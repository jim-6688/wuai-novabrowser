package top.wuai.nova;

import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * 吾爱Nova浏览器 · 移动版无图模式判定。
 *
 * <h3>与桌面版最关键的区别</h3>
 *
 * 桌面版（{@code src/main/nomedia.js}）按 <b>resourceType</b> 判定：Electron 在
 * {@code onBeforeRequest} 里直接告诉你这次请求是 image 还是 media，零猜测。
 *
 * Android 的 {@code shouldInterceptRequest} <b>不给资源类型</b>，能拿到的只有 URL、
 * 方法、是否主文档。所以移动版只能<b>按 URL 后缀猜</b>。
 *
 * <p>这不是实现偷懒，是平台能力的硬边界。由此带来两个必须对用户讲明的后果：
 * <ol>
 *   <li>{@code https://cdn.x.com/a/b/c}（无后缀）返回 {@code Content-Type: image/jpeg}
 *       的图，<b>拦不住</b>。想拦住它就得先把响应拉回来，那就已经产生流量，
 *       整个功能的意义当场归零。</li>
 *   <li>{@code /img.php?id=12} 这类伪静态也拦不住，同上。</li>
 * </ol>
 *
 * <h3>为什么字体一律不拦（两版一致）</h3>
 *
 * 大量站点的界面图标就是字体（Iconfont / Font Awesome）。拦掉页面直接散架，
 * 而省下的字节远不如图片视频可观。这是取舍，不是遗漏。
 */
public final class NoImagePolicy {

    /** 档位。取值与桌面端 settings.js 的 mobile.noImage 同名同值域。 */
    public enum Level {
        OFF("off", "关闭", "正常加载图片与视频"),
        IMAGE("image", "无图", "按网址后缀识别，尽量不下载图片"),
        IMAGE_AV("image-av", "无图 + 视频", "连视频、音频、流媒体分片也一并跳过");

        public final String id;
        public final String label;
        public final String hint;

        Level(String id, String label, String hint) {
            this.id = id;
            this.label = label;
            this.hint = hint;
        }

        public static Level fromId(String id) {
            for (Level l : values()) {
                if (l.id.equals(id)) return l;
            }
            return OFF;
        }

        /** 是不是「会拦东西」的档位。界面上用它决定要不要显示常驻标记。 */
        public boolean active() { return this != OFF; }
    }

    /** 判定结果。带 kind 是为了记台账时能分开统计「省了图」和「省了视频」。 */
    public static final class Decision {
        public final boolean block;
        /** {@code "image"} / {@code "media"} / {@code null} */
        public final String kind;
        /** 判定依据，供台账与排查用 */
        public final String reason;

        private Decision(boolean block, String kind, String reason) {
            this.block = block;
            this.kind = kind;
            this.reason = reason;
        }

        static Decision allow(String reason) { return new Decision(false, null, reason); }
        static Decision block(String kind, String reason) { return new Decision(true, kind, reason); }
    }

    /**
     * 图片后缀表。
     *
     * <p>这是一份<b>启发式名单</b>，与桌面版的资源类型判定不是一回事，所以它单独活在这里，
     * 而不是去跟 sniffer 的注册表合并 —— 那份注册表判的是「这算不算媒体」，
     * 语义不一样，硬合会得到一个谁都说不清的表。
     */
    public static final Set<String> IMAGE_EXTS = Collections.unmodifiableSet(
        new HashSet<>(java.util.Arrays.asList(
            "jpg", "jpeg", "jpe", "jfif", "pjpeg", "pjp",
            "png", "apng", "gif", "webp", "avif", "jxl",
            "bmp", "dib", "tif", "tiff", "heic", "heif",
            "svg", "svgz", "cur"
            // 故意不含 ico：站点图标走 faviconAllow 放行，见桌面版的同名名单
        )));

    private final Level level;
    private final Set<String> imageExts;
    private final Set<String> mediaExts;

    public NoImagePolicy(Level level, Set<String> mediaExts) {
        this(level, IMAGE_EXTS, mediaExts);
    }

    NoImagePolicy(Level level, Set<String> imageExts, Set<String> mediaExts) {
        this.level = level == null ? Level.OFF : level;
        this.imageExts = imageExts == null ? IMAGE_EXTS : imageExts;
        this.mediaExts = mediaExts == null ? Collections.emptySet() : mediaExts;
    }

    public Level level() { return level; }

    public boolean active() { return level != Level.OFF; }

    /**
     * 站点图标放行。
     *
     * <p>与桌面版 nomedia.js 的 KEEP_RE 同义：路径最后一段以 favicon 开头，或后缀是 .ico。
     * 这是<b>启发式</b>而不是标准 —— 好处是宁可放宽：拦掉站点图标既省不下多少字节，
     * 又会让标签页看起来像坏了。
     */
    public static boolean faviconAllow(String path) {
        if (path == null) return false;
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".ico")) return true;
        for (String seg : p.split("/")) {
            if (!seg.isEmpty() && seg.startsWith("favicon")) return true;
        }
        return false;
    }

    /**
     * 取路径最后一段的后缀，没有则返回空串。
     *
     * <p>只看最后一个点之后的部分，且要求点在最后一段里 ——
     * 否则 {@code https://a.com/v1.2/page} 会被当成后缀是 {@code 2/page}。
     */
    public static String extOf(String path) {
        if (path == null) return "";
        int slash = path.lastIndexOf('/');
        String seg = slash >= 0 ? path.substring(slash + 1) : path;
        int dot = seg.lastIndexOf('.');
        if (dot <= 0 || dot == seg.length() - 1) return "";
        return seg.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    /**
     * 判定一次请求是否要在<b>请求阶段</b>就地掐掉。
     *
     * <p>顺序不是随手排的：越靠前的判定越便宜，也越不能出错。
     * 主文档必须最先放行 —— 拦错了它，整页都打不开。
     *
     * @param scheme      请求的协议（小写），如 http / https / data
     * @param path        URL 的路径部分
     * @param isMainFrame 是否主文档
     */
    public Decision judge(String scheme, String path, boolean isMainFrame) {
        // 1) 主文档永远放行
        if (isMainFrame) return Decision.allow("主文档");

        // 2) 只管 http(s)。data: / blob: / file: 拦了也省不下一个字节，
        //    却会把页面自己的内联资源搞坏。
        if (scheme == null) return Decision.allow("无协议");
        String s = scheme.toLowerCase(Locale.ROOT);
        if (!"http".equals(s) && !"https".equals(s)) return Decision.allow("非网络请求");

        // 3) 关闭档位时连后缀都不用取
        if (level == Level.OFF) return Decision.allow("未开启");

        // 4) 站点图标放行（桌面版同一条规则）
        if (faviconAllow(path)) return Decision.allow("站点图标");

        String ext = extOf(path);
        if (ext.isEmpty()) return Decision.allow("无后缀，判不了");

        if (imageExts.contains(ext)) return Decision.block("image", "后缀 ." + ext);

        // 5) 视频 / 音频只在最高档拦
        if (level == Level.IMAGE_AV && mediaExts.contains(ext)) {
            return Decision.block("media", "后缀 ." + ext);
        }

        return Decision.allow("不在名单里");
    }
}
