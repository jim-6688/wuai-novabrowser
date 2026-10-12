package top.wuai.nova;

import org.junit.Test;

import java.util.List;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * 下载逻辑的测试。这里测的是「算错了用户会拿到一个损坏文件」的地方。
 */
public class DownloadTaskTest {

    // ------------------------------------------------------------ 分片

    @Test
    public void 单线程就是一片覆盖全文件() {
        List<DownloadTask.Chunk> cs = DownloadTask.plan(1000, 1, true, "a.mp4");
        assertEquals(1, cs.size());
        assertEquals(0, cs.get(0).start);
        assertEquals(999, cs.get(0).endInclusive);
        assertEquals(1000, cs.get(0).length());
    }

    @Test
    public void 四片要正好铺满不重不漏() {
        List<DownloadTask.Chunk> cs = DownloadTask.plan(1000, 4, true, "a.mp4");
        assertEquals(4, cs.size());
        long expectNext = 0;
        long sum = 0;
        for (DownloadTask.Chunk c : cs) {
            assertEquals("片必须首尾相接", expectNext, c.start);
            sum += c.length();
            expectNext = c.endInclusive + 1;
        }
        assertEquals("总字节必须等于文件长", 1000, sum);
        assertEquals(1000, expectNext);
    }

    @Test
    public void 除不尽时余数分给前几片() {
        // 1003 / 4 = 250 余 3 → 251,251,251,250
        List<DownloadTask.Chunk> cs = DownloadTask.plan(1003, 4, true, "a");
        assertEquals(251, cs.get(0).length());
        assertEquals(251, cs.get(1).length());
        assertEquals(251, cs.get(2).length());
        assertEquals(250, cs.get(3).length());
        assertEquals(1003, cs.get(0).length() + cs.get(1).length()
            + cs.get(2).length() + cs.get(3).length());
    }

    @Test
    public void 服务器不认Range时必须退化成单片() {
        // 这条是整个分片方案的安全阀：写下去会是「完整 + 完整」的坏文件，
        // 而且大小正常、不会报错，只有播到一半才炸。
        List<DownloadTask.Chunk> cs = DownloadTask.plan(1000, 8, false, "a.mp4");
        assertEquals("不支持分片时只能一片", 1, cs.size());
        assertEquals(0, cs.get(0).start);
        assertEquals(999, cs.get(0).endInclusive);
    }

    @Test
    public void 不知道总长时只能单片() {
        List<DownloadTask.Chunk> cs = DownloadTask.plan(-1, 8, true, "a");
        assertEquals(1, cs.size());
    }

    @Test
    public void 文件比线程数还小时片数要收窄() {
        // 3 字节开 8 片会切出「长度 0 的片」，
        // 那在 HTTP 里是非法的（Range: bytes=1-0）
        List<DownloadTask.Chunk> cs = DownloadTask.plan(3, 8, true, "a");
        assertEquals(3, cs.size());
        for (DownloadTask.Chunk c : cs) {
            assertTrue("不能有零长或负长的片", c.length() >= 1);
        }
    }

    @Test
    public void 分片序号决定合并顺序() {
        List<DownloadTask.Chunk> cs = DownloadTask.plan(100, 3, true, "v");
        assertEquals("v.part0", cs.get(0).fileName);
        assertEquals("v.part1", cs.get(1).fileName);
        assertEquals("v.part2", cs.get(2).fileName);
    }

    // ------------------------------------------------------------ 响应头

    @Test
    public void 从ContentRange读总长() {
        assertEquals(45678, DownloadTask.parseContentRangeTotal("bytes 0-1023/45678"));
        assertEquals(1000, DownloadTask.parseContentRangeTotal("bytes 0-999/1000"));
    }

    @Test
    public void 未知总长返回负一() {
        assertEquals(-1, DownloadTask.parseContentRangeTotal("bytes 0-1023/*"));
        assertEquals(-1, DownloadTask.parseContentRangeTotal("bytes 0-1023/"));
        assertEquals(-1, DownloadTask.parseContentRangeTotal(null));
        assertEquals(-1, DownloadTask.parseContentRangeTotal("garbage"));
    }

    @Test
    public void 认出这确实是分片响应() {
        assertTrue(DownloadTask.isPartialResponse(206, "bytes 0-99/1000"));
        // 有些服务器用 200 但按 Range 截断了
        assertTrue(DownloadTask.isPartialResponse(200, "bytes 100-199/1000"));
        // 200 且没有 Content-Range = 这就是整个文件，不能当分片写
        assertFalse(DownloadTask.isPartialResponse(200, null));
        assertFalse(DownloadTask.isPartialResponse(200, "text/html"));
    }

    // ------------------------------------------------------------ 文件名

    @Test
    public void 从Disposition取中文名() {
        String h = "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.mp4";
        assertEquals("测试.mp4", DownloadTask.nameFromDisposition(h));
    }

    @Test
    public void 带引号的普通filename() {
        assertEquals("video.mp4",
            DownloadTask.nameFromDisposition("attachment; filename=\"video.mp4\""));
    }

    @Test
    public void 没有Disposition就取不到() {
        assertEquals(null, DownloadTask.nameFromDisposition(null));
        assertEquals(null, DownloadTask.nameFromDisposition("inline"));
        assertEquals(null, DownloadTask.nameFromDisposition("attachment;"));
    }

    @Test
    public void 文件名里的非法字符要清掉() {
        // Android 与桌面文件系统都不接受这些。每个非法字符恰好变一个下划线：
        // 斜杠、冒号、星号、问号、反斜杠都一样，不去重也不合并。
        assertEquals("a_b_c.mp4", DownloadTask.sanitize("a/b:c.mp4"));
        assertEquals("a_b_.mp4", DownloadTask.sanitize("a*b?.mp4"));
        assertEquals("a_b_c.mp4", DownloadTask.sanitize("a/b\\c.mp4"));
        // 以点开头/结尾会「消失」（. 与 ..）
        assertEquals("mp4", DownloadTask.sanitize("...mp4"));
        assertEquals("file", DownloadTask.sanitize("file..."));
        assertEquals("", DownloadTask.sanitize("   "));
        assertEquals("", DownloadTask.sanitize(null));
    }

    @Test
    public void 超长文件名截断但保留扩展名() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 300; i++) sb.append('a');
        sb.append(".mp4");
        String out = DownloadTask.sanitize(sb.toString());
        assertTrue("截断后不该超长", out.length() <= 120);
        assertTrue("扩展名必须留住，否则文件打不开", out.endsWith(".mp4"));
    }

    @Test
    public void 从URL兜底取名() {
        assertEquals("a.mp4", DownloadTask.nameFromUrl("https://x.com/p/a.mp4"));
        assertEquals("a.mp4", DownloadTask.nameFromUrl("https://x.com/p/a.mp4?id=1"));
        assertEquals("a.mp4", DownloadTask.nameFromUrl("https://x.com/p/a.mp4#t=10"));
        // 末段没有名字（以斜杠结尾）
        assertEquals("download", DownloadTask.nameFromUrl("https://x.com/p/"));
    }

    // ------------------------------------------------------------ 进度

    @Test
    public void 进度百分比() {
        DownloadTask t = new DownloadTask(1, "u", "a", 0);
        t.totalBytes = 200;
        t.chunks.addAll(DownloadTask.plan(200, 1, false, "a"));
        assertEquals(0, t.percent());

        t.chunks.get(0).received = 50;
        assertEquals(25, t.percent());

        t.chunks.get(0).received = 200;
        assertEquals(100, t.percent());
    }

    @Test
    public void 总长未知时进度是负一而不是零() {
        // 显示 0% 会让用户以为卡死了，显示「已下载 X」才对
        DownloadTask t = new DownloadTask(1, "u", "a", 0);
        t.totalBytes = -1;
        t.receivedBytes = 512;
        assertEquals(-1, t.percent());
        assertTrue(t.statusLine().contains("512 B"));
    }

    @Test
    public void 容量单位() {
        assertEquals("512 B", DownloadTask.human(512));
        assertEquals("1.0 KB", DownloadTask.human(1024));
        assertEquals("1.5 KB", DownloadTask.human(1536));
        assertEquals("1.0 MB", DownloadTask.human(1024 * 1024));
        assertEquals("1.00 GB", DownloadTask.human(1024L * 1024 * 1024));
        assertEquals("未知", DownloadTask.human(-1));
    }

    // ------------------------------------------------------------ 状态

    @Test
    public void 状态的可操作性() {
        assertTrue(DownloadTask.State.PAUSED.resumable());
        assertTrue(DownloadTask.State.FAILED.resumable());
        assertFalse(DownloadTask.State.RUNNING.resumable());
        assertFalse(DownloadTask.State.DONE.resumable());

        assertTrue(DownloadTask.State.DONE.isTerminal());
        assertTrue(DownloadTask.State.FAILED.isTerminal());
        assertTrue(DownloadTask.State.CANCELED.isTerminal());
        assertFalse(DownloadTask.State.PAUSED.isTerminal());
        assertFalse(DownloadTask.State.RUNNING.isTerminal());
    }

    @Test
    public void 少片的必须能被认出来() {
        // 合并前发现缺片，否则合出来的是个缺段的坏文件
        DownloadTask t = new DownloadTask(1, "u", "a", 0);
        t.totalBytes = 100;
        t.chunks.addAll(DownloadTask.plan(100, 4, true, "a"));
        for (DownloadTask.Chunk c : t.chunks) c.received = c.length();
        assertTrue(t.incompleteChunks().isEmpty());

        t.chunks.get(2).received = 0;
        assertEquals(1, t.incompleteChunks().size());
        assertEquals(2, t.incompleteChunks().get(0).index);
    }

    @Test
    public void 临时文件名不重复() {
        DownloadTask t = new DownloadTask(1, "u", "a", 0);
        t.chunks.addAll(DownloadTask.plan(100, 4, true, "a"));
        List<String> temps = t.tempFiles();
        assertEquals(4, temps.size());
        assertEquals(4, new java.util.HashSet<>(temps).size());
    }

    @Test
    public void 状态行覆盖各状态() {
        DownloadTask t = new DownloadTask(1, "u", "a", 0);
        t.state = DownloadTask.State.FAILED;
        t.error = "服务器返回 404";
        assertTrue(t.statusLine().contains("404"));
        assertTrue(t.statusLine().contains("失败"));

        t.state = DownloadTask.State.DONE;
        t.totalBytes = 2048;
        assertTrue(t.statusLine().contains("已完成"));
    }
}