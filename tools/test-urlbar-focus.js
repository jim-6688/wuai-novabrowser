'use strict';
/**
 * 手机版「打开网页时地址栏自己变成编辑态」回归检查
 * 用法：node tools/test-urlbar-focus.js
 *
 * 这一层是静态字面量检查，不是 UI 测试 —— 本地 android.jar 是裁剪桩，
 * 编不出 View / InputMethodManager，JVM 单测碰不到焦点这条链路。
 * 真正要钉住的是四处协同，缺一处就会复发：
 *   ① 布局让 topRow 自己接住系统分配的初始焦点；
 *   ② 每次导航 / 重建界面 / 顶栏从隐藏变可见，都主动退出编辑态；
 *   ③ 收键盘用窗口 token（页内 input 弹的键盘也得收），
 *      且焦点不能交给 WebView（登录页 autofocus 会把键盘弹回来）；
 *   ④ Manifest 压住 Activity 进前台时的自动弹键盘。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const P = (p) => path.join(root, p);
const read = (p) => fs.readFileSync(P(p), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
};

const xml = read('android-app/app/src/main/res/layout/activity_main.xml');
const manifest = read('android-app/app/src/main/AndroidManifest.xml');
const java = read('android-app/app/src/main/java/top/wuai/nova/MainActivity.java');

/* --- ① 布局：把「自动分配的初始焦点」从 urlBar 手里拿走 --- */
const topRow = (xml.match(/<FrameLayout\s+android:id="@\+id\/topRow"[\s\S]*?>/) || [])[0] || '';
check('topRow 自己可聚焦（focusableInTouchMode）',
  /android:focusableInTouchMode="true"/.test(topRow));
check('topRow 先于子孙接管焦点（beforeDescendants）',
  /android:descendantFocusability="beforeDescendants"/.test(topRow));
check('用户主动点地址栏仍会全选（selectAllOnFocus 没被误删）',
  /android:id="@\+id\/urlBar"[\s\S]{0,800}?android:selectAllOnFocus="true"/.test(xml));

/* --- ② 三个时机都要回到展示态 --- */
const goBody = (java.match(/private void go\(String raw\)\s*\{[\s\S]*?\n    \}/) || [])[0] || '';
check('go() 导航前调 releaseOmnibox()', /releaseOmnibox\(\)/.test(goBody));
check('go() 不再只收浮层 / 联想（旧的半吊子收尾已换掉）',
  !/dismissUrlActions\(\);\s*\n\s*hideSuggest\(\);/.test(goBody));

const mountBody = (java.match(/private void mountMain\(\)\s*\{[\s\S]*?\n    \}/) || [])[0] || '';
check('mountMain() 末尾等一帧再收编辑态（setContentView 后系统才分焦点）',
  /mainViewMounted = true;[\s\S]{0,400}?main\.post\(releaseOmniboxTask\)/.test(mountBody));
check('延后任务是可取消的同一个 Runnable（两处 post 共用一个 Handler）',
  /private final Runnable releaseOmniboxTask = this::releaseOmnibox;/.test(java)
  && (java.match(/main\.post\(releaseOmniboxTask\)/g) || []).length === 2
  && !/main\.post\(this::releaseOmnibox\)/.test(java));
check('用户主动聚焦地址栏时撤掉排队的清理（否则点地址栏没反应）',
  /main\.removeCallbacks\(releaseOmniboxTask\)/.test(
    (java.match(/private void focusOmnibox\(\)\s*\{[\s\S]*?\n    \}/) || [])[0] || ''));

const chromeBody = (java.match(/private void applyChromeFor\(String url\)\s*\{[\s\S]*?\n    \}/) || [])[0] || '';
check('applyChromeFor 识别「顶栏从隐藏变可见」这一跳',
  /boolean wasHidden = topBar\.getVisibility\(\) != View\.VISIBLE/.test(chromeBody));
check('新标签页跳网页时，布局走完再收一次编辑态',
  /if \(wasHidden && !isNtp\) main\.post\(releaseOmniboxTask\)/.test(chromeBody));
check('普通网页之间切换不打扰用户',
  !/topBar\.post\(this::releaseOmnibox\);?\s*\n\s*\/\/[^\n]*常/.test(chromeBody));

/* --- ③ 收尾动作本身 --- */
const relBody = (java.match(/private void releaseOmnibox\(\)\s*\{[\s\S]*?\n    \}/) || [])[0] || '';
check('releaseOmnibox 收掉「复制/分享」浮层与输入联想',
  /dismissUrlActions\(\)/.test(relBody) && /hideSuggest\(\)/.test(relBody));
check('releaseOmnibox 清掉地址栏与胶囊输入框的焦点',
  /urlBar\.clearFocus\(\)/.test(relBody) && /capsuleInput\.clearFocus\(\)/.test(relBody));
check('收键盘用窗口 token 而非 urlBar token（页内 input 弹的也收得掉）',
  /getWindow\(\)\.getDecorView\(\)\.getWindowToken\(\)/.test(relBody)
  && /hideSoftInputFromWindow\(token, 0\)/.test(relBody)
  && /if \(token != null\)/.test(relBody));
check('焦点交给 topRow 容器，不给 WebView（避免登录页 autofocus 反弹）',
  /R\.id\.topRow/.test(relBody) && /sink\.requestFocus\(\)/.test(relBody)
  && !/web\.requestFocus\(\)/.test(relBody));
check('首屏未装载主界面时不抢焦点',
  /if \(mainViewMounted\)/.test(relBody));

/* --- ④ Manifest --- */
check('MainActivity 压住进前台自动弹键盘（stateHidden）',
  /android:windowSoftInputMode="adjustResize\|stateHidden"/.test(manifest));
check('保留 adjustResize（键盘弹起时页面仍能顶上去）',
  /adjustResize/.test(manifest));

/* --- 不能顺手破坏的既有能力 --- */
check('用户点图标聚焦地址栏并弹键盘的入口还在',
  /private void focusOmnibox\(\)/.test(java)
  && /urlBar\.requestFocus\(\)/.test(java)
  && /showSoftInput\(urlBar, InputMethodManager\.SHOW_IMPLICIT\)/.test(java));
check('地址栏聚焦仍会切回真实网址并弹「复制/分享」',
  /if \(hasFocus\)[\s\S]{0,600}?showUrlActions\(\)/.test(java));

console.log(`\n结果：${pass} 通过 / ${fail} 未通过\n`);
process.exit(fail ? 1 : 0);
