'use strict';

/**
 * 多线程下载引擎集成测试（纯 Node，不需要 Electron / jsdom）
 * 用法：node tools/test-downloader.js
 *
 * 这不是 mock 测试 —— 起一个真实的 http 服务器，让引擎真下载，
 * 然后拿 sha256 跟源数据逐字节比对。同时统计服务端侧收到的连接数与
 * 发出的字节数，用来证明「确实是多连接并行」以及「续传确实没重下」。
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const {
  DownloadManager, planChunks, parseContentRange, sanitizeName,
  filenameFromDisposition, filenameFromUrl, uniquePath
} = require('../src/main/downloader');

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const human = (n) => n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';

/* ------------------------------------------------------------------ *
 * 测试用 HTTP 服务器
 * ------------------------------------------------------------------ */

const pattern = (size) => {
  const b = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 255;
  return b;
};

const bodies = {
  big: pattern(6 * 1024 * 1024),      // 6MB，够切 8 片
  small: pattern(64 * 1024),          // 64KB，小于最小分片尺寸 → 只能单线程
  odd: pattern(1000 * 1000 + 7),      // 故意不是整数兆，验边界
  norange: pattern(1024 * 1024),
  slow: pattern(512 * 1024),
  trunc: pattern(2 * 1024 * 1024),
  liar: pattern(3 * 1024 * 1024)
};

const stats = {
  requests: 0, rangeRequests: 0, bytesSent: 0,
  /** /liar.bin 上「要 206 却回 200 整份」的次数 */
  liarFullBodies: 0,
  paths: {},
  /** 每个路径同时在飞的响应数，用来抓「并发达到了多少」 */
  inflight: {}, peakInflight: {}
};

function makeServer() {
  const truncLeft = { '/trunc.bin': 2 };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    stats.requests++;
    stats.paths[p] = (stats.paths[p] || 0) + 1;
    if (req.headers.range) stats.rangeRequests++;

    // 在飞的响应数只在 close 时减 —— 一定要等响应体真正发完，
    // 否则内存里瞬间返回的响应会让计数永远停在 1，量不出并发。
    stats.inflight[p] = (stats.inflight[p] || 0) + 1;
    stats.peakInflight[p] = Math.max(stats.peakInflight[p] || 0, stats.inflight[p]);
    res.on('close', () => { stats.inflight[p] = Math.max(0, stats.inflight[p] - 1); });

    /* ---- 特殊路径 ---- */

    if (p === '/404') { res.writeHead(404); return res.end('nope'); }

    if (p === '/redirect') { res.writeHead(302, { Location: '/big.bin' }); return res.end(); }
    if (p === '/redirect-loop') { res.writeHead(302, { Location: '/redirect-loop' }); return res.end(); }

    if (p === '/disposition') {
      const body = bodies.small;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        'Content-Disposition': "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87%E5%90%8D.zip",
        'Accept-Ranges': 'bytes'
      });
      stats.bytesSent += body.length;
      return res.end(body);
    }

    // 不支持 Range、且慢慢地挤数据 —— 用来测「暂停时正好有在飞的连接」
    if (p === '/slow.bin') {
      const body = bodies.slow;
      res.writeHead(200, { 'Content-Length': body.length, 'Accept-Ranges': 'none' });
      const step = Math.ceil(body.length / 16);
      let off = 0;
      const timer = setInterval(() => {
        if (off >= body.length) { clearInterval(timer); return res.end(); }
        const slice = body.subarray(off, Math.min(off + step, body.length));
        off += slice.length;
        stats.bytesSent += slice.length;
        res.write(slice);
      }, 20);
      res.on('close', () => clearInterval(timer));
      return;
    }

    // 「骗子」服务器：探测那一个字节（Range: bytes=0-0）老老实实回 206，
    // 于是引擎会按 8 片规划；等真正的分片请求来了，却把 Range 当耳边风，
    // 每次都从头倒一份完整的 200。这是「服务端不支持分片」最难缠的一种：
    // 探测阶段看不出来，只能在传输中途发现。
    if (p === '/liar.bin' || p === '/echo.bin') {
      const body = bodies.liar;
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      const isProbe = !!m && m[1] === '0' && m[2] === '0';
      if (isProbe) {
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '1',
          'Content-Range': `bytes 0-0/${body.length}`,
          'Accept-Ranges': 'bytes'
        });
        stats.bytesSent += 1;
        return res.end(body.subarray(0, 1));
      }
      stats.liarFullBodies++;
      // 一点点挤，好让降级发生时确实有分片正在写盘 —— 太快的话
      // 八片会在降级生效前就各自跑完，测不出「边下边切」。
      // ?dribble=ms 可以把窗口拉长到「来得及在半路按暂停」。
      const dribble = Number(u.searchParams.get('dribble') || 2);
      const piece = 64 * 1024;
      // echo 变体：整份从头倒，但把 Content-Range 老老实实回写成 bytes 0-(N-1)/N。
      // 起点恰好是 0，正好等于第一片请求的起点 —— 判据只看起点的话，
      // 第一片会被误判成「服务端认了 Range」。（QA 端到端在安卓端逮到的那一次。）
      const echo = p === '/echo.bin';
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        'Accept-Ranges': 'bytes'
      };
      if (echo) headers['Content-Range'] = `bytes 0-${body.length - 1}/${body.length}`;
      res.writeHead(200, headers);
      let off = 0;
      const pump = () => {
        if (res.destroyed || res.writableEnded) return;
        if (off >= body.length) return res.end();
        const s2 = body.subarray(off, Math.min(off + piece, body.length));
        off += s2.length;
        stats.bytesSent += s2.length;
        res.write(s2);
        setTimeout(pump, dribble);
      };
      pump();
      return;
    }

    const table = {
      '/big.bin': { body: bodies.big, ranged: true },
      '/small.bin': { body: bodies.small, ranged: true },
      '/odd.bin': { body: bodies.odd, ranged: true },
      '/srslow.bin': { body: bodies.big, ranged: true },
      '/trunc.bin': { body: bodies.trunc, ranged: true },
      '/norange.bin': { body: bodies.norange, ranged: false }
    };
    const entry = table[p];
    if (!entry) { res.writeHead(404); return res.end('unknown'); }

    const body = entry.body;

    // 声明了长度却只发一半就掐断，用来验证「分片内重试」
    if (p === '/trunc.bin' && truncLeft[p] > 0) {
      truncLeft[p] -= 1;
      const half = Math.floor(body.length / 2);
      res.writeHead(200, { 'Content-Length': body.length, 'Accept-Ranges': 'none' });
      stats.bytesSent += half;
      res.write(Buffer.from(body.subarray(0, half)));
      setTimeout(() => res.destroy(), 10);
      return;
    }

    const range = entry.ranged ? req.headers.range : null;

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start === null) { start = body.length - (end || 0); end = body.length - 1; }
      if (end === null || end >= body.length) end = body.length - 1;
      if (!(start >= 0) || start > end || start >= body.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
        return res.end();
      }
      const slice = body.subarray(start, end + 1);

      // ?delay=ms 每个分片响应前先等一会儿：顺序下载会把延迟累加，
      // 并发下载则重叠 —— 这是「真多线程」最不含糊的证据。
      // ?dribble=ms 把响应体拆成小块慢慢发，用来制造足够长的下载窗口。
      const delayMs = Number(u.searchParams.get('delay') || 0);
      const dribble = Number(u.searchParams.get('dribble') || 0);

      const send = () => {
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': slice.length,
          'Content-Range': `bytes ${start}-${end}/${body.length}`,
          'Accept-Ranges': 'bytes'
        });
        if (!dribble) { stats.bytesSent += slice.length; return res.end(slice); }
        const piece = Math.max(4096, Math.ceil(slice.length / 24));
        let off = 0;
        const pump = () => {
          // 客户端可能已经掐断连接（暂停/取消），这里必须自查，
          // 否则往已销毁的流里写会抛 ERR_STREAM_DESTROYED 把测试服务器带崩。
          if (res.destroyed || res.writableEnded) return;
          if (off >= slice.length) return res.end();
          const s2 = slice.subarray(off, Math.min(off + piece, slice.length));
          off += s2.length;
          stats.bytesSent += s2.length;
          res.write(s2);
          setTimeout(pump, dribble);
        };
        pump();
      };

      if (delayMs) setTimeout(send, delayMs); else send();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length,
      'Accept-Ranges': entry.ranged ? 'bytes' : 'none'
    });
    stats.bytesSent += body.length;
    res.end(body);
  });

  return server;
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

function mkManager(dir, opts = {}) {
  const updates = [];
  const mgr = new DownloadManager(Object.assign({
    dir,
    threads: 8,
    maxConcurrent: 3,
    onUpdate: (s) => updates.push(s),
    headersFor: async () => ({ 'User-Agent': 'NovaTest/1.0', 'Accept-Encoding': 'identity' })
  }, opts));
  return { mgr, updates };
}

async function waitFor(task, states, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (states.includes(task.state)) return task.state;
    await sleep(30);
  }
  return task.state;
}

async function download(mgr, url, opts = {}) {
  const id = mgr.enqueue(Object.assign({ url }, opts));
  const task = mgr.get(id);
  await waitFor(task, ['done', 'error', 'canceled', 'paused']);
  return task;
}

/* ------------------------------------------------------------------ *
 * 跑
 * ------------------------------------------------------------------ */

(async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nova-dl-'));
  const server = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\n测试服务器 ${base}  临时目录 ${tmpRoot}\n`);

  /* ---------- [A] 纯函数 ---------- */
  console.log('[A] 分片规划与文件名解析（纯函数）');

  const c1 = planChunks(1024 * 1024 * 8, 8);
  check('8MB 切 8 片', c1.length === 8, `实际 ${c1.length}`);
  check('分片无重叠且顺序递增', c1.every((c, i) => i === 0 ? c.start === 0 : c.start === c1[i - 1].end + 1));
  check('最后一片正好落在 total-1', c1[c1.length - 1].end === 8 * 1024 * 1024 - 1);
  check('各片大小相等（8MB/8）', new Set(c1.map((c) => c.end - c.start + 1)).size === 1);

  const c2 = planChunks(1000 * 1000 + 7, 8);
  check('长度不能整除时最后一片吸收余数',
    c2.reduce((a, c) => a + (c.end - c.start + 1), 0) === 1000 * 1000 + 7,
    `${c2.reduce((a, c) => a + (c.end - c.start + 1), 0)} vs ${1000 * 1000 + 7}`);

  check('小文件不硬切（64KB → 1 片）', planChunks(64 * 1024, 8).length === 1);
  check('线程数上限被夹住（要 64 片实际 ≤16）', planChunks(64 * 1024 * 1024, 64).length <= 16);
  check('total 未知时不分片', planChunks(-1, 8).length === 0);

  check('解析 Content-Range', parseContentRange('bytes 0-0/12345') === 12345);
  check('Content-Range 不合法时返回 -1', parseContentRange('garbage') === -1);

  check('过滤 Windows 非法字符', sanitizeName('a/b\\c:d*e?f"g<h>i|j.txt') === 'a_b_c_d_e_f_g_h_i_j.txt',
    sanitizeName('a/b\\c:d*e?f"g<h>i|j.txt'));
  check('去掉开头的点（防目录穿越）', sanitizeName('../../etc/passwd') === '_.._etc_passwd',
    sanitizeName('../../etc/passwd'));

  check('RFC 5987 中文文件名', filenameFromDisposition("attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.zip") === '中文.zip',
    filenameFromDisposition("attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87.zip"));
  check('普通引号文件名', filenameFromDisposition('attachment; filename="a b.zip"') === 'a b.zip');
  check('从 URL 推文件名', filenameFromUrl('http://x/y/%E6%B5%8B%E8%AF%95.bin') === '测试.bin',
    filenameFromUrl('http://x/y/%E6%B5%8B%E8%AF%95.bin'));

  /* ---------- [B] 多线程主路径 ---------- */
  console.log('\n[B] 多线程主路径（6MB / 8 线程）');

  const dirB = path.join(tmpRoot, 'b');
  await fsp.mkdir(dirB, { recursive: true });
  const beforeB = { req: stats.rangeRequests, bytes: stats.bytesSent };
  const { mgr: mgrB, updates } = mkManager(dirB, { threads: 8 });
  const tB = await download(mgrB, `${base}/big.bin`, { filename: 'big.bin' });
  const bytesB = stats.bytesSent - beforeB.bytes;
  const rangesB = stats.rangeRequests - beforeB.req;

  check('任务状态为 done', tB.state === 'done', tB.state + (tB.error ? ' / ' + tB.error : ''));
  check('识别为支持分片（ranged=true）', tB.ranged === true);
  check('总长度正确', tB.total === bodies.big.length, `${tB.total} vs ${bodies.big.length}`);
  check('已收字节 == 总长度', tB.received === bodies.big.length);
  check('界面线程数为 8', tB.snapshot().threads === 8, String(tB.snapshot().threads));
  check('分片数 8 且各自跑到头', tB.chunks.length === 8 && tB.chunks.every((c) => c.cursor === c.end + 1));

  const gotB = await fsp.readFile(tB.savePath);
  check('下载结果与源文件 sha256 一致', sha(gotB) === sha(bodies.big), sha(gotB).slice(0, 16) + '…');
  check('落盘大小正确', gotB.length === bodies.big.length);

  check('服务端确实收到 ≥8 个 Range 请求（真并发分片）', rangesB >= 8, `实际 ${rangesB}`);
  check('传输总量 ≈ 文件大小（没有重复下载）', bytesB < bodies.big.length * 1.1,
    `${human(bytesB)} vs ${human(bodies.big.length)}`);
  check('成功率不是 0（有进度事件）', updates.some((u) => u.state === 'downloading' && u.received > 0));
  check('成功后 sidecar 被清除', !fs.existsSync(tB.savePath + '.novadl.json'));

  // 并行性最硬的证据：让每个分片响应前先等 150ms。
  // 顺序下载要把延迟累加成 8×150 = 1200ms，并发重叠则只需约 150ms。
  // 这条不依赖任何计数器，纯粹看墙钟时间。
  //
  // 注意「并发连接峰值」只能在这种带延迟的场景下量：本机内存响应是瞬时返回的，
  // 8 个请求会在事件循环里流水而过、窗口根本重叠不上（实测峰值只有 1），
  // 那是量法的问题，不是引擎没并发。
  const peakBefore = stats.peakInflight['/big.bin'] || 0;
  const dirB2 = path.join(tmpRoot, 'b2');
  await fsp.mkdir(dirB2, { recursive: true });
  const { mgr: mgrB2 } = mkManager(dirB2, { threads: 8 });
  const t0 = Date.now();
  const tB2 = await download(mgrB2, `${base}/big.bin?delay=150`, { filename: 'parallel.bin' });
  const elapsed = Date.now() - t0;
  const peakB2 = stats.peakInflight['/big.bin'] || 0;

  check('并行性：8 片各延迟 150ms，总耗时远小于顺序累加的 1200ms',
    tB2.state === 'done' && elapsed < 900, `${elapsed} ms（顺序需 ≥1350ms）`);
  check('带延迟时服务端同时挂着 8 个连接（真并发，非流水线）',
    peakB2 >= 6 && peakB2 > peakBefore, `峰值 ${peakB2}（即时响应场景下仅 ${peakBefore}）`);

  /* ---------- [C] 服务端不支持 Range → 退化单连接 ---------- */
  console.log('\n[C] 服务端不支持 Range 时退化单连接');

  const dirC = path.join(tmpRoot, 'c');
  await fsp.mkdir(dirC, { recursive: true });
  const beforeC = stats.rangeRequests;
  const { mgr: mgrC } = mkManager(dirC, { threads: 8 });
  const tC = await download(mgrC, `${base}/norange.bin`, { filename: 'norange.bin' });
  const gotC = await fsp.readFile(tC.savePath);

  check('仍然下完了（不因不支持分片而报错）', tC.state === 'done', tC.state + (tC.error ? ' / ' + tC.error : ''));
  check('ranged=false 如实标注', tC.ranged === false);
  check('界面上线程数显示 1', tC.snapshot().threads === 1);
  check('内容正确', sha(gotC) === sha(bodies.norange));
  // 探测阶段必然要发一个 `bytes=0-0`（1 字节）才能判定服务端认不认 Range，
  // 除此之外不该再有分片请求 —— 这就是退化成单连接的证据。
  check('除探测那 1 个之外不再发 Range 请求',
    stats.rangeRequests - beforeC === 1, `多了 ${stats.rangeRequests - beforeC} 个`);

  /* ---------- [C2] 探测说支持、真发请求却被无视 → 运行时降级 ---------- */
  console.log('\n[C2] 分片请求被无视时运行时切回单连接');

  const dirC2 = path.join(tmpRoot, 'c2');
  await fsp.mkdir(dirC2, { recursive: true });
  const beforeC2 = { bytes: stats.bytesSent, full: stats.liarFullBodies };
  const { mgr: mgrC2, updates: upC2 } = mkManager(dirC2, { threads: 8 });
  const idC2 = mgrC2.enqueue({ url: `${base}/liar.bin`, filename: 'liar.bin' });
  const tC2 = mgrC2.get(idC2);
  await waitFor(tC2, ['done', 'error', 'canceled'], 30000);

  // 先确认它确实是「按多线程起手」的 —— 否则这个用例根本没测到降级。
  // 取快照里的峰值而不是结束时的值：降级后 chunks 只剩一片，
  // 而「进入 downloading 那一次」的快照一定还是 8 片。
  const plannedC2 = upC2.reduce((m, u) => Math.max(m, (u.chunks || []).length), 0);
  check('起手按 8 片规划（探测确实回了 206）', plannedC2 === 8, `峰值 ${plannedC2} 片`);
  check('服务端确实整份从头倒过（不是我们误判）',
    stats.liarFullBodies - beforeC2.full >= 1, `${stats.liarFullBodies - beforeC2.full} 次`);
  check('运行时降级被触发', tC2.degraded === true, String(tC2.degraded));
  check('降级后 ranged=false', tC2.ranged === false);
  check('降级后只剩一片', tC2.chunks.length === 1, `${tC2.chunks.length} 片`);
  check('界面线程数如实变成 1', tC2.snapshot().threads === 1, String(tC2.snapshot().threads));
  check('降级后仍然下完（没有甩出去报错）', tC2.state === 'done',
    tC2.state + (tC2.error ? ' / ' + tC2.error : ''));

  const gotC2 = await fsp.readFile(tC2.savePath);
  check('降级后文件逐字节正确（没有写坏）', sha(gotC2) === sha(bodies.liar),
    sha(gotC2).slice(0, 16) + '… vs ' + sha(bodies.liar).slice(0, 16) + '…');
  check('落盘大小正好等于文件长度（没有残留尾巴）',
    gotC2.length === bodies.liar.length, `${gotC2.length} vs ${bodies.liar.length}`);
  check('降级消息是给用户看的一句话', /单连接/.test(tC2.degradeReason || ''), tC2.degradeReason);
  check('降级后不再有八份全量在飞（带宽没被浪费成 8 倍）',
    stats.bytesSent - beforeC2.bytes < bodies.liar.length * 3,
    `${human(stats.bytesSent - beforeC2.bytes)}（整份 ${human(bodies.liar.length)}）`);
  check('降级那一刻之后界面收到过单连接的快照',
    upC2.some((u) => u.degraded === true && u.threads === 1));

  // 降级时「从哪儿接着下」是全链路最容易写错的一步：分片是并行填的，
  // 第 3 片可能写完了而第 1 片才过半。这时正确的起点是连续前缀（1500），
  // 不是最大已下偏移（3000）—— 取后者会把 1500–2000 那个洞留在文件里。
  const { mgr: mgrC3 } = mkManager(dirC2, { threads: 1 });
  const tC3 = mgrC3.get(mgrC3.enqueue({ url: `${base}/404`, filename: 'probe-only.bin' }));
  await waitFor(tC3, ['error', 'done']);
  tC3.chunks = [
    { index: 0, start: 0, end: 999, cursor: 1000, state: 'done', connections: 0 },
    { index: 1, start: 1000, end: 1999, cursor: 1500, state: 'active', connections: 0 },
    { index: 2, start: 2000, end: 2999, cursor: 3000, state: 'done', connections: 0 }
  ];
  check('连续前缀算到第一个洞为止（不会把洞留在文件里）', tC3.contiguousReceived() === 1500,
    String(tC3.contiguousReceived()));
  tC3.chunks[1].cursor = 2000;
  check('补齐之后连续前缀继续往前推', tC3.contiguousReceived() === 3000,
    String(tC3.contiguousReceived()));
  await mgrC3.shutdown();

  // 降级之后再暂停 / 续传：服务端不认 Range，续传只能靠「从 0 重新倒、丢掉前 N 字节」。
  // 这条路和「刚从八片切成一片」叠在一起，是整条需求里最容易把偏移算错的地方。
  const { mgr: mgrC4 } = mkManager(dirC2, { threads: 8 });
  const idC4 = mgrC4.enqueue({ url: `${base}/liar.bin?dribble=20`, filename: 'liar-resume.bin' });
  const tC4 = mgrC4.get(idC4);
  const deadline = Date.now() + 15000;
  while (!tC4.degraded && tC4.state !== 'done' && Date.now() < deadline) await sleep(20);
  await sleep(60);
  mgrC4.pause(idC4);
  await waitFor(tC4, ['paused', 'done', 'error']);
  const midC4 = tC4.received;

  check('降级中途能按下暂停', tC4.state === 'paused', tC4.state);
  check('暂停时已经下到一部分（不是从零重来）',
    midC4 > 0 && midC4 < bodies.liar.length, `${human(midC4)} / ${human(bodies.liar.length)}`);
  check('暂停时落了 sidecar', fs.existsSync(tC4.savePath + '.novadl.json'));

  mgrC4.resume(idC4);
  await waitFor(tC4, ['done', 'error'], 30000);
  const gotC4 = await fsp.readFile(tC4.savePath);
  check('降级 + 续传后仍下完', tC4.state === 'done', tC4.state + (tC4.error ? ' / ' + tC4.error : ''));
  check('降级 + 续传后文件逐字节正确（偏移没算错）', sha(gotC4) === sha(bodies.liar),
    sha(gotC4).slice(0, 16) + '…');
  check('降级 + 续传后大小正好（没有重复也没有缺口）',
    gotC4.length === bodies.liar.length, `${gotC4.length} vs ${bodies.liar.length}`);
  await mgrC4.shutdown();

  // 同一个「服务端不支持」，只是它把 Content-Range 也回了出来：
  // bytes 0-(N-1)/N 的起点是 0，正好等于第一片请求的起点。
  // 判据若只比对起点，第一片会被当成「服务端认了 Range」—— 整份被倒进一个
  // 只有 1/8 的分片，而降级时那一片又因为「已完成」被整片留下。
  const dirC5 = path.join(tmpRoot, 'c5');
  await fsp.mkdir(dirC5, { recursive: true });
  const { mgr: mgrC5 } = mkManager(dirC5, { threads: 8 });
  const tC5 = await download(mgrC5, `${base}/echo.bin`, { filename: 'echo.bin' });
  const gotC5 = await fsp.readFile(tC5.savePath);

  check('回显整份 Content-Range 时同样要降级', tC5.degraded === true, String(tC5.degraded));
  check('回显整份 Content-Range 时仍然下完', tC5.state === 'done',
    tC5.state + (tC5.error ? ' / ' + tC5.error : ''));
  check('回显整份 Content-Range 时文件逐字节正确', sha(gotC5) === sha(bodies.liar),
    sha(gotC5).slice(0, 16) + '…');
  check('回显整份 Content-Range 时大小正好（不是「完整 + 尾巴」）',
    gotC5.length === bodies.liar.length, `${gotC5.length} vs ${bodies.liar.length}`);
  await mgrC5.shutdown();

  /* ---------- [D] 不支持 Range 时的单连接续传 ---------- */
  console.log('\n[D] 不支持 Range 时暂停再继续（靠丢弃前缀续传）');

  const dirD = path.join(tmpRoot, 'd');
  await fsp.mkdir(dirD, { recursive: true });
  const { mgr: mgrD } = mkManager(dirD, { threads: 8 });
  const idD = mgrD.enqueue({ url: `${base}/slow.bin`, filename: 'slow.bin' });
  const tD = mgrD.get(idD);
  await waitFor(tD, ['downloading']);
  await sleep(120);
  mgrD.pause(idD);
  await waitFor(tD, ['paused', 'error', 'done']);
  const pauseAt = tD.received;
  const gotDuringPause = fs.existsSync(tD.savePath) ? (await fsp.stat(tD.savePath)).size : 0;

  check('暂停后状态为 paused', tD.state === 'paused', tD.state + (tD.error ? ' / ' + tD.error : ''));
  check('暂停时已下一部分', pauseAt > 0 && pauseAt < bodies.slow.length, `${human(pauseAt)} / ${human(bodies.slow.length)}`);
  check('暂停时写了 sidecar（供续传）', fs.existsSync(tD.savePath + '.novadl.json'));

  const sidecarD = JSON.parse(await fsp.readFile(tD.savePath + '.novadl.json', 'utf8'));
  check('sidecar 记了游标且大于 0', sidecarD.chunks[0].cursor > 0, String(sidecarD.chunks[0].cursor));

  mgrD.resume(idD);
  await waitFor(tD, ['done', 'error', 'canceled']);
  const gotD = await fsp.readFile(tD.savePath);
  check('继续后下完', tD.state === 'done', tD.state + (tD.error ? ' / ' + tD.error : ''));
  check('续传结果 sha256 正确（丢弃前缀逻辑没写错位）', sha(gotD) === sha(bodies.slow),
    sha(gotD).slice(0, 16) + '… vs ' + sha(bodies.slow).slice(0, 16) + '…');
  check('续传后 sidecar 被清掉', !fs.existsSync(tD.savePath + '.novadl.json'));

  /* ---------- [E] 分片内重试（对端提前掐断） ---------- */
  console.log('\n[E] 对端声明长度却提前掐断 → 分片内重试');

  const dirE = path.join(tmpRoot, 'e');
  await fsp.mkdir(dirE, { recursive: true });
  const { mgr: mgrE } = mkManager(dirE, { threads: 4, maxConcurrent: 1 });
  const tE = await download(mgrE, `${base}/trunc.bin`, { filename: 'trunc.bin' });
  const gotE = await fsp.readFile(tE.savePath);

  check('前两次被掐断后仍下完', tE.state === 'done', tE.state + (tE.error ? ' / ' + tE.error : ''));
  check('重试后的内容依然正确', sha(gotE) === sha(bodies.trunc), sha(gotE).slice(0, 16) + '…');

  /* ---------- [F] 多线程的暂停 / 续传 ---------- */
  console.log('\n[F] 多线程任务暂停再继续（只补剩余区间）');

  const dirF = path.join(tmpRoot, 'f');
  await fsp.mkdir(dirF, { recursive: true });
  const { mgr: mgrF } = mkManager(dirF, { threads: 4 });
  // 先整跑一遍量出基准字节数
  const beforeF = stats.bytesSent;
  const tF0 = await download(mgrF, `${base}/big.bin`, { filename: 'base.bin' });
  const fullBytes = stats.bytesSent - beforeF;
  check('基准：整跑一遍传输量≈文件大小', tF0.state === 'done' && fullBytes < bodies.big.length * 1.1,
    human(fullBytes));

  const beforeF2 = stats.bytesSent;
  // ?dribble=15 让每个分片分约 24 小块、每块隔 15ms 发，把下载窗口拉到 300ms 以上，
  // 这样才有机会在下载中途按暂停（本机 localhost 太快，不拖一下根本来不及）。
  const idF = mgrF.enqueue({ url: `${base}/big.bin?dribble=15`, filename: 'resume.bin' });
  const tF = mgrF.get(idF);
  await waitFor(tF, ['downloading']);
  await sleep(70);
  mgrF.pause(idF);
  await waitFor(tF, ['paused', 'error', 'done']);
  const midF = tF.received;
  check('多线程任务能暂停', tF.state === 'paused', tF.state);
  check('暂停时已有分片拿到了数据', tF.chunks.filter((c) => c.cursor > c.start).length >= 1,
    tF.chunks.map((c) => c.cursor - c.start).join('/'));

  mgrF.resume(idF);
  await waitFor(tF, ['done', 'error']);
  const gotF = await fsp.readFile(tF.savePath);
  const resumedBytes = stats.bytesSent - beforeF2;

  check('续传完成', tF.state === 'done', tF.state + (tF.error ? ' / ' + tF.error : ''));
  check('续传结果正确', sha(gotF) === sha(bodies.big));
  check('续传没有把整个文件重下一遍', resumedBytes < bodies.big.length * 1.6,
    `${human(resumedBytes)}（整下需 ${human(bodies.big.length)}）`);
  check('续传后各分片都到 end+1', tF.chunks.every((c) => c.cursor === c.end + 1));

  /* ---------- [G] 重定向 ---------- */
  console.log('\n[G] 重定向');

  const dirG = path.join(tmpRoot, 'g');
  await fsp.mkdir(dirG, { recursive: true });
  const { mgr: mgrG } = mkManager(dirG, { threads: 4 });
  const tG = await download(mgrG, `${base}/redirect`, { filename: 'via-redirect.bin' });
  const gotG = await fsp.readFile(tG.savePath);
  check('跟随 302 后下完', tG.state === 'done', tG.state + (tG.error ? ' / ' + tG.error : ''));
  check('内容与目标文件一致', sha(gotG) === sha(bodies.big));
  check('记下了最终 URL', /\/big\.bin$/.test(tG.finalUrl), tG.finalUrl);

  const { mgr: mgrG2 } = mkManager(path.join(tmpRoot, 'g2'), { threads: 2 });
  await fsp.mkdir(path.join(tmpRoot, 'g2'), { recursive: true });
  const tG2 = await download(mgrG2, `${base}/redirect-loop`, { filename: 'loop.bin' });
  check('重定向死循环给出明确报错而非卡死', tG2.state === 'error' && /重定向/.test(tG2.error || ''),
    tG2.state + ' / ' + tG2.error);

  /* ---------- [H] 错误路径 ---------- */
  console.log('\n[H] 错误路径');

  const dirH = path.join(tmpRoot, 'h');
  await fsp.mkdir(dirH, { recursive: true });
  const { mgr: mgrH } = mkManager(dirH, { threads: 4 });
  const tH = await download(mgrH, `${base}/404`, { filename: 'nope.bin' });
  check('404 落到 error 状态', tH.state === 'error', tH.state);
  check('错误信息含状态码', /404/.test(tH.error || ''), tH.error);

  /* ---------- [I] 取消 ---------- */
  console.log('\n[I] 取消');

  const dirI = path.join(tmpRoot, 'i');
  await fsp.mkdir(dirI, { recursive: true });
  const { mgr: mgrI } = mkManager(dirI, { threads: 4 });
  const idI = mgrI.enqueue({ url: `${base}/slow.bin`, filename: 'cancel.bin' });
  const tI = mgrI.get(idI);
  await waitFor(tI, ['downloading']);
  await sleep(80);
  const beforeI = stats.requests;
  await mgrI.cancel(idI);
  await sleep(200);

  check('取消后状态为 canceled', tI.state === 'canceled', tI.state);
  check('半成品文件被清掉', !fs.existsSync(tI.savePath));
  check('sidecar 被清掉', !fs.existsSync(tI.savePath + '.novadl.json'));
  check('取消后不再有新请求', stats.requests - beforeI <= 1, `多了 ${stats.requests - beforeI}`);

  /* ---------- [J] 并发上限与队列 ---------- */
  console.log('\n[J] 并发上限');

  const dirJ = path.join(tmpRoot, 'j');
  await fsp.mkdir(dirJ, { recursive: true });
  const { mgr: mgrJ } = mkManager(dirJ, { threads: 2, maxConcurrent: 2 });
  const idsJ = ['j1.bin', 'j2.bin', 'j3.bin'].map((f) => mgrJ.enqueue({ url: `${base}/slow.bin`, filename: f }));
  await sleep(150);
  const activeJ = mgrJ.list().filter((t) => t.state === 'downloading' || t.state === 'probing').length;
  check('同时进行的任务不超过 maxConcurrent', activeJ <= 2, `实际 ${activeJ}`);
  check('第三个任务在排队', mgrJ.get(idsJ[2]).state === 'queued', mgrJ.get(idsJ[2]).state);
  for (const id of idsJ) await waitFor(mgrJ.get(id), ['done', 'error']);
  check('三个任务最终都完成', idsJ.every((id) => mgrJ.get(id).state === 'done'),
    idsJ.map((id) => mgrJ.get(id).state).join(','));

  /* ---------- [K] 文件名与不重名 ---------- */
  console.log('\n[K] 文件名解析与重名规避');

  const dirK = path.join(tmpRoot, 'k');
  await fsp.mkdir(dirK, { recursive: true });
  const { mgr: mgrK } = mkManager(dirK, { threads: 2 });
  const tK = await download(mgrK, `${base}/disposition`);
  check('采用服务端给的中文文件名', tK.filename === '中文名.zip', tK.filename);
  check('落盘用该文件名', path.basename(tK.savePath) === '中文名.zip', path.basename(tK.savePath));

  const { mgr: mgrK2 } = mkManager(dirK, { threads: 2 });
  const tK2 = await download(mgrK2, `${base}/disposition`);
  check('同名时自动改名而不覆盖', path.basename(tK2.savePath) === '中文名 (1).zip', path.basename(tK2.savePath));
  check('第一个文件仍在', fs.existsSync(tK.savePath));

  /* ---------- [L] 速度与 ETA ---------- */
  console.log('\n[L] 速度与 ETA');

  const dirL = path.join(tmpRoot, 'l');
  await fsp.mkdir(dirL, { recursive: true });
  const { mgr: mgrL, updates: upL } = mkManager(dirL, { threads: 4 });
  const tL = await download(mgrL, `${base}/big.bin`, { filename: 'speed.bin' });
  const withSpeed = upL.filter((u) => u.state === 'downloading' && u.speed > 0);
  check('过程中报出过速度', withSpeed.length > 0, withSpeed.length ? human(withSpeed[0].speed) + '/s' : '无');
  check('进度单调不减', upL.filter((u) => u.state === 'downloading')
    .every((u, i, a) => i === 0 || u.received >= a[i - 1].received));
  check('进度值落在 [0,1]', upL.every((u) => u.progress >= 0 && u.progress <= 1));
  check('分片快照带 size/done/state', tL.snapshot().chunks.every((c) => c.size > 0 && c.done >= 0 && c.state));

  /* ---------- [M] 管理器聚合 ---------- */
  console.log('\n[M] 管理器聚合与持久化快照');

  const st = mgrL.stats();
  check('stats 能给出完成数', st.done >= 1, JSON.stringify(st));
  const persisted = mgrL.persistable();
  check('persistable 不含分片明细（设置文件不该被撑爆）',
    persisted.every((p) => !('chunks' in p)));
  check('persistable 保留续传所需字段',
    persisted.every((p) => 'id' in p && 'savePath' in p && 'state' in p && 'url' in p));

  const { mgr: mgrM } = mkManager(path.join(tmpRoot, 'm'), { threads: 2 });
  const adopted = mgrM.adopt([
    { id: 'a1', url: 'http://x/a.bin', filename: 'a.bin', state: 'downloading', total: 100, received: 40 },
    { id: 'a2', url: 'http://x/b.bin', filename: 'b.bin', state: 'done', total: 200, received: 200 }
  ]);
  check('恢复未完成任务时标为 paused（等用户点继续）',
    adopted.find((t) => t.id === 'a1').state === 'paused');
  check('已完成的任务保持 done', adopted.find((t) => t.id === 'a2').state === 'done');

  /* ---------- 收尾 ---------- */
  await mgrB.shutdown(); await mgrC.shutdown(); await mgrD.shutdown();
  await mgrE.shutdown(); await mgrF.shutdown(); await mgrK.shutdown();
  await mgrL.shutdown(); await mgrJ.shutdown();
  await new Promise((r) => server.close(r));
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n测试自身崩了：', err);
  process.exit(2);
});
