/**
 * 吾爱Nova浏览器 · 图标构建器
 *
 * 一次产出四套东西：
 *   1. assets/icon/*.png            通用 PNG 尺寸族（16 → 1024）
 *   2. assets/icon/nova.ico         Windows 图标（多尺寸 PNG 内嵌）
 *   3. assets/icon/nova-icon-preview.png  评审用的对照预览图
 *   4. mobile/android/app/src/main/res/…  Android 启动图标（各密度 mipmap + 自适应图标两层）
 *
 * 为什么用 canvas 而不是 capturePage：
 *   capturePage 拿的是**物理像素**，在 125% / 150% 缩放屏上会返回比逻辑尺寸更大的图，
 *   于是 16px 的图标实际是 20px 再缩回去 —— 小尺寸必然糊。
 *   改用「页面里建 canvas 画到精确 S×S」之后，栅格化尺寸完全由我们说了算，
 *   和显示器缩放、窗口大小都无关。SVG 是矢量的，Chromium 会在目标尺寸上重新栅格化。
 *
 * 用法：npm run icons
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

/*
 * 沙箱开关。
 *
 * 本机环境里 `ELECTRON_RUN_AS_NODE=1` 是设着的 —— 它会让 electron.exe
 * 无条件以**纯 Node** 模式启动，于是 `require('electron')` 拿到的是 npm 包
 * 导出的「路径字符串」而不是模块，`app` 是 undefined，脚本直接崩。
 *
 * 之所以要主动清掉：Electron 读的是进程启动时的环境，
 * 而此刻模块已经加载完了 —— 改 process.env 已经太晚，
 * 只能靠调用方在启动前清。npm 脚本做不到这件事（跨平台），
 * 所以清在这里没意义，真正要做的是让调用方别带着那个变量跑。
 * 保留这段注释是为了下一个人不必再花十分钟查同一个现象。
 */
if (app) {
  app.commandLine.appendSwitch('no-sandbox');
}

const ROOT = path.join(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'assets', 'icon');
const ANDROID_RES = path.join(ROOT, 'android-app', 'app', 'src', 'main', 'res');

const read = (name) => fs.readFileSync(path.join(ICON_DIR, name), 'utf8');

/** 主图标：含轨道环与柔光，细节多，只在 ≥48px 用 */
const MASTER = read('nova-icon.svg');
/** 小尺寸变体：删掉轨道环与柔光、星芒加粗。16/24/32px 直接用主图会糊成一团 */
const COMPACT = read('nova-icon-compact.svg');
const FOREGROUND = read('nova-icon-foreground.svg');
const BACKGROUND = read('nova-icon-background.svg');

/** 圆形启动图标（Android <8.0 的 ic_launcher_round）：把圆角方底改成整圆 */
const ROUND = MASTER.replace('rx="15"', 'rx="32"');
const ROUND_COMPACT = COMPACT.replace('rx="15"', 'rx="32"');

const pick = (size) => (size <= 32 ? COMPACT : MASTER);
const pickRound = (size) => (size <= 32 ? ROUND_COMPACT : ROUND);

// ---------------------------------------------------------------- 作业清单

const jobs = [];

// 1) 通用 PNG 尺寸族
const GENERIC_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
for (const size of GENERIC_SIZES) {
  jobs.push({
    kind: 'png',
    svg: pick(size),
    size,
    out: path.join(ICON_DIR, `nova-icon-${size}.png`),
    note: size <= 32 ? '小尺寸变体' : '主图',
  });
}

// 2) Android 各密度启动图标
//    48dp 系列：mdpi 48 / hdpi 72 / xhdpi 96 / xxhdpi 144 / xxxhdpi 192
const MIPMAPS = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];
for (const [density, size] of MIPMAPS) {
  jobs.push({
    kind: 'raw',
    svg: pick(size),
    size,
    out: path.join(ANDROID_RES, `mipmap-${density}`, 'ic_launcher.png'),
    note: `Android ${density}`,
  });
  jobs.push({
    kind: 'raw',
    svg: pickRound(size),
    size,
    out: path.join(ANDROID_RES, `mipmap-${density}`, 'ic_launcher_round.png'),
    note: `Android ${density} 圆形`,
  });
}

// 3) Android 自适应图标的两个图层（108dp 画布，安全区 66dp）
//    背景铺满 108dp；前景已按 1.7 倍放大到 66 安全区内，见 nova-icon-foreground.svg 注释。
const ADAPTIVE = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]];
for (const [density, scale] of ADAPTIVE) {
  const size = Math.round(108 * scale);
  jobs.push({
    kind: 'raw',
    svg: FOREGROUND,
    size,
    out: path.join(ANDROID_RES, `drawable-${density}`, 'ic_launcher_foreground.png'),
    note: `自适应前景 ${density}`,
  });
  jobs.push({
    kind: 'raw',
    svg: BACKGROUND,
    size,
    out: path.join(ANDROID_RES, `drawable-${density}`, 'ic_launcher_background.png'),
    note: `自适应背景 ${density}`,
  });
}
// 无密度限定的兜底副本：anydpi-v26 的 XML 引用了 @drawable/ic_launcher_foreground，
// 若没有任何「默认配置」的候选资源，aapt 会告警。基线按 mdpi 尺寸放一份即可。
jobs.push({
  kind: 'raw', svg: FOREGROUND, size: 108,
  out: path.join(ANDROID_RES, 'drawable', 'ic_launcher_foreground.png'),
  note: '自适应前景 默认基线',
});
jobs.push({
  kind: 'raw', svg: BACKGROUND, size: 108,
  out: path.join(ANDROID_RES, 'drawable', 'ic_launcher_background.png'),
  note: '自适应背景 默认基线',
});

// ------------------------------------------------------------ 页面内栅格化

/**
 * 页面侧助手：把一段 SVG 源码按 size×size 精确栅格化成 PNG 的 base64。
 * 用 encodeURIComponent 而不是 btoa —— 图标 SVG 里带中文（title / aria-label），
 * btoa 碰上多字节字符直接抛 InvalidCharacterError。
 */
const RASTER_HELPER = `
window.__novaRaster = async function (svg, size) {
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const img = new Image();
  img.width = size; img.height = size;
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  // 显式清空：SVG 的四个圆角之外必须是真透明，不能吃到页面底色
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(img, 0, 0, size, size);
  return c.toDataURL('image/png');
};

/**
 * 评审预览图：浅色/深色两条底带 + 各尺寸 + 蒙版预演。
 * 只用 canvas 原生绘制，不引外部字体，避免构建机字体差异。
 *
 * 注意：这个函数整体被丢进渲染进程执行，主进程里的 pick()/pickRound() 在这里**不存在**，
 * 所以六份 SVG 源码必须当参数传进来。（这里踩过一次：页面里直接调 pick() 抛
 * ReferenceError，异步函数吞掉异常后进程既不报错也不退出。）
 */
window.__novaPreview = async function (S) {
  // 尺寸列排在左边，蒙版预演独占右边一栏。两栏之间留出空档，
  // 否则 256px 那张会压到蒙版预演上（第一版就是这么排的，图上一片糊）。
  const W = 1340, H = 680, BAND = 340;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  const pick = (size) => (size <= 32 ? S.compact : S.master);

  // 显式给 SVG 盖上目标尺寸：主图 SVG 自带 width/height="64"，
  // 不换掉的话 drawImage(img, x, y, s, s) 虽然也会缩放，但 intrinsic size 会对不齐。
  const load = async (svg, size) => {
    const sized = svg.replace(/width="[\\d.]+" height="[\\d.]+"/, 'width="' + size + '" height="' + size + '"');
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized);
    await img.decode();
    return img;
  };

  const label = (text, x, y, color) => {
    ctx.fillStyle = color;
    ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(text, x, y);
  };

  ctx.fillStyle = '#F6F7FB'; ctx.fillRect(0, 0, W, BAND);
  ctx.fillStyle = '#14161C'; ctx.fillRect(0, BAND, W, BAND);
  // 两带之间的分隔线
  ctx.fillStyle = '#3D6BFF';
  ctx.fillRect(0, BAND - 1, W, 2);

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const BASELINE = 292;   // 底对齐基准；256 那张从 y=36 起，上方留白才够
  let x = 44;
  for (const s of sizes) {
    for (const top of [0, BAND]) {
      // 尺寸列一律用「圆角方」那张 —— 它就是各平台默认拿到的启动图标长相。
      // 整圆变体只在 Android 8.0 以下当 ic_launcher_round 用，放到右栏单独交代。
      ctx.drawImage(await load(pick(s), s), x, top + BASELINE - s, s, s);
    }
    label(s + 'px', x, BAND - 20, '#6B7183');
    label(s + 'px', x, H - 20, '#9AA0B0');
    x += s + 42;
  }
  label('各档实机像素尺寸', 44, 24, '#6B7183');

  // 右侧规格栏：两列。第一行是自适应图标被系统蒙版裁切后的样子，
  // 第二行是 Android 8.0 以下的整圆启动图标，以及自适应图标的前景/背景合成。
  const COL = [1030, 1200];
  const drawMasked = async (kind, mx, my, R) => {
    ctx.save();
    ctx.beginPath();
    if (kind === 'circle') {
      ctx.arc(mx, my, R, 0, Math.PI * 2);
    } else {
      const rr = R * 0.46;
      ctx.moveTo(mx - R + rr, my - R);
      ctx.arcTo(mx + R, my - R, mx + R, my + R, rr);
      ctx.arcTo(mx + R, my + R, mx - R, my + R, rr);
      ctx.arcTo(mx - R, my + R, mx - R, my - R, rr);
      ctx.arcTo(mx - R, my - R, mx + R, my - R, rr);
      ctx.closePath();
    }
    ctx.clip();
    ctx.drawImage(await load(S.bg, 108), mx - R, my - R, R * 2, R * 2);
    ctx.drawImage(await load(S.fg, 108), mx - R, my - R, R * 2, R * 2);
    ctx.restore();
  };

  for (const top of [0, BAND]) {
    const dim = top === 0 ? '#6B7183' : '#9AA0B0';
    label('自适应图标 · 蒙版裁切', COL[0] - 62, top + 24, dim);
    await drawMasked('circle', COL[0], top + 108, 50);
    await drawMasked('squircle', COL[1], top + 108, 50);
    label('圆形蒙版', COL[0] - 27, top + 178, dim);
    label('圆角方蒙版', COL[1] - 32, top + 178, dim);

    // 整圆启动图标（Android 8.0 以下走 ic_launcher_round 这套 mipmap）
    const round96 = await load(S.round, 96);
    ctx.drawImage(round96, COL[0] - 48, top + 206, 96, 96);
    label('整圆启动图标 96', COL[0] - 48, top + 320, dim);

    // 自适应图标的两层：背景铺满、前景留安全区，叠起来才是系统看到的样子
    const bg108 = await load(S.bg, 108);
    ctx.drawImage(bg108, COL[1] - 54, top + 197, 108, 108);
    const fg108 = await load(S.fg, 108);
    ctx.drawImage(fg108, COL[1] - 54, top + 197, 108, 108);
    ctx.strokeStyle = top === 0 ? '#D5D9E4' : '#343A48';
    ctx.lineWidth = 1;
    ctx.strokeRect(COL[1] - 54.5, top + 196.5, 109, 109);
    label('自适应两层合成 108', COL[1] - 54, top + 320, dim);
  }

  return c.toDataURL('image/png');
};

// executeJavaScript 会把整段脚本的**完成值**回传主进程，而赋值表达式的完成值是个函数 ——
// 函数过不了结构化克隆，报「An object could not be cloned」。补一句原始值收尾。
true;
`;

// ---------------------------------------------------------------- ICO 打包

/**
 * 打 Windows .ico。所有档位都内嵌 PNG（Vista 起支持）。
 * 传统做法是 ≤48px 用 BMP DIB，但 Win10/11 的图标缓存与资源管理器都认 PNG，
 * 而 BMP 那条路要处理 BITMAPINFOHEADER + 1bpp AND 掩码 + 行序翻转，收益为零。
 */
function packIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);

  let offset = 6 + 16 * count;
  const dir = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    const dim = e.size >= 256 ? 0 : e.size; // 256 用 0 表示
    d.writeUInt8(dim, 0); // width
    d.writeUInt8(dim, 1); // height
    d.writeUInt8(0, 2);   // 调色板数
    d.writeUInt8(0, 3);   // reserved
    d.writeUInt16LE(1, 4);  // color planes
    d.writeUInt16LE(32, 6); // bits per pixel
    d.writeUInt32LE(e.buf.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.buf.length;
    dir.push(d);
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.buf)]);
}

/**
 * 检查待写入的 XML 有没有连续两个连字符（在注释里）。
 *
 * <p>为什么值得单独做一道：XML 注释里出现连续两个连字符是**硬性非法**的，
 * 但两个工具链给出来的诊断都很难用 ——
 * Chromium 只说「图片无法解码」，不指文件也不指行号；
 * aapt2 说「注释中不允许出现字符串 --」，同样不说是哪一行。
 *
 * <p>更麻烦的是它<b>只在下游才暴露</b>：图标本身已经生成好了、看着完全正常，
 * 要等 aapt2 读那些 XML 时才炸。所以宁可在写盘前挡一道。
 *
 * @param {string} xml  待写入的内容
 * @param {string} label 出错时指给用户看的文件名
 */
function assertNoDoubleDash(xml, label) {
  const bad = [];
  xml.split('\n').forEach((line, i) => {
    // 只查注释内部。属性值或内容里出现两个连字符是完全合法的
    //（比如一个 URL），所以不能整行扫。
    const open = line.indexOf('<!--');
    if (open < 0) return;
    const close = line.indexOf('-->', open);
    const inner = close < 0 ? line.slice(open + 4) : line.slice(open + 4, close);
    if (inner.includes('--')) bad.push([i + 1, line.trim()]);
  });
  if (!bad.length) return;
  const lines = bad.map(([n, t]) => `  第 ${n} 行：${t}`).join('\n');
  throw new Error(
    `${label} 的注释里出现了连续两个连字符，这会让 XML 变成非法文件。\n${lines}\n`
    + '改法：注释里不要写 CSS 自定义属性的写法（两个前导连字符），\n'
    + '只写变量名本身，比如「品牌色令牌」而不是「双连字符 brand」。'
  );
}

// ------------------------------------------------------------------ 主流程

const results = { pngs: [], warnings: [] };

/**
 * 校验一张刚生成的 PNG。
 *
 * 断言分两套，因为两类图层的「正确」本来就不一样：
 *   - 图标层（含星芒）：圆角之外必须真透明，中心必须是星芒近白
 *   - 背景层：必须满幅不透明，且中心与右下角色不同（证明渐变真的画出来了，
 *     而不是退化成一块平色），同时中心要落在品牌蓝的色相里
 */
function checkPng(buf, expectSize, label, isBackdrop) {
  const img = nativeImage.createFromBuffer(buf);
  const { width, height } = img.getSize();
  if (width !== expectSize || height !== expectSize) {
    results.warnings.push(`${label}: 尺寸 ${width}×${height}，期望 ${expectSize}×${expectSize}`);
    return false;
  }
  // toBitmap 是 BGRA（Windows），alpha 恒在第 4 字节
  const bmp = img.toBitmap();
  const alphaAt = (x, y) => bmp[(y * width + x) * 4 + 3];
  // 注意顺序：缓冲区是 B G R A，取出来的数组要按 R G B 摆正再比较
  const rgbAt = (x, y) => [
    bmp[(y * width + x) * 4 + 2],
    bmp[(y * width + x) * 4 + 1],
    bmp[(y * width + x) * 4],
  ];

  const corner = alphaAt(0, 0);
  const mid = rgbAt(width >> 1, height >> 1);
  const far = rgbAt(width - 1, height - 1);

  if (isBackdrop) {
    if (corner < 250) results.warnings.push(`${label}: 背景层应满幅不透明，实测左上角 alpha=${corner}`);
    const spread = Math.max(Math.abs(mid[0] - far[0]), Math.abs(mid[1] - far[1]), Math.abs(mid[2] - far[2]));
    if (spread < 16) results.warnings.push(`${label}: 中心与右下角颜色几乎一致（差 ${spread}），渐变可能没生效`);
    if (!(mid[2] > mid[0] && mid[2] > mid[1])) {
      results.warnings.push(`${label}: 中心应落在品牌蓝的色相里，实测 rgb=${mid.join(',')}`);
    }
  } else {
    // 圆角之外必须是真透明，否则装到桌面上会露出四个白角
    if (corner > 8) results.warnings.push(`${label}: 左上角应透明，实测 alpha=${corner}`);
    if (mid[0] < 200 || mid[1] < 200 || mid[2] < 200) {
      results.warnings.push(`${label}: 中心应是星芒近白，实测 rgb=${mid.join(',')}`);
    }
  }
  return true;
}

if (app) {
  app.whenReady().then(async () => {
    try {
      await build();
    } catch (err) {
      // 不接这一手的话，async 回调里抛出的异常会变成 unhandled rejection：
      // 进程既不打印也不退出，就这么挂着等外部超时 —— 排查起来非常费劲。
      console.error('\n图标构建失败：' + (err && err.stack ? err.stack : err));
      app.exit(2);
    }
  });
} else {
  // 不是 Electron 环境。给一句能直接照做的提示，而不是
  // 「Cannot read properties of undefined」让人自己猜。
  console.error(
    '这个脚本必须在 Electron 下运行（它用 Chromium 的 canvas 栅格化 SVG）。\n'
    + '如果刚才是用 npx electron 跑的，先清掉 ELECTRON_RUN_AS_NODE：\n'
    + '\n'
    + '  unset ELECTRON_RUN_AS_NODE\n'
    + '  ./node_modules/electron/dist/electron.exe tools/build-icons.js\n'
  );
  process.exit(2);
}

/**
 * 包一层「把异常转成普通对象」的调用。
 *
 * 直接调 executeJavaScript 会踩两个连环坑：
 *   1) 页面里抛错时，Electron 尝试把 Error 对象回传，而它过不了结构化克隆，
 *      主进程收到的只有一句 “An object could not be cloned” —— 真正的错误信息全丢了；
 *   2) 于是 async 流程既不报错也不退出，进程就这么挂到外部超时。
 * 所以这里统一用 try/catch 包住，把结果压成 { ok, data } / { ok:false, err } 两个纯字符串字段。
 */
async function callPage(win, expr) {
  const r = await win.webContents.executeJavaScript(
    '(async () => { try { return { ok: true, data: await (' + expr + ') }; }' +
    ' catch (e) { return { ok: false, err: String((e && e.message) || e), name: String((e && e.name) || "") }; } })()'
  );
  return r;
}

/**
 * 预检：四份源 SVG 能不能被 Chromium 解析。
 *
 * 这一步是被一次真实事故逼出来的：主图注释里写了 CSS 变量名，里面的连续连字符
 * 让 XML 变成非法文档（XML 注释内禁止出现「减号减号」），而 Chromium 对非法 SVG
 * 只会回一句 “The source image cannot be decoded”，既不指文件也不指行号。
 * 预检把这件事提前到「一个文件一次」地报清楚，并直接把根因写在提示里。
 */
async function preflight(win) {
  const sources = [
    ['nova-icon.svg', MASTER],
    ['nova-icon-compact.svg', COMPACT],
    ['nova-icon-foreground.svg', FOREGROUND],
    ['nova-icon-background.svg', BACKGROUND],
  ];
  const bad = [];
  for (const [name, svg] of sources) {
    const r = await callPage(win, `window.__novaRaster(${JSON.stringify(svg)}, 64)`);
    if (!r.ok) bad.push({ name, err: r.err });
  }
  if (bad.length) {
    console.error('\n源 SVG 预检未通过：\n');
    for (const b of bad) {
      console.error('  × ' + b.name + '  →  ' + b.err);
      // XML 注释里出现连续连字符是最常见的一类，直接把线索给出来
      const lines = sources.find((s) => s[0] === b.name)[1].split('\n');
      lines.forEach((line, i) => {
        if (/<!--/.test(line) && /--/.test(line.replace(/<!--|-->/g, ''))) {
          console.error('      ' + (i + 1) + ' 行：注释正文里出现了连续两个连字符');
          console.error('      ' + line.trim());
        }
      });
    }
    console.error('\n提示：XML 注释体内不允许出现连续两个 ASCII 连字符（「-」「-」）。');
    console.error('      写 CSS 变量名时请去掉前缀连字符，或改用中文括号。\n');
    return false;
  }
  console.log('  源 SVG 预检：4 份全部可解析');
  return true;
}

async function build() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      // 隐藏窗口默认会给定时器/解码降频。img.decode() 走的是解码器，
      // 但没必要赌 —— 这个坑在本项目的截图脚本里已经踩过一次了。
      backgroundThrottling: false,
      contextIsolation: false,
      nodeIntegration: false,
    },
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><body>'));
  // callPage 会把传入的表达式整个塞进 `await (...)`，所以多语句的助手脚本必须先包成 IIFE，
  // 否则括号里出现分号就是语法错误 —— 报出来还是那句没头没尾的 “Script failed to execute”。
  const helper = await callPage(win, '(function () {\n' + RASTER_HELPER + '\nreturn "helper-installed"; })()');
  if (!helper.ok) throw new Error('页面侧助手注入失败：' + helper.err);

  console.log('吾爱Nova浏览器 · 图标构建\n');
  if (!(await preflight(win))) {
    app.exit(3);
    return;
  }

  // 1) 逐档栅格化
  console.log('  栅格化 ' + jobs.length + ' 档…');
  const pngEntries = [];
  for (const job of jobs) {
    const r = await callPage(win, `window.__novaRaster(${JSON.stringify(job.svg)}, ${job.size})`);
    if (!r.ok) throw new Error('栅格化失败 ' + path.relative(ROOT, job.out) + '：' + r.err);
    const buf = Buffer.from(r.data.split(',')[1], 'base64');
    fs.mkdirSync(path.dirname(job.out), { recursive: true });
    fs.writeFileSync(job.out, buf);
    // Android 那批路径太长，会把表格列挤爆；相对 res/ 显示就够了
    const rel = job.out.startsWith(ANDROID_RES)
      ? 'android/res/' + path.relative(ANDROID_RES, job.out).replace(/\\/g, '/')
      : path.relative(ROOT, job.out).replace(/\\/g, '/');
    const ok = checkPng(buf, job.size, rel, job.svg === BACKGROUND);
    pngEntries.push({ ...job, buf, rel });
    results.pngs.push({ rel, size: job.size, bytes: buf.length, note: job.note, ok });
  }

  // 2) Windows .ico —— 只取适合图标缓存的档位
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoEntries = icoSizes.map((s) => {
    const hit = pngEntries.find((e) => e.kind === 'png' && e.size === s);
    return { size: s, buf: hit.buf };
  });
  const icoBuf = packIco(icoEntries);
  fs.writeFileSync(path.join(ICON_DIR, 'nova.ico'), icoBuf);
  results.pngs.push({ rel: 'assets/icon/nova.ico', size: icoSizes.length + ' 档', bytes: icoBuf.length, note: icoSizes.join('/'), ok: true });

  // 3) Android 自适应图标 XML
  const anydpi = path.join(ANDROID_RES, 'mipmap-anydpi-v26');
  fs.mkdirSync(anydpi, { recursive: true });
  const adaptiveXml = () =>
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<!-- 吾爱Nova浏览器 · 自适应图标（Android 8.0+）\n' +
    '     前景/背景两层由 assets/icon/nova-icon-{foreground,background}.svg 生成。\n' +
    '     要改图标请改 SVG 再跑 npm run icons，不要手改这里的 PNG。 -->\n' +
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <background android:drawable="@drawable/ic_launcher_background" />\n' +
    '    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n' +
    '</adaptive-icon>\n';
  const axml = adaptiveXml();
  assertNoDoubleDash(axml, 'mipmap-anydpi-v26/ic_launcher.xml');
  fs.writeFileSync(path.join(anydpi, 'ic_launcher.xml'), axml);
  fs.writeFileSync(path.join(anydpi, 'ic_launcher_round.xml'), axml);
  results.pngs.push({ rel: 'mobile/…/mipmap-anydpi-v26/ic_launcher{xml,_round.xml}', size: 'XML', bytes: 0, note: '自适应图标（两层引用）', ok: true });

  // 生成的 XML 同样不能有连续两个连字符（那是 XML 注释的硬性规定，
  // aapt2 会直接报「注释中不允许出现字符串 --」并中断构建）。
  // 上一版的 preflight 只覆盖 SVG，没管到这里，于是图标重建一次就把
  // Android 工程顶崩一次 —— 而当时图标看起来完全正常。
  // 所以这里也过一遍预检。
  const colorsXml =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<resources>\n' +
    '    <!-- 品牌主色，与 src/renderer/shell.css 的品牌色令牌同源。\n' +
    '         改这里要同步改 assets/icon/nova-icon-background.svg 的渐变首停靠点。 -->\n' +
    '    <color name="ic_launcher_brand">#3D6BFF</color>\n' +
    '</resources>\n';
  assertNoDoubleDash(colorsXml, 'values/ic_launcher_colors.xml');
  fs.writeFileSync(path.join(ANDROID_RES, 'values', 'ic_launcher_colors.xml'), colorsXml);

  // 4) 评审预览图
  const pv = await callPage(win, 'window.__novaPreview(' + JSON.stringify({
    master: MASTER, compact: COMPACT,
    round: ROUND, roundCompact: ROUND_COMPACT,
    fg: FOREGROUND, bg: BACKGROUND,
  }) + ')');
  if (!pv.ok) throw new Error('预览图绘制失败：' + pv.err);
  const previewBuf = Buffer.from(pv.data.split(',')[1], 'base64');
  fs.writeFileSync(path.join(ICON_DIR, 'nova-icon-preview.png'), previewBuf);
  results.pngs.push({ rel: 'assets/icon/nova-icon-preview.png', size: '1340×680', bytes: previewBuf.length, note: '评审预览（含蒙版预演）', ok: true });

  // ------------------------------------------------------------------ 汇报
  console.log('\n  文件'.padEnd(58) + '尺寸'.padEnd(12) + '大小'.padEnd(11) + '说明');
  console.log('  ' + '-'.repeat(100));
  for (const p of results.pngs) {
    console.log(
      '  ' + p.rel.padEnd(56) +
      String(p.size).padEnd(12) +
      (p.bytes ? (p.bytes / 1024).toFixed(1) + ' KB' : '—').padEnd(11) +
      p.note
    );
  }

  if (results.warnings.length) {
    console.log('\n  警告 ' + results.warnings.length + ' 条：');
    for (const w of results.warnings) console.log('    ! ' + w);
    console.log('\n  结果：未通过');
  } else {
    console.log('\n  共 ' + results.pngs.length + ' 个文件。');
    console.log('  断言：尺寸精确 / 圆角之外真透明 / 中心是星芒 / 背景层满幅 —— 全部通过');
  }

  app.exit(results.warnings.length ? 1 : 0);
}

app.on('window-all-closed', () => {});
