'use strict';

/**
 * 突破网页禁用右键 —— 真实 Chromium 探针
 * ---------------------------------------------------------------------------
 * 用户报的问题：有些网页禁用了右键（contextmenu preventDefault），Nova 的原生
 * 右键菜单就弹不出来，「复制 / 另存图片 / 导出 PDF」全用不了。
 *
 * Electron 只在网页没拦 contextmenu 时才发 webContents 的 context-menu 事件，
 * 被拦了外壳根本收不到。修法见 src/main/context-menu-hook.js：主进程往页面主
 * 世界注入钩子，捕获阶段先拿右键信息，setTimeout 后判断 defaultPrevented ——
 * 被拦才 dispatch nova:context-menu，preload 转 sendToHost 让外壳补弹。
 *
 * 这条探针验那套链路的核心行为：
 *   1) 钩子装上后，网页 preventDefault 右键 → 宿主收到 nova-context-menu（带上下文）
 *   2) 网页没拦右键 → 不发（否则正常页面会弹两次菜单）
 *   3) iframe 里被拦 → 也转上来
 *
 * 用法：npm run check:ctxhook
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
  console.error('\n这条探针必须在 Electron 里跑：\n  npm run check:ctxhook\n');
  if (process.env.ELECTRON_RUN_AS_NODE) {
    console.error('检测到 ELECTRON_RUN_AS_NODE，先清掉再跑：env -u ELECTRON_RUN_AS_NODE npm run check:ctxhook\n');
  }
  process.exit(2);
}

const { app, BrowserWindow } = electron;
const ROOT = path.join(__dirname, '..');
const PRELOAD = pathToFileURL(path.join(ROOT, 'src/preload/webview-preload.js')).href;
const { CONTEXT_HOOK_JS, installContextHook } = require(path.join(ROOT, 'src/main/context-menu-hook.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

app.disableHardwareAcceleration();
app.on('window-all-closed', function () {});

/** 在 webview 里开一个页面，装好钩子，返回 { win, guest, events, dir } */
async function openPage(html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ctx-'));
  const pageFile = path.join(dir, 'page.html');
  fs.writeFileSync(pageFile, html);
  const hostFile = path.join(dir, 'host.html');
  fs.writeFileSync(hostFile, '<!doctype html><meta charset="utf-8"><body style="margin:0">'
    + '<webview id="wv" src="' + pathToFileURL(pageFile).href + '" preload="' + PRELOAD + '"'
    + ' webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"'
    + ' style="width:800px;height:600px"></webview></body>');

  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { webviewTag: true } });
  let guest = null;
  win.webContents.on('did-attach-webview', (_e, g) => { guest = g; });
  await win.loadFile(hostFile);
  for (let i = 0; i < 60 && !guest; i++) await new Promise((r) => setTimeout(r, 50));
  // sendToHost 送给宿主页面里的 <webview> 元素，监听装在宿主侧
  await win.webContents.executeJavaScript(
    'window.__ctx = [];'
    + "document.querySelector('#wv').addEventListener('ipc-message', function (e) {"
    + "  if (e.channel === 'nova-context-menu') window.__ctx.push(e.args[0]);"
    + '});'
    + 'true'
  );
  await new Promise((r) => setTimeout(r, 300));
  installContextHook(guest);
  await new Promise((r) => setTimeout(r, 200));
  return {
    win, guest, dir,
    events: {
      list: async () => JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__ctx || [])'))
    }
  };
}

/** 派发一个右键事件（页面主世界，不可 bubbles=false；contextmenu 默认 bubbles） */
const FIRE = `(function () {
  var el = document.getElementById('box') || document.body;
  var ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 123, clientY: 45 });
  el.dispatchEvent(ev);
  return true;
})()`;

app.whenReady().then(async () => {
  console.log('\n[1] 网页 preventDefault 右键 → 宿主收到 nova-context-menu');

  {
    const page = '<!doctype html><meta charset="utf-8"><body>'
      + '<a id="box" href="https://example.com/target">link</a>'
      + '<script>document.addEventListener("contextmenu", function(e){ e.preventDefault(); });<\/script>'
      + '</body>';
    const { win, guest, events } = await openPage(page);
    await guest.executeJavaScript(FIRE).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    const list = await events.list();
    check('被拦的右键触发了 nova-context-menu', list.length >= 1, JSON.stringify(list));
    if (list.length) {
      const p = list[0];
      check('上下文带上了链接地址', p && p.linkURL === 'https://example.com/target', JSON.stringify(p));
      check('上下文带上了坐标', p && p.x === 123 && p.y === 45, JSON.stringify(p));
    }
    win.destroy();
  }

  console.log('\n[2] 网页没拦右键 → 不发（避免弹两次）');

  {
    const page = '<!doctype html><meta charset="utf-8"><body><a id="box" href="https://ok.example/x">ok</a></body>';
    const { win, guest, events } = await openPage(page);
    await guest.executeJavaScript(FIRE).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    const list = await events.list();
    check('未被拦的右键不发新通道（原生菜单照常弹）', list.length === 0, JSON.stringify(list));
    win.destroy();
  }

  console.log('\n[3] iframe 里被拦 → 转给顶层 → 宿主收到');

  {
    const frameHtml = '<!doctype html><meta charset="utf-8"><body><div id="box">frame</div>'
      + '<script>document.addEventListener("contextmenu", function(e){ e.preventDefault(); });<\/script>'
      + '</body>';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ctx-frame-'));
    const frameFile = path.join(dir, 'frame.html');
    fs.writeFileSync(frameFile, frameHtml);
    const page = '<!doctype html><meta charset="utf-8"><body><div id="box">top</div>'
      + '<iframe src="' + pathToFileURL(frameFile).href + '" style="width:400px;height:300px"></iframe></body>';
    const { win, guest, events } = await openPage(page);
    // 等 iframe commit
    for (let i = 0; i < 40 && guest.mainFrame.framesInSubtree.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    installContextHook(guest);
    await new Promise((r) => setTimeout(r, 200));
    // 在子框架里派发右键
    const frames = guest.mainFrame.framesInSubtree;
    const child = frames.find((f) => f !== guest.mainFrame);
    check('子框架已就绪', !!child);
    if (child) {
      const childHook = await child.executeJavaScript('!!window.__novaCtxHook').catch(() => false);
      check('子框架装上了钩子', childHook, String(childHook));
      await child.executeJavaScript(FIRE).catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
      const list = await events.list();
      check('子框架被拦的右键也转上来', list.length >= 1, JSON.stringify(list));
    }
    win.destroy();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
