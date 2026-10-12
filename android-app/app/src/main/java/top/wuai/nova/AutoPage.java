package top.wuai.nova;

/**
 * 吾爱Nova浏览器 · 移动版自动拼页。
 *
 * <p>这里<b>不含任何拼页算法</b>。算法在 {@code src/renderer/autopage.js} 里，
 * 由 {@code npm run mobile:sync} 调那个模块的 {@code buildScript()} 生成
 * {@code assets/autopage.inject.js}，本类只负责：注入、读状态、停、撤。
 *
 * <p>为什么坚持复用而不是用 Java 重写一遍：拼页的难点全在「找下一页链接」
 * 「剔除翻页控件」「去重」「地址绝对化」这些脏活上，那些恰恰是最容易写错、
 * 也最需要长期打磨的部分。重写一份意味着以后每修一次 bug 都得修两遍，两边还会慢慢长歪。
 * 桌面版那套算法本来就是「序列化成字符串注入页面」的形式，移动版注入的是同一段代码 ——
 * 这是它设计时就留好的复用口。
 *
 * <h3>为什么状态不用 JSON 传</h3>
 *
 * {@code evaluateJavascript} 的返回值会被 JSON 编码一次（字符串结果带引号，
 * 中文还可能被转成反斜杠 u 开头的十六进制形式）。为了不在 Java 里引一个 JSON 库、也不依赖 Android 框架里
 * 那个在本地单测中会抛 Stub! 的 org.json，这里让页面侧拼一个 {@code ~} 分隔的紧凑串，
 * Java 侧按位切分。文本字段里的 {@code ~} 由页面侧先替换掉，避免分隔符被数据污染。
 */
public final class AutoPage {

    public static final String ASSET = "autopage.inject.js";
    public static final String GLOBAL = "window.__novaAutoPage";

    /** 页数上限只认这三档，与桌面端 settings.js 的 mobile.autoPageMax 一致 */
    public static final int[] MAX_PAGES = {5, 10, 20};
    public static final int DEFAULT_MAX_PAGES = 10;

    private AutoPage() {}

    public static boolean isAllowedMax(int n) {
        for (int m : MAX_PAGES) {
            if (m == n) return true;
        }
        return false;
    }

    /** 把配置夹到合法档位。配置文件可以被手改，读进来一定得过这一道。 */
    public static int clampMax(int n) {
        return isAllowedMax(n) ? n : DEFAULT_MAX_PAGES;
    }

    /**
     * 注入脚本，并<b>在同一次求值里</b>把页数上限改掉。
     *
     * <p>为什么不能「先注入、下一句再改配置」：脚本 boot 之后会挂滚动监听，
     * 首检有 600ms 延迟，看似够。但只要把它拆成两次求值，就依赖那个延迟不出意外 ——
     * 而这类「依赖时序恰好来得及」的写法，正是最难查的一类 bug。
     * 合成一次求值，配置一定先于任何一次 step 生效。
     */
    public static String bootSource(String script, int maxPages) {
        int n = clampMax(maxPages);
        // 脚本自己就是用 OPTS.maxPages 判定上限的，所以改 config.maxPages 就够，
        // 不需要（也没法）重新生成一遍脚本。
        return script + "\n;(function(){var a=" + GLOBAL
            + ";if(a&&a.config){a.config.maxPages=" + n + ";}})();";
    }

    /** 读状态。拼一个 {@code ~} 分隔串，见类注释。 */
    public static final String STATUS_SOURCE =
        "(function(){var a=" + GLOBAL + ";if(!a)return '';var s=a.status();"
            + "function esc(v){return String(v==null?'':v).replace(/~/g,'/');}"
            + "return s.pages+'~'+(s.loading?1:0)+'~'+(s.hasNext?1:0)+'~'+esc(s.error)+'~'+esc(s.finished);})()";

    public static final String STOP_SOURCE =
        "(function(){var a=" + GLOBAL + ";if(a)a.stop();return 'ok';})()";

    public static final String UNDO_SOURCE =
        "(function(){var a=" + GLOBAL + ";if(a)a.undo();return 'ok';})()";

    /** 页面侧 {@code status()} 的返回结构。 */
    public static final class Status {
        public final int pages;
        public final boolean loading;
        public final boolean hasNext;
        public final String error;
        public final String finished;

        public Status(int pages, boolean loading, boolean hasNext, String error, String finished) {
            this.pages = pages;
            this.loading = loading;
            this.hasNext = hasNext;
            this.error = error == null ? "" : error;
            this.finished = finished == null ? "" : finished;
        }

        public static final Status EMPTY = new Status(0, false, false, "", "");

        /** 给界面看的一句话。安静优先：没事发生就不吭声。 */
        public String summary() {
            if (!error.isEmpty()) return "拼页失败：" + error;
            if (!finished.isEmpty()) return finished;
            if (loading) return "正在拼接第 " + (pages + 2) + " 页…";
            if (pages > 0) return "已拼接 " + pages + " 页";
            return "尚未拼接";
        }

        public boolean canStop() { return pages > 0 || loading; }
        public boolean canUndo() { return pages > 0; }
    }

    /**
     * 解析页面侧回传的状态串。
     *
     * <p>页面没注入、脚本抛错、返回 null —— 统统当成「没有状态」，
     * 界面上表现为「尚未拼接」，绝不把解析失败装成正常状态。
     */
    public static Status parseStatus(String raw) {
        String s = unwrapJsString(raw);
        if (s.isEmpty()) return Status.EMPTY;
        String[] f = s.split("~", -1);
        if (f.length < 5) return Status.EMPTY;
        int pages;
        try {
            pages = Integer.parseInt(f[0].trim());
        } catch (NumberFormatException e) {
            return Status.EMPTY;
        }
        return new Status(pages, "1".equals(f[1].trim()), "1".equals(f[2].trim()), f[3], f[4]);
    }

    /**
     * 把 {@code evaluateJavascript} 回传的 JSON 字符串字面量还原成普通字符串。
     *
     * <p>这是 Android WebView 的一个真实陷阱：{@code evaluateJavascript} 的结果是
     * <b>JSON 编码</b>过的 —— 返回字符串时你会拿到带引号的一整串，中文还可能变成
     * 反斜杠 u 开头的十六进制形式。不脱这层壳，界面上的状态文字就会带着引号显示出来。
     */
    public static String unwrapJsString(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        if (s.isEmpty() || "null".equals(s)) return "";
        if (hasQuotes(s)) s = s.substring(1, s.length() - 1);
        if (s.indexOf('\\') < 0) return s;

        StringBuilder out = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c != '\\' || i == s.length() - 1) {
                out.append(c);
                continue;
            }
            char n = s.charAt(++i);
            switch (n) {
                case 'n': out.append('\n'); break;
                case 'r': out.append('\r'); break;
                case 't': out.append('\t'); break;
                case 'b': out.append('\b'); break;
                case 'f': out.append('\f'); break;
                case 'u':
                    if (i + 4 < s.length()) {
                        try {
                            out.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                            i += 4;
                        } catch (NumberFormatException e) {
                            out.append(n);
                        }
                    } else {
                        out.append(n);
                    }
                    break;
                default: out.append(n);
            }
        }
        return out.toString();
    }

    /**
     * 判断这串是不是一个完整的 JSON 字符串字面量。
     *
     * <p><b>末尾引号必须没被转义。</b>这是本函数唯一的真 bug：
     * 输入 {@code "ab\} 看起来两头都有引号，但最后那个引号前面是反斜杠 ——
     * 它是被转义的内容，不是定界符。第一版只判了「两头都是引号」，
     * 于是把这个 {@code "} 当成了内容交出去，界面上的状态会莫名其妙多一个引号。
     *
     * <p>而截断输入本来就该原样返回：宁可多显示一个字符，
     * 也不能因为「猜错了结构」就吃掉真实内容。
     */
    private static boolean hasQuotes(String s) {
        if (s.length() < 2 || s.charAt(0) != '"' || s.charAt(s.length() - 1) != '"') {
            return false;
        }
        // 从末尾往前数连续反斜杠：偶数个说明末尾引号未被转义
        int backslashes = 0;
        for (int i = s.length() - 2; i >= 0 && s.charAt(i) == '\\'; i--) {
            backslashes++;
        }
        return backslashes % 2 == 0;
    }
}
