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

    // -------------------------------------------- 服务器到底认没认 Range

    @Test
    public void 要了偏移却回整份就是被无视() {
        // 最难缠的一种「不支持」：探测那一个字节时回得好好的 206，
        // 真发分片请求却整份从头倒。200 且没有 Content-Range → 被无视。
        assertFalse(DownloadTask.honorsRange(200, null, 1024, 2047));
        // 200 且 Content-Range 写着起点 0（也就是整份）：同样是被无视。
        // 只看「有没有 Content-Range」会把这一支误判成分片，
        // 于是照单全收，拼出来的是「完整 + 完整」。
        assertFalse(DownloadTask.honorsRange(200, "bytes 0-4095/4096", 1024, 2047));
    }

    @Test
    public void 整份从头倒却把ContentRange回写成整份时也要判为被无视() {
        // 这一条是 QA 端到端逮到的真 bug。整份从头倒的 200 里最常见的一种，
        // 会把 Content-Range 老实写成 bytes 0-(N-1)/N —— 起点恰好是 0，
        // 而第一片请求的起点也恰好是 0。只比对起点的话这一片永远被判成
        // 「服务端认了 Range」，于是整份 512KB 被无上限地倒进一个只有 64KB
        // 的分片；后面七片起点不为 0 照常被判「被无视」；降级时第一片又因为
        // 「已完成」被整片留下 —— 合并出来是「完整 + 尾巴」。
        assertFalse(DownloadTask.honorsRange(200, "bytes 0-524287/524288", 0, 65535));

        // 同样的响应落在「要的就是整份」那一片上才算认了：终点没有越出窗口。
        assertTrue(DownloadTask.honorsRange(200, "bytes 0-524287/524288", 0, 524287));
    }

    @Test
    public void 回了206或起止点都在窗口内就是真分片() {
        assertTrue(DownloadTask.honorsRange(206, "bytes 1024-2047/4096", 1024, 2047));
        // 有些服务端拿 200 回分片，但 Content-Range 老实写着起止点 —— 那是合规分片，
        // 误判成「被无视」会把已经下到的字节白白丢掉重来。
        assertTrue(DownloadTask.honorsRange(200, "bytes 1024-2047/4096", 1024, 2047));
        // 第一片本来就从 0 要起
        assertTrue(DownloadTask.honorsRange(200, "bytes 0-1023/4096", 0, 1023));
        // 给得比要的少也算认了（剩下的下次补）
        assertTrue(DownloadTask.honorsRange(200, "bytes 1024-1500/4096", 1024, 2047));
    }

    @Test
    public void 起点差一个字节也算被无视() {
        // 要 1024 却从 1023 开始给 —— 写下去整份文件错一位
        assertFalse(DownloadTask.honorsRange(200, "bytes 1023-2046/4096", 1024, 2047));
    }

    @Test
    public void 说不清终点的按没认处理() {
        // bytes 0-*/1024：给多给少全凭猜，宁可降级也不要赌
        assertFalse(DownloadTask.honorsRange(200, "bytes 0-*/1024", 0, 1023));
    }

    @Test
    public void 解ContentRange的起点与终点() {
        assertEquals(1024, DownloadTask.contentRangeStart("bytes 1024-2047/4096"));
        assertEquals(0, DownloadTask.contentRangeStart("bytes 0-0/1"));
        assertEquals(-1, DownloadTask.contentRangeStart(null));
        assertEquals(-1, DownloadTask.contentRangeStart(""));
        // 总长未知（bytes */4096）时起点无从谈起
        assertEquals(-1, DownloadTask.contentRangeStart("bytes */4096"));

        assertEquals(2047, DownloadTask.contentRangeEnd("bytes 1024-2047/4096"));
        assertEquals(524287, DownloadTask.contentRangeEnd("bytes 0-524287/524288"));
        assertEquals(-1, DownloadTask.contentRangeEnd(null));
        assertEquals(-1, DownloadTask.contentRangeEnd("bytes 0-*/4096"));
    }

    // -------------------------------------------- 运行时降级成单连接

    @Test
    public void 降级后的单连接从断点吞到末尾() {
        List<DownloadTask.Chunk> cs = DownloadTask.singleFrom(1500, 4096, "v", 1);
        assertEquals(1, cs.size());
        assertEquals(1500, cs.get(0).start);
        assertEquals(4095, cs.get(0).endInclusive);
        // 序号必须还是原来那一片：合并是按 index 顺序拼的，
        // 换成 0 会把这一片拼到文件开头去。
        assertEquals(1, cs.get(0).index);
        assertEquals("v.part1", cs.get(0).fileName);
        assertEquals(2596, cs.get(0).length());
    }

    @Test
    public void 降级时总长未知也不炸() {
        // 总长拿不到时末字节按起点记，长度因此是 1 —— 只是给进度一个非空的底，
        // 真正到哪儿由连接决定。绝不能算出负长度（那会让「这一片已完成」恒成立）。
        List<DownloadTask.Chunk> cs = DownloadTask.singleFrom(500, -1, "v", 0);
        assertEquals(500, cs.get(0).start);
        assertEquals(500, cs.get(0).endInclusive);
        assertTrue("长度必须是正数", cs.get(0).length() >= 1);
    }

    @Test
    public void 降级只允许翻一次闸() {
        // degraded 是「只许翻一次」的开关：run() 靠它避免
        // 「降级 → 重跑 → 又被判无视 → 再降级」的死循环。
        DownloadTask t = new DownloadTask(1, "u", "a", 0);
        assertFalse(t.degraded);
        assertFalse(t.rangeIgnored);
        t.rangeIgnored = true;
        t.degraded = true;
        assertTrue(t.degraded);
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