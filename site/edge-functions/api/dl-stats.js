/*
 * 下载次数统计（Edge Function · V8 运行时）
 * ---------------------------------------------------------------------------
 * 路由：GET  /api/dl-stats   → { ok, counts: { android, pc } }
 *      POST /api/dl-stats   → body { channel: "android" | "pc" }，计数 +1 后回读
 *
 * 存储用 EdgeOne KV。KV 命名空间在控制台绑定，变量名 = nova_dl_kv。
 * 不同运行时注入位置可能不同：裸全局 / globalThis / context.env，这里三处都探测。
 *
 * KV 是最终一致的（全球同步最长 60 秒），读-改-写也不是原子操作，
 * 高并发下可能少计。对「下载次数」这种展示型指标足够，别拿它记账。
 *
 * 这个运行时是 V8（不是 Node）：没有 require / fs / npm，Response.json() 也不可用。
 */

var CHANNELS = ['android', 'pc'];

// 探测 KV 句柄：依次尝试三种可能的注入位置，返回第一个可用的。
function locateKV(context) {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.nova_dl_kv) {
      return { kv: globalThis.nova_dl_kv, where: 'globalThis' };
    }
  } catch (e) {}
  try {
    if (typeof nova_dl_kv !== 'undefined' && nova_dl_kv) {
      return { kv: nova_dl_kv, where: 'bare' };
    }
  } catch (e) {}
  try {
    if (context && context.env) {
      if (context.env.nova_dl_kv) return { kv: context.env.nova_dl_kv, where: 'env.nova_dl_kv' };
      if (context.env.NOVA_DL_KV) return { kv: context.env.NOVA_DL_KV, where: 'env.NOVA_DL_KV' };
    }
  } catch (e) {}
  return { kv: undefined, where: null };
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function keyOf(channel) {
  return 'dl:' + channel;
}

async function readCounts(kv) {
  var counts = { android: 0, pc: 0 };
  if (!kv) return counts;
  for (var i = 0; i < CHANNELS.length; i++) {
    var ch = CHANNELS[i];
    try {
      var raw = await kv.get(keyOf(ch));
      counts[ch] = raw ? (parseInt(raw, 10) || 0) : 0;
    } catch (e) {
      counts[ch] = 0;
    }
  }
  return counts;
}

export async function onRequestGet() {
  var found = locateKV();
  if (!found.kv) {
    // 探测诊断：KV 没找到时，把三处 available 情况带回，方便定位注入方式。
    var diag = {
      hasGlobalThis: typeof globalThis !== 'undefined',
      bareTypeof: (function () { try { return typeof nova_dl_kv; } catch (e) { return 'throw'; } })(),
      envHasNova: (typeof globalThis !== 'undefined' && globalThis.nova_dl_kv) ? true : false
    };
    return json({ ok: false, reason: 'KV not bound', where: found.where, diag: diag });
  }
  return json({ ok: true, counts: await readCounts(found.kv) });
}

export async function onRequestPost(context) {
  var found = locateKV(context);
  if (!found.kv) return json({ ok: false, reason: 'KV not bound', where: found.where });

  var body = {};
  try {
    body = await context.request.json();
  } catch (e) {
    body = {};
  }

  var ch = String((body && body.channel) || '');
  if (CHANNELS.indexOf(ch) === -1) {
    return json({ ok: false, error: 'unknown channel' }, 400);
  }

  try {
    var raw = await found.kv.get(keyOf(ch));
    var next = (parseInt(raw, 10) || 0) + 1;
    await found.kv.put(keyOf(ch), String(next));
  } catch (e) {
    return json({ ok: false, error: 'kv write failed' });
  }

  return json({ ok: true, counts: await readCounts(found.kv) });
}
