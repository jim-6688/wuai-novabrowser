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
  check('地址栏也跟着变了',
    $('#omni-input').value === 'https://example.com/a', $('#omni-input').value);

  console.log('\n[D] 右键移出');

  setBms([
    { title: 'A', url: 'https://a.test/' },
    { title: 'B', url: 'https://b.test/' }
  ]);
  Right(items().find((el) => el.dataset.bm === 'https://a.test/'));
  await sleep(60);
  check('书签少了一条', window.eval('state.bookmarks.length') === 1,
    window.eval('state.bookmarks.map(b=>b.url).join(",")'));
  check('留下的正好是另一条', window.eval('state.bookmarks[0].url') === 'https://b.test/');
  check('栏里那一格跟着消失',
    items().length === 1 && items()[0].dataset.bm === 'https://b.test/');

  console.log('\n[E] 星标与这条栏说的是同一件事');

  setBms([{ title: 'A', url: 'https://a.test/' }]);
  window.eval("navigate(state.activeId, 'https://a.test/')");
  window.eval('syncStarButton()');
  check('当前页已在书签里 → 星标实心', $('#omni-star').classList.contains('is-on'));
  check('星标的 title 同步改成「已在书签里」',
    ($('#omni-star').getAttribute('title') || '').includes('已在书签里'));

  Right(items()[0]);
  await sleep(60);
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

  console.log('\n[J] 设置页里的档位控件');

  window.eval("openSettings('appearance')");
  await waitFor(() => $('#set-bmbar'));
  const btns = $$('#set-bmbar button');
  check('外观分区里有四档（含侧边栏）', btns.length === 4,
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

  // 侧边栏档：横向栏收起、视口加 bm-side（网页让位）、竖向列表出现
  byMode('side').click();
  await sleep(100);
  check('侧边栏：写进设置', window.eval('state.settings.bookmarkBar') === 'side');
  check('侧边栏：横向栏收起', bar.hidden);
  check('侧边栏：视口加上 bm-side（网页让位）', $('#viewport').classList.contains('bm-side'));
  check('侧边栏：竖向列表有条目', $$('#bm-side-list [data-bm]').length > 0);

  byMode('always').click();
  await sleep(80);
  check('点回「地址栏下方」后恢复', !bar.hidden);
  check('侧边栏：撤回后视口去掉 bm-side', !$('#viewport').classList.contains('bm-side'));
  check('设置值也回到 always', window.eval('state.settings.bookmarkBar') === 'always');
  window.eval('closeSettings()');

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

  console.log('\n[R] 运行时错误');

  check('走完这套全流程仍无异常', errors.length === 0, errors.join(' | ') || '无');

  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n测试自身崩了：', err);
  process.exit(2);
});
