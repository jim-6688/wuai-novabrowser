'use strict';
/**
 * 第三方登录弹窗 · 真机验证（Electron）
 * ---------------------------------------------------------------------------
 * 验的是「QQ/微信登录点了没反应」这个故障的修复是否真的成立，三件事缺一不可：
 *
 *   ① window.open 能被**放行成真窗口**，而不是被 deny 掉、也不是变成标签页
 *   ② 新窗口里 `window.opener` **非空** —— 登录结果靠它 postMessage 回传，
 *      这一条没了，扫码成功原页面也永远不知道
 *   ③ 新窗口与打开它的页面**同一个 session** —— 否则回调那一跳回来是未登录
 *
 * 判定与开窗参数都直接 require src/main/auth-popup.js（跑的那份 = 测的那份），
 * 这里只复刻 main.js 里那几行 return 语句。
 *
 * 跑法：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
 *     --use-angle=swiftshader --use-gl=angle --disable-gpu-sandbox --no-sandbox \
 *     tools/test-auth-popup-e2e.js
 */

const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../src/main/auth-popup.js');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-popup-blocking');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 45000);

const PART = 'persist:nova-authpopup-test';

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authpopup-'));
  const popupFile = path.join(dir, 'popup.html');
  const childFile = path.join(dir, 'child.html');
  const hostFile = path.join(dir, 'host.html');
  const plainFile = path.join(dir, 'plain.html');

  // 「授权页」：一进来就把结果 postMessage 给 opener（模拟登录成功回调）
  fs.writeFileSync(popupFile, `<!doctype html><meta charset="utf-8">
    <body><h1>authorize</h1><script>
      window.__NOVA_POPUP__ = true;
      try { if (window.opener) window.opener.postMessage({ t: 'login-ok' }, '*'); } catch (e) {}
    </script></body>`, 'utf8');
  fs.writeFileSync(plainFile, '<!doctype html><meta charset="utf-8"><body>plain</body>', 'utf8');

  // 被 webview 加载的页面：两个按钮，一个带尺寸（应弹窗），一个不带（应标签页）
  fs.writeFileSync(childFile, `<!doctype html><meta charset="utf-8"><body>
    <button id="sized">sized</button><button id="plain">plain</button>
    <script>
      function toURL(name) {
        var base = location.href.replace(/[^/]*$/, '');
        return base + name;
      }
      document.getElementById('sized').onclick = function () {
        window.open(toURL('popup.html'), '_blank', 'width=520,height=640');
      };
      document.getElementById('plain').onclick = function () {
        window.open(toURL('plain.html'), '_blank');
      };
    </script></body>`, 'utf8');

  fs.writeFileSync(hostFile, `<!doctype html><meta charset="utf-8">
    <body style="margin:0"><webview id="wv" allowpopups style="width:600px;height:500px"
      src="child.html" partition="${PART}"></webview></body>`, 'utf8');

  const win = new BrowserWindow({
    width: 700, height: 600, show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true, webviewTag: true }
  });

  let guest = null;
  win.webContents.on('did-attach-webview', (_e, wc) => { guest = wc; });
  await win.loadFile(hostFile);
  for (let i = 0; i < 100 && !guest; i++) await sleep(100);
  check('webview 已挂载（拿到 guest webContents）', !!guest);
  if (!guest) { console.log(`\n结论：${pass} 通过 / ${fail} 失败`); return app.quit(); }

  /* 复刻 main.js 的 setWindowOpenHandler（判定与参数都来自 auth-popup.js） */
  const denied = [];
  const opened = [];
  guest.setWindowOpenHandler(({ url, disposition, features }) => {
    const d = A.decide({ url, disposition, features, allowAuthPopups: true });
    if (d.popup) {
      opened.push({ url, reason: d.reason, width: d.width, height: d.height });
      return {
        action: 'allow',
        overrideBrowserWindowOptions: A.windowOptions(d, { session: guest.session, parent: win })
      };
    }
    denied.push(url);
    return { action: 'deny' };
  });

  // ---- ① 带尺寸的 window.open：应放行成真窗口
  await guest.executeJavaScript("document.getElementById('sized').click()").catch(() => {});
  await sleep(2500);

  check('带尺寸的 window.open 走进「弹窗」分支', opened.length === 1 && opened[0].reason === 'sized-popup',
    JSON.stringify(opened));
  check('放行时没有丢进标签页', denied.length === 0, JSON.stringify(denied));

  const kids = BrowserWindow.getAllWindows().filter((w) => w !== win);
  check('真的开出了独立窗口', kids.length >= 1, '窗口数=' + (kids.length + 1));

  const popupWc = kids.length ? kids[0].webContents : null;
  if (popupWc) {
    // ---- ② opener 必须还在（登录结果靠它回传）
    const hasOpener = await popupWc.executeJavaScript('!!window.opener').catch(() => null);
    check('新窗口里 window.opener 非空', hasOpener === true, 'opener=' + hasOpener);

    // ---- ③ 同一个 session（Cookie / 登录态才对得上）
    check('新窗口与 opener 共用 session', popupWc.session === guest.session,
      popupWc.session === guest.session ? 'same' : 'different');

    const isPopupPage = await popupWc.executeJavaScript('!!window.__NOVA_POPUP__').catch(() => null);
    check('新窗口里加载的是目标页面', isPopupPage === true, String(isPopupPage));
  }

  // ---- ④ 不带尺寸的普通 window.open：仍应走标签页（deny），不开新窗口
  const before = BrowserWindow.getAllWindows().length;
  await guest.executeJavaScript("document.getElementById('plain').click()").catch(() => {});
  await sleep(1800);
  check('普通 window.open 仍走标签页分支', denied.length === 1, JSON.stringify(denied));
  check('没为普通 window.open 开新窗口',
    BrowserWindow.getAllWindows().length === before,
    `${before} → ${BrowserWindow.getAllWindows().length}`);

  console.log(`\n结论：${pass} 通过 / ${fail} 失败`);
  setTimeout(() => app.quit(), 300);
}).catch((err) => {
  console.error('测试异常:', err && err.message);
  process.exit(1);
});
