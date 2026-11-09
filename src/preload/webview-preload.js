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
 *   - 挑一个可见、且没标 new-password 的密码框，它为空才问：登录页常同时
 *     挂着注册框 / 显示密码用的第二框 / 蜜罐框，硬性要求「只有一个」会让
 *     这些站点永远问不出口；非空说明页面自己带了值或用户已经在打，覆盖
 *     用户的输入是最讨厌的事。
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
  /** 成功填过一次就收手：框架重渲染可能把值清空，别跟着再填第二轮 */
  let done = false;
  /** 最近一次开口时看到的那一对输入框（SPA 常在这期间把 DOM 整个换掉） */
  let lastPair = null;
  /** DOM 变化探测：登录表单晚到也能接住 */
  let observer = null;
  /** 没等到回填时的补偿重发：一次性消息若赶上宿主还没挂好监听，就永久丢了 */
  let retryTimer = null;
  let retryLeft = 0;

  /**
   * 可见性只用来「从多个密码框里挑一个」，不是硬门槛 —— 判不准时宁可全留着，
   * 也别像从前那样「有两个密码框就整个不填」。
   */
  function visible(el) {
    if (!el || el.disabled || el.readOnly || el.hidden || el.type === 'hidden') return false;
    try {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      // jsdom / 页面还没布局时矩形全是 0，这时只靠样式判断，别把所有框都判成隐藏
      if (r.width === 0 && r.height === 0 && document.documentElement.offsetWidth > 0) return false;
    } catch { /* 取不到样式就当可见 */ }
    return true;
  }

  /** 登录页常同时挂着注册框、显示密码用的第二个框、蜜罐框：挑真正那个 */
  function pickPassword(pws) {
    const all = Array.prototype.slice.call(pws || []);
    if (!all.length) return null;
    const bad = (p) => p.disabled || p.readOnly || p.hidden
      || /new-password/i.test(p.getAttribute('autocomplete') || '');
    const vis = all.filter((p) => !bad(p) && visible(p));
    const pool = vis.length ? vis : all.filter((p) => !bad(p));
    const list = pool.length ? pool : all;
    return list.find((p) => (p.getAttribute('autocomplete') || '').toLowerCase() === 'current-password')
      || list[0] || null;
  }

  /** 用户名框按语义打分，避开验证码 / 搜索 / 隐藏域；不再只认第一个 text */
  function pickUser(form) {
    let inputs;
    try { inputs = Array.prototype.slice.call(form.querySelectorAll('input')); } catch { return null; }
    const bad = /(captcha|verify|vcode|otp|search|keyword|query)/i;
    const score = (i) => {
      const ac = (i.getAttribute('autocomplete') || '').toLowerCase();
      const t = (i.type || '').toLowerCase();
      const n = ((i.name || '') + ' ' + (i.id || '') + ' ' + (i.placeholder || '')).toLowerCase();
      if (ac === 'username' || ac === 'email') return 100;
      if (t === 'email' || /e-?mail/.test(n)) return 90;
      if (/user|account|login|acct|uname|phone|mobile|tel/.test(n)) return 80;
      if (t === 'tel') return 70;
      return (t === 'text' || !t) ? 10 : 0;
    };
    const usable = inputs.filter((i) => i && i.type !== 'password' && i.type !== 'hidden'
      && i.type !== 'submit' && i.type !== 'button' && i.type !== 'checkbox'
      && i.type !== 'radio' && i.type !== 'file' && visible(i)
      && !bad.test((i.name || '') + ' ' + (i.id || '') + ' ' + (i.autocomplete || '')));
    const scored = usable.map((i) => ({ i, s: score(i) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.length ? scored[0].i : null;
  }

  /** 当前文档里那个「能填」的登录表单；没有返回 null */
  function findLoginForm() {
    let pws;
    try { pws = document.querySelectorAll('input[type="password"]'); } catch { return null; }
    if (!pws || !pws.length) return null;
    const pw = pickPassword(pws);
    if (!pw) return null;
    // DOM 是共享的：主世界（或页面脚本）已经填过就别插手
    if (pw.value || filled.has(pw)) return null;
    const form = pw.form || document;
    return { ue: pickUser(form), pw };
  }

  function sendAsk(f) {
    try {
      ipcRenderer.sendToHost('nova-cred-ask', {
        origin: location.origin,
        // 站点常会「记住用户名」，把它当线索交给宿主优先匹配同账号那条，
        // 免得同站点存了多个账号时把别人的密码填错。
        username: f.ue ? String(f.ue.value || '').slice(0, 200) : ''
      });
    } catch { /* 宿主已销毁 */ }
  }

  /**
   * 补偿重发。按「密码框元素」去重是对的（不反复打扰宿主），但代价是同一条
   * 消息只有一次机会：宿主那一刻若在重建 webview / 刚挂监听 / 凭证还在写入，
   * 这次静默失败之后就再也不会填了。这里给同一条消息最多补两次，收到回填
   * 或用户自己开始输入就停。重复到达的回填由 done 拦住，不会覆盖第二遍。
   */
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (done || !lastPair || lastPair.pw.value || retryLeft <= 0) return;
      retryLeft--;
      sendAsk(lastPair);
      scheduleRetry();
    }, 1500);
  }

  function askHost() {
    if (done) return;
    const f = findLoginForm();
    if (!f || askedFor.has(f.pw)) return;
    askedFor.add(f.pw);
    asked = true;
    lastPair = f;
    sendAsk(f);
    retryLeft = 2;
    scheduleRetry();
  }

  /**
   * 写值必须绕开框架在实例上装的 value 拦截器：React / Vue 会劫持 input.value，
   * 直接赋值只更新了它的 value tracker，框架据此认为「值没变」而不派 onChange，
   * 下一次渲染又把 state 里的空值写回来 —— 用户看到的就是「填了又没了」。
   * 用原型上那个原生 setter 赋值，再派 input / change，框架才认这个变化。
   */
  function setValue(el, v) {
    if (!el || !v) return;
    try {
      el.focus();
      const proto = typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : null;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, v);
      else el.value = v;
      const input = (typeof InputEvent === 'function')
        ? new InputEvent('input', { bubbles: true, data: v, inputType: 'insertText' })
        : new Event('input', { bubbles: true });
      el.dispatchEvent(input);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch { /* 控件没了就算了 */
    }
  }

  /** 宿主回一条账号密码。已经要过才填，防止页面脚本伪造这条消息乱填。 */
  ipcRenderer.on('nova-cred-fill', (_e, payload) => {
    if (!asked || done || !payload || !payload.password) return;
    let f = lastPair;
    // 记住的框可能已被 SPA 换掉：仍挂在文档上且还是空的才用，否则重新找
    if (!f || !f.pw || !f.pw.isConnected || f.pw.value) f = findLoginForm() || f;
    if (!f || !f.pw) return;
    setValue(f.ue, String(payload.username || ''));
    setValue(f.pw, String(payload.password));
    if (f.ue) filled.add(f.ue);
    filled.add(f.pw);
    done = true;
    lastPair = null;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    try { if (observer) observer.disconnect(); } catch { /* ignore */ }
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
