'use strict';
/**
 * 内核选择器行为测试（真实 DOM，jsdom）
 * 用法：node tools/test-engine-menu.js
 * 验证：地址栏右端徽标 → 下拉 → 点选切换内核 → 关闭行为 → 移动端走底部分层
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * 解析 jsdom：优先项目内 node_modules，其次 WorkBuddy 隔离运行区（本机把依赖装在隔离目录，
 * 不污染用户环境），最后给出可执行的安装指引而不是抛一句看不懂的 MODULE_NOT_FOUND。
 */
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

  // 等 init() 完成（renderEngineSwitch 会往 #engine-menu-list 里填项）
  for (let i = 0; i < 60 && $$('#engine-menu-list .em-item').length === 0; i++) await sleep(50);

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));

  console.log('\n[A] 初始渲染');
  const items = $$('#engine-menu-list .em-item');
  check('内核下拉渲染出 3 项', items.length === 3, `实际 ${items.length}`);
  check('面板初始为关闭', $('#engine-menu').hidden === true);
  check('触发器 aria-expanded=false', $('#omni-engine').getAttribute('aria-expanded') === 'false');
  check('徽标停在地址栏右端（最后一个可见控件）', (() => {
    const kids = [...$('#omnibox').children].map((c) => c.id || c.className);
    // 期望顺序：锁 → 输入框 → 书签 → 分隔线 → 内核徽标 → 下拉面板 → 分享面板。
    // 末尾的 omni-share 是 position:absolute 的弹出层（默认 hidden、不占弹性布局），
    // 所以内核徽标仍是视觉上最右的那个常驻控件 —— 这里只把 DOM 顺序补上它。
    return kids.join(',') === 'omni-lock,omni-input,omni-star,ow-divider,omni-engine,engine-menu,omni-share';
  })(), [...$('#omnibox').children].map((c) => c.id || c.className).join(' → '));
  check('徽标本体在面板之前', (() => {
    const kids = [...$('#omnibox').children];
    return kids.findIndex((c) => c.id === 'omni-engine') < kids.findIndex((c) => c.id === 'engine-menu');
  })());
  check('当前内核项被标为选中', items.filter((b) => b.classList.contains('is-active')).length === 1
        && items.find((b) => b.classList.contains('is-active')).dataset.engine === 'chromium');
  check('每项都自述模式（原生/兼容层标签）', items.every((b) => b.querySelector('.mode-pill')), 
        items.map((b) => b.querySelector('.mode-pill').textContent.trim()).join(' / '));
  check('兼容层两项带 compat 样式标签', $$('#engine-menu-list .mode-pill.mode-compat').length === 2);
  check('工具栏里不再有旧分段控件', !$('.toolbar .engine-switch') && !$('.toolbar #engine-switch'));

  console.log('\n[B] 点开下拉');
  $('#omni-engine').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('点击徽标后面板展开', $('#engine-menu').hidden === false);
  check('aria-expanded 同步为 true', $('#omni-engine').getAttribute('aria-expanded') === 'true');

  console.log('\n[C] 点选内核 → 切换');
  const before = window.eval('state.tabs.find(t => t.id === state.activeId).engineId');
  const ieBtn = items.find((b) => b.dataset.engine === 'trident');
  ieBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  const after = window.eval('state.tabs.find(t => t.id === state.activeId).engineId');
  check('标签页内核已从 chromium 切到 trident', before === 'chromium' && after === 'trident', `${before} -> ${after}`);
  check('切换后面板自动关闭', $('#engine-menu').hidden === true);
  check('徽标文字变为 IE', $('#omni-engine-short').textContent === 'IE');
  check('徽标标记为兼容层（is-compat）', $('#omni-engine').classList.contains('is-compat'),
        '兼容层不被画成真内核');
  check('下拉选中态跟着走', $$('#engine-menu-list .em-item.is-active')[0].dataset.engine === 'trident');
  check('弹出降级提示条', $('#engine-notice').hidden === false,
        ($('#engine-notice-text').textContent || '').slice(0, 34) + '…');
  check('URL 保持不变（切内核不丢页面）',
        window.eval('state.tabs.find(t => t.id === state.activeId).url') === 'https://52ta.top/');

  console.log('\n[D] 关闭行为');
  $('#omni-engine').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('再次点击徽标可展开', $('#engine-menu').hidden === false);
  $('#omni-engine').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('第三次点击收起（toggle）', $('#engine-menu').hidden === true);

  $('#omni-engine').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  doc.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('点击别处关闭', $('#engine-menu').hidden === true);

  $('#omni-engine').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('按 Esc 关闭', $('#engine-menu').hidden === true);

  console.log('\n[E] 切回原生内核');
  $('#omni-engine').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  $$('#engine-menu-list .em-item').find((b) => b.dataset.engine === 'chromium')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(30);
  check('内核回到 chromium', window.eval('state.tabs.find(t => t.id === state.activeId).engineId') === 'chromium');
  check('徽标恢复原生配色（无 is-compat）', !$('#omni-engine').classList.contains('is-compat'));
  check('原生内核下提示条隐藏', $('#engine-notice').hidden === true);

  console.log('\n[F] 移动端改走底部分层');
  window.eval("state.settings.layout = 'mobile'; applyLayout();");
  check('布局已切到 mobile', doc.documentElement.dataset.layout === 'mobile');
  $('#omni-engine').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('点徽标唤起底部弹层（而非桌面下拉）', $('#engine-sheet').hidden === false);
  check('桌面下拉保持关闭', $('#engine-menu').hidden === true);
  check('弹层里也有 3 个内核卡', $$('#engine-cards .engine-card').length === 3);
  $('#engine-sheet').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('点遮罩关闭弹层', $('#engine-sheet').hidden === true);

  console.log('\n[G] 样式确实生效（外部样式表已加载）');
  // 上一节把布局切到了 mobile，这一节断言的是桌面端行为，先切回来
  window.eval("state.settings.layout = 'desktop'; applyLayout();");
  const cs = (sel, prop) => window.getComputedStyle($(sel))[prop];
  check('shell.css 已加载', cs('.omnibox', 'display') === 'flex', 'display=' + cs('.omnibox', 'display'));
  check('地址栏是下拉的定位锚点', cs('#omnibox', 'position') === 'relative',
        'position=' + cs('#omnibox', 'position'));
  check('面板绝对定位于地址栏下方', cs('#engine-menu', 'position') === 'absolute' && cs('#engine-menu', 'right') === '0px',
        `position=${cs('#engine-menu', 'position')} right=${cs('#engine-menu', 'right')}`);
  check('面板 z-index 高于抽屉(40)/遮罩(30)', Number(cs('#engine-menu', 'zIndex')) > 40,
        'z-index=' + cs('#engine-menu', 'zIndex'));
  // 高度用的是字面量，能证明桌面规则生效、且没被移动端规则(26px)串到
  check('桌面端徽标高度 24px（非移动端 26px）', cs('#omni-engine', 'height') === '24px',
        'height=' + cs('#omni-engine', 'height'));
  check('下拉项是横向 flex 行', cs('#engine-menu-list .em-item', 'display') === 'flex',
        'display=' + cs('#engine-menu-list .em-item', 'display'));
  // 关/开 由 hidden 属性控制 → 必须真的不显示
  check('关闭时面板 display:none', cs('#engine-menu', 'display') === 'none',
        'display=' + cs('#engine-menu', 'display'));
  $('#omni-engine').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('展开时面板真的显示出来', cs('#engine-menu', 'display') === 'block',
        'display=' + cs('#engine-menu', 'display'));
  $('#omni-engine').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('收起后回到 display:none', cs('#engine-menu', 'display') === 'none');

  console.log('\n[H] 运行时错误');
  check('渲染层无未捕获异常', errors.length === 0, errors.join(' | ') || '无');

  console.log('\n[I] 设置页 · 内核分区');
  window.eval("openSettings('engines')");
  const body = $('#settings-body');
  const txt = body.textContent;

  check('设置页已展开（不再是抽屉）', $('#settings-view').hidden === false);
  check('左导航标出当前分区', (() => {
    const a = $('#settings-nav .sv-nav-item.is-active');
    return a && a.dataset.sec === 'engines';
  })(), ($('#sv-path') || {}).textContent);
  check('旧的抽屉式设置面板已移除', window.eval("typeof renderSettingsPanel") === 'undefined');
  check('面板已渲染内核二进制区块', body.querySelector('.kb-group') !== null);
  check('三个内核各有一组', body.querySelectorAll('.kb-group').length === 3,
        '实际 ' + body.querySelectorAll('.kb-group').length + ' 组');
  check('列出 5 个发行版（2 Chromium + 2 Gecko + 1 Trident）',
        body.querySelectorAll('.kb-src').length === 5,
        '实际 ' + body.querySelectorAll('.kb-src').length + ' 个');
  check('没有 is-missing（本次全部就位）',
        body.querySelectorAll('.kb-src.is-missing').length === 0);
  check('Chromium 标注为原生桥接就绪态', /Electron 30\.5\.1/.test(txt) && /CEF 154\.0\.34/.test(txt));
  check('Gecko 显示 32 位约束（x86）', /x86 \(I386\)/.test(txt));
  check('Gecko 两条发行版都在列', /XULRunner 45\.0\.0\.5873/.test(txt) && /XULRunner 41\.0\.2/.test(txt));
  check('Trident 标为系统组件', /Windows 内置 MSHTML/.test(txt));
  check('显示 PE 特征识别结果', /Gecko \/ XULRunner \(XPCOM\)/.test(txt) && /Trident \/ MSHTML \(IE\)/.test(txt));
  check('显示文件数与体积', /32 文件 \/ 74 MB/.test(txt), txt.match(/\d+ 文件 \/ \d+ MB/)?.[0] || '未找到');
  check('列出阻塞原因（缺宿主）', body.querySelectorAll('.kb-note').length === 2,
        '实际 ' + body.querySelectorAll('.kb-note').length + ' 条');
  check('保留「重新探测」入口', body.querySelector('[data-act="probe-engine"]') !== null);
  check('列出了抓取与校验命令', /fetch-engines\.sh/.test(txt) && /check-engines\.js/.test(txt));

  // 样式确实生效。注意：jsdom 不解析 var()，凡值里带变量的简写属性一律取不到，
  // 所以「纯字面量属性」用计算样式断言，「含变量的规则」改对 CSS 源文本断言。
  const cs2 = (sel, prop) => window.getComputedStyle(body.querySelector(sel))[prop];
  check('架构标签 padding 生效（纯字面量）', cs2('.kb-arch', 'paddingLeft') === '6px',
        'padding-left=' + cs2('.kb-arch', 'paddingLeft'));

  const cssText = fs.readFileSync(path.join(root, 'src/renderer/shell.css'), 'utf8');
  const rule = (sel) => {
    const esc = sel.replace(/[.-]/g, (c) => '\\' + c);
    const m = cssText.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
  };
  check('CSS 定义 .kb-group 下边框', /border-bottom:\s*1px solid var\(--border\)/.test(rule('.kb-group')), rule('.kb-group'));
  check('CSS 定义 .kb-arch 胶囊圆角', /border-radius:\s*var\(--r-pill\)/.test(rule('.kb-arch')), rule('.kb-arch'));
  check('CSS 定义 .kb-note 橙色警示左边', /border-left:\s*2px solid var\(--warn\)/.test(rule('.kb-note')), rule('.kb-note'));
  check('CSS 定义 .ok-text / .warn-text 语义色',
        /color:\s*var\(--ok\)/.test(rule('.ok-text')) && /color:\s*var\(--warn\)/.test(rule('.warn-text')),
        rule('.ok-text') + ' | ' + rule('.warn-text'));
  check('CSS 定义 .kb-meta 等宽字体', /font-family:\s*var\(--font-mono\)/.test(rule('.kb-meta')), rule('.kb-meta'));
  check('CSS 定义 .is-missing 降透明度', /opacity:\s*0?\.55/.test(rule('.kb-src.is-missing')), rule('.kb-src.is-missing'));

  console.log('\n[J] 运行时错误（二）');
  check('渲染内核面板后仍无异常', errors.length === 0, errors.join(' | ') || '无');

  console.log('\n[K] 广告拦截分区 · 三个拦截源');
  $('#btn-shield').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(50);

  check('盾牌按钮把设置页切到拦截分区', (() => {
    const a = $('#settings-nav .sv-nav-item.is-active');
    return a && a.dataset.sec === 'adblock' && $('#settings-view').hidden === false;
  })());

  const cards = $$('.src-card');
  check('渲染出 3 张拦截源卡片', cards.length === 3, `实际 ${cards.length}`);
  check('源名称与顺序正确',
        cards.map((c) => c.querySelector('.src-name').textContent.trim()).join(' | ')
          === '广告终结者 | Adblock Plus | 系统内置拦截器',
        cards.map((c) => c.querySelector('.src-name').textContent.trim()).join(' | '));
  check('每张卡片都有独立开关', cards.every((c) => c.querySelector('.switch')));
  check('每个源都标注了厂商/来源',
        cards.every((c) => (c.querySelector('.src-vendor') || {}).textContent.trim()));
  check('规则数按千分位显示（121,936）', /121,936/.test(cards[1].textContent),
        cards[1].querySelector('.src-metrics').textContent.replace(/\s+/g, ' ').trim());
  check('每张卡片列出所属规则列表', $$('.src-card .src-list').length >= 5,
        `${$$('.src-card .src-list').length} 条子列表`);
  check('广告终结者如实标注订阅域已停服',
        ($('.src-card[data-src="adtchrome"] .src-note') || { textContent: '' }).textContent.includes('停服'),
        ($('.src-card[data-src="adtchrome"] .src-note') || { textContent: '' }).textContent.slice(0, 40));
  check('顶部统计含「本次会话已拦截」', /本次会话已拦截/.test($('#settings-body').textContent));
  check('保留总开关与拦截强度', !!$('#settings-body [data-toggle="enabled"]') && !!$('#ab-level'));

  console.log('\n[L] 拦截源开关交互');
  const swOf = (id) => $(`.src-card[data-src="${id}"] .switch`);
  const wasOn = swOf('abp').classList.contains('is-on');
  swOf('abp').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  check('点击开关后状态取反', swOf('abp').classList.contains('is-on') !== wasOn,
        `${wasOn} → ${swOf('abp').classList.contains('is-on')}`);
  check('停用的源卡片带 .is-off 降透明度标记',
        $('.src-card[data-src="abp"]').classList.contains('is-off'));
  check('其它源不受影响', swOf('adtchrome').classList.contains('is-on'));
  swOf('abp').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  check('再点一次恢复启用', swOf('abp').classList.contains('is-on') === wasOn);

  console.log('\n[M] 拦截源样式');
  check('CSS 定义 .src-card 容器', /var\(--sp-4\)/.test(rule('.src-card')), rule('.src-card'));
  check('CSS 定义 .src-card.is-off 降透明度', /opacity/.test(rule('.src-card.is-off')), rule('.src-card.is-off'));
  check('CSS 定义 .src-metrics 虚线分隔', /border-top:\s*1px dashed/.test(rule('.src-metrics')), rule('.src-metrics'));
  check('CSS 定义 .src-note 橙色警示边', /border-left:\s*2px solid var\(--warn\)/.test(rule('.src-note')), rule('.src-note'));
  check('CSS 定义 .src-list 等宽计数', /font-family:\s*var\(--font-mono\)/.test(rule('.src-list .sl-count')), rule('.src-list .sl-count'));

  console.log('\n[N] 运行时错误（三）');
  check('渲染拦截面板后仍无异常', errors.length === 0, errors.join(' | ') || '无');

  /* ---------------- 全屏设置页 ---------------- */

  const navItems = () => $$('#settings-nav .sv-nav-item');
  const clickNav = (sec) => navItems().find((x) => x.dataset.sec === sec)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  console.log('\n[O] 设置页 · 导航与分区切换');
  check('左导航 11 个分区（PC 档位不列「移动端」）', navItems().length === 11, `实际 ${navItems().length}`);
  check('导航分成 3 组', $$('#settings-nav .sv-nav-group').length === 3);
  check('PC 档位下导航里没有「移动端」分区',
        !navItems().some((b) => b.dataset.sec === 'mobile'),
        navItems().map((b) => b.dataset.sec).join(','));
  check('分区顺序与 id 正确',
        navItems().map((b) => b.dataset.sec).join(',') ===
        'general,appearance,engines,adblock,sniffer,extensions,bookmarks,history,downloads,privacy,about',
        navItems().map((b) => b.dataset.sec).join(','));
  check('拦截源角标显示 3/3', /3\/3/.test($('#settings-nav').textContent));

  clickNav('appearance');
  check('切到外观：路径标签与正文同步',
        $('#sv-path').textContent === '外观' && !!$('#settings-body #set-layout') && !!$('#settings-body #set-theme'),
        $('#sv-path').textContent);
  check('外观分区含布局三档', $$('#settings-body #set-layout button').length === 3);

  clickNav('privacy');
  check('隐私与数据含四类清理入口',
        ['clear-history', 'clear-bookmarks', 'clear-site-data', 'reset-stats']
          .every((a) => !!$(`#settings-body [data-act="${a}"]`)));
  check('隐私与数据含恢复默认设置', !!$('#settings-body [data-act="restore-defaults"]'));
  check('如实标注未实现项（不摆假开关）', /relaxThirdParty/.test($('#settings-body').textContent));

  clickNav('about');
  check('关于分区显示运行时版本表',
        /Electron/.test($('#settings-body').textContent) && !!$('#settings-body .kv'));

  console.log('\n[P] 补齐的设置项');
  clickNav('general');
  const gen = $('#settings-body');
  check('常规分区有主页输入框与自定义新标签页地址',
        !!gen.querySelector('#set-homepage') && !!gen.querySelector('#set-newtab'));
  check('新标签页有三种档位（内置 / 主页 / 空白）',
        ['newtab-builtin', 'newtab-homepage', 'newtab-blank']
          .every((a) => !!gen.querySelector(`[data-act="${a}"]`)));
  check('新标签页默认落在「内置」那一档',
        gen.querySelector('[data-act="newtab-builtin"]').classList.contains('is-active'),
        gen.querySelector('[data-act="newtab-builtin"]').className);
  check('默认档位不是「跟随主页」，所以那个按钮可用',
        gen.querySelector('[data-act="newtab-same"]').disabled === false);
  check('搜索模板回填当前值',
        gen.querySelector('#set-search').value === 'https://www.baidu.com/s?wd=%s',
        gen.querySelector('#set-search').value);
  check('搜索预设 3 档', gen.querySelectorAll('#set-search-preset button').length === 3);
  check('会话恢复开关存在', !!gen.querySelector('[data-cfg="restoreSession"]'));
  check('默认内核三档', gen.querySelectorAll('#set-engine button').length === 3);

  [...gen.querySelectorAll('#set-search-preset button')].find((b) => b.textContent.trim() === '必应')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  check('点「必应」后模板写入设置',
        window.eval('state.settings.searchTemplate') === 'https://www.bing.com/search?q=%s',
        window.eval('state.settings.searchTemplate'));
  check('地址栏搜索改用新模板', /bing\.com/.test(window.eval("searchUrl('nova')")),
        window.eval("searchUrl('nova')"));

  clickNav('bookmarks');
  await sleep(30);
  // 数量跟着预览桥里的示例书签走，不写死 —— 那几条是配置初值（新标签页宫格
  // 里的六个内置入口），以后增减一次就要来这儿改一次数字，属于白挨的维护。
  const bmCount = $$('#settings-body .list-row[data-url]').length;
  check('书签分区把配置里的书签都列出来了',
        bmCount > 0 && bmCount === window.eval('state.settings.bookmarks.length'),
        `界面 ${bmCount} / 配置 ${window.eval('state.settings.bookmarks.length')}`);
  check('每条书签带删除按钮', $$('#settings-body [data-unbookmark]').length === bmCount);
  check('书签分区有「把当前页加入书签」', !!$('#settings-body [data-act="bookmark-current"]'));

  $$('#settings-body [data-unbookmark]')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(50);
  check('删除后少了一条', $$('#settings-body .list-row[data-url]').length === bmCount - 1,
        `实际 ${$$('#settings-body .list-row[data-url]').length}`);

  clickNav('history');
  await sleep(60);
  check('历史分区（异步）渲染出 4 条', $$('#settings-body .hist-row').length === 4,
        `实际 ${$$('#settings-body .hist-row').length}`);
  check('历史分区保留清空入口', !!$('#settings-body [data-act="clear-history"]'));

  console.log('\n[Q] hidden 属性回归');
  window.eval('closeSettings()');
  check('关闭后设置页 hidden=true', $('#settings-view').hidden === true);
  check('关闭后计算样式为 none', window.getComputedStyle($('#settings-view')).display === 'none',
        'display=' + window.getComputedStyle($('#settings-view')).display);

  // 关键回归。真实 Chromium 里作者样式表的 display:flex 会盖掉 UA 的 [hidden]{display:none}，
  // 于是 .tab-grid / .sheet 这种「position:fixed + inset:0」的覆盖层带 hidden 也照样铺满窗口
  // —— 已用 Electron 30 实测确认（npm run check:hidden 是那条权威探针）。
  // 这里断言两条引擎无关的不变式：全局兜底规则存在，且所有会设 display 的覆盖层都带守卫。
  check('样式表有全局 [hidden] 兜底且带 !important',
        /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/.test(cssText),
        (cssText.match(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/) || [''])[0].replace(/\s+/g, ' ').trim());
  for (const cls of ['tab-grid', 'sheet', 'empty-state', 'engine-notice', 'settings-view']) {
    check(`.${cls} 带 :not([hidden]) 守卫`,
          new RegExp('\\.' + cls + ':not\\(\\[hidden\\]\\)').test(cssText));
  }
  // 守卫生效 → 这四类覆盖层带 hidden 时，元素根本不匹配任何 display 规则
  for (const sel of ['#tab-grid', '#engine-sheet', '#empty-state', '#settings-view']) {
    check(`${sel} 带 hidden 时计算样式为 none`,
          window.getComputedStyle($(sel)).display === 'none',
          'display=' + window.getComputedStyle($(sel)).display);
  }

  console.log('\n[R] 运行时错误（四）');
  check('走完设置页全流程仍无异常', errors.length === 0, errors.join(' | ') || '无');

  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
