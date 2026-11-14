'use strict';

/**
 * 移动端（Android / Java）功能 #18（稍后读 / WebRTC 防护 / 网页视频画中画）· 静态接线检查
 * 用法：node tools/test-android-readlater.js
 *
 * 为什么是静态检查：Android 工程的编译需要 Android SDK + Gradle，本机不一定装了；
 * 这一层要证明的是「接线对没对」—— 三个功能各自的存储 / 设置 / 布局 / 入口 / 生命周期
 * 是否按设计落地。这些行为之外的真机行为由 mobile:check 覆盖。
 *
 * 注：全部用 indexOf / includes 做子串匹配，避免正则里 \/ 这类转义被 JSON 层吃掉导致误判。
 */

const fs = require('fs');
const path = require('path');

const A = path.resolve(__dirname, '..', 'android-app', 'app', 'src', 'main');
const J = 'java/top/wuai/nova';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const read = (p) => {
  const full = path.join(A, p);
  try { return fs.readFileSync(full, 'utf8'); } catch { return ''; }
};

const mainJava = read(J + '/MainActivity.java');
const novaSettings = read(J + '/NovaSettings.java');
const novaStore = read(J + '/NovaStore.java');
const readLaterStore = read(J + '/ReadLaterStore.java');
const pop = read('res/layout/pop_url_actions.xml');
const sheetRead = read('res/layout/sheet_readlater.xml');
const itemRead = read('res/layout/item_readlater.xml');
const sheetMenu = read('res/layout/sheet_menu.xml');
const sheetSettings = read('res/layout/sheet_settings.xml');
const strings = read('res/values/strings.xml');
const manifest = read('AndroidManifest.xml');
const icReadlater = read('res/drawable/ic_readlater.xml');

const has = (hay, needle) => hay.indexOf(needle) >= 0;

console.log('\n[A] 稍后读 · 存储层');

check('ReadLaterStore.java 存在且落盘 readlater.json',
  has(readLaterStore, 'class ReadLaterStore')
  && has(readLaterStore, '"readlater.json"'));
check('ReadLaterStore 有 list / add / remove / contains / clear',
  has(readLaterStore, 'public List<Item> list(')
  && has(readLaterStore, 'public boolean add(')
  && has(readLaterStore, 'public void remove(')
  && has(readLaterStore, 'public boolean contains(')
  && has(readLaterStore, 'public void clear('));
check('NovaStore 持有 readLaterStore 并聚合 readLaters/addReadLater/removeReadLater/clearReadLaters/isReadLater',
  has(novaStore, 'ReadLaterStore readLaterStore')
  && has(novaStore, 'public List<ReadLaterStore.Item> readLaters(')
  && has(novaStore, 'public boolean addReadLater(')
  && has(novaStore, 'public void removeReadLater(')
  && has(novaStore, 'public void clearReadLaters(')
  && has(novaStore, 'public boolean isReadLater('));
check('NovaStore.clearAll 清掉稍后读',
  has(novaStore, 'readLaterStore.clear();'));

console.log('\n[B] 稍后读 · 资源与布局闭环');

check('ic_readlater.xml 存在（时钟图标）', has(icReadlater, 'vector'));
check('item_readlater.xml 含 rlTitle / rlUrl / rlRemove',
  has(itemRead, 'android:id="@+id/rlTitle"')
  && has(itemRead, 'android:id="@+id/rlUrl"')
  && has(itemRead, 'android:id="@+id/rlRemove"'));
check('sheet_readlater.xml 含 rlEmpty / rlList / rlClear',
  has(sheetRead, 'android:id="@+id/rlEmpty"')
  && has(sheetRead, 'android:id="@+id/rlList"')
  && has(sheetRead, 'android:id="@+id/rlClear"'));
check('sheet_menu.xml 含 menuReadLater 行',
  has(sheetMenu, 'android:id="@+id/menuReadLater"'));
check('pop_url_actions.xml 含第三行 urlActRead（引用 ic_readlater + url_act_readlater）',
  has(pop, 'android:id="@+id/urlActRead"')
  && has(pop, '@drawable/ic_readlater')
  && has(pop, '@string/url_act_readlater'));

const needStrings = ['sheet_readlater', 'readlater_empty', 'readlater_added',
  'readlater_dup', 'readlater_removed', 'readlater_cleared', 'readlater_count',
  'url_act_readlater', 'readlater_no_site'];
const missingStrings = needStrings.filter((s) => !has(strings, 'name="' + s + '"'));
check('strings.xml 含全部稍后读相关字符串',
  missingStrings.length === 0, missingStrings.join(',') || '全部齐');

console.log('\n[C] 稍后读 · MainActivity 接线');

check('有 addReadLater / showReadLaterSheet / readLaterRow 三方法',
  has(mainJava, 'private void addReadLater(')
  && has(mainJava, 'private void showReadLaterSheet(')
  && has(mainJava, 'private View readLaterRow('));
check('showUrlActions 把 urlActRead 接到 addReadLater',
  has(mainJava, 'R.id.urlActRead') && has(mainJava, 'addReadLater();'));
check('showMenuSheet 把 menuReadLater 接到 showReadLaterSheet',
  has(mainJava, 'R.id.menuReadLater') && has(mainJava, 'showReadLaterSheet();'));
check('列表用 store.addReadLater / removeReadLater / clearReadLaters / readLaters',
  has(mainJava, 'store.addReadLater(')
  && has(mainJava, 'store.removeReadLater(')
  && has(mainJava, 'store.clearReadLaters(')
  && has(mainJava, 'store.readLaters()'));
check('addReadLater 走 hasSiteUrl 守卫 + 取 web.getTitle()',
  has(mainJava, 'if (!hasSiteUrl(url))')
  && has(mainJava, 'web.getTitle()'));

console.log('\n[D] WebRTC 防护');

check('NovaSettings 有 webRtcProtect 字段并进出 toMap/fromMap',
  has(novaSettings, 'public boolean webRtcProtect')
  && has(novaSettings, 'm.put("webRtcProtect"')
  && has(novaSettings, 's.webRtcProtect = bool(m.get("webRtcProtect")'));
check('sheet_settings.xml 含 setWebRtc 行',
  has(sheetSettings, 'android:id="@+id/setWebRtc"'));
check('showSettings 接 setWebRtc 开关（改 webRtcProtect + save + 重画 + 注入）',
  has(mainJava, 'R.id.setWebRtc') && has(mainJava, 'settings.webRtcProtect = !settings.webRtcProtect')
  && has(mainJava, 'repaintToggle(sheet, R.id.setWebRtc')
  && has(mainJava, 'injectWebRtcKill();'));
check('有 JS_WEBRTC_KILL 常量与 injectWebRtcKill 方法',
  has(mainJava, 'JS_WEBRTC_KILL =') && has(mainJava, 'private void injectWebRtcKill('));
check('注入覆盖 RTCPeerConnection 各家别名（含 webkit/moz/ms）',
  has(mainJava, 'window.RTCPeerConnection=block')
  && has(mainJava, 'window.webkitRTCPeerConnection=block')
  && has(mainJava, 'window.mozRTCPeerConnection=block')
  && has(mainJava, 'window.msRTCPeerConnection=block'));
check('onPageStarted 在 webRtcProtect 时注入',
  has(mainJava, 'if (settings.webRtcProtect) injectWebRtcKill();'));

console.log('\n[E] 网页视频画中画');

check('NovaSettings 有 pipEnabled 字段并进出 toMap/fromMap',
  has(novaSettings, 'public boolean pipEnabled')
  && has(novaSettings, 'm.put("pipEnabled"')
  && has(novaSettings, 's.pipEnabled = bool(m.get("pipEnabled")'));
check('sheet_settings.xml 含 setPip 行',
  has(sheetSettings, 'android:id="@+id/setPip"'));
check('showSettings 接 setPip 开关（改 pipEnabled + save + 重画）',
  has(mainJava, 'R.id.setPip') && has(mainJava, 'settings.pipEnabled = !settings.pipEnabled')
  && has(mainJava, 'repaintToggle(sheet, R.id.setPip'));
check('Manifest 给 .MainActivity 声明 supportsPictureInPicture',
  has(manifest, 'android:name=".MainActivity"')
  && has(manifest, 'android:supportsPictureInPicture="true"'));
check('有 customView / customViewCallback / inPictureInPicture 三个字段',
  has(mainJava, 'private View customView;')
  && has(mainJava, 'private WebChromeClient.CustomViewCallback customViewCallback;')
  && has(mainJava, 'private boolean inPictureInPicture;'));
check('WebChromeClient 接管 onShowCustomView / onHideCustomView',
  has(mainJava, 'public void onShowCustomView(View view, WebChromeClient.CustomViewCallback cb)')
  && has(mainJava, 'public void onHideCustomView()'));
check('onUserLeaveHint 在 customView 非空时进画中画（API O+）',
  has(mainJava, 'protected void onUserLeaveHint(')
  && has(mainJava, 'enterPictureInPictureMode(new PictureInPictureParams.Builder().build())')
  && has(mainJava, 'Build.VERSION_CODES.O'));
check('onPictureInPictureModeChanged 维护 inPictureInPicture',
  has(mainJava, 'public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode')
  && has(mainJava, 'inPictureInPicture = isInPictureInPictureMode;'));
check('补了 import：android.app.PictureInPictureParams',
  has(mainJava, 'import android.app.PictureInPictureParams;'));

console.log(`\n功能 #18 静态检查：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）\n`);
process.exit(fail ? 1 : 0);
