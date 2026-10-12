'use strict';

/**
 * 无图模式 · 真实 Electron 端到端验证
 * 用法：npm run check:mobile
 *
 * 为什么非得真机：这一段要证明的是「图片请求根本没发出去」——
 * webRequest 是 Electron 独有的能力，jsdom 里根本没有网络层，
 * 在那儿只能验判定函数返回了什么，验不了「服务端到底有没有收到这条请求」。
 *
 * 为此这里起了一个真实 HTTP 服务器，把每一个进来的请求都记下来，
 * 然后直接去数：该来的来了没有、不该来的有没有偷偷来。
 *
 * 判定逻辑由 tools/test-nomedia.js 在纯 Node 下覆盖，
 * 界面由 tools/test-mobile-ui.js 覆盖。
 */

const http = require('http');

const electron = (() => { try { return require('electron'); } catch { return null; } })();
const usable = electron && typeof electron === 'object'
  && electron.app && typeof electron.app.whenReady === 'function';
if (!usable) {
  console.error('\n这个脚本必须在 Electron 里跑：npm run check:mobile');
  if (process.env.ELECTRON_RUN_AS_NODE) {
    console.error('（检测到 ELECTRON_RUN_AS_NODE=1，需要先 env -u ELECTRON_RUN_AS_NODE）');
  }
  process.exit(2);
}
const { app, session, BrowserWindow } = electron;

const { NoMedia } = require('../src/main/nomedia');
const { wireRequestGate } = require('../src/main/request-gate');

app.disableHardwareAcceleration();

let pass = 0;
let fail = 0;
let skipped = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const skip = (name, why) => { skipped++; console.log('  SKIP  ' + name + '  ' + why); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 38931;
const ORIGIN = `http://127.0.0.1:${PORT}/`;

/* ------------------------------------------------------------------ *
 * 测试服务器：把每一个进来的请求都记下来
 * ------------------------------------------------------------------ */

/** 一张能真正解码的 1x1 PNG */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478'
  + '9c6360000002000100fdff03fd0000000049454e44ae426082', 'hex');

const ICO = Buffer.from('00000100010001010000010018003000000016000000', 'hex');

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>gate-test</title>
<link rel="icon" href="/favicon.ico">
</head><body>
<img id="i1" src="/img/a.png" width="16" height="16">
<img id="i2" src="/img/b.png" width="16" height="16">
<img id="i3" src="/img/c.png" width="16" height="16">
<!-- 放行名单的探针：.ico / favicon 路径应当被放行。
     不用 <link rel="icon"> 来验 —— 无头窗口里 Chromium 压根不会去取它，
     两档都取不到，那样这条断言等于什么都没测。
     用 <img> 引同一个地址，就必然会产生一条 image 类型的请求。 -->
<img id="ico" src="/favicon.ico" width="16" height="16">
<div id="css-bg" style="width:16px;height:16px;background-image:url(/img/bg.png)"></div>
<video id="v" src="/v.mp4" preload="auto"></video>
</body></html>`;

let requestLog = [];
let server = null;

function resetLog() { requestLog = []; }
const sawPath = (p) => requestLog.some((u) => u === p);
const countImgs = () => requestLog.filter((u) => /^\/img\//.test(u)).length;

function serve() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      requestLog.push(url);

      if (url === '/index.html' || url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      }
      if (url === '/favicon.ico') {
        res.writeHead(200, { 'Content-Type': 'image/x-icon' });
        res.end(ICO);
        return;
      }
      if (url === '/v.mp4') {
        // 给一段足够长的假数据，免得 Chromium 立刻判定流结束
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(4096) });
        res.end(Buffer.alloc(4096, 0x11));
        return;
      }
      if (/^\/img\//.test(url)) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) });
        res.end(PNG);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('nope');
    });
    server.listen(PORT, '127.0.0.1', resolve);
  });
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  await serve();

  const ses = session.fromPartition('persist:nova-gate-test');

  /* 广告拦截用桩：既能证明闸门的顺序，也能证明「被无图拦下的请求
     不会被记到广告拦截头上」——省流量不该冒充成拦截广告。 */
  const adblockStub = {
    seen: [],
    check(url) {
      this.seen.push(url);
      if (url.includes('blocked-by-rule')) return { raw: '||ad.example^' };
      return null;
    }
  };

  const noMedia = new NoMedia({ level: 'off' });
  let noMediaHits = 0;

  wireRequestGate(ses, {
    adblock: adblockStub,
    noMedia,
    onNoMediaHit: () => { noMediaHits += 1; }
  });

  const win = new BrowserWindow({ show: false, width: 700, height: 500, webPreferences: { session: ses } });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const load = async () => {
    resetLog();
    await win.loadURL(ORIGIN + 'index.html');
    await sleep(500);   // 留出子资源的时间
  };

  /* ---------------- */

  console.log('\n[A] 关档位时：一切照常');

  await load();
  check('页面本身请求到了', sawPath('/index.html'));
  check('三张图片都请求了', countImgs() >= 3, `实际 ${countImgs()} 条：${requestLog.filter((u) => /^\/img\//.test(u)).join(' ')}`);
  check('CSS 背景图也请求了', sawPath('/img/bg.png'));
  check('放行名单上的 .ico 请求了（有请求才谈得上「放行」）', sawPath('/favicon.ico'));
  check('关闭时一条都没拦', noMediaHits === 0, String(noMediaHits));
  check('图片确实解码成功了（说明桩环境是正常的）',
        (await js('document.getElementById("i1").naturalWidth')) > 0);

  /* ---------------- */

  console.log('\n[B] 开「无图」：图片请求必须根本没出门');

  noMedia.configure({ level: 'image' });
  // 广告桩的日志要清空：上一相位的记录留在里面会把「有没有被短路过」验成假阳性
  adblockStub.seen = [];
  const hitsBefore = noMediaHits;
  await load();

  check('页面本身还是请求到了（拦的是图，不是页面）', sawPath('/index.html'));
  check('三张 <img> 一个请求都没发', countImgs() === 0 && !sawPath('/img/a.png'),
        `实际 ${countImgs()} 条：${requestLog.join(' ')}`);
  check('CSS 背景图也没发', !sawPath('/img/bg.png'));
  check('放行名单上的 .ico 照常通过（几个 KB，拦它没意义还会让人以为浏览器坏了）',
        sawPath('/favicon.ico'));
  check('账记上了', noMediaHits - hitsBefore >= 4, `本相位命中 ${noMediaHits - hitsBefore} 次`);
  check('统计按类型分开', noMedia.snapshot().byType.image >= 4, JSON.stringify(noMedia.snapshot().byType));

  check('图片在页面里确实没解码', (await js('document.getElementById("i1").naturalWidth')) === 0,
        String(await js('document.getElementById("i1").naturalWidth')));

  // 顺序证明：被无图拦下的请求不该进广告拦截的账
  const adSawImg = adblockStub.seen.some((u) => /\/img\/a\.png/.test(u));
  check('被无图拦下的请求不会记到广告拦截头上（省流量不冒充拦截广告）', adSawImg === false,
        adblockStub.seen.join(' '));
  check('广告拦截仍在为正常请求工作', adblockStub.seen.some((u) => u.includes('/index.html')),
        adblockStub.seen.filter((u) => u.includes('index')).join(' '));

  /* ---------------- */

  console.log('\n[C] 「显示本页图片」：放行后图片必须回来');

  const wcId = win.webContents.id;
  check('放行前该页未被放行', noMedia.isPageAllowed(wcId) === false);
  noMedia.allowPage(wcId);
  check('放行后状态如实反映', noMedia.isPageAllowed(wcId) === true);

  await load();
  check('放行后图片请求回来了', countImgs() >= 3, `实际 ${countImgs()} 条`);
  check('放行后图片真的解码了', (await js('document.getElementById("i1").naturalWidth')) > 0);

  // 翻页即失效：否则用户会以为「只对刚才那一页生效」，实际却是永久放行
  noMedia.clear(wcId);
  check('clear 之后回到未放行', noMedia.isPageAllowed(wcId) === false);
  await load();
  check('放行状态清掉后图片又被拦了', countImgs() === 0, `实际 ${countImgs()} 条`);

  /* ---------------- */

  console.log('\n[D] 音视频（image-av 档）');

  // 先确认这个环境里 <video> 到底会不会发请求 —— 不发的话下面的断言就没有意义，
  // 与其给个假通过，不如如实说明环境驱动不了
  noMedia.configure({ level: 'off' });
  await load();
  noMedia.configure({ level: 'off' });
  const mediaWorks = await driveVideo(js);
  if (!mediaWorks) {
    skip('video 元素能触发 media 请求', '本环境里 preload=auto 不拉流，这一档改为由 test-nomedia 覆盖');
  } else {
    check('关档位时 video 会去拉流', sawPath('/v.mp4'));

    noMedia.configure({ level: 'image-av' });
    await load();
    const blockedMedia = await driveVideo(js);
    check('开 image-av 后 media 请求被拦下', !sawPath('/v.mp4'),
          `日志：${requestLog.filter((u) => u === '/v.mp4').length} 条 /v.mp4`);
    check('被拦下时 video 拿不到数据', blockedMedia && blockedMedia.readyState === 0,
          JSON.stringify(blockedMedia));
    check('media 进了统计', noMedia.snapshot().byType.media >= 1,
          JSON.stringify(noMedia.snapshot().byType));

    noMedia.configure({ level: 'off' });
    await load();
    await driveVideo(js);
    check('关回去之后又能拉流了', sawPath('/v.mp4'));
  }

  /* ---------------- */

  console.log('\n[E] 关闭即归零成本');

  noMedia.configure({ level: 'off' });
  const before = noMediaHits;
  await load();
  check('关闭后不再产生任何拦截', noMediaHits === before, `${before} → ${noMediaHits}`);
  check('关闭时图片全部正常加载', countImgs() >= 3, `实际 ${countImgs()} 条`);

  noMedia.allowPage(wcId);
  noMedia.clearAll();
  check('clearAll 清掉所有放行', noMedia.isPageAllowed(wcId) === false);

  /* ---------------- */

  console.log(`\n无图模式真机验证：${pass} 项通过 / ${fail} 项失败${skipped ? ` / ${skipped} 项跳过` : ''}\n`);

  try { win.destroy(); } catch { /* noop */ }
  try { server.close(); } catch { /* noop */ }
  app.exit(fail ? 1 : 0);
});

/**
 * 让页面里的 <video> 真正去拉一次流。
 * 注意 http 的 Content-Length 与真实字节数一致，避免 Chromium 直接判流结束。
 */
async function driveVideo(js) {
  try {
    await js(`(function(){
      var v = document.getElementById('v');
      if (!v) return null;
      v.preload = 'auto';
      try { v.load(); } catch (e) {}
      return true;
    })()`);
    await sleep(700);
    return await js(`(function(){
      var v = document.getElementById('v');
      return v ? { readyState: v.readyState, networkState: v.networkState } : null;
    })()`);
  } catch {
    return null;
  }
}
