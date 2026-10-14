package top.wuai.nova;

/**
 * 吾爱Nova浏览器 · 「滚动 → 顶栏 / 底栏 谁该出现」的判定。
 *
 * <h3>两个状态到底改了什么</h3>
 *
 * <p>切到 {@link State#SHOW_CAPSULE} 时上下各发生一件事：<b>顶栏整行收起</b>
 * （把那 52dp 还给网页），而<b>底栏那一行由五格换成胶囊搜索框</b> ——
 * 底栏隐去后它那 54dp 本来就空着，正好把「滚动时唯一还要用的东西」放进去，
 * 而且手指刚划完的地方本来就是拇指最顺的位置。
 * 切回 {@link State#SHOW_BAR} 时两者都还原。
 *
 * <h3>为什么抽成纯类</h3>
 *
 * <p>这段判断的错法在真机上很难复现、也很难描述：阈值差一点、方向反转没清零，
 * 表现都是「底栏来回闪」，而闪烁只在特定手速下出现。把它做成一个不碰任何
 * Android 类的纯状态机，就能用单测把每一条边界钉死 —— 这与本工程把
 * {@link NoImagePolicy}、{@link AutoPage} 抽出去是同一个理由。
 *
 * <h3>三条阈值规则</h3>
 * <ol>
 *   <li><b>向下累计超过 {@link #DOWN_THRESHOLD}</b>：收起顶栏、底栏那一行换成胶囊搜索框。
 *       用「累计」而不是「单帧位移」：手指一抖就是几十像素，单帧判定必闪。</li>
 *   <li><b>向上累计超过 {@link #UP_THRESHOLD}</b>：恢复底栏与地址栏。
 *       这个阈值刻意比下滚的小 —— 让 chrome（后退/前进/标签）更容易回来，
 *       是想回来时立刻就能回来，而把它推走需要一次干脆的下滑。</li>
 *   <li><b>进入顶部区（{@code scrollY <= }{@link #TOP_ZONE}）</b>：无条件恢复。
 *       人在页面开头时最可能想做导航动作，这时把底栏藏起来只会让人以为界面坏了。</li>
 * </ol>
 *
 * <h3>防抖怎么做的</h3>
 *
 * <p>维护一个「同方向上的未达阈值位移」accum：一旦方向反转就把它清零。
 * 这样一次「下 100px、上 100px」的来回抖动永远不会凑够 {@link #DOWN_THRESHOLD}，
 * 也就不会先触发胶囊再触发回弹。这是防抖的全部 —— 不引入时间窗口，
 * 因为时间窗口要么引入 Handler/时钟（就没法当纯类测了），
 * 要么调不好还会在慢速滑动时误判。
 */
public final class BottomBarReveal {

    /** 两种状态：常态（顶栏 + 五格底栏），或滚动态（顶栏收起 + 底栏位置换成胶囊搜索框）。 */
    public enum State {
        /** 顶栏与五格底栏都可见（常态）。 */
        SHOW_BAR,
        /** 顶栏整行收起，底栏那一行换成胶囊搜索框。 */
        SHOW_CAPSULE
    }

    /** 向下累计超过它 → 换成胶囊。120px 约等于一次「有意识的下滑启动」。 */
    public static final int DOWN_THRESHOLD = 120;
    /** 向上累计超过它 → 恢复底栏。比下滚阈值小，让 chrome 更容易回来。 */
    public static final int UP_THRESHOLD = 60;
    /** 距顶部不足它 → 无条件恢复底栏。 */
    public static final int TOP_ZONE = 40;

    private State state = State.SHOW_BAR;
    /** 同方向上尚未达阈值的位移累积。方向反转时清零。 */
    private int accum = 0;
    /** 上一次的 scrollY，用来算位移。 */
    private int lastY = 0;
    /**
     * {@code lastY} 是否已经是一个可信的基准。
     *
     * <p>构造出来的新实例天然可信（基准 0）。但 {@link #reset(int)} 之后不是 ——
     * 刚装配完主界面时，页面真实位置可能已经是 800px，而设备接下来回吐的第一个
     * {@code onScrollChange} 未必正好等于 {@code reset} 时拿到的值。若把这个首样本
     * 当成「从基准猛滚过来的位移」，就会算出一个巨大的 dy，于是切到「上次滚过一段」的
     * 标签时底栏莫名隐藏、胶囊乱冒。所以反标为 false：<b>reset 后的首个样本只用来
     * 重新定基准，不参与累计判定</b>。
     */
    private boolean hasBaseline = true;

    public State state() {
        return state;
    }

    /**
     * 复位成「底栏可见」，基准未知。
     *
     * <p>保留这个无参重载给「拿不到当前滚动位置」的调用点与既有测试用；
     * 生产代码应优先用 {@link #reset(int)} 把真实位置一起传进来。
     */
    public void reset() {
        reset(0);
    }

    /**
     * 复位成「底栏可见」，并把 {@code currentScrollY} 记为这套新界面的滚动基准。
     *
     * <p>每次重新装配主界面（从弹层返回、切标签、提交搜索后跳转）都要调一次：
     * 那时的 XML 默认就是底栏可见、胶囊隐藏，状态机必须跟着回到同一个初态。
     *
     * <p>注意基准只能「尽量准」：调用时拿到的 {@code currentScrollY} 与紧接着的首个
     * {@code onScrollChange} 未必相等（例如切标签后 {@code onPageFinished} 里的
     * {@code scrollTo(0, y)} 会在稍后才回吐真实位置）。所以这里刻意把
     * {@link #hasBaseline} 置 false，让首样本自己再定一次基准。
     *
     * @param currentScrollY 当前页面的竖直滚动位置，作为初始基准
     */
    public void reset(int currentScrollY) {
        state = State.SHOW_BAR;
        accum = 0;
        lastY = currentScrollY;
        hasBaseline = false;
    }

    /**
     * 只把基准挪到当前位置 —— 状态与累积都不动。
     *
     * <p>给<b>程序性滚动</b>用的：顶栏收起 / 展开时我们会把页面反向补一段，
     * 抵消它带来的视觉位移（见 {@code MainActivity#compensateTopBarShift}）。
     * 那不是用户划的，不能算进累计；但基准必须跟着挪，否则下一个真实回调会
     * 拿一个过期的基准去算位移，把这一下补偿记成一次用户手势 ——
     * 表现就是顶栏刚收起来、又立刻弹回去。
     *
     * <p>与 {@link #reset(int)} 的区别：那个是「换了一套界面，一切重来」，
     * 会强制回到 {@link State#SHOW_BAR}；这个只动基准，当前状态原样保留。
     *
     * @param scrollY 补偿之后页面真正的滚动位置
     */
    public void syncBaseline(int scrollY) {
        lastY = scrollY;
        hasBaseline = true;
    }

    /**
     * 喂一个新的滚动位置，返回喂完之后应该显示的状态。
     *
     * @param scrollY 页面当前的竖直滚动位置（像素）
     * @return 应当显示的状态；与上次相同就表示无需改变
     */
    public State onScroll(int scrollY) {
        // reset 之后的首个样本：只用来重新定基准，绝不参与判定。
        // 少了这一步，mountMain 后的第一帧就会被当成「从 0 猛滚到当前位置」。
        if (!hasBaseline) {
            hasBaseline = true;
            lastY = scrollY;
            return state;
        }

        int dy = scrollY - lastY;
        lastY = scrollY;

        // 顶部区：无条件回到底栏，并把累积清干净
        if (scrollY <= TOP_ZONE) {
            accum = 0;
            state = State.SHOW_BAR;
            return state;
        }

        // 方向反转就清零累积：这是防抖的核心，见类注释
        if ((dy > 0 && accum < 0) || (dy < 0 && accum > 0)) accum = 0;
        accum += dy;

        if (accum >= DOWN_THRESHOLD) {
            state = State.SHOW_CAPSULE;
            accum = 0;  // 触发后清零，避免紧接着一帧又因为残留累积抖动
        } else if (accum <= -UP_THRESHOLD) {
            state = State.SHOW_BAR;
            accum = 0;
        }
        return state;
    }
}
