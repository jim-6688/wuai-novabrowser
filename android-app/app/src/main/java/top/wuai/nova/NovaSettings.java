package top.wuai.nova;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 吾爱Nova浏览器 · 移动版配置。
 *
 * <p>配置项刻意与桌面版 {@code src/main/settings.js} 的 {@code mobile} 配置块同名同值域，
 * 这样两端的说法是一致的：{@code noImage} 都是 off / image / image-av，
 * {@code autoPageMax} 都是 5 / 10 / 20。
 *
 * <p>序列化用扁平 {@code Map<String,String>}，不用 JSON：落到 SharedPreferences 就是
 * 一组键值，读回来是一组键值，中间没有任何一层需要解析。副作用是它天然可单测 ——
 * 传一个 HashMap 进去就能验，不需要 Android 环境。
 */
public final class NovaSettings {

    public static final String KEY = "nova.settings.";
    /**
     * 主题键。单独提出来是因为 {@code MainActivity.attachBaseContext} 要在
     * 完整加载设置之前单独读它（那个时机比 onCreate 还早），三处引用同一个字面量
     * 的话，改键名时漏一处就是「主题切换突然不生效」且没有任何报错。
     */
    public static final String K_THEME = "theme";

    public String homepage = "https://52ta.top/";
    /** homepage | blank */
    public String newTabPage = "homepage";
    /**
     * 已废弃：移动版不再提供内核选择。
     *
     * <p>保留字段与读写，只为了不把老配置里的这个键读成 null。界面里不再出现它。
     * 刻意<b>不删</b>：删掉之后老用户的 SharedPreferences 里会留一个野键，
     * 下次读回来又是 null，看起来像是新功能没生效。
     */
    public String defaultEngine = "chromium";
    public boolean restoreSession = true;
    /** auto | desktop | mobile */
    public String layout = "auto";
    /** system | light | dark */
    public String theme = "system";
    public boolean adblockEnabled = true;
    /** off | image | image-av */
    public String noImage = "off";
    public boolean autoPage = false;
    public int autoPageMax = AutoPage.DEFAULT_MAX_PAGES;
    public String searchTemplateId = "baidu";
    public String customSearch = "";

    // ---- 新增：下载
    /** 下载并行分片数。1 表示不并发。 */
    public int downloadThreads = 4;
    /** 下载完成后是否用系统通知提示 */
    public boolean downloadNotify = true;
    /** 嗅探到媒体链接时是否自动交给下载（关掉则只提示） */
    public boolean autoDownload = false;
    /** 保留的下载记录条数上限，超出后删最旧的 */
    public int downloadHistoryMax = 50;

    // ---- 新增：插件
    /** 是否注入用户脚本 */
    public boolean pluginsEnabled = true;
    /** 安装插件时是否要求确认 */
    public boolean pluginConfirm = true;

    // ---- 新增：拦截规则
    /** 更新订阅时是否自动（关掉则只手动点） */
    public boolean rulesAutoUpdate = false;

    // ---- 新增：应用更新
    /**
     * 发现新版是否直接后台下载。
     *
     * <p>默认开 —— 这就是「主流浏览器」的做法：发现新版不再问「要不要下载」，
     * 直接下完再告诉你「重启即可」。关掉它才退回逐个询问的老行为。
     */
    public boolean updateAuto = true;
    /**
     * 是否只在 Wi-Fi 下自动下载更新包。
     *
     * <p>默认开。一个用户没主动要的下载却吃掉几百 MB 流量，是这类「自动更新」
     * 最容易招骂的地方 —— 而更新包本身只有几 MB，等一个 Wi-Fi 的代价很小。
     */
    public boolean updateWifiOnly = true;

    // ---- 新增：隐私与浏览
    /** 无痕模式：退出时不留会话 */
    public boolean incognito = false;
    /** 关闭页面时是否清 Cookie 与缓存 */
    public boolean clearOnExit = false;

    // ---- 新增：高级
    /** 自定义 UA。空字符串表示用系统默认。 */
    public String customUA = "";
    /** 是否开启图片缩放（按流量优先则关） */
    public boolean loadImages = true;
    /** 强制 https（明文链接自动升级） */
    public boolean forceHttps = false;

    /** 搜索模板。与桌面版一样给三个预设 + 自定义。 */
    public static final class SearchTemplate {
        public final String id;
        public final String label;
        /** {@code %s} 会被替换成编码后的关键词 */
        public final String url;

        SearchTemplate(String id, String label, String url) {
            this.id = id;
            this.label = label;
            this.url = url;
        }

        public String build(String query) {
            // 用 java.net.URLEncoder 而不是 android.net.Uri.encode：后者是框架类，
            // 在本地 JVM 单元测试里一调就抛 Stub!，整个配置类就没法离线验证了。
            try {
                return url.replace("%s", java.net.URLEncoder.encode(query, "UTF-8"));
            } catch (java.io.UnsupportedEncodingException e) {
                return url.replace("%s", query);
            }
        }
    }

    public static SearchTemplate[] templates() {
        return new SearchTemplate[]{
            new SearchTemplate("baidu", "百度", "https://www.baidu.com/s?wd=%s"),
            new SearchTemplate("bing", "必应", "https://www.bing.com/search?q=%s"),
            new SearchTemplate("google", "Google", "https://www.google.com/search?q=%s"),
            NAV_52TA,
        };
    }

    /**
     * 吾爱导航（52ta.top）搜索模板。
     *
     * <p>它同时兼两个角色：一是可以像别的模板一样在设置里被选为地址栏的搜索引擎，
     * 二是底部胶囊搜索框<b>固定</b>用它（与用户选了哪个搜索引擎无关）。
     *
     * <p>做成公开静态常量而不是每次都从 {@link #templates()} 里捞：
     * 胶囊搜索框只要「那一个」模板，直接引用常量最直白；而且网址格式
     * （{@code action="/all/"} + {@code name="q"}）全工程只有这一处字面量，
     * 站点改了只改这里。
     *
     * <p>注意：把 {@code NAV_52TA} 放进 {@link #templates()} 并<b>不</b>改变默认值 ——
     * {@code searchTemplateId} 默认仍是 {@code baidu}，而 {@link #searchTemplate()}
     * 的兜底取的是 {@code templates()[0]}，也就是百度。
     */
    public static final SearchTemplate NAV_52TA =
        new SearchTemplate("nav52ta", "吾爱导航", "https://52ta.top/all/?q=%s");

    public SearchTemplate searchTemplate() {
        if ("custom".equals(searchTemplateId) && !customSearch.trim().isEmpty()) {
            return new SearchTemplate("custom", "自定义", customSearch.trim());
        }
        for (SearchTemplate t : templates()) {
            if (t.id.equals(searchTemplateId)) return t;
        }
        return templates()[0];
    }

    /**
     * 把地址栏输入变成可以加载的地址：像网址就补协议，否则交给搜索引擎。
     */
    public String resolveInput(String raw) {
        String input = raw == null ? "" : raw.trim();
        if (input.isEmpty()) return homepage;
        if (input.matches("^[a-zA-Z][a-zA-Z0-9+.\\-]*:.*")) return input;
        // 含空格的一律当搜索词；否则看它像不像域名
        if (!input.contains(" ") && input.matches("^[^\\s/]+\\.[^\\s/]{2,}.*")) {
            return "https://" + input;
        }
        return searchTemplate().build(input);
    }

    public Map<String, String> toMap() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("homepage", homepage);
        m.put("newTabPage", newTabPage);
        m.put("defaultEngine", defaultEngine);
        m.put("restoreSession", String.valueOf(restoreSession));
        m.put("layout", layout);
        m.put(K_THEME, theme);
        m.put("adblockEnabled", String.valueOf(adblockEnabled));
        m.put("noImage", noImage);
        m.put("autoPage", String.valueOf(autoPage));
        m.put("autoPageMax", String.valueOf(autoPageMax));
        m.put("searchTemplateId", searchTemplateId);
        m.put("customSearch", customSearch);
        m.put("downloadThreads", String.valueOf(downloadThreads));
        m.put("downloadNotify", String.valueOf(downloadNotify));
        m.put("autoDownload", String.valueOf(autoDownload));
        m.put("downloadHistoryMax", String.valueOf(downloadHistoryMax));
        m.put("pluginsEnabled", String.valueOf(pluginsEnabled));
        m.put("pluginConfirm", String.valueOf(pluginConfirm));
        m.put("rulesAutoUpdate", String.valueOf(rulesAutoUpdate));
        m.put("updateAuto", String.valueOf(updateAuto));
        m.put("updateWifiOnly", String.valueOf(updateWifiOnly));
        m.put("incognito", String.valueOf(incognito));
        m.put("clearOnExit", String.valueOf(clearOnExit));
        m.put("customUA", customUA);
        m.put("loadImages", String.valueOf(loadImages));
        m.put("forceHttps", String.valueOf(forceHttps));
        return m;
    }

    public static NovaSettings fromMap(Map<String, String> m) {
        NovaSettings s = new NovaSettings();
        if (m == null) return s;
        String v;
        if (nonEmpty(v = m.get("homepage"))) s.homepage = v.trim();
        s.newTabPage = oneOf(m.get("newTabPage"), new String[]{"homepage", "blank"}, s.newTabPage);
        // 已废弃项：照样读，但读出来也没人用。留着是为了不把老配置读成 null。
        s.defaultEngine = oneOf(m.get("defaultEngine"),
            new String[]{"chromium", "gecko", "trident"}, s.defaultEngine);
        s.restoreSession = bool(m.get("restoreSession"), s.restoreSession);
        s.layout = oneOf(m.get("layout"), new String[]{"auto", "desktop", "mobile"}, s.layout);
        s.theme = oneOf(m.get(K_THEME), new String[]{"system", "light", "dark"}, s.theme);
        s.adblockEnabled = bool(m.get("adblockEnabled"), s.adblockEnabled);
        s.noImage = NoImagePolicy.Level.fromId(m.get("noImage")).id;
        s.autoPage = bool(m.get("autoPage"), s.autoPage);
        // 页数上限只认规范里的三档，读到别的值一律拉回默认 —— 配置文件是可以被手改的
        s.autoPageMax = AutoPage.clampMax(intOf(m.get("autoPageMax"), s.autoPageMax));
        if (nonEmpty(v = m.get("searchTemplateId"))) s.searchTemplateId = v;
        if (m.get("customSearch") != null) s.customSearch = m.get("customSearch");

        // 并行数夹到 1–16：0 会让 Downloader 的线程池起不来，
        // 而一个手改的 SharedPreferences 里出现 0 完全可能。
        s.downloadThreads = clamp(intOf(m.get("downloadThreads"), s.downloadThreads), 1, 16);
        s.downloadNotify = bool(m.get("downloadNotify"), s.downloadNotify);
        s.autoDownload = bool(m.get("autoDownload"), s.autoDownload);
        s.downloadHistoryMax = clamp(intOf(m.get("downloadHistoryMax"), s.downloadHistoryMax),
            5, 500);
        s.pluginsEnabled = bool(m.get("pluginsEnabled"), s.pluginsEnabled);
        s.pluginConfirm = bool(m.get("pluginConfirm"), s.pluginConfirm);
        s.rulesAutoUpdate = bool(m.get("rulesAutoUpdate"), s.rulesAutoUpdate);
        // 这两个默认都是 true：老配置里没有这两个键，bool() 会走 fallback，
        // 于是升级上来的用户直接就获得了「后台自动下载」的新行为 —— 这正是本轮的目的。
        s.updateAuto = bool(m.get("updateAuto"), s.updateAuto);
        s.updateWifiOnly = bool(m.get("updateWifiOnly"), s.updateWifiOnly);
        s.incognito = bool(m.get("incognito"), s.incognito);
        s.clearOnExit = bool(m.get("clearOnExit"), s.clearOnExit);
        if (m.get("customUA") != null) s.customUA = m.get("customUA");
        s.loadImages = bool(m.get("loadImages"), s.loadImages);
        s.forceHttps = bool(m.get("forceHttps"), s.forceHttps);
        return s;
    }

    public NoImagePolicy.Level noImageLevel() {
        return NoImagePolicy.Level.fromId(noImage);
    }

    private static boolean nonEmpty(String v) { return v != null && !v.trim().isEmpty(); }

    private static boolean bool(String v, boolean fallback) {
        if ("true".equals(v)) return true;
        if ("false".equals(v)) return false;
        return fallback;
    }

    private static int intOf(String v, int fallback) {
        try {
            return Integer.parseInt(v);
        } catch (Exception e) {
            return fallback;
        }
    }

    private static String oneOf(String v, String[] allowed, String fallback) {
        if (v != null) {
            for (String a : allowed) {
                if (a.equals(v)) return v;
            }
        }
        return fallback;
    }

    private static int clamp(int v, int lo, int hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    }
}
