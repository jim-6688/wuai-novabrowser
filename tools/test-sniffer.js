'use strict';

/**
 * 媒体嗅探引擎测试（纯 Node，不需要 Electron / jsdom）
 * 用法：node tools/test-sniffer.js
 *
 * 判定逻辑是这整个功能的地基，所以这里测得最细的是「误报」与「漏报」两侧：
 *   - 漏报：无扩展名的地址、大小写混杂的 MIME、冷门容器
 *   - 误报：动态路由把 .mp4 当路径却返回 HTML、图片、字体、CSS
 * 池逻辑（去重 / 命中计数 / 分片 / 上限 / 统计）在后面几组。
 */

const {
  classify, extOf, normMime, looksLikeFragment, hashId, normalizeUrl,
  Sniffer, EXT_TABLE, MIME_TABLE, FORMAT_STATS
} = require('../src/main/sniffer');

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const group = (t) => console.log('\n' + t);

/* ================================================================== *
 * [A] 格式注册表规模
 * ================================================================== */

group('[A] 格式注册表');

check('扩展名表覆盖 ≥ 90 种', FORMAT_STATS.extensions >= 90, `${FORMAT_STATS.extensions} 种`);
check('MIME 表覆盖 ≥ 80 种', FORMAT_STATS.mimes >= 80, `${FORMAT_STATS.mimes} 种`);
check('归一化到 ≥ 60 个容器', FORMAT_STATS.containers >= 60, `${FORMAT_STATS.containers} 个`);
check('四个大类都有覆盖（video/audio/stream/subtitle）', (() => {
  const kinds = new Set(Object.values(EXT_TABLE).map((v) => v[0]));
  return ['video', 'audio', 'stream', 'subtitle'].every((k) => kinds.has(k));
})());

/* ================================================================== *
 * [B] 扩展名解析
 * ================================================================== */

group('[B] 扩展名解析');

check('普通地址', extOf('https://a.com/video.mp4') === 'mp4');
check('带查询串', extOf('https://a.com/v.mp4?token=abc&x=1') === 'mp4');
check('带 hash', extOf('https://a.com/v.mp3#t=30') === 'mp3');
check('目录名里带点不干扰', extOf('https://a.com/v1.2/file.mkv') === 'mkv');
check('大写扩展名归一为小写', extOf('https://a.com/V.MP4') === 'mp4');
check('编码过的文件名', extOf('https://a.com/%E4%B8%AD%E6%96%87.mp3') === 'mp3');
check('无扩展名返回空', extOf('https://a.com/api/media?id=1') === '');
check('点结尾不算扩展名', extOf('https://a.com/weird.') === '');
check('超长后缀不当扩展名', extOf('https://a.com/x.abcdefghijkl') === '');
check('畸形 URL 不抛异常', (() => { try { extOf('not a url/at all.mp4'); return true; } catch { return false; } })());

check('MIME 去参数', normMime('video/mp4; charset=utf-8') === 'video/mp4');
check('MIME 小写归一', normMime('Application/VND.Apple.MPEGURL') === 'application/vnd.apple.mpegurl');
check('空 MIME 返回空串', normMime(null) === '');

/* ================================================================== *
 * [C] 分级判定 —— 第 1 级 MIME 精确表
 * ================================================================== */

group('[C] MIME 判定');

const byMime = (mime, url = 'https://a.com/x') => classify({ url, mime, size: 1024 });

check('video/mp4 → MP4', byMime('video/mp4').container === 'MP4');
check('video/x-matroska → MKV', byMime('video/x-matroska').container === 'MKV');
check('video/quicktime → MOV', byMime('video/quicktime').container === 'MOV');
check('video/mp2t → TS', byMime('video/mp2t').container === 'TS');
check('video/3gpp → 3GP', byMime('video/3gpp').container === '3GP');
check('audio/mpeg → MP3', byMime('audio/mpeg').container === 'MP3');
check('audio/x-flac → FLAC', byMime('audio/x-flac').container === 'FLAC');
check('audio/webm → WebM', byMime('audio/webm').container === 'WebM');
check('audio/opus → Opus', byMime('audio/opus').container === 'Opus');
check('audio/x-ms-wma → WMA', byMime('audio/x-ms-wma').container === 'WMA');
check('MIME 精确命中置信度 0.95', byMime('video/mp4').confidence === 0.95);
check('判定依据标为 mime', byMime('video/mp4').basis === 'mime');

/* HLS 的多种写法是这个功能的重点 —— 各家服务端写得都不一样 */
const HLS_MIMES = [
  'application/vnd.apple.mpegurl', 'application/x-mpegurl', 'application/x-mpegURL',
  'audio/mpegurl', 'audio/x-mpegurl', 'application/mpegurl',
  'application/vnd.apple.mpegurl.audio', 'application/x-apple-mpegurl'
];
check(`HLS 的 ${HLS_MIMES.length} 种 MIME 写法全部归一为 HLS`, (() => {
  const bad = HLS_MIMES.filter((m) => {
    const r = byMime(m);
    return !r || r.container !== 'HLS' || r.kind !== 'stream';
  });
  return bad.length === 0 || bad.join(',');
})() === true, HLS_MIMES.filter((m) => { const r = byMime(m); return !r || r.container !== 'HLS'; }).join(',') || '全部正确');
check('application/dash+xml → DASH', byMime('application/dash+xml').container === 'DASH');
check('application/vnd.ms-sstr+xml → MSS', byMime('application/vnd.ms-sstr+xml').container === 'MSS');
check('text/vtt → 字幕 VTT（text/ 前缀不误杀）', byMime('text/vtt').kind === 'subtitle');

/* ================================================================== *
 * [D] 一票否决 —— 防误报
 * ================================================================== */

group('[D] 防误报（非媒体一票否决）');

/* 最典型也最容易翻车的场景：动态路由把 .mp4 当路径，实际返回登录页 HTML */
check('★ .mp4 路径但返回 text/html → 拒绝', classify({ url: 'https://a.com/watch.mp4', mime: 'text/html', size: 2048 }) === null);
check('.m3u8 路径但返回 text/html → 拒绝', classify({ url: 'https://a.com/x.m3u8', mime: 'text/html' }) === null);
check('.mp3 路径但返回 text/html → 拒绝', classify({ url: 'https://a.com/song.mp3', mime: 'text/html' }) === null);
check('image/png 拒绝', classify({ url: 'https://a.com/a.png', mime: 'image/png' }) === null);
check('image/jpeg 拒绝', classify({ url: 'https://a.com/a.jpg', mime: 'image/jpeg' }) === null);
check('image/webp 拒绝', classify({ url: 'https://a.com/a.webp', mime: 'image/webp' }) === null);
check('font/woff2 拒绝', classify({ url: 'https://a.com/f.woff2', mime: 'font/woff2' }) === null);
check('application/javascript 拒绝', classify({ url: 'https://a.com/a.js', mime: 'application/javascript' }) === null);
check('text/css 拒绝', classify({ url: 'https://a.com/a.css', mime: 'text/css' }) === null);
check('application/json 拒绝', classify({ url: 'https://a.com/a.json', mime: 'application/json' }) === null);
check('application/pdf 拒绝', classify({ url: 'https://a.com/a.pdf', mime: 'application/pdf' }) === null);
check('application/zip 拒绝', classify({ url: 'https://a.com/a.zip', mime: 'application/zip' }) === null);
check('无扩展名的 HTML 页面拒绝', classify({ url: 'https://a.com/', mime: 'text/html' }) === null);
check('无扩展名且无 MIME → 拒绝', classify({ url: 'https://a.com/api/x' }) === null);

/* ================================================================== *
 * [E] 扩展名判定与置信度分级
 * ================================================================== */

group('[E] 扩展名判定');

const byExt = (url, mime) => classify({ url, mime, size: 1024 });

check('扩展名命中但 MIME 是陌生应用类型 → 0.75', byExt('https://a.com/v.mp4', 'application/x-msdownload').confidence === 0.75);
check('octet-stream + .mp3 → 0.7（低一档）', byExt('https://a.com/x.mp3', 'application/octet-stream').confidence === 0.7);
check('octet-stream + .mkv → MKV', byExt('https://a.com/x.mkv', 'application/octet-stream').container === 'MKV');
check('无 MIME 但有扩展名 → 0.7', byExt('https://a.com/x.flac', '').confidence === 0.7);
check('判定依据标为 ext', byExt('https://a.com/x.wav', 'application/x-msdownload').basis === 'ext');
/* video/ 前缀比扩展名更可信：即使 MIME 子类型没见过，也走前缀分支拿 0.9 */
check('video/ 陌生子类型置信度高于扩展名兜底', byExt('https://a.com/v.mp4', 'video/x-unknown-thing').confidence === 0.9);
check('前缀分支的依据标为 mime-prefix', byExt('https://a.com/v.mp4', 'video/x-unknown-thing').basis === 'mime-prefix');
check('判定依据标为 octet-stream+ext', byExt('https://a.com/x.wav', 'application/octet-stream').basis === 'octet-stream+ext');

check('无扩展名但 video/mp4 → 靠 MIME 救回', byExt('https://a.com/api/media?id=8123', 'video/mp4').kind === 'video');
check('无扩展名但 audio/ogg → 靠 MIME 救回', byExt('https://a.com/stream', 'audio/ogg').container === 'OGG');
check('video/ 未知子类型也收（前缀即强信号）', byExt('https://a.com/x', 'video/x-some-new-codec').kind === 'video');
check('audio/ 未知子类型也收', byExt('https://a.com/x', 'audio/x-weird').kind === 'audio');
check('未知子类型容器标为「未知容器」', byExt('https://a.com/x', 'video/x-some-new-codec').container === '未知容器');

check('冷门容器 .ape → APE', byExt('https://a.com/a.ape', 'audio/x-ape').container === 'APE');
check('冷门容器 .tta → TTA', byExt('https://a.com/a.tta', 'audio/x-tta').container === 'TTA');
check('冷门容器 .mxf → MXF', byExt('https://a.com/a.mxf', 'application/octet-stream').container === 'MXF');
check('字幕 .ass → ASS', byExt('https://a.com/a.ass', 'application/octet-stream').kind === 'subtitle');
check('字幕 .lrc → LRC', byExt('https://a.com/a.lrc', 'application/octet-stream').container === 'LRC');
check('流清单 .f4m → HDS', byExt('https://a.com/a.f4m', 'application/octet-stream').container === 'HDS');
check('流清单 .ism → MSS', byExt('https://a.com/a.ism', 'application/octet-stream').container === 'MSS');

check('真实 URL 里的中文名 + 参数', byExt('https://cdn.a.com/%E6%AD%8C.mp3?sign=x&t=1', 'audio/mpeg').container === 'MP3');
check('真实 URL 里带鉴权参数', byExt('https://cdn.a.com/v.mp4?auth=abc.def&expire=123', 'video/mp4').container === 'MP4');

/* ================================================================== *
 * [F] 分片识别
 * ================================================================== */

group('[F] 分片识别');

check('纯序号 .ts 认作分片', looksLikeFragment('https://a.com/hls/123.ts', 'ts', 500 * 1024));
check('seg-N .ts 认作分片', looksLikeFragment('https://a.com/hls/seg-12.ts', 'ts', 500 * 1024));
check('chunk_N.m4s 认作分片', looksLikeFragment('https://a.com/hls/chunk_7.m4s', 'm4s', 300 * 1024));
check('大体积 .ts 仍是切片格式（体积不是唯一依据）', looksLikeFragment('https://a.com/hls/999.ts', 'ts', 20 * 1024 * 1024));
check('正片 .mkv 不是分片', !looksLikeFragment('https://a.com/movie.mkv', 'mkv', 500 * 1024 * 1024));
check('正片 .mp4 单看不算分片', !looksLikeFragment('https://a.com/movie.mp4', 'mp4', 500 * 1024 * 1024));
check('带序号的 .mp4 算分片候选', looksLikeFragment('https://a.com/hls/seg-3.mp4', 'mp4', 2 * 1024 * 1024));

/* 池层的分片判定：.mp4 要结合「同目录有没有清单文件」 */
{
  const s = new Sniffer({ enabled: true });
  s.setPage(1, 'https://a.com/watch', '页');
  const man = s.observe({ url: 'https://a.com/hls/index.m3u8', mime: 'application/vnd.apple.mpegurl', tabId: 1 });
  check('清单文件本身不是分片', man && man.rec.isSegment === false);
  const seg = s.observe({ url: 'https://a.com/hls/seg-3.mp4', mime: 'video/mp4', size: 2 * 1024 * 1024, tabId: 1 });
  check('★ 同目录有 m3u8 时，序号 .mp4 被认作分片', seg && seg.rec.isSegment === true);
  const other = s.observe({ url: 'https://b.com/other/movie.mp4', mime: 'video/mp4', size: 500 * 1024 * 1024, tabId: 1 });
  check('不同源的 .mp4 不受影响', other && other.rec.isSegment === false);
}
{
  const s = new Sniffer({ enabled: true });
  s.setPage(1, 'https://a.com/', '');
  const seg = s.observe({ url: 'https://a.com/hls/seg-3.mp4', mime: 'video/mp4', size: 2 * 1024 * 1024, tabId: 1 });
  check('同目录无清单时，序号 .mp4 不算分片（避免误杀）', seg && seg.rec.isSegment === false);
}

/* ================================================================== *
 * [G] 资源池：去重 / 命中计数 / 上限
 * ================================================================== */

group('[G] 资源池');

const mkSniffer = (opts) => {
  const s = new Sniffer(Object.assign({ enabled: true }, opts));
  s.setPage(7, 'https://a.com/page', '某个页面');
  return s;
};

{
  const s = mkSniffer();
  const r1 = s.observe({ url: 'https://a.com/v.mp4', mime: 'video/mp4', size: 1000, tabId: 7 });
  check('首次观察到 → isNew', r1 && r1.isNew === true);
  const r2 = s.observe({ url: 'https://a.com/v.mp4', mime: 'video/mp4', size: 1000, tabId: 7 });
  check('★ 同 URL 二次请求 → 不新增，只累加命中', r2 && r2.isNew === false && r2.rec.hits === 2, `hits=${r2 && r2.rec.hits}`);
  check('池内只有 1 条', s.list().length === 1);
  check('带 hash 的同 URL 视为同一条', (() => {
    s.observe({ url: 'https://a.com/v.mp4#t=10', mime: 'video/mp4', size: 1000, tabId: 7 });
    return s.list().length === 1;
  })());
  check('带不同查询串的视为不同条（不猜语义）', (() => {
    s.observe({ url: 'https://a.com/v.mp4?q=1', mime: 'video/mp4', size: 1000, tabId: 7 });
    return s.list().length === 2;
  })());
}

{
  const s = mkSniffer();
  const first = s.observe({ url: 'https://a.com/v.mp4', mime: 'video/mp4', size: -1, tabId: 7 });
  check('首次无长度时 size = -1', first.rec.size === -1);
  s.observe({ url: 'https://a.com/v.mp4', mime: 'video/mp4', size: 8888, tabId: 7 });
  check('★ 后续拿到长度时补上', s.list()[0].size === 8888, `size=${s.list()[0].size}`);
  s.observe({ url: 'https://a.com/v.mp4', mime: 'video/mp4', size: 100, tabId: 7 });
  check('已知道长度后不被小值覆盖', s.list()[0].size === 8888);
}

{
  const s = mkSniffer();
  check('非 http(s) 协议不观察', s.observe({ url: 'file:///c:/x.mp4', mime: 'video/mp4', tabId: 7 }) === null);
  check('空 URL 不观察', s.observe({ url: '', tabId: 7 }) === null);
  check('data: 不观察', s.observe({ url: 'data:video/mp4;base64,AAAA', tabId: 7 }) === null);
}

{
  const s = mkSniffer({ enabled: false });
  check('总开关关闭时不收集', s.observe({ url: 'https://a.com/v.mp4', mime: 'video/mp4', tabId: 7 }) === null);
  s.configure({ enabled: true });
  check('打开后开始收集', s.observe({ url: 'https://a.com/v.mp4', mime: 'video/mp4', tabId: 7 }) !== null);
}

{
  const s = mkSniffer({ minSizeKB: 100 });
  check('低于阈值被过滤', s.observe({ url: 'https://a.com/small.mp3', mime: 'audio/mpeg', size: 50 * 1024, tabId: 7 }) === null);
  check('达到阈值被收下', s.observe({ url: 'https://a.com/big.mp3', mime: 'audio/mpeg', size: 200 * 1024, tabId: 7 }) !== null);
  check('★ 长度未知时不按阈值拦（宁多勿漏）', s.observe({ url: 'https://a.com/unk.mp3', mime: 'audio/mpeg', size: -1, tabId: 7 }) !== null);
}

{
  const s = mkSniffer({ maxPerTab: 5 });
  for (let i = 0; i < 12; i++) {
    // 前半是分片，后半是正片 —— 超限时应该先淘汰分片
    const isSeg = i < 6;
    s.observe({
      url: isSeg ? `https://a.com/hls/${i}.ts` : `https://a.com/movie${i}.mp4`,
      mime: isSeg ? 'video/mp2t' : 'video/mp4',
      size: isSeg ? 100 * 1024 : 500 * 1024 * 1024,
      tabId: 7
    });
  }
  const list = s.list();
  check('超出单页上限后自动裁剪', list.length === 5, `剩 ${list.length} 条`);
  check('★ 裁剪时优先淘汰分片，保留正片', list.filter((r) => !r.isSegment).length === 5, `正片 ${list.filter((r) => !r.isSegment).length} 条`);
}

{
  const s = mkSniffer();
  s.observe({ url: 'https://a.com/v.mp4', mime: 'video/mp4', size: 10, tabId: 7 });
  s.observe({ url: 'https://a.com/a.mp3', mime: 'audio/mpeg', size: 10, tabId: 8 });
  check('list({tabId}) 只取该页的', s.list({ tabId: 7 }).length === 1);
  check('reset(tabId) 只清该页', (() => { s.reset(7); return s.list().length === 1 && s.list()[0].tabId === 8; })());
  check('clearAll() 全清', (() => { s.clearAll(); return s.totalCount() === 0; })());
}

/* ================================================================== *
 * [H] 统计与来源信息
 * ================================================================== */

group('[H] 统计与来源');

{
  const s = mkSniffer();
  s.setPage(7, 'https://a.com/watch/123', '某视频页');
  s.observe({ url: 'https://a.com/1.mp4', mime: 'video/mp4', size: 1000, tabId: 7 });
  s.observe({ url: 'https://a.com/2.m3u8', mime: 'application/vnd.apple.mpegurl', tabId: 7 });
  s.observe({ url: 'https://a.com/3.mp3', mime: 'audio/mpeg', size: 500, tabId: 7 });
  s.observe({ url: 'https://a.com/4.vtt', mime: 'text/vtt', size: 100, tabId: 7 });
  s.observe({ url: 'https://a.com/hls/5.ts', mime: 'video/mp2t', size: 1000, tabId: 7 });
  s.observe({ url: 'https://a.com/pixel.gif', mime: 'image/gif', tabId: 7 });

  const st = s.stats(7);
  check('总数正确', st.total === 5, `total=${st.total}`);
  check('按类别计数正确', st.byKind.video === 2 && st.byKind.audio === 1 && st.byKind.stream === 1 && st.byKind.subtitle === 1,
    JSON.stringify(st.byKind));
  check('分片单独计数', st.segments === 1, `segments=${st.segments}`);
  check('累计总体积只算已知长度的', st.bytes === 1000 + 500 + 100 + 1000, `bytes=${st.bytes}`);
  check('被过滤的请求有计数', st.filtered === 1, `filtered=${st.filtered}`);

  const rec = s.list().find((r) => r.url.endsWith('1.mp4'));
  check('记录带来源页 URL', rec.pageUrl === 'https://a.com/watch/123');
  check('记录带来源页标题', rec.pageTitle === '某视频页');
  check('记录带 tabId', rec.tabId === 7);
  check('流媒体标记为不可直接下载', s.list().find((r) => r.kind === 'stream').downloadable === false);
  check('视频标记为可下载', rec.downloadable === true);
  check('记录带判定依据（给用户看原因）', typeof rec.reason === 'string' && rec.reason.length > 0, rec.reason);
}

{
  const s = mkSniffer();
  s.observe({ url: 'https://a.com/v.mp4', mime: 'video/mp4', size: 100, tabId: 7 });
  const id = s.list()[0].id;
  const r = s.setMeta(id, { duration: 213.4, width: 1920, height: 1080 });
  check('元数据能按 id 回填', r && r.meta && r.meta.duration === 213.4);
  check('回填后快照里能读到', s.list()[0].meta.height === 1080);
  check('回填不存在的 id 返回 null', s.setMeta('nope', {}) === null);
}

{
  const s = mkSniffer();
  let events = 0;
  s.onChange = () => { events++; };
  s.observe({ url: 'https://a.com/v.mp4', mime: 'video/mp4', tabId: 7 });
  s.reset(7);
  check('观察者能收到通知', events >= 1, `events=${events}`);
  check('观察者抛异常不影响引擎', (() => {
    s.onChange = () => { throw new Error('boom'); };
    try { s.reset(7); return true; } catch { return false; }
  })());
}

/* ================================================================== *
 * [I] 工具函数
 * ================================================================== */

group('[I] 工具函数');

check('hashId 同输入同输出', hashId('abc') === hashId('abc'));
check('hashId 不同输入不同输出', hashId('abc') !== hashId('abd'));
check('hashId 以 m 开头且是字符串', /^m/.test(hashId('x')) && typeof hashId('x') === 'string');
check('normalizeUrl 去 hash', normalizeUrl('https://a.com/v.mp4#t=5') === 'https://a.com/v.mp4');
check('normalizeUrl 保留查询串', normalizeUrl('https://a.com/v.mp4?x=1').includes('x=1'));
check('normalizeUrl 畸形输入不抛', (() => { try { normalizeUrl('::::'); return true; } catch { return false; } })());

/* ------------------------------------------------------------------ */

console.log(`\n嗅探引擎测试：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）\n`);
process.exit(fail ? 1 : 0);
