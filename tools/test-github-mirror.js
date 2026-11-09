'use strict';
/**
 * GitHub 镜像改写纯函数单测（Node，无需 Electron / jsdom）。
 * 用法：node tools/test-github-mirror.js
 *
 * 覆盖 src/main/github-mirror.js 的改写规则，尤其是「绝不把账号流量交给
 * 第三方」那几条边界 —— 这部分一旦写错，用户可能把登录 POST 发到镜像站。
 */
const path = require('path');
const G = require(path.join(__dirname, '..', 'src', 'main', 'github-mirror.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

const CFG = {
  enabled: true,
  siteMirror: 'https://bgithub.xyz',
  assetMirror: 'https://gh-proxy.com/'
};
const r = (url, extra, cfg) => G.rewrite(Object.assign({ url, method: 'GET', resourceType: 'mainFrame' }, extra || {}), cfg || CFG);

console.log('\n[A] 总开关与归一化');
check('默认关闭时不改写', G.rewrite({ url: 'https://github.com/a/b' }, { enabled: false, siteMirror: CFG.siteMirror, assetMirror: CFG.assetMirror }) === null);
check('老配置没这个键（cfg=undefined）直连', G.rewrite({ url: 'https://github.com/a/b' }, undefined) === null);
check('enabled 写成字符串 "true" 也不生效', G.rewrite({ url: 'https://github.com/a/b' }, { enabled: 'true' }) === null);
check('originOf 去掉尾斜杠与路径', G.originOf('https://bgithub.xyz/foo/') === 'https://bgithub.xyz');
check('originOf 允许只填域名', G.originOf('kkgithub.com') === 'https://kkgithub.com');
check('originOf 拒绝非法值', G.originOf('localhost') === '');
check('prefixOf 保留带路径的服务', G.prefixOf('https://moeyy.cn/gh-proxy/') === 'https://moeyy.cn/gh-proxy/');
check('prefixOf 补一个尾斜杠', G.prefixOf('https://ghproxy.net') === 'https://ghproxy.net/');
check('prefixOf 不会补出双斜杠', G.prefixOf('https://gh-proxy.com/') === 'https://gh-proxy.com/');
check('prefixOf 拒绝非法值', G.prefixOf('') === '');

console.log('\n[B] 整站镜像：github.com 网页');
check('仓库页换成镜像域名', r('https://github.com/tensorflow/tensorflow') === 'https://bgithub.xyz/tensorflow/tensorflow');
check('www 子域同样处理', r('https://www.github.com/a/b') === 'https://bgithub.xyz/a/b');
check('保留查询串与 hash', r('https://github.com/a/b?tab=readme#x') === 'https://bgithub.xyz/a/b?tab=readme#x');
check('首页也走镜像', r('https://github.com/') === 'https://bgithub.xyz/');
check('搜索页走镜像', r('https://github.com/search?q=nova') === 'https://bgithub.xyz/search?q=nova');
check('自定义整站镜像生效', r('https://github.com/a/b', {}, { enabled: true, siteMirror: 'https://kkgithub.com/', assetMirror: CFG.assetMirror }) === 'https://kkgithub.com/a/b');
check('整站镜像填错就直连、不拼出坏 URL', r('https://github.com/a/b', {}, { enabled: true, siteMirror: 'localhost', assetMirror: CFG.assetMirror }) === null);

console.log('\n[C] 资源前缀镜像：文件类子域与下载路径');
check('raw 文件', r('https://raw.githubusercontent.com/a/b/main/f.txt') === 'https://gh-proxy.com/https://raw.githubusercontent.com/a/b/main/f.txt');
check('codeload 源码包', r('https://codeload.github.com/a/b/zip/refs/heads/main') === 'https://gh-proxy.com/https://codeload.github.com/a/b/zip/refs/heads/main');
check('objects（Release 附件实际落点）', r('https://objects.githubusercontent.com/x/y') === 'https://gh-proxy.com/https://objects.githubusercontent.com/x/y');
check('gist raw', r('https://gist.githubusercontent.com/a/1/raw/f') === 'https://gh-proxy.com/https://gist.githubusercontent.com/a/1/raw/f');
check('github.com 的 releases/download', r('https://github.com/a/b/releases/download/v1/app.zip') === 'https://gh-proxy.com/https://github.com/a/b/releases/download/v1/app.zip');
check('github.com 的 archive 源码包', r('https://github.com/a/b/archive/refs/tags/v1.zip') === 'https://gh-proxy.com/https://github.com/a/b/archive/refs/tags/v1.zip');
check('自定义前缀镜像（带路径）', r('https://raw.githubusercontent.com/a/b/main/f.txt', {}, { enabled: true, siteMirror: CFG.siteMirror, assetMirror: 'https://moeyy.cn/gh-proxy/' }) === 'https://moeyy.cn/gh-proxy/https://raw.githubusercontent.com/a/b/main/f.txt');
check('前缀镜像填错时下载仍直连', r('https://raw.githubusercontent.com/a/b/main/f.txt', {}, { enabled: true, siteMirror: CFG.siteMirror, assetMirror: 'not a url' }) === null);

console.log('\n[D] 绝不改写的部分（安全边界）');
check('非 GET：POST 登录表单', r('https://github.com/session', { method: 'POST' }) === null);
check('非 GET：PUT API', r('https://github.com/a/b', { method: 'PUT' }) === null);
check('HEAD 仍可改写', r('https://github.com/a/b', { method: 'HEAD' }) === 'https://bgithub.xyz/a/b');
check('xhr 不改写', r('https://github.com/a/b', { resourceType: 'xhr' }) === null);
check('fetch 不改写', r('https://github.com/a/b', { resourceType: 'fetch' }) === null);
check('websocket 不改写', r('https://github.com/a/b', { resourceType: 'websocket' }) === null);
check('api.github.com（可能带 Token）', r('https://api.github.com/repos/a/b') === null);
check('gist.github.com', r('https://gist.github.com/a/1') === null);
check('github.io', r('https://a.github.io/') === null);
check('头像 CDN 直连', r('https://avatars.githubusercontent.com/u/1') === null);
check('用户图片 CDN 直连', r('https://user-images.githubusercontent.com/1.png') === null);
check('camo 图片代理直连', r('https://camo.githubusercontent.com/abc') === null);
check('/login 不改写', r('https://github.com/login') === null);
check('/session 不改写', r('https://github.com/session') === null);
check('/settings/profile 不改写', r('https://github.com/settings/profile') === null);
check('/oauth/authorize 不改写', r('https://github.com/login/oauth/authorize') === null);
check('/notifications 不改写', r('https://github.com/notifications') === null);
check('/user/repo 是公开仓库，不能被 /user 误伤', r('https://github.com/user/repo') === 'https://bgithub.xyz/user/repo');
check('其他域名不改写', r('https://www.baidu.com/s?wd=x') === null);
check('非法 URL 不改写', r('not a url') === null);
check('file:// 不改写', r('file:///C:/x.html') === null);
check('空 URL 不改写', r('') === null);

console.log('\n[E] 不成环 / 幂等');
const once = r('https://github.com/a/b');
check('改写结果再过一次规则 → 不再改写', G.rewrite({ url: once, method: 'GET', resourceType: 'mainFrame' }, CFG) === null);
const assetOnce = r('https://raw.githubusercontent.com/a/b/main/f.txt');
check('前缀镜像结果再过一次规则 → 不再改写', G.rewrite({ url: assetOnce, method: 'GET', resourceType: 'mainFrame' }, CFG) === null);
check('isPrivatePath 按第一段判断', G.isPrivatePath('/settings/admin') === true && G.isPrivatePath('/a/settings') === false);

console.log('\n[F] 候选清单与设置页预览');
check('整站候选都是 https 且不带尾斜杠', G.SITE_MIRRORS.length >= 3 && G.SITE_MIRRORS.every((m) => /^https:\/\/[^/]+$/.test(m.url)));
check('资源候选都以斜杠结尾', G.ASSET_MIRRORS.length >= 5 && G.ASSET_MIRRORS.every((m) => m.url.endsWith('/')));
check('候选 id 不重复', new Set([...G.SITE_MIRRORS, ...G.ASSET_MIRRORS].map((m) => m.id)).size === G.SITE_MIRRORS.length + G.ASSET_MIRRORS.length);
check('默认值来自候选清单', G.SITE_MIRRORS[0].url === G.DEFAULT_SITE_MIRROR && G.ASSET_MIRRORS[0].url === G.DEFAULT_ASSET_MIRROR);
check('preview 给出改写结果', G.preview('https://github.com/a/b', CFG) === 'https://bgithub.xyz/a/b');
check('preview 对不改写项原样返回', G.preview('https://api.github.com/repos/a/b', CFG) === 'https://api.github.com/repos/a/b');

console.log('\n[G] 请求闸门接线（模拟 webRequest，不需要 Electron）');
const { wireRequestGate } = require(path.join(__dirname, '..', 'src', 'main', 'request-gate.js'));

let liveCfg = CFG;
let adblockHit = false;
let gateHandler = null;
wireRequestGate({
  webRequest: { onBeforeRequest: (_filter, cb) => { gateHandler = cb; } }
}, {
  adblock: { check: () => (adblockHit ? { raw: '||github.com^' } : null) },
  noMedia: { shouldBlock: () => null },
  githubRewrite: (d) => G.rewrite(d, liveCfg)
});
const gate = (details) => {
  let out = null;
  gateHandler(details, (r) => { out = r; });
  return out;
};
const nav = { url: 'https://github.com/a/b', method: 'GET', resourceType: 'mainFrame', webContentsId: 1 };

check('闸门只注册一条 onBeforeRequest', typeof gateHandler === 'function');
const g1 = gate(nav);
check('命中时以 redirectURL 改道', !!g1 && g1.redirectURL === 'https://bgithub.xyz/a/b', JSON.stringify(g1));
const g2 = gate({ url: 'https://www.baidu.com', method: 'GET', resourceType: 'mainFrame', webContentsId: 1 });
check('不命中时正常放行', !!g2 && g2.cancel === false && !g2.redirectURL);

liveCfg = { enabled: false, siteMirror: CFG.siteMirror, assetMirror: CFG.assetMirror };
const g3 = gate(nav);
check('总开关关掉后闸门不再改道', !!g3 && g3.cancel === false && !g3.redirectURL);
liveCfg = CFG;

adblockHit = true;
const g4 = gate(nav);
check('广告拦截命中时优先 cancel，不做改道', !!g4 && g4.cancel === true && !g4.redirectURL);
adblockHit = false;

let throwHandler = null;
wireRequestGate({
  webRequest: { onBeforeRequest: (_f, cb) => { throwHandler = cb; } }
}, {
  adblock: { check: () => null },
  noMedia: { shouldBlock: () => null },
  githubRewrite: () => { throw new Error('boom'); }
});
let g5 = null;
throwHandler(nav, (r) => { g5 = r; });
check('改写函数抛异常时直连放行，不把页面搞挂', !!g5 && g5.cancel === false && !g5.redirectURL);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
