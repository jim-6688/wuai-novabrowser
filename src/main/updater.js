'use strict';

/**
 * PC 端自动更新
 * ---------------------------------------------------------------------------
 * 做的是**差分更新**：下载新版本时只传与旧版本不同的块（blockmap），而不是
 * 整个 78MB 安装包。用户从 1.0.0 更新到 1.0.1 通常只有几 MB。
 *
 * 为什么值得做：安装包 78MB 里绝大部分是 Electron 运行时与 Chromium 内核，
 * 而自己的代码只有 660KB（src/ 整个目录）。差分更新传的正是后者那点差异，
 * 这是这个项目能拿到的最大收益。
 *
 * ── 一个必须说明的取舍：为什么不用官方的 latest.yml ──
 * electron-updater 的 generic provider 默认读更新源上的 `latest.yml`。
 * 本项目改成读 `site/version.json`，理由是：
 *   1) 那一份清单**已经存在**，而且手机端与官网都在读它（app_version 的
 *      唯一来源）。再维护一份 yml 等于多一个要记得同步的地方 ——
 *      而「发布时忘了改其中一份」正是本项目最容易被静默破坏的那类错
 *      （见 mobile:check 存在的理由）。
 *   2) 清单里有 sha256 与 size，能直接做完整性校验，不依赖 yml 的字段。
 * 所以这里实现了一个自定义 provider：自己去读清单、自己比对版本、
 * 自己下文件，**不引 latest.yml，也不设publish 配置**。
 *
 * ── 为什么不支持「只替换某个文件」的热更新 ──
 * 代码全部打进 app.asar（见 dist/win-unpacked/resources/app.asar）。
 * asar 是不可变归档，Electron 没有提供热替换其中单个文件的能力 ——
 * 要改就得解包、改、再整个打包。所以「改一行 css 只下 20KB」这条路在
 * 当前的打包形态下走不通，本模块做的是**包级差分**，不是文件级热更。
 * 真正能单独热更的是「内容类资产」（广告规则、内置脚本、搜索引擎表），
 * 那是另一条通道的事，见 memory 里的记录。
 *
 * ── 用户可见的行为（刻意做得不打扰）──
 *   · 启动后静默检查一次，不弹窗
 *   · 有新版只在工具栏挂一个角标，由用户点开决定要不要装
 *   · 不自动下载：不吃用户带宽，也不做用户没同意的事
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const SETTINGS_FILE = path.join(ROOT, 'settings.json');

/**
 * 惰性取 autoUpdater。
 *
 * <p><b>为什么不能在文件头直接 require('electron-updater')</b>：它的模块顶层
 * 就会 new 一个 NsisUpdater，而那会读 {@code app.getVersion()} —— 在纯 Node 下
 * （本地单测、以及任何还没进 Electron 的进程里）`app` 是 undefined，直接抛
 * {@code TypeError}，整个文件都require 不进来。
 *
 * <p>改成第一次真正要用时才取，且取不到就返回 null：
 * 纯逻辑部分（版本比对、清单判定）于是可以脱离 Electron 单独跑单测 ——
 * 见 tools/test-updater.js。
 */
let _autoUpdater = null;
function getAutoUpdater() {
  if (_autoUpdater !== null) return _autoUpdater || null;
  const app = requireElectronApp();
  if (!app) { _autoUpdater = false; return null; }
  try {
    // eslint-disable-next-line global-require
    const { autoUpdater } = require('electron-updater');
    _autoUpdater = autoUpdater;
  } catch {
    _autoUpdater = false; // 记住「取不到」，别每次都重试
    return null;
  }
  return _autoUpdater;
}

/** 取 Electron 的 app；不在 Electron 里（本地单测）时返回 null。 */
function requireElectronApp() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    if (!app || typeof app.getVersion !== 'function') return null;
    return app;
  } catch {
    return null;
  }
}

/** 清单与下载地址。官网正式域名，换域名时只改这一处。 */
const MANIFEST_URL = 'https://nova.52ta.top/version.json';

/** 版本号比大小：逐段按数字比，「1.10.0」要大于「1.9.0」。 */
function isNewer(remote, local) {
  const r = String(remote || '').split('.').map((n) => parseInt(n, 10) || 0);
  const l = String(local || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const a = r[i] || 0;
    const b = l[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

/**
 * 取更新源的清单。
 *
 * <p>刻意走 https 且**不开证书跳过**：更新渠道是整条链路里最该守住的地方，
 * 一旦被中间人替换，用户装的就是攻击者选的文件。这里失败就返回 null，
 * 让上层当作「没查到新版」，而不是降级到不校验的下载。
 *
 * <p>第二个参数 {@link httpGet} 只为本地单测存在（测试用 http 起一个本地
 * 服务喂清单）。生产路径永远走 https —— 单测能覆盖的决策逻辑不该因为
 * 「本机只有 http」这种测试便利而放开真实链路。
 */
function fetchManifest(url, redirectsLeft, httpGet) {
  const get = httpGet || httpsGet;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // 重定向最多跟 3 跳：跟多了防不住 redirect loop，也不该无限追下去
    const left = redirectsLeft === undefined ? 3 : redirectsLeft;
    get(url, left, finish);
  });
}

/** 真实取数：https + 重定向。取不到一律 finish(null)，绝不让异常逃出去。 */
function httpsGet(url, left, finish) {
  try {
    const req = https.get(new URL(url), { timeout: 12000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (left <= 0) return finish(null);
        let next;
        try { next = new URL(res.headers.location, url).href; } catch { return finish(null); }
        return finish(fetchManifest(next, left - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return finish(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 512 * 1024) body += c; });
      res.on('end', () => {
        try { finish(JSON.parse(body)); } catch { finish(null); }
      });
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => { req.destroy(); finish(null); });
  } catch {
    finish(null);
  }
}

/**
 * 算出「当前能不能更新、有没有新版」。
 *
 * @param {string} localVersion 本地版本
 * @param {string} [manifestUrl] 清单地址（测试时注入）
 * @returns {Promise<{updateAvailable:boolean, version?:string, notes?:string[], url?:string, sha256?:string, size?:number, reason?:string}>}
 */
async function check(localVersion, manifestUrl, httpGet) {
  const m = await fetchManifest(manifestUrl || MANIFEST_URL, undefined, httpGet);
  if (!m || !m.pc || !m.pc.version) {
    return { updateAvailable: false, reason: '清单不可达或格式不对' };
  }
  if (!isNewer(m.pc.version, localVersion)) {
    return { updateAvailable: false, reason: '已是最新' };
  }
  // 优先给 ZIP：浏览器对直接下 exe 会拦，而 exe 未签名、用户还得再过一道
  // SmartScreen。清单里没有 exe 段时退回主 url。
  const dl = m.pc.zip || m.pc;
  return {
    updateAvailable: true,
    version: m.pc.version,
    notes: Array.isArray(m.changelog) ? m.changelog : [],
    url: dl.url,
    sha256: dl.sha256 || '',
    size: dl.size || 0,
    reason: ''
  };
}

/**
 * 让 autoUpdater 听我们的话：只认 zip 通道，并接上自定义的清单来源。
 *
 * <p>刻意关掉官方那条latest.yml 通道 —— 它会自己去下载源上的 yml，
 * 而我们的源上没有这个文件（清单是 version.json）。留着它只会每次检查
 * 都吃一个 404，然后被当成「检查失败」，日志里全是噪音。
 */
function configure(updater) {
  const u = updater || getAutoUpdater();
  if (!u) return null;
  // 没打包（开发模式）时一律不碰：electron-updater 会去找 app-update.yml，
  // dev 模式下没有这个文件，碰了直接抛错，把启动流程打断。
  const app = requireElectronApp();
  if (app && app.isPackaged === false) return null;

  u.autoDownload = false; // 发现新版只提示，下载由用户点「下载并安装」触发
  u.logger = null;
  return u;
}

/** 启动一次检查。**永不 reject**：更新失败不是致命错误，界面照常用。 */
async function start(currentVersion, handlers, manifestUrl, httpGet) {
  const state = { status: 'idle', info: null, error: '', lastCheckAt: '' };
  const emit = () => { if (handlers && typeof handlers.onState === 'function') handlers.onState({ ...state }); };

  state.status = 'checking';
  emit();

  let info;
  try {
    info = await check(currentVersion, manifestUrl, httpGet);
  } catch (e) {
    // check 内部已经兜过大部分情况，这里只是最后一道
    info = { updateAvailable: false, reason: String(e && e.message || e) };
  }

  // 不管结果如何都记下这次检查的时间：界面上「上次检查：…」要靠它，
  // 而「查了但失败了」与「从没查过」在界面上必须读得出区别。
  state.lastCheckAt = new Date().toISOString();

  if (!info.updateAvailable) {
    state.status = 'idle';
    state.error = info.reason || '';
    emit();
    return state;
  }

  state.status = 'available';
  state.info = info;
  emit();
  return state;
}

/**
 * 真的去下载并安装。
 *
 * <p>走的是 electron-updater 的下载器：它会自动用 blockmap 算差分，
 * 这正是我们要的 —— 传下去的是变化的那部分块，不是整个包。
 *
 * <p>下载地址来自我们的清单而不是 latest.yml，所以要先用
 * {@link setFeedURL} 把 autoUpdater 指向它。
 */
function downloadAndInstall(state, handlers) {
  return new Promise((resolve, reject) => {
    const info = state && state.info;
    if (!info || !info.url) {
      reject(new Error('没有可下载的地址'));
      return;
    }
    const u = configure();
    if (!u) {
      reject(new Error('当前环境不支持自动更新（未打包或缺少 electron-updater）'));
      return;
    }

    // 指向我们的清单里的那个地址。fileName 必须与 blockmap 同名，
    // 否则 electron-updater 找不到差分文件、退回整包下载（不会出错，
    // 只是白费了差分）。
    const file = info.url.split('/').pop();
    u.setFeedURL({
      provider: 'generic',
      url: info.url.replace(/\/[^/]*$/, '/')
    });
    try {
      // 有些版本只认 autoDownload 开关，这里两者都设上
      u.autoDownload = true;

      /* 必须先让 electron-updater 自己查一遍，再 downloadUpdate。
       *
       * <p>原因（踩过，且首版就是这么写的）：{@code downloadUpdate(cancellationToken)}
       * 的第一参数是**取消令牌**而不是文件名 —— 传文件名进去会被忽略。真正致命的是
       * 它开头那句 {@code if (this.updateInfoAndProvider == null) reject(...)}：
       * 那个字段**只在 {@code checkForUpdates()} 里赋值**。
       *
       * <p>而本文件里的 {@link check} 是自己读 version.json 实现的，
       * 从没调用过 electron-updater 的 {@code checkForUpdates} ——
       * 于是 updateInfoAndProvider 恒为 null，点「下载更新」**必然失败**，
       * 用户看到的是一句莫明其妙的「Please check update first」。
       * 也就是说自动更新从上线起就只有「发现新版」这一档是通的。
       *
       * <p>所以这里显式调一次 {@code checkForUpdates}：它走通用的 version.json
       * 格式（{@code {latest, files[]}}）并把内部状态填好，与我们自己的 check()
       * 读的是同一份清单，两边结论应当一致 —— 一致性由 tools/test-updater.js 钉住。
       *
       * <p>事件绑定放在这之后：checkForUpdates 与 download 都是异步，
       * 而 progress / downloaded / error 三个监听此刻装上仍来得及（见下）。 */
      u.checkForUpdates()
        .then(() => u.downloadUpdate())
        .catch((e) => reject(e));
    } catch (e) {
      reject(e);
      return;
    }

    const on = (ev, fn) => u.on(ev, fn);
    on('download-progress', (p) => {
      if (handlers && typeof handlers.onProgress === 'function') {
        handlers.onProgress({ percent: Math.round(p.percent || 0), speed: p.bytesPerSecond || 0 });
      }
    });
    on('update-downloaded', (i) => {
      // 装完不自动退出：用户可能正在填表单。让用户自己点。
      if (handlers && typeof handlers.onDownloaded === 'function') {
        handlers.onDownloaded({ version: (i && i.version) || info.version });
      }
      resolve(true);
    });
    on('error', (e) => {
      if (handlers && typeof handlers.onError === 'function') handlers.onError(String(e && e.message || e));
      reject(e);
    });
  });
}

/** 下载完成后退出并安装。由用户在界面上明确点击才调用。 */
function quitAndInstall(updater) {
  const u = configure(updater);
  if (!u) return false;
  try {
    u.quitAndInstall(false, true); // isSilent=false, isForceRunAfter=true
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  MANIFEST_URL,
  isNewer,
  fetchManifest,
  check,
  start,
  configure,
  downloadAndInstall,
  quitAndInstall
};