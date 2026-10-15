'use strict';

/**
 * 从**本机已安装的浏览器**里读书签
 * ---------------------------------------------------------------------------
 * 「导入书签」最要紧的用法是从别的浏览器搬过来，而用户手上有三种常见格式：
 *
 *   1. Chrome / Edge 的**原生 Bookmarks 文件** —— JSON（Chromium 系）
 *   2. Firefox 的 places.sqlite —— SQLite（**本模块不支持**，见下）
 *   3. 浏览器「导出」出来的 HTML —— Netscape 格式（在 bookmarks-io.js 里处理）
 *
 * <p>第 3 种最常见但要用户多点几步；第 1 种最省事，检测到就直接读。
 * 所以这里做检测，让用户点一下就能搬。
 *
 * <h3>为什么不支持 Firefox</h3>
 * <p>Firefox 的书签在 {@code places.sqlite} 里，要读就得引入一个 SQLite 引擎
 * （better-sqlite3 走原生模块、要重新编译；sql.js 是 1MB+ 的 wasm）。
 * 为了读一份书签而给一个主打「安装包不足 400 KB」的应用加 1MB 依赖，
 * 账算不过来 —— 而 Firefox 用户走「导出 HTML」这条路只需多点一次。
 * <b>检测里会把 Firefox 列出来并写明原因</b>，而不是假装它不存在。
 *
 * <h3>Chrome / Edge 的 JSON 结构</h3>
 * <pre>
 * { roots: { bookmark_bar: { children: [ {type:'url', name, url}, {type:'folder', children:[…]} ] },
 *           other: {…}, synced: {…} } }
 * </pre>
 * <p>文件夹是<strong>树</strong>，要递归展开；每条 url 节点是
 * {@code {type:'url', name, url}}，folder 节点没有 url。
 *
 * <h3>隐私边界</h3>
 * <p>只读用户明确点开的那一个浏览器的书签文件，<b>只挑出 http/https 的条目</b>
 * （Chromium 会在里面塞 chrome://、edge:// 这类内部页，导进书签表毫无意义），
 * 不读历史、不读 cookie、不读其它 profile。检测阶段只<b>看文件在不在</b>，
 * 不读内容 —— 检测结果本身不该泄露「这个浏览器里有哪些站点」。
 *
 * <p>纯逻辑：路径拼装与 JSON 解析都在这里，实际读盘交给 main.js，
 * 这样最容易写错的递归展开能离线单测。
 */

const os = require('os');
const path = require('path');

/**
 * 各浏览器的候选位置。
 *
 * <p>profile 名（Default / Profile 1）会变，所以每家都给一组候选路径，
 * 由 {@link detectBrowsers} 挑第一个存在的。
 *
 * <p>顺序有意义：**Chrome 在 Edge 前面** —— 两家都用 Chromium、书签格式相同，
 * 但用户装 Chrome 的比例更高，先列它更符合多数人的预期。
 */
const BROWSERS = [
  {
    id: 'chrome',
    name: 'Chrome',
    // Chromium 系：%LOCALAPPDATA%\Google\Chrome\User Data\<profile>\Bookmarks
    profiles: ['Default', 'Profile 1', 'Profile 2', 'Profile 3'],
    resolve: () => path.join(
      process.env.LOCALAPPDATA || os.homedir(),
      'Google', 'Chrome', 'User Data'
    ),
    format: 'chromium-json'
  },
  {
    id: 'edge',
    name: 'Edge',
    profiles: ['Default', 'Profile 1', 'Profile 2', 'Profile 3'],
    resolve: () => path.join(
      process.env.LOCALAPPDATA || os.homedir(),
      'Microsoft', 'Edge', 'User Data'
    ),
    format: 'chromium-json'
  },
  {
    id: 'brave',
    name: 'Brave',
    profiles: ['Default', 'Profile 1'],
    resolve: () => path.join(
      process.env.LOCALAPPDATA || os.homedir(),
      'BraveSoftware', 'Brave-Browser', 'User Data'
    ),
    format: 'chromium-json'
  },
  {
    id: 'firefox',
    name: 'Firefox',
    profiles: ['*.default-release', '*.default'],
    resolve: () => path.join(process.env.APPDATA || os.homedir(), 'Mozilla', 'Firefox', 'Profiles'),
    format: 'sqlite',
    // 如实说明为什么不能直接读，而不是让它在列表里神秘地缺一块
    note: '书签存在 places.sqlite 里，需要额外的数据库引擎才能读；请在 Firefox 里「导出为 HTML」后再导入'
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    profiles: ['Default', 'Profile 1'],
    resolve: () => path.join(
      process.env.LOCALAPPDATA || os.homedir(),
      'Vivaldi', 'User Data'
    ),
    format: 'chromium-json'
  },
  {
    id: 'opera',
    name: 'Opera',
    // Opera 在 Windows 上把 Chromium 数据放在 Roaming 下，且目录名是
    // 「Opera Software」而可执行文件是 Opera —— 这个不一致是它自己的历史包袱
    profiles: ['Default'],
    resolve: () => path.join(
      process.env.APPDATA || os.homedir(),
      'Opera Software', 'Opera Stable'
    ),
    format: 'chromium-json'
  }
];

/** 挑出这个平台的候选浏览器。非 Windows 返回空数组。 */
function candidates() {
  return process.platform === 'win32' ? BROWSERS.slice() : [];
}

/**
 * 这一家在本机装了吗、书签文件在不在。
 *
 * @param {object} b BROWSERS 里的一项
 * @param {(p:string)=>boolean} exists 注入的存在性判断（测试用假实现）
 * @returns {{ok:boolean, file:string|null, profile:string|null}}
 */
function probe(b, exists) {
  const base = b.resolve();
  for (const prof of b.profiles) {
    if (prof.indexOf('*') === 0) {
      // 通配（Firefox 那种随机目录名）交给调用方按目录枚举处理，
      // 这里只负责把「装了没有」这件事答了
      if (exists(base)) return { ok: true, file: null, profile: null, needsEnumerate: true };
      continue;
    }
    const file = path.join(base, prof, 'Bookmarks');
    if (exists(file)) return { ok: true, file, profile: prof };
  }
  return { ok: false, file: null, profile: null };
}

/**
 * 检测结果 → 给界面的列表（每家一条，**装了就列，没装不列**）。
 *
 * @param {(p:string)=>boolean} exists
 * @returns {Array<{id,name,format,file?,profile?,supported:boolean,note?}>}
 */
function detectBrowsers(exists) {
  const out = [];
  for (const b of candidates()) {
    const r = probe(b, exists);
    if (!r.ok) continue;
    const supported = b.format === 'chromium-json' && !!r.file;
    out.push({
      id: b.id,
      name: b.name,
      format: b.format,
      supported,
      file: supported ? r.file : null,
      profile: r.profile || null,
      // 不支持要说清为什么，并把出路给出来（导出的 HTML 那条路）
      note: supported ? '' : (b.note || '这个浏览器的书签格式暂不支持，请改为导入 HTML 文件')
    });
  }
  return out;
}

/**
 * Chromium 系书签 JSON → 一维的 url 条目数组。
 *
 * <p>递归展开文件夹；**只取 type==='url' 的节点**（folder 没有 url，
 * 硬取会得到 undefined）。
 *
 * <p>三个来源都收（bookmark_bar / other / synced）：用户自己整理过的
 * 一般在书签栏，但「其他书签」里也常有值得搬的东西。
 *
 * @param {object|string} doc Bookmarks 文件的内容（JSON 文本或已解析的对象）
 * @returns {Array<{url:string,title:string}>}
 */
function parseChromiumBookmarks(doc) {
  let data = doc;
  if (typeof doc === 'string') {
    try { data = JSON.parse(doc); } catch (e) { return []; }
  }
  if (!data || typeof data !== 'object' || !data.roots) return [];

  const out = [];
  const seen = Object.create(null);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const kids = Array.isArray(node.children) ? node.children : [];
    for (const c of kids) {
      if (!c) continue;
      if (c.type === 'url' && typeof c.url === 'string' && c.url.trim()) {
        // 内部页（chrome://、edge://、chrome-extension://）对用户没有意义，
        // 导进来只会占位置 —— 与 bookmarks-io.js 的协议闸同一把尺子
        if (!/^https?:\/\//i.test(c.url.trim())) continue;
        const key = c.url.trim().replace(/\/+$/, '').toLowerCase();
        if (seen[key]) continue;
        seen[key] = 1;
        out.push({ url: c.url.trim(), title: String(c.name || '').trim() });
      }
      if (c.type === 'folder' || Array.isArray(c.children)) walk(c);
    }
  };

  for (const key of ['bookmark_bar', 'other', 'synced']) {
    const root = data.roots[key];
    if (root) walk(root);
  }
  return out;
}

module.exports = { BROWSERS, candidates, probe, detectBrowsers, parseChromiumBookmarks };