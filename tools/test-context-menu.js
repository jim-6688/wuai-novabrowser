'use strict';

/**
 * 网页右键菜单能力：导出 PDF / 常用项 / 突破禁用右键 —— 静态链路检查。
 * 用法：node tools/test-context-menu.js
 *
 * 真实浏览器里的注入行为另见 tools/test-context-hook-electron.js
 * （npm run check:ctxhook），那条用 Electron 实测钩子确实能在网页
 * preventDefault 后补弹、且不重复弹。这里只钉住四处源码接线，缺一处就复发：
 *   ① 主进程菜单模板：图片 / 整页翻译 / 导出 PDF 的项与 channel 齐
 *   ② 渲染层：sendContextMenu 统一组装、webview:save-pdf 按 wcId 存、去重
 *   ③ 突破链路：主世界注入 → preload 转发 → 宿主补弹 → 设置开关
 *   ④ preload 放行新通道（否则 bridge.on 直接抛，init 后半段不跑）
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const has = (s, needle) => String(s).indexOf(needle) >= 0;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

const main = read('src/main/main.js');
const shell = read('src/renderer/shell.js');
const preload = read('src/preload/preload.js');
const wvpre = read('src/preload/webview-preload.js');
const hook = read('src/main/context-menu-hook.js');
const settings = read('src/main/settings.js');
const mock = read('src/renderer/bridge-mock.js');

console.log('\n[1] 主进程菜单模板：新增项');
const menuBlock = (main.match(/ipcMain\.on\('webview:context-menu'[\s\S]*?Menu\.buildFromTemplate/) || [])[0] || '';
check('图片另存 / 复制图片地址 / 新标签开图片',
  has(menuBlock, '图片另存为') && has(menuBlock, '复制图片地址') && has(menuBlock, '在新标签页打开图片'));
check('图片另存走 webContents.downloadURL（带 referrer）', has(menuBlock, '.downloadURL(p.srcURL)'));
check('翻译当前页面走 pageTrUrl', has(menuBlock, 'pageTrUrl') && has(menuBlock, '翻译当前页面'));
check('导出为 PDF 回 webview:save-pdf 且带 wcId',
  has(menuBlock, '导出为 PDF') && has(menuBlock, "back('webview:save-pdf'") && has(menuBlock, 'wcId: payload'));
check('突破补弹的复制走剪贴板兜底（网页连 copy 都禁了也能复制）',
  has(menuBlock, 'params.forced') && has(menuBlock, 'clipboard.writeText(p.selectionText)'));

console.log('\n[2] 渲染层：组装与 PDF 保存');
check('sendContextMenu 统一组装并算两条翻译链接',
  has(shell, 'function sendContextMenu(') && has(shell, 'translateTextUrl(sel)') && has(shell, 'translatePageUrl(url)'));
check('原生 context-menu 与突破补弹都走 sendContextMenu',
  (shell.match(/sendContextMenu\(/g) || []).length >= 3);
check('cmdSavePdfPage 支持按 wcId 保存',
  has(shell, 'async function cmdSavePdfPage(tabOrWcId)') && has(shell, 'bridge.page.savePdf(id)'));
check('webview:save-pdf 监听把 wcId 交给 cmdSavePdfPage',
  has(shell, "bridge.on('webview:save-pdf'") && has(shell, 'cmdSavePdfPage(p'));
check('原生与补弹之间做了时间去重',
  has(shell, 'lastContextMenuAt') && has(shell, 'now - lastContextMenuAt < 250'));

console.log('\n[3] 突破禁用右键：注入链路');
check('主世界钩子捕获阶段先拿 contextmenu',
  has(hook, "addEventListener('contextmenu'") && has(hook, '}, true);'));
check('网页 preventDefault 后才补弹（defaultPrevented 判定）',
  has(hook, 'ev.defaultPrevented') && has(hook, 'setTimeout'));
check('未拦时不动，避免弹两次',
  has(hook, 'if (!ev.defaultPrevented) return;'));
check('子框架 postMessage 转给顶层',
  has(hook, '__novaCtx') && has(hook, 'top.postMessage'));
check('钩子 dispatch nova:context-menu DOM 事件',
  has(hook, "new CustomEvent('nova:context-menu'") && has(hook, 'window.dispatchEvent'));
check('WeakSet 去重，按 webContents 所有框架注入',
  has(hook, 'new WeakSet()') && has(hook, 'framesInSubtree') && has(hook, 'did-frame-navigate'));

check('preload 把 DOM 事件转成 sendToHost（保留 forced 标记）',
  has(wvpre, "addEventListener('nova:context-menu'") && has(wvpre, "sendToHost('nova-context-menu'")
  && has(wvpre, 'forced: d.forced === 1'));
check('宿主 handleWebviewIpc 补弹菜单（nova-context-menu）',
  has(shell, "ev.channel === 'nova-context-menu'") && has(shell, 'sendContextMenu(tab'));
check('宿主在 dom-ready 时装钩子',
  has(shell, 'installContextHook(tab)') && has(shell, 'bridge.page.installContextHook'));

console.log('\n[4] 主进程 handle 与 preload 接口');
check('主进程 require 并注册 page:context-hook',
  has(main, "require('./context-menu-hook')") && has(main, "handle('page:context-hook'"));
check('preload 暴露 installContextHook',
  has(preload, 'installContextHook: (wcId)') && has(preload, "ipcRenderer.invoke('page:context-hook'"));
check('preload 放行 webview:save-pdf 通道',
  has(preload, "'webview:save-pdf'"));
check('预览桩补 installContextHook（否则预览报错）',
  has(mock, 'installContextHook: async'));

console.log('\n[5] 设置开关');
check('默认开启 breakLimit',
  has(settings, 'contextMenu: {') && has(settings, 'breakLimit: true'));
check('渲染层开关读取缺省视为开',
  has(shell, 'function contextBreakLimit()') && has(shell, 'c.breakLimit !== false'));
check('设置页有开关 UI 与落盘',
  has(shell, 'data-act="ctx-break"') && has(shell, "{ contextMenu: { breakLimit: on } }"));

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
