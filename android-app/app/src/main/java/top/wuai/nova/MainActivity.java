package top.wuai.nova;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.Locale;

/**
 * 吾爱Nova浏览器 · 移动版主界面。
 *
 * <h3>这一类为什么这么大</h3>
 *
 * 它确实大。但把接线拆出去只会更糟：拦截、拼页、标签、底栏四件事互相咬着
 * —— 切标签要停拼页、换档位要换判定器、换内核要重载页面。拆成四个文件只是把
 * 「谁在什么时候改了什么状态」摊开，那才是真的难读。
 *
 * <p>真正该抽出去的是<b>能独立判断对错的部分</b>，而那些都已经抽了：
 * 无图判定（{@link NoImagePolicy}）、内核解析（{@link EngineCatalog}）、
 * 拼页状态解析（{@link AutoPage}）、配置序列化（{@link NovaSettings}）。
 * 剩下的确实只是胶水，而胶水就该写在一个地方。
 */
public final class MainActivity extends Activity {

    // ------------------------------------------------------------ 状态

    private final List<Tab> tabs = new ArrayList<>();
    private int active = 0;

    private NovaStore store;
    private NovaSettings settings;
    private MediaRegistry registry;
    private RequestInterceptor interceptor;
    private EngineCatalog.Outcome engine;

    /** 下载执行器。故意**不**在 onCreate 里建：它要起线程池，
     *  而进程可能只是被文档查看器拉起来看一眼，用户不会用到下载。 */
    private Downloader downloader;
    /** 拦截规则订阅更新器。同上，懒建。 */
    private RuleUpdater ruleUpdater;
    /** 应用内自动更新。同样懒建 —— 大多数会话里用户根本不会去点它。 */
    private UpdateManager updateManager;

    /** 已装用户脚本。装/删/启停后要重设一遍，否则改动不生效。 */
    private List<UserScript.Installed> scripts = new ArrayList<>();
    /** 当前打开的是哪个 sheet。弹层之间互相调用时要用它决定要不要先装主界面。 */
    private View openSheetView;
    /**
     * 当前 sheet 用的是哪个布局资源。
     *
     * <p>不要靠 {@code view.getId()} 反推「现在开的是哪个面板」—— 布局的根节点常常
     * 没有 {@code android:id}（sheet_rules.xml 就是），getId() 返回
     * {@code View.NO_ID}(-1)，判断恒为 false，于是「更新完重开面板」静默失效。
     * 显式记一份 layoutRes，判断才是可靠的。
     */
    private int openSheetLayout;
    /** 当前 sheet 是不是下载列表（它有自己的刷新回调）。 */
    private boolean downloadSheetOpen;
    /**
     * 切标签带来的加载，要在页面 finish 后把滚动位置还原回去。
     *
     * <p>普通导航（点链接、刷新）<b>不</b>还原：那时 {@link Tab#scrollY} 记的还是
     * 上一个页面的位置，照着滚会把用户扔到莫名其妙的地方。
     */
    private boolean restoreScrollOnFinish;

    /** 自动拼页脚本全文。缓存住，避免每次翻页都读一次 assets。 */
    private String autoPageScript = "";
    /** 脚本读失败的原因，要在界面上显示，不能只记日志。 */
    private String autoPageError = "";

    private final Handler main = new Handler(Looper.getMainLooper());
    /** 状态轮询。只在拼页开着时挂，停了就没必要再问页面要状态。 */
    private Runnable poll;

    /** 上一次 {@code setContentView(activity_main)} 装的是不是当前显示的这一套。 */
    private boolean mainViewMounted;

    /** WebView 的 client 只绑一次 —— 它是同一个实例，重复绑定会让回调跑多遍。 */
    private boolean webClientBound;

    // ------------------------------------------------------------ 视图

    private WebView web;
    private EditText urlBar;
    private ProgressBar progress;
    private TextView statusStrip;
    private TextView noImageChip;
    private TextView engineLabel;
    private View engineDot;
    private View engineChip;

    // ------------------------------------------------------------ 生命周期

    /**
     * 主题设置在这里生效。
     *
     * <p>为什么在 attachBaseContext 而不是 onCreate：{@code values-night} 的解析
     * 发生在资源第一次被拿到的时候，onCreate 里再改就晚了 —— 界面已经按旧主题
     * inflate 完。{@code createConfigurationContext} 造一个改了 uiMode 的上下文
     * 挂上去，这个 Activity 拿到的所有资源就都按目标主题解析。
     *
     * <p>只处理「强制浅色 / 强制深色」：跟随系统的那一档系统自己会给我们正确的
     * uiMode，不用插手。而那次 SharedPreferences 只读一个字符串，比加载整个
     * NovaSettings 便宜，也不会因为字段增多而变慢。
     */
    @Override
    protected void attachBaseContext(Context newBase) {
        super.attachBaseContext(applyThemeOverride(newBase));
    }

    private static Context applyThemeOverride(Context base) {
        SharedPreferences p = base.getSharedPreferences(NovaStore.PREFS, Context.MODE_PRIVATE);
        String theme = p.getString(NovaSettings.KEY + NovaSettings.K_THEME, "system");
        if ("system".equals(theme)) return base;
        boolean systemNight = (base.getResources().getConfiguration().uiMode
            & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        boolean night = nightOn(theme, systemNight);
        int want = night ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO;
        Configuration cfg = new Configuration(base.getResources().getConfiguration());
        if ((cfg.uiMode & Configuration.UI_MODE_NIGHT_MASK) == want) return base;
        cfg.uiMode = (cfg.uiMode & ~Configuration.UI_MODE_NIGHT_MASK) | want;
        return base.createConfigurationContext(cfg);
    }

    /**
     * 主题三档 → 最终是否夜间。抽成静态纯函数是为了单测：
     * 「跟随系统」时以系统为准，另外两档强制，这三种分支各测一遍就够了。
     */
    static boolean nightOn(String theme, boolean systemNight) {
        if ("light".equals(theme)) return false;
        if ("dark".equals(theme)) return true;
        return systemNight;
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        store = new NovaStore(this);
        settings = store.load();
        reloadRegistry();
        // 内核不再可选，这里只读出「当前跑的是什么」用于显示。
        engine = EngineCatalog.resolve(settings.defaultEngine);

        interceptor = new RequestInterceptor(registry,
            new NoImagePolicy(settings.noImageLevel(), registry.mediaExts()));
        interceptor.setAdblockEnabled(settings.adblockEnabled);

        scripts = store.loadScripts();

        try {
            autoPageScript = store.readAssetText(AutoPage.ASSET);
        } catch (Exception e) {
            autoPageError = AutoPage.ASSET + " 读取失败，自动拼页不可用";
        }

        mountMain();
        handleShare(getIntent());
        // 放在 mountMain 之后：更新完成要 reloadRegistry()，那会碰 interceptor，
        // 而它在这里才刚刚建好。
        maybeAutoUpdateRules();
        // 静默查一次有没有新版：查不到就当没有，绝不为后台动作弹窗。
        maybeAutoCheckUpdate();
    }

    /** 自动更新订阅的间隔。订阅名单一般周更，3 天既能跟上又不会每次冷启动都打网络。 */
    private static final long RULES_AUTO_INTERVAL_MS = 3L * 24 * 3600 * 1000;

    /**
     * 订阅自动更新。只在设置里开了、且订阅超过 {@link #RULES_AUTO_INTERVAL_MS}
     * 没更新时才动手，并且全程<b>静默</b>。
     *
     * <p>静默是有意的：用户没有点「更新」，成功不必庆功；失败更不该弹窗 ——
     * 为一个后台动作弹「更新失败」是骚扰，而规则更新失败的正确表现就是
     * 「保留原有规则，下次再说」。想看到结果可以去规则面板看「更新于」。
     *
     * <p>没订阅过（rulesUrl 为空）直接返回：没有源就无从更新，
     * 而内置名单随包发布，不需要联网。
     */
    private void maybeAutoUpdateRules() {
        if (!settings.rulesAutoUpdate) return;
        String url = store.rulesUrl();
        if (url.isEmpty()) return;
        if (!rulesStale(store.rulesUpdatedAt(), System.currentTimeMillis())) return;
        if (ruleUpdater == null) ruleUpdater = new RuleUpdater(store);
        ruleUpdater.update(url, store.rulesSourceLabel(), result -> {
            if (result != null && result.ok) reloadRegistry();
        });
    }

    /**
     * 订阅是否旧到该自动更新的程度。抽成静态纯函数是为了能单测 ——
     * 「3 天」这条边界差一毫秒都不该更新，而这类边界在真机上要等三天才能看到。
     *
     * <p>{@code updatedAt <= 0}（从未订阅过）一律算旧：没有旧规则要保护，
     * 早一点拉到第一份比多等一个周期好。
     */
    static boolean rulesStale(long updatedAt, long now) {
        if (updatedAt <= 0) return true;
        return now - updatedAt >= RULES_AUTO_INTERVAL_MS;
    }

    // ------------------------------------------------------------ 应用更新

    /** 启动时静默查一次。 */
    private void maybeAutoCheckUpdate() {
        checkUpdate(false);
    }

    /**
     * 检查更新。
     *
     * <p>清单一律从官网 {@link UpdateManager#UPDATE_URL} 取，因为那是 App 与官网
 * 共用的唯一版本来源 —— 在 App 里再抄一份版本号，迟早会对不上。
     *
     * <p>{@code interactive} 决定「没查到 / 已是最新」要不要出声：
     * 启动时自动查的那次必须完全静默，用户主动点的才反馈。
     */
    private void checkUpdate(final boolean interactive) {
        if (updateManager == null) updateManager = new UpdateManager(this);
        updateManager.check(BuildConfig.VERSION_CODE, m -> {
            if (m == null) {
                if (interactive) toast("没有查到更新信息，请检查网络后重试");
                return;
            }
            if (!m.newerThan(BuildConfig.VERSION_CODE)) {
                if (interactive) toast("已是最新版本 " + m.version);
                return;
            }
            showUpdateSheet(m);
        });
    }

    /** 新版提示。清单给了两个地址时，第二个作为备用写在正文里。 */
    private void showUpdateSheet(final UpdateManager.Manifest m) {
        boolean must = m.mustUpdate(BuildConfig.VERSION_CODE);
        UpdateManager.Link pick = m.primary();
        if (pick == null) {
            new NovaAlert(this, "发现新版本", describeUpdate(m))
                .positive("知道了", null).show();
            return;
        }
        StringBuilder sb = new StringBuilder(describeUpdate(m));
        if (m.downloads.size() > 1) {
            sb.append("\n\n备用地址（官网下不动时用）：")
                .append(m.downloads.get(1).url);
        }
        new NovaAlert(this, must ? "需要更新" : "发现新版本", sb.toString())
            .positive("下载 " + m.version, () -> downloadUpdate(m))
            .negative(must ? "退出" : "以后再说",
                must ? this::finishAffinity : null)
            .show();
    }

    private static String describeUpdate(UpdateManager.Manifest m) {
        StringBuilder sb = new StringBuilder();
        sb.append("新版本 ").append(m.version);
        if (!m.updatedAt.isEmpty()) sb.append(" · ").append(m.updatedAt);
        if (m.changelog.isEmpty()) {
            sb.append("\n\n本次没有更新说明。");
        } else {
            for (String line : m.changelog) sb.append("\n\n· ").append(line);
        }
        return sb.toString();
    }

    private void downloadUpdate(UpdateManager.Manifest m) {
        if (updateManager == null) updateManager = new UpdateManager(this);
        long id = updateManager.download(m);
        if (id < 0) {
            toast("无法开始下载，检查一下存储空间或网络");
        } else {
            toast("开始下载，完成后点通知里的文件即可安装");
    }
    }

    /**
     * 重读拦截名单。
     *
     * <p>订阅更新成功后必须调它 —— {@code MediaRegistry} 是不可变的，
     * 所以「让拦截器看到新规则」的唯一办法就是造一个新的塞进去。
     * 顺手把判定器也换掉，因为媒体后缀表虽然不变，但换一次保证两边是同一份。
     */
    private void reloadRegistry() {
        registry = store.loadMediaRegistry();
        if (interceptor != null) {
            interceptor.setRegistry(registry);
            interceptor.setPolicy(new NoImagePolicy(settings.noImageLevel(),
                registry.mediaExts()));
        }
    }

    /**
     * 装上主界面。
     *
     * <p>每次都重新 {@code setContentView}：弹层是用 {@code setContentView} 叠上去的，
     * 所以「从弹层回来」的正确做法就是把主界面<b>重新装一遍</b>。
     * 单纯 removeView 会把 WebView 一起带走，它还挂在 window 上就再也回不来了。
     *
     * <p>但 WebView <b>不能</b>跟着重新 inflate —— 那会每开一次弹层就丢一次页面，
     * 而且丢的是用户正在读的东西。所以它单独持有，重新 inflate 之后
     * <b>把原来的实例搬回容器</b>：既保住了 WebView，又保住了它的全部状态
     * （滚动位置、表单内容、正在播放的音频）。这比 saveState/restoreState 可靠 ——
     * 后者对第三方 Cookie、JS 状态、媒体播放都保不住。
     */
    private void mountMain() {
        // 回到主界面 = 没有任何 sheet 开着。这几个字段必须一起清掉 ——
        // 漏了的话 openSheetView 会永远指向上一个弹层，于是 onResume 里
        // 「只在没开弹层时才重载脚本」的判断从此再也不成立。
        openSheetView = null;
        openSheetLayout = 0;
        downloadSheetOpen = false;

        // 先把现有的 WebView 从旧容器里摘出来，inflate 之后再放回去
        WebView keep = web;
        if (keep != null && keep.getParent() instanceof ViewGroup) {
            ((ViewGroup) keep.getParent()).removeView(keep);
        }

        setContentView(R.layout.activity_main);

        // 布局里只有一个空容器 webHost，WebView 由这里注入：
        // 第一次新建，之后每次把同一个实例搬进新容器、压在最底层
        // （进度条与状态条要盖在它上面）。
        //
        // 关键是它<b>不写在布局里</b>：写在布局里的话，setContentView 每次执行
        // （也就是每次从弹层返回）都会 inflate 出一个新的 WebView，而那个新实例
        // 随即被丢弃且从不 destroy() —— WebView 持有的是 native 内存，
        // 反复开关弹层攒几十个就能把进程拖崩。
        FrameLayout host = findViewById(R.id.webHost);
        if (keep == null) {
            keep = new WebView(this);
        }
        host.addView(keep, 0, new FrameLayout.LayoutParams(-1, -1));
        web = keep;

        urlBar = findViewById(R.id.urlBar);
        progress = findViewById(R.id.progress);
        statusStrip = findViewById(R.id.statusStrip);
        noImageChip = findViewById(R.id.noImageChip);
        engineLabel = findViewById(R.id.engineLabel);
        engineDot = findViewById(R.id.engineDot);
        engineChip = findViewById(R.id.engineChip);

        // 重新 inflate 出来的进度条是全新的：XML 没写 visibility，默认 visible、progress=0。
        // 而复用的 WebView 此刻早已加载完（空闲）—— 不把进度条复位的话，
        // 它会以「可见但 0 进度」的状态挂在那儿，刷新按钮也会被它带偏（见 setupOmnibox）。
        // 真正的加载进度由 onProgressChanged 接管，这里只需把陈旧状态清掉。
        progress.setProgress(100);
        progress.setVisibility(View.GONE);

        setupWebView();
        setupBottomBar();
        setupHomeButton();
        setupStarButton();
        setupAiButton();
        setupOmnibox();
        applyEngine();
        syncChrome();
        syncNoImageChip();

        applySurfaceTheme();
        mainViewMounted = true;
    }

    /**
     * 无图提示条的可见性。
     *
     * <p>「加载图片」关掉时也要亮：用户看到的结果一样是「图上没出来」，
     * 只认无图模式会让关了加载图片的人以为提示条坏了。
     */
    private void syncNoImageChip() {
        if (noImageChip == null) return;
        boolean noImg = !settings.loadImages || settings.noImageLevel().active();
        noImageChip.setVisibility(noImg ? View.VISIBLE : View.GONE);
    }

    // ------------------------------------------------------------ WebView

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // 这两条合起来对应桌面端的「按视口自适应」：关掉的话，
        // 站点自己的响应式布局在手机屏上会永远按 980px 排版，然后被整体缩小。
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        // 图片开关。两条都要设：只关 setLoadsImagesAutomatically，部分 WebView
        // 版本上网络图片照样会被拉回来；只设 setBlockNetworkImage 又拦不住
        // data: 和内联的图。两条一起才是真的「不显示图片」。
        applyImageLoading();

        // UA 切换：兼容层就是靠这一行实现的（换成一个老 IE 的 UA）。
        // 必须在 loadUrl 之前设置，否则第一次页面协商已经带着旧 UA 发出去了。
        applyUserAgent();

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        // setupWebView 每次重新装主界面都会被调一遍，而 WebView 是同一个实例。
        // 重复 setWebViewClient 会堆起一串 client，于是每个回调都跑 N 次 ——
        // 表现是进度条乱跳、状态条被覆盖、注入被执行多次。
        // 所以这里只在第一次真正装。
        if (webClientBound) return;
        webClientBound = true;

        web.setWebViewClient(new WebViewClient() {

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view,
                                                              WebResourceRequest req) {
                return interceptor.intercept(view, req);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                if (req.getUrl() == null) return false;
                String scheme = req.getUrl().getScheme();
                if (scheme == null) return false;
                String lower = scheme.toLowerCase(java.util.Locale.ROOT);
                if ("http".equals(lower) || "https".equals(lower)) return false;

                // 非 http(s) 的（tel: / mailto: / intent: / weixin:）交回系统。
                // 自己吞掉只会得到一个打不开的空白页。
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, req.getUrl()));
                } catch (Exception ignored) {
                    // 没有应用能处理它。那就什么都不做 ——
                    // 弹一个「出错了」对用户毫无帮助，他也不知道该怎么办。
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progress.setVisibility(View.VISIBLE);
                progress.setProgress(0);
                // 只更新地址栏，不动 tab.url —— 后者是「这个标签本来要去哪」，
                // 被页面内的跳转改写，会让会话恢复直接跳进广告落地页。
                syncUrlBar(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
                Tab t = current();
                if (t != null) {
                    t.url = url;
                    saveSessionNow();
                    // 历史也在这里记：onPageFinished 是「这个页面确实打开了」的
                    // 可靠信号，标题也已经有了。放在 shouldOverrideUrlLoading 里
                    // 会记下一堆被拦截、被重定向掉的中间地址。
                    if (!settings.incognito) {
                        store.recordHistory(url, t.title);
                    }
                    if (restoreScrollOnFinish) {
                        restoreScrollOnFinish = false;
                        final int y = t.scrollY;
                        if (y > 0) {
                            // 延一帧再滚：页面刚 finish 时布局常常还没定型，
                            // 此刻 scrollTo 会被紧随其后的 layout 冲掉。
                            view.post(() -> view.scrollTo(0, y));
                        }
                    }
                }
                injectPlugins(url);
                maybeInjectAutoPage();
                updateStarState();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req,
                                         WebResourceError err) {
                // 只报主文档的错误。无图模式下子资源失败是常态（那正是我们干的），
                // 全报出来会刷成一堆红，把真正的错误埋掉。
                if (req != null && req.isForMainFrame()) {
                    progress.setVisibility(View.GONE);
                    showStatus("页面加载失败：" + describeError(err));
                }
            }
        });

        /**
         * 下载回调挂在 DownloadListener 上，**不是** WebViewClient。
         *
         * <p>这一点很容易搞错：{@code onDownloadStart} 不在 WebViewClient 里
         * （那是 Desktop 时代的老 API），所以加 @Override 会编译失败 ——
         * 那条报错「方法不会覆盖或实现超类型的方法」就是在说这件事。
         *
         * <p>也不能无条件下载：WebView 在遇到它处理不了的响应时也会走这里，
         * 无条件接的话用户点任何链接都可能弹出一个下载。所以先过一遍判定器。
         */
        web.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            if (url == null) return;
            DownloadTrigger trig = new DownloadTrigger(registry.mediaExts(), true);
            DownloadTrigger.Verdict v = trig.judge(contentDisposition, url, false);
            if (!v.trigger) return;
            // 服务器明说是附件时，Content-Disposition 里往往带着真实文件名
            // （`filename="report.zip"` 或 RFC 5987 的 `filename*=UTF-8''...`）。
            // 只从 URL 末段取名会拿到 `download.php` 这种没信息量的名字，
            // 所以这里先把头部里的名字解出来传给下载器；取不到再回落到 URL。
            final String name = filenameFromDisposition(contentDisposition);
            main.post(() -> {
                // 「自动下载」开关在这里生效：开着就直接下，
                // 关着则先问一句（见 NovaSettings.autoDownload 的注释）。
                if (settings.autoDownload) {
                    enqueueDownload(url, name);
                } else {
                    confirmDownload(url, name, contentLength);
                }
            });
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public void onReceivedTitle(WebView view, String title) {
                if (TextUtils.isEmpty(title)) return;
                Tab t = current();
                if (t != null) {
                    t.title = title;
                    // 标题一拿到就存。用户随时可能切走或杀进程，
                    // 那时不该再指望 onPageFinished 一定跑过。
                    saveSessionNow();
                }
                engineLabel.setContentDescription(title);
            }
        });
    }

    /**
     * 把「加载图片」开关写进 WebView。
     *
     * <p>刻意<b>不</b>在这里 reload：setupWebView 每次重装主界面都会跑一遍
     * （也就是每次从弹层回来），带上 reload 会变成「关个设置页回来页面重新加载」。
     * 重载只由改设置的那一处负责 —— 见 setLoadImages 的点击回调。
     */
    private void applyImageLoading() {
        if (web == null) return;
        WebSettings s = web.getSettings();
        s.setLoadsImagesAutomatically(settings.loadImages);
        s.setBlockNetworkImage(!settings.loadImages);
    }

    private String describeError(WebResourceError err) {
        if (err == null) return "未知错误";
        int code = err.getErrorCode();
        // 把常见码翻成人话。干巴巴一个 -6 对用户等于没信息。
        if (code == -2) return "域名解析失败，检查一下网络或 DNS";
        if (code == -6) return "找不到该域名";
        if (code == -10) return "网络连接超时";
        if (code == -1) return "该网站拒绝连接";
        if (err.getDescription() != null) return String.valueOf(err.getDescription());
        return "错误码 " + code;
    }

    // ------------------------------------------------------------ 底栏

    private interface OnTap { void tap(View v); }

    private void setupBottomBar() {
        bindMb(R.id.item_mb_back, R.drawable.ic_back, R.string.mb_back, v -> {
            if (web.canGoBack()) web.goBack();
        });
        bindMb(R.id.item_mb_forward, R.drawable.ic_forward, R.string.mb_forward, v -> {
            if (web.canGoForward()) web.goForward();
        });
        bindMb(R.id.item_mb_download, R.drawable.ic_download, R.string.mb_download,
            v -> showDownloadSheet());
        bindMb(R.id.item_mb_read, R.drawable.ic_read, R.string.mb_read,
            v -> showReadSheet());
        bindMb(R.id.item_mb_menu, R.drawable.ic_menu, R.string.mb_menu,
            v -> showMenuSheet());

        findViewById(R.id.mbTabs).setOnClickListener(v -> showTabSheet());
        // 工具栏那个内核标识现在只读，不挂点击 —— 移动版没有内核可选了，
        // 挂一个只能弹「你其实只有这一个」的提示，等于用一次点击骗一次用户。
    }

    /**
     * 首页按钮。回首页是高频动作，值得在工具栏占一个位置。
     *
     * <p>和菜单里的「首页」共用 {@link #goHome()}：两处各写一份的话，
     * 以后改「新标签页打开还是当前页打开」就要记着改两处。
     */
    private void setupHomeButton() {
        findViewById(R.id.btnHome).setOnClickListener(v -> goHome());
    }

    /**
     * 收藏（书签）按钮。点一下切换「当前页是否收藏」，图标在描边 / 实心之间换。
     * 状态靠当前 url 判断，所以每次页面加载完都要重算一次（见 {@link #updateStarState()}）。
     */
    private void setupStarButton() {
        findViewById(R.id.btnStar).setOnClickListener(v -> toggleBookmark());
    }

    /** AI 助手按钮：弹出常用 AI 服务商列表。 */
    private void setupAiButton() {
        findViewById(R.id.btnAi).setOnClickListener(v -> showAiSheet());
    }

    /** 切换当前页收藏状态。 */
    private void toggleBookmark() {
        if (!mainViewMounted) mountMain();
        String url = currentUrl();
        if (url == null || url.isEmpty() || url.startsWith("about:")
                || url.startsWith("javascript:")) {
            toast("当前页面无法收藏");
            return;
        }
        if (store.isBookmarked(url)) {
            store.removeBookmark(url);
            toast(getString(R.string.bookmark_removed));
        } else {
            store.addBookmark(url, web != null ? web.getTitle() : "");
            toast(getString(R.string.bookmark_added));
        }
        updateStarState();
    }

    /** 按当前 url 刷新星标图标（已收藏=实心，否则=描边）。 */
    private void updateStarState() {
        ImageButton star = findViewById(R.id.btnStar);
        if (star == null) return;
        String url = currentUrl();
        boolean on = url != null && store.isBookmarked(url);
        star.setImageResource(on ? R.drawable.ic_star_filled : R.drawable.ic_star);
    }

    private String currentUrl() {
        Tab t = current();
        if (t != null && t.url != null && !t.url.isEmpty()) return t.url;
        return (web != null && web.getUrl() != null) ? web.getUrl() : settings.homepage;
    }

    /**
     * 回首页。从弹层里调也要能工作，所以先确认主界面装着。
     *
     * <p>刻意不做「已在新页则禁用」：那要监听每次页面跳转来改可用状态，
     * 而收益只是让一个按钮偶尔变灰 —— 用户点了就重新加载首页，行为仍然正确。
     */
    private void goHome() {
        if (!mainViewMounted) mountMain();
        go(settings.homepage);
    }

    /** 底栏下载按钮上的红点：有任务在跑就显示数量。 */
    private void updateDownloadBadge() {
        View badge = findViewById(R.id.item_mb_download);
        if (badge == null) return;
        TextView text = badge.findViewById(R.id.btnText);
        if (text == null) return;
        int active_ = 0;
        if (downloader != null) {
            for (DownloadTask t : downloader.tasks()) {
                if (t.state == DownloadTask.State.RUNNING
                    || t.state == DownloadTask.State.PROBING
                    || t.state == DownloadTask.State.MERGING
                    || t.state == DownloadTask.State.QUEUED) {
                    active_++;
                }
            }
        }
        text.setText(active_ > 0
            ? getString(R.string.mb_download) + " " + active_
            : getString(R.string.mb_download));
        // 有任务在跑时给个品牌色的底，提醒「它还在动」
        badge.setBackgroundResource(active_ > 0 ? R.drawable.seg_on : 0);
    }

    private void bindMb(int boxId, int iconRes, int textRes, OnTap cb) {
        View box = findViewById(boxId);
        ((ImageView) box.findViewById(R.id.btnIcon)).setImageResource(iconRes);
        ((TextView) box.findViewById(R.id.btnText)).setText(textRes);
        box.setOnClickListener(v -> cb.tap(v));
    }

    // ------------------------------------------------------------ 地址栏

    private void setupOmnibox() {
        urlBar.setOnEditorActionListener((v, actionId, event) -> {
            boolean go = actionId == EditorInfo.IME_ACTION_GO
                || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                    && event.getAction() == KeyEvent.ACTION_DOWN);
            if (!go) return false;
            go(settings.resolveInput(urlBar.getText().toString()));
            hideKeyboard();
            return true;
        });

        /*
         * 刷新 / 停止。判据用 WebView 自己的进度，不用进度条的可见性：
         * mountMain 每次从弹层返回都会重新 inflate 布局，新 ProgressBar 在 XML 里
         * 没写 visibility、默认是 visible，于是「空闲」也会被误判成「正在加载」，
         * 点了只会 stopLoading、什么都不发生 —— 这就是「刷新按钮无效」的根因。
         * 更早的版本还多加了一个 web.canGoBack()，那个跟「停不停」毫无关系，一并去掉。
         */
        findViewById(R.id.btnReload).setOnClickListener(v -> {
            if (web == null) return;
            if (web.getProgress() < 100) {
                web.stopLoading();
            } else {
                web.reload();
            }
        });
    }

    /**
     * 打开一个地址。
     *
     * <p>「强制 HTTPS」在这里生效，因为这是<b>唯一</b>能真正拦住明文的时机：
     * 在 loadUrl 之前把 http:// 换成 https://，明文请求根本不会发出去。
     * 放到请求拦截里就晚了 —— 那时请求已经在路上了。
     */
    private void go(String raw) {
        if (TextUtils.isEmpty(raw)) return;
        String url = applyHttps(raw);
        Tab t = current();
        if (t != null) t.url = url;
        web.loadUrl(url);
    }

    /**
     * 明文升级成 https。
     *
     * <p>本机、内网、纯 IP 一律不升级：这些地址通常没有可信证书，
     * 升上去只会把「能打开」变成「打不开」，那是在帮倒忙。
     */
    private String applyHttps(String raw) {
        String s = raw.trim();
        if (!settings.forceHttps) return s;
        if (!s.toLowerCase(Locale.ROOT).startsWith("http://")) return s;
        if (isLocalOrIp(s)) return s;
        return "https://" + s.substring("http://".length());
    }

    /** 本机 / 内网 / 纯 IP —— 这类地址一般拿不到可信证书。 */
    static boolean isLocalOrIp(String url) {
        String host = Tab.hostOf(url);
        if (host.isEmpty() || "localhost".equals(host)) return true;
        if (host.startsWith("127.") || host.startsWith("192.168.")
                || host.startsWith("10.")) return true;
        // 172.16.0.0 – 172.31.255.255
        if (host.startsWith("172.")) {
            String[] p = host.split("\\.");
            if (p.length == 4) {
                try {
                    int second = Integer.parseInt(p[1]);
                    if (second >= 16 && second <= 31) return true;
                } catch (NumberFormatException ignored) {
                    // 第二段不是数字，那就不是内网保留段
                }
            }
        }
        return isIpLiteral(host);
    }

    private static boolean isIpLiteral(String host) {
        int dot = host.indexOf('.');
        if (dot < 0) return host.equals("::1");
        String[] p = host.split("\\.");
        if (p.length != 4) return false;
        for (String x : p) {
            if (x.isEmpty() || x.length() > 3) return false;
            for (int i = 0; i < x.length(); i++) {
                char c = x.charAt(i);
                if (c < '0' || c > '9') return false;
            }
        }
        return true;
    }

    private void syncUrlBar(String url) {
        if (urlBar.hasFocus()) return;
        urlBar.setText(url == null ? "" : url);
        urlBar.setSelection(urlBar.getText().length());
    }

    // ------------------------------------------------------------ 标签

    private Tab current() {
        return active >= 0 && active < tabs.size() ? tabs.get(active) : null;
    }

    private void newTab(String raw) {
        if (TextUtils.isEmpty(raw)) return;
        // 和 go() 一样走一遍明文升级：开了「强制 HTTPS」却让新标签页漏掉，
        // 用户只会觉得这个开关时灵时不灵。
        String url = applyHttps(raw);
        if (tabs.size() >= MAX_TABS) {
            // 上限的理由写在 Tab 的类注释里：一个标签一个 WebView 的做法在 Android 上
            // 活不过二十个。这里复用 WebView，理论上能开更多，但标签数据本身
            // （URL + 标题 + 缩略图）到几十个也已经是几十兆的量级了。
            toast("标签太多了，先关掉几个吧");
            return;
        }
        captureScroll();
        captureSnapshot(active);
        tabs.add(new Tab(url));
        active = tabs.size() - 1;
        web.loadUrl(url);
        syncChrome();
    }

    private static final int MAX_TABS = 40;

    private void switchTab(int index) {
        if (index < 0 || index >= tabs.size() || index == active) return;
        captureScroll();
        captureSnapshot(active);
        active = index;
        // 记下来的滚动位置，要等页面加载完再还原（见 onPageFinished）。
        // 用标志而不是「判断 scrollY > 0」：后者会把普通刷新也当成切标签。
        restoreScrollOnFinish = true;
        web.loadUrl(tabs.get(active).url);
        syncChrome();
    }

    private void closeTab(int index) {
        if (index < 0 || index >= tabs.size()) return;
        tabs.get(index).releaseSnapshot();
        tabs.remove(index);

        if (tabs.isEmpty()) {
            tabs.add(new Tab(settings.homepage));
            active = 0;
            web.loadUrl(tabs.get(0).url);
        } else if (index < active) {
            // 关掉的是前面的：索引整体前移，当前页面不变，不用重载
            active--;
        } else if (index == active) {
            active = Math.min(active, tabs.size() - 1);
            web.loadUrl(tabs.get(active).url);
        }
        saveSessionNow();
        syncChrome();
    }

    private void captureScroll() {
        Tab t = current();
        if (t != null) t.scrollY = web.getScrollY();
    }

    /**
     * 给标签总览抓一张缩略图。
     *
     * <p>抓完立刻缩到 240px 宽。为什么不让它保持原始尺寸：那会让「并排看十几个标签」
     * 这个功能变成内存杀手 —— 十几张全屏 Bitmap 轻松吃掉上百兆。
     * 它的用途只是「一眼认出是哪个页面」，240px 足够了。
     */
    private void captureSnapshot(int index) {
        if (index < 0 || index >= tabs.size()) return;
        Tab t = tabs.get(index);
        if (t.snapshot != null) return;
        try {
            // 用 draw + Canvas 而不是某个「截 WebView」的现成方法 ——
            // 那类方法要么不存在，要么在页面没画完时抛。走 draw 最直白：
            // 它就是「把当前这帧画下来」，画不出东西就是空白，天然安全。
            int w = 240;
            int h = Math.max(1, web.getHeight() * w / Math.max(1, web.getWidth()));
            if (web.getWidth() == 0 || web.getHeight() == 0) return;
            Bitmap small = Bitmap.createBitmap(w, h, Bitmap.Config.RGB_565);
            Canvas canvas = new Canvas(small);
            // 只取页面左上角一块：整页缩到 240px 宽的话，
            // 一屏 2000px 高的内容会缩到 24px，什么都认不出来。
            canvas.scale(w / (float) web.getWidth(), h / (float) web.getHeight());
            web.draw(canvas);
            t.snapshot = small;
        } catch (Exception ignored) {
            // 页面还没画出内容时 draw 会抛。抓不到缩略图只是总览里少一张图，
            // 不该因此打断用户切标签。
        }
    }

    /**
     * 存一次当前会话。无痕模式下直接不写盘。
     *
     * <p>判断集中在这里，而不是散在各个调用点：会话保存散落在
     * onPageFinished、onReceivedTitle、closeTab、onPause 四处，
     * 漏掉任何一处，无痕就形同虚设 —— 只要写过一次盘，
     * 「去过哪些页」这份清单就已经留在机器上了，后面不写也没用。
     */
    private void saveSessionNow() {
        if (settings.incognito) return;
        store.saveSession(sessionUrls(), active);
    }

    private List<String> sessionUrls() {
        List<String> out = new ArrayList<>();
        for (Tab t : tabs) out.add(t.url);
        return out;
    }

    private void restoreSession() {
        // 开关关掉时不去读上次存的会话，只开一个主页。
        // 存下来的数据不清，用户哪天把开关打开还能接着用——
        // 「关掉」说的是这次别恢复，不是把历史抹了。
        List<String> urls = null;
        if (settings.restoreSession) urls = store.loadSession();
        if (urls == null || urls.isEmpty()) {
            tabs.add(new Tab(settings.homepage));
            active = 0;
            web.loadUrl(tabs.get(0).url);
        } else {
            for (String u : urls) tabs.add(new Tab(u));
            int idx = store.loadActive();
            active = (idx >= 0 && idx < tabs.size()) ? idx : 0;
            web.loadUrl(tabs.get(active).url);
        }
        syncChrome();
    }

    private void syncChrome() {
        ((TextView) findViewById(R.id.mbTabCount)).setText(String.valueOf(tabs.size()));
        updateDownloadBadge();
    }

    // ------------------------------------------------------------ 用户脚本

    /**
     * 按 URL 匹配并注入用户脚本。
     *
     * <p>与自动拼页刻意分开注入：那个是「页面一加载就要接管滚动」，
     * 这个是「按站点匹配、可有可无」。混成一次求值的话，
     * 关掉插件也得让拼页跟着重新 boot 一次，而插件是用户随时会开关的。
     *
     * <p>注入失败绝不能让页面出问题 —— 脚本跑在页面上下文里，
     * 一个语法错误的用户脚本如果能让浏览器崩掉，那就是严重的安全问题。
     * {@link UserScript#buildInject} 把它整个包在 try/catch 里。
     */
    private void injectPlugins(String url) {
        if (!settings.pluginsEnabled || scripts.isEmpty() || url == null) return;
        String code;
        try {
            code = UserScript.buildInjectAll(scripts, url, null);
        } catch (Exception e) {
            return;
        }
        if (code.isEmpty()) return;
        web.evaluateJavascript(code, null);
    }

    /** 插件相关配置变了之后重设一遍，避免下次进页面才生效。 */
    private void reloadScripts() {
        scripts = store.loadScripts();
    }

    // -------------------------------------------------------------- 下载

    private android.net.Uri uriOf(String url) {
        try {
            return android.net.Uri.parse(url);
        } catch (Exception e) {
            return null;
        }
    }

    /** 媒体文件类型在系统里的 MIME，用于「用别的应用打开」。 */
    private String mimeOf(String name) {
        String ext = DownloadTrigger.extOf(name);
        if (ext.isEmpty()) return "*/*";
        switch (ext) {
            case "mp4": case "m4v": case "mkv": case "webm": case "mov":
            case "avi": case "flv": case "ts":
                return "video/*";
            case "mp3": case "m4a": case "aac": case "wav": case "flac": case "ogg":
                return "audio/*";
            case "jpg": case "jpeg": case "png": case "gif": case "webp": case "bmp":
                return "image/*";
            case "pdf":
                return "application/pdf";
            case "zip": case "rar": case "7z": case "apk":
                return "application/octet-stream";
            case "txt":
                return "text/plain";
            default:
                return "*/*";
        }
    }

    /**
     * 从 {@code Content-Disposition} 头里取出文件名。
     *
     * <p>两种常见写法都要认：
     * <pre>
     *   attachment; filename="report.zip"
     *   attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.zip
     * </pre>
     * 第二种是 RFC 5987 的编码形式，中文站点多用它，且比裸 filename 更可靠
     * （裸 filename 常常是问号乱码）。取不到就返回 null，让下载器回落到
     * 「从 URL 末段取名」。顺手砍掉目录部分：文件名里不该有 {@code /} 或 {@code \}，
     * 万一有（不怀好意的服务器），也只保留最后一段，防止它借文件名写到别的目录。
     *
     * <p>抽成静态纯函数是为了单测：这些分支在真机上要各碰一次对应的服务器才看得到。
     */
    static String filenameFromDisposition(String cd) {
        if (cd == null || cd.isEmpty()) return null;
        java.util.regex.Pattern p;
        java.util.regex.Matcher m;

        // filename* 优先：带字符集，最可靠
        p = java.util.regex.Pattern.compile(
            "filename\\*\\s*=\\s*([^;]+)", java.util.regex.Pattern.CASE_INSENSITIVE);
        m = p.matcher(cd);
        if (m.find()) {
            String raw = m.group(1).trim();
            int q = raw.indexOf("''");        // 形如 UTF-8''<encoded>
            if (q >= 0) raw = raw.substring(q + 2);
            String dec;
            try {
                dec = java.net.URLDecoder.decode(raw, "UTF-8");
            } catch (Exception e) {
                dec = raw;                     // 解不动就用原样，总比没有好
            }
            return lastSegment(dec);
        }

        // 带引号的 filename="..."
        p = java.util.regex.Pattern.compile(
            "filename\\s*=\\s*\"([^\"]*)\"", java.util.regex.Pattern.CASE_INSENSITIVE);
        m = p.matcher(cd);
        if (m.find()) return lastSegment(m.group(1));

        // 少数服务器不加引号：filename=report.zip
        p = java.util.regex.Pattern.compile(
            "filename\\s*=\\s*([^;]+)", java.util.regex.Pattern.CASE_INSENSITIVE);
        m = p.matcher(cd);
        if (m.find()) return lastSegment(m.group(1).trim());

        return null;
    }

    /** 砍掉目录部分，只留最后一段；空了返回 null。 */
    private static String lastSegment(String name) {
        if (name == null) return null;
        int cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (cut >= 0) name = name.substring(cut + 1);
        name = name.trim();
        return name.isEmpty() ? null : name;
    }

    // ------------------------------------------------------------ 自动拼页

    /**
     * 页面加载完成后按需注入自动拼页。
     *
     * <p>注入和读状态之间只隔一次回调。脚本内部有版本号自检，重复注入会被它挡掉，
     * 但那仍然是一次多余求值 —— 而 {@code evaluateJavascript} 本身是这一页里
     * 唯一可能抛异常的地方，能少调一次就少一个故障点。
     */
    private void maybeInjectAutoPage() {
        if (!settings.autoPage) {
            stopPolling();
            hideStatus();
            return;
        }
        if (!autoPageError.isEmpty()) {
            showStatus(autoPageError);
            return;
        }
        web.evaluateJavascript(AutoPage.bootSource(autoPageScript, settings.autoPageMax),
            value -> startPolling());
    }

    private void startPolling() {
        stopPolling();
        poll = new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript(AutoPage.STATUS_SOURCE, raw -> {
                    if (raw == null) { stopPolling(); return; }
                    AutoPage.Status st = AutoPage.parseStatus(raw);
                    if (st.error.length() > 0 || st.finished.length() > 0
                        || st.loading || st.pages > 0) {
                        showStatus(st.summary());
                    } else {
                        hideStatus();
                    }
                    // 拼完就停：继续问一个再也不变的页面，纯属耗电。
                    if (st.loading) main.postDelayed(this, 600);
                    else stopPolling();
                });
            }
        };
        main.postDelayed(poll, 600);
    }

    private void stopPolling() {
        if (poll != null) main.removeCallbacks(poll);
        poll = null;
    }

    // ------------------------------------------------------------ 状态条

    private void showStatus(String text) {
        if (TextUtils.isEmpty(text)) {
            hideStatus();
            return;
        }
        statusStrip.setText(text);
        statusStrip.setVisibility(View.VISIBLE);
    }

    private void hideStatus() {
        if (statusStrip != null) statusStrip.setVisibility(View.GONE);
    }

    // ------------------------------------------------------------ 内核

    private void applyUserAgent() {
        WebSettings s = web.getSettings();
        // 自定义 UA 优先于一切 —— 它是用户明确要的，压过任何默认策略。
        if (!settings.customUA.trim().isEmpty()) {
            s.setUserAgentString(settings.customUA.trim());
            return;
        }
        // 用户把自定义 UA 清空时，UA 必须回到系统真实值。
        // 漏了这一步就是那种「界面上写着默认、实际发出去还是 IE」的静默错。
        String cur = s.getUserAgentString();
        String system = getSystemDefaultUA();
        if (!system.isEmpty() && !system.equals(cur)) {
            s.setUserAgentString(system);
        }
    }

    /**
     * 取系统的真实 UA。
     *
     * <p>不能靠「把已知的几个 UA 换回去」—— 那永远漏得掉一个。
     * 正解是 {@code WebSettings} 有一个 {@code getDefaultUserAgent}，
     * 它在任何 UA 被设过之前调用都能拿到系统默认值。调它之前必须先把
     * {@code setUserAgentString} 恢复成 null，否则拿回来的就是刚设的那个。
     */
    private String getSystemDefaultUA() {
        try {
            String saved = web.getSettings().getUserAgentString();
            web.getSettings().setUserAgentString(null);
            String d = web.getSettings().getDefaultUserAgent(this);
            if (d == null || d.isEmpty()) {
                web.getSettings().setUserAgentString(saved);
                return "";
            }
            return d;
        } catch (Exception e) {
            return "";
        }
    }

    /** 是否在装桌面 UA 的兼容层。移动版不再提供内核选择，这里恒为 false。 */
    private boolean applyEngine() {
        engineLabel.setText("CR");
        GradientDrawable dot = new GradientDrawable();
        dot.setShape(GradientDrawable.OVAL);
        dot.setColor(color(engine.active.colorRes));
        engineDot.setBackground(dot);
        return true;
    }

    private int color(int res) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) return getColor(res);
        return getResources().getColor(res);
    }

    /** 深浅色下给网页区换个底色，否则夜间模式会留一条刺眼的白边。 */
    private void applySurfaceTheme() {
        boolean night = (getResources().getConfiguration().uiMode
            & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        web.setBackgroundColor(color(night ? R.color.surface_dark : R.color.surface));
    }

    // ------------------------------------------------------------ 弹层

    /**
     * 弹层底座：全屏遮罩 + 底部卡片。
     *
     * <p>遮罩点击即关。弹层都是 {@code setContentView} 换出来的，
     * 所以关闭走 {@link #mountMain()} 而不是 removeView —— 原因见那里的注释。
     */
    private View openSheet(String title, int layoutRes) {
        mainViewMounted = false;
        downloadSheetOpen = false;

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(color(R.color.bg));

        View scrim = new View(this);
        scrim.setBackgroundResource(R.drawable.scrim);
        root.addView(scrim, new FrameLayout.LayoutParams(-1, -1));
        scrim.setOnClickListener(v -> mountMain());

        View sheet = LayoutInflater.from(this).inflate(layoutRes, root, false);
        sheet.setBackgroundResource(R.drawable.card);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-1, -2);
        lp.gravity = Gravity.BOTTOM;
        root.addView(sheet, lp);

        TextView t = sheet.findViewById(R.id.sheetTitle);
        if (t != null) t.setText(title);
        View close = sheet.findViewById(R.id.sheetClose);
        if (close != null) close.setOnClickListener(v -> mountMain());

        setContentView(root);
        openSheetView = sheet;
        openSheetLayout = layoutRes;
        return sheet;
    }

    // ------------------------------------------------------- 内核信息（只读）

    /**
     * 界面上的「当前内核」说明。移动版没有内核选择，这一档只有说明没有动作。
     *
     * <p>保留它的原因不是「显得功能多」，而是用户迟早会问「这到底是不是 Chrome」——
     * 与其让他去网上猜，不如直接写清楚（含真实版本号）。
     */
    private String engineInfo() {
        String v = webEngineVersion();
        StringBuilder sb = new StringBuilder();
        sb.append("渲染内核：系统内置 Chromium 内核");
        if (!v.isEmpty()) sb.append(' ').append(v);
        sb.append("\n本应用不内置内核。移动版没有内置第二套引擎可选，"
            + "因此也不提供内核选择 —— 这不是功能被砍，是真内核最小也有 80MB，"
            + "塞进 APK 后这个浏览器会变成 100MB 起步。");
        return sb.toString();
    }

    /** 从 UA 里抠出 Chromium 版本号。比问 PackageManager 简单且更贴近「我实际跑的是谁」。 */
    private String webEngineVersion() {
        try {
            String ua = web.getSettings().getUserAgentString();
            int i = ua.indexOf("Chrome/");
            if (i < 0) return "";
            int j = ua.indexOf('.', i + 7);
            int k = ua.indexOf(' ', i + 7);
            if (j < 0) return "";
            int end = (k > 0 && k < j + 3) ? k : j + 3;
            return "v" + ua.substring(i + 7, end).replaceAll("\\..*$", ".0");
        } catch (Exception e) {
            return "";
        }
    }

    private String natureLabel(EngineCatalog.Nature nature) {
        switch (nature) {
            case REAL_KERNEL: return "真内核";
            case COMPAT_LAYER: return "兼容层 · 不是内核";
            default: return "未内置";
        }
    }

    // ------------------------------------------------------- 阅读增强弹层

    private void showReadSheet() {
        View sheet = openSheet(getString(R.string.sheet_read), R.layout.sheet_read);

        // 无图三档
        LinearLayout seg = sheet.findViewById(R.id.nmSeg);
        final NoImagePolicy.Level cur = settings.noImageLevel();
        for (NoImagePolicy.Level lv : NoImagePolicy.Level.values()) {
            final NoImagePolicy.Level level = lv;
            View b = LayoutInflater.from(this).inflate(R.layout.item_seg, seg, false);
            TextView label = b.findViewById(R.id.segText);
            label.setText(lv.label);
            boolean on = lv == cur;
            b.setBackgroundResource(on ? R.drawable.seg_on : R.drawable.seg_track);
            label.setTextColor(color(on ? R.color.surface : R.color.text_2));
            b.setOnClickListener(v -> {
                settings.noImage = level.id;
                interceptor.setPolicy(new NoImagePolicy(level, registry.mediaExts()));
                store.save(settings);
                syncNoImageChip();
                updateNoImageHint(sheet);
                showReadSheet();
            });
            seg.addView(b);
        }
        updateNoImageHint(sheet);

        // 拼页上限三档。按下去即开启拼页并重载 —— 配置必须在页面脚本注入前生效，
        // 所以走一次 reload 而不是等下一次导航。
        LinearLayout pages = sheet.findViewById(R.id.apSeg);
        for (int n : AutoPage.MAX_PAGES) {
            final int max = n;
            View b = LayoutInflater.from(this).inflate(R.layout.item_seg, pages, false);
            TextView label = b.findViewById(R.id.segText);
            label.setText(n + " 页");
            boolean on = n == settings.autoPageMax && settings.autoPage;
            b.setBackgroundResource(on ? R.drawable.seg_on : R.drawable.seg_track);
            label.setTextColor(color(on ? R.color.surface : R.color.text_2));
            b.setOnClickListener(v -> {
                settings.autoPageMax = max;
                settings.autoPage = true;
                store.save(settings);
                mountMain();
                web.reload();
                toast("自动拼页已开启，上限 " + max + " 页");
            });
            pages.addView(b);
        }

        sheet.findViewById(R.id.apUndo).setOnClickListener(v ->
            web.evaluateJavascript(AutoPage.UNDO_SOURCE, raw -> {
                mountMain();
                toast("已撤销拼接");
            }));

        sheet.findViewById(R.id.apStop).setOnClickListener(v ->
            web.evaluateJavascript(AutoPage.STOP_SOURCE, raw -> {
                mountMain();
                toast("已停止拼接");
            }));

        TextView warn = sheet.findViewById(R.id.registryWarn);
        if (!registry.loaded()) {
            warn.setVisibility(View.VISIBLE);
            warn.setText("名单加载异常：" + registry.loadError()
                + "。此时无图模式仍可用，但最高档拦不了视频。");
        }
        if (!autoPageError.isEmpty()) {
            ((TextView) sheet.findViewById(R.id.readNote)).setText(autoPageError);
        }
    }

    /**
     * 无图档位的诚实提示。
     *
     * <p>这几行不是凑字数。Android 的 {@code shouldInterceptRequest} 不给资源类型，
     * 只能按 URL 后缀猜，所以「无后缀的图」和「伪静态图」必然拦不住。
     * 不讲清楚，用户会以为功能坏了 —— 或者更糟，以为流量真省下来了。
     */
    private void updateNoImageHint(View sheet) {
        TextView hint = sheet.findViewById(R.id.nmHint);
        if (hint == null) return;
        NoImagePolicy.Level lv = settings.noImageLevel();
        if (lv == NoImagePolicy.Level.OFF) {
            hint.setText("无图模式已关闭，图片与视频正常加载。");
            return;
        }
        hint.setText(lv.label + "：按网址后缀识别，尽量不下载图片。\n"
            + "移动端按后缀判断，所以没有后缀的图（/a/b/c）和伪静态链接拦不住。"
            + "这不是没做，是 Android 的拦截接口不告诉我们要什么类型 —— "
            + "想拦就得先把响应拉回来，那流量已经产生了。");
    }

    // --------------------------------------------------------- 菜单弹层

    private void showMenuSheet() {
        View sheet = openSheet(getString(R.string.sheet_menu), R.layout.sheet_menu);

        // ---- 浏览：导航与拦截
        menuRow(sheet, R.id.menuHome, "首页", "回到首页", () -> goHome());
        menuRow(sheet, R.id.menuBookmarks, "书签",
            store.bookmarks().isEmpty() ? "未收藏"
                : "已收藏 " + store.bookmarks().size() + " 条", () -> {
            mountMain();
            showBookmarksSheet();
        }, true);
        // 无痕模式下副标题直接说明「不记录」。不写的话，用户开了无痕、
        // 进来发现历史停在几天前，只会以为这个功能坏了。
        menuRow(sheet, R.id.menuHistory, getString(R.string.sheet_history),
            settings.incognito ? "无痕模式不记录"
                : (store.history().isEmpty() ? "无记录"
                    : "最近 " + store.history().size() + " 条"), () -> {
            mountMain();
            showHistorySheet();
        }, true);
        menuRow(sheet, R.id.menuAdblock, "广告拦截",
            registry.hasUserRules()
                ? "已订阅 · " + registry.totalHosts() + " 个域名"
                : "内置 " + registry.adblockHosts().size() + " 个域名", () -> {
            mountMain();
            showRulesSheet();
        }, true);

        // ---- 工具：对网页的加工能力（下载 / 阅读 / 篡改猴）
        menuRow(sheet, R.id.menuRead, "阅读增强", "无图模式 / 自动拼页", () -> {
            mountMain();
            showReadSheet();
        }, true);
        menuRow(sheet, R.id.menuDownloads, "下载", downloadSummary(), () -> {
            mountMain();
            showDownloadSheet();
        }, true);
        menuRow(sheet, R.id.menuPlugins, "篡改猴",
            scripts.isEmpty() ? "未安装" : "已装 " + scripts.size() + " 个", () -> {
            mountMain();
            showPluginSheet();
        }, true);

        // ---- 应用
        menuRow(sheet, R.id.menuUpdate, "检查更新",
            "当前 " + getString(R.string.app_version),
            () -> checkUpdate(true));
        menuRow(sheet, R.id.menuSettings, "设置", null, () -> {
            mountMain();
            showSettings();
        }, true);
        menuRow(sheet, R.id.menuAbout, "关于", null, () -> {
            mountMain();
            showAbout();
        });
        menuRow(sheet, R.id.menuExit, "退出", null, () -> {
            finishAffinity();
        });

        ((TextView) sheet.findViewById(R.id.aboutVer))
            .setText("吾爱Nova浏览器 " + getString(R.string.app_version));
    }

    private void toggleAdblock() {
        settings.adblockEnabled = !settings.adblockEnabled;
        interceptor.setAdblockEnabled(settings.adblockEnabled);
        store.save(settings);
        toast(settings.adblockEnabled
            ? "广告拦截已开启（" + registry.totalHosts() + " 个域名）"
            : "广告拦截已关闭");
        web.reload();
    }

    // ------------------------------------------------------ 拦截规则面板

    private void showRulesSheet() {
        View sheet = openSheet(getString(R.string.sheet_rules), R.layout.sheet_rules);

        refreshRulesPanel(sheet);

        // 开关。改完立刻重算这一块，因为它就是「现在拦不拦」的答案。
        TextView sw = sheet.findViewById(R.id.rlSwitch);
        sw.setBackgroundResource(settings.adblockEnabled ? R.drawable.seg_on : R.drawable.seg_track);
        sw.setTextColor(color(settings.adblockEnabled ? R.color.surface : R.color.text_2));
        sw.setText(settings.adblockEnabled ? "已开启" : "已关闭");
        sw.setOnClickListener(v -> {
            toggleAdblock();
            mountMain();
            showRulesSheet();
        });

        LinearLayout list = sheet.findViewById(R.id.rlList);
        for (RuleSet.Subscription sub : RuleSet.presets()) {
            list.addView(subRow(list, sub));
        }

        sheet.findViewById(R.id.rlCustom).setOnClickListener(v -> {
            View input = LayoutInflater.from(this).inflate(R.layout.sheet_settings, null, false);
            EditText box = new EditText(this);
            box.setHint("https://example.com/list.txt");
            box.setText(store.rulesUrl());
            box.setSingleLine(true);
            box.setTextColor(color(R.color.text));
            box.setHintTextColor(color(R.color.text_4));
            box.setBackgroundResource(R.drawable.omnibox);
            int pad = (int) (14 * getResources().getDisplayMetrics().density);
            box.setPadding(pad, pad, pad, pad);
            FrameLayout box1 = new FrameLayout(this);
            box1.setPadding(pad, pad, pad, pad);
            box1.addView(box, new FrameLayout.LayoutParams(-1, -2));

            new NovaAlert(this, "自定义订阅地址", null)
                .custom(box1)
                .negative("取消", null)
                .positive("更新", () -> {
                    String url = box.getText().toString().trim();
                    String bad = RuleSet.validateUrl(url);
                    if (!bad.isEmpty()) {
                        toast(bad);
                        return;
                    }
                    startRuleUpdate(url, url);
                })
                .show();
        });

        sheet.findViewById(R.id.rlUpdate).setOnClickListener(v -> {
            String url = store.rulesUrl();
            if (url.isEmpty()) {
                toast("先选一个订阅源，或填自定义地址");
                return;
            }
            startRuleUpdate(url, store.rulesSourceLabel());
        });
    }

    private View subRow(LinearLayout parent, RuleSet.Subscription sub) {
        boolean on = sub.url.equals(store.rulesUrl());
        return pickerRow(parent, sub.label, sub.note, on, () -> {
            store.saveUserRules(new java.util.HashSet<>(registry.adblockHosts()),
                sub.url, sub.label, 0, "");
            reloadRegistry();
            mountMain();
            showRulesSheet();
            startRuleUpdate(sub.url, sub.label);
        });
    }

    /** 重算规则面板上的所有文字。订阅更新完成后也走这里。 */
    private void refreshRulesPanel(View sheet) {
        TextView title = sheet.findViewById(R.id.rlTitle);
        TextView sub = sheet.findViewById(R.id.rlSub);
        TextView stat = sheet.findViewById(R.id.rlStat);

        if (registry.hasUserRules()) {
            title.setText(store.rulesSourceLabel().isEmpty()
                ? "自定义订阅" : store.rulesSourceLabel());
            sub.setText("更新于 " + store.rulesStamp()
                + (store.rulesUnsupported() > 0
                    ? " · " + store.rulesUnsupported() + " 条规则移动版不支持" : ""));
            stat.setText("生效域名 " + registry.totalHosts()
                + " 个（内置 " + registry.adblockHosts().size()
                + " + 订阅 " + (registry.totalHosts() - registry.adblockHosts().size()) + "）");
        } else {
            title.setText("仅内置名单");
            sub.setText("还没订阅外部规则。选一个源更新后，拦截量会明显上升。");
            stat.setText("生效域名 " + registry.adblockHosts().size()
                + " 个（随包内置）");
        }

        ((TextView) sheet.findViewById(R.id.rlLimit)).setText(
            "移动版的拦截只能按域名匹配，原因是 Android 的请求拦截拿不到资源类型。"
            + "这带来两条限制，订阅里对应的规则会被跳过（上面有显示跳过了多少条）：\n"
            + "· 元素隐藏规则（##.ad-banner）拦不了 —— 那需要改页面 DOM\n"
            + "· 路径规则（||cdn.com/ads/）拦不了 —— 只能整站或按域名\n"
            + "桌面端这两类是能用的，移动版不是同一套实现。");
    }

    private void startRuleUpdate(String url, String label) {
        if (ruleUpdater == null) ruleUpdater = new RuleUpdater(store);
        toast("正在更新规则…");
        ruleUpdater.update(url, label, result -> {
            if (result == null) return;
            if (result.ok) {
                reloadRegistry();
                toast(result.message);
                // 当前若正开着规则面板，就重开一次让数字刷新。
                // 判据用显式记录的 openSheetLayout，不要用 view.getId() ——
                // 面板布局的根节点常常没有 android:id，那样 getId() 返回
                // View.NO_ID，判断恒为 false，这段刷新就永远不会跑到。
                if (!mainViewMounted && openSheetLayout == R.layout.sheet_rules) {
                    showRulesSheet();
                }
            } else {
                new NovaAlert(this, "更新失败", result.message)
                    .positive("知道了", null)
                    .show();
            }
        });
    }

    // ---------------------------------------------------------- 书签面板

    private void showBookmarksSheet() {
        View sheet = openSheet(getString(R.string.sheet_bookmarks), R.layout.sheet_bookmarks);

        LinearLayout list = sheet.findViewById(R.id.bmList);
        List<BookmarkStore.Bookmark> bms = store.bookmarks();
        sheet.findViewById(R.id.bmEmpty)
            .setVisibility(bms.isEmpty() ? View.VISIBLE : View.GONE);

        for (BookmarkStore.Bookmark b : bms) list.addView(bookmarkRow(list, b));

        sheet.findViewById(R.id.bmClear).setOnClickListener(v -> {
            final int n = store.bookmarks().size();
            if (n == 0) return;
            new NovaAlert(this, "清空书签",
                "会删除全部 " + n + " 条书签，无法撤销。")
                .positive("清空", () -> {
                    store.clearBookmarks();
                    showBookmarksSheet();
                })
                .negative("取消", null)
                .show();
        });
    }

    private View bookmarkRow(LinearLayout parent, final BookmarkStore.Bookmark b) {
        View row = LayoutInflater.from(this).inflate(R.layout.item_bookmark, parent, false);
        ((TextView) row.findViewById(R.id.bmTitle)).setText(b.title);
        ((TextView) row.findViewById(R.id.bmUrl)).setText(b.url);

        // 点整行去那个网址；右侧 × 单独删，互不干扰。
        row.setOnClickListener(v -> {
            mountMain();
            go(b.url);
        });
        row.findViewById(R.id.bmRemove).setOnClickListener(v -> {
            store.removeBookmark(b.url);
            showBookmarksSheet();
        });
        return row;
    }

    // ---------------------------------------------------------- 浏览历史

    private void showHistorySheet() {
        View sheet = openSheet(getString(R.string.sheet_history), R.layout.sheet_history);

        LinearLayout list = sheet.findViewById(R.id.hiList);
        List<HistoryStore.Entry> items = store.history();
        sheet.findViewById(R.id.hiEmpty)
            .setVisibility(items.isEmpty() ? View.VISIBLE : View.GONE);

        // now 只算一次：几十条记录各调一次 System.currentTimeMillis()
        // 既浪费，也可能在跨零点的瞬间让相邻两条一个算今天、一个算昨天。
        final long now = System.currentTimeMillis();
        for (HistoryStore.Entry e : items) list.addView(historyRow(list, e, now));

        sheet.findViewById(R.id.hiClear).setOnClickListener(v -> {
            final int n = store.history().size();
            if (n == 0) return;
            new NovaAlert(this, "清空历史",
                "会删除全部 " + n + " 条浏览记录，无法撤销。")
                .positive("清空", () -> {
                    store.clearHistory();
                    showHistorySheet();
                })
                .negative("取消", null)
                .show();
        });
    }

    private View historyRow(LinearLayout parent, final HistoryStore.Entry e, long now) {
        View row = LayoutInflater.from(this).inflate(R.layout.item_history, parent, false);
        ((TextView) row.findViewById(R.id.hiTitle)).setText(e.title);
        ((TextView) row.findViewById(R.id.hiUrl)).setText(e.url);

        TextView meta = row.findViewById(R.id.hiMeta);
        String when = historyTime(e.visitedAt, now);
        // 去过多次才标次数：几乎所有条目都是 1 次，挂个「1 次」只是白占一行
        meta.setText(e.visits > 1
            ? when + " · " + getString(R.string.history_visits, e.visits)
            : when);

        row.setOnClickListener(v -> {
            mountMain();
            go(e.url);
        });
        row.findViewById(R.id.hiRemove).setOnClickListener(v -> {
            store.removeHistory(e.url);
            showHistorySheet();
        });
        return row;
    }

    /**
     * 历史条目上的时间怎么显示。
     *
     * <p>「今天 14:30」比「2026-10-12 14:30」有用得多 ——
     * 人是靠「我上午看的那个」来找的，不是靠一串日期。
     * minSdk 24 用不了 java.time，所以走 Calendar + SimpleDateFormat。
     */
    static String historyTime(long at, long now) {
        if (at <= 0) return "";
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(at);
        String hm = String.format(Locale.ROOT, "%02d:%02d",
            c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE));
        long days = (startOfDay(now) - startOfDay(at)) / 86400000L;
        if (days <= 0) return "今天 " + hm;
        if (days == 1) return "昨天 " + hm;
        if (days < 7) return days + " 天前";
        return new SimpleDateFormat("M月d日", Locale.CHINA).format(new java.util.Date(at));
    }

    /**
     * 当天零点。要以「日历日」为单位比，直接拿毫秒差算天数的话，
     * 23:50 记下的一条，00:10 再看会被算成同一天。
     */
    static long startOfDay(long ms) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(ms);
        c.set(Calendar.HOUR_OF_DAY, 0);
        c.set(Calendar.MINUTE, 0);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }

    // ---------------------------------------------------------- 插件面板

    private void showPluginSheet() {
        View sheet = openSheet(getString(R.string.sheet_plugins), R.layout.sheet_plugins);

        ((TextView) sheet.findViewById(R.id.plNotice)).setText(
            "吾爱Nova 内置篡改猴（Tampermonkey）兼容的用户脚本管理器，"
            + "装的是 .user.js，不是 Chrome 扩展 —— Android 没有提供扩展宿主，装不了扩展。"
            + "脚本按 @match 声明的地址注入页面。\n"
            + "不支持 @grant 特权（跨域请求、读取 Cookie 等），"
            + "声明了会在装上后明确标出。");

        refreshPluginPanel(sheet);

        TextView sw = sheet.findViewById(R.id.plSwitch);
        sw.setBackgroundResource(settings.pluginsEnabled ? R.drawable.seg_on : R.drawable.seg_track);
        sw.setTextColor(color(settings.pluginsEnabled ? R.color.surface : R.color.text_2));
        sw.setText(settings.pluginsEnabled ? "运行中" : "已停用");
        sw.setOnClickListener(v -> {
            settings.pluginsEnabled = !settings.pluginsEnabled;
            store.save(settings);
            mountMain();
            showPluginSheet();
        });

        sheet.findViewById(R.id.plInstall).setOnClickListener(v -> pickScriptFile());
    }

    private void refreshPluginPanel(View sheet) {
        scripts = store.loadScripts();
        LinearLayout list = sheet.findViewById(R.id.plList);
        list.removeAllViews();

        ((TextView) sheet.findViewById(R.id.plEmpty))
            .setVisibility(scripts.isEmpty() ? View.VISIBLE : View.GONE);

        int on = 0;
        for (UserScript.Installed s : scripts) {
            if (s.enabled) on++;
            list.addView(pluginRow(list, s));
        }

        ((TextView) sheet.findViewById(R.id.plStatText)).setText(
            scripts.isEmpty() ? "还没有安装任何脚本"
                : "已装 " + scripts.size() + " 个，启用 " + on + " 个");
    }

    private View pluginRow(LinearLayout parent, final UserScript.Installed s) {
        View row = LayoutInflater.from(this).inflate(R.layout.item_plugin, parent, false);
        ((TextView) row.findViewById(R.id.plName)).setText(s.displayName());
        ((TextView) row.findViewById(R.id.plDesc)).setText(s.meta.summary());

        StringBuilder m = new StringBuilder("适用：");
        for (String x : s.meta.match) m.append('\n').append(x);
        for (String x : s.meta.include) m.append('\n').append(x);
        ((TextView) row.findViewById(R.id.plMatch)).setText(m.toString());

        TextView tg = row.findViewById(R.id.plToggle);
        tg.setBackgroundResource(s.enabled ? R.drawable.seg_on : R.drawable.seg_track);
        tg.setTextColor(color(s.enabled ? R.color.surface : R.color.text_2));
        tg.setText(s.enabled ? "启用" : "停用");
        tg.setOnClickListener(v -> {
            store.setScriptEnabled(s.id, !s.enabled);
            mountMain();
            showPluginSheet();
        });

        ((TextView) row.findViewById(R.id.plRemove)).setOnClickListener(v ->
            new NovaAlert(this, "卸载脚本",
                "「" + s.displayName() + "」将从本机删除，无法恢复。")
                .negative("取消", null)
                .positive("卸载", () -> {
                    store.removeScript(s.id);
                    mountMain();
                    showPluginSheet();
                    toast("已卸载");
                })
                .show());
        return row;
    }

    /** 打开系统文件选择器挑 .user.js。 */
    private void pickScriptFile() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivityForResult(i, REQ_PICK_SCRIPT);
        } catch (Exception e) {
            // 有些定制系统没有文档选择器
            startActivityForResult(
                Intent.createChooser(i, "选择用户脚本"), REQ_PICK_SCRIPT);
        }
    }

    private static final int REQ_PICK_SCRIPT = 4101;

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_PICK_SCRIPT || res != RESULT_OK || data == null
            || data.getData() == null) {
            return;
        }
        String text;
        try {
            text = readUriText(data.getData());
        } catch (Exception e) {
            toast("读取失败：" + e.getClass().getSimpleName());
            return;
        }
        UserScript.Parsed p = UserScript.parse(text);
        if (!p.ok()) {
            new NovaAlert(this, "无法安装", p.error).positive("知道了", null).show();
            return;
        }
        String id = UserScript.idOf(p.meta, p.body);
        UserScript.Installed inst = new UserScript.Installed(id, p.meta, p.body,
            System.currentTimeMillis(), data.getData().toString());

        String summary = p.meta.name
            + "\n\n匹配：" + String.join("、", p.meta.match)
            + "\n\n" + p.meta.summary();
        NovaAlert alert = new NovaAlert(this, "安装篡改猴脚本", summary)
            .negative("取消", null)
            .positive("安装", () -> {
                if (!store.saveScript(inst)) {
                    toast("写入失败，可能是存储空间不足");
                    return;
                }
                mountMain();
                showPluginSheet();
                toast("已安装 " + p.meta.name);
            });
        // 关闭「安装时确认」时直接装，不弹框 —— 这个开关存在就是因为有人嫌这一步多余。
        if (!settings.pluginConfirm) {
            store.saveScript(inst);
            mountMain();
            showPluginSheet();
            toast("已安装 " + p.meta.name);
        } else {
            alert.show();
        }
    }

    private String readUriText(android.net.Uri uri) throws Exception {
        java.io.InputStream in = getContentResolver().openInputStream(uri);
        if (in == null) throw new java.io.IOException("打不开这个文件");
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        int total = 0;
        while ((n = in.read(buf)) > 0) {
            bos.write(buf, 0, n);
            total += n;
            // 脚本正常只有几 KB。超过 2MB 基本是选错文件了，
            // 而读下去会把这个内存吃满。
            if (total > 2 * 1024 * 1024) throw new java.io.IOException("文件太大了");
        }
        in.close();
        // 显式 UTF-8：不少用户脚本是中文，不给编码会用平台默认，
        // 在部分机型上会读成一串乱码然后解析失败。
        return new String(bos.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
    }

    // ---------------------------------------------------------- 下载面板

    private void showDownloadSheet() {
        if (downloader == null) {
            downloader = new Downloader(downloadDir(), settings.downloadThreads,
                new Downloader.Listener() {
                    @Override
                    public void onChange(DownloadTask task) {
                        // 底栏数字与当前列表都要刷。列表没开时只刷底栏。
                        updateDownloadBadge();
                        if (downloadSheetOpen && openSheetView != null) {
                            refreshDownloadList(openSheetView);
                        }
                    }

                    @Override
                    public void onSettled(DownloadTask task) {
                        if (task.state == DownloadTask.State.DONE && settings.downloadNotify) {
                            notifyDownloaded(task);
                        }
                        trimDownloadHistory();
                    }
                });
        }
        View sheet = openSheet(getString(R.string.sheet_downloads), R.layout.sheet_downloads);
        downloadSheetOpen = true;
        refreshDownloadList(sheet);

        sheet.findViewById(R.id.dlClear).setOnClickListener(v -> {
            if (downloader == null) return;
            int n = 0;
            for (DownloadTask t : new ArrayList<>(downloader.tasks())) {
                if (t.state == DownloadTask.State.DONE
                    || t.state == DownloadTask.State.CANCELED) {
                    downloader.remove(t);
                    n++;
                }
            }
            if (n == 0) {
                toast("没有已完成的记录");
            } else {
                refreshDownloadList(openSheetView);
                toast("已清除 " + n + " 条");
            }
        });

        sheet.findViewById(R.id.dlPaste).setOnClickListener(v -> promptDownload());
    }

    /** 粘贴地址下载。菜单里也给一条，不只能从网页点链接。 */
    private void promptDownload() {
        EditText box = new EditText(this);
        box.setHint("https://");
        box.setSingleLine(true);
        box.setTextColor(color(R.color.text));
        box.setHintTextColor(color(R.color.text_4));
        box.setBackgroundResource(R.drawable.omnibox);
        int pad = (int) (14 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, pad);
        FrameLayout wrap = new FrameLayout(this);
        wrap.setPadding(pad, pad, pad, pad);
        wrap.addView(box, new FrameLayout.LayoutParams(-1, -2));

        new NovaAlert(this, "下载链接", null)
            .custom(wrap)
            .negative("取消", null)
            .positive("下载", () -> {
                String url = box.getText().toString().trim();
                if (url.isEmpty()) return;
                if (!url.startsWith("http://") && !url.startsWith("https://")) {
                    // 用户大概率漏了协议。直接退回去让他改不如替他补上 ——
                    // 但要先说明补了什么，别让他以为原样在下载。
                    if (url.contains(".")) {
                        toast("已补上 https://");
                        url = "https://" + url;
                    } else {
                        toast("地址应以 http:// 或 https:// 开头");
                        return;
                    }
                }
                enqueueDownload(url, null);
            })
            .show();
    }

    /**
     * 没开「自动下载」时，嗅探到下载链接先问一句再动手。
     *
     * <p>判定器只能看出「这个链接像是媒体」，看不出用户想不想要它。
     * 不问就下，等于替用户决定要不要花这份流量 —— 移动网络下尤其不合适。
     * 开关开着的意思正是「我信得过判定器，别问我了」。
     */
    private void confirmDownload(String url, String name, long contentLength) {
        String shown = TextUtils.isEmpty(name) ? nameFromUrl(url) : name;
        String size = contentLength > 0 ? DownloadTask.human(contentLength) : "大小未知";
        new NovaAlert(this, "要下载这个文件吗？", shown + "\n" + size)
            .positive("下载", () -> enqueueDownload(url, name))
            .negative("取消", null)
            .show();
    }

    /**
     * 从 URL 末段取个能给人看的名字。
     *
     * <p>末尾是斜杠（如 {@code example.com/dir/}）时末段为空，那就退回整串；
     * 名字过长则截断，否则对话框会被一串网址撑到看不见按钮。
     */
    static String nameFromUrl(String url) {
        if (url == null || url.isEmpty()) return "";
        int q = url.indexOf('?');
        String s = q > 0 ? url.substring(0, q) : url;
        int slash = s.lastIndexOf('/');
        String last = slash >= 0 ? s.substring(slash + 1) : s;
        if (last.isEmpty()) last = s;
        return last.length() > 64 ? last.substring(0, 64) + "…" : last;
    }

    private void enqueueDownload(String url, String name) {
        if (downloader == null) {
            showDownloadSheet();
        }
        List<String> urls = new ArrayList<>();
        urls.add(url);
        List<String> names = new ArrayList<>();
        names.add(name);
        downloader.enqueue(urls, names);
        toast("已加入下载队列");
        if (!downloadSheetOpen) {
            mountMain();
            showDownloadSheet();
        } else {
            refreshDownloadList(openSheetView);
        }
        updateDownloadBadge();
    }

    private void refreshDownloadList(View sheet) {
        if (sheet == null || downloader == null) return;
        TextView stat = sheet.findViewById(R.id.dlStat);
        LinearLayout list = sheet.findViewById(R.id.dlList);
        if (stat == null || list == null) return;

        list.removeAllViews();
        List<DownloadTask> all = downloader.tasks();

        int running = 0, done = 0, failed = 0;
        long runningBytes = 0;
        for (DownloadTask t : all) {
            switch (t.state) {
                case RUNNING: case PROBING: case MERGING: case QUEUED:
                    running++;
                    runningBytes += t.received();
                    break;
                case DONE: done++; break;
                case FAILED: failed++; break;
                default: break;
            }
        }

        ((View) sheet.findViewById(R.id.dlEmpty))
            .setVisibility(all.isEmpty() ? View.VISIBLE : View.GONE);

        if (all.isEmpty()) {
            stat.setText("并行 " + settings.downloadThreads + " 线程"
                + (settings.downloadThreads > 1 ? "（服务器不支持分片时会自动退回单线程）" : ""));
        } else {
            stat.setText("进行中 " + running + " · 已完成 " + done + " · 失败 " + failed
                + "　已下载 " + DownloadTask.human(runningBytes));
        }

        // 新的在上：用户最关心的是刚点的那个，不是三天前的。
        List<DownloadTask> sorted = new ArrayList<>(all);
        java.util.Collections.reverse(sorted);
        for (DownloadTask t : sorted) list.addView(downloadRow(list, t));
    }

    private View downloadRow(LinearLayout parent, final DownloadTask t) {
        View row = LayoutInflater.from(this).inflate(R.layout.item_download, parent, false);
        ((TextView) row.findViewById(R.id.dlName)).setText(t.fileName);
        ((TextView) row.findViewById(R.id.dlState)).setText(t.statusLine());

        ProgressBar bar = row.findViewById(R.id.dlBar);
        int p = t.percent();
        if (p < 0) {
            // 总长未知：转成不确定态，而不是显示 0% —— 0% 看起来像卡死。
            bar.setIndeterminate(t.state == DownloadTask.State.RUNNING);
            bar.setProgress(0);
        } else {
            bar.setIndeterminate(false);
            bar.setProgress(p);
        }

        TextView primary = row.findViewById(R.id.dlPrimary);
        TextView second = row.findViewById(R.id.dlSecond);
        TextView cancel = row.findViewById(R.id.dlCancel);

        switch (t.state) {
            case RUNNING:
            case PROBING:
            case MERGING:
            case QUEUED:
                primary.setText("暂停");
                primary.setOnClickListener(v -> {
                    downloader.pause(t);
                    refreshDownloadList(openSheetView);
                });
                second.setText(t.chunks.size() > 1
                    ? t.chunks.size() + " 个分片" : "单线程");
                second.setOnClickListener(v -> {
                    // 分片信息没什么可操作的，明确告诉用户，而不是给一个死按钮。
                    toast(t.chunks.size() > 1
                        ? "共 " + t.chunks.size() + " 个分片并行下载中"
                        : "该服务器不支持分片，已用单线程下载");
                });
                cancel.setText("取消");
                cancel.setOnClickListener(v -> {
                    downloader.cancel(t);
                    refreshDownloadList(openSheetView);
                });
                break;

            case PAUSED:
            case FAILED:
                primary.setText(t.state == DownloadTask.State.FAILED ? "重试" : "继续");
                primary.setOnClickListener(v -> {
                    downloader.resume(t);
                    refreshDownloadList(openSheetView);
                });
                // 失败时第二个按钮是「复制错误」—— 出错后用户要能把它带出去问人。
                second.setText("详情");
                second.setOnClickListener(v -> new NovaAlert(this, t.fileName,
                        "状态：" + t.state.label + "\n"
                        + (t.error.isEmpty() ? "（无附加信息）" : t.error) + "\n\n"
                        + "已下载：" + DownloadTask.human(t.received()) + "\n"
                        + "总大小：" + (t.totalBytes > 0
                            ? DownloadTask.human(t.totalBytes) : "未知")
                        + "\n服务器分片支持：" + (t.rangeSupported ? "是" : "否")
                        + "\n临时分片：" + t.tempFiles().size() + " 个")
                    .positive("复制链接", () -> copyToClipboard(t.url))
                    .negative("关闭", null)
                    .show());
                cancel.setText("删除");
                cancel.setOnClickListener(v -> {
                    downloader.remove(t);
                    refreshDownloadList(openSheetView);
                });
                break;

            case DONE:
                primary.setText("打开");
                primary.setOnClickListener(v -> openDownloaded(t));
                second.setText("复制链接");
                second.setOnClickListener(v -> {
                    copyToClipboard(t.url);
                    toast("已复制");
                });
                cancel.setText("删除");
                cancel.setOnClickListener(v -> {
                    deleteDownloaded(t.fileName);
                    downloader.remove(t);
                    refreshDownloadList(openSheetView);
                });
                break;

            default:
                primary.setText("继续");
                primary.setOnClickListener(v -> {
                    downloader.resume(t);
                    refreshDownloadList(openSheetView);
                });
                second.setText("复制链接");
                second.setOnClickListener(v -> copyToClipboard(t.url));
                cancel.setText("删除");
                cancel.setOnClickListener(v -> {
                    downloader.remove(t);
                    refreshDownloadList(openSheetView);
                });
                break;
        }
        return row;
    }

    private java.io.File downloadDir() {
        // 不用 DownloadManager 的公共目录：那会要求写外部存储权限，
        // 而应用私有目录在 Android 10+ 免权限，且卸载时自动清理。
        java.io.File d = new java.io.File(getFilesDir(), "downloads");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private void openDownloaded(DownloadTask t) {
        java.io.File f = new java.io.File(downloadDir(), t.fileName);
        if (!f.exists()) {
            toast("文件已不在，可能被系统清理");
            return;
        }
        // 文件在应用私有目录，别的应用读不到。要让别的应用打开就得先拷到公共目录 ——
        // 那样需要用户授权。这里直接说明，不静默失败。
        new NovaAlert(this, "下载完成",
            "文件保存在应用私有目录（不会占用公共存储）：\n"
            + getFilesDir().getAbsolutePath() + "/downloads/\n\n"
            + "要查看或取出它，请用「复制链接」保存地址，或从下方目录用文件管理器"
            + "（需授予访问应用私有目录的权限）打开。")
            .negative("知道了", null)
            .positive("复制路径", () -> copyToClipboard(f.getAbsolutePath()))
            .show();
    }

    /** 删掉下载目录里的一个文件。名字不叫 deleteFile 是因为那会撞 Context 的同名方法。 */
    private void deleteDownloaded(String name) {
        try {
            java.io.File f = new java.io.File(downloadDir(), name);
            if (f.exists() && !f.delete()) {
                toast("删除失败，可能正被其他应用打开");
            }
        } catch (Exception ignored) {
            // 删不掉不算失败：记录已经移除了，用户看到列表里没有它就行
        }
    }

    private void notifyDownloaded(DownloadTask t) {
        try {
            android.app.NotificationManager nm =
                (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            android.app.Notification.Builder b;
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                android.app.NotificationChannel ch = new android.app.NotificationChannel(
                    "nova.download", "下载完成",
                    android.app.NotificationManager.IMPORTANCE_LOW);
                nm.createNotificationChannel(ch);
                b = new android.app.Notification.Builder(this, "nova.download");
            } else {
                b = new android.app.Notification.Builder(this);
            }
            b.setContentTitle("下载完成")
                .setContentText(t.fileName + " · " + DownloadTask.human(t.totalBytes))
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setAutoCancel(true);
            nm.notify((int) (t.id & 0x7fffffff), b.build());
        } catch (Exception ignored) {
            // 通知通道被系统关掉、或厂商 ROM 限制 —— 下载本身已经成功了，不该因此报错
        }
    }

    /** 记录条数超上限就删最旧的已结束条目。 */
    private void trimDownloadHistory() {
        if (downloader == null) return;
        List<DownloadTask> all = new ArrayList<>(downloader.tasks());
        if (all.size() <= settings.downloadHistoryMax) return;
        int excess = all.size() - settings.downloadHistoryMax;
        for (DownloadTask t : all) {
            if (excess <= 0) break;
            if (t.state.isTerminal()) {
                downloader.remove(t);
                excess--;
            }
        }
    }

    private String downloadSummary() {
        if (downloader == null) return "没有下载任务";
        int running = 0, total = downloader.tasks().size();
        for (DownloadTask t : downloader.tasks()) {
            if (!t.state.isTerminal()) running++;
        }
        if (total == 0) return "没有下载任务";
        return running > 0 ? running + " 个进行中 · 共 " + total + " 条" : "共 " + total + " 条";
    }

    private void copyToClipboard(String text) {
        try {
            android.content.ClipboardManager cm =
                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (cm != null) {
                cm.setPrimaryClip(android.content.ClipData.newPlainText("Nova", text));
            }
        } catch (Exception ignored) {
            // 部分 ROM 禁用剪贴板访问，失败就当没这回事
        }
    }

    // --------------------------------------------------------- 设置弹层

    private void showSettings() {
        View sheet = openSheet(getString(R.string.sheet_settings), R.layout.sheet_settings);

        EditText home = sheet.findViewById(R.id.setHomepage);
        home.setText(settings.homepage);
        // 失焦才存：onTextChanged 里存会把用户打的每一个中间态都写进磁盘，
        // 而且 IME 还没提交时存的是半截地址。
        home.setOnFocusChangeListener((v, hasFocus) -> {
            if (hasFocus) return;
            String v2 = home.getText().toString().trim();
            if (v2.isEmpty()) {
                home.setText(settings.homepage);
                return;
            }
            settings.homepage = v2;
            store.save(settings);
        });

        // ---- 通用
        setRow(sheet, R.id.setNewTab, "新标签页", null,
            "blank".equals(settings.newTabPage) ? "空白页" : "首页", false, false,
            () -> {
                settings.newTabPage = "blank".equals(settings.newTabPage)
                    ? "homepage" : "blank";
                store.save(settings);
                mountMain();
                showSettings();
            });

        setRow(sheet, R.id.setSearch, "搜索引擎", null,
            settings.searchTemplate().label, false, false,
            () -> pickSearchEngine());

        setRow(sheet, R.id.setTheme, "主题", "跟随系统 / 强制浅色 / 强制深色",
            themeLabel(settings.theme), false, false,
            () -> {
                String[] order = {"system", "light", "dark"};
                int i = 0;
                for (int k = 0; k < order.length; k++) {
                    if (order[k].equals(settings.theme)) i = k;
                }
                settings.theme = order[(i + 1) % order.length];
                store.save(settings);
                // 换主题必须重建 Activity：uiMode 的覆盖发生在 attachBaseContext，
                // 已经 inflate 出来的视图不会自己变色。不重建的话这一行就是假开关。
                recreate();
            });

        setRow(sheet, R.id.setUA, "User-Agent 覆写", "留空则用系统默认。改 UA 会让部分网站认不出是手机",
            settings.customUA.isEmpty() ? "默认" : "已自定义", false, true,
            () -> promptUA());

        // ---- 阅读增强
        setRow(sheet, R.id.setNoImage, "无图模式", null,
            settings.noImageLevel().label, false, true, () -> {
                mountMain();
                showReadSheet();
            });

        setRow(sheet, R.id.setAutoPage, "自动拼页", "往上滑自动接上下一页",
            "关 · 上限 " + settings.autoPageMax + " 页", false, true, () -> {
                mountMain();
                showReadSheet();
            });

        // 比无图模式更狠的一档：无图模式按网址后缀猜，这个直接让 WebView 不拉图。
        // 两条路都留着是因为它们的误伤率不同 —— 后缀猜错的图（/a/b/c）这里能拦住。
        setRow(sheet, R.id.setLoadImages, "加载图片", "关掉后所有图片都不显示，比无图模式更省流量",
            null, settings.loadImages, false, () -> {
                settings.loadImages = !settings.loadImages;
                store.save(settings);
                applyImageLoading();
                // 图片开关改完必须重载：已经拉进当前页的图不会自己消失。
                web.reload();
                mountMain();
                showSettings();
            });

        // ---- 广告拦截
        // 总开关。关掉之后下面的订阅、内置名单全部不生效，
        // 但规则本身不动 —— 再打开就恢复，不需要重新订阅。
        setRow(sheet, R.id.setAdblock, "广告拦截", "总开关。关掉后内置与订阅的规则都不生效",
            null, settings.adblockEnabled, false, () -> {
                settings.adblockEnabled = !settings.adblockEnabled;
                interceptor.setAdblockEnabled(settings.adblockEnabled);
                store.save(settings);
                web.reload();
                mountMain();
                showSettings();
            });
        setRow(sheet, R.id.setRules, "拦截规则", null, null, false, true, () -> {
            mountMain();
            showRulesSheet();
        });
        ((TextView) sheet.findViewById(R.id.setRulesSub)).setText(
            (settings.adblockEnabled ? "拦截已开启 · " : "拦截已关闭 · ")
            + (registry.hasUserRules()
                ? "订阅 " + store.rulesSourceLabel() + "（" + store.rulesStamp() + "），"
                    + "生效 " + registry.totalHosts() + " 个域名"
                : "仅内置 " + registry.adblockHosts().size() + " 个域名，"
                    + "建议订阅一份外部规则"));

        // 自动更新。间隔固定 3 天：订阅名单一般周更，3 天既能跟上节奏，
        // 又不至于每次冷启动都打一次网络。静默进行，失败不弹窗 ——
        // 用户没点它，为一个背景动作弹「更新失败」是骚扰。
        setRow(sheet, R.id.setRulesAuto, "订阅自动更新",
            "开启后每次打开应用时检查，超过 3 天没更新就自动拉一次（失败不打扰）",
            null, settings.rulesAutoUpdate, false, () -> {
                settings.rulesAutoUpdate = !settings.rulesAutoUpdate;
                store.save(settings);
                mountMain();
                showSettings();
            });

        // ---- 篡改猴（用户脚本）
        setRow(sheet, R.id.setPluginsOn, "启用篡改猴",
            "关掉后已装脚本全部停用，不用逐个卸载",
            null, settings.pluginsEnabled, false, () -> {
                settings.pluginsEnabled = !settings.pluginsEnabled;
                store.save(settings);
                mountMain();
                showSettings();
            });
        setRow(sheet, R.id.setPlugins, "篡改猴",
            "篡改猴用户脚本（.user.js）· 兼容 Tampermonkey · 非 Chrome 扩展",
            scripts.isEmpty() ? "未安装" : "已装 " + scripts.size() + " 个", false, true, () -> {
                mountMain();
                showPluginSheet();
            });
        setRow(sheet, R.id.setPluginConfirm, "安装前确认",
            "关掉之后，选中脚本文件即直接安装",
            null, settings.pluginConfirm, false, () -> {
                settings.pluginConfirm = !settings.pluginConfirm;
                store.save(settings);
                mountMain();
                showSettings();
            });

        // ---- 下载
        setRow(sheet, R.id.setThreads, "并行分片数",
            "越大越快，但占带宽；服务器不支持分片时会自动退回单线程",
            settings.downloadThreads + " 线程", false, false, () -> {
                int[] opts = {1, 2, 4, 6, 8};
                int i = 0;
                for (int k = 0; k < opts.length; k++) {
                    if (opts[k] == settings.downloadThreads) i = k;
                }
                settings.downloadThreads = opts[(i + 1) % opts.length];
                store.save(settings);
                // 线程数变了要重建执行器 —— 线程池是固定大小的，改配置不会自己变。
                if (downloader != null) {
                    downloader.shutdown();
                    downloader = null;
                }
                mountMain();
                showSettings();
            });

        setRow(sheet, R.id.setAutoDownload, "自动下载媒体",
            "开着：嗅探到的音视频直接进队列，不再询问。关着：每次先问一句再下",
            null, settings.autoDownload, false, () -> {
                settings.autoDownload = !settings.autoDownload;
                store.save(settings);
                mountMain();
                showSettings();
            });

        setRow(sheet, R.id.setDlNotify, "完成通知", null,
            null, settings.downloadNotify, false, () -> {
                settings.downloadNotify = !settings.downloadNotify;
                store.save(settings);
                mountMain();
                showSettings();
            });

        // 记录条数上限。删的是列表里的旧记录，不是磁盘上的文件 ——
        // 这一点必须写在副标题里，否则用户会以为文件被一起删了。
        setRow(sheet, R.id.setHistoryMax, "下载记录上限",
            "超出后删最旧的记录，已下载的文件不受影响",
            settings.downloadHistoryMax + " 条", false, false, () -> {
                int[] opts = {20, 50, 100, 200, 500};
                int i = 0;
                for (int k = 0; k < opts.length; k++) {
                    if (opts[k] == settings.downloadHistoryMax) i = k;
                }
                settings.downloadHistoryMax = opts[(i + 1) % opts.length];
                store.save(settings);
                mountMain();
                showSettings();
            });

        setRow(sheet, R.id.setOpenFolder, "下载目录", null,
            downloadDir().getAbsolutePath(), false, false,
            () -> copyToClipboard(downloadDir().getAbsolutePath()));

        // ---- 隐私
        setRow(sheet, R.id.setIncognito, "无痕模式", "退出时不恢复上次会话",
            null, settings.incognito, false, () -> {
                settings.incognito = !settings.incognito;
                store.save(settings);
                mountMain();
                showSettings();
            });
        setRow(sheet, R.id.setClearOnExit, "退出时清缓存", "关掉后浏览记录与 Cookie 都会留下",
            null, settings.clearOnExit, false, () -> {
                settings.clearOnExit = !settings.clearOnExit;
                store.save(settings);
                mountMain();
                showSettings();
            });
        setRow(sheet, R.id.setForceHttps, "强制 HTTPS", "把明文地址自动升级成 https",
            null, settings.forceHttps, false, () -> {
                settings.forceHttps = !settings.forceHttps;
                store.save(settings);
                mountMain();
                showSettings();
            });
        setRow(sheet, R.id.setRestore, "恢复上次会话",
            "关着：每次启动只开主页。已存的会话不清，重新打开还能接着用",
            null, settings.restoreSession, false, () -> {
                settings.restoreSession = !settings.restoreSession;
                store.save(settings);
                mountMain();
                showSettings();
            });
        setRow(sheet, R.id.setClearCache, "清除缓存", "不影响 Cookie 与下载",
            null, false, true, () -> clearCache());
        setRow(sheet, R.id.setClear, "清除全部数据",
            "设置、会话、已装脚本、订阅规则、书签全部删除", null, false, true,
            () -> new NovaAlert(this, "清除数据",
                "会清掉全部设置、会话记录、已装脚本与订阅规则，无法撤销。")
                .negative("取消", null)
                .positive("清除", () -> {
                    store.clearAll();
                    settings = new NovaSettings();
                    tabs.clear();
                    active = 0;
                    reloadRegistry();
                    scripts = new ArrayList<>();
                    mountMain();
                    restoreSession();
                    web.loadUrl(settings.homepage);
                    toast("已清除");
                })
                .show());

        // ---- 关于
        ((TextView) sheet.findViewById(R.id.setEngineNow)).setText(engineInfo());

        ((TextView) sheet.findViewById(R.id.setStat)).setText(
            "本次会话：" + interceptor.describe()
            + "　插件：" + (settings.pluginsEnabled && !scripts.isEmpty()
                ? "运行中，" + countEnabled(scripts) + " 个匹配当前页"
                : "未运行"));

        ((TextView) sheet.findViewById(R.id.setListSize)).setText(
            "资产清单：广告域名 " + registry.adblockHosts().size()
            + " 个（内置）"
            + (registry.hasUserRules() ? " + " + (registry.totalHosts()
                - registry.adblockHosts().size()) + " 个（订阅）" : "")
            + "，媒体后缀 " + registry.mediaExts().size() + " 种"
            + (registry.adblockSkipped() > 0
                ? "，另有 " + registry.adblockSkipped() + " 条带路径/选项的规则未启用" : "")
            + "\n移动版不含浏览器内核，渲染由系统内核提供；"
            + "它会随系统或 Chrome 自动更新。");

        sheet.findViewById(R.id.setAbout).setOnClickListener(v -> {
            mountMain();
            showAbout();
        });
    }

    private int countEnabled(List<UserScript.Installed> list) {
        int n = 0;
        String url = "";
        if (current() != null) url = current().url;
        for (UserScript.Installed s : list) {
            if (s.enabled && UserScript.appliesTo(s, url)) n++;
        }
        return n;
    }

    private String themeLabel(String theme) {
        if ("light".equals(theme)) return "浅色";
        if ("dark".equals(theme)) return "深色";
        return "跟随系统";
    }

    private void pickSearchEngine() {
        View sheet = openSheet(getString(R.string.sheet_search), R.layout.sheet_picker);
        LinearLayout list = sheet.findViewById(R.id.pickerList);
        ((TextView) sheet.findViewById(R.id.pickerNote)).setText(
            "地址栏里输入的东西不像网址时会交给搜索引擎。"
            + "自定义的地址里必须有 %s，它会被替换成搜索关键词。");

        NovaSettings.SearchTemplate[] all = NovaSettings.templates();
        for (final NovaSettings.SearchTemplate t : all) {
            list.addView(pickerRow(list, t.label, t.url,
                t.id.equals(settings.searchTemplateId), () -> {
                    settings.searchTemplateId = t.id;
                    store.save(settings);
                    mountMain();
                    toast("搜索引擎已改为 " + t.label);
                }));
        }

        list.addView(pickerRow(list, "自定义…",
            settings.customSearch.isEmpty() ? "未设置" : settings.customSearch,
            "custom".equals(settings.searchTemplateId), this::promptCustomSearch));
    }

    /**
     * AI 助手面板：列出常用 AI 服务商，点开在<b>新标签页</b>打开它们的网页版对话。
     *
     * <p>刻意走新标签页而不是当前页 —— 用户多半是读着某个页面想顺手问一句 AI，
     * 当前页不该被顶掉；而这一轮正好补齐了标签切换与单独关闭，切回去很方便。
     *
     * <p>这些都是各家的在线网页服务：本应用不接任何 API、不经手输入，
     * 所以没有密钥要配，也不会因为某家接口收费或改版而失效。
     * 想更深的集成（把当前页正文一起送过去）是另一件事，那需要逐家接开放接口，
     * 超出「集成常用服务商的调用」这一步。
     */
    private void showAiSheet() {
        View sheet = openSheet(getString(R.string.sheet_ai), R.layout.sheet_picker);
        LinearLayout list = sheet.findViewById(R.id.pickerList);
        ((TextView) sheet.findViewById(R.id.pickerNote)).setText(
            "点开任意一个，会在新标签页里打开它的网页版对话，当前页不会丢。"
            + "这些都是各家的在线服务，本应用不接 API、不经手你的输入。");

        final String[][] providers = {
            {"DeepSeek", "https://chat.deepseek.com/"},
            {"腾讯元宝", "https://yuanbao.tencent.com/"},
            {"豆包", "https://www.doubao.com/"},
            {"通义千问", "https://www.tongyi.com/"},
            {"Kimi", "https://kimi.moonshot.cn/"},
            {"智谱清言", "https://chatglm.cn/"},
        };
        for (final String[] p : providers) {
            list.addView(pickerRow(list, p[0], Tab.hostOf(p[1]), false, () -> {
                mountMain();
                newTab(p[1]);
                toast("正在打开 " + p[0]);
            }));
        }
    }

    /** 一行可选项：名字 + 说明 + 选中标记。搜索引擎与订阅源共用。 */
    private View pickerRow(LinearLayout parent, String name, String note,
                           boolean selected, Runnable onTap) {
        View row = LayoutInflater.from(this).inflate(R.layout.item_engine, parent, false);
        ((TextView) row.findViewById(R.id.engName)).setText(name);
        ((TextView) row.findViewById(R.id.engNature)).setText("");
        ((TextView) row.findViewById(R.id.engNote)).setText(note);

        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(color(R.color.brand));
        row.findViewById(R.id.engDot).setBackground(d);
        row.findViewById(R.id.engCheck).setVisibility(
            selected ? View.VISIBLE : View.INVISIBLE);
        row.setOnClickListener(v -> onTap.run());
        return row;
    }

    private void promptCustomSearch() {
        EditText box = new EditText(this);
        box.setHint("https://example.com/search?q=%s");
        box.setSingleLine(true);
        box.setText(settings.customSearch);
        box.setTextColor(color(R.color.text));
        box.setHintTextColor(color(R.color.text_4));
        box.setBackgroundResource(R.drawable.omnibox);
        int pad = (int) (14 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, pad);
        FrameLayout wrap = new FrameLayout(this);
        wrap.setPadding(pad, pad, pad, pad);
        wrap.addView(box, new FrameLayout.LayoutParams(-1, -2));

        new NovaAlert(this, "自定义搜索引擎",
            "地址里的 %s 会被替换成搜索关键词（自动做 URL 编码）")
            .custom(wrap)
            .negative("取消", null)
            .positive("保存", () -> {
                String v = box.getText().toString().trim();
                if (!v.isEmpty() && !v.contains("%s")) {
                    toast("地址里必须有 %s，否则关键词无处安放");
                    return;
                }
                settings.customSearch = v;
                settings.searchTemplateId = v.isEmpty() ? "baidu" : "custom";
                store.save(settings);
                mountMain();
                toast("已保存");
            })
            .show();
    }

    private void promptUA() {
        EditText box = new EditText(this);
        box.setHint("留空 = 使用系统默认");
        box.setSingleLine(true);
        box.setText(settings.customUA);
        box.setTextColor(color(R.color.text));
        box.setHintTextColor(color(R.color.text_4));
        box.setBackgroundResource(R.drawable.omnibox);
        int pad = (int) (14 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, pad);
        FrameLayout wrap = new FrameLayout(this);
        wrap.setPadding(pad, pad, pad, pad);
        wrap.addView(box, new FrameLayout.LayoutParams(-1, -2));

        new NovaAlert(this, "User-Agent",
            "把桌面版的 UA 填进来，部分只认桌面浏览器的老网站就能用了。"
            + "代价是它们会按桌面布局返回页面，在手机屏上需要缩放才能看。")
            .custom(wrap)
            .negative("取消", null)
            .positive("保存", () -> {
                settings.customUA = box.getText().toString().trim();
                store.save(settings);
                applyUserAgent();
                web.reload();
                toast(settings.customUA.isEmpty() ? "已恢复默认 UA" : "UA 已生效");
            })
            .show();
    }

    private void clearCache() {
        try {
            web.clearCache(true);
            web.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
            android.webkit.WebStorage.getInstance().deleteAllData();
            if (settings.clearOnExit) {
                android.webkit.CookieManager.getInstance().removeAllCookies(null);
            }
            toast("缓存已清除");
        } catch (Exception e) {
            toast("清除失败：" + e.getClass().getSimpleName());
        }
    }

    /**
     * 关于页。
     *
     * <p>原来是一个 NovaAlert 文字框：版本 + 三段说明挤在一屏里，「它是什么」
     * 和「它不是什么」混排，用户最关心的那句（到底有没有内核）埋在中间。
     * 现在按「身份 / 能力 / 边界 / 验证状态」四段展开，版面见 sheet_about.xml。
     *
     * <p>版本与内核版本是运行动态填的 —— 内核版本从当前 UA 里抠，
     * 写死会让这个面板在系统更新 WebView 之后开始说谎。
     */
    private void showAbout() {
        View sheet = openSheet(getString(R.string.sheet_about), R.layout.sheet_about);
        String v = webEngineVersion();
        ((TextView) sheet.findViewById(R.id.abVer)).setText(
            "版本 " + getString(R.string.app_version)
            + " · 渲染由系统内核（Chromium）提供"
            + (v.isEmpty() ? "" : " " + v));
    }

    private void menuRow(View sheet, int id, String title, Runnable onTap) {
        menuRow(sheet, id, title, null, onTap, false);
    }

    /** 带副标题、不带箭头。 */
    private void menuRow(View sheet, int id, String title, String sub, Runnable onTap) {
        menuRow(sheet, id, title, sub, onTap, false);
    }

    /**
     * 一行菜单。
     *
     * @param sub      副标题；null 或空则不占地方
     * @param arrow    有下一层才传 true。「点了直接执行」的行不显示箭头 ——
     *                 显示了会让人以为还有下一层要点，白等一次
     */
    private void menuRow(View sheet, int id, String title, String sub, Runnable onTap,
                        boolean arrow) {
        View row = sheet.findViewById(id);
        ((TextView) row.findViewById(R.id.rowTitle)).setText(title);

        TextView subView = row.findViewById(R.id.rowSub);
        if (sub == null || sub.isEmpty()) {
            subView.setVisibility(View.GONE);
        } else {
            subView.setVisibility(View.VISIBLE);
            subView.setText(sub);
        }

        row.findViewById(R.id.rowValue).setVisibility(View.GONE);
        row.findViewById(R.id.rowArrow).setVisibility(
            arrow ? View.VISIBLE : View.INVISIBLE);
        row.setOnClickListener(v -> onTap.run());
    }

    /**
     * 设置页的一行。
     *
     * @param onValue true = 开关类（右侧显示「开/关」，点了立刻生效）
     * @param arrow   true = 点了进另一个面板
     * @param sub     副标题，通常放当前值之外的说明
     */
    private void setRow(View sheet, int id, String title, String sub,
                        String currentValue, boolean onValue, boolean arrow,
                        Runnable onTap) {
        View row = sheet.findViewById(id);
        ((TextView) row.findViewById(R.id.rowTitle)).setText(title);

        TextView subView = row.findViewById(R.id.rowSub);
        if (sub == null || sub.isEmpty()) {
            subView.setVisibility(View.GONE);
        } else {
            subView.setVisibility(View.VISIBLE);
            subView.setText(sub);
        }

        TextView val = row.findViewById(R.id.rowValue);
        if (onValue) {
            val.setVisibility(View.VISIBLE);
            val.setBackgroundResource(onValue ? R.drawable.seg_on : R.drawable.seg_track);
            val.setTextColor(color(onValue ? R.color.surface : R.color.text_2));
            val.setText(onValue ? "开" : "关");
        } else if (currentValue != null && !currentValue.isEmpty()) {
            val.setVisibility(View.VISIBLE);
            val.setBackgroundResource(R.drawable.seg_track);
            val.setTextColor(color(R.color.text_2));
            val.setText(currentValue);
        } else {
            val.setVisibility(View.GONE);
        }

        row.findViewById(R.id.rowArrow).setVisibility(
            arrow ? View.VISIBLE : View.INVISIBLE);
        row.setOnClickListener(v -> onTap.run());
    }

    // --------------------------------------------------------- 标签总览

    private void showTabSheet() {
        View sheet = openSheet(getString(R.string.sheet_tabs), R.layout.sheet_tabs);

        ((TextView) sheet.findViewById(R.id.tabTotal)).setText(
            "共 " + tabs.size() + " 个标签");

        final android.widget.GridView grid = sheet.findViewById(R.id.tabGrid);

        // 先给所有标签补一张缩略图：总览里并排十几个方块，
        // 没有图的话用户只能靠标题认，而很多站点的标题是一样的。
        for (int i = 0; i < tabs.size(); i++) captureSnapshot(i);

        TabAdapter adapter = new TabAdapter();
        adapter.total = (TextView) sheet.findViewById(R.id.tabTotal);
        grid.setAdapter(adapter);
        grid.setOnItemClickListener((parent, v, position, id) -> {
            mountMain();
            switchTab(position);
        });
        grid.setOnItemLongClickListener((parent, v, position, id) -> {
            closeTab(position);
            adapter.notifyDataSetChanged();
            ((TextView) sheet.findViewById(R.id.tabTotal)).setText(
                "共 " + tabs.size() + " 个标签");
            return true;
        });

        sheet.findViewById(R.id.tabNew).setOnClickListener(v -> {
            mountMain();
            newTab(settings.homepage);
        });
    }

    private final class TabAdapter extends android.widget.BaseAdapter {
        /** 面板顶部的「共 N 个标签」，关掉一张就地更新，不用重开面板。 */
        private TextView total;

        @Override
        public int getCount() { return tabs.size(); }

        @Override
        public Object getItem(int i) { return tabs.get(i); }

        @Override
        public long getItemId(int i) { return i; }

        @Override
        public View getView(int i, View convert, ViewGroup parent) {
            View row = convert;
            if (row == null) {
                row = LayoutInflater.from(MainActivity.this)
                    .inflate(R.layout.item_tab, parent, false);
            }
            Tab t = tabs.get(i);
            ((TextView) row.findViewById(R.id.tabTitle)).setText(t.displayTitle());
            ((TextView) row.findViewById(R.id.tabHost)).setText(Tab.hostOf(t.url));
            ((ImageView) row.findViewById(R.id.tabShot)).setImageBitmap(t.snapshot);
            row.findViewById(R.id.tabShot).setVisibility(
                t.snapshot == null ? View.GONE : View.VISIBLE);
            // 当前标签用一个品牌色左边条标出来。不要只靠高亮背景：
            // 在小缩略图上，两个标签挨着时背景色的差别很难一眼看出。
            row.findViewById(R.id.tabActiveBar).setVisibility(
                i == active ? View.VISIBLE : View.INVISIBLE);

            // 单独关闭。点这张卡片的 × 只关它自己；点卡片其它地方仍是切换
            // （网格的 OnItemClickListener 管那个，× 是 clickable 子视图会吃掉自己的触摸）。
            ImageButton close = row.findViewById(R.id.tabClose);
            close.setOnClickListener(v -> {
                closeTab(i);
                notifyDataSetChanged();
                if (total != null) total.setText("共 " + tabs.size() + " 个标签");
            });
            return row;
        }
    }

    // ------------------------------------------------------------ 杂项

    private void handleShare(Intent intent) {
        // 先把分享的网址挑出来，再去恢复会话。
        // 顺序反过来会白加载一次页面：恢复完立刻被 go() 覆盖掉。
        String shared = null;
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
            shared = urlFromShare(intent);
        }
        restoreSession();
        // 分享进来的内容开一个新标签，而不是顶掉刚恢复出来的那个 ——
        // 顶掉的话，用户上次没看完的页面就少了一个。
        if (shared != null) newTab(shared);
    }

    /**
     * 从分享来的文本里挑出网址。
     *
     * <p>挑不出来（比如分享的只是一句话）就交给输入解析变成一次搜索，
     * 这样和在地址栏里敲同样一段文字的结果是一致的。
     */
    private String urlFromShare(Intent intent) {
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (TextUtils.isEmpty(text)) return null;
        // 分享文本常常是「标题 网址」两段，把第一个像网址的片段挑出来
        String[] parts = text.trim().split("\\s+");
        for (String part : parts) {
            if (part.startsWith("http://") || part.startsWith("https://")) return part;
        }
        return settings.resolveInput(text.trim());
    }

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null && urlBar != null) {
            imm.hideSoftInputFromWindow(urlBar.getWindowToken(), 0);
        }
        if (urlBar != null) urlBar.clearFocus();
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // 返回键的顺序：键盘 → 前进历史 → 退出。
        // 反了的话，用户在地址栏打了一半字按返回会直接退出应用。
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (urlBar != null && urlBar.hasFocus()) {
                urlBar.clearFocus();
                hideKeyboard();
                return true;
            }
            if (!mainViewMounted) {
                mountMain();
                return true;
            }
            if (web != null && web.canGoBack()) {
                web.goBack();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopPolling();
        captureScroll();
        captureSnapshot(active);
        // 无痕模式不留会话、也不记历史 —— 判断都在 saveSessionNow() 里。
        // 它「不做」什么比「做」什么更值得说清：真要什么都不留，
        // 还得清 Cookie 与缓存，但那样连用户自己都察觉不到代价 ——
        // 下次打开登录态、深色模式偏好全没了，这跟人们对无痕的预期并不一致。
        saveSessionNow();
    }

    @Override
    protected void onResume() {
        super.onResume();
        stopPolling();
        // 从系统文件选择器回来：装插件的结果要马上反映到界面上。
        if (mainViewMounted && openSheetView == null) {
            reloadScripts();
        }
    }

    @Override
    protected void onDestroy() {
        stopPolling();
        if (downloader != null) {
            downloader.shutdown();
            downloader = null;
        }
        if (ruleUpdater != null) {
            ruleUpdater.shutdown();
            ruleUpdater = null;
        }
        for (Tab t : tabs) t.releaseSnapshot();
        if (web != null) {
            web.stopLoading();
            web.loadUrl("about:blank");
            // 先从父容器摘掉再 destroy。不摘的话 Activity 还没走完生命周期、
            // WebView 还挂在 window 上，destroy 就会崩 —— Android 的老毛病。
            ViewGroup parent = (ViewGroup) web.getParent();
            if (parent != null) parent.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (web != null) applySurfaceTheme();
    }
}