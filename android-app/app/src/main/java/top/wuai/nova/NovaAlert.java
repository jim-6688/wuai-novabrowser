package top.wuai.nova;

import android.app.AlertDialog;
import android.content.Context;

/**
 * 对话框的薄包装。
 *
 * <p>存在的理由只有两个，都不是「省代码」：
 * <ol>
 *   <li>原生 {@code AlertDialog} 在本应用的主题下会带一层 Material 的圆角与动画，
 *       和其余界面（卡片 16dp、白底无阴影）对不齐。</li>
 *   <li>它顺手把「确认类操作必须两段式」这条规矩固定下来 ——
 *       破坏性操作永远带一个明确的否定按钮，不靠「再点一次标题栏返回」当取消。</li>
 * </ol>
 *
 * <p>它<b>不是</b>为了可单测：对话框天生要 Activity，这个类测不了。
 * 真正能测的是它背后那些纯逻辑类。
 */
public final class NovaAlert {

    private final Context ctx;
    private final String title;
    private String message;

    private Runnable onPositive;
    private Runnable onNegative;
    private String positiveText = "确定";
    private String negativeText;
    /** 自定义内容视图（输入框之类）。给了它就不显示 message。 */
    private android.view.View customView;

    public NovaAlert(Context ctx, String title, String message) {
        this.ctx = ctx;
        this.title = title;
        this.message = message;
    }

    /**
     * 自定义内容区。用于「要用户填一个地址」这种必须输入才成立的场景 ——
     * 用 message 塞一行文字再让用户在别处填，等于多绕一圈。
     *
     * <p>用了它就别再给 message，两个同时存在会让原生对话框把它们一起显示，
     * 结果是输入框被挤到最下面。
     */
    public NovaAlert custom(android.view.View v) {
        this.customView = v;
        return this;
    }

    public NovaAlert positive(String label, Runnable cb) {
        this.positiveText = label;
        this.onPositive = cb;
        return this;
    }

    public NovaAlert negative(String label, Runnable cb) {
        this.negativeText = label;
        this.onNegative = cb;
        return this;
    }

    public void show() {
        AlertDialog.Builder b = new AlertDialog.Builder(ctx).setTitle(title);
        if (customView != null) {
            b.setView(customView);
        } else if (message != null) {
            b.setMessage(message);
        }
        b.setPositiveButton(positiveText, (d, w) -> {
            if (onPositive != null) onPositive.run();
        });
        if (negativeText != null) {
            b.setNegativeButton(negativeText, (d, w) -> {
                if (onNegative != null) onNegative.run();
            });
        }
        AlertDialog d = b.create();
        d.show();
        // 原生对话框的窗口背景是一块 Material 圆角白片，和其余界面
        // （卡片 16dp、白底无阴影）对不齐。要对齐就得把它换成主题自己的卡片底。
        android.view.Window w = d.getWindow();
        if (w != null) {
            w.setBackgroundDrawableResource(R.drawable.card);
        }
    }
}