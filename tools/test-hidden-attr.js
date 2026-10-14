'use strict';

/**
 * hidden 属性回归 —— 真实 Chromium 下的权威探针
 * ---------------------------------------------------------------------------
 * 为什么需要单独一条：
 *   HTML 的 hidden 属性在 UA 样式表里只是一条普通声明（display:none），
 *   作者样式表里的任何 display 都会把它盖掉。像 .tab-grid / .sheet 这种
 *   「position:fixed + inset:0」的覆盖层，带 hidden 也照样铺满整个窗口。
 *   目标浏览器是 Chromium，所以这条必须在 Chromium 里验，jsdom 不算数 ——
 *   实测 jsdom 对 !important 的处理与规范不一致，结论会和真机相反。
 *
 * 用法：
 *   npm run check:hidden
 *   （即 electron --no-sandbox tools/test-hidden-attr.js；--no-sandbox 在本机
 *     沙箱环境下是必需的，否则 renderer 起不来，loadURL 直接 ERR_FAILED）
 *
 * 不在 browser 环境或拿不到 Electron 时给出指引并以 2 退出，不静默通过。
 */

const path = require('path');
const fs = require('fs');
const http = require('http');

const electron = (() => {
  try { return require('electron'); } catch { return null; }
})();

// 注意：在纯 Node 下 require('electron') 拿到的是 npm 包导出的「可执行文件路径字符串」，
// 只有在 Electron 主进程里才是真正的模块对象（app / BrowserWindow 挂在模块上）。
const usable = electron && typeof electron === 'object'
  && electron.app && typeof electron.app.whenReady === 'function';

if (!usable) {
  console.error(
    '\n这条探针必须在 Electron 里跑（它要的是真实 Chromium 的层叠结果）：\n' +
    '  npm run check:hidden\n'
  );
  if (process.env.ELECTRON_RUN_AS_NODE) {
    console.error(
      '检测到 ELECTRON_RUN_AS_NODE=' + process.env.ELECTRON_RUN_AS_NODE + '，\n' +
      '这会让 electron 退化成普通 Node，require("electron") 只拿到可执行文件路径。\n' +
      '先清掉再跑：env -u ELECTRON_RUN_AS_NODE npm run check:hidden\n'
    );
  }
  process.exit(2);
}

const { app, BrowserWindow } = electron;

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PROBE_PORT || 4399);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

/** 起一个只读的本地静态服务，避免 file:// 在沙箱里的 ERR_FAILED */
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const target = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      if (!target.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
      fs.readFile(target, (err, data) => {
        if (err) { res.writeHead(404).end('404'); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store'
        });
        res.end(data);
      });
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const server = await serve();
  const win = new BrowserWindow({ show: false, width: 1200, height: 820 });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  await win.loadURL(`http://127.0.0.1:${PORT}/src/renderer/shell.html`);
  // 等 init() 把内核下拉渲染出来，说明外壳脚本已完成启动
  for (let i = 0; i < 60; i++) {
    const ready = await js("document.querySelectorAll('#engine-menu-list .em-item').length > 0");
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const styles = (sels) => js(`(() => {
    const out = {};
    for (const s of ${JSON.stringify(sels)}) {
      const el = document.querySelector(s);
      out[s] = el ? { hidden: el.hidden, display: getComputedStyle(el).display } : null;
    }
    return out;
  })()`);

  console.log('\n[A] 带 hidden 的覆盖层在真实 Chromium 里必须真的不可见');
  const idle = await styles(['#tab-grid', '#engine-sheet', '#read-sheet', '#empty-state', '#settings-view', '#engine-notice', '#scrim', '#toast', '#engine-menu']);
  for (const sel of Object.keys(idle)) {
    const st = idle[sel];
    if (!st) { check(`${sel} 存在`, false, '元素不存在'); continue; }
    check(`${sel}（hidden=${st.hidden}）计算样式为 none`,
          st.display === 'none', 'display=' + st.display);
  }

  console.log('\n[B] 显式打开后必须真的可见（守卫没把功能一起干掉）');
  // 两个底部弹层是互斥的：openReadSheet() 内部会先 closeSheet()。
  // 所以必须先量完内核弹层再开阅读弹层 —— 一次性全开再量，量到的内核弹层
  // 是被后开的阅读弹层关掉的那个，会假红。
  const opened = await js(`(() => {
    openTabGrid();
    openSheet();
    const sheet = getComputedStyle(document.querySelector('#engine-sheet')).display;
    openReadSheet();
    const readSheet = getComputedStyle(document.querySelector('#read-sheet')).display;
    const sheetAfterRead = getComputedStyle(document.querySelector('#engine-sheet')).display;
    openPanel('adblock');
    return {
      grid: getComputedStyle(document.querySelector('#tab-grid')).display,
      sheet: sheet,
      readSheet: readSheet,
      sheetAfterRead: sheetAfterRead,
      settings: getComputedStyle(document.querySelector('#settings-view')).display,
      srcCards: document.querySelectorAll('.src-card').length,
      navItems: document.querySelectorAll('#settings-nav .sv-nav-item').length
    };
  })()`);
  check('#tab-grid 打开后 display=flex', opened.grid === 'flex', opened.grid);
  check('#engine-sheet 打开后 display=flex', opened.sheet === 'flex', opened.sheet);
  check('#read-sheet 打开后 display=flex', opened.readSheet === 'flex', opened.readSheet);
  check('★ 开阅读弹层会顺手关掉内核弹层（两个底部弹层不共存）',
        opened.sheetAfterRead === 'none', opened.sheetAfterRead);
  check('#settings-view 打开后 display=flex', opened.settings === 'flex', opened.settings);
  check('设置页确实渲染出 3 张拦截源卡片', opened.srcCards === 3, '实际 ' + opened.srcCards);
  // 11 而不是 12：「移动端」那一分区只在窄屏档位下才列出来，宽屏下它管的
  // 两项（无图模式、自动拼页）根本不生效。见 shell.js 的 settingsNavGroups()。
  check('左导航渲染出 11 个分区', opened.navItems === 11, '实际 ' + opened.navItems);

  console.log('\n[C] 关闭后必须回到不可见');
  const closed = await js(`(() => {
    closeTabGrid(); closeSheet(); closeReadSheet(); closeSettings();
    return {
      grid: getComputedStyle(document.querySelector('#tab-grid')).display,
      sheet: getComputedStyle(document.querySelector('#engine-sheet')).display,
      readSheet: getComputedStyle(document.querySelector('#read-sheet')).display,
      settings: getComputedStyle(document.querySelector('#settings-view')).display
    };
  })()`);
  check('#tab-grid 关闭后回到 none', closed.grid === 'none', 'display=' + closed.grid);
  check('#engine-sheet 关闭后回到 none', closed.sheet === 'none', 'display=' + closed.sheet);
  check('#read-sheet 关闭后回到 none', closed.readSheet === 'none', 'display=' + closed.readSheet);
  check('#settings-view 关闭后回到 none', closed.settings === 'none', 'display=' + closed.settings);

  console.log('\n[D] 拦截条与 Toast（走 UA 兜底，无作者 display 规则）');
  const bare = await styles(['#scrim', '#toast']);
  check('#scrim display=none', bare['#scrim'] && bare['#scrim'].display === 'none');
  check('#toast display=none', bare['#toast'] && bare['#toast'].display === 'none');

  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  server.close();
  app.exit(fail ? 1 : 0);
}).catch((err) => {
  console.error('探针异常：' + err.message);
  app.exit(1);
});
