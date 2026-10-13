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

    // ------------------------------------------------------------ 响应 MIME 档
    //
    // 这一档是「网页上点击下载无反应」的正面修复。真实下载地址大量长成
    // /down.php?id=1 或 /getfile?f=x 这种「像页面、其实是文件」的样子，
    // 只靠 URL 后缀会被 .php / 无后缀两条分支先后否决。

    @Test
    public void octetStream让伪静态下载地址触发() {
        // .php 后缀本来会被「页面后缀」否决，octet-stream 必须把它救回来
        DownloadTrigger.Verdict v = trig().judge(
            null, "application/octet-stream", "https://x.com/down.php?id=123", false);
        assertTrue("octet-stream 是文件，应触发", v.trigger);
        assertTrue("理由里要能看出走的是 MIME 档", v.reason.contains("octet-stream"));
    }

    @Test
    public void 无后缀接口路径靠MIME触发() {
        // 无扩展名、不含关键词 —— 旧逻辑必否决，现在靠 MIME 触发
        assertTrue(trig().judge(
            null, "application/octet-stream", "https://x.com/getfile?f=abc", false).trigger);
        assertTrue(trig().judge(
            null, "application/octet-stream", "https://x.com/api/v2/file/91823", false).trigger);
    }

    @Test
    public void APK的MIME触发() {
        // Android 安装包。这里同时给了 URL 后缀与 MIME，两条路都该认为它是文件。
        DownloadTrigger.Verdict v = trig().judge(null,
            "application/vnd.android.package-archive", "https://x.com/app.apk", false);
        assertTrue(v.trigger);
        assertEquals("apk", v.ext);
    }

    @Test
    public void 压缩包与文档MIME触发() {
        assertTrue(trig().judge(null, "application/zip", "https://x.com/a", false).trigger);
        assertTrue(trig().judge(null, "application/x-rar-compressed", "https://x.com/a", false).trigger);
        assertTrue(trig().judge(null, "application/x-7z-compressed", "https://x.com/a", false).trigger);
        assertTrue(trig().judge(null, "application/pdf", "https://x.com/a", false).trigger);
        assertTrue(trig().judge(null,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "https://x.com/a", false).trigger);
        assertTrue(trig().judge(null,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "https://x.com/a", false).trigger);
        assertTrue(trig().judge(null,
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "https://x.com/a", false).trigger);
    }

    @Test
    public void 媒体前缀MIME触发() {
        assertTrue(trig().judge(null, "video/mp4", "https://x.com/v", false).trigger);
        assertTrue(trig().judge(null, "audio/mpeg", "https://x.com/v", false).trigger);
    }

    @Test
    public void MIME大小写与参数不影响判定() {
        // 服务器写大写、带 charset 都很常见，不规整就会漏判
        assertTrue(trig().judge(null, "Application/Octet-Stream",
            "https://x.com/down.php?id=1", false).trigger);
        assertFalse("text/html 带参数也要被认出来并否决", trig().judge(
            null, "Text/HTML; charset=utf-8", "https://x.com/a.mp4", false).trigger);
    }

    @Test
    public void 网页MIME即使后缀命中也不触发() {
        // SPA 的路由长成 /download/page 这种样子，响应是网页 —— 绝不能当成下载
        assertFalse(trig().judge(null, "text/html", "https://x.com/page", false).trigger);
        assertFalse("后缀命中也要被 MIME 否决",
            trig().judge(null, "text/html", "https://x.com/a.mp4", false).trigger);
        assertFalse(trig().judge(null, "application/xhtml+xml",
            "https://x.com/a.pdf", false).trigger);
        assertFalse(trig().judge(null, "text/css", "https://x.com/a.zip", false).trigger);
    }

    @Test
    public void 纯文本MIME既不自己触发也不否决后缀() {
        // text/plain 是两用的：接口返回的纯文本不该下，用户点的 .txt 文件该下。
        // 所以它不表态，把判断交回 URL 后缀。
        assertFalse("无后缀 + text/plain 不猜",
            trig().judge(null, "text/plain", "https://x.com/api/thing", false).trigger);
        assertTrue(".txt 后缀仍然要触发",
            trig().judge(null, "text/plain", "https://x.com/a.txt", false).trigger);
    }

    @Test
    public void attachment优先级高于网页MIME() {
        // 服务器既说了是附件，就一定下 —— 这是最硬的证据
        assertTrue(trig().judge("attachment; filename=\"a.zip\"", "text/html",
            "https://x.com/x", false).trigger);
    }

    @Test
    public void 旧签名仍然可用() {
        // 三参版本转发到四参版本，不带 MIME 的调用点行为不变
        assertTrue(trig().judge(null, "https://x.com/a/b.mp4", false).trigger);
        assertFalse(trig().judge(null, "https://x.com/p.php", false).trigger);
        assertTrue(trig().judge("attachment; filename=\"x.bin\"",
            "https://x.com/a/b", false).trigger);
    }

    @Test
    public void 规整MIME() {
        assertEquals("text/html", DownloadTrigger.normalizeMime("Text/HTML; charset=utf-8"));
        assertEquals("application/octet-stream", DownloadTrigger.normalizeMime(" APPLICATION/OCTET-STREAM "));
        assertEquals("", DownloadTrigger.normalizeMime(null));
        assertEquals("", DownloadTrigger.normalizeMime("  "));
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