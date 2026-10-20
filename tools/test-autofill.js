'use strict';

/**
 * 自动带入账号密码的行为测试 —— 真实 DOM，jsdom
 * 用法：node tools/test-autofill.js
 *
 * 覆盖用户报过的问题：「网页密码可以提示保存，但再次打开该网站时还要输入密码」。
 * 保存了却每次手输，等于保存只做了一半。
 *
 *   [A] 设置里两个开关（提示保存 / 自动带入）都在，缺省都开
 *   [B] 宿主侧核对：问的是不是本标签页当前地址的 origin
 *   [C] 命中一条就回填（webview.send → 页面 preload 填框）
 *   [D] 同一站点存了多个账号时不猜，取最近保存的那条
 *   [E] 解密失败（换过 Windows 账户）时安静放过，不打扰用户
 *
 * 页面侧那段在 src/preload/webview-preload.js，它要 ipcRenderer，jsdom 里跑不动；
 * 两端接线由 tools/check-shell.js 的静态断言钉住。
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
  const $$ = (s) => [...doc.querySelectorAll(s)];
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));

  const waitFor = async (fn, timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (fn()) return true;
      await sleep(30);
    }
    return false;
  };

  for (let i = 0; i < 80 && $$('#engine-menu-list .em-item').length === 0; i++) await sleep(50);
  check('外壳初始化完成（内核菜单已渲染）', $$('#engine-menu-list .em-item').length > 0);

  /* ================================================================ *
   * [A] 设置里的两个开关
   * ================================================================ */
  console.log('\n[A] 密码设置里的两个开关');
  window.eval("openSettings(); renderSettingsSection('passwords')");
  await sleep(200);
  const rows = $$('[data-act]');
  check('有「登录后提示保存密码」开关', rows.some((b) => b.dataset.act === 'pwd-toggle'));
  check('有「打开网站时自动填入」开关', rows.some((b) => b.dataset.act === 'autofill-toggle'));
  check('自动填入默认是开的',
    !!$('[data-act="autofill-toggle"]') && $('[data-act="autofill-toggle"]').classList.contains('is-on'));

  // 点一下关掉，再点开：patch 要落到 settings 里，不然下一次进来又是开着的
  click($('[data-act="autofill-toggle"]'));
  await sleep(120);
  check('点一下能关掉', !$('[data-act="autofill-toggle"]').classList.contains('is-on'));
  check('关的状态写进了设置', window.eval('state.settings.passwords.autofill') === false);
  click($('[data-act="autofill-toggle"]'));
  await sleep(120);
  check('再点一下能打开', $('[data-act="autofill-toggle"]').classList.contains('is-on'));
  window.eval('closeSettings()');

  /* ================================================================ *
   * 造一个「假 webview」：只记录 send() 收到的消息
   * ================================================================ */
  const sent = [];
  const tab = window.eval('activeTab()');
  check('有活动标签页可用', !!tab);
  if (!tab) { report(); }
  tab.url = 'https://site.test/login';
  tab.webview = {
    tagName: 'WEBVIEW',
    send: (ch, msg) => sent.push({ ch, msg })
  };

  const list = [
    { id: 'c1', origin: 'https://site.test', username: 'me', ts: 200 },
    { id: 'c2', origin: 'https://site.test', username: 'work', ts: 100 },
    { id: 'c3', origin: 'https://other.test', username: 'someone', ts: 300 }
  ];
  const realList = window.nova.credentials.list;
  const realReveal = window.nova.credentials.reveal;
  window.nova.credentials.list = async () => list;
  window.nova.credentials.reveal = async (id) => ({ ok: true, password: 'pw-' + id });

  /* ================================================================ *
   * [B] origin 核对
   * ================================================================ */
  console.log('\n[B] 只认本标签页当前地址的 origin');
  window.eval('state').credentials = list.slice();
  await window.eval('autofillLogin')(tab, { origin: 'https://evil.test' });
  check('问的是别的站点 → 什么都不给', sent.length === 0, JSON.stringify(sent));

  window.eval('state').settings.passwords.autofill = false;
  await window.eval('autofillLogin')(tab, { origin: 'https://site.test' });
  check('开关关掉后不再自动带入', sent.length === 0);
  window.eval('state').settings.passwords.autofill = true;

  /* ================================================================ *
   * [C] 命中 → 回填
   * ================================================================ */
  console.log('\n[C] 命中的站点回填账号密码');
  sent.length = 0;
  await window.eval('autofillLogin')(tab, { origin: 'https://site.test' });
  check('发回了 nova-cred-fill', sent.length === 1 && sent[0].ch === 'nova-cred-fill', JSON.stringify(sent[0] && sent[0].ch));
  const m = sent[0] && sent[0].msg;
  check('带上了用户名', !!m && m.username === 'me', m && m.username);
  check('带上了密码', !!m && m.password === 'pw-c1', m && m.password);

  // 同一站点存了多个账号（c1 / c2）：不猜，取最近保存的那条（ts 大的）
  console.log('\n[D] 同一站点多个账号取最近保存的那条');
  check('取的是最近保存的那条', !!m && m.username === 'me' && m.password === 'pw-c1',
    `${m && m.username} / ${m && m.password}`);

  /* ================================================================ *
   * [E] 解密失败 → 安静放过
   * ================================================================ */
  console.log('\n[E] 解密失败不打扰用户');
  window.nova.credentials.reveal = async () => ({ ok: false, error: '解密失败' });
  sent.length = 0;
  await window.eval('autofillLogin')(tab, { origin: 'https://site.test' });
  check('解不开密码时什么都不填', sent.length === 0);

  window.nova.credentials.list = realList;
  window.nova.credentials.reveal = realReveal;
  window.eval('closeSettings()');

  check('走完全流程无异常', errors.length === 0, errors.join(' | ') || '无');
  report();

  function report() {
    console.log(`\n结果：${pass}/${pass + fail} 通过`);
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
