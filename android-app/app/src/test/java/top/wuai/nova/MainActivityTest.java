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

    // -------------------------------------------------- 非 http(s) 地址归谁管

    @Test
    public void 内置新标签页是本机内容不该被送走() {
        // 这一条就是「新建标签页打开的还是首页」的根因。
        // 早先 shouldOverrideUrlLoading 写的是「非 http(s) 一律交回系统」，
        // 于是 file:///android_asset/newtab.html 也被递给系统；
        // 系统里没有能打开它的组件（/android_asset 不是真实路径），
        // 异常被吞掉、回调返回 true，WebView 于是什么都不加载 ——
        // 屏幕上是上一个页面，第一次用时那就是首页。
        assertEquals(MainActivity.UrlRoute.WEB,
            MainActivity.routeUrl("file:///android_asset/newtab.html?theme=dark&data=a"));
    }

    @Test
    public void 内置新标签页拼出来的地址一定留在本机() {
        // 把两端接起来验一次：NewTab 负责拼地址，routeUrl 负责放行。
        // 任一侧改了写法（比如改成 file:// 之外的形式）这里都会红。
        assertEquals(MainActivity.UrlRoute.WEB,
            MainActivity.routeUrl(NewTab.pageUrl("dark", NewTab.candidates(null))));
        assertEquals(MainActivity.UrlRoute.WEB,
            MainActivity.routeUrl(NewTab.pageUrl("light",
                NewTab.candidates(java.util.Collections.singletonList(
                    new NewTab.Row("示例", "https://example.com/", 3, true))))));
    }

    @Test
    public void 空白页同理留在WebView里() {
        // 「新标签页 → 空白页」那一档是 about:blank，走的正是同一个分支，
        // 一样会被送出去、一样会静默不动。
        assertEquals(MainActivity.UrlRoute.WEB, MainActivity.routeUrl("about:blank"));
    }

    @Test
    public void http与https由WebView自己加载() {
        assertEquals(MainActivity.UrlRoute.WEB, MainActivity.routeUrl("https://example.com/"));
        assertEquals(MainActivity.UrlRoute.WEB, MainActivity.routeUrl("http://example.com/"));
    }

    @Test
    public void 快捷方式命令交给命令处理器() {
        assertEquals(MainActivity.UrlRoute.COMMAND,
            MainActivity.routeUrl("nova://shortcut/add?label=x&url=y"));
        assertEquals(MainActivity.UrlRoute.COMMAND,
            MainActivity.routeUrl("nova://shortcut/remove?url=y"));
        // scheme 是大小写不敏感的，页面拼的时候大小写不固定
        assertEquals(MainActivity.UrlRoute.COMMAND,
            MainActivity.routeUrl("NOVA://shortcut/add?label=x"));
    }

    @Test
    public void 电话邮件微信这类交回系统() {
        assertEquals(MainActivity.UrlRoute.EXTERNAL, MainActivity.routeUrl("tel:10086"));
        assertEquals(MainActivity.UrlRoute.EXTERNAL, MainActivity.routeUrl("mailto:a@b.com"));
        assertEquals(MainActivity.UrlRoute.EXTERNAL, MainActivity.routeUrl("weixin://dl/x"));
        assertEquals(MainActivity.UrlRoute.EXTERNAL,
            MainActivity.routeUrl("intent://x#Intent;scheme=y;end"));
    }

    @Test
    public void 没有协议头的相对地址不往外送() {
        // 页面里 location.href = "下一页.html" 这种相对地址，
        // 交出去只会得到一个打不开的空白页。
        assertEquals(MainActivity.UrlRoute.WEB, MainActivity.routeUrl("next/page.html"));
        assertEquals(MainActivity.UrlRoute.WEB, MainActivity.routeUrl(""));
        assertEquals(MainActivity.UrlRoute.WEB, MainActivity.routeUrl(null));
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

    // ------------------------------------------------------- 新标签页三档

    @Test
    public void 新标签页三档轮换成一个环() {
        assertEquals("homepage", MainActivity.nextNtpMode("start"));
        assertEquals("blank", MainActivity.nextNtpMode("homepage"));
        assertEquals("start", MainActivity.nextNtpMode("blank"));
    }

    @Test
    public void 三档都能转到一次_没有哪一档转不出来() {
        // 挨个转一圈，三档必须都出现过。写成 if/else 时最容易漏掉一档，
        // 表现是「有个选项怎么也切不到」，而真机上要点好几下才发现。
        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        String mode = "start";
        for (int i = 0; i < 3; i++) {
            seen.add(mode);
            mode = MainActivity.nextNtpMode(mode);
        }
        assertEquals(3, seen.size());
        assertEquals("start", mode);
    }

    @Test
    public void 认不出的档位当默认档处理而不是崩() {
        // 配置是从设置文件里读回来的，手改过、或来自更早的版本都可能。
        // 新标签页是每次开标签都要走的路，这里绝不能抛。
        assertEquals("start", MainActivity.nextNtpMode("乱写的"));
        assertEquals("start", MainActivity.nextNtpMode(null));
        assertEquals("start", MainActivity.nextNtpMode(""));
        // 老配置里 newTabPage 存的是一个地址 —— 也不该崩
        assertEquals("start", MainActivity.nextNtpMode("https://52ta.top/"));
    }

    // ------------------------------------------- 有没有「真实的网站地址」

    @Test
    public void 普通网址算有网站() {
        assertTrue(MainActivity.hasSiteUrl("https://52ta.top/"));
        assertTrue(MainActivity.hasSiteUrl("http://example.com/a?b=1"));
    }

    @Test
    public void 内置新标签页没有网站() {
        // 这是最要紧的一条：内置新标签页是一条 file:///android_asset/…，
        // 它出现在地址栏里的样子被刻意换成了提示语（见 syncUrlBar），
        // 要是这里漏了，用户点「分享该网站」会把一条本机路径发给别人。
        assertFalse(MainActivity.hasSiteUrl("file:///android_asset/newtab.html"));
        assertFalse(MainActivity.hasSiteUrl("file:///sdcard/a.html"));
    }

    @Test
    public void 空白页与脚本页都没有网站() {
        assertFalse(MainActivity.hasSiteUrl("about:blank"));
        assertFalse(MainActivity.hasSiteUrl("javascript:void(0)"));
        // data: 是原来收藏那处判断漏掉的一个 —— 它同样没有网站可分享
        assertFalse(MainActivity.hasSiteUrl("data:text/html,<b>x</b>"));
    }

    @Test
    public void 空值一律算没有网站() {
        assertFalse(MainActivity.hasSiteUrl(null));
        assertFalse(MainActivity.hasSiteUrl(""));
    }

    @Test
    public void 网址判断不区分大小写() {
        // scheme 按 RFC 不区分大小写，而 WebView 回吐的 URL 大小写没有保证。
        // 只写 startsWith("file:") 的话，"FILE:///x" 会被放过去。
        assertFalse(MainActivity.hasSiteUrl("FILE:///android_asset/newtab.html"));
        assertFalse(MainActivity.hasSiteUrl("About:Blank"));
        assertFalse(MainActivity.hasSiteUrl("Javascript:void(0)"));
        assertTrue(MainActivity.hasSiteUrl("HTTPS://example.com/"));
    }
}
