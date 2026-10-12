package top.wuai.nova;

import org.junit.Test;

import java.io.File;
import java.nio.file.Files;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * BookmarkStore 是纯 JVM 类（只碰 File 和 org.json），不依赖 Android 框架，
 * 所以这里直接用临时目录跑，不需要 Robolectric。
 */
public class BookmarkStoreTest {

    private BookmarkStore store() throws Exception {
        File dir = Files.createTempDirectory("bm-test").toFile();
        return new BookmarkStore(dir);
    }

    @Test
    public void 新增后能查到且倒序() throws Exception {
        BookmarkStore s = store();
        assertTrue(s.add("https://a.com", "A站"));
        assertTrue(s.isBookmarked("https://a.com"));

        List<BookmarkStore.Bookmark> list = s.list();
        assertEquals(1, list.size());
        assertEquals("https://a.com", list.get(0).url);
    }

    @Test
    public void 空url不收() throws Exception {
        BookmarkStore s = store();
        assertFalse(s.add("", "空"));
        assertFalse(s.add(null, "空"));
        assertEquals(0, s.list().size());
    }

    @Test
    public void 同url不重复() throws Exception {
        BookmarkStore s = store();
        assertTrue(s.add("https://dup.com", "第一次"));
        assertFalse(s.add("https://dup.com", "第二次")); // 返回 false = 没新加
        assertEquals(1, s.list().size());
    }

    @Test
    public void 删除后查不到() throws Exception {
        BookmarkStore s = store();
        s.add("https://x.com", "X");
        s.remove("https://x.com");
        assertFalse(s.isBookmarked("https://x.com"));
        assertEquals(0, s.list().size());
    }

    @Test
    public void 清空后为空() throws Exception {
        BookmarkStore s = store();
        s.add("https://a.com", "A");
        s.add("https://b.com", "B");
        s.clear();
        assertEquals(0, s.list().size());
    }

    @Test
    public void 后加的排在最前() throws Exception {
        BookmarkStore s = store();
        s.add("https://a.com", "A");
        s.add("https://b.com", "B");
        List<BookmarkStore.Bookmark> list = s.list();
        assertEquals(2, list.size());
        assertEquals("https://b.com", list.get(0).url); // 最新的在最前
        assertEquals("https://a.com", list.get(1).url);
    }

    @Test
    public void 损坏文件不崩() throws Exception {
        // 写一个坏 JSON，list() 应退回空列表而不是抛异常。
        File dir = Files.createTempDirectory("bm-bad").toFile();
        File f = new File(dir, "bookmarks.json");
        java.nio.file.Files.write(f.toPath(), "这不是json{".getBytes("UTF-8"));
        BookmarkStore s = new BookmarkStore(dir);
        assertEquals(0, s.list().size());
    }

    @Test
    public void 落盘后可重新读回() throws Exception {
        File dir = Files.createTempDirectory("bm-persist").toFile();
        BookmarkStore s1 = new BookmarkStore(dir);
        s1.add("https://keep.com", "留存");
        BookmarkStore s2 = new BookmarkStore(dir); // 新实例，从同一文件读
        assertEquals(1, s2.list().size());
        assertEquals("留存", s2.list().get(0).title);
    }
}
