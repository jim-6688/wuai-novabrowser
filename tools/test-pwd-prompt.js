'use strict';

/**
 * 「保存密码」提示的行为测试 —— 真实 DOM，jsdom
 * 用法：node tools/test-pwd-prompt.js
 *
 * 覆盖用户报的问题：「缺少提示保存密码」。
 *   [A] 网页提交登录表单（preload → nova-login）→ 右下角气泡出现
 *   [B] 点「保存」→ 交给主进程，origin 不由渲染层提供
 *   [C] 密码跟已存的一样就不再问（「记住我」每次自动提交，不能每次都弹）
 *   [D] 密码变了 → 提示，按钮变成「更新」
 *   [E] 「不保存」只收起这一次，下次登录还会问
 *   [F] 「此站不再提示」写进 settings.passwords.neverFor，之后不再问
 *   [G] 设置里关掉「登录后提示保存密码」→ 完全不问
 *
 * 这里只验外壳侧接线与去重逻辑。真正落盘（safeStorage 加密）在主进程，
 * 由 src/main/main.js 的 cred:save-from-page 负责。
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

  const waitFor = async (fn, timeout = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (fn()) return true;
      await sleep(25);
    }
    return false;
  };

  for (let i = 0; i < 80 && $$('#engine-menu-list .em-item').length === 0; i++) await sleep(50);
  check('外壳初始化完成', $$('#engine-menu-list .em-item').length > 0);

  /* 桥的桩：记下 saveFromPage 的入参，list/reveal 由各用例自己摆 */
  const calls = { save: [] };
  let stored = [];           // credentials.list() 的返回
  let storedPw = '';         // reveal() 解出来的明文
  const real = {
    list: window.nova.credentials.list,
    reveal: window.nova.credentials.reveal,
    saveFromPage: window.nova.credentials.saveFromPage
  };
  window.nova.credentials.list = async () => stored;
  window.nova.credentials.reveal = async () => (storedPw ? { ok: true, password: storedPw } : { error: '解密失败' });
  window.nova.credentials.saveFromPage = async (wcId, username, password) => {
    calls.save.push({ wcId, username, password });
    return { ok: true, updated: false };
  };

  const tab = window.eval('activeTab()');
  check('有活动标签页', !!tab);
  tab.url = 'https://example.com/login';
  tab.wcId = tab.wcId != null ? tab.wcId : 7;

  /** 模拟 webview preload 的 sendToHost('nova-login', {...})。
   *  jsdom 里没有真 webview，所以直接调外壳的这条消息处理器（真实运行时由
   *  `wv.addEventListener('ipc-message', …)` 转进来，转接那一行见 mountTab）。 */
  const submitLogin = async (username, password) => {
    window.eval('handleWebviewIpc')(tab, { channel: 'nova-login', args: [{ username, password }] });
    await sleep(60);
  };
  const promptOpen = () => $('#pwd-prompt').hidden === false;
  const dismiss = () => { if (promptOpen()) click($('#pwd-never')); };

  /* ================================================================ *
   * [A] 提交登录表单 → 气泡出现
   * ================================================================ */
  console.log('\n[A] 登录后询问是否保存');
  check('气泡初始是收起的', $('#pwd-prompt').hidden === true);

  await submitLogin('alice', 's3cret');
  const shown = await waitFor(promptOpen);
  check('提交登录表单后气泡出现', shown);
  check('气泡写的是当前站点', $('#pwd-site').textContent === 'example.com', $('#pwd-site').textContent);
  check('气泡写的是用户名', $('#pwd-user').textContent === 'alice', $('#pwd-user').textContent);
  check('按钮是「保存」', $('#pwd-save').textContent === '保存', $('#pwd-save').textContent);

  /* ================================================================ *
   * [B] 保存
   * ================================================================ */
  console.log('\n[B] 保存到本机');
  click($('#pwd-save'));
  const saved = await waitFor(() => calls.save.length === 1);
  check('点「保存」后交给了主进程', saved);
  check('带上的是当前页的 wcId', calls.save[0] && calls.save[0].wcId === tab.wcId, String(calls.save[0] && calls.save[0].wcId));
  check('带上了用户名与密码', calls.save[0] && calls.save[0].username === 'alice' && calls.save[0].password === 's3cret');
  check('保存后气泡收起', $('#pwd-prompt').hidden === true);
  check('渲染层不提供 origin（由主进程反查）',
    calls.save[0] && !('origin' in calls.save[0]));

  /* ================================================================ *
   * [C] 密码没变 → 不再问
   * ================================================================ */
  console.log('\n[C] 密码没变就不再打扰');
  stored = [{ id: 'c1', origin: 'https://example.com', username: 'alice' }];
  storedPw = 's3cret';
  await submitLogin('alice', 's3cret');
  await sleep(300);
  check('已存过同样的密码 → 不弹气泡', $('#pwd-prompt').hidden === true);

  /* ================================================================ *
   * [D] 密码变了 → 提示「更新」
   * ================================================================ */
  console.log('\n[D] 改过密码要能更新');
  await submitLogin('alice', 'n3w-pass');
  const shown2 = await waitFor(promptOpen);
  check('密码变了 → 再问一次', shown2);
  check('按钮变成「更新」', $('#pwd-save').textContent === '更新', $('#pwd-save').textContent);
  dismiss();
  check('「不保存」能收起气泡', $('#pwd-prompt').hidden === true);

  /* ================================================================ *
   * [E] 「不保存」只针对这一次
   * ================================================================ */
  console.log('\n[E] 「不保存」只管这一次');
  await submitLogin('alice', 'n3w-pass');
  const again = await waitFor(promptOpen);
  check('下次登录还会问（没被永久关掉）', again);
  dismiss();

  /* ================================================================ *
   * [F] 此站不再提示
   * ================================================================ */
  console.log('\n[F] 此站不再提示');
  await submitLogin('alice', 'n3w-pass');
  await waitFor(promptOpen);
  click($('#pwd-never-site'));
  const muted = await waitFor(() => {
    const s = window.eval('state.settings.passwords && state.settings.passwords.neverFor');
    return Array.isArray(s) && s.indexOf('https://example.com') >= 0;
  });
  check('站点进了 neverFor', muted, JSON.stringify(window.eval('state.settings.passwords.neverFor')));
  check('气泡收起', $('#pwd-prompt').hidden === true);

  await submitLogin('alice', 'n3w-pass');
  await sleep(300);
  check('这个站点之后不再问', $('#pwd-prompt').hidden === true);

  /* ================================================================ *
   * [G] 设置里的总开关
   * ================================================================ */
  console.log('\n[G] 设置里可以彻底关掉');
  window.eval('state.settings.passwords.neverFor = []');
  window.eval('state.settings.passwords.promptSave = false');
  await submitLogin('alice', 'n3w-pass');
  await sleep(300);
  check('关掉总开关后完全不问', $('#pwd-prompt').hidden === true);

  // 顺手验一下设置页里那个开关确实读的是同一个键
  window.eval('state.settings.passwords.promptSave = true');
  window.eval('renderSettingsSection("passwords")');
  await waitFor(() => !!$('[data-act="pwd-toggle"]'));
  check('设置 → 密码 里有「登录后提示保存密码」开关', !!$('[data-act="pwd-toggle"]'));
  check('开关状态跟配置一致（开着）', $('[data-act="pwd-toggle"]').classList.contains('is-on'));

  window.nova.credentials.list = real.list;
  window.nova.credentials.reveal = real.reveal;
  window.nova.credentials.saveFromPage = real.saveFromPage;

  console.log('\n[H] 运行时错误');
  check('走完全流程仍无异常', errors.length === 0, errors.join(' | ') || '无');

  console.log(`\n结果：${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
