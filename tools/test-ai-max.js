'use strict';

/**
 * AI 窗口「最大化 / 还原」行为测试（真实 DOM，jsdom）
 * 用法：node tools/test-ai-max.js
 *
 * 重点验证「当前画面不丢失」：最大化只是改尺寸，不重建 webview、不重载当前页，
 * 正在看的那场对话原样保留；还原后回到贴着 AI 按钮的小窗。
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

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));

  // 等启动完成（引擎菜单渲染出来说明 shell.js 已跑完初始化）
  for (let i = 0; i < 60 && !$('#engine-menu-list .em-item'); i++) await sleep(50);

  const panel = $('#ai-panel');
  check('AI 面板与最大化按钮已挂载', !!panel && !!$('#ai-max') && !!$('#ai-close'));

  console.log('\n[A] 打开面板');
  window.eval('openAiPanel()');
  await sleep(10);
  check('面板已打开', panel.classList.contains('is-open'));
  check('初始未最大化', !panel.classList.contains('is-max'));
  check('最大化按钮标题为「最大化」', $('#ai-max').title === '最大化');

  // 造一个「正在看的画面」：webview 已载入某 AI 页、对话聊到一半。
  // 这些都只是给 DOM 打标记，用来验证最大化前后**是同一个节点、内容没动**。
  window.eval("const w=document.querySelector('#ai-webview'); w.setAttribute('src','https://chat.deepseek.com/'); w.dataset.msg='half-typed';");
  const srcBefore = window.eval("document.querySelector('#ai-webview').getAttribute('src')");

  console.log('\n[B] 点「最大化」');
  $('#ai-max').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(10);
  check('进入最大化态（is-max）', panel.classList.contains('is-max'));
  check('按钮标题变为「还原」', $('#ai-max').title === '还原');
  check('图标切到还原态（max 藏、restore 露）',
    window.eval("(function(){var p=document.querySelector('#ai-panel');return p.classList.contains('is-max');})()"),
    'is-max 由 CSS 控制图标显隐');
  check('清掉了内联 top/right/maxHeight（交给 .is-max 布局）',
    panel.style.top === '' && panel.style.right === '' && panel.style.maxHeight === '');

  console.log('\n[C] 当前画面不丢失');
  check('webview 是同一个节点、没被重建', window.eval("document.querySelector('#ai-webview').dataset.msg") === 'half-typed');
  check('webview 地址未变（没重载）', window.eval("document.querySelector('#ai-webview').getAttribute('src')") === srcBefore);
  check('API 对话容器仍在（未清空）', !!$('#ai-chat') && !!$('#ai-api'));

  console.log('\n[D] 最大化时窗口 resize 不冲掉布局');
  window.eval('positionAiPanel()');
  await sleep(5);
  check('positionAiPanel 在最大化下是空操作', panel.classList.contains('is-max') && panel.style.top === '');

  console.log('\n[E] 点「还原」');
  $('#ai-max').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(10);
  check('退出最大化态', !panel.classList.contains('is-max'));
  check('按钮标题回到「最大化」', $('#ai-max').title === '最大化');
  check('还原后重新按 AI 按钮定位（内联 top 已写回）', panel.style.top !== '');
  check('webview 仍在、内容没丢', window.eval("document.querySelector('#ai-webview').dataset.msg") === 'half-typed');

  console.log('\n[F] 样式确实定义了最大化布局');
  const cssText = fs.readFileSync(path.join(root, 'src/renderer/shell.css'), 'utf8');
  check('CSS 有 .ai-panel.is-max 布局规则', /\.ai-panel\.is-max\s*\{[^}]*inset|\.ai-panel\.is-max\s*\{[^}]*top:\s*16px/.test(cssText));
  check('CSS 让 is-max 下 body 撑满', /\.ai-panel\.is-max \.ai-body\s*\{[^}]*flex:\s*1 1 auto/.test(cssText));

  console.log('\n[G] 运行时错误');
  check('渲染层无未捕获异常', errors.length === 0, errors.join(' | ') || '无');

  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
