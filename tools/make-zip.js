#!/usr/bin/env node
/**
 * 把 electron-builder 产出的 Windows 安装包再压一层 ZIP。
 *
 * 为什么需要这一层：浏览器对「直接下载 .exe」会弹风险提示
 * （Edge/Chrome 的「不常下载的文件」），而 .zip 不在拦截名单里 ——
 * 同一个安装包，外面套一层压缩包，**下载环节**就干净了。
 * 解压出来仍是原来的 setup.exe，安装向导、快捷方式、卸载项一个不少。
 *
 * 说清楚边界：这只解决「下载」这一步。解压后双击安装时，
 * Windows 11 自带解压器会把「来自网络」标记传给解压产物，
 * 未签名的安装包仍可能触发 SmartScreen。根治要么买代码签名证书，
 * 要么让用户用 7-Zip 之类不传播该标记的工具解压 —— 后者不可控，
 * 所以这里只把它当作过渡手段。
 *
 * 用 PowerShell 的 Compress-Archive（Windows 内置）而不是引 zip 依赖：
 * 这个脚本一年只跑几次发布，不值得为它多一个 node_modules。
 *
 * 用法：npm run pc:zip        （打包 dist 里当前版本号的 setup.exe）
 *      node tools/make-zip.js --keep-exe=false   （预留：压完删掉源 exe）
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

const version = require(path.join(root, 'package.json')).version;
const exeName = `nova-pc-${version}-win-x64-setup.exe`;
const exePath = path.join(dist, exeName);
const zipName = `nova-pc-${version}-win-x64-setup.zip`;
const zipPath = path.join(dist, zipName);

if (!fs.existsSync(exePath)) {
  console.error(`找不到安装包：${exePath}`);
  console.error('先跑 npm run pc:build。');
  process.exit(1);
}

// Compress-Archive 的同名文件会直接报错，用 -Force 覆盖。
// CompressionLevel 取 Fastest：NSIS 安装包内部已经是 LZMA 压过的，
// 再压一遍收益不到 5%，不值得为此让发布多等几分钟。
// 单引号包裹、内部的单引号翻倍 —— PowerShell 里这样才不会做变量展开，
// 路径带中文或空格也安全。
const ps = (s) => `'${s.replace(/'/g, "''")}'`;
const script =
  `$ErrorActionPreference='Stop'; ` +
  `Compress-Archive -LiteralPath ${ps(exePath)} -DestinationPath ${ps(zipPath)} ` +
  `-CompressionLevel Fastest -Force`;

console.log(`打包 ${exeName} → ${zipName}`);
try {
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'inherit',
  });
} catch (err) {
  console.error('压缩失败：', err.message);
  process.exit(1);
}

const size = fs.statSync(zipPath).size;
const exeSize = fs.statSync(exePath).size;
console.log('');
console.log(`  ${zipName}`);
console.log(`  ${size.toLocaleString()} 字节（安装包本身 ${exeSize.toLocaleString()} 字节，` +
  `压缩率 ${(100 - (size / exeSize) * 100).toFixed(1)}%）`);
console.log('');
console.log('  下一步：算 sha256 填进 site/version.json，并把 zip 上传到 Gitee Release。');
console.log(`  node -e "const c=require('crypto'),f=require('fs');` +
  `console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" ${zipName}`);
