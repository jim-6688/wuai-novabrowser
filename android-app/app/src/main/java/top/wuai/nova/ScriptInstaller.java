package top.wuai.nova;

import android.os.Handler;
import android.os.Looper;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 吾爱Nova浏览器 · 推荐脚本的下载。
 *
 * <h3>它只负责「取回来 + 验一遍」，不负责落盘</h3>
 *
 * <p>取回来的脚本不直接写进 store，而是连同检测结果一起交回界面 —— 因为
 * 「这个脚本要了本引擎不提供的权限」这件事必须让用户先知道、先同意。
 * {@link #fetch} 给出的 {@link Result#pending} 是一个构造好但<b>尚未保存</b>的
 * {@link UserScript.Installed}，存不存由调用方决定。
 *
 * <h3>为什么把 {@code @grant} 检测放在这一层</h3>
 *
 * <p>清单里多数条目标着「未验证」—— 那不是「大概不能用」，是「没确认过」。
 * 下载回来的那一刻，{@link UserScript#parse} 会读出<b>真实的</b>
 * {@code @grant}，于是「未验证」在用户点下安装的一秒内就变成了确定的事实。
 * 这比在清单里猜准确得多，也不必让发布者在无网络的环境里预先验证每一条。
 *
 * <h3>为什么不用 OkHttp</h3>
 *
 * <p>与 {@link RuleUpdater} 同一个理由：就一次 HTTP GET，为它引一个几 MB 的
 * 依赖不划算，而 {@code HttpURLConnection} 是系统自带的、各版本行为一致。
 *
 * <h3>四种失败必须分开说</h3>
 *
 * <p>超时 / 404 / 返回网页 / 内容解析不了 —— 这四种在用户眼里都会变成
 * 「装不上」，但原因完全不同（网络问题、脚本已下架、地址被重定向到首页、
 * 拿到的根本不是 .user.js）。{@link Result#message} 要能把它们区分开，
 * 否则用户唯一能做的就是反复重试。
 */
public final class ScriptInstaller {

    /** 脚本正常只有几十 KB。超过这个数基本是抓错了东西，早点停。 */
    private static final int MAX_BYTES = 2 * 1024 * 1024;

    /** 一次下载的结果。除 {@link #pending} 外全部会显示在界面上。 */
    public static final class Result {
        public boolean ok;
        /** 失败原因，或成功后的摘要。 */
        public String message = "";
        /**
         * 构造好但<b>尚未保存</b>的脚本。调用方确认后才落盘。
         * 失败时为 {@code null}。
         */
        public UserScript.Installed pending;
        /** 脚本声明了、但本引擎不提供的权限。空表示没有越界请求。 */
        public final List<String> grants = new ArrayList<>();
        /**
         * 脚本没有 {@code ==UserScript==} 元数据头。
         *
         * <p>这不是错误，但必须告知：没有头就没有 {@code @match}，
         * {@link UserScript#parse} 会兜底成「所有网站都运行」。
         * 用户有权在装之前知道这一点。
         */
        public boolean headless;
        /** 来源地址，显示用。 */
        public String origin = "";
    }

    public interface Callback {
        /** 只在结束时回调一次，在主线程。 */
        void onDone(Result r);
    }

    private final ExecutorService io =
        Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "nova-script");
            t.setPriority(Thread.NORM_PRIORITY - 1);
            return t;
        });
    private final Handler main = new Handler(Looper.getMainLooper());

    public void shutdown() { io.shutdown(); }

    /** 下载并解析一条清单项。 */
    public void fetch(final ScriptCatalog.Item item, final Callback cb) {
        io.execute(() -> {
            Result r = download(item);
            main.post(() -> cb.onDone(r));
        });
    }

    private Result download(ScriptCatalog.Item item) {
        Result r = new Result();
        if (item == null) {
            r.message = "清单项为空";
            return r;
        }
        r.origin = ScriptCatalog.homeUrl(item);
        String url = ScriptCatalog.installUrl(item);

        String text;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) NovaBrowser/1.0");
            conn.setRequestProperty("Accept", "text/plain, application/javascript, */*");

            int code = conn.getResponseCode();
            if (code >= 400) {
                r.message = "服务器返回 " + code + hint(code);
                return r;
            }

            String ctype = conn.getHeaderField("Content-Type");
            if (ctype != null && ctype.toLowerCase(Locale.ROOT).contains("text/html")) {
                // 脚本下架、ID 变更、或站点把请求重定向到了首页，都会落到这里。
                // 必须单独说 —— 否则用户看到的是「装不上」，而真实原因是那条脚本没了。
                r.message = "该地址返回的是网页（" + shortType(ctype) + "），不是脚本。"
                    + "这条脚本可能已从 Greasy Fork 下架或改过地址。";
                return r;
            }

            StringBuilder sb = new StringBuilder(8192);
            try (BufferedReader br = new BufferedReader(
                new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) {
                    sb.append(line).append('\n');
                    if (sb.length() > MAX_BYTES) {
                        r.message = "下载内容超过 2MB，不像用户脚本，已放弃。";
                        return r;
                    }
                }
            }
            text = sb.toString();
        } catch (SocketTimeoutException e) {
            r.message = "连接超时，请检查网络后重试";
            return r;
        } catch (UnknownHostException e) {
            r.message = "域名解析失败：可能当前网络无法访问 Greasy Fork";
            return r;
        } catch (Exception e) {
            r.message = "下载失败：" + (e.getMessage() == null
                ? e.getClass().getSimpleName() : e.getMessage());
            return r;
        } finally {
            if (conn != null) conn.disconnect();
        }

        return parseDownloaded(text);
    }

    /**
     * 把下载到的文本验成一条可安装的脚本。
     *
     * <p>独立成静态方法是为了能单测 —— 这里挡的是一个<b>真实且危险</b>的坑：
     * {@link UserScript#parse} 对没有元数据头的文本会兜底成「匹配所有地址」，
     * 也就是「所有网站都运行」。于是一张 HTML 错误页
     * 会被安静地装成一个全站脚本。所以进 parse 之前必须先排除「这是网页」。
     */
    static Result parseDownloaded(String text) {
        Result r = new Result();
        if (text == null || text.trim().isEmpty()) {
            r.message = "下载到的内容是空的";
            return r;
        }
        String t = text.trim();

        if (looksLikeHtml(t)) {
            r.message = "下载到的是一张网页而不是脚本 —— 请求可能被重定向了，"
                + "或这条脚本已经不存在。";
            return r;
        }

        UserScript.Parsed p = UserScript.parse(text);
        if (!p.ok()) {
            r.message = "无法解析这个脚本：" + p.error;
            return r;
        }

        // 头是脚本自己声明的适用范围。没有头 = 会在所有网站上运行，
        // 这是用户装之前必须知道的事，所以要走 headless 提示而不是默默装上。
        r.headless = !text.contains("==UserScript==");
        // 只收「确实不支持」的那些，不是脚本声明的全量 —— 已经提供的接口
        // （GM_addStyle 一类）列进这里会变成一条假的缺陷报告。
        r.grants.addAll(p.meta.unsupportedGrants());

        String id = UserScript.idOf(p.meta, p.body);
        r.pending = new UserScript.Installed(id, p.meta, p.body,
            System.currentTimeMillis(), r.origin);
        r.ok = true;
        r.message = "已下载：" + p.meta.name;
        return r;
    }

    /**
     * 这段文本看起来是不是一张网页。
     *
     * <p>只认开头：脚本正文里当然可以有 HTML 字符串（往页面插元素的那种），
     * 但<b>开头</b>就是 {@code <!DOCTYPE} 或 {@code <html} 的，只可能是网页本身。
     * 用「包含」判断会把正常脚本误伤成网页，那是另一种错。
     */
    private static boolean looksLikeHtml(String s) {
        String t = s.trim().toLowerCase(Locale.ROOT);
        return t.startsWith("<!doctype") || t.startsWith("<html");
    }

    private static String shortType(String ctype) {
        int semi = ctype.indexOf(';');
        return (semi > 0 ? ctype.substring(0, semi) : ctype).trim();
    }

    private static String hint(int code) {
        if (code == 403) return "（服务器拒绝了请求，可能被网络环境拦截）";
        if (code == 404) return "（脚本不存在，可能已从 Greasy Fork 下架）";
        if (code >= 500) return "（对方服务器出错，稍后再试）";
        return "";
    }
}
