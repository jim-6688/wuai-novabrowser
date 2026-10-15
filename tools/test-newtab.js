'use strict';
/**
 * 内置新标签页测试
 * 用法：node tools/test-newtab.js
 *
 * 这一页有三层，测试也分三层：
 *   [A] 页面纯函数 —— 从 newtab.html 里把那段纯函数**抽出来**在 Node 里跑。
 *       排序规则（固定项在前、同主机去重、7 格上限）是最容易改错又最难肉眼
 *       发现的部分（少一个图标、顺序不对），必须有测试钉住。
 *   [B] 宿主侧纯函数 —— src/renderer/ntp.js，同文件也是外壳跑的那一份。
 *   [C] 两端契约 —— 页面发出去的 nova:// 命令，宿主侧必须能原样解开；
 *       宿主拼出去的 data 参数，页面必须能原样读回来。这两处各有一种
 *       很安静的编码坑（`+` 与 `%20`），所以真的走一遍往返。
 *   [D] 外壳接线 —— 真实 DOM（jsdom）里点档位按钮、看地址栏、发一条命令。
 *   [E] 跨端常量 —— 与 android-app 的 NewTab.java、assets 产物逐项对齐。
 *       改一边忘一边的表现是「手机上少了两个图标」，没人会为此开一个 issue。
 *   [F] 内置推荐位 —— 候选不足时补齐版面（宫格只剩两三个格子的那类问题），
 *       以及收藏夹拿同一份数据开张、老配置只补一次。
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
  console.error(
    '\n缺少 jsdom（仅测试需要，不影响浏览器运行）。任选一种安装方式：\n' +
    '  cd novabrowser && npm i -D jsdom\n' +
    '  # 或装到隔离运行区：\n' +
    `  cd "${path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace')}" && npm i jsdom\n`
  );
  process.exit(2);
}
const { JSDOM } = loadJsdom();

const root = path.join(__dirname, '..');
const P = (rel) => path.join(root, rel);

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const Ntp = require(P('src/renderer/ntp.js'));

/**
 * 把宿主拼出来的候选拆开看。
 *
 * 分两个桶是因为 buildData 的输出里混着两种东西：真实候选（历史 + 用户加的）
 * 与不足时补上的内置推荐位（flags 为 f）。测真实逻辑的断言只该看前者 ——
 * 混在一起数行数的话，以后内置清单增减一条，十几条断言要跟着改数字。
 */
const realRows = (d) => String(d || '').split('\n').filter((l) => l && l.slice(-1) !== 'f');
const padRows = (d) => String(d || '').split('\n').filter((l) => l && l.slice(-1) === 'f');

/* ---------------------------------------------------------------- 抽取工具 */

/**
 * 把 newtab.html 里的 <script> 块切出来（这一页刻意只有两段，都是内联的）。
 *
 * 必须先剥掉 HTML 注释：文件顶部那段说明里就写着「把下面的 <script> 抽出来
 * 在 Node 里跑」，不剥的话第一刀会从注释里那个 <script> 切起，切出来的
 * 「脚本」前半截是中文散文，new Function 直接语法错。
 */
function scriptBlocks() {
  const html = fs.readFileSync(P('src/renderer/newtab.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

/** 用 new Function 给一段源码塞一个 module 进去，取它的导出 */
function loadPageModule(src) {
  const box = { exports: {} };
  new Function('module', src)(box);
  return box.exports;
}

/**
 * 从源码里抠出一个顶层函数声明（含函数体）。
 *
 * 为什么要抠而不是重写一份：这段实现是页面真正在跑的那一段，重写一份就等于
 * 「测的是一份、跑的是另一份」。用花括号配对而不是正则收尾，是因为函数体里
 * 有嵌套的 if/for，非贪婪正则会在第一个 '}' 就收住。
 */
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, k + 1);
    }
  }
  return null;
}

/** 从 Java 源码里读一个常量：`public static final int FOO = 30;` */
function javaConst(src, type, name) {
  const re = new RegExp(`public static final\\s+${type}\\s+${name}\\s*=\\s*([^;]+);`);
  const m = src.match(re);
  return m ? m[1].trim() : null;
}

const blocks = scriptBlocks();
const pureSrc = blocks.find((b) => b.indexOf('var NovaNtp = (function') >= 0);
if (!pureSrc) {
  console.error('newtab.html 里找不到那段纯函数（var NovaNtp = (function …），测试没法继续');
  process.exit(2);
}
const Page = loadPageModule(pureSrc);

/** 抠出页面里那个 param() 并跑起来。它读的是 location.search + location.hash，
 *  所以塞一个假的 location 进去就行 —— 这样测的是页面真正跑的那一份。 */
function loadParam(url) {
  const mount = blocks.find((b) => b.indexOf('function param(name)') >= 0);
  const src = extractFunction(mount, 'param');
  const i = url.indexOf('?');
  const loc = { search: i < 0 ? '' : url.slice(i), hash: '' };
  return new Function('location', src + '\nreturn param;')(loc);
}

/** 造一批互不相干的候选，用来验证上限与排序 */
function manyHosts(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ label: 'S' + i, url: `https://s${i}.example.com/`, visits: i, pinned: false });
  }
  return out;
}

(async () => {
  /* ================================================================ [A] */
  console.log('\n[A] 页面纯函数（从 newtab.html 抽出来跑）');
  check('能定位到页面的纯函数段', !!pureSrc);

  const zhihu = { label: '知乎', url: 'https://www.zhihu.com/', visits: 12, pinned: false };
  const zhihuSub = { label: '知乎问题页', url: 'https://www.zhihu.com/question/1', visits: 30, pinned: false };
  const bili = { label: '哔哩', url: 'https://www.bilibili.com/', visits: 9, pinned: false };
  const tieba = { label: '贴吧', url: 'https://tieba.baidu.com/', visits: 5, pinned: false };

  // 曾经这一组是用 history 项（zhihu / bili / tieba）验证「同主机去重」与
  // 「其余按访问次数降序」的。2026-10 起新标签页**不再显示浏览历史**，
  // 那些项在 rank 里会被直接丢掉 —— 于是这两条断言的对象已经不存在，
  // 改成验证真实的新规则：只有 pinned 与 builtin 两档能上版。
  check('浏览历史不再上版（既不是内置、也不是用户自己加的，一律丢掉）', (() => {
    const r = Page.rank([zhihu, bili, tieba], 7);
    return r.length === 0;
  })(), JSON.stringify(Page.rank([zhihu, bili, tieba], 7).map((x) => x.label)));

  check('用户自己加的与内置的那六条都保留，且同主机去重', (() => {
    const pinned = { label: '我的博客', url: 'https://blog.example.com/', visits: 0, pinned: true };
    const pinnedSub = { label: '博客第二篇', url: 'https://blog.example.com/post/2', visits: 0, pinned: true };
    const b = { label: '导航', url: 'https://52ta.top/', visits: 0, builtin: true };
    const r = Page.rank([pinned, pinnedSub, b], 7);
    // 同主机只留先来的那一条
    return r.length === 2 && r[0].url === b.url && r[1].url === pinned.url;
  })());

  check('固定项排在最前面，且不参与次数排序', (() => {
    const pinned = { label: '我的博客', url: 'https://blog.example.com/', visits: 0, pinned: true };
    const pinned2 = { label: '另一个', url: 'https://two.example.com/', visits: 0, pinned: true };
    // tieba / bili / zhihu 是 history 项，rank 会丢掉它们 —— 所以这里只放两条 pinned
    const r = Page.rank([pinned, pinned2], 7);
    return r.length === 2 && r[0].url === pinned.url;
  })());

  check('超过 7 格就截断（第 8 格永远留给「＋添加」）', (() => {
    // 用 pinned 造 12 条：history 项会被 rank 丢掉，拿它们测截断会得到 0 条。
    const many = manyHosts(12).map((h) => ({ url: h.url, label: h.title, pinned: true }));
    return Page.MAX_SHORTCUTS === 7 && Page.rank(many, Page.MAX_SHORTCUTS).length === 7;
  })());

  // 钉住这次的承诺：新标签页上只有内置那六条与用户自己加的，浏览历史一律不上版。
  // 「历史」这个来源一旦被谁加回来（多半是为了「智能推荐」），这条会立刻红。
  check('浏览历史完全不进候选（buildData 只认 added）', (() => {
    const withHistory = Ntp.buildData({
      added: [{ url: 'https://mine.test/', label: '我的' }],
      history: [{ url: 'https://from-history.test/', title: '不该出现', visits: 999 }]
    });
    return !withHistory.includes('from-history.test');
  })());

  // 原先这里有一条「次数相同时按名称定序」—— 它测的是「浏览历史那一档按名称
  // 定序以免刷新时抖」。那一档 2026-10 起已经不存在了（新标签页不显示浏览
  // 历史），于是这条断言的对象没了。留着它反而会让人以为还有第三档。

  check('磁贴底色按主机名定，同一个站点每次进来都一样', (() => {
    return Page.gradOf('https://www.zhihu.com/hot') === Page.gradOf('https://www.zhihu.com/question/1');
  })());

  check('中文取首字、英文域名取首字母大写', (() => {
    return Page.initialOf('知乎', 'https://www.zhihu.com/') === '知'
      && Page.initialOf('', 'https://www.github.com/') === 'G';
  })(), Page.initialOf('', 'https://www.github.com/'));

  check('about:blank 的主机名不会被砍成 about', Page.hostOf('about:blank') === 'about:blank');

  check('用户没写协议时补 https://，不像域名的退回空串', (() => {
    return Page.normalizeUrl('zhihu.com') === 'https://zhihu.com'
      && Page.normalizeUrl('https://a.com') === 'https://a.com'
      && Page.normalizeUrl('随便写点啥') === '';
  })());

  check('收不到数据时退回内置兜底（不能白屏）', (() => {
    const list = Page.rank(Page.parseData(Page.FALLBACK), Page.MAX_SHORTCUTS);
    // 兜底是 6 条（书签/导航/播放器/浏览器/百度/DeepSeek），第 8 格留给「＋添加」。
    return list.length === 6;
  })());

  check('内置位在版面上永远占前排（候选再多也不被截掉）', (() => {
    const b = { label: '导航', url: 'https://52ta.top/', visits: 0, builtin: true };
    const mine = [
      { url: 'https://a.test/', label: 'A', pinned: true },
      { url: 'https://b.test/', label: 'B', pinned: true },
      { url: 'https://c.test/', label: 'C', pinned: true }
    ];
    const r = Page.rank(mine.concat([b]), 3);
    // 截到 3 格时第一个必须还是内置那条：截断发生在排序之后，
    // 内置位排在后面的话会被整条截掉，「固定」就是空话。
    return r.length === 3 && r[0].builtin === true;
  })());

  check('用户自己加的排在历史候选之前、但让内置位先占排', (() => {
    const b = { label: '导航', url: 'https://52ta.top/', visits: 0, builtin: true };
    const mine = { label: '我的', url: 'https://mine.example.com/', visits: 0, pinned: true };
    const r = Page.rank([zhihu, mine, b], 7);
    return r[0].builtin === true && r[1].pinned === true;
  })());

  /* ================================================================ [B] */
  console.log('\n[B] 宿主侧纯函数（src/renderer/ntp.js）');

  check('hostKey 去掉 www. 并转小写（不归一化就会「删了又回来」）', (() => {
    return Ntp.hostKey('https://WWW.Zhihu.com/x') === 'zhihu.com'
      && Ntp.hostKey('https://zhihu.com/hot') === 'zhihu.com';
  })());
  check('hostKey 不把 about:blank 砍成 about', Ntp.hostKey('about:blank') === 'about:blank');

  check('labelOf 切掉「页面名 - 站点名」的后半段',
    Ntp.labelOf('知乎 - 有问题，就会有答案', 'https://zhihu.com/') === '知乎');
  check('labelOf 不切「8_12岁英语」（分隔符前只有 1 个字）',
    Ntp.labelOf('8_12岁英语', 'https://a.com/') === '8_12岁英语');
  check('labelOf 标题为空时退回域名',
    Ntp.labelOf('', 'https://www.zhihu.com/') === 'zhihu.com'
    && Ntp.labelOf(null, 'https://www.zhihu.com/') === 'zhihu.com');
  check('labelOf 按码点截断，不会把 emoji 切成半个',
    [...Ntp.labelOf('😀😀😀😀😀😀😀😀😀😀😀😀😀', 'https://a.com/')].length === Ntp.MAX_LABEL,
    `长度 ${[...Ntp.labelOf('😀😀😀😀😀😀😀😀😀😀😀😀😀', 'https://a.com/')].length}`);

  check('候选里只有 http/https，about:blank 与 file:// 一律不进', (() => {
    const d = Ntp.buildData({
      added: [
        { url: 'about:blank', label: '新标签页' },
        { url: 'file:///preview/newtab.html', label: '本地页' },
        { url: 'https://a.com/', label: 'A' }
      ]
    });
    const r = realRows(d);
    return r.length === 1 && r[0].indexOf('https://a.com/') > 0
      && !/about:blank|newtab\.html/.test(d);
  })());

  check('候选按主机名归一化去重（www 与裸域名算同一家）', (() => {
    const d = Ntp.buildData({
      added: [
        { url: 'https://www.zhihu.com/hot', title: '知乎', visits: 9 },
        { url: 'https://zhihu.com/question/1', title: '知乎问题', visits: 30 }
      ]
    });
    return realRows(d).length === 1;
  })());

  check('已移除的主机名不会再出现在候选里', (() => {
    const d = Ntp.buildData({
      added: [{ url: 'https://www.zhihu.com/hot', label: '知乎' }],
      removed: ['zhihu.com']
    });
    return realRows(d).length === 0 && d.indexOf('zhihu') < 0;
  })());

  check('名称里的制表符不会把一行拆成两行（凭空多出一个磁贴）', (() => {
    const r = realRows(Ntp.buildData({ added: [{ label: '知\t乎', url: 'https://a.com/' }] }));
    return r.length === 1 && r[0].indexOf('知 乎') === 0;
  })(), JSON.stringify(realRows(Ntp.buildData({ added: [{ label: '知\t乎', url: 'https://a.com/' }] }))));

  // 用例名里那个「排在历史前面」已经过期：2026-10 起新标签页不显示浏览历史，
  // 没有「历史」那一档可排了。现在验证的是「自己加的每一条都打 p 标记」。
  check('自己加的每一条都打 p 标记', (() => {
    const rows = realRows(Ntp.buildData({
      added: [
        { label: '我的 博客', url: 'https://blog.example.com/' },
        { url: 'https://www.zhihu.com/', label: '知乎' }
      ]
    }));
    return rows.length === 2 && rows[0].indexOf('blog.example.com') > 0
      && rows[0].slice(-1) === 'p' && rows[1].slice(-1) === 'p';
  })());

  check('候选上限 30 条',
    Ntp.buildData({ added: manyHosts(60).map((h) => ({ url: h.url, label: h.title })) }).split('\n').length === Ntp.MAX_CANDIDATES
    && Ntp.MAX_CANDIDATES === 30);

  check('加进去的站点会从「已移除」里清掉（否则加了不出现）', (() => {
    const s = Ntp.addShortcut({ added: [], removed: ['zhihu.com'] }, '知乎', 'https://www.zhihu.com/');
    return s.removed.length === 0 && s.added.length === 1;
  })());

  check('同一家站点只留一条自己加的记录', (() => {
    const s1 = Ntp.addShortcut({ added: [], removed: [] }, '知乎', 'https://www.zhihu.com/');
    const s2 = Ntp.addShortcut(s1, '知乎热榜', 'https://zhihu.com/hot');
    return s2.added.length === 1 && s2.added[0].url === 'https://zhihu.com/hot';
  })());

  check('删掉一个磁贴时，「已移除」也记一笔', (() => {
    const s = Ntp.removeShortcut(
      { added: [{ label: '知乎', url: 'https://zhihu.com/' }], removed: [] },
      'https://www.zhihu.com/');
    return s.added.length === 0 && s.removed.join() === 'zhihu.com';
  })());

  check('同一个站点删两次不会在「已移除」里攒重复项', (() => {
    const a = Ntp.removeShortcut({ added: [], removed: [] }, 'https://a.com/');
    return Ntp.removeShortcut(a, 'https://a.com/').removed.length === 1;
  })());

  check('坏掉的存储值不会把首页搞崩', (() => {
    return Ntp.normShortcuts(null).added.length === 0
      && Ntp.normShortcuts({ added: [null, { url: '' }], removed: [1, 'a.com'] }).added.length === 0
      && Ntp.normShortcuts({ removed: [1, 'a.com'] }).removed.join() === 'a.com';
  })());

  check('三种具名档位之外的值当自定义地址（老配置不能被悄悄改掉）', (() => {
    return Ntp.modeOf('start') === 'start'
      && Ntp.modeOf('homepage') === 'homepage'
      && Ntp.modeOf('blank') === 'blank'
      && Ntp.modeOf('https://52ta.top/') === 'custom'
      && Ntp.modeOf(undefined) === 'custom';
  })());

  const ctx = { homepage: 'https://52ta.top/', base: 'file:///x/newtab.html', theme: 'dark', data: 'a\tb' };
  check('档位 = 空白 → about:blank', Ntp.target('blank', ctx) === 'about:blank');
  check('档位 = 主页 → 主页地址', Ntp.target('homepage', ctx) === 'https://52ta.top/');
  check('档位 = 内置 → 本地页地址（带 theme 与 data）',
    Ntp.target('start', ctx).indexOf('file:///x/newtab.html?theme=dark&data=') === 0,
    Ntp.target('start', ctx));
  check('老配置里的自定义地址原样使用', Ntp.target('https://my.site/', ctx) === 'https://my.site/');
  check('base 缺失时退回主页，而不是拼出一条没法加载的地址', (() => {
    return Ntp.target('start', { homepage: 'https://52ta.top/', base: '', theme: 'light', data: 'x' })
      === 'https://52ta.top/';
  })());
  check('没有候选时不挂空的 data 参数（空参数=「明确说没有」，会顶掉页面兜底）', (() => {
    return Ntp.pageUrl('file:///x/newtab.html', 'light', '') === 'file:///x/newtab.html?theme=light'
      && Ntp.pageUrl('file:///x/newtab.html', 'light', null) === 'file:///x/newtab.html?theme=light';
  })());

  /* ================================================================ [C] */
  console.log('\n[C] 两端契约（命令格式 / data 编码）');

  check('页面发出去的 add 命令，宿主侧能原样解开', (() => {
    const url = Page.cmdUrl('add', { label: 'C++ 教程', url: 'https://a.com/x?y=1&z=2' });
    const cmd = Ntp.parseCmd(url);
    return cmd && cmd.op === 'add'
      && cmd.get('label') === 'C++ 教程'
      && cmd.get('url') === 'https://a.com/x?y=1&z=2';
  })());

  check('含加号的名称不会被当成空格（URLSearchParams 在这里会解错）', (() => {
    // 页面用 encodeURIComponent：空格出 %20，字面的加号出 %2B。
    // 用 URLSearchParams 读的话会把 %2B 解成空格，得到「C  教程」——
    // 手拆 + decodeURIComponent 才对得上。
    const cmd = Ntp.parseCmd('nova://shortcut/add?label=C%2B%2B%20%E6%95%99%E7%A8%8B');
    return cmd && cmd.get('label') === 'C++ 教程';
  })());

  check('认不出的操作返回 null，而不是抛异常', (() => {
    return Ntp.parseCmd('nova://shortcut/dance') === null
      && Ntp.parseCmd('nova://shortcut/') === null
      && Ntp.parseCmd('https://a.com/') === null
      && Ntp.parseCmd(null) === null;
  })());

  check('页面发的 remove 命令只带 url', (() => {
    const cmd = Ntp.parseCmd(Page.cmdUrl('remove', { url: 'https://a.com/' }));
    return cmd && cmd.op === 'remove' && cmd.get('url') === 'https://a.com/';
  })());

  check('页面发的 extstore 命令被宿主侧认出（PC 新标签页的插件商店入口）', (() => {
    const cmd = Ntp.parseCmd(Page.cmdUrl('extstore', {}));
    return cmd && cmd.op === 'extstore';
  })());

  check('宿主拼的 data 参数能被页面读回成同一批候选', (() => {
    const src = {
      added: [
        { label: '我的 博客', url: 'https://blog.example.com/' },
        { url: 'https://www.zhihu.com/hot', label: '知乎 - 有问题' }
      ]
    };
    const url = Ntp.pageUrl('file:///x/newtab.html', 'light', Ntp.buildData(src));
    const list = Page.parseData(loadParam(url)('data'));
    // 末尾那条是补位来的，顺带验一下 f 标记活着到了页面 —— 少了它，
    // 内置位就与用户自己加的混作一谈，「固定」这个承诺也没了。
    // （原先这里还断言 list[1].visits === 7，那是浏览历史才有的字段，
    //   2026-10 起新标签页不再收历史，于是断言改成只看 p 标记。）
    return list.length >= 2
      && list[0].label === '我的 博客' && list[0].pinned === true
      && list[1].label === '知乎 - 有问题' && list[1].pinned === true
      && list[list.length - 1].builtin === true;
  })());

  check('data 里没有裸露的制表符或换行',
    (() => {
      const url = Ntp.pageUrl('file:///x/newtab.html', 'light', Ntp.buildData({
        added: [{ label: 'a\tb\nc', url: 'https://a.com/' }]
      }));
      return url.indexOf('\t') < 0 && url.indexOf('\n') < 0;
    })());

  check('页面 param() 把 `+` 当空格（Java 的 URLEncoder 会编出 `+`）', (() => {
    // 真实来源：安卓侧拼 URL 用的是 java.net.URLEncoder，空格出 `+`；
    // 而 decodeURIComponent 不认 `+`。两端各留一层兜底。
    return loadParam('file:///x/newtab.html?theme=light&data=My+Site')('data') === 'My Site';
  })());

  /* ================================================================ [D] */
  console.log('\n[D] 外壳接线（真实 DOM）');
  const dom = await JSDOM.fromFile(P('src/renderer/shell.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const doc = window.document;
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => [...doc.querySelectorAll(s)];
  const ev = (expr) => window.eval(expr);
  const evSafe = (expr) => { try { return window.eval(expr); } catch { return undefined; } };
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // 等 init() 跑完：它以 bootstrap 为界，之后才有 settings / newTabFileUrl
  for (let i = 0; i < 100 && evSafe('state.settings.newTabPage') === undefined; i++) await sleep(50);
  evSafe('openSettings("general")');
  await sleep(60);

  check('外壳拿到了内置新标签页的本地地址', !!ev('state.newTabFileUrl'), ev('state.newTabFileUrl'));
  check('出厂档位是「内置」', ev('state.settings.newTabPage') === 'start',
    String(ev('state.settings.newTabPage')));
  check('设置页渲染出三档 + 自定义地址输入框',
    ['newtab-builtin', 'newtab-homepage', 'newtab-blank', 'newtab-same']
      .every((a) => !!$(`#settings-body [data-act="${a}"]`)) && !!$('#settings-body #set-newtab'));
  check('「内置」那档是高亮的',
    $('#settings-body [data-act="newtab-builtin"]').classList.contains('is-active'));

  click($('#settings-body [data-act="newtab-blank"]'));
  await sleep(60);
  check('点「空白」写入 blank', ev('state.settings.newTabPage') === 'blank',
    String(ev('state.settings.newTabPage')));
  check('新建标签页此时是 about:blank', ev('newTabUrl()') === 'about:blank', ev('newTabUrl()'));
  check('设置页那句「当前：」跟着变', /当前：空白页/.test($('#settings-body').textContent));

  click($('#settings-body [data-act="newtab-builtin"]'));
  await sleep(60);
  check('点「内置」写回 start', ev('state.settings.newTabPage') === 'start');
  check('「内置」重新高亮',
    $('#settings-body [data-act="newtab-builtin"]').classList.contains('is-active'));

  const ntpUrl = ev('newTabUrl()');
  check('内置档位指向本地 newtab.html 并带上 theme',
    /^file:\/\/.*newtab\.html\?theme=/.test(ntpUrl), String(ntpUrl).slice(0, 56));

  // 真的开一张新标签页，看地址栏怎么显示
  const before = ev('state.tabs.length');
  click($('#tab-new'));
  await sleep(80);
  check('新建标签页按钮开出一张新标签', ev('state.tabs.length') === before + 1);
  check('新标签的目标就是内置新标签页',
    String(ev('state.tabs[state.tabs.length - 1].url')).indexOf('newtab.html') > 0);

  ev('syncOmnibox()');
  check('地址栏不摊那条又长又吓人的本地地址',
    $('#omni-input').value === '' && $('#omni-input').placeholder === '新标签页',
    `value=${JSON.stringify($('#omni-input').value)} placeholder=${$('#omni-input').placeholder}`);

  check('新开的那张就是当前标签', ev('activeTab().id') === ev('state.tabs[state.tabs.length - 1].id'));
  // 地址栏看的是**当前**标签，所以要切当前这张，不是 tabs[0]
  ev('navigate(state.activeId, "https://example.com/")');
  ev('syncOmnibox()');
  check('普通页面时 placeholder 还原成提示语',
    $('#omni-input').placeholder === '搜索或输入网址' && $('#omni-input').value === 'https://example.com/',
    `value=${JSON.stringify($('#omni-input').value)} placeholder=${$('#omni-input').placeholder}`);

  // 回到新标签页那张，发一条 add 命令（模拟页面跳 nova:// 被主进程截下来）
  const ntpTabId = ev('state.tabs[state.tabs.length - 1].id');
  const ntpTabWc = ev('state.tabs[state.tabs.length - 1].wcId');
  ev(`navigate(${ntpTabId}, newTabUrl())`);
  await sleep(30);
  window.nova.__emit('ntp:command', {
    id: ntpTabWc,
    url: Page.cmdUrl('add', { label: '示例站', url: 'https://sample.example.com/' })
  });
  await sleep(80);
  check('页面发来的 add 命令落到了 ntpShortcuts.added',
    ev('state.settings.ntpShortcuts.added.length') === 1,
    JSON.stringify(ev('state.settings.ntpShortcuts.added')));
  check('落盘之后那一页被重新导航（否则点了等于没点）',
    String(ev(`state.tabs.find((t) => t.id === ${ntpTabId}).url`)).indexOf('sample.example.com') > 0);

  window.nova.__emit('ntp:command', {
    id: ntpTabWc,
    url: Page.cmdUrl('remove', { url: 'https://sample.example.com/' })
  });
  await sleep(80);
  check('remove 命令把主机名记进「已移除」',
    ev('state.settings.ntpShortcuts.removed').join() === 'sample.example.com',
    JSON.stringify(ev('state.settings.ntpShortcuts.removed')));
  check('自己加的那条同时被摘掉', ev('state.settings.ntpShortcuts.added.length') === 0);
  check('删掉之后那一页的地址里不再有该站点',
    String(ev(`state.tabs.find((t) => t.id === ${ntpTabId}).url`)).indexOf('sample.example.com') < 0);

  window.nova.__emit('ntp:command', { id: ntpTabWc, url: 'nova://shortcut/dance' });
  await sleep(40);
  check('认不出的命令既不落盘也不炸', ev('state.settings.ntpShortcuts.removed.length') === 1);

  // 命令绕回来的时候用户可能已经跳走了，那时不该把页面拽回来
  ev('navigate(state.tabs[0].id, "https://example.com/")');
  await sleep(30);
  window.nova.__emit('ntp:command', {
    id: ev('state.tabs[0].wcId'),
    url: Page.cmdUrl('add', { label: '另一站', url: 'https://other.example.com/' })
  });
  await sleep(80);
  check('命令落在非新标签页的标签上时不重新导航（不把用户拽回来）',
    ev('state.tabs[0].url') === 'https://example.com/', ev('state.tabs[0].url'));

  check('档位不是「自定义」时输入框显示主页地址（起点不该是一串 start）',
    $('#settings-body #set-newtab').value === ev('state.settings.homepage'),
    $('#settings-body #set-newtab').value);
  check('设置页那句「当前：」在切回内置后也跟着回来',
    /当前：内置页/.test($('#settings-body').textContent));

  // 会话恢复带回来的内置新标签页要用**当下**的候选重算。
  // 真环境踩到的：快照里存的是上次关闭那一刻算好的地址，照原样恢复的话，
  // 用户重启后看到的新标签页还是那时候的格数（实测就是「六宫格变回两格」）。
  check('恢复会话时内置新标签页重新算候选，不沿用快照里的旧 data', (() => {
    const live = ev('newTabUrl()');
    const stale = String(live).replace(/data=[^&]*/, 'data=' + encodeURIComponent('老站\thttps://old.test/\t9\t-'));
    const restored = ev(`restoreUrlFor(${JSON.stringify(stale)})`);
    return restored === live && String(restored).indexOf('old.test') < 0;
  })());
  check('恢复会话时普通页面照旧原样还给用户',
    ev("restoreUrlFor('https://example.com/')") === 'https://example.com/',
    ev("restoreUrlFor('https://example.com/')"));

  /* ================================================================ [E] */
  console.log('\n[E] 与安卓端 NewTab.java / assets 产物对齐');
  const java = fs.readFileSync(P('android-app/app/src/main/java/top/wuai/nova/NewTab.java'), 'utf8');

  check('命令 scheme 两端一字不差',
    (javaConst(java, 'String', 'CMD_PREFIX') || '').replace(/"/g, '') === Ntp.CMD_PREFIX,
    javaConst(java, 'String', 'CMD_PREFIX'));
  check('候选上限两端都是 30',
    javaConst(java, 'int', 'MAX_CANDIDATES') === String(Ntp.MAX_CANDIDATES),
    javaConst(java, 'int', 'MAX_CANDIDATES'));
  check('操作名两端一致（add / remove）',
    (javaConst(java, 'String', 'OP_ADD') || '').replace(/"/g, '') === Ntp.OP_ADD
    && (javaConst(java, 'String', 'OP_REMOVE') || '').replace(/"/g, '') === Ntp.OP_REMOVE);
  check('两端指的是同一个 assets 页面',
    /newtab\.html/.test(javaConst(java, 'String', 'ASSET_URL') || ''),
    javaConst(java, 'String', 'ASSET_URL'));
  check('页面的 7 格上限 < 宿主的候选上限（否则排序没有意义）',
    Page.MAX_SHORTCUTS < Ntp.MAX_CANDIDATES, `${Page.MAX_SHORTCUTS} vs ${Ntp.MAX_CANDIDATES}`);

  check('移动端产物与源逐字节一致（npm run mobile:check 可复现）', (() => {
    const a = fs.readFileSync(P('src/renderer/newtab.html'));
    const b = fs.readFileSync(P('android-app/app/src/main/assets/newtab.html'));
    return a.length === b.length && Buffer.compare(a, b) === 0;
  })());

  /* ================================================================ [F] */
  console.log('\n[F] 内置推荐位（候选不足时补齐版面）');
  // 这一组守的是一个很容易复发的用户可感问题：候选一旦非空，「候选为空才兜底」
  // 就再也不会生效 —— 一个只访问过两三个站点的用户看到的是一片空白，
  // 而他的感受是「宫格被删了」。

  const shortData = Ntp.buildData({ added: [{ url: 'https://a.com/', label: 'A' }] });
  check('候选不足时用内置推荐补齐到版面格数',
    realRows(shortData).length + padRows(shortData).length === Ntp.MAX_TILES
      && Ntp.MAX_TILES === Page.MAX_SHORTCUTS,
    `真实 ${realRows(shortData).length} + 补位 ${padRows(shortData).length}，格数 ${Ntp.MAX_TILES}`);
  check('补位项排在用户自己加的那些之后（都是 p，只有补位的是 f）', (() => {
    // 原先这条断言第一行是 '-' 标记 —— 那是浏览历史才有的标记，
    // 新标签页不收历史之后不再有 '-'，现在每一行都是 p 或 f。
    const first = shortData.split('\n')[0].slice(-1);
    const last = shortData.split('\n').slice(-1)[0].slice(-1);
    return (first === 'p' || first === 'f') && last === 'f';
  })());

  check('候选够填满版面时内置位依然在（固定入口不随候选增减）', (() => {
    const d = Ntp.buildData({ added: manyHosts(9).map((h) => ({ url: h.url, label: h.title })) });
    // 真实候选照原样送出去，内置那六条**照样追加**。
    // 这条断言钉的是「固定」二字：老实现是「候选够 7 条就一条都不补」，
    // 于是用户多访问几个站点，这六条整体消失、清次历史又回来 —— 网址来回改。
    return padRows(d).length === Ntp.BUILTIN_SITES.length && realRows(d).length === 9;
  })());

  check('候选多少，内置位的位置与条数都不变（刷新不跳位）', (() => {
    // 同一条内置入口，在候选 0 条与候选 20 条两种情形下都出现、且顺序一致。
    const few = padRows(Ntp.buildData({ history: manyHosts(2) })).map((l) => l.split('\t')[1]);
    const many = padRows(Ntp.buildData({ history: manyHosts(20) })).map((l) => l.split('\t')[1]);
    return few.length === many.length
      && few.length === Ntp.BUILTIN_SITES.length
      && few.every((u, i) => u === many[i]);
  })());

  check('用户点掉某个固定入口后不再补它，其余固定入口仍在（那个 × 是真的）', (() => {
    const d = Ntp.buildData({ removed: ['music.52ta.top'] });
    const urls = padRows(d).map((l) => l.split('\t')[1]);
    return realRows(d).length === 0
      && !urls.some((u) => Ntp.hostKey(u) === 'music.52ta.top')
      && urls.length === Ntp.BUILTIN_SITES.length - 1;
  })());

  check('被用户点掉的主机名不会被补回来（否则那个 × 是假的）', (() => {
    const d = Ntp.buildData({ removed: ['52ta.top'] });
    const urls = padRows(d).map((l) => l.split('\t')[1]);
    return realRows(d).length === 0 && !urls.some((u) => Ntp.hostKey(u) === '52ta.top')
      && urls.length === Ntp.BUILTIN_SITES.length - 2;
  })());

  check('判重按完整 URL：同一家的两个入口都保留（少一个就是「宫格缺一角」）', (() => {
    const urls = padRows(Ntp.buildData({})).map((l) => l.split('\t')[1]);
    return urls.length === Ntp.BUILTIN_SITES.length
      && urls.indexOf('https://www.52ta.top/') >= 0
      && urls.indexOf('https://52ta.top/') >= 0;
  })());

  check('用户自己加的那条排在补位项前面', (() => {
    const lines = Ntp.buildData({ added: [{ label: '我的', url: 'https://mine.test/' }] })
      .split('\n').filter(Boolean);
    return lines[0].slice(-1) === 'p' && lines[lines.length - 1].slice(-1) === 'f';
  })());

  check('页面兜底清单与宿主内置清单逐条一致', (() => {
    const fb = Page.parseData(Page.FALLBACK);
    return fb.length === Ntp.BUILTIN_SITES.length
      && fb.every((r, i) => r.label === Ntp.BUILTIN_SITES[i].label && r.url === Ntp.BUILTIN_SITES[i].url);
  })(), `${Page.parseData(Page.FALLBACK).length} vs ${Ntp.BUILTIN_SITES.length}`);

  check('安卓端内置清单与桌面端逐条一致', (() => {
    const jb = [...java.matchAll(/new Row\("([^"]*)",\s*"([^"]*)",\s*0,\s*false,\s*true\)/g)]
      .map((m) => ({ label: m[1], url: m[2] }));
    return jb.length === Ntp.BUILTIN_SITES.length
      && jb.every((r, i) => r.label === Ntp.BUILTIN_SITES[i].label && r.url === Ntp.BUILTIN_SITES[i].url);
  })(), `${[...java.matchAll(/new Row\("([^"]*)",\s*"([^"]*)",\s*0,\s*false,\s*true\)/g)].length} 条`);

  // 上面前一条只守「两端一致」—— 改一处改两处，它照样是绿的。
  // 而用户要的是「这六条本身不许动」，所以这里把内容也钉死：
  // 要增删或改地址必须先改这一条，并且在 commit 里说清为什么。
  check('这六条固定入口不许被改动（地址逐字钉死）', (() => {
    const PINNED = [
      ['主页', 'https://www.52ta.top/'],
      ['导航', 'https://52ta.top/'],
      ['播放器', 'https://music.52ta.top/'],
      ['浏览器', 'https://nova.52ta.top/'],
      ['百度', 'https://www.baidu.com/'],
      ['DeepSeek', 'https://chat.deepseek.com/']
    ];
    return Ntp.BUILTIN_SITES.length === PINNED.length
      && PINNED.every((p, i) =>
        Ntp.BUILTIN_SITES[i].label === p[0] && Ntp.BUILTIN_SITES[i].url === p[1]);
  })(), Ntp.BUILTIN_SITES.map((s) => s.url).join(' '));

  // 页面侧那份兜底清单也是同一批地址（FALLBACK 给 flags 'p'，位置不同），
  // 同样钉死 —— 否则数据一旦不同步，用户看到的是「有时候六个有时候五个」。
  check('页面兜底清单与这六条同一批地址', (() => {
    const fb = Page.parseData(Page.FALLBACK);
    const pinnedUrls = [
      'https://www.52ta.top/', 'https://52ta.top/', 'https://music.52ta.top/',
      'https://nova.52ta.top/', 'https://www.baidu.com/', 'https://chat.deepseek.com/'
    ];
    return fb.length === pinnedUrls.length && pinnedUrls.every((u, i) => fb[i].url === u);
  })(), Page.parseData(Page.FALLBACK).map((r) => r.url).join(' '));

  check('版面格数三处同值（页面 / 桌面宿主 / 安卓宿主）',
    javaConst(java, 'int', 'MAX_TILES') === String(Ntp.MAX_TILES)
      && Page.MAX_SHORTCUTS === Ntp.MAX_TILES,
    `页面 ${Page.MAX_SHORTCUTS} · 桌面 ${Ntp.MAX_TILES} · 安卓 ${javaConst(java, 'int', 'MAX_TILES')}`);

  check('「固定入口无条件补齐」在安卓端同样成立（withBuiltins 不看格数提前退）',
    // 反向断言：安卓端**不能**再有 out.size() >= MAX_TILES 的提前退出。
    // 那是「候选够 7 条就不补」的根因，两端必须一起去掉，否则手机上
    // 这六条仍会随候选多少而增减 —— 正是用户说的「网址来回改」。
    !/out\.size\(\)\s*>=\s*MAX_TILES/.test(java));

  /* ---- 收藏夹：同一份数据开张 ---- */
  const settings = require(P('src/main/settings.js'));
  check('收藏夹初值就是这六个内置入口（与宫格同源）', (() => {
    const bm = settings.DEFAULTS.bookmarks || [];
    return bm.length === Ntp.BUILTIN_SITES.length
      && bm.every((b, i) => b.title === Ntp.BUILTIN_SITES[i].label && b.url === Ntp.BUILTIN_SITES[i].url);
  })(), `${(settings.DEFAULTS.bookmarks || []).length} 条`);

  check('老配置升级时补进收藏夹，且只补一次', (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-seed-'));
    const file = path.join(dir, 'nova-settings.json');
    // 老配置长这样：只有用户自己的那条，没有 bookmarkSeed 键
    fs.writeFileSync(file, JSON.stringify({
      bookmarks: [{ title: '52ta', url: 'https://52ta.top/' }]
    }));
    const first = settings.init(dir);
    const urls = first.bookmarks.map((b) => b.url);
    const okFirst = first.bookmarkSeed === 1
      && urls.length === Ntp.BUILTIN_SITES.length
      && urls[0] === 'https://52ta.top/';          // 用户原来那条没被挤位
    // 再来一次：这次用户已经删掉过某个内置书签，不该被补回来
    first.bookmarks = first.bookmarks.filter((b) => b.url !== 'https://chat.deepseek.com/');
    fs.writeFileSync(file, JSON.stringify(first));
    const second = settings.init(dir);
    return okFirst && !second.bookmarks.some((b) => b.url === 'https://chat.deepseek.com/');
  })());

  /* ---- 内置地址改错过之后的修订 ---- */
  // 书签是**整条**存下来的，不是存个「内置第 3 条」的引用。所以上游把某个内置
  // 地址改对，只对装上新版本的人有效 —— 已经装过的那份文件里躺着的仍是错地址。
  // 少了这一步，用户报「播放器打不开」时改完常量，他会说「还是打不开」。
  check('写错过的内置地址，老用户那份也改过来', (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-fix-'));
    fs.writeFileSync(path.join(dir, 'nova-settings.json'), JSON.stringify({
      bookmarks: [
        { title: '52ta', url: 'https://52ta.top/' },
        { title: '播放器', url: 'https://misuc.52ta.top/' }
      ],
      bookmarkSeed: 1,
      ntpShortcuts: { added: [], removed: ['misuc.52ta.top'] }
    }));
    const s = settings.init(dir);
    const urls = s.bookmarks.map((b) => b.url);
    return s.bookmarkFix === 1
      && urls.includes('https://music.52ta.top/')
      && !urls.some((u) => u.includes('misuc'))
      && urls[0] === 'https://52ta.top/'                    // 用户自己那条没被碰
      && urls.length === 2                                  // 也没顺手补种（种子早用掉了）
      && s.ntpShortcuts.removed.includes('music.52ta.top');  // 他删过的一直算数
  })());

  check('修订也只做一次 —— 用户自己把地址改回去了，就认他的', (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-fix2-'));
    fs.writeFileSync(path.join(dir, 'nova-settings.json'), JSON.stringify({
      bookmarks: [{ title: '播放器', url: 'https://misuc.52ta.top/' }],
      bookmarkSeed: 1,
      bookmarkFix: 1
    }));
    return settings.init(dir).bookmarks.some((b) => b.url === 'https://misuc.52ta.top/');
  })());

  console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
