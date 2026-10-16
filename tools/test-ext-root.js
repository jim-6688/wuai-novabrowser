'use strict';
/**
 * 扩展根目录定位的测试
 * 用法：node tools/test-ext-root.js
 *
 * 背景：zip / xpi 绝大多数是「单层包裹」结构 —— 包里最外层是一个与扩展同名的
 * 目录，manifest.json 在它里面。而 extractZip 原样保留包内结构，所以解到
 * workDir 之后真正的根是 workDir/扩展名/。曾因此对**每一个正常的包**
 * 报「扩展目录内缺少 manifest.json」。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const mod = require(path.join(__dirname, '..', 'src', 'main', 'extensions.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

// 这个模块只在被 Electron 主进程 require 时导出内部函数，
// 纯 node 环境下拿不到 —— 那就退化成「只测能测的」，不假装测到了。
const R = mod.resolveExtensionRoot;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-ext-'));
const mk = (rel, content) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content || '{}');
  return p;
};

console.log('\n[A] 扩展根定位');

if (typeof R !== 'function') {
  console.log('  SKIP  resolveExtensionRoot 未导出 —— 以下用例无法在纯 node 下运行。');
  console.log('        （这是有意的：生产构建里它是内部函数，不进公共 API。）');
} else {
  // 1. 目录本身就有 manifest.json —— 最简单的情形
  const flat = path.join(tmp, 'flat');
  mk('flat/manifest.json', '{"name":"flat"}');
  const r1 = R(flat);
  check('目录本身含 manifest.json 时原样返回（depth 0）',
    r1 && r1.dir === flat && r1.depth === 0);

  // 2. **单层包裹** —— 这就是那个 bug 的真实形状
  const wrapped = path.join(tmp, 'wrapped');
  mk('wrapped/MyExt/manifest.json', '{"name":"wrapped"}');
  mk('wrapped/MyExt/content.js', '');
  const r2 = R(wrapped);
  check('单层包裹（扩展名/manifest.json）能定位到里层',
    r2 && r2.dir === path.join(wrapped, 'MyExt') && r2.depth === 1, r2 && path.basename(r2.dir));

  // 3. 真实 zip 的形状：只有一层子目录，且里面不止 manifest.json
  const likeZip = path.join(tmp, 'likezip');
  mk('likezip/adblock-plus/manifest.json', '{"name":"ABP"}');
  mk('likezip/adblock-plus/js/background.js', '');
  mk('likezip/adblock-plus/_locales/zh_CN/messages.json', '{}');
  check('多文件、多子目录的真实包结构也能定位',
    R(likeZip) && R(likeZip).depth === 1 && path.basename(R(likeZip).dir) === 'adblock-plus');

  // 4. 没有 manifest —— 必须返回 null（而不是乱指一个目录）
  const noManifest = path.join(tmp, 'nomanifest');
  fs.mkdirSync(path.join(noManifest, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(noManifest, 'README.md'), 'hi');
  check('整棵树都没有 manifest.json 时返回 null', R(noManifest) === null);

  // 5. 只往下找**一层**：两层的包不该被误定位
  const twoDeep = path.join(tmp, 'twodeep');
  mk('twodeep/outer/inner/manifest.json', '{"name":"deep"}');
  check('嵌套两层时返回 null（刻意不递归：再深就不是真实世界的样子）',
    R(twoDeep) === null);

  // 6. 多个子目录时取第一个含 manifest 的（顺序稳定，不随机）
  const multi = path.join(tmp, 'multi');
  mk('multi/a/manifest.json', '{"name":"a"}');
  mk('multi/b/manifest.json', '{"name":"b"}');
  const r6 = R(multi);
  check('多个候选目录时取第一个', r6 && path.basename(r6.dir) === 'a', r6 && path.basename(r6.dir));

  // 7. 顶层有同名 .json 但不是 manifest —— 不能误判
  const tricky = path.join(tmp, 'tricky');
  mk('tricky/manifest.json5', '{}');
  check('只有 manifest.json5 时不算扩展（后缀不同）', R(tricky) === null);

  // 8. 用一个**真实的**商店扩展跑一遍（用户实测的那个包）
  //    DeepSider 3.0.6：434 个文件、103 个顶层条目、manifest_v3、中文名走
  //    __MSG_ext_title__ 占位符。商店包的目录形态各不相同（这个是扁平的，
  //    而网上多数 zip 是单层包裹），所以两种都要能用。
  const realCrx = path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    'Downloads', 'dfbnddndcmilnhdfmmaolepiaefacnpo',
    'dfbnddndcmilnhdfmmaolepiaefacnpo_3.0.6_chrome.zzzmh.cn.crx'
  );
  if (fs.existsSync(realCrx) && typeof mod.stripCrxHeader === 'function') {
    const { zip } = mod.stripCrxHeader(fs.readFileSync(realCrx));
    const work = path.join(tmp, 'realflat');
    fs.mkdirSync(work, { recursive: true });
    mod.extractZip(Buffer.from(zip), work);

    const rf = R(work);
    check('真实商店扩展（扁平形态）能定位到根', rf && rf.depth === 0, rf && path.basename(rf.dir));
    if (rf) {
      const m = JSON.parse(fs.readFileSync(rf.manifest, 'utf8'));
      const name = mod.resolveMessage(rf.dir, m, m.name);
      check('真实扩展的中文名解析出来（zh_CN 优先于 default_locale=en）',
        name && name.indexOf('__MSG') < 0 && /[\u4e00-\u9fa5]/.test(name), name);
      check('真实扩展的 id 派生得出来且不含 __MSG 残留',
        /^[a-z0-9-]+$/.test(String(name || '').replace(/[^\w-]+/g, '-').toLowerCase()));
    }

    // 同一个扩展，**包一层**之后再试 —— 那是 manifest 报错的那一类
    const inner = path.join(tmp, 'realinner');
    fs.renameSync(work, inner);
    fs.mkdirSync(work, { recursive: true });
    fs.renameSync(inner, path.join(work, 'DeepSider'));
    check('workDir 根下确实没有 manifest.json（复现了那个报错的前提）',
      !fs.existsSync(path.join(work, 'manifest.json')));
    const rw = R(work);
    check('真实扩展（单层包裹形态）同样能定位到里层',
      rw && rw.depth === 1 && path.basename(rw.dir) === 'DeepSider');
  } else {
    console.log('  SKIP  真实扩展包不在本机 Downloads 下，跳过这 5 项');
  }
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);