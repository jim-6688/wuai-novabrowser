'use strict';
/**
 * 页面加载自愈判定单测（Node，无需 Electron / jsdom）
 * 用法：node tools/test-page-heal.js
 *
 * 覆盖 src/renderer/heal.js：什么算「加载完但没画出来」、什么时候不该自动重载。
 * 最后两组是防漂移检查 —— 确认外壳真的用这份判定，而不是又写了一份。
 */
const fs = require('fs');
const path = require('path');
const H = require(path.join(__dirname, '..', 'src', 'renderer', 'heal.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

console.log('\n[A] isHealableUrl（只对真网页自愈）');
check('https 可自愈', H.isHealableUrl('https://example.com/a') === true);
check('http 可自愈', H.isHealableUrl('http://example.com') === true);
check('about: 不碰', H.isHealableUrl('about:blank') === false);
check('file: 不碰（内置新标签页/本地文件）', H.isHealableUrl('file:///C:/x/newtab.html') === false);
check('chrome-extension: 不碰', H.isHealableUrl('chrome-extension://abc/popup.html') === false);
check('data: 不碰', H.isHealableUrl('data:text/html,hi') === false);
check('devtools 不碰', H.isHealableUrl('devtools://devtools/x') === false);
check('空值不碰', H.isHealableUrl('') === false);
check('undefined 不碰', H.isHealableUrl(undefined) === false);

console.log('\n[B] parseProbe（探针返回值解析）');
const p1 = H.parseProbe('1200|300|5');
check('正常值解析', p1 && p1.h === 1200 && p1.t === 300 && p1.v === 5);
const p2 = H.parseProbe('0|0|0');
check('全零解析', p2 && p2.h === 0 && p2.t === 0 && p2.v === 0);
check('探针抛异常 → null', H.parseProbe('-1|-1|-1') === null);
check('缺字段 → null', H.parseProbe('1200|300') === null);
check('非数字 → null', H.parseProbe('a|b|c') === null);
check('空值 → null', H.parseProbe('') === null);
check('null → null', H.parseProbe(null) === null);
const p3 = H.parseProbe('88|12|0');
check('小数/带空格也能读', p3 && p3.h === 88 && p3.t === 12);

console.log('\n[C] isBlank（阈值判定）');
check('三样全无 → 空白', H.isBlank({ h: 20, t: 0, v: 0 }) === true);
check('高度很矮但有正文 → 不算空白', H.isBlank({ h: 20, t: 40, v: 0 }) === false);
check('高度很矮但有一个图元 → 不算空白', H.isBlank({ h: 20, t: 0, v: 1 }) === false);
check('内容很多 → 不算空白', H.isBlank({ h: 900, t: 500, v: 12 }) === false);
check('只有少量文本（<20）仍算空白', H.isBlank({ h: 30, t: 18, v: 0 }) === true);
check('文本正好 20 不算空白（边界取小于）', H.isBlank({ h: 30, t: 20, v: 0 }) === false);
check('高度到阈值不算空白', H.isBlank({ h: H.MIN_HEIGHT, t: 0, v: 0 }) === false);
check('null 不算空白（不猜）', H.isBlank(null) === false);

console.log('\n[D] shouldHeal（冷却与边界）');
const NOW = 1700000000000;
check('首次遇到空白页 → 该自愈',
  H.shouldHeal({ url: 'https://a.com/x', now: NOW }) === true);
check('同地址 30 秒内 → 不自愈（防循环）',
  H.shouldHeal({ url: 'https://a.com/x', lastUrl: 'https://a.com/x', lastAt: NOW - 30000, now: NOW }) === false);
check('同地址过了冷却 → 可以再来一次',
  H.shouldHeal({ url: 'https://a.com/x', lastUrl: 'https://a.com/x', lastAt: NOW - H.COOLDOWN - 1, now: NOW }) === true);
check('换了地址 → 不受上一个地址的冷却影响',
  H.shouldHeal({ url: 'https://a.com/y', lastUrl: 'https://a.com/x', lastAt: NOW - 1000, now: NOW }) === true);
check('错误页 → 不自愈（那条路归 renderPageError）',
  H.shouldHeal({ url: 'https://a.com/x', hasError: true, now: NOW }) === false);
check('非 http 页面 → 不自愈',
  H.shouldHeal({ url: 'file:///C:/x.html', now: NOW }) === false);
check('空入参不炸', H.shouldHeal() === false);

console.log('\n[E] 探针脚本本身');
check('探针是一段可执行表达式', /^\(function\(\)\{/.test(H.PROBE.trim()));
check('探针读 body 与 documentElement', /document\.body/.test(H.PROBE) && /documentElement/.test(H.PROBE));
check('探针统计可视图元', /querySelectorAll/.test(H.PROBE) && /canvas/.test(H.PROBE));
check('探针自带 try/catch（页面禁用 API 时不抛到外面）', /catch/.test(H.PROBE));

console.log('\n[F] 防漂移：外壳用的是这份判定');
const root = path.join(__dirname, '..');
const shelljs = fs.readFileSync(path.join(root, 'src', 'renderer', 'shell.js'), 'utf8');
const shellhtml = fs.readFileSync(path.join(root, 'src', 'renderer', 'shell.html'), 'utf8');

check('shell.js 引用了 NovaPageHeal', /NovaPageHeal/.test(shelljs));
check('shell.js 里没有第二份探针串', !/HEAL_PROBE/.test(shelljs));
check('shell.js 用 healRules.isBlank 判定', /healRules\.isBlank/.test(shelljs));
// 注意：只能比 <script src> 的位置。shell.html 正文里还有一句注释「见 shell.js」，
// 拿裸文件名 indexOf 会因为那句注释而误判（本测试自己踩过一次）。
check('shell.html 在 shell.js 之前加载 heal.js',
  shellhtml.indexOf('<script src="heal.js"') >= 0 &&
  shellhtml.indexOf('<script src="heal.js"') < shellhtml.indexOf('<script src="shell.js"'));
check('shell.js 切标签页时会补 resize', /nudgePageLayout/.test(shelljs) &&
  /window\.dispatchEvent\(new Event\("resize"\)\)/.test(shelljs));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
