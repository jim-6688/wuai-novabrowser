package top.wuai.nova;

import java.util.ArrayList;
import java.util.List;

/**
 * 下载界面里「该怎么显示」的那部分纯逻辑。
 *
 * <p>这里一行 Android 代码都没有，是刻意的：状态到颜色、状态到文案、任务到进度分段，
 * 全是「算错了界面就会说谎」的地方 —— 把 100% 显示成 0%、把单连接显示成 8 线程，
 * 后者会让用户以为文件是完整分片下载的，而实际上服务端不认 Range。
 * 这些判定必须能在本地 JVM 上单测，不能靠真机肉眼看。
 *
 * <h3>为什么界面要按「连接」而不是「百分比」画</h3>
 *
 * <p>多线程下载的价值恰恰在于「几条连接各自跑到哪了」。一个整体的进度条在
 * 「一条连接跑到 90%、其余七条还没启动」和「八条都跑到 11%」上长得一模一样，
 * 而这这两种情况在真实网络里的剩余时间差一个数量级。所以进度按
 * {@link DownloadTask#chunks} 逐格画，一格就是一条连接的进度。
 *
 * <p>退化成单连接时只有一格 —— 这同样重要：{@link DownloadTask#plan} 在服务端不认
 * Range 时会强制单片，此时如果界面还按 8 格画（前 7 格假完成），用户看到的就是
 * 一个骗人的动画。
 */
public final class DownloadUi {

    /** 状态色阶。与设计板上 .dlpill 的五档一一对应。 */
    public enum Tone {
        /** 正在动：下载中 / 合并中 / 探测中 */
        BRAND,
        /** 正常收尾：已完成 */
        OK,
        /** 需要人看一眼，但不是错误 */
        WARN,
        /** 出错了 */
        DANGER,
        /** 排队、暂停、取消这类「停在那」的状态 */
        NEUTRAL
    }

    /** 总长未知。界面画成半透明的品牌色，表示「在动，但不知道还剩多久」。 */
    public static final float UNKNOWN = -1f;

    /** 一格进度。一格 = 一条连接。 */
    public static final class Seg {
        /** 0..1；{@link #UNKNOWN} 表示总长未知。 */
        public final float fill;
        /** 该连接已跑完（画成 ok 色）。 */
        public final boolean done;

        Seg(float fill, boolean done) {
            this.fill = fill;
            this.done = done;
        }
    }

    private DownloadUi() {}

    /** 还在队列或传输中的（含暂停 —— 暂停的任务还是要摆在进行中那一组，否则用户找不到它）。 */
    public static boolean isActive(DownloadTask t) {
        return !t.state.isTerminal();
    }

    public static Tone tone(DownloadTask t) {
        switch (t.state) {
            case RUNNING:
            case PROBING:
            case MERGING:
                return Tone.BRAND;
            case DONE:
                return Tone.OK;
            case FAILED:
                return Tone.DANGER;
            default:
                // QUEUED / PAUSED / CANCELED：都不是错误，用中性色，
                // 免得一个「已暂停」被画成红色，看起来像出事了。
                return Tone.NEUTRAL;
        }
    }

    /**
     * 状态胶囊上的短文案。
     *
     * <p>刻意不用 {@link DownloadTask.State#label}：那个是给整句状态行用的
     * （「探测服务器」），塞进一个胶囊里会把行撑变形。这里是短词。
     */
    public static String pill(DownloadTask t) {
        switch (t.state) {
            case QUEUED:  return "排队中";
            case PROBING: return "探测中";
            case RUNNING: return "下载中";
            case MERGING: return "合并中";
            case DONE:    return "已完成";
            case PAUSED:  return "已暂停";
            case FAILED:  return "失败";
            case CANCELED: return "已取消";
            default:      return t.state.label;
        }
    }

    /**
     * 连接形态。
     *
     * <p>单片时必须明说「单连接」，而不是显示「1 条连接」—— 后者看着像是
     * 用户把线程数设错了，实际是服务端不支持分片，是服务器那边的事。
     */
    public static String connections(DownloadTask t) {
        int n = t.chunks.size();
        return n > 1 ? n + " 条连接" : "单连接";
    }

    /**
     * 把任务拆成一格一格的进度。
     *
     * <p>还没探测出分片（{@link DownloadTask#chunks} 为空）时只给一格：
     * 这一刻引擎自己也不知道会切几片，先画一格比画八格空格诚实。
     */
    public static List<Seg> segments(DownloadTask t) {
        List<Seg> out = new ArrayList<>();
        if (!t.chunks.isEmpty()) {
            for (DownloadTask.Chunk c : t.chunks) {
                long len = c.length();
                float f = len <= 0 ? 0f : (float) ((double) c.received / (double) len);
                if (f < 0f) f = 0f;
                if (f > 1f) f = 1f;
                boolean done = c.complete();
                out.add(new Seg(done ? 1f : f, done));
            }
            return out;
        }

        // 单连接：整体进度就是这一格的进度。
        if (t.state == DownloadTask.State.DONE) {
            out.add(new Seg(1f, true));
            return out;
        }
        int p = t.percent();
        if (p < 0) {
            // 总长未知。给 -1 让控件画成「在动但不知道百分比」的半透明格，
            // 而不是 0% —— 0% 看起来就是不走了。
            out.add(new Seg(UNKNOWN, false));
        } else {
            out.add(new Seg(p / 100f, false));
        }
        return out;
    }

    /**
     * 元信息行第一段：进度 / 大小。
     *
     * <p>总长未知时写「大小未知」而不是拿已下载量冒充总量。
     */
    public static String progress(DownloadTask t) {
        switch (t.state) {
            case DONE:
                return DownloadTask.human(t.received());
            case CANCELED:
                return "已取消 · 已下载 " + DownloadTask.human(t.received());
            case FAILED:
                return "已下载 " + DownloadTask.human(t.received())
                    + " / " + DownloadTask.human(t.totalBytes);
            default:
                break;
        }
        int p = t.percent();
        if (p < 0) {
            return "已下载 " + DownloadTask.human(t.received()) + " · 大小未知";
        }
        return DownloadTask.human(t.received()) + " / " + DownloadTask.human(t.totalBytes)
            + "（" + p + "%）";
    }

    /** 元信息行第二段：保存位置。已完成的文件放在应用私有目录，用户要能知道去哪找。 */
    public static String location(DownloadTask t) {
        return t.state == DownloadTask.State.DONE ? "应用私有目录" : "";
    }
}
