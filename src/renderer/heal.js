'use strict';

/**
 * 页面「加载完了却没画出来」的判定（双导出：外壳脚本 + Node 单测）
 * ---------------------------------------------------------------------------
 * 用户的原话：「个别网页加载一般刷新才恢复正常」。
 *
 * 这类页面 did-finish-load 已经触发过 —— 网络层是成功的 —— 但文档里什么都没有：
 * 没有文字、没有图片/画布/表格这些区块，整页只有背景色。再刷新一次多半就好了，
 * 因为问题出在首帧那次渲染，不在服务端。
 *
 * 这里的职责只有一个：**判断「这次加载算不算空白」**，以及**什么时候不该再自动重载**。
 * 真正的探测与重载动作在 shell.js（要真 webview 才能跑），判定逻辑放在这里，
 * 才可能被 tools/test-page-heal.js 覆盖到 —— 与 ntp.js 同一个写法。
 *
 * 三条边界，避免把自愈变成刷新循环：
 *   · 只对 http(s) 页面动手（about: / file: / chrome-extension: 一律不碰）
 *   · 同一个地址一个冷却窗口内只重载一次
 *   · 已经在错误页的不管（那是 renderPageError 那条路）
 */

/** 在页面里量「画出来没有」：滚动高度 | 可见文本长度 | 可视图元数量。 */
const PROBE = `(function(){try{
  var b=document.body,d=document.documentElement;
  if(!b||!d) return '0|0|0';
  var h=Math.max(b.scrollHeight|0,d.scrollHeight|0);
  var t=(b.innerText||b.textContent||'').replace(/\\s+/g,'').length;
  var v=b.querySelectorAll('img,canvas,video,picture,iframe,svg,table,ul,ol,form,input,button,object,embed').length;
  return h+'|'+t+'|'+v;
}catch(e){return '-1|-1|-1'}})()`;

/** 同一地址的自动重载冷却（毫秒）。 */
const COOLDOWN = 60000;

/** 判定用的阈值：高度低于这个、文本少于这个、且没有任何图元 → 当作空白页。 */
const MIN_HEIGHT = 60;
const MIN_TEXT = 20;

/** 只有真网页才自愈。 */
function isHealableUrl(url) {
  return /^https?:/i.test(String(url || ''));
}

/**
 * 解析探针返回值。
 * @returns {{h:number,t:number,v:number}|null} 探针自己出错时返回 null（不猜）
 */
function parseProbe(raw) {
  const parts = String(raw == null ? '' : raw).split('|');
  if (parts.length < 3) return null;
  const h = parseInt(parts[0], 10);
  const t = parseInt(parts[1], 10);
  const v = parseInt(parts[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(t) || !Number.isFinite(v)) return null;
  if (h < 0) return null; // 页内探针抛异常
  return { h, t, v };
}

/** 是不是「空得只剩背景」——高度、文本、图元三样都没有。 */
function isBlank(parsed) {
  if (!parsed) return false;
  return parsed.h < MIN_HEIGHT && parsed.t < MIN_TEXT && parsed.v <= 0;
}

/**
 * 这次该不该自动重载。
 *
 * @param {{url:string, lastUrl?:string, lastAt?:number, now?:number, hasError?:boolean}} s
 */
function shouldHeal(s) {
  const st = s || {};
  if (st.hasError) return false;
  if (!isHealableUrl(st.url)) return false;
  const now = Number.isFinite(st.now) ? st.now : Date.now();
  const lastAt = Number.isFinite(st.lastAt) ? st.lastAt : 0;
  if (st.lastUrl && st.lastUrl === st.url && now - lastAt < COOLDOWN) return false;
  return true;
}

const NovaPageHeal = {
  PROBE,
  COOLDOWN,
  MIN_HEIGHT,
  MIN_TEXT,
  isHealableUrl,
  parseProbe,
  isBlank,
  shouldHeal
};

if (typeof window !== 'undefined') window.NovaPageHeal = NovaPageHeal;
if (typeof module !== 'undefined' && module.exports) module.exports = NovaPageHeal;
