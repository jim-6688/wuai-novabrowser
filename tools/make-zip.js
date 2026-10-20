#!/usr/bin/env node
/**
 * 把 electron-builder 产出的**免安装（绿色）版**再压一层 ZIP 发布。
 *
 * 这一层压的是 `dist/win-unpacked/` —— 解压出来直接双击 `吾爱Nova浏览器.exe`
 * 就能跑，不用装。之所以要有它：很多用户要的就是「绿色免安装」，不想走
 * 安装向导、不想写注册表/开始菜单。安装包（setup.exe）仍单独留着，谁想正式
 * 安装就下 exe，谁想免安装就下这个 zip —— 两个都发。
 *
 * 说清楚边界：这里的「绿色」指**免安装**（解压即用），数据仍存当前用户的
 * 应用数据目录（%APPDATA%），不是「整个软件装在 U 盘、数据也跟着走」那种
 * 全便携。要后者得另做 portable 数据重定向，不在这一层。
 *
 * 压缩包里额外放一份「使用说明.txt」：免安装版第一次拿到手的人最常问的
 * 就是「解压后点哪个」，写清楚比让他对着一堆 dll 找强。
 *
 * 用 PowerShell 的 Compress-Archive（Windows 内置）而不是引 zip 依赖：
 * 这个脚本一年只跑几次发布，不值得为它多一个 node_modules。
 *
 * 用法：npm run pc:zip
 *   （先跑 npm run pc:build 或 pc:dir 让 dist/win-unpacked 落地）
 *   注意：请在**沙箱外**、并清掉 NODE_OPTIONS / CODEBUDDY_SAFE_DELETE_BULK_GUARD
 *   两个环境变量后跑 —— 那个 node-safe-delete-shim 会拦「批量删文件」，而这里的
 *   改名/清理会撞上。见项目备忘「PC 构建」一节。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

const version = require(path.join(root, 'package.json')).version;
const greenName = `nova-pc-${version}-win-x64-green`;
const winUnpacked = path.join(dist, 'win-unpacked');
const greenDir = path.join(dist, greenName);
const zipName = `${greenName}.zip`;
const zipPath = dist + path.sep + zipName;

if (!fs.existsSync(winUnpacked)) {
  console.error(`找不到免安装目录：${winUnpacked}`);
  console.error('先跑 npm run pc:build（或 npm run pc:dir）。');
  process.exit(1);
}

// 免安装包里必须真有可执行文件，别把一个空目录压出去发了。
// 主程序名随 productName（吾爱Nova浏览器.exe），这里不写死，扫 .exe 兜。
const entries = fs.readdirSync(winUnpacked);
const exeName = entries.find((f) => /\.exe$/i.test(f));
if (!exeName) {
  console.error(`${winUnpacked} 里没有 .exe —— 这不是一份能跑的免安装目录。`);
  process.exit(1);
}
if (!fs.existsSync(path.join(winUnpacked, 'resources'))) {
  console.error(`${winUnpacked} 里缺少 resources/ —— 构建不完整。`);
  process.exit(1);
}

// 上一次跑残留的同名目录 / 压缩包先清掉：Compress-Archive 遇同名文件会报错，
// 而 win-unpacked -> greenDir 改名时目标已存在也会失败。
try {
  if (fs.existsSync(greenDir)) fs.rmSync(greenDir, { recursive: true, force: true });
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
} catch (err) {
  console.error('清理旧产物失败（多半是安全垫片拦了批量删）。');
  console.error('请在沙箱外并清掉 NODE_OPTIONS / CODEBUDDY_SAFE_DELETE_BULK_GUARD 后重跑：');
  console.error('  env -u NODE_OPTIONS -u CODEBUDDY_SAFE_DELETE_BULK_GUARD npm run pc:zip');
  console.error('原始错误：', err.message);
  process.exit(1);
}

// win-unpacked -> greenName 目录名「改个好看的名字」，压缩后改回去。
// 用改名（同卷瞬间完成）而不是复制：win-unpacked 动辄 200MB+，复制纯属浪费。
const readmeText =
  `吾爱Nova浏览器 v${version} · 绿色版（免安装）\r\n` +
  `\r\n` +
  `解压后直接双击「${exeName}」即可使用，无需安装。\r\n` +
  `\r\n` +
  `· 这是免安装版：解压即用，不写安装项。想正式安装（含卸载项、开始菜单），\r\n` +
  `  请下载同版本的 EXE 安装包。\r\n` +
  `· 配置与浏览数据保存在当前系统用户的应用数据目录。\r\n` +
  `\r\n` +
  `官网：https://nova.52ta.top/\r\n`;

fs.renameSync(winUnpacked, greenDir);
let renamedBack = false;
try {
  fs.writeFileSync(path.join(greenDir, '使用说明.txt'), readmeText, 'utf8');

  // Compress-Archive 的同名文件会直接报错，用 -Force 覆盖。
  // CompressionLevel 用 Optimal：win-unpacked 里是一堆已经小压缩过的
  // resources/app.asar 与原生 dll，再压一遍仍能省下可观体积，值得多等一会。
  const ps = (s) => `'${s.replace(/'/g, "''")}'`;
  const script =
    `$ErrorActionPreference='Stop'; ` +
    `Compress-Archive -LiteralPath ${ps(greenDir)} -DestinationPath ${ps(zipPath)} ` +
    `-CompressionLevel Optimal -Force`;

  console.log(`打包 ${greenName}/ → ${zipName}`);
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'inherit'
  });
} catch (err) {
  console.error('压缩失败：', err.message);
  process.exitCode = 1;
} finally {
  // 无论成败都把目录名还原回 win-unpacked：留个改过名的目录会绊倒下次构建 / 校验。
  // 先删掉塞进去的使用说明，免得它跟着进 win-unpacked（那是构建产物，不该混入文档）。
  try {
    const readme = path.join(greenDir, '使用说明.txt');
    if (fs.existsSync(readme)) fs.rmSync(readme, { force: true });
    if (fs.existsSync(greenDir)) { fs.renameSync(greenDir, winUnpacked); renamedBack = true; }
  } catch (err) {
    console.error('还原 win-unpacked 目录名失败（不影响已生成的 zip）：', err.message);
    renamedBack = false;
  }
}

if (process.exitCode) process.exit(process.exitCode);
if (!renamedBack) {
  console.error('注意：dist 下的免安装目录名未还原，下次构建前请手动改回 win-unpacked。');
}

const size = fs.statSync(zipPath).size;
console.log('');
console.log(`  ${zipName}`);
console.log(`  ${size.toLocaleString()} 字节（免安装目录原始体积见 dist/win-unpacked）`);
console.log('');
console.log('  下一步：算 sha256 填进 site/version.json，并把 zip 上传到 Gitee Release。');
console.log(`  node -e "const c=require('crypto'),f=require('fs');` +
  `console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" ${zipName}`);
