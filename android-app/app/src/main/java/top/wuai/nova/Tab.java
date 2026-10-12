package top.wuai.nova;

import android.graphics.Bitmap;

/**
 * 一个标签页。
 *
 * <p>刻意<b>不</b>一个标签配一个 WebView。原生 WebView 数量一多，内存会线性往上走，
 * 而浏览器标签的下限天然是几十个 —— 用户随手开个二三十个就把内存吃光了。
 *
 * <p>所以这里是「<b>标签是数据，WebView 是唯一的</b>」：切换标签只换数据，
 * 真正渲染的那一个 WebView 被复用，各标签的滚动位置用 {@link #scrollY} 记着，
 * 返回时还原。这与桌面端「每个标签一个 BrowserWindow」的做法是相反的取舍，
 * 原因纯粹是移动端的内存预算：Android 上一个标签一个 WebView 活不过二十个。
 *
 * <p>缩略图 {@link #snapshot} 是切标签时抓的一张 Bitmap。它有上限而且会及时释放，
 * 不会变成又一份内存陷阱 —— 它的作用只是让标签总览能一眼认出页面，不是长期缓存。
 */
public final class Tab {

    public String url;
    public String title = "";
    /** 切走时记住的滚动位置，还原时用。 */
    public int scrollY;
    /** 标签总览里的缩略图。会及时置空，不长期持有。 */
    public Bitmap snapshot;

    public Tab(String url) {
        this.url = url;
    }

    /**
     * 显示用标题。
     *
     * <p>没有标题时退回域名而不是退回 URL：标签总览是一屏里并排看十几个条目，
     * 一串 {@code https://www.example.com/...} 会把布局挤到换行，而域名足够认人。
     */
    public String displayTitle() {
        if (title != null && !title.trim().isEmpty()) return title.trim();
        return hostOf(url);
    }

    /**
     * 从 URL 里取域名，取不到就原样返回。
     *
     * <p>两条必须分清的分支：
     * <ul>
     *   <li>带 {@code http(s)://} 的，按 authority 段解析，再去用户信息和端口。</li>
     *   <li>其余的（{@code about:blank}、{@code data:...}、{@code file:///a/b}）
     *       <b>原样返回</b>。它们没有 authority 段，硬套「去端口」那一步会把
     *       {@code about:blank} 砍成 {@code about} —— 这是本函数第一版的真 bug，
     *       由一条 {@code assertEquals("about:blank", ...)} 逮到。</li>
     * </ul>
     */
    public static String hostOf(String url) {
        if (url == null) return "";
        int scheme = url.indexOf("://");
        if (scheme < 0) return url;

        String s = url.substring(scheme + 3);
        int end = s.length();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '/' || c == '?' || c == '#') {
                end = i;
                break;
            }
        }
        String host = s.substring(0, end);
        int at = host.lastIndexOf('@');
        if (at >= 0) host = host.substring(at + 1);
        int colon = host.indexOf(':');
        if (colon >= 0) host = host.substring(0, colon);
        return host.isEmpty() ? url : host;
    }

    /** 释放缩略图。切走的标签必须调，否则 Bitmap 会一直挂在标签上。 */
    public void releaseSnapshot() {
        if (snapshot != null && !snapshot.isRecycled()) snapshot.recycle();
        snapshot = null;
    }
}