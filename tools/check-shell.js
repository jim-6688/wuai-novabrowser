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
    /document\.addEventListener\('click',[\s\S]{0,200}?closest\('\[data-up\]'\)/.test(js)],
  ['「关于」面板里有检查更新，且照抄顶栏那套状态机而不是另写一份',
    /function buildAbout[\s\S]{0,3000}?data-up="check"/.test(js)
      && /function buildAbout[\s\S]{0,3000}?data-up="download"/.test(js)
      && /function buildAbout[\s\S]{0,3000}?data-up="install"/.test(js)],
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

  /* --- 自动更新（这条链路从上线起就是断的，务必钉住） --- */
  ['downloadUpdate 之前先 checkForUpdates',
    // downloadUpdate(cancellationToken) 的第一参数是取消令牌而非文件名；
    // 且它开头就要求 updateInfoAndProvider 非空，而那个字段**只在
    // checkForUpdates() 里赋值**。不补这一句，点「下载更新」必然失败。
    /checkForUpdates\(\)[\s\S]{0,120}?\.downloadUpdate\(\)/.test(updaterMod)],
  ['downloadUpdate 不再被当成「接收文件名」的函数调用',
    !/downloadUpdate\(file\)/.test(updaterMod) && !/downloadUpdate\(fileName\)/.test(updaterMod)],
  ['主进程构造 updaterState 的两处都带 lastCheckAt（整体替换会抹掉它）',
    (mainMod.match(/lastCheckAt/g) || []).length >= 3],

  /* --- 扩展删除记账 --- */
  ['ext:remove 也写回 settings.extensions（三条安装路径都写了，唯独删除漏了 → 重启又装回来）',
    /handle\('ext:remove'[\s\S]{0,500}?settings\.patch\(\{ extensions: recs \}\)/.test(mainMod)],

  /* --- 下载状态机 --- */
  ['DL_STATE 认得 progressing（Chromium 内建下载器的进行中状态）',
    /progressing:\s*\{\s*label: '下载中'/.test(js)],
  ['activeDownloads 的白名单含 progressing（否则不进浮窗与角标）',
    /'probing', 'downloading', 'progress', 'progressing', 'queued', 'paused'/.test(js)]
].forEach(([name, pass]) => pass ? ok(name) : bad(name));

console.log(failed ? `\n结果：${failed} 项未通过\n` : '\n结果：全部通过\n');
process.exit(failed ? 1 : 0);
