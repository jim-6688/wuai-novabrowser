'use strict';

/**
 * 站点权限管理（主进程侧）。
 *
 * 三类权限走不同入口，但「查规则 -> 决定 允许/禁止/询问」这一层是共用的：
 *
 *   - 会话级权限（位置 / 通知 / 摄像头 / 麦克风 / 全屏 / 指针锁定 / 本地网络）
 *     由 session.setPermissionRequestHandler 与 setPermissionCheckHandler 接管。
 *   - 弹窗（window.open / target=_blank 的额外窗口）
 *     由 webContents.setWindowOpenHandler 接管（见 main.js 的 wireContents）。
 *
 * 规则按「精确主机 -> 逐级父域」匹配，与按站点切换内核（siteEngines）同口径。
 * 每条规则形如：
 *   { host: 'example.com',
 *     rules: { geolocation:'block', notifications:'ask', camera:'allow', … } }
 * 取值：'allow' 允许 / 'block' 禁止 / 'ask'（或缺失）询问 —— 询问在会话内记住一次。
 *
 * 主进程只负责「决定」，把可测的纯函数（matchHostRule / normalizePermission /
 * decide / decideMedia / decidePopup / decideLocalNetwork）与 IPC 问答分开，
 * 便于在 Node 里直接跑单测。
 *
 * -------------------------------------------------------------------
 * 本地网络访问（LNA，Chromium 142+）
 * -------------------------------------------------------------------
 * 公网页面去连本机 / 内网地址需要这一权限。微信、QQ 的「快捷登录」访问的是
 * 本机客户端监听的 localhost 端口（如 localhost.weixin.qq.com:14013），
 * Chromium 判定为「公网 -> 环回」后会拦下它。Chromium 把它拆成三个名字：
 * 旧名 local-network-access、拆分后的 local-network（局域网）与
 * loopback-network（127.0.0.1 / localhost）。用户不必分辨，统一归到
 * localNetwork 一类规则里。
 *
 * 与别的权限不同，check 一侧对「询问」不能返回 undefined：Electron 没有
 * Chromium 内置的权限提示界面，同步 check 落到浏览器默认就是「拒绝」，
 * 网页据此显示「您的浏览器已屏蔽了本地网络访问权限」。详见
 * installPermissionHandlers 里的说明。
 */

const hostOf = (u) => {
  if (!u) return '';
  try { return new URL(u).hostname; } catch { return ''; }
};

/** 权限名 -> 我们管理的分类。'media' 是合并项，在 handler 里单独拆摄像头/麦克风。 */
function normalizePermission(permission, details) {
  switch (permission) {
    case 'geolocation': return 'geolocation';
    case 'notifications': return 'notifications';
    case 'fullscreen': return 'fullscreen';
    case 'pointerLock': return 'pointerLock';
    case 'media': return 'media';
    case 'midiSysex': return 'midiSysex';
    case 'openExternal': return 'openExternal';
    // Chromium 142+ Local Network Access：旧名 + 拆分后的两个粒度，同类处理。
    case 'local-network':
    case 'local-network-access':
    case 'loopback-network': return 'localNetwork';
    default: return null;
  }
}

/** 精确主机 -> 逐级父域：写 example.com 也命中 www.example.com。与 siteEngines 同算法。 */
function matchHostRule(permissions, host) {
  if (!host || !Array.isArray(permissions)) return null;
  const h = host.toLowerCase();
  for (const rule of permissions) {
    if (rule && rule.host && rule.host.toLowerCase() === h) return rule;
  }
  const parts = h.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    for (const rule of permissions) {
      if (rule && rule.host && rule.host.toLowerCase() === parent) return rule;
    }
  }
  return null;
}

/** 单个分类的决定：allow / block / ask（缺失或显式 ask 都算询问）。 */
function decide(permissions, sessionChoices, host, category) {
  const rule = matchHostRule(permissions, host);
  const v = rule && rule.rules && rule.rules[category];
  if (v === 'allow') return 'allow';
  if (v === 'block') return 'block';
  // 询问：会话内已记住的选择直接复用，否则回落到 ask
  const sc = sessionChoices && sessionChoices.get(host + ' ' + category);
  if (typeof sc === 'boolean') return sc ? 'allow' : 'block';
  return 'ask';
}

/** 媒体请求可能是摄像头、麦克风、或两者同时。两者任一被禁则禁；任一询问则问。 */
function decideMedia(permissions, sessionChoices, host) {
  const cam = decide(permissions, sessionChoices, host, 'camera');
  const mic = decide(permissions, sessionChoices, host, 'microphone');
  if (cam === 'block' || mic === 'block') return 'block';
  if (cam === 'ask' || mic === 'ask') return 'ask';
  return 'allow';
}

/** 弹窗：allow / block / ask（询问回落到允许，避免误伤正常的新标签打开）。 */
function decidePopup(permissions, sessionChoices, host) {
  const r = decide(permissions, sessionChoices, host, 'popups');
  return r === 'block' ? 'block' : 'allow';
}

/**
 * 本地网络访问：全局档位优先，'ask' 才落到按站点规则。
 *
 * mode 来自设置的 localNetworkAccess：'ask'（默认，按站点规则走）/ 'allow'
 * （所有站点都允许，不再询问）/ 'block'（所有站点都禁止）。抽成纯函数是为了
 * 单测能覆盖；运行时接线只负责把设置里的档位读进来传给我们。
 */
function decideLocalNetwork(permissions, sessionChoices, host, mode) {
  if (mode === 'allow') return 'allow';
  if (mode === 'block') return 'block';
  return decide(permissions, sessionChoices, host, 'localNetwork');
}

const CATEGORY_LABEL = {
  geolocation: '位置信息',
  notifications: '通知',
  camera: '摄像头',
  microphone: '麦克风',
  media: '摄像头和麦克风',
  fullscreen: '全屏',
  pointerLock: '指针锁定',
  popups: '弹出窗口',
  midiSysex: 'MIDI 设备',
  openExternal: '打开外部程序',
  localNetwork: '本地网络访问'
};

// ---- 以下为运行时状态（仅在 Electron 主进程内使用，不进入单测） ----

let getMainWindowRef = () => null;
let getPermissionsRef = () => [];
let getLocalNetworkModeRef = () => 'ask';
const sessionChoices = new Map(); // host + ' ' + category -> boolean（会话内记住的询问选择）
const pending = new Map(); // requestId -> { resolve, timer }
let reqSeq = 0;

function configure({ getMainWindow, getPermissions, getLocalNetworkMode }) {
  getMainWindowRef = getMainWindow || getMainWindowRef;
  getPermissionsRef = getPermissions || getPermissionsRef;
  getLocalNetworkModeRef = getLocalNetworkMode || getLocalNetworkModeRef;
}

/** 渲染层回话权限询问的结果，解除挂起的回调并记住选择。 */
function resolvePending(requestId, allow) {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  if (p.timer) clearTimeout(p.timer);
  p.resolve(!!allow);
}

/**
 * 把一次「询问」转成渲染层弹出的权限条，返回是否允许。
 * 找不到目标渲染层、或 60s 内没回应（窗口已销毁等），按拒绝兜底，避免回调永远挂起。
 */
function askPermission(category, host, wc) {
  return new Promise((resolve) => {
    const requestId = ++reqSeq;
    const target = (wc && wc.hostWebContents) || (() => { const w = getMainWindowRef(); return w && !w.isDestroyed() ? w.webContents : null; })();
    if (!target) { resolve(false); return; }
    const timer = setTimeout(() => {
      if (pending.has(requestId)) { pending.delete(requestId); resolve(false); }
    }, 60000);
    pending.set(requestId, { resolve, timer });
    target.send('permission:request', {
      requestId,
      category,
      label: CATEGORY_LABEL[category] || category,
      host
    });
  });
}

function finish(action, category, host, wc, callback) {
  if (action === 'allow') return void callback(true);
  if (action === 'block') return void callback(false);
  askPermission(category, host, wc)
    .then((allow) => { sessionChoices.set(host + ' ' + category, allow); callback(allow); })
    .catch(() => callback(false));
}

/** 在指定会话上安装权限处理器。多个会话（defaultSession + persist:nova-chromium）各装一次。 */
function installPermissionHandlers(session) {
  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    const host = hostOf(details && details.requestingUrl) || (wc && typeof wc.getURL === 'function' ? wc.getURL() : '') || '';
    const cat = normalizePermission(permission, details);
    if (cat === null) { callback(true); return; } // 未知权限类型：放行，不当成拦截
    if (cat === 'media') {
      finish(decideMedia(getPermissionsRef(), sessionChoices, host), 'media', host, wc, callback);
      return;
    }
    if (cat === 'localNetwork') {
      finish(decideLocalNetwork(getPermissionsRef(), sessionChoices, host, getLocalNetworkModeRef()),
        'localNetwork', host, wc, callback);
      return;
    }
    finish(decide(getPermissionsRef(), sessionChoices, host, cat), cat, host, wc, callback);
  });

  session.setPermissionCheckHandler((wc, permission, requestingUrl) => {
    const host = hostOf(requestingUrl) || (wc && typeof wc.getURL === 'function' ? wc.getURL() : '') || '';
    const cat = normalizePermission(permission);
    if (cat === null) return undefined;

    // 本地网络访问要单独处理：它是网络层的**同步** check（navigator.permissions.query
    // 与发起请求时的地址空间判定），不像 request handler 那样能挂起等用户点授权条。
    // Electron 没有 Chromium 内置的权限提示界面，这里若返回 undefined 落到浏览器默认
    // 就是「拒绝」—— 网页正是据此显示「您的浏览器已屏蔽了本地网络访问权限」。
    // 所以只有显式禁止才返回 false；「询问」也放行，让请求能真正发出去。
    // 这不是无条件放开：用户在权限条里点「禁止」会写进 sessionChoices，下一次
    // decide 就变成 block；设置里也能把全局档位调成「始终禁止」或按站点加规则。
    if (cat === 'localNetwork') {
      return decideLocalNetwork(getPermissionsRef(), sessionChoices, host, getLocalNetworkModeRef()) !== 'block';
    }

    let action;
    if (cat === 'media') action = decideMedia(getPermissionsRef(), sessionChoices, host);
    else action = decide(getPermissionsRef(), sessionChoices, host, cat);
    if (action === 'allow') return true;
    if (action === 'block') return false;
    return undefined; // 询问：交给浏览器默认（通常是允许）
  });
}

/** 弹窗处理：在 wireContents 的 setWindowOpenHandler 里调用，先于「开新标签」逻辑。 */
function decidePopupOnOpen(permissions, host) {
  return decidePopup(permissions, sessionChoices, host);
}

module.exports = {
  hostOf,
  normalizePermission,
  matchHostRule,
  decide,
  decideMedia,
  decidePopup,
  decideLocalNetwork,
  configure,
  resolvePending,
  installPermissionHandlers,
  decidePopupOnOpen,
  CATEGORY_LABEL
};
