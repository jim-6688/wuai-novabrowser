package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 内核目录的单测。
 *
 * <p>这个产品有一条底线约定：<b>绝不把兼容层画成真内核，也绝不静默降级</b>。
 * 桌面端靠 UI 提示条守，移动端的守点就在 {@link EngineCatalog}。
 * 所以这里的测试重点不是「能不能切」，而是「没带的内核被选中时会不会被悄悄换掉」。
 */
public class EngineCatalogTest {

    @Test
    public void 三档内核都在() {
        assertEquals(3, EngineCatalog.ALL.size());
        assertEquals("chromium", EngineCatalog.ALL.get(0).id);
        assertEquals("gecko", EngineCatalog.ALL.get(1).id);
        assertEquals("trident", EngineCatalog.ALL.get(2).id);
    }

    @Test
    public void 系统WebView是真内核() {
        // Android 上唯一一个不用额外打包就能拿到的真内核
        EngineCatalog.Engine e = EngineCatalog.byId("chromium");
        assertTrue(e.isRealKernel());
        assertTrue(e.selectable());
        assertEquals(EngineCatalog.Nature.REAL_KERNEL, e.nature);
    }

    @Test
    public void 兼容层不是内核() {
        // 这是最重要的一条断言：兼容层跑的还是系统 WebView，只是换了 UA。
        // 它的 nature 必须是 COMPAT_LAYER，不能是 REAL_KERNEL。
        EngineCatalog.Engine e = EngineCatalog.byId("trident");
        assertFalse(e.isRealKernel());
        assertEquals(EngineCatalog.Nature.COMPAT_LAYER, e.nature);
        assertTrue(e.selectable());
    }

    @Test
    public void 兼容层有UA且像老IE() {
        EngineCatalog.Engine e = EngineCatalog.byId("trident");
        assertTrue(e.userAgent != null);
        assertTrue(e.userAgent.contains("Trident"));
    }

    @Test
    public void 真内核的UA是空的() {
        // 真内核不该带 UA 覆盖 —— 那是兼容层才干的事
        assertEquals(null, EngineCatalog.byId("chromium").userAgent);
    }

    @Test
    public void GeckoView标为未内置() {
        // 它是货真价实的第二套内核，但本包没有内置。
        EngineCatalog.Engine e = EngineCatalog.byId("gecko");
        assertEquals(EngineCatalog.Nature.NOT_BUNDLED, e.nature);
        assertFalse(e.selectable());
    }

    @Test
    public void 内核色三种不同() {
        // 三档必须各有标识色，弹层上要靠它一眼区分
        int a = EngineCatalog.byId("chromium").colorRes;
        int b = EngineCatalog.byId("gecko").colorRes;
        int c = EngineCatalog.byId("trident").colorRes;
        assertTrue(a != b);
        assertTrue(b != c);
        assertTrue(a != c);
    }

    // ------------------------------------------------------------ resolve

    @Test
    public void 选真内核不降级() {
        EngineCatalog.Outcome o = EngineCatalog.resolve("chromium");
        assertFalse(o.degraded);
        assertEquals("chromium", o.active.id);
        assertEquals("chromium", o.requested.id);
        assertEquals("", o.reason);
    }

    @Test
    public void 选未内置的会降级并说明原因() {
        // 这是底线：不静默降级。选了没带的，必须回退到系统 WebView
        // 且 reason 里说清是哪个被拒、换成了什么。
        EngineCatalog.Outcome o = EngineCatalog.resolve("gecko");
        assertTrue(o.degraded);
        assertEquals("chromium", o.active.id);
        assertEquals("gecko", o.requested.id);
        assertTrue(o.reason.contains("GeckoView"));
        assertTrue(o.reason.contains("WebView"));
    }

    @Test
    public void 选兼容层不算降级() {
        // 兼容层是可选功能，不是失败。选中它就是选中它，不该弹降级提示。
        EngineCatalog.Outcome o = EngineCatalog.resolve("trident");
        assertFalse(o.degraded);
        assertEquals("trident", o.active.id);
        assertFalse(o.active.isRealKernel());
    }

    @Test
    public void 未知内核落回系统WebView() {
        EngineCatalog.Outcome o = EngineCatalog.resolve("netscape");
        assertEquals("chromium", o.active.id);
    }

    @Test
    public void 按id取内核未知落回首档() {
        assertEquals("chromium", EngineCatalog.byId("nope").id);
        assertEquals("chromium", EngineCatalog.byId(null).id);
    }

    @Test
    public void 降级目标必须是真内核且可用() {
        // 降级的唯一目标是系统 WebView。要求两点：它自己可选，
        // 而且它确实是真内核 —— 降级绝不能把用户送进一个兼容层，
        // 那等于「假装降级了，实际问题原样存在」。
        for (EngineCatalog.Engine e : EngineCatalog.ALL) {
            EngineCatalog.Outcome o = EngineCatalog.resolve(e.id);
            if (!o.degraded) continue;
            assertTrue(e.id + " 降级目标不可用", o.active.selectable());
            assertTrue(e.id + " 降级目标不是真内核", o.active.isRealKernel());
        }
    }

    @Test
    public void 所有内核都能解析成某种结果() {
        // 兼容层虽然不是真内核，但它可选，所以不该触发降级
        assertFalse(EngineCatalog.resolve("trident").degraded);
        assertFalse(EngineCatalog.resolve("chromium").degraded);
        assertTrue(EngineCatalog.resolve("gecko").degraded);
    }
}