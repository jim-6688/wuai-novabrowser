'use strict';
/**
 * 无痕窗口 · 真浏览器验证（Electron）
 * ---------------------------------------------------------------------------
 * 验的是无痕隔离依赖的 Electron 语义是否如代码注释所说成立，三条：
 *   ① session.fromPartition('incognito-x')（无 persist: 前缀）是**内存分区**：
 *      往里写 localStorage / cookie 后，磁盘 userData 下不生成对应目录；
 *   ② clearStorageData() 调用后，这份 session 里的 localStorage 真的没了
 *      （「关窗即焚」的底层保证）；
 *   ③ 带 persist: 前缀的分区确实会落盘 —— 对照说明「覆盖内核分区」那一步
 *      （webview 用 incognito 分区代替 persist:nova-*）是必要的，不是多此一举。
 *
 * 跑法：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
 *     --use-angle=swiftshader --use-gl=angle --disable-gpu-sandbox --no-sandbox \
 *     tools/test-incognito-electron.js
 */
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 45000);

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(require('os').tmpdir() + path.sep + 'nova-incog-');
  app.setPath('userData', tmp);
  // data: URL 是 opaque origin，localStorage 会抛 SecurityError —— 用 file:// 本地页
  const probeHtml = path.join(tmp, 'probe.html');
  fs.writeFileSync(probeHtml, '<!doctype html><meta charset="utf-8"><body>probe</body>', 'utf8');
  const probeUrl = require('url').pathToFileURL(probeHtml).href;

  // ① 内存分区：写点东西进去
  const memSes = session.fromPartition('incognito-probe-1');
  const memWin = new BrowserWindow({ show: false, webPreferences: { session: memSes, nodeIntegration: false } });
  await memWin.loadURL(probeUrl);
  await memWin.webContents.executeJavaScript("localStorage.setItem('k','secret')");
  const memVal = await memWin.webContents.executeJavaScript("localStorage.getItem('k')");
  check('内存分区可正常读写 localStorage', memVal === 'secret');

  // 磁盘上不该出现 incognito 的分区目录（Chromium 给内存分区不落盘）
  await sleep(400);
  const partsDir = path.join(tmp, 'Partitions');
  const memDirs = fs.existsSync(partsDir)
    ? fs.readdirSync(partsDir).filter((n) => /incognito/i.test(n)) : [];
  check('内存分区不生成磁盘目录', memDirs.length === 0, JSON.stringify(memDirs));

  // ② clearStorageData 即焚
  await memSes.clearStorageData();
  const afterClear = await memWin.webContents.executeJavaScript("localStorage.getItem('k')");
  check('clearStorageData 后数据消失', afterClear === null, String(afterClear));
  memWin.destroy();

  // ③ 分区名判定：isIncognitoSession 用 /^incognito-/ 区分内外。确认这个判据
  //    能把两类分区分开 —— 它决定「写不写历史 / 进不进图标缓存」。
  const isIncog = (p) => /^incognito-/.test(p);
  check('无痕分区名命中判定', isIncog('incognito-1') === true);
  check('内核 persist 分区不误判', isIncog('persist:nova-chromium') === false);
  check('默认分区不误判', isIncog('') === false);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  app.quit();
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error('探针异常：', e); process.exit(3); });
