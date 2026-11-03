'use strict';
/**
 * 语言与地区 · 真机验证（Electron）
 * ---------------------------------------------------------------------------
 * 验的是「网页按地区用当地语言」这条链路真的通：
 *
 *   ① 引擎的 applyHeaders 把 Accept-Language 写进真实请求（不是只改了配置）
 *   ② 切换语言后**下一次请求就是新语言**（不用重启）—— 靠的是每个请求现读，
 *      而不是启动时定死
 *   ③ 顺带回归：UA 伪装与 Client Hints 没被这次改动挤掉
 *
 * 跑法：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
 *     --use-angle=swiftshader --use-gl=angle --disable-gpu-sandbox --no-sandbox \
 *     tools/test-locale-e2e.js
 */

const { app, BrowserWindow, session } = require('electron');
const http = require('http');
const path = require('path');

app.disableHardwareAcceleration();

const locale = require('../src/main/locale.js');
const { EngineRegistry } = require('../src/main/engines.js');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 45000);

const PART = 'persist:nova-locale-test';

app.whenReady().then(async () => {
  // 回显请求头的本地服务：拿到什么原样吐回，测试只认它
  let last = {};
  const server = http.createServer((req, res) => {
    last = {
      al: req.headers['accept-language'] || '',
      ua: req.headers['user-agent'] || '',
      chua: req.headers['sec-ch-ua'] || '',
      chplatform: req.headers['sec-ch-ua-platform'] || ''
    };
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><meta charset="utf-8"><body>ok</body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/echo`;

  const ses = session.fromPartition(PART);
  const registry = new EngineRegistry();
  await registry.resolveAll();
  const chromium = registry.get('chromium');
  chromium.applyHeaders(ses);

  const win = new BrowserWindow({
    width: 500, height: 400, show: false,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true }
  });

  // ---- ① 简体中文
  locale.setActive('zh-CN');
  await win.loadURL(url);
  check('zh-CN：Accept-Language 已写入请求',
    last.al === 'zh-CN,zh;q=0.9,en;q=0.8', JSON.stringify(last.al));

  // ---- ③ 顺带回归：UA 与 Client Hints
  check('UA 伪装仍在（含 NovaBrowser 标识）',
    /Chrome\/\d+/.test(last.ua) && /NovaBrowser\//.test(last.ua), last.ua);
  check('Sec-CH-UA 仍在', /Chromium/.test(last.chua), last.chua);
  check('Sec-CH-UA-Platform 仍在', /Windows/.test(last.chplatform), last.chplatform);

  // ---- ② 运行中切换：下一次请求就该变，不用重启
  locale.setActive('en-US');
  await win.loadURL(url);
  check('en-US：切换后立刻生效（无需重启）',
    last.al === 'en-US,en;q=0.9,zh;q=0.6', JSON.stringify(last.al));

  locale.setActive('zh-TW');
  await win.loadURL(url);
  check('zh-TW：繁体走 zh-TW 串',
    last.al === 'zh-TW,zh;q=0.9,en;q=0.8', JSON.stringify(last.al));

  // ---- 系统脏值也要落到正确的串上
  locale.setActive('en_GB');
  await win.loadURL(url);
  check('系统值 en_GB 被归一到 en-US 串',
    last.al === 'en-US,en;q=0.9,zh;q=0.6', JSON.stringify(last.al));

  await sleep(100);
  server.close();
  console.log(`\n结论：${pass} 通过 / ${fail} 失败`);
  setTimeout(() => app.quit(), 200);
}).catch((err) => {
  console.error('测试异常:', err && err.message);
  process.exit(1);
});
