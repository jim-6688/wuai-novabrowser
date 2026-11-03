'use strict';

/**
 * 收藏夹栏行为测试（真实 DOM，jsdom）
 * 用法：node tools/test-bookmark-bar.js
 *
 * 验的是这条栏本身：画得对不对、三档显隐有没有按当前页走、点一格会不会
 * 跳、右键能不能移出、加入书签之后栏里是不是当场就多一条。
 *
 * 有两处刻意不验：
 *   1. 窄屏档位下这条栏具体收得多窄。那是层叠结果，而 jsdom 不跑布局，
 *      这里只验到「栏还在、内容还对、CSS 里写的是收窄规则而不是 display:none」。
 *   2. 图标是不是真的画出来了。jsdom 不加载图，img 的 onerror 触发时机
 *      也和真机不同，所以这里只验「该用 img 的时候用的是 img」，以及三层
 *      兜底的顺序对不对（详见 [Q]）。
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

const root = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dom = await JSDOM.fromFile(path.join(root, 'src/renderer/shell.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const doc = window.document;
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => [...doc.querySelectorAll(s)];

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));

  const waitFor = async (fn, timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (fn()) return true;
      await sleep(30);
    }
    return false;
  };

  // 等启动跑完（首个标签页建好、收藏夹栏渲染出来）
  await waitFor(() => $('#bookmark-bar .bm-item'));

  const bar = $('#bookmark-bar');
  const items = () => $$('#bookmark-bar .bm-item');
  const setMode = (m) => window.eval(`state.settings.bookmarkBar = ${JSON.stringify(m)}; renderBookmarkBar(true)`);
  /**
   * 摆一份书签。
   *
   * 必须从 state.settings 那一头改：bootstrap 给的 settings 与 mock 桥内部
   * 是同一个对象，而 state.bookmarks 与 settings.bookmarks 本来是同一个数组。
   * 直接给 state.bookmarks 赋个新数组会把这条线剪断 —— 之后
   * bridge.bookmarks.remove() 过滤的是 mock 那一份，不是我们摆的这一份，
   * 断言就会对着一份没动过的数据发问。
   */
  const setBms = (list) => window.eval(
    `state.settings.bookmarks = ${JSON.stringify(list)};` +
    'state.bookmarks = state.settings.bookmarks; renderBookmarkBar(true)');
  const Right = (el) => el.dispatchEvent(
    new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

  if (!bar) {
    console.error('\n#bookmark-bar 不存在 —— shell.html 里那条栏没了？\n');
    process.exit(2);
  }

  console.log('\n[A] 默认常驻');

  check('收藏夹栏在 DOM 里', !!bar);
  check('默认档位下是显示的', !bar.hidden);
  // 条数不写死：mock 摆的那几条就是内置入口（ntp.js 的 BUILTIN_SITES 同一份），
  // 内置入口从两条补到六条的那一轮，就把这里的两条断言打红了 —— 而界面本身
  // 一点问题没有，只是「写死 2」这件事过期了。直接问 mock 有几条、界面上
  // 就得画几条，以后增删内置站点都不必再回来改这一行。
  const mockCount = window.eval('state.settings.bookmarks.length');
  const mockFirstTitle = window.eval('state.settings.bookmarks[0].title');
  check('渲染出 mock 里的全部书签', items().length === mockCount,
    `${items().length} 条 / mock ${mockCount} 条`);
  check('条目文案取自书签标题',
    items().some((el) => el.textContent.includes(mockFirstTitle)),
    items().map((el) => el.textContent.trim()).join(' | '));
  check('没有 favicon 时退回首字母方块（不是空白格）',
    !!items()[0].querySelector('.bm-fav') && !items()[0].querySelector('.bm-fav img'),
    items()[0].querySelector('.bm-fav').textContent);
  check('条目 title 里写了右键能做什么',
    (items()[0].getAttribute('title') || '').includes('右键'),
    (items()[0].getAttribute('title') || '').split('\n').pop());

  console.log('\n[B] 空栏');

  setBms([]);
  check('没有书签时不显示条目', items().length === 0);
  check('空栏给一句去处，而不是留一条纯白带子', !!$('#bookmark-bar .bm-empty'),
    ($('#bookmark-bar .bm-empty') || {}).textContent);

  console.log('\n[C] 点一格在当前标签页打开');

  setBms([{ title: '示例', url: 'https://example.com/a' }]);
  window.eval("navigate(state.activeId, 'https://start.test/')");
  items()[0].click();
  await sleep(40);
  check('当前标签页的地址变成了那一格的书签',
    window.eval('activeTab().url') === 'https://example.com/a',
    window.eval('activeTab().url'));
  // 地址栏非聚焦时显示的是网站名，点进去才切回真实网址 —— 所以这里验
  // 「聚焦后能拿到真实网址」，而不是「一直显示网址」。
  const omniInp = $('#omni-input');
  omniInp.focus();
  await sleep(20);
  check('地址栏聚焦后显示真实网址',
    omniInp.value === 'https://example.com/a', omniInp.value);
  omniInp.blur();

  console.log('\n[D] 右键开编辑框，再从框里移出');

  setBms([
    { title: 'A', url: 'https://a.test/' },
    { title: 'B', url: 'https://b.test/' }
  ]);
  Right(items().find((el) => el.dataset.bm === 'https://a.test/'));
  await sleep(60);
  check('右键打开的是编辑框，不是直接删掉', !$('#bm-edit').hidden);
  check('框里带着这一条的标题', $('#bm-edit-title').value === 'A',
    $('#bm-edit-title').value);
  check('框里带着这一条的网址', $('#bm-edit-url').value === 'https://a.test/',
    $('#bm-edit-url').value);
  check('右键之后书签没被删', window.eval('state.bookmarks.length') === 2,
    window.eval('state.bookmarks.length') + ' 条');

  $('#bm-edit-remove').click();
  await sleep(80);
  check('点了「移出收藏」才真的少一条', window.eval('state.bookmarks.length') === 1,
    window.eval('state.bookmarks.map(b=>b.url).join(",")'));
  check('留下的正好是另一条', window.eval('state.bookmarks[0].url') === 'https://b.test/');
  check('栏里那一格跟着消失',
    items().length === 1 && items()[0].dataset.bm === 'https://b.test/');
  check('编辑框收起来了', $('#bm-edit').hidden);

  console.log('\n[D2] 改标题与网址');

  setBms([{ title: '旧标题', url: 'https://old.test/a' }]);
  Right(items()[0]);
  await sleep(50);
  $('#bm-edit-title').value = '新标题';
  $('#bm-edit-url').value = 'https://new.test/b';
  $('#bm-edit-save').click();
  await sleep(80);
  check('标题写进去了', window.eval('state.bookmarks[0].title') === '新标题',
    window.eval('state.bookmarks[0].title'));
  check('网址写进去了', window.eval('state.bookmarks[0].url') === 'https://new.test/b',
    window.eval('state.bookmarks[0].url'));
  check('栏里那一格换成新标题', items().some((el) => el.textContent.includes('新标题')),
    items().map((el) => el.textContent.trim()).join(' | '));
  check('保存后编辑框关掉', $('#bm-edit').hidden);

  // 半截域名自动补协议：收藏时写「zhihu.com」是常事
  // 先等上一次保存真正落地：那是一次 IPC，回来时会整体覆盖 state.bookmarks，
  // 抢在它前面 setBms 会被它盖回去（机器忙的时候偶发，见 [J2] 之后那条）。
  await sleep(120);
  setBms([{ title: '知乎', url: 'https://zhihu.com/' }]);
  Right(items()[0]);
  await sleep(50);
  $('#bm-edit-url').value = 'www.zhihu.com';
  $('#bm-edit-save').click();
  await sleep(80);
  check('只写域名时自动补 https://',
    window.eval('state.bookmarks[0].url') === 'https://www.zhihu.com',
    window.eval('state.bookmarks[0].url'));

  // 改成已有网址 → 拒绝并留在框里，别静默合并
  setBms([
    { title: 'A', url: 'https://a.test/' },
    { title: 'B', url: 'https://b.test/' }
  ]);
  Right(items().find((el) => el.dataset.bm === 'https://a.test/'));
  await sleep(50);
  $('#bm-edit-url').value = 'https://b.test/';
  $('#bm-edit-save').click();
  await sleep(60);
  check('改成已收藏的网址会被拒绝', !$('#bm-edit').hidden);
  check('拒绝时给出理由',
    ($('#bm-edit-tip').textContent || '').includes('已经在收藏里'),
    $('#bm-edit-tip').textContent);
  check('拒绝后数据没变', window.eval('state.bookmarks.length') === 2);
  $('#bm-edit-cancel').click();
  await sleep(40);

  console.log('\n[E] 星标与这条栏说的是同一件事');

  setBms([{ title: 'A', url: 'https://a.test/' }]);
  window.eval("navigate(state.activeId, 'https://a.test/')");
  window.eval('syncStarButton()');
  check('当前页已在书签里 → 星标实心', $('#omni-star').classList.contains('is-on'));
  check('星标的 title 同步改成「已在书签里」',
    ($('#omni-star').getAttribute('title') || '').includes('已在书签里'));

  Right(items()[0]);
  await sleep(50);
  $('#bm-edit-remove').click();
  await sleep(80);
  check('从栏里移出当前页那一条之后，星标变回空心',
    !$('#omni-star').classList.contains('is-on'));
  check('星标的 title 跟着改回去',
    ($('#omni-star').getAttribute('title') || '') === '加入书签',
    $('#omni-star').getAttribute('title'));

  console.log('\n[F] 点星标加入，栏里当场多一条');

  setBms([]);
  window.eval("navigate(state.activeId, 'https://new.test/page')");
  window.eval("activeTab().title = '示例页'; activeTab().favicon = 'https://new.test/f.ico'");
  $('#omni-star').click();
  await sleep(80);
  check('栏里当场多出一条', items().length === 1, items().length + ' 条');
  check('标题取自标签页',
    items()[0].querySelector('.bm-title').textContent === '示例页',
    items()[0].querySelector('.bm-title').textContent);
  check('favicon 一起存了下来（不是等下次再回填）',
    window.eval('state.bookmarks[0].favicon') === 'https://new.test/f.ico',
    String(window.eval('state.bookmarks[0].favicon')));
  check('这一格画的是真图标而不是首字母', !!items()[0].querySelector('.bm-fav img'));

  console.log('\n[G] 三档显隐');

  setBms([{ title: 'A', url: 'https://a.test/' }]);
  window.eval("navigate(state.activeId, 'https://plain.test/')");

  setMode('always');
  check('常驻：停在普通网页上也显示', !bar.hidden && items().length === 1);

  setMode('hidden');
  check('不显示：收起来', bar.hidden);

  setMode('ntp');
  check('仅新标签页：停在普通网页上时不出现', bar.hidden);

  window.eval('activeTab().url = state.newTabFileUrl');
  window.eval('syncBookmarkBar()');
  check('仅新标签页：停在新标签页上时出现', !bar.hidden && items().length === 1);

  window.eval("navigate(state.activeId, 'https://other.test/')");
  check('仅新标签页：从新标签页跳走后收起', bar.hidden);

  console.log('\n[H] 配置里写了别的字');

  window.eval("state.settings.bookmarkBar = 'weird'");
  window.eval('renderBookmarkBar(true)');
  check('不认识的取值当常驻 —— 不该因为配置脏了就凭空少一条栏', !bar.hidden);
  setMode('always');

  console.log('\n[I] 窄屏档位');

  const cssSrc = fs.readFileSync(path.join(root, 'src/renderer/shell.css'), 'utf8');

  window.eval("state.settings.layout = 'mobile'");
  window.eval('applyLayout()');
  // 窄屏不再整条消失 —— 和宽屏是同一条栏，收窄交给 CSS。这一档要是又退回
  // display:none，下面那条静态断言会当场拦下来。
  check('切到窄屏档位后这条栏仍然在', !bar.hidden);
  check('内容照样渲染', items().length === 1);
  check('CSS 里是收窄规则，不是把它藏掉',
    /\[data-layout="mobile"\]\s*\.bookmarkbar\s*\{[^}]*padding/.test(cssSrc));
  check('CSS 里没有再把窄屏这条栏 display:none',
    !/\[data-layout="mobile"\]\s*\.bookmarkbar\s*\{[^}]*display:\s*none/.test(cssSrc),
    (cssSrc.match(/\[data-layout="mobile"\]\s*\.bookmarkbar\s*\{[^}]*\}/) || [''])[0].replace(/\s+/g, ' '));

  window.eval("state.settings.layout = 'desktop'");
  window.eval('applyLayout()');
  check('切回桌面端后照旧', !bar.hidden && items().length === 1);

  console.log('\n[J] 设置页里的显示时机控件');

  window.eval("openSettings('appearance')");
  await waitFor(() => $('#set-bmbar'));
  const btns = $$('#set-bmbar button');
  check('外观分区里有三档（显示时机）', btns.length === 3,
    btns.map((b) => b.textContent.trim()).join(' / '));
  check('默认档落在第一档', btns[0].classList.contains('is-active'),
    btns.find((b) => b.classList.contains('is-active')).textContent.trim());

  // 按 data-bmbar 找按钮，不按索引 —— 以后再加档位也不会连累这条用例
  const byMode = (m) => $$('#set-bmbar button').find((b) => b.dataset.bmbar === m);

  byMode('hidden').click();
  await sleep(80);
  check('点了「不显示」后写进设置', window.eval('state.settings.bookmarkBar') === 'hidden');
  check('收藏夹栏当场收起', bar.hidden);
  check('选中态跟着走（重绘后仍然对）',
    byMode('hidden').classList.contains('is-active') && !byMode('always').classList.contains('is-active'));

  byMode('always').click();
  await sleep(80);
  check('点回「常驻」后恢复', !bar.hidden);
  check('设置值也回到 always', window.eval('state.settings.bookmarkBar') === 'always');

  /* 摆放位置在这一版被拆成独立一项（上/下/左/右）。以前「侧边栏」混在档位里，
     既说不清「放哪」也说不清「露不露」，是两件事混成了一件。 */
  console.log('\n[J2] 摆放位置（顶部 / 底部 / 左侧 / 右侧）');
  const posBtns = $$('#set-bmpos button');
  check('外观分区里有四个摆放位置', posBtns.length === 4,
    posBtns.map((b) => b.textContent.trim()).join(' / '));
  const byPos = (p) => $$('#set-bmpos button').find((b) => b.dataset.bmpos === p);
  check('四个位置齐全', ['top', 'bottom', 'left', 'right'].every((p) => !!byPos(p)));
  check('默认位置是顶部', window.eval('bmBarPos()') === 'top', window.eval('bmBarPos()'));

  byPos('right').click();
  await sleep(120);
  check('右侧：写进设置', window.eval('state.settings.bookmarkBarPos') === 'right');
  check('右侧：横向栏收起', bar.hidden);
  check('右侧：视口加 bm-bar-side（网页让位）', $('#viewport').classList.contains('bm-bar-side'));
  /* 回归：视口上的状态类**不能**叫 bm-side —— 侧栏元素自己就叫 .bm-side，
     而那条规则里有 display:none。以前两者同名，一切侧栏就把整个视口隐藏了：
     页面一片空白，用户只能得出「改不了方向」这个结论。 */
  check('竖栏档没把视口弄没（类名撞车）',
    window.getComputedStyle($('#viewport')).display !== 'none',
    window.getComputedStyle($('#viewport')).display);
  check('视口状态类与侧栏元素类不同名',
    !$('#viewport').classList.contains('bm-side'));
  check('右侧：不是左侧', !$('#viewport').classList.contains('bm-bar-side-left'));
  check('右侧：竖向列表有条目', $$('#bm-side-list [data-bm]').length > 0);

  byPos('left').click();
  await sleep(120);
  check('左侧：写进设置', window.eval('state.settings.bookmarkBarPos') === 'left');
  check('左侧：视口挂上 bm-bar-side-left', $('#viewport').classList.contains('bm-bar-side-left'));
  check('左侧：仍属竖栏档', $('#viewport').classList.contains('bm-bar-side'));

  byPos('bottom').click();
  await sleep(120);
  check('底部：横向栏显示', !bar.hidden);
  check('底部：栏上打了 data-pos=bottom（CSS 靠它换到窗口下沿）', bar.dataset.pos === 'bottom', bar.dataset.pos);
  check('底部：视口把侧栏宽度还回去了', !$('#viewport').classList.contains('bm-bar-side'));
  check('底部：侧栏隐藏', $('#bm-side').hidden);

  byPos('top').click();
  await sleep(100);
  check('顶部：data-pos=top', bar.dataset.pos === 'top', bar.dataset.pos);

  // 旧配置兼容：历史上「侧边栏」写在 bookmarkBar 里，升级上来的人不能因此丢栏
  window.eval("state.settings.bookmarkBar = 'side'; state.settings.bookmarkBarPos = undefined; renderBookmarkBar(true)");
  await sleep(80);
  check('旧值 side 仍按右侧竖栏渲染', window.eval('bmBarPos()') === 'right' && $('#viewport').classList.contains('bm-bar-side'));
  window.eval("state.settings.bookmarkBar = 'always'; state.settings.bookmarkBarPos = 'top'; renderBookmarkBar(true)");
  await sleep(60);

  // 书签分区里也有同一份位置控件（用户在哪一页都该能改）
  window.eval("openSettings('bookmarks')");
  await waitFor(() => $('#set-bmpos-bm'));
  check('书签分区里也有摆放位置控件', $$('#set-bmpos-bm button').length === 4);
  const bmPosBtn = $$('#set-bmpos-bm button').find((b) => b.dataset.bmpos === 'bottom');
  bmPosBtn.click();
  await sleep(120);
  check('书签分区里改位置同样生效', window.eval('state.settings.bookmarkBarPos') === 'bottom',
    window.eval('state.settings.bookmarkBarPos'));
  window.eval("state.settings.bookmarkBarPos = 'top'; renderBookmarkBar(true)");
  window.eval('closeSettings()');
  await sleep(60);

  console.log('\n[K] 网页内跳转（不走外壳的 navigate）');

  // 这条路径在 jsdom 里模拟不出来：UI 预览模式（bridge-mock）压根不建
  // webview，mountTab 只画一个同构的占位面板，派发 did-navigate 没有目标。
  // 所以「接线在不在」用静态断言守，而「url 变了栏就重算」这一半上面 [G]
  // 已经验过 —— 两者合起来才是完整的一条链路。
  const src = fs.readFileSync(path.join(root, 'src/renderer/shell.js'), 'utf8');
  const handler = src.match(/addEventListener\('did-navigate'[\s\S]*?\n  \}\);/);
  check('did-navigate 的处理器里调了 syncBookmarkBar',
    !!handler && handler[0].includes('syncBookmarkBar()'),
    handler ? '命中处理器 ' + handler[0].split('\n').length + ' 行' : '没匹配到处理器');

  setBms([{ title: 'A', url: 'https://a.test/' }]);
  setMode('ntp');
  window.eval('activeTab().url = state.newTabFileUrl');
  window.eval('syncBookmarkBar()');
  check('仅新标签页：停在新标签页上是放出来的', !bar.hidden);

  window.eval("activeTab().url = 'https://jumped.test/'");
  window.eval('syncBookmarkBar()');
  check('地址变成普通网页之后收起', bar.hidden);
  setMode('always');

  console.log('\n[M] 设置页导航按外壳形态取舍');

  window.eval("state.settings.layout = 'desktop'");
  window.eval('applyLayout()');
  window.eval("openSettings('general')");
  await waitFor(() => $('#settings-nav .sv-nav-item'));

  let navSecs = $$('#settings-nav .sv-nav-item').map((b) => b.dataset.sec);
  check('宽屏档位下导航里没有「移动端」',
    !navSecs.includes('mobile') && navSecs.length === 13, navSecs.join(','));
  check('深链接落到 mobile 时兜底到常规（不留一个打不开的分区）',
    window.eval("(openSettings('mobile'), state.settingsSection)") === 'general',
    window.eval('state.settingsSection'));

  window.eval("state.settings.layout = 'mobile'");
  window.eval('applyLayout()');
  window.eval("renderSettingsSection('general')");
  navSecs = $$('#settings-nav .sv-nav-item').map((b) => b.dataset.sec);
  check('窄屏档位下「移动端」回到导航里',
    navSecs.includes('mobile') && navSecs.length === 14, navSecs.join(','));
  window.eval("state.settings.layout = 'desktop'");
  window.eval('applyLayout()');

  console.log('\n[N] 设置页的返回');

  window.eval("openSettings('general')");
  await waitFor(() => $('#sv-back'));
  check('刚进设置页时返回是灰的（没有上一页可回）', $('#sv-back').disabled);
  check('返回按钮的 title 说明了为什么点不动',
    ($('#sv-back').getAttribute('title') || '').includes('第一页'),
    $('#sv-back').getAttribute('title'));

  window.eval("renderSettingsSection('appearance')");
  check('跳到外观之后返回可点了', !$('#sv-back').disabled);
  check('路径条跟着显示当前分区', $('#sv-path').textContent === '外观', $('#sv-path').textContent);

  $('#sv-back').click();
  await sleep(30);
  check('点返回退到上一页（常规）',
    window.eval('state.settingsSection') === 'general', window.eval('state.settingsSection'));
  check('设置页还开着 —— 返回不是关闭', !$('#settings-view').hidden);
  check('退到起点后返回又灰了', $('#sv-back').disabled);

  // 来回横跳两次不该在栈里堆出一长串：设过页的人最烦的就是返回得按十几次。
  window.eval("renderSettingsSection('appearance')");
  window.eval("renderSettingsSection('general')");
  window.eval("renderSettingsSection('appearance')");
  check('横跳之后栈只有两格',
    window.eval('state.settingsTrail.join(">")') === 'general>appearance',
    window.eval('state.settingsTrail.join(">")'));

  $('#sv-close').click();
  await sleep(30);
  check('× 仍然是直接关闭设置页', $('#settings-view').hidden);
  check('关闭时清空历史 —— 下次进来返回不该一推门就是亮的',
    window.eval('state.settingsTrail.length') === 0,
    String(window.eval('state.settingsTrail.length')));

  console.log('\n[O] 顶栏快捷开关');

  const qkTheme = $('#qk-theme');
  const qkBm = $('#qk-bmbar');
  check('主题与收藏夹栏两个开关都在', !!qkTheme && !!qkBm);
  check('它们排在品牌区后面，不是混进窗口按钮里',
    !!qkTheme.closest('.tb-quick') && !!$('.tb-brand')
      && !!($('.tb-brand').compareDocumentPosition(qkTheme) & window.Node.DOCUMENT_POSITION_FOLLOWING));

  window.eval("state.settings.theme = 'light'");
  doc.documentElement.dataset.theme = 'light';
  window.eval('syncQuickBar()');
  check('浅色时 title 说的是切到深色',
    (qkTheme.getAttribute('title') || '').includes('深色'), qkTheme.getAttribute('title'));

  qkTheme.click();
  await sleep(60);
  check('点一下切到深色', doc.documentElement.dataset.theme === 'dark',
    doc.documentElement.dataset.theme);
  check('设置里也写进去了', window.eval('state.settings.theme') === 'dark');
  check('title 跟着翻过来', (qkTheme.getAttribute('title') || '').includes('浅色'),
    qkTheme.getAttribute('title'));

  setBms([{ title: 'A', url: 'https://a.test/' }]);
  setMode('always');
  window.eval('syncQuickBar()');
  check('栏露着的时候开关是亮的', qkBm.classList.contains('is-on'));

  // 按钮现在是一个下拉：点按钮开菜单，再由菜单里的开合项真正收起 / 放出
  qkBm.click();
  await sleep(60);
  check('点收藏夹按钮弹出下拉', !$('#qk-bm-menu').hidden);
  check('下拉里有导入 / 导出', !!$('#qk-bm-import') && !!$('#qk-bm-export'));
  check('下拉里有「从其他浏览器导入」', !!$('#qk-bm-from-browser'));

  /* 摆放位置在顶栏下拉里也有一份：用户想挪这条栏时通常正站在它跟前，
     为此跑一趟设置页是多余的。三个入口（这里 / 外观 / 书签）共用同一份设置。 */
  const qkPos = $$('#qk-bm-pos [data-bmpos]');
  check('下拉里有四个摆放位置', qkPos.length === 4,
    qkPos.map((b) => b.textContent.trim()).join(' / '));
  check('下拉里的位置按钮默认亮在「顶」',
    qkPos.find((b) => b.dataset.bmpos === 'top').classList.contains('is-active'));
  qkPos.find((b) => b.dataset.bmpos === 'left').click();
  await sleep(150);
  check('在下拉里点「左」就写进设置', window.eval('state.settings.bookmarkBarPos') === 'left',
    window.eval('state.settings.bookmarkBarPos'));
  check('点完菜单自动收起（好让用户看栏挪到哪了）', $('#qk-bm-menu').hidden);
  check('视口真的挂上了左侧竖栏', $('#viewport').classList.contains('bm-bar-side-left'));
  // 下次打开菜单，选中态要跟到「左」
  qkBm.click();
  await sleep(80);
  check('再开菜单时选中态跟到「左」',
    $$('#qk-bm-pos [data-bmpos]').find((b) => b.dataset.bmpos === 'left').classList.contains('is-active'));
  $$('#qk-bm-pos [data-bmpos]').find((b) => b.dataset.bmpos === 'top').click();
  await sleep(150);
  check('点回「顶」恢复横向栏',
    window.eval('state.settings.bookmarkBarPos') === 'top' && !bar.hidden);
  qkBm.click();
  await sleep(60);
  if ($('#qk-bm-menu').hidden === false) $('#qk-bmbar').click();

  // 第二视图：检测已装浏览器（预览模式的 mock 没有这个方法，会退化成「没检测到」，
  // 但视图切换本身必须成立 —— 那才是这里的接线）
  $('#qk-bm-from-browser').click();
  await sleep(60);
  check('切到「从其他浏览器导入」视图',
    $('#qk-bm-main').hidden && !$('#qk-bm-browsers').hidden);
  $('#qk-bm-browsers [data-bmback]').click();
  await sleep(30);
  check('返回后回到主视图', !$('#qk-bm-main').hidden && $('#qk-bm-browsers').hidden);

  $('#qk-bm-toggle').click();
  await sleep(60);
  check('点「收起」把栏收起来', bar.hidden);
  check('设置值写成 hidden', window.eval('state.settings.bookmarkBar') === 'hidden');
  check('开关也跟着灭', !qkBm.classList.contains('is-on'));

  qkBm.click();
  await sleep(60);
  $('#qk-bm-toggle').click();
  await sleep(60);
  check('再点「展开」放出来', !bar.hidden);
  check('设置值回到 always', window.eval('state.settings.bookmarkBar') === 'always');

  // 「仅新标签页」档下栏是收着的，但开关不该跟着页面闪 —— 它回答的是
  // 「这条栏开着没有」，不是「此刻看得见吗」。
  window.eval("state.settings.bookmarkBar = 'ntp'");
  window.eval("navigate(state.activeId, 'https://plain.test/')");
  window.eval('syncQuickBar()');
  check('「仅新标签页」档下栏收着，开关仍读作开着',
    bar.hidden && qkBm.classList.contains('is-on'));

  setMode('always');
  window.eval("state.settings.theme = 'light'");
  doc.documentElement.dataset.theme = 'light';

  console.log('\n[P] 设置窗口（不再是整屏）');

  // 宽屏档位下，设置是一扇居中的窗，不是把整个浏览器顶走。
  window.eval("state.settings.layout = 'desktop'");
  window.eval('applyLayout()');
  window.eval("openSettings('general')");
  await waitFor(() => $('#settings-nav .sv-nav-item'));

  const view = $('#settings-view');
  const win = $('.settings-view > .sv-window');
  check('宽屏档位下有窗口外壳包着（head/body 不是直接铺满）', !!win);
  check('标题栏和正文都收在窗口里',
    !!win && !!win.querySelector('.sv-head') && !!win.querySelector('.sv-body'));
  check('窗口外壳与分区内的分组卡没有撞名',
    !$('.sv-window.sv-card') && !!$('.sv-main .sv-card'));

  // 点暗底关窗。mousedown + click 两段合成，对应真实的一次按下与一次松开。
  const pressBackdrop = () => {
    view.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    view.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  };
  pressBackdrop();
  await sleep(30);
  check('点暗底关得掉', view.hidden);

  // 在窗口里按住鼠标、拖选一段文字、手一滑松到了窗外 —— click 的落点是暗底，
  // 但按下不是。这种「拖选」不该被当成「点外面」，否则一松手设置就没了。
  window.eval("openSettings('general')");
  await waitFor(() => $('.settings-view > .sv-window'));
  $('.settings-view > .sv-window')
    .dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  view.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  check('窗口里按下、松开落在暗底上 —— 不关（那不是点外面）', !view.hidden);

  pressBackdrop();
  await sleep(30);
  check('按下与松开都落在暗底上 —— 这才叫点外面', view.hidden);

  // 窄屏档位：窗口外壳留在 DOM 里，「整屏还是窗口」归 CSS 那一层覆盖管，
  // jsdom 不跑布局，这里只验到结构没有因为换档被拆掉。
  window.eval("state.settings.layout = 'mobile'");
  window.eval('applyLayout()');
  window.eval("openSettings('general')");
  await waitFor(() => $('#settings-nav .sv-nav-item'));
  check('窄屏档位下窗口外壳仍在 DOM 里', !!$('.settings-view > .sv-window'));
  window.eval("state.settings.layout = 'desktop'");
  window.eval('applyLayout()');

  console.log('\n[Q] 站点图标');

  // 换掉「桥」那一层来喂图标表，而不是直接写 state.hostIcons ——
  // 后者会把 refreshHostIcons 那段接线整个绕过去，测不到它。
  // 真的那份桥在主进程里按主机名抓 /favicon.ico 再以 data: URI 交出来
  // （见 src/main/favicon-cache.js），这里只需要它「按主机的写法查表」这一点。
  const icons = async (map) => {
    window.eval(`bridge.favicons.json = async () => (${JSON.stringify(map)});`
      + "hostIconsAsked = '';");
    await window.eval('refreshHostIcons()');
    await sleep(20);
  };
  const favImg = () => $('#bookmark-bar .bm-fav img');
  const favText = () => ($('#bookmark-bar .bm-fav') || {}).textContent || '';

  setBms([{ url: 'https://52ta.top/', title: '52ta' }]);
  await icons({ '52ta.top': 'data:image/png;base64,AAAA' });
  check('拿到图标表后书签格画的是 <img>，不再是首字母', !!favImg());
  check('img 的 src 就是表里那个 data: URI',
    !!favImg() && favImg().getAttribute('src') === 'data:image/png;base64,AAAA',
    favImg() && favImg().getAttribute('src'));

  // 表里的键由主进程按「书签里写的那个 url」算出来，与这里读到的 url
  // 不保证同一写法 —— 带不带 www. 是每个站点的自由。
  setBms([{ url: 'https://www.zhihu.com/', title: '知乎' }]);
  await icons({ 'zhihu.com': 'data:image/png;base64,BBB' });
  check('书签带 www.、表里存的是裸域名 —— 也命中',
    !!favImg() && favImg().getAttribute('src') === 'data:image/png;base64,BBB');
  setBms([{ url: 'https://zhihu.com/', title: '知乎' }]);
  await icons({ 'www.zhihu.com': 'data:image/png;base64,CCC' });
  check('反过来（书签不带 www.、表里带）也命中',
    !!favImg() && favImg().getAttribute('src') === 'data:image/png;base64,CCC');

  // 三层兜底。外链那份是收藏那一刻从标签页抄下来的，会失效；
  // 缓存那份是主进程按站点抓的，落盘、有 TTL。所以前者是备选，不是首选。
  setBms([{ url: 'https://x.test/', title: 'X', favicon: 'https://x.test/f.png' }]);
  await icons({});
  check('没有缓存图标时退到书签自带的 favicon',
    !!favImg() && favImg().getAttribute('src') === 'https://x.test/f.png');
  await icons({ 'x.test': 'data:image/png;base64,DDD' });
  check('两层都有时，站点图标缓存胜过书签自带的外链',
    !!favImg() && favImg().getAttribute('src') === 'data:image/png;base64,DDD',
    favImg() && favImg().getAttribute('src'));

  // 设置页那张书签列表读的是同一张表 —— 它是上一次用空表画出来的，
  // 图标到了不补画一次就永远停在首字母上。
  setBms([{ url: 'https://n.test/', title: 'Nova' }]);
  await icons({ 'n.test': 'data:image/png;base64,EEE' });
  window.eval("openSettings('bookmarks')");
  await waitFor(() => $('.sv-main .list-row'));
  check('设置页的书签列表也画站点图标', !!$('.sv-main .list-row .lr-fav img'));
  window.eval('closeSettings()');

  // 表空掉之后落回首字母 —— 两层兜底都不在时才走这一层
  await icons({});
  check('两层都没有时才回落首字母，且不带 <img>',
    !favImg() && favText().trim() === 'N', JSON.stringify(favText().trim()));

  // 接线：书签变动后要重新问一次，而且只问书签用到的主机
  window.eval('window.__asked = null; window.__calls = 0;'
    + 'bridge.favicons.json = async (hosts) => { window.__asked = hosts; window.__calls++; return {}; };'
    + "hostIconsAsked = '';");
  setBms([{ url: 'https://q.test/', title: 'Q' }]);
  window.eval('refreshCurrent()');
  await sleep(30);
  check('书签变动后重新问一次，且只问书签用到的主机（不是全量历史）',
    JSON.stringify(window.__asked) === '["q.test"]', JSON.stringify(window.__asked));
  const calls0 = window.__calls;
  await window.eval('refreshHostIcons()');
  check('同一批主机不重复问 —— refreshCurrent 每次都会调到这儿，白跑一趟 IPC 不划算',
    window.__calls === calls0, `${calls0} → ${window.__calls}`);

  // 抓图是异步的：主机名没变、但表的内容变了，也必须重读一次。
  // 真机上是主进程抓到图标后推 favicon:updated 触发的这条路。
  window.eval('window.__calls = 0;'
    + 'bridge.favicons.json = async () => { window.__calls++; return {}; };'
    + "hostIconsAsked = 'q.test';");
  await window.eval('bridge.__emit("favicon:updated", null)');
  await sleep(40);
  check('主进程推 favicon:updated 时外壳会重读那张表（主机名没变也要重读）——'
    + '少了这条，书签格会一直停在首字母上，直到用户下次动书签才碰巧重画',
    window.__calls === 1, `重读 ${window.__calls} 次`);

  /* ---------------------------------------------------------------- *
   * [Q] 拖拽排序：三处共用一份实现（横栏 / 竖栏 / 设置页列表）
   *
   * jsdom 里没有真实的布局，getBoundingClientRect 全是 0 —— 落点会永远算成
   * 「插到最后」，那样测了等于没测。所以这里给每个条目塞一份假的几何：
   * 横排 x=0/100/200，竖排 y=0/40/80。落点按「是否越过中线」算，
   * 用错轴时结果会明显不同（横排拿 clientY、竖排拿 clientX 都会插到最前面），
   * 正好能把「轴用反了」揪出来。
   * ---------------------------------------------------------------- */
  console.log('\n[Q] 拖拽排序（横栏 / 竖栏 / 设置页）');

  const rect = (el, box) => {
    el.getBoundingClientRect = () => ({
      left: box.x || 0, top: box.y || 0,
      width: box.w || 100, height: box.h || 20,
      right: (box.x || 0) + (box.w || 100),
      bottom: (box.y || 0) + (box.h || 20),
      x: box.x || 0, y: box.y || 0
    });
  };
  const drag = (el, type, pt) => {
    const p = pt || {};
    el.dispatchEvent(new window.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: p.x || 0, clientY: p.y || 0
    }));
  };
  const order = () => (window.eval('state.bookmarks') || []).map((b) => b.url);

  const ABC = [
    { title: 'A', url: 'https://a.test/' },
    { title: 'B', url: 'https://b.test/' },
    { title: 'C', url: 'https://c.test/' }
  ];

  // --- 横栏：把 A 拖到 B 与 C 之间
  setBms(ABC);
  setMode('always');
  await sleep(60);
  let hItems = $$('#bm-track .bm-item');
  check('横栏条目可拖动（draggable）', hItems.length === 3 && hItems.every((el) => el.getAttribute('draggable') === 'true'),
    String(hItems.length));
  hItems.forEach((el, i) => rect(el, { x: i * 100, w: 100 }));
  drag(hItems[0], 'dragstart');
  drag($('#bm-track'), 'dragover', { x: 240 }); // 越过 C 的左中线(250)? 否 → 插在 C 之前
  check('横栏 dragover 落下落点标记', !!$('#bm-track .bm-item.bm-drop-before'));
  drag($('#bm-track'), 'drop', { x: 240 });
  await sleep(120);
  check('横栏：A 拖到 B 之后', order().join(',') === 'https://b.test/,https://a.test/,https://c.test/',
    order().join(','));
  check('横栏：拖完重画，顺序跟着变', $$('#bm-track .bm-item')[1].dataset.bm === 'https://a.test/');

  // --- 竖栏：把 A 拖到最末（用 clientY 判定；若误用 clientX=0 会插到最前）
  // 每个用例都先把顺序摆回 A/B/C —— 上一条用例已经把顺序改过了，
  // 不重置就等于在测一条别的数据。
  setBms(ABC);
  window.eval("state.settings.bookmarkBarPos = 'right'; renderBookmarkBar(true)");
  await sleep(80);
  let sItems = $$('#bm-side-list .bm-side-item');
  check('竖栏条目可拖动', sItems.length === 3 && sItems.every((el) => el.getAttribute('draggable') === 'true'));
  sItems.forEach((el, i) => rect(el, { y: i * 40, h: 40 }));
  drag(sItems[0], 'dragstart');
  // 先指到一个「中间落点」看标记（指到最后一项之后时本就不该画标记）
  drag($('#bm-side-list'), 'dragover', { x: 0, y: 50 });
  check('竖栏落点用的是横线标记（不是竖线）', !!$('#bm-side-list .bm-side-item.bm-drop-above'));
  // 落点以**最后一次 dragover** 为准（真实拖拽会连续触发很多次），
  // 所以挪到末尾要再发一次 —— 只发 drop 不会重新算落点。
  drag($('#bm-side-list'), 'dragover', { x: 0, y: 999 });
  drag($('#bm-side-list'), 'drop', { x: 0, y: 999 });
  await sleep(120);
  check('竖栏：A 拖到最末（说明按 clientY 算，没串到横轴）',
    order().join(',') === 'https://b.test/,https://c.test/,https://a.test/', order().join(','));

  // --- 设置页书签列表：同样能拖
  setBms(ABC);
  window.eval("state.settings.bookmarkBarPos = 'top'; renderBookmarkBar(true)");
  window.eval("openSettings('bookmarks')");
  await waitFor(() => $('#bm-manage-list'));
  let rows = $$('#bm-manage-list .bm-manage-row');
  check('设置页书签行可拖动', rows.length === 3 && rows.every((el) => el.getAttribute('draggable') === 'true'),
    String(rows.length));
  check('设置页每行有拖动手柄记号', $$('#bm-manage-list .bm-grip').length === 3);
  check('设置页行用的是独立属性（不撞全局 [data-bm] 点击，否则会导航两次）',
    rows[0].getAttribute('data-bmorder') === rows[0].getAttribute('data-url')
    && rows[0].getAttribute('data-bm') === null);
  rows.forEach((el, i) => rect(el, { y: i * 40, h: 40 }));
  drag(rows[2], 'dragstart');
  drag($('#bm-manage-list'), 'dragover', { x: 0, y: 10 }); // 越过第一行中线(20)? 是 → 插到最前
  drag($('#bm-manage-list'), 'drop', { x: 0, y: 10 });
  await sleep(150);
  check('设置页：C 拖到最前',
    order().join(',') === 'https://c.test/,https://a.test/,https://b.test/', order().join(','));
  check('设置页：拖完就地重画，首行跟着变',
    $$('#bm-manage-list .bm-manage-row')[0].getAttribute('data-bmorder') === 'https://c.test/');
  check('设置页：列表只有一个（重画是替换，不是再插一份）', $$('#bm-manage-list').length === 1);

  window.eval('closeSettings()');
  await sleep(60);

  console.log('\n[S] 锁定收藏夹栏');

  setBms(ABC);
  setMode('always');
  window.eval("state.settings.bookmarkLocked = false; state.settings.bookmarkBarPos = 'top'; renderBookmarkBar(true)");
  await sleep(80);
  check('解锁时横栏每格都有拖动手柄', $$('#bm-track .bm-grip-x').length === 3,
    String($$('#bm-track .bm-grip-x').length));
  check('解锁时条目可拖', $$('#bm-track .bm-item').every((el) => el.getAttribute('draggable') === 'true'));

  // 锁上：手柄消失、draggable 关掉
  window.eval('setBmLock(true)');
  await sleep(140);
  check('锁定写进设置', window.eval('state.settings.bookmarkLocked') === true);
  check('锁定后手柄消失', $$('#bm-track .bm-grip-x').length === 0,
    String($$('#bm-track .bm-grip-x').length));
  check('锁定后条目不再是 draggable',
    $$('#bm-track .bm-item').every((el) => el.getAttribute('draggable') === 'false'));

  // 锁定状态下拖拽必须一步都不动（第二道闸在 dragstart 里）
  const lkItems = $$('#bm-track .bm-item');
  lkItems.forEach((el, i) => rect(el, { x: i * 100, w: 100 }));
  drag(lkItems[0], 'dragstart');
  drag($('#bm-track'), 'dragover', { x: 240 });
  drag($('#bm-track'), 'drop', { x: 240 });
  await sleep(140);
  check('锁定时拖不动，顺序一点没变',
    order().join(',') === 'https://a.test/,https://b.test/,https://c.test/', order().join(','));

  // 锁定状态下也不许改位置（三个入口共用 applyBmBarPos 里那道闸）
  window.eval("applyBmBarPos('left')");
  await sleep(120);
  check('锁定时改不了位置', window.eval('state.settings.bookmarkBarPos') === 'top',
    window.eval('state.settings.bookmarkBarPos'));
  check('锁定时视口也没被切', !$('#viewport').classList.contains('bm-bar-side'));

  // 解锁：手柄回来、拖拽与改位置都恢复
  window.eval('setBmLock(false)');
  await sleep(140);
  check('解锁后手柄回来了', $$('#bm-track .bm-grip-x').length === 3,
    String($$('#bm-track .bm-grip-x').length));
  window.eval("applyBmBarPos('left')");
  await sleep(140);
  check('解锁后能改位置', window.eval('state.settings.bookmarkBarPos') === 'left',
    window.eval('state.settings.bookmarkBarPos'));

  // 竖栏也有手柄
  window.eval("state.settings.bookmarkBarPos = 'right'; renderBookmarkBar(true)");
  await sleep(110);
  check('竖栏条目也有手柄', $$('#bm-side-list .bm-grip-y').length === 3,
    String($$('#bm-side-list .bm-grip-y').length));
  window.eval("state.settings.bookmarkBarPos = 'top'; renderBookmarkBar(true)");
  await sleep(80);

  // 顶栏下拉里的锁开关
  $('#qk-bmbar').click();
  await sleep(80);
  const qkLock = $('#qk-bm-lock');
  check('顶栏下拉里有锁定开关', !!qkLock);
  check('开关当前是「未锁」', !!qkLock && !qkLock.classList.contains('is-on'));
  qkLock.click();
  await sleep(160);
  check('点一下锁上（设置与开关状态都跟上）',
    window.eval('state.settings.bookmarkLocked') === true && qkLock.classList.contains('is-on'));
  qkLock.click();
  await sleep(160);
  check('再点一下解锁', window.eval('state.settings.bookmarkLocked') === false);
  $('#qk-bmbar').click();
  await sleep(60);

  // 设置页「书签」分区里的锁开关
  window.eval("openSettings('bookmarks')");
  await waitFor(() => $('#settings-body [data-bmlock]'));
  const swLock = $('#settings-body [data-bmlock]');
  check('书签分区有锁定开关', !!swLock);
  swLock.click();
  await sleep(170);
  check('设置页的开关也真的锁上', window.eval('state.settings.bookmarkLocked') === true);
  window.eval('setBmLock(false)');
  window.eval('closeSettings()');
  await sleep(80);

  console.log('\n[R] 运行时错误');

  check('走完这套全流程仍无异常', errors.length === 0, errors.join(' | ') || '无');
  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n测试自身崩了：', err);
  process.exit(2);
});
