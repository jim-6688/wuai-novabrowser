package top.wuai.nova;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * QA 补充：胶囊搜索框固定模板 {@link NovaSettings#NAV_52TA} 的 URL 编码，
 * 以及新增模板是否污染地址栏解析。
 *
 * <p>编码里最要命的是 {@code &}：不编成 {@code %26} 会被当成 query 分隔符，
 * 关键词在第一个 {@code &} 处被截断。其余（{@code ? = # +} 空格 emoji 中文）
 * 一并钉住，因为它们是同一段 {@code URLEncoder} 行为的边界。
 */
public class NovaSettingsCapsuleTest {

    private static final String PREFIX = "https://52ta.top/all/?q=";

    private static String build(String q) {
        return NovaSettings.NAV_52TA.build(q);
    }

    @Test
    public void 普通关键词原样拼接() {
        assertEquals(PREFIX + "nova", build("nova"));
        assertEquals(PREFIX, build(""));
    }

    @Test
    public void 和号必须被编码成百分号26否则query被截断() {
        String out = build("a&b");
        assertEquals(PREFIX + "a%26b", out);
        // 不能残留裸 &，否则浏览器会当成第二个参数
        assertFalse(out.substring(PREFIX.length()).contains("&"));
    }

    @Test
    public void 问号等号井号加号都被编码() {
        assertTrue(build("a?b").endsWith("a%3Fb"));
        assertTrue(build("k=v").endsWith("k%3Dv"));
        assertTrue(build("#frag").endsWith("%23frag"));
        assertTrue(build("C++").endsWith("C%2B%2B"));
    }

    @Test
    public void 中文被UTF8百分号编码() {
        String out = build("吾爱导航");
        assertEquals(PREFIX + "%E5%90%BE%E7%88%B1%E5%AF%BC%E8%88%AA", out);
    }

    @Test
    public void 空格不留下裸空格() {
        // URLEncoder 用 '+' 表示空格（query 串里被解读为空格），关键是绝不能出现裸空格
        String body = build("hello world").substring(PREFIX.length());
        assertFalse("不能含裸空格: " + body, body.contains(" "));
        assertTrue("应为 + 或 %20: " + body, body.contains("+") || body.contains("%20"));
    }

    @Test
    public void emoji被正确编码成四字节序列() {
        // 😀 U+1F600 → UTF-8 F0 9F 98 80 → %F0%9F%98%80
        assertTrue(build("😀").endsWith("%F0%9F%98%80"));
    }

    // ------------------------------------------------- 新增模板不得污染地址栏解析

    @Test
    public void 搜吾爱导航不会把中文标签误判成域名() {
        // 「吾爱导航」是无点号的纯中文，必须走搜索而不是被当成域名补 https://
        String out = new NovaSettings().resolveInput("吾爱导航");
        assertTrue(out.startsWith("https://www.baidu.com/s?wd="));
    }

    @Test
    public void 新增模板不影响真实域名的解析() {
        assertEquals("https://52ta.top", new NovaSettings().resolveInput("52ta.top"));
    }

    @Test
    public void 默认搜索引擎仍是百度() {
        assertEquals("baidu", new NovaSettings().searchTemplate().id);
    }
}
