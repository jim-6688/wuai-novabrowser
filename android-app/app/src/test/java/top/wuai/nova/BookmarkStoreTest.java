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

    @Test
    public void 批量导入只加新的() throws Exception {
        BookmarkStore s = store();
        s.add("https://have.com", "已有");

        java.util.List<BookmarkStore.Draft> drafts = new java.util.ArrayList<>();
        drafts.add(new BookmarkStore.Draft("https://have.com/", "重复的（带斜杠）"));
        drafts.add(new BookmarkStore.Draft("https://new1.com", "新的1"));
        drafts.add(new BookmarkStore.Draft("https://new2.com", "新的2"));
        drafts.add(new BookmarkStore.Draft("https://new2.com", "文件内重复"));

        // 返回真正新增的条数，不是传进去的条数
        assertEquals(2, s.addAll(drafts));
        assertEquals(3, s.list().size());
    }

    @Test
    public void 批量导入空标题用网址顶上() throws Exception {
        BookmarkStore s = store();
        java.util.List<BookmarkStore.Draft> drafts = new java.util.ArrayList<>();
        drafts.add(new BookmarkStore.Draft("https://notitle.com", "   "));
        assertEquals(1, s.addAll(drafts));
        assertEquals("https://notitle.com", s.list().get(0).title);
    }

    @Test
    public void 批量导入空列表不动盘() throws Exception {
        BookmarkStore s = store();
        assertEquals(0, s.addAll(new java.util.ArrayList<>()));
        assertEquals(0, s.addAll(null));
        assertEquals(0, s.list().size());
    }

    // ---------------------------------------------------------------- 编辑

    @Test
    public void 改标题与网址后落盘且id不变() throws Exception {
        File dir = Files.createTempDirectory("bm-edit").toFile();
        BookmarkStore s = new BookmarkStore(dir);
        s.add("https://old.test/a", "旧标题");
        String id = s.list().get(0).id;
        long at = s.list().get(0).addedAt;

        assertEquals(BookmarkStore.Update.OK,
            s.update("https://old.test/a", "新标题", "https://new.test/b"));

        // 新实例从同一文件读回，确认真的写盘了（不是只改了内存）
        BookmarkStore again = new BookmarkStore(dir);
        List<BookmarkStore.Bookmark> l = again.list();
        assertEquals(1, l.size());
        assertEquals("新标题", l.get(0).title);
        assertEquals("https://new.test/b", l.get(0).url);
        // id 与加入时间保持不变：这条还是同一条，排序不该因此改动
        assertEquals(id, l.get(0).id);
        assertEquals(at, l.get(0).addedAt);
    }

    @Test
    public void 标题留空回退成网址() throws Exception {
        BookmarkStore s = store();
        s.add("https://a.test/", "原标题");
        assertEquals(BookmarkStore.Update.OK, s.update("https://a.test/", "   ", null));
        assertEquals("https://a.test/", s.list().get(0).title);
    }

    @Test
    public void 改成另一条已收藏的网址会被拒绝() throws Exception {
        BookmarkStore s = store();
        s.add("https://a.test/", "A");
        s.add("https://b.test/", "B");
        // 带不带尾斜杠算同一个网址（与导入去重同一套归一化）
        assertEquals(BookmarkStore.Update.DUP,
            s.update("https://a.test/", "A", "https://b.test/"));
        assertEquals(2, s.list().size());
        // 想改的那条还是原样
        boolean stillOld = false;
        for (BookmarkStore.Bookmark b : s.list()) {
            if (b.url.equals("https://a.test/")) stillOld = true;
        }
        assertTrue(stillOld);
    }

    @Test
    public void 改不存在的条目返回MISSING() throws Exception {
        BookmarkStore s = store();
        s.add("https://a.test/", "A");
        assertEquals(BookmarkStore.Update.MISSING, s.update("https://nope.test/", "x", null));
        assertEquals(BookmarkStore.Update.MISSING, s.update(null, "x", null));
        assertEquals(1, s.list().size());
    }
}
