/**
 * 阅读模式（PC 正文提取）—— 接线静态回归。用法：node tools/test-reader.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const shell = fs.readFileSync(path.join(root, 'src/renderer/shell.js'), 'utf8');

const has = (hay, needle) => hay.indexOf(needle) >= 0;
let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('[1] 阅读模式脚本与切换 (shell.js)');
check('READER_JS 常量已定义', has(shell, 'const READER_JS ='));
check('注入浮层根 nova-reader-root', has(shell, "root.id = 'nova-reader-root'"));
check('正文打分挑选逻辑 scoreNode', has(shell, 'function scoreNode('));
check('克隆清洗正文节点', has(shell, 'best.cloneNode(true)'));
check('去除脚本/广告等干扰节点', has(shell, "node.querySelectorAll('script,style,iframe"));
check('浮层工具条 data-nr 按钮', has(shell, "data-nr=\"close\""));
check('字号 ± / 衬线 / 退出 交互', has(shell, "act==='inc'") && has(shell, "act==='dec'") && has(shell, "act==='serif'"));
check('已开启时再次调用即退出', has(shell, 'window.__novaReaderOn) { window.__novaReaderOff();'));
check('toggleReaderMode 函数已定义', has(shell, 'async function toggleReaderMode('));
check('调用 webview.executeJavaScript(READER_JS)', has(shell, 't.webview.executeJavaScript(READER_JS)'));
check('Trident / 非网页 守卫', has(shell, 't.webview.__bridge') && has(shell, '当前内核不支持阅读模式'));

console.log('[2] 入口接线 (shell.js)');
check('命令面板含 read-mode', has(shell, "id: 'read-mode'"));
check('工具菜单含 readmode', has(shell, "{ id: 'readmode', label: '阅读模式'"));
check('read-mode 调用 toggleReaderMode', has(shell, "run: () => toggleReaderMode()"));

console.log('[3] 注入脚本内部语法');
const m = shell.match(/const READER_JS = `([\s\S]*?)`;/);
let innerOk = false;
let innerErr = '';
if (m) {
  try { new Function(m[1]); innerOk = true; } catch (e) { innerErr = e.message; }
} else { innerErr = '未找到 READER_JS'; }
check('READER_JS 内部 JS 可解析' + (innerOk ? '' : '：' + innerErr), innerOk);

console.log('[4] 阅读模式 Android 端 (reader.inject.js)');
const assetPath = path.join(root, 'android-app/app/src/main/assets/reader.inject.js');
const assetExists = fs.existsSync(assetPath);
check('Android 注入脚本资产存在', assetExists);
let aInnerOk = false, aInnerErr = '', aSrc = '';
if (assetExists) {
  aSrc = fs.readFileSync(assetPath, 'utf8');
  try { new Function(aSrc); aInnerOk = true; } catch (e) { aInnerErr = e.message; }
}
check('Android 注入脚本 JS 可解析' + (aInnerOk ? '' : '：' + aInnerErr), aInnerOk);
check('Android 自切换：已开启则退出', has(aSrc, 'window.__novaReaderOn) { window.__novaReaderOff();'));
check('Android 提取不到正文返回 no-content', has(aSrc, "return 'none~0~~~no-content'"));
check('Android 进入返回 on~1~ 状态串', has(aSrc, "return 'on~1~'"));
check('Android 标题 ~ 转义防污染', has(aSrc, "safeTitle = title.replace(/~/g,'/')"));
const javaPath = path.join(root, 'android-app/app/src/main/java/top/wuai/nova/Reader.java');
const java = fs.existsSync(javaPath) ? fs.readFileSync(javaPath, 'utf8') : '';
check('Reader.java 已创建', fs.existsSync(javaPath));
check('Reader.parseStatus 用 ~ 分隔解析', has(java, 's.split("~", -1)') && has(java, 'AutoPage.unwrapJsString'));
check('MainActivity 加载 reader 资产', has(fs.readFileSync(path.join(root, 'android-app/app/src/main/java/top/wuai/nova/MainActivity.java'), 'utf8'), 'readerScript = store.readAssetText(Reader.ASSET)'));
check('阅读增强弹层含进入按钮 rdEnter', has(fs.readFileSync(path.join(root, 'android-app/app/src/main/res/layout/sheet_read.xml'), 'utf8'), 'android:id="@+id/rdEnter"'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
