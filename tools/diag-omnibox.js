'use strict';
/**
 * 诊断 2：分别检查
 *  A) 外壳启动（主页=newtab）时，外壳 omnibox 是否聚焦 / omni-panel 是否弹出；
 *  B) 内置 newtab 页面本身加载时，它自己的搜索框（页面内 input）是否自动获得焦点。
 * 复用 shot.js 的 http 服务 + 隐藏窗口机制（预览模式走 bridge-mock）。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 4401;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};
if (!app || typeof app.whenReady !== 'function') { console.error('need electron'); process.exit(2); }
app.disableHardwareAcceleration();

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const t = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      fs.readFile(t, (e, d) => {
        if (e) { res.writeHead(404).end('404'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(t).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(d);
      });
    });
    s.listen(PORT, '127.0.0.1', () => resolve(s));
  });
}

app.whenReady().then(async () => {
  const server = await serve();

  // ===== A) 外壳，主页强制为 newtab =====
  const win = new BrowserWindow({ show: false, width: 1280, height: 820, backgroundColor: '#F6F7FB' });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await win.loadURL(`http://127.0.0.1:${PORT}/src/renderer/shell.html`);
  for (let i = 0; i < 80; i++) {
    if (await js("typeof state !== 'undefined' && state.tabs && state.tabs.length > 0")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // 把当前激活标签强行变成 newtab 并刷新外壳
  await js("(function(){ var t = state.tabs[state.activeId-1] || state.tabs[0]; if(t){ t.url = newTabUrl(); t.title='新标签页'; } syncOmnibox(); return 1; })()");
  await new Promise((r) => setTimeout(r, 400));
  const A = await js(`(function(){
    var input = document.querySelector('#omni-input');
    var panel = document.querySelector('#omni-panel');
    var ae = document.activeElement;
    return { activeElementId: ae?(ae.id||ae.tagName):'(none)', omniInputIsActive: ae===input,
      omniPanelHidden: panel?panel.hidden:'(none)', omniValue: input?input.value:'' };
  })()`);
  console.log('=== A) 外壳主页=newtab 启动态 ===');
  console.log(JSON.stringify(A, null, 2));
  const imgA = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'screenshots', 'diag-shell-newtab.png'), imgA.toPNG());
  console.log('SHOT diag-shell-newtab.png');
  win.destroy();

  // ===== B) 内置 newtab 页面自身 =====
  const tab = new BrowserWindow({ show: false, width: 520, height: 760, backgroundColor: '#F4F6FB', webPreferences: { offscreen: false } });
  try {
    await tab.loadURL(`http://127.0.0.1:${PORT}/src/renderer/newtab.html?theme=light&store=1`);
  } catch (e) { console.log('newtab load err:', e && e.message); }
  await new Promise((r) => setTimeout(r, 1500));
  const B = await tab.webContents.executeJavaScript(`(function(){
    var ae = document.activeElement;
    var inputs = Array.prototype.slice.call(document.querySelectorAll('input,textarea,[contenteditable]'));
    return { activeElementId: ae?(ae.id||ae.tagName):'(none)', activeElementIsInput: inputs.indexOf(ae)>=0,
      inputCount: inputs.length, ids: inputs.map(function(i){return i.id||i.tagName;}) };
  })()`, true);
  console.log('=== B) 内置 newtab 页面加载态 ===');
  console.log(JSON.stringify(B, null, 2));
  const imgB = await tab.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT, 'screenshots', 'diag-newtab.png'), imgB.toPNG());
  console.log('SHOT diag-newtab.png');
  tab.destroy();

  server.close();
  app.quit();
});
