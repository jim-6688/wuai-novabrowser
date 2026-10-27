/* ==========================================================================
   广告拦截 · 独立窗口
   --------------------------------------------------------------------------
   把原来塞在设置抽屉里的「广告拦截」面板搬成一个真正的独立窗口，点工具栏
   盾牌就弹出来（打开即最大化），不挤在设置页里。

   窗口自己拉一份状态、自己画、自己接按钮，跟主界面那一份互不依赖：
     - 读：bridge.adblock.stats() 一次性拿到 sources / blocked / rules / top /
            enabled / cosmetic / level / allowlist。
     - 写：开关、源切换、白名单、强度、导入、重置全都走既有的 bridge.adblock.*
           与 bridge.settings.patch，主进程那边照常落地、照常把变化 push 回
           主界面（主界面的盾牌图标与设置页会跟着变）。
     - 活：主进程每次拦截变化都 send('adblock:stats')，本窗口收到就原地刷新，
           让用户看见「本次会话已拦截」实时往上跳。

   关窗口只关这个窗口；adblock 没有要还给主界面的对话态，所以关掉就行。
   ========================================================================== */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const bridge = window.nova;

  const S = {
    adblock: { blocked: 0, sources: [], rules: {}, top: [], allowlist: [] },
    allowlist: []
  };

  /* ---------------- 小工具（窗口里没有 shell.js 那套，自己带一份） ---------------- */
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
    return String(n);
  }

  /* ---------------- 渲染 ---------------- */

  function renderSourceCards(s) {
    const sources = (s && s.sources) || [];
    if (!sources.length) return '';
    return `
      <div class="panel-label">拦截来源</div>
      ${sources.map((src) => {
        const c = src.counts || {};
        const lists = (src.lists || []);
        return `
        <div class="src-card ${src.enabled ? '' : 'is-off'}" data-src="${esc(src.id)}">
          <div class="src-head">
            <span class="src-name">${esc(src.name)}</span>
            <button class="switch ${src.enabled ? 'is-on' : ''}" data-source="${esc(src.id)}"
                    title="${src.enabled ? '停用该源' : '启用该源'}"></button>
          </div>
          <div class="src-vendor">${esc(src.vendor)}</div>
          <div class="src-metrics">
            <span class="sm"><b>${fmtNum(c.network)}</b> 网络</span>
            <span class="sm"><b>${fmtNum(c.cosmetic)}</b> 隐藏</span>
            <span class="sm sm-hit"><b>${fmtNum(src.blocked)}</b> 命中</span>
          </div>
          ${lists.filter((l) => l.rules).map((l) => `
            <div class="src-list" title="${esc(l.url || '随应用内置，不依赖网络')}">
              <span class="sl-title">${esc(l.title || l.file)}</span>
              <span class="sl-count">${fmtNum(l.rules)} 条</span>
            </div>`).join('')}
          ${lists.filter((l) => l.missing).map((l) => `
            <div class="src-list is-missing">
              <span class="sl-title">${esc(l.title || l.file)}</span>
              <span class="sl-count">未下载</span>
            </div>`).join('')}
          ${src.note ? `<div class="src-note">${esc(src.note)}</div>` : ''}
        </div>`;
      }).join('')}
    `;
  }

  function render() {
    const s = S.adblock;
    const ab = {
      enabled: s.enabled !== false,
      cosmetic: s.cosmetic !== false,
      level: s.level || 'standard'
    };
    const sources = s.sources || [];
    const onCount = sources.filter((x) => x.enabled).length;
    const allow = S.allowlist || [];

    const html = `
      <h2 class="sv-h2">广告拦截</h2>
      <div class="sv-lead">
        ${sources.length ? `${sources.length} 个拦截源，当前启用 ${onCount} 个。` : ''}
        三个源各自独立判定，都可单独关掉；规则自带索引，十万级规则下单次判定仍在微秒量级。
      </div>

      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-value is-ok">${fmtNum(s.blocked)}</div>
          <div class="stat-label">本次会话已拦截</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${fmtNum(s.rules && s.rules.network)}</div>
          <div class="stat-label">网络规则</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${fmtNum(s.rules && s.rules.cosmetic)}</div>
          <div class="stat-label">隐藏规则</div>
        </div>
      </div>

      ${renderSourceCards(s)}

      <div class="panel-label">总开关</div>
      <div class="sv-card">
        <div class="list-row">
          <span class="lr-main"><span class="lr-title">启用广告拦截</span><span class="lr-sub">网络层 + 元素隐藏</span></span>
          <button class="switch ${ab.enabled ? 'is-on' : ''}" data-toggle="enabled"></button>
        </div>
        <div class="list-row">
          <span class="lr-main"><span class="lr-title">元素隐藏（外观过滤）</span><span class="lr-sub">干掉自售广告位</span></span>
          <button class="switch ${ab.cosmetic ? 'is-on' : ''}" data-toggle="cosmetic"></button>
        </div>
      </div>

      <div class="panel-label">拦截强度</div>
      <div class="panel-section">
        <div class="segmented" id="ab-level">
          <button data-level="standard" class="${ab.level === 'standard' ? 'is-active' : ''}">标准</button>
          <button data-level="aggressive" class="${ab.level === 'aggressive' ? 'is-active' : ''}">严格</button>
        </div>
        <div class="muted" style="padding:var(--sp-2) 0 0">标准档只拦第三方统计；严格档连第一方埋点一并拦截。</div>
      </div>

      <div class="panel-label">白名单（${allow.length}）</div>
      <div class="abw-allow-add">
        <input id="ab-allow-input" placeholder="输入站点域名，如 example.com" spellcheck="false" />
        <button class="btn" data-allow-add="1">加入</button>
      </div>
      ${allow.length ? `
      <div class="sv-card">
        ${allow.map((h) => `
          <div class="list-row">
            <span class="lr-main"><span class="lr-sub" style="font-size:12px;color:var(--text-2)">${esc(h)}</span></span>
            <button class="btn" data-unallow="${esc(h)}">移除</button>
          </div>`).join('')}
      </div>` : '<div class="sv-empty">还没有例外站点。拦截误伤时把站点域名加进来即可。</div>'}

      <div class="panel-label">拦截来源 Top</div>
      ${(s.top || []).length ? `<div class="sv-card">${(s.top).map((r) => `
        <div class="list-row">
          <span class="lr-main"><span class="lr-sub" style="font-size:12px;color:var(--text-2)">${esc(r.host)}</span></span>
          <span class="lr-tail">${r.count} 次</span>
        </div>`).join('')}</div>` : '<div class="muted">本次会话还没有拦截记录。</div>'}

      <div class="btn-row">
        <button class="btn btn-primary" data-act="import-list">导入过滤清单</button>
        <button class="btn" data-act="reset-stats">重置统计</button>
      </div>
      <div class="muted">
        支持 EasyList / ABP 语法：<code>||域名^</code>、<code>@@</code> 例外、<code>$third-party</code> 选项、<code>##选择器</code> 元素隐藏。<br />
        未执行请求改写类规则（<code>$redirect=</code> / <code>$csp=</code> / <code>$removeparam=</code>），装载时如实跳过并计入 skipped。
      </div>
    `;

    const root = $('#abw-root');
    if (!root) return;
    const prevScroll = root.scrollTop;
    root.innerHTML = html;
    root.scrollTop = prevScroll;
  }

  /* ---------------- 操作 ---------------- */

  async function refreshStats() {
    try { S.adblock = (await bridge.adblock.stats()) || S.adblock; } catch { /* 忽略 */ }
    S.allowlist = S.adblock.allowlist || [];
    render();
  }

  async function toggleMaster(key, next) {
    await bridge.settings.patch({ adblock: { [key]: next } });
    // settings:patch 会经 adblock.configure 落到引擎，再经 onChange 把新快照 push 回来；
    // 这里不等推送，先本地翻一下，界面立刻有反应。
    S.adblock[key] = next;
    render();
  }

  async function toggleSource(id, next) {
    const s = await bridge.adblock.sourceToggle(id, next);
    if (s) S.adblock = s;
    render();
  }

  async function setLevel(level) {
    await bridge.settings.patch({ adblock: { level } });
    S.adblock.level = level;
    render();
  }

  async function addAllow(host) {
    host = (host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!host) return;
    S.allowlist = await bridge.adblock.allowlistAdd(host);
    S.adblock.allowlist = S.allowlist;
    render();
  }

  async function removeAllow(host) {
    S.allowlist = await bridge.adblock.allowlistRemove(host);
    S.adblock.allowlist = S.allowlist;
    render();
  }

  async function resetStats() {
    S.adblock = await bridge.adblock.reset();
    S.allowlist = S.adblock.allowlist || [];
    render();
  }

  async function importList() {
    const r = await bridge.adblock.importList();
    if (r && r.imported) {
      S.adblock = await bridge.adblock.stats();
      S.allowlist = S.adblock.allowlist || [];
      render();
      toast(`已导入 ${r.imported} 条规则`);
    } else if (r && r.note) {
      toast(r.note);
    } else {
      toast('未导入任何文件');
    }
  }

  function toast(msg) {
    // 窗口里没有主界面的 toast 通道：用最朴素的临时浮层顶一下
    let t = $('#abw-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'abw-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);'
        + 'background:rgba(20,22,28,.92);color:#fff;padding:8px 14px;border-radius:10px;'
        + 'font-size:13px;z-index:50;max-width:80%;text-align:center;pointer-events:none;'
        + 'transition:opacity .2s;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 1800);
  }

  /* ---------------- 事件接线（委托在 #abw-root 上） ---------------- */

  function wire() {
    const root = $('#abw-root');
    if (root) {
      root.addEventListener('click', async (ev) => {
        const sw = ev.target.closest('[data-toggle]');
        if (sw) {
          const key = sw.dataset.toggle;
          const next = !sw.classList.contains('is-on');
          sw.classList.toggle('is-on', next);
          await toggleMaster(key, next);
          toast(next ? '已开启' : '已关闭');
          return;
        }
        const srcSw = ev.target.closest('[data-source]');
        if (srcSw) {
          const id = srcSw.dataset.source;
          const next = !srcSw.classList.contains('is-on');
          srcSw.classList.toggle('is-on', next);
          const src = ((S.adblock.sources) || []).find((x) => x.id === id);
          toast(`${src ? src.name : id} 已${next ? '启用' : '停用'}`);
          await toggleSource(id, next);
          return;
        }
        const lvl = ev.target.closest('#ab-level button');
        if (lvl) {
          root.querySelectorAll('#ab-level button').forEach((x) => x.classList.toggle('is-active', x === lvl));
          await setLevel(lvl.dataset.level);
          toast(lvl.dataset.level === 'aggressive' ? '已切换为严格拦截' : '已切换为标准拦截');
          return;
        }
        const addBtn = ev.target.closest('[data-allow-add]');
        if (addBtn) {
          const inp = $('#ab-allow-input');
          await addAllow(inp ? inp.value : '');
          if (inp) inp.value = '';
          return;
        }
        const unallow = ev.target.closest('[data-unallow]');
        if (unallow) {
          await removeAllow(unallow.dataset.unallow);
          toast(`已移出白名单：${unallow.dataset.unallow}`);
          return;
        }
        const act = ev.target.closest('[data-act]');
        if (act) {
          if (act.dataset.act === 'reset-stats') { await resetStats(); toast('统计已重置'); }
          else if (act.dataset.act === 'import-list') { await importList(); }
        }
      });

      // 白名单输入框回车也能加
      root.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && ev.target && ev.target.id === 'ab-allow-input') {
          ev.preventDefault();
          addAllow(ev.target.value).then(() => { ev.target.value = ''; });
        }
      });
    }

    const closeBtn = $('#abw-close');
    if (closeBtn) closeBtn.addEventListener('click', () => window.close());

    // 主进程每次拦截变化都推快照过来，原地刷新（含「已拦截」实时跳动）
    if (bridge && typeof bridge.on === 'function') {
      try { bridge.on('adblock:stats', (s) => { if (s && typeof s === 'object') { S.adblock = s; S.allowlist = s.allowlist || []; render(); } }); } catch { /* 通道不可用时忽略 */ }
    }
  }

  async function boot() {
    wire();
    await refreshStats();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
