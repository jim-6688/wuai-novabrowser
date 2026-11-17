'use strict';

/**
 * 本机快捷登录的回环域名白名单。
 * ---------------------------------------------------------------------------
 * 微信 / QQ 的「快捷登录」不是走公网回调，而是网页里一个跨域 iframe 去访问
 * **本机客户端**监听的端口：
 *
 *   微信  POST https://localhost.weixin.qq.com:14013/api/check-login
 *   QQ    https://localhost.ptlogin2.qq.com:4301/pt_get_uins?...
 *         （QQ 客户端监听 4300-4308 / 动态端口，域名解析到 127.0.0.1）
 *
 * 这些域名有共同特征：**长得像大厂域名（*.qq.com），却在 DNS / hosts 里指向
 * 127.0.0.1**。Chromium 142（2025-10）起把「公网页面 → 回环地址」纳入 LNA
 * （Local Network Access）权限，默认拦截；快捷登录请求被挡住后，页面静默
 * 回退到扫码，用户只看到「快捷登录突然不能用了」。
 *
 * 为什么需要**内置**白名单而不是让用户配站点规则：
 *   - 这个域名只在快捷登录那一瞬间出现，用户事前根本不知道要给它授权；
 *   - 权限条弹出时写的是「localhost.weixin.qq.com 想访问本地网络」，用户看不懂；
 *   - Electron 没有 chrome://flags / 网站设置入口，用户无从手动放行。
 *
 * 所以对这些**已知第一方回环域名**直接放行 LNA，开箱即用。安全边界：
 *   1. 只收「localhost.」前缀的精确域名，绝不写 qq.com / weixin.qq.com 通配 ——
 *      否则真正的公网站点也会被当成回环放行。
 *   2. 只做精确主机名匹配（不按后缀），evilqq.com / xx.qq.com 都不算。
 *   3. 有总开关 settings.localAuth.enabled，用户可一键关掉退回严格模式。
 *   4. 这里只放行**浏览器到本机客户端的连接授权**，不读取客户端任何数据，
 *      也不碰登录票据 / Cookie —— 真正的授权握手由网页与该客户端自己完成。
 */

/**
 * 已知快捷登录回环域名（全部 DNS 指向 127.0.0.1，第一方客户端监听）。
 * 只收 localhost.* 形式；端口不固定（微信 14013、QQ 4300-4308/动态），
 * 所以只按主机名匹配，端口交给 LNA 自己判定。
 */
const LOCAL_AUTH_HOSTS = [
  // 微信 PC 客户端
  'localhost.weixin.qq.com',
  'localhost.wechat.com',
  // QQ / 腾讯 PC 客户端
  'localhost.ptlogin2.qq.com',
  'localhost.ptlogin.qq.com',
  'localhost.sec.qq.com',
  'localhost.qq.com'
];

/**
 * host 是否属于已知快捷登录回环域名。
 *
 * 只做**精确匹配**：收集到的本身就是完整主机名，不需要子域；而后缀匹配会让
 * 攻击者构造的 evil.localhost.weixin.qq.com（若哪天 DNS 指到公网）也被放行，
 * 白白扩大攻击面。忽略大小写与末尾点。
 */
function isLocalAuthHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '').trim();
  if (!h) return false;
  return LOCAL_AUTH_HOSTS.indexOf(h) >= 0;
}

module.exports = { LOCAL_AUTH_HOSTS, isLocalAuthHost };
