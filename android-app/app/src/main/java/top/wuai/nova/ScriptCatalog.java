package top.wuai.nova;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * 吾爱Nova浏览器 · 可选脚本库（推荐脚本清单）。
 *
 * <h3>它跟 {@link BuiltinScripts} 的区别，是这个类存在的全部理由</h3>
 *
 * <p>{@code BuiltinScripts} 是「随包发布 + 首次启动自动装上」—— 那是浏览器
 * 替用户做的决定。本类反过来：清单随包内置，<b>一条都不装</b>，用户想要哪个
 * 自己点。两者默认行为正好相反，所以没有合并成一个类 —— 合并之后这两种语义
 * 会挤在同一个 MANIFEST 上，迟早被改错一处。
 *
 * <h3>为什么源是脚本猫，而不是 Greasy Fork</h3>
 *
 * <p>本清单原先指向 {@code update.greasyfork.org}。那个域名在国内网络下
 * <b>整条链路都断了</b>：系统 DNS 把它解析到 Facebook 的 IPv6 段与一个停放 IP
 * （典型的污染返回），换真实 IP 直连同样超时 —— 也就是说，这不是一个
 * 「有时候慢」的地址，而是一个恒定不可达的地址。表现是清单看得见、
 * 「安装」按钮点得动、然后每次都失败，而失败原因写得再准确也没用，
 * 因为用户除了放弃没有别的选择。
 *
 * <p>换成 <a href="https://scriptcat.org">脚本猫</a> 的理由是三条叠在一起：
 *
 * <ol>
 *   <li><b>可达</b>。同一台机器上直连实测：脚本猫 2.9 秒握手成功，
 *       Greasy Fork 12 秒无响应。一个装不上的库，条目选得再好也是零。</li>
 *   <li><b>中文圈的口碑数据是真的</b>。脚本猫公开每条脚本的累计安装量，
 *       所以「为什么是这几条」有据可查，而不是凭印象挑。
 *       下面的清单按安装量排序，每条的 {@code installs} 就是当时的读数。</li>
 *   <li><b>它能自己讲清授权</b>。条目里带 {@code @license}，
 *       于是「哪几条可以随包分发、哪几条只能在线装」有事实依据，
 *       不用靠猜 —— 见下面 {@link Item#bundled}。</li>
 * </ol>
 *
 * <h3>为什么要分「已内置」和「需联网」两类</h3>
 *
 * <p>换成可达的源解决了「有网时能装」，但没解决「没网时一条都装不上」。
 * 所以能不能随包分发，取决于脚本自己的许可：
 *
 * <ul>
 *   <li>许可明确允许再分发的（MIT / GPL-3.0 等），正文打进
 *       {@code assets/user-scripts/catalog/}，点「安装」直接从安装包读，
 *       <b>整个过程不碰网络</b>。这类条目标 {@link Item#bundled}。</li>
 *   <li>没写许可或写了「保留所有权利」的，<b>只能在线装</b>。
 *       这不是偷懒 —— 随包分发第三方代码要过许可这道关，
 *       而「它没写许可」跟「它允许我分发」是两件事。</li>
 * </ul>
 *
 * <p>两类混在一份清单里，所以界面必须把它们分开显示。用户有权在点下去之前
 * 就知道「这条现在就能装」还是「这条得先有网」。
 *
 * <h3>入选门槛（三道，比原先多一道）</h3>
 *
 * <p>第一道是<b>引擎跑不跑得起来</b>，硬门槛：本引擎的 {@code GM_} 支持集
 * 只有 {@link GmShim#SUPPORTED} 那六项，且做不到 {@code @run-at document-start}
 * （原因见 {@link UserScript}）。所以依赖 {@code GM_xmlhttpRequest}、
 * {@code GM_setValue}、{@code GM_registerMenuCommand} 的脚本一律不入清单 ——
 * 装上只会静默失败，那<b>比不提供更糟</b>：用户以为装了个好用的东西，
 * 实际什么都没发生，最后怪浏览器有 bug。
 *
 * <p>每条脚本声明的 {@code @grant} 都记在 {@link Item#grants} 里，
 * 由 {@code ScriptCatalogTest} 对着 {@link GmShim#SUPPORTED} 逐条核。
 * 这条不是风格偏好，是这个清单唯一能自证「选品没错」的地方。
 *
 * <p>第二道是<b>口碑</b>：安装量。清单里每条都标了读数。
 *
 * <p>第三道是<b>不碰灰产</b>。脚本猫上安装量最高的那批里有相当一部分是
 * VIP 视频解析、刷课、爬取付费内容一类。它们不是「技术上有问题」，
 * 是<b>不该被一个浏览器作为推荐内容推给用户</b>。这一类整体排除，
 * 不因为安装量高就破例。
 *
 * <h3>关于 {@link Item#caution}</h3>
 *
 * <p>已知限制写在条目上，安装前显示给用户。空串表示没发现限制 ——
 * 而不是「懒得写」。
 */
public final class ScriptCatalog {

    private ScriptCatalog() {}

    /** 清单分类。声明顺序即界面上的显示顺序。 */
    public enum Category {
        AD_CLEAN("广告与干扰清理"),
        MEDIA("视频与媒体增强"),
        SITE("内容平台增强"),
        UTILITY("全域功能"),
        TRANSLATE("翻译");

        public final String label;

        Category(String label) { this.label = label; }
    }

    /** 一份可安装脚本的清单项。 */
    public static final class Item {
        /**
         * 稳定标识，用于「装没装过」的判断。
         *
         * <p>刻意不用脚本 id（{@link UserScript#idOf}）—— 那个是脚本内容的函数，
         * 作者改个名字它就变了，而「这份清单项装过没有」不该跟着变。
         */
        public final String key;
        public final Category category;
        public final String name;
        public final String author;
        /** 许可标识，如 {@code MIT}；脚本没声明就写「未声明」。 */
        public final String license;
        /** 一句话说明它干什么，直接显示给用户。 */
        public final String desc;
        /** 脚本猫上的脚本 ID。展示页与下载地址都由它拼出来。 */
        public final long scriptId;
        /** 下载地址路径里的文件名部分（就是脚本名，含中文与表情）。 */
        public final String fileName;
        /** 当时的累计安装量，显示用，也是「凭什么选它」的依据。 */
        public final long installs;
        /**
         * 脚本声明的 {@code @grant} 全量，<b>不含</b> {@code none}。
         *
         * <p>记在清单里而不是在运行时读脚本，是因为<b>没内置的那些根本读不到</b>
         * —— 它们在用户点安装之前不在设备上。而「这条脚本要的权限本引擎给不给得起」
         * 恰恰是选品时唯一该问的问题，必须在有网的状态下就先答掉。
         *
         * <p>空列表表示「它没要任何特权」，也就是脚本头里 {@code @grant none}
         * 或压根没写 {@code @grant} —— 这两件事在 {@link GmShim#unsupported} 那里
         * 是等价的，所以这里也合成一种写法。
         */
        public final List<String> grants;
        /** 正文是否随包内置。true 表示安装全程不碰网络。 */
        public final boolean bundled;
        /** 内置脚本在 assets 里的路径；未内置时是空串。 */
        public final String asset;
        /**
         * 内置脚本正文的 sha256；未内置时是空串。
         *
         * <p>钉住「内置的就是审计过的那一份」。脚本是第三方代码、随包发给
         * 每一个用户，改一个字符就会在测试里红 —— 这不是麻烦，
         * 这正是这个问题唯一的答案。
         */
        public final String sha256;
        /** 已知限制，安装前要告诉用户；没有就空串。 */
        public final String caution;

        Item(String key, Category category, String name, String author, String license,
             String desc, long scriptId, String fileName, long installs,
             List<String> grants, String asset, String sha256, String caution) {
            this.key = key;
            this.category = category;
            this.name = name;
            this.author = author;
            this.license = license;
            this.desc = desc;
            this.scriptId = scriptId;
            this.fileName = fileName;
            this.installs = installs;
            this.grants = Collections.unmodifiableList(new ArrayList<>(grants));
            this.bundled = !asset.isEmpty();
            this.asset = asset;
            this.sha256 = sha256;
            this.caution = caution;
        }

        /** 面板上显示的那行来源：平台 · 作者 · 许可 · 安装量。 */
        public String credit() {
            return "脚本猫 · " + author + " · " + license + " · 装机 " + installsText();
        }

        /** 安装量，超过一万折成「万」，免得那行被数字撑爆。 */
        public String installsText() {
            if (installs >= 10000) {
                return (installs / 1000) / 10.0 + " 万";
            }
            return String.valueOf(installs);
        }
    }

    /** 内置脚本在 assets 里的目录。 */
    static final String ASSET_DIR = "user-scripts/catalog/";

    private static Item bundled(String key, Category c, String name, String author,
                                String license, String desc, long id, String file,
                                long installs, List<String> grants, String sha256,
                                String caution) {
        return new Item(key, c, name, author, license, desc, id, file, installs, grants,
            ASSET_DIR + key + ".user.js", sha256, caution);
    }

    private static Item online(String key, Category c, String name, String author,
                               String license, String desc, long id, String file,
                               long installs, List<String> grants, String caution) {
        return new Item(key, c, name, author, license, desc, id, file, installs, grants,
            "", "", caution);
    }

    private static List<String> g(String... gs) {
        return Arrays.asList(gs);
    }

    /**
     * 清单。
     *
     * <p>顺序即显示顺序：同一分类内按安装量从高到低。
     *
     * <p>安装量是整理这份清单时的读数，不是实时值 —— 它在这里的作用是
     * 「凭什么选它」的证据，不是行情。会随作者更新而变，不必追。
     */
    public static final List<Item> ALL = Collections.unmodifiableList(Arrays.asList(

        // ---------------------------------------------------- 广告与干扰清理
        bundled("auto-expand", Category.AD_CLEAN,
            "自动展开", "airbash", "GPL-3.0",
            "自动展开被折叠的正文、答案与代码块。覆盖 CSDN、简书、知乎、"
                + "百家号、百度系、各大新闻站与博客平台共六十余个站点，PC 与手机同一套规则。",
            725L, "自动展开", 128297L, g(),
            "08b70d6a04976c2bdfad98528557e6883bc5f4e0fae6709af9f8ff96781c2374",
            "它只在列出的站点上生效，不在名单里的站点了没有反应 —— 那是没匹配上，不是坏了。"),

        bundled("adblock-4khd", Category.AD_CLEAN,
            "4khd 广告屏蔽", "Via", "MIT",
            "清理 4khd 及其镜像站上的广告位与浮层。纯样式与 DOM 处理，不劫持请求。",
            4484L, "4khd 广告屏蔽", 20899L, g("unsafeWindow", "GM_addStyle"),
            "60a2fc521968ab260dca58a44073d4b9783c63275ce0f1fe0c85c226e9606fa0",
            "只覆盖 4khd 这几个域名，不是通用广告拦截。全站拦截由内置的广告拦截负责。"),

        online("baidu-ad-filter", Category.AD_CLEAN,
            "屏蔽百度广告及关键字", "linger", "未声明",
            "去掉百度搜索结果里的推广位与指定关键字条目，让首屏回到自然结果。",
            176L, "屏蔽百度广告及关键字", 6143L, g(),
            "只作用于 www.baidu.com 的结果页。"),

        // ---------------------------------------------------- 视频与媒体增强
        bundled("bilibili-save", Category.MEDIA,
            "B站视频下载", "youhou", "MIT",
            "在 B 站视频页加一个下载入口，一键把当前视频存到本地，支持到 4K 画质。",
            5958L, "🎬 B站视频下载器 | bilibili哔哩哔哩视频下载助手📥一键解析保存",
            4243L, g(),
            "04b704b158b4b328c95d221dbc808b899068dfb79b2bc2ccfce41b05327d207f",
            "只在 B 站的视频详情页出现。它读的是页面自身的播放地址，"
                + "所以需要登录/付费才能看的清晰度仍然拿不到。"),

        bundled("video-speed", Category.MEDIA,
            "全网视频倍速", "呀嘻耶耶", "MIT",
            "给任意网站的 video 与 audio 元素加上倍速控制，最高 16 倍。",
            1134L, "所有网站倍速播放", 8446L, g(),
            "af72d112d878e4acfec50324dc9be88ff4d05575a7230912cf1359bbf0ebf7aa",
            "它默认就把播放速度设成 16 倍，并且会自动开始播放 —— 这是脚本自己的设定，"
                + "本引擎没有改。不喜欢的话在插件列表里停用它。"),

        online("video-fit", Category.MEDIA,
            "网页视频全页面适配", "Your name", "未声明",
            "把网页里的视频播放窗口撑满整个页面，顺带把页面上的干扰元素让开。",
            2866L, "网页视频倍速播放器·视频全页面播放适配·视频网页全屏", 10632L, g(),
            "名字里写着「倍速」，但正文做的是全屏适配，没有倍速功能。"),

        // ---------------------------------------------------- 内容平台增强
        online("csdn-reader", Category.SITE,
            "CSDN 沉浸式阅读", "Mr.Chen", "未声明",
            "CSDN 文章页去广告与去推荐位、免登录复制、自动展开收起的代码块，"
                + "并把需要关注才能看的内容直接展开。",
            295L, "CSDN去除收费项、免登录复制、免登录查看需关注的内容、沉浸式阅读", 40172L,
            g("GM_addStyle", "unsafeWindow"),
            "「还原付费下载内容」那部分依赖页面结构，CSDN 改版后可能失效。"),

        bundled("zhihu-clean", Category.SITE,
            "知乎净化", "Assistant", "MIT",
            "自动关掉知乎的登录弹窗与右下角广告弹窗，处理外链安全提示，并恢复被锁住的页面滚动。",
            4687L, "知乎增强：自动关闭登录弹窗、外链跳转与广告弹窗", 10631L, g(),
            "d45c278bc5802b2cbb93e20f4734e9ec761da1d9e42ba6c948a63a4cdc656964",
            "只处理弹窗与滚动，不改内容。"),

        online("douyin-clean", Category.SITE,
            "抖音网页版净化", "雪中明月", "未声明",
            "隐藏抖音网页版的信息流推荐位、直播入口与右侧栏，只留下视频本身。",
            1903L, "抖音净化", 5108L, g(),
            "抖音改版频繁，选择器失效时表现为「什么都没隐藏」。"),

        // ---------------------------------------------------- 全域功能
        bundled("mobile-unlock", Category.UTILITY,
            "移动端限制解除", "Via", "MIT",
            "解除手机网页上的滑动禁止与触控禁止，并移除挡住内容的「请下载 App」弹窗。"
                + "这一条是专为手机浏览器写的。",
            4681L, "移动端限制弹窗解除", 2865L, g("GM_addStyle"),
            "2425424a2464e60c2da38bed9a079a2041125c0734ea2680d3e474a8ba8b39b4",
            "它会在所有网站上运行。若是某个站点因此出现滚动异常，"
                + "先停用这一条再判断是不是它。"),

        online("copy-unlock", Category.UTILITY,
            "解除复制与右键限制", "MERCURY", "未声明",
            "解除网页对选中文字、复制与右键菜单的限制，覆盖所有网站。",
            4231L, "解除网页复制和右键菜单限制", 2473L, g(),
            "与随包内置的「网页限制解除」功能重叠，两者同时启用可能互相干扰，建议只留一个。"),

        // ---------------------------------------------------- 翻译
        online("google-translate", Category.TRANSLATE,
            "整页翻译", "执念e1", "未声明",
            "用 Google 翻译直接把当前页面译成中文，不跳转到翻译站、不改地址。",
            180L, "Google网页翻译", 14148L, g(),
            "翻译时页面会整体重排，脚本类扩展在此期间可能短暂失效；"
                + "需要能访问 Google 的网络环境。")
    ));

    /**
     * 拼出脚本猫的直链。
     *
     * <p>用 {@code /scripts/code/} 而不是脚本展示页地址：前者直接返回
     * {@code .user.js} 正文，后者是一张 HTML 页面（要再抓一次才能拿到源码），
     * 而且 {@link ScriptInstaller} 会把「下回来的是网页」判成失败。
     *
     * <p>文件名段按 RFC 3986 逐字节百分号编码。<b>不能</b>用
     * {@code URLEncoder.encode}：那个是为表单设计的，会把空格编成 {@code +}，
     * 而 {@code +} 在 URL 路径里是字面加号 —— 中文脚本名一旦含空格，
     * 拼出来的地址就指向一个不存在的文件，表现为 404 而看不出原因。
     *
     * <p>脚本名里有表情符号与竖线（真实存在），所以这一段不能省。
     */
    public static String installUrl(Item item) {
        return "https://scriptcat.org/scripts/code/" + item.scriptId + "/"
            + pathEncode(item.fileName) + ".user.js";
    }

    /** 给人看的脚本主页地址。 */
    public static String homeUrl(Item item) {
        return "https://scriptcat.org/script-show-page/" + item.scriptId;
    }

    /**
     * URL 路径段的百分号编码。
     *
     * <p>只保留未保留字符（ALPHA / DIGIT / {@code -._~}），其余一律编成
     * {@code %XX}。中文脚本名会在这里变成一长串 {@code %E9...}，这是对的。
     */
    static String pathEncode(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder();
        for (byte b : s.getBytes(StandardCharsets.UTF_8)) {
            int c = b & 0xFF;
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
                || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~') {
                sb.append((char) c);
            } else {
                sb.append('%').append(String.format("%02X", c));
            }
        }
        return sb.toString();
    }

    /**
     * 由安装来源地址反查清单项；对不上（比如用户自己从文件装的）返回 null。
     *
     * <p>用来回答「这条清单项装过没有」。比的是 {@link #homeUrl} 拼出来的地址 ——
     * 内置与在线两条安装路径落盘时都把来源写成了它，所以这里能对上。
     * 这也是为什么不拿脚本名去比：名字是作者随时会改的东西，改一次判断就失效，
     * 表现是「装过了却还显示可安装」，点下去装出第二份。
     */
    public static Item fromOrigin(String origin) {
        if (origin == null || origin.isEmpty()) return null;
        for (Item it : ALL) {
            if (origin.equals(homeUrl(it))) return it;
        }
        return null;
    }

    /** 按 key 找，找不到返回 null。 */
    public static Item byKey(String key) {
        if (key == null) return null;
        for (Item it : ALL) {
            if (it.key.equals(key)) return it;
        }
        return null;
    }

    /** 某个分类下的条目。 */
    public static List<Item> of(Category c) {
        List<Item> out = new ArrayList<>();
        for (Item it : ALL) {
            if (it.category == c) out.add(it);
        }
        return out;
    }

    /** 随包内置的那些 —— 断网也能装。 */
    public static List<Item> bundledItems() {
        List<Item> out = new ArrayList<>();
        for (Item it : ALL) {
            if (it.bundled) out.add(it);
        }
        return out;
    }
}
