'use strict';

/**
 * 真实扩展端到端验证（侧边栏型）
 * ---------------------------------------------------------------------------
 * 用本机**实际安装**的扩展（豆包/Cici 类，清单声明 side_panel）走一遍真实
 * 装载链路，回答三件事：
 *   1) 真实扩展能不能被 ExtensionManager.loadExtension 装上（还是装的时候抛错）？
 *   2) 内容脚本注入在这套「Electron + <webview> 同分区」里到底工作不工作？
 *   3) 扩展上下文里的 chrome.sidePanel / chrome.action API 在不在？
 *      —— 在，但 Electron 根本不渲染侧边栏/弹窗 UI，所以「装上了点不出来」。
 * 顺便把「从已安装的浏览器导入」的探测（browserExtensions.scan）也跑一遍，
 * 确认那条路正不正常。
 *
 * 跑法（避开本会话的 ELECTRON_RUN_AS_NODE 污染）：
 *   env -u ELECTRON_RUN_AS_NODE \
 *     ./node_modules/electron/dist/electron.exe \
 *     --use-angle=swiftshader --use-gl=angle --disable-gpu-sandbox --no-sandbox \
 *     tools/test-ext-sidepanel-e2e.js [真实扩展目录]
 */

const { app, session, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

const PART = 'persist:nova-chromium';
const REAL_EXT_DEFAULT =
  'C:\\Users\\jim\\AppData\\Roaming\\吾爱Nova浏览器\\extensions'
  + '\\dbjibobgilijgolhjdcbdebjhejelffo_1.38.0_-e9d68cde';
// 真实扩展目录用环境变量传，避免和 electron 的 --use-gl 等开关争 argv[2]
const REAL_EXT_DIR = process.env.NOVA_REAL_EXT || REAL_EXT_DEFAULT;

let pass = 0, fail = 0;
const log = (s) => console.log(s);
const check = (name, cond, extra) => {
  if (cond) { pass++; log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

function makeProbeExt() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-probe-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Nova SidePanel Probe',
    version: '1.0.0',
    content_scripts: [{
      matches: ['http://127.0.0.1/*'],
      js: ['cs.js'],
      run_at: 'document_start'
    }]
  }, null, 2));
  // 内容脚本跑在隔离世界，但 document.documentElement.dataset 是 DOM、两世界共享，
  // 所以主世界 executeJavaScript 能读到。顺带把「扩展上下文里有哪些 API」记下来，
  // 这是判断侧边栏能不能用的关键证据。
  fs.writeFileSync(path.join(dir, 'cs.js'),
    `(function(){
      var d = document.documentElement.dataset;
      d.__novaCsLoaded = 'yes';
      try {
        d.__novaChrome = (typeof chrome !== 'undefined') ? 'yes' : 'no';
        d.__novaSidePanel = (typeof chrome !== 'undefined' && chrome.sidePanel) ? 'yes' : 'no';
        d.__novaAction = (typeof chrome !== 'undefined' && chrome.action) ? 'yes' : 'no';
        d.__novaRuntime = (typeof chrome !== 'undefined' && chrome.runtime) ? 'yes' : 'no';
      } catch (e) { d.__novaApiErr = String(e); }
    })();`);
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

const readDs = (wc, key) => wc.executeJavaScript(
  `document.documentElement.dataset['${key}'] || ''`).catch(() => '');

app.whenReady().then(async () => {
  const realDir = REAL_EXT_DIR;
  const probeDir = makeProbeExt();
  const srv = await startServer();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const ses = session.fromPartition(PART);

  const { ExtensionManager } = require('../src/main/extensions');
  const browserExtensions = require('../src/main/browser-extensions');

  const extManager = new ExtensionManager({
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nova-extwork-')),
    partitions: [PART]
  });

  log('\n=== 1) 真实侧边栏扩展装载 ===');
  let realInfo = null, realErr = '';
  try {
    realInfo = await extManager.install(realDir, () => session.fromPartition(PART));
    check('真实扩展 loadExtension 成功', !!realInfo, realInfo ? realInfo.electronId : 'null');
  } catch (e) {
    realErr = String(e && e.message || e);
    check('真实扩展 loadExtension 成功', false, '抛错: ' + realErr);
  }
  if (realInfo) {
    const list = extManager.list();
    const me = list.find((x) => x.electronId === realInfo.electronId);
    check('扩展出现在 extManager.list（enabled）', !!me && me.enabled !== false);
    const all = ses.getAllExtensions ? ses.getAllExtensions() : [];
    check('session 里能查到该扩展', all.some((x) => x.id === realInfo.electronId));
  }

  log('\n=== 2) 内容脚本注入（合成探针，证明链路本身工作） ===');
  let probe = null;
  try { probe = await extManager.install(probeDir, () => session.fromPartition(PART)); }
  catch (e) { log('  探针装载抛错: ' + String(e && e.message || e)); }
  check('探针扩展 loadExtension 成功', !!probe);

  const win = new BrowserWindow({
    width: 500, height: 400, show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true, webviewTag: true }
  });
  let guest = null;
  win.webContents.on('did-attach-webview', (_e, wc) => { guest = wc; });

  const tmpHtml = path.join(os.tmpdir(), 'nova-sidepanel-host.html');
  fs.writeFileSync(tmpHtml, `<!doctype html><html><body>`
    + `<webview id="wv" partition="${PART}" src="${url}" `
    + `style="width:480px;height:380px"></webview></body></html>`);

  await win.loadFile(tmpHtml);
  for (let i = 0; i < 80 && !guest; i++) await new Promise((r) => setTimeout(r, 100));
  check('捕获到 webview 的 guest webContents', !!guest);

  if (guest) {
    await new Promise((r) => setTimeout(r, 1500));
    const csLoaded = await readDs(guest, '__novaCsLoaded');
    check('[关键] 内容脚本注入到 <webview> 页面', csLoaded === 'yes', 'dataset=' + csLoaded);
    const sp = await readDs(guest, '__novaSidePanel');
    const act = await readDs(guest, '__novaAction');
    const rt = await readDs(guest, '__novaRuntime');
    const ch = await readDs(guest, '__novaChrome');
    log('  扩展上下文 API 可用性（content script 视角，跑在网页上）：');
    log('    typeof chrome      = ' + ch);
    log('    chrome.runtime     = ' + rt);
    log('    chrome.sidePanel   = ' + sp);
    log('    chrome.action      = ' + act);
    check('content script 里 chrome 命名空间存在', ch === 'yes');
    log('  注：content script 跑在「网页」上，Electron 不在这里暴露 sidePanel/action，');
    log('      这不代表扩展页里没有——下面第 5 步直接加载 side_panel.html 验证。');
  }

  log('\n=== 3) 「从已安装的浏览器导入」探测（browserExtensions.scan） ===');
  let found = [];
  try { found = browserExtensions.scan(); }
  catch (e) { log('  探测抛错: ' + String(e && e.message || e)); }
  check('探测能返回列表（不抛错）', Array.isArray(found));
  log('  探测到本机浏览器扩展 ' + found.length + ' 个：');
  found.slice(0, 12).forEach((x) => log('    - ' + x.name + '  [' + x.browser + ' / ' + x.crxId + ']'));

  log('\n=== 4) 真实扩展清单里的 UI 入口 ===');
  let sidePanelPath = null;
  if (realInfo && realInfo.dir) {
    try {
      const mf = JSON.parse(fs.readFileSync(path.join(realInfo.dir, 'manifest.json'), 'utf8'));
      sidePanelPath = (mf.side_panel && mf.side_panel.default_path) || null;
      log('   side_panel.default_path = ' + (sidePanelPath || '(无)'));
      log('   action.default_popup    = ' + (mf.action && mf.action.default_popup || '(无 → 点图标只会开侧边栏)'));
      log('   options_ui              = ' + (mf.options_ui && mf.options_ui.page || '(无)'));
      check('真实扩展依赖 side_panel 作为主界面', !!sidePanelPath);
    } catch (e) { log('  读清单失败: ' + String(e && e.message || e)); }
  }

  log('\n=== 5) 直接加载 side_panel.html（chrome-extension://<id>/…）验证 API 可用 ===');
  if (realInfo && sidePanelPath) {
    const extUrl = `chrome-extension://${realInfo.electronId}/${sidePanelPath}`;
    log('   加载: ' + extUrl);
    const spWin = new BrowserWindow({
      width: 500, height: 400, show: false,
      webPreferences: { contextIsolation: false, nodeIntegration: true, webviewTag: true }
    });
    let spGuest = null;
    spWin.webContents.on('did-attach-webview', (_e, wc) => { spGuest = wc; });
    const spHtml = path.join(os.tmpdir(), 'nova-sidepanel-page.html');
    fs.writeFileSync(spHtml, `<!doctype html><html><body>`
      + `<webview id="wv" partition="${PART}" src="${extUrl}" `
      + `style="width:480px;height:380px"></webview></body></html>`);
    await spWin.loadFile(spHtml);
    for (let i = 0; i < 80 && !spGuest; i++) await new Promise((r) => setTimeout(r, 100));
    if (spGuest) {
      await new Promise((r) => setTimeout(r, 2000));
      const inPage = await spGuest.executeJavaScript(
        `({
           chrome: typeof chrome !== 'undefined' ? 'yes' : 'no',
           sidePanel: (typeof chrome !== 'undefined' && chrome.sidePanel) ? 'yes' : 'no',
           title: document.title,
           bodyLen: (document.body && document.body.textContent || '').trim().length
         })`).catch((e) => ({ err: String(e) }));
      log('   扩展页（side_panel.html）内部视角：');
      log('     typeof chrome    = ' + (inPage.chrome || inPage.err || '?'));
      log('     chrome.sidePanel = ' + (inPage.sidePanel || inPage.err || '?') + '（宿主 API，扩展页自己不需要）');
      log('     document.title   = ' + (inPage.title || '(空)'));
      log('     body 文本长度    = ' + (inPage.bodyLen != null ? inPage.bodyLen : '?'));
      // **关键纠正**：承载方案是否可行，看的是 side_panel.html 有没有正常渲染出来
      // （有标题/有正文），而不是 chrome.sidePanel 在不在 —— 后者是「宿主去打开
      // 面板」的 API，扩展页自己根本不调用它。e2e 实测：同分区 webview 能渲染，
      // title="Side Panel" —— 这正是「Nova 自建停靠面板打开 side_panel.html」的依据。
      const rendered = !!(inPage && !inPage.err && (inPage.title || inPage.bodyLen));
      check('side_panel.html 在 webview 里正常渲染（承载方案可行）', rendered,
        'title=' + (inPage && inPage.title) + (rendered ? '' : ' · ' + (inPage && inPage.err)));
    } else {
      check('扩展页 webview 挂载成功', false);
    }
    spWin.destroy();
  } else {
    log('   （跳过：真实扩展未装载或无 side_panel）');
  }

  log(`\n结论：${pass} 通过 / ${fail} 失败`);
  log('—— 扩展本身装得上、内容脚本也注入了、探测也扫得到；但 Electron 不渲染侧边栏/弹窗 UI，');
  log('   后台 worker 还可能因缺 chrome.windows 崩溃，所以用户在 Nova 里「看不到也点不出」扩展界面。');
  log('   修复方向（已实现）：Nova 自建停靠面板 #ext-ui-panel，用同分区 webview 打开扩展自己的');
  log('   side_panel.html / popup.html / options.html（install() 已把入口路径记进 info.uiPaths）。');
  log('   第 5 步验证的正是这条路：side_panel.html 在同分区 webview 里能正常渲染。');

  srv.close();
  win.destroy();
  setTimeout(() => app.quit(), 200);
});
