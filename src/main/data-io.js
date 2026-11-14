'use strict';

/**
 * 跨设备数据迁移（本地闭环）
 * ---------------------------------------------------------------------------
 * 把书签 / 历史 / 设置打包成一个 JSON 文件带走，到另一台设备再导入 —— 这是
 * 不依赖任何后端就能做到的最小「同步」。真正跨设备的云端同步需要一套账号与
 * 同步服务（本仓库目前没有，见 shell.js 隐私页的说明），那部分不在这一版里。
 *
 * 刻意**不包含**两类数据：
 *   · Cookie —— 多半是会话令牌，落明文文件等于把登录态到处撒，风险太高；
 *   · 已保存密码的明文 —— 凭证在主进程是加密存的，这里不导出，避免一文件走天下。
 * 想换设备时这两类请各自用系统 / 站点的导出能力，浏览器不替你明文搬运。
 *
 * 纯逻辑、不碰 fs 与 electron，便于离线单测。读文件 / 写文件在主进程做。
 */

const FORMAT = 'nova-data';
const FORMAT_VERSION = 1;

/** 设置里这些键是「本机运行态 / 由别处单独管理」，导入时跳过，不覆盖目标机的。 */
const SETTINGS_SKIP_ON_IMPORT = ['session', 'history', 'bookmarks', 'downloadTasks'];

/** 把要导出的三块整理成包体。bookmarksIo 负责书签的清洗与计数。 */
function buildBundle({ bookmarks, history, settings, appVersion, app }) {
  const bm = (bookmarks || []).filter((b) => b && b.url);
  const hist = (history || []).filter((h) => h && h.url);
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    app: app || '吾爱Nova浏览器',
    appVersion: String(appVersion || ''),
    exportedAt: new Date().toISOString(),
    counts: { bookmarks: bm.length, history: hist.length },
    bookmarks: bm,
    history: hist,
    // 导出设置时同样剥掉运行态键：带过去没有意义（另一台机器的会话当然不该被覆盖）
    settings: pruneSettings(settings || {})
  };
}

/** 导出侧剥键（与导入侧跳过的是同一批）。 */
function pruneSettings(settings) {
  const out = {};
  for (const [k, v] of Object.entries(settings)) {
    if (SETTINGS_SKIP_ON_IMPORT.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 解析一份导入文件，返回干净的三块。刻意不抛异常：文件格式不对是常事，
 * 一律降级成「能认几块认几块 + 一句人话」。
 *
 * 兼容两种来源：
 *   · 自家 nova-data 包（含 bookmarks / history / settings）
 *   · 单独的书签文件（nova-bookmarks 或 Netscape HTML）—— 只填 bookmarks 一块
 */
function parseBundle(text) {
  const raw = String(text || '');
  const trimmed = raw.trim();
  if (!trimmed) return { isBundle: false, bookmarks: [], history: [], settings: {}, warnings: ['文件是空的'] };

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data;
    try { data = JSON.parse(trimmed); } catch (e) {
      return { isBundle: false, bookmarks: [], history: [], settings: {}, warnings: ['这个 JSON 解析不了：' + e.message] };
    }
    // 自家数据包：历史与设置只在这是 nova-data 时才填（其它 JSON 书签文件不含这些块）
    if (data && data.format === FORMAT) {
      return {
        isBundle: true,
        bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks : [],
        history: Array.isArray(data.history) ? data.history : [],
        settings: (data.settings && typeof data.settings === 'object') ? data.settings : {},
        warnings: []
      };
    }
    // 否则当作纯书签 JSON（nova-bookmarks 或裸数组）；历史与设置不在这类文件里
    const arr = Array.isArray(data) ? data : (data && data.bookmarks);
    if (Array.isArray(arr)) return { isBundle: false, bookmarks: arr, history: [], settings: {}, warnings: ['只认出书签，历史与设置未包含'] };
    return { isBundle: false, bookmarks: [], history: [], settings: {}, warnings: ['这个 JSON 里没有可用于导入的内容'] };
  }
  // 不是 JSON 又长得像 Netscape HTML 书签文件：书签交给 bookmarks-io 解析，
  // 这里不填历史与设置（这类文件本来就没有）。
  if (/<A\s/i.test(trimmed) || /<!DOCTYPE\s+HTML/i.test(trimmed) || /<DT>/i.test(trimmed)) {
    return { isBundle: false, bookmarks: [], history: [], settings: {}, warnings: ['只认出书签（HTML），历史与设置未包含'] };
  }
  return { isBundle: false, bookmarks: [], history: [], settings: {}, warnings: ['认不出这个文件的格式（支持 nova-data 包、书签 JSON 与浏览器导出的 HTML）'] };
}

/** 合并设置：深合并且跳过运行态键。返回新的完整 settings（调用方负责写回）。 */
function mergeSettings(existing, incoming) {
  const base = Object.assign({}, existing || {});
  const patch = (incoming && typeof incoming === 'object') ? incoming : {};
  for (const [k, v] of Object.entries(patch)) {
    if (SETTINGS_SKIP_ON_IMPORT.includes(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      base[k] = mergeSettings(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

/** 合并历史：去重（按归一化 URL）后合进现有，最多保留 2000 条，新近的排前面。 */
function mergeHistory(existing, incoming) {
  const key = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
  const seen = new Set((existing || []).map((h) => key(h.url)));
  const merged = (existing || []).slice();
  let added = 0;
  for (const h of incoming || []) {
    if (!h || !h.url) continue;
    const k = key(h.url);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.unshift(Object.assign({ visits: 1, ts: Date.now() }, h));
    added++;
  }
  if (merged.length > 2000) merged.length = 2000;
  return { merged, added };
}

module.exports = { FORMAT, FORMAT_VERSION, buildBundle, parseBundle, mergeSettings, mergeHistory, SETTINGS_SKIP_ON_IMPORT };
