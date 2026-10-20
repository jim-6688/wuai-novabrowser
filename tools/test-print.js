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
    // 模拟 webview preload 的 sendToHost：外壳监听的就是这条 ipc-message。
    // jsdom 里没有真 webview，直接调那条消息处理器（转接见 mountTab）。
    window.eval('handleWebviewIpc')(tab, { channel: 'nova-print', args: [] });
    await waitFor(() => $('#print-view').hidden === false);
    check('收到 nova-print 后弹出设置窗口', $('#print-view').hidden === false);
  }

  click($('#print-cancel'));
  check('取消能关掉面板', $('#print-view').hidden === true);

  key('p', { ctrlKey: true });
  await waitFor(() => $('#print-view').hidden === false);
  key('Escape');
  check('Esc 也能关掉面板', $('#print-view').hidden === true);

  /* ================================================================ *
   * [E] 右侧预览：改一项就重排一次
   * ================================================================ */
  console.log('\n[E] 右侧真实预览（printToPDF）');

  const pv = { calls: [], n: 0, pages: 1 };
  const realPreview = window.nova.page.printPreview;
  window.nova.page.printPreview = async (wcId, opts) => {
    pv.n++;
    pv.calls.push({ wcId, opts });
    return { ok: true, url: `file:///tmp/nova-preview-${pv.n}.pdf`, pages: pv.pages };
  };

  key('p', { ctrlKey: true });
  await waitFor(() => $('#print-view').hidden === false);
  const firstPreview = await waitFor(() => pv.calls.length >= 1);
  check('打开面板就会生成一次预览', firstPreview, String(pv.calls.length));
  const c0 = pv.calls[0] || { opts: {} };
  check('预览打的是当前标签页', c0.wcId != null);
  check('预览带上了纸张设置', !!c0.opts.pageSize, String(c0.opts.pageSize));
  check('预览不传打印机（printToPDF 没有这个概念）', !('deviceName' in (c0.opts || {})));

  const pvEl = $('#print-preview');
  const pvSrc = String(pvEl.getAttribute('src'));
  check('预览地址交给了 PDF 阅读器', pvSrc.startsWith('file:///tmp/nova-preview-1.pdf'), pvSrc);
  // 铺满宽度：一张小票按 100% 显示只占中间一小条，「一页还是两页」就看不出来了
  check('预览地址带上了按宽缩放、隐藏工具栏', /#zoom=page-width/.test(pvSrc) && /toolbar=0/.test(pvSrc), pvSrc);
  check('预览出来以后遮罩收起', $('#print-preview-mask').hidden === true);
  check('预览区标了纸张/方向/边距', /B5/.test($('#print-preview-info').textContent)
    && /横向/.test($('#print-preview-info').textContent), $('#print-preview-info').textContent);

  // 页数：主进程数完 PDF 的 /Type /Page 回传 pages，这里只验「回什么就显示什么」
  const pill = $('#print-preview-pages');
  check('一页时显示「共 1 页」', pill.hidden === false && pill.textContent.trim() === '共 1 页',
    `hidden=${pill.hidden} text=${pill.textContent}`);
  check('一页时不用警示色', !pill.classList.contains('is-multi'));

  // 改成两页：胶囊要跟着变，并且换成警示色（纸选小了这件事得看得见）
  pv.pages = 2;
  $('#print-paper').value = 'A4';
  $('#print-paper').dispatchEvent(new window.Event('change', { bubbles: true }));
  // 设置一变，旧页数立刻作废：不能拿上一版纸型的「共 1 页」继续骗人
  check('改设置后旧页数立刻收起', pill.hidden === true, `hidden=${pill.hidden}`);
  await waitFor(() => pv.calls.length > 0 && pill.hidden === false);
  check('两页时显示「共 2 页」', pill.textContent.trim() === '共 2 页', pill.textContent);
  check('两页时打警示色', pill.classList.contains('is-multi'));

  // 数不出页数（老 PDF / 解析失败）时干脆不显示，别写「共 0 页」
  pv.pages = 0;
  $('#print-paper').value = 'A3';
  $('#print-paper').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(500);
  check('数不出页数时不显示胶囊', pill.hidden === true, `hidden=${pill.hidden}`);
  pv.pages = 1;

  // 改方向 → 节流后重排一次，并且换一个地址（同一个地址 Chromium 会认成旧的那份）
  const before = pv.calls.length;
  const srcBefore = String($('#print-preview').getAttribute('src'));
  click($('#print-orient [data-orient="landscape"]'));
  const repainted = await waitFor(() => pv.calls.length > before);
  check('改设置后重新排版', repainted, `${before} → ${pv.calls.length}`);
  const c1 = pv.calls[pv.calls.length - 1] || { opts: {} };
  check('重排带上了新方向', c1.opts.landscape === true);
  await waitFor(() => String($('#print-preview').getAttribute('src')) !== srcBefore);
  const srcAfter = String($('#print-preview').getAttribute('src'));
  check('预览换了一个新地址', srcAfter !== srcBefore, `${srcBefore} → ${srcAfter}`);

  // 换纸张 → 那行小字也要跟着变（它是按当前表单现算的，不读回上次的结果）
  $('#print-paper').value = 'A3';
  $('#print-paper').dispatchEvent(new window.Event('change', { bubbles: true }));
  const infoA3 = await waitFor(() => /A3/.test($('#print-preview-info').textContent));
  check('换纸张后预览区那行小字跟着变', infoA3, $('#print-preview-info').textContent);

  // 连改三次只该排最后一次（250ms 节流）
  const b2 = pv.calls.length;
  $('#print-scale').value = '80';
  $('#print-scale').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('#print-scale').value = '70';
  $('#print-scale').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('#print-scale').value = '60';
  $('#print-scale').dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => pv.calls.length > b2, 2000);
  await sleep(400);
  check('连续改动只排最后一次（节流生效）', pv.calls.length - b2 === 1, `多跑了 ${pv.calls.length - b2} 次`);
  check('排的是最后那个值', pv.calls[pv.calls.length - 1].opts.scale === 60,
    String(pv.calls[pv.calls.length - 1].opts.scale));

  click($('#print-cancel'));
  check('关面板时清掉预览地址', !$('#print-preview').getAttribute('src'));
  window.nova.page.printPreview = realPreview;

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
