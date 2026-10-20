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
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, session, dialog, shell, nativeTheme, clipboard, safeStorage, Menu, webContents } = require('electron');
const QRCode = require('qrcode'); // 本地生成二维码（分享用），不把网址丢第三方二维码接口
const creds = require('./credentials'); // 从 Edge 导入已存密码（本地解密）
const protocolLinks = require('./protocol-links'); // ed2k / magnet 交给本地客户端

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
const browsersDetect = require('./browsers-detect');
const browserExtensions = require('./browser-extensions');
const desktopShortcut = require('./desktop-shortcut');
const permissions = require('./permissions');

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
let extWorkDir = '';   // 解包缓存目录（bootstrap 里赋值）
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

  // 站点权限：让主进程随时能读到最新规则（含用户刚改的），并知道往哪个窗口弹询问条
  permissions.configure({
    getPermissions: () => settings.get('permissions', []),
    getMainWindow: () => mainWindow
  });

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
    permissions.installPermissionHandlers(ses);
  }
  // 默认 session 也接一份，避免无分区页面漏网
  sessionEngineMap.set(session.defaultSession, 'chromium');
  engineSessions.set('chromium', session.defaultSession);
  registry.get('chromium').applyHeaders(session.defaultSession);
  wireRequestGate(session.defaultSession);
  wireDownloads(session.defaultSession, 'chromium');
  wireSniffer(session.defaultSession);
  permissions.installPermissionHandlers(session.defaultSession);

  // 6.5) 内核桥接：原生宿主（trident host）跑起来后，把它的事件转发给渲染进程。
  // 只有 resolve 到 bridge 的内核才有运行中的宿主进程；compat 内核不在此列。
  // host 通过 NDJSON 发出的 frame/title/url/cursor/log/error 都原样转出去（附上 engineId），
  // 供渲染进程把帧画到标签页、同步地址/标题。
  const HOST_FWD_EVENTS = ['frame', 'title', 'url', 'cursor', 'log', 'error'];
  for (const engine of registry.engines) {
    if (!engine.host) continue;
    for (const ev of HOST_FWD_EVENTS) {
      engine.host.on(ev, (msg) => {
        if (msg && typeof msg === 'object') send('host:event', Object.assign({ engineId: engine.id }, msg));
      });
    }
    engine.host.on('exit', (code) => {
      console.warn(`[bridge] ${engine.id}-host 退出，code=${code}`);
    });
  }

  // 7) 扩展：统一装到 chromium 内核 session（Chromium 扩展实现的宿主）
  // 解包缓存目录。单独提一个变量：从别的浏览器导入扩展时也要往这里复制
  extWorkDir = path.join(app.getPath('userData'), 'extensions');
  extManager = new ExtensionManager({
    workDir: extWorkDir,
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

  /* 恢复扩展。
   *
   * **优先用「上次解包好的目录」而不是原始包路径。**
   * 记的是包路径的话，每次启动都要把整个包重新解一遍（DeepSider 是
   * 434 个文件 / 8.7 MB），而这一步在 createWindow() **之前**、还是
   * 顺序 await —— 窗口要等所有扩展解包完才出现。用户的原话是
   * 「装完插件后开启浏览器特别慢」，根因就在这里。
   *
   * 目录不在了才退回原始包路径（比如用户手动清了 userData）。
   * 停用的那些**不装进 session**，但要登记进列表 ——
   * 否则用户停用之后就再也找不到它、也没法重新启用。
   */
  const extRecords = settings.get('extensions', []);
  const extRecordsNext = [];
  for (const rec of extRecords) {
    try {
      const src = (rec.dir && fs.existsSync(rec.dir)) ? rec.dir : rec.path;
      if (!src || !fs.existsSync(src)) {
        // 两者都不在：不静默删记录（用户的包可能只是暂时不在，比如插在
        // 移动硬盘上），只记一条日志，界面里那条仍然可见、可手动移除
        console.warn('[extensions] 恢复失败（文件不在了）', rec.path);
        extRecordsNext.push(rec);
        continue;
      }
      const info = await extManager.install(src, extSessionFactory);
      if (rec.enabled === false) {
        // 上次是停用状态：装完立刻卸下来，并保留在列表里
        await extManager.setEnabled(info.id, false, extSessionFactory);
      }
      /* **把 dir 写回去。**
       * 这条是为**老记录**补的：本版之前装上来的那些，settings 里只有
       * 原始包路径、没有 dir —— 于是每次启动都走「解包」那条路。
       * 不补这一步，它们会永远每次启动重解一遍（正是用户报的那个慢），
       * 这一版只修好了「新装的那部分」。
       * 也顺带补上 enabled，让老记录和新记录形状一致。 */
      extRecordsNext.push({
        ...rec,
        id: info.id,
        name: info.name,
        source: info.source,
        dir: info.dir,
        enabled: rec.enabled !== false
      });
    } catch (err) {
      console.warn('[extensions] 恢复失败', rec.path, err.message);
      extRecordsNext.push(rec);
    }
  }
  // 只在真的变过时才落盘，避免每次启动都写一遍 settings
  if (JSON.stringify(extRecordsNext) !== JSON.stringify(extRecords)) {
    settings.patch({ extensions: extRecordsNext });
  }
  // 顺手清掉旧版本留下的孤儿解包目录（那时用的是时间戳目录名，每次启动新建一个）
  try {
    const n = extManager.pruneOrphanDirs(settings.get('extensions', []));
    if (n) console.info(`[extensions] 清掉 ${n} 个无引用的解包目录`);
  } catch { /* 清理失败不影响启动 */ }

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
    // 限速走 getter：用户改设置后下一步写盘就按新速度走，不必重启任务
    speedLimitFor: () => {
      const kb = Number(settings.get('download').speedLimitKB || 0);
      return kb > 0 ? kb * 1024 : 0;
    },
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
      progress: 0,
      source: 'chromium',
      state: 'progress'
    };

    /* 进度条读的是 progress（0..1 的比值），**不是** received / total。
     *
     * <p>Chromium 只给字节数，它不会替你算这个比值 —— 而这条路上原来
     * 从头到尾没写过 progress，于是这一条任务的进度条永远是 0% 宽，
     * 只有右边的「已下载 12.3 MB / 88.1 MB」在动。用户看到的正是
     * 「进度条不跟着百分比走」。（Nova 多线程那条路是在 snapshot() 里算的，
     * 所以只有回退到内建下载器的任务会这样。） */
    const syncNativeProgress = () => {
      payload.progress = payload.total > 0
        ? Math.min(1, payload.received / payload.total)
        : 0;
    };

    send('download:update', payload);
    item.on('updated', (_ev, state) => {
      payload.received = item.getReceivedBytes();
      payload.total = item.getTotalBytes();
      payload.state = state;
      syncNativeProgress();
      send('download:update', payload);
    });
    item.once('done', (_ev, state) => {
      payload.state = state === 'completed' ? 'done' : state;
      payload.received = item.getReceivedBytes();
      payload.total = item.getTotalBytes();
      // 完成就是 100%：按比值算的话，服务端少算几百字节会让它停在 99.9%，
      // 显示上像是没下完
      if (payload.state === 'done') payload.progress = 1;
      else syncNativeProgress();
      payload.path = item.getSavePath();
      payload.savePath = item.getSavePath();
      send('download:update', payload);
    });
  });
}

/* ------------------------------------------------------------------ *
 * 页面事件接线路由
 * ------------------------------------------------------------------ */

/**
 * 渲染进程退出的现场记录。
 *
 * <p>这类崩溃在界面上表现为「整块灰」（guest 未绘制时的占位面，实测正是 #808080），
 * 用户只能描述成“过一会变灰了”。把 reason / exitCode / URL 写进 userData/crash.log，
 * 事后能直接看出是 oom、crashed 还是被系统 kill。
 */
function logRendererGone(contents, details) {
  try {
    const rec = {
      at: new Date().toISOString(),
      reason: (details && details.reason) || 'unknown',
      exitCode: details ? details.exitCode : null,
      url: (contents && typeof contents.getURL === 'function') ? contents.getURL() : '',
      engine: sessionEngineMap.get(contents && contents.session) || 'chromium'
    };
    fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), JSON.stringify(rec) + '\n');
  } catch { /* 写日志失败不该影响运行 */ }
}

/**
 * 交给系统里注册的 eD2k / 磁力客户端。
 *
 * <p>只在这里做「弹确认 + 拉起」的编排，协议解析与文案都在 protocol-links.js，
 * 那部分是纯函数，能在 Node 里直接测。
 */
function handleExternalDownloadLink(url) {
  protocolLinks.handleExternalLink({
    url,
    dialog,
    shell,
    clipboard,
    parent: mainWindow,
    toast: (msg) => send('app:toast', String(msg || ''))
  }).catch(() => { /* 拉起外部程序失败不该影响浏览 */ });
}

function wireContents(contents) {
  const engineId = sessionEngineMap.get(contents.session) || 'chromium';
  const engine = registry.get(engineId);

  contents.setWindowOpenHandler(({ url, disposition }) => {
    // ed2k / magnet 不该开成一个标签页 —— 浏览器本身下不了，交给外部客户端
    if (protocolLinks.isExternalDownloadLink(url)) {
      handleExternalDownloadLink(url);
      return { action: 'deny' };
    }
    // 站点权限：被显式禁止弹窗的主机，连同背景标签一起拦下（见 permissions.decidePopup）
    if (permissions.decidePopupOnOpen(settings.get('permissions', []), permissions.hostOf(url)) === 'block') {
      return { action: 'deny' };
    }
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
    if (typeof url !== 'string') return;

    // 同标签点 ed2k: / magnet: 会走到这里（实测确实会触发 will-navigate）。
    // 不拦的话 Electron 会当成一次导航，最后以 ERR_UNKNOWN_URL_SCHEME 失败。
    if (protocolLinks.isExternalDownloadLink(url)) {
      event.preventDefault();
      handleExternalDownloadLink(url);
      return;
    }

    /* 拖入扩展**落在网页区域**时走的是这一条，不是外壳的 document.drop。
     *
     * <p>原因：网页是 <webview>，它跑在**独立的渲染进程**里。往它上面拖一个
     * 文件，事件被那个进程接走（页面上往往还会弹出自己的「拖入以上传」提示，
     * 比如 DeepSeek 就有），外壳那一层 document 根本收不到 ——
     * 于是用户看到「拖进去没反应」。
     *
     * <p>而 Chromium 对拖进来的本地文件，默认动作是**导航到那个 file:// 地址**
     * （也就是「浏览器打开这个文件」）。所以这里能兜住：拦下「file:// 且扩展名
     * 是扩展包」的导航，改成安装。
     *
     * <p>只认扩展包后缀，其余 file:// 导航（比如用户自己点开本地 html）
     * 一律放行 —— 这个判断很窄，不会误伤正常浏览。 */
    if (/^file:\/\//i.test(url) && isExtensionFile(url)) {
      event.preventDefault();
      let p = '';
      try { p = decodeURIComponent(url.replace(/^file:\/\//i, '')); } catch { p = ''; }
      // Windows 的 file:///C:/x 去掉 file:// 后是 /C:/x，要去掉那个前导斜杠
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      if (!p) return;
      installOneExtension(p).then((r) => {
        send('settings:changed', settings.all());
        // 结果回报给界面：装成了就提示名字，没成就把原因原样给出
        if (r && r.installed) {
          send('ext:dropped', { ok: true, name: r.installed.name });
        } else {
          send('ext:dropped', { ok: false, error: (r && r.error) || '安装失败' });
        }
      }).catch(() => {});
      return;
    }

    if (url.indexOf(ntp.CMD_PREFIX) !== 0) return;
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
    logRendererGone(contents, details);
    send('tab:crashed', { id: contents.id, reason: details.reason });
  });

  // 页面标签的音频状态（缩放走 webview 的 preload，不在这里做）
  if (contents.getType() === 'webview') {
    // 注意：这个事件的第二个参数在 Electron 30 里拿不到，直接问 isCurrentlyAudible()
    contents.on('audio-state-changed', () => {
      let audible = false;
      try { audible = contents.isCurrentlyAudible(); } catch { /* 页面销毁中 */ }
      send('tab:audio', { id: contents.id, audible });
    });
  }

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

  /**
   * 渲染层对一次「权限询问」的最终答复。
   *
   * 权限条（渲染层）上用户点了允许/禁止，结果从这里回给主进程，
   * 解除 setPermissionRequestHandler 里挂起的回调（见 permissions.resolvePending）。
   * 会话内对「询问」的选择会记住一次，刷新页面不用再问；要长期生效
   * 得去「设置 → 站点权限」显式写规则（那里走 settings:patch 落盘）。
   */
  handle('permissions:resolve', (requestId, allow) => {
    permissions.resolvePending(requestId, allow);
    return { ok: true };
  });

  /* ----------------------- 自动更新（PC） -----------------------
   * **自己下载安装包**（不用 electron-updater，原因见 updater.js 文件头）。
   * 清单用 site/version.json，里面有 url / size / sha256 —— 下完要**校验**。
   *
   * 状态机在上游：check → available → downloading → ready。
   * 这里负责把状态转给渲染层，并把用户的动作（下载、安装）转回去。
   * 「自动下载」与「自动安装」的策略在**渲染层**决定（它才知道用户设了什么），
   * 主进程只提供能力，不做策略 —— 这样设置一改就立刻生效，不用重启。
   */

  // 当前更新状态。渲染层重启后会来问一次，所以不能只靠推送。
  // lastCheckAt 每一处构造 updaterState 都要带上：整体替换会把 updater.start()
  // 写进去的值抹掉，而「关于」面板读的是它
  let updaterState = { status: 'idle', info: null, error: '', lastCheckAt: '' };

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
      // 自己下（不用 electron-updater），下完把路径记进状态 ——
      // 「安装」那一步要的就是它，而不是再去问下载器还剩什么
      const r = await updater.download(updaterState, {
        onProgress: (p) => send('update:progress', p)
      });
      updaterState = {
        status: 'ready',
        info: updaterState.info,
        error: '',
        installerPath: r.path,
        reused: !!r.reused,
        lastCheckAt: updaterState.lastCheckAt || ''
      };
      pushUpdater();
      return { ok: true, path: r.path, reused: !!r.reused };
    } catch (e) {
      // 失败要回到 available（而不是留在 downloading）——否则界面上那个
      // 「重试」会变成「下载中」卡住，用户只能重启应用
      updaterState = {
        ...updaterState,
        status: 'available',
        error: String(e && e.message || e)
      };
      pushUpdater();
      return { error: updaterState.error };
    }
  });

  /* 拉起安装器并退出自己。返回 {ok} 而不是抛 —— 渲染层要把它显示出来
     （原来那个 ok:false 的返回值渲染层根本没看，用户点了「立即重启」
     而什么都没发生、界面也不说一句）。 */
  handle('update:install', () => updater.installAndRestart(updaterState));

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
  // 渲染进程 → 原生宿主的指令通道（create/navigate/resize/input/eval/destroy/activate/stop）。
  // 按 engineId 路由到对应内核的 NativeKernelHost；宿主未运行（compat 模式）时优雅返回错误。
  handle('host:cmd', async ({ engineId, t, payload, expectReply } = {}) => {
    const engine = registry.get(engineId);
    if (!engine || !engine.host) return { ok: false, message: `未知内核：${engineId}` };
    try {
      return await engine.host.send(t, payload || {}, { expectReply: expectReply !== false, timeout: 8000 });
    } catch (err) {
      return { ok: false, message: err.message };
    }
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

  /**
   * 装一个扩展并把记账写回 settings。
   *
   * <p>抽出来是因为「浏览安装」与「拖入安装」两条路都要做同样三件事：
   * 装、写 settings.extensions（重启恢复靠它）、返回结果。
   * 原来两处各抄一遍，而**「删除」那条路就是因为漏了记账，导致重启又装回来** ——
   * 与其继续抄，不如收到一处。
   *
   * @returns {Promise<{installed?:object, error?:string}>} 永不 reject
   */
  async function installOneExtension(p) {
    try {
      const info = await extManager.install(p, () => session.fromPartition('persist:nova-chromium'));
      const recs = settings.get('extensions', []).filter((r) => r.path !== p);
      /* dir 一定要记：重启恢复靠它直接装载，省掉重新解包那一步（见 bootstrap）。
         enabled 也记：用户停用过的下次启动要保持停用。 */
      recs.push({
        id: info.id, name: info.name, path: p, source: info.source,
        dir: info.dir, enabled: info.enabled !== false
      });
      settings.patch({ extensions: recs });
      return { installed: info };
    } catch (err) {
      return { error: String(err && err.message || err), path: p };
    }
  }

  handle('ext:list', () => extManager.list());

  /* AI 助手：走 API（OpenAI 兼容的 /chat/completions）。
   *
   * 为什么改成 API：内嵌网页对话会被一些 AI 站点识别成嵌入式 webview、
   * 以「环境异常 / 有隐私泄露风险」为由拒绝渲染。API 是自己的请求，
   * 不受对方页面脚本摆布。请求放主进程发：一来避开页面 CORS，二来密钥
   * 只在主进程与设置里流转，不落到渲染层页面上下文。
   *
   * cfg = { base, key, model, messages:[{role, content}] }
   *   base  例：https://api.deepseek.com （末尾斜杠会自动去掉）
   *   key   Bearer 令牌
   *   model 例：deepseek-chat
   * 返回 { ok:true, content } 或 { error }。 */
  handle('ai:chat', async (cfg) => {
    const base = String((cfg && cfg.base) || 'https://api.deepseek.com').replace(/\/+$/, '');
    const key = String((cfg && cfg.key) || '').trim();
    const model = String((cfg && cfg.model) || 'deepseek-chat').trim();
    const messages = (cfg && Array.isArray(cfg.messages)) ? cfg.messages : [];
    if (!key) return { error: '还没有填 API Key —— 在 AI 面板里选「API」后填写' };
    if (!messages.length) return { error: '没有要发送的内容' };
    // 超时护栏：LLM 偶尔会卡住，不能让 IPC 一直挂着
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);
    try {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model, messages, stream: false, temperature: 0.6 })
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        return { error: `API 返回 HTTP ${res.status}${t ? '：' + t.slice(0, 300) : ''}` };
      }
      const data = await res.json();
      const content = data && data.choices && data.choices[0]
        && data.choices[0].message && data.choices[0].message.content;
      if (typeof content !== 'string' || !content.trim()) {
        return { error: 'API 返回里没有可用内容' };
      }
      return { ok: true, content };
    } catch (e) {
      const msg = (e && e.name === 'AbortError') ? '请求超时（60s）' : String(e && e.message || e);
      return { error: '请求失败：' + msg };
    } finally {
      clearTimeout(timer);
    }
  });

  /* 扫本机其它浏览器里已装的扩展。
   *
   * 为什么需要：Edge 商店的取包接口已经被微软关掉（一律 400），
   * 详情接口又不给 Chrome 侧的 ID，所以「粘贴地址直接装」对 Edge 走不通。
   * 但商店装好的扩展在磁盘上是**解包**的，可以复制过来直接用。
   * 详见 browser-extensions.js 的文件头。 */
  handle('ext:from-browser', () => {
    try {
      return { ok: true, found: browserExtensions.scan() };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), found: [] };
    }
  });

  handle('ext:import-from-browser', async (key) => {
    if (!key || typeof key !== 'string') return { error: '缺少扩展标识' };
    // 按 key **重新扫一次**自己解析目录，不用渲染层传来的路径 ——
    // 否则等于开了一个「把任意目录当扩展装载」的口子
    const hit = browserExtensions.scan().find((x) => x.key === key);
    if (!hit) return { error: '没有找到这个扩展（可能刚被卸载）' };
    try {
      const dest = browserExtensions.importToOneDir(hit, extWorkDir);
      const r = await installOneExtension(dest);
      if (r.error) return r;
      return { ...r, from: hit.browser, name: r.installed.name };
    } catch (e) {
      return { error: '导入失败：' + String(e && e.message || e) };
    }
  });

  /* 把「用户选中的路径」摊平成真正要装的**包路径**列表。
   *
   * <p>用户下载扩展之后，落盘常常是「一个与扩展同名的文件夹，里面躺着
   * 那个 .crx」—— 他选「浏览安装」时顺理成章选中那个**文件夹**。
   * 而它既不是包、也不是已解包的扩展目录，于是报
   * 「扩展目录内缺少 manifest.json」。可那个文件夹里根本没有 manifest.json，
   * 这句话对他毫无帮助。
   *
   * <p>所以这里替他把这一层找出来：目录里若直接躺着扩展包，就把它们当成本次
   * 要装的东西。**只在「这个目录本身不像扩展」时才展开** —— 否则一个正常的
   * 已解包扩展目录里若恰好有个 .zip，会被误当成两个扩展。
   */
  function expandInstallTargets(paths) {
    const out = [];
    for (const p of paths) {
      let isDir = false;
      try { isDir = fs.statSync(p).isDirectory(); } catch { isDir = false; }
      if (!isDir) { out.push(p); continue; }
      // 目录本身就是一个（已解包的）扩展 → 原样交给 install
      if (extensions.resolveExtensionRoot(p)) { out.push(p); continue; }
      const pkgs = extensions.findPackagesIn(p);
      if (pkgs.length) out.push(...pkgs);
      else out.push(p);   // 里面也没有包：原样交下去，让 install 报那句实情
    }
    return out;
  }

  handle('ext:install', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '安装扩展',
      filters: [
        // crx3 也要列进去 —— 它在 EXTENSION_EXTS 白名单里，装得上，
        // 却不写在这里的话它在这个对话框里显示成「不是受支持的类型」，
        // 用户会以为不支持而去找别的包。（白名单与过滤器必须同步。）
        { name: 'Chromium 扩展 / 火狐扩展', extensions: ['crx', 'crx3', 'xpi', 'zip'] },
        { name: '全部文件', extensions: ['*'] }
      ],
      properties: ['openFile', 'openDirectory', 'multiSelections']
    });
    if (res.canceled) return { installed: [] };
    const installed = [];
    for (const p of expandInstallTargets(res.filePaths)) {
      const r = await installOneExtension(p);
      installed.push(r.installed || { error: r.error, path: p });
    }
    return { installed };
  });

  /* --- 拖拽安装：从一个具体路径直接装，不再弹文件框 ---
     外壳把拖进来的文件拦下来，按扩展判过类型后把绝对路径交到这里。
     和 ext:install 同一套记账（写进 settings.extensions 以便重启恢复），
     只是少了「让用户挑文件」那一步。 */
  handle('ext:install-path', async (p) => {
    if (!p || typeof p !== 'string') return { error: '缺少文件路径' };
    // 目录也收：拖进来的可能是文件夹，也可能是「装着包的文件夹」。
    // 展开规则与「浏览安装」完全共用（同一个 expandInstallTargets）——
    // 两条路各写一份的话，迟早只有一边能装。
    const targets = expandInstallTargets([p]);
    if (targets.length !== 1) {
      // 展开出多个包时逐个装（拖入那条路的界面只显示一个结果，所以取第一个并说明）
      let last = null;
      for (const t of targets) {
        last = await installOneExtension(t);
        if (last && last.installed) break;
      }
      return last || { error: '这个文件夹里没有可安装的扩展包' };
    }
    if (!isExtensionFile(targets[0])) {
      const ext = path.extname(targets[0]).toLowerCase();
      const isDir = (() => { try { return fs.statSync(targets[0]).isDirectory(); } catch { return false; } })();
      if (isDir) {
        return {
          error: '这个文件夹里既没有扩展包（.crx / .crx3 / .zip / .xpi），'
            + '也不是已解包的扩展（没有 manifest.json）。请选中含 manifest.json 的那一层。'
        };
      }
      return { error: `不是扩展包：${ext || '未知类型'}（支持 .crx / .crx3 / .zip / .xpi）` };
    }
    return installOneExtension(targets[0]);
  });

  /* 启用 / 停用。
   *
   * 这两件事在 Electron 里就是 loadExtension / removeExtension —— 没有单独的
   * 开关，装上就等于启用。所以这个开关**是真的生效**，不是界面装饰。
   * 停用是可逆的（记录留在列表里），移除不可逆（记录一并删掉），
   * 所以这里必须把 enabled 写回 settings，否则重启后停用的又自己开了。 */
  handle('ext:set-enabled', async (id, on) => {
    try {
      const info = await extManager.setEnabled(id, !!on, extSessionFactory);
      if (!info) return { error: '找不到这个扩展' };
      const recs = settings.get('extensions', []).map((r) =>
        (r.id === id ? { ...r, enabled: !!on } : r));
      settings.patch({ extensions: recs });
      send('ext:changed', extManager.list());
      return { ok: true, info };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  });

  /* 删除也**必须记账** —— 三条安装路径都往 settings.extensions 写了记录
     （见上面 ext:install / ext:install-path / ext:store-install），
     而 bootstrap() 的恢复循环会照着这些记录重新 install。
     少了这一步：用户移除一个扩展 → 重启浏览器 → 它又回来了；
     对从商店装的还会顺带占住 storeId，导致再点安装直接提示「已经装过」。
     典型的「加功能时三处都写了、删功能时漏了一处」。 */
  handle('ext:remove', async (id) => {
    const r = await extManager.remove(id, () => session.fromPartition('persist:nova-chromium'));
    const recs = settings.get('extensions', []).filter((x) => x.id !== id);
    settings.patch({ extensions: recs });
    return r;
  });

  /* --- 从 Edge 加载项商店装（模块头解释了为什么必须由外壳自己取包） --- */

  // 只查详情、不下载。装之前先让用户看清装的是什么 —— 商店页上的名字
  // 与装完之后的卡片对得上，是这件事可信的全部来源。
  handle('ext:store-info', (input) => extStore.fetchDetail(input, { chromeVersion: process.versions.chrome }));

  handle('ext:store-install', async (input) => {
    const parsed = extStore.parseStoreInput(input);
    if (!parsed) return { error: '认不出扩展。请粘贴商店里那个扩展的页面地址、32 位的扩展 ID，或者一个 .crx / .zip 的下载地址。' };

    /* 「已经装过」的判据用 settings 里记的 storeId，**不是** Chromium 给的
     * electronId —— 真环境实测：loadExtension 对解包目录按路径重新派生 ID，
     * 同一个扩展每次解到新目录就得到一个新 ID，拿它判重永远判不中，
     * 用户多点一次「安装」就会真的多出一份。
     *
     * **直链那条没有 storeId**，所以这里必须先判一下 crxId 在不在：
     * 拿 undefined 去比会把「任何没有 storeId 的记录」（比如拖入安装的那些）
     * 全判成「已经装过」，于是用户点安装得到一个莫名其妙的「已安装」。 */
    if (parsed.crxId) {
      const existed = settings.get('extensions', []).find((r) => r.storeId === parsed.crxId);
      if (existed) return { already: true, name: existed.name };
    }

    /* 落盘的文件名**必须带正确的扩展名**：extManager.install 是照后缀选解包方式的
     * （.crx → 拆签名段；.zip/.xpi → 直接解包）。直链那条沿用地址里的名字，
     * 商店那条用 crxId。名字里的路径分隔符等要挡掉，免得写出目录外。 */
    const dest = parsed.source === 'direct'
      ? path.join(extStoreDir, String(parsed.fileName || 'extension.crx').replace(/[\\/:*?"<>|]+/g, '_'))
      : path.join(extStoreDir, parsed.crxId + '.crx');
    const dl = await extStore.downloadCrx(input, dest, { chromeVersion: process.versions.chrome });
    if (dl.error) return { error: dl.error };

    try {
      const info = await extManager.install(dest, () => session.fromPartition('persist:nova-chromium'));
      // 与「安装扩展」那条路同一套记账，否则重启后恢复装载找不到它。
      // storeId 单独记一份：恢复装载按 path 装，但「装没装过」得按商店 ID 认。
      const recs = settings.get('extensions', []).filter((r) => r.path !== dest);
      recs.push({
        id: info.id, name: info.name, path: dest, source: info.source,
        storeId: parsed.crxId || '', dir: info.dir, enabled: info.enabled !== false
      });
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
  /* ----------------------- 从已安装的浏览器导入 -----------------------
   * 「导入书签」最要紧的用法是从别的浏览器搬过来。让用户自己去找
   * %LOCALAPPDATA% 下的 Bookmarks 文件不现实，而浏览器「导出 HTML」
   * 虽然通用，但要多点几步 —— 所以先检测，检测到了就一键读。
   *
   * 检测只**看文件在不在**，不读内容：检测结果本身不该泄露
   * 「这个浏览器里有哪些站点」。
   */
  handle('bookmarks:browsers', () => {
    try {
      const list = browsersDetect.detectBrowsers((p) => fs.existsSync(p));
      return { ok: true, browsers: list };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), browsers: [] };
    }
  });

  handle('bookmarks:from-browser', async (id) => {
    const found = browsersDetect.detectBrowsers((p) => fs.existsSync(p))
      .find((b) => b.id === id);
    if (!found) return { error: '没有找到这个浏览器（可能刚被卸载）' };
    if (!found.supported) return { error: found.note || '这个浏览器的书签格式暂不支持' };

    let items;
    try {
      items = browsersDetect.parseChromiumBookmarks(
        await fs.promises.readFile(found.file, 'utf8')
      );
    } catch (e) {
      // 读不到就说读不到，不猜。常见原因是浏览器正开着、文件被锁。
      return { error: '读取失败：' + String(e && e.message || e) };
    }
    if (!items.length) {
      return { error: `${found.name} 里没有可导入的网址书签` };
    }

    // 合并规则与从文件导入**完全一致**（同一个 merge）：
    // 已在的不覆盖、只追加 —— 用户本地改过的名字是ta自己的劳动。
    const m = bookmarksIo.merge(settings.get('bookmarks', []), items);
    settings.patch({ bookmarks: m.merged });
    send('settings:changed', settings.all());
    if (faviconCache) {
      // 传**主机名**而不是完整 URL —— refreshOne 内部会自己拼 https://，
      // 传 URL 会拼成 https://https://a.com/ 这种废地址（这个坑踩过一次）
      const hosts = [];
      for (const b of m.merged) {
        try { hosts.push(new URL(b.url).hostname); } catch { /* 不是网址，跳过 */ }
      }
      if (hosts.length && typeof faviconCache.refreshIfStale === 'function') {
        faviconCache.refreshIfStale(hosts);
      }
    }
    return {
      added: m.added, dup: m.dup, total: m.merged.length,
      from: found.name, bookmarks: m.merged
    };
  });

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
      // 传**主机名**，不是完整 URL —— refreshOne 内部自己会拼 https://，
      // 传 URL 会拼成 https://https://a.com//favicon.ico 这种废地址，
      // 结果是每次导入都白跑 3×N 次无效请求、图标永远出不来。
      // （另外三个调用点 injectFavicons / warmFavicons / favicon:json 都传对了，
      //   只有这一处漏了。）
      const hosts = [];
      for (const b of m.merged) {
        try { hosts.push(new URL(b.url).hostname); } catch { /* 不是网址，跳过 */ }
      }
      if (hosts.length) faviconCache.refreshIfStale(hosts);
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

  // 网页截图：整页走 CDP 的 captureBeyondViewport，可见区域走 capturePage。
  handle('page:capture', async (wcId, mode) => {
    const wc = webContents.fromId(Number(wcId));
    if (!wc || wc.isDestroyed()) return { ok: false, error: '页面已关闭' };
    let png = null;
    try {
      if (mode === 'full') {
        const dbg = wc.debugger;
        dbg.attach('1.3');
        try {
          const m = await dbg.sendCommand('Page.getLayoutMetrics');
          const size = m.cssContentSize || m.contentSize || { width: 1280, height: 800 };
          // 极长页面（评论区）截出来是几百 MB 的图，这里设个上限
          const width = Math.min(20000, Math.max(1, Math.ceil(size.width)));
          const height = Math.min(30000, Math.max(1, Math.ceil(size.height)));
          const shot = await dbg.sendCommand('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width, height, scale: 1 }
          });
          png = Buffer.from(shot.data, 'base64');
        } finally {
          try { dbg.detach(); } catch { /* 已经断开 */ }
        }
      } else {
        const img = await wc.capturePage();
        png = img.toPNG();
      }
    } catch (e) {
      // DevTools 占用调试器等情况：退回可见区域截图，别让用户什么都没拿到
      try {
        const img = await wc.capturePage();
        png = img.toPNG();
      } catch (e2) {
        return { ok: false, error: String((e2 && e2.message) || e2) };
      }
    }
    let name = '网页截图';
    try { name = wc.getTitle() || name; } catch { /* noop */ }
    name = String(name).replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || '网页截图';
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: '保存网页截图',
      defaultPath: path.join(app.getPath('pictures'), name + '.png'),
      filters: [{ name: 'PNG', extensions: ['png'] }]
    });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(picked.filePath, png);
      return { ok: true, path: picked.filePath };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  /* --- 打印 ---
   * 为什么必须由主进程接这一层：Electron 里网页自己调 `window.print()` 不会
   * 弹出系统打印窗口（Chromium 的打印预览在 Electron 里没有实现），`<webview>`
   * 更是连浏览器外壳都没有。于是用户按 Ctrl+P 只会得到「什么都没发生」——
   * 看起来就是打印坏了。这里把打印收成一条 IPC：外壳先给出纸张 / 边距 /
   * 方向这些设置，再交给 `webContents.print()` 弹系统窗口或直接出纸。
   *
   * 单位坑（两套 API 不一样，别混）：
   *   print()       pageSize 用微米，margins 用 96dpi 像素
   *   printToPDF()  pageSize 用英寸，margins 也用英寸
   * 所以下面同一份用户设置要分两个构造函数。
   */
  const PRINT_PAPER_MM = {
    A3: [297, 420], A4: [210, 297], A5: [148, 210], A6: [105, 148],
    B5: [176, 250], Letter: [215.9, 279.4], Legal: [215.9, 355.6],
    Tabloid: [279.4, 431.8], '16K': [184, 260]
  };
  // Chromium 认这些具名纸张；B5 / 16K 不在表里，只能按尺寸传
  const PRINT_STD_NAMES = new Set(['A3', 'A4', 'A5', 'A6', 'Letter', 'Legal', 'Tabloid']);
  const clampNum = (v, min, max, def) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  };
  const mmToMicron = (mm) => Math.round(mm * 1000);
  const mmToPx = (mm) => Math.round((mm / 25.4) * 96);
  const mmToInch = (mm) => mm / 25.4;

  const printPageSize = (opts) => {
    const o = opts || {};
    if (o.pageSize === 'custom') {
      return {
        width: mmToMicron(clampNum(o.customWidth, 50, 2000, 210)),
        height: mmToMicron(clampNum(o.customHeight, 50, 2000, 297))
      };
    }
    const name = String(o.pageSize || 'A4');
    if (PRINT_STD_NAMES.has(name)) return name;
    const mm = PRINT_PAPER_MM[name] || PRINT_PAPER_MM.A4;
    return { width: mmToMicron(mm[0]), height: mmToMicron(mm[1]) };
  };

  const printMargins = (opts) => {
    const o = opts || {};
    const type = String(o.marginType || 'default');
    if (type === 'none') return { marginType: 'none' };
    if (type === 'printableArea') return { marginType: 'printableArea' };
    if (type !== 'custom') return { marginType: 'default' };
    return {
      marginType: 'custom',
      top: mmToPx(clampNum(o.marginTop, 0, 100, 10)),
      bottom: mmToPx(clampNum(o.marginBottom, 0, 100, 10)),
      left: mmToPx(clampNum(o.marginLeft, 0, 100, 10)),
      right: mmToPx(clampNum(o.marginRight, 0, 100, 10))
    };
  };

  const pdfPageSize = (opts) => {
    const o = opts || {};
    if (o.pageSize === 'custom') {
      return {
        width: mmToInch(clampNum(o.customWidth, 50, 2000, 210)),
        height: mmToInch(clampNum(o.customHeight, 50, 2000, 297))
      };
    }
    const name = String(o.pageSize || 'A4');
    if (PRINT_STD_NAMES.has(name)) return name;
    const mm = PRINT_PAPER_MM[name] || PRINT_PAPER_MM.A4;
    return { width: mmToInch(mm[0]), height: mmToInch(mm[1]) };
  };

  // 「默认」在 printToPDF 里没有对应枚举，按 Chromium 自己的默认 1cm 显式写出来
  const pdfMargins = (opts) => {
    const o = opts || {};
    const type = String(o.marginType || 'default');
    if (type === 'none') return { top: 0, bottom: 0, left: 0, right: 0 };
    const pick = (v, def) => mmToInch(clampNum(v, 0, 100, def));
    if (type === 'custom') {
      return {
        top: pick(o.marginTop, 10), bottom: pick(o.marginBottom, 10),
        left: pick(o.marginLeft, 10), right: pick(o.marginRight, 10)
      };
    }
    // default / printableArea 都按 1cm 走；可打印区域由打印机决定，PDF 没有这个概念
    return { top: mmToInch(10), bottom: mmToInch(10), left: mmToInch(10), right: mmToInch(10) };
  };

  /**
   * "1-3,5" → [{from:0,to:2},{from:4,to:4}]（0 基、闭区间，与 Electron 一致）。
   * 返回 null 表示「没填 / 全部」；返回 false 表示格式不对（调用方要报错，
   * 不能静默当成全部 —— 用户明明填了范围，结果打了一整本，纸是真的会浪费的）。
   */
  const parsePageRanges = (input) => {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return null;
    const out = [];
    for (const part of raw.split(/[,，;；]/)) {
      const s = part.trim();
      if (!s) continue;
      const m = /^(\d+)\s*(?:[-–—~]\s*(\d*))?$/.exec(s);
      if (!m) return false;
      const from = parseInt(m[1], 10);
      if (!from) return false; // 页码从 1 开始，0 是无效输入
      const hasDash = /[-–—~]/.test(s);
      const to = m[2] ? parseInt(m[2], 10) : (hasDash ? 10000 : from);
      if (!to || to < from) return false;
      out.push({ from: from - 1, to: to - 1 });
      if (out.length > 40) return false;
    }
    return out.length ? out : null;
  };

  const resolveWc = (wcId) => {
    const wc = webContents.fromId(Number(wcId));
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  };

  /** 打印预览的文件序号：让每次预览都换一个地址，见 page:print-preview 的说明 */
  let previewSeq = 0;

  /** 系统打印机列表。deviceName 要用 name（系统名），displayName 只给界面看。 */
  handle('page:printers', async (wcId) => {
    const wc = resolveWc(wcId);
    if (!wc) return { ok: false, error: '页面已关闭', printers: [] };
    try {
      const list = await wc.getPrintersAsync();
      return {
        ok: true,
        printers: (list || []).map((p) => ({
          name: p.name,
          displayName: p.displayName || p.name,
          description: p.description || '',
          isDefault: !!p.isDefault,
          status: p.status || 0
        }))
      };
    } catch (e) {
      return { ok: false, error: '读取打印机列表失败：' + String((e && e.message) || e), printers: [] };
    }
  });

  /**
   * 打印当前页。
   *   silent=false（默认）→ 弹系统打印窗口，上面这些设置作为窗口里的初始值；
   *   silent=true          → 直接按设置出纸，不再问。
   * 返回 { ok } / { ok:false, canceled:true } / { ok:false, error }。
   */
  handle('page:print', async (wcId, opts = {}) => {
    const wc = resolveWc(wcId);
    if (!wc) return { ok: false, error: '页面已关闭' };
    const o = opts || {};
    const silent = !!o.silent;

    const ranges = parsePageRanges(o.pageRanges);
    if (ranges === false) return { ok: false, error: '页面范围格式不对，示例：1-3,5' };

    const options = {
      silent,
      printBackground: o.printBackground !== false,
      color: o.color !== false,
      landscape: !!o.landscape,
      scaleFactor: clampNum(o.scale, 10, 200, 100) / 100,
      copies: Math.round(clampNum(o.copies, 1, 99, 1)),
      collate: true,
      pageSize: printPageSize(o),
      margins: printMargins(o)
    };
    // 打印机名两种模式都带上：非静默时它只是系统窗口里的预选项（用户仍可改），
    // 不传的话用户在上面选了 A 打印机、弹出来的窗口却停在系统默认 B，很像 bug。
    if (o.deviceName) options.deviceName = String(o.deviceName);
    // 页码范围交给系统窗口自己管；静默时才由我们传（那边没有输入框）
    if (silent && ranges) options.pageRanges = ranges;
    if (o.headerFooter) {
      try { options.header = wc.getTitle() || ''; } catch { options.header = ''; }
      try { options.footer = wc.getURL() || ''; } catch { options.footer = ''; }
    }

    return await new Promise((resolve) => {
      let settled = false;
      const done = (success, reason) => {
        if (settled) return;
        settled = true;
        if (success) { resolve({ ok: true }); return; }
        const why = String(reason || '');
        // 用户在系统窗口点了取消：不是错误，界面上不该弹红字
        if (/cancel/i.test(why)) resolve({ ok: false, canceled: true });
        else resolve({ ok: false, error: '打印失败：' + (why || '未知原因') });
      };
      try {
        wc.print(options, done);
      } catch (e) {
        done(false, (e && e.message) || e);
      }
    });
  });

  /**
   * 打印设置 → printToPDF 选项。预览与「另存为 PDF」共用同一份，保证看到的就是导出的。
   *
   * 两处「同一个名字、不同规矩」的坑，别再踩：
   *   - 单位：printToPDF 的 pageSize / margins 都是**英寸**，print() 是微米 + 96dpi 像素；
   *   - 类型：printToPDF 的 pageRanges 是**字符串**（"1-3,5"），print() 要 [{from,to}]。
   * 类型传错不是「没效果」，Electron 会直接抛 `pageRanges must be a string`。
   */
  const buildPdfOptions = (o) => {
    const pdfOpts = {
      printBackground: o.printBackground !== false,
      landscape: !!o.landscape,
      scale: clampNum(o.scale, 10, 200, 100) / 100,
      pageSize: pdfPageSize(o),
      margins: pdfMargins(o)
    };
    const ranges = String(o.pageRanges || '').trim();
    if (ranges) pdfOpts.pageRanges = ranges;
    return pdfOpts;
  };

  /**
   * 打印预览：按当前设置渲染一份 PDF 到临时目录，返回 file:// 地址。
   *
   * 为什么走 printToPDF 而不是截图：预览要能看出分页、纸张比例与边距，
   * 截图只能看到当前视口那一屏，跟真正打印出来的东西差得远。
   * Electron 自带 PDF 阅读器（webview 加 plugins 属性即可），所以渲染层
   * 直接把这个文件显示出来就行，不必再引 pdf.js 这类依赖。
   */
  handle('page:print-preview', async (wcId, opts = {}) => {
    const wc = resolveWc(wcId);
    if (!wc) return { ok: false, error: '页面已关闭' };
    const o = opts || {};
    const ranges = parsePageRanges(o.pageRanges);
    if (ranges === false) return { ok: false, error: '页面范围格式不对，示例：1-3,5' };
    try {
      const data = await wc.printToPDF(buildPdfOptions(o));
      const dir = path.join(app.getPath('temp'), 'nova-print-preview');
      fs.mkdirSync(dir, { recursive: true });
      // 文件名带序号：每改一次设置就要让 <webview> 重新读一次文件。地址不变时
      // Chromium 会认成同一个资源（还可能是缓存的那份），预览就停在上一版了。
      previewSeq = (previewSeq + 1) % 1000;
      const prefix = 'preview-' + Number(wcId) + '-';
      const file = path.join(dir, prefix + previewSeq + '.pdf');
      fs.writeFileSync(file, data);
      // 写完再清旧的那几版：一次预览最多几 MB，攒着没意义。
      // 清不掉也不算失败 —— 正在被阅读器打开的文件在 Windows 上删不掉。
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f !== path.basename(file) && f.indexOf(prefix) === 0) fs.unlinkSync(path.join(dir, f));
        }
      } catch { /* 清不掉不影响这次预览 */ }
      return { ok: true, url: pathToFileURL(file).href, bytes: data.length };
    } catch (e) {
      return { ok: false, error: '预览生成失败：' + String((e && e.message) || e) };
    }
  });

  // 把当前页另存为 PDF。渲染层只给 webContents id，磁盘读写与保存框都在主进程做。
  // opts 与打印共用一份（纸张 / 边距 / 方向 / 缩放），不带时按默认值导出。
  handle('page:save-pdf', async (wcId, opts = {}) => {
    const wc = resolveWc(wcId);
    if (!wc || wc.isDestroyed()) return { ok: false, error: '页面已关闭' };
    const o = opts || {};
    const ranges = parsePageRanges(o.pageRanges);
    if (ranges === false) return { ok: false, error: '页面范围格式不对，示例：1-3,5' };
    let name = '页面';
    try { name = wc.getTitle() || name; } catch { /* 拿不到标题就用默认名 */ }
    name = String(name).replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || '页面';
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: '另存为 PDF',
      defaultPath: path.join(app.getPath('downloads'), name + '.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    try {
      const data = await wc.printToPDF(buildPdfOptions(o));
      fs.writeFileSync(picked.filePath, data);
      return { ok: true, path: picked.filePath };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  handle('shell:copy', (text) => { clipboard.writeText(String(text == null ? '' : text)); return true; });
  /* 本地生成二维码（分享到微信/朋友圈等桌面无 API 的 App 时，用扫码桥接）。
   * 为什么放主进程：qrcode 是 Node 库，渲染层 contextIsolation 下 require 不到；
   * 而且本地生成不把网址泄露给第三方二维码服务。返回 PNG dataURL。 */
  handle('shell:qrcode', async (text) => {
    const s = String(text == null ? '' : text).slice(0, 2048);
    if (!s) return { error: '没有内容可生成二维码' };
    try {
      const dataUrl = await QRCode.toDataURL(s, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
      return { ok: true, dataUrl };
    } catch (e) {
      return { error: '生成二维码失败：' + String(e && e.message || e) };
    }
  });
  handle('shell:show-item', (p) => shell.showItemInFolder(p));
  handle('app:userData', () => app.getPath('userData'));
  handle('app:open-user-data', () => shell.openPath(app.getPath('userData')));

  /* --- 登录凭证（密码）：从 Edge 导入 + 本机加密保存 ---
   * 只读 Edge（不写回）；密码用系统 safeStorage（Windows 上是 DPAPI）加密后落盘，
   * 明文只在主进程内存里短暂存在，不写日志、不联网。列表只回 origin/username。 */
  const credFile = () => path.join(app.getPath('userData'), 'credentials.json');
  const credLoad = () => {
    try {
      const j = JSON.parse(fs.readFileSync(credFile(), 'utf8'));
      return Array.isArray(j && j.items) ? j.items : [];
    } catch { return []; }
  };
  const credWrite = (items) => {
    try { fs.writeFileSync(credFile(), JSON.stringify({ items }, null, 2)); }
    catch (e) { /* 写失败由调用方从返回值体现 */ }
  };
  handle('cred:import-edge', async () => {
    if (!safeStorage.isEncryptionAvailable()) return { error: '系统加密不可用，无法安全保存密码' };
    let r;
    try { r = await creds.readEdgeLogins(); }
    catch (e) { return { error: String(e && e.message || e) }; }
    const items = credLoad();
    const seen = new Set(items.map((x) => (x.origin + '\n' + x.username).toLowerCase()));
    let added = 0, dup = 0;
    for (const c of r.items) {
      const k = (c.origin + '\n' + c.username).toLowerCase();
      if (seen.has(k)) { dup++; continue; }
      seen.add(k);
      items.push({
        id: crypto.randomUUID(),
        origin: c.origin,
        username: c.username,
        enc: safeStorage.encryptString(c.password).toString('base64'),
        ts: Date.now()
      });
      added++;
    }
    credWrite(items);
    return { ok: true, added, dup, skipped: r.skipped || 0, total: items.length };
  });
  handle('cred:list', () => credLoad().map((x) => ({ id: x.id, origin: x.origin, username: x.username })));
  handle('cred:reveal', (id) => {
    const it = credLoad().find((x) => x.id === id);
    if (!it) return { error: '没有这条记录' };
    try { return { ok: true, password: safeStorage.decryptString(Buffer.from(it.enc, 'base64')) }; }
    catch { return { error: '解密失败（可能换了 Windows 账户或系统密钥变了）' }; }
  });
  handle('cred:remove', (id) => { credWrite(credLoad().filter((x) => x.id !== id)); return { ok: true }; });
  handle('cred:clear', () => { credWrite([]); return { ok: true }; });
  // 手动添加一条（Edge 新版 v20 加密导不出来时，用户可自行录入）
  handle('cred:add', (c) => {
    if (!safeStorage.isEncryptionAvailable()) return { error: '系统加密不可用，无法安全保存密码' };
    const origin = String((c && c.origin) || '').trim();
    const username = String((c && c.username) || '').trim();
    const password = String((c && c.password) || '');
    if (!origin) return { error: '请填网站地址' };
    if (!password) return { error: '请填密码' };
    const items = credLoad();
    const dup = items.some((x) => x.origin.toLowerCase() === origin.toLowerCase() && x.username === username);
    if (dup) return { error: '这个站点 + 账号已经存过了' };
    items.push({
      id: crypto.randomUUID(), origin, username,
      enc: safeStorage.encryptString(password).toString('base64'),
      ts: Date.now()
    });
    credWrite(items);
    return { ok: true };
  });
  /**
   * 网页里提交了登录表单 → 外壳弹「保存密码？」。
   *
   * origin 由主进程从 `wc.getURL()` 取，**不接受渲染层传进来的地址**：
   * 那等于让页面自己声明自己是谁，一个 iframe 就能把密码存到别人名下。
   * 同一站点 + 同一账号再次登录时更新密码（用户改过密码后不该存着旧的）。
   */
  handle('cred:save-from-page', (wcId, username, password) => {
    if (!safeStorage.isEncryptionAvailable()) return { error: '系统加密不可用，无法安全保存密码' };
    const wc = resolveWc(wcId);
    if (!wc) return { error: '页面已关闭' };
    let origin = '';
    try {
      const u = new URL(wc.getURL());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: '这个页面不支持保存密码' };
      origin = u.origin;
    } catch { return { error: '读不到页面地址' }; }
    const user = String(username || '').trim().slice(0, 200);
    const pass = String(password || '');
    if (!pass) return { error: '没有密码可保存' };

    const items = credLoad();
    const at = items.findIndex((x) => String(x.origin).toLowerCase() === origin.toLowerCase() && x.username === user);
    const rec = {
      id: at >= 0 ? items[at].id : crypto.randomUUID(),
      origin,
      username: user,
      enc: safeStorage.encryptString(pass).toString('base64'),
      ts: Date.now()
    };
    if (at >= 0) items[at] = rec; else items.push(rec);
    credWrite(items);
    return { ok: true, updated: at >= 0, origin, username: user };
  });

  /* --- 网页区右键菜单（系统原生 Menu）---
   * 为什么用原生 Menu：<webview> 会盖在同层 DOM 之上，DOM 菜单会被网页遮住；
   * 原生菜单不受影响。菜单项按右键上下文（链接 / 选中文字 / 可编辑）动态给。 */
  ipcMain.on('webview:context-menu', (e, payload) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    const p = (payload && payload.params) || {};
    let wc = null;
    try { wc = webContents.fromId(payload.wcId); } catch { wc = null; }
    const back = (ch, arg) => { try { e.sender.send(ch, arg); } catch { /* 窗口没了 */ } };
    const short = (s) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > 16 ? t.slice(0, 16) + '…' : t; };
    const tpl = [];

    if (p.linkURL) {
      tpl.push({ label: '在新标签页打开链接', click: () => back('webview:open-url', p.linkURL) });
      tpl.push({ label: '复制链接地址', click: () => clipboard.writeText(p.linkURL) });
      tpl.push({ type: 'separator' });
    }
    if (p.selectionText && p.selectionText.trim()) {
      tpl.push({ label: '复制', click: () => { try { wc && wc.copy(); } catch { /* ignore */ } } });
      tpl.push({ label: '搜索「' + short(p.selectionText) + '」', click: () => back('webview:search', p.selectionText.trim()) });
      tpl.push({ type: 'separator' });
    }
    if (p.isEditable) {
      tpl.push({ label: '剪切', click: () => { try { wc && wc.cut(); } catch { /* ignore */ } } });
      tpl.push({ label: '粘贴', click: () => { try { wc && wc.paste(); } catch { /* ignore */ } } });
      tpl.push({ label: '全选', click: () => { try { wc && wc.selectAll(); } catch { /* ignore */ } } });
      tpl.push({ type: 'separator' });
    }
    tpl.push({ label: '后退', enabled: !!(wc && wc.canGoBack()), click: () => { try { wc && wc.goBack(); } catch { /* ignore */ } } });
    tpl.push({ label: '前进', enabled: !!(wc && wc.canGoForward()), click: () => { try { wc && wc.goForward(); } catch { /* ignore */ } } });
    tpl.push({ label: '刷新', click: () => { try { wc && wc.reload(); } catch { /* ignore */ } } });

    try { Menu.buildFromTemplate(tpl).popup({ window: win }); } catch { /* 弹不出就算了 */ }
  });

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
