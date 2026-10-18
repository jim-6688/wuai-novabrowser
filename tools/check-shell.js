'use strict';
/**
 * 外壳一致性自检（无浏览器依赖）
 * 用法：node tools/check-shell.js
 * 校验：语法 / DOM id 引用 / 类选择器 / CSS 变量 / 内核选择器链路完整性
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const P = (p) => path.join(root, p);

let failed = 0;
const ok = (m) => console.log('  \u2713 ' + m);
const bad = (m) => { failed++; console.log('  \u2717 ' + m); };

/* 1. 语法（在进程内编译，不 spawn 子进程） */
console.log('\n[1] JS 语法');
const jsFiles = [
  'src/main/settings.js', 'src/main/engines.js', 'src/main/adblock.js',
  'src/main/adblock-lists.js', 'src/main/extensions.js', 'src/main/main.js',
  'src/main/downloader.js', 'src/main/sniffer.js', 'src/main/sniffer-wire.js',
  'src/main/nomedia.js', 'src/main/request-gate.js', 'src/main/favicon-cache.js',
  'src/main/desktop-shortcut.js', 'src/main/ext-store.js',
  'src/preload/preload.js', 'src/renderer/bridge-mock.js',
  'src/renderer/autopage.js', 'src/renderer/shell.js', 'tools/preview.js'
];
for (const f of jsFiles) {
  try {
    new vm.Script(fs.readFileSync(P(f), 'utf8'), { filename: f });
    ok(f);
  } catch (e) {
    bad(f + ' -> ' + String(e.message).split('\n')[0]);
  }
}

/* 2. DOM id 引用 */
console.log('\n[2] DOM id 引用');
const html = fs.readFileSync(P('src/renderer/shell.html'), 'utf8');
const js = fs.readFileSync(P('src/renderer/shell.js'), 'utf8');
const css = fs.readFileSync(P('src/renderer/shell.css'), 'utf8');

/* 取「挂在 document 上、处理设置项按钮的那个 click 委托」这一段。
 *
 * 原先几条断言用的是 `document.addEventListener('click',[\s\S]{0,N}?closest(…)`
 * 这种固定窗口 —— 而那个 N 每加一个分支就要重调一次（已经调过三次：
 * 加 data-upcfg、加 data-ext-toggle，每次都把那两条老断言弄红）。
 *
 * 现在**以 `closest('[data-up]')` 为锚**向两边扩：往左找最近的
 * `document.addEventListener('click'`，往右找下一个 document 监听器。
 * 这样同一段里以后再加多少分支都自动被覆盖，不用再动任何数字。
 *
 * （注意不能简单取「第一个 document 上的 click」——文件里第一个是
 * `closeEngineMenu`，很短，取到它这一段就全空了。这个坑踩过。）
 */
const docClickSeg = (() => {
  const marker = js.indexOf("closest('[data-up]')");
  if (marker < 0) return '';
  const i = js.lastIndexOf("document.addEventListener('click'", marker);
  if (i < 0) return '';
  const j = js.indexOf('document.addEventListener(', marker);
  return js.slice(i, j > i ? j : js.length);
})();

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const usedIds = new Set([...js.matchAll(/\$\$?\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
/**
 * 这些 id 不在 shell.html 里 —— 它们由设置页正文的 buildXxx() 在运行时渲染出来，
 * 所以「HTML 里查不到」是正常的，不能算缺陷。
 *
 * 加新条目时的规矩：**只加真正由 JS 运行时生成的**，并在这里说明是谁生成的。
 * 加一个静态就在 HTML 里的 id 进来，等于把一条真缺陷的检测关掉了。
 */
const dynamicIds = new Set([
  'dl-url',            // buildDownloads()
  'ext-browsers',      // buildExtensions() 里「从已安装的浏览器导入扩展」那一块，同上
  'bm-browsers'        // buildBookmarks() 的「从已安装的浏览器导入」那一块；
                       // 内容还是异步的（detectBrowsers() 回填），所以连它内部的
                       // 那几行也是 JS 生成的
]);
console.log(`  HTML id ${htmlIds.size} 个 / JS 引用 ${usedIds.size} 个`);
const missingIds = [...usedIds].filter((id) => !htmlIds.has(id) && !dynamicIds.has(id));
missingIds.length ? bad('JS 引用但 HTML 不存在: ' + missingIds.join(', '))
                  : ok(`JS 引用的 id 全部存在于 HTML（另有 ${dynamicIds.size} 个由 JS 运行时生成：${[...dynamicIds].join(', ')}）`);
const orphanIds = [...htmlIds].filter((id) => !js.includes(id));
console.log('  HTML 中未被 JS 直接引用的 id: ' + (orphanIds.join(', ') || '无'));

/* 3. 类选择器 */
console.log('\n[3] 类选择器');
const cssCls = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]));
const usedCls = new Set([...js.matchAll(/\$\$?\('\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
const dynamic = new Set(['tab', 'hist-row', 'preview-pane']);
const missingCls = [...usedCls].filter((c) => !cssCls.has(c) && !dynamic.has(c));
missingCls.length ? bad('JS 用但 CSS 无定义: ' + missingCls.join(', '))
                  : ok('JS 选择器类都在 CSS 中有定义');

const htmlCls = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
const noCss = [...htmlCls].filter((c) => c && !cssCls.has(c));
noCss.length ? bad('HTML 用但 CSS 无定义: ' + noCss.join(', '))
             : ok('HTML 用到的类都有样式');

/* 4. CSS 变量 */
console.log('\n[4] CSS 变量');
const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const usedVar = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
// 这两个由 JS 在运行时按标签页注入（style.setProperty），不在样式表里声明
const runtimeVars = new Set(['--tab-accent', '--engine-color']);
const undef = [...usedVar].filter((v) => !defined.has(v) && !runtimeVars.has(v));
undef.length ? bad('使用了未定义的变量: ' + undef.join(', '))
             : ok(`定义 ${defined.size} 个 / 使用 ${usedVar.size} 个，无缺失（--tab-accent、--engine-color 由 JS 运行时注入）`);

/* 5. 内核选择器链路 */
console.log('\n[5] 内核选择器（地址栏右端）链路');
const all = html + js + css;
const gone = !all.includes('engine-switch');
gone ? ok('旧工具栏切换器 .engine-switch 已彻底移除') : bad('.engine-switch 仍有残留');
const chain = [
  ['HTML 触发器', /id="omni-engine"/.test(html)],
  ['HTML 下拉面板', /id="engine-menu"/.test(html) && /id="engine-menu-list"/.test(html)],
  ['HTML 面板挂在 omnibox 内', /<div class="omnibox"[\s\S]*?engine-menu[\s\S]*?<\/div>\s*\n\s*<\/div>/.test(html)],
  ['样式 position:relative 锚点', /\.omnibox \{[\s\S]*?position: relative;/.test(css)],
  ['样式 .engine-menu', /\.engine-menu \{/.test(css)],
  ['样式 .ow-engine 右端选择器', /\.ow-engine \{/.test(css)],
  ['样式 兼容层态 .is-compat', /\.ow-engine\.is-compat \{/.test(css)],
  ['样式 下拉项 .em-item', /\.em-item\.is-active \{/.test(css)],
  ['JS 渲染下拉项', js.includes('engineMenuItem(') && js.includes("$('#engine-menu-list')")],
  ['JS 打开/关闭/切换', js.includes('function openEngineMenu') && js.includes('function closeEngineMenu') && js.includes('function toggleEngineMenu')],
  ['JS 点击触发', /\$\('#omni-engine'\)\.addEventListener\('click'/.test(js)],
  ['JS 点击外部关闭', /document\.addEventListener\('click', closeEngineMenu\)/.test(js)],
  ['JS Escape 关闭', /Escape'\) \{ closeEngineMenu\(\)/.test(js)],
  ['JS 同步选中态', js.includes("$$('#engine-menu-list .em-item')")],
  ['移动端走底部分层', /state\.layout === 'mobile'/.test(js)],
  ['移动端弹层仍保留', /id="engine-sheet"/.test(html) && /id="engine-cards"/.test(html)]
];
for (const [name, pass] of chain) pass ? ok(name) : bad(name);

/* 6. 设计板同步 */
console.log('\n[6] 设计板与实现同步');
const board = fs.readFileSync(P('design/design-board.html'), 'utf8');
!board.includes('engswitch') ? ok('设计板已无旧分段控件 .engswitch') : bad('设计板仍画出旧分段控件');
['.engmenu', 'class="engmenu"', '地址栏右端'].forEach((k) => {
  board.includes(k) ? ok('设计板包含 ' + k) : bad('设计板缺少 ' + k);
});

/* 7. 设置是窗口，不是整屏 */
console.log('\n[7] 设置窗口（不再整屏接管）');
// 剥掉注释再比对：注释里写到 .sv-card / .sv-window 只是解释「别把它们写混」，
// 不剥掉的话，说明文字本身就会把「选择器不能混用」这一条误判成失败。
const cssRules = fs.readFileSync(P('src/renderer/shell.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
[
  ['外壳有窗口元素 .sv-window', /class="sv-window"/.test(html)],
  ['窗口外壳与分区内的分组卡 .sv-card 没有写进同一条选择器',
    !/\.sv-window[^{}]*\.sv-card/.test(cssRules) && !/\.sv-card[^{}]*\.sv-window/.test(cssRules)],
  ['外壳定位层做的是居中 + 压暗，不是铺满',
    /\.settings-view:not\(\[hidden\]\)\s*\{[^}]*align-items:\s*center/.test(cssRules)
      && /\.settings-view:not\(\[hidden\]\)\s*\{[^}]*rgba\(10,\s*13,\s*22/.test(cssRules)],
  ['窄屏档位覆盖回整屏',
    /\[data-layout="mobile"\] \.settings-view:not\(\[hidden\]\)\s*\{[^}]*padding:\s*0/.test(cssRules)],
  ['点暗底关窗的按下/松开两步判定在', /svPressedBackdrop/.test(js)],
  ['设计板的设置类帧也画成窗口',
    (board.match(/frame pc setwin/g) || []).length >= 5],
  ['设计板画出了窗口本体 .svwin', /class="svwin"/.test(board)]
].forEach(([name, pass]) => pass ? ok(name) : bad(name));

/* 8. 站点图标：一条从抓取到画出来的完整链子 */
console.log('\n[8] 站点图标链路');
// 这条链子横跨四个文件，任何一环断了的表现都一样 —— 「图标就是不出来」。
// 而链子本身没有任何报错：抓不到图只是回落到首字母，看起来像「本来就长这样」。
const mainJs = fs.readFileSync(P('src/main/main.js'), 'utf8');
const preload = fs.readFileSync(P('src/preload/preload.js'), 'utf8');
const mockJs = fs.readFileSync(P('src/renderer/bridge-mock.js'), 'utf8');
const mainMod = fs.readFileSync(P('src/main/main.js'), 'utf8');
const updaterMod = fs.readFileSync(P('src/main/updater.js'), 'utf8');
const bmIo = fs.readFileSync(P('src/main/bookmarks-io.js'), 'utf8');
const bdMod = fs.readFileSync(P('src/main/browsers-detect.js'), 'utf8');
const extMod = fs.readFileSync(P('src/main/extensions.js'), 'utf8');
const preloadMod = fs.readFileSync(P('src/preload/preload.js'), 'utf8');
const storeMod = fs.readFileSync(P('src/main/ext-store.js'), 'utf8');
const bxMod = fs.readFileSync(P('src/main/browser-extensions.js'), 'utf8');
const stMod = fs.readFileSync(P('src/main/settings.js'), 'utf8');
const newtab = fs.readFileSync(P('src/renderer/newtab.html'), 'utf8');
const toJava = (rel) => P('android-app/app/src/main/' + rel);
[
  ['主进程引了 FaviconCache（与安卓端同一套语义的另一份实现）',
    /require\('\.\/favicon-cache'\)/.test(mainJs)],
  ['缓存目录落在 userData 下（不写进安装目录，那里可能只读）',
    /new FaviconCache\(/.test(mainJs) && /app\.getPath\('userData'\)/.test(mainJs)],
  ['导航时顺手记住「站点自己声明的图标」——盲探三处常规位置拿不到的那种',
    /page-favicon-updated'[\s\S]{0,900}?faviconCache\.remember\(/.test(mainJs)],
  ['新标签页加载完就把图标表注入进去（页面那条 CSP 锁死了网络，只能这样喂）',
    /function injectFavicons/.test(mainJs) && /window\.__novaIcons\s*=/.test(mainJs)
      && /__novaApplyIcons/.test(mainJs)],
  ['抓到新图标会回灌给还开着的新标签页（先抓到先换，不等整轮跑完）',
    /faviconCache\.onFetched\s*=\s*\(\)\s*=>\s*\{?[\s\S]{0,300}?reinjectFavicons\(\)/.test(mainJs)],
  ['启动时按「用户认得的站点」暖一轮（书签 + 自己加的磁贴 + 近期历史）',
    /function warmFavicons/.test(mainJs) && /warmFavicons\(\)/.test(mainJs)
      && /s\.bookmarks/.test(mainJs) && /ntpShortcuts/.test(mainJs)],
  ['有 favicon:json 这个 IPC 给外壳用', /handle\('favicon:json'/.test(mainJs)],
  ['favicon:json 顺手 kick 一次抓取 —— 只读不抓的话，用户当场加的书签'
    + '在本次运行里永远等不到图标（启动暖缓存只覆盖当时已在设置里的站点）',
    /handle\('favicon:json'[\s\S]{0,400}?refreshIfStale\(/.test(mainJs)],
  ['抓到图标会推 favicon:updated 给外壳（否则书签格停在首字母，直到下次动书签）',
    /send\('favicon:updated'/.test(mainJs) && /on\('favicon:updated'/.test(js)],
  ['外壳收到推送后走的是强制重读（主机名没变，但表的内容变了）',
    /on\('favicon:updated',\s*\(\)\s*=>\s*refreshHostIcons\(true\)\)/.test(js)],
  ['preload 把 favicons.json 挂到桥上', /favicons:\s*\{/.test(preload)
    && /favicon:json/.test(preload)],
  ['外壳有查表与取表两个函数', /function hostIcon\(/.test(js) && /async function refreshHostIcons\(/.test(js)],
  ['书签每一次增删清都会走到取表那一步（挂在 refreshCurrent 上，一处顶八处）',
    /function refreshCurrent\(\)[\s\S]{0,600}?refreshHostIcons\(\)/.test(js)],
  ['书签格与设置页列表走同一套三层兜底（缓存 → 书签自带 favicon → 首字母）',
    (js.match(/hostIcon\(b\.url\)/g) || []).length >= 2],
  ['设置页列表行的图标样式在', /\.list-row \.lr-fav\s*\{/.test(cssRules)],
  ['预览桥给了一张空表而不是编造的图标 —— 预览里一个请求都不发，编一张等于让截图说谎',
    /favicons:\s*\{[\s\S]{0,200}?json:\s*async\s*\(\)\s*=>\s*\(\{\}\)/.test(mockJs)],
  ['新标签页的说明已不再写着「桌面端目前不喂这张表」（那句话已经过期）',
    !/桌面端目前不喂这张表/.test(newtab) && /favicon-cache\.js/.test(newtab)],
  ['新标签页与安卓端产物仍然逐字节一致（npm run mobile:check 会再验一遍）',
    fs.readFileSync(P('src/renderer/newtab.html')).equals(
      fs.readFileSync(toJava('assets/newtab.html')))]
].forEach(([name, pass]) => pass ? ok(name) : bad(name));

/* 8.1 事件白名单：外壳监听的每个通道，preload 都得放行 */
// 这一条值得单列，因为它的失败方式最阴：preload 的 on() 对不在白名单里的通道
// 直接 throw，而外壳是在 init 里注册监听的 —— 一抛，init 后半段（建标签页、
// 挂各处分区）整段不跑。界面看起来只是「少了个功能」，控制台里也只是一句
// 「未授权的事件通道」，很容易被当成无关日志划过去。
// 而 jsdom 测试用的是 mock 桥，mock 没有白名单 —— 所以单测全绿也拦不住。
const allowedBlock = ((preload.match(/const EVENT_CHANNELS = \[([\s\S]*?)\];/) || [])[1] || '')
  // 先剥注释：这段数组的说明里就写着 bridge.on('…') 当例子，
  // 不剥的话那个例子会被当成一个真的通道名，白算出一条「多出来的通道」。
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const allowedEvents = new Set([...allowedBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]));
const listenedEvents = [...new Set([...js.matchAll(/bridge\.on\('([^']+)'/g)].map((m) => m[1]))];
const missingEvents = listenedEvents.filter((c) => !allowedEvents.has(c));
missingEvents.length
  ? bad('外壳监听了 preload 未放行的通道：' + missingEvents.join(', ')
      + '（on() 会直接抛，init 后半段整段不跑）')
  : ok(`外壳监听的 ${listenedEvents.length} 个事件通道都在 preload 白名单里`);
// 反向也看一眼：白名单里挂着但没人监听的，多半是推送改了名而监听没跟上
const staleEvents = [...allowedEvents].filter((c) => !listenedEvents.includes(c));
staleEvents.length
  ? ok(`白名单里有 ${staleEvents.length} 个通道外壳当前没监听（可能由别处消费）：${staleEvents.join(', ')}`)
  : ok('白名单没有多出来的通道');

/* 9. 桌面快捷方式：绿色版首启补建 */
// 这条链子断掉时的表现是「桌面上什么也没发生」—— 没有报错、没有界面变化。
// 而它又只在**打包后**才跑，平时开发根本碰不到，所以最容易在某个 `if` 上写反。
console.log('\n[9] 桌面快捷方式（免安装首启补建）');
const shortcutMod = fs.readFileSync(P('src/main/desktop-shortcut.js'), 'utf8');
const pkgJson = require(P('package.json'));
[
  ['主进程引了这个模块并在 bootstrap 里真的调用',
    /require\('\.\/desktop-shortcut'\)/.test(mainJs) && /ensureDesktopShortcut\(\)/.test(mainJs)],
  ['只在打包后动手（开发时跑的是 node_modules 里的 electron.exe）',
    /app\.isPackaged/.test(mainJs) && /function shouldInstall\(o\)[\s\S]{0,200}?o\.packaged/.test(shortcutMod)],
  ['用 shell.writeShortcutLink，不引 COM / 不 spawn PowerShell',
    /shell\.writeShortcutLink\(/.test(mainJs) && !/WScript\.Shell|powershell/i.test(shortcutMod)],
  ['桌面上已经有同名图标就不覆盖（用户可能改过名字、钉过任务栏）',
    /existsSync\(lnk\)[\s\S]{0,60}?return 'exists'/.test(shortcutMod)],
  ['写失败不打标 —— 打了标就等于永远不建了，只做一次的门就锁死了',
    /result === 'failed'[\s\S]{0,200}?return;[\s\S]{0,400}?settings\.patch\(\{ desktopShortcut: 1 \}\)/.test(mainJs)],
  ['标记落在 settings 里，默认 0', /desktopShortcut:\s*0/.test(
    fs.readFileSync(P('src/main/settings.js'), 'utf8'))],
  ['快捷方式名字的三份来源同词（productName / NSIS shortcutName / 模块默认名）',
    pkgJson.productName === pkgJson.build.nsis.shortcutName
      && shortcutMod.includes(`const SHORTCUT_BASENAME = '${pkgJson.productName}'`)],
  ['安装版的路没被动过（NSIS 仍然自己建快捷方式）',
    pkgJson.build.nsis.createDesktopShortcut === true]
].forEach(([name, pass]) => pass ? ok(name) : bad(name));

/* 10. 扩展商店：打开入口 + 从商店取包装上 */
// 这条链子断掉的表现同样是安静的：按钮点得动、界面也没错，只是什么都不发生。
// 另外这里钉一个具体的决定 —— **不列 Greasy Fork**。实测那个域名与它的
// update 子域在国内连 15 秒无响应（DNS 被解析到 Facebook 的地址段），
// 安卓端吃过一次亏才换到脚本猫。哪天有人「顺手补一个常用脚本站」补上它，
// 这一条会红。
console.log('\n[10] 扩展商店（入口 + 取包装上）');
const shopShell = fs.readFileSync(P('src/renderer/shell.js'), 'utf8');
const shopMod = fs.readFileSync(P('src/main/ext-store.js'), 'utf8');
[
  ['主进程引了这个模块',
    /require\('\.\/ext-store'\)/.test(mainJs)],
  ['两个 IPC 通道都注册了（查详情 / 取包装）',
    /handle\('ext:store-info'/.test(mainJs) && /handle\('ext:store-install'/.test(mainJs)],
  ['preload 把两个方法都挂到桥上',
    /storeInfo:\s*\(input\)\s*=>\s*ipcRenderer\.invoke\('ext:store-info'/.test(preload)
      && /storeInstall:\s*\(input\)\s*=>\s*ipcRenderer\.invoke\('ext:store-install'/.test(preload)],
  ['外壳走的是这两个桥方法（不是自己拼 URL 去 fetch）',
    /bridge\.extensions\.storeInfo\(/.test(shopShell) && /bridge\.extensions\.storeInstall\(/.test(shopShell)],
  ['取了包就落盘到 userData 下，且路径记进 settings 供重启恢复装载',
    /extStoreDir = path\.join\(app\.getPath\('userData'\)/.test(mainJs)
      && /downloadCrx\(input, dest[\s\S]{0,600}?path: dest/.test(mainJs)],
  ['「已装过」的判重记在 settings 的 storeId 上',
    /r\.storeId === parsed\.crxId/.test(mainJs) && /storeId: parsed\.crxId/.test(mainJs)],
  ['Edge 那条取包接口还在（可达，且直出 CRX3）',
    /edge\.microsoft\.com\/extensionwebstorebase/.test(shopMod)],
  ['Chrome 应用店走的是国内镜像，入口没指向 chromewebstore.google.com',
    /CHROME_MIRROR\s*=\s*'https:\/\/chrome\.zzzmh\.cn'/.test(shopMod)
      && !/url:\s*'[^']*chromewebstore\.google\.com/i.test(shopShell)],
  ['商店入口列的三个站今天都真可达（Edge 商店 / Chrome 应用店镜像 / 脚本猫）',
    /microsoftedge\.microsoft\.com\/addons/.test(shopShell)
      && /chrome\.zzzmh\.cn/.test(shopShell)
      && /scriptcat\.org/.test(shopShell)],
  ['两个商店的 ID 不是同一套编号 —— Chrome 来源直接走镜像，不去问 Edge',
    /parsed\.source === 'chrome'\)\s*return fetchChromeDetail/.test(shopMod)],
  ['镜像给的是套娃 zip，取包时得把里面的 .crx 掏出来（否则装载那步报缺 manifest.json）',
    /function extractCrxFromMirrorZip/.test(shopMod)
      && /\.crx\$\/i\.test\(e\.name\)/.test(shopMod)],
  ['镜像直链优先取不带签名的那条（带签名的会过期，扩展重启就装不回来）',
    /bare[\s\S]{0,160}?return CHROME_MIRROR \+ bare\[0\]/.test(shopMod)],
  ['扩展包上限容得下镜像站那种偏胖的包（实测 Adblock Plus 70 MB，64 MB 会误杀）',
    /MAX_CRX_BYTES = 192 \* 1024 \* 1024/.test(shopMod)],
  ['STORE_LINKS 里没有一个入口地址指向 Greasy Fork（国内恒不可达，安卓端已换过一轮）',
    !/url:\s*'[^']*greasyfork/i.test(shopShell) && !/greasyfork/i.test(shopMod)],
  ['输入框内容存在 state 里（这个分区会被推送整体重绘，只靠 DOM 值会丢字）',
    /extStore:\s*\{\s*draft:/.test(shopShell) && /extStore\.draft = storeInput\.value/.test(shopShell)],
  ['预览桥也给了这两个方法（否则预览里点一下就是 undefined 报错）',
    /storeInfo:/.test(mockJs) && /storeInstall:/.test(mockJs)],
  ['打开商店会把设置窗口收起来（不然新标签页正好被那扇窗口盖住）',
    /data-store-open[\s\S]{0,400}?closeSettings\(\)/.test(shopShell)],
  ['「已经装过」不当成错误报红（它确实没出错，只是没有新东西）',
    /r\.already[\s\S]{0,200}?toast\(/.test(shopShell)]
].forEach(([name, pass]) => pass ? ok(name) : bad(name));

/* ------------------------------------------------------------------
 * 菜单入口与「关于」里的更新功能
 * ------------------------------------------------------------------ */
const menuBody = js.slice(js.indexOf('function renderMenuPanel'), js.indexOf('function renderSourceCards'));

[
  ['菜单里「设置」排在「新建标签页」之前（用户要求把设置与关于提到上面）',
    menuBody.indexOf('data-panel="settings"') > -1
      && menuBody.indexOf('data-panel="settings"') < menuBody.indexOf('data-act="new-tab"')],
  ['菜单里「关于」也排在「新建标签页」之前',
    menuBody.indexOf('data-panel="about"') > -1
      && menuBody.indexOf('data-panel="about"') < menuBody.indexOf('data-act="new-tab"')],
  ['菜单里「设置」与「关于」各只有一处（挪位置时容易留下重复的那一份）',
    (menuBody.match(/data-panel="settings"/g) || []).length === 1
      && (menuBody.match(/data-panel="about"/g) || []).length === 1],
  ['「关于」那一行的副标题用 upVer()，不再是写死的版本号',
    /data-panel="about"[\s\S]{0,320}?\$\{esc\(upVer\(\)\)\}/.test(menuBody)],
  ['更新按钮的委托挂在 document 上（原来绑 #update-body，「关于」里的按钮点不动）',
    /closest\('\[data-up\]'\)/.test(docClickSeg)],
  ['自动更新的两个开关也用 document 委托（设置分区会被整体重绘，逐行绑定会漏绑）',
    /closest\('\[data-upcfg\]'\)/.test(docClickSeg)],
  ['扩展的启用开关同样用 document 委托（卡片会随列表重绘）',
    /closest\('\[data-ext-toggle\]'\)/.test(docClickSeg)],
  ['更新的状态界面**只有一份**（「关于」与工具栏小窗共用 updateStatusHtml）——各写一份必然漂移',
    // 这条原来要求 buildAbout 里直接出现 data-up="check" —— 那是「各写一份」
    // 时代的判据。现在改成要求：三段按钮都定义在共用的那个函数里，
    // 且两个入口都调它。这比原来严格：漏改一处会直接红。
    /function updateStatusHtml[\s\S]{0,3000}?data-up="check"/.test(js)
      && /function updateStatusHtml[\s\S]{0,3000}?data-up="download"/.test(js)
      && /function updateStatusHtml[\s\S]{0,3000}?data-up="install"/.test(js)
      && /function syncUpdateBlocks[\s\S]{0,400}?updateStatusHtml\(state\.update/.test(js)
      && /function buildAbout[\s\S]{0,600}?updateStatusHtml\(u\)/.test(js)
      // 两个显示位置都标了 [data-up-block]：漏标的那一处会在下载时僵住
      // （「关于」那一页正是这么僵住的 —— 状态是新的，界面是旧的）
      && /data-up-block/.test(html)
      && /<div data-up-block>/.test(js)
      && /querySelectorAll\('\[data-up-block\]'\)/.test(js)],
  ['进度推送不按「小窗开着才重画」来（那样「关于」那一页的进度条会一直停在 0%）',
    /bridge\.on\('update:progress'[\s\S]{0,400}?syncUpdateBlocks\(\)/.test(js)
      && !/if \(!\$\('#update-panel'\)\.hidden\) syncUpdateBlocks/.test(js)],
  // 取委托处理器那**一段**来看（从 closest('[data-up]') 到下一个不同缩进的顶层块），
  // 不要用「从 data-up="check" 起 N 字符」那种宽松匹配 —— 中间隔着注释，
  // 窗口宽度得试好几遍，而其中一段注释里还正好出现了 openPanel('about')
  // （那句是在解释「为什么不用它」），于是宽松匹配会两头都判错。
  ['更新按钮动作后重画当前分区（用 refreshCurrent 刷当前分区，而不是 openPanel 把人弹走）',
    (() => {
      const i = js.indexOf("closest('[data-up]')");
      const seg = js.slice(i, i + 2400);
      // 这段注释是 **// 行注释**，只去 /* */ 块注释是不够的 —— 试过一次，
      // 结果「解释为什么不用 openPanel」那两行照样被当成代码判进去了。
      const segCode = seg
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      return /refreshCurrent\(\)/.test(segCode) && !/openPanel\(/.test(segCode);
    })()],
  ['「关于」里的版本号不再是写死的 0.1.0（那值早就过期了）',
    !/版本<\/span><b>0\.1\.0</.test(js) && /版本<\/span><b>\$\{esc\(upVer\(\)\)\}/.test(js)],
  ['应用版本号由主进程经 bootstrap 透传（package.json 是唯一来源）',
    /appVersion: app\.getVersion\(\)/.test(mainMod)
      && /state\.appVersion = boot\.appVersion/.test(js)],
  ['预览桥也给了 appVersion（否则预览里版本号一片空白）',
    /appVersion:/.test(mockJs)],
  ['updater 记下上次检查时间（「查过但失败」与「从没查过」要读得出区别）',
    /lastCheckAt/.test(updaterMod)],
  ['fmtWhen 用本地时区渲染，不是截 ISO 字符串（否则钟点差几个小时）',
    /function fmtWhen[\s\S]{0,600}?getHours\(\)/.test(js)],
  ['书签页有「从已安装的浏览器导入」这一块',
    /buildBookmarks[\s\S]{0,4000}?id="bm-browsers"/.test(js)],
  ['检测结果里 null（检测中）与空数组（没有）读得出区别',
    /let stateBrowsers = null/.test(js) && /正在检测已安装的浏览器/.test(js)],
  ['那几行用委托绑定（检测完才渲出来，逐行绑定会漏绑 → 渲染出来却点不动）',
    /addEventListener\('click'[\s\S]{0,300}?closest\('\[data-browser\]'\)/.test(js)],
  ['从浏览器导入后如实报数（加了几条 / 重复几条）',
    /已从 \$\{r\.from\} 导入 \$\{r\.added\} 条/.test(js)],
  ['导入图标刷新传的是主机名，不是完整 URL（否则拼成 https://https://… ）',
    /refreshIfStale\(hosts\)/.test(mainMod) && !/refreshIfStale\(m\.merged\.map/.test(mainMod)],
  ['导出与导入用同一个协议闸 importable（分开写会打破「导出→导入恒等」）',
    /function importable/.test(bmIo) && /buildExport[\s\S]{0,400}?importable\(b\.url\)/.test(bmIo)
      && /if \(!importable\(url\)\)/.test(bmIo)],
  ['导出结果带 skipped（内部页导不出去，界面要能如实说少了几条）',
    /skipped,/.test(bmIo) && /const skipped = \(list \|\| \[\]\)\.length - items\.length/.test(bmIo)],
  ['检测只问「文件在不在」，不读内容（检测结果不该泄露有哪些站点）',
    /detectBrowsers\(\(p\) => fs\.existsSync\(p\)\)/.test(mainMod)],
  ['检测在进入书签页时才触发，不在启动时',
    /=== 'bookmarks'\) detectBrowsers\(\)/.test(js)],
  ['Firefox 列为不支持但要说明原因并给出路（不让它神秘消失）',
    /places\.sqlite/.test(bdMod) && /导出为 HTML/.test(bdMod)],
  ['预览桥给了 browsers / fromBrowser',
    /browsers: async/.test(mockJs) && /fromBrowser: async/.test(mockJs)],

  /* --- 自动更新：**自己下载**（不再用 electron-updater） ---
   * 这几条守的是「换个实现时最容易悄悄丢掉的东西」。原来那三条守
   * electron-updater 调用方式的断言已随实现一起删掉（见 git 历史）。 */
  ['更新不再依赖 electron-updater（它要进 dependencies 才打得到包里，且只认 latest.yml）',
    !/require\('electron-updater'\)/.test(updaterMod)
      && !/electron-updater/.test(JSON.stringify(require(P('package.json')).devDependencies || {}))
      && !/electron-updater/.test(JSON.stringify(require(P('package.json')).dependencies || {}))],
  ['下载地址优先取清单里的 exe 段（zip 拿到手还得再解一次才有安装器）',
    /const dl = m\.pc\.exe \|\| m\.pc/.test(updaterMod)],
  ['下载跟随重定向（Gitee 会跳到 CDN，不跟就只能拿到一个 302 的响应体）',
    /function downloadTo[\s\S]{0,1600}?res\.headers\.location/.test(updaterMod)
      && /start\(new URL\(res\.headers\.location, u\)\.href\)/.test(updaterMod)],
  ['重定向有次数上限（成环时必须自己停下来）',
    /重定向次数过多/.test(updaterMod)],
  ['下完校验 sha256（下回来的是要覆盖用户机器上那份程序的东西，下坏了不能照装）',
    /校验不通过（sha256 不符）/.test(updaterMod)
      && /sha256File\(part\)/.test(updaterMod)],
  ['校验通过才改名（否则半个文件会以「下好了」的名字留在那儿）',
    /fs\.renameSync\(part, dest\)/.test(updaterMod)
      && /校验通过才改名/.test(updaterMod)],
  ['下过且哈希对得上时不重复下载（下载失败重试 / 下完没装就重启这两条路不该各吃一次 78MB）',
    /if \(!info\.sha256 \|\| \(await sha256File\(dest\)\) === String\(info\.sha256\)\.toLowerCase\(\)\)/.test(updaterMod)],
  ['安装器用 detached 拉起再退出自己（NSIS 要覆盖的正是我们正在跑的 exe）',
    /function installAndRestart[\s\S]{0,1600}?detached: true/.test(updaterMod)
      && /function installAndRestart[\s\S]{0,1600}?app\.quit\(\)/.test(updaterMod)],
  ['installAndRestart 返回 {ok,error} 而不抛（渲染层要把它显示出来）',
    /function installAndRestart[\s\S]{0,400}?return \{ ok: false, error/.test(updaterMod)],
  ['下载失败会退回 available（留在 downloading 的话那个「重试」会变成卡住的「下载中」）',
    /status: 'available',\s*\n\s*error: String\(e && e\.message/.test(mainMod)],
  ['available 分支会显示失败原因（不读 u.error 的话，点一次失败界面纹丝不动）',
    /u\.status === 'available'[\s\S]{0,400}?u\.error \?/.test(js)],
  ['界面里不再出现「差分 / 只传变化的那部分」这类说法（现在是下整包，留着就是骗人）',
    // 这句一共在两个地方出现过（进度条旁边、开关的副标题）—— 上一次只改了前者，
    // 后者留在「关于」页里继续宣称差分，直到截图才看出来。
    !/下载的是变化的那部分/.test(js) && !/只包含变化的那部分/.test(js)
      && !/走差分/.test(js) && !/只传变化的那部分/.test(js)],
  ['旧安装包会被清掉（一版一个 78 MB，不清的话十版之后用户机器上躺着 780 MB 他看不到的东西）',
    /function pruneOldInstallers/.test(updaterMod)
      && (updaterMod.match(/pruneOldInstallers\(dest\)/g) || []).length === 2],
  ['清理只碰安装包与半成品、且保留当前这一份',
    /if \(full === keepPath\) continue;/.test(updaterMod)
      && /if \(!\/\\\.\(exe\|part\)\$\/i\.test\(k\.name\)\) continue;/.test(updaterMod)],
  ['主进程构造 updaterState 的两处都带 lastCheckAt（整体替换会抹掉它）',
    (mainMod.match(/lastCheckAt/g) || []).length >= 3],

  /* --- 扩展删除记账 --- */
  ['ext:remove 也写回 settings.extensions（三条安装路径都写了，唯独删除漏了 → 重启又装回来）',
    /handle\('ext:remove'[\s\S]{0,500}?settings\.patch\(\{ extensions: recs \}\)/.test(mainMod)],

  /* --- 下载状态机 --- */
  ['DL_STATE 认得 progressing（Chromium 内建下载器的进行中状态）',
    /progressing:\s*\{\s*label: '下载中'/.test(js)],
  ['activeDownloads 的白名单含 progressing（否则不进浮窗与角标）',
    /'probing', 'downloading', 'progress', 'progressing', 'queued', 'paused'/.test(js)],

  /* --- webview 就绪判断：这一类错会被冒泡成一句误导人的「初始化失败」 --- */
  ['syncNavButtons 先探 getWebContentsId 再调 canGoBack（启动必经，不接住就是每次启动报一次）',
    /function syncNavButtons[\s\S]{0,900}?getWebContentsId\(\)\s*>\s*0/.test(js)
      && /function syncNavButtons[\s\S]{0,900}?\}\s*catch\s*\{/.test(js)],
  ['前进/后退走 navGo，里面同样判就绪并接住异常',
    /function navGo\(dir\)[\s\S]{0,900}?getWebContentsId/.test(js)
      && /function navGo\(dir\)[\s\S]{0,900}?catch/.test(js)],
  ['刷新按钮未就绪时退回「重设 src」那条不需要就绪的路',
    /nav-reload[\s\S]{0,700}?getWebContentsId\(\)\s*>\s*0[\s\S]{0,400}?setAttribute\('src'/.test(js)],
  ['「webview 未就绪」这一类错不再显示成「初始化失败」（浏览器其实好得很）',
    /function isWebViewNotReady/.test(js)
      && /must be attached to the DOM/.test(js)
      && /if \(isWebViewNotReady\(err\)\)[\s\S]{0,300}?return;/.test(js)],
  ['真失败时仍然弹提示并留下堆栈（不能为了静默而把真错误也吞掉）',
    /console\.error\(err\)/.test(js) && /toast\('初始化失败：'/.test(js)],

  /* --- 拖入扩展的提示（原先整页只有 preventDefault，屏幕上什么都不变） --- */
  ['拖入时有整窗提示遮罩，且 HTML 与 CSS 都在',
    /id="drop-hint"/.test(html) && /\.drophint\s*\{/.test(css)],
  ['遮罩用 hidden 属性控制（内联 display 会和 [hidden] 规则打架）',
    /\.drophint\[hidden\]\s*\{\s*display:\s*none/.test(css)],
  ['dragenter / dragover / dragleave / drop 四件套都接了',
    /addEventListener\('dragenter'/.test(js) && /addEventListener\('dragover'/.test(js)
      && /addEventListener\('dragleave'/.test(js) && /addEventListener\('drop'/.test(js)],
  ['dragleave 用计数器（划过子元素会反复触发，直接收起会闪）',
    /depth\s*\+=\s*1/.test(js) && /depth\s*-=\s*1/.test(js)],
  ['拖出窗口时也收起（relatedTarget === null，否则遮罩会一直挂着像卡住）',
    /relatedTarget === null\) hideHint\(\)/.test(js)],
  ['非扩展文件不显示「可安装」，并如实说会被忽略',
    /松手后会忽略/.test(js) && /忽略 \$\{paths\.length - extPaths\.length\}/.test(js)],
  ['拖文字/链接进来不弹这个提示（先看 dt.types 里有没有 Files）',
    /indexOf\.call\(dt\.types \|\| \[\], 'Files'\)/.test(js)],
  ['取路径的逻辑只有一处（dragenter 与 drop 共用）',
    /function filePathsOf/.test(js) && (js.match(/filePathsOf\(/g) || []).length >= 3],

  /* --- 拖入取不到路径 = 整条拖入安装链路失效（曾因此报「装不上」） --- */
  ['preload 用 webUtils.getPathForFile 取路径（File.path 已废弃，在 30.x 上是 undefined）',
    /webUtils\.getPathForFile\(file\)/.test(preloadMod)
      && /pathForFile/.test(preloadMod)],
  ['webUtils 从 electron 里取（它需要主进程上下文，渲染层调不到）',
    // 同一行解构出来，所以不能写「先 require 再 webUtils」那种顺序断言 ——
    // 实测它们的先后与写法有关，顺序断言会在改一次格式后莫名变红。
    /const \{[^}]*webUtils[^}]*\} = require\('electron'\)/.test(preloadMod)],
  ['渲染层不再直接读 File.path，改问 preload',
    /function filePathsOf[\s\S]{0,900}?bridge\.system\.pathForFile/.test(js)
      && !/function filePathsOf[\s\S]{0,400}?const p = dt\.files\[i\]\.path/.test(js)],
  ['pathForFile 带老版本兜底，且取不到时返回空串而不是抛',
    /file && file\.path\) \|\| ''/.test(preloadMod) && /catch \{[\s\S]{0,60}?return ''/.test(preloadMod)],
  ['预览桥给了 pathForFile 且返回空串（别返回假路径，那会让预览看起来能用）',
    /pathForFile: async \(\) => ''/.test(mockJs)],
  ['文件对话框的过滤器与白名单同步（含 crx3 —— 少了它在对话框里显示成不认识）',
    /extensions: \['crx', 'crx3', 'xpi', 'zip'\]/.test(mainMod)
      && /EXTENSION_EXTS = \['\.crx', '\.crx3', '\.zip', '\.xpi'\]/.test(extMod)],

  /* --- 选中「装着 crx 的文件夹」时不该报「缺少 manifest.json」 --- */
  ['findPackagesIn 在目录里找扩展包（用户下载后的常见落盘形态）',
    /function findPackagesIn/.test(extMod)
      && /EXTENSION_EXTS\.indexOf\(path\.extname\(k\.name\)\.toLowerCase\(\)\) >= 0/.test(extMod)],
  ['目录展开只发生在「目录本身不像扩展」时（否则已解包目录里的 .zip 会被误当成两个扩展）',
    /if \(extensions\.resolveExtensionRoot\(p\)\) \{ out\.push\(p\); continue; \}/.test(mainMod)],
  ['ext:install 与 ext:install-path 共用同一个展开函数（两条路各写一份迟早只有一边能装）',
    (mainMod.match(/expandInstallTargets\(res\.filePaths\)/g) || []).length === 1
      && (mainMod.match(/expandInstallTargets\(\[p\]\)/g) || []).length === 1],
  ['装扩展的记账只有一处（installOneExtension）——「删除」曾因漏记账导致重启又装回来',
    /async function installOneExtension/.test(mainMod)
      && (mainMod.match(/settings\.patch\(\{ extensions: recs \}\)/g) || []).length >= 1
      && /function installOneExtension[\s\S]{0,700}?settings\.patch\(\{ extensions: recs \}\)/.test(mainMod)],
  ['目录里既没包也没 manifest 时，报错把两种情况都说清（别再只说「缺少 manifest.json」）',
    /既没有扩展包[\s\S]{0,200}?也不是已解包的扩展/.test(mainMod)],
  ['拖到**网页区域**也能装：主进程拦 file:// 且是扩展包的导航',
    /will-navigate'[\s\S]{0,900}?file:[\s\S]{0,200}?isExtensionFile\(url\)/.test(mainMod)],
  ['那条兜底只认扩展包（其余 file:// 导航必须放行，否则用户点开本地 html 就被吃了）',
    /isExtensionFile\(url\)[\s\S]{0,200}?preventDefault\(\)/.test(mainMod)],
  ['file:// → 本地路径的转换处理了 Windows 的前导斜杠（file:///C:/x）',
    /\^\\\/\[A-Za-z\]:/.test(mainMod)],
  ['装了之后有结果回报（ext:dropped 通道 + 外壳的 toast）',
    /'ext:dropped'/.test(preloadMod) && /bridge\.on\('ext:dropped'/.test(js)],

  /* --- 左上角品牌标 = 设置入口 --- */
  ['左上角品牌区是设置入口（div + role=button，键盘也要能触发）',
    /id="btn-brand"[\s\S]{0,120}?role="button"/.test(html)
      && /btn-brand'\)[\s\S]{0,400}?openPanel\('settings'\)/.test(js)
      && /btn-brand'\)[\s\S]{0,600}?ev\.key === 'Enter'/.test(js)],
  ['品牌区标了 no-drag（标题栏整条是窗口拖拽区，否则点击被系统吃掉）',
    /\.tb-brand \{[\s\S]{0,400}?-webkit-app-region: no-drag/.test(css)],
  ['品牌区有悬停反馈与指针形状（否则没人会去点一个像纯装饰的徽标）',
    /\.tb-brand:hover/.test(css) && /\.tb-brand \{[\s\S]{0,400}?cursor: pointer/.test(css)],

  /* --- 自动更新：自动下载 / 自动安装 --- */
  ['设置里有 update.autoDownload / autoInstall 两项，且默认都开',
    /update: \{\s*autoDownload: true,\s*autoInstall: true\s*\}/.test(stMod)],
  ['偏好读取不是简单的 ||（false 是有意义的值，用 || 兜会把「关」当「没设过」）',
    /v\.autoDownload === undefined \? d\.autoDownload !== false/.test(js)],
  ['自动下载按**版本号**去重（用布尔开关的话，主进程每次推状态都会再下一次）',
    /state\.update\.autoDlFor !== ver/.test(js)],
  ['自动下载开着时不再弹「点击工具栏的更新按钮」（自相矛盾）',
    // 窗口按到 400：从判据到那句 toast 中间隔着两行赋值（notified 与 panel），
    // 按 120 会把它们挤出去。
    /if \(!pre\.autoDownload[\s\S]{0,400}?新版本 \$\{ver\} 可用/.test(js)],
  ['自动安装前有倒计时（重启会丢未保存内容，要留喊停的窗口）',
    /function startAutoInstallCountdown/.test(js) && /id="update-now"/.test(html)
      && /\.upnow \{/.test(css)],
  ['倒计时不用 toast 承载（那是单例元素，别的提示一来就被顶掉）',
    /id="update-now"/.test(html) && /不能用 toast 代替/.test(html)],
  ['「稍后」会标记本次运行内不再自动装（否则任何一次状态推送都会重新倒计时）',
    /autoInstallCancelled = true/.test(js)
      && /state\.update\.autoInstFor !== ver[\s\S]{0,120}?autoInstallCancelled/.test(js)],
  ['quitAndInstall 返回 false 时会提示（否则点了「立即重启」像按钮坏了）',
    /r\.ok !== true[\s\S]{0,200}?无法启动安装/.test(js)],
  ['自动安装的开关关掉时把已挂着的倒计时一并收掉',
    /key === 'autoInstall' && !next[\s\S]{0,160}?stopAutoInstallCountdown\(\)/.test(js)],

  /* --- 扩展根定位（单层包裹的包曾对全体用户报「缺少 manifest.json」） --- */
  ['resolveExtensionRoot 会往下找一层（zip/xpi 的真实形状是单层包裹）',
    /function resolveExtensionRoot[\s\S]{0,1500}?manifestAt\(sub\)/.test(extMod)],
  ['定位根排在 normalizeFirefoxExtension 之前（.xpi 正是那种形状）',
    extMod.indexOf('resolveExtensionRoot(extDir)') < extMod.indexOf('normalizeFirefoxExtension(extDir)')],

  /* --- 扩展：启动恢复不该每次重新解包 --- */
  ['解包目录名是确定的（不是 Date.now()）——否则每次启动都新建一个目录，'
    + '既重解一遍（装完插件后启动慢的根因）又无限攒垃圾',
    // 判据要**只看 unpackDirFor 的函数体**：文件别处的注释里提到了旧的
    // Date.now() 写法（解释为什么改），全局判据会被那段注释误伤。
    /function unpackDirFor[\s\S]{0,700}?createHash\('sha1'\)/.test(extMod)
      && !/function unpackDirFor[\s\S]{0,700}?Date\.now/.test(extMod)],
  ['解包前先清掉同名目录（否则换了文件集会留上一版残渣）',
    /fs\.rmSync\(extDir, \{ recursive: true, force: true \}\)/.test(extMod)],
  ['启动恢复优先用上次解包好的 dir，不在了才退回原始包路径',
    /const src = \(rec\.dir && fs\.existsSync\(rec\.dir\)\) \? rec\.dir : rec\.path/.test(mainMod)],
  ['安装时把 dir 记进 settings（不记的话下次启动只能重新解包）',
    /recs\.push\(\{\s*id: info\.id[\s\S]{0,200}?dir: info\.dir/.test(mainMod)],
  ['启动恢复会把 dir 写回 settings（老记录没有 dir，不补的话它们永远每次重解一遍）',
    /extRecordsNext\.push\(\{[\s\S]{0,300}?dir: info\.dir/.test(mainMod)
      && /settings\.patch\(\{ extensions: extRecordsNext \}\)/.test(mainMod)],
  ['有清孤儿解包目录的动作（旧版本用时间戳目录名留下的那些）',
    /pruneOrphanDirs\(settings\.get\('extensions', \[\]\)\)/.test(mainMod)
      && /pruneOrphanDirs\(records\) \{/.test(extMod)],

  /* --- 扩展：启用 / 停用 --- */
  ['有启用/停用能力，且停用的仍留在列表里（否则用户停了就再也找不到它）',
    /async setEnabled\(id, on, sessionFactory\)/.test(extMod)
      && /this\.disabled\.set\(id, \{ \.\.\.hit\.info, enabled: false \}\)/.test(extMod)
      && /list\(\) \{[\s\S]{0,300}?this\.disabled\.values\(\)/.test(extMod)],
  ['停用是真的从 session 卸下、启用是真的装回去（Electron 没有单独的开关）',
    /ses\.removeExtension\(eid\)/.test(extMod) && /await ses\.loadExtension\(rec\.dir/.test(extMod)],
  ['启用/停用会写回 settings.enabled（不写的话重启后停用的又自己开了）',
    /r\.id === id \? \{ \.\.\.r, enabled: !!on \}/.test(mainMod)],
  ['停用的下次启动保持停用',
    /if \(rec\.enabled === false\)[\s\S]{0,200}?setEnabled\(info\.id, false/.test(mainMod)],
  ['停在启用时如果解包目录没了，报「请重新安装」而不是静默失败',
    /扩展文件不在了，请重新安装/.test(extMod)],
  ['扩展面板里已装的排在商店**前面**（点拼图图标进来是想管已装的，不是想再装一个）',
    js.indexOf('已安装${list.length') < js.indexOf('${storeBox(state.extStore)}')],
  ['卡片上有启用开关与移除，且移除标明了不可逆',
    /data-ext-toggle=/.test(js) && /data-remove-ext=/.test(js)
      && /不可撤销，装的文件也会删掉/.test(js)],

  /* --- Edge 商店取包接口已关闭 → 走「从已安装的浏览器导入」 --- */
  ['镜像的 404 错误页不会被当成扩展（曾把 <h1>404</h1> 读成扩展名，界面显示一张名为「404」的卡片）',
    /\/\^\\d\{3\}\$\/\.test\(name\)/.test(storeMod)],
  ['镜像有详情页但没有下载地址时，在**看详情**这一步就判为没收录（不能等点安装才失败）',
    /if \(!downloadUrl\) \{[\s\S]{0,200}?notFound: true/.test(storeMod)],
  ['没收录的说明要指出替代路径、并点明「不是 ID 抄错」',
    /不是 ID 抄错/.test(storeMod) && /从已安装的浏览器导入/.test(storeMod)],
  /* --- 支持「直接粘 .crx / .zip 下载地址」 --- */
  ['认得出直接的扩展包地址（官网 / GitHub 上那种）',
    /source: 'direct', url: url\.href, fileName/.test(storeMod)],
  ['直链那条**排在 ID 识别之前**（直链末段是文件名不是 ID，顺序错了会解析失败）',
    storeMod.indexOf("source: 'direct', url: url.href") < storeMod.indexOf('const seg = url.pathname.split'),
    ],
  ['直链查详情不联网（那只是个文件地址，查不到任何元数据）',
    /if \(parsed\.source === 'direct'\) \{[\s\S]{0,400}?return \{\s*\n?\s*source: 'direct'/.test(storeMod)],
  ['直链取包时**认内容**：给回来一个网页要拦住（别把 HTML 存成 .crx，那样报错更难懂）',
    /不是扩展包（八成是个网页）/.test(storeMod)],
  ['落盘文件名带正确扩展名（install 是照后缀选解包方式的：.crx 拆签名 / .zip 直解）',
    /parsed\.source === 'direct'[\s\S]{0,200}?parsed\.fileName/.test(mainMod)],
  ['判重前先确认 crxId 在（直链没有 storeId，拿 undefined 去比会把没 storeId 的记录全判成「已装过」）',
    /if \(parsed\.crxId\) \{\s*\n\s*const existed/.test(mainMod)],
  ['界面里说明了「可以直接粘下载地址」这条办法',
    /直接粘下载地址/.test(js) && /tampermonkey/.test(js)],
  /* --- 下载进度条 --- */
  ['Chromium 内建下载器那条路会自己算 progress（它只给字节数，渲染层拿不到比值）',
    // 这一路原来从头到尾没写过 progress → 那条任务的进度条永远 0% 宽，
    // 只有右边的字节数在动，看起来就是「进度条不跟着百分比走」
    /const syncNativeProgress = \(\) => \{[\s\S]{0,200}?payload\.progress/.test(mainMod)
      && /syncNativeProgress\(\);/.test(mainMod)],
  ['渲染层的进度条不单独依赖 progress 字段（谁漏写都不该让它僵住）',
    /function dlProgressOf[\s\S]{0,400}?t\.received \/ t\.total/.test(js)
      && /dlProgressOf\(t\)/.test(js)
      && !/Math\.round\(\(t\.progress \|\| 0\) \* 100\)/.test(js)],
  ['下完的那一条直接记成 100%（按比值算会停在 99.9%，看着像没下完）',
    /payload\.state === 'done'\) payload\.progress = 1/.test(mainMod)],

  /* --- 工具栏的扩展小窗 --- */
  ['拼图图标打开的是**独立的扩展小窗**（就地开关），不再直接跳进设置页',
    /function toggleExtPopover/.test(js)
      && /\$\('#btn-ext'\)\.addEventListener\('click', toggleExtPopover\)/.test(js)
      && !/\$\('#btn-ext'\)\.addEventListener\('click', \(\) => openPanel\('extensions'\)\)/.test(js)],
  ['小窗**不能**把自己的 click 拦下来（里面那些开关走的是 document 委托，拦在冒泡路上它们就永远点不动）',
    // 这个是实测踩出来的：一开始照内核菜单的写法给小窗加了 stopPropagation，
    // 结果开关点得下去、界面有反应，就是扩展状态不变。
    !/\$\('#ext-popover'\)\s*\.addEventListener\('click'/.test(js)],
  ['小窗里每一行都有启用开关（这就是「独立的插件启用窗口」本身）',
    // 窗口从 700 放宽到 1000：extPopRow 里在开关之前多了一个可选的
    // 「打开界面」按钮（data-ext-open），把 data-ext-toggle 推远了约 150 字符。
    // 断言意图不变 —— 开关仍必须紧跟在这一行里，只是前面多了个按钮。
    /function extPopRow[\s\S]{0,1000}?data-ext-toggle=/.test(js)],
  ['小窗与设置页显示同一个开关状态 —— 切一处要两处都重画',
    /renderExtPopover\(\);\s*\n\s*refreshCurrent\(\);/.test(js)],
  ['点小窗外面会收起它（按落点判断，而不是给小窗加 stopPropagation）',
    /document\.addEventListener\('click', \(ev\) => \{[\s\S]{0,400}?closest\('#ext-popover'\)[\s\S]{0,200}?closeExtPopover\(\)/.test(js)],
  ['「从本地文件安装」的实现在外壳里**只有一处**（两个入口共用，抄第二份必然漏改）',
    (js.match(/bridge\.extensions\.install\(\)/g) || []).length === 1
      && /function installExtensionsFromDisk/.test(js)],

  ['Edge 取包 400 时给出可操作的说明（不是干巴巴地报 HTTP 400）',
    /Edge 商店的取包接口已关闭/.test(storeMod)
      && /从已安装的浏览器导入/.test(storeMod)],
  ['扫已装扩展的模块用 crxId 白名单挡掉 Temp 之类（a-p 的 32 字母）',
    /const CRX_ID_RE = \/\^\[a-p\]\{32\}\$\//.test(bxMod)
      && /CRX_ID_RE\.test\(idDir\.name\)/.test(bxMod)
      && /'Extensions'/.test(bxMod)],
  ['只认 Default / Profile N 这两种 profile（Temp、System Profile 都不是用户装的）',
    /PROFILE_RE = \/\^\(Default\|Profile \\d\+\)\$\/\~?/.test(bxMod)
      || /PROFILE_RE = \/\^\(Default\|Profile \\d\+\)\$\/;/.test(bxMod)],
  ['火狐那条路不被碰（它没有 Extensions/<id>/<版本> 这种布局）',
    /b\.format !== 'chromium-json'\) continue/.test(bxMod)],
  ['导入是**复制**而不是引用原目录（Edge 更新会删掉旧版本目录）',
    /function importToOneDir/.test(bxMod) && /Edge 更新扩展时会删掉旧版本目录/.test(bxMod)],
  ['复制时跳过 _metadata（Chromium 的校验信息，不是扩展的一部分）',
    /k\.name === '_metadata'\) continue/.test(bxMod)],
  ['导入按 key 重新扫一次解析目录，不接受渲染层传来的路径',
    /const hit = browserExtensions\.scan\(\)\.find/.test(mainMod)
      && !/import-from-browser', async \(dir\)/.test(mainMod)],
  ['扩展面板里有「从已安装的浏览器导入」这一块，且进这一页时触发扫描',
    // 这块是 buildExtensions() 运行时渲出来的，所以看 js 不是 html
    /id="ext-browsers"/.test(js) && /function scanBrowserExts/.test(js)
      && /=== 'extensions'\) scanBrowserExts\(\)/.test(js)],
  ['导入结果如实说来自哪个浏览器',
    /已导入「\$\{r\.name \|\| ''\}」（来自 \$\{r\.from/.test(js)],

  /* --- 网页加载失败的提示页（此前加载失败会一片空白）--- */
  ['有「无法打开此网页」提示页（含重试/回首页）',
    /id="page-error"/.test(html) && /id="pe-retry"/.test(html) && /id="pe-home"/.test(html)],
  ['监听 did-fail-load 并渲染提示页（-3/子框架除外）',
    /addEventListener\('did-fail-load'/.test(js)
      && /ev\.errorCode === -3/.test(js)
      && /renderPageError\(\)/.test(js)],
  ['提示页会藏起承载 webview（否则错误页被 webview 盖住又成空白）',
    /function renderPageError[\s\S]{0,1200}?webview\.hidden = true/.test(js)],

  /* --- 地址栏自动匹配（收藏 + 历史）--- */
  ['有地址栏建议下拉 #omni-suggest',
    /id="omni-suggest"/.test(html)],
  ['从收藏 + 历史匹配并渲染建议',
    /function omniSugMatches/.test(js)
      && /function renderOmniSuggest/.test(js)
      && /state\.bookmarks/.test(js) && /state\.historyCache/.test(js)],
  ['方向键选、回车进建议',
    /ev\.key === 'ArrowDown'/.test(js) && /function pickOmniSuggest/.test(js)],

  /* --- 登录凭证（Nova 自己保存密码 + 填充）--- */
  ['有密码分区与导入/添加/填充动作',
    /id: 'passwords'/.test(js) && /function buildPasswords/.test(js)
      && /'cred-import'/.test(js) && /'cred-add'/.test(js) && /'cred-fill'/.test(js)
      && /function fillLoginIntoActiveTab/.test(js)],

  /* --- 网页右键菜单 + 选中文字迷你条 --- */
  ['有网页右键菜单与选区迷你条',
    /addEventListener\('context-menu'/.test(js) && /bridge\.webview\.contextMenu/.test(js)
      && /function injectSelectionBar/.test(js) && /injectSelectionBar\(tab\)/.test(js)],
].forEach(([name, pass]) => pass ? ok(name) : bad(name));

console.log(failed ? `\n结果：${failed} 项未通过\n` : '\n结果：全部通过\n');
process.exit(failed ? 1 : 0);
