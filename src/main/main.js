'use strict';

/**
 * 吾爱Nova浏览器 · 主进程
 * ---------------------------------------------------------------------------
 * 职责边界：
 *   - 窗口与外壳（frameless，自绘标题栏 / 工具栏 / 移动端底栏）
 *   - 内核注册表（engines.js）+ 每个内核独立 session（cookie/缓存/UA 全隔离）
 *   - 广告拦截（adblock.js）挂到每个内核 session 上
 *   - 扩展装载（extensions.js）
 * 渲染层只通过 preload 暴露的白名单 API 说话。
 */

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, session, dialog, shell, nativeTheme, clipboard } = require('electron');

const settings = require('./settings');
// 新标签页的宿主侧逻辑。它是 src/renderer 下的双导出模块（既被外壳页面当
// 普通脚本加载，也能在 Node 里 require）—— 与 autopage.js 同一形态，
// 这样 tools/test-newtab.js 测的就是跑的那一份。这里只需要它那两个
// 「增删自己加的快捷方式」的纯函数。
const ntp = require('../renderer/ntp');
const { EngineRegistry } = require('./engines');
const { adblock } = require('./adblock');
const { ExtensionManager, isExtensionFile } = require('./extensions');
const extStore = require('./ext-store');
const { DownloadManager } = require('./downloader');
const { Sniffer, FORMAT_STATS } = require('./sniffer');
const { wireSniffer: wireSnifferSession } = require('./sniffer-wire');
const { NoMedia, PLACEHOLDER_CSS, PLACEHOLDER_JS } = require('./nomedia');
const { wireRequestGate: installRequestGate } = require('./request-gate');
const { FaviconCache, hostsFromNtpData } = require('./favicon-cache');
const updater = require('./updater');
const bookmarksIo = require('./bookmarks-io');
const desktopShortcut = require('./desktop-shortcut');

const IS_DEV = process.argv.includes('--dev');
const ROOT = path.join(__dirname, '..', '..');

/**
 * 应用元信息。桌面快捷方式的名字与 AppUserModelID 都取这一份。
 *
 * 名字其实有三份：这里的 productName、build.nsis.shortcutName（NSIS 打包时写死在
 * package.json 里，那边没有「读一下常量」这条路）、以及 desktop-shortcut.js 里的
 * 默认名。三处必须同词，否则同一台机器上会并出两个名字不一样的图标，
 * 而且「桌上已经有同名图标就不再动」那条会失效。tools/test-desktop-shortcut.js
 * 的 [G] 组把这三份逐字比过。
 */
const PKG = require('../../package.json');

/**
 * 内置新标签页的本地文件地址。外壳拿它当「新建标签页」的目标，
 * 拼上 ?theme=…&data=… 之后交给 <webview> 加载。
 *
 * 用 pathToFileURL 而不是手拼 `'file://' + p`：Windows 的盘符（C:\…）、
 * 路径里的空格与中文都要转义，手拼这三样里错一样就是「新建标签页打不开」。
 */
const NEWTAB_FILE_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'newtab.html')).href;

let mainWindow = null;
/** session → engineId，用于在 web-contents-created 时反查内核 */
const sessionEngineMap = new Map();
/** engineId → session，下载引擎取 Cookie / UA 时要用 */
const engineSessions = new Map();
/** webContentsId → 顶层文档 hostname，供第三方判定 */
const docHostMap = new Map();
/** 已经从 Nova 引擎退回给 Chromium 的 URL，防止 will-download 来回打转 */
const downloadPassthrough = new Set();

const registry = new EngineRegistry();
let extManager = null;
/** 从商店取的 .crx 落在这里。见 bootstrap 里的说明：这份要长期留着。 */
let extStoreDir = null;
let dlManager = null;
let dlPersistTimer = null;
let sniffer = null;
/** 待推送的嗅探结果：webContentsId → 记录数组。一个页面加载会瞬时命中几十条，
 *  攒一小段再一次性推给界面，避免打爆 IPC。 */
const sniffPending = new Map();
let sniffFlushTimer = null;
/** 无图模式判定器 */
let noMedia = null;
/** 无图拦截计数的推送节流 —— 一个图片多的页面首屏能瞬时命中上百条 */
let noMediaStatsTimer = null;
/**
 * webContentsId → 放行宽限截止时间戳。
 * 「显示本页图片」要先放行再重载，而重载会触发 did-start-navigation，
 * 常规逻辑在那里是要把放行状态清掉的 —— 于是刚放行就被自己清没了。
 * 用一个几百毫秒的宽限窗口把这次导航让过去（重定向可能连着来几次，
 * 所以不是「让一次」而是「让一小段时间」）。
 */
const noMediaGrace = new Map();

/** 新标签页磁贴图标的抓取与缓存（语义与安卓端 FaviconCache 对齐，见该模块头） */
let faviconCache = null;
/** 当前开着的新标签页 webContents：图标抓到后要挨个重注入，谁先看到谁先换 */
const ntpContents = new Set();

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

app.commandLine.appendSwitch('enable-features', 'WebContentsForceDark:disabled');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(bootstrap);
}

async function bootstrap() {
  settings.init(app.getPath('userData'));

  // 0) 桌面快捷方式：免安装（绿色版）第一次跑起来时补一个。
  // 走安装包进来的用户这里什么也不会发生 —— 桌面那个图标是 NSIS 安装器放的，
  // 我们只会读到一句「已有」。放在最前面是因为它跟应用状态无关，
  // 纯粹看「桌面上有没有」这一件事，越早办完越早从启动流程里消失。
  ensureDesktopShortcut();

  // 1) 广告拦截：装载三个源（广告终结者 / Adblock Plus / 系统内置）+ 用户配置
  adblock.loadAll();
  adblock.configure(settings.get('adblock'));
  for (const listPath of settings.get('adblock.userLists', [])) {
    try { adblock.importFile(listPath); } catch (err) { console.warn('[adblock] 清单导入失败', listPath, err.message); }
  }
  // 源开关或规则变化时推给界面，让「拦截来源」实时反映
  adblock.onChange((s) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('adblock:stats', s); } catch { /* 窗口正在销毁 */ }
    }
  });

  // 2) 内核解析（探测原生宿主，决定 native / bridge / compat）
  await registry.resolveAll();

  // 3) 下载引擎（多线程）。必须在 session 之前建好，wireDownloads 要用它
  createDownloadManager();

  // 4) 媒体嗅探引擎。同样要在 session 之前建好
  createSniffer();

  // 5) 无图模式判定器。它要在请求闸门里被问到，所以必须早于 session
  createNoMedia();

  // 5.5) 磁贴图标缓存。要在 createWindow 之前建好：新标签页一打开就要注入。
  // 启动先按书签 + 快捷方式 + 近期历史暖一轮 —— 用户开第一个新标签页时
  // 常去站点的图标多半已经在盘上了，不用等这一页自己触发抓取。
  faviconCache = new FaviconCache(path.join(app.getPath('userData'), 'favicons'));
  // 抓到一份新的：进新标签页的那条路要重注入，外壳那条路（收藏夹栏、书签列表）
  // 也要被告一声 —— 它是先拿到空表画出来的，不重画就停在首字母上，
  // 而图标通常要几秒后才到（没缓存时得现连 DNS、现拿 TLS）。
  faviconCache.onFetched = () => {
    reinjectFavicons();
    send('favicon:updated', null);
  };
  warmFavicons();

  // 6) 每个内核一份独立 session
  for (const engine of registry.engines) {
    const ses = session.fromPartition(engine.partition);
    sessionEngineMap.set(ses, engine.id);
    engineSessions.set(engine.id, ses);
    engine.applyHeaders(ses);
    wireRequestGate(ses);
    wireDownloads(ses, engine.id);
    wireSniffer(ses);
  }
  // 默认 session 也接一份，避免无分区页面漏网
  sessionEngineMap.set(session.defaultSession, 'chromium');
  engineSessions.set('chromium', session.defaultSession);
  registry.get('chromium').applyHeaders(session.defaultSession);
  wireRequestGate(session.defaultSession);
  wireDownloads(session.defaultSession, 'chromium');
  wireSniffer(session.defaultSession);

  // 7) 扩展：统一装到 chromium 内核 session（Chromium 扩展实现的宿主）
  extManager = new ExtensionManager({
    workDir: path.join(app.getPath('userData'), 'extensions'),
    partitions: ['persist:nova-chromium']
  });
  const extSessionFactory = () => session.fromPartition('persist:nova-chromium');
  extManager.onChange = (list) => send('ext:changed', list);

  // 从商店取的包单独放一层，与「用户自己选的文件」分开。
  //
  // 这一份必须长期留着：settings 里记的是扩展的装载来源路径，下次启动要照着
  // 它恢复装载。用户自己选的文件在下载目录里、本来就不归我们管；商店下下来
  // 的没有一个别的地方存在，删了就等于「装过一次，重启后扩展不见了」。
  extStoreDir = path.join(app.getPath('userData'), 'extensions', 'store');

  for (const rec of settings.get('extensions', [])) {
    try {
      await extManager.install(rec.path, extSessionFactory);
    } catch (err) {
      console.warn('[extensions] 恢复失败', rec.path, err.message);
    }
  }

  // 8) 页面级事件（webview 内容也走这里）
  app.on('web-contents-created', (_e, contents) => wireContents(contents));

  createWindow();
}

/* ------------------------------------------------------------------ *
 * 桌面快捷方式
 * ------------------------------------------------------------------ */

/**
 * 免安装形态下补一个桌面快捷方式。
 *
 * 这里只做「把环境事实喂给桌面快捷方式模块」这一件事 —— 该不该建、什么情况下
 * 不动桌上已有的那个、为什么只做一次，理由全在 desktop-shortcut.js 的模块头里。
 *
 * 顺带说清这条路的覆盖面：**走安装包的用户不会走到这里**（桌面已有同名图标，
 * 直接进 exists 分支），所以这段代码对现有安装版用户是零影响的。
 */
function ensureDesktopShortcut() {
  if (!desktopShortcut.shouldInstall({
    platform: process.platform,
    packaged: app.isPackaged,
    done: (settings.get('desktopShortcut', 0) | 0) >= 1
  })) return;

  let desktopDir;
  try {
    desktopDir = app.getPath('desktop');
  } catch (err) {
    // 极少见：没有桌面目录的会话（服务账号、某些精简系统）。跳过即可，
    // 不打标 —— 万一只是这一次取不到，下次启动还能再试。
    console.warn('[shortcut] 取不到桌面目录，跳过：' + err.message);
    return;
  }

  const name = desktopShortcut.shortcutFileName(PKG.productName);
  const result = desktopShortcut.ensureShortcut({
    desktopDir,
    name,
    exePath: process.execPath,
    description: PKG.productName,
    appId: (PKG.build && PKG.build.appId) || '',
    // 'create' 是 Electron 的写法：它在已存在时默认不覆盖，但我们在上面
    // 已经自己判过 exists 了，走到这里本来就只有「不存在」这一种。
    writeLink: (lnk, opts) => shell.writeShortcutLink(lnk, 'create', opts)
  });

  if (result === 'failed') {
    console.warn('[shortcut] 桌面快捷方式没建成，下次启动会再试一次：' + name);
    return;
  }

  settings.patch({ desktopShortcut: 1 });
  if (result === 'created') console.log('[shortcut] 已创建桌面快捷方式：' + name);
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 380,
    minHeight: 520,
    frame: false,
    titleBarStyle: 'hidden',
    // 任务栏 / Alt-Tab / 窗口缩略图都用它。用 .ico 而不是 .png —— Windows 会按
    // 当前 DPI 和显示场景（16/32/48/256）自己在多档里挑，给单张 PNG 就只能硬缩。
    icon: path.join(ROOT, 'assets', 'icon', 'nova.ico'),
    backgroundColor: settings.get('theme') === 'dark' ? '#0E1016' : '#F6F7FB',
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'shell.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 窗口尺寸变化 → 通知渲染层切换 PC / 移动布局
  mainWindow.on('resize', () => {
    if (mainWindow) send('shell:viewport', { width: mainWindow.getContentSize()[0] });
  });
  mainWindow.webContents.on('did-finish-load', () => {
    send('shell:viewport', { width: mainWindow.getContentSize()[0] });
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/* ------------------------------------------------------------------ *
 * 请求闸门（广告拦截 + 无图模式）
 * ------------------------------------------------------------------ */

/**
 * 一条闸门管两件事：无图模式与广告拦截。判定顺序与「为什么必须合成一条」的
 * 说明都在 request-gate.js 里；这里只负责把主进程这边的依赖接上去。
 */
function wireRequestGate(ses) {
  installRequestGate(ses, {
    adblock,
    noMedia,
    docHostFor: (id) => docHostMap.get(id) || '',
    onAdblockHit: (hit, details) => {
      send('adblock:hit', { url: details.url, rule: hit.raw, type: details.resourceType });
    },
    onNoMediaHit: () => queueNoMediaStats()
  });
}

/* ------------------------------------------------------------------ *
 * 无图模式
 * ------------------------------------------------------------------ */

function createNoMedia() {
  const prefs = settings.get('mobile', {}) || {};
  noMedia = new NoMedia({
    level: prefs.noImage || 'off',
    // 浏览器自己的界面也在发请求：设置页、嗅探页里的媒体预览都是。
    // 不排除的话，用户在嗅探页点一次预览，视频就被自己的省流量开关拦了。
    isInternal: (id) => !!mainWindow && !mainWindow.isDestroyed() && id === mainWindow.webContents.id
  });
  return noMedia;
}

/** 攒 400ms 再推一次计数：一个图片多的页面首屏能瞬时命中上百条 */
function queueNoMediaStats() {
  if (noMediaStatsTimer) return;
  noMediaStatsTimer = setTimeout(() => {
    noMediaStatsTimer = null;
    send('mobile:stats', noMedia ? noMedia.snapshot() : null);
  }, 400);
}

/**
 * 主框架导航时清掉放行状态。
 *
 * 不清的话：用户在第一页点了「显示本页图片」，翻到第二页图片照样全放行，
 * 而他的理解一定是「只对刚才那一页生效」。
 *
 * 宽限窗口是给「放行 → 重载」这条链路让路的，见 noMediaGrace 的注释。
 */
function clearNoMediaOnNavigate(wcId) {
  if (!noMedia) return;
  const until = noMediaGrace.get(wcId) || 0;
  if (Date.now() < until) return;
  noMedia.clear(wcId);
}


/* ------------------------------------------------------------------ *
 * 磁贴图标（新标签页 / 收藏夹栏）
 * ------------------------------------------------------------------ */

/**
 * 把图标表喂进一个新标签页。
 *
 * 页面那条 CSP 不许它自己发请求（见 newtab.html），所以图标只能这样喂：
 * 写一张「主机名 → data: URI」的表到 window.__novaIcons，再叫页面重画一遍
 * 磁贴。注入放在 did-finish-load：更早页面还没有 __novaApplyIcons 可调，
 * 更晚用户已经看见了没有图标的那一版，磁贴会跳一下 —— 与安卓端
 * MainActivity#injectFavicons 的时机是同一条规则。
 *
 * 表是空的也要注入：页面可能还挂着上一次注入的表，不覆盖会显示过期的图标。
 */
function injectFavicons(contents) {
  if (!faviconCache || !contents || contents.isDestroyed()) return;
  let url = '';
  try { url = contents.getURL(); } catch { /* 窗口正在销毁 */ }
  if (typeof url !== 'string' || url.indexOf(NEWTAB_FILE_URL) !== 0) return;
  ntpContents.add(contents);

  let hosts = [];
  try {
    hosts = hostsFromNtpData(new URL(url).searchParams.get('data') || '');
  } catch { /* 拿不到就用空表，覆盖照做 */ }
  // 这一页要用的主机顺手暖一遍：用户加了新磁贴、或历史里冒出新站点时，
  // 不用等下一次启动才抓到
  faviconCache.refreshIfStale(hosts);

  const script = 'window.__novaIcons = ' + JSON.stringify(faviconCache.jsonFor(hosts)) + ';'
    + 'if (window.__novaApplyIcons) window.__novaApplyIcons();';
  contents.executeJavaScript(script, true).catch(() => { /* 页面走了就算了 */ });
}

/** 图标抓到新的一份 → 给所有还开着的新标签页重注入。谁先抓到谁先换。 */
function reinjectFavicons() {
  for (const contents of [...ntpContents]) {
    let gone = !contents || contents.isDestroyed();
    if (!gone) {
      try {
        gone = String(contents.getURL()).indexOf(NEWTAB_FILE_URL) !== 0;
      } catch { gone = true; }
    }
    if (gone) { ntpContents.delete(contents); continue; }
    injectFavicons(contents);
  }
}

/**
 * 启动时按「用户认得的站点」暖一轮缓存：书签 + 自己加的磁贴 + 近期历史。
 * 只暖这些而不是全量历史 —— 抓图标是锦上添花，不该在启动路径上
 * 对几十个域名排队发请求。
 */
function warmFavicons() {
  if (!faviconCache) return;
  const s = settings.all();
  const hosts = new Set();
  const add = (u) => { try { const h = new URL(u).hostname; if (h) hosts.add(h); } catch { /* 跳过坏地址 */ } };
  for (const b of s.bookmarks || []) add(b && b.url);
  for (const a of ((s.ntpShortcuts || {}).added || [])) add(a && a.url);
  for (const h of (s.history || []).slice(0, 30)) add(h && h.url);
  faviconCache.refreshIfStale([...hosts]);
}


/* ------------------------------------------------------------------ *
 * 媒体嗅探接线
 * ------------------------------------------------------------------ */

function createSniffer() {
  const prefs = settings.get('sniffer', {}) || {};
  sniffer = new Sniffer({
    enabled: prefs.enabled !== false,
    minSizeKB: prefs.minSizeKB || 0
  });
  sniffer.onChange = (type, payload) => {
    if (type === 'reset') send('sniff:reset', payload);
    else if (type === 'update') send('sniff:update', payload);
  };
  return sniffer;
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
 * 解析逻辑在 sniffer-wire.js 里，好让真实 Electron 测试能直接调同一份实现。
 */
function wireSniffer(ses) {
  wireSnifferSession(ses, {
    sniffer,
    onRecord: (rec) => queueSniff(rec),
    // 浏览器自己的界面（设置页、嗅探页预览）也在发请求，这些不是「页面里的媒体」。
    // 不排除的话，设置页里预览一次视频就会在清单里凭空多出一条。
    isInternal: (tabId) => !!mainWindow && !mainWindow.isDestroyed() && tabId === mainWindow.webContents.id
  });
}

/** 攒 200ms 再推：一个页面首屏能瞬时命中几十条媒体请求，逐条推会把 IPC 打爆 */
function queueSniff(rec) {
  const list = sniffPending.get(rec.tabId);
  if (list) list.push(rec);
  else sniffPending.set(rec.tabId, [rec]);

  if (sniffFlushTimer) return;
  sniffFlushTimer = setTimeout(() => {
    sniffFlushTimer = null;
    const batch = [...sniffPending.entries()].map(([tabId, recs]) => ({ tabId, recs }));
    sniffPending.clear();
    send('sniff:found', batch);
  }, 200);
}

/* ------------------------------------------------------------------ *
 * 下载
 * ------------------------------------------------------------------ */

/**
 * 建下载引擎。
 * 传给引擎的 headersFor 负责把对应内核 session 里的 Cookie 和 UA 带上 ——
 * 很多下载链接是靠登录态鉴权的，不带 Cookie 会直接拿到 403 页面。
 */
function createDownloadManager() {
  const prefs = settings.get('download', {}) || {};
  dlManager = new DownloadManager({
    dir: prefs.dir || app.getPath('downloads'),
    threads: prefs.threads || 8,
    maxConcurrent: prefs.maxConcurrent || 3,
    headersFor: async (url, engineId) => {
      const ses = engineSessions.get(engineId) || session.defaultSession;
      const engine = registry.get(engineId) || {};
      const headers = {
        'User-Agent': engine.userAgent || 'Mozilla/5.0',
        Accept: '*/*',
        // 这一行是硬要求：服务端一旦 gzip，Content-Length 就不是文件真实大小，
        // Range 偏移也会错位，分片拼出来的文件必坏。
        'Accept-Encoding': 'identity',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      };
      try {
        const cookies = await ses.cookies.get({ url });
        if (cookies.length) headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      } catch { /* 拿不到就当匿名请求 */ }
      return headers;
    },
    onUpdate: (snap) => {
      send('download:update', snap);
      // 只在状态跃迁时落盘，进度事件不写文件
      if (['queued', 'paused', 'done', 'error', 'canceled'].includes(snap.state)) {
        schedulePersistDownloads();
      }
      maybeFallbackToChromium(snap);
    }
  });

  dlManager.adopt(settings.get('downloadTasks', []) || []);
  return dlManager;
}

function schedulePersistDownloads() {
  if (dlPersistTimer) clearTimeout(dlPersistTimer);
  dlPersistTimer = setTimeout(() => {
    try { settings.patch({ downloadTasks: dlManager.persistable() }); } catch { /* 落盘失败不致命 */ }
  }, 800);
}

/**
 * 兜底：Nova 引擎一个字节都没拿到就失败了（比如需要 POST、需要特殊鉴权头），
 * 把这条交回 Chromium 内建下载器。用户不该因为我们想多线程就下不了东西。
 *
 * 只对「页面触发的下载」这么做。用户手动粘贴 URL 新建的任务失败时给明确报错 + 重试按钮就够了，
 * 不该在他没要求的时候偷偷再起一个 Chromium 下载、在列表里多出一条莫名其妙的记录。
 */
function maybeFallbackToChromium(snap) {
  if (snap.state !== 'error' || snap.received > 0) return;
  if (snap.source !== 'page') return;
  const task = dlManager.get(snap.id);
  if (!task || task.fallbackTried) return;
  task.fallbackTried = true;

  const ses = engineSessions.get(snap.engineId) || session.defaultSession;
  downloadPassthrough.add(snap.url);
  setTimeout(() => downloadPassthrough.delete(snap.url), 60000);
  console.log('[downloads] Nova 引擎失败，交回 Chromium 内建下载器:', snap.url, '—', snap.error);
  try { ses.downloadURL(snap.url); } catch (err) { console.warn('[downloads] 回退失败', err.message); }
}

function wireDownloads(ses, engineId) {
  ses.on('will-download', (e, item) => {
    const url = item.getURL();
    const filename = item.getFilename();
    const savePath = item.getSavePath();

    // 接管条件：引擎在、用户在设置里开了、是 http(s)、且这条不是刚退回来的
    const canTakeOver = !!dlManager
      && settings.get('download.takeOver', true) !== false
      && /^https?:/i.test(url)
      && !downloadPassthrough.has(url);

    if (canTakeOver) {
      // preventDefault 会阻止 Chromium 真的开始下载，同时不产生 canceled 状态，
      // 比 item.cancel() 干净（后者会让 done 事件带一条 cancelled 记录）。
      e.preventDefault();
      const id = dlManager.enqueue({
        url,
        filename,
        savePath,
        engineId,
        source: 'page'
      });
      send('download:taken-over', { id, url, filename });
      return;
    }

    // 原路径：Chromium 内建单连接下载器
    const payload = {
      id: 'native_' + Date.now().toString(36),
      filename,
      url,
      total: item.getTotalBytes(),
      received: 0,
      source: 'chromium',
      state: 'progress'
    };
    send('download:update', payload);
    item.on('updated', (_ev, state) => {
      payload.received = item.getReceivedBytes();
      payload.total = item.getTotalBytes();
      payload.state = state;
      send('download:update', payload);
    });
    item.once('done', (_ev, state) => {
      payload.state = state === 'completed' ? 'done' : state;
      payload.path = item.getSavePath();
      payload.savePath = item.getSavePath();
      send('download:update', payload);
    });
  });
}

/* ------------------------------------------------------------------ *
 * 页面事件接线路由
 * ------------------------------------------------------------------ */

function wireContents(contents) {
  const engineId = sessionEngineMap.get(contents.session) || 'chromium';
  const engine = registry.get(engineId);

  contents.setWindowOpenHandler(({ url, disposition }) => {
    send('tabs:open-request', { url, disposition, background: disposition === 'background-tab' });
    return { action: 'deny' };
  });

  // 内置新标签页回传的动作（加 / 删快捷方式）。
  //
  // 这一页是本地文件，上不了 preload 那座桥，所以它用的是「跳一个
  // nova://shortcut/… 地址」这个老办法 —— 页面那边的注释里写了原因。
  // 必须拦在 will-navigate 上：Electron 对没注册处理器的 scheme 会直接
  // 放弃这次导航（页面上什么都不发生，用户点了 × 像按了个死键）。
  //
  // 拦下来之后把**原始地址**转发给渲染层去解析、再由它回主进程落盘：
  // 解析规则只有 src/renderer/ntp.js 一份，不在这里再写一遍。
  contents.on('will-navigate', (event, url) => {
    if (typeof url !== 'string' || url.indexOf(ntp.CMD_PREFIX) !== 0) return;
    event.preventDefault();
    send('ntp:command', { id: contents.id, url });
  });

  contents.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    try { docHostMap.set(contents.id, new URL(url).hostname); } catch { /* noop */ }
    // 主框架跳走了，上一页的媒体清单作废 —— 否则换页后会看到一堆上页残留
    if (sniffer) {
      sniffer.reset(contents.id);
      sniffer.setPage(contents.id, url, '');
    }
    // 「显示本页图片」只对这一页有效，翻页即失效（宽限窗口内的重载除外）
    clearNoMediaOnNavigate(contents.id);
  });

  contents.on('page-title-updated', (_e, title) => {
    send('tab:title', { id: contents.id, title });
    // 标题是判断「这条媒体属于哪个页面」最直观的线索，记下来给嗅探清单用
    if (sniffer) sniffer.setPage(contents.id, contents.getURL(), title);
  });

  // 标签页关掉后把它的媒体记录一并释放，长时间开开关关不会越攒越多
  contents.on('destroyed', () => {
    docHostMap.delete(contents.id);
    if (sniffer) sniffer.reset(contents.id);
    sniffPending.delete(contents.id);
    if (noMedia) noMedia.clear(contents.id);
    noMediaGrace.delete(contents.id);
    ntpContents.delete(contents);
  });

  contents.on('page-favicon-updated', (_e, favicons) => {
    send('tab:favicon', { id: contents.id, favicon: favicons[0] || null });
    // 顺手把「站点自己声明的图标」抓进缓存：新标签页磁贴与收藏夹栏格用。
    // 只收 http(s) 的页面与图标地址 —— file:、扩展页的图标不进缓存。
    // 盲探 PATHS 探不到自定义图标路径，这一步是它的高命中率补位。
    if (faviconCache && favicons && favicons[0]) {
      let pageUrl = '';
      try { pageUrl = contents.getURL(); } catch { /* noop */ }
      if (/^https?:/i.test(pageUrl) && /^https?:/i.test(favicons[0])) {
        let host = '';
        try { host = new URL(pageUrl).hostname; } catch { /* noop */ }
        if (host) faviconCache.remember(host, favicons[0]);
      }
    }
  });

  // 新标签页加载完成 → 注入图标表（其他页面在 injectFavicons 里被前缀挡掉）
  contents.on('did-finish-load', () => injectFavicons(contents));

  contents.on('did-navigate', (_e, url, httpStatus) => {
    settings.pushHistory({
      title: contents.getTitle(),
      url,
      engine: engineId
    });
    send('tab:navigated', { id: contents.id, url, httpStatus, engine: engineId });
  });

  contents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (!isMainFrame) return;
    send('tab:navigated', { id: contents.id, url, inPage: true, engine: engineId });
  });

  contents.on('did-start-loading', () => send('tab:loading', { id: contents.id, loading: true }));
  contents.on('did-stop-loading', () => send('tab:loading', { id: contents.id, loading: false }));

  contents.on('render-process-gone', (_e, details) => {
    send('tab:crashed', { id: contents.id, reason: details.reason });
  });

  // 注入内核兼容层垫片 + 广告元素隐藏样式 + 无图占位样式
  contents.on('dom-ready', async () => {
    const url = contents.getURL();
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch { /* noop */ }

    if (engine.shim && engine.mode === 'compat') {
      try { await contents.executeJavaScript(engine.shim, true); } catch { /* noop */ }
    }

    const css = adblock.cosmeticCss(hostname);
    if (css) {
      try { await contents.insertCSS(css, { cssOrigin: 'user' }); } catch { /* noop */ }
    }

    // 无图占位：图片请求已经被拦在网上了，这里负责把「一片破图」收拾成一排灰块。
    // 本页已放行时不注入 —— 图片都正常加载了，再垫灰底只是难看。
    if (noMedia && noMedia.enabled && !noMedia.isPageAllowed(contents.id)) {
      const internal = !!mainWindow && !mainWindow.isDestroyed()
        && contents.id === mainWindow.webContents.id;
      if (!internal) {
        try { await contents.insertCSS(PLACEHOLDER_CSS, { cssOrigin: 'user' }); } catch { /* noop */ }
        try { await contents.executeJavaScript(PLACEHOLDER_JS, true); } catch { /* noop */ }
      }
    }

    send('tab:dom-ready', { id: contents.id, hostname, engine: engineId, mode: engine.mode });
  });
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => fn(...args));

  handle('app:bootstrap', () => ({
    settings: settings.all(),
    /** 出厂默认值：渲染层的「恢复默认设置」据此回滚，避免前后端各写一份 */
    defaults: settings.DEFAULTS,
    /** 内置新标签页的本地文件地址，见 NEWTAB_FILE_URL */
    newTabFileUrl: NEWTAB_FILE_URL,
    engines: registry.list(),
    extensions: extManager.list(),
    adblock: adblock.statsSnapshot(),
    downloads: dlManager.list(),
    downloadStats: dlManager.stats(),
    downloadsDir: dlManager.dir,
    /** 嗅探清单为空 —— 它是「随浏览产生」的，重启后自然从零开始 */
    sniffStats: sniffer ? sniffer.stats() : null,
    /** 格式注册表规模：界面上直接拿它说话，不手写数字 */
    sniffFormats: FORMAT_STATS,
    /** 无图模式的档位与计数。清单是「随浏览产生」的，重启后从零开始 */
    nomedia: noMedia ? noMedia.snapshot() : null,
    /** 无图占位样式由主进程持有，渲染层负责往页面里插 —— 一处定义，两边不各写一份 */
    noImageCss: PLACEHOLDER_CSS,
    noImageJs: PLACEHOLDER_JS,
    platform: process.platform,
    /** 应用自身的版本号（package.json 的 version）。
     *
     * <p>此前「关于」面板把版本号**写死成 0.1.0**，而实际早已是 1.0.x ——
     * 根因是这里没把版本号交给渲染层，而渲染层没有别的地方能拿到它。
     * 版本号只有一个来源（package.json），这里只透传，不再另抄一份。 */
    appVersion: app.getVersion(),
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    },
    allowlist: [...adblock.allowlist]
  }));

  handle('settings:patch', (partial) => {
    const next = settings.patch(partial);
    if (partial.adblock) {
      adblock.configure(partial.adblock);
      send('adblock:stats', adblock.statsSnapshot());
    }
    if (partial.download) {
      const prefs = settings.get('download', {}) || {};
      dlManager.configure({
        dir: prefs.dir || app.getPath('downloads'),
        threads: prefs.threads || 8,
        maxConcurrent: prefs.maxConcurrent || 3
      });
    }
    // 嗅探开关一变立刻生效 —— 关掉后网络路径上连解析都不做
    if (partial.sniffer && sniffer) {
      sniffer.configure(settings.get('sniffer', {}));
      send('sniff:state', sniffer.stats());
    }
    // 无图档位一变立刻生效，但已加载的图片不会自己消失 —— 外壳会提示重载
    if (partial.mobile && noMedia) {
      noMedia.configure(settings.get('mobile', {}));
      send('mobile:stats', noMedia.snapshot());
    }
    if (partial.theme) nativeTheme.themeSource = partial.theme;
    send('settings:changed', next);
    return next;
  });

  /**
   * 新标签页上的「＋添加」/「× 删除」。
   *
   * 外壳解析完 nova:// 命令之后回落到这里 —— 解析规则只写在
   * src/renderer/ntp.js 一份，而落盘归主进程管（设置文件在这里）。
   * 两个纯函数都是「给旧的存储对象、还一个新的」，所以这里只管覆盖。
   */
  handle('ntp:shortcut:add', ({ label, url }) => {
    const next = ntp.addShortcut(settings.get('ntpShortcuts'), label, url);
    settings.patch({ ntpShortcuts: next });
    send('settings:changed', settings.all());
    return next;
  });

  handle('ntp:shortcut:remove', ({ url }) => {
    const next = ntp.removeShortcut(settings.get('ntpShortcuts'), url);
    settings.patch({ ntpShortcuts: next });
    send('settings:changed', settings.all());
    return next;
  });

  /* ----------------------- 自动更新（PC） -----------------------
   * 做的是**包级差分更新**：只传与旧版本不同的块，不是整个 78MB 安装包。
   * 界面上的行为刻意做得不打扰：启动后静默检查一次，有新版只在工具栏挂一个
   * 角标，下载与安装都要用户点。不自动下，也不自动退。
   *
   * 状态机在 updater.js 里（check → available → downloading → ready），
   * 这里只负责把它的状态转给渲染层，并把用户的两个动作（开始下载、
   * 重启安装）转回去。**下载不在这里做**：electron-updater 会自己算差分。
   */

  // 当前更新状态。渲染层重启后会来问一次，所以不能只靠推送。
  let updaterState = { status: 'idle', info: null, error: '' };

  const pushUpdater = () => {
    send('update:state', { ...updaterState, currentVersion: app.getVersion() });
  };

  handle('update:check', async () => {
    updaterState = await updater.start(app.getVersion(), {
      onState: (s) => {
        updaterState = s;
        pushUpdater();
      }
    });
    pushUpdater();
    return updaterState;
  });

  handle('update:status', () => ({
    ...updaterState,
    currentVersion: app.getVersion()
  }));

  handle('update:download', async () => {
    if (!updaterState.info) return { error: '没有待安装的新版本' };
    updaterState = { ...updaterState, status: 'downloading' };
    pushUpdater();
    try {
      await updater.downloadAndInstall(updaterState, {
        onProgress: (p) => send('update:progress', p),
        onDownloaded: (info) => {
          updaterState = { status: 'ready', info: { ...updaterState.info, ...info }, error: '' };
          pushUpdater();
        },
        onError: (msg) => {
          updaterState = { ...updaterState, status: 'error', error: String(msg) };
          pushUpdater();
        }
      });
      return { ok: true };
    } catch (e) {
      updaterState = { ...updaterState, status: 'error', error: String(e && e.message || e) };
      pushUpdater();
      return { error: updaterState.error };
    }
  });

  handle('update:install', () => ({ ok: updater.quitAndInstall() }));

  /**
   * 收藏夹栏 / 书签列表按主机名要图标。新标签页那条路不走 IPC（主进程直接注入）。
   *
   * 顺手 kick 一次抓取：只读不抓的话，用户当场加的那条书签在本次运行里永远
   * 等不到图标 —— 启动时的暖缓存只覆盖「当时已经在设置里的那些站点」。
   * 抓到之后 onFetched 会推 favicon:updated，外壳据此重画。
   */
  handle('favicon:json', (hosts) => {
    if (!faviconCache) return {};
    const list = Array.isArray(hosts) ? hosts : [];
    faviconCache.refreshIfStale(list);
    return faviconCache.jsonFor(list);
  });

  handle('engine:list', () => registry.list());
  handle('engine:re-resolve', async (forceCompat) => {
    await registry.resolveAll({ forceCompat: !!forceCompat });
    return registry.list();
  });

  handle('adblock:stats', () => adblock.statsSnapshot());
  handle('adblock:reset', () => { adblock.resetStats(); return adblock.statsSnapshot(); });
  handle('adblock:source:toggle', ({ id, enabled }) => {
    const ok = adblock.setSourceEnabled(id, enabled);
    if (ok) {
      const cur = settings.get('adblock.sources', {}) || {};
      settings.patch({ adblock: { sources: { ...cur, [id]: !!enabled } } });
    }
    return adblock.statsSnapshot();
  });
  handle('adblock:allowlist:add', (host) => {
    adblock.allowlist.add(host);
    settings.patch({ adblock: { allowlist: [...adblock.allowlist] } });
    return [...adblock.allowlist];
  });
  handle('adblock:allowlist:remove', (host) => {
    adblock.allowlist.delete(host);
    settings.patch({ adblock: { allowlist: [...adblock.allowlist] } });
    return [...adblock.allowlist];
  });
  handle('adblock:import-list', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '导入过滤清单（EasyList / ABP 语法）',
      filters: [{ name: '过滤清单', extensions: ['txt', 'list'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (res.canceled) return { imported: 0 };
    let imported = 0;
    for (const f of res.filePaths) imported += adblock.importFile(f);
    settings.patch({ adblock: { userLists: [...settings.get('adblock.userLists', []), ...res.filePaths] } });
    return { imported, stats: adblock.statsSnapshot() };
  });

  handle('ext:list', () => extManager.list());
  handle('ext:install', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '安装扩展',
      filters: [
        { name: 'Chromium 扩展 / 火狐扩展', extensions: ['crx', 'xpi', 'zip'] },
        { name: '全部文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'openDirectory', 'multiSelections']
    });
    if (res.canceled) return { installed: [] };
    const installed = [];
    for (const p of res.filePaths) {
      try {
        const info = await extManager.install(p, () => session.fromPartition('persist:nova-chromium'));
        installed.push(info);
        const recs = settings.get('extensions', []).filter((r) => r.path !== p);
        recs.push({ id: info.id, name: info.name, path: p, source: info.source });
        settings.patch({ extensions: recs });
      } catch (err) {
        installed.push({ error: err.message, path: p });
      }
    }
    return { installed };
  });

  /* --- 拖拽安装：从一个具体路径直接装，不再弹文件框 ---
     外壳把拖进来的文件拦下来，按扩展判过类型后把绝对路径交到这里。
     和 ext:install 同一套记账（写进 settings.extensions 以便重启恢复），
     只是少了「让用户挑文件」那一步。 */
  handle('ext:install-path', async (p) => {
    if (!p || typeof p !== 'string') return { error: '缺少文件路径' };
    if (!isExtensionFile(p)) {
      const ext = path.extname(p).toLowerCase();
      return { error: `不是扩展包：${ext || '未知类型'}（支持 .crx / .zip / .xpi）` };
    }
    try {
      const info = await extManager.install(p, () => session.fromPartition('persist:nova-chromium'));
      const recs = settings.get('extensions', []).filter((r) => r.path !== p);
      recs.push({ id: info.id, name: info.name, path: p, source: info.source });
      settings.patch({ extensions: recs });
      return { installed: info };
    } catch (err) {
      return { error: err.message };
    }
  });
  handle('ext:remove', (id) => extManager.remove(id, () => session.fromPartition('persist:nova-chromium')));

  /* --- 从 Edge 加载项商店装（模块头解释了为什么必须由外壳自己取包） --- */

  // 只查详情、不下载。装之前先让用户看清装的是什么 —— 商店页上的名字
  // 与装完之后的卡片对得上，是这件事可信的全部来源。
  handle('ext:store-info', (input) => extStore.fetchDetail(input, { chromeVersion: process.versions.chrome }));

  handle('ext:store-install', async (input) => {
    const parsed = extStore.parseStoreInput(input);
    if (!parsed) return { error: '认不出扩展。请粘贴商店里那个扩展的页面地址，或者 32 位的扩展 ID。' };

    // 「已经装过」的判据用 settings 里记的 storeId，**不是** Chromium 给的
    // electronId —— 真环境实测：loadExtension 对解包目录按路径重新派生 ID，
    // 同一个扩展每次解到新目录就得到一个新 ID，拿它判重永远判不中，
    // 用户多点一次「安装」就会真的多出一份。
    const existed = settings.get('extensions', []).find((r) => r.storeId === parsed.crxId);
    if (existed) return { already: true, name: existed.name };

    const dest = path.join(extStoreDir, parsed.crxId + '.crx');
    const dl = await extStore.downloadCrx(input, dest, { chromeVersion: process.versions.chrome });
    if (dl.error) return { error: dl.error };

    try {
      const info = await extManager.install(dest, () => session.fromPartition('persist:nova-chromium'));
      // 与「安装扩展」那条路同一套记账，否则重启后恢复装载找不到它。
      // storeId 单独记一份：恢复装载按 path 装，但「装没装过」得按商店 ID 认。
      const recs = settings.get('extensions', []).filter((r) => r.path !== dest);
      recs.push({ id: info.id, name: info.name, path: dest, source: info.source, storeId: parsed.crxId });
      settings.patch({ extensions: recs });
      return { installed: info };
    } catch (err) {
      return { error: '装载失败：' + err.message };
    }
  });

  handle('history:list', (limit = 200) => settings.get('history', []).slice(0, limit));
  handle('history:clear', () => { settings.clearHistory(); return []; });
  handle('bookmarks:list', () => settings.get('bookmarks', []));
  handle('bookmarks:add', (bm) => { settings.addBookmark(bm); return settings.get('bookmarks'); });
  handle('bookmarks:remove', (url) => { settings.removeBookmark(url); return settings.get('bookmarks'); });
  handle('bookmarks:clear', () => { settings.patch({ bookmarks: [] }); return []; });

  /* ----------------------- 书签导入 / 导出 -----------------------
   * 格式与清洗规则都在 src/main/bookmarks-io.js（纯逻辑，可离线单测）；
   * 这一段只负责「挑文件、读文件、写文件」三件 IO。
   *
   * 导出给的是自家 JSON；导入**也认 Chrome / Edge 导出的 HTML** ——
   * 「导入」最要紧的用途就是从别的浏览器搬过来，不认那种格式的话
   * 这个功能在真正需要它的场景里是废的。
   */
  handle('bookmarks:export', async () => {
    const list = settings.get('bookmarks', []);
    if (!list.length) return { canceled: true, reason: '还没有书签可导出' };
    const stamp = new Date().toISOString().slice(0, 10);
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出书签',
      defaultPath: `nova-bookmarks-${stamp}.json`,
      filters: [{ name: '书签文件', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    const doc = bookmarksIo.buildExport(list, app.getVersion());
    try {
      // 缩进 2：用户多半会用记事本打开确认一下内容，
      // 压成一行的 JSON 那种黑压压一片，看着就不敢碰
      await fs.promises.writeFile(res.filePath, JSON.stringify(doc, null, 2), 'utf8');
    } catch (e) {
      return { error: '写入失败：' + (e && e.message ? e.message : String(e)) };
    }
    return { path: res.filePath, count: doc.count };
  });

  handle('bookmarks:import', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '导入书签',
      // .html / .htm 也列上：那是 Chrome / Edge 导出的那份
      filters: [{ name: '书签文件', extensions: ['json', 'html', 'htm'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    let text;
    try {
      text = await fs.promises.readFile(res.filePaths[0], 'utf8');
    } catch (e) {
      return { error: '读取失败：' + (e && e.message ? e.message : String(e)) };
    }
    const parsed = bookmarksIo.parseImport(text);
    if (!parsed.items.length) return { error: parsed.reason || '这个文件里没有书签' };

    const cur = settings.get('bookmarks', []);
    const m = bookmarksIo.merge(cur, parsed.items);
    settings.patch({ bookmarks: m.merged });
    send('settings:changed', settings.all());
    // 顺带更新收藏夹栏与书签列表的图标缓存：导入进来的大多没抓过图标，
    // 不 kick 一次的话它们会一直停在首字母上
    if (faviconCache && typeof faviconCache.refreshIfStale === 'function') {
      faviconCache.refreshIfStale(m.merged.map((b) => b.url));
    }
    return {
      added: m.added,
      dup: m.dup,
      skipped: parsed.skipped,
      reason: parsed.reason,
      total: m.merged.length,
      bookmarks: m.merged
    };
  });

  /* --- 下载 --- */
  handle('download:list', () => dlManager.list());
  handle('download:stats', () => dlManager.stats());
  handle('download:new', ({ url, filename, engineId } = {}) => {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) return { error: '只支持 http / https 地址' };
    const id = dlManager.enqueue({
      url: target,
      filename: filename ? String(filename) : '',
      engineId: engineId || null,
      source: 'manual'
    });
    return { id };
  });
  handle('download:pause', (id) => dlManager.pause(id));
  handle('download:resume', (id) => dlManager.resume(id));
  handle('download:cancel', (id) => dlManager.cancel(id));
  handle('download:remove', (id) => dlManager.remove(id));
  handle('download:retry', (id) => dlManager.retry(id));
  handle('download:clear-finished', async () => {
    await dlManager.removeAll({ includeDone: true });
    schedulePersistDownloads();
    return dlManager.list();
  });
  handle('download:open', (p) => shell.openPath(p || dlManager.dir));
  handle('download:show', (p) => shell.showItemInFolder(p));
  handle('download:choose-dir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择下载目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });
  handle('download:dir', () => dlManager.dir);

  /* --- 媒体嗅探 --- */
  handle('sniff:list', (filter = {}) => (sniffer ? sniffer.list(filter) : []));
  handle('sniff:stats', (filter = {}) => (sniffer ? sniffer.stats(filter && filter.tabId) : null));
  handle('sniff:formats', () => FORMAT_STATS);
  handle('sniff:clear', (filter = {}) => {
    if (!sniffer) return [];
    if (filter && filter.tabId != null) sniffer.reset(filter.tabId);
    else sniffer.clearAll();
    return sniffer.list(filter && filter.tabId != null ? { tabId: filter.tabId } : {});
  });
  handle('sniff:reset-stats', () => {
    if (!sniffer) return null;
    sniffer.resetStats();
    return sniffer.stats();
  });
  /** 渲染层探测出的时长 / 分辨率回填到记录上 */
  handle('sniff:meta', ({ id, meta } = {}) => (sniffer ? sniffer.setMeta(id, meta) : null));

  /* --- 移动端阅读：无图模式 --- */
  handle('mobile:state', (wcId) => {
    if (!noMedia) return null;
    const id = wcId == null ? null : Number(wcId);
    return { noImage: noMedia.snapshot(Number.isFinite(id) ? id : null) };
  });
  handle('mobile:stats', (wcId) => {
    if (!noMedia) return null;
    const id = wcId == null ? null : Number(wcId);
    return noMedia.snapshot(Number.isFinite(id) ? id : null);
  });
  /**
   * 「显示本页图片」。
   * 放行 + 开一个宽限窗口，让紧接着的重载不会被自己的清理逻辑把放行抹掉。
   * 调用方必须重载页面 —— 已经被拦掉的请求不会因为放行而自己回来。
   */
  handle('mobile:show-images', (wcId) => {
    if (!noMedia) return null;
    const id = Number(wcId);
    if (!Number.isFinite(id)) return noMedia.snapshot();
    noMedia.allowPage(id);
    noMediaGrace.set(id, Date.now() + 4000);
    return noMedia.snapshot(id);
  });
  handle('mobile:reset-stats', () => {
    if (!noMedia) return null;
    const s = noMedia.resetStats();
    send('mobile:stats', s);
    return s;
  });

  /** 清空全部内核分区（含默认 session）的 Cookie / 缓存 / localStorage */
  handle('app:clear-site-data', async () => {
    const partitions = new Set(registry.engines.map((e) => e.partition));
    let cleared = 0;
    const failed = [];
    const targets = [...partitions].map((p) => [p, session.fromPartition(p)]);
    targets.push(['<default>', session.defaultSession]);
    for (const [name, ses] of targets) {
      try {
        await ses.clearStorageData();
        await ses.clearCache();
        cleared += 1;
      } catch (err) {
        failed.push(name + ': ' + err.message);
      }
    }
    return { cleared, total: targets.length, failed };
  });

  handle('shell:open-external', (url) => shell.openExternal(url));
  handle('shell:copy', (text) => { clipboard.writeText(String(text == null ? '' : text)); return true; });
  handle('shell:show-item', (p) => shell.showItemInFolder(p));
  handle('app:userData', () => app.getPath('userData'));
  handle('app:open-user-data', () => shell.openPath(app.getPath('userData')));

  ipcMain.on('window:control', (_e, action) => {
    if (!mainWindow) return;
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    else if (action === 'close') mainWindow.close();
  });

  ipcMain.on('debug:log', (_e, msg) => console.log('[renderer]', msg));
}

registerIpc();

app.on('window-all-closed', () => {
  registry.stopAll();
  // 正在跑的任务先暂停并把游标落盘，下次启动能接着下
  if (dlManager) {
    dlManager.shutdown().finally(() => {
      try { settings.patch({ downloadTasks: dlManager.persistable() }); } catch { /* noop */ }
      settings.flush();
    });
  }
  settings.flush();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
