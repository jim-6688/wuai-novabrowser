package top.wuai.nova;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.util.TypedValue;
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
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

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
    /** 推荐脚本的下载器。同样懒建 —— 只有用户点进脚本库才会用到。 */
    private ScriptInstaller scriptInstaller;
    /** 应用内自动更新。同样懒建 —— 大多数会话里用户根本不会去点它。 */
    private UpdateManager updateManager;

    // ---- 更新流程的界面状态。判断全交给 UpdateFlow，这里只存「当前是哪一档」。
    /** 正在处理的那个版本清单；为 null 表示没有更新在进行。 */
    private UpdateManager.Manifest pendingUpdate;
    /** 更新走到了哪一步。 */
    private UpdateFlow.Phase updatePhase = UpdateFlow.Phase.IDLE;
    /** 下载百分比；-1 表示总长未知。 */
    private int updatePercent = -1;
    /** 失败原因（给人看的一句话）。 */
    private String updateError = "";
    /** 已下载好的安装包，点「重启更新」时交给系统安装器。 */
    private File updateApk;
    /**
     * 用户是否手动关掉了更新条。
     *
     * <p>它只在 UpdateFlow 判定「这条可以关」时才可能为 true ——
     * 强制更新的快照里 {@code closable} 是 false，那个 × 根本不会出现，
     * 所以这个标记不可能把强制更新一起关掉。
     */
    private boolean updateDismissed;
    /** 更新条本身。每次 mountMain 都要重新取（setContentView 会重建整棵树）。 */
    private View updateBar;

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

    /** 观影/沉浸模式是否开启（隐藏顶栏底栏，只留网页）。 */
    private boolean cinemaMode;

    // --------------------------------------------------- 网页安全/资源统计

    /** 当前页加载的资源计数（网页安全/资源面板用）。主线程更新，onLoadResource 回调触发。 */
    private int resImages;
    private int resCss;
    private int resScripts;
    private int resOthers;
    /** 当前页 SSL 证书是否可信。默认 true，onReceivedSslError 置 false。 */
    private boolean pageSslOk = true;
    /** 当前页 SSL 错误信息（若有）。 */
    private String pageSslError = "";

    // ------------------------------------------------------------ 视图

    private WebView web;
    private EditText urlBar;
    private ProgressBar progress;
    private TextView statusStrip;
    private TextView noImageChip;
    /** 顶栏最左侧的应用 logo，点它打开主菜单。 */
    private View btnLogo;
    /** 五格底栏。滚动时整条淡出，位置上换成 {@link #searchCapsule}。 */
    private View mobileBar;
    /** 顶栏那一行。滚动时整行收起，把这 52dp 还给网页。 */
    private View topRow;
    /** 滚动态的胶囊搜索框。与 {@link #mobileBar} 叠在同一行里（布局里的 bottomRow）。 */
    private View searchCapsule;
    /** 胶囊搜索框里的输入框。 */
    private EditText capsuleInput;
    /** 胶囊搜索框里的放大镜图标。可点击：点它等同提交搜索（与软键盘搜索键一致）。 */
    private View capsuleSearch;
    /**
     * 地址栏点开后贴在它下面的「复制 / 分享该网站」浮层。
     *
     * <p>存成字段是为了能主动收掉 —— 它不像 {@link #openSheet} 那样有遮罩接管，
     * 页面切换、重新装界面、隐藏键盘这些时机都得手动 dismiss，
     * 否则浮层会孤零零地悬在一个已经换过的界面上。
     */
    private PopupWindow urlActions;
    /** 装着 WebView 的容器，负责下拉刷新（见 {@link RefreshHost}）。 */
    private RefreshHost refreshHost;
    /** 刷新卡死时的兜底。正常由 onPageFinished / onReceivedError 先收掉。 */
    private final Runnable refreshTimeout = this::finishPullRefresh;
    /**
     * 滚动 → 底栏/胶囊 的状态机（纯逻辑，见 {@link BottomBarReveal}）。
     * 每次重新装配主界面都 reset 一次，保证状态机与 XML 初态一致。
     */
    private final BottomBarReveal reveal = new BottomBarReveal();
    /** 上一次真正应用到界面上的状态，用来避免每个滚动帧都重复启动动画。 */
    private BottomBarReveal.State shownReveal = BottomBarReveal.State.SHOW_BAR;

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
        interceptor.setThirdPartyBlockEnabled(settings.thirdPartyBlock);

        // 内置用户脚本：首次启动装上，之后不再检查（卸载了也不会复活）。
        // 必须排在 loadScripts 之前 —— 否则第一次启动会先读到空列表，
        // 要等下次冷启动才看得到那条脚本，用户会以为内置没生效。
        BuiltinScripts.seed(store);
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
     *
     * <p>查到新版之后<b>不再问「要不要下载」</b>，直接进 {@link #beginUpdate}。
     * 为什么不做那一问，见 {@link UpdateFlow} 的类说明。
     */
    private void checkUpdate(final boolean interactive) {
        if (updateManager == null) updateManager = new UpdateManager(this);
        updateManager.check(BuildConfig.VERSION_CODE, m -> {
            if (m == null) {
                if (interactive) toast("没有查到更新信息，请检查网络后重试");
                return;
            }
            if (!m.newerThan(BuildConfig.VERSION_CODE)) {
                // 已经是最新：把上一次留下的更新条和包一起收掉。
                // 不收的话，用户装完新版回来会看到「新版本 x.y.z 已就绪」还挂在上面。
                clearUpdate();
                if (interactive) toast("已是最新版本 " + m.version);
                return;
            }
            beginUpdate(m, interactive);
        });
    }

    /**
     * 进入更新流程。
     *
     * <p>三条分支的顺序不能调换：
     * <ol>
     *   <li>同一个版本正在处理中 → 什么都不做。用户随手点一次「检查更新」，
     *       就把已经下了 80% 的包清掉重下，是最没道理的一种骚扰。</li>
     *   <li>上次已经下好（下载完但没装成，比如中途退出了应用）→ 直接进「已就绪」，
     *       不再重下一遍。用户看到的是「明明下过了，怎么又在下载」就是漏了这条。</li>
     *   <li>该下就下。只有「仅 Wi-Fi」这条设置拦着时，才停在等待态。</li>
     * </ol>
     */
    private void beginUpdate(final UpdateManager.Manifest m, boolean interactive) {
        if (pendingUpdate != null && pendingUpdate.versionCode == m.versionCode
                && updatePhase != UpdateFlow.Phase.IDLE
                && updatePhase != UpdateFlow.Phase.FAILED) {
            renderUpdate();
            return;
        }

        pendingUpdate = m;
        updateDismissed = false;
        updateError = "";
        if (updateManager == null) updateManager = new UpdateManager(this);

        File ready = updateManager.readyPackage(m);
        if (ready != null) {
            updateApk = ready;
            updatePhase = UpdateFlow.Phase.READY;
            updatePercent = 100;
            updateManager.prune(ready);
            renderUpdate();
            return;
        }

        if (!settings.updateAuto) {
            // 用户关掉了自动下载：退回「问一句再下」的老行为。
            updatePhase = UpdateFlow.Phase.IDLE;
            renderUpdate();
            showUpdateSheet(m);
            return;
        }

        if (settings.updateWifiOnly && !onWifi()) {
            updatePhase = UpdateFlow.Phase.WAITING;
            renderUpdate();
            return;
        }

        startUpdateDownload();
    }

    /** 发起下载。 */
    private void startUpdateDownload() {
        if (pendingUpdate == null) return;
        if (updateManager == null) updateManager = new UpdateManager(this);

        updatePhase = UpdateFlow.Phase.DOWNLOADING;
        updatePercent = -1;
        updateError = "";
        renderUpdate();

        // 延后 60ms 再开工。下载是同步阻塞在 IO 线程里跑的，而 renderUpdate()
        // 只是把「正在下载」这一帧交给下一帧去画 —— 立刻开工会让提示条比
        // 网络请求还晚出现，用户点完「重试」会有一小段什么都没发生的空档。
        View anchor = updateBar != null ? updateBar : findViewById(android.R.id.content);
        if (anchor != null) {
            anchor.postDelayed(this::launchUpdateFetch, 60);
        } else {
            launchUpdateFetch();
        }
    }

    private void launchUpdateFetch() {
        final UpdateManager.Manifest m = pendingUpdate;
        if (m == null || updateManager == null) return;
        updateManager.fetch(m,
            (got, total) -> {
                updatePercent = UpdateFlow.percentOf(got, total);
                renderUpdate();
            },
            (apk, error) -> {
                if (apk != null) {
                    updateApk = apk;
                    updatePhase = UpdateFlow.Phase.READY;
                    updatePercent = 100;
                    // 下好即清掉别的残包：更新目录里只该留这一个文件。
                    updateManager.prune(apk);
                } else {
                    updatePhase = UpdateFlow.Phase.FAILED;
                    updateError = error == null ? "" : error;
                }
                renderUpdate();
            });
    }

    /**
     * 把当前状态画到更新条上。
     *
     * <p>这里只做赋值：显示什么、按钮写什么、能不能关，全部由 {@link UpdateFlow}
     * 算好。一旦在这里写 if，就等于把状态判断拆到了两个地方，早晚会对不上。
     */
    private void renderUpdate() {
        if (updateBar == null) return;
        // 下载回调仍会回到主线程，但 Activity 可能已经走了。这时再碰那些 View
        // 没有意义（updateBar 指向的还是已经 detach 的旧视图），提前退出。
        if (isFinishing() || isDestroyed()) return;

        boolean mandatory = pendingUpdate != null
            && pendingUpdate.mustUpdate(BuildConfig.VERSION_CODE);
        UpdateFlow.Snapshot s = UpdateFlow.of(updatePhase,
            pendingUpdate == null ? "" : pendingUpdate.version,
            updatePercent, mandatory, updateError);

        boolean show = s.visible && !(updateDismissed && s.closable);
        updateBar.setVisibility(show ? View.VISIBLE : View.GONE);
        if (!show) {
            setUpdateGuard(false);
            return;
        }

        TextView title = updateBar.findViewById(R.id.updateTitle);
        TextView detail = updateBar.findViewById(R.id.updateDetail);
        TextView action = updateBar.findViewById(R.id.updateAction);
        ImageButton close = updateBar.findViewById(R.id.updateClose);
        ImageView icon = updateBar.findViewById(R.id.updateIcon);
        ProgressBar bar = updateBar.findViewById(R.id.updateProgress);

        title.setText(s.title);
        // 底色故意做得安静（见 bg_update_bar 的说明），所以「轻重缓急」只能靠
        // 标题与图标这两处来表达：失败和强制更新染成警示色，其余用常规色。
        title.setTextColor(color(s.warn ? R.color.danger : R.color.text));
        if (icon != null) {
            icon.setImageTintList(ColorStateList.valueOf(
                color(s.warn ? R.color.danger : R.color.brand)));
        }

        if (s.detail == null || s.detail.isEmpty()) {
            detail.setVisibility(View.GONE);
        } else {
            detail.setVisibility(View.VISIBLE);
            detail.setText(s.detail);
        }

        if (bar != null) {
            bar.setVisibility(s.progressVisible ? View.VISIBLE : View.GONE);
            if (s.progressVisible) {
                // 总长未知时给一个极小的非零值：0 和「刚要开始」看起来一模一样，
                // 而一条永远停在 0 的进度条比没有进度条更让人怀疑是不是卡死了。
                bar.setProgress(s.percent > 0 ? s.percent : 2);
            }
        }

        if (s.action == null) {
            action.setVisibility(View.GONE);
        } else {
            action.setVisibility(View.VISIBLE);
            action.setText(s.action);
            action.setOnClickListener(v -> onUpdateAction());
        }

        close.setVisibility(s.closable ? View.VISIBLE : View.GONE);
        if (s.closable) {
            close.setOnClickListener(v -> {
                updateDismissed = true;
                renderUpdate();
            });
        }

        setUpdateGuard(s.blocking);
    }

    /** 更新条上那个主按钮的唯一入口。文案与含义都由当前阶段决定。 */
    private void onUpdateAction() {
        switch (updatePhase) {
            case READY:
                if (updateManager == null) updateManager = new UpdateManager(this);
                String err = updateManager.install(updateApk);
                if (err != null) toast(err);
                break;
            case WAITING:
            case FAILED:
                // 等待态点它是「不想等 Wi-Fi 了」，失败态点它是「再来一次」，
                // 两者都是重新发起下载。
                startUpdateDownload();
                break;
            default:
                break;
        }
    }

    /**
     * 强制更新时挡住网页区。
     *
     * <p>只挡网页，不挡顶栏与底栏：地址栏还能看出当前在哪个站，还能退出应用。
     * 要拦的是「继续用旧版」，不是「把人关在这个界面里」。
     */
    private void setUpdateGuard(boolean on) {
        View guard = findViewById(R.id.updateGuard);
        if (guard == null) return;
        guard.setVisibility(on ? View.VISIBLE : View.GONE);
    }

    /**
     * 当前是否连在 Wi-Fi 上。
     *
     * <p>判断不出来时返回 true：「仅 Wi-Fi」是一省流量的偏好，不是安全边界，
     * 为它把更新卡死并不划算。
     */
    @SuppressWarnings("deprecation")
    private boolean onWifi() {
        try {
            ConnectivityManager cm =
                (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            NetworkInfo ni = cm.getActiveNetworkInfo();
            return ni != null && ni.isConnected()
                && ni.getType() == ConnectivityManager.TYPE_WIFI;
        } catch (Exception e) {
            return true;
        }
    }

    /** 收掉更新条与磁盘上的更新包。只在「确认没有更新」时才调。 */
    private void clearUpdate() {
        pendingUpdate = null;
        updateApk = null;
        updatePhase = UpdateFlow.Phase.IDLE;
        updatePercent = -1;
        updateError = "";
        updateDismissed = false;
        if (updateManager != null) updateManager.prune(null);
        renderUpdate();
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
            .positive("下载 " + m.version, () -> {
                // 这条路只在「自动下载更新」被用户关掉时才会走到（见 beginUpdate）。
                pendingUpdate = m;
                startUpdateDownload();
            })
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

        // 「复制 / 分享」那个浮层挂在旧布局的地址栏上。setContentView 之后
        // 整棵视图树被换掉，而浮层是挂在 **WindowManager** 上的，不在那棵树里 ——
        // 没人收它，它会一直悬在一个已经不存在了的地址栏下面。
        dismissUrlActions();

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
        btnLogo = findViewById(R.id.btnLogo);
        mobileBar = findViewById(R.id.mobileBar);
        topRow = findViewById(R.id.topRow);
        searchCapsule = findViewById(R.id.searchCapsule);
        capsuleInput = findViewById(R.id.capsuleInput);
        capsuleSearch = findViewById(R.id.capsuleSearch);
        refreshHost = findViewById(R.id.webHost);

        // 重新 inflate 出来的进度条是全新的：XML 没写 visibility，默认 visible、progress=0。
        // 而复用的 WebView 此刻早已加载完（空闲）—— 不把进度条复位的话，
        // 它会以「可见但 0 进度」的状态挂在那儿，刷新按钮也会被它带偏（见 setupOmnibox）。
        // 真正的加载进度由 onProgressChanged 接管，这里只需把陈旧状态清掉。
        progress.setProgress(100);
        progress.setVisibility(View.GONE);

        setupWebView();
        setupBottomBar();
        setupStarButton();
        setupTopActions();
        setupOmnibox();
        // 滚动显隐。状态机复位成「底栏可见」，与新 inflate 出来的 XML 初态对齐 ——
        // 否则从「胶囊」状态返回主界面时，界面显示的是底栏、状态机却以为是胶囊，
        // 之后要再滚一次才会发现不同步。
        //
        // 把当前真实位置一起传进去当基准：从弹层返回时页面可能已经滚过一段，
        // 若基准仍是 0，接下来的首个滚动回调会被当成「从 0 猛滚过来」而误弹胶囊
        // （reset 还会把首个样本判为「仅定基准」，见 BottomBarReveal）。
        reveal.reset(web != null ? web.getScrollY() : 0);
        shownReveal = BottomBarReveal.State.SHOW_BAR;
        setupScrollReveal();
        setupPullRefresh();
        setupLogoButton();
        syncChrome();
        syncNoImageChip();

        applySurfaceTheme();
        applyAccentTheme();

        // 更新条在新树里是一个全新的实例，必须重新取回来；顺带按当前状态重画一遍 ——
        // 否则从弹层返回时，正在下载的进度会停在进弹层前的那一帧上。
        updateBar = findViewById(R.id.updateBar);
        renderUpdate();

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
        // 渲染优先级调到高：滚动、手势、视频等重交互场景下，让 GPU 合成器
        // 优先服务 WebView，减少掉帧。代价是可能挤占同进程其他 UI 的预算，
        // 但对一个「以页面为主体」的浏览器来说这是值得的。
        s.setRenderPriority(WebSettings.RenderPriority.HIGH);
        // 混合内容：http 页面里的 https 子资源照常加载，https 页面里的 http
        // 子资源按目标 SDK 默认会被拦。打开兼容模式，老站点（大量混用协议）才不白屏。
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        // 内置新标签页走 file:///android_asset/newtab.html，这里刻意**不**去动
        // setAllowFileAccess：它从 targetSdk 31 起默认就是 false，而按官方的定义
        // 「Resources and assets are still accessible using file:///android_asset
        // and file:///android_res」—— 关掉的是**任意本地路径**，不是 assets。
        // 反过来把它打开只会让用户和页面多一条读本机文件的路，没有收益。
        // （setAllowFileAccessFromFileURLs 同样保持默认 false：这一页不做 XHR，
        // 不需要跨文件同源。）

        // 图片开关。两条都要设：只关 setLoadsImagesAutomatically，部分 WebView
        // 版本上网络图片照样会被拉回来；只设 setBlockNetworkImage 又拦不住
        // data: 和内联的图。两条一起才是真的「不显示图片」。
        applyImageLoading();

        // UA 切换：兼容层就是靠这一行实现的（换成一个老 IE 的 UA）。
        // 必须在 loadUrl 之前设置，否则第一次页面协商已经带着旧 UA 发出去了。
        applyUserAgent();

        // 字号：textZoom 设置同样在 loadUrl 之前应用。
        applyTextZoom();

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
                // 判定全在 routeUrl 里，这里只负责执行。
                //
                // 注意这个回调对 web.loadUrl(...) 同样会来一次 —— 内置新标签页是
                // 我们自己 loadUrl 进去的，所以它也会过这一关。把 file: 判成外部
                // 就等于把「新建标签页」这件事整个掐掉。
                UrlRoute route = routeUrl(req.getUrl().toString());
                if (route == UrlRoute.WEB) return false;
                if (route == UrlRoute.COMMAND) {
                    handleNovaCommand(req.getUrl().toString());
                    return true;
                }
                handToSystem(req.getUrl());
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progress.setVisibility(View.VISIBLE);
                progress.setProgress(0);
                // 更新当前主文档 host，供第三方拦截做同源比对。
                interceptor.onMainFrame(url);
                // 重置本页资源统计与 SSL 状态。
                resImages = 0; resCss = 0; resScripts = 0; resOthers = 0;
                pageSslOk = true; pageSslError = "";
                // 只更新地址栏，不动 tab.url —— 后者是「这个标签本来要去哪」，
                // 被页面内的跳转改写，会让会话恢复直接跳进广告落地页。
                syncUrlBar(url);
            }

            @Override
            public void onLoadResource(WebView view, String url) {
                // 按扩展名粗分资源类型，供「网页安全/资源面板」展示。
                String low = url == null ? "" : url.toLowerCase(java.util.Locale.ROOT);
                if (low.endsWith(".js") || low.endsWith(".mjs")) resScripts++;
                else if (low.endsWith(".css")) resCss++;
                else if (low.endsWith(".png") || low.endsWith(".jpg") || low.endsWith(".jpeg")
                    || low.endsWith(".gif") || low.endsWith(".webp") || low.endsWith(".svg")
                    || low.endsWith(".ico") || low.endsWith(".avif")) resImages++;
                else resOthers++;
            }

            @Override
            public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler,
                                           android.net.http.SslError error) {
                // 记录证书状态，但交给系统默认行为（onReceivedError 会兜底）。
                // 这里只做「记录」，不擅自 proceed 或 cancel —— 安全决策不该替用户做。
                pageSslOk = false;
                pageSslError = error == null ? "证书校验失败" : String.valueOf(error.getUrl());
                handler.cancel();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
                // 下拉刷新的球收回去。放在这里而不是 onPageStarted：那时页面刚开始加载，
                // 球一收就等于「刷完了」，而屏幕上其实还是一片白。
                finishPullRefresh();
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
                injectSelectionTools(url);
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
                    // 刷新失败也要收球。不收的话，一次拉不到页面的刷新会让它一直转，
                    // 用户唯一能做的事就是杀进程。
                    finishPullRefresh();
                    showStatus("页面加载失败：" + describeError(err));
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // 渲染进程崩了（个别站点、GPU 驱动、内存压力都可能触发）。
                // 此时这个 WebView 已不可用 —— 继续操作它只会再崩一次。
                // 正确做法是销毁旧实例、重建一个新的，再把用户正在看的页面恢复回来。
                recoverFromRenderGone(detail);
                // 返回 true 表示「这个 WebView 已经没救了，请不要再碰它」。
                // 返回 false 会让系统去做它的兜底（可能同样以崩溃收场）。
                return true;
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
            // mimetype 一定要传进去：它是最可靠的信号，也是「点 .php / 无后缀下载地址
            // 没反应」的正解。旧代码把它丢掉了，于是 /down.php?id=1 这种地址
            // 会被「页面后缀」规则直接否决，用户点了毫无反馈。
            DownloadTrigger.Verdict v = trig.judge(contentDisposition, mimetype, url, false);
            if (!v.trigger) return;
            // 服务器明说是附件时，Content-Disposition 里往往带着真实文件名
            // （`filename="report.zip"` 或 RFC 5987 的 `filename*=UTF-8''...`）。
            // 只从 URL 末段取名会拿到 `download.php` 这种没信息量的名字，
            // 所以这里先把头部里的名字解出来传给下载器；取不到再回落到 URL。
            final String name = filenameFromDisposition(contentDisposition);
            main.post(() -> {
                // 这里刻意不问：能走到这一步，说明判定器已经确认这是附件类型
                // （Content-Disposition / MIME / 后缀三者之一说了算），
                // 再问一句「要下载这个文件吗？」只是多一次点击。
                // 真正有信息量的决定点是下载面板里的暂停 / 取消 —— 文件已经在下、
                // 速度和大小都看得见的时候，用户才知道自己要不要这份流量。
                //
                // 早先这里有一层 NovaAlert 确认（settings.autoDownload 关着才问），
                // 已被去掉：那一层除了多一次点击什么也没挡住。
                enqueueDownload(url, name);
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
            }
        });
    }

    /**
     * 把地址交回系统（{@code tel:} / {@code mailto:} / {@code intent:} / {@code weixin:}）。
     *
     * <p>自己吞掉只会得到一个打不开的空白页，所以宁可交给系统去撞。
     * 撞不上（没有任何应用能处理）就什么都不做 —— 弹一个「出错了」对用户
     * 毫无帮助，他也不知道该怎么办。
     */
    private void handToSystem(android.net.Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception ignored) {
            // 没有应用能处理它。
        }
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

    /**
     * 渲染进程崩溃后的自救：销毁旧 WebView，重建一个，恢复到用户正在看的页面。
     *
     * <p>为什么不能只是 {@code reload}：渲染进程一没，这个 WebView 实例连同它的
     * native 渲染树整个失效，reload 只会再撞一次。必须走「换新实例」的路。
     *
     * <p>为什么能复用 {@code mountMain}：它本来就是「把（可能是新建的）WebView
     * 装进容器并重跑 setupWebView」的入口。这里先把 {@code web} 置空、{@code
     * webClientBound} 复位，mountMain 就会在 {@code keep == null} 分支里新建一个
     * WebView，再因为 client 标志已复位而重新挂上全新的 WebViewClient。
     *
     * <p>恢复的目标页取 {@code current().url}（标签本来要去哪），而不是临时抓
     * {@code view.getUrl()}：后者在崩溃瞬间可能已经拿不到，而标签数据是持久的。
     */
    private void recoverFromRenderGone(RenderProcessGoneDetail detail) {
        // 先把要恢复的地址记住。current() 可能为空（极端情况下标签还没建好），
        // 那就回落到内置新标签页，保证重建后不是一个白屏。
        Tab t = current();
        final String resumeUrl = (t != null && !TextUtils.isEmpty(t.url))
                ? t.url
                : newTabTarget();

        WebView gone = web;
        if (gone != null && gone.getParent() instanceof ViewGroup) {
            ((ViewGroup) gone.getParent()).removeView(gone);
        }
        if (gone != null) {
            // destroy 里会清掉内部 handler 的队列、停掉加载，尽量把 native 资源还回去。
            gone.destroy();
        }

        // 关键的两步复位：让 mountMain 走「新建」分支，让 setupWebView 重新挂 client。
        web = null;
        webClientBound = false;

        // 重新装主界面（会 new 一个 WebView 并注入），然后回到崩溃前的页面。
        mountMain();
        if (web != null) web.loadUrl(resumeUrl);

        // 给用户一个明确的、不吓人的提示：崩溃是页面/系统的问题，不是浏览器的锅。
        boolean wasInForeground = detail != null && detail.didCrash();
        toast(wasInForeground
                ? "页面渲染进程异常，已自动恢复"
                : "页面渲染进程被系统回收，已自动恢复");
    }

    // ------------------------------------------------------------ 底栏

    private interface OnTap { void tap(View v); }

    private void setupBottomBar() {
        bindMb(R.id.item_mb_back, R.drawable.ic_back, R.string.mb_back, v -> {
            if (web.canGoBack()) web.goBack();
        });
        // 主页：回家键是高频动作，放底栏比放顶栏更贴拇指动线。
        bindMb(R.id.item_mb_home, R.drawable.ic_home, R.string.mb_home, v -> goHome());
        // 刷新。
        bindMb(R.id.item_mb_reload, R.drawable.ic_reload, R.string.mb_reload, v -> {
            reloadOrStop();
        });
        // 第五格「工具箱」：弹工具面板（下载 / 篡改猴 / 广告拦截等）。
        bindMb(R.id.item_mb_tools, R.drawable.ic_tools, R.string.mb_tools, v -> showToolsSheet());

        findViewById(R.id.mbTabs).setOnClickListener(v -> showTabSheet());
    }

    /**
     * 顶栏第二行四个功能按钮：阅读模式 / 观影模式 / 翻译 / AI 助手。
     * 直接触发对应动作，不再经过「工具」面板中转。
     */
    private void setupTopActions() {
        bindTopAction(R.id.btnRead, R.drawable.ic_read, "阅读", v -> {
            mountMain();
            showReadSheet();
        });
        bindTopAction(R.id.btnMovie, R.drawable.ic_movie, "观影", v -> {
            mountMain();
            toggleCinemaMode();
        });
        bindTopAction(R.id.btnTranslate, R.drawable.ic_translate, "翻译", v -> {
            mountMain();
            translateCurrentPage();
        });
        bindTopAction(R.id.btnAi, R.drawable.ic_ai, "AI", v -> {
            mountMain();
            showAiSheet();
        });
    }

    /** 绑定顶栏功能按钮（图标 + 文字）。 */
    private void bindTopAction(int boxId, int iconRes, String text, OnTap cb) {
        View box = findViewById(boxId);
        if (box == null) return;
        ((ImageView) box.findViewById(R.id.btnIcon)).setImageResource(iconRes);
        ((TextView) box.findViewById(R.id.btnText)).setText(text);
        box.setOnClickListener(v -> cb.tap(v));
    }

    /**
     * 刷新 / 停止。判据用 WebView 自己的进度，不用进度条的可见性：
     * mountMain 每次从弹层返回都会重新 inflate 布局，新 ProgressBar 在 XML 里
     * 没写 visibility、默认是 visible，于是「空闲」也会被误判成「正在加载」，
     * 点了只会 stopLoading、什么都不发生 —— 这就是「刷新按钮无效」的根因。
     * 更早的版本还多加了一个 web.canGoBack()，那个跟「停不停」毫无关系，一并去掉。
     *
     * <p>从地址栏挪到底栏后，逻辑收进这一个方法，底栏「刷新」格直接调用。
     */
    private void reloadOrStop() {
        if (web == null) return;
        if (web.getProgress() < 100) {
            web.stopLoading();
        } else {
            web.reload();
        }
    }

    /**
     * 收藏（书签）按钮。点一下切换「当前页是否收藏」，图标在描边 / 实心之间换。
     * 状态靠当前 url 判断，所以每次页面加载完都要重算一次（见 {@link #updateStarState()}）。
     * 位置从地址栏左侧挪到了右侧，动作不变。
     */
    private void setupStarButton() {
        findViewById(R.id.btnStar).setOnClickListener(v -> toggleBookmark());
    }

    /** 切换当前页收藏状态。 */
    private void toggleBookmark() {
        if (!mainViewMounted) mountMain();
        String url = currentUrl();
        // 判断与复制 / 分享共用同一份（原先这里自己写了一份，少挡一个 data:）
        if (!hasSiteUrl(url)) {
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

    /**
     * 底栏「工具箱」格上的下载角标：有任务在跑时把图标换成下载图标。
     *
     * <p>「下载」格合并进「工具」之后，这个提醒不能丢 —— 否则任务在后台跑，
     * 界面上没有任何迹象。工具入口在底栏（带文字），有活动任务时切换图标。
     */
    private void updateDownloadBadge() {
        View box = findViewById(R.id.item_mb_tools);
        if (box == null) return;
        ImageView tools = box.findViewById(R.id.btnIcon);
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
        // 有任务在跑时换成下载图标，一眼看出「有个东西还在动，点进去看看」。
        tools.setImageResource(active_ > 0 ? R.drawable.ic_download : R.drawable.ic_tools);
    }

    private void bindMb(int boxId, int iconRes, int textRes, OnTap cb) {
        View box = findViewById(boxId);
        ((ImageView) box.findViewById(R.id.btnIcon)).setImageResource(iconRes);
        ((TextView) box.findViewById(R.id.btnText)).setText(textRes);
        box.setOnClickListener(v -> cb.tap(v));
    }

    /**
     * 网页滚动时切换「顶栏 / 底栏」。
     *
     * <p>判断本身全在 {@link BottomBarReveal} 里（纯逻辑，可单测），这里只负责
     * 把状态变化翻译成动画。刻意只在<b>状态真正变化</b>时才调 {@code applyReveal}：
     * onScrollChange 一秒里会来很多帧，每帧都启动一次 ViewPropertyAnimator
     * 会把动画队列冲乱，表现就是底栏抖个不停。
     *
     * <p>WebView 是复用的同一个实例，所以这里重复 set listener 也不会有多份
     * —— set 是覆盖语义，跟 add 不一样。
     */
    private void setupScrollReveal() {
        if (web == null) return;
        web.setOnScrollChangeListener((v, scrollX, scrollY, oldScrollX, oldScrollY) -> {
            BottomBarReveal.State s = reveal.onScroll(scrollY);
            if (s != shownReveal) {
                shownReveal = s;
                applyReveal(s, true);
            }
        });

        if (capsuleInput != null) {
            capsuleInput.setOnEditorActionListener((v, actionId, event) -> {
                boolean submit = actionId == EditorInfo.IME_ACTION_SEARCH
                    || actionId == EditorInfo.IME_ACTION_GO
                    || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                        && event.getAction() == KeyEvent.ACTION_DOWN);
                if (!submit) return false;
                submitCapsule();
                return true;
            });
        }
        // 放大镜图标同样能提交：软键盘的搜索键不是每个用户都找得到（有的输入法把它
        // 收进二级菜单），点图标和敲搜索键走同一条 submitCapsule，行为完全一致。
        if (capsuleSearch != null) {
            capsuleSearch.setOnClickListener(v -> submitCapsule());
        }
    }

    /**
     * 提交胶囊搜索框里的内容。两条入口（软键盘搜索键 / 放大镜图标）共用，
     * 保证「点搜索」和「敲回车」永远走同一段逻辑，不会出现一边能搜一边没反应。
     */
    private void submitCapsule() {
        if (capsuleInput == null) return;
        String q = capsuleInput.getText().toString().trim();
        if (q.isEmpty()) return;
        hideKeyboard();
        // 从别的状态进来时先保证主界面装着，再跳转；已经在主界面就直接 go。
        if (!mainViewMounted) mountMain();
        navSearch(q);
        capsuleInput.setText("");
        // 跳完把底栏恢复常态：别让用户落在一个「只有搜索框、没有底栏」的界面。
        // 用当前位置作基准，并让首个滚动回调只定基准、不判定，避免跳转瞬间误弹。
        reveal.reset(web != null ? web.getScrollY() : 0);
        if (shownReveal != BottomBarReveal.State.SHOW_BAR) {
            shownReveal = BottomBarReveal.State.SHOW_BAR;
            applyReveal(BottomBarReveal.State.SHOW_BAR, true);
        }
    }

    /**
     * 统一的「搜索」跳转：内置主页的搜索框、下滑胶囊的搜索框，都走这里。
     * 复用地址栏同一条 resolveInput：像网址就直接跳（最快），不像网址就交给
     * 用户选中的内置搜索引擎（默认百度）。不写死 52ta 导航 —— 那会绕开用户
     * 对搜索引擎的选择，也丢掉了「网址直跳」这条更快的路。
     */
    private void navSearch(String q) {
        go(settings.resolveInput(q));
    }

    /**
     * 把状态落到界面。一次切换里上下各发生一件事：
     *
     * <ul>
     *   <li><b>顶栏</b>：滚动时整行收起（{@code topRow} 置 {@link View#GONE}），
     *       把这 52dp 还给网页。它是整行进出，不做交叉淡入淡出 ——
     *       收起的目的就是把高度让出去，若只是把内容变透明，那一条空白
     *       照样横在网页上面，等于没让。</li>
     *   <li><b>底栏</b>：五格与胶囊搜索框叠在同一行（布局里的 {@code bottomRow}，
     *       行高恒定 54dp）里交叉淡入淡出。滚动时五格向下滑出、胶囊从下沿滑进来。
     *       两套内容互相覆盖，行高不变，所以网页不会被推一下。</li>
     * </ul>
     *
     * @param s       目标状态
     * @param animate 是否播放 300ms 动画；装配阶段不需要动画
     */
    private void applyReveal(BottomBarReveal.State s, boolean animate) {
        final View bar = mobileBar;
        final View cap = searchCapsule;
        final View top = topRow;
        if (bar == null || cap == null || top == null) return;
        boolean showBar = s == BottomBarReveal.State.SHOW_BAR;
        int duration = animate ? 300 : 0;
        // 高度拿不到（还没 layout）时用布局里写死的尺寸兜底，否则位移量会是 0，
        // 动画看起来就像没动。54dp 对应 bottomRow（底栏那一行）。
        float density = getResources().getDisplayMetrics().density;
        int barH = bar.getHeight() > 0 ? bar.getHeight() : Math.round(54 * density);

        if (showBar) {
            // 顶栏整行回来。它上一轮是被 GONE 掉的，这里没有 alpha 可播 —— 直接出现。
            top.setVisibility(View.VISIBLE);
            // 胶囊向下滑出行外。位移取的是整个「行高」而不是它自己的高度：
            // 它要从本行下沿出去，只移自身高度的话会卡在行里露一条边。
            cap.animate().alpha(0f).translationY(barH).setDuration(duration)
                .withEndAction(() -> settleReveal(cap, View.GONE,
                    BottomBarReveal.State.SHOW_BAR))
                .start();
            // 五格从下方滑回来
            bar.setVisibility(View.VISIBLE);
            bar.setTranslationY(barH);
            bar.animate().alpha(1f).translationY(0f).setDuration(duration).start();
        } else {
            // 顶栏整行收起，把这一行的高度让给网页
            top.setVisibility(View.GONE);
            cap.setVisibility(View.VISIBLE);
            // 先摆到行外，再滑进来。少了这一步，第一帧它已经在终点上，
            // 看起来是「啪」一下出现，而不是滑进来。
            cap.setTranslationY(barH);
            cap.animate().alpha(1f).translationY(0f).setDuration(duration).start();
            bar.animate().alpha(0f).translationY(barH).setDuration(duration)
                .withEndAction(() -> settleReveal(bar, View.GONE,
                    BottomBarReveal.State.SHOW_CAPSULE))
                .start();
        }
    }

    /**
     * 动画收尾：把淡出的那一套真正藏起来。
     *
     * <p>收尾前必须复核一次状态。这 300ms 里页面可能已经被拉回顶部，
     * 状态也翻回了 {@code SHOW_BAR} —— 照着老目标收尾的话，就会把刚滑回来的五格
     * 又藏起来、而胶囊也被另一条动画藏起来，底栏那一行空成一片。
     * 这不是理论问题：动画的结束回调不保证在状态翻转之前跑完。
     *
     * @param v        要藏的那个 View
     * @param hideAs   {@link View#GONE} 或 {@link View#INVISIBLE}
     * @param expected 只有当前状态仍是它，才动手
     */
    private void settleReveal(View v, int hideAs, BottomBarReveal.State expected) {
        if (shownReveal != expected) return;
        v.setVisibility(hideAs);
        if (hideAs == View.GONE) v.setTranslationY(0f);
    }

    /**
     * 下拉刷新。
     *
     * <p>判定在 {@link PullToRefresh}、触摸拦截在 {@link RefreshHost}，
     * 这里只回答两件事：页面在不在顶部，以及「刷新」具体做什么。
     */
    private void setupPullRefresh() {
        if (refreshHost == null) return;
        refreshHost.setPage(new RefreshHost.Page() {
            @Override
            public boolean atTop() {
                // scrollY 可能是负数（过卷的回弹），所以判 <= 0 而不是 == 0。
                return web == null || web.getScrollY() <= 0;
            }

            @Override
            public void refresh() {
                if (web == null) return;
                web.reload();
                // 兜底。有些站点会一直挂着不停加载（长轮询、广告轮播），
                // onPageFinished 迟迟不来，球就会一直转下去 ——
                // 一个永远转着的刷新指示器，看起来就是浏览器卡死了。
                main.removeCallbacks(refreshTimeout);
                main.postDelayed(refreshTimeout, 15000);
            }
        });
    }

    /**
     * 收尾一次下拉刷新。页面加载完、加载失败、等超时，三条路都汇到这里。
     *
     * <p>先判 {@code isRefreshing()} 再动：这三条路之间会互相抢先
     * （超时先到、页面随后才加载完就必然会踩一次），
     * 不判的话第二次收尾会把已经收好的球再收一遍，白播一次动画。
     */
    private void finishPullRefresh() {
        main.removeCallbacks(refreshTimeout);
        if (refreshHost == null || !refreshHost.isRefreshing()) return;
        refreshHost.finishRefresh();
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
         * 刷新 / 停止按钮已从地址栏挪到底栏（item_mb_reload），
         * 逻辑收进 {@link #reloadOrStop()} 供底栏那格复用。这里不再绑 btnReload。
         */

        /*
         * 点开地址栏：全选 + 弹出「复制 / 分享该网站」。
         *
         * 全选交给 XML 的 selectAllOnFocus —— 用代码在这里再 selectAll() 一次
         * 是重复的，而且顺序上会跟 syncUrlBar 里那句 setSelection(length) 打架。
         * 这里只管浮层。
         *
         * 用 focus 变化而不是 onClick：EditText 每次被点击都会回调 onClick
         * （包括已经聚焦时再点），那样用户想挪一下光标就会被反复弹一次浮层；
         * 而「没焦点 → 有焦点」这一跳，正好等于「用户要开始输网址了」。
         */
        urlBar.setOnFocusChangeListener((v, hasFocus) -> {
            if (hasFocus) {
                showUrlActions();
            } else {
                dismissUrlActions();
            }
        });

        /*
         * 一开始打字就收掉浮层。它挡着地址栏下面那条，而用户已经在输地址了，
         * 两个按钮此刻只会碍事。
         *
         * 用 TextWatcher 而不是 onKeyListener：中文输入法下按键事件大多拿不到
         * （走的是组合文本），而 setText 这类改动又根本不产生按键事件。
         */
        urlBar.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable s) {
                if (urlActions != null && urlActions.isShowing()) dismissUrlActions();
            }
        });
    }

    /**
     * 弹出「复制 / 分享该网站」。
     *
     * <p>锚在地址栏那一格的 FrameLayout 上，不是里面的 EditText：
     * EditText 自带 padding 与光标，拿它当锚点，浮层会偏出去几个 dp。
     *
     * <p>{@code setInputMethodMode(INPUT_METHOD_NOT_NEEDED)} 是关键 ——
     * 不设的话 PopupWindow 会自认为也要一个输入法，点开地址栏后
     * 它和软键盘会互相顶位置，浮层在键盘弹起的一瞬间被顶到屏幕外。
     */
    private void showUrlActions() {
        if (!mainViewMounted) return;
        View anchor = findViewById(R.id.omniboxWrap);
        if (anchor == null) return;
        if (urlActions != null && urlActions.isShowing()) return;

        View box = LayoutInflater.from(this).inflate(R.layout.pop_url_actions, null);
        box.findViewById(R.id.urlActCopy).setOnClickListener(v -> {
            dismissUrlActions();
            copyCurrentUrl();
        });
        box.findViewById(R.id.urlActShare).setOnClickListener(v -> {
            dismissUrlActions();
            shareCurrentUrl();
        });

        PopupWindow pop = new PopupWindow(box,
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, true);
        /*
         * 背景必须给一个**非 null** 的 drawable，哪怕是全透明的：
         * PopupWindow 拿它来判断「点击发生在窗体之外」，为 null 时
         * setOutsideTouchable(true) 形同虚设，浮层只能靠按钮收掉。
         */
        pop.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        pop.setOutsideTouchable(true);
        pop.setInputMethodMode(PopupWindow.INPUT_METHOD_NOT_NEEDED);
        pop.setElevation(dp(8));
        pop.showAsDropDown(anchor, 0, dp(6));
        urlActions = pop;
    }

    private void dismissUrlActions() {
        if (urlActions == null) return;
        if (urlActions.isShowing()) urlActions.dismiss();
        urlActions = null;
    }

    /**
     * 复制当前页面的网址。
     *
     * <p>复制的是 {@link #currentUrl()} 而不是地址栏里的文本：地址栏刚被全选过，
     * 用户还没改，两者本应一致；而停在内置新标签页上时地址栏是空的（显示的是
     * 提示语），照抄地址栏会复制出一个空串。
     */
    private void copyCurrentUrl() {
        String url = shareableUrl();
        if (url == null) {
            toast(getString(R.string.url_no_site));
            return;
        }
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) return;
        cm.setPrimaryClip(ClipData.newPlainText("url", url));
        toast(getString(R.string.url_copied));
    }

    /** 分享当前网站。分享的是网址，不是选中的文字。 */
    private void shareCurrentUrl() {
        String url = shareableUrl();
        if (url == null) {
            toast(getString(R.string.url_no_site));
            return;
        }
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, url);
        String title = (web != null && web.getTitle() != null) ? web.getTitle() : "";
        if (!title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
        startActivity(Intent.createChooser(send, getString(R.string.url_share_title)));
    }

    /**
     * 当前可分享的网址；没有则返回 null。
     *
     * <p>返回 null 由调用方给一句提示，而不是静默：按钮点了没反应，
     * 用户只会以为按钮坏了。
     */
    private String shareableUrl() {
        String url = currentUrl();
        return hasSiteUrl(url) ? url : null;
    }

    /**
     * 这一页有没有一个「真实的网站地址」可用。
     *
     * <p>内置新标签页（{@code file:///android_asset/…}）、空白页（about:blank）、
     * javascript: 与 data: 一律算没有 —— 收藏它们回不到有内容的那一页，
     * 复制或分享给别人也打不开。
     *
     * <p>抽成静态方法是因为它有<b>三个</b>调用点（收藏 / 复制 / 分享）。
     * 原先收藏那儿自己写了一份判断，比这里少一个 data: ——
     * 同一件事写两遍，早晚会分叉，而分叉的那一刻没有任何东西会报错。
     *
     * <p>大小写不敏感：scheme 按 RFC 是不区分大小写的，而 WebView 回吐的
     * URL 大小写并不保证。
     */
    static boolean hasSiteUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        String u = url.toLowerCase(Locale.ROOT);
        return !(u.startsWith("file:") || u.startsWith("about:")
            || u.startsWith("javascript:") || u.startsWith("data:"));
    }

    /** dp 转 px。PopupWindow 的偏移只认像素。 */
    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
            getResources().getDisplayMetrics()));
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
        // 已经导航走了，浮层说的还是上一页的地址。这里必须收 ——
        // 点「首页」这一类按钮不会让地址栏失焦，浮层自己不会消失。
        dismissUrlActions();
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

    /**
     * 一个地址该由谁处理。
     *
     * <p>抽成枚举是因为这条判定曾经写死在 {@code shouldOverrideUrlLoading} 的
     * if 链里，而那个位置没法被测：它一判错，用户点「新建标签页」会静静停在
     * 上一个页面，日志里一行都没有。判定的三种去向各写成一个名字，
     * 单测就能把「内置页面不许被送走」这件事钉住。
     */
    public enum UrlRoute {
        /** WebView 自己加载：http(s)、以及 {@code file:} / {@code about:} 这类本机内容。 */
        WEB,
        /** 内置新标签页回传的 {@code nova://shortcut/…} 命令，交给 {@code handleNovaCommand}。 */
        COMMAND,
        /**
         * 交回系统。{@code tel:} / {@code mailto:} / {@code intent:} / {@code weixin:}
         * 这些自己吞掉只会得到一个打不开的空白页。
         */
        EXTERNAL
    }

    /**
     * 非 http(s) 的地址该去哪。
     *
     * <p><b>{@code file:} 为什么算 {@link UrlRoute#WEB}</b>：内置新标签页的真身就是
     * 一条 {@code file:///android_asset/newtab.html?theme=…&data=…}。它若是被当成
     * 外部地址递给系统，系统里没有能打开它的组件（{@code /android_asset} 不是真实
     * 路径，别的 app 也读不到本 app 的 assets），异常被吞掉、回调返回 true，
     * WebView 于是什么都不加载 —— 表现就是「新建标签页打开的是上一个页面」。
     *
     * <p>{@code about:blank} 同理：「新标签页 → 空白页」那一档也是这么丢的。
     *
     * <p>其余未知 scheme 一律 {@link UrlRoute#EXTERNAL}：宁可交给系统去撞，
     * 也不要在一个自己不了解的协议上假装能渲染。
     */
    static UrlRoute routeUrl(String url) {
        if (url == null) return UrlRoute.WEB;
        String s = url.trim();
        if (s.isEmpty()) return UrlRoute.WEB;
        int colon = s.indexOf(':');
        if (colon <= 0) return UrlRoute.WEB;
        String scheme = s.substring(0, colon).toLowerCase(java.util.Locale.ROOT);
        if ("http".equals(scheme) || "https".equals(scheme)) return UrlRoute.WEB;
        if ("nova".equals(scheme)) return UrlRoute.COMMAND;
        if ("file".equals(scheme) || "about".equals(scheme)) return UrlRoute.WEB;
        return UrlRoute.EXTERNAL;
    }

    private void syncUrlBar(String url) {
        if (urlBar.hasFocus()) return;
        if (NewTab.isNewTab(url)) {
            // 内置新标签页的真身是一条 file:///android_asset/newtab.html?theme=…&data=…
            // 的地址，又长又吓人（像是踩进了本机哪个文件），显示成「新标签页」。
            //
            // 走 hint 而不是 text：写成 text 的话，用户点亮地址栏直接敲回车，
            // 敲出去的就是「新标签页」四个字，会被当成搜索词送给搜索引擎。
            // 空 text + hint 则与初始状态一致，用户看到的就是一个待输入的框。
            urlBar.setText("");
            urlBar.setHint(R.string.omnibox_new_tab);
            return;
        }
        urlBar.setText(url == null ? "" : url);
        urlBar.setHint(R.string.omnibox_hint);
        urlBar.setSelection(urlBar.getText().length());
    }

    // ------------------------------------------------------------ 标签

    private Tab current() {
        return active >= 0 && active < tabs.size() ? tabs.get(active) : null;
    }

    // -------------------------------------------------------- 内置新标签页

    /**
     * 新标签页该去哪。
     *
     * <p>设置页里的「新标签页」三态切换已移除（用户要「启动进主页、
     * 点新建进内置新标签页」的固定行为），这里统一返回内置新标签页。
     * 保留 {@code settings.newTabPage} 字段不动（老配置仍能读回），
     * 但新建动作不再询问它。
     */
    private String newTabTarget() {
        return ntpUrl();
    }

    /** 开一个新标签（用户主动新建）。目标完全由设置决定，不需要解析输入。 */
    private void openNewTab() {
        newTab(newTabTarget());
    }

    /**
     * 拼内置新标签页的地址：把「用户自己加的」和「历史里的常去站点」一起编码进 URL。
     *
     * <p>页面那边只负责排序与呈现，候选得由这边算 —— 因为历史记录和
     * 「已移除」清单都躺在原生这边，页面拿不到。
     *
     * <p>自己加的排在前面并且打上 {@code pinned}：页面按「固定项在前、
     * 其余按访问次数降序」排，用户明确加过的东西不该被访问次数挤下去。
     */
    private String ntpUrl() {
        List<NewTab.Row> rows = new ArrayList<>(store.ntpAdded());
        Set<String> blocked = store.ntpRemoved();
        // 去重按主机名，和页面上那条规则一致：zhihu.com 的历史里可能有几十条
        // 不同的问题页，不去重的话七个格子会被同一家占满。
        Set<String> seen = new HashSet<>();
        for (NewTab.Row r : rows) seen.add(NewTab.hostKey(r.url));

        for (HistoryStore.Entry e : store.history()) {
            if (!HistoryStore.recordable(e.url)) continue;
            String key = NewTab.hostKey(e.url);
            if (key.isEmpty() || blocked.contains(key) || !seen.add(key)) continue;
            rows.add(new NewTab.Row(NewTab.labelOf(e.title, e.url), e.url, e.visits, false));
        }
        return NewTab.pageUrl(themeName(), NewTab.candidates(rows));
    }

    /**
     * 页面要去用什么色。把「跟随系统」解析成当下真正的深浅色再传过去。
     *
     * <p>判据是 Activity 自己的 {@code uiMode}，而不是系统设置：用户可能在
     * 设置里强制了浅色，那时系统是深色但地址栏、底栏都是浅的 ——
     * 页面要是跟着系统走，就会出现「白色页面配浅色边框」这种半截深色。
     * 页面上那份 {@code prefers-color-scheme} 兜底同理靠不住。
     */
    private String themeName() {
        int ui = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        boolean systemNight = ui == Configuration.UI_MODE_NIGHT_YES;
        // 复用 attachBaseContext 那一套判断，不另写一份：那支管的是「界面是什么色」，
        // 这里要的是同一个答案，写两份迟早出现「地址栏深色、页面浅色」。
        return nightOn(settings.theme, systemNight) ? "dark" : "light";
    }

    /**
     * 处理页面回传的 {@code nova://shortcut/…} 动作。
     *
     * <p>落盘之后必须**重新加载页面**：快捷方式那一屏是渲染时算好的，
     * 不重载的话用户点了 × 屏幕上什么都没少，看起来就是「这个按钮坏了」。
     */
    private void handleNovaCommand(String url) {
        // 划词命令：nova://sel?q=…
        if (url != null && url.startsWith("nova://sel")) {
            handleSelectionCommand(url);
            return;
        }
        NewTab.Cmd cmd = NewTab.parse(url);
        if (cmd == null) return;
        if (NewTab.OP_ADD.equals(cmd.op)) {
            store.ntpAdd(cmd.get("label"), cmd.get("url"));
            toast(getString(R.string.ntp_added));
        } else if (NewTab.OP_REMOVE.equals(cmd.op)) {
            // 没真改动（这家本来就不在候选里）就不用重载 —— 否则一次误触
            // 会让页面白闪一下
            if (!store.ntpRemove(cmd.get("url"))) return;
        } else if (NewTab.OP_SEARCH.equals(cmd.op)) {
            // 内置主页的搜索框回传。与下滑胶囊共用同一个搜索目标（navSearch），
            // 保证两处「搜索」跳的是同一个链接，不会一边搜 52ta 一边搜别的。
            String q = cmd.get("q").trim();
            if (q.isEmpty()) return;
            navSearch(q);
            return;
        } else {
            return;
        }
        reloadNewTab();
    }

    /**
     * 划词命令：{@code nova://sel?q=…}。弹「搜索 / 翻译」选择，用户点哪个走哪个。
     *
     * <p>两者都开新标签，当前页不丢。搜索走内置搜索引擎；翻译走有道网页翻译
     * （国内可用、免密钥）。
     */
    private void handleSelectionCommand(String url) {
        try {
            android.net.Uri u = android.net.Uri.parse(url);
            String q = u.getQueryParameter("q");
            if (q == null || q.trim().isEmpty()) return;
            final String text = q.trim();
            if (text.length() > 120) {
                // 太长的选中文字大概率是误触（整段、整页），截断到 120 字。
                // 截断是为了让对话框标题可读，也避免误触整页。
            }
            final String display = text.length() > 30 ? text.substring(0, 30) + "…" : text;

            new android.app.AlertDialog.Builder(this)
                .setTitle("「" + display + "」")
                .setItems(new String[]{"搜索", "翻译"}, (d, which) -> {
                    if (which == 0) {
                        newTab(settings.resolveInput(text));
                    } else {
                        newTab("https://fanyi.youdao.com/#/TextTranslate");
                        toast("已打开有道翻译，把选中文字粘进去即可");
                    }
                })
                .setNegativeButton("取消", null)
                .show();
        } catch (Exception ignored) {
            // 命令格式不对就静默忽略，绝不影响页面。
        }
    }
    private void reloadNewTab() {
        Tab t = current();
        if (t == null || !NewTab.isNewTab(t.url)) return;
        String url = ntpUrl();
        t.url = url;
        if (web != null) web.loadUrl(url);
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
            // 关掉最后一个之后补上来的这一张，语义上就是「新标签页」，
            // 该按设置来 —— 刚清空所有标签的用户看到的应该是新标签页，
            // 而不是被塞回首页。
            tabs.add(new Tab(newTabTarget()));
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

    /**
     * 按<b>对象引用</b>关标签。
     *
     * <p>为什么不直接用位置下标：标签总览是一个 {@code GridView}，它会复用 item 视图。
     * 视图的 {@code OnClickListener} 只能捕获「绑定时那一刻的下标」，而一次关闭之后
     * 后面的下标会整体前移；在「点 × 就地 notifyDataSetChanged」这种边改边刷的场景里，
     * 那个捕获到的下标就不再指向用户刚点的那张卡 —— 于是可能关错项，甚至连锁误关。
     * 改成捕获 {@link Tab} 对象本身、关的时候再按引用重新定位，位置怎么漂移都只会关这一张。
     *
     * <p>找不到（已经被别的路径关掉了）就直接返回：让「重复点同一个 ×」变成无害的。
     */
    private void closeTabByRef(Tab ref) {
        int idx = indexOfTabRef(tabs, ref);
        if (idx < 0) return;
        closeTab(idx);
    }

    /**
     * 按引用找下标，找不到返回 -1。
     *
     * <p>抽成静态纯函数是为了能单测 —— 这段「按引用定位」的逻辑正是这次修复的核心，
     * 而它在真机上要靠 GridView 复用才会暴露，写单测才能钉住。
     *
     * <p>用 {@code ==} 而不是 {@code equals}：这里要的是「同一张卡的同一个对象」，
     * 而不是「两个内容相等的标签」。将来 {@code Tab} 就算重写了 {@code equals}，
     * 这里也不会因为「两个空白主页标签相等」而关错。
     */
    static int indexOfTabRef(List<Tab> list, Tab ref) {
        if (list == null || ref == null) return -1;
        for (int i = 0; i < list.size(); i++) {
            if (list.get(i) == ref) return i;
        }
        return -1;
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
            // 启动首屏 = 主页，不是「新标签页」：用户打开 App 想看到的是
            // 自己设的主页（默认 52ta.top 导航），内置新标签页只在「点新建标签页」时出现。
            // 这里若用 newTabTarget() 会把启动和新建两个入口混成一个。
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
        // 必须判空：关闭标签是在「标签总览」弹层开着的时候发生的，而那时
        // setContentView 换掉的是弹层根布局，里面根本没有 mbTabCount。
        // 不判空的话 closeTab 末尾这一行会 NPE —— 表现是「点一下 × 应用闪退」，
        // 而且 tabs.remove 已经执行过了，界面和状态从此对不上。
        TextView count = findViewById(R.id.mbTabCount);
        if (count != null) count.setText(String.valueOf(tabs.size()));
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

    /**
     * 划词搜索 / 翻译：注入一段自包含脚本，监听用户选中文字。
     *
     * <p>移动端长按选词会触发 {@code selectionchange} 与 {@code touchend}，
     * 脚本在用户「选中了一段文字且抬手」时，把选中内容通过
     * {@code location.href = 'nova://sel?q=…'} 回传。
     * 这个跳转会被 {@link #shouldOverrideUrlLoading} 拦下（COMMAND 分支返回 true），
     * 页面本身不会真的离开 —— 由 {@link #handleSelectionCommand} 弹出
     * 「搜索 / 翻译」选择。
     *
     * <p>脚本刻意做成幂等：每页只注入一次（用 window 标志位防重复），
     * 且只对 http/https 页面注入，file:// 的内置页不注入（没有可划的词）。
     * 选中文字少于 2 个字符不触发，避免长按链接时误判。
     */
    private void injectSelectionTools(String url) {
        if (url == null) return;
        if (!url.startsWith("http://") && !url.startsWith("https://")) return;
        String js = "(function(){"
            + "if(window.__novaSel)return;window.__novaSel=true;"
            + "var go=function(q){"
            + "  if(!q||q.length>500||q.length<2)return;"
            + "  try{location.href='nova://sel?q='+encodeURIComponent(q);}catch(e){}"
            + "};"
            + "var read=function(){"
            + "  var s=window.getSelection?window.getSelection().toString():'';"
            + "  if(s&&s.trim())return s.trim();return '';"
            + "};"
            + "var last='';"
            + "document.addEventListener('touchend',function(){"
            + "  setTimeout(function(){"
            + "    var s=read();"
            + "    if(s&&s!==last){last=s;go(s);}"
            + "  },250);"
            + "},true);"
            + "})();";
        web.evaluateJavascript(js, null);
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
        // 自定义 UA 优先于一切 —— 它是用户明确要的，压过任何预设。
        if (!settings.customUA.trim().isEmpty()) {
            s.setUserAgentString(settings.customUA.trim());
            return;
        }
        String system = getSystemDefaultUA();
        if ("desktop".equals(settings.layout)) {
            // 电脑版 UA：取系统默认 UA 里的真实 Chrome 版本号，套一个桌面 Chrome 模板。
            // 不写死版本 —— WebView 实际跑的就是那个版本，写死会造成「UA 说 80、内核是 100」的错位。
            s.setUserAgentString(desktopUA(system));
            return;
        }
        // mobile / auto 都是手机 UA（系统默认），auto 在移动端没有「按窗口宽度」一说，
        // 一律等同手机。
        String cur = s.getUserAgentString();
        if (!system.isEmpty() && !system.equals(cur)) {
            s.setUserAgentString(system);
        }
    }

    /**
     * 由系统默认（手机）UA 构造一个桌面 Chrome UA。
     *
     * <p>做法是「借版本号、换平台标识」：从 {@code Chrome/x.y.z} 抠出版本号，
     * 拼进桌面模板 {@code Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
     * (KHTML, like Gecko) Chrome/x.y.z Safari/537.36}。桌面 UA 不含 {@code Mobile}、
     * {@code wv}、{@code Android}，站点据此返回桌面布局。
     */
    private String desktopUA(String systemUA) {
        String chrome = "";
        int i = systemUA.indexOf("Chrome/");
        if (i >= 0) {
            int j = i + 7;
            while (j < systemUA.length()) {
                char c = systemUA.charAt(j);
                if (!(Character.isDigit(c) || c == '.')) break;
                j++;
            }
            chrome = systemUA.substring(i + 7, j);
        }
        if (chrome.isEmpty()) chrome = "120.0.0.0";
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/" + chrome + " Safari/537.36";
    }

    /**
     * 把字号设置落到 WebView。textZoom 100 = 不变，50–200 范围（在 fromMap 里已夹）。
     */
    private void applyTextZoom() {
        if (web == null) return;
        web.getSettings().setTextZoom(settings.textZoom);
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

    /**
     * 顶栏最左侧的应用 logo：点它打开主菜单。
     *
     * <p>这个位置原先是「圆点 + CR」的内核标识。移动版没有内核可选，那个标识
     * 既没信息量（用户看不懂「CR」）也没得点，纯占位。换成 logo 后既补了品牌感，
     * 又给了顶栏一个真实的入口 —— 和底栏的「菜单」格指向同一个 {@link #showMenuSheet()}。
     */
    private void setupLogoButton() {
        btnLogo.setOnClickListener(v -> showMenuSheet());
    }

    private int color(int res) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) return getColor(res);
        return getResources().getColor(res);
    }

    /**
     * 下载状态色阶到颜色令牌。
     *
     * <p>集中在一处取值，是为了「同一个状态在列表里和统计里是同一个颜色」——
     * 分两处写的话，改了一处忘了另一处，界面就会自相矛盾。
     */
    private int toneColor(DownloadUi.Tone tone) {
        switch (tone) {
            case BRAND:  return color(R.color.brand);
            case OK:     return color(R.color.ok);
            case WARN:   return color(R.color.warn);
            case DANGER: return color(R.color.danger);
            default:     return color(R.color.text_3);
        }
    }

    /** 深浅色下给网页区换个底色，否则夜间模式会留一条刺眼的白边。 */
    private void applySurfaceTheme() {
        boolean night = (getResources().getConfiguration().uiMode
            & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        web.setBackgroundColor(color(night ? R.color.surface_dark : R.color.surface));
    }

    /**
     * 主题配色：把「品牌主色」染到最显眼的几处。
     *
     * <p>主题切换只改色相、不改结构，所以这里不重建 Activity，只在装配时把
     * 当前主题的三原色刷到界面上。要染的是「用户一眼看得到的品牌色」：
     * 状态栏、底栏主按钮、胶囊搜索框描边、进度条。
     *
     * <p>XML 里那批 {@code @color/brand} 静态引用（图标、分段选中态等）保持默认蓝，
     * 不逐一重染 —— 那些是「次级品牌色」，色相差一点用户感知很弱，逐一换反而
     * 容易漏。真正的「这套主题是什么颜色」，由状态栏 + 主按钮 + 胶囊描边说了算。
     */
    private void applyAccentTheme() {
        ThemeCatalog.Theme t = ThemeCatalog.byId(settings.accentTheme);
        int brand = t.brand;
        int strong = t.brandStrong;
        int accent = t.accent;

        // 状态栏 / 导航栏：主色铺底。浅色主题下状态栏文字用深色，深色用浅色。
        boolean night = (getResources().getConfiguration().uiMode
            & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(brand);
            getWindow().setNavigationBarColor(brand);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                int flags = getWindow().getDecorView().getSystemUiVisibility();
                // 状态栏文字反色与否，跟着深浅走，不跟着主色走。
                if (night) {
                    flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                } else {
                    flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                }
                getWindow().getDecorView().setSystemUiVisibility(flags);
            }
        }

        // 底栏主按钮（标签数）：蓝绿渐变 → 当前主题的「主色→强调色」渐变。
        View tabs = findViewById(R.id.mbTabs);
        if (tabs != null) {
            GradientDrawable g = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[]{brand, accent});
            g.setCornerRadius(dp(12));
            tabs.setBackground(g);
        }

        // 胶囊搜索框描边：换成当前主色。
        if (searchCapsule != null) {
            GradientDrawable cap = new GradientDrawable();
            cap.setShape(GradientDrawable.RECTANGLE);
            cap.setCornerRadius(dp(18));
            cap.setColor(color(R.color.surface_translucent));
            cap.setStroke(1, brand);
            searchCapsule.setBackground(cap);
        }

        // 进度条 tint 换成主色。
        if (progress != null) {
            progress.setProgressTintList(
                android.content.res.ColorStateList.valueOf(brand));
        }
    }

    /** dp → px，主题渐变圆角用。 */
    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
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

        // ---- 浏览：导航与拦截。只放「去哪」与「看什么」，加工能力都进「工具」。
        menuRow(sheet, R.id.menuHome, R.drawable.ic_home, "首页", "回到首页",
            () -> goHome(), false);
        menuRow(sheet, R.id.menuBookmarks, R.drawable.ic_bookmark, "书签",
            store.bookmarks().isEmpty() ? "未收藏"
                : "已收藏 " + store.bookmarks().size() + " 条", () -> {
            mountMain();
            showBookmarksSheet();
        }, true);
        // 无痕模式下副标题直接说明「不记录」。不写的话，用户开了无痕、
        // 进来发现历史停在几天前，只会以为这个功能坏了。
        menuRow(sheet, R.id.menuHistory, R.drawable.ic_history, getString(R.string.sheet_history),
            settings.incognito ? "无痕模式不记录"
                : (store.history().isEmpty() ? "无记录"
                    : "最近 " + store.history().size() + " 条"), () -> {
            mountMain();
            showHistorySheet();
        }, true);

        // ---- 工具：对网页的加工能力（下载 / 阅读 / 篡改猴 / 广告拦截），
        // 收敛成「工具」一个入口，不再在这里逐项平铺 —— 那是「毛坯房」的来源之一。
        menuRow(sheet, R.id.menuTools, R.drawable.ic_tools, "工具",
            "下载 / 阅读 / 篡改猴 / 广告拦截", () -> {
            mountMain();
            showToolsSheet();
        }, true);

        // ---- 应用
        menuRow(sheet, R.id.menuUpdate, R.drawable.ic_update, "检查更新",
            "当前 " + getString(R.string.app_version),
            () -> checkUpdate(true), false);
        menuRow(sheet, R.id.menuSettings, R.drawable.ic_settings, "设置", null, () -> {
            mountMain();
            showSettings();
        }, true);
        menuRow(sheet, R.id.menuAbout, R.drawable.ic_about, "关于", null, () -> {
            mountMain();
            showAbout();
        }, true);
        menuRow(sheet, R.id.menuExit, R.drawable.ic_exit, "退出", null, () -> {
            finishAffinity();
        }, false);

        ((TextView) sheet.findViewById(R.id.aboutVer))
            .setText("吾爱Nova浏览器 " + getString(R.string.app_version));
    }

    /**
     * 工具栏面板：原来底栏的「下载」「阅读」两格合并到这里。
     *
     * <p>两行的动作都先 {@link #mountMain()} 再开对应面板 —— 与主菜单里那两行的写法
     * 完全一致。不先装主界面的话，「从工具面板直接跳到下载面板」时当前 content view
     * 还是旧面板，新面板的 {@code setContentView} 会把它顶掉，而 WebView 仍被搬来搬去，
     * 容易在返回时白屏（原因见 mountMain 的注释）。
     */
    private void showToolsSheet() {
        View sheet = openSheet(getString(R.string.sheet_tools), R.layout.sheet_tools);

        // 副标题直接用 downloadSummary()，和主菜单里的下载入口保持一致：
        // 同一件事的说明文字只有一个来源，改一处两边都变。
        menuRow(sheet, R.id.toolDownloads, R.drawable.ic_download, "下载",
            downloadSummary(), () -> {
            mountMain();
            showDownloadSheet();
        }, true);
        menuRow(sheet, R.id.toolRead, R.drawable.ic_read, "阅读模式",
            "无图模式 / 自动拼页", () -> {
            mountMain();
            showReadSheet();
        }, true);
        menuRow(sheet, R.id.toolTranslate, R.drawable.ic_translate, "翻译网页",
            "打开有道翻译（国内可用）", () -> {
            mountMain();
            translateCurrentPage();
        }, false);
        menuRow(sheet, R.id.toolMovie, R.drawable.ic_movie, "观影模式",
            "隐藏工具栏 · 沉浸全屏", () -> {
            mountMain();
            toggleCinemaMode();
        }, false);
        menuRow(sheet, R.id.toolAi, R.drawable.ic_ai, "AI 助手",
            "DeepSeek / 元宝 / 豆包 / Kimi 等在线对话", () -> {
            mountMain();
            showAiSheet();
        }, true);
        menuRow(sheet, R.id.toolPlugins, R.drawable.ic_plugin, "篡改猴",
            scripts.isEmpty() ? "未安装" : "已装 " + scripts.size() + " 个", () -> {
            mountMain();
            showPluginSheet();
        }, true);
        menuRow(sheet, R.id.toolAdblock, R.drawable.ic_shield, "广告拦截",
            registry.hasUserRules()
                ? "已订阅 · " + registry.totalHosts() + " 个域名"
                : "内置 " + registry.adblockHosts().size() + " 个域名", () -> {
            mountMain();
            showRulesSheet();
        }, true);
        menuRow(sheet, R.id.toolSiteInfo, R.drawable.ic_settings, "网页安全",
            "当前页资源 / 证书 / 拦截情报", () -> {
            mountMain();
            showSiteInfoSheet();
        }, true);
    }

    /**
     * 网页安全 / 资源面板。只读展示当前页的技术情报，不发任何网络请求。
     */
    private void showSiteInfoSheet() {
        View sheet = openSheet(getString(R.string.sheet_siteinfo), R.layout.sheet_siteinfo);

        String url = currentUrl();
        String host = Tab.hostOf(url);
        boolean https = url != null && url.startsWith("https://");

        ((TextView) sheet.findViewById(R.id.siHost)).setText(
            host.isEmpty() ? "（无站点）" : host);
        ((TextView) sheet.findViewById(R.id.siUrl)).setText(url);

        // SSL 状态徽章。
        TextView badge = sheet.findViewById(R.id.siSslBadge);
        TextView sslText = sheet.findViewById(R.id.siSslText);
        if (https && pageSslOk) {
            badge.setText("https");
            badge.setBackgroundResource(R.drawable.seg_on);
            badge.setTextColor(color(R.color.surface));
            sslText.setText("连接已加密，证书有效");
        } else if (https && !pageSslOk) {
            badge.setText("警告");
            badge.setBackgroundResource(R.drawable.bar_warn);
            badge.setTextColor(color(R.color.text));
            sslText.setText("证书校验失败：" + pageSslError);
        } else {
            badge.setText("http");
            badge.setBackgroundResource(R.drawable.seg_track);
            badge.setTextColor(color(R.color.text_2));
            sslText.setText("明文连接，未加密");
        }

        // 资源统计。
        ((TextView) sheet.findViewById(R.id.siScripts)).setText("脚本 " + resScripts);
        ((TextView) sheet.findViewById(R.id.siCss)).setText("样式 " + resCss);
        ((TextView) sheet.findViewById(R.id.siImages)).setText("图片 " + resImages);
        ((TextView) sheet.findViewById(R.id.siOthers)).setText("其他 " + resOthers);

        // 拦截统计。
        StringBuilder sb = new StringBuilder();
        sb.append("广告请求：").append(interceptor.blockedHosts()).append("\n");
        sb.append("第三方请求：").append(interceptor.blockedThirdParty()).append("\n");
        sb.append("省下图片：").append(interceptor.blockedImages()).append("\n");
        sb.append("媒体资源：").append(interceptor.blockedMedia());
        ((TextView) sheet.findViewById(R.id.siBlocked)).setText(sb.toString());
    }

    /**
     * 翻译网页：新标签打开有道翻译（国内可用、免翻墙、无需密钥）。
     *
     * <p>有道翻译网页版不支持像 Google 那样用 {@code ?u=} 直达整页翻译，
     * 用户需要把网址粘进有道的输入框。这里直接打开有道翻译首页并给出提示，
     * 是最稳的「零开发、国内可用」落地。当前页不丢（新标签打开）。
     */
    private void translateCurrentPage() {
        String url = currentUrl();
        if (!hasSiteUrl(url)) {
            toast("当前页面无法翻译");
            return;
        }
        newTab("https://fanyi.youdao.com/");
        toast("已打开有道翻译，把网址粘进去即可整页翻译");
    }

    /**
     * 观影 / 沉浸模式：隐藏顶栏和底栏，只留网页本身。
     *
     * <p>进入后靠「点网页任意位置」或系统返回键恢复 —— 这里做一个简单的开关：
     * 再次点工具里的「观影模式」即退出。为避免和滚动显隐状态机打架，
     * 这里直接 GONE 掉顶栏（topRow）和底栏那一行（bottomRow），
     * 退出时 mountMain 重新装一遍主界面，状态自然复位。
     */
    private void toggleCinemaMode() {
        cinemaMode = !cinemaMode;
        if (cinemaMode) {
            View top = topRow;
            View bottom = findViewById(R.id.bottomRow);
            if (top != null) top.setVisibility(View.GONE);
            if (bottom != null) bottom.setVisibility(View.GONE);
            toast("已进入观影模式，点工具→观影模式退出");
        } else {
            mountMain();
        }
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
            + "声明了会在装上后明确标出。\n"
            + "随包内置一条口碑最好的脚本（网页限制解除），用不上可以停用或卸载 ——"
            + "卸载后不会再自己回来。");

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

        sheet.findViewById(R.id.plCatalog).setOnClickListener(v -> showCatalogSheet());
        sheet.findViewById(R.id.plInstall).setOnClickListener(v -> pickScriptFile());
    }

    // ---------------------------------------------------------- 推荐脚本库

    /**
     * 推荐脚本库：清单随包内置，但<b>一条都不装</b>，用户点哪条才装哪条。
     *
     * <p>与插件面板分成两级，是因为两件事的语义不同 —— 那个面板答的是
     * 「我已经装了什么」，这里答的是「我可以装什么」。挤进同一个列表的话，
     * 「已装」和「可装」会混在一起，用户分不清哪些已经在页面上跑着了。
     */
    private void showCatalogSheet() {
        View sheet = openSheet("推荐脚本", R.layout.sheet_catalog);

        ((TextView) sheet.findViewById(R.id.ctNotice)).setText(
            "这些脚本不在安装包里，选了哪条才去 Greasy Fork 下哪条 —— "
            + "第三方脚本的许可各不相同，只提供地址就不涉及随包分发的问题，"
            + "安装包也不会变大。\n"
            + "「已确认」= 它的 @grant 声明已人工核对过，本引擎能跑；"
            + "「未确认」不是不能用，是还没核对过 —— 安装时仍会逐项检测，"
            + "把它要的权限摆出来给你看。");

        LinearLayout list = sheet.findViewById(R.id.ctList);
        list.removeAllViews();

        Set<String> installed = installedCatalogKeys();
        float d = getResources().getDisplayMetrics().density;
        int p4 = (int) (4 * d), p6 = (int) (6 * d), p10 = (int) (10 * d);

        for (ScriptCatalog.Category c : ScriptCatalog.Category.values()) {
            List<ScriptCatalog.Item> items = ScriptCatalog.of(c);
            if (items.isEmpty()) continue;

            TextView head = new TextView(this);
            head.setText(c.label);
            head.setTextSize(12f);
            head.setTextColor(color(R.color.text_3));
            head.setPadding(p4, p10, 0, p6);
            list.addView(head);

            for (ScriptCatalog.Item item : items) {
                list.addView(catalogRow(list, item, installed.contains(item.key)));
            }
        }
    }

    /**
     * 清单里哪些条目已经装过了。
     *
     * <p>靠<b>安装来源</b>反查，而不是拿脚本名去比 —— 名字是作者随时会改的东西，
     * 改一次这个判断就失效，表现是「装过了却还显示可安装」，点下去装出第二份。
     */
    private Set<String> installedCatalogKeys() {
        Set<String> out = new HashSet<>();
        for (UserScript.Installed s : store.loadScripts()) {
            ScriptCatalog.Item item = ScriptCatalog.fromOrigin(s.origin);
            if (item != null) out.add(item.key);
        }
        return out;
    }

    private View catalogRow(LinearLayout parent, final ScriptCatalog.Item item,
                            final boolean installed) {
        View row = LayoutInflater.from(this).inflate(R.layout.item_catalog, parent, false);
        ((TextView) row.findViewById(R.id.ctName)).setText(item.name);
        ((TextView) row.findViewById(R.id.ctCredit)).setText(item.credit());
        ((TextView) row.findViewById(R.id.ctDesc)).setText(item.desc);

        // 「未确认」不能画得像「推荐」—— 用中性色，与「已确认」的强调色分开。
        TextView badge = row.findViewById(R.id.ctBadge);
        badge.setText(item.verified ? "已确认" : "未确认");
        badge.setTextColor(color(item.verified ? R.color.accent : R.color.text_3));

        TextView caution = row.findViewById(R.id.ctCaution);
        if (item.caution.isEmpty()) {
            caution.setVisibility(View.GONE);
        } else {
            caution.setVisibility(View.VISIBLE);
            caution.setText("注意：" + item.caution);
        }

        TextView action = row.findViewById(R.id.ctAction);
        if (installed) {
            action.setText("已安装");
            action.setEnabled(false);
            action.setAlpha(0.45f);
        } else {
            action.setOnClickListener(v -> installFromCatalog(item));
        }
        return row;
    }

    /**
     * 装一条推荐脚本。
     *
     * <p>下载是异步的。取回来的第一件事<b>不是</b>写库，而是把能力检测的结果
     * 摆给用户看 —— {@link UserScript#parse} 会读出脚本真实的 {@code @grant}，
     * 那是清单里「未确认」三个字变成确定事实的时刻。用户点了确认才落盘。
     */
    private void installFromCatalog(final ScriptCatalog.Item item) {
        if (scriptInstaller == null) scriptInstaller = new ScriptInstaller();
        toast("正在获取「" + item.name + "」…");

        scriptInstaller.fetch(item, r -> {
            if (!r.ok || r.pending == null) {
                new NovaAlert(this, "没能安装", r.message)
                    .positive("知道了", null).show();
                return;
            }

            UserScript.Installed inst = r.pending;
            StringBuilder msg = new StringBuilder();
            msg.append("匹配：").append(String.join("、", inst.meta.match));
            msg.append("\n\n").append(inst.meta.summary());
            if (r.headless) {
                msg.append("\n\n⚠ 它没有 ==UserScript== 元数据头，"
                    + "会被当成「所有网站都运行」。");
            }
            if (!r.grants.isEmpty()) {
                msg.append("\n\n⚠ 它声明了本引擎不提供的权限：")
                    .append(String.join("、", r.grants))
                    .append("。依赖这些权限的功能不会生效，其余部分照常。");
            }
            msg.append("\n\n来源：").append(r.origin);

            new NovaAlert(this, "安装「" + inst.displayName() + "」", msg.toString())
                .negative("取消", null)
                .positive("安装", () -> {
                    if (!store.saveScript(inst)) {
                        toast("写入失败，可能是存储空间不足");
                        return;
                    }
                    mountMain();
                    showCatalogSheet();
                    toast("已安装 " + inst.displayName());
                })
                .show();
        });
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

        // 内置的那几条要标出来：它是浏览器替用户装上的，而用户从没做过这个决定，
        // 列表里就得看得出哪些不是自己装的，否则清理时会把自己的和内置的混在一起删。
        BuiltinScripts.Item builtin = BuiltinScripts.itemOf(s.id, store);
        TextView badge = row.findViewById(R.id.plBadge);
        if (builtin != null) {
            badge.setVisibility(View.VISIBLE);
            badge.setText(R.string.plugin_builtin);
        }

        StringBuilder m = new StringBuilder();
        if (builtin != null) m.append(builtin.credit).append('\n');
        m.append("适用：");
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

    /**
     * 刷新下载面板。
     *
     * <p>列表按「进行中 / 已结束」分成两组、各自一张卡片。旧版是一条条平铺，
     * 已完成的文件会把还在跑的那条挤到看不见的地方 —— 而这个面板最要紧的信息
     * 恰恰是「还在跑的那条到哪了」。
     */
    private void refreshDownloadList(View sheet) {
        if (sheet == null || downloader == null) return;
        LinearLayout runningList = sheet.findViewById(R.id.dlRunningList);
        LinearLayout doneList = sheet.findViewById(R.id.dlDoneList);
        if (runningList == null || doneList == null) return;

        List<DownloadTask> all = downloader.tasks();

        int running = 0, done = 0, failed = 0;
        List<DownloadTask> active = new ArrayList<>();
        List<DownloadTask> settled = new ArrayList<>();
        for (DownloadTask t : all) {
            if (!t.state.isTerminal()) {
                running++;
                active.add(t);
            } else {
                settled.add(t);
                // 「取消」不计入失败：那是用户自己点的，标成红的会让人以为出了问题。
                if (t.state == DownloadTask.State.DONE) done++;
                else if (t.state == DownloadTask.State.FAILED) failed++;
            }
        }

        setStatText(sheet, R.id.dlStatRunning, running);
        setStatText(sheet, R.id.dlStatDone, done);
        setStatText(sheet, R.id.dlStatFailed, failed);

        // 引擎卡上的线程数来自设置，不写死在布局里 —— 写死就会和设置页对不上。
        TextView engPill = sheet.findViewById(R.id.dlEngPill);
        if (engPill != null) engPill.setText(settings.downloadThreads + " 线程");

        View empty = sheet.findViewById(R.id.dlEmpty);
        if (empty != null) empty.setVisibility(all.isEmpty() ? View.VISIBLE : View.GONE);

        // 新的在上：用户最关心的是刚点的那个，不是三天前的。
        java.util.Collections.reverse(active);
        java.util.Collections.reverse(settled);
        fillDownloadGroup(sheet, R.id.dlGroupRunning, R.id.dlRunningList, "进行中", active);
        fillDownloadGroup(sheet, R.id.dlGroupDone, R.id.dlDoneList, "已结束", settled);
    }

    /** 统计格里的数字。取不到就什么都不做，不让一处布局改动把整块界面拖崩。 */
    private void setStatText(View root, int id, int value) {
        TextView v = root.findViewById(id);
        if (v != null) v.setText(String.valueOf(value));
    }

    /**
     * 把一组任务填进它的卡片，并同步分组标题。
     *
     * <p>空组整块隐藏（标题 + 卡片），而不是留一个「进行中（0）」的空框 ——
     * 一张空的带边框卡片看起来像加载失败。
     */
    private void fillDownloadGroup(View sheet, int labelId, int listId,
                                   String name, List<DownloadTask> tasks) {
        TextView label = sheet.findViewById(labelId);
        LinearLayout list = sheet.findViewById(listId);
        if (label == null || list == null) return;

        list.removeAllViews();
        boolean has = !tasks.isEmpty();
        label.setVisibility(has ? View.VISIBLE : View.GONE);
        list.setVisibility(has ? View.VISIBLE : View.GONE);
        if (!has) return;

        label.setText(name + "（" + tasks.size() + "）");
        for (DownloadTask t : tasks) list.addView(downloadRow(list, t));

        // 最后一行不画分隔线。用 INVISIBLE 而不是 GONE：GONE 会让最后一行贴着
        // 卡片的圆角收尾，看着像被切掉一块；INVISIBLE 保留那 13dp 的底部留白。
        View last = list.getChildAt(list.getChildCount() - 1);
        View divider = last == null ? null : last.findViewById(R.id.dlDivider);
        if (divider != null) divider.setVisibility(View.INVISIBLE);
    }

    /**
     * 一条任务行。
     *
     * <p>该显示什么、该是什么颜色，全部问 {@link DownloadUi}；这里只负责把结果搬进视图。
     * 判定留在那个纯逻辑类里，才能在本地 JVM 上单测 —— 界面代码是测不了的。
     */
    private View downloadRow(LinearLayout parent, final DownloadTask t) {
        View row = LayoutInflater.from(this).inflate(R.layout.item_download, parent, false);

        ((TextView) row.findViewById(R.id.dlName)).setText(t.fileName);

        // 状态胶囊：文字与描边同色。bg_pill 是「透明填充 + 描边」，
        // tint 会把两者一起染色，而透明的填充乘完仍是透明，所以只有描边显色。
        TextView pill = row.findViewById(R.id.dlPill);
        int tone = toneColor(DownloadUi.tone(t));
        pill.setText(DownloadUi.pill(t));
        pill.setTextColor(tone);
        pill.setBackgroundTintList(ColorStateList.valueOf(tone));

        ((SegmentedProgressBar) row.findViewById(R.id.dlBar))
            .setSegments(DownloadUi.segments(t));

        // 三段元信息。已完成的任务不再报连接数（对已经落盘的文件没意义），
        // 换成「存在哪」—— 那才是用户接下来要关心的地方。
        ((TextView) row.findViewById(R.id.dlMeta1)).setText(DownloadUi.progress(t));
        ((TextView) row.findViewById(R.id.dlMeta2)).setText(
            t.state == DownloadTask.State.DONE
                ? DownloadUi.location(t) : DownloadUi.connections(t));
        ((TextView) row.findViewById(R.id.dlMeta3)).setText(
            historyTime(t.createdAt, System.currentTimeMillis()));

        TextView note = row.findViewById(R.id.dlNote);
        if (t.state == DownloadTask.State.FAILED) {
            note.setVisibility(View.VISIBLE);
            note.setText(TextUtils.isEmpty(t.error) ? "下载失败，未拿到具体原因" : t.error);
        } else {
            note.setVisibility(View.GONE);
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
                second.setText("详情");
                second.setOnClickListener(v -> showDownloadDetail(t));
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
                second.setText("详情");
                second.setOnClickListener(v -> showDownloadDetail(t));
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

    /**
     * 任务详情。
     *
     * <p>三种状态下都给同一个入口，不再只在失败时才有：正在下载的任务里，
     * 「服务端到底认不认 Range」是用户唯一能自己解释「为什么这么慢」的线索。
     */
    private void showDownloadDetail(final DownloadTask t) {
        new NovaAlert(this, t.fileName,
                "状态：" + t.state.label + "\n"
                + (t.error.isEmpty() ? "（无附加信息）" : t.error) + "\n\n"
                + "已下载：" + DownloadTask.human(t.received()) + "\n"
                + "总大小：" + (t.totalBytes > 0
                    ? DownloadTask.human(t.totalBytes) : "未知")
                + "\n服务器分片支持：" + (t.rangeSupported ? "是" : "否")
                + "\n连接数：" + t.chunks.size() + "\n"
                + "临时分片：" + t.tempFiles().size() + " 个")
            .positive("复制链接", () -> copyToClipboard(t.url))
            .negative("关闭", null)
            .show();
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

        setRow(sheet, R.id.setAccent, "主题配色", "默认蓝 / 青绿 / 粉紫 / 暖橙 / 纯黑",
            accentLabel(), false, true,
            () -> pickAccent());

        setRow(sheet, R.id.setUA, "网页标识（UA）", "自动 = 手机版；电脑版适合只认桌面浏览器的老网站",
            uaLabel(), false, true,
            () -> pickUA());

        setRow(sheet, R.id.setFont, "网页字号", "放大或缩小网页文字",
            textZoomLabel(), false, true,
            () -> pickTextZoom());

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
        setRow(sheet, R.id.setThirdParty, "第三方脚本拦截",
            "严格隐私：拦下一切非同源脚本、跟踪像素与第三方资源，可能影响部分页面加载",
            null, settings.thirdPartyBlock, false, () -> {
                settings.thirdPartyBlock = !settings.thirdPartyBlock;
                interceptor.setThirdPartyBlockEnabled(settings.thirdPartyBlock);
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

        // 副标题里的「关着先问一句」已经不成立了：下载前的确认框被去掉了，
        // 嗅探到的链接一律直接进队列（理由见 setDownloadListener 里那句注释）。
        // 这一格暂时留着占位 —— 它现在不再参与判定，等产品定了「还要不要这一档」
        // 再决定是删掉还是换个说法。
        setRow(sheet, R.id.setAutoDownload, "自动下载媒体",
            "嗅探到的音视频直接进入队列，不再弹框询问；可在下载面板里暂停或取消",
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
                    // restoreSession 在这里只有一条路可走：会话刚被 clearAll 抹掉、
                    // tabs 也清空了，它必然走「开一张新标签」那一支并把地址装进去。
                    // 原先后面还跟一句 loadUrl(settings.homepage)，等于把刚装好的
                    // 新标签页立刻顶掉 —— 清除数据之后落到了首页，与新标签页设置无关。
                    restoreSession();
                    toast("已清除");
                })
                .show());

        // ---- 应用更新
        setRow(sheet, R.id.setUpdateAuto, "自动下载更新",
            "开着：发现新版直接后台下载，下完只提示「重启更新」；关着：每次先问一句再下",
            null, settings.updateAuto, false, () -> {
                settings.updateAuto = !settings.updateAuto;
                store.save(settings);
                mountMain();
                showSettings();
                // 从「手动」切成「自动」：如果刚才已经查到了新版却没下，现在就该下。
                // 少了这一步，用户打开开关后会以为「它怎么还是没动」。
                if (settings.updateAuto && pendingUpdate != null
                        && updatePhase == UpdateFlow.Phase.IDLE) {
                    beginUpdate(pendingUpdate, false);
                }
            });

        setRow(sheet, R.id.setUpdateWifi, "仅在 Wi-Fi 下下载更新",
            "更新包只有几 MB，但一个用户没主动要的下载不该吃掉移动流量",
            null, settings.updateWifiOnly, false, () -> {
                settings.updateWifiOnly = !settings.updateWifiOnly;
                store.save(settings);
                mountMain();
                showSettings();
                // 正在等 Wi-Fi 时把这个开关关掉，就该立刻开始下 ——
                // 否则用户盯着「等待 Wi-Fi」的提示条，怎么点开关它都不动。
                if (!settings.updateWifiOnly && updatePhase == UpdateFlow.Phase.WAITING) {
                    startUpdateDownload();
                }
            });

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

    /** 「新标签页」三种取值的显示名。认不出一律当「内置」—— 那是默认值。 */
    private String ntpLabel(String mode) {
        if ("blank".equals(mode)) return getString(R.string.ntp_blank);
        if ("homepage".equals(mode)) return getString(R.string.ntp_homepage);
        return getString(R.string.ntp_start);
    }

    /**
     * 三态轮换：内置 → 首页 → 空白 → 内置。
     *
     * <p>「内置」放第一个不只是因为它现在是默认值 —— 轮换是从当前值往后转，
     * 一进来点一下就到「首页」，而绝大多数人的预期正是「新标签页 = 首页」，
     * 转两下才到空白页。顺序反过来的话，最常用的那个反而要多点一次。
     *
     * <p>抽成静态纯函数是为了能单测（见 MainActivityTest）：轮换成环这件事
     * 最容易写成「有一档永远出不来」，而那种 bug 在真机上要点好几下才发现。
     */
    static String nextNtpMode(String mode) {
        if ("start".equals(mode)) return "homepage";
        if ("homepage".equals(mode)) return "blank";
        return "start";
    }

    private String themeLabel(String theme) {
        if ("light".equals(theme)) return "浅色";
        if ("dark".equals(theme)) return "深色";
        return "跟随系统";
    }

    /** 主题配色当前档的显示名。 */
    private String accentLabel() {
        return ThemeCatalog.byId(settings.accentTheme).name;
    }

    /**
     * 选主题配色。五套主题排成一张 picker，选中后立刻生效 —— 换色是运行时
     * 动态染的，不用重建 Activity（和「深浅主题」的 recreate 不同）。
     */
    private void pickAccent() {
        View sheet = openSheet("主题配色", R.layout.sheet_picker);
        LinearLayout list = sheet.findViewById(R.id.pickerList);
        ((TextView) sheet.findViewById(R.id.pickerNote)).setText(
            "换一套主色。不影响深浅模式，只改状态栏、主按钮等品牌色。");

        for (final ThemeCatalog.Theme t : ThemeCatalog.ALL) {
            list.addView(pickerRow(list, t.name,
                ThemeCatalog.hex(t),
                t.id.equals(settings.accentTheme),
                () -> {
                    settings.accentTheme = t.id;
                    store.save(settings);
                    mountMain();
                    toast("已切换「" + t.name + "」");
                }));
        }
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

    /** UA 预设的显示名。customUA 非空时优先显示「自定义」。 */
    private String uaLabel() {
        if (!settings.customUA.trim().isEmpty()) return "自定义";
        if ("desktop".equals(settings.layout)) return "电脑版";
        if ("mobile".equals(settings.layout)) return "手机版";
        return "自动";
    }

    private void pickUA() {
        View sheet = openSheet("网页标识（UA）", R.layout.sheet_picker);
        LinearLayout list = sheet.findViewById(R.id.pickerList);
        ((TextView) sheet.findViewById(R.id.pickerNote)).setText(
            "决定网页把自己当手机还是当电脑。电脑版能让只认桌面浏览器的老网站打开，"
            + "但页面会按桌面布局返回，需要缩放才能看。");

        list.addView(pickerRow(list, "自动（手机版）",
            "跟随系统默认，绝大多数网站的最佳选择",
            "auto".equals(settings.layout) && settings.customUA.trim().isEmpty(),
            () -> setUaMode("auto")));
        list.addView(pickerRow(list, "电脑版",
            "以桌面 Chrome 的身份访问，适合只认桌面浏览器的网站",
            "desktop".equals(settings.layout) && settings.customUA.trim().isEmpty(),
            () -> setUaMode("desktop")));
        list.addView(pickerRow(list, "手机版",
            "强制手机 UA（与自动等价，区别在于不随系统变）",
            "mobile".equals(settings.layout) && settings.customUA.trim().isEmpty(),
            () -> setUaMode("mobile")));
        list.addView(pickerRow(list, "自定义…",
            settings.customUA.isEmpty() ? "未设置" : settings.customUA,
            !settings.customUA.trim().isEmpty(),
            this::promptCustomUA));
    }

    private void setUaMode(String mode) {
        settings.layout = mode;
        settings.customUA = "";
        store.save(settings);
        applyUserAgent();
        web.reload();
        mountMain();
        toast("网页标识已改为 " + uaLabel());
    }

    private void promptCustomUA() {
        EditText box = new EditText(this);
        box.setHint("完整的 UA 字符串");
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

        new NovaAlert(this, "自定义 UA",
            "填完整的 User-Agent 字符串。留空则回到自动（手机版）。")
            .custom(wrap)
            .negative("取消", null)
            .positive("保存", () -> {
                settings.customUA = box.getText().toString().trim();
                store.save(settings);
                applyUserAgent();
                web.reload();
                mountMain();
                toast(settings.customUA.isEmpty() ? "已恢复自动" : "自定义 UA 已生效");
            })
            .show();
    }

    private String textZoomLabel() {
        int z = settings.textZoom;
        if (z < 100) return "小（" + z + "%）";
        if (z > 100) return "大（" + z + "%）";
        return "默认（100%）";
    }

    private void pickTextZoom() {
        View sheet = openSheet("网页字号", R.layout.sheet_picker);
        LinearLayout list = sheet.findViewById(R.id.pickerList);
        ((TextView) sheet.findViewById(R.id.pickerNote)).setText(
            "放大或缩小网页文字。只影响网页内容，不影响浏览器界面。");

        int[][] levels = {
            {85, R.string.zoom_small},
            {100, R.string.zoom_default},
            {115, R.string.zoom_large},
            {130, R.string.zoom_xl}
        };
        for (final int[] lv : levels) {
            final int z = lv[0];
            list.addView(pickerRow(list, getString(lv[1]), z + "%",
                settings.textZoom == z,
                () -> {
                    settings.textZoom = z;
                    store.save(settings);
                    applyTextZoom();
                    mountMain();
                    showSettings();
                    toast("网页字号 " + z + "%");
                }));
        }
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
        menuRow(sheet, id, 0, title, sub, onTap, arrow);
    }

    /**
     * 一行菜单（带图标）。
     *
     * @param iconRes  左侧图标 drawable id；0 = 不显示图标
     */
    private void menuRow(View sheet, int id, int iconRes, String title, String sub,
                         Runnable onTap, boolean arrow) {
        View row = sheet.findViewById(id);
        ((TextView) row.findViewById(R.id.rowTitle)).setText(title);

        TextView subView = row.findViewById(R.id.rowSub);
        if (sub == null || sub.isEmpty()) {
            subView.setVisibility(View.GONE);
        } else {
            subView.setVisibility(View.VISIBLE);
            subView.setText(sub);
        }

        ImageView icon = row.findViewById(R.id.rowIcon);
        if (iconRes != 0) {
            icon.setVisibility(View.VISIBLE);
            icon.setImageResource(iconRes);
        } else {
            icon.setVisibility(View.GONE);
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

        // 设置页行不带图标（图标会挤掉本来就紧张的横向空间，且设置项重在文字），
        // 但把图标显式收掉，避免复用 item_menu 时残留。
        row.findViewById(R.id.rowIcon).setVisibility(View.GONE);

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
            // 长按同样是「按引用关」：position 来自网格派发，同样会在关闭后失效，
            // 于是这里也只是用它取一次对象，真正的定位交给 closeTabByRef。
            if (position >= 0 && position < tabs.size()) {
                closeTabByRef(tabs.get(position));
                adapter.notifyDataSetChanged();
                ((TextView) sheet.findViewById(R.id.tabTotal)).setText(
                    "共 " + tabs.size() + " 个标签");
            }
            return true;
        });

        sheet.findViewById(R.id.tabNew).setOnClickListener(v -> {
            mountMain();
            openNewTab();
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
            //
            // 关键：捕获的是 t（这一格的 Tab 对象），不是 i（绑定时的下标）。
            // GridView 复用 item 视图，而关闭后又立刻 notifyDataSetChanged ——
            // 下标会在这一刻整体前移，缓存 i 会关错项。按引用关（closeTabByRef）免疫这种漂移。
            ImageButton close = row.findViewById(R.id.tabClose);
            close.setOnClickListener(v -> {
                closeTabByRef(t);
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

        // 切走时收掉地址栏浮层。它挂在 WindowManager 上，不属于 Activity 的
        // 视图树，留着不会自动消失 —— 用户去别的应用转一圈回来，
        // 会看到它还原样悬在地址栏下面（而地址栏可能已经不是那一页了）。
        dismissUrlActions();
    }

    @Override
    protected void onResume() {
        super.onResume();
        stopPolling();
        // 从系统文件选择器回来：装插件的结果要马上反映到界面上。
        if (mainViewMounted && openSheetView == null) {
            reloadScripts();
        }

        // 强制更新：每次回到前台都重新亮一次提示条。
        //
        // 用户可能刚从系统安装器回来却没装成（点了取消），也可能是在某个弹层里
        // 把它关掉了。强制更新如果只显示一次、之后就被用户甩掉，那 mandatory
        // 这个标记就等于没写。这里宁可多显示一次，也不能留这个口子。
        if (pendingUpdate != null
                && pendingUpdate.mustUpdate(BuildConfig.VERSION_CODE)) {
            updateDismissed = false;
            if (updateBar == null) updateBar = findViewById(R.id.updateBar);
            renderUpdate();
        }
    }

    @Override
    protected void onDestroy() {
        stopPolling();
        // 下拉刷新的超时兜底。它握着一个 Runnable 贴着 this，不在销毁前摘掉，
        // 那 15 秒内 Activity 就走不干净。
        main.removeCallbacks(refreshTimeout);
        if (downloader != null) {
            downloader.shutdown();
            downloader = null;
        }
        if (ruleUpdater != null) {
            ruleUpdater.shutdown();
            ruleUpdater = null;
        }
        if (scriptInstaller != null) {
            scriptInstaller.shutdown();
            scriptInstaller = null;
        }
        if (updateManager != null) {
            // 下载到一半被中断不会留下坏文件：写的是 .part，改名那一步没走到，
            // 下次启动 readyPackage() 也认不出它，会被当成「没有下过」重来一遍。
            updateManager.shutdown();
            updateManager = null;
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