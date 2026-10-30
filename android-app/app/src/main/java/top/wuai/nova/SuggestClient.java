package top.wuai.nova;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 搜索引擎的补全接口。**会联网**，所以只在后台线程调用，超时很短，失败一律当「没有建议」。
 *
 * <p>为什么不自己维护一张「中文名 → 网址」表：站点会改、会关、会被仿冒，一张没人维护的
 * 映射表迟早给出错网址 —— 那比不给建议更糟。补全接口给的是「你可能想搜什么」，
 * 不会指错地方；真要把「知乎」变成 zhihu.com，靠的是本机的书签与历史。
 *
 * <p>接口按设置里的搜索引擎选；自定义引擎没有补全接口，直接返回空。
 */
public final class SuggestClient {

    private static final int CONNECT_TIMEOUT_MS = 2500;
    private static final int READ_TIMEOUT_MS = 2500;
    /** 响应上限：补全结果都是几 KB，超过这个数说明拿到的不是补全。 */
    private static final int MAX_BYTES = 64 * 1024;

    private SuggestClient() {
    }

    /** 这个引擎有没有可用的补全接口。 */
    public static boolean supported(String engineId) {
        return endpoint(engineId, "x") != null;
    }

    /**
     * 取补全建议。阻塞调用，**必须在后台线程**里用。
     *
     * @return 建议列表；任何异常都返回空表（联想失败不该影响打字）
     */
    public static List<String> fetch(String engineId, String query, String ua) {
        String url = endpoint(engineId, query);
        if (url == null) return new ArrayList<>();
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(CONNECT_TIMEOUT_MS);
            c.setReadTimeout(READ_TIMEOUT_MS);
            c.setRequestProperty("Accept", "application/json, text/javascript, */*");
            if (ua != null && !ua.isEmpty()) c.setRequestProperty("User-Agent", ua);
            c.setInstanceFollowRedirects(true);
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) return new ArrayList<>();
            return OmniSuggest.parseSuggest(readAll(c.getInputStream()));
        } catch (Exception e) {
            return new ArrayList<>();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 各引擎的补全端点；不支持的返回 null。 */
    static String endpoint(String engineId, String q) {
        String id = engineId == null ? "" : engineId;
        String enc = enc(q);
        switch (id) {
            case "baidu":
                return "https://www.baidu.com/sugrec?prod=pc&wd=" + enc;
            case "bing":
                return "https://api.bing.com/osjson.aspx?query=" + enc;
            case "google":
                return "https://suggestqueries.google.com/complete/search?client=firefox&q=" + enc;
            default:
                // 自定义引擎：没有公开的补全协议，不做猜测
                return null;
        }
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s == null ? "" : s, "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        int total = 0;
        while ((n = in.read(buf)) > 0) {
            bos.write(buf, 0, n);
            total += n;
            if (total > MAX_BYTES) break;
        }
        in.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }
}
