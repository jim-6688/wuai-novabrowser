#!/usr/bin/env node
/**
 * 自动发布到 GitHub Release。
 *
 * 一条命令完成「创建/复用 Release + 上传安装包附件 + 校验直链」，
 * 不用打开 github.com 网页（本机该域名常被干扰，API 反而是通的）。
 *
 * 用法：
 *   GH_TOKEN=ghp_xxx npm run publish:github
 *   GH_TOKEN=ghp_xxx npm run publish:github -- --pc dist/nova-pc-2.0.2-win-x64-setup.exe
 *   GH_TOKEN=ghp_xxx npm run publish:github -- --dry        # 只看要做什么，不真的改
 *
 * 版本号：package.json 的 version（与 site/version.json 的 pc.version 应一致）。
 * 附件名：nova-pc-<版本>-win-x64-setup.exe。
 * 说明正文：从 site/version.json 的 pc.changelog + sha256/size 生成。
 *
 * Token 权限：仓库是公开的，classic 勾 `public_repo` 即可（或 fine-grained 的
 * Contents: Read and write）。**不要**勾 admin/delete_repo/workflow。
 *
 * 幂等：Release 已存在就复用（不覆盖正文，除非给 --refresh-body）；
 * 同名附件已存在且大小一致就跳过，大小不同才删掉重传。
 * 所以「没传完/传一半失败」时直接重跑即可，不会堆出重复附件。
 *
 * 顺序：先 `git push`（tag 要落在正确提交上）再跑本脚本。
 * 走 curl 而不是 Node 原生 https：curl 自动继承系统代理，
 * 这台机器上 GitHub 依赖 VPN 代理（见项目备忘）。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

// ---------------- 参数解析 ----------------
function parseArgs(argv) {
  const out = { pc: null, tag: null, dry: false, refreshBody: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pc') out.pc = argv[++i];
    else if (a === '--tag') out.tag = argv[++i];
    else if (a === '--dry') out.dry = true;
    else if (a === '--refresh-body') out.refreshBody = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  return out;
}

function log(...xs) { console.log(...xs); }

// ---------------- 仓库 / 版本 ----------------
/** 从 git remote 读 owner/repo，免得仓库改名后脚本里还写着旧地址。 */
function repoFromRemote() {
  let url = '';
  try {
    url = execFileSync('git', ['remote', 'get-url', 'github'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    try {
      url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch { /* 下面统一报错 */ }
  }
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error('没能从 git remote 解析出 GitHub 的 owner/repo（需要一条指向 github.com 的 remote）');
  return { owner: m[1], repo: m[2], url };
}

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'version.json'), 'utf8'));
  } catch { /* 没有清单也能发，只是正文少点东西 */ }
  return { version: pkg.version, pc: manifest && manifest.pc ? manifest.pc : null };
}

// ---------------- curl 封装 ----------------
/** 返回 { code, body }；body 已尝试按 JSON 解析。 */
function curl(args, { token, json = true, timeout = 120 } = {}) {
  const full = ['-sS', '-w', '\n%{http_code}', '--max-time', String(timeout)];
  if (token) full.push('-H', `Authorization: token ${token}`);
  full.push('-H', 'Accept: application/vnd.github+json', ...args);
  let out;
  try {
    out = execFileSync('curl', full, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`curl 调用失败：${(e.stderr || e.message || '').toString().slice(0, 300)}`);
  }
  const idx = out.lastIndexOf('\n');
  const code = parseInt(out.slice(idx + 1).trim(), 10);
  const raw = out.slice(0, idx);
  let body = raw;
  if (json && raw.trim()) { try { body = JSON.parse(raw); } catch { /* 保留原文 */ } }
  return { code, body, raw };
}

function api(token, method, p, payload, opts = {}) {
  const args = ['-X', method, `${API}${p}`];
  if (payload !== undefined) {
    args.push('-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(payload));
  }
  return curl(args, { token, ...opts });
}

// ---------------- Release 正文 ----------------
function releaseBody(pc, version) {
  const lines = [];
  lines.push(`## 吾爱Nova 浏览器 · PC ${version}`);
  lines.push('');
  lines.push('Windows x64 · EXE 安装程序 · 约 102 MB · 需要 Windows 10 及以上');
  if (pc && Array.isArray(pc.changelog) && pc.changelog.length) {
    lines.push('');
    lines.push('### 本次更新');
    pc.changelog.forEach((x) => lines.push(`- ${x}`));
  }
  if (pc && pc.url) {
    lines.push('');
    lines.push('### 下载');
    lines.push(`- 官网（多吉云 CDN）：${pc.url}`);
  }
  if (pc && (pc.sha256 || pc.size)) {
    lines.push('');
    lines.push('### 校验');
    if (pc.sha256) lines.push(`- sha256：\`${pc.sha256}\``);
    if (pc.size) lines.push(`- size：${pc.size} 字节`);
  }
  return lines.join('\n');
}

// ---------------- 主流程 ----------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log('用法：GH_TOKEN=ghp_xxx npm run publish:github [-- --pc <文件>] [--tag v<x.y.z>] [--dry] [--refresh-body]');
    return;
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!token) throw new Error('缺 GH_TOKEN（classic PAT 勾 public_repo 即可；不要写进仓库里的文件）');

  const { owner, repo } = repoFromRemote();
  const { version, pc } = readVersion();
  const tag = args.tag || `v${version}`;
  const file = path.resolve(ROOT, args.pc || `dist/nova-pc-${version}-win-x64-setup.exe`);

  if (!fs.existsSync(file)) throw new Error(`找不到安装包：${file}（先 npm run pc:build）`);
  const size = fs.statSync(file).size;
  const name = path.basename(file);

  log(`仓库    : ${owner}/${repo}`);
  log(`tag     : ${tag}`);
  log(`附件    : ${name}（${size} 字节 / ${(size / 1048576).toFixed(1)} MB）`);
  if (pc && pc.version && pc.version !== version) {
    log(`注意    : package.json 是 ${version}，但 site/version.json 的 pc.version 是 ${pc.version} —— 建议先同步`);
  }
  if (args.dry) { log('--dry：到此为止，未做任何改动'); return; }

  // 0) token 身份
  const me = api(token, 'GET', '/user', undefined, { timeout: 30 });
  if (me.code !== 200) throw new Error(`token 无效或权限不足（HTTP ${me.code}）`);
  log(`身份    : ${me.body.login}`);

  // 1) 找已有的 Release（按 tag）
  let release = null;
  const found = api(token, 'GET', `/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, undefined, { timeout: 40 });
  if (found.code === 200 && found.body && found.body.id) {
    release = found.body;
    log(`Release : 复用已存在的 #${release.id}`);
    if (args.refreshBody) {
      const upd = api(token, 'PATCH', `/repos/${owner}/${repo}/releases/${release.id}`, { body: releaseBody(pc, version) });
      if (upd.code === 200) log('          正文已刷新');
      else log(`          正文刷新失败（HTTP ${upd.code}）`);
    }
  } else if (found.code === 404) {
    const created = api(token, 'POST', `/repos/${owner}/${repo}/releases`, {
      tag_name: tag,
      target_commitish: 'main',
      name: `PC ${version}`,
      body: releaseBody(pc, version),
      draft: false,
      prerelease: false
    }, { timeout: 60 });
    if (created.code !== 201) throw new Error(`创建 Release 失败（HTTP ${created.code}）：${JSON.stringify(created.body).slice(0, 300)}`);
    release = created.body;
    log(`Release : 新建 #${release.id} ${release.html_url}`);
  } else {
    throw new Error(`查询 Release 失败（HTTP ${found.code}）：${JSON.stringify(found.body).slice(0, 300)}`);
  }

  // 2) 附件：同名同大小就跳过，否则删旧的再传
  const assets = release.assets || [];
  const same = assets.find((a) => a.name === name);
  if (same && same.size === size) {
    log(`附件    : 已存在且大小一致，跳过上传（asset #${same.id}）`);
  } else {
    if (same) {
      log(`附件    : 同名但大小不同（${same.size} → ${size}），先删旧的 #${same.id}`);
      const del = api(token, 'DELETE', `/repos/${owner}/${repo}/releases/assets/${same.id}`);
      if (del.code !== 204) log(`          删除失败（HTTP ${del.code}），将继续尝试上传`);
    }
    log('附件    : 上传中（102 MB 左右，通常 30–90 秒）…');
    const up = curl([
      '-X', 'POST',
      '-H', 'Content-Type: application/x-msdownload',
      '--data-binary', `@${file}`,
      `${UPLOADS}/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`
    ], { token, timeout: 1800 });
    if (up.code !== 201) throw new Error(`上传失败（HTTP ${up.code}）：${JSON.stringify(up.body).slice(0, 300)}`);
    log(`附件    : 完成 asset #${up.body.id}，state=${up.body.state}`);
  }

  // 3) 校验：主判据走 API（不依赖 github.com 网页域，这台机器上它常被干扰），
  //    直链只在能连通时顺手探一下，失败只提示、不影响发布结果。
  let asset = null;
  const list = api(token, 'GET', `/repos/${owner}/${repo}/releases/${release.id}/assets`, undefined, { timeout: 40 });
  if (list.code === 200 && Array.isArray(list.body)) asset = list.body.find((a) => a.name === name) || null;
  if (asset) {
    const ok = asset.size === size && asset.state === 'uploaded';
    log(`校验    : ${ok ? 'OK' : '注意'}（API：size=${asset.size} / 本地 ${size} / state=${asset.state}）`);
  } else {
    log('校验    : 注意（API 里没查到该附件，请到 Release 页面确认）');
  }

  const url = `https://github.com/${owner}/${repo}/releases/download/${tag}/${name}`;
  log(`直链    : ${url}`);
  try {
    const head = curl(['-I', '-L', url], { json: false, timeout: 60 });
    const m = /content-length:\s*(\d+)/i.exec(head.raw || '');
    const got = m ? parseInt(m[1], 10) : 0;
    log(`          直链探测：${got === size ? 'OK' : '未取到/不一致'}（Content-Length=${got || '解析不到'}）`);
  } catch {
    log('          直链探测：跳过（本机连不上 github.com，属网络环境问题，附件本身已上传成功）');
  }
}

try {
  main();
} catch (e) {
  console.error('发布失败：' + e.message);
  process.exit(1);
}
