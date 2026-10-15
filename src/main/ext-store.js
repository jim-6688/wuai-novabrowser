'use strict';

/**
 * Edge 加载项商店：把「一条商店链接」变成「一个能装进 Nova 的扩展包」
 * ---------------------------------------------------------------------------
 *
 * 为什么要有这个模块：商店页上的「获取」按钮点不动。
 *
 *   Chromium 系商店（Edge 加载项 / Chrome 应用店）那个安装按钮，调的是浏览器
 *   自家的内部接口（webstorePrivate、management 之类），只有带这套东西的品牌
 *   浏览器有。第三方外壳里页面能正常打开、按钮也能点，但什么都不会发生 ——
 *   不是网络问题，是那个 API 根本不存在。所以「打开商店」只解决了浏览，
 *   真要装上必须由外壳自己去取包。这一步就是本模块做的事。
 *
 * 为什么是 Edge 商店而不是 Chrome 应用店：
 *
 *   同一台机器实测，Chrome 应用店（chromewebstore.google.com 与
 *   clients2.google.com）**15 秒超时、无响应**；Edge 加载项商店
 *   （microsoftedge.microsoft.com）0.3–1.1 秒可达，取包接口也通。
 *   而且拿到的是同一份 CRX —— 本项目的装载流水线直接就能吃
 *   （见 extensions.js 的 stripCrxHeader + extractZip），不需要为它单独写解释器。
 *
 * 网络实现由调用方注入（与 favicon-cache.js 同一个取舍）：
 *
 *   这个文件不 import electron、也不在模块加载时碰网络。这样它才能在一个
 *   普通 Node 进程里被测试钉住 —— 而这一层最需要钉住的，恰恰是
 *   「一段用户粘贴的字符串，到底被认成了哪个 ID」。认错的下场是把一个完全
 *   无关的扩展装进用户的浏览器。
 */

const fs = require('fs');
const path = require('path');

/* ========================================================================== *
 * 常量
 * ========================================================================== */

/**
 * Chromium 扩展 ID 的字符集恒为 32 个 a–p 字母。
 *
 * 这不是「一般是」而是「只能是」：ID 由一个 128 位摘要的每个半字节映射到
 * a–p 得到，所以出现 q–z 或数字的必然不是 ID。这条约束是整个解析的支点 ——
 * 有它才敢在一段任意文本里捞出 ID 而不至于误伤。
 */
const CRX_ID_RE = /^[a-p]{32}$/;

const DETAIL_API = 'https://microsoftedge.microsoft.com/addons/getproductdetailsbycrxid/';
const CRX_API = 'https://edge.microsoft.com/extensionwebstorebase/v1/crx';

/**
 * 取包接口要能带上 installsource=ondemand 这一项才会回 302。
 * 少了它接口直接 500 —— 这不是可选的「附加信息」，是必填闸门。
 */
const CRX_X = (id) => 'id=' + id + '&uc&installsource=ondemand';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DETAIL_TIMEOUT_MS = 12000;
const DOWNLOAD_TIMEOUT_MS = 120000;

/** 扩展包上限。uBlock Origin Lite 这类也就 1–3 MB，64 MB 已经宽到离谱，
 *  留在那里是为了挡住「接口返回了一个不知道什么东西的巨物」这种情况。 */
const MAX_CRX_BYTES = 64 * 1024 * 1024;

/* ========================================================================== *
 * 解析
 * ========================================================================== */

/**
 * 从用户粘贴的一串东西里认出扩展 ID。
 *
 * 认三种写法，因为用户手上真正拿得到的就这三种：
 *   1. 商店详情页地址（在商店里点进某个扩展，地址栏那一串）
 *   2. 32 位的扩展 ID 本身（有人会直接抄 ID）
 *   3. 上面两种的变体：前后带了空格、被聊天软件裹上 <尖括号>、尾巴上带了 ?hl=zh-CN
 *
 * 认不出就返回 null，**不做模糊猜测**。猜错会把一个完全无关的扩展装进用户
 * 浏览器里，那比「认不出、请重新粘贴」严重得多。
 *
 * @returns {{crxId: string, source: 'edge'|'chrome'|'other'|'bare'}|null}
 */
function parseStoreInput(raw) {
  // 尖括号是聊天软件里复制链接时常见的包裹，不算内容
  const s = String(raw == null ? '' : raw).trim().replace(/^</, '').replace(/>$/, '').trim();
  if (!s) return null;

  if (CRX_ID_RE.test(s)) return { crxId: s, source: 'bare' };

  let url = null;
  try { url = new URL(s); } catch { url = null; }
  if (!url) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  // source 只为了一句更准的提示：Chrome 应用店的扩展在 Edge 商店可能没有收录，
  // 那种「查不到」与「ID 打错了」是两回事，不该给同一句话。
  const source = host === 'microsoftedge.microsoft.com' ? 'edge'
    : (host === 'chromewebstore.google.com' || host === 'chrome.google.com') ? 'chrome'
      : 'other';

  // 详情页地址的末段就是 ID
  const seg = url.pathname.split('/').filter(Boolean).pop() || '';
  if (CRX_ID_RE.test(seg)) return { crxId: seg, source };

  // 末段不是 ID 的（个别链接尾巴上还挂别的东西），退回在路径里找第一个像 ID 的
  const m = url.pathname.match(/[a-p]{32}/);
  return m ? { crxId: m[0], source } : null;
}

/** 详情接口地址。 */
function detailApi(crxId) {
  return DETAIL_API + encodeURIComponent(crxId);
}

/**
 * 取包接口地址。
 *
 * prodversion 传当前内核的大版本：商店会按它挑一份兼容的包
 * （同一 ID 对不同内核版本可能给不同 CRX）。传死一个数字在几个月后
 * 就会开始拿到过时的包，所以由调用方把真实版本递进来。
 */
function crxApi(crxId, chromeVersion) {
  const major = String(chromeVersion || '120').split('.')[0].replace(/\D/g, '') || '120';
  const q = new URLSearchParams({
    response: 'redirect',
    prodversion: major + '.0.0.0',
    acceptformat: 'crx3,crx2',
    x: CRX_X(crxId)
  });
  return CRX_API + '?' + q.toString();
}

/* ========================================================================== *
 * 详情
 * ========================================================================== */

/**
 * 安装量的中文写法。
 *
 * 商店给的是精确数字（13321147），界面上要的是一眼能比出大小的量级。
 * 超过 100 万就不带小数了 —— 「1332.1 万」多出来的那位小数没有任何决策价值，
 * 只是把一行字撑长。
 */
function formatInstalls(n) {
  const v = Number(n) || 0;
  if (v < 10000) return String(v);
  if (v < 100000000) {
    const wan = v / 10000;
    return (wan >= 100 ? Math.round(wan) : Math.round(wan * 10) / 10) + ' 万';
  }
  return (Math.round((v / 100000000) * 10) / 10) + ' 亿';
}

/** 商店详情 → 界面要用的那几个字段。取不到的留空，不编。 */
function summarizeDetail(json, crxId) {
  if (!json || typeof json !== 'object') return null;
  const logo = String(json.logoUrl || '');
  return {
    crxId,
    name: String(json.name || '').trim(),
    version: String(json.version || '').trim(),
    developer: String(json.developer || '').trim(),
    installs: Number(json.activeInstallCount) || 0,
    installsText: formatInstalls(json.activeInstallCount),
    // 商店给的图标地址是协议相对的（//store-images...），补上协议才能用
    icon: logo ? (logo.startsWith('//') ? 'https:' + logo : logo) : '',
    description: String(json.shortDescription || json.description || '').trim(),
    manifestVersion: json.isManifestV2 ? 2 : 3
  };
}

/**
 * 查一个扩展的详情。用于「装之前先让用户看清装的是什么」。
 *
 * @returns {{crxId: string, source: string, detail: object}|{error: string, crxId?: string}}
 */
async function fetchDetail(rawInput, opts = {}) {
  const f = opts.fetchImpl || defaultFetch;
  const parsed = parseStoreInput(rawInput);
  if (!parsed) {
    return { error: '认不出扩展。请粘贴商店里那个扩展的页面地址，或者 32 位的扩展 ID。' };
  }

  let res;
  try {
    res = await f(detailApi(parsed.crxId), {
      timeoutMs: DETAIL_TIMEOUT_MS,
      headers: { 'User-Agent': UA, Accept: 'application/json' }
    });
  } catch (err) {
    return { crxId: parsed.crxId, error: '连不上 Edge 加载项商店：' + errText(err) };
  }

  if (res.status === 404) {
    // 「Chrome 应用店有、Edge 商店没收录」是最常见的一种查不到。
    // 它和「ID 抄错了」给出同一句提示的话，用户会一直换 ID 试。
    return {
      crxId: parsed.crxId,
      error: parsed.source === 'chrome'
        ? '这是 Chrome 应用店的扩展，Edge 加载项商店没有收录它。'
        : 'Edge 加载项商店里没有这个扩展。'
    };
  }
  if (!res.ok) return { crxId: parsed.crxId, error: '商店返回了 HTTP ' + res.status };

  let json = null;
  try { json = await res.json(); } catch { /* 落到下面那句 */ }
  const detail = summarizeDetail(json, parsed.crxId);
  if (!detail || !detail.name) return { crxId: parsed.crxId, error: '商店返回的内容读不懂（可能被网络中间设备替换了）' };

  return { crxId: parsed.crxId, source: parsed.source, detail };
}

/* ========================================================================== *
 * 取包
 * ========================================================================== */

/**
 * 把扩展包取回来写到 destPath。
 *
 * 保存下来而不是「下完就删」：settings 里记的是扩展的装载来源路径，
 * 下次启动要照着它恢复装载（见 main.js bootstrap 里那段恢复循环）。
 * 包一删，恢复就失败 —— 那正是「装过一次，重启后扩展不见了」的由来。
 *
 * 已经下过同一个 crxId 就不重复下载（同一个 ID 的内容不会变）。
 *
 * @returns {{ok: true, bytes: number, crxId: string, cached?: boolean}|{error: string}}
 */
async function downloadCrx(rawInput, destPath, opts = {}) {
  const f = opts.fetchImpl || defaultFetch;
  const parsed = parseStoreInput(rawInput);
  if (!parsed) return { error: '认不出扩展 ID' };

  if (!opts.force) {
    try {
      const st = fs.statSync(destPath);
      if (st.size > 0) return { ok: true, bytes: st.size, crxId: parsed.crxId, cached: true };
    } catch { /* 没下过，往下走 */ }
  }

  let res;
  try {
    res = await f(crxApi(parsed.crxId, opts.chromeVersion), {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      headers: { 'User-Agent': UA, Accept: '*/*' }
    });
  } catch (err) {
    return { error: '下载扩展包失败：' + errText(err) };
  }
  if (!res.ok) return { error: '商店拒绝了这次下载（HTTP ' + res.status + '）' };

  let buf = null;
  try { buf = Buffer.from(await res.arrayBuffer()); } catch { buf = null; }
  if (!buf || !buf.length) return { error: '商店返回了空文件' };
  if (buf.length > MAX_CRX_BYTES) {
    return { error: '扩展包过大（' + Math.round(buf.length / 1048576) + ' MB），已放弃' };
  }

  // 认魔数，不认后缀。这个接口正常给的就是 CRX3（开头 Cr24），
  // 但也可能被网络中间设备换成一张 HTML 错误页 —— 那种东西存下来，
  // 只会在解包那一步报出一句更难懂的错。
  if (buf.subarray(0, 4).toString('latin1') !== 'Cr24') {
    return { error: '取回来的不是扩展包（可能被网络中间设备替换了内容）' };
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return { ok: true, bytes: buf.length, crxId: parsed.crxId };
}

/* ========================================================================== *
 * 默认网络实现
 * ========================================================================== */

/** 把各种异常收成一句人话。fetch 的异常信息（比如 "fetch failed"）直接给用户看没有意义。 */
function errText(err) {
  const m = err && err.message ? err.message : '';
  if (!m) return '网络错误';
  if (/abort/i.test(m)) return '请求超时';
  return m;
}

async function defaultFetch(url, { timeoutMs = DETAIL_TIMEOUT_MS, headers } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: headers || { 'User-Agent': UA }
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  CRX_ID_RE,
  DETAIL_API,
  CRX_API,
  parseStoreInput,
  detailApi,
  crxApi,
  formatInstalls,
  summarizeDetail,
  fetchDetail,
  downloadCrx,
  defaultFetch
};
