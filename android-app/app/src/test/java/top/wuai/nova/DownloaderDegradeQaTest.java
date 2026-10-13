package top.wuai.nova;

import org.junit.AfterClass;
import org.junit.Before;
import org.junit.BeforeClass;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.Assert.assertEquals;

/**
 * 降级路径的<b>端到端</b>验证（QA 独立补的用例）。
 *
 * <p>仓库里已有的 {@link DownloadTaskTest} 只测了 {@code honorsRange} /
 * {@code singleFrom} 这些纯函数，而 {@code Downloader} 里真正把「探测 → 分片 →
 * 发现被无视 → 降级 → 重跑 → 合并」串起来的那一段没有任何测试覆盖 ——
 * 它需要一个真实的 HTTP 服务端才跑得到。这里手搓一个极小的 HTTP 服务端
 * （{@code com.sun.net.httpserver} 不在单测的编译类路径上），让下载器真的下，
 * 再拿 sha256 跟源数据逐字节比。
 *
 * <p>三种服务端性格：
 * <ul>
 *   <li>{@code ok} —— 老实支持 Range（206），不该降级；</li>
 *   <li>{@code liar} —— 探测回 206、真要数据却回 200 整份、<b>不带</b>
 *       Content-Range，这是本轮要修的那一档；</li>
 *   <li>{@code echo} —— 同样是回 200 整份，但把 Content-Range 老老实实写成
 *       {@code bytes 0-(N-1)/N}。整份的 Content-Range 起点恰好是 0，正好落在
 *       第一片请求 {@code bytes=0-…} 的起点上 —— 判据只看起点的话，
 *       这一片会被误判成「服务端认了 Range」。</li>
 * </ul>
 */
public class DownloaderDegradeQaTest {

    private static final int SIZE = 512 * 1024;
    private static final byte[] BODY = new byte[SIZE];
    private static final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");

    private static TinyServer server;
    private static String base;
    /** 服务端最近一次收到的 Accept-Encoding（用来钉住 identity 那条防线）。 */
    private static volatile String lastAcceptEncoding;

    private File dir;

    @BeforeClass
    public static void boot() throws Exception {
        for (int i = 0; i < SIZE; i++) BODY[i] = (byte) ((i * 31 + 7) & 255);
        server = new TinyServer();
        server.start();
        base = "http://127.0.0.1:" + server.port();
    }

    @AfterClass
    public static void stop() {
        if (server != null) server.halt();
    }

    @Before
    public void prepare() throws Exception {
        dir = Files.createTempDirectory("nova-dl-qa-").toFile();
    }

    /** 跑一次下载，等到落定（单测里 Handler 是空壳，回调不会来，只能轮询）。 */
    private DownloadTask run(String path, String name) throws Exception {
        Downloader d = new Downloader(dir, 8, new Downloader.Listener() {
            @Override public void onChange(DownloadTask t) { /* noop */ }
            @Override public void onSettled(DownloadTask t) { /* noop */ }
        });
        List<DownloadTask> ts = d.enqueue(Collections.singletonList(base + path),
            Collections.singletonList(name));
        DownloadTask t = ts.get(0);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (System.nanoTime() < deadline) {
            DownloadTask.State s = t.state;
            if (s == DownloadTask.State.DONE || s == DownloadTask.State.FAILED
                || s == DownloadTask.State.PAUSED) break;
            Thread.sleep(20);
        }
        d.shutdown();
        return t;
    }

    private static String sha(byte[] b) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] d = md.digest(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : d) sb.append(String.format("%02x", x & 255));
        return sb.toString();
    }

    // ------------------------------------------------------------------ 用例

    @Test
    public void 老实支持分片的服务端不降级且文件正确() throws Exception {
        DownloadTask t = run("/ok.bin", "ok.bin");
        assertEquals("状态应为完成：" + t.error, DownloadTask.State.DONE, t.state);
        assertEquals("不该降级", false, t.degraded);
        byte[] got = Files.readAllBytes(new File(dir, t.fileName).toPath());
        assertEquals("落盘大小应正好等于文件长度", SIZE, got.length);
        assertEquals("字节内容应完全一致", sha(BODY), sha(got));
    }

    @Test
    public void 整份从头倒且不带ContentRange时降级后文件正确() throws Exception {
        DownloadTask t = run("/liar.bin", "liar.bin");
        assertEquals("状态应为完成而不是甩给用户一个错误：" + t.error,
            DownloadTask.State.DONE, t.state);
        assertEquals("应当已经从多线程降级", true, t.degraded);
        byte[] got = Files.readAllBytes(new File(dir, t.fileName).toPath());
        assertEquals("落盘大小应正好等于文件长度（没有「完整+完整」）", SIZE, got.length);
        assertEquals("降级后字节内容应完全一致", sha(BODY), sha(got));
    }

    @Test
    public void 整份从头倒且ContentRange写着整份时也要降级() throws Exception {
        // 和上一个用例是同一种「服务端不支持」，只是它把 Content-Range 也回了出来：
        // bytes 0-(N-1)/N 的起点是 0，正好等于第一片请求的起点。
        // 判据若只比对起点，第一片就会被当成「服务端认了 Range」，
        // 于是把整份 512KB 全吞进 part0，而后面七片照常被判为「被无视」——
        // 降级时 part0 又因为是「已完成」被整片留下，合并出来是「完整 + 尾巴」。
        DownloadTask t = run("/echo.bin", "echo.bin");
        assertEquals("状态应为完成：" + t.error, DownloadTask.State.DONE, t.state);
        assertEquals("同样应当降级", true, t.degraded);
        byte[] got = Files.readAllBytes(new File(dir, t.fileName).toPath());
        assertEquals("落盘大小应正好等于文件长度，实得 " + got.length, SIZE, got.length);
        assertEquals("字节内容应完全一致", sha(BODY), sha(got));
    }

    @Test
    public void 谎报206却整份倒时合并的大小校验会拦下来() throws Exception {
        // 服务端嘴上回 206（honorsRange 对 206 一律认），身体却从头倒一整份。
        // 八个分片各吞一份全量、各自都「已完成」，于是走到 merge ——
        // 合并出来是 8 倍大小。加了大小校验之前，这会静默产出一个坏文件
        // 并报「完成」；现在必须报错，而且不能把废品留在下载目录里。
        DownloadTask t = run("/greedy.bin", "greedy.bin");
        assertEquals("必须是失败，不能假装下好了", DownloadTask.State.FAILED, t.state);
        assertEquals("错误信息要说清楚是大小对不上：" + t.error, true,
            t.error != null && t.error.contains("大小对不上"));
        File out = new File(dir, t.fileName);
        assertEquals("半成品必须被删掉，不能留给用户", false, out.exists());
    }

    @Test
    public void 请求明说了identity不要压缩() throws Exception {
        // Content-Length 若是压缩后的长度，总长和分片偏移会整体错位 ——
        // 而加了大小校验之后，这种错位会变成一条看不懂的失败。
        run("/ok.bin", "ok.bin");
        assertEquals("必须带 Accept-Encoding: identity", "identity", lastAcceptEncoding);
    }

    @Test
    public void 解ContentRange的终点() {
        // 终点是「有没有越出我们要的窗口」的判据，和起点成对
        assertEquals(2047, DownloadTask.contentRangeEnd("bytes 1024-2047/4096"));
        assertEquals(0, DownloadTask.contentRangeEnd("bytes 0-0/1"));
        assertEquals(-1, DownloadTask.contentRangeEnd(null));
        assertEquals(-1, DownloadTask.contentRangeEnd(""));
        // 总长未知（bytes 0-1023/*）不影响终点
        assertEquals(1023, DownloadTask.contentRangeEnd("bytes 0-1023/*"));
        // 终点写成星号 = 说不清给了多少 → 按没认处理
        assertEquals(-1, DownloadTask.contentRangeEnd("bytes 0-*/4096"));
        assertEquals(-1, DownloadTask.contentRangeEnd("bytes */4096"));
    }

    @Test
    public void 降级时保留连续前缀且序号不乱() throws Exception {
        // 「保留哪几片」这件事：前两片完整、第三片半截、第四片有货但接不上。
        // 留下来的是「前两片 + 改造成单连接的第三片」，第四片即便已下满也不能留
        // （中间是断的，拼上去就错位）。
        DownloadTask t = new DownloadTask(1, "u", "v", 0);
        t.totalBytes = 4000;
        t.chunks.addAll(DownloadTask.plan(4000, 4, true, "v"));
        assertEquals(4, t.chunks.size());
        assertEquals("第 3 片应覆盖 2000-2999", 2000, t.chunks.get(2).start);
        t.chunks.get(2).received = 400;    // 断点在这一片
        t.chunks.get(3).received = 1000;   // 有货，但前面是断的，必须丢

        List<DownloadTask.Chunk> one = DownloadTask.singleFrom(
            t.chunks.get(2).start + t.chunks.get(2).received, t.totalBytes, "v", 2);
        assertEquals("单连接从断点处起（已下的 400 字节没被白丢）", 2400, one.get(0).start);
        assertEquals("单连接一路吞到文件末尾", 3999, one.get(0).endInclusive);
        assertEquals("序号保持原片号，否则合并顺序错乱", 2, one.get(0).index);
        assertEquals("临时文件名跟着序号走", "v.part2", one.get(0).fileName);
    }

    @Test
    public void 续传时被无视的分片不再从零重来() throws Exception {
        // 降级 + 暂停 + 续传：服务端不认 Range，续传只能「整份从头倒、丢掉前 N 字节」。
        // 这里 N 取一个非零值，验的是「已有的前缀不会被再写一遍」——
        // 早先这一处是 raf.seek(already) 之后把整份响应原样写入，
        // 于是文件变成「已下前缀 + 一整份」。
        DownloadTask t = new DownloadTask(2, "u", "v", 0);
        t.totalBytes = 4096;
        t.degraded = true;
        t.rangeSupported = false;
        t.chunks.addAll(DownloadTask.singleFrom(0, 4096, "v", 0));
        DownloadTask.Chunk c = t.chunks.get(0);
        c.received = 1500;
        // 续传时这一片要请求的偏移 = 起点 + 已下字节
        assertEquals("续传请求的偏移应是已下到的位置", 1500, c.start + c.received);
        assertEquals("这一片的长度应是剩下的部分", 2596, c.length() - c.received);
    }

    /* ------------------------------------------------------------ 迷你服务端 */

    /** 极小的 HTTP/1.1 服务端：一请求一连接，发完就关。 */
    private static final class TinyServer {
        private final ExecutorService pool = Executors.newCachedThreadPool();
        private final ServerSocket ss;
        private volatile boolean on = true;

        TinyServer() throws IOException {
            ss = new ServerSocket();
            ss.bind(new InetSocketAddress("127.0.0.1", 0));
        }

        int port() { return ss.getLocalPort(); }

        void start() {
            pool.execute(() -> {
                while (on) {
                    try {
                        Socket s = ss.accept();
                        pool.execute(() -> {
                            try { serve(s); } catch (Exception ignored) {
                                /* 客户端提前断开很正常 */
                            } finally {
                                try { s.close(); } catch (Exception ignored) { /* noop */ }
                            }
                        });
                    } catch (Exception e) {
                        if (!on) return;
                    }
                }
            });
        }

        void halt() {
            on = false;
            try { ss.close(); } catch (Exception ignored) { /* noop */ }
            pool.shutdownNow();
        }

        private void serve(Socket s) throws IOException {
            byte[] head = readHead(s.getInputStream());
            String text = new String(head, StandardCharsets.ISO_8859_1).toLowerCase(Locale.ROOT);
            int ae = text.indexOf("accept-encoding:");
            if (ae >= 0) {
                int eol = text.indexOf('\n', ae);
                lastAcceptEncoding = text.substring(ae + "accept-encoding:".length(),
                    eol < 0 ? text.length() : eol).trim();
            }
            String path = text.replaceAll("(?s)^\\s*get\\s+(\\S+).*", "$1");
            int[] r = range(text);

            boolean ok = path.contains("ok.bin");
            boolean echo = path.contains("echo.bin");
            boolean probe = r[0] == 0 && r[1] == 0;

            // 不带 Range 的普通请求（下载器靠它拿总长）：老实回整份 200
            if (r[0] < 0) { write(s, 200, "", BODY); return; }

            // 谎报 206：Content-Range 说只给 a-b，身体却从头倒一整份。
            // honorsRange 对 206 一律判「认了」，所以不会降级 ——
            // 八个分片各吞一份全量，只能靠 merge 的大小校验拦下来。
            if (path.contains("greedy.bin")) {
                int a = Math.max(0, r[0]), b = Math.min(r[1], SIZE - 1);
                write(s, 206, "Content-Range: bytes " + a + "-" + b + "/" + SIZE + "\r\n", BODY);
                return;
            }

            if (ok && !probe) {
                int from = r[0], to = Math.min(r[1], SIZE - 1);
                if (from > to || from >= SIZE) { write(s, 416, "", new byte[0]); return; }
                byte[] slice = Arrays.copyOfRange(BODY, from, to + 1);
                write(s, 206, "Content-Range: bytes " + from + "-" + to + "/" + SIZE + "\r\n", slice);
                return;
            }
            if (probe) {
                write(s, 206, "Content-Range: bytes 0-0/" + SIZE + "\r\n",
                    new byte[] { BODY[0] });
                return;
            }
            // liar / echo：整份从头倒。echo 额外把 Content-Range 回出来（起点 0）。
            write(s, 200, echo ? "Content-Range: bytes 0-" + (SIZE - 1) + "/" + SIZE + "\r\n" : "",
                BODY);
        }

        private static int[] range(String head) {
            Matcher m = RANGE.matcher(head);
            if (!m.find()) return new int[] { -1, -1 };
            int a = m.group(1).isEmpty() ? 0 : Integer.parseInt(m.group(1));
            int b = m.group(2).isEmpty() ? SIZE - 1 : Integer.parseInt(m.group(2));
            return new int[] { a, b };
        }

        private static void write(Socket s, int code, String extra, byte[] body) throws IOException {
            String reason = code == 206 ? "Partial Content" : code == 200 ? "OK" : "Range Not Satisfiable";
            StringBuilder h = new StringBuilder();
            h.append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n");
            h.append("Content-Type: application/octet-stream\r\n");
            h.append("Content-Length: ").append(body.length).append("\r\n");
            h.append("Accept-Ranges: bytes\r\n");
            h.append(extra);
            h.append("Connection: close\r\n\r\n");
            OutputStream os = s.getOutputStream();
            os.write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
            os.write(body);
            os.flush();
        }

        /** 一直读到请求头结束（\r\n\r\n）。 */
        private static byte[] readHead(InputStream in) throws IOException {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            int seen = 0;
            while (true) {
                int b = in.read();
                if (b < 0) break;
                buf.write(b);
                if (b == '\r' || b == '\n') { seen++; if (seen >= 4) break; }
                else seen = 0;
            }
            return buf.toByteArray();
        }
    }
}
