package top.wuai.nova;

import java.util.Locale;
import java.util.Set;

/**
 * 吾爱Nova浏览器 · 「这个请求该不该交给下载」的判定。
 *
 * <p>抽成纯逻辑是为了能单测 —— 这段判断的错法很隐蔽：
 * 判宽了会把页面自己的 JS、图片当成下载，页面直接白屏；
 * 判窄了则视频站的下载按钮点了没反应。
 *
 * <h3>四档优先级（从硬到软）</h3>
 *
 * <ol>
 *   <li><b>Content-Disposition: attachment</b> —— 服务器已经明说了「这是个文件，
 *       请保存」，这是最硬的证据，任何时候都该拦。</li>
 *   <li><b>响应 MIME 是明确的文件类型</b> —— 例如 {@code application/octet-stream}、
 *       {@code application/vnd.android.package-archive}（APK）、{@code application/zip}。
 *       这一档是<b>本轮新增</b>，也是修「点了没反应」的关键：真实下载地址常常长得像
 *       {@code /down.php?id=123} 或 {@code /getfile?f=abc}，光看 URL 后缀会误判成页面。</li>
 *   <li><b>路径后缀在已知名单里</b> —— 与嗅探共用同一张表（{@code media-ext.txt}），
 *       所以「嗅探里认为是视频的」和「下载里认为是视频的」永远一致，
 *       不会出现两个模块对同一个文件给出不同结论的情况。</li>
 *   <li><b>URL 里带 download/savefile 之类的词</b> —— 兜底。放在最后且要求
 *       「既有关键词、又没有任何扩展名」，因为带扩展名的已经处理过了。</li>
 * </ol>
 *
 * <h3>为什么 MIME 排在 URL 后缀之前</h3>
 *
 * <p>URL 后缀是可以被伪装的（{@code /down.php?id=1} 指向的其实是一个 zip），
 * 而响应 MIME 是服务器对「这坨字节到底是什么」的直接声明，可信度天然更高。
 * 反过来，如果先看后缀，{@code .php} 会在第一步就被当页面否决掉，
 * 后面再准的 MIME 也救不回来 —— 这正是旧的「点击下载无反应」的成因。
 *
 * <h3>为什么还要一个「网页 MIME 一票否决」</h3>
 *
 * <p>单页应用（SPA）的路由常常长成 {@code /download/page}，甚至直接命中关键词。
 * 这类请求的响应 MIME 一定是 {@code text/html} / {@code application/xhtml+xml}，
 * 也就是说「服务器说自己是一张网页」。此时即便 URL 后缀命中了下载名单，
 * 也不该触发下载 —— 那只会把用户正在浏览的页面变成一个下载框。
 */
public final class DownloadTrigger {

    private static final String[] KEYWORDS = {
        "/download", "/downloads", "/savefile", "/attachment", "/filedownload", "/dl/"
    };

    /** 已知的「非文件」后缀。这些即使路径里有关键词也不是下载。 */
    private static final String[] NOT_DOWNLOAD = {
        "html", "htm", "php", "asp", "aspx", "jsp", "json", "xml", "js", "css"
    };

    /**
     * 「网页」MIME：出现它就一律否决，哪怕 URL 后缀命中下载名单。
     *
     * <p>刻意<b>不</b>把 {@code text/plain} 放进来。{@code text/plain} 是两用的：
     * 它既可能是接口随手返回的一串文本（不该下载），也可能是用户真的点了一个
     * {@code .txt} 文件（该下载）。把它一刀切成「否决」会让 {@code /a.txt} 永远下不了；
     * 一刀切成「文件」又会让一堆接口响应弹出下载框。所以它既不触发也不否决，
     * 把这个判断交回给下一步的 URL 后缀 —— 后缀是 {@code .txt} 就下，没有后缀就不下。
     */
    private static final String[] PAGE_MIMES = {
        "text/html", "application/xhtml+xml", "text/css"
    };

    /**
     * 明确的文件 MIME。
     *
     * <p>只列「一定是整份文件」的类型。{@code text/plain} 故意不在其中（理由见
     * {@link #PAGE_MIMES}）；{@code application/json}、{@code application/xml} 也不列 ——
     * 它们是接口响应的高频类型，收了会把页面自己的 XHR 变成下载。
     */
    private static final String[] FILE_MIMES = {
        // 通用二进制。Content-Disposition 之外的下载里，最常见的兜底声明。
        "application/octet-stream",
        // 安装包
        "application/vnd.android.package-archive",
        "application/x-msdownload", "application/x-msdos-program",
        "application/vnd.microsoft.portable-executable",
        // 压缩包
        "application/zip", "application/x-zip-compressed", "application/x-zip", "multipart/x-zip",
        "application/x-rar-compressed", "application/vnd.rar", "application/x-rar",
        "application/x-7z-compressed", "application/x-tar",
        "application/gzip", "application/x-gzip",
        // 文档
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.oasis.opendocument.text",
        "application/vnd.oasis.opendocument.spreadsheet",
        // 其它整份文件
        "application/x-bittorrent", "application/epub+zip",
        "application/ogg"
    };

    /**
     * 前缀类 MIME。视频 / 音频 / 图片无论子类型是什么，都是一份文件。
     *
     * <p>用前缀而不是逐一列举：{@code video/*} 底下有几十个子类型，
     * 漏一个就少一分「该下没下」。这类资源又不会被 DownloadListener 误触发
     * （页面里的 video 标签、img 标签是子资源，不走这里），所以放宽是安全的。
     */
    private static final String[] FILE_MIME_PREFIXES = {
        "video/", "audio/", "image/"
    };

    private final Set<String> knownExts;
    private final boolean allowKeyword;

    public DownloadTrigger(Set<String> knownExts, boolean allowKeyword) {
        this.knownExts = knownExts;
        this.allowKeyword = allowKeyword;
    }

    /** 判定结果，带原因 —— 界面上要能解释「为什么没触发」。 */
    public static final class Verdict {
        public final boolean trigger;
        public final String reason;
        /** 推断出来的文件后缀（不含点）。判断不出就是空串。 */
        public final String ext;

        Verdict(boolean trigger, String reason, String ext) {
            this.trigger = trigger;
            this.reason = reason;
            this.ext = ext;
        }

        static final Verdict NO = new Verdict(false, "", "");

        /** 带原因的「不触发」。用于向用户解释「为什么这次没下」。 */
        static Verdict no(String reason) {
            return new Verdict(false, reason, "");
        }
    }

    /**
     * 旧签名的判定：不带 MIME。
     *
     * <p>保留它并转发到新签名，是为了不动那些只关心 URL 的调用点与老测试。
     * 内部一律走带 MIME 的那条路径，避免两份逻辑各自演化。
     *
     * @param contentDisposition 响应头，可能为 null
     * @param url                请求地址
     * @param isMainFrame        是不是主文档
     */
    public Verdict judge(String contentDisposition, String url, boolean isMainFrame) {
        return judge(contentDisposition, null, url, isMainFrame);
    }

    /**
     * 判定一个请求要不要交给下载。
     *
     * @param contentDisposition 响应头，可能为 null
     * @param mimetype           响应的 Content-Type，可能为 null 或带 {@code ;charset=...}
     * @param url                请求地址
     * @param isMainFrame        是不是主文档
     */
    public Verdict judge(String contentDisposition, String mimetype, String url,
                         boolean isMainFrame) {
        if (url == null || url.isEmpty()) return Verdict.NO;
        String lower = url.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) return Verdict.NO;
        // 永不把主文档当下载：那个是导航，不是附件。
        // 判错的话用户点一下链接浏览器就退出当前页了。
        if (isMainFrame) return Verdict.NO;

        // ---- 第 1 档：服务器明说是附件
        if (contentDisposition != null) {
            String cd = contentDisposition.toLowerCase(Locale.ROOT);
            if (cd.startsWith("attachment")) {
                String name = DownloadTask.nameFromDisposition(contentDisposition);
                String ext = extOf(name);
                return new Verdict(true, "服务器标记为附件", ext);
            }
            // inline 是明确说了「这是内嵌显示，不是附件」——
            // 视频站的播放器地址常带它，直接下会把页面正在播的内容抽走。
            if (cd.startsWith("inline")) return Verdict.NO;
        }

        // ---- 第 2 档：响应 MIME
        String mime = normalizeMime(mimetype);
        if (!mime.isEmpty()) {
            if (isPageMime(mime)) {
                // 服务器说自己是一张网页 —— 一票否决，连后缀都不再看了。
                return Verdict.no("响应类型 " + mime + " 是网页");
            }
            if (isFileMime(mime)) {
                // 后缀能取到就把文件名信息带出去（下载器要用它定名），取不到也没关系。
                return new Verdict(true, "响应类型 " + mime + " 是文件", extOf(lower));
            }
            // 其余 MIME（text/plain、application/json 等）不表态，交给下面的后缀判定。
        }

        // ---- 第 3 档：URL 后缀
        // extOf 内部会自己跳到最后一个斜杠之后取名，所以直接传整个 URL 即可，
        // 不用先剥 host —— 剥了反而多一层出错机会。
        String ext = extOf(lower);
        if (!ext.isEmpty()) {
            if (isWebPage(ext)) {
                return Verdict.NO;
            }
            if (knownExts.contains(ext)) {
                return new Verdict(true, "后缀 ." + ext + " 在下载名单内", ext);
            }
            // 未知但存在的后缀：可能是用户要的文件，也可能是 .php 这种页面。
            // 不猜 —— 只对明确的名单生效，否则页面自己的 .dat/.json 请求会被吞掉。
            return Verdict.NO;
        }

        // ---- 第 4 档：关键词兜底
        if (allowKeyword && hasKeyword(lower)) {
            return new Verdict(true, "地址含下载关键词", "");
        }
        return Verdict.NO;
    }

    /**
     * 规整 MIME：转小写、砍掉 {@code ;charset=...} 之类的参数、去掉空白。
     *
     * <p>不规整的话 {@code Text/HTML; charset=utf-8} 这种写法会匹配不上，
     * 于是「网页一票否决」形同虚设 —— 而服务器写大写或带 charset 是家常便饭。
     */
    static String normalizeMime(String mimetype) {
        if (mimetype == null) return "";
        String s = mimetype;
        int semi = s.indexOf(';');
        if (semi >= 0) s = s.substring(0, semi);
        return s.trim().toLowerCase(Locale.ROOT);
    }

    private static boolean isPageMime(String mime) {
        for (String m : PAGE_MIMES) {
            if (m.equals(mime)) return true;
        }
        return false;
    }

    private static boolean isFileMime(String mime) {
        for (String m : FILE_MIMES) {
            if (m.equals(mime)) return true;
        }
        for (String p : FILE_MIME_PREFIXES) {
            if (mime.startsWith(p)) return true;
        }
        return false;
    }

    private static boolean isWebPage(String ext) {
        for (String s : NOT_DOWNLOAD) {
            if (s.equals(ext)) return true;
        }
        return false;
    }

    private static boolean hasKeyword(String lowerUrl) {
        for (String k : KEYWORDS) {
            if (lowerUrl.contains(k)) return true;
        }
        return false;
    }

    /**
     * 从 URL 里取路径部分（去掉 scheme、query、hash）。
     *
     * <p>结果<b>含 host</b>（{@code x.com/a/b.mp4} 而不是 {@code /a/b.mp4}），
     * 因为调用它的地方只关心末段文件名，含不含 host 无所谓 ——
     * 而多剥一层就多一个出错机会。
     */
    static String pathOf(String url) {
        String s = url;
        int scheme = s.indexOf("://");
        if (scheme >= 0) s = s.substring(scheme + 3);
        int query = s.indexOf('?');
        int hash = s.indexOf('#');
        int cut = s.length();
        if (query >= 0 && query < cut) cut = query;
        if (hash >= 0 && hash < cut) cut = hash;
        return s.substring(0, cut);
    }

    /**
     * 取后缀。
     *
     * <p>与 {@link NoImagePolicy#extOf} 同样要求点不在段首 ——
     * {@code /.well-known/x} 里那个 {@code .well-known} 是隐藏目录，不是扩展名。
     */
    static String extOf(String pathOrName) {
        if (pathOrName == null || pathOrName.isEmpty()) return "";
        // 先砍掉 query 与 hash。放在 lastIndexOf('/') 之前 ——
        // 否则 "/a/b?x=1" 会被当成末段是 "b?x=1"，取不到任何扩展名。
        String s = pathOrName;
        int cut = s.length();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '?' || c == '#') {
                cut = i;
                break;
            }
        }
        s = s.substring(0, cut);

        int slash = s.lastIndexOf('/');
        String name = slash >= 0 ? s.substring(slash + 1) : s;
        int dot = name.lastIndexOf('.');
        if (dot <= 0 || dot == name.length() - 1) return "";
        String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        for (int i = 0; i < ext.length(); i++) {
            char c = ext.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
            if (!ok) return "";
        }
        return ext;
    }

    /** 提示用的说明文字。 */
    public static String explain(Set<String> knownExts) {
        return "以下情况会交给下载：\n"
            + "· 服务器标了 attachment（最可靠）\n"
            + "· 响应类型是明确的文件类型（apk / zip / pdf / office 文档等）\n"
            + "· 地址后缀是已知的媒体或文档类型（共 " + knownExts.size() + " 种）\n"
            + "\n不会触发的情况：响应类型是网页（html/css）时一律放行，"
            + "无后缀且不含关键词的地址也不猜 —— 猜错会让页面加载到一半白屏。";
    }
}
