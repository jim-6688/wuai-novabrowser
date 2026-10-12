package top.wuai.nova;

import android.os.Handler;
import android.os.Looper;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 吾爱Nova浏览器 · 拦截规则订阅更新。
 *
 * <h3>为什么不用 OkHttp 或 WorkManager</h3>
 *
 * <p>就一次 HTTP GET + 一次落盘。为此引两个依赖（一个几 MB，一个还要注册
 * 后台调度约束）不划算，而且 {@code HttpURLConnection} 是系统自带的，
 * 在所有 Android 版本上行为一致。{@code WorkManager} 也不合适 ——
 * 更新是用户主动点的，不是「保证一定会跑」的后台任务。
 *
 * <h3>三件必须守住的事</h3>
 *
 * <ol>
 *   <li><b>先校验再落盘</b>：解析出 0 条域名就不写。写进去等于把用户现有的
 *       规则清空了，而他点的只是「更新」。</li>
 *   <li><b>临时文件 + 改名</b>：写一半断电不会毁掉原来那份好规则。</li>
 *   <li><b>失败要说原因</b>：网络超时、404、被重定向到 HTML 页面
 *       （有些站点把订阅请求重定向到首页，那会解析出 0 条）—— 三种要分开说，
 *       否则用户只会看到一句「更新失败」。</li>
 * </ol>
 */
public final class RuleUpdater {

    /** 更新结果。全部字段都会展示在界面上。 */
    public static final class Result {
        public boolean ok;
        public String message = "";
        /** 解析出的域名数 */
        public int hosts;
        /** 跳过的规则数（元素隐藏、路径规则） */
        public int unsupported;
        /** 更新时间戳文本 */
        public String stamp = "";
        public long at;
    }

    public interface Callback {
        /** 开始与结束都会来（开始时 {@code result} 为 null），都在主线程。 */
        void onUpdate(Result result);
    }

    private final NovaStore store;
    private final ExecutorService io =
        Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "nova-rules");
            t.setPriority(Thread.NORM_PRIORITY - 1);
            return t;
        });
    private final Handler main = new Handler(Looper.getMainLooper());

    public RuleUpdater(NovaStore store) { this.store = store; }

    public void shutdown() { io.shutdown(); }

    public boolean busy() { return !io.isShutdown(); }

    /** 更新到指定的订阅地址。 */
    public void update(final String url, final String label, final Callback cb) {
        main.post(() -> cb.onUpdate(null));
        io.execute(() -> {
            Result r = fetch(url, label);
            main.post(() -> cb.onUpdate(r));
        });
    }

    private Result fetch(String url, String label) {
        Result r = new Result();
        r.at = System.currentTimeMillis();

        String invalid = RuleSet.validateUrl(url);
        if (!invalid.isEmpty()) {
            r.message = invalid;
            return r;
        }

        HttpURLConnection conn = null;
        String text;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) NovaBrowser/1.0");
            conn.setRequestProperty("Accept", "text/plain, */*");

            int code = conn.getResponseCode();
            if (code >= 400) {
                r.message = "服务器返回 " + code + hint(code);
                return r;
            }

            String ctype = conn.getHeaderField("Content-Type");
            if (ctype != null && ctype.toLowerCase(Locale.ROOT).contains("text/html")) {
                // 有些站点把订阅请求重定向到首页，返回的是一个 HTML 页面。
                // 这种情况必须单独说，不然用户看到的是「更新成功但一条规则都没变」。
                r.message = "该地址返回的是网页（" + shortType(ctype) + "），不是规则列表。"
                    + "请确认订阅地址是否正确，或是否已失效。";
                return r;
            }

            InputStream in = conn.getInputStream();
            StringBuilder sb = new StringBuilder(4096);
            try (BufferedReader br = new BufferedReader(
                new InputStreamReader(in, StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) {
                    sb.append(line).append('\n');
                    // 5MB 以上的「规则列表」几乎肯定是抓错页面了，早点停。
                    if (sb.length() > 5 * 1024 * 1024) {
                        r.message = "返回内容超过 5MB，不像规则列表，已放弃。";
                        return r;
                    }
                }
            }
            text = sb.toString();
        } catch (java.net.SocketTimeoutException e) {
            r.message = "连接超时，请检查网络后重试";
            return r;
        } catch (java.net.UnknownHostException e) {
            r.message = "域名解析失败：" + e.getMessage();
            return r;
        } catch (Exception e) {
            r.message = "下载失败：" + (e.getMessage() == null ? e.getClass().getSimpleName()
                : e.getMessage());
            return r;
        } finally {
            if (conn != null) conn.disconnect();
        }

        List<String> lines = RuleSet.lines(text);
        RuleSet.ParseResult parsed = RuleSet.parse(lines);

        if (parsed.hosts.isEmpty()) {
            // 关键防线：空结果绝不落盘。落进去等于清空了用户现有的规则。
            r.message = "解析结果里一条域名都没有，已保留原有规则。"
                + "该订阅可能只含元素隐藏规则（移动版不支持），或已失效。";
            return r;
        }

        // 域名数锐减也要拦一下：更新完规则从 13 万变成 200 条，
        // 几乎肯定是拉到了空壳页面而不是真实订阅。
        int oldCount = 0;
        Set<String> old = store.loadUserRules();
        if (old != null) oldCount = old.size();
        if (oldCount > 1000 && parsed.hosts.size() < oldCount / 20) {
            r.message = "新规则只有 " + parsed.hosts.size() + " 条，而原有 " + oldCount
                + " 条，锐减到 1/20 以下，很可能不是完整订阅。已保留原有规则。";
            return r;
        }

        String stamp = stamp(r.at);
        if (!store.saveUserRules(parsed.hosts, url, label, parsed.unsupported, stamp)) {
            r.message = "规则已下载但写入失败，可能是存储空间不足。";
            return r;
        }

        r.ok = true;
        r.hosts = parsed.hosts.size();
        r.unsupported = parsed.unsupported;
        r.stamp = stamp;
        r.message = "已更新：" + parsed.hosts.size() + " 个域名"
            + (parsed.unsupported > 0 ? "，另有 " + parsed.unsupported + " 条规则移动版不支持" : "");
        return r;
    }

    private static String stamp(long at) {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA).format(new Date(at));
    }

    private static String shortType(String ctype) {
        int semi = ctype.indexOf(';');
        String t = semi > 0 ? ctype.substring(0, semi) : ctype;
        return t.trim();
    }

    private static String hint(int code) {
        if (code == 403) return "（服务器拒绝了请求，订阅可能需要鉴权或已过期）";
        if (code == 404) return "（地址不存在，订阅可能已失效）";
        if (code >= 500) return "（对方服务器出错）";
        return "";
    }
}