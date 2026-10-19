'use strict';

/**
 * preload：把主进程能力收成一个白名单 API 暴露给外壳页面。
 * 渲染层拿不到 ipcRenderer、拿不到 Node，只能调这里列出的方法。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/* ------------------------------------------------------------------ *
 * 拖入文件的本地路径
 * ------------------------------------------------------------------ *
 * 渲染层拿不到拖进来的 File 对象的绝对路径 —— **`File.path` 这条路已经不通了**：
 * Electron 把它标记成 deprecated，随后在 32 里彻底移除；而本项目用的是 30.x，
 * 实测 `dt.files[i].path` 为 undefined，于是「拖入安装扩展」永远拿不到路径，
 * 直接被那一层 `if (p)` 过滤掉 —— **表现为「拖进去没反应/装不上」**。
 *
 * 官方给的路子是 `webUtils.getPathForFile(file)`，它**只能在 preload 里调**
 * （需要主进程的上下文），所以必须在这里透一层给渲染层。
 */
function pathForFile(file) {
  try {
    return webUtils && typeof webUtils.getPathForFile === 'function'
      ? webUtils.getPathForFile(file)
      : (file && file.path) || '';   // 老版本兜底
  } catch {
    return '';
  }
}

const EVENT_CHANNELS = [
  'settings:changed',
  'engine:changed',
  'ext:changed',
  /* 拖到**网页区域**装扩展的结果（那条路在外壳的 document.drop 之外，
     由主进程拦 file:// 导航处理，见 main.js 的 will-navigate） */
  'ext:dropped',
  'adblock:hit',
  'adblock:stats',
  'tab:title',
  'tab:favicon',
  'tab:navigated',
  'tab:loading',
  'tab:dom-ready',
  'tab:crashed',
  'app:toast',
  'tabs:open-request',
  'download:update',
  'download:taken-over',
  'sniff:found',
  'sniff:reset',
  'sniff:update',
  'sniff:state',
  'mobile:stats',
  'shell:viewport',
  /* 主进程抓到一份新的站点图标。收藏夹栏与书签列表据此重读那张表 ——
     图标是异步到的，不推的话它们会一直停在首字母上。
     注意：这个数组是**白名单**，不在里面的通道 on() 会抛异常。新加推送
     通道时两边都得改，而漏改的表现是「init 后半段整段没跑」——
     因为外壳是在 init 里注册监听的，一抛后面就全断了。
     tools/check-shell.js 的 [8] 会拿外壳里的每个 bridge.on('…') 对着
     这个数组逐一比对，专门守这件事。 */
  'favicon:updated',
  /* 内置新标签页发来的动作（加 / 删快捷方式）。页面本身是本地文件、
     上不了这座桥，它是跳一个 nova:// 地址被主进程拦下来转发的。 */
  'ntp:command',
  /* PC 自动更新的状态推送与下载进度。两个都要：前者推「发现新版 / 已下好，
     后者报百分比 —— 两者是不同节奏的事件，合成一个会在「下载中」这段时间
     反复重发整个状态，白白把更新日志刷满。 */
  'update:state',
  'update:progress',
  /* 原生右键菜单里「搜索选中文字 / 在新标签页打开链接」两条动作要回到外壳做
     （搜索开新标签、链接开新标签）。菜单在主进程弹，动作由这里转发回去。 */
  'webview:search',
  'webview:open-url',
  /* 内核桥接：原生宿主（trident host）发来的事件（frame/title/url/cursor/…）。
     渲染进程据此把帧画到标签页、同步地址与标题。 */
  'host:event'
];

const listeners = new Map();

for (const channel of EVENT_CHANNELS) {
  ipcRenderer.on(channel, (_e, payload) => {
    const set = listeners.get(channel);
    if (set) set.forEach((fn) => { try { fn(payload); } catch (err) { console.error(err); } });
  });
}

contextBridge.exposeInMainWorld('nova', {
  /* --- 基础 --- */
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  platform: process.platform,

  /* --- 设置 --- */
  settings: {
    patch: (partial) => ipcRenderer.invoke('settings:patch', partial)
  },

  /* --- 内核 --- */
  engines: {
    list: () => ipcRenderer.invoke('engine:list'),
    reResolve: (forceCompat) => ipcRenderer.invoke('engine:re-resolve', forceCompat)
  },

  /* --- 内核桥接：渲染进程 ↔ 原生宿主（trident host）--- */
  host: {
    // 发指令给宿主：create/navigate/resize/input/eval/destroy/activate/stop。
    // 返回宿主的 reply（携带 ok 与可选 result/viewId）。compat 模式下宿主没运行，返回 {ok:false}。
    cmd: (opts) => ipcRenderer.invoke('host:cmd', opts)
  },

  /* --- 广告拦截 --- */
  adblock: {
    stats: () => ipcRenderer.invoke('adblock:stats'),
    reset: () => ipcRenderer.invoke('adblock:reset'),
    sourceToggle: (id, enabled) => ipcRenderer.invoke('adblock:source:toggle', { id, enabled }),
    allowlistAdd: (host) => ipcRenderer.invoke('adblock:allowlist:add', host),
    allowlistRemove: (host) => ipcRenderer.invoke('adblock:allowlist:remove', host),
    importList: () => ipcRenderer.invoke('adblock:import-list')
  },

  /* --- 扩展 --- */
  extensions: {
    list: () => ipcRenderer.invoke('ext:list'),
    install: () => ipcRenderer.invoke('ext:install'),
    // 拖拽安装：外壳把拖进来的扩展包路径直接交来，不再弹文件框
    installPath: (p) => ipcRenderer.invoke('ext:install-path', p),
    remove: (id) => ipcRenderer.invoke('ext:remove', id),
    /** 启用 / 停用。停用是可逆的（记录还在），移除不可逆。 */
    setEnabled: (id, on) => ipcRenderer.invoke('ext:set-enabled', id, on),
    /** 列出本机其它浏览器里已装的扩展（Edge 商店取包接口已关闭，这是替代路径） */
    fromBrowser: () => ipcRenderer.invoke('ext:from-browser'),
    /** 按 key 导入一个（主进程会重新扫一次自己解析目录，不接受渲染层传路径） */
    importFromBrowser: (key) => ipcRenderer.invoke('ext:import-from-browser', key),
    // Edge 加载项商店：先查详情（让用户看清装的是什么），再取包装上。
    // 商店页上那个「获取」按钮在第三方外壳里点不动，所以绕到这两条上。
    storeInfo: (input) => ipcRenderer.invoke('ext:store-info', input),
    storeInstall: (input) => ipcRenderer.invoke('ext:store-install', input)
  },

  /* --- 书签 / 历史 --- */
  bookmarks: {
    list: () => ipcRenderer.invoke('bookmarks:list'),
    add: (bm) => ipcRenderer.invoke('bookmarks:add', bm),
    remove: (url) => ipcRenderer.invoke('bookmarks:remove', url),
    clear: () => ipcRenderer.invoke('bookmarks:clear'),
    /** 导入：文件挑选用主进程的对话框，渲染层不碰文件系统 */
    import: () => ipcRenderer.invoke('bookmarks:import'),
    /** 导出：同上 */
    export: () => ipcRenderer.invoke('bookmarks:export'),
    /** 列出本机装了哪些浏览器（检测只看文件在不在，不读内容） */
    browsers: () => ipcRenderer.invoke('bookmarks:browsers'),
    /** 从某个已检测到的浏览器直接读书签 */
    fromBrowser: (id) => ipcRenderer.invoke('bookmarks:from-browser', id)
  },
  history: {
    list: (limit) => ipcRenderer.invoke('history:list', limit),
    clear: () => ipcRenderer.invoke('history:clear')
  },

  /* --- 内置新标签页的快捷方式 --- */
  ntp: {
    addShortcut: (label, url) => ipcRenderer.invoke('ntp:shortcut:add', { label, url }),
    removeShortcut: (url) => ipcRenderer.invoke('ntp:shortcut:remove', { url })
  },

  /* --- 磁贴图标（收藏夹栏 / 书签列表用；新标签页由主进程直接注入，不走这里） --- */
  favicons: {
    json: (hosts) => ipcRenderer.invoke('favicon:json', hosts)
  },

  /* --- 自动更新（PC） ---
     四个动作都是「问主进程」，主进程把状态经update:state 推回来。
     刻意不给渲染层任何「自己发起下载」的能力：下载要走差分，
     而差分逻辑在 electron-updater 那边，放到渲染层等于让它能随意指定
     下载地址 —— 那是更新链路上最不该松的一环。 */
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    status: () => ipcRenderer.invoke('update:status'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install')
  },

  /* --- 下载（Nova 多线程引擎） --- */
  downloads: {
    list: () => ipcRenderer.invoke('download:list'),
    stats: () => ipcRenderer.invoke('download:stats'),
    create: (opts) => ipcRenderer.invoke('download:new', opts),
    pause: (id) => ipcRenderer.invoke('download:pause', id),
    resume: (id) => ipcRenderer.invoke('download:resume', id),
    cancel: (id) => ipcRenderer.invoke('download:cancel', id),
    remove: (id) => ipcRenderer.invoke('download:remove', id),
    retry: (id) => ipcRenderer.invoke('download:retry', id),
    clearFinished: () => ipcRenderer.invoke('download:clear-finished'),
    open: (p) => ipcRenderer.invoke('download:open', p),
    showInFolder: (p) => ipcRenderer.invoke('download:show', p),
    chooseDir: () => ipcRenderer.invoke('download:choose-dir'),
    dir: () => ipcRenderer.invoke('download:dir')
  },

  /* --- 媒体嗅探（页面里的音视频资源） --- */
  sniffer: {
    list: (filter) => ipcRenderer.invoke('sniff:list', filter),
    stats: (filter) => ipcRenderer.invoke('sniff:stats', filter),
    clear: (filter) => ipcRenderer.invoke('sniff:clear', filter),
    resetStats: () => ipcRenderer.invoke('sniff:reset-stats'),
    setMeta: (id, meta) => ipcRenderer.invoke('sniff:meta', { id, meta }),
    formats: () => ipcRenderer.invoke('sniff:formats')
  },

  /* --- 移动端阅读（无图模式） --- */
  mobile: {
    state: (wcId) => ipcRenderer.invoke('mobile:state', wcId),
    stats: (wcId) => ipcRenderer.invoke('mobile:stats', wcId),
    /** 放行当前标签页的所有图片；调用方负责随后的重载 */
    showImages: (wcId) => ipcRenderer.invoke('mobile:show-images', wcId),
    resetStats: () => ipcRenderer.invoke('mobile:reset-stats')
  },

  /* --- 系统 --- */
  system: {
    /** 拖进来的文件 → 本地绝对路径。见文件头 pathForFile 的说明。
     *  渲染层拿不到 File.path，只能问这里要。 */
    pathForFile,
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
    showItemInFolder: (p) => ipcRenderer.invoke('shell:show-item', p),
    userDataPath: () => ipcRenderer.invoke('app:userData'),
    openUserData: () => ipcRenderer.invoke('app:open-user-data'),
    clearSiteData: () => ipcRenderer.invoke('app:clear-site-data'),
    /** 复制走主进程的剪贴板 —— 比渲染层的 navigator.clipboard 稳，
     *  后者在 file:// 下不算安全上下文，会直接抛异常 */
    copy: (text) => ipcRenderer.invoke('shell:copy', text),
    /** 本地生成二维码 PNG（dataURL）—— 分享到桌面无 API 的 App 时扫码桥接 */
    qrcode: (text) => ipcRenderer.invoke('shell:qrcode', text)
  },

  /* --- 登录凭证（密码）：从 Edge 导入 + 本机加密保存 --- */
  // 只读 Edge 的登录数据、本地解密，密码由主进程用系统 safeStorage 加密落盘。
  // 列表只回 origin/username；取明文要单独调 reveal。
  credentials: {
    importEdge: () => ipcRenderer.invoke('cred:import-edge'),
    add: (c) => ipcRenderer.invoke('cred:add', c),
    list: () => ipcRenderer.invoke('cred:list'),
    reveal: (id) => ipcRenderer.invoke('cred:reveal', id),
    remove: (id) => ipcRenderer.invoke('cred:remove', id),
    clear: () => ipcRenderer.invoke('cred:clear')
  },

  /* --- 网页区交互（右键菜单等）--- */
  // 右键菜单交给主进程用系统原生 Menu 弹（原生菜单能盖在 <webview> 之上，
  // DOM 菜单会被 webview 盖住）。payload = { params, wcId }。
  webview: {
    contextMenu: (payload) => ipcRenderer.send('webview:context-menu', payload)
  },

  /* --- AI 助手（API 集成）--- */
  // 内嵌网页对话会被一些 AI 站点识别成「环境异常」而拒绝渲染，所以改走 API：
  // 渲染层只收集 base/key/model 与对话，真正的 HTTP 请求在主进程发（避开 CORS，
  // 也不把密钥暴露给页面上下文）。cfg = { base, key, model, messages:[{role,content}] }
  ai: {
    chat: (cfg) => ipcRenderer.invoke('ai:chat', cfg)
  },

  window: {
    minimize: () => ipcRenderer.send('window:control', 'minimize'),
    maximize: () => ipcRenderer.send('window:control', 'maximize'),
    close: () => ipcRenderer.send('window:control', 'close')
  },

  /* --- 事件 --- */
  on(channel, fn) {
    if (!EVENT_CHANNELS.includes(channel)) throw new Error('未授权的事件通道: ' + channel);
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return () => listeners.get(channel).delete(fn);
  },

  log: (msg) => ipcRenderer.send('debug:log', msg)
});
