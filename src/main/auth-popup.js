'use strict';

/**
 * 第三方登录弹窗的识别与尺寸解析
 * ---------------------------------------------------------------------------
 * 为什么需要这一层：
 *
 * 站点上的「QQ 登录 / 微信登录」几乎都是 `window.open()` 开一个**真弹窗**，
 * 登录完成后靠 `window.opener.postMessage()` 把结果回传给打开它的页面，
 * 或者直接 `window.close()` 关掉自己。
 *
 * 而我们在 main.js 里对 window.open 的处理是「一律 deny + 让外壳开新标签页」——
 * 新标签页**没有 opener**，于是：扫码/授权在弹出页里明明成功了，原页面却
 * 永远等不到那次 postMessage，用户看到的就是「点了没反应 / 一直在转」。
 *
 * 所以这里要能区分「该开成真弹窗的」和「该开成标签页的」：
 *
 *   1. 登录/授权域名 → 一定是弹窗（哪怕站点没给尺寸）
 *   2. window.open 且显式带了宽高（或 popup=yes）→ 弹窗（OAuth 的常见写法）
 *   3. 其余（含 target=_blank 的普通链接）→ 走标签页，保持现在的行为
 *
 * 这里的函数都是纯函数，不碰 Electron，方便 tools/test-auth-popup.js 直接测。
 */

/**
 * 登录 / 授权类站点。
 *
 * 只列「作为弹出页出现、且必须保留 opener」的那些域名；按**后缀**匹配，
 * 所以写 `qq.com` 会连 `ptlogin2.qq.com`、`xui.ptlogin2.qq.com` 一起命中。
 * 宁可多列几个，也别让用户点了登录没反应 —— 这类弹窗一个月也弹不了几次，
 * 多放行一个域名的代价远小于「登录彻底不能用」。
 */
const AUTH_HOSTS = [
  // QQ / 腾讯
  'qq.com',
  'qqmail.com',
  'tencent.com',
  // 微信
  'weixin.qq.com',
  'wechat.com',
  // 其他国内常用第三方登录
  'weibo.com',
  'weibo.cn',
  'sina.com.cn',
  'baidu.com',
  'bdstatic.com',
  '163.com',
  '126.com',
  'taobao.com',
  'alipay.com',
  'aliyun.com',
  'dingtalk.com',
  'feishu.cn',
  'xiaomi.com',
  'huawei.com',
  'jd.com',
  // 国际
  'google.com',
  'googleusercontent.com',
  'gstatic.com',
  'microsoftonline.com',
  'live.com',
  'apple.com',
  'github.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'discord.com',
  'steampowered.com',
  'auth0.com',
  'okta.com',
  'cloudflareaccess.com'
];

/** 弹窗默认尺寸：没有显式给尺寸的登录页按这个开（够放下扫码框和授权按钮）。 */
const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 700;

/** 尺寸上下限：太小的弹窗扫不了码，太大的没意义。 */
const MIN_WIDTH = 320;
const MAX_WIDTH = 1400;
const MIN_HEIGHT = 240;
const MAX_HEIGHT = 1100;

/** 取主机名（小写，去掉端口）。非法 URL 返回空串。 */
function hostOf(url) {
  try {
    return String(new URL(String(url || '')).hostname).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 主机是否属于登录/授权域名。
 *
 * 按标签边界做后缀匹配：`qq.com` 命中 `ptlogin2.qq.com`，
 * 但**不**命中 `notqq.com`（那是另一个域名，不能因为结尾像就放行）。
 */
function isAuthHost(url) {
  const host = hostOf(url);
  if (!host) return false;
  return AUTH_HOSTS.some((base) => host === base || host.endsWith('.' + base));
}

/** 从 Electron 给的 features 串里抠出宽高。 */
function parseFeatures(features) {
  const out = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, sized: false, popup: false };
  const str = String(features || '');
  if (!str.trim()) return out;

  const num = (name) => {
    const m = new RegExp('(?:^|[,;\\s])' + name + '\\s*=\\s*(\\d+)', 'i').exec(str);
    return m ? parseInt(m[1], 10) : null;
  };

  const w = num('width') || num('innerWidth');
  const h = num('height') || num('innerHeight');
  if (w && w > 0) {
    out.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));
    out.sized = true;
  }
  if (h && h > 0) {
    out.height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, h));
    out.sized = true;
  }
  // 站点明确要求「这是个弹窗」（而不是标签页）
  if (/(?:^|[,;\s])popup\s*=\s*(?:yes|1|true)/i.test(str)) out.popup = true;
  return out;
}

/**
 * 这次 window.open 该怎么处理。
 *
 * @param {{url:string, disposition?:string, features?:string, allowAuthPopups?:boolean}} req
 * @returns {{popup:boolean, reason:string, width:number, height:number}}
 *   popup=true 时调用方应当**放行成真实子窗口**（保留 opener），
 *   否则维持「开成标签页」。
 */
function decide(req) {
  const r = req || {};
  const url = String(r.url || '');
  const disposition = String(r.disposition || '');
  const feat = parseFeatures(r.features);

  // 用户可以把「第三方登录弹窗」整体关掉，退回旧行为（开标签页）
  if (r.allowAuthPopups === false) {
    return { popup: false, reason: 'disabled', width: feat.width, height: feat.height };
  }

  // 只在真的「新开窗口」时才考虑弹窗；同标签导航不在此列
  const opensWindow = disposition === 'new-window' || disposition === 'foreground-tab' ||
    disposition === 'background-tab' || disposition === '';

  if (isAuthHost(url)) {
    // 登录域名：即便站点没给尺寸也开成弹窗（否则 opener 丢了，登录必然失败）
    return { popup: true, reason: 'auth-host', width: feat.width, height: feat.height };
  }

  if (opensWindow && disposition === 'new-window' && (feat.sized || feat.popup)) {
    return { popup: true, reason: 'sized-popup', width: feat.width, height: feat.height };
  }

  return { popup: false, reason: 'tab', width: feat.width, height: feat.height };
}

/**
 * 把 decide() 的结果翻成 Electron `overrideBrowserWindowOptions`。
 *
 * <p>抽出来是为了「跑的那份 = 测的那份」：main.js 和 tools/test-auth-popup-e2e.js
 * 都用这一个函数，否则 e2e 测的只是测试里另写一遍的参数。
 *
 * @param {{width:number,height:number}} decision decide() 的返回值
 * @param {{session?:object, parent?:object}} ctx  opener 的 session / 父窗口（可为 null）
 */
function windowOptions(decision, ctx) {
  const c = ctx || {};
  const opts = {
    width: (decision && decision.width) || DEFAULT_WIDTH,
    height: (decision && decision.height) || DEFAULT_HEIGHT,
    autoHideMenuBar: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  };
  // 与打开它的页面共用同一个 session：Cookie / 登录态必须对得上，
  // 否则授权回调那一跳回来是「未登录」，等于白登。
  if (c.session) opts.webPreferences.session = c.session;
  if (c.parent) opts.parent = c.parent;
  return opts;
}

module.exports = {
  AUTH_HOSTS,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  hostOf,
  isAuthHost,
  parseFeatures,
  decide,
  windowOptions
};
