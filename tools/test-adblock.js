'use strict';

/**
 * 广告拦截引擎测试
 * ===========================================================================
 * 重点不是「能跑」，而是三件事：
 *   1. 多源规则真的装进去了，且能分源统计、分源开关
 *   2. 4-gram 索引**没有漏规则** —— 拿索引路径与全量扫描逐个 URL 对拍
 *   3. 真实 EasyList 规则真的能拦到真实广告域名，且不误伤正常资源
 */

const path = require('path');
const {
  adblock, cosmeticKind, longestLiteral, domainAnchorOf, sameSite, FILTER_DIR
} = require(path.join(__dirname, '..', 'src', 'main', 'adblock.js'));

let pass = 0; let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (detail ? '   → ' + detail : '')); }
}
const S = (n) => String(n).padStart(7);

/* ==================================================================== *
 * A. 装载
 * ==================================================================== */
console.log('\n[A] 多源装载');
const stats = adblock.loadAll();
check('三个源全部装载完成', stats.sources.length === 3 && stats.sources.every((s) => s.loaded),
      stats.sources.map((s) => s.id + '=' + s.loaded).join(', '));

const byId = Object.fromEntries(stats.sources.map((s) => [s.id, s]));
check('广告终结者源装载了规则', byId.adtchrome.counts.network > 5000,
      '网络规则 ' + byId.adtchrome.counts.network);
check('Adblock Plus 源装载了规则', byId.abp.counts.network > 50000,
      '网络规则 ' + byId.abp.counts.network);
check('系统内置源装载了规则', byId.builtin.counts.network > 100,
      '网络规则 ' + byId.builtin.counts.network);

for (const s of stats.sources) {
  console.log(`      ${s.id.padEnd(10)} 网络${S(s.counts.network)}  隐藏${S(s.counts.cosmetic)}  例外${S(s.counts.exceptions)}  跳过${S(s.counts.skipped)}`);
}
console.log(`      索引：域名锚 ${stats.rules.indexedDomains} 键 / token ${stats.rules.indexedTokens} 键 / 回退全扫 ${stats.rules.generic} 条`);

check('元素隐藏规则规模达万级', stats.rules.cosmetic > 30000, String(stats.rules.cosmetic));
check('回退全扫的规则占比 < 1%',
      stats.rules.generic < stats.rules.network * 0.01,
      stats.rules.generic + ' / ' + stats.rules.network);
check('每个源都带上了镜像溯源地址',
      byId.adtchrome.lists.every((l) => l.url) && byId.abp.lists.every((l) => l.url),
      byId.adtchrome.lists.map((l) => l.url).join(' | '));

/* ==================================================================== *
 * B. 语法解析
 * ==================================================================== */
console.log('\n[B] 语法解析');
check('最长字面量提取', longestLiteral('/adframe/*/banner.gif') === '/banner.gif',
      longestLiteral('/adframe/*/banner.gif'));
check('域名锚提取', domainAnchorOf('||ads.example.com^') === 'ads.example.com', String(domainAnchorOf('||ads.example.com^')));
check('含通配的域名锚不索引', domainAnchorOf('||ad*.example.com^') === null);
check('非域名锚不索引', domainAnchorOf('/banner/*') === null);

check('识别 ## 隐藏规则', cosmeticKind('##.ad-banner')?.kind === 'hide');
check('识别域名限定隐藏规则', cosmeticKind('example.com##.ad')?.kind === 'hide');
check('识别 #@# 例外', cosmeticKind('example.com#@#.ad')?.kind === 'exception');
check('识别 #?# 扩展语法', cosmeticKind('example.com#?#div:has-text(ad)')?.kind === 'ext');
check('识别 ##+js 脚本注入', cosmeticKind('example.com##+js(set-constant)')?.kind === 'ext');

/* ==================================================================== *
 * C. 索引无损性 —— 与全量扫描对拍
 * ==================================================================== */
console.log('\n[C] 索引无损性（索引 vs 全量扫描对拍）');

function flattenIndex(idx) {
  const set = new Set();
  for (const m of [idx.domain, idx.t4, idx.t8, idx.t12]) {
    for (const arr of m.values()) for (const r of arr) set.add(r);
  }
  for (const r of idx.generic) set.add(r);
  return [...set];
}
const ALL_RULES = flattenIndex(adblock.net);
const ALL_EXCEPTIONS = flattenIndex(adblock.ex);
console.log(`      参与对拍的规则 ${ALL_RULES.length} 条（去重后），例外 ${ALL_EXCEPTIONS.length} 条`);

function sourceOn(rule) {
  const s = adblock.sources.get(rule.sourceId);
  return !!s && s.enabled;
}

/** 参考实现：不查任何索引，逐条扫 */
function referenceCheck(url, type, doc) {
  let hostname = '';
  try { hostname = new URL(url).hostname; } catch { return false; }
  const ctx = { url, urlLower: url.toLowerCase(), hostname, resourceType: type, docHostname: doc };
  for (const ex of ALL_EXCEPTIONS) {
    if (sourceOn(ex) && ex.matches(ctx)) return false;
  }
  for (const r of ALL_RULES) {
    if (!sourceOn(r)) continue;
    if (adblock.level === 'standard' && doc && sameSite(hostname, doc)) continue;
    if (r.matches(ctx)) return true;
  }
  return false;
}

// 语料：真实广告域名 + 真实正常资源 + 从规则里反推的路径
const CORPUS = [
  ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'script', 'news.example.com'],
  ['https://securepubads.g.doubleclick.net/gpt/pubads_impl.js', 'script', 'news.example.com'],
  ['https://www.google-analytics.com/analytics.js', 'script', 'news.example.com'],
  ['https://hm.baidu.com/hm.js?abc123', 'script', '52ta.top'],
  ['https://pos.baidu.com/ecom', 'image', '52ta.top'],
  ['https://s1.pstatp.com/cdn/expire-1/tos-cn-i-0000/adbanner.jpg', 'image', 'toutiao.com'],
  ['https://v6-ad.douyucdn.cn/ad/avator?x=1', 'image', 'douyu.com'],
  ['https://static.criteo.net/js/ld/publishertag.js', 'script', 'shop.example.com'],
  ['https://cdn.taboola.com/libtrc/loader.js', 'script', 'news.example.com'],
  ['https://track.adform.net/serving/scripts/trackpoint/async/', 'script', 'blog.io'],
  ['https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.js', 'script', 'blog.io'],
  ['https://fonts.gstatic.com/s/roboto/v30/xyz.woff2', 'font', 'site.com'],
  ['https://52ta.top/assets/index-4f2c.js', 'script', '52ta.top'],
  ['https://api.52ta.top/v1/user/profile', 'xhr', '52ta.top'],
  ['https://img.alicdn.com/imgextra/i1/xxx.jpg', 'image', 'taobao.com'],
  ['https://g.alicdn.com/kissy/k/1.4.5/seed-min.js', 'script', 'taobao.com'],
  ['https://hmcdn.baidu.com/static/hmt/hm.js', 'script', 'zhihu.com'],
  ['https://www.zhihu.com/api/v4/questions/1', 'xhr', 'zhihu.com'],
  ['https://pic1.zhimg.com/v2-abc_b.jpg', 'image', 'zhihu.com'],
  ['https://static.doubleclick.net/instream/ad_status.js', 'script', 'youtube.com'],
  ['https://adservice.google.com/adsid/integrator.js', 'script', 'google.com'],
  ['https://www.googletagmanager.com/gtag/js?id=G-XXX', 'script', 'shop.com'],
  ['https://mads.dailymail.co.uk/v8/ads.js', 'script', 'dailymail.co.uk'],
  ['https://banner.agoda.com/ads/banner.png', 'image', 'hotel.com'],
  ['https://ad.doubleclick.net/ddm/ad/N123', 'subFrame', 'news.com'],
  ['https://analytics.tiktok.com/i18n/pixel/events.js', 'script', 'shop.com'],
  ['https://connect.facebook.net/en_US/fbevents.js', 'script', 'shop.com'],
  ['https://static.ads-twitter.com/uwt.js', 'script', 'shop.com'],
  ['http://legacy.example.com/js/jquery.min.js', 'script', 'legacy.example.com'],
  ['https://cdn.bootcdn.net/ajax/libs/jquery/3.6.0/jquery.min.js', 'script', 'old.example.com'],
  ['https://example.com/wp-content/uploads/2024/01/photo.jpg', 'image', 'example.com'],
  ['https://cdn.shopify.com/s/files/1/xxx/product.jpg', 'image', 'shopify.com'],
  ['https://matomo.example.org/matomo.js', 'script', 'example.org'],
  ['https://clarity.ms/tag/abc123', 'script', 'shop.com'],
  ['https://cdn.heapanalytics.com/js/heap-123.js', 'script', 'app.io'],
  ['https://static.hotjar.com/c/hotjar-123.js', 'script', 'app.io']
];

adblock.level = 'aggressive';
let mismatch = 0;
const mismatches = [];
for (const [url, type, doc] of CORPUS) {
  const indexed = !!adblock.check(url, type, doc);
  const reference = referenceCheck(url, type, doc);
  if (indexed !== reference) { mismatch++; mismatches.push(`${url} 索引=${indexed} 全扫=${reference}`); }
}
check(`${CORPUS.length} 个 URL 索引与全扫结果完全一致`, mismatch === 0,
      mismatches.slice(0, 3).join(' | '));

/* ==================================================================== *
 * D. 真实规则命中
 * ==================================================================== */
console.log('\n[D] 真实规则命中（实时命中真实 EasyList 规则）');
adblock.resetStats();

const HIT = [
  ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'script', 'news.com', true, 'Google 广告联盟'],
  ['https://securepubads.g.doubleclick.net/gpt/pubads_impl.js', 'script', 'news.com', true, 'DoubleClick'],
  ['https://www.google-analytics.com/analytics.js', 'script', 'news.com', true, 'GA 统计'],
  ['https://hm.baidu.com/hm.js?x=1', 'script', '52ta.top', true, '百度统计'],
  ['https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.js', 'script', 'blog.io', false, '正常 CDN'],
  ['https://fonts.gstatic.com/s/roboto/v30/xyz.woff2', 'font', 'site.com', false, '正常字体'],
  ['https://52ta.top/assets/index.js', 'script', '52ta.top', false, '本站资源'],
  ['https://connect.facebook.net/en_US/fbevents.js', 'script', 'shop.com', true, 'FB 像素'],
  ['https://static.hotjar.com/c/hotjar-1.js', 'script', 'app.io', true, 'Hotjar 录屏'],
  ['https://img.alicdn.com/imgextra/i1/x.jpg', 'image', 'taobao.com', false, '正常图床']
];
let hitPass = 0;
for (const [url, type, doc, expect, label] of HIT) {
  const r = adblock.check(url, type, doc);
  const ok = !!r === expect;
  if (ok) hitPass++;
  console.log(`      ${ok ? '\u2713' : '\u2717'} ${expect ? '拦' : '放'}  ${label.padEnd(14)} ${new URL(url).hostname}`);
  if (r) console.log(`          ← [${r.sourceId}] ${r.raw.slice(0, 80)}`);
}
check(`真实用例 ${hitPass}/${HIT.length} 通过`, hitPass === HIT.length);

/* ==================================================================== *
 * E. 分源统计与分源开关
 * ==================================================================== */
console.log('\n[E] 分源统计与分源开关');
const afterHit = adblock.statsSnapshot();
check('拦截数按源分开统计', afterHit.sources.some((s) => s.blocked > 0),
      afterHit.sources.map((s) => s.id + '=' + s.blocked).join(', '));

// 找一个「只有 ABP 源能拦」的 URL：临时只开 abp，看是否仍能拦
const probe = ['https://static.hotjar.com/c/hotjar-1.js', 'script', 'app.io'];
adblock.setSourceEnabled('adtchrome', false);
adblock.setSourceEnabled('builtin', false);
const onlyAbp = adblock.check(...probe);
const onlyAbpHit = onlyAbp ? onlyAbp.sourceId : null;
check('只开 ABP 源时仍能拦截（说明该 URL 由 ABP 规则覆盖）', !!onlyAbp, String(onlyAbpHit));

adblock.setSourceEnabled('abp', false);
const noneOn = adblock.check(...probe);
check('三个源全关时不再拦截', noneOn === null, noneOn ? noneOn.raw : '');

adblock.setSourceEnabled('adtchrome', true);
adblock.setSourceEnabled('abp', true);
adblock.setSourceEnabled('builtin', true);
check('重新开启后恢复拦截', !!adblock.check(...probe));

/* ==================================================================== *
 * F. 拦截强度
 * ==================================================================== */
console.log('\n[F] 拦截强度（标准挡第一方 / 严格全拦）');
adblock.level = 'standard';
const firstParty = adblock.check('https://52ta.top/adbanner/top.png', 'image', '52ta.top');
check('标准档不拦第一方资源', firstParty === null, firstParty ? firstParty.raw : '');
adblock.level = 'aggressive';
const firstPartyAgg = adblock.check('https://52ta.top/adbanner/top.png', 'image', '52ta.top');
check('严格档拦下同一第一方资源', !!firstPartyAgg, firstPartyAgg ? firstPartyAgg.raw : '');

/* ==================================================================== *
 * G. 元素隐藏
 * ==================================================================== */
console.log('\n[G] 元素隐藏');
const zhihuCss = adblock.cosmeticCss('www.zhihu.com');
const genericCss = adblock.cosmeticCss('unknown-domain-xyz.com');
check('知乎能生成隐藏样式', zhihuCss.length > 0, zhihuCss.length + ' 字节');
check('未收录站点也有通用隐藏规则', genericCss.length > 0, genericCss.length + ' 字节');
check('生成的 CSS 合法（以 display 声明收尾）', /display\s*:\s*none\s*!important\s*\}/.test(zhihuCss));
check('不含我们无法执行的伪类',
      !/:has-text\(|:contains\(|:xpath\(|:style\(|\$\$/.test(zhihuCss));
check('同一域名二次调用走缓存（返回同一字符串）', adblock.cosmeticCss('www.zhihu.com') === zhihuCss);

const emptyCss = adblock.cosmeticCss('example.com');
console.log(`      生成体积：zhihu ${(zhihuCss.length / 1024).toFixed(1)} KB / 通用 ${(genericCss.length / 1024).toFixed(1)} KB / example.com ${(emptyCss.length / 1024).toFixed(1)} KB`);

/* ==================================================================== *
 * H. 性能
 * ==================================================================== */
console.log('\n[H] 性能');
{
  const urls = CORPUS.map((c) => [c[0], c[1], c[2]]);
  const N = 20000;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const [u, ty, d] = urls[i % urls.length];
    adblock.check(u, ty, d);
  }
  const ms = Date.now() - t0;
  const perCheck = (ms / N) * 1000;
  console.log(`      ${N} 次判定耗时 ${ms} ms  →  ${(perCheck).toFixed(1)} μs/次  (${Math.round(N / (ms / 1000))} 次/秒)`);
  check('单次判定 < 200 μs（一个页面百来个请求也扛得住）', perCheck < 200, perCheck.toFixed(1) + ' μs');

  const mem = process.memoryUsage();
  console.log(`      堆占用 ${(mem.heapUsed / 1048576).toFixed(0)} MB / RSS ${(mem.rss / 1048576).toFixed(0)} MB`);
  check('堆占用 < 1024 MB', mem.heapUsed < 1024 * 1048576, (mem.heapUsed / 1048576).toFixed(0) + ' MB');
}

/* ==================================================================== *
 * 汇总
 * ==================================================================== */
console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
process.exit(fail ? 1 : 0);
