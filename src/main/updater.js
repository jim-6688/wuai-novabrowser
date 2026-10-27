'use strict';

/**
 * PC 端自动更新
 * ---------------------------------------------------------------------------
 * **自己下载安装包，不依赖 electron-updater。**
 *
 * 清单用 site/version.json（手机端与官网读的也是它），里面写好了
 * url / size / sha256 —— 下载与**完整性校验**需要的东西全都在手上。
 *
 * ── 为什么不用 electron-updater ──
 * 1. 它得被当成**运行时依赖**打进包（含依赖约 2.7 MB）。而本项目其余部分
 *    零运行时依赖（dependencies 是空的），为一个功能破这个例不划算。
 * 2. 它只认 latest.yml。我们的源上只有自己那份 version.json，走它就得
 *    再生成并托管一个 yml、再上传 .blockmap，链路多三节。
 *    而这条链路已经连着坏过两次：
 *      · downloadUpdate(cancellationToken) 的第一参数是取消令牌，
 *        我们把文件名传了进去（被静默忽略）；
 *      · 它压根没被打进包 —— 因为它在 devDependencies 里。
 *        用户看到的那句「当前环境下不支持自动更新（未打包或缺少
 *        electron-updater）」就是这一条。
 *
 * ── 代价：**没有差分下载** ──
 * 每次更新下完整的安装包（约 78 MB），而不是只传变化的那几 MB。
 * 安装包里绝大部分是 Electron 运行时与 Chromium 内核（自己的代码只有
 * 660KB），所以这个代价是实打实的。
 * 换来的是零运行时依赖、零额外托管文件，以及一条看得懂、测得到的链路 ——
 * 在链路已经坏过两次的前提下，这个取舍是划算的。
 * **以后想开差分，三样要一起做**：把依赖打进包、托管 latest.yml、
 * 上传 .blockmap。单独做任何一样都是白搭（没有 blockmap 时
 * electron-updater 会静默退回整包下载，而用户只会觉得「怎么还是慢」）。
 *
 * ── 为什么不支持「只替换某个文件」的热更新 ──
 * 代码全部打进 app.asar（见 dist/win-unpacked/resources/app.asar），
 * 而 asar 是不可变归档，Electron 没有提供热替换其中单个文件的能力 ——
 * 要改就得解包、改、再整个打包。真正能单独热更的是「内容类资产」
 * （广告规则、内置脚本、搜索引擎表），那是另一条通道的事。
 *
 * ── 用户可见的行为 ──
 *   · 启动后静默检查一次，不弹窗
 *   · 有新版默认**自动下载**（可在 关于 面板关掉）
 *   · 下载完默认**倒计时 8 秒后自动拉起安装器并重启**（可关，也可当场喊停）
 *     倒计时那一段在 renderer —— 因为「重启会丢未保存的内容」，
 *     要让用户有机会看清楚将要发生什么
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const SETTINGS_FILE = path.join(ROOT, 'settings.json');

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

/** 清单地址（多源，按顺序回退）。
 *  主源 = 官网；官网不可达时退回**码云仓库里的 raw version.json**（该文件已入库）。
 *  换域名 / 换仓库时只改这里。 */
const MANIFEST_URLS = [
  'https://nova.52ta.top/version.json',
  'https://gitee.com/jinghe-net/i-adore-the-nova-browser/raw/main/site/version.json'
];
/** 兼容旧引用：主清单地址。 */
const MANIFEST_URL = MANIFEST_URLS[0];

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
  // 多源清单：显式传入（单测只喂一个）就只试它；否则按 MANIFEST_URLS 依次回退
  const sources = manifestUrl ? [manifestUrl] : MANIFEST_URLS;
  let m = null;
  for (const src of sources) {
    m = await fetchManifest(src, undefined, httpGet);
    if (m && m.pc && m.pc.version) break;
    m = null;
  }
  if (!m || !m.pc || !m.pc.version) {
    return { updateAvailable: false, reason: '清单不可达或格式不对' };
  }
  if (!isNewer(m.pc.version, localVersion)) {
    return { updateAvailable: false, reason: '已是最新' };
  }
  /* 给**安装包本身（exe）**，不是 zip。
   *
   * <p>原先优先给 zip，理由是「浏览器对直接下 exe 会拦、用户还得再过一道
   * SmartScreen」。但那条理由只对**官网上的下载按钮**成立 —— 那是浏览器
   * 发起的下载。应用内的更新是我们自己用 https 取的，中间没有浏览器，
   * 不会触发那个拦截；而 zip 拿到手还得再解一次才有个安装器（zip 里就
   * 装着那一个 setup.exe）。
   *
   * <p>清单里没有 exe 段时退回主 url —— 那是老清单的形状。这种时候下面
   * 会拿到一个 .zip，而 {@link installAndRestart} 启动不了它，
   * 用户会看到一句「无法启动安装器」，好过静默失败。 */
  const dl = m.pc.exe || m.pc;
  /* 下载地址做成**多源回退**：清单里的 `pc.mirrors`（码云 / GitHub 等）优先，
     最后回落到主 `url`（多吉云）。每个源都可能失败（单附件超限、区域不可达、限速），
     所以给调用方一个有序列表，download() 逐个试、校验通过才收。 */
  const urls = [];
  const push = (x) => {
    const u = typeof x === 'string' ? x : (x && x.url);
    if (u && !urls.includes(u)) urls.push(u);
  };
  if (Array.isArray(m.pc.mirrors)) m.pc.mirrors.forEach(push);
  push(dl.url);
  return {
    updateAvailable: true,
    version: m.pc.version,
    // 只读 PC 自己这一版的更新日志。顶层 changelog 是 Android 的历史累加，
    // 拿来当 PC 的更新说明会把整份日志都铺进更新窗口。
    notes: Array.isArray(m.pc.changelog) ? m.pc.changelog : [],
    url: urls[0] || dl.url,
    urls,                          // 有序回退列表（新增；旧字段 url 保留 = 第一个）
    sha256: dl.sha256 || '',
    size: dl.size || 0,
    reason: ''
  };
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

/* ========================================================================== *
 * 下载与安装
 * --------------------------------------------------------------------------
 * **刻意不用 electron-updater**。
 *
 * <p>原因是它在这个项目里要付两份成本：
 * 1. 它得被当成**运行时依赖**打进包（含依赖约 2.7 MB）—— 而我们其余部分
 *    零运行时依赖（`dependencies` 是空的），打进去就为这一个功能破例；
 * 2. 它只认 `latest.yml`。我们的源上放的是自己那份 `version.json`，
 *    走它就得再生成并托管一个 yml、还要上传 `.blockmap`，链路多三节。
 *    而这条链路此前已经连着坏过两次（`downloadUpdate` 的取消令牌把参数吃掉、
 *    以及它压根没被打进包）。
 *
 * <p>自己下则用的是**手上已经有的东西**：清单里的 `url` / `size` / `sha256`。
 * 而且能**校验完整性** —— 这一条 electron-updater 默认并不给我们。
 *
 * <p>代价说清：**没有差分下载**，每次更新下完整的安装包（约 78 MB）。
 * 换来的是零运行时依赖、零额外托管文件，以及一条看得懂、测得到的链路。
 * ========================================================================== */

/** 安装包下载到哪儿。放 userData 下：下完没装就重启时还能复用，不必重下。 */
function updatesDir() {
  const app = requireElectronApp();
  let base = '';
  try {
    base = app && typeof app.getPath === 'function' ? app.getPath('userData') : '';
  } catch { base = ''; }
  return path.join(base || os.tmpdir(), 'updates');
}

/**
 * 流式下载到文件，跟随重定向，边下边报进度。
 *
 * <p>为什么不能用上面那个 {@link httpsGet}：它是给 JSON 用的 —— 把 body
 * 拼成字符串、只认 https、还截断在 512 KB。78 MB 的二进制走那条路
 * 既下不下来也装不进内存。
 *
 * <p>重定向必须跟：Gitee 的 release 下载地址会跳到 CDN。
 * 不跟的话拿到的是一个 302 的响应体，当成安装包去跑必然失败。
 */
function downloadTo(url, dest, opts) {
  const onProgress = (opts && opts.onProgress) || (() => {});
  const totalHint = (opts && opts.total) || 0;
  return new Promise((resolve, reject) => {
    let left = 5;                 // 最多跟 5 跳：够用，又不至于陷进 redirect loop
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };

    const start = (u) => {
      let parsed;
      try { parsed = new URL(u); } catch { return done(reject, new Error('下载地址不合法')); }
      // http 也认：清单是我们自己写的，万一某天挂到 http 上，此处不该无谓地拒
      const mod = parsed.protocol === 'http:' ? require('http') : https;
      const req = mod.get(parsed, { timeout: 30000 }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (left <= 0) return done(reject, new Error('重定向次数过多'));
          left -= 1;
          return start(new URL(res.headers.location, u).href);
        }
        if (code !== 200) {
          res.resume();
          return done(reject, new Error(`下载失败：HTTP ${code}`));
        }
        // total 优先用 content-length，没有就退回清单里的 size。
        // 两者都有时用 content-length —— 它才是这次传输真正要收的字节数。
        const total = Number(res.headers['content-length']) || totalHint || 0;
        let got = 0;
        let lastTick = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          got += chunk.length;
          const now = Date.now();
          if (now - lastTick > 200) {
            lastTick = now;
            onProgress({ got, total, percent: total ? Math.round((got / total) * 100) : 0 });
          }
        });
        res.on('error', (e) => { out.destroy(); done(reject, e); });
        res.pipe(out);
        out.on('error', (e) => done(reject, e));
        out.on('finish', () => {
          onProgress({ got, total, percent: 100 });
          done(resolve, { got, total });
        });
      });
      req.on('error', (e) => done(reject, e));
      req.on('timeout', () => { req.destroy(); done(reject, new Error('连接超时')); });
    };

    start(url);
  });
}

/** 算文件的 sha256。流式 —— 不把 78 MB 读进内存。 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (c) => h.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

/** 从下载地址里取文件名；取不到就用兜底名。 */
function fileNameOf(url, fallback) {
  try {
    const n = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return n || fallback;
  } catch { return fallback; }
}

/**
 * 清掉 updates 目录里除当前这份之外的安装包。
 *
 * <p><b>为什么必须清</b>：一个安装包 78 MB。不清的话每更新一版就多留一个 ——
 * 十版之后用户的 AppData 里躺着 780 MB 他自己不知道的安装包。
 * 这个数字在「本来就装了几百 MB」的机器上不算致命，但它是纯浪费，
 * 而且用户没有任何办法看到或清理它。
 *
 * <p>保留当前这一份的原因：装完之前它还有用（用户可能关掉安装器再点一次
 * 「重启并安装」）。装完之后它会在下一次更新时被这里清掉。
 *
 * <p>只删**本目录下的文件**，不递归、不删子目录 —— 这个目录是我们自己的，
 * 但「删一个自己不完全了解的目录里的东西」这种操作值得把范围收紧到最小。
 */
function pruneOldInstallers(keepPath) {
  let kids = [];
  try {
    kids = fs.readdirSync(updatesDir(), { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const k of kids) {
    if (!k.isFile()) continue;
    const full = path.join(updatesDir(), k.name);
    if (full === keepPath) continue;
    // 只清安装包与半成品：别的（比如用户自己丢进来的东西）不碰
    if (!/\.(exe|part)$/i.test(k.name)) continue;
    try { fs.unlinkSync(full); n += 1; } catch { /* 被占用就留着，下次再说 */ }
  }
  return n;
}

/**
 * 下载安装包。失败一律 throw 并带原因 —— 调用方负责把它显示出来。
 *
 * @param {{info:{url:string,version?:string,size?:number,sha256?:string}}} state
 * @param {{onProgress?:Function}} handlers
 * @returns {Promise<{path:string, reused:boolean}>}
 */
async function download(state, handlers) {
  const info = state && state.info;
  const urls = (info && (info.urls && info.urls.length ? info.urls : (info.url ? [info.url] : []))) || [];
  if (!urls.length) throw new Error('没有可下载的地址');

  const app = requireElectronApp();
  if (app && app.isPackaged === false) {
    // 开发模式没有安装包可装（跑的是源码），下载也毫无意义
    throw new Error('开发模式（未打包）不执行更新下载');
  }

  const dir = updatesDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = fileNameOf(urls[0], `nova-pc-${info.version || 'new'}-setup.exe`);
  const dest = path.join(dir, name);
  const part = dest + '.part';

  /* 已经下过、且哈希对得上就直接用。
   * 这一步不是「优化」—— 它是「下载失败后重试」与「下完没装就重启」
   * 这两条路不重复吃 78 MB 的唯一保障。 */
  if (fs.existsSync(dest)) {
    if (!info.sha256 || (await sha256File(dest)) === String(info.sha256).toLowerCase()) {
      if (handlers && typeof handlers.onProgress === 'function') {
        handlers.onProgress({ percent: 100, speed: 0 });
      }
      pruneOldInstallers(dest);
      return { path: dest, reused: true };
    }
    fs.unlinkSync(dest);   // 哈希不符：是个残包，删掉重下
  }
  if (fs.existsSync(part)) fs.unlinkSync(part);

  /* 逐个源尝试：任一个下完且**校验通过**即收；全失败才抛出（带最后一个错误）。
     换源时重置速度采样，避免把上一个源已下的字节算进新源的速度里。 */
  let lastErr = null;
  let downloaded = false;
  for (const src of urls) {
    let lastBytes = 0;
    let lastAt = Date.now();
    try {
      if (fs.existsSync(part)) fs.unlinkSync(part);
      await downloadTo(src, part, {
        total: info.size || 0,
        onProgress: (p) => {
          if (!handlers || typeof handlers.onProgress !== 'function') return;
          const now = Date.now();
          const dt = (now - lastAt) / 1000;
          // 速度按 ~600ms 一档算：逐块算的话数字跳得根本看不清
          let speed = 0;
          if (dt >= 0.6) {
            speed = Math.max(0, Math.round((p.got - lastBytes) / dt));
            lastBytes = p.got;
            lastAt = now;
          }
          handlers.onProgress({ percent: p.percent, speed, got: p.got, total: p.total });
        }
      });

      /* **校验**。这一步很要紧：下回来的东西是用来**覆盖用户机器上那份程序**的。
       * 下坏了、或者被中间替换了却照装，后果比「更新失败」严重得多。
       * 清单里的 sha256 是我们发布时现算的，正好拿来当判据。
       * 校验不过就当作这个源失败、继续试下一个（换个镜像可能是好的）。 */
      if (info.sha256) {
        const got = await sha256File(part);
        if (got !== String(info.sha256).toLowerCase()) {
          throw new Error('下载的文件校验不通过（sha256 不符）');
        }
      }

      // 校验通过才改名 —— 否则半个文件会以「下好了」的名字留在那儿
      fs.renameSync(part, dest);
      downloaded = true;
      break;
    } catch (e) {
      lastErr = e;
      try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch { /* 清理失败无所谓 */ }
    }
  }

  if (!downloaded) {
    throw new Error('所有下载源都失败了' + (lastErr ? '：' + lastErr.message : ''));
  }
  pruneOldInstallers(dest);
  return { path: dest, reused: false };
}

/**
 * 拉起安装器并退出自己。
 *
 * <p>安装器是 electron-builder 生成的 NSIS **向导**（`oneClick:false` +
 * `allowToChangeInstallationDirectory`），所以它会自己弹界面让用户选装到哪 ——
 * 这正是「拉起安装器」要的效果，而不是静默替换。
 *
 * <p>**为什么必须自己先退出**：NSIS 要覆盖的正是我们此刻正在跑的那个 exe。
 * 我们不让开，安装器要么失败、要么弹一句「请先关闭程序」——
 * 而用户刚在浏览器里点了「安装」，得到的却是一句叫他去关程序的话。
 *
 * <p>做法：以 `detached` 把安装器拉起来（脱离我们的进程树，我们退了它还活着），
 * 再延迟退出自己。延迟 800ms 是留给安装器窗口起来的时间 ——
 * 立刻退会让「点了没反应」和「程序自己关了」同时发生，很吓人。
 *
 * @returns {{ok:boolean, error?:string}} 不抛异常：调用方要把它显示给用户
 */
function installAndRestart(state) {
  const file = state && state.installerPath;
  if (!file) return { ok: false, error: '还没有下载好的安装包' };
  if (!fs.existsSync(file)) return { ok: false, error: '安装包不见了，请重新下载' };
  const app = requireElectronApp();
  if (!app) return { ok: false, error: '当前环境不支持自动安装' };

  try {
    const child = spawn(file, [], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    return { ok: false, error: '无法启动安装器：' + String(e && e.message || e) };
  }

  setTimeout(() => {
    try { app.quit(); } catch { /* 已经要退了 */ }
  }, 800);
  return { ok: true };
}

module.exports = {
  MANIFEST_URL,
  MANIFEST_URLS,
  isNewer,
  fetchManifest,
  check,
  start,
  download,
  installAndRestart,
  downloadTo,
  updatesDir,
  pruneOldInstallers,
  sha256File,
  fileNameOf
};