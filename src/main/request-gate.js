'use strict';

/**
 * 请求闸门
 * ---------------------------------------------------------------------------
 * 所有出网请求都要从这里过一道：先问无图模式，再问广告拦截。
 *
 * 为什么合成一条而不是各注册一个监听器 —— Electron 对同一个 webRequest 事件
 * 只保留最后注册的那一个，重复注册是静默覆盖：不报错、不提示，后注册的把
 * 先注册的顶掉，表现为「广告拦截莫名其妙不拦了」。所以这里只有一条
 * onBeforeRequest，两个判定按顺序问。
 *
 * 顺序上无图排在最前：它的判定便宜（看类型 + 两三个特征就完事），广告拦截要
 * 走规则索引。图片多的页面里绝大多数请求在第一步就被挡回去，进不到规则匹配，
 * 顺带也是给广告拦截减负。除此之外还有个可观测的后果：被无图拦下的请求
 * 不会出现在广告拦截的统计里 —— 这是刻意的，省流量不该冒充成拦截广告。
 *
 * 单独成一个文件的理由：这是 jsdom 完全够不着的部分（webRequest 是 Electron
 * 才有的东西），拆出来真实 Electron 测试才能装上同一份实现。
 */

/**
 * @param {object} ses     Electron session
 * @param {object} opts
 * @param {object}   opts.adblock    广告拦截器（需有 check(url, type, docHost)）
 * @param {object}   opts.noMedia    无图判定器（需有 shouldBlock(details) / record()）
 * @param {function} opts.docHostFor webContentsId → 顶层文档 hostname
 * @param {function} opts.onAdblockHit (命中规则, details) => void
 * @param {function} opts.onNoMediaHit (资源类型, details) => void
 * @param {string[]} opts.urls       匹配的 URL 模式，默认全部
 */
function wireRequestGate(ses, opts) {
  const o = opts || {};
  const { adblock, noMedia, docHostFor, onAdblockHit, onNoMediaHit } = o;

  ses.webRequest.onBeforeRequest({ urls: o.urls || ['<all_urls>'] }, (details, callback) => {
    // 1) 无图模式
    if (noMedia) {
      const blocked = noMedia.shouldBlock(details);
      if (blocked) {
        noMedia.record(blocked, details.webContentsId);
        if (onNoMediaHit) {
          try { onNoMediaHit(blocked, details); } catch { /* 通知失败不该影响放行决定 */ }
        }
        callback({ cancel: true });
        return;
      }
    }

    // 2) 广告拦截
    if (adblock) {
      try {
        const docHost = docHostFor ? docHostFor(details.webContentsId) : '';
        const hit = adblock.check(details.url, details.resourceType, docHost);
        if (hit) {
          if (onAdblockHit) onAdblockHit(hit, details);
          callback({ cancel: true });
          return;
        }
      } catch { /* 规则引擎出错时放行，绝不因为拦截失败把页面搞挂 */ }
    }

    callback({ cancel: false });
  });
}

module.exports = { wireRequestGate };
