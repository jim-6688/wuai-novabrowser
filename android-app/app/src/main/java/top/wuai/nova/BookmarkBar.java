package top.wuai.nova;

/**
 * 收藏夹栏的纯逻辑。
 *
 * <p>与 {@link BookmarkStore} 同一个理由抽出来：这些判断一旦写在 MainActivity 里，
 * 就只能靠 instrumented 测试或真机去验，而本项目刻意不引 Robolectric。
 * 这里每一条都是纯字符串运算与布尔判断，传进去就能验。
 *
 * <p>只管「显示什么」与「该不该显示」，不管 View —— 建视图那一半留在 MainActivity。
 * 也不重复解析 URL：主机名走 {@link NewTab#hostOf}。
 */
public final class BookmarkBar {

    private BookmarkBar() {}

    /**
     * 这条栏此刻该不该展开。三个条件缺一不可。
     *
     * @param userOpen      用户在这台机器上点过唤出键没有
     * @param isNewTab      当前页是不是内置新标签页
     * @param buttonEnabled 设置里「收藏夹栏」那一项开着没有
     */
    public static boolean expanded(boolean userOpen, boolean isNewTab, boolean buttonEnabled) {
        // 设置关掉时连入口都不显示，展开状态就不该还留着 —— 否则「先展开、再去设置里
        // 关掉」会留下一条收不回去的栏（那时唤出键已经不见了，没人能把它关掉）。
        if (!buttonEnabled) return false;
        // 新标签页上顶栏整行内容是隐去的（页内自带搜索框），这条栏跟着一起隐：
        // 否则一屏里会只剩它亮着，悬在一个空的新标签页上方。
        return userOpen && !isNewTab;
    }

    /**
     * 一格上显示什么字。
     *
     * <p>三级降级：标题 → 主机名 → 整条 url。中间那一级不能省 —— 收藏时页面
     * 可能还没给出标题（用户手快），那时显示主机名也比甩出一串 https://… 有用。
     *
     * <p>主机名借 {@link NewTab#hostOf}，<b>不再自己写一份</b>：这一层解析项目里
     * 已经有 {@code Tab.hostOf} 与 {@code NewTab.hostOf} 两处，且注释里写着两者
     * 分支要对齐。再添第三份，改一次规则就得记着改三处 —— 而漏掉的那一处
     * 往往要到「某个站名显示得跟别处不一样」才被发现。
     */
    public static String label(String title, String url) {
        if (title != null && !title.trim().isEmpty()) return title.trim();
        String h = NewTab.hostOf(url);
        // hostOf 对「不带 ://」的输入是原样返回（about:blank 这类），那种「主机名」
        // 其实就是整条地址，没有再往下退的必要。
        if (h != null && !h.isEmpty()) return h;
        return url == null ? "" : url.trim();
    }

    /**
     * 首字母方块上那一个字。
     *
     * <p>跳过开头的非字母数字（「[推荐] 某站」这种标题取到的是「推」而不是「[」），
     * 一个都取不到时给一个中性点号 —— 留一个空格子看起来像没加载出来。
     */
    public static String letter(String label) {
        if (label == null) return "•";
        for (int i = 0; i < label.length(); i++) {
            char c = label.charAt(i);
            if (Character.isLetterOrDigit(c)) {
                return String.valueOf(Character.toUpperCase(c));
            }
        }
        return "•";
    }
}
