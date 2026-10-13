package top.wuai.nova;

import org.junit.Test;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * QA 补充：下载判定矩阵里工程师<b>没覆盖</b>的格子。
 *
 * <p>这些用例刻意不复刻 {@link DownloadTriggerTest} 已有的断言，专攻三类死角：
 * <ul>
 *   <li>四参签名下 MIME 为 null / 空串 / 大写 / 带 {@code ;charset=} 的变体；</li>
 *   <li>「误触发」这个更危险的方向（页面资源被当成下载 → 白屏）；</li>
 *   <li>三参 / 四参两条签名在 MIME 缺失时是否真的同一条逻辑路径。</li>
 * </ul>
 */
public class DownloadTriggerEdgeTest {

    private static final Set<String> EXTS = new HashSet<>(Arrays.asList(
        "mp4", "m4v", "mkv", "webm", "mp3", "m4a", "aac", "flac",
        "jpg", "jpeg", "png", "gif", "webp",
        "zip", "rar", "7z", "pdf", "txt", "epub", "apk"));

    private static DownloadTrigger trig() {
        return new DownloadTrigger(EXTS, true);
    }

    // ------------------------------------------------- MIME 规整（null/空/大写/charset）

    @Test
    public void MIME为null或空串时退回后缀判定() {
        assertTrue(trig().judge(null, null, "https://x.com/a.mp4", false).trigger);
        assertTrue(trig().judge(null, "", "https://x.com/a.mp4", false).trigger);
        // 没有后缀、没有关键词 → 不猜
        assertFalse(trig().judge(null, null, "https://x.com/api/v2/items", false).trigger);
        assertFalse(trig().judge(null, "", "https://x.com/api/v2/items", false).trigger);
    }

    @Test
    public void 带charset参数的二进制MIME仍判定为文件() {
        DownloadTrigger.Verdict v = trig().judge(
            null, "application/octet-stream; charset=utf-8", "https://x.com/down", false);
        assertTrue(v.trigger);
        // 无后缀时后缀档取不到扩展名，ext 应为空 —— 但必须触发
        assertEquals("", v.ext);
    }

    @Test
    public void 大写与前后空白MIME被规整() {
        assertTrue(trig().judge(
            null, "  APPLICATION/OCTET-STREAM  ", "https://x.com/down", false).trigger);
        assertTrue(trig().judge(
            null, "Application/Zip", "https://x.com/down", false).trigger);
    }

    @Test
    public void 纯文本MIME带参数时既不触发也不否决() {
        // text/plain 是两用的：不表态，交给 URL 后缀
        assertFalse("无后缀的接口响应不该下",
            trig().judge(null, "text/plain;charset=UTF-8", "https://x.com/api/thing", false).trigger);
        assertTrue(".txt 后缀仍然要下",
            trig().judge(null, "text/plain;charset=UTF-8", "https://x.com/a.txt", false).trigger);
        // 需求冲突的取舍：text/plain + .zip 命中后缀时也触发（偏向「该下的要下」）
        assertTrue(trig().judge(null, "text/plain", "https://x.com/a.zip", false).trigger);
        // 但后缀是网页（.php）时仍不触发
        assertFalse(trig().judge(null, "text/plain", "https://x.com/down.php", false).trigger);
    }

    // --------------------------------------------------------- 误触发方向（更危险）

    @Test
    public void 网页MIME对后缀的一票否决是硬的() {
        assertFalse(trig().judge(null, "text/html", "https://x.com/", false).trigger);
        assertFalse(trig().judge(null, "text/html", "https://x.com/a.php", false).trigger);
        assertFalse("后缀命中已知媒体名也要被否决",
            trig().judge(null, "text/html", "https://x.com/a.mp4", false).trigger);
        assertFalse(trig().judge(null, "text/css", "https://x.com/a.css", false).trigger);
        // 大写 + charset 的网页 MIME 同样要被认出来
        assertFalse(trig().judge(null, "Text/HTML; charset=utf-8",
            "https://x.com/a.zip", false).trigger);
    }

    @Test
    public void 无MIME时网页后缀仍不触发() {
        assertFalse(trig().judge(null, null, "https://x.com/a.css", false).trigger);
        assertFalse(trig().judge(null, null, "https://x.com/index.html", false).trigger);
        assertFalse(trig().judge(null, null, "https://x.com/app.js", false).trigger);
    }

    @Test
    public void 媒体前缀MIME触发_记录其边界() {
        // video/ audio/ image/ 前缀一律当文件。这一档「宽」是刻意的：
        // 能走到 DownloadListener 的前提是 WebView 决定不渲染它，
        // 页面内嵌的 media/img 是子资源，不会走这里。
        assertTrue(trig().judge(null, "video/mp4", "https://x.com/watch", false).trigger);
        assertTrue(trig().judge(null, "audio/mpeg", "https://x.com/v", false).trigger);
        assertTrue(trig().judge(null, "image/png", "https://x.com/p", false).trigger);
    }

    @Test
    public void MIME优先于后缀_二进制MIME可覆盖网页后缀() {
        // 这是「MIME 信赖度高于后缀」的直接后果：服务器说 octet-stream，
        // 即便 URL 长得像 .css 也按文件处理。断言当前行为，风险等级见 QA 报告。
        assertTrue(trig().judge(
            null, "application/octet-stream", "https://x.com/style.css", false).trigger);
    }

    @Test
    public void inline硬否决即使MIME是文件() {
        // 服务器说了「内嵌显示」：视频站播放地址常带它，不该下
        assertFalse(trig().judge("inline", "application/octet-stream",
            "https://x.com/play", false).trigger);
        assertFalse(trig().judge("INLINE; filename=x.mp4", "video/mp4",
            "https://x.com/play", false).trigger);
    }

    @Test
    public void attachment大小写不敏感且要求http地址() {
        assertTrue(trig().judge("ATTACHMENT; filename=\"a.zip\"",
            "https://x.com/x", false).trigger);
        // url 检查在最前：非 http 即使标了 attachment 也不下
        assertFalse(trig().judge("attachment; filename=\"a.zip\"",
            "ftp://x.com/a.zip", false).trigger);
    }

    // ----------------------------------------------------- 两签名必须同一条逻辑路径

    @Test
    public void 三参与四参在MIME缺失时结果一致() {
        String[] urls = {
            "https://x.com/a.mp4",
            "https://x.com/index.html",
            "https://x.com/download?id=1",
            "https://x.com/api/v2/items",
            "https://x.com/a.zip",
            "https://x.com/a.dat",
            "https://x.com/",
        };
        DownloadTrigger t = trig();
        for (String u : urls) {
            boolean oldSig = t.judge(null, u, false).trigger;
            boolean newSig = t.judge(null, null, u, false).trigger;
            assertEquals("签名不一致于 " + u, oldSig, newSig);
        }
        // 带 attachment 的也要一致
        for (String u : urls) {
            boolean oldSig = t.judge("attachment; filename=\"x.bin\"", u, false).trigger;
            boolean newSig = t.judge("attachment; filename=\"x.bin\"", null, u, false).trigger;
            assertEquals("签名不一致于 " + u, oldSig, newSig);
        }
    }

    @Test
    public void 主文档在四参签名下同样永不触发() {
        assertFalse(trig().judge(null, "application/octet-stream",
            "https://x.com/a", true).trigger);
        assertFalse(trig().judge("attachment", "application/octet-stream",
            "https://x.com/a.zip", true).trigger);
    }
}
