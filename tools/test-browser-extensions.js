'use strict';
/**
 * 「从已安装的浏览器导入扩展」的测试
 * 用法：node tools/test-browser-extensions.js
 *
 * 全部用假 fs —— 不依赖本机装了什么浏览器（那种测试换台机器就红）。
 * 真正要钉住的是**目录形状的识别**：Chromium 系的扩展是
 *   <User Data>/<Profile>/Extensions/<crxId>/<版本>/manifest.json
 * 少认一层、多认一层、或者把 Temp 当扩展，都会让这个功能报错的错。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const BX = require(path.join(__dirname, '..', 'src', 'main', 'browser-extensions.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

/* ---------------------------------------------------------------- 假 fs */
/**
 * 用一棵**嵌套**的表造出假 fs：键是绝对路径，值是这一层的内容
 * （对象 = 子项，字符串 = 文件内容）。
 *
 * <p>必须把它**递归展开**成「每个文件、每个目录各占一条路径」的扁平表。
 * 一开始我只登记了目录节点本身，于是
 * `existsSync('.../5.1.0/manifest.json')` 永远 false ——
 * 表现为「扫到 0 个扩展」，而日志里明明 readdir 出了一层层目录，
 * 很难一眼看出是假 fs 的问题而不是被测代码的问题。
 */
function makeFs(tree) {
  const flat = new Map();          // 绝对路径 → 值（对象=目录，字符串=文件）
  const walk = (obj, base) => {
    for (const [name, v] of Object.entries(obj)) {
      const full = path.resolve(path.join(base, name));
      flat.set(full, v);
      if (v && typeof v === 'object') walk(v, full);
    }
  };
  for (const [key, v] of Object.entries(tree)) {
    flat.set(path.resolve(key), v);
    if (v && typeof v === 'object') walk(v, key);
  }

  const kids = new Map();          // 目录 → 它的子项
  for (const full of flat.keys()) {
    const parent = path.dirname(full);
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(full);
  }

  return {
    readdirSync: (dir) => {
      const list = kids.get(path.resolve(dir));
      if (!list) throw new Error('ENOENT ' + dir);
      return list.map((full) => {
        const v = flat.get(full);
        return {
          name: path.basename(full),
          isDirectory: () => typeof v === 'object' && v !== null,
          isFile: () => typeof v === 'string'
        };
      });
    },
    existsSync: (p) => flat.has(path.resolve(p)),
    readFileSync: (p) => {
      const v = flat.get(path.resolve(p));
      if (typeof v !== 'string') throw new Error('EISDIR/ENOENT ' + p);
      return v;
    },
    mkdirSync: () => {},
    copyFileSync: () => {},
    rmSync: () => {}
  };
}

const EDGE = 'C:\\Users\\x\\AppData\\Local\\Microsoft\\Edge\\User Data';
const CHROME = 'C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data';

function buildTree() {
  const t = {};
  const put = (p, v) => { t[path.resolve(p)] = v; };

  // Edge：Default 下有两个扩展，其中一个有两个版本；外加一个 Temp 目录
  put(path.join(EDGE, 'Default'), {});
  put(path.join(EDGE, 'Default', 'Extensions'), {});
  put(path.join(EDGE, 'Default', 'Extensions', 'Temp'), {});
  put(path.join(EDGE, 'Default', 'Extensions', 'iikmkjmpaadaobahmlepeloendndfphd'), {});
  put(path.join(EDGE, 'Default', 'Extensions', 'iikmkjmpaadaobahmlepeloendndfphd', '5.1.0'),
    { 'manifest.json': JSON.stringify({ name: 'Tampermonkey', version: '5.1.0', manifest_version: 3 }) });
  put(path.join(EDGE, 'Default', 'Extensions', 'abcdefghijklmnopabcdefghijklmnop'), {});
  put(path.join(EDGE, 'Default', 'Extensions', 'abcdefghijklmnopabcdefghijklmnop', '1.0.0'),
    { 'manifest.json': JSON.stringify({ name: '旧版', version: '1.0.0', manifest_version: 3 }) });
  put(path.join(EDGE, 'Default', 'Extensions', 'abcdefghijklmnopabcdefghijklmnop', '1.2.0'),
    { 'manifest.json': JSON.stringify({ name: '新版', version: '1.2.0', manifest_version: 3 }) });

  // Edge 的第二个 profile 里也有一个
  put(path.join(EDGE, 'Profile 1'), {});
  put(path.join(EDGE, 'Profile 1', 'Extensions'), {});
  put(path.join(EDGE, 'Profile 1', 'Extensions', 'ponmlkjihgfedcbaponmlkjihgfedcba'), {});
  put(path.join(EDGE, 'Profile 1', 'Extensions', 'ponmlkjihgfedcbaponmlkjihgfedcba', '2.0.0'),
    { 'manifest.json': JSON.stringify({ name: '工作用扩展', version: '2.0.0', manifest_version: 2 }) });

  // 一个不是扩展的业务目录（不该被认成 profile）
  put(path.join(EDGE, 'System Profile'), {});
  put(path.join(EDGE, 'System Profile', 'Extensions'), {});

  // Chrome：一个扩展
  put(path.join(CHROME, 'Default'), {});
  put(path.join(CHROME, 'Default', 'Extensions'), {});
  put(path.join(CHROME, 'Default', 'Extensions', 'dhdgffkkebhmkfjojejmpbldmpobfkfo'), {});
  put(path.join(CHROME, 'Default', 'Extensions', 'dhdgffkkebhmkfjojejmpbldmpobfkfo', '9.9.9'),
    { 'manifest.json': JSON.stringify({ name: 'Chrome 侧的那个', version: '9.9.9', manifest_version: 3 }) });
  return t;
}

console.log('\n[A] 扫描');

/* 注入假的浏览器表：真实的 resolve() 取的是环境变量里的**本机**路径，
   而我们的假树在别处。不注入的话这个测试就变成「看跑测试的机器装了什么」。 */
const FAKE_BROWSERS = [
  { id: 'chrome', name: 'Chrome', format: 'chromium-json', resolve: () => CHROME },
  { id: 'edge', name: 'Edge', format: 'chromium-json', resolve: () => EDGE },
  // 火狐是 sqlite 那一路，不该被这个模块碰
  { id: 'firefox', name: 'Firefox', format: 'sqlite', resolve: () => path.join(EDGE, 'ff') }
];
const scanWith = (tree) => BX.scan({ fs: makeFs(tree), browsers: FAKE_BROWSERS });

const found = scanWith(buildTree());
/* 刻意**不**写成 `|| {}`：那样 `!!byName('x')` 永远为真（空对象也是真），
   于是「扫到了某个扩展」这类断言会假通过。真正的存在性用 name 比对。 */
const byName = (n) => found.find((x) => x.name === n);
const has = (n) => found.some((x) => x.name === n);

check('扫到了 Edge 与 Chrome 两边的扩展', found.length === 4, found.length + ' 个');
check('Temp 目录不被当成扩展', !found.some((x) => x.crxId === 'Temp'));
check('System Profile 不算用户 profile', !found.some((x) => x.profile === 'System Profile'));
check('Profile 1 里的也被扫到', has('工作用扩展'), found.map((x) => x.profile).join(' '));
check('Chrome 那边的也在（不只 Edge）', has('Chrome 侧的那个'));

check('一个扩展有多个版本时取**新版**', has('新版') && !has('旧版'),
  found.map((x) => x.name).join(' '));

check('带上浏览器名与 crxId，便于界面显示与去重',
  has('Tampermonkey') && byName('Tampermonkey').browser === 'Edge'
  && byName('Tampermonkey').crxId === 'iikmkjmpaadaobahmlepeloendndfphd');
check('带上 manifest 版本', has('Tampermonkey') && byName('Tampermonkey').manifestVersion === 3);
check('带 Manifest V2 的也认', has('工作用扩展') && byName('工作用扩展').manifestVersion === 2);
check('火狐那条路不被碰（它的布局完全不同）', !found.some((x) => x.browserId === 'firefox'));

console.log('\n[B] key 与去重');

const keys = found.map((x) => x.key);
check('每个都有 key', keys.every(Boolean) && keys.length === new Set(keys).size, keys.join(' '));
check('key 里含浏览器标识（同一个扩展装在两处不会撞）',
  keys.includes('edge:iikmkjmpaadaobahmlepeloendndfphd'));

console.log('\n[C] 空与异常');

check('一个浏览器都没装时返回空数组', scanWith({}).length === 0);
{
  // Extensions 目录存在但里面什么都没有
  const t = {};
  t[path.resolve(path.join(EDGE, 'Default', 'Extensions'))] = {};
  check('Extensions 目录是空的也不炸', scanWith(t).length === 0);
}
{
  // manifest.json 坏了：跳过这一个，不能让整次扫描失败
  const t = {};
  t[path.resolve(path.join(EDGE, 'Default', 'Extensions', 'iikmkjmpaadaobahmlepeloendndfphd', '1.0'))] =
    { 'manifest.json': '{ 这不是 JSON' };
  check('manifest 坏掉时只跳过那一个，不整体失败', scanWith(t).length === 0);
}
{
  // 版本目录里没有 manifest.json（Chromium 有时留半成品目录）
  const t = {};
  t[path.resolve(path.join(EDGE, 'Default', 'Extensions', 'iikmkjmpaadaobahmlepeloendndfphd', '1.0'))] =
    { 'other.txt': 'x' };
  check('没有 manifest.json 的版本目录不算扩展', scanWith(t).length === 0);
}

console.log('\n[D] 导入到自己的目录');

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-bx-'));
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, '_metadata'), { recursive: true });
  fs.mkdirSync(path.join(src, 'js'), { recursive: true });
  fs.writeFileSync(path.join(src, 'manifest.json'), '{"name":"T"}');
  fs.writeFileSync(path.join(src, '_metadata', 'verified_contents.json'), '{}');
  fs.writeFileSync(path.join(src, 'js', 'a.js'), 'x');

  const work = path.join(tmp, 'work');
  fs.mkdirSync(work, { recursive: true });
  const dest = BX.importToOneDir(
    { dir: src, name: 'Test Ext', crxId: 'a'.repeat(32), version: '1.0' }, work);

  check('复制到了 workDir 下', path.dirname(dest) === work, dest);
  check('manifest 复制过来了', fs.existsSync(path.join(dest, 'manifest.json')));
  check('子目录也复制了', fs.existsSync(path.join(dest, 'js', 'a.js')));
  check('**跳过 _metadata**（那是 Chromium 的校验信息，不是扩展的一部分）',
    !fs.existsSync(path.join(dest, '_metadata')));
  check('目录名是确定的（同一来源重复导入会复用，不越攒越多）',
    BX.importToOneDir({ dir: src, name: 'Test Ext', crxId: 'x', version: '1.0' }, work) === dest);
  check('名字里的非法字符被换掉',
    !/[\\/:*?"<>|]/.test(path.basename(dest)), path.basename(dest));

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
