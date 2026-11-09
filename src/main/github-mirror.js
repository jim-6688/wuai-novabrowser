'use strict';

/**
 * GitHub 访问加速 · 镜像改写决策（纯函数）
 * ---------------------------------------------------------------------------
 * 没有代理节点时，浏览器层面唯一还能给 GitHub 提速的办法是「改道」：
 * 把请求重定向到公共镜像。这个模块只回答一个问题 —— 眼前这条请求该不该改、
 * 改成什么；它不碰 Electron、不读配置文件、不落盘，因此可以在 Node 里直接单测。
 *
 * 两条规则，各管各的：
 *   A. 整站镜像 —— github.com 的网页（仓库页 / 代码 / 搜索）换成镜像域名，
 *      路径原样保留。例：github.com/a/b → bgithub.xyz/a/b
 *   B. 资源前缀镜像 —— 托管「文件」的子域和下载路径，把原始完整 URL 拼到
 *      镜像前缀后面。例：gh-proxy.com/https://raw.githubusercontent.com/…
 *      两类镜像都不代理 GitHub 登录态，也不代理大文件的仓库页，所以分开走。
 *
 * 【安全边界】下面这些一律**不改写**，直连官方：
 *   - 非 GET/HEAD 请求：POST 登录、表单提交、API 写操作绝不能经过第三方。
 *   - xhr / fetch / websocket：跨域重定向会破坏页面自己的请求，宁可漏加速。
 *   - api.github.com：可能带 Token，第三方镜像会看到请求头。
 *   - github.com 上的账号 / 认证 / 组织设置路径：涉及 Cookie 与私有内容。
 *   - gist.github.com、github.io 等非主站域名。
 *   - 头像 / 图片 CDN：这些走直连本来就快，过一层代理反而容易 403。
 *
 * 【已知边界】镜像站若把某条请求 302 回 github.com，这条请求会被再改写一次；
 * 不过改写后的 host 已不是 GitHub 系域名，正常转发不会成环，极端情况下
 * Chromium 自带的重定向环检测会兜住。公共镜像随时可能失效或限速，所以
 * 配置里给的是「可切换的候选清单」，而不是写死一个域名。
 */

/** 整站镜像候选：替换 github.com 域名，用于浏览仓库 / 代码。 */
const SITE_MIRRORS = [
  { id: 'bgithub', label: 'bgithub.xyz · 界面简洁、响应快', url: 'https://bgithub.xyz' },
  { id: 'kkgithub', label: 'kkgithub.com · Markdown 渲染好', url: 'https://kkgithub.com' },
  { id: 'ur1fun', label: 'github.ur1.fun · 加载快', url: 'https://github.ur1.fun' }
];

/**
 * 资源前缀镜像候选：原始完整 URL 拼在后面。
 * gh-proxy.com 自己就跑在 Cloudflare 的多区域节点上（含国内优选与 Fastly /
 * EdgeOne 备用线路），所以「CF 加速」在这里体现为镜像服务自带的边缘网络，
 * 而不是浏览器去给任意 Cloudflare 站点提速 —— 后者没有出口节点做不到。
 */
const ASSET_MIRRORS = [
  { id: 'ghproxycom', label: 'gh-proxy.com · Cloudflare 多节点（推荐）', url: 'https://gh-proxy.com/' },
  { id: 'ghproxynet', label: 'ghproxy.net · 支持断点续传', url: 'https://ghproxy.net/' },
  { id: 'mirror', label: 'mirror.ghproxy.com · 官方备用', url: 'https://mirror.ghproxy.com/' },
  { id: 'llkk', label: 'gh.llkk.cc · 国内 CDN', url: 'https://gh.llkk.cc/' },
  { id: 'gitmirror', label: 'hub.gitmirror.com · 大体积 Release', url: 'https://hub.gitmirror.com/' },
  { id: 'moeyy', label: 'moeyy.cn/gh-proxy', url: 'https://moeyy.cn/gh-proxy/' },
  { id: 'akams', label: 'github.akams.cn · 支持 API / Gist', url: 'https://github.akams.cn/' }
];

const DEFAULT_SITE_MIRROR = SITE_MIRRORS[0].url;
const DEFAULT_ASSET_MIRROR = ASSET_MIRRORS[0].url;

/** 只托管「文件」的子域。头像 / 图片 CDN 刻意不收，直连比过代理更快更稳。 */
const ASSET_HOSTS = new Set([
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'gist.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'desktop.githubusercontent.com'
]);

/**
 * github.com 路径的**第一段**是这些词时不改写 —— 账号、认证、组织后台。
 * 按「第一段」而不是字符串前缀判断很重要：/user/repo 是公开仓库，
 * 用 startsWith('/user') 会把所有个人仓库都误判成私有页面。
 */
const PRIVATE_FIRST_SEGMENTS = new Set([
  'login', 'logout', 'join', 'signup', 'session', 'sessions',
  'settings', 'notifications', 'account', 'oauth', 'authorize',
  'apps', 'dashboard', 'password_reset', 'two_factor', 'suspended',
  'orgs', 'organizations', 'billing', 'admin', 'staff', 'security',
  'codespaces', 'sponsors', 'sponsor', 'billing_plans'
]);

/** 下载 / 归档类路径：整站镜像一般不代理大文件，改走前缀镜像。 */
const DOWNLOAD_PATH_RE = /\/releases\/download\/|\/releases\/latest\/download\/|\/archive\/|\/raw\//i;

/** 这些类型重定向会破坏页面自己的请求，一律漏加速也不改。 */
const NO_REWRITE_TYPES = new Set(['xhr', 'fetch', 'websocket', 'ping', 'cspreport']);

/**
 * 把用户填的镜像地址规整成 origin（协议 + 主机 + 端口，不带路径与尾斜杠）。
 * 允许直接填域名；填错 / 填了内网地址就返回空串，调用方据此放弃改写道，
 * 让请求直连官方 —— 配置写错不该让用户连不上 GitHub。
 */
function originOf(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    if (!u.hostname.includes('.')) return '';
    return u.origin;
  } catch { return ''; }
}

/**
 * 把用户填的镜像地址规整成「可拼接的前缀」：保留路径（moeyy.cn/gh-proxy/
 * 这类带路径的服务），末尾恰好一个斜杠。
 */
function prefixOf(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    if (!u.hostname.includes('.')) return '';
    return u.origin + u.pathname.replace(/\/+$/, '') + '/';
  } catch { return ''; }
}

/** githubusercontent.com 下专供图片 / 头像的域名，过代理容易 403，直连更快。 */
const IMAGE_HOSTS = new Set([
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'camo.githubusercontent.com',
  'cloud.githubusercontent.com',
  'repository-images.githubusercontent.com'
]);

function isAssetHost(host) {
  if (ASSET_HOSTS.has(host)) return true;
  if (IMAGE_HOSTS.has(host)) return false;
  return host.endsWith('.githubusercontent.com');
}

/** 路径第一段命中账号 / 认证保留词 → 不改写。 */
function isPrivatePath(pathname) {
  const seg = String(pathname || '').split('/').filter(Boolean)[0];
  return !!seg && PRIVATE_FIRST_SEGMENTS.has(seg.toLowerCase());
}

/**
 * 核心决策：这条请求要不要改道、改成什么。
 *
 * @param {object} details 至少含 url；可选 method / resourceType（与 Electron
 *                         webRequest 的 details 同形，便于接线层直接透传）
 * @param {object} cfg     settings.github：{ enabled, siteMirror, assetMirror }
 * @returns {string|null}  改写后的完整 URL；不改道返回 null
 */
function rewrite(details, cfg) {
  // 默认关闭。老配置里没有这个键时 cfg 是 undefined，同样直连 ——
  // 升级上来的人不该在不知情的情况下把流量交给第三方。
  if (!cfg || cfg.enabled !== true) return null;

  const d = details || {};
  const url = String(d.url || '');
  if (!url) return null;

  const method = String(d.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (NO_REWRITE_TYPES.has(String(d.resourceType || '').toLowerCase())) return null;

  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

  const host = u.hostname.toLowerCase();
  const prefix = prefixOf(cfg.assetMirror || DEFAULT_ASSET_MIRROR);
  const site = originOf(cfg.siteMirror || DEFAULT_SITE_MIRROR);

  // 1) 文件类子域 —— 前缀镜像
  if (isAssetHost(host)) return prefix ? prefix + url : null;

  // 2) 主站 —— 下载 / 归档优先前缀镜像，其余整站镜像
  if (host === 'github.com' || host === 'www.github.com') {
    if (isPrivatePath(u.pathname)) return null;
    if (DOWNLOAD_PATH_RE.test(u.pathname) && prefix) return prefix + url;
    if (!site) return null;
    return site + u.pathname + u.search + u.hash;
  }

  // 3) api.github.com / gist.github.com / github.io 等一律直连
  return null;
}

/** 给设置页的「试一下」用：与 rewrite 同一份规则，只把入参补齐。 */
function preview(rawUrl, cfg) {
  return rewrite({ url: rawUrl, method: 'GET', resourceType: 'mainFrame' }, cfg)
    || String(rawUrl || '');
}

module.exports = {
  SITE_MIRRORS,
  ASSET_MIRRORS,
  DEFAULT_SITE_MIRROR,
  DEFAULT_ASSET_MIRROR,
  originOf,
  prefixOf,
  isPrivatePath,
  rewrite,
  preview
};
