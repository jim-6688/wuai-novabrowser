package top.wuai.nova;

import java.net.URLDecoder;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 内置新标签页的「原生侧逻辑」：页面地址怎么拼、候选怎么编码、页面回传的动作怎么解。
 *
 * <p>这一页本身（{@code assets/newtab.html}）与桌面端共用一份源，页面负责排序与呈现；
 * 这里只负责两件事：
 * <ul>
 *   <li><b>数据进去</b> —— 把候选按 {@code label\turl\tvisits\tflags} 逐行编码，
 *       挂到 URL 的 {@code data} 参数上。</li>
 *   <li><b>动作出来</b> —— 页面要增删快捷方式时，是跳一个 {@code nova://shortcut/…}
 *       地址，由 {@code MainActivity.shouldOverrideUrlLoading} 拦下来，这里负责解析。</li>
 * </ul>
 *
 * <p><b>为什么用制表符分隔的文本、而不是 JSON</b>：安卓侧读一行拆一行就够了，
 * 于是不必引 JSON 库；更实际的理由是本地单测里 {@code org.json} 是空壳，
 * 一碰就抛 {@code Stub!} —— 这一层是要被测的逻辑，不能依赖只能上真机才成立的东西。
 * 这与 {@code SYNC.json} 那边「产物刻意用纯文本行」是同一条取舍。
 *
 * <p>整个类不碰任何 Android 框架类，全部是纯 JVM 逻辑，所以能被本地单测完整覆盖。
 */
public final class NewTab {

    /** 页面的资源地址。后面会拼上 {@code ?theme=…&data=…}。 */
    public static final String ASSET_URL = "file:///android_asset/newtab.html";

    /** 页面回传动作时用的 scheme。 */
    public static final String CMD_PREFIX = "nova://shortcut/";

    /** 日志与命令里用的操作名。 */
    public static final String OP_ADD = "add";
    public static final String OP_REMOVE = "remove";
    public static final String OP_SEARCH = "search";

    /** 一次最多送多少条候选过去。页面只显示 7 格，送 30 条是为了让「按访问次数排序」
        真的有意义 —— 只送最近几条的话，一个很久以前被访问过上百次的站点永远进不了视野。 */
    public static final int MAX_CANDIDATES = 30;

    /** 页面上真正摆得下的格数。补位（见 {@link #BUILTIN_SITES}）以它为目标：
        「别让这一屏空着」。与页面侧的 MAX_SHORTCUTS、桌面端 ntp.js 的 MAX_TILES 同值。 */
    public static final int MAX_TILES = 7;

    /**
     * 官方推荐位：候选不够填满版面时，用它们把后面的格子补齐（见 {@link #withBuiltins}）。
     *
     * <p>为什么要补：候选一旦非空，「候选为空才兜底」这条规则就再也不会生效 ——
     * 一个只访问过两三个站点的用户，新标签页上就只剩两三个磁贴，内置的六个入口
     * 整体退场。用户的感受是「宫格被删了」，而不是「我还没访问过几个站」。
     *
     * <p>与桌面端 {@code ntp.js} 的 {@code BUILTIN_SITES}、以及页面里的 {@code FALLBACK}
     * 是同一份数据。三处同值：两端的宿主各有单测逐条比对，改了这份没改那份会被拦下。
     */
    public static final Row[] BUILTIN_SITES = {
        new Row("主页", "https://www.52ta.top/", 0, false, true),
        new Row("导航", "https://52ta.top/", 0, false, true),
        new Row("播放器", "https://music.52ta.top/", 0, false, true),
        new Row("浏览器", "https://nova.52ta.top/", 0, false, true),
        new Row("百度", "https://www.baidu.com/", 0, false, true),
        new Row("DeepSeek", "https://chat.deepseek.com/", 0, false, true)
    };

    /** 一行候选，对应页面上一个磁贴。 */
    public static final class Row {
        public final String label;
        public final String url;
        public final int visits;
        /** 用户自己加的、或固定下来的。固定项会被页面排在前面，且不参与次数排序。 */
        public final boolean pinned;
        /** 官方推荐位（补齐版面用的那种）。排在真实候选之后，flags 编成 {@code f}。 */
        public final boolean builtin;

        public Row(String label, String url, int visits, boolean pinned) {
            this(label, url, visits, pinned, false);
        }

        public Row(String label, String url, int visits, boolean pinned, boolean builtin) {
            this.label = label == null ? "" : label;
            this.url = url == null ? "" : url;
            this.visits = visits;
            this.pinned = pinned;
            this.builtin = builtin;
        }
    }

    /** 页面回传的一条动作。 */
    public static final class Cmd {
        public final String op;
        private final Map<String, String> params;

        Cmd(String op, Map<String, String> params) {
            this.op = op;
            this.params = params;
        }

        public String get(String key) {
            String v = params.get(key);
            return v == null ? "" : v;
        }
    }

    private NewTab() {
    }

    /** 这个地址是不是内置新标签页（含带参数的形式）。地址栏显示、会话恢复都要问它。 */
    public static boolean isNewTab(String url) {
        return url != null && url.startsWith(ASSET_URL);
    }

    /**
     * 从 URL 里取主机名，取不到就返回空串。
     *
     * <p>与 {@code Tab.hostOf}、以及页面上那份 {@code hostOf} 的分支保持一致：
     * 没有 {@code ://} 的（{@code about:blank}）原样返回，因为硬套「去端口」
     * 会把 {@code about:blank} 砍成 {@code about} —— 那是 {@code TabTest} 里
     * 已经逮到过一次的真 bug，这里不重复踩。
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
        // [::1]:8080 这种方括号里的冒号不是端口分隔符
        int colon = host.lastIndexOf(':');
        if (colon > 0 && host.indexOf(']') < colon) host = host.substring(0, colon);
        return host;
    }

    /**
     * 比对「用户不想在新标签页上看到的站点」用的键。
     *
     * <p><b>按主机名而不是按完整 URL 记</b>，因为用户点掉一个磁贴的意思是
     * 「我不想在这儿看到这家」，不是「我不想看到这一个页面」。按 URL 记的话，
     * 知乎换个路径又能爬回来一次，用户就得一个页面一个页面地删。
     *
     * <p>去 {@code www.} 前缀、转小写：{@code WWW.Zhihu.com} 与 {@code zhihu.com}
     * 是同一家，不归一化会出现「删了又回来」。
     */
    public static String hostKey(String url) {
        String h = hostOf(url);
        if (h == null) return "";
        h = h.trim().toLowerCase(Locale.ROOT);
        if (h.startsWith("www.")) h = h.substring(4);
        return h;
    }

    /** 磁贴底下只有一行的位置，名称超过这个长度就会被省略号吃掉。 */
    public static final int MAX_LABEL = 12;

    /**
     * 站点名与页面名之间的常见分隔符。按「先长后短」的顺序试：
     * {@code " - "} 必须排在 {@code "-"} 前面，否则「知乎 - 有问题」会被
     * 按单个连字符切成「知乎 」和「 有问题」两半，结果一样但意图不同 ——
     * 更糟的是「A-B 公司」这种名字里本来就带连字符的会被误切。
     */
    private static final String[] TITLE_SEPS = {
        " - ", " – ", " — ", " | ", " · ", "｜", "|", "_", "－"
    };

    /**
     * 从页面标题里取一个能塞进磁贴的短名。
     *
     * <p>标题最常见的形态是「页面名 - 站点名」（知乎、B 站、掘金都是这个套路）。
     * 直接拿来当磁贴名称，11sp 的字号下那点宽度只够放下四五个字，
     * 用户看到的是清一色的「知乎 - 有…」，七格全一个样，等于没有名字。
     * 所以先按常见分隔符切一刀取前半段，再按长度截断。
     *
     * <p>切的条件是前半段<b>至少两个字</b>：{@code "8-12岁英语"} 里那个连字符
     * 后面是内容而不是站点名，切了反而丢掉一半信息。
     *
     * <p>标题是空的就退回域名（{@link #hostKey}）—— 历史记录里确实有没取到标题的条目。
     */
    public static String labelOf(String title, String url) {
        String s = sanitize(title);
        if (!s.isEmpty()) {
            for (String sep : TITLE_SEPS) {
                int i = s.indexOf(sep);
                if (i >= 2) {
                    s = sanitize(s.substring(0, i));
                    break;
                }
            }
        }
        if (s.isEmpty()) return hostKey(url);
        // 按码点截断。直接 substring 会把 emoji 这类增补平面字符切成半个，
        // 显示成一个方块字符 —— 而磁贴上的字恰恰是最显眼的地方。
        if (s.codePointCount(0, s.length()) > MAX_LABEL) {
            s = s.substring(0, s.offsetByCodePoints(0, MAX_LABEL));
        }
        return s;
    }

    /**
     * 拼页面地址。
     *
     * @param theme {@code dark} / {@code light}；传别的值（含 null）就当浅色。
     *              这一档刻意在调用侧先解析好（见 {@code MainActivity.themeName}），
     *              而不是「不认识就不传、让页面自己看系统」：页面上的颜色要和
     *              地址栏、底栏这些原生部分对得上，而原生的深浅色可能来自
     *              设置里的强制覆盖，未必等于系统当前的深浅色。两边各判一次
     *              的结果就是「深色设置下新标签页是白的」。
     * @param data  已经编码好的候选文本，可以为空。
     */
    public static String pageUrl(String theme, String data) {
        StringBuilder sb = new StringBuilder(ASSET_URL);
        sb.append("?theme=").append(enc(isDark(theme) ? "dark" : "light"));
        if (data != null && !data.isEmpty()) sb.append("&data=").append(enc(data));
        return sb.toString();
    }

    /** 主题名归一化。只认 dark，其余一律 light —— 免得把 null 拼进 URL。 */
    public static boolean isDark(String theme) {
        return theme != null && "dark".equals(theme.toLowerCase(Locale.ROOT));
    }

    /**
     * 把候选编码成逐行文本：{@code label<TAB>url<TAB>visits<TAB>flags}。
     *
     * <p>排序在这里做一次（固定项在前，其余按访问次数降序），页面还会再排一次。
     * 看起来是重复，但两边排的是不同的东西：这边排是为了在 {@link #MAX_CANDIDATES}
     * 这个上限里**优先保住常去的站点**，页面排是为了在 7 格版面里决定谁上谁下。
     * 少了这边这一次，一个访问过上百次的站点会因为「最近没去过」而被截掉。
     */
    public static String candidates(List<Row> rows) {
        if (rows == null || rows.isEmpty()) return "";
        List<Row> sorted = new ArrayList<>(rows);
        Collections.sort(sorted, new Comparator<Row>() {
            @Override
            public int compare(Row a, Row b) {
                if (a.pinned != b.pinned) return a.pinned ? -1 : 1;
                // 推荐位排在所有真实候选之后，且内部保持给定顺序（不比 visits / label）——
                // 掺进次数排序里的话，内置那六条的给定顺序每次都会被重排成另一个样子。
                if (a.builtin != b.builtin) return a.builtin ? 1 : -1;
                if (a.visits != b.visits) return b.visits - a.visits;
                return a.label.compareTo(b.label);
            }
        });
        StringBuilder sb = new StringBuilder();
        int n = 0;
        for (Row r : sorted) {
            if (n >= MAX_CANDIDATES) break;
            if (r.url.isEmpty()) continue;
            if (n > 0) sb.append('\n');
            String flags = r.pinned ? "p" : (r.builtin ? "f" : "-");
            sb.append(sanitize(r.label)).append('\t').append(r.url)
              .append('\t').append(r.visits)
              .append('\t').append(flags);
            n++;
        }
        return sb.toString();
    }

    /**
     * 真实候选不够填满版面时，用 {@link #BUILTIN_SITES} 把后面的格子补齐。
     *
     * <p>单独一个函数、由调用方在编码前调一次，而不是塞进 {@link #candidates}：
     * 那边是「一行候选怎么编码」的纯逻辑，混进补位之后，所有测编码的断言都得
     * 先绕开内置那六条。
     *
     * <p>两个刻意的选择：
     * <ul>
     *   <li>判重按<b>完整 URL</b>，不按主机名 —— 内置那几条本来就是同一家的不同入口
     *       （「主页」是 www 那条、「导航」是裸域那条），按主机名去重会凭空少两格，
     *       用户看到的就是「六宫格又缺了一角」。</li>
     *   <li>被用户点掉的站点（{@code blocked}，归一化主机名）一律不补 —— 否则那个 ×
     *       就是假的，下次进新标签页它又回来了。</li>
     * </ul>
     *
     * @param rows    已组装的真实候选（可为 null）
     * @param blocked 用户点掉过的主机名集合（可为 null）
     */
    public static List<Row> withBuiltins(List<Row> rows, Set<String> blocked) {
        List<Row> out = rows == null ? new ArrayList<Row>() : new ArrayList<>(rows);
        Set<String> have = new HashSet<>();
        for (Row r : out) have.add(r.url);
        for (Row b : BUILTIN_SITES) {
            if (out.size() >= MAX_TILES) break;
            String k = hostKey(b.url);
            if (k.isEmpty()) continue;
            if (blocked != null && blocked.contains(k)) continue;
            if (!have.add(b.url)) continue;
            out.add(b);
        }
        return out;
    }

    /**
     * 解析页面回传的动作地址；不是动作就返回 {@code null}。
     *
     * <p>认不出来的操作也返回 {@code null} 而不是抛异常 —— 地址是可以被页面
     * 随手拼出来的，而这里唯一的正确反应是「当没看见」，不该让一次误拼变成一次崩溃。
     */
    public static Cmd parse(String url) {
        if (url == null || !url.startsWith(CMD_PREFIX)) return null;
        String rest = url.substring(CMD_PREFIX.length());
        String op;
        String query = null;
        int q = rest.indexOf('?');
        if (q < 0) {
            op = rest;
        } else {
            op = rest.substring(0, q);
            query = rest.substring(q + 1);
        }
        op = op.trim();
        if (!OP_ADD.equals(op) && !OP_REMOVE.equals(op) && !OP_SEARCH.equals(op)) return null;

        Map<String, String> params = new LinkedHashMap<>();
        if (query != null) {
            for (String pair : query.split("&")) {
                if (pair.isEmpty()) continue;
                int eq = pair.indexOf('=');
                String k = eq < 0 ? pair : pair.substring(0, eq);
                String v = eq < 0 ? "" : pair.substring(eq + 1);
                params.put(dec(k), dec(v));
            }
        }
        return new Cmd(op, params);
    }

    /**
     * 标签里不能出现制表符和换行 —— 它们是这一层的分隔符。
     * 真出现（用户从别处粘进来）就换成空格，宁可名字少一个分隔符，
     * 也不能让一行被拆成两行、凭空多出一个磁贴。
     */
    static String sanitize(String s) {
        if (s == null) return "";
        return s.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ').trim();
    }

    /** URL 编码。
     *
     * <p>{@code URLEncoder} 按表单规则把空格编成 {@code +}，而页面那头读的是
     * {@code decodeURIComponent}，它只认 {@code %20}。这里统一换成 {@code %20}；
     * 页面里也做了一次 {@code +} → 空格的兜底。两端各留一层，谁改都还有一层接住。 */
    static String enc(String s) {
        try {
            return URLEncoder.encode(s == null ? "" : s, "UTF-8").replace("+", "%20");
        } catch (Exception e) {
            return "";
        }
    }

    static String dec(String s) {
        try {
            return URLDecoder.decode(s == null ? "" : s, "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }
}
