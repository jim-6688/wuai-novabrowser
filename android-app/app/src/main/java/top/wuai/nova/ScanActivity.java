package top.wuai.nova;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.SurfaceTexture;
import android.hardware.Camera;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.WindowManager;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * 扫码界面：自己用 Camera 预览 + ZXing core 解码，不依赖任何第三方扫码 UI 库。
 *
 * <p>为什么不用 ZXing Embedded：它的 4.x 已经把扫码 Activity 拆走了，只剩一个
 * {@code IntentIntegrator} 去调「系统里别的扫码 app」，在没有装扫码 app 的机器上
 * 会直接 {@code ActivityNotFoundException} 崩溃。所以我们自己画预览、自己解码，
 * 完全可控，也不引入 androidx/appcompat 依赖。
 *
 * <p>解码跑在独立的 HandlerThread 上，绝不阻塞预览回调与主线程。
 */
public class ScanActivity extends Activity implements SurfaceHolder.Callback {
    public static final String EXTRA_SCAN = "scan";

    private SurfaceView surface;
    private Camera camera;
    private boolean previewing = false;
    private volatile boolean decoding = false;
    private HandlerThread decodeThread;
    private Handler decodeHandler;
    private final MultiFormatReader reader = new MultiFormatReader();

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        setContentView(R.layout.activity_scan);

        surface = findViewById(R.id.scanSurface);
        TextView close = findViewById(R.id.scanClose);
        close.setOnClickListener(v -> finish());
        surface.getHolder().addCallback(this);

        // 扫码只认 QR：PC 地址栏分享面板那张就是 QR。
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS,
                Collections.singletonList(BarcodeFormat.QR_CODE));
        reader.setHints(hints);

        decodeThread = new HandlerThread("scan-decode");
        decodeThread.start();
        decodeHandler = new Handler(decodeThread.getLooper());
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        openCamera(holder);
    }

    @Override
    public void surfaceChanged(SurfaceHolder h, int f, int w, int hh) { }

    @Override
    public void surfaceDestroyed(SurfaceHolder h) {
        releaseCamera();
    }

    private void openCamera(SurfaceHolder holder) {
        if (camera != null) return;
        try {
            camera = Camera.open(Camera.CameraInfo.CAMERA_FACING_BACK);
            if (camera == null) { fail("无法打开相机"); return; }
            Camera.Parameters p = camera.getParameters();
            Camera.Size best = chooseSize(p.getSupportedPreviewSizes(), 1280, 720);
            if (best != null) p.setPreviewSize(best.width, best.height);
            List<String> focusModes = p.getSupportedFocusModes();
            if (focusModes != null
                    && focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            }
            camera.setParameters(p);
            camera.setDisplayOrientation(90);
            camera.setPreviewDisplay(holder);
            camera.setPreviewCallback(previewCb);
            camera.startPreview();
            previewing = true;
        } catch (Exception e) {
            fail("相机初始化失败：" + e.getMessage());
        }
    }

    private final Camera.PreviewCallback previewCb = new Camera.PreviewCallback() {
        @Override
        public void onPreviewFrame(byte[] data, Camera cam) {
            if (data == null || decoding || !previewing) return;
            decoding = true;
            Camera.Size s = cam.getParameters().getPreviewSize();
            decodeHandler.post(() -> {
                try {
                    // 竖屏下预览帧是横向的，先顺时针转 90° 成竖向再喂解码。
                    byte[] rotated = rotateNV21(data, s.width, s.height, 90);
                    int w = s.height, h = s.width;
                    PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(
                            rotated, w, h, 0, 0, w, h, false);
                    BinaryBitmap bmp = new BinaryBitmap(new HybridBinarizer(src));
                    Result r = reader.decodeWithState(bmp);
                    runOnUiThread(() -> deliver(r.getText()));
                } catch (NotFoundException e) {
                    // 这一帧没扫到，下一帧继续。
                } catch (Exception e) {
                    // 其它解码异常忽略，避免卡住预览。
                } finally {
                    decoding = false;
                }
            });
        }
    };

    private void deliver(String text) {
        if (text == null) return;
        Intent i = new Intent();
        i.putExtra(EXTRA_SCAN, text);
        setResult(RESULT_OK, i);
        finish();
    }

    private void fail(String msg) {
        runOnUiThread(() -> {
            Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
            finish();
        });
    }

    private void releaseCamera() {
        if (camera != null) {
            try {
                camera.setPreviewCallback(null);
                camera.stopPreview();
                camera.release();
            } catch (Exception ignored) { }
            camera = null;
        }
        previewing = false;
    }

    @Override
    protected void onPause() {
        super.onPause();
        releaseCamera();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (camera == null && surface.getHolder() != null) openCamera(surface.getHolder());
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        releaseCamera();
        if (decodeThread != null) decodeThread.quitSafely();
    }

    private static Camera.Size chooseSize(List<Camera.Size> sizes, int tw, int th) {
        if (sizes == null || sizes.isEmpty()) return null;
        Camera.Size best = null;
        long minDiff = Long.MAX_VALUE;
        for (Camera.Size s : sizes) {
            long diff = Math.abs((long) s.width * s.height - (long) tw * th);
            if (diff < minDiff) { minDiff = diff; best = s; }
        }
        return best;
    }

    /** NV21 顺时针旋转 90°。相机预览帧是横向的，竖屏下需转成竖向再喂解码。 */
    private static byte[] rotateNV21(byte[] data, int w, int h, int degree) {
        if (degree != 90) return data;
        byte[] out = new byte[data.length];
        int ySize = w * h;
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                out[x * h + (h - y - 1)] = data[y * w + x];
            }
        }
        for (int y = 0; y < h / 2; y++) {
            for (int x = 0; x < w / 2; x++) {
                int src = ySize + (y * w + x) * 2;
                int dst = ySize + (x * h + (h / 2 - y - 1)) * 2;
                out[dst] = data[src];
                out[dst + 1] = data[src + 1];
            }
        }
        return out;
    }
}
