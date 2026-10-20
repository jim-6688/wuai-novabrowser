'use strict';

/**
 * 顶栏「工具」菜单行为测试（真实 DOM，jsdom）
 * 用法：node tools/test-tools-menu.js
 *
 * 验证：按钮摆在「关于」左面、点击开合、列出新增功能、点项执行并收起、
 * 点外面 / Esc 收起，全程无未捕获异常。
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

  // 等启动完成（引擎菜单渲染出来说明 shell.js 已跑完初始化）
  for (let i = 0; i < 60 && $$('#engine-menu-list .em-item').length === 0; i++) await sleep(50);

  const btn = $('#qk-tools');
  const menu = $('#tools-menu');
  check('工具按钮与下拉已挂载', !!btn && !!menu);

  console.log('\n[A] 位置：摆在「关于」左面');
  check('按钮在 .tb-quick 快捷区里', !!btn.closest('.tb-quick'));
  check('工具按钮排在「关于」之前', (() => {
    const kids = [...$('.tb-quick').children];
    const ti = kids.findIndex((k) => k.id === 'qk-tools' || k.querySelector?.('#qk-tools'));
    const ai = kids.findIndex((k) => k.id === 'qk-about' || k.querySelector?.('#qk-about'));
    return ti >= 0 && ai >= 0 && ti < ai;
  })(), [...$('.tb-quick').children].map((k) => k.id || k.className).join(' → '));
  check('菜单初始为关闭', menu.hidden === true);
  check('aria-expanded 初始 false', btn.getAttribute('aria-expanded') === 'false');

  console.log('\n[B] 点击展开');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(10);
  check('点击后菜单展开', menu.hidden === false);
  check('aria-expanded 同步为 true', btn.getAttribute('aria-expanded') === 'true');

  console.log('\n[C] 列出新增功能');
  const rows = $$('#tools-menu-list .em-item');
  check('每一项都是一行菜单项', rows.length >= 5, `${rows.length} 项`);
  const labels = rows.map((r) => (r.querySelector('.em-name') || {}).textContent);
  check('含命令面板与站点权限（最新加入的）',
        labels.includes('命令面板') && labels.includes('站点权限'), labels.join(' / '));
  check('含网址分享 / 密码 / 插件商店 / AI / 嗅探',
        ['网址分享', '密码管理', '插件商店', 'AI 助手', '媒体嗅探'].every((l) => labels.includes(l)));
  check('每项带图标与副标题', rows.every((r) => r.querySelector('.em-ico') && r.querySelector('.em-sub')));

  console.log('\n[D] 点「命令面板」执行并收起');
  rows.find((r) => r.querySelector('.em-name').textContent === '命令面板')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(10);
  check('菜单已收起', menu.hidden === true);
  check('命令面板已打开', $('#cmd-palette').hidden === false);
  window.eval('closeCmdPalette()');

  console.log('\n[E] 点「站点权限」打开设置分区');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(5);
  $$('#tools-menu-list .em-item').find((r) => r.querySelector('.em-name').textContent === '站点权限')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(10);
  check('菜单已收起', menu.hidden === true);
  check('设置页切到「站点权限」分区',
        $('#sv-path').textContent === '站点权限' && $('#settings-view').hidden === false,
        ($('#sv-path') || {}).textContent);
  window.eval('closeSettings()');

  console.log('\n[F] 点外面收起');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(5);
  check('再次展开', menu.hidden === false);
  doc.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(5);
  check('点别处后收起', menu.hidden === true);

  console.log('\n[G] Esc 收起');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(5);
  check('展开后可见', menu.hidden === false);
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(5);
  check('Esc 后收起', menu.hidden === true);

  console.log('\n[H] toggle：再点一次也收起');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(5);
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(5);
  check('第二次点击收起（toggle）', menu.hidden === true);

  console.log('\n[I] 运行时错误');
  check('渲染层无未捕获异常', errors.length === 0, errors.join(' | ') || '无');

  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
