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

// 只为拆开镜像站那个套娃 zip。extensions.js 顶层只 require Node 内置模块
// （fs/path/zlib/os），不带 electron —— 所以在这里引它不会破坏本模块
// 「能在普通 Node 进程里被测试」这条底线。
const { listZipEntries, readZipEntry } = require('./extensions');

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
 * Chrome 应用店的国内镜像站。
 *
 * 为什么必须有它：Google 那边整段域名在国内不可达 —— 实测
 * chromewebstore.google.com、chrome.google.com、clients2.google.com
 * （Chrome 的取包接口）全部 15 秒超时无响应。所以「打开 Chrome 应用店」
 * 这件事本身在直连环境下做不到。
 *
 * 但 Chrome 应用店的扩展仍然拿得到，因为**它和 Edge 商店不是同一套 ID**：
 * 同一个 Tampermonkey，Chrome 那边是 dhdgffkkebhmkfjojejmpbldmpobfkfo，
 * Edge 那边是 iikmkjmpaadaobahmlepeloendndfphd。拿 Chrome 的地址去问
 * Edge 商店永远问不到 —— 必须有第三条路。
 *
 * 极简插件用 Chrome 商店的原始 crxId 作详情页路径，并且提供长期有效的
 * 包直链（「备用下载」那条不带 auth_key，不会过期）。实测：站点 0.3 秒
 * 可达，1.7 MB 的包 0.44 秒下完。它取的就是 Chrome 应用店里那同一个包，
 * 只是换了一个国内能通的域名来分发。
 */
const CHROME_MIRROR = 'https://chrome.zzzmh.cn';
const CHROME_MIRROR_INFO = CHROME_MIRROR + '/info/';

/**
 * 取包接口要能带上 installsource=ondemand 这一项才会回 302。
 * 少了它接口直接 500 —— 这不是可选的「附加信息」，是必填闸门。
 */
const CRX_X = (id) => 'id=' + id + '&uc&installsource=ondemand';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DETAIL_TIMEOUT_MS = 12000;

/**
 * 下载超时。
 *
 * 镜像站那份 70 MB 的包实测要一两分钟（同一台机器上 1.6 MB 的包只要 0.4 秒 ——
 * 慢的是那个文件本身，不是链路）。按最坏情况留够，不然大包会卡在超时上，
 * 用户看到的是「下载失败」而其实只是还没下完。
 */
const DOWNLOAD_TIMEOUT_MS = 300000;

/**
 * 扩展包上限。
 *
 * 原先按 Edge 商店的经验定在 64 MB（那边最大也就 1–3 MB）。但 Chrome 应用店
 * 的镜像站是**解包后重新打包**的，同一个扩展能比原版大出一截 —— 实测
 * Adblock Plus 最新版 70.1 MB（它的历史版本只有 2.6 MB，uBlock Origin 4.4 MB，
 * AdGuard 28.5 MB）。64 MB 会把这种真实存在的包误判成异常并拒绝安装。
 *
 * 放到 192 MB：仍然挡得住「接口返回了一个不知道什么东西的巨物」，
 * 但不再误杀正常（只是偏胖）的扩展包。
 */
const MAX_CRX_BYTES = 192 * 1024 * 1024;

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

  // Chrome 应用店只有镜像这一条路，不必去 Edge 商店空跑一趟 ——
  // 两个商店的 ID 不是同一套编号，拿 Chrome 的 ID 问 Edge 是问不到的。
  if (parsed.source === 'chrome') return fetchChromeDetail(parsed.crxId, opts);

  const viaEdge = await fetchEdgeDetail(parsed, f);
  // 裸 ID（用户直接抄了一串）问不出出处，Edge 那边没有就再问问镜像。
  // 带 edge 来源的不用问：用户明明是从 Edge 商店复制的地址。
  if (viaEdge.error && viaEdge.notFound && parsed.source === 'bare') {
    const viaMirror = await fetchChromeDetail(parsed.crxId, opts);
    if (viaMirror.detail) return viaMirror;
  }
  return viaEdge;
}

/** 走 Edge 加载项商店查详情。 */
async function fetchEdgeDetail(parsed, f) {
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
    // notFound 与「网络不通」是两回事：前者说明可以换一条路再试，
    // 后者换路也没用。fetchDetail 拿它决定要不要回落镜像站。
    return {
      crxId: parsed.crxId,
      source: parsed.source,
      notFound: true,
      error: 'Edge 加载项商店里没有收录这个扩展。'
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
 * Chrome 应用店（走国内镜像）
 *
 * 这一段的解析对象是 HTML，不是 JSON —— 镜像站是个渲染好的页面。
 * 规则写得窄一些：名字只从 <h1> 拿，版本/更新时间/安装量只在
 * .chrome-subtitle 那个小区块里找。宁可拿不到，也不要在整页里瞎捞 ——
 * 页面上还挂着「相关推荐」的卡片，捞错了就会把别人的名字安在这个 ID 上。
 * ========================================================================== */

/** HTML 实体转回原字符。标题里 &amp; &#39; 这类很常见。 */
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#0*34;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 取 <meta property="X" content="...">（属性顺序两种都认）。 */
function metaContent(html, prop) {
  const p = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = new RegExp('<meta[^>]*(?:property|name)="' + p + '"[^>]*content="([^"]*)"', 'i').exec(html);
  if (a) return decodeEntities(a[1]);
  const b = new RegExp('<meta[^>]*content="([^"]*)"[^>]*(?:property|name)="' + p + '"', 'i').exec(html);
  return b ? decodeEntities(b[1]) : '';
}

/**
 * 从 .chrome-subtitle 那一行里取一项（版本 / 更新时间 / 下载量）。
 *
 * 那一行的结构是三个并列的 span，各自带一个 iconfont 图标名当标签：
 *   <span><i class="iconfont icon-ic_app"></i>5.5.1</span>
 *   <span><i class="iconfont icon-time"></i>2026-10-04</span>
 *   <span><i class="iconfont icon-download"></i>246万+</span>
 * 先把这个小区块切出来再找图标，是为了躲开页面上别处同样用到 icon-time
 * 的地方（更新历史那一栏）。
 */
function subtitleField(html, iconKey) {
  const seg = (/<div[^>]*class="[^"]*chrome-subtitle[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html) || [])[1];
  if (!seg) return '';
  const m = new RegExp('<i[^>]*icon-' + iconKey + '[^>]*>[\\s\\S]{0,20}?</i>\\s*([^<]+)', 'i').exec(seg);
  return m ? decodeEntities(m[1]).trim() : '';
}

/**
 * 镜像详情页 → 界面要用的那几个字段。
 *
 * 注意这里 **不编安装量**：镜像页只给「246万+」这种量级写法，没有精确值。
 * 与其把 2460000 算出来假装精确，不如原样把「246万+」显示出去 ——
 * 它本来就是给用户看的那个数。拿不到就留空，界面上不显示这一项。
 */
function summarizeMirror(html, crxId) {
  if (typeof html !== 'string' || !html) return null;

  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const name = h1 ? decodeEntities(h1[1].replace(/<[^>]*>/g, '')).trim() : '';
  if (!name) return null;

  let icon = metaContent(html, 'og:image');
  if (icon && !/^https?:/i.test(icon)) {
    icon = CHROME_MIRROR + (icon.startsWith('/') ? '' : '/') + icon;
  }

  let description = (metaContent(html, 'og:description') || metaContent(html, 'description')).trim();
  if (description.length > 140) description = description.slice(0, 140) + '…';

  return {
    crxId,
    name,
    version: subtitleField(html, 'ic_app'),
    updated: subtitleField(html, 'time'),
    // 开发者镜像页没有单独给，留空由界面兜底成「未知开发者」
    developer: '',
    installs: 0,
    installsText: subtitleField(html, 'download'),
    icon,
    description,
    manifestVersion: 0,
    // 界面上据此标注「来自 Chrome 应用店镜像」，别让用户以为这是官方渠道
    mirror: true
  };
}

/**
 * 从详情页里挑出包直链。
 *
 * 页面上给两条：一条「推荐下载」挂在 CDN 上带 auth_key（有有效期），
 * 一条「备用下载」是同站相对路径、不带任何签名。**优先取后者** ——
 * 扩展包装下来要长期留着（重启后照着它恢复装载），带签名的地址过几天
 * 就失效了，那个扩展下次启动就装不回来。
 */
function parseMirrorDownloadUrl(html, crxId) {
  if (typeof html !== 'string') return '';
  // 不带参数的相对路径：/v3/crx/<hash>/<id>.zip
  const bare = new RegExp('/v3/crx/[a-f0-9]{32}/' + crxId + '\\.zip(?![?\\w])', 'i').exec(html);
  if (bare) return CHROME_MIRROR + bare[0];
  // 退路：带签名的绝对地址（会过期，但总比取不到强）
  const signed = new RegExp(
    'https://[^"\'\\s]*/v3/crx/[a-f0-9]{32}/' + crxId + '\\.zip\\?auth_key=[^"\'\\s&]+', 'i').exec(html);
  return signed ? signed[0] : '';
}

/** 查一个 Chrome 应用店扩展（经镜像站）。 */
async function fetchChromeDetail(crxId, opts = {}) {
  const f = opts.fetchImpl || defaultFetch;

  let res;
  try {
    res = await f(CHROME_MIRROR_INFO + encodeURIComponent(crxId), {
      timeoutMs: opts.timeoutMs || DETAIL_TIMEOUT_MS,
      headers: { 'User-Agent': UA, Accept: 'text/html' }
    });
  } catch (err) {
    return { crxId, source: 'chrome', error: '连不上 Chrome 应用店镜像：' + errText(err) };
  }

  if (res.status === 404) {
    return {
      crxId, source: 'chrome', notFound: true,
      error: 'Chrome 应用店镜像里没有收录这个扩展（可能是 Edge 专属的，或者 ID 抄错了）。'
    };
  }
  if (!res.ok) return { crxId, source: 'chrome', error: '镜像返回了 HTTP ' + res.status };

  let html = '';
  try { html = await res.text(); } catch { /* 落到下面那句 */ }
  const detail = summarizeMirror(html, crxId);
  if (!detail) return { crxId, source: 'chrome', notFound: true, error: '镜像页面上找不到这个扩展' };

  return {
    crxId, source: 'chrome', detail,
    downloadUrl: parseMirrorDownloadUrl(html, crxId)
  };
}

/**
 * 拆开镜像给的套娃。
 *
 * 镜像站发的是一个普通 zip，里面装着真正的 .crx 再加一份说明 txt
 * （实测：dhdgffkkebhmkfjojejmpbldmpobfkfo_5.5.1_chrome.zzzmh.cn.crx）。
 * 直接把外层 zip 交给装载流水线是不行的 —— 解出来是一堆没有 manifest.json
 * 的东西，报错还很难懂。所以在这一层把 .crx 掏出来，下游完全不知情。
 *
 * @returns {Buffer|null} CRX3 内容；不是预期的套娃结构时返回 null
 */
function extractCrxFromMirrorZip(buf) {
  if (!buf || !buf.length) return null;
  // 万一哪天镜像站改成直接给 crx，也认
  if (buf.subarray(0, 4).toString('latin1') === 'Cr24') return buf;

  let entries = [];
  try { entries = listZipEntries(buf); } catch { return null; }

  const hit = entries.find((e) => /\.crx$/i.test(e.name) && !e.name.endsWith('/'));
  if (!hit) return null;
  try {
    const inner = readZipEntry(buf, hit);
    return inner.subarray(0, 4).toString('latin1') === 'Cr24' ? inner : null;
  } catch { return null; }
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

  let buf = null;

  if (parsed.source === 'chrome') {
    const got = await fetchChromePackage(parsed.crxId, f, opts);
    if (got.error) return { error: got.error };
    buf = got.buf;
  } else {
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

    try { buf = Buffer.from(await res.arrayBuffer()); } catch { buf = null; }
    if (!buf || !buf.length) return { error: '商店返回了空文件' };
  }

  if (buf.length > MAX_CRX_BYTES) {
    return { error: '扩展包过大（' + Math.round(buf.length / 1048576) + ' MB），已放弃' };
  }

  // 认魔数，不认后缀。这个接口正常给的就是 CRX3（开头 Cr24），
  // 但也可能被网络中间设备换成一张 HTML 错误页 —— 那种东西存下来，
  // 只会在解包那一步报出一句更难懂的错。
  if (buf.subarray(0, 4).toString('latin1') !== 'Cr24') {
    return {
      error: parsed.source === 'chrome'
        ? '取回来的不是扩展包（镜像站给的结构变了）'
        : '取回来的不是扩展包（可能被网络中间设备替换了内容）'
    };
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return { ok: true, bytes: buf.length, crxId: parsed.crxId };
}

/**
 * 从镜像站取一个 Chrome 应用店的包，返回**已经拆掉套娃的** CRX。
 *
 * 分两步：先要详情页（下载直链只写在页面上，没有独立的取包接口），
 * 再把外层 zip 拉下来掏出里面的 .crx。两步都不缓存中间结果 ——
 * 这个函数被调用时，用户已经在界面上看过一次详情了，多抓一次页面
 * （0.3 秒）换来的好处是这里不需要和 fetchDetail 共享任何状态。
 */
async function fetchChromePackage(crxId, f, opts = {}) {
  const info = await fetchChromeDetail(crxId, { ...opts, fetchImpl: f });
  if (!info.detail) return { error: info.error || 'Chrome 应用店镜像里没有这个扩展' };
  if (!info.downloadUrl) return { error: '镜像页面上没给出这个扩展的下载地址' };

  let res;
  try {
    res = await f(info.downloadUrl, {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      headers: { 'User-Agent': UA, Accept: '*/*' }
    });
  } catch (err) {
    return { error: '下载扩展包失败：' + errText(err) };
  }
  if (!res.ok) return { error: '镜像站拒绝了这次下载（HTTP ' + res.status + '）' };

  let outer = null;
  try { outer = Buffer.from(await res.arrayBuffer()); } catch { outer = null; }
  if (!outer || !outer.length) return { error: '镜像站返回了空文件' };
  if (outer.length > MAX_CRX_BYTES) {
    return { error: '扩展包过大（' + Math.round(outer.length / 1048576) + ' MB），已放弃' };
  }

  const crx = extractCrxFromMirrorZip(outer);
  if (!crx) return { error: '镜像给的包里没找到 .crx（它的打包方式可能变了）' };
  return { buf: crx };
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
  CHROME_MIRROR,
  CHROME_MIRROR_INFO,
  parseStoreInput,
  detailApi,
  crxApi,
  formatInstalls,
  summarizeDetail,
  decodeEntities,
  summarizeMirror,
  parseMirrorDownloadUrl,
  extractCrxFromMirrorZip,
  fetchChromeDetail,
  fetchDetail,
  downloadCrx,
  defaultFetch
};
