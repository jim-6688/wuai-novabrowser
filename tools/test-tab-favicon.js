'use strict';

/**
 * 标签页图标的兜底链测试 —— 真实 DOM，jsdom
 * 用法：node tools/test-tab-favicon.js
 *
 * 覆盖用户报过的问题：「标签 ico 带入问题，有的网站可以带入，有的缺少带入的
 * 使用浏览器 logo 标识代替」。根因有两个：
 *   1) 外壳页面 CSP 是 `img-src 'self' data: https:`，站点把图标声明成 http://
 *      （或那个地址根本取不到）时，图片一律被拦；
 *   2) 原来那句内联 `onerror="this.remove()"` 同样被 CSP 的 `script-src 'self'`
 *      挡掉，从没执行过 —— 所以失败后留下的是空方框，而不是首字母兜底。
 *
 * 改法：标签图标统一从主进程的图标缓存（data: URI）取；远程图标加载失败时用
 * 事件监听回落成首字母。这里验这条链在渲染层的接线。
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

  for (let i = 0; i < 80 && $$('#engine-menu-list .em-item').length === 0; i++) await sleep(50);
  check('外壳初始化完成（内核菜单已渲染）', $$('#engine-menu-list .em-item').length > 0);

  /* 记录 favicons.json 调用：验「什么时候该问一次、什么时候不该问」 */
  const jsonCalls = [];
  const realJson = window.nova.favicons.json;
  let reply = {};
  window.nova.favicons.json = async (hosts) => {
    jsonCalls.push(hosts && hosts[0]);
    return reply;
  };

  const tab = window.eval('activeTab()');
  const st = window.eval('state');
  check('有活动标签页可用', !!tab);

  /* ================================================================ *
   * [A] 没有图标 / 远程图标 → 问主进程要一份缓存
   * ================================================================ */
  console.log('\n[A] 标签页从图标缓存取图标');

  tab.url = 'https://site.test/page';
  tab.favicon = null;
  st.isPreview = false;
  await window.eval('resolveTabFavicon')(tab);
  check('问了一次主进程（按主机名）', jsonCalls.length === 1 && jsonCalls[0] === 'site.test',
    JSON.stringify(jsonCalls));

  reply = { 'site.test': 'data:image/png;base64,AAAA' };
  await window.eval('resolveTabFavicon')(tab);
  check('缓存里有的就换成 data: URI', tab.favicon === 'data:image/png;base64,AAAA', tab.favicon);

  // 已经是 data: URI 的别重复问：每次导航都问一遍是白忙
  const before = jsonCalls.length;
  await window.eval('resolveTabFavicon')(tab);
  check('已经是 data: URI 就不再问', jsonCalls.length === before, `${before} → ${jsonCalls.length}`);

  // 缓存里也没有（站点压根没图标）→ 保持现状，别把已有的远程图标清了
  tab.favicon = 'https://site.test/icon.png';
  reply = {};
  await window.eval('resolveTabFavicon')(tab);
  check('缓存没有就留着原来的图标', tab.favicon === 'https://site.test/icon.png', String(tab.favicon));

  /* ================================================================ *
   * [B] 画不出来要回落成首字母，不能留空框
   * ================================================================ */
  console.log('\n[B] 图标加载失败回落成首字母');

  tab.favicon = 'https://broken.test/icon.png';
  tab.url = 'https://broken.test/page';
  window.eval('renderTabstrip()');
  const span = $$('#tabs .tab-favicon')[0];
  check('远程图标仍然先画上去（能显示时不该等缓存）', !!span && !!span.querySelector('img'),
    span && span.innerHTML.slice(0, 60));
  check('兜底字母挂在容器上（CSP 不让用内联 onerror）',
    !!span && span.dataset.fb === 'B', span && span.dataset.fb);

  // 图片加载失败 = CSP 拦截 / 链接失效 / 站点下线，三种真实情况
  const img = span.querySelector('img');
  img.dispatchEvent(new window.Event('error'));
  check('失败后回落成首字母', span.textContent === 'B', JSON.stringify(span.textContent));

  /* ================================================================ *
   * [C] 非 http 页面（新标签页 / file 页）不该去问图标
   * ================================================================ */
  console.log('\n[C] 本地页面不打扰主进程');
  const before2 = jsonCalls.length;
  tab.url = 'file:///C:/nova/newtab.html';
  tab.favicon = null;
  await window.eval('resolveTabFavicon')(tab);
  check('file: 页面不问图标', jsonCalls.length === before2, `${before2} → ${jsonCalls.length}`);

  window.nova.favicons.json = realJson;
  check('走完全流程无异常', errors.length === 0, errors.join(' | ') || '无');
  console.log(`\n结果：${pass}/${pass + fail} 通过`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
