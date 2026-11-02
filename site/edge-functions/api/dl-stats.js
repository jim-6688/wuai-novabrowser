/*
 * 下载次数统计（Edge Function · V8 运行时）
 * ---------------------------------------------------------------------------
 * 路由：GET  /api/dl-stats   → { ok, counts: { android, pc } }
 *      POST /api/dl-stats   → body { channel: "android" | "pc" }，计数 +1 后回读
 *
 * 存储用 EdgeOne KV。KV 命名空间在控制台绑定，变量名 = 绑定名称那一列的值。
 * 当前线上绑定的变量名是 `roadtv`（命名空间 nova_n1_kv）。
 * 兼容旧命名 `nova_dl_kv`。不同运行时注入位置可能不同：裸全局 / globalThis / context.env，三处都探测。
 *
 * KV 是最终一致的（全球同步最长 60 秒），读-改-写也不是原子操作，
 * 高并发下可能少计。对「下载次数」这种展示型指标足够，别拿它记账。
 *
 * 这个运行时是 V8（不是 Node）：没有 require / fs / npm，Response.json() 也不可用。
 */

var CHANNELS = ['android', 'pc'];

// 探测 KV 句柄：依次尝试裸全局 / globalThis / context.env，绑定名 roadtv 优先、nova_dl_kv 兼容。
function locateKV(context) {
  // 候选绑定名（控制台「绑定名称」列的值）。roadtv 为当前线上实际绑定名。
  var candidates = [];
  try { if (typeof roadtv !== 'undefined' && roadtv) candidates.push(roadtv); } catch (e) {}
  try { if (typeof globalThis !== 'undefined' && globalThis.roadtv) candidates.push(globalThis.roadtv); } catch (e) {}
  try { if (typeof nova_dl_kv !== 'undefined' && nova_dl_kv) candidates.push(nova_dl_kv); } catch (e) {}
  try { if (typeof globalThis !== 'undefined' && globalThis.nova_dl_kv) candidates.push(globalThis.nova_dl_kv); } catch (e) {}
  if (context && context.env) {
    [context.env.roadtv, context.env.nova_dl_kv, context.env.ROADTV, context.env.NOVA_DL_KV].forEach(function (v) {
      if (v) candidates.push(v);
    });
  }
  return candidates[0];
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

export async function onRequestGet(context) {
  var kv = locateKV(context);
  if (!kv) return json({ ok: false, reason: 'KV not bound' });
  return json({ ok: true, counts: await readCounts(kv) });
}

export async function onRequestPost(context) {
  var kv = locateKV(context);
  if (!kv) return json({ ok: false, reason: 'KV not bound' });

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
    var raw = await kv.get(keyOf(ch));
    var next = (parseInt(raw, 10) || 0) + 1;
    await kv.put(keyOf(ch), String(next));
  } catch (e) {
    return json({ ok: false, error: 'kv write failed' });
  }

  return json({ ok: true, counts: await readCounts(kv) });
}
