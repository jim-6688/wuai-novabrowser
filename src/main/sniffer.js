'use strict';

/**
 * 吾爱Nova浏览器 · 媒体嗅探引擎
 * ---------------------------------------------------------------------------
 * 干什么：盯着每个内核 session 的网络响应，把「这是音频 / 视频 / 流媒体 / 字幕」的
 * 请求挑出来，汇成一份可下载的清单。
 *
 * 为什么不是简单地看扩展名：
 *   1. 真实站点大量使用无扩展名的地址（/api/media?id=8123），扩展名一无所获；
 *   2. 反过来，`https://site.com/watch.mp4` 完全可能是返回登录页 HTML 的动态路由 ——
 *      只信扩展名就会把 HTML 当成视频列出来；
 *   3. 同一容器有多种 MIME 写法（HLS 至少有 4 种），必须归一化。
 *   所以判定是分级的：MIME 精确表 > video//audio/ 前缀 > 扩展名 > octet-stream+扩展名，
 *   每一级带上不同的置信度，并且「明确的非媒体 MIME」有一票否决权。
 *
 * 本文件不依赖 Electron —— 判定逻辑可以脱离浏览器独立跑测试。
 */

/* ========================================================================== *
 * 1. 格式注册表
 * ========================================================================== */

/** 扩展名 → [kind, container]。kind ∈ video | audio | stream | subtitle */
const EXT_TABLE = {
  /* ---- 视频容器 ---- */
  mp4: ['video', 'MP4'],
  m4v: ['video', 'M4V'],
  mov: ['video', 'MOV'],
  qt: ['video', 'MOV'],
  webm: ['video', 'WebM'],
  mkv: ['video', 'MKV'],
  avi: ['video', 'AVI'],
  divx: ['video', 'AVI'],
  flv: ['video', 'FLV'],
  f4v: ['video', 'F4V'],
  wmv: ['video', 'WMV'],
  asf: ['video', 'ASF'],
  mpg: ['video', 'MPEG'],
  mpeg: ['video', 'MPEG'],
  mpe: ['video', 'MPEG'],
  mpv: ['video', 'MPEG'],
  m1v: ['video', 'MPEG'],
  m2v: ['video', 'MPEG'],
  mp2v: ['video', 'MPEG'],
  ts: ['video', 'TS'],
  m2ts: ['video', 'M2TS'],
  mts: ['video', 'M2TS'],
  m4s: ['video', 'M4S'],
  '3gp': ['video', '3GP'],
  '3g2': ['video', '3G2'],
  '3gpp': ['video', '3GP'],
  ogv: ['video', 'OGV'],
  rm: ['video', 'RealMedia'],
  rmvb: ['video', 'RealMedia'],
  vob: ['video', 'VOB'],
  mxf: ['video', 'MXF'],
  dv: ['video', 'DV'],
  amv: ['video', 'AMV'],
  wtv: ['video', 'WTV'],
  nsv: ['video', 'NSV'],
  bik: ['video', 'Bink'],
  roq: ['video', 'RoQ'],
  y4m: ['video', 'YUV4MPEG'],
  mj2: ['video', 'MJ2'],

  /* ---- 音频容器 ---- */
  mp3: ['audio', 'MP3'],
  mp2: ['audio', 'MP2'],
  m4a: ['audio', 'M4A'],
  m4b: ['audio', 'M4B'],
  m4r: ['audio', 'M4R'],
  m4p: ['audio', 'M4P'],
  aac: ['audio', 'AAC'],
  flac: ['audio', 'FLAC'],
  wav: ['audio', 'WAV'],
  wave: ['audio', 'WAV'],
  wma: ['audio', 'WMA'],
  ogg: ['audio', 'OGG'],
  oga: ['audio', 'OGG'],
  opus: ['audio', 'Opus'],
  ape: ['audio', 'APE'],
  alac: ['audio', 'ALAC'],
  amr: ['audio', 'AMR'],
  aiff: ['audio', 'AIFF'],
  aif: ['audio', 'AIFF'],
  aifc: ['audio', 'AIFF'],
  mid: ['audio', 'MIDI'],
  midi: ['audio', 'MIDI'],
  mka: ['audio', 'MKV'],
  ac3: ['audio', 'AC3'],
  eac3: ['audio', 'EAC3'],
  dts: ['audio', 'DTS'],
  ra: ['audio', 'RealAudio'],
  ram: ['audio', 'RealAudio'],
  caf: ['audio', 'CAF'],
  wv: ['audio', 'WavPack'],
  tta: ['audio', 'TTA'],
  spx: ['audio', 'Speex'],
  gsm: ['audio', 'GSM'],
  au: ['audio', 'AU'],
  snd: ['audio', 'AU'],
  mod: ['audio', 'MOD'],
  xm: ['audio', 'XM'],
  s3m: ['audio', 'S3M'],
  it: ['audio', 'IT'],
  voc: ['audio', 'VOC'],

  /* ---- 流媒体清单（拿到的是「分片列表」，不是可直接播放的文件）---- */
  m3u8: ['stream', 'HLS'],
  m3u: ['stream', 'M3U'],
  mpd: ['stream', 'DASH'],
  f4m: ['stream', 'HDS'],
  ism: ['stream', 'MSS'],
  ismc: ['stream', 'MSS'],
  smil: ['stream', 'SMIL'],
  pls: ['stream', 'PLS'],
  asx: ['stream', 'ASX'],
  xspf: ['stream', 'XSPF'],

  /* ---- 字幕 ---- */
  srt: ['subtitle', 'SRT'],
  vtt: ['subtitle', 'VTT'],
  ass: ['subtitle', 'ASS'],
  ssa: ['subtitle', 'SSA'],
  sub: ['subtitle', 'SUB'],
  sbv: ['subtitle', 'SBV'],
  lrc: ['subtitle', 'LRC'],
  ttml: ['subtitle', 'TTML'],
  dfxp: ['subtitle', 'TTML'],
  smi: ['subtitle', 'SAMI'],
  sami: ['subtitle', 'SAMI']
};

/** MIME → [kind, container]。同一容器多种写法的都在这里归一。 */
const MIME_TABLE = {
  /* ---- 视频 ---- */
  'video/mp4': ['video', 'MP4'],
  'video/x-m4v': ['video', 'M4V'],
  'video/quicktime': ['video', 'MOV'],
  'video/webm': ['video', 'WebM'],
  'video/x-matroska': ['video', 'MKV'],
  'video/x-matroska-3d': ['video', 'MKV'],
  'video/x-msvideo': ['video', 'AVI'],
  'video/avi': ['video', 'AVI'],
  'video/msvideo': ['video', 'AVI'],
  'video/x-flv': ['video', 'FLV'],
  'video/x-f4v': ['video', 'F4V'],
  'video/x-ms-wmv': ['video', 'WMV'],
  'video/x-ms-asf': ['video', 'ASF'],
  'video/x-ms-wm': ['video', 'ASF'],
  'video/x-ms-wmx': ['video', 'ASF'],
  'video/x-ms-wvx': ['video', 'ASF'],
  'video/mpeg': ['video', 'MPEG'],
  'video/mp2p': ['video', 'MPEG'],
  'video/mp2t': ['video', 'TS'],
  'video/vnd.dlna.mpeg-tts': ['video', 'TS'],
  'video/3gpp': ['video', '3GP'],
  'video/3gpp2': ['video', '3G2'],
  'video/ogg': ['video', 'OGV'],
  'video/x-mng': ['video', 'MNG'],
  'video/vnd.rn-realvideo': ['video', 'RealMedia'],
  'video/x-realvideo': ['video', 'RealMedia'],
  'video/x-sgi-movie': ['video', 'SGI'],
  'video/x-ms-vob': ['video', 'VOB'],
  'video/x-dv': ['video', 'DV'],
  'video/mj2': ['video', 'MJ2'],
  'video/x-motion-jpeg': ['video', 'MJPEG'],

  /* ---- 音频 ---- */
  'audio/mpeg': ['audio', 'MP3'],
  'audio/mp3': ['audio', 'MP3'],
  'audio/x-mpeg': ['audio', 'MP3'],
  'audio/mp4': ['audio', 'M4A'],
  'audio/x-m4a': ['audio', 'M4A'],
  'audio/m4a': ['audio', 'M4A'],
  'audio/mp4a-latm': ['audio', 'M4A'],
  'audio/aac': ['audio', 'AAC'],
  'audio/x-aac': ['audio', 'AAC'],
  'audio/aacp': ['audio', 'AAC'],
  'audio/flac': ['audio', 'FLAC'],
  'audio/x-flac': ['audio', 'FLAC'],
  'audio/wav': ['audio', 'WAV'],
  'audio/x-wav': ['audio', 'WAV'],
  'audio/wave': ['audio', 'WAV'],
  'audio/vnd.wave': ['audio', 'WAV'],
  'audio/webm': ['audio', 'WebM'],
  'audio/ogg': ['audio', 'OGG'],
  'audio/vorbis': ['audio', 'OGG'],
  'audio/opus': ['audio', 'Opus'],
  'audio/x-ms-wma': ['audio', 'WMA'],
  'audio/x-ms-wax': ['audio', 'WMA'],
  'audio/x-ms-asf': ['audio', 'ASF'],
  'audio/amr': ['audio', 'AMR'],
  'audio/x-amr': ['audio', 'AMR'],
  'audio/aiff': ['audio', 'AIFF'],
  'audio/x-aiff': ['audio', 'AIFF'],
  'audio/midi': ['audio', 'MIDI'],
  'audio/x-midi': ['audio', 'MIDI'],
  'audio/x-matroska': ['audio', 'MKV'],
  'audio/ac3': ['audio', 'AC3'],
  'audio/vnd.dts': ['audio', 'DTS'],
  'audio/x-ape': ['audio', 'APE'],
  'audio/x-tta': ['audio', 'TTA'],
  'audio/x-caf': ['audio', 'CAF'],
  'audio/basic': ['audio', 'AU'],
  'audio/x-au': ['audio', 'AU'],
  'audio/x-mod': ['audio', 'MOD'],
  'audio/s3m': ['audio', 'S3M'],
  'audio/xm': ['audio', 'XM'],
  'audio/vnd.rn-realaudio': ['audio', 'RealAudio'],

  /* ---- 流媒体清单：HLS 的多种写法是重点，各家服务端写得都不一样 ---- */
  'application/vnd.apple.mpegurl': ['stream', 'HLS'],
  'application/vnd.apple.mpegurl.audio': ['stream', 'HLS'],
  'application/x-mpegurl': ['stream', 'HLS'],
  'application/mpegurl': ['stream', 'HLS'],
  'audio/mpegurl': ['stream', 'HLS'],
  'audio/x-mpegurl': ['stream', 'HLS'],
  'application/x-apple-mpegurl': ['stream', 'HLS'],
  'vnd.apple.mpegurl': ['stream', 'HLS'],
  'application/dash+xml': ['stream', 'DASH'],
  'application/vnd.ms-sstr+xml': ['stream', 'MSS'],
  'application/smil+xml': ['stream', 'SMIL'],
  'application/x-smil': ['stream', 'SMIL'],
  'application/vnd.apple.mpegurl.video': ['stream', 'HLS'],

  /* ---- 字幕 ---- */
  'text/vtt': ['subtitle', 'VTT'],
  'text/x-webvtt': ['subtitle', 'VTT'],
  'application/x-subrip': ['subtitle', 'SRT'],
  'text/srt': ['subtitle', 'SRT'],
  'application/ttml+xml': ['subtitle', 'TTML'],
  'application/x-sami': ['subtitle', 'SAMI']
};

/**
 * 明确的非媒体类型 —— 有一票否决权。
 * `text/html` 在第一位是有原因的：动态路由把 .mp4 当路径、实际返回登录页，
 * 是这个功能最容易翻车的地方。
 */
const NON_MEDIA_EXACT = new Set([
  'text/html', 'application/xhtml+xml',
  'text/css', 'text/javascript', 'application/javascript', 'application/x-javascript',
  'application/json', 'application/ld+json', 'application/manifest+json',
  'application/xml', 'application/rss+xml', 'application/atom+xml', 'application/soap+xml',
  'application/pdf', 'application/zip', 'application/gzip', 'application/x-gzip',
  'application/x-tar', 'application/x-7z-compressed', 'application/x-rar-compressed',
  'application/wasm', 'application/x-shockwave-flash',
  'image/svg+xml'
]);

/** 前缀级的非媒体（text/ 要在 MIME_TABLE 精确命中之后再判，否则会误杀 text/vtt 字幕） */
const NON_MEDIA_PREFIX = ['image/', 'font/', 'application/vnd.ms-fontobject'];

/** 中性类型：不算媒体，但也绝不否决扩展名的判定 */
const NEUTRAL_MIME = new Set([
  'application/octet-stream', 'binary/octet-stream', 'application/binary',
  'application/download', 'application/force-download', 'application/unknown',
  'application/x-download', 'multipart/byteranges'
]);

/** 这些容器本质上就是「切片」，出现即视为分片候选 */
const FRAGMENT_EXTS = new Set(['ts', 'm4s', 'm2ts', 'mts']);

/* ========================================================================== *
 * 2. 纯判定函数
 * ========================================================================== */

/** MIME 归一化：小写、去参数、去空格 */
function normMime(mime) {
  if (!mime) return '';
  return String(mime).split(';')[0].trim().toLowerCase();
}

/**
 * 从 URL 取扩展名。带查询串、带 hash、带 %20 编码的都要能正确取到。
 * 取不到时返回 ''。
 */
function extOf(url) {
  if (!url) return '';
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    // 相对地址或畸形 URL：退化成手工切
    path = String(url).split(/[?#]/)[0];
  }
  let name;
  try {
    name = decodeURIComponent(path);
  } catch {
    name = path; // 编码坏了就用原样
  }
  const base = name.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  // 只收合理的扩展名长度，避免把 "index.php?a=b" 这种切出奇怪东西
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

/**
 * 判定一条响应是不是媒体。
 *
 * @param {{url:string, mime?:string, size?:number}} input
 * @returns {null | {kind:string, container:string, ext:string, mime:string,
 *                   confidence:number, basis:string, reason:string}}
 *   confidence 是「我们有几分把握」，不是「文件好坏」：
 *     0.95 MIME 精确命中    0.9 video//audio/ 前缀
 *     0.75 扩展名命中        0.7 octet-stream + 扩展名
 */
function classify(input) {
  const url = (input && input.url) || '';
  const mime = normMime(input && input.mime);
  const ext = extOf(url);
  const size = Number.isFinite(input && input.size) ? input.size : -1;

  const build = (entry, confidence, basis, reason) => ({
    kind: entry[0],
    container: entry[1],
    ext,
    mime,
    size,
    confidence,
    basis,
    reason
  });

  // 第 1 级：MIME 精确表。这一级最可靠，也是唯一能救「无扩展名地址」的一级。
  if (mime && MIME_TABLE[mime]) {
    return build(MIME_TABLE[mime], 0.95, 'mime', `响应类型 ${mime}`);
  }

  // 第 2 级：一票否决。非媒体的明确声明，压过任何扩展名。
  if (mime && NON_MEDIA_EXACT.has(mime)) return null;
  if (mime && NON_MEDIA_PREFIX.some((p) => mime.startsWith(p))) return null;

  // 第 2.5 级：text/* 整体否决（text/vtt 已在第 1 级被接走，所以这里安全）
  if (mime.startsWith('text/')) return null;

  // 第 3 级：video/ 或 audio/ 前缀。类型未知也收 —— 前缀本身就是强信号。
  if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    const kind = mime.startsWith('video/') ? 'video' : 'audio';
    const byExt = ext && EXT_TABLE[ext];
    const container = byExt ? byExt[1] : '未知容器';
    return {
      kind, container, ext, mime, size, confidence: 0.9, basis: 'mime-prefix',
      reason: `响应类型 ${mime}`
    };
  }

  // 第 4 级：扩展名。
  if (ext && EXT_TABLE[ext]) {
    const neutral = !mime || NEUTRAL_MIME.has(mime);
    const confidence = neutral ? 0.7 : 0.75;
    const basis = neutral && mime ? 'octet-stream+ext' : 'ext';
    const reason = neutral && mime
      ? `通用二进制类型 + 扩展名 .${ext}`
      : (mime ? `扩展名 .${ext}（响应类型 ${mime} 不认识）` : `扩展名 .${ext}（无响应类型）`);
    return build(EXT_TABLE[ext], confidence, basis, reason);
  }

  return null;
}

/**
 * 分片候选判定（不含上下文的那部分）。
 * HLS 会把一个视频切成几百片 .ts / .m4s，全列出来会把清单淹掉。
 * 这里只做「长得像切片」的判断，是否真的算分片还要结合同目录有没有清单文件。
 */
function looksLikeFragment(url, ext, size) {
  if (!ext) return false;
  if (!FRAGMENT_EXTS.has(ext) && ext !== 'aac' && ext !== 'mp4' && ext !== 'cmfv' && ext !== 'cmfa') return false;

  // 末段是纯序号 / 带序号的切片命名
  let base = '';
  try { base = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { base = ''; }
  if (/^(seg|segment|chunk|frag|part|slice|init)?[-_]?\d{1,6}([-_]\d{1,6})?\.(ts|m4s|m2ts|mts|aac|mp4|cmfv|cmfa)$/i.test(base)) return true;

  // .ts / .m4s 本身就是切片格式，体积又不大 —— 基本可以断定
  if (FRAGMENT_EXTS.has(ext) && size >= 0 && size <= 8 * 1024 * 1024) return true;

  return false;
}

/* ========================================================================== *
 * 3. 资源池
 * ========================================================================== */

const MAX_PER_TAB = 400;
const MAX_TOTAL = 1500;

function hashId(s) {
  // FNV-1a 32 位，够用且同步 —— 不需要密码学强度
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return 'm' + h.toString(36) + s.length.toString(36);
}

/** 去掉 URL 的 hash —— 同一资源带不同锚点不该算两条 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return String(url).split('#')[0];
  }
}

class Sniffer {
  /**
   * @param {{enabled?:boolean, minSizeKB?:number, maxPerTab?:number, maxTotal?:number}} opts
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    /** 小于这个体积的不收（0 表示不按体积过滤） */
    this.minSizeKB = Math.max(0, Number(opts.minSizeKB) || 0);
    this.maxPerTab = opts.maxPerTab || MAX_PER_TAB;
    this.maxTotal = opts.maxTotal || MAX_TOTAL;

    /** tabId → Map<id, record>（Map 保序，天然按发现时间排） */
    this.byTab = new Map();
    /** tabId → { url, title } */
    this.pages = new Map();
    /** 累计统计（不随清空归零，除非 resetStats） */
    this.seen = 0;
    this.filtered = 0;
    this.onChange = null;
  }

  configure(prefs = {}) {
    if (prefs.enabled !== undefined) this.enabled = prefs.enabled !== false;
    if (prefs.minSizeKB !== undefined) this.minSizeKB = Math.max(0, Number(prefs.minSizeKB) || 0);
  }

  setPage(tabId, url, title) {
    this.pages.set(tabId, { url: url || '', title: title || '' });
  }

  /** 主框架导航到新页面 —— 该标签页的旧清单作废 */
  reset(tabId) {
    const had = (this.byTab.get(tabId) || new Map()).size;
    this.byTab.delete(tabId);
    if (had) this.emit('reset', { tabId, removed: had });
    return had;
  }

  clearAll() {
    this.byTab.clear();
    this.emit('reset', { tabId: null, removed: 0 });
  }

  resetStats() {
    this.seen = 0;
    this.filtered = 0;
  }

  /**
   * 观察一条响应。
   * @returns {{rec:object, isNew:boolean} | null} null 表示不是媒体 / 被过滤 / 已存在但无需上报
   */
  observe(input) {
    const url = (input && input.url) || '';
    if (!url || !/^https?:/i.test(url)) return null;

    const mime = normMime(input.mime);
    const size = Number.isFinite(input.size) ? input.size : -1;

    // 先看是不是已知资源（同一资源被 Range 请求反复命中是常态）
    const norm = normalizeUrl(url);
    const id = hashId(norm);
    const tabId = input.tabId;
    const bucket = this.byTab.get(tabId);

    if (bucket && bucket.has(id)) {
      const rec = bucket.get(id);
      rec.hits += 1;
      // 首次拿不到长度、这次拿到了就补上；反过来不动
      if (rec.size < 0 && size >= 0) rec.size = size;
      rec.lastAt = Date.now();
      return { rec, isNew: false };
    }

    if (!this.enabled) return null;

    const hit = classify({ url, mime, size });
    if (!hit) {
      this.filtered += 1;
      return null;
    }

    // 体积过滤：只在真的知道体积时生效，未知长度不拦
    if (this.minSizeKB > 0 && hit.size >= 0 && hit.size < this.minSizeKB * 1024) {
      this.filtered += 1;
      return null;
    }

    this.seen += 1;

    const page = this.pages.get(tabId) || {};
    const rec = {
      id,
      url,
      normUrl: norm,
      kind: hit.kind,
      container: hit.container,
      ext: hit.ext,
      mime: hit.mime || mime,
      size: hit.size,
      confidence: hit.confidence,
      basis: hit.basis,
      reason: hit.reason,
      /** 流媒体清单不能直接丢给多线程引擎 —— 它下回来的是分片列表 */
      downloadable: hit.kind !== 'stream',
      /** 分片（HLS 切片），默认折叠 */
      isSegment: this.isFragment(url, hit, tabId),
      hits: 1,
      tabId,
      pageUrl: page.url || '',
      pageTitle: page.title || '',
      /** 渲染层探测出来的媒体元数据（时长 / 分辨率），由 sniff:probe-result 回填 */
      meta: null,
      foundAt: Date.now(),
      lastAt: Date.now()
    };

    if (!this.byTab.has(tabId)) this.byTab.set(tabId, new Map());
    this.byTab.get(tabId).set(id, rec);
    this.enforceLimits(tabId);

    return { rec, isNew: true };
  }

  /**
   * 是不是分片。除了自身特征，还要看同源有没有清单文件 ——
   * CMAF 的 .mp4 切片与真正的 .mp4 视频，单看一条是分不出来的。
   */
  isFragment(url, hit, tabId) {
    const size = hit.size;
    if (!looksLikeFragment(url, hit.ext, size)) return false;

    // .ts / .m4s 这类「本来就是切片」的格式，自身特征就够了
    if (FRAGMENT_EXTS.has(hit.ext)) return true;

    // .mp4 / .aac 这种可能是正片，只有当同源存在清单文件时才认定为切片
    const bucket = this.byTab.get(tabId);
    if (!bucket) return false;
    let host = '';
    let dir = '';
    try {
      const u = new URL(url);
      host = u.host;
      dir = u.pathname.replace(/[^/]*$/, '');
    } catch { return false; }

    for (const r of bucket.values()) {
      if (r.kind !== 'stream') continue;
      try {
        const ru = new URL(r.url);
        if (ru.host === host && ru.pathname.replace(/[^/]*$/, '') === dir) return true;
      } catch { /* 忽略畸形 */ }
    }
    return false;
  }

  /** 回填渲染层探测到的元数据 */
  setMeta(id, meta) {
    for (const bucket of this.byTab.values()) {
      const rec = bucket.get(id);
      if (rec) {
        rec.meta = meta;
        this.emit('update', rec);
        return rec;
      }
    }
    return null;
  }

  enforceLimits(tabId) {
    const bucket = this.byTab.get(tabId);
    if (bucket && bucket.size > this.maxPerTab) {
      // 超限时优先淘汰分片，其次淘汰最早发现的
      const victims = [...bucket.values()]
        .sort((a, b) => (Number(b.isSegment) - Number(a.isSegment)) || (a.foundAt - b.foundAt));
      let over = bucket.size - this.maxPerTab;
      for (const v of victims) {
        if (over <= 0) break;
        bucket.delete(v.id);
        over -= 1;
      }
    }
    let total = this.totalCount();
    if (total > this.maxTotal) {
      const all = this.list().sort((a, b) => (Number(b.isSegment) - Number(a.isSegment)) || (a.foundAt - b.foundAt));
      let over = total - this.maxTotal;
      for (const v of all) {
        if (over <= 0) break;
        const b = this.byTab.get(v.tabId);
        if (b && b.delete(v.id)) over -= 1;
      }
    }
  }

  totalCount() {
    let n = 0;
    for (const b of this.byTab.values()) n += b.size;
    return n;
  }

  /**
   * 快照。
   * @param {{tabId?:number, kind?:string, withSegments?:boolean}} filter
   */
  list(filter = {}) {
    const out = [];
    const wantTab = filter.tabId;
    for (const [tabId, bucket] of this.byTab) {
      if (wantTab !== undefined && wantTab !== null && tabId !== wantTab) continue;
      for (const rec of bucket.values()) {
        if (filter.kind && rec.kind !== filter.kind) continue;
        if (filter.withSegments === false && rec.isSegment) continue;
        out.push(rec);
      }
    }
    // 新的在前
    return out.sort((a, b) => b.foundAt - a.foundAt);
  }

  stats(tabId) {
    const list = this.list(tabId === undefined ? {} : { tabId });
    const byKind = { video: 0, audio: 0, stream: 0, subtitle: 0 };
    let segments = 0;
    let bytes = 0;
    for (const r of list) {
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      if (r.isSegment) segments += 1;
      if (r.size > 0) bytes += r.size;
    }
    return {
      total: list.length,
      byKind,
      segments,
      bytes,
      seen: this.seen,
      filtered: this.filtered,
      enabled: this.enabled
    };
  }

  emit(type, payload) {
    if (this.onChange) {
      try { this.onChange(type, payload); } catch { /* 观察者出错不影响引擎 */ }
    }
  }
}

/* ========================================================================== *
 * 4. 导出
 * ========================================================================== */

/** 格式注册表规模 —— README 与界面上都拿它说话，避免手写数字对不上 */
const FORMAT_STATS = {
  extensions: Object.keys(EXT_TABLE).length,
  mimes: Object.keys(MIME_TABLE).length,
  containers: new Set(Object.values(EXT_TABLE).map((v) => v[1])).size
};

module.exports = {
  EXT_TABLE,
  MIME_TABLE,
  FRAGMENT_EXTS,
  FORMAT_STATS,
  Sniffer,
  classify,
  extOf,
  normMime,
  looksLikeFragment,
  hashId,
  normalizeUrl
};
