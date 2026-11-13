'use strict';

/**
 * 新开内容的去向判定：标签页 / 真弹窗
 * ---------------------------------------------------------------------------
 * 为什么需要这一层：
 *
 * 站点上的「QQ 登录 / 微信登录」几乎都是 `window.open()` 开一个**真弹窗**，
 * 登录完成后靠 `window.opener.postMessage()` 把结果回传给打开它的页面，
 * 或者直接 `window.close()` 关掉自己。若按旧逻辑一律 deny + 让外壳开新标签页，
 * 新标签页没有 opener —— 扫码明明成功了，原页面永远等不到回调。
 *
 * 但反过来，「命中登录域名就一律弹窗」会闯更大的祸：白名单里曾写着整个
 * `baidu.com`，于是百度搜索结果的跳转链接 `www.baidu.com/link?url=…`
 * 也被当成登录页，点一条搜索结果弹出一个独立窗口（用户反馈：应该新页面显示）。
 * 同样被误伤的还有 taobao / jd / google / github 等整域白名单下的普通网页。
 *
 * 所以判定分成两件事，缺一不可：
 *
 *   ① **是不是普通网页导航** —— `<a target="_blank">` / Ctrl+点击 / 中键给出的
 *      disposition 是 foreground-tab / background-tab。这类一律开标签页，
 *      不管目标站点是谁：**网页链接不是窗口**。
 *   ② **有没有「窗口属性」** —— window.open 显式给了宽高、popup=yes，或
 *      toolbar=no / location=no 这类只有真窗口才会写的 chrome 参数；再或者
 *      目标本身就是明确的授权端点（登录专用子域 / OAuth 路径）。
 *      这些才放行成真子窗口，保留 opener 与同一个 session。
 *
 * 域名白名单因此收敛到「登录/授权专用子域」（`passport.baidu.com` 而不是
 * `baidu.com`）；把授权端点放在主域的提供方（`github.com/login/oauth/authorize`、
 * `discord.com/oauth2/authorize`）另列一张表，**必须同时命中授权路径**才算数。
 *
 * 这里的函数都是纯函数，不碰 Electron，方便 tools/test-auth-popup.js 直接测。
 */

/**
 * 登录 / 授权专用主机。
 *
 * 只列「整个主机就是登录/授权服务」的那些，按**标签边界后缀**匹配
 * （`ptlogin2.qq.com` 会连 `xui.ptlogin2.qq.com` 一起命中，但不会命中 `notqq.com`）。
 * 绝不写 `baidu.com` / `qq.com` / `github.com` 这类主域 —— 那上面的普通网页
 * 比登录页多得多，误伤一次就是「点搜索结果弹出一个窗口」。
 */
const AUTH_HOSTS = [
  // QQ / 腾讯
  'ptlogin2.qq.com',
  'ptlogin.qq.com',
  'graph.qq.com',
  'open.qq.com',
  'connect.qq.com',
  'passport.qq.com',
  // 微信
  'open.weixin.qq.com',
  'open.wechat.com',
  // 百度
  'passport.baidu.com',
  'openapi.baidu.com',
  // 微博 / 新浪
  'passport.weibo.com',
  'api.weibo.com',
  'login.sina.com.cn',
  // 阿里
  'login.taobao.com',
  'oauth.taobao.com',
  'login.alipay.com',
  'openauth.alipay.com',
  'account.aliyun.com',
  // 网易
  'login.163.com',
  'reg.163.com',
  'passport.126.com',
  // 京东 / 小米 / 华为
  'passport.jd.com',
  'login.jd.com',
  'account.xiaomi.com',
  'id.huawei.com',
  // 企业协作
  'passport.feishu.cn',
  'open.feishu.cn',
  'login.dingtalk.com',
  // 国际
  'accounts.google.com',
  'oauth2.googleapis.com',
  'login.live.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
  'login.steampowered.com',
  // 通用 IdP（租户子域，后缀匹配）
  'auth0.com',
  'okta.com',
  'cloudflareaccess.com'
];

/**
 * 把 OAuth 授权端点挂在**主域**上的提供方。
 *
 * 这些域上绝大多数请求都是普通网页，所以只有 URL 路径同时命中
 * {@link OAUTH_PATH_RE} 时才认作授权页（见 isAuthTarget）。
 * 例：`github.com/login/oauth/authorize` 算，`github.com/torvalds/linux` 不算。
 */
const OAUTH_HOSTS = [
  'qq.com',
  'baidu.com',
  'weibo.com',
  'sina.com.cn',
  'taobao.com',
  'alipay.com',
  'aliyun.com',
  'jd.com',
  '163.com',
  '126.com',
  'xiaomi.com',
  'huawei.com',
  'feishu.cn',
  'dingtalk.com',
  'google.com',
  'microsoftonline.com',
  'live.com',
  'apple.com',
  'github.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'discord.com',
  'steamcommunity.com',
  'weixin.qq.com',
  'wechat.com'
];

/**
 * 授权端点路径特征。只在「路径」上匹配，避免把查询串里的普通参数
 * （比如 `?from=login`）或者 `www.baidu.com/link?url=…` 当成授权页。
 *
 * 覆盖：/oauth2.0/authorize、/o/oauth2/auth、/connect/qrconnect、
 * /cgi-bin/xlogin、/login/oauth/authorize、/openid/login、/sso/… 等常见写法。
 */
const OAUTH_PATH_RE = /(?:^|\/)(?:oauth2?(?:\.0)?|authorize|connect|qrconnect|xlogin|openid|sso|passport|signin|login)(?=[/.?#]|$)/i;

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
 * 只取 pathname：授权端点在路径上，而查询串里经常**带着另一个网址**
 * （`www.baidu.com/link?url=http://example.com/login`）。连 query 一起匹配的话，
 * 那条跳转链接会因为目标站点的 `/login` 被误判成授权页，又弹回窗口。
 */
function pathOf(url) {
  try {
    return new URL(String(url || '')).pathname;
  } catch {
    return '';
  }
}

/** 主机是否属于登录/授权专用子域。 */
function isAuthHost(url) {
  const host = hostOf(url);
  if (!host) return false;
  return AUTH_HOSTS.some((base) => host === base || host.endsWith('.' + base));
}

/** 这次打开的 URL 路径像不像授权端点。 */
function isOAuthPath(url) {
  return OAUTH_PATH_RE.test(pathOf(url));
}

/**
 * 这次打开的 URL 是不是「登录/授权目标」。
 * 登录专用子域直接算；大站主域必须再叠加授权路径，否则一律按普通网页处理。
 */
function isAuthTarget(url) {
  if (isAuthHost(url)) return true;
  if (!isOAuthPath(url)) return false;
  const host = hostOf(url);
  if (!host) return false;
  return OAUTH_HOSTS.some((base) => host === base || host.endsWith('.' + base));
}

/** 从 Electron 给的 features 串里抠出宽高与「窗口属性」。 */
function parseFeatures(features) {
  const out = {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    sized: false,
    popup: false,
    chrome: false,
    noopener: false
  };
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
  // 只有真窗口才会写的 chrome 参数：有些 OAuth 不写宽高，只把地址栏/工具栏关掉
  if (/(?:^|[,;\s])(?:toolbar|menubar|location|status|personalbar|directories|scrollbars|resizable|centerscreen|alwaysRaised|modal|dialog)\s*(?:=|[,;\s]|$)/i.test(str)) {
    out.chrome = true;
  }
  // 站点自己就不要 opener 了，再开真弹窗没有意义（登录回调也用不上）
  if (/(?:^|[,;\s])noopener(?:=|,|\s|$)/i.test(str)) out.noopener = true;
  return out;
}

/**
 * 这次 window.open 该怎么处理。
 *
 * @param {{url:string, disposition?:string, features?:string, allowAuthPopups?:boolean}} req
 * @returns {{popup:boolean, reason:string, width:number, height:number}}
 *   popup=true 时调用方应当**放行成真实子窗口**（保留 opener），
 *   否则维持「开成标签页」。reason 只用于测试与排障。
 */
function decide(req) {
  const r = req || {};
  const url = String(r.url || '');
  const disposition = String(r.disposition || '');
  const feat = parseFeatures(r.features);
  const tab = (reason) => ({ popup: false, reason, width: feat.width, height: feat.height });
  const popup = (reason) => ({ popup: true, reason, width: feat.width, height: feat.height });

  // 用户可以把「第三方登录弹窗」整体关掉，退回旧行为（开标签页）
  if (r.allowAuthPopups === false) return tab('disabled');

  // 站点自己声明 noopener：它并不打算靠 opener 收结果，一律标签页
  if (feat.noopener) return tab('noopener');

  const authTarget = isAuthTarget(url);
  const oauthPath = isOAuthPath(url);
  // window.open 语义（带 features 或指定了新窗口名），而不是普通链接点击
  const windowSemantics = disposition === 'new-window' || disposition === '';
  // 站点确实给了「窗口属性」：宽高 / popup=yes / 窗口 chrome 参数
  const windowish = feat.sized || feat.popup || feat.chrome;

  /* ① 普通网页导航（target=_blank / Ctrl+点击 / 中键）：一律标签页。
   *    百度搜索结果就是这一类，以前因为白名单里写着 baidu.com 被弹成窗口。
   *    唯一例外是「明确的授权端点」（如 open.weixin.qq.com/connect/qrconnect），
   *    它即便用 target=_blank 打开也得保留 opener。 */
  if (disposition === 'foreground-tab' || disposition === 'background-tab') {
    return (authTarget && oauthPath) ? popup('auth-host') : tab('tab');
  }

  /* ② window.open 语义：先看窗口属性，再看是不是授权端点，其余都走标签页。 */
  if (windowSemantics) {
    if (windowish) return popup('sized-popup');
    if (authTarget) return popup('auth-host');
    return tab('tab');
  }

  /* ③ 其它 disposition（default / other / save-to-disk …）：不擅自开窗口，
   *    只有明确的授权端点才保留 opener。 */
  if (authTarget && oauthPath) return popup('auth-host');
  return tab('tab');
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
  OAUTH_HOSTS,
  OAUTH_PATH_RE,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  hostOf,
  pathOf,
  isAuthHost,
  isOAuthPath,
  isAuthTarget,
  parseFeatures,
  decide,
  windowOptions
};
