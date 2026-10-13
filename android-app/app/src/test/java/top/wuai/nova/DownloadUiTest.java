package top.wuai.nova;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * 下载界面纯逻辑的测试。
 *
 * <p>这里测的是「算错了界面就会说谎」的地方：进度画错会让人以为下完了，
 * 颜色画错会把「已暂停」说成「失败」，分段数画错会让单连接看起来像八线程并发。
 * 这些都不是真机能靠肉眼可靠发现的 —— 必须钉死在单测里。
 */
public class DownloadUiTest {

    private static DownloadTask task() {
        return new DownloadTask(1L, "https://x.com/a.zip", "a.zip", 1000L);
    }

    private static DownloadTask withChunks(int n, long eachLen, long eachGot) {
        DownloadTask t = task();
        for (int i = 0; i < n; i++) {
            DownloadTask.Chunk c = new DownloadTask.Chunk(
                i * eachLen, i * eachLen + eachLen - 1, i, "a.zip.part" + i);
            c.received = eachGot;
            t.chunks.add(c);
        }
        t.totalBytes = eachLen * n;
        return t;
    }

    // ------------------------------------------------------------ 分段

    @Test
    public void 八条连接就是八格() {
        DownloadTask t = withChunks(8, 100, 0);
        assertEquals(8, DownloadUi.segments(t).size());
    }

    @Test
    public void 每格的填充比按该连接自己的字节算() {
        DownloadTask t = withChunks(4, 100, 0);
        t.chunks.get(0).received = 100;   // 跑完
        t.chunks.get(1).received = 50;    // 一半
        t.chunks.get(2).received = 0;     // 还没动
        t.chunks.get(3).received = 25;
        List<DownloadUi.Seg> segs = DownloadUi.segments(t);

        assertEquals(1f, segs.get(0).fill, 0.001f);
        assertEquals(0.5f, segs.get(1).fill, 0.001f);
        assertEquals(0f, segs.get(2).fill, 0.001f);
        assertEquals(0.25f, segs.get(3).fill, 0.001f);
    }

    @Test
    public void 跑完的那一格标记为done() {
        DownloadTask t = withChunks(3, 100, 0);
        t.chunks.get(0).received = 100;
        t.chunks.get(1).received = 99;
        List<DownloadUi.Seg> segs = DownloadUi.segments(t);
        assertTrue("跑满的一格要换成完成色", segs.get(0).done);
        assertFalse("差一字节也不算跑完", segs.get(1).done);
    }

    @Test
    public void 收到超过该片长度的字节被夹到满格() {
        // 真实场景：服务器不认 Range，第二片回了整个文件。这时该片会收到远超
        // 自己长度的字节。不夹住的话填充比会 >1，画出来溢出到隔壁格上。
        DownloadTask t = withChunks(2, 100, 0);
        t.chunks.get(0).received = 9999;
        assertEquals(1f, DownloadUi.segments(t).get(0).fill, 0.001f);
    }

    @Test
    public void 没有分片时只有一格() {
        // 还没探测出分片：这一刻引擎自己也不知道会切几片，画一格比画八格空格诚实。
        DownloadTask t = task();
        t.totalBytes = 1000;
        t.receivedBytes = 250;
        assertEquals(1, DownloadUi.segments(t).size());
    }

    @Test
    public void 单连接按整体百分比填充() {
        DownloadTask t = task();
        t.totalBytes = 1000;
        t.receivedBytes = 250;
        assertEquals(0.25f, DownloadUi.segments(t).get(0).fill, 0.001f);
    }

    @Test
    public void 总长未知时给UNKNOWN而不是零() {
        // 0% 看起来就是「卡住不动了」，而实际只是服务器没给 Content-Length。
        DownloadTask t = task();
        t.totalBytes = -1;
        t.receivedBytes = 4096;
        List<DownloadUi.Seg> segs = DownloadUi.segments(t);
        assertEquals(1, segs.size());
        assertEquals(DownloadUi.UNKNOWN, segs.get(0).fill, 0.001f);
    }

    @Test
    public void 已完成的任务无论有没有分片都画满格() {
        DownloadTask t = task();
        t.totalBytes = -1;              // 总长未知也要画满
        t.state = DownloadTask.State.DONE;
        List<DownloadUi.Seg> segs = DownloadUi.segments(t);
        assertEquals(1, segs.size());
        assertEquals(1f, segs.get(0).fill, 0.001f);
        assertTrue(segs.get(0).done);
    }

    // ------------------------------------------------------------ 颜色与文案

    @Test
    public void 传输中的三种状态都是品牌色() {
        for (DownloadTask.State s : new DownloadTask.State[]{
            DownloadTask.State.RUNNING,
            DownloadTask.State.PROBING,
            DownloadTask.State.MERGING}) {
            DownloadTask t = task();
            t.state = s;
            assertEquals(s.name(), DownloadUi.Tone.BRAND, DownloadUi.tone(t));
        }
    }

    @Test
    public void 失败是警示色完成是成功色() {
        DownloadTask t = task();
        t.state = DownloadTask.State.FAILED;
        assertEquals(DownloadUi.Tone.DANGER, DownloadUi.tone(t));
        t.state = DownloadTask.State.DONE;
        assertEquals(DownloadUi.Tone.OK, DownloadUi.tone(t));
    }

    @Test
    public void 取消不算出错用中性色() {
        // 取消是用户自己点的，标成红的会让人以为出了问题。
        DownloadTask t = task();
        t.state = DownloadTask.State.CANCELED;
        assertEquals(DownloadUi.Tone.NEUTRAL, DownloadUi.tone(t));
    }

    @Test
    public void 八个状态都有各自的胶囊文案() {
        Object[][] cases = {
            {DownloadTask.State.QUEUED, "排队中"},
            {DownloadTask.State.PROBING, "探测中"},
            {DownloadTask.State.RUNNING, "下载中"},
            {DownloadTask.State.MERGING, "合并中"},
            {DownloadTask.State.DONE, "已完成"},
            {DownloadTask.State.PAUSED, "已暂停"},
            {DownloadTask.State.FAILED, "失败"},
            {DownloadTask.State.CANCELED, "已取消"},
        };
        for (Object[] c : cases) {
            DownloadTask t = task();
            t.state = (DownloadTask.State) c[0];
            assertEquals((String) c[1], DownloadUi.pill(t));
        }
    }

    @Test
    public void 单片时明说单连接而不是一条连接() {
        DownloadTask t = task();
        assertEquals("单连接", DownloadUi.connections(t));
        t.chunks.add(new DownloadTask.Chunk(0, 99, 0, "a.part0"));
        assertEquals("单片仍写单连接", "单连接", DownloadUi.connections(t));
    }

    @Test
    public void 多片时报出真实连接数() {
        assertEquals("8 条连接", DownloadUi.connections(withChunks(8, 100, 0)));
    }

    // ------------------------------------------------------------ 元信息

    @Test
    public void 进度文案带总量与百分比() {
        DownloadTask t = task();
        t.totalBytes = 8 * 1024 * 1024;
        t.receivedBytes = 4 * 1024 * 1024;
        t.state = DownloadTask.State.RUNNING;
        String s = DownloadUi.progress(t);
        assertTrue(s, s.contains("4.0 MB"));
        assertTrue(s, s.contains("8.0 MB"));
        assertTrue(s, s.contains("50%"));
    }

    @Test
    public void 总长未知时文案里明说大小未知() {
        DownloadTask t = task();
        t.totalBytes = -1;
        t.receivedBytes = 4096;
        t.state = DownloadTask.State.RUNNING;
        assertTrue(DownloadUi.progress(t).contains("大小未知"));
    }

    @Test
    public void 已完成的任务只报文件大小不再报百分比() {
        DownloadTask t = task();
        t.totalBytes = 2048;
        t.receivedBytes = 2048;
        t.state = DownloadTask.State.DONE;
        String s = DownloadUi.progress(t);
        assertFalse("已完成的文件说百分比没有意义", s.contains("%"));
        assertTrue(s, s.contains("2.0 KB"));
    }

    @Test
    public void 只有已完成的任务才报保存位置() {
        DownloadTask t = task();
        t.state = DownloadTask.State.RUNNING;
        assertEquals("", DownloadUi.location(t));
        t.state = DownloadTask.State.DONE;
        assertEquals("应用私有目录", DownloadUi.location(t));
    }

    @Test
    public void 暂停的任务仍算进行中() {
        // 暂停的任务要留在「进行中」那一组，否则用户找不到它。
        DownloadTask t = task();
        t.state = DownloadTask.State.PAUSED;
        assertTrue(DownloadUi.isActive(t));
        t.state = DownloadTask.State.DONE;
        assertFalse(DownloadUi.isActive(t));
        t.state = DownloadTask.State.CANCELED;
        assertFalse(DownloadUi.isActive(t));
    }
}
