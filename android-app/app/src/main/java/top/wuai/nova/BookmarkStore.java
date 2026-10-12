package top.wuai.nova;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 书签（收藏）的存储层。刻意抽成<b>不依赖 Android 框架、也不依赖 org.json</b>的纯类 ——
 * 这样它能在纯 JVM 单测里直接用临时目录跑通，而不用为了测一个文件读写去引 Robolectric。
 *
 * <p>落盘就是 {@code <dir>/bookmarks.json} 一个行式文件：每行一条书签，
 * 字段用 U+001F（单位分隔符，正常文本里不会出现）分隔。不用 JSON 是因为单元测试的
 * 类路径里 org.json 是 Android 的桩，构造即返回 null，会静默 NPE 把写入吞掉
 * （调了等于没写）。行格式简单到不需要任何库就能解析，反而更稳。
 *
 * <p>损坏不抛异常（最多丢书签），因为书签丢了不该拖垮整个浏览器。
 * 复用 {@link NovaStore#readText} / {@link NovaStore#writeText}。
 */
public final class BookmarkStore {

    /** 字段分隔符：U+001F，正常文本里不会出现。用码点构造，避免源码里出现控制字符。 */
    private static final String SEP = String.valueOf((char) 0x1F);

    /** 一条书签。纯数据，没有行为。 */
    public static final class Bookmark {
        public final String id;
        public final String title;
        public final String url;
        public final long addedAt;
        public Bookmark(String id, String title, String url, long addedAt) {
            this.id = id; this.title = title; this.url = url; this.addedAt = addedAt;
        }
    }

    private final File file;

    public BookmarkStore(File dir) {
        this.file = new File(dir, "bookmarks.json");
    }

    /**
     * 全部书签，按添加时间倒序（最新在最前）。
     * 存盘按正序（新加在末尾），这里翻一下方便列表从新到旧展示。
     */
    public List<Bookmark> list() {
        List<Bookmark> out = new ArrayList<>();
        if (!file.exists()) return out;
        try {
            for (String line : NovaStore.readLines(file)) {
                if (line.isEmpty()) continue;
                String[] p = line.split(SEP, -1);
                if (p.length < 3) continue;
                long t;
                try { t = Long.parseLong(p[1]); } catch (NumberFormatException e) { t = 0; }
                out.add(new Bookmark(p[0], p[2], p[3], t));
            }
        } catch (Exception e) {
            // 文件损坏（比如上次写被中断）不能让书签功能整体崩，退回空列表。
            return new ArrayList<>();
        }
        Collections.reverse(out);
        return out;
    }

    /** 当前 url 是否已被收藏。 */
    public boolean isBookmarked(String url) {
        if (url == null || url.isEmpty()) return false;
        for (Bookmark b : list()) {
            if (b.url.equals(url)) return true;
        }
        return false;
    }

    /**
     * 收藏一条。已存在（同 url）则不动，避免重复。
     * 返回是否是「新加的」—— 调用方靠这个决定弹「已收藏」还是「已取消收藏」。
     */
    public boolean add(String url, String title) {
        if (url == null || url.isEmpty()) return false;
        if (isBookmarked(url)) return false;
        List<Bookmark> ordered = list();
        Collections.reverse(ordered); // 存盘是正序，翻回正序再追加
        String id = "bm_" + Long.toHexString(
            (url + "|" + System.currentTimeMillis()).hashCode());
        ordered.add(new Bookmark(id,
            (title == null || title.trim().isEmpty()) ? url : title.trim(),
            url, System.currentTimeMillis()));
        save(ordered);
        return true;
    }

    /** 取消收藏。按 url 删（一个 url 只会有一条）。 */
    public void remove(String url) {
        if (url == null || url.isEmpty()) return;
        List<Bookmark> ordered = list();
        Collections.reverse(ordered);
        List<Bookmark> kept = new ArrayList<>();
        for (Bookmark b : ordered) {
            if (!b.url.equals(url)) kept.add(b);
        }
        if (kept.size() != ordered.size()) save(kept);
    }

    /** 清空全部书签。 */
    public void clear() {
        if (file.exists()) file.delete();
    }

    private void save(List<Bookmark> ordered) {
        try {
            StringBuilder sb = new StringBuilder();
            for (Bookmark b : ordered) {
                String title = sanitize(b.title);
                String url = sanitize(b.url);
                // 顺序：id SEP addedAt SEP title SEP url
                sb.append(b.id).append(SEP)
                  .append(b.addedAt).append(SEP)
                  .append(title).append(SEP)
                  .append(url).append('\n');
            }
            NovaStore.writeText(file, sb.toString());
        } catch (Exception e) {
            // 写失败不抛：书签丢了不该拖垮整个浏览器。
        }
    }

    /** 去掉分隔符和换行，避免一条书签被拆成多行或字段错位。 */
    private static String sanitize(String s) {
        if (s == null) return "";
        return s.replace('\n', ' ').replace('\r', ' ').replace((char) 0x1F, ' ').trim();
    }
}
