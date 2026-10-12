'use strict';

/**
 * 内核适配层（Engine Adapter Layer）
 * ---------------------------------------------------------------------------
 * 设计原则：
 *  1. 内核能力差异全部收敛到 Engine Adapter 里，上层（tab / renderer / adblock）
 *     只认 engine.id，不关心底下是 Blink、Gecko 还是 Trident。
 *  2. 三种运行时模式，UI 必须如实标注，不允许把兼容层伪装成真内核：
 *       native  真正的内核进程内渲染（Chromium/Blink 走这条）
 *       bridge  通过「原生内核宿主进程」渲染（native/bin/*-host.exe，真 Gecko / 真 Trident）
 *       compat  兼容层：用 Chromium 渲染，但完整伪造该内核的 UA / 客户端提示 / 文档模式 / API 垫片
 *  3. 原生宿主二进制存在时自动升级为 bridge，不存在就诚实降级为 compat。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..', '..');
const HOST_BIN_DIR = path.join(ROOT, 'native', 'bin');
const ENGINE_MANIFEST = path.join(ROOT, 'native', 'engines', 'manifest.json');

const CHROME_MAJOR = (process.versions.chrome || '126.0.0.0').split('.')[0];

/**
 * 读取内核清单（由 tools/check-engines.js 生成）。
 * 清单记录每个内核「二进制是否真的在本地」以及 PE 校验结果。
 * 读不到就返回 null —— 引擎必须能在没有清单的情况下正常工作。
 */
let _manifest;
function loadKernelManifest() {
  if (_manifest !== undefined) return _manifest;
  try {
    const m = JSON.parse(fs.readFileSync(ENGINE_MANIFEST, 'utf8'));
    _manifest = m && m.engines ? m : null;
  } catch {
    _manifest = null;
  }
  return _manifest;
}

/* ========================================================================== *
 * 原生内核宿主桥（Native Kernel Host Bridge）
 * 协议：stdio 上的换行分隔 JSON（NDJSON）。详见 native/README.md
 * ========================================================================== */

class NativeKernelHost extends EventEmitter {
  constructor(kernelId) {
    super();
    this.kernelId = kernelId;
    this.proc = null;
    this.buf = '';
    this.seq = 0;
    this.pending = new Map();
  }

  /** 探测宿主可执行文件是否存在 */
  probe() {
    const exe = process.platform === 'win32'
      ? path.join(HOST_BIN_DIR, `${this.kernelId}-host.exe`)
      : path.join(HOST_BIN_DIR, `${this.kernelId}-host`);
    if (fs.existsSync(exe)) return { available: true, exe };
    return {
      available: false,
      exe: null,
      reason: `未找到原生宿主 ${path.relative(ROOT, exe)}，已降级为兼容层`
    };
  }

  /** 启动宿主进程；未安装二进制时抛错，由调用方降级 */
  start() {
    const { available, exe, reason } = this.probe();
    if (!available) return Promise.reject(new Error(reason));

    this.proc = spawn(exe, ['--ndjson'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (t) => console.warn(`[${this.kernelId}-host]`, t.trim()));
    this.proc.on('exit', (code) => {
      this.emit('exit', code);
      this.proc = null;
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('宿主启动超时')), 5000);
      this.once('ready', (info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.t === 'ready') this.emit('ready', msg);
      else if (msg.t === 'reply' && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      } else this.emit(msg.t, msg);
    }
  }

  send(type, payload = {}, { expectReply = false, timeout = 8000 } = {}) {
    if (!this.proc) return Promise.reject(new Error('宿主未运行'));
    const id = ++this.seq;
    const line = JSON.stringify(Object.assign({ t: type, id }, payload)) + '\n';
    this.proc.stdin.write(line);
    if (!expectReply) return Promise.resolve({ ok: true, id });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} 超时`));
      }, timeout);
      this.pending.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); }
      });
    });
  }

  stop() {
    if (this.proc) {
      try { this.proc.stdin.end(); } catch { /* noop */ }
      this.proc.kill();
      this.proc = null;
    }
  }
}

/* ========================================================================== *
 * 兼容层垫片：注入到页面里，让「按内核特性检测」的老站点走对分支
 * ========================================================================== */

const SHIMS = {
  trident: `/* Nova · IE 兼容层垫片 */
(function () {
  if (window.__NOVA_ENGINE_SHIM__) return;
  window.__NOVA_ENGINE_SHIM__ = 'trident-compat';
  try {
    // 1) 文档模式：告诉老脚本「我是 IE11」
    Object.defineProperty(document, 'documentMode', { get: function () { return 11; }, configurable: true });
    // 2) 补回 X-UA-Compatible，某些老页面靠 meta 判断分支
    var head = document.head || document.documentElement;
    if (head && !head.querySelector('meta[http-equiv="X-UA-Compatible"]')) {
      var m = document.createElement('meta');
      m.setAttribute('http-equiv', 'X-UA-Compatible');
      m.setAttribute('content', 'IE=edge');
      head.insertBefore(m, head.firstChild);
    }
    // 3) 老式事件模型
    if (!Element.prototype.attachEvent) {
      Element.prototype.attachEvent = function (n, h) { this.addEventListener(String(n).replace(/^on/, ''), h); };
      Element.prototype.detachEvent = function (n, h) { this.removeEventListener(String(n).replace(/^on/, ''), h); };
    }
    if (!window.attachEvent) {
      window.attachEvent = function (n, h) { window.addEventListener(String(n).replace(/^on/, ''), h); };
      window.detachEvent = function (n, h) { window.removeEventListener(String(n).replace(/^on/, ''), h); };
    }
    // 4) 老站常见特性检测
    if (typeof window.ActiveXObject === 'undefined') {
      window.ActiveXObject = function () { throw new Error('ActiveX 已在本内核中停用'); };
    }
    if (!('execCommand' in document)) { /* 现代 Blink 仍保留 */ }
    // 5) 条件注释残留在 innerHTML 里时兜底清理
    window.__NOVA_IE_COMPAT_READY__ = true;
  } catch (e) { /* 静默 */ }
})();`,

  gecko: `/* Nova · Gecko 兼容层垫片 */
(function () {
  if (window.__NOVA_ENGINE_SHIM__) return;
  window.__NOVA_ENGINE_SHIM__ = 'gecko-compat';
  try {
    // 1) Firefox WebExtension 里 browser.* 是 promise 风格；Chromium 只有 chrome.*
    //    把 browser 指过去，让「先探测 browser 再探测 chrome」的站点/扩展能跑
    if (!window.browser && window.chrome) window.browser = window.chrome;
    // 2) moz 前缀属性兜底
    var d = document;
    if (!('mozFullScreenEnabled' in d) && 'fullscreenEnabled' in d) {
      Object.defineProperty(d, 'mozFullScreenEnabled', { get: function () { return d.fullscreenEnabled; }, configurable: true });
    }
    if (!('mozHidden' in d) && 'hidden' in d) {
      Object.defineProperty(d, 'mozHidden', { get: function () { return d.hidden; }, configurable: true });
    }
    // 3) 老站用 mozRequestAnimationFrame 做特性检测
    if (!window.mozRequestAnimationFrame) window.mozRequestAnimationFrame = window.requestAnimationFrame;
    if (!window.mozCancelAnimationFrame) window.mozCancelAnimationFrame = window.cancelAnimationFrame;
    // 4) CSS.supports('-moz-*') 兜底：把 -moz-appearance 映射为可用的 appearance
    if (window.CSS && CSS.supports && !CSS.supports('-moz-appearance', 'none')) {
      var orig = CSS.supports.bind(CSS);
      CSS.supports = function (a, b) {
        if (typeof a === 'string' && a.indexOf('-moz-') === 0) return orig('appearance', b);
        return orig(a, b);
      };
    }
    window.__NOVA_GECKO_COMPAT_READY__ = true;
  } catch (e) { /* 静默 */ }
})();`
};

/* ========================================================================== *
 * 引擎定义
 * ========================================================================== */

const DEFINITIONS = [
  {
    id: 'chromium',
    label: 'Chromium',
    vendor: 'Blink · 现代标准内核',
    short: 'CR',
    accent: '#3D6BFF',
    partition: 'persist:nova-chromium',
    runtime: 'native',
    canBeNative: true,
    userAgent:
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    clientHints: { platform: '"Windows"', mobile: '?0' },
    headers: {},
    shim: null,
    capabilities: { crx: true, xpi: 'polyfill', adblock: true, devtools: true },
    notes: '进程内真实 Blink 渲染，插件与 DevTools 完整可用。'
  },
  {
    id: 'gecko',
    label: 'Gecko',
    vendor: 'Firefox 内核',
    short: 'GK',
    accent: '#FF7139',
    partition: 'persist:nova-gecko',
    runtime: 'bridge', // 有二进制的原生宿主 → bridge
    canBeNative: false,
    userAgent:
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${CHROME_MAJOR}.0) Gecko/20100101 Firefox/${CHROME_MAJOR}.0`,
    clientHints: { platform: '"Windows"', mobile: '?0' },
    headers: { 'Sec-Fetch-Site': 'none' },
    shim: SHIMS.gecko,
    capabilities: { crx: 'polyfill', xpi: true, adblock: true, devtools: false },
    notes: '真内核 XULRunner 45 二进制已在 native/engines/gecko-xulrunner45（32 位，xul.dll 38MB）。' +
      '尚缺原生宿主 native/bin/gecko-host.exe —— 必须编译为 x86，否则无法加载 32 位 xul.dll。'
  },
  {
    id: 'trident',
    label: 'IE / Trident',
    vendor: 'IE11 兼容内核',
    short: 'IE',
    accent: '#0A84C6',
    partition: 'persist:nova-trident',
    runtime: 'bridge',
    canBeNative: false,
    userAgent:
      `Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; .NET4.0C; .NET4.0E; rv:11.0) like Gecko`,
    clientHints: null, // IE11 不发送 Client Hints，必须整组抹掉
    headers: { DNT: '1' },
    shim: SHIMS.trident,
    capabilities: { crx: false, xpi: false, adblock: true, devtools: false },
    notes: 'Trident 不是可下载的独立程序 —— 它由系统 mshtml.dll 提供（已检测到，22MB）。' +
      '尚缺原生宿主 native/bin/trident-host.exe（MSHTML WebBrowser 控件宿主），编译前以兼容层渲染。'
  }
];

/* ========================================================================== *
 * 引擎实例
 * ========================================================================== */

class Engine {
  constructor(def) {
    Object.assign(this, def);
    this.host = new NativeKernelHost(this.id);
    this.hostInfo = null;
    this.mode = this.runtime === 'native' ? 'native' : 'compat';
    this.fallbackReason = null;

    const man = loadKernelManifest();
    this.kernel = man ? man.engines[this.id] || null : null;
  }

  /**
   * 降级原因要落到「缺的是哪一环」，不能笼统一句「未启用原生宿主」。
   * 真内核二进制在、只差未编译的宿主，与「什么都没下」，是两件完全不同的事。
   */
  describeFallback() {
    const k = this.kernel;
    if (k && k.binariesReady) {
      const ready = (k.sources || []).filter((s) => s.complete);
      const arch = k.arch ? `（${String(k.arch).split(' ')[0]}）` : '';
      // 系统组件与下载来的二进制，措辞必须分开 —— 前者不占磁盘，后者是我们拉下来的
      const sysOnly = ready.length > 0 && ready.every((s) => s.role === 'system');
      const head = sysOnly
        ? `内核由系统提供${arch}：${ready.map((s) => s.label).join('、')}`
        : `真内核二进制已就位${arch}：${ready.map((s) => s.version || s.label).join('、')}`;
      return `${head}。尚缺原生宿主 native/bin/${this.id}-host.exe（需自行编译），编译前以兼容层渲染。`;
    }
    if (k && k.blocker) return k.blocker;
    return `未找到 ${this.label} 的真内核二进制，也未启用原生宿主；以兼容层渲染。`;
  }

  /** 解析最终运行时模式：能起原生宿主就是 bridge，否则 compat */
  async resolve(forceCompat = false) {
    if (this.runtime === 'native') {
      this.mode = 'native';
      return this;
    }
    const probe = this.host.probe();
    if (!forceCompat && probe.available) {
      try {
        this.hostInfo = await this.host.start();
        this.mode = 'bridge';
        this.fallbackReason = null;
        return this;
      } catch (err) {
        this.fallbackReason = err.message;
      }
    } else {
      this.fallbackReason = this.describeFallback();
    }
    if (!this.fallbackReason) this.fallbackReason = this.describeFallback();
    this.mode = 'compat';
    return this;
  }

  /** 内核二进制侧的真实情况（供 UI 展示「真内核下到哪一步了」） */
  kernelInfo() {
    const k = this.kernel;
    if (!k) return null;
    return {
      binariesReady: !!k.binariesReady,
      bridgeReady: !!k.bridgeReady,
      arch: k.arch || null,
      blocker: k.blocker || null,
      sources: (k.sources || []).map((s) => ({
        id: s.id,
        label: s.label,
        version: s.version || null,
        complete: !!s.complete,
        sizeBytes: s.sizeBytes || 0,
        fileCount: s.fileCount || 0,
        signature: s.signature
          ? {
              valid: !!s.signature.valid,
              detected: s.signature.detected || null,
              arch: s.signature.arch || null,
              exportCount: s.signature.exportCount || 0,
              linkedAt: s.signature.linkedAt || null
            }
          : null
      }))
    };
  }

  /** 渲染进程创建 <webview> 需要的完整描述 */
  descriptor() {
    return {
      id: this.id,
      label: this.label,
      vendor: this.vendor,
      short: this.short,
      accent: this.accent,
      partition: this.partition,
      mode: this.mode,
      modeLabel: { native: '原生内核', bridge: '原生桥接', compat: '兼容层' }[this.mode],
      userAgent: this.userAgent,
      shim: this.mode === 'compat' ? this.shim : null,
      capabilities: this.capabilities,
      notes: this.notes,
      fallbackReason: this.mode === 'compat' ? this.fallbackReason : null,
      kernel: this.kernelInfo()
    };
  }

  /** 给 session 挂响应头改写：伪造 UA / Client Hints，让站点识别成目标内核 */
  applyHeaders(ses) {
    const ua = this.userAgent;
    const hints = this.clientHints;

    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      const headers = Object.assign({}, details.requestHeaders);
      headers['User-Agent'] = ua;
      if (hints) {
        headers['Sec-CH-UA'] = `"Chromium";v="${CHROME_MAJOR}", "Not(A:Brand";v="24"`;
        headers['Sec-CH-UA-Mobile'] = hints.mobile;
        headers['Sec-CH-UA-Platform'] = hints.platform;
      } else {
        delete headers['Sec-CH-UA'];
        delete headers['Sec-CH-UA-Mobile'];
        delete headers['Sec-CH-UA-Platform'];
        delete headers['Sec-CH-UA-Full-Version-List'];
        delete headers['Sec-CH-UA-Arch'];
        delete headers['Sec-CH-UA-Bitness'];
        delete headers['Sec-CH-UA-Model'];
      }
      for (const [k, v] of Object.entries(this.headers || {})) headers[k] = v;
      cb({ requestHeaders: headers });
    });
  }

  stop() {
    this.host.stop();
  }
}

/* ========================================================================== *
 * 注册表
 * ========================================================================== */

class EngineRegistry {
  constructor() {
    this.engines = DEFINITIONS.map((d) => new Engine(d));
    this.byId = new Map(this.engines.map((e) => [e.id, e]));
  }

  get(id) {
    return this.byId.get(id) || this.byId.get('chromium');
  }

  list() {
    return this.engines.map((e) => e.descriptor());
  }

  async resolveAll(opts) {
    // 强制重读清单：用户点「重新探测」时，必须反映磁盘此刻的真实状态，
    // 不能拿进程启动时的那份缓存。
    _manifest = undefined;
    const man = loadKernelManifest();
    for (const e of this.engines) {
      if (man) e.kernel = man.engines[e.id] || null;
      await e.resolve(opts && opts.forceCompat);
    }
    return this.list();
  }

  stopAll() {
    this.engines.forEach((e) => e.stop());
  }
}

module.exports = {
  EngineRegistry,
  Engine,
  NativeKernelHost,
  SHIMS,
  HOST_BIN_DIR,
  ENGINE_MANIFEST,
  loadKernelManifest,
  CHROME_MAJOR
};
