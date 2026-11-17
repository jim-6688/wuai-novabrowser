'use strict';

/**
 * 核心功能补齐：标签页体验 / 开发者工具 / 常用页面操作 / 无痕窗口 —— 静态链路检查。
 * 用法：node tools/test-core-features.js
 *
 * 这些功能横跨主进程 / preload / 渲染层 / CSS 四层，任何一层接线断了功能就静默失效。
 * 这里逐条钉住源码里的关键语句；配合 npm test 的其余用例一起守完整回归。
 * 真浏览器行为（无痕 session 隔离、DevTools 打开）不在这里测 —— 那需要 Electron 探针。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const has = (s, needle) => String(s).indexOf(needle) >= 0;

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
};

const main = read('src/main/main.js');
const shell = read('src/renderer/shell.js');
const css = read('src/renderer/shell.css');
const preload = read('src/preload/preload.js');
const wvpre = read('src/preload/webview-preload.js');
const settings = read('src/main/settings.js');
const mock = read('src/renderer/bridge-mock.js');

console.log('\n[A] 标签页体验：固定 / 拖拽重排 / 右键菜单');
check('tab 结构带 pinned 字段', has(shell, 'pinned: false'));
check('会话快照保存 pinned', has(shell, 'pinned: !!t.pinned'));
check('渲染层有 toggleTabPin', has(shell, 'function toggleTabPin(id)'));
check('固定页沉到最左', has(shell, 'state.tabs.splice(lastPinned + 1, 0, t)'));
check('拖拽重排 reorderTab', has(shell, 'function reorderTab(srcId, targetId)'));
check('标签 draggable 与 drop 绑定', has(shell, "addEventListener('drop'") && has(shell, 'draggable="true"'));
check('固定页不参与拖拽', has(shell, "${t.pinned ? '' : 'draggable=\"true\"'}"));
check('标签右键菜单 openTabContextMenu', has(shell, 'function openTabContextMenu(id, ev)'));
check('右键动作 runTabContextAction', has(shell, 'function runTabContextAction(tabId, act)'));
check('关闭右侧 / 关闭其他动作齐', has(shell, "act === 'close-right'") && has(shell, "act === 'close-others'"));
check('桥接 tabContextMenu 接口', has(preload, 'tabContextMenu: (payload)'));
check('主进程 tab:context-menu handler', has(main, "ipcMain.on('tab:context-menu'"));
check('动作回传 tab:context-action 在白名单', has(preload, "'tab:context-action'"));
check('渲染层监听 tab:context-action', has(shell, "bridge.on('tab:context-action'"));
check('固定/拖拽 CSS 齐', has(css, '.tab.is-pinned') && has(css, '.tab.is-dragging') && has(css, '.tab.is-drop-target'));

console.log('\n[B] 开发者工具 F12 / Ctrl+Shift+I 与查看源码 Ctrl+U');
check('主进程 page:devtools handler', has(main, "handle('page:devtools'"));
check('openDevTools 真调用', has(main, 'wc.openDevTools({ mode: \'detach\' })'));
check('主进程 page:view-source handler', has(main, "handle('page:view-source'"));
check('源码用 executeJavaScript 抓取', has(main, 'document.documentElement.outerHTML'));
check('源码写成只读 txt 文件', has(main, 'nova-view-source') && has(main, ".txt'"));
check('preload 暴露 devTools', has(preload, 'devTools: (wcId)'));
check('preload 暴露 viewSource', has(preload, 'viewSource: (wcId)'));
check('渲染层 cmdDevTools', has(shell, 'function cmdDevTools()'));
check('渲染层 cmdViewSource', has(shell, 'function cmdViewSource()'));
check('webview-preload 转发 F12', has(wvpre, "event.key === 'F12'") && has(wvpre, "'nova-devtools'"));
check('webview-preload 转发 Ctrl+U', has(wvpre, "ipcRenderer.sendToHost('nova-view-source')"));
check('宿主接 nova-devtools', has(shell, "ev.channel === 'nova-devtools'"));
check('宿主接 nova-view-source', has(shell, "ev.channel === 'nova-view-source'"));
check('快捷键 F12 / Ctrl+U', has(shell, "ev.key === 'F12'") && has(shell, "ev.key.toLowerCase() === 'u'"));
check('命令面板有 devtools / view-source', has(shell, "id: 'devtools'") && has(shell, "id: 'view-source'"));

console.log('\n[C] 常用页面操作：另存HTML / 停止 / 全屏 / 可见截图 / 历史单删');
check('主进程 page:save-page handler', has(main, "handle('page:save-page'"));
check('用 webContents.savePage', has(main, 'wc.savePage(picked.filePath, kind)'));
check('HTMLComplete 完整版', has(main, "'HTMLComplete'"));
check('settings.removeHistory 实现', has(settings, 'function removeHistory(url)') && has(settings, 'removeHistory,'));
check('主进程 history:remove handler', has(main, "handle('history:remove'"));
check('preload 暴露 savePage / history.remove', has(preload, 'savePage: (wcId)') && has(preload, 'remove: (url)'));
check('渲染层 cmdSavePage', has(shell, 'function cmdSavePage()'));
check('Ctrl+S 快捷键', has(shell, "ev.key.toLowerCase() === 's'"));
check('停止按钮真调 stop()', has(shell, 't.webview.stop()') && has(shell, 'if (t.loading)'));
check('F11 全屏 cmdFullScreen', has(shell, 'function cmdFullScreen()') && has(shell, "ev.key === 'F11'"));
check('window:control 加 fullscreen', has(main, "action === 'fullscreen'") && has(preload, "ipcRenderer.send('window:control', 'fullscreen')"));
check('window:control 按 sender 定位窗口（无痕窗不能关主窗）', has(main, 'BrowserWindow.fromWebContents(e.sender) || mainWindow'));
check('可见区域截图 cmdCaptureView', has(shell, 'function cmdCaptureView()') && has(shell, "bridge.page.capture(id, 'view')"));
check('历史单条删除按钮', has(shell, 'data-hist-del') && has(shell, 'bridge.history.remove'));
check('历史删除 CSS', has(css, '.hist-del'));

console.log('\n[D] 无痕窗口：内存 session 隔离');
check('createIncognitoWindow 实现', has(main, 'function createIncognitoWindow()'));
check('内存分区名 incognito-（无 persist:）', has(main, "'incognito-' + (++incognitoSeq)"));
check('fromPartition 不带 persist 前缀', has(main, 'session.fromPartition(partition); // 无 persist:'));
check('无痕 session 装全套拦截', has(main, 'installSession(ses, \'chromium\')') && has(main, 'function installSession(ses, engineId)'));
check('无痕 session 判定', has(main, 'function isIncognitoSession(ses)'));
check('无痕不写历史', has(main, '!isIncognitoSession(contents.session)'));
check('无痕不进图标缓存', has(main, 'favicons[0] && !isIncognitoSession(contents.session)'));
check('关窗即焚 clearStorageData', has(main, 'ses.clearStorageData()'));
check('window:new-incognito handler', has(main, "handle('window:new-incognito'"));
check('preload 暴露 newIncognito', has(preload, 'newIncognito: ()'));
check('渲染层 cmdNewIncognito', has(shell, 'function cmdNewIncognito()'));
check('URL ?incognito= 读分区', has(shell, "get('incognito') || ''"));
check('无痕窗不恢复会话', has(shell, '!state.incognitoPartition'));
check('webview 用无痕分区覆盖内核分区', has(shell, 'state.incognitoPartition || e.partition'));
check('无痕视觉标识 data-incognito', has(shell, "dataset.incognito = '1'") && has(css, 'html[data-incognito="1"]'));
check('品牌格显示无痕模式', has(shell, '无痕模式 · ${e.label}'));
check('Ctrl+Shift+N 快捷键', has(shell, "ev.shiftKey && ev.key.toLowerCase() === 'n'"));
check('工具菜单 + 命令面板入口', has(shell, "id: 'incognito'"));
check('send 广播到无痕窗口', has(main, 'for (const win of incognitoWindows)'));

console.log('\n[E] 预览桩一致性');
check('mock 补 tabContextMenu', has(mock, 'tabContextMenu: () => {}'));
check('mock 补 page 新接口', has(mock, 'savePage: async') && has(mock, 'devTools: async') && has(mock, 'viewSource: async'));
check('mock 补 history.remove', has(mock, 'remove: async (url)'));
check('mock 补 window 新接口', has(mock, 'newIncognito: async') && has(mock, 'fullScreen() {}'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）\n`);
process.exit(fail ? 1 : 0);
