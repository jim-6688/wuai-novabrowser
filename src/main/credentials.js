'use strict';

/**
 * 从 Edge / Chromium 系浏览器导入已保存的账号密码。
 * ---------------------------------------------------------------------------
 * 为什么这么做：用户想换到 Nova 时，一堆网站的账号密码已在 Edge 里存着；
 * 逐个重新登录太麻烦。这里把 Edge 的「Login Data」(SQLite) 读出来、按 Edge 的
 * 加密方式解密，交给调用方加密保存。
 *
 * 安全约定（务必守住）：
 *   - **只读** Edge 的数据，绝不写回；Edge 运行时会锁「Login Data」，先复制一份再读。
 *   - 解密在**本机**完成，明文只在主进程内存里短暂存在，**不写日志、不联网**。
 *   - DPAPI 需要以「同一个 Windows 用户」运行（就是本程序运行的那个用户）。
 *
 * 加密格式（Chromium 系）：
 *   - `Local State` → `os_crypt.encrypted_key` = base64( "DPAPI" + DPAPI(AES-256 key) )
 *   - `Login Data` 的 `logins.password_value` = "v10" + nonce(12) + ciphertext + tag(16)
 *     用上面那把 32 字节 key 做 AES-256-GCM 解密。
 *   - 较新版本的 "v20" 是 App-Bound 加密，需要浏览器自己的解密服务，这里不支持，跳过并如实计数。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

function edgeUserDataDir() {
  const base = process.env.LOCALAPPDATA;
  if (!base) return null;
  const p = path.join(base, 'Microsoft', 'Edge', 'User Data');
  return fs.existsSync(p) ? p : null;
}

/** 列出有 Login Data 的 Edge 配置档。 */
function edgeProfiles() {
  const root = edgeUserDataDir();
  if (!root) return [];
  const out = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  for (const name of names) {
    if (name !== 'Default' && !/^Profile \d+$/.test(name)) continue;
    const dir = path.join(root, name);
    const loginData = path.join(dir, 'Login Data');
    if (fs.existsSync(loginData)) out.push({ name, dir, loginData });
  }
  return out;
}

/** 调 Windows DPAPI 解一段 DPAPI 保护的 buffer（走 PowerShell，无需原生模块）。 */
function dpapiUnprotect(buf) {
  return new Promise((resolve, reject) => {
    const b64 = buf.toString('base64');
    // execFile 不经过 shell，参数原样传给 powershell，免去引号转义坑
    const ps = "$ErrorActionPreference='Stop';"
      + 'Add-Type -AssemblyName System.Security;'
      + `$b=[Convert]::FromBase64String('${b64}');`
      + "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');"
      + '[Convert]::ToBase64String($p)';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
      (err, stdout) => {
        if (err) return reject(new Error('DPAPI 解密失败（需以同一 Windows 用户运行）：' + (err.message || err)));
        const out = String(stdout || '').trim();
        if (!out || !/^[A-Za-z0-9+/=]+$/.test(out)) return reject(new Error('DPAPI 返回异常'));
        resolve(Buffer.from(out, 'base64'));
      });
  });
}

/** 取 Edge 的 AES-256 key（从 Local State 的 os_crypt.encrypted_key）。 */
async function edgeAesKey() {
  const root = edgeUserDataDir();
  if (!root) throw new Error('没有找到 Edge 用户数据目录（未安装或用的是别的用户）');
  const lsPath = path.join(root, 'Local State');
  if (!fs.existsSync(lsPath)) throw new Error('没有找到 Edge 的 Local State');
  let ls;
  try { ls = JSON.parse(fs.readFileSync(lsPath, 'utf8')); }
  catch { throw new Error('Edge Local State 解析失败'); }
  const ek = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
  if (!ek) throw new Error('Edge Local State 里没有 os_crypt.encrypted_key');
  let buf = Buffer.from(ek, 'base64');
  if (buf.slice(0, 5).toString() === 'DPAPI') buf = buf.slice(5);
  const key = await dpapiUnprotect(buf);
  if (key.length !== 32) throw new Error('DPAPI 解出的 key 长度异常：' + key.length);
  return key;
}

/** 解一条 password_value。返回 { plain } 或 { unsupported: 'v20' }。 */
function decryptPassword(blob, key) {
  const buf = Buffer.from(blob);
  if (buf.length < 3) return { unsupported: 'empty' };
  const prefix = buf.slice(0, 3).toString();
  if (prefix !== 'v10') return { unsupported: prefix };
  if (buf.length < 3 + 12 + 16) return { unsupported: 'short' };
  const nonce = buf.slice(3, 15);
  const tag = buf.slice(buf.length - 16);
  const ct = buf.slice(15, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(ct), d.final()]);
  return { plain: plain.toString('utf8') };
}

/**
 * 读取所有 Edge 配置档里已保存的账号密码。
 * 返回 { items:[{origin, username, password}], skipped } —— skipped 是解不开/不支持的条数。
 */
async function readEdgeLogins() {
  const profiles = edgeProfiles();
  if (!profiles.length) throw new Error('没有找到 Edge 的登录数据（未安装 Edge，或不是当前用户）');
  const key = await edgeAesKey();

  const initSqlJs = require('sql.js');
  const wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });

  const items = [];
  let skipped = 0;
  for (const prof of profiles) {
    // Edge 运行时 Login Data 被 SQLite 锁住，复制一份再读（只读，不碰原文件）
    const tmp = path.join(os.tmpdir(), 'nova-login-' + process.pid + '-' + Date.now() + '.db');
    try {
      fs.copyFileSync(prof.loginData, tmp);
      const db = new SQL.Database(fs.readFileSync(tmp));
      const res = db.exec('SELECT origin_url, username_value, password_value FROM logins');
      const rows = res[0] ? res[0].values : [];
      for (const r of rows) {
        const origin = (r[0] || '').trim();
        const username = (r[1] || '').trim();
        const pw = r[2];
        if (!origin || !pw || !pw.length) continue;
        try {
          const out = decryptPassword(pw, key);
          if (out.unsupported) { skipped++; continue; }
          items.push({ origin, username, password: out.plain || '' });
        } catch { skipped++; }
      }
      db.close();
    } catch (e) {
      // 单个配置档读失败不影响其它档；最后如实回报
      skipped++;
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* 删不掉就算了 */ }
    }
  }
  return { items, skipped };
}

module.exports = { readEdgeLogins, edgeProfiles, edgeUserDataDir };
