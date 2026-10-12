package top.wuai.nova;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 吾爱Nova浏览器 · 下载任务的纯逻辑部分。
 *
 * <p>刻意不碰任何 Android 类：分片切分、文件名推断、进度换算这些是「算错了用户会
 * 拿到一个损坏文件」的地方，必须能在本地 JVM 上单测。IO 与线程调度在
 * {@link Downloader} 里。
 *
 * <h3>为什么不用 Android 自带的 DownloadManager</h3>
 *
 * <p>它做不到两件我们要的事：<b>同一文件的多线程分片</b>（它只有一条下载队列），
 * 以及<b>把已完成的部分留着、下次接着下</b>（它下完就删中间文件）。
 * 手机浏览器里大文件很常见，这两件正好是最有用的。
 *
 * <h3>多线程分片的真实风险</h3>
 *
 * <p>服务器不认 Range 时，第二片拿回的是<b>整个文件</b>，而不��从第二片偏移处的内容。
 * 这时如果照单全收，文件会变成「完整文件 + 完整文件 + …」—— 而且它<b>大小正常</b>，
 * 不会报错，只有播到一半才炸。所以 {@link #plan} 强制先做一次探测：
 * 拿首片的前若干字节，顺带把服务器到底认不认 Range 问清楚。
 */
public final class DownloadTask {

    /** 一个下载任务的状态机。 */
    public enum State {
        /** 还没开始（在等线程） */
        QUEUED("排队中"),
        /** 正在拿响应头 */
        PROBING("探测服务器"),
        /** 正在传输 */
        RUNNING("下载中"),
        /** 全部片段已落盘，正在合并 */
        MERGING("合并分片"),
        DONE("已完成"),
        /** 用户按了暂停 */
        PAUSED("已暂停"),
        /** 出错了。{@link #error} 里必须有可展示给用户的中文原因。 */
        FAILED("失败"),
        /** 用户按了取消。不再重试，临时文件会被清掉 */
        CANCELED("已取消");

        public final String label;

        State(String label) { this.label = label; }

        public boolean isTerminal() {
            return this == DONE || this == FAILED || this == CANCELED;
        }

        /** 还能不能接着下。只有临时文件还在才有意义。 */
        public boolean resumable() {
            return this == PAUSED || this == FAILED;
        }
    }

    /** 一个字节区间。左闭右开，与 HTTP Range 的语义一致。 */
    public static final class Chunk {
        public final long start;
        public final long endInclusive;
        public final int index;
        /** 该片已落盘的文件名（{@code <任务名>.part<序号>}），合并时按 index 排 */
        public final String fileName;
        /** 已经写进去的字节数，用于断点续传时算进度 */
        public volatile long received;

        public Chunk(long start, long endInclusive, int index, String fileName) {
            this.start = start;
            this.endInclusive = endInclusive;
            this.index = index;
            this.fileName = fileName;
        }

        public long length() { return endInclusive - start + 1; }

        public boolean complete() { return received >= length(); }

        @Override
        public String toString() {
            return "[" + index + "] " + start + "-" + endInclusive;
        }
    }

    public final long id;
    public final String url;
    public final String suggestedName;
    /** 服务器给出的最终文件名，可能与建议名不同（Content-Disposition 优先） */
    public volatile String fileName;
    public volatile long totalBytes = -1;
    public volatile State state = State.QUEUED;
    public volatile String error = "";
    public volatile long receivedBytes;
    public final List<Chunk> chunks = new ArrayList<>();
    /** 服务器认不认 Range。false 时整个分片方案退化成单线程。 */
    public volatile boolean rangeSupported;
    public volatile long createdAt;

    public DownloadTask(long id, String url, String suggestedName, long createdAt) {
        this.id = id;
        this.url = url;
        this.suggestedName = suggestedName;
        this.fileName = suggestedName;
        this.createdAt = createdAt;
    }

    // ------------------------------------------------------------ 分片

    /**
     * 切分字节区间。
     *
     * @param total     文件总长
     * @param threads   并行数。1 就不分片（这是最省事也最常见的情况）
     * @param useRange  服务器是否认 Range。不认就必须单片，否则会写出损坏文件
     */
    public static List<Chunk> plan(long total, int threads, boolean useRange, String baseName) {
        List<Chunk> out = new ArrayList<>();
        int n = (!useRange || threads <= 1 || total <= 0) ? 1 : threads;
        if (n == 1) {
            out.add(new Chunk(0, Math.max(0, total - 1), 0, partName(baseName, 0)));
            return out;
        }
        // 每片至少 1 字节；总量比线程数还小时片数要收窄，
        // 否则会切出「长度 0 的片」，它在 HTTP 里是非法的（Range: bytes=5-4）。
        int count = (int) Math.min(n, total);
        long each = total / count;
        long remainder = total % count;
        long cursor = 0;
        for (int i = 0; i < count; i++) {
            // 余数分给前几片，让各片长度最多差 1 字节
            long len = each + (i < remainder ? 1 : 0);
            long end = cursor + len - 1;
            out.add(new Chunk(cursor, end, i, partName(baseName, i)));
            cursor = end + 1;
        }
        return out;
    }

    /** 从服务器的 Content-Range 头里解析总长与是否完整覆盖。 */
    public static long parseContentRangeTotal(String header) {
        if (header == null) return -1;
        // 形如 bytes 0-1023/45678，斜杠后是总长；未知时是 *
        int slash = header.lastIndexOf('/');
        if (slash < 0 || slash == header.length() - 1) return -1;
        String tail = header.substring(slash + 1).trim();
        if (tail.equals("*")) return -1;
        try {
            long v = Long.parseLong(tail);
            return v > 0 ? v : -1;
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** 判断这次响应是不是「我们要的那一段」而不是整个文件。 */
    public static boolean isPartialResponse(int httpCode, String contentRange) {
        if (httpCode == 206) return true;
        // 200 也可以是分片 —— 有些服务器用 200 但照样按 Range 截断，
        // 判据是 Content-Range 存在且写着起止点。
        if (contentRange == null || !contentRange.contains("bytes")) return false;
        String head = contentRange.trim();
        int dash = head.indexOf('-');
        return dash > 0;
    }

    // ------------------------------------------------------------ 文件名

    /**
     * 从 Content-Disposition 里取文件名。
     *
     * <p>优先用服务器给的名字而不是 URL 末段 —— 很多下载链接末段是 {@code /download?id=123}
     * 这种，截出来毫无意义。解析不了就返回 null，让调用方退回 URL 推断。
     */
    public static String nameFromDisposition(String header) {
        if (header == null) return null;
        String lower = header.toLowerCase(Locale.ROOT);
        int at = lower.indexOf("filename*");
        if (at >= 0) {
            // RFC 5987：filename*=UTF-8''%E4%B8%AD%E6%96%87.mp4
            // 必须是 filename* 而不是 filename —— 很多站点两者都给，
            // 前者才是百分号编码过的那个（中文文件名只出现在它里）。
            int q1 = header.indexOf('\'', at);
            int q2 = q1 < 0 ? -1 : header.indexOf('\'', q1 + 1);
            if (q2 > 0) {
                String charset = header.substring(q1 + 1, q2);
                String encoded = header.substring(q2 + 1).trim();
                int semi = encoded.indexOf(';');
                if (semi > 0) encoded = encoded.substring(0, semi);
                String clean = sanitize(percentDecode(encoded, charset));
                if (!clean.isEmpty()) return clean;
            }
        }
        int f = lower.indexOf("filename");
        if (f >= 0) {
            int eq = header.indexOf('=', f);
            if (eq > 0) {
                String raw = header.substring(eq + 1).trim();
                int semi = raw.indexOf(';');
                if (semi > 0) raw = raw.substring(0, semi);
                raw = raw.trim();
                if (raw.length() >= 2 && raw.startsWith("\"") && raw.endsWith("\"")) {
                    raw = raw.substring(1, raw.length() - 1);
                }
                String clean = sanitize(raw);
                if (!clean.isEmpty()) return clean;
            }
        }
        return null;
    }

    /**
     * 百分号解码。
     *
     * <p>字符集名不可信 —— 有些服务器会填 {@code ISO-8859-1} 甚至乱填，
     * 对这两种情况 {@link java.net.URLDecoder} 会抛异常。所以退化到 UTF-8 重试，
     * 再不行就把 {@code +} 当空格去掉就返回，宁可文件名有一处不完美也不要整条失败。
     */
    private static String percentDecode(String s, String charset) {
        if (s == null || s.indexOf('%') < 0) return s == null ? "" : s.replace("+", " ");
        try {
            return java.net.URLDecoder.decode(s, charset);
        } catch (Exception e) {
            try {
                return java.net.URLDecoder.decode(s, "UTF-8");
            } catch (Exception e2) {
                return s.replace("+", " ");
            }
        }
    }

    /**
     * 清掉文件名里不能用的字符。
     *
     * <p>Android 与桌面文件系统都不接受 {@code / \ : * ? " < > |} 和控制字符，
     * 而且以点开头/结尾的名字在某些系统上会「消失」（{@code .} 与 {@code ..}）。
     * 有一个总比没有强：宁可改成下划线，也不要让保存直接失败。
     */
    public static String sanitize(String raw) {
        if (raw == null) return "";
        String s = raw.trim().replace('\\', '_');
        s = s.replaceAll("[/:\\*?\"<>|\\x00-\\x1F]", "_");
        s = s.trim();
        while (s.startsWith(".")) s = s.substring(1);
        while (s.endsWith(".")) s = s.substring(0, s.length() - 1);
        if (s.length() > 120) {
            // 超长名在很多手机上会存不下。按「留扩展名」的方式截。
            int dot = s.lastIndexOf('.');
            String ext = (dot > 0 && s.length() - dot <= 8) ? s.substring(dot) : "";
            s = s.substring(0, 120 - ext.length()) + ext;
        }
        return s.trim();
    }

    /** URL 里取不出干净名字时的兜底：取末段，没有就自己造一个。 */
    public static String nameFromUrl(String url) {
        if (url == null) return "";
        String s = url;
        int q = s.indexOf('?');
        if (q >= 0) s = s.substring(0, q);
        int h = s.indexOf('#');
        if (h >= 0) s = s.substring(0, h);
        int slash = s.lastIndexOf('/');
        if (slash >= 0 && slash < s.length() - 1) {
            s = s.substring(slash + 1);
        } else {
            // 末段没有名字（以斜杠结尾，或根本没有路径）——
            // 此时 s 还带着 host 和 scheme，必须整个丢掉。
            s = "";
        }
        String clean = sanitize(s);
        return clean.isEmpty() ? "download" : clean;
    }

    public static String partName(String baseName, int index) {
        return baseName + ".part" + index;
    }

    // ------------------------------------------------------------ 进度

    /** 已收字节合计。分片时等于各片之和。 */
    public long received() {
        if (chunks.isEmpty()) return receivedBytes;
        long sum = 0;
        for (Chunk c : chunks) sum += c.received;
        return sum;
    }

    /**
     * 进度百分比 0–100。总长未知时给 -1，让界面显示「已下载 X」而不是假装知道百分比。
     *
     * <p>刻意不返回 0：总长未知时显示「0%」会让用户以为卡住了。
     */
    public int percent() {
        if (totalBytes <= 0) return -1;
        long got = received();
        if (got >= totalBytes) return 100;
        return (int) (got * 100 / totalBytes);
    }

    public static String human(long bytes) {
        if (bytes < 0) return "未知";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) {
            return String.format(Locale.ROOT, "%.1f KB", bytes / 1024.0);
        }
        if (bytes < 1024L * 1024 * 1024) {
            return String.format(Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024));
        }
        return String.format(Locale.ROOT, "%.2f GB", bytes / (1024.0 * 1024 * 1024));
    }

    /** 一行状态文字，给下载列表用。 */
    public String statusLine() {
        switch (state) {
            case DONE:
                return "已完成 · " + human(totalBytes);
            case FAILED:
                return "失败：" + (error.isEmpty() ? "未知原因" : error);
            case CANCELED:
                return "已取消";
            case PAUSED:
                return "已暂停 · 已下载 " + human(received());
            default:
                int p = percent();
                String left = p < 0
                    ? human(received())
                    : p + "%（" + human(received()) + " / " + human(totalBytes) + "）";
                return state.label + " · " + left;
        }
    }

    /** 合并前必须检查的分片是否都齐了。少一片合并出来的文件就是缺一段。 */
    public List<Chunk> incompleteChunks() {
        List<Chunk> out = new ArrayList<>();
        for (Chunk c : chunks) {
            if (!c.complete()) out.add(c);
        }
        return out;
    }

    /** 清掉临时文件名前缀列表，删除时用。 */
    public List<String> tempFiles() {
        List<String> out = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (Chunk c : chunks) {
            if (seen.add(c.fileName)) out.add(c.fileName);
        }
        return out;
    }

    @Override
    public String toString() {
        return "DownloadTask{" + fileName + " " + state + " " + percent() + "%}";
    }
}