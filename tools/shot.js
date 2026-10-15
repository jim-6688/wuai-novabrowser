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
 *
 * ── Windows + 沙箱环境下怎么才能真跑起来（踩过的坑，别再改回去）──
 *   直接 `electron tools/shot.js` 会失败，两个原因叠在一起：
 *
 *   1) **`ELECTRON_RUN_AS_NODE=1` 会污染子进程**。Electron 自身基于 Electron 跑
 *      （WorkBuddy 就是），这个变量会漏给所有子进程；一旦它在，electron.exe
 *      退化成纯 Node，`app.whenReady` 不存在，脚本第一行的检查直接退出，
 *      打印「需要在 Electron 里跑」。**跑之前先清掉它。**
 *   2) **缺 GL 上下文**。报错是 `Failed to create GLES3 context` →
 *      `kFatalFailure`，跟着就是 `ERR_FAILED (-2) loading .../shell.html` ——
 *      看着像页面或本地服务有问题，其实是 GPU 进程崩了（exit_code=-1073741819
 *      即 0xC0000005 访问违例），渲染器拿不到页面。**加纯软件渲染参数**：
 *        --use-angle=swiftshader --use-gl=angle --disable-gpu-sandbox --no-sandbox
 *      加了就能拍出全部截图（EXIT=0）。
 *
 *   另：Windows 上 `./node_modules/.bin/electron` 这个 shim 会把
 *   `--no-sandbox` 之类的参数报成 `bad option`（参数被当成脚本参数传了）。
 *   稳妥做法是直接调 `node_modules\electron\dist\electron.exe`。
 *
 *   排查顺序：先看有没有 `GPU process exited unexpectedly` / `Failed to create
 *   GLES3 context`，有就是第 2 条；再看打印的是不是「需要在 Electron 里跑」，
 *   是就是第 1 条。两者可同时存在。
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

  // 扩展面板（回桌面宽度拍）。
  // 只拍初始态的话，「粘了地址之后长什么样、能不能装」这一半信息看不到 ——
  // 而那一半正是这一块存在的理由，所以顺手把查询也跑一遍。
  // 预览桥返回的是照真商店形状写的一份假详情（见 bridge-mock），
  // 网络一个请求都不发，写死的字段不会随时间漂。
  win.setContentSize(1280, 820);
  await new Promise((r) => setTimeout(r, 300));
  // 19 拍的是内核弹层，它还开着 —— 不关的话正好把扩展面板下半截盖住
  await js("state.settings.layout='desktop'; applyLayout(); closeSheet(); openSettings('extensions');");
  await js("(function(){var i=document.querySelector('#store-input');"
    + "i.value='https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd';"
    + 'state.extStore.draft=i.value;return 1})()');
  await js('runStoreQuery()');
  await shot('20-set-extensions');

  /* ============ PC 版产品形态（官网「电脑版界面」那一节用） ============
   * 上面 01–20 是设置页与弹层，属于「功能都在哪」；这一段拍的是「用了长什么样」。
   * 两者不是一回事：官网原有的界面宣传图全是纯 CSS 画的安卓手机 mockup，
   * 读者看不到电脑端真正的样子，而 PC 版现在才是功能最全的一端。
   *
   * 都用真实渲染而非画出来的图 —— 画的图与实现各走各的，改了代码图不会跟着变，
   * 官网就会开始说谎（与 newtab.html 不引外部图片是同一条理由）。
   */
  await js("closeSettings(); state.settings.layout='desktop'; applyLayout();");

  // 21 AI 侧边窗口：这一轮的招牌。面板开着、下拉选了 AI、输入框里带了内容 ——
  // 空着拍等于没拍到「右侧下拉选 AI」这个动作。
  // 先摘掉 webview 的 src：它要真去连 deepseek.com，沙箱里必然加载失败，
  // 失败时 Chromium 会显示自己的错误页，把整个面板内容盖掉。
  await js("(function(){var w=document.querySelector('#ai-webview');"
    + "if(w){w.removeAttribute('src');}"
    + "openAiPanel();"
    + "var sel=document.querySelector('#ai-select');"
    + "if(sel){sel.value='deepseek';sel.dispatchEvent(new Event('change'));}"
    + "var ta=document.querySelector('#ai-text');"
    + "if(ta){ta.value='总结这篇讲了什么，并列出三个要点';}"
    + "return 1})()");
  await shot('21-pc-ai-panel');
  await js('closeAiPanel();');

  // 22 下载浮窗：地址栏旁那一格，角标 + 进度条 + 动作按钮都在这一屏里。
  // 直接喂两条状态进 state.downloads 再重画 —— 预览桥不联网，真下载跑不起来，
  // 而要拍的只是「这一屏长什么样」，不需要真的下东西。
  //
  // **progress 是 0~1 的小数，不是百分数**（dlTaskRow 里是 Math.round(t.progress*100)）。
  // 第一版喂了 62 拍出来进度条空着 —— 就是这个错。
  // 文件名字段是全小写 `filename`（写成 fileName 会静默回落到主机名，
  // 拍出来标题是「gitee.com」而不是「nova-1.6.0.apk」，第一版又踩了一次）。
  await js("(function(){state.downloads=["
    + "{id:'d1',state:'downloading',progress:0.62,received:7549747,total:12163408,"
    + "speed:1258291,eta:38,ranged:true,threads:8,"
    + "filename:'nova-1.6.0.apk',savePath:'C:/Users/jim/Downloads',"
    + "url:'https://gitee.com/jinghe-net/i-adore-the-nova-browser/releases/download/v1.6.0/nova-1.6.0.apk'},"
    + "{id:'d2',state:'done',progress:1,received:2097152,total:2097152,"
    + "speed:0,eta:0,ranged:true,threads:4,"
    + "filename:'quantum-notes.pdf',savePath:'C:/Users/jim/Downloads',"
    + "url:'https://example.test/quantum-notes.pdf'}"
    + "];renderDownloadPill();refreshDownloadPopover(true);"
    + "document.querySelector('#dl-popover').hidden=false;state.dlAutoOpen=false;return 1})()");
  await shot('22-pc-download-popover');
  await js("(function(){document.querySelector('#dl-popover').hidden=true;"
    + "state.downloads=[];renderDownloadPill();return 1})()");

  // 23 内置新标签页：logo 主视觉 + 固定宫格 + 插件商店入口（PC 宿主挂的 store=1）。
  //
  // **不复用外壳那个窗口，另开一个直接拍 newtab.html。** 原因：
  // 这一页是自包含的静态页（不引外部文件、CSP 锁死网络），本身就能独立渲染；
  // 而外壳那个窗口跑在 UI 预览模式下（bridge-mock 的 isPreview:true，
  // 截图里那句「UI 预览模式」就是它），根本不会创建真实 <webview> ——
  // 在里面导航多少次，内容区都是那张占位图，拍到的永远不是新标签页。
  //
  // store=1 模拟 PC 宿主会挂的那个参数（插件商店入口靠它显隐），
  // data 手工喂几条候选，好让宫格里有内容可拍。
  {
    const rows = [
      ['主页', 'https://www.52ta.top/'],
      ['导航', 'https://52ta.top/'],
      ['播放器', 'https://music.52ta.top/'],
      ['浏览器', 'https://nova.52ta.top/'],
      ['百度', 'https://www.baidu.com/'],
      ['DeepSeek', 'https://chat.deepseek.com/'],
      ['一个名字特别长的站点', 'https://very-long-hostname.example.com/']
    ].map((r, i) => `${r[0]}\t${r[1]}\t${9 - i}\t${i >= 6 ? '-' : 'f'}`).join('\n');
    const page = `${PORT}/src/renderer/newtab.html`
      + `?theme=light&store=1&data=${encodeURIComponent(rows)}`;

    const tab = new BrowserWindow({
      show: false, width: 520, height: 760, backgroundColor: '#F4F6FB',
      webPreferences: { offscreen: false }
    });
    await tab.loadURL(`http://127.0.0.1:${page}`);
    await new Promise((r) => setTimeout(r, 1200));
    const img = await tab.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, '23-pc-newtab.png'), img.toPNG());
    console.log('SHOT 23-pc-newtab');
    tab.destroy();
  }

  // 24 深色主题下的 AI 面板。
  // 原先拍的是「深色外壳」，但内容区是 UI 预览模式的占位图 —— 一大片空白，
  // 跟浅色那张除了颜色什么都没多，读者看了等于没看。改成拍 AI 面板：
  // 面板本身有内容（下拉、输入框、按钮），深浅两色才各有各要看的东西。
  await js("(function(){"
    + "state.settings.theme='dark';document.documentElement.dataset.theme='dark';"
    + "openAiPanel();"
    + "var sel=document.querySelector('#ai-select');"
    + "if(sel){sel.value='kimi';sel.dispatchEvent(new Event('change'));}"
    + "var ta=document.querySelector('#ai-text');"
    + "if(ta){ta.value='这段代码在什么情况下会失效？';}"
    + "return 1})()");
  await shot('24-pc-dark-ai');
  await js("closeAiPanel();state.settings.theme='light';"
    + "document.documentElement.dataset.theme='light';");

  console.log('DONE');
  server.close();
  app.exit(0);
}).catch((e) => { console.log('ERR ' + e.message); app.exit(1); });
