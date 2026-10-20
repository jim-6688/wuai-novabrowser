'use strict';

/**
 * 打印预览的真实 Chromium 探针
 * ---------------------------------------------------------------------------
 * 为什么需要单独一条：打印预览这条路有两个假设，jsdom 一个都验不了 ——
 *
 *   1) printToPDF 的**单位**。pageSize 与 margins 在 printToPDF 里都是英寸，
 *      而在 webContents.print() 里前者是微米、后者是 96dpi 像素。单位搞错不会
 *      报错，只会默默印出一张比例不对的纸 —— 所以必须真渲一次、数页数。
 *   2) **<webview plugins> 能显示 PDF**。Electron 自带的 PDF 阅读器是个插件，
 *      少了 plugins 属性，Chromium 会把 PDF 当成下载而不是渲染出来，
 *      预览区就永远是一块白板。
 *
 * 用法：
 *   npm run check:print
 *   （即 electron tools/test-print-electron.js；沙箱环境要 --no-sandbox）
 *
 * 不在 Electron 里跑就退出码 2 并给出指引，不静默通过。
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
  console.error(
    '\n这条探针必须在 Electron 里跑（它要的是真实 Chromium 的排版结果）：\n' +
    '  npm run check:print\n'
  );
  if (process.env.ELECTRON_RUN_AS_NODE) {
    console.error(
      '检测到 ELECTRON_RUN_AS_NODE=' + process.env.ELECTRON_RUN_AS_NODE + '，\n' +
      '这会让 electron 退化成普通 Node。先清掉再跑：env -u ELECTRON_RUN_AS_NODE npm run check:print\n'
    );
  }
  process.exit(2);
}

const { app, BrowserWindow } = electron;

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

/** 毫米 → 英寸，与主进程同一套换算 */
const mmToInch = (mm) => mm / 25.4;
const A4 = [210, 297];
const A5 = [148, 210];
const A3 = [297, 420];

/** 数 PDF 里的页对象。Skia 出的 PDF 不解压缩对象字典，直接数 /Type /Page 就够 */
const pageCount = (buf) => {
  const s = buf.toString('latin1');
  const m = s.match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 0;
};

/** 内容正好一页 A4 高（297mm）的测试页，用来验纸张尺寸真的生效。
 *  刻意**不写** `@page { margin: 0 }`：CSS 的 @page 边距会盖掉 printToPDF 的
 *  margins 参数，写了就验不出「自定义边距有没有传进去」。 */
const TEST_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; padding:0 }
  #sheet { width: 180mm; height: 297mm; background: linear-gradient(#eef,#fee) }
</style></head><body><div id="sheet"></div></body></html>`;

const pdfOpts = (o) => ({
  printBackground: true,
  landscape: !!o.landscape,
  scale: (o.scale || 100) / 100,
  pageSize: o.pageSize,
  margins: o.margins
});

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-print-probe-'));
  const htmlFile = path.join(tmp, 'probe.html');
  fs.writeFileSync(htmlFile, TEST_HTML);

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 900,
    webPreferences: { webviewTag: true, sandbox: false, contextIsolation: false, nodeIntegration: false }
  });
  await win.loadFile(htmlFile);

  console.log('\n[1] printToPDF 的单位与纸张');

  const zero = { top: 0, bottom: 0, left: 0, right: 0 };
  const inch = (mm) => mmToInch(mm);

  const pdfA4 = await win.webContents.printToPDF(pdfOpts({
    pageSize: { width: inch(A4[0]), height: inch(A4[1]) }, margins: zero
  }));
  check('A4 出得来一份 PDF', pdfA4.length > 1000 && pdfA4.slice(0, 5).toString() === '%PDF-',
    `${pdfA4.length} 字节`);
  const nA4 = pageCount(pdfA4);
  check('A4 数得出页数', nA4 > 0, String(nA4));
  check('A4 上「一页高」的内容就是一页（毫米换算没错）', nA4 === 1, `${nA4} 页`);

  // 同一份内容换 A5：A5 只有 210mm 高，297mm 的内容至少要两页。
  // 这一步是整条探针的关键 —— 单位写错（比如把毫米当英寸）时页数不会变。
  const pdfA5 = await win.webContents.printToPDF(pdfOpts({
    pageSize: { width: inch(A5[0]), height: inch(A5[1]) }, margins: zero
  }));
  const nA5 = pageCount(pdfA5);
  check('换成 A5 后页数变多（纸张尺寸真的传到了排版）', nA5 > nA4, `A4 ${nA4} 页 → A5 ${nA5} 页`);

  // 具名纸张走字符串，自定义走 {width,height}，两条路都得通
  const pdfNamed = await win.webContents.printToPDF(pdfOpts({ pageSize: 'A4', margins: zero }));
  check('具名纸张（字符串 "A4"）也能用', pageCount(pdfNamed) === 1, `${pageCount(pdfNamed)} 页`);

  const pdfLand = await win.webContents.printToPDF(pdfOpts({
    pageSize: { width: inch(A3[0]), height: inch(A3[1]) }, landscape: true, margins: zero
  }));
  check('横向 + A3 能出 PDF', pageCount(pdfLand) >= 1, `${pageCount(pdfLand)} 页`);

  // 边距：同样的内容，加上 30mm 边距后可用高度少了 60mm，页数只会变多不会变少
  const pdfMargin = await win.webContents.printToPDF(pdfOpts({
    pageSize: { width: inch(A4[0]), height: inch(A4[1]) },
    margins: { top: inch(30), bottom: inch(30), left: inch(30), right: inch(30) }
  }));
  const nMargin = pageCount(pdfMargin);
  check('自定义边距生效（边距吃掉可用高度）', nMargin > nA4, `${nA4} 页 → ${nMargin} 页`);

  // 页码范围：只要第 1 页。
  // 注意这里是**字符串**（"1"），不是 print() 要的 [{from:0,to:0}] —— 传错类型
  // Electron 会直接抛 `pageRanges must be a string`，这也是 main.js 里
  // buildPdfOptions 单独处理这一项的原因。
  const pdfRange = await win.webContents.printToPDF(Object.assign(
    pdfOpts({ pageSize: { width: inch(A5[0]), height: inch(A5[1]) }, margins: zero }),
    { pageRanges: '1' }
  ));
  check('页码范围能只导第 1 页', pageCount(pdfRange) === 1, `${pageCount(pdfRange)} 页`);

  console.log('\n[2] <webview plugins> 显示 PDF');

  const pdfFile = path.join(tmp, 'preview.pdf');
  fs.writeFileSync(pdfFile, pdfA4);
  const pdfUrl = pathToFileURL(pdfFile).href;

  const hostFile = path.join(tmp, 'host.html');
  fs.writeFileSync(hostFile, `<!doctype html><html><body style="margin:0">
    <webview id="pv" src="${pdfUrl}" plugins style="width:600px;height:800px;display:inline-flex"></webview>
  </body></html>`);

  const w2 = new BrowserWindow({ show: false, width: 700, height: 900, webPreferences: { webviewTag: true } });

  const guestLoaded = new Promise((resolve) => {
    let settled = false;
    const done = (ok, why) => { if (!settled) { settled = true; resolve({ ok, why }); } };
    w2.webContents.on('did-attach-webview', (_e, guest) => {
      guest.on('did-finish-load', () => done(true, guest.getURL()));
      guest.on('did-fail-load', (_ev, code, desc) => done(false, `${code} ${desc}`));
    });
    setTimeout(() => done(false, '超时（10s 没有加载完成）'), 10000);
  });

  await w2.loadFile(hostFile);
  const r = await guestLoaded;
  check('PDF 在 <webview plugins> 里加载完成', r.ok, String(r.why));
  check('加载的就是那个 PDF 地址', r.ok && String(r.why).indexOf('.pdf') >= 0, String(r.why));

  win.destroy();
  w2.destroy();

  console.log(`\n结果：${pass}/${pass + fail} 通过`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录，删不掉无妨 */ }
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
