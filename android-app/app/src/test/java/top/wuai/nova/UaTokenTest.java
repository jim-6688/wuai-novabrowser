package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * UA 标识的单测。
 *
 * <p>这段逻辑只有一个用处：让自家站点认出「访客已经在用 Nova」，别再弹下载提示。
 * 站点是按 {@code /NovaBrowser/i} 匹配的，所以两件事必须钉死——
 * <b>标识真的被加上了</b>，以及<b>原串一个字都不能被改</b>（改了就影响站点返回的布局/功能）。
 */
public class UaTokenTest {

    private static final String MOBILE_UA =
        "Mozilla/5.0 (Linux; Android 14; PJD110 Build/UP1A.231005.007; wv) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 "
            + "Chrome/120.0.6099.230 Mobile Safari/537.36";

    @Test
    public void 标识格式对() {
        assertEquals("NovaBrowser/1.6.12", UaToken.token("1.6.12"));
        // 版本号带空白也不该把空格带进 UA
        assertEquals("NovaBrowser/1.6.12", UaToken.token(" 1.6.12 "));
        // 没有版本也别拼出 "NovaBrowser/" 这种半截标识
        assertEquals("NovaBrowser/0", UaToken.token(null));
        assertEquals("NovaBrowser/0", UaToken.token(""));
    }

    @Test
    public void 追加后原串完整保留() {
        String out = UaToken.append(MOBILE_UA, "1.6.12");
        assertEquals(MOBILE_UA + " NovaBrowser/1.6.12", out);
        // 关键子串一个不少 —— 站点靠它们返回手机布局
        assertTrue(out.contains("Mobile"));
        assertTrue(out.contains("Android 14"));
        assertTrue(out.contains("wv"));
        assertTrue(out.contains("Chrome/120.0.6099.230"));
        // 标识在末尾，不影响前面任何 token 的位置
        assertTrue(out.endsWith(" NovaBrowser/1.6.12"));
    }

    @Test
    public void 重复调用不会叠加() {
        String once = UaToken.append(MOBILE_UA, "1.6.12");
        String twice = UaToken.append(once, "1.6.12");
        String thrice = UaToken.append(twice, "1.6.12");
        assertEquals(once, twice);
        assertEquals(once, thrice);
        assertEquals(1, countOf(thrice, "NovaBrowser/"));
    }

    @Test
    public void 版本升级时不会留下两个标识() {
        // 先加了旧版本号，升级后重新 apply 时不应出现 "NovaBrowser/1.6.11 ... NovaBrowser/1.6.12"
        String old = UaToken.append(MOBILE_UA, "1.6.11");
        String now = UaToken.append(old, "1.6.12");
        assertEquals(old, now);
        assertEquals(1, countOf(now, "NovaBrowser/"));
    }

    @Test
    public void 空UA不凭空造一个() {
        assertNull(UaToken.append(null, "1.6.12"));
        assertEquals("", UaToken.append("", "1.6.12"));
        assertEquals("   ", UaToken.append("   ", "1.6.12"));
    }

    @Test
    public void has判定与大小写无关的站点匹配兼容() {
        assertFalse(UaToken.has(null));
        assertFalse(UaToken.has(MOBILE_UA));
        // 站点用 /NovaBrowser/i，所以只要出现这个子串（哪怕大小写变了）就算认得
        assertTrue(UaToken.has(MOBILE_UA + " NovaBrowser/1.6.12"));
        assertTrue(UaToken.has("xx novabrowser/1.6.12"));
    }

    @Test
    public void 桌面UA同样会带上标识() {
        String desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        String out = UaToken.append(desktop, "1.6.12");
        assertTrue(out.startsWith(desktop));
        assertTrue(out.endsWith("NovaBrowser/1.6.12"));
        // 桌面 UA 不该被手机标识污染
        assertFalse(out.contains("Mobile"));
    }

    @Test
    public void 常量与PC端一致() {
        // PC 端 engines.js 追加的也是 "NovaBrowser/<版本>"；两边名字不一致的话，
        // 导航站就得写两套判断。这条断言就是防止日后有人单边改掉。
        assertEquals("NovaBrowser/", UaToken.MARK);
        assertSame(UaToken.MARK, UaToken.MARK);
    }

    private static int countOf(String haystack, String needle) {
        int n = 0;
        int i = haystack.indexOf(needle);
        while (i >= 0) {
            n++;
            i = haystack.indexOf(needle, i + needle.length());
        }
        return n;
    }
}
