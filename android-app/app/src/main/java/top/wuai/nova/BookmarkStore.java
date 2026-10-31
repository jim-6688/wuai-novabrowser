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

    /** 导入用的一条草稿：只有标题和网址，id / 时间戳由存储层补。 */
    public static final class Draft {
        public final String url;
        public final String title;
        public Draft(String url, String title) {
            this.url = url;
            this.title = title;
        }
    }

    /**
     * 批量收藏（导入用）。<b>只落一次盘</b> —— 逐条调 {@link #add} 会读一遍写一遍，
     * 导入几百条就是几百次全量重写。
     *
     * <p>已存在的（同 url，按 {@link BookmarkImport#norm} 归一化）跳过，不算新增。
     *
     * @return 真正新增的条数
     */
    public int addAll(List<Draft> items) {
        if (items == null || items.isEmpty()) return 0;
        List<Bookmark> ordered = list();
        Collections.reverse(ordered); // 存盘正序，翻回来再追加
        java.util.Set<String> have = new java.util.HashSet<>();
        for (Bookmark b : ordered) have.add(BookmarkImport.norm(b.url));
        int added = 0;
        long now = System.currentTimeMillis();
        for (Draft d : items) {
            if (d == null) continue;
            String url = d.url == null ? "" : d.url.trim();
            if (url.isEmpty()) continue;
            if (!have.add(BookmarkImport.norm(url))) continue;
            String id = "bm_" + Long.toHexString((url + "|" + (now + added)).hashCode());
            String title = (d.title == null || d.title.trim().isEmpty()) ? url : d.title.trim();
            ordered.add(new Bookmark(id, title, url, now + added));
            added++;
        }
        if (added > 0) save(ordered);
        return added;
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

    /** 改一条书签的结果。界面按它决定提示什么。 */
    public enum Update { OK, MISSING, DUP }

    /**
     * 改一条书签的标题 / 网址。
     *
     * <p>按<b>原网址</b>定位 —— 因为网址本身可能就是被改的那一项。
     * id 与 addedAt 保持不变：这条收藏还是同一条，只是写法变了，
     * 重新生成 id 会让「按时间排序」把它挪到最后。
     *
     * <p>改成另一条已经收藏的网址时返回 {@link Update#DUP}，<b>不合并</b>：
     * 悄悄删掉一条会让用户以为自己改坏了东西，而「这个网址已经在收藏里」
     * 是他能理解、也能自己处理的一句话。
     */
    public Update update(String oldUrl, String newTitle, String newUrl) {
        if (oldUrl == null || oldUrl.isEmpty()) return Update.MISSING;
        List<Bookmark> ordered = list();
        Collections.reverse(ordered); // 存盘是正序
        int at = -1;
        for (int i = 0; i < ordered.size(); i++) {
            if (ordered.get(i).url.equals(oldUrl)) { at = i; break; }
        }
        if (at < 0) return Update.MISSING;

        Bookmark old = ordered.get(at);
        String url = (newUrl == null || newUrl.trim().isEmpty()) ? old.url : newUrl.trim();
        if (!url.equals(old.url)) {
            String norm = BookmarkImport.norm(url);
            for (int i = 0; i < ordered.size(); i++) {
                if (i != at && BookmarkImport.norm(ordered.get(i).url).equals(norm)) {
                    return Update.DUP;
                }
            }
        }
        // 标题留空就退回网址本身 —— 与 add() 的口径一致，列表里不会出现空白行。
        String title = (newTitle == null || newTitle.trim().isEmpty()) ? url : newTitle.trim();
        ordered.set(at, new Bookmark(old.id, title, url, old.addedAt));
        save(ordered);
        return Update.OK;
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
