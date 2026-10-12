package top.wuai.nova;

import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * HistoryStore 和 BookmarkStore 一样是不碰 Android 框架的纯类，
 * 所以这里直接用临时目录跑，不需要 Robolectric。
 *
 * <p>重点钉住历史跟书签不一样的那三条规矩：同网址只更新不新增、
 * 超过上限从最旧的一头删、只记 http/https。这三条都是历史这种
 * 「自己会长」的数据独有的，写错了在真机上要过很久才看得出来。
 */
public class HistoryStoreTest {

    private HistoryStore store() throws Exception {
        return new HistoryStore(Files.createTempDirectory("hi-test").toFile());
    }

    private HistoryStore store(int max) throws Exception {
        return new HistoryStore(Files.createTempDirectory("hi-test").toFile(), max);
    }

    private static boolean has(List<HistoryStore.Entry> list, String url) {
        for (HistoryStore.Entry e : list) {
            if (e.url.equals(url)) return true;
        }
        return false;
    }

    // ------------------------------------------------------------ 记录与列出

    @Test
    public void 记一条能查到() throws Exception {
        HistoryStore s = store();
        assertTrue(s.record("https://a.com", "A站"));

        List<HistoryStore.Entry> list = s.list();
        assertEquals(1, list.size());
        assertEquals("https://a.com", list.get(0).url);
        assertEquals("A站", list.get(0).title);
        assertEquals(1, list.get(0).visits);
        assertTrue(list.get(0).visitedAt > 0);
    }

    @Test
    public void 列表按最近访问倒序() throws Exception {
        HistoryStore s = store();
        s.record("https://a.com", "A");
        s.record("https://b.com", "B");
        s.record("https://c.com", "C");

        List<HistoryStore.Entry> list = s.list();
        assertEquals(3, list.size());
        assertEquals("https://c.com", list.get(0).url);
        assertEquals("https://a.com", list.get(2).url);
    }

    @Test
    public void 重新访问会顶到最前而不是新增一行() throws Exception {
        // 这是历史和书签最大的区别：来回点几下不该把列表冲成一堆副本
        HistoryStore s = store();
        s.record("https://a.com", "A");
        s.record("https://b.com", "B");
        s.record("https://a.com", "A");

        List<HistoryStore.Entry> list = s.list();
        assertEquals("不该多出一行", 2, list.size());
        assertEquals("最近访问的排最前", "https://a.com", list.get(0).url);
    }

    @Test
    public void 重复访问次数会累加() throws Exception {
        HistoryStore s = store();
        s.record("https://a.com", "A");
        s.record("https://a.com", "A");
        s.record("https://a.com", "A");
        assertEquals(3, s.list().get(0).visits);
    }

    // ---------------------------------------------------------------- 上限

    @Test
    public void 超过上限从最旧的一头删() throws Exception {
        HistoryStore s = store(3);
        s.record("https://a.com", "A");
        s.record("https://b.com", "B");
        s.record("https://c.com", "C");
        s.record("https://d.com", "D");

        List<HistoryStore.Entry> list = s.list();
        assertEquals(3, list.size());
        assertFalse("最旧的 a 应被删掉", has(list, "https://a.com"));
        assertEquals("最新的一条要在", "https://d.com", list.get(0).url);
    }

    @Test
    public void 重新访问的旧页面不会被当成最旧的裁掉() throws Exception {
        // 重新访问必须把这条挪到队尾（即「最新」），否则裁剪时
        // 用户刚看过的页面反而会因为最早存进来而被删掉 —— 那是最不该删的一条。
        HistoryStore s = store(3);
        s.record("https://a.com", "A");
        s.record("https://b.com", "B");
        s.record("https://c.com", "C");
        s.record("https://a.com", "A"); // 重新访问最旧的 a，顺序变成 b c a
        s.record("https://d.com", "D"); // 这才超限：该删 b，不是 a

        List<HistoryStore.Entry> list = s.list();
        assertEquals(3, list.size());
        assertTrue("刚访问过的 a 必须还在", has(list, "https://a.com"));
        assertFalse("b 才是最旧没再碰过的，该删它", has(list, "https://b.com"));
    }

    // ---------------------------------------------------------- 什么该记

    @Test
    public void 只记http和https() throws Exception {
        assertTrue(HistoryStore.recordable("http://a.com"));
        assertTrue(HistoryStore.recordable("https://a.com"));
        assertTrue(HistoryStore.recordable("HTTPS://A.COM"));

        // about:blank 是每个新标签的起点，记下来等于往列表里灌空页
        assertFalse(HistoryStore.recordable("about:blank"));
        // file:// 与 content:// 会把本机路径留在一份可能被截屏的列表里
        assertFalse(HistoryStore.recordable("file:///sdcard/a.html"));
        assertFalse(HistoryStore.recordable("content://media/x"));
        assertFalse(HistoryStore.recordable(null));
        assertFalse(HistoryStore.recordable(""));
    }

    @Test
    public void 不该记的地址确实一条都进不去() throws Exception {
        HistoryStore s = store();
        assertFalse(s.record("about:blank", ""));
        assertFalse(s.record("file:///a.txt", "本地"));
        assertEquals(0, s.list().size());
    }

    // ------------------------------------------------------------ 标题回落

    @Test
    public void 没标题时退回网址而不是留空() throws Exception {
        // 列表里总得有东西可显示，一片空白比一串网址更让人困惑
        HistoryStore s = store();
        s.record("https://a.com", null);
        s.record("https://b.com", "   ");

        List<HistoryStore.Entry> list = s.list(); // 倒序：最新在前
        assertEquals("https://b.com", list.get(0).title);
        assertEquals("https://a.com", list.get(1).title);
    }

    @Test
    public void 后来拿到标题会补上但次数不变() throws Exception {
        HistoryStore s = store();
        s.record("https://a.com", null);
        s.record("https://a.com", "真正的标题");
        assertEquals("真正的标题", s.list().get(0).title);
        assertEquals(2, s.list().get(0).visits);
    }

    // ------------------------------------------------------------ 删与清空

    @Test
    public void 删一条() throws Exception {
        HistoryStore s = store();
        s.record("https://a.com", "A");
        s.record("https://b.com", "B");
        s.remove("https://a.com");

        List<HistoryStore.Entry> list = s.list();
        assertEquals(1, list.size());
        assertEquals("https://b.com", list.get(0).url);
    }

    @Test
    public void 清空() throws Exception {
        HistoryStore s = store();
        s.record("https://a.com", "A");
        s.clear();
        assertEquals(0, s.list().size());
    }

    // -------------------------------------------------------------- 搜索

    @Test
    public void 标题和网址都能搜到且忽略大小写() throws Exception {
        HistoryStore s = store();
        s.record("https://example.com/doc", "使用说明");

        assertEquals(1, s.search("example").size());
        assertEquals(1, s.search("EXAMPLE").size());
        assertEquals(1, s.search("说明").size());
        assertEquals(0, s.search("不存在的词").size());
    }

    @Test
    public void 空关键字等于列出全部() throws Exception {
        HistoryStore s = store();
        s.record("https://a.com", "A");
        s.record("https://b.com", "B");
        assertEquals(2, s.search(null).size());
        assertEquals(2, s.search("").size());
        assertEquals(2, s.search("  ").size());
    }

    // ---------------------------------------------------------- 文件坏了

    @Test
    public void 文件损坏只丢记录不抛异常() throws Exception {
        // 上次写到一半被杀进程很常见。历史丢了不该拖垮整个浏览器。
        File dir = Files.createTempDirectory("hi-broken").toFile();
        Files.write(new File(dir, "history.json").toPath(),
            "乱码一行\n另一行乱码".getBytes(StandardCharsets.UTF_8));

        HistoryStore s = new HistoryStore(dir);
        assertEquals(0, s.list().size());
        // 坏文件之上还能继续记，不能就此废掉
        assertTrue(s.record("https://a.com", "A"));
        assertEquals(1, s.list().size());
    }

    @Test
    public void 字段不足的行会被跳过而不是错位() throws Exception {
        File dir = Files.createTempDirectory("hi-short").toFile();
        String sep = String.valueOf((char) 0x1F);
        Files.write(new File(dir, "history.json").toPath(),
            ("https://a.com" + sep + "A" + sep + "1234567890" + sep + "1\n"
                + "残缺行\n").getBytes(StandardCharsets.UTF_8));

        HistoryStore s = new HistoryStore(dir);
        List<HistoryStore.Entry> list = s.list();
        assertEquals(1, list.size());
        assertEquals("https://a.com", list.get(0).url);
        assertEquals(1234567890L, list.get(0).visitedAt);
    }

    @Test
    public void 次数写成非法值时按一次算() throws Exception {
        File dir = Files.createTempDirectory("hi-visits").toFile();
        String sep = String.valueOf((char) 0x1F);
        Files.write(new File(dir, "history.json").toPath(),
            ("https://a.com" + sep + "A" + sep + "123" + sep + "不是数字\n")
                .getBytes(StandardCharsets.UTF_8));

        HistoryStore s = new HistoryStore(dir);
        assertEquals(1, s.list().get(0).visits);
    }
}
