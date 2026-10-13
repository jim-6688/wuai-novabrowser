package top.wuai.nova;

/**
 * 吾爱Nova浏览器 · 「下拉刷新」的判定。
 *
 * <h3>为什么抽成纯类</h3>
 *
 * <p>与 {@link BottomBarReveal} 同一个理由：这段判断的错法在真机上很难复现，
 * 也很难用嘴描述清楚。阈值差一点、回退时没跟着退、松手瞬间的边界算错，
 * 表现都是「有时候拉得出来有时候拉不出来」「拉一下球就飞出去了」，
 * 而它们只在特定手速下出现。做成一个不碰任何 Android 类的纯状态机，
 * 就能用单测把每一条边界钉死。
 *
 * <h3>四个状态</h3>
 *
 * <ol>
 *   <li>{@link State#IDLE} —— 没在下拉。指示器收起，手指的动作全归网页。</li>
 *   <li>{@link State#PULL} —— 正在拉，但还没拉到阈值。指示器跟着手指走。</li>
 *   <li>{@link State#READY} —— 拉到位了，松手就刷新。这时球会「顶」一下并给一次振动。</li>
 *   <li>{@link State#REFRESHING} —— 已经松手，球停在原位转圈，直到页面加载完。</li>
 * </ol>
 *
 * <h3>两处刻意的设计</h3>
 *
 * <p><b>位移是绝对量而不是增量。</b>{@link #drag(float)} 收的是「相对按下点的总位移」，
 * 每次都从头算一遍 —— 所以同一个 {@code dy} 喂两次结果完全一样（幂等）。
 * 这一点不是洁癖：父容器的 {@code onInterceptTouchEvent} 与 {@code onTouchEvent}
 * 会拿同一个 MOVE 事件各调一次（拦截那一帧是同一个事件同时走两条路），
 * 用增量累计就会把这一帧算成两倍位移。
 *
 * <p><b>阻尼分两段。</b>阈值以内跟得比较实（0.85），越过阈值明显变沉（0.25）。
 * 前者是为了「球像被手指拽下来」，后者是为了让「已经拉到位了」这件事有手感 ——
 * 过阈值后手指继续走、球几乎不动，这个反差就是在说「够了，松手吧」。
 * 而且总有上限：不设上限的话，往下一路拖能把球拖到屏幕中间去。
 */
public final class PullToRefresh {

    /** 四个状态。除 {@code IDLE} 外，其余三个都要求指示器出现在屏幕上。 */
    public enum State {
        /** 没在下拉。 */
        IDLE,
        /** 正在拉，还没到阈值。 */
        PULL,
        /** 拉到位了，松手就刷新。 */
        READY,
        /** 正在刷新，等页面加载完。 */
        REFRESHING
    }

    /**
     * 手指下拉这么多 dp 算「拉到位」。
     *
     * <p>52dp 是刻意挑的：它乘 {@link #SLOPE_BEFORE} 正好 ≈ 44dp，
     * 也就是指示器从屏幕外滑到它既定位置所需的位移
     * （球 34dp + 上边距 10dp，见 activity_main.xml）。
     * 于是「球完全露出来」与「可以松手了」是同一个瞬间 ——
     * 用户看到的和实际生效的对齐，不用额外解释。
     */
    public static final float TRIGGER_DP = 52f;

    /** 指示器最大位移 dp。球滑到最下面也就这么远，再拉也不会更深。 */
    public static final float MAX_OFFSET_DP = 68f;

    /** 阈值以内的阻尼：跟手，但仍比手指慢一点，才有「拽」的感觉。 */
    public static final float SLOPE_BEFORE = 0.85f;
    /** 阈值以外的阻尼：手指继续走、球几乎不动，用反差告诉用户「够了」。 */
    public static final float SLOPE_AFTER = 0.25f;

    private final int slopPx;
    private final int triggerPx;
    private final int maxOffsetPx;

    private State state = State.IDLE;
    /** 本次手势是否有资格下拉。按下时页面不在顶部，就整场作废。 */
    private boolean armed = false;
    /** 手指下拉的距离（已扣掉起手容差）。 */
    private int travelPx = 0;
    /** 阻尼之后的指示器位移。 */
    private int offsetPx = 0;

    /**
     * @param density    屏幕密度，用来把上面的 dp 常量换成像素
     * @param touchSlopPx 起手容差，通常直接取
     *                    {@code ViewConfiguration.get(ctx).getScaledTouchSlop()}。
     *                    一定要传平台的这个值而不是自己拍一个：它跟着设备与
     *                    「手套模式」之类的设置走，自己拍一个必然在某些机器上手感不对。
     */
    public PullToRefresh(float density, int touchSlopPx) {
        slopPx = Math.max(0, touchSlopPx);
        triggerPx = Math.max(1, Math.round(TRIGGER_DP * density));
        maxOffsetPx = Math.max(1, Math.round(MAX_OFFSET_DP * density));
    }

    /** 测试用：容差取 0，位移量退化成 dp 数值本身（density 传 1）。 */
    public PullToRefresh(float density) {
        this(density, 0);
    }

    public State state() {
        return state;
    }

    /** 本次手势是否被允许下拉。 */
    public boolean armed() {
        return armed;
    }

    /** 指示器此刻该不该出现在屏幕上。 */
    public boolean active() {
        return state == State.PULL || state == State.READY || state == State.REFRESHING;
    }

    /** 是否正在刷新。刷新期间不接受新的下拉，也不该被页面加载中的滚动打断。 */
    public boolean refreshing() {
        return state == State.REFRESHING;
    }

    /**
     * 阻尼后的指示器位移（px）。0 表示完全收起。
     *
     * <p>刷新中它停在 {@code damp(triggerPx)}，也就是松手那一刻的位置 ——
     * 松手后球会往上跳一下的观感很差，停在原地才好读成「它接住了」。
     */
    public int offsetPx() {
        return offsetPx;
    }

    /** 离「拉到位」还有多远，0..1。给界面做透明度 / 旋转用。 */
    public float progress() {
        if (state == State.REFRESHING) return 1f;
        return Math.min(1f, travelPx / (float) triggerPx);
    }

    /**
     * 手指按下。
     *
     * @param atTop 页面此刻是否停在顶部。不是的话整场手势都不武装 ——
     *              页面能往上滚的时候，手指往下划是「把页面滚回去」，不是「拉」。
     * @return 是否武装
     */
    public boolean begin(boolean atTop) {
        // 刷新中不重新武装：否则「正在转圈时拉一下」会把自己拉成第二次刷新。
        if (state == State.REFRESHING) {
            armed = false;
            return false;
        }
        state = State.IDLE;
        travelPx = 0;
        offsetPx = 0;
        armed = atTop;
        return armed;
    }

    /**
     * 手指移动。幂等：同一个 {@code dy} 反复喂，结果一样（理由见类注释）。
     *
     * @param dy 相对按下点的总竖直位移，向下为正
     * @return true 表示这个事件该被下拉手势吃掉，不要再交给网页去滚
     */
    public boolean drag(float dy) {
        if (!armed || state == State.REFRESHING) return false;

        int travel = Math.round(dy) - slopPx;
        if (travel <= 0) {
            // 还没过起手容差（或者已经退回去了）：指示器收起来，事件照常给网页。
            // 注意 armed 保留 —— 手指在同一场手势里再往下拉，仍然算数。
            travelPx = 0;
            offsetPx = 0;
            state = State.IDLE;
            return false;
        }

        travelPx = travel;
        offsetPx = damp(travel);
        state = travel >= triggerPx ? State.READY : State.PULL;
        return true;
    }

    /**
     * 松手。
     *
     * @return true 表示该真的去刷新了
     */
    public boolean release() {
        if (state == State.READY) {
            state = State.REFRESHING;
            armed = false;
            // 停在拉到位那一刻的位移上（见 offsetPx 的注释）
            travelPx = triggerPx;
            offsetPx = damp(triggerPx);
            return true;
        }
        if (state != State.REFRESHING) {
            state = State.IDLE;
            armed = false;
            travelPx = 0;
            offsetPx = 0;
        }
        return false;
    }

    /**
     * 手势被打断（父层抢走、多指、系统弹窗…）。
     *
     * <p>与 {@link #release()} 的区别：这个绝不触发刷新。
     * 把「被打断」当成「松手」的话，一次来电就能刷出一个新页面。
     */
    public void cancel() {
        if (state == State.REFRESHING) return;
        state = State.IDLE;
        armed = false;
        travelPx = 0;
        offsetPx = 0;
    }

    /**
     * 刷新结束：页面加载完了、加载失败了，或者等超时了。
     *
     * @return true 表示确实有一次刷新被收尾了（调用方可以据此只做一次收场动画）
     */
    public boolean finish() {
        if (state != State.REFRESHING) return false;
        state = State.IDLE;
        armed = false;
        travelPx = 0;
        offsetPx = 0;
        return true;
    }

    /** 两段阻尼。单调不减、且有上限，这两条由单测钉住。 */
    private int damp(int travel) {
        float before = Math.min(travel, triggerPx) * SLOPE_BEFORE;
        float after = Math.max(0, travel - triggerPx) * SLOPE_AFTER;
        return Math.min(maxOffsetPx, Math.round(before + after));
    }
}
