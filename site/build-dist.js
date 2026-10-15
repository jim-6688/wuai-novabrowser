#!/usr/bin/env node
/**
 * EdgeOne Pages 的构建步骤：把要发布的那几样拷进 dist/。
 *
 * <p><b>为什么要单独一个文件</b>：原先这条逻辑写在 edgeone.json 的 buildCommand 里，
 * 先后试过两种写法都栽了 ——
 * <ul>
 *   <li>Linux 的 {@code rm -rf dist && mkdir -p dist && cp -R …}：远端构建环境是
 *       cmd，直接报「'rm' 不是内部或外部命令」。</li>
 *   <li>cmd 的 {@code rmdir /s /q & xcopy …}：在本机复现时整条链**静默失败**，
 *       {@code dist/} 建出来是空的；而这些子命令各自的返回码又都不为 0，
 *       换 {@code &&} 会被当成失败而短路，用 {@code &} 又是静默失败 ——
 *       部署却报「成功」，产物里少了截图才发现。</li>
 *   <li>内联 {@code node -e "…"}：远端把内层引号剥掉了，
 *       报 {@code Unterminated string constant}。</li>
 * </ul>
 * 放进文件后，命令行只剩一句 {@code node build-dist.js}，没有引号、没有 shell
 * 语法，也不依赖远端是哪种 shell —— 这些坑一次性全绕开。
 *
 * <p><b>拷贝哪几样也是定死的</b>：官网只需要 assets / download / index.html /
 * version.json 这四样，源码、工具脚本、SYNC.json 之类一律不进产物
 * （下面用白名单而非「排除」写法：新增文件默认不会被带上去）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');

/** 要拷进产物的目录 / 文件。想再加一样，改这里就行。 */
const DIRS = ['assets', 'download'];
const FILES = ['index.html', 'version.json'];

function main() {
  // recursive+force：dist 已存在时先清掉，否则上一次残留的文件会混进新产物
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  let count = 0;
  for (const name of DIRS) {
    const from = path.join(ROOT, name);
    if (!fs.existsSync(from)) {
      console.warn(`! 跳过不存在的目录：${name}`);
      continue;
    }
    fs.cpSync(from, path.join(OUT, name), { recursive: true });
    count++;
  }

  for (const name of FILES) {
    const from = path.join(ROOT, name);
    if (!fs.existsSync(from)) {
      // 少一个 index.html 会导致整站白屏，属于必须让构建失败的情况
      if (name === 'index.html') throw new Error(`缺少 ${name}，构建中止`);
      console.warn(`! 跳过不存在的文件：${name}`);
      continue;
    }
    fs.copyFileSync(from, path.join(OUT, name));
    count++;
  }

  const size = fs.readdirSync(OUT, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .reduce((n, d) => n + (fs.statSync(path.join(d.parentPath || d.path, d.name)).size || 0), 0);
  console.log(`✓ 产物就绪：${OUT}（${count} 项，约 ${(size / 1024 / 1024).toFixed(1)} MB）`);
}

main();