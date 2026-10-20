'use strict';

/**
 * 网页里的 window.print() 真能落到外壳 —— 真实 Chromium 探针
 * ---------------------------------------------------------------------------
 * 这条是给一个用户报过的问题留的：点了页面上的「打印」按钮，弹出来的却是
 * Windows 的系统打印对话框，Nova 的打印设置窗口根本没出现。
 *
 * 根因不是「没接管」，而是**接管装错了世界**：webview 开着 contextIsolation，
 * preload 跑在隔离世界，在那边改 window.print 页面看不见。Ctrl+P 是键盘事件、
 * 跨世界有效，所以「Ctrl+P 能弹窗」一直看着正常，把这个问题盖住了。
 *
 * 修法见 src/main/print-hook.js（主进程往页面主世界注入钩子，钩子 dispatch
 * 一个 nova:print 事件，preload 在隔离世界接住）。这条探针验的就是那套链路：
 *   1) 主世界的 window.print 被换掉了
 *   2) 顶层调用 → 宿主收到 nova-print
 *   3) iframe 里调用 → 宿主也收到（报表类页面常把内容放在 iframe 里）
 *
 * 用法：npm run check:printhook
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const electron = (() => {
  try { return require('electron'); } catch { return null; }
})();
const usable = electron && typeof electron === 'object'
  && electron.app && typeof electron.app.whenReady === 'function';

if (!usable) {
  console.error('\n这条探针必须在 Electron 里跑：\n  npm run check:printhook\n');
  if (process.env.ELECTRON_RUN_AS_NODE) {
    console.error('检测到 ELECTRON_RUN_AS_NODE，先清掉再跑：env -u ELECTRON_RUN_AS_NODE npm run check:printhook\n');
  }
  process.exit(2);
}

const { app, BrowserWindow } = electron;
const ROOT = path.join(__dirname, '..');
const PRELOAD = pathToFileURL(path.join(ROOT, 'src/preload/webview-preload.js')).href;
const { PRINT_HOOK_JS, installPrintHook } = require(path.join(ROOT, 'src/main/print-hook.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

app.disableHardwareAcceleration();
// 每个用例都会 destroy 窗口；不拦一下 app 会自己退出，后面的用例跑不到
app.on('window-all-closed', function () {});

/** 在 webview 里开一个页面，返回 { win, guest, messages } */
async function openPage(html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-hook-'));
  const pageFile = path.join(dir, 'page.html');
  fs.writeFileSync(pageFile, html);
  const hostFile = path.join(dir, 'host.html');
  fs.writeFileSync(hostFile, '<!doctype html><meta charset="utf-8"><body style="margin:0">'
    + '<webview id="wv" src="' + pathToFileURL(pageFile).href + '" preload="' + PRELOAD + '"'
    // 与 src/renderer/shell.js 里给 <webview> 的 webpreferences 完全一致
    + ' webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"'
    + ' style="width:800px;height:600px"></webview></body>');

  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { webviewTag: true } });
  let guest = null;
  win.webContents.on('did-attach-webview', (_e, g) => { guest = g; });
  await win.loadFile(hostFile);
  for (let i = 0; i < 60 && !guest; i++) await new Promise((r) => setTimeout(r, 50));
  // sendToHost 是送给**宿主页面里的 <webview> 元素**的，不是送给 guest 的
  // webContents —— 监听要装在宿主那一侧
  await win.webContents.executeJavaScript(
    'window.__msgs = [];'
    + "document.querySelector('#wv').addEventListener('ipc-message', function (e) { window.__msgs.push(e.channel); });"
    + 'true'
  );
  await new Promise((r) => setTimeout(r, 400));
  const messages = {
    list: async () => win.webContents.executeJavaScript('JSON.stringify(window.__msgs || [])')
  };
  return { win, guest, messages, dir };
}

const PAGE = (extra) => '<!doctype html><meta charset="utf-8"><body>'
  + '<div id="box">page</div>' + (extra || '') + '</body>';

/** 等子框架 commit。iframe 是异步加载的，固定 sleep 在慢机器上会偶发数不到 ——
 *  这里改成轮询，超时了也照原样返回，让断言自己报错而不是靠运气。 */
async function waitFrames(guest, n, ms) {
  const t0 = Date.now();
  let frames = guest.mainFrame.framesInSubtree;
  while (frames.length < n && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 100));
    frames = guest.mainFrame.framesInSubtree;
  }
  return frames;
}

app.whenReady().then(async () => {
  console.log('\n[1] 主世界的 window.print 被换掉了');

  {
    const { win, guest } = await openPage(PAGE());
    installPrintHook(guest);
    await new Promise((r) => setTimeout(r, 300));
    const info = await guest.executeJavaScript(
      'JSON.stringify({ mark: (window.print && window.print.__nova) || null })'
    );
    check('注入后主世界的 print 带上了钩子标记', info.indexOf('print-hook') >= 0, info);
    win.destroy();
  }

  console.log('\n[2] 顶层页面调用 window.print() → 宿主收到 nova-print');

  {
    const { win, guest, messages } = await openPage(PAGE());
    installPrintHook(guest);
    await new Promise((r) => setTimeout(r, 300));
    await guest.executeJavaScript('window.print(); true');
    await new Promise((r) => setTimeout(r, 400));
    const msgs = await messages.list();
    check('收到 nova-print', msgs.indexOf('nova-print') >= 0, msgs);
    win.destroy();
  }

  console.log('\n[3] iframe 里调用 window.print() → 宿主同样收到');

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-hook-frame-'));
    const innerFile = path.join(dir, 'inner.html');
    fs.writeFileSync(innerFile, '<!doctype html><meta charset="utf-8"><body>inner</body>');
    const outer = PAGE('<iframe id="f" src="' + pathToFileURL(innerFile).href + '" style="width:600px;height:300px"></iframe>');
    const { win, guest, messages } = await openPage(outer);
    installPrintHook(guest);
    // 从子框架里调 print（等价于页面在 iframe 内部点「打印」）
    const frames = await waitFrames(guest, 2, 5000);
    check('子框架被找到', frames.length >= 2, String(frames.length));
    const sub = frames.find((f) => f !== guest.mainFrame);
    if (sub) {
      // 钩子是在 did-frame-navigate 里补装的，子框架刚 commit 时可能还没轮到
      await new Promise((r) => setTimeout(r, 400));
      await sub.executeJavaScript('window.print(); true');
      await new Promise((r) => setTimeout(r, 400));
    }
    const msgs2 = await messages.list();
    check('子框架里的 print 也接到了宿主', msgs2.indexOf('nova-print') >= 0, msgs2);
    win.destroy();
  }

  console.log('\n[4] 没有注入时不该有钩子（确认不是浏览器原生行为）');
  {
    const { win, guest } = await openPage(PAGE());
    const info = await guest.executeJavaScript(
      'JSON.stringify({ mark: (window.print && window.print.__nova) || null })'
    );
    check('未注入时主世界没有钩子标记', info.indexOf('print-hook') < 0, info);
    win.destroy();
  }

  console.log(`\n结果：${pass}/${pass + fail} 通过`);
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
