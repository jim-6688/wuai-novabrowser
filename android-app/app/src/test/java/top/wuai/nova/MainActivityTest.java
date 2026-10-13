package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

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

    // ---------------------------------------------------------- URL 末段取名

    @Test
    public void 取URL末段当文件名() {
        assertEquals("a.apk", MainActivity.nameFromUrl("https://x.com/dir/a.apk"));
    }

    @Test
    public void 查询串不进文件名() {
        // 带 ?token=... 的下载链接很常见，不砍掉的话文件名会变成一长串签名，
        // 用户根本看不出自己要下的是什么。
        assertEquals("a.apk", MainActivity.nameFromUrl("https://x.com/a.apk?token=abc&e=1"));
    }

    @Test
    public void 末尾是斜杠时退回整串() {
        // example.com/dir/ 的末段是空的，这时不能再返回空名字 ——
        // 确认框会显示一片空白，用户不知道要下什么。
        assertEquals("https://x.com/dir/", MainActivity.nameFromUrl("https://x.com/dir/"));
    }

    @Test
    public void 没有路径时就是主机名之后那一段() {
        assertEquals("x.com", MainActivity.nameFromUrl("https://x.com"));
    }

    @Test
    public void 超长名字会被截断() {
        // 不截断的话，一串长网址能把确认框撑到看不见「下载」按钮
        String got = MainActivity.nameFromUrl("https://x.com/" + "a".repeat(100));
        assertTrue("应截断到 65 以内，实际 " + got.length(), got.length() <= 65);
        assertTrue("截断处应有省略号：" + got, got.endsWith("…"));
    }

    @Test
    public void 空URL返回空串而不是崩() {
        // 确认框拿它拼提示语，返回 null 会让显示变成 "null" 四个字母
        assertEquals("", MainActivity.nameFromUrl(null));
        assertEquals("", MainActivity.nameFromUrl(""));
    }

    // ------------------------------------------------------ 历史条目上的时间

    private static final long DAY_MS = 24L * 3600 * 1000;

    @Test
    public void 今天和昨天显示成相对说法() {
        // 人是靠「我上午看的那个」来找历史的，一串日期没有这个信息
        long now = MainActivity.startOfDay(System.currentTimeMillis()) + 15 * 3600_000L;
        assertTrue(MainActivity.historyTime(now, now).startsWith("今天"));
        assertTrue(MainActivity.historyTime(now - DAY_MS, now).startsWith("昨天"));
    }

    @Test
    public void 一周内显示几天前() {
        long now = MainActivity.startOfDay(System.currentTimeMillis()) + 15 * 3600_000L;
        assertEquals("3 天前", MainActivity.historyTime(now - 3 * DAY_MS, now));
        assertEquals("6 天前", MainActivity.historyTime(now - 6 * DAY_MS, now));
    }

    @Test
    public void 更早的落到具体日期() {
        // 超过一周再显示「几天前」就没意义了，人会开始数不过来
        long now = MainActivity.startOfDay(System.currentTimeMillis()) + 15 * 3600_000L;
        String got = MainActivity.historyTime(now - 30 * DAY_MS, now);
        assertFalse(got.startsWith("今天"));
        assertFalse(got.contains("天前"));
        assertFalse(got.isEmpty());
    }

    @Test
    public void 跨零点才算前一天() {
        // 直接拿毫秒差算天数的话，23:50 记下的一条 00:10 再看会被算成同一天
        long midnight = MainActivity.startOfDay(System.currentTimeMillis());
        long lateNight = midnight + 23 * 3600_000L + 50 * 60_000L; // 23:50
        long afterMidnight = midnight + DAY_MS + 10 * 60_000L;     // 次日 00:10
        // 只差 20 分钟，但跨了零点，就该算昨天
        assertTrue(MainActivity.historyTime(lateNight, afterMidnight).startsWith("昨天"));
    }

    @Test
    public void 时间戳为零时不显示时间() {
        // 老数据或解析失败的记录没有时间戳，显示 "今天 00:00" 是在骗人
        assertEquals("", MainActivity.historyTime(0, System.currentTimeMillis()));
        assertEquals("", MainActivity.historyTime(-1, System.currentTimeMillis()));
    }

    // ------------------------------------------------------ 标签「按引用关闭」
    //
    // 标签总览用 GridView，会复用 item 视图。× 的点击回调如果捕获「绑定时的下标」，
    // 在关闭 + notifyDataSetChanged 造成下标前移之后就会关错项。修复是改成捕获
    // Tab 对象本身、关的时候按引用重新定位 —— 下面就是钉住这个定位逻辑的测试。

    @Test
    public void 按引用定位得到正确下标() {
        List<Tab> tabs = new ArrayList<>();
        Tab a = new Tab("https://a.com/");
        Tab b = new Tab("https://b.com/");
        Tab c = new Tab("https://c.com/");
        tabs.add(a);
        tabs.add(b);
        tabs.add(c);
        assertEquals(0, MainActivity.indexOfTabRef(tabs, a));
        assertEquals(1, MainActivity.indexOfTabRef(tabs, b));
        assertEquals(2, MainActivity.indexOfTabRef(tabs, c));
    }

    @Test
    public void 内容相等的两个标签不会认错() {
        // 两个空白主页标签内容一模一样；按下标之外的任何「值比较」都会认错，
        // 按引用（==）才能分清它们是两个不同的标签。
        List<Tab> tabs = new ArrayList<>();
        Tab home1 = new Tab("about:blank");
        Tab home2 = new Tab("about:blank");
        Tab other = new Tab("https://x.com/");
        tabs.add(other);
        tabs.add(home1);
        tabs.add(home2);
        assertEquals(1, MainActivity.indexOfTabRef(tabs, home1));
        assertEquals(2, MainActivity.indexOfTabRef(tabs, home2));
        // 关掉 home1，home2 前移到下标 1，但按引用仍能定位到它自己
        tabs.remove(MainActivity.indexOfTabRef(tabs, home1));
        assertEquals(1, MainActivity.indexOfTabRef(tabs, home2));
    }

    @Test
    public void 下标漂移后仍能对上原对象() {
        List<Tab> tabs = new ArrayList<>();
        Tab a = new Tab("https://a.com/");
        Tab b = new Tab("https://b.com/");
        Tab c = new Tab("https://c.com/");
        tabs.add(a);
        tabs.add(b);
        tabs.add(c);
        assertEquals(1, MainActivity.indexOfTabRef(tabs, b));
        // 关掉 a 之后 b 从下标 1 漂到 0：缓存的下标会失效，缓存的引用不会
        tabs.remove(MainActivity.indexOfTabRef(tabs, a));
        assertEquals(0, MainActivity.indexOfTabRef(tabs, b));
    }

    @Test
    public void 找不到引用返回负一而不是抛异常() {
        // 重复点同一个 × 时对象已经不在了，应返回 -1（调用方据此直接返回），
        // 绝不能抛 —— 抛在点击回调里就是一次闪退。
        List<Tab> tabs = new ArrayList<>();
        tabs.add(new Tab("https://a.com/"));
        assertEquals(-1, MainActivity.indexOfTabRef(tabs, new Tab("https://a.com/")));
        assertEquals(-1, MainActivity.indexOfTabRef(tabs, null));
        assertEquals(-1, MainActivity.indexOfTabRef(null, new Tab("x")));
    }
}
