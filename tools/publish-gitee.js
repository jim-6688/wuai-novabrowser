#!/usr/bin/env node
/**
 * 自动发布到 Gitee Release。
 *
 * 一条命令完成「创建/更新 Release + 上传 APK 附件」，不再进 Gitee 网页点确认。
 *
 * 用法：
 *   GITEE_TOKEN=xxx node tools/publish-gitee.js                 # Android APK
 *   GITEE_TOKEN=xxx node tools/publish-gitee.js --pc <exe路径>  # PC 安装包
 *   GITEE_TOKEN=xxx node tools/publish-gitee.js --apk <apk路径> --pc <exe路径>
 *
 * Token 获取：Gitee → 头像 → 设置 → 私人令牌 → 生成新令牌（勾选 projects 权限）。
 * Token 也可写进本地 .env 文件（GITEE_TOKEN=xxx，已 gitignore），脚本会自动读，
 * 这样命令行就不用每次带 token 了。
 *
 * 版本号唯一来源：android-app/app/src/main/res/values/strings.xml 的 app_version。
 * PC 版版本号从 package.json 的 version 字段读。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'jinghe-net';
const REPO = 'i-adore-the-nova-browser';
const API = 'https://gitee.com/api/v5';

// ---------------- 参数解析 ----------------
function parseArgs(argv) {
  const out = { apk: null, pc: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apk') out.apk = argv[++i];
    else if (a === '--pc') out.pc = argv[++i];
    else if (a === '--dry' || a === '--dry-run') out.dry = true;
  }
  return out;
}

// ---------------- token ----------------
function readToken() {
  if (process.env.GITEE_TOKEN) return process.env.GITEE_TOKEN.trim();
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*GITEE_TOKEN\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

// ---------------- 版本号 ----------------
function appVersion() {
  const f = path.join(ROOT, 'android-app/app/src/main/res/values/strings.xml');
  const m = fs.readFileSync(f, 'utf8').match(/name="app_version"\s*>([^<]+)</);
  if (!m) throw new Error('strings.xml 里找不到 app_version');
  return m[1].trim();
}

function pcVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return pkg.version || '0.1.0';
}

function changelog() {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'site/version.json'), 'utf8'));
  const lines = (v.changelog || []).map((s) => '- ' + s);
  return lines.join('\n');
}

// ---------------- HTTP ----------------
function request(method, urlStr, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: opts.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let body = data;
        try { body = JSON.parse(data); } catch (e) { /* 非 JSON 就原样返回 */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function qs(obj) {
  return Object.keys(obj).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])).join('&');
}

// ---------------- 主流程 ----------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = readToken();
  if (!token) {
    console.error('✗ 没有 GITEE_TOKEN。请先：');
    console.error('  Gitee → 头像 → 设置 → 私人令牌 → 生成新令牌（勾选 projects 权限）');
    console.error('  然后：GITEE_TOKEN=xxx node tools/publish-gitee.js');
    console.error('  或把 GITEE_TOKEN=xxx 写进仓库根目录的 .env 文件（已 gitignore）');
    process.exit(1);
  }

  const ver = appVersion();
  const tag = 'v' + ver;
  const body = changelog() + '\n\n（由 tools/publish-gitee.js 自动发布）';

  console.log('== 吾爱Nova浏览器 · 自动发布 Gitee Release ==');
  console.log('版本: ' + ver + '  tag: ' + tag);

  // 1. 创建 Release（若已存在则 Gitee 会报错，走更新逻辑）
  const createUrl = `${API}/repos/${OWNER}/${REPO}/releases?${qs({ access_token: token })}`;
  const createBody = JSON.stringify({
    tag_name: tag,
    name: 'v' + ver,
    body,
    target_commitish: 'main',
    prerelease: false,
  });

  let release;
  const created = await request('POST', createUrl, {
    headers: { 'Content-Type': 'application/json' },
    body: createBody,
  });

  if (created.status === 201 || created.status === 200) {
    release = created.body;
    console.log('✓ 已创建 Release: ' + tag);
  } else if (created.status === 422 || created.status === 400) {
    // tag 已存在：尝试拿现有 release，走「重新上传附件」
    console.log('  Release 已存在，改为上传附件到现有 tag');
    release = { tag_name: tag };
  } else {
    console.error('✗ 创建 Release 失败: HTTP ' + created.status);
    console.error(JSON.stringify(created.body, null, 2));
    process.exit(1);
  }

  if (args.dry) {
    console.log('（--dry-run，到此为止，未真正上传附件）');
    return;
  }

  // 2. 上传附件
  const files = [];
  if (args.apk) {
    files.push({ path: args.apk, name: 'nova-' + ver + '.apk' });
  } else {
    const defApk = path.join(ROOT, 'site/download/nova-' + ver + '.apk');
    if (fs.existsSync(defApk)) files.push({ path: defApk, name: 'nova-' + ver + '.apk' });
  }
  if (args.pc) {
    files.push({ path: args.pc, name: 'nova-pc-' + pcVersion() + '-win-x64-setup.exe' });
  }

  if (files.length === 0) {
    console.warn('⚠ 没有可上传的附件（APK 未找到，且未指定 --pc）');
    console.warn('  APK 应在: site/download/nova-' + ver + '.apk');
    process.exit(0);
  }

  for (const f of files) {
    if (!fs.existsSync(f.path)) {
      console.error('✗ 附件不存在: ' + f.path);
      process.exit(1);
    }
    await uploadAsset(token, tag, f.path, f.name);
  }

  console.log('\n✓ 全部完成。Release: https://gitee.com/' + OWNER + '/' + REPO + '/releases/tag/' + tag);
}

async function uploadAsset(token, tag, filePath, fileName) {
  // 2a. 拿预签名上传地址
  const upUrl = `${API}/repos/${OWNER}/${REPO}/releases/${tag}/upload_url?${qs({
    access_token: token,
    file_name: fileName,
  })}`;
  const got = await request('GET', upUrl);
  if (got.status !== 200 || !got.body.url) {
    console.error('✗ 获取上传地址失败: HTTP ' + got.status);
    console.error(JSON.stringify(got.body, null, 2));
    process.exit(1);
  }

  const uploadUrl = got.body.url;
  const headers = got.body.headers || {};
  const data = fs.readFileSync(filePath);

  console.log('  上传附件: ' + fileName + ' (' + (data.length / 1024).toFixed(0) + ' KB) → ' + uploadUrl);

  const res = await new Promise((resolve, reject) => {
    const u = new URL(uploadUrl);
    const req = https.request({
      method: 'PUT',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Length': data.length }, headers),
    }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve({ status: r.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });

  if (res.status >= 200 && res.status < 300) {
    console.log('  ✓ 上传成功: ' + fileName);
  } else {
    console.error('  ✗ 上传失败: HTTP ' + res.status + ' ' + res.body);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('✗ 出错: ' + e.message);
  process.exit(1);
});
