package top.wuai.nova;

/**
 * 扫码相机的纯计算部分：预览尺寸选择、NV21 旋转、显示方向。
 *
 * <p>为什么单独一个类：这几段逻辑以前埋在 {@link ScanActivity} 里，而那个类要真机
 * 才能跑 —— 于是「相机打不开」这种问题只能靠猜。抽成不依赖任何 Android 类型的纯类后，
 * 能在 JVM 上直接单测（见 {@code ScanMathTest}），跟 DownloadTask / UaToken 的做法一致。
 *
 * <p>这里不 import android.*：一旦引了 Camera.Size，纯 JVM 单测就跑不起来
 * （android.jar 里的方法是空实现，调用即抛 RuntimeException）。
 */
public final class ScanMath {

    private ScanMath() { }

    /**
     * 选一个最接近目标像素数的预览尺寸。
     *
     * @param widths  候选宽度（与 heights 等长）
     * @param heights 候选高度
     * @param targetW 目标宽
     * @param targetH 目标高
     * @return {宽, 高}；输入不可用时返回 null
     */
    public static int[] choosePreviewSize(int[] widths, int[] heights, int targetW, int targetH) {
        if (widths == null || heights == null) return null;
        int n = Math.min(widths.length, heights.length);
        if (n == 0) return null;

        long target = (long) targetW * targetH;
        int best = -1;
        long minDiff = Long.MAX_VALUE;
        for (int i = 0; i < n; i++) {
            if (widths[i] <= 0 || heights[i] <= 0) continue;
            long area = (long) widths[i] * heights[i];
            long diff = Math.abs(area - target);
            if (diff < minDiff) {
                minDiff = diff;
                best = i;
            }
        }
        if (best < 0) return null;
        return new int[]{widths[best], heights[best]};
    }

    /**
     * 相机的显示方向（度）。
     *
     * <p>公式来自 Android 官方文档的「setDisplayOrientation」示例。后摄是
     * {@code orientation - rotation}，前摄要先加再取反 —— 前摄是镜像的，方向反着来。
     *
     * @param cameraOrientation {@link android.hardware.Camera.CameraInfo#orientation}（0/90/180/270）
     * @param front             是否前置
     * @param displayDegrees    屏幕旋转角度（竖屏锁定时传 0）
     */
    public static int displayOrientation(int cameraOrientation, boolean front, int displayDegrees) {
        int o = ((cameraOrientation % 360) + 360) % 360;
        int d = ((displayDegrees % 360) + 360) % 360;
        if (front) {
            return (360 - ((o + d) % 360)) % 360;
        }
        return (o - d + 360) % 360;
    }

    /**
     * NV21 顺时针旋转 90°（竖屏下预览帧是横向的，要转成竖向再喂解码）。
     *
     * <p>只实现 90°：扫码界面锁竖屏，只有这一种角度会用到；别的角度原样返回，
     * 避免写一堆没被测过的分支。
     *
     * <p><b>色度平面必须按「半分辨率」算步长。</b>NV21 的 UV 是 2×2 子采样：
     * 整幅 {@code w×h} 对应 {@code (w/2)×(h/2)} 个采样点、每点 2 字节（VU）。
     * 早期版本在这里用了整幅的 {@code w}/{@code h}，src 和 dst 都会算到数组末尾之外，
     * 于是在真机分辨率下每一帧都抛 {@code ArrayIndexOutOfBoundsException}；
     * 而 {@link ScanActivity} 把解码异常吞掉了，结果就是「相机正常、画面正常、永远扫不出码」。
     * 2×2 的玩具数据恰好不会越界，所以只有用真实分辨率的单测才能钉住这个 bug。
     */
    public static byte[] rotateNV21(byte[] data, int w, int h, int degree) {
        if (data == null || w <= 0 || h <= 0) return data;
        if (degree != 90) return data;
        int ySize = w * h;
        int uvW = w / 2, uvH = h / 2;
        // 用子采样后的尺寸算所需长度，奇数宽高也不会多要一个字节
        int need = ySize + uvW * uvH * 2;
        if (data.length < need) return data; // 帧不完整就别转了，转了也是垃圾

        byte[] out = new byte[data.length];
        // 亮度平面：原 (x,y) → 旋转后 (h-1-y, x)，新图宽 h、高 w。
        // ZXing 的 PlanarYUVLuminanceSource 只读这一段。
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                out[x * h + (h - y - 1)] = data[y * w + x];
            }
        }
        // 色度平面：旋转后新宽 uvH、新高 uvW，步长一律用子采样后的尺寸。
        for (int y = 0; y < uvH; y++) {
            for (int x = 0; x < uvW; x++) {
                int src = ySize + (y * uvW + x) * 2;
                int dst = ySize + (x * uvH + (uvH - y - 1)) * 2;
                out[dst] = data[src];
                out[dst + 1] = data[src + 1];
            }
        }
        return out;
    }

    /**
     * 相机不可用时给用户看的原因。
     *
     * <p>把异常翻译成人话，而不是把 {@code java.lang.RuntimeException: startPreview failed}
     * 原样丢在屏幕上（那样用户既看不懂，也帮不上我们）。
     */
    public static String explainFailure(int reason) {
        switch (reason) {
            case REASON_NO_PERMISSION:
                return "没有相机权限，无法扫码";
            case REASON_IN_USE:
                return "相机被其他应用占用，先关掉那个应用再试";
            case REASON_NO_CAMERA:
                return "这台设备上没有可用的相机";
            case REASON_START_FAILED:
                return "相机启动失败，点「重试」再试一次";
            default:
                return "相机打不开，点「重试」再试一次";
        }
    }

    public static final int REASON_UNKNOWN = 0;
    public static final int REASON_NO_PERMISSION = 1;
    public static final int REASON_IN_USE = 2;
    public static final int REASON_NO_CAMERA = 3;
    public static final int REASON_START_FAILED = 4;

    /**
     * 把打开相机时的异常归类。
     *
     * <p>顺序有讲究：SecurityException 是 RuntimeException 的子类，必须先判；
     * 「占用」与「没有相机」只能靠 message 认（Camera1 没有专门的错误码）。
     */
    public static int classifyOpenError(Throwable e) {
        if (e == null) return REASON_UNKNOWN;
        if (e instanceof SecurityException) return REASON_NO_PERMISSION;
        String m = String.valueOf(e.getMessage()).toLowerCase();
        if (e instanceof RuntimeException && m.contains("fail to connect")) return REASON_IN_USE;
        if (m.contains("permission")) return REASON_NO_PERMISSION;
        if (m.contains("startpreview") || m.contains("start preview")) return REASON_START_FAILED;
        if (m.contains("no camera") || m.contains("camera not found")) return REASON_NO_CAMERA;
        return REASON_UNKNOWN;
    }
}
