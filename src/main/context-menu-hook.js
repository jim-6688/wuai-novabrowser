'use strict';

/**
 * 突破网页禁用右键（contextmenu 被 preventDefault）。
 * ---------------------------------------------------------------------------
 * Electron 的 <webview> 只有在网页**没有**拦掉 contextmenu 时才会发 `context-menu`
 * 事件，外壳据此弹系统原生菜单。一旦网页写下
 *   document.oncontextmenu = () => false;  /  addEventListener('contextmenu', e => e.preventDefault())
 * 这个事件就不来了 —— 用户连「复制 / 另存图片 / 导出 PDF」都用不了。
 *
 * 这里由主进程往页面**主世界**注入钩子（和 print-hook 同一套路：preload 在隔离
 * 世界，改不到页面的事件监听；主世界 executeJavaScript 不受页面 CSP 限制）：
 *   1. 捕获阶段先于网页的冒泡处理器拿到 contextmenu，读走右键上下文（链接 / 图片 /
 *      选中文字 / 可编辑 / 坐标），存进一个模块级变量；
 *   2. 用 setTimeout(0) 让本轮事件走完整条传播链，再看 ev.defaultPrevented：
 *        - 被网页 preventDefault 了 → Electron 不会弹菜单 → dispatch `nova:context-menu`
 *          把上下文交给隔离世界的 preload，由它 sendToHost 请外壳补弹；
 *        - 没被拦 → Electron 自己会弹原生菜单，这里什么都不做，**避免弹两次**。
 *
 * 子框架：iframe 里的 contextmenu 冒泡不到顶层，而 preload 只装在顶层框架。
 * 子框架钩子把上下文 postMessage 给顶层，由顶层转成 `nova:context-menu`。
 *
 * 钩子只发一条 DOM 事件，不改页面 DOM、不碰页面自己的菜单逻辑、不发网络请求。
 * 是否生效由外壳每次右键时按设置决定：preload 监听 DOM 事件后会再问一次外壳开关，
 * 关掉时外壳直接忽略（见 shell.js 的 handleWebviewIpc）。
 */

const CONTEXT_HOOK_JS = `(function () {
  try {
    if (window.__novaCtxHook) return;
    window.__novaCtxHook = 1;

    // 从原生 contextmenu 事件里读出右键上下文；尽量对齐 Electron webContents
    // context-menu 的 params 字段，让补弹出来的菜单和正常菜单一模一样。
    function collect(ev) {
      var t = ev.target;
      var out = { x: ev.clientX || 0, y: ev.clientY || 0, linkURL: '', srcURL: '',
                  selectionText: '', isEditable: false, mediaType: 'none' };
      try {
        var sel = window.getSelection ? String(window.getSelection().toString() || '') : '';
        out.selectionText = sel;
      } catch (e) { /* ignore */ }
      try {
        var node = t;
        while (node && node.nodeType === 1) {
          if (!out.linkURL && node.tagName === 'A') {
            try { out.linkURL = node.href || ''; } catch (e) { /* ignore */ }
          }
          if (!out.srcURL && (node.tagName === 'IMG' || node.tagName === 'VIDEO' || node.tagName === 'AUDIO')) {
            try { out.srcURL = node.currentSrc || node.src || ''; } catch (e) { /* ignore */ }
          }
          if (node.isContentEditable) out.isEditable = true;
          node = node.parentElement;
        }
      } catch (e) { /* ignore */ }
      if (!out.linkURL && !out.selectionText) out.mediaType = 'none';
      return out;
    }

    function emit(params) {
      try {
        // forced=1 告诉外壳这是「突破补弹」：这类页面常连 copy 事件一起禁了，
        // 复制要改用剪贴板 API 写 selectionText，不能只靠 webContents.copy()。
        params.forced = 1;
        window.dispatchEvent(new CustomEvent('nova:context-menu', { detail: params }));
      } catch (e) { /* 页面把事件禁了就算了 */ }
    }

    var top = null;
    try { top = window.top; } catch (e) { top = null; }

    // 顶层：捕获阶段先记住，本轮结束后判断有没有被网页拦掉。
    window.addEventListener('contextmenu', function (ev) {
      var params = collect(ev);
      setTimeout(function () {
        if (!ev.defaultPrevented) return;   // Electron 会自己弹，不重复
        emit(params);
      }, 0);
    }, true);

    // 子框架转上来的请求：只在顶层接，转成顶层 DOM 事件（preload 只听顶层）。
    if (top === window) {
      window.addEventListener('message', function (e) {
        if (e && e.data && e.data.__novaCtx === 1 && e.data.params) emit(e.data.params);
      });
    } else {
      window.addEventListener('contextmenu', function (ev) {
        var params = collect(ev);
        setTimeout(function () {
          if (!ev.defaultPrevented) return;
          try { top.postMessage({ __novaCtx: 1, params: params }, '*'); } catch (e) { /* ignore */ }
        }, 0);
      }, true);
    }
  } catch (e) { /* 极少数页面锁死了事件系统，那就退回默认行为 */ }
})();`;

/** 这个 webContents 是否已装过钩子（避免每次导航重复挂监听） */
const installed = new WeakSet();

/**
 * 给 webContents 的所有框架注入钩子（顶层 + iframe，和 print-hook 一致）。
 * 主框架与子框架都要装：受限页面常把内容放进 iframe，只装顶层等于没装。
 */
function installContextHook(wc) {
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
      f.executeJavaScript(CONTEXT_HOOK_JS, false).catch(() => { /* 框架还没提交导航 */ });
      n++;
    } catch { /* 框架已销毁 */ }
  }
  if (n && !installed.has(wc)) {
    installed.add(wc);
    // 页面里后面新建 / 导航的框架：did-frame-navigate 提交后注入正好
    try {
      wc.on('did-frame-navigate', () => { installContextHook(wc); });
    } catch { /* ignore */ }
  }
  return n;
}

module.exports = { CONTEXT_HOOK_JS, installContextHook };
