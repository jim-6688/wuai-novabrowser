/* 吾爱Nova浏览器 · 移动版自动拼页注入脚本
 * 本文件由 npm run mobile:sync 从 src/renderer/autopage.js 生成，**不要手改**。
 * 生成方式：require 那个模块 → 调 buildScript({}) → 原样落盘。
 * 源脚本版本：SCRIPT_VERSION = 3
 */
(function () {
  var OPTS = {"maxPages":10,"gap":900,"delay":600,"manual":false};
  var VERSION = 3;

  if (window.__novaAutoPage && window.__novaAutoPage.v === VERSION) return 'autopage:already-on';

function novaAbs(url, base) {
  try { return new URL(url, base).href; } catch (e) { return url; }
}

function novaAbsolutize(root, baseUrl) {
  if (!root || !root.querySelectorAll) return 0;
  var n = 0;
  var i, j, els, v;

  var PAIRS = [
    ['a', 'href'], ['area', 'href'], ['img', 'src'], ['source', 'src'],
    ['video', 'src'], ['video', 'poster'], ['audio', 'src'], ['iframe', 'src'],
    ['embed', 'src'], ['track', 'src'], ['link', 'href'], ['form', 'action']
  ];
  var SKIP = /^(https?:|data:|blob:|mailto:|tel:|javascript:|#)/i;

  for (i = 0; i < PAIRS.length; i++) {
    els = root.querySelectorAll(PAIRS[i][0] + '[' + PAIRS[i][1] + ']');
    for (j = 0; j < els.length; j++) {
      v = els[j].getAttribute(PAIRS[i][1]);
      if (!v || SKIP.test(v.trim())) continue;
      els[j].setAttribute(PAIRS[i][1], novaAbs(v, baseUrl));
      n++;
    }
  }

  // 懒加载：data-src / data-original / data-lazy-src → src
  els = root.querySelectorAll('img[data-src],img[data-original],img[data-lazy-src],img[data-echo]');
  for (j = 0; j < els.length; j++) {
    var cur = els[j].getAttribute('src') || '';
    if (cur && !/^data:/i.test(cur)) continue;   // 已经有真 src，别动它
    var lazy = els[j].getAttribute('data-src')
      || els[j].getAttribute('data-original')
      || els[j].getAttribute('data-lazy-src')
      || els[j].getAttribute('data-echo');
    if (lazy) { els[j].setAttribute('src', novaAbs(lazy, baseUrl)); n++; }
  }

  // srcset 是逗号分隔的「地址 描述符」列表，得逐个换
  els = root.querySelectorAll('[srcset]');
  for (j = 0; j < els.length; j++) {
    var raw = els[j].getAttribute('srcset') || '';
    if (!raw.trim()) continue;
    var out = raw.split(',').map(function (part) {
      var seg = part.trim();
      if (!seg) return '';
      var sp = seg.split(/\s+/);
      if (!SKIP.test(sp[0])) sp[0] = novaAbs(sp[0], baseUrl);
      return sp.join(' ');
    }).filter(Boolean).join(', ');
    if (out !== raw) { els[j].setAttribute('srcset', out); n++; }
  }

  return n;
}

function novaSelectorPath(el) {
  var parts = [];
  var cur = el;
  var guard = 0;
  while (cur && cur.nodeType === 1 && guard++ < 40) {
    var owner = cur.ownerDocument;
    if (owner && cur === owner.documentElement) break;
    var id = cur.id;
    if (id && /^[A-Za-z][\w-]*$/.test(id)) {
      parts.unshift('#' + id);
      break;
    }
    var tag = cur.tagName.toLowerCase();
    var parent = cur.parentElement;
    if (!parent) { parts.unshift(tag); break; }
    var idx = 1;
    var sib = cur;
    while ((sib = sib.previousElementSibling)) {
      if (sib.tagName === cur.tagName) idx++;
    }
    parts.unshift(tag + ':nth-of-type(' + idx + ')');
    cur = parent;
  }
  return parts.join(' > ');
}

function novaFindByPath(doc, path) {
  if (!path) return null;
  try { return doc.querySelector(path) || null; } catch (e) { return null; }
}

function novaPickContentRoot(doc) {
  var HINT = /(article|content|post|entry|chapter|read|detail|story|main|text|body)/i;
  var BAD = /(comment|sidebar|side-bar|foot|header|\bnav\b|menu|share|related|recommend|advert|\bads?\b|banner|toolbar|crumb)/i;

  var nodes = doc.querySelectorAll('article, main, section, div, td');
  var best = null;
  var bestScore = 0;

  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var text = el.textContent || '';
    var len = text.replace(/\s+/g, '').length;
    if (len < 200) continue;

    var linkLen = 0;
    var as = el.querySelectorAll('a');
    for (var k = 0; k < as.length; k++) linkLen += (as[k].textContent || '').length;
    var density = linkLen / len;
    if (density > 0.5) continue;

    var tag = el.tagName.toLowerCase();
    var cls = typeof el.className === 'string' ? el.className : '';
    var sig = tag + ' ' + (el.id || '') + ' ' + cls;

    var s = len;
    if (tag === 'article') s *= 1.6;
    else if (tag === 'main') s *= 1.3;
    if (HINT.test(sig)) s *= 1.4;
    if (BAD.test(sig)) s *= 0.2;
    s *= (1 - density);

    if (s > bestScore) { bestScore = s; best = el; }
  }
  return best;
}

function novaStripPager(root) {
  if (!root || !root.querySelectorAll) return 0;
  var RE = /(^|[\s_-])(pagination|pager|page-nav|pagenav|pagebar|page-bar|pagelist|page-list|nextpage|next-page|pages)([\s_-]|$)/i;
  var els = root.querySelectorAll('[class],[id]');
  var removed = 0;
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var sig = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
    if (RE.test(sig) && el.parentNode) { el.parentNode.removeChild(el); removed++; }
  }
  return removed;
}

function novaFingerprint(el) {
  var t = ((el && el.textContent) || '').replace(/\s+/g, '');
  return t.slice(0, 120);
}

function novaPickNextUrl(doc, baseUrl) {
  var TEXT_RE = /^(下一页|下页|后一页|次页|下一章|下章|下一节|下节|next|nextpage|next\s*page|older|»|›|>>|→)$/i;
  var CLASS_RE = /(^|[\s_-])(next|nextpage|next-page|page-next|pager-next)([\s_-]|$)/i;
  var here = String(baseUrl).split('#')[0];

  function usable(href) {
    if (!href) return '';
    var h = String(href).trim();
    if (!h) return '';
    if (/^(javascript:|mailto:|tel:|#)/i.test(h)) return '';
    var abs = novaAbs(h, baseUrl);
    if (!/^https?:/i.test(abs)) return '';
    if (abs.split('#')[0] === here) return '';
    return abs;
  }

  var i, u, els;

  els = doc.querySelectorAll('link[rel~="next"]');
  for (i = 0; i < els.length; i++) {
    u = usable(els[i].getAttribute('href'));
    if (u) return { url: u, basis: 'link-rel' };
  }

  els = doc.querySelectorAll('a[rel~="next"]');
  for (i = 0; i < els.length; i++) {
    u = usable(els[i].getAttribute('href'));
    if (u) return { url: u, basis: 'a-rel' };
  }

  var byClass = '';
  var anchors = doc.querySelectorAll('a[href]');
  for (i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    u = usable(a.getAttribute('href'));
    if (!u) continue;
    var txt = (a.textContent || '').replace(/\s+/g, '');
    var aria = (a.getAttribute('aria-label') || '').replace(/\s+/g, '');
    var title = (a.getAttribute('title') || '').replace(/\s+/g, '');
    if (TEXT_RE.test(txt) || TEXT_RE.test(aria) || TEXT_RE.test(title)) {
      return { url: u, basis: 'text' };
    }
    if (!byClass) {
      var cls = typeof a.className === 'string' ? a.className : '';
      if (CLASS_RE.test(cls)) byClass = u;
    }
  }
  if (byClass) return { url: byClass, basis: 'class' };
  return null;
}

function novaNearBottom(target, gap) {
  var GAP = gap || 900;
  var se = document.scrollingElement || document.documentElement;
  if (se && se.scrollTop + se.clientHeight >= se.scrollHeight - GAP) return true;

  var el = target;
  var hops = 0;
  while (el && el.nodeType === 1 && hops++ < 12) {
    if (el.scrollHeight > el.clientHeight + 40
        && el.scrollTop + el.clientHeight >= el.scrollHeight - GAP) return true;
    el = el.parentElement;
  }
  return false;
}

function novaAppendChunk(target, sourceRoot, pageNo, seen) {
  var doc = target.ownerDocument;
  var chunk = doc.createElement('div');
  chunk.setAttribute('data-nova-chunk', String(pageNo));

  var divider = doc.createElement('div');
  divider.setAttribute('data-nova-divider', '1');
  divider.style.cssText = 'margin:22px 0 14px;border-top:1px dashed rgba(128,132,140,.45);'
    + 'text-align:center;font:600 12px/2.2 -apple-system,system-ui,"PingFang SC",sans-serif;'
    + 'color:#8b8f99;letter-spacing:.06em;';
  divider.textContent = '第 ' + pageNo + ' 页';
  chunk.appendChild(divider);

  var kids = [];
  for (var i = 0; i < sourceRoot.childNodes.length; i++) kids.push(sourceRoot.childNodes[i]);

  var added = 0;
  for (var j = 0; j < kids.length; j++) {
    var node = kids[j];
    if (node.nodeType !== 1) continue;
    if (node.hasAttribute && node.hasAttribute('data-nova-chunk')) continue;
    var fp = novaFingerprint(node);
    if (fp.length > 40) {
      if (seen.has(fp)) continue;
      if (seen.size < 200) seen.add(fp);
    }
    chunk.appendChild(doc.importNode(node, true));
    added++;
  }

  if (!added) return 0;
  target.appendChild(chunk);
  return added;
}

  var S = {
    running: false,
    stopped: false,
    loading: false,
    pages: 0,
    nextUrl: '',
    firstUrl: '',
    root: null,
    rootPath: '',
    seen: new Set(),
    visited: {},
    lastError: '',
    finished: ''
  };
  var bar = null;

  function norm(u) { try { return new URL(u).href; } catch (e) { return u; } }
  function label() { return bar && bar.querySelector('[data-nova-bar-label]'); }

  /* ---------- 状态条 ----------
     样式全部内联：页面自己的样式表里什么稀奇古怪的规则都有，用 !important
     去压不如干脆不带类名、只带内联样式来得稳。 */
  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.setAttribute('data-nova-autopage', '1');
    // width:max-content 不能省。只写 left:50% 时，绝对定位元素的 shrink-to-fit
    // 可用宽度 = 包含块宽 - left = 一半视口，标签会被压到 195px 并截成
    // 「自动拼页 · 已拼…」。max-width 只是上限，救不了下限。
    bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:70px;'
      + 'width:max-content;'
      + 'z-index:2147483647;display:none;align-items:center;gap:10px;padding:7px 8px 7px 14px;'
      + 'border-radius:999px;background:rgba(22,24,30,.94);color:#fff;'
      + 'font:600 13px/1 -apple-system,system-ui,"PingFang SC",sans-serif;'
      + 'box-shadow:0 8px 24px rgba(0,0,0,.34);max-width:86vw;';

    var lab = document.createElement('span');
    lab.setAttribute('data-nova-bar-label', '1');
    lab.style.cssText = 'flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    bar.appendChild(lab);

    var btnCss = 'flex:0 0 auto;border:0;border-radius:999px;padding:5px 11px;'
      + 'color:#fff;font:600 12px/1 inherit;cursor:pointer;';

    var stop = document.createElement('button');
    stop.setAttribute('data-nova-bar-stop', '1');
    stop.textContent = '停止';
    stop.style.cssText = btnCss + 'background:#4b4f59;';
    stop.addEventListener('click', function (e) { e.stopPropagation(); api.stop(); });

    var undo = document.createElement('button');
    undo.setAttribute('data-nova-bar-undo', '1');
    undo.textContent = '撤销';
    undo.style.cssText = btnCss + 'background:#2f323a;';
    undo.addEventListener('click', function (e) { e.stopPropagation(); api.undo(); });

    bar.appendChild(stop);
    bar.appendChild(undo);
    (document.body || document.documentElement).appendChild(bar);
    return bar;
  }

  /* ---------- 状态条重绘 ----------
     只改标签文字，绝不碰容器 —— 对容器写一次 textContent 就会把两个按钮
     一起抹掉。 */
  function paint() {
    if (!bar) return;
    var lab = label();
    if (!lab) return;

    var msg;
    if (S.lastError) msg = '拼页失败：' + S.lastError;
    else if (S.finished) msg = S.finished;
    else if (S.loading) msg = '正在拼接第 ' + (S.pages + 2) + ' 页…';
    else msg = '自动拼页 · 已拼接 ' + S.pages + ' 页';
    lab.textContent = msg;

    // 安静优先：一上来就挂个条子打扰人不好，等真拼了、出错了或正在拼才露面
    var show = !!S.lastError || S.pages > 0 || S.loading;
    bar.style.display = show ? 'flex' : 'none';
  }

  /* ---------- 主体流程 ---------- */
  function seedSeen() {
    if (!S.root) return;
    var kids = S.root.children || [];
    var from = Math.max(0, kids.length - 5);
    for (var i = from; i < kids.length; i++) {
      var fp = novaFingerprint(kids[i]);
      if (fp.length > 40 && S.seen.size < 200) S.seen.add(fp);
    }
  }

  function status() {
    return {
      v: VERSION,
      running: S.running,
      pages: S.pages,
      rootPath: S.rootPath,
      nextUrl: S.nextUrl,
      hasNext: !!S.nextUrl,
      loading: S.loading,
      error: S.lastError,
      finished: S.finished
    };
  }

  function step() {
    if (!S.nextUrl || S.loading || S.stopped) return Promise.resolve(false);
    if (S.pages >= OPTS.maxPages) {
      S.finished = '已拼到 ' + OPTS.maxPages + ' 页上限';
      paint();
      return Promise.resolve(false);
    }

    var target = S.nextUrl;
    S.loading = true;
    ensureBar();
    paint();

    return fetch(target, { credentials: 'include' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var baseEl = doc.querySelector('base[href]');
        var base = baseEl ? novaAbs(baseEl.getAttribute('href'), target) : target;

        var src = S.rootPath ? novaFindByPath(doc, S.rootPath) : null;
        if (!src) {
          src = novaPickContentRoot(doc);
          if (src) S.rootPath = novaSelectorPath(src);
        }
        if (!src) throw new Error('没找到正文容器');

        // 顺序不能反：翻页控件既是「要删掉的东西」，也是「下一页地址的来源」。
        // 先删再找，下一页链接就被自己删没了，拼到第二页必然断在这里。
        var next = novaPickNextUrl(doc, target);

        novaStripPager(src);
        novaAbsolutize(src, base);
        var added = novaAppendChunk(S.root, src, S.pages + 1, S.seen);
        if (!added) throw new Error('下一页没有可接的内容');

        S.pages += 1;
        S.visited[norm(target)] = true;

        S.nextUrl = (next && !S.visited[norm(next.url)]) ? next.url : '';
        if (!S.nextUrl) S.finished = '已拼完 · 共 ' + S.pages + ' 页';

        S.loading = false;
        S.lastError = '';
        paint();
        return true;
      })
      .catch(function (err) {
        S.loading = false;
        S.nextUrl = '';
        S.lastError = String((err && err.message) || err);
        paint();
        return false;
      });
  }

  function check(target) {
    if (S.stopped || S.loading || !S.nextUrl) return;
    if (!novaNearBottom(target, OPTS.gap)) return;
    step();
  }

  function stop() {
    S.stopped = true;
    S.running = false;
    S.finished = S.pages ? '已停止 · 共拼接 ' + S.pages + ' 页' : '已停止';
    if (bar) bar.style.display = 'none';
  }

  /** 撤销：把拼进来的整块摘掉，并回到第一页的状态，可以重新开始拼 */
  function undo() {
    var chunks = document.querySelectorAll('[data-nova-chunk]');
    for (var i = 0; i < chunks.length; i++) {
      if (chunks[i].parentNode) chunks[i].parentNode.removeChild(chunks[i]);
    }
    S.pages = 0;
    S.seen = new Set();
    S.visited = {};
    S.nextUrl = S.firstUrl;
    S.stopped = false;
    S.loading = false;
    S.lastError = '';
    S.finished = '';
    seedSeen();
    if (bar) bar.style.display = 'none';
  }

  var api = { v: VERSION, step: step, check: check, stop: stop, undo: undo, status: status, config: OPTS };
  window.__novaAutoPage = api;

  /* ---------- 启动 ---------- */
  function boot() {
    S.root = novaPickContentRoot(document);
    if (!S.root) { S.stopped = true; return; }
    S.rootPath = novaSelectorPath(S.root);
    seedSeen();

    // 当前页本身也算访问过。有些站点的「下一页」会绕回第一页，
    // 不把它记上就会多取一轮才发现是个环。
    S.visited[norm(location.href)] = true;

    var next = novaPickNextUrl(document, location.href);
    if (!next) { S.stopped = true; return; }   // 没有下一页 → 完全安静，不打扰

    S.nextUrl = next.url;
    S.firstUrl = next.url;
    S.running = true;

    if (OPTS.manual) return;   // 手动模式：只暴露接口，不自动触发

    window.addEventListener('scroll', function (ev) { check(ev.target); }, true);
    window.addEventListener('load', function () { setTimeout(function () { check(null); }, 200); });
    // 有些站点的正文在一个 overflow 容器里滚动，且高度变化不触发 scroll，
    // 所以再补一个低频轮询兜底 —— 900ms 的代价可以忽略。
    setInterval(function () { check(null); }, 900);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, OPTS.delay); });
  } else {
    setTimeout(boot, OPTS.delay);
  }

  return 'autopage:on';
})()