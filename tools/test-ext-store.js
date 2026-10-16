'use strict';
/**
 * Edge 加载项商店取包 测试
 * 用法：node tools/test-ext-store.js
 *
 * 这个模块里出错代价最大的一步是「认 ID」：认错会把一个完全无关的扩展装进
 * 用户浏览器，而界面上一路都是绿的 —— 装上了、名字也有、卡片也画出来了。
 * 所以这里大半篇幅在钉解析，而且两个方向都钉：该认出来的要认出来，
 * 认不出来的必须返回 null **而不是猜一个**。
 *
 * 各段在测什么：
 *   [A] 用户手上真拿得到的那几种字符串，都要认出来
 *   [B] 认不出的不许猜（商店首页地址、31 位、含 q–z 的伪 ID、非 http 协议…）
 *   [C] 两个接口地址的构造，尤其是取包接口那几个必填项
 *   [D] 详情归一化（协议相对图标、安装量文案、MV2/MV3）
 *   [E] 查详情的各条岔路 —— 两种「404」要给不同的话，不能混成一句
 *   [F] 取包：落盘、认魔数、命中缓存、以及各种失败都不留半个坏文件
 *   [G] 拿真包跑一遍装载流水线：证明取回来的东西 extensions.js 真的吃得下
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const P = (rel) => path.join(root, rel);

const {
  parseStoreInput, detailApi, crxApi, formatInstalls, summarizeDetail,
  fetchDetail, downloadCrx,
  CHROME_MIRROR, CHROME_MIRROR_INFO, summarizeMirror, parseMirrorDownloadUrl,
  fetchChromeDetail,
  extractCrxFromMirrorZip
} = require(P('src/main/ext-store.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

/** 造一条假的 fetch 响应。arrayBuffer 吃 Buffer，json 吃对象，text 吃字符串。 */
const res = (status, body, opts = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => (opts.rawJson ? JSON.parse(body) : body),
  text: async () => (Buffer.isBuffer(body) ? body.toString('utf8') : String(body)),
  arrayBuffer: async () => body
});

/** 记下被调用过的地址，便于断言「有没有真的去请求」。 */
function recorder(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  fn.calls = calls;
  return fn;
}

/** 造一个合法的 CRX3 头 + 一段占位 zip 内容。 */
function fakeCrx(zipBody = Buffer.from('PK\x03\x04rest')) {
  const header = Buffer.alloc(12);
  header.write('Cr24', 0, 'latin1');
  header.writeUInt32LE(3, 4);
  header.writeUInt32LE(0, 8); // 头长度为 0，紧随其后就是 zip
  return Buffer.concat([header, zipBody]);
}

/** 造一个合法的 CRX3：Cr24 + 版本 3 + 头长度 + 头 + zip。 */
function crx3(zipBuf, headerLen = 0) {
  const head = Buffer.alloc(12);
  head.write('Cr24', 0, 'latin1');
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(headerLen, 8);
  return Buffer.concat([head, Buffer.alloc(headerLen), zipBuf]);
}

/** 造一个合法的 CRX2：Cr24 + 版本 2 + 公钥长 + 签名长 + 公钥 + 签名 + zip。 */
function crx2(zipBuf, pubLen = 0, sigLen = 0) {
  const head = Buffer.alloc(16);
  head.write('Cr24', 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(pubLen, 8);
  head.writeUInt32LE(sigLen, 12);
  return Buffer.concat([head, Buffer.alloc(pubLen + sigLen), zipBuf]);
}

/**
 * 造一个最小合法 ZIP（单文件、deflate）。
 *
 * 自己拼而不是引一个 zip 库：这里要验的是「解包这条链路通不通」，
 * 用一个第三方写入器去配自家读取器，验的会变成「两家实现是否恰好对得上」。
 * CRC 字段留 0 —— 本项目的读取器不校验它（见 extensions.js 的 readZipEntry），
 * 这一点在这里也顺带钉住了：哪天真加了校验，这段会红。
 */
function miniZip(name, content) {
  const data = Buffer.from(content, 'utf8');
  const nameBuf = Buffer.from(name, 'utf8');
  const comp = zlib.deflateRawSync(data);

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(8, 8);          // method = deflate
  lfh.writeUInt32LE(comp.length, 18);
  lfh.writeUInt32LE(data.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(8, 10);          // method
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42);          // local offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + nameBuf.length, 12);
  eocd.writeUInt32LE(lfh.length + nameBuf.length + comp.length, 16);

  return Buffer.concat([lfh, nameBuf, comp, cd, nameBuf, eocd]);
}

/**
 * 造一个多文件的最小合法 ZIP。
 *
 * miniZip 只写单文件，而镜像站那个套娃包里除了 .crx 还塞了一份说明 txt ——
 * 「有没有挑对条目」正是要验的东西，单文件测不出来。
 */
function multiZip(files) {
  const parts = [];
  const cds = [];
  let offset = 0;

  for (const [name, content] of files) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    parts.push(lfh, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    cds.push(cd, nameBuf);

    offset += lfh.length + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, cdBuf, eocd]);
}

const tmpDirs = [];
const mkTmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-extstore-'));
  tmpDirs.push(d);
  return d;
};

const EDGE_URL = 'https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd';
const TM_ID = 'iikmkjmpaadaobahmlepeloendndfphd';

(async () => {

  /* ---------------------------------------------------------------- */

  console.log('\n[A] 认 ID：用户手上真拿得到的那几种字符串');

  check('完整商店详情页地址',
    (parseStoreInput(EDGE_URL) || {}).crxId === TM_ID, JSON.stringify(parseStoreInput(EDGE_URL)));

  check('地址尾巴带了 ?hl=zh-CN',
    (parseStoreInput(EDGE_URL + '?hl=zh-CN') || {}).crxId === TM_ID);

  check('地址带 #hash',
    (parseStoreInput(EDGE_URL + '#x') || {}).crxId === TM_ID);

  check('被聊天软件裹了尖括号',
    (parseStoreInput('<' + EDGE_URL + '>') || {}).crxId === TM_ID);

  check('前后带空格与换行',
    (parseStoreInput('  \n' + EDGE_URL + ' \n ') || {}).crxId === TM_ID);

  check('裸 ID（32 位）',
    (parseStoreInput(TM_ID) || {}).crxId === TM_ID,
    JSON.stringify(parseStoreInput(TM_ID)));

  check('裸 ID 标 source=bare',
    (parseStoreInput(TM_ID) || {}).source === 'bare');

  check('Edge 地址标 source=edge',
    (parseStoreInput(EDGE_URL) || {}).source === 'edge');

  const CHROME_URL = 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo';
  check('Chrome 应用店地址也认，且标 source=chrome',
    (parseStoreInput(CHROME_URL) || {}).source === 'chrome'
    && (parseStoreInput(CHROME_URL) || {}).crxId === 'dhdgffkkebhmkfjojejmpbldmpobfkfo',
    JSON.stringify(parseStoreInput(CHROME_URL)));

  const oldChrome = 'https://chrome.google.com/webstore/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm';
  check('旧版 chrome.google.com 地址同样认',
    (parseStoreInput(oldChrome) || {}).crxId === 'cjpalhdlnbpafiamejdnhcphjbkeiagm');

  check('末段就是 ID 的短地址',
    (parseStoreInput('https://microsoftedge.microsoft.com/addons/detail/' + TM_ID) || {}).crxId === TM_ID);

  /* ---------------------------------------------------------------- */

  console.log('\n[B] 认不出的不许猜');

  const mustBeNull = [
    ['空串', ''],
    ['纯空格', '   '],
    ['null', null],
    ['undefined', undefined],
    ['一句中文', '帮我装一个广告拦截'],
    ['31 位 ID', TM_ID.slice(0, 31)],
    ['33 位 ID', TM_ID + 'a'],
    ['含 q–z 的 32 位串（不是合法 ID 字符集）', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['含数字的 32 位串', '12345678901234567890123456789012'],
    ['商店首页（没有 ID）', 'https://microsoftedge.microsoft.com/addons/Microsoft-Edge-Extensions-Home'],
    ['商店搜索页', 'https://microsoftedge.microsoft.com/addons/search?hl=zh-CN&q=adblock'],
    ['非 http 协议', 'file:///C:/Users/jim/tm.crx'],
    ['javascript 伪协议', 'javascript:alert(1)'],
    ['一段 HTML', '<div class="x">hello</div>'],
    ['纯路径', 'C:\\Users\\jim\\Downloads\\tm.crx']
  ];
  for (const [label, input] of mustBeNull) {
    check(label + ' → null', parseStoreInput(input) === null, JSON.stringify(parseStoreInput(input)));
  }

  /* ---------------------------------------------------------------- */

  console.log('\n[C] 接口地址构造');

  check('详情接口带上 ID',
    detailApi(TM_ID) === 'https://microsoftedge.microsoft.com/addons/getproductdetailsbycrxid/' + TM_ID,
    detailApi(TM_ID));

  const cu = crxApi(TM_ID, '131.0.6778.86');
  check('取包接口域名正确', cu.startsWith('https://edge.microsoft.com/extensionwebstorebase/v1/crx?'), cu);
  check('取包接口 prodversion 取主版本 + .0.0.0', /prodversion=131\.0\.0\.0/.test(cu), cu);
  check('取包接口 acceptformat 带 crx3', /acceptformat=crx3%2Ccrx2/.test(cu), cu);
  check('取包接口带 response=redirect', /response=redirect/.test(cu));
  check('取包接口的 x 参数逐字对上（少了 installsource 会直接 500）',
    /x=id%3D/.test(cu) && /%26uc%26installsource%3Dondemand/.test(cu), cu);

  check('没给版本号时回落一个能用的默认值',
    /prodversion=120\.0\.0\.0/.test(crxApi(TM_ID, '')));
  check('版本号被写坏时也回落，而不是拼出一个坏地址',
    /prodversion=120\.0\.0\.0/.test(crxApi(TM_ID, 'abc')));

  /* ---------------------------------------------------------------- */

  console.log('\n[D] 详情归一化');

  const d1 = summarizeDetail({
    name: 'Tampermonkey', version: '5.5.1', developer: 'Jan Biniok',
    activeInstallCount: 13321147, logoUrl: '//store-images.s-microsoft.com/image/apps.1',
    shortDescription: 'Change the web at will with userscripts', isManifestV2: false
  }, TM_ID);
  check('名字 / 版本 / 开发者都取到', d1.name === 'Tampermonkey' && d1.version === '5.5.1' && d1.developer === 'Jan Biniok');
  check('协议相对的图标地址补上 https', d1.icon === 'https://store-images.s-microsoft.com/image/apps.1', d1.icon);
  check('已经是 https 的图标地址不动',
    summarizeDetail({ name: 'x', logoUrl: 'https://a.com/i.png' }, TM_ID).icon === 'https://a.com/i.png');
  check('没有图标时留空串，不编一个',
    summarizeDetail({ name: 'x' }, TM_ID).icon === '');
  check('安装量 13321147 → 1332 万', d1.installsText === '1332 万', d1.installsText);
  check('非 MV2 判为 MV3', d1.manifestVersion === 3);
  check('isManifestV2 判为 2',
    summarizeDetail({ name: 'x', isManifestV2: true }, TM_ID).manifestVersion === 2);
  check('短描述优先于长描述',
    summarizeDetail({ name: 'x', shortDescription: '短', description: '长' }, TM_ID).description === '短');
  check('没有短描述时退回长描述',
    summarizeDetail({ name: 'x', description: '长' }, TM_ID).description === '长');
  check('crxId 原样带上', d1.crxId === TM_ID);
  check('null 输入 → null', summarizeDetail(null, TM_ID) === null);
  check('非对象输入 → null', summarizeDetail('abc', TM_ID) === null);

  check('安装量 9999 → 原数字', formatInstalls(9999) === '9999', formatInstalls(9999));
  check('安装量 12345 → 1.2 万', formatInstalls(12345) === '1.2 万', formatInstalls(12345));
  check('安装量 0 → 0', formatInstalls(0) === '0');
  check('安装量缺失 → 0', formatInstalls(undefined) === '0');

  /* ---------------------------------------------------------------- */

  console.log('\n[E] 查详情');

  const okDetail = { name: 'Tampermonkey', version: '5.5.1', activeInstallCount: 10 };
  const r1 = await fetchDetail(EDGE_URL, {
    fetchImpl: recorder(async () => res(200, okDetail))
  });
  check('成功路径拿到 detail', r1.detail && r1.detail.name === 'Tampermonkey', JSON.stringify(r1.error || ''));
  check('成功路径带回 crxId 与 source', r1.crxId === TM_ID && r1.source === 'edge');

  const r2 = await fetchDetail(CHROME_URL, { fetchImpl: async () => res(404, {}) });
  check('Chrome 应用店的 404 提示里点明「Chrome 应用店」',
    r2.error && r2.error.includes('Chrome 应用店'), r2.error);

  const r3 = await fetchDetail(EDGE_URL, { fetchImpl: async () => res(404, {}) });
  check('Edge 商店自己的 404 不提 Chrome，只说没收录',
    r3.error && !r3.error.includes('Chrome 应用店'), r3.error);

  const r4 = await fetchDetail(EDGE_URL, { fetchImpl: async () => res(500, {}) });
  check('HTTP 500 如实报出来', /HTTP 500/.test(r4.error || ''), r4.error);

  const r5 = await fetchDetail(EDGE_URL, {
    fetchImpl: async () => { throw new Error('fetch failed'); }
  });
  check('连不上时给一句人话（不是裸的 fetch failed）',
    /连不上/.test(r5.error || '') && !/^fetch failed$/.test(r5.error || ''), r5.error);

  const r6 = await fetchDetail('帮我装个插件', { fetchImpl: async () => res(200, okDetail) });
  check('认不出时不去请求，直接要求重新粘贴',
    !!r6.error && !r6.detail, r6.error);

  const r7 = await fetchDetail(EDGE_URL, { fetchImpl: async () => res(200, { name: '' }) });
  check('返回里没有名字视为读不懂', !!r7.error, r7.error);

  const badJson = await fetchDetail(EDGE_URL, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })
  });
  check('JSON 坏掉时给一句人话', !!badJson.error, badJson.error);

  // 请求真的打到了详情接口
  const rec = recorder(async () => res(200, okDetail));
  await fetchDetail(EDGE_URL, { fetchImpl: rec });
  check('请求打的是详情接口', rec.calls.length === 1 && rec.calls[0].url.includes('getproductdetailsbycrxid'), rec.calls[0] && rec.calls[0].url);
  check('请求带了 UA 与 Accept',
    !!(rec.calls[0].init.headers['User-Agent'] && rec.calls[0].init.headers.Accept));

  /* ---------------------------------------------------------------- */

  console.log('\n[F] 取包');

  const dir = mkTmp();
  const dest = path.join(dir, 'store', TM_ID + '.crx');
  const crxBytes = fakeCrx();

  const w1 = await downloadCrx(EDGE_URL, dest, {
    chromeVersion: '131.0.0.0',
    fetchImpl: recorder(async (u) => res(200, crxBytes))
  });
  check('成功返回 ok 与字节数', w1.ok === true && w1.bytes === crxBytes.length, JSON.stringify(w1));
  check('文件真的落盘了', fs.existsSync(dest) && fs.readFileSync(dest).length === crxBytes.length);
  check('自动建了不存在的父目录', fs.existsSync(path.dirname(dest)));
  check('带回 crxId', w1.crxId === TM_ID);

  // 第二次：不该再发请求
  const rec2 = recorder(async () => { throw new Error('不该再请求'); });
  const w2 = await downloadCrx(EDGE_URL, dest, { fetchImpl: rec2 });
  check('同一个 ID 第二次命中缓存，不再下载',
    w2.ok === true && w2.cached === true, JSON.stringify(w2));
  check('缓存命中时一次网络请求都没发', rec2.calls.length === 0);

  // force 时仍然重新下载
  const rec3 = recorder(async () => res(200, crxBytes));
  await downloadCrx(EDGE_URL, dest, { fetchImpl: rec3, force: true });
  check('force 时忽略缓存重新下载', rec3.calls.length === 1);

  const destEmpty = path.join(mkTmp(), 'empty.crx');
  const w3 = await downloadCrx(EDGE_URL, destEmpty, { fetchImpl: async () => res(200, Buffer.alloc(0)) });
  check('空文件被拒', !!w3.error, w3.error);
  check('空文件没有被写下来', !fs.existsSync(destEmpty));

  const htmlErr = Buffer.from('<!DOCTYPE html><html>403 Forbidden</html>');
  const destHtml = path.join(mkTmp(), 'html.crx');
  const w4 = await downloadCrx(EDGE_URL, destHtml, { fetchImpl: async () => res(200, htmlErr) });
  check('内容不是 CRX（魔数不对）时被拒', !!w4.error, w4.error);
  check('被换成 HTML 时不留半个坏文件', !fs.existsSync(destHtml));

  const dest403 = path.join(mkTmp(), 'denied.crx');
  const w5 = await downloadCrx(EDGE_URL, dest403, { fetchImpl: async () => res(403, Buffer.alloc(0)) });
  check('非 2xx 被拒', /403/.test(w5.error || ''), w5.error);

  const w6 = await downloadCrx(EDGE_URL, path.join(mkTmp(), 'x.crx'), {
    fetchImpl: async () => { throw new Error('fetch failed'); }
  });
  check('网络异常时给一句人话', /下载扩展包失败/.test(w6.error || ''), w6.error);

  const destBad = path.join(mkTmp(), 'bad.crx');
  const w7 = await downloadCrx('随便一段话', destBad, { fetchImpl: async () => res(200, crxBytes) });
  check('输入认不出时直接拒，不发请求', !!w7.error, w7.error);

  const recVer = recorder(async () => res(200, crxBytes));
  await downloadCrx(EDGE_URL, path.join(mkTmp(), 'v.crx'), { fetchImpl: recVer, chromeVersion: '140.1.2.3' });
  check('取包地址用的是调用方给的内核版本',
    /prodversion=140\.0\.0\.0/.test(recVer.calls[0].url), recVer.calls[0].url);

  /* ---------------------------------------------------------------- */

  console.log('\n[G] 取回来的包，装载流水线吃得下吗');

  // 这一段钉的是一个已经踩过的坑：stripCrxHeader 里的魔数校验原先写成
  // `readUInt32LE(0) !== 0x43723234` —— 常量按书写顺序拼，读取却是小端，
  // 两边永远不等，于是**任何 .crx 都会被判成「不是 CRX 文件」**，
  // 整个扩展安装路径是死的，而且失败得很安静（用户只会以为这个文件坏了）。
  const { stripCrxHeader, listZipEntries, extractZip } = require(P('src/main/extensions.js'));

  const manifest = JSON.stringify({ manifest_version: 3, name: 'Test Ext', version: '1.0.0' });
  const zip = miniZip('manifest.json', manifest);

  const s3 = stripCrxHeader(crx3(zip, 0));
  check('CRX3（无头内容）能剥出来', !!s3.zip && s3.version === 3, JSON.stringify({ v: s3 && s3.version }));
  check('剥掉头之后正好是原 ZIP', Buffer.compare(Buffer.from(s3.zip), zip) === 0);
  check('开头是 PK 魔数', Buffer.from(s3.zip).subarray(0, 4).toString('hex') === '504b0304');

  const s3h = stripCrxHeader(crx3(zip, 128));
  check('CRX3 带头部内容时按 headerLen 跳过', Buffer.compare(Buffer.from(s3h.zip), zip) === 0);

  const s2 = stripCrxHeader(crx2(zip, 300, 256));
  check('CRX2 按公钥长 + 签名长跳过', s2.version === 2 && Buffer.compare(Buffer.from(s2.zip), zip) === 0);

  const entries = listZipEntries(zip);
  check('ZIP 里能列出 manifest.json',
    entries.length === 1 && entries[0].name === 'manifest.json',
    JSON.stringify(entries.map((e) => e.name)));

  const exDir = mkTmp();
  extractZip(zip, exDir);
  check('extractZip 真把文件解出来了', fs.existsSync(path.join(exDir, 'manifest.json')));
  check('解出来的内容逐字对得上',
    fs.readFileSync(path.join(exDir, 'manifest.json'), 'utf8') === manifest);

  let magicErr = null;
  try { stripCrxHeader(Buffer.from('not a crx at all')); } catch (e) { magicErr = e.message; }
  check('非 CRX 内容仍然被拒', !!magicErr, magicErr);

  let verErr = null;
  try {
    const bad = Buffer.from(crx3(zip)); bad.writeUInt32LE(9, 4);
    stripCrxHeader(bad);
  } catch (e) { verErr = e.message; }
  check('不支持的 CRX 版本被拒', /不支持的 CRX 版本/.test(verErr || ''), verErr);

  // 真包不随仓库走（1.7 MB 二进制，也不该进 git），有就顺带跑一遍：
  //   curl -sL -o /tmp/real.crx "https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&prodversion=120.0.0.0&acceptformat=crx3,crx2&x=id%3Diikmkjmpaadaobahmlepeloendndfphd%26uc%26installsource%3Dondemand"
  //   NOVA_REAL_CRX=/tmp/real.crx node tools/test-ext-store.js
  const realPath = process.env.NOVA_REAL_CRX;
  let realOk = false;
  try { realOk = !!realPath && fs.statSync(realPath).size > 0; } catch { realOk = false; }
  if (!realOk) {
    console.log('  SKIP  没给真 CRX 样本（NOVA_REAL_CRX），跳过真实包验证');
  } else {
    const buf = fs.readFileSync(realPath);
    const sReal = stripCrxHeader(buf);
    check('真实商店包能剥出 ZIP（' + buf.length + ' 字节）',
      Buffer.from(sReal.zip).subarray(0, 4).toString('hex') === '504b0304');
    const realEntries = listZipEntries(Buffer.from(sReal.zip));
    check('真实包里能找到 manifest.json',
      realEntries.some((e) => e.name === 'manifest.json'),
      realEntries.slice(0, 3).map((e) => e.name).join(', '));
  }

  console.log('\n[H] manifest 本地化占位符');

  // 真环境实测：Tampermonkey 装出来名字是 __MSG_extName__ —— 商店里的扩展
  // 普遍把真名字放在 _locales 里，不解的话卡片上就是一串占位符。
  const { resolveMessage } = require(P('src/main/extensions.js'));

  const mkExt = (locales) => {
    const d = mkTmp();
    for (const [loc, msgs] of Object.entries(locales)) {
      const p = path.join(d, '_locales', loc);
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'messages.json'), JSON.stringify(msgs));
    }
    return d;
  };

  check('不是占位符时原样返回，不碰盘',
    resolveMessage(mkTmp(), {}, '普通名字') === '普通名字');

  const dZhEn = mkExt({
    en: { extName: { message: 'Tampermonkey' } },
    zh_CN: { extName: { message: '篡改猴' } }
  });
  check('中文环境优先拿中文，而不是扩展声明的默认语言',
    resolveMessage(dZhEn, { default_locale: 'en' }, '__MSG_extName__') === '篡改猴');
  check('声明 default_locale 的扩展，中英都缺时回落到 default_locale',
    resolveMessage(mkExt({ ja: { extName: { message: '日本語' } } }),
      { default_locale: 'ja' }, '__MSG_extName__') === '日本語');

  const dEnOnly = mkExt({ en: { extName: { message: 'Tampermonkey' } } });
  check('没有中文时拿英文',
    resolveMessage(dEnOnly, { default_locale: 'en' }, '__MSG_extName__') === 'Tampermonkey');
  check('key 大小写对不上也能命中（有些扩展头字母大写）',
    resolveMessage(dEnOnly, { default_locale: 'en' }, '__MSG_ExtName__') === 'Tampermonkey');

  check('哪里都没有时退回 key 本身（比留一串 __MSG_ 像个决定）',
    resolveMessage(mkTmp(), { default_locale: 'en' }, '__MSG_nothing__') === 'nothing');

  check('描述也走同一个解析',
    resolveMessage(mkExt({ zh_CN: { extDesc: { message: '脚本管理器' } } }),
      {}, '__MSG_extDesc__') === '脚本管理器');

  check('default_locale 没写、也没命中的 key，扫描目录兜底后仍落回 key',
    resolveMessage(mkExt({ fr: { other: { message: 'x' } } }), {}, '__MSG_extName__') === 'extName');

  console.log('\n[I] Chrome 应用店：走国内镜像');

  // 结构照抄真实页面（实测 2026-10 的 chrome.zzzmh.cn 详情页）。
  // 名字只在 <h1> 里、三个数字只在 .chrome-subtitle 里 —— 页面上别处
  // 也挂着「相关推荐」的卡片，解析规则一放宽就会把别人的名字安在这个 ID 上。
  const TM_CHROME_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
  const MIRROR_HTML = [
    '<!DOCTYPE html><html><head>',
    '<title>Tampermonkey 篡改猴(油猴脚本)_5.5.1_Chrome插件下载_极简插件</title>',
    '<meta property="og:image" content="/v3/crx/bb90e83d26b3439aa362788efd0da6a9/logo/thumb.jpeg">',
    '<meta property="og:description" content="自由地改变网络 &amp; 提升浏览体验。">',
    '</head><body>',
    '<h1 class="chrome-title">Tampermonkey 篡改猴(油猴脚本)</h1>',
    '<div class="chrome-subtitle">',
    '  <span><i class="iconfont icon-ic_app"></i>5.5.1</span>',
    '  <span><i\n class="iconfont icon-time"></i>2026-10-04</span>',
    '  <span><i\n class="iconfont icon-download"></i>246万+</span>',
    '</div>',
    '<div class="chrome-download-btns">',
    '  <a href="https://cdn3.zzzmh.cn/v3/crx/bb90e83d26b3439aa362788efd0da6a9/' + TM_CHROME_ID + '.zip?auth_key=1793-abc">推荐下载</a>',
    '  <a href="/v3/crx/bb90e83d26b3439aa362788efd0da6a9/' + TM_CHROME_ID + '.zip">备用下载</a>',
    '</div>',
    '</body></html>'
  ].join('\n');

  const md = summarizeMirror(MIRROR_HTML, TM_CHROME_ID);
  check('名字从 <h1> 拿，不是从整页里捞',
    md && md.name === 'Tampermonkey 篡改猴(油猴脚本)', md && md.name);
  check('版本从 .chrome-subtitle 的 ic_app 项拿', md && md.version === '5.5.1', md && md.version);
  check('更新时间从 icon-time 项拿（跨行的标签也认）',
    md && md.updated === '2026-10-04', md && md.updated);
  check('安装量原样保留「246万+」，不换算成一个假精确的数字',
    md && md.installsText === '246万+' && md.installs === 0, md && md.installsText);
  check('图标相对路径补成绝对地址',
    md && md.icon === CHROME_MIRROR + '/v3/crx/bb90e83d26b3439aa362788efd0da6a9/logo/thumb.jpeg',
    md && md.icon);
  check('描述里的 HTML 实体被解码',
    md && md.description === '自由地改变网络 & 提升浏览体验。', md && md.description);
  check('标了 mirror，界面据此提示来源',
    md && md.mirror === true);
  check('页面上找不到 <h1> 时返回 null，不猜',
    summarizeMirror('<html><body>空空如也</body></html>', TM_CHROME_ID) === null);
  check('传进来不是字符串也返回 null', summarizeMirror(null, TM_CHROME_ID) === null);

  const dlUrl = parseMirrorDownloadUrl(MIRROR_HTML, TM_CHROME_ID);
  check('下载直链优先取不带签名的备用地址',
    dlUrl === CHROME_MIRROR + '/v3/crx/bb90e83d26b3439aa362788efd0da6a9/' + TM_CHROME_ID + '.zip', dlUrl);
  check('拿到的直链里没有 auth_key（不会过期）', dlUrl && !/auth_key/.test(dlUrl));

  const signedOnly = '<a href="https://cdn3.zzzmh.cn/v3/crx/bb90e83d26b3439aa362788efd0da6a9/' +
    TM_CHROME_ID + '.zip?auth_key=99-x">推荐下载</a>';
  check('只有带签名的地址时退回它（总比取不到强）',
    /auth_key=99-x$/.test(parseMirrorDownloadUrl(signedOnly, TM_CHROME_ID)));
  check('页面上一条下载地址都没有时返回空串',
    parseMirrorDownloadUrl('<html></html>', TM_CHROME_ID) === '');
  check('别人的 ID 不会误命中（页面里挂着相关推荐）',
    parseMirrorDownloadUrl(MIRROR_HTML, 'cfhdojbkjhnklbpkdaibdccddilifddb') === '');

  // 套娃：镜像站发的是普通 zip，里面装着 .crx 加一份说明 txt
  const innerCrx = crx3(Buffer.from('PK\x03\x04payload'));
  const nest = multiZip([
    [TM_CHROME_ID + '_5.5.1_chrome.zzzmh.cn.crx', innerCrx],
    ['安装说明.txt', '解压后把 crx 拖进扩展页']
  ]);
  const dug = extractCrxFromMirrorZip(nest);
  check('从套娃 zip 里掏出 .crx（挑对条目，不是那份 txt）',
    dug && Buffer.compare(dug, innerCrx) === 0, dug ? dug.length + ' 字节' : 'null');
  check('zip 里没有 .crx 时返回 null，不硬凑',
    extractCrxFromMirrorZip(multiZip([['readme.txt', 'x']])) === null);
  check('镜像站哪天直接给 crx 也认（原样返回）',
    Buffer.compare(extractCrxFromMirrorZip(innerCrx), innerCrx) === 0);
  check('空 buffer 返回 null', extractCrxFromMirrorZip(Buffer.alloc(0)) === null);
  check('不是 zip 也不是 crx 的垃圾数据返回 null',
    extractCrxFromMirrorZip(Buffer.from('<!DOCTYPE html><html>404</html>')) === null);

  // CHROME_URL 在 [A] 段就定义过了，这里直接用同一个地址（同一个 ID）

  {
    // Chrome 来源直接走镜像，不去 Edge 商店空跑 ——
    // 两个商店的 ID 不是同一套编号，拿 Chrome 的 ID 问 Edge 是问不到的。
    const f = recorder((url) => (url.includes('/info/') ? res(200, MIRROR_HTML) : res(404, '')));
    const out = await fetchDetail(CHROME_URL, { fetchImpl: f });
    check('Chrome 地址查详情时，请求打的是镜像站',
      f.calls.length === 1 && f.calls[0].url.startsWith(CHROME_MIRROR_INFO), f.calls.map((c) => c.url).join(' | '));
    check('一次都没碰 Edge 商店', !f.calls.some((c) => /microsoftedge/.test(c.url)));
    check('查回来带着 mirror 标记', out.detail && out.detail.mirror === true);
    check('查回来带着可以下载的直链', !!out.downloadUrl);
  }

  {
    const f = recorder(() => res(404, ''));
    const out = await fetchDetail(CHROME_URL, { fetchImpl: f });
    check('镜像站没有收录时给出 notFound（区别于网络不通）',
      out.notFound === true && out.error, out.error);
  }

  {
    // 裸 ID 问不出出处：Edge 那边没有，就再问问镜像
    const f = recorder((url) => (url.includes('/info/') ? res(200, MIRROR_HTML) : res(404, '')));
    const out = await fetchDetail(TM_CHROME_ID, { fetchImpl: f });
    check('裸 ID 在 Edge 查不到时，自动回落问镜像',
      out.detail && out.detail.mirror === true && f.calls.some((c) => c.url.includes('/info/')),
      f.calls.map((c) => (c.url.includes('/info/') ? 'mirror' : 'edge')).join(' → '));
  }

  {
    // 用户明明是从 Edge 商店复制的地址，就别再拿它去镜像站碰运气
    const f = recorder(() => res(404, ''));
    const out = await fetchDetail(EDGE_URL, { fetchImpl: f });
    check('Edge 地址查不到时不回落镜像（来源已经明确）',
      !f.calls.some((c) => c.url.includes('/info/')) && out.error, out.error);
  }

  {
    const pkg = multiZip([
      [TM_CHROME_ID + '_5.5.1_chrome.zzzmh.cn.crx', innerCrx],
      ['安装说明.txt', 'x']
    ]);
    const f = recorder((url) => (url.includes('/info/') ? res(200, MIRROR_HTML) : res(200, pkg)));
    const dest = path.join(mkTmp(), 'chrome-install.crx');
    const out = await downloadCrx(CHROME_URL, dest, { fetchImpl: f });

    check('Chrome 来源的取包成功', out.ok === true, out.error || (out.bytes + ' 字节'));
    check('取的是页面上给的 zip 直链，不是 Edge 的取包接口',
      f.calls.some((c) => /\.zip$/.test(c.url)) && !f.calls.some((c) => /extensionwebstorebase/.test(c.url)));
    const onDisk = fs.readFileSync(dest);
    check('落盘的是拆掉套娃后的 CRX（装载流水线直接能吃）',
      onDisk.subarray(0, 4).toString('latin1') === 'Cr24', onDisk.subarray(0, 4).toString('latin1'));
    check('落盘内容就是内层那个 crx', Buffer.compare(onDisk, innerCrx) === 0);

    const again = await downloadCrx(CHROME_URL, dest, { fetchImpl: f });
    check('下过的不重复下载', again.cached === true);
  }

  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也不影响 */ } }

  console.log('\n[J] 镜像没收录时要说清楚（而不是给一张名为「404」的卡片）');

  {
    /* 镜像站对没收录的扩展返回的是一个错误页，而那个页面的 <h1> 是 404。
     * 实测「Chrome 商店 · 沉浸式翻译」就是这个症状：我们把它当成了扩展名。 */
    const notFoundPage = '<html><head><title>404</title></head><body><h1>404</h1></body></html>';
    check('错误页不会被当成一个叫 404 的扩展', summarizeMirror(notFoundPage, 'a'.repeat(32)) === null);

    const notFoundPage2 = '<html><body><h1>页面不存在</h1></body></html>';
    check('「页面不存在」这类文案同样拒掉', summarizeMirror(notFoundPage2, 'a'.repeat(32)) === null);

    const okPage = '<html><head><meta property="og:image" content="/i.png">'
      + '<meta name="description" content="一个正常的扩展"></head>'
      + '<body><h1>正常的扩展</h1></body></html>';
    const d = summarizeMirror(okPage, 'a'.repeat(32));
    check('正常的详情页照常解析', !!d && d.name === '正常的扩展');
    check('正常的名字里带数字不受影响（只有**纯**数字才算错误页）',
      (() => { const x = summarizeMirror('<h1>7-Zip 助手</h1>', 'a'.repeat(32)); return !!x && x.name === '7-Zip 助手'; })());
  }

  {
    // 有详情页但没下载地址 → 必须在看详情这一步就说清，不能等点安装才失败
    const id = 'a'.repeat(32);
    const page = '<html><body><h1>某个扩展</h1></body></html>';   // 没有 /v3/crx/... 链接
    const r = await fetchChromeDetail(id, { fetchImpl: async () => res(200, page) });
    check('详情页可开但没有下载地址 → 判为没收录', r.notFound === true, JSON.stringify(r.error || '').slice(0, 40));
    check('并且给出可操作的说明（指出替代路径，而不是只说失败）',
      /从已安装的浏览器导入/.test(r.error || ''), (r.error || '').slice(0, 30) + '…');
    check('说明里点明「不是 ID 抄错」（用户第一反应会是这个）',
      /不是 ID 抄错/.test(r.error || ''));
  }

  {
    // 有详情页**且**有下载地址 → 正常
    const id = 'a'.repeat(32);
    const page = '<html><body><h1>某个扩展</h1>'
      + '<a href="/v3/crx/' + 'b'.repeat(32) + '/' + id + '.zip">备用下载</a></body></html>';
    const r = await fetchChromeDetail(id, { fetchImpl: async () => res(200, page) });
    check('有下载地址时正常返回详情与地址',
      !!r.detail && r.detail.name === '某个扩展' && /\.zip$/.test(r.downloadUrl || ''),
      r.downloadUrl);
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n测试自身出错：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
