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

    /**
     * 收藏夹栏里标题下面那一行显示的网址。
     *
     * <p><b>只到主机名，不给整条路径</b>：横栏的可用宽度有限，而这一行是给
     * 「分得清」用的 —— 看到 {@code zhihu.com} 就能区分是哪一家，
     * 看到 {@code zhuanlan.zhihu.com/…} 只会把那一格撑得很宽、
     * 而多出来的那部分本来就是标题里有的信息。
     *
     * <p>去掉 {@code www.} 前缀：它不携带任何区分信息（同一个站必然是同一个
     * 主机），却占掉一行里最贵的两三个字符。
     *
     * <p>与标题一样是<b>纯函数</b>：这一层解析项目里已经有一份
     * {@link NewTab#hostOf}，这里直接借它而不是自己再写一遍 —— 重复的解析
     * 规则散在三处时，改一次要记着改三处，而漏掉的那一处要到「某处显示得跟别处
     * 不一样」才被发现。
     */
    public static String host(String url) {
        String h = NewTab.hostOf(url);
        if (h == null) return "";
        if (h.startsWith("www.")) return h.substring(4);
        return h;
    }
}
