'use strict';

/**
 * AI 助手「用新窗口打开」行为测试（真实 DOM，jsdom）
 * 用法：node tools/test-ai-window.js
 *
 * 重点验证「搬到独立窗口后，当前画面不丢」：
 *   - 网页模式：带上**当前对话页地址** + 页面输入框里没发出去的草稿；
 *   - API 模式：整份对话一条不差地带过去；
 *   - 独立窗口用的还是同一个持久化分区（cookie / 会话历史因此延续）；
 *   - 窗口关了以后，最后一份状态回到侧栏，接着聊。
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
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
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

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));

  // 等启动完成（引擎菜单渲染出来说明 shell.js 已跑完初始化）
  for (let i = 0; i < 60 && !$('#engine-menu-list .em-item'); i++) await sleep(50);

  // 捕获「送去开窗口的那份状态」——这就是「内容有没有丢」的判据
  let sent = null;
  window.nova.ai.openWindow = async (payload) => {
    sent = payload;
    return { ok: true, reused: false };
  };

  const panel = $('#ai-panel');

  console.log('\n[A] 挂载与按钮语义');
  check('AI 面板在 DOM 里', !!panel);
  check('有「用新窗口打开」按钮 #ai-pop', !!$('#ai-pop'));
  check('按钮标题说明了是新窗口', /新窗口/.test($('#ai-pop').title), $('#ai-pop').title);
  check('仍有关闭按钮', !!$('#ai-close'));

  console.log('\n[B] 网页模式：地址与草稿一并带过去');
  window.eval('openAiPanel()');
  await sleep(10);
  check('面板已打开', panel.classList.contains('is-open'));

  // 造一个「正在看的画面」：webview 已载入 DeepSeek 对话、输入框里有半句话。
  // jsdom 没有真 webview，这里把两个探针打成桩，让「读草稿」这条路真跑一遍。
  window.eval([
    "var w = document.querySelector('#ai-webview');",
    "w.setAttribute('src', 'https://chat.deepseek.com/');",
    "w.getWebContentsId = function () { return 1; };",
    "w.executeJavaScript = function () { return Promise.resolve('还没发出去的半句话'); };"
  ].join(''));

  $('#ai-pop').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(80);
  check('调用了 bridge.ai.openWindow', !!sent);
  check('模式是网页模式', sent && sent.mode === 'web', sent && sent.mode);
  check('带上了**当前**对话页地址（画面不丢）',
    sent && sent.url === 'https://chat.deepseek.com/', sent && sent.url);
  check('带上了 AI 名字与输入框选择器', !!(sent && sent.name && sent.sel), sent && sent.name);
  check('带上了没发出去的草稿', sent && sent.draft === '还没发出去的半句话', sent && sent.draft);
  check('开窗口后侧栏这一份收起（同一个会话不在两处同时跑）',
    !panel.classList.contains('is-open'));

  console.log('\n[C] API 模式：整份对话带过去');
  window.eval('openAiPanel()');
  window.eval("document.querySelector('#ai-select').value = 'api';");
  $('#ai-select').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(10);
  window.eval("state.aiApiMessages = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '嗨，有什么可以帮您' }];");
  sent = null;
  $('#ai-pop').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(80);
  check('模式是 API 模式', sent && sent.mode === 'api', sent && sent.mode);
  check('整份对话都带过去了（一条不差）',
    sent && Array.isArray(sent.messages) && sent.messages.length === 2,
    sent && sent.messages && sent.messages.length);
  check('对话内容原样（没被截断/改写）',
    sent && sent.messages[0].content === '你好' && sent.messages[1].content === '嗨，有什么可以帮您');
  check('带上了 API 配置', !!(sent && sent.apiCfg && sent.apiCfg.base), sent && sent.apiCfg && sent.apiCfg.base);

  console.log('\n[D] 窗口关回来：状态回到侧栏');
  window.eval([
    "onAiWindowClosed({ mode: 'api',",
    "  messages: [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }],",
    "  apiCfg: { base: 'https://api.deepseek.com', key: 'k', model: 'deepseek-chat' } });"
  ].join(''));
  await sleep(40);
  check('对话回到 state.aiApiMessages',
    window.eval("(state.aiApiMessages || []).length") === 2,
    window.eval("JSON.stringify(state.aiApiMessages || [])"));
  check('侧栏消息列表重画了这两条', doc.querySelectorAll('#ai-chat .ai-msg').length === 2,
    doc.querySelectorAll('#ai-chat .ai-msg').length + ' 条');

  window.eval("onAiWindowClosed({ mode: 'web', url: 'https://www.doubao.com/chat/', draft: '回到侧栏的草稿' });");
  await sleep(20);
  check('网页模式：地址回到侧栏 webview',
    $('#ai-webview').getAttribute('src') === 'https://www.doubao.com/chat/',
    $('#ai-webview').getAttribute('src'));
  check('网页模式：草稿交给既有的「待注入」通道',
    window.eval('state.aiPending') === '回到侧栏的草稿');

  console.log('\n[E] 独立窗口本身（主进程 + 承载页）');
  const mainSrc = read('src/main/main.js');
  check('主进程有 openAiWindow（独立窗口）', /function openAiWindow\(/.test(mainSrc));
  check('独立窗口是 BrowserWindow 且开 webviewTag',
    /aiWindow = new BrowserWindow\(/.test(mainSrc) && /webviewTag: true/.test(mainSrc));
  check('打开即最大化', /aiWindow\.maximize\(\)/.test(mainSrc));
  check('已开着就复用（不跑两个同一会话）', /aiWindow\.focus\(\)/.test(mainSrc));
  check('关窗口把最后状态推回侧栏', /send\('ai:closed'/.test(mainSrc));
  check('有 ai:open-window / ai:init / ai:sync 三条 IPC',
    /handle\('ai:open-window'/.test(mainSrc) && /handle\('ai:init'/.test(mainSrc) && /ipcMain\.on\('ai:sync'/.test(mainSrc));

  const winHtml = read('src/renderer/ai-window.html');
  check('AI 窗口页存在', !!winHtml);
  check('网页模式用**同一个持久化分区**（cookie / 会话历史因此延续）',
    /partition="persist:nova-chromium"/.test(winHtml));
  const winJs = read('src/renderer/ai-window.js');
  check('承载页取初始状态（ai.init）', /bridge\.ai\.init\(\)/.test(winJs));
  check('承载页把变化同步回主进程（ai.sync）', /bridge\.ai\.sync\(/.test(winJs));
  check('承载页把草稿塞回页面输入框', /injectDraft/.test(winJs));
  check('承载页监听 ai:init（再次点开时刷新内容）', /bridge\.on\('ai:init'/.test(winJs));

  console.log('\n[F] 桥接白名单');
  const pre = read('src/preload/preload.js');
  check('preload 暴露 ai.openWindow / ai.init / ai.sync',
    /openWindow: \(payload\)/.test(pre) && /init: \(\) =>/.test(pre) && /sync: \(payload\)/.test(pre));
  check('EVENT_CHANNELS 含 ai:init 与 ai:closed',
    /'ai:init'/.test(pre) && /'ai:closed'/.test(pre));
  check('外壳确实注册了 ai:closed 监听',
    /bridge\.on\('ai:closed'/.test(read('src/renderer/shell.js')));

  console.log('\n[G] 运行时错误');
  check('渲染层无未捕获异常', errors.length === 0, errors.join(' | ') || '无');

  console.log(`\n结果：${pass}/${pass + fail} 通过\n`);
  dom.window.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
