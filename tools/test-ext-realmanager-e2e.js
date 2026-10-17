'use strict';

/**
 * 用**真实**的 src/main/extensions.js ExtensionManager + 真实 webview，
 * 完整跑一遍 安装 → 注入 → 停用 → 启用，验证 toggle 机制本身没问题。
 * 如果全过，说明"功能没实现"是体验断层（当前页不刷新），不是机制 bug。
 */

const { app, session, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ExtensionManager } = require('../src/main/extensions.js');

app.disableHardwareAcceleration();

const PART = 'persist:nova-chromium';
let pass = 0, fail = 0;
const check = (n, c, e) => { if (c) { pass++; console.log('  PASS  ' + n + (e ? '  ' + e : '')); } else { fail++; console.log('  FAIL  ' + n + (e ? '  ' + e : '')); } };

function makeExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-real-ext-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'RealMgr E2E', version: '1.0.0',
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['cs.js'], run_at: 'document_start' }]
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'cs.js'), "document.documentElement.dataset.novaExtInjected='yes';");
  return dir;
}

function startServer() {
  return new Promise((res) => {
    const s = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end('<!doctype html><html><body>x</body></html>'); });
    s.listen(0, '127.0.0.1', () => res(s));
  });
}

const readInj = (wc) => wc.executeJavaScript("document.documentElement.dataset.novaExtInjected||''").then((v) => v === 'yes').catch(() => false);

app.whenReady().then(async () => {
  const extDir = makeExtension();
  const srv = await startServer();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const extSessionFactory = () => session.fromPartition(PART);

  const mgr = new ExtensionManager({ workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nova-wd-')), partitions: [PART] });
  mgr.onChange = () => {};

  // 真实 install
  const info = await mgr.install(extDir, extSessionFactory);
  check('ExtensionManager.install 成功', !!info && !!info.id, info && info.id);

  // 真实 webview
  const win = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { contextIsolation: false, nodeIntegration: true, webviewTag: true } });
  let guest = null;
  win.webContents.on('did-attach-webview', (_e, wc) => { guest = wc; });
  const host = path.join(os.tmpdir(), 'nova-host.html');
  fs.writeFileSync(host, `<!doctype html><html><body><webview id="wv" partition="${PART}" src="${url}" style="width:380px;height:280px"></webview></body></html>`);
  await win.loadFile(host);
  for (let i = 0; i < 60 && !guest; i++) await new Promise((r) => setTimeout(r, 100));
  check('捕获 guest', !!guest);

  if (guest) {
    await new Promise((r) => setTimeout(r, 1200));
    check('[A] 安装后 content script 注入 webview', await readInj(guest));

    // 真实停用
    const off = await mgr.setEnabled(info.id, false, extSessionFactory);
    check('setEnabled(false) 返回 disabled 记录', off && off.enabled === false);
    await guest.loadURL(url);
    await new Promise((r) => setTimeout(r, 1200));
    check('[B] 停用后刷新，content script 不再注入', !(await readInj(guest)));

    // 真实启用
    const on = await mgr.setEnabled(info.id, true, extSessionFactory);
    check('setEnabled(true) 返回 enabled 记录', on && on.enabled === true);
    await guest.loadURL(url);
    await new Promise((r) => setTimeout(r, 1200));
    check('[C] 启用后刷新，content script 再次注入', await readInj(guest));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  srv.close(); win.destroy();
  setTimeout(() => app.quit(), 200);
});
