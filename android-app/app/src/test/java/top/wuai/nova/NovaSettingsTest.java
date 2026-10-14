package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * 配置与名单解析的单测。
 *
 * <p>{@link NovaSettings} 的「同名同值域」是这个类唯一重要的性质 ——
 * 它必须与桌面端 settings.js 的 mobile 块逐字对得上，否则会出现
 * 「桌面端关了、手机端还开着」这种最难查的不一致。所以 {@link #配置字段与桌面端同名}
 * 把每个键名都钉了一遍。
 */
public class NovaSettingsTest {

    // ------------------------------------------------------------ 默认值

    @Test
    public void 默认值合理() {
        NovaSettings s = new NovaSettings();
        assertEquals("off", s.noImage);
        assertEquals("chromium", s.defaultEngine);
        assertEquals(10, s.autoPageMax);
        assertFalse(s.autoPage);
        assertTrue(s.adblockEnabled);
        assertEquals("system", s.theme);
        assertTrue(s.swipeUpSearch);
    }

    @Test
    public void 老配置缺上划显示搜索键时保持开启() {
        // 新增开关不该让任何人的界面突然变了：老配置里没有这个键，
        // bool() 走 fallback，升级上来的用户保持原有行为（上划换搜索框）。
        Map<String, String> m = new HashMap<>(new NovaSettings().toMap());
        m.remove("swipeUpSearch");
        assertTrue(NovaSettings.fromMap(m).swipeUpSearch);
        // 只有显式关掉才关
        m.put("swipeUpSearch", "false");
        assertFalse(NovaSettings.fromMap(m).swipeUpSearch);
    }

    // ------------------------------------------------------------ 往返

    @Test
    public void 序列化和反序列化往返() {
        NovaSettings s = new NovaSettings();
        s.noImage = "image-av";
        s.autoPage = true;
        s.autoPageMax = 20;
        s.theme = "dark";
        s.defaultEngine = "trident";
        s.swipeUpSearch = false;

        NovaSettings back = NovaSettings.fromMap(s.toMap());
        assertEquals("image-av", back.noImage);
        assertTrue(back.autoPage);
        assertEquals(20, back.autoPageMax);
        assertEquals("dark", back.theme);
        assertEquals("trident", back.defaultEngine);
        assertFalse(back.swipeUpSearch);
    }

    @Test
    public void 空输入返回默认值() {
        NovaSettings s = NovaSettings.fromMap(null);
        assertEquals("off", s.noImage);
        assertEquals(10, s.autoPageMax);
    }

    // ------------------------------------------------------------ 容错

    @Test
    public void 非法值被拉回() {
        // 配置文件可以被手改。读到一个不认识的枚举值不能崩，也不能当真。
        Map<String, String> m = new HashMap<>();
        m.put("noImage", "全部拦掉");
        m.put("defaultEngine", "netscape");
        m.put("theme", "荧光");
        m.put("autoPageMax", "999");

        NovaSettings s = NovaSettings.fromMap(m);
        assertEquals("off", s.noImage);
        assertEquals("chromium", s.defaultEngine);
        assertEquals("system", s.theme);
        assertEquals(10, s.autoPageMax);
    }

    @Test
    public void 空字符串首页落回默认() {
        Map<String, String> m = new HashMap<>();
        m.put("homepage", "   ");
        assertEquals("https://52ta.top/", NovaSettings.fromMap(m).homepage);
    }

    @Test
    public void 布尔值容错() {
        Map<String, String> m = new HashMap<>();
        m.put("autoPage", "TRUE");
        m.put("adblockEnabled", "1");
        // 只认小写的 true/false。别的都当没设置，保持默认 ——
        // 把 "1" 当 true 也行，但那就意味着有两个真值写法，不一致。
        assertFalse(NovaSettings.fromMap(m).autoPage);
        assertTrue(NovaSettings.fromMap(m).adblockEnabled);
    }

    // ------------------------------------------------------- 地址栏解析

    @Test
    public void 像网址就补协议() {
        NovaSettings s = new NovaSettings();
        assertEquals("https://example.com", s.resolveInput("example.com"));
        assertEquals("https://example.com/a/b?c=1", s.resolveInput("example.com/a/b?c=1"));
    }

    @Test
    public void 带协议的原样保留() {
        NovaSettings s = new NovaSettings();
        assertEquals("http://example.com", s.resolveInput("http://example.com"));
        assertEquals("https://example.com", s.resolveInput("https://example.com"));
        assertEquals("about:blank", s.resolveInput("about:blank"));
    }

    @Test
    public void 不像网址就走搜索() {
        NovaSettings s = new NovaSettings();
        String out = s.resolveInput("今天天气怎么样");
        assertTrue(out.startsWith("https://www.baidu.com/s?wd="));
        assertTrue(out.contains("%"));
    }

    @Test
    public void 空输入回首页() {
        assertEquals("https://52ta.top/", new NovaSettings().resolveInput(""));
        assertEquals("https://52ta.top/", new NovaSettings().resolveInput("   "));
        assertEquals("https://52ta.top/", new NovaSettings().resolveInput(null));
    }

    @Test
    public void 含空格的当搜索词() {
        // "hello world" 含空格，不能被当成域名
        assertTrue(new NovaSettings().resolveInput("hello world")
            .startsWith("https://www.baidu.com/s?wd="));
    }

    // ------------------------------------------------------------ 搜索模板

    @Test
    public void 预设模板含百度必应谷歌与吾爱导航() {
        NovaSettings.SearchTemplate[] t = NovaSettings.templates();
        // 本轮新增了「吾爱导航」一档：它既能被用户选作地址栏搜索引擎，
        // 也是底部胶囊搜索框固定使用的模板。
        assertEquals(4, t.length);
        assertEquals("baidu", t[0].id);
        assertEquals("bing", t[1].id);
        assertEquals("google", t[2].id);
        assertEquals("nav52ta", t[3].id);
        for (NovaSettings.SearchTemplate x : t) {
            assertTrue(x.id + " 模板里没有 %s", x.url.contains("%s"));
        }
    }

    @Test
    public void 吾爱导航模板指向52ta并编码关键词() {
        // 表单 action="/all/" + name="q"，已核实
        assertEquals("https://52ta.top/all/?q=nova", NovaSettings.NAV_52TA.build("nova"));
        // 关键词必须 UTF-8 编码：中文直接拼进 URL 会被当成乱码
        String out = NovaSettings.NAV_52TA.build("吾爱 导航");
        assertTrue("中文关键词必须被百分号编码", out.startsWith("https://52ta.top/all/?q=%"));
        assertFalse("编码后不应出现空格", out.contains(" "));
    }

    @Test
    public void 新增模板不改变默认搜索引擎() {
        // 默认仍是 baidu；加模板不能顺手把默认值改了
        assertEquals("baidu", new NovaSettings().searchTemplate().id);
    }

    @Test
    public void 自定义模板() {
        NovaSettings s = new NovaSettings();
        s.searchTemplateId = "custom";
        s.customSearch = "https://s.example.com/?q=%s";
        assertEquals("https://s.example.com/?q=nova",
            s.searchTemplate().build("nova"));
    }

    @Test
    public void 自定义为空落回首预设() {
        // 用户选了「自定义」但没填地址，不能返回一个带 %s 的怪 URL
        NovaSettings s = new NovaSettings();
        s.searchTemplateId = "custom";
        s.customSearch = "";
        assertEquals("baidu", s.searchTemplate().id);
    }

    @Test
    public void 关键词被编码() {
        // 不编码的话「C++ 教程」里的 + 和空格会让搜索结果完全跑偏
        String out = NovaSettings.templates()[0].build("C++ 教程");
        assertTrue(out.contains("C%2B%2B"));
        assertTrue(out.contains("%20") || out.contains("+"));
    }

    // -------------------------------------------------- 与桌面端同名同值域

    @Test
    public void 配置字段与桌面端同名() {
        // 这些键名必须与桌面端 settings.js 的 mobile 块一致。
        // 对不上就会出现「两端说法不一致」的功能分歧。
        Map<String, String> m = new HashMap<>(new NovaSettings().toMap());
        for (String key : Arrays.asList(
            "homepage", "newTabPage", "defaultEngine", "restoreSession",
            "layout", "theme", "adblockEnabled", "noImage",
            "autoPage", "autoPageMax", "searchTemplateId", "customSearch")) {
            assertTrue("少了配置项 " + key, m.containsKey(key));
        }
    }

    @Test
    public void 无图档位值域与桌面端一致() {
        // off / image / image-av 三个字符串，两端必须逐字相同
        Map<String, String> m = new HashMap<>();
        for (String lv : Arrays.asList("off", "image", "image-av")) {
            m.put("noImage", lv);
            assertEquals(lv, NovaSettings.fromMap(m).noImage);
        }
    }

    @Test
    public void 页数上限与桌面端一致() {
        // 5 / 10 / 20
        Map<String, String> m = new HashMap<>();
        for (int n : new int[]{5, 10, 20}) {
            m.put("autoPageMax", String.valueOf(n));
            assertEquals(n, NovaSettings.fromMap(m).autoPageMax);
        }
    }

    // ------------------------------------------------------------ 名单解析

    @Test
    public void 解析媒体后缀() {
        java.util.Set<String> exts = MediaRegistry.parseMediaExts(Arrays.asList(
            "# 媒体后缀表",
            "",
            "video mp4",
            "video webm",
            "audio mp3",
            "stream m3u8",
            "坏行只有一列"));
        assertTrue(exts.contains("mp4"));
        assertTrue(exts.contains("webm"));
        assertTrue(exts.contains("mp3"));
        assertTrue(exts.contains("m3u8"));
        assertEquals(4, exts.size());
    }

    @Test
    public void 解析域名并读回跳过条数() {
        MediaRegistry.Hosts h = MediaRegistry.parseAdblockHosts(Arrays.asList(
            "# 从桌面端同步，已跳过 64 条带路径或选项的规则",
            "ads.example.com",
            "tracker.example.net"));
        assertEquals(2, h.hosts.size());
        // 这个数字要显示给用户，不能由 Java 侧另算一遍（另算就是第二份真相）
        assertEquals(64, h.skipped);
    }

    @Test
    public void 域名匹配命中自身与父域() {
        MediaRegistry r = new MediaRegistry(
            new java.util.HashSet<>(),
            new java.util.HashSet<>(Arrays.asList("doubleclick.net", "ads.example.com")),
            0, "");
        assertTrue(r.isBlockedHost("doubleclick.net"));
        assertTrue(r.isBlockedHost("ad.doubleclick.net"));
        assertTrue(r.isBlockedHost("www.doubleclick.net"));
        assertTrue(r.isBlockedHost("ads.example.com"));
        assertFalse(r.isBlockedHost("example.com"));
        assertFalse(r.isBlockedHost(null));
    }

    @Test
    public void 域名匹配不是子串匹配() {
        // "notads.example.com" 不该被 "ads.example.com" 命中 ——
        // 子串匹配会误伤大量正常站点。
        MediaRegistry r = new MediaRegistry(
            new java.util.HashSet<>(),
            new java.util.HashSet<>(Arrays.asList("ads.example.com")), 0, "");
        assertFalse(r.isBlockedHost("notads.example.com"));
        assertFalse(r.isBlockedHost("example.com"));
    }

    @Test
    public void 空名单等于不拦() {
        // 解析失败时的兜底是空表，不是内置兜底名单 ——
        // 自己编一份兜底会悄悄变成第二份真相。
        MediaRegistry r = new MediaRegistry(
            new java.util.HashSet<>(), new java.util.HashSet<>(), 0, "读失败");
        assertFalse(r.isBlockedHost("ads.doubleclick.net"));
        assertFalse(r.loaded());
        assertTrue(r.mediaExts().isEmpty());
    }
}