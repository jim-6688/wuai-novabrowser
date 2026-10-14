'use strict';

/**
 * 移动端阅读增强 · 界面行为测试（真实 DOM，jsdom）
 * 用法：node tools/test-mobile-ui.js
 *
 * 这一层验界面：移动端设置分区画没画对、三档分段有没有把档位写回配置、
 * 计数有没有如实展示、自动拼页的开关与页数有没有落到配置、
 * 底栏「阅读」入口与菜单入口能不能打开弹层、弹层里的操作有没有接对桥。
 *
 * 判定逻辑由 tools/test-nomedia.js 在纯 Node 下验，
 * 拼页算法与注入流程由 tools/test-autopage.js 在 jsdom 里验，
 * 「图片请求是不是真的没发出去」由 tools/test-mobile-electron.js 在真机验。
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

  for (let i = 0; i < 60 && $$('#engine-menu-list .em-item').length === 0; i++) await sleep(50);

  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const openMobile = async () => {
    // 「移动端」这一分区只在窄屏档位下列出来 —— 宽屏下它管的那两项（无图
    // 模式、自动拼页）根本不生效，导航里就不摆它。所以先把外壳切到窄档再
    // 开这一页；不切的话 openSettings('mobile') 会被兜底到常规，后面一整
    // 套断言就都在对着一张空页发问。
    window.eval("state.settings.layout = 'mobile'; applyLayout(); openSettings('mobile')");
    await sleep(40);
  };

  /* 记录所有写回配置的调用，用来断言「哪些操作该落盘、哪些不该」 */
  const patchCalls = [];
  const origPatch = window.nova.settings.patch;
  window.nova.settings.patch = async (p) => { patchCalls.push(p); return origPatch(p); };

  /* ---------------- */

  console.log('\n[A] 移动端分区渲染');

  await openMobile();
  check('分区标题正确', $('#sv-path').textContent === '移动端', $('#sv-path').textContent);
  check('分区分成 4 组配置',
        !!$('#settings-body #nm-level') && !!$('#settings-body #ap-max')
        && !!$('#settings-body [data-ap="autoPage"]')
        && !!$('#settings-body [data-act="nm-reset"]'));
  check('分区没冒充成真实统计（说明了只有条数没有字节）',
        /Content-Length/.test($('#settings-body').textContent));

  console.log('\n[B] 无图模式三档');

  const levels = $$('#settings-body #nm-level button');
  check('三个档位按钮', levels.length === 3, String(levels.length));
  check('档位 id 与主进程一致',
        levels.map((b) => b.dataset.level).join(',') === 'off,image,image-av',
        levels.map((b) => b.dataset.level).join(','));
  check('档位名与主进程一致',
        levels.map((b) => b.textContent).join(',') === '关闭,无图,无图 + 视频',
        levels.map((b) => b.textContent).join(','));
  check('当前档位（预览桩里是 image）处于选中态',
        levels.filter((b) => b.classList.contains('is-active')).map((b) => b.dataset.level).join(',') === 'image');
  check('说明里点出了「切换会重载」',
        /重载/.test($('#settings-body #nm-level').parentElement.textContent));

  patchCalls.length = 0;
  click(levels.find((b) => b.dataset.level === 'off'));
  await sleep(40);
  check('点「关闭」把档位写回配置',
        patchCalls.some((p) => p.mobile && p.mobile.noImage === 'off'),
        JSON.stringify(patchCalls[0] || null));
  check('选中态跟着换到「关闭」',
        $('#settings-body #nm-level button.is-active').dataset.level === 'off',
        $('#settings-body #nm-level button.is-active').dataset.level);

  await sleep(20);
  const offBtn = $$('#settings-body #nm-level button').find((b) => b.dataset.level === 'off');
  click(offBtn);
  await sleep(30);
  check('点已选中的档位不重复落盘',
        patchCalls.filter((p) => p.mobile && p.mobile.noImage === 'off').length === 1,
        String(patchCalls.filter((p) => p.mobile && p.mobile.noImage === 'off').length));

  patchCalls.length = 0;
  const avBtn = $$('#settings-body #nm-level button').find((b) => b.dataset.level === 'image-av');
  click(avBtn);
  await sleep(40);
  check('切到「无图 + 视频」能落盘',
        patchCalls.some((p) => p.mobile && p.mobile.noImage === 'image-av'),
        JSON.stringify(patchCalls[0] || null));

  console.log('\n[C] 拦截计数');

  const kvText = $$('#settings-body .kv').map((r) => r.textContent.replace(/\s+/g, '')).join('|');
  check('展示图片条数', /图片121/.test(kvText), kvText);
  check('展示音视频条数', /音视频7/.test(kvText), kvText);
  check('展示当前标签页条数', /当前标签页34/.test(kvText), kvText);

  const resetCalls = { n: 0 };
  const origReset = window.nova.mobile.resetStats;
  window.nova.mobile.resetStats = async () => { resetCalls.n += 1; return origReset(); };
  click($('#settings-body [data-act="nm-reset"]'));
  await sleep(40);
  check('「重置计数」接到了桥上', resetCalls.n === 1, String(resetCalls.n));

  console.log('\n[D] 自动拼页');

  const apSwitch = $('#settings-body [data-ap="autoPage"]');
  check('有自动拼页开关', !!apSwitch);
  check('预览桩里它是开着的', apSwitch.classList.contains('is-on'));

  patchCalls.length = 0;
  click(apSwitch);
  await sleep(40);
  check('关掉自动拼页落盘',
        patchCalls.some((p) => p.mobile && p.mobile.autoPage === false),
        JSON.stringify(patchCalls[0] || null));

  const maxBtns = $$('#settings-body #ap-max button');
  check('三个页数档', maxBtns.length === 3, String(maxBtns.length));
  check('页数档是 5/10/20', maxBtns.map((b) => b.dataset.max).join(',') === '5,10,20',
        maxBtns.map((b) => b.dataset.max).join(','));

  patchCalls.length = 0;
  click(maxBtns.find((b) => b.dataset.max === '20'));
  await sleep(40);
  check('改上限落盘',
        patchCalls.some((p) => p.mobile && p.mobile.autoPageMax === 20),
        JSON.stringify(patchCalls[0] || null));
  check('上限说明点出了「防呆」的用意',
        /防呆/.test($('#settings-body #ap-max').parentElement.textContent));

  console.log('\n[E] 边界如实说明，不摆假开关');

  const mb = $('#settings-body').textContent;
  check('说明了字体不会被拦', /字体不会被拦/.test(mb));
  check('说明了标签页图标是启发式放行', /启发式/.test(mb) && /favicon/.test(mb));
  check('说明了跨域分页会失败', /跨域/.test(mb) && /CORS/.test(mb));
  check('没有「省下多少 MB」这种编出来的指标',
        !/\d+(\.\d+)?\s*MB/.test(mb) && !/\d+(\.\d+)?\s*KB/.test(mb));
  check('反而把「为什么给不出字节数」讲清楚了',
        /Content-Length/.test(mb) && /编的/.test(mb));

  console.log('\n[F] 底栏「阅读」入口');

  check('底栏有阅读按钮', !!$('#mb-read'));
  check('底栏按钮顺序含阅读',
        $$('.mobilebar .mb-btn').map((b) => b.id).join(',') === 'mb-back,mb-forward,mb-tabs,mb-engine,mb-read,mb-menu',
        $$('.mobilebar .mb-btn').map((b) => b.id).join(','));
  check('阅读按钮有图标与文字',
        !!$('#mb-read svg') && /阅读/.test($('#mb-read').textContent));
  check('阅读按钮默认在底栏（移动端靠布局规则显示）',
        !!$('#read-sheet'));

  console.log('\n[G] 阅读弹层');

  check('弹层初始是隐藏的', $('#read-sheet').hidden === true);
  click($('#mb-read'));
  await sleep(60);
  check('点底栏「阅读」打开弹层', $('#read-sheet').hidden === false);
  check('弹层里有标题', /阅读增强/.test($('#read-sheet').textContent));
  check('弹层里有三档无图', $$('#read-sheet #rs-nm button').length === 3,
        String($$('#read-sheet #rs-nm button').length));
  check('弹层里有拼页开关', !!$('#read-sheet [data-ap="autoPage"]'));
  check('弹层里有页数档', $$('#read-sheet #rs-apmax button').length === 3);
  check('弹层里报了本次拦截条数', /本次已拦/.test($('#read-sheet').textContent));
  check('弹层里提到了状态条上的停止/撤销',
        /停止/.test($('#read-sheet').textContent) && /撤销/.test($('#read-sheet').textContent));

  patchCalls.length = 0;
  const rsOff = $$('#read-sheet #rs-nm button').find((b) => b.dataset.level === 'off');
  click(rsOff);
  await sleep(50);
  check('弹层里切档位也落盘',
        patchCalls.some((p) => p.mobile && p.mobile.noImage === 'off'),
        JSON.stringify(patchCalls[0] || null));

  patchCalls.length = 0;
  const rsMax = $$('#read-sheet #rs-apmax button').find((b) => b.dataset.max === '5');
  click(rsMax);
  await sleep(50);
  check('弹层里改上限也落盘',
        patchCalls.some((p) => p.mobile && p.mobile.autoPageMax === 5),
        JSON.stringify(patchCalls[0] || null));

  // 档位在 off 时不该显示「显示本页图片」——没图可放行
  check('关闭档位时不摆「显示本页图片」（没图可放行）',
        !$('#read-sheet [data-act="rs-show-images"]'));

  const rsOn = $$('#read-sheet #rs-nm button').find((b) => b.dataset.level === 'image');
  click(rsOn);
  await sleep(60);
  check('切回无图档后出现「显示本页图片」', !!$('#read-sheet [data-act="rs-show-images"]'));

  let showCalls = 0;
  const origShow = window.nova.mobile.showImages;
  window.nova.mobile.showImages = async (id) => { showCalls += 1; return origShow(id); };
  click($('#read-sheet [data-act="rs-show-images"]'));
  await sleep(60);
  check('「显示本页图片」接到了桥上', showCalls === 1, String(showCalls));

  click($('#read-sheet'));
  await sleep(40);
  check('点弹层外的遮罩能关掉', $('#read-sheet').hidden === true);

  console.log('\n[H] 菜单入口');

  window.eval('renderMenuPanel()');
  await sleep(40);
  check('菜单里加了「阅读增强」入口', !!$('#drawer-body [data-read]'));
  check('菜单行显示了当前档位与拼页状态',
        /无图模式/.test($('#drawer-body [data-read]').textContent)
        && /自动拼页/.test($('#drawer-body [data-read]').textContent),
        $('#drawer-body [data-read]').textContent.replace(/\s+/g, ' ').trim().slice(0, 60));

  click($('#drawer-body [data-read]'));
  await sleep(60);
  check('点菜单行打开阅读弹层', $('#read-sheet').hidden === false);
  check('打开弹层时顺手关掉抽屉', $('#drawer').classList.contains('is-open') === false);
  window.eval('closeReadSheet()');

  console.log('\n[I] 导航角标');

  const navMobile = $$('#settings-nav .sv-nav-item').find((b) => b.dataset.sec === 'mobile');
  check('左导航有移动端分区', !!navMobile);
  check('位置排在外观之后、内核之前',
        $$('#settings-nav .sv-nav-item').map((b) => b.dataset.sec).join(',').startsWith('general,appearance,mobile,engines'),
        $$('#settings-nav .sv-nav-item').map((b) => b.dataset.sec).join(','));
  check('开着时显示「开」角标', /开/.test(navMobile.textContent), navMobile.textContent.replace(/\s+/g, ' ').trim());

  await openMobile();
  const offNow = $$('#settings-body #nm-level button').find((b) => b.dataset.level === 'off');
  click(offNow);
  await sleep(50);
  check('全部关掉后角标消失',
        !/开/.test($$('#settings-nav .sv-nav-item').find((b) => b.dataset.sec === 'mobile').textContent),
        $$('#settings-nav .sv-nav-item').find((b) => b.dataset.sec === 'mobile').textContent.replace(/\s+/g, ' ').trim());

  console.log('\n[J] 无运行时错误');

  check('全程无未捕获异常', errors.length === 0, errors.join(' | ') || '无');

  console.log(`\n移动端阅读测试：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）\n`);
  window.close();
  process.exit(fail ? 1 : 0);
})();
