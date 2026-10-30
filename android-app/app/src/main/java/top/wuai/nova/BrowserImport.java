package top.wuai.nova;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.net.Uri;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 从「本机已安装的浏览器」导入书签。
 *
 * <p>先说清楚这件事在 Android 上能做到什么程度 —— 这决定了界面上怎么写：
 * <ul>
 *   <li>Android <b>没有</b>统一的「读别人书签」接口。历史上只有 AOSP 浏览器提供
 *       {@code content://com.android.browser/bookmarks} 这类 ContentProvider；</li>
 *   <li>Chromium 系（Chrome / Edge / Brave / Opera …）<b>不导出</b>书签给第三方，
 *       书签存在自己的私有数据和账号里，没有 root 读不到；</li>
 *   <li>所以这里做的是：<b>列出真的装了的浏览器</b>，逐个去试它有没有开放的
 *       书签接口；能读的直接导，读不了的如实说明原因并给一步到位的文件导入。</li>
 * </ul>
 *
 * <p>「试」比「白名单」重要：厂商 ROM 常自带基于 AOSP 的浏览器，包名各不相同，
 * 但 authority 一般都等于包名。所以除了几个已知映射，还会拿包名本身当 authority 试一次。
 */
public final class BrowserImport {

    /** 一个装着的浏览器。 */
    public static final class App {
        public final String pkg;
        public final String label;

        public App(String pkg, String label) {
            this.pkg = pkg;
            this.label = label;
        }
    }

    /** 读取结果。error 为 null 表示接口可读（items 可能为空，即对方没有书签）。 */
    public static final class Read {
        public final List<BookmarkImport.Entry> items;
        public final int skipped;
        public final String error;

        private Read(List<BookmarkImport.Entry> items, int skipped, String error) {
            this.items = items;
            this.skipped = skipped;
            this.error = error;
        }

        public boolean readable() {
            return error == null;
        }
    }

    private BrowserImport() {
    }

    /**
     * 本机装了哪些浏览器（不含自己）。
     *
     * <p>按「能不能打开 https 链接」判定，比按包名猜更准 —— 用户装了什么浏览器，
     * 系统最清楚。
     */
    public static List<App> browsers(Context ctx) {
        Map<String, App> out = new LinkedHashMap<>();
        try {
            Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com"));
            probe.addCategory(Intent.CATEGORY_BROWSABLE);
            PackageManager pm = ctx.getPackageManager();
            List<ResolveInfo> list = pm.queryIntentActivities(probe, 0);
            String self = ctx.getPackageName();
            for (ResolveInfo ri : list) {
                if (ri == null || ri.activityInfo == null) continue;
                String pkg = ri.activityInfo.packageName;
                if (pkg == null || pkg.equals(self) || out.containsKey(pkg)) continue;
                String label;
                try {
                    label = String.valueOf(ri.loadLabel(pm));
                } catch (Exception e) {
                    label = pkg;
                }
                if (label.trim().isEmpty()) label = pkg;
                out.put(pkg, new App(pkg, label));
            }
        } catch (Exception ignored) {
            // 取不到就当没有 —— 界面会提示改用文件导入
        }
        return new ArrayList<>(out.values());
    }

    /** 试读某个浏览器的书签。**会查 ContentProvider，建议在后台线程调用。** */
    public static Read read(Context ctx, String pkg) {
        ContentResolver cr = ctx.getContentResolver();
        List<String> authorities = authoritiesFor(pkg);
        String lastError = null;
        for (String auth : authorities) {
            Uri uri = Uri.parse("content://" + auth + "/bookmarks");
            Cursor c = null;
            try {
                c = cr.query(uri, null, null, null, null);
                if (c == null) {
                    lastError = "这个浏览器没有开放书签接口";
                    continue;
                }
                List<BookmarkImport.Entry> items = new ArrayList<>();
                int skipped = 0;
                int ti = c.getColumnIndex("title");
                int ui = c.getColumnIndex("url");
                if (ui < 0) {                       // 列名不对，这个 provider 不是书签接口
                    lastError = "这个浏览器的书签格式无法识别";
                    continue;
                }
                while (c.moveToNext()) {
                    String url = c.getString(ui);
                    String title = ti >= 0 ? c.getString(ti) : "";
                    if (!BookmarkImport.accept(url)) {
                        skipped++;
                        continue;
                    }
                    items.add(new BookmarkImport.Entry(
                        title == null || title.trim().isEmpty() ? url : title.trim(),
                        url.trim()));
                }
                return new Read(items, skipped, null);
            } catch (SecurityException e) {
                lastError = "系统未开放读取（该浏览器不允许别人读它的书签）";
            } catch (Exception e) {
                lastError = "读取失败：" + e.getClass().getSimpleName();
            } finally {
                if (c != null) c.close();
            }
        }
        return new Read(new ArrayList<>(), 0, lastError == null ? "这个浏览器没有开放书签接口" : lastError);
    }

    /**
     * 候选 authority。先看已知映射，再用包名本身兜底 ——
     * 厂商自带的 AOSP 系浏览器通常就是「authority = 包名」。
     */
    static List<String> authoritiesFor(String pkg) {
        List<String> out = new ArrayList<>();
        if (pkg == null || pkg.isEmpty()) return out;
        String known = null;
        switch (pkg) {
            case "com.android.browser":
                known = "com.android.browser";
                break;
            case "com.sec.android.app.sbrowser":
                known = "com.sec.android.app.sbrowser";
                break;
            case "com.tencent.mtt":
                known = "com.tencent.mtt";
                break;
            case "com.UCMobile":
                known = "com.UCMobile";
                break;
            default:
                break;
        }
        if (known != null) out.add(known);
        if (!out.contains(pkg)) out.add(pkg);
        return out;
    }
}
