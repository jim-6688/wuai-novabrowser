'use strict';

/**
 * 外壳（顶栏那一圈）的行为测试 —— 真实 DOM，jsdom
 * 用法：node tools/test-shell-ui.js
 *
 * 覆盖两处用户报过的问题：
 *   [A] 拼图图标要弹出**独立的扩展启用窗口**（就地开关），不是跳进设置页
 *   [B] 更新状态同时显示在两处（工具栏小窗 + 设置里的「关于」），
 *       进度推来的时候**两处都要跟着走** —— 只画一处，另一处就是假的
 *
 * 引擎/扩展本身的正确性由 test-downloader.js / test-ext-root.js 等验证，
 * 这一层只管界面接线有没有接错。
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

  const waitFor = async (sel, timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if ($(sel)) return true;
      await sleep(30);
    }
    return false;
  };

  // 等外壳初始化完成：内核菜单渲染出来就说明 init() 从头跑完了
  for (let i = 0; i < 80 && $$('#engine-menu-list .em-item').length === 0; i++) await sleep(50);
  check('外壳初始化完成（内核菜单已渲染）', $$('#engine-menu-list .em-item').length > 0);

  /* ================================================================ *
   * [A] 点拼图 → 独立的扩展启用窗口
   * ================================================================ */
  console.log('\n[A] 点拼图 → 独立的扩展启用小窗');

  const exts = window.eval('state.extensions.length');
  check('样例里有扩展（后面几条都靠它）', exts > 0, String(exts));

  check('小窗初始是收起的', $('#ext-popover').hidden === true);
  check('按钮上标着展开态为 false（无障碍属性要跟着走）',
    $('#btn-ext').getAttribute('aria-expanded') === 'false');

  click($('#btn-ext'));
  const gotRows = await waitFor('#ext-pop-list .ext-pop-row');
  check('点一下弹出扩展小窗', gotRows && $('#ext-popover').hidden === false);
  check('展示的是**已装扩展**，不是商店搜索框',
    $$('#ext-pop-list .ext-pop-row').length === exts
      && !$('#ext-pop-list input'),
    String($$('#ext-pop-list .ext-pop-row').length));
  check('没有把人送去设置页（设置视图仍关着）',
    $('#settings-view').hidden === true);
  check('按钮的无障碍属性同步成 true', $('#btn-ext').getAttribute('aria-expanded') === 'true');
  check('每一行都有启用开关', $$('#ext-pop-list .ext-pop-row .switch').length === exts,
    String($$('#ext-pop-list .ext-pop-row .switch').length));
  check('行里标出了版本与当前状态',
    /v1\.52\.2\s*·\s*已启用/.test($('#ext-pop-list .ext-pop-row .ext-pop-ver').textContent),
    $('#ext-pop-list .ext-pop-row .ext-pop-ver').textContent.trim());

  // 就地把一个扩展关掉
  const firstId = $('#ext-pop-list .ext-pop-row .switch').dataset.extToggle;
  click($('#ext-pop-list .ext-pop-row .switch'));
  await sleep(120);

  check('点开关真的把扩展关掉了（不是界面装饰）',
    window.eval(`state.extensions.find(e => e.id === '${firstId}').enabled`) === false);
  check('那一行立刻变成关闭态（压暗 + 开关复位）',
    $('#ext-pop-list .ext-pop-row').classList.contains('is-off')
      && !$('#ext-pop-list .ext-pop-row .switch').classList.contains('is-on'));
  check('没有任何一行还留着旧状态（整列一起重画）',
    $$('#ext-pop-list .ext-pop-row.is-off').length === 1,
    String($$('#ext-pop-list .ext-pop-row.is-off').length));

  // 点外面收起
  click(doc.body);
  await sleep(40);
  check('点小窗外面会收起它', $('#ext-popover').hidden === true);
  check('收起后无障碍属性回到 false', $('#btn-ext').getAttribute('aria-expanded') === 'false');

  // Esc 也能收
  click($('#btn-ext'));
  await sleep(80);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(40);
  check('Esc 也能收起小窗', $('#ext-popover').hidden === true);

  // 底部入口 → 设置里的扩展分区
  click($('#btn-ext'));
  await sleep(80);
  click($('#ext-pop-manage'));
  await waitFor('.ext-card');
  check('「管理全部扩展」跳到设置的扩展分区',
    window.eval('state.settingsSection') === 'extensions',
    String(window.eval('state.settingsSection')));
  check('跳过去的同时小窗收起（不留一个盖在上面的浮层）', $('#ext-popover').hidden === true);
  check('设置页里确实有已装扩展的卡片', $$('.ext-card').length === exts,
    String($$('.ext-card').length));

  // 两处显示同一个开关：设置页里切一下，小窗也要跟着变
  // （按「切完之后应该是什么状态」判，而不是假定点一下就是关 ——
  //  上面那条用例已经把第一个扩展切过一次了，写死方向会读出假失败）
  const sw2 = $('.ext-card .switch');
  const id2 = sw2.dataset.extToggle;
  const willBeOn = !sw2.classList.contains('is-on');
  click(sw2);
  await sleep(120);
  click($('#btn-ext'));
  await sleep(120);
  const row2 = $$('#ext-pop-list .ext-pop-row')
    .find((r) => r.querySelector('.switch').dataset.extToggle === id2);
  check('在设置页里切的开关，小窗里也是切过的样子（两处同一个状态）',
    !!row2 && row2.classList.contains('is-off') === !willBeOn,
    row2 ? `is-off=${row2.classList.contains('is-off')} 期望=${!willBeOn}` : '没找到那一行');
  click(doc.body);
  await sleep(40);

  /* ================================================================ *
   * [B] 更新状态在两处同步
   * ================================================================ */
  console.log('\n[B] 更新进度：两个显示位置都要跟着走');

  // 打开「关于」分区 —— 那一页里也嵌着一块更新状态
  window.eval("openSettings('about')");
  await waitFor('#settings-view .up-bar');
  const blocks = $$('[data-up-block]');
  check('标记 [data-up-block] 的位置至少有两处（工具栏小窗 + 「关于」）',
    blocks.length >= 2, String(blocks.length));
  check('「关于」分区里那一块是标记过的（漏标就会在下载时僵住）',
    !!$('#settings-view [data-up-block]'));

  const widthsIn = (sel) => $$(`${sel} .up-bar i`).map((b) => b.style.width);

  // 主进程推来「开始下载」
  window.nova.__emit('update:state', {
    status: 'downloading', info: { version: '9.9.9' }, percent: 0, error: ''
  });
  await sleep(60);
  check('两处都画出了进度条', widthsIn('[data-up-block]').length >= 2,
    widthsIn('[data-up-block]').join(' '));

  // 推两帧进度
  window.nova.__emit('update:progress', { percent: 37, got: 37, total: 100, speed: 1024 });
  await sleep(60);
  check('进度到 37% 时两处都是 37%（工具栏小窗没开着也要画）',
    widthsIn('[data-up-block]').every((w) => w === '37%'),
    widthsIn('[data-up-block]').join(' '));

  window.nova.__emit('update:progress', { percent: 68, got: 68, total: 100, speed: 1024 });
  await sleep(60);
  check('下一帧 68% 时两处都跟着变了（不是停在第一帧）',
    widthsIn('[data-up-block]').every((w) => w === '68%'),
    widthsIn('[data-up-block]').join(' '));
  check('顶栏角标也显示同一个百分比', $('#update-count').textContent === '68',
    $('#update-count').textContent);
  check('「关于」那一页的文案也跟着更新（不是只改了条形宽度）',
    /68%/.test($('#settings-view [data-up-block]').textContent));

  console.log('\n[C] 运行时错误');
  check('走完全流程仍无异常', errors.length === 0, errors.join(' | ') || '无');

  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n测试自身崩了：', err);
  process.exit(2);
});
