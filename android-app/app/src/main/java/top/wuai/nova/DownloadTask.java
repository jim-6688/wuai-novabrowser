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
    /**
     * 分片请求被无视过：探测时说支持（回了 206），真发 Range 却整份从头倒。
     *
     * <p>这是一个「已经在传输中途」才能发现的事实，和 {@link #rangeSupported}
     * 分开记 —— 后者是开工前的判断，前者要在收工后据此降级重跑。
     */
    public volatile boolean rangeIgnored;
    /** 已经从多线程降级成单线程过。界面与续传都要看它，且降级只允许发生一次。 */
    public volatile boolean degraded;
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

    /**
     * 服务器这次到底<b>认没认</b>我们发的 Range。
     *
     * <p>比 {@link #isPartialResponse} 多问了两句 —— 「起点对不对」和「终点有没有
     * 越出我们要的窗口」，这正是「不支持分片」的第二种判据：探测那一个字节时回了
     * 206，于是我们按八片规划；真发分片请求时却整份从头倒。只看「有没有
     * Content-Range」会把「{@code bytes 0-999/1000} 的整份 200」误判成分片，
     * 于是照单全收，拼出来的文件是「完整 + 完整」。
     *
     * <p><b>为什么终点也必须看</b>：整份从头倒的 200 里，最常见的一种会把
     * Content-Range 老实回写成 {@code bytes 0-(N-1)/N} —— 起点恰好是 0，
     * 而第一片请求的起点也恰好是 0。只比对起点的话，第一片永远被判成
     * 「服务端认了 Range」，于是整份 N 字节被无上限地写进一个只有 N/8 的分片；
     * 后面七片起点不为 0，照常被判「被无视」；降级时第一片又因为「已完成」
     * 被整片留下，合并出来是「完整 + 尾巴」。这个 bug 是 QA 端到端复现出来的。
     *
     * @param requestedStart 这一片请求的起始偏移
     * @param requestedEnd   这一片请求的结束偏移（含）
     * @return true = 服务器确实按我们要的那一段截断了
     */
    public static boolean honorsRange(int httpCode, String contentRange,
                                      long requestedStart, long requestedEnd) {
        if (httpCode == 206) return true;
        long start = contentRangeStart(contentRange);
        if (start < 0 || start != requestedStart) return false;
        long end = contentRangeEnd(contentRange);
        if (end < 0) return false;
        // 给得比要的少也算认了（剩下的下次补）；给得比要的多就是无视。
        return end >= requestedStart && end <= requestedEnd;
    }

    /**
     * 从 {@code bytes 100-199/1000} 里解出起点；解不出返回 -1。
     *
     * <p>刻意不复用 {@link #parseContentRangeTotal}：那个取的是斜杠后的总长，
     * 而这里要判断「身体是不是从 0 开始倒的」，只能看起点。
     */
    public static long contentRangeStart(String header) {
        if (header == null) return -1;
        String s = header.trim().toLowerCase(Locale.ROOT);
        int b = s.indexOf("bytes");
        if (b < 0) return -1;
        int sp = s.indexOf(' ', b);
        if (sp < 0) return -1;
        int dash = s.indexOf('-', sp);
        if (dash < 0) return -1;
        try {
            return Long.parseLong(s.substring(sp + 1, dash).trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /**
     * 从 {@code bytes 100-199/1000} 里解出终点（含）；解不出返回 -1。
     *
     * <p>终点写成星号（说不清给了多少）的按 -1 处理，也就是按「没认 Range」
     * 处理 —— 宁可降级，也不要赌。
     */
    public static long contentRangeEnd(String header) {
        if (header == null) return -1;
        String s = header.trim().toLowerCase(Locale.ROOT);
        int b = s.indexOf("bytes");
        if (b < 0) return -1;
        int sp = s.indexOf(' ', b);
        if (sp < 0) return -1;
        int dash = s.indexOf('-', sp);
        if (dash < 0) return -1;
        int slash = s.indexOf('/', dash);
        String num = slash < 0 ? s.substring(dash + 1) : s.substring(dash + 1, slash);
        num = num.trim();
        if (num.isEmpty() || num.startsWith("*")) return -1;
        try {
            return Long.parseLong(num);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /**
     * 降级之后的规划：一整条单连接，从 {@code start} 一直吞到文件末尾。
     *
     * @param start   这一片的起始偏移。降级时它必须是「已经连续下到的那个位置」，
     *                因为服务端不认 Range，只能整份从头倒、再把前面已有的丢掉。
     * @param total   文件总长；未知（{@code <=0}）时末字节按 {@code start} 记，
     *                长度因此是 1 —— 只是给进度一个非空的底，真正到哪儿由连接决定。
     */
    public static List<Chunk> singleFrom(long start, long total, String baseName, int index) {
        List<Chunk> out = new ArrayList<>();
        long end = total > 0 ? total - 1 : start;
        if (end < start) end = start;
        out.add(new Chunk(start, end, index, partName(baseName, index)));
        return out;
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