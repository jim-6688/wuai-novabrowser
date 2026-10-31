package top.wuai.nova;

/**
 * 把用户输入的地址补成可收藏的网址。
 *
 * <p>刻意抽成纯类：判断规则很容易写歪（少一个分支就会把「知乎」当成域名），
 * 而它又完全不需要 Android 框架，放这里就能用纯 JVM 单测锁住。
 *
 * <p>与 {@link NovaSettings#resolveInput} 的区别是<b>关键</b>：
 * 那边「不像网址就当搜索词」，因为地址栏本来就是「搜或去」的入口；
 * 这边「不像网址就返回空串」，因为改收藏时把网址悄悄换成搜索结果页，
 * 等于把用户那条收藏改坏了，而且他下次点开才发现。
 */
public final class UrlInput {

    private UrlInput() {
    }

    /**
     * @return 可用的网址；看起来不像网址时返回空串（调用方据此报错，不猜）
     */
    public static String toUrl(String raw) {
        if (raw == null) return "";
        String q = raw.trim();
        if (q.isEmpty()) return "";
        String lower = q.toLowerCase(java.util.Locale.ROOT);
        // 带协议的原样认；file / ftp 也算（收藏本地页、ftp 目录是真实用法）
        for (String scheme : new String[]{"http://", "https://", "file://", "ftp://"}) {
            if (lower.startsWith(scheme)) return q;
        }
        if (looksLikeHost(q)) return "https://" + q;
        return "";
    }

    /**
     * 像不像一个「主机[:端口][/路径]」。
     *
     * <p>要求至少一个点（或 localhost），且点两侧都得有字符 —— 只写「知乎」
     * 不该被当成域名补成 https://知乎。
     */
    static boolean looksLikeHost(String q) {
        if (q.startsWith("localhost")) return true;
        int slash = q.indexOf('/');
        String host = slash >= 0 ? q.substring(0, slash) : q;
        // 去掉端口，再判点。端口必须是纯数字 —— 「a.test:http」不是一个主机，
        // 更像有人把协议名敲到后面去了，这种一律判「不像网址」而不是硬补 https://。
        int colon = host.lastIndexOf(':');
        if (colon > 0) {
            String port = host.substring(colon + 1);
            if (port.isEmpty() || !isDigits(port)) return false;
            host = host.substring(0, colon);
        }
        int dot = host.indexOf('.');
        if (dot <= 0 || dot == host.length() - 1) return false;
        // 允许出现多个点（a.b.c）；逐段都非空，且不含空格
        if (host.indexOf(' ') >= 0 || host.indexOf('\t') >= 0) return false;
        String[] segs = host.split("\\.", -1);
        if (segs.length < 2) return false;
        for (String s : segs) {
            if (s.isEmpty()) return false;
        }
        return true;
    }

    private static boolean isDigits(String s) {
        for (int i = 0; i < s.length(); i++) {
            if (!Character.isDigit(s.charAt(i))) return false;
        }
        return true;
    }
}
