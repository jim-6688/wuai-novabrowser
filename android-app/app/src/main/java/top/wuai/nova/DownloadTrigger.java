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
 * <h3>三档优先级</h3>
 *
 * <ol>
 *   <li><b>Content-Disposition: attachment</b> —— 服务器已经明说了「这是个文件，
 *       请保存」，这是最硬的证据，任何时候都该拦。</li>
 *   <li><b>路径后缀在已知名单里</b> —— 与嗅探共用同一张表（{@code media-ext.txt}），
 *       所以「嗅探里认为是视频的」和「下载里认为是视频的」永远一致，
 *       不会出现两个模块对同一个文件给出不同结论的情况。</li>
 *   <li><b>URL 里带 download/savefile 之类的词</b> —— 兜底。放在最后且要求
 *       「既有关键词、又没有任何扩展名」，因为带扩展名的已经处理过了。</li>
 * </ol>
 */
public final class DownloadTrigger {

    private static final String[] KEYWORDS = {
        "/download", "/downloads", "/savefile", "/attachment", "/filedownload", "/dl/"
    };

    /** 已知的「非文件」后缀。这些即使路径里有关键词也不是下载。 */
    private static final String[] NOT_DOWNLOAD = {
        "html", "htm", "php", "asp", "aspx", "jsp", "json", "xml", "js", "css"
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
    }

    /**
     * 判定一个请求要不要交给下载。
     *
     * @param contentDisposition 响应头，可能为 null
     * @param url                请求地址
     * @param isMainFrame        是不是主文档
     */
    public Verdict judge(String contentDisposition, String url, boolean isMainFrame) {
        if (url == null || url.isEmpty()) return Verdict.NO;
        String lower = url.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) return Verdict.NO;
        // 永不把主文档当下载：那个是导航，不是附件。
        // 判错的话用户点一下链接浏览器就退出当前页了。
        if (isMainFrame) return Verdict.NO;

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

        if (allowKeyword && hasKeyword(lower)) {
            return new Verdict(true, "地址含下载关键词", "");
        }
        return Verdict.NO;
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
            + "· 地址后缀是已知的媒体或文档类型（共 " + knownExts.size() + " 种）\n"
            + "\n不会触发的情况：网页自身的请求（html/js/css/json 等）一律放行，"
            + "无后缀且不含关键词的地址也不猜 —— 猜错会让页面加载到一半白屏。";
    }
}