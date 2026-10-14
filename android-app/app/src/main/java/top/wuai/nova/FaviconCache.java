package top.wuai.nova;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Locale;

/**
 * 新标签页磁贴图标的抓取与缓存。
 *
 * <p><b>为什么要有这个类</b>：新标签页（{@code assets/newtab.html}）的 CSP 是
 * {@code default-src 'none'; img-src data:} —— 那一页刻意不许发任何外部请求
 * （它是一张本地页面，「锁死网络」是它当初的设计）。于是「自动获取站点图标」
 * 这件事在页面里根本做不了，只能由原生抓、原生缓存、再以 {@code data:} URI
 * 交给页面。这样页面那一条 CSP 不用放开，图标也不会每开一次新标签页就重新下载。
 *
 * <p><b>抓什么</b>：按 {@link #PATHS} 的顺序试站点自己的三处常规位置，
 * 先拿到的赢。不引任何第三方取图服务 —— 那等于把「用户去过哪些站点」
 * 交给一个陌生域名，它对一个浏览器来说是不可接受的代价。
 *
 * <p><b>多久抓一次</b>：{@link #TTL_MS} 天。站点换图标不是每天发生的事，
 * 而且这是「打开新标签页就能看到的东西」，晚几天用户不会察觉；
 * 反过来，每次开页都去抓一遍，等于把七个请求塞进每次新建标签的路径上。
 * 检查发生在 App 启动时（见 {@code MainActivity#warmFavicons}），
 * 页面侧永远只读本地缓存，打开即显示、不发请求。
 *
 * <p><b>取不到怎么办</b>：什么都不写，页面会回落成「渐变底 + 站点首字」。
 * 这是页面本来就有的那套（{@code NovaNtp.gradOf} / {@code initialOf}），
 * 所以「没有图标」不是一个需要单独做样式的状态。
 *
 * <p><b>为什么 .ico 要解开</b>：{@code /favicon.ico} 是命中率最高的一处，而它是个容器 ——
 * 里面的图有两种装法：直接放 PNG（Vista 之后，见 {@link #pngFromIco}），
 * 或者放一张老的 BMP 位图（见 {@link #bmpFromIco}）。只认头一种的话，
 * 一大批老站点（比如百度，实测它那份就是 64×64 的 32bpp BMP）会一家图标都拿不到，
 * 而它们恰恰是用户天天去的那批。BMP 那支解出来是裸像素，得再编码成 PNG
 * 才能交给页面（{@code img-src data:} 只收图片格式），这一步要用到
 * {@link android.graphics.Bitmap}，所以做成可注入的 {@link Encoder}：
 * 解析部分保持纯 JVM、能被单测直接跑，编码部分留在真机上。
 *
 * <p>纯解析部分（{@link #sniffMime}、{@link #pngFromIco}、{@link #bmpFromIco}、
 * {@link #fileNameFor}）是静态的、不碰 Android 类的，能被本地单测直接覆盖 ——
 * 这一层最容易出的错是「把别的东西当成图片存了下来」，那种错不会有异常，
 * 只会在页面上变成一个破图。
 */
public final class FaviconCache {

    /**
     * 缓存有效期：7 天。
     *
     * <p>与页面侧约定的「定期抓一次」对应。改成更短只是更费流量（每次启动
     * 都要重抓七个域名），改成更长会让站点换图标这件事迟迟不生效。
     */
    public static final long TTL_MS = 7L * 24 * 60 * 60 * 1000;

    /** 一次最多读多少字节。图标不该有几百 KB，超过就当这次抓取失败。 */
    private static final int MAX_BYTES = 512 * 1024;

    /** 连接与读取超时。这是后台任务，但不能挂太久 —— 它占着一条线程和一个连接。 */
    private static final int CONNECT_MS = 6000;
    private static final int READ_MS = 8000;

    /**
     * 取图顺序。
     *
     * <p>{@code /favicon.ico} 放在最前，因为它是唯一一个「约定俗成、不放也要放」的位置；
     * 后面两支是各站点自便的，命中率低但图更好看，所以放在备选。
     */
    private static final String[] PATHS = {
        "/favicon.ico", "/apple-touch-icon.png", "/favicon.png"
    };

    private static final String UA =
        "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) "
            + "Chrome/120.0.0.0 Mobile Safari/537.36";

    /** 抓到一个新图标时的回调。参数是主机名；主线程上调用。 */
    public interface OnFetched {
        void onFetched(String host);
    }

    /**
     * 裸像素 → PNG 字节。
     *
     * <p>抽成接口只是为了能在本地单测里把这一步换掉：这一步要用
     * {@link android.graphics.Bitmap}，而框架类在本地单测里是空壳，
     * 一碰就抛 {@code Stub!}。解析那半（纯 JVM）因此才测得动。
     */
    public interface Encoder {
        byte[] toPng(int[] argb, int width, int height);
    }

    private final File dir;
    private final Encoder encoder;
    private final Handler main = new Handler(Looper.getMainLooper());

    public FaviconCache(Context ctx) {
        this(new File(ctx.getCacheDir(), "favicons"), (argb, w, h) -> {
            android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(
                argb, w, h, android.graphics.Bitmap.Config.ARGB_8888);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
            bmp.recycle();
            return out.toByteArray();
        });
    }

    /** 单测用（也是上面那个构造器的真身）：缓存目录与编码器都能换掉，
     *  于是这一支里没有一行代码依赖 Android 框架，能在 JVM 上直接跑。 */
    FaviconCache(File dir, Encoder encoder) {
        this.dir = dir;
        this.encoder = encoder;
    }

    // ------------------------------------------------------------------ 读

    /** 取某主机的图标。没有缓存、缓存过期、或内容认不出来时返回 {@code null}。 */
    public String dataUri(String host) {
        File f = find(host);
        if (f == null) return null;
        if (System.currentTimeMillis() - f.lastModified() > TTL_MS) return null;
        String mime = mimeOfExt(extOfFile(f.getName()));
        if (mime == null) return null;
        try {
            byte[] b = readAll(f);
            if (b == null || b.length == 0) return null;
            return "data:" + mime + ";base64," + Base64.encodeToString(b, Base64.NO_WRAP);
        } catch (Exception e) {
            // 读不出来就当没有：这是「锦上添花」的东西，任何时候都不该让页面出错。
            return null;
        }
    }

    /**
     * 把这批主机里**已经有图标**的那些拼成一份 JSON 字面量（主机名 → data URI），
     * 供注入页面用（{@code window.__novaIcons}）。
     *
     * <p>没有图标的那些刻意不出现在结果里，而不是给一个空字符串：页面那边
     * 只判「取不取得到」，不需要区分「没抓过」和「抓过但失败了」——
     * 两者的表现都该是回落成渐变底。
     */
    public String jsonFor(List<String> hosts) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        if (hosts != null) {
            for (String h : hosts) {
                if (h == null || h.isEmpty()) continue;
                String uri = dataUri(h);
                if (uri == null) continue;
                if (!first) sb.append(',');
                first = false;
                sb.append(jsonStr(h)).append(':').append(jsonStr(uri));
            }
        }
        return sb.append('}').toString();
    }

    // ------------------------------------------------------------------ 写

    /**
     * 过期的那些，后台抓一轮。
     *
     * <p>单线程队列：一次抓七个域名本来就是串行的（它们各自要连 DNS、拿 TLS），
     * 并发反而会把那几秒的流量堆在同一个时间窗口里。
     *
     * <p>每一项成功都回调一次，而不是等整轮跑完再回调一次 —— 先抓到的那些
     * 应该立刻出现在页面上，不用等最慢的那家（有一家连不上就要多等 6 秒超时）。
     */
    public void refreshIfStale(final List<String> hosts, final OnFetched onFetched) {
        if (hosts == null || hosts.isEmpty()) return;
        new Thread(() -> {
            for (String h : hosts) {
                if (h == null || h.isEmpty()) continue;
                if (isFresh(h)) continue;
                if (fetch(h)) {
                    if (onFetched != null) {
                        final String host = h;
                        main.post(() -> onFetched.onFetched(host));
                    }
                }
            }
        }, "nova-favicon").start();
    }

    /** 缓存里的这份还新不新。 */
    private boolean isFresh(String host) {
        File f = find(host);
        return f != null && System.currentTimeMillis() - f.lastModified() <= TTL_MS;
    }

    /** 抓一家站点，成功落盘返回 true。 */
    private boolean fetch(String host) {
        for (String path : PATHS) {
            byte[] raw = get("https://" + host + path);
            if (raw == null) continue;
            String mime = sniffMime(raw);
            byte[] img = raw;
            if (mime == null) {
                // 不是浏览器直接认得的格式。最可能是一个 .ico 壳，里面装着
                // PNG（新式）或者 BMP（老式）—— 两种都试一遍。
                img = pngFromIco(raw);
                if (img == null) img = pngFromBmpIco(raw);
                mime = img == null ? null : "image/png";
            }
            if (mime == null) continue;
            if (store(host, img, mime)) return true;
        }
        return false;
    }

    private byte[] get(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(CONNECT_MS);
            c.setReadTimeout(READ_MS);
            c.setRequestProperty("User-Agent", UA);
            // 各家 CDN 对「没有 Referer 的图片请求」反应不一，带上自己的主页地址最稳。
            c.setRequestProperty("Accept", "image/*,*/*;q=0.8");
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) return null;
            return readLimited(c.getInputStream(), MAX_BYTES);
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private boolean store(String host, byte[] data, String mime) {
        try {
            if (!dir.exists() && !dir.mkdirs()) return false;
            String name = fileNameFor(host);
            // 先清掉这个主机的旧文件：站点换了格式（png → webp）时，
            // 留着旧的那份会被 find() 先撞上，于是「换了图标却还是旧图」。
            File[] old = dir.listFiles();
            if (old != null) {
                String prefix = name + ".";
                for (File f : old) {
                    if (f.getName().startsWith(prefix)) f.delete();
                }
            }
            File out = new File(dir, name + "." + extOf(mime));
            FileOutputStream os = new FileOutputStream(out);
            try {
                os.write(data);
                os.flush();
            } finally {
                os.close();
            }
            out.setLastModified(System.currentTimeMillis());
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private File find(String host) {
        if (host == null || host.isEmpty()) return null;
        String name = fileNameFor(host);
        for (String ext : new String[] {"png", "jpg", "webp", "gif"}) {
            File f = new File(dir, name + "." + ext);
            if (f.isFile()) return f;
        }
        return null;
    }

    // ------------------------------------------------------------ 纯解析

    /**
     * 认字节头，返回 MIME；认不出来返回 {@code null}。
     *
     * <p>为什么不看 {@code Content-Type}：那是我方请求方自己声明的，而这里恰恰
     * 见过不少站点把图标当 {@code text/html} 发（404 页面配 200 状态码）。
     * 字节头不会撒谎。
     */
    static String sniffMime(byte[] b) {
        if (b == null || b.length < 12) return null;
        if ((b[0] & 0xFF) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "image/png";
        if ((b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xD8 && (b[2] & 0xFF) == 0xFF) {
            return "image/jpeg";
        }
        if (b[0] == 'G' && b[1] == 'I' && b[2] == 'F') return "image/gif";
        if (b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
            && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') {
            return "image/webp";
        }
        return null;
    }

    /**
     * 从 {@code .ico} 里抠出那份 PNG；抠不出来返回 {@code null}。
     *
     * <p>绝大多数站点的 {@code favicon.ico} 其实是「一个 ICO 壳，装着几张 PNG」——
     * ICO 格式从 Vista 起允许条目直接放 PNG 数据，各家图标工具默认就这么导。
     * 于是这里不用写 ICO/BMP 解码器，只要认出 ICONDIR、挑一张 PNG 条目取出来。
     *
     * <p>挑最大的那张：最小那张（16×16）在 30dp 的磁贴上糊得看不出是什么，
     * 而它在文件里的顺序并不保证是最后一张。
     *
     * <p>整包都是 BMP 的老图标（XP 时代留下的那种）取不出来 → 返回 {@code null}，
     * 调用方当作这次抓取失败，页面回落成「渐变底 + 首字」，而不是显示一个花屏。
     */
    static byte[] pngFromIco(byte[] b) {
        if (b == null || b.length < 22) return null;
        // ICONDIR: reserved(2)=0, type(2)=1, count(2)
        if ((b[0] & 0xFF) != 0 || (b[1] & 0xFF) != 0) return null;
        if ((b[2] & 0xFF) != 1 || (b[3] & 0xFF) != 0) return null;
        int count = u16(b, 4);
        int bestOff = -1;
        int bestLen = -1;
        for (int i = 0; i < count; i++) {
            int e = 6 + i * 16;
            if (e + 16 > b.length) break;
            int size = u32(b, e + 8);
            int off = u32(b, e + 12);
            if (size <= 0 || off < 0 || off + size > b.length) continue;
            if (!isPng(b, off)) continue;
            if (size > bestLen) {
                bestLen = size;
                bestOff = off;
            }
        }
        if (bestOff < 0) return null;
        byte[] out = new byte[bestLen];
        System.arraycopy(b, bestOff, out, 0, bestLen);
        return out;
    }

    /**
     * 老式 {@code .ico}（里面装的是 BMP 位图）→ PNG 字节。
     *
     * <p>两步分开是为了可测：{@link #bmpFromIco} 是纯解析（能单测），
     * 编码交给 {@link Encoder}（真机上用 Bitmap）。
     */
    byte[] pngFromBmpIco(byte[] b) {
        if (b == null || encoder == null) return null;
        int[] wh = new int[2];
        int[] argb = bmpFromIco(b, wh);
        if (argb == null) return null;
        try {
            byte[] png = encoder.toPng(argb, wh[0], wh[1]);
            return png == null || png.length == 0 ? null : png;
        } catch (Exception | OutOfMemoryError e) {
            // 解一张图失败（或者刚好内存紧张）不该影响别的站点，也不该崩。
            return null;
        }
    }

    /**
     * 把 ICO 里那张 BMP 位图解成 ARGB 像素；解不出来返回 {@code null}。
     *
     * <p>只认最常见的两种规格：<b>32bpp 带 alpha</b>（现代工具导出的默认，实测百度那份
     * 就是这个）与 <b>24bpp 不透明</b>（老工具，透明度靠跟在后面的 AND 掩码给）。
     * 调色板那一类（1/4/8bpp）与带压缩的一律返回 {@code null}：它们要么得先建调色板，
     * 要么得写解码器，而收益只是再多几个站点的图标 —— 那些站点会走渐变底 + 首字，
     * 不会显示成破图。
     *
     * @param outWH 长度 ≥2 时写入宽高（{@code [0]}=宽、{@code [1]}=高）
     */
    static int[] bmpFromIco(byte[] b, int[] outWH) {
        if (b == null || b.length < 22) return null;
        if ((b[0] & 0xFF) != 0 || (b[1] & 0xFF) != 0) return null;
        if ((b[2] & 0xFF) != 1 || (b[3] & 0xFF) != 0) return null;
        int count = u16(b, 4);
        int bestOff = -1;
        int bestLen = -1;
        for (int i = 0; i < count; i++) {
            int e = 6 + i * 16;
            if (e + 16 > b.length) break;
            int size = u32(b, e + 8);
            int off = u32(b, e + 12);
            if (size <= 0 || off < 0 || off + 22 > b.length) continue;
            if (isPng(b, off)) continue;
            if (size > bestLen) {
                bestLen = size;
                bestOff = off;
            }
        }
        if (bestOff < 0) return null;

        int biSize = u32(b, bestOff);
        if (biSize < 40) return null;                 // BITMAPCOREHEADER（12 字节）不支持
        int w = u32(b, bestOff + 4);
        int rawH = u32(b, bestOff + 8);
        int bpp = u16(b, bestOff + 14);
        int compression = u32(b, bestOff + 16);
        if (w <= 0 || w > 4096 || rawH == 0 || compression != 0) return null;
        if (bpp != 32 && bpp != 24) return null;
        // ICO 里的高度是真实高度的两倍：下面还跟着一份 1bpp 的 AND 掩码。
        int h = Math.abs(rawH) / 2;
        if (h <= 0 || h > 4096) return null;

        int stride = ((w * bpp + 31) / 32) * 4;
        int px = bestOff + biSize;
        if (px + (long) stride * h > b.length) return null;
        // 24bpp 没有 alpha 通道，透明度全在掩码里（置 1 的位表示「透明」）。
        int maskStride = ((w + 31) / 32) * 4;
        int mask = px + stride * h;
        boolean hasMask = rawH > 0 && mask + (long) maskStride * h <= b.length;

        int[] argb = new int[w * h];
        boolean bottomUp = rawH > 0;
        for (int y = 0; y < h; y++) {
            int row = bottomUp ? (h - 1 - y) : y;
            int src = px + row * stride;
            int dst = y * w;
            int mrow = mask + row * maskStride;
            for (int x = 0; x < w; x++) {
                int i = src + x * (bpp / 8);
                int blue = b[i] & 0xFF;
                int green = b[i + 1] & 0xFF;
                int red = b[i + 2] & 0xFF;
                int alpha = bpp == 32 ? (b[i + 3] & 0xFF) : 0xFF;
                if (bpp == 24 && hasMask && (b[mrow + (x >> 3)] & (0x80 >> (x & 7))) != 0) {
                    alpha = 0;
                }
                argb[dst + x] = (alpha << 24) | (red << 16) | (green << 8) | blue;
            }
        }
        if (outWH != null && outWH.length >= 2) {
            outWH[0] = w;
            outWH[1] = h;
        }
        return argb;
    }

    /**
     * 主机名 → 文件名。
     *
     * <p>正常主机名里只有字母数字、点和连字符。出现别的（用户手输的怪地址、
     * 或者别的调用方传进来一个带路径的串）一律换成下划线 —— 否则
     * {@code ../../files/x} 这种输入会让 {@code new File(dir, name)} 写到目录外面去。
     * 这是这一层唯一的输入校验，值 20 行。
     */
    static String fileNameFor(String host) {
        String h = host == null ? "" : host.toLowerCase(Locale.ROOT);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < h.length() && sb.length() < 80; i++) {
            char c = h.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-';
            sb.append(ok ? c : '_');
        }
        return sb.length() == 0 ? "site" : sb.toString();
    }

    private static boolean isPng(byte[] b, int off) {
        return off + 4 <= b.length && (b[off] & 0xFF) == 0x89 && b[off + 1] == 'P'
            && b[off + 2] == 'N' && b[off + 3] == 'G';
    }

    private static int u16(byte[] b, int i) {
        return (b[i] & 0xFF) | ((b[i + 1] & 0xFF) << 8);
    }

    private static int u32(byte[] b, int i) {
        return (b[i] & 0xFF) | ((b[i + 1] & 0xFF) << 8)
            | ((b[i + 2] & 0xFF) << 16) | ((b[i + 3] & 0xFF) << 24);
    }

    private static String extOf(String mime) {
        if ("image/jpeg".equals(mime)) return "jpg";
        if ("image/webp".equals(mime)) return "webp";
        if ("image/gif".equals(mime)) return "gif";
        return "png";
    }

    private static String mimeOfExt(String ext) {
        if ("jpg".equals(ext)) return "image/jpeg";
        if ("webp".equals(ext)) return "image/webp";
        if ("gif".equals(ext)) return "image/gif";
        if ("png".equals(ext)) return "image/png";
        return null;
    }

    /** 取文件名里最后那一段扩展名（小写，不带点）。 */
    private static String extOfFile(String name) {
        int i = name.lastIndexOf('.');
        return i < 0 ? "" : name.substring(i + 1).toLowerCase(Locale.ROOT);
    }

    /** 拼 JSON 字符串字面量。只处理这一层真的会遇到的字符。 */
    private static String jsonStr(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c < 0x20) sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
            else sb.append(c);
        }
        return sb.append('"').toString();
    }

    private static byte[] readAll(File f) throws Exception {
        InputStream in = new java.io.FileInputStream(f);
        try {
            return readLimited(in, MAX_BYTES);
        } finally {
            in.close();
        }
    }

    private static byte[] readLimited(InputStream in, int max) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (out.size() > max) return null;
        }
        return out.toByteArray();
    }
}
