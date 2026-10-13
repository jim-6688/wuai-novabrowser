package top.wuai.nova;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 移动版请求拦截：广告宿主 + 无图模式。
 *
 * <h3>被拦下的请求返回 1×1 透明 GIF（43 字节），不是「无响应」</h3>
 *
 * <p>这是一个刻意的选择。返回空响应会让 {@code <img>} 变成「加载失败」：
 * 页面布局可能塌（没算宽高的图片是 0×0），控制台还会刷一串错误。
 * 而这 43 字节的 GIF 是一个<b>合法的成功响应</b>，页面只会安静地显示成一张空图。
 *
 * <p>关键点是：{@code shouldInterceptRequest} 在<b>请求发出之前</b>被调用，
 * 返回它等于原请求根本没发生过 —�� 所以「省流量」是真的省，不是「下完再扔掉」。
 *
 * <p>注意这与桌面端的机制<b>完全不同</b>：桌面版是 {@code cancel} + 注入占位 CSS
 * （因为 Electron 的 session 层能干净地 abort），移动版靠的是一个真实的替代响应。
 * 殊途同归，但两条路的 bug 不会是同一个，不会互相掩盖。
 *
 * <h3>统计</h3>
 *
 * <p>用 {@link AtomicInteger} 而不是普通 int：{@code shouldInterceptRequest} 跑在
 * WebView 的 IO 线程上，而界面在主线程读这些计数。普通 int 的自增在两个线程之间
 * 不是原子的，统计会少算 —— 而「省了多少」是这个功能唯一的说服力指标，算错就等于没有。
 */
public final class RequestInterceptor {

    private volatile MediaRegistry registry;
    private final AtomicInteger blockedImages = new AtomicInteger();
    private final AtomicInteger blockedMedia = new AtomicInteger();
    private final AtomicInteger blockedHosts = new AtomicInteger();
    private final AtomicInteger blockedThirdParty = new AtomicInteger();

    /**
     * 1×1 透明 GIF，43 字节。
     *
     * <p>用 {@code java.util.Base64} 而不是 {@code android.util.Base64}：后者是框架类，
     * 在本地 JVM 单测里一调就抛 {@code Stub!}，于是这个常量所在的方法整条路径
     * 都没法离线验证了 —— 为了 43 个字节放弃可测性不划算。
     */
    private static final byte[] PIXEL_GIF = java.util.Base64.getDecoder().decode(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");

    private volatile NoImagePolicy policy;

    /**
     * 广告拦截总开关。
     *
     * <p>{@code volatile} 同一个理由：读在 IO 线程，写在主线程（用户开关时）。
     * 不加 volatile 的话，开了之后可能要等这个 IO 线程下次被调度才看见 ——
     * 表现就是「我明明开了，怎么还在拦」。
     */
    private volatile boolean adblockEnabled;

    /**
     * 第三方请求拦截（严格隐私模式）总开关。
     *
     * <p>开着时，凡是「与当前主文档不同源」的子资源请求一律拦下 ——
     * 脚本、跟踪像素、第三方字体、跨域图片，一个都不放。这是比广告名单
     * 更激进的一层：广告名单只拦已知坏域名，这层拦的是「一切非同源」。
     *
     * <p>移动端 {@code shouldInterceptRequest} 拿不到资源类型，所以无法精确到
     * 「只拦脚本」—— 这是平台的硬限制，这里做成「第三方即拦」，语义是
     * 隐私优先：默认不共享你的浏览行为给任何第三方。
     */
    private volatile boolean thirdPartyBlockEnabled;

    /** 当前主文档的 host。由 {@link #onMainFrame(String)} 更新，读在 IO 线程。 */
    private volatile String currentPageHost = "";

    public RequestInterceptor(MediaRegistry registry, NoImagePolicy policy) {
        this.registry = registry;
        this.policy = policy;
        this.adblockEnabled = true;
    }

    /** 无图档位变了就换判定器。{@code volatile} 是因为读在 IO 线程、写可能在主线程。 */
    public void setPolicy(NoImagePolicy policy) {
        this.policy = policy;
    }

    /**
     * 换名单。订阅更新成功后调它。
     *
     * <p>{@code volatile} 与 {@link #setPolicy} 同理。更关键的是<b>只能整份换</b>：
     * {@code MediaRegistry} 的集合是 {@code unmodifiable}，没法增量加 ——
     * 这是刻意的（见那个类的注释：宁可少一点也不要出现第二份真相）。
     */
    public void setRegistry(MediaRegistry registry) {
        this.registry = registry;
    }

    public MediaRegistry registry() {
        return registry;
    }

    public void setAdblockEnabled(boolean on) {
        this.adblockEnabled = on;
    }

    public boolean adblockEnabled() {
        return adblockEnabled;
    }

    public void setThirdPartyBlockEnabled(boolean on) {
        this.thirdPartyBlockEnabled = on;
    }

    public boolean thirdPartyBlockEnabled() {
        return thirdPartyBlockEnabled;
    }

    /** 主文档开始加载时更新当前页面 host，供第三方判定做同源比对。 */
    public void onMainFrame(String url) {
        if (url == null) return;
        try {
            Uri u = Uri.parse(url);
            String host = u.getHost();
            currentPageHost = host == null ? "" : host;
        } catch (Exception e) {
            currentPageHost = "";
        }
    }

    public int blockedImages() { return blockedImages.get(); }
    public int blockedMedia() { return blockedMedia.get(); }
    public int blockedHosts() { return blockedHosts.get(); }
    public int blockedThirdParty() { return blockedThirdParty.get(); }
    public int blockedTotal() {
        return blockedImages.get() + blockedMedia.get() + blockedHosts.get()
            + blockedThirdParty.get();
    }

    public void resetCounters() {
        blockedImages.set(0);
        blockedMedia.set(0);
        blockedHosts.set(0);
        blockedThirdParty.set(0);
    }

    /**
     * 宿主黑名单匹配。
     *
     * <p>整站拦（含主文档），所以它排在无图判定<b>之前</b>：
     * 一个整站都是广告的域名，没什么好「按后缀挑着拦」的。
     */
    public boolean isBlockedHost(String url) {
        if (url == null) return false;
        try {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme();
            if (scheme == null) return false;
            String s = scheme.toLowerCase(java.util.Locale.ROOT);
            if (!"http".equals(s) && !"https".equals(s)) return false;
            String host = u.getHost();
            return host != null && registry.isBlockedHost(host);
        } catch (Exception e) {
            // URL 解析不了就当没这条规则，绝不在这里抛 —— 抛了整页都打不开
            return false;
        }
    }

    /**
     * 无图判定。
     *
     * <p>取不到 query 里的路径细节，所以只按 path 的后缀判 ——
     * 具体限制见 {@link NoImagePolicy} 的类注释，那里有必须对用户讲明的两条后果。
     */
    public NoImagePolicy.Decision judgeImage(String url, boolean isMainFrame) {
        if (url == null) return NoImagePolicy.Decision.allow("空 URL");
        try {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme();
            String path = u.getPath();
            return policy.judge(scheme == null ? "" : scheme, path, isMainFrame);
        } catch (Exception e) {
            return NoImagePolicy.Decision.allow("解析失败");
        }
    }

    /**
     * 真正的入口。返回 null 表示放行，让 WebView 自己去发请求。
     */
    public WebResourceResponse intercept(WebView view, WebResourceRequest req) {
        String url = req.getUrl() == null ? null : req.getUrl().toString();
        if (url == null) return null;
        boolean main = req.isForMainFrame();

        if (adblockEnabled && registry.adblockHosts().size() > 0 && isBlockedHost(url)) {
            blockedHosts.incrementAndGet();
            // 整站拦时连主文档一起拦：既然判定它整站都是广告，返回一个说明页
            // 比留一片空白好，用户至少知道自己被拦了。
            return main ? blockedNotice(url) : pixel();
        }

        // 第三方拦截：非主框架、且与当前页面不同源 → 拦下。
        if (thirdPartyBlockEnabled && !main && isThirdParty(url)) {
            blockedThirdParty.incrementAndGet();
            return pixel();
        }

        NoImagePolicy.Decision d = judgeImage(url, main);
        if (d.block) {
            if ("media".equals(d.kind)) blockedMedia.incrementAndGet();
            else blockedImages.incrementAndGet();
            return pixel();
        }
        return null;
    }

    /**
     * 判断一个请求是否「第三方」：host 与当前主文档 host 不同源。
     *
     * <p>同源判定只看 host（不含子域降级、不含端口）：第三方脚本几乎都挂在
     * 完全不同的域名下（cdn、广告联盟、统计服务），按 host 严格比对足够。
     * currentPageHost 为空（尚未记录主文档）时不拦，避免误伤首屏资源。
     */
    private boolean isThirdParty(String url) {
        if (currentPageHost == null || currentPageHost.isEmpty()) return false;
        try {
            Uri u = Uri.parse(url);
            String scheme = u.getScheme();
            if (scheme == null) return false;
            String s = scheme.toLowerCase(java.util.Locale.ROOT);
            if (!"http".equals(s) && !"https".equals(s)) return false;
            String host = u.getHost();
            return host != null && !host.equalsIgnoreCase(currentPageHost);
        } catch (Exception e) {
            return false;
        }
    }

    /** 1×1 透明 GIF 的响应。 */
    public static WebResourceResponse pixel() {
        WebResourceResponse r = new WebResourceResponse("image/gif", "gif",
            new ByteArrayInputStream(PIXEL_GIF));
        // 不给 CORS 头：给了反而会让某些站点开始发跨域探测请求，那是我们要拦的东西
        return r;
    }

    /**
     * 主文档被整站拦截时的说明页。
     *
     * <p>刻意做成一张纯 HTML 图（而不是加载本地 assets 的 file:// 页）：
     * file:// 页面在 targetSdk 30+ 会受 {@code file://} 的跨源限制，
     * 嵌在 WebView 里样式和行为都可能不对。data: 没有这个限制。
     */
    private static WebResourceResponse blockedNotice(String url) {
        String host = Tab.hostOf(url);
        String html = "<!doctype html><html><head><meta charset=\"utf-8\">"
            + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            + "<style>body{margin:0;display:flex;height:100vh;align-items:center;"
            + "justify-content:center;background:#F6F7FB;font:15px/1.7 system-ui;color:#4A5062}"
            + ".c{max-width:300px;padding:24px;text-align:center}"
            + "b{display:block;font-size:20px;color:#14161C;margin-bottom:8px}"
            + "code{display:block;margin-top:12px;font-size:12px;color:#9AA0B0;"
            + "word-break:break-all}</style></head><body><div class=\"c\">"
            + "<b>已拦截</b>此站点在广告名单中，页面没有被加载。"
            + "<code>" + escapeHtml(host) + "</code>"
            + "<p style=\"font-size:12px;color:#9AA0B0\">可在「菜单 → 广告拦截」里关掉拦截</p>"
            + "</div></body></html>";
        byte[] data = html.getBytes(StandardCharsets.UTF_8);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        // 6 参构造的参数顺序是 (mime, encoding, statusCode, reason, headers, data)：
        // data 在最后一位，不是紧跟 encoding。记成后者编译不过，
        // 编译器给的报错还特别费解（会说「ByteArrayInputStream 无法转换为 int」）。
        // 用 403 是因为「这是被拦了」和「服务器崩了」对页面脚本是两件事，
        // 403 能让脚本走自己的错误分支。
        return new WebResourceResponse("text/html", "utf-8", 403, "Blocked",
            headers, new ByteArrayInputStream(data));
    }

    private static String escapeHtml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    /** 给界面用的一句话，讲清当前到底拦了什么。 */
    public String describe() {
        int i = blockedImages.get();
        int m = blockedMedia.get();
        int h = blockedHosts.get();
        int tp = blockedThirdParty.get();
        if (i + m + h + tp == 0) return "尚未拦截任何请求";
        StringBuilder sb = new StringBuilder();
        if (i > 0) sb.append("省下 ").append(i).append(" 张图");
        if (m > 0) {
            if (sb.length() > 0) sb.append("、");
            sb.append(m).append(" 个视频/音频");
        }
        if (h > 0) {
            if (sb.length() > 0) sb.append("、");
            sb.append(h).append(" 次广告请求");
        }
        if (tp > 0) {
            if (sb.length() > 0) sb.append("、");
            sb.append(tp).append(" 次第三方请求");
        }
        return sb.toString();
    }
}