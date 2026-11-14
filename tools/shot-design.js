'use strict';

/**
 * 把设计稿 design/*.html 渲染成 PNG，用于和真实 UI 截图逐屏比对。
 *
 * 用法（Git Bash 下必须清掉 ELECTRON_RUN_AS_NODE，否则 electron 退化成纯 Node）：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
 *     --use-angle=swiftshader --use-gl=angle --disable-gpu-sandbox --no-sandbox \
 *     tools/shot-design.js [design-board|mobile-spring]
 *
 * 产出：系统临时目录 nova-design-shots/*.png（刻意不写进仓库，避免污染 screenshots/）
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'nova-design-shots');

if (!app || typeof app.whenReady !== 'function') {
  console.error('需要在 Electron 里跑');
  process.exit(2);
}

app.disableHardwareAcceleration();

const TARGETS = {
  'design-board': { file: 'design/design-board.html', width: 1440, height: 900 },
  'mobile-spring': { file: 'design/mobile-spring.html', width: 900, height: 1000 },
  'mobile-spring-demo': { file: 'design/mobile-spring-demo.html', width: 900, height: 1000 }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture(win, name, y, fullHeight) {
  await win.webContents.executeJavaScript(`window.scrollTo(0, ${y}); void 0;`);
  await sleep(320);
  const img = await win.webContents.capturePage();
  const p = path.join(OUT, name + '.png');
  fs.writeFileSync(p, img.toPNG());
  console.log('saved', p, img.getSize());
  return p;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // electron 的 --flag 也会进 argv，所以按白名单挑，而不是取 argv[2]
  const key = process.argv.slice(1).find((a) => TARGETS[a]) || 'design-board';
  const t = TARGETS[key];
  if (!t) {
    console.error('未知目标:', key, '可选:', Object.keys(TARGETS).join(', '));
    app.exit(2);
    return;
  }

  const win = new BrowserWindow({
    width: t.width,
    height: t.height,
    show: true,
    backgroundColor: '#ffffff',
    webPreferences: { offscreen: false }
  });

  const url = 'file:///' + path.join(ROOT, t.file).replace(/\\/g, '/');
  await win.loadURL(url);
  await sleep(900);

  const full = await win.webContents.executeJavaScript(
    'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)'
  );
  console.log('页面总高:', full, '视口:', t.height);

  // 逐屏截图，最多 12 屏
  let i = 0;
  for (let y = 0; y < full && i < 12; y += t.height - 80) {
    await capture(win, `${key}-${String(i).padStart(2, '0')}`, y, full);
    i += 1;
  }
  console.log('总屏数:', i);
  app.exit(0);
});
