package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 设置页补齐后新增的两个判断的单测。
 *
 * <p>{@link MainActivity#rulesStale(long, long)} 管订阅自动更新的「3 天」边界。
 * 抽成纯函数就是为了在这里钉住它 —— 差一毫秒都不该多打一次网络，
 * 而这条边界在真机上要老老实实等三天才能复现。
 */
public class MainActivityTest {

    private static final long DAY = 24L * 3600 * 1000;
    private static final long NOW = 1_800_000_000_000L;

    @Test
    public void 从未订阅过一律算旧() {
        assertTrue(MainActivity.rulesStale(0, NOW));
        assertTrue(MainActivity.rulesStale(-1, NOW));
    }

    @Test
    public void 三天内不更新() {
        assertFalse(MainActivity.rulesStale(NOW, NOW));
        assertFalse(MainActivity.rulesStale(NOW - DAY, NOW));
        // 差一毫秒到三天也不算旧
        assertFalse(MainActivity.rulesStale(NOW - 3 * DAY + 1, NOW));
    }

    @Test
    public void 满三天及更旧才更新() {
        assertTrue(MainActivity.rulesStale(NOW - 3 * DAY, NOW));
        assertTrue(MainActivity.rulesStale(NOW - 10 * DAY, NOW));
    }

    @Test
    public void 时钟拨回旧时间不会误判() {
        // updatedAt 在未来（用户改过系统时间）：now - at 为负，不触发更新。
        // 此时按「不旧」处理，等时钟恢复正常再说 —— 为一个错时钟拼命重试没有意义。
        assertFalse(MainActivity.rulesStale(NOW + 5 * DAY, NOW));
    }

    // ------------------------------------------------------------ 主题三档

    @Test
    public void 跟随系统时以系统为准() {
        assertTrue(MainActivity.nightOn("system", true));
        assertFalse(MainActivity.nightOn("system", false));
    }

    @Test
    public void 强制两档不受系统影响() {
        assertFalse(MainActivity.nightOn("light", true));
        assertTrue(MainActivity.nightOn("dark", false));
    }

    @Test
    public void 未知主题值按跟随系统处理() {
        // 手改 SharedPreferences 完全可能写出第三个值。这时不猜，退回系统。
        assertTrue(MainActivity.nightOn("深色", true));
        assertFalse(MainActivity.nightOn("", false));
    }

    // ------------------------------------------------ Content-Disposition 文件名

    @Test
    public void 带引号的文件名() {
        assertEquals("report.zip",
            MainActivity.filenameFromDisposition("attachment; filename=\"report.zip\""));
    }

    @Test
    public void 不带引号的文件名() {
        assertEquals("setup.exe",
            MainActivity.filenameFromDisposition("attachment; filename=setup.exe"));
    }

    @Test
    public void RFC5987编码文件名优先且会解码() {
        // 中文站点多用 filename*=UTF-8''<percent-encoded>，比裸 filename 可靠
        // （裸 filename 常常是问号乱码）。%E6%8A%A5%E5%91%8A == 「报告」。
        assertEquals("报告.zip",
            MainActivity.filenameFromDisposition(
                "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.zip"));
    }

    @Test
    public void 同时给两种写法时取编码的那个() {
        assertEquals("报告.zip",
            MainActivity.filenameFromDisposition(
                "attachment; filename=\"?.zip\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.zip"));
    }

    @Test
    public void 砍掉目录只留最后一段() {
        // 不怀好意的服务器可能借文件名写目录，只保留最后一段
        assertEquals("evil.apk",
            MainActivity.filenameFromDisposition("attachment; filename=\"../../evil.apk\""));
        assertEquals("a.zip",
            MainActivity.filenameFromDisposition("attachment; filename=\"C:\\\\tmp\\\\a.zip\""));
    }

    @Test
    public void 没有文件名一律返回null() {
        assertNull(MainActivity.filenameFromDisposition(null));
        assertNull(MainActivity.filenameFromDisposition(""));
        assertNull(MainActivity.filenameFromDisposition("attachment"));
        assertNull(MainActivity.filenameFromDisposition("inline"));
        // 只剩目录、没有真实名字时也算没有
        assertNull(MainActivity.filenameFromDisposition("attachment; filename=\"/\""));
    }
}
