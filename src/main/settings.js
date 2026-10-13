'use strict';

/**
 * 极简持久化配置（原子写入）。
 * 所有用户偏好、书签、历史都在这里进出，渲染进程通过 IPC 读写。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_HOMEPAGE = 'https://52ta.top/';

const DEFAULTS = {
  homepage: DEFAULT_HOMEPAGE,
  /**
   * 新建标签页打开什么。三种具名取值：
   *   start     —— 随应用自带的这一页（品牌区 + 快捷方式九宫格）
   *   homepage  —— 跟随上面的主页
   *   blank     —— about:blank
   * 除这三种之外的值一律当「自定义地址」直接用：这个键在桌面端历史上就是
   * 一个自由地址，升级过来的人不该被悄悄改掉自己的设置。
   * 语义与移动端 NovaSettings.newTabPage 对齐。
   */
  newTabPage: 'start',
  searchTemplate: 'https://www.baidu.com/s?wd=%s',
  defaultEngine: 'chromium',
  /** auto | desktop | mobile —— auto 由窗口宽度决定 */
  layout: 'auto',
  theme: 'light',
  adblock: {
    enabled: true,
    cosmetic: true,
    level: 'standard',
    allowlist: [],
    /** 用户导入的 EasyList 风格规则文件（绝对路径） */
    userLists: [],
    /**
     * 三个拦截源的开关。
     *   adtchrome —— 广告终结者（ChinaList + EasyList 修正）
     *   abp       —— Adblock Plus（EasyList 官方规则）
     *   builtin   —— 系统内置拦截器
     */
    sources: {
      adtchrome: true,
      abp: true,
      builtin: true
    }
  },
  /** 允许站点使用第三方 Cookie / 跨站请求 */
  relaxThirdParty: false,
  restoreSession: true,
  /**
   * 上次关闭时的标签页快照，供「恢复上次会话」还原。
   * 只存 URL 与内核，不存页面内容。
   */
  session: { tabs: [], activeIndex: 0 },
  /**
   * 下载引擎偏好。
   *   takeOver  —— 页面触发的下载是否交给 Nova 多线程引擎接管（关掉则用 Chromium 内建下载器）
   *   threads   —— 单任务并发线程数；服务端不支持 Range 时自动退化为 1
   *   dir       —— 空字符串表示用系统默认下载目录
   */
  download: {
    takeOver: true,
    threads: 8,
    maxConcurrent: 3,
    dir: ''
  },
  /**
   * 媒体嗅探偏好。
   *   enabled    —— 总开关；关掉后不再解析响应头（对性能零影响）
   *   minSizeKB  —— 小于这个体积不收；0 表示不按体积过滤。
   *                 默认 0 是刻意的：嗅探是「发现」工具，宁可多列也不能漏，
   *                 体积噪声靠界面分类与排序解决，而不是在这里替用户做决定。
   *   showSegments —— 界面上是否展开 HLS 分片（切片动辄几百条）
   *   autoProbe  —— 是否自动读媒体时长 / 分辨率（只取文件头，代价极小；
   *                 但流媒体清单一律不探测 —— 那会把整条流拉起来）
   */
  sniffer: {
    enabled: true,
    minSizeKB: 0,
    showSegments: false,
    autoProbe: true
  },
  /**
   * 移动端阅读增强。
   *
   *   noImage      —— 无图模式档位：off 关闭 / image 只拦图片 / image-av 连音视频一起停。
   *                   默认关闭：这是省流量诉求下的主动选择，不该替所有人默认打开
   *                   —— 一上来就没有图，很多人会以为浏览器坏了。
   *   autoPage     —— 自动拼页：滚到底自动把下一页正文接到当前页尾部。
   *                   默认关闭，同上。
   *   autoPageMax  —— 单次最多拼几页。不是性能考虑，是防呆：有些站点的「下一页」
   *                   实际指向下一篇完全不相干的文章，不设上限会一路拼下去。
   */
  mobile: {
    noImage: 'off',
    autoPage: false,
    autoPageMax: 10
  },
  extensions: [],
  bookmarks: [
    { title: '52ta', url: 'https://52ta.top/' }
  ],
  history: [],
  /**
   * 新标签页上用户手工增删的快捷方式。
   *   added   —— 用户点「＋添加」加进来的（这些排在候选最前面）
   *   removed —— 用户点 × 删掉的**归一化主机名**
   *
   * 为什么 removed 必须单独记一份：历史记录不会因为用户在新标签页上点了个 ×
   * 就把那几条删掉。不记下来的话，下次生成候选时那家站点立刻又爬回来 ——
   * 用户的感受是「这个 × 是假的」。与安卓端 NovaStore 的 ntp.* 两个键同义。
   */
  ntpShortcuts: { added: [], removed: [] },
  /**
   * 下载任务快照（供界面重启后还原列表）。
   * 分片级游标不在这个文件里 —— 那由每个文件旁边的 <文件名>.novadl.json 负责，
   * 免得下载几次就把设置文件撑到几兆。
   */
  downloadTasks: []
};

let cache = null;
let filePath = null;
let writeTimer = null;

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function init(userDataDir) {
  filePath = path.join(userDataDir, 'nova-settings.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    cache = deepMerge(DEFAULTS, JSON.parse(raw));
  } catch {
    cache = deepMerge(DEFAULTS, {});
    flush();
  }
  return cache;
}

function flush() {
  if (!filePath) return;
  const tmp = filePath + '.tmp';
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error('[settings] 写入失败:', err.message);
  }
}

function scheduleFlush() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 250);
}

function all() {
  return cache;
}

function get(key, fallback) {
  const v = key.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), cache);
  return v === undefined ? fallback : v;
}

function patch(partial) {
  cache = deepMerge(cache, partial);
  scheduleFlush();
  return cache;
}

/**
 * 这个地址值不值得进历史。
 *
 * 只有 http/https 算数。少了这一道，内置新标签页自己会被记进历史 ——
 * 它的地址是一条 `file:///…/newtab.html?theme=…&data=…`，于是历史列表里
 * 多出一条几 KB 长、点进去毫无意义的条目；更糟的是它下一次又会作为
 * 「访问过的站点」被选成新标签页的快捷方式候选，首页上凭空出现一个
 * 指向自己的图标。about:blank 同理（它是空白页本身）。
 *
 * 与安卓端 HistoryStore.recordable 是同一条规则。
 */
function historyRecordable(url) {
  if (!url) return false;
  const s = String(url).trim().toLowerCase();
  return s.indexOf('http://') === 0 || s.indexOf('https://') === 0;
}

function pushHistory(entry) {
  if (!entry || !historyRecordable(entry.url)) return;
  const list = cache.history;
  // 连续同一 URL 去重
  if (list[0] && list[0].url === entry.url) {
    list[0].visits = (list[0].visits || 1) + 1;
    list[0].ts = Date.now();
  } else {
    list.unshift(Object.assign({ visits: 1, ts: Date.now() }, entry));
  }
  if (list.length > 2000) list.length = 2000;
  scheduleFlush();
}

function clearHistory() {
  cache.history = [];
  scheduleFlush();
}

function addBookmark(bm) {
  if (!cache.bookmarks.some((b) => b.url === bm.url)) cache.bookmarks.unshift(bm);
  scheduleFlush();
}

function removeBookmark(url) {
  cache.bookmarks = cache.bookmarks.filter((b) => b.url !== url);
  scheduleFlush();
}

module.exports = {
  DEFAULT_HOMEPAGE,
  DEFAULTS,
  init,
  flush,
  all,
  get,
  patch,
  pushHistory,
  historyRecordable,
  clearHistory,
  addBookmark,
  removeBookmark,
  path: () => filePath
};
