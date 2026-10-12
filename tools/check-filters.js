'use strict';

/**
 * 过滤规则校验器 + 清单生成
 * ===========================================================================
 * 纯 Node 实现：只读文件系统，不联网、不起子进程（沙箱禁止 child_process）。
 * 抓取交给 bash（tools/fetch-filters.sh），校验与取证记录交给这里。
 *
 * 做四件事：
 *   1. 逐个源核对规则文件是否就位、体积、行数、SHA-256
 *   2. 用引擎**真实装载**一遍，报告每个源实际落地多少条规则、跳过多少条
 *   3. 比对 _mirrors.txt 里记录的实际镜像地址（停服源用了哪些替代必须可溯）
 *   4. 写出 assets/filters/manifest.json 作为可复核记录
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FILTER_DIR = path.join(ROOT, 'assets', 'filters');
const MANIFEST = path.join(FILTER_DIR, 'manifest.json');
const MIRROR_LOG = path.join(FILTER_DIR, '_mirrors.txt');

const { adblock, SOURCE_DEFS } = require(path.join(ROOT, 'src', 'main', 'adblock.js'));

const NUM = (n) => String(n || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const KB = (n) => (n == null ? '—' : (n / 1024).toFixed(1) + ' KB');
const line = (s) => console.log(s);

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function countLines(p) {
  const txt = fs.readFileSync(p, 'utf8');
  let n = 0;
  for (let i = 0; i < txt.length; i++) if (txt.charCodeAt(i) === 10) n++;
  return n + (txt.endsWith('\n') ? 0 : 1);
}

function readMirrors() {
  const map = {};
  try {
    for (const l of fs.readFileSync(MIRROR_LOG, 'utf8').split(/\r?\n/)) {
      const [file, url] = l.split('\t');
      if (file && url) map[file.trim()] = url.trim();
    }
  } catch { /* 无记录 */ }
  return map;
}

/* ==================================================================== *
 * 主流程
 * ==================================================================== */
line('');
line('Nova 过滤规则校验  ——  广告终结者 / Adblock Plus / 系统内置');
line('='.repeat(74));

const mirrors = readMirrors();
const stats = adblock.loadAll();

const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  engine: { filterDir: path.relative(ROOT, FILTER_DIR).replace(/\\/g, '/') },
  totals: {
    network: stats.rules.network,
    cosmetic: stats.rules.cosmetic,
    exceptions: stats.rules.exceptions,
    skipped: 0
  },
  index: {
    domainKeys: stats.rules.indexedDomains,
    tokenKeys: stats.rules.indexedTokens,
    generic: stats.rules.generic
  },
  universalCssBytes: stats.rules.universalCssBytes,
  sources: []
};

let missing = 0;

for (const def of SOURCE_DEFS) {
  const src = stats.sources.find((s) => s.id === def.id);
  line('');
  line(`[${def.name}]  ${def.vendor}`);
  line(`  类型   ${def.kind === 'builtin' ? '随应用内置（不依赖网络）' : '远程订阅'}`);
  line(`  规则   网络 ${NUM(src.counts.network)} / 隐藏 ${NUM(src.counts.cosmetic)}`
     + ` / 例外 ${NUM(src.counts.exceptions)} / 跳过 ${NUM(src.counts.skipped)}`);
  if (def.note) line(`  说明   ${def.note}`);

  const srcOut = {
    id: def.id, name: def.name, vendor: def.vendor, homepage: def.homepage,
    kind: def.kind, enabled: src.enabled, counts: src.counts, lists: []
  };

  if (def.kind === 'builtin') {
    line(`  · ${src.lists[0].title}`);
    line(`      规则   ${NUM(src.lists[0].rules)} 条（网络 ${NUM(src.lists[0].network)} + 隐藏 ${NUM(src.lists[0].cosmetic)}）`);
    line(`      来源   src/main/adblock-lists.js（随版本发布）`);
    srcOut.lists.push({ ...src.lists[0], lines: null, sha256: null, url: '' });
    report.sources.push(srcOut);
    continue;
  }

  for (const spec of def.files) {
    const abs = path.join(FILTER_DIR, spec.file);
    const landed = src.lists.find((l) => l.file === spec.file) || {};
    const exists = fs.existsSync(abs);

    line(`  · ${landed.title || spec.title}`);
    if (!exists) {
      missing += 1;
      line(`      ✗ 文件缺失：assets/filters/${spec.file}`);
      line(`        用 \`bash tools/fetch-filters.sh --only=${def.id}\` 重新抓取`);
      srcOut.lists.push({ file: spec.file, title: spec.title, missing: true, rules: 0 });
      continue;
    }

    const size = fs.statSync(abs).size;
    const lines = countLines(abs);
    const hash = sha256(abs);

    line(`      文件   assets/filters/${spec.file}`);
    line(`      体积   ${KB(size)} / ${NUM(lines)} 行`);
    if (landed.version) line(`      版本   ${landed.version}`);
    if (landed.modified) line(`      更新   ${landed.modified}`);
    line(`      规则   ${NUM(landed.rules)} 条（网络 ${NUM(landed.network)} + 隐藏 ${NUM(landed.cosmetic)}）`);
    if (landed.skipped) line(`      跳过   ${NUM(landed.skipped)} 行（扩展语法 / 请求改写类选项，本引擎不执行）`);
    line(`      镜像   ${mirrors[spec.file] || '（无溯源记录）'}`);
    line(`      SHA-256 ${hash}`);

    srcOut.lists.push({
      file: spec.file, title: landed.title || spec.title,
      version: landed.version || null, modified: landed.modified || null,
      url: mirrors[spec.file] || '',
      bytes: size, lines,
      rules: landed.rules || 0, network: landed.network || 0,
      cosmetic: landed.cosmetic || 0, skipped: landed.skipped || 0,
      sha256: hash
    });
  }

  report.sources.push(srcOut);
}

report.totals.skipped = report.sources
  .reduce((n, s) => n + (s.counts ? s.counts.skipped : 0), 0);

/* ------------------------------------------------------------------ */
line('');
line('='.repeat(74));
line(`合计   网络 ${NUM(report.totals.network)} / 隐藏 ${NUM(report.totals.cosmetic)}`
   + ` / 例外 ${NUM(report.totals.exceptions)} / 跳过 ${NUM(report.totals.skipped)}`);
line(`索引   域名锚 ${NUM(report.index.domainKeys)} 键 / token ${NUM(report.index.tokenKeys)} 键`
   + ` / 回退全扫 ${NUM(report.index.generic)} 条`);
line(`注入   通用元素隐藏样式 ${KB(report.universalCssBytes)}（按站点缓存，不含域名专属规则）`);
line('');

if (missing === 0) {
  line('所有规则文件就位 ✓');
} else {
  line(`${missing} 个规则文件缺失 —— 运行 bash tools/fetch-filters.sh 抓取`);
}

try {
  fs.writeFileSync(MANIFEST, JSON.stringify(report, null, 2), 'utf8');
  line(`清单已写入 ${path.relative(ROOT, MANIFEST).replace(/\\/g, '/')}`);
} catch (err) {
  line(`清单写入失败：${err.message}`);
}
line('');

process.exit(missing ? 1 : 0);
