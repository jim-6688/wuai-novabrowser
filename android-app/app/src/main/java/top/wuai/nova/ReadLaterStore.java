package top.wuai.nova;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 「稍后读」的存储层。刻意与 {@link BookmarkStore} 同一套设计：不依赖 Android 框架、
 * 也不依赖 org.json（单元测试里 org.json 是桩，构造即返回 null，会静默吞掉写入），
 * 落盘就是 {@code <dir>/readlater.json} 一个行式文件，字段用 U+001F 分隔。
 *
 * <p>每条记录是「网址 + 标题 + 加入时间」。比书签多一个时间戳，是因为「稍后读」天然
 * 按加入顺序排列，最近加的排在最前最符合直觉。
 *
 * <p>损坏不抛异常（最多丢几条），因为数据丢了不该拖垮整个浏览器。
 * 复用 {@link NovaStore#readLines} / {@link NovaStore#writeText}。
 */
public final class ReadLaterStore {

    /** 字段分隔符：U+001F，正常文本里不会出现。用码点构造，避免源码里出现控制字符。 */
    private static final String SEP = String.valueOf((char) 0x1F);

    /** 一条「稍后读」。纯数据，没有行为。 */
    public static final class Item {
        public final String url;
        public final String title;
        public final long addedAt;
        public Item(String url, String title, long addedAt) {
            this.url = url;
            this.title = title;
            this.addedAt = addedAt;
        }
    }

    private final File file;

    public ReadLaterStore(File dir) {
        this.file = new File(dir, "readlater.json");
    }

    /**
     * 全部「稍后读」，按加入时间倒序（最新在最前）。
     * 存盘按正序（新加在末尾），这里翻一下方便列表从新到旧展示。
     */
    public List<Item> list() {
        List<Item> out = new ArrayList<>();
        if (!file.exists()) return out;
        try {
            for (String line : NovaStore.readLines(file)) {
                if (line.isEmpty()) continue;
                String[] p = line.split(SEP, -1);
                if (p.length < 3) continue;
                long t;
                try { t = Long.parseLong(p[2]); } catch (NumberFormatException e) { t = 0; }
                out.add(new Item(p[0], p[1], t));
            }
        } catch (Exception e) {
            return new ArrayList<>();
        }
        Collections.reverse(out);
        return out;
    }

    /** 当前 url 是否已在「稍后读」里。 */
    public boolean contains(String url) {
        if (url == null || url.isEmpty()) return false;
        for (Item it : list()) {
            if (it.url.equals(url)) return true;
        }
        return false;
    }

    /**
     * 加入一条。已存在（同 url）则不动，避免重复。
     * 返回是否是「新加的」—— 调用方靠这个决定弹「已加入」还是「已在列表中」。
     */
    public boolean add(String url, String title) {
        if (url == null || url.isEmpty()) return false;
        if (contains(url)) return false;
        List<Item> ordered = list();
        Collections.reverse(ordered); // 存盘是正序，翻回正序再追加
        ordered.add(new Item(url,
            (title == null || title.trim().isEmpty()) ? url : title.trim(),
            System.currentTimeMillis()));
        save(ordered);
        return true;
    }

    /** 移除一条（按 url）。 */
    public void remove(String url) {
        if (url == null || url.isEmpty()) return;
        List<Item> ordered = list();
        Collections.reverse(ordered);
        List<Item> kept = new ArrayList<>();
        for (Item it : ordered) {
            if (!it.url.equals(url)) kept.add(it);
        }
        if (kept.size() != ordered.size()) save(kept);
    }

    /** 清空全部。 */
    public void clear() {
        if (file.exists()) file.delete();
    }

    private void save(List<Item> ordered) {
        try {
            StringBuilder sb = new StringBuilder();
            for (Item it : ordered) {
                String title = sanitize(it.title);
                String url = sanitize(it.url);
                // 顺序：url SEP title SEP addedAt
                sb.append(url).append(SEP)
                  .append(title).append(SEP)
                  .append(it.addedAt).append('\n');
            }
            NovaStore.writeText(file, sb.toString());
        } catch (Exception e) {
            // 写失败不抛：数据丢了不该拖垮整个浏览器。
        }
    }

    /** 去掉分隔符和换行，避免一条记录被拆成多行或字段错位。 */
    private static String sanitize(String s) {
        if (s == null) return "";
        return s.replace('\n', ' ').replace('\r', ' ').replace((char) 0x1F, ' ').trim();
    }
}
