/*
 * 下载次数统计（Edge Function · V8 运行时）
 * ---------------------------------------------------------------------------
 * 路由：GET  /api/dl-stats   → { ok, counts: { android, pc } }
 *      POST /api/dl-stats   → body { channel: "android" | "pc" }，计数 +1 后回读
 *
 * 存储用 EdgeOne KV。**KV 命名空间要在控制台绑定，并把变量名设成 nova_dl_kv**；
 * 没绑定时 typeof 判断会失败，接口返回 ok:false 且不带 counts —— 前端据此隐藏
 * 数字，页面与下载链接完全不受影响。
 *
 * 注意：KV 是最终一致的（全球同步最长 60 秒），读-改-写也不是原子操作，
 * 高并发下可能少计。对「下载次数」这种展示型指标足够，别拿它记账。
 *
 * 这个运行时是 V8（不是 Node）：没有 require / fs / npm，Response.json() 也不可用。
 */

var CHANNELS = ['android', 'pc'];

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function kvReady() {
  // KV 以全局变量形式注入，不在 context.env 上。
  // typeof 对未声明的标识符是安全的，不会抛 ReferenceError。
  return typeof nova_dl_kv !== 'undefined' && nova_dl_kv;
}

function keyOf(channel) {
  return 'dl:' + channel;
}

async function readCounts() {
  var counts = { android: 0, pc: 0 };
  if (!kvReady()) return counts;
  for (var i = 0; i < CHANNELS.length; i++) {
    var ch = CHANNELS[i];
    try {
      var raw = await nova_dl_kv.get(keyOf(ch));
      counts[ch] = raw ? (parseInt(raw, 10) || 0) : 0;
    } catch (e) {
      counts[ch] = 0;
    }
  }
  return counts;
}

export async function onRequestGet() {
  if (!kvReady()) return json({ ok: false, reason: 'KV not bound' });
  return json({ ok: true, counts: await readCounts() });
}

export async function onRequestPost(context) {
  if (!kvReady()) return json({ ok: false, reason: 'KV not bound' });

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
    var raw = await nova_dl_kv.get(keyOf(ch));
    var next = (parseInt(raw, 10) || 0) + 1;
    await nova_dl_kv.put(keyOf(ch), String(next));
  } catch (e) {
    return json({ ok: false, error: 'kv write failed' });
  }

  return json({ ok: true, counts: await readCounts() });
}
