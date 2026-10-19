#!/usr/bin/env node
/**
 * ed2k / magnet 协议接管测试。
 *
 * 只测纯逻辑：链接解析、展示文案、三种按钮分支、没有客户端时的回退。
 * 「点击确实会走到 will-navigate / window-open」由 Electron 侧实测（见提交说明）。
 */
'use strict';

const path = require('path');
const {
  parseEd2k, parseMagnet, fmtSize, isExternalDownloadLink, handleExternalLink
} = require(path.join(__dirname, '..', 'src', 'main', 'protocol-links.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

const FILE_LINK = 'ed2k://|file|%E6%B5%8B%E8%AF%95.bin|1048576|0123456789ABCDEF0123456789ABCDEF|/';

function makeDeps(response, rejectOpen) {
  const opened = [];
  const copied = [];
  const toasts = [];
  return {
    opened, copied, toasts,
    deps: {
      url: FILE_LINK,
      dialog: { showMessageBox: async () => ({ response }) },
      shell: {
        openExternal: async (u) => {
          if (rejectOpen) throw new Error('no handler');
          opened.push(u);
        }
      },
      clipboard: { writeText: (t) => copied.push(t) },
      toast: (m) => toasts.push(m)
    }
  };
}

(async () => {
  console.log('\nNova 外部下载协议测试\n');

  console.log('[A] ed2k 解析');
  const f = parseEd2k(FILE_LINK);
  check('文件名做了 URL 解码', f && f.name === '测试.bin', f && f.name);
  check('大小解析正确', f && f.size === 1048576, f && String(f.size));
  check('哈希统一转小写', f && f.hash === '0123456789abcdef0123456789abcdef');
  check('kind = file', f && f.kind === 'file');

  const srv = parseEd2k('ed2k://|server|1.2.3.4|4661|/');
  check('server 链接解析', srv && srv.kind === 'server' && srv.host === '1.2.3.4' && srv.port === 4661);
  check('哈希不合法 → 拒绝', parseEd2k('ed2k://|file|x|1|zzz|/') === null);
  check('非 ed2k → 拒绝', parseEd2k('https://example.com/a.bin') === null);

  console.log('\n[B] magnet 解析');
  const m = parseMagnet('magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF&dn=hello%20world&xl=2048');
  check('名称解码', m && m.name === 'hello world', m && m.name);
  check('大小解析', m && m.size === 2048);
  check('识别为 BT', m && m.kind === 'bt');
  check('非 magnet → 拒绝', parseMagnet('ed2k://|file|x|1|' + '0'.repeat(32) + '|/') === null);

  console.log('\n[C] 体积展示');
  check('0 → 未知大小', fmtSize(0) === '未知大小');
  check('1.5 MB', fmtSize(1572864) === '1.5 MB', fmtSize(1572864));
  check('2.0 GB', fmtSize(2 * 1024 ** 3) === '2.0 GB', fmtSize(2 * 1024 ** 3));
  check('>=100 取整', fmtSize(300 * 1024) === '300 KB', fmtSize(300 * 1024));

  console.log('\n[D] 协议判定');
  check('ed2k 命中', isExternalDownloadLink(FILE_LINK) === true);
  check('magnet 命中', isExternalDownloadLink('magnet:?xt=urn:btih:x') === true);
  check('http 不命中', isExternalDownloadLink('https://example.com/') === false);

  console.log('\n[E] 三种按钮分支');
  {
    const d = makeDeps(0);
    const handled = await handleExternalLink(d.deps);
    check('「打开」→ 调用外部程序', handled === true && d.opened.length === 1 && d.copied.length === 0);
  }
  {
    const d = makeDeps(1);
    await handleExternalLink(d.deps);
    check('「复制」→ 只写剪贴板', d.copied.length === 1 && d.opened.length === 0);
  }
  {
    const d = makeDeps(2);
    await handleExternalLink(d.deps);
    check('「取消」→ 什么都不做', d.copied.length === 0 && d.opened.length === 0 && d.toasts.length === 0);
  }
  {
    const d = makeDeps(0, true);
    await handleExternalLink(d.deps);
    check('没有客户端 → 复制并提示',
      d.copied.length === 1 && /已复制/.test(d.toasts[0] || ''), d.toasts[0]);
  }
  {
    let calls = 0;
    const handled = await handleExternalLink({
      url: 'https://example.com/',
      dialog: { showMessageBox: async () => { calls += 1; return { response: 0 }; } },
      shell: { openExternal: async () => {} },
      clipboard: { writeText: () => {} }
    });
    check('普通网址不接管、不弹框', handled === false && calls === 0);
  }

  console.log(`\n结果：${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})();
