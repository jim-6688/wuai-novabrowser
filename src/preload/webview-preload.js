'use strict';

/**
 * 标签页 webview 的极薄 preload：只负责把「页面获得焦点时的缩放操作」转给外壳。
 *
 * <p>为什么必须在页面里捕获：
 * Chromium 的 Ctrl+滚轮缩放是浏览器 UI 层的能力，不是网页 API。Electron 的
 * `<webview>` 不会自己缩放，`webContents` 的 `zoom-changed` 对合成/普通滚轮
 * 也不触发（实测两次都不来）。页面里监听 wheel 再 `sendToHost` 是唯一可靠的路。
 *
 * <p>这个文件只做这一件事 —— 不注入任何 DOM、不读页面内容，保持攻击面最小。
 */

const { ipcRenderer } = require('electron');

function send(dir) {
  try { ipcRenderer.sendToHost('nova-zoom', dir); } catch { /* 宿主已销毁 */ }
}

window.addEventListener('wheel', (event) => {
  if (!event.ctrlKey || event.metaKey) return;
  // 拦掉页面自己的「Ctrl+滚轮 = 横向滚动」，否则会一边缩放一边滚
  event.preventDefault();
  send(event.deltaY < 0 ? 'in' : 'out');
}, { passive: false, capture: true });

window.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key;
  if (key === '=' || key === '+') { event.preventDefault(); send('in'); }
  else if (key === '-' || key === '_') { event.preventDefault(); send('out'); }
  else if (key === '0') { event.preventDefault(); send('reset'); }
}, true);
