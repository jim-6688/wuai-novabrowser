package top.wuai.nova;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 地址栏输入的「中文名称 → 网址」联想。
 *
 * <p>三个来源，按可信度从高到低拼成一份候选：
 * <ol>
 *   <li><b>书签</b> —— 用户亲手存的，最可能是他想要的；</li>
 *   <li><b>历史</b> —— 去过的地方，按访问次数与新鲜度加权；</li>
 *   <li><b>联网建议</b>（搜索引擎的补全接口）—— 只给「搜索什么」，不给网址。</li>
 * </ol>
 *
 * <p>为什么联网那一路不给网址：搜索引擎的补全接口返回的是**查询词**，不是站点。
 * 想让「知乎」直接变成 zhihu.com 只能靠本地记录，或者自己维护一张站点表 ——
 * 后者一旦维护不动就会给出错网址，比不猜更糟。所以这里的分工是：
 * <b>本地命中就是「打开」，联网命中就是「搜索」</b>，界面上分得清清楚楚。
 *
 * <p>纯逻辑类，不碰 Android、也不碰 org.json（单测里它是桩），可在纯 JVM 里测。
 */
public final class OmniSuggest {

    public static final int SRC_OPEN = 0;       // 「前往 / 搜索」那条，永远是第一行
    public static final int SRC_BOOKMARK = 1;
    public static final int SRC_HISTORY = 2;
    public static final int SRC_ONLINE = 3;

    /** 一条候选。{@code sub} 是第二行小字（网址或来源说明）。 */
    public static final class Item {
        public final String title;
        public final String url;
        public final String sub;
        public final int source;

        public Item(String title, String url, String sub, int source) {
            this.title = title;
            this.url = url;
            this.sub = sub;
            this.source = source;
        }
    }

    private OmniSuggest() {
    }

    /**
     * 本地候选：书签 + 历史，按匹配度排序并按网址去重。
     *
     * <p>中文名称靠**标题子串**命中（「知乎」命中「知乎 - 有问题就会有答案」），
     * 不要求从词首开始 —— 中文没有词边界，前缀匹配会漏掉太多。
     */
    public static List<Item> fromLocal(String query,
                                       List<BookmarkStore.Bookmark> bookmarks,
                                       List<HistoryStore.Entry> history,
                                       int limit) {
        String q = normQuery(query);
        if (q.isEmpty() || limit <= 0) return new ArrayList<>();

        Map<String, Integer> score = new LinkedHashMap<>();
        Map<String, Item> best = new LinkedHashMap<>();

        if (bookmarks != null) {
            for (BookmarkStore.Bookmark b : bookmarks) {
                if (b == null) continue;
                int s = scoreOf(q, b.title, b.url, 300);
                if (s <= 0) continue;
                // 书签之间的比较：标题短的更像目标（「知乎」比「知乎 - 有问题就会有答案 - 某某频道」准）
                s += Math.max(0, 40 - shortLen(b.title));
                put(score, best, b.url, s, new Item(
                    text(b.title, b.url), b.url, "书签", SRC_BOOKMARK));
            }
        }
        if (history != null) {
            for (HistoryStore.Entry h : history) {
                if (h == null) continue;
                int s = scoreOf(q, h.title, h.url, 200);
                if (s <= 0) continue;
                // 去过多次的更像常用站点；上限 10 次，免得一个高频页压掉所有别的结果
                s += Math.min(h.visits, 10) * 2;
                put(score, best, h.url, s, new Item(
                    text(h.title, h.url), h.url, "历史", SRC_HISTORY));
            }
        }

        List<Item> out = new ArrayList<>(best.values());
        Collections.sort(out, new Comparator<Item>() {
            @Override
            public int compare(Item a, Item b) {
                Integer sa = score.get(BookmarkImport.norm(a.url));
                Integer sb = score.get(BookmarkImport.norm(b.url));
                int d = (sb == null ? 0 : sb) - (sa == null ? 0 : sa);
                if (d != 0) return d;
                return a.title.compareTo(b.title);
            }
        });
        if (out.size() > limit) out = new ArrayList<>(out.subList(0, limit));
        return out;
    }

    /**
     * 联网补全的结果（只有查询词，没有网址）→ 候选行。
     * 点这些行是「拿这个词去搜」，所以 url 字段留空，由调用方用搜索模板生成。
     */
    public static List<Item> fromOnline(String query, List<String> suggestions, int limit) {
        List<Item> out = new ArrayList<>();
        String q = normQuery(query);
        if (suggestions == null || limit <= 0) return out;
        for (String s : suggestions) {
            if (s == null) continue;
            String t = s.trim();
            if (t.isEmpty()) continue;
            if (normQuery(t).equals(q)) continue;      // 和输入一模一样的那条没有信息量
            out.add(new Item(t, null, "搜索建议", SRC_ONLINE));
            if (out.size() >= limit) break;
        }
        return out;
    }

    /**
     * 解析搜索引擎的补全响应。两种形态都认：
     * <pre>
     *   必应 / Google ：["输入的词",["建议1","建议2"]]
     *   百度 sugrec  ：{"q":"输入的词","g":[{"type":"sug","q":"建议1"},…]}
     * </pre>
     * 解析失败一律返回空表 —— 联想挂了不该影响打字。
     */
    public static List<String> parseSuggest(String body) {
        List<String> out = new ArrayList<>();
        if (body == null) return out;
        String s = body.trim();
        if (s.isEmpty()) return out;

        if (s.charAt(0) == '{') {
            // 百度：所有 "q":"..." 里，第一条是回显的输入，后面才是建议
            int from = 0;
            boolean first = true;
            while (true) {
                int k = indexOfIgnoreCase(s, "\"q\"", from);
                if (k < 0) break;
                int colon = s.indexOf(':', k + 3);
                if (colon < 0) break;
                int q = nextQuote(s, colon + 1);
                if (q < 0) break;
                int end = endOfString(s, q);
                if (end < 0) break;
                String v = jsonString(s, q);
                from = end + 1;            // 从这条字符串**之后**继续，否则会重读同一个值
                if (v == null) continue;
                if (first) { first = false; continue; }
                out.add(v);
            }
            return out;
        }

        if (s.charAt(0) == '[') {
            // 必应 / Google：把数组里所有字符串按顺序取出来，第一条是回显
            int from = 0;
            boolean first = true;
            while (true) {
                int q = nextQuote(s, from);
                if (q < 0) break;
                int end = endOfString(s, q);
                if (end < 0) break;
                String v = jsonString(s, q);
                from = end + 1;
                if (v == null) continue;
                if (first) { first = false; continue; }
                out.add(v);
            }
            return out;
        }
        return out;
    }

    /** 输入看起来是不是一个网址（决定第一行写「前往」还是「搜索」）。与 NovaSettings 的判断口径一致。 */
    public static boolean looksLikeUrl(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return false;
        if (s.matches("^[a-zA-Z][a-zA-Z0-9+.\\-]*:.*")) return true;
        return !s.contains(" ") && s.matches("^[^\\s/]+\\.[^\\s/]{2,}.*");
    }

    // ------------------------------------------------------------ 内部

    /** 标题/网址同时参与匹配；一个都不命中就返回 0。 */
    private static int scoreOf(String q, String title, String url, int base) {
        String t = title == null ? "" : title.toLowerCase(Locale.ROOT);
        String u = url == null ? "" : url.toLowerCase(Locale.ROOT);
        if (t.isEmpty() && u.isEmpty()) return 0;
        int s = 0;
        if (!t.isEmpty() && t.contains(q)) {
            s = base;
            if (t.startsWith(q)) s += 60;
            if (t.equals(q)) s += 40;
        }
        if (!u.isEmpty() && u.contains(q)) {
            // 网址命中次之：搜「zhihu」时 zhihu.com 该排前面，但标题命中更贴近意图
            s = Math.max(s, base - 40);
            String host = hostOf(u);
            if (host.startsWith(q) || host.startsWith("www." + q)) s += 30;
        }
        return s;
    }

    private static void put(Map<String, Integer> score, Map<String, Item> best,
                            String url, int s, Item item) {
        String k = BookmarkImport.norm(url);
        if (k.isEmpty()) return;
        Integer old = score.get(k);
        if (old == null || s > old) {
            score.put(k, s);
            best.put(k, item);
        }
    }

    private static String text(String title, String url) {
        String t = title == null ? "" : title.trim();
        return t.isEmpty() ? (url == null ? "" : url) : t;
    }

    private static int shortLen(String s) {
        return s == null ? 0 : Math.min(40, s.length());
    }

    static String normQuery(String q) {
        return q == null ? "" : q.trim().toLowerCase(Locale.ROOT);
    }

    static String hostOf(String url) {
        int i = url.indexOf("://");
        String rest = i < 0 ? url : url.substring(i + 3);
        int slash = rest.indexOf('/');
        return slash < 0 ? rest : rest.substring(0, slash);
    }

    private static int indexOfIgnoreCase(String hay, String needle, int from) {
        int n = needle.length();
        for (int i = Math.max(0, from); i + n <= hay.length(); i++) {
            if (hay.regionMatches(true, i, needle, 0, n)) return i;
        }
        return -1;
    }

    private static int nextQuote(String s, int from) {
        for (int i = Math.max(0, from); i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') return i;
            if (c == '}' || c == ']') return -1;
        }
        return -1;
    }

    /**
     * 从引号位置往后找**这条字符串的结束引号**，跳过 {@code \"} 这类转义。
     *
     * <p>不能拿 {@code quote + 1 + value.length()} 去推算结束位置：值里有转义时
     * （比如 {@code \"} 源码 2 个字符、解出来 1 个），推算会落在字符串中间，
     * 下一次又从同一个引号接着读 —— 结果就是同一条建议被重复收进来。
     */
    private static int endOfString(String s, int quoteIndex) {
        for (int i = quoteIndex + 1; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\') { i++; continue; }
            if (c == '"') return i;
        }
        return -1;
    }

    private static String jsonString(String s, int quoteIndex) {
        StringBuilder sb = new StringBuilder();
        for (int i = quoteIndex + 1; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') return sb.toString();
            if (c != '\\') { sb.append(c); continue; }
            if (i + 1 >= s.length()) return null;
            char e = s.charAt(++i);
            switch (e) {
                case '"': sb.append('"'); break;
                case '\\': sb.append('\\'); break;
                case '/': sb.append('/'); break;
                case 'n': sb.append('\n'); break;
                case 'r': sb.append('\r'); break;
                case 't': sb.append('\t'); break;
                case 'u':
                    if (i + 4 >= s.length()) return null;
                    try {
                        sb.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16));
                    } catch (NumberFormatException ex) {
                        return null;
                    }
                    i += 4;
                    break;
                default: sb.append(e); break;
            }
        }
        return null;
    }
}
