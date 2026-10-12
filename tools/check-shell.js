'use strict';
/**
 * 外壳一致性自检（无浏览器依赖）
 * 用法：node tools/check-shell.js
 * 校验：语法 / DOM id 引用 / 类选择器 / CSS 变量 / 内核选择器链路完整性
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const P = (p) => path.join(root, p);

let failed = 0;
const ok = (m) => console.log('  \u2713 ' + m);
const bad = (m) => { failed++; console.log('  \u2717 ' + m); };

/* 1. 语法（在进程内编译，不 spawn 子进程） */
console.log('\n[1] JS 语法');
const jsFiles = [
  'src/main/settings.js', 'src/main/engines.js', 'src/main/adblock.js',
  'src/main/adblock-lists.js', 'src/main/extensions.js', 'src/main/main.js',
  'src/main/downloader.js', 'src/main/sniffer.js', 'src/main/sniffer-wire.js',
  'src/main/nomedia.js', 'src/main/request-gate.js',
  'src/preload/preload.js', 'src/renderer/bridge-mock.js',
  'src/renderer/autopage.js', 'src/renderer/shell.js', 'tools/preview.js'
];
for (const f of jsFiles) {
  try {
    new vm.Script(fs.readFileSync(P(f), 'utf8'), { filename: f });
    ok(f);
  } catch (e) {
    bad(f + ' -> ' + String(e.message).split('\n')[0]);
  }
}

/* 2. DOM id 引用 */
console.log('\n[2] DOM id 引用');
const html = fs.readFileSync(P('src/renderer/shell.html'), 'utf8');
const js = fs.readFileSync(P('src/renderer/shell.js'), 'utf8');
const css = fs.readFileSync(P('src/renderer/shell.css'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const usedIds = new Set([...js.matchAll(/\$\$?\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
/**
 * 这些 id 不在 shell.html 里 —— 它们由设置页正文的 buildXxx() 在运行时渲染出来，
 * 所以「HTML 里查不到」是正常的，不能算缺陷。
 */
const dynamicIds = new Set(['dl-url']);
console.log(`  HTML id ${htmlIds.size} 个 / JS 引用 ${usedIds.size} 个`);
const missingIds = [...usedIds].filter((id) => !htmlIds.has(id) && !dynamicIds.has(id));
missingIds.length ? bad('JS 引用但 HTML 不存在: ' + missingIds.join(', '))
                  : ok(`JS 引用的 id 全部存在于 HTML（另有 ${dynamicIds.size} 个由 JS 运行时生成：${[...dynamicIds].join(', ')}）`);
const orphanIds = [...htmlIds].filter((id) => !js.includes(id));
console.log('  HTML 中未被 JS 直接引用的 id: ' + (orphanIds.join(', ') || '无'));

/* 3. 类选择器 */
console.log('\n[3] 类选择器');
const cssCls = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]));
const usedCls = new Set([...js.matchAll(/\$\$?\('\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
const dynamic = new Set(['tab', 'hist-row', 'preview-pane']);
const missingCls = [...usedCls].filter((c) => !cssCls.has(c) && !dynamic.has(c));
missingCls.length ? bad('JS 用但 CSS 无定义: ' + missingCls.join(', '))
                  : ok('JS 选择器类都在 CSS 中有定义');

const htmlCls = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
const noCss = [...htmlCls].filter((c) => c && !cssCls.has(c));
noCss.length ? bad('HTML 用但 CSS 无定义: ' + noCss.join(', '))
             : ok('HTML 用到的类都有样式');

/* 4. CSS 变量 */
console.log('\n[4] CSS 变量');
const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const usedVar = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
// 这两个由 JS 在运行时按标签页注入（style.setProperty），不在样式表里声明
const runtimeVars = new Set(['--tab-accent', '--engine-color']);
const undef = [...usedVar].filter((v) => !defined.has(v) && !runtimeVars.has(v));
undef.length ? bad('使用了未定义的变量: ' + undef.join(', '))
             : ok(`定义 ${defined.size} 个 / 使用 ${usedVar.size} 个，无缺失（--tab-accent、--engine-color 由 JS 运行时注入）`);

/* 5. 内核选择器链路 */
console.log('\n[5] 内核选择器（地址栏右端）链路');
const all = html + js + css;
const gone = !all.includes('engine-switch');
gone ? ok('旧工具栏切换器 .engine-switch 已彻底移除') : bad('.engine-switch 仍有残留');
const chain = [
  ['HTML 触发器', /id="omni-engine"/.test(html)],
  ['HTML 下拉面板', /id="engine-menu"/.test(html) && /id="engine-menu-list"/.test(html)],
  ['HTML 面板挂在 omnibox 内', /<div class="omnibox"[\s\S]*?engine-menu[\s\S]*?<\/div>\s*\n\s*<\/div>/.test(html)],
  ['样式 position:relative 锚点', /\.omnibox \{[\s\S]*?position: relative;/.test(css)],
  ['样式 .engine-menu', /\.engine-menu \{/.test(css)],
  ['样式 .ow-engine 右端选择器', /\.ow-engine \{/.test(css)],
  ['样式 兼容层态 .is-compat', /\.ow-engine\.is-compat \{/.test(css)],
  ['样式 下拉项 .em-item', /\.em-item\.is-active \{/.test(css)],
  ['JS 渲染下拉项', js.includes('engineMenuItem(') && js.includes("$('#engine-menu-list')")],
  ['JS 打开/关闭/切换', js.includes('function openEngineMenu') && js.includes('function closeEngineMenu') && js.includes('function toggleEngineMenu')],
  ['JS 点击触发', /\$\('#omni-engine'\)\.addEventListener\('click'/.test(js)],
  ['JS 点击外部关闭', /document\.addEventListener\('click', closeEngineMenu\)/.test(js)],
  ['JS Escape 关闭', /Escape'\) \{ closeEngineMenu\(\)/.test(js)],
  ['JS 同步选中态', js.includes("$$('#engine-menu-list .em-item')")],
  ['移动端走底部分层', /state\.layout === 'mobile'/.test(js)],
  ['移动端弹层仍保留', /id="engine-sheet"/.test(html) && /id="engine-cards"/.test(html)]
];
for (const [name, pass] of chain) pass ? ok(name) : bad(name);

/* 6. 设计板同步 */
console.log('\n[6] 设计板与实现同步');
const board = fs.readFileSync(P('design/design-board.html'), 'utf8');
!board.includes('engswitch') ? ok('设计板已无旧分段控件 .engswitch') : bad('设计板仍画出旧分段控件');
['.engmenu', 'class="engmenu"', '地址栏右端'].forEach((k) => {
  board.includes(k) ? ok('设计板包含 ' + k) : bad('设计板缺少 ' + k);
});

console.log(failed ? `\n结果：${failed} 项未通过\n` : '\n结果：全部通过\n');
process.exit(failed ? 1 : 0);
