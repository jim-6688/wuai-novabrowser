'use strict';

/**
 * 无图模式 · 移动端省流量
 * ---------------------------------------------------------------------------
 * 在请求发出之前就把图片掐掉 —— 这是唯一真正省流量的位置。图片一旦进了响应
 * 阶段，字节已经在路上，此时再隐藏元素只是「眼不见为净」，流量一分没省。
 *
 * 为什么不单独注册一个 onBeforeRequest 监听器：Electron 对同一个 webRequest
 * 事件只保留最后注册的那一个，重复注册会静默覆盖掉前一个。广告拦截已经占着
 * onBeforeRequest，所以无图判定必须并进那条闸门 —— 由闸门先问一句
 * 「这条要不要拦」，再走广告规则。
 *
 * 本模块只做判定与记账，不碰 Electron，因此可以脱离浏览器独立验证。
 */

/**
 * 档位。
 *   off       关闭
 *   image     无图：拦下所有图片请求
 *   image-av  无图 + 视频：再停掉音视频的自动加载（移动流量的大头）
 */
const LEVELS = ['off', 'image', 'image-av'];

/**
 * 每档拦哪些 resourceType。
 *
 * 字体（font）刻意不在其列：眼下大量站点的界面图标就是字体（Iconfont、
 * Font Awesome 这类），拦掉会让页面直接散架，而省下来的字节远不如图片和
 * 视频可观。宁可少省一点，也别把页面搞坏 —— 这也是「无图」没有扩成
 * 「无图无字无一切」的原因。
 */
const LEVEL_TYPES = {
  off: [],
  image: ['image'],
  'image-av': ['image', 'media']
};

const LEVEL_LABEL = {
  off: '关闭',
  image: '无图',
  'image-av': '无图 + 视频'
};

/**
 * 必须放行的图片请求。
 *
 * 这是一份启发式名单，不是标准。标签页图标被拦掉会让人以为浏览器坏了，
 * 而它通常只有几 KB，省它没有任何意义 —— 所以宁可放宽。
 */
const KEEP_RE = [
  /\/favicon[^/]*$/i,
  /\.ico(\?|#|$)/i
];

/**
 * 注入页面的占位样式。
 *
 * 图片被拦掉之后，Chromium 会画出破图图标并显示 alt 文字，整页看起来像坏了。
 * 这里用一块灰底把位置占住：有显式尺寸的图保持原尺寸，纯靠图片自身撑开的
 * 则收到 36px 的最小高度，至少不像一排碎玻璃。
 *
 * 用 html.nova-no-image 作用域而不是直接命中 img，是为了让「本页显示图片」
 * 能够在不重新注入样式的前提下整体撤销。
 */
const PLACEHOLDER_CSS = `
html.nova-no-image img {
  background-color: rgba(128, 132, 140, .16) !important;
  background-image: none !important;
  color: transparent !important;
  font-size: 0 !important;
  min-height: 36px;
  box-shadow: none !important;
}
html.nova-no-image picture source,
html.nova-no-image [style*="background-image"] {
  background-image: none !important;
}
`;

/** 给页面打上作用域类。与上面的样式成对出现，缺一不可。 */
const PLACEHOLDER_JS = "document.documentElement.classList.add('nova-no-image');";

function normalizeLevel(v) {
  return LEVELS.includes(v) ? v : 'off';
}

/** 是否属于「不该拦」的图片请求 */
function isKept(url) {
  for (let i = 0; i < KEEP_RE.length; i++) {
    if (KEEP_RE[i].test(url)) return true;
  }
  return false;
}

class NoMedia {
  /**
   * @param {object} opts
   * @param {string}   opts.level     档位
   * @param {function} opts.isInternal webContentsId → 是否浏览器自己的界面。
   *   设置页、嗅探预览都在发请求，它们不是「页面里的内容」，一律放行。
   *   不排除的话，用户打开嗅探页预览一次视频，视频就被自己的省流量开关拦了。
   */
  constructor(opts = {}) {
    this.isInternal = typeof opts.isInternal === 'function' ? opts.isInternal : null;
    this.allowUrls = new Map();   // webContentsId → Set<url>：点名放行的单张图
    this.allowPages = new Set();  // webContentsId：整页放行（「显示本页图片」）
    // 顺序不能反：snapshot() 要读 this.types，所以得先把档位定下来再建台账
    this.types = new Set();
    this.configure(opts);
    this.resetStats();
  }

  configure(opts = {}) {
    if (opts.level != null) {
      this.level = normalizeLevel(opts.level);
      this.types = new Set(LEVEL_TYPES[this.level]);
      this.enabled = this.level !== 'off';
    } else if (!this.types) {
      this.level = 'off';
      this.types = new Set();
      this.enabled = false;
    }
    return this;
  }

  resetStats() {
    this.stats = { blocked: 0, byType: { image: 0, media: 0 } };
    this.byTab = new Map();
    return this.snapshot();
  }

  /**
   * 判定一条请求该不该被无图模式拦下。
   * 返回 resourceType（'image' / 'media'）表示拦，返回 null 表示放行。
   *
   * 注意这里只判定、不记账 —— 记账拆到 record() 里，好让测试能单独验证判定。
   */
  shouldBlock(details) {
    if (!this.enabled) return null;

    const type = details.resourceType;
    if (!this.types.has(type)) return null;

    const wc = details.webContentsId;
    if (this.isInternal && this.isInternal(wc)) return null;
    if (this.allowPages.has(wc)) return null;

    const urls = this.allowUrls.get(wc);
    if (urls && urls.has(details.url)) return null;

    if (isKept(details.url)) return null;

    return type;
  }

  /** 拦下之后的记账。返回累计拦截数。 */
  record(type, wcId) {
    this.stats.blocked += 1;
    if (this.stats.byType[type] == null) this.stats.byType[type] = 0;
    this.stats.byType[type] += 1;
    this.byTab.set(wcId, (this.byTab.get(wcId) || 0) + 1);
    return this.stats.blocked;
  }

  /** 点名放行一个 URL（留给「单独看这张」这类入口，目前界面上没开） */
  allowUrl(wcId, url) {
    let set = this.allowUrls.get(wcId);
    if (!set) { set = new Set(); this.allowUrls.set(wcId, set); }
    set.add(url);
    return set.size;
  }

  /**
   * 整页放行。
   * 语义是「这一页的图片都正常加载」，所以调用方必须配合重载页面才看得到效果
   * —— 已经被拦掉的请求不会因为放行而自己回来。
   */
  allowPage(wcId) {
    this.allowPages.add(wcId);
    return true;
  }

  isPageAllowed(wcId) {
    return this.allowPages.has(wcId);
  }

  /**
   * 清掉某个标签页的放行状态。
   * 主框架导航时必须调用：否则用户在第一页点了「显示图片」，翻到第二页
   * 图片照样全放行，而用户以为放行只对刚才那一页生效。
   */
  clear(wcId) {
    this.allowUrls.delete(wcId);
    this.allowPages.delete(wcId);
    this.byTab.delete(wcId);
  }

  clearAll() {
    this.allowUrls.clear();
    this.allowPages.clear();
    this.byTab.clear();
  }

  /**
   * 给界面看的快照。
   *
   * 只有条数、没有「省下多少 MB」—— 被拦下的请求根本不会有响应头，
   * Content-Length 无从得知。按平均图片大小乘一乘估一个数很好看，但那是编的，
   * 这里不干这种事。
   */
  snapshot(wcId) {
    return {
      level: this.level,
      label: LEVEL_LABEL[this.level],
      types: [...this.types],
      blocked: this.stats.blocked,
      byType: Object.assign({ image: 0, media: 0 }, this.stats.byType),
      tabBlocked: wcId == null ? 0 : (this.byTab.get(wcId) || 0),
      pageAllowed: wcId == null ? false : this.isPageAllowed(wcId)
    };
  }
}

module.exports = {
  NoMedia,
  LEVELS,
  LEVEL_LABEL,
  LEVEL_TYPES,
  KEEP_RE,
  PLACEHOLDER_CSS,
  PLACEHOLDER_JS,
  normalizeLevel,
  isKept
};
