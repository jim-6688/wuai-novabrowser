'use strict';

/**
 * 降级路径的补充验证（QA 独立写的用例，不改动 test-downloader.js）。
 * 用法：node tools/test-downloader-degrade-qa.js
 *
 * 与 tools/test-downloader.js 里 [C2] 那一组的区别：那边验的是「骗子服务器
 * 每次都整份从头倒」这一种性格；这里换几种服务端性格和几种时机，
 * 专挑「从哪儿接着下」「什么时候切」「切完还留下什么」这三件事的边界：
 *
 *   QA-1  contiguousReceived() 的洞出现在不同位置（不只是第 2 片）
 *   QA-2  200 整份 + Content-Range 写着整份（起点 0，最容易误判的一种）
 *   QA-3  一半老实一半骗（降级时前半截已经下满，看会不会白丢）
 *   QA-4  降级后极早暂停再续传（续传起点接近 0 这一档）
 *   QA-5  降级后有人在文件末尾多写了一截，落盘时是否被裁干净
 *   QA-6  续传后界面不会从「单连接」跳回「8 线程」
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { DownloadManager } = require('../src/main/downloader');

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const pattern = (size) => {
  const b = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 255;
  return b;
};

const N = 1024 * 1024;              // 1MB，切 8 片每片 128KB
const BODY = pattern(N);
const stats = { bytesSent: 0 };

/* ------------------------------------------------------------------ *
 * 测试用服务端
 * ------------------------------------------------------------------ */

function parseRange(req) {
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!m) return null;
  return { from: m[1] === '' ? 0 : Number(m[1]), to: m[2] === '' ? N - 1 : Number(m[2]) };
}

function makeServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    const r = parseRange(req);

    if (p === '/404') { res.writeHead(404); return res.end('nope'); }

    // 探测：那一个字节一律老实回 206，好让引擎按 8 片规划。
    // /shrink.bin 例外 —— 它要的就是「探测阶段就声明不支持 Range」。
    const isProbe = !!r && r.from === 0 && r.to === 0;
    if (isProbe && p !== '/404' && p !== '/shrink.bin') {
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '1',
        'Content-Range': `bytes 0-0/${N}`,
        'Accept-Ranges': 'bytes'
      });
      stats.bytesSent += 1;
      return res.end(BODY.subarray(0, 1));
    }

    /** 200 + 整份。echo=true 时把 Content-Range 也回出来（起点恰好是 0） */
    const fullBody = (echo) => {
      const h = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(N),
        'Accept-Ranges': 'bytes'
      };
      // echo 时把整份的 Content-Range 也回出来：起点恰好是 0，
      // 正好等于第一片请求的起点 —— 判据只看起点的话这一片会被误判成「认了 Range」
      if (echo) h['Content-Range'] = `bytes 0-${N - 1}/${N}`;
      res.writeHead(200, h);
      stats.bytesSent += N;
      res.end(BODY);
    };

    /** 真正的 206 分片 */
    const partial = (from, to) => {
      const slice = BODY.subarray(from, to + 1);
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${from}-${to}/${N}`,
        'Accept-Ranges': 'bytes'
      });
      stats.bytesSent += slice.length;
      res.end(slice);
    };

    if (p === '/shrink.bin') {
      // 声明长度不符：探测那一次说整份是 N（不支持 Range），
      // 真取数据时却只给了 N/2 并且干净收尾（Content-Length 也如实写成 N/2，
      // 所以 HTTP 层看不出任何问题 —— 不像 /trunc.bin 那样会被当成断线）。
      // 这一档过去是静默 DONE：用户拿到一个只有一半的文件，界面却说下好了。
      if (isProbe) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(N),
          'Accept-Ranges': 'none'
        });
        stats.bytesSent += 1;
        return res.end(BODY.subarray(0, 1));
      }
      const half = BODY.subarray(0, N / 2);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(half.length),
        'Accept-Ranges': 'none'
      });
      stats.bytesSent += half.length;
      return res.end(half);
    }

    if (p === '/echo-liar.bin') return fullBody(true);

    if (p === '/half-liar.bin') {
      // 前半截老实、后半截骗：降级发生时前半截应该已经下满，
      // 于是「从哪儿接着下」是 N/2 而不是 0 —— 取错就把已下的半份白丢了。
      if (r && r.from < N / 2) return partial(r.from, r.to);
      return setTimeout(() => fullBody(false), 200);
    }

    if (p === '/drip-liar.bin') {
      // 慢慢挤，好让「降级后刚写了一点点就按暂停」这一档跑得到
      const piece = 32 * 1024;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(N) });
      let off = 0;
      const pump = () => {
        if (res.destroyed || res.writableEnded) return;
        if (off >= N) return res.end();
        const s2 = BODY.subarray(off, Math.min(off + piece, N));
        off += s2.length;
        stats.bytesSent += s2.length;
        res.write(s2);
        setTimeout(pump, 15);
      };
      pump();
      return;
    }

    res.writeHead(404);
    res.end('nope');
  });
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

function mkManager(dir, opts = {}) {
  const updates = [];
  const mgr = new DownloadManager(Object.assign({
    dir,
    threads: 8,
    maxConcurrent: 5,
    onUpdate: (s) => updates.push(s),
    headersFor: async () => ({ 'User-Agent': 'NovaQaTest/1.0', 'Accept-Encoding': 'identity' })
  }, opts));
  return { mgr, updates };
}

async function waitFor(task, states, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (states.includes(task.state)) return task.state;
    await sleep(20);
  }
  return task.state;
}

(async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nova-dlqa-'));
  const server = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nQA 补充用例　服务端 ${base}　临时目录 ${tmpRoot}\n`);

  /* ---------------- QA-1 连续前缀的洞在不同位置 ---------------- */
  console.log('[QA-1] contiguousReceived()：洞出现在不同位置');

  const dirA = path.join(tmpRoot, 'a');
  await fsp.mkdir(dirA, { recursive: true });
  const { mgr: mgrA } = mkManager(dirA, { threads: 1 });
  const tA = mgrA.get(mgrA.enqueue({ url: `${base}/404`, filename: 'x.bin' }));
  await waitFor(tA, ['error', 'done']);

  const mk = (cursors) => cursors.map((cur, i) => ({
    index: i, start: i * 128, end: (i + 1) * 128 - 1, cursor: i * 128 + cur,
    state: 'active', connections: 0
  }));

  // 洞在第 1 片（工程师验过的那一档）
  tA.chunks = mk([128, 64, 128, 128]);
  check('洞在第 2 片：取连续前缀 192 而不是最大偏移', tA.contiguousReceived() === 192,
    String(tA.contiguousReceived()));

  // 洞在第 1 片本身 —— 后面全下满了也不能往前推
  tA.chunks = mk([30, 128, 128, 128]);
  check('洞在第 1 片：停在 30（后面下满也不算）', tA.contiguousReceived() === 30,
    String(tA.contiguousReceived()));

  // 洞在最后一片：前三片满、最后一片只下了 10 字节 ——
  // 那 10 字节本身是接得上的，所以连续前缀要把它算进去（394 而不是 384）
  tA.chunks = mk([128, 128, 128, 10]);
  check('最后一片半截：连续前缀含它已下的那 10 字节', tA.contiguousReceived() === 394,
    String(tA.contiguousReceived()));

  // 第一片一动没动
  tA.chunks = mk([0, 128, 128, 128]);
  check('第 1 片还没动：起点是 0（后面的都不能用）', tA.contiguousReceived() === 0,
    String(tA.contiguousReceived()));

  // 全下满
  tA.chunks = mk([128, 128, 128, 128]);
  check('全部下满：等于总长', tA.contiguousReceived() === 512, String(tA.contiguousReceived()));

  // 一片都没有
  tA.chunks = [];
  check('没有分片时不炸，返回 0', tA.contiguousReceived() === 0);
  await mgrA.shutdown();

  /* ---------------- QA-2 200 整份 + Content-Range 写着整份 ---------------- */
  console.log('\n[QA-2] 200 整份且 Content-Range 写着 bytes 0-(N-1)/N');

  const dirB = path.join(tmpRoot, 'b');
  await fsp.mkdir(dirB, { recursive: true });
  const { mgr: mgrB, updates: upB } = mkManager(dirB, { threads: 8 });
  const tB = mgrB.get(mgrB.enqueue({ url: `${base}/echo-liar.bin`, filename: 'echo.bin' }));
  await waitFor(tB, ['done', 'error', 'canceled']);

  check('这种服务端也要降级', tB.degraded === true, String(tB.degraded));
  check('降级后 ranged=false', tB.ranged === false);
  check('降级后只剩一片', tB.chunks.length === 1, `${tB.chunks.length} 片`);
  check('状态是 done 而不是甩个错误出来', tB.state === 'done',
    tB.state + (tB.error ? ' / ' + tB.error : ''));
  const gotB = await fsp.readFile(tB.savePath);
  check('文件逐字节正确', sha(gotB) === sha(BODY), sha(gotB).slice(0, 12) + '…');
  check('落盘大小正好（不是「完整+完整」）', gotB.length === N, `${gotB.length} vs ${N}`);
  await mgrB.shutdown();

  /* ---------------- QA-3 一半老实一半骗 ---------------- */
  console.log('\n[QA-3] 前半截老实分片、后半截整份从头倒');

  const dirC = path.join(tmpRoot, 'c');
  await fsp.mkdir(dirC, { recursive: true });
  const beforeC = stats.bytesSent;
  const { mgr: mgrC, updates: upC } = mkManager(dirC, { threads: 8 });
  const tC = mgrC.get(mgrC.enqueue({ url: `${base}/half-liar.bin`, filename: 'half.bin' }));
  await waitFor(tC, ['done', 'error', 'canceled']);

  check('确实降级了', tC.degraded === true, String(tC.degraded));
  check('状态是 done', tC.state === 'done', tC.state + (tC.error ? ' / ' + tC.error : ''));

  // 降级那一刻的快照里，已下字节应当已经越过半程 —— 前半截没被白丢
  const firstDegraded = upC.find((u) => u.degraded === true);
  check('降级时前半截的进度被留下了（不是从 0 重来）',
    !!firstDegraded && firstDegraded.received >= N / 2,
    firstDegraded ? String(firstDegraded.received) : '没抓到降级快照');

  const gotC = await fsp.readFile(tC.savePath);
  check('文件逐字节正确', sha(gotC) === sha(BODY), sha(gotC).slice(0, 12) + '…');
  check('落盘大小正好', gotC.length === N, `${gotC.length} vs ${N}`);
  check('带宽没有浪费成 8 倍整份',
    stats.bytesSent - beforeC < N * 3, `${stats.bytesSent - beforeC} vs 上限 ${N * 3}`);
  await mgrC.shutdown();

  /* ---------------- QA-4 降级后极早暂停再续传 ---------------- */
  console.log('\n[QA-4] 降级后只写了一点点就暂停，再续传');

  const dirD = path.join(tmpRoot, 'd');
  await fsp.mkdir(dirD, { recursive: true });
  const { mgr: mgrD, updates: upD } = mkManager(dirD, { threads: 8 });
  const idD = mgrD.enqueue({ url: `${base}/drip-liar.bin`, filename: 'drip.bin' });
  const tD = mgrD.get(idD);

  // 一看到降级就立刻按暂停：续传起点会非常接近 0，
  // 「从 0 重新倒、丢掉前 N 字节」这条路上 N≈0 是最容易被写错的一档
  const dl = Date.now() + 20000;
  while (!tD.degraded && tD.state !== 'done' && Date.now() < dl) await sleep(10);
  mgrD.pause(idD);
  await waitFor(tD, ['paused', 'done', 'error']);
  const midD = tD.received;

  check('降级后立刻暂停能停住', tD.state === 'paused', tD.state);
  check('暂停时确实已经写了一部分', midD > 0 && midD < N, `${midD} / ${N}`);
  check('暂停时 sidecar 记了降级状态',
    JSON.parse(await fsp.readFile(tD.savePath + '.novadl.json', 'utf8')).degraded === true);

  mgrD.resume(idD);
  await waitFor(tD, ['done', 'error'], 30000);
  const gotD = await fsp.readFile(tD.savePath);
  check('续传后状态是 done', tD.state === 'done', tD.state + (tD.error ? ' / ' + tD.error : ''));
  check('续传后文件逐字节正确（偏移没算错）', sha(gotD) === sha(BODY), sha(gotD).slice(0, 12) + '…');
  check('续传后大小正好（没有重复也没有缺口）', gotD.length === N, `${gotD.length} vs ${N}`);
  await mgrD.shutdown();

  /* ---------------- QA-5 末尾多出的一截要被裁掉 ---------------- */
  console.log('\n[QA-5] 降级后有人在文件末尾多写了一截');

  const dirE = path.join(tmpRoot, 'e');
  await fsp.mkdir(dirE, { recursive: true });
  const { mgr: mgrE } = mkManager(dirE, { threads: 8 });
  const idE = mgrE.enqueue({ url: `${base}/drip-liar.bin`, filename: 'tail.bin' });
  const tE = mgrE.get(idE);
  const dlE = Date.now() + 20000;
  while (!tE.degraded && tE.state !== 'done' && Date.now() < dlE) await sleep(10);

  // 趁它还在下，往文件末尾另外粘 256KB 垃圾 —— 这正是「被丢弃分片写下的
  // 越界字节」的样子：单连接那一片覆盖不到，只能靠落盘前那一刀裁掉。
  const junk = Buffer.alloc(256 * 1024, 0x5a);
  const fhJunk = await fsp.open(tE.savePath, 'r+');
  const cur = (await fsp.stat(tE.savePath)).size;
  await fhJunk.write(junk, 0, junk.length, cur);
  await fhJunk.close();
  const withTail = (await fsp.stat(tE.savePath)).size;
  check('粘完之后文件确实变长了（这一刀有东西可裁）', withTail > cur, `${cur} → ${withTail}`);

  await waitFor(tE, ['done', 'error'], 30000);
  const gotE = await fsp.readFile(tE.savePath);
  check('状态是 done', tE.state === 'done', tE.state + (tE.error ? ' / ' + tE.error : ''));
  check('落盘时把越界的那一截裁干净了', gotE.length === N, `${gotE.length} vs ${N}`);
  check('裁完之后内容仍然逐字节正确', sha(gotE) === sha(BODY), sha(gotE).slice(0, 12) + '…');
  await mgrE.shutdown();

  /* ---------------- QA-6 续传后界面不跳回 8 线程 ---------------- */
  console.log('\n[QA-6] 续传后界面不会从「单连接」跳回「8 线程」');

  const dirF = path.join(tmpRoot, 'f');
  await fsp.mkdir(dirF, { recursive: true });
  const { mgr: mgrF, updates: upF } = mkManager(dirF, { threads: 8 });
  const idF = mgrF.enqueue({ url: `${base}/drip-liar.bin`, filename: 'ui.bin' });
  const tF = mgrF.get(idF);
  const dlF = Date.now() + 20000;
  while (!tF.degraded && tF.state !== 'done' && Date.now() < dlF) await sleep(10);
  await sleep(120);
  mgrF.pause(idF);
  await waitFor(tF, ['paused', 'done', 'error']);
  const upToPause = upF.length;

  mgrF.resume(idF);
  await waitFor(tF, ['done', 'error'], 30000);
  const afterResume = upF.slice(upToPause);

  check('续传后仍然是 done', tF.state === 'done', tF.state + (tF.error ? ' / ' + tF.error : ''));
  check('续传后的每一份快照都还带着 degraded=true（没有翻回去）',
    afterResume.length > 0 && afterResume.every((u) => u.degraded === true),
    `${afterResume.filter((u) => u.degraded !== true).length} 份翻了回去 / 共 ${afterResume.length} 份`);
  check('续传后线程数没有跳回 8',
    afterResume.every((u) => (u.threads || 1) === 1),
    '最大 ' + Math.max(...afterResume.map((u) => u.threads || 1)));
  check('降级原因那一句话还在（界面有话可说）',
    afterResume.some((u) => /单连接/.test(u.degradeReason || '')),
    String(afterResume[afterResume.length - 1] && afterResume[afterResume.length - 1].degradeReason));
  await mgrF.shutdown();

  /* ---------------- QA-7 普通单连接声明长度不符要报错 ---------------- */
  console.log('\n[QA-7] 普通单连接：声明的长度没兑现');

  const dirG = path.join(tmpRoot, 'g');
  await fsp.mkdir(dirG, { recursive: true });
  const { mgr: mgrG } = mkManager(dirG, { threads: 8 });
  const tG = mgrG.get(mgrG.enqueue({ url: `${base}/shrink.bin`, filename: 'shrink.bin' }));
  await waitFor(tG, ['done', 'error', 'canceled']);

  // HTTP 层看不出问题（Content-Length 是如实的、连接也干净收尾），
  // 所以「连接被对端提前中断」那道防线抓不到它，只能靠 settle 的大小校验。
  check('不是分片也不是降级，就是最普通的一路单连接',
    tG.ranged === false && tG.degraded === false, `ranged=${tG.ranged} degraded=${tG.degraded}`);
  check('不许报「完成」—— 那等于发一个半截文件给用户', tG.state === 'error', tG.state);
  check('错误要说清楚是长度对不上', /字节/.test(tG.error || ''), String(tG.error));

  server.close();
  console.log(`\n降级补充用例：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
