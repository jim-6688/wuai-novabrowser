'use strict';

/* AI 面板里那个网页的「隐身」预处理（webview 的 preload）。
 *
 * DeepSeek 等站点风控很严，会把内嵌浏览器判成「使用环境异常」而拒绝渲染 —— 截图里
 * 那个报错就是它。UA 已由 webview 的 useragent 属性换成干净 Chrome 串（内核级覆盖，
 * 请求头和 navigator.userAgent 一起换；只改请求头的 onBeforeSendHeaders 挡不住页面
 * 脚本里读 navigator.userAgent 的风控），这里在对方脚本之前把另外几个最常被查的
 * 自动化/内嵌特征抹平。
 *
 * **尽力而为，不保证**：风控规则不公开（还可能查 WebGL 指纹、行为等），仍可能被拦。
 * 真被拦时请用面板里的「API 模式」（用自己的 Key，走 API 请求，不经过对方网页风控）。
 */
(function () {
  const def = (obj, key, get) => {
    try { Object.defineProperty(obj, key, { get, configurable: true }); } catch { /* 对方先改过 */ }
  };

  // 自动化标记：Electron 默认是 false，这里显式钉死，防页面改写
  def(navigator, 'webdriver', () => false);

  // 插件数量：内嵌浏览器通常是 0，真实 Chrome 是 5 —— 这是很常见的一票判据
  def(navigator, 'plugins', () => {
    const names = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer',
      'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
    const out = names.map((n) => ({
      name: n, filename: 'internal-pdf-viewer',
      description: 'Portable Document Format', length: 1
    }));
    out.item = (i) => out[i] || null;
    out.namedItem = (n) => out.find((p) => p.name === n) || null;
    out.refresh = () => { };
    return out;
  });

  // 语言列表：按中文用户给一份合理的
  def(navigator, 'languages', () => ['zh-CN', 'zh', 'en']);

  // window.chrome：真实 Chrome 一定有，内嵌页面有时缺
  if (!window.chrome) {
    def(window, 'chrome', () => ({ app: {}, csi: () => { }, loadTimes: () => { }, runtime: {} }));
  }

  // userAgentData：Chromium 110+ 必有，缺了也是一票判据（只在缺失时补）
  if (!navigator.userAgentData) {
    def(navigator, 'userAgentData', () => ({
      brands: [
        { brand: 'Google Chrome', brandVersion: '144' },
        { brand: 'Chromium', brandVersion: '144' },
        { brand: 'Not?A_Brand', brandVersion: '24' }
      ],
      mobile: false,
      platform: 'Windows',
      getHighEntropyValues: () => Promise.resolve({
        architecture: 'x86', bitness: '64', model: '', platform: 'Windows',
        platformVersion: '15.0.0', uaFullVersion: '144.0.7559.236'
      }),
      toJSON: () => ({})
    }));
  }
})();
