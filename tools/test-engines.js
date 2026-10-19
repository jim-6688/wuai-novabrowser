#!/usr/bin/env node
/**
 * 引擎适配层测试
 *
 * 覆盖两件事：
 *   1) 内核清单 → 运行时模式 / 降级原因 / 描述符 的推导是否正确
 *   2) NDJSON 宿主协议（帧解析、reply 关联、超时）是否正确
 *
 * 纯 Node，不联网、不派生子进程。
 */
'use strict';

const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const {
  EngineRegistry, NativeKernelHost, loadKernelManifest, ENGINE_MANIFEST
} = require(path.join(root, 'src/main/engines.js'));

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

(async () => {
  console.log('\nNova 引擎适配层测试\n');

  /* ---------------------------------------------------------------- */
  console.log('[A] 内核清单读取');
  const man = loadKernelManifest();
  check('清单路径指向 native/engines/manifest.json',
        ENGINE_MANIFEST.replace(/\\/g, '/').endsWith('native/engines/manifest.json'));
  check('清单能被读取', man !== null);
  if (!man) { console.log('\n清单缺失，后续用例跳过\n'); process.exit(1); }
  check('清单含两个内核', ['chromium', 'trident'].every((k) => man.engines[k]),
        Object.keys(man.engines).join(', '));
  check('清单记录了原生宿主探测结果', Array.isArray(man.hosts) && man.hosts.length === 1,
        man.hosts.map((h) => h.id + (h.present ? '✓' : '✗')).join(' '));

  /* ---------------------------------------------------------------- */
  console.log('\n[B] 运行时模式推导');
  const reg = new EngineRegistry();
  const list = await reg.resolveAll();
  const by = Object.fromEntries(list.map((e) => [e.id, e]));

  check('Chromium = 原生内核', by.chromium.mode === 'native', by.chromium.modeLabel);
  check('Trident 随包提供宿主 → 原生桥接', by.trident.mode === 'bridge', by.trident.modeLabel);
  check('原生内核不报降级原因', by.chromium.fallbackReason === null);
  check('桥接内核不报降级原因', by.trident.fallbackReason === null);

  /* ---------------------------------------------------------------- */
  console.log('\n[C] 原生桥接的就绪状态');
  check('Trident kernel.bridgeReady = true（宿主已随包提供）',
        by.trident.kernel && by.trident.kernel.bridgeReady === true);
  check('Trident 内核由系统提供（不是下载来的）',
        (man.engines.trident.sources || []).some((x) => x.role === 'system'),
        (man.engines.trident.sources || []).map((x) => x.role).join(', '));

  /* ---------------------------------------------------------------- */
  console.log('\n[D] 描述符携带内核二进制详情（供 UI 展示）');
  const ce = by.chromium.kernel;
  check('Chromium 列出 2 个发行版（Electron + CEF）', ce.sources.length === 2,
        ce.sources.map((s) => s.id).join(', '));
  check('CEF 被识别为 CEF/Chromium Embedded',
        ce.sources.some((s) => /CEF/.test(s.signature.detected)));
  check('Electron 被识别为 Electron/Chromium',
        ce.sources.some((s) => /Electron/.test(s.signature.detected)));

  const td = by.trident.kernel;
  check('Trident 被识别为 MSHTML', /MSHTML/.test(td.sources[0].signature.detected),
        td.sources[0].signature.detected);

  /* ---------------------------------------------------------------- */
  console.log('\n[E] forceCompat 强制降级');
  const reg2 = new EngineRegistry();
  await reg2.resolveAll({ forceCompat: true });
  const forced = reg2.get('chromium');
  check('强制降级时 Chromium 保持 native（native 不受 forceCompat 影响）',
        forced.mode === 'native', forced.modeLabel);

  /* ---------------------------------------------------------------- */
  console.log('\n[F] NDJSON 宿主协议');
  const host = new NativeKernelHost('nohost');
  const probe = host.probe();
  check('probe() 在无二进制时返回 available=false', probe.available === false);
  check('probe() 给出人类可读的 reason', /nohost-host/.test(probe.reason || ''), probe.reason);

  // 用假 stdin 顶替子进程，直接灌数据进协议解析器
  let written = [];
  host.proc = { stdin: { write: (s) => written.push(s) } };

  const seen = [];
  host.on('title', (m) => seen.push(['title', m.title]));
  host.on('url', (m) => seen.push(['url', m.url]));
  host.on('ready', (m) => seen.push(['ready', m.kernel]));

  // 一次灌入多行：必须逐行正确切分（含跨 chunk 的半行）
  host._onData('{"t":"ready","kernel":"trident","version":"11.0"}\n{"t":"title","viewId":1,"tit');
  check('半行不会被误解析', seen.length === 1 && seen[0][0] === 'ready',
        JSON.stringify(seen));
  host._onData('le":"示例站点"}\n{"t":"url","viewId":1,"url":"https://52ta.top/"}\n');
  check('补齐后剩余行全部解析', seen.length === 3, JSON.stringify(seen));
  check('title 事件正确', seen[1][0] === 'title' && seen[1][1] === '示例站点');
  check('url 事件正确', seen[2][0] === 'url' && seen[2][1] === 'https://52ta.top/');

  // 坏行必须被吞掉，不能让整条流挂掉
  host._onData('这不是 JSON\n{"t":"url","viewId":1,"url":"https://after.example/"}\n');
  check('非法 JSON 行被跳过，后续行照常解析',
        seen[seen.length - 1][1] === 'https://after.example/', JSON.stringify(seen[seen.length - 1]));
  check('空行被跳过', (() => {
    const n = seen.length;
    host._onData('\n\n\n');
    return seen.length === n;
  })());

  // reply 关联：send(expectReply) 必须等到同 id 的 reply
  const p = host.send('eval', { viewId: 1, code: '1+1' }, { expectReply: true });
  check('指令已按 NDJSON 写出', written.length === 1 && written[0].endsWith('\n'),
        JSON.stringify(written[0] || ''));
  const sent = JSON.parse(written[0]);
  check('指令带自增 id 与 type', sent.t === 'eval' && sent.id === 1, JSON.stringify(sent));
  check('reply 到达前 promise 未 settle', (() => { let done = false; p.then(() => { done = true; }); return !done; })());
  host._onData(`{"t":"reply","id":${sent.id},"ok":true,"result":2}\n`);
  const reply = await p;
  check('reply 正确关联到对应 id', reply.result === 2, JSON.stringify(reply));

  // id 不复用
  host.send('navigate', { viewId: 1, url: 'x' });
  check('id 单调递增不复用', JSON.parse(written[written.length - 1]).id === sent.id + 1);

  // 超时
  const t0 = Date.now();
  try {
    await host.send('eval', { viewId: 1, code: 'sleep' }, { expectReply: true, timeout: 120 });
    check('未收到 reply 时应当超时抛错', false);
  } catch (e) {
    const dt = Date.now() - t0;
    check('未收到 reply 时按 timeout 抛错', /超时/.test(e.message) && dt >= 110 && dt < 2000,
          `${e.message} (${dt}ms)`);
  }

  host.proc = null;
  await host.send('eval', {}).catch((e) => {
    check('宿主未运行时 send 明确拒绝', /未运行/.test(e.message), e.message);
  });

  /* ---------------------------------------------------------------- */
  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试本身抛错：', e);
  process.exit(1);
});
