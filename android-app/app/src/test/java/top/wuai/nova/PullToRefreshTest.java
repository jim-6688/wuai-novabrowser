package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 下拉刷新的判定。全部是纯 JVM 测试 —— {@link PullToRefresh} 刻意不碰任何
 * Android 类，就是为了能这样直接测（碰了框架类会变成 {@code Stub!} 异常）。
 *
 * <p>density 一律传 1，于是「dp 常量」与「像素」数值相等，断言里可以直接写
 * 52 / 68 这些常量值，不用在每条里乘一遍密度；密度换算单独由最后一条测。
 */
public class PullToRefreshTest {

    /** 起手容差。真机上来自 ViewConfiguration，这里固定 8 便于算。 */
    private static final int SLOP = 8;
    /** 超过容差、但正好拉到位所需的位移。 */
    private static final int TO_TRIGGER = SLOP + (int) PullToRefresh.TRIGGER_DP;

    private PullToRefresh fresh() {
        return new PullToRefresh(1f, SLOP);
    }

    /** 一路拉到「可以松手」的状态。 */
    private PullToRefresh pulledToReady() {
        PullToRefresh p = fresh();
        p.begin(true);
        p.drag(TO_TRIGGER);
        return p;
    }

    @Test
    public void 初始是收起的_不显示指示器也不武装() {
        PullToRefresh p = fresh();
        assertEquals(PullToRefresh.State.IDLE, p.state());
        assertFalse(p.active());
        assertFalse(p.armed());
        assertEquals(0, p.offsetPx());
        assertFalse(p.refreshing());
    }

    @Test
    public void 页面不在顶部时整场手势都不武装() {
        PullToRefresh p = fresh();
        assertFalse(p.begin(false));
        // 页面还能往上滚的时候，手指往下划是「把页面滚回去」——
        // 这时候把事件抢过来，用户会觉得页面卡住了
        assertFalse(p.drag(TO_TRIGGER + 200));
        assertFalse(p.active());
        assertEquals(PullToRefresh.State.IDLE, p.state());
    }

    @Test
    public void 起手容差以内不吃事件也不显示球() {
        PullToRefresh p = fresh();
        p.begin(true);
        assertFalse(p.drag(SLOP));
        assertEquals(PullToRefresh.State.IDLE, p.state());
        assertFalse(p.active());
        // 但武装保留：手指在同一场手势里继续往下拉，仍然算数
        assertTrue(p.armed());
        assertTrue(p.drag(SLOP + 1));
        assertEquals(PullToRefresh.State.PULL, p.state());
    }

    @Test
    public void 没过阈值是拉动态_过了阈值是可以松手() {
        PullToRefresh p = fresh();
        p.begin(true);
        p.drag(SLOP + (int) PullToRefresh.TRIGGER_DP - 1);
        assertEquals(PullToRefresh.State.PULL, p.state());
        p.drag(SLOP + (int) PullToRefresh.TRIGGER_DP);
        assertEquals(PullToRefresh.State.READY, p.state());
    }

    @Test
    public void 拉到位的那一刻球正好完全露出来() {
        PullToRefresh p = pulledToReady();
        assertEquals(PullToRefresh.State.READY, p.state());
        // TRIGGER_DP × SLOPE_BEFORE = 52 × 0.85 ≈ 44，正好等于球从屏幕外滑到
        // 既定位置所需的那段位移（球 34dp + 上边距 10dp，见 activity_main.xml）。
        // 「球完全露出来」与「可以松手了」是同一个瞬间 —— 这条等式是刻意维持的：
        // 改任一个常量时这里会先红，提醒你两者要求是绑在一起的。
        assertEquals(44, p.offsetPx());
        assertEquals(1f, p.progress(), 0.001f);
    }

    @Test
    public void 阈值一半时进度是一半() {
        PullToRefresh p = fresh();
        p.begin(true);
        p.drag(SLOP + (int) PullToRefresh.TRIGGER_DP / 2);
        assertEquals(0.5f, p.progress(), 0.001f);
    }

    @Test
    public void 没拉到位松手不算刷新() {
        PullToRefresh p = fresh();
        p.begin(true);
        p.drag(SLOP + 10);
        assertFalse(p.release());
        assertEquals(PullToRefresh.State.IDLE, p.state());
        assertFalse(p.active());
        assertEquals(0, p.offsetPx());
    }

    @Test
    public void 拉到位松手才开始刷新() {
        PullToRefresh p = pulledToReady();
        assertTrue(p.release());
        assertEquals(PullToRefresh.State.REFRESHING, p.state());
        assertTrue(p.refreshing());
        assertTrue(p.active());
    }

    @Test
    public void 刷新中球停在松手那一刻的位置() {
        PullToRefresh p = pulledToReady();
        int atRelease = p.offsetPx();
        p.release();
        // 松手后球往上跳一下的观感很差，停在原地才好读成「它接住了」
        assertEquals(atRelease, p.offsetPx());
        // 刷新中手指还在动也不该再改变它
        assertFalse(p.drag(SLOP + 300));
        assertEquals(atRelease, p.offsetPx());
    }

    @Test
    public void 位移有上限_一直往下拉也不会无限深() {
        PullToRefresh p = fresh();
        p.begin(true);
        p.drag(SLOP + 5000);
        assertEquals((int) PullToRefresh.MAX_OFFSET_DP, p.offsetPx());
    }

    @Test
    public void 位移随下拉单调不减() {
        PullToRefresh p = fresh();
        p.begin(true);
        int last = 0;
        for (int travel = 1; travel <= 400; travel++) {
            p.drag(SLOP + travel);
            int now = p.offsetPx();
            assertTrue("travel=" + travel + " 时位移倒退了：" + last + " → " + now,
                now >= last);
            last = now;
        }
    }

    @Test
    public void 同一个位移喂两次结果一样() {
        // 这条不是洁癖：父容器的 onInterceptTouchEvent 与 onTouchEvent
        // 会拿同一个 MOVE 事件各调一次（拦截那一帧是同一个事件走两条路），
        // 如果内部是按增量累加的，这一帧就会被算成两倍位移。
        PullToRefresh a = fresh();
        PullToRefresh b = fresh();
        a.begin(true);
        b.begin(true);
        a.drag(SLOP + 30);
        b.drag(SLOP + 30);
        b.drag(SLOP + 30);
        assertEquals(a.state(), b.state());
        assertEquals(a.offsetPx(), b.offsetPx());
        assertEquals(a.progress(), b.progress(), 0.001f);
    }

    @Test
    public void 退回到容差以内会收起_但手势不作废() {
        PullToRefresh p = fresh();
        p.begin(true);
        p.drag(SLOP + 40);
        assertEquals(PullToRefresh.State.PULL, p.state());
        // 手指退回到起手容差以内：球收起来，事件交回网页。
        // 注意退到 SLOP+2 是不够的 —— 那还剩 2px 的位移，球仍然挂着一点点。
        p.drag(SLOP);
        assertEquals(PullToRefresh.State.IDLE, p.state());
        assertEquals(0, p.offsetPx());
        assertFalse(p.active());
        // 但武装保留 —— 手指只是抖了一下，不该把这一场手势作废
        assertTrue(p.armed());
        assertTrue(p.drag(SLOP + (int) PullToRefresh.TRIGGER_DP));
        assertEquals(PullToRefresh.State.READY, p.state());
        assertTrue(p.release());
    }

    @Test
    public void 退回一点点仍然算拉动() {
        PullToRefresh p = fresh();
        p.begin(true);
        p.drag(SLOP + 1);
        // 1px 也是拉：这里不做「太小就当没拉」的二次判定，
        // 否则手在阈值边缘来回时会一会儿有球一会儿没球
        assertEquals(PullToRefresh.State.PULL, p.state());
        assertTrue(p.active());
        assertTrue(p.offsetPx() >= 0);
    }

    @Test
    public void 刷新中不再武装_拉不出第二次刷新() {
        PullToRefresh p = pulledToReady();
        p.release();
        assertFalse(p.begin(true));
        assertFalse(p.armed());
        assertFalse(p.drag(SLOP + 500));
        // 状态没被拉走，还是刷新中
        assertEquals(PullToRefresh.State.REFRESHING, p.state());
        // 刷新中再抬手也不该又触发一次
        assertFalse(p.release());
        assertEquals(PullToRefresh.State.REFRESHING, p.state());
    }

    @Test
    public void 被中断不算松手() {
        PullToRefresh p = pulledToReady();
        p.cancel();
        assertEquals(PullToRefresh.State.IDLE, p.state());
        assertFalse(p.active());
        // 把「被打断」当成「松手」的话，一次来电就能刷出一个新页面
        assertFalse(p.release());
    }

    @Test
    public void 刷新中的中断不改变状态() {
        PullToRefresh p = pulledToReady();
        p.release();
        p.cancel();
        // 页面加载中被打断（例如转屏）不该让球收回去，
        // 否则球没了、页面还在加载，用户不知道发生了什么
        assertEquals(PullToRefresh.State.REFRESHING, p.state());
    }

    @Test
    public void 收尾只认一次() {
        PullToRefresh p = pulledToReady();
        p.release();
        assertTrue(p.finish());
        assertEquals(PullToRefresh.State.IDLE, p.state());
        assertFalse(p.active());
        assertEquals(0, p.offsetPx());
        // 超时与「页面加载完」会互相抢先，第二次收尾必须什么都不做，
        // 否则会白播一次收场动画
        assertFalse(p.finish());
        // 没在刷新时收尾也什么都不做
        assertFalse(fresh().finish());
    }

    @Test
    public void 收尾之后可以再拉一次() {
        PullToRefresh p = pulledToReady();
        p.release();
        p.finish();
        assertTrue(p.begin(true));
        assertTrue(p.drag(TO_TRIGGER));
        assertEquals(PullToRefresh.State.READY, p.state());
        assertTrue(p.release());
    }

    @Test
    public void 阈值按dp换算而不是按像素写死() {
        // 3 倍屏：52dp 应该是 156px。写成常量像素的话，高密度屏上得拉三倍远才生效。
        PullToRefresh p = new PullToRefresh(3f, 24);
        p.begin(true);
        p.drag(24 + 155);
        assertEquals(PullToRefresh.State.PULL, p.state());
        p.drag(24 + 156);
        assertEquals(PullToRefresh.State.READY, p.state());
        // 位移同样按 dp 走，所以三倍屏上球的行程也正好是 1 倍屏的 3 倍（差 1px 取整）
        int px = p.offsetPx();
        assertTrue("三倍屏位移 " + px + " 不在 44×3 附近", Math.abs(px - 44 * 3) <= 2);
    }

    @Test
    public void 容差为零时仍然可用() {
        // 有些设备 / 测试环境拿不到 touchSlop，退化成 0 也要能正常工作
        PullToRefresh p = new PullToRefresh(1f, 0);
        p.begin(true);
        assertFalse(p.drag(0));
        assertEquals(PullToRefresh.State.IDLE, p.state());
        assertTrue(p.drag(1));
        assertEquals(PullToRefresh.State.PULL, p.state());
    }
}
