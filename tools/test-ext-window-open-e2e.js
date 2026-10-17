'use strict';
/**
 * 验证：侧边栏扩展（豆包类）window.open 时，承载面板**放行**（开真窗口）并收起空面板。
 * ---------------------------------------------------------------------------
 * 背景：豆包这类扩展的 side_panel 多是个「发射器」——真正界面靠 window.open 开成
 * 独立窗口，且只在真正的顶层窗口里渲染得出来（载进 webview / loadURL 都会空白）。
 * 所以承载面板不能再拦这个 window.open（拦了就只剩空白发射器），而要放行 +
 * 收起空面板。本测试注入一个 chrome-extension:// 的 window.open（模拟扩展行为），
 * 验证：① 真的开出了窗口（没被拦）② 承载面板收起。
 *
 * 跑法：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
 *     --use-angle=swiftshader --use-gl=angle --disable-gpu-sandbox --no-sandbox \
 *     tools/test-ext-window-open-e2e.js
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
setTimeout(() => { log('WATCHDOG'); process.exit(2); }, 40000);

app.whenReady().then(async () => {
  const { ExtensionManager } = require('../src/main/extensions');
  const ses = session.fromPartition(PART);
  const mgr = new ExtensionManager({ workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nw-')), partitions: [PART] });
  const info = await mgr.install(REAL_EXT_DIR, () => ses);
  const extOrigin = `chrome-extension://${info.electronId}/`;

  // 宿主页：承载 webview + 一个假的「面板」，并复刻 shell.js 的 new-window 处理逻辑
  const p = path.join(os.tmpdir(), `nw-${Date.now()}.html`);
  fs.writeFileSync(p, `<!doctype html><html><body style="margin:0">`
    + `<div id="panel" class="is-open"></div>`
    + `<webview id="wv" allowpopups partition="${PART}" src="${extOrigin}side_panel.html" style="width:420px;height:600px"></webview>`
    + `<script>
         var wv = document.getElementById('wv');
         wv.addEventListener('new-window', function (e) {
           var url = e.url;
           if (!url || /^about:/i.test(url)) { e.preventDefault(); return; }
           if (url.indexOf('${extOrigin}') === 0) {
             document.getElementById('panel').classList.remove('is-open');  // closeExtUiPanel()
             return;  // 放行 → 开真窗口
           }
           e.preventDefault();  // 外部 → 标签页
         });
       </script></body></html>`);

  const created = [];
  app.on('web-contents-created', (_e, wc) => {
    // 只数真正的新窗口（不是主窗口、不是宿主）
    created.push(wc.getType());
  });

  const win = new BrowserWindow({ width: 460, height: 660, show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true, webviewTag: true } });
  let guest = null;
  win.webContents.on('did-attach-webview', (_e, wc) => { guest = wc; });
  await win.loadFile(p);
  for (let i = 0; i < 80 && !guest; i++) await sleep(100);

  // 模拟扩展发射器：从 side_panel 页面里 window.open 出真正的界面
  await guest.executeJavaScript(
    `window.open('${extOrigin}popup.html', '_blank', 'popup=yes,width=420,height=760')`).catch(() => {});
  await sleep(2500);

  const panelOpen = await win.webContents.executeJavaScript(
    "document.getElementById('panel').classList.contains('is-open')");
  const hasWindow = created.some((t) => t === 'window' || t === 'webview' || t === 'browserView' || t === 'remote');

  check('window.open 真的开出了窗口（没被承载面板拦死）', hasWindow,
    'web-contents-created: ' + JSON.stringify(created));
  check('承载空面板已收起（不会留一块空白）', panelOpen === false, 'is-open=' + panelOpen);

  log(`\n结论：${pass} 通过 / ${fail} 失败`);
  setTimeout(() => app.quit(), 200);
});
