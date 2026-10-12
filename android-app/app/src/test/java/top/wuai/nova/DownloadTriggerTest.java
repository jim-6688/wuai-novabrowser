package top.wuai.nova;

import org.junit.Test;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * 下载触发的测试。这个判定的两种错法都很致命：
 * 判宽了会把页面的 JS / CSS / XHR 当成下载（页面加载到一半白屏），
 * 判窄了则视频站的下载按钮点了没反应。
 */
public class DownloadTriggerTest {

    private static final Set<String> EXTS = new HashSet<>(Arrays.asList(
        "mp4", "m4v", "mkv", "webm", "mp3", "m4a", "aac", "flac",
        "jpg", "jpeg", "png", "gif", "webp",
        "zip", "rar", "7z", "pdf", "txt", "epub", "apk"));

    private static DownloadTrigger trig() {
        return new DownloadTrigger(EXTS, true);
    }

    // ------------------------------------------------------------ 该触发

    @Test
    public void 已知媒体后缀要触发() {
        assertTrue(trig().judge(null, "https://x.com/a/b.mp4", false).trigger);
        assertTrue(trig().judge(null, "https://x.com/a/b.mp3", false).trigger);
        assertTrue(trig().judge(null, "https://x.com/a/b.pdf", false).trigger);
    }

    @Test
    public void 后缀大小写无关() {
        assertTrue(trig().judge(null, "https://x.com/A.MP4", false).trigger);
    }

    @Test
    public void 服务器标了attachment一定触发() {
        DownloadTrigger.Verdict v = trig().judge(
            "attachment; filename=\"x.bin\"", "https://x.com/a/b", false);
        assertTrue(v.trigger);
        assertEquals("bin", v.ext);
    }

    @Test
    public void 下载关键词且无后缀才触发() {
        assertTrue(trig().judge(null, "https://x.com/download?id=1", false).trigger);
        assertTrue(trig().judge(null, "https://x.com/a/savefile", false).trigger);
        // 带扩展名的已经按后缀判过了，这里不该重复触发
        assertFalse(trig().judge(null, "https://x.com/download/page.html", false).trigger);
    }

    @Test
    public void 关掉关键词判定后不再凭地址猜() {
        DownloadTrigger t = new DownloadTrigger(EXTS, false);
        assertFalse(t.judge(null, "https://x.com/download?id=1", false).trigger);
        assertTrue("按后缀的仍然要触发", t.judge(null, "https://x.com/a.mp4", false).trigger);
    }

    // ------------------------------------------------------------ 不该触发

    @Test
    public void 页面自身的资源不能触发() {
        // 这几条判错的话，用户点一下普通链接浏览器就退出当前页了
        assertFalse(trig().judge(null, "https://x.com/index.html", false).trigger);
        assertFalse(trig().judge(null, "https://x.com/app.js", false).trigger);
        assertFalse(trig().judge(null, "https://x.com/s.css", false).trigger);
        assertFalse(trig().judge(null, "https://x.com/api/data.json", false).trigger);
        assertFalse(trig().judge(null, "https://x.com/p.php", false).trigger);
        assertFalse(trig().judge(null, "https://x.com/x.aspx", false).trigger);
    }

    @Test
    public void 主文档永不触发() {
        assertFalse(trig().judge("attachment", "https://x.com/a.mp4", true).trigger);
    }

    @Test
    public void 非http不触发() {
        assertFalse(trig().judge(null, "ftp://x.com/a.mp4", false).trigger);
        assertFalse(trig().judge(null, "data:video/mp4;base64,AAAA", false).trigger);
        assertFalse(trig().judge(null, "blob:https://x.com/1234", false).trigger);
        assertFalse(trig().judge(null, null, false).trigger);
        assertFalse(trig().judge(null, "", false).trigger);
    }

    @Test
    public void 无后缀且无关键词的不猜() {
        // 猜错会让页面加载到一半白屏
        assertFalse(trig().judge(null, "https://x.com/api/v2/items", false).trigger);
        assertFalse(trig().judge(null, "https://x.com/track/click", false).trigger);
    }

    @Test
    public void 未知后缀不触发() {
        // .dat .log .tmp 这类是站点自己的接口，
        // 按「有后缀就是文件」来判会把整个页面吞掉
        assertFalse(trig().judge(null, "https://x.com/a.dat", false).trigger);
        assertFalse(trig().judge(null, "https://x.com/a.log", false).trigger);
        assertFalse(trig().judge(null, "https://x.com/a.woff2", false).trigger);
    }

    @Test
    public void inline不算附件() {
        assertFalse(trig().judge("inline", "https://x.com/a.mp4", false).trigger);
    }

    // ------------------------------------------------------------ 工具

    @Test
    public void 取后缀() {
        assertEquals("mp4", DownloadTrigger.extOf("a/b/c.mp4"));
        assertEquals("mp4", DownloadTrigger.extOf("a/b/c.MP4"));
        assertEquals("mp4", DownloadTrigger.extOf("c.mp4?x=1"));
        assertEquals("mp4", DownloadTrigger.extOf("c.mp4#t=3"));
        assertEquals("", DownloadTrigger.extOf("a/b/c"));
        assertEquals("", DownloadTrigger.extOf("a/b/"));
        assertEquals("", DownloadTrigger.extOf(null));
        // 点在段首是隐藏目录，不是扩展名
        assertEquals("", DownloadTrigger.extOf("/.well-known/x"));
    }

    @Test
    public void 非法字符不是后缀() {
        // 连字符不是合法后缀字符，整个当不成后缀
        assertEquals("", DownloadTrigger.extOf("a.e-x"));
        // 但多段后缀取最后一段（.mp4.exe 就是 exe）
        assertEquals("exe", DownloadTrigger.extOf("a.mp4.exe"));
    }

    @Test
    public void 取路径不含query与hash() {
        assertEquals("x.com/a/b.mp4", DownloadTrigger.pathOf("https://x.com/a/b.mp4?x=1"));
        assertEquals("x.com/a/b.mp4", DownloadTrigger.pathOf("https://x.com/a/b.mp4#t"));
        assertEquals("x.com", DownloadTrigger.pathOf("https://x.com?x=1"));
    }

    @Test
    public void 说明文字要说清不触发的情况() {
        String s = DownloadTrigger.explain(EXTS);
        assertTrue(s.contains("html"));
        assertTrue("必须说清「不猜」这件事", s.contains("不猜"));
    }
}