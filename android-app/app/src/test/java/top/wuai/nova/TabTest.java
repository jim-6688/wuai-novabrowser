package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 标签页纯逻辑的单测。
 *
 * <p>只测 {@link Tab#hostOf}：标题回退与缩略图释放都依赖它，
 * 而它是唯一能离线验证的部分（{@code displayTitle} 里的 title 字段倒是纯数据，
 * 但它的规则就是「有标题用标题，没有用域名」，一行断言已经覆盖）。
 */
public class TabTest {

    @Test
    public void 取域名() {
        assertEquals("example.com", Tab.hostOf("https://example.com/a/b?c=1#d"));
        assertEquals("example.com", Tab.hostOf("http://example.com"));
        assertEquals("example.com", Tab.hostOf("https://example.com/"));
    }

    @Test
    public void 去掉用户信息() {
        // URL 里带 user:pass@ 的情况少见但真实存在，直接当域名显示会很怪
        assertEquals("example.com", Tab.hostOf("https://user:pass@example.com/a"));
    }

    @Test
    public void 去掉端口() {
        assertEquals("example.com", Tab.hostOf("http://example.com:8080/a"));
    }

    @Test
    public void 取不到域名就原样返回() {
        // data: 与 about:blank 没有 authority 段。原样返回而不是硬套「去端口」
        // 那一步 —— 后者会把 about:blank 砍成 about。
        assertEquals("about:blank", Tab.hostOf("about:blank"));
        assertEquals("javascript:void 0", Tab.hostOf("javascript:void 0"));
        assertEquals("", Tab.hostOf(null));
    }

    @Test
    public void 空authority回退整串() {
        // file:///a/b 的 authority 是空的，取不到域名就回退整串
        assertEquals("file:///a/b", Tab.hostOf("file:///a/b"));
    }

    @Test
    public void 无标题时回退域名() {
        // 标签总览是一屏并排十几个条目，一串完整 URL 会挤到换行
        Tab t = new Tab("https://example.com/a/very/long/path");
        assertEquals("example.com", t.displayTitle());
    }

    @Test
    public void 有标题就用标题() {
        Tab t = new Tab("https://example.com");
        t.title = "  吾爱Nova浏览器  ";
        assertEquals("吾爱Nova浏览器", t.displayTitle());
    }

    @Test
    public void 空白标题当没有() {
        Tab t = new Tab("https://example.com");
        t.title = "   ";
        assertEquals("example.com", t.displayTitle());
    }

    @Test
    public void 新标签没有缩略图() {
        Tab t = new Tab("https://example.com");
        assertEquals(null, t.snapshot);
        // 释放一个 null 缩略图不能抛 —— 切标签时会对每个标签都调一次
        t.releaseSnapshot();
    }

    @Test
    public void 构造时记录URL() {
        assertTrue(new Tab("https://a.test").url.equals("https://a.test"));
    }
}