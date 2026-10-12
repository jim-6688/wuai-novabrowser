package top.wuai.nova;

import android.os.Handler;
import android.os.Looper;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 吾爱Nova浏览器 · 下载执行器。
 *
 * <h3>线程模型</h3>
 *
 * <p>一个任务 = N 个分片线程（{@code ExecutorService}，N 就是设置里的并行数）
 * + 一个合并线程。全局共用一个线程池，按任务数限流 —— 不按线程数限流的话，
 * 十个任务各开八片就是 80 个连接，手机直接卡死。
 *
 * <h3>进度通知的节流</h3>
 *
 * <p>每写 8KB 就往主线程 post 一次的话，一个 4G 视频会产生几千次 post，
 * 界面会一直忙于处理回调反而卡。改成「字节变化超过阈值或状态变了才通知」。
 *
 * <h3>断点续传</h3>
 *
 * <p>每片一个 {@code .part<序号>} 文件，暂停/失败都不删。下次继续时按文件实际长度
 * 算出「还差多少」，从那个偏移接着写 —— 这比记一个偏移量可靠：文件被系统清理过
 * 或写了一半断电时，偏移量会骗人，文件长度不会。
 */
public final class Downloader {

    /** 状态变化的回调。全部在主线程。 */
    public interface Listener {
        /** 任意变化都会来一次（节流后）。 */
        void onChange(DownloadTask task);
        /** 任务全部结束（成功、失败、取消都会来），紧接着 onChange 之后。 */
        void onSettled(DownloadTask task);
    }

    private static final int BUF = 16 * 1024;
    /** 进度通知的最小字节间隔 */
    private static final long NOTIFY_EVERY = 128 * 1024;

    private final File dir;
    private final int threads;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicLong nextId = new AtomicLong(1);
    private final Map<Long, DownloadTask> live = new ConcurrentHashMap<>();
    private final List<DownloadTask> history = new ArrayList<>();

    private ExecutorService pool;
    /**
     * 分片传输池。任务调度池({@link #pool})与它必须分开：
     * {@code run()} 本身就占着调度池的一个线程，若分片也往同一个池里投
     * 并同步等待，池会被自己的任务占满而死锁。分开之后，
     * 「总并发连接数」也被锁死在 {@code threads} 上，多出来的排队而不是一起挤。
     */
    private ExecutorService chunkPool;

    public Downloader(File dir, int threads, Listener listener) {
        this.dir = dir;
        this.threads = Math.max(1, Math.min(16, threads));
        this.listener = listener;
        if (!dir.exists()) dir.mkdirs();
    }

    public List<DownloadTask> tasks() { return history; }

    public DownloadTask find(long id) { return live.get(id); }

    // ------------------------------------------------------------ 生命周期

    private ExecutorService pool() {
        if (pool == null || pool.isShutdown()) {
            pool = Executors.newFixedThreadPool(threads, new ThreadFactory() {
                private final AtomicInteger seq = new AtomicInteger();
                @Override
                public Thread newThread(Runnable r) {
                    Thread t = new Thread(r, "nova-dl-" + seq.incrementAndGet());
                    t.setPriority(Thread.NORM_PRIORITY - 1);
                    return t;
                }
            });
        }
        return pool;
    }

    /**
     * 分片传输池。只在 {@link #fetchChunks} / {@link #resumeChunks} 里取用，
     * 大小固定为 {@code threads} —— 于是无论同时跑多少个任务，
     * 对外建立的连接总数都不会超过 {@code threads}。
     */
    private ExecutorService chunkPool() {
        if (chunkPool == null || chunkPool.isShutdown()) {
            chunkPool = Executors.newFixedThreadPool(threads, new ThreadFactory() {
            private final AtomicInteger seq = new AtomicInteger();
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "nova-chunk-" + seq.incrementAndGet());
                t.setPriority(Thread.NORM_PRIORITY - 1);
                return t;
            }
        });
        }
        return chunkPool;
    }

    public void shutdown() {
        if (pool != null) pool.shutdown();
        if (chunkPool != null) chunkPool.shutdown();
    }

    /** 清单：要新增几个任务。返回新增的任务列表。 */
    public List<DownloadTask> enqueue(List<String> urls, List<String> suggestedNames) {
        List<DownloadTask> out = new ArrayList<>();
        for (int i = 0; i < urls.size(); i++) {
            String u = urls.get(i);
            if (u == null || u.trim().isEmpty()) continue;
            String hint = (suggestedNames != null && i < suggestedNames.size())
                ? suggestedNames.get(i) : null;
            String name = DownloadTask.sanitize(hint);
            if (name == null || name.isEmpty()) {
                name = DownloadTask.nameFromUrl(u);
            }
            DownloadTask t = new DownloadTask(nextId.getAndIncrement(), u.trim(), name,
                System.currentTimeMillis());
            history.add(t);
            live.put(t.id, t);
            out.add(t);
        }
        for (DownloadTask t : out) start(t);
        return out;
    }

    public void pause(DownloadTask t) {
        if (t.state.isTerminal()) return;
        t.state = DownloadTask.State.PAUSED;
        notifyChange(t);
    }

    /**
     * 取消。临时文件由谁删，取决于有没有分片线程还在跑：
     *
     * <ul>
     *   <li><b>还在跑</b>：只置状态，删除交给 {@link #fetchChunks} 在 latch 归零后做。
     *       此刻线程正持有 {@code .part} 的写句柄，这里删会与写操作打架 ——
     *       要么删掉又被写回来（残留文件），要么写着写着文件没了（IO 异常）。</li>
     *   <li><b>已经停了</b>（排队中 / 已暂停 / 已失败）：没有并发写，这里直接删。</li>
     * </ul>
     */
    public void cancel(DownloadTask t) {
        if (t.state.isTerminal()) return;
        boolean running = t.state == DownloadTask.State.RUNNING
                || t.state == DownloadTask.State.PROBING
                || t.state == DownloadTask.State.MERGING;
        t.state = DownloadTask.State.CANCELED;
        if (!running) deleteTemps(t);
        notifyChange(t);
        notifySettled(t);
    }

    /** 断点续传：重新跑一遍，已下的部分不会重下。 */
    public void resume(DownloadTask t) {
        if (!t.state.resumable()) return;
        t.error = "";
        start(t);
    }

    public void remove(DownloadTask t) {
        cancel(t);
        live.remove(t.id);
        history.remove(t);
    }

    // ------------------------------------------------------------ 执行

    private void start(DownloadTask t) {
        t.state = DownloadTask.State.PROBING;
        notifyChange(t);
        pool().execute(() -> run(t));
    }

    private void run(DownloadTask t) {
        try {
            // ---- 1. 探测：拿响应头与服务器给的真实文件名
            HttpURLConnection head = open(t.url, null, null);
            int code = head.getResponseCode();
            if (code >= 400) {
                throw new IOException("服务器返回 " + code + httpHint(code));
            }
            String disposition = head.getHeaderField("Content-Disposition");
            String dispName = DownloadTask.nameFromDisposition(disposition);
            if (dispName != null) t.fileName = dispName;
            if (t.chunks.isEmpty()) {
                t.totalBytes = contentLength(head);
            }
            head.disconnect();

            // ---- 2. 实测服务器认不认 Range。
            //
            // 必须真的发一个带 Range 的请求：不带 Range 的普通响应里不会有
            // Content-Range，于是「看 Content-Range 是否存在」这个判据恒为 false，
            // 分片下载会永远退化成单线程 —— 界面上照旧显示「并行 N 线程」，
            // 没有任何报错，只是从来没并行过。
            t.rangeSupported = probeRange(t.url);

            if (!t.chunks.isEmpty()) {
                // 续传：片已经在（可能部分已下），直接接着跑
                resumeChunks(t);
            } else {
                if (t.totalBytes <= 0) {
                    // 不知道总长 → 无法分片，只能单流下
                    t.chunks.addAll(DownloadTask.plan(-1, 1, false, t.fileName));
                } else {
                    t.chunks.addAll(DownloadTask.plan(t.totalBytes, threads,
                        t.rangeSupported, t.fileName));
                }
                fetchChunks(t);
            }

            if (t.state == DownloadTask.State.CANCELED) return;
            if (!t.incompleteChunks().isEmpty()) {
                // 不是被暂停/取消，而是真的少片了
                t.state = DownloadTask.State.PAUSED;
                t.error = "有 " + t.incompleteChunks().size() + " 个分片没收完，可继续下载";
                notifyChange(t);
                notifySettled(t);
                return;
            }

            merge(t);
            if (t.state == DownloadTask.State.CANCELED) return;
            t.state = DownloadTask.State.DONE;
            notifyChange(t);
            notifySettled(t);

        } catch (Exception e) {
            if (t.state == DownloadTask.State.CANCELED) return;
            t.state = DownloadTask.State.FAILED;
            t.error = describe(e);
            notifyChange(t);
            notifySettled(t);
        } finally {
            // 成功就把分片清掉，失败/暂停要留着给续传用
            if (t.state == DownloadTask.State.DONE) deleteTemps(t);
            // 合并中断留下的半成品，既不能续传也没人再用，不该留着占空间
            deleteMerging(t);
        }
    }

    /**
     * 并发拉全部分片，全部结束才返回。
     *
     * <p>分片走 {@link #chunkPool()} 而不是裸 {@code new Thread()}：后者会让
     * 「并发连接数 = 任务数 × 分片数」，十个任务各八片就是 80 条连接，
     * 手机直接卡死 —— 这正是类注释里点名要避免的情况。
     * 走固定大小的池，总连接数就被锁死在 {@code threads} 上，多出来的排队而不是一起挤。
     *
     * <p>两个池必须分开：{@code run()} 本身就占着调度池({@link #pool()})的一个线程，
     * 若分片也往同一个池里投并同步等待，池会被自己占满而死锁。
     */
    private void fetchChunks(final DownloadTask t) {
        t.state = DownloadTask.State.RUNNING;
        notifyChange(t);
        final java.util.concurrent.CountDownLatch latch =
            new java.util.concurrent.CountDownLatch(t.chunks.size());

        for (final DownloadTask.Chunk c : t.chunks) {
            chunkPool().execute(() -> {
                try {
                    pull(t, c);
                } catch (Exception e) {
                    if (t.state != DownloadTask.State.CANCELED) {
                    t.error = describe(e);
                }
                } finally {
                    latch.countDown();
                }
            });
        }
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        // 能走到这里，说明所有分片线程都已退出、.part 不再被任何人持有，
        // 此刻删除才是安全的 —— 所以 cancel() 只置状态，删除留到这一步。
        if (t.state == DownloadTask.State.CANCELED) deleteTemps(t);
    }

    /** 续传：已存在的分片文件跳过完整片，其余接着写。 */
    private void resumeChunks(DownloadTask t) {
        t.state = DownloadTask.State.RUNNING;
        notifyChange(t);
        final java.util.concurrent.CountDownLatch latch =
            new java.util.concurrent.CountDownLatch(t.chunks.size());
        for (final DownloadTask.Chunk c : t.chunks) {
            chunkPool().execute(() -> {
                try {
                    pull(t, c);
                } catch (Exception e) {
                    if (t.state != DownloadTask.State.CANCELED) t.error = describe(e);
                } finally {
                    latch.countDown();
                }
            });
        }
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        // 同 fetchChunks：所有分片线程都已退出，此刻删临时文件才是安全的。
        if (t.state == DownloadTask.State.CANCELED) deleteTemps(t);
    }

    /** 下载一个分片。已存在的部分按文件实际长度跳过。 */
    private void pull(DownloadTask t, DownloadTask.Chunk c) throws IOException {
        File f = new File(dir, c.fileName);
        long already = f.exists() ? f.length() : 0;
        if (already >= c.length()) {
            c.received = c.length();
            return;
        }
        long from = c.start + already;

        String range = (t.totalBytes > 0)
            ? "bytes=" + from + "-" + c.endInclusive
            : null;
        HttpURLConnection conn = open(t.url, range, null);
        try {
            int code = conn.getResponseCode();
            if (code >= 400) throw new IOException("服务器返回 " + code + httpHint(code));

            String cr = conn.getHeaderField("Content-Range");
            // 关键防线：服务器不认 Range（200 + 整个文件）却给了分片请求，
            // 这时写下去会得到「完整 + 完整」的坏文件。立刻退回单片。
            if (range != null && !DownloadTask.isPartialResponse(code, cr)) {
                throw new IOException("服务器忽略了分片请求（HTTP " + code
                    + "），已退回单线程，请重试");
            }

            RandomAccessFile raf = null;
            InputStream in = null;
            try {
                raf = new RandomAccessFile(f, "rw");
                raf.seek(already);
                in = conn.getInputStream();
                byte[] buf = new byte[BUF];
                long sinceNotify = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (t.state == DownloadTask.State.CANCELED) return;
                    if (t.state == DownloadTask.State.PAUSED) return;
                    raf.write(buf, 0, n);
                    c.received += n;
                    t.receivedBytes += n;
                    sinceNotify += n;
                    if (sinceNotify >= NOTIFY_EVERY) {
                        sinceNotify = 0;
                        notifyChange(t);
                    }
                }
            } finally {
                closeQuietly(in);
                closeQuietly(raf);
            }
        } finally {
            conn.disconnect();
        }
    }

    /** 把分片按序拼成最终文件。 */
    private void merge(DownloadTask t) throws IOException {
        t.state = DownloadTask.State.MERGING;
        notifyChange(t);

        File target = new File(dir, t.fileName);
        File tmp = new File(dir, t.fileName + ".merging");
        FileOutputStream out = new FileOutputStream(tmp, false);
        try {
            byte[] buf = new byte[BUF];
            for (DownloadTask.Chunk c : t.chunks) {
                File f = new File(dir, c.fileName);
                if (!f.exists()) continue;
                InputStream in = new java.io.FileInputStream(f);
                try {
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                } finally {
                    closeQuietly(in);
                }
            }
            out.flush();
        } finally {
            closeQuietly(out);
        }
        // 覆盖用 rename：Android 上目标已存在时 renameTo 会失败，
        // 所以先删旧的再改名 —— 宁可短暂没有文件，也不要留着半截的旧版本。
        if (target.exists() && !target.delete()) {
            throw new IOException("无法覆盖同名文件：" + t.fileName);
        }
        if (!tmp.renameTo(target)) {
            throw new IOException("合并后的文件无法重命名：" + t.fileName);
        }
        if (t.totalBytes <= 0) {
            try {
                t.totalBytes = target.length();
            } catch (Exception ignored) {
                // 拿不到长度就算了，界面显示「未知」比报错好
            }
        }
    }

    // ------------------------------------------------------------ HTTP

    private HttpURLConnection open(String url, String range, Map<String, String> headers)
            throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(30000);
        conn.setRequestProperty("User-Agent", "NovaBrowser/1.0 (Android)");
        conn.setRequestProperty("Accept", "*/*");
        if (range != null) conn.setRequestProperty("Range", range);
        if (headers != null) {
            for (Map.Entry<String, String> e : headers.entrySet()) {
                conn.setRequestProperty(e.getKey(), e.getValue());
            }
        }
        return conn;
    }

    private static long contentLength(HttpURLConnection conn) {
        String cr = conn.getHeaderField("Content-Range");
        long fromRange = DownloadTask.parseContentRangeTotal(cr);
        if (fromRange > 0) return fromRange;
        // 分片请求拿到的是「这一段」的长度，不是整个文件。
        // 只有非分片响应（没有 Content-Range）才认 Content-Length。
        if (cr != null && cr.contains("bytes")) return -1;
        long v = conn.getContentLengthLong();
        return v > 0 ? v : -1;
    }

    /**
     * 实测服务器认不认 Range。
     *
     * <p>为什么不能只看 {@code Accept-Ranges} 声明：相当多服务器不声明却实打实支持，
     * 只看声明会把好服务器误判掉，平白退化成单线程。
     *
     * <p>为什么又不能只看普通响应的 {@code Content-Range}：不带 Range 的请求拿到的
     * 响应里根本没有这个头 —— 于是判据恒为 false。这是本方法上一版的真 bug，
     * 表现是「设置里选了 8 线程，实际永远 1 线程，且不报任何错」。
     *
     * <p>所以两者结合：显式声明 {@code none} 直接否定；否则真的发一个 1 字节的
     * Range 请求，回 206（或带起止点的 Content-Range）才算支持。
     */
    private boolean probeRange(String url) {
        HttpURLConnection c = null;
        try {
            c = open(url, "bytes=0-0", null);
            int code = c.getResponseCode();
            if (code >= 400) return false;
            String ar = c.getHeaderField("Accept-Ranges");
            if (ar != null && ar.toLowerCase(Locale.ROOT).contains("none")) return false;
            return DownloadTask.isPartialResponse(code, c.getHeaderField("Content-Range"));
        } catch (Exception e) {
            return false;   // 探测失败就按不支持处理：单线程永远是对的
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ------------------------------------------------------------ 小工具

    private void deleteTemps(DownloadTask t) {
        for (String name : t.tempFiles()) {
            try {
                File f = new File(dir, name);
                if (f.exists()) f.delete();
            } catch (Exception ignored) {
                // 临时文件删不掉不影响正确性，下次续传会覆盖它
            }
        }
    }

    /**
     * 合并阶段留下的半成品（{@code <文件名>.merging}）。
     *
     * <p>它必须单独清理：{@link DownloadTask#tempFiles()} 只列分片文件，不含它，
     * 而一旦合并中途失败或被取消，这个文件就<b>永久滞留</b> —— 既不能续传
     * （合并是从头重跑），也不会被任何地方用上，纯粹白占空间。
     */
    private void deleteMerging(DownloadTask t) {
        try {
            File f = new File(dir, t.fileName + ".merging");
            if (f.exists()) f.delete();
        } catch (Exception ignored) {
            // 清不掉不影响正确性：下次合并会用 FileOutputStream(false) 覆盖它
        }
    }

    private void notifyChange(final DownloadTask t) {
        main.post(() -> {
            if (listener != null) listener.onChange(t);
        });
    }

    private void notifySettled(final DownloadTask t) {
        main.post(() -> {
            if (listener != null) listener.onSettled(t);
        });
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (Exception ignored) {
            // 关闭失败不影响结果
        }
    }

    /** 把异常翻成一句中文。技术细节留在日志里，界面上只给人话。 */
    static String describe(Exception e) {
        String m = e.getMessage();
        String name = e.getClass().getSimpleName();
        if (e instanceof java.net.SocketTimeoutException) return "连接超时";
        if (e instanceof java.net.UnknownHostException) return "域名解析失败，请检查网络";
        if (e instanceof java.net.ConnectException) return "连不上服务器";
        if (m == null || m.trim().isEmpty()) return name;
        return m;
    }

    static String httpHint(int code) {
        if (code == 403) return "（服务器拒绝了请求）";
        if (code == 404) return "（文件不存在或已失效）";
        if (code == 416) return "（请求的范围不合法）";
        if (code >= 500) return "（服务器出错）";
        return "";
    }
}