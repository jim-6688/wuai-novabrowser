package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.junit.Test;

/**
 * 内置新标签页的原生侧逻辑。
 *
 * <p>全部是纯 JVM 测试 —— {@link NewTab} 刻意不碰任何 Android 类，
 * 就是为了能这样直接跑（碰了框架类会变成 {@code Stub!} 异常）。
 *
 * <p>这一层最值得钉住的两件事：
 * <ul>
 *   <li><b>编码是跨语言的</b> —— 安卓侧用 {@code java.net.URLEncoder}，页面侧用
 *       {@code decodeURIComponent}，而前者把空格编成 {@code +}、后者只认 {@code %20}。
 *       这个不一致不会有任何报错，只会让「名字里带空格的快捷方式」在页面上变成
 *       {@code My+Site}。最后两条专门盯着它。</li>
 *   <li><b>页面回传的东西是不可信的</b> —— 动作地址是页面拼出来的，
 *       认不出来时必须安静地当没发生，而不是抛异常把浏览器带崩。</li>
 * </ul>
 */
public class NewTabTest {

    private static NewTab.Row row(String label, String url, int visits, boolean pinned) {
        return new NewTab.Row(label, url, visits, pinned);
    }

    // ------------------------------------------------------------ 地址识别

    @Test
    public void 裸的资产地址算新标签页() {
        assertTrue(NewTab.isNewTab(NewTab.ASSET_URL));
    }

    @Test
    public void 带主题与数据的资产地址也算新标签页() {
        String url = NewTab.pageUrl("dark", "主页\thttps://52ta.top/\t3\tp");
        assertTrue(NewTab.isNewTab(url));
    }

    @Test
    public void 普通网页不算新标签页() {
        assertFalse(NewTab.isNewTab("https://52ta.top/"));
        assertFalse(NewTab.isNewTab("about:blank"));
    }

    @Test
    public void 空地址不算新标签页() {
        assertFalse(NewTab.isNewTab(null));
        assertFalse(NewTab.isNewTab(""));
    }

    // ------------------------------------------------------------ 地址拼装

    @Test
    public void 默认主题拼成_light() {
        assertEquals(NewTab.ASSET_URL + "?theme=light", NewTab.pageUrl(null, null));
        assertEquals(NewTab.ASSET_URL + "?theme=light", NewTab.pageUrl("", null));
    }

    @Test
    public void 深色主题拼成_dark() {
        assertEquals(NewTab.ASSET_URL + "?theme=dark", NewTab.pageUrl("dark", ""));
    }

    @Test
    public void 主题大小写不敏感_只认深色() {
        assertTrue(NewTab.isDark("DARK"));
        assertTrue(NewTab.isDark("Dark"));
        assertFalse(NewTab.isDark("system"));
        assertFalse(NewTab.isDark(null));
    }

    @Test
    public void 数据为空时不拼_data_参数() {
        // 拼一个空的 data= 会让页面以为「原生明确说没有候选」，
        // 而它的正确行为是退回内置兜底那七个。
        assertFalse(NewTab.pageUrl("light", null).contains("data="));
        assertFalse(NewTab.pageUrl("light", "").contains("data="));
    }

    @Test
    public void 数据非空时挂上_data_参数() {
        String url = NewTab.pageUrl("light", "知乎\thttps://www.zhihu.com/\t9\t-");
        assertTrue(url.contains("&data="));
        // 中间的制表符与换行必须被编码，否则会把 URL 拆坏
        assertFalse(url.contains("\t"));
    }

    // ------------------------------------------------------------ 候选编码

    @Test
    public void 一行候选是四个制表符分隔的字段() {
        List<NewTab.Row> rows = new ArrayList<>();
        rows.add(row("知乎", "https://www.zhihu.com/", 9, true));
        assertEquals("知乎\thttps://www.zhihu.com/\t9\tp", NewTab.candidates(rows));
    }

    @Test
    public void 没固定的候选标志位是减号() {
        List<NewTab.Row> rows = new ArrayList<>();
        rows.add(row("知乎", "https://www.zhihu.com/", 9, false));
        assertEquals("知乎\thttps://www.zhihu.com/\t9\t-", NewTab.candidates(rows));
    }

    @Test
    public void 固定项排在前面_哪怕访问次数低() {
        List<NewTab.Row> rows = new ArrayList<>();
        rows.add(row("常去的", "https://a.com/", 500, false));
        rows.add(row("自己加的", "https://b.com/", 1, true));
        String out = NewTab.candidates(rows);
        assertEquals("自己加的\thttps://b.com/\t1\tp\n常去的\thttps://a.com/\t500\t-", out);
    }

    @Test
    public void 其余按访问次数降序() {
        List<NewTab.Row> rows = new ArrayList<>();
        rows.add(row("少的", "https://a.com/", 3, false));
        rows.add(row("多的", "https://b.com/", 90, false));
        rows.add(row("中的", "https://c.com/", 40, false));
        String[] lines = NewTab.candidates(rows).split("\n");
        assertEquals("多的", lines[0].split("\t")[0]);
        assertEquals("中的", lines[1].split("\t")[0]);
        assertEquals("少的", lines[2].split("\t")[0]);
    }

    @Test
    public void 次数相同时按名称定序_顺序不抖() {
        // 不定序的话，同一个数据每次排出来的顺序可能不同 ——
        // 表现是「新标签页的图标每次刷新都在换位置」，用户找不到肌肉记忆。
        //
        // 这里用的「苹果 / 香蕉」是码点顺序与直觉一致的一对（苹 U+82F9 < 香 U+9999）。
        // 别换成「甲 / 乙」：String.compareTo 比的是码点，而乙 U+4E59 < 甲 U+7532，
        // 结果会和「甲乙丙丁」的日常语感反过来 —— 这条测试最早就是那么写错的。
        List<NewTab.Row> rows = new ArrayList<>();
        rows.add(row("香蕉", "https://b.com/", 5, false));
        rows.add(row("苹果", "https://a.com/", 5, false));
        String[] lines = NewTab.candidates(rows).split("\n");
        assertEquals("苹果", lines[0].split("\t")[0]);
        assertEquals("香蕉", lines[1].split("\t")[0]);
    }

    @Test
    public void 标签里的制表符与换行被换成空格() {
        // 不换的话一行会被拆成两行，页面上凭空多出一个磁贴
        List<NewTab.Row> rows = new ArrayList<>();
        rows.add(row("带\t制表\t符\n和换行", "https://a.com/", 1, false));
        String out = NewTab.candidates(rows);
        assertEquals(1, out.split("\n").length);
        assertTrue(out.startsWith("带 制表 符 和换行\t"));
    }

    @Test
    public void 候选上限是三十条() {
        List<NewTab.Row> rows = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            rows.add(row("站点" + i, "https://s" + i + ".com/", 100 - i, false));
        }
        assertEquals(NewTab.MAX_CANDIDATES, NewTab.candidates(rows).split("\n").length);
        // 截掉的是访问次数少的那些，不是随机的那些
        assertTrue(NewTab.candidates(rows).contains("站点0\t"));
        assertFalse(NewTab.candidates(rows).contains("站点40\t"));
    }

    @Test
    public void 没有网址的候选被跳过() {
        List<NewTab.Row> rows = new ArrayList<>();
        rows.add(row("空的", "", 9, false));
        rows.add(row("正常的", "https://a.com/", 1, false));
        assertEquals("正常的\thttps://a.com/\t1\t-", NewTab.candidates(rows));
    }

    @Test
    public void 空列表编码成空串() {
        assertEquals("", NewTab.candidates(null));
        assertEquals("", NewTab.candidates(new ArrayList<NewTab.Row>()));
    }

    // -------------------------------------------------------- 内置推荐位补位
    //
    // 守的是「宫格被删了」那类反馈：候选一旦非空，页面那条「候选为空才兜底」
    // 就再也不会生效，只访问过两三个站点的用户会看到一片空白。

    @Test
    public void 候选不足时补齐到版面格数() {
        List<NewTab.Row> rows = new ArrayList<>();
        rows.add(new NewTab.Row("A", "https://a.com/", 3, false));
        List<NewTab.Row> out = NewTab.withBuiltins(rows, new HashSet<String>());
        assertEquals(NewTab.MAX_TILES, out.size());
        assertEquals(7, NewTab.MAX_TILES);
    }

    @Test
    public void 候选够填满版面时一条都不补() {
        List<NewTab.Row> rows = new ArrayList<>();
        for (int i = 0; i < 9; i++) {
            rows.add(new NewTab.Row("S" + i, "https://s" + i + ".test/", 9 - i, false));
        }
        assertEquals(9, NewTab.withBuiltins(rows, new HashSet<String>()).size());
    }

    @Test
    public void 补位项垫底且带f标记() {
        List<NewTab.Row> rows = new ArrayList<>();
        rows.add(new NewTab.Row("A", "https://a.com/", 3, false));
        String[] lines = NewTab.candidates(NewTab.withBuiltins(rows, new HashSet<String>())).split("\n");
        assertEquals(NewTab.MAX_TILES, lines.length);
        assertTrue(lines[0].endsWith("\t-"));
        assertTrue(lines[lines.length - 1].endsWith("\tf"));
    }

    @Test
    public void 被用户点掉的主机名不会被补回来() {
        Set<String> blocked = new HashSet<>();
        blocked.add("52ta.top");
        List<NewTab.Row> out = NewTab.withBuiltins(new ArrayList<NewTab.Row>(), blocked);
        for (NewTab.Row r : out) {
            assertFalse("52ta.top".equals(NewTab.hostKey(r.url)));
        }
        // 主页与导航同属 52ta.top，两条都不该回来
        assertEquals(NewTab.BUILTIN_SITES.length - 2, out.size());
    }

    @Test
    public void 判重按完整URL同一家的两个入口都保留() {
        List<NewTab.Row> rows = new ArrayList<>();
        rows.add(new NewTab.Row("导航", "https://52ta.top/", 0, false));
        List<NewTab.Row> out = NewTab.withBuiltins(rows, new HashSet<String>());
        int nav = 0;
        int home = 0;
        for (NewTab.Row r : out) {
            if ("https://52ta.top/".equals(r.url)) nav++;
            if ("https://www.52ta.top/".equals(r.url)) home++;
        }
        // 「导航」已经在了就不重复补；「主页」是同一家的另一个入口，必须补上 ——
        // 按主机名去重的话这里会是 0，用户看到的就是「宫格缺一角」。
        assertEquals(1, nav);
        assertEquals(1, home);
    }

    @Test
    public void 自己加的候选排在补位项前面() {
        List<NewTab.Row> rows = new ArrayList<>();
        rows.add(new NewTab.Row("我的", "https://mine.test/", 0, true));
        String[] lines = NewTab.candidates(NewTab.withBuiltins(rows, new HashSet<String>())).split("\n");
        assertEquals("我的\thttps://mine.test/\t0\tp", lines[0]);
        assertTrue(lines[lines.length - 1].endsWith("\tf"));
    }

    // ------------------------------------------------------------ 动作解析

    @Test
    public void 解析新增命令() {
        NewTab.Cmd c = NewTab.parse("nova://shortcut/add?label=%E7%9F%A5%E4%B9%8E&url=https%3A%2F%2Fzhihu.com%2F");
        assertNotNull(c);
        assertEquals(NewTab.OP_ADD, c.op);
        assertEquals("知乎", c.get("label"));
        assertEquals("https://zhihu.com/", c.get("url"));
    }

    @Test
    public void 解析删除命令() {
        NewTab.Cmd c = NewTab.parse("nova://shortcut/remove?url=https%3A%2F%2Fa.com%2F");
        assertNotNull(c);
        assertEquals(NewTab.OP_REMOVE, c.op);
        assertEquals("https://a.com/", c.get("url"));
    }

    @Test
    public void 没有参数的命令也能解析_取到空串而不是崩() {
        NewTab.Cmd c = NewTab.parse("nova://shortcut/remove");
        assertNotNull(c);
        assertEquals(NewTab.OP_REMOVE, c.op);
        assertEquals("", c.get("url"));
        assertEquals("", c.get("没这个键"));
    }

    @Test
    public void 认不出的操作返回空() {
        // 页面是可以随手拼出任意地址的，唯一的正确反应是当没看见
        assertNull(NewTab.parse("nova://shortcut/dance?x=1"));
        assertNull(NewTab.parse("nova://shortcut/"));
    }

    @Test
    public void 解析搜索命令() {
        NewTab.Cmd c = NewTab.parse("nova://shortcut/search?q=%E6%90%9C%E7%B4%A2");
        assertNotNull(c);
        assertEquals(NewTab.OP_SEARCH, c.op);
        assertEquals("搜索", c.get("q"));
    }

    @Test
    public void 不是新标签页命令的一律返回空() {
        assertNull(NewTab.parse(null));
        assertNull(NewTab.parse(""));
        assertNull(NewTab.parse("https://example.com/"));
        assertNull(NewTab.parse("nova://other/thing"));
    }

    @Test
    public void 命令参数里的加号被当成加号_空格还原成空格() {
        // 页面用的是 encodeURIComponent：空格出 %20，字面的加号出 %2B。
        // 用 URLDecoder 解正好对上；反过来把 + 当空格就会把 %2B 解成空格。
        NewTab.Cmd c = NewTab.parse("nova://shortcut/add?label=a%2Bb%20c");
        assertNotNull(c);
        assertEquals("a+b c", c.get("label"));
    }

    // ------------------------------------------------------------ 主机名

    @Test
    public void 取主机名() {
        assertEquals("www.zhihu.com", NewTab.hostOf("https://www.zhihu.com/question/1"));
        assertEquals("a.com", NewTab.hostOf("http://a.com:8080/x?y=1#z"));
        assertEquals("a.com", NewTab.hostOf("https://user:pw@a.com/x"));
    }

    @Test
    public void 没有协议头的原样返回_不砍成_about() {
        // 硬套「去端口」那一步会把 about:blank 砍成 about —— TabTest 逮到过一次，
        // 这一份实现刻意保持同一个分支，不能两个地方两种行为。
        assertEquals("about:blank", NewTab.hostOf("about:blank"));
        assertEquals("", NewTab.hostOf(null));
    }

    @Test
    public void 比对键去掉_www_前缀并转小写() {
        // 不归一化就会「删了又回来」：用户删掉的是 WWW.Zhihu.com，
        // 历史里回来的却是 zhihu.com
        assertEquals("zhihu.com", NewTab.hostKey("https://WWW.Zhihu.com/"));
        assertEquals("zhihu.com", NewTab.hostKey("https://zhihu.com/hot"));
        assertEquals(NewTab.hostKey("https://www.a.com/"), NewTab.hostKey("http://a.com/"));
    }

    @Test
    public void 不同站点的主机名键不同() {
        assertFalse(NewTab.hostKey("https://a.com/").equals(NewTab.hostKey("https://b.com/")));
    }

    // ------------------------------------------------------------ 名称截取

    @Test
    public void 标题里的站点后缀被切掉() {
        // 「页面名 - 站点名」是国内站点最常见的标题形态
        assertEquals("知乎", NewTab.labelOf(
            "知乎 - 有问题，就会有答案", "https://www.zhihu.com/"));
        assertEquals("哔哩哔哩", NewTab.labelOf(
            "哔哩哔哩 | 干杯", "https://www.bilibili.com/"));
        assertEquals("豆瓣", NewTab.labelOf(
            "豆瓣_读书", "https://book.douban.com/"));
    }

    @Test
    public void 没有分隔符的短标题原样保留() {
        assertEquals("百度一下，你就知道",
            NewTab.labelOf("百度一下，你就知道", "https://www.baidu.com/"));
    }

    @Test
    public void 分隔符前面不足两个字就不切() {
        // 「8_12岁英语」里那一横后面是内容，不是站点名；切了等于丢一半信息。
        // 顺带钉住 `i >= 2` 这个门槛：改成 `i > 0` 这条就会红。
        assertEquals("8_12岁英语", NewTab.labelOf("8_12岁英语", "https://a.com/"));
    }

    @Test
    public void 标题为空时退回域名() {
        assertEquals("zhihu.com", NewTab.labelOf("", "https://www.zhihu.com/"));
        assertEquals("zhihu.com", NewTab.labelOf(null, "https://www.zhihu.com/"));
        assertEquals("zhihu.com", NewTab.labelOf("   ", "https://www.zhihu.com/"));
    }

    @Test
    public void 过长的名称按码点截断() {
        String long_ = "一二三四五六七八九十十一十二十三";
        assertEquals("一二三四五六七八九十十一", NewTab.labelOf(long_, "https://a.com/"));
        // 直接 substring 会把 emoji 切成半个代理对，页面上显示成一个方块。
        // 判据用码点数，而不是「长度等于 12」——后者对半个代理对同样成立。
        String emoji = "😀😀😀😀😀😀😀😀😀😀😀😀😀";
        String cut = NewTab.labelOf(emoji, "https://a.com/");
        assertEquals(NewTab.MAX_LABEL, cut.codePointCount(0, cut.length()));
    }

    @Test
    public void 名称里的制表符被换成空格() {
        // 制表符是这一层的字段分隔符，混进名称里会把一行拆成两行、
        // 凭空多出一个磁贴
        assertEquals("知 乎", NewTab.labelOf("知\t乎", "https://zhihu.com/"));
        assertEquals("知 乎", NewTab.labelOf("知\n乎", "https://zhihu.com/"));
    }

    // ------------------------------------------------- 跨语言编码：这一层最容易错

    @Test
    public void 空格编成百分号二十而不是加号() {
        // java.net.URLEncoder 默认把空格编成 '+'，而页面读的是 decodeURIComponent，
        // 它不认 '+'。不换成 %20 的话，名称里带空格的快捷方式会显示成「My+Site」，
        // 而且两端都不会报任何错。
        assertEquals("My%20Site", NewTab.enc("My Site"));
    }

    @Test
    public void 中文标签编码后能原样解回来() {
        String label = "我的 博客 + 笔记";
        assertEquals(label, NewTab.dec(NewTab.enc(label)));
    }
}
