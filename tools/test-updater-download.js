'use strict';
/**
 * 自研更新下载器的测试
 * 用法：node tools/test-updater-download.js
 *
 * 这里测的是**下载与安装**那一段（updater.js 的 download / downloadTo /
 * sha256File / installAndRestart）。它取代了 electron-updater，
 * 所以「重定向跟随」「sha256 校验」「下过的不重下」这三件事必须钉住 ——
 * 每一条出错都不是「多等一会儿」，而是「更新装不上」或者「装了个坏包」。
 *
 * 用本地 http 服务造真实响应（含 302），不打外网。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const U = require(path.join(__dirname, '..', 'src', 'main', 'updater.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 起一个本地 http 服务。routes: { '/p': (req,res)=>void } */
function serve(routes) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const fn = routes[req.url.split('?')[0]];
      if (fn) return fn(req, res);
      res.statusCode = 404;
      res.end('nope');
    });
    s.listen(0, '127.0.0.1', () => resolve({
      url: 'http://127.0.0.1:' + s.address().port,
      stop: () => new Promise((r) => s.close(r))
    }));
  });
}

/** 保证每次跑用的文件名都不同，免得撞上上一次留下的缓存 */
const stamp = Date.now();
const updatesDir = U.updatesDir();

(async () => {
  console.log('\n[A] 小工具');

  check('fileNameOf 从地址里取文件名',
    U.fileNameOf('https://a.test/dir/nova-pc-1.0.9-win-x64-setup.exe', 'x') === 'nova-pc-1.0.9-win-x64-setup.exe');
  check('fileNameOf 会解码百分号转义',
    U.fileNameOf('https://a.test/%E5%90%BE%E7%88%B1Nova.exe', 'x') === '吾爱Nova.exe');
  check('fileNameOf 取不到时给兜底名',
    U.fileNameOf('not a url', 'fallback.exe') === 'fallback.exe');

  // sha256File：流式算的，结果必须与一次性算的一致（78MB 时这条保证才有意义）
  {
    const f = path.join(os.tmpdir(), `nova-sha-${stamp}.bin`);
    const buf = crypto.randomBytes(256 * 1024);
    fs.writeFileSync(f, buf);
    const got = await U.sha256File(f);
    fs.unlinkSync(f);
    check('sha256File 与一次性算的 sha256 一致', got === sha256(buf));
  }

  console.log('\n[B] downloadTo：跟随重定向');

  {
    const body = crypto.randomBytes(200 * 1024);
    const srv = await serve({
      '/real': (req, res) => {
        res.setHeader('content-length', String(body.length));
        res.end(body);
      },
      // 两级跳转 —— Gitee 的下载地址就是先 302 到 CDN
      '/a': (req, res) => { res.statusCode = 302; res.setHeader('location', '/b'); res.end(); },
      '/b': (req, res) => { res.statusCode = 302; res.setHeader('location', '/real'); res.end(); }
    });
    const dest = path.join(os.tmpdir(), `nova-dl-${stamp}.bin`);
    const ticks = [];
    const r = await U.downloadTo(srv.url + '/a', dest, {
      onProgress: (p) => ticks.push(p)
    });
    await srv.stop();
    check('两级重定向后拿到了完整内容', fs.readFileSync(dest).equals(body), r.got + ' 字节');
    check('有进度回调', ticks.length > 0, JSON.stringify(ticks[ticks.length - 1]));
    check('最后一次进度是 100%', ticks[ticks.length - 1].percent === 100);
    fs.unlinkSync(dest);
  }

  {
    const srv = await serve({});
    let err = '';
    try {
      await U.downloadTo(srv.url + '/missing', path.join(os.tmpdir(), `nova-404-${stamp}.bin`), {});
    } catch (e) { err = e.message; }
    await srv.stop();
    check('HTTP 404 会 reject 并说清状态码', /HTTP 404/.test(err), err);
  }

  {
    // 重定向成环：必须自己停下来，不能无限追
    const srv = await serve({
      '/loop': (req, res) => { res.statusCode = 302; res.setHeader('location', '/loop'); res.end(); }
    });
    let err = '';
    try {
      await U.downloadTo(srv.url + '/loop', path.join(os.tmpdir(), `nova-loop-${stamp}.bin`), {});
    } catch (e) { err = e.message; }
    await srv.stop();
    check('重定向成环时会放弃并报错', /重定向/.test(err), err);
  }

  console.log('\n[C] download：校验与复用');

  {
    // 主用例：地址直接指向服务上的文件
    const body = Buffer.from('fake-installer-body-' + stamp);
    const name = `nova-pc-1.0.9-good-${stamp}.exe`;
    const srv = await serve({
      ['/' + name]: (req, res) => {
        res.setHeader('content-length', String(body.length));
        res.end(body);
      }
    });
    const info = { url: srv.url + '/' + name, size: body.length, sha256: sha256(body), version: '1.0.9' };

    const r1 = await U.download({ info }, {});
    check('下好了，路径就在 updates 目录里',
      fs.existsSync(r1.path) && r1.path.indexOf('updates') >= 0, r1.path);
    check('内容与源一致', fs.readFileSync(r1.path).equals(body));
    check('第一次算「新下的」，不是复用', r1.reused === false);
    check('没有留下 .part 半成品', !fs.existsSync(r1.path + '.part'));

    // 复用的关键一步：**把服务关掉**再下一次 ——
    // 如果它还是去联网，这里必然失败；能过就证明真的走了本地那份
    await srv.stop();
    const r2 = await U.download({ info }, {});
    check('下过且哈希对得上时不再联网重下（服务已关仍成功）', r2.reused === true);
    check('复用返回的是同一个文件', r2.path === r1.path);
    fs.unlinkSync(r1.path);
  }

  {
    // 哈希不符：必须**丢掉**，不能留下半个坏包冒充下好的
    const body = Buffer.from('tampered-' + stamp);
    const name = `nova-pc-1.0.9-bad-${stamp}.exe`;
    const srv = await serve({
      ['/' + name]: (req, res) => {
        res.setHeader('content-length', String(body.length));
        res.end(body);
      }
    });
    const info = {
      url: srv.url + '/' + name,
      size: body.length,
      sha256: sha256(Buffer.from('完全不是这个内容')),   // 故意对不上
      version: '1.0.9'
    };
    let err = '';
    try { await U.download({ info }, {}); } catch (e) { err = e.message; }
    await srv.stop();
    check('哈希不符时抛错', /校验不通过/.test(err), err);
    check('哈希不符时不留残包',
      !fs.existsSync(path.join(updatesDir, name)) && !fs.existsSync(path.join(updatesDir, name + '.part')));
  }

  {
    // 没有 url 时要说清原因，不能抛一个 undefined 的错
    let err = '';
    try { await U.download({ info: {} }, {}); } catch (e) { err = e.message; }
    check('没有可下载地址时报「没有可下载的地址」', /没有可下载的地址/.test(err), err);
  }

  console.log('\n[D] updates 目录不会越攒越大');

  {
    /* 一个安装包 78 MB。不清的话每更新一版就多留一个 —— 十版之后用户
     * AppData 里躺着 780 MB 他自己看不到、也清不掉的东西。
     * 这里用假文件验行为，不占空间。 */
    const keep = path.join(updatesDir, `nova-pc-keep-${stamp}.exe`);
    const old1 = path.join(updatesDir, `nova-pc-old1-${stamp}.exe`);
    const old2 = path.join(updatesDir, `nova-pc-old2-${stamp}.exe`);
    const stray = path.join(updatesDir, `nova-pc-half-${stamp}.exe.part`);
    const other = path.join(updatesDir, `用户自己放的东西-${stamp}.txt`);
    fs.mkdirSync(updatesDir, { recursive: true });
    for (const f of [keep, old1, old2, stray, other]) fs.writeFileSync(f, 'x');

    const n = U.pruneOldInstallers(keep);
    check('清掉了旧安装包', !fs.existsSync(old1) && !fs.existsSync(old2), '清了 ' + n + ' 个');
    check('清掉了 .part 半成品', !fs.existsSync(stray));
    check('**当前这一份要留着**（装完之前用户可能还要再点一次「重启并安装」）',
      fs.existsSync(keep));
    check('不碰非安装包的文件（这个目录里若混进别的东西不该被误删）',
      fs.existsSync(other), path.basename(other));
    fs.unlinkSync(keep);
    fs.unlinkSync(other);
  }

  console.log('\n[E] installAndRestart：装不起来时要如实说');
  {
    const r = U.installAndRestart({});
    check('还没有安装包时返回 ok:false',
      r.ok === false && /还没有下载好的安装包/.test(r.error || ''), r.error);
  }
  {
    const r = U.installAndRestart({ installerPath: path.join(os.tmpdir(), `nope-${stamp}.exe`) });
    check('安装包不见了时返回 ok:false 并提示重新下载',
      r.ok === false && /不见了/.test(r.error || ''), r.error);
  }
  {
    // 纯 Node 下没有 Electron app —— 要返回 ok:false，不能抛
    const f = path.join(os.tmpdir(), `nova-fake-${stamp}.exe`);
    fs.writeFileSync(f, 'x');
    const r = U.installAndRestart({ installerPath: f });
    fs.unlinkSync(f);
    check('非 Electron 环境下返回 ok:false 而不是抛异常',
      r.ok === false && /不支持自动安装/.test(r.error || ''), r.error);
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
