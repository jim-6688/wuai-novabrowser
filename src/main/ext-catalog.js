'use strict';
/**
 * 官网插件目录（site/extensions.json）的读取与归一化。
 *
 * <p><b>为什么必须由主进程读</b>：shell.html 的 CSP 只放开 'self'，没声明
 * connect-src，渲染层直接 fetch 官网会被挡；而且这份目录同时喂官网页面和
 * PC 端设置页，字段兜底 / 地址白名单只该有一份，不能两端各写一遍。
 *
 * <p><b>为什么是纯模块</b>：与 ext-store.js / updater.js 同一约定 —— 不 import
 * electron，网络由 {@code opts.fetchImpl} 注入，普通 Node 进程就能跑单测。
 * 生产路径用 Node 全局 fetch（带 AbortController 超时）；三个源按顺序回退，
 * 官网不可达时退到 Gitee / GitHub 上那份入库的同一个文件。
 *
 * <p><b>只做目录，不碰安装</b>：拉回来的 installUrl 原样交给既有的
 * {@code ext:store-install}，由 ext-store.parseStoreInput 解析 32 位 ID /
 * 详情页 / 直链并取包装载。这里刻意不新增一条安装链路 —— 两条链路一旦
 * 分开维护，判重、落盘、重启恢复迟早会对不上。
 */

const CATALOG_URLS = [
  'https://nova.52ta.top/extensions.json',
  'https://gitee.com/jinghe-net/i-adore-the-nova-browser/raw/main/site/extensions.json',
  'https://raw.githubusercontent.com/jim-6688/wuai-novabrowser/main/site/extensions.json'
];

/** 官网自托管扩展包时，清单里的相对地址统一按站点根补全。 */
const SITE_BASE = 'https://nova.52ta.top/';
const MAX_ITEMS = 60;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 8000;

function text(v, fallback) {
  return (typeof v === 'string' && v.trim()) ? v.trim() : (fallback || '');
}

/**
 * 安装地址只认三种形态：32 位扩展 ID、http(s) 地址、以及指向官网相对路径的
 * 扩展包名。file: / data: / javascript: 之类一律丢掉 —— 清单是远端下发的，
 * 万一被替换，不想让它变成「点一下就加载本地文件」。
 */
function resolveInstallUrl(it) {
  const raw = text(it.packageUrl) || text(it.installUrl);
  if (!raw) return '';
  if (/^[a-p]{32}$/.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[\w./-]+\.(crx|crx3|zip|xpi)$/i.test(raw)) {
    try { return new URL(raw, SITE_BASE).href; } catch { return ''; }
  }
  return '';
}

/** 把远端清单收成界面能直接用的形状；一条都装不了时返回空数组而不是抛错。 */
function normalize(data) {
  if (!data || !Array.isArray(data.items)) return null;
  const seen = Object.create(null);
  const items = [];
  for (const it of data.items) {
    if (!it || typeof it !== 'object') continue;
    const id = text(it.id);
    const installUrl = resolveInstallUrl(it);
    if (!id || !installUrl || seen[id]) continue;
    seen[id] = 1;
    items.push({
      id,
      name: text(it.name, '未命名扩展'),
      developer: text(it.developer, '未知开发者'),
      category: text(it.category, '其它'),
      mark: text(it.mark, 'E').slice(0, 2),
      accent: /^#[0-9a-fA-F]{6}$/.test(it.accent || '') ? it.accent : '#3D6BFF',
      description: text(it.description),
      installUrl,
      source: text(it.source, '来源未标注'),
      homepage: text(it.homepage),
      tags: Array.isArray(it.tags)
        ? it.tags.filter((t) => typeof t === 'string').slice(0, 4)
        : [],
      featured: !!it.featured
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/** 真实取数：超时 / 超大 / 非 200 / 坏 JSON 一律抛，交给 load 换下一个源。 */
async function defaultFetch(url, timeoutMs) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || TIMEOUT_MS) : null;
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: ctl ? ctl.signal : undefined,
      headers: { Accept: 'application/json' }
    });
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
    const body = await res.text();
    if (body.length > MAX_BYTES) throw new Error('清单过大');
    return JSON.parse(body);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 按顺序试三个源，第一个成功的就用它。
 * 返回值恒定为 {@code {ok, items, updatedAt, url, error}} —— 界面不用猜形状。
 */
async function load(opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || defaultFetch;
  const urls = Array.isArray(o.urls) && o.urls.length ? o.urls : CATALOG_URLS;
  let lastErr = null;
  for (const url of urls) {
    try {
      const data = await fetchImpl(url, o.timeoutMs || TIMEOUT_MS);
      const items = normalize(data);
      if (!items) { lastErr = new Error('清单格式不对'); continue; }
      return {
        ok: true,
        items,
        updatedAt: text(data.updatedAt),
        note: text(data.note),
        url,
        error: ''
      };
    } catch (err) {
      lastErr = err;
    }
  }
  return {
    ok: false,
    items: [],
    updatedAt: '',
    note: '',
    url: '',
    error: '官网插件目录暂时读取不到' + (lastErr ? '（' + lastErr.message + '）' : '')
      + '，可稍后点「刷新目录」，或直接粘贴扩展地址安装。'
  };
}

module.exports = {
  CATALOG_URLS, SITE_BASE, MAX_ITEMS, MAX_BYTES, TIMEOUT_MS,
  text, resolveInstallUrl, normalize, defaultFetch, load
};
