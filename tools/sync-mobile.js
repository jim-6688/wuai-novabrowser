/**
 * 移动版资产同步器
 *
 * 移动版（Flutter / Android）不能 require 桌面端的 JS，但有两样东西必须**同源**，
 * 否则立刻会出现「两份实现各改各的」：
 *
 *   1. 自动拼页的注入脚本  ← src/renderer/autopage.js 的 buildScript()
 *      这份脚本本来就是为「序列化后注入页面」设计的，移动版要注入的是同一段代码。
 *      这里不复制源码，而是真的 require 那个模块、调用它的 buildScript()，
 *      把它生成的脚本原样落盘。桌面端改了拼页算法，重跑本脚本即可同步。
 *
 *   2. 媒体扩展名注册表    ← src/main/sniffer.js 的 EXT_TABLE
 *      移动版的无图模式要判「这是不是视频/音频」，用的就是嗅探器那份注册表。
 *
 *   3. 广告/追踪域名名单    ← src/main/adblock-lists.js 的内置网络规则
 *      移动版把 `||host^` 这类纯域名规则抽出来做宿主黑名单。
 *      **只抽纯域名规则**：带路径、带选项、通配的规则在移动版没有等价实现，
 *      抽不出来就不抽，绝不假装支持。
 *
 * 产物落在 android-app/app/src/main/assets/，并附一份 SYNC.json 记录每个产物的 sha256，
 * 由 tools/check-mobile-sync.js 在门禁里校验「源改了但没同步」。
 *
 * 产物刻意用**纯文本行**而不是 JSON：Android 侧读一行拆一行就够了，
 * 于是 Java 里不用引 JSON 库，单元测试里也不用给 org.json 打桩
 * （Android 框架的 org.json 在本地单测里是空壳，会抛 Stub!）。
 *
 * 用法：npm run mobile:sync
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'android-app', 'app', 'src', 'main', 'assets');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

function write(name, content) {
  const out = path.join(ASSETS, name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  fs.writeFileSync(out, buf);
  return { file: 'android-app/app/src/main/assets/' + name, bytes: buf.length, sha256: sha(buf) };
}

function main() {
  const artifacts = [];

  // ---------------------------------------------------------------- 1) 拼页脚本
  const autopageSrc = path.join(ROOT, 'src', 'renderer', 'autopage.js');
  const autopage = require(autopageSrc);

  // 用默认参数生成：页数上限由 App 在注入后立刻改 window.__novaAutoPage.config.maxPages
  // 覆盖（脚本自己就是用 OPTS.maxPages 判定上限的），不在这里编译期写死。
  const script = autopage.buildScript({});
  const header =
    '/* 吾爱Nova浏览器 · 移动版自动拼页注入脚本\n' +
    ' * 本文件由 npm run mobile:sync 从 src/renderer/autopage.js 生成，**不要手改**。\n' +
    ' * 生成方式：require 那个模块 → 调 buildScript({}) → 原样落盘。\n' +
    ' * 源脚本版本：SCRIPT_VERSION = ' + autopage.SCRIPT_VERSION + '\n' +
    ' */\n';
  artifacts.push(write('autopage.inject.js', header + script));

  // ---------------------------------------------------------------- 2) 媒体扩展名
  const sniffer = require(path.join(ROOT, 'src', 'main', 'sniffer.js'));
  const byKind = {};
  for (const [ext, tuple] of Object.entries(sniffer.EXT_TABLE)) {
    const kind = tuple[0];
    (byKind[kind] = byKind[kind] || []).push(ext);
  }
  for (const k of Object.keys(byKind)) byKind[k].sort();
  const mediaLines = [
    '# 吾爱Nova浏览器 · 移动版媒体后缀表',
    '# 由 npm run mobile:sync 从 src/main/sniffer.js 的 EXT_TABLE 生成，不要手改。',
    '# 每行：<kind> <ext>；kind ∈ video | audio | stream | subtitle',
    '# 移动版无图模式的「无图 + 视频」档用它判「这是不是视频/音频」。',
  ];
  for (const kind of Object.keys(byKind).sort()) {
    for (const ext of byKind[kind]) mediaLines.push(kind + ' ' + ext);
  }
  artifacts.push(write('media-ext.txt', mediaLines.join('\n') + '\n'));
  const mediaCounts = Object.fromEntries(
    Object.entries(byKind).map(([k, v]) => [k, v.length]));

  // ---------------------------------------------------------------- 3) 广告域名
  const lists = require(path.join(ROOT, 'src', 'main', 'adblock-lists.js'));
  const networkRules = lists.network();
  const hosts = new Set();
  let skipped = 0;
  for (const rule of networkRules) {
    // 只认 `||host^` 与 `||host^$options` 两种：抽取主机名，其余一律不算
    const m = /^\|\|([a-z0-9.-]+)\^(?:\$[a-z0-9,=-]+)?$/i.exec(rule.trim());
    if (m) hosts.add(m[1].toLowerCase());
    else skipped++;
  }
  const hostList = [...hosts].sort();
  const adLines = [
    '# 吾爱Nova浏览器 · 移动版广告/追踪域名黑名单',
    '# 由 npm run mobile:sync 从 src/main/adblock-lists.js 的内置网络规则抽取，不要手改。',
    '# 只抽取形如 ||host^ 的纯域名规则；带路径/通配/选项的规则在移动版没有等价实现，',
    '# 已跳过 ' + skipped + ' 条。每行一个域名，无其他字段。',
  ];
  for (const h of hostList) adLines.push(h);
  artifacts.push(write('adblock-hosts.txt', adLines.join('\n') + '\n'));

  // ---------------------------------------------------------------- 4) 同步台账
  const sync = {
    _note: '源文件的 sha256，供 tools/check-mobile-sync.js 校验「源改了但产物没同步」',
    generatedFrom: [
      { source: 'src/renderer/autopage.js', sha256: sha(fs.readFileSync(autopageSrc)) },
      { source: 'src/main/sniffer.js', sha256: sha(fs.readFileSync(path.join(ROOT, 'src', 'main', 'sniffer.js'))) },
      { source: 'src/main/adblock-lists.js', sha256: sha(fs.readFileSync(path.join(ROOT, 'src', 'main', 'adblock-lists.js'))) },
    ],
    artifacts,
  };
  const syncEntry = write('SYNC.json', JSON.stringify(sync, null, 2) + '\n');

  // ---------------------------------------------------------------- 汇报
  console.log('\n移动版资产同步\n');
  const rows = [...artifacts, syncEntry];
  for (const a of rows) {
    console.log('  ' + a.file.padEnd(46) + (a.bytes / 1024).toFixed(1).padStart(8) + ' KB   ' + a.sha256.slice(0, 12));
  }
  console.log('\n  拼页脚本：SCRIPT_VERSION ' + autopage.SCRIPT_VERSION + '，' + script.length + ' 字符');
  console.log('  媒体后缀表：' + JSON.stringify(mediaCounts));
  console.log('  广告域名：' + hostList.length + ' 条纯域名规则（跳过 ' + skipped + ' 条带路径/通配/选项的规则）');
  console.log('\n  结果：已同步 ' + rows.length + ' 个产物');
}

main();
