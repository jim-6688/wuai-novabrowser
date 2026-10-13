package top.wuai.nova;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
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
 * <h3>为什么用 DownloadManager 而不是自己的 Downloader</h3>
 *
 * <p>自己的 {@link Downloader} 是为「网页里嗅探到的媒体文件」设计的：分片、断点续传、
 * 落到应用私有目录。而装 APK 最终要让系统安装器能<b>读到</b>那个文件 ——
 * 私有目录里的文件别的应用读不到，得再垫一层 ContentProvider 才能对外给 content:// URI。
 *
 * <p>DownloadManager 直接写公共下载目录，天然带系统通知栏进度，也省掉这一层。
 * APK 只有几百 KB，分片带不来什么收益，不值得为此多一条容易出错的路径。
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

    /**
     * 交给系统下载器。
     *
     * <p>用 DownloadManager 的另一个理由：它自己就有写公共下载目录的权限，
     * 我们不用为了装一个 APK 去申请存储权限 —— 少一个权限弹窗，
     * 就少一个用户在安装前被劝退的机会。
     */
    public long download(Manifest m) {
        Link link = m == null ? null : m.primary();
        if (link == null) return -1;
        try {
            DownloadManager dm =
                (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return -1;
            String abs = absolute(m.baseUrl, link.url);
            DownloadManager.Request rq = new DownloadManager.Request(Uri.parse(abs));
            rq.setTitle("吾爱Nova浏览器 " + m.version);
            rq.setDescription("下载完成后点通知即可安装");
            rq.setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            rq.setMimeType("application/vnd.android.package-archive");
            rq.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                fileNameOf(abs));
            return dm.enqueue(rq);
        } catch (Exception e) {
            return -1;
        }
    }

    /** 从地址里取文件名；取不到就给个默认名。 */
    static String fileNameOf(String url) {
        String s = url;
        int q = s.indexOf('?');
        if (q >= 0) s = s.substring(0, q);
        int h = s.indexOf('#');
        if (h >= 0) s = s.substring(0, h);
        int slash = s.lastIndexOf('/');
        String name = slash >= 0 ? s.substring(slash + 1) : "";
        return name.isEmpty() ? "nova.apk" : name;
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
