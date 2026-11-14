/**
 * PC 内置翻译 —— 接线静态回归。
 *
 * 只查「该接的地方都接上了」，不依赖浏览器运行时（shell.js 一进文件就碰 DOM，
 * 没法在 node 里直接 require）。用法：node tools/test-translate.js
 *
 * 用子串包含判断：上一版用正则的 `/` 在 JSON 层被转义搞丢过，导致误报，
 * 这里一律 indexOf，稳。
 */
'use strict';

const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const settings = fs.readFileSync(path.join(root, 'src/main/settings.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'src/renderer/shell.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');

const has = (hay, needle) => hay.indexOf(needle) >= 0;
let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('[1] 设置默认值 (settings.js)');
check('DEFAULTS 含 translate 块', has(settings, 'translate: {'));
check('默认引擎 google', has(settings, "engine: 'google'"));
check('默认目标语言 zh-CN', has(settings, "target: 'zh-CN'"));

console.log('[2] 设置页导航与分区 (shell.js)');
check('SETTINGS_NAV 含 translate 条目', has(shell, "{ id: 'translate', label: '内置翻译', icon: 'translate' }"));
check('SECTION_BUILDERS 映射 translate → buildTranslate', has(shell, 'translate: buildTranslate'));
check('NAV_ICONS 含 translate 图标', has(shell, "translate: '<path"));
check('CMD_ICON 含 translate 图标', has(shell, "translate: '<path"));
check('buildTranslate 函数已定义', has(shell, 'function buildTranslate()'));

console.log('[3] 翻译辅助函数 (shell.js)');
check('TRANSLATE_ENGINES 已定义', has(shell, 'const TRANSLATE_ENGINES'));
check('TARGET_LANGS 已定义', has(shell, 'const TARGET_LANGS'));
check('translateCfg 已定义', has(shell, 'function translateCfg('));
check('translateTargetFor 已定义', has(shell, 'function translateTargetFor('));
check('translatePageUrl 已定义', has(shell, 'function translatePageUrl('));
check('translateTextUrl 已定义', has(shell, 'function translateTextUrl('));
check('activeSelectionText 已定义', has(shell, 'function activeSelectionText('));
check('translateActivePage 已定义', has(shell, 'function translateActivePage('));
check('translateActiveSelection 已定义', has(shell, 'function translateActiveSelection('));

console.log('[4] 设置页交互接线 (shell.js)');
check('下拉 #tr-engine 绑定 change', has(shell, "root.querySelector('#tr-engine')"));
check('下拉 #tr-target 绑定 change', has(shell, "root.querySelector('#tr-target')"));

console.log('[5] 动作分发 (shell.js data-act)');
check("data-act 'tr-page' 分发", has(shell, "act === 'tr-page'"));
check("data-act 'tr-selection' 分发", has(shell, "act === 'tr-selection'"));

console.log('[6] 工具菜单与命令面板 (shell.js)');
check('TOOLS_ITEMS 含翻译页面条目', has(shell, "{ id: 'translate', label: '翻译页面'"));
check('命令面板含 translate-page', has(shell, "id: 'translate-page'"));
check('命令面板含 translate-selection', has(shell, "id: 'translate-selection'"));

console.log('[7] 网页右键菜单 (shell.js + main.js)');
check('context-menu 事件把 trUrl 带给主进程', has(shell, 'bridge.webview.contextMenu({ params: ev.params, wcId, trUrl })'));
check('主进程消费 payload.trUrl', has(main, 'payload.trUrl'));
check('主进程新增「翻译选中文字」菜单项', has(main, "翻译「' + short(p.selectionText) + '」"));

console.log('[8] 整页翻译 URL 形态 (shell.js)');
check('Google 整页翻译深链 ?u=', has(shell, 'translate.google.com/translate?sl=auto&tl=${tl}&u=${enc}'));
check('Bing 翻译主页带 to=', has(shell, 'www.bing.com/translator?to=${tl}'));
check('DeepL 翻译主页带 target_lang=', has(shell, 'www.deepl.com/translator?target_lang=${tl}'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
