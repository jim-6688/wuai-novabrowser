'use strict';
/**
 * 语言与地区单测（Node，无需 Electron）
 * 用法：node tools/test-locale.js
 *
 * 覆盖 src/main/locale.js：系统语言归一、设置解析、Accept-Language 生成。
 * 另外校验渲染层两处「兜底选项表」没有跟主进程跑偏 —— 那两处是抄的，
 * 抄错了界面上就会少了某个语言，或者选了个主进程不认识的值。
 */
const fs = require('fs');
const path = require('path');
const L = require(path.join(__dirname, '..', 'src', 'main', 'locale.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

console.log('\n[A] normalizeLocale（只认表里的值）');
check('auto 保留', L.normalizeLocale('auto') === 'auto');
check('zh-CN 保留', L.normalizeLocale('zh-CN') === 'zh-CN');
check('大小写不合规范 → auto', L.normalizeLocale('zh-cn') === 'auto');
check('乱填 → auto', L.normalizeLocale('klingon') === 'auto');
check('空值 → auto', L.normalizeLocale('') === 'auto');
check('undefined → auto', L.normalizeLocale(undefined) === 'auto');

console.log('\n[B] normalizeSystemLocale（系统语言的脏值归一）');
check('zh_CN 下划线 → zh-CN', L.normalizeSystemLocale('zh_CN') === 'zh-CN');
check('zh-Hans-CN → zh-CN', L.normalizeSystemLocale('zh-Hans-CN') === 'zh-CN');
check('zh-Hant-TW → zh-TW', L.normalizeSystemLocale('zh-Hant-TW') === 'zh-TW');
check('zh-TW 保持', L.normalizeSystemLocale('zh-TW') === 'zh-TW');
check('zh-HK → zh-TW（港澳用繁体）', L.normalizeSystemLocale('zh-HK') === 'zh-TW');
check('en-GB → en-US', L.normalizeSystemLocale('en-GB') === 'en-US');
check('ja 无地区 → ja-JP', L.normalizeSystemLocale('ja') === 'ja-JP');
check('ko-KR 保持', L.normalizeSystemLocale('ko-KR') === 'ko-KR');
check('pt-PT → pt-BR（只支持巴西葡语）', L.normalizeSystemLocale('pt-PT') === 'pt-BR');
check('不认识的语言 → 中文兜底', L.normalizeSystemLocale('sv-SE') === L.FALLBACK);
check('空值 → 中文兜底', L.normalizeSystemLocale('') === L.FALLBACK);

console.log('\n[C] resolveLocale（设置 × 系统）');
check('设置 auto → 用系统', L.resolveLocale('auto', 'en-US') === 'en-US');
check('设置 auto + 系统中文 → zh-CN', L.resolveLocale('auto', 'zh-CN') === 'zh-CN');
check('显式设置优先于系统', L.resolveLocale('zh-CN', 'en-US') === 'zh-CN');
check('非法设置 → 退回跟随系统', L.resolveLocale('nope', 'ja-JP') === 'ja-JP');

console.log('\n[D] acceptLanguageFor（q 权重串）');
check('zh-CN 串固定', L.acceptLanguageFor('zh-CN') === 'zh-CN,zh;q=0.9,en;q=0.8');
check('zh-TW 串固定', L.acceptLanguageFor('zh-TW') === 'zh-TW,zh;q=0.9,en;q=0.8');
check('en-US 串固定', L.acceptLanguageFor('en-US') === 'en-US,en;q=0.9,zh;q=0.6');
check('ja-JP 带 ja 与 en', /^ja-JP,ja;q=0\.9,en;q=0\.8$/.test(L.acceptLanguageFor('ja-JP')));
// 系统脏值也要能落到正确的串上
check('zh_CN 走中文串', L.acceptLanguageFor('zh_CN') === 'zh-CN,zh;q=0.9,en;q=0.8');
// 首选语言必须排在最前，且第一个一定是 q=1（不带 q）
const tokens = L.acceptLanguageFor('de-DE').split(',');
check('首选语言排第一', tokens[0] === 'de-DE');
check('首选不带 q（即 q=1）', tokens[0].indexOf(';q=') < 0);
check('一定带英文兜底', /en;q=/.test(L.acceptLanguageFor('ru-RU')));

console.log('\n[E] 运行时状态');
const before = L.activeAccept();
L.setActive('en-US');
check('setActive 生效', L.activeLocale() === 'en-US' && L.activeAccept().indexOf('en-US') === 0);
L.setActive('zh-TW');
check('可以再切', L.activeLocale() === 'zh-TW');
L.setActive('zh_CN'); // 脏值
check('脏值被归一', L.activeLocale() === 'zh-CN');
L.setActive(L.FALLBACK);
check('能回到兜底', L.activeAccept() === before || L.activeAccept().indexOf('zh-CN') === 0);

console.log('\n[F] 选项表');
const opts = L.options();
check('有 auto', opts.some((o) => o.value === 'auto'));
check('每项都有 value 与 label', opts.every((o) => o.value && o.label));
check('value 不重复', new Set(opts.map((o) => o.value)).size === opts.length);
check('options() 返回副本', L.options() !== L.OPTIONS);

console.log('\n[G] 渲染层兜底表没跑偏');
const root = path.join(__dirname, '..');
const shelljs = fs.readFileSync(path.join(root, 'src', 'renderer', 'shell.js'), 'utf8');
const mockjs = fs.readFileSync(path.join(root, 'src', 'renderer', 'bridge-mock.js'), 'utf8');

// shell.js 的 localeOptions() 兜底：抽 { value: 'x', label: 'y' } 对，断言都在主进程表里
const shellFallback = [...shelljs.matchAll(/\{\s*value:\s*'([\w-]+)'\s*,\s*label:\s*'[^']*'\s*\}/g)].map((m) => m[1]);
check('shell.js 有一份兜底表', shellFallback.length >= 4, '实际 ' + shellFallback.length);
check('兜底表的值都存在于主进程表',
  shellFallback.every((v) => L.OPTIONS.some((o) => o.value === v)),
  JSON.stringify(shellFallback));

// bridge-mock 的预览表：抽 { value: 'x', label: 'y' }，同样比对
const mockList = [...mockjs.matchAll(/value:\s*'([\w-]+)',\s*label:\s*'[^']*'/g)].map((m) => m[1]);
check('bridge-mock 有预览表', mockList.length >= 8, '实际 ' + mockList.length);
check('预览表的值都在主进程表里',
  mockList.every((v) => L.OPTIONS.some((o) => o.value === v)),
  JSON.stringify(mockList));
check('预览表覆盖主进程全部语言',
  L.OPTIONS.every((o) => mockList.indexOf(o.value) >= 0),
  JSON.stringify(mockList));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
