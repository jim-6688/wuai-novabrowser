/* ==========================================================================
   AI 助手 · 独立窗口
   --------------------------------------------------------------------------
   侧栏那个 AI 面板挪到这里来，变成一个真正的独立窗口（打开即最大化），
   能自己最大化/还原/最小化，不再挤在主界面右侧那条小窗里。

   「搬到新窗口，画面不丢」由三件事合成：
     1. webview 用的是**同一个持久化分区** persist:nova-chromium —— cookie 与
        localStorage 都在磁盘上，AI 站点认得出你，历史会话也还在。
     2. 侧栏把「现在在看什么」打包成初始状态（地址 / 选择框草稿 / 整份对话）
        交给主进程，本窗口起来后按这份状态原样重建。
     3. 之后的变化（导航到别的 AI 页、新产生的对话、输入框草稿）随时 sync
        回主进程；关闭窗口时主进程把手上那份最新的还给侧栏。
   ========================================================================== */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const bridge = window.nova;

  const S = {
    mode: 'web',          // 'web' = 网页对话页；'api' = 自己的 API
    url: '',
    sel: '',              // 网页模式：AI 站点输入框选择器
    name: '',             // 网页模式：AI 名字（显示在标题条）
    draft: '',            // 网页模式：没发出去的输入框草稿
    messages: [],         // API 模式：整份对话
    apiCfg: null,         // API 模式：{ base, key, model }
    theme: 'light'
  };

  function cfg() {
    return Object.assign({ base: 'https://api.deepseek.com', model: 'deepseek-chat' }, S.apiCfg || {});
  }

  /** 把当前状态回写给主进程，好让关窗口时侧栏能接着用。单向发送，不等回执。 */
  function sync(extra) {
    if (!bridge || typeof bridge.ai.sync !== 'function') return;
    try {
      bridge.ai.sync(Object.assign({
        mode: S.mode, url: S.url, draft: S.mode === 'api' ? draftText() : S.draft, messages: S.messages
      }, extra || {}));
    } catch { /* 同步失败不影响窗口本身 */ }
  }

  function draftText() {
    const ta = $('#aw-text');
    return ta ? ta.value : '';
  }

  /* ---------------- 网页模式 ---------------- */

  function webviewReady() {
    const wv = $('#aw-webview');
    if (!wv) return false;
    // getWebContentsId 未就绪时返回 0 且不抛，适合当探针
    try { return wv.getWebContentsId() > 0; } catch { return false; }
  }

  function whenReady(timeout = 10000) {
    const wv = $('#aw-webview');
    if (!wv) return Promise.resolve(false);
    if (webviewReady()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        wv.removeEventListener('dom-ready', onReady);
        resolve(ok);
      };
      const onReady = () => { if (webviewReady()) finish(true); };
      const timer = setTimeout(() => finish(false), timeout);
      wv.addEventListener('dom-ready', onReady);
      if (webviewReady()) finish(true);
    });
  }

  /**
   * 把草稿塞回 AI 站点的输入框。跨域注入由宿主执行，不受页面 CSP 限制。
   * 这是「聊到一半搬到新窗口」最要紧的一步：不然输入框里那半句话就没了。
   */
  async function injectDraft() {
    const wv = $('#aw-webview');
    if (!wv || !S.draft || !S.sel) return;
    if (!(await whenReady())) return;
    const code = '(function(){'
      + 'try{'
      + 'var el=document.querySelector(' + JSON.stringify(S.sel) + ');'
      + 'if(!el)return "no-input";'
      + 'el.focus();'
      + 'if(el.value!==undefined){'
      + 'var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;'
      + 's.call(el,' + JSON.stringify(S.draft) + ');'
      + '}else{el.textContent=' + JSON.stringify(S.draft) + ';}'
      + 'el.dispatchEvent(new Event("input",{bubbles:true}));'
      + 'el.dispatchEvent(new Event("change",{bubbles:true}));'
      + 'return "ok";'
      + '}catch(e){return "err:"+e.message;}'
      + '})()';
    try { await wv.executeJavaScript(code); } catch { /* 注入不成也不该让窗口报错 */ }
  }

  function loadWeb() {
    const src = $('#aw-src');
    if (src) src.textContent = S.name ? (S.name + ' · 网页对话') : (S.url || '网页对话');
    const wv = $('#aw-webview');
    if (!wv || !S.url) return;
    // 地址没变就别重设 src —— 重设会真的重新加载一次，正在看的页面就丢了
    if (wv.getAttribute('src') === S.url) { injectDraft(); return; }
    wv.setAttribute('src', S.url);
    injectDraft();
  }

  /* ---------------- API 模式 ---------------- */

  function renderChat() {
    const box = $('#aw-chat');
    if (!box) return;
    box.textContent = '';
    for (const m of (S.messages || [])) {
      const div = document.createElement('div');
      div.className = 'aw-msg ' + (m.role === 'user' ? 'user' : 'assistant');
      div.textContent = m.content || '';
      box.appendChild(div);
    }
    box.scrollTop = box.scrollHeight;
  }

  function addBubble(role, text) {
    const box = $('#aw-chat');
    if (!box) return null;
    const div = document.createElement('div');
    div.className = 'aw-msg ' + role;
    div.textContent = text || '';
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  async function send() {
    const ta = $('#aw-text');
    const text = (ta && ta.value || '').trim();
    if (!text) return;
    const c = cfg();
    if (!String(c.key || '').trim()) {
      const hint = $('#aw-hint');
      if (hint) hint.textContent = '还没填 API Key —— 点右上角「API 设置」填一下';
      $('#aw-cfg').hidden = false;
      return;
    }
    if (ta) ta.value = '';
    S.messages.push({ role: 'user', content: text });
    addBubble('user', text);
    const thinking = addBubble('thinking', '思考中…');
    sync();
    let r;
    try {
      r = await bridge.ai.chat({ base: c.base, key: c.key, model: c.model, messages: S.messages });
    } catch (e) {
      r = { error: String((e && e.message) || e) };
    }
    if (thinking) thinking.remove();
    if (r && r.ok) {
      S.messages.push({ role: 'assistant', content: r.content });
      addBubble('assistant', r.content);
    } else {
      addBubble('err', (r && r.error) || '请求失败');
    }
    sync();
  }

  /* ---------------- 装载 ---------------- */

  function apply(payload) {
    if (!payload || typeof payload !== 'object') return;
    Object.assign(S, {
      mode: payload.mode === 'api' ? 'api' : 'web',
      url: payload.url || '',
      sel: payload.sel || '',
      name: payload.name || '',
      draft: payload.draft || '',
      messages: Array.isArray(payload.messages) ? payload.messages.slice() : (S.messages || []),
      apiCfg: payload.apiCfg || S.apiCfg
    });
    if (payload.theme) document.documentElement.dataset.theme = payload.theme === 'dark' ? 'dark' : 'light';

    const api = S.mode === 'api';
    const apiBox = $('#aw-api');
    const wv = $('#aw-webview');
    if (apiBox) apiBox.hidden = !api;
    if (wv) wv.style.display = api ? 'none' : '';

    if (api) {
      const src = $('#aw-src');
      if (src) src.textContent = 'API 模式 · ' + (cfg().model || '');
      const f = { base: $('#aw-base'), key: $('#aw-key'), model: $('#aw-model') };
      const c = cfg();
      if (f.base) f.base.value = c.base || '';
      if (f.key) f.key.value = c.key || '';
      if (f.model) f.model.value = c.model || '';
      renderChat();
    } else {
      loadWeb();
    }
  }

  function wire() {
    const sendBtn = $('#aw-send');
    const clearBtn = $('#aw-clear');
    const ta = $('#aw-text');
    const cfgBtn = $('#aw-toggle-cfg');
    const backBtn = $('#aw-back');

    if (sendBtn) sendBtn.addEventListener('click', send);
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        S.messages = [];
        renderChat();
        sync({ messages: [] });
      });
    }
    if (ta) {
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
      });
    }
    if (cfgBtn) {
      cfgBtn.addEventListener('click', () => {
        const box = $('#aw-cfg');
        if (box) box.hidden = !box.hidden;
      });
    }
    // 改了配置就同步一次，侧栏下次打开也能用上
    for (const id of ['#aw-base', '#aw-key', '#aw-model']) {
      const el = $(id);
      if (el) {
        el.addEventListener('change', () => {
          S.apiCfg = { base: ($('#aw-base') || {}).value, key: ($('#aw-key') || {}).value, model: ($('#aw-model') || {}).value };
          sync({ apiCfg: S.apiCfg });
        });
      }
    }
    if (backBtn) backBtn.addEventListener('click', () => { sync(); window.close(); });

    // 网页模式：在窗口里跳到别的 AI 页也要记下来，侧栏下次打开才跟得上
    const wv = $('#aw-webview');
    if (wv) {
      wv.addEventListener('did-navigate', (e) => {
        if (e && e.url) { S.url = e.url; sync({ url: e.url }); }
      });
    }

    // 关窗口前尽力再同步一次：sync 走的是单向 send，不等回执，
    // 比 invoke 更可能在页面销毁前把消息发出去。
    window.addEventListener('beforeunload', () => sync());

    // 已经开着的窗口又被点了一次「用新窗口打开」：主进程会把新状态推过来
    if (bridge && typeof bridge.on === 'function') {
      try { bridge.on('ai:init', (p) => apply(p)); } catch { /* 通道不可用时忽略 */ }
    }
  }

  async function boot() {
    wire();
    let init = {};
    try { init = (await bridge.ai.init()) || {}; } catch { init = {}; }
    apply(init);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
