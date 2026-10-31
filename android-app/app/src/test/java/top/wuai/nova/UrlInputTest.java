package top.wuai.nova;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * 改收藏时的网址补齐规则。
 *
 * <p>这里锁的是「像网址就补 https://，不像就返回空」—— 一旦有人把它改成
 * 「不像就转搜索」（地址栏那套），这几条会立刻红。那正是要防的回归：
 * 收藏被悄悄改成搜索结果页，用户下次点开才发现。
 */
public class UrlInputTest {

    @Test
    public void 只写域名时补上协议() {
        assertEquals("https://zhihu.com", UrlInput.toUrl("zhihu.com"));
        assertEquals("https://www.zhihu.com", UrlInput.toUrl(" www.zhihu.com "));
        assertEquals("https://a.b.c", UrlInput.toUrl("a.b.c"));
    }

    @Test
    public void 带协议的原样保留() {
        assertEquals("http://old.test/a", UrlInput.toUrl("http://old.test/a"));
        assertEquals("https://x.test/?q=1", UrlInput.toUrl("https://x.test/?q=1"));
        assertEquals("file:///sdcard/a.html", UrlInput.toUrl("file:///sdcard/a.html"));
        // 大写协议也要认（有人从别处粘过来）
        assertEquals("HTTPS://X.TEST/", UrlInput.toUrl("HTTPS://X.TEST/"));
    }

    @Test
    public void 带端口与路径的算域名() {
        assertEquals("https://localhost:8080", UrlInput.toUrl("localhost:8080"));
        assertEquals("https://example.com:8443/a/b", UrlInput.toUrl("example.com:8443/a/b"));
    }

    @Test
    public void 不像网址的一律返回空而不是转搜索() {
        assertEquals("", UrlInput.toUrl("知乎"));
        assertEquals("", UrlInput.toUrl("吾爱浏览器"));
        assertEquals("", UrlInput.toUrl(""));
        assertEquals("", UrlInput.toUrl("   "));
        assertEquals("", UrlInput.toUrl(null));
        // 只有点、没有主机名
        assertEquals("", UrlInput.toUrl(".com"));
        assertEquals("", UrlInput.toUrl("zhihu."));
        assertEquals("", UrlInput.toUrl("a..b"));
    }

    @Test
    public void 端口不是数字时不当作主机端口() {
        // 「a:b」这种更像协议名，不是 host:port —— 不补协议
        assertEquals("", UrlInput.toUrl("a.test:http"));
    }
}
