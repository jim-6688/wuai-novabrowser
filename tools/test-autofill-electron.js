'use strict';

/**
 * 「再打开站点时自动带入密码」的真实 Chromium 探针
 * ---------------------------------------------------------------------------
 * jsdom 跑不了页面 preload（它要 ipcRenderer、要真的 DOM 时机），所以这段链路
 * 单独用 Electron 验一遍：
 *
 *   1) 页面里出现空的登录表单 → preload 向宿主问一次（nova-cred-ask）
 *   2) 宿主回一条 nova-cred-fill → 输入框里出现账号密码
 *
 * 另外两条边界也要真机才能验：
 *   3) 没有密码框的页面（首页/搜索页）不该问
 *   4) 密码框已经有值（页面自己带值 / 用户正在打）不该覆盖 —— 覆盖用户的
 *      输入是这类功能最讨厌的事故
 *
 * 用法：npm run check:autofill
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
  console.error('\n这条探针必须在 Electron 里跑：\n  npm run check:autofill\n');
  process.exit(2);
}

const { app, BrowserWindow } = electron;
const ROOT = path.join(__dirname, '..');
const PRELOAD = pathToFileURL(path.join(ROOT, 'src/preload/webview-preload.js')).href;

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

app.disableHardwareAcceleration();
app.on('window-all-closed', function () {});

/** 登录页：一个用户名框 + 一个密码框。prefill 表示页面自己已经带了值。 */
const LOGIN = (prefill) => '<!doctype html><meta charset="utf-8"><body>'
  + '<form id="f"><input id="u" type="text" value="' + (prefill ? 'someone' : '') + '">'
  + '<input id="p" type="password" value="' + (prefill ? 'oldpass' : '') + '">'
  + '<input type="submit" value="登录"></form></body>';

/** 没有密码框的普通页。 */
const PLAIN = '<!doctype html><meta charset="utf-8"><body><h1>首页</h1>'
  + '<input type="search" placeholder="搜索"></body>';

/**
 * 起一个装着 webview 的宿主页。
 *
 * 返回 { win, wv, asked }；asked() 同步回读宿主页面里记下的消息数组。
 *
 * 注意两件踩过的坑：
 *  - `ipc-message` 是宿主页面里的 DOM 事件，监听必须**从宿主页面里**给 #wv 挂
 *    （executeJavaScript）。在主进程侧给同一个元素 addEventListener 收不到，
 *    表现就是「preload 明明发了，宿主却什么都没收到」。
 *  - `sendToHost` 的消息也是送到宿主页面里的 <webview> 元素上，不是 guest 的
 *    webContents —— 同理。
 */
async function open(html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-af-'));
  const pageFile = path.join(dir, 'page.html');
  fs.writeFileSync(pageFile, html);
  const hostFile = path.join(dir, 'host.html');
  fs.writeFileSync(hostFile, '<!doctype html><meta charset="utf-8"><body style="margin:0">'
    + '<webview id="wv" src="' + pathToFileURL(pageFile).href + '" preload="' + PRELOAD + '"'
    + ' webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"'
    + ' style="width:800px;height:600px"></webview></body>');

  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { webviewTag: true } });
  let wv = null;
  win.webContents.on('did-attach-webview', (_e, el) => { wv = el; });
  await win.loadFile(hostFile);
  for (let i = 0; i < 60 && !wv; i++) await new Promise((r) => setTimeout(r, 50));

  // 在宿主页面里挂好记录器（监听必须在 document 这一侧，见函数注释）
  await win.webContents.executeJavaScript(
    'window.__ask = [];'
    + 'document.querySelector("#wv").addEventListener("ipc-message", function (e) {'
    + '  window.__ask.push({ ch: e.channel, args: e.args });'
    + '}); true'
  );
  const asked = async () => JSON.parse(await win.webContents.executeJavaScript(
    'JSON.stringify(window.__ask || [])'));
  return { win, wv, dir, asked };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const channelsOf = (list) => list.map((a) => a.ch).join(',');

app.whenReady().then(async () => {
  /* 1. 空登录表单 → 问一次，宿主回填后输入框里有值 */
  {
    const { win, wv, asked } = await open(LOGIN(false));
    await wait(900);
    const list = await asked();
    check('登录表单向宿主问了（nova-cred-ask）',
      channelsOf(list).indexOf('nova-cred-ask') >= 0, channelsOf(list));

    const ask = list.find((a) => a.ch === 'nova-cred-ask');
    check('问的时候带上了本站 origin（宿主据此核对是不是这个站点）',
      !!ask && ask.args && ask.args[0] && typeof ask.args[0].origin === 'string',
      JSON.stringify(ask && ask.args));

    // 宿主侧：对应 shell.js 的 autofillLogin 这一端
    wv.send('nova-cred-fill', { username: 'me', password: 'p@ssw0rd' });
    await wait(300);
    const vals = await wv.executeJavaScript(
      'JSON.stringify({u:document.querySelector("#u").value,p:document.querySelector("#p").value})');
    check('账号密码填进了输入框',
      vals.indexOf('"u":"me"') >= 0 && vals.indexOf('"p":"p@ssw0rd"') >= 0, vals);

    win.destroy();
  }

  /* 2. 没有密码框 → 不该问 */
  {
    const { win, asked } = await open(PLAIN);
    await wait(900);
    const list = await asked();
    check('没有密码框的页面不问', channelsOf(list).indexOf('nova-cred-ask') < 0, channelsOf(list));
    win.destroy();
  }

  /* 3. 密码框已经有值 → 不该问，也不该覆盖 */
  {
    const { win, wv, asked } = await open(LOGIN(true));
    await wait(900);
    const list = await asked();
    check('页面自带密码的登录框不问', channelsOf(list).indexOf('nova-cred-ask') < 0, channelsOf(list));
    wv.send('nova-cred-fill', { username: 'me', password: 'new' });
    await wait(300);
    const vals = await wv.executeJavaScript(
      'JSON.stringify({u:document.querySelector("#u").value,p:document.querySelector("#p").value})');
    check('不覆盖用户已经在输入框里的值', vals.indexOf('oldpass') >= 0, vals);
    win.destroy();
  }

  console.log(`\n结果：${pass}/${pass + fail} 通过`);
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
