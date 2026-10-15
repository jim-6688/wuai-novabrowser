'use strict';
/**
 * 拖拽安装扩展 · 类型校验测试
 * 用法：node tools/test-ext-install-drop.js
 *
 * 拖拽装扩展这条路径（main.js 的 ext:install-path + 外壳的 drop 监听）只能
 * 真机点出来，但「什么文件算扩展包」这一步是纯逻辑，写成 isExtensionFile
 * 抽出来，正好用单测钉死。写错的表现是：用户拖进来一个 .zip 被当成普通文件
 * 忽略、或者反过来把一张截图当扩展去解包、报一串看不懂的 ZIP 错。
 *
 * 这里覆盖几件容易写错、写错了也看不出来的事：
 *   [A] 认得的四类扩展包（.crx / .crx3 / .zip / .xpi）
 *   [B] 认不出来的（普通文件、目录、无后缀）一律 false
 *   [C] 大小写 / 结尾空格不敏感
 *   [D] 与 main.js 里那条「同词」的判据对得上
 */
const path = require('path');
const { isExtensionFile } = require(path.join(__dirname, '..', 'src/main/extensions.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

(async () => {
  console.log('\n[A] 认得的扩展包');
  for (const f of ['tampermonkey.crx', 'ext.crx3', 'my-ext.zip', 'firefox.xpi',
    'C:\\Users\\x\\Downloads\\广告拦截.crx', '/home/x/abc.XPI']) {
    check('认得 ' + f, isExtensionFile(f) === true);
  }

  console.log('\n[B] 认不出来的');
  for (const f of ['readme.txt', 'photo.png', 'notes.md', 'script.user.js',
    'directory', 'no-extension', 'weird.tar.gz', '', null, undefined, 42]) {
    check('拒绝 ' + JSON.stringify(f), isExtensionFile(f) === false);
  }

  console.log('\n[C] 大小写 / 空格不敏感');
  check('.CRX（全大写）', isExtensionFile('X.CRX') === true);
  check('.Zip（大小写混排）', isExtensionFile('y.Zip') === true);
  check('文件名带尾随空格', isExtensionFile('z.crx ') === true);
  check('路径带尾随空格', isExtensionFile('z.crx  ') === true);

  console.log('\n[D] 与 main.js 的判据同词');
  const mainSrc = require('fs').readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
  check('main.js 用的是同一份 isExtensionFile，不是又抄了一遍字面量',
    /isExtensionFile\(p\)/.test(mainSrc) && /require\('\.\/extensions'\)/.test(mainSrc));

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n测试自身出错：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
