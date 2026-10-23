'use strict';

/**
 * HTTP 认证（Basic / Digest）测试（真实 DOM，jsdom）
 * 用法：node tools/test-http-auth.js
 *
 * 这类站点就是「地址栏先弹个小窗要用户名密码，填完才露出真正的登录页」那种
 * （例如 http://host:8228/xxx）。Electron 的默认行为是把认证**一律取消**，
 * 表现就是白屏 / 打不开，所以必须自己接管：
 *   - <webview>（标签页）的 login 事件在渲染层就地弹框；
 *   - 主进程里普通窗口（AI 独立窗口等）的认证转发过来，共用同一个框；
 *   - 取消 / Esc / 点遮罩都要让 Chromium 放弃这次认证，而不是拿空账号去碰 401。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

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
  console.error('\n缺少 jsdom（仅测试需要）。装法见 README。\n');
  process.exit(2);
}
const { JSDOM } = loadJsdom();

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dom = await JSDOM.fromFile(path.join(root, 'src/renderer/shell.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const doc = window.document;
  const $ = (s) => doc.querySelector(s);

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));

  // 等启动完成（引擎菜单渲染出来说明 shell.js 已跑完初始化）
  for (let i = 0; i < 60 && !$('#engine-menu-list .em-item'); i++) await sleep(50);

  console.log('\n[A] 认证框挂载');
  check('DOM 里有 #auth-dlg', !!$('#auth-dlg'));
  check('默认收起', $('#auth-dlg').hidden);
  check('有用户名输入框', !!$('#auth-user'));
  check('密码框是 password 类型', !!$('#auth-pass') && $('#auth-pass').type === 'password');
  check('有登录 / 取消两个按钮', !!$('#auth-ok') && !!$('#auth-cancel'));

  console.log('\n[B] 标签页（<webview>）要认证：弹框并把凭据回传');
  // 造一次真实的认证请求：host/port/realm/scheme 就是 Electron 给的那套 authInfo
  window.eval([
    "window.__authCb = null;",
    "onWebviewLogin({",
    "  authInfo: { host: '103.237.248.155', port: 8228, realm: 'Restricted Area', scheme: 'basic' },",
    "  callback: function (u, p) { window.__authCb = { u: u, p: p }; }",
    "});"
  ].join(''));
  await sleep(20);
  check('认证框弹出来了', !$('#auth-dlg').hidden);
  check('标题是「需要登录」', $('#auth-title').textContent === '需要登录', $('#auth-title').textContent);
  check('副标题写明是哪个地址在要账',
    /103\.237\.248\.155:8228/.test($('#auth-sub').textContent), $('#auth-sub').textContent);
  check('副标题带上 realm', /Restricted Area/.test($('#auth-sub').textContent));
  check('提示里说明了认证方式（BASIC）', /BASIC/.test($('#auth-tip').textContent), $('#auth-tip').textContent);

  $('#auth-user').value = 'admin';
  $('#auth-pass').value = 's3cret';
  $('#auth-ok').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(20);
  const cb = window.__authCb;
  check('用户名回给了 Electron 的 callback', cb && cb.u === 'admin', JSON.stringify(cb));
  check('密码原样回传（没被改）', cb && cb.p === 's3cret', cb && cb.p);
  check('填完框收起', $('#auth-dlg').hidden);

  console.log('\n[C] 取消 = 放弃这次认证（不能拿空账号去碰 401）');
  window.eval([
    "window.__authCb = null;",
    "onWebviewLogin({ authInfo: { host: 'a.com', port: 80 },",
    "  callback: function (u, p) { window.__authCb = { u: u, p: p }; } });"
  ].join(''));
  await sleep(20);
  $('#auth-cancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(20);
  check('回传的是 null（放弃认证）',
    window.__authCb && window.__authCb.u === null && window.__authCb.p === null,
    JSON.stringify(window.__authCb));
  check('框已收起', $('#auth-dlg').hidden);

  console.log('\n[D] Esc 关闭 = 取消');
  window.eval([
    "window.__authCb = null;",
    "onWebviewLogin({ authInfo: { host: 'b.com' },",
    "  callback: function (u, p) { window.__authCb = { u: u, p: p }; } });"
  ].join(''));
  await sleep(20);
  check('框已弹出', !$('#auth-dlg').hidden);
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(20);
  check('Esc 后框收起', $('#auth-dlg').hidden);
  check('Esc 也按取消处理', window.__authCb && window.__authCb.u === null);

  console.log('\n[E] 密码框里回车 = 登录');
  window.eval([
    "window.__authCb = null;",
    "onWebviewLogin({ authInfo: { host: 'c.com' },",
    "  callback: function (u, p) { window.__authCb = { u: u, p: p }; } });"
  ].join(''));
  await sleep(20);
  $('#auth-user').value = 'u1';
  $('#auth-pass').value = 'pw1';
  $('#auth-pass').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(20);
  check('回车回传了凭据',
    window.__authCb && window.__authCb.u === 'u1' && window.__authCb.p === 'pw1',
    JSON.stringify(window.__authCb));
  check('回车后框收起', $('#auth-dlg').hidden);

  console.log('\n[F] 代理认证：文案要说清是代理在要账');
  window.eval([
    "window.__authCb = null;",
    "onWebviewLogin({ authInfo: { isProxy: true, host: 'proxy.corp', port: 3128 },",
    "  callback: function (u, p) { window.__authCb = { u: u, p: p }; } });"
  ].join(''));
  await sleep(20);
  check('标题是「代理服务器需要验证」',
    $('#auth-title').textContent === '代理服务器需要验证', $('#auth-title').textContent);
  check('提示文案指向代理', /代理/.test($('#auth-tip').textContent), $('#auth-tip').textContent);
  window.eval('closeAuthDialog(null)');
  await sleep(10);

  console.log('\n[G] 主进程转发来的认证（AI 独立窗口等）：共用同一个框');
  let resolved = null;
  window.nova.auth.resolve = async (reqId, user, pass) => {
    resolved = { reqId, user, pass };
    return { ok: true };
  };
  window.nova.__emit('auth:request', { reqId: 7, authInfo: { host: 'ai.example.com', port: 443, scheme: 'digest' } });
  await sleep(20);
  check('转发来的请求也弹框了', !$('#auth-dlg').hidden);
  check('提示里写了 DIGEST', /DIGEST/.test($('#auth-tip').textContent), $('#auth-tip').textContent);
  $('#auth-user').value = 'ai-user';
  $('#auth-pass').value = 'ai-pass';
  $('#auth-ok').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(30);
  check('凭据回给了主进程', !!resolved, JSON.stringify(resolved));
  check('reqId 对得上（解除的是那一次挂起的回调）', resolved && resolved.reqId === 7, resolved && resolved.reqId);
  check('用户名密码一致', resolved && resolved.user === 'ai-user' && resolved.pass === 'ai-pass');

  console.log('\n[H] 防御：拿不到 callback 就不弹框');
  window.eval('closeAuthDialog(null)');
  await sleep(10);
  window.eval("onWebviewLogin({ authInfo: { host: 'x.com' } });");
  await sleep(20);
  check('没有 callback 时不弹（弹了也填了没用）', $('#auth-dlg').hidden);

  console.log('\n[I] 接线没被漏掉（源码级断言）');
  const shellJs = read('src/renderer/shell.js');
  const mainJs = read('src/main/main.js');
  const preloadJs = read('src/preload/preload.js');
  check('webview 创建时挂了 login 监听',
    /addEventListener\('login',\s*onWebviewLogin\)/.test(shellJs));
  check('主进程接管了 app.on(\'login\')（标签页的认证也汇总到这里）', /app\.on\('login'/.test(mainJs));
  // 实测：webview 自己的 login DOM 事件不触发，认证全走 app.on('login')。
  // 所以这里**不能**按 webContents 类型跳过 —— 跳了标签页就没人接管，还是白屏。
  check('没有「webview 跳过」这种分支（否则标签页没人管）',
    !/type === 'webview'\) return/.test(mainJs));
  check('同一个认证只弹一个框（host+port+realm 去重）', /authKeyOf/.test(mainJs));
  check('有 auth:resolve 这个回传口子', /handle\('auth:resolve'/.test(mainJs));
  check("'auth:request' 进了 preload 事件白名单", /'auth:request'/.test(preloadJs));

  console.log('\n[J] 全程无 JS 报错');
  check('没有未捕获的运行时错误', errors.length === 0, errors.join(' | '));

  console.log(`\n结果：${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})();
