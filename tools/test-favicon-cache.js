'use strict';
/**
 * 站点图标缓存（PC 主进程侧）测试
 * 用法：node tools/test-favicon-cache.js
 *
 * 这个模块一半是纯解析（认字节头、清洗文件名、抠主机名），一半是落盘与抓取的
 * 编排。两半的失败方式完全不同：
 *   - 解析错了，表现是「明明有图标却显示不出来」，或者更糟 —— 文件名没洗干净，
 *     一个带 `../../` 的主机名能把文件写到缓存目录外面去。所以 [B] 那组是
 *     安全断言，不是风格断言。
 *   - 编排错了，表现是「每开一次新标签页就重抓一遍」或者「换了图标却还是旧图」。
 *     所以 [F] 那组真的在临时目录里落盘、真的改 mtime、真的数请求次数。
 *
 * [A] 认字节头       sniffMime
 * [B] 主机名 → 文件名 fileNameFor（含路径穿越）
 * [C] 扩展名往返     extOf / mimeOfExt
 * [D] 地址过滤       isHttpUrl
 * [E] ntp data 解析  hostsFromNtpData
 * [F] 缓存编排       真实临时目录 + 注入的 fetchImpl
 * [G] 跨端常量       与 android-app 的 FaviconCache.java 逐项对齐
 *
 * [G] 存在的理由：两端各写一份实现，常量各自写死。改一边忘一边的表现是
 * 「手机上三天一换、电脑上还在用去年的图标」，没人会为此开一个 issue。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const root = path.join(__dirname, '..');
const P = (rel) => path.join(root, rel);

const {
  FaviconCache, sniffMime, fileNameFor, extOf, mimeOfExt, isHttpUrl,
  hostsFromNtpData, TTL_MS, MAX_BYTES, PATHS
} = require(P('src/main/favicon-cache.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

/* ---------------------------------------------------------------- 样本字节 */

// 每样都造到 12 字节以上 —— sniffMime 对短于 12 字节的一律不认
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12, 3)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(10, 1)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.alloc(4, 0),
  Buffer.from('WEBP', 'latin1'), Buffer.alloc(4, 1)
]);
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(10, 2)]);
const HTML = Buffer.concat([Buffer.from('<html><body>404 Not Found', 'latin1'), Buffer.alloc(12, 0x20)]);

/** 造一个只认得给定 url 的假 fetch。log 传进来就顺手记下请求顺序。 */
function fakeFetch(map, log) {
  return async (url) => {
    if (log) log.push(url);
    const b = map[url];
    return b ? { ok: true, bytes: b } : { ok: false, bytes: null };
  };
}

/** 每个用例一个干净缓存目录，互不干扰 */
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nova-fav-'));

(async () => {
  /* ------------------------------------------------------------ [A] 认字节头 */
  console.log('\n[A] 认字节头');
  check('PNG', sniffMime(PNG) === 'image/png');
  check('JPEG', sniffMime(JPG) === 'image/jpeg');
  check('GIF', sniffMime(GIF) === 'image/gif');
  check('WEBP（认的是 RIFF....WEBP 这个壳，不是只看开头四个字母）',
    sniffMime(WEBP) === 'image/webp');
  check('ICO 壳按 x-icon 整包收 —— Chromium 的 <img> 原生认，不必走安卓那套抠 PNG',
    sniffMime(ICO) === 'image/x-icon');
  check('HTML 不认：不少站点把 404 页面配 200 状态码发回来，只看 Content-Type 会把它当图标存下',
    sniffMime(HTML) === null);
  check('太短的一律不认（12 字节以下连头都凑不齐）',
    sniffMime(Buffer.from([0x89, 0x50])) === null && sniffMime(Buffer.alloc(0)) === null);
  check('null / undefined 不炸', sniffMime(null) === null && sniffMime(undefined) === null);
  check('只像 RIFF 但不是 WEBP 的不算', (() => {
    const notWebp = Buffer.concat([
      Buffer.from('RIFF', 'latin1'), Buffer.alloc(4, 0),
      Buffer.from('WAVE', 'latin1'), Buffer.alloc(4, 1)
    ]);
    return sniffMime(notWebp) === null;
  })());

  /* ------------------------------------------------------- [B] 主机名 → 文件名 */
  console.log('\n[B] 主机名 → 文件名');
  check('正常主机名原样保留（点与连字符是合法的）',
    fileNameFor('www.zhihu.com') === 'www.zhihu.com'
    && fileNameFor('news-yz.52ta.top') === 'news-yz.52ta.top');
  check('大写折成小写 —— 大小写不同是同一家站点，不折会存出两份',
    fileNameFor('WWW.Baidu.COM') === 'www.baidu.com');
  check('空 / null / undefined 给占位名，不返回空串（空串拼出来的路径就是目录本身）',
    fileNameFor('') === 'site' && fileNameFor(null) === 'site' && fileNameFor(undefined) === 'site');
  check('截到 80 字符，不让畸形主机名撑爆文件名上限',
    fileNameFor('a'.repeat(300)).length === 80);
  // 这一条是安全断言，不是风格断言
  const evil = fileNameFor('../../../../etc/passwd');
  check('路径穿越被清洗：斜杠一律落成下划线，拼不出缓存目录外的路径',
    !evil.includes('/') && !evil.includes('\\') && evil.endsWith('etc_passwd'), evil);
  check('冒号 / 空格 / 中文这类主机名里不该有的字符也一并清洗',
    fileNameFor('a:b c中文') === 'a_b_c__', fileNameFor('a:b c中文'));
  check('只由非法字符组成时也不会给空串', fileNameFor('/') === '_', fileNameFor('/'));

  /* --------------------------------------------------------- [C] 扩展名往返 */
  console.log('\n[C] 扩展名往返');
  for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon']) {
    check(`${mime} → ext → mime 回到原值`, mimeOfExt(extOf(mime)) === mime,
      `${extOf(mime)} → ${mimeOfExt(extOf(mime))}`);
  }
  check('认不出的 mime 落成 png（默认那支），认不出的 ext 给 null',
    extOf('image/avif') === 'png' && mimeOfExt('avif') === null);

  /* ----------------------------------------------------------- [D] 地址过滤 */
  console.log('\n[D] 地址过滤');
  check('http / https 收（大小写都收）',
    isHttpUrl('http://a.test/f.ico') && isHttpUrl('HTTPS://a.test/f.ico'));
  // 这三样都不该进缓存：本地文件、内联数据、扩展页。它们要么没有「站点」的概念，
  // 要么会把缓存目录污染成一张与站点无关的表。
  ['file:///C:/x.png', 'data:image/png;base64,AAAA', 'chrome-extension://abc/i.png']
    .forEach((u) => check(u.slice(0, 24) + '… 不收', !isHttpUrl(u)));
  check('空值不炸', !isHttpUrl('') && !isHttpUrl(null) && !isHttpUrl(undefined));

  /* --------------------------------------------- [E] 从 ntp data 里抠主机名 */
  console.log('\n[E] 从新标签页地址里抠主机名');
  const data = [
    '知乎\thttps://www.zhihu.com/\t12\t',
    'B站\thttps://www.bilibili.com/\t7\t',
    '坏行没有第二列\t\t3\t',
    '不是地址\t这不是一个 url\t1\t',
    ''
  ].join('\n');
  const hosts = hostsFromNtpData(data);
  check('按 TSV 取第二列 url，再取其主机名',
    hosts.length === 2 && hosts[0] === 'www.zhihu.com' && hosts[1] === 'www.bilibili.com',
    JSON.stringify(hosts));
  check('缺列 / 坏地址的行跳过，不抛异常', hostsFromNtpData('a\t\t1\nb\t%%%\t1').length === 0);
  check('空串 / null 给空表', hostsFromNtpData('').length === 0 && hostsFromNtpData(null).length === 0);

  /* ----------------------------------------------------------- [F] 缓存编排 */
  console.log('\n[F] 缓存编排（真实临时目录）');

  {
    const dir = tmpDir();
    const log = [];
    const cache = new FaviconCache(dir, {
      fetchImpl: fakeFetch({ 'https://a.test/favicon.ico': PNG }, log)
    });
    const got = await cache.refreshOne('a.test');
    check('抓到了就落盘', got === true);
    check('落盘的文件名与扩展名都符合约定',
      fs.readdirSync(dir).join(',') === 'a.test.png', fs.readdirSync(dir).join(','));
    check('dataUri 交的是完整的 data: URI，页面直接塞进 <img src> 就能用',
      cache.dataUri('a.test') === 'data:image/png;base64,' + PNG.toString('base64'));
    check('第一个位置就命中时不再往下探（不多打两个白跑的请求）',
      log.length === 1 && log[0] === 'https://a.test/favicon.ico', log.join(' '));
  }

  {
    const dir = tmpDir();
    const log = [];
    // 约定位置都没图，只有 apple-touch-icon 有 —— 验证探测顺序真的按 PATHS 走
    const cache = new FaviconCache(dir, {
      fetchImpl: fakeFetch({ 'https://b.test/apple-touch-icon.png': PNG }, log)
    });
    await cache.refreshOne('b.test');
    check('按 PATHS 顺序依次探，直到某处命中',
      log.join(' ') === 'https://b.test/favicon.ico https://b.test/apple-touch-icon.png',
      log.join(' '));
  }

  {
    const dir = tmpDir();
    const log = [];
    const cache = new FaviconCache(dir, { fetchImpl: fakeFetch({}, log) });
    await cache.refreshOne('c.test');
    check('三处都没有 → 一个文件也不落，也不抛',
      fs.readdirSync(dir).length === 0 && log.length === 3);
    check('没缓存时 dataUri 给 null、jsonFor 里干脆不出现'
      + '（调用方据此回落到首字母兜底，不需要区分「没抓过」与「抓失败」）',
      cache.dataUri('c.test') === null && Object.keys(cache.jsonFor(['c.test'])).length === 0);
  }

  {
    const dir = tmpDir();
    const cache = new FaviconCache(dir, {
      fetchImpl: fakeFetch({ 'https://d.test/favicon.ico': HTML })
    });
    const got = await cache.refreshOne('d.test');
    check('认不出来的字节（404 页面）不落盘 —— 宁可不显示图标，也不显示一张破图',
      got === false && fs.readdirSync(dir).length === 0);
  }

  {
    const dir = tmpDir();
    const log = [];
    const cache = new FaviconCache(dir, {
      fetchImpl: fakeFetch({ 'https://e.test/favicon.ico': PNG }, log)
    });
    await cache.refreshOne('e.test');
    const before = log.length;
    const again = await cache.refreshOne('e.test');
    check('缓存还新时不重复抓 —— 这正是 7 天 TTL 唯一的意义所在',
      again === false && log.length === before, `请求数 ${log.length}`);
  }

  {
    const dir = tmpDir();
    const log = [];
    const cache = new FaviconCache(dir, {
      fetchImpl: fakeFetch({ 'https://g.test/favicon.ico': PNG }, log)
    });
    await cache.refreshOne('g.test');
    const file = path.join(dir, 'g.test.png');
    const old = new Date(Date.now() - TTL_MS - 60 * 1000);
    fs.utimesSync(file, old, old);
    check('过了 7 天就不算新：isFresh 为假', cache.isFresh('g.test') === false);
    check('过期后 dataUri 给 null（页面回落到首字母，而不是显示一张早已换掉的旧图）',
      cache.dataUri('g.test') === null);
    const n0 = log.length;
    await cache.refreshOne('g.test');
    check('过期的那家会被重抓一次', log.length > n0, `请求数 ${log.length - n0}`);
  }

  {
    const dir = tmpDir();
    const seen = [];
    const cache = new FaviconCache(dir, {
      fetchImpl: fakeFetch({ 'https://h.test/favicon.ico': PNG })
    });
    cache.onFetched = (host) => seen.push(host);
    await cache.refreshOne('h.test');
    check('抓到新图标时回调一次 —— 新标签页靠它立刻重画，不用等下一轮',
      seen.length === 1 && seen[0] === 'h.test', seen.join(','));
  }

  {
    // 站点换了图标格式：从 png 换成 ico。旧的那份必须被清掉，否则 find() 的
    // 固定扩展名顺序会先撞上旧文件 —— 表现是「换了图标却还是旧图」。
    const dir = tmpDir();
    const cache = new FaviconCache(dir, {
      fetchImpl: fakeFetch({ 'https://i.test/favicon.ico': PNG })
    });
    await cache.refreshOne('i.test');
    fs.utimesSync(path.join(dir, 'i.test.png'), new Date(0), new Date(0)); // 装作过期
    cache.fetchImpl = fakeFetch({ 'https://i.test/favicon.ico': ICO });
    await cache.refreshOne('i.test');
    check('换格式时旧的扩展名文件被清掉，目录里只剩新那份',
      fs.readdirSync(dir).join(',') === 'i.test.ico', fs.readdirSync(dir).join(','));
    check('换过之后读出来的是新格式',
      /^data:image\/x-icon;base64,/.test(cache.dataUri('i.test') || ''));
  }

  {
    // remember 走的是「站点自己声明的图标地址」，盲探 PATHS 拿不到
    const dir = tmpDir();
    const log = [];
    const cache = new FaviconCache(dir, {
      fetchImpl: fakeFetch({ 'https://j.test/__user_favicon__': JPG }, log)
    });
    const got = await cache.remember('j.test', 'https://j.test/__user_favicon__');
    check('remember 抓的是传进来的那个地址，不探 PATHS',
      got === true && log.length === 1 && log[0] === 'https://j.test/__user_favicon__');
    check('自定义路径的图标也能存下来并读回去',
      /^data:image\/jpeg;base64,/.test(cache.dataUri('j.test') || ''));
    check('非 http(s) 的图标地址不收（扩展页、data: 之类）',
      (await cache.remember('k.test', 'chrome-extension://abc/i.png')) === false);
    check('没有主机名时不收', (await cache.remember('', 'https://x.test/f.ico')) === false);
  }

  {
    const dir = tmpDir();
    const cache = new FaviconCache(dir, {
      fetchImpl: fakeFetch({ 'https://m.test/favicon.ico': PNG })
    });
    await cache.refreshOne('m.test');
    const table = cache.jsonFor(['m.test', 'nope.test', '', null]);
    check('jsonFor 只把有图的主机写进表里',
      Object.keys(table).join(',') === 'm.test', JSON.stringify(Object.keys(table)));
    check('表里的值就是可以直接用的 data: URI',
      String(table['m.test']).startsWith('data:image/png;base64,'));
  }

  {
    // 路径穿越落到实际文件系统上再验一遍
    const dir = tmpDir();
    const cache = new FaviconCache(dir, { fetchImpl: fakeFetch({}) });
    await cache.refreshOne('x.test');
    fs.writeFileSync(path.join(dir, 'x.test.png'), PNG);
    await cache.store('../../../pwned', PNG, 'image/png');
    const outside = path.join(path.dirname(dir), 'pwned.png');
    check('畸形主机名写不出缓存目录（这是本模块唯一的输入校验）',
      !fs.existsSync(outside) && fs.readdirSync(dir).every((f) => !f.includes('/') && !f.includes('\\')),
      fs.readdirSync(dir).join(','));
  }

  {
    // 并发去重：收藏夹栏与设置页会在同一帧里各问一次同一批主机
    const dir = tmpDir();
    let calls = 0;
    const cache = new FaviconCache(dir, {
      fetchImpl: async (url) => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return url === 'https://p.test/favicon.ico'
          ? { ok: true, bytes: PNG } : { ok: false, bytes: null };
      }
    });
    const both = await Promise.all([cache.refreshOne('p.test'), cache.refreshOne('p.test')]);
    check('同一主机并发只抓一次（inflight 集合挡住第二次）',
      calls === 1 && both.filter(Boolean).length === 1, `请求数 ${calls}`);
  }

  {
    // refreshIfStale 对一批主机串行跑，每一项成功都立刻回调 —— 不等整批跑完
    // （有一家连不上就要多等 8 秒超时）
    const dir = tmpDir();
    const seen = [];
    const order = [];
    const cache = new FaviconCache(dir, {
      fetchImpl: async (url) => {
        order.push(url);
        return (url === 'https://q1.test/favicon.ico' || url === 'https://q2.test/favicon.ico')
          ? { ok: true, bytes: PNG } : { ok: false, bytes: null };
      }
    });
    cache.onFetched = (h) => seen.push(h);
    await cache.refreshIfStale(['q1.test', 'q2.test', 'q1.test']);
    check('同一主机在一批里只抓一次（去重）',
      order.filter((u) => u === 'https://q1.test/favicon.ico').length === 1);
    check('两家都抓到，各自回调一次', seen.length === 2, seen.join(','));
    check('空批次直接返回，不抛', (await cache.refreshIfStale([])) === undefined);
  }

  /* ----------------------------------------------------------- [G] 跨端常量 */
  console.log('\n[G] 与安卓端 FaviconCache.java 对齐');
  const java = fs.readFileSync(
    P('android-app/app/src/main/java/top/wuai/nova/FaviconCache.java'), 'utf8');
  const javaNum = (name) => {
    const m = java.match(new RegExp(name + '\\s*=\\s*([0-9L*\\s]+);'));
    if (!m) return null;
    return m[1].replace(/L/g, '').split('*')
      .map((s) => Number(s.trim())).reduce((a, b) => a * b, 1);
  };
  check('TTL 两端同值（7 天）', javaNum('TTL_MS') === TTL_MS, `${javaNum('TTL_MS')} vs ${TTL_MS}`);
  check('抓取上限两端同值（512KB）',
    javaNum('MAX_BYTES') === MAX_BYTES, `${javaNum('MAX_BYTES')} vs ${MAX_BYTES}`);
  const javaPaths = (() => {
    const m = java.match(/PATHS\s*=\s*\{([\s\S]*?)\}/);
    if (!m) return [];
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  })();
  check('探测顺序两端一字不差（顺序错了就是「图更差的先命中」）',
    javaPaths.join(',') === PATHS.join(','), javaPaths.join(',') + ' vs ' + PATHS.join(','));
  const javaCap = (java.match(/sb\.length\(\)\s*<\s*(\d+)/) || [])[1];
  check('文件名长度上限两端同值（两边各写了一份清洗规则，改一边要同步另一边）',
    javaCap === '80' && fileNameFor('a'.repeat(300)).length === 80, javaCap);

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n测试自身出错：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
