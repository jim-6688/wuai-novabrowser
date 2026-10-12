package top.wuai.nova;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * 吾爱Nova浏览器 · 移动版内核目录。
 *
 * <p>桌面端能真的切三套内核（Chromium / Gecko / 打补丁的 Trident 宿主）。
 * <b>Android 上做不到这件事</b>，所以这个类的核心任务不是「提供三档」，
 * 而是「把哪一档是真的、哪一档是假的、哪一档根本没带，说清楚」。
 *
 * <p>这是整个产品的底线约定：绝不把兼容层画成真内核，也绝不静默降级。
 * 桌面端有同样的约束（见 shell.js 的降级提示条），移动版照搬。
 */
public final class EngineCatalog {

    /** 一档内核的「真身」是什么。 */
    public enum Nature {
        /** 真内核：由真实浏览器引擎驱动渲染 */
        REAL_KERNEL,
        /**
         * 兼容层：跑的是同一个真内核，只是换了 UA、关掉一些现代特性。
         * 它能骗过检测旧浏览器的站点，但它<b>不是</b>另一个内核，也修不好真正的兼容问题。
         */
        COMPAT_LAYER,
        /** 没带：这个引擎是真实存在的另一套引擎，但本包没有内置它 */
        NOT_BUNDLED
    }

    public static final class Engine {
        public final String id;
        public final String label;
        public final String shortName;
        public final Nature nature;
        /** 标识色，取自 values/colors.xml —— 与 shell.css 的 engine 系列同源 */
        public final int colorRes;
        public final String note;
        public final boolean bundled;
        /** 只为兼容层准备：切换内核时改写 UA */
        public final String userAgent;

        Engine(String id, String label, String shortName, Nature nature, int colorRes,
               String note, boolean bundled, String userAgent) {
            this.id = id;
            this.label = label;
            this.shortName = shortName;
            this.nature = nature;
            this.colorRes = colorRes;
            this.note = note;
            this.bundled = bundled;
            this.userAgent = userAgent;
        }

        /** 能不能真的切过去用。没带的内核选了也白选，所以这个判断收在一处。 */
        public boolean selectable() { return bundled; }

        /**
         * 它到底算不算「内核」。界面上但凡要显示「当前内核」，
         * 都得先过这一关，避免把兼容层写成真内核。
         */
        public boolean isRealKernel() { return nature == Nature.REAL_KERNEL; }
    }

    /** 兼容层的 UA：伪装成一台还在用老版 Trident 的机器。这只是**字符串**。 */
    private static final String COMPAT_UA =
        "Mozilla/5.0 (Windows NT 6.1; Trident/7.0; rv:11.0) like Gecko";

    public static final List<Engine> ALL = Collections.unmodifiableList(Arrays.asList(
        new Engine("chromium", "系统 WebView", "WebView", Nature.REAL_KERNEL,
            R.color.engine_chromium,
            "设备自带的 Android WebView，本身就是 Chromium 内核。"
                + "Android 上唯一一个不需要额外打包就能拿到的真内核。",
            true, null),
        new Engine("gecko", "GeckoView", "Gecko", Nature.NOT_BUNDLED,
            R.color.engine_gecko,
            "本包没有内置 GeckoView。它是货真价实的第二套内核，但会给安装包平添几十兆，"
                + "且需要换掉整套 WebView 宿主。选中它只会得到一句提示，不会偷偷切回系统内核。",
            false, null),
        new Engine("trident", "兼容层", "兼容", Nature.COMPAT_LAYER,
            R.color.engine_trident,
            "兼容层不是内核：跑的还是系统 WebView，只是换了个老 IE 的 UA。"
                + "能让「请升级浏览器」的站点放行，但渲染结果仍由 Chromium 决定 —— "
                + "真遇上只认 Trident 的页面，它救不了。",
            true, COMPAT_UA)
    ));

    private EngineCatalog() {}

    public static Engine byId(String id) {
        for (Engine e : ALL) {
            if (e.id.equals(id)) return e;
        }
        return ALL.get(0);
    }

    /** 一次内核选择的结果。 */
    public static final class Outcome {
        /** 用户点的那个 */
        public final Engine requested;
        /** 实际生效的那个 */
        public final Engine active;
        /** 是否发生了降级 */
        public final boolean degraded;
        /** 降级原因，直接显示给用户看 */
        public final String reason;

        Outcome(Engine requested, Engine active, boolean degraded, String reason) {
            this.requested = requested;
            this.active = active;
            this.degraded = degraded;
            this.reason = reason;
        }
    }

    /**
     * 按用户选择解析出真正能用的内核。
     *
     * <p>注意这里<b>不抛异常也不静默通过</b>：请求了没带的内核时，返回的是
     * 「降级到系统 WebView + 原因」，界面必须把原因显示出来。
     */
    public static Outcome resolve(String requestedId) {
        Engine want = byId(requestedId);
        if (want.selectable()) return new Outcome(want, want, false, "");
        Engine fallback = byId("chromium");
        return new Outcome(want, fallback, true,
            want.label + " 未内置在本安装包里，已回退到" + fallback.label);
    }
}
