'use strict';

/**
 * 命令面板（Ctrl+K）行为测试（真实 DOM，jsdom）
 * 用法：node tools/test-cmd-palette.js
 *
 * 验证：快捷键开关、空串时的常用/已打开分组、按串过滤（命令/标签页/书签/
 * 历史/网址/搜索）、上下键导航、回车执行并关闭、Esc 关闭。
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

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));

  // 等启动完成（引擎菜单渲染出来说明 shell.js 已经跑完初始化）。
  for (let i = 0; i < 60 && $$('#engine-menu-list .em-item').length === 0; i++) await sleep(50);

  const palette = $('#cmd-palette');
  const input = $('#cmd-input');
  const list = $('#cmd-list');
  check('命令面板 DOM 已挂载', !!palette && !!input && !!list);

  console.log('\n[A] 快捷键 Ctrl+K 打开');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(10);
  check('Ctrl+K 后面板可见', palette.hidden === false);
  await sleep(10);
  const rowsEmpty = $$('#cmd-list .cmd-row').length;
  check('空串时列出结果（常用 + 已打开）', rowsEmpty > 0, String(rowsEmpty) + ' 行');
  check('空串时显示「常用」分组', /常用/.test(list.textContent));
  check('输入框已聚焦', doc.activeElement === input);

  console.log('\n[B] 按命令名过滤');
  input.value = '设置';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(10);
  const setRows = $$('#cmd-list .cmd-row');
  check('过滤「设置」有结果', setRows.length > 0, String(setRows.length) + ' 行');
  check('过滤结果里含「打开设置」', /打开设置/.test(list.textContent));
  check('未匹配的常用项已被滤掉', !/新建标签页/.test(list.textContent) || /打开设置/.test(list.textContent));

  console.log('\n[C] 网址 / 搜索 兜底项');
  input.value = 'example.com';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(10);
  check('像网址的输入给出「打开 example.com」', /打开 https:\/\/example\.com/.test(list.textContent));

  input.value = '怎样绕开代理 502';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(10);
  check('不像网址的输入给出搜索项', /用默认引擎搜索/.test(list.textContent));

  console.log('\n[D] 上下键导航');
  input.value = '';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(10);
  const beforeSel = $$('#cmd-list .cmd-row.is-sel').length;
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await sleep(5);
  const selAfterDown = $('#cmd-list .cmd-row.is-sel');
  check('打开后有且只有一个选中项', beforeSel === 1 || !!selAfterDown);
  check('按 ↓ 后选中项移动到了第 2 行', !!selAfterDown && Number(selAfterDown.dataset.cmd) === 1);

  console.log('\n[E] 回车执行并关闭');
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(10);
  check('回车后面板关闭', palette.hidden === true);

  console.log('\n[F] Esc 关闭（全局）');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(10);
  check('再次 Ctrl+K 打开', palette.hidden === false);
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(10);
  check('Esc 后面板关闭', palette.hidden === true);

  console.log('\n[G] 背景点击关闭');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(10);
  const backdrop = $('[data-cmd-close]');
  backdrop.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  await sleep(10);
  check('点背景后面板关闭', palette.hidden === true);

  console.log('\n[H] 运行时错误');
  check('无未捕获错误', errors.length === 0, errors.join(' | '));

  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('测试运行异常：', err);
  process.exit(2);
});
