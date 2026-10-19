'use strict';

/**
 * 极简持久化配置（原子写入）。
 * 所有用户偏好、书签、历史都在这里进出，渲染进程通过 IPC 读写。
 */

const fs = require('fs');
const path = require('path');

// 内置站点清单只有一份（在 ntp.js 里），宫格拿它补位、收藏夹拿它开张。
// 在这里再抄一份 URL，就是把「内置入口有哪几个」这件事写成了两份。
const ntp = require('../renderer/ntp');

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
  /**
   * 按站点自动切换内核。数组便于整体替换：
   *   [{ host: 'example.com', engine: 'trident' }]
   * 匹配顺序是「精确主机 → 逐级父域」：写 example.com 也会命中 www.example.com。
   */
  siteEngines: [],
  /** auto | desktop | mobile —— auto 由窗口宽度决定 */
  layout: 'auto',
  theme: 'light',
  /**
   * 自动更新（仅 PC，且只在打包版有意义）。
   *
   *   autoDownload —— 发现新版就自己下（下整包约 78MB，支持不了差分，见 updater.js）
   *   autoInstall  —— 下载完就**拉起安装器并重启**去装
   *
   * 两个默认都开：这是「装上就不用管」的那条路。关掉任一之后退回
   * 原来的「工具栏挂个角标、下载与安装都要自己点」。
   *
   * autoInstall 的代价要说清：它会重启浏览器，当前页面里没保存的内容会丢。
   * 所以界面上给了一个倒计时窗口让用户能喊停（见 renderer 的 autoInstallSoon），
   * 而不是下载完就立刻退 —— 那样用户连看清楚发生了什么的机会都没有。
   */
  update: {
    autoDownload: true,
    autoInstall: true
  },
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
  /**
   * 收藏夹栏（桌面端）。三种取值：
   *   always  —— 常驻在地址栏下方（默认）
   *   ntp     —— 只在新标签页露出来，浏览网页时把这一行高度还给页面
   *   hidden  —— 不显示；书签仍在「设置 → 书签」里管
   *
   * 位置写死在一处：地址栏与网页视口之间。往上就是标签条，这条栏没有
   * 第二处可放 —— 所以这一项给的不是「上/下」，而是「什么时候露出」。
   * 取值不在表里的一律当 always：用户不该因为配置文件脏了就少掉一条栏。
   *
   * 安卓端也有收藏夹栏，但形态不同（顶栏按钮按需唤出，不是常驻一行），
   * 因此不读这一项 —— 那边是 NovaSettings.bookmarkBarButton 一个开关，
   * 刻意不做三档：手机上这一行本来就占地方，再给「仅新标签页」只是徒增解释成本。
   */
  bookmarkBar: 'always',
  /**
   * 书签。
   *
   * 初值就是新标签页宫格里的那六个内置入口（ntp.js 的 BUILTIN_SITES）——
   * 同一份数据两处用：宫格拿它把不足的格子补齐，收藏夹拿它开张。
   * 两边都是「装好就能点」，而不是先给用户一个空收藏夹让他自己去找。
   *
   * 老配置的补种见 seedBookmarks()：数组在 deepMerge 里是整体覆盖的，
   * 只改这里的初值对已经装过的用户一个字节都影响不到。
   */
  bookmarks: ntp.BUILTIN_SITES.map((s) => ({ title: s.label, url: s.url })),
  /**
   * 内置站点补种标记：0 没补过，1 补过了。
   *
   * 补过就打标，是因为「补种」必须是一次性的：否则用户删掉某个内置书签，
   * 下次启动又照 DEFAULTS 补回来 —— 那个删除动作就是假的。
   * 同一个道理，新标签页那边用户点掉的站点记在 ntpShortcuts.removed 里。
   */
  bookmarkSeed: 0,
  /**
   * 内置地址修订标记：0 没修过，1 修过了（见 fixBookmarkUrls）。
   * 与 bookmarkSeed 分开记：那一个是「种子用掉了没有」，这一个是
   * 「写错的地址改过来了没有」，两件事的时机不一样。
   */
  bookmarkFix: 0,
  /**
   * 桌面快捷方式补建标记：0 没补过，1 补过了。
   *
   * 只有免安装（绿色版）这条路用得上 —— 走安装包进来的用户，图标是 NSIS 安装器
   * 放进桌面的，我们只会读到一个「桌上已有」。补过（或确认已有）就打标，
   * 同样是「只做一次」，理由与 bookmarkSeed 那段完全一样：用户删了图标，
   * 下次开浏览器它又长回来，那个删除动作就成了假的。
   * 细节见 src/main/desktop-shortcut.js 的模块头。
   */
  desktopShortcut: 0,
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

/**
 * 把内置那六个站点补进收藏夹。只做一次（见 DEFAULTS.bookmarkSeed 的说明）。
 *
 * 判重按**完整 URL**，不按主机名 —— 与宫格补位同一条口径。内置那几条本来
 * 就是同一家的不同入口（「主页」是 www 那条、「导航」是裸域那条），按主机名
 * 判重会把两条并成一条，用户数一数发现少了一个。
 *
 * 顺序上把补进来的接在用户已有书签**后面**：他原来的东西不该被挤位。
 */
function seedBookmarks() {
  if (!cache || (cache.bookmarkSeed | 0) >= 1) return;
  if (!Array.isArray(cache.bookmarks)) cache.bookmarks = [];
  const have = new Set(cache.bookmarks.map((b) => (b && b.url) || ''));
  for (const s of ntp.BUILTIN_SITES) {
    if (!s.url || have.has(s.url)) continue;
    have.add(s.url);
    cache.bookmarks.push({ title: s.label, url: s.url });
  }
  cache.bookmarkSeed = 1;
  scheduleFlush();
}

/**
 * 内置地址里写错过的那几个 —— 老用户也要改过来。
 *
 * 为什么不能只改 ntp.js：BUILTIN_SITES 只对**新装**的人生效。老用户收藏夹里
 * 那一条是上一个版本种下去的（书签是整条存下来的，不是存个「内置第 3 条」的
 * 引用），文件里躺着的就是那个错地址 —— 光改常量，他看到的仍然是错的。
 *
 * 这是**修订一处已知的错误**，不是每次启动都去覆盖用户的编辑：所以同样只做一次。
 * 用户如果自己把地址改回了错的，也认他的 —— 打过标就不再动。
 *
 * 顺带把宫格那边的删除记录也接上：用户点掉过这条内置项的话，ntpShortcuts.removed
 * 里记的是**旧主机名**。改了地址而不同步，新主机名不在名单里，那个 × 就等于白点了
 * —— 他删掉的站点过一版又自己回来了。
 */
const URL_FIXES = [
  // 播放器：misuc → music（2026-10 修订）
  ['https://misuc.52ta.top/', 'https://music.52ta.top/']
];

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

function fixBookmarkUrls() {
  if (!cache || (cache.bookmarkFix | 0) >= 1) return;
  if (!Array.isArray(cache.bookmarks)) cache.bookmarks = [];

  for (const bm of cache.bookmarks) {
    if (!bm) continue;
    for (const [wrong, right] of URL_FIXES) {
      if (bm.url === wrong) bm.url = right;
    }
  }

  const removed = cache.ntpShortcuts && cache.ntpShortcuts.removed;
  if (Array.isArray(removed)) {
    for (const [wrong, right] of URL_FIXES) {
      const oldHost = hostOf(wrong);
      const newHost = hostOf(right);
      if (oldHost && newHost && removed.includes(oldHost) && !removed.includes(newHost)) {
        removed.push(newHost);
      }
    }
  }

  cache.bookmarkFix = 1;
  scheduleFlush();
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
  // 顺序有讲究：先补种再修订。新装的人由补种拿到正确地址（DEFAULTS 就是对的），
  // 修订对他是个空操作；老用户补种早就用掉了，靠修订把存下来的错地址改过来。
  seedBookmarks();
  fixBookmarkUrls();
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
