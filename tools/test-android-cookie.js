'use strict';

/**
 * 移动端（Android / Java）Cookie 管理 · 静态接线检查
 * 用法：node tools/test-android-cookie.js
 *
 * 为什么是静态检查：Android 工程的编译需要 Android SDK + Gradle，
 * 本机不一定装了；而这一层要证明的是「接线对没对」——
 * 入口是否在设置里、面板方法是否齐全、布局与字符串是否齐备、序列化是否闭环。
 * 这些不依赖编译，纯文本就能验，于是把关键符号都点一遍。
 *
 * 真正的行为（CookieManager 枚举/增删/清空）由真机或 mobile:check 覆盖。
 *
 * 注：全部用 indexOf / includes 做子串匹配，避免正则里 \/ 这类转义被 JSON
 * 层吃掉导致的误判。
 */

const fs = require('fs');
const path = require('path');

const A = path.resolve(__dirname, '..', 'android-app', 'app', 'src', 'main');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const read = (p) => {
  const full = path.join(A, p);
  try { return fs.readFileSync(full, 'utf8'); } catch { return ''; }
};

const mainJava = read('java/top/wuai/nova/MainActivity.java');
const settingsJava = read('java/top/wuai/nova/NovaSettings.java');
const settingsXml = read('res/layout/sheet_settings.xml');
const cookieSheet = read('res/layout/sheet_cookie.xml');
const cookieItem = read('res/layout/item_cookie.xml');
const cookieEdit = read('res/layout/sheet_cookie_edit.xml');
const strings = read('res/values/strings.xml');

// 子串断言助手
const has = (hay, needle) => hay.indexOf(needle) >= 0;

console.log('\n[A] 设置入口');

check('设置页「隐私与浏览」里加了 Cookie 行（setCookies）',
  has(settingsXml, 'android:id="@+id/setCookies"'));
check('MainActivity 把 setCookies 这一行接进了 showSettings',
  has(mainJava, 'setRow(sheet, R.id.setCookies') && has(mainJava, 'showCookieSheet()'));

console.log('\n[B] 面板方法齐全');

check('有 showCookieSheet', has(mainJava, 'private void showCookieSheet()'));
check('有 cookieRow', has(mainJava, 'private View cookieRow('));
check('有 showCookieEdit', has(mainJava, 'private void showCookieEdit('));
check('有 removeCookie', has(mainJava, 'private void removeCookie('));
check('有 collectCookieHosts', has(mainJava, 'private Set<String> collectCookieHosts()'));
check('有 CookieItem 内部类', has(mainJava, 'private static final class CookieItem'));
check('枚举走后台线程（new Thread）',
  has(mainJava, 'new Thread(') && has(mainJava, 'getCookie('));
check('清空全部走 removeAllCookies',
  has(mainJava, 'CookieManager.getInstance().removeAllCookies(null)'));

console.log('\n[C] 布局与控件 ID 闭环');

check('sheet_cookie.xml 存在且含 cookieList / cookieEmpty / cookieAdd / cookieClearAll',
  has(cookieSheet, 'android:id="@+id/cookieList"')
  && has(cookieSheet, 'android:id="@+id/cookieEmpty"')
  && has(cookieSheet, 'android:id="@+id/cookieAdd"')
  && has(cookieSheet, 'android:id="@+id/cookieClearAll"'));
check('item_cookie.xml 含 ckName / ckValue / ckDomain / ckRemove',
  has(cookieItem, 'android:id="@+id/ckName"')
  && has(cookieItem, 'android:id="@+id/ckValue"')
  && has(cookieItem, 'android:id="@+id/ckDomain"')
  && has(cookieItem, 'android:id="@+id/ckRemove"'));
check('sheet_cookie_edit.xml 含五个输入与 删除/确定 按钮',
  has(cookieEdit, 'android:id="@+id/ckEditName"')
  && has(cookieEdit, 'android:id="@+id/ckEditValue"')
  && has(cookieEdit, 'android:id="@+id/ckEditDomain"')
  && has(cookieEdit, 'android:id="@+id/ckEditPath"')
  && has(cookieEdit, 'android:id="@+id/ckEditExp"')
  && has(cookieEdit, 'android:id="@+id/ckEditRemove"')
  && has(cookieEdit, 'android:id="@+id/ckEditSave"'));
check('Java 引用了上述布局 ID（不会引用了却没在 XML 里）',
  has(mainJava, 'R.layout.sheet_cookie')
  && has(mainJava, 'R.layout.item_cookie')
  && has(mainJava, 'R.layout.sheet_cookie_edit'));

console.log('\n[D] 字符串资源');

const needStrings = ['sheet_cookie', 'cookie_empty', 'cookie_add', 'cookie_clear_all',
  'cookie_remove', 'cookie_name', 'cookie_value', 'cookie_domain', 'cookie_path',
  'cookie_exp', 'cookie_name_hint', 'cookie_value_hint', 'cookie_domain_hint',
  'cookie_path_hint', 'cookie_added', 'cookie_updated', 'cookie_cleared', 'cookie_removed'];
const missingStrings = needStrings.filter((s) => !has(strings, 'name="' + s + '"'));
check('strings.xml 含全部 Cookie 相关字符串',
  missingStrings.length === 0, missingStrings.join(',') || '全部齐');

console.log('\n[E] 序列化闭环（cookies 域名集合要能存能取）');

check('NovaSettings 有 cookieDomains 字段',
  has(settingsJava, 'public String cookieDomains = "";'));
check('toMap 写进了 cookieDomains',
  has(settingsJava, 'm.put("cookieDomains", cookieDomains);'));
check('fromMap 读回了 cookieDomains',
  has(settingsJava, 'if (m.get("cookieDomains") != null) s.cookieDomains'));

console.log(`\n移动端 Cookie 静态检查：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）\n`);
process.exit(fail ? 1 : 0);
