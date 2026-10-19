#!/usr/bin/env node
/**
 * Nova 多内核浏览器 —— 引擎校验器 / 清单生成
 *
 * 只读文件系统：不联网、不派生子进程，可在受限沙箱里跑。
 * 抓取请用 tools/fetch-engines.sh。
 *
 *   node tools/check-engines.js           # 校验并打印状态
 *   node tools/check-engines.js --json    # 打印清单原文
 *
 * 产物：native/engines/manifest.json —— 引擎适配层据此判定 native / bridge / compat。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { inspect: peInspect, detectKernelSignature } = require('./pe-info.js');

const ROOT = path.join(__dirname, '..');
const ENGINES_DIR = path.join(ROOT, 'native', 'engines');
const HOST_BIN_DIR = path.join(ROOT, 'native', 'bin');
const MANIFEST = path.join(ENGINES_DIR, 'manifest.json');
const HASH_LIMIT = 32 * 1024 * 1024;

const MB = (n) => (n / 1048576).toFixed(1) + ' MB';
const tty = process.stdout.isTTY;
const C = {
  b: (s) => (tty ? '\x1b[1m' + s + '\x1b[0m' : s),
  d: (s) => (tty ? '\x1b[2m' + s + '\x1b[0m' : s),
  ok: (s) => (tty ? '\x1b[32m' + s + '\x1b[0m' : s),
  bad: (s) => (tty ? '\x1b[31m' + s + '\x1b[0m' : s),
  warn: (s) => (tty ? '\x1b[33m' + s + '\x1b[0m' : s),
  cy: (s) => (tty ? '\x1b[36m' + s + '\x1b[0m' : s),
};

const J = (p) => path.join(ROOT, p).replace(/\\/g, '/');

/* ---------------- 文件系统工具 ---------------- */

function probeFile(abs, desc) {
  let present = false, size = 0;
  try {
    const st = fs.statSync(abs);
    if (st.isFile()) { present = true; size = st.size; }
  } catch {}
  return { desc, present, sizeBytes: size };
}

function dirStat(dir) {
  let bytes = 0, files = 0;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { bytes += fs.statSync(p).size; files++; } catch {} }
    }
  };
  walk(dir);
  return { bytes, files };
}

function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

/* ---------------- 引擎目录 ---------------- */

/**
 * probes: 相对 root 的路径
 * signature: 用哪个二进制做 PE 特征识别（相对 root）
 * archExpect: 'x64' | 'x86' | null —— 已知正确架构，用于报「架构不符」
 */
const CATALOG = [
  {
    engine: 'chromium',
    label: 'Chromium (Blink)',
    sources: [
      {
        id: 'chromium-electron',
        label: 'Electron 主内核',
        root: 'node_modules/electron/dist',
        version: (() => {
          try { return 'Electron ' + JSON.parse(fs.readFileSync(J('node_modules/electron/package.json'), 'utf8')).version; }
          catch { return '未安装'; }
        })(),
        role: 'primary',
        archExpect: 'x64',
        signature: 'electron.exe',
        probes: [
          ['electron.exe', 'Chromium 运行时主程序'],
          ['resources.pak', 'Chromium 资源包'],
          ['icudtl.dat', 'ICU 国际化数据'],
          ['v8_context_snapshot.bin', 'V8 堆快照'],
        ],
      },
      {
        id: 'chromium-cef',
        label: 'CEF 嵌入内核',
        root: 'native/engines/chromium-cef',
        version: 'CEF 154.0.34 / Chromium 154.0.8037.98',
        role: 'embedded',
        archExpect: 'x64',
        signature: 'Release/libcef.dll',
        probes: [
          ['Release/libcef.dll', 'CEF 运行时（Chromium 渲染本体）'],
          ['Release/bootstrap.exe', 'CEF 154 示例宿主（可直接运行）'],
          ['Release/chrome_elf.dll', 'Chromium 崩溃处理模块'],
          ['Resources/icudtl.dat', 'ICU 国际化数据'],
          ['Resources/resources.pak', 'Chromium 资源包'],
          ['include/cef_browser.h', 'CEF C++ API 头文件'],
          ['libcef_dll/wrapper/libcef_dll_wrapper.cc', 'libcef_dll_wrapper 源码'],
        ],
      },
    ],
  },
  {
    engine: 'trident',
    label: 'IE / Trident',
    sources: [
      {
        id: 'trident-mshtml',
        label: 'Windows 内置 MSHTML',
        root: null,
        version: '系统组件（不下载）',
        role: 'system',
        archExpect: 'x64',
        signature: 'C:/Windows/System32/mshtml.dll',
        probes: [
          ['C:/Windows/System32/mshtml.dll', '64 位 MSHTML（Trident 渲染本体）'],
          ['C:/Windows/System32/ieframe.dll', 'IE 框架（WebBrowser 控件宿主）'],
          ['C:/Windows/System32/wininet.dll', 'IE 网络栈'],
          ['C:/Windows/SysWOW64/mshtml.dll', '32 位 MSHTML'],
        ],
      },
    ],
  },
];

/* ---------------- 校验 ---------------- */

function absOf(root, rel) {
  if (!root) return rel;                       // 系统绝对路径
  if (/^[A-Za-z]:[\\/]/.test(rel)) return rel;
  return path.join(ROOT, root, rel);
}

function inspectSource(src) {
  const base = src.root ? path.join(ROOT, src.root) : null;
  const rec = {
    id: src.id,
    label: src.label,
    version: src.version || null,
    role: src.role,
    dir: src.root || null,
    present: false,
    complete: false,
    sizeBytes: 0,
    fileCount: 0,
    arch: null,
    archNote: null,
    probes: [],
    signature: null,
  };

  for (const [rel, desc] of src.probes) {
    const abs = absOf(src.root, rel);
    const p = probeFile(abs, desc);
    p.path = src.root ? path.relative(ROOT, abs).replace(/\\/g, '/') : rel;
    rec.probes.push(p);
  }

  const hit = rec.probes.filter((p) => p.present).length;
  const primary = rec.probes[0];               // 第一项为该发行版的主程序
  rec.present = hit > 0;
  rec.complete = primary.present && hit >= Math.max(3, rec.probes.length - 1);

  if (base) {
    const st = dirStat(base);
    rec.sizeBytes = st.bytes;
    rec.fileCount = st.files;
  } else {
    rec.sizeBytes = rec.probes.reduce((a, p) => a + p.sizeBytes, 0);
  }

  /* PE 校验：证明二进制是真实、完整、架构正确的映像 */
  if (src.signature) {
    const sigAbs = absOf(src.root, src.signature);
    const pe = peInspect(sigAbs, { exportLimit: 6, readExports: true });
    const sig = detectKernelSignature(pe);
    rec.signature = {
      file: rec.dir ? path.relative(ROOT, sigAbs).replace(/\\/g, '/') : src.signature,
      valid: pe.valid,
      peType: pe.peType || null,
      arch: pe.arch || null,
      is64: pe.is64,
      subsystem: pe.subsystemName || null,
      exportCount: pe.exportCount || 0,
      dllName: pe.dllName || null,
      linkedAt: pe.linkedAt || null,
      imageBytes: pe.sizeOfImage || 0,
      sampleExports: pe.exports.slice(0, 4),
      detected: sig,
      errors: pe.errors,
    };
    rec.arch = pe.arch || null;
    if (src.archExpect && pe.valid) {
      const isX64 = pe.is64 === true;
      const wantX64 = src.archExpect === 'x64';
      if (isX64 !== wantX64) rec.archNote = `架构为 ${pe.arch}，与预期 ${src.archExpect} 不符`;
    }
    /* 内核特征与声明不符 → 记为可疑 */
    if (pe.valid && !sig && src.engine !== undefined) rec.signature.mismatch = true;
    rec.complete = rec.complete && pe.valid;
  }

  rec.sha256 = rec.probes
    .filter((p) => p.present && p.path && !path.isAbsolute(p.path))
    .map((p) => ({ file: p.path.replace(rec.dir + '/', ''), sha256: sha256(path.join(ROOT, p.path)) }))
    .filter((x) => x.sha256);

  return rec;
}

function inspectHosts() {
  const want = ['trident-host'];
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  return want.map((k) => {
    let found = null;
    for (const e of exts) {
      const p = path.join(HOST_BIN_DIR, k + e);
      if (fs.existsSync(p)) { found = p; break; }
    }
    return {
      id: k,
      present: !!found,
      path: found ? path.relative(ROOT, found).replace(/\\/g, '/') : null,
      sizeBytes: found ? fs.statSync(found).size : 0,
    };
  });
}

/* 已下载归档的 SHA-256 —— 归档是一次性取证的关键，只算一次并缓存进清单 */
function archiveHashes(prev) {
  const dir = path.join(ENGINES_DIR, '_downloads');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => !n.startsWith('.')); } catch { return []; }
  const cache = new Map((prev || []).map((a) => [a.file, a]));
  return names.map((n) => {
    const p = path.join(dir, n);
    const size = fs.statSync(p).size;
    const hit = cache.get(n);
    if (hit && hit.sizeBytes === size && hit.sha256) return hit;
    return { file: n, sizeBytes: size, sha256: sha256(p) };
  });
}

/**
 * Electron 的归档由 npm 下载，会留在 electron 的缓存目录里。
 * 拿它跟 npm 包自带的官方 checksums.json 比 SHA-256 —— 这是唯一能
 * 「端到端证明 Chromium 主内核与官方发布包逐字节相同」的办法。
 */
function verifyElectronArchive() {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(J('node_modules/electron/package.json'), 'utf8')); } catch { return null; }
  const want = pkg.version;
  const key = `electron-v${want}-${process.platform}-${process.arch}.zip`;

  let checksums;
  try { checksums = JSON.parse(fs.readFileSync(J('node_modules/electron/checksums.json'), 'utf8')); } catch { return null; }
  const expected = checksums[key];
  if (!expected) return { file: key, found: false, reason: '官方 checksums.json 中没有该平台条目' };

  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'electron', 'Cache'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'electron', 'Cache'),
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.cache', 'electron'),
  ].filter(Boolean);

  for (const root of roots) {
    let subs = [];
    try { subs = fs.readdirSync(root); } catch { continue; }
    for (const s of subs) {
      const z = path.join(root, s, key);
      if (!fs.existsSync(z)) continue;
      const got = sha256(z);
      return {
        file: key,
        found: true,
        archivePath: z.replace(/\\/g, '/'),
        sizeBytes: fs.statSync(z).size,
        expectedSha256: expected,
        actualSha256: got,
        match: got === expected,
      };
    }
  }
  return { file: key, found: false, reason: '本机未找到 electron 下载缓存（npm install 后可能已清理）', expectedSha256: expected };
}

function main() {
  const jsonOnly = process.argv.includes('--json');
  const prev = (() => { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return null; } })();

  const hosts = inspectHosts();
  const hostOf = (k) => hosts.find((h) => h.id === k + '-host');

  const report = {
    generatedAt: new Date().toISOString(),
    platform: process.platform + ' ' + process.arch,
    node: process.version,
    engineRoot: path.relative(ROOT, ENGINES_DIR).replace(/\\/g, '/'),
    hosts,
    engines: {},
    archives: [],
  };

  for (const cat of CATALOG) {
    const sources = cat.sources.map(inspectSource);
    const ready = sources.filter((s) => s.complete);

    let mode = 'compat';
    let blocker = null;

    if (cat.engine === 'chromium') {
      mode = ready.some((s) => s.id === 'chromium-electron') ? 'native' : 'compat';
      if (mode === 'compat') {
        blocker = ready.length
          ? 'Chromium 二进制在，但缺 Electron 运行时 → 跑 npm install'
          : '未找到任何 Chromium 二进制 → 跑 npm install 或 tools/fetch-engines.sh';
      }
    } else {
      const h = hostOf(cat.engine);
      if (h && h.present) mode = 'bridge';
      else {
        blocker = ready.length
          ? `真内核二进制已就位（${ready.map((s) => s.id).join(', ')}），缺原生宿主 native/bin/${cat.engine}-host.exe —— 需自行编译，见 native/README.md`
          : '既无真内核二进制，也无原生宿主 → 先跑 tools/fetch-engines.sh';
      }
    }

    report.engines[cat.engine] = {
      engine: cat.engine,
      label: cat.label,
      mode,
      binariesReady: ready.length > 0,
      bridgeReady: mode === 'bridge',
      arch: (sources.find((s) => s.arch) || {}).arch || null,
      blocker,
      sources,
    };
  }

  report.archives = archiveHashes(prev && prev.archives);
  report.upstream = { electron: verifyElectronArchive() };

  fs.mkdirSync(ENGINES_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(report, null, 2) + '\n', 'utf8');

  if (jsonOnly) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return; }

  /* ---------------- 打印 ---------------- */
  console.log('\n' + C.b('Nova 引擎校验') + C.d('  ' + report.platform + '  node ' + report.node));
  console.log(C.d('引擎根：' + report.engineRoot));

  for (const key of Object.keys(report.engines)) {
    const e = report.engines[key];
    const badge = { native: C.ok('[原生内核]'), bridge: C.ok('[原生桥接]'), compat: C.warn('[兼容层]') }[e.mode];
    console.log('\n' + C.b(e.label) + '  ' + badge + (e.arch ? C.d('  ' + e.arch) : ''));

    for (const s of e.sources) {
      const mark = s.complete ? C.ok('✓') : s.present ? C.warn('◐') : C.d('✗');
      console.log('  ' + mark + ' ' + s.label.padEnd(28) + C.d(s.version || '') +
        (s.present ? C.d(`  ${s.fileCount} 文件 / ${MB(s.sizeBytes)}`) : ''));

      if (s.signature) {
        const g = s.signature;
        const line = g.valid
          ? C.ok('PE 正确') + C.d(`  ${g.peType} ${g.arch}  导出 ${g.exportCount}  ${g.linkedAt || ''}`)
          : C.bad('PE 无效') + C.d('  ' + (g.errors.join('; ') || ''));
        console.log('      ' + C.d('映像校验 ') + line);
        if (g.detected) console.log('      ' + C.d('内核特征 ') + C.cy(g.detected));
        if (s.archNote) console.log('      ' + C.warn('⚠ ' + s.archNote));
        for (const p of s.probes) {
          console.log('      ' + (p.present ? C.ok('·') : C.d('·')) + ' ' +
            p.desc.padEnd(34) + C.d(p.present ? MB(p.sizeBytes) : '缺失'));
        }
      } else {
        for (const p of s.probes) {
          console.log('      ' + (p.present ? C.ok('·') : C.d('·')) + ' ' +
            p.desc.padEnd(34) + C.d(p.present ? MB(p.sizeBytes) : '缺失'));
        }
      }
    }
    if (e.blocker) console.log('  ' + C.d('→ ') + C.warn(e.blocker));
  }

  console.log('\n' + C.b('原生宿主'));
  for (const h of hosts) {
    console.log('  ' + (h.present ? C.ok('✓') : C.d('✗')) + ' ' + h.id.padEnd(16) +
      C.d(h.present ? h.path + '  ' + MB(h.sizeBytes) : 'native/bin/ 下未找到'));
  }
  if (!hosts.every((h) => h.present)) {
    console.log('  ' + C.d('宿主二进制需在 Windows 上编译（协议与要点见 native/README.md）'));
  }

  if (report.archives.length) {
    console.log('\n' + C.b('下载归档') + C.d('  (SHA-256 一次算清，缓存于清单)'));
    let total = 0;
    for (const a of report.archives) {
      total += a.sizeBytes;
      console.log('  ' + C.d('·') + ' ' + a.file.padEnd(58) + MB(a.sizeBytes));
      console.log('      ' + C.d(a.sha256 || '—'));
    }
    console.log('  ' + C.d(`共 ${report.archives.length} 个归档 / ${MB(total)}`));
  }

  /* 与上游官方发布包的哈希比对 —— 端到端完整性证据 */
  const up = report.upstream && report.upstream.electron;
  if (up) {
    console.log('\n' + C.b('上游比对') + C.d('  (对方发布方的 SHA-256)'));
    console.log('  ' + C.d('· ') + up.file);
    if (up.found) {
      console.log('      本地 ' + C.d(up.actualSha256));
      console.log('      官方 ' + C.d(up.expectedSha256));
      console.log('      ' + (up.match
        ? C.ok('一致 ✓ 与官方发布包逐字节相同')
        : C.bad('不一致 ✗ 归档可能被篡改或损坏')));
    } else {
      console.log('      ' + C.warn('未比对：' + up.reason));
      if (up.expectedSha256) console.log('      官方 ' + C.d(up.expectedSha256));
    }
  }

  console.log('\n' + C.b('清单') + '  ' + C.cy(path.relative(ROOT, MANIFEST).replace(/\\/g, '/')));
  console.log();
}

main();
