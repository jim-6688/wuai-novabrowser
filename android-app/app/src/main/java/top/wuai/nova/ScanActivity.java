package top.wuai.nova;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.hardware.Camera;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.util.ArrayList;
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
 * <h3>相机只能在 Surface 建好之后开（v2 修的就是这条）</h3>
 * <p>旧版在 {@code onResume()} 里就 {@code Camera.open()} + {@code startPreview()}。
 * 而 SurfaceView 的生命周期是 {@code onResume()} **之后**才回调 {@code surfaceCreated()}，
 * 也就是说在那一刻 Surface 还不存在 —— {@code startPreview()} 必抛
 * {@code RuntimeException: startPreview failed}，被 catch 后 Toast 一下就 {@code finish()}。
 * 用户看到的现象正是「扫码页一闪、摄像头从来没打开过」。
 *
 * <p>所以现在：<b>只有 {@code surfaceCreated()} 才会开相机</b>；{@code onResume()} 只在
 * Surface 已经就绪时补开（比如从后台回来）。失败也不再直接退出，而是把原因写在屏幕上
 * 并给一个「重试」——退出等于让用户连重试的机会都没有。
 *
 * <p>解码跑在独立的 HandlerThread 上，绝不阻塞预览回调与主线程。
 */
public class ScanActivity extends Activity implements SurfaceHolder.Callback {
    private static final String TAG = "NovaScan";
    public static final String EXTRA_SCAN = "scan";

    /** 本页自己申请相机权限用的请求码（MainActivity 已经申请过一次，这里是兜底）。 */
    private static final int REQ_CAMERA = 7201;

    private SurfaceView surface;
    private TextView status;
    private View retry;
    private Camera camera;
    private int cameraId = -1;
    /** Surface 是否已创建。相机只能在这之后开。 */
    private boolean surfaceReady = false;
    private boolean previewing = false;
    private volatile boolean decoding = false;
    /** 已经交过结果（解码线程可能连着送来两帧，只认第一帧）。 */
    private boolean delivered = false;
    private HandlerThread decodeThread;
    private Handler decodeHandler;
    private final MultiFormatReader reader = new MultiFormatReader();
    /** 预览回调。开预览时才创建（它要用到缓存的帧尺寸）。 */
    private Camera.PreviewCallback previewCb = null;
    /** 预览帧尺寸，开预览时缓存下来 —— 回调里每帧都 getParameters() 太贵，某些机型还会抛。 */
    private int previewW = 0;
    private int previewH = 0;
    /** 权限请求已发出、还没回来 —— 防止表面回调连着来几次就弹几次框。 */
    private boolean permissionPending = false;
    /** 连续「解码抛异常」的帧数（正常没扫到不计）。用来把静默失败暴露给用户。 */
    private volatile int decodeFailures = 0;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        setContentView(R.layout.activity_scan);

        surface = findViewById(R.id.scanSurface);
        status = findViewById(R.id.scanStatus);
        retry = findViewById(R.id.scanRetry);

        findViewById(R.id.scanClose).setOnClickListener(v -> finish());
        retry.setOnClickListener(v -> {
            hideStatus();
            decodeFailures = 0;
            if (!surfaceReady) {
                // Surface 一直没建起来（极罕见）：重试也没用，如实说
                showError("界面还没准备好，请退出后重新打开扫一扫");
                return;
            }
            if (!ensurePermission()) return;
            openCamera();
        });
        surface.getHolder().addCallback(this);

        // 扫码只认 QR：PC 地址栏分享面板那张就是 QR。
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS,
                Collections.singletonList(BarcodeFormat.QR_CODE));
        // 手机屏幕上的二维码、或光照不均/略模糊的打印码，默认单遍解码容易漏。
        // TRY_HARDER 让 ZXing 多试几轮阈值与方向，识别率明显更高。
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        reader.setHints(hints);

        decodeThread = new HandlerThread("scan-decode");
        decodeThread.start();
        decodeHandler = new Handler(decodeThread.getLooper());

        showStatus("正在启动相机…");
        /* 看门狗：正常情况下 surfaceCreated 几百毫秒内就到了。8 秒还没开成，
         * 说明卡在了我们看不见的地方（Surface 没建起来 / 相机被别处占着）。
         * 宁可给一句明确的话 + 重试，也别让用户对着「正在启动相机…」干等。 */
        new Handler(getMainLooper()).postDelayed(() -> {
            if (!isFinishing() && camera == null) {
                showError("相机没有启动，点「重试」再试一次");
            }
        }, 8000);
    }

    /* ------------------------------------------------------------------ *
     * Surface 生命周期
     * ------------------------------------------------------------------ */

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        surfaceReady = true;
        openCamera();
    }

    @Override
    public void surfaceChanged(SurfaceHolder h, int format, int w, int hh) {
        surfaceReady = true;
        // 尺寸变化（旋屏/分屏）后预览可能已断：相机在但没在预览，就重新挂一次
        if (camera != null && !previewing) startPreview();
        else if (camera == null) openCamera();
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder h) {
        surfaceReady = false;
        releaseCamera();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 只有 Surface 已就绪才补开。没有 Surface 时开相机＝必然 startPreview 失败。
        if (surfaceReady && camera == null) openCamera();
    }

    @Override
    protected void onPause() {
        super.onPause();
        releaseCamera();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        releaseCamera();
        if (decodeThread != null) decodeThread.quitSafely();
    }

    /* ------------------------------------------------------------------ *
     * 相机
     * ------------------------------------------------------------------ */

    /**
     * 打开相机并开始预览。
     *
     * <p>所有「什么时候可以开」的判断都收在这里，调用方只管喊一声 —— 这样
     * surfaceCreated / surfaceChanged / onResume / 重试按钮四条路不会各写一套守卫。
     */
    private void openCamera() {
        if (camera != null || !surfaceReady) return;
        if (!ensurePermission()) return;

        Camera c = null;
        int id = -1;
        Throwable err = null;
        // 先试后摄；某些平板/开发板没有后摄，退到「任意可用相机」。
        for (int candidate : candidateIds()) {
            try {
                c = Camera.open(candidate);
                id = candidate;
                break;
            } catch (Throwable e) {
                err = e;
                c = null;
            }
        }
        if (c == null) {
            showError(ScanMath.explainFailure(ScanMath.classifyOpenError(err)));
            return;
        }

        camera = c;
        cameraId = id;
        try {
            Camera.Parameters p = camera.getParameters();
            // 显式锁 NV21：Camera1 默认就是它，但个别机型会回 YV12，
            // 那会让下面的 rotateNV21 / PlanarYUVLuminanceSource 全盘读错。
            try {
                List<Integer> formats = p.getSupportedPreviewFormats();
                if (formats == null || formats.contains(ImageFormat.NV21)) {
                    p.setPreviewFormat(ImageFormat.NV21);
                }
            } catch (Throwable ignored) { }
            List<Camera.Size> sizes = p.getSupportedPreviewSizes(); // 只问一次，问两次拿的是同一个列表
            int[] best = ScanMath.choosePreviewSize(widthsOf(sizes), heightsOf(sizes), 1280, 720);
            if (best != null) p.setPreviewSize(best[0], best[1]);
            List<String> focusModes = p.getSupportedFocusModes();
            if (focusModes != null
                    && focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            }
            camera.setParameters(p);
            // 记下最终生效的帧尺寸：预览回调要用，避免每帧再去问一次 camera
            Camera.Size ps = p.getPreviewSize();
            previewW = ps != null ? ps.width : 0;
            previewH = ps != null ? ps.height : 0;
            camera.setDisplayOrientation(displayDegrees());
            startPreview();
        } catch (Throwable e) {
            releaseCamera();
            showError(ScanMath.explainFailure(ScanMath.classifyOpenError(e)));
        }
    }

    /** 挂 Surface 并开始预览。Surface 未就绪时什么都不做（等 surfaceChanged 再来）。 */
    private void startPreview() {
        if (camera == null || !surfaceReady) return;
        try {
            if (previewCb == null) previewCb = newPreviewCallback();
            camera.setPreviewDisplay(surface.getHolder());
            camera.setPreviewCallback(previewCb);
            camera.startPreview();
            previewing = true;
            hideStatus();
        } catch (Throwable e) {
            previewing = false;
            releaseCamera();
            showError(ScanMath.explainFailure(ScanMath.classifyOpenError(e)));
        }
    }

    private int displayDegrees() {
        try {
            Camera.CameraInfo info = new Camera.CameraInfo();
            Camera.getCameraInfo(cameraId, info);
            return ScanMath.displayOrientation(info.orientation, info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT, 0);
        } catch (Throwable e) {
            return 90; // 绝大多数后摄在竖屏下就是 90，取不到就按常见值
        }
    }

    /** 尝试顺序：后摄 → 其余任意一个。 */
    private static List<Integer> candidateIds() {
        List<Integer> ids = new ArrayList<>();
        int count = 0;
        try { count = Camera.getNumberOfCameras(); } catch (Throwable e) { count = 0; }
        int back = -1;
        for (int i = 0; i < count; i++) {
            try {
                Camera.CameraInfo info = new Camera.CameraInfo();
                Camera.getCameraInfo(i, info);
                if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) { back = i; break; }
            } catch (Throwable ignored) { }
        }
        if (back >= 0) ids.add(back);
        for (int i = 0; i < count; i++) if (i != back) ids.add(i);
        if (ids.isEmpty()) ids.add(0); // 连数量都取不到时死马当活马医
        return ids;
    }

    private static int[] widthsOf(List<Camera.Size> sizes) {
        if (sizes == null) return new int[0];
        int[] out = new int[sizes.size()];
        for (int i = 0; i < sizes.size(); i++) out[i] = sizes.get(i).width;
        return out;
    }

    private static int[] heightsOf(List<Camera.Size> sizes) {
        if (sizes == null) return new int[0];
        int[] out = new int[sizes.size()];
        for (int i = 0; i < sizes.size(); i++) out[i] = sizes.get(i).height;
        return out;
    }

    private void releaseCamera() {
        if (camera != null) {
            try {
                camera.setPreviewCallback(null);
                camera.stopPreview();
            } catch (Throwable ignored) { }
            try { camera.release(); } catch (Throwable ignored) { }
            camera = null;
        }
        previewing = false;
        cameraId = -1;
    }

    /* ------------------------------------------------------------------ *
     * 权限
     * ------------------------------------------------------------------ */

    /** 缺权限就申请并返回 false（调用方先别开相机）；已有权限返回 true。 */
    private boolean ensurePermission() {
        if (checkSelfPermission(android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            return true;
        }
        if (!permissionPending) {
            permissionPending = true;
            requestPermissions(new String[]{android.Manifest.permission.CAMERA}, REQ_CAMERA);
            showStatus("需要相机权限才能扫码");
        }
        return false;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_CAMERA) return;
        permissionPending = false;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            hideStatus();
            openCamera();
        } else {
            showError("没有相机权限，无法扫码");
        }
    }

    /* ------------------------------------------------------------------ *
     * 解码
     * ------------------------------------------------------------------ */

    /**
     * 建预览回调。
     *
     * <p>帧尺寸用 {@link #previewW}/{@link #previewH} 缓存，不再每帧 {@code getParameters()}：
     * 那个调用要跨进程取一整包参数，在预览回调里每帧都做既费电又容易把预览拖卡，
     * 个别机型还会直接抛 IllegalStateException。
     */
    private Camera.PreviewCallback newPreviewCallback() {
        return new Camera.PreviewCallback() {
            @Override
            public void onPreviewFrame(byte[] data, Camera cam) {
                if (data == null || decoding || !previewing) return;
                final int fw = previewW, fh = previewH;
                if (fw <= 0 || fh <= 0) return;
                // Camera 的回调 buffer 在 onPreviewFrame 返回后随时可能被复用/覆盖，
                // 而解码在另一个线程上跑 —— 必须先拷一份，否则解的是半新半旧的帧。
                final byte[] frame = data.clone();
                decoding = true;
                decodeHandler.post(() -> {
                    try {
                        // 竖屏下预览帧是横向的，先顺时针转 90° 成竖向再喂解码。
                        byte[] rotated = ScanMath.rotateNV21(frame, fw, fh, 90);
                        int w = fh, h = fw;
                        PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(
                                rotated, w, h, 0, 0, w, h, false);
                        BinaryBitmap bmp = new BinaryBitmap(new HybridBinarizer(src));
                        Result r = reader.decodeWithState(bmp);
                        decodeFailures = 0;
                        runOnUiThread(() -> deliver(r.getText()));
                    } catch (NotFoundException e) {
                        // 这一帧没扫到，属于正常路径，下一帧继续。
                        decodeFailures = 0;
                    } catch (Throwable e) {
                        /* 不能再静默吞掉：解码链路一旦坏了，用户只会看到「相机正常
                         * 却永远扫不出」，完全无从判断坏在哪一环（rotateNV21 越界
                         * 就是这样藏了一整个版本）。写日志 + 连续失败给一句可见提示。 */
                        Log.e(TAG, "解码帧失败", e);
                        if (++decodeFailures == 10) {
                            runOnUiThread(() ->
                                showError("识别组件出现异常，点「重试」再试一次"));
                        }
                    } finally {
                        decoding = false;
                    }
                });
            }
        };
    }

    private void deliver(String text) {
        if (text == null || delivered) return;
        delivered = true; // 解码线程可能连着送来两帧的结果，只认第一帧
        releaseCamera(); // 别再让后续帧喂进解码线程
        Intent i = new Intent();
        i.putExtra(EXTRA_SCAN, text);
        setResult(RESULT_OK, i);
        finish();
    }

    /* ------------------------------------------------------------------ *
     * 状态提示
     * ------------------------------------------------------------------ */

    private void showStatus(String msg) {
        if (status == null) return;
        status.setText(msg);
        status.setVisibility(View.VISIBLE);
        if (retry != null) retry.setVisibility(View.GONE);
    }

    private void showError(String msg) {
        if (status == null) {
            finish();
            return;
        }
        status.setText(msg);
        status.setVisibility(View.VISIBLE);
        // 有「重试」按钮，就别再把用户踢出去 —— 退出等于连重试的机会都没有
        if (retry != null) retry.setVisibility(View.VISIBLE);
    }

    private void hideStatus() {
        if (status != null) status.setVisibility(View.GONE);
        if (retry != null) retry.setVisibility(View.GONE);
    }
}
