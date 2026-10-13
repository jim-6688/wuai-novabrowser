package top.wuai.nova;

import android.content.Context;
import android.util.AttributeSet;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.widget.FrameLayout;

/**
 * 吾爱Nova浏览器 · 装着 WebView 的那个容器，负责下拉刷新。
 *
 * <h3>为什么必须是「包着 WebView 的那一层」</h3>
 *
 * <p>下拉刷新要做的第一件事是「在网页自己动手之前把这一指抢过来」，这件事只有
 * 父容器的 {@code onInterceptTouchEvent} 能做 —— 它是在事件往下发之前被问的那一句。
 * 挂在 WebView 的 {@code OnTouchListener} 上也能看到事件，但那时网页往往已经
 * 开始滚了，而且我们在中途「不还给它」时它永远等不到那一指的 UP，
 * 内部的长按计时器会一直挂着（表现是长拉之后莫名其妙跳出一个文本选择菜单）。
 * 走拦截这条路，框架会替我们给子 View 发一个 ACTION_CANCEL，收尾是干净的。
 *
 * <h3>WebView 会主动叫我们别拦，这一句必须无视</h3>
 *
 * <p>WebView 在手指按下后会调 {@code requestDisallowInterceptTouchEvent(true)}，
 * 意思是「这一指别拦我，我要自己滚」。它拦掉的正是下拉刷新赖以工作的那套拦截：
 * 照单全收的话 {@code onInterceptTouchEvent} 从此再也不会被调用，
 * 下拉刷新会整体失效 —— 而且失效得毫无声息，只是「怎么拉都没反应」。
 *
 * <p>所以下拉有资格的时候把它忽略掉。这不是自创的招：androidx 的
 * SwipeRefreshLayout 对「不支持嵌套滚动的子 View」（WebView 正好是）
 * 做的就是同一件事。反过来，页面不在顶部、或者正在刷新时照常放行 ——
 * 那两个时刻我们本来就不该抢。
 *
 * <h3>这个类不碰业务</h3>
 *
 * <p>「能不能起手」「刷新要做什么」都是页面的知识，通过 {@link Page} 传进来。
 * 容器自己只管触摸与那颗球。判定逻辑全在 {@link PullToRefresh}（纯类，可单测）。
 */
public class RefreshHost extends FrameLayout {

    /** 宿主与页面之间的桥。 */
    public interface Page {
        /**
         * 页面是否停在顶部。
         *
         * <p>只有这时手指往下划才是「拉」。页面还能往上滚的时候，
         * 手指往下划是「把页面滚回去」—— 那时候把事件抢过来，用户会觉得页面卡住了。
         */
        boolean atTop();

        /** 真的去刷新。 */
        void refresh();
    }

    /** 松手 / 取消后球收回原位的时长。 */
    private static final int RETURN_MS = 180;
    /** 球从全透明到完全显形所需的位移 dp。 */
    private static final float FADE_DP = 26f;
    /** 球本身的高度与上边距的兜底值，对应 activity_main.xml 里的 34dp / 10dp。 */
    private static final float BALL_DP = 34f;
    private static final float BALL_MARGIN_DP = 10f;

    private final PullToRefresh pull;

    private Page page;
    private View ball;
    private View arrow;
    private View spinner;
    private PullToRefresh.State lastState = PullToRefresh.State.IDLE;

    /** 算 dy / dx 的基准点。页面滚走时会跟着手指挪，理由见 onInterceptTouchEvent。 */
    private float baseY;
    private float baseX;

    public RefreshHost(Context context) {
        this(context, null);
    }

    public RefreshHost(Context context, AttributeSet attrs) {
        this(context, attrs, 0);
    }

    public RefreshHost(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        pull = new PullToRefresh(getResources().getDisplayMetrics().density,
            ViewConfiguration.get(context).getScaledTouchSlop());
    }

    public void setPage(Page p) {
        page = p;
    }

    @Override
    protected void onFinishInflate() {
        super.onFinishInflate();
        ball = findViewById(R.id.refreshBall);
        arrow = findViewById(R.id.refreshArrow);
        spinner = findViewById(R.id.refreshSpinner);
        if (ball != null) {
            // 先把球摆到屏幕外：布局里它是 marginTop=10dp 的正常位置，
            // 不挪出去的话，主界面一装好就会有一颗粒子悬在网页顶上。
            ball.setTranslationY(-hiddenPx());
            ball.setAlpha(0f);
        }
    }

    /** 是否正在刷新。收尾只该做一次，调用方拿它来挡住重复的收场动画。 */
    public boolean isRefreshing() {
        return pull.refreshing();
    }

    /** 刷新结束：把球收回屏幕外。页面加载完、加载失败、等超时都走这里。 */
    public void finishRefresh() {
        if (pull.finish()) render(true);
    }

    // ------------------------------------------------------------ 触摸

    @Override
    public void requestDisallowInterceptTouchEvent(boolean disallow) {
        if (pull.armed() || pull.active()) {
            // 下拉有资格：这一句必须无视，理由见类注释
            return;
        }
        super.requestDisallowInterceptTouchEvent(disallow);
    }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent ev) {
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                beginGesture(ev);
                // DOWN 不抢：用户可能是想横向划、也可能只是想点一个链接
                return false;

            case MotionEvent.ACTION_MOVE: {
                if (!pull.armed()) return false;

                /*
                 * 页面不在顶部时，把基准点跟着手指一起挪。
                 *
                 * 不挪会出一个很难查的错：手指在顶部往下划一小段（没到阈值，
                 * 事件仍归网页）→ 手指转向上划、网页被滚下去一大截 → 手指又往下划回顶部。
                 * 这时 dy 是相对最初那个按下点算的，已经积累了「滚下去再滚回来」的
                 * 那几百像素，于是手指刚回到顶部，球就被顶到最下面，
                 * 看起来像「一碰就刷新」。跟着挪之后，dy 永远只反映「回到顶部之后又拉了多少」。
                 */
                if (page == null || !page.atTop()) {
                    baseY = ev.getY();
                    baseX = ev.getX();
                    return false;
                }

                float dy = ev.getY() - baseY;
                float dx = ev.getX() - baseX;
                // 竖直为主才算下拉：横向划动（网页里的轮播、图片左右翻）不该被抢
                if (dy > Math.abs(dx) && pull.drag(dy)) {
                    render(false);
                    return true;
                }
                return false;
            }
        }
        return false;
    }

    @Override
    public boolean onTouchEvent(MotionEvent ev) {
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                // 正常情况下走不到这里（DOWN 会给 WebView）。但万一 WebView 不在，
                // 或者它没接这一指，拦截就从 DOWN 起就归我们了：
                // 那时若不重新定基准，上一场手势残留的 armed 会让这一场凭空冒出一颗球。
                beginGesture(ev);
                return pull.armed();

            case MotionEvent.ACTION_MOVE:
                if (!pull.armed()) return false;
                pull.drag(ev.getY() - baseY);
                render(false);
                return true;

            case MotionEvent.ACTION_UP: {
                boolean fire = pull.release();
                render(true);
                if (fire && page != null) page.refresh();
                return true;
            }

            case MotionEvent.ACTION_CANCEL:
                // 被打断绝不能当成松手 —— 那样一次来电就能刷出一个新页面
                pull.cancel();
                render(true);
                return true;
        }
        return super.onTouchEvent(ev);
    }

    private void beginGesture(MotionEvent ev) {
        baseY = ev.getY();
        baseX = ev.getX();
        pull.begin(page != null && page.atTop());
    }

    // ------------------------------------------------------------ 指示器

    /**
     * 把 {@link PullToRefresh} 的状态画到界面上。
     *
     * @param animateReturn 收起时是否播动画。拖动过程中（{@code false}）必须直接跟手：
     *                      每帧起一个动画会把动画队列冲乱，表现就是球抖个不停
     *                      —— 与底栏显隐那里是同一类坑（见 MainActivity#applyReveal）。
     */
    private void render(boolean animateReturn) {
        if (ball == null) return;

        if (!pull.active()) {
            hideBall(animateReturn);
            lastState = pull.state();
            return;
        }

        ball.animate().cancel();
        ball.setVisibility(View.VISIBLE);
        boolean refreshing = pull.refreshing();
        setSpinning(refreshing);

        if (animateReturn) {
            ball.animate().translationY(pull.offsetPx() - hiddenPx()).alpha(1f)
                .setDuration(RETURN_MS).start();
        } else {
            ball.setTranslationY(pull.offsetPx() - hiddenPx());
            ball.setAlpha(Math.min(1f, pull.offsetPx() / (float) fadePx()));
            // 拉的过程中箭头跟着转，转到「拉到位」正好一圈 ——
            // 一圈转满时它正好回到正姿态，这个「对齐了」本身就是可以松手的提示
            if (arrow != null) arrow.setRotation(360f * pull.progress());
        }

        /*
         * 刚拉到位：给一次轻振动。
         *
         * 特意不加视觉上的第二形态。球在最关键的那一瞬间正好完全露出来
         * （52dp × 0.85 ≈ 44dp，与球的露出距离相等，见 PullToRefresh.TRIGGER_DP），
         * 「完全露出来」就是那个视觉提示；再加一个放大或变色，
         * 会和「跟手位移」这条动画抢同一个属性，反而容易抖。
         * 而此刻手指正压在屏幕上，多半看不到球 —— 所以补一次触觉。
         */
        if (pull.state() == PullToRefresh.State.READY
            && lastState != PullToRefresh.State.READY) {
            ball.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
        }
        lastState = pull.state();
    }

    private void hideBall(boolean animate) {
        if (ball == null) return;
        ball.animate().cancel();
        if (animate) {
            ball.animate().translationY(-hiddenPx()).alpha(0f).setDuration(RETURN_MS)
                .withEndAction(() -> {
                    // 动画这 180ms 里可能又被拉起来了：那就不能收，
                    // 收掉的话球会凭空消失在半路（状态说它在，屏幕上却没有）
                    if (pull.active()) return;
                    ball.setVisibility(View.GONE);
                    setSpinning(false);
                    if (arrow != null) arrow.setRotation(0f);
                }).start();
        } else {
            ball.setVisibility(View.GONE);
            ball.setTranslationY(-hiddenPx());
            ball.setAlpha(0f);
            setSpinning(false);
            if (arrow != null) arrow.setRotation(0f);
        }
    }

    /**
     * 刷新中的转圈用系统的 ProgressBar，不自己写旋转动画。
     *
     * <p>自己写的写法是「转一圈、结束时再起一圈」，递归的结束回调在这种
     * 「随时可能被 visibility 打断」的场景里很容易转出两三条并行的动画链，
     * 表现是速度忽快忽慢。系统 spinner 没有这个问题，而且它就是用户在别处看惯的样子。
     */
    private void setSpinning(boolean on) {
        if (arrow != null) arrow.setVisibility(on ? View.GONE : View.VISIBLE);
        if (spinner != null) spinner.setVisibility(on ? View.VISIBLE : View.GONE);
    }

    /** 球完全收到屏幕外所需的位移：它自己的高度 + 上边距。 */
    private int hiddenPx() {
        int h = ball != null && ball.getHeight() > 0 ? ball.getHeight() : dp(BALL_DP);
        int margin = Math.round(BALL_MARGIN_DP * getResources().getDisplayMetrics().density);
        if (ball != null && ball.getLayoutParams() instanceof MarginLayoutParams) {
            margin = ((MarginLayoutParams) ball.getLayoutParams()).topMargin;
        }
        return h + margin;
    }

    private int fadePx() {
        return dp(FADE_DP);
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
