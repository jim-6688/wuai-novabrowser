#!/usr/bin/env node
/**
 * 自动发布到 Gitee Release。
 *
 * 一条命令完成「创建/更新 Release + 上传 APK 附件」，不再进 Gitee 网页点确认。
 *
 * 用法：
 *   npm run publish:gitee                                       # Android：自动找 site/download/nova-<版本>.apk
 *   npm run publish:gitee -- --pc dist/nova-pc-<版本>-win-x64-setup.zip
 *   npm run publish:gitee -- --apk <apk路径> --pc <zip路径>      # 两个都要传时显式写全
 *
 *   PC 版主发 .zip（见 tools/make-zip.js 的说明），附件名按源文件后缀生成。
 *
 * 规则：不给任何文件参数时才去猜默认 APK 路径；给了 --apk / --pc 就只传给的那个。
 *
 * Token：**零配置**。依次尝试 GITEE_TOKEN 环境变量 → 仓库根 .env（已 gitignore）
 * → ~/.git-credentials 里 gitee.com 那条凭据（Gitee 允许把私人令牌当 git 密码用，
 * 所以那串 32 字符本身就是合法令牌）。三种都没有才报错。
 *
 * 版本号唯一来源：android-app/app/src/main/res/values/strings.xml 的 app_version。
 * PC 版版本号从 package.json 的 version 字段读。
 *
 * 顺序要求：本脚本按 tag 在 **Gitee 服务端** 的 main 上打 tag，
 * 所以必须先 `git push` 再跑本脚本，否则 tag 会落在上一个提交上。
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
  const out = { apk: null, pc: null, dry: false, tag: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apk') out.apk = argv[++i];
    else if (a === '--pc') out.pc = argv[++i];
    // 只改 PC 的那一版（安卓没重发）必须显式给 tag —— 默认的 tag 跟着
    // strings.xml 的 app_version 走，不给的话会去复用上一版的 Release，
    // 表现为「文件传到旧版本下面去了」，而且配额算在旧版本头上。
    else if (a === '--tag') out.tag = argv[++i];
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
  // 兜底：从 git 的凭据文件里读 gitee 的 token（很多人用 token 当 git 密码，
  // 它就是合法的私人令牌）。路径兼容 Windows（HOME）与 macOS/Linux（~）。
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) {
    const cred = path.join(home, '.git-credentials');
    if (fs.existsSync(cred)) {
      for (const line of fs.readFileSync(cred, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^https:\/\/[^:]+:([^@]+)@gitee\.com/);
        if (m) return decodeURIComponent(m[1]);
      }
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

function changelog(tag) {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'site/version.json'), 'utf8'));
  // PC 版（v1.0.x）的更新日志在 pc.changelog 里，和安卓那份是两套。
  // 早先一律取顶层，结果 PC Release 的正文写着安卓的更新内容 —— 看的人
  // 会以为这一版也发了安卓包。
  const list = /^v1\.0\./.test(tag || '') ? ((v.pc && v.pc.changelog) || []) : (v.changelog || []);
  return list.map((s) => '- ' + s).join('\n');
}

// ---------------- HTTP ----------------
function request(method, urlStr, opts) {
  opts = opts || {};
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
  const tag = args.tag || ('v' + ver);
  // 只发 PC 那一版时，报出来的版本要用 PC 自己的号 ——
  // 否则 Release 标题写着 1.6.4 而附件是 1.0.4，看的人会以为安卓也发了。
  const shownVer = /^v1\.0\./.test(tag) ? 'PC ' + tag.slice(1) : ver;
  const body = changelog(tag) + '\n\n（由 tools/publish-gitee.js 自动发布）';

  console.log('== 吾爱Nova浏览器 · 自动发布 Gitee Release ==');
  console.log('版本: ' + shownVer + '  tag: ' + tag);

  // 1. 创建 Release（若已存在则 Gitee 会报错，走更新逻辑）
  const createUrl = `${API}/repos/${OWNER}/${REPO}/releases?${qs({ access_token: token })}`;
  const createBody = JSON.stringify({
    tag_name: tag,
    // 标题跟 tag 走：只发 PC 那一版时 appVersion() 还是安卓的号，
    // 用它会写出一版标题叫 v1.6.5、附件却是 1.0.25 的 Release。
    name: tag,
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
    console.log('✓ 已创建 Release: ' + tag + ' (id=' + release.id + ')');
  } else if (created.status === 422 || created.status === 400) {
    // tag 已存在：按 tag 名拿现有 release 的 id
    console.log('  Release 已存在，按 tag 查 id');
    const getUrl = `${API}/repos/${OWNER}/${REPO}/releases/tags/${tag}?${qs({ access_token: token })}`;
    const got = await request('GET', getUrl);
    if (got.status === 200 && got.body.id) {
      release = got.body;
      console.log('  现有 Release id=' + release.id);
    } else {
      console.error('✗ 拿不到已有 Release 的 id: HTTP ' + got.status);
      console.error(JSON.stringify(got.body, null, 2));
      process.exit(1);
    }
  } else {
    console.error('✗ 创建 Release 失败: HTTP ' + created.status);
    console.error(JSON.stringify(created.body, null, 2));
    process.exit(1);
  }

  const releaseId = release.id;
  if (!releaseId) {
    console.error('✗ 创建/查询 Release 未返回 id');
    process.exit(1);
  }

  if (args.dry) {
    console.log('（--dry-run，到此为止，未真正上传附件）');
    return;
  }

  // 2. 上传附件
  //
  // 默认（一个文件参数都不给）才去猜 site/download 下的 APK。
  // 只要显式给了 --apk 或 --pc，就以给的那个为准 —— 否则
  // `--pc xxx.exe` 会顺带把 APK 再传一次，Release 里出现两条同名附件。
  const explicit = !!(args.apk || args.pc);
  const files = [];
  if (args.apk) {
    files.push({ path: args.apk, name: 'nova-' + ver + '.apk' });
  } else if (!explicit) {
    const defApk = path.join(ROOT, 'site/download/nova-' + ver + '.apk');
    if (fs.existsSync(defApk)) files.push({ path: defApk, name: 'nova-' + ver + '.apk' });
  }
  if (args.pc) {
    // 附件名跟着**实际文件的后缀**走，不写死 .exe。
    // PC 版现在主发 .zip（浏览器对 .exe 直接下载会弹「不常下载」风险提示，
    // 套一层压缩包就干净了），但偶尔也会直接传 .exe 做备份。写死的话
    // 会把 zip 传成 exe 名字 —— 用户下到的文件后缀和实际格式对不上，
    // 反而更容易被浏览器拦，解压时也会报「不是有效的压缩包」。
    //
    // 已经是 nova-pc-* 这种成品名的（比如 -green.zip）就原样用：
    // 官网 version.json 里写的下载地址正是这个文件名，改名会让链接 404。
    const ext = path.extname(args.pc) || '.exe';
    const base = path.basename(args.pc);
    const name = /^nova-pc-.*\.(zip|exe)$/i.test(base)
      ? base
      : 'nova-pc-' + pcVersion() + '-win-x64-setup' + ext;
    files.push({ path: args.pc, name });
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
    await uploadAsset(token, releaseId, f.path, f.name);
  }

  console.log('\n✓ 全部完成。Release: https://gitee.com/' + OWNER + '/' + REPO + '/releases/tag/' + tag);
}

/**
 * 上传附件到指定 release（用 release 的整数 id）。
 * Gitee 接口：POST /api/v5/repos/{owner}/{repo}/releases/{release_id}/attach_files
 * multipart/form-data，字段 access_token + file。
 */
async function uploadAsset(token, releaseId, filePath, fileName) {
  const data = fs.readFileSync(filePath);
  const boundary = '----NovaBoundary' + Date.now() + Math.random().toString(16).slice(2);

  const header =
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="access_token"\r\n\r\n' +
    token + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="' + fileName + '"\r\n' +
    'Content-Type: application/octet-stream\r\n\r\n';
  const footer = '\r\n--' + boundary + '--\r\n';

  const body = Buffer.concat([
    Buffer.from(header, 'utf8'),
    data,
    Buffer.from(footer, 'utf8'),
  ]);

  console.log('  上传附件: ' + fileName + ' (' + (data.length / 1024).toFixed(0) + ' KB) → release id=' + releaseId);

  const pathStr = `/api/v5/repos/${OWNER}/${REPO}/releases/${releaseId}/attach_files`;
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      hostname: 'gitee.com',
      path: pathStr,
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
      },
    }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve({ status: r.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (res.status >= 200 && res.status < 300) {
    console.log('  ✓ 上传成功: ' + fileName);
  } else {
    console.error('  ✗ 上传失败: HTTP ' + res.status);
    console.error('  ' + res.body.slice(0, 500));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('✗ 出错: ' + e.message);
  process.exit(1);
});
