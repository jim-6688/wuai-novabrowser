package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.Test;

/**
 * 地址栏联想的单测。
 *
 * <p>这块最容易出的错不是「能不能匹配」，而是三件更细的事：
 * <b>同一站点别出两条</b>（书签与历史各命中一次）、
 * <b>别的结果别被高频站点挤没</b>、
 * <b>联网建议解析别把回显当成建议</b>（否则第一行永远是「搜索你刚打的字」，
 * 看起来像联想坏了）。这三条各自钉一条断言。
 */
public class OmniSuggestTest {

    private static BookmarkStore.Bookmark bm(String title, String url) {
        return new BookmarkStore.Bookmark("id", title, url, 0);
    }

    private static HistoryStore.Entry hi(String title, String url, int visits) {
        return new HistoryStore.Entry(url, title, 0, visits);
    }

    @Test
    public void 中文标题命中书签并给出网址() {
        List<BookmarkStore.Bookmark> bms = Arrays.asList(
            bm("知乎 - 有问题就会有答案", "https://www.zhihu.com/"),
            bm("豆瓣电影", "https://movie.douban.com/"));
        List<OmniSuggest.Item> out = OmniSuggest.fromLocal("知乎", bms, null, 5);
        assertEquals(1, out.size());
        assertEquals("https://www.zhihu.com/", out.get(0).url);
        assertEquals(OmniSuggest.SRC_BOOKMARK, out.get(0).source);
        assertEquals("书签", out.get(0).sub);
    }

    @Test
    public void 标题短的更像目标() {
        List<BookmarkStore.Bookmark> bms = Arrays.asList(
            bm("知乎 - 有问题就会有答案 - 某某频道 - 第 3 页", "https://www.zhihu.com/a"),
            bm("知乎", "https://www.zhihu.com/"));
        List<OmniSuggest.Item> out = OmniSuggest.fromLocal("知乎", bms, null, 5);
        assertEquals(2, out.size());
        // 两条都命中，但「知乎」这条更短、分数更高，排第一
        assertEquals("https://www.zhihu.com/", out.get(0).url);
    }

    @Test
    public void 历史命中且访问多的排前() {
        // 两条标题都不是「恰好等于输入」，胜负因此由访问次数决定
        List<HistoryStore.Entry> his = Arrays.asList(
            hi("少数派 文章一", "https://sspai.com/post/1", 1),
            hi("少数派 高效工作", "https://sspai.com/post/2", 9));
        List<OmniSuggest.Item> out = OmniSuggest.fromLocal("少数派", null, his, 5);
        assertEquals(2, out.size());
        assertEquals("https://sspai.com/post/2", out.get(0).url);
        assertEquals("历史", out.get(0).sub);
    }

    @Test
    public void 标题与输入完全相同胜过访问次数() {
        // 输入「少数派」，站点标题就叫「少数派」—— 这比「去过 9 次的长标题」更明确是目标，
        // 所以访问次数不该把它挤下去。
        List<HistoryStore.Entry> his = Arrays.asList(
            hi("少数派", "https://sspai.com/", 1),
            hi("少数派 高效工作", "https://sspai.com/post/2", 9));
        List<OmniSuggest.Item> out = OmniSuggest.fromLocal("少数派", null, his, 5);
        assertEquals("https://sspai.com/", out.get(0).url);
    }

    @Test
    public void 书签优先于历史() {
        List<BookmarkStore.Bookmark> bms = Arrays.asList(bm("V2EX", "https://www.v2ex.com/"));
        List<HistoryStore.Entry> his = Arrays.asList(hi("V2EX 社区", "https://v2ex.com/t/1", 50));
        List<OmniSuggest.Item> out = OmniSuggest.fromLocal("v2ex", bms, his, 5);
        assertEquals(OmniSuggest.SRC_BOOKMARK, out.get(0).source);
    }

    @Test
    public void 同一网址只出一条() {
        // 书签与历史都命中同一个站（末尾斜杠不同）—— 只能出现一条
        List<BookmarkStore.Bookmark> bms = Arrays.asList(bm("知乎", "https://www.zhihu.com/"));
        List<HistoryStore.Entry> his = Arrays.asList(
            hi("知乎", "https://www.zhihu.com", 3),
            hi("知乎", "https://www.zhihu.com/", 8));
        List<OmniSuggest.Item> out = OmniSuggest.fromLocal("知乎", bms, his, 5);
        assertEquals(1, out.size());
        assertEquals("https://www.zhihu.com/", out.get(0).url);
    }

    @Test
    public void 网址片段也能命中() {
        List<BookmarkStore.Bookmark> bms = Arrays.asList(
            bm("某个站", "https://www.zhihu.com/question/1"));
        List<OmniSuggest.Item> out = OmniSuggest.fromLocal("zhihu", bms, null, 5);
        assertEquals(1, out.size());
        assertEquals("https://www.zhihu.com/question/1", out.get(0).url);
    }

    @Test
    public void limit生效且空输入返回空() {
        List<BookmarkStore.Bookmark> bms = new ArrayList<>();
        for (int i = 0; i < 9; i++) bms.add(bm("测试站 " + i, "https://t" + i + ".test/"));
        assertEquals(3, OmniSuggest.fromLocal("测试站", bms, null, 3).size());
        assertEquals(0, OmniSuggest.fromLocal("", bms, null, 5).size());
        assertEquals(0, OmniSuggest.fromLocal("   ", bms, null, 5).size());
        assertEquals(0, OmniSuggest.fromLocal(null, bms, null, 5).size());
    }

    @Test
    public void 一个都不命中就返回空() {
        List<BookmarkStore.Bookmark> bms = Arrays.asList(bm("豆瓣", "https://douban.com/"));
        assertEquals(0, OmniSuggest.fromLocal("知乎", bms, null, 5).size());
    }

    @Test
    public void 判断是不是网址() {
        assertTrue(OmniSuggest.looksLikeUrl("zhihu.com"));
        assertTrue(OmniSuggest.looksLikeUrl("https://a.test/x"));
        assertTrue(OmniSuggest.looksLikeUrl("ftp://a.test"));
        assertFalse(OmniSuggest.looksLikeUrl("知乎"));
        assertFalse(OmniSuggest.looksLikeUrl("hello world"));
        assertFalse(OmniSuggest.looksLikeUrl(""));
    }

    @Test
    public void 解析必应和Google的补全() {
        List<String> s = OmniSuggest.parseSuggest(
            "[\"知乎\",[\"知乎盐选\",\"知乎热榜\",\"知乎直答\"]]");
        assertEquals(3, s.size());
        assertEquals("知乎盐选", s.get(0));
        // 第一条是回显，不能当建议
        assertFalse(s.contains("知乎"));
    }

    @Test
    public void 解析百度的补全() {
        String body = "{\"q\":\"知乎\",\"g\":[{\"type\":\"sug\",\"sa\":\"\",\"q\":\"知乎热榜\"},"
            + "{\"type\":\"sug\",\"sa\":\"\",\"q\":\"知乎官网\"}]}";
        List<String> s = OmniSuggest.parseSuggest(body);
        assertEquals(2, s.size());
        assertEquals("知乎热榜", s.get(0));
        assertEquals("知乎官网", s.get(1));
    }

    @Test
    public void 补全响应是垃圾时返回空而不是崩() {
        assertEquals(0, OmniSuggest.parseSuggest(null).size());
        assertEquals(0, OmniSuggest.parseSuggest("").size());
        assertEquals(0, OmniSuggest.parseSuggest("<html>403</html>").size());
        assertEquals(0, OmniSuggest.parseSuggest("{不是json").size());
    }

    @Test
    public void 联网建议去掉与输入相同的那条() {
        List<String> raw = Arrays.asList("知乎", "知乎热榜", "知乎日报");
        List<OmniSuggest.Item> out = OmniSuggest.fromOnline("知乎", raw, 5);
        assertEquals(2, out.size());
        assertEquals("知乎热榜", out.get(0).title);
        assertEquals(OmniSuggest.SRC_ONLINE, out.get(0).source);
        // 联网行的 url 留空，由调用方套搜索模板 —— 它不是网址
        assertEquals(null, out.get(0).url);
    }

    @Test
    public void 联网建议也受limit约束() {
        List<String> raw = Arrays.asList("a1", "a2", "a3", "a4", "a5");
        assertEquals(3, OmniSuggest.fromOnline("a", raw, 3).size());
        assertEquals(0, OmniSuggest.fromOnline("a", null, 3).size());
    }

    @Test
    public void 引擎端点只给支持的三个() {
        assertTrue(SuggestClient.supported("baidu"));
        assertTrue(SuggestClient.supported("bing"));
        assertTrue(SuggestClient.supported("google"));
        // 自定义引擎没有公开补全协议，必须是「不支持」，别去猜一个地址
        assertFalse(SuggestClient.supported("custom"));
        assertFalse(SuggestClient.supported(""));
        assertFalse(SuggestClient.supported(null));
    }

    @Test
    public void 端点带正确的编码与域名() {
        String u = SuggestClient.endpoint("baidu", "知乎 测试");
        assertTrue(u.startsWith("https://www.baidu.com/sugrec"));
        assertTrue(u.contains("wd="));
        // 中文必须编码，空格编码成 %20 或 +，不能原样拼进去
        assertFalse(u.contains("知乎"));
        assertTrue(SuggestClient.endpoint("bing", "x").contains("api.bing.com"));
        assertTrue(SuggestClient.endpoint("google", "x").contains("suggestqueries.google.com"));
    }
}
