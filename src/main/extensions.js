'use strict';

/**
 * 扩展管理器
 * ---------------------------------------------------------------------------
 * 三类输入统一走一条流水线：识别 → 解包 → 归一化 → 装载
 *   .crx / .zip       Chromium 商店包 / 压缩包  → 解包后 loadExtension
 *   目录              已解包的扩展目录          → 直接 loadExtension
 *   .xpi              火狐扩展（就是一个 zip）   → 解包 + 清单归一化（browser → chrome 桥）
 *
 * 注意：Electron 的 loadExtension 底层是 Chromium 的扩展实现，
 * 因此「火狐扩展」走的是 polyfill 桥：把 browser.* 命名空间补上、
 * 把 Firefox 专有清单字段清洗掉。能跑 WebExtension 通用能力的子集，
 * 依赖 Gecko 专有 API（browser.tabs.hide 等）的扩展会失效 —— 这一点在 UI 里如实标注。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

/* ========================================================================== *
 * 极简 ZIP 读取器（stored + deflate，够解扩展包）
 * ========================================================================== */

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function listZipEntries(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 包（未找到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entry) {
  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('本地文件头损坏: ' + entry.name);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('不支持的压缩方式: ' + entry.method);
}

function safeJoin(root, name) {
  const target = path.resolve(root, name);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('非法路径: ' + name);
  return target;
}

function extractZip(buf, destDir) {
  const entries = listZipEntries(buf);
  let files = 0;
  for (const entry of entries) {
    const target = safeJoin(destDir, entry.name);
    if (entry.name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, readZipEntry(buf, entry));
    files++;
  }
  return { files, entries: entries.length };
}

/**
 * 这个目录**本身**是不是一个扩展（含 manifest.json）？
 * @returns {string|null} manifest 的路径，不是扩展则 null
 */
function manifestAt(dir) {
  const p = path.join(dir, 'manifest.json');
  return fs.existsSync(p) ? p : null;
}

/**
 * 在解包出来的目录里找扩展的根。
 *
 * <p><b>为什么要往下一层找</b>：zip / xpi 绝大多数是「单层包裹」结构 ——
 * 包里最外层是一个与扩展同名的文件夹，manifest.json 在它里面
 * （`扩展名/manifest.json`）。而 {@link extractZip} 是**原样保留**包内
 * 目录结构的，所以解到 extDir 之后真正的根是 `extDir/扩展名/`。
 * 直接找 `extDir/manifest.json` 就会报「扩展目录内缺少 manifest.json」——
 * 而包是好的，只是多了一层。
 *
 * <p>同样处理「用户直接选了已解包目录」那条路：用户从资源管理器里选中
 * 扩展文件夹时，也可能选中的是它的父目录。
 *
 * <p><b>只往下找一层</b>，不递归：再深的嵌套在真实世界里不存在，
 * 而递归会在一个装了几百个文件的目录里乱窜，还可能命中某个子项目里
 * 恰好叫 manifest.json 的文件。
 *
 * @returns {{dir:string, manifest:string, depth:number}|null}
 */
function resolveExtensionRoot(extDir) {
  const own = manifestAt(extDir);
  if (own) return { dir: extDir, manifest: own, depth: 0 };

  let kids = [];
  try { kids = fs.readdirSync(extDir, { withFileTypes: true }); } catch { return null; }
  for (const k of kids) {
    if (!k.isDirectory()) continue;
    const sub = path.join(extDir, k.name);
    const m = manifestAt(sub);
    if (m) return { dir: sub, manifest: m, depth: 1 };
  }
  return null;
}

/* ========================================================================== *
 * CRX 解包
 * ========================================================================== */

function stripCrxHeader(buf) {
  // 按字节比，不按 readUInt32LE 比。
  //
  // 这里原先写的是 `readUInt32LE(0) !== 0x43723234` —— 那个常量是把 "Cr24"
  // 按书写顺序直接拼出来的，可 readUInt32LE 是小端读取，读同一个文件得到的是
  // 0x34327243。两边永远不相等，于是**任何一个 .crx 都会被判成「不是 CRX 文件」**，
  // 安装路径整条是死的。按字节比没有这个坑，也一眼看得出在比什么。
  if (buf.subarray(0, 4).toString('latin1') !== 'Cr24') throw new Error('不是 CRX 文件（魔数不符）');
  const version = buf.readUInt32LE(4);
  if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    return { version, zip: buf.subarray(16 + pubKeyLen + sigLen) };
  }
  if (version === 3) {
    const headerLen = buf.readUInt32LE(8);
    return { version, zip: buf.subarray(12 + headerLen) };
  }
  throw new Error('不支持的 CRX 版本: ' + version);
}

/* ========================================================================== *
 * Firefox 扩展清单归一化
 * ========================================================================== */

const GECKO_ONLY_PERMISSIONS = new Set([
  'menus.overrideContext', 'contextualIdentities', 'dns', 'geckoProfiler',
  'identity.email', 'nativeMessaging', 'privacy', 'theme', 'browserSettings',
  'pkcs11', 'webRequestFilterResponse', 'webRequestFilterResponse.serviceWorkerScript',
  'proxy', 'tabHide', 'normandyAddonStudy', 'urlbar', 'telemetry'
]);

const BROWSER_POLYFILL = `/* Nova · browser.* → chrome.* 桥（自动注入给 Firefox 扩展） */
(function () {
  if (typeof window === 'undefined' || window.browser) return;
  if (!window.chrome) return;
  var wrap = function (ctx, fn) {
    return function () {
      try {
        var r = fn.apply(ctx, arguments);
        if (r && typeof r.then === 'function') return r;
        if (r === undefined) return Promise.resolve();
        return Promise.resolve(r);
      } catch (e) { return Promise.reject(e); }
    };
  };
  var browser = {};
  for (var ns in chrome) {
    var api = chrome[ns];
    if (api && typeof api === 'object') {
      browser[ns] = {};
      for (var k in api) {
        browser[ns][k] = typeof api[k] === 'function' ? wrap(api, api[k]) : api[k];
      }
    } else if (typeof api === 'function') {
      browser[ns] = wrap(chrome, api);
    } else {
      browser[ns] = api;
    }
  }
  try { Object.defineProperty(window, 'browser', { value: browser, configurable: true }); } catch (e) { window.browser = browser; }
})();
`;

/**
 * 把一个 Firefox 扩展目录归一化成 Chromium 能装的形态。
 * 返回一份变更报告，UI 里如实展示（而不是假装完全兼容）。
 */
function normalizeFirefoxExtension(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('扩展包内缺少 manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const changes = [];

  // 1) browser_specific_settings / applications → 记录来源后移除（Chromium 不认）
  const gecko = manifest.browser_specific_settings || manifest.applications;
  if (gecko) {
    changes.push('移除 Firefox 专有字段 browser_specific_settings');
    delete manifest.browser_specific_settings;
    delete manifest.applications;
  }

  // 2) 清洗 Gecko 专有权限
  if (Array.isArray(manifest.permissions)) {
    const before = manifest.permissions.length;
    manifest.permissions = manifest.permissions.filter((p) => {
      const head = String(p).split('.')[0];
      return !GECKO_ONLY_PERMISSIONS.has(p) && !GECKO_ONLY_PERMISSIONS.has(head);
    });
    if (manifest.permissions.length !== before) {
      changes.push(`过滤 ${before - manifest.permissions.length} 项 Gecko 专有权限`);
    }
  }

  // 3) MV3 的 background.scripts → service_worker（语义有差异，需标注）
  if (manifest.manifest_version === 3 && manifest.background && !manifest.background.service_worker && Array.isArray(manifest.background.scripts)) {
    manifest.background.service_worker = manifest.background.scripts[0];
    delete manifest.background.scripts;
    changes.push('background.scripts → service_worker（事件页语义与 Gecko 不完全一致）');
  }

  // 4) MV3 的 browser_specific_settings 里 content_security_policy 形态差异
  if (manifest.content_security_policy && typeof manifest.content_security_policy === 'object') {
    // Chromium MV3 只接受字符串
    const csp = manifest.content_security_policy.extension_pages || manifest.content_security_policy;
    if (typeof csp !== 'string') {
      manifest.content_security_policy = { extension_pages: "script-src 'self'; object-src 'self'" };
      changes.push('CSP 归一化为 Chromium MV3 形态');
    }
  }

  // 5) 注入 browser → chrome 桥，写进 background 与 content_scripts 前面
  const bridgeFile = '_nova_browser_polyfill.js';
  fs.writeFileSync(path.join(dir, bridgeFile), BROWSER_POLYFILL, 'utf8');

  const injectInto = (scripts) => {
    if (Array.isArray(scripts) && !scripts.includes(bridgeFile)) scripts.unshift(bridgeFile);
  };
  if (manifest.background && Array.isArray(manifest.background.scripts)) injectInto(manifest.background.scripts);
  if (Array.isArray(manifest.content_scripts)) {
    manifest.content_scripts.forEach((cs) => injectInto(cs.js));
  }
  if (manifest.background && manifest.background.service_worker) {
    changes.push('Service Worker 形态的桥接需要打包器支持，已尽力注入');
  }
  changes.push('注入 browser.* → chrome.* 兼容桥');

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { manifest, changes };
}

/* ========================================================================== *
 * manifest 本地化占位符
 * ========================================================================== */

/**
 * 解 manifest 里的 `__MSG_xxx__` 占位符。
 *
 * 商店里的扩展大量用它做本地化：manifest 写 `__MSG_extName__`，
 * 真名字放在 `_locales/<locale>/messages.json`。不解的话，装完的卡片上
 * 写的是一串占位符（真环境实测 Tampermonkey 就是这样）—— 用户看到的是
 * 一个显然没做完的东西，而它其实只差一步。
 *
 * 顺序按 Chrome 的近似来：先中文（用户是中文环境），再 default_locale，
 * 再英文。全都没命中时退回 key 本身 —— 界面上看到 "extName" 好歹比
 * "__MSG_extName__" 像一个有意的决定；真想把它做好，得把 Chrome 的
 * locale fallback 整套搬来，那超出这一步该做的事。
 *
 * @returns {string} 原样返回（不是占位符时）或解析出的文案
 */
function resolveMessage(dir, manifest, value) {
  if (typeof value !== 'string') return value;
  const m = /^__MSG_(.+?)__$/.exec(value.trim());
  if (!m) return value;
  const key = m[1];

  const locales = ['zh_CN', 'zh', manifest && manifest.default_locale, 'en', 'en_US']
    .filter(Boolean);
  // default_locale 没写（或写错了）时，扫一遍 _locales 里有什么就用什么 ——
  // 目录里总共有哪几种语言是事实，比「猜一个常见的」可靠。
  try {
    for (const f of fs.readdirSync(path.join(dir, '_locales'))) {
      if (!locales.includes(f)) locales.push(f);
    }
  } catch { /* 没有 _locales 目录：这个占位符本来就没得解 */ }

  for (const loc of locales) {
    try {
      const msgs = JSON.parse(
        fs.readFileSync(path.join(dir, '_locales', loc, 'messages.json'), 'utf8'));
      // 先精确找；找不到再做一次大小写不敏感的匹配 —— 有些扩展在 manifest 里
      // 写 __MSG_ExtName__ 而 messages.json 里是 extName，两边差一个头字母。
      // Chrome 对这里是严格匹配（那样会显示成 key），宽容一点没有代价。
      let hit = msgs[key];
      if (!hit) {
        const lower = key.toLowerCase();
        hit = Object.keys(msgs).find((k) => k.toLowerCase() === lower);
        hit = hit && msgs[hit];
      }
      if (hit && typeof hit.message === 'string') return hit.message;
    } catch { /* 这个语言没有或读不懂，试下一个 */ }
  }
  return key;
}

/* ========================================================================== *
 * 扩展管理器
 * ========================================================================== */

class ExtensionManager {
  constructor({ workDir, partitions }) {
    this.workDir = workDir; // 解包缓存目录
    this.partitions = partitions; // 需要装载扩展的 partition 列表
    this.loaded = new Map(); // id → { info, electronExtension }
    this.onChange = () => {};
  }

  ensureDirs() {
    fs.mkdirSync(this.workDir, { recursive: true });
  }

  /** 统一入口：返回 { id, name, source, changes, warnings } */
  async install(inputPath, sessionFactory) {
    this.ensureDirs();
    const stat = fs.statSync(inputPath);
    let extDir = inputPath;
    let source = 'unpacked';
    let pkgVersion = null;
    const warnings = [];

    if (stat.isFile()) {
      const ext = path.extname(inputPath).toLowerCase();
      const base = path.basename(inputPath, ext);
      extDir = path.join(this.workDir, `${base}-${Date.now()}`);
      fs.mkdirSync(extDir, { recursive: true });
      const buf = fs.readFileSync(inputPath);

      if (ext === '.crx') {
        const { version, zip } = stripCrxHeader(buf);
        pkgVersion = `CRX v${version}`;
        source = 'chromium-store';
        extractZip(Buffer.from(zip), extDir);
      } else if (ext === '.xpi' || ext === '.zip' || ext === '.crx3') {
        source = ext === '.xpi' ? 'firefox' : 'archive';
        extractZip(buf, extDir);
      } else {
        throw new Error(`不支持的文件类型：${ext}（支持 .crx / .xpi / .zip 或已解包目录）`);
      }
    }

    // 找真正的扩展根：包/目录外面可能还包着一层（详见 resolveExtensionRoot）。
    // **必须排在 normalizeFirefoxExtension 之前** —— .xpi 正是那种「单层包裹」
    // 结构，先规范化会在解包根目录里找 manifest.json 而找不到，
    // 于是改不到真正该改的那一层，改了等于没改。
    const root = resolveExtensionRoot(extDir);
    if (!root) {
      throw new Error(
        '扩展目录内缺少 manifest.json'
        + (source === 'unpacked'
          // 已解包目录这条路要说清「也可能是选错了父目录」，否则用户会去检查包本身
          ? '（如果这是已解包的扩展文件夹，请确认选中的是**含 manifest.json 的那一层**，'
            + '而不是它的上级目录）'
          : '（若包解压后最外层是一个同名文件夹，请改用「浏览安装」选中里面的那一层）')
      );
    }
    extDir = root.dir;
    const manifestPath = root.manifest;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    let changes = [];
    if (source === 'firefox') {
      const result = normalizeFirefoxExtension(extDir);
      changes = result.changes;
    }

    // 名字与描述先过一遍本地化占位符。内部 id 也从这里派生：
    // `__MSG_extName__` 派生出来的是 "-msg-extname-"，而解析出的
    // 真名字派生出来就是一个正常的 slug（Tampermonkey → tampermonkey）。
    const displayName = resolveMessage(extDir, manifest, manifest.name);
    const id = String(displayName || manifest.name || 'extension')
      .replace(/[^\w-]+/g, '-').toLowerCase();
    const electronExtension = await sessionFactory().loadExtension(extDir, { allowFileAccess: true });

    const info = {
      id,
      electronId: electronExtension.id,
      name: displayName,
      version: manifest.version,
      description: resolveMessage(extDir, manifest, manifest.description || ''),
      manifestVersion: manifest.manifest_version,
      source,
      packageVersion: pkgVersion,
      dir: extDir,
      changes,
      warnings,
      enabled: true,
      icon: this._findIcon(extDir, manifest)
    };

    this.loaded.set(electronExtension.id, { info, electronExtension });
    this.onChange(this.list());
    return info;
  }

  _findIcon(dir, manifest) {
    const icons = manifest.icons || (manifest.action && manifest.action.default_icon) || (manifest.browser_action && manifest.browser_action.default_icon);
    if (!icons) return null;
    const rel = typeof icons === 'string' ? icons : icons[Object.keys(icons).sort((a, b) => b - a)[0]];
    if (!rel) return null;
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) return null;
    try {
      const ext = path.extname(abs).slice(1) || 'png';
      return `data:image/${ext === 'svg' ? 'svg+xml' : ext};base64,${fs.readFileSync(abs).toString('base64')}`;
    } catch { return null; }
  }

  /** 已装载的 Electron 扩展集合（供 UA / 过滤逻辑查询） */
  electronExtensions() {
    return [...this.loaded.values()].map((v) => v.electronExtension);
  }

  list() {
    return [...this.loaded.values()].map((v) => v.info);
  }

  electronIdOf(id) {
    const hit = [...this.loaded.values()].find((v) => v.info.id === id);
    return hit ? hit.info.electronId : null;
  }

  remove(id, sessionFactory) {
    const ses = sessionFactory();
    const eid = this.electronIdOf(id);
    if (!eid) return false;
    try { ses.removeExtension(eid); } catch (err) { console.warn('[extensions] 移除失败:', err.message); }
    for (const [k, v] of this.loaded) if (v.info.id === id) this.loaded.delete(k);
    this.onChange(this.list());
    return true;
  }
}

/**
 * 判断一个文件是不是可被自动安装的扩展包。
 *
 * 拖拽安装（见 main.js 的 drop-file 接线）和「安装扩展」对话框共用这一份判据，
 * 抽出来是为了两处口径永不失同步，也方便 Node 单测直接覆盖（拖拽路径本身
 * 只能真机点）。认得的四类：
 *   .crx     Chromium 商店包（走 stripCrxHeader 拆签名段）
 *   .crx3    同上的 CRX3 变体（魔数同样是 "Cr24"，headerLen 不同）
 *   .zip     已打成压缩包的扩展目录（直接解包 loadExtension）
 *   .xpi     火狐扩展（本质是个 zip，还要过 Gecko 归一化桥）
 */
const EXTENSION_EXTS = ['.crx', '.crx3', '.zip', '.xpi'];

function isExtensionFile(p) {
  if (!p || typeof p !== 'string') return false;
  // trim 两端：拖拽进来偶尔会夹到不可见字符，而路径本身中间的空格（如
  // "Downloads\Nova 浏览器\ext.crx"）不受影响 —— 只 trim 首尾正好避开它。
  const ext = path.extname(p.trim()).toLowerCase();
  return EXTENSION_EXTS.indexOf(ext) >= 0;
}

module.exports = {
  ExtensionManager,
  extractZip,
  listZipEntries,
  readZipEntry,
  stripCrxHeader,
  normalizeFirefoxExtension,
  // 与上面那几个一样是「为可测而导出」：这个函数决定装哪个目录当扩展根，
  // 而「单层包裹」这个形状一改就又是全体用户装不上，靠单测守住最实在
  resolveExtensionRoot,
  resolveMessage,
  isExtensionFile,
  BROWSER_POLYFILL
};
