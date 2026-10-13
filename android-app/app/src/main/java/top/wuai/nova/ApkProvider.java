package top.wuai.nova;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 只读的 APK 分发通道 —— 把「我们自己下载好的更新包」交给系统安装器。
 *
 * <h3>为什么必须走这一层</h3>
 *
 * <p>Android 7.0（API 24）起，把一个 {@code file://} 形式的地址交给别的应用会
 * 立刻抛 {@link android.os.FileUriExposedException}。系统安装器也是「别的应用」，
 * 所以安装自己下载的 APK <b>必须</b>给它一个 {@code content://} 地址。
 *
 * <h3>为什么不用现成的 FileProvider</h3>
 *
 * <p>{@code androidx.core.content.FileProvider} 要引 androidx 整包，
 * 而系统自带的 {@code android.support.v4.content.FileProvider} 属于早已停止维护的
 * support 库。本工程零第三方依赖，要暴露的东西又单调到极致 ——
 * 只有一个目录下的一类文件 —— 与其为它引一整包，不如把这几十行校验写清楚。
 *
 * <h3>安全</h3>
 *
 * <p>它 {@code exported="false"}：别的应用只有在被显式授权
 * （{@code FLAG_GRANT_READ_URI_PERMISSION}）的那一刻才能读到东西。
 *
 * <p>但「拿到了授权」不等于「可以读任意文件」——文件名里只要出现
 * {@code /}、{@code \} 或 {@code ..} 就一律拒绝。少这一条，
 * {@code content://.../..%2F..%2Fdatabases%2Fcookies} 这种构造就能把
 * 整个私有目录读出去。而且只放行 {@code .apk} 后缀：
 * 这条通道的职责单一，没有理由让它能读别的文件。
 */
public final class ApkProvider extends ContentProvider {

    /** 与 AndroidManifest 里 {@code android:authorities} 必须逐字一致。 */
    public static final String AUTHORITY = "top.wuai.nova.apk";

    /** 只允许分发这一种 MIME。 */
    private static final String APK_MIME = "application/vnd.android.package-archive";

    /** 拼出这个 APK 的可读地址。 */
    public static Uri uriFor(File apk) {
        return new Uri.Builder()
            .scheme("content")
            .authority(AUTHORITY)
            .appendPath(apk.getName())
            .build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = resolve(uri);
        // 一律只读。安装器不需要写权限，而写权限意味着这个通道能改我们的私有文件。
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        return APK_MIME;
    }

    /**
     * 文件名是否允许通过。
     *
     * <p>抽成静态纯函数只为一件事：<b>能单测</b>。这是整条安装链路上唯一的
     * 安全边界 —— 它有洞就等于把应用私有目录暴露给任何一个拿到过授权的进程，
     * 而这属于「必须验证、不能靠肉眼读代码相信」的那一类。
     *
     * <p>三条规则，缺一不可：
     * <ul>
     *   <li>反斜杠与正斜杠都挡 —— Windows 上写惯了 {@code a\b}，
     *       而某些解析器在 Android 上也会把反斜杠当分隔符。</li>
     *   <li>{@code ..} 挡掉，否则 {@code ../../databases/cookies} 就是一条读遍私有目录的路。</li>
     *   <li>只放行 {@code .apk}：这条通道的职责单一，没有理由让它能读别的文件。</li>
     * </ul>
     */
    static boolean safeName(String name) {
        if (name == null || name.isEmpty()) return false;
        if (name.indexOf('/') >= 0) return false;
        if (name.indexOf('\\') >= 0) return false;
        if (name.contains("..")) return false;
        return name.endsWith(".apk");
    }

    /**
     * 把 URI 的最后一段解析成一个真实存在的文件，任何不合规的输入都抛
     * {@link FileNotFoundException}。
     *
     * <p>刻意不用 {@code uri.getPath()} 再拼：那样会把查询串、多层路径一起带进来；
     * 只取最后一段，等于先砍掉一切「多级路径」的可能，再逐字符校验。
     */
    private File resolve(Uri uri) throws FileNotFoundException {
        if (uri == null) throw new FileNotFoundException("空地址");

        String name = uri.getLastPathSegment();
        if (!safeName(name)) throw new FileNotFoundException("文件名不合法");

        Context c = getContext();
        if (c == null) throw new FileNotFoundException("没有可用的上下文");

        File dir = new File(c.getFilesDir(), UpdateManager.UPDATE_DIR);
        File f = new File(dir, name);

        // 双重保险：即便上面的字符检查哪天被改松了，这里再确认一次落点确实在目录内。
        try {
            if (!f.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator)) {
                throw new FileNotFoundException("越界访问");
            }
        } catch (java.io.IOException e) {
            throw new FileNotFoundException("路径解析失败");
        }

        if (!f.isFile()) throw new FileNotFoundException("文件不存在");
        return f;
    }

    // ---- 这条通道只读、只给一个文件用，其余操作一律不支持。

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("只读通道");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("只读通道");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("只读通道");
    }
}
