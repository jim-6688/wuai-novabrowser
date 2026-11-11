'use strict';
/**
 * 官网插件商店目录的界面接线测试 —— 真实 DOM，jsdom。
 *
 * 纯逻辑（多源、白名单、归一化）归 test-ext-catalog.js；这里只管
 * 「设置 → 扩展」那一页有没有真的把目录卡片画出来、按钮点不点得动。
 * 走的是 UI 预览桥（bridge-mock），不联网也不碰 Electron。
 *
 * 顺序有讲究：必须**先**让 loadExtCatalog 跑完（loaded=true），再塞假数据
 * 去测卡片与点击。否则 afterSectionRender 每次重绘都会惰性拉一次目录，
 * 异步回来把刚塞进去的假数据和筛选状态覆盖掉 —— 这本来就是设计要的行为，
 * 测试得顺着它来。
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

const ID32 = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const fake = [
  { id: 'a', name: '插件 A', developer: 'Dev A', category: '效率工具', mark: 'A',
    accent: '#0A84C6', description: '第一条', installUrl: ID32,
    source: 'Chrome 应用店镜像', tags: ['脚本'], featured: true },
  { id: 'b', name: '插件 B', developer: 'Dev B', category: '效率工具', mark: 'B',
    accent: '#D64545', description: '第二条', installUrl: ID32,
    source: 'Chrome 应用店镜像', tags: [], featured: false },
  { id: 'c', name: '插件 C', developer: 'Dev C', category: '外观', mark: 'C',
    accent: '#4B4BD6', description: '第三条', installUrl: ID32,
    source: 'Chrome 应用店镜像', tags: [], featured: false }
];

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
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // 等外壳初始化完成
  for (let i = 0; i < 80 && $$('#engine-menu-list .em-item').length === 0; i++) await sleep(50);
  check('外壳初始化完成', $$('#engine-menu-list .em-item').length > 0);

  console.log('\n[A] 目录状态与桥');
  const initObj = JSON.parse(window.eval('JSON.stringify(state.extCatalog)'));
  check('state.extCatalog 初始为空、未加载',
    initObj.items.length === 0 && initObj.loaded === false && initObj.filter === '全部');
  check('预览桥挂上了 catalog（否则目录永远读不到）',
    typeof window.eval('bridge.extensions.catalog') === 'function');

  console.log('\n[B] 从预览桥拉一次目录');
  window.eval("state.settingsSection = 'extensions';"
    + " document.querySelector('#settings-view').hidden = false;");
  await window.eval('loadExtCatalog(true)');
  const after = JSON.parse(window.eval('JSON.stringify(state.extCatalog)'));
  check('目录加载完成，拿到预览桥那份样例',
    after.loaded === true && after.items.length === 2 && after.items[0].id === 'tampermonkey',
    String(after.items.length));
  check('加载完没有残留错误、loading 已复位',
    after.error === '' && after.loading === false);

  // 后面要测「点安装」：预览模式下按钮是 disabled，先关掉预览标记。
  // loaded 已经是 true，afterSectionRender 不会再把下面的假数据冲掉。
  window.eval('state.isPreview = false; state.extCatalog.filter = "全部";'
    + ' state.extCatalog.items = ' + JSON.stringify(fake) + ';'
    + " state.extCatalog.updatedAt = '2026-11-11';");

  console.log('\n[C] 目录卡片渲染');
  const holder = doc.createElement('div');
  holder.innerHTML = window.eval('catalogBox()');
  check('三张卡片都画出来了', holder.querySelectorAll('.cat-card').length === 3);
  check('标题、来源、更新日期都出现',
    /官网插件商店/.test(holder.textContent)
    && /更新于 2026-11-11/.test(holder.textContent)
    && /nova.52ta.top/.test(holder.textContent));
  check('每张卡片都有安装按钮，且带条目 id',
    holder.querySelectorAll('[data-act="catalog-install"][data-ext-id]').length === 3);
  check('推荐标记只出现在标记过的条目上',
    holder.querySelectorAll('.cat-badge').length === 1);
  check('分类筛选项是「全部 + 两个实际分类」',
    holder.querySelectorAll('.cat-filter').length === 3);
  check('刷新目录按钮存在', !!holder.querySelector('[data-act="catalog-refresh"]'));

  console.log('\n[D] 扩展分区里目录的位置');
  const extHtml = window.eval('buildExtensions()');
  check('已安装列表仍在商店前面（顺序没被新目录打乱）',
    extHtml.indexOf('已安装') < extHtml.indexOf('cat-box'));
  check('目录在「手动安装 · 粘贴地址」之前',
    extHtml.indexOf('cat-box') < extHtml.indexOf('store-divider'));

  console.log('\n[E] 点筛选 / 点安装真的改状态');
  const body = $('#settings-body');
  body.innerHTML = extHtml;
  window.eval('wireActions(document.querySelector("#settings-body"))');

  const filters = $$('#settings-body .cat-filter');
  const appearance = filters.find((b) => b.dataset.cat === '外观');
  check('筛选按钮带分类值', !!appearance);
  if (appearance) {
    click(appearance);
    await sleep(80);
    check('点「外观」后状态切过去',
      window.eval('state.extCatalog.filter') === '外观');
    check('重绘后只剩外观那一类的一张卡片',
      $$('#settings-body .cat-card').length === 1,
      String($$('#settings-body .cat-card').length));
  }

  window.eval("state.extCatalog.filter = '全部'; refreshCurrent();");
  const installBtn = $('#settings-body [data-act="catalog-install"][data-ext-id="a"]');
  check('安装按钮在接线后仍在、且没被禁用', !!installBtn && !installBtn.disabled);
  if (installBtn) {
    click(installBtn);
    await sleep(150);
    // 预览桥的 storeInstall 返回「预览模式不可安装」，错误要落到目录区而不是吞掉
    check('点安装后错误提示落到目录区，且 busy 已复位',
      /预览模式/.test(window.eval('state.extCatalog.error'))
      && window.eval('state.extCatalog.busyId') === '');
  }

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n[test-ext-catalog-ui] 自身异常：', err);
  process.exit(1);
});
