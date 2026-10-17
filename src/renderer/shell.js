'use strict';

/**
 * Nova 浏览器 · 外壳逻辑
 * ---------------------------------------------------------------------------
 * 单一渲染层同时承载 PC 与移动端：布局由 [data-layout] 决定（desktop | mobile），
 * 由视口宽度 × 用户设置推导。内核切换是每个标签页的属性，切内核即按新内核
 * 重建该标签页的 <webview>（换 partition / UA / 垫片），URL 保持不变。
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const bridge = window.nova;

/**
 * 地址栏空着时那句提示，**开脚本时从 HTML 里抄一次**。
 *
 * 不在 JS 里再写一份字符串：写两份就等于两处都得记得改。也不能等第一次
 * 用到时才抄 —— 停在内置新标签页上时这一格会被换成「新标签页」，
 * 那时再抄下来的就是那个临时值，切回普通页面后提示语永远变成「新标签页」。
 * （脚本在 body 末尾，这里拿得到 #omni-input。）
 */
const OMNI_DEFAULT_PLACEHOLDER = (() => {
  const el = document.getElementById('omni-input');
  return el ? (el.placeholder || '') : '';
})();

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

const state = {
  engines: [],
  engineMap: new Map(),
  settings: {},
  /**
   * 内置新标签页那个本地文件的地址，由主进程随 bootstrap 下发。
   * 之所以不让外壳自己拼：Windows 的盘符、路径里的空格与中文都要转义，
   * 而主进程那边有 pathToFileURL 这个现成的正确实现（见 NEWTAB_FILE_URL）。
   */
  newTabFileUrl: '',
  /** 出厂默认值，由主进程随 bootstrap 下发，供「恢复默认设置」使用 */
  defaults: null,
  extensions: [],
  /**
   * 扩展商店那一块的状态。
   *
   * draft 必须存在这里而不是只放在输入框的 DOM 值上：这个分区会因为各种推送
   * （下载进度、嗅探命中、扩展列表变化）整体重绘，重绘一发生输入框就是新的，
   * 用户刚粘进去的地址会没。与下载页的 dlDraft 同一个道理。
   */
  extStore: { draft: '', busy: false, detail: null, error: '' },
  bookmarks: [],
  /**
   * 站点图标表：主机名 → data: URI。由主进程按站点抓取并落盘（见
   * src/main/favicon-cache.js），外壳启动时问一次、书签变动后再问一次。
   * 新标签页磁贴读的是同一份缓存，只是那份由主进程直接注进页面。
   */
  hostIcons: {},
  adblock: { blocked: 0, rules: {}, top: [], enabled: true },
  allowlist: [],
  tabs: [],
  activeId: null,
  seq: 0,
  layout: 'desktop',
  panel: null,
  /** 设置页当前分区 */
  settingsSection: 'general',
  /** 设置页里走过的分区，栈顶就是当前页 —— 给左上角那个返回箭头用 */
  settingsTrail: [],
  userDataPath: '',
  hitCounter: 0,
  downloads: [],
  /** { active, done, error, queued, speed, total } —— 由主进程聚合 */
  downloadStats: null,
  /** 当前下载目录（空字符串表示系统默认） */
  downloadsDir: '',
  /** 新建下载输入框的草稿 —— 重渲染时不能把用户正在敲的地址弄丢 */
  dlDraft: '',
  /**
   * 嗅探到的媒体资源，按 webContentsId 分组。
   * 注意这里的分组键是主进程的 webContents.id，不是 state.tabs 里那个自增 id ——
   * 两者毫无关系，靠 <webview>.getWebContentsId() 建立映射（见 mountTab）。
   */
  sniffByWc: new Map(),
  /** 格式注册表规模，由主进程下发 */
  sniffFormats: null,
  /** 嗅探统计（主进程聚合） */
  sniffStats: null,
  /** 已展开内联预览的资源 id */
  sniffPreview: null,
  /** 展开/收起分片列表 */
  sniffShowSegments: false,
  /** 无图模式快照：档位、类型、全局拦截数、当前标签页拦截数 */
  noMedia: null,
  /** 无图占位样式与作用域类注入脚本，由主进程下发 —— 一处定义，两边不各写一份 */
  noImageCss: '',
  noImageJs: '',
  /** 当前页自动拼页状态（由页面内脚本回读，见 readAutoPageStatus） */
  autoPageStatus: null,
  isPreview: !!bridge.isPreview,
  /** AI 面板：发送时若 webview 还没在目标对话页，先把内容暂存，载入完成后注入 */
  aiPending: ''
};

const MOBILE_BREAKPOINT = 640;

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.remove('is-show');
    setTimeout(() => { el.hidden = true; }, 220);
  }, ms);
}

/** 千分位数字 —— 规则数以十万计时可读性很重要 */
/**
 * ISO 时间戳 → 「今天 15:42」/「10 月 14 日 15:42」这样的本地化短串。
 *
 * <p>刻意用**本地时区**而不是截 ISO 字符串：update.lastCheckAt 存的是
 * UTC，截出来的时间会比用户看到的钟点差几个小时，而「上次检查」这句话
 * 的全部意义就是让人知道「我刚才那次检查是什么时候」。
 *
 * <p>今天的不写日期 —— 「今天 15:42」比「10 月 15 日 15:42」更贴近
 * 「刚才那次」的语感。跨天才补日期，年份与当前不同则连年一起写。
 */
function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `今天 ${hm}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const md = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return sameYear ? `${md} ${hm}` : `${d.getFullYear()} 年 ${md} ${hm}`;
}

function fmtNum(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function prettyUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.pathname === '/' && !u.search && !u.hash) return u.hostname;
    return u.hostname + u.pathname + u.search + u.hash;
  } catch { return url; }
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  return `${Math.floor(d / 86400000)} 天前`;
}

function searchUrl(q) {
  const tpl = state.settings.searchTemplate || 'https://www.baidu.com/s?wd=%s';
  return tpl.replace('%s', encodeURIComponent(q));
}

/**
 * 这个地址是不是内置新标签页（含带参数的形式）。
 *
 * 与安卓端 NewTab.isNewTab 同一个角色。地址栏显示、命令回来之后的重载
 * 都要问它 —— 少了这一道，用户点一下 × 就会把当前标签页从「某个网页」
 * 强行导航回新标签页。
 */
function isNewTabUrl(url) {
  return !!url && !!state.newTabFileUrl && url.indexOf(state.newTabFileUrl) === 0;
}

/**
 * 恢复会话时，快照里的这个地址该还原成什么。
 *
 * 内置新标签页是个例外：它地址里那串 data 是**上次算好的候选**，照原样恢复的话，
 * 这次启动看到的还是那时候的历史与「已移除」清单 —— 用户刚点掉的站点照旧出现、
 * 候选不足时补上的那几个内置入口也不会来（表现就是「六宫格变回两格」）。
 * 它的入参本来就是当下的状态，重新算一次才是它该有的样子。
 *
 * 其余地址一律原样返回：会话恢复的承诺就是「把上次那几页还给你」。
 */
function restoreUrlFor(snapshotUrl) {
  return isNewTabUrl(snapshotUrl) ? newTabUrl() : snapshotUrl;
}

/**
 * 新标签页的候选：用户自己加的 + 历史里的常去站点。
 *
 * 排序、去重、上限、截断全在 ntp.js 里（那一段能单独跑单测），这里只负责
 * 把三个来源凑齐。history 直接在 settings 里 —— 主进程 bootstrap 下发的
 * 就是整份配置。
 */
function newTabCandidates() {
  const s = state.settings || {};
  const sc = s.ntpShortcuts || {};
  return NovaNtpHost.buildData({
    added: sc.added,
    removed: sc.removed,
    history: s.history
  });
}

/**
 * 新建标签页打开的地址。
 *
 * 三种具名取值（内置 / 主页 / 空白）之外的值当**自定义地址**：这个键在
 * 桌面端历史上就是一个自由地址，升级过来的人不该被悄悄改掉自己的设置。
 * 语义与移动端 NovaSettings.newTabPage 对齐。
 */
function newTabUrl() {
  const s = state.settings || {};
  const u = NovaNtpHost.target(s.newTabPage, {
    homepage: s.homepage,
    base: state.newTabFileUrl,
    // 用界面上实际的深浅色而不是设置项：主题只认 light/dark 两档，
    // 而这里要的是「现在是什么色」，两者在跟随系统时可能差一步。
    theme: document.documentElement.dataset.theme || s.theme || 'light',
    data: newTabCandidates()
  });
  // 只有内置（本地 newtab.html）这一档才挂 store=1：让页面在 PC 端显示
  // 「插件商店」入口。移动端不挂这个参数（需求只针对 PC），共享页面靠这个
  // 开关决定显隐 —— 既满足「PC 新标签页加插件商店链接」，又不牵动手机端。
  if (state.newTabFileUrl && u.indexOf(state.newTabFileUrl) === 0) {
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'store=1';
  }
  return u;
}

/** 「新标签页」当前档位的中文说法，给设置页那一行用。 */
function ntpModeLabel() {
  const s = state.settings || {};
  const mode = NovaNtpHost.modeOf(s.newTabPage);
  if (mode === 'start') return '内置页';
  if (mode === 'blank') return '空白页';
  if (mode === 'homepage') return '跟随主页';
  // 自定义地址，但填的恰好就是主页 —— 说「跟随主页」比说「自定义地址」
  // 更贴近用户看到的行为，也和「与主页相同」那个按钮的置灰状态一致。
  return (s.newTabPage || s.homepage) === s.homepage ? '跟随主页' : '自定义地址';
}

/**
 * 切「新标签页」那一档。三个具名取值都走这里，免得三处各写一遍 patch。
 *
 * 切完必须 refreshCurrent()：设置页那一行的高亮、旁边那句「当前：…」都
 * 依赖 settings，不重渲染就还是旧样子 —— 看起来就是「点了没反应」。
 */
async function setNtpMode(mode) {
  state.settings.newTabPage = mode;
  await bridge.settings.patch({ newTabPage: mode });
  refreshCurrent();
  toast('新标签页：' + ntpModeLabel());
}

/** 输入框内容 → 真实 URL：像域名的当地址，否则当搜索词 */
function resolveInput(raw) {
  const q = raw.trim();
  if (!q) return null;
  if (/^(https?|file|about|chrome|edge):/i.test(q)) return q;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/i.test(q) || /^localhost(:\d+)?/i.test(q)) {
    return 'https://' + q;
  }
  return searchUrl(q);
}

/* ------------------------------------------------------------------ *
 * 内核
 * ------------------------------------------------------------------ */

function engine(id) {
  return state.engineMap.get(id) || state.engineMap.get('chromium') || state.engines[0];
}

/** 内核下拉里的一项 */
function engineMenuItem(e, activeId) {
  const on = e.id === activeId;
  return `
    <button class="em-item ${on ? 'is-active' : ''}" data-engine="${e.id}"
            style="--engine-color:${e.accent}" role="menuitemradio" aria-checked="${on}"
            title="${esc(e.label)} · ${esc(e.modeLabel)}&#10;${esc(e.notes)}">
      <span class="em-dot"></span>
      <span class="em-main">
        <span class="em-name">
          ${esc(e.label)}
          <span class="mode-pill mode-${e.mode}">${esc(e.modeLabel)}</span>
        </span>
        <span class="em-sub">${esc(e.vendor)} · ${esc(e.short)} · ${esc(e.partition)}</span>
      </span>
      <span class="em-check">
        <svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-6.5" /></svg>
      </span>
    </button>`;
}

function renderEngineSwitch() {
  const tab = activeTab();
  const activeId = (tab && tab.engineId) || state.settings.defaultEngine;

  // 地址栏右侧的下拉菜单
  const list = $('#engine-menu-list');
  list.innerHTML = state.engines.map((e) => engineMenuItem(e, activeId)).join('');
  list.querySelectorAll('.em-item').forEach((b) => {
    b.addEventListener('click', () => {
      switchEngine(state.activeId, b.dataset.engine);
      closeEngineMenu();
    });
  });

  // 移动端底部弹层
  const cards = $('#engine-cards');
  cards.innerHTML = state.engines.map((e) => `
    <button class="engine-card" data-engine="${e.id}" style="--engine-color:${e.accent}">
      <span class="engine-card-dot"></span>
      <span class="engine-card-main">
        <span class="engine-card-name">${esc(e.label)}</span>
        <span class="engine-card-sub">${esc(e.vendor)} · ${esc(e.modeLabel)}</span>
      </span>
    </button>
  `).join('');
  cards.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      switchEngine(state.activeId, b.dataset.engine);
      closeSheet();
    });
  });
}

function syncEngineUi() {
  const tab = activeTab();
  const id = tab ? tab.engineId : state.settings.defaultEngine;
  const e = engine(id);

  $$('#engine-menu-list .em-item').forEach((b) => {
    const on = b.dataset.engine === id;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', String(on));
  });
  $$('#engine-cards .engine-card').forEach((c) => {
    c.classList.toggle('is-active', c.dataset.engine === id);
  });

  const badge = $('#omni-engine');
  badge.style.setProperty('--engine-color', e.accent);
  badge.classList.toggle('is-compat', e.mode === 'compat');
  $('#omni-engine-short').textContent = e.short;
  $('#brand-tag').textContent = `${e.label} · ${e.modeLabel}`;
  $('#mb-engine-label').textContent = e.label;
}

function engineNotice(engineId) {
  const e = engine(engineId);
  const bar = $('#engine-notice');
  if (e.mode === 'native') {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  $('#engine-notice-text').textContent =
    `${e.label}：${e.modeLabel}。${e.fallbackReason || e.notes} 换成原生内核后即可获得真实内核行为。`;
}

/* ---- 地址栏右侧的内核选择器 ---- */

function openEngineMenu() {
  // 移动端空间不够，走底部分层
  if (state.layout === 'mobile') { openSheet(); return; }
  syncEngineUi();
  $('#engine-menu').hidden = false;
  $('#omni-engine').setAttribute('aria-expanded', 'true');
}

function closeEngineMenu() {
  const menu = $('#engine-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $('#omni-engine').setAttribute('aria-expanded', 'false');
}

function toggleEngineMenu() {
  if (state.layout === 'mobile') { openSheet(); return; }
  if ($('#engine-menu').hidden) openEngineMenu();
  else closeEngineMenu();
}

/* ------------------------------------------------------------------ *
 * 标签页
 * ------------------------------------------------------------------ */

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

function createTab(url, engineId, { activate = true } = {}) {
  const id = ++state.seq;
  const engineKey = engineId || state.settings.defaultEngine || 'chromium';
  const tab = {
    id,
    engineId: engineKey,
    url: url || state.settings.homepage,
    title: '新标签页',
    favicon: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    webview: null,
    crashed: false
  };

  state.tabs.push(tab);
  mountTab(tab);
  if (activate) activateTab(id);
  else renderTabstrip();
  persistSession();
  return tab;
}

/** 按标签页当前内核属性创建渲染载体 */
function mountTab(tab) {
  const host = $('#viewport');
  const e = engine(tab.engineId);

  // UI 预览模式（非 Electron 环境）：不创建真实 webview，只画一个同构的占位面板
  if (state.isPreview) {
    const pane = document.createElement('div');
    pane.className = 'preview-pane';
    pane.dataset.tabId = String(tab.id);
    pane.style.setProperty('--engine-color', e.accent);
    pane.innerHTML = `
      <div class="preview-bar">
        <span class="pb-pill">${esc(e.short)} · ${esc(e.modeLabel)}</span>
        <span>${esc(tab.url)}</span>
      </div>
      <div class="preview-body">
        <div>
          <h3>${esc(hostOf(tab.url) || '目标是本地页面')}</h3>
          <p>
            UI 预览模式：真实运行时这里嵌的是 ${esc(e.label)} 内核的页面视图。<br />
            内核：${esc(e.label)}（${esc(e.modeLabel)}）· 隔离分区 ${esc(e.partition)}<br />
            广告拦截：内置清单 ${state.adblock.rules.network || 0} 条网络规则 + ${state.adblock.rules.cosmetic || 0} 条隐藏规则
          </p>
        </div>
      </div>`;
    host.appendChild(pane);
    tab.webview = pane;
    // 预览模式没有真实 webContents，用标签页自增 id 顶替，
    // 好让 mock 里按 tabId 分组的嗅探数据能对上号
    tab.wcId = tab.id;
    renderTabstrip();
    renderTabGrid();
    return;
  }

  const wv = document.createElement('webview');
  wv.setAttribute('src', tab.url);
  wv.setAttribute('partition', e.partition);
  wv.setAttribute('useragent', e.userAgent);
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no, sandbox=yes');
  wv.dataset.tabId = String(tab.id);
  wv.hidden = true;

  wv.addEventListener('did-start-loading', () => {
    // 新一轮加载开始 → 清掉上次的失败状态（重试/换网址时错误页要收起来）
    tab.loadError = null;
    if (activeTab() && activeTab().id === tab.id) renderPageError();
    tab.loading = true; renderTabstrip(); syncNavButtons();
  });
  wv.addEventListener('did-stop-loading', () => { tab.loading = false; renderTabstrip(); syncNavButtons(); });
  wv.addEventListener('did-navigate', (ev) => {
    tab.url = ev.url;
    syncOmnibox();
    renderTabGrid();
    // 网页里点链接跳转走的是这条事件，不经过外壳的 navigate()。
    // 「仅新标签页」档位下，从新标签页上一跳走就得把这行收起来。
    syncBookmarkBar();
    persistSession();
  });
  wv.addEventListener('did-navigate-in-page', (ev) => {
    if (ev.isMainFrame) { tab.url = ev.url; syncOmnibox(); persistSession(); }
  });
  wv.addEventListener('page-title-updated', (ev) => {
    tab.title = ev.title || tab.title;
    renderTabstrip();
    renderTabGrid();
  });
  wv.addEventListener('page-favicon-updated', (ev) => {
    tab.favicon = (ev.favicons && ev.favicons[0]) || null;
    renderTabstrip();
  });
  wv.addEventListener('new-window', (ev) => {
    createTab(ev.url, tab.engineId, { activate: !ev.disposition || ev.disposition === 'foreground-tab' });
  });
  wv.addEventListener('crashed', () => { tab.crashed = true; renderTabstrip(); });
  // 网页加载失败 → 显示「无法打开此网页」提示页（此前是空白）。
  // errorCode -3 是 ERR_ABORTED（被新导航/主动中断取消），不算真的失败。
  wv.addEventListener('did-fail-load', (ev) => {
    if (ev.errorCode === -3) return;
    if (ev.isMainFrame === false) return;
    tab.loadError = { code: ev.errorCode, desc: ev.errorDescription || '', url: ev.validatedURL || tab.url };
    if (activeTab() && activeTab().id === tab.id) renderPageError();
  });
  wv.addEventListener('dom-ready', () => {
    syncNavButtons();
    // 建立「标签页 ↔ webContents」的映射：主进程的嗅探结果按 webContents id 分组，
    // 而 state.tabs 里那个 id 是自增序号，两者没有任何对应关系，只能这里问出来。
    try { tab.wcId = wv.getWebContentsId(); } catch { /* 拿不到就留空，界面上会提示等待就绪 */ }
    // 自动拼页要等页面 DOM 就位才能找正文容器和下一页，所以挂在这一步
    injectAutoPage(tab);
  });

  host.appendChild(wv);
  tab.webview = wv;
  // 尽早拿一次：媒体请求可能比 dom-ready 还早，晚拿会漏掉开头几条
  try { tab.wcId = wv.getWebContentsId(); } catch { /* 同上 */ }
  renderTabstrip();
  renderTabGrid();
}

function destroyTab(tab) {
  if (tab.webview && tab.webview.parentNode) tab.webview.parentNode.removeChild(tab.webview);
  tab.webview = null;
  // 标签页没了，它嗅到的资源也一并释放（主进程侧销毁 webContents 时同样会清）
  if (tab.wcId != null) state.sniffByWc.delete(tab.wcId);
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const [tab] = state.tabs.splice(idx, 1);
  destroyTab(tab);

  if (state.tabs.length === 0) {
    state.activeId = null;
    createTab(newTabUrl(), state.settings.defaultEngine);
    return;
  }
  if (state.activeId === id) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    activateTab(next.id);
  } else {
    renderTabstrip();
    renderTabGrid();
  }
  persistSession();
}

function activateTab(id) {
  state.activeId = id;
  for (const t of state.tabs) {
    if (t.webview) t.webview.hidden = t.id !== id;
  }
  renderTabstrip();
  renderTabGrid();
  syncOmnibox();
  syncNavButtons();
  syncEngineUi();
  engineNotice(activeTab().engineId);
  // 嗅探角标是「当前页」的口径，切标签页必须跟着变
  syncSniffBadge();
  // 收藏夹栏在「仅新标签页」档位下的显隐同样跟当前页走
  syncBookmarkBar();
  // 切到的这一页如果是加载失败状态，错误页要跟着显示/收起
  renderPageError();
  persistSession();
}

/** 把 electron 的 errorCode 翻成人话；没有映射就退回原始描述。 */
function pageErrorReason(err) {
  const map = {
    '-105': '找不到服务器（域名解析失败）',
    '-137': '找不到服务器',
    '-106': '网络未连接',
    '-102': '连接被拒绝',
    '-118': '连接超时',
    '-7': '连接超时',
    '-107': 'SSL 证书或协议错误',
    '-109': '服务器无法访问',
    '-2': '加载失败'
  };
  const m = map[String(err && err.code)];
  const d = err && err.desc ? '（' + err.desc + '）' : '';
  return m ? m + d : (err && err.desc) || '请检查网址或网络后重试';
}

/** 显示/收起「无法打开此网页」提示页（口径=当前标签页的 loadError）。 */
function renderPageError() {
  const el = $('#page-error');
  if (!el) return;
  const t = activeTab();
  const err = t && t.loadError;
  if (!err) {
    el.hidden = true;
    // 恢复当前标签页的 webview（它才是页面内容的载体）
    if (t && t.webview) t.webview.hidden = false;
    return;
  }
  const urlEl = $('#pe-url'), reasonEl = $('#pe-reason');
  if (urlEl) urlEl.textContent = err.url || (t && t.url) || '';
  if (reasonEl) reasonEl.textContent = pageErrorReason(err);
  el.hidden = false;
  // 关键：<webview> 会盖在同层 DOM 之上，不藏起来的话错误页会被压在下面（又是空白）。
  // 失败页本来就是空/白的，把承载它的 webview 藏起来正好让提示页露出来。
  if (t && t.webview) t.webview.hidden = true;
}

function navigate(id, url) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab || !url) return;
  tab.url = url;
  if (tab.webview) {
    if (typeof tab.webview.loadURL === 'function') tab.webview.loadURL(url);
    else tab.webview.setAttribute('src', url);
  }
  syncOmnibox();
  // 从新标签页跳到某个网页（或反过来）时，「仅新标签页」档位要跟着收放
  syncBookmarkBar();
  persistSession();
}

/** 切内核：保留 URL 与原分区状态，按新内核重建渲染载体 */
function switchEngine(tabId, engineId) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) { toast('还没有打开的标签页'); return; }
  if (tab.engineId === engineId) return;

  const from = engine(tab.engineId);
  const to = engine(engineId);
  const url = tab.url;

  destroyTab(tab);
  tab.engineId = engineId;
  tab.crashed = false;
  mountTab(tab);
  tab.url = url;
  if (tab.webview) {
    if (typeof tab.webview.loadURL === 'function') tab.webview.loadURL(url);
    else tab.webview.setAttribute('src', url);
  }
  if (tab.id === state.activeId) {
    for (const t of state.tabs) if (t.webview) t.webview.hidden = t.id !== tab.id;
  }
  syncEngineUi();
  engineNotice(engineId);
  toast(`已切换到 ${to.label}（${to.modeLabel}），从 ${from.label} 换出`);
}

/* ------------------------------------------------------------------ *
 * 会话快照（供「恢复上次会话」用）
 * ------------------------------------------------------------------ */

let sessionTimer = null;

/**
 * 把当前标签页集合写进设置。防抖 400ms —— 导航会连续触发，
 * 没必要每次跳转都落一次盘。
 */
function persistSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    const tabs = state.tabs.map((t) => ({ url: t.url, engineId: t.engineId }));
    const activeIndex = Math.max(0, state.tabs.findIndex((t) => t.id === state.activeId));
    state.settings.session = { tabs, activeIndex };
    try {
      const r = bridge.settings.patch({ session: { tabs, activeIndex } });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* 预览桩不会抛，忽略 */ }
  }, 400);
}

/* ------------------------------------------------------------------ *
 * 渲染：标签条 / 标签总览
 * ------------------------------------------------------------------ */

function renderTabstrip() {
  const box = $('#tabs');
  box.innerHTML = state.tabs.map((t) => {
    const e = engine(t.engineId);
    const fav = t.favicon
      ? `<img src="${esc(t.favicon)}" alt="" onerror="this.remove()" />`
      : (hostOf(t.url) || 'N').slice(0, 1).toUpperCase();
    return `
      <div class="tab ${t.id === state.activeId ? 'is-active' : ''}" data-tab="${t.id}"
           style="--tab-accent:${e.accent}" title="${esc(t.title)}&#10;${esc(t.url)}">
        ${t.loading ? '<span class="tab-spinner"></span>' : `<span class="tab-favicon">${fav}</span>`}
        <span class="tab-title">${esc(t.title)}</span>
        <span class="tab-engine">${esc(e.short)}</span>
        <button class="tab-close" data-close="${t.id}" title="关闭标签页">
          <svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" /></svg>
        </button>
      </div>`;
  }).join('');

  box.querySelectorAll('.tab').forEach((el) => {
    el.addEventListener('mousedown', (ev) => {
      if (ev.button === 1) { closeTab(Number(el.dataset.tab)); return; }
      if (ev.target.closest('[data-close]')) return;
      activateTab(Number(el.dataset.tab));
    });
  });
  box.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', (ev) => { ev.stopPropagation(); closeTab(Number(b.dataset.close)); });
  });

  $('#mb-tab-count').textContent = String(state.tabs.length);
  $('#tg-count').textContent = String(state.tabs.length);
}

function renderTabGrid() {
  const list = $('#tg-list');
  list.innerHTML = state.tabs.map((t) => {
    const e = engine(t.engineId);
    return `
      <div class="tg-card ${t.id === state.activeId ? 'is-active' : ''}" data-tab="${t.id}"
           style="--tab-accent:${e.accent}">
        <button class="tg-card-close" data-close="${t.id}" title="关闭">
          <svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" /></svg>
        </button>
        <div class="tg-card-top">
          <span class="engine-card-dot" style="--engine-color:${e.accent}"></span>
          <span class="tg-card-title">${esc(t.title)}</span>
        </div>
        <div class="tg-card-url">${esc(prettyUrl(t.url))}</div>
        <div class="tab-engine" style="--tab-accent:${e.accent}; align-self:flex-start">${esc(e.label)}</div>
      </div>`;
  }).join('');

  list.querySelectorAll('.tg-card').forEach((c) => {
    c.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-close]')) {
        closeTab(Number(ev.target.closest('[data-close]').dataset.close));
        return;
      }
      activateTab(Number(c.dataset.tab));
      closeTabGrid();
    });
  });
}

/* ------------------------------------------------------------------ *
 * 地址栏 / 导航
 * ------------------------------------------------------------------ */

/**
 * 地址栏右端的星标：实心 = 当前页已在书签里。
 *
 * 单独成函数是因为「书签变了」有两条来路 —— 切标签页（走 syncOmnibox）
 * 和删书签（走 refreshCurrent）。原先只有点星标那一下会点亮它，
 * 于是从收藏夹栏右键移出一条之后，实心还挂在地址栏上。
 */
function syncStarButton() {
  const star = $('#omni-star');
  if (!star) return;
  const tab = activeTab();
  const marked = !!tab && (state.bookmarks || []).some((b) => b.url === tab.url);
  star.classList.toggle('is-on', marked);
  star.title = marked ? '已在书签里' : '加入书签';
}

function syncOmnibox() {
  const tab = activeTab();
  const input = $('#omni-input');

  // 星标跟地址栏里那串文字无关，所以放在下面那个 early return 之前 ——
  // 用户正聚焦在地址栏里打字时，切标签页同样该把星标刷对。
  syncStarButton();

  if (document.activeElement === input) return;
  // 内置新标签页的真身是一条 file:///…/newtab.html?theme=…&data=… 的地址，
  // data 里塞着最多 30 条候选，能有好几 KB —— 直接摊在地址栏里既长又吓人，
  // 显示成「新标签页」。
  //
  // 走 placeholder 而不是 value：写成 value 的话，用户点亮地址栏（会全选）
  // 直接敲回车，敲出去的就是「新标签页」四个字，会被当成搜索词送出去。
  // 空 value + placeholder 则与初始状态一致，用户看到的就是一个待输入的框。
  // 与移动端 syncUrlBar 是同一条处理。
  if (tab && isNewTabUrl(tab.url)) {
    input.value = '';
    input.placeholder = '新标签页';
  } else {
    input.value = tab ? tab.url : '';
    input.placeholder = OMNI_DEFAULT_PLACEHOLDER;
  }
  const lock = $('#omni-lock');
  const secure = tab && /^https:/i.test(tab.url);
  lock.classList.toggle('is-insecure', !secure);
  lock.title = secure ? '连接已加密' : '非加密连接或本地页面';
}

/* --- 地址栏网址 → 分享面板 / 二维码 --- */
function openOmniShare() {
  const t = activeTab();
  const pop = $('#omni-share');
  if (!pop) return;
  const url = t ? t.url : '';
  // 新标签页那种内置 file:// 页没有可分享的网址
  if (!url || isNewTabUrl(url)) { toast('这个页面没有可分享的网址'); return; }
  const title = t ? (t.title || '') : '';
  const tEl = $('#os-title'), uEl = $('#os-url');
  if (tEl) tEl.textContent = title || prettyUrl(url);
  if (uEl) uEl.textContent = prettyUrl(url);
  pop.dataset.url = url;
  pop.dataset.title = title;
  pop.hidden = false;
}

function closeOmniShare() {
  const pop = $('#omni-share');
  if (pop) pop.hidden = true;
}

function closeQrModal() {
  const m = $('#qr-modal');
  if (m) m.hidden = true;
}

/** 「复制简介」：标题 + 页面 description（尽力取，取不到就只标题）+ 链接。 */
async function shareSummaryText() {
  const t = activeTab();
  if (!t) return '';
  let desc = '';
  if (t.webview && typeof t.webview.executeJavaScript === 'function') {
    try {
      desc = await t.webview.executeJavaScript(
        "(document.querySelector('meta[name=\"description\"]')||{}).content||''");
    } catch { /* 跨域或没权限就算了 */ }
  }
  const d = (desc && desc.length > 140) ? desc.slice(0, 140) + '…' : desc;
  return [t.title || '', d, t.url].filter(Boolean).join('\n');
}

/** 本地生成二维码并弹层（微信/朋友圈等桌面无 API 的 App 用扫码桥接）。 */
async function showQr(title) {
  const pop = $('#omni-share');
  const url = pop && pop.dataset.url;
  if (!url) return;
  const modal = $('#qr-modal'), img = $('#qr-img'), urlEl = $('#qr-url'), titleEl = $('#qr-title');
  if (titleEl) titleEl.textContent = title || '用手机扫码';
  if (urlEl) urlEl.textContent = url;
  if (img) img.removeAttribute('src');
  if (modal) modal.hidden = false;
  const r = await bridge.system.qrcode(url);
  if (r && r.ok && img) { img.src = r.dataUrl; }
  else { toast((r && r.error) || '生成二维码失败'); }
}

async function handleShareAction(act) {
  const pop = $('#omni-share');
  const url = pop && pop.dataset.url;
  const title = (pop && pop.dataset.title) || '';
  if (!url) return;
  if (act === 'copy-link') {
    await bridge.system.copy(url);
    toast('链接已复制');
    closeOmniShare();
  } else if (act === 'copy-summary') {
    await bridge.system.copy(await shareSummaryText());
    toast('已复制简介（标题 + 链接）');
    closeOmniShare();
  } else if (act === 'qr') {
    showQr('扫码在手机上打开');
  } else if (act === 'wechat') {
    showQr('用微信扫码打开 / 转发');
  } else if (act === 'moments') {
    showQr('扫码后在朋友圈分享');
  } else if (act === 'weibo') {
    // 微博有网页分享接口
    const u = 'https://service.weibo.com/share/share.php?url='
      + encodeURIComponent(url) + '&title=' + encodeURIComponent(title || url);
    bridge.system.openExternal(u);
    toast('已打开微博分享页');
    closeOmniShare();
  } else if (act === 'xhs') {
    // 小红书无分享接口：复制「标题 + 链接」去 App 粘贴
    await bridge.system.copy((title ? title + '\n' : '') + url);
    toast('已复制标题和链接，去小红书粘贴');
    closeOmniShare();
  }
}

function syncNavButtons() {
  const tab = activeTab();
  const wv = tab && tab.webview;
  // 未就绪一律按「不能导航」处理。canGoBack / canGoForward 与
  // executeJavaScript 一样，都要求 webview 已 attach 且 dom-ready 已触发，
  // 在那之前调用会抛
  // 「The WebView must be attached to the DOM and the dom-ready event emitted…」。
  //
  // **为什么必须是 try/catch 而不是提前 return**：这个函数有四个调用点，
  // 其中 did-start-loading / did-stop-loading 那两个恰恰发生在「attach 之后、
  // dom-ready 之前」那段窗口里 —— 启动必经，所以不接住就是**每次启动报一次**
  // 「初始化失败」，而真实原因只是按钮状态还没法算。
  // 判据用 getWebContentsId()：它同样要求 dom-ready，但未就绪时返回 0 而不抛，
  // 正好用来「问一句而不打扰用户」（与 aiWebViewReady 同一个道理）。
  let canBack = false;
  let canFwd = false;
  try {
    if (wv && typeof wv.canGoBack === 'function' && wv.getWebContentsId() > 0) {
      canBack = !!wv.canGoBack();
      canFwd = !!wv.canGoForward();
    }
  } catch { /* 没就绪：按钮保持禁用，等 dom-ready 那次再刷 */ }
  $('#nav-back').disabled = !canBack;
  $('#nav-forward').disabled = !canFwd;
  $('#nav-reload').title = tab && tab.loading ? '停止' : '刷新';
}

/**
 * 前进 / 后退。webview 未 dom-ready 时**安静地什么都不做**。
 *
 * <p>与 {@link syncNavButtons} 同一个坑：这个错会冒泡成一句误导人的
 * 「初始化失败」，而真实原因只是「页面还没加载好，用户手快」。
 */
function navGo(dir) {
  const wv = activeTab() && activeTab().webview;
  if (!wv) return;
  try {
    if (!(typeof wv.getWebContentsId === 'function' && wv.getWebContentsId() > 0)) return;
    if (dir === 'back' && typeof wv.canGoBack === 'function' && wv.canGoBack()) wv.goBack();
    else if (dir === 'forward' && typeof wv.canGoForward === 'function' && wv.canGoForward()) wv.goForward();
  } catch { /* 没就绪：这一次点击就当没发生 */ }
}

/* ------------------------------------------------------------------ *
 * 收藏夹栏
 * ------------------------------------------------------------------ */

/**
 * 档位取值。不在表里的一律当常驻 —— 用户不该因为配置文件脏了、
 * 或某个旧版本写过别的字，就凭空少掉一条栏。
 */
function bmBarMode() {
  const v = state.settings && state.settings.bookmarkBar;
  return (v === 'ntp' || v === 'hidden') ? v : 'always';
}

/** 档位 → 设置页上的说法。toast 与分段控件共用一份，免得两处各写一遍。 */
const BM_BAR_LABEL = {
  always: '地址栏下方',
  ntp: '仅新标签页',
  hidden: '不显示'
};

/**
 * 上一次渲染的内容指纹。
 * refreshCurrent() 会被嗅探刷新、下载进度这类高频事件带着跑，没有这道比对
 * 就会不停重建 —— 表现是鼠标停在某一格上，底色一直闪。
 */
let bmBarSig = null;

/**
 * 某个地址的站点图标，取到给 data: URI，取不到给空串。
 *
 * 与 newtab.html 的 NovaNtp.iconOf 是同一套查表规则（原文主机名 → 去 www.
 * → 补 www.，三试），因为写到表里的键是主进程按书本 / 磁贴里的写法算的，
 * 与这里读到的 url 不保证同一写法。改这里记得同步那一处。
 */
function hostIcon(url) {
  const h = hostOf(url);
  if (!h) return '';
  const bare = h.replace(/^www\./, '');
  return state.hostIcons[h] || state.hostIcons[bare] || state.hostIcons['www.' + bare] || '';
}

/** 已经问过主进程的主机名。同一批问第二遍拿到的还是同一张表，白跑一趟 IPC。 */
let hostIconsAsked = '';

/**
 * 问主进程要一次站点图标表。
 *
 * 只问书签用到的那些主机，不是全量 —— 这张表是为「书签格 / 书签列表上那颗
 * 图标」服务的，历史记录里那几百个域名不需要。
 *
 * 拿到之后重新渲染：图标是异步来的（没缓存时主进程要现抓，可能要几秒），
 * 渲染时不重画一次的话，用户得切个页面才看得到图标。
 *
 * force 用于「主机名没变但表的内容变了」——主进程抓到新图标会推
 * favicon:updated，那时必须再读一次。
 */
async function refreshHostIcons(force = false) {
  const hosts = [...new Set((state.bookmarks || []).map((b) => hostOf(b && b.url)).filter(Boolean))];
  const key = hosts.slice().sort().join(',');
  // 一张表都没有（书签全删光）时也要走一次：state.hostIcons 得跟着清空，
  // 否则删掉的书签的图标会留在表里，下次同名主机加回来时先撞上旧图。
  if (!force && !hosts.length && !Object.keys(state.hostIcons).length) return;
  if (!force && key === hostIconsAsked) return;
  hostIconsAsked = key;
  try {
    state.hostIcons = (await bridge.favicons.json(hosts)) || {};
  } catch {
    // 拿不到就维持现状：书签格上还有 b.favicon 与首字母两层兜底，
    // 不该因为一次 IPC 失败把整条栏画没了。
    return;
  }
  renderBookmarkBar(true);
  // 设置页正停在「书签」分区时，那张列表也要跟着换图标 —— 它是上一次
  // 用空表画出来的，不补这一次就停在首字母上。
  const view = $('#settings-view');
  if (view && !view.hidden && state.settingsSection === 'bookmarks') {
    renderSettingsSection('bookmarks');
  }
}

/**
 * 渲染收藏夹栏。
 *
 * 位置固定在地址栏下方（往上就是标签条，这条栏没有第二处可放），
 * 所以设置里给的三档不是「上/下」而是「什么时候露出来」。
 * 宽屏窄屏共用这一条，差别只在样式（见 shell.css 的 [data-layout="mobile"]）。
 */
function renderBookmarkBar(force = false) {
  const bar = $('#bookmark-bar');
  if (!bar) return;

  const mode = bmBarMode();
  const tab = activeTab();
  const onNtp = !!tab && isNewTabUrl(tab.url);
  // 「不显示」档收起时不只设 hidden：关掉的条目还留在 DOM 里能被读到，
  // 而「这条栏现在不在了」最好在 DOM 上也成立，不是只靠一层 CSS 挡。
  const show = mode === 'always' || (mode === 'ntp' && onNtp);

  if (!show) {
    if (!bar.hidden) bar.hidden = true;
    if (bar.firstChild) bar.innerHTML = '';
    bmBarSig = null;
    return;
  }
  bar.hidden = false;

  const list = state.bookmarks || [];
  // 指纹里带上图标三层来源：书签的标题可能不变，而图标是后来才到的 ——
  // 页面的 page-favicon-updated 比收藏动作晚，主进程抓缓存又要等网络。
  // 不带就会停在一个旧图标上（甚至是永远不换的首字母）。
  const sig = mode + '|' + list
    .map((b) => `${b.url}\u0001${b.title || ''}\u0001${hostIcon(b.url)}\u0001${b.favicon || ''}`)
    .join('\u0002');
  if (!force && sig === bmBarSig) return;
  bmBarSig = sig;

  // 空栏不留一条纯白 —— 那条空带子看着像个渲染失败的控件。
  if (!list.length) {
    bar.innerHTML = '<span class="bm-empty">收藏夹栏还是空的 —— 地址栏右侧的星形按钮可以把当前页钉到这里</span>';
    return;
  }

  bar.innerHTML = list.map((b) => {
    const host = hostOf(b.url);
    const label = b.title || host || b.url;
    // 三层，从可靠到兜底：站点图标缓存（主进程按站点抓的，落盘、有 TTL）
    // → 书签自带的 favicon（收藏那一刻抄下来的外链，可能空、可能已失效）
    // → 首字母方块（新标签页磁贴用的是同一套兜底）。
    const src = hostIcon(b.url) || b.favicon || '';
    const icon = src
      ? `<img src="${esc(src)}" alt="" onerror="this.remove()" />`
      : esc((host || 'N').slice(0, 1).toUpperCase());
    // 标题下面补一行主机名（与安卓那条栏一致）。没有它的话，一长条书签里
    // 「知乎」和「知乎回答」分不出来，得逐个点进去才知道跳哪。
    // 只到主机名、不带 https:// 与 www.：这一行是给「分得清哪一家」用的，
    // 整条路径写进来只会把格子撑宽 —— 而那部分信息标题里已经有了。
    const hostLine = (host || '').replace(/^www\./, '');
    return `<button class="bm-item" data-bm="${esc(b.url)}"` +
      ` title="${esc(label)}&#10;${esc(b.url)}&#10;右键移出收藏夹栏">` +
      `<span class="bm-fav">${icon}</span>` +
      `<span class="bm-text">` +
      `<span class="bm-title">${esc(label)}</span>` +
      (hostLine ? `<span class="bm-host">${esc(hostLine)}</span>` : '') +
      `</span></button>`;
  }).join('');
}

/**
 * 导航之后问一次要不要重画。
 *
 * 只有 ntp 档位的显隐跟当前页有关；另两档每次导航都重建纯属白费，
 * 而且会把鼠标停着那一格的悬停底色打掉。
 */
function syncBookmarkBar() {
  if (bmBarMode() !== 'ntp') return;
  renderBookmarkBar();
}

/* ------------------------------------------------------------------ *
 * 顶栏快捷开关（品牌名右侧）
 * ------------------------------------------------------------------ */

/**
 * 同步两个快捷开关的外观。
 *
 * 主题格换图标靠 CSS 按 [data-theme] 走，这里只补 title；收藏夹栏格要写
 * is-on 与 title，所以两格都得过一遍。
 */
function syncQuickBar() {
  const theme = document.documentElement.dataset.theme || 'light';
  const tbtn = $('#qk-theme');
  if (tbtn) {
    tbtn.title = theme === 'dark' ? '当前深色主题 · 点击切到浅色' : '当前浅色主题 · 点击切到深色';
  }
  const bbtn = $('#qk-bmbar');
  if (bbtn) {
    // 判定用配置档位，而不是此刻这条栏露没露出来：在「仅新标签页」档下，
    // 用户在网页与新标签页之间来回走，按真实可见性画会让按钮跟着一闪一闪，
    // 看着像坏了。这一格回答的是「这条栏开着没有」。
    const mode = bmBarMode();
    const on = mode !== 'hidden';
    bbtn.classList.toggle('is-on', on);
    bbtn.title = `收藏夹栏：${BM_BAR_LABEL[mode]} · 点击${on ? '隐藏' : '显示'}`;
  }
}

function wireQuickBar() {
  const tbtn = $('#qk-theme');
  if (tbtn) {
    tbtn.addEventListener('click', async () => {
      const next = (document.documentElement.dataset.theme === 'dark') ? 'light' : 'dark';
      state.settings.theme = next;
      document.documentElement.dataset.theme = next;
      syncQuickBar();
      // 设置页正开着的时候，那边的分段控件不能还停在上一个主题上。
      refreshCurrent();
      await bridge.settings.patch({ theme: next });
      toast(next === 'dark' ? '深色主题' : '浅色主题');
    });
  }

  const bbtn = $('#qk-bmbar');
  if (bbtn) {
    bbtn.addEventListener('click', async () => {
      // 两态开关：「仅新标签页」那一档在这里读作「开着」，点一下收起，再点
      // 放成常驻 —— 三档之间的细微差别留给设置页。
      const next = bmBarMode() === 'hidden' ? 'always' : 'hidden';
      state.settings.bookmarkBar = next;
      renderBookmarkBar(true);
      syncQuickBar();
      refreshCurrent();
      await bridge.settings.patch({ bookmarkBar: next });
      toast('收藏夹栏：' + BM_BAR_LABEL[next]);
    });
  }

  // 「关于」：顶栏直达，版本/更新/下载入口不必再翻菜单进设置
  const abtn = $('#qk-about');
  if (abtn) {
    abtn.addEventListener('click', () => openPanel('about'));
  }
}

/* ------------------------------------------------------------------ *
 * 抽屉面板
 * ------------------------------------------------------------------ */

function openDrawer(title, html) {
  $('#drawer-title').textContent = title;
  $('#drawer-body').innerHTML = html;
  $('#drawer').classList.add('is-open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  requestAnimationFrame(() => $('#scrim').classList.add('is-open'));
}

function closeDrawer() {
  $('#drawer').classList.remove('is-open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('is-open');
  setTimeout(() => { $('#scrim').hidden = true; }, 220);
  state.panel = null;
}

/**
 * 当前应用版本号（来自 package.json，经主进程 bootstrap 透传）。
 *
 * <p>取不到时给一个显眼的占位而不是静默空着 —— 「关于」里版本号那一栏
 * 空着会让人以为这是不支持显示，而实际是漏传了。
 */
function upVer() {
  return state.appVersion || '版本未知';
}

/**
 * 菜单里「关于」那一行右端的角标：有新版可更新时显示版本号，否则不占位。
 *
 * <p>此前这一格恒为空，而更新状态只由顶栏那个齿轮按钮表达 ——
 * 于是「有新版」这件事在菜单里完全看不出来，用户不会去点那个齿轮。
 * 这里把它带过来，是给顶栏那处补一个不必先扫视工具栏的入口。
 */
function updateTail() {
  const s = state.update || {};
  if (s.status === 'available') {
    return `<span style="color:var(--brand)">${esc((s.info && s.info.version) || '有新版')}</span>`;
  }
  if (s.status === 'downloading') return `${Math.round(s.percent || 0)}%`;
  if (s.status === 'ready') return '<span style="color:var(--brand)">可安装</span>';
  return '›';
}

function renderMenuPanel() {
  const tab = activeTab();
  const e = tab ? engine(tab.engineId) : engine(state.settings.defaultEngine);
  state.panel = 'menu';
  openDrawer('菜单', `
    <div class="engine-info">
      <div class="engine-info-head">
        <span class="engine-dot" style="--engine-color:${e.accent}"></span>
        <span class="engine-info-name">当前内核 · ${esc(e.label)}</span>
        <span class="mode-pill mode-${e.mode}">${esc(e.modeLabel)}</span>
      </div>
      <div class="engine-info-body">
        ${esc(e.notes)}<br />
        <span style="color:var(--text-4)">UA：${esc(e.userAgent)}</span>
      </div>
    </div>

    <div class="panel-label">应用</div>
    <div class="list-row is-click" data-panel="settings">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/></svg></span>
      <span class="lr-main"><span class="lr-title">设置</span><span class="lr-sub">常规 / 内核 / 拦截 / 数据</span></span>
      <span class="lr-tail">›</span>
    </div>
    <div class="list-row is-click" data-panel="about">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 6.5v.01"/></svg></span>
      <span class="lr-main"><span class="lr-title">关于吾爱Nova</span><span class="lr-sub">${esc(upVer())}</span></span>
      <span class="lr-tail">${updateTail()}</span>
    </div>

    <div class="panel-label">导航</div>
    <div class="list-row is-click" data-act="new-tab">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"/></svg></span>
      <span class="lr-main"><span class="lr-title">新建标签页</span></span>
      <span class="lr-tail">Ctrl+T</span>
    </div>
    <div class="list-row is-click" data-act="home">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><path d="M3.5 9L10 3.5 16.5 9v7.5h-5v-4h-3v4h-5z"/></svg></span>
      <span class="lr-main"><span class="lr-title">回到主页</span></span>
      <span class="lr-tail">${esc(prettyUrl(state.settings.homepage))}</span>
    </div>
    <div class="list-row is-click" data-act="bookmark">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><path d="M6 3.5h8v13l-4-3-4 3z"/></svg></span>
      <span class="lr-main"><span class="lr-title">加入书签</span></span>
    </div>

    <div class="panel-label">功能</div>
    <div class="list-row is-click" data-read="1">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.2"/><path d="M2.5 10S5.5 5 10 5s7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5z"/></svg></span>
      <span class="lr-main">
        <span class="lr-title">阅读增强</span>
        <span class="lr-sub">无图模式 ${esc(noImageLabel())} · 自动拼页 ${mobilePref().autoPage ? '开' : '关'}</span>
      </span>
      <span class="lr-tail">›</span>
    </div>
    <div class="list-row is-click" data-panel="adblock">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><path d="M10 2.5l6 2v5.2c0 3.6-2.5 6.6-6 7.8-3.5-1.2-6-4.2-6-7.8V4.5z"/></svg></span>
      <span class="lr-main"><span class="lr-title">广告拦截</span><span class="lr-sub">已拦截 ${state.adblock.blocked} 次</span></span>
      <span class="lr-tail">›</span>
    </div>
    <div class="list-row is-click" data-panel="extensions">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><path d="M8 3.5a2 2 0 1 1 4 0h3v3a2 2 0 1 0 0 4v3h-3a2 2 0 1 0-4 0H5v-3a2 2 0 1 0 0-4V3.5z"/></svg></span>
      <span class="lr-main"><span class="lr-title">扩展管理</span><span class="lr-sub">${state.extensions.length} 个已安装</span></span>
      <span class="lr-tail">›</span>
    </div>
    <div class="list-row is-click" data-panel="bookmarks">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><path d="M10 3l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.8 5.8 16l.8-4.7L3.2 8l4.7-.7z"/></svg></span>
      <span class="lr-main"><span class="lr-title">书签</span><span class="lr-sub">${state.bookmarks.length} 条</span></span>
      <span class="lr-tail">›</span>
    </div>
    <div class="list-row is-click" data-panel="history">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><path d="M10 6v4.2l3 1.8"/></svg></span>
      <span class="lr-main"><span class="lr-title">历史记录</span></span>
      <span class="lr-tail">›</span>
    </div>
    <div class="list-row is-click" data-panel="downloads">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><path d="M10 3.5v9M6.5 9.5L10 13l3.5-3.5M4 16h12"/></svg></span>
      <span class="lr-main"><span class="lr-title">下载</span></span>
      <span class="lr-tail">${state.downloads.length}</span>
    </div>
  `);
  wireActions($('#drawer-body'));
}

/** 三个拦截源的卡片：独立开关 + 分源统计 + 溯源地址 */
function renderSourceCards(s) {
  const sources = (s && s.sources) || [];
  if (!sources.length) return '';
  return `
    <div class="panel-label">拦截来源</div>
    ${sources.map((src) => {
      const c = src.counts || {};
      const lists = (src.lists || []);
      return `
      <div class="src-card ${src.enabled ? '' : 'is-off'}" data-src="${esc(src.id)}">
        <div class="src-head">
          <span class="src-name">${esc(src.name)}</span>
          <button class="switch ${src.enabled ? 'is-on' : ''}" data-source="${esc(src.id)}"
                  title="${src.enabled ? '停用该源' : '启用该源'}"></button>
        </div>
        <div class="src-vendor">${esc(src.vendor)}</div>
        <div class="src-metrics">
          <span class="sm"><b>${fmtNum(c.network)}</b> 网络</span>
          <span class="sm"><b>${fmtNum(c.cosmetic)}</b> 隐藏</span>
          <span class="sm sm-hit"><b>${fmtNum(src.blocked)}</b> 命中</span>
        </div>
        ${lists.filter((l) => l.rules).map((l) => `
          <div class="src-list" title="${esc(l.url || '随应用内置，不依赖网络')}">
            <span class="sl-title">${esc(l.title || l.file)}</span>
            <span class="sl-count">${fmtNum(l.rules)} 条</span>
          </div>`).join('')}
        ${lists.filter((l) => l.missing).map((l) => `
          <div class="src-list is-missing">
            <span class="sl-title">${esc(l.title || l.file)}</span>
            <span class="sl-count">未下载</span>
          </div>`).join('')}
        ${src.note ? `<div class="src-note">${esc(src.note)}</div>` : ''}
      </div>`;
    }).join('')}
  `;
}

function buildAdblock() {
  const s = state.adblock;
  const ab = state.settings.adblock || {};
  const host = activeTab() ? hostOf(activeTab().url) : '';
  const allowed = state.allowlist.some((h) => h === host || (host && host.endsWith('.' + h)));
  const sources = s.sources || [];
  const onCount = sources.filter((x) => x.enabled).length;

  return `
    <h2 class="sv-h2">广告拦截</h2>
    <div class="sv-lead">
      ${sources.length ? `${sources.length} 个拦截源，当前启用 ${onCount} 个。` : ''}
      三个源各自独立判定，都可单独关掉；规则自带索引，十万级规则下单次判定仍在微秒量级。
    </div>

    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-value is-ok">${fmtNum(s.blocked)}</div>
        <div class="stat-label">本次会话已拦截</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${fmtNum(s.rules && s.rules.network)}</div>
        <div class="stat-label">网络规则</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${fmtNum(s.rules && s.rules.cosmetic)}</div>
        <div class="stat-label">隐藏规则</div>
      </div>
    </div>

    ${renderSourceCards(s)}

    <div class="panel-label">总开关</div>
    <div class="sv-card">
      <div class="list-row">
        <span class="lr-main"><span class="lr-title">启用广告拦截</span><span class="lr-sub">网络层 + 元素隐藏</span></span>
        <button class="switch ${ab.enabled ? 'is-on' : ''}" data-toggle="enabled"></button>
      </div>
      <div class="list-row">
        <span class="lr-main"><span class="lr-title">元素隐藏（外观过滤）</span><span class="lr-sub">干掉自售广告位</span></span>
        <button class="switch ${ab.cosmetic ? 'is-on' : ''}" data-toggle="cosmetic"></button>
      </div>
    </div>

    <div class="panel-label">拦截强度</div>
    <div class="panel-section">
      <div class="segmented" id="ab-level">
        <button data-level="standard" class="${(ab.level || 'standard') === 'standard' ? 'is-active' : ''}">标准</button>
        <button data-level="aggressive" class="${ab.level === 'aggressive' ? 'is-active' : ''}">严格</button>
      </div>
      <div class="muted" style="padding:var(--sp-2) 0 0">标准档只拦第三方统计；严格档连第一方埋点一并拦截。</div>
    </div>

    <div class="panel-label">白名单（${state.allowlist.length}）</div>
    ${host ? `
    <div class="sv-card">
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">当前站点 ${esc(host)}</span>
          <span class="lr-sub">${allowed ? '已加入白名单，本站不拦截' : '正常拦截'}</span>
        </span>
        <button class="btn" data-allow="${esc(host)}">${allowed ? '移出白名单' : '加入白名单'}</button>
      </div>
    </div>` : ''}
    ${state.allowlist.length ? `
    <div class="sv-card">
      ${state.allowlist.map((h) => `
        <div class="list-row">
          <span class="lr-main"><span class="lr-sub" style="font-size:12px;color:var(--text-2)">${esc(h)}</span></span>
          <button class="btn" data-unallow="${esc(h)}">移除</button>
        </div>`).join('')}
    </div>` : '<div class="sv-empty">还没有例外站点。拦截误伤时把当前站点加进来即可。</div>'}

    <div class="panel-label">拦截来源 Top</div>
    ${(s.top || []).length ? `<div class="sv-card">${(s.top).map((r) => `
      <div class="list-row">
        <span class="lr-main"><span class="lr-sub" style="font-size:12px;color:var(--text-2)">${esc(r.host)}</span></span>
        <span class="lr-tail">${r.count} 次</span>
      </div>`).join('')}</div>` : '<div class="muted">本次会话还没有拦截记录。</div>'}

    <div class="btn-row">
      <button class="btn btn-primary" data-act="import-list">导入过滤清单</button>
      <button class="btn" data-act="reset-stats">重置统计</button>
    </div>
    <div class="muted">
      支持 EasyList / ABP 语法：<code>||域名^</code>、<code>@@</code> 例外、<code>$third-party</code> 选项、<code>##选择器</code> 元素隐藏。<br />
      未执行请求改写类规则（<code>$redirect=</code> / <code>$csp=</code> / <code>$removeparam=</code>），装载时如实跳过并计入 skipped。
    </div>
  `;
}

/* ------------------------------------------------------------------ *
 * 媒体嗅探
 * ------------------------------------------------------------------ */

const SNIFF_KIND = {
  video: { label: '视频', cls: 'is-video' },
  audio: { label: '音频', cls: 'is-audio' },
  stream: { label: '流媒体', cls: 'is-stream' },
  subtitle: { label: '字幕', cls: 'is-subtitle' }
};

/** 列表里的类别顺序：流清单与大视频优先，字幕垫底 */
const SNIFF_ORDER = ['stream', 'video', 'audio', 'subtitle'];

/** 秒 → 时:分:秒。读不到时长返回空串，不写「0:00」骗人 */
function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** 从 URL 取一个能看的文件名 */
function fileNameOf(url) {
  try {
    const u = new URL(url);
    const base = decodeURIComponent(u.pathname.split('/').pop() || '');
    return base || u.host;
  } catch {
    return url;
  }
}

/**
 * 当前活动标签页对应的 webContents id。
 * 这是主进程给媒体分组用的键，与 state.tabs 里的自增 id 完全无关。
 */
function currentWcId() {
  const t = activeTab();
  return t && t.wcId != null ? t.wcId : null;
}

/** 当前页嗅探到的全部记录 */
function sniffRecords() {
  const wc = currentWcId();
  if (wc == null) return [];
  return state.sniffByWc.get(wc) || [];
}

/** 工具栏角标：只数非分片，否则一个 HLS 页面能显示成几百 */
function sniffBadge() {
  return sniffRecords().filter((r) => !r.isSegment).length;
}

/** 置信度标签 —— 把「我们凭什么认定这是媒体」直白地摆出来 */
function confInfo(c) {
  if (c >= 0.95) return { text: '确定', cls: 'is-high', hint: '响应类型直接声明' };
  if (c >= 0.9) return { text: '很可能是', cls: 'is-high', hint: '响应类型以 video/ 或 audio/ 开头' };
  if (c >= 0.75) return { text: '可能是', cls: 'is-mid', hint: '靠地址扩展名判断' };
  return { text: '存疑', cls: 'is-low', hint: '通用二进制类型 + 地址扩展名' };
}

function syncSniffBadge() {
  const el = $('#sniff-count');
  if (!el) return;
  const n = sniffBadge();
  el.textContent = String(n);
  el.classList.toggle('is-empty', n === 0);
}

/**
 * 把主进程推来的记录并进本地缓存。
 * 同 id 覆盖，但**本地已经探测出的 meta 要留住** —— 主进程那份可能是探测之前的快照，
 * 直接覆盖会把刚读到的时长又抹掉，界面上表现为「读取中…」闪一下又没了。
 */
function mergeSniffRecords(tabId, recs) {
  let bucket = state.sniffByWc.get(tabId);
  if (!bucket) { bucket = []; state.sniffByWc.set(tabId, bucket); }
  const idx = new Map(bucket.map((r, i) => [r.id, i]));

  for (const rec of recs) {
    const i = idx.get(rec.id);
    if (i != null) {
      const keep = (!rec.meta && bucket[i].meta) ? bucket[i].meta : rec.meta;
      bucket[i] = Object.assign({}, rec, { meta: keep || null });
    } else {
      bucket.push(rec);
      idx.set(rec.id, bucket.length - 1);
    }
  }
}

/** 给下载引擎挑个像样的默认文件名：地址里没有扩展名时，用容器格式补一个 */
function suggestName(rec) {
  const base = fileNameOf(rec.url) || 'media';
  if (/\.[a-z0-9]{1,8}$/i.test(base)) return base;
  const raw = rec.ext || String(rec.container || '').toLowerCase();
  const ext = raw.replace(/[^a-z0-9]/g, '') || 'bin';
  return `${base}.${ext}`;
}

function sniffItem(rec) {
  const k = SNIFF_KIND[rec.kind] || { label: rec.kind, cls: '' };
  const conf = confInfo(rec.confidence);
  const isStream = rec.kind === 'stream';
  const canPreview = !isStream && rec.kind !== 'subtitle';
  const opened = state.sniffPreview === rec.id;

  const bits = [];
  if (rec.meta && rec.meta.width && rec.meta.height) bits.push(`${rec.meta.width}×${rec.meta.height}`);
  if (rec.meta && rec.meta.duration) bits.push(fmtDuration(rec.meta.duration));
  if (rec.size > 0) bits.push(fmtBytes(rec.size));
  if (rec.container) bits.push(rec.container);
  if (rec.hits > 1) bits.push(`命中 ${rec.hits} 次`);

  const probing = canPreview && !rec.meta;
  const noMeta = rec.meta && rec.meta.failed;

  return `
    <div class="sn-item ${rec.isSegment ? 'is-seg' : ''}" data-rec="${esc(rec.id)}">
      <div class="sn-item-head">
        <span class="sn-kind ${k.cls}">${esc(k.label)}</span>
        <span class="sn-name" title="${esc(rec.url)}">${esc(fileNameOf(rec.url))}</span>
        <span class="sn-conf ${conf.cls}" title="${esc(conf.hint)}">${esc(conf.text)}</span>
      </div>
      <div class="sn-item-meta">
        ${bits.map((b) => `<span>${esc(b)}</span>`).join('')}
        ${probing ? '<span class="sn-probing">读取中…</span>' : ''}
        ${noMeta ? '<span class="sn-meta-fail">读不到元数据</span>' : ''}
      </div>
      <div class="sn-item-url" title="${esc(rec.url)}">${esc(rec.url)}</div>
      <div class="sn-item-why">判定依据：${esc(rec.reason || '—')}</div>
      ${opened ? `
      <div class="sn-preview">
        ${rec.kind === 'audio'
          ? `<audio controls preload="metadata" src="${esc(rec.url)}"></audio>`
          : `<video controls preload="metadata" src="${esc(rec.url)}"></video>`}
        <div class="sn-preview-note">
          预览走的是浏览器通用会话，不带该页面所在内核的登录态 —— 需要鉴权的资源可能播不了；
          下载走对应内核会话（带 Cookie），不受此限。
        </div>
      </div>` : ''}
      ${isStream ? `
      <div class="sn-stream-note">
        这是流媒体的<strong>分片清单</strong>：拿到的是切片地址表，不是单个文件。
        下载得到的是清单本身，要合成完整视频需要专门的合并工具。
      </div>` : ''}
      <div class="sn-item-actions">
        ${canPreview ? `<button class="btn btn-sm" data-sn="preview" data-id="${esc(rec.id)}">${opened ? '收起' : '预览'}</button>` : ''}
        <button class="btn btn-sm btn-primary" data-sn="download" data-id="${esc(rec.id)}">下载</button>
        <button class="btn btn-sm" data-sn="copy" data-id="${esc(rec.id)}">复制链接</button>
        <button class="btn btn-sm" data-sn="open" data-id="${esc(rec.id)}">在标签页打开</button>
      </div>
    </div>`;
}

function buildSniffer() {
  const prefs = (state.settings && state.settings.sniffer) || {};
  const enabled = prefs.enabled !== false;
  const autoProbe = prefs.autoProbe !== false;
  const minSize = prefs.minSizeKB || 0;
  const tab = activeTab();
  const wc = currentWcId();

  const all = sniffRecords();
  const main = all.filter((r) => !r.isSegment);
  const segs = all.filter((r) => r.isSegment);

  const counts = { video: 0, audio: 0, stream: 0, subtitle: 0 };
  let bytes = 0;
  for (const r of main) {
    counts[r.kind] = (counts[r.kind] || 0) + 1;
    if (r.size > 0) bytes += r.size;
  }

  const fmt = state.sniffFormats || {};
  const stat = state.sniffStats || {};

  const seg = (id, values, current, fmtFn) => `
    <div class="segmented" id="${id}">
      ${values.map((v) => `<button data-v="${v}" class="${v === current ? 'is-active' : ''}">${fmtFn ? fmtFn(v) : v}</button>`).join('')}
    </div>`;

  // 按类别分组，组内体积大的排前面 —— 用户找的多半是那个大视频
  const groups = SNIFF_ORDER
    .map((kind) => ({ kind, items: main.filter((r) => r.kind === kind).sort((a, b) => (b.size || 0) - (a.size || 0)) }))
    .filter((g) => g.items.length);

  const listHtml = !enabled
    ? '<div class="sv-empty">嗅探已关闭。打开后新产生的媒体请求才会被记录。</div>'
    : (wc == null
      ? '<div class="sv-empty">等待页面就绪…嗅探结果按标签页归属，页面开始加载后才会出现记录。</div>'
      : (main.length
        ? groups.map((g) => `
          <div class="panel-label">${esc(SNIFF_KIND[g.kind].label)}（${g.items.length}）</div>
          <div class="sv-card sn-card">${g.items.map(sniffItem).join('')}</div>`).join('')
        : `<div class="sv-empty">
             这一页还没有嗅到音频 / 视频。<br />
             播放一次页面上的媒体，或往下滚动触发懒加载，资源出现后会自动冒出来。
           </div>`));

  return `
    <h2 class="sv-h2">媒体嗅探</h2>
    <div class="sv-lead">
      在响应头阶段识别页面加载的音视频与流媒体，判定依据分四级置信度，并把依据如实标在每一条上。
      识别不改写任何请求，纯旁路观察。
    </div>

    <div class="sn-engine">
      <div class="sn-engine-head">
        <span class="sn-engine-title">媒体嗅探引擎</span>
        <span class="sn-pill ${enabled ? 'is-active' : 'is-canceled'}">${enabled ? '运行中' : '已关闭'}</span>
      </div>
      <div class="sn-stats">
        <div class="sn-stat"><b>${fmtNum(counts.video)}</b><span>视频</span></div>
        <div class="sn-stat"><b>${fmtNum(counts.audio)}</b><span>音频</span></div>
        <div class="sn-stat"><b>${fmtNum(counts.stream)}</b><span>流媒体</span></div>
        <div class="sn-stat"><b>${fmtNum(counts.subtitle)}</b><span>字幕</span></div>
        <div class="sn-stat"><b>${bytes > 0 ? fmtBytes(bytes) : '—'}</b><span>合计体积</span></div>
      </div>
      <div class="sn-engine-note">
        ${tab ? `当前页：<b>${esc(tab.title || hostOf(tab.url) || tab.url)}</b>` : '还没有打开的标签页'}
        ${stat.seen ? ` · 本次会话共解析 ${fmtNum(stat.seen)} 个媒体响应、排除 ${fmtNum(stat.filtered)} 个非媒体响应` : ''}
        ${fmt.extensions ? `<br />格式注册表：<b>${fmt.extensions}</b> 种扩展名 / <b>${fmt.mimes}</b> 种响应类型，归一为 <b>${fmt.containers}</b> 个容器。` : ''}
      </div>
    </div>

    <div class="panel-label">嗅探设置</div>
    <div class="sv-card">
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">启用媒体嗅探</span>
          <span class="lr-sub">关闭后不再解析响应头</span>
        </span>
        <button class="switch ${enabled ? 'is-on' : ''}" data-sncfg="enabled"></button>
      </div>
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">自动读取时长与分辨率</span>
          <span class="lr-sub">只取文件头，代价极小；流媒体清单一律不探测（那会把整条流拉起来）</span>
        </span>
        <button class="switch ${autoProbe ? 'is-on' : ''}" data-sncfg="autoProbe"></button>
      </div>
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">显示 HLS 分片</span>
          <span class="lr-sub">切片动辄几百条，默认折叠以免淹没清单</span>
        </span>
        <button class="switch ${state.sniffShowSegments ? 'is-on' : ''}" data-sncfg="showSegments"></button>
      </div>
    </div>

    <div class="panel-label">最小体积</div>
    ${seg('sn-minsize', [0, 64, 256, 1024], minSize, (v) => (v === 0 ? '不限' : v + ' KB'))}
    <div class="muted" style="padding-bottom:var(--sp-3)">
      默认「不限」是刻意的：嗅探是发现工具，宁可多列也不能漏。长度未知的响应永远不会被这一项拦掉。
    </div>

    <div class="panel-label dl-label-row">
      <span>${wc == null ? '当前页面' : '当前页面的媒体'}（${main.length}）</span>
      <button class="btn btn-sm" data-sn="clear" ${main.length || segs.length ? '' : 'disabled'}>清空</button>
    </div>

    ${listHtml}

    ${segs.length ? `
      <div class="panel-label dl-label-row">
        <span>HLS 分片（${segs.length}）· 默认折叠</span>
        <button class="btn btn-sm" data-sn="toggle-segs">${state.sniffShowSegments ? '收起' : '展开'}</button>
      </div>
      ${state.sniffShowSegments
        ? `<div class="sv-card sn-card">${segs.slice(0, 200).map(sniffItem).join('')}</div>
           ${segs.length > 200 ? `<div class="muted">仅显示前 200 条，共 ${segs.length} 条。</div>` : ''}`
        : ''}` : ''}

    <div class="sv-note">
      嗅探只认「响应里声明了媒体类型」的资源。几种情况会漏，这里说清楚：
      用 <code>blob:</code> 或 MSE 在页面里现拼的流（如部分直播与 DRM 视频）网络上没有可下载的完整地址；
      加了密或需要特殊鉴权头的链接能嗅到、但下载可能被拒；
      加密的 HLS（<code>#EXT-X-KEY</code>）分片单独下下来也解不开。
    </div>
  `;
}

/**
 * 读媒体元数据：用隐藏的 <video>/<audio> 只加载文件头。
 *
 * 两条硬规矩：
 *   1. 流媒体（m3u8/mpd）绝不自动探测 —— 浏览器一旦开始解析清单就会去拉分片，
 *      用户的流量会在毫无察觉的情况下被吃掉；
 *   2. 每条只探测一次，失败就记 failed，不在滚动时反复重试。
 */
const sniffProbed = new Set();

function probeOne(rec) {
  if (!rec || sniffProbed.has(rec.id)) return;
  const prefs = (state.settings && state.settings.sniffer) || {};
  if (prefs.autoProbe === false) return;
  if (rec.kind === 'stream' || rec.kind === 'subtitle') return;
  if (!/^https?:/i.test(rec.url)) return;
  sniffProbed.add(rec.id);

  const el = document.createElement(rec.kind === 'audio' ? 'audio' : 'video');
  el.preload = 'metadata';
  el.muted = true;

  let settled = false;
  const finish = (meta) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { el.removeAttribute('src'); el.load(); } catch { /* 释放连接，失败无妨 */ }
    try { bridge.sniffer.setMeta(rec.id, meta); } catch { /* 主进程没起来就算了 */ }
    // 本地也记一份，免得等 IPC 回来才更新界面
    rec.meta = meta;
    if (state.settingsSection === 'sniffer') refreshCurrent();
  };

  // 8 秒还读不到就当读不到 —— 不能让一个卡住的资源把「读取中…」永远挂在那
  const timer = setTimeout(() => finish({ failed: true }), 8000);

  el.addEventListener('loadedmetadata', () => {
    const dur = Number(el.duration);
    finish({
      duration: Number.isFinite(dur) && dur > 0 ? Math.round(dur * 10) / 10 : null,
      width: el.videoWidth || 0,
      height: el.videoHeight || 0
    });
  });
  el.addEventListener('error', () => finish({ failed: true }));

  el.src = rec.url;
}

/** 渲染出列表后，给屏上靠前的几条排上探测 —— 不做全量，避免一次拉起几十个连接 */
function scheduleSniffProbe() {
  const recs = sniffRecords().filter((r) => !r.isSegment && !r.meta);
  const batch = recs.slice(0, 6);
  batch.forEach((rec, i) => setTimeout(() => probeOne(rec), 120 * i));
}

/**
 * 扩展面板里那两个「去哪找」的入口。
 *
 * 脚本站为什么是脚本猫而不是 Greasy Fork：与安卓端 ScriptCatalog 的判断
 * 完全一致 —— 同一台机器实测，greasyfork.org 与 update.greasyfork.org
 * 连 15 秒无响应（DNS 被解析到 Facebook 的地址段，是污染返回），
 * scriptcat.org 2.8 秒可达。一个装不上的库，推荐得再好也是零。
 *
 * Chrome 应用店同理不在列表里：chromewebstore.google.com 与取包接口
 * clients2.google.com 都不可达，列出来只会浪费用户点一次。
 */
const STORE_LINKS = [
  {
    id: 'edge',
    name: 'Edge 加载项商店',
    note: '微软官方扩展库，可直接装进 Nova',
    mark: 'E',
    accent: '#0A84C6',
    url: 'https://microsoftedge.microsoft.com/addons/Microsoft-Edge-Extensions-Home'
  },
  {
    /**
     * 这里给的是镜像站，不是 chromewebstore.google.com。
     *
     * 那个地址在国内连不上（实测 15 秒超时无响应），做成入口只会打开一张
     * 白屏 —— 用户会以为浏览器坏了。镜像站收录的是同一批扩展、用的是同一套
     * ID，从它上面复制的地址粘回本应用照样能装，所以入口指向它是有意义的；
     * 指向 Google 那个域名则只是把「打不开」这件事换了个地方发生。
     */
    id: 'chrome',
    name: 'Chrome 应用店',
    note: '国内镜像站，扩展可直接装进 Nova',
    mark: 'C',
    accent: '#4285F4',
    url: 'https://chrome.zzzmh.cn/'
  },
  {
    id: 'scriptcat',
    name: '脚本猫',
    note: '用户脚本市场（得先装 Tampermonkey）',
    mark: '脚',
    accent: '#3D6BFF',
    url: 'https://scriptcat.org/'
  }
];

/** 商店那一块。查询结果与错误都在这里长出来，不另开弹层。 */
function storeBox(st) {
  const d = st.detail;
  // 各商店给的字段不一样：Edge 有开发者与精确安装量但是 Manifest V2/V3，
  // 镜像那边给的是「246万+」这种量级写法、没有开发者、也读不到 Manifest 版本。
  // 与其给缺的那几项编个默认值，不如把这一行按实际有的拼 —— 少一项就少一项。
  const metaBits = d ? [
    d.developer || '未知开发者',
    d.installsText ? d.installsText + '次安装' : '',
    d.version ? 'v' + d.version : '',
    d.manifestVersion ? 'Manifest V' + d.manifestVersion : ''
  ].filter(Boolean) : [];

  return `
    <div class="store-box">
      <div class="store-title">扩展商店</div>
      <div class="store-sub">
        支持 Chromium 扩展（.crx / 已解包目录）与火狐扩展（.xpi）。火狐扩展会经过
        清单归一化与 <code>browser.* → chrome.*</code> 桥接后装载，依赖 Gecko 专有 API
        的功能不可用 —— 每张卡片会列出实际做了哪些改动。
        <br /><br />
        商店页上那个「获取」按钮在本应用里点不动 —— 它调的是浏览器自家的安装接口，
        第三方外壳没有这套东西，点了不会有任何反应。所以拆成两步：
        商店照常打开逛，看好了把那个扩展的页面地址粘下来装。
        <br /><br />
        Chrome 应用店本身（chromewebstore.google.com）在国内连不上，这里给的是
        它的国内镜像站：收录的是同一批扩展、用的是同一套 ID，从上面复制的地址
        粘进来照样能装。
        <br />但它是<b>第三方搬运、收录不全</b> —— 热门的大多有（篡改猴、uBlock Origin
        实测都能装），冷门的可能没有。遇到没收录的，可以回到上面的
        「从已安装的浏览器导入」。

        <div style="margin-top:10px">
          <b>第三种办法：直接粘下载地址。</b>
          不少扩展在自己的官网或 GitHub 上直接给 <code>.crx</code> / <code>.zip</code>
          下载链接，而<b>那些域名国内往往是通的</b>。
          比如篡改猴官网 <code>tampermonkey.net</code> 就能直接下
          （实测 <code>data.tampermonkey.net/tampermonkey_stable.crx</code> 可用）。
          把这种链接粘进来一样能装。
        </div>
      </div>
      <div class="store-open-row">
        ${STORE_LINKS.map((s) => `
          <button class="store-open" data-store-open="${esc(s.id)}">
            <span class="so-icon" style="--so:${esc(s.accent)}">${esc(s.mark)}</span>
            <span class="so-main"><b>${esc(s.name)}</b><i>${esc(s.note)}</i></span>
            <span class="so-go">打开</span>
          </button>`).join('')}
      </div>
      <div class="store-paste">
        <input id="store-input" type="text" spellcheck="false"
               placeholder="粘贴扩展页面地址、32 位扩展 ID，或 .crx 下载地址"
               value="${esc(st.draft)}" />
        <button class="btn" data-act="store-query" ${st.busy ? 'disabled' : ''}>${st.busy ? '请稍候…' : '查询'}</button>
      </div>
      ${st.error ? `<div class="store-err">${esc(st.error)}</div>` : ''}
      ${d ? `
        <div class="store-hit">
          <div class="sh-icon">${d.icon
            ? `<img src="${esc(d.icon)}" alt="" onerror="this.remove()" />`
            : esc((d.name || 'E').slice(0, 1))}</div>
          <div class="sh-main">
            <div class="sh-name">${esc(d.name)}${d.mirror
              ? '<span class="sh-tag" title="Chrome 应用店的国内镜像站">镜像</span>' : ''}</div>
            <div class="sh-meta">${metaBits.map(esc).join(' · ')}</div>
            ${d.description ? `<div class="sh-desc">${esc(d.description)}</div>` : ''}
          </div>
          <button class="btn btn-primary" data-act="store-install"
                  ${st.busy || state.isPreview ? `disabled title="UI 预览模式"` : ''}>${st.busy ? '处理中…' : '安装'}</button>
        </div>` : ''}
    </div>
  `;
}

function buildExtensions() {
  const list = state.extensions;
  const on = list.filter((x) => x.enabled !== false);
  const off = list.filter((x) => x.enabled === false);

  /* 顺序刻意是「已装的在前、商店在后」。
   *
   * 原来商店搜索框在最上面，于是用户点顶栏那个拼图图标进来，第一眼看到的
   * 是「搜索商店」——他的原话是「点开插件还是跳转到插件安装页面」。
   * 而他点这个图标多半是想管已经装了的那些（开启/关闭/移除），
   * 不是想再装一个。 */
  return `
    <h2 class="sv-h2">扩展</h2>
    <div class="sv-lead">
      ${list.length
        ? `已装 ${list.length} 个${off.length ? `，其中 ${off.length} 个已关闭` : ''}。开关即时生效，不用重启浏览器。`
        : '还没有装扩展。可以从商店装，也可以把 .crx / .zip / .xpi 直接拖进窗口。'}
    </div>
    <div class="btn-row" style="padding-top:0">
      <button class="btn" data-act="install-ext" ${state.isPreview ? 'disabled title="UI 预览模式"' : ''}>从本地文件安装</button>
    </div>
    <div class="sv-sub-h">已安装${list.length ? ` · ${list.length}` : ''}</div>
    ${list.length ? list.map((x) => extCard(x)).join('')
      : '<div class="sv-empty">还没有安装扩展。</div>'}

    <div class="sv-sub-h">从已安装的浏览器导入</div>
    <div class="sv-lead" style="margin:0 var(--sp-4) var(--sp-2)">
      列出 Chrome / Edge 等浏览器里<b>已经装过</b>的扩展，点一下搬过来。
      这是为 Edge 商店准备的替代路径：微软已关掉它的取包接口，
      粘贴地址下载会一律失败（详见下方商店说明）。
      <br />列表里可能混着浏览器自带的功能组件（名字通常没有本地化的那种），
      只挑你认得出来的装即可 —— 装错了可以在上面「已安装」里移除。
    </div>
    <div id="ext-browsers">${renderBrowserExtList()}</div>

    ${storeBox(state.extStore)}
  `;
}

/**
 * 从其它浏览器扫到的扩展列表。
 *
 * <p>与书签那边同一套：{@code null} 表示**还在扫**，空数组表示**扫完没有** ——
 * 两者在界面上必须读得出区别，空白会被读成后者。
 */
let stateBrowserExts = null;

async function scanBrowserExts() {
  const box = () => $('#ext-browsers');
  try {
    const r = await bridge.extensions.fromBrowser();
    stateBrowserExts = (r && r.found) || [];
  } catch (e) {
    stateBrowserExts = [];
    const el = box();
    if (el) {
      el.innerHTML = '<p class="muted" style="padding:10px 14px">'
        + '扫描不可用（' + esc(String(e && e.message || e)) + '）。</p>';
    }
    return;
  }
  const el = box();
  if (el) el.innerHTML = renderBrowserExtList();
}

function renderBrowserExtList(given) {
  const list = given === undefined ? stateBrowserExts : given;
  if (list === null) {
    return '<p class="muted" style="padding:10px 14px">正在扫描其它浏览器里的扩展…</p>';
  }
  if (!list.length) {
    return '<p class="sv-empty" style="margin:0 var(--sp-4) var(--sp-2)">'
      + '没有在其它浏览器里找到可导入的扩展。</p>';
  }
  return list.map((x) => `
    <div class="list-row is-click" data-imp-ext="${esc(x.key)}">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><path d="M10 3v9M6.5 8.5L10 12l3.5-3.5M4 15.5h12"/></svg></span>
      <span class="lr-main">
        <span class="lr-title">${esc(x.name)}</span>
        <span class="lr-sub">${esc(x.browser)}${x.profile && x.profile !== 'Default' ? ' · ' + esc(x.profile) : ''} · v${esc(x.version)} · Manifest V${esc(x.manifestVersion)}</span>
      </span>
      <span class="lr-tail">导入</span>
    </div>`).join('');
}

/**
 * 从本地文件装扩展（.crx / .zip / .xpi / 装着包的目录）。
 *
 * <p>抽成具名函数是因为它有**两个入口**：设置里的「从本地文件安装」与
 * 工具栏扩展小窗底部的同一个动作。复制一份出来的话，某个入口迟早被漏改
 * （改一处、另一处还按旧行为跑，而且两处看起来都正常）。
 */
async function installExtensionsFromDisk() {
  const r = await bridge.extensions.install();
  state.extensions = await bridge.extensions.list();
  // 两处都重画：这一句调用时可能两个界面都在（小窗开着 + 设置页在背后）
  renderExtPopover();
  refreshCurrent();
  const ok = (r.installed || []).filter((x) => !x.error);
  const bad = (r.installed || []).filter((x) => x.error);
  toast(ok.length
    ? `已安装 ${ok.length} 个扩展${bad.length ? `，${bad.length} 个失败` : ''}`
    : (bad[0] ? bad[0].error : '未选择文件'));
}

/** 一张扩展卡片。启用状态体现在开关与卡片整体的淡出上。 */
function extCard(x) {
  const enabled = x.enabled !== false;
  return `
    <div class="ext-card ${enabled ? '' : 'is-off'}">
      <div class="ext-icon">${x.icon ? `<img src="${esc(x.icon)}" alt="" />` : esc((x.name || 'E').slice(0, 1))}</div>
      <div class="ext-main">
        <div class="ext-name">
          ${esc(x.name)}
          <span class="source-tag source-${esc(x.source)}">${{
            'chromium-store': 'Chromium 商店',
            'firefox': '火狐扩展',
            'archive': '压缩包',
            'unpacked': '已解包'
          }[x.source] || esc(x.source)}</span>
        </div>
        <div class="ext-desc">${esc(x.description || '（无描述）')}</div>
        <div class="ext-meta">v${esc(x.version)} · Manifest V${esc(x.manifestVersion)}${x.packageVersion ? ' · ' + esc(x.packageVersion) : ''}</div>
        ${(x.changes || []).length ? `<div class="ext-changes"><b>兼容处理：</b>${x.changes.map(esc).join('；')}</div>` : ''}
      </div>
      <div class="ext-acts">
        ${(x.uiPaths && x.uiPaths.primary && enabled)
          ? `<button class="btn" data-ext-open="${esc(x.id)}" title="打开这个扩展的界面（侧边栏 / 弹窗 / 选项页）">打开界面</button>`
          : ''}
        <button class="switch ${enabled ? 'is-on' : ''}" data-ext-toggle="${esc(x.id)}"
                title="${enabled ? '已启用，点击关闭' : '已关闭，点击启用'}"></button>
        <button class="btn" data-remove-ext="${esc(x.id)}" title="移除（不可撤销，装的文件也会删掉）">移除</button>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * 工具栏的扩展小窗（点拼图图标弹出来）
 *
 * 用户的原话是「插件按钮没有独立的插件启用窗口」—— 点拼图直接跳进设置
 * 虽然能开/关，但那是「管理」的地方：一页里有说明、商店、导入、每张卡片
 * 的详情。开/关是**高频**动作，每次都要落到那一页上太远。
 * 所以这一个窗口只做一件事：列出已装的、就地切开关。其余仍在设置里
 * （底部一个入口过去）。
 *
 * 与下载小窗同一套壳（.dl-popover）：贴在按钮下面、往左展开。
 * ------------------------------------------------------------------ */

/** 小窗里的一行：图标 / 名字+版本 / 开关 —— 比设置里那张卡片矮得多。 */
function extPopRow(x) {
  const enabled = x.enabled !== false;
  return `
    <div class="ext-pop-row ${enabled ? '' : 'is-off'}">
      <div class="ext-icon">${x.icon ? `<img src="${esc(x.icon)}" alt="" />` : esc((x.name || 'E').slice(0, 1))}</div>
      <div class="ext-pop-main">
        <div class="ext-pop-name" title="${esc(x.name)}${x.description ? ' · ' + esc(x.description) : ''}">${esc(x.name)}</div>
        <div class="ext-pop-ver">v${esc(x.version)} · ${enabled ? '已启用' : '已关闭'}</div>
      </div>
      ${(x.uiPaths && x.uiPaths.primary && enabled)
        ? `<button class="btn btn-sm ext-pop-open" data-ext-open="${esc(x.id)}" title="打开这个扩展的界面（侧边栏 / 弹窗 / 选项页）">打开</button>`
        : ''}
      <button class="switch ${enabled ? 'is-on' : ''}" data-ext-toggle="${esc(x.id)}"
              title="${enabled ? '已启用，点击关闭' : '已关闭，点击启用'}"></button>
    </div>`;
}

/** 重画小窗。开关、安装、卸装都走这里（见那几个调用点）。 */
function renderExtPopover() {
  const list = $('#ext-pop-list');
  const title = $('#ext-pop-title');
  if (!list) return;
  // 两种视图：默认「已装扩展」（就地开关），导入视图「从浏览器导入」。
  // 都在这一个小窗里完成，不用为了导入专门跳去设置页 —— 那正是用户
  // 反馈「探测还是打开设置界面」要解决的：探测/导入就该在点开的这个窗里。
  if (state.extPopView === 'import') {
    if (title) title.textContent = '从浏览器导入';
    list.innerHTML = renderExtImportRows();
    return;
  }
  if (title) title.textContent = '扩展';
  const items = state.extensions || [];
  list.innerHTML = items.length
    ? items.map(extPopRow).join('')
    : '<div class="dl-pop-empty">还没有安装扩展<br />点下面的「从文件安装」</div>';
}

/**
 * 导入视图的行：顶上一条「返回」，下面是扫到的候选。
 *
 * <p>state.extImport 用 null 表示「还在扫」、空数组表示「扫完没有」——
 * 与 {@link stateBrowserExts} 同一套约定：空白会被读成后者，而那是个错误结论。
 */
function renderExtImportRows() {
  const back = '<div class="ext-pop-back" data-ext-pop-back>'
    + '<span class="ext-pop-back-arrow">←</span>返回已装扩展</div>';
  const s = state.extImport;
  if (s === null || s === undefined) {
    return back + '<div class="dl-pop-empty">正在扫描本机已安装浏览器里的扩展…</div>';
  }
  if (!s.length) {
    return back + '<div class="dl-pop-empty">没有在本机其它浏览器里找到可导入的扩展。</div>';
  }
  return back + s.map((x) => `
    <div class="ext-pop-row">
      <div class="ext-pop-import-main">
        <div class="ext-pop-name" title="${esc(x.name)}">${esc(x.name)}</div>
        <div class="ext-pop-ver">${esc(x.browser)}${x.profile && x.profile !== 'Default' ? ' · ' + esc(x.profile) : ''} · v${esc(x.version)}</div>
      </div>
      <button class="btn btn-sm" data-ext-import="${esc(x.key)}">导入</button>
    </div>`).join('');
}

/** 切到导入视图并扫一遍本机浏览器扩展。 */
async function scanExtImport() {
  state.extPopView = 'import';
  state.extImport = null;
  renderExtPopover();
  try {
    const r = await bridge.extensions.fromBrowser();
    state.extImport = (r && r.found) || [];
  } catch (e) {
    state.extImport = [];
    toast('扫描失败：' + String(e && e.message || e), 5000);
  }
  // 只在还停在导入视图时才重画 —— 扫的这会儿用户可能已经点了返回
  if (state.extPopView === 'import') renderExtPopover();
}

/** 打开前先拉一份最新的：扩展可能在别处（设置页 / 拖入安装）变过。 */
async function openExtPopover() {
  const pop = $('#ext-popover');
  if (!pop) return;
  try { state.extensions = await bridge.extensions.list(); } catch { /* 预览模式下没有真列表，用缓存 */ }
  // 每次打开都回到「已装扩展」视图，不停在上次的导入页上
  state.extPopView = 'installed';
  renderExtPopover();
  pop.hidden = false;
  $('#btn-ext').setAttribute('aria-expanded', 'true');
}

function closeExtPopover() {
  const pop = $('#ext-popover');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  const btn = $('#btn-ext');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleExtPopover() {
  if ($('#ext-popover').hidden) openExtPopover();
  else closeExtPopover();
}

async function buildHistory() {
  const items = await bridge.history.list(200);
  return `
    <h2 class="sv-h2">历史记录</h2>
    <div class="sv-lead">最多保留 2000 条，连续访问同一地址只累计次数。最近 ${items.length} 条。</div>
    <div class="btn-row" style="padding-top:0">
      <button class="btn" data-act="clear-history">清空历史</button>
    </div>
    ${items.length ? `<div class="sv-card">${items.map((h) => `
      <div class="hist-row" data-url="${esc(h.url)}">
        <div class="hist-main">
          <div class="hist-title">${esc(h.title || h.url)}</div>
          <div class="hist-url">${esc(prettyUrl(h.url))}</div>
        </div>
        <div class="hist-time">${esc(timeAgo(h.ts))}</div>
      </div>`).join('')}</div>` : '<div class="sv-empty">暂无历史记录。</div>'}
  `;
}

function buildBookmarks() {
  const list = state.bookmarks || [];
  // 用户在书签页最可能想找的就是「那条栏去哪了」，所以在这一页指一次路。
  const barNote = `收藏夹栏当前：<b>${esc(BM_BAR_LABEL[bmBarMode()])}</b> —— 换档在「外观」分区，`
    + '顶栏品牌名右边那个按钮也能一键开合。';
  return `
    <h2 class="sv-h2">书签</h2>
    <div class="sv-lead">共 ${list.length} 条。点一行就在当前标签页打开。<br />${barNote}</div>
    ${list.length ? `<div class="sv-card">${list.map((b) => {
      const host = hostOf(b.url);
      // 与收藏夹栏同一套三层兜底：站点图标缓存 → 书签自带 favicon → 首字母。
      // 列表行比收藏夹栏宽，所以这里给 20px，图标本身看得清。
      const src = hostIcon(b.url) || b.favicon || '';
      const icon = src
        ? `<img src="${esc(src)}" alt="" onerror="this.remove()" />`
        : esc((host || 'N').slice(0, 1).toUpperCase());
      return `
      <div class="list-row is-click" data-url="${esc(b.url)}">
        <span class="lr-fav">${icon}</span>
        <span class="lr-main">
          <span class="lr-title">${esc(b.title || b.url)}</span>
          <span class="lr-sub">${esc(prettyUrl(b.url))}</span>
        </span>
        <button class="btn" data-unbookmark="${esc(b.url)}">删除</button>
      </div>`;
    }).join('')}</div>` : '<div class="sv-empty">还没有书签。地址栏右侧的星形按钮可以加入当前页。</div>'}
    <div class="btn-row">
      <button class="btn btn-primary" data-act="bookmark-current">把当前页加入书签</button>
      <button class="btn" data-act="clear-bookmarks" ${list.length ? '' : 'disabled'}>清空全部书签</button>
    </div>
    <h2 class="sv-h2" style="margin-top:28px">导入 / 导出</h2>
    <div class="sv-lead">
      导出成一份 JSON 文件；导入除自家 JSON 外，也认<b>Chrome / Edge 导出的 HTML</b>
      —— 换浏览器时最要紧的就是这一步。<br />
      同一家站的不同页面会各留一条（那是你真的收过的）；已在的书签不会被覆盖，
      导入只追加。
    </div>
    <div class="btn-row">
      <button class="btn" data-act="bookmarks-import" ${list.length ? '' : 'disabled'}
              title="${list.length ? '' : '还没有书签，先收几条再导出'}">从文件导入…</button>
      <button class="btn" data-act="bookmarks-export" ${list.length ? '' : 'disabled'}>导出书签…</button>
    </div>

    <h2 class="sv-h2" style="margin-top:28px">从已安装的浏览器导入</h2>
    <div class="sv-lead">
      检测到本机装了哪些浏览器，点一下直接把它的书签读进来 —— 不用自己去
      <code>%LOCALAPPDATA%</code> 里翻文件。检测只看文件在不在，<b>不会读你其它浏览器的书签内容</b>。
    </div>
    <div id="bm-browsers">${renderBrowserList()}</div>
  `;
}

/**
 * 已检测到的浏览器列表。
 *
 * <p>检测是**异步**的（要问主进程），所以这个函数先把外壳画出来、
 * 再由调用方把真结果塞回来。在结果回来之前显示的是一行「正在检测…」——
 * 而不是空白：空白会被读成「没检测到任何浏览器」，而那是个错误的结论。
 */
/**
 * 检测结果。**null 表示「还在检测中」**，而不是「没检测到」——
 * 两者在界面上必须读得出区别：空白会被当成后者，而那是个错误结论。
 */
let stateBrowsers = null;

/** 问主进程要检测结果，然后重画那一块。 */
async function detectBrowsers() {
  try {
    const r = await bridge.bookmarks.browsers();
    stateBrowsers = (r && r.browsers) || [];
  } catch (e) {
    // 预览模式（bridge-mock 没有这个方法）或检测本身出错：
    // 给一句人话，而不是留一块空白让人以为没装浏览器
    stateBrowsers = [];
    const box = $('#bm-browsers');
    if (box) {
      box.innerHTML = '<p class="muted" style="padding:10px 0">'
        + '检测不可用（' + esc(String(e && e.message || e)) + '）。'
        + '请改用上方「从文件导入」。</p>';
    }
    return;
  }
  const box = $('#bm-browsers');
  if (box) box.innerHTML = renderBrowserList();
}

function renderBrowserList(given) {
  const s = given === undefined ? stateBrowsers : given;
  if (s === null) return '<p class="muted" style="padding:10px 0">正在检测已安装的浏览器…</p>';
  if (!s.length) {
    return '<p class="sv-empty" style="padding:14px 0">没有检测到可读取书签的浏览器。'
      + '如果你用的是 Firefox 或其他浏览器，请改用上方「从文件导入」，'
      + '在那个浏览器里导出 HTML 后再导入。</p>';
  }
  return s.map((b) => `
    <div class="list-row ${b.supported ? 'is-click' : ''}" ${b.supported ? `data-browser="${esc(b.id)}"` : ''}>
      <span class="lr-icon"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><path d="M10 6.5v.01M10 9v5"/></svg></span>
      <span class="lr-main">
        <span class="lr-title">${esc(b.name)}</span>
        <span class="lr-sub">${b.supported
          ? (b.profile ? `配置 ${esc(b.profile)} · ` : '') + '点一下导入它的书签'
          : esc(b.note || '格式暂不支持')}</span>
      </span>
      ${b.supported ? '<span class="lr-tail">导入</span>' : ''}
    </div>`).join('');
}

/* ------------------------------------------------------------------ *
 * 下载
 * ------------------------------------------------------------------ */

const DL_STATE = {
  queued: { label: '排队中', cls: 'is-queued' },
  probing: { label: '探测中', cls: 'is-active' },
  downloading: { label: '下载中', cls: 'is-active' },
  progress: { label: '下载中', cls: 'is-active' },
  paused: { label: '已暂停', cls: 'is-paused' },
  done: { label: '已完成', cls: 'is-done' },
  completed: { label: '已完成', cls: 'is-done' },
  error: { label: '失败', cls: 'is-error' },
  canceled: { label: '已取消', cls: 'is-canceled' },
  // Chromium 内建下载器沿用的原始状态名。
  // **progressing 也在这一列里**：Electron 的 session 'updated' 事件把 state
  // 原样透传，而那里的取值正是 'progressing' | 'interrupted' ——
  // 漏了它的话，网页里点下载链接（关掉「接管页面触发的下载」之后走的就是这条）
  // 会得到一个英文原文的 pill、没有进行中的高亮，而且因为它不在
  // activeDownloads() 的白名单里，这条任务**根本不会出现在地址栏旁的
  // 下载小窗与角标计数中** —— 下载在进行中，界面却当作没有。
  cancelled: { label: '已取消', cls: 'is-canceled' },
  interrupted: { label: '已中断', cls: 'is-error' },
  progressing: { label: '下载中', cls: 'is-active' }
};

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return sec + ' 秒';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${Math.floor(sec / 3600)} 时 ${Math.floor((sec % 3600) / 60)} 分`;
}

/**
 * 一条任务的完成比例（0..1）。
 *
 * <p>优先用 progress，**但一定要能自己从 received / total 兜出来** ——
 * 这条兜底不是多余的：Chromium 内建下载器那条路只给字节数，
 * 它的 progress 曾经一整个没写过，于是那条任务的进度条永远停在 0%，
 * 而旁边的字节数在动（用户报的就是「进度条不跟百分比走」）。
 * 主进程那边已经补上了，这里再兜一道：以后任何一处忘了写 progress，
 * 进度条也不会僵在那儿。
 */
function dlProgressOf(t) {
  if (t.progress > 0) return Math.min(1, t.progress);
  return t.total > 0 ? Math.min(1, Math.max(0, t.received / t.total)) : 0;
}

/**
 * 分片进度条 —— 这个界面里最重要的一个控件。
 * Chromium 自带下载器只有一个整条进度，看不出用了多少连接；
 * 这里一条分片画一格，谁快谁慢、有没有退化成单连接，一眼就能看出来。
 */
function dlSegments(t) {
  const chunks = t.chunks || [];
  if (!chunks.length) {
    // 还没探测出分片（排队 / 探测中），或者这条是 Chromium 内建下载器的任务
    const pct = Math.min(100, Math.round(dlProgressOf(t) * 100));
    return `<i class="dl-seg is-pending" title="尚未分片"><b style="width:${pct}%"></b></i>`;
  }
  const maxSize = Math.max(...chunks.map((c) => c.size || 1), 1);
  return chunks.map((c) => {
    const cls = c.state === 'done' ? 'is-done' : c.state === 'active' ? 'is-active' : 'is-pending';
    const w = Math.min(100, (c.progress || 0) * 100).toFixed(1);
    return `<i class="dl-seg ${cls}" style="flex-grow:${((c.size || 1) / maxSize).toFixed(3)}"
      title="分片 ${c.index + 1}/${chunks.length}　${fmtBytes(c.done)} / ${fmtBytes(c.size)}"><b style="width:${w}%"></b></i>`;
  }).join('');
}

/** 按任务状态给出可用的操作按钮 */
function dlActions(t) {
  const btn = (act, label, extra = '') =>
    `<button class="btn btn-sm" data-dl="${act}" data-id="${esc(t.id)}" ${extra}>${label}</button>`;
  const pathBtn = (act, label) => t.savePath
    ? `<button class="btn btn-sm" data-dl="${act}" data-path="${esc(t.savePath)}">${label}</button>` : '';

  switch (t.state) {
    case 'queued':
      return btn('cancel', '取消');
    case 'probing':
    case 'downloading':
    case 'progress':
      return btn('pause', '暂停') + btn('cancel', '取消');
    case 'paused':
      return btn('resume', '继续') + btn('cancel', '取消') + pathBtn('show', '定位');
    case 'error':
      return btn('retry', '重试') + pathBtn('show', '定位') + btn('remove', '移除');
    case 'canceled':
      return btn('retry', '重新下载') + btn('remove', '移除');
    case 'done':
    case 'completed':
      return `<button class="btn btn-sm btn-primary" data-dl="open" data-path="${esc(t.savePath || '')}">打开</button>`
        + pathBtn('show', '在文件夹中显示') + btn('remove', '移除');
    default:
      return btn('remove', '移除');
  }
}

function dlTaskRow(t) {
  const st = DL_STATE[t.state] || { label: t.state, cls: '' };
  const total = t.total > 0 ? t.total : 0;
  const pct = Math.round(dlProgressOf(t) * 100);
  const native = t.source === 'chromium' || t.source === 'fallback';

  const meta = [];
  meta.push(total ? `${fmtBytes(t.received)} / ${fmtBytes(total)}（${pct}%）` : fmtBytes(t.received));
  if (st.cls === 'is-active') {
    if (t.speed > 0) meta.push(fmtBytes(t.speed) + '/s');
    if (t.eta > 0) meta.push('剩余 ' + fmtEta(t.eta));
  }
  if (native) meta.push('Chromium 内建下载器');
  else if (t.ranged) meta.push(`${t.threads || 1} 线程并发`);
  else if (t.degraded) meta.push('单连接（分片请求被无视，已自动降级）');
  else if (t.state !== 'queued' && t.state !== 'probing') meta.push('单连接（服务端不支持分片）');

  const err = t.state === 'error' && t.error ? `<div class="dl-error">${esc(t.error)}</div>` : '';
  const where = t.savePath ? `<div class="dl-path" title="${esc(t.savePath)}">${esc(t.savePath)}</div>` : '';

  return `
    <div class="dl-task" data-task="${esc(t.id)}">
      <div class="dl-task-head">
        <span class="dl-name" title="${esc(t.url)}">${esc(t.filename || hostOf(t.url) || t.url)}</span>
        <span class="dl-pill ${st.cls}">${esc(st.label)}</span>
      </div>
      <div class="dl-segs">${dlSegments(t)}</div>
      <div class="dl-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
      ${err}${where}
      <div class="dl-actions">${dlActions(t)}</div>
    </div>`;
}

/**
 * 地址栏旁的下载小窗。
 *
 * 与「下载」设置分区（buildDownloads）共用同一份数据 state.downloads 与同一套
 * 行渲染 dlTaskRow —— 这里只是把它缩成「贴在地址栏右边、有下载才弹出来」的
 * 轻量形态，免得下载时非得钻进设置页看进度。行动按钮也是同一套 data-dl，
 * renderDownloadPopover 里直接复用 wireActions 把暂停 / 取消 / 打开都接上。
 */
function activeDownloads() {
  // progressing 必须在列：它是 Chromium 内建下载器的进行中状态（见 DL_STATE 注释），
  // 漏了它这条任务就不会进地址栏旁的浮窗与角标
  return (state.downloads || []).filter((t) =>
    ['probing', 'downloading', 'progress', 'progressing', 'queued', 'paused'].includes(t.state));
}

/** 更新地址栏下载图标的角标（进行中任务数）。 */
function renderDownloadPill() {
  const badge = $('#dl-count');
  if (!badge) return;
  const n = activeDownloads().length;
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

let dlPopTimer = null;
/** 节流刷新小窗列表（与下载设置页同理，避免 120ms 一次的进度事件把列表拆了重建）。 */
function refreshDownloadPopover(force) {
  const pop = $('#dl-popover');
  if (!pop) return;
  if (!force) {
    if (dlPopTimer) return;
    dlPopTimer = setTimeout(() => { dlPopTimer = null; refreshDownloadPopover(true); }, 300);
    return;
  }
  renderDownloadPopover();
}

function renderDownloadPopover() {
  const pop = $('#dl-popover');
  const list = pop && $('#dl-pop-list');
  if (!list) return;
  const items = activeDownloads();
  // 没有进行中的任务时，把最近一条已完成的也留着，免得「下完去哪看」没着落
  const show = items.length
    ? items
    : (state.downloads || []).filter((t) => ['done', 'completed'].includes(t.state)).slice(0, 1);
  list.innerHTML = show.length
    ? show.map(dlTaskRow).join('')
    : '<div class="dl-pop-empty">没有进行中的下载</div>';
  wireActions(list);
}

async function buildDownloads() {
  // 拉一份最新的：进度事件可能在别处丢过，进分区时以主进程为准
  try {
    state.downloads = await bridge.downloads.list();
    state.downloadStats = await bridge.downloads.stats();
    state.downloadsDir = await bridge.downloads.dir();
  } catch { /* 预览模式或主进程未就绪，用已有缓存 */ }

  const list = state.downloads || [];
  const prefs = (state.settings && state.settings.download) || {};
  const takeOver = prefs.takeOver !== false;
  const threads = prefs.threads || 8;
  const conc = prefs.maxConcurrent || 3;
  const st = state.downloadStats
    || (() => {
      const active = list.filter((t) => ['probing', 'downloading', 'progress'].includes(t.state)).length;
      const done = list.filter((t) => ['done', 'completed'].includes(t.state)).length;
      const error = list.filter((t) => t.state === 'error').length;
      const speed = list.reduce((a, t) => a + (t.speed || 0), 0);
      return { active, done, error, speed, queued: 0, total: list.length };
    })();

  const active = list.filter((t) => ['probing', 'downloading', 'progress', 'queued', 'paused'].includes(t.state));
  const finished = list.filter((t) => ['done', 'completed', 'canceled', 'error'].includes(t.state));

  const seg = (id, values, current, fmt) => `
    <div class="segmented" id="${id}">
      ${values.map((v) => `<button data-v="${v}" class="${v === current ? 'is-active' : ''}">${fmt ? fmt(v) : v}</button>`).join('')}
    </div>`;

  return `
    <h2 class="sv-h2">下载</h2>
    <div class="sv-lead">吾爱Nova 多线程引擎：把文件按 Range 切成多段并发拉取，各段直接写到目标文件的对应偏移，最后无需合并。</div>

    <div class="dl-engine">
      <div class="dl-engine-head">
        <span class="dl-engine-title">吾爱Nova 多线程下载引擎</span>
        <span class="dl-pill ${takeOver ? 'is-active' : 'is-canceled'}">${takeOver ? '接管中' : '已关闭'}</span>
      </div>
      <div class="dl-stats">
        <div class="dl-stat"><b>${fmtNum(st.active || 0)}</b><span>进行中</span></div>
        <div class="dl-stat"><b>${st.speed > 0 ? fmtBytes(st.speed) + '/s' : '—'}</b><span>合计速度</span></div>
        <div class="dl-stat"><b>${fmtNum(st.done || 0)}</b><span>已完成</span></div>
        <div class="dl-stat"><b>${fmtNum(st.error || 0)}</b><span>失败</span></div>
      </div>
      <div class="dl-engine-note">
        ${takeOver
          ? '页面触发的下载会被接管到本引擎；引擎一个字节都拿不到时会自动交回 Chromium 内建下载器。'
          : '当前未接管，页面下载走 Chromium 内建单连接下载器。'}
        服务端不支持 Range 时自动退化为单连接，不会因此下载失败。
      </div>
    </div>

    <div class="panel-label">并发线程数（每个任务）</div>
    ${seg('dl-threads', [1, 4, 8, 16], threads)}
    <div class="muted" style="padding-bottom:var(--sp-3)">分片过碎反而更慢，实测 4~8 条连接收益最高；上限 16。</div>

    <div class="panel-label">同时进行的任务数</div>
    ${seg('dl-conc', [1, 2, 3, 5], conc)}

    <div class="sv-card" style="margin-top:var(--sp-3)">
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">接管页面触发的下载</span>
          <span class="lr-sub">关闭后一律使用 Chromium 内建下载器</span>
        </span>
        <button class="switch ${takeOver ? 'is-on' : ''}" data-dlcfg="takeOver"></button>
      </div>
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">下载目录</span>
          <span class="lr-sub">${esc(state.downloadsDir || '系统默认下载目录')}</span>
        </span>
        <button class="btn btn-sm" data-act="dl-choose-dir">更改</button>
        <button class="btn btn-sm" data-act="dl-open-dir">打开</button>
      </div>
    </div>

    <div class="panel-label">新建下载</div>
    <div class="dl-new">
      <input id="dl-url" placeholder="粘贴文件地址（http / https）" spellcheck="false" value="${esc(state.dlDraft)}" />
      <button class="btn btn-primary" data-act="dl-start">开始下载</button>
    </div>

    ${active.length ? `
      <div class="panel-label">进行中（${active.length}）</div>
      <div class="sv-card">${active.map(dlTaskRow).join('')}</div>` : ''}

    ${finished.length ? `
      <div class="panel-label dl-label-row">
        <span>已完成与历史（${finished.length}）</span>
        <button class="btn btn-sm" data-act="dl-clear">清除记录</button>
      </div>
      <div class="sv-card">${finished.map(dlTaskRow).join('')}</div>` : ''}

    ${list.length ? '' : '<div class="sv-empty">还没有下载任务。在上面的输入框粘贴一个文件地址试试，或者在网页里点任意下载链接。</div>'}
  `;
}

/**
 * 内核二进制一览：把「真内核下到哪一步了」摊开给用户看。
 * 数据来自 native/engines/manifest.json（tools/check-engines.js 生成），
 * 含每个发行版的版本、体积与 PE 特征识别结果。读不到清单时返回一行说明。
 */
function renderKernelBinaries() {
  const rows = state.engines.filter((e) => e.kernel);
  if (!rows.length) {
    return `<div class="muted">未找到内核清单（<code>native/engines/manifest.json</code>）。<br />
      运行 <code>node tools/check-engines.js</code> 生成。</div>`;
  }

  const mb = (n) => (n / 1048576).toFixed(0) + ' MB';
  return rows.map((e) => {
    const k = e.kernel;
    const head = k.binariesReady
      ? (k.bridgeReady ? '<span class="ok-text">原生桥接</span>' : '<span class="warn-text">二进制就位 · 待宿主编译</span>')
      : '<span class="muted">未下载</span>';

    const src = (k.sources || []).map((s) => {
      const sig = s.signature && s.signature.detected
        ? `　<span class="muted">PE ${esc(s.signature.arch || '')} · ${esc(s.signature.detected)}</span>`
        : '';
      return `<div class="kb-src ${s.complete ? '' : 'is-missing'}">
        <span class="kb-mark">${s.complete ? '✓' : '✗'}</span>
        <span class="kb-body">
          <span class="kb-name">${esc(s.label)}${sig}</span>
          <span class="kb-meta">${esc(s.version || '')}${s.fileCount ? `　${s.fileCount} 文件 / ${mb(s.sizeBytes)}` : ''}</span>
        </span>
      </div>`;
    }).join('');

    const note = k.blocker
      ? `<div class="kb-note">${esc(k.blocker)}</div>`
      : '';

    return `<div class="kb-group">
      <div class="kb-head">
        <span class="kb-title">${esc(e.label)}</span>
        <span class="kb-arch">${esc(k.arch || '')}</span>
      </div>
      <div class="kb-status">${head}</div>
      ${src}
      ${note}
    </div>`;
  }).join('');
}

/** 预设搜索引擎 —— 值就是 searchTemplate，界面上按模板反查当前项 */
const SEARCH_PRESETS = [
  { label: '百度', tpl: 'https://www.baidu.com/s?wd=%s' },
  { label: '必应', tpl: 'https://www.bing.com/search?q=%s' },
  { label: 'Google', tpl: 'https://www.google.com/search?q=%s' }
];

function buildGeneral() {
  const s = state.settings;
  const ntpMode = NovaNtpHost.modeOf(s.newTabPage);
  // 「与主页相同」那个按钮的置灰判据有两个来源：新的具名取值 homepage，
  // 以及桌面端历史上的「自定义地址，但填的恰好就是主页」。两种都算跟随。
  const followsHome = ntpMode === 'homepage' || (s.newTabPage || s.homepage) === s.homepage;
  // 输入框就是「自定义地址」那一栏；档位是三种具名取值时它显示主页地址 ——
  // 用户想从「内置」切回一个具体网址时，起点不该是一串 'start'。
  const ntpAddress = ntpMode === 'custom' ? s.newTabPage : s.homepage;
  const sessCount = (s.session && Array.isArray(s.session.tabs)) ? s.session.tabs.length : 0;

  return `
    <h2 class="sv-h2">常规</h2>
    <div class="sv-lead">主页、新标签页与地址栏搜索。改动即时生效，并原子写入 nova-settings.json。</div>

    <div class="panel-label">主页</div>
    <div class="field"><input id="set-homepage" value="${esc(s.homepage)}" spellcheck="false" /></div>
    <div class="muted" style="padding-bottom:var(--sp-3)">点「主页」按钮、以及启动时的第一个标签页打开的地址。</div>

    <div class="panel-label">新标签页</div>
    <div class="panel-section">
      <div class="segmented" id="set-newtab-mode">
        <button data-act="newtab-builtin" class="${ntpMode === 'start' ? 'is-active' : ''}">内置</button>
        <button data-act="newtab-homepage" class="${ntpMode === 'homepage' ? 'is-active' : ''}">主页</button>
        <button data-act="newtab-blank" class="${ntpMode === 'blank' ? 'is-active' : ''}">空白</button>
      </div>
      <div class="muted" style="padding:var(--sp-2) 0 0">「内置」是随应用自带的一页：品牌区 + 快捷方式九宫格，按访问次数自动排；长按或右键图标可以删掉不要的。与移动端共用同一份源。</div>
    </div>
    <div class="field"><input id="set-newtab" value="${esc(ntpAddress)}" spellcheck="false" /></div>
    <div class="btn-row" style="padding-top:0">
      <button class="btn" data-act="newtab-same" ${followsHome ? 'disabled' : ''}>与主页相同</button>
      <span class="lr-sub" style="align-self:center">当前：${ntpModeLabel()}</span>
    </div>

    <div class="panel-label">默认内核</div>
    <div class="panel-section">
      <div class="segmented" id="set-engine">
        ${state.engines.map((e) => `<button data-engine="${e.id}" class="${s.defaultEngine === e.id ? 'is-active' : ''}">${esc(e.label)}</button>`).join('')}
      </div>
      <div class="muted" style="padding:var(--sp-2) 0 0">只影响新建标签页；已有标签页的内核在地址栏右侧单独切换。</div>
    </div>

    <div class="panel-label">地址栏搜索</div>
    <div class="panel-section">
      <div class="segmented" id="set-search-preset">
        ${SEARCH_PRESETS.map((p) => `<button data-tpl="${esc(p.tpl)}" class="${s.searchTemplate === p.tpl ? 'is-active' : ''}">${esc(p.label)}</button>`).join('')}
      </div>
    </div>
    <div class="field"><input id="set-search" value="${esc(s.searchTemplate)}" spellcheck="false" /></div>
    <div class="muted" style="padding-bottom:var(--sp-3)">
      <code>%s</code> 会被替换成搜索词。当前示例：${esc(searchUrl('nova'))}
    </div>

    <div class="panel-label">启动</div>
    <div class="sv-card">
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">恢复上次会话</span>
          <span class="lr-sub">启动时重新打开关闭前的标签页${sessCount ? `（已记录 ${sessCount} 个地址）` : ''}</span>
        </span>
        <button class="switch ${s.restoreSession ? 'is-on' : ''}" data-cfg="restoreSession"></button>
      </div>
    </div>
  `;
}

function buildAppearance() {
  const s = state.settings;
  const pref = s.layout || 'auto';
  // 用规整后的档位画选中态，而不是 s.bookmarkBar 的原值 —— 配置里写着
  // 别的字时，界面上显示的应该就是它实际的表现（常驻）。
  const bmbar = bmBarMode();
  return `
    <h2 class="sv-h2">外观</h2>
    <div class="sv-lead">布局档位决定外壳形态（宽档：顶栏三行 ＋ 收藏夹栏；窄档：底栏 ＋ 标签总览）。收藏夹栏两档都有，差别只在样式宽窄。主题同时写入 Electron 的 nativeTheme。</div>

    <div class="panel-label">布局</div>
    <div class="panel-section">
      <div class="segmented" id="set-layout">
        <button data-layout="auto" class="${pref === 'auto' ? 'is-active' : ''}">跟随窗口</button>
        <button data-layout="desktop" class="${pref === 'desktop' ? 'is-active' : ''}">桌面端</button>
        <button data-layout="mobile" class="${pref === 'mobile' ? 'is-active' : ''}">移动端</button>
      </div>
      <div class="muted" style="padding:var(--sp-2) 0 0">
        当前档位：${esc(pref)}；实际生效：${esc(state.layout)}。窗口宽度 &lt; ${MOBILE_BREAKPOINT}px 时「跟随窗口」判为移动端。
      </div>
    </div>

    <div class="panel-label">主题</div>
    <div class="panel-section">
      <div class="segmented" id="set-theme">
        <button data-theme="light" class="${s.theme === 'light' ? 'is-active' : ''}">浅色</button>
        <button data-theme="dark" class="${s.theme === 'dark' ? 'is-active' : ''}">深色</button>
      </div>
    </div>

    <div class="panel-label">收藏夹栏位置</div>
    <div class="panel-section">
      <div class="segmented" id="set-bmbar">
        <button data-bmbar="always" class="${bmbar === 'always' ? 'is-active' : ''}">地址栏下方</button>
        <button data-bmbar="ntp" class="${bmbar === 'ntp' ? 'is-active' : ''}">仅新标签页</button>
        <button data-bmbar="hidden" class="${bmbar === 'hidden' ? 'is-active' : ''}">不显示</button>
      </div>
      <div class="muted" style="padding:var(--sp-2) 0 0">
        这条栏只有一处可放：地址栏与网页之间（再往上就是标签条）。所以这一项实际管的是
        <b>什么时候露出来</b> —— 「仅新标签页」在浏览网页时会把这一行高度还给页面。
        当前：${esc(BM_BAR_LABEL[bmbar])}，${(state.bookmarks || []).length} 条书签。
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ *
 * 移动端阅读增强：无图模式 / 自动拼页
 * ------------------------------------------------------------------ */

/**
 * 无图档位。
 * 这里再列一份 label 是为了让分段控件在拿不到主进程快照时也能画出来
 * （预览模式、IPC 还没回来的时候）。真正的判定与计数全在主进程，界面不算数。
 */
const NOIMAGE_LEVELS = [
  { id: 'off', label: '关闭', hint: '图片正常加载' },
  { id: 'image', label: '无图', hint: '拦下所有图片请求' },
  { id: 'image-av', label: '无图 + 视频', hint: '再停掉音视频的自动加载' }
];

const AUTOPAGE_MAX = [5, 10, 20];

function mobilePref() {
  const m = state.settings.mobile || {};
  return {
    noImage: m.noImage || 'off',
    autoPage: !!m.autoPage,
    autoPageMax: m.autoPageMax || 10
  };
}

function noImageLevel() {
  return mobilePref().noImage;
}

function noImageLabel(level) {
  const hit = NOIMAGE_LEVELS.find((l) => l.id === (level || noImageLevel()));
  return hit ? hit.label : '关闭';
}

/** 无图快照。主进程还没回话时给一份零值，免得模板里到处判空 */
function nm() {
  return state.noMedia || {
    level: noImageLevel(),
    label: noImageLabel(),
    types: [],
    blocked: 0,
    byType: { image: 0, media: 0 },
    tabBlocked: 0,
    pageAllowed: false
  };
}

function apSubtitle(ap, m) {
  if (!m.autoPage) return '已关闭';
  if (!ap) return '已开启 · 打开页面后生效';
  if (ap.error) return '上次失败：' + ap.error;
  if (ap.pages > 0) return `本页已拼接 ${ap.pages} 页` + (ap.hasNext ? ' · 还有下一页' : ' · 已到底');
  if (ap.hasNext) return '已就绪 · 滚到底开始拼接';
  return '本页没找到下一页';
}

function buildMobile() {
  const m = mobilePref();
  const st = nm();
  const on = m.noImage !== 'off';
  const cur = NOIMAGE_LEVELS.find((l) => l.id === m.noImage) || NOIMAGE_LEVELS[0];
  const ap = state.autoPageStatus;

  return `
    <h2 class="sv-h2">移动端</h2>
    <div class="sv-lead">
      为小屏准备的两件事：<b>无图模式</b>在请求发出的那一刻就把图片掐掉（不是加载完再藏起来，
      那种做法一个字节也没省），<b>自动拼页</b>把 <code>/p1 /p2 /p3</code> 这样的分页长文接成一整篇。
      两项默认都关着 —— 一上来就没有图，很多人会以为浏览器坏了。
    </div>

    <div class="panel-label">无图模式</div>
    <div class="panel-section">
      <div class="segmented" id="nm-level">
        ${NOIMAGE_LEVELS.map((l) => `<button data-level="${l.id}" class="${m.noImage === l.id ? 'is-active' : ''}">${esc(l.label)}</button>`).join('')}
      </div>
      <div class="muted" style="padding:var(--sp-2) 0 0">
        当前：${esc(cur.hint)}。切换后当前标签页会自动重载 —— 已经发出去的请求拦不回来，
        不重载界面状态就对不上。
      </div>
    </div>

    <div class="panel-label">本次拦截</div>
    <div class="sv-card">
      <div class="kv"><span>图片</span><b>${fmtNum(st.byType.image || 0)}</b></div>
      <div class="kv"><span>音视频</span><b>${fmtNum(st.byType.media || 0)}</b></div>
      <div class="kv"><span>当前标签页</span><b>${fmtNum(st.tabBlocked || 0)}</b></div>
    </div>
    <div class="muted" style="padding:var(--sp-2) 0 var(--sp-3)">
      只统计条数，没有「省下多少 MB」—— 被拦下的请求压根没有响应头，
      Content-Length 无从得知。按平均图片大小估一个数很好看，但那是编的。
    </div>
    <div class="btn-row">
      <button class="btn" data-act="nm-show-images" ${on && activeTab() ? '' : 'disabled'}>显示本页图片</button>
      <button class="btn" data-act="nm-reset">重置计数</button>
    </div>

    <div class="panel-label">自动拼页</div>
    <div class="sv-card">
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">滚到底自动接下一页</span>
          <span class="lr-sub">${esc(apSubtitle(ap, m))}</span>
        </span>
        <button class="switch ${m.autoPage ? 'is-on' : ''}" data-ap="autoPage"></button>
      </div>
    </div>

    <div class="panel-label">单次最多拼几页</div>
    <div class="panel-section">
      <div class="segmented" id="ap-max">
        ${AUTOPAGE_MAX.map((v) => `<button data-max="${v}" class="${m.autoPageMax === v ? 'is-active' : ''}">${v} 页</button>`).join('')}
      </div>
      <div class="muted" style="padding:var(--sp-2) 0 0">
        上限是防呆，不是性能考虑：有些站点的「下一页」实际指向另一篇毫不相干的文章，
        不封顶会一路拼下去。
      </div>
    </div>

    <div class="panel-label">边界</div>
    <div class="sv-card">
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">字体不会被拦</span>
          <span class="lr-sub">大量站点的界面图标就是字体，拦掉页面直接散架，省下的字节却不值当</span>
        </span>
      </div>
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">标签页图标放行</span>
          <span class="lr-sub">这是启发式名单（路径含 favicon 或以 .ico 结尾），不是标准 —— 宁可放宽</span>
        </span>
      </div>
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">跨域分页拼不了</span>
          <span class="lr-sub">下一页在不同域名时会被 CORS 挡下，此时会如实报错并停下，不会静默失败</span>
        </span>
      </div>
    </div>
  `;
}

/** 底部弹层：移动端把这两个开关收在一处，不挤底栏 */
function renderReadSheet() {
  const body = $('#read-sheet-body');
  if (!body) return;

  const m = mobilePref();
  const st = nm();
  const t = activeTab();
  const ap = state.autoPageStatus;

  body.innerHTML = `
    <div class="panel-label">无图模式</div>
    <div class="segmented" id="rs-nm">
      ${NOIMAGE_LEVELS.map((l) => `<button data-level="${l.id}" class="${m.noImage === l.id ? 'is-active' : ''}">${esc(l.label)}</button>`).join('')}
    </div>
    <div class="rs-note">
      图片在请求发出前就被拦下，省的是真流量。本次已拦 <b>${fmtNum(st.blocked)}</b> 张
      ${st.pageAllowed ? '· <b>本页已放行</b>' : ''}
    </div>
    ${m.noImage !== 'off' ? `
      <button class="btn" data-act="rs-show-images" ${t ? '' : 'disabled'} style="width:100%;margin-top:var(--sp-2)">
        显示本页图片（放行后重载）
      </button>` : ''}

    <div class="panel-label" style="padding-top:var(--sp-4)">自动拼页</div>
    <div class="list-row">
      <span class="lr-main">
        <span class="lr-title">滚到底自动接下一页</span>
        <span class="lr-sub">${esc(apSubtitle(ap, m))}</span>
      </span>
      <button class="switch ${m.autoPage ? 'is-on' : ''}" data-ap="autoPage"></button>
    </div>
    <div class="segmented" id="rs-apmax" style="margin-top:var(--sp-2)">
      ${AUTOPAGE_MAX.map((v) => `<button data-max="${v}" class="${m.autoPageMax === v ? 'is-active' : ''}">最多 ${v} 页</button>`).join('')}
    </div>
    <div class="rs-note">
      拼接后页面底部会出现一条状态条，上面就能「停止」或「撤销」。
      有些站点的「下一页」其实指向另一篇文章，所以封了顶。
    </div>
  `;

  body.querySelectorAll('#rs-nm button').forEach((b) => {
    b.addEventListener('click', () => applyNoImage(b.dataset.level));
  });
  body.querySelectorAll('#rs-apmax button').forEach((b) => {
    b.addEventListener('click', () => applyAutoPageMax(Number(b.dataset.max)));
  });
  const apSwitch = body.querySelector('[data-ap="autoPage"]');
  if (apSwitch) {
    apSwitch.addEventListener('click', () => applyAutoPage(!apSwitch.classList.contains('is-on')));
  }
  const showBtn = body.querySelector('[data-act="rs-show-images"]');
  if (showBtn) showBtn.addEventListener('click', showPageImages);
}

function openReadSheet() {
  closeDrawer();
  closeSheet();
  $('#read-sheet').hidden = false;
  renderReadSheet();
  // 弹层打开时才去问页面内脚本，平时不做无谓的 executeJavaScript
  readAutoPageStatus().then(() => { if (!$('#read-sheet').hidden) renderReadSheet(); });
}

function closeReadSheet() {
  const sheet = $('#read-sheet');
  if (sheet) sheet.hidden = true;
}

/** 切换无图档位。档位真变了就重载当前页 —— 不重载，界面显示的状态和实际不符 */
async function applyNoImage(level) {
  const next = NOIMAGE_LEVELS.some((l) => l.id === level) ? level : 'off';
  const prev = noImageLevel();
  if (prev === next) return;

  state.settings.mobile = Object.assign({}, mobilePref(), { noImage: next });
  await bridge.settings.patch({ mobile: { noImage: next } });

  const t = activeTab();
  if (t && t.webview && typeof t.webview.reload === 'function') {
    state.autoPageStatus = null;
    t.webview.reload();
  }
  toast(next === 'off' ? '无图模式已关闭 · 正在重载当前页' : `${noImageLabel(next)}已开启 · 正在重载当前页`);
  refreshCurrent();
}

/**
 * 扩展开启/停用后，重载所有 chromium 内核的打开标签页。
 *
 * <p><b>为什么必须重载</b>：Electron 的 `loadExtension` / `removeExtension`
 * 只对**之后的导航**生效 —— 当前已打开的页不会变；而且 `removeExtension`
 * 之后，那一支 content script 已经注入了，会**残留在打开的页里**不被卸载。
 * 不重载的话，用户拨一下开关、盯着手上正在看的页啥都没变，会以为开关是
 * 摆设（这正是被反馈「开启按钮有了，功能没实现」的根因）。
 *
 * <p>真实浏览器也是这个行为：切换扩展会重载受影响的标签页。这里只重载
 * chromium 内核的（扩展只装载在 persist:nova-chromium 这一个 session 上，
 * 其它内核的页本来就不受扩展影响，重了也是白重、还白丢一页状态）。 */
function reloadChromiumTabs() {
  for (const t of (state.tabs || [])) {
    if (!t || t.engineId !== 'chromium') continue;
    if (t.webview && typeof t.webview.reload === 'function') {
      try { t.webview.reload(); } catch { /* 正在销毁的标签页，跳过 */ }
    }
  }
}

async function applyAutoPage(on) {
  state.settings.mobile = Object.assign({}, mobilePref(), { autoPage: !!on });
  await bridge.settings.patch({ mobile: { autoPage: !!on } });

  const t = activeTab();
  if (on) {
    // 已经打开的页面不用等重载，直接注入就行
    injectAutoPage(t);
    toast('已开启自动拼页');
    // 页面内脚本 boot 有几百毫秒延迟，等一下再去读状态
    setTimeout(() => { readAutoPageStatus().then(() => refreshCurrent()); }, 900);
  } else {
    // 关掉只是让它别再拼新的；已经接上去的内容由页面上的「撤销」负责清理
    if (t && t.webview && typeof t.webview.executeJavaScript === 'function') {
      try {
        t.webview.executeJavaScript(
          '(function(){var a=window.__novaAutoPage;if(a&&a.stop)a.stop();return "stopped";})()'
        );
      } catch { /* 页面可能已经销毁 */ }
    }
    state.autoPageStatus = null;
    toast('已关闭自动拼页');
  }
  refreshCurrent();
}

async function applyAutoPageMax(v) {
  const max = AUTOPAGE_MAX.includes(v) ? v : 10;
  state.settings.mobile = Object.assign({}, mobilePref(), { autoPageMax: max });
  await bridge.settings.patch({ mobile: { autoPageMax: max } });
  toast(`单次最多拼 ${max} 页 · 下次加载生效`);
  refreshCurrent();
}

/** 放行本页图片。放行之后必须重载，已经被拦掉的请求不会自己回来 */
async function showPageImages() {
  const t = activeTab();
  if (!t) { toast('没有打开的标签页'); return; }
  if (t.wcId == null) { toast('标签页还没就绪，稍候再试'); return; }

  try {
    const st = await bridge.mobile.showImages(t.wcId);
    if (st) state.noMedia = st;
  } catch { /* 预览模式下桥是空壳 */ }

  if (t.webview && typeof t.webview.reload === 'function') t.webview.reload();
  toast('已放行本页图片 · 正在重载');
  refreshCurrent();
}

/**
 * 往标签页里注入自动拼页脚本。
 * 注入的是 autopage.js 里那份算法序列化出来的字符串 —— 与 Node 测试跑的是同一份源码。
 */
function injectAutoPage(tab) {
  if (state.isPreview) return false;
  if (!mobilePref().autoPage) return false;
  if (!tab || !tab.webview) return false;
  // 本地页面不注入。内置新标签页上没有「下一页」这回事，而注入的脚本
  // 会先在 body 上做一遍正文容器打分 —— 白花几百毫秒，还可能因为
  // 那一页的九宫格结构挑出一个莫名其妙的容器。about:blank 同理。
  if (!/^https?:/i.test(tab.url || '')) return false;
  if (typeof tab.webview.executeJavaScript !== 'function') return false;

  const AP = window.NovaAutoPage;
  if (!AP || typeof AP.buildScript !== 'function') return false;

  try {
    const p = tab.webview.executeJavaScript(AP.buildScript({ maxPages: mobilePref().autoPageMax }));
    if (p && typeof p.catch === 'function') p.catch(() => { /* 注入失败不影响浏览 */ });
    return true;
  } catch {
    return false;
  }
}

/** 回读页面内拼页脚本的状态。没有注入过、或页面已经换掉，都会拿到 null */
async function readAutoPageStatus() {
  const t = activeTab();
  if (!t || !t.webview || typeof t.webview.executeJavaScript !== 'function') {
    state.autoPageStatus = null;
    return null;
  }
  try {
    const raw = await t.webview.executeJavaScript(
      '(function(){var a=window.__novaAutoPage;return a?a.status():null;})()'
    );
    state.autoPageStatus = raw || null;
  } catch {
    state.autoPageStatus = null;
  }
  return state.autoPageStatus;
}

function buildEngines() {
  return `
    <h2 class="sv-h2">内核</h2>
    <div class="sv-lead">
      三档运行时：<b>native</b>（进程内真实 Blink）/ <b>bridge</b>（原生宿主进程，NDJSON over stdio）/
      <b>compat</b>（兼容层：Chromium 渲染 + 伪造 UA 与 API 垫片）。探测不到宿主的绝不假装成真内核。
    </div>

    <div class="panel-label">当前状态</div>
    <div class="sv-card">
      ${state.engines.map((e) => `
      <div class="list-row">
        <span class="lr-icon"><span class="engine-dot" style="--engine-color:${e.accent}"></span></span>
        <span class="lr-main">
          <span class="lr-title">${esc(e.label)}</span>
          <span class="lr-sub">${esc(e.partition)} · ${esc(e.vendor)}</span>
        </span>
        <span class="mode-pill mode-${e.mode}">${esc(e.modeLabel)}</span>
      </div>`).join('')}
    </div>

    <div class="panel-label">内核二进制</div>
    <div class="panel-section">
      ${renderKernelBinaries()}
    </div>

    <div class="panel-label">内核桥接</div>
    <div class="panel-section">
      <button class="btn" data-act="probe-engine" style="width:100%">重新探测原生内核宿主</button>
      <div class="muted" style="padding:var(--sp-2) 0 0">
        把 <code>gecko-host.exe</code> / <code>trident-host.exe</code> 放进
        <code>native/bin/</code> 后重新探测，对应内核会从「兼容层」升级为「原生桥接」。<br />
        抓取内核：<code>bash tools/fetch-engines.sh</code>　校验：<code>node tools/check-engines.js</code>
      </div>
    </div>
  `;
}

/**
 * 更新状态 → 那一块 HTML。
 *
 * <p>**只有这一份**。「关于」面板与工具栏的更新小窗显示的是同一件事，
 * 各写一份必然漂移 —— 事实上就漂移过：把「差分更新」改成「下完整安装包」时，
 * 只改了「关于」那份，小窗里还留着「只下变化的那部分」这种与事实相反的说法，
 * 而用户很可能先看到的就是小窗。
 *
 * <p>（原来这里还写着「照抄顶栏浮层那套状态机」—— 知道有风险还是抄了，
 * 然后就被这个风险咬了一口。所以这次不是再抄一遍，而是抽出来共用。）
 *
 * @param {object} u state.update
 * @returns {string} 状态相关的 HTML 片段
 */
function updateStatusHtml(u) {
  const notes = Array.isArray(u.info && u.info.notes) && u.info.notes.length
    ? `<ul class="up-notes">${u.info.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
    : '';

  if (u.status === 'checking') {
    // 这一档一闪而过，除了这句话不放别的：塞太多会让人以为卡住了
    return '<p class="up-none">正在检查更新…</p>';
  }

  if (u.status === 'error') {
    return `<p class="up-err">检查失败：${esc(u.error || '未知原因')}</p>
      <button class="btn" data-up="check">重试</button>`;
  }

  if (u.status === 'downloading') {
    const pct = Math.round(u.percent || 0);
    return `<div class="up-ver">正在下载 ${esc((u.info && u.info.version) || '')}</div>
      <div class="up-bar"><i style="width:${pct}%"></i></div>
      <p class="up-none">${pct}%${u.speed ? ` · ${fmtBytes(u.speed)}/s` : ''}。下载完会校验 sha256，校验不过会丢弃重来。</p>`;
  }

  if (u.status === 'ready') {
    // 自动安装开着时界面上已经挂了倒计时条（#update-now），
    // 这里就不再说「重启后生效」那种含糊话 —— 说清「马上就要重启」。
    const auto = updatePref().autoInstall && !u.autoInstallCancelled;
    return `<div class="up-ver">${esc((u.info && u.info.version) || '')} 已下载完毕</div>
      <p class="up-none">${auto ? '即将重启并拉起安装器。' : '重启后生效。'}当前页面里未保存的内容会丢失。</p>
      <button class="btn btn-primary" data-up="install">重启并安装</button>`;
  }

  if (u.status === 'available') {
    /* **失败原因必须显示出来。**
     * 下载失败后主进程会把状态退回 available（而不是留在 downloading），
     * 于是这一档会被重画 —— 原先不读 u.error，用户点一次「下载更新」失败、
     * 界面纹丝不动，看起来就像那个按钮坏了。 */
    const size = (u.info && u.info.size)
      ? `${(u.info.size / 1024 / 1024).toFixed(1)} MB`
      : '';
    return `<div class="up-ver">新版本 ${esc((u.info && u.info.version) || '')}</div>
      ${u.error ? `<p class="up-err">下载失败：${esc(u.error)}</p>` : ''}
      ${size ? `<p class="up-none">安装包 ${esc(size)}</p>` : ''}
      ${notes}
      <div class="up-actions">
        <button class="btn btn-primary" data-up="download">${u.error ? '重试下载' : '下载更新'}</button>
        <button class="btn" data-up="later">稍后再说</button>
      </div>`;
  }

  /* idle：没有待处理的更新。
   * **不写「当前已是最新版本」** —— 检查失败时状态落在 error 档，
   * 而这一档的语义是「还没查过」，把两者说成同一句就是不准确的。 */
  return `<p class="up-none">${u.lastCheckAt
    ? `上次检查：${esc(fmtWhen(u.lastCheckAt))}。`
    : '尚未检查过。'}</p>
    <button class="btn" data-up="check">检查更新</button>`;
}

function buildAbout() {
  const v = state.__versions || {};
  const u = state.update || {};
  const pre = updatePref();
  const updBlock = `<div data-up-block>${updateStatusHtml(u)}</div>`;

  return `
    <h2 class="sv-h2">关于吾爱Nova</h2>
    <div class="panel-section" style="text-align:center;padding-top:var(--sp-2)">
      <div class="es-mark" style="margin:0 auto var(--sp-3)">N</div>
      <div style="font-size:16px;font-weight:600">吾爱Nova浏览器</div>
      <div class="muted" style="padding-top:var(--sp-1)">多内核 · 双端 · 内置广告拦截</div>
    </div>

    <div class="panel-label">检查更新</div>
    <div class="sv-card">${updBlock}</div>

    <!-- 自动更新的两个开关。
         放在「检查更新」这块下面而不是另起一个设置分区：它们调的就是上面
         那套流程的行为，摆在一起才读得出「关掉它，上面那个就要自己点」。 -->
    <div class="sv-card" style="margin-top:12px">
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">自动检查并下载更新</span>
          <span class="lr-sub">发现新版本就自己下载（下完会自动校验完整性）</span>
        </span>
        <button class="switch ${pre.autoDownload ? 'is-on' : ''}" data-upcfg="autoDownload"
                title="${pre.autoDownload ? '已开启' : '已关闭'}"></button>
      </div>
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">下载完成后自动重启安装</span>
          <span class="lr-sub">会重启浏览器，当前页面里未保存的内容会丢失（有 8 秒可喊停）</span>
        </span>
        <button class="switch ${pre.autoInstall ? 'is-on' : ''}" data-upcfg="autoInstall"
                title="${pre.autoInstall ? '已开启' : '已关闭'}"></button>
      </div>
    </div>

    <div class="panel-label">运行时</div>
    <div class="sv-card">
      <div class="kv"><span>版本</span><b>${esc(upVer())}</b></div>
      <div class="kv"><span>Electron</span><b>${esc(v.electron || '-')}</b></div>
      <div class="kv"><span>Chromium</span><b>${esc(v.chrome || '-')}</b></div>
      <div class="kv"><span>Node</span><b>${esc(v.node || '-')}</b></div>
      <div class="kv"><span>平台</span><b>${esc(state.platform || '-')}</b></div>
    </div>

    <div class="panel-label">内核状态</div>
    <div class="sv-card">
      ${state.engines.map((e) => `
      <div class="list-row">
        <span class="lr-icon"><span class="engine-dot" style="--engine-color:${e.accent}"></span></span>
        <span class="lr-main"><span class="lr-title">${esc(e.label)}</span><span class="lr-sub">${esc(e.vendor)}</span></span>
        <span class="mode-pill mode-${e.mode}">${esc(e.modeLabel)}</span>
      </div>`).join('')}
    </div>

    <div class="sv-note">
      渲染载体：每个内核一份独立 session（Cookie / 缓存 / UA 全隔离）。
      当前 shell 由 Electron 自带 Blink 承载；Gecko 与 Trident 的真内核二进制已在
      <code>native/engines/</code> 就位，但缺原生宿主程序，因此标为「兼容层」而非「原生内核」。
    </div>
  `;
}

/* ------------------------------------------------------------------ *
 * 设置页：导航 / 分区调度
 * ------------------------------------------------------------------ */

/** 左侧导航：分组 → 条目。count 是可选的实时角标。 */
const SETTINGS_NAV = [
  { group: '浏览器', items: [
    { id: 'general', label: '常规', icon: 'gear' },
    { id: 'appearance', label: '外观', icon: 'palette' },
    { id: 'mobile', label: '移动端', icon: 'phone',
      count: () => (mobilePref().noImage !== 'off' || mobilePref().autoPage ? '开' : '') },
    { id: 'engines', label: '内核', icon: 'chip' }
  ] },
  { group: '内容', items: [
    { id: 'adblock', label: '广告拦截', icon: 'shield',
      count: () => ((state.adblock.sources || []).filter((s) => s.enabled).length + '/' + (state.adblock.sources || []).length) },
    { id: 'sniffer', label: '媒体嗅探', icon: 'radar', count: () => sniffBadge() },
    { id: 'extensions', label: '扩展', icon: 'puzzle', count: () => state.extensions.length },
    { id: 'bookmarks', label: '书签', icon: 'star', count: () => state.bookmarks.length },
    { id: 'history', label: '历史记录', icon: 'clock' },
    { id: 'downloads', label: '下载', icon: 'down', count: () => state.downloads.length }
  ] },
  { group: '系统', items: [
    { id: 'privacy', label: '隐私与数据', icon: 'lock' },
    { id: 'about', label: '关于吾爱Nova', icon: 'info' }
  ] }
];

const NAV_ICONS = {
  gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/>',
  palette: '<path d="M10 3a7 7 0 0 0 0 14c1.2 0 1.8-.8 1.8-1.6 0-.5-.3-.9-.6-1.2-.3-.3-.5-.6-.5-1 0-.6.5-1.1 1.1-1.1H13A4 4 0 0 0 17 8c0-2.8-3.1-5-7-5z"/><circle cx="7.4" cy="8.2" r=".9"/><circle cx="11" cy="6.8" r=".9"/>',
  chip: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.6"/><path d="M8.5 2.5v3M11.5 2.5v3M8.5 14.5v3M11.5 14.5v3M2.5 8.5h3M2.5 11.5h3M14.5 8.5h3M14.5 11.5h3"/>',
  phone: '<rect x="6" y="2.5" width="8" height="15" rx="2"/><path d="M9 15.3h2"/>',
  shield: '<path d="M10 2.5l6 2v5.2c0 3.6-2.5 6.6-6 7.8-3.5-1.2-6-4.2-6-7.8V4.5z"/>',
  radar: '<rect x="2.5" y="5" width="9" height="8" rx="1.4"/><path d="M5.5 8.5l2.4 1.5-2.4 1.5z"/><path d="M14 8a3.2 3.2 0 0 1 0 5"/><path d="M16.6 5.8a6.4 6.4 0 0 1 0 9.4"/>',
  puzzle: '<path d="M8 3.5a2 2 0 1 1 4 0h3v3a2 2 0 1 0 0 4v3h-3a2 2 0 1 0-4 0H5v-3a2 2 0 1 0 0-4V3.5z"/>',
  star: '<path d="M10 3l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.8 5.8 16l.8-4.7L3.2 8l4.7-.7z"/>',
  clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4.2l3 1.8"/>',
  down: '<path d="M10 3.5v9M6.5 9.5L10 13l3.5-3.5M4 16h12"/>',
  lock: '<path d="M5.5 8.5V6.8a4.5 4.5 0 0 1 9 0v1.7"/><rect x="4" y="8.5" width="12" height="7.5" rx="1.8"/>',
  info: '<circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 6.5v.01"/>'
};

/** 分区 id → 构建函数。构建函数可以返回字符串，也可以返回 Promise<string>。 */
const SECTION_BUILDERS = {
  general: buildGeneral,
  appearance: buildAppearance,
  mobile: buildMobile,
  engines: buildEngines,
  adblock: buildAdblock,
  sniffer: buildSniffer,
  extensions: buildExtensions,
  bookmarks: buildBookmarks,
  history: buildHistory,
  downloads: buildDownloads,
  privacy: buildPrivacy,
  about: buildAbout
};

/**
 * 当前外壳形态下该露出来的导航分组。
 *
 * 「移动端」那两项（无图模式、自动拼页）是给小屏看的：PC 档位下摆在导航里，
 * 只会让人以为浏览器内置了一个手机模拟器 —— 它不是模拟器，是同一套外壳换了
 * 个形态，那两项在 PC 上也不生效。反过来窄屏档位下，这两项才是当前该管的。
 *
 * 判据用 state.layout（实际生效的形态）而不是设置里的偏好值：偏好写「跟随
 * 窗口」时，谁生效得看窗口宽度。
 */
function settingsNavGroups() {
  if (state.layout === 'mobile') return SETTINGS_NAV;
  return SETTINGS_NAV
    .map((g) => ({ group: g.group, items: g.items.filter((it) => it.id !== 'mobile') }))
    .filter((g) => g.items.length);
}

function findSection(id) {
  for (const g of settingsNavGroups()) {
    const hit = g.items.find((i) => i.id === id);
    if (hit) return hit;
  }
  return null;
}

function renderSettingsNav() {
  const nav = $('#settings-nav');
  nav.innerHTML = settingsNavGroups().map((g) => `
    <div class="sv-nav-group">${esc(g.group)}</div>
    ${g.items.map((it) => {
      const c = it.count ? it.count() : null;
      return `<button class="sv-nav-item ${it.id === state.settingsSection ? 'is-active' : ''}" data-sec="${it.id}">
        <svg viewBox="0 0 20 20">${NAV_ICONS[it.icon] || ''}</svg>
        <span>${esc(it.label)}</span>
        ${c ? `<span class="sv-nav-count">${typeof c === 'number' ? fmtNum(c) : esc(c)}</span>` : ''}
      </button>`;
    }).join('')}
  `).join('');
  nav.querySelectorAll('.sv-nav-item').forEach((b) => {
    b.addEventListener('click', () => renderSettingsSection(b.dataset.sec));
  });
}

/**
 * 渲染一个设置分区。同步分区立刻落 DOM（便于断言与避免闪烁），
 * 异步分区（历史记录要读盘）先给占位再替换。
 */
function renderSettingsSection(id) {
  const def = findSection(id) || findSection('general');
  state.settingsSection = def.id;
  state.panel = def.id;
  // 走到哪一页就记一笔。重绘（下载进度、嗅探命中这类）也会走到这里，
  // 但那时栈顶正是当前分区，pushSettingsTrail 会原地不动。
  pushSettingsTrail(def.id);
  syncSettingsBack();
  $('#sv-path').textContent = def.label;
  renderSettingsNav();

  const body = $('#settings-body');
  body.scrollTop = 0;
  const html = SECTION_BUILDERS[def.id]();

  if (html && typeof html.then === 'function') {
    body.innerHTML = '<div class="sv-empty">载入中…</div>';
    html.then((h) => {
      if (state.settingsSection !== def.id) return;
      body.innerHTML = h;
      wireActions(body);
      afterSectionRender(def.id);
    });
    return;
  }
  body.innerHTML = html;
  wireActions(body);
  afterSectionRender(def.id);
}

/** 分区渲染完的收尾钩子 —— 需要 DOM 已经就位的副作用放这里 */
function afterSectionRender(id) {
  if (id === 'sniffer') {
    // 兜底补拉：事件推送可能丢，UI 预览模式下也根本没有事件
    syncSniffFromMain();
    // 渲染出来后，给靠前的几条排上元数据探测
    scheduleSniffProbe();
    return;
  }
  if (id === 'mobile') syncMobileFromMain();
}

/**
 * 补拉无图快照与拼页状态。
 *
 * 递归防护：这个函数会触发重渲染，而重渲染又会回到 afterSectionRender。
 * 用一个进行中标志把嵌套调用挡掉 —— 否则「渲染 → 补拉 → 重渲染」会转成死循环。
 */
let mobileSyncBusy = false;

async function syncMobileFromMain() {
  if (mobileSyncBusy) return;
  mobileSyncBusy = true;
  try {
    const t = activeTab();
    const before = JSON.stringify(state.noMedia);
    try {
      const st = await bridge.mobile.state(t && t.wcId != null ? t.wcId : null);
      if (st && st.noImage) state.noMedia = st.noImage;
    } catch { /* 预览模式：桥是空壳 */ }

    await readAutoPageStatus();

    if (JSON.stringify(state.noMedia) === before) return;
    if (state.settingsSection === 'mobile') renderSettingsSection('mobile');
  } finally {
    mobileSyncBusy = false;
  }
}

/**
 * 从主进程补拉一次嗅探清单。
 * 只在真的有新增时才触发重绘 —— 否则会和 afterSectionRender 形成
 * 「刷新 → 渲染 → 补拉 → 再刷新」的死循环。
 */
async function syncSniffFromMain() {
  let recs;
  try {
    recs = await bridge.sniffer.list({});
  } catch {
    return; // 主进程没起来 / 预览模式下桥是空壳
  }
  if (!Array.isArray(recs) || !recs.length) return;

  let added = 0;
  for (const rec of recs) {
    const bucket = state.sniffByWc.get(rec.tabId);
    if (!bucket || !bucket.some((r) => r.id === rec.id)) added += 1;
    mergeSniffRecords(rec.tabId, [rec]);
  }
  if (!added) return;
  syncSniffBadge();
  refreshSniffer(true);
}

/**
 * 设置页的返回栈。
 *
 * 原先 #sv-back 和右上角的 × 绑的是同一个 closeSettings —— 一个画成返回箭头
 * 的按钮和一个画成叉的按钮做同一件事，那个箭头就是假的。现在它管的是分区
 * 之间的回退：左侧导航跳到哪一页就记一笔，返回沿原路退回去。
 */
function pushSettingsTrail(id) {
  const t = state.settingsTrail;
  // 目标已经在栈里就截断到那里，而不是再压一层。否则用户在「常规 ⇄ 外观」
  // 之间来回点两下，返回得按十几次才出得去 —— 那正是浏览器返回的行为。
  const at = t.lastIndexOf(id);
  if (at !== -1) { t.length = at + 1; return; }
  t.push(id);
}

/** 返回按钮的可用态。已经在第一页时没有可去的地方，置灰好过假装能点。 */
function syncSettingsBack() {
  const back = $('#sv-back');
  if (!back) return;
  const can = state.settingsTrail.length > 1;
  back.disabled = !can;
  back.title = can ? '返回上一页设置' : '已经在第一页设置';
}

function goSettingsBack() {
  const t = state.settingsTrail;
  if (t.length <= 1) return;
  t.pop();
  renderSettingsSection(t[t.length - 1]);
}

function openSettings(id) {
  closeDrawer();
  // 每次从外面进设置页都从一页新历史开始：上一轮「常规 → 外观」不该让这一次
  // 的返回按钮一推开门就是亮的。
  state.settingsTrail = [];
  $('#settings-view').hidden = false;
  renderSettingsSection(id || state.settingsSection || 'general');
}

function closeSettings() {
  const view = $('#settings-view');
  if (!view || view.hidden) return;
  view.hidden = true;
  state.panel = null;
  state.settingsTrail = [];
}

/** 菜单里的 data-panel 值 → 设置页分区 */
const PANEL_ALIAS = {
  settings: 'general',
  general: 'general',
  appearance: 'appearance',
  mobile: 'mobile',
  engines: 'engines',
  adblock: 'adblock',
  sniffer: 'sniffer',
  extensions: 'extensions',
  bookmarks: 'bookmarks',
  history: 'history',
  downloads: 'downloads',
  privacy: 'privacy',
  about: 'about'
};

/** 兼容旧入口（菜单行、盾牌/扩展按钮、快捷键、?panel= 深链接） */
function openPanel(p) {
  openSettings(PANEL_ALIAS[p] || 'general');
  // 进书签页时才去检测浏览器：检测要问主进程要文件是否存在，
  // 没必要在启动时就做 —— 而且用户可能只是路过设置。
  if ((PANEL_ALIAS[p] || p) === 'bookmarks') detectBrowsers();
  // 扩展页也要扫一次：那台机器上装了哪些扩展属于「进这一页才知道」的信息
  if ((PANEL_ALIAS[p] || p) === 'extensions') scanBrowserExts();
}

/**
 * 重绘当前所有可见面。
 *
 * 早先写的是「谁在最上面就只刷谁」—— 结果设置页挂着的时候，被它盖住的阅读弹层
 * 就刷不动了：弹层里切了档位，主进程那边已经生效，弹层上的选中态却还停在旧的。
 * 改成把在显示的面都刷一遍，谁盖着谁不影响各自的状态同步（没显示的那几个是空操作）。
 */
function refreshCurrent() {
  // 收藏夹栏是常驻面，不归设置页 / 弹层那套显隐管，所以先刷它。
  // 书签的每一次增删清最后都落到这里，不必在七八处各补一句。
  renderBookmarkBar();
  // 站点图标表在书签变了之后要重新问一次。放这里而不是跟着上面那句一起
  // 塞进 renderBookmarkBar：那张表是异步来的，而 renderBookmarkBar 是同步
  // 渲染路径，不该在里面发 IPC。主机名没变时这个调用会立刻返回。
  refreshHostIcons();
  // 删掉的书签如果正好是当前页，星标要跟着变回空心
  syncStarButton();

  const view = $('#settings-view');
  if (view && !view.hidden) renderSettingsSection(state.settingsSection);

  const read = $('#read-sheet');
  if (read && !read.hidden) renderReadSheet();

  if (state.panel === 'menu') renderMenuPanel();
}

/**
 * 下载页专用刷新。
 * 下载过程中主进程每 120ms 推一次进度，直接每次都整页重绘会把输入框里
 * 正在敲的地址清掉；所以这里做两件事：节流到 350ms，并在重绘前后
 * 把输入框的值、光标位置和焦点原样接回去。
 */
let dlRefreshTimer = null;

function refreshDownloads(force = false) {
  if (state.settingsSection !== 'downloads') return;
  const view = $('#settings-view');
  if (!view || view.hidden) return;

  if (force) {
    clearTimeout(dlRefreshTimer);
    dlRefreshTimer = null;
    doRefreshDownloads();
    return;
  }
  if (dlRefreshTimer) return; // 已经排上队了，这一波合并掉
  dlRefreshTimer = setTimeout(() => { dlRefreshTimer = null; doRefreshDownloads(); }, 350);
}

function doRefreshDownloads() {
  const body = $('#settings-body');
  if (!body) return;

  const input = $('#dl-url');
  const focused = !!input && document.activeElement === input;
  const caret = focused ? input.selectionStart : 0;
  if (input) state.dlDraft = input.value;

  Promise.resolve(buildDownloads()).then((html) => {
    if (state.settingsSection !== 'downloads') return;
    body.innerHTML = html;
    wireActions(body);
    if (focused) {
      const next = $('#dl-url');
      if (next) {
        next.focus();
        try { next.setSelectionRange(caret, caret); } catch { /* 类型不支持就算了 */ }
      }
    }
  }).catch(() => { /* 渲染失败不该把页面搞崩 */ });
}

/**
 * 嗅探页刷新。
 * 与下载页同理要节流（一页首屏能瞬时冒几十条），但多一条更硬的规矩：
 * **有预览打开时不重绘** —— 整页重绘会把 <video> 节点拆掉，正在播的媒体会当场中断。
 */
let sniffRefreshTimer = null;

function refreshSniffer(force = false) {
  if (state.settingsSection !== 'sniffer') return;
  const view = $('#settings-view');
  if (!view || view.hidden) return;

  if (force) {
    clearTimeout(sniffRefreshTimer);
    sniffRefreshTimer = null;
    refreshCurrent();
    return;
  }
  if (state.sniffPreview) return; // 别把用户正在看的东西刷没了
  if (sniffRefreshTimer) return;
  sniffRefreshTimer = setTimeout(() => { sniffRefreshTimer = null; refreshCurrent(); }, 400);
}

function buildPrivacy() {
  const s = state.settings;
  return `
    <h2 class="sv-h2">隐私与数据</h2>
    <div class="sv-lead">数据全部落在本机用户目录，不上传任何一方。每个内核一份独立 session，Cookie 与缓存互不串味。</div>

    <div class="panel-label">存储位置</div>
    <div class="sv-card">
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">用户数据目录</span>
          <span class="lr-sub">${esc(state.userDataPath || '（读取中…）')}</span>
        </span>
        <button class="btn" data-act="open-user-data">打开</button>
      </div>
      ${state.engines.map((e) => `
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">${esc(e.label)} 隔离分区</span>
          <span class="lr-sub">${esc(e.partition)}</span>
        </span>
        <span class="mode-pill mode-${e.mode}">${esc(e.modeLabel)}</span>
      </div>`).join('')}
    </div>

    <div class="panel-label">清理</div>
    <div class="sv-card">
      <div class="list-row">
        <span class="lr-main"><span class="lr-title">清空历史记录</span><span class="lr-sub">保留书签与设置</span></span>
        <button class="btn" data-act="clear-history">清空</button>
      </div>
      <div class="list-row">
        <span class="lr-main"><span class="lr-title">清空全部书签</span><span class="lr-sub">当前 ${state.bookmarks.length} 条</span></span>
        <button class="btn" data-act="clear-bookmarks" ${state.bookmarks.length ? '' : 'disabled'}>清空</button>
      </div>
      <div class="list-row">
        <span class="lr-main"><span class="lr-title">清空站点数据</span><span class="lr-sub">Cookie / 缓存 / localStorage，覆盖全部内核分区</span></span>
        <button class="btn" data-act="clear-site-data">清空</button>
      </div>
      <div class="list-row">
        <span class="lr-main"><span class="lr-title">重置广告拦截统计</span><span class="lr-sub">只清计数，不动已装载的规则</span></span>
        <button class="btn" data-act="reset-stats">重置</button>
      </div>
    </div>

    <div class="panel-label">还原</div>
    <div class="sv-card">
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">恢复默认设置</span>
          <span class="lr-sub">主页 / 新标签页 / 搜索 / 默认内核 / 外观 / 拦截强度；不动书签与历史</span>
        </span>
        <button class="btn" data-act="restore-defaults">恢复</button>
      </div>
    </div>

    <div class="sv-note">
      本版没有做的东西，这里如实写明：站点级 Cookie 策略开关（<code>relaxThirdParty</code> 字段已在配置里，
      但没有接到 Electron 的 session 策略上，所以不给一个点了没反应的按钮）、代理设置、证书管理。
      第三方 Cookie 目前完全由 Chromium 默认策略决定。
    </div>
  `;
}

/* ------------------------------------------------------------------ *
 * 交互接线（抽屉与设置页正文共用）
 * ------------------------------------------------------------------ */

/**
 * 查一次商店详情。
 *
 * 全程只改 state 再重绘，不直接动 DOM —— 重绘是这一块唯一的出口。
 * 顺手往输入框里写一句「查询中」或改个按钮文案的做法，会在这块被任何
 * 一次推送重绘之后被打回原形，两个出口迟早对不上。
 */
async function runStoreQuery() {
  const raw = state.extStore.draft;
  state.extStore.busy = true;
  state.extStore.detail = null;
  state.extStore.error = '';
  refreshCurrent();

  let r = null;
  try { r = await bridge.extensions.storeInfo(raw); } catch { r = null; }

  state.extStore.busy = false;
  if (r && r.detail) state.extStore.detail = r.detail;
  else state.extStore.error = (r && r.error) || '查询失败，稍后再试';
  refreshCurrent();
}

/** 装。成功之后把输入框清掉，免得用户对着一条已经装上的地址再点一次。 */
async function runStoreInstall() {
  const raw = state.extStore.draft;
  if (!raw) { toast('先粘一个扩展地址'); return; }

  state.extStore.busy = true;
  state.extStore.error = '';
  refreshCurrent();

  let r = null;
  try { r = await bridge.extensions.storeInstall(raw); } catch { r = null; }

  state.extStore.busy = false;
  if (!r) {
    state.extStore.error = '安装失败，稍后再试';
  } else if (r.error) {
    state.extStore.error = r.error;
  } else if (r.already) {
    // 「已经装过」不是错误，但它也确实没有新东西出现，
    // 写成红色的报错会让人以为失败了。
    state.extStore.detail = null;
    toast(`已经装过「${r.name}」了`);
  } else if (r.installed) {
    state.extStore.detail = null;
    state.extStore.draft = '';
    state.extensions = await bridge.extensions.list();
    toast(`已装好「${r.installed.name}」`);
  }
  refreshCurrent();
}

function wireActions(root) {
  root.querySelectorAll('[data-toggle]').forEach((sw) => {
    sw.addEventListener('click', async () => {
      const key = sw.dataset.toggle;
      const next = !sw.classList.contains('is-on');
      sw.classList.toggle('is-on', next);
      await bridge.settings.patch({ adblock: { [key]: next } });
      state.settings.adblock[key] = next;
      if (key === 'enabled') {
        state.adblock.enabled = next;
        $('#btn-shield').classList.toggle('is-off', !next);
      }
      toast(next ? '已开启' : '已关闭');
    });
  });

  // 三个拦截源的独立开关
  root.querySelectorAll('[data-source]').forEach((sw) => {
    sw.addEventListener('click', async () => {
      const id = sw.dataset.source;
      const next = !sw.classList.contains('is-on');
      sw.classList.toggle('is-on', next);
      const s = await bridge.adblock.sourceToggle(id, next);
      if (s) state.adblock = s;
      refreshCurrent();
      const src = ((s && s.sources) || []).find((x) => x.id === id);
      toast(`${src ? src.name : id} 已${next ? '启用' : '停用'}`);
    });
  });

  root.querySelectorAll('#ab-level button').forEach((b) => {
    b.addEventListener('click', async () => {
      root.querySelectorAll('#ab-level button').forEach((x) => x.classList.toggle('is-active', x === b));
      state.settings.adblock.level = b.dataset.level;
      await bridge.settings.patch({ adblock: { level: b.dataset.level } });
      toast(b.dataset.level === 'aggressive' ? '已切换为严格拦截' : '已切换为标准拦截');
    });
  });

  root.querySelectorAll('#set-engine button').forEach((b) => {
    b.addEventListener('click', async () => {
      root.querySelectorAll('#set-engine button').forEach((x) => x.classList.toggle('is-active', x === b));
      state.settings.defaultEngine = b.dataset.engine;
      await bridge.settings.patch({ defaultEngine: b.dataset.engine });
      toast(`默认内核：${engine(b.dataset.engine).label}`);
    });
  });

  root.querySelectorAll('#set-layout button').forEach((b) => {
    b.addEventListener('click', async () => {
      root.querySelectorAll('#set-layout button').forEach((x) => x.classList.toggle('is-active', x === b));
      state.settings.layout = b.dataset.layout;
      applyLayout();
      await bridge.settings.patch({ layout: b.dataset.layout });
      refreshCurrent();
    });
  });

  root.querySelectorAll('#set-theme button').forEach((b) => {
    b.addEventListener('click', async () => {
      root.querySelectorAll('#set-theme button').forEach((x) => x.classList.toggle('is-active', x === b));
      state.settings.theme = b.dataset.theme;
      document.documentElement.dataset.theme = b.dataset.theme;
      syncQuickBar();
      await bridge.settings.patch({ theme: b.dataset.theme });
    });
  });

  root.querySelectorAll('#set-bmbar button').forEach((b) => {
    b.addEventListener('click', async () => {
      root.querySelectorAll('#set-bmbar button').forEach((x) => x.classList.toggle('is-active', x === b));
      state.settings.bookmarkBar = b.dataset.bmbar;
      // 先落界面再落盘：这条栏的显隐是立等可看的，没道理让它等一个 IPC 往返。
      renderBookmarkBar(true);
      syncQuickBar();
      await bridge.settings.patch({ bookmarkBar: b.dataset.bmbar });
      refreshCurrent();
      toast('收藏夹栏：' + (BM_BAR_LABEL[b.dataset.bmbar] || b.dataset.bmbar));
    });
  });

  root.querySelectorAll('#set-search-preset button').forEach((b) => {
    b.addEventListener('click', async () => {
      state.settings.searchTemplate = b.dataset.tpl;
      await bridge.settings.patch({ searchTemplate: b.dataset.tpl });
      refreshCurrent();
      toast('搜索模板已更新');
    });
  });

  // 通用布尔配置开关（restoreSession 等）
  root.querySelectorAll('[data-cfg]').forEach((sw) => {
    sw.addEventListener('click', async () => {
      const key = sw.dataset.cfg;
      const next = !sw.classList.contains('is-on');
      sw.classList.toggle('is-on', next);
      state.settings[key] = next;
      await bridge.settings.patch({ [key]: next });
      toast(next ? '已开启' : '已关闭');
    });
  });

  /* --- 移动端阅读：无图模式 / 自动拼页 --- */
  root.querySelectorAll('#nm-level button').forEach((b) => {
    b.addEventListener('click', () => applyNoImage(b.dataset.level));
  });
  root.querySelectorAll('#ap-max button').forEach((b) => {
    b.addEventListener('click', () => applyAutoPageMax(Number(b.dataset.max)));
  });
  root.querySelectorAll('[data-ap]').forEach((sw) => {
    sw.addEventListener('click', () => applyAutoPage(!sw.classList.contains('is-on')));
  });
  root.querySelectorAll('[data-read]').forEach((row) => {
    row.addEventListener('click', () => { closeDrawer(); openReadSheet(); });
  });

  const home = root.querySelector('#set-homepage');
  if (home) {
    home.addEventListener('change', async () => {
      const v = home.value.trim() || (state.defaults && state.defaults.homepage) || 'https://52ta.top/';
      state.settings.homepage = v;
      await bridge.settings.patch({ homepage: v });
      refreshCurrent();
      toast('主页已更新');
    });
  }

  const newTab = root.querySelector('#set-newtab');
  if (newTab) {
    newTab.addEventListener('change', async () => {
      // 空着、或者填的就是主页地址 → 记成具名的 homepage，而不是把主页
      // 地址原样存一份。存一份拷贝的话，以后改主页时这一栏不会跟着变，
      // 用户会觉得「我明明设的是跟随主页」。
      const raw = newTab.value.trim();
      const v = (!raw || raw === state.settings.homepage) ? 'homepage' : raw;
      state.settings.newTabPage = v;
      await bridge.settings.patch({ newTabPage: v });
      refreshCurrent();
      toast('新标签页已更新');
    });
  }

  const search = root.querySelector('#set-search');
  if (search) {
    search.addEventListener('change', async () => {
      const v = search.value.trim() || 'https://www.baidu.com/s?wd=%s';
      state.settings.searchTemplate = v;
      await bridge.settings.patch({ searchTemplate: v });
      refreshCurrent();
      toast('搜索模板已更新');
    });
  }

  root.querySelectorAll('[data-allow]').forEach((b) => {
    b.addEventListener('click', async () => {
      const host = b.dataset.allow;
      const isAllowed = state.allowlist.includes(host);
      state.allowlist = isAllowed
        ? await bridge.adblock.allowlistRemove(host)
        : await bridge.adblock.allowlistAdd(host);
      refreshCurrent();
      toast(isAllowed ? `已移出白名单：${host}` : `已加入白名单：${host}`);
    });
  });

  root.querySelectorAll('[data-unallow]').forEach((b) => {
    b.addEventListener('click', async () => {
      const host = b.dataset.unallow;
      state.allowlist = await bridge.adblock.allowlistRemove(host);
      refreshCurrent();
      toast(`已移出白名单：${host}`);
    });
  });

  // 商店输入框的内容同步进 state。这个分区会被各种推送（下载进度、嗅探命中、
  // 扩展列表变化）整体重绘，只靠 DOM 值的话，用户打到一半来一次重绘字就没了。
  const storeInput = root.querySelector('#store-input');
  if (storeInput) {
    storeInput.addEventListener('input', () => { state.extStore.draft = storeInput.value; });
    storeInput.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const v = storeInput.value.trim();
      state.extStore.draft = v;
      if (v) runStoreQuery();
    });
  }

  // 「打开商店」：在新标签页里开，并把设置窗口收起来 —— 不然新开的页正好
  // 被这扇窗口盖着，用户会以为点了没反应。
  root.querySelectorAll('[data-store-open]').forEach((b) => {
    b.addEventListener('click', () => {
      const link = STORE_LINKS.find((s) => s.id === b.dataset.storeOpen);
      if (!link) return;
      closeSettings();
      createTab(link.url, state.settings.defaultEngine);
    });
  });

  root.querySelectorAll('[data-remove-ext]').forEach((b) => {
    b.addEventListener('click', async () => {
      await bridge.extensions.remove(b.dataset.removeExt);
      state.extensions = await bridge.extensions.list();
      refreshCurrent();
      toast('扩展已移除');
    });
  });

  root.querySelectorAll('[data-unbookmark]').forEach((b) => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      state.bookmarks = await bridge.bookmarks.remove(b.dataset.unbookmark);
      refreshCurrent();
      toast('书签已删除');
    });
  });

  // 历史行 → 当前标签页打开
  root.querySelectorAll('.hist-row').forEach((r) => {
    r.addEventListener('click', () => {
      const tab = activeTab();
      if (tab) navigate(tab.id, r.dataset.url);
      closeSettings();
    });
  });

  // 书签行 → 当前标签页打开（删除按钮单独处理，不触发跳转）
  root.querySelectorAll('.list-row[data-url]').forEach((r) => {
    r.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-unbookmark]')) return;
      const tab = activeTab();
      if (tab) navigate(tab.id, r.dataset.url);
      closeSettings();
    });
  });

  /* --- 下载 --- */

  const draft = root.querySelector('#dl-url');
  if (draft) {
    draft.addEventListener('input', () => { state.dlDraft = draft.value; });
    // 回车即开始下载
    draft.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const go = root.querySelector('[data-act="dl-start"]');
        if (go) go.click();
      }
    });
  }

  root.querySelectorAll('#dl-threads button').forEach((b) => {
    b.addEventListener('click', async () => {
      const v = Number(b.dataset.v);
      root.querySelectorAll('#dl-threads button').forEach((x) => x.classList.toggle('is-active', x === b));
      state.settings.download = Object.assign({}, state.settings.download, { threads: v });
      await bridge.settings.patch({ download: { threads: v } });
      toast(`并发线程数已设为 ${v}`);
    });
  });

  root.querySelectorAll('#dl-conc button').forEach((b) => {
    b.addEventListener('click', async () => {
      const v = Number(b.dataset.v);
      root.querySelectorAll('#dl-conc button').forEach((x) => x.classList.toggle('is-active', x === b));
      state.settings.download = Object.assign({}, state.settings.download, { maxConcurrent: v });
      await bridge.settings.patch({ download: { maxConcurrent: v } });
      toast(`同时下载任务数已设为 ${v}`);
    });
  });

  root.querySelectorAll('[data-dlcfg]').forEach((sw) => {
    sw.addEventListener('click', async () => {
      const key = sw.dataset.dlcfg;
      const next = !sw.classList.contains('is-on');
      sw.classList.toggle('is-on', next);
      state.settings.download = Object.assign({}, state.settings.download, { [key]: next });
      await bridge.settings.patch({ download: { [key]: next } });
      refreshCurrent();
      toast(next ? '已接管页面下载，走多线程引擎' : '已交回 Chromium 内建下载器');
    });
  });

  root.querySelectorAll('[data-dl]').forEach((b) => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const act = b.dataset.dl;
      const id = b.dataset.id;
      const p = b.dataset.path;

      if (act === 'open') { await bridge.downloads.open(p); return; }
      if (act === 'show') { await bridge.downloads.showInFolder(p); return; }

      const run = {
        pause: () => bridge.downloads.pause(id),
        resume: () => bridge.downloads.resume(id),
        cancel: () => bridge.downloads.cancel(id),
        remove: () => bridge.downloads.remove(id),
        retry: () => bridge.downloads.retry(id)
      }[act];
      if (!run) return;

      await run();
      state.downloads = await bridge.downloads.list();
      state.downloadStats = await bridge.downloads.stats();
      refreshDownloads(true);

      const msg = {
        pause: '已暂停（进度已存档，可继续）',
        resume: '已继续',
        cancel: '已取消，半成品文件已删除',
        remove: '已从列表移除',
        retry: '已重新开始'
      }[act];
      if (msg) toast(msg);
    });
  });

  /* --- 媒体嗅探 --- */

  root.querySelectorAll('[data-sncfg]').forEach((sw) => {
    sw.addEventListener('click', async () => {
      const key = sw.dataset.sncfg;

      // 「显示分片」纯界面开关，不必落盘
      if (key === 'showSegments') {
        state.sniffShowSegments = !state.sniffShowSegments;
        refreshCurrent();
        return;
      }

      const next = !sw.classList.contains('is-on');
      sw.classList.toggle('is-on', next);
      state.settings.sniffer = Object.assign({}, state.settings.sniffer, { [key]: next });
      await bridge.settings.patch({ sniffer: { [key]: next } });
      refreshCurrent();
      toast(key === 'enabled'
        ? (next ? '已开始嗅探页面媒体' : '已停止嗅探')
        : (next ? '已开启自动读取时长与分辨率' : '已关闭自动读取'));
    });
  });

  root.querySelectorAll('#sn-minsize button').forEach((b) => {
    b.addEventListener('click', async () => {
      const v = Number(b.dataset.v);
      root.querySelectorAll('#sn-minsize button').forEach((x) => x.classList.toggle('is-active', x === b));
      state.settings.sniffer = Object.assign({}, state.settings.sniffer, { minSizeKB: v });
      await bridge.settings.patch({ sniffer: { minSizeKB: v } });
      toast(v === 0 ? '不再按体积过滤' : `小于 ${v} KB 的不再收录`);
    });
  });

  root.querySelectorAll('[data-sn]').forEach((b) => {
    b.addEventListener('click', async () => {
      const act = b.dataset.sn;
      const id = b.dataset.id;

      if (act === 'clear') {
        const wc = currentWcId();
        await bridge.sniffer.clear(wc == null ? {} : { tabId: wc });
        if (wc == null) state.sniffByWc.clear();
        else state.sniffByWc.set(wc, []);
        state.sniffPreview = null;
        refreshCurrent();
        syncSniffBadge();
        toast('已清空本页的媒体清单');
        return;
      }

      if (act === 'toggle-segs') {
        state.sniffShowSegments = !state.sniffShowSegments;
        refreshCurrent();
        return;
      }

      const rec = sniffRecords().find((r) => r.id === id);
      if (!rec) return;

      if (act === 'preview') {
        state.sniffPreview = state.sniffPreview === id ? null : id;
        refreshCurrent();
        return;
      }
      if (act === 'download') {
        const r = await bridge.downloads.create({ url: rec.url, filename: suggestName(rec) });
        if (r && r.error) { toast(r.error); return; }
        try { state.downloads = await bridge.downloads.list(); } catch { /* 列表拉不到不影响已入队 */ }
        state.downloadStats = null;
        toast('已交给多线程引擎下载');
        return;
      }
      if (act === 'copy') {
        await bridge.system.copy(rec.url);
        toast('链接已复制到剪贴板');
        return;
      }
      if (act === 'open') {
        const base = activeTab();
        createTab(rec.url, base ? base.engineId : state.settings.defaultEngine);
        toast('已在新标签页打开');
        return;
      }
    });
  });

  root.querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'new-tab') { createTab(newTabUrl(), state.settings.defaultEngine); closeDrawer(); }
      else if (act === 'home') { const t = activeTab(); if (t) navigate(t.id, state.settings.homepage); closeDrawer(); }
      else if (act === 'bookmark' || act === 'bookmark-current') {
        const t = activeTab();
        if (!t) { toast('还没有打开的标签页'); return; }
        state.bookmarks = await bridge.bookmarks.add({
          title: t.title, url: t.url, favicon: t.favicon || null
        });
        refreshCurrent();
        toast('已加入书签');
      } else if (act === 'clear-bookmarks') {
        state.bookmarks = await bridge.bookmarks.clear();
        refreshCurrent();
        toast('书签已清空');
      } else if (act === 'bookmarks-import') {
        // 导入：文件对话框在主进程那边（渲染层不碰文件系统）。
        // 取消时返回 { canceled:true } —— 那不是错误，别弹红色的提示。
        const r = await bridge.bookmarks.import();
        if (!r || r.canceled) return;
        if (r.error) {
          toast('导入失败：' + r.error, 4200);
          return;
        }
        if (r.bookmarks) state.bookmarks = r.bookmarks;
        refreshCurrent();
        // 如实报数：加了几条、重复几条、跳过几条。
        // 只说「导入成功」的话，用户不知道自己那份文件里有多少被合并掉了。
        const bits = [`导入完成：新增 ${r.added} 条`];
        if (r.dup) bits.push(`已在书签里 ${r.dup} 条`);
        if (r.skipped) bits.push(`跳过 ${r.skipped} 条`);
        toast(`${bits.join(' · ')}，当前共 ${r.total} 条`, 4200);
      } else if (act === 'bookmarks-export') {
        const r = await bridge.bookmarks.export();
        if (!r || r.canceled) return;
        if (r.error) { toast(r.error, 4200); return; }
        toast(`已导出 ${r.count} 条书签`, 3200);
      } else if (act === 'newtab-builtin') { await setNtpMode('start'); }
      else if (act === 'newtab-homepage') { await setNtpMode('homepage'); }
      else if (act === 'newtab-blank') { await setNtpMode('blank'); }
      else if (act === 'newtab-same') { await setNtpMode('homepage'); }
      else if (act === 'reset-stats') {
        state.adblock = await bridge.adblock.reset();
        refreshCurrent();
        toast('统计已重置');
      } else if (act === 'nm-reset') {
        try {
          const st = await bridge.mobile.resetStats();
          if (st) state.noMedia = st;
        } catch { /* 预览模式 */ }
        refreshCurrent();
        toast('无图拦截计数已重置');
      } else if (act === 'nm-show-images') {
        await showPageImages();
      } else if (act === 'import-list') {
        const r = await bridge.adblock.importList();
        if (r && r.imported) {
          state.adblock = await bridge.adblock.stats();
          refreshCurrent();
          toast(`已导入 ${r.imported} 条规则`);
        } else toast(r && r.note ? r.note : '未导入任何文件');
      } else if (act === 'store-query') {
        const input = root.querySelector('#store-input');
        const raw = (input ? input.value : '').trim();
        if (!raw) { toast('先粘一个扩展地址'); return; }
        state.extStore.draft = raw;
        await runStoreQuery();
      } else if (act === 'store-install') {
        await runStoreInstall();
      } else if (act === 'install-ext') {
        await installExtensionsFromDisk();
      } else if (act === 'clear-history') {
        await bridge.history.clear();
        refreshCurrent();
        toast('历史已清空');
      } else if (act === 'dl-start') {
        const input = root.querySelector('#dl-url');
        const raw = (input ? input.value : '').trim();
        if (!raw) { toast('请先粘贴一个文件地址'); return; }
        const r = await bridge.downloads.create({ url: raw });
        if (r && r.error) { toast(r.error); return; }
        // DOM 的值也要一起清：否则紧随其后的重绘会把输入框里的旧内容
        // 又当成草稿抄回 state.dlDraft，等于没清。
        state.dlDraft = '';
        if (input) input.value = '';
        state.downloads = await bridge.downloads.list();
        state.downloadStats = await bridge.downloads.stats();
        refreshDownloads(true);
        toast('已加入下载队列');
      } else if (act === 'dl-choose-dir') {
        const dir = await bridge.downloads.chooseDir();
        if (!dir) return;
        state.settings.download = Object.assign({}, state.settings.download, { dir });
        await bridge.settings.patch({ download: { dir } });
        state.downloadsDir = dir;
        refreshDownloads(true);
        toast('下载目录已更新');
      } else if (act === 'dl-open-dir') {
        await bridge.downloads.open(state.downloadsDir || '');
      } else if (act === 'dl-clear') {
        state.downloads = await bridge.downloads.clearFinished();
        state.downloadStats = await bridge.downloads.stats();
        refreshDownloads(true);
        toast('下载记录已清除');
      } else if (act === 'clear-site-data') {
        const r = await bridge.system.clearSiteData();
        toast(r && r.note ? r.note
          : (r && r.cleared ? `已清空 ${r.cleared} 个分区的站点数据` : '已清空站点数据'));
      } else if (act === 'restore-defaults') {
        const d = state.defaults || {};
        const patch = {};
        // bookmarkBar 也在里面：恢复默认做过半截的话，会出现「主题回了浅色、
        // 收藏夹栏却还停在上次手动收起的状态」，而设置页上写着「已恢复默认」。
        for (const k of ['homepage', 'newTabPage', 'searchTemplate', 'defaultEngine', 'layout', 'theme', 'bookmarkBar', 'restoreSession']) {
          if (d[k] !== undefined) patch[k] = d[k];
        }
        if (d.adblock) patch.adblock = { enabled: d.adblock.enabled, cosmetic: d.adblock.cosmetic, level: d.adblock.level };
        state.settings = await bridge.settings.patch(patch);
        document.documentElement.dataset.theme = state.settings.theme || 'light';
        applyLayout();
        refreshCurrent();
        toast('已恢复默认设置');
      } else if (act === 'open-user-data') {
        await bridge.system.openUserData();
      } else if (act === 'probe-engine') {
        state.engines = await bridge.engines.reResolve(true);
        state.engineMap = new Map(state.engines.map((e) => [e.id, e]));
        renderEngineSwitch();
        syncEngineUi();
        refreshCurrent();
        const native = state.engines.filter((e) => e.mode !== 'compat').map((e) => e.label);
        toast(native.length > 1 ? `可用原生内核：${native.join('、')}` : '未发现原生内核宿主，仍为兼容层');
      }
    });
  });

  root.querySelectorAll('[data-panel]').forEach((row) => {
    row.addEventListener('click', () => openPanel(row.dataset.panel));
  });

  /* 「从已安装的浏览器导入」的那几行。用**委托**挂在 root 上而不是逐行绑定：
   * 这些行是检测完才渲出来的（buildBookmarks 里先渲一个「正在检测…」的占位），
   * 逐行绑定的话每次重画都要重新绑一遍 —— 而 detectBrowsers() 正好会重画。
   * 漏绑的后果是那一行渲染出来了、就是点不动。 */
  root.addEventListener('click', async (ev) => {
    const row = ev.target.closest('[data-browser]');
    if (!row) return;
    const id = row.dataset.browser;
    row.style.opacity = '0.6';
    row.style.pointerEvents = 'none';
    try {
      const r = await bridge.bookmarks.fromBrowser(id);
      if (r && r.error) {
        toast(r.error, 4600);
      } else if (r) {
        if (r.bookmarks) state.bookmarks = r.bookmarks;
        refreshCurrent();
        // 如实报数：加了几条、重复几条 —— 只说「导入成功」的话，
        // 用户不知道自己那份书签里有多少本来就有了
        const bits = [`已从 ${r.from} 导入 ${r.added} 条`];
        if (r.dup) bits.push(`已在书签里 ${r.dup} 条`);
        toast(`${bits.join(' · ')}，当前共 ${r.total} 条`, 4200);
      }
    } catch (e) {
      toast('导入失败：' + String(e && e.message || e), 4200);
    } finally {
      row.style.opacity = '';
      row.style.pointerEvents = '';
    }
  });
}

/* ------------------------------------------------------------------ *
 * 移动端
 * ------------------------------------------------------------------ */

function openTabGrid() { $('#tab-grid').hidden = false; renderTabGrid(); }
function closeTabGrid() { $('#tab-grid').hidden = true; }
function openSheet() { $('#engine-sheet').hidden = false; syncEngineUi(); }
function closeSheet() { $('#engine-sheet').hidden = true; }

/* ------------------------------------------------------------------ *
 * 布局
 * ------------------------------------------------------------------ */

function applyLayout() {
  const pref = state.settings.layout || 'auto';
  const w = window.innerWidth;
  const layout = pref === 'auto' ? (w < MOBILE_BREAKPOINT ? 'mobile' : 'desktop') : pref;
  const changed = state.layout !== layout;
  state.layout = layout;
  document.documentElement.dataset.layout = layout;
  // 档位一跨过移动端那条线，收藏夹栏就该整条收起或放出来。窗口 resize 每次
  // 都会走到这里，所以只在真的换了档时才重画 —— 否则拖一次窗口要把这条栏
  // 重建几十次，鼠标碰巧停在上面时看得出来在闪。
  if (changed) renderBookmarkBar(true);
}

/* ------------------------------------------------------------------ *
 * 事件接线
 * ------------------------------------------------------------------ */

/**
 * 拖拽安装扩展。
 *
 * 整页级 `dragover` 必须 preventDefault —— 否则 Electron 会把拖进来的文件当成
 * 导航目标、直接跳去打开那个文件，用户看到的是「浏览器打开了一个 .crx」，
 * 而不是安装。drop 也要先拦下来自己处理。
 *
 * 只认扩展包（.crx / .zip / .xpi）：其它文件拖进来静默忽略，不弹错误打扰——
 * 用户很可能只是随手甩一个文件进窗口。一次甩进来多个时逐个装，最后汇总结果。
 *
 * 装完若扩展面板正开着就原地刷新（ext:changed 已经会推一次，但这里补一句
 * 让结果即时可见），并提示成功 / 失败。失败的那条把原因原样告诉用户——
 * 商店包魔数不对、manifest 缺字段这类，用户自己能判断。
 */
/**
 * 从 DataTransfer 里取出拖进来的本地文件绝对路径。
 *
 * <p><b>不能直接读 `File.path`</b> —— 那条路已经不通了：Electron 把它标成
 * deprecated 并在 32 里移除，本项目用的 30.x 上实测为 undefined。
 * 于是旧的写法会让 `p` 恒为空、被下面那层 `if (p)` 全过滤掉 ——
 * 表现为**拖进去完全没反应**（连提示遮罩都不显示，因为它是靠这里有没有路径
 * 来判断「这是不是扩展包」的）。必须问 preload 要：`webUtils.getPathForFile`
 * 需要主进程上下文，渲染层调不到。
 *
 * <p>preview 模式（bridge-mock）没有这个方法，此时退回 `file.path`
 * —— 在浏览器里预览时能拿到 `name` 但没有路径，那条路本来也走不通。
 *
 * <p>dragenter 与 drop 两处都要用，抽出来一份：写两遍的话，
 * 改扩展名白名单时容易只改一处。
 */
function filePathsOf(dt) {
  if (!dt || !dt.files || !dt.files.length) return [];
  const ask = bridge && bridge.system && typeof bridge.system.pathForFile === 'function'
    ? (f) => bridge.system.pathForFile(f)
    : (f) => (f && f.path) || '';
  const out = [];
  for (let i = 0; i < dt.files.length; i++) {
    let p = '';
    try { p = ask(dt.files[i]) || ''; } catch { /* 拿不到就跳过这一个 */ }
    if (p) out.push(p);
  }
  return out;
}

function wireDropInstall() {
  const isExt = (f) => /\.(crx|crx3|zip|xpi)$/i.test(f);
  const hint = () => $('#drop-hint');

  /* 拖入提示。
   *
   * <p><b>为什么必须做</b>：原先整页只有 preventDefault，用户把包拖进窗口时
   * 屏幕上**什么都不变** —— 不知道拖进来了没有，也不知道松手会发生什么。
   *
   * <p><b>两个容易踩的坑</b>：
   * 1) dragleave 会在指针划过子元素时反复触发，直接收起就会「闪」。
   *    用一个计数：dragenter +1、dragleave -1，归零才收。
   * 2) <b>非扩展文件不要显示「可安装」</b> —— 用户很可能只是随手甩一个文件进来，
   *    下方那句「不是扩展包，已忽略」比一个假装能装的提示诚实得多。
   */
  let depth = 0;
  const showHint = (ok) => {
    const el = hint();
    if (!el) return;
    const sub = el.querySelector('.dh-sub');
    const title = el.querySelector('.dh-title');
    if (sub) sub.textContent = ok
      ? '支持 .crx / .crx3 / .zip / .xpi'
      : '这不是扩展包（.crx / .crx3 / .zip / .xpi），松手后会忽略';
    if (title) title.textContent = ok ? '松手即可安装扩展' : '认不出这个文件';
    el.hidden = false;
  };
  const hideHint = () => {
    depth = 0;
    const el = hint();
    if (el) el.hidden = true;
  };

  document.addEventListener('dragenter', (ev) => {
    ev.preventDefault();
    const dt = ev.dataTransfer;
    // types 里有 Files 才可能是拖文件进来；拖文字/链接不显示这个提示
    if (!dt || Array.prototype.indexOf.call(dt.types || [], 'Files') < 0) return;
    depth += 1;
    const paths = filePathsOf(dt);
    showHint(paths.some(isExt));
  });

  document.addEventListener('dragover', (ev) => { ev.preventDefault(); });

  document.addEventListener('dragleave', (ev) => {
    ev.preventDefault();
    depth -= 1;
    if (depth <= 0) hideHint();
  });

  // 兜底：指针**拖出窗口**时 dragleave 常常不触发（事件目标已经离开了文档），
  // 于是遮罩会一直挂在屏幕上 —— 而用户看到的浏览器像是卡住了。
  // 盯着 relatedTarget：它变成 null 就是「已经离开这个文档」。
  document.addEventListener('dragleave', (ev) => {
    if (ev.relatedTarget === null) hideHint();
  });

  document.addEventListener('drop', (ev) => {
    ev.preventDefault();
    hideHint();
    const paths = filePathsOf(ev.dataTransfer);
    if (!paths.length) return;

    const extPaths = paths.filter(isExt);
    // 不认得的文件如实说一声「已忽略」，而不是静默丢开 ——
    // 静默的话用户会以为是自己拖的方式不对。
    if (extPaths.length < paths.length) {
      toast(`忽略 ${paths.length - extPaths.length} 个非扩展包文件`, 3600);
    }
    if (!extPaths.length) return;

    let done = 0;
    const ok = [];
    const bad = [];
    const finish = () => {
      done += 1;
      if (done < extPaths.length) return;
      if (ok.length) toast(`已安装 ${ok.length} 个扩展${bad.length ? `，${bad.length} 个失败` : ''}`);
      else if (bad.length) toast(bad[0], 5200);
      // 扩展面板正开着就原地刷新，让刚装的卡片即时出现
      if (state.settingsSection === 'extensions') refreshCurrent();
    };

    for (const p of extPaths) {
      bridge.extensions.installPath(p).then((r) => {
        if (r && r.installed) ok.push(r.installed.name);
        else if (r && r.error) bad.push(r.error);
        finish();
      }).catch((err) => { bad.push(err && err.message ? err.message : String(err)); finish(); });
    }
  });
}

/* ------------------------------------------------------------------ *
 * AI 助手面板（内嵌网页对话）
 * ------------------------------------------------------------------ */
// 下拉里的顺序即展示顺序；免登录的排最前（用户明确要「免登录优先」）。
// sel 是各家的对话输入框选择器（best-effort，页面改版可能失效——失效就
// 回落成「只打开对话页、让用户自己贴」）。custom 没有预设地址，靠用户填。
const AI_PROVIDERS = {
  deepseek: { name: 'DeepSeek', url: 'https://chat.deepseek.com/', sel: 'textarea, [contenteditable="true"]', guest: true },
  kimi: { name: 'Kimi', url: 'https://kimi.moonshot.cn/', sel: 'textarea', guest: true },
  qwen: { name: '通义千问', url: 'https://tongyi.aliyun.com/qianwen/', sel: 'textarea, [contenteditable="true"]', guest: true },
  doubao: { name: '豆包', url: 'https://www.doubao.com/chat/', sel: 'textarea, [contenteditable="true"]', guest: true },
  custom: { name: '自定义', url: '', sel: '', guest: false }
};

function currentAi() {
  const sel = $('#ai-select');
  const id = (sel && sel.value) || 'deepseek';
  return AI_PROVIDERS[id] || AI_PROVIDERS.deepseek;
}

function openAiPanel() {
  const panel = $('#ai-panel');
  if (!panel) return;
  applyAiMode();                 // API 模式藏起 webview、显示配置+消息列表
  if (aiIsApiMode()) aiApiLoadCfg();
  panel.hidden = false;
  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
  // 面板第一次打开时把当前选中的 AI 对话页载进 webview
  const ai = currentAi();
  const wv = $('#ai-webview');
  if (wv && ai.url && !wv.getAttribute('src')) wv.src = ai.url;
  // 面板从 hidden 变可见后，webview 要过一会儿才 attach 并触发 dom-ready。
  // 之前若用户「打开面板 → 直接点发送」，那次发送的内容会等不到事件。
  // 这里主动补一次：等就绪后把暂存内容送进去（没有暂存就什么都不做）。
  if (wv && state.aiPending) {
    whenAiWebViewReady().then((ok) => {
      if (!ok) return;
      const text = state.aiPending;
      if (!text) return;
      aiInject(text).then((r) => {
        if (r === 'ok' || r === 'no-input' || r === 'err') state.aiPending = '';
      });
    });
  }
}

function closeAiPanel() {
  const panel = $('#ai-panel');
  if (!panel) return;
  panel.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
  // 滑动动画结束后隐藏，避免 webview 一直占着资源
  setTimeout(() => { if (!panel.classList.contains('is-open')) panel.hidden = true; }, 240);
}

/**
 * 打开某个扩展的界面（侧边栏 / 弹窗 / 选项页）。
 *
 * <p>Electron 不渲染扩展侧边栏与浏览器动作弹窗，所以 side_panel 型扩展
 * （豆包/Cici、DeepSider 等）装上了也没有工具栏图标可点。这里用 Nova 自己的
 * 停靠面板 + 同分区 webview 把扩展自己的 side_panel.html / popup.html 打开 ——
 * 相当于替 Electron 补上它没做的那块 UI。e2e 实测：同分区 webview 载入
 * `chrome-extension://<id>/side_panel.html` 能正常渲染（title="Side Panel"）。
 *
 * @param {string} id 我们自己的扩展 id（state.extensions 里的那条）
 */
function openExtUiPanel(id) {
  const panel = $('#ext-ui-panel');
  const x = (state.extensions || []).find((e) => e.id === id);
  if (!panel || !x) return;
  if (x.enabled === false) { toast('这个扩展已关闭，先打开开关再用'); return; }
  const rel = x.uiPaths && x.uiPaths.primary;
  if (!rel || !x.electronId) { toast('这个扩展没有可打开的界面'); return; }

  const url = 'chrome-extension://' + x.electronId + '/' + String(rel).replace(/^\/+/, '');
  const nameEl = $('#ext-ui-name');
  if (nameEl) nameEl.textContent = x.name || '扩展';
  const iconEl = $('#ext-ui-icon');
  if (iconEl) {
    if (x.icon) { iconEl.src = x.icon; iconEl.hidden = false; }
    else { iconEl.hidden = true; iconEl.removeAttribute('src'); }
  }
  wireExtUiWebview();                 // 确保 window.open 拦截已挂上（幂等）
  panel.classList.add('is-loading');  // 顶部显示加载条，dom-ready 后去掉（见 wireExtUiWebview）
  panel.hidden = false;
  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
  const wv = $('#ext-ui-webview');
  if (wv) wv.src = url;               // 面板可见后再载入，避免隐藏态下加载的怪问题
}

/**
 * 给承载 webview 挂一次 window.open 拦截（幂等）。
 *
 * <p>侧边栏扩展常常用 window.open 把自已（或登录页）开成一个**独立窗口** ——
 * 真 Chrome 里那是浏览器级侧栏/弹窗，而 Electron 的 `<webview>` 带 allowpopups
 * 时会把它变成一个单独的 BrowserWindow：于是「扩展界面单独弹出来、不嵌进面板」，
 * 还因为同一份应用加载了两遍而更慢。这里拦下所有 new-window：
 *   - chrome-extension://（扩展自己的页面）→ 载回同一个面板 webview，继续嵌在面板里
 *   - 其它（外部登录页等）→ 开成一个普通标签页，不弹独立小窗
 */
function wireExtUiWebview() {
  const wv = $('#ext-ui-webview');
  if (!wv || wv.__novaWired) return;
  wv.__novaWired = true;
  wv.addEventListener('new-window', (e) => {
    const url = e.url;
    // 空白/内部页：拦掉
    if (!url || /^about:/i.test(url)) { e.preventDefault(); return; }
    if (url.startsWith('chrome-extension://')) {
      // 侧边栏型扩展（豆包/Cici/DeepSider 等）的 side_panel 多是个「发射器」：
      // 真正界面靠 window.open 开成独立窗口，且只在**真正的顶层窗口**里才渲染得出来
      // （载进 webview / loadURL 都会空白）。所以这里**放行**让它开成窗口——
      // 能用的窗口远好过空白；同时收起这个只起了个头的承载面板，免得留一块空白。
      closeExtUiPanel();
      return;  // 不 preventDefault → 交给 Electron 开真正的窗口
    }
    // 外部（登录页等）：拦成普通标签页
    e.preventDefault();
    createTab(url);
  });
  wv.addEventListener('dom-ready', () => {
    const panel = $('#ext-ui-panel');
    if (panel) panel.classList.remove('is-loading');
  });
}

function closeExtUiPanel() {
  const panel = $('#ext-ui-panel');
  if (!panel) return;
  panel.classList.remove('is-open');
  panel.classList.remove('is-loading');
  panel.setAttribute('aria-hidden', 'true');
  // 与 AI 面板一致：滑出后再隐藏并清掉 src，避免 webview 常驻占资源，
  // 也避免下次打开时先闪一下上一个扩展的旧内容
  setTimeout(() => {
    if (!panel.classList.contains('is-open')) {
      panel.hidden = true;
      const wv = $('#ext-ui-webview');
      if (wv) wv.removeAttribute('src');
    }
  }, 240);
}

/* ------------------------------------------------------------------ *
 * 自动更新（PC）
 * ------------------------------------------------------------------ */

/**
 * 按当前状态画更新按钮。
 *
 * <p>按钮默认隐藏（见 shell.html），只有「有新版」或「正在下载/已下好」
 * 这几个状态才露出来 —— 没更新的时候它什么也做不了，白占工具栏宽度。
 */
function renderUpdateBtn() {
  const btn = $('#btn-update');
  if (!btn) return;
  const s = state.update || {};
  const visible = s.status === 'available' || s.status === 'downloading' || s.status === 'ready';
  btn.hidden = !visible;
  const badge = $('#update-count');
  if (badge) {
    // 下载中用百分比当角标（比「1」有信息量），其余状态不挂数字角标 ——
    // 「有新版」这件事本身已经由按钮的可见性表达了，再挂个 1 是重复。
    if (s.status === 'downloading') {
      badge.hidden = false;
      badge.textContent = String(Math.round(s.percent || 0));
      badge.classList.add('is-pct');
    } else {
      badge.hidden = true;
    }
  }
  const tips = {
    available: () => `发现新版本 ${(s.info && s.info.version) || ''}，点击查看`,
    downloading: () => `正在下载更新…${Math.round(s.percent || 0)}%`,
    ready: () => '更新已下载完毕，点击重启安装'
  };
  btn.title = (tips[s.status] || (() => '检查更新'))();
  btn.classList.toggle('is-busy', s.status === 'downloading');
}

/**
 * 把更新状态重画到**所有**显示它的地方。
 *
 * <p>为什么不是「只画工具栏小窗」：同一份状态现在同时出现在两处 ——
 * 顶栏的更新小窗（#update-body）与设置里的「关于」分区（buildAbout 里那一块）。
 * 两者用一个 `[data-up-block]` 标记，这里一并重画。
 *
 * <p>原来的写法是 `if (!$('#update-panel').hidden) renderUpdatePanel()` ——
 * 只有小窗开着才重画，于是**下载时「关于」那一页的进度条是死的**：
 * 顶栏角标上的百分比一直在跳，那一页的进度条停在开始下载时的 0%
 * 一动不动（用户报的就是这个）。同一个状态显示在两处，就只有「两处都重画」
 * 才是对的 —— 少画一处，那处就是假的。
 *
 * <p>这里是整段 innerHTML 重写而不是改宽度：状态之间结构不同
 * （idle 一个按钮、downloading 一条进度条、ready 两个按钮），
 * 逐字段打补丁迟早会漏。整块重画的代价可以忽略（几十个节点），
 * 而进度事件本来就在主进程那边按 200ms 节流过了。
 * 这些按钮走的是 document 上的委托，重画不会掉监听。
 */
function syncUpdateBlocks() {
  const html = updateStatusHtml(state.update || {});
  for (const el of document.querySelectorAll('[data-up-block]')) el.innerHTML = html;
}

function openUpdatePanel() {
  const panel = $('#update-panel');
  if (!panel) return;
  syncUpdateBlocks();
  panel.hidden = false;
  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
}

function closeUpdatePanel() {
  const panel = $('#update-panel');
  if (!panel) return;
  panel.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
  setTimeout(() => { if (!panel.classList.contains('is-open')) panel.hidden = true; }, 240);
}

/** 主进程推来的状态。 */
/**
 * 自动更新的两个偏好。
 *
 * <p>取不到时按「开」—— 与 settings.js 里的默认值保持一致。
 * 用户显式关掉才关（`false` 是一个有意义的值，不能用 `||` 兜）。
 */
function updatePref() {
  const d = (state.defaults && state.defaults.update) || {};
  const v = (state.settings && state.settings.update) || {};
  return {
    autoDownload: v.autoDownload === undefined ? d.autoDownload !== false : !!v.autoDownload,
    autoInstall: v.autoInstall === undefined ? d.autoInstall !== false : !!v.autoInstall
  };
}

/* 自动安装的倒计时。变量放模块级而不是 state 里：它是一段正在进行的过程，
   不是「设置」或「当前状态」，重绘时不该被一起清掉。 */
let autoInstallTimer = null;
let autoInstallLeft = 0;

function stopAutoInstallCountdown() {
  if (autoInstallTimer) clearInterval(autoInstallTimer);
  autoInstallTimer = null;
  const bar = $('#update-now');
  if (bar) bar.hidden = true;
}

/**
 * 开始自动安装前的倒计时。
 *
 * <p><b>为什么要有倒计时</b>：自动更新的最后一步是**重启浏览器去装**，
 * 而重启会丢掉当前页面里没保存的内容。下载完就立刻退，用户连看清楚
 * 发生了什么的机会都没有。这里给 8 秒，想留的可以点「稍后」。
 *
 * <p>不用 toast 代替：那是单例元素，别的提示一来就被顶掉 ——
 * 而「再有 8 秒就要重启」这件事被顶掉等于没提示。
 */
function startAutoInstallCountdown(seconds = 8) {
  const bar = $('#update-now');
  const sec = $('#update-now-sec');
  if (!bar || !sec) return;
  stopAutoInstallCountdown();
  autoInstallLeft = seconds;
  sec.textContent = String(autoInstallLeft);
  bar.hidden = false;
  autoInstallTimer = setInterval(() => {
    autoInstallLeft -= 1;
    // 每次都重新取元素：面板重绘不该让这条倒计时失去落点
    const s2 = $('#update-now-sec');
    if (s2) s2.textContent = String(Math.max(0, autoInstallLeft));
    if (autoInstallLeft <= 0) {
      stopAutoInstallCountdown();
      doInstallUpdate();
    }
  }, 1000);
}

/** 拉起安装器并重启。两个入口（倒计时到点 / 用户点「立即重启」）共用。 */
async function doInstallUpdate() {
  stopAutoInstallCountdown();
  try {
    const r = await bridge.update.install();
    // quitAndInstall 会返回 false（未打包、或 electron-updater 取不到）。
    // **不检查它的话，用户点了「立即重启」而什么都没发生，界面也不说一句** ——
    // 看起来就像那个按钮坏了。
    if (!r || r.ok !== true) {
      toast('无法启动安装：当前环境不支持自动安装（未打包，或缺少更新组件）', 5600);
    }
  } catch (e) {
    // 装不起来要说一声：否则界面看起来像「点了没反应」
    toast('启动安装失败：' + String(e && e.message || e), 5200);
  }
}

function applyUpdateState(s) {
  if (!s || typeof s !== 'object') return;
  state.update = Object.assign({}, state.update, s, {
    percent: s.status === 'downloading' ? (state.update.percent || 0) : 0
  });
  renderUpdateBtn();
  // 无条件重画：小窗与「关于」分区都要跟着走（见 syncUpdateBlocks）
  syncUpdateBlocks();

  const pre = updatePref();
  const ver = (s.info && s.info.version) || '';

  /* 自动下载。
   * 用版本号做去重键（而不是一个布尔开关）：同一版只自动下一次。
   * 主进程会在每次状态变化时推一帧，用布尔开关的话第二次推来的 'available'
   * 就又触发一次下载。 */
  if (s.status === 'available' && pre.autoDownload && ver
      && state.update.autoDlFor !== ver) {
    state.update.autoDlFor = ver;
    // 面板开着时不再弹提示（用户正看着那上面的「下载更新」按钮）
    const panel = $('#update-panel');
    if (!panel || panel.hidden) toast(`发现新版本 ${ver}，正在自动下载…`, 3600);
    bridge.update.download().catch(() => { /* 状态里有错误，界面会显示 */ });
  }

  // 首次发现有新版时才主动提示一次，且只在面板关着的时候 ——
  // 用户正在看别的界面时不该被弹窗打断。
  // **自动下载开着时不提示**：那条提示写的是「点击工具栏的更新按钮」，
  // 而我们已经在替他下了，再让人去点一下是自相矛盾。
  if (!pre.autoDownload
      && s.status === 'available' && state.update.notified !== ver) {
    state.update.notified = ver;
    const panel = $('#update-panel');
    if (panel && panel.hidden) toast(`新版本 ${ver} 可用 · 点击工具栏的更新按钮`, 4200);
  }

  /* 自动安装。同样按版本去重；用户点过「稍后」之后本次运行内不再自动装
   * （cancelled 标记不落盘：下次启动是新的下载周期，该问还得问）。 */
  if (s.status === 'ready' && pre.autoInstall && ver
      && state.update.autoInstFor !== ver
      && !state.update.autoInstallCancelled) {
    state.update.autoInstFor = ver;
    startAutoInstallCountdown(8);
  }

  // 状态离开 ready（比如下载失败被重置）就把倒计时收掉，
  // 否则会留一条「8 秒后重启」而实际没什么可装
  if (s.status !== 'ready' && autoInstallTimer) stopAutoInstallCountdown();
}

/**
 * AI 面板里的 <webview> 是否已经可用（挂进 DOM 且 dom-ready 触发过）。
 *
 * <b>为什么必须判断</b>：Electron 的 webview 在 attach 到 DOM 之后、要等
 * {@code dom-ready} 事件触发，方法才可用 —— 在那之前调 executeJavaScript /
 * reload 会抛
 * {@code The WebView must be attached to the DOM and the dom-ready event emitted…}。
 * 这个错有个特别之处：<b>它会一路冒泡到 init() 的 catch</b>，
 * 弹出一句「初始化失败」，而真实原因只是「那个面板还没打开」——
 * 用户看到的是「浏览器启动失败」，排查时完全摸不到头绪（就是这次踩的）。
 *
 * <p>面板默认是 hidden 的，webview 在它第一次打开之前根本没 attach，
 * 所以「面板开着」也不等于「就绪」。只能用事件记账。
 */
function aiWebViewReady() {
  const wv = $('#ai-webview');
  // getWebContentsId 是 Electron 用来确认 webview 已就绪的探针：它同样要求
  // dom-ready，但它不抛异常（未就绪时返回 0），适合拿来做判断而不打扰用户。
  if (!wv) return false;
  try { return wv.getWebContentsId() > 0; } catch { return false; }
}

/** 等 webview 就绪；已经就绪就立刻 resolve。超时按失败算，不无限等。 */
function whenAiWebViewReady(timeout = 8000) {
  const wv = $('#ai-webview');
  if (!wv) return Promise.resolve(false);
  if (aiWebViewReady()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wv.removeEventListener('dom-ready', onReady);
      resolve(ok);
    };
    const onReady = () => { if (aiWebViewReady()) finish(true); };
    const timer = setTimeout(() => finish(false), timeout);
    wv.addEventListener('dom-ready', onReady);
    // 挂载可能已经发生过、只是事件早于我们这次监听到达，再补探测一次
    if (aiWebViewReady()) finish(true);
  });
}

/** 把文本带入 AI 网页对话的输入框（best-effort，跨域注入由宿主执行、不受页面 CSP 限制）。 */
async function aiInject(text) {
  const wv = $('#ai-webview');
  const ai = currentAi();
  if (!wv || !wv.getAttribute('src') || !ai.sel) return 'no-target';
  // 未就绪时不要硬调 —— 抛出来的错会冒泡到 init 的 catch，变成一句误导人的
  // 「初始化失败」。这里等它就绪（最多 8 秒），超时当没注入成。
  if (!(await whenAiWebViewReady())) return 'not-ready';
  const code = '(function(){'
    + 'try{'
    + 'var el=document.querySelector(' + JSON.stringify(ai.sel) + ');'
    + 'if(!el)return "no-input";'
    + 'el.focus();'
    + 'if(el.value!==undefined){'
    + 'var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;'
    + 's.call(el,' + JSON.stringify(text) + ');'
    + '}else{el.textContent=' + JSON.stringify(text) + ';}'
    + 'el.dispatchEvent(new Event("input",{bubbles:true}));'
    + 'el.dispatchEvent(new Event("change",{bubbles:true}));'
    + 'return "ok";'
    + '}catch(e){return "err:"+e.message;}'
    + '})()';
  try { return await wv.executeJavaScript(code); } catch (e) { return 'exec-fail'; }
}

async function aiSend() {
  if (aiIsApiMode()) return aiApiSend();
  const ai = currentAi();
  const text = ($('#ai-text') && $('#ai-text').value || '').trim();
  if (!text) { toast('先写点内容'); return; }
  let url = ai.url;
  if (!url) {
    // 自定义：从输入框取地址
    url = ($('#ai-custom-url') && $('#ai-custom-url').value || '').trim();
    if (!/^https?:/i.test(url)) { toast('请填写自定义 AI 对话地址（https://…）'); return; }
  }
  const wv = $('#ai-webview');
  if (!wv) return;
  if (!wv.getAttribute('src') || wv.src !== url) {
    // 还没在目标对话页：先载入，载入完成后再把内容带进去
    state.aiPending = text;
    wv.src = url;
    toast('正在打开 ' + ai.name + ' 对话…');
  } else {
    const r = await aiInject(text);
    if (r !== 'ok') toast('已打开对话页，把内容贴进去即可');
  }
}

/* --- AI · API 模式（内嵌网页常被对方以「环境异常」拒绝渲染，故走自己的 API）--- */
const AI_API_DEFAULTS = { base: 'https://api.deepseek.com', model: 'deepseek-chat' };

function aiIsApiMode() {
  const sel = $('#ai-select');
  return !!sel && sel.value === 'api';
}

/** 按当前选中的模式切换：API 模式显示配置+消息列表、藏起 webview；网页模式相反。 */
function applyAiMode() {
  const api = aiIsApiMode();
  const apiBox = $('#ai-api');
  const wv = $('#ai-webview');
  if (apiBox) apiBox.hidden = !api;
  if (wv) wv.style.display = api ? 'none' : '';
}

/** 把设置里存的 API 配置填进输入框（只填空着的，避免覆盖用户正在输入的）。 */
function aiApiLoadCfg() {
  const cfg = (state.settings && state.settings.aiApi) || {};
  const base = $('#ai-api-base'), key = $('#ai-api-key'), model = $('#ai-api-model');
  if (base && !base.value) base.value = cfg.base || AI_API_DEFAULTS.base;
  if (key && !key.value) key.value = cfg.key || '';
  if (model && !model.value) model.value = cfg.model || AI_API_DEFAULTS.model;
}

/** 存配置到设置（本机落盘，不联网）。 */
async function aiApiSaveCfg() {
  const aiApi = aiApiCfg();
  state.settings = Object.assign({}, state.settings, { aiApi });
  try { await bridge.settings.patch({ aiApi }); } catch { /* 存不上不影响这次发送 */ }
}

function aiApiCfg() {
  return {
    base: ($('#ai-api-base') && $('#ai-api-base').value || '').trim() || AI_API_DEFAULTS.base,
    key: ($('#ai-api-key') && $('#ai-api-key').value || '').trim(),
    model: ($('#ai-api-model') && $('#ai-api-model').value || '').trim() || AI_API_DEFAULTS.model
  };
}

/** 往消息列表追加一条。role: 'me' | 'ai' | 'err'。文本按纯文本追加，不当 HTML 执行。 */
function aiChatAppend(role, text) {
  const box = $('#ai-chat');
  if (!box) return null;
  const div = document.createElement('div');
  div.className = 'ai-msg ai-msg-' + role;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

async function aiApiSend() {
  const text = ($('#ai-text') && $('#ai-text').value || '').trim();
  if (!text) { toast('先写点内容'); return; }
  const cfg = aiApiCfg();
  if (!cfg.key) { toast('先填 API Key（AI 面板顶部）'); return; }
  await aiApiSaveCfg();
  if (!state.aiApiMessages) state.aiApiMessages = [];
  state.aiApiMessages.push({ role: 'user', content: text });
  aiChatAppend('me', text);
  const ta = $('#ai-text'); if (ta) ta.value = '';
  const thinking = aiChatAppend('ai', '思考中…');
  const r = await bridge.ai.chat({ base: cfg.base, key: cfg.key, model: cfg.model, messages: state.aiApiMessages });
  if (thinking) thinking.remove();
  if (r && r.ok) {
    state.aiApiMessages.push({ role: 'assistant', content: r.content });
    aiChatAppend('ai', r.content);
  } else {
    // 失败时撤掉刚追加的用户消息，别在上下文里留一条没回复的
    state.aiApiMessages.pop();
    aiChatAppend('err', (r && r.error) || '请求失败');
  }
}

/** 把当前标签页选中的文字（没有选中则退而取标题+地址）带进输入框。 */
async function aiGrab() {
  const t = activeTab();
  let text = '';
  if (t && t.webview && typeof t.webview.executeJavaScript === 'function') {
    try { text = await t.webview.executeJavaScript('(window.getSelection?window.getSelection().toString():"")'); } catch { /* 跨域或没权限就算了 */ }
  }
  if (!text || !text.trim()) {
    text = (t && t.title ? t.title + '\n' : '') + (t && t.url ? t.url : '');
  }
  if (!text.trim()) { toast('没有可带入的内容'); return; }
  const ta = $('#ai-text');
  if (ta) { ta.value = (ta.value ? ta.value + '\n\n' : '') + text.trim(); ta.focus(); }
  openAiPanel();
}

function wireUi() {
  // 窗口控制
  $$('[data-win]').forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.dataset.win;
      if (act === 'minimize') bridge.window.minimize();
      else if (act === 'maximize') bridge.window.maximize();
      else bridge.window.close();
    });
  });

  // 标签
  $('#tab-new').addEventListener('click', () => createTab(newTabUrl(), state.settings.defaultEngine));
  $('#tab-list-btn').addEventListener('click', openTabGrid);
  $('#tg-close').addEventListener('click', closeTabGrid);
  $('#tg-new').addEventListener('click', () => { createTab(newTabUrl(), state.settings.defaultEngine); closeTabGrid(); });

  // 导航。goBack / goForward 与 canGoBack 一样要求 webview 已 dom-ready，
  // 同样用 getWebContentsId() 探一下并接住异常 —— 按钮虽然已按就绪状态禁用了，
  // 但「禁用状态」与「真实就绪状态」之间仍可能有一瞬不一致（比如刚 attach
  // 就被点），那一瞬抛出来的错会变成一个无人接的 promise 异常。
  $('#nav-back').addEventListener('click', () => navGo('back'));
  $('#nav-forward').addEventListener('click', () => navGo('forward'));
  $('#nav-reload').addEventListener('click', () => {
    const t = activeTab();
    if (!t || !t.webview) return;
    // reload 同样要求 dom-ready（见 navGo 的注释）。没就绪时退回「重设 src」，
    // 那条路不需要就绪 —— 于是用户点刷新永远有反应，而不是抛一个
    // 「The WebView must be attached to the DOM…」上来。
    try {
      if (typeof t.webview.reload === 'function'
          && typeof t.webview.getWebContentsId === 'function'
          && t.webview.getWebContentsId() > 0) {
        t.webview.reload();
        return;
      }
    } catch { /* 落到下面那条 */ }
    t.webview.setAttribute('src', t.url);
  });
  $('#nav-home').addEventListener('click', () => { const t = activeTab(); if (t) navigate(t.id, state.settings.homepage); });

  /* --- 点地址栏网址 → 分享面板（input 相关的监听在下面 const input 之后挂）--- */
  // 分享面板里的动作
  $('#omni-share') && $('#omni-share').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-share]');
    if (b) handleShareAction(b.dataset.share);
  });
  // 点外面收起分享面板（落点在地址栏或面板内则不收）
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t && typeof t.closest === 'function'
        && (t.closest('#omni-share') || t.closest('#omni-input'))) return;
    closeOmniShare();
  });
  // 二维码弹层
  $('#qr-close') && $('#qr-close').addEventListener('click', closeQrModal);
  $('#qr-modal') && $('#qr-modal').addEventListener('click', (ev) => { if (ev.target.id === 'qr-modal') closeQrModal(); });
  $('#qr-copy') && $('#qr-copy').addEventListener('click', async () => {
    const pop = $('#omni-share');
    if (pop && pop.dataset.url) { await bridge.system.copy(pop.dataset.url); toast('链接已复制'); }
  });

  // 地址栏
  const input = $('#omni-input');
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const url = resolveInput(input.value);
      const t = activeTab();
      if (url && t) navigate(t.id, url);
      input.blur();
    } else if (ev.key === 'Escape') {
      syncOmnibox();
      input.blur();
    }
  });
  input.addEventListener('focus', () => input.select());
  // 点网址（地址栏还没聚焦时的那次点击）→ 弹分享面板；已在编辑态不弹。
  // 一开始打字（input）就收起，让位给编辑。
  input.addEventListener('mousedown', () => { if (document.activeElement !== input) openOmniShare(); });
  input.addEventListener('input', closeOmniShare);

  $('#omni-star').addEventListener('click', async () => {
    const t = activeTab();
    if (!t) return;
    // 顺手把 favicon 一起存下来：收藏夹栏那一格要画图标，而书签本身只带
    // 标题与网址。此刻标签页手上正拿着这张图，不必日后翻一次书签就往
    // 十来家站点各发一个 favicon.ico 去猜。
    state.bookmarks = await bridge.bookmarks.add({
      title: t.title, url: t.url, favicon: t.favicon || null
    });
    // refreshCurrent 会一并把星标点亮、把收藏夹栏补上那一条
    refreshCurrent();
    toast('已加入书签');
  });

  // 收藏夹栏：左键在当前标签页打开，右键移出。
  // 栏里不放删除按钮 —— 一格只有 24px 高、标题本来就是截断的，再塞个 ×
  // 进去会把标题挤成两个字，而这条栏的全部价值就是「一眼看得见标题」。
  const bmBar = $('#bookmark-bar');
  bmBar.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-bm]');
    if (!el) return;
    const t = activeTab();
    if (t) navigate(t.id, el.dataset.bm);
  });
  bmBar.addEventListener('contextmenu', async (ev) => {
    const el = ev.target.closest('[data-bm]');
    if (!el) return;
    // 拦掉默认菜单。Electron 里渲染进程默认不弹，但开发工具打开时或换到
    // 别的平台就会，而这里要的是一个「右键即移出」的确定动作。
    ev.preventDefault();
    state.bookmarks = await bridge.bookmarks.remove(el.dataset.bm);
    refreshCurrent();
    toast('已移出收藏夹栏');
  });

  // 工具栏
  $('#omni-engine').addEventListener('click', (ev) => { ev.stopPropagation(); toggleEngineMenu(); });
  $('#engine-menu').addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('click', closeEngineMenu);

  $('#btn-shield').addEventListener('click', () => openPanel('adblock'));
  $('#btn-sniff').addEventListener('click', () => openPanel('sniffer'));

  /* 拼图图标 = 打开**独立的扩展小窗**（就地开关），不再直接跳进设置。
   *
   * 收起用「看落点」而不是给小窗加 stopPropagation —— 这一点是踩出来的：
   * 小窗里那些开关走的是 document 上的委托（卡片/行会随列表重绘，
   * 逐行绑定会漏绑），一旦小窗把 click 拦在冒泡路上，里面的开关就**永远点不动**
   * （界面完好、点击有反馈、就是不生效）。所以这里只判落点是不是落在
   * 小窗或按钮里面，是就放过。 */
  $('#btn-ext').addEventListener('click', toggleExtPopover);
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t && typeof t.closest === 'function'
        && (t.closest('#ext-popover') || t.closest('#btn-ext'))) return;
    closeExtPopover();
  });
  $('#ext-pop-close').addEventListener('click', closeExtPopover);
  // 窗口尺寸变了（尤其窗口变窄）小窗可能贴出可视区，收起最稳
  window.addEventListener('resize', closeExtPopover);
  $('#ext-pop-manage').addEventListener('click', () => {
    closeExtPopover();
    openPanel('extensions');
  });
  $('#ext-pop-install').addEventListener('click', async () => {
    // 走设置页那个按钮用的**同一个函数**，不在这儿再抄一遍装扩展的逻辑
    // （抄一份出来，两处迟早只改一处）。
    await installExtensionsFromDisk();
  });
  // 从浏览器导入：就地扫、就地导入，不再为了这一步专门跳去设置页
  $('#ext-pop-import').addEventListener('click', scanExtImport);

  $('#btn-ai').addEventListener('click', openAiPanel);
  $('#btn-menu').addEventListener('click', renderMenuPanel);

  /* 左上角品牌区 → 设置。
   *
   * 键盘可达性要自己补：用的是 div + role="button"，浏览器不会替它把
   * Enter/Space 变成 click（只有真 <button> 才有那套默认行为）。
   * 漏了这一步，鼠标能点、键盘按不动 —— 而这种「一半可用」最容易被忽略。 */
  {
    const brand = $('#btn-brand');
    if (brand) {
      brand.addEventListener('click', () => openPanel('settings'));
      brand.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
          ev.preventDefault();     // Space 不 preventDefault 会顺带滚动页面
          openPanel('settings');
        }
      });
    }
  }
  $('#drawer-close').addEventListener('click', closeDrawer);

  // AI 助手面板：下拉切换 / 带入当前页 / 发送 / 清空 / 关闭
  $('#ai-close').addEventListener('click', closeAiPanel);
  $('#ext-ui-close').addEventListener('click', closeExtUiPanel);
  wireExtUiWebview();
  $('#ai-grab').addEventListener('click', aiGrab);
  $('#ai-send').addEventListener('click', aiSend);
  $('#ai-clear').addEventListener('click', () => {
    const ta = $('#ai-text'); if (ta) ta.value = '';
    // API 模式下「清空」连对话一起清（那是这一模式的「内容」）
    if (aiIsApiMode()) {
      state.aiApiMessages = [];
      const box = $('#ai-chat'); if (box) box.innerHTML = '';
    }
  });
  $('#ai-select').addEventListener('change', () => {
    applyAiMode();
    if (aiIsApiMode()) { aiApiLoadCfg(); return; }
    const ai = currentAi();
    const custom = !ai.url; // 自定义项没有预设地址
    $('#ai-custom').hidden = !custom;
    const wv = $('#ai-webview');
    if (wv && !custom && wv.getAttribute('src') !== ai.url) wv.src = ai.url;
  });
  // webview 载入完成后，若发送时还没在目标对话页、暂存了内容，则补注入。
  //
  // 两个事件都挂：dom-ready 保证「面板刚打开、webview 首次可用」这一路也能补上
  // （只有 did-finish-load 的话，面板一直没打开过就永远等不到那次事件，
  // 用户点发送看到的是「正在打开…」然后内容没了）。
  // 注入走 aiInject，它自己会等就绪并在失败时如实返回，不会把异常抛到外面。
  const aiWv = $('#ai-webview');
  if (aiWv) {
    const flushPending = async () => {
      if (!state.aiPending) return;
      const text = state.aiPending;
      const r = await aiInject(text);
      // 只在真的注入进去（或明确失败）后才清暂存，否则失败一次内容就没了
      if (r === 'ok' || r === 'no-input' || r === 'err') state.aiPending = '';
      if (r === 'not-ready' || r === 'exec-fail') toast('对话页还没准备好，请再点一次发送');
    };
    aiWv.addEventListener('did-finish-load', flushPending);
    aiWv.addEventListener('dom-ready', flushPending);
  }

  // 拖拽安装扩展：把 .crx/.zip/.xpi 拖进浏览器窗口即装。见 wireDropInstall。
  wireDropInstall();

  // 自动更新：按钮开面板，面板里那几个动作按 data-up 分发。
  //
  // 先问一次当前状态再触发检查：主进程里那个 updaterState 跨渲染层重启
  // 是留着的（主进程不重启就一直有效），而外壳每次打开都是新的 ——
  // 只靠检查事件的话，上次已经查到的「有新版」这一档会被漏掉，
  // 按钮就不亮了。
  {
    const btn = $('#btn-update');
    if (btn) btn.addEventListener('click', openUpdatePanel);
    const panel = $('#update-panel');
    if (panel) $('#update-close').addEventListener('click', closeUpdatePanel);

    /* 更新相关的按钮**一律靠委托**处理，挂在 document 上而不是某个容器上。
     *
     * <p>原因：这些按钮现在出现在**两个地方** —— 顶栏那个齿轮浮层（#update-body）
     * 与「关于」面板（#drawer-body 里，走菜单 → 关于进来）。原先绑在 #update-body 上，
     * 于是「关于」里那几个按钮**点不动**：它们渲染出来了、有样式、就是不响应。
     * 那种「看起来能点其实不能」比没有按钮更难排查。
     *
     * <p>挂 document 的代价是事件多走一层 closest()，换来的是新增一个入口
     * 不必记得回来补一行绑定 —— 而这次错的正是这一处。 */
    document.addEventListener('click', async (ev) => {
      /* 自动更新的两个开关。
       * 与上面 data-up 同一个理由用 document 委托：这些开关渲染在
       * 「关于」面板里（设置视图内），而设置分区会被整体重绘 ——
       * 逐行绑定的话每次重画都要重绑一遍，漏一次就是「开关点不动」。 */
      const cfg = ev.target.closest('[data-upcfg]');
      if (cfg) {
        const key = cfg.dataset.upcfg;
        const next = !cfg.classList.contains('is-on');
        cfg.classList.toggle('is-on', next);
        cfg.title = next ? '已开启' : '已关闭';
        await bridge.settings.patch({ update: { [key]: next } });
        // 就地更新本地那份：preload 只给了 settings.patch，没有 get
        // （写 bridge.settings.get() 会是一个 undefined 的函数调用）。
        // 而且这里本来也不需要回读 —— 我们刚写进去的就是结果。
        state.settings = Object.assign({}, state.settings, {
          update: Object.assign({}, (state.settings && state.settings.update) || {},
            { [key]: next })
        });
        // 关掉「自动安装」时把已经挂着的倒计时一并收掉 ——
        // 不然那条「N 秒后重启」还挂在那儿，而用户刚明确说了不要自动装
        if (key === 'autoInstall' && !next) {
          stopAutoInstallCountdown();
          state.update.autoInstallCancelled = true;
        }
        toast(next ? '已开启' : '已关闭');
        return;
      }

      const imp = ev.target.closest('[data-imp-ext]');
      if (imp) {
        const key = imp.dataset.impExt;
        const tail = imp.querySelector('.lr-tail');
        if (tail) tail.textContent = '导入中…';
        imp.style.pointerEvents = 'none';
        const r = await bridge.extensions.importFromBrowser(key);
        if (r && r.error) {
          toast(r.error, 6000);
          if (tail) tail.textContent = '导入';
          imp.style.pointerEvents = '';
        } else if (r) {
          state.extensions = await bridge.extensions.list();
          // 导入过的从候选列表里去掉（它已经在「已安装」那一块里了）
          stateBrowserExts = (stateBrowserExts || []).filter((x) => x.key !== key);
          toast(`已导入「${r.name || ''}」（来自 ${r.from || '其它浏览器'}）`, 4200);
          refreshCurrent();
        }
        return;
      }

      // 变量名不能复用下面的 t（同一个作用域里重复 const 声明是语法错）
      const sw = ev.target.closest('[data-ext-toggle]');
      if (sw) {
        const id = sw.dataset.extToggle;
        const next = !sw.classList.contains('is-on');
        // 先禁掉，避免连点两次发出两次相反的操作（第二次会基于旧列表算错方向）
        sw.disabled = true;
        const r = await bridge.extensions.setEnabled(id, next);
        sw.disabled = false;
        if (r && r.error) {
          toast(r.error, 5200);
        } else {
          state.extensions = await bridge.extensions.list();
          // 开关要立刻对正在看的页生效：Electron 的 load/removeExtension 只对
          // 之后的导航生效，不重载当前页用户会以为开关是摆设（见 reloadChromiumTabs）
          toast(next ? '已启用，正在刷新打开的页面让扩展生效' : '已关闭，正在刷新打开的页面');
          reloadChromiumTabs();
        }
        // 同一个状态显示在两处（设置页那一片 + 工具栏小窗），只重画一处，
        // 另一处会停在上一次的位置上，看起来像那个开关没生效
        renderExtPopover();
        refreshCurrent();
        return;
      }

      // 「打开界面」：把 side_panel / popup / 选项页载进右侧停靠面板（见 openExtUiPanel）
      const eo = ev.target.closest('[data-ext-open]');
      if (eo) {
        // 从工具栏小窗点进来时先把小窗收起，两个停靠层别叠在一起
        if (eo.closest('#ext-popover')) closeExtPopover();
        openExtUiPanel(eo.dataset.extOpen);
        return;
      }

      // 导入视图的「返回已装扩展」
      const eback = ev.target.closest('[data-ext-pop-back]');
      if (eback) { state.extPopView = 'installed'; renderExtPopover(); return; }

      // 小窗里的「导入」：从本机浏览器搬一个扩展过来（与设置页同一个 IPC）
      const ei = ev.target.closest('[data-ext-import]');
      if (ei) {
        const key = ei.dataset.extImport;
        ei.textContent = '导入中…';
        ei.disabled = true;
        const r = await bridge.extensions.importFromBrowser(key);
        if (r && r.error) {
          toast(r.error, 6000);
          ei.textContent = '导入';
          ei.disabled = false;
        } else if (r) {
          state.extensions = await bridge.extensions.list();
          // 导入过的从候选里去掉（它已经进「已安装」了）
          state.extImport = (state.extImport || []).filter((x) => x.key !== key);
          toast(`已导入「${r.name || ''}」（来自 ${r.from || '其它浏览器'}）`, 4200);
          renderExtPopover();
          refreshCurrent();
        }
        return;
      }

      const t = ev.target.closest('[data-up]');
      if (!t) return;
      const act = t.dataset.up;
      if (act === 'check') {
        t.disabled = true;
        try { await bridge.update.check(); } catch { /* 主进程已兜 */ }
        t.disabled = false;
        syncUpdateBlocks();
        // 「关于」分区也在 [data-up-block] 之列，上面那一句已经把它画过了。
        // 这里再 refreshCurrent() 是因为**同一个面板里还有别的东西随状态变**
        // （比如那一行的按钮禁用态）；用它而不是 openPanel('about')：
        // 后者会 openSettings 把设置视图整个打开，而用户此刻正站在设置里的
        // 「关于」分区上 —— 那会把人从当前位置弹走。
        refreshCurrent();
      } else if (act === 'download') {
        t.disabled = true;
        toast('开始下载更新…');
        try { await bridge.update.download(); } catch { /* 状态里有错误 */ }
        syncUpdateBlocks();
        refreshCurrent();
      } else if (act === 'install') {
        await bridge.update.install();
      } else if (act === 'later') {
        closeUpdatePanel();
        refreshCurrent();
      }
    });

    // 状态同步：主进程推来的每一帧都画一遍。
    bridge.on('update:state', (s) => applyUpdateState(s));
    bridge.on('update:progress', (p) => {
      state.update.percent = p && p.percent ? p.percent : 0;
      renderUpdateBtn();
      // 条件里**不要**写「小窗开着才重画」：那样「关于」那一页的进度条会僵住
      syncUpdateBlocks();
    });

    renderUpdateBtn();
    // 拿到已有状态（可能上次已查到有新版），再触发一次后台检查
    bridge.update.status().then((s) => {
      if (s) applyUpdateState(s);
    }).catch(() => {});
    // 静默检查：不弹窗，等主进程推状态回来。
    // 查到有新版之后会不会自动下、自动装，由 updatePref() 决定（见 applyUpdateState）
    setTimeout(() => { bridge.update.check().catch(() => {}); }, 2500);

    /* 倒计时条上的两个按钮。
     * 「稍后」不只是把这条收起来 —— 还要**标记本次运行内别再自动装**，
     * 否则主进程任何一次状态推送（比如用户去设置里改了个开关触发的推送）
     * 都会让倒计时重新开始，用户按几次都关不掉。 */
    const later = $('#update-now-later');
    if (later) {
      later.addEventListener('click', () => {
        stopAutoInstallCountdown();
        state.update.autoInstallCancelled = true;
        toast('已推迟，本次运行不再自动安装（可在 关于 里手动重启安装）', 4200);
      });
    }
    const go = $('#update-now-go');
    if (go) go.addEventListener('click', doInstallUpdate);

    window.addEventListener('beforeunload', stopAutoInstallCountdown);
  }

  // 地址栏旁的下载小窗
  $('#btn-downloads').addEventListener('click', () => {
    const pop = $('#dl-popover');
    if (!pop) return;
    pop.hidden = !pop.hidden;
    // 用户主动点开 → 允许下次新下载再自动弹出
    if (!pop.hidden) { state.dlAutoOpen = true; renderDownloadPopover(); }
  });
  $('#dl-pop-close').addEventListener('click', () => {
    const pop = $('#dl-popover');
    if (pop) { pop.hidden = true; state.dlAutoOpen = false; }
  });
  $('#dl-pop-open-dir').addEventListener('click', async () => {
    try { await bridge.downloads.open(state.downloadsDir || ''); } catch { /* 目录可能为空 */ }
  });
  $('#dl-pop-clear').addEventListener('click', async () => {
    state.downloads = await bridge.downloads.clearFinished();
    renderDownloadPill();
    refreshDownloadPopover(true);
  });
  $('#dl-pop-all').addEventListener('click', () => {
    const pop = $('#dl-popover');
    if (pop) pop.hidden = true;
    openPanel('downloads');
  });
  $('#scrim').addEventListener('click', closeDrawer);
  $('#sv-back').addEventListener('click', goSettingsBack);
  $('#sv-close').addEventListener('click', closeSettings);
  // 设置页从整屏改成窗口后多了圈暗底，点它也该能关 —— 应用里另一处暗底
  // （抽屉的 .scrim）就是这么做的，同一套视觉语言不该有两种脾气。
  //
  // 判据用 mousedown 的落点，不是只看 click：在窗口里选中一段文字、手一滑
  // 松到窗外，click 的 target 会是暗底 —— 那样「拖选」会被当成「点外面」，
  // 用户一松手窗就没了。按下与松开都落在暗底上才算数。
  let svPressedBackdrop = false;
  const svView = $('#settings-view');
  svView.addEventListener('mousedown', (ev) => { svPressedBackdrop = ev.target === svView; });
  svView.addEventListener('click', (ev) => {
    if (svPressedBackdrop && ev.target === svView) closeSettings();
    svPressedBackdrop = false;
  });
  $('#engine-notice-close').addEventListener('click', () => { $('#engine-notice').hidden = true; });

  // 加载失败提示页：重试 / 回到首页
  $('#pe-retry') && $('#pe-retry').addEventListener('click', () => {
    const t = activeTab();
    if (!t) return;
    t.loadError = null; renderPageError();
    if (t.webview && typeof t.webview.reload === 'function') t.webview.reload();
    else navigate(t.id, t.url);
  });
  $('#pe-home') && $('#pe-home').addEventListener('click', () => {
    const t = activeTab();
    if (!t) return;
    t.loadError = null; renderPageError();
    navigate(t.id, state.settings.homepage);
  });

  // 移动端
  $('#mb-back').addEventListener('click', () => { const t = activeTab(); if (t && t.webview && t.webview.canGoBack) t.webview.goBack(); });
  $('#mb-forward').addEventListener('click', () => { const t = activeTab(); if (t && t.webview && t.webview.canGoForward) t.webview.goForward(); });
  $('#mb-tabs').addEventListener('click', openTabGrid);
  $('#mb-engine').addEventListener('click', openSheet);
  $('#mb-read').addEventListener('click', openReadSheet);
  $('#mb-menu').addEventListener('click', renderMenuPanel);
  $('#engine-sheet').addEventListener('click', (ev) => { if (ev.target.id === 'engine-sheet') closeSheet(); });
  $('#read-sheet').addEventListener('click', (ev) => { if (ev.target.id === 'read-sheet') closeReadSheet(); });

  // 快捷键
  window.addEventListener('keydown', (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === 't') { ev.preventDefault(); createTab(newTabUrl(), state.settings.defaultEngine); }
    else if (mod && ev.key.toLowerCase() === 'w') { ev.preventDefault(); if (state.activeId) closeTab(state.activeId); }
    else if (mod && ev.key.toLowerCase() === 'l') { ev.preventDefault(); $('#omni-input').focus(); }
    else if (mod && ev.shiftKey && ev.key.toLowerCase() === 'a') { ev.preventDefault(); openPanel('adblock'); }
    else if (ev.key === 'F5') { ev.preventDefault(); $('#nav-reload').click(); }
    else if (ev.altKey && ev.key === 'ArrowLeft') { ev.preventDefault(); $('#nav-back').click(); }
    else if (ev.altKey && ev.key === 'ArrowRight') { ev.preventDefault(); $('#nav-forward').click(); }
    else if (ev.key === 'Escape') { closeEngineMenu(); closeDrawer(); closeAiPanel(); closeExtUiPanel(); closeQrModal(); closeOmniShare(); closeUpdatePanel(); closeExtPopover(); closeTabGrid(); closeSheet(); closeReadSheet(); closeSettings(); }
    else if (mod && ev.key === 'Tab') {
      ev.preventDefault();
      if (state.tabs.length < 2) return;
      const idx = state.tabs.findIndex((t) => t.id === state.activeId);
      const next = state.tabs[(idx + (ev.shiftKey ? -1 + state.tabs.length : 1)) % state.tabs.length];
      activateTab(next.id);
    }
  });

  wireQuickBar();
  window.addEventListener('resize', applyLayout);
}

/* ------------------------------------------------------------------ *
 * 主进程事件
 * ------------------------------------------------------------------ */

function wireBridgeEvents() {
  bridge.on('adblock:hit', () => {
    state.hitCounter += 1;
    const pill = $('#shield-count');
    pill.textContent = String(state.hitCounter);
    if (state.panel === 'adblock' && state.hitCounter % 5 === 0) {
      bridge.adblock.stats().then((s) => { state.adblock = s; refreshCurrent(); });
    }
  });

  bridge.on('adblock:stats', (s) => { state.adblock = s; $('#shield-count').textContent = String(s.blocked); });
  bridge.on('ext:changed', (list) => {
    state.extensions = list;
    // 小窗一直挂在那儿（点别处才收起），主进程推来的变化要立刻反映上去
    renderExtPopover();
  });

  /* 拖到**网页区域**装扩展的结果。
   *
   * <p>那条路在外壳的 document.drop 之外（网页是独立渲染进程，事件被它接走了），
   * 由主进程拦 file:// 导航处理 —— 所以结果也只能这样推回来。
   * 不接这一条的话，用户在网页上拖入扩展会**装成功却毫无提示**。
   */
  bridge.on('ext:dropped', (r) => {
    if (r && r.ok) {
      toast(`已安装扩展：${r.name || ''}`, 4200);
      if (state.settingsSection === 'extensions') refreshCurrent();
    } else if (r && r.error) {
      toast(r.error, 5200);
    }
  });
  bridge.on('download:update', (d) => {
    // 优先按 id 认（同一个文件重复下载时要能区分开），退而求其次才按 文件名+URL
    const i = state.downloads.findIndex((x) => (d.id && x.id === d.id)
      || (x.filename === d.filename && x.url === d.url));
    if (i >= 0) state.downloads[i] = Object.assign({}, state.downloads[i], d);
    else state.downloads.unshift(d);
    // 进度事件很密，走节流刷新；输入框的草稿与焦点会被保留
    refreshDownloads();
    // 地址栏旁的下载小窗：角标 + 列表同步；有新的进行中任务且用户没收起时自动弹出
    renderDownloadPill();
    refreshDownloadPopover();
    const pop = $('#dl-popover');
    if (pop && pop.hidden && state.dlAutoOpen && activeDownloads().length) pop.hidden = false;
  });
  bridge.on('download:taken-over', (p) => {
    toast(`已接管到多线程引擎：${p.filename || hostOf(p.url) || '下载任务'}`);
  });

  /* --- 媒体嗅探 --- */
  bridge.on('sniff:found', (batch) => {
    if (!Array.isArray(batch)) return;
    for (const item of batch) {
      if (!item || item.tabId == null) continue;
      mergeSniffRecords(item.tabId, item.recs || []);
    }
    syncSniffBadge();
    refreshSniffer();
  });

  bridge.on('sniff:reset', (p) => {
    const tabId = p && p.tabId;
    if (tabId == null) state.sniffByWc.clear();
    else state.sniffByWc.delete(tabId);
    state.sniffPreview = null;
    syncSniffBadge();
    refreshSniffer(true);
  });

  bridge.on('sniff:update', (rec) => {
    if (!rec || rec.tabId == null) return;
    mergeSniffRecords(rec.tabId, [rec]);
    syncSniffBadge();
    refreshSniffer();
  });

  bridge.on('sniff:state', (s) => { state.sniffStats = s; });

  /* --- 无图模式 --- */
  bridge.on('mobile:stats', (s) => {
    if (!s) return;
    // 主进程推的是全局快照，没有当前标签页那份，本地补一次按页计数
    const t = activeTab();
    if (t && t.wcId != null && state.noMedia && state.noMedia.tabBlocked != null) {
      s = Object.assign({}, s, { tabBlocked: state.noMedia.tabBlocked });
    }
    state.noMedia = s;
    if (state.settingsSection === 'mobile') refreshCurrent();
    else {
      const read = $('#read-sheet');
      if (read && !read.hidden) renderReadSheet();
    }
  });

  // applyLayout 只在布局档位真的变了时重画收藏夹栏，而档位（bookmarkBar）
  // 与布局是两码事，所以这里还得显式补一次 —— 设置可能来自另一个窗口。
  bridge.on('settings:changed', (s) => {
    state.settings = s;
    applyLayout();
    renderBookmarkBar(true);
    // 设置页里改主题 / 收藏夹栏档位时，顶栏那两个快捷开关要跟着走。
    syncQuickBar();
  });
  bridge.on('tabs:open-request', (p) => {
    if (p.background) createTab(p.url, activeTab() ? activeTab().engineId : state.settings.defaultEngine, { activate: false });
    else createTab(p.url, activeTab() ? activeTab().engineId : state.settings.defaultEngine);
  });
  bridge.on('shell:viewport', applyLayout);

  // 主进程抓到一份新图标。重读一次那张表（同名主机也要重读 —— 内容变了）。
  // 这条推送是必须的：图标是异步到的，不推的话书签格会一直停在首字母上，
  // 直到用户下一次动书签才碰巧重画一次。
  bridge.on('favicon:updated', () => refreshHostIcons(true));

  // 内置新标签页发来的动作（加 / 删快捷方式）。
  //
  // 页面本身是本地文件，上不了 preload 那座桥 —— 它是跳一个
  // nova://shortcut/… 的地址，被主进程从 will-navigate 上截下来转发的。
  // 这里负责解析（规则在 ntp.js，与单测跑的是同一份），落盘交给主进程。
  bridge.on('ntp:command', async (p) => {
    const cmd = NovaNtpHost.parseCmd(p && p.url);
    if (!cmd) return;
    if (cmd.op === NovaNtpHost.OP_ADD) {
      await bridge.ntp.addShortcut(cmd.get('label'), cmd.get('url'));
      toast('已添加');
    } else if (cmd.op === NovaNtpHost.OP_REMOVE) {
      await bridge.ntp.removeShortcut(cmd.get('url'));
    } else if (cmd.op === NovaNtpHost.OP_STORE) {
      // 内置新标签页的「插件商店」入口：直接打开扩展面板（含商店），不重导这一屏。
      openPanel('extensions');
      return;
    } else if (cmd.op === NovaNtpHost.OP_SEARCH) {
      /* 新标签页中间那个搜索框。
       *
       * **不做 reloadNewTab**：搜索之后这一屏就不该再留着（否则用户搜完
       * 回到新标签页还能看到它，等于没走）。直接让这张标签页导航到结果页 ——
       * 新标签页本来就是在「还没有内容」时才显示的那一屏，有了内容它自然让位。
       *
       * 关键词再 trim 一次：页面侧已经 trim 过，但这里是**命令入口**，
       * 不该假定送命令的一定是那一页。 */
      const q = String(cmd.get('q') || '').trim();
      const tab = tabByWcId(p.id);
      if (q && tab) navigate(tab.id, searchUrl(q));
      return;
    }
    reloadNewTab(p.id);
  });
}

/** 主进程的 webContents id → 标签页。两者毫无关系，只能在 dom-ready 时记下来。 */
function tabByWcId(wcId) {
  return state.tabs.find((t) => t.wcId != null && t.wcId === wcId) || null;
}

/**
 * 重新加载某张标签页上的内置新标签页。
 *
 * 快捷方式那一屏是渲染时算好的（候选编在 URL 里），不重新导航的话，
 * 用户点了 × 屏幕上什么都没少 —— 看起来就是「这个按钮坏了」。
 *
 * 判一次 isNewTabUrl：命令是异步绕回来处理的，这中间用户可能已经点了
 * 某个磁贴跳走了，那时不该把他的页面拽回来。
 */
function reloadNewTab(wcId) {
  const tab = tabByWcId(wcId);
  if (!tab || !isNewTabUrl(tab.url)) return;
  navigate(tab.id, newTabUrl());
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function init() {
  const boot = await bridge.bootstrap();

  state.engines = boot.engines;
  state.engineMap = new Map(boot.engines.map((e) => [e.id, e]));
  state.settings = boot.settings;
  state.newTabFileUrl = boot.newTabFileUrl || '';
  state.extensions = boot.extensions || [];
  state.bookmarks = boot.settings.bookmarks || [];
  state.adblock = boot.adblock || state.adblock;
  state.allowlist = boot.allowlist || [];
  state.defaults = boot.defaults || null;
  state.downloads = boot.downloads || [];
  state.dlAutoOpen = true; // 出现新下载时允许自动弹出地址栏旁的小窗
  // 自动更新状态。status: idle | checking | available | downloading | ready | error
  // info 里有 version / url / sha256 / size / notes（更新日志）
  state.update = { status: 'idle', info: null, error: '', percent: 0 };
  state.downloadStats = boot.downloadStats || null;
  state.downloadsDir = boot.downloadsDir || '';
  state.sniffFormats = boot.sniffFormats || null;
  state.sniffStats = boot.sniffStats || null;
  state.__versions = boot.versions;
  state.appVersion = boot.appVersion || '';
  state.platform = boot.platform;
  state.noMedia = boot.nomedia || null;
  state.noImageCss = boot.noImageCss || '';
  state.noImageJs = boot.noImageJs || '';

  try { state.userDataPath = await bridge.system.userDataPath(); } catch { state.userDataPath = ''; }

  document.documentElement.dataset.theme = boot.settings.theme || 'light';
  applyLayout();
  // 放在 applyLayout 之后：这条栏要先知道 state.layout 才决定渲不渲。
  // 此处标签页还没建，所以「仅新标签页」档位下一开始是收着的，等下面
  // createTab → activateTab 那次 syncBookmarkBar 再把它放出来。
  renderBookmarkBar(true);
  // 书签格上的站点图标。这里问一次（不 await）：那张表是异步来的，拿到之后
  // refreshHostIcons 自己会重画一遍。不 await 是为了让它和下面 createTab
  // 那些初始化并行跑，不必等图标回来才把界面立起来。
  refreshHostIcons();
  syncQuickBar();

  if (state.isPreview) {
    const tag = $('#brand-tag');
    tag.textContent = 'UI 预览';
    tag.style.color = 'var(--warn)';
    tag.style.borderColor = 'var(--warn)';
  }

  renderEngineSwitch();
  wireUi();
  wireBridgeEvents();

  $('#shield-count').textContent = String(state.adblock.blocked || 0);
  $('#btn-shield').classList.toggle('is-off', !state.adblock.enabled);
  syncSniffBadge();

  // 首个标签页：按「恢复上次会话」决定是还原还是开主页
  const saved = boot.settings.session;
  const canRestore = boot.settings.restoreSession !== false
    && saved && Array.isArray(saved.tabs) && saved.tabs.length;

  if (canRestore) {
    // 内置新标签页走 restoreUrlFor 现算（原因见那个函数），其余页面照旧按快照恢复
    saved.tabs.forEach((t) => createTab(restoreUrlFor(t.url), t.engineId, { activate: false }));
    const idx = Math.min(Math.max(0, Number(saved.activeIndex) || 0), state.tabs.length - 1);
    activateTab(state.tabs[idx].id);
  } else {
    createTab(state.settings.homepage, state.settings.defaultEngine);
  }

  // 预览/调试深链接：?panel=settings 直接展开设置页对应分区
  const deep = new URLSearchParams(location.search).get('panel');
  if (deep) openPanel(deep);
}

/**
 * 这个错是不是「webview 还没 dom-ready 就被调用」那一类。
 *
 * <p>Electron 的 webview 在 attach 到 DOM 之后、要等 dom-ready 事件触发，
 * {@code canGoBack} / {@code goBack} / {@code reload} / {@code executeJavaScript}
 * 这些方法才可用 —— 在那之前调会抛这句。**它不代表启动失败**：
 * 真实情况只是「某个操作比页面加载快了一点」。
 *
 * <p>而弹「初始化失败」是最糟的处理：用户看到的是「浏览器启动失败」，
 * 实际浏览器好得很（页面照常打开、照常能用）。所以对已知的这一类**静默**
 * —— 界面会在 dom-ready 那一次把按钮状态刷对。
 */
function isWebViewNotReady(err) {
  const m = err && (err.message || String(err)) || '';
  return /must be attached to the DOM|dom-ready event emitted/i.test(m);
}

init().catch((err) => {
  console.error(err);
  // 带上栈。只打 message 的话，这类错完全看不出是谁调的 —— 栈是唯一的线索。
  if (isWebViewNotReady(err)) {
    console.warn('[Nova] 启动期有一步跑在页面就绪之前，已忽略：', err && err.message);
    return;
  }
  toast('初始化失败：' + (err && err.message ? err.message : String(err)), 6000);
});
