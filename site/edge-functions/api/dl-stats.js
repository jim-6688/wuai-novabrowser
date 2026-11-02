/*
 * 下载次数统计（Edge Function · V8 运行时）
 * ---------------------------------------------------------------------------
 * 路由：GET  /api/dl-stats           → { ok, counts: { android, pc } }
 *      POST /api/dl-stats           → body { channel: "android" | "pc" }，计数 +1 后回读
 *      GET  /api/dl-stats?debug=1   → 诊断：运行时里有哪些像 KV 的对象、绑到了哪个名字
 *
 * 存储用 EdgeOne KV。KV 命名空间在控制台绑定，绑定时的「变量名」就是代码里的全局变量名。
 *
 * 这里**不写死绑定名**：直接在 globalThis / context.env 上找「带 get + put 方法的对象」，
 * 谁像 KV 就用谁。这样控制台里绑成 nova_dl_kv、roadtv 还是别的都能接住，
 * 免得因为一个名字对不上反复瞎猜。
 *
 * KV 是最终一致的（全球同步最长 60 秒），读-改-写也不是原子操作，
 * 高并发下可能少计。对「下载次数」这种展示型指标足够，别拿它记账。
 *
 * 这个运行时是 V8（不是 Node）：没有 require / fs / npm，Response.json() 也不可用。
 */

var CHANNELS = ['android', 'pc'];

// 明确的候选绑定名（控制台绑定名称优先命中，省得全量扫描）。
var KNOWN_NAMES = ['nova_dl_kv', 'roadtv', 'NOVA_DL_KV', 'ROADTV'];

function looksLikeKV(v) {
  return !!v && typeof v === 'object' &&
    typeof v.get === 'function' &&
    typeof v.put === 'function';
}

// 返回 { kv, name }；找不到时 { kv: null, name: null }。
function locateKV(context) {
  var g = typeof globalThis !== 'undefined' ? globalThis : null;

  // 1) 先试已知名字（裸全局 / globalThis / context.env）
  for (var i = 0; i < KNOWN_NAMES.length; i++) {
    var n = KNOWN_NAMES[i];
    try { if (g && looksLikeKV(g[n])) return { kv: g[n], name: n }; } catch (e) {}
    try { if (context && context.env && looksLikeKV(context.env[n])) return { kv: context.env[n], name: 'env.' + n }; } catch (e) {}
  }

  // 2) 再扫 globalThis 上所有像 KV 的对象
  if (g) {
    try {
      var keys = Object.keys(g);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        try { if (looksLikeKV(g[key])) return { kv: g[key], name: key }; } catch (e) {}
      }
    } catch (e) {}
  }

  // 3) 最后扫 context.env
  if (context && context.env) {
    try {
      var ekeys = Object.keys(context.env);
      for (var e = 0; e < ekeys.length; e++) {
        var ekey = ekeys[e];
        try { if (looksLikeKV(context.env[ekey])) return { kv: context.env[ekey], name: 'env.' + ekey }; } catch (e2) {}
      }
    } catch (e) {}
  }

  return { kv: null, name: null };
}

// 诊断用：列出 globalThis / env 里所有像 KV 的候选名 + 名字带 kv 的全局键。
function describeRuntime(context) {
  var g = typeof globalThis !== 'undefined' ? globalThis : null;
  var kvCandidates = [];
  var kvishKeys = [];

  if (g) {
    try {
      var keys = Object.keys(g);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var v;
        try { v = g[key]; } catch (e) { continue; }
        if (looksLikeKV(v)) kvCandidates.push('globalThis.' + key);
        if (/kv|store|namespace/i.test(key)) kvishKeys.push(key);
      }
    } catch (e) {}
  }

  var envKeys = [];
  if (context && context.env) {
    try {
      envKeys = Object.keys(context.env);
      for (var j = 0; j < envKeys.length; j++) {
        var ek = envKeys[j];
        try { if (looksLikeKV(context.env[ek])) kvCandidates.push('env.' + ek); } catch (e) {}
      }
    } catch (e) {}
  }

  return {
    kvCandidates: kvCandidates,
    kvishGlobalKeys: kvishKeys,
    envKeys: envKeys
  };
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
  var found = locateKV(context);

  // ?debug=1 输出运行时探测结果，定位「KV 到底绑没绑到函数里」
  var url = '';
  try { url = String((context && context.request && context.request.url) || ''); } catch (e) {}
  if (url.indexOf('debug=1') !== -1) {
    var info = describeRuntime(context);
    info.ok = !!found.kv;
    info.detectedName = found.name;
    info.counts = found.kv ? await readCounts(found.kv) : null;
    return json(info);
  }

  if (!found.kv) return json({ ok: false, reason: 'KV not bound' });
  return json({ ok: true, name: found.name, counts: await readCounts(found.kv) });
}

export async function onRequestPost(context) {
  var found = locateKV(context);
  if (!found.kv) return json({ ok: false, reason: 'KV not bound' });

  var kv = found.kv;
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
