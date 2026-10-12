package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * 无图判定的单测。
 *
 * <p>这一组测的是<b>移动端最容易出错的地方</b>：按后缀猜类型。
 * 猜错的两种后果都不轻 —— 该拦的没拦（省不下流量，还让人以为省了），
 * 不该拦的拦了（页面直接散架）。而这两种错在真机上都不容易看出来，
 * 所以必须离线钉死。
 */
public class NoImagePolicyTest {

    private static Set<String> media() {
        return new HashSet<>(Arrays.asList("mp4", "m3u8", "mp3", "m4a", "flv"));
    }

    private static NoImagePolicy policy(NoImagePolicy.Level lv) {
        return new NoImagePolicy(lv, media());
    }

    // ------------------------------------------------------------ 主文档

    @Test
    public void 主文档永远放行() {
        // 主文档哪怕后缀就是 .jpg 也得放行。拦掉它整页都打不开 ——
        // 这是本类最不能错的一条，所以放在最前面测。
        for (NoImagePolicy.Level lv : NoImagePolicy.Level.values()) {
            assertFalse(policy(lv).judge("https", "/a/b.jpg", true).block);
        }
    }

    // ------------------------------------------------------------ 协议

    @Test
    public void 非网络协议放行() {
        NoImagePolicy p = policy(NoImagePolicy.Level.IMAGE_AV);
        // data: / blob: / file: 拦了省不下一个字节，却会搞坏页面自己的内联资源
        assertFalse(p.judge("data", "/a/b.png", false).block);
        assertFalse(p.judge("blob", "/a/b.png", false).block);
        assertFalse(p.judge("file", "/a/b.png", false).block);
        assertFalse(p.judge("ftp", "/a/b.png", false).block);
        assertFalse(p.judge("", "/a/b.png", false).block);
        assertFalse(p.judge(null, "/a/b.png", false).block);
    }

    // ------------------------------------------------------------ 关闭档

    @Test
    public void 关闭档不拦任何东西() {
        NoImagePolicy p = policy(NoImagePolicy.Level.OFF);
        assertFalse(p.judge("https", "/a/b.jpg", false).block);
        assertFalse(p.judge("https", "/a/b.mp4", false).block);
        assertFalse(p.active());
        assertFalse(NoImagePolicy.Level.OFF.active());
    }

    // ------------------------------------------------------------ 图片

    @Test
    public void 无图档拦图片() {
        NoImagePolicy p = policy(NoImagePolicy.Level.IMAGE);
        NoImagePolicy.Decision d = p.judge("https", "/img/a.jpg", false);
        assertTrue(d.block);
        assertEquals("image", d.kind);
    }

    @Test
    public void 常见图片后缀都拦() {
        NoImagePolicy p = policy(NoImagePolicy.Level.IMAGE);
        String[] exts = {"jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg"};
        for (String e : exts) {
            assertTrue(e, p.judge("https", "/a/b." + e, false).block);
        }
    }

    @Test
    public void 大写后缀也拦() {
        // URL 里的后缀大小写混用很常见。不转小写的话 CDN 返回的大写路径就全漏了。
        assertTrue(policy(NoImagePolicy.Level.IMAGE).judge("https", "/a/b.JPG", false).block);
        assertTrue(policy(NoImagePolicy.Level.IMAGE).judge("https", "/a/b.PnG", false).block);
    }

    @Test
    public void 媒体在无图档不拦() {
        // 这一档只管图。视频照常加载，否则「看视频」这个最基本的功能就没了。
        assertFalse(policy(NoImagePolicy.Level.IMAGE).judge("https", "/v/a.mp4", false).block);
    }

    @Test
    public void 媒体在最高档拦() {
        NoImagePolicy p = policy(NoImagePolicy.Level.IMAGE_AV);
        NoImagePolicy.Decision d = p.judge("https", "/v/a.mp4", false);
        assertTrue(d.block);
        assertEquals("media", d.kind);
    }

    // ------------------------------------------------------------ 边界

    @Test
    public void 无后缀不拦() {
        // 这是移动端的硬边界，不是遗漏。拦它就得先把响应拉回来，
        // 流量已经产生了，省流量的意义当场归零。
        NoImagePolicy.Decision d = policy(NoImagePolicy.Level.IMAGE_AV).judge("https", "/a/b/c", false);
        assertFalse(d.block);
        assertTrue(d.reason.contains("无后缀"));
    }

    @Test
    public void 伪静态不拦() {
        // 同上：/img.php?id=12 没有可用的后缀
        assertFalse(policy(NoImagePolicy.Level.IMAGE_AV).judge("https", "/img.php", false).block);
    }

    @Test
    public void 版本号不被当后缀() {
        // /v1.2/page 的最后一段是 page，点不在最后一段里 —— 不能取成 "2/page"
        assertEquals("", NoImagePolicy.extOf("/v1.2/page"));
        assertFalse(policy(NoImagePolicy.Level.IMAGE).judge("https", "/v1.2/page", false).block);
    }

    @Test
    public void 结尾的点不算后缀() {
        assertEquals("", NoImagePolicy.extOf("/a/b."));
        assertEquals("", NoImagePolicy.extOf("/a/b"));
        assertEquals("", NoImagePolicy.extOf(""));
        assertEquals("", NoImagePolicy.extOf(null));
    }

    @Test
    public void 前导点不是扩展名() {
        // 点在段首说明这是一个「以点开头的段」（/.well-known、/.git），
        // 不是文件的后缀。把 well-known 当成扩展名会误伤一批域名。
        assertEquals("", NoImagePolicy.extOf("/.well-known"));
        assertEquals("", NoImagePolicy.extOf("/.git/config"));
        // 对照：点在中间、后面还有内容，那才是扩展名
        assertEquals("js", NoImagePolicy.extOf("/a.b.js"));
    }

    // ------------------------------------------------------------ favicon

    @Test
    public void 站点图标放行() {
        // 拦掉站点图标省不下多少字节，又让标签页看起来像坏了
        NoImagePolicy p = policy(NoImagePolicy.Level.IMAGE_AV);
        assertFalse(p.judge("https", "/favicon.ico", false).block);
        assertFalse(p.judge("https", "/favicon-32x32.png", false).block);
        assertFalse(p.judge("https", "/assets/favicon_v2.png", false).block);
        assertFalse(p.judge("https", "/FAVICON.PNG", false).block);
    }

    @Test
    public void faviconAllow判定() {
        assertTrue(NoImagePolicy.faviconAllow("/favicon.ico"));
        assertTrue(NoImagePolicy.faviconAllow("/a/b/favicon-16.png"));
        // 只是「favicon」开头就算，中间夹什么都行 ——
        // 这是启发式，故意放宽。见方法的类注释。
        assertTrue(NoImagePolicy.faviconAllow("/faviconx/bar.png"));
        assertFalse(NoImagePolicy.faviconAllow("/logo.png"));
        assertFalse(NoImagePolicy.faviconAllow(null));
    }

    // ------------------------------------------------------------ 档位

    @Test
    public void 档位id与桌面端一致() {
        // 这三个字符串必须与桌面端 settings.js 的 mobile.noImage 逐字相同。
        // 对不上就会出现「桌面端关了手机端还开着」这种最难查的不一致。
        assertEquals("off", NoImagePolicy.Level.OFF.id);
        assertEquals("image", NoImagePolicy.Level.IMAGE.id);
        assertEquals("image-av", NoImagePolicy.Level.IMAGE_AV.id);
    }

    @Test
    public void 未知档位落回关闭() {
        assertEquals(NoImagePolicy.Level.OFF, NoImagePolicy.Level.fromId("nope"));
        assertEquals(NoImagePolicy.Level.OFF, NoImagePolicy.Level.fromId(null));
        assertEquals(NoImagePolicy.Level.IMAGE, NoImagePolicy.Level.fromId("image"));
    }

    @Test
    public void ico不在图片名单里() {
        // ico 走 faviconAllow 那条放行，不该再被当成普通图片重复处理
        assertFalse(NoImagePolicy.IMAGE_EXTS.contains("ico"));
    }

    @Test
    public void 字体一律不拦() {
        // 大量站点的界面图标就是字体。拦掉页面直接散架，
        // 省下的字节远不如图片视频可观 —— 明确取舍。
        assertFalse(NoImagePolicy.IMAGE_EXTS.contains("woff"));
        assertFalse(NoImagePolicy.IMAGE_EXTS.contains("woff2"));
        assertFalse(NoImagePolicy.IMAGE_EXTS.contains("ttf"));
    }
}