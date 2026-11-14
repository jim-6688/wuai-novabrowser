/**
 * 跨设备数据迁移（本地闭环）—— 接线静态回归。
 * 用子串包含判断（同 test-translate.js 的理由）。用法：node tools/test-sync.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const dataIo = fs.readFileSync(path.join(root, 'src/main/data-io.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'src/renderer/shell.js'), 'utf8');

const has = (hay, needle) => hay.indexOf(needle) >= 0;
let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('[1] 纯逻辑模块 (data-io.js)');
check('buildBundle 已定义', has(dataIo, 'function buildBundle('));
check('parseBundle 已定义', has(dataIo, 'function parseBundle('));
check('mergeSettings 已定义', has(dataIo, 'function mergeSettings('));
check('mergeHistory 已定义', has(dataIo, 'function mergeHistory('));
check('导出剥离运行态键 SETTINGS_SKIP_ON_IMPORT', has(dataIo, 'SETTINGS_SKIP_ON_IMPORT'));
check("格式标记 nova-data", has(dataIo, "FORMAT = 'nova-data'"));

console.log('[2] 主进程 IPC (main.js)');
check('require data-io', has(main, "require('./data-io')"));
check('注册 data:export-all', has(main, "handle('data:export-all'"));
check('注册 data:import-all', has(main, "handle('data:import-all'"));
check('导出用 buildBundle', has(main, 'dataIo.buildBundle('));
check('导入用 parseBundle', has(main, 'dataIo.parseBundle(text)'));
check('导入用 bookmarksIo.merge', has(main, 'bookmarksIo.merge('));
check('导入用 mergeHistory', has(main, 'dataIo.mergeHistory('));
check('导入用 mergeSettings', has(main, 'dataIo.mergeSettings('));
check('导出对话框默认名 nova-data-', has(main, "defaultPath: `nova-data-${stamp}.json`"));

console.log('[3] 桥 (preload.js)');
check('nova.data 命名空间', has(preload, 'data: {'));
check('exportAll 桥方法', has(preload, 'exportAll: () => ipcRenderer.invoke(\'data:export-all\')'));
check('importAll 桥方法', has(preload, 'importAll: () => ipcRenderer.invoke(\'data:import-all\')'));

console.log('[4] 界面接线 (shell.js)');
check('doDataExport 辅助函数', has(shell, 'async function doDataExport('));
check('doDataImport 辅助函数', has(shell, 'async function doDataImport('));
check('buildPrivacy 含 跨设备迁移 卡片', has(shell, '跨设备迁移'));
check("data-act 'data-export' 按钮", has(shell, "data-act=\"data-export\""));
check("data-act 'data-import' 按钮", has(shell, "data-act=\"data-import\""));
check("dispatch 'data-export'", has(shell, "act === 'data-export'"));
check("dispatch 'data-import'", has(shell, "act === 'data-import'"));
check('调用 bridge.data.exportAll', has(shell, 'bridge.data.exportAll()'));
check('调用 bridge.data.importAll', has(shell, 'bridge.data.importAll()'));
check('隐私页说明云端同步需后端', has(shell, '云端同步'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
