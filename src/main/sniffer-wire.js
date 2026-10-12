'use strict';

/**
 * 把嗅探引擎接到 Electron session 的响应头阶段。
 * ---------------------------------------------------------------------------
 * 单独成一个文件的理由：这段接线是 jsdom 完全够不着的部分（webRequest 是
 * Electron 独有的），要验证它只能起真实 Electron —— 而 main.js 是要启动整个
 * 应用的入口，测试没法直接 require 它。抽出来，测试就能调同一份实现。
 */

/**
 * 响应头的键大小写不固定（Chromium 给的是 `Content-Type`，中间层可能给小写），
 * 必须不敏感地读。
 */
function pickHeader(headers, name) {
  const want = name.toLowerCase();
  for (const k of Object.keys(headers || {})) {
    if (k.toLowerCase() === want) {
      const v = headers[k];
      return Array.isArray(v) ? (v[0] || '') : (v || '');
    }
  }
  return '';
}

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : -1;
}

/**
 * 从一条响应里解析出嗅探结果。不是媒体就返回 null。
 *
 * @param {object} details webRequest 的 details
 * @param {object} sniffer Sniffer 实例
 * @param {(id:number)=>boolean} [isInternal] 判断是不是浏览器自己的请求
 */
function sniffResponse(details, sniffer, isInternal) {
  if (!sniffer || !sniffer.enabled) return null;
  if (!details || details.method !== 'GET') return null;

  // 只认页面发出的请求。-1 是主进程或扩展侧发的，不是用户在看的内容。
  const tabId = details.webContentsId;
  if (tabId == null || tabId < 0) return null;
  if (isInternal && isInternal(tabId)) return null; // 浏览器自己的 UI 请求不算

  const code = details.statusCode;
  if (code && code >= 300) return null; // 重定向与 304 不参与

  const headers = details.responseHeaders || {};
  const mime = pickHeader(headers, 'content-type');
  let size = toInt(pickHeader(headers, 'content-length'));

  // 206 的部分响应里，content-length 只是这一段的长度，不是文件全长。
  // 分片下载时每片都会来一条这样的响应，照单全收会把体积报小几十倍。
  const range = pickHeader(headers, 'content-range');
  if (range) {
    const m = /\/(\d+)\s*$/.exec(range);
    if (m) size = Number(m[1]);
  }

  const res = sniffer.observe({ url: details.url, mime, size, tabId });
  return res && res.isNew ? res.rec : null;
}

/**
 * 挂在响应头阶段。
 *
 * 选这个时机而不是请求阶段是有原因的：判定媒体最可靠的两个依据
 * —— Content-Type 与 Content-Length —— 只有响应头里才有，请求发出时
 * 手上只有一个 URL 可看。选它还有一个好处：这个事件此前无人注册
 * （onBeforeSendHeaders 被内核 UA 改写占了、onBeforeRequest 被广告拦截占了），
 * 所以不会碰到 Electron「同一事件重复注册会互相覆盖」那个陷阱。
 *
 * @param {Electron.Session} ses
 * @param {{sniffer:object, onRecord?:Function, isInternal?:Function, onError?:Function}} opts
 */
function wireSniffer(ses, opts) {
  const { sniffer, onRecord, isInternal, onError } = opts || {};

  ses.webRequest.onHeadersReceived((details, callback) => {
    // 嗅探是旁路观察者。它出任何问题都不该影响真实网络请求。
    try {
      const rec = sniffResponse(details, sniffer, isInternal);
      if (rec && onRecord) onRecord(rec);
    } catch (err) {
      if (onError) onError(err);
      else console.warn('[sniff] 解析失败:', err.message);
    }
    // 这个回调必须调用，否则该请求会一直挂起
    callback({});
  });
}

module.exports = { wireSniffer, sniffResponse, pickHeader, toInt };
