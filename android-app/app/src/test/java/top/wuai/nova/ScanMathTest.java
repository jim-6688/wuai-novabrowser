package top.wuai.nova;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 扫码相机的纯计算单测（纯 JVM，不碰 Android）。
 *
 * <p>这几段逻辑以前埋在 ScanActivity 里，只能真机验证 —— 而真机验证恰恰是
 * 「扫码相机打不开」拖了这么久没定位的原因。抽出来之后，最容易写错的
 * 「选尺寸 / 旋转 / 方向」现在都能在这里钉住。
 */
public class ScanMathTest {

    /* ---------------------------------------------------------------- 尺寸选择 */

    @Test
    public void 选最接近目标像素数的尺寸() {
        int[] w = {640, 1280, 1920};
        int[] h = {480, 720, 1080};
        // 1280x720 = 921600，目标 1280x720 也是它 → 精确命中
        assertArrayEquals(new int[]{1280, 720}, ScanMath.choosePreviewSize(w, h, 1280, 720));
    }

    @Test
    public void 没有精确命中时取面积最接近的() {
        int[] w = {320, 640, 1920};
        int[] h = {240, 480, 1080};
        // 目标 1280x720=921600：|640x480-921600|=614400，|1920x1080-921600|=1152000 → 640x480 更近
        assertArrayEquals(new int[]{640, 480}, ScanMath.choosePreviewSize(w, h, 1280, 720));
    }

    @Test
    public void 空或非法尺寸返回null() {
        assertNull(ScanMath.choosePreviewSize(null, null, 1280, 720));
        assertNull(ScanMath.choosePreviewSize(new int[0], new int[0], 1280, 720));
        // 全是非法值（<=0）也算没有可用尺寸
        assertNull(ScanMath.choosePreviewSize(new int[]{0, -1}, new int[]{0, -1}, 1280, 720));
    }

    @Test
    public void 宽高数组长度不一致时按短的算() {
        int[] w = {640, 1280, 1920};
        int[] h = {480};
        assertArrayEquals(new int[]{640, 480}, ScanMath.choosePreviewSize(w, h, 640, 480));
    }

    /* ---------------------------------------------------------------- 显示方向 */

    @Test
    public void 后摄竖屏方向等于相机自身角度() {
        // 绝大多数手机后摄 orientation=90，竖屏锁定时显示方向就是 90
        assertEquals(90, ScanMath.displayOrientation(90, false, 0));
        assertEquals(270, ScanMath.displayOrientation(270, false, 0));
    }

    @Test
    public void 后摄横屏要减掉屏幕旋转() {
        // 屏幕转了 90（横屏），后摄 90-90=0
        assertEquals(0, ScanMath.displayOrientation(90, false, 90));
        // 180 旋转：90-180 = -90 → 归一到 270
        assertEquals(270, ScanMath.displayOrientation(90, false, 180));
    }

    @Test
    public void 前摄方向是镜像的() {
        // 官方公式：result = (orientation + degrees) % 360; 再 result = (360 - result) % 360
        // orientation=270、竖屏 0 → 270 → 360-270 = 90
        assertEquals(90, ScanMath.displayOrientation(270, true, 0));
        // orientation=90、屏幕转 270 → (90+270)%360=0 → 360-0 = 0
        assertEquals(0, ScanMath.displayOrientation(90, true, 270));
    }

    @Test
    public void 方向结果永远是0到359() {
        int[] orientations = {0, 90, 180, 270};
        int[] displays = {0, 90, 180, 270};
        for (int o : orientations) {
            for (int d : displays) {
                int back = ScanMath.displayOrientation(o, false, d);
                int front = ScanMath.displayOrientation(o, true, d);
                assertTrue("后摄越界: " + back, back >= 0 && back < 360);
                assertTrue("前摄越界: " + front, front >= 0 && front < 360);
            }
        }
    }

    /* ---------------------------------------------------------------- NV21 旋转 */

    @Test
    public void nv21旋转90度把左上角送到右上角() {
        // 2x2 的 Y 平面：1 2 / 3 4 → 顺时针 90° 后：3 1 / 4 2（按行读）
        int w = 2, h = 2;
        byte[] data = new byte[w * h * 3 / 2];
        data[0] = 1; data[1] = 2; data[2] = 3; data[3] = 4; // Y
        // UV 平面填 0，不参与断言

        byte[] out = ScanMath.rotateNV21(data, w, h, 90);
        assertEquals(3, out[0]); // 新 (0,0) 来自原 (0,1)
        assertEquals(1, out[1]); // 新 (0,1) 来自原 (0,0)
        assertEquals(4, out[2]); // 新 (1,0) 来自原 (1,1)
        assertEquals(2, out[3]); // 新 (1,1) 来自原 (1,0)
    }

    @Test
    public void 非90度原样返回() {
        byte[] data = {1, 2, 3, 4, 5, 6};
        assertSame(data, ScanMath.rotateNV21(data, 2, 2, 0));
        assertSame(data, ScanMath.rotateNV21(data, 2, 2, 180));
    }

    @Test
    public void 帧不完整时不动它() {
        // 声明 4x4（需要 24 字节），实际只给 6 字节 → 不能越界，原样返回
        byte[] data = {1, 2, 3, 4, 5, 6};
        assertSame(data, ScanMath.rotateNV21(data, 4, 4, 90));
    }

    @Test
    public void 空值不炸() {
        assertNull(ScanMath.rotateNV21(null, 2, 2, 90));
        byte[] data = {1, 2, 3, 4, 5, 6};
        assertSame(data, ScanMath.rotateNV21(data, 0, 2, 90));
    }

    /* ---------------------------------------------------------------- 错误归类 */

    @Test
    public void 没有权限的异常要先于通用运行时异常被认出() {
        // SecurityException 是 RuntimeException 的子类，顺序写反就会被当成「相机占用」
        assertEquals(ScanMath.REASON_NO_PERMISSION,
                ScanMath.classifyOpenError(new SecurityException("no permission")));
    }

    @Test
    public void 相机被占用() {
        assertEquals(ScanMath.REASON_IN_USE,
                ScanMath.classifyOpenError(new RuntimeException("Fail to connect to camera service")));
    }

    @Test
    public void 预览启动失败() {
        assertEquals(ScanMath.REASON_START_FAILED,
                ScanMath.classifyOpenError(new RuntimeException("startPreview failed")));
    }

    @Test
    public void 未知异常不会误判() {
        assertEquals(ScanMath.REASON_UNKNOWN, ScanMath.classifyOpenError(new Exception("whatever")));
        assertEquals(ScanMath.REASON_UNKNOWN, ScanMath.classifyOpenError(null));
    }

    /* ---------------------------------------------------------------- 文案 */

    @Test
    public void 每种失败都有面向用户的中文说明() {
        int[] reasons = {
                ScanMath.REASON_NO_PERMISSION,
                ScanMath.REASON_IN_USE,
                ScanMath.REASON_NO_CAMERA,
                ScanMath.REASON_START_FAILED,
                ScanMath.REASON_UNKNOWN
        };
        for (int r : reasons) {
            String msg = ScanMath.explainFailure(r);
            assertTrue("原因 " + r + " 没有文案", msg != null && msg.length() > 0);
            // 不能把异常类名或英文栈信息丢给用户
            assertTrue("文案里混进了技术术语: " + msg,
                    !msg.contains("Exception") && !msg.contains("null"));
        }
    }

    @Test
    public void 权限文案要说明是权限问题() {
        assertTrue(ScanMath.explainFailure(ScanMath.REASON_NO_PERMISSION).contains("权限"));
    }

    @Test
    public void 占用文案要告诉用户怎么办() {
        assertTrue(ScanMath.explainFailure(ScanMath.REASON_IN_USE).contains("占用"));
    }
}
