'use strict';
/**
 * 桌面快捷方式（免安装首启补建）测试
 * 用法：node tools/test-desktop-shortcut.js
 *
 * 这个功能的失败方式特别安静：图标没出现，用户只会觉得「这版没做这件事」，
 * 控制台里一句话也没有。所以这里测的不是「函数能跑起来」，而是几件容易写错、
 * 写错了也看不出来的事：
 *
 *   [B] 该动手的场合真动手（Windows + 打包后 + 没办过），其余一律不动
 *   [C] 建出来的链接指向对的东西（exe、工作目录、图标、AUMID）
 *   [D] 桌上**已经有**图标时不许覆盖 —— 那个图标用户可能改过名字、挪过位置、
 *       钉过任务栏；覆盖掉就是把他的设置冲了
 *   [E] 写失败不许打标。打了标就等于「永远不建了」，一次偶发失败会变成永久缺陷
 *   [F] 名字的三份来源逐字比一遍
 *
 * [F] 值得单列：`productName`、`build.nsis.shortcutName`、以及模块里的默认名是
 * 三份独立的字面量，NSIS 那份甚至没法引用常量。少一个「浏览器」三个字，
 * 桌面上就会并排出现两个图标，而两个都「能打开 Nova」—— 没人会为此开 issue。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const P = (rel) => path.join(root, rel);

const {
  SHORTCUT_BASENAME, shortcutFileName, shouldInstall, linkOptions, ensureShortcut
} = require(P('src/main/desktop-shortcut.js'));
const PKG = require(P('package.json'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

/** 造一个干净的「桌面」目录；用完统一删。 */
const tmpDirs = [];
const newDesktop = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-shortcut-'));
  tmpDirs.push(d);
  return d;
};

(async () => {
  const NAME = shortcutFileName(PKG.productName);
  // 绿色版的典型位置：用户的「下载」文件夹，路径里有中文也有空格。
  // 拿它当样本是因为 shell.writeShortcutLink 收的是完整路径，这些字符会原样进去。
  const EXE = 'C:\\Users\\someone\\Downloads\\Nova 浏览器\\吾爱Nova浏览器.exe';

  console.log('\n[A] 文件名');
  check('默认名就是《吾爱Nova浏览器.lnk》',
    shortcutFileName() === SHORTCUT_BASENAME + '.lnk', shortcutFileName());
  check('传入产品名就按产品名来（主进程传的是 package.json 的 productName）',
    shortcutFileName('某某浏览器') === '某某浏览器.lnk');
  check('空值回落成默认名，不是造出「.lnk」这种没有主名的文件',
    shortcutFileName('') === SHORTCUT_BASENAME + '.lnk' && shortcutFileName(null) === SHORTCUT_BASENAME + '.lnk');

  console.log('\n[B] 三道闸：该不该动手');
  const gate = (o) => shouldInstall(Object.assign({ platform: 'win32', packaged: true, done: false }, o));
  check('Windows + 打包后 + 从没办过 → 动手', gate({}) === true);
  check('开发环境（npm start 跑的是 node_modules 里的 electron.exe）→ 一次都不动',
    gate({ packaged: false }) === false);
  check('macOS / Linux → 不动（writeShortcutLink 在这两个平台没有实现）',
    gate({ platform: 'darwin' }) === false && gate({ platform: 'linux' }) === false);
  check('已经办过（用户删了图标是他自己的决定）→ 不再自作主张补回来',
    gate({ done: true }) === false);
  check('done 传 1 / true 都认（落盘回来的是数字，内存里可能是布尔）',
    gate({ done: 1 }) === false && gate({ done: true }) === false);
  check('done 为 undefined / 0 时不算办过', gate({ done: undefined }) === true && gate({ done: 0 }) === true);

  console.log('\n[C] 链接指向哪');
  const opts = linkOptions({ exePath: EXE, description: PKG.productName, appId: 'top.wuai.nova' });
  check('目标就是当前这个 exe', opts.target === EXE);
  check('工作目录跟着 exe 走', opts.cwd === path.dirname(EXE), opts.cwd);
  check('图标指回 exe 自己（打包时已经嵌了 nova.ico，不多带一份图标文件）',
    opts.icon === EXE && opts.iconIndex === 0);
  check('描述用产品名', opts.description === PKG.productName);
  check('AUMID 与 electron-builder 的 appId 一致（否则任务栏会把同一个应用算成两个）',
    opts.appUserModelId === 'top.wuai.nova');
  const noId = linkOptions({ exePath: EXE });
  check('没有 appId 时**不带**这个字段 —— 传空串会把「按 target 推断」这条路堵掉',
    !('appUserModelId' in noId));
  check('描述缺省时回落到默认名，不会写进 undefined',
    noId.description === SHORTCUT_BASENAME);

  console.log('\n[D] 落盘行为（真临时目录 + 注入的 writeLink）');
  const desktopA = newDesktop();
  const calls = [];
  const created = ensureShortcut({
    desktopDir: desktopA, name: NAME, exePath: EXE, description: PKG.productName,
    appId: 'top.wuai.nova',
    writeLink: (lnk, o) => { calls.push({ lnk, o }); return true; }
  });
  check('桌上没有 → 建一个', created === 'created', created);
  check('  路径 = 桌面目录 + 那一个文件名', calls.length === 1 && calls[0].lnk === path.join(desktopA, NAME));
  check('  传下去的就是 linkOptions 那一份', calls[0] && calls[0].o.target === EXE);

  console.log('\n[E] 桌上已经有同名图标 —— 一个字节都不改');
  // 上面那次是 stub，不会真落文件；这里手动放一个，模拟「安装器建的」或
  // 「用户自己右键建的」。文件内容故意是脏的：真被覆盖了，内容会变。
  fs.writeFileSync(path.join(desktopA, NAME), 'user-owned');
  const overwriteCalls = [];
  const again = ensureShortcut({
    desktopDir: desktopA, name: NAME, exePath: EXE,
    writeLink: (lnk) => { overwriteCalls.push(lnk); return true; }
  });
  check('读到「已有」→ 报 exists', again === 'exists', again);
  check('  一次都没调用写（用户改过名字、钉过任务栏的那个图标保住了）', overwriteCalls.length === 0);
  check('  文件内容原样，没被重写成新链接',
    fs.readFileSync(path.join(desktopA, NAME), 'utf8') === 'user-owned');

  console.log('\n[F] 写失败：不打标，下次启动还会再试');
  const desktopB = newDesktop();
  const refused = ensureShortcut({
    desktopDir: desktopB, name: NAME, exePath: EXE, writeLink: () => false
  });
  check('writeShortcutLink 返回 false（桌面只读 / 组策略限制）→ failed', refused === 'failed', refused);
  const desktopC = newDesktop();
  const threw = ensureShortcut({
    desktopDir: desktopC, name: NAME, exePath: EXE,
    writeLink: () => { throw new Error('EACCES: permission denied'); }
  });
  check('writeShortcutLink 抛异常 → 同样 failed，不往启动流程上抛', threw === 'failed', threw);
  check('  失败时桌面上不留半个文件', !fs.existsSync(path.join(desktopB, NAME)) && !fs.existsSync(path.join(desktopC, NAME)));

  console.log('\n[G] 快捷方式名字的三份来源必须同词');
  check('模块默认名 == package.json 的 productName',
    SHORTCUT_BASENAME === PKG.productName, `${SHORTCUT_BASENAME} vs ${PKG.productName}`);
  check('NSIS 的 shortcutName 也是同一个词（那边只能写字面量，改一处必须改另一处）',
    PKG.build && PKG.build.nsis && PKG.build.nsis.shortcutName === SHORTCUT_BASENAME,
    PKG.build && PKG.build.nsis && PKG.build.nsis.shortcutName);
  check('主进程真的用的是 productName 这一份（不是又抄了一遍别的字面量）',
    /shortcutFileName\(PKG\.productName\)/.test(fs.readFileSync(P('src/main/main.js'), 'utf8')));

  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也不影响 */ } }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n测试自身出错：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
