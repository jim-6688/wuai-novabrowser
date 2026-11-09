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
 * 用户报「保存的用户名和密码不能自动填充」之后补了三种真实登录页形态，
 * 旧探针只有「一个用户名框 + 一个密码框」的静态页，这三种全都测不到：
 *   5) React / Vue 受控输入（页面劫持了 input.value，直接赋值不派 onChange）
 *   6) 页面同时挂着注册框 / 蜜罐框（不止一个密码框）
 *   7) 开口之后 SPA 把整张表单重绘掉
 *
 * 用法：npm run check:autofill
 *   （Git Bash 里若继承了 ELECTRON_RUN_AS_NODE，改用
 *     env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe
 *       --use-angle=swiftshader --use-gl=angle --disable-gpu-sandbox --no-sandbox
 *       tools/test-autofill-electron.js）
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
 * 受控输入：页面自己给两个框装上 React 风格的 value tracker。
 * 框架的判定是「input 事件里当前值 !== tracker 记录的值」才算变化；
 * 直接 el.value = v 会把 tracker 一起改掉，onChange 因此不派发，下一次
 * 渲染又把空的 state 写回来 —— 用户看到的就是「没填 / 填了又没了」。
 */
const CONTROLLED = '<!doctype html><meta charset="utf-8"><body>'
  + '<form id="f"><input id="u" type="text" name="user" autocomplete="username">'
  + '<input id="p" type="password" autocomplete="current-password">'
  + '<input type="submit" value="登录"></form>'
  + '<script>(function(){'
  + 'var d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");'
  + 'window.__seen={};'
  + '["u","p"].forEach(function(id){'
  + '  var el=document.getElementById(id), last=d.get.call(el);'
  + '  Object.defineProperty(el,"value",{configurable:true,'
  + '    get:function(){return d.get.call(this)},'
  + '    set:function(v){last=v;d.set.call(this,v)}});'
  + '  window.__seen[id]=false;'
  + '  el.addEventListener("input",function(){if(d.get.call(el)!==last)window.__seen[id]=true});'
  + '});})();</script></body>';

/** 登录页 + 隐藏的注册表单 + 蜜罐框：DOM 里一共四个密码框 */
const MULTI_PW = '<!doctype html><meta charset="utf-8"><body>'
  + '<form id="reg" style="display:none">'
  + '<input id="rp1" type="password" autocomplete="new-password">'
  + '<input id="rp2" type="password" autocomplete="new-password"></form>'
  + '<form id="f"><input id="u" type="text" name="user">'
  + '<input id="honey" type="password" hidden>'
  + '<input id="p" type="password" autocomplete="current-password">'
  + '<input type="submit" value="登录"></form></body>';

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
  // 监听器写在宿主页的**内联脚本**里，紧跟 <webview> 之后同步执行。
  // 以前是在 loadFile 完成后再用 executeJavaScript 补挂：guest 是小页面，
  // preload 在 DOMContentLoaded 就发了 nova-cred-ask，那时宿主还没开始监听，
  // 消息直接丢了 —— 探针自己造出的假阴性（真实外壳在 appendChild 之前就挂好了）。
  fs.writeFileSync(hostFile, '<!doctype html><meta charset="utf-8"><body style="margin:0">'
    + '<webview id="wv" src="' + pathToFileURL(pageFile).href + '" preload="' + PRELOAD + '"'
    + ' webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"'
    + ' style="width:800px;height:600px"></webview>'
    + '<script>'
    + 'window.__ask = [];'
    + 'document.querySelector("#wv").addEventListener("ipc-message", function (e) {'
    + '  window.__ask.push({ ch: e.channel, args: e.args });'
    + '});'
    + '</script></body>');

  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { webviewTag: true } });
  let wv = null;
  win.webContents.on('did-attach-webview', (_e, el) => { wv = el; });
  await win.loadFile(hostFile);
  for (let i = 0; i < 60 && !wv; i++) await new Promise((r) => setTimeout(r, 50));

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

  /* 4. React/Vue 受控输入：值要写进去，还要让框架的 onChange 判定认这个变化 */
  {
    const { win, wv, asked } = await open(CONTROLLED);
    await wait(900);
    check('受控表单也向宿主开口',
      channelsOf(await asked()).indexOf('nova-cred-ask') >= 0);
    wv.send('nova-cred-fill', { username: 'me', password: 'pw-ctrl' });
    await wait(300);
    const state = JSON.parse(await wv.executeJavaScript(
      'JSON.stringify({seen:window.__seen,u:document.querySelector("#u").value,'
      + 'p:document.querySelector("#p").value})'));
    check('受控输入框里确实有值', state.u === 'me' && state.p === 'pw-ctrl', JSON.stringify(state));
    check('框架感知到值变化（不会被下一次渲染清空）',
      !!state.seen && state.seen.u === true && state.seen.p === true, JSON.stringify(state.seen));
    win.destroy();
  }

  /* 5. 页面里不止一个密码框：仍然要问，且只填登录那个 */
  {
    const { win, wv, asked } = await open(MULTI_PW);
    await wait(900);
    check('四个密码框的登录页仍然开口问',
      channelsOf(await asked()).indexOf('nova-cred-ask') >= 0);
    wv.send('nova-cred-fill', { username: 'me', password: 'pw-multi' });
    await wait(300);
    const vals = JSON.parse(await wv.executeJavaScript(
      'JSON.stringify({u:document.querySelector("#u").value,'
      + 'p:document.querySelector("#p").value,honey:document.querySelector("#honey").value,'
      + 'rp1:document.querySelector("#rp1").value,rp2:document.querySelector("#rp2").value})'));
    check('填的是 current-password 那个登录框', vals.u === 'me' && vals.p === 'pw-multi', JSON.stringify(vals));
    check('蜜罐框 / 注册框一个都没被填',
      !vals.honey && !vals.rp1 && !vals.rp2, JSON.stringify(vals));
    win.destroy();
  }

  /* 6. 开口之后 SPA 把整张表单重绘掉：回填不能丢 */
  {
    const { win, wv, asked } = await open(LOGIN(false));
    await wait(900);
    check('重绘前已经开过口', channelsOf(await asked()).indexOf('nova-cred-ask') >= 0);
    await wv.executeJavaScript(
      'document.querySelector("#f").innerHTML = '
      + JSON.stringify('<input id="u2" type="text" name="user">'
        + '<input id="p2" type="password" autocomplete="current-password">')
      + '; true');
    await wait(150);   // 给 MutationObserver 一点时间把记住的框换到新 DOM
    wv.send('nova-cred-fill', { username: 'me', password: 'pw-spa' });
    await wait(300);
    const vals = JSON.parse(await wv.executeJavaScript(
      'JSON.stringify({u:document.querySelector("#u2").value,p:document.querySelector("#p2").value})'));
    check('SPA 重绘后回填落到新框上', vals.u === 'me' && vals.p === 'pw-spa', JSON.stringify(vals));
    win.destroy();
  }

  console.log(`\n结果：${pass}/${pass + fail} 通过`);
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
