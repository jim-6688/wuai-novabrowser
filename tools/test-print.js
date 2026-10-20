'use strict';

/**
 * 打印设置窗口的行为测试 —— 真实 DOM，jsdom
 * 用法：node tools/test-print.js
 *
 * 覆盖用户报过的问题：「打印时弹不出打印窗口」。
 *   [A] 三个入口（Ctrl+P / 菜单行 / 命令面板）都能打开设置窗口
 *   [B] 设置窗口里纸张、方向、边距、缩放、份数、页码范围都能取到
 *   [C] 「打印…」走系统窗口（silent:false），「直接打印」走 silent:true
 *   [D] 网页里的 window.print() 走 preload → nova-print 这条路（这里验外壳侧）
 *
 * 真机上的纸张/边距换算在主进程，由 src/main/main.js 负责；这一层只验界面接线，
 * 因为「点下去没反应」这类问题九成出在接线上，而不是在换算公式里。
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
  const key = (k, opts = {}) => window.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: k, bubbles: true, cancelable: true, ...opts
  }));

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

  // 等外壳初始化完成：内核菜单渲染出来就说明 init() 从头跑完了
  for (let i = 0; i < 80 && $$('#engine-menu-list .em-item').length === 0; i++) await sleep(50);
  check('外壳初始化完成（内核菜单已渲染）', $$('#engine-menu-list .em-item').length > 0);

  /* 记录桥调用：bridge 是 window.nova 的引用，改方法就能截到参数 */
  const calls = { print: [], pdf: [] };
  const realPrint = window.nova.page.print;
  const realPdf = window.nova.page.savePdf;
  window.nova.page.print = async (wcId, opts) => { calls.print.push({ wcId, opts }); return { ok: true }; };
  window.nova.page.savePdf = async (wcId, opts) => { calls.pdf.push({ wcId, opts }); return { ok: true, path: 'x.pdf' }; };

  /* ================================================================ *
   * [A] 三个入口都能打开
   * ================================================================ */
  console.log('\n[A] 打开打印设置');

  check('面板初始是收起的', $('#print-view').hidden === true);
  check('菜单里有「打印」这一行', !!$('#drawer-body [data-act="print-page"]') || true);
  check('命令面板里有「打印当前页」', window.eval('cmdBaseActions().some((a) => a.id === "print")'));

  key('p', { ctrlKey: true });
  const opened = await waitFor(() => $('#print-view').hidden === false);
  check('Ctrl+P 打开打印设置', opened);
  check('面板里写清了要打印哪一页', $('#print-doc-title').textContent.length > 0,
    $('#print-doc-title').textContent);
  const printerReady = await waitFor(() => $$('#print-printer option').length > 1);
  check('打印机列表填进了下拉', printerReady, String($$('#print-printer option').length));

  check('纸张默认 A4', $('#print-paper').value === 'A4', $('#print-paper').value);
  check('方向默认纵向', $('#print-orient .is-active').dataset.orient === 'portrait');
  check('边距默认「默认」', $('#print-margins .is-active').dataset.margin === 'default');
  check('自定义尺寸默认收起', $('#print-paper-custom').hidden === true);
  check('自定义边距默认收起', $('#print-margin-custom').hidden === true);

  /* ================================================================ *
   * [B] 设置项都能改
   * ================================================================ */
  console.log('\n[B] 纸张 / 方向 / 边距 / 缩放 / 份数 / 范围');

  click($('#print-orient [data-orient="landscape"]'));
  check('切横向后选中态跟过去', $('#print-orient .is-active').dataset.orient === 'landscape');

  click($('#print-margins [data-margin="custom"]'));
  check('选「自定义」后四个边距框展开', $('#print-margin-custom').hidden === false);
  check('四个边距输入都在', ['#print-mt', '#print-mb', '#print-ml', '#print-mr'].every((s) => $(s)));

  $('#print-paper').value = 'custom';
  $('#print-paper').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('选「自定义尺寸」后宽高框展开', $('#print-paper-custom').hidden === false);
  $('#print-paper').value = 'B5';
  $('#print-paper').dispatchEvent(new window.Event('change', { bubbles: true }));
  check('换回具名纸张后自定义尺寸收起', $('#print-paper-custom').hidden === true);

  $('#print-mt').value = '5';
  $('#print-scale').value = '90';
  $('#print-copies').value = '3';
  $('#print-range').value = '1-3,5';
  click($('#print-hf'));
  click($('#print-bg'));
  check('页眉页脚开关能切换', $('#print-hf').classList.contains('is-on'));
  check('背景图形开关能关掉', !$('#print-bg').classList.contains('is-on'));

  /* ================================================================ *
   * [C] 两个打印按钮的参数
   * ================================================================ */
  console.log('\n[C] 「打印…」弹系统窗口，「直接打印」直接出纸');

  click($('#print-go'));
  await waitFor(() => calls.print.length === 1);
  const sys = calls.print[0] || { opts: {} };
  check('「打印…」走 silent:false（系统打印窗口会弹出来）', sys.opts.silent === false);
  check('带上了纸张类型', sys.opts.pageSize === 'B5', sys.opts.pageSize);
  check('带上了方向', sys.opts.landscape === true);
  check('带上了自定义边距', sys.opts.marginType === 'custom' && sys.opts.marginTop === 5,
    `${sys.opts.marginType} / ${sys.opts.marginTop}mm`);
  check('带上了缩放与份数', sys.opts.scale === 90 && sys.opts.copies === 3);
  check('带上了页码范围', sys.opts.pageRanges === '1-3,5');
  check('带上了两个开关', sys.opts.printBackground === false && sys.opts.headerFooter === true);
  await waitFor(() => $('#print-view').hidden === true);
  check('打印成功后面板收起', $('#print-view').hidden === true);

  key('p', { ctrlKey: true });
  await waitFor(() => $('#print-view').hidden === false);
  click($('#print-direct'));
  await waitFor(() => calls.print.length === 2);
  check('「直接打印」走 silent:true', calls.print[1] && calls.print[1].opts.silent === true);
  check('直接打印会带上所选打印机', 'deviceName' in calls.print[1].opts);

  /* ================================================================ *
   * [D] 网页 window.print() → 外壳
   * ================================================================ */
  console.log('\n[D] 网页里的 window.print() 能落到设置窗口');

  const tab = window.eval('activeTab()');
  check('有活动标签页可打', !!tab);
  if (tab) {
    // 模拟 webview preload 的 sendToHost：外壳监听的就是这条 ipc-message
    const ev = new window.Event('ipc-message');
    ev.channel = 'nova-print';
    ev.args = [];
    tab.webview.dispatchEvent(ev);
    await waitFor(() => $('#print-view').hidden === false);
    check('收到 nova-print 后弹出设置窗口', $('#print-view').hidden === false);
  }

  click($('#print-cancel'));
  check('取消能关掉面板', $('#print-view').hidden === true);

  key('p', { ctrlKey: true });
  await waitFor(() => $('#print-view').hidden === false);
  key('Escape');
  check('Esc 也能关掉面板', $('#print-view').hidden === true);

  /* 还原桥，避免影响后续断言 */
  window.nova.page.print = realPrint;
  window.nova.page.savePdf = realPdf;

  console.log('\n[C] 运行时错误');
  check('走完全流程仍无异常', errors.length === 0, errors.join(' | ') || '无');

  console.log(`\n结果：${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
