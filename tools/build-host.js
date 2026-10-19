#!/usr/bin/env node
/**
 * host:build 的入口：宿主源码没变就跳过编译。
 *
 * <p><b>为什么需要这一层</b>：`pc:build` 每次都会先跑 host:build，而
 * `native/bin/trident-host.exe` 很可能正被 Nova 拉起来跑着。csc 无法覆盖
 * 正在运行的 exe，会报 CS0016（文件被另一进程使用），整条打包随即失败 ——
 * 哪怕宿主代码一个字都没改。
 *
 * <p>先比时间戳：Program.cs 不比产物新就直接跳过。真要重编时交给
 * build-trident.bat，它会在编译前结束正在运行的宿主。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'native', 'host', 'trident-host', 'Program.cs');
const OUT = path.join(ROOT, 'native', 'bin', 'trident-host.exe');

if (process.platform !== 'win32') {
  console.log('! 宿主编译只支持 Windows，跳过（不影响其余打包步骤）');
  process.exit(0);
}

if (!fs.existsSync(SRC)) {
  console.error('缺少 native/host/trident-host/Program.cs，无法编译宿主');
  process.exit(1);
}

if (fs.existsSync(OUT) && fs.statSync(OUT).mtimeMs >= fs.statSync(SRC).mtimeMs) {
  console.log('✓ trident-host.exe 已是最新（源码未改动），跳过编译');
  process.exit(0);
}

try {
  execFileSync('cmd', ['/c', path.join(ROOT, 'native', 'host', 'build-trident.bat')], {
    cwd: ROOT,
    stdio: 'inherit'
  });
} catch (e) {
  console.error('宿主编译失败：' + (e && e.message ? e.message : e));
  process.exit(1);
}
