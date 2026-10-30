package top.wuai.nova;

/**
 * 在 User-Agent 末尾追加自家标识：{@code ... Chrome/120.0.0.0 Mobile Safari/537.36 NovaBrowser/1.6.12}。
 *
 * <p>目的只有一个：让自家站点（52ta.top 导航）能认出「访客用的已经是 Nova」，
 * 不再给他弹「换用吾爱Nova浏览器」的下载提示。站点侧是按 {@code /NovaBrowser/i} 判的，
 * 与 PC 版 {@code engines.js} 追加的那一段完全同名，两端口径一致。
 *
 * <p>两条硬约束，都在 {@link #append} 里体现：
 * <ul>
 *   <li><b>只增量追加</b>：原串一个字符都不动（含 {@code Mobile}、{@code wv}、{@code Android}），
 *       否则站点会按改过的 UA 返回错的布局或错的功能；</li>
 *   <li><b>幂等</b>：已带标识就原样返回，避免反复进入设置页后变成
 *       {@code ...NovaBrowser/1.6.12 NovaBrowser/1.6.12}。</li>
 * </ul>
 *
 * <p>写成不依赖 Android 框架的纯逻辑类，本机 JVM 单测就能覆盖（见 {@code UaTokenTest}）。
 */
public final class UaToken {

    /** 标识前缀。站点侧按它做大小写不敏感匹配。 */
    public static final String MARK = "NovaBrowser/";

    /** 小写形态，只给 {@link #has} 做不区分大小写的包含判断用。 */
    private static final String MARK_LC = "novabrowser/";

    private UaToken() {
    }

    /** 生成标识本体，如 {@code NovaBrowser/1.6.12}。版本为空时退化成 {@code NovaBrowser/0}。 */
    public static String token(String version) {
        String v = version == null ? "" : version.trim();
        if (v.isEmpty()) v = "0";
        return MARK + v;
    }

    /**
     * UA 是否已经带标识。
     *
     * <p><b>不区分大小写</b>：站点侧是 {@code /NovaBrowser/i}，任何大小写写法它都认。
     * 这里若按大小写敏感判，遇到一个 {@code novabrowser/1.0} 的 UA 就会再追加一次，
     * 变成两个标识。
     */
    public static boolean has(String ua) {
        return ua != null && ua.toLowerCase(java.util.Locale.ROOT).contains(MARK_LC);
    }

    /**
     * 追加标识。空 UA 原样返回（不凭空造一个 UA）；已带标识原样返回（幂等）。
     *
     * @param ua      原始 UA，可为 null
     * @param version 应用版本号，可为 null
     * @return 追加后的 UA
     */
    public static String append(String ua, String version) {
        if (ua == null || ua.trim().isEmpty()) return ua;
        if (has(ua)) return ua;
        return ua.trim() + " " + token(version);
    }
}
