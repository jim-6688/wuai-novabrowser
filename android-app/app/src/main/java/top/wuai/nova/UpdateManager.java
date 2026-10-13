package top.wuai.nova;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 吾爱Nova浏览器 · 应用内自动更新。
 *
 * <h3>为什么版本清单一律走官网</h3>
 *
 * <p>更新清单（{@code version.json}）由官网静态托管，App 端与官网<b>共用同一个版本来源</b>。
 * 版本号只写一处，就不会出现「官网写着 1.1.0、下载下来却是 1.0.0」这种事 ——
 * 那类不一致最难查，因为两端看起来都对。
 *
 * <h3>为什么改成自己下载，而不是交给 DownloadManager</h3>
 *
 * <p>最初这版把下载交给系统 DownloadManager，看中的是「免费的通知栏进度」与
 * 「不写存储权限也能落公共下载目录」。但要做成<b>后台静默下载 + 重启更新</b>
 * （见 {@link UpdateFlow}）时，它的两个短板就变成了拦路石：
 *
 * <ul>
 *   <li>进度只能靠轮询 {@code DownloadManager.query()} 或监听它的完成广播。
 *       前者要么太密（每次查询都是一次跨进程调用）要么太疏（进度条一顿一顿）；
 *       后者要动态注册一个接收器，还得为部分版本补上 {@code RECEIVER_NOT_EXPORTED}，
 *       平白多出一条很容易写错的平台分支。</li>
 *   <li>它对「校验完整性」提供不了任何帮助。而清单里的 {@code sha256} 本来就该被用上 ——
 *       一个下了一半的 APK 被送去安装，用户看到的是「应用未安装」，
 *       没人能从这句提示里猜到真正的原因。</li>
 * </ul>
 *
 * <p>自己下一个几 MB 的包并不难：一个 {@code HttpURLConnection}，边读边报进度，
 * 读完算一遍 sha256，最后把 {@code .part} 改名成 {@code .apk} 落盘。
 * 进度是真实字节数算出来的，校验是顺手做的，全程没有一次额外的跨进程调用。
 *
 * <p>代价是应用被杀就中断。这个代价可以接受：包只有几 MB，下次启动重下即可；
 * 而「下次启动发现上次已经下好」这条路径也做了（见 {@link #readyPackage}）。
 *
 * <h3>静默约定</h3>
 *
 * <p>启动时那次检查<b>完全静默</b>：查不到、解析失败、网络不通，统统不弹窗 ——
 * 用户没点「检查更新」，为一个后台动作弹「失败」是骚扰。
 * 只有真的有新版时才出现提示；从菜单里主动点「检查更新」才反馈「已是最新」。
 */
public final class UpdateManager {

    /**
     * 首选的更新清单地址（正式域名）。
     *
     * <p>换域名时<b>只需要改这一处</b>：清单里的官网直链故意写成相对路径，
     * 由 {@link #absolute(String)} 拿这里当基座拼出绝对地址。
     */
    public static final String UPDATE_URL =
        "https://nova.52ta.top/version.json";

    /**
     * 依次尝试的清单地址，取第一个能读通的。
     *
     * <p>为什么不是一个地址而是一个列表：这是 App <b>唯一的自救通道</b>，
     * 而它恰好挂在最脆弱的一根线上 —— 域名。证书过期、DNS 改错、CDN 欠费、
     * 域名忘了续，任何一个都会让「检查更新」彻底哑掉。启动时那次检查是静默的，
     * 所以用户不会收到任何提示，只会被永久钉在旧版本上，连为什么都不知道。
     * 多留一个兜底地址，等于给这条唯一的通道上了双保险。
     *
     * <p>顺序有意义：正式域名在前，托管域名在后，正常情况下永远用不到后者。
     */
    public static final String[] UPDATE_URLS = {
        UPDATE_URL,
        "https://nova-browser-site.app.workbuddy.host/version.json",
    };

    /** 清单体积上限。正常的清单只有几百字节，几十 KB 就肯定是抓错页面了。 */
    private static final int MAX_BYTES = 64 * 1024;

    public interface Callback {
        /**
         * 主线程回调。
         *
         * @param m 版本清单；{@code null} 表示没查到（网络问题、解析失败等），
         *          调用方应据此判断「已是最新」还是「没查到」，不要弹错误。
         */
        void onResult(Manifest m);
    }

    /** 一个可点的下载地址。 */
    public static final class Link {
        public final String label;
        public final String url;
        public final long size;
        public final String sha256;

        Link(String label, String url, long size, String sha256) {
            this.label = label;
            this.url = url;
            this.size = size;
            this.sha256 = sha256;
        }
    }

    /** 解析出来的版本清单。 */
    public static final class Manifest {
        public final String version;
        public final int versionCode;
        public final String updatedAt;
        public final boolean mandatory;
        public final int minVersionCode;
        public final List<String> changelog;
        public final List<Link> downloads;
        /**
         * 这份清单是从哪个地址读来的。
         *
         * <p>清单里的官网直链写成相对路径，必须由读它的那个地址来补全 ——
         * 记下来源而不是一律用首选域名，兜底地址读来的清单才能拼对下载链接，
         * 否则会出现「提示有更新，一点下载就 404」这种最让人恼火的情况。
         */
        public final String baseUrl;

        Manifest(String version, int versionCode, String updatedAt, boolean mandatory,
                 int minVersionCode, List<String> changelog, List<Link> downloads,
                 String baseUrl) {
            this.version = version;
            this.versionCode = versionCode;
            this.updatedAt = updatedAt;
            this.mandatory = mandatory;
            this.minVersionCode = minVersionCode;
            this.changelog = changelog;
            this.downloads = downloads;
            this.baseUrl = baseUrl == null || baseUrl.isEmpty() ? UPDATE_URL : baseUrl;
        }

        /** 是否比当前版本新。 */
        public boolean newerThan(int currentCode) {
            return versionCode > currentCode;
        }

        /**
         * 是否必须更新。
         *
         * <p>两种情形：作者标了强制，或者当前版本已经低于清单里写的最低支持版本码。
         */
        public boolean mustUpdate(int currentCode) {
            return mandatory || (minVersionCode > 0 && currentCode < minVersionCode);
        }

        /** 首选下载地址；清单里没给地址则返回 null。 */
        public Link primary() {
            return downloads.isEmpty() ? null : downloads.get(0);
        }
    }

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "nova-update");
        t.setPriority(Thread.NORM_PRIORITY - 1);
        return t;
    });

    public UpdateManager(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    /**
     * 退出时关掉 IO 线程池。
     *
     * <p>它跑的是普通优先级的非守护线程，留着没有任何意义 ——
     * 下载到一半被中断也不会留下坏文件（写的是 {@code .part}，改名那一步没走到）。
     */
    public void shutdown() {
        io.shutdownNow();
    }

    /**
     * 异步检查更新。
     *
     * <p>失败一律回调 {@code null}，由调用方决定「静默」还是「提示」，
     * 这里不抛也不弹 —— 与规则订阅自动更新同一套约定。
     */
    public void check(final int currentCode, final Callback cb) {
        io.execute(() -> {
            Manifest m = null;
            try {
                m = fetch();
            } catch (Exception ignored) {
                // 静默：查不到就当没有更新
            }
            final Manifest got = m;
            main.post(() -> cb.onResult(got));
        });
    }

    /**
     * 逐个地址试，取第一个能读通的清单。
     *
     * <p>只有「连不上 / 返回错误码 / 清单格式不对」才换下一个地址 ——
     * 读到了一份<b>内容合法但版本更旧</b>的清单不算失败，那就该按它说的算：
     * 没有更新。否则一个还停在旧版本的镜像站会让用户反复收到已经装过的版本。
     */
    private Manifest fetch() throws Exception {
        java.io.IOException last = null;
        for (String url : UPDATE_URLS) {
            try {
                Manifest m = fetchOne(url);
                if (m != null) return m;
            } catch (java.io.IOException e) {
                last = e; // 这个地址不行，换下一个
            }
        }
        throw last != null ? last : new java.io.IOException("没有可用的更新地址");
    }

    private Manifest fetchOne(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestProperty("Accept", "application/json");
        try {
            int code = c.getResponseCode();
            if (code >= 400) throw new java.io.IOException("HTTP " + code);
            String text = readAll(c.getInputStream(), MAX_BYTES);
            Manifest m = parse(text, url);
            if (m == null || m.versionCode <= 0) {
                throw new java.io.IOException("清单格式不对");
            }
            return m;
        } finally {
            c.disconnect();
        }
    }

    /** 读流，超过 max 就放弃 —— 防止一个抓错的页面把内存吃满。 */
    static String readAll(InputStream in, int max) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        int total = 0;
        while ((n = in.read(buf)) > 0) {
            bos.write(buf, 0, n);
            total += n;
            if (total > max) throw new java.io.IOException("内容太大了");
        }
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    /**
     * 解析更新清单。
     *
     * <p>这里刻意<b>手写</b>而不是用 {@code org.json}：那个类来自 android.jar，
     * 在本地 JVM 单测里一调就抛 {@code Stub!}，整条解析链路都没法离线验证。
     * 清单结构固定且很浅，手写扫描足够，还能顺手容忍字段缺失和多余空格。
     */
    static Manifest parse(String json) {
        return parse(json, UPDATE_URL);
    }

    /** 同 {@link #parse(String)}，但记住清单是从 baseUrl 读来的。 */
    static Manifest parse(String json, String baseUrl) {
        if (json == null || json.trim().isEmpty()) return null;
        String version = str(json, "version");
        int code = (int) num(json, "versionCode");
        if (version.isEmpty() || code <= 0) return null;
        int min = (int) num(json, "minVersionCode");
        if (min <= 0) min = 1;
        return new Manifest(version, code, str(json, "updatedAt"),
            bool(json, "mandatory"), min, strArray(json, "changelog"),
            links(json), baseUrl);
    }

    /**
     * 把清单里写的相对地址补全成绝对地址。
     *
     * <p>官网直链故意写成 {@code download/xxx.apk} 这种相对形式：
     * 这样换域名时清单文件一个字都不用改，基座由使用方自己拼。
     */
    public static String absolute(String url) {
        return absolute(UPDATE_URL, url);
    }

    /**
     * 同 {@link #absolute(String)}，但按 baseUrl 补基座。
     *
     * <p>兜底地址读来的清单必须用它自己的域名补全，不能一律用首选域名 ——
     * 否则首选域名一挂，就会出现「提示有新版，一点下载就 404」。
     */
    public static String absolute(String baseUrl, String url) {
        if (url == null || url.isEmpty()) return url;
        String lower = url.toLowerCase(Locale.ROOT);
        if (lower.startsWith("http://") || lower.startsWith("https://")) return url;
        if (baseUrl == null || baseUrl.isEmpty()) baseUrl = UPDATE_URL;
        int cut = baseUrl.indexOf("/version.json");
        String base = cut >= 0 ? baseUrl.substring(0, cut + 1) : baseUrl + "/";
        return base + (url.startsWith("/") ? url.substring(1) : url);
    }

    // ------------------------------------------------------------ 下载与安装

    /**
     * 更新包目录名（相对 {@code filesDir}）。
     *
     * <p>放应用私有目录而不是公共下载目录：这份文件是<b>中间产物</b>，装完就该消失。
     * 落公共目录会在用户相册旁边留下一个陌生文件，还要额外申请存储权限才能写。
     */
    public static final String UPDATE_DIR = "update";

    /** 下载进度回调。运行在主线程。 */
    public interface Progress {
        /**
         * @param got   已下载字节
         * @param total 总字节；{@code <= 0} 表示服务器没给（总长未知）
         */
        void onProgress(long got, long total);
    }

    /** 下载结束回调。运行在主线程。 */
    public interface Done {
        /**
         * @param apk   已下载并通过校验的安装包；失败时为 {@code null}
         * @param error 失败原因（给人看的一句话）；成功时为 {@code null}
         */
        void onDone(File apk, String error);
    }

    /** 更新包目录。 */
    public File updateDir() {
        return new File(ctx.getFilesDir(), UPDATE_DIR);
    }

    /** 某个版本对应安装包的文件名。下载、就绪检测、清理三处必须用同一个规则。 */
    static String apkName(String version) {
        String v = version == null ? "" : version.trim();
        // 版本号是从网络清单里读来的。虽然清单是我们自己发的，但只要有一次手误
        // 写成 "1.2/3"，拼出来的就是一份跨目录的路径 —— ApkProvider 会在安装那一步
        // 拒绝它，但那时留下的已经是一个「下载完了却装不上」的谜案了。
        // 所以在这里先把不属于版本号的字符剔掉。
        v = v.replaceAll("[^A-Za-z0-9._-]", "");
        // 连着两个点在路径里表示「上一层目录」，而它恰好能由版本号里的杂质拼出来。
        while (v.contains("..")) v = v.replace("..", ".");
        if (v.isEmpty() || ".".equals(v)) v = "latest";
        return "nova-" + v + ".apk";
    }

    /**
     * 上次已经下好、且校验通过的更新包；没有则返回 {@code null}。
     *
     * <p>这个方法存在的原因很具体：用户下载完、正准备重启时退出了应用
     * （或者安装被系统打断）。没有它，下次启动会把已经下好的包当成不存在、
     * 从头再下一遍 —— 用户看到的是「明明下过了，怎么又在下载」。
     */
    public File readyPackage(Manifest m) {
        if (m == null) return null;
        File f = new File(updateDir(), apkName(m.version));
        if (!f.isFile() || f.length() <= 0) return null;

        Link link = m.primary();
        if (link != null) {
            // 大小先粗筛：对不上多半是上次没下完的残包，不必白算一遍 sha256。
            if (link.size > 0 && f.length() != link.size) return null;
            if (!link.sha256.isEmpty()) {
                try {
                    if (!sha256(f).equalsIgnoreCase(link.sha256)) return null;
                } catch (Exception e) {
                    return null;
                }
            }
        }
        return f;
    }

    /**
     * 后台下载更新包。进度与结果都回到主线程。
     *
     * <p>失败不抛异常，而是把原因塞进 {@link Done#onDone} 的第二个参数 ——
     * 调用方需要的是「给用户看的一句话」，不是堆栈。
     */
    public void fetch(final Manifest m, final Progress p, final Done d) {
        io.execute(() -> {
            File apk = null;
            String err = null;
            try {
                apk = downloadApk(m, p);
            } catch (Exception e) {
                err = describe(e);
            }
            final File f = apk;
            final String msg = err;
            main.post(() -> d.onDone(f, msg));
        });
    }

    /**
     * 真正下载的地方。
     *
     * <p>先写 {@code .part} 再改名，是为了让「下到一半」这件事对别人不可见：
     * 如果直接写 {@code .apk}，中途被杀就会留下一个同名但残缺的文件，
     * 而 {@link #readyPackage} 只看文件名是判断不出它坏没坏的
     * （清单里没给 sha256 时尤其如此）。
     */
    private File downloadApk(Manifest m, Progress p) throws Exception {
        if (m == null) throw new IOException("没有版本信息");
        Link link = m.primary();
        if (link == null) throw new IOException("更新清单里没有可用的下载地址");

        File dir = updateDir();
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("无法创建更新目录");
        }

        File part = new File(dir, apkName(m.version) + ".part");
        File dst = new File(dir, apkName(m.version));
        // 上次的残包先清掉。不做断点续传：清单里的 sha256 是整包校验，
        // 续传得额外维护分片状态，而包只有几 MB，不值得。
        if (part.exists()) part.delete();

        String abs = absolute(m.baseUrl, link.url);
        HttpURLConnection c = (HttpURLConnection) new URL(abs).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("Accept",
            "application/vnd.android.package-archive,application/octet-stream,*/*");
        try {
            int code = c.getResponseCode();
            if (code >= 400) throw new IOException("服务器返回 HTTP " + code);

            long total = c.getContentLength();
            if (total <= 0) total = link.size; // 清单里写了大小就拿它兜底

            try (InputStream in = c.getInputStream();
                 FileOutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[16384];
                long got = 0;
                int last = -2; // -2 与任何真实百分比都不同，保证首帧一定会被报出去
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    got += n;
                    // 按百分比节流：每读一块就回调，会把主线程淹没在无意义的刷新里。
                    int pct = UpdateFlow.percentOf(got, total);
                    if (pct != last) {
                        last = pct;
                        if (p != null) p.onProgress(got, total);
                    }
                }
                out.flush();
            }
        } finally {
            c.disconnect();
        }

        if (!link.sha256.isEmpty()) {
            String got = sha256(part);
            if (!got.equalsIgnoreCase(link.sha256)) {
                part.delete();
                throw new IOException("更新包校验没通过，可能没下完整");
            }
        }

        if (dst.exists() && !dst.delete()) {
            part.delete();
            throw new IOException("旧的更新包删不掉");
        }
        if (!part.renameTo(dst)) {
            part.delete();
            throw new IOException("更新包保存失败");
        }
        return dst;
    }

    /** 清掉除 {@code keep} 以外的更新包（含上次没下完的 {@code .part}）。 */
    public void prune(File keep) {
        File[] all = updateDir().listFiles();
        if (all == null) return;
        String keepPath = keep == null ? null : keep.getAbsolutePath();
        for (File f : all) {
            if (keepPath != null && keepPath.equals(f.getAbsolutePath())) continue;
            f.delete();
        }
    }

    /**
     * 交给系统安装器。
     *
     * <p>这里只能「拉起安装器」，做不到真正的静默安装 —— Android 不允许普通应用
     * 直接覆盖安装自己（那等于给了应用绕过用户确认改自己代码的能力）。
     * 所以「重启更新」这个动作在系统里的真实含义是：用户点一下 →
     * 系统弹出安装确认 → 装完应用以新版本重新启动。
     *
     * @return {@code null} 表示已成功拉起；否则是给人看的一句话原因
     */
    public String install(File apk) {
        if (apk == null || !apk.isFile() || apk.length() <= 0) {
            return "更新包不见了，请重新下载";
        }

        // Android 8.0 起，安装来自其他应用的 APK 需要用户先授权「安装未知应用」。
        // 不先查这一下，startActivity 会静默失败 —— 用户只看到「点了没反应」，
        // 而这恰恰是最难自查的一类现象。所以这里主动把人送到那个开关面前。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PackageManager pm = ctx.getPackageManager();
            if (pm != null && !pm.canRequestPackageInstalls()) {
                try {
                    Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + ctx.getPackageName()));
                    s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(s);
                    return "请先允许「吾爱Nova浏览器」安装应用，再点一次「重启更新」";
                } catch (Exception e) {
                    return "请在系统设置里允许本应用安装其他应用";
                }
            }
        }

        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(ApkProvider.uriFor(apk), "application/vnd.android.package-archive");
        // 安装器是另一个进程，读权限必须显式授予，否则它拿到的是 permission denied。
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
            return null;
        } catch (Exception e) {
            return "没有找到能安装应用的程序";
        }
    }

    /** 整文件的 sha256，小写十六进制。 */
    static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder(64);
        for (byte b : md.digest()) {
            sb.append(Character.forDigit((b >> 4) & 0xf, 16));
            sb.append(Character.forDigit(b & 0xf, 16));
        }
        return sb.toString();
    }

    /**
     * 把异常翻译成一句能给人看的话。
     *
     * <p>本类自己抛的那几个 {@link IOException}，消息本来就是写给用户看的
     * （「更新包校验没通过，可能没下完整」），直接透传即可；
     * 系统抛的那些 {@code failed to connect to ... / Read timed out}
     * 对用户没有任何帮助，所以只在没有消息时退回一句中性描述。
     */
    private static String describe(Exception e) {
        String msg = e == null ? null : e.getMessage();
        if (msg != null && !msg.trim().isEmpty()) return msg.trim();
        return "网络中断，稍后会自动重试";
    }

    // ------------------------------------------------------ 极简 JSON 扫描

    /**
     * 取某个键的字符串值。
     *
     * <p>只按 {@code "key" : "value"} 的形状扫，不解析完整 JSON。
     * 值里的转义引号会让这里取到半截 —— 我们自己的清单不会出现那种内容，
 * 真出现了也只是取到一个短一点的名字，不会崩。
     */
    static String str(String src, String key) {
        int at = src.indexOf('"' + key + '"');
        if (at < 0) return "";
        int colon = src.indexOf(':', at + key.length() + 2);
        if (colon < 0) return "";
        int q1 = src.indexOf('"', colon + 1);
        if (q1 < 0) return "";
        int q2 = src.indexOf('"', q1 + 1);
        if (q2 < 0) return "";
        return src.substring(q1 + 1, q2);
    }

    /** 取某个键的数字值，取不到返回 def。 */
    static long num(String src, String key) {
        int at = src.indexOf('"' + key + '"');
        if (at < 0) return -1;
        int colon = src.indexOf(':', at + key.length() + 2);
        if (colon < 0) return -1;
        int i = colon + 1;
        while (i < src.length() && Character.isWhitespace(src.charAt(i))) i++;
        int j = i;
        while (j < src.length()
                && (Character.isDigit(src.charAt(j)) || src.charAt(j) == '-')) j++;
        if (j == i) return -1;
        try {
            return Long.parseLong(src.substring(i, j));
        } catch (Exception e) {
            return -1;
        }
    }

    /** 取某个键的布尔值，取不到返回 false。 */
    static boolean bool(String src, String key) {
        int at = src.indexOf('"' + key + '"');
        if (at < 0) return false;
        int colon = src.indexOf(':', at + key.length() + 2);
        if (colon < 0) return false;
        String tail = src.substring(colon + 1,
            Math.min(src.length(), colon + 8)).trim().toLowerCase(Locale.ROOT);
        return tail.startsWith("true");
    }

    /** 取某个键的字符串数组（顶层或块内均可）。 */
    static List<String> strArray(String src, String key) {
        List<String> out = new ArrayList<>();
        String body = arrayBody(src, key);
        if (body == null) return out;
        int i = 0;
        while (i < body.length()) {
            int a = body.indexOf('"', i);
            if (a < 0) break;
            int b = body.indexOf('"', a + 1);
            if (b < 0) break;
            out.add(body.substring(a + 1, b));
            i = b + 1;
        }
        return out;
    }

    /** 取某个键的对象数组，抽出每个对象的 label / url / size / sha256。 */
    static List<Link> links(String src) {
        List<Link> out = new ArrayList<>();
        String body = arrayBody(src, "downloads");
        if (body == null) return out;
        int i = 0;
        while (i < body.length()) {
            int a = body.indexOf('{', i);
            if (a < 0) break;
            int b = body.indexOf('}', a);
            if (b < 0) break;
            String one = body.substring(a + 1, b);
            String url = str(one, "url");
            if (!url.isEmpty()) {
                out.add(new Link(str(one, "label"), url,
                    num(one, "size"), str(one, "sha256")));
            }
            i = b + 1;
        }
        return out;
    }

    /** 找到 "key": [...] 的方括号内部文本。 */
    private static String arrayBody(String src, String key) {
        int at = src.indexOf('"' + key + '"');
        if (at < 0) return null;
        int open = src.indexOf('[', at);
        if (open < 0) return null;
        int close = src.indexOf(']', open);
        if (close < 0) close = src.length();
        return src.substring(open + 1, close);
    }
}
