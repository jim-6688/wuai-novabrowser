package top.wuai.nova;

import android.graphics.Bitmap;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;

import java.util.EnumMap;
import java.util.Map;

/**
 * 把一串文字（这里是网址）编码成二维码 Bitmap。
 *
 * <p>复用项目里已有的 ZXing core —— {@code app/build.gradle} 里给 {@code ScanActivity}
 * 解码用的 {@code com.google.zxing:core:3.5.3}，纯 Java、无需任何新依赖。
 *
 * <h3>为什么不引新的二维码库</h3>
 *
 * <p>二维码「生成」与「解码」在 ZXing 里是同一份 core 的两个入口：解码端已经把整包
 * 拉进来了，生成端只是再调一个 {@link QRCodeWriter}，边际成本为零。本工程零第三方依赖，
 * 能复用就绝不新引。详见 {@link ApkProvider} 注释里讲过的同一套取舍。
 *
 * <h3>为什么自己把 BitMatrix 画成 Bitmap</h3>
 *
 * <p>{@link QRCodeWriter#encode} 只产出 {@link BitMatrix}（一个黑/白点阵），不带任何
 * 上色逻辑。自己遍历点阵写像素，能精确控制「黑点 = 不透明、白点 = 全透明」——
 * 透明底让二维码在深色弹层上也清晰，而默认的白底在暗背景里会发灰、降低扫码成功率。
 */
public final class QrGen {

    private QrGen() {}

    /**
     * 留白边宽，单位「模块」(px)。太小扫码器不好定位，太大浪费空间。
     * ZXing 的 MARGIN 提示按「模块数」理解；取 2 即在码体四周各留 2 个模块的安静区，
     * 满足大多数扫码器对 quiet zone 的最低要求（通常 ≥1 模块）。
     */
    public static final int MARGIN = 2;

    /**
     * 把文字编码成 size×size 的二维码。
     *
     * @param text 要编码的文字（网址）。
     * @param size 输出边长（像素）；建议足够大以保证模块清晰，弹层里再缩放显示即可。
     * @return 透明底 + 黑点的 {@link Bitmap}；编码失败（空串 / 容量超限）时返回 null。
     */
    public static Bitmap make(String text, int size) {
        if (text == null || text.isEmpty() || size <= 0) return null;
        try {
            Map<EncodeHintType, Object> hints = new EnumMap<>(EncodeHintType.class);
            // M 级纠错：约 15% 容损，网址不长、又不印在易磨损表面，这个级别足够，
            // 比 H 级塞得下更多模块、码体更小。
            hints.put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M);
            hints.put(EncodeHintType.MARGIN, MARGIN);
            // 把码体塞进 size×size 的方框里，ZXing 会自动居中并留安静区。
            // 返回的 BitMatrix 维度恰好等于 size，逐像素上色即可。
            BitMatrix m = new QRCodeWriter().encode(
                text, BarcodeFormat.QR_CODE, size, size, hints);
            int w = m.getWidth();
            int h = m.getHeight();
            Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    // 黑点不透明，其余全透明（露出弹层底色，暗背景上一样清晰）。
                    bmp.setPixel(x, y, m.get(x, y) ? 0xFF000000 : 0x00000000);
                }
            }
            return bmp;
        } catch (WriterException e) {
            return null;
        }
    }
}
