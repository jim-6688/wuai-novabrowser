'use strict';

/**
 * 媒体嗅探 · 真实 Electron 端到端验证
 * 用法：npm run check:sniffer
 *
 * 为什么非得真机：嗅探挂在 webRequest.onHeadersReceived 上，这是 Electron 独有的能力，
 * jsdom 里根本没有。这一层要证明的是三件在别处证不了的事：
 *
 *   1. 真实响应头能被正确读到 —— 包括键大小写、数组形式的值；
 *   2. 回调确实被调用了 —— 漏调一次，那个请求就会永久挂起（用「页面所有 fetch 都返回了」来证）；
 *   3. 206 的 Content-Range 被正确用来取全长，而不是把分段长度当文件大小。
 *
 * 判定逻辑本身（上百种格式组合）由 tools/test-sniffer.js 在纯 Node 下覆盖。
 */

const http = require('http');

const electron = (() => { try { return require('electron'); } catch { return null; } })();
const usable = electron && typeof electron === 'object'
  && electron.app && typeof electron.app.whenReady === 'function';
if (!usable) {
  console.error('\n这个脚本必须在 Electron 里跑：npm run check:sniffer');
  if (process.env.ELECTRON_RUN_AS_NODE) {
    console.error('（检测到 ELECTRON_RUN_AS_NODE=1，需要先 env -u ELECTRON_RUN_AS_NODE）');
  }
  process.exit(2);
}
const { app, session, BrowserWindow } = electron;

const { Sniffer } = require('../src/main/sniffer');
const { wireSniffer, sniffResponse, pickHeader, toInt } = require('../src/main/sniffer-wire');

app.disableHardwareAcceleration();

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 测试服务器
 * ------------------------------------------------------------------ */

const buf = (n, seed) => {
  const b = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + (seed || 0)) & 255;
  return b;
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>loading</title></head><body>
<script>
const targets = [
  '/video.mp4', '/audio.mp3', '/index.m3u8', '/seg-1.ts',
  '/api/media', '/audio-stream', '/partially.bin',
  '/logo.png', '/fake.mp4', '/noext-css'
];
(async () => {
  for (const u of targets) { try { await fetch(u); } catch (e) { /* 记下来也没用，交给断言 */ } }
  document.title = 'ALL_FETCHED';
})();
</script></body></html>`;

const requested = {};

function makeServer() {
  return http.createServer((req, res) => {
    const p = new URL(req.url, 'http://127.0.0.1').pathname;
    requested[p] = (requested[p] || 0) + 1;
    const send = (code, headers, body) => {
      res.writeHead(code, headers);
      res.end(body);
    };

    if (p === '/' || p === '/page.html') {
      return send(200, { 'Content-Type': 'text/html; charset=utf-8' }, Buffer.from(PAGE, 'utf8'));
    }

    /* 206 部分响应：Content-Length 只是这一段，全长在 Content-Range 里。
       分片下载时每片都长这样，照 content-length 收会把体积报小几十倍。 */
    if (p === '/partially.bin') {
      return send(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': 1024,
        'Content-Range': 'bytes 0-1023/5242880',
        'Accept-Ranges': 'bytes'
      }, buf(1024, 3));
    }

    const table = {
      '/video.mp4': { type: 'video/mp4', size: 2048 },
      '/audio.mp3': { type: 'audio/mpeg', size: 1024 },
      '/index.m3u8': { type: 'application/vnd.apple.mpegurl', size: 512 },
      '/seg-1.ts': { type: 'video/mp2t', size: 320 * 1024 },
      /* 无扩展名的地址 —— 只信扩展名的嗅探器会漏掉这类 */
      '/api/media': { type: 'video/mp4', size: 4096 },
      '/audio-stream': { type: 'audio/mpeg', size: 3072 },
      /* 以下三条都**不该**被收 */
      '/logo.png': { type: 'image/png', size: 800 },
      '/fake.mp4': { type: 'text/html', size: 700 },   // 路径像视频，其实返回 HTML
      '/noext-css': { type: 'text/css', size: 300 }
    };
    const hit = table[p];
    if (!hit) return send(404, { 'Content-Type': 'text/plain' }, Buffer.from('nope'));
    return send(200, { 'Content-Type': hit.type, 'Content-Length': hit.size }, buf(hit.size, p.length));
  });
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  /* ---------------- [A] 纯函数层：用假 details 覆盖边界 ---------------- */

  console.log('\n[A] 响应头解析');

  check('pickHeader 大小写不敏感',
    pickHeader({ 'Content-Type': ['video/mp4'] }, 'content-type') === 'video/mp4');
  check('pickHeader 兼容小写键',
    pickHeader({ 'content-type': 'audio/mpeg' }, 'Content-Type') === 'audio/mpeg');
  check('pickHeader 取数组首元素',
    pickHeader({ 'Content-Length': ['123', '456'] }, 'content-length') === '123');
  check('pickHeader 缺失返回空串', pickHeader({}, 'x-nope') === '');
  check('toInt 正常解析', toInt('4096') === 4096);
  check('toInt 非法值返回 -1', toInt(undefined) === -1 && toInt('abc') === -1);

  const mkDetails = (over) => Object.assign({
    method: 'GET', webContentsId: 5, statusCode: 200,
    url: 'https://a.com/v.mp4',
    responseHeaders: { 'Content-Type': ['video/mp4'], 'Content-Length': ['1234'] }
  }, over);

  const s0 = new Sniffer({ enabled: true });
  s0.setPage(5, 'https://a.com/', '');

  check('正常媒体被收下', !!sniffResponse(mkDetails(), s0));
  check('POST 请求不收', sniffResponse(mkDetails({ method: 'POST' }), s0) === null);
  check('302 跳转不收', sniffResponse(mkDetails({ statusCode: 302 }), s0) === null);
  check('304 不收', sniffResponse(mkDetails({ statusCode: 304 }), s0) === null);
  check('webContentsId = -1（主进程侧）不收', sniffResponse(mkDetails({ webContentsId: -1 }), s0) === null);
  check('isInternal 判定为浏览器自身请求时不收',
    sniffResponse(mkDetails({ url: 'https://a.com/other.mp4' }), s0, () => true) === null);
  check('isInternal 放行时正常收下',
    sniffResponse(mkDetails({ url: 'https://a.com/other2.mp4' }), s0, () => false) !== null);

  const sRange = new Sniffer({ enabled: true });
  sRange.setPage(5, 'https://a.com/', '');
  sniffResponse(mkDetails({
    url: 'https://a.com/part.bin',
    responseHeaders: {
      'Content-Type': ['video/mp4'],
      'Content-Length': ['1024'],
      'Content-Range': ['bytes 0-1023/5242880']
    }
  }), sRange);
  check('★ 206 用 Content-Range 取全长而非分段长度',
    sRange.list()[0] && sRange.list()[0].size === 5242880,
    sRange.list()[0] ? String(sRange.list()[0].size) : '无记录');

  const sHtml = new Sniffer({ enabled: true });
  sHtml.setPage(5, 'https://a.com/', '');
  check('★ text/html 即使路径是 .mp4 也不收',
    sniffResponse(mkDetails({ url: 'https://a.com/watch.mp4', responseHeaders: { 'Content-Type': ['text/html'] } }), sHtml) === null);

  const sOff = new Sniffer({ enabled: false });
  check('总开关关闭时一律不收', sniffResponse(mkDetails(), sOff) === null);

  /* ---------------- [B] 真实端到端 ---------------- */

  console.log('\n[B] 真实浏览器请求（端到端）');

  const PART = 'persist:nova-sniff-test';
  const ses = session.fromPartition(PART);
  await ses.clearStorageData();

  const sniffer = new Sniffer({ enabled: true });
  const collected = [];
  wireSniffer(ses, {
    sniffer,
    onRecord: (rec) => collected.push(rec),
    isInternal: () => false
  });

  const srv = makeServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const win = new BrowserWindow({
    show: false, width: 640, height: 480,
    webPreferences: { partition: PART, contextIsolation: true, nodeIntegration: false }
  });

  // 页面把「媒体」请求发出去，标题变了说明所有 fetch 都回来了
  await win.loadURL(base + '/page.html').catch(() => {});
  let done = false;
  for (let i = 0; i < 100 && !done; i++) {
    await sleep(50);
    try { done = win.webContents.getTitle() === 'ALL_FETCHED'; } catch { /* 窗口没了 */ }
  }
  await sleep(400); // 让 onHeadersReceived 与批处理都落定

  const list = sniffer.list({});
  const byPath = new Map(list.map((r) => [new URL(r.url).pathname, r]));
  const tabId = win.webContents.id;

  check('★ 页面里所有 fetch 都返回了（证明 onHeadersReceived 回调没漏调）', done,
    done ? '' : '页面里的请求没能全部完成 —— 很可能回调没被调用，请求被挂起');
  check('嗅探确实收到了记录', list.length > 0, `共 ${list.length} 条`);
  check('记录归属到正确的 webContents', list.every((r) => r.tabId === tabId), `tabId=${tabId}`);

  check('嗅到 video/mp4', !!byPath.get('/video.mp4') && byPath.get('/video.mp4').kind === 'video');
  check('嗅到 audio/mpeg → MP3', !!byPath.get('/audio.mp3') && byPath.get('/audio.mp3').container === 'MP3');
  check('嗅到 HLS 清单', !!byPath.get('/index.m3u8') && byPath.get('/index.m3u8').kind === 'stream');
  check('HLS 清单被标为不可直接下载',
    byPath.get('/index.m3u8') && byPath.get('/index.m3u8').downloadable === false);
  check('嗅到 .ts 分片', !!byPath.get('/seg-1.ts'));
  check('★ .ts 小文件被标记为分片', byPath.get('/seg-1.ts') && byPath.get('/seg-1.ts').isSegment === true);
  check('★ 无扩展名的 /api/media 靠响应类型被救回',
    !!byPath.get('/api/media') && byPath.get('/api/media').kind === 'video');
  check('★ 无扩展名的 /audio-stream 也被救回',
    !!byPath.get('/audio-stream') && byPath.get('/audio-stream').container === 'MP3');

  /* ---------------- [C] 防误报 ---------------- */

  console.log('\n[C] 防误报（真机）');

  check('★ 路径是 .mp4 但返回 text/html —— 没被收', !byPath.get('/fake.mp4'));
  check('服务器确实收到过 /fake.mp4 请求（不是没发出去）', (requested['/fake.mp4'] || 0) > 0,
    `请求 ${requested['/fake.mp4'] || 0} 次`);
  check('image/png 没被收', !byPath.get('/logo.png'));
  check('服务器确实收到过 /logo.png 请求', (requested['/logo.png'] || 0) > 0);
  check('text/css 没被收', !byPath.get('/noext-css'));
  check('页面 HTML 本身没被当成媒体', !byPath.get('/page.html') && !byPath.get('/'));

  /* ---------------- [D] 体积 ---------------- */

  console.log('\n[D] 体积解析（真机）');

  const part = byPath.get('/partially.bin');
  check('206 响应被收下', !!part);
  check('★ 体积取的是全长 5242880，不是分段长度 1024',
    part && part.size === 5242880, part ? String(part.size) : '无记录');
  check('普通响应的体积正确（2048）',
    byPath.get('/video.mp4') && byPath.get('/video.mp4').size === 2048,
    byPath.get('/video.mp4') ? String(byPath.get('/video.mp4').size) : '');

  /* ---------------- [E] 统计与格式表 ---------------- */

  console.log('\n[E] 统计');

  const st = sniffer.stats();
  check('视频类计数正确（video.mp4 / api/media / partially.bin / seg-1.ts）', st.byKind.video === 4,
    JSON.stringify(st.byKind));
  check('音频类计数正确（audio.mp3 / audio-stream）', st.byKind.audio === 2);
  check('流媒体计数 = 1', st.byKind.stream === 1);
  check('分片计数 = 1', st.segments === 1, String(st.segments));
  check('被排除的响应有计数（至少有 png / css / html 三条）', st.filtered >= 3, `filtered=${st.filtered}`);

  /* ---------------- 收尾 ---------------- */

  await ses.clearStorageData();
  win.destroy();
  srv.close();

  console.log(fail ? `\n嗅探真机验证：${pass} 通过 / ${fail} 失败\n` : `\n嗅探真机验证：${pass} 项全部通过\n`);
  app.exit(fail ? 1 : 0);
}).catch((err) => {
  console.error('真机验证崩了：', err);
  app.exit(2);
});
