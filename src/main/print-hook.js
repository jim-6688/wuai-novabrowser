'use strict';

/**
 * 把网页里的 window.print() 接到 Nova 的打印设置窗口。
 * ---------------------------------------------------------------------------
 * 为什么不能像缩放那样在 preload 里改：webview 带着 contextIsolation=yes，
 * preload 跑在**隔离世界**，在那边改 `window.print` 页面看不见 —— 页面里的
 * print 还是原生那个，点下去直接弹系统打印对话框，绕过纸张/边距设置。
 * （Ctrl+P 走的是 DOM 键盘事件，跨世界有效，所以「Ctrl+P 能弹窗」看着一切正常，
 * 只有页面自己的打印按钮不听话 —— 这个坑就是这么藏住的。）
 *
 * Electron 30 没有 contextBridge.executeInMainWorld（那是后面的版本才有的），
 * 所以这里由主进程用 webContents / webFrameMain 的 executeJavaScript 注入 ——
 * 它跑在页面主世界，且不受页面 CSP 限制。
 *
 * 注入的钩子不直接跟外壳说话（主世界拿不到 ipcRenderer），而是 dispatch 一个
 * DOM 事件 `nova:print`；preload 在隔离世界监听同一个事件。两个世界共享同一份
 * DOM，事件是跨世界的 —— 这一点由 tools/test-print-hook-electron.js 实测保证。
 *
 * 子框架：iframe 里点打印同样要能接管。子框架的主世界发不出顶层的事件，
 * 所以钩子里让它 postMessage 给顶层，由顶层钩子转成 `nova:print`。
 */

const PRINT_HOOK_JS = `(function () {
  try {
    if (window.__novaPrintHook) return;
    window.__novaPrintHook = 1;

    var request = function () {
      try { window.dispatchEvent(new Event('nova:print')); } catch (e) { /* 页面把事件禁了 */ }
    };

    // 子框架转上来的请求：只在顶层框架上听（子框架自己也听，但没有 preload，无害）
    try {
      window.addEventListener('message', function (e) {
        if (e && e.data && e.data.__novaPrint === 1) request();
      });
    } catch (e) { /* ignore */ }

    var hooked = function print() {
      var top = null;
      try { top = window.top; } catch (e) { top = null; }   // 跨域时读 top 会抛
      if (!top || top === window) { request(); return; }
      try { top.postMessage({ __novaPrint: 1 }, '*'); }
      catch (e) { request(); }
    };
    hooked.__nova = 'print-hook';

    Object.defineProperty(window, 'print', {
      configurable: true,
      writable: true,
      value: hooked
    });
  } catch (e) { /* 极少数页面把 print 锁死了，那就只能靠 Ctrl+P */ }
})();`;

/** 这个 webContents 上的框架是否已经装过钩子（避免每次导航都重复挂监听） */
const installed = new WeakSet();

/**
 * 给一个 webContents 的**所有**框架注入钩子。
 * 主框架与子框架都要装：报表类页面常把内容放在 iframe 里，只装顶层等于没装。
 */
function installPrintHook(wc) {
  if (!wc || wc.isDestroyed()) return 0;
  let frames = [];
  try {
    frames = (wc.mainFrame && wc.mainFrame.framesInSubtree) || [wc.mainFrame];
  } catch {
    frames = [];
  }
  let n = 0;
  for (const f of frames) {
    if (!f) continue;
    try {
      f.executeJavaScript(PRINT_HOOK_JS, false).catch(() => { /* 框架还没提交导航 */ });
      n++;
    } catch { /* 框架已销毁 */ }
  }
  if (n && !installed.has(wc)) {
    installed.add(wc);
    // 页面里后面新建 / 导航的框架：did-frame-navigate 在提交后触发，这时注入正好
    try {
      wc.on('did-frame-navigate', () => { installPrintHook(wc); });
    } catch { /* ignore */ }
  }
  return n;
}

module.exports = { PRINT_HOOK_JS, installPrintHook };
