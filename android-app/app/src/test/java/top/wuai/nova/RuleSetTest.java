package top.wuai.nova;

import org.junit.Test;

import java.util.List;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * 拦截规则的测试。这里测的错法都很隐蔽：
 * 把 ABP 的元素隐藏规则当域名收进去，会让整站误伤；
 * 用 endsWith 匹配，会让 notexample.com 被 example.com 的规则误杀。
 */
public class RuleSetTest {

    // ------------------------------------------------------------ 单行解析

    @Test
    public void 裸域名() {
        assertEquals("ads.example.com", RuleSet.hostFrom("ads.example.com"));
    }

    @Test
    public void ABP网络规则() {
        assertEquals("ads.example.com", RuleSet.hostFrom("||ads.example.com^"));
        assertEquals("ads.example.com",
            RuleSet.hostFrom("||ads.example.com^$third-party"));
        assertEquals("ads.example.com",
            RuleSet.hostFrom("||ads.example.com^$domain=foo.com|~bar.com"));
        // 锚定根域
        assertEquals("example.com", RuleSet.hostFrom("||example.com^"));
    }

    @Test
    public void hosts格式() {
        assertEquals("ads.example.com",
            RuleSet.hostFrom("0.0.0.0 ads.example.com"));
        assertEquals("ads.example.com",
            RuleSet.hostFrom("127.0.0.1 ads.example.com"));
        assertEquals("ads.example.com",
            RuleSet.hostFrom("0.0.0.0 ads.example.com # 广告"));
    }

    @Test
    public void 纯IP的行没有域名可匹配() {
        assertNull(RuleSet.hostFrom("192.168.1.1"));
        assertNull(RuleSet.hostFrom("10.0.0.0"));
    }

    @Test
    public void 元素隐藏规则拦不了要丢掉() {
        // 移动版不注入 CSS，## 开头的规则拿它没办法
        assertNull(RuleSet.hostFrom("example.com##.ad-banner"));
        assertNull(RuleSet.hostFrom("example.com#@#.ad"));
        assertNull(RuleSet.hostFrom("example.com#?#ad"));
    }

    @Test
    public void 白名单例外要整条丢掉() {
        // 留着会让用户以为「我加了白名单」其实没有
        assertNull(RuleSet.hostFrom("@@||safe.example.com^"));
    }

    @Test
    public void 路径规则与通配规则要丢掉() {
        assertNull(RuleSet.hostFrom("||cdn.example.com/ads/"));
        assertNull(RuleSet.hostFrom("*.example.com"));
    }

    @Test
    public void 归一化() {
        assertEquals("example.com", RuleSet.hostFrom("WWW.Example.COM"));
        assertEquals("example.com", RuleSet.hostFrom("example.com."));
        assertEquals("example.com", RuleSet.hostFrom("  example.com  "));
    }

    @Test
    public void 非法域名要丢掉() {
        assertNull(RuleSet.hostFrom("exa mple.com"));
        assertNull(RuleSet.hostFrom(".example.com"));
        assertNull(RuleSet.hostFrom("localhost"));   // 单段不拦
        // 尾点是 DNS 的合法写法（example.com. 等价于 example.com），要去掉而不是丢掉
        assertEquals("example.com", RuleSet.hostFrom("example.com."));
    }

    @Test
    public void 行内注释要剥掉() {
        // hosts 格式很常见地带行尾注释，带着它走完流程必然解析失败
        assertEquals("ads.example.com", RuleSet.hostFrom("0.0.0.0 ads.example.com # 广告"));
        assertEquals("ads.example.com", RuleSet.hostFrom("||ads.example.com^# rule"));
        assertNull(RuleSet.hostFrom("# 只有注释"));
    }

    // ------------------------------------------------------------ 整份解析

    @Test
    public void 整份解析要统计跳过的条数() {
        RuleSet.ParseResult r = RuleSet.parse(RuleSet.lines(
            "# 注释",
            "",
            "||ads.a.com^",
            "0.0.0.0 ads.b.com",
            "ads.c.com",
            "example.com##.ad",
            "@@||safe.com^",
            "||cdn.com/path/"));
        assertEquals(3, r.hosts.size());
        // 跳过的是元素隐藏 + 白名单例外 + 路径规则这三条
        assertEquals(3, r.unsupported);
        assertTrue(r.ignored >= 2);
        // 样例要给界面提示用
        assertFalse(r.unsupportedSamples.isEmpty());
    }

    @Test
    public void 重复域名去重() {
        RuleSet.ParseResult r = RuleSet.parse(RuleSet.lines(
            "||ads.a.com^", "0.0.0.0 ads.a.com", "ads.a.com"));
        assertEquals(1, r.hosts.size());
    }

    @Test
    public void 空输入不抛() {
        RuleSet.ParseResult r = RuleSet.parse(null);
        assertEquals(0, r.size());
        assertEquals(0, RuleSet.parse(RuleSet.lines("")).size());
        assertEquals(0, RuleSet.parse(RuleSet.lines((String) null)).size());
    }

    @Test
    public void 整份ABP订阅能读出域名() {
        // 模拟一份真实订阅的头几行
        String text = "[Adblock Plus 2.0]\n"
            + "! Version: 20240101\n"
            + "||doubleclick.net^$third-party\n"
            + "||googlesyndication.com^\n"
            + "||adservice.google.com^\n"
            + "example.com##.ad-banner\n"
            + "||cdn.example.com/track/^$script\n"
            + "0.0.0.0 tracker.ads.net\n"
            + "0.0.0.0 metrics.ads.net";
        RuleSet.ParseResult r = RuleSet.parse(RuleSet.lines(text));
        assertEquals(5, r.hosts.size());
        assertTrue(r.hosts.contains("doubleclick.net"));
        assertTrue(r.hosts.contains("googlesyndication.com"));
        assertTrue(r.hosts.contains("adservice.google.com"));
        assertTrue(r.hosts.contains("tracker.ads.net"));
        assertTrue(r.hosts.contains("metrics.ads.net"));
        // 元素隐藏与路径规则被跳过
        assertEquals(2, r.unsupported);
    }

    // ------------------------------------------------------------ 匹配

    @Test
    public void 命中自身与父域() {
        Set<String> hosts = new java.util.HashSet<>(
            java.util.Arrays.asList("ads.example.com", "tracker.net"));
        assertTrue(RuleSet.matches(hosts, "ads.example.com"));
        assertTrue(RuleSet.matches(hosts, "www.ads.example.com"));
        assertTrue(RuleSet.matches(hosts, "a.b.ads.example.com"));
        assertTrue(RuleSet.matches(hosts, "tracker.net"));
        assertFalse(RuleSet.matches(hosts, "example.com"));
    }

    @Test
    public void 相似域名不能误杀() {
        // endsWith 会让 notexample.com 被 example.com 的规则命中，
        // 这是 Adblock 里最经典的一类误杀
        Set<String> hosts = new java.util.HashSet<>(
            java.util.Arrays.asList("example.com"));
        assertFalse(RuleSet.matches(hosts, "notexample.com"));
        assertFalse(RuleSet.matches(hosts, "myexample.com"));
        assertFalse(RuleSet.matches(hosts, "example.com.evil.net"));
        assertTrue(RuleSet.matches(hosts, "example.com"));
        assertTrue(RuleSet.matches(hosts, "www.example.com"));
    }

    @Test
    public void 匹配的各种退化输入() {
        Set<String> hosts = new java.util.HashSet<>(
            java.util.Arrays.asList("a.com"));
        assertFalse(RuleSet.matches(hosts, null));
        assertFalse(RuleSet.matches(hosts, ""));
        assertFalse(RuleSet.matches(null, "a.com"));
        assertFalse(RuleSet.matches(new java.util.HashSet<String>(), "a.com"));
        assertTrue(RuleSet.matches(hosts, "A.COM"));
        assertTrue(RuleSet.matches(hosts, "a.com."));
    }

    // ------------------------------------------------------------ 订阅地址

    @Test
    public void 只放行http地址() {
        // file:// 能读到应用私有目录，content:// 在 WebView 里会抛
        assertEquals("", RuleSet.validateUrl("https://a.com/list.txt"));
        assertEquals("", RuleSet.validateUrl("http://a.com/list.txt"));
        assertFalse(RuleSet.validateUrl("file:///data/data/x/list").isEmpty());
        assertFalse(RuleSet.validateUrl("content://x/y").isEmpty());
        assertFalse(RuleSet.validateUrl("ftp://a.com").isEmpty());
        assertFalse(RuleSet.validateUrl("").isEmpty());
        assertFalse(RuleSet.validateUrl(null).isEmpty());
        assertFalse(RuleSet.validateUrl("http://a").isEmpty());
    }

    @Test
    public void 预置订阅地址都是合法的() {
        for (RuleSet.Subscription s : RuleSet.presets()) {
            assertEquals("预置订阅地址必须能通过校验：" + s.id,
                "", RuleSet.validateUrl(s.url));
        }
    }

    // ------------------------------------------------------------ 落盘

    @Test
    public void 落盘格式自带元信息() {
        Set<String> hosts = new java.util.LinkedHashSet<>(
            java.util.Arrays.asList("a.com", "b.com"));
        List<String> lines = RuleSet.toLines(hosts, "2026-01-01 10:00",
            "https://x.com/list", 42);
        // 头几行必须把「来源 / 何时 / 跳过了多少」写清楚：
        // 这些信息没有别的地方能拿到，下次读回来就只剩一堆裸域名了
        assertTrue(lines.get(0).contains("吾爱Nova"));
        assertTrue(lines.get(1).contains("https://x.com/list"));
        assertTrue(lines.get(2).contains("2026-01-01 10:00"));
        assertTrue(lines.get(3).contains("2 条"));
        assertTrue(lines.get(3).contains("42 条"));
        // 5 行头之后才是域名，顺序必须与传入的 LinkedHashSet 一致（合并时要按序）
        assertEquals(5, lines.size() - 2);
        assertEquals("a.com", lines.get(5));
        assertEquals("b.com", lines.get(6));
    }

    @Test
    public void 切行兼容两种换行() {
        List<String> a = RuleSet.lines("a\r\nb\rc");
        assertEquals(3, a.size());
        assertEquals("b", a.get(1));
    }

    @Test
    public void 切行丢掉尾部空行() {
        // 否则解析器会把它们计成 ignored，数字对不上
        List<String> a = RuleSet.lines("a\nb\n\n\n");
        assertEquals(2, a.size());
    }
}