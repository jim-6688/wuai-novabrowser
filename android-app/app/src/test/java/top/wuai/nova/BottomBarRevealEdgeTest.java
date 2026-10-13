package top.wuai.nova;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * QA 补充：{@link BottomBarReveal} 的边界用例。
 *
 * <p>工程师的 {@link BottomBarRevealTest} 覆盖了常规路径与 120 下滚阈值。
 * 这里补：负数 scrollY、恰好等于 60/40 两个阈值、连续同向累积、一次超大跳变、
 * {@code reset()} 的复位语义 —— 以及一条<b>刻意记录下的风险行为</b>。
 */
public class BottomBarRevealEdgeTest {

    private static final BottomBarReveal.State BAR = BottomBarReveal.State.SHOW_BAR;
    private static final BottomBarReveal.State CAP = BottomBarReveal.State.SHOW_CAPSULE;

    @Test
    public void 负数滚动位置当作顶部处理() {
        BottomBarReveal r = new BottomBarReveal();
        // scrollY 为负只可能出现在「越界回弹」的瞬间，绝不该因此浮出胶囊
        assertEquals(BAR, r.onScroll(-1));
        assertEquals(BAR, r.onScroll(-999));
        assertEquals(BAR, r.state());
    }

    @Test
    public void 恰好等于顶部阈值40仍回底栏() {
        BottomBarReveal r = new BottomBarReveal();
        r.onScroll(0);
        assertEquals(BAR, r.onScroll(40));
    }

    @Test
    public void 恰好等于上滚阈值60恢复底栏() {
        BottomBarReveal r = new BottomBarReveal();
        r.onScroll(0);
        assertEquals(CAP, r.onScroll(500));
        // 从 500 回到 440，位移 -60，正好抵消阈值
        assertEquals(BAR, r.onScroll(440));
    }

    @Test
    public void 连续同向累积到阈值才触发() {
        BottomBarReveal r = new BottomBarReveal();
        assertEquals(BAR, r.onScroll(0));
        assertEquals(BAR, r.onScroll(50));
        assertEquals(BAR, r.onScroll(100));
        // 三次同向 50 + 50 + 30 = 130 >= 120
        assertEquals(CAP, r.onScroll(130));
    }

    @Test
    public void 一次超大跳变直接触发() {
        BottomBarReveal r = new BottomBarReveal();
        assertEquals(BAR, r.onScroll(0));
        assertEquals(CAP, r.onScroll(5000));
    }

    @Test
    public void reset会清零累积而不是只改状态() {
        BottomBarReveal r = new BottomBarReveal();
        r.onScroll(0);
        r.onScroll(100);          // accum = 100，差一点没触发
        r.reset();
        // 若 reset 只改 state、不清 accum，下一个 50 会让累积变成 150 误触发
        assertEquals(BAR, r.onScroll(50));
    }

    @Test
    public void reset后回到非零但未越阈的位置仍是底栏() {
        BottomBarReveal r = new BottomBarReveal();
        r.onScroll(400);
        assertEquals(CAP, r.state());
        r.reset();
        assertEquals(BAR, r.state());
        assertEquals(BAR, r.onScroll(100));
    }

    /**
     * 修复验证（原「风险记录」用例，已随修复翻转断言）。
     *
     * <p>旧实现：{@code reset()} 把 {@code lastY} 归零，而主界面重装/切标签后页面的
     * 真实 scrollY 往往不为零；WebView 因 {@code scrollTo()}（见 MainActivity#onPageFinished
     * 的还原滚动）回吐一个大 scrollY 时，第一帧就被算成「从 0 猛滚到底」→ 状态机跳胶囊，
     * 表现是切到「上次滚过一段」的标签后底栏莫名隐藏。
     *
     * <p>修复后：{@code reset()} 之后的首个样本只用来重新定基准，不参与判定。
     */
    @Test
    public void reset后首个大位置样本不会被当成猛滚() {
        BottomBarReveal r = new BottomBarReveal();
        r.reset(800);                 // 切标签后页面真实位置
        // 首个样本（scrollTo 回吐 800）：只定基准，不该弹胶囊
        assertEquals(BAR, r.onScroll(800));
        // 之后用户真的下滑 150px，才应弹出胶囊
        assertEquals(CAP, r.onScroll(950));
    }

    @Test
    public void 无参reset后首个大样本也只定基准() {
        // 拿不到真实位置时用的无参重载，同样不能让首个大样本误触发
        BottomBarReveal r = new BottomBarReveal();
        r.reset();
        assertEquals(BAR, r.onScroll(3000));
    }

    @Test
    public void 方向反转清零_先上后下也不会累积出误触发() {
        BottomBarReveal r = new BottomBarReveal();
        assertEquals(BAR, r.onScroll(60));   // accum 60
        assertEquals(CAP, r.onScroll(600));  // 触发并清零
        assertEquals(BAR, r.onScroll(400));  // 上滚 -200 恢复底栏
        assertEquals(CAP, r.onScroll(650));  // 再下滚触发
    }
}
