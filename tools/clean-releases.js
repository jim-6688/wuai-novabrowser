'use strict';
/**
 * 清理 Gitee 的旧 Release —— 为发布腾出配额。
 *
 * <p><b>为什么需要它</b>：Gitee 的 Release 附件配额是 <b>1 GB</b>，
 * 而本项目每版 PC 要传 zip + exe 两个 75 MB 的包 —— 算上历史几版就超了，
 * 表现是发布时报「文件大小已超出仓库附件配额：1 GB」。
 *
 * <p>这不是发布脚本的 bug，而是配额与产物大小的固有矛盾：78 MB × 2 × 6 版就满了。
 * 两条出路：清旧版（这个脚本）、或以后只传 zip。
 *
 * <p><b>删的是整个 Release，不是单个附件</b>。原因踩过：Gitee v5 的
 * releases 列表里，assets 只有 {@code browser_download_url} 与 {@code name}
 * 两个字段，**没有 id** —— 于是按 `releases/attachments/<id>` 删会全部 404。
 * 拿不到附件 id 就只能整版删，而旧版本来也没人再下载，正好一并清掉。
 *
 * <p><b>默认不动手</b>：必须显式给 {@code --keep} 之外的 {@code --yes} 才真删，
 * 且默认只删**排在前面、且不含当前版本**的那些 release。
 *
 * 用法：
 *   node tools/clean-releases.js --dry           # 只看会删什么
 *   node tools/clean-releases.js --yes           # 真删
 *   node tools/clean-releases.js --yes --keep v1.0.4 --keep v1.6.5
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = 'https://gitee.com/api/v5';
const OWNER = 'jinghe-net';
const REPO = 'i-adore-the-nova-browser';

function readToken() {
  if (process.env.GITEE_TOKEN) return process.env.GITEE_TOKEN.trim();
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/GITEE_TOKEN\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  }
  // 兜底与 publish-gitee.js 同一套：从 git 凭据里取 gitee 的 token
  // （很多人直接拿私人令牌当 git 密码）。路径兼容 Windows 与 macOS/Linux。
  // 少了这段的话，这个脚本会在有 .git-credentials 的机器上莫名其妙说没 token。
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) {
    const cred = path.join(home, '.git-credentials');
    if (fs.existsSync(cred)) {
      const m = fs.readFileSync(cred, 'utf8')
        .match(/^https:\/\/[^:]+:([^@]+)@gitee\.com/m);
      if (m) return decodeURIComponent(m[1]);
    }
  }
  return '';
}

function request(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        Accept: 'application/json',
        Authorization: `token ${readToken()}`,
        'User-Agent': 'nova-clean',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* 非 JSON 原样回 */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error(`HTTP ${res.statusCode}: ${String(raw).slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 当前该保住的 tag：清单里两个版本号对应的那两个。 */
function currentTags() {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'version.json'), 'utf8'));
  return new Set([`v${v.version}`, `v${v.pc.version}`]);
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const yes = args.includes('--yes');
  const keeps = new Set(currentTags());
  const keepTagsFromArgs = new Set();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keep') keepTagsFromArgs.add(args[++i]);
  }

  if (!readToken()) {
    console.error('✗ 没有 GITEE_TOKEN（环境变量或仓库根目录的 .env）');
    process.exit(1);
  }

  const list = await request('GET',
    `${API}/repos/${OWNER}/${REPO}/releases?per_page=50`);
  const releases = Array.isArray(list) ? list : [];

  // 要删的是**整个非当前版本的 Release**（原因见文件头：拿不到附件 id）。
  // 按 created_at 升序删 —— 先删最老的，万一需要回溯，最近的版本还留着。
  const victims = releases
    .filter((r) => !keeps.has(r.tag_name))
    .filter((r) => !keepTagsFromArgs.has(r.tag_name))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  const nAssets = victims.reduce((n, r) => n + (r.assets || []).length, 0);
  const names = victims.flatMap((r) => (r.assets || []).map((a) => a.name));

  console.log(`共 ${releases.length} 个 Release，保留 ${[...keeps].join(', ')}`);
  console.log(`可清理 ${victims.length} 个旧 Release（共 ${nAssets} 个附件）：`);
  for (const r of victims) {
    console.log(`  ${r.tag_name}  ${(r.assets || []).length} 个附件  `
      + `(${(r.assets || []).map((a) => a.name).join(', ')})`);
  }

  if (!victims.length) {
    console.log('没有可清理的旧版本。');
    return;
  }
  if (dry || !yes) {
    console.log('\n这是演练。加 --yes 才真删（整版删除，不可逆）。');
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const r of victims) {
    try {
      await request('DELETE', `${API}/repos/${OWNER}/${REPO}/releases/${r.id}`);
      console.log(`  ✓ 删除 ${r.tag_name}`);
      ok++;
    } catch (e) {
      console.log(`  ✗ ${r.tag_name}: ${e.message}`);
      failed++;
    }
  }
  console.log(`\n完成：删除 ${ok} 个 Release（其中 ${names.length} 个附件），失败 ${failed} 个`);
}

main().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});