'use strict';

/**
 * 标签页 webview 的极薄 preload：把「页面获得焦点时的缩放 / 打印操作」转给外壳。
 *
 * <p>为什么必须在页面里捕获：
 * Chromium 的 Ctrl+滚轮缩放是浏览器 UI 层的能力，不是网页 API。Electron 的
 * `<webview>` 不会自己缩放，`webContents` 的 `zoom-changed` 对合成/普通滚轮
 * 也不触发（实测两次都不来）。页面里监听 wheel 再 `sendToHost` 是唯一可靠的路。
 *
 * <p>打印同理，而且更彻底：Electron 没有实现 Chromium 的打印预览，网页里
 * `window.print()` 会静默返回 —— 用户点了「打印」什么都没发生。这里把它改写
 * 成一条 sendToHost 消息，由外壳弹出自己的打印设置窗口（纸张/边距/方向），
 * 再走 `webContents.print()` 交给系统打印窗口。
 *
 * <p>这个文件只做这两件事 —— 不注入任何 DOM、不读页面内容，保持攻击面最小。
 */

const { ipcRenderer } = require('electron');

function send(dir) {
  try { ipcRenderer.sendToHost('nova-zoom', dir); } catch { /* 宿主已销毁 */ }
}

function askPrint() {
  try { ipcRenderer.sendToHost('nova-print'); } catch { /* 宿主已销毁 */ }
}

/**
 * 登录表单提交 → 把「用户名 + 密码」交给外壳问是否保存。
 *
 * <p>只在表单里**恰好有一个**密码框时上报：两个及以上通常是注册 / 改密码 /
 * 二次确认，那种场景下弹「保存密码」会让人莫名其妙。
 * <p>这里只读当前表单这两个值，不碰页面其它内容，也不发任何网络请求；
 * 密码只在内存里经过一次 IPC，落盘由主进程用系统 safeStorage 加密。
 */
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!form || form.tagName !== 'FORM') return;

  let pws;
  try { pws = form.querySelectorAll('input[type="password"]'); } catch { return; }
  if (!pws || pws.length !== 1) return;
  const pw = pws[0];
  if (!pw.value) return;

  const q = (sel) => { try { return form.querySelector(sel); } catch { return null; } };
  const ue = q('input[autocomplete="username"]')
    || q('input[type="email"]')
    || q('input[name*="user" i]')
    || q('input[id*="user" i]')
    || q('input[type="tel"]')
    || q('input[type="text"]')
    || q('input:not([type])');

  try {
    ipcRenderer.sendToHost('nova-login', {
      username: ue ? String(ue.value || '').slice(0, 200) : '',
      password: String(pw.value)
    });
  } catch { /* 宿主已销毁 */ }
}, true);

/* 网页里调 window.print() —— 原生的那个在 Electron 下是空操作，必须接管。
   定义成自有属性而不是改原型：有些页面会自己包一层 print 做埋点/排版切换，
   只覆盖当前 window 这一层，页面自己的逻辑仍然保留在它自己的作用域里。 */
try {
  Object.defineProperty(window, 'print', {
    configurable: true,
    writable: true,
    value: function print() { askPrint(); }
  });
} catch { /* 极少数页面把 print 锁死了，那就只能靠 Ctrl+P */ }

window.addEventListener('wheel', (event) => {
  if (!event.ctrlKey || event.metaKey) return;
  // 拦掉页面自己的「Ctrl+滚轮 = 横向滚动」，否则会一边缩放一边滚
  event.preventDefault();
  send(event.deltaY < 0 ? 'in' : 'out');
}, { passive: false, capture: true });

window.addEventListener('keydown', (event) => {
  // Ctrl+P：页面里按下时外壳收不到（焦点在 webview 内部），所以在这里截住
  if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      && (event.key === 'p' || event.key === 'P')) {
    event.preventDefault();
    event.stopPropagation();
    askPrint();
    return;
  }
  if (!event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key;
  if (key === '=' || key === '+') { event.preventDefault(); send('in'); }
  else if (key === '-' || key === '_') { event.preventDefault(); send('out'); }
  else if (key === '0') { event.preventDefault(); send('reset'); }
}, true);
