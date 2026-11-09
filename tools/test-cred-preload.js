'use strict';

/**
 * 页面侧「自动带入账号密码」的行为测试 —— 真实 DOM（jsdom）+ 模拟 ipcRenderer。
 * 用法：node tools/test-cred-preload.js
 *
 * 为什么要有这一层：这段逻辑跑在 webview 的 preload 里，此前只被
 * tools/check-shell.js 的静态断言钉住「字面量还在」，从来没在 DOM 里执行过。
 * 用户报「保存了密码却不能自动填充」之后复盘，四个坑全在这一层：
 *
 *   [A] React / Vue 受控输入框：直接 input.value = v 只更新框架的 value tracker，
 *       onChange 不触发，下一次渲染又把空 state 写回来 → 看着就是没填。
 *   [B] 只认「恰好一个密码框」：登录页常同时挂着注册框 / 显示密码切换框 /
 *       蜜罐框，硬性要求一个就永远问不出口。
 *   [C] 开口 → 回填之间 SPA 把 DOM 整个换掉，回填时再找就找不到了。
 *   [D] 用户名框只按固定选择器顺序取第一个，容易抓到搜索框 / 验证码框。
 *
 * 另测异步出现的表单（MutationObserver）、防重复填、不覆盖用户已输入的值、
 * 没等到回填时的有限次补偿重发，以及提交表单上报 nova-login 没被带坏。
 *
 * vm 里跑 preload：它需要 electron 的 ipcRenderer 和浏览器全局，这里造一份最小
 * 沙箱。宿主侧（autofillLogin）由 tools/test-autofill.js 覆盖。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');

function loadJsdom() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules'),
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules')
  ];
  for (const dir of candidates) {
    const p = path.join(dir, 'jsdom');
    if (fs.existsSync(p)) return require(p);
  }
  try { return require('jsdom'); } catch { /* 继续 */ }
  console.error('\n缺少 jsdom（仅测试需要）。\n');
  process.exit(2);
}
const { JSDOM } = loadJsdom();

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/preload/webview-preload.js'), 'utf8');
let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一份带 preload 的假页面；返回可以向它回填的句柄 */
function boot(html, url = 'https://site.test/login') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const sent = [];
  const handlers = Object.create(null);
  const ipcRenderer = {
    sendToHost: (ch, payload) => sent.push({ ch, payload }),
    on: (ch, fn) => { (handlers[ch] || (handlers[ch] = [])).push(fn); },
    send: () => {},
    invoke: async () => ({})
  };
  const sandbox = {
    console,
    require: (m) => (m === 'electron' ? { ipcRenderer } : {}),
    window: win,
    document: win.document,
    location: win.location,
    Event: win.Event,
    InputEvent: win.InputEvent,
    MutationObserver: win.MutationObserver,
    HTMLInputElement: win.HTMLInputElement,
    getComputedStyle: (el) => win.getComputedStyle(el),
    WeakSet,
    setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'webview-preload.js' });
  return {
    win, doc: win.document, sent, handlers,
    $: (s) => win.document.querySelector(s),
    fill: (payload) => (handlers['nova-cred-fill'] || []).forEach((fn) => fn({}, payload)),
    asks: () => sent.filter((x) => x.ch === 'nova-cred-ask'),
    submit: (form) => form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })),
    close: () => win.close()
  };
}

/**
 * 给 input 装一个 React 风格的 value tracker：实例属性上的 setter 会同步更新
 * tracker，而 React 在 input 事件里比较 tracker 与当前值，相等就认为「没变」、
 * 不派 onChange。用原型 setter 赋值才能绕开它。
 * 返回一个函数，读「框架有没有感知到这次变化」。
 */
function installTracker(win, el) {
  const desc = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value');
  let tracker = desc.get.call(el);
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { tracker = v; desc.set.call(this, v); }
  });
  let seen = false;
  let inputs = 0;
  let changes = 0;
  el.addEventListener('input', () => {
    inputs++;
    if (desc.get.call(el) !== tracker) seen = true;
  });
  el.addEventListener('change', () => { changes++; });
  return () => ({ seen, inputs, changes, raw: desc.get.call(el) });
}

const FORM = (inner, attrs = '') => `<form id="f" ${attrs}>${inner}</form>`;

(async () => {
  /* ================================================================ *
   * [A] 经典登录页 + 受控输入：这是「填了又没了」的根因
   * ================================================================ */
  console.log('\n[A] 经典登录页 / React 受控输入框');
  {
    const t = boot(FORM(
      '<input id="u" type="text" name="username" autocomplete="username" />' +
      '<input id="p" type="password" autocomplete="current-password" />' +
      '<button type="submit">登录</button>'
    ));
    await sleep(60);   // 等 DOMContentLoaded 那一次 ask
    const asks = t.asks();
    check('开口向宿主问凭证', asks.length >= 1, '实际 ' + asks.length);
    check('报的是 guest 自己的 origin', asks.length && asks[0].payload.origin === 'https://site.test');
    check('用户名线索跟着一起报上去', asks.length && 'username' in asks[0].payload);

    const u = t.$('#u'), p = t.$('#p');
    const trackU = installTracker(t.win, u);
    const trackP = installTracker(t.win, p);
    t.fill({ username: 'me@example.com', password: 'pw-123' });

    check('用户名写进了输入框', u.value === 'me@example.com', u.value);
    check('密码写进了输入框', p.value === 'pw-123', p.value);
    check('派发了 input 事件', trackU().inputs >= 1 && trackP().inputs >= 1);
    check('派发了 change 事件', trackU().changes >= 1 && trackP().changes >= 1);
    check('受控组件能感知到值变化（会触发 onChange）', trackU().seen && trackP().seen,
      `user=${trackU().seen} pw=${trackP().seen}`);
    t.close();
  }

  /* 反例校验：证明上面的 tracker 不是摆设，旧写法在这里会红 */
  console.log('\n[A2] 旧写法确实会被受控组件吞掉');
  {
    const t = boot('<input id="x" type="text" />');
    await sleep(30);
    const x = t.$('#x');
    const track = installTracker(t.win, x);
    x.value = 'direct';   // 旧代码就是这么写的
    x.dispatchEvent(new t.win.Event('input', { bubbles: true }));
    check('直接赋值时框架感知不到值变化（回归测试有鉴别力）', !track().seen);
    t.close();
  }

  /* ================================================================ *
   * [B] 多个密码框：注册框 / 蜜罐框不该让登录页整个问不出口
   * ================================================================ */
  console.log('\n[B] 登录页同时挂着注册框 / 蜜罐框');
  {
    const t = boot(
      '<form id="reg" style="display:none">' +
      '  <input id="rp1" type="password" autocomplete="new-password" />' +
      '  <input id="rp2" type="password" autocomplete="new-password" />' +
      '</form>' +
      FORM(
        '<input id="u" type="text" name="account" />' +
        '<input id="honey" type="password" hidden />' +
        '<input id="p" type="password" autocomplete="current-password" />'
      )
    );
    await sleep(60);
    check('有两个以上密码框时仍然开口问', t.asks().length >= 1, '实际 ' + t.asks().length);
    t.fill({ username: 'me', password: 'pw-123' });
    check('填的是登录那个密码框', t.$('#p').value === 'pw-123');
    check('没填进隐藏的蜜罐框', t.$('#honey').value === '');
    check('没填进注册框', t.$('#rp1').value === '' && t.$('#rp2').value === '');
    t.close();
  }

  /* ================================================================ *
   * [C] 开口后 SPA 把 DOM 整个换掉：回填不能丢
   * ================================================================ */
  console.log('\n[C] 开口与回填之间 DOM 被重绘');
  {
    const t = boot(FORM(
      '<input id="u1" type="text" name="user" />' +
      '<input id="p1" type="password" />'
    ));
    await sleep(60);
    check('重绘前已经问过一次', t.asks().length >= 1);
    const f = t.$('#f');
    f.innerHTML = '<input id="u2" type="text" name="user" />' +
      '<input id="p2" type="password" autocomplete="current-password" />';
    t.fill({ username: 'me', password: 'pw-123' });
    check('回填落到了重绘后的新密码框', t.$('#p2').value === 'pw-123');
    check('回填落到了重绘后的新用户名框', t.$('#u2').value === 'me');
    t.close();
  }

  /* ================================================================ *
   * [D] 用户名框按语义挑，别抓到搜索框 / 验证码框
   * ================================================================ */
  console.log('\n[D] 用户名框识别');
  {
    const t = boot(
      '<input id="search" type="text" name="search" />' +
      FORM(
        '<input id="code" type="text" name="captcha" />' +
        '<input id="u" type="text" name="account" autocomplete="username" />' +
        '<input id="p" type="password" />'
      )
    );
    await sleep(60);
    t.fill({ username: 'me', password: 'pw-123' });
    check('填进 autocomplete=username 那个', t.$('#u').value === 'me');
    check('没填进验证码框', t.$('#code').value === '');
    check('没填进搜索框', t.$('#search').value === '');
    t.close();
  }

  /* ================================================================ *
   * [E] 异步渲染的登录框（MutationObserver）
   * ================================================================ */
  console.log('\n[E] 登录框异步挂载');
  {
    const t = boot('<div id="root">加载中</div>');
    await sleep(30);
    check('还没有表单时不乱问', t.asks().length === 0);
    t.$('#root').innerHTML = FORM(
      '<input id="u" type="text" name="user" />' +
      '<input id="p" type="password" />'
    );
    await sleep(40);
    check('表单晚到也被接住', t.asks().length >= 1, '实际 ' + t.asks().length);
    t.fill({ username: 'me', password: 'pw-123' });
    check('异步表单照样填得上', t.$('#p').value === 'pw-123');
    t.close();
  }

  /* ================================================================ *
   * [F] 安全边界：不覆盖已输入的值、不重复填、没开口不填
   * ================================================================ */
  console.log('\n[F] 不覆盖用户输入 / 不重复填');
  {
    const t0 = boot(FORM(
      '<input id="u" type="text" name="user" />' +
      '<input id="p" type="password" value="already" />'
    ));
    await sleep(60);
    check('密码框已有值时不开口（不覆盖用户正在输入的内容）', t0.asks().length === 0,
      '实际 ' + t0.asks().length);
    t0.fill({ username: 'me', password: 'pw-123' });
    check('没开口时伪造的回填消息被忽略', t0.$('#p').value === 'already');
    t0.close();

    const t1 = boot(FORM(
      '<input id="u" type="text" name="user" />' +
      '<input id="p" type="password" />'
    ));
    await sleep(60);
    t1.fill({ username: 'me', password: 'pw-123' });
    t1.$('#p').value = 'manual';
    t1.fill({ username: 'other', password: 'another' });
    check('填过一次后不再覆盖用户改过的值', t1.$('#p').value === 'manual');
    t1.close();
  }

  /* ================================================================ *
   * [G] 提交上报（保存密码那半条链路）没被带坏
   * ================================================================ */
  console.log('\n[G] 提交表单仍会上报 nova-login');
  {
    const t = boot(FORM(
      '<input id="u" type="text" name="user" />' +
      '<input id="p" type="password" />'
    ));
    t.$('#u').value = 'me';
    t.$('#p').value = 'pw-123';
    t.submit(t.$('#f'));
    const login = t.sent.filter((x) => x.ch === 'nova-login');
    check('提交时上报一条登录信息', login.length === 1);
    check('带上用户名与密码、标成登录', login.length
      && login[0].payload.username === 'me'
      && login[0].payload.password === 'pw-123'
      && login[0].payload.kind === 'login');
    t.close();
  }

  /* ================================================================ *
   * [H] 宿主那一刻没准备好时，同一条消息要能补发
   * ================================================================ */
  console.log('\n[H] 没等到回填时补偿重发');
  {
    const t = boot(FORM(
      '<input id="u" type="text" name="user" />' +
      '<input id="p" type="password" />'
    ));
    await sleep(60);
    const first = t.asks().length;
    check('开口时发了一次', first === 1, '实际 ' + first);
    await sleep(1700);
    check('没等到回填会补发一次', t.asks().length > first,
      first + ' -> ' + t.asks().length);
    t.fill({ username: 'me', password: 'pw-123' });
    const after = t.asks().length;
    await sleep(1700);
    check('回填到了就停，不再打扰宿主', t.asks().length === after,
      after + ' -> ' + t.asks().length);
    t.close();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
