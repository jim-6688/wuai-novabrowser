'use strict';

/**
 * 「保存密码 / 改密自动更新」的行为测试 —— 真实 DOM，jsdom
 * 用法：node tools/test-pwd-prompt.js
 *
 * 覆盖用户要的闭环：「保存后重新访问自动填，改密后自动更新」。
 *   [A] 首次提交登录表单 → 右下角气泡问「要不要保存」
 *   [B] 点「保存」→ 交给主进程，origin 不由渲染层提供
 *   [C] 密码跟已存的一样 → 什么都不做（「记住我」自动提交的常态）
 *   [D] 密码变了 → 静默自动更新，不再弹「更新」让用户点一次
 *   [E] 关掉自动更新 → 退回气泡；「不保存」只管这一次；「此站不再提示」写 neverFor
 *   [F] neverFor 的站点连自动更新也跳过
 *   [G] 改密表单（kind:'change'）→ 更新已有记录；多账号不猜；无记录直接忽略
 *   [H] 设置里关掉「提示保存」→ 新记录完全不问
 *   [I] 设置页三个开关都在，自动更新默认开
 *
 * 只验外壳侧接线与去重逻辑。真正落盘（safeStorage 加密）在主进程，
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
  const submitLogin = async (username, password, kind) => {
    const arg = { username, password };
    if (kind) arg.kind = kind;
    window.eval('handleWebviewIpc')(tab, { channel: 'nova-login', args: [arg] });
    await sleep(60);
  };
  const promptOpen = () => $('#pwd-prompt').hidden === false;
  const dismiss = () => { if (promptOpen()) click($('#pwd-never')); };
  const oneRecord = () => [{ id: 'c1', origin: 'https://example.com', username: 'alice' }];

  /* ================================================================ *
   * [A] 提交登录表单 → 气泡出现
   * ================================================================ */
  console.log('\n[A] 首次登录询问是否保存');
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
   * [C] 密码没变 → 什么都不做
   * ================================================================ */
  console.log('\n[C] 密码没变就不再打扰');
  stored = oneRecord();
  storedPw = 's3cret';
  calls.save.length = 0;
  await submitLogin('alice', 's3cret');
  await sleep(300);
  check('已存过同样的密码 → 不弹气泡', $('#pwd-prompt').hidden === true);
  check('已存过同样的密码 → 也不写盘', calls.save.length === 0);

  /* ================================================================ *
   * [D] 改过密码 → 静默自动更新（用户要的「改密后自动更新」）
   * ================================================================ */
  console.log('\n[D] 改过密码静默自动更新');
  calls.save.length = 0;
  await submitLogin('alice', 'n3w-pass');
  const updated = await waitFor(() => calls.save.length === 1);
  check('密码变了 → 直接写回，不再点「更新」', updated);
  check('不再弹气泡', $('#pwd-prompt').hidden === true);
  check('写回的是新密码', calls.save[0] && calls.save[0].password === 'n3w-pass', calls.save[0] && calls.save[0].password);
  check('写回用的还是原账号名（不会新建重复记录）',
    calls.save[0] && calls.save[0].username === 'alice', calls.save[0] && calls.save[0].username);

  /* ================================================================ *
   * [E] 关掉自动更新 → 退回原来的「弹气泡问一次」
   * ================================================================ */
  console.log('\n[E] 关掉自动更新后退回询问');
  window.eval('state.settings.passwords.autoUpdate = false');
  calls.save.length = 0;
  await submitLogin('alice', 'n3w-pass');
  const shown2 = await waitFor(promptOpen);
  check('关掉自动更新 → 气泡回来了', shown2);
  check('按钮变成「更新」', $('#pwd-save').textContent === '更新', $('#pwd-save').textContent);
  check('没点确认前不会自己写盘', calls.save.length === 0);
  dismiss();
  check('「不保存」能收起气泡', $('#pwd-prompt').hidden === true);

  await submitLogin('alice', 'n3w-pass');
  const again = await waitFor(promptOpen);
  check('「不保存」只管这一次，下次登录还会问', again);

  click($('#pwd-never-site'));
  const muted = await waitFor(() => {
    const s = window.eval('state.settings.passwords && state.settings.passwords.neverFor');
    return Array.isArray(s) && s.indexOf('https://example.com') >= 0;
  });
  check('「此站不再提示」写进 neverFor', muted, JSON.stringify(window.eval('state.settings.passwords.neverFor')));
  check('气泡收起', $('#pwd-prompt').hidden === true);
  await submitLogin('alice', 'n3w-pass');
  await sleep(300);
  check('这个站点之后不再问', $('#pwd-prompt').hidden === true);

  /* ================================================================ *
   * [F] neverFor 连自动更新也跳过（用户说「别管这个站」）
   * ================================================================ */
  console.log('\n[F] 此站不再提示时也不自动更新');
  window.eval('state.settings.passwords.autoUpdate = true');
  calls.save.length = 0;
  await submitLogin('alice', 'n3w-pass');
  await sleep(300);
  check('开着自动更新也不写盘', calls.save.length === 0);
  window.eval('state.settings.passwords.neverFor = []');

  /* ================================================================ *
   * [G] 站内改密表单（多个密码框）→ kind:'change'
   * ================================================================ */
  console.log('\n[G] 站内改密表单自动更新');
  stored = oneRecord();
  storedPw = 's3cret';
  calls.save.length = 0;
  // 改密表单通常没有用户名框，宿主按 origin 找唯一那条
  await submitLogin('', 'ch4nged', 'change');
  const changed = await waitFor(() => calls.save.length === 1);
  check('改密表单直接更新已存记录', changed);
  check('用记录里的用户名作 key', calls.save[0] && calls.save[0].username === 'alice', calls.save[0] && calls.save[0].username);
  check('改密表单不弹气泡', $('#pwd-prompt').hidden === true);

  // 同站点存了多个账号、表单又不带用户名时不猜
  stored = [
    { id: 'c1', origin: 'https://example.com', username: 'alice' },
    { id: 'c2', origin: 'https://example.com', username: 'bob' }
  ];
  calls.save.length = 0;
  await submitLogin('', 'ch4nged', 'change');
  await sleep(200);
  check('多个账号且没用户名 → 不猜、不写盘', calls.save.length === 0);
  check('多个账号 → 也不弹气泡', $('#pwd-prompt').hidden === true);

  // 没有已存记录（注册页 / 别人家的改密页）→ 完全忽略
  stored = [];
  calls.save.length = 0;
  await submitLogin('', 'brand-new', 'change');
  await sleep(200);
  check('没有已存记录 → 绝不新建', calls.save.length === 0);
  check('没有已存记录 → 也不问保存', $('#pwd-prompt').hidden === true);

  /* ================================================================ *
   * [H] 设置里的提示总开关
   * ================================================================ */
  console.log('\n[H] 设置里可以关掉保存提示');
  window.eval('state.settings.passwords.promptSave = false');
  await submitLogin('charlie', 'fresh');   // 没有已存记录 → 走询问路径
  await sleep(300);
  check('关掉总开关后完全不问', $('#pwd-prompt').hidden === true);
  check('关掉总开关后也不擅自新建', calls.save.length === 0);

  /* ================================================================ *
   * [I] 设置页三个开关
   * ================================================================ */
  console.log('\n[I] 设置 → 密码 里的三个开关');
  window.eval('state.settings.passwords.promptSave = true');
  window.eval('state.settings.passwords.autoUpdate = true');
  window.eval('renderSettingsSection("passwords")');
  await waitFor(() => !!$('[data-act="pwd-toggle"]'));
  check('有「登录后提示保存密码」开关', !!$('[data-act="pwd-toggle"]'));
  check('有「打开网站时自动填入」开关', !!$('[data-act="autofill-toggle"]'));
  check('有「改密后自动更新」开关', !!$('[data-act="pwd-autoupdate-toggle"]'));
  check('自动更新默认开着',
    !!$('[data-act="pwd-autoupdate-toggle"]') && $('[data-act="pwd-autoupdate-toggle"]').classList.contains('is-on'));

  window.nova.credentials.list = real.list;
  window.nova.credentials.reveal = real.reveal;
  window.nova.credentials.saveFromPage = real.saveFromPage;

  console.log('\n[J] 运行时错误');
  check('走完全流程仍无异常', errors.length === 0, errors.join(' | ') || '无');

  console.log(`\n结果：${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
