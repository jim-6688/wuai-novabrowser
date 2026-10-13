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
 * 替用户做的决定。本类反过来：清单随包内置，但<b>一条都不装</b>，用户想要哪个
 * 自己点。两者默认行为正好相反（一个默认装、一个默认不装），所以没有合并成
 * 一个类 —— 合并之后这两种语义会挤在同一个 MANIFEST 上，迟早被改错一处。
 *
 * <h3>为什么脚本本体不入包，只给地址现下</h3>
 *
 * <p>三条理由，按重要性排：
 * <ol>
 *   <li><b>版权</b>。随包分发第三方脚本要过许可这道关。内置那条「网页限制解除」
 *       能用，是因为它恰好是 LGPLv3（明确允许再分发）。而 Greasy Fork 上大量
 *       脚本没有声明许可、或只写「保留所有权利」—— 那些<b>不能</b>打进 APK。
 *       只存地址就绕开了这个问题：下载发生在用户自己的设备上，为的是他自己的使用。</li>
 *   <li><b>体积</b>。本包 release 只有 386KB，塞十个脚本进来是另一个量级。</li>
 *   <li><b>时效</b>。脚本作者随时更新，随包的那份从发版起就冻结了。</li>
 * </ol>
 *
 * <h3>入选门槛（两道，与 BuiltinScripts 同一套）</h3>
 *
 * <p>第一道是<b>引擎跑不跑得起来</b>，这是硬门槛：本引擎不提供任何 {@code GM_*}
 * 特权接口，也做不到 {@code @run-at document-start}。所以依赖
 * {@code GM_xmlhttpRequest}（跨域请求）、{@code GM_setValue}（持久化配置）、
 * {@code GM_registerMenuCommand}（脚本菜单）的脚本<b>一律不入清单</b>。
 * 装上只会静默失败 —— 用户以为装了个好用的东西、实际什么都没发生、
 * 还怪浏览器有 bug，<b>那比不提供更糟</b>。
 *
 * <p>被这一条筛掉的真实例子：
 * <ul>
 *   <li>AC-Baidu 净化搜索（Greasy Fork 总安装量第一，约 342 万）——
 *       依赖 {@code GM_xmlhttpRequest} 与 {@code GM_setValue}。</li>
 *   <li>网页翻译器（573432）—— 明确声明了 5 个 GM 接口。</li>
 *   <li>知乎增强（419081）的功能开关挂在 Tampermonkey 右上角菜单上，
 *       即 {@code GM_registerMenuCommand}。它默认全开、能跑一部分，
 *       但「关不掉」意味着用户遇到误伤时没有退路，故也不入。</li>
 * </ul>
 *
 * <p>第二道是<b>口碑</b>：安装量与评分。
 *
 * <h3>关于 {@link Item#verified}</h3>
 *
 * <p>{@code verified} 表示「这条的 {@code @grant} 声明已人工确认过」。本清单是在
 * 无网络环境下整理的，多数条目<b>无法在包内逐个验证</b>，所以它们标 {@code false}。
 * 这不是「大概不能用」，而是「没确认过」—— 界面必须把这两者分开显示
 * （已验证 / 未验证），不能让用户以为未验证等于不能用。
 *
 * <p>真正的兜底在安装那一刻：{@link ScriptInstaller} 会把下载到的脚本交给
 * {@link UserScript#parse} 过一遍，那里会读出<b>真实的</b> {@code @grant}
 * 并明确告诉用户「这个脚本要了 N 项本引擎不提供的权限」。
 * 也就是说，未验证项会在用户点下安装的那一秒变成已验证。
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
        /** 许可标识，如 {@code MIT}；未知就写「未声明」。 */
        public final String license;
        /** 一句话说明它干什么，直接显示给用户。 */
        public final String desc;
        /** Greasy Fork 上的脚本 ID。 */
        public final long scriptId;
        /** 直链路径里的文件名部分（通常是脚本名，可含中文）。 */
        public final String fileName;
        /** {@code @grant} 声明是否已人工确认。 */
        public final boolean verified;
        /** 已知限制，安装前要告诉用户；没有就空串。 */
        public final String caution;

        Item(String key, Category category, String name, String author, String license,
             String desc, long scriptId, String fileName, boolean verified, String caution) {
            this.key = key;
            this.category = category;
            this.name = name;
            this.author = author;
            this.license = license;
            this.desc = desc;
            this.scriptId = scriptId;
            this.fileName = fileName;
            this.verified = verified;
            this.caution = caution;
        }

        /** 面板上显示的那行来源。 */
        public String credit() {
            return author + " · " + license;
        }
    }

    private static Item it(String key, Category c, String name, String author, String license,
                           String desc, long id, String file, boolean verified, String caution) {
        return new Item(key, c, name, author, license, desc, id, file, verified, caution);
    }

    /**
     * 清单。
     *
     * <p>顺序即显示顺序：同一分类内按推荐程度排，最值得先试的放前面。
     */
    public static final List<Item> ALL = Collections.unmodifiableList(Arrays.asList(

        // ---------------------------------------------------- 广告与干扰清理
        it("dom-cleaner", Category.AD_CLEAN,
            "通用 DOM 清理器", "dazi", "MIT",
            "按站点规则清理广告与干扰区块，覆盖腾讯视频、腾讯网、腾讯邮箱、新浪财经、"
                + "新浪新闻、搜狐、微博、百度网盘、雪球、ChatGPT 等。纯 DOM 操作，无需特权。",
            584494L, "通用 DOM 清理器", true, ""),

        it("page-simplify", Category.AD_CLEAN,
            "全页面精简", "未署名", "未声明",
            "去除各大网站广告、优化界面布局、自动展开全文、移除登录弹窗。",
            464665L, "全页面精简", false,
            "未在本机确认 @grant 声明，安装时会自动检测并提示。"),

        // ---------------------------------------------------- 视频与媒体增强
        it("bilibili-enhance", Category.MEDIA,
            "哔哩哔哩增强", "未署名", "未声明",
            "B 站页面增强：视频下载、自动跳过片头片尾、画质与倍速调整等。",
            395575L, "哔哩哔哩增强", false,
            "未在本机确认 @grant 声明。下载类功能常依赖 GM_xmlhttpRequest，"
                + "若安装时提示有特权请求，说明本引擎跑不了那部分。"),

        it("m3u8-downloader", Category.MEDIA,
            "M3U8 下载器", "未署名", "未声明",
            "嗅探页面里的 m3u8 地址，支持加密视频下载与多线程加速。",
            449581L, "M3U8 下载器", false,
            "未在本机确认 @grant 声明，且本类脚本高度依赖跨域请求能力，"
                + "在本引擎上失败的概率较大 —— 请以安装时的检测结果为准。"),

        // ---------------------------------------------------- 内容平台增强
        it("csdn-clean", Category.SITE,
            "CSDN 优化与美化", "未署名", "未声明",
            "去除 CSDN 广告、优化页面布局、自动展开文章、解除复制限制。",
            471071L, "CSDN 优化与美化", false,
            "未在本机确认 @grant 声明，安装时会自动检测并提示。"),

        // ---------------------------------------------------- 全域功能
        it("text-select", Category.UTILITY,
            "文本选择增强", "未署名", "未声明",
            "解除右键、选择与复制限制，去除复制时追加的小尾巴，支持自定义快捷键。",
            428960L, "文本选择增强", false,
            "与随包内置的「网页限制解除」功能重叠，两者同时启用可能互相干扰，"
                + "建议只留一个。"),

        // ---------------------------------------------------- 翻译
        it("dict-lookup", Category.TRANSLATE,
            "划词翻译 · 多词典查询", "barrer", "Apache-2.0",
            "选中文字后弹出面板，调用有道、金山词霸、必应词典、谷歌翻译等多个词典查询。"
                + "以弹窗/面板方式展示，不依赖跨域请求。",
            376313L, "划词翻译-多词典查询", false,
            "未在本机确认 @grant 声明。本引擎只支持 document-end 注入，"
                + "划词面板在页面加载后才挂载，首次划词可能需要先让页面加载完。"),

        it("translate-popup", Category.TRANSLATE,
            "Translate（划词/弹窗翻译）", "barrer", "Apache-2.0",
            "老牌翻译脚本：划词调用金山词霸、有道、谷歌、搜狗、必应、DeepL、百度等"
                + "十余个词典与搜索引擎。",
            34921L, "Translate", false,
            "未在本机确认 @grant 声明。该脚本以 window.open 弹窗方式展示结果，"
                + "而 WebView 默认拦截 window.open，可能需要额外配置才能生效。")
    ));

    /**
     * 拼出 Greasy Fork 的直链。
     *
     * <p>用 {@code update.greasyfork.org} 而不是脚本页面地址：前者直接返回
     * {@code .user.js} 正文，后者是一张 HTML 页面（要再抓一次才能拿到源码）。
     *
     * <p>文件名段按 RFC 3986 逐字节百分号编码。<b>不能</b>用
     * {@code URLEncoder.encode}：那个是为表单设计的，会把空格编成 {@code +}，
     * 而 {@code +} 在 URL 路径里是字面加号 —— 中文脚本名一旦含空格，
     * 拼出来的地址就指向一个不存在的文件，表现为 404 而看不出原因。
     */
    public static String installUrl(Item item) {
        return "https://update.greasyfork.org/scripts/" + item.scriptId + "/"
            + pathEncode(item.fileName) + ".user.js";
    }

    /** 给人看的脚本主页地址。 */
    public static String homeUrl(Item item) {
        return "https://greasyfork.org/zh-CN/scripts/" + item.scriptId;
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
     * {@link ScriptInstaller} 落盘时把来源写成了它，所以这里能对上。
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
}
