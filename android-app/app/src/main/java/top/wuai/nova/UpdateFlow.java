package top.wuai.nova;

/**
 * 更新提示条的状态机 —— 纯逻辑，零 Android 依赖，可直接跑 JVM 单测。
 *
 * <h3>为什么要把这一层单独抽出来</h3>
 *
 * <p>「什么时候显示什么、主按钮写什么、能不能被关掉、要不要挡住网页」这套判断，
 * 如果散在 MainActivity 的十几个 if 里，会冒出两类很难查的问题：
 * 一是进度才 30% 就跳出了「重启更新」，二是强制更新被用户点一下 × 就永久消失。
 * 这两类 bug 在真机上都要<b>等一次真实的版本发布</b>才能看到 ——
 * 也就是说，验证成本是「发一次版」。抽成纯函数后，每个阶段乘「强制与否」
 * 的组合都能在毫秒级跑完。
 *
 * <h3>为什么不是「有新版就弹窗问要不要下载」</h3>
 *
 * <p>主流浏览器的更新是<b>无感</b>的：发现新版 → 后台悄悄下 → 下完只在界面上
 * 留一句「重新启动以更新」。中间没有「要不要下载」这一问 ——
 * 那一问除了多一次点击，还会让相当一部分用户停在旧版本上，
 * 而安全修复正是靠新版本送出去的。
 *
 * <p>所以这里的默认动作是「直接下」。用户唯一要做的决定只在最后一步：
 * <b>什么时候重启</b>。这也正是本类里 {@link Phase#READY} 存在的意义 ——
 * 它不是「等你确认要不要下」，而是「已经下好了，就等你点头」。
 */
public final class UpdateFlow {

    /** 更新进行到哪一步了。 */
    public enum Phase {
        /** 没有新版，整条提示条不出现。 */
        IDLE,
        /** 查到新版，但因为「仅 Wi-Fi 下载」的设置，正等着网络条件满足。 */
        WAITING,
        /** 正在后台下载更新包。 */
        DOWNLOADING,
        /** 包已下好并通过校验，只差用户点一下「重启更新」。 */
        READY,
        /** 下载或校验失败。 */
        FAILED
    }

    /** 提示条在某一刻该长什么样。所有字段都是算出来的，没有一个来自 Android。 */
    public static final class Snapshot {
        /** 整条要不要出现。 */
        public final boolean visible;
        /** 主标题。 */
        public final String title;
        /** 副标题（进度、原因、说明）。可能为空。 */
        public final String detail;
        /** 是否显示那条细进度条。 */
        public final boolean progressVisible;
        /** 0..100。{@link #progressVisible} 为 false 时无意义。 */
        public final int percent;
        /** 主按钮文案；{@code null} 表示这一步没有可点的动作。 */
        public final String action;
        /** 是否给用户一个 × 。强制更新时没有。 */
        public final boolean closable;
        /** 是否要在网页区盖一层遮罩，让用户没法一边用旧版一边无视更新。 */
        public final boolean blocking;
        /** 是否用警示配色（失败、强制）。 */
        public final boolean warn;

        Snapshot(boolean visible, String title, String detail,
                 boolean progressVisible, int percent, String action,
                 boolean closable, boolean blocking, boolean warn) {
            this.visible = visible;
            this.title = title;
            this.detail = detail;
            this.progressVisible = progressVisible;
            this.percent = percent;
            this.action = action;
            this.closable = closable;
            this.blocking = blocking;
            this.warn = warn;
        }

        static final Snapshot HIDDEN =
            new Snapshot(false, "", "", false, 0, null, false, false, false);
    }

    private UpdateFlow() {
        // 全是静态方法，不实例化
    }

    /**
     * 算出提示条此刻的样子。
     *
     * @param phase     当前阶段；{@code null} 等同于 {@link Phase#IDLE}
     * @param version   新版版本号，可空（拿不到就不显示在标题里）
     * @param percent   下载百分比；小于 0 表示总长未知（服务器没给 Content-Length）
     * @param mandatory 这份清单是否要求必须更新（作者标了 mandatory，或当前版本已低于
     *                  {@code minVersionCode}）
     * @param error     失败原因；只在 {@link Phase#FAILED} 时被使用
     */
    public static Snapshot of(Phase phase, String version, int percent,
                              boolean mandatory, String error) {
        if (phase == null) return Snapshot.HIDDEN;

        String v = version == null ? "" : version.trim();
        String name = v.isEmpty() ? "" : " " + v;

        switch (phase) {
            case WAITING:
                // 这一档是「已经发现新版、但我们（不是用户）主动压着不下载」。
                // 所以按钮必须写「立即下载」而不是「下载」—— 它要解释的是
                // 「你现在点它，是让我别等 Wi-Fi 了」，而不是「开始干活」。
                return new Snapshot(true,
                    "发现新版本" + name,
                    "已设为仅在 Wi-Fi 下下载，连上 Wi-Fi 会自动开始",
                    false, 0, "立即下载",
                    !mandatory, mandatory, false);

            case DOWNLOADING: {
                int p = clampPercent(percent);
                return new Snapshot(true,
                    "正在后台下载更新" + name,
                    percent < 0 ? "已开始下载" : p + "%",
                    true, p, null,
                    !mandatory, mandatory, false);
            }

            case READY:
                // 「已下载的内容不受影响」这句是刻意加的结论句，不是客套：
                // 升级这个动作天然让人担心「我的标签页 / 登录状态会不会没了」，
                // 而这恰恰是浏览器最不能弄丢的东西。先把它说清楚，再让他点。
                return new Snapshot(true,
                    "新版本" + name + " 已就绪",
                    "重启后即可完成更新，已打开的标签与登录状态不受影响",
                    false, 100, "重启更新",
                    !mandatory, mandatory, false);

            case FAILED:
                return new Snapshot(true,
                    "更新下载失败",
                    error == null || error.trim().isEmpty()
                        ? "网络似乎不太稳定，稍后会自动重试" : error.trim(),
                    false, 0, "重试",
                    !mandatory, mandatory, true);

            default:
                return Snapshot.HIDDEN;
        }
    }

    /** 把百分比夹到 0..100。负数（总长未知）按 0 处理。 */
    static int clampPercent(int p) {
        if (p < 0) return 0;
        return p > 100 ? 100 : p;
    }

    /**
     * 已下载字节 → 百分比。
     *
     * <p>两条边界值得写下来：
     * <ul>
     *   <li>总长未知时返回 -1，而不是 0 —— 调用方要靠这个区别来决定
     *       「显示进度条」还是「显示一句『已开始下载』」。返回 0 会让界面
     *       永远停在 0%，看起来像卡死。</li>
     *   <li>整数除法会把 99.6% 截断成 99，但会把 100% 以下所有值都<b>不会</b>
     *       误报成 100 —— 唯独 got == total 时才是真的 100。若因截断算出 100
     *       而 got 还小于 total，说明进度条会「先跑到头再等一会儿」，
     *       那正是让人以为卡死的画面，所以这里把它压回 99。</li>
     * </ul>
     */
    public static int percentOf(long got, long total) {
        if (total <= 0) return -1;
        if (got <= 0) return 0;
        if (got >= total) return 100;
        long pct = got * 100 / total;
        return pct >= 100 ? 99 : (int) pct;
    }
}
