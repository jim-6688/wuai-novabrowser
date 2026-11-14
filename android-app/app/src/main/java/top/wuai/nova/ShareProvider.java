package top.wuai.nova;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * 只读的图片分发通道 —— 把「我们刚截好的图 / 生成的二维码 PNG」交给系统分享目标。
 *
 * <h3>为什么必须走这一层</h3>
 *
 * <p>Android 7.0（API 24）起，把一个 {@code file://} 地址交给别的应用会
 * 立刻抛 {@link android.os.FileUriExposedException}。系统分享选择器、微信、相册……都是
 * 「别的应用」，所以把截图 / 二维码交给它们 <b>必须</b>给一个 {@code content://} 地址。
 *
 * <h3>为什么不用现成的 FileProvider</h3>
 *
 * <p>{@code androidx.core.content.FileProvider} 要引 androidx 整包，而系统自带的
 * {@code android.support.v4.content.FileProvider} 属于早已停止维护的 support 库。
 * 本工程零第三方依赖（{@link ApkProvider} 的注释里详述过这一取舍），要暴露的东西又单调
 * 到极致 —— 只有 Pictures/novabrowser 目录下一类 {@code .png} —— 与其为它引一整包，
 * 不如把这几十行校验写清楚，与 ApkProvider 同套路。
 *
 * <h3>安全</h3>
 *
 * <p>它 {@code exported="false"}：别的应用只有在被显式授权
 * （{@code FLAG_GRANT_READ_URI_PERMISSION}）的那一刻才能读到东西。
 *
 * <p>但「拿到了授权」不等于「可以读任意文件」——文件名里只要出现
 * {@code /}、{@code \} 或 {@code ..} 就一律拒绝，且只放行 {@code .png} 后缀：
 * 这条通道的职责单一，没有理由让它能读别的文件，更没有理由让它翻出 Pictures 目录。
 */
public final class ShareProvider extends ContentProvider {

    /** 与 AndroidManifest 里 {@code android:authorities} 必须逐字一致。 */
    public static final String AUTHORITY = "top.wuai.nova.share";

    /** 只允许分发这一种 MIME。 */
    private static final String PNG_MIME = "image/png";

    /** 把一张已落盘的图片拼出可分享的 content:// 地址。 */
    public static Uri uriFor(File png) {
        return new Uri.Builder()
            .scheme("content")
            .authority(AUTHORITY)
            .appendPath(png.getName())
            .build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = resolve(uri);
        // 一律只读。拿到授权的应用只需要「读走这张图」，写权限意味着能改我们的私有文件。
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        return PNG_MIME;
    }

    /**
     * 文件名是否允许通过。抽成静态纯函数只为一件事：<b>能单测</b>。
     *
     * <p>规则与 ApkProvider 同源：
     * <ul>
     *   <li>反斜杠与正斜杠都挡 —— 某些解析器在 Android 上会把反斜杠当分隔符。</li>
     *   <li>{@code ..} 挡掉，否则 {@code ../../databases/cookies} 就是一条读遍私有目录的路。</li>
     *   <li>只放行 {@code .png}：这条通道的职责单一，没有理由让它能读别的文件。</li>
     * </ul>
     */
    static boolean safeName(String name) {
        if (name == null || name.isEmpty()) return false;
        if (name.indexOf('/') >= 0) return false;
        if (name.indexOf('\\') >= 0) return false;
        if (name.contains("..")) return false;
        return name.endsWith(".png");
    }

    /**
     * 把 URI 的最后一段解析成一个真实存在的图片文件，任何不合规的输入都抛
     * {@link FileNotFoundException}。
     *
     * <p>只取最后一段，等于先砍掉一切「多级路径」的可能，再逐字符校验；
     * 落点必须确实在 Pictures/novabrowser 内（canonical 双重保险）。
     */
    private File resolve(Uri uri) throws FileNotFoundException {
        if (uri == null) throw new FileNotFoundException("空地址");

        String name = uri.getLastPathSegment();
        if (!safeName(name)) throw new FileNotFoundException("文件名不合法");

        Context c = getContext();
        if (c == null) throw new FileNotFoundException("没有可用的上下文");

        File dir = picturesDir(c);
        File f = new File(dir, name);

        // 双重保险：即便上面的字符检查哪天被改松了，这里再确认一次落点确实在目录内。
        try {
            if (!f.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator)) {
                throw new FileNotFoundException("越界访问");
            }
        } catch (IOException e) {
            throw new FileNotFoundException("路径解析失败");
        }

        if (!f.isFile()) throw new FileNotFoundException("文件不存在");
        return f;
    }

    /** Pictures/novabrowser —— 与 MainActivity#shareImageDir() 落盘目录一致。 */
    static File picturesDir(Context c) {
        File base = c.getExternalFilesDir(Environment.DIRECTORY_PICTURES);
        File dir = new File(base, "novabrowser");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    // ---- 这条通道只读、只给一个目录用，其余操作一律不支持。

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
