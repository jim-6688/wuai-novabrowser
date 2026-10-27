#!/usr/bin/env node
/* ==========================================================================
   多吉云（DogeCloud）云存储上传工具
   --------------------------------------------------------------------------
   用法（凭据走环境变量，不写进文件）：
     DOGE_AK=xxx DOGE_SK=yyy node tools/doji.js probe
     DOGE_AK=xxx DOGE_SK=yyy node tools/doji.js upload <本地文件> [key]

   签名规则（见 docs.dogecloud.com）：
     signStr = apiPath + "\n" + body
     sign    = HMAC-SHA1(secretKey, signStr) 的 hex
     Authorization: TOKEN <accessKey>:<sign>

   上传走 S3 兼容接口：先 /auth/tmp_token.json 取 OSS_FULL 临时密钥，
   再用 AWS S3 协议 PUT 到 s3Bucket / s3Endpoint。纯 Node 实现，无需装 SDK。
   ========================================================================== */
'use strict';

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

const AK = process.env.DOGE_AK;
const SK = process.env.DOGE_SK;
if (!AK || !SK) {
  console.error('缺少 DOGE_AK / DOGE_SK 环境变量');
  process.exit(2);
}

const HOST = 'api.dogecloud.com';

/** 调多吉云 Web API（POST，JSON）。返回解析后的对象（含 code/msg/data）。 */
function api(apiPath, data) {
  const body = JSON.stringify(data);
  const sign = crypto.createHmac('sha1', SK)
    .update(Buffer.from(apiPath + '\n' + body, 'utf8')).digest('hex');
  const authorization = 'TOKEN ' + AK + ':' + sign;
  const buf = Buffer.from(body, 'utf8');

  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST,
      path: apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        'Authorization': authorization
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error('API 返回非 JSON：' + text.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

/** 取 OSS_FULL 临时密钥 + 桶信息 */
async function getToken() {
  const r = await api('/auth/tmp_token.json', { channel: 'OSS_FULL', scopes: ['*'] });
  if (r.code !== 200) throw new Error('取临时密钥失败：' + r.code + ' ' + (r.msg || r.err_code));
  return r.data;
}

/* ---------------- S3 SigV4（纯 Node 实现，够 PutObject 用） ---------------- */

function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function hmac(key, str) { return crypto.createHmac('sha256', key).update(str, 'utf8').digest(); }
function hmacHex(key, str) { return crypto.createHmac('sha256', key).update(str, 'utf8').digest('hex'); }

/**
 * 用 S3 临时密钥把一个文件 PUT 到 endpoint/bucket/key（path-style）。
 * @param {object} cred { accessKeyId, secretAccessKey, sessionToken }
 * @param {string} endpoint 例如 https://cos.ap-chengdu.myqcloud.com
 * @param {string} bucket   s3Bucket
 * @param {string} key      对象键
 * @param {string} file     本地文件路径
 * @param {string} region   例如 ap-chengdu（从 endpoint 里取）
 */
function s3Put(cred, endpoint, bucket, key, file, region) {
  const u = new URL(endpoint);
  const host = u.host;
  const fileSize = fs.statSync(file).size;
  const ct = 'application/octet-stream';
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = 'UNSIGNED-PAYLOAD';

  // path-style：/<bucket>/<key>
  const canonicalUri = '/' + bucket + '/' + key.split('/').map(encodeURIComponent).join('/');
  const canonicalQuerystring = '';
  const canonicalHeaders =
    'content-type:' + ct + '\n' +
    'host:' + host + '\n' +
    'x-amz-content-sha256:' + payloadHash + '\n' +
    'x-amz-date:' + amzDate + '\n' +
    (cred.sessionToken ? 'x-amz-security-token:' + cred.sessionToken + '\n' : '');
  const signedHeaders =
    'content-type;host;x-amz-content-sha256;x-amz-date' +
    (cred.sessionToken ? ';x-amz-security-token' : '');

  const canonicalRequest = [
    'PUT', canonicalUri, canonicalQuerystring, canonicalHeaders, signedHeaders, payloadHash
  ].join('\n');

  const credentialScope = dateStamp + '/' + region + '/s3/aws4_request';
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(Buffer.from(canonicalRequest, 'utf8'))
  ].join('\n');

  const kDate = hmac('AWS4' + cred.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmacHex(kSigning, stringToSign);

  const authorization = 'AWS4-HMAC-SHA256 Credential=' + cred.accessKeyId + '/' + credentialScope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

  const headers = {
    'Content-Type': ct,
    'Content-Length': fileSize,
    'Host': host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'Authorization': authorization
  };
  if (cred.sessionToken) headers['x-amz-security-token'] = cred.sessionToken;

  return new Promise((resolve, reject) => {
    const req = https.request({
      host, path: canonicalUri, method: 'PUT', headers
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, status: res.statusCode });
        else reject(new Error('S3 PUT 失败 HTTP ' + res.statusCode + '：' + text.slice(0, 300)));
      });
    });
    req.on('error', reject);
    const rs = fs.createReadStream(file);
    rs.on('error', reject);
    rs.pipe(req);
  });
}

/* ---------------- 命令 ---------------- */

async function main() {
  const mode = process.argv[2] || 'probe';
  const data = await getToken();
  const buckets = (data.Buckets || []).map((b) => ({ name: b.name, s3Bucket: b.s3Bucket, s3Endpoint: b.s3Endpoint }));

  if (mode === 'probe') {
    console.log('code=200，临时密钥获取成功');
    console.log('桶数量：' + buckets.length);
    for (const b of buckets) console.log(`  - name=${b.name}  s3Bucket=${b.s3Bucket}  endpoint=${b.s3Endpoint}`);
    return;
  }

  if (mode === 'upload') {
    const file = process.argv[3];
    if (!file || !fs.existsSync(file)) { console.error('找不到文件：' + file); process.exit(2); }
    const key = process.argv[4] || ('download/' + path.basename(file));
    // 选桶：显式 DOGE_BUCKET，否则取第一个
    const want = process.env.DOGE_BUCKET;
    const b = want ? buckets.find((x) => x.name === want) : buckets[0];
    if (!b) { console.error('没有可用存储桶' + (want ? '（' + want + '）' : '')); process.exit(2); }

    const region = (b.s3Endpoint.match(/cos\.([a-z0-9-]+)\.myqcloud\.com/) || [])[1] || 'ap-chengdu';
    const cred = {
      accessKeyId: data.Credentials.accessKeyId,
      secretAccessKey: data.Credentials.secretAccessKey,
      sessionToken: data.Credentials.sessionToken
    };
    console.log(`上传 ${file}（${fs.statSync(file).size} 字节）→ 桶 ${b.name} / key ${key}`);
    await s3Put(cred, b.s3Endpoint, b.s3Bucket, key, file, region);
    console.log('上传成功。对象 key = ' + key);
  }
}

main().catch((e) => { console.error('出错：' + e.message); process.exit(1); });
