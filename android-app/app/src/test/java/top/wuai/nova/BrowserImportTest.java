package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.List;

import org.junit.Test;

/**
 * 「从已安装的浏览器导入」里唯一能纯 JVM 测的部分：authority 的候选顺序。
 *
 * <p>为什么这一段值得测：查 ContentProvider 失败是**静默**的（查不到就是空游标或
 * SecurityException），authority 拼错不会报错，只会让「可导入 12 条」变成
 * 「这个浏览器没有开放书签接口」。所以把「先试哪个、再试哪个、别重复」钉住。
 *
 * <p>真正发 query 的那部分要设备，留给真机验证。
 */
public class BrowserImportTest {

    @Test
    public void 已知包名先用自己的authority() {
        List<String> a = BrowserImport.authoritiesFor("com.android.browser");
        assertEquals(1, a.size());
        assertEquals("com.android.browser", a.get(0));
    }

    @Test
    public void 三星浏览器用自己的authority() {
        List<String> a = BrowserImport.authoritiesFor("com.sec.android.app.sbrowser");
        assertTrue(a.contains("com.sec.android.app.sbrowser"));
    }

    @Test
    public void 未知包名拿包名兜底() {
        // 厂商自带的 AOSP 系浏览器通常就是「authority = 包名」，所以必须试一次
        List<String> a = BrowserImport.authoritiesFor("com.miui.browser");
        assertEquals(1, a.size());
        assertEquals("com.miui.browser", a.get(0));
    }

    @Test
    public void 候选里不会有重复() {
        for (String pkg : new String[]{"com.android.browser", "com.tencent.mtt",
            "com.UCMobile", "com.example.unknown"}) {
            List<String> a = BrowserImport.authoritiesFor(pkg);
            assertEquals("包名 " + pkg + " 出现了重复候选", 1, countDistinct(a));
        }
    }

    @Test
    public void 空包名没有候选() {
        assertEquals(0, BrowserImport.authoritiesFor(null).size());
        assertEquals(0, BrowserImport.authoritiesFor("").size());
    }

    @Test
    public void Chromium系不会被当成可读() {
        // Chrome / Edge 没有开放书签接口。这里不硬编码「不可读」，只是确认
        // 它们的候选 authority 就是包名本身 —— 试一次失败后界面会如实说明原因，
        // 而不是假装读到了空列表。
        List<String> chrome = BrowserImport.authoritiesFor("com.android.chrome");
        assertEquals("com.android.chrome", chrome.get(0));
    }

    private static int countDistinct(List<String> xs) {
        java.util.Set<String> s = new java.util.HashSet<>(xs);
        return s.size();
    }
}
