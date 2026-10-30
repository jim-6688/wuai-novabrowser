package top.wuai.nova;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 从别的浏览器导入书签：解析 + 合并。
 *
 * <p>和 {@link BookmarkStore} 一样刻意写成<b>不依赖 Android 框架、也不依赖 org.json</b>
 * 的纯类 —— 单测类路径里 org.json 是 Android 的桩，构造即返回 null，
 * 用它解析会静默拿到 null 再 NPE，写成手扫反而更稳、也能在纯 JVM 里测。
 *
 * <p>认两种格式：
 * <ul>
 *   <li><b>Netscape 书签 HTML</b>：Chrome / Edge / Firefox / 360 等导出的都是这一种
 *       （{@code <DT><A HREF="..." ...>标题</A>}）。手机上这是唯一通行的路子 ——
 *       别的浏览器不把书签开放给第三方读；</li>
 *   <li><b>本产品自己的 JSON 信封</b>：{@code {"format":..., "items":[{"title","url"}]}}，
 *       也接受裸数组 {@code [{"title","url"}]}。</li>
 * </ul>
 *
 * <p>去重口径：{@link #norm} 归一化后相同的算同一条（忽略首尾空白与末尾单个斜杠）。
 * 不忽略 www.、不忽略协议 —— 那是两回事，猜错了会悄悄吃掉用户的书签。
 */
public final class BookmarkImport {

    /** 解析出来的一条。 */
    public static final class Entry {
        public final String title;
        public final String url;
        public Entry(String title, String url) {
            this.title = title;
            this.url = url;
        }
    }

    /** 解析结果：成功时 error 为 null；skipped 是被跳过的条目数（坏行、javascript: 等）。 */
    public static final class Parsed {
        public final List<Entry> items;
        public final int skipped;
        public final String error;
        private Parsed(List<Entry> items, int skipped, String error) {
            this.items = items;
            this.skipped = skipped;
            this.error = error;
        }
        public boolean ok() {
            return error == null;
        }
    }

    /** 合并结果：真正新增的条目、因重复没加的条数、以及解析阶段被跳过的条数。 */
    public static final class Merge {
        public final List<Entry> added;
        public final int dup;
        public final int skipped;
        private Merge(List<Entry> added, int dup, int skipped) {
            this.added = added;
            this.dup = dup;
            this.skipped = skipped;
        }
        public int total() {
            return added.size() + dup + skipped;
        }
    }

    private BookmarkImport() {
    }

    /**
     * 按内容猜格式并解析。
     *
     * <p>不靠文件名后缀：系统文件选择器给回来的 mime 经常是
     * {@code application/octet-stream}，后缀也可能是 .html/.htm/.json/.txt 各种写法。
     */
    public static Parsed parse(String text) {
        if (text == null || text.trim().isEmpty()) {
            return new Parsed(new ArrayList<>(), 0, "文件是空的");
        }
        String head = text.trim();
        char c = head.charAt(0);
        if (c == '{' || c == '[') {
            return parseJson(text);
        }
        // Netscape 的注释行、<!DOCTYPE>、<meta> 都在前面，所以看「有没有 <a 」比看开头更准
        if (containsIgnoreCase(text, "<a ") || containsIgnoreCase(text, "<a>")) {
            return parseNetscape(text);
        }
        return new Parsed(new ArrayList<>(), 0, "认不出这个文件的格式（既不是书签 HTML，也不是 JSON）");
    }

    // ------------------------------------------------------------ Netscape HTML

    /** 解析 Netscape 书签 HTML。文件夹结构会被压平（产品里书签就是一层列表）。 */
    public static Parsed parseNetscape(String html) {
        List<Entry> items = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        int skipped = 0;
        int from = 0;
        while (true) {
            int a = indexOfIgnoreCase(html, "<a", from);
            if (a < 0) break;
            // 必须真的是 <a 后跟空白，别把 <article>、<audio> 当成链接
            int after = a + 2;
            if (after < html.length() && !isSpace(html.charAt(after)) && html.charAt(after) != '>') {
                from = a + 2;
                continue;
            }
            int tagEnd = findTagEnd(html, after);
            if (tagEnd < 0) break;
            String href = attrValue(html.substring(a, tagEnd), "href");
            int close = indexOfIgnoreCase(html, "</a", tagEnd);
            String title = close < 0
                ? ""
                : stripTags(html.substring(tagEnd + 1, close));
            from = close < 0 ? tagEnd + 1 : close + 3;

            if (!accept(href)) {
                skipped++;
                continue;
            }
            // HREF 里同样会带实体（Chrome 把 & 写成 &amp;），不解的话点开就是错的地址
            String url = decode(href).trim();
            String t = decode(title).trim();
            if (t.isEmpty()) t = url;
            if (!seen.add(norm(url))) {
                continue;   // 同一份文件里出现两次，算一条
            }
            items.add(new Entry(t, url));
        }
        return new Parsed(items, skipped, null);
    }

    // ------------------------------------------------------------ JSON

    /**
     * 解析 JSON（自家信封或裸数组）。
     *
     * <p>不做通用 JSON 解析：只需要取出一串 {@code {"title":..., "url":...}}，
     * 手扫 {@code "url"} 这个键比引入一个解析器更短，也不用碰 org.json 那个桩。
     */
    public static Parsed parseJson(String text) {
        List<Entry> items = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        int skipped = 0;
        int from = 0;
        while (true) {
            int k = indexOfIgnoreCase(text, "\"url\"", from);
            if (k < 0) break;
            int q = text.indexOf(':', k + 5);
            if (q < 0) break;
            int v = nextQuote(text, q + 1);
            if (v < 0) { from = k + 5; skipped++; continue; }
            String url = jsonString(text, v);
            if (url == null) { from = v + 1; skipped++; continue; }
            from = v + 1;

            // 标题只在这条记录的对象范围内找：往回找最近的一个 "title"
            String title = "";
            int tKey = lastIndexOfIgnoreCase(text, "\"title\"", v);
            if (tKey >= 0 && !crossesBrace(text, tKey, v)) {
                int tq = text.indexOf(':', tKey + 7);
                if (tq >= 0 && tq < v) {
                    int tv = nextQuote(text, tq + 1);
                    if (tv >= 0 && tv < v) {
                        String s = jsonString(text, tv);
                        if (s != null) title = s.trim();
                    }
                }
            }
            if (!accept(url)) { skipped++; continue; }
            String t = title.isEmpty() ? url : title;
            if (!seen.add(norm(url))) continue;
            items.add(new Entry(t, url));
        }
        if (items.isEmpty()) {
            return new Parsed(new ArrayList<>(), skipped, "这份 JSON 里没有找到书签（缺 url 字段？）");
        }
        return new Parsed(items, skipped, null);
    }

    // ------------------------------------------------------------ 合并

    /**
     * 把「解析出来的条目」并进已有书签。
     *
     * @param existingUrls 已有书签的 url 列表（调用方从 {@link BookmarkStore} 取）
     * @param incoming     解析结果
     */
    public static Merge merge(List<String> existingUrls, List<Entry> incoming) {
        Set<String> have = new LinkedHashSet<>();
        if (existingUrls != null) {
            for (String u : existingUrls) have.add(norm(u));
        }
        List<Entry> added = new ArrayList<>();
        int dup = 0;
        if (incoming != null) {
            for (Entry e : incoming) {
                if (e == null || !accept(e.url)) continue;
                if (!have.add(norm(e.url))) { dup++; continue; }
                added.add(e);
            }
        }
        return new Merge(added, dup, 0);
    }

    // ------------------------------------------------------------ 小工具

    /** 能不能当书签收：要有协议头，且不是脚本伪地址。 */
    static boolean accept(String url) {
        if (url == null) return false;
        String u = url.trim();
        if (u.isEmpty()) return false;
        String low = u.toLowerCase(Locale.ROOT);
        // javascript:/data:/place: 这些不是网页，收进来点了也没用
        if (low.startsWith("javascript:")
            || low.startsWith("data:")
            || low.startsWith("place:")) {
            return false;
        }
        return low.startsWith("http://") || low.startsWith("https://")
            || low.startsWith("ftp://") || low.startsWith("file://");
    }

    /** 去重用的归一化：首尾空白 + 末尾单个斜杠。其余（www、协议、大小写）按原样。 */
    static String norm(String url) {
        if (url == null) return "";
        String u = url.trim();
        if (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    private static boolean isSpace(char c) {
        return c == ' ' || c == '\t' || c == '\n' || c == '\r';
    }

    static boolean containsIgnoreCase(String hay, String needle) {
        return indexOfIgnoreCase(hay, needle, 0) >= 0;
    }

    static int indexOfIgnoreCase(String hay, String needle, int from) {
        if (hay == null || needle == null) return -1;
        int n = needle.length();
        if (n == 0) return from;
        for (int i = Math.max(0, from); i + n <= hay.length(); i++) {
            if (hay.regionMatches(true, i, needle, 0, n)) return i;
        }
        return -1;
    }

    private static int lastIndexOfIgnoreCase(String hay, String needle, int endExclusive) {
        int n = needle.length();
        for (int i = Math.min(endExclusive, hay.length()) - n; i >= 0; i--) {
            if (hay.regionMatches(true, i, needle, 0, n)) return i;
        }
        return -1;
    }

    /** 从 from 往回看这段里有没有 '{'：有说明跨到了上一条记录，标题就不该认。 */
    private static boolean crossesBrace(String s, int from, int to) {
        for (int i = from; i < to; i++) {
            if (s.charAt(i) == '{') return true;
        }
        return false;
    }

    private static int nextQuote(String s, int from) {
        for (int i = from; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') return i;
            if (c == ',' || c == '}' || c == ']') return -1;
        }
        return -1;
    }

    /** 从 tag 里取属性值，单双引号都认。 */
    static String attrValue(String tag, String name) {
        int i = indexOfIgnoreCase(tag, name, 0);
        if (i < 0) return "";
        int eq = tag.indexOf('=', i + name.length());
        if (eq < 0) return "";
        int q = eq + 1;
        while (q < tag.length() && isSpace(tag.charAt(q))) q++;
        if (q >= tag.length()) return "";
        char quote = tag.charAt(q);
        if (quote != '"' && quote != '\'') {
            int e = q;
            while (e < tag.length() && !isSpace(tag.charAt(e)) && tag.charAt(e) != '>') e++;
            return tag.substring(q, e);
        }
        int end = tag.indexOf(quote, q + 1);
        if (end < 0) return "";
        return tag.substring(q + 1, end);
    }

    /** 找当前标签的 '>'，跳过引号里的内容（ICON 的 base64 里不会有 '>'，但属性值可能是别的）。 */
    private static int findTagEnd(String s, int from) {
        char quote = 0;
        for (int i = from; i < s.length(); i++) {
            char c = s.charAt(i);
            if (quote != 0) {
                if (c == quote) quote = 0;
            } else if (c == '"' || c == '\'') {
                quote = c;
            } else if (c == '>') {
                return i;
            }
        }
        return -1;
    }

    /** 去掉标签，保留文字（{@code <b>x</b>} → {@code x}）。 */
    static String stripTags(String s) {
        StringBuilder sb = new StringBuilder();
        boolean in = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '<') { in = true; continue; }
            if (c == '>') { in = false; continue; }
            if (!in) sb.append(c);
        }
        return sb.toString();
    }

    /** 解 HTML 实体：常见命名实体 + 十进制/十六进制数字实体。 */
    static String decode(String s) {
        if (s == null || s.indexOf('&') < 0) return s == null ? "" : s;
        StringBuilder sb = new StringBuilder(s.length());
        int i = 0;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c != '&') { sb.append(c); i++; continue; }
            int semi = s.indexOf(';', i + 1);
            if (semi < 0 || semi - i > 10) { sb.append(c); i++; continue; }
            String ent = s.substring(i + 1, semi);
            String rep = entity(ent);
            if (rep == null) { sb.append(c); i++; continue; }
            sb.append(rep);
            i = semi + 1;
        }
        return sb.toString();
    }

    private static String entity(String ent) {
        if (ent.isEmpty()) return null;
        switch (ent.toLowerCase(Locale.ROOT)) {
            case "amp": return "&";
            case "lt": return "<";
            case "gt": return ">";
            case "quot": return "\"";
            case "apos": return "'";
            case "nbsp": return " ";
            default: break;
        }
        try {
            if (ent.charAt(0) == '#') {
                int cp = ent.length() > 1 && (ent.charAt(1) == 'x' || ent.charAt(1) == 'X')
                    ? Integer.parseInt(ent.substring(2), 16)
                    : Integer.parseInt(ent.substring(1), 10);
                if (cp > 0 && cp <= 0x10FFFF) return new String(Character.toChars(cp));
            }
        } catch (Exception e) {
            return null;
        }
        return null;
    }

    /** 从 quoteIndex 处的引号开始读一个 JSON 字符串，处理转义。 */
    static String jsonString(String s, int quoteIndex) {
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
                case 'b': sb.append('\b'); break;
                case 'f': sb.append('\f'); break;
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
