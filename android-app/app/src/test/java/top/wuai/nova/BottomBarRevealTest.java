package top.wuai.nova;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * 下滑浮现胶囊搜索框的「滚动 → 显隐」判定。
 *
 * <p>这套阈值的错法在真机上极难复现：要么底栏来回闪，要么上滑了它也不回来，
 * 而两者都跟「手速」有关。抽成纯状态机就是为了在这里把每条边界钉死。
 */
public class BottomBarRevealTest {

    private static final BottomBarReveal.State BAR = BottomBarReveal.State.SHOW_BAR;
    private static final BottomBarReveal.State CAP = BottomBarReveal.State.SHOW_CAPSULE;

    @Test
    public void 初始是底栏可见() {
        assertEquals(BAR, new BottomBarReveal().state());
    }

    @Test
    public void 向下越过阈值浮出胶囊() {
        BottomBarReveal r = new BottomBarReveal();
        assertEquals(BAR, r.onScroll(0));
        assertEquals(CAP, r.onScroll(200));
    }

    @Test
    public void 向上越过阈值恢复底栏() {
        BottomBarReveal r = new BottomBarReveal();
        r.onScroll(0);
        assertEquals(CAP, r.onScroll(500));
        // 往回滑一段（远离顶部），应恢复底栏
        assertEquals(BAR, r.onScroll(380));
    }

    @Test
    public void 接近顶部无条件恢复底栏() {
        BottomBarReveal r = new BottomBarReveal();
        r.onScroll(0);
        assertEquals(CAP, r.onScroll(600));
        // 20 <= TOP_ZONE(40)：只要进了顶部区，就该无条件把底栏叫回来
        assertEquals(BAR, r.onScroll(20));
    }

    @Test
    public void 阈值边界刚好触发() {
        BottomBarReveal r = new BottomBarReveal();
        assertEquals(BAR, r.onScroll(0));
        // 累计 119 还差一点，不该触发
        assertEquals(BAR, r.onScroll(119));
        // 再多 1px 刚好到 120，触发
        assertEquals(CAP, r.onScroll(120));
    }

    @Test
    public void 小幅抖动不改变状态() {
        BottomBarReveal r = new BottomBarReveal();
        r.onScroll(0);
        // 一屏内来回十几像素的抖动，永远凑不够阈值
        assertEquals(BAR, r.onScroll(30));
        assertEquals(BAR, r.onScroll(45));
        assertEquals(BAR, r.onScroll(38));
        assertEquals(BAR, r.onScroll(52));
        assertEquals(BAR, r.onScroll(60));
        assertEquals(BAR, r.state());
    }

    @Test
    public void 方向反转会清零累积_down后up不再凑够阈值() {
        BottomBarReveal r = new BottomBarReveal();
        r.onScroll(0);
        // 向下累计 115，差一点到 120
        assertEquals(BAR, r.onScroll(115));
        // 方向反转：累积清零，之前的 115 不该被保留
        assertEquals(BAR, r.onScroll(60));
        // 再往下一点点也只有 10，仍然不触发
        assertEquals(BAR, r.onScroll(70));
    }

    @Test
    public void 触发之后残留累积不引起抖动() {
        BottomBarReveal r = new BottomBarReveal();
        r.onScroll(0);
        assertEquals(CAP, r.onScroll(200));
        // 判断已经触发并清零了累积，紧接着的小幅滚动不该把它顶回底栏
        assertEquals(CAP, r.onScroll(210));
        assertEquals(CAP, r.state());
    }

    @Test
    public void 复位回到底栏可见() {
        BottomBarReveal r = new BottomBarReveal();
        r.onScroll(0);
        r.onScroll(400);
        assertEquals(CAP, r.state());
        r.reset();
        assertEquals(BAR, r.state());
        // 复位后首个样本只用来重新定基准：无论它多大都不会被当成一次猛滚
        assertEquals(BAR, r.onScroll(100));
    }

    @Test
    public void 复位后首个样本只作基准不作判定() {
        // 切到「上次滚过一段」的标签：reset 传入真实位置后，WebView 回吐的首个
        // 大样本只更新基准，状态保持不变；要真的下滑超过阈值才弹胶囊。
        BottomBarReveal r = new BottomBarReveal();
        r.reset(800);
        assertEquals(BAR, r.onScroll(800));
        assertEquals(CAP, r.onScroll(950));
    }

    @Test
    public void 挪基准不改变当前状态() {
        BottomBarReveal r = new BottomBarReveal();
        r.onScroll(0);
        assertEquals(CAP, r.onScroll(300));
        r.syncBaseline(1000);
        assertEquals(CAP, r.state());
    }

    @Test
    public void 程序性补偿只挪基准不作判定() {
        // 收起顶栏后我们把页面反向补了 48px（那不是用户划的）。
        // 基准跟着挪，于是这一下既不算「向下」也不算「向上」；
        // 少了 syncBaseline，它会变成一次莫名其妙的向上拖动 ——
        // 用户再回划 45px 就够到 60px 的回弹阈值，顶栏刚收起来又弹回去。
        BottomBarReveal r = new BottomBarReveal();
        assertEquals(BAR, r.onScroll(0));
        assertEquals(CAP, r.onScroll(300));
        r.syncBaseline(252);                 // 300 - 48
        assertEquals(CAP, r.onScroll(280));  // 用户继续下划一帧
        assertEquals(CAP, r.onScroll(235));  // 再回划 45px：没到阈值，不该弹回来
    }
}
