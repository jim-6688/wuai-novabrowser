'use strict';

/**
 * 吾爱Nova浏览器 · 多线程下载引擎
 * ---------------------------------------------------------------------------
 * Chromium 自带的下载器是单连接流式——一个 TCP 连接从头读到尾，带宽上限就是
 * 单连接的带宽。本模块用 HTTP Range 把同一个文件切成 N 段，并发拉取，
 * 每段各自 seek 到文件对应偏移写入，从而把多条连接的带宽叠加起来。
 *
 * 设计要点（都是踩过的坑）：
 *   1. 用「真实发一个 Range 请求看是否回 206」来判定服务端是否支持分片，
 *      而不是只看 Accept-Ranges 头——后者经常缺失但服务端其实支持。
 *   2. 必须带 Accept-Encoding: identity。一旦服务端 gzip，Content-Length
 *      就不是文件真实大小，Range 偏移也会错位。
 *   3. 进度按「分片内游标」而不是「本次已经收了多少字节」记录，
 *      这样分片中途断线重试、以及暂停后续传，都只需要重取剩余区间。
 *   4. 服务端不支持 Range 时不是报错，而是退化成单连接顺序流，
 *      并且靠「丢弃前 cursor 个字节」依然能续传。
 *
 * 本文件不 require electron，也不碰任何全局状态，因此可以在普通 Node 进程里
 * 起一个本地 HTTP 服务器直接跑集成测试（见 tools/test-downloader.js）。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');

const MAX_REDIRECTS = 6;
/** 单个分片断线后的重试次数（重试会从分片内游标继续，不会重头下） */
const MAX_RETRY = 3;
/** 小于这个尺寸就不值得再切了，分片太碎反而拖慢 */
const MIN_CHUNK_BYTES = 256 * 1024;
const MAX_THREADS = 16;
/** 进度推送节流，避免高频 IPC 把渲染层打爆 */
const EMIT_INTERVAL_MS = 120;
/** 测速采样窗口 */
const SPEED_WINDOW_MS = 4000;

const STATES = ['queued', 'probing', 'downloading', 'paused', 'done', 'error', 'canceled'];
const ACTIVE_STATES = new Set(['probing', 'downloading']);

/* ------------------------------------------------------------------ *
 * 纯函数工具（可独立测试）
 * ------------------------------------------------------------------ */

/** 从 `bytes 0-1023/4096` 里解出总长度；解不出返回 -1 */
function parseContentRange(value) {
  if (!value) return -1;
  const m = /\/(\d+)\s*$/.exec(String(value));
  return m ? Number(m[1]) : -1;
}

/** 把 [0,total) 切成 n 段；返回每段的起止与游标 */
function planChunks(total, threads, minChunk = MIN_CHUNK_BYTES) {
  if (!Number.isFinite(total) || total <= 0) return [];
  const n = Math.max(1, Math.min(Number(threads) || 1, MAX_THREADS, Math.floor(total / minChunk) || 1));
  const size = Math.floor(total / n);
  const out = [];
  for (let i = 0; i < n; i++) {
    const start = i * size;
    const end = i === n - 1 ? total - 1 : start + size - 1;
    out.push({ index: i, start, end, cursor: start, state: 'pending', connections: 0 });
  }
  return out;
}

/** Windows 不允许的字符 + 控制字符一律换成下划线，并掐掉长度 */
function sanitizeName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+$/, '')
    .trim();
  return cleaned.slice(0, 180);
}

/** RFC 5987 的 filename*=UTF-8''… 与普通 filename= 都认 */
function filenameFromDisposition(cd) {
  if (!cd) return '';
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (star) {
    try {
      const v = decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
      if (v) return v;
    } catch { /* 编码坏了就退回普通字段 */ }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(cd);
  return plain ? (plain[1] || plain[2] || '').trim() : '';
}

/** 从 URL 末段推文件名；推不出来就叫 download */
function filenameFromUrl(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(seg);
  } catch {
    return '';
  }
}

/** 目录里已有同名文件时改叫 `名字 (1).ext` */
function uniquePath(dir, filename) {
  const ext = require('path').extname(filename);
  const stem = filename.slice(0, filename.length - ext.length) || 'download';
  let candidate = require('path').join(dir, filename);
  for (let i = 1; fs.existsSync(candidate) && i < 9999; i++) {
    candidate = require('path').join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * HTTP 基础
 * ------------------------------------------------------------------ */

function requestOnce(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {}
    }, (res) => resolve({ req, res, url: u }));

    const onAbort = () => req.destroy(new Error('已取消'));
    if (opts.signal) {
      if (opts.signal.aborted) { req.destroy(new Error('已取消')); return; }
      opts.signal.addEventListener('abort', onAbort, { once: true });
      req.once('close', () => opts.signal.removeEventListener('abort', onAbort));
    }

    req.on('error', reject);
    req.end();
  });
}

/**
 * 发一个请求并手动跟随重定向。
 * 之所以不交给 http 自动处理，是因为我们要在最终 URL 上重新探测 Range，
 * 而且换主机时必须把 Cookie 摘掉——不然就是把 A 站的凭证递给 B 站。
 */
async function openUrl(url, opts, originHost = null, depth = 0) {
  const u = new URL(url);
  const host = originHost === null ? u.host : originHost;

  let headers = opts.headers || {};
  if (u.host !== host && headers.Cookie) {
    headers = Object.assign({}, headers);
    delete headers.Cookie;
  }

  const { req, res } = await requestOnce(url, Object.assign({}, opts, { headers }));
  const status = res.statusCode;

  if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
    if (depth >= MAX_REDIRECTS) {
      res.destroy();
      throw new Error('重定向层数过多');
    }
    res.resume();
    const next = new URL(res.headers.location, url).toString();
    return openUrl(next, opts, host, depth + 1);
  }

  return { req, res, status, headers: res.headers, finalUrl: url };
}

/* ------------------------------------------------------------------ *
 * 单个下载任务
 * ------------------------------------------------------------------ */

let seq = 0;

class DownloadTask {
  constructor(opts, ctx) {
    this.id = opts.id || `dl_${Date.now().toString(36)}_${(++seq).toString(36)}`;
    this.url = opts.url;
    this.filename = opts.filename || '';
    this.dir = opts.dir || ctx.dir;
    this.savePath = opts.savePath || '';
    this.engineId = opts.engineId || null;
    this.requestedThreads = Number(opts.threads || ctx.threads || 8);

    this.state = 'queued';
    this.total = -1;
    this.received = 0;
    this.ranged = false;
    this.connections = 0;
    this.chunks = [];
    this.error = null;
    this.createdAt = Date.now();
    this.startedAt = 0;
    this.endedAt = 0;
    this.bytesThisRun = 0;
    this.samples = [];
    this.mime = '';
    this.finalUrl = '';
    this.fromSnapshot = !!opts.fromSnapshot;
    /** 供 UI 判断「这个任务是本引擎接管的还是 Chromium 自己下的」 */
    this.source = opts.source || 'nova';

    this.ctx = ctx;
    this.fh = null;
    this.workers = [];
    this.controller = new AbortController();
    this.lastEmit = 0;
    this.pauseRequested = false;
    this.cancelRequested = false;
    this.fatal = null;
  }

  get aborting() { return this.controller.signal.aborted; }

  /** 速度采样：只记 (时间, 累计字节)，渲染时再算斜率 */
  tick() {
    const now = Date.now();
    this.samples.push({ t: now, bytes: this.received });
    const cutoff = now - SPEED_WINDOW_MS;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
    if (now - this.lastEmit >= EMIT_INTERVAL_MS) {
      this.lastEmit = now;
      this.ctx.onUpdate(this.snapshot());
    }
  }

  speed() {
    const s = this.samples;
    if (s.length < 2) return 0;
    const dt = (s[s.length - 1].t - s[0].t) / 1000;
    if (dt <= 0) return 0;
    return Math.max(0, Math.round((s[s.length - 1].bytes - s[0].bytes) / dt));
  }

  snapshot() {
    const sp = this.state === 'downloading' ? this.speed() : 0;
    const remain = this.total > 0 ? Math.max(0, this.total - this.received) : -1;
    return {
      id: this.id,
      url: this.url,
      finalUrl: this.finalUrl || this.url,
      filename: this.filename || filenameFromUrl(this.url) || 'download',
      savePath: this.savePath,
      dir: this.dir,
      engineId: this.engineId,
      source: this.source,
      state: this.state,
      error: this.error,
      total: this.total,
      received: this.received,
      progress: this.total > 0 ? Math.min(1, this.received / this.total) : 0,
      speed: sp,
      eta: sp > 0 && remain > 0 ? Math.round(remain / sp) : -1,
      /** 服务端不支持 Range 时这里是 1，界面上要如实显示「单连接」 */
      threads: this.ranged ? Math.max(1, this.chunks.length) : 1,
      requestedThreads: this.requestedThreads,
      ranged: this.ranged,
      connections: this.connections,
      mime: this.mime,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      chunks: this.chunks.map((c) => {
        const size = c.end >= c.start ? c.end - c.start + 1 : 0;
        const done = Math.max(0, c.cursor - c.start);
        return {
          index: c.index,
          start: c.start,
          end: c.end,
          size,
          done,
          state: c.state,
          progress: size > 0 ? Math.min(1, done / size) : 0
        };
      })
    };
  }

  /* --- sidecar：跨重启续传靠它，成功或取消后删掉 --- */

  get sidecarPath() { return this.savePath ? this.savePath + '.novadl.json' : ''; }

  async writeSidecar() {
    if (!this.sidecarPath || !this.savePath) return;
    const data = {
      v: 1,
      id: this.id,
      url: this.url,
      finalUrl: this.finalUrl,
      filename: this.filename,
      savePath: this.savePath,
      total: this.total,
      ranged: this.ranged,
      received: this.received,
      mime: this.mime,
      chunks: this.chunks.map((c) => ({ index: c.index, start: c.start, end: c.end, cursor: c.cursor }))
    };
    try {
      await fsp.writeFile(this.sidecarPath, JSON.stringify(data, null, 2), 'utf8');
    } catch { /* 写不了就算了，不影响已下的数据 */ }
  }

  async readSidecar() {
    if (!this.sidecarPath) return null;
    try {
      const raw = JSON.parse(await fsp.readFile(this.sidecarPath, 'utf8'));
      if (raw && raw.v === 1 && raw.url === this.url) return raw;
    } catch { /* 没有或坏了 */ }
    return null;
  }

  async dropSidecar() {
    if (!this.sidecarPath) return;
    try { await fsp.unlink(this.sidecarPath); } catch { /* 本来就不在 */ }
  }

  /* --- 生命周期 --- */

  /**
   * 探针：发一个 `Range: bytes=0-0` 看服务端怎么答。
   *   206 + Content-Range → 支持分片，且能拿到真实总长度
   *   200                → 不支持分片，退化单连接（Content-Length 只作展示）
   */
  async probe(sidecar) {
    if (sidecar && sidecar.total > 0) {
      // 有 sidecar 就不重复探测，直接按上次的结论恢复
      this.total = sidecar.total;
      this.ranged = !!sidecar.ranged;
      this.mime = sidecar.mime || '';
      this.finalUrl = sidecar.finalUrl || this.url;
      this.chunks = (sidecar.chunks || []).map((c) => ({
        index: c.index, start: c.start, end: c.end, cursor: c.cursor,
        state: 'pending', connections: 0
      }));
      this.received = this.chunks.reduce((a, c) => a + Math.max(0, c.cursor - c.start), 0);
      if (!this.ranged && !this.chunks.length) {
        this.chunks = [{ index: 0, start: 0, end: null, cursor: sidecar.received || 0, state: 'pending', connections: 0 }];
      }
      return;
    }

    const headers = Object.assign({}, await this.ctx.headersFor(this.url, this.engineId), { Range: 'bytes=0-0' });
    const { res, status, headers: h, finalUrl } = await openUrl(this.url, { headers, signal: this.controller.signal });
    this.finalUrl = finalUrl;
    this.mime = h['content-type'] || '';

    if (status === 206) {
      this.ranged = true;
      this.total = parseContentRange(h['content-range']);
      if (!(this.total > 0)) this.ranged = false; // Content-Range 不合法，不敢按它切
    } else if (status === 200) {
      this.ranged = false;
      const len = Number(h['content-length']);
      this.total = Number.isFinite(len) && len > 0 ? len : -1;
    } else {
      res.destroy();
      throw new Error(`HTTP ${status}`);
    }
    res.destroy();

    // 文件名：服务端给的 Content-Disposition 优先
    const disp = filenameFromDisposition(h['content-disposition']);
    if (!this.filename) this.filename = sanitizeName(disp) || sanitizeName(filenameFromUrl(finalUrl)) || 'download';
    else this.filename = sanitizeName(this.filename);

    this.chunks = this.ranged
      ? planChunks(this.total, this.requestedThreads)
      : [{ index: 0, start: 0, end: null, cursor: 0, state: 'pending', connections: 0 }];
  }

  async openFile() {
    const exists = fs.existsSync(this.savePath);
    this.fh = await fsp.open(this.savePath, exists ? 'r+' : 'w+');
    // 预先占位到总长度，这样各分片可以直接按偏移写，不必排队等前面写完
    if (this.ranged && this.total > 0) await this.fh.truncate(this.total);
  }

  async closeFile() {
    if (!this.fh) return;
    const fh = this.fh;
    this.fh = null;
    try { await fh.close(); } catch { /* 已经关了 */ }
  }

  pause() {
    if (!ACTIVE_STATES.has(this.state) && this.state !== 'queued') return false;
    this.pauseRequested = true;
    if (this.state === 'queued') {
      // 还没开跑，直接从排队里摘出来
      this.state = 'paused';
      this.ctx.onUpdate(this.snapshot());
      this.ctx.pump();
      return true;
    }
    this.controller.abort();
    return true;
  }

  resume() {
    if (!['paused', 'error', 'canceled'].includes(this.state)) return false;
    this.pauseRequested = false;
    this.cancelRequested = false;
    this.error = null;
    this.fatal = null;
    this.controller = new AbortController();
    this.state = 'queued';
    this.ctx.enqueueRun(this);
    this.ctx.onUpdate(this.snapshot());
    return true;
  }

  async cancel() {
    this.cancelRequested = true;
    if (ACTIVE_STATES.has(this.state)) {
      this.controller.abort();
      return true; // 由 run() 的收尾统一处理
    }
    this.state = 'canceled';
    this.endedAt = Date.now();
    await this.cleanupPartial();
    this.ctx.onUpdate(this.snapshot());
    return true;
  }

  /** 取消 = 连半成品一起删掉，不留垃圾在下载目录里 */
  async cleanupPartial() {
    await this.closeFile();
    if (this.savePath) { try { await fsp.unlink(this.savePath); } catch { /* 没有就没有 */ } }
    await this.dropSidecar();
  }

  async run() {
    this.state = 'probing';
    this.startedAt = this.startedAt || Date.now();
    this.ctx.onUpdate(this.snapshot());

    try {
      // 1) 已有保存路径说明是续传/恢复，先看看 sidecar 还在不在
      const sidecar = this.savePath ? await this.readSidecar() : null;
      if (this.cancelRequested) { await this.settle(); return; }

      // 2) 探测：拿到总长度、是否支持分片、以及服务端给的文件名
      await this.probe(sidecar);
      if (!this.filename) this.filename = sanitizeName(filenameFromUrl(this.finalUrl)) || 'download';

      // 3) 还没定路径就现在定（挑一个不重名的）
      if (!this.savePath) this.savePath = uniquePath(this.dir, this.filename);

      // 4) 打开文件：r+ 保留已下部分，w+ 新建
      await this.openFile();

      this.state = 'downloading';
      this.bytesThisRun = 0;
      this.samples = [{ t: Date.now(), bytes: this.received }];
      this.ctx.onUpdate(this.snapshot());

      // 5) 并发拉取
      this.workers = this.chunks
        .filter((c) => c.end === null || c.cursor <= c.end)
        .map((c) => this.runChunk(c)
          .then(() => { c.state = 'done'; })
          .catch((err) => {
            if (!this.aborting && !this.fatal) this.fatal = err;
            throw err;
          }));

      await Promise.allSettled(this.workers);
      await this.settle();
    } catch (err) {
      this.fatal = this.fatal || err;
      await this.settle();
    } finally {
      this.workers = [];
    }
  }

  /** 所有分片都停下之后，只有这一个地方决定最终状态 */
  async settle() {
    // 注意：状态一律在收尾动作（关文件 / 落盘 sidecar / 删半成品）之后才发布，
    // 否则外部看到 done 的时候文件可能还没落完，会读到半截数据。
    if (this.cancelRequested) {
      this.endedAt = Date.now();
      await this.cleanupPartial();
      this.state = 'canceled';
      this.ctx.onUpdate(this.snapshot());
      this.ctx.pump();
      return;
    }

    if (this.pauseRequested) {
      this.endedAt = Date.now();
      await this.closeFile();
      await this.writeSidecar();
      this.state = 'paused';
      this.ctx.onUpdate(this.snapshot());
      this.ctx.pump();
      return;
    }

    if (this.fatal) {
      this.error = this.fatal.message || String(this.fatal);
      this.endedAt = Date.now();
      await this.closeFile();
      await this.writeSidecar(); // 保留进度，用户点「重试」能接着下
      this.state = 'error';
      this.ctx.onUpdate(this.snapshot());
      this.ctx.pump();
      return;
    }

    // 完整性校验：声明了总长度就必须一分不差
    let finalSize = -1;
    try { finalSize = (await fsp.stat(this.savePath)).size; } catch { /* noop */ }
    if (this.ranged && this.total > 0 && finalSize !== this.total) {
      this.error = `完整性校验失败：期望 ${this.total} 字节，实际 ${finalSize} 字节`;
      this.endedAt = Date.now();
      await this.closeFile();
      await this.writeSidecar();
      this.state = 'error';
      this.ctx.onUpdate(this.snapshot());
      this.ctx.pump();
      return;
    }

    if (finalSize >= 0) this.received = finalSize;
    this.endedAt = Date.now();
    await this.closeFile();
    await this.dropSidecar();
    this.state = 'done';
    this.ctx.onUpdate(this.snapshot());
    this.ctx.pump();
  }

  /** 一个分片的完整生命周期：断线就从分片内游标接着来 */
  async runChunk(chunk) {
    let attempt = 0;
    chunk.state = 'active';

    while (chunk.end === null || chunk.cursor <= chunk.end) {
      if (this.aborting) throw new Error('已中止');
      try {
        const headers = Object.assign({}, await this.ctx.headersFor(this.url, this.engineId));
        if (this.ranged && chunk.end !== null) {
          headers.Range = `bytes=${chunk.cursor}-${chunk.end}`;
        } else if (!this.ranged && chunk.cursor > 0) {
          // 服务端不支持 Range，续传只能整段重来再把前面弃掉
          headers.Range = `bytes=${chunk.cursor}-`;
        }

        const { res, status } = await openUrl(this.url, { headers, signal: this.controller.signal });
        this.connections += 1;
        chunk.connections += 1;

        if (status >= 400) { res.destroy(); throw new Error(`HTTP ${status}`); }

        let skip = 0;
        let limit = null;

        if (this.ranged && chunk.end !== null) {
          if (status === 206) {
            skip = 0;
          } else if (status === 200) {
            // 探测时答应得好好的，这会儿又不认 Range 了 —— 那就自己跳过
            skip = chunk.cursor;
          } else {
            res.destroy();
            throw new Error(`分片请求返回 HTTP ${status}`);
          }
          limit = chunk.end - chunk.cursor + 1;
        } else if (status === 206) {
          // 反向情况：本来判定不支持分片，续传时带了 `bytes=N-` 结果服务端认了。
          // 206 的响应体本来就从 N 开始，所以既不要额外跳过、也绝不能把游标倒回去
          // —— 倒回去会把这段数据写到文件开头，整份文件就毁了。
          skip = 0;
        } else {
          skip = chunk.cursor;
        }

        await pumpToFile(this, chunk, res, { skip, limit });

        if (chunk.end !== null && chunk.cursor > chunk.end) break;
        if (chunk.end === null) break;
      } catch (err) {
        if (this.aborting || this.pauseRequested || this.cancelRequested) throw err;
        if (attempt >= MAX_RETRY) throw new Error(`${err.message}（已重试 ${MAX_RETRY} 次）`);
        attempt += 1;
        await delay(300 * attempt);
      }
    }
  }
}

/**
 * 把响应体写进文件。
 * 每一片都先 pause 流、写盘完成再 resume —— 这就是手写的背压，
 * 否则高带宽下 'data' 事件会把内存顶爆。
 */
function pumpToFile(task, chunk, res, opts) {
  return new Promise((resolve, reject) => {
    let skip = opts.skip || 0;
    let limit = opts.limit === null || opts.limit === undefined ? null : opts.limit;
    let chain = Promise.resolve();
    let settled = false;

    const ok = () => { if (!settled) { settled = true; resolve(); } };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { res.destroy(); } catch { /* noop */ }
      reject(err);
    };

    res.on('data', (buf) => {
      res.pause();
      chain = chain.then(async () => {
        let b = buf;
        if (skip > 0) {
          const n = Math.min(skip, b.length);
          skip -= n;
          b = b.subarray(n);
        }
        if (limit !== null) {
          if (b.length > limit) b = b.subarray(0, limit);
          limit -= b.length;
        }
        if (b.length) {
          await task.fh.write(b, 0, b.length, chunk.cursor);
          chunk.cursor += b.length;
          task.received += b.length;
          task.bytesThisRun += b.length;
          task.tick();
        }
      }).then(() => {
        if (limit !== null && limit <= 0) {
          try { res.destroy(); } catch { /* noop */ }
          ok();
          return;
        }
        res.resume();
      }, fail);
    });

    res.on('end', () => { chain.then(ok, fail); });
    res.on('error', fail);
    // 对端提前断开时 'end' 不会来，只能靠 complete 判定
    res.on('close', () => {
      if (res.complete) return;
      chain.then(() => fail(new Error('连接被对端提前中断')), fail);
    });
  });
}

/* ------------------------------------------------------------------ *
 * 任务管理
 * ------------------------------------------------------------------ */

class DownloadManager {
  /**
   * @param {object} opts
   *   dir          —— 默认下载目录
   *   threads      —— 单任务默认线程数
   *   maxConcurrent—— 同时进行的任务数上限
   *   onUpdate     —— (snapshot) => void
   *   headersFor   —— async (url, engineId) => 请求头（Cookie/UA/Referer 由主进程从对应 session 取）
   */
  constructor(opts = {}) {
    this.dir = opts.dir || process.cwd();
    this.threads = opts.threads || 8;
    this.maxConcurrent = opts.maxConcurrent || 3;
    this.onUpdate = opts.onUpdate || (() => {});
    this.headersFor = opts.headersFor || (async () => ({}));
    this.tasks = new Map();
    this.queue = [];
  }

  configure(partial = {}) {
    if (partial.dir) this.dir = partial.dir;
    if (partial.threads) this.threads = partial.threads;
    if (partial.maxConcurrent) this.maxConcurrent = partial.maxConcurrent;
  }

  enqueue(opts) {
    const task = new DownloadTask(opts, {
      dir: this.dir,
      threads: this.threads,
      onUpdate: (s) => this.onUpdate(s),
      enqueueRun: (t) => { this.queue.push(t); this.pump(); },
      pump: () => this.pump(),
      headersFor: this.headersFor
    });
    this.tasks.set(task.id, task);
    this.queue.push(task);
    this.onUpdate(task.snapshot());
    this.pump();
    return task.id;
  }

  /** 从设置里恢复上次的任务列表；未完成的标成暂停，等用户点继续 */
  adopt(snapshots = []) {
    for (const s of snapshots) {
      if (!s || !s.id || !s.url) continue;
      const task = new DownloadTask(Object.assign({}, s, { fromSnapshot: true }), {
        dir: this.dir,
        threads: this.threads,
        onUpdate: (snap) => this.onUpdate(snap),
        enqueueRun: (t) => { this.queue.push(t); this.pump(); },
        pump: () => this.pump(),
        headersFor: this.headersFor
      });
      if (['done', 'canceled'].includes(s.state)) {
        task.state = s.state;
        task.total = s.total || -1;
        task.received = s.received || 0;
        task.filename = s.filename || '';
        task.savePath = s.savePath || '';
      } else {
        task.state = 'paused';
      }
      this.tasks.set(task.id, task);
    }
    return this.list();
  }

  get(id) { return this.tasks.get(id); }

  list() {
    return [...this.tasks.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((t) => t.snapshot());
  }

  /** 需要落盘的精简快照（分片明细在 sidecar 里，不进设置文件） */
  persistable() {
    return [...this.tasks.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 200)
      .map((t) => {
        const s = t.snapshot();
        return {
          id: s.id, url: s.url, filename: s.filename, savePath: s.savePath,
          state: s.state, total: s.total, received: s.received,
          ranged: s.ranged, engineId: s.engineId, source: s.source,
          error: s.error, createdAt: s.createdAt, endedAt: s.endedAt
        };
      });
  }

  stats() {
    let active = 0, done = 0, error = 0, speed = 0;
    for (const t of this.tasks.values()) {
      if (ACTIVE_STATES.has(t.state)) { active += 1; speed += t.speed(); }
      else if (t.state === 'done') done += 1;
      else if (t.state === 'error') error += 1;
    }
    return { active, done, error, queued: this.queue.length, speed, total: this.tasks.size };
  }

  /** 按并发上限把排队中的任务放出去 */
  pump() {
    const active = [...this.tasks.values()].filter((t) => ACTIVE_STATES.has(t.state)).length;
    let room = Math.max(0, this.maxConcurrent - active);
    for (const task of [...this.queue]) {
      if (room <= 0) break;
      if (task.state !== 'queued') continue;
      this.queue.splice(this.queue.indexOf(task), 1);
      room -= 1;
      task.run().catch((err) => {
        task.fatal = task.fatal || err;
        task.settle().catch(() => {});
      });
    }
  }

  pause(id) { const t = this.tasks.get(id); return t ? t.pause() : false; }
  resume(id) { const t = this.tasks.get(id); return t ? t.resume() : false; }

  async cancel(id) {
    const t = this.tasks.get(id);
    if (!t) return false;
    await t.cancel();
    return true;
  }

  async remove(id) {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (ACTIVE_STATES.has(t.state)) await t.cancel();
    else await t.cleanupPartial();
    this.tasks.delete(id);
    this.queue = this.queue.filter((x) => x !== t);
    this.pump();
    return true;
  }

  async removeAll({ includeDone = true } = {}) {
    for (const t of [...this.tasks.values()]) {
      if (!includeDone && !['done', 'canceled'].includes(t.state)) continue;
      await this.remove(t.id);
    }
    return this.list();
  }

  /** 重试：清掉进度从头再来（已下字节不保留，避免服务端换文件后拼出错东西） */
  async retry(id) {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (ACTIVE_STATES.has(t.state)) await t.cancel();
    t.chunks = [];
    t.received = 0;
    t.total = -1;
    t.fatal = null;
    t.error = null;
    t.bytesThisRun = 0;
    t.samples = [];
    await t.cleanupPartial();
    return t.resume();
  }

  async shutdown() {
    for (const t of this.tasks.values()) {
      if (ACTIVE_STATES.has(t.state)) {
        t.pauseRequested = true;
        t.controller.abort();
      }
    }
    await Promise.allSettled([...this.tasks.values()].map((t) => t.closeFile()));
  }
}

module.exports = {
  DownloadManager,
  DownloadTask,
  planChunks,
  parseContentRange,
  sanitizeName,
  filenameFromDisposition,
  filenameFromUrl,
  uniquePath,
  pumpToFile,
  STATES,
  MAX_THREADS,
  MIN_CHUNK_BYTES
};
