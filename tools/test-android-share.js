'use strict';

/**
 * 移动端（Android / Java）截图与二维码分享（功能 #17）· 静态接线检查
 * 用法：node tools/test-android-share.js
 *
 * 为什么是静态检查：Android 工程的编译需要 Android SDK + Gradle，
 * 本机不一定装了；而这一层要证明的是「接线对没对」——
 * 浮层四格是否齐全、两个 ContentProvider / 工具类是否落地、MainActivity 是否接好、
 * 布局与字符串是否齐备、manifest 是否登记。这些不依赖编译，纯文本就能验。
 *
 * 真正的行为（截图 draw、ZXing 编码、content:// 分享）由真机或 mobile:check 覆盖。
 *
 * 注：全部用 indexOf / includes 做子串匹配，避免正则里 \/ 这类转义被 JSON 层吃掉导致的误判。
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
const shareProvider = read('java/top/wuai/nova/ShareProvider.java');
const qrGen = read('java/top/wuai/nova/QrGen.java');
const pop = read('res/layout/pop_url_actions.xml');
const sheetQr = read('res/layout/sheet_qr.xml');
const strings = read('res/values/strings.xml');
const manifest = read('AndroidManifest.xml');

const has = (hay, needle) => hay.indexOf(needle) >= 0;

console.log('\n[A] 地址栏浮层四格');

check('pop_url_actions.xml 含四个动作格（复制 / 分享 / 截图 / 二维码）',
  has(pop, 'android:id="@+id/urlActCopy"')
  && has(pop, 'android:id="@+id/urlActShare"')
  && has(pop, 'android:id="@+id/urlActShot"')
  && has(pop, 'android:id="@+id/urlActQr"'));
check('截图格引用 ic_screenshot 图标', has(pop, '@drawable/ic_screenshot'));
check('二维码格引用 ic_qr 图标', has(pop, '@drawable/ic_qr'));
check('截图格文案来自 url_act_shot', has(pop, '@string/url_act_shot'));
check('二维码格文案来自 url_act_qr', has(pop, '@string/url_act_qr'));

console.log('\n[B] ShareProvider（仿 ApkProvider 的只读 content:// 通道）');

check('ShareProvider.java 存在且声明 AUTHORITY = top.wuai.nova.share',
  has(shareProvider, 'AUTHORITY = "top.wuai.nova.share"'));
check('有 uriFor 拼 content:// 地址', has(shareProvider, 'public static Uri uriFor('));
check('有 safeName 静态校验（挡 / \\ .. 且只放行 .png）',
  has(shareProvider, 'static boolean safeName(')
  && has(shareProvider, '.png'));
check('getType 返回 image/png', has(shareProvider, 'image/png'));
check('openFile 只读（MODE_READ_ONLY）', has(shareProvider, 'MODE_READ_ONLY'));
check('目录落在 Pictures/novabrowser', has(shareProvider, 'DIRECTORY_PICTURES') && has(shareProvider, '"novabrowser"'));
check('manifest 注册 .ShareProvider（authority 一致）',
  has(manifest, 'android:name=".ShareProvider"')
  && has(manifest, 'top.wuai.nova.share')
  && has(manifest, 'android:exported="false"')
  && has(manifest, 'android:grantUriPermissions="true"'));

console.log('\n[C] QrGen（复用 ZXing core 生成二维码）');

check('QrGen.java 存在且有 make 方法', has(qrGen, 'public static Bitmap make('));
check('MARGIN 常量 = 2', has(qrGen, 'MARGIN = 2'));
check('引用 QRCodeWriter / BitMatrix（ZXing 编码）',
  has(qrGen, 'QRCodeWriter()') && has(qrGen, 'BitMatrix'));
check('输出 ARGB_8888 透明底', has(qrGen, 'ARGB_8888'));

console.log('\n[D] MainActivity 接线');

check('showUrlActions 把 urlActShot 接到 captureAndShareScreenshot',
  has(mainJava, 'R.id.urlActShot') && has(mainJava, 'captureAndShareScreenshot()'));
check('showUrlActions 把 urlActQr 接到 showQrSheet',
  has(mainJava, 'R.id.urlActQr') && has(mainJava, 'showQrSheet()'));
check('方法齐全：captureAndShareScreenshot / captureScreenshot / saveBitmap / shareImage / showQrSheet / stamp',
  has(mainJava, 'private void captureAndShareScreenshot()')
  && has(mainJava, 'private Bitmap captureScreenshot(')
  && has(mainJava, 'private File saveBitmap(')
  && has(mainJava, 'private void shareImage(')
  && has(mainJava, 'private void showQrSheet()')
  && has(mainJava, 'private Bitmap stamp('));
check('截图走 ShareProvider.uriFor + FLAG_GRANT_READ_URI_PERMISSION',
  has(mainJava, 'ShareProvider.uriFor(') && has(mainJava, 'FLAG_GRANT_READ_URI_PERMISSION'));
check('截图生成调 QrGen.make 或 复用 web.draw（draw 截图）',
  has(mainJava, 'web.draw(canvas)') && has(mainJava, 'QrGen.make('));
check('落盘目录 = getExternalFilesDir(PICTURES)/novabrowser',
  has(mainJava, 'getExternalFilesDir(Environment.DIRECTORY_PICTURES)')
  && has(mainJava, '"novabrowser"'));
check('补了 import：FileOutputStream / Date / Environment / Paint',
  has(mainJava, 'import java.io.FileOutputStream;')
  && has(mainJava, 'import java.util.Date;')
  && has(mainJava, 'import android.os.Environment;')
  && has(mainJava, 'import android.graphics.Paint;'));

console.log('\n[E] 二维码弹层布局与字符串闭环');

check('sheet_qr.xml 含 qrImg / qrUrl / qrSave / qrShare',
  has(sheetQr, 'android:id="@+id/qrImg"')
  && has(sheetQr, 'android:id="@+id/qrUrl"')
  && has(sheetQr, 'android:id="@+id/qrSave"')
  && has(sheetQr, 'android:id="@+id/qrShare"'));
check('Java 引用了 R.layout.sheet_qr 与上述控件 id',
  has(mainJava, 'R.layout.sheet_qr')
  && has(mainJava, 'R.id.qrImg')
  && has(mainJava, 'R.id.qrUrl')
  && has(mainJava, 'R.id.qrSave')
  && has(mainJava, 'R.id.qrShare'));
const needStrings = ['sheet_qr', 'qr_hint', 'qr_save', 'qr_share', 'qr_saved',
  'url_act_shot', 'url_act_qr'];
const missingStrings = needStrings.filter((s) => !has(strings, 'name="' + s + '"'));
check('strings.xml 含全部截图 / 二维码相关字符串',
  missingStrings.length === 0, missingStrings.join(',') || '全部齐');

console.log(`\n移动端截图与二维码分享 静态检查：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）\n`);
process.exit(fail ? 1 : 0);
