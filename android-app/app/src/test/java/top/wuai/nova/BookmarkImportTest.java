package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.Test;

/**
 * 导入书签的单测。
 *
 * <p>这段逻辑唯一的失败方式是「把用户的书签弄丢或弄脏」，所以测的重点不是
 * 「能不能解析」，而是几件容易悄悄错的事：<b>标题里的 HTML 实体</b>、
 * <b>文件内重复</b>、<b>javascript: 这类假地址</b>、<b>归一化后被误判成重复</b>。
 */
public class BookmarkImportTest {

    /** Chrome「导出书签」的真实形态（含工具栏文件夹、ICON 的 base64、实体）。 */
    private static final String CHROME_HTML =
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n"
            + "<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n"
            + "<TITLE>Bookmarks</TITLE>\n"
            + "<H1>Bookmarks</H1>\n"
            + "<DL><p>\n"
            + "    <DT><H3 ADD_DATE=\"1690000000\" PERSONAL_TOOLBAR_FOLDER=\"true\">书签栏</H3>\n"
            + "    <DL><p>\n"
            + "        <DT><A HREF=\"https://www.example.com/\" ADD_DATE=\"1690000000\" "
            + "ICON=\"data:image/png;base64,iVBORw0KGgo=\">示例 &amp; 站点</A>\n"
            + "        <DT><A HREF=\"https://a.test/path?x=1&amp;y=2\">带参数</A>\n"
            + "    </DL><p>\n"
            + "</DL><p>\n";

    @Test
    public void 解析Chrome导出的HTML() {
        BookmarkImport.Parsed p = BookmarkImport.parse(CHROME_HTML);
        assertTrue(p.ok());
        assertEquals(2, p.items.size());
        assertEquals("https://www.example.com/", p.items.get(0).url);
        // 实体要解开，否则列表里会显示 "示例 &amp; 站点"
        assertEquals("示例 & 站点", p.items.get(0).title);
        // 地址里的 &amp; 也要还原，不然点开是错的
        assertEquals("https://a.test/path?x=1&y=2", p.items.get(1).url);
        // 文件夹（H3）不是书签，不该被算成一条
        assertEquals(0, p.skipped);
    }

    @Test
    public void 跳过不是网页的地址() {
        String html = "<DL><p>"
            + "<DT><A HREF=\"javascript:alert(1)\">收藏夹小工具</A>"
            + "<DT><A HREF=\"place:type=6&amp;sort=14\">最近使用的标签</A>"
            + "<DT><A HREF=\"https://ok.test/\">正常</A>"
            + "</DL>";
        BookmarkImport.Parsed p = BookmarkImport.parse(html);
        assertTrue(p.ok());
        assertEquals(1, p.items.size());
        assertEquals("https://ok.test/", p.items.get(0).url);
        // 被跳过要如实报数，不能装作全导入成功
        assertEquals(2, p.skipped);
    }

    @Test
    public void 文件内重复只收一条() {
        String html = "<DT><A HREF=\"https://dup.test/\">一</A>"
            + "<DT><A HREF=\"https://dup.test/\">二</A>"
            + "<DT><A HREF=\"https://dup.test\">三</A>";   // 末尾斜杠差异也算同一条
        BookmarkImport.Parsed p = BookmarkImport.parse(html);
        assertTrue(p.ok());
        assertEquals(1, p.items.size());
    }

    @Test
    public void 属性用单引号也认() {
        String html = "<DT><A HREF='https://single.test/x'>单引号</A>";
        BookmarkImport.Parsed p = BookmarkImport.parse(html);
        assertTrue(p.ok());
        assertEquals(1, p.items.size());
        assertEquals("https://single.test/x", p.items.get(0).url);
    }

    @Test
    public void 没有标题时用网址顶上() {
        String html = "<DT><A HREF=\"https://notitle.test/\"></A>";
        BookmarkImport.Parsed p = BookmarkImport.parse(html);
        assertTrue(p.ok());
        assertEquals("https://notitle.test/", p.items.get(0).title);
    }

    @Test
    public void 标题里的标签会被剥掉只留文字() {
        String html = "<DT><A HREF=\"https://rich.test/\"><b>粗</b>体 &lt;标题&gt;</A>";
        BookmarkImport.Parsed p = BookmarkImport.parse(html);
        assertEquals("粗体 <标题>", p.items.get(0).title);
    }

    @Test
    public void 解析自家JSON信封() {
        String json = "{\"format\":\"nova-bookmarks\",\"version\":1,\"count\":2,\"items\":["
            + "{\"title\":\"中文 & 标题\",\"url\":\"https://j1.test/\"},"
            + "{\"title\":\"说\\\"引号\\\"\",\"url\":\"https://j2.test/?a=1\\u0026b=2\"}]}";
        BookmarkImport.Parsed p = BookmarkImport.parse(json);
        assertTrue(p.ok());
        assertEquals(2, p.items.size());
        assertEquals("中文 & 标题", p.items.get(0).title);
        assertEquals("https://j2.test/?a=1&b=2", p.items.get(1).url);
        assertEquals("说\"引号\"", p.items.get(1).title);
    }

    @Test
    public void 裸数组也认() {
        String json = "[{\"title\":\"甲\",\"url\":\"https://arr1.test/\"},"
            + "{\"title\":\"乙\",\"url\":\"https://arr2.test/\"}]";
        BookmarkImport.Parsed p = BookmarkImport.parse(json);
        assertTrue(p.ok());
        assertEquals(2, p.items.size());
        assertEquals("https://arr2.test/", p.items.get(1).url);
    }

    @Test
    public void 空文件与垃圾内容要给出理由() {
        assertFalse(BookmarkImport.parse("").ok());
        assertFalse(BookmarkImport.parse("   \n  ").ok());
        BookmarkImport.Parsed junk = BookmarkImport.parse("这不是书签，是一段话");
        assertFalse(junk.ok());
        assertNotNull(junk.error);
    }

    @Test
    public void 合并且去重() {
        List<String> existing = Arrays.asList("https://have.test/", "https://have2.test");
        List<BookmarkImport.Entry> incoming = new ArrayList<>();
        incoming.add(new BookmarkImport.Entry("已有", "https://have.test"));      // 末尾斜杠差异 → 重复
        incoming.add(new BookmarkImport.Entry("新的", "https://new.test/"));
        incoming.add(new BookmarkImport.Entry("也有", "https://have2.test/"));    // 同上 → 重复

        BookmarkImport.Merge m = BookmarkImport.merge(existing, incoming);
        assertEquals(1, m.added.size());
        assertEquals("https://new.test/", m.added.get(0).url);
        assertEquals(2, m.dup);
        assertEquals(3, m.total());
    }

    @Test
    public void 合并时丢掉废地址() {
        List<BookmarkImport.Entry> incoming = new ArrayList<>();
        incoming.add(new BookmarkImport.Entry("脚本", "javascript:void(0)"));
        incoming.add(new BookmarkImport.Entry("正常", "https://keep.test/"));
        BookmarkImport.Merge m = BookmarkImport.merge(null, incoming);
        assertEquals(1, m.added.size());
        assertEquals("https://keep.test/", m.added.get(0).url);
    }

    @Test
    public void 不忽略www与协议() {
        // www.a.com 和 a.com 是两个站点；http 和 https 也是两条 —— 猜错了会吃掉用户的书签
        assertFalse(BookmarkImport.norm("https://www.a.com/").equals(BookmarkImport.norm("https://a.com/")));
        assertFalse(BookmarkImport.norm("http://a.com/").equals(BookmarkImport.norm("https://a.com/")));
        // 但末尾斜杠与空白不算区别
        assertEquals(BookmarkImport.norm("https://a.com"), BookmarkImport.norm("  https://a.com/  "));
    }

    @Test
    public void 只有斜杠差异的根地址算同一条() {
        String html = "<DT><A HREF=\"https://root.test/\">A</A>"
            + "<DT><A HREF=\"https://root.test\">B</A>";
        BookmarkImport.Parsed p = BookmarkImport.parse(html);
        assertEquals(1, p.items.size());
    }

    @Test
    public void 空输入合并返回零() {
        BookmarkImport.Merge m = BookmarkImport.merge(null, null);
        assertEquals(0, m.added.size());
        assertEquals(0, m.dup);
        assertNull(m.added.isEmpty() ? null : "不该有东西");
    }
}
