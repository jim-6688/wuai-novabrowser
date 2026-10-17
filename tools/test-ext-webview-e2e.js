'use strict';

const { app, session, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

const PART = 'persist:nova-chromium';
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

function makeExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ext-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Nova Webview E2E',
    version: '1.0.0',
    content_scripts: [{
      matches: ['http://127.0.0.1/*'],
      js: ['cs.js'],
      run_at: 'document_start'
    }]
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'cs.js'),
    "document.documentElement.dataset.novaExtInjected = 'yes';");
  return dir;
}

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>e2e</title></head>'
        + '<body><h1 id="h">hello</h1></body></html>');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const readInjected = (wc) => wc.executeJavaScript(
  "document.documentElement.dataset.novaExtInjected || ''").then((v) => v === 'yes').catch(() => false);

app.whenReady().then(async () => {
  const extDir = makeExtension();
  const srv = await startServer();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const ses = session.fromPartition(PART);

  let ext = null;
  try { ext = await ses.loadExtension(extDir, { allowFileAccess: true }); }
  catch (e) { console.error('loadExtension 抛错:', e.message); }
  check('session.loadExtension 成功', !!ext, ext ? ext.id : 'null');

  const win = new BrowserWindow({
    width: 400, height: 300, show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true, webviewTag: true }
  });

  let guest = null;
  win.webContents.on('will-attach-webview', () => console.log('  [ev] will-attach-webview'));
  win.webContents.on('did-attach-webview', (_e, wc) => {
    console.log('  [ev] did-attach-webview -> ' + (wc ? wc.id : 'null'));
    guest = wc;
  });

  const tmpHtml = path.join(os.tmpdir(), 'nova-webview-host.html');
  fs.writeFileSync(tmpHtml, `<!doctype html><html><body>`
    + `<webview id="wv" partition="${PART}" src="${url}" `
    + `style="width:380px;height:280px"></webview></body></html>`);

  await win.loadFile(tmpHtml);

  for (let i = 0; i < 60 && !guest; i++) await new Promise((r) => setTimeout(r, 100));
  check('捕获到 webview 的 guest webContents', !!guest);

  if (guest) {
    guest.on('dom-ready', () => console.log('  [ev] guest dom-ready'));
    await new Promise((r) => setTimeout(r, 1500));
    const injected = await readInjected(guest);
    check('[关键] 扩展 content script 注入到 <webview> 页面里', injected);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  srv.close();
  win.destroy();
  setTimeout(() => app.quit(), 200);
});
