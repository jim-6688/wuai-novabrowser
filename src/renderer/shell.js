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
 * 内核桥接视图登记：viewId（= 标签页 id）→ { wrap, canvas, engineId }。
 * 主进程转发来的 host:event（frame/title/url/cursor）按 viewId 找到对应画布并绘制。
 * 只有 resolve 到 bridge 的内核（真·trident/gecko 宿主）才会进这里；compat 内核不在此列。
 */
const bridgeViews = new Map();

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

/**
 * 标签页 webview 的 preload：页面里的 Ctrl+滚轮 / Ctrl+±0 通过它转回外壳。
 * 用相对 shell.html 的路径拼，dev 与 asar 里都成立。
 */
const WEBVIEW_PRELOAD_URL = new URL('../preload/webview-preload.js', window.location.href).href;

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
  tabQuery: '',   // 多标签视图的搜索词
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

/** 凭证按 origin 归档（与主进程 cred:save-from-page 的口径一致），不是按主机名 */
function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch { return ''; }
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
  const engineKey = engineId || siteEngineFor(url || state.settings.homepage)
    || state.settings.defaultEngine || 'chromium';
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

/* ------------------------------------------------------------------ *
 * 内核桥接（bridge 模式）：真·trident/gecko 宿主渲染，画面以帧的形式推过来
 * ------------------------------------------------------------------ */

/** 宿主推来的事件：按 viewId 找到画布并画帧 / 同步地址标题 / 光标 */
function onHostEvent(msg) {
  if (!msg || typeof msg.viewId === 'undefined') return;
  const v = bridgeViews.get(msg.viewId);
  if (!v) return;
  const tab = state.tabs.find((t) => t.id === msg.viewId);
  switch (msg.t) {
    case 'frame':
      paintBridgeFrame(v.canvas, msg);
      break;
    case 'url':
      if (tab) { tab.url = msg.url; tab.loading = false; if (tab.id === state.activeId) syncOmnibox(); }
      renderTabstrip(); renderTabGrid();
      break;
    case 'title':
      if (tab) tab.title = msg.title || tab.title;
      renderTabstrip(); renderTabGrid();
      break;
    case 'cursor':
      v.canvas.style.cursor = (msg.cursor === 'pointer') ? 'pointer' : 'default';
      break;
    case 'error':
      console.warn('[bridge] 宿主报错：', msg.message);
      break;
    default:
      break;
  }
}

/** base64（无 Buffer 依赖）→ Uint8Array */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 把宿主推来的 BGRA 原始像素画到 canvas（BGRA → RGBA 后 putImageData，比经 PNG 更快） */
function paintBridgeFrame(canvas, msg) {
  const w = msg.w | 0;
  const h = msg.h | 0;
  if (w <= 0 || h <= 0) return;
  let bytes;
  try { bytes = base64ToBytes(msg.data); } catch { return; }
  if (bytes.length < w * h * 4) return;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = bytes[i + 2];     // R
    rgba[i + 1] = bytes[i + 1]; // G
    rgba[i + 2] = bytes[i];     // B
    rgba[i + 3] = bytes[i + 3]; // A
  }
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
}

/** 把 canvas 上的鼠标 / 键盘 / 滚轮事件转成宿主 input 指令 */
function wireBridgeInput(canvas, engineId, viewId) {
  const pos = (ev) => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.round(ev.clientX - r.left), y: Math.round(ev.clientY - r.top) };
  };
  canvas.tabIndex = 0; // 让 canvas 能收键盘焦点
  canvas.addEventListener('mousedown', (ev) => {
    const p = pos(ev);
    canvas.focus();
    bridge.host.cmd({ engineId, t: 'input', payload: { viewId, kind: 'mouse', type: 'down', button: ev.button === 2 ? 'right' : 'left', x: p.x, y: p.y } }).catch(() => {});
  });
  canvas.addEventListener('mouseup', (ev) => {
    const p = pos(ev);
    bridge.host.cmd({ engineId, t: 'input', payload: { viewId, kind: 'mouse', type: 'up', button: ev.button === 2 ? 'right' : 'left', x: p.x, y: p.y } }).catch(() => {});
  });
  canvas.addEventListener('mousemove', (ev) => {
    const p = pos(ev);
    bridge.host.cmd({ engineId, t: 'input', payload: { viewId, kind: 'mouse', type: 'move', x: p.x, y: p.y } }).catch(() => {});
  });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const p = pos(ev);
    bridge.host.cmd({ engineId, t: 'input', payload: { viewId, kind: 'wheel', deltaX: ev.deltaX, deltaY: ev.deltaY, x: p.x, y: p.y } }).catch(() => {});
  }, { passive: false });
  canvas.addEventListener('keydown', (ev) => {
    const key = ev.key;
    if (key && key.length === 1) {
      bridge.host.cmd({ engineId, t: 'input', payload: { viewId, kind: 'text', text: key } }).catch(() => {});
    } else {
      bridge.host.cmd({ engineId, t: 'input', payload: { viewId, kind: 'key', type: 'down', key } }).catch(() => {});
    }
    if (key === 'Tab' || key === ' ') ev.preventDefault();
  });
}

/** bridge 模式挂载：用 canvas 承接宿主帧，而不是 <webview> */
function mountBridgeTab(tab, e) {
  const host = $('#viewport');
  const wrap = document.createElement('div');
  wrap.className = 'bridge-view';
  wrap.dataset.tabId = String(tab.id);
  wrap.__bridge = true;
  wrap.hidden = true;

  const canvas = document.createElement('canvas');
  canvas.className = 'bridge-canvas';
  wrap.appendChild(canvas);

  // 让外壳其余代码把 wrap 当成 webview 来操作：隐藏 / 移除 / 读 getWebContentsId 都不崩
  wrap.loadURL = (url) => {
    tab.loading = true; renderTabstrip();
    bridge.host.cmd({ engineId: e.id, t: 'navigate', payload: { viewId: tab.id, url } }).catch(() => {});
  };
  wrap.getWebContentsId = () => null; // 桥接视图没有真实 webContents（嗅探/广告拦截按内核 session 不覆盖宿主）
  wrap.setAttribute = () => {};       // useragent / partition 等属性对桥接无意义
  wrap.dispatchEvent = wrap.dispatchEvent.bind(wrap);

  bridgeViews.set(tab.id, { wrap, canvas, engineId: e.id });
  wireBridgeInput(canvas, e.id, tab.id);

  // 尺寸变化时（含切到可见）通知宿主；隐藏态尺寸为 0 不发送
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      const w = Math.round(r.width), h = Math.round(r.height);
      if (w > 0 && h > 0) bridge.host.cmd({ engineId: e.id, t: 'resize', payload: { viewId: tab.id, w, h } }).catch(() => {});
    });
    ro.observe(canvas);
  }

  host.appendChild(wrap);
  tab.webview = wrap;
  tab.wcId = null;

  // 创建视图（默认尺寸；激活后再 resize 成真实尺寸），并首屏导航
  bridge.host.cmd({ engineId: e.id, t: 'create', payload: { viewId: tab.id, w: 1024, h: 768 } }).catch(() => {});
  if (tab.url) wrap.loadURL(tab.url);

  renderTabstrip();
  renderTabGrid();
}

/** 切到某个 bridge 标签页时，让宿主把对应视图提到前台（不重新导航）并校准尺寸 */
function activateBridgeView(tab) {
  const v = bridgeViews.get(tab.id);
  if (!v) return;
  const r = v.canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  bridge.host.cmd({ engineId: tab.engineId, t: 'activate', payload: { viewId: tab.id } }).catch(() => {});
  bridge.host.cmd({ engineId: tab.engineId, t: 'resize', payload: { viewId: tab.id, w, h } }).catch(() => {});
}

/**
 * 网页 preload 送来的消息（`ipcRenderer.sendToHost`）。
 *
 * 这些是网页自己发起的动作，外壳只是接手：网页里调 window.print() 在 Electron
 * 下是空操作、Ctrl+滚轮要缩放整页、登录表单提交后要问一句存不存密码 ——
 * 三件事都只能由外壳做（见 src/preload/webview-preload.js）。
 */
function handleWebviewIpc(tab, ev) {
  if (!tab || !ev) return;
  if (ev.channel === 'nova-print') { openPrintDialog(tab); return; }
  if (ev.channel === 'nova-login') { onLoginSubmitted(tab, ev.args && ev.args[0]); return; }
  if (ev.channel === 'nova-cred-ask') { autofillLogin(tab, ev.args && ev.args[0]); return; }
  if (ev.channel !== 'nova-zoom') return;
  const dir = ev.args && ev.args[0];
  if (dir === 'reset') setTabZoom(tab, 1);
  else stepZoom(tab, dir === 'in' ? 1 : -1);
}

/**
 * 网页里出现了登录表单 → 本站有存的密码就填回去。
 *
 * <p>「保存密码」在用户眼里的本义是下次别让我再输一遍。只弹提示不做带入，
 * 保存这件事就只完成了一半。
 *
 * <p>三条边界：
 *  1. origin 必须是**这个标签页当前地址**的 origin。页面里读到的 origin 只当
 *     线索，宿主拿真实地址核一遍 —— 否则跨站 iframe 一句 ask 就能拿去别人的记录。
 *  2. 只填一条。同一站点存了多个账号时不猜：把口令乱填进别人的账号上，比不填更糟。
 *     选最近保存的那条（settings 里也能手动「填充到当前页」逐个填）。
 *  3. 解密失败（换过 Windows 账户）就安静放过，不打扰用户。
 */
async function autofillLogin(tab, payload) {
  if (!tab || !payload) return;
  const cfg = (state.settings && state.settings.passwords) || {};
  if (cfg.autofill === false) return;
  const origin = originOf(tab.url);
  const asked = String(payload.origin || '');
  if (!origin || !asked || origin.toLowerCase() !== asked.toLowerCase()) return;

  const wv = tab.webview;
  if (!wv || typeof wv.send !== 'function') return;   // UI 预览模式没有真 webview

  try {
    if (!state.credentials) {
      const list = await bridge.credentials.list();
      state.credentials = Array.isArray(list) ? list : [];
    }
    const mine = state.credentials.filter((c) => String(c.origin).toLowerCase() === origin.toLowerCase());
    if (!mine.length) return;
    // 最近保存的那条在前（cred:list 按保存顺序倒序，这里再排一次以防万一）
    mine.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const r = await bridge.credentials.reveal(mine[0].id);
    if (!r || !r.ok) return;
    wv.send('nova-cred-fill', { username: mine[0].username || '', password: r.password });
  } catch { /* 填不进去不影响浏览 */ }
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

  // bridge 模式（真·原生宿主）：用 canvas 承接宿主帧，不走 <webview>
  if (e.mode === 'bridge') {
    mountBridgeTab(tab, e);
    return;
  }

  const wv = document.createElement('webview');
  wv.setAttribute('src', tab.url);
  wv.setAttribute('partition', e.partition);
  wv.setAttribute('useragent', e.userAgent);
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no, sandbox=yes');
  wv.setAttribute('preload', WEBVIEW_PRELOAD_URL);
  wv.dataset.tabId = String(tab.id);
  wv.hidden = true;
  // 点进网页时焦点落到 webview：Share 面板要跟着收起（网页内的点击不会冒泡到外壳文档）
  wv.addEventListener('focus', () => { closeOmniShare(); closeSniffPopover(); });
  // 页面里的缩放 / 打印 / 登录操作（preload 转来的）：Ctrl+滚轮、Ctrl+±0、
  // Ctrl+P、window.print()、提交登录表单。抽成具名函数是为了让测试能直接调
  // —— jsdom 里没有真 webview，只能验这段逻辑，验不了 DOM 事件那一步。
  wv.addEventListener('ipc-message', (ev) => handleWebviewIpc(tab, ev));
  wv.addEventListener('found-in-page', (ev) => {
    if (!activeTab() || activeTab().id !== tab.id) return;
    const r = (ev && ev.result) || {};
    const el = $('#find-count');
    if (el) el.textContent = `${r.activeMatchOrdinal || 0}/${r.matches || 0}`;
  });

  wv.addEventListener('did-start-loading', () => {
    // 新一轮加载开始 → 清掉上次的失败状态（重试/换网址时错误页要收起来）
    tab.loadError = null;
    if (activeTab() && activeTab().id === tab.id) renderPageError();
    tab.loading = true; renderTabstrip(); syncNavButtons();
  });
  wv.addEventListener('did-stop-loading', () => {
    tab.loading = false; renderTabstrip(); syncNavButtons();
    // 页面自己可能从头到尾都没发 page-favicon-updated（图标只在 <link> 里声明、
    // 或者放在 /favicon.ico 而这一步被 CSP 拦了）。这时问主进程缓存要一份，
    // 顺带踢一次盲探 —— 抓到之后 onFetched 会推 favicon:updated 再回来补。
    resolveTabFavicon(tab);
  });
  wv.addEventListener('did-navigate', (ev) => {
    tab.url = ev.url;
    // 换了站点：套用该域名记住的缩放（不落盘，只是应用）
    if (tab.webview === wv) setTabZoom(tab, zoomForHost(ev.url), { persist: false, silent: true });
    syncOmnibox();
    renderTabGrid();
    // 网页里点链接跳转走的是这条事件，不经过外壳的 navigate()。
    // 「仅新标签页」档位下，从新标签页上一跳走就得把这行收起来。
    syncBookmarkBar();
    persistSession();

    // 站内点进了「规则指向另一个内核」的站点：等这次事件走完再换，避免拆掉正在派发的对象
    const want = siteEngineFor(ev.url);
    if (want && want !== tab.engineId && engineExists(want)) {
      setTimeout(() => {
        if (tab.webview !== wv) return; // 期间已经重建过就别重复切
        switchEngine(tab.id, want);
      }, 0);
    }
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
    // 先用页面声明的地址顶上：能立刻显示，等主进程抓完缓存再换成 data: URI
    // （外壳 CSP 只放行 https 的图片，http 图标那一步会被挡掉 —— 那正是
    // 「有的网站有图标、有的只有一个方框」的一半原因）。
    tab.favicon = (ev.favicons && ev.favicons[0]) || null;
    renderTabstrip();
    resolveTabFavicon(tab);
  });
  wv.addEventListener('new-window', (ev) => {
    createTab(ev.url, tab.engineId, { activate: !ev.disposition || ev.disposition === 'foreground-tab' });
  });
  // 右键 → 交给主进程弹系统原生菜单（DOM 菜单会被 webview 盖住，原生不会）
  wv.addEventListener('context-menu', (ev) => {
    let wcId = 0;
    try { wcId = wv.getWebContentsId(); } catch { /* 还没就绪 */ }
    try { bridge.webview.contextMenu({ params: ev.params, wcId }); } catch { /* 桥没起来 */ }
  });
  // 渲染进程崩了：DOM 事件能立刻收到（但不带原因），主进程还会补一条带 reason 的。
  // 不处理的话界面只会留一块灰色（guest 未绘制的占位面），用户完全不知道发生了什么。
  wv.addEventListener('crashed', () => {
    // 自动重建后，旧 <webview> 的事件还可能冒出来，别把新一轮又算成第二次崩溃
    if (tab.webview !== wv) return;
    handleTabCrash(tab, '');
  });
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
    // 把页面主世界的 window.print 接到外壳。preload 在隔离世界改不到页面的 print，
    // 只能由主进程注入（见 src/main/print-hook.js）—— 不做这一步，页面自己的
    // 「打印」按钮会直接弹系统打印对话框，绕过纸张/边距设置。
    installPrintHook(tab);
    // 自动拼页要等页面 DOM 就位才能找正文容器和下一页，所以挂在这一步
    injectAutoPage(tab);
    // 选中文字后弹「搜索/复制」迷你条（注入到页面里，避免被 webview 盖住）
    injectSelectionBar(tab);
  });

  host.appendChild(wv);
  tab.webview = wv;
  // 尽早拿一次：媒体请求可能比 dom-ready 还早，晚拿会漏掉开头几条
  try { tab.wcId = wv.getWebContentsId(); } catch { /* 同上 */ }
  renderTabstrip();
  renderTabGrid();
}

function destroyTab(tab) {
  // 桥接视图：先通知宿主销毁对应视图，再从登记里移除
  if (bridgeViews.has(tab.id)) {
    bridge.host.cmd({ engineId: tab.engineId, t: 'destroy', payload: { viewId: tab.id } }).catch(() => {});
    bridgeViews.delete(tab.id);
  }
  if (tab.webview && tab.webview.parentNode) tab.webview.parentNode.removeChild(tab.webview);
  tab.webview = null;
  // 标签页没了，它嗅到的资源也一并释放（主进程侧销毁 webContents 时同样会清）
  if (tab.wcId != null) state.sniffByWc.delete(tab.wcId);
}

/**
 * 重建一个标签页的渲染载体。
 *
 * <p>渲染进程已经退出时 `webview.reload()` 是对着尸体喊话 —— 必须把 <webview>
 * 整个换掉。URL 与内核保持不变。
 */
function remountTab(tab) {
  if (!tab) return;
  const url = tab.url;
  const engineId = tab.engineId;
  destroyTab(tab);
  tab.wcId = null;
  tab.crashed = false;
  tab.loadError = null;
  tab.url = url;
  tab.engineId = engineId;
  mountTab(tab);
  if (state.activeId === tab.id) activateTab(tab.id);
}

/**
 * 渲染进程崩溃的统一处理。
 *
 * <p>崩溃后界面会变成一块 #808080（guest 未绘制时的占位面，实测就是这个值）。
 * 第一次先在原地静默重建，用户基本无感；只有短时间内反复崩（60 秒内第二次）
 * 才停下来报错，避免把崩溃循环变成无限重载。
 */
function handleTabCrash(tab, reason) {
  if (!tab) return;
  tab.crashed = true;
  const now = Date.now();
  if (!tab.crashAt || now - tab.crashAt > 60000) tab.crashCount = 0;
  tab.crashAt = now;
  tab.crashCount = (tab.crashCount || 0) + 1;

  if (tab.crashCount === 1) {
    remountTab(tab);
    toast('页面渲染进程异常，已自动恢复');
    return;
  }
  tab.loadError = { code: 'crash', desc: reason || '', url: tab.url };
  if (activeTab() && activeTab().id === tab.id) renderPageError();
  renderTabstrip();
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
  // 先对**旧**标签页停掉查找高亮，再切 activeId（否则 stopFindInPage 会打到新页上）
  closeFindBar();
  state.activeId = id;
  closeOmniShare(); // 切标签页时分享面板不该还挂在那儿
  closeSniffPopover(); // 嗅探清单按标签页归属，切页了旧清单没有意义
  for (const t of state.tabs) {
    if (t.webview) t.webview.hidden = t.id !== id;
  }
  // 切到 bridge 标签页：让宿主把对应视图提到前台并校准尺寸（不重新导航）
  const at = activeTab();
  if (at && at.webview && at.webview.__bridge) activateBridgeView(at);
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
    '-2': '加载失败',
    crash: '页面渲染进程崩溃，已中断渲染；点「重试」重新加载'
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

/**
 * 站点规则：精确主机 → 逐级父域。
 *
 * <p>规则里写 example.com，www.example.com 也要命中 —— 用户不会为了
 * 「带不带 www」写两条。逐级去掉最左边的标签，直到没有点为止。
 */
function siteEngineFor(url) {
  const rules = (state.settings && state.settings.siteEngines) || [];
  if (!rules.length) return null;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (!host) return null;
  let h = host;
  while (h) {
    const hit = rules.find((x) => String(x.host || '').toLowerCase() === h);
    if (hit) return hit.engine;
    const i = h.indexOf('.');
    if (i < 0) break;
    h = h.slice(i + 1);
  }
  return null;
}

/** 把用户输入揉成裸主机名：去掉协议、路径、空白与大小写差异。 */
function normalizeSiteHost(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : '';
}

/* --- 页面缩放（按站点记忆）--- */
/** 缩放的键：主机名去掉 www.（用户不会为带不带 www 记两套比例）。 */
function zoomKey(url) {
  const host = hostOf(url);
  return host ? host.replace(/^www\./, '') : '';
}

function zoomForHost(url) {
  const key = zoomKey(url);
  if (!key) return 1;
  const v = (state.settings.zoomByHost || {})[key];
  return (typeof v === 'number' && v >= 0.25 && v <= 5) ? v : 1;
}

function setTabZoom(tab, factor, opts) {
  if (!tab || !tab.webview || tab.webview.__bridge) return false;
  const o = opts || {};
  const f = Math.min(5, Math.max(0.25, Math.round(factor * 100) / 100));
  try { tab.webview.setZoomFactor(f); } catch { return false; }
  tab.zoom = f;
  const host = zoomKey(tab.url);
  if (o.persist !== false && host) {
    const map = Object.assign({}, state.settings.zoomByHost || {});
    // 100% 写 null：deepMerge 不会删键，读的时候把 null 当 1
    map[host] = Math.abs(f - 1) < 0.005 ? null : f;
    state.settings.zoomByHost = map;
    bridge.settings.patch({ zoomByHost: map });
  }
  if (!o.silent) toast(`缩放 ${Math.round(f * 100)}%`);
  return true;
}

/** 按 10% 一档放大/缩小；dir > 0 放大。 */
function stepZoom(tab, dir) {
  if (!tab) return;
  const cur = typeof tab.zoom === 'number' ? tab.zoom : zoomForHost(tab.url);
  setTabZoom(tab, cur * (dir > 0 ? 1.1 : 1 / 1.1));
}

function engineExists(id) {
  return (state.engines || []).some((e) => e.id === id);
}

function engineLabel(id) {
  const e = (state.engines || []).find((x) => x.id === id);
  return e ? e.label : id;
}

function navigate(id, url) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab || !url) return;
  tab.url = url;

  // 站点规则优先：目标站点配了另一个内核，就直接换过去。
  // switchEngine 会拿 tab.url 重新加载，所以这里不要再自己 load 一次。
  const want = siteEngineFor(url);
  if (want && want !== tab.engineId && engineExists(want)) {
    switchEngine(tab.id, want);
    syncOmnibox();
    syncBookmarkBar();
    persistSession();
    return;
  }

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

/** 静音/取消静音当前标签页。图标由 t.audible / t.muted 共同决定。 */
function toggleTabMute(id) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t || !t.webview || t.webview.__bridge) return;
  const next = !t.muted;
  try { t.webview.setAudioMuted(next); } catch { return; }
  t.muted = next;
  renderTabstrip();
  toast(next ? '已静音此标签页' : '已取消静音');
}

/**
 * 从主进程的图标缓存里给这个标签页要一份图标。
 *
 * 为什么要绕这一圈：外壳页面的 CSP 是 `img-src 'self' data: https:`，
 * 站点声明成 `http://…` 的图标（还有一部分 https 之外的协议、链接失效的地址）
 * 一律被拦，表现就是「一个空方框」。缓存里存的是主进程抓下来的字节、以
 * data: URI 返回，不受这条限制，页面关了也还在。
 *
 * 只覆盖「还没有图标」或「远程地址」两种情况 —— 已经是 data: URI 的说明
 * 上一次已经换过了，别每导航一次就再换一次（同一个地址也换不出新东西）。
 */
async function resolveTabFavicon(tab) {
  if (!tab || state.isPreview) return;
  const host = hostOf(tab.url);
  if (!host) return;
  const cur = tab.favicon || '';
  if (cur.indexOf('data:') === 0) return;
  let map = null;
  try { map = await bridge.favicons.json([host]); } catch { map = null; }
  const uri = map && map[host];
  if (!uri) return;
  if (tab.favicon !== uri) { tab.favicon = uri; renderTabstrip(); }
}

function renderTabstrip() {
  const box = $('#tabs');
  box.innerHTML = state.tabs.map((t) => {
    const e = engine(t.engineId);
    const letter = (hostOf(t.url) || 'N').slice(0, 1).toUpperCase();
    // 图标画不出来时不要留个空框：CSP 会把内联 onerror 也一并挡掉
    // （script-src 'self'），原来那句 this.remove() 从来就没执行过。
    // 改成渲染后给 img 挂事件监听兜底，见下面的 forEach。
    const fav = t.favicon ? `<img src="${esc(t.favicon)}" alt="" />` : letter;
    return `
      <div class="tab ${t.id === state.activeId ? 'is-active' : ''}" data-tab="${t.id}"
           style="--tab-accent:${e.accent}" title="${esc(t.title)}&#10;${esc(t.url)}">
        ${t.loading ? '<span class="tab-spinner"></span>' : `<span class="tab-favicon" data-fb="${esc(letter)}">${fav}</span>`}
        <span class="tab-title">${esc(t.title)}</span>
        ${(t.audible || t.muted) ? `<button class="tab-audio ${t.muted ? 'is-muted' : ''}" data-mute="${t.id}" title="${t.muted ? '取消静音' : '静音此标签页'}">` +
          `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 8h3l4-3v10l-4-3H4z"/>` +
          (t.muted ? '<path d="M13.5 8l4 4M17.5 8l-4 4"/>' : '<path d="M14 7.5a4 4 0 0 1 0 5"/>') +
          `</svg></button>` : ''}
        <span class="tab-engine">${esc(e.short)}</span>
        <button class="tab-close" data-close="${t.id}" title="关闭标签页">
          <svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" /></svg>
        </button>
      </div>`;
  }).join('');

  // 图标加载失败（http 被 CSP 拦、链接失效、站点下线）→ 换回落地的首字母。
  // 内联 onerror 被 CSP 挡掉，只能这样挂。
  box.querySelectorAll('.tab-favicon img').forEach((img) => {
    img.addEventListener('error', () => {
      const s = img.parentNode;
      if (!s) return;
      s.textContent = s.dataset.fb || '';
    });
  });

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
  box.querySelectorAll('[data-mute]').forEach((b) => {
    b.addEventListener('click', (ev) => { ev.stopPropagation(); toggleTabMute(Number(b.dataset.mute)); });
  });

  $('#mb-tab-count').textContent = String(state.tabs.length);
  $('#tg-count').textContent = String(state.tabs.length);
}

function renderTabGrid() {
  const list = $('#tg-list');
  const q = (state.tabQuery || '').trim().toLowerCase();
  const tabs = q
    ? state.tabs.filter((t) => (t.title + ' ' + t.url).toLowerCase().includes(q))
    : state.tabs;
  if (!tabs.length) {
    list.innerHTML = `<div class="tg-empty">没有匹配「${esc(q)}」的标签页</div>`;
    return;
  }
  list.innerHTML = tabs.map((t) => {
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
  // 新标签页那种内置 file:// 页没有可分享的网址：静默不弹（地址栏点击同时是「去打字」，
  // 不该每次点都弹个提示打断）
  if (!url || isNewTabUrl(url)) return;
  const title = t ? (t.title || '') : '';
  const tEl = $('#os-title'), uEl = $('#os-url');
  if (tEl) tEl.textContent = title || prettyUrl(url);
  if (uEl) uEl.textContent = prettyUrl(url);
  pop.dataset.url = url;
  pop.dataset.title = title;
  pop.hidden = false;
  loadShareQr(url);
}

/**
 * 面板里的二维码：本地生成。生成失败（或没有这项能力）就把整块收起，
 * 不留一个空白方框。异步回来时面板可能已经关了或换了网址，用 url 兜一下。
 */
async function loadShareQr(url) {
  const pop = $('#omni-share'), wrap = $('#os-qrwrap'), img = $('#os-qr');
  if (!pop || !wrap || !img) return;
  wrap.hidden = true;
  img.removeAttribute('src');
  try {
    const r = await bridge.system.qrcode(url);
    if (pop.hidden || pop.dataset.url !== url) return;
    if (r && r.ok && r.dataUrl) {
      img.src = r.dataUrl;
      wrap.hidden = false;
    }
  } catch { /* 没有这项能力就安静地不显示 */ }
}

function closeOmniShare() {
  const pop = $('#omni-share');
  if (pop) pop.hidden = true;
}

/* --- 页内查找 ---
 * 只对 Chromium 的 <webview> 有效：IE/Trident 走的是原生宿主，没有 findInPage。
 */
function openFindBar() {
  const t = activeTab();
  if (!t || !t.webview || t.webview.__bridge || typeof t.webview.findInPage !== 'function') {
    toast('当前内核不支持页面内查找');
    return;
  }
  const bar = $('#findbar');
  if (!bar) return;
  bar.hidden = false;
  const input = $('#find-input');
  if (input) {
    input.focus();
    input.select();
    if (input.value) runFind(true);
  }
}

function closeFindBar() {
  const bar = $('#findbar');
  if (!bar || bar.hidden) return;
  bar.hidden = true;
  state.findQuery = '';
  const count = $('#find-count');
  if (count) count.textContent = '0/0';
  const t = activeTab();
  if (t && t.webview && typeof t.webview.stopFindInPage === 'function') {
    try { t.webview.stopFindInPage('clearSelection'); } catch { /* 页面可能已经换了 */ }
  }
}

function runFind(forward) {
  const t = activeTab();
  const input = $('#find-input');
  if (!t || !t.webview || !input || typeof t.webview.findInPage !== 'function') return;
  const q = input.value;
  if (!q) {
    if (typeof t.webview.stopFindInPage === 'function') t.webview.stopFindInPage('clearSelection');
    const c = $('#find-count');
    if (c) c.textContent = '0/0';
    state.findQuery = '';
    return;
  }
  // 换了关键词要重新开始，否则 findNext 会接着上一次的结果往后跳
  const fresh = q !== state.findQuery;
  state.findQuery = q;
  try {
    t.webview.findInPage(q, { forward: forward !== false, findNext: !fresh });
  } catch { /* 页面正在加载时可能失败，下一次输入会再试 */ }
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

async function handleShareAction(act) {
  const pop = $('#omni-share');
  const url = pop && pop.dataset.url;
  const title = (pop && pop.dataset.title) || '';
  if (!url) return;

  if (act === 'copy') {
    // 一次复制「标题 + 简介 + 链接」，不再拆成两个按钮
    await bridge.system.copy(await shareSummaryText());
    toast('已复制链接和简介');
    closeOmniShare();
  } else if (act === 'wechat' || act === 'moments') {
    // 桌面没有分享 API：高亮面板里的二维码，让用户扫码桥接
    const wrap = $('#os-qrwrap');
    if (wrap && !wrap.hidden) {
      wrap.classList.remove('is-pulse');
      void wrap.offsetWidth; // 强制重排，连点也能再播一次动画
      wrap.classList.add('is-pulse');
    }
    toast(act === 'wechat' ? '用上方二维码在微信里打开 / 转发' : '用上方二维码发到朋友圈');
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

/* --- 地址栏自动匹配（收藏 + 历史）--- */
// 收藏在 state.bookmarks 里；历史从主进程拉一批缓存（地址栏聚焦时刷新）。
async function ensureHistoryCache(refresh) {
  if (state.historyCache && !refresh) return state.historyCache;
  try {
    const list = await bridge.history.list(400);
    state.historyCache = Array.isArray(list) ? list : [];
  } catch { state.historyCache = state.historyCache || []; }
  return state.historyCache;
}

function hideOmniSuggest() {
  const el = $('#omni-suggest');
  if (el) { el.hidden = true; el.innerHTML = ''; }
  state.omniSugg = [];
  state.omniSel = -1;
}

function paintOmniSel() {
  const el = $('#omni-suggest');
  if (!el) return;
  [...el.querySelectorAll('.osug-row')].forEach((r, i) => r.classList.toggle('is-sel', i === state.omniSel));
}

function pickOmniSuggest(idx) {
  const it = (state.omniSugg || [])[idx];
  const input = $('#omni-input');
  if (!it || !input) return;
  input.value = it.url;
  hideOmniSuggest();
  const t = activeTab();
  if (t) navigate(t.id, it.url);
  input.blur();
}

/**
 * 一条记录在匹配列表里的「网站名称」。
 *
 * 历史条目里 title 可能是空的（记录发生在标题解析出来之前），也可能是地址本身
 * （旧版本就是这么存的）。两种都回落成主机名 —— 一行里同时出现「bilibili.com」
 * 和「bilibili.com/xxx」看着重复，但至少能一眼认出是哪个站；直接空着才是真的
 * 「缺少网址名称」。
 */
function siteNameOf(title, url) {
  const t = String(title || '').trim();
  if (t && t !== url) return t;
  return hostOf(url) || String(url || '');
}

/** 按输入串从收藏 + 历史里挑匹配项（收藏优先、按 URL 去重，最多 8 条）。 */
function omniSugMatches(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const seen = new Set();
  const out = [];
  const hit = (url, title) => {
    const u = String(url || '').toLowerCase();
    const u2 = u.replace(/^https?:\/\//, '').replace(/^www\./, '');
    const t = String(title || '').toLowerCase();
    return u.includes(q) || u2.includes(q) || t.includes(q);
  };
  const push = (item, type) => {
    const url = item && item.url;
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, title: siteNameOf(item && item.title, url), type });
  };
  for (const b of (state.bookmarks || [])) if (hit(b.url, b.title)) push(b, 'bm');
  for (const h of (state.historyCache || [])) if (hit(h.url, h.title)) push(h, 'hist');
  return out.slice(0, 8);
}

function renderOmniSuggest() {
  const el = $('#omni-suggest');
  const input = $('#omni-input');
  if (!el || !input) return;
  // 历史还没缓存好：先拉，回来再补渲染一次
  if (!state.historyCache) { ensureHistoryCache().then(() => { if (document.activeElement === input) renderOmniSuggest(); }); }
  const list = omniSugMatches(input.value);
  state.omniSugg = list;
  state.omniSel = -1;
  if (!list.length) { hideOmniSuggest(); return; }
  el.innerHTML = list.map((it, i) => `
    <button class="osug-row" data-idx="${i}" data-url="${esc(it.url)}">
      <span class="osug-ico ${it.type === 'bm' ? 'is-bm' : 'is-hist'}">${it.type === 'bm' ? '★' : '↺'}</span>
      <span class="osug-main">
        <span class="osug-title">${esc(it.title)}</span>
        <span class="osug-url">${esc(prettyUrl(it.url))}</span>
      </span>
      <span class="osug-tag">${it.type === 'bm' ? '收藏' : '历史'}</span>
    </button>`).join('');
  el.hidden = false;
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
/** 一条书签的展示信息：图标三层降级（站点缓存 → 自带 favicon → 首字母）。 */
function bmEntry(b) {
  const host = hostOf(b.url);
  const label = b.title || host || b.url;
  const src = hostIcon(b.url) || b.favicon || '';
  const icon = src
    ? `<img src="${esc(src)}" alt="" onerror="this.remove()" />`
    : esc((host || 'N').slice(0, 1).toUpperCase());
  return { host, label, icon, hostLine: (host || '').replace(/^www\./, '') };
}

function renderBmMenu() {
  const menu = $('#bm-menu');
  if (!menu) return;
  menu.innerHTML = (state.bookmarks || []).map((b) => {
    const p = bmEntry(b);
    return `<button class="bm-menu-item" role="menuitem" data-bm="${esc(b.url)}"` +
      ` title="${esc(p.label)}&#10;${esc(b.url)}">` +
      `<span class="bm-fav">${p.icon}</span>` +
      `<span class="bm-menu-text">` +
      `<span class="bm-menu-title">${esc(p.label)}</span>` +
      (p.hostLine ? `<span class="bm-menu-host">${esc(p.hostLine)}</span>` : '') +
      `</span></button>`;
  }).join('');
}

function closeBmMenu() {
  const menu = $('#bm-menu');
  const btn = $('#bm-more');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleBmMenu() {
  const menu = $('#bm-menu');
  const btn = $('#bm-more');
  if (!menu || !btn) return;
  if (!menu.hidden) { closeBmMenu(); return; }
  renderBmMenu();
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
}

/**
 * 决定「更多」露不露。
 *
 * <p>先把按钮显示出来再量：按钮本身要占宽度。若按“隐藏时”的宽度判断，
 * 会出现「本来刚好 → 显示按钮 → 反而溢出」的抖动。
 */
function updateBmOverflow() {
  const track = $('#bm-track');
  const btn = $('#bm-more');
  if (!track || !btn) return;
  const wasHidden = btn.hidden;
  btn.hidden = false;
  const overflow = track.scrollWidth - track.clientWidth > 2;
  btn.hidden = !overflow;
  if (!overflow && !wasHidden) closeBmMenu();
}

function renderBookmarkBar(force = false) {
  const bar = $('#bookmark-bar');
  const track = $('#bm-track');
  if (!bar || !track) return;

  const mode = bmBarMode();
  const tab = activeTab();
  const onNtp = !!tab && isNewTabUrl(tab.url);
  // 「不显示」档收起时不只设 hidden：关掉的条目还留在 DOM 里能被读到，
  // 而「这条栏现在不在了」最好在 DOM 上也成立，不是只靠一层 CSS 挡。
  const show = mode === 'always' || (mode === 'ntp' && onNtp);

  if (!show) {
    if (!bar.hidden) bar.hidden = true;
    if (track.firstChild) track.innerHTML = '';
    closeBmMenu();
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
    track.innerHTML = '<span class="bm-empty">收藏夹栏还是空的 —— 地址栏右侧的星形按钮可以把当前页钉到这里</span>';
    const emptyBtn = $('#bm-more');
    if (emptyBtn) emptyBtn.hidden = true;
    closeBmMenu();
    return;
  }

  // 条目之间插一条细分隔线：纯靠间距太挤，加边框又会把每格框死。
  track.innerHTML = list.map((b, i) => {
    const p = bmEntry(b);
    const item = `<button class="bm-item" data-bm="${esc(b.url)}"` +
      ` title="${esc(p.label)}&#10;${esc(b.url)}&#10;右键移出收藏夹栏">` +
      `<span class="bm-fav">${p.icon}</span>` +
      `<span class="bm-text">` +
      `<span class="bm-title">${esc(p.label)}</span>` +
      (p.hostLine ? `<span class="bm-host">${esc(p.hostLine)}</span>` : '') +
      `</span></button>`;
    return (i ? '<span class="bm-sep" aria-hidden="true"></span>' : '') + item;
  }).join('');

  closeBmMenu();
  updateBmOverflow();
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

/* --- 工具菜单（顶栏「关于」左面的下拉） ---
 * 把新增的功能收在一个下拉里速达，免得它们散在设置各处要点三层才找得到。
 * 每一项直接调既有的入口（openCmdPalette / openPanel / openOmniShare / openAiPanel），
 * 不重写一遍逻辑。顺序把最新加入的（命令面板 / 站点权限）排最前。 */
const TOOLS_ITEMS = [
  { id: 'cmd', label: '命令面板', sub: 'Ctrl+K · 命令 / 网址 / 搜索',
    icon: '<circle cx="9" cy="9" r="6"/><path d="M14 14l3.5 3.5" stroke-linecap="round"/>',
    run: () => openCmdPalette() },
  { id: 'perm', label: '站点权限', sub: '按域名管位置 / 通知 / 摄像头…',
    icon: '<path d="M10 2.5l6 2v5.2c0 3.6-2.5 6.6-6 7.8-3.5-1.2-6-4.2-6-7.8V4.5z"/><path d="M7.6 10l1.8 1.8 3.2-3.2"/>',
    run: () => openPanel('permissions') },
  { id: 'share', label: '网址分享', sub: '复制 / 二维码 / 分享当前页',
    icon: '<circle cx="6" cy="10" r="2"/><circle cx="14" cy="5.5" r="2"/><circle cx="14" cy="14.5" r="2"/><path d="M7.8 9l4.4-2.4M7.8 11l4.4 2.4"/>',
    run: () => openOmniShare() },
  { id: 'pass', label: '密码管理', sub: '本机加密保存的登录凭证',
    icon: '<circle cx="7" cy="13" r="3"/><path d="M9.1 11.1L16 4.2M13.9 4.2h2.4v2.4"/>',
    run: () => openPanel('passwords') },
  { id: 'ext', label: '插件商店', sub: '扩展管理 / 从浏览器导入',
    icon: '<path d="M8 3.5a2 2 0 1 1 4 0h3v3a2 2 0 1 0 0 4v3h-3a2 2 0 1 0-4 0H5v-3a2 2 0 1 0 0-4V3.5z"/>',
    run: () => openPanel('extensions') },
  { id: 'ai', label: 'AI 助手', sub: 'API 对话 · 免网页环境异常',
    icon: '<path d="M10 3l1.3 3.2L14.5 7.5 11.3 8.8 10 12 8.7 8.8 5.5 7.5 8.7 6.2z"/><path d="M15 12l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
    run: () => openAiPanel() },
  { id: 'sniff', label: '媒体嗅探', sub: '页面音视频资源',
    icon: '<rect x="2.5" y="5" width="9" height="8" rx="1.4"/><path d="M5.5 8.5l2.4 1.5-2.4 1.5z"/><path d="M14 8a3.2 3.2 0 0 1 0 5"/><path d="M16.6 5.8a6.4 6.4 0 0 1 0 9.4"/>',
    run: () => openPanel('sniffer') }
];

function renderToolsMenu() {
  const list = $('#tools-menu-list');
  if (!list) return;
  list.innerHTML = TOOLS_ITEMS.map((it, i) => `
    <button class="em-item" role="menuitem" data-tool="${i}">
      <span class="em-ico"><svg viewBox="0 0 20 20" aria-hidden="true">${it.icon}</svg></span>
      <span class="em-main">
        <span class="em-name">${esc(it.label)}</span>
        <span class="em-sub">${esc(it.sub)}</span>
      </span>
    </button>`).join('');
}

function closeToolsMenu() {
  const m = $('#tools-menu'), b = $('#qk-tools');
  if (!m || m.hidden) return;
  m.hidden = true;
  if (b) b.setAttribute('aria-expanded', 'false');
}

function toggleToolsMenu() {
  const m = $('#tools-menu'), b = $('#qk-tools');
  if (!m) return;
  const open = m.hidden;
  m.hidden = !open;
  if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/** 工具菜单的开合与点击执行。只在启动时绑定一次（document 级委托，菜单会重绘）。 */
function wireToolsMenu() {
  const btn = $('#qk-tools'), menu = $('#tools-menu');
  if (!btn || !menu) return;
  renderToolsMenu();
  btn.addEventListener('click', (ev) => { ev.stopPropagation(); toggleToolsMenu(); });
  menu.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-tool]');
    if (!b) return;
    const it = TOOLS_ITEMS[+b.dataset.tool];
    closeToolsMenu();
    if (it && it.run) it.run();
  });
  // 点外面收起。菜单里点的是 [data-tool]，那条在冒泡路上已自行关闭并 stop。
  document.addEventListener('click', (ev) => {
    if (menu.hidden) return;
    if (ev.target.closest('#tools-menu') || ev.target.closest('#qk-tools')) return;
    closeToolsMenu();
  });
  // Esc 收起交给全局 Escape 链（window 上那条），这里不重复绑 ——
  // 事件从 window 派发时不会走到 document 的监听器，绑 document 等于没绑。
}

/** 命令面板：输入框实时过滤 + 键盘导航 + 背景关闭。只在启动时绑定一次。 */
function wireCmdPalette() {
  const inp = $('#cmd-input');
  const box = $('#cmd-palette');
  if (!inp || !box) return;
  inp.addEventListener('input', () => { cmdSel = 0; renderCmdList(inp.value); });
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (cmdItemsFlat.length) { cmdSel = Math.min(cmdItemsFlat.length - 1, cmdSel + 1); paintCmdSel(); }
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (cmdItemsFlat.length) { cmdSel = Math.max(0, cmdSel - 1); paintCmdSel(); }
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      runCmdItem(cmdSel);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closeCmdPalette();
    }
  });
  // 点击背景（不是面板本身）关闭
  box.addEventListener('mousedown', (ev) => { if (ev.target.hasAttribute('data-cmd-close')) closeCmdPalette(); });
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
    <div class="list-row is-click" data-act="capture-page">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><rect x="2.5" y="4.5" width="15" height="11" rx="1.6"/><circle cx="10" cy="10" r="2.6"/><path d="M6.5 4.5l1-2h5l1 2"/></svg></span>
      <span class="lr-main"><span class="lr-title">整页截图</span><span class="lr-sub">保存为 PNG，含滚动出屏幕的部分</span></span>
    </div>
    <div class="list-row is-click" data-act="print-page">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><path d="M5.5 7.5v-4h9v4"/><rect x="3.5" y="7.5" width="13" height="6" rx="1.2"/><path d="M6.5 12h7v4.5h-7z"/></svg></span>
      <span class="lr-main"><span class="lr-title">打印</span><span class="lr-sub">纸张、方向、边距等设置</span></span>
      <span class="lr-tail">Ctrl+P</span>
    </div>
    <div class="list-row is-click" data-act="save-pdf">
      <span class="lr-icon"><svg viewBox="0 0 20 20"><path d="M5 2.5h7l3 3v12H5z"/><path d="M12 2.5v3h3"/><path d="M7.5 12h5M7.5 15h3"/></svg></span>
      <span class="lr-main"><span class="lr-title">另存为 PDF</span><span class="lr-sub">把当前页保存成本地 PDF</span></span>
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

function buildSniffer(compact = false) {
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

  // 小窗模式（按钮下方那个）省掉页头与长说明：那两块在 340px 里只会把清单挤下去。
  // 设置页仍用完整版，两者内容同源，改一处两边都变。
  const head = compact ? '' : `
    <h2 class="sv-h2">媒体嗅探</h2>
    <div class="sv-lead">
      在响应头阶段识别页面加载的音视频与流媒体，判定依据分四级置信度，并把依据如实标在每一条上。
      识别不改写任何请求，纯旁路观察。
    </div>`;

  return `
    ${head}

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

    ${compact ? '' : `<div class="sv-note">
      嗅探只认「响应里声明了媒体类型」的资源。几种情况会漏，这里说清楚：
      用 <code>blob:</code> 或 MSE 在页面里现拼的流（如部分直播与 DRM 视频）网络上没有可下载的完整地址；
      加了密或需要特殊鉴权头的链接能嗅到、但下载可能被拒；
      加密的 HLS（<code>#EXT-X-KEY</code>）分片单独下下来也解不开。
    </div>`}
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

/* --- 媒体嗅探小窗 ---
 * 内容与设置页「媒体嗅探」同一份（buildSniffer），只是 compact 模式省掉页头和长说明。
 * 这里不复制任何逻辑：开关、清空、下载这些动作仍由 wireActions 统一绑定。
 */
function renderSniffPopover() {
  const body = $('#sniff-pop-body');
  if (!body) return;
  body.innerHTML = buildSniffer(true);
  wireActions(body);
}

function openSniffPopover() {
  const pop = $('#sniff-pop');
  if (!pop) return;
  renderSniffPopover();
  pop.hidden = false;
  const btn = $('#btn-sniff');
  if (btn) btn.setAttribute('aria-expanded', 'true');
}

function closeSniffPopover() {
  const pop = $('#sniff-pop');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  const btn = $('#btn-sniff');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleSniffPopover() {
  const pop = $('#sniff-pop');
  if (!pop) return;
  if (pop.hidden) openSniffPopover();
  else closeSniffPopover();
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
          <div class="hist-title">${esc(siteNameOf(h.title, h.url))}</div>
          <div class="hist-url">${esc(prettyUrl(h.url))}</div>
        </div>
        <div class="hist-time">${esc(timeAgo(h.ts))}</div>
      </div>`).join('')}</div>` : '<div class="sv-empty">暂无历史记录。</div>'}
  `;
}

async function buildPasswords() {
  try { state.credentials = await bridge.credentials.list(); } catch { state.credentials = state.credentials || []; }
  const list = state.credentials || [];
  // 缺省视为开启：老配置里没有这个键，不该因为升级就少了提示
  const pwdPromptOn = !(state.settings.passwords && state.settings.passwords.promptSave === false);
  // 自动带入：保存过的密码，下次打开这个站点直接填进登录框
  const autofillOn = !(state.settings.passwords && state.settings.passwords.autofill === false);
  return `
    <h2 class="sv-h2">密码 / 登录凭证</h2>
    <div class="sv-lead">Nova 自己保存账号密码：<b>只存本机、系统加密、不上传</b>。到网站后可点「填充到当前页」自动填入登录框。</div>
    <div class="sv-card">
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">登录后提示保存密码</span>
          <span class="lr-sub">提交登录表单时询问一次；关掉后不再打扰</span>
        </span>
        <button class="switch ${pwdPromptOn ? 'is-on' : ''}" data-act="pwd-toggle" title="登录后提示保存密码"></button>
      </div>
      <div class="list-row">
        <span class="lr-main">
          <span class="lr-title">打开网站时自动填入账号密码</span>
          <span class="lr-sub">只填本站已保存的那一条，且不覆盖已经在输入的内容</span>
        </span>
        <button class="switch ${autofillOn ? 'is-on' : ''}" data-act="autofill-toggle" title="自动填入账号密码"></button>
      </div>
    </div>
    <div class="btn-row" style="padding-top:0">
      <button class="btn btn-primary" data-act="cred-fill" ${list.length ? '' : 'disabled'}>填充到当前页</button>
      <button class="btn" data-act="cred-import" ${state.isPreview ? 'disabled title="UI 预览模式"' : ''}>从 Edge 导入</button>
      <button class="btn" data-act="cred-clear" ${list.length ? '' : 'disabled'}>全部清空</button>
    </div>
    <div class="sv-card" style="padding:var(--sp-3)">
      <div class="sv-lead" style="padding:0 0 var(--sp-2)">手动添加一条</div>
      <div style="display:flex; gap:6px; flex-wrap:wrap">
        <input id="cred-origin" class="ai-input" placeholder="网站地址，如 https://example.com" style="flex:1;min-width:180px" spellcheck="false" />
        <input id="cred-user" class="ai-input" placeholder="用户名 / 邮箱" style="flex:1;min-width:130px" spellcheck="false" />
        <input id="cred-pass" class="ai-input" type="password" placeholder="密码" style="flex:1;min-width:130px" />
        <button class="btn btn-sm" data-act="cred-add">添加</button>
      </div>
    </div>
    ${list.length ? `<div class="sv-card">${list.map((c) => `
      <div class="hist-row" data-cred-row="${esc(c.id)}">
        <div class="hist-main">
          <div class="hist-title">${esc(hostOf(c.origin) || c.origin)}</div>
          <div class="hist-url">${esc(c.username || '（无用户名）')} · ${esc(c.origin)}</div>
          <div class="cred-pw" hidden></div>
        </div>
        <div class="btn-row" style="padding:0">
          <button class="btn btn-sm" data-act="cred-reveal" data-id="${esc(c.id)}">显示</button>
          <button class="btn btn-sm" data-act="cred-copy" data-id="${esc(c.id)}">复制</button>
          <button class="btn btn-sm" data-act="cred-del" data-id="${esc(c.id)}">删除</button>
        </div>
      </div>`).join('')}</div>` : '<div class="sv-empty">还没有保存任何账号密码。</div>'}
  `;
}

/** 把当前标签页对应站点的账号密码填进登录框（尽力而为：找 password 框 + 它前面最近的文本/邮箱框）。 */
async function fillLoginIntoActiveTab() {
  const t = activeTab();
  if (!t) { toast('没有打开的标签页'); return; }
  const host = hostOf(t.url);
  if (!host) { toast('当前页没有可填充的网站'); return; }
  const cred = (state.credentials || []).find((c) => hostOf(c.origin) === host);
  if (!cred) { toast('这个网站还没有保存的密码，先在上面添加'); return; }
  const r = await bridge.credentials.reveal(cred.id);
  if (!r || !r.ok) { toast((r && r.error) || '解密失败'); return; }
  const wv = t.webview;
  if (!wv || typeof wv.executeJavaScript !== 'function') { toast('当前页没法填充'); return; }
  const code = '(function(u,p){try{'
    + 'var pw=document.querySelector("input[type=password]");if(!pw)return "no-pw";'
    + 'var form=pw.form||document;'
    + 'var cands=form.querySelectorAll("input[type=text],input[type=email],input:not([type])");'
    + 'var ue=null;for(var i=0;i<cands.length;i++){if(cands[i].compareDocumentPosition(pw)&Node.DOCUMENT_POSITION_FOLLOWING)ue=cands[i];}'
    + 'function set(el,v){if(!el)return;el.focus();el.value=v;el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));}'
    + 'set(ue,u);set(pw,p);return "ok";'
    + '}catch(e){return "err:"+e.message;}})('
    + JSON.stringify(cred.username || '') + ',' + JSON.stringify(r.password) + ')';
  try {
    const res = await wv.executeJavaScript(code);
    if (res === 'ok') { toast('已填入登录框'); closeSettings(); }
    else if (res === 'no-pw') toast('当前页没找到密码输入框');
    else toast('填充失败');
  } catch { toast('填充失败'); }
}

/* ------------------------------------------------------------------ *
 * 保存密码提示
 * ------------------------------------------------------------------ *
 * 网页提交登录表单后，webview preload 把「用户名 + 密码」送到外壳
 * （nova-login，见 src/preload/webview-preload.js）。这里决定要不要问，
 * 并把用户的选择交给主进程 —— origin 由主进程从 wc.getURL() 反查，
 * 渲染层传进去的地址不作数（否则一个 iframe 就能把密码存到别人名下）。
 *
 * 三条不问的理由：
 *   设置里关了提示 / 这个站点点过「不再提示」/ 这个账号的密码跟已存的一模一样。
 * 最后一条是关键：登录页「记住我」之后每次进来都会自动提交一次表单，
 * 每次都弹「要保存密码吗」等于把这个功能做成骚扰。
 */
let pwdTimer = null;
/** 气泡里待确认的那一条：{ wcId, origin, username, password } */
let pwdPending = null;

function hidePwdPrompt() {
  if (pwdTimer) { clearTimeout(pwdTimer); pwdTimer = null; }
  pwdPending = null;
  const el = $('#pwd-prompt');
  if (el) el.hidden = true;
}

/** 这个站点 + 账号已经存过的记录（没有就返回 null） */
async function findSavedCredential(origin, username) {
  let list = null;
  try { list = await bridge.credentials.list(); } catch { list = null; }
  if (!Array.isArray(list)) list = state.credentials || [];
  state.credentials = list;
  const o = origin.toLowerCase();
  return list.find((c) => String(c.origin).toLowerCase() === o && (c.username || '') === (username || '')) || null;
}

async function onLoginSubmitted(tab, payload) {
  if (!tab || !payload || !payload.password) return;
  const cfg = (state.settings && state.settings.passwords) || {};
  // 缺省视为开启：老配置里没有这个键，不该因为升级就少了提示
  if (cfg.promptSave === false) return;

  const origin = originOf(tab.url);
  if (!origin) return;   // about:blank / file: 之类没有可归档的站点

  const never = Array.isArray(cfg.neverFor) ? cfg.neverFor : [];
  if (never.some((x) => String(x).toLowerCase() === origin.toLowerCase())) return;

  const username = String(payload.username || '');
  const saved = await findSavedCredential(origin, username);
  if (saved) {
    // 密码没变就别问 —— 这是「记住我」自动登录的常态，不是新登录
    let same = false;
    try {
      const r = await bridge.credentials.reveal(saved.id);
      same = !!(r && r.ok && r.password === payload.password);
    } catch { same = false; }
    if (same) return;
  }

  let wcId = tab.wcId;
  if (wcId == null && tab.webview && typeof tab.webview.getWebContentsId === 'function') {
    try { wcId = tab.webview.getWebContentsId(); } catch { wcId = null; }
  }
  if (wcId == null) return;

  pwdPending = { wcId, origin, username, password: payload.password };
  const site = $('#pwd-site');
  const user = $('#pwd-user');
  const save = $('#pwd-save');
  if (site) site.textContent = hostOf(origin) || origin;
  if (user) user.textContent = username || '（无用户名）';
  if (save) save.textContent = saved ? '更新' : '保存';
  $('#pwd-prompt').hidden = false;

  // 30 秒没人理就收起：这是顺手问一句，不是必须回答的对话框
  if (pwdTimer) clearTimeout(pwdTimer);
  pwdTimer = setTimeout(hidePwdPrompt, 30000);
}

/** 保存当前这条（密码改过时就是更新） */
async function commitPwdPrompt() {
  const p = pwdPending;
  if (!p) return;
  hidePwdPrompt();   // 先收起，免得连点两下存两遍
  let r = null;
  try { r = await bridge.credentials.saveFromPage(p.wcId, p.username, p.password); }
  catch { r = null; }
  if (r && r.ok) {
    toast(r.updated ? '密码已更新（设置 → 密码 可查看）' : '密码已保存（设置 → 密码 可查看）');
    try { state.credentials = await bridge.credentials.list(); } catch { /* 列表刷新失败不影响已保存 */ }
    return;
  }
  toast((r && r.error) || '保存失败');
}

/** 这个站点不再提示；只记 origin，别处照旧 */
async function mutePwdPromptForSite() {
  const p = pwdPending;
  hidePwdPrompt();
  if (!p) return;
  const cfg = (state.settings && state.settings.passwords) || {};
  const never = (Array.isArray(cfg.neverFor) ? cfg.neverFor : []).slice();
  if (!never.some((x) => String(x).toLowerCase() === p.origin.toLowerCase())) never.push(p.origin);
  try {
    state.settings = await bridge.settings.patch({ passwords: { neverFor: never } });
    toast('这个网站不再提示保存密码');
  } catch { toast('设置没能保存（预览模式）'); }
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

    <div class="panel-label">限速（所有任务合计）</div>
    ${seg('dl-limit', [0, 256, 512, 1024, 2048], prefs.speedLimitKB || 0, (v) => (v === 0 ? '不限速' : v + ' KB/s'))}
    <div class="muted" style="padding-bottom:var(--sp-3)">对所有任务合计生效；改完立即生效，正在下载的任务下一块数据就按新速度走。</div>

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
    <div class="muted" style="padding-top:var(--sp-2)">
      ed2k / 磁力链接不用在这里粘 —— 网页里点一下就会交给系统里注册的下载客户端，
      没装客户端时会提示复制链接。
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
 * 往标签页里注入「选中文字 → 迷你条（搜索 / 复制）」。
 * 为什么注入进页面而不是在外壳里画：<webview> 会盖在同层 DOM 之上，外壳画的小条会被盖住；
 * 注入进页面（用 Shadow DOM 隔离样式）就不会被遮。搜索用 window.open → 复用 new-window 建新标签。
 */
function injectSelectionBar(tab) {
  const wv = tab.webview;
  if (!wv || typeof wv.executeJavaScript !== 'function') return;
  const tpl = state.settings.searchTemplate || 'https://www.baidu.com/s?wd=%s';
  const script = '(function(){'
    + 'if(window.__novaSelBar)return "already";'
    + 'var TPL=' + JSON.stringify(tpl) + ';'
    + 'var host=document.createElement("div");'
    + 'host.style.cssText="all:initial;position:fixed;z-index:2147483000;left:0;top:0";'
    + 'var sh=host.attachShadow({mode:"open"});'
    + 'sh.innerHTML="<style>'
    +   '.bar{position:fixed;display:none;background:#1f2430;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.28);font:12px/1.2 -apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;overflow:hidden}'
    +   '.bar.show{display:flex}'
    +   'button{all:unset;padding:8px 12px;color:#fff;font-size:12px;cursor:pointer;white-space:nowrap}'
    +   'button:hover{background:#2c3342}'
    +   'button+button{border-left:1px solid rgba(255,255,255,.14)}'
    + '</style>'
    + '<div class=bar><button data-a=search>搜索</button><button data-a=copy>复制</button></div>";'
    + 'document.documentElement.appendChild(host);'
    + 'var bar=sh.querySelector(".bar");var cur="";'
    + 'function hide(){bar.classList.remove("show")}'
    + 'function place(){'
    +   'var s=window.getSelection();if(!s||!s.rangeCount)return hide();'
    +   'var t=s.toString().trim();if(!t)return hide();'
    +   'var r;try{r=s.getRangeAt(0).getBoundingClientRect()}catch(e){return hide()}'
    +   'if(!r||(!r.width&&!r.height))return hide();'
    +   'cur=t;bar.classList.add("show");'
    +   'var bw=112,x=r.left+r.width/2-bw/2,y=r.top-40;'
    +   'if(y<4)y=r.bottom+8;if(x<4)x=4;'
    +   'if(x>window.innerWidth-bw-8)x=window.innerWidth-bw-8;'
    +   'bar.style.left=x+"px";bar.style.top=y+"px";'
    + '}'
    + 'document.addEventListener("mouseup",function(e){if(e.composedPath().indexOf(host)>=0)return;setTimeout(place,0)},true);'
    + 'document.addEventListener("mousedown",function(e){if(e.composedPath().indexOf(host)>=0)return;hide()},true);'
    + 'document.addEventListener("scroll",hide,true);'
    + 'document.addEventListener("keydown",function(e){if(e.key==="Escape")hide()},true);'
    + 'bar.addEventListener("mousedown",function(e){e.preventDefault()});'
    + 'bar.addEventListener("click",function(e){'
    +   'var b=e.target&&e.target.closest?e.target.closest("button"):null;if(!b)return;'
    +   'var a=b.getAttribute("data-a");'
    +   'if(a==="copy"){'
    +     'try{navigator.clipboard.writeText(cur)}catch(err){}'
    +     'try{var ta=document.createElement("textarea");ta.value=cur;ta.style.cssText="position:fixed;left:-9999px";document.body.appendChild(ta);ta.select();document.execCommand("copy");ta.remove()}catch(err){}'
    +     'hide();'
    +   '}else if(a==="search"){'
    +     'var u=TPL.replace("%s",encodeURIComponent(cur));'
    +     'try{window.open(u,"_blank")}catch(err){}'
    +     'hide();'
    +   '}'
    + '});'
    + 'window.__novaSelBar=true;return "ok";'
    + '})()';
  try { wv.executeJavaScript(script); } catch { /* 页面还没就绪就算了 */ }
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
      双内核：<b>Chromium</b>（进程内真实 Blink）与 <b>IE / Trident</b>（原生宿主进程，NDJSON over stdio）。
      探测不到宿主的绝不假装成真内核，会如实降级为兼容层并说明原因。
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
        把 <code>trident-host.exe</code> 放进 <code>native/bin/</code> 后重新探测，
        IE 内核会从「兼容层」升级为「原生桥接」。<br />
        抓取内核：<code>bash tools/fetch-engines.sh</code>　校验：<code>node tools/check-engines.js</code>
      </div>
    </div>

    <div class="panel-label">按站点自动切换</div>
    <div class="sv-card">
      ${(state.settings.siteEngines || []).length
        ? (state.settings.siteEngines || []).map((r) => `
          <div class="list-row">
            <span class="lr-main">
              <span class="lr-title">${esc(r.host)}</span>
              <span class="lr-sub">打开该站及其子域时自动使用 ${esc(engineLabel(r.engine))}</span>
            </span>
            <button class="btn btn-sm" data-rule-del="${esc(r.host)}">移除</button>
          </div>`).join('')
        : '<div class="sv-empty">还没有规则。比如把老 OA / 网银域名指到 IE，其余走 Chromium。</div>'}
    </div>
    <div class="dl-new" style="padding-top:var(--sp-2)">
      <input id="site-rule-host" placeholder="example.com" spellcheck="false" />
      <select id="site-rule-engine" class="site-rule-sel">
        ${state.engines.map((e) => `<option value="${esc(e.id)}">${esc(e.label)}</option>`).join('')}
      </select>
      <button class="btn btn-primary" id="site-rule-add">添加</button>
    </div>
    <div class="muted" style="padding:var(--sp-2) 0 0">
      规则按「精确主机 → 逐级父域」匹配：写 <code>example.com</code> 也会命中 <code>www.example.com</code>。
      手动切换只对当前标签页这一次有效，重新打开仍按规则走。
    </div>
  `;
}

/* --- 站点权限（设置分区） ---
 * 按域名的权限覆盖，与按站点切内核（siteEngines）同口径：数组整体替换，
 * 规则按「精确主机 → 逐级父域」匹配（见主进程 permissions.matchHostRule）。
 * 这里只暴露最常管的几类；其余分类（全屏 / 指针锁定 / MIDI / 打开外部程序）
 * 引擎同样认，只是界面上不一一列出。 */
const PERM_CATS = [
  { key: 'geolocation', label: '位置信息' },
  { key: 'notifications', label: '通知' },
  { key: 'camera', label: '摄像头' },
  { key: 'microphone', label: '麦克风' },
  { key: 'popups', label: '弹出窗口' }
];

function buildPermissions() {
  const rules = (state.settings && state.settings.permissions) || [];
  return `
    <h2 class="sv-h2">站点权限</h2>
    <div class="sv-lead">
      给特定域名单独设定权限，覆盖全局默认。规则按「精确主机 → 逐级父域」匹配：
      写 <code>example.com</code> 也会命中 <code>www.example.com</code>。
      没列出的站点走浏览器默认（通常是「访问时询问」）。
    </div>

    ${rules.length
      ? `<div class="sv-card perm-card-list">${rules.map((r) => `
          <div class="perm-rule">
            <div class="perm-rule-head">
              <span class="perm-host">${esc(r.host)}</span>
              <button class="btn btn-sm" data-act="perm-del" data-host="${esc(r.host)}">移除</button>
            </div>
            <div class="perm-grid">
              ${PERM_CATS.map((c) => {
                const cur = (r.rules && r.rules[c.key]) || 'ask';
                return `<div class="perm-cat">
                  <span class="perm-cat-label">${esc(c.label)}</span>
                  <select class="perm-cat-sel" data-host="${esc(r.host)}" data-cat="${esc(c.key)}">
                    <option value="ask" ${cur === 'ask' ? 'selected' : ''}>询问</option>
                    <option value="allow" ${cur === 'allow' ? 'selected' : ''}>允许</option>
                    <option value="block" ${cur === 'block' ? 'selected' : ''}>禁止</option>
                  </select>
                </div>`;
              }).join('')}
            </div>
          </div>`).join('')}</div>`
      : '<div class="sv-empty">还没有站点权限规则。下面的输入框加一个域名即可开始设定。</div>'}

    <div class="dl-new" style="padding-top:var(--sp-2)">
      <input id="perm-host" placeholder="example.com" spellcheck="false" />
      <button class="btn btn-primary" data-act="perm-add">添加站点</button>
    </div>
    <div class="muted" style="padding:var(--sp-2) 0 0">
      选「询问」= 该站点下次访问若用到此权限会再弹条问你；选「允许 / 禁止」则不再问。
      仅当前会话内的选择（不写到这里）刷新页面后失效，要长期生效请在此显式设定。
    </div>
  `;
}

/* --- 站点权限询问条 ---
 * 主进程把一次权限询问推过来（bridge 'permission:request'）时，这里叠出一条
 * 带「允许 / 禁止」的提示条。一次可能叠多条（不同站点 / 不同权限），所以
 * #perm-stack 是容器，每条 bar 带自己的 requestId。用户点了就回主进程
 * （bridge.permissions.resolve(requestId, allow)），解除挂起的回调。 */
function showPermissionRequest(p) {
  if (!p || !p.requestId) return;
  const stack = $('#perm-stack');
  if (!stack) return;
  if (stack.querySelector(`.perm-req[data-request="${p.requestId}"]`)) return; // 同一次不重画
  const bar = document.createElement('div');
  bar.className = 'perm-req';
  bar.dataset.request = String(p.requestId);
  bar.innerHTML = `
    <svg class="perm-req-ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 8.5V6.8a4.5 4.5 0 0 1 9 0v1.7"/><rect x="4" y="8.5" width="12" height="7.5" rx="1.8"/></svg>
    <span class="perm-req-text"><b>${esc(p.host)}</b> 想要使用 <b>${esc(p.label || p.category)}</b></span>
    <span class="perm-req-actions">
      <button class="btn btn-sm" data-perm-allow="0">禁止</button>
      <button class="btn btn-sm btn-primary" data-perm-allow="1">允许</button>
    </span>`;
  bar.querySelectorAll('[data-perm-allow]').forEach((btn) => {
    btn.addEventListener('click', () => resolvePermissionRequest(p.requestId, btn.dataset.permAllow === '1'));
  });
  stack.appendChild(bar);
  stack.hidden = false;
}

function resolvePermissionRequest(requestId, allow) {
  const stack = $('#perm-stack');
  if (stack) {
    const bar = stack.querySelector(`.perm-req[data-request="${requestId}"]`);
    if (bar) bar.remove();
    if (!stack.querySelector('.perm-req')) stack.hidden = true;
  }
  // 未捕获异常兜底：桥在 UI 预览模式下是空壳，resolve 不存在就静默放过
  try { if (bridge && bridge.permissions && bridge.permissions.resolve) bridge.permissions.resolve(requestId, allow); }
  catch { /* 预览模式：忽略 */ }
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
      <p class="up-none">${pct}%${u.speed ? ` · ${fmtBytes(u.speed)}/s` : ''}。下载完会校验 sha256，校验不过会丢弃重来。</p>
      ${notes}`;
  }

  if (u.status === 'ready') {
    // 自动安装开着时界面上已经挂了倒计时条（#update-now），
    // 这里就不再说「重启后生效」那种含糊话 —— 说清「马上就要重启」。
    const auto = updatePref().autoInstall && !u.autoInstallCancelled;
    return `<div class="up-ver">${esc((u.info && u.info.version) || '')} 已下载完毕</div>
      <p class="up-none">${auto ? '即将重启并拉起安装器。' : '重启后生效。'}当前页面里未保存的内容会丢失。</p>
      ${notes}
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
    { id: 'passwords', label: '密码', icon: 'key', count: () => (state.credentials || []).length },
    { id: 'permissions', label: '站点权限', icon: 'globe' },
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
  key: '<circle cx="7" cy="13" r="3"/><path d="M9.1 11.1L16 4.2M13.9 4.2h2.4v2.4"/>',
  info: '<circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 6.5v.01"/>',
  globe: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2.4 2 2.4 12 0 14M10 3c-2.4 2-2.4 12 0 14"/>'
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
  passwords: buildPasswords,
  permissions: buildPermissions,
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
  closeSniffPopover(); // 整页设置盖上来时，小窗不该还浮在上面
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
  passwords: 'passwords',
  permissions: 'permissions',
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

  // 嗅探小窗开着时跟着刷新。预览中的 <video> 不能重绘 —— 会被拆掉、播放中断。
  const sniffPop = $('#sniff-pop');
  if (sniffPop && !sniffPop.hidden && !state.sniffPreview) renderSniffPopover();

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
  // 设置页的嗅探分区 或 工具栏小窗，任一个开着就该刷
  const pop = $('#sniff-pop');
  const popOpen = !!(pop && !pop.hidden);
  const view = $('#settings-view');
  const settingsOpen = state.settingsSection === 'sniffer' && !!view && !view.hidden;
  if (!popOpen && !settingsOpen) return;

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

  root.querySelectorAll('#dl-limit button').forEach((b) => {
    b.addEventListener('click', async () => {
      const v = Number(b.dataset.v);
      root.querySelectorAll('#dl-limit button').forEach((x) => x.classList.toggle('is-active', x === b));
      state.settings.download = Object.assign({}, state.settings.download, { speedLimitKB: v });
      await bridge.settings.patch({ download: { speedLimitKB: v } });
      toast(v === 0 ? '已取消限速' : `全局限速已设为 ${v} KB/s`);
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
      else if (act === 'capture-page') {
        const t = activeTab();
        if (!t || !t.webview || t.webview.__bridge) { toast('当前内核不支持网页截图'); return; }
        let id = t.wcId;
        if (id == null && typeof t.webview.getWebContentsId === 'function') {
          try { id = t.webview.getWebContentsId(); } catch { /* 还没就绪 */ }
        }
        const r = await bridge.page.capture(id, 'full');
        if (r && r.ok) { closeDrawer(); toast('截图已保存'); }
        else if (r && r.error) toast(r.error);
      }
      else if (act === 'print-page') { closeDrawer(); openPrintDialog(activeTab()); }
      else if (act === 'save-pdf') {
        const t = activeTab();
        if (!t || !t.webview || t.webview.__bridge) { toast('当前内核不支持另存为 PDF'); return; }
        let id = t.wcId;
        if (id == null && typeof t.webview.getWebContentsId === 'function') {
          try { id = t.webview.getWebContentsId(); } catch { /* 还没就绪 */ }
        }
        const r = await bridge.page.savePdf(id);
        if (r && r.ok) { closeDrawer(); toast('已保存 PDF'); }
        else if (r && r.error) toast(r.error);
      }
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
      } else if (act === 'cred-import') {
        toast('正在从 Edge 读取并解密…');
        const r = await bridge.credentials.importEdge();
        if (r && r.error) { toast(r.error); return; }
        state.credentials = await bridge.credentials.list();
        refreshCurrent();
        if (!r.added && !r.dup) {
          toast(r.skipped
            ? 'Edge 这些密码用了新版 App-Bound 加密，暂无法导入（Edge 的安全限制）'
            : 'Edge 里没有可导入的密码');
          return;
        }
        const bits = [];
        if (r.added) bits.push('新增 ' + r.added);
        if (r.dup) bits.push('已存在 ' + r.dup);
        if (r.skipped) bits.push('跳过 ' + r.skipped);
        toast('导入完成：' + bits.join('，'));
      } else if (act === 'pwd-toggle') {
        const cur = !(state.settings.passwords && state.settings.passwords.promptSave === false);
        state.settings = await bridge.settings.patch({ passwords: { promptSave: !cur } });
        renderSettingsSection('passwords');
        toast(!cur ? '登录后不再提示保存密码' : '登录后会提示保存密码');
      } else if (act === 'autofill-toggle') {
        const cur = !(state.settings.passwords && state.settings.passwords.autofill === false);
        state.settings = await bridge.settings.patch({ passwords: { autofill: !cur } });
        renderSettingsSection('passwords');
        toast(!cur ? '已关闭自动填入，仍可手动点「填充到当前页」' : '已开启自动填入');
      } else if (act === 'cred-add') {
        const g = (id) => { const el = root.querySelector('#' + id); return el ? el.value : ''; };
        const r = await bridge.credentials.add({
          origin: g('cred-origin').trim(), username: g('cred-user').trim(), password: g('cred-pass')
        });
        if (r && r.error) { toast(r.error); return; }
        state.credentials = await bridge.credentials.list();
        refreshCurrent();
        toast('已保存这条密码');
      } else if (act === 'cred-fill') {
        await fillLoginIntoActiveTab();
      } else if (act === 'cred-clear') {
        await bridge.credentials.clear();
        state.credentials = [];
        refreshCurrent();
        toast('已清空保存的密码');
      } else if (act === 'cred-reveal') {
        const row = b.closest('[data-cred-row]');
        const pwEl = row && row.querySelector('.cred-pw');
        if (!pwEl) return;
        if (!pwEl.hidden) { pwEl.hidden = true; pwEl.textContent = ''; b.textContent = '显示'; return; }
        const r = await bridge.credentials.reveal(b.dataset.id);
        if (!r || !r.ok) { toast((r && r.error) || '解密失败'); return; }
        pwEl.textContent = r.password;
        pwEl.hidden = false;
        b.textContent = '隐藏';
      } else if (act === 'cred-copy') {
        const r = await bridge.credentials.reveal(b.dataset.id);
        if (!r || !r.ok) { toast((r && r.error) || '解密失败'); return; }
        await bridge.system.copy(r.password);
        toast('密码已复制');
      } else if (act === 'cred-del') {
        await bridge.credentials.remove(b.dataset.id);
        state.credentials = await bridge.credentials.list();
        refreshCurrent();
        toast('已删除');
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
      } else if (act === 'perm-del') {
        const host = b.dataset.host;
        const list = (state.settings.permissions || []).filter((x) => x.host !== host);
        state.settings.permissions = list;
        await bridge.settings.patch({ permissions: list });
        refreshCurrent();
        toast('已移除该站点的权限规则');
      } else if (act === 'perm-add') {
        const input = root.querySelector('#perm-host');
        const host = normalizeSiteHost(input && input.value);
        if (!host) { toast('请输入域名，例如 example.com'); return; }
        const list = (state.settings.permissions || []).slice();
        if (!list.some((x) => x.host === host)) list.push({ host, rules: {} });
        state.settings.permissions = list;
        await bridge.settings.patch({ permissions: list });
        refreshCurrent();
        toast(`已添加 ${host}`);
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

  /* --- 站点内核规则：增 / 删 --- */
  root.querySelectorAll('[data-rule-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      const host = b.dataset.ruleDel;
      const list = (state.settings.siteEngines || []).filter((x) => x.host !== host);
      state.settings.siteEngines = list;
      await bridge.settings.patch({ siteEngines: list });
      refreshCurrent();
      toast('已移除站点规则');
    });
  });
  const ruleAdd = root.querySelector('#site-rule-add');
  if (ruleAdd) {
    const hostEl = root.querySelector('#site-rule-host');
    const engEl = root.querySelector('#site-rule-engine');
    const submit = async () => {
      const host = normalizeSiteHost(hostEl && hostEl.value);
      if (!host) { toast('请输入域名，例如 example.com'); return; }
      const engineId = engEl && engEl.value;
      if (!engineExists(engineId)) { toast('该内核当前不可用'); return; }
      const list = (state.settings.siteEngines || []).slice();
      const i = list.findIndex((x) => x.host === host);
      if (i >= 0) list[i] = { host, engine: engineId };
      else list.push({ host, engine: engineId });
      state.settings.siteEngines = list;
      await bridge.settings.patch({ siteEngines: list });
      refreshCurrent();
      toast(`已设置 ${host} → ${engineLabel(engineId)}`);
    };
    ruleAdd.addEventListener('click', submit);
    if (hostEl) hostEl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });
  }

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

  /* 站点权限：每个分类一个下拉（允许 / 禁止 / 询问）。用 change 委托挂在 root 上，
   * 因为 select 不是 click 型的 data-act，且每次重画都要能继续响应。
   * 改完直接 patch，不必整页重绘 —— select 自己已经反映了新值，重绘反而闪。 */
  root.addEventListener('change', async (ev) => {
    const sel = ev.target.closest('.perm-cat-sel');
    if (!sel) return;
    const host = sel.dataset.host;
    const cat = sel.dataset.cat;
    const val = sel.value;
    const list = (state.settings.permissions || []).slice();
    const rule = list.find((x) => x.host === host);
    if (!rule) return;
    rule.rules = Object.assign({}, rule.rules, { [cat]: val });
    state.settings.permissions = list;
    await bridge.settings.patch({ permissions: list });
  });
}

/* ------------------------------------------------------------------ *
 * 移动端
 * ------------------------------------------------------------------ */

function openTabGrid() {
  state.tabQuery = '';
  const inp = $('#tg-search');
  if (inp) inp.value = '';
  $('#tab-grid').hidden = false;
  renderTabGrid();
  // 打开就聚焦搜索框：这个视图的入口多数时候就是想「找一个标签页」
  if (inp) inp.focus();
}

function closeTabGrid() {
  $('#tab-grid').hidden = true;
  state.tabQuery = '';
}

/* ------------------------------------------------------------------ *
 * 命令面板（Ctrl+K）
 * ------------------------------------------------------------------ */

/** 命令面板里用到的图标，全是 20x20 viewBox 的 path 串，渲染时统一包一层 <svg>。 */
const CMD_ICON = {
  plus: '<path d="M10 4v12M4 10h12"/>',
  minus: '<path d="M4 10h12"/>',
  x: '<path d="M5 5l10 10M15 5L5 15"/>',
  reset: '<path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9"/><path d="M16 4v3.5h-3.5"/>',
  home: '<path d="M3.5 9L10 3.5 16.5 9v7.5h-5v-4h-3v4h-5z"/>',
  gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/>',
  star: '<path d="M10 3l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.8 5.8 16l.8-4.7L3.2 8l4.7-.7z"/>',
  search: '<circle cx="9" cy="9" r="6"/><path d="M14 14l3.5 3.5"/>',
  camera: '<rect x="2.5" y="4.5" width="15" height="11" rx="1.6"/><circle cx="10" cy="10" r="2.6"/><path d="M6.5 4.5l1-2h5l1 2"/>',
  pdf: '<path d="M5 2.5h7l3 3v12H5z"/><path d="M12 2.5v3h3"/><path d="M7.5 12h5M7.5 15h3"/>',
  book: '<path d="M3 5.5C3 4.7 3.7 4 4.5 4H9v12H4.5C3.7 16 3 15.3 3 14.5z"/><path d="M17 5.5C17 4.7 16.3 4 15.5 4H11v12h4.5c.8 0 1.5-.7 1.5-1.5z"/>',
  mute: '<path d="M4 8.5v3h2.5L10 15V5L6.5 8.5z"/><path d="M13 8l4 4M17 8l-4 4"/>',
  link: '<path d="M8 12l4-4"/><path d="M9 6.5l1.5-1.5a3 3 0 0 1 4 4L13 10.5"/><path d="M11 13.5l-1.5 1.5a3 3 0 0 1-4-4L7 9.5"/>',
  down: '<path d="M10 3.5v9M6.5 9.5L10 13l3.5-3.5M4 16h12"/>',
  eye: '<path d="M2.5 10S5.5 5 10 5s7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2.6"/>',
  lock: '<path d="M5.5 8.5V6.8a4.5 4.5 0 0 1 9 0v1.7"/><rect x="4" y="8.5" width="12" height="7.5" rx="1.8"/>',
  chip: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.6"/><path d="M8.5 2.5v3M11.5 2.5v3M8.5 14.5v3M11.5 14.5v3M2.5 8.5h3M2.5 11.5h3M14.5 8.5h3M14.5 11.5h3"/>',
  clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4.2l3 1.8"/>',
  tab: '<rect x="2.5" y="5" width="10" height="10" rx="1.4"/><path d="M12.5 8h5M12.5 11h5"/>',
  globe: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2.5 2.4 2.5 11.6 0 14M10 3c-2.5 2.4-2.5 11.6 0 14"/>'
};

/** 全部设置分区的扁平列表，命令面板里「打开设置」用它动态生成。 */
const ALL_PANELS = SETTINGS_NAV.flatMap((g) => g.items || []);

/** 当前页是否已在书签里，决定命令面板的「加入/移出」文案。 */
function bookmarkToggleLabel() {
  const t = activeTab();
  const on = !!t && (state.bookmarks || []).some((b) => b.url === t.url);
  return on ? '移出书签' : '加入书签';
}

async function toggleBookmarkCurrent() {
  const t = activeTab();
  if (!t) { toast('还没有打开的标签页'); return; }
  const existing = (state.bookmarks || []).find((b) => b.url === t.url);
  if (existing) state.bookmarks = await bridge.bookmarks.remove(t.url);
  else state.bookmarks = await bridge.bookmarks.add({ title: t.title, url: t.url, favicon: t.favicon || null });
  refreshCurrent();
  toast(existing ? '已移出书签' : '已加入书签');
}

/** 整页截图 / 另存为 PDF 的复用入口（与菜单面板里的逻辑一致）。 */
async function cmdCapturePage() {
  const t = activeTab();
  if (!t || !t.webview || t.webview.__bridge) { toast('当前内核不支持网页截图'); return; }
  let id = t.wcId;
  if (id == null && typeof t.webview.getWebContentsId === 'function') {
    try { id = t.webview.getWebContentsId(); } catch { /* 还没就绪 */ }
  }
  const r = await bridge.page.capture(id, 'full');
  if (r && r.ok) toast('截图已保存');
  else if (r && r.error) toast(r.error);
}

/* ------------------------------------------------------------------ *
 * 打印
 * ------------------------------------------------------------------ *
 * 网页里的 window.print() 与 Ctrl+P 都被 webview preload 转成 nova-print
 * 事件送到这里（见 src/preload/webview-preload.js）—— 因为 Electron 没实现
 * Chromium 的打印预览，网页自己调 print() 是静默失败的。外壳这一层负责把
 * 纸张 / 方向 / 边距这些设置摆出来，再交给主进程的 webContents.print()。
 */

/** 纸张档位。尺寸表在主进程（毫米），这里只保证选项值一致。 */
const PRINT_PAPER_KEYS = ['A4', 'A3', 'A5', 'B5', 'Letter', 'Legal', 'Tabloid', '16K', 'custom'];

/**
 * 让页面里的 window.print() 落到 Nova 的打印窗口。
 *
 * 钩子本身在主进程装（src/main/print-hook.js）：webview 开着 contextIsolation，
 * preload 在隔离世界改不到页面的 print。这里只负责在 dom-ready 时喊一声，
 * 之后每次框架导航由主进程自己补装。
 */
function installPrintHook(tab) {
  if (!tab || (tab.webview && tab.webview.__bridge)) return;
  if (tab.wcId == null) return;
  if (!bridge.page || typeof bridge.page.installPrintHook !== 'function') return;
  try {
    const r = bridge.page.installPrintHook(tab.wcId);
    if (r && typeof r.catch === 'function') r.catch(() => { /* 页面已关闭 */ });
  } catch { /* 同上 */ }
}

/** 上次用过的打印设置，存在 settings.print 里。 */
function printPrefs() {
  const p = (state.settings && state.settings.print) || {};
  const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
  return {
    pageSize: PRINT_PAPER_KEYS.includes(p.pageSize) ? p.pageSize : 'A4',
    customWidth: num(p.customWidth, 210),
    customHeight: num(p.customHeight, 297),
    landscape: !!p.landscape,
    marginType: ['default', 'printableArea', 'none', 'custom'].includes(p.marginType) ? p.marginType : 'default',
    marginTop: num(p.marginTop, 10),
    marginBottom: num(p.marginBottom, 10),
    marginLeft: num(p.marginLeft, 10),
    marginRight: num(p.marginRight, 10),
    scale: num(p.scale, 100),
    copies: num(p.copies, 1),
    printBackground: p.printBackground !== false,
    headerFooter: !!p.headerFooter,
    deviceName: typeof p.deviceName === 'string' ? p.deviceName : ''
  };
}

/** 当前正在打印的 webContents；关闭面板后置空，避免把任务发到已经关掉的标签页 */
let printWcId = null;
let printBusy = false;

function printSegValue(sel, key) {
  const b = document.querySelector(sel + ' .is-active');
  return b ? (b.dataset[key] || '') : '';
}

function setPrintSeg(sel, key, value) {
  $$(sel + ' button').forEach((b) => b.classList.toggle('is-active', b.dataset[key] === value));
}

function setPrintNum(sel, value) {
  const el = $(sel);
  if (el) el.value = String(value);
}

function readPrintNum(sel, def) {
  const el = $(sel);
  const n = el ? Number(el.value) : NaN;
  return Number.isFinite(n) ? n : def;
}

/** 自定义尺寸 / 自定义边距只在选中「自定义」时展开 */
function syncPrintCustom() {
  $('#print-paper-custom').hidden = $('#print-paper').value !== 'custom';
  $('#print-margin-custom').hidden = printSegValue('#print-margins', 'margin') !== 'custom';
}

function fillPrintForm(p) {
  $('#print-paper').value = p.pageSize;
  setPrintNum('#print-paper-w', p.customWidth);
  setPrintNum('#print-paper-h', p.customHeight);
  setPrintSeg('#print-orient', 'orient', p.landscape ? 'landscape' : 'portrait');
  setPrintSeg('#print-margins', 'margin', p.marginType);
  setPrintNum('#print-mt', p.marginTop);
  setPrintNum('#print-mb', p.marginBottom);
  setPrintNum('#print-ml', p.marginLeft);
  setPrintNum('#print-mr', p.marginRight);
  setPrintNum('#print-scale', p.scale);
  setPrintNum('#print-copies', p.copies);
  $('#print-range').value = '';
  $('#print-bg').classList.toggle('is-on', p.printBackground);
  $('#print-hf').classList.toggle('is-on', p.headerFooter);
  syncPrintCustom();
}

function setPrintBusy(busy) {
  ['#print-go', '#print-direct', '#print-pdf', '#print-cancel', '#print-close', '#print-refresh'].forEach((sel) => {
    const b = $(sel);
    if (b) b.disabled = busy;
  });
  const go = $('#print-go');
  if (go) go.textContent = busy ? '正在打印…' : '打印…';
}

function closePrintDialog() {
  const v = $('#print-view');
  if (!v || v.hidden) return;
  v.hidden = true;
  printWcId = null;
  resetPrintPreview();
}

/**
 * 打开打印设置。
 * 入口有四个：Ctrl+P、菜单「打印」、命令面板、网页里的 window.print()。
 * 统一从这里进，避免四条路各写一套「取 wcId」的逻辑 —— 那正是漏改的来源。
 */
function openPrintDialog(tab) {
  const t = tab || activeTab();
  if (!t || !t.webview || t.webview.__bridge) { toast('当前内核不支持打印'); return; }
  let id = t.wcId;
  if (id == null && typeof t.webview.getWebContentsId === 'function') {
    try { id = t.webview.getWebContentsId(); } catch { /* 还没就绪 */ }
  }
  if (id == null) { toast('页面还没准备好，稍后再试'); return; }

  closeDrawer();
  closeCmdPalette();
  closeSettings();   // 打印是模态：别让它压在设置窗上面叠成两层
  printWcId = id;

  const p = printPrefs();
  $('#print-doc-title').textContent = t.title || '当前页面';
  $('#print-doc-url').textContent = prettyUrl(t.url || '');
  $('#print-target').textContent = t.title || '';
  $('#print-note').textContent = '「打印…」会弹出系统打印窗口，可在那边再选打印机；「直接打印」按上面的设置立刻出纸。';
  fillPrintForm(p);
  $('#print-view').hidden = false;
  refreshPrinters(p.deviceName);
  // 先摆出预览的骨架（遮罩 + 纸张信息），再去排 PDF：printToPDF 要几百毫秒，
  // 空着的右半屏会让人以为这栏坏了
  resetPrintPreview();
  renderPreviewMeta();
  schedulePrintPreview(0);
  setTimeout(() => { const b = $('#print-go'); if (b) b.focus(); }, 30);
}

/**
 * 读系统打印机列表。
 * 读不到也不挡住打印：下拉里留「使用系统默认打印机」，用户仍可以点「打印…」
 * 在系统窗口里选 —— 把「列不出打印机」升级成「不能打印」是没必要的。
 */
async function refreshPrinters(preferred) {
  const sel = $('#print-printer');
  if (!sel) return;
  sel.innerHTML = '<option value="">（使用系统默认打印机）</option>';
  let r = null;
  try { r = await bridge.page.printers(printWcId); } catch { r = null; }

  const list = (r && r.ok && Array.isArray(r.printers)) ? r.printers : [];
  for (const p of list) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.displayName + (p.isDefault ? '（默认）' : '');
    sel.appendChild(o);
  }
  const want = preferred || ((list.find((p) => p.isDefault) || {}).name || '');
  if (want && list.some((p) => p.name === want)) sel.value = want;

  if (!r || !r.ok) {
    $('#print-note').textContent = (r && r.error ? r.error + '；' : '')
      + '仍可点「打印…」在系统窗口里选择打印机。';
  } else if (!list.length) {
    $('#print-note').textContent = '没有检测到打印机；可点「打印…」在系统窗口里再选，或先「保存为 PDF」。';
  }
}

function collectPrintOptions(opt) {
  const o = {
    deviceName: $('#print-printer').value || '',
    pageSize: $('#print-paper').value,
    customWidth: readPrintNum('#print-paper-w', 210),
    customHeight: readPrintNum('#print-paper-h', 297),
    landscape: printSegValue('#print-orient', 'orient') === 'landscape',
    marginType: printSegValue('#print-margins', 'margin') || 'default',
    marginTop: readPrintNum('#print-mt', 10),
    marginBottom: readPrintNum('#print-mb', 10),
    marginLeft: readPrintNum('#print-ml', 10),
    marginRight: readPrintNum('#print-mr', 10),
    scale: readPrintNum('#print-scale', 100),
    copies: readPrintNum('#print-copies', 1),
    pageRanges: ($('#print-range').value || '').trim(),
    printBackground: $('#print-bg').classList.contains('is-on'),
    headerFooter: $('#print-hf').classList.contains('is-on')
  };
  // 预览走 printToPDF，没有「打印机」这个概念；把 deviceName 传过去只会让人
  // 以为预览是发到那台机器上排的
  if (opt && opt.withDevice === false) delete o.deviceName;
  return o;
}

/** 预览区右上角那行小字：改任何一项都要立刻跟着变，所以按当前表单现算 */
function previewInfoText() {
  const o = collectPrintOptions({ withDevice: false });
  const size = o.pageSize === 'custom' ? `${o.customWidth}×${o.customHeight}mm` : o.pageSize;
  const dir = o.landscape ? '横向' : '纵向';
  const mg = o.marginType === 'none' ? '无边距'
    : o.marginType === 'custom' ? `边距 ${o.marginTop}/${o.marginBottom}/${o.marginLeft}/${o.marginRight}mm`
      : '边距 10mm';
  return `${size} · ${dir} · ${mg} · ${o.scale}%`;
}

/**
 * 预览区顶部那两处文字：纸张信息 + 页数。
 * 页数单独做成一个胶囊而不是拼进那行小字里 —— 用户改纸张高度时最想知道的就是
 * 「会不会溢到第二页」，这是这一屏的结论，不该混在一串参数里。
 * 0 表示还不知道（正在排 / 数不出来），这时候不显示，免得写个「共 0 页」吓人。
 */
function renderPreviewMeta() {
  const info = $('#print-preview-info');
  if (info) info.textContent = previewInfoText();
  const pill = $('#print-preview-pages');
  if (!pill) return;
  if (previewPages > 0) {
    pill.textContent = previewPages === 1 ? '共 1 页' : `共 ${previewPages} 页`;
    pill.classList.toggle('is-multi', previewPages > 1);
    pill.hidden = false;
  } else {
    pill.hidden = true;
  }
}

/* 预览：每改一项设置就重排一次 PDF。
 * printToPDF 的代价是整页排版 + 写盘，所以在数字框里敲键不能每敲一下就排一次，
 * 250ms 内的连续改动只跑最后一次。 */
const PRINT_PREVIEW_DELAY = 250;
let previewTimer = null;
/** 只认最后一次请求的结果：改得快时前几次的响应会晚到，不能拿它盖掉新的 */
let previewSeq = 0;
/** 上一次预览排出来几页（0 = 还不知道）。改设置时先清零，等新结果回来再填 */
let previewPages = 0;

function schedulePrintPreview(delay) {
  if (printWcId == null) return;
  previewPages = 0;   // 设置变了，旧页数立刻作废，别让它挂在信息栏上误导
  renderPreviewMeta();
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPrintPreview, delay == null ? PRINT_PREVIEW_DELAY : delay);
}

/**
 * 预览的载体。
 *
 * 真实运行时是 `<webview plugins>` —— Electron 自带的 PDF 阅读器本身是个插件，
 * 少了 plugins 属性 Chromium 只会把 PDF 当下载，预览区就永远白着。
 * UI 预览模式（普通浏览器里打开外壳）没有 `<webview>` 这个东西，换成 iframe：
 * 那种模式下装的是同构的占位纸（见 bridge-mock 的 page.printPreview），iframe
 * 够用，而且它与外壳同进程合成，隐藏窗口截图也能拍到。
 */
function previewHost() {
  let el = $('#print-preview');
  if (!el || !state.isPreview || el.tagName === 'IFRAME') return el;
  const f = document.createElement('iframe');
  f.id = 'print-preview';
  f.className = 'print-preview';
  f.setAttribute('title', '打印预览');
  if (el.parentNode) el.parentNode.replaceChild(f, el);
  return f;
}

async function refreshPrintPreview() {
  previewTimer = null;
  const wcId = printWcId;
  const mask = $('#print-preview-mask');
  if (wcId == null || !mask) return;
  // 正在出纸 / 导 PDF 时让一让：别把预览的排版任务排到真正的打印任务前面
  if (printBusy) { schedulePrintPreview(400); return; }

  const seq = ++previewSeq;
  mask.textContent = '正在生成预览…';
  mask.hidden = false;
  renderPreviewMeta();

  let r = null;
  try { r = await bridge.page.printPreview(wcId, collectPrintOptions({ withDevice: false })); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }

  // 期间又改了设置、或者面板已经关掉：这次结果作废
  if (seq !== previewSeq || printWcId !== wcId) return;

  if (r && r.ok && r.url) {
    previewPages = Number(r.pages) || 0;
    renderPreviewMeta();
    const pv = previewHost();
    // 按宽度铺满：#zoom=page-width 是 PDFium 阅读器认的地址参数。默认 100%
    // 时一张 210×9mm 的小票只占中间一小条，用户得眯着眼看；铺满宽度后
    // 「一页还是两页」一眼就能看出来。toolbar/navpanes 关掉，把地方留给纸。
    if (pv) pv.setAttribute('src', r.url + '#zoom=page-width&toolbar=0&navpanes=0');
    mask.hidden = true;
  } else {
    previewPages = 0;
    renderPreviewMeta();
    mask.textContent = (r && r.error) || '预览生成失败';
    mask.hidden = false;
  }
}

/** 清掉预览：关面板时调用，别让上一份 PDF 留在那儿占着文件 */
function resetPrintPreview() {
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
  previewSeq++;  // 让在飞的请求作废
  const pv = previewHost();
  if (pv) pv.removeAttribute('src');
  const mask = $('#print-preview-mask');
  if (mask) { mask.textContent = '正在生成预览…'; mask.hidden = false; }
  previewPages = 0;
  renderPreviewMeta();
}

/** 记住这套设置（不含页码范围：那是「这一次」的选择，不是长期偏好） */
function savePrintPrefs(o) {
  const pref = {
    pageSize: o.pageSize, customWidth: o.customWidth, customHeight: o.customHeight,
    landscape: o.landscape, marginType: o.marginType,
    marginTop: o.marginTop, marginBottom: o.marginBottom,
    marginLeft: o.marginLeft, marginRight: o.marginRight,
    scale: o.scale, copies: o.copies,
    printBackground: o.printBackground, headerFooter: o.headerFooter,
    deviceName: o.deviceName
  };
  try {
    Promise.resolve(bridge.settings.patch({ print: pref }))
      .then((s) => { if (s) state.settings = s; })
      .catch(() => { /* 预览模式：桥是空壳 */ });
  } catch { /* 同上 */ }
}

async function runPrint(silent) {
  if (printBusy || printWcId == null) return;
  const opts = collectPrintOptions();
  savePrintPrefs(opts);
  printBusy = true;
  setPrintBusy(true);
  let r = null;
  try {
    r = await bridge.page.print(printWcId, Object.assign({}, opts, { silent }));
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  } finally {
    printBusy = false;
    setPrintBusy(false);
  }
  if (r && r.ok) { closePrintDialog(); toast(silent ? '已发送到打印机' : '已发送打印任务'); return; }
  // 用户在系统窗口点了取消：不是错误，设置面板留着，改完可以直接再试
  if (r && r.canceled) return;
  toast((r && r.error) || '打印失败');
}

async function runPrintPdf() {
  if (printBusy || printWcId == null) return;
  const opts = collectPrintOptions();
  savePrintPrefs(opts);
  printBusy = true;
  setPrintBusy(true);
  let r = null;
  try {
    r = await bridge.page.savePdf(printWcId, opts);
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  } finally {
    printBusy = false;
    setPrintBusy(false);
  }
  if (r && r.ok) { closePrintDialog(); toast('已保存 PDF'); }
  else if (r && r.error) toast(r.error);
}

async function cmdSavePdfPage() {
  const t = activeTab();
  if (!t || !t.webview || t.webview.__bridge) { toast('当前内核不支持另存为 PDF'); return; }
  let id = t.wcId;
  if (id == null && typeof t.webview.getWebContentsId === 'function') {
    try { id = t.webview.getWebContentsId(); } catch { /* 还没就绪 */ }
  }
  const r = await bridge.page.savePdf(id);
  if (r && r.ok) toast('已保存 PDF');
  else if (r && r.error) toast(r.error);
}

/** 在「当前标签页」打开一个地址；没有标签页就新建一个。 */
function cmdOpenUrl(url) {
  const t = activeTab();
  if (t) navigate(t.id, url);
  else createTab(url, state.settings.defaultEngine);
}

/** 命令面板全部内置动作。部分文案带状态（书签 / 无图），所以每次打开都重新算。 */
function cmdBaseActions() {
  const actions = [
    { id: 'new-tab', label: '新建标签页', hint: 'Ctrl+T', icon: 'plus', run: () => createTab(newTabUrl(), state.settings.defaultEngine) },
    { id: 'new-tab-blank', label: '新建空白标签页', icon: 'plus', run: () => createTab('about:blank', state.settings.defaultEngine) },
    { id: 'settings', label: '打开设置', icon: 'gear', run: () => openPanel('general') },
    { id: 'home', label: '回到主页', icon: 'home', run: () => { const t = activeTab(); if (t) navigate(t.id, state.settings.homepage); } },
    { id: 'toggle-bookmark', label: bookmarkToggleLabel(), icon: 'star', run: () => toggleBookmarkCurrent() },
    { id: 'find', label: '页内查找', hint: 'Ctrl+F', icon: 'search', run: () => openFindBar() },
    { id: 'capture', label: '整页截图', icon: 'camera', run: () => cmdCapturePage() },
    { id: 'print', label: '打印当前页', hint: 'Ctrl+P', icon: 'pdf', run: () => openPrintDialog(activeTab()) },
    { id: 'pdf', label: '另存为 PDF', icon: 'pdf', run: () => cmdSavePdfPage() },
    { id: 'read', label: '阅读增强（无图 / 拼页）', icon: 'book', run: () => openReadSheet() },
    { id: 'mute', label: '静音 / 取消静音当前标签页', icon: 'mute', run: () => { const t = activeTab(); if (t) toggleTabMute(t.id); } },
    { id: 'copy-url', label: '复制当前网址', icon: 'link', run: async () => { const t = activeTab(); if (t) { await bridge.system.copy(t.url); toast('已复制当前网址'); } } },
    { id: 'open-dl-folder', label: '打开下载目录', icon: 'down', run: async () => { await bridge.downloads.showInFolder(state.downloadsDir || ''); } },
    { id: 'zoom-in', label: '放大页面', hint: 'Ctrl++', icon: 'plus', run: () => stepZoom(activeTab(), 1) },
    { id: 'zoom-out', label: '缩小页面', hint: 'Ctrl+-', icon: 'minus', run: () => stepZoom(activeTab(), -1) },
    { id: 'zoom-reset', label: '重置缩放', hint: 'Ctrl+0', icon: 'reset', run: () => setTabZoom(activeTab(), 1) },
    { id: 'close-tab', label: '关闭当前标签页', hint: 'Ctrl+W', icon: 'x', run: () => { if (state.activeId) closeTab(state.activeId); } },
    { id: 'clear-site-data', label: '清空站点数据', icon: 'lock', run: async () => { const r = await bridge.system.clearSiteData(); toast(r && r.note ? r.note : (r && r.cleared ? `已清空 ${r.cleared} 个分区` : '已清空站点数据')); } },
    { id: 'no-image', label: noImageLevel() === 'off' ? '无图模式：开启' : '无图模式：关闭', icon: 'eye', run: async () => { await applyNoImage(noImageLevel() === 'off' ? 'image' : 'off'); } }
  ];
  // 设置分区
  for (const s of ALL_PANELS) actions.push({ id: 'panel-' + s.id, label: '打开' + s.label, icon: (NAV_ICONS[s.icon] || CMD_ICON.gear), run: () => openPanel(s.id) });
  // 内核切换
  for (const e of (state.engines || [])) actions.push({ id: 'engine-' + e.id, label: `切换内核：${e.label}`, sub: e.modeLabel, icon: CMD_ICON.chip, run: () => { const t = activeTab(); if (t) switchEngine(t.id, e.id); } });
  return actions;
}

/**
 * 根据输入串组装命令面板结果。返回分组结构：[{ group, items:[{label,sub,icon,hint,run}] }]。
 * 空串时给「常用 + 已打开的标签页」；有串时跨 命令 / 标签页 / 书签 / 历史 匹配，
 * 最后补一个「打开网址 / 搜索」的最终兜底项。
 */
async function getCmdItems(query) {
  const q = (query || '').trim().toLowerCase();
  const actions = cmdBaseActions();

  const tabItems = (state.tabs || []).map((t) => ({
    group: '已打开的标签页', label: t.title || prettyUrl(t.url), sub: prettyUrl(t.url), icon: CMD_ICON.tab,
    run: () => activateTab(t.id)
  }));
  const bmItems = (state.bookmarks || []).map((b) => ({
    group: '书签', label: b.title || b.url, sub: b.url, icon: CMD_ICON.star,
    run: () => cmdOpenUrl(b.url)
  }));
  const histItems = (state.historyCache || []).map((h) => ({
    group: '历史记录', label: h.title || h.url, sub: h.url, icon: CMD_ICON.clock,
    run: () => cmdOpenUrl(h.url)
  }));

  const groups = [];
  if (!q) {
    const common = ['new-tab', 'settings', 'home', 'find', 'print', 'capture', 'pdf', 'toggle-bookmark', 'no-image'];
    groups.push({ group: '常用', items: actions.filter((a) => common.includes(a.id)) });
    groups.push({ group: '已打开的标签页', items: tabItems.slice(0, 8) });
    return groups;
  }

  const matchedActions = actions.filter((a) => (a.label || '').toLowerCase().includes(q) || (a.hint || '').toLowerCase().includes(q));
  if (matchedActions.length) groups.push({ group: '命令', items: matchedActions });

  const hit = (i) => ((i.label + ' ' + (i.sub || '')).toLowerCase().includes(q));
  const tabHit = tabItems.filter(hit);
  if (tabHit.length) groups.push({ group: '已打开的标签页', items: tabHit.slice(0, 8) });
  const bmHit = bmItems.filter(hit);
  if (bmHit.length) groups.push({ group: '书签', items: bmHit.slice(0, 8) });
  const histHit = histItems.filter(hit);
  if (histHit.length) groups.push({ group: '历史记录', items: histHit.slice(0, 8) });

  const resolved = resolveInput(query);
  if (resolved) {
    const isSearch = resolved === searchUrl(query);
    groups.push({
      group: isSearch ? '搜索' : '网址',
      items: [{
        label: isSearch ? `用默认引擎搜索：${query}` : `打开 ${resolved}`,
        sub: isSearch ? searchUrl(query) : resolved,
        icon: isSearch ? CMD_ICON.search : CMD_ICON.globe,
        run: () => cmdOpenUrl(resolved)
      }]
    });
  }
  return groups;
}

let cmdSel = 0;
let cmdItemsFlat = [];

/** 把分组结果渲染进列表，并维护扁平序号 cmdItems 供键盘/点击执行。 */
async function renderCmdList(query) {
  const groups = await getCmdItems(query);
  const list = $('#cmd-list');
  if (!list) return;
  cmdItemsFlat = [];
  if (!groups.length || !groups.some((g) => g.items && g.items.length)) {
    list.innerHTML = '<div class="cmd-empty">没有匹配的结果</div>';
    cmdSel = -1;
    return;
  }
  let html = '';
  let idx = 0;
  for (const g of groups) {
    if (!g.items || !g.items.length) continue;
    html += `<div class="cmd-group">${esc(g.group)}</div>`;
    for (const it of g.items) {
      const i = idx++;
      cmdItemsFlat.push(it);
      const sel = i === cmdSel ? ' is-sel' : '';
      const ico = it.icon ? `<svg viewBox="0 0 20 20">${it.icon}</svg>` : '';
      html += `<div class="cmd-row${sel}" data-cmd="${i}">
        <span class="cmd-ico">${ico}</span>
        <span class="cmd-main"><span class="cmd-title">${esc(it.label)}</span>${it.sub ? `<span class="cmd-sub">${esc(it.sub)}</span>` : ''}</span>
        ${it.hint ? `<span class="cmd-hint">${esc(it.hint)}</span>` : ''}
      </div>`;
    }
  }
  list.innerHTML = html;
  if (cmdSel >= cmdItemsFlat.length) cmdSel = cmdItemsFlat.length - 1;
  if (cmdSel < 0) cmdSel = 0;
  paintCmdSel();
  list.querySelectorAll('.cmd-row').forEach((r) => {
    const i = Number(r.dataset.cmd);
    r.addEventListener('mousemove', () => { cmdSel = i; paintCmdSel(); });
    r.addEventListener('click', () => runCmdItem(i));
  });
}

function paintCmdSel() {
  const list = $('#cmd-list');
  if (!list) return;
  const rows = [...list.querySelectorAll('.cmd-row')];
  rows.forEach((r, i) => r.classList.toggle('is-sel', i === cmdSel));
  const sel = rows[cmdSel];
  if (sel && typeof sel.scrollIntoView === 'function') sel.scrollIntoView({ block: 'nearest' });
}

function runCmdItem(idx) {
  const it = cmdItemsFlat[idx];
  if (!it) return;
  closeCmdPalette();
  try { it.run(); } catch (e) { console.error('[cmd] run failed', e); }
}

function openCmdPalette() {
  const inp = $('#cmd-input');
  if (!inp) return;
  cmdSel = 0;
  $('#cmd-palette').hidden = false;
  // 历史缓存可能还没拉过，先确保有，再渲染（失败就静默退回到书签/标签页）。
  ensureHistoryCache(false).then(() => { if (!$('#cmd-palette').hidden) renderCmdList(inp.value); });
  renderCmdList('');
  inp.focus();
  if (inp.select) inp.select();
}

function closeCmdPalette() {
  const el = $('#cmd-palette');
  if (el) el.hidden = true;
}

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
  positionAiPanel();
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

/** 小窗贴着工具栏的 AI 按钮弹出；高度由 CSS 的 auto + 上限决定，这里只给定位与最大高度。 */
function positionAiPanel() {
  const panel = $('#ai-panel');
  const btn = $('#btn-ai');
  if (!panel || !btn) return;
  // 最大化时不动定位（那套几何由 .ai-panel.is-max 接管），否则 resize 会把最大态冲掉
  if (panel.classList.contains('is-max')) return;
  const r = btn.getBoundingClientRect();
  const top = Math.round(r.bottom + 8);
  panel.style.top = top + 'px';
  panel.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
  panel.style.maxHeight = Math.max(240, Math.min(520, window.innerHeight - top - 12)) + 'px';
}

/**
 * 最大化 / 还原 AI 窗口。
 *
 * **只改尺寸，不重建 webview / 不重载当前页** —— 这正是「当前画面不丢失」的关键：
 * 用一个 class 切换几何布局，内部那个正在看的 AI 对话页、聊到一半的内容都原样留着。
 * 最大化时把 positionAiPanel 写下的内联 top/right/maxHeight 清掉，好让 .is-max 的
 * inset 布局生效；还原时再按 AI 按钮重新定位一次。
 */
function toggleAiMax() {
  const panel = $('#ai-panel');
  const btn = $('#ai-max');
  if (!panel) return;
  const max = panel.classList.toggle('is-max');
  if (max) {
    panel.style.top = '';
    panel.style.right = '';
    panel.style.maxHeight = '';
  } else {
    positionAiPanel();
  }
  if (btn) btn.title = max ? '还原' : '最大化';
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
  positionUpdatePanel();
  panel.hidden = false;
  panel.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
}

/** 小窗贴着顶栏的更新按钮弹出；高度由内容决定，这里只给 top/right 与最大高度。 */
function positionUpdatePanel() {
  const panel = $('#update-panel');
  const btn = $('#btn-update');
  if (!panel || !btn) return;
  const r = btn.getBoundingClientRect();
  const top = Math.round(r.bottom + 8);
  panel.style.top = top + 'px';
  panel.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
  panel.style.maxHeight = Math.max(220, Math.min(560, window.innerHeight - top - 12)) + 'px';
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

  // 网页模式的对话页面**自带输入框**，底栏再摆一个就成了「两个文本框」。
  // 网页模式下把底栏那套（textarea + 发送/清空）收起，只留「带入当前页」，
  // 由它直接把内容注入页面输入框；API 模式没有页面输入，才需要这套。
  const ta = $('#ai-text');
  const acts = $('#ai-actions');
  if (ta) ta.hidden = !api;
  if (acts) acts.hidden = !api;
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

  // 网页模式：直接注进页面自己的输入框（底栏那个已被 applyAiMode 收起）
  if (!aiIsApiMode()) {
    openAiPanel();
    const r = await aiInject(text.trim());
    if (r === 'ok') { toast('已带入 AI 对话框'); return; }
    // 页面还没就绪 / 找不到输入框：退回复制，别让用户以为没反应
    try { await bridge.system.copy(text.trim()); } catch { /* 复制失败也不致命 */ }
    toast('已复制，粘贴到对话框即可');
    return;
  }

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
  // 标签页搜索：输入即筛，Enter 跳第一个匹配，Esc 先清词再关
  $('#tg-search').addEventListener('input', (ev) => {
    state.tabQuery = ev.target.value || '';
    renderTabGrid();
  });
  $('#tg-search').addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if ((state.tabQuery || '').trim()) { state.tabQuery = ''; ev.target.value = ''; renderTabGrid(); }
      else closeTabGrid();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const q = (state.tabQuery || '').trim().toLowerCase();
      const hit = q
        ? state.tabs.find((t) => (t.title + ' ' + t.url).toLowerCase().includes(q))
        : state.tabs[0];
      if (hit) { activateTab(hit.id); closeTabGrid(); }
    }
  });
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
  // 点外面收起分享面板：用 mousedown 捕获阶段，点网页区域也能抢到；
  // 落点在地址栏 / 面板内则不收（点地址栏本身是「打开面板」）。
  document.addEventListener('mousedown', (ev) => {
    const t = ev.target;
    if (t && typeof t.closest === 'function'
        && (t.closest('#omnibox') || t.closest('#omni-share'))) return;
    closeOmniShare();
  }, true);

  // 地址栏
  const input = $('#omni-input');
  if (state.omniSel == null) state.omniSel = -1;
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      const list = state.omniSugg || [];
      if (list.length) { ev.preventDefault(); state.omniSel = Math.min(state.omniSel + 1, list.length - 1); paintOmniSel(); }
      return;
    }
    if (ev.key === 'ArrowUp') {
      const list = state.omniSugg || [];
      if (list.length) { ev.preventDefault(); state.omniSel = Math.max(state.omniSel - 1, -1); paintOmniSel(); }
      return;
    }
    if (ev.key === 'Enter') {
      // 有高亮的建议就进那一条，否则按普通解析（地址/搜索词）
      if (state.omniSel >= 0 && (state.omniSugg || [])[state.omniSel]) { ev.preventDefault(); pickOmniSuggest(state.omniSel); return; }
      const url = resolveInput(input.value);
      const t = activeTab();
      if (url && t) navigate(t.id, url);
      hideOmniSuggest();
      input.blur();
    } else if (ev.key === 'Escape') {
      if ($('#omni-suggest') && !$('#omni-suggest').hidden) { hideOmniSuggest(); return; }
      syncOmnibox();
      input.blur();
    }
  });
  input.addEventListener('focus', () => { input.select(); ensureHistoryCache(true); });
  // 点网址（地址栏还没聚焦时的那次点击）→ 弹分享面板；已在编辑态不弹。
  input.addEventListener('mousedown', () => { if (document.activeElement !== input) openOmniShare(); });
  // 打字 → 收起分享面板、显示自动补齐（收藏 + 历史）
  input.addEventListener('input', () => { closeOmniShare(); renderOmniSuggest(); });
  // 失焦收起建议；点建议行用的是 mousedown+preventDefault，不会先触发这里
  input.addEventListener('blur', hideOmniSuggest);
  // 点建议行 → 跳转（mousedown 抢在 blur 前，避免点了却先失焦收起）
  const sugEl = $('#omni-suggest');
  if (sugEl) {
    sugEl.addEventListener('mousedown', (ev) => {
      const row = ev.target && ev.target.closest && ev.target.closest('[data-idx]');
      if (!row) return;
      ev.preventDefault();
      pickOmniSuggest(Number(row.dataset.idx));
    });
  }

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

  // 「更多」：栏里放不下时出现，点开列出全部书签
  $('#bm-more') && $('#bm-more').addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleBmMenu();
  });
  $('#bm-menu') && $('#bm-menu').addEventListener('click', () => closeBmMenu());
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t && typeof t.closest === 'function' && t.closest('#bm-more')) return;
    closeBmMenu();
  });
  // 窗口变宽变窄会改变「放不放得下」，重算一次（防抖，避免拖拽时狂算）
  let bmResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(bmResizeTimer);
    bmResizeTimer = setTimeout(updateBmOverflow, 120);
  });

  // 工具栏
  $('#omni-engine').addEventListener('click', (ev) => { ev.stopPropagation(); toggleEngineMenu(); });
  $('#engine-menu').addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('click', closeEngineMenu);

  $('#btn-shield').addEventListener('click', () => openPanel('adblock'));
  $('#btn-sniff').addEventListener('click', () => toggleSniffPopover());

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

  // 媒体嗅探小窗：点外面 / 点网页 / 改窗口尺寸都收起
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t && typeof t.closest === 'function'
        && (t.closest('#sniff-pop') || t.closest('#btn-sniff'))) return;
    closeSniffPopover();
  });
  window.addEventListener('resize', closeSniffPopover);
  $('#sniff-pop-close').addEventListener('click', closeSniffPopover);
  $('#sniff-pop-manage').addEventListener('click', () => {
    closeSniffPopover();
    openPanel('sniffer');
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
  $('#ai-max').addEventListener('click', toggleAiMax);
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
    // 「隐身」预处理：DeepSeek 等站点的风控会把内嵌浏览器判成「使用环境异常」，
    // 在对方脚本之前抹平几个最常查的自动化特征（尽力而为，仍可能被拦）
    try { aiWv.setAttribute('preload', new URL('./ai-stealth.js', location.href).href); }
    catch { /* 预览等环境下拿不到绝对路径就算了 */ }
    // UA 属性：主进程的 onBeforeSendHeaders 只改请求头，改不到页面 JS 里读的
    // navigator.userAgent —— 默认串带着 Electron/x.y.z 令牌，DeepSeek 等风控
    // 在脚本里一查一个准，直接判「环境异常」拒渲染。webview 的 useragent 属性
    // 是内核级覆盖：请求头和 navigator.userAgent 一起换成干净 Chrome 串
    //（标签页的 webview 也是这么设的，见 mountTab）。
    try {
      const eng = engine('chromium');
      if (eng && eng.userAgent) aiWv.setAttribute('useragent', eng.userAgent);
    } catch { /* 预览模式下没有引擎清单，跳过 */ }
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
    // 网页模式打不开（被风控拦 / 断网）→ 指条明路：改用 API 模式
    aiWv.addEventListener('did-fail-load', (ev) => {
      if (ev.errorCode === -3) return;          // ERR_ABORTED，主动取消不算
      if (ev.isMainFrame === false) return;
      toast('这个 AI 站点没能打开（可能屏蔽内嵌浏览器），可在下方改用「API 模式」');
    });
    // 窗口尺寸变了，开着的 AI 小窗重新贴回按钮下
    window.addEventListener('resize', () => {
      const p = $('#ai-panel');
      if (p && p.classList.contains('is-open')) positionAiPanel();
    });
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
    if (btn) btn.addEventListener('click', () => {
      const p = $('#update-panel');
      if (p && p.classList.contains('is-open')) closeUpdatePanel();
      else openUpdatePanel();
    });
    const panel = $('#update-panel');
    if (panel) $('#update-close').addEventListener('click', closeUpdatePanel);
    // 小窗：点外面收起（点在面板内或更新按钮上不算）
    document.addEventListener('click', (ev) => {
      const p = $('#update-panel');
      if (!p || !p.classList.contains('is-open')) return;
      const t = ev.target;
      if (t && typeof t.closest === 'function' && (t.closest('#update-panel') || t.closest('#btn-update'))) return;
      closeUpdatePanel();
    });
    // 窗口尺寸变了，开着的小窗要重新贴回按钮下面
    window.addEventListener('resize', () => {
      const p = $('#update-panel');
      if (p && p.classList.contains('is-open')) positionUpdatePanel();
    });

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
    const crashed = !!(t.loadError && t.loadError.code === 'crash');
    t.loadError = null;
    t.crashed = false;
    renderPageError();
    // 渲染进程已经没了，reload() 对它是无效的 —— 必须重建渲染载体
    if (crashed) {
      t.crashCount = 0; // 用户主动重试，重新给一次自动恢复的机会
      remountTab(t);
      return;
    }
    if (t.webview && typeof t.webview.reload === 'function') t.webview.reload();
    else navigate(t.id, t.url);
  });
  // 页内查找：输入即查，Enter 下一个、Shift+Enter 上一个
  $('#find-input') && $('#find-input').addEventListener('input', () => runFind(true));
  $('#find-input') && $('#find-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); runFind(!ev.shiftKey); }
    else if (ev.key === 'Escape') { ev.preventDefault(); closeFindBar(); }
  });
  $('#find-next') && $('#find-next').addEventListener('click', () => runFind(true));
  $('#find-prev') && $('#find-prev').addEventListener('click', () => runFind(false));
  $('#find-close') && $('#find-close').addEventListener('click', closeFindBar);

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

  // 打印设置：分段控件与开关走委托，避免给每个按钮各挂一条。
  // 每一条都要顺手排一次预览 —— 「改一项，右边立刻变」是这一屏的全部意义。
  const printView = $('#print-view');
  printView.addEventListener('click', (ev) => {
    if (ev.target === printView) { closePrintDialog(); return; }
    const orient = ev.target.closest('[data-orient]');
    if (orient) { setPrintSeg('#print-orient', 'orient', orient.dataset.orient); schedulePrintPreview(); return; }
    const margin = ev.target.closest('[data-margin]');
    if (margin) { setPrintSeg('#print-margins', 'margin', margin.dataset.margin); syncPrintCustom(); schedulePrintPreview(); return; }
    if (ev.target.closest('#print-bg')) { $('#print-bg').classList.toggle('is-on'); schedulePrintPreview(); return; }
    if (ev.target.closest('#print-hf')) { $('#print-hf').classList.toggle('is-on'); schedulePrintPreview(); return; }
  });
  $('#print-paper').addEventListener('change', () => { syncPrintCustom(); schedulePrintPreview(); });
  // 数字框：input 在打字与点微调箭头时都会来，节流交给 schedulePrintPreview。
  // 份数不列进来 —— 它只影响出纸张数，跟排版一点关系都没有。
  ['#print-paper-w', '#print-paper-h', '#print-mt', '#print-mb', '#print-ml', '#print-mr', '#print-scale', '#print-range']
    .forEach((sel) => { const el = $(sel); if (el) el.addEventListener('input', () => schedulePrintPreview()); });
  $('#print-close').addEventListener('click', closePrintDialog);
  $('#print-cancel').addEventListener('click', closePrintDialog);
  $('#print-go').addEventListener('click', () => runPrint(false));
  $('#print-direct').addEventListener('click', () => runPrint(true));
  $('#print-pdf').addEventListener('click', runPrintPdf);
  $('#print-refresh').addEventListener('click', () => refreshPrinters($('#print-printer').value));

  // 保存密码气泡
  const pwdSave = $('#pwd-save');
  if (pwdSave) pwdSave.addEventListener('click', commitPwdPrompt);
  const pwdNever = $('#pwd-never');
  if (pwdNever) pwdNever.addEventListener('click', hidePwdPrompt);
  const pwdNeverSite = $('#pwd-never-site');
  if (pwdNeverSite) pwdNeverSite.addEventListener('click', mutePwdPromptForSite);

  // 快捷键
  window.addEventListener('keydown', (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === 't') { ev.preventDefault(); createTab(newTabUrl(), state.settings.defaultEngine); }
    else if (mod && ev.key.toLowerCase() === 'w') { ev.preventDefault(); if (state.activeId) closeTab(state.activeId); }
    else if (mod && ev.key.toLowerCase() === 'l') { ev.preventDefault(); $('#omni-input').focus(); }
    else if (mod && ev.key.toLowerCase() === 'f') { ev.preventDefault(); openFindBar(); }
    else if (mod && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'p') { ev.preventDefault(); openPrintDialog(activeTab()); }
    else if (mod && (ev.key === '=' || ev.key === '+')) { ev.preventDefault(); stepZoom(activeTab(), 1); }
    else if (mod && ev.key === '-') { ev.preventDefault(); stepZoom(activeTab(), -1); }
    else if (mod && ev.key === '0') { ev.preventDefault(); setTabZoom(activeTab(), 1); }
    else if (mod && ev.shiftKey && ev.key.toLowerCase() === 'a') { ev.preventDefault(); openPanel('adblock'); }
    else if (mod && ev.key.toLowerCase() === 'k') { ev.preventDefault(); openCmdPalette(); }
    else if (ev.key === 'F5') { ev.preventDefault(); $('#nav-reload').click(); }
    else if (ev.altKey && ev.key === 'ArrowLeft') { ev.preventDefault(); $('#nav-back').click(); }
    else if (ev.altKey && !ev.ctrlKey && ev.key.toLowerCase() === 'q') { ev.preventDefault(); openTabGrid(); }
    else if (ev.altKey && ev.key === 'ArrowRight') { ev.preventDefault(); $('#nav-forward').click(); }
    else if (ev.key === 'Escape') { closeEngineMenu(); closeToolsMenu(); closeDrawer(); closeAiPanel(); closeExtUiPanel(); closeOmniShare(); closeFindBar(); closeSniffPopover(); closeUpdatePanel(); closeExtPopover(); closeTabGrid(); closeSheet(); closeReadSheet(); closePrintDialog(); hidePwdPrompt(); closeSettings(); closeCmdPalette(); }
    else if (mod && ev.key === 'Tab') {
      ev.preventDefault();
      if (state.tabs.length < 2) return;
      const idx = state.tabs.findIndex((t) => t.id === state.activeId);
      const next = state.tabs[(idx + (ev.shiftKey ? -1 + state.tabs.length : 1)) % state.tabs.length];
      activateTab(next.id);
    }
  });

  wireQuickBar();
  wireCmdPalette();
  wireToolsMenu();
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

  // 渲染进程退出（主进程 render-process-gone）：带 reason，比 DOM 的 crashed 更具体。
  // 主进程按 webContents.id 发过来，这里用 tab.wcId 反查是哪一页。
  bridge.on('tab:crashed', (p) => {
    if (!p || p.id == null) return;
    const t = state.tabs.find((x) => x.wcId === p.id);
    if (!t) return;
    handleTabCrash(t, p.reason || '');
  });

  // 主进程发来的轻提示（例如 ed2k 链接没有客户端可用、已复制到剪贴板）
  bridge.on('app:toast', (m) => toast(String(m || '')));

  // 音频状态（主进程 isCurrentlyAudible 查询后发来）
  bridge.on('tab:audio', (p) => {
    if (!p || p.id == null) return;
    const t = state.tabs.find((x) => x.wcId === p.id);
    if (!t) return;
    t.audible = !!p.audible;
    renderTabstrip();
  });

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
  // 原生右键菜单的两条动作：搜索选中文字 / 在新标签页打开链接（都开新标签）
  bridge.on('webview:search', (text) => {
    const q = String(text || '').trim();
    if (q) createTab(searchUrl(q), activeTab() ? activeTab().engineId : state.settings.defaultEngine);
  });
  bridge.on('webview:open-url', (url) => {
    if (url) createTab(url, activeTab() ? activeTab().engineId : state.settings.defaultEngine);
  });
  bridge.on('shell:viewport', applyLayout);
  // 内核桥接：原生宿主推来的事件（frame/title/url/cursor）。compat 内核不会发。
  bridge.on('host:event', onHostEvent);

  // 站点权限询问：主进程 setPermissionRequestHandler 遇到「询问」规则（或没有规则）时，
  // 把请求推过来，这里弹一条带「允许 / 禁止」的提示条等用户点（见 showPermissionRequest）。
  // 用户点了就回主进程（bridge.permissions.resolve），解除挂起的回调。
  bridge.on('permission:request', (p) => showPermissionRequest(p));

  // 主进程抓到一份新图标。重读一次那张表（同名主机也要重读 —— 内容变了）。
  // 这条推送是必须的：图标是异步到的，不推的话书签格会一直停在首字母上，
  // 直到用户下一次动书签才碰巧重画一次。
  bridge.on('favicon:updated', () => {
    refreshHostIcons(true);
    // 标签页同理：刚打开一个没有图标的站点时，图标要等这次推送才到
    for (const t of state.tabs) {
      const cur = t.favicon || '';
      if (cur.indexOf('data:') === 0) continue;
      resolveTabFavicon(t);
    }
  });

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
  state.credentials = [];
  bridge.credentials.list().then((list) => { state.credentials = Array.isArray(list) ? list : []; }).catch(() => {});
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
