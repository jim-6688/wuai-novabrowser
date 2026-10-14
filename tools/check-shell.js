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
  'src/main/desktop-shortcut.js',
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
 */
const dynamicIds = new Set(['dl-url']);
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

console.log(failed ? `\n结果：${failed} 项未通过\n` : '\n结果：全部通过\n');
process.exit(failed ? 1 : 0);
