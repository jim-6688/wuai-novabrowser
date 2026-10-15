'use strict';

/**
 * 新标签页 · 宿主侧逻辑（桌面端）
 * ---------------------------------------------------------------------------
 * 这一页本身是 `src/renderer/newtab.html`，与移动端共用同一份源。页面负责
 * 排序与呈现，剩下的三件事在这里：
 *
 *   1) <b>数据进去</b> —— 把「用户自己加的 + 历史里的常去站点」编码成
 *      逐行文本，挂到页面地址的 `data` 参数上。
 *   2) <b>地址拼装</b> —— 新标签页那三种取值分别指向哪里。
 *   3) <b>动作出来</b> —— 页面跳 `nova://shortcut/…` 时解析成一条命令。
 *
 * 为什么单独一个文件：这套规则要跑在两个地方 —— Node 里被 require 做单测
 * （见 tools/test-newtab.js），以及外壳页面里当普通脚本加载。所以写法跟
 * autopage.js 一致：顶层函数声明 + 双导出。这样测的就是跑的那一份，
 * 不存在「测试版本和行为版本是两份代码」。
 *
 * 移动端那一半是 android-app 里的 NewTab.java，两边刻意保持同一套语义：
 * 同一套分隔符、同一个主机名归一化、同一套命令格式、同一个候选上限。
 * 改一边就要照着改另一边，否则「手机上少两个图标」这种问题不会有人报。
 */

/** 页面回传动作时用的 scheme。与 newtab.html 里的 SCHEME 一字不差。 */
const CMD_PREFIX = 'nova://shortcut/';

/** 日志与命令里用的操作名。 */
const OP_ADD = 'add';
const OP_REMOVE = 'remove';
/** 内置新标签页的「插件商店」入口：点一下打开扩展面板（含商店）。仅 PC 端会触发，
 *  因为共享页面靠 PC 主机多挂的那个 store=1 参数才显示这个入口。 */
const OP_STORE = 'extstore';

/**
 * 一次最多送多少条候选过去。页面只显示 7 格，送 30 条是为了让「按访问次数
 * 排序」真的有意义 —— 只送最近几条的话，一个很久以前被访问过上百次的站点
 * 永远进不了视野。
 */
const MAX_CANDIDATES = 30;

/**
 * 页面上真正摆得下的格数。补位（见 {@link BUILTIN_SITES}）以它为目标：
 * 「别让这一屏空着」。与页面侧的 MAX_SHORTCUTS 同值，两边都由这一条语义决定。
 */
const MAX_TILES = 7;

/**
 * 官方推荐位。候选不够填满版面时，用它们把后面的格子补齐。
 *
 * 为什么要补：候选一旦非空，「候选为空才兜底」这条规则就再也不会生效 ——
 * 一个只访问过两三个站点的用户（或者刚清过历史的用户），新标签页上就只剩
 * 两三个磁贴，内置的六个入口整体退场。用户的感受是「宫格被删了」，而不是
 * 「我还没访问过几个站」。
 *
 * 与 newtab.html 里的 FALLBACK 是**同一份数据**：那边是页面自身的兜底
 * （宿主数据没送到时也得有一屏能看的东西），这边是宿主侧的补位。两份由
 * tools/test-newtab.js 逐条比对锁住，改一份漏一份会被测试拦下。
 */
const BUILTIN_SITES = [
  { label: '主页', url: 'https://www.52ta.top/' },
  { label: '导航', url: 'https://52ta.top/' },
  { label: '播放器', url: 'https://music.52ta.top/' },
  { label: '浏览器', url: 'https://nova.52ta.top/' },
  { label: '百度', url: 'https://www.baidu.com/' },
  { label: 'DeepSeek', url: 'https://chat.deepseek.com/' }
];

/** 磁贴底下只有一行的位置，名称超过这个长度就会被省略号吃掉。 */
const MAX_LABEL = 12;

/** 新标签页那三种具名取值。除这三种之外的值一律当「自定义地址」。 */
const MODES = ['start', 'homepage', 'blank'];

/**
 * 站点名与页面名之间的常见分隔符。按「先长后短」的顺序试：
 * `' - '` 必须排在 `'-'` 前面，否则「A-B 公司」这种名字里
 * 本来就带连字符的会被误切。
 */
const TITLE_SEPS = [' - ', ' – ', ' — ', ' | ', ' · ', '｜', '|', '_', '－'];

/* ------------------------------------------------------------------ *
 * 地址与主机名
 * ------------------------------------------------------------------ */

/**
 * 从 URL 取主机名；取不到就返回空串。
 *
 * 与 Tab.hostOf（安卓）、newtab.html 里那份 hostOf 的分支保持一致：
 * 没有 `://` 的（about:blank）原样返回 —— 硬套「去端口」会把
 * `about:blank` 砍成 `about`，那是已经踩过一次的真 bug。
 */
function hostOf(url) {
  if (!url) return '';
  const s0 = String(url);
  const i = s0.indexOf('://');
  if (i < 0) return s0;
  const s = s0.slice(i + 3);
  let end = s.length;
  for (let k = 0; k < s.length; k++) {
    const c = s.charAt(k);
    if (c === '/' || c === '?' || c === '#') { end = k; break; }
  }
  let host = s.slice(0, end);
  const at = host.lastIndexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  // [::1]:8080 这种方括号里的冒号不是端口分隔符
  const colon = host.lastIndexOf(':');
  if (colon > 0 && host.indexOf(']') < colon) host = host.slice(0, colon);
  return host;
}

/**
 * 比对「用户不想在新标签页上看到的站点」用的键。
 *
 * 按主机名而不是按完整 URL 记：用户点掉一个磁贴的意思是「我不想在这儿看到
 * 这家」，不是「我不想看到这一个页面」。按 URL 记的话，知乎换个路径又能
 * 爬回来一次，用户就得一个页面一个页面地删。
 *
 * 去 `www.` 前缀、转小写：`WWW.Zhihu.com` 与 `zhihu.com`
 * 是同一家，不归一化就会出现「删了又回来」。
 */
function hostKey(url) {
  let h = hostOf(url);
  if (!h) return '';
  h = h.trim().toLowerCase();
  if (h.indexOf('www.') === 0) h = h.slice(4);
  return h;
}

/** 只有 http/https 值得进新标签页的候选：about:blank 是空白页本身，
 *  file:// 会把本机路径当站点名亮在首页上。与 HistoryStore.recordable 同义。 */
function recordable(url) {
  if (!url) return false;
  const s = String(url).trim().toLowerCase();
  return s.indexOf('http://') === 0 || s.indexOf('https://') === 0;
}

/* ------------------------------------------------------------------ *
 * 名称
 * ------------------------------------------------------------------ */

/** 标签里不能出现制表符和换行 —— 它们是这一层的分隔符。真出现（用户从别处
 *  粘进来）就换成空格，宁可名字少一个分隔符，也不能让一行被拆成两行、
 *  凭空多出一个磁贴。 */
function sanitize(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[\t\n\r]/g, ' ').trim();
}

/**
 * 从页面标题里取一个能塞进磁贴的短名。
 *
 * 标题最常见的形态是「页面名 - 站点名」。直接拿来当磁贴名称，11sp 的字号下
 * 那点宽度只够放下四五个字，用户看到的是清一色的「知乎 - 有…」，七格全一个样，
 * 等于没有名字。所以先按常见分隔符切一刀取前半段，再按长度截断。
 *
 * 切的条件是前半段<b>至少两个字</b>：「8-12岁英语」里那个连字符后面是内容
 * 而不是站点名，切了反而丢掉一半信息。
 */
function labelOf(title, url) {
  let s = sanitize(title);
  if (s) {
    for (const sep of TITLE_SEPS) {
      const i = s.indexOf(sep);
      if (i >= 2) { s = sanitize(s.slice(0, i)); break; }
    }
  }
  if (!s) return hostKey(url);
  // 按码点截断：直接 slice 会把 emoji 这类增补平面字符切成半个，
  // 显示成一个方块字符 —— 而磁贴上的字恰恰是最显眼的地方。
  const cp = Array.from(s);
  if (cp.length > MAX_LABEL) s = cp.slice(0, MAX_LABEL).join('');
  return s;
}

/* ------------------------------------------------------------------ *
 * 候选 → 逐行文本
 * ------------------------------------------------------------------ */

/**
 * 排序：固定项在前，其余按访问次数降序，次数相同按名称升序。
 *
 * 与页面里 rank() 的同名规则要对得上，但两边排的是不同的东西：这边排是为了
 * 在 `MAX_CANDIDATES` 这个上限里**优先保住常去的站点**，页面排是为了
 * 在 7 格版面里决定谁上谁下。少了这边这一次，一个访问过上百次的站点会因为
 * 「最近没去过」而被截掉。
 */
function compareCandidates(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.visits !== b.visits) return b.visits - a.visits;
  return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0);
}

/**
 * 把三个来源合成页面要的那段文本：`label<TAB>url<TAB>visits<TAB>flags`，
 * 一行一条，最多 `MAX_CANDIDATES` 条。
 *
 * @param {{added?:Array, history?:Array, removed?:Array}} sources
 *        added   用户自己加的（pinned）
 *        history 浏览历史（带 visits）
 *        removed 用户点掉过的归一化主机名
 */
function buildData(sources) {
  const src = sources || {};
  const added = Array.isArray(src.added) ? src.added : [];
  const history = Array.isArray(src.history) ? src.history : [];
  const removed = Array.isArray(src.removed) ? src.removed : [];

  const blocked = Object.create(null);
  for (const k of removed) if (k) blocked[k] = 1;

  // 去重按主机名，和页面上那条规则一致：zhihu.com 的历史里可能有几十条
  // 不同的问题页，不去重的话七个格子会被同一家占满 —— 那就不叫快捷方式了。
  const seen = Object.create(null);
  // 另外记一份「已经出现过的完整 URL」，只给下面补位时判重用（口径不同，见那儿）。
  const seenUrls = Object.create(null);
  const rows = [];

  for (const a of added) {
    if (!a || !a.url) continue;
    const k = hostKey(a.url);
    if (!k || seen[k]) continue;
    seen[k] = 1;
    seenUrls[a.url] = 1;
    rows.push({ label: sanitize(a.label) || k, url: a.url, visits: 0, pinned: true });
  }

  for (const h of history) {
    if (!h || !recordable(h.url)) continue;
    const k = hostKey(h.url);
    if (!k || blocked[k] || seen[k]) continue;
    seen[k] = 1;
    seenUrls[h.url] = 1;
    rows.push({
      label: labelOf(h.title, h.url),
      url: h.url,
      visits: parseInt(h.visits, 10) || 0,
      pinned: false
    });
  }

  rows.sort(compareCandidates);

  // 真实候选不够填满版面时，用官方推荐把后面的格子补齐（见 BUILTIN_SITES）。
  //
  // 两个刻意的选择：
  //   1) 追加在排序之后、不进 compareCandidates —— 这几个是垫底的，不该跟
  //      用户自己的常去站点抢前几位；顺序也照 BUILTIN_SITES 给定，不重排。
  //      页面侧同样把它们放在最后一堆（flags 里的 'f'），两端看法一致。
  //   2) 判重按**完整 URL** 而不是主机名 —— 内置这几条本来就是同一家的不同
  //      入口（「主页」是 www 那条、「导航」是裸域那条），按主机名去重会凭空
  //      少掉两格，用户看到的就是「六宫格又缺了一角」。
  for (const site of BUILTIN_SITES) {
    if (rows.length >= MAX_TILES) break;
    const k = hostKey(site.url);
    if (!k || blocked[k] || seenUrls[site.url]) continue;
    seenUrls[site.url] = 1;
    rows.push({ label: site.label, url: site.url, visits: 0, pinned: false, builtin: true });
  }

  const out = [];
  for (const r of rows) {
    if (out.length >= MAX_CANDIDATES) break;
    if (!r.url) continue;
    const flags = r.pinned ? 'p' : (r.builtin ? 'f' : '-');
    out.push([sanitize(r.label), r.url, r.visits, flags].join('\t'));
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * 增删快捷方式
 * ------------------------------------------------------------------ */

/** 把存下来的那两个列表归一化：坏值丢掉，别让一个手改过的配置文件把首页搞崩。 */
function normShortcuts(store) {
  const o = (store && typeof store === 'object') ? store : {};
  return {
    added: (Array.isArray(o.added) ? o.added : []).filter((a) => a && a.url),
    removed: (Array.isArray(o.removed) ? o.removed : [])
      .filter((k) => typeof k === 'string' && k)
  };
}

/**
 * 加一条自己加的快捷方式，返回新的存储对象。
 *
 * 同一家站点只留一条：页面上本来就是按主机名去重的，这里不去的话，
 * 存储里会攒下一堆永远不会显示的重复项。
 *
 * 顺手把这个站点从 removed 里清掉 —— 用户先删后加同一个站点时，不清的话
 * 它会被自己的「已移除」记录挡在门外，表现是「加了但没出现」。
 */
function addShortcut(store, label, url) {
  const cur = normShortcuts(store);
  if (!url) return cur;
  const key = hostKey(url);
  const name = sanitize(label) || key;
  const added = cur.added.filter((a) => hostKey(a.url) !== key);
  added.push({ label: name, url });
  return { added, removed: cur.removed.filter((k) => k !== key) };
}

/**
 * 点掉一个磁贴，返回新的存储对象。
 *
 * 两条路都要走：从 added 里摘掉（如果本来就在里面），并且把这个主机名记进
 * removed。只做前者的话，一个既在历史里、又被用户加过的站点会立刻从历史
 * 那边回来 —— 用户的感受是「这个 × 是假的」。
 */
function removeShortcut(store, url) {
  const cur = normShortcuts(store);
  if (!url) return cur;
  const key = hostKey(url);
  if (!key) return cur;
  return {
    added: cur.added.filter((a) => hostKey(a.url) !== key),
    removed: cur.removed.indexOf(key) >= 0 ? cur.removed : cur.removed.concat([key])
  };
}

/* ------------------------------------------------------------------ *
 * 地址拼装
 * ------------------------------------------------------------------ */

/**
 * 归一化 newTabPage 的取值。
 *
 * 历史上这个键在桌面端就是**一个自由地址**，在移动端却是个
 * `blank|homepage` 的枚举（而且从来没有任何地方读过它 —— 是个死设置）。
 * 现在两端统一成这三种具名取值，同时保留旧配置：认不出来的值（含用户以前
 * 自己填的地址）一律当「自定义地址」直接用，不让升级把它悄悄改掉。
 */
function modeOf(value) {
  return MODES.indexOf(value) >= 0 ? value : 'custom';
}

/** 页面地址。base 是本机那个 newtab.html 的 file:// 地址。 */
function pageUrl(base, theme, data) {
  const q = ['theme=' + encodeURIComponent(theme === 'dark' ? 'dark' : 'light')];
  // 空的 data 参数会让页面以为「宿主明确说没有候选」，而它的正确行为是
  // 退回内置兜底那七个。所以没有候选时干脆不挂这个参数。
  if (data) q.push('data=' + encodeURIComponent(data));
  return base + '?' + q.join('&');
}

/**
 * 新建标签页该去哪。
 *
 * @param {string} value     settings.newTabPage（三种具名取值，或一个旧的自定义地址）
 * @param {{homepage:string, base:string, theme:string, data:string}} ctx
 */
function target(value, ctx) {
  const c = ctx || {};
  switch (modeOf(value)) {
    case 'blank': return 'about:blank';
    case 'homepage': return c.homepage || '';
    // 旧配置：那一栏本来就填的是一个地址，原样用
    case 'custom': return value || c.homepage || '';
    default:
      // base 缺失（预览模式、或主进程没下发）时退回主页，而不是拼出
      // 一条 '?theme=light&data=…' 这种根本没法加载的地址。
      return c.base ? pageUrl(c.base, c.theme, c.data) : (c.homepage || '');
  }
}

/* ------------------------------------------------------------------ *
 * 动作解析
 * ------------------------------------------------------------------ */

function dec(s) {
  try { return decodeURIComponent(s); } catch { return ''; }
}

/**
 * 解析页面回传的动作地址；不是动作就返回 `null`。
 *
 * <p><b>为什么不用 URLSearchParams</b>：它会把 `+` 解成空格，而页面那边
 * 用的是 `encodeURIComponent` —— 空格出 `%20`，字面的加号出
 * `%2B`。用 URLSearchParams 读一个真的含加号的名称（「C++ 教程」）
 * 就会变成「C  教程」，而且两端都不报错。手拆 + decodeURIComponent 才对得上。
 *
 * 认不出来的操作也返回 null 而不是抛异常 —— 地址是可以被页面随手拼出来的，
 * 而这里唯一的正确反应是「当没看见」。
 */
function parseCmd(url) {
  if (typeof url !== 'string' || url.indexOf(CMD_PREFIX) !== 0) return null;
  const rest = url.slice(CMD_PREFIX.length);
  let op;
  let query = null;
  const q = rest.indexOf('?');
  if (q < 0) {
    op = rest;
  } else {
    op = rest.slice(0, q);
    query = rest.slice(q + 1);
  }
  op = op.trim();
  if (op !== OP_ADD && op !== OP_REMOVE && op !== OP_STORE) return null;

  const params = Object.create(null);
  if (query) {
    for (const pair of query.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = eq < 0 ? pair : pair.slice(0, eq);
      const v = eq < 0 ? '' : pair.slice(eq + 1);
      params[dec(k)] = dec(v);
    }
  }
  return {
    op,
    get: (key) => (params[key] === undefined ? '' : params[key])
  };
}

const NovaNtpHost = {
  CMD_PREFIX,
  OP_ADD,
  OP_REMOVE,
  OP_STORE,
  MAX_CANDIDATES,
  MAX_TILES,
  BUILTIN_SITES,
  MAX_LABEL,
  MODES,
  hostOf,
  hostKey,
  recordable,
  sanitize,
  labelOf,
  compareCandidates,
  buildData,
  normShortcuts,
  addShortcut,
  removeShortcut,
  modeOf,
  pageUrl,
  target,
  parseCmd
};

if (typeof window !== 'undefined') window.NovaNtpHost = NovaNtpHost;
if (typeof module !== 'undefined' && module.exports) module.exports = NovaNtpHost;
