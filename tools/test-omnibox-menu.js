'use strict';

/**
 * 地址栏右键编辑菜单（复制 / 粘贴 / 剪切 / 全选 / 粘贴并打开）测试
 * 用法：node tools/test-omnibox-menu.js
 *
 * 验证：右键弹出、无选区时剪切删除置灰、复制走主进程剪贴板、粘贴按选区替换、
 * 多行压成一行、粘贴并打开会真的导航、点外面 / Esc 收起，全程无未捕获异常。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

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

  // 等启动完成（引擎菜单渲染出来说明 shell.js 已跑完初始化）
  for (let i = 0; i < 60 && $$('#engine-menu-list .em-item').length === 0; i++) await sleep(50);

  const input = $('#omni-input');
  const menu = $('#omni-menu');

  // 剪贴板观测：替换桩里的 copy / paste，记下进出内容
  let copied = null;
  let pasteText = '';
  const nova = window.nova;
  check('预览桩已挂载 window.nova', !!nova);
  nova.system.copy = async (t) => { copied = String(t == null ? '' : t); return true; };
  nova.system.paste = async () => pasteText;

  // 导航的观测点：navigate() 末尾会 persistSession()，把最新 tabs 落盘。
  // （webview 在 jsdom 里是未知元素，src 未必落到 attribute 上，不看它。）
  let savedSession = null;
  const origPatch = nova.settings && nova.settings.patch;
  nova.settings.patch = async (p) => {
    if (p && p.session) savedSession = p.session;
    return origPatch ? origPatch(p) : {};
  };

  const rightClick = () => {
    const ev = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 140, button: 2 });
    input.dispatchEvent(ev);
    return ev;
  };
  const clickItem = async (id) => {
    const b = menu.querySelector(`[data-om="${id}"]`);
    if (!b) return false;
    b.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(20);
    return true;
  };
  const setSel = (s, e) => { input.focus(); input.setSelectionRange(s, e); };
  const item = (id) => menu.querySelector(`[data-om="${id}"]`);
  const disabled = (id) => !!item(id) && item(id).classList.contains('is-disabled');

  console.log('\n[A] 挂载与初始态');
  check('菜单节点已挂载', !!menu);
  check('菜单在地址栏容器内（随地址栏定位）', !!menu && !!menu.closest('#omnibox'));
  check('初始隐藏', !!menu && menu.hidden === true);

  console.log('\n[B] 右键弹出');
  const ev = rightClick();
  await sleep(10);
  check('右键后菜单打开', menu.hidden === false);
  check('已拦掉默认菜单（不弹系统那套）', ev.defaultPrevented === true);
  const ids = $$('#omni-menu [data-om]').map((b) => b.dataset.om);
  check('菜单项齐全', ['undo', 'cut', 'copy', 'paste', 'paste-go', 'delete', 'select-all', 'copy-url']
    .every((k) => ids.includes(k)), ids.join(' / '));
  check('右键时不弹分享面板', $('#omni-share').hidden === true);

  console.log('\n[C] 置灰：剪切 / 删除要有选区');
  input.value = 'https://example.com/page';
  setSel(4, 4);
  rightClick(); await sleep(10);
  check('无选区时剪切置灰', disabled('cut'));
  check('无选区时删除置灰', disabled('delete'));
  check('无选区时复制不置灰（复制整条）', !disabled('copy'));
  setSel(8, 15);
  rightClick(); await sleep(10);
  check('有选区时剪切可用', !disabled('cut'));
  check('有选区时删除可用', !disabled('delete'));

  console.log('\n[D] 复制');
  copied = null;
  input.value = 'https://example.com/page';
  setSel(8, 15);
  rightClick(); await sleep(10);
  await clickItem('copy');
  check('复制的是选中的那一段', copied === 'example', JSON.stringify(copied));
  copied = null;
  setSel(3, 3);
  rightClick(); await sleep(10);
  await clickItem('copy');
  check('没选区时复制整条地址', copied === 'https://example.com/page', JSON.stringify(copied));

  console.log('\n[E] 粘贴');
  pasteText = 'nova.52ta.top';
  input.value = 'https://example.com/page';
  setSel(0, input.value.length);
  rightClick(); await sleep(10);
  await clickItem('paste');
  check('粘贴替换选区', input.value === 'nova.52ta.top', JSON.stringify(input.value));
  pasteText = 'a.com\r\nb.com';
  input.value = 'x';
  setSel(1, 1);
  rightClick(); await sleep(10);
  await clickItem('paste');
  check('多行压成一行', input.value === 'xa.com b.com', JSON.stringify(input.value));

  console.log('\n[F] 粘贴并打开');
  pasteText = 'https://paste-go.test/hello';
  input.value = '';
  setSel(0, 0);
  savedSession = null;
  rightClick(); await sleep(10);
  await clickItem('paste-go');
  check('地址栏填上了粘贴的内容', input.value === 'https://paste-go.test/hello', JSON.stringify(input.value));
  await sleep(600);
  const navUrl = ((savedSession && savedSession.tabs) || []).map((t) => t.url)
    .find((u) => String(u).indexOf('paste-go.test') >= 0) || '';
  check('真的发起了导航（标签页网址已更新）', !!navUrl, navUrl || '（会话里没有这个网址）');

  console.log('\n[G] 剪切 / 删除 / 全选');
  copied = null;
  input.value = 'https://example.com/page';
  setSel(8, 15);
  rightClick(); await sleep(10);
  await clickItem('cut');
  check('剪切：选段进了剪贴板', copied === 'example', JSON.stringify(copied));
  check('剪切：地址里那段被去掉', input.value === 'https://.com/page', JSON.stringify(input.value));

  input.value = 'abcdef';
  setSel(2, 4);
  rightClick(); await sleep(10);
  await clickItem('delete');
  check('删除只删选中的那两个字符', input.value === 'abef', JSON.stringify(input.value));

  input.value = 'https://example.com';
  setSel(0, 0);
  rightClick(); await sleep(10);
  await clickItem('select-all');
  check('全选覆盖整条', input.selectionStart === 0 && input.selectionEnd === input.value.length,
    `${input.selectionStart}-${input.selectionEnd}`);

  console.log('\n[H] 复制当前页网址');
  copied = null;
  rightClick(); await sleep(10);
  await clickItem('copy-url');
  check('复制到的是一条网址', typeof copied === 'string' && /^[a-z]+:/i.test(copied), JSON.stringify(copied));

  console.log('\n[I] 空剪贴板不动');
  pasteText = '';
  input.value = 'keep-me';
  setSel(7, 7);
  rightClick(); await sleep(10);
  await clickItem('paste');
  check('剪贴板为空时地址栏原样不动', input.value === 'keep-me', JSON.stringify(input.value));

  console.log('\n[J] 收起');
  rightClick(); await sleep(10);
  check('打开着', menu.hidden === false);
  doc.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await sleep(10);
  check('点外面收起', menu.hidden === true);

  rightClick(); await sleep(10);
  check('再打开', menu.hidden === false);
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(10);
  check('Esc 收起', menu.hidden === true);

  console.log('\n[K] 左键仍然是「点网址弹分享面板」');
  // 右键不能顺手把分享面板带出来 —— mousedown 只看左键
  input.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 }));
  await sleep(10);
  check('右键 mousedown 不弹分享面板', $('#omni-share').hidden === true);

  console.log('\n[L] 主进程 / preload 的读剪贴板通道');
  const mainSrc = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const preSrc = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
  const mockSrc = fs.readFileSync(path.join(root, 'src/renderer/bridge-mock.js'), 'utf8');
  check('主进程接了 shell:paste', /handle\('shell:paste'/.test(mainSrc));
  check('主进程用 clipboard.readText 读', /clipboard\.readText\(\)/.test(mainSrc));
  check('preload 暴露 system.paste', /paste:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('shell:paste'\)/.test(preSrc));
  check('预览桩也有 paste（预览里能走通复制→粘贴）', /paste:\s*async\s*\(\)/.test(mockSrc));

  console.log('\n[M] 无未捕获异常');
  check('运行期没有异常', errors.length === 0, errors.join(' | '));

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
