'use strict';

/**
 * 标签页 webview 的 preload：把宿主接管不了的三件事转给外壳
 * —— Ctrl+滚轮缩放、window.print()、登录 / 改密表单的账号密码。
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
 * <p>这里只发消息：缩放 / 打印 / 当前表单的两个字段值，各一条 IPC。不注入
 * DOM、不碰页面其它内容、不碰密码库、不发网络请求，保持攻击面最小。
 */

const { ipcRenderer } = require('electron');

function send(dir) {
  try { ipcRenderer.sendToHost('nova-zoom', dir); } catch { /* 宿主已销毁 */ }
}

function askPrint() {
  try { ipcRenderer.sendToHost('nova-print'); } catch { /* 宿主已销毁 */ }
}

/**
 * 登录 / 改密码表单提交 → 把「用户名 + 密码」交给外壳。
 *
 * <p>两种表单：
 *   - 恰好一个密码框 = 登录（kind:'login'）。外壳问「要不要保存」；本站已存过
 *     且密码变了，就自动把那条记录更新掉。
 *   - 多个密码框 = 改密码 / 注册 / 二次确认。只有能确定「新密码」时才上报
 *     （kind:'change'），而且外壳那边**只在同站点已有保存记录时**才更新，
 *     没有记录就完全忽略 —— 注册页的密码绝不会被顺手存下来。
 *
 * <p>这里只读当前表单的字段值，不碰页面其它内容，也不发任何网络请求；
 * 密码只在内存里经过一次 IPC，落盘由主进程用系统 safeStorage 加密。
 */
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!form || form.tagName !== 'FORM') return;

  let pws;
  try { pws = form.querySelectorAll('input[type="password"]'); } catch { return; }
  if (!pws || !pws.length) return;

  const q = (sel) => { try { return form.querySelector(sel); } catch { return null; } };
  const ue = q('input[autocomplete="username"]')
    || q('input[type="email"]')
    || q('input[name*="user" i]')
    || q('input[id*="user" i]')
    || q('input[type="tel"]')
    || q('input[type="text"]')
    || q('input:not([type])');

  let password = '';
  let kind = 'login';
  if (pws.length === 1) {
    password = String(pws[0].value || '');
  } else {
    // 认「改密表单」的两条路，都要能排除注册页：
    //  ① 表单里同时标了 current-password 和 new-password（规范写法）；
    //  ② 至少三个密码框（旧 / 新 / 确认），且新密码与确认密码同值 ——
    //     注册页通常只有「新 + 确认」两个框，不会有第三个旧密码框。
    const oldPw = q('input[type="password"][autocomplete="current-password"]');
    const newPw = q('input[type="password"][autocomplete="new-password"]');
    if (oldPw && newPw && String(newPw.value || '')) {
      password = String(newPw.value);
    } else if (pws.length >= 3) {
      const vals = [];
      for (const p of pws) { const v = String(p.value || ''); if (v) vals.push(v); }
      password = vals.find((v, i) => vals.indexOf(v) !== i) || '';
    }
    if (!password) return;   // 认不出就别猜，宁可漏一次也不覆盖错密码
    kind = 'change';
  }
  if (!password) return;

  try {
    ipcRenderer.sendToHost('nova-login', {
      username: ue ? String(ue.value || '').slice(0, 200) : '',
      password: password,
      kind: kind
    });
  } catch { /* 宿主已销毁 */ }
}, true);

/* ------------------------------------------------------------------ *
 * 自动带入已保存的账号密码
 * ------------------------------------------------------------------ *
 * 用户存的并非只有「提示保存」这一半：保存了却还要每次都手输，等于没保存。
 *
 * 流程（三段都在**页面侧**发起，宿主只负责解密与比对）：
 *   1) 页面里出现「登录表单」→ sendToHost('nova-cred-ask', {origin, username})
 *   2) 外壳按 origin 精确匹配一条已存记录、解密，webview.send('nova-cred-fill')
 *   3) 这里把值写进输入框并派发 input/change（框架要监听这个才知道值变了）
 *
 * 安全边界：
 *   - 只问、不存。这个文件碰不到密码库，也发不出任何请求。
 *   - 表单里**恰好一个**密码框且它是空的才问：两个以上是注册/改密码；非空
 *     说明页面自己带了值或用户已经在打，覆盖用户的输入是最讨厌的事。
 *   - origin 由页面自己读 location.origin（这里是 guest 自己的 origin，
 *     不是宿主的地址），宿主那侧还会再拿标签页真实地址核一遍。
 *
 * 时机：DOM 就绪问一次 + 定时器兜底 + MutationObserver 盯异步渲染的登录框。
 * 现代登录页多用前端框架延迟挂载表单，只靠几次定时器会整个漏掉 —— 表现为
 * 「保存了密码，下次打开还是要手输」。按「密码框元素」去重，不是整篇文档只问
 * 一次：SPA 换了一批 DOM 之后还能再问，同一个框则不会反复打扰宿主。
 */
(function () {
  /** 已经填过的框：别填第二遍（页面重绘、用户改主意都算） */
  const filled = new WeakSet();
  /** 已经问过的密码框：同一个框只问一次；SPA 换了新的框允许再问 */
  const askedFor = new WeakSet();
  /** 这一份文档至少问过一次（宿主回填时要确认是自己先开的口） */
  let asked = false;
  /** DOM 变化探测：登录表单晚到也能接住 */
  let observer = null;

  /** 当前文档里那个「能填」的登录表单；没有返回 null */
  function findLoginForm() {
    let pws;
    try { pws = document.querySelectorAll('input[type="password"]'); } catch { return null; }
    if (!pws || pws.length !== 1) return null;
    const pw = pws[0];
    // DOM 是共享的：主世界（或页面脚本）已经填过就别插手
    if (pw.value || filled.has(pw)) return null;
    const form = pw.form || document;
    const q = (sel) => { try { return form.querySelector(sel); } catch { return null; } };
    const ue = q('input[autocomplete="username"]')
      || q('input[type="email"]')
      || q('input[name*="user" i]')
      || q('input[id*="user" i]')
      || q('input[type="tel"]')
      || q('input[type="text"]')
      || q('input:not([type])');
    return { ue: ue || null, pw };
  }

  function askHost() {
    const f = findLoginForm();
    if (!f || askedFor.has(f.pw)) return;
    askedFor.add(f.pw);
    asked = true;
    try {
      ipcRenderer.sendToHost('nova-cred-ask', {
        origin: location.origin,
        // 站点常会「记住用户名」，把它当线索交给宿主优先匹配同账号那条，
        // 免得同站点存了多个账号时把别人的密码填错。
        username: f.ue ? String(f.ue.value || '').slice(0, 200) : ''
      });
    } catch { /* 宿主已销毁 */ }
  }

  function setValue(el, v) {
    if (!el || !v) return;
    try {
      el.focus();
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    } catch { /* 控件没了就算了 */
    }
  }

  /** 宿主回一条账号密码。已经要过才填，防止页面脚本伪造这条消息乱填。 */
  ipcRenderer.on('nova-cred-fill', (_e, payload) => {
    if (!asked || !payload || !payload.password) return;
    const f = findLoginForm();
    if (!f) return;
    setValue(f.ue, String(payload.username || ''));
    setValue(f.pw, String(payload.password));
    if (f.ue) filled.add(f.ue);
    filled.add(f.pw);
  });

  // 新增节点 / type 被改成 password 时都补问一次。有 askedFor 去重，
  // 同一个框不会因为页面反复重绘刷爆宿主；填完之后 findLoginForm 会因为
  // 「密码框已有值」直接返回 null，也不会被反复填。
  try {
    observer = new MutationObserver(() => askHost());
    observer.observe(document, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['type']
    });
    // 长页面不必一直挂着：60 秒后收手，之后仍靠 focusin 兜底
    setTimeout(() => { try { if (observer) observer.disconnect(); } catch { /* ignore */ } }, 60000);
  } catch { /* 老环境没有 MutationObserver，定时器与 focusin 仍可用 */ }

  // 时机：DOM 就绪立刻问一次；定时器接住接口渲染晚到的表单。
  // 用户第一次点进密码框也问（这时表单一定在），比多等两秒更贴手。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { askHost(); setTimeout(askHost, 800); setTimeout(askHost, 2000); }, { once: true });
  } else {
    askHost(); setTimeout(askHost, 800); setTimeout(askHost, 2000);
  }
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t && t.tagName === 'INPUT' && t.type === 'password') askHost();
  }, true);
})();

/* 网页里调 window.print() —— 必须接管，否则页面自己的「打印」按钮会直接弹系统
   打印对话框，绕过 Nova 的纸张/边距设置。
 *
 * 真正的接管装在**页面主世界**（src/main/print-hook.js，由主进程注入）：这个
 * preload 跑在隔离世界，在这里改 window.print 页面根本看不见 —— 以前正是这么
 * 写的，所以「Ctrl+P 能弹窗」看着正常（键盘事件跨世界），页面里的打印按钮却
 * 一直弹系统对话框。主世界的钩子改的是页面自己那份 print，然后 dispatch 一个
 * `nova:print` 事件，这里接着往下送。
 */
window.addEventListener('nova:print', askPrint);

/* 兜底：万一钩子没装上（老版本宿主、或页面把 print 锁死了），至少隔离世界这份
   是可用的；另外没有 contextIsolation 的宿主里，这一行就是真正生效的那份。 */
try {
  if (!(window.print && window.print.__nova)) {
    Object.defineProperty(window, 'print', {
      configurable: true,
      writable: true,
      value: function print() { askPrint(); }
    });
  }
} catch { /* ignore */ }

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
