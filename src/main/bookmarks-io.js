'use strict';

/**
 * 书签的导入 / 导出
 * ---------------------------------------------------------------------------
 * 格式选 **JSON**，不是浏览器标准的 HTML（Bookmarks 文件）：
 *
 *   · HTML 那套结构（`<DT><A HREF=…>`、文件夹嵌套、NETSCAPE-Bookmark 头）
 *     对着「一堆平铺的 title+url」来说是过度设计，而且两边现成的解析器
 *     各有各的怪癖（编码、非 ASCII 的转义、文件夹层级），为它引入依赖不划算。
 *   · JSON 能原样带 title 与 url，也便于日后加字段（比如图标、加入时间）
 *     而不改格式版本。
 *   · **仍然能读 Chrome / Edge 导出的 HTML**：那是别人已经在用的格式，
 *     不支持就等于「导入」这个功能对最需要它的场景（从别的浏览器搬过来）
 *     失效。读它只需要正则那几个标签，比引入一整个解析库轻得多。
 *
 * 所以是**双向不对称**：导出只出自家 JSON（没有别的浏览器会读它），
 * 导入既认自家 JSON 也认 Netscape HTML。
 *
 * 纯逻辑，不碰 fs 与 electron —— 读文件、写文件都在 main.js 那边做。
 * 这样合并、去重、清洗这几条最容易写错的规则可以离线单测。
 */

/** 格式版本。往后加字段时递增，读取时按版本决定怎么解释。 */
const FORMAT = 'nova-bookmarks';
const FORMAT_VERSION = 1;

/**
 * 这个协议该不该进新标签页的候选 / 书签表。
 *
 * <p>两个来源用的是**同一个判断**（新标签页的磁贴、书签的导入），
 * 所以只有一处定义。分成两处写的话，迟早有一处放宽了而另一处没有 ——
 * 而「导出→导入应当恒等」这条承诺正是这么被打破的：buildExport 只看
 * typeof url === 'string' 就放行 file:// 与 about:blank，而 normalize
 * 用 /https?|是否/ 拦掉了它们，于是用户导出的备份自己导不回来。
 */
function importable(url) {
  if (!url) return false;
  return /^https?:\/\//i.test(String(url).trim());
}

/**
 * 把内部那份书签整理成导出用的形状。
 *
 * @param {Array<{title?:string,url:string,favicon?:string}>} list
 * @param {number} version 应用版本，写进文件里便于日后排查
 * @returns {object} 可直接 JSON.stringify 的对象
 */
function buildExport(list, version) {
  const items = (list || [])
    .filter((b) => b && importable(b.url))
    .map((b) => {
      const url = b.url.trim();
      // 标题为空时**在导出这一步就用地址顶上**，而不是留个空字符串出去。
      // 空标题的条目导出后，在别的编辑器里看就是一条没有名字的裸地址，
      // 而导入侧（normalize）虽然也会兜底，但两份文件就不一样了 ——
      // 「导出→导入」不再是恒等的，而那条恒等性正是用户拿来信这个功能的依据。
      const title = String(b.title || '').trim() || url;
      const o = { url, title };
      // favicon 只在有的时候带：多数书签没有，字段一多文件就全是 null
      if (b.favicon) o.favicon = b.favicon;
      return o;
    });
    // skipped 一并带出去：内部页（file:// 的新标签页、about:blank）导不出去，
    // 界面要能如实告诉用户「少了几条」，否则他对着数量对不上会以为文件坏了。
  const skipped = (list || []).length - items.length;
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    app: '吾爱Nova浏览器',
    appVersion: String(version || ''),
    exportedAt: new Date().toISOString(),
    count: items.length,
    skipped,
    bookmarks: items
  };
}

/**
 * 解析一份导入文件，返回干净的书签数组。
 *
 * <p>刻意**不抛异常**：用户挑的是一个自己从别处导出的文件，格式不对是常事。
 * 一律降级成「能认几条认几条 + 一句人话」，让界面照常用。
 *
 * @param {string} text 文件内容
 * @returns {{items:Array<{url:string,title:string,favicon?:string}>, skipped:number, reason:string}}
 */
function parseImport(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { items: [], skipped: 0, reason: '文件是空的' };

  const trimmed = raw.trim();
  // 先按自家 JSON 试；不像 JSON 再走 HTML。
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data;
    try { data = JSON.parse(trimmed); } catch (e) {
      return { items: [], skipped: 0, reason: '这个 JSON 解析不了：' + e.message };
    }
    const arr = Array.isArray(data) ? data : (data && data.bookmarks);
    if (!Array.isArray(arr)) {
      return { items: [], skipped: 0, reason: '这个 JSON 里没有书签列表' };
    }
    return normalize(arr);
  }
  if (/<A\s/i.test(trimmed) || /<!DOCTYPE\s+HTML/i.test(trimmed) || /<DT>/i.test(trimmed)) {
    const parsed = normalize(parseNetscapeHtml(trimmed));
    if (!parsed.items.length) {
      // **认得出来是 HTML，但里面一条书签都没有** —— 这种情况必须报错。
      // 静默返回 0 条的话，界面上会显示「导入成功」，而用户挑的其实是
      // 一个书签导出的页面（比如直接给了个空白模板），于是他以为书签没了。
      return {
        items: [],
        skipped: 0,
        reason: '这个 HTML 里没找到书签条目 —— 确认一下是不是导出的那份文件'
      };
    }
    return parsed;
  }
  return { items: [], skipped: 0, reason: '认不出这个文件的格式（支持自家 JSON 与浏览器导出的 HTML）' };
}

/** Netscape Bookmark File 里的 `<A HREF="…">标题</A>`。 */
function parseNetscapeHtml(html) {
  const out = [];
  // 之所以不用 DOMParser：渲染进程里有，主进程里没有，
  // 而这段逻辑要与其它纯逻辑一样能离线单测。
  const re = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = decodeEntities(m[2] || m[3] || m[4] || '');
    if (!url) continue;
    // 标题里可能有 &amp; 之类，也可能带标签（Chrome 有时塞 <b>）
    let title = m[5] || '';
    title = title.replace(/<[^>]*>/g, '');
    title = decodeEntities(title).trim();
    out.push({ url: url.trim(), title });
  }
  return out;
}

/** 解 HTML 实体：只认常见的几个，不是全表。 */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/**
 * 清洗 + 去重。
 *
 * <p>去重按<b>完整 URL</b>，而导入这一层刻意不做按主机名的去重：
 * 用户从别的浏览器搬过来的书签里，同一家常常有若干条不同路径
 * （知乎的问题页、专栏页），那是他们真的收过的，替他删掉就是替他做决定。
 * 真正的「一家只留一条」只适用于新标签页那 7 格磁贴（有版面约束）。
 *
 * @param {Array} arr
 */
function normalize(arr) {
  const seen = new Set();
  const items = [];
  let skipped = 0;
  for (const b of arr) {
    if (!b || typeof b !== 'object') { skipped++; continue; }
    const url = String(b.url || '').trim();
    if (!importable(url)) { skipped++; continue; }
    const key = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    const o = { url, title: String(b.title || '').trim() || url };
    if (b.favicon) o.favicon = String(b.favicon);
    items.push(o);
  }
  return { items, skipped, reason: skipped ? `跳过 ${skipped} 条（重复或不是网址）` : '' };
}

/**
 * 合并到现有书签里。
 *
 * @param {Array} existing 现有的
 * @param {Array} incoming 导入的
 * @returns {{merged:Array, added:number, dup:number, skipped:number}}
 *   merged 是**新的完整列表**，调用方负责写回。
 *
 * <p>已在的条目<b>不覆盖标题</b>：用户在本地改过的名字是ta自己的劳动，
 * 导入不该把它悄悄换回旧的名字（而地址也一样，重复就是重复）。
 */
function merge(existing, incoming) {
  const base = (existing || []).filter((b) => b && b.url);
  const key = (u) => String(u).replace(/\/+$/, '').toLowerCase();
  const seen = new Set(base.map((b) => key(b.url)));
  let added = 0;
  let dup = 0;
  let skipped = 0;
  for (const b of incoming || []) {
    if (!b || !b.url) { skipped++; continue; }
    const k = key(b.url);
    if (seen.has(k)) { dup++; continue; }
    seen.add(k);
    added++;
    base.push(b);
  }
  return { merged: base, added, dup, skipped };
}

module.exports = { FORMAT, FORMAT_VERSION, buildExport, parseImport, parseNetscapeHtml, normalize, merge };