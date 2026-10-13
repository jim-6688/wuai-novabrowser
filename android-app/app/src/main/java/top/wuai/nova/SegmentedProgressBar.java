package top.wuai.nova;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.View;

import java.util.ArrayList;
import java.util.List;

/**
 * 分段进度条：一格 = 一条连接。
 *
 * <p>下载任务行里那个最显眼的控件。刻意不用 {@link android.widget.ProgressBar}：
 * 它只有一个整体进度，表达不了「八条连接各自跑到哪」。而多线程下载里最该被看见的
 * 恰恰是这件事 —— 哪几条已经收完、哪条在拖后腿。
 *
 * <h3>为什么自己画而不是用一排 View</h3>
 *
 * <p>下载进度是每秒都在刷新的。用一排子 View 拼，每次刷新都要增删或改宽高，
 * 那就是每帧一次 measure/layout 风暴，且线程数变化时还要重建视图树。
 * 一个 View 自己画，刷新只是 {@link #setSegments} + {@code invalidate()}，
 * 线程数从 1 变 8 也只是同一个 View 换个画法。
 *
 * <h3>为什么要 clip</h3>
 *
 * <p>设计上外框是圆角、每格是直角。Android 里没有「子元素跟着父元素圆角裁切」的
 * 免费午餐（除非开 clipToOutline + 外层再包一层），所以这里把圆角矩形做成一条
 * 裁剪路径，逐格填色时超出圆角的部分自然被切掉。不这么做的话，第一格和最后一格
 * 会从圆角里探出来两个尖角。
 */
public class SegmentedProgressBar extends View {

    /** 格与格之间的缝。缝里露出的是底层的 track 色，看起来就是一条分隔线。 */
    private static final float GAP_DP = 2f;
    private static final float RADIUS_DP = 3f;
    /** 总长未知时那层的透明度。太实会被当成「跑了一半」，太淡又看不见。 */
    private static final int UNKNOWN_ALPHA = 70;

    private List<DownloadUi.Seg> segs = new ArrayList<>();

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path clip = new Path();
    private final RectF box = new RectF();

    private final int trackColor;
    private final int cellColor;
    private final int brandColor;
    private final int okColor;

    private final float gap;
    private final float radius;

    public SegmentedProgressBar(Context context) {
        this(context, null);
    }

    public SegmentedProgressBar(Context context, AttributeSet attrs) {
        this(context, attrs, 0);
    }

    public SegmentedProgressBar(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        trackColor = context.getColor(R.color.border);
        cellColor = context.getColor(R.color.surface_3);
        brandColor = context.getColor(R.color.brand);
        okColor = context.getColor(R.color.ok);
        float d = getResources().getDisplayMetrics().density;
        gap = GAP_DP * d;
        radius = RADIUS_DP * d;
    }

    /** 传 {@link DownloadUi#segments} 的结果。传空列表就只画一条空槽。 */
    public void setSegments(List<DownloadUi.Seg> list) {
        segs = list == null ? new ArrayList<>() : list;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float left = getPaddingLeft();
        float right = getWidth() - getPaddingRight();
        float top = getPaddingTop();
        float bottom = getHeight() - getPaddingBottom();
        float w = right - left;
        float h = bottom - top;
        if (w <= 0 || h <= 0) return;

        float rr = Math.min(radius, h / 2f);

        // 底层铺 track 色：格与格之间的缝露出来的就是它。不铺的话缝里是透明，
        // 深浅色主题下会看到背景透出来，缝会变成一条断掉的虚线。
        box.set(left, top, right, bottom);
        paint.setColor(trackColor);
        canvas.drawRoundRect(box, rr, rr, paint);

        clip.reset();
        clip.addRoundRect(box, rr, rr, Path.Direction.CW);
        canvas.save();
        canvas.clipPath(clip);

        int n = Math.max(1, segs.size());
        // 缝占掉 (n-1) 条，剩下的均分给各格。n 很大而控件很窄时会算出非正数，
        // 那就别画了 —— 画出来是一团互相覆盖的色块，比空着更糟。
        float segW = (w - gap * (n - 1)) / n;
        if (segW <= 0) {
            canvas.restore();
            return;
        }

        for (int i = 0; i < n; i++) {
            float x = left + i * (segW + gap);

            // 每格的底色。哪怕这条连接一点没跑，也要有一块灰摆在那 ——
            // 空着的格子和「只有一条连接」在视觉上必须能分开。
            paint.setColor(cellColor);
            canvas.drawRect(x, top, x + segW, bottom, paint);

            if (i >= segs.size()) continue;
            DownloadUi.Seg s = segs.get(i);

            if (s.fill == DownloadUi.UNKNOWN) {
                // 总长未知：整格铺一层很淡的品牌色。它表达的是「这条连接在动」，
                // 而不是「跑了这么多」—— 所以满格铺、低透明度，不能画成半格。
                paint.setColor(brandColor);
                paint.setAlpha(UNKNOWN_ALPHA);
                canvas.drawRect(x, top, x + segW, bottom, paint);
                paint.setAlpha(255);
                continue;
            }
            if (s.fill <= 0f) continue;

            // 跑完的连接换成 ok 色：一眼能看出「这条已经收工了」，
            // 剩下的品牌色格子就是还在跑的。
            paint.setColor(s.done ? okColor : brandColor);
            canvas.drawRect(x, top, x + segW * s.fill, bottom, paint);
        }

        canvas.restore();
    }
}
