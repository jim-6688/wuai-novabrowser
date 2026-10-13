package top.wuai.nova;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 更新完成后的自动重启：监听系统发出的「本应用已被替换」广播，随即把新版本拉起来。
 *
 * <h3>它解决的是哪段体验</h3>
 *
 * <p>普通第三方应用做不到真正静默安装，所以「重启更新」落到用户手里就是
 * 「点安装 → 系统装完 → 得自己再点图标打开」。别的浏览器补的那一步正是这里：
 * 装完<b>不用手动重开</b>，屏幕一闪直接进新版本。
 *
 * <h3>为什么用系统广播而不是回调</h3>
 *
 * <p>{@code PackageInstaller.Session} 的 commit 回调能拿到「安装成功」，
 * 但走那条路需要 {@code INSTALL_PACKAGES} 权限 —— 那是 {@code signature|privileged}
 * 级别，普通应用拿不到。而 {@link Intent#ACTION_PACKAGE_REPLACED} 是系统在
 * 应用<b>升级替换成功</b>后无条件发出的广播，任何应用都能收到、无需任何权限，
 * 它本身又是隐式广播（manifest 静态注册也能收到，进程被杀都没关系）。
 *
 * <h3>为什么只认自己</h3>
 *
 * <p>广播里带的 {@code EXTRA_UID} 或 data URI 里带包名。这里刻意再比对一次自己的
 * 包名：手机里别的应用升级不该把 Nova 弹起来。
 */
public final class UpdateReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        if (!Intent.ACTION_PACKAGE_REPLACED.equals(action)) return;

        // 只响应「自己」被替换。data URI 形如 package:top.wuai.nova。
        android.net.Uri data = intent.getData();
        String pkg = data == null ? null : data.getSchemeSpecificPart();
        if (pkg == null || !pkg.equals(context.getPackageName())) return;

        // 拉起自己的启动页。getLaunchIntentForPackage 返回的就是带 LAUNCHER 的那条
        // 主入口意图，等价于用户去桌面点一次图标 —— 但这里是装完自动发生的。
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(pkg);
        if (launch == null) return;
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        context.startActivity(launch);
    }
}
