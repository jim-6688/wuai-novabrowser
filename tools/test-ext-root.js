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

console.log('\n[B] 在目录里找扩展包（用户选中「装着 crx 的文件夹」时）');

if (typeof mod.findPackagesIn !== 'function') {
  console.log('  SKIP  findPackagesIn 未导出');
} else {
  const F = mod.findPackagesIn;
  // 用户真实的那种落盘形态：一个文件夹里躺着那个 .crx
  const dl = path.join(tmp, 'downloads');
  mk('downloads/DeepSider_3.0.6.crx', 'x');
  check('目录里躺着 .crx 时能找到它', F(dl).length === 1 && /\.crx$/.test(F(dl)[0]));
  check('找到的是绝对路径', path.isAbsolute(F(dl)[0]));

  // 混着别的文件：只挑包的
  mk('downloads/readme.txt', 'x');
  mk('downloads/photo.png', 'x');
  mk('downloads/note.md', 'x');
  check('忽略非包文件（txt / png / md）', F(dl).length === 1, F(dl).map((x) => path.basename(x)).join(' '));

  // 多个包：按文件名排序，顺序稳定
  mk('downloads/b_pack.zip', 'x');
  mk('downloads/a_pack.xpi', 'x');
  const many = F(dl);
  // 顺序是**按文件名的码位**排的，所以大写在前（D < a）—— 这点要写清：
  // 一开始我按「人眼的字母序」预期 a_pack 在最前，于是断言红了而代码是对的。
  // 这里要钉的是「确定性」，不是某个特定的字母序。
  check('多个包时按文件名排序（顺序稳定、可复现）',
    many.length === 3
      && /DeepSider_3\.0\.6\.crx$/.test(many[0])
      && /a_pack\.xpi$/.test(many[1])
      && /b_pack\.zip$/.test(many[2]),
    many.map((x) => path.basename(x)).join(' '));
  check('同样的目录连查两次，顺序一致（不是文件系统的枚举顺序）',
    JSON.stringify(F(dl)) === JSON.stringify(F(dl)));

  // 不递归：子目录里的包不算
  mk('downloads/nested/deep.crx', 'x');
  check('只看本层、不递归（子目录里的包不算）',
    F(dl).length === 3 && !F(dl).some((p) => /deep\.crx$/.test(p)));

  check('空目录返回空数组', F(path.join(tmp, 'empty-dir-nonexistent')).length === 0);
  check('传文件路径（而不是目录）时返回空数组', F(path.join(dl, 'readme.txt')).length === 0);
}

console.log('\n[C] 「不像扩展的目录」与「像扩展的目录」要分得开');

if (typeof mod.findPackagesIn === 'function' && typeof R === 'function') {
  // 已解包的扩展目录：里面若恰好有个 .zip，不该被当成「装着包的文件夹」
  const unpacked = path.join(tmp, 'unpacked-with-zip');
  mk('unpacked-with-zip/manifest.json', '{"name":"u"}');
  mk('unpacked-with-zip/some-bundle.zip', 'x');
  check('已解包目录能被 resolveExtensionRoot 认出来（该走「目录本身就是扩展」那条路）',
    !!R(unpacked) && R(unpacked).depth === 0);
  check('……而它里面确实也有个 .zip（所以判据必须是「本身不像扩展」而不是「有没有 zip」）',
    mod.findPackagesIn(unpacked).length === 1);
}

console.log('\n[D] 解包目录的名字（决定重启能不能直接复用，不再每次解一遍）');

if (typeof mod.unpackDirFor !== 'function') {
  console.log('  SKIP  unpackDirFor 未导出');
} else {
  const UD = mod.unpackDirFor;
  // 用一个真实的目录当 workDir：假路径（比如 '/w'）在 Windows 上会被
  // resolve 成 'C://w'，拿它比对会得到一条假失败
  const WD = path.join(tmp, 'workdir');
  const a1 = UD(WD, 'C:/dl/DeepSider.crx');
  const a2 = UD(WD, 'C:/dl/DeepSider.crx');
  check('同一来源路径 → 同一个目录名（这是「重启复用」的前提）', a1 === a2, a1);

  // 旧写法是 `${base}-${Date.now()}`，同一个包每次启动都新建一个目录，
  // 于是 userData 里静静涨着几十份解包产物
  check('目录名里不含时间戳之类每次都变的东西', !/\d{10,}/.test(a1), a1);

  const b = UD(WD, 'D:/下载/DeepSider.crx');
  check('不同来源路径但同名 → 目录不同（否则两个扩展互相覆盖）', a1 !== b, b);

  const weird = UD(WD, 'C:/dl/a:b*c?.crx');
  check('路径里不允许的字符被换掉（Windows 上否则建不出目录）',
    !/[\\/:*?"<>|]/.test(path.basename(weird)), path.basename(weird));

  check('都落在给定的 workDir 下', path.dirname(a1) === WD, path.dirname(a1));
}

console.log('\n[E] 界面入口路径解析（决定「打开界面」按钮出不出得来）');
if (typeof mod.readUiPaths !== 'function') {
  console.log('  SKIP  readUiPaths 未导出');
} else {
  const U = mod.readUiPaths;
  // side_panel 型扩展（豆包/Cici、DeepSider）：主界面必须是 side_panel.html
  const sp = U({ side_panel: { default_path: 'side_panel.html' },
    action: { default_popup: 'popup.html' }, options_ui: { page: 'options.html' } });
  check('三者都有时 primary 取 side_panel（侧边栏型扩展的主界面）', sp.primary === 'side_panel.html');
  check('sidePanel / popup / options 各自分开记', sp.sidePanel === 'side_panel.html' && sp.popup === 'popup.html' && sp.options === 'options.html');
  // 只有 action 弹窗的扩展
  const pop = U({ action: { default_popup: 'popup.html' } });
  check('没有 side_panel 时 primary 落到 action 弹窗', pop.primary === 'popup.html' && pop.sidePanel === null);
  // 只有选项页的扩展
  const opt = U({ options_ui: { page: 'options.html' } });
  check('只有选项页时 primary 落到 options', opt.primary === 'options.html');
  // 三样都没有的扩展 —— 这时不该有「打开界面」按钮
  const none = U({ name: 'x' });
  check('三样都没有时 primary 为 null（渲染层据此不显示「打开界面」）', none.primary === null);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);