'use strict';

/**
 * 真实渲染截图 —— 用 Electron 把外壳与设置页各状态抓成 PNG
 * ---------------------------------------------------------------------------
 * 为什么值得单独做一个：这个项目没有浏览器扩展可依赖，靠 jsdom 只能断言 DOM 结构，
 * 断不出「这一屏到底长什么样」。而真实排版问题（覆盖层铺满、标题副标题挤一行）
 * 只有截图能看出来。
 *
 * 用法：
 *   npm run shots
 *   （即 electron --no-sandbox tools/shot.js；--no-sandbox 在本机沙箱下必需）
 * 产出：screenshots/*.png
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots');
const PORT = Number(process.env.SHOT_PORT || 4398);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

if (!app || typeof app.whenReady !== 'function') {
  console.error('需要在 Electron 里跑：npm run shots');
  process.exit(2);
}

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
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const win = new BrowserWindow({ show: false, width: 1280, height: 820, backgroundColor: '#F6F7FB' });
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await win.loadURL(`http://127.0.0.1:${PORT}/src/renderer/shell.html`);
  for (let i = 0; i < 60; i++) {
    if (await js("document.querySelectorAll('#engine-menu-list .em-item').length > 0")) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const shot = async (name) => {
    await new Promise((r) => setTimeout(r, 450));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    console.log('SHOT ' + name);
  };

  // 关掉入场动画再拍。
  // 弹层/面板的进场是 transform 动画，而隐藏窗口里动画帧会被节流 ——
  // 450ms 的等待远不够它滑到位，拍出来是「滑到一半」的残影（实测弹层卡片
  // 停在 translateY(100%)，整个在视口下面）。截图要的是终态，不是中间帧。
  await js("(function(){var s=document.createElement('style');"
    + "s.textContent='*{animation:none !important;transition:none !important}';"
    + 'document.head.appendChild(s);return 1})()');

  // 桌面端：外壳总览
  await shot('01-shell-desktop');

  for (const [sec, name] of [['general', '02-set-general'], ['engines', '03-set-engines'],
    ['adblock', '04-set-adblock'], ['privacy', '05-set-privacy'], ['bookmarks', '06-set-bookmarks'],
    ['downloads', '07-set-downloads'], ['sniffer', '08-set-sniffer'], ['mobile', '09-set-mobile']]) {
    await js(`openSettings('${sec}')`);
    await shot(name);
  }

  await js('closeSettings()');
  await shot('10-shell-back');

  // 移动端：真的把窗口调到手机宽度，而不是只在 1280 下强行切档
  win.setContentSize(420, 820);
  await new Promise((r) => setTimeout(r, 400));
  await js("state.settings.layout='mobile'; applyLayout(); openSettings('general');");
  await shot('11-mobile-set-general');

  // 移动端的下载页：统计改两列、新建下载上下排，分段条仍保留
  await js("renderSettingsSection('downloads')");
  await shot('12-mobile-set-downloads');

  // 移动端的嗅探页：统计降两列、地址换行
  await js("renderSettingsSection('sniffer')");
  await shot('13-mobile-set-sniffer');

  // 移动端的阅读增强分区
  await js("renderSettingsSection('mobile')");
  await shot('14-mobile-set-mobile');

  // 移动端的拦截页
  await js("renderSettingsSection('adblock')");
  await shot('15-mobile-set-adblock');

  // 底栏「阅读」弹出的底部弹层：无图三档 + 拼页开关 + 拦截计数都在这一屏里。
  // 临时放开 max-height 只是为了「一屏拍全」：弹层实际是 82vh 可滚的，
  // 不放开的话截图只会拍到 82vh 以内的部分，下半截的拼页设置就看不到。
  // 滚动行为本身由 test-mobile-ui 断言，这里纯属给评审看的取景处理。
  // 放在深色那一步之前 —— 深色只留 17 一张，其余全是浅色，便于横向比对。
  await js('closeSettings(); openReadSheet(); '
    + "(function(){var c=document.querySelector('#read-sheet .sheet-card');c.style.maxHeight='none';c.style.overflow='visible';return 1;})()");
  await shot('16-mobile-read-sheet');
  await js('closeReadSheet()');

  // 深色主题 + 移动端
  await js("openSettings('appearance'); state.settings.theme='dark'; document.documentElement.dataset.theme='dark'; renderSettingsSection('appearance');");
  await shot('17-mobile-dark-appearance');

  // 拍完深色就切回浅色，免得后面两张跟着一起变深
  await js("state.settings.theme='light'; document.documentElement.dataset.theme='light';");

  await js("closeSettings(); openTabGrid();");
  await shot('18-mobile-tabgrid');

  await js("closeTabGrid(); openSheet();");
  await shot('19-mobile-engine-sheet');

  console.log('DONE');
  server.close();
  app.exit(0);
}).catch((e) => { console.log('ERR ' + e.message); app.exit(1); });
