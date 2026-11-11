'use strict';
/**
 * 官网插件目录（src/main/ext-catalog.js）的纯逻辑单测。
 *
 * 与 ext-store.js / updater.js 同一约定：模块不碰 electron，网络由
 * fetchImpl 注入，所以这里能在普通 Node 进程里把「多源回退 / 地址白名单 /
 * 字段兜底」全跑一遍，不用起服务也不用真联网。
 */
const path = require('path');
const fs = require('fs');
const cat = require('../src/main/ext-catalog');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const ID32 = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';

console.log('\n[ext-catalog] 目录地址与归一化');

check('主源是官网 extensions.json',
  cat.CATALOG_URLS[0] === 'https://nova.52ta.top/extensions.json');
check('一共三个源（官网 / Gitee / GitHub），按顺序回退',
  cat.CATALOG_URLS.length === 3
  && /gitee\.com/.test(cat.CATALOG_URLS[1])
  && /raw\.githubusercontent\.com/.test(cat.CATALOG_URLS[2]));

check('null / 非数组 items 一律判为坏清单',
  cat.normalize(null) === null && cat.normalize({ items: 'oops' }) === null);
check('空目录是合法结果（空数组，不是 null）',
  Array.isArray(cat.normalize({ items: [] })) && cat.normalize({ items: [] }).length === 0);

const one = cat.normalize({
  updatedAt: '2026-11-11',
  items: [{ id: 'a', name: '插件 A', installUrl: ID32 }]
});
check('合法条目收成界面能用的形状',
  one.length === 1 && one[0].id === 'a' && one[0].installUrl === ID32);
check('缺省字段有兜底，不会把 undefined 渲染到界面上',
  one[0].developer === '未知开发者' && one[0].category === '其它'
  && one[0].mark === 'E' && one[0].accent === '#3D6BFF'
  && one[0].source === '来源未标注' && Array.isArray(one[0].tags)
  && one[0].featured === false);

check('没有安装地址的条目直接丢掉（装不上的卡片不该出现）',
  cat.normalize({ items: [
    { id: 'noid', name: 'X' },
    { name: 'Y', installUrl: ID32 },
    { id: 'z', installUrl: '' }
  ] }).length === 0);

check('32 位扩展 ID 原样保留，交给 parseStoreInput 解析',
  cat.resolveInstallUrl({ installUrl: ID32 }) === ID32);
check('http(s) 详情页 / 直链保留',
  cat.resolveInstallUrl({ installUrl: 'https://example.com/x.crx' })
    === 'https://example.com/x.crx');
check('官网相对包路径按站点根补全',
  cat.resolveInstallUrl({ packageUrl: 'download/ext/a.crx' })
    === 'https://nova.52ta.top/download/ext/a.crx');
check('packageUrl 优先于 installUrl（官网自托管包走这条）',
  cat.resolveInstallUrl({ packageUrl: 'download/ext/a.crx', installUrl: ID32 })
    === 'https://nova.52ta.top/download/ext/a.crx');

['javascript:alert(1)', 'file:///C:/evil.crx', 'data:text/plain,hi',
  'ftp://x/a.crx', 'download/ext/a.exe', ''].forEach((bad) => {
  check('危险 / 不认得的安装地址被挡：' + (bad || '(空)'),
    cat.resolveInstallUrl({ installUrl: bad }) === '');
});

check('重复 id 只留一条',
  cat.normalize({ items: [
    { id: 'dup', name: 'A', installUrl: ID32 },
    { id: 'dup', name: 'B', installUrl: ID32 }
  ] }).length === 1);

const many = [];
for (let i = 0; i < 70; i++) many.push({ id: 'x' + i, installUrl: ID32 });
check('条数封顶 60，防止坏清单把设置页撑爆',
  cat.normalize({ items: many }).length === cat.MAX_ITEMS);

const shaped = cat.normalize({ items: [{
  id: 's', installUrl: ID32,
  mark: '插件图标', accent: 'red', tags: ['1', '2', '3', '4', '5', 6],
  featured: 'yes'
}] })[0];
check('mark 截断、accent 校验、tags 限 4 且只收字符串、featured 布尔化',
  shaped.mark.length === 2 && shaped.accent === '#3D6BFF'
  && shaped.tags.length === 4 && shaped.tags.every((t) => typeof t === 'string')
  && shaped.featured === true);

console.log('\n[ext-catalog] 多源读取（注入 fetchImpl）');

(async () => {
  let calls = [];
  let r = await cat.load({
    urls: ['https://a', 'https://b'],
    fetchImpl: async (url) => { calls.push(url); return { updatedAt: 'D', items: [{ id: 'a', installUrl: ID32 }] }; }
  });
  check('第一个源成功即停，不再请求备用源',
    r.ok && r.items.length === 1 && r.updatedAt === 'D' && calls.length === 1 && r.url === 'https://a');

  calls = [];
  r = await cat.load({
    urls: ['https://a', 'https://b'],
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === 'https://a') throw new Error('502');
      return { items: [{ id: 'b', installUrl: ID32 }] };
    }
  });
  check('主源失败自动回退到备用源',
    r.ok && r.url === 'https://b' && calls.length === 2);

  r = await cat.load({
    urls: ['https://a'],
    fetchImpl: async () => { throw new Error('timeout'); }
  });
  check('全源失败返回固定形状，不抛异常、不缓存半截结果',
    r.ok === false && Array.isArray(r.items) && r.items.length === 0
    && /官网插件目录暂时读取不到/.test(r.error) && /timeout/.test(r.error));

  calls = [];
  r = await cat.load({
    urls: ['https://a', 'https://b'],
    fetchImpl: async (url) => { calls.push(url); return url === 'https://a' ? { nope: 1 } : { items: [] }; }
  });
  check('清单格式不对会换下一个源；空目录也算成功',
    r.ok === true && r.items.length === 0 && calls.length === 2 && r.url === 'https://b');

  r = await cat.load({
    urls: ['https://a'],
    fetchImpl: async () => ({ items: [{ id: 'ok', installUrl: ID32 }, { id: 'bad' }] })
  });
  check('单条坏数据不影响整份目录',
    r.ok && r.items.length === 1 && r.items[0].id === 'ok');

  console.log('\n[ext-catalog] 官网清单本体');
  const file = path.join(__dirname, '..', 'site', 'extensions.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = cat.normalize(raw);
  check('site/extensions.json 能解析且每条都带可用安装地址',
    Array.isArray(items) && items.length === 3
    && items.every((x) => x.installUrl && x.name));
  check('清单标了更新日期', /^\d{4}-\d{2}-\d{2}$/.test(raw.updatedAt || ''));

  console.log(`\n[ext-catalog] ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('[ext-catalog] 单测自身异常：', err);
  process.exit(1);
});
