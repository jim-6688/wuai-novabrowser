'use strict';

/**
 * 下载引擎 · Electron 接线测试
 * ---------------------------------------------------------------------------
 * 用法：npm run check:downloads
 *       （即 electron --no-sandbox tools/test-downloader-electron.js）
 *
 * 为什么单独做一个：纯 Node 的集成测试（test-downloader.js）证明不了这条链路 ——
 * 它跑在普通 Node 里，没有 Electron 的 session。而「下载能不能用登录态」恰恰取决于
 * main.js 里那段 headersFor：从**对应内核的 session** 读 Cookie 再塞进请求。
 * 这段接线一旦写错，匿名能下的文件照样能下，需要登录的会静默变成 403 页面，
 * 而且 jsdom 与纯 Node 测试都发现不了。
 *
 * 本脚本不创建窗口，跑完即退；需要桌面会话（与 check:hidden 同类）。
 */

const { app, session } = require('electron');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DownloadManager } = require('../src/main/downloader');

if (!app || typeof app.whenReady !== 'function') {
  console.error('需要在 Electron 里跑：npm run check:downloads');
  process.exit(2);
}
app.disableHardwareAcceleration();

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

app.whenReady().then(async () => {
  console.log('\n[A] 主进程依赖的 Electron API');

  let dlDir = '';
  try { dlDir = app.getPath('downloads'); } catch { dlDir = ''; }
  check('app.getPath("downloads") 可用（下载目录默认值）',
    !!dlDir && path.isAbsolute(dlDir), dlDir);

  const ses = session.fromPartition('persist:nova-dltest');
  let cookies = null;
  try { cookies = await ses.cookies.get({ url: 'http://127.0.0.1/' }); } catch { cookies = null; }
  check('session.cookies.get() 可用且返回数组', Array.isArray(cookies),
    Array.isArray(cookies) ? `${cookies.length} 条` : String(cookies));

  await ses.cookies.set({ url: 'http://127.0.0.1/', name: 'nova_probe', value: 'yes' });
  const back = await ses.cookies.get({ url: 'http://127.0.0.1/' });
  check('写入的 Cookie 能读回来', back.some((c) => c.name === 'nova_probe' && c.value === 'yes'));

  console.log('\n[B] 用真实 session 当 headersFor 来源，真下载一次');

  const body = Buffer.allocUnsafe(3 * 1024 * 1024);
  for (let i = 0; i < body.length; i++) body[i] = (i * 17 + 3) & 255;

  let sawCookie = false;
  const srv = http.createServer((req, res) => {
    if (/nova_probe=yes/.test(req.headers.cookie || '')) sawCookie = true;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] === '' ? 0 : Number(m[1]);
      const end = m[2] === '' ? body.length - 1 : Math.min(Number(m[2]), body.length - 1);
      const slice = body.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Accept-Ranges': 'bytes'
      });
      return res.end(slice);
    }
    res.writeHead(200, { 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/x.bin`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-dltest-'));
  /** 与 main.js 里的 createDownloadManager().headersFor 同构 */
  const mgr = new DownloadManager({
    dir: tmp,
    threads: 4,
    onUpdate: () => {},
    headersFor: async (u) => {
      const h = { 'User-Agent': 'NovaDlTest/1.0', 'Accept-Encoding': 'identity' };
      const c = await ses.cookies.get({ url: u });
      if (c.length) h.Cookie = c.map((x) => `${x.name}=${x.value}`).join('; ');
      return h;
    }
  });

  const id = mgr.enqueue({ url, filename: 'probe.bin', source: 'page' });
  const task = mgr.get(id);
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !['done', 'error'].includes(task.state)) {
    await new Promise((r) => setTimeout(r, 50));
  }

  check('多线程下载完成', task.state === 'done',
    task.state === 'done' ? `${task.chunks.length} 分片 / ${Date.now() - t0} ms` : `${task.state} / ${task.error}`);
  check('在 Electron 的 Node 运行时里也分成了 4 片', task.chunks.length === 4, String(task.chunks.length));

  let same = false;
  try { same = sha(fs.readFileSync(task.savePath)) === sha(body); } catch { /* 文件没落盘 */ }
  check('内容 sha256 与源文件一致', same);
  check('请求确实带上了真实 session 的 Cookie（登录态下载的关键）', sawCookie);

  await mgr.shutdown();
  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  app.exit(fail ? 1 : 0);
}).catch((err) => {
  console.error('\n测试自身崩了：', err);
  app.exit(2);
});
