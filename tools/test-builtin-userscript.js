'use strict';

/**
 * 内置用户脚本测试（纯 Node + jsdom）
 * 用法：node tools/test-builtin-userscript.js
 *
 * 单测（BuiltinScriptsTest）只看得到「清单形状对不对、能不能解析、有没有声明特权、
 * @match 写没写对」。而真正要回答的问题是：**装上去之后，用户在网页上到底能不能复制。**
 * 这一层把那一步跑完 —— 造一个禁止复制与右键的页面，把脚本注入进去，看限制有没有被解除。
 *
 * 它还钉住一个容易被忘掉的事实：内置脚本原设计是 `@run-at document-start`，
 * 而本引擎只能做到 `document-end`（文档已经建好才注入）。
 * 这里的注入时机刻意就按 document-end 来。若哪天有人「优化」成别的时机、
 * 或者换了个依赖 document-start 才有效的脚本，这个测试会红。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'android-app', 'app', 'src', 'main', 'assets', 'user-scripts');
const SCRIPT = path.join(ASSETS, 'remove-web-limits.user.js');
const LICENSE = path.join(ASSETS, 'LICENSE-remove-web-limits.txt');

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

/* ---------------- */

console.log('\n[A] 资产与元数据');

check('脚本文件存在', fs.existsSync(SCRIPT));
check('许可证全文存在', fs.existsSync(LICENSE));

const src = fs.readFileSync(SCRIPT, 'utf8');
const lic = fs.readFileSync(LICENSE, 'utf8');

check('声明了 @grant none', /^\s*\/\/\s*@grant\s+none\s*$/m.test(src));
check('没有声明任何别的 @grant', !/^\s*\/\/\s*@grant\s+(?!none)\S/m.test(src));
check('@match 覆盖所有网站', /^\s*\/\/\s*@match\s+\*:\/\/\*\/\*\s*$/m.test(src));
check('标注了作者与许可', /@author\s+Cat73/.test(src) && /@license\s+LGPLv3/.test(src));
check('许可证全文不是空壳', lic.length > 1000 && /GNU LESSER GENERAL PUBLIC LICENSE/.test(lic));

/* ---------------- */

console.log('\n[B] 注入后到底有没有解除限制（jsdom，按 document-end 时机）');

let JSDOM;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (e) {
  console.log('  SKIP  jsdom 未安装，跳过行为验证（npm i 后重跑）');
}

if (JSDOM) {
  // 一个典型的中文内容站：CSS 禁选 + 右键与复制都被 JS 拦掉
  const dom = new JSDOM(
    '<!doctype html><html><head>'
    + '<style>body,p{-webkit-user-select:none;user-select:none}</style>'
    + '</head><body><p id="t">这段文字应该能被选中和复制</p></body></html>',
    { runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window;

  // 脚本里有一行原作者留下的 console.debug（在 Android 上会进 logcat）。
  // 这里静音掉，让测试输出只剩结论 —— 否则每个 PASS 之间都会夹一行 storageName。
  win.console.debug = function () {};

  // 网站自己的反复制脚本先跑（相当于 head 里的内联脚本）
  win.eval(
    "document.addEventListener('contextmenu', function (e) { e.preventDefault(); });"
    + "document.addEventListener('copy', function (e) { e.preventDefault(); });"
    + "document.body.oncopy = function () { return false; };");

  const blocked = () => {
    const ev = new win.Event('contextmenu', { bubbles: true, cancelable: true });
    win.document.body.dispatchEvent(ev);
    return ev.defaultPrevented;
  };

  const beforeBlocked = blocked();
  const beforeOncopy = !!win.document.body.oncopy;
  check('注入前：右键确实被网站拦住了', beforeBlocked, '（前提成立，否则后面的验证没有意义）');
  check('注入前：body.oncopy 挂着反复制函数', beforeOncopy);

  // ---- 注入。包装方式与 UserScript.buildInject 一致（IIFE + try/catch）----
  let threw = false;
  try {
    win.eval('(function(){\ntry{\n' + src + '\n}catch(e){console.error("[Nova插件]",e);}\n})();\n');
  } catch (e) {
    threw = true;
  }
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  win.dispatchEvent(new win.Event('load'));

  check('注入过程本身不抛异常', !threw);

  // 脚本替换了 Event.prototype.preventDefault：对反复制那几类事件，调用会被吞掉，
  // 于是 defaultPrevented 保持 false —— 右键菜单就能弹出来了。
  check('注入后：右键不再被拦', blocked() === false);
  check('注入后：body.oncopy 被清掉了', !win.document.body.oncopy);

  const css = Array.from(win.document.querySelectorAll('style'))
    .map(s => s.textContent).join('\n');
  check('注入后：页面里多了一段强制可选中的 CSS',
    /-webkit-user-select\s*:\s*text/i.test(css));
  check('注入后：Event.prototype.preventDefault 已被接管',
    !/native code/.test(String(win.Event.prototype.preventDefault)));
}

/* ---------------- */

console.log('\n[C] 语法能在 V8 里解析（Node 与 WebView 同引擎）');

let syntaxOk = true;
let syntaxErr = '';
try {
  // eslint-disable-next-line no-new-func
  new Function(src);
} catch (e) {
  syntaxOk = false;
  syntaxErr = e.message;
}
check('脚本本体语法合法', syntaxOk, syntaxErr);

/* ---------------- */

console.log('\n──────────────────────────────────────────');
console.log('内置脚本测试：' + pass + ' 通过 / ' + fail + ' 失败（共 ' + (pass + fail) + ' 项）');
process.exit(fail === 0 ? 0 : 1);
