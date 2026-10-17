'use strict';
/**
 * 回归：侧边栏扩展经 Nova 承载面板加载后**留在面板内**，不会逃逸成独立窗口。
 * ---------------------------------------------------------------------------
 * 背景：用户反馈豆包侧边栏「单独弹出窗口、不嵌入面板、加载特慢」。
 * 本测试用与外壳完全相同的承载方式（同分区 webview + chrome-extension://<id>/side_panel.html）
 * 验证：side_panel.html 能载入、停在该页、全程不触发 window.open / new-window /
 * did-create-window（即不会变成独立 BrowserWindow）。这是承载面板正确性的守门测试。
 *
 * 跑法：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
 *     --use-angle=swiftshader --use-gl=angle --disable-gpu-sandbox --no-sandbox \
 *     tools/test-ext-popup-breakout-e2e.js
 */

const { app, session, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

const PART = 'persist:nova-chromium';
const REAL_EXT_DIR = process.env.NOVA_REAL_EXT
  || 'C:\\Users\\jim\\AppData\\Roaming\\吾爱Nova浏览器\\extensions'
  + '\\dbjibobgilijgolhjdcbdebjhejelffo_1.38.0_-e9d68cde';

let pass = 0, fail = 0;
const log = (s) => console.log(s);
const check = (name, cond, extra) => {
  if (cond) { pass++; log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { log('WATCHDOG 强制退出'); process.exit(2); }, 40000);

app.whenReady().then(async () => {
  const { ExtensionManager } = require('../src/main/extensions');
  const ses = session.fromPartition(PART);
  const mgr = new ExtensionManager({ workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'np-')), partitions: [PART] });
  const info = await mgr.install(REAL_EXT_DIR, () => ses);
  const mf = JSON.parse(fs.readFileSync(path.join(info.dir, 'manifest.json'), 'utf8'));
  const sp = mf.side_panel && mf.side_panel.default_path;
  const extUrl = `chrome-extension://${info.electronId}/${sp}`;
  log('\n=== 承载面板：side_panel.html 应载入并留在面板内 ===');
  log('  ' + extUrl);

  let mainPopups = 0;
  app.on('web-contents-created', (_e, wc) => {
    try { wc.setWindowOpenHandler(() => { mainPopups++; return { action: 'deny' }; }); } catch (e) {}
    wc.on('did-create-window', () => { mainPopups++; });
  });

  const p = path.join(os.tmpdir(), `np-${Date.now()}.html`);
  fs.writeFileSync(p, `<!doctype html><html><body style="margin:0">`
    + `<webview id="wv" allowpopups partition="${PART}" src="${extUrl}" style="width:420px;height:600px"></webview>`
    + `<script>window.__popups=[];var w=document.getElementById('wv');`
    + `w.addEventListener('new-window',function(e){window.__popups.push(e.url);});`
    + `w.addEventListener('dom-ready',function(){window.__dr=Date.now();});</script></body></html>`);
  const win = new BrowserWindow({ width: 460, height: 660, show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true, webviewTag: true } });
  await win.loadFile(p);
  await sleep(12000);
  const r = await win.webContents.executeJavaScript(
    `JSON.stringify({popups:window.__popups||[],url:document.getElementById('wv').getURL(),dr:!!window.__dr})`);
  const st = JSON.parse(r);
  win.destroy();

  check('side_panel.html 在承载 webview 里加载（dom-ready 触发）', st.dr === true);
  check('面板始终停在扩展自己的页面上（没有逃逸）', st.url === extUrl, st.url);
  check('渲染层无 window.open / new-window 逃逸', (st.popups || []).length === 0,
    (st.popups || []).length + ' 次');
  check('主进程无独立窗口被创建（did-create-window / setWindowOpenHandler）', mainPopups === 0,
    mainPopups + ' 次');

  log(`\n结论：${pass} 通过 / ${fail} 失败`);
  log('—— 全过即证明：承载面板把 side_panel.html 载入并留在面板内，不会逃逸成独立窗口。');
  setTimeout(() => app.quit(), 200);
});
