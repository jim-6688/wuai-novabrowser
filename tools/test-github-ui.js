'use strict';

/**
 * GitHub 加速设置页行为测试（真实 DOM，jsdom）
 * 用法：node tools/test-github-ui.js
 *
 * 这一层验证的是界面：分区能不能打开、默认是不是关着的、两组下拉和自定义
 * 地址有没有把配置写回去、选「自定义…」会不会把占位串误存成镜像地址。
 * 改写规则本身的正确性由 tools/test-github-mirror.js 覆盖。
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
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
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

  const waitFor = async (sel, timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if ($(sel)) return true;
      await sleep(30);
    }
    return false;
  };
  const openGithub = async () => {
    window.eval("openSettings('github')");
    await waitFor('[data-act="gh-toggle"]');
    await sleep(30);
  };
  const cfg = () => window.eval('JSON.stringify(githubCfg())');
  const changeEl = (el) => el.dispatchEvent(new window.Event('change', { bubbles: true }));
  const clickEl = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  console.log('\n[A] 分区渲染与默认状态');
  await openGithub();
  check('设置页切到「GitHub 加速」分区', $('#sv-path').textContent === 'GitHub 加速', $('#sv-path').textContent);
  check('左导航「GitHub 加速」项高亮', !!$('.sv-nav-item.is-active') && $('.sv-nav-item.is-active').dataset.sec === 'github');
  check('默认是关闭的（第三方中转不能默认开）',
    !$('[data-act="gh-toggle"]').classList.contains('is-on') && JSON.parse(cfg()).enabled === false);
  check('整站镜像下拉存在', !!$('#gh-site-sel'));
  check('资源镜像下拉存在', !!$('#gh-asset-sel'));
  check('两个自定义地址输入框存在', !!$('#gh-site-custom') && !!$('#gh-asset-custom'));
  check('整站候选是 3 个 + 自定义', $$('#gh-site-sel option').length === 4, String($$('#gh-site-sel option').length));
  check('资源候选是 7 个 + 自定义', $$('#gh-asset-sel option').length === 8, String($$('#gh-asset-sel option').length));
  check('默认节点与输入框显示的一致',
    $('#gh-site-sel').value === 'https://bgithub.xyz' && $('#gh-site-custom').value === 'https://bgithub.xyz',
    $('#gh-site-sel').value + ' / ' + $('#gh-site-custom').value);
  check('资源镜像默认指向 gh-proxy.com', $('#gh-asset-custom').value === 'https://gh-proxy.com/');
  check('说明里讲清了不要登录 / 不要带 Token', /不要.*登录 GitHub/.test($('#settings-body').textContent)
    && /Token/.test($('#settings-body').textContent));
  check('说明里如实写明 CF 加速的能力边界', /无法给任意 Cloudflare 背后的网站提速/.test($('#settings-body').textContent));
  check('给了两个验证入口', !!$('[data-act="gh-try"]') && !!$('[data-act="gh-try-raw"]'));

  console.log('\n[B] 总开关');
  clickEl($('[data-act="gh-toggle"]'));
  await sleep(60);
  await waitFor('[data-act="gh-toggle"]');
  check('点一次后开启', JSON.parse(cfg()).enabled === true && $('[data-act="gh-toggle"]').classList.contains('is-on'));
  check('导航角标显示「开」',
    $$('.sv-nav-item').some((b) => b.dataset.sec === 'github' && /开/.test(b.textContent)));
  clickEl($('[data-act="gh-toggle"]'));
  await sleep(60);
  await waitFor('[data-act="gh-toggle"]');
  check('再点一次关闭', JSON.parse(cfg()).enabled === false && !$('[data-act="gh-toggle"]').classList.contains('is-on'));

  console.log('\n[C] 切换节点与自定义地址');
  const siteSel = $('#gh-site-sel');
  siteSel.value = 'https://kkgithub.com';
  changeEl(siteSel);
  await sleep(60);
  check('切换整站节点写回配置', JSON.parse(cfg()).siteMirror === 'https://kkgithub.com', JSON.parse(cfg()).siteMirror);
  check('切换后输入框同步（界面不骗人）', $('#gh-site-custom').value === 'https://kkgithub.com');

  const before = JSON.parse(cfg()).siteMirror;
  $('#gh-site-sel').value = '__custom__';
  changeEl($('#gh-site-sel'));
  await sleep(60);
  check('选「自定义…」不会把占位串存成镜像地址', JSON.parse(cfg()).siteMirror === before, JSON.parse(cfg()).siteMirror);

  const siteInput = $('#gh-site-custom');
  siteInput.value = 'https://my-mirror.example.com';
  changeEl(siteInput);
  await sleep(60);
  check('自定义地址写回配置', JSON.parse(cfg()).siteMirror === 'https://my-mirror.example.com', JSON.parse(cfg()).siteMirror);
  check('自定义后下拉停在「自定义…」', $('#gh-site-sel').value === '__custom__');

  const assetInput = $('#gh-asset-custom');
  assetInput.value = 'https://ghproxy.net/';
  changeEl(assetInput);
  await sleep(60);
  check('资源镜像切到候选项时下拉自动回到那一项',
    JSON.parse(cfg()).assetMirror === 'https://ghproxy.net/' && $('#gh-asset-sel').value === 'https://ghproxy.net/',
    $('#gh-asset-sel').value);

  assetInput.value = '   ';
  changeEl(assetInput);
  await sleep(60);
  check('清空输入框不会把空地址写进配置',
    JSON.parse(cfg()).assetMirror === 'https://ghproxy.net/' && $('#gh-asset-custom').value === 'https://ghproxy.net/',
    JSON.parse(cfg()).assetMirror);

  console.log('\n[D] 节点自检');
  check('给了「检测哪个节点能用」按钮', !!$('[data-act="gh-probe"]'));
  const cfgBeforeProbe = cfg();
  clickEl($('[data-act="gh-probe"]'));
  await sleep(150);
  await waitFor('[data-act="gh-probe"]');
  check('检测结束后画出两组结果', /整站镜像检测结果/.test($('#settings-body').textContent)
    && /资源镜像检测结果/.test($('#settings-body').textContent));
  check('预览模式如实显示不可用，不编造绿色状态', /✗/.test($('#settings-body').textContent)
    && /预览模式不发网络请求/.test($('#settings-body').textContent));
  check('一个可用节点都没有时保持原配置不动', cfg() === cfgBeforeProbe, cfg());

  console.log('\n[E] 运行期无异常');
  check('没有未捕获的脚本错误', errors.length === 0, errors.join(' | '));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  window.close();
  process.exit(fail ? 1 : 0);
})();
