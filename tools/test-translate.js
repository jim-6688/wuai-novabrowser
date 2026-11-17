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
const html = fs.readFileSync(path.join(root, 'src/renderer/shell.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/renderer/shell.css'), 'utf8');

const has = (hay, needle) => hay.indexOf(needle) >= 0;
let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('[1] 设置默认值 (settings.js)');
check('DEFAULTS 含 translate 块', has(settings, 'translate: {'));
check('默认引擎百度（国内直连可用）', has(settings, "engine: 'baidu'"));
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
// 右键组装已抽到 sendContextMenu（右键菜单增强：图片/整页翻译/导出 PDF 共用）。
check('右键组装把 trUrl 带给主进程', has(shell, 'function sendContextMenu(')
  && has(shell, 'bridge.webview.contextMenu({ params: p, wcId, trUrl, pageTrUrl })'));
check('主进程消费 payload.trUrl', has(main, 'payload.trUrl'));
check('主进程新增「翻译选中文字」菜单项', has(main, "翻译「' + short(p.selectionText) + '」"));

console.log('[8] 整页翻译 URL 形态 (shell.js)');
check('百度整页翻译深链 transpage?query=', has(shell, 'fanyi.baidu.com/transpage?source=url&from=auto&to=${tl}&query=${enc}&render=1'));
check('Google 整页翻译深链 ?u=', has(shell, 'translate.google.com/translate?sl=auto&tl=${tl}&u=${enc}'));
check('Bing 翻译主页带 to=', has(shell, 'www.bing.com/translator?to=${tl}'));
check('DeepL 翻译主页带 target_lang=', has(shell, 'www.deepl.com/translator?target_lang=${tl}'));

console.log('[8b] 百度 / 腾讯翻译接入');
check('引擎表含 baidu', has(shell, 'baidu: { label: \'百度翻译\' }'));
check('引擎表含 tencent', has(shell, 'tencent: { label: \'腾讯翻译君\' }'));
check('翻译引擎缺省兜底为 baidu', has(shell, "TRANSLATE_ENGINES[t.engine] ? t.engine : 'baidu'"));
check('目标语言表含百度代码', has(shell, "baidu: 'jp'"));
check('translateTargetFor 处理百度代码', has(shell, "if (engine === 'baidu') return lang.baidu;"));
check('百度选中文字深链 #auto/', has(shell, 'fanyi.baidu.com/#auto/${tl}/${enc}'));
check('腾讯选中文字深链 ?text=', has(shell, 'fanyi.qq.com/?text=${enc}'));
check('腾讯整页给出不支持提示', has(shell, '腾讯翻译君不支持整页翻译'));
check('设置页说明百度国内可用', has(shell, '默认百度（国内直连可用）'));
check('设置页设置注释写明默认百度', has(settings, 'engine —— baidu | google | tencent | bing | deepl，默认百度'));

console.log('[9] 非中文页面主动提醒 —— 设置');
check('默认 offer 开启', has(settings, 'offer: true'));
check('默认 neverOfferLangs 空数组', has(settings, 'neverOfferLangs: []'));
check('设置项注释说明 offer', has(settings, 'offer  —— 打开非目标语言的网页时'));
check('translateCfg 读 offer 且默认 true', has(shell, 'offer: t.offer !== false'));
check('translateCfg 读 neverOfferLangs 兜底数组', has(shell, 'neverOfferLangs: Array.isArray(t.neverOfferLangs)'));

console.log('[10] 非中文页面主动提醒 —— 检测逻辑 (shell.js)');
check('语言名表 PAGE_LANG_NAMES 已定义', has(shell, 'const PAGE_LANG_NAMES'));
check('读 lang 的注入脚本已定义', has(shell, 'const PAGE_LANG_DETECT_JS'));
check('注入脚本优先 html lang', has(shell, "de.lang || de.getAttribute('lang')"));
check('注入脚本回退 meta content-language', has(shell, "'content-language'"));
check('注入脚本回退 navigator.language', has(shell, 'navigator.language || navigator.userLanguage'));
check('中文判定 isChineseLang 已定义', has(shell, 'function isChineseLang('));
check('检测入口 maybeOfferTranslation 已定义', has(shell, 'async function maybeOfferTranslation('));
check('每个 URL 只检测一次', has(shell, 'tab.translateOfferCheckedUrl === url'));
check('只提醒 http(s) 网页', has(shell, 'if (!/^https?:\\/\\//i.test(url)) return;'));
check('跳过 bridge 内核视图', has(shell, 'tab.webview.__bridge'));
check('过滤已忽略语言', has(shell, 'cfg.neverOfferLangs.some((l) => langPrimary(l) === lang)'));
check('提醒挂到 tab 上按标签归属', has(shell, 'tab.translateOffer = { lang, name: langName(lang), target: cfg.target }'));
check('did-finish-load 触发检测', has(shell, 'maybeOfferTranslation(tab);'));
check('did-navigate 换网址清提醒', has(shell, 'tab.translateOffer = null;'));
check('activateTab 切回来同步提醒', has(shell, 'syncTranslateOffer();'));
check('提示栏同步函数已定义', has(shell, 'function syncTranslateOffer('));
check('接受提醒函数已定义', has(shell, 'function acceptTranslateOffer('));
check('永久忽略函数已定义', has(shell, 'async function neverOfferTranslateLang('));
check('忽略写入 neverOfferLangs', has(shell, "bridge.settings.patch({ translate: { neverOfferLangs: list } })"));
check('关闭开关时清掉所有挂起提醒', has(shell, "bridge.settings.patch({ translate: { offer: next } })"));
check('恢复全部提醒动作已接线', has(shell, "act === 'tr-never-clear'"));

console.log('[11] 非中文页面主动提醒 —— UI (html/css)');
check('提醒条容器 id=translate-offer', has(html, 'id="translate-offer"'));
check('提醒条占布局不浮层', has(html, '和查找条一样占布局'));
check('提醒条三个按钮齐全',
  has(html, 'id="to-accept"') && has(html, 'id="to-never"') && has(html, 'id="to-dismiss"'));
check('按钮事件已接线',
  has(shell, "$('#to-accept').addEventListener('click', acceptTranslateOffer)")
  && has(shell, "$('#to-never').addEventListener('click'")
  && has(shell, "$('#to-dismiss').addEventListener('click', dismissTranslateOffer)"));
check('提醒条样式已定义', has(css, '.translate-offer:not([hidden])'));
check('设置页含开关 #tr-offer', has(shell, 'id="tr-offer"'));
check('设置页开关接线', has(shell, "root.querySelector('#tr-offer')"));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
