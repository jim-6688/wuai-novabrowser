package top.wuai.nova;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 吾爱Nova浏览器 · 拦截规则的解析与匹配。
 *
 * <p>移动版只吃**域名**这一种规则（理由见 {@link MediaRegistry}）：
 * Android 的 {@code shouldInterceptRequest} 拿不到资源类型，也拿不到「这个请求
 * 是被什么规则拦的」这种信息，能做的只有按主机名匹配。路径级规则在移动版没有
 * 等价实现，硬套等于把规则放宽成「整站全拦」。
 *
 * <p>但「只能吃域名」不等于「只能吃我自己那份域名」。远程订阅同样要能读，
 * 所以这里的解析器处理两类输入：
 * <ul>
 *   <li><b>纯域名列表</b>（一行一个）—— 移动版自己的资产就是这个格式</li>
 *   <li><b>ABP 风格规则</b>（{@code ||ads.example.com^}）—— 远程订阅会给这个</li>
 * </ul>
 * 两者混在一个文件里也没问题，逐行判断就行。
 */
public final class RuleSet {

    /** 一条规则。移动版里只有域名，所以字段比桌面版少得多。 */
    public static final class Rule {
        /** 小写域名，不含 www. 前缀（匹配时会先剥掉） */
        public final String host;
        /** 来源说明，只用于界面上解释「这条是哪来的」 */
        public final String source;

        Rule(String host, String source) {
            this.host = host;
            this.source = source;
        }

        @Override public String toString() { return host; }
    }

    /** 一次解析的完整结果，含被丢弃的条目 —— 界面必须显示它们，否则用户不知道为什么规则数上不去。 */
    public static final class ParseResult {
        public final Set<String> hosts = new LinkedHashSet<>();
        /** 解析不了而跳过的行数 */
        public int unsupported;
        /** 注释与空行数 */
        public int ignored;
        /** 样例：前几条被跳过的行，给界面提示「你的订阅格式不对」用 */
        public final List<String> unsupportedSamples = new ArrayList<>();

        public int size() { return hosts.size(); }
    }

    /**
     * 解析规则文本。
     *
     * <p>接受的行：
     * <ul>
     *   <li>{@code #} 开头 → 注释</li>
     *   <li>空行 → 忽略</li>
     *   <li>{@code 0.0.0.0 ads.com} 或 {@code 127.0.0.1 ads.com}（hosts 格式）</li>
     *   <li>{@code ||ads.com^} / {@code ||ads.com^$script}（ABP 网络规则）</li>
     *   <li>裸域名 {@code ads.com}</li>
     * </ul>
     * 其余（正则规则、元素隐藏规则、路径规则）计为 unsupported 而不是静默丢弃 ——
     * 静默丢弃会让人以为「订阅更新了但就是没效果」。
     */
    public static ParseResult parse(List<String> lines) {
        ParseResult r = new ParseResult();
        if (lines == null) return r;
        for (String raw : lines) {
            String line = raw == null ? "" : raw.trim();
            if (line.isEmpty()) { r.ignored++; continue; }
            if (line.startsWith("#") || line.startsWith("!") || line.startsWith("[")) {
                r.ignored++;
                continue;
            }
            String host = hostFrom(line);
            if (host == null) {
                r.unsupported++;
                if (r.unsupportedSamples.size() < 3) r.unsupportedSamples.add(trim(line));
                continue;
            }
            r.hosts.add(host);
        }
        return r;
    }

    /**
     * 从一行里取出域名，取不到返回 null。
     *
     * <p>顺序是有讲究的：先看是不是 hosts 格式（IP 打头），再看 ABP，最后才当裸域名。
     * 反过来会把 ABP 规则里的垃圾（{@code ##.ad-banner}）当成域名收进去。
     */
    static String hostFrom(String line) {
        String s = line.trim();
        if (s.isEmpty()) return null;

        // 行内注释要在做任何判断之前先剥掉 —— hosts 格式很常见地带行尾注释
        // （"0.0.0.0 ads.com # 广告"），带着它走完流程必然解析失败。
        //
        // 但只在「# 前面确实有域名形状的内容」时才剥：ABP 的元素隐藏规则是
        // "example.com##.ad"，它的 ## 后面跟的是选择器不是注释，
        // 无脑按 # 截断会把 example.com 留下、选择器丢掉，
        // 于是「这条元素规则」变成「拦掉整个 example.com」—— 这是灾难性的误伤。
        // 所以这里只剥「前面有空格或行首」的 #，ABP 的 ## 前面没有空格。
        int hash = firstLooseHash(s);
        if (hash >= 0) s = s.substring(0, hash).trim();
        if (s.isEmpty()) return null;

        // hosts 格式：0.0.0.0 ads.com / 127.0.0.1 ads.com / ::1 ads.com
        // 必须在 isIpLiteral 之前判 —— "0.0.0.0 ads.com" 这一行以 IP 开头，
        // 先走 IP 分支就会被当成「纯 IP 无域名」而丢掉整行。
        if (s.startsWith("0.0.0.0 ") || s.startsWith("127.0.0.1 ")
            || s.startsWith("::1 ")) {
            return cleanHost(s.substring(s.indexOf(' ') + 1).trim());
        }
        // 纯 IP 开头且后面没跟域名：没有域名可匹配
        if (isIpLiteral(s)) return null;

        // ABP 网络规则 ||host^$options
        if (s.startsWith("||")) {
            // 先看整行：只要域名之后还有路径/通配，这条就是路径规则，
            // 移动版没有等价实现，必须整条丢掉。
            // 注意这个判断必须在「截断出域名」之前 ——
            // ||cdn.com/path/ 与 ||cdn.com^ 截断后都是 cdn.com，
            // 在截断之后就分不出这两者了，于是路径规则会被当成「拦整站」，
            // 那会把一个正常的 CDN 站点整个拦掉。
            int delim = s.length();
            for (int i = 2; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c == '^' || c == '$' || c == '/' || c == '|' || c == '*') {
                    delim = i;
                    break;
                }
            }
            char at = s.charAt(delim);
            if (at == '/' || at == '*') return null;

            return cleanHost(s.substring(2, delim));
        }
        // 带路径或通配的（/ads/banner.png、*.example.com）—— 移动版没有等价实现
        if (s.indexOf('/') >= 0) return null;
        if (s.startsWith("*")) return null;
        // 元素隐藏规则 ##.ad / #@#.ad —— 移动版不注入 CSS，拦不了。
        // 必须在剥注释之后判：剥注释只动「前面带空格」的 #，这里的 ## 不受影响。
        if (s.contains("##") || s.contains("#@#") || s.contains("#?#")) return null;
        // @@ 白名单例外 —— 移动版不支持例外规则，整条丢弃更安全
        // （留着会让用户以为「我加了白名单」其实没有）
        if (s.startsWith("@@")) return null;

        return cleanHost(s);
    }

    /**
     * 找出「真正的注释分隔符」的位置，找不到返回 -1。
     *
     * <p>规则：{@code #} 前面必须是行首或空白字符。ABP 的 {@code ##} / {@code #@#}
     * 前面紧贴着域名（{@code example.com##.ad}），所以不会被误当成注释。
     */
    private static int firstLooseHash(String s) {
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) != '#') continue;
            if (i == 0) return i;
            char prev = s.charAt(i - 1);
            if (prev == ' ' || prev == '\t') return i;
        }
        return -1;
    }

    /** 归一化域名：小写、去尾点、剥 www.、去非法字符。 */
    static String cleanHost(String raw) {
        if (raw == null) return null;
        String s = raw.trim().toLowerCase(Locale.ROOT);
        while (s.endsWith(".")) s = s.substring(0, s.length() - 1);
        if (s.startsWith("www.")) s = s.substring(4);
        if (s.isEmpty()) return null;
        // 域名里不该有这些；有就说明这行不是域名
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                || c == '.' || c == '-' || c == '_' || c > 127;
            if (!ok) return null;
        }
        if (s.indexOf('.') < 0) return null;   // 单段（localhost）不拦
        if (s.startsWith(".") || s.endsWith(".")) return null;
        return s;
    }

    static boolean isIpLiteral(String s) {
        boolean dot = s.indexOf('.') >= 0;
        if (dot) {
            String[] parts = s.split("\\.");
            if (parts.length != 4) return false;
            for (String p : parts) {
                if (p.isEmpty() || p.length() > 3) return false;
                for (int i = 0; i < p.length(); i++) {
                    if (p.charAt(i) < '0' || p.charAt(i) > '9') return false;
                }
            }
            return true;
        }
        return s.equals("::1");
    }

    /**
     * 域名匹配：命中自身或任一父域即算命中。
     *
     * <p>父域逐段向上找而不是简单 {@code endsWith}：
     * {@code endsWith} 会让 {@code notexample.com} 因为含 {@code example.com} 而被拦，
     * 这是 Adblock 规则里最经典的一类误杀。
     */
    public static boolean matches(Set<String> hosts, String host) {
        if (host == null || hosts == null || hosts.isEmpty()) return false;
        String h = host.trim().toLowerCase(Locale.ROOT);
        while (h.endsWith(".")) h = h.substring(0, h.length() - 1);
        if (h.startsWith("www.")) h = h.substring(4);
        if (hosts.contains(h)) return true;
        int dot = h.indexOf('.');
        while (dot > 0) {
            if (hosts.contains(h.substring(dot + 1))) return true;
            dot = h.indexOf('.', dot + 1);
        }
        return false;
    }

    // ------------------------------------------------------------ 订阅

    /** 预置订阅源。放在这里而不是让用户从零填，是因为空地址是最常见的卡点。 */
    public static final class Subscription {
        public final String id;
        public final String label;
        public final String url;
        public final String note;

        Subscription(String id, String label, String url, String note) {
            this.id = id;
            this.label = label;
            this.url = url;
            this.note = note;
        }
    }

    public static Subscription[] presets() {
        return new Subscription[]{
            new Subscription("easy", "EasyList（移动版可读部分）",
                "https://easylist.to/easylist/easylist.txt",
                "标准 ABP 订阅。移动版只能取其中的域名规则，"
                + "元素隐藏与路径规则会被跳过（会显示跳过多少条）。"),
            new Subscription("cn", "EasyList China",
                "https://easylist-downloads.adblockplus.org/easylistchina.txt",
                "针对中文站点。包含大量针对国内 CDN 的路径规则，"
                + "移动版只能取域名部分。"),
            new Subscription("ublock", "uBlock Origin 过滤器",
                "https://ublockorigin.github.io/uAssets/filters/filters.txt",
                "规则量大，域名部分覆盖最广。"),
            new Subscription("adguard", "AdGuard DNS 过滤器",
                "https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt",
                "AdGuard 的 DNS 过滤列表，格式接近 hosts，移动版读起来损失最小。"),
        };
    }

    /**
     * 验证用户手填的地址。
     *
     * <p>只放行 http/https：{@code file://} 能读到应用私有目录，
     * {@code content://} 在 WebView 里会抛。这些不该从「订阅地址」进来。
     */
    public static String validateUrl(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return "地址不能为空";
        String lower = s.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            return "地址必须以 http:// 或 https:// 开头";
        }
        if (s.length() < 12) return "地址太短了";
        return "";
    }

    /** 把解析结果转成落盘的纯文本行。 */
    public static List<String> toLines(Set<String> hosts, String stamp, String sourceUrl,
                                       int unsupported) {
        List<String> out = new ArrayList<>();
        out.add("# 吾爱Nova浏览器 · 拦截规则");
        out.add("# 来源：" + sourceUrl);
        out.add("# 更新时间：" + stamp);
        out.add("# 域名 " + hosts.size() + " 条；另有 " + unsupported + " 条规则在移动版未启用"
            + "（元素隐藏与路径规则，Android 侧拿不到资源类型，没有等价实现）");
        out.add("# 用 tools/sync-mobile.js 从桌面端同步或由本机订阅更新生成，勿手改");
        for (String h : hosts) out.add(h);
        return out;
    }

    /** 把文本切成行。统一在这里做，避免每处都写一遍 split 的边界处理。 */
    public static List<String> lines(String text) {
        if (text == null) return new ArrayList<>();
        // 换行符要处理三种：\r\n、\n、以及单独的 \r（老 Mac 格式，
        // 下载来的老规则文件里真的存在）。少一种就会把一整份订阅解析成一行。
        List<String> out = new ArrayList<>(
            Arrays.asList(text.replace("\r\n", "\n").replace('\r', '\n').split("\n")));
        while (!out.isEmpty() && out.get(out.size() - 1).trim().isEmpty()) {
            out.remove(out.size() - 1);
        }
        return out;
    }

    /**
     * {@link #lines(String)} 的行数组版本。
     *
     * <p>存在是因为组装一小段测试规则比先拼成字符串再切自然得多，
     * 而 {@code lines("a", "b")} 会被当成「多传了一个参数」——
     * 那个报错信息（"无法将方法 lines 应用到给定类型"）指不到真正的原因上。
     */
    public static List<String> lines(String... rows) {
        List<String> out = new ArrayList<>();
        if (rows == null) return out;
        for (String r : rows) out.add(r == null ? "" : r);
        while (!out.isEmpty() && out.get(out.size() - 1).trim().isEmpty()) {
            out.remove(out.size() - 1);
        }
        return out;
    }

    private static String trim(String s) {
        return s.length() <= 48 ? s : s.substring(0, 48) + "…";
    }
}