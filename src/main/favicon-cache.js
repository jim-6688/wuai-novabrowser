'use strict';

/**
 * 新标签页磁贴图标的抓取与缓存（PC / 主进程侧）。
 * ---------------------------------------------------------------------------
 * 与安卓端 FaviconCache 是同一件事的两份实现，语义逐条对齐：
 *   - TTL 7 天；抓取上限 512KB；按 /favicon.ico → /apple-touch-icon.png →
 *     /favicon.png 的顺序探测；主机名 → 文件名的清洗规则相同（fileNameFor）。
 *   - 不引第三方取图服务 —— 那等于把「用户去过哪些站点」交给一个陌生域名。
 *
 * PC 侧比安卓省事的两处：
 *   - Chromium 的 <img> 原生认 ICO（里面装 BMP 也一样），所以不需要安卓那套
 *     「从 .ico 壳里抠 PNG / 解 BMP 再编码」的 dance，字节头认出 x-icon 就整包存。
 *   - 主进程收得到 page-favicon-updated（安卓 WebView 没有这个事件），访问过的
 *     站点可以直接拿「站点自己声明的图标地址」来抓，命中率比盲探 PATHS 高。
 *
 * 为什么抓取放主进程而不是新标签页里：那一页的 CSP 是
 * `default-src 'none'; img-src data:` —— 本地页面刻意锁死网络（见 newtab.html）。
 * 所以只能由主进程抓、落盘缓存、以 data: URI 喂给页面（window.__novaIcons）。
 * 缓存的意义也在这里：图标不会每开一次新标签页就重新下载。
 *
 * 纯解析部分（sniffMime / fileNameFor / mimeOfExt / extOf）不碰 Electron，
 * tools/test-favicon-cache.js 在普通 Node 里直接测。
 */

const fs = require('fs');
const path = require('path');

/** 缓存有效期：7 天。与安卓端 FaviconCache.TTL_MS 同值。 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 一次最多读多少字节。图标不该有几百 KB，超过就当这次抓取失败。 */
const MAX_BYTES = 512 * 1024;

/** 连接与读取超时。这是后台任务，但不能挂太久 —— 它占着一条并发额度。 */
const FETCH_TIMEOUT_MS = 8000;

/**
 * 取图顺序。/favicon.ico 放最前：它是唯一一个「约定俗成、不放也要放」的位置；
 * 后面两支命中率低但图更好看，放在备选。与安卓端 PATHS 相同。
 */
const PATHS = ['/favicon.ico', '/apple-touch-icon.png', '/favicon.png'];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ 纯解析 */

/**
 * 认字节头，返回 MIME；认不出来返回 null。
 *
 * 为什么不看 Content-Type：那是对方服务器声明的，这里见过不少站点把图标
 * 当 text/html 发（404 页面配 200 状态码）。字节头不会撒谎。
 *
 * ICO 壳（00 00 01 00）按 image/x-icon 整包交给页面 —— Chromium 的 <img>
 * 原生支持，不需要安卓端那套抠 PNG / 解 BMP 的处理。
 */
function sniffMime(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  // ICONDIR: reserved(2)=0, type(2)=1
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  return null;
}

/**
 * 主机名 → 文件名。
 *
 * 正常主机名里只有字母数字、点和连字符。出现别的（用户手输的怪地址、
 * 或者调用方传进来一个带路径的串）一律换成下划线 —— 否则
 * ../../files/x 这种输入会让拼出来的路径写到缓存目录外面去。
 * 这是这一层唯一的输入校验。与安卓端 fileNameFor 同一条规则。
 */
function fileNameFor(host) {
  const h = host == null ? '' : String(host).toLowerCase();
  let out = '';
  for (let i = 0; i < h.length && out.length < 80; i++) {
    const c = h[i];
    const ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '.' || c === '-';
    out += ok ? c : '_';
  }
  return out.length === 0 ? 'site' : out;
}

function extOf(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/x-icon') return 'ico';
  return 'png';
}

function mimeOfExt(ext) {
  if (ext === 'jpg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'ico') return 'image/x-icon';
  if (ext === 'png') return 'image/png';
  return null;
}

/** 只收 http/https —— file:、data:、chrome-extension: 之类不进缓存。 */
function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

/* ------------------------------------------------------------------ 类 */

class FaviconCache {
  /**
   * @param {string} dir   缓存目录（每家站点一个文件，扩展名跟着格式走）
   * @param {object} opts
   *   fetchImpl(url, timeoutMs) → Promise<{ok, bytes}>；默认用全局 fetch。
   *   注入点是为单测：不联网也能把「抓到什么就存什么」这条链路走通。
   */
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.fetchImpl = opts.fetchImpl || defaultFetch;
    this.onFetched = null;      // (host) => void；抓到新图标时通知（给「重注入新标签页」用）
    this.inflight = new Set();  // 正在抓的主机名：防止同一主机被并发抓两遍
  }

  /* ---- 读 ---- */

  /** 取某主机的图标 data: URI。没缓存 / 过期 / 内容认不出来时返回 null。 */
  dataUri(host) {
    const f = this.find(host);
    if (!f) return null;
    try {
      if (Date.now() - fs.statSync(f).mtimeMs > TTL_MS) return null;
      const mime = mimeOfExt(path.extname(f).slice(1).toLowerCase());
      if (!mime) return null;
      const b = fs.readFileSync(f);
      if (!b.length) return null;
      return 'data:' + mime + ';base64,' + b.toString('base64');
    } catch {
      // 读不出来就当没有：这是「锦上添花」的东西，任何时候都不该让页面出错。
      return null;
    }
  }

  /**
   * 把这批主机里已经有图标的那些拼成 {host: dataUri}。
   *
   * 没有图标的那些刻意不出现在结果里，而不是给一个空字符串：页面那边只判
   * 「取不取得到」，不需要区分「没抓过」和「抓过但失败了」—— 两者都回落成
   * 渐变底 + 首字，那是页面本来就有的兜底。
   */
  jsonFor(hosts) {
    const out = {};
    for (const h of hosts || []) {
      if (!h) continue;
      const uri = this.dataUri(h);
      if (uri) out[h] = uri;
    }
    return out;
  }

  /* ---- 写 ---- */

  /**
   * 过期的那些，后台抓一轮（串行：一次抓七个域名各自要连 DNS、拿 TLS，
   * 并发反而把那几秒的流量堆进同一个时间窗口 —— 与安卓端同一取舍）。
   *
   * 每一项成功都回调一次 onFetched，而不是等整轮跑完 —— 先抓到的那些应该
   * 立刻出现在页面上，不用等最慢的那家（有一家连不上就要多等 8 秒超时）。
   */
  refreshIfStale(hosts) {
    const list = [...new Set((hosts || []).filter(Boolean))];
    if (!list.length) return Promise.resolve();
    let chain = Promise.resolve();
    for (const h of list) {
      chain = chain.then(() => this.refreshOne(h));
    }
    return chain;
  }

  /** 抓一家（若缓存还新就跳过）。成功落盘返回 true。 */
  async refreshOne(host) {
    if (!host || this.isFresh(host) || this.inflight.has(host)) return false;
    this.inflight.add(host);
    try {
      // 先走 https。全都没命中的话再补 http —— 还有一批站点（内网、
      // 老的政府/学校站点）压根没开 TLS，只在 http 上有图标。
      // 只补 .ico / .png 两个常见位置，不把六次请求全打一遍。
      const tries = [];
      for (const p of PATHS) tries.push('https://' + host + p);
      for (const p of ['/favicon.ico', '/favicon.png']) tries.push('http://' + host + p);
      for (const url of tries) {
        const res = await this.fetchImpl(url);
        if (!res || !res.ok || !res.bytes) continue;
        const mime = sniffMime(res.bytes);
        if (!mime) continue;
        if (this.store(host, res.bytes, mime)) {
          if (this.onFetched) this.onFetched(host);
          return true;
        }
      }
      return false;
    } finally {
      this.inflight.delete(host);
    }
  }

  /**
   * 记住一个「站点自己声明的图标地址」（来自 page-favicon-updated）。
   *
   * 盲探 PATHS 拿不到的东西这一步拿得到：很多站点的图标放在完全自定义的
   * 路径上（/?__user_favicon__ 之类），约定位置反而没有。缓存还新就跳过，
   * 否则每次导航都会对着同一家站点重复发请求。
   */
  async remember(host, iconUrl) {
    if (!host || !isHttpUrl(iconUrl) || this.isFresh(host) || this.inflight.has(host)) return false;
    this.inflight.add(host);
    try {
      const res = await this.fetchImpl(iconUrl);
      if (!res || !res.ok || !res.bytes) return false;
      const mime = sniffMime(res.bytes);
      if (!mime) return false;
      if (this.store(host, res.bytes, mime)) {
        if (this.onFetched) this.onFetched(host);
        return true;
      }
      return false;
    } finally {
      this.inflight.delete(host);
    }
  }

  /* ---- 落盘 ---- */

  isFresh(host) {
    const f = this.find(host);
    if (!f) return false;
    try { return Date.now() - fs.statSync(f).mtimeMs <= TTL_MS; } catch { return false; }
  }

  find(host) {
    if (!host) return null;
    const name = fileNameFor(host);
    for (const ext of ['png', 'jpg', 'webp', 'gif', 'ico']) {
      const f = path.join(this.dir, name + '.' + ext);
      try { if (fs.statSync(f).isFile()) return f; } catch { /* 下一个 */ }
    }
    return null;
  }

  store(host, data, mime) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const name = fileNameFor(host);
      // 先清掉这个主机的旧文件：站点换了格式（png → ico）时，留着旧的那份
      // 会被 find() 先撞上，于是「换了图标却还是旧图」。
      for (const ext of ['png', 'jpg', 'webp', 'gif', 'ico']) {
        const old = path.join(this.dir, name + '.' + ext);
        try { fs.unlinkSync(old); } catch { /* 本来就没有 */ }
      }
      fs.writeFileSync(path.join(this.dir, name + '.' + extOf(mime)), data);
      return true;
    } catch {
      return false;
    }
  }
}

/** 默认抓取实现：全局 fetch + 超时 + 体积上限。 */
async function defaultFetch(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'image/*,*/*;q=0.8' }
    });
    if (!res.ok) return { ok: false, bytes: null };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return { ok: false, bytes: null };
    return { ok: true, bytes: buf };
  } catch {
    return { ok: false, bytes: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从一份 ntp data 参数里把候选主机名抠出来。
 *
 * data 的格式由 src/renderer/ntp.js 的 buildData 决定：TSV 文本，
 * 每行 `label\turl\tvisits\tflags`。解析规则在这里只取 url 一列，
 * 不复刻排序 —— 抓图标的顺序无所谓。解析失败给空表。
 */
function hostsFromNtpData(raw) {
  const out = [];
  const lines = String(raw || '').split('\n');
  for (const line of lines) {
    const cols = line.split('\t');
    const url = cols[1];
    if (!url) continue;
    try { out.push(new URL(url).hostname); } catch { /* 跳过坏地址 */ }
  }
  return out;
}

module.exports = {
  FaviconCache,
  TTL_MS,
  MAX_BYTES,
  PATHS,
  sniffMime,
  fileNameFor,
  extOf,
  mimeOfExt,
  isHttpUrl,
  hostsFromNtpData,
  defaultFetch
};
