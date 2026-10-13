package top.wuai.nova;

import android.content.Context;
import android.util.AttributeSet;
import android.util.DisplayMetrics;
import android.widget.LinearLayout;

/**
 * 弹层根容器：把自身高度压到可用空间的一部分。
 *
 * <h3>为什么需要它</h3>
 *
 * <p>弹层是用 {@code FrameLayout.LayoutParams(-1, -2)}（wrap_content）叠上去的，
 * 父容器给下来的是 AT_MOST(整屏高)。于是弹层里那个 {@code 0dp + weight=1} 的
 * 列表会被「分到」整屏剩下的全部高度 —— 哪怕列表里一条内容都没有。
 * 结果就是：一个只有两行字的下载面板，却铺满整屏，下半截一片空白，
 * 看起来像没做完。
 *
 * <p>有人会想到给 ScrollView 加 {@code android:maxHeight}。那个属性对
 * ScrollView 是无效的 —— 框架只在 ImageView 等少数控件里读它，
 * {@link android.view.View#onMeasure} 的默认实现只认 minHeight。
 * 所以只能在测量这一步动手。
 *
 * <h3>为什么在 onMeasure 里改 spec，而不是测完再截断</h3>
 *
 * <p>如果把 {@code super.onMeasure} 的结果改小，子 View 早就已经按「整屏」量过一遍了，
 * 那个 weight 分配过的列表依然是整屏高，只会从容器里溢出去。
 * 必须在把测量规格交给父类之前就压小，这样 LinearLayout 的权重重分配才有界可依。
 */
public class SheetPanel extends LinearLayout {

    /**
     * 弹层最高占可用高度的比例。
     *
     * <p>0.82 是从设计板取的（{@code .sheetc.scroll{max-height:82%}}）。
     * 留出的 18% 是让用户还能看见后面被压暗的网页 —— 弹层盖满全屏时，
     * 人会失去「我是从哪个页面点进来的」这个上下文。
     */
    private static final float MAX_RATIO = 0.82f;

    public SheetPanel(Context context) {
        super(context);
    }

    public SheetPanel(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    public SheetPanel(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int mode = MeasureSpec.getMode(heightMeasureSpec);
        int size = MeasureSpec.getSize(heightMeasureSpec);

        if (mode == MeasureSpec.AT_MOST) {
            int cap = (int) (size * MAX_RATIO);
            heightMeasureSpec = MeasureSpec.makeMeasureSpec(Math.min(size, cap),
                MeasureSpec.AT_MOST);
        } else if (mode == MeasureSpec.UNSPECIFIED) {
            // 没人给上限时才去问屏幕。真正放在屏幕里的弹层走不到这里，
            // 但布局预览和某些自定义容器会给 UNSPECIFIED，这时 size 是 0，
            // 不兜住的话弹层会被压成 0 高。
            DisplayMetrics dm = getResources().getDisplayMetrics();
            int cap = (int) (Math.max(dm.heightPixels, dm.widthPixels) * MAX_RATIO);
            heightMeasureSpec = MeasureSpec.makeMeasureSpec(cap, MeasureSpec.AT_MOST);
        }

        super.onMeasure(widthMeasureSpec, heightMeasureSpec);
    }
}
