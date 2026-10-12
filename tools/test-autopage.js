'use strict';

/**
 * 自动拼页测试（真实 DOM，jsdom）
 * 用法：node tools/test-autopage.js
 *
 * 这一层把注入脚本原样 eval 进 jsdom，再用一个 fetch 桩喂下一页的 HTML，
 * 一页页把整条链路走完：找下一页 → 取回 → 找正文容器 → 绝对化地址 →
 * 剔除翻页控件 → 去重 → 追加 → 推进下一页地址 → 到底收工。
 *
 * 关键在于测的就是注入页面执行的那份源码 —— autopage.js 里的算法是顶层函数
 * 声明，buildScript() 用 Function.prototype.toString() 原样取出来拼进脚本，
 * 所以不存在「测试版本和行为版本是两份代码」的老问题。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

function loadJsdom() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules'),
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules')
  ];
  for (const dir of candidates) {
    const p = path.join(dir, 'jsdom');
    if (fs.existsSync(p)) return require(p);
  }
  try { return require('jsdom'); } catch { /* 继续 */ }
  console.error('\n缺少 jsdom（仅测试需要）。装法见 README。\n');
  process.exit(2);
}
const { JSDOM } = loadJsdom();

const AP = require(path.join(__dirname, '..', 'src', 'renderer', 'autopage.js'));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个 jsdom 文档。runScripts:'outside-only' 允许 window.eval，但不跑页面自带脚本 */
function doc(html, url) {
  return new JSDOM(html, { url: url || 'https://ex.com/art/1.html', runScripts: 'outside-only' });
}

/** 把注入脚本装进文档，并接好 fetch 桩 */
function install(dom, pages, opts) {
  const w = dom.window;
  w.fetch = async (u) => {
    const key = String(u);
    if (!(key in pages)) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => pages[key] };
  };
  w.eval(AP.buildScript(Object.assign({ delay: 0, manual: true }, opts || {})));
  return w.__novaAutoPage;
}

/** 正文块：足够长才过得了内容根的最小长度门槛 */
const body = (tag, n) => `<p>${tag.repeat(n)}</p>`;

function page(n, links, extra) {
  return `<!doctype html><html><head><title>第${n}页</title>${links.head || ''}</head><body>
<div id="outer"><header>站点页头</header>
<div class="article-content">
  <h1>第 ${n} 章</h1>
  ${body('正', 300)}
  ${extra || ''}
  <div class="pagination">${links.pager || ''}</div>
</div>
<footer>站点页脚</footer></div></body></html>`;
}

/* ================================================================== */

(async () => {
  console.log('\n[A] 找下一页');

  {
    const d = doc(page(1, { head: '<link rel="next" href="/art/2.html">', pager: '<a href="/art/9.html">下一页</a>' }));
    const r = AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html');
    check('link rel=next 优先于锚文本', r && r.url === 'https://ex.com/art/2.html', r && r.url);
    check('标出来源是 link-rel', r && r.basis === 'link-rel', r && r.basis);
    d.window.close();
  }

  {
    const d = doc(page(1, { pager: '<a rel="next" href="/art/2.html">继续</a>' }));
    const r = AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html');
    check('a rel=next 认', r && r.url === 'https://ex.com/art/2.html', r && r.url);
    check('标出来源是 a-rel', r && r.basis === 'a-rel', r && r.basis);
    d.window.close();
  }

  {
    const d = doc(page(1, { pager: '<a href="/art/2.html">下一页</a>' }));
    const r = AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html');
    check('锚文本「下一页」认', r && r.url === 'https://ex.com/art/2.html', r && r.url);
    check('标出来源是 text', r && r.basis === 'text', r && r.basis);
    d.window.close();
  }

  {
    const d = doc(page(1, { pager: '<a href="/art/2.html">Next</a><a href="/art/3.html">末页</a>' }));
    const r = AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html');
    check('英文 Next 认', r && r.url === 'https://ex.com/art/2.html', r && r.url);
    d.window.close();
  }

  {
    // 锚文本不认得，只剩 class 名这条线索
    const d = doc(page(1, { pager: '<a class="page-next" href="/art/2.html">继续阅读</a>' }));
    const r = AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html');
    check('class 名兜底认得出来', r && r.url === 'https://ex.com/art/2.html', r && r.url);
    check('标出来源是 class', r && r.basis === 'class', r && r.basis);
    d.window.close();
  }

  {
    const d = doc(page(1, { pager: '<a class="page-next" href="/art/2.html">›</a>' }));
    const r = AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html');
    check('纯符号箭头也认（走锚文本那条）', r && r.url === 'https://ex.com/art/2.html', r && r.url);
    d.window.close();
  }

  {
    const d = doc(page(1, {
      pager: '<a class="next" href="/art/8.html">随便什么</a><a href="/art/2.html">下一页</a>'
    }));
    const r = AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html');
    check('锚文本优先于 class（class 最容易误伤）', r && r.url === 'https://ex.com/art/2.html', r && r.url);
    d.window.close();
  }

  {
    const d = doc(page(1, { pager: '<a href="javascript:void(0)">下一页</a>' }));
    check('javascript: 伪链接不认', AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html') === null);
    d.window.close();
  }

  {
    const d = doc(page(1, { pager: '<a href="#top">下一页</a>' }));
    check('纯锚点不认', AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html') === null);
    d.window.close();
  }

  {
    const d = doc(page(1, { pager: '<a href="/art/1.html">下一页</a>' }));
    check('指回当前页的不认（否则原地打转）',
          AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html') === null);
    d.window.close();
  }

  {
    const d = doc(page(1, { pager: '<a href="/art/1.html#part2">下一页</a>' }));
    check('只差 hash 的也算同一页，不认',
          AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html') === null);
    d.window.close();
  }

  {
    const d = doc(page(1, { pager: '<a href="/art/0.html">上一页</a><a href="/art/1.html">首页</a>' }));
    check('只有上一页时返回 null（不瞎猜）',
          AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html') === null);
    d.window.close();
  }

  {
    const d = doc(page(1, { pager: '<a href="/art/2.html" title="下一页">›</a>' }));
    const r = AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html');
    check('title 属性也认', r && r.url === 'https://ex.com/art/2.html', r && r.url);
    d.window.close();
  }

  {
    const d = doc(page(1, { pager: '<a href="/art/2.html" aria-label="下一页">›</a>' }));
    const r = AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html');
    check('aria-label 也认', r && r.url === 'https://ex.com/art/2.html', r && r.url);
    d.window.close();
  }

  {
    const d = doc(page(1, { head: '<base href="https://cdn.ex.com/mirror/">', pager: '<a href="p2.html">下一页</a>' }));
    const r = AP.novaPickNextUrl(d.window.document, 'https://ex.com/art/1.html');
    check('相对地址按传入的 base 解析（不是按 <base> 标签）',
          r && r.url === 'https://ex.com/art/p2.html', r && r.url);
    d.window.close();
  }

  /* ---------------- */

  console.log('\n[B] 地址绝对化');

  {
    const d = doc(`<div id="r">
      <a href="/a/b">链接</a>
      <img src="pic.png">
      <img src="https://cdn.x.com/abs.png">
      <img src="data:image/gif;base64,AAA">
      <source srcset="/s1.png 1x, /s2.png 2x">
      <img data-src="/lazy.jpg">
    </div>`, 'https://ex.com/art/1.html');
    const w = d.window;
    const root = w.document.querySelector('#r');
    const n = AP.novaAbsolutize(root, 'https://ex.com/art/sub/page.html');

    check('返回改写的条数', n > 0, String(n));
    // base 是 /art/sub/page.html：以 / 开头的是站根绝对路径，不带斜杠的才是相对
    check('a href 站根绝对路径 → 带域名',
          root.querySelector('a').getAttribute('href') === 'https://ex.com/a/b',
          root.querySelector('a').getAttribute('href'));
    check('img src 相对路径 → 按 base 目录解析',
          root.querySelectorAll('img')[0].getAttribute('src') === 'https://ex.com/art/sub/pic.png',
          root.querySelectorAll('img')[0].getAttribute('src'));
    check('已是绝对的保持不动',
          root.querySelectorAll('img')[1].getAttribute('src') === 'https://cdn.x.com/abs.png');
    check('data: 协议不动',
          root.querySelectorAll('img')[2].getAttribute('src') === 'data:image/gif;base64,AAA');
    check('srcset 两个候选都绝对化',
          root.querySelector('source').getAttribute('srcset') === 'https://ex.com/s1.png 1x, https://ex.com/s2.png 2x',
          root.querySelector('source').getAttribute('srcset'));
    check('data-src 懒加载提升为 src',
          root.querySelector('img[data-src]').getAttribute('src') === 'https://ex.com/lazy.jpg',
          root.querySelector('img[data-src]').getAttribute('src'));
    d.window.close();
  }

  {
    // 已经有真 src 的不要再被 data-src 顶掉
    const d = doc('<div id="r"><img src="/real.png" data-src="/fake.png"></div>', 'https://ex.com/');
    const root = d.window.document.querySelector('#r');
    AP.novaAbsolutize(root, 'https://ex.com/');
    check('已有真 src 时不覆盖',
          root.querySelector('img').getAttribute('src') === 'https://ex.com/real.png',
          root.querySelector('img').getAttribute('src'));
    d.window.close();
  }

  {
    const d = doc('<div id="r"><a>没有 href</a></div>', 'https://ex.com/');
    check('没有 href 的属性不炸', AP.novaAbsolutize(d.window.document.querySelector('#r'), 'https://ex.com/') === 0);
    d.window.close();
  }

  /* ---------------- */

  console.log('\n[C] 正文容器');

  {
    const d = doc(`<body>
      <div id="comments"><p>${'评'.repeat(400)}</p></div>
      <article><p>${'正'.repeat(300)}</p></article>
    </body>`, 'https://ex.com/');
    const r = AP.novaPickContentRoot(d.window.document);
    check('article 压过评论区长文', r && r.tagName === 'ARTICLE', r && r.tagName);
    d.window.close();
  }

  {
    const d = doc(`<body>
      <div class="article-content"><p>${'正'.repeat(300)}</p></div>
      <div class="comment-block"><p>${'评'.repeat(300)}</p></div>
    </body>`, 'https://ex.com/');
    const r = AP.novaPickContentRoot(d.window.document);
    check('同长度时正文类名胜出',
          r && /article-content/.test(r.className), r && r.className);
    d.window.close();
  }

  {
    const d = doc(`<body><div class="list">${
      Array.from({ length: 30 }, (_, i) => `<a href="/x/${i}">这是第 ${i} 条链接标题文字</a>`).join('')
    }</div></body>`, 'https://ex.com/');
    check('链接占比过半的列表页不选（否则会把目录拼成正文）',
          AP.novaPickContentRoot(d.window.document) === null);
    d.window.close();
  }

  {
    const d = doc(`<body><div class="article-content"><p>太短了</p></div></body>`, 'https://ex.com/');
    check('正文过短不选', AP.novaPickContentRoot(d.window.document) === null);
    d.window.close();
  }

  {
    const d = doc(`<body>
      <div id="sidebar"><p>${'边'.repeat(500)}</p></div>
      <div class="story-body"><p>${'故'.repeat(260)}</p></div>
    </body>`, 'https://ex.com/');
    const r = AP.novaPickContentRoot(d.window.document);
    check('侧栏被罚分后正文胜出', r && /story-body/.test(r.className), r && r.className);
    d.window.close();
  }

  /* ---------------- */

  console.log('\n[D] 选择器路径往返');

  {
    const d = doc(`<body><div id="outer"><div><section class="c"><p>${'正'.repeat(300)}</p></section></div></div></body>`, 'https://ex.com/');
    const w = d.window;
    const el = w.document.querySelector('section.c');
    const p = AP.novaSelectorPath(el);
    check('路径以 id 收口（id 比 nth-of-type 稳得多）', p.startsWith('#outer'), p);
    check('路径能找回原元素', AP.novaFindByPath(w.document, p) === el);
    d.window.close();
  }

  {
    const d = doc('<body><div><div><div><p>x</p></div></div></div></body>', 'https://ex.com/');
    const w = d.window;
    const el = w.document.querySelectorAll('div')[2];
    const p = AP.novaSelectorPath(el);
    check('没有 id 时退化为 nth-of-type', /nth-of-type/.test(p), p);
    check('无 id 路径也能往返', AP.novaFindByPath(w.document, p) === el);
    check('畸形路径返回 null 而不是抛异常', AP.novaFindByPath(w.document, '>>>') === null);
    check('空路径返回 null', AP.novaFindByPath(w.document, '') === null);
    d.window.close();
  }

  /* ---------------- */

  console.log('\n[E] 翻页控件剔除与去重');

  {
    const d = doc(`<div id="r">
      <div class="pagination"><a href="/2">下一页</a></div>
      <div class="page-nav">导航</div>
      <div class="pagebar">分页</div>
      <p id="keep">正文</p>
    </div>`, 'https://ex.com/');
    const w = d.window;
    const removed = AP.novaStripPager(w.document.querySelector('#r'));
    check('剔除了分页控件', removed === 3, String(removed));
    check('正文留下', !!w.document.querySelector('#keep'));
    check('pagination 没了', !w.document.querySelector('.pagination'));
    d.window.close();
  }

  {
    const d = doc('<div id="r"><div class="post-nav">文章导航</div><p id="keep2">正文</p></div>', 'https://ex.com/');
    const w = d.window;
    check('post-nav 不在剔除名单里（那是文章导航，不是翻页控件）',
          AP.novaStripPager(w.document.querySelector('#r')) === 0);
    check('post-nav 确实留下了', !!w.document.querySelector('.post-nav'));
    d.window.close();
  }

  {
    const d = doc(`<body><div id="t"><div id="a"><p>${'同'.repeat(60)}</p></div><div id="b"><p>短</p></div></div></body>`, 'https://ex.com/');
    const w = d.window;
    // seen 先塞进「已经拼过的」那段，模拟第二页开头把上页结尾又贴了一遍的情形
    const seen = new Set([AP.novaFingerprint(w.document.querySelector('#a'))]);
    const src = w.document.createElement('div');
    src.innerHTML = `<div id="a2"><p>${'同'.repeat(60)}</p></div><div id="c"><p>${'新'.repeat(60)}</p></div>`;
    const added = AP.novaAppendChunk(w.document.querySelector('#t'), src, 2, seen);
    check('长重复段落被跳过，新内容照加', added === 1, String(added));
    check('重复的那段没进 DOM', !w.document.querySelector('#a2'));
    check('新的那段进了 DOM', !!w.document.querySelector('#c'));
    d.window.close();
  }

  {
    const d = doc('<body><div id="t"></div></body>', 'https://ex.com/');
    const w = d.window;
    const seen = new Set();
    const src = w.document.createElement('div');
    src.innerHTML = '<div><p>短</p></div><div><p>也短</p></div>';
    const added = AP.novaAppendChunk(w.document.querySelector('#t'), src, 2, seen);
    check('短文本不参与去重（否则列表项会被误删）', added === 2, String(added));
    check('去重集合没被短文本塞满', seen.size === 0, String(seen.size));
    d.window.close();
  }

  {
    const d = doc('<body><div id="t"></div></body>', 'https://ex.com/');
    const w = d.window;
    const src = w.document.createElement('div');
    const added = AP.novaAppendChunk(w.document.querySelector('#t'), src, 3, new Set());
    check('空容器返回 0（调用方据此报「没有可接的内容」）', added === 0);
    check('空容器不往 DOM 里塞空壳', w.document.querySelectorAll('[data-nova-chunk]').length === 0);
    d.window.close();
  }

  {
    const d = doc('<body><div id="t"></div></body>', 'https://ex.com/');
    const w = d.window;
    const src = w.document.createElement('div');
    src.innerHTML = '<p>内容一</p>';
    AP.novaAppendChunk(w.document.querySelector('#t'), src, 2, new Set());
    const chunk = w.document.querySelector('[data-nova-chunk]');
    check('每页包一层容器（撤销时好整体摘掉）', !!chunk);
    check('容器上标了页码', chunk.getAttribute('data-nova-chunk') === '2');
    check('带一条分页分隔线', !!chunk.querySelector('[data-nova-divider]'));
    check('分隔线写的是第几页', /第 2 页/.test(chunk.querySelector('[data-nova-divider]').textContent));
    d.window.close();
  }

  /* ---------------- */

  console.log('\n[F] 端到端：注入脚本');

  const P1 = page(1, { pager: '<a class="next" href="/art/2.html">下一页</a>' });
  const P2 = page(2, { pager: '<a class="next" href="/art/3.html">下一页</a>', }, '<img data-src="/img/p2.jpg">');
  const P3 = page(3, {});

  const PAGES = {
    'https://ex.com/art/2.html': P2,
    'https://ex.com/art/3.html': P3
  };

  {
    const d = doc(P1, 'https://ex.com/art/1.html');
    const A = install(d, PAGES);
    const w = d.window;

    check('注入后挂上了接口', A && typeof A.step === 'function' && typeof A.status === 'function');
    check('版本号一致', A.v === AP.SCRIPT_VERSION, String(A.v));

    await sleep(10);
    const s0 = A.status();
    check('boot 找到了下一页', s0.hasNext === true, s0.nextUrl);
    check('boot 后处于运行态', s0.running === true);
    check('boot 时一页都没拼', s0.pages === 0);
    check('boot 认出了正文容器', !!s0.rootPath, s0.rootPath);
    check('boot 阶段不挂状态条（安静优先）', w.document.querySelector('[data-nova-autopage]') === null);

    const ok1 = await A.step();
    check('第 2 页拼上了', ok1 === true);
    check('页数变成 1', A.status().pages === 1);
    check('下一页地址推进到第 3 页', A.status().nextUrl === 'https://ex.com/art/3.html', A.status().nextUrl);
    check('第 2 页确实在 DOM 里', w.document.body.innerHTML.includes('第 2 章'));
    check('拼上后状态条出现了', !!w.document.querySelector('[data-nova-autopage]'));
    check('状态条上有「停止」', !!w.document.querySelector('[data-nova-bar-stop]'));
    check('状态条上有「撤销」', !!w.document.querySelector('[data-nova-bar-undo]'));
    check('状态条文案报了页数', /已拼接 1 页/.test(w.document.querySelector('[data-nova-bar-label]').textContent),
          w.document.querySelector('[data-nova-bar-label]').textContent);
    // 结构性不变量：只写 left:50% 的绝对定位元素，shrink-to-fit 可用宽度只剩一半视口，
    // 标签会被压到约 195px 并截成「自动拼页 · 已拼…」。max-width 是上限，救不了这个下限。
    // jsdom 不做真实排版，量不出宽度，所以只能锁住「必须声明 width:max-content」这一条。
    check('状态条声明了 width:max-content（否则 left:50% 会把标签截断）',
          /width:\s*max-content/.test(w.document.querySelector('[data-nova-autopage]').getAttribute('style') || ''),
          w.document.querySelector('[data-nova-autopage]').getAttribute('style'));

    const ok2 = await A.step();
    check('第 3 页拼上了', ok2 === true);
    check('页数变成 2', A.status().pages === 2);
    check('第 3 页没有下一页 → 地址清空', A.status().nextUrl === '', A.status().nextUrl);
    check('如实报「已拼完」', /已拼完/.test(A.status().finished), A.status().finished);
    check('第 3 页确实在 DOM 里', w.document.body.innerHTML.includes('第 3 章'));

    const more = await A.step();
    check('到底之后再 step 直接返回 false，不会重复取', more === false);
    check('页数没被多算', A.status().pages === 2);

    // 拼进来的内容要能用：相对地址已绝对化、懒加载已提升、翻页控件已剔除
    const img = w.document.querySelector('[data-nova-chunk] img');
    check('拼进来的图片地址已绝对化',
          img && img.getAttribute('src') === 'https://ex.com/img/p2.jpg',
          img && img.getAttribute('src'));
    check('拼进来的分页控件被剔除了',
          w.document.querySelectorAll('[data-nova-chunk] .pagination').length === 0);
    check('拼进来两块容器（两页各一）',
          w.document.querySelectorAll('[data-nova-chunk]').length === 2);

    // 撤销
    A.undo();
    check('撤销后拼进来的东西全没了', w.document.querySelectorAll('[data-nova-chunk]').length === 0);
    check('撤销后页数归零', A.status().pages === 0);
    check('撤销后回到第一页的下一页地址',
          A.status().nextUrl === 'https://ex.com/art/2.html', A.status().nextUrl);
    check('撤销后可以重新开始拼', A.status().hasNext === true && A.status().error === '');

    const again = await A.step();
    check('撤销后确实能再拼一次', again === true && A.status().pages === 1, String(A.status().pages));

    d.window.close();
  }

  {
    const d = doc(P1, 'https://ex.com/art/1.html');
    const A = install(d, PAGES);
    await sleep(10);
    check('同一文档二次注入是幂等的', d.window.eval(AP.buildScript({ delay: 0 })) === 'autopage:already-on');
    check('二次注入没把状态冲掉', A.status().pages === 0 && A.status().hasNext === true);
    d.window.close();
  }

  {
    const d = doc(page(1, {}), 'https://ex.com/art/1.html');
    const A = install(d, {});
    await sleep(10);
    check('没有下一页时不进入运行态', A.status().running === false);
    check('没有下一页时状态条完全不出现', d.window.document.querySelector('[data-nova-autopage]') === null);
    check('没有下一页时下一个地址为空', A.status().hasNext === false);
    check('没有下一页时 step 直接返回 false', (await A.step()) === false);
    d.window.close();
  }

  {
    // 「下一页」绕回第一页：必须收敛，不能无限取
    const LOOP = page(1, { pager: '<a class="next" href="/art/2.html">下一页</a>' });
    const LOOP2 = page(2, { pager: '<a class="next" href="/art/1.html">下一页</a>' });
    const d = doc(LOOP, 'https://ex.com/art/1.html');
    const A = install(d, { 'https://ex.com/art/2.html': LOOP2, 'https://ex.com/art/1.html': LOOP });
    await sleep(10);
    await A.step();
    await A.step();
    check('成环时能收敛（不会把第一页再取一遍）', A.status().pages === 1, String(A.status().pages));
    check('成环时下一个地址被清空', A.status().nextUrl === '', A.status().nextUrl);
    d.window.close();
  }

  {
    // 上限封顶：链上有 5 页，但只允许拼 2 页
    const chain = {};
    for (let i = 2; i <= 6; i++) {
      chain[`https://ex.com/art/${i}.html`] = page(i, { pager: `<a class="next" href="/art/${i + 1}.html">下一页</a>` });
    }
    chain['https://ex.com/art/7.html'] = page(7, {});
    const d = doc(P1, 'https://ex.com/art/1.html');
    const A = install(d, chain, { maxPages: 2 });
    await sleep(10);
    check('配置传进去了', A.config.maxPages === 2);
    await A.step();
    await A.step();
    check('拼到上限就停', A.status().pages === 2, String(A.status().pages));
    const over = await A.step();
    check('超过上限后 step 返回 false', over === false);
    check('如实说明是被上限拦住的（不是「拼完了」）',
          /上限/.test(A.status().finished), A.status().finished);
    d.window.close();
  }

  {
    // 下一页 404：要如实报错并停下，不能静默失败
    const d = doc(P1, 'https://ex.com/art/1.html');
    const A = install(d, {});   // 桩里什么都没有 → 404
    await sleep(10);
    const ok = await A.step();
    check('取不到下一页时 step 返回 false', ok === false);
    check('错误信息带上了 HTTP 状态', /HTTP 404/.test(A.status().error), A.status().error);
    check('出事后清空地址，不会无限重试', A.status().nextUrl === '', A.status().nextUrl);
    check('出事后状态条上如实报了失败',
          /拼页失败/.test(d.window.document.querySelector('[data-nova-bar-label]').textContent));
    d.window.close();
  }

  {
    // 下一页取回来但正文容器找不到
    const d = doc(P1, 'https://ex.com/art/1.html');
    const A = install(d, { 'https://ex.com/art/2.html': '<html><body><p>空</p></body></html>' });
    await sleep(10);
    await A.step();
    check('找不到正文容器时如实报错', /正文容器/.test(A.status().error), A.status().error);
    d.window.close();
  }

  {
    // 跨页结构一致时，正文容器路径要能复用（否则每页都在重新猜）
    const d = doc(P1, 'https://ex.com/art/1.html');
    const A = install(d, PAGES);
    await sleep(10);
    const path0 = A.status().rootPath;
    await A.step();
    check('跨页复用同一个正文容器路径', A.status().rootPath === path0, A.status().rootPath);
    d.window.close();
  }

  {
    // 手动模式：不挂滚动监听，只留接口
    const d = doc(P1, 'https://ex.com/art/1.html');
    const A = install(d, PAGES, { manual: true });
    await sleep(10);
    check('手动模式仍能认出下一页', A.status().hasNext === true);
    check('手动模式下 check() 不会自己动手（还没滚到底的判定也照样安全）', (() => {
      A.check(null);
      return A.status().pages === 0;
    })());
    d.window.close();
  }

  {
    // stop() 之后不再拼
    const d = doc(P1, 'https://ex.com/art/1.html');
    const A = install(d, PAGES);
    await sleep(10);
    A.stop();
    check('停止后 step 不动手', (await A.step()) === false);
    check('停止后如实报页数', /已停止/.test(A.status().finished), A.status().finished);
    d.window.close();
  }

  d_count();
})();

function d_count() {
  console.log(`\n自动拼页测试：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）\n`);
  process.exit(fail ? 1 : 0);
}
