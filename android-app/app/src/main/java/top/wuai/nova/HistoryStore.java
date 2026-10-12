package top.wuai.nova;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * 浏览历史的存储层。与 {@link BookmarkStore} 同一套做法：不依赖 Android 框架、
 * 也不依赖 org.json，于是能在纯 JVM 单测里拿临时目录直接跑。
 *
 * <p>落盘是 {@code <dir>/history.json} 一个行式文件，每行一条，
 * 字段用 U+001F（单位分隔符，正常文本里不会出现）分隔。理由和书签那边一样：
 * 单测类路径里 org.json 是 Android 的桩，构造即返回 null，会静默把写入吞掉。
 *
 * <p>三条和书签不同的规矩，都是历史这种数据自己带出来的：
 *
 * <ol>
 *   <li><b>同网址只更新，不新增。</b>历史是「去过哪」而不是「点过几次」，
 *       每行一个网址才看得清；重复访问只把时间推到最新、次数加一，
 *       否则来回点几下就把列表冲成同一条的副本。
 *   <li><b>有上限。</b>浏览历史会自己长，不像书签是用户一条条加的。
 *       超过上限就从最旧的那头删 —— 留着一年前的记录既占空间也没人翻。
 *   <li><b>只记 http/https。</b>{@code about:blank} 是每个新标签的起点，
 *       记下来等于往列表里灌空页；{@code file://}、{@code content://}
 *       会把本机路径留在列表里，而历史列表是要给人看、也可能被截屏分享的。
 * </ol>
 *
 * <p>损坏不抛异常（最多丢记录），因为历史丢了不该拖垮整个浏览器。
 * 复用 {@link NovaStore#readLines} / {@link NovaStore#writeText}。
 */
public final class HistoryStore {

    /** 字段分隔符：U+001F，正常文本里不会出现。用码点构造，避免源码里出现控制字符。 */
    private static final String SEP = String.valueOf((char) 0x1F);

    /** 默认保留条数。手机上一年翻不完，再往上留只是白占空间。 */
    public static final int DEFAULT_MAX = 500;

    /** 一条历史记录。纯数据，没有行为。 */
    public static final class Entry {
        public final String url;
        public final String title;
        public final long visitedAt;
        public final int visits;

        public Entry(String url, String title, long visitedAt, int visits) {
            this.url = url;
            this.title = title;
            this.visitedAt = visitedAt;
            this.visits = visits;
        }
    }

    private final File file;
    private final int max;

    public HistoryStore(File dir) {
        this(dir, DEFAULT_MAX);
    }

    public HistoryStore(File dir, int max) {
        this.file = new File(dir, "history.json");
        this.max = max > 0 ? max : DEFAULT_MAX;
    }

    /**
     * 这个网址值不值得进历史。
     *
     * <p>只有 http/https 算数：{@code about:blank} 是新标签页的起点，
     * 记下来就是往列表里灌空页；file:// 和 content:// 会把本机路径
     * 留在一份可能被截屏、被分享出去的列表里。
     */
    public static boolean recordable(String url) {
        if (url == null) return false;
        String s = url.trim().toLowerCase(Locale.ROOT);
        return s.startsWith("http://") || s.startsWith("https://");
    }

    /** 全部记录，按最近访问倒序（最新在最前）。 */
    public List<Entry> list() {
        List<Entry> out = readAll();
        // 存盘是时间正序（旧在前），翻一下让列表从新到旧
        Collections.reverse(out);
        return out;
    }

    /**
     * 按关键字搜，标题或网址命中即可，忽略大小写。结果按时间倒序。
     * 空关键字等价于 {@link #list()}（不给关键字时就是要看全部）。
     */
    public List<Entry> search(String keyword) {
        List<Entry> all = list();
        if (keyword == null || keyword.trim().isEmpty()) return all;
        String q = keyword.trim().toLowerCase(Locale.ROOT);
        List<Entry> out = new ArrayList<>();
        for (Entry e : all) {
            if (e.url.toLowerCase(Locale.ROOT).contains(q)) {
                out.add(e);
            } else if (e.title != null
                    && e.title.toLowerCase(Locale.ROOT).contains(q)) {
                out.add(e);
            }
        }
        return out;
    }

    /**
     * 记一次访问。同网址只更新时间与次数，不新增一行。
     *
     * @return 是否真的记下了。调用方（比如无痕模式）可以据此判断要不要提示。
     */
    public boolean record(String url, String title) {
        if (!recordable(url)) return false;
        String u = url.trim();
        List<Entry> ordered = readAll(); // 正序：旧在前
        int at = -1;
        for (int i = 0; i < ordered.size(); i++) {
            if (ordered.get(i).url.equals(u)) { at = i; break; }
        }
        long now = System.currentTimeMillis();
        if (at >= 0) {
            // 命中旧记录：只更新时间与次数，位置挪到末尾（末尾即最新）
            Entry old = ordered.get(at);
            ordered.remove(at);
            ordered.add(new Entry(u,
                pickTitle(title, old.title, u), now, old.visits + 1));
        } else {
            ordered.add(new Entry(u, pickTitle(title, null, u), now, 1));
        }
        trimToMax(ordered);
        return save(ordered);
    }

    /** 删一条。按 url 删 —— 一个 url 只会有一条。 */
    public void remove(String url) {
        if (url == null || url.isEmpty()) return;
        List<Entry> ordered = readAll();
        List<Entry> kept = new ArrayList<>();
        for (Entry e : ordered) {
            if (!e.url.equals(url)) kept.add(e);
        }
        if (kept.size() != ordered.size()) save(kept);
    }

    /** 清空全部历史。 */
    public void clear() {
        if (file.exists()) file.delete();
    }

    // ------------------------------------------------------------ 内部

    /** 超出上限就从最旧的一头删。 */
    private void trimToMax(List<Entry> ordered) {
        while (ordered.size() > max) {
            ordered.remove(0);
        }
    }

    /**
     * 标题怎么取：新给的优先，新给的为空就留着原来那个，都没有才退回网址。
     * 退回网址是因为列表里总得有东西可显示 —— 一片空白比一串网址更让人困惑。
     */
    private static String pickTitle(String fresh, String old, String url) {
        if (fresh != null && !fresh.trim().isEmpty()) return fresh.trim();
        if (old != null && !old.trim().isEmpty()) return old;
        return url;
    }

    /** 读盘，时间正序（旧在前）。文件坏了就当没有，绝不往外抛。 */
    private List<Entry> readAll() {
        List<Entry> out = new ArrayList<>();
        if (!file.exists()) return out;
        try {
            for (String line : NovaStore.readLines(file)) {
                if (line.isEmpty()) continue;
                String[] p = line.split(SEP, -1);
                // 顺序：url SEP title SEP visitedAt SEP visits
                if (p.length < 3) continue;
                long t;
                try { t = Long.parseLong(p[2]); } catch (NumberFormatException e) { t = 0; }
                int v;
                try {
                    v = p.length >= 4 ? Integer.parseInt(p[3]) : 1;
                } catch (NumberFormatException e) { v = 1; }
                if (v < 1) v = 1;
                String title = p[1].isEmpty() ? p[0] : p[1];
                out.add(new Entry(p[0], title, t, v));
            }
        } catch (Exception e) {
            // 上次写到一半被中断之类。历史丢了不该拖垮浏览器，退回空列表。
            return new ArrayList<>();
        }
        return out;
    }

    private boolean save(List<Entry> ordered) {
        try {
            StringBuilder sb = new StringBuilder();
            for (Entry e : ordered) {
                sb.append(sanitize(e.url)).append(SEP)
                  .append(sanitize(e.title)).append(SEP)
                  .append(e.visitedAt).append(SEP)
                  .append(e.visits).append('\n');
            }
            NovaStore.writeText(file, sb.toString());
            return true;
        } catch (Exception e) {
            // 写失败不抛：历史丢了不该拖垮整个浏览器。
            return false;
        }
    }

    /** 去掉分隔符和换行，避免一条记录被拆成多行或字段错位。 */
    private static String sanitize(String s) {
        if (s == null) return "";
        return s.replace('\n', ' ').replace('\r', ' ').replace((char) 0x1F, ' ').trim();
    }
}
