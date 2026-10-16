'use strict';

/**
 * 从**本机已安装的浏览器**里导入扩展
 * ---------------------------------------------------------------------------
 * <h3>为什么需要它</h3>
 * 「粘贴商店地址 → 直接装」这条路对 Edge 已经断了：微软的取包接口
 * `edge.microsoft.com/extensionwebstorebase/v1/crx` 现在**一律返回 400**
 * （实测过十来种组合：带不带 installsource、加不加 Referer/Cookie/Origin、
 * 换 UA、换路径 —— 全是 400）。它不再是「少传了个参数」，而是要求只有
 * Edge 自己能出示的东西。而它的详情接口照常返回 200，只是里面**不含**
 * Chrome 那边的 ID，所以也没法自动转去镜像站拿包。
 *
 * <p>但扩展仍然拿得到：**商店装好的扩展在磁盘上是解包的**（Chromium 系
 * 一直如此，为了能直接 mmap 加载）。路径是
 * {@code <User Data>/<Profile>/Extensions/<crxId>/<版本>/}。
 * 所以「用户已经在 Edge 里装过的扩展」可以直接搬过来 —— 我们本来就支持
 * 从已解包目录装载（见 extensions.js 的 install）。
 *
 * <h3>这条路的边界要说清楚</h3>
 * <ul>
 *   <li>要求那个扩展**在该浏览器里已经装过**。没装过的拿不到
 *       （拿不到的原因就是上面那个 400）。</li>
 *   <li>导入是**复制**一份到我们自己的目录，不是引用原目录。理由：Edge
 *       自己更新扩展时会把旧版本目录删掉 —— 那时我们的记录就指向一个
 *       不存在的路径，下次启动扩展就「自己不见了」。</li>
 * </ul>
 *
 * <h3>隐私边界</h3>
 * 只读 {@code Extensions/} 下每个扩展的 manifest.json（拿名字与版本用来
 * 显示）。不读浏览历史、不读 cookie、不读别的 profile 数据。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { BROWSERS } = require('./browsers-detect');
const { resolveMessage } = require('./extensions');
const { isNewer } = require('./updater');

/** Chromium 系的 crxId：a-p 之间的 32 个字母。 */
const CRX_ID_RE = /^[a-p]{32}$/;

/** 只看这两种 profile 目录名。`Temp`、`System Profile` 这些不是用户装的。 */
const PROFILE_RE = /^(Default|Profile \d+)$/;

/**
 * 某一家浏览器里存在 `Extensions` 目录的那些 profile。
 *
 * <p>用 readdir 而不是去猜 `Default` / `Profile 1`：装了三个 profile 的
 * 用户，扩展可能装在第三个里，而 `Default` 是空的。
 */
function profileDirs(browser, fsx) {
  const base = browser.resolve();
  let kids = [];
  try { kids = fsx.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const k of kids) {
    if (!k.isDirectory() || !PROFILE_RE.test(k.name)) continue;
    const dir = path.join(base, k.name, 'Extensions');
    if (fsx.existsSync(dir)) out.push({ profile: k.name, dir });
  }
  return out;
}

/** 一个扩展目录下如果有多个版本，挑最新的那个。 */
function pickNewestVersion(dirs) {
  let best = null;
  for (const d of dirs) {
    if (!best || isNewer(d.version, best.version)) best = d;
  }
  return best;
}

/**
 * 扫描已安装浏览器里的扩展。
 *
 * @param {{fs?:object, browsers?:Array}} [deps]
 *   注入 fs 与浏览器表 —— 都只为可测：真实路径来自环境变量，
 *   不注入的话单测只能去读**跑测试那台机器**上装了什么，换台机器就红。
 * @returns {Array<{key,browserId,browser,profile,crxId,version,dir,name,description,manifestVersion}>}
 */
function scan(deps = {}) {
  const fsx = deps.fs || fs;
  const browsers = deps.browsers || BROWSERS;
  const out = [];

  for (const b of browsers) {
    // 只有 Chromium 系有这种「Extensions/<id>/<版本>/」布局；
    // 火狐的扩展是 xpi、存在别处（而且本项目对 .xpi 的支持是另一条路）
    if (b.format !== 'chromium-json') continue;

    for (const p of profileDirs(b, fsx)) {
      let ids = [];
      try { ids = fsx.readdirSync(p.dir, { withFileTypes: true }); } catch { continue; }

      for (const idDir of ids) {
        // 这条同时挡掉了 `Temp` 以及别的不相干目录 —— 只有合法 crxId 才算
        if (!idDir.isDirectory() || !CRX_ID_RE.test(idDir.name)) continue;
        const idPath = path.join(p.dir, idDir.name);

        let versions = [];
        try { versions = fsx.readdirSync(idPath, { withFileTypes: true }); } catch { continue; }

        const found = [];
        for (const v of versions) {
          if (!v.isDirectory()) continue;
          const dir = path.join(idPath, v.name);
          const mf = path.join(dir, 'manifest.json');
          if (!fsx.existsSync(mf)) continue;
          let manifest = null;
          try { manifest = JSON.parse(fsx.readFileSync(mf, 'utf8')); } catch { continue; }
          found.push({
            dir,
            version: manifest.version || v.name,
            name: resolveMessage(dir, manifest, manifest.name) || idDir.name,
            description: resolveMessage(dir, manifest, manifest.description || ''),
            manifestVersion: manifest.manifest_version
          });
        }
        const pick = pickNewestVersion(found);
        if (!pick) continue;

        out.push({
          // 界面上传的是这个 key，不是路径 —— 主进程再扫一次自己解析出目录。
          // 让渲染层直接传目录路径等于「把任意目录当扩展装载」的口子。
          key: `${b.id}:${idDir.name}`,
          browserId: b.id,
          browser: b.name,
          profile: p.profile,
          crxId: idDir.name,
          version: pick.version,
          dir: pick.dir,
          name: pick.name,
          description: pick.description,
          manifestVersion: pick.manifestVersion
        });
      }
    }
  }
  // 名字排序，让列表稳定（同一个扩展在不同浏览器里都有时会挨在一起）
  out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
  return out;
}

/** 递归复制，跳过 `_metadata`。 */
function copyTree(from, to, fsx) {
  fsx.mkdirSync(to, { recursive: true });
  for (const k of fsx.readdirSync(from, { withFileTypes: true })) {
    /* `_metadata` 是 Chromium 自己放的校验信息（verified_contents.json 之类），
     * 不是扩展的一部分。搬过去只会让 Electron 那边多看到一份它不认识的目录。 */
    if (k.name === '_metadata') continue;
    const src = path.join(from, k.name);
    const dst = path.join(to, k.name);
    if (k.isDirectory()) copyTree(src, dst, fsx);
    else if (k.isFile()) fsx.copyFileSync(src, dst);
  }
}

/**
 * 把一个已扫到的扩展**复制**到我们自己的目录，返回可交给 install() 的路径。
 *
 * <p>为什么是复制而不是直接用原目录：Edge 更新扩展时会删掉旧版本目录，
 * 那时我们的记录就指向一条不存在的路径 —— 下次启动扩展「自己不见了」，
 * 而用户完全不知道发生了什么。
 *
 * <p>目录名沿用 {@link unpackDirFor} 那套规则（来源路径的哈希），
 * 所以同一个来源重复导入会复用同一个目录、不会越攒越多。
 *
 * @param {{dir:string,name:string,crxId:string,version:string}} entry
 * @param {string} workDir
 * @param {object} [fsx]
 * @returns {string} 目标目录
 */
function importToOneDir(entry, workDir, fsx = fs) {
  const base = String(entry.name || entry.crxId || 'ext')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .slice(0, 40) || 'ext';
  // 哈希来源**在磁盘上的位置**（含版本号），所以 Edge 更新扩展之后
  // 会落到另一个目录、而不是把新版混进旧目录里
  const h = crypto.createHash('sha1').update(path.resolve(entry.dir)).digest('hex').slice(0, 8);
  const dest = path.join(workDir, `${base}-${h}`);
  fsx.rmSync(dest, { recursive: true, force: true });
  copyTree(entry.dir, dest, fsx);
  return dest;
}

module.exports = { CRX_ID_RE, profileDirs, scan, importToOneDir, copyTree };
