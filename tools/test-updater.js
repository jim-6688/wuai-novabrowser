'use strict';
/**
 * PC 端自动更新测试
 * 用法：node tools/test-updater.js
 *
 * 只测纯逻辑，不碰 Electron —— updater.js 里唯一依赖 electron 的部分
 * （autoUpdater）全部收在 configure / downloadAndInstall 里，测不到也不需要测。
 * 被测的是「拿到一份清单之后判断该不该更新」这条决策链。
 */
const path = require('path');
const http = require('http');
const assert = require('assert');

const U = require(path.join(__dirname, '..', 'src', 'main', 'updater.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

/* ---------------------------------------------------------------- 版本比对 */
console.log('\n[A] 版本号比大小');
check('同号不算更新', !U.isNewer('1.0.0', '1.0.0'));
check('补丁位更大算更新', U.isNewer('1.0.1', '1.0.0'));
check('次版本更大算更新', U.isNewer('1.1.0', '1.0.9'));
check('旧版本不算更新', !U.isNewer('1.0.0', '1.0.1'));
check('位数不同时按段比', U.isNewer('1.0.1', '1.0'));
check('第 9 到第 10 版要按数字比（1.10.0 > 1.9.0）',
  U.isNewer('1.10.0', '1.9.0') && !U.isNewer('1.9.0', '1.10.0'));
check('缺段当作 0（1.0 == 1.0.0）',
  !U.isNewer('1.0', '1.0.0') && !U.isNewer('1.0.0', '1.0'));
check('带前缀的版本号不炸', !U.isNewer(undefined, '1.0.0') && !U.isNewer('', '1.0.0'));
check('非数字段按 0 处理', U.isNewer('1.x.1', '1.0.0'));

/* ---------------------------------------------------------------- 清单判定 */
console.log('\n[B] 拿到清单之后的判断');

/**
 * 起一个本地 http 服务冒充更新源。
 *
 * <p>生产路径只走 https（更新渠道是整条链路最该守住的地方，不该为测试
 * 便利放开），所以这里把取数函数也一并注入，让被测的仍是
 * 「拿到清单之后判断该不该更新」这条真实决策链。
 */
function serveManifest(body) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      const url = `http://127.0.0.1:${p}/version.json`;
      // 与 updater 内部同形的取数函数：只做「GET 一个 JSON、回来」
      const httpGet = (u, left, finish) => {
        try {
          const req = http.get(u, (res) => {
            if (res.statusCode !== 200) { res.resume(); return finish(null); }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
              try { finish(JSON.parse(body)); } catch { finish(null); }
            });
          });
          req.on('error', () => finish(null));
        } catch { finish(null); }
      };
      resolve({ url, httpGet, stop: () => s.close() });
    });
  });
}

(async () => {
  // 有新版 → 认出来，并且把 pc 段那几个字段原样带出去
  {
    const srv = await serveManifest({
      version: '1.6.2',
      versionCode: 15,
      changelog: ['修了一处', '又修了一处'],
      pc: {
        version: '1.0.1',
        url: 'https://example.test/nova-pc-1.0.1-win-x64-setup.zip',
        size: 12345,
        sha256: 'abc123'
      }
    });
    const r = await U.check('1.0.0', srv.url, srv.httpGet);
    srv.stop();
    check('远端更高 → 报告可更新', r.updateAvailable === true,
      JSON.stringify(r));
    check('带出版本号', r.version === '1.0.1', r.version);
    check('带出下载地址', /1\.0\.1.*\.zip$/.test(r.url || ''), r.url);
    check('带出 sha256 与 size（清单里那一份，不重新算）',
      r.sha256 === 'abc123' && r.size === 12345);
    check('带出更新日志', Array.isArray(r.notes) && r.notes.length === 2);
  }

  // 同版本 → 明确说已是最新，不该提示用户
  {
    const srv = await serveManifest({ version: '1.6.1', pc: { version: '1.0.0', url: 'x' } });
    const r = await U.check('1.0.0', srv.url, srv.httpGet);
    srv.stop();
    check('同版本 → 不提示更新', r.updateAvailable === false && r.reason === '已是最新', r.reason);
  }

  // 本地更高（开发机上跑着新版、源上还是旧的）→ 同样不提示
  {
    const srv = await serveManifest({ version: '1.6.1', pc: { version: '0.9.0', url: 'x' } });
    const r = await U.check('1.0.0', srv.url, srv.httpGet);
    srv.stop();
    check('源上版本更低 → 不提示更新', r.updateAvailable === false);
  }

  // 清单里没有 pc 段 → 当作查不到，绝不能拿一个没有 url 的状态去下载
  {
    const srv = await serveManifest({ version: '1.6.1', downloads: [] });
    const r = await U.check('1.0.0', srv.url, srv.httpGet);
    srv.stop();
    check('清单没有 pc 段 → 不提示更新', r.updateAvailable === false);
  }

  // 优先给 zip：exe 未签名且浏览器会拦，zip 才是该主推的通道
  {
    const srv = await serveManifest({
      version: '1.6.2',
      pc: {
        version: '1.0.1',
        url: 'https://example.test/nova-pc-1.0.1-win-x64-setup.zip',
        exe: { url: 'https://example.test/nova-pc-1.0.1-win-x64-setup.exe' }
      }
    });
    const r = await U.check('1.0.0', srv.url, srv.httpGet);
    srv.stop();
    check('默认给 zip 而不是 exe', /\.zip$/.test(r.url || ''), r.url);
  }

  // 清单取不到 → 安静地当作没更新，绝不抛错打断启动
  {
    const r = await U.check('1.0.0', 'http://127.0.0.1:1/none.json');
    check('清单取不到 → 不提示、不抛错', r.updateAvailable === false);
  }
  {
    const r = await U.check('1.0.0', 'not-a-url');
    check('地址非法 → 不提示、不抛错', r.updateAvailable === false);
  }

  // start() 的对外契约：永不 reject，且会把状态变化回调出去
  console.log('\n[C] start() 的状态回调');
  {
    const srv = await serveManifest({
      version: '1.6.2',
      changelog: ['x'],
      pc: { version: '1.0.1', url: 'https://example.test/a.zip', size: 1, sha256: 'b' }
    });
    const seen = [];
    const st = await U.start('1.0.0', { onState: (s) => seen.push(s.status) }, srv.url, srv.httpGet);
    srv.stop();
    check('回调顺序是 checking → available',
      seen.join(',') === 'checking,available', seen.join(','));
    check('返回的状态里带上了版本与地址', st.status === 'available' && st.info.version === '1.0.1');
  }
  {
    const srv = await serveManifest({ version: '1.6.1', pc: { version: '1.0.0', url: 'x' } });
    const seen = [];
    const st = await U.start('1.0.0', { onState: (s) => seen.push(s.status) }, srv.url, srv.httpGet);
    srv.stop();
    check('没有新版时回调顺序是 checking → idle',
      seen.join(',') === 'checking,idle', seen.join(','));
    check('没有新版时 info 为空', st.info === null);
  }
  {
    // 清单彻底取不到时也必须走完回调，界面不能停在「检查中」
    const seen = [];
    const st = await U.start('1.0.0', { onState: (s) => seen.push(s.status) },
      'http://127.0.0.1:1/none.json');
    check('取不到清单时也回调到 idle（界面不会卡在「检查中」）',
      seen.join(',') === 'checking,idle', seen.join(','));
    check('取不到清单时记下原因，便于排查', typeof st.error === 'string' && st.error.length > 0, st.error);
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});