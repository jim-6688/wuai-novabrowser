package top.wuai.nova;

import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 吾爱Nova浏览器 · 移动版的「同步资产」。
 *
 * <p>数据全部由 {@code npm run mobile:sync} 从桌面端源码生成，落在 assets 下：
 * <ul>
 *   <li>{@code media-ext.txt}     ← src/main/sniffer.js 的 EXT_TABLE</li>
 *   <li>{@code adblock-hosts.txt} ← src/main/adblock-lists.js 的内置网络规则</li>
 * </ul>
 *
 * <p>格式刻意选**纯文本行**而不是 JSON：Android 侧读一行拆一行就够了，
 * 于是不用引 JSON 库，本地单元测试也不用给 Android 框架里那个空壳 org.json 打桩。
 *
 * <p>解析失败的兜底做得**很窄**：媒体后缀空了，就只剩「无图」档可用（最高档失效）；
 * 域名空了，就等于不拦。宁可功能少一点，也不自己编一份名单顶上 ——
 * 那种「兜底名单」会悄悄变成第二份真相，以后没人知道哪份在生效。
 */
public final class MediaRegistry {

    public static final String MEDIA_ASSET = "media-ext.txt";
    public static final String ADBLOCK_ASSET = "adblock-hosts.txt";

    private final Set<String> mediaExts;
    private final Set<String> adblockHosts;
    private final int adblockSkipped;
    private final String loadError;
    /**
     * 用户订阅的域名集合，null 表示没订阅。
     *
     * <p>与内置表<b>并存而不是替换</b>：内置表是随包发的那份小名单，
     * 订阅是用户自己加的。订阅失败时不应该连带把内置的也弄丢。
     */
    private final Set<String> userHosts;
    private final String userSource;
    private final String userStamp;

    public MediaRegistry(Set<String> mediaExts, Set<String> adblockHosts,
                         int adblockSkipped, String loadError) {
        this(mediaExts, adblockHosts, adblockSkipped, loadError, null, "", "");
    }

    public MediaRegistry(Set<String> mediaExts, Set<String> adblockHosts,
                         int adblockSkipped, String loadError,
                         Set<String> userHosts, String userSource, String userStamp) {
        this.mediaExts = Collections.unmodifiableSet(mediaExts);
        this.adblockHosts = Collections.unmodifiableSet(adblockHosts);
        this.adblockSkipped = adblockSkipped;
        this.loadError = loadError == null ? "" : loadError;
        this.userHosts = userHosts == null ? null
            : Collections.unmodifiableSet(new HashSet<>(userHosts));
        this.userSource = userSource == null ? "" : userSource;
        this.userStamp = userStamp == null ? "" : userStamp;
    }

    public Set<String> mediaExts() { return mediaExts; }
    public Set<String> adblockHosts() { return adblockHosts; }
    public int adblockSkipped() { return adblockSkipped; }
    public String loadError() { return loadError; }
    public boolean loaded() { return loadError.isEmpty(); }

    /** 生效的域名总数（内置 + 订阅）。界面上要显示的是这个，不是内置那一半。 */
    public int totalHosts() {
        return adblockHosts.size() + (userHosts == null ? 0 : userHosts.size());
    }

    public boolean hasUserRules() { return userHosts != null && !userHosts.isEmpty(); }
    public String userSource() { return userSource; }
    public String userStamp() { return userStamp; }

    /**
     * 解析媒体后缀表。每行 {@code <kind> <ext>}，{@code #} 开头是注释。
     */
    public static Set<String> parseMediaExts(List<String> lines) {
        Set<String> out = new HashSet<>();
        if (lines == null) return out;
        for (String raw : lines) {
            String line = raw == null ? "" : raw.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            String[] parts = line.split("\\s+");
            if (parts.length < 2) continue;
            out.add(parts[1].toLowerCase(Locale.ROOT));
        }
        return out;
    }

    /**
     * 解析域名黑名单。每行一个域名，{@code #} 开头是注释。
     *
     * <p>顺带把源名单里被跳过的条数从注释里读出来 —— 那个数字要显示给用户看，
     * 不能由 Java 侧另算一遍（另算就是第二份真相）。
     */
    public static Hosts parseAdblockHosts(List<String> lines) {
        Hosts h = new Hosts();
        if (lines == null) return h;
        for (String raw : lines) {
            String line = raw == null ? "" : raw.trim();
            if (line.isEmpty()) continue;
            if (line.startsWith("#")) {
                int i = line.indexOf("已跳过 ");
                if (i >= 0) {
                    StringBuilder digits = new StringBuilder();
                    for (int k = i + 4; k < line.length(); k++) {
                        char c = line.charAt(k);
                        if (c >= '0' && c <= '9') digits.append(c);
                        else break;
                    }
                    if (digits.length() > 0) h.skipped = Integer.parseInt(digits.toString());
                }
                continue;
            }
            h.hosts.add(line.toLowerCase(Locale.ROOT));
        }
        return h;
    }

    /** {@link #parseAdblockHosts} 的产物 */
    public static final class Hosts {
        public final Set<String> hosts = new HashSet<>();
        public int skipped = 0;
    }

    /**
     * 宿主黑名单匹配：命中自身或其任一父域即算命中。
     *
     * <p>只做后缀匹配，不做路径匹配 —— 源名单里能抽出来的就只有域名，
     * 拿域名去套路径匹配等于把规则放宽成「整站全拦」，那是另一回事。
     *
     * <p>实现在 {@link RuleSet#matches}，那里把「为什么不用 endsWith」
     * 写清楚了（{@code notexample.com} 会被 {@code example.com} 误杀）。
     */
    public boolean isBlockedHost(String host) {
        if (host == null) return false;
        if (RuleSet.matches(adblockHosts, host)) return true;
        return userHosts != null && RuleSet.matches(userHosts, host);
    }
}
