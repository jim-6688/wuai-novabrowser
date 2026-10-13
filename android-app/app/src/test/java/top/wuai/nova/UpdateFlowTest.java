package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 更新提示条状态机的单测。
 *
 * <p>这些用例的价值全在「不用发一次版就能验证」上：真机上要看到「下载失败时
 * 按钮是重试还是重启」「强制更新能不能被关掉」，得先造一个真的新版本出来。
 */
public class UpdateFlowTest {

    private static final String V = "1.2.3";

    // ---------------------------------------------------------- 可见性

    @Test
    public void 没有新版时整条不出现() {
        UpdateFlow.Snapshot s = UpdateFlow.of(UpdateFlow.Phase.IDLE, V, 0, false, null);
        assertFalse(s.visible);
        assertNull("不显示时不该给按钮", s.action);
        assertFalse(s.blocking);
    }

    @Test
    public void 阶段为null等同于没有新版() {
        assertFalse(UpdateFlow.of(null, V, 0, false, null).visible);
    }

    // ---------------------------------------------------------- 等待 Wi-Fi

    @Test
    public void 等待WiFi时按钮是立即下载且可以关掉() {
        UpdateFlow.Snapshot s =
            UpdateFlow.of(UpdateFlow.Phase.WAITING, V, -1, false, null);
        assertTrue(s.visible);
        assertEquals("立即下载", s.action);
        assertFalse("还没开始下，不该显示进度", s.progressVisible);
        assertTrue("非强制，允许用户把提示条收起来", s.closable);
        assertFalse("非强制不该挡住网页", s.blocking);
        assertFalse(s.warn);
        assertTrue("标题要带上版本号", s.title.contains(V));
    }

    @Test
    public void 强制更新时等待态不能关掉并会挡住网页() {
        UpdateFlow.Snapshot s =
            UpdateFlow.of(UpdateFlow.Phase.WAITING, V, -1, true, null);
        assertFalse("强制更新的提示条不能有 ×", s.closable);
        assertTrue("强制更新要挡住网页区", s.blocking);
    }

    // ---------------------------------------------------------- 下载中

    @Test
    public void 下载中有进度条且没有按钮() {
        UpdateFlow.Snapshot s =
            UpdateFlow.of(UpdateFlow.Phase.DOWNLOADING, V, 45, false, null);
        assertTrue(s.visible);
        assertTrue(s.progressVisible);
        assertEquals(45, s.percent);
        assertEquals("45%", s.detail);
        assertNull("下载中不该给「重启更新」这种按钮", s.action);
    }

    @Test
    public void 总长未知时进度按0算且副标题不写百分比() {
        UpdateFlow.Snapshot s =
            UpdateFlow.of(UpdateFlow.Phase.DOWNLOADING, V, -1, false, null);
        assertTrue(s.progressVisible);
        assertEquals(0, s.percent);
        assertEquals("已开始下载", s.detail);
    }

    @Test
    public void 进度超过100会被夹回去() {
        assertEquals(100, UpdateFlow.of(UpdateFlow.Phase.DOWNLOADING, V, 130,
            false, null).percent);
    }

    @Test
    public void 强制更新下载中也不能关掉() {
        UpdateFlow.Snapshot s =
            UpdateFlow.of(UpdateFlow.Phase.DOWNLOADING, V, 10, true, null);
        assertFalse(s.closable);
        assertTrue(s.blocking);
    }

    // ---------------------------------------------------------- 已就绪

    @Test
    public void 已就绪时按钮是重启更新且不再显示进度() {
        UpdateFlow.Snapshot s =
            UpdateFlow.of(UpdateFlow.Phase.READY, V, 100, false, null);
        assertTrue(s.visible);
        assertEquals("重启更新", s.action);
        assertFalse("已经下完了，再挂一条进度条只会让人以为还没完", s.progressVisible);
        assertTrue(s.title.contains("已就绪"));
        assertTrue("要顺口说明升级不会弄丢标签与登录状态", s.detail.contains("标签"));
    }

    @Test
    public void 强制更新已就绪时仍然不可关且继续遮挡() {
        UpdateFlow.Snapshot s =
            UpdateFlow.of(UpdateFlow.Phase.READY, V, 100, true, null);
        assertFalse(s.closable);
        assertTrue("没装上新版之前，强制更新不该松口", s.blocking);
    }

    // ---------------------------------------------------------- 失败

    @Test
    public void 失败时用警示色并且按钮是重试() {
        UpdateFlow.Snapshot s =
            UpdateFlow.of(UpdateFlow.Phase.FAILED, V, 0, false, "服务器返回 HTTP 503");
        assertTrue(s.visible);
        assertEquals("重试", s.action);
        assertTrue("失败要用警示配色", s.warn);
        assertEquals("服务器返回 HTTP 503", s.detail);
    }

    @Test
    public void 失败原因缺失时给一句默认说明() {
        assertEquals("网络似乎不太稳定，稍后会自动重试",
            UpdateFlow.of(UpdateFlow.Phase.FAILED, V, 0, false, null).detail);
        assertEquals("空白的原因也要被当成没有",
            "网络似乎不太稳定，稍后会自动重试",
            UpdateFlow.of(UpdateFlow.Phase.FAILED, V, 0, false, "   ").detail);
    }

    @Test
    public void 失败态下非强制可以关掉() {
        assertTrue(UpdateFlow.of(UpdateFlow.Phase.FAILED, V, 0, false, "x").closable);
        assertFalse(UpdateFlow.of(UpdateFlow.Phase.FAILED, V, 0, true, "x").closable);
    }

    // ---------------------------------------------------------- 版本号缺失

    @Test
    public void 拿不到版本号时标题里不留悬空的空格() {
        UpdateFlow.Snapshot s =
            UpdateFlow.of(UpdateFlow.Phase.READY, null, 100, false, null);
        assertNotNull(s.title);
        assertFalse("不该出现「新版本  已就绪」这种双空格",
            s.title.contains("  "));

        UpdateFlow.Snapshot blank =
            UpdateFlow.of(UpdateFlow.Phase.READY, "   ", 100, false, null);
        assertEquals(s.title, blank.title);
    }

    // ---------------------------------------------------------- percentOf

    @Test
    public void 百分比_总长未知返回负一而不是零() {
        assertEquals(-1, UpdateFlow.percentOf(1024, 0));
        assertEquals(-1, UpdateFlow.percentOf(1024, -5));
    }

    @Test
    public void 百分比_零与负的已下载都算零() {
        assertEquals(0, UpdateFlow.percentOf(0, 1000));
        assertEquals(0, UpdateFlow.percentOf(-3, 1000));
    }

    @Test
    public void 百分比_下满才是100() {
        assertEquals(100, UpdateFlow.percentOf(1000, 1000));
        assertEquals(100, UpdateFlow.percentOf(1001, 1000));
    }

    @Test
    public void 百分比_取整到100但还没下满时压回99() {
        // 999/1000 = 99.9%，整数除法会给 99 —— 正常。
        assertEquals(99, UpdateFlow.percentOf(999, 1000));
        // 但 1000 分之 999.6 这种情况会算出 100（截断），而包还没下完。
        // 进度条先跑到 100% 再干等，正是让人以为卡死的画面。
        assertEquals(99, UpdateFlow.percentOf(9996, 10000));
        assertEquals(99, UpdateFlow.percentOf(9999, 10000));
    }

    @Test
    public void 百分比_中间值() {
        assertEquals(50, UpdateFlow.percentOf(500, 1000));
        // 1/1000 = 0.1%，整数截断后就是 0。这条写下来是为了别有人「顺手」把它改成 1：
        // 已经下了一个字节却显示 0%，看着像没动，但它确实是 0.1%。
        assertEquals(0, UpdateFlow.percentOf(1, 1000));
        assertEquals(33, UpdateFlow.percentOf(1, 3));
    }

    @Test
    public void 百分比_大文件不溢出() {
        // 3 GB 的包在 64 位 long 上不该出问题；这条挡住的是「用 int 算 got*100」的写法。
        long total = 3L * 1024 * 1024 * 1024;
        assertEquals(50, UpdateFlow.percentOf(total / 2, total));
    }

    @Test
    public void 夹取百分比() {
        assertEquals(0, UpdateFlow.clampPercent(-1));
        assertEquals(0, UpdateFlow.clampPercent(0));
        assertEquals(100, UpdateFlow.clampPercent(100));
        assertEquals(100, UpdateFlow.clampPercent(101));
    }
}
