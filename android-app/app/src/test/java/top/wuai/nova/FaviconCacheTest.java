package top.wuai.nova;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/**
 * 图标缓存里那几段「不碰 Android 类」的解析逻辑。
 *
 * <p>它们共同的问题是：错了不会抛异常，只会在页面上变成一个破图或者一个空磁贴 ——
 * 那种错没人会为此开 issue，只会觉得「这个功能好像不太好用」。所以这里把
 * 「什么算图片」「ICO 里那份图在哪（PNG 型与 BMP 型两条路）」「主机名怎么写进文件名」
 * 分别钉住。BMP 那支还要多钉一件事：图是自下而上存的，翻错了方向，图标会上下颠倒。
 */
public class FaviconCacheTest {

    // ------------------------------------------------------------ 字节头

    @Test
    public void 认得四种浏览器支持的图片格式() {
        assertEquals("image/png", FaviconCache.sniffMime(png(64)));
        assertEquals("image/jpeg", FaviconCache.sniffMime(new byte[] {
            (byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0,
            0, 0, 0, 0, 0, 0, 0, 0 }));
        assertEquals("image/gif", FaviconCache.sniffMime(new byte[] {
            'G', 'I', 'F', '8', '9', 'a', 0, 0, 0, 0, 0, 0 }));
        assertEquals("image/webp", FaviconCache.sniffMime(new byte[] {
            'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'E', 'B', 'P' }));
    }

    @Test
    public void 把404页面当成图标是不行的() {
        // 真实来源：不少站点对 /favicon.ico 回一个 200 的 HTML 错误页。
        // 只看 Content-Type 会把它存下来，页面上就是一个破图。
        String html = "<!DOCTYPE html><html><body>not found</body></html>";
        assertNull(FaviconCache.sniffMime(html.getBytes()));
        assertNull(FaviconCache.sniffMime(new byte[] {'P', 'N'}));
        assertNull(FaviconCache.sniffMime(null));
        assertNull(FaviconCache.sniffMime(new byte[0]));
    }

    // ------------------------------------------------------------ ICO

    @Test
    public void 从ico里挑最大的那份PNG() {
        byte[] small = png(32);
        byte[] big = png(2048);
        byte[] ico = ico(new byte[][] {small, big});
        // 壳本身不是图片：认不出来才对，否则调用方会把它整包当成 PNG 存下来。
        assertNull(FaviconCache.sniffMime(ico));
        // 最小那张（16×16）不该被选中：它在 30dp 的磁贴上糊得看不出是什么，
        // 而它在文件里的顺序并不保证是最后一张。
        byte[] got = FaviconCache.pngFromIco(ico);
        assertEquals(2048, got.length);
        assertArrayEquals(big, got);
    }

    @Test
    public void 只有BMP的老图标抠不出来也不报错() {
        // XP 时代留下的那种 .ico 里没有 PNG，这里必须返回 null ——
        // 调用方会当作这次抓取失败，页面回落成渐变底 + 首字。
        byte[] bmpEntry = new byte[64];
        bmpEntry[0] = 40; // BITMAPINFOHEADER 的起始，不是 PNG 的魔数
        assertNull(FaviconCache.pngFromIco(ico(new byte[][] {bmpEntry})));
        assertNull(FaviconCache.pngFromIco(null));
        assertNull(FaviconCache.pngFromIco(new byte[] {1, 2, 3}));
        // 壳对不上（type 不是 1）也要安静地返回 null
        byte[] notIco = ico(new byte[][] {png(16)});
        notIco[2] = 2;
        assertNull(FaviconCache.pngFromIco(notIco));
    }

    // ------------------------------------------------------------ BMP 型的 ICO

    @Test
    public void 老式ico里的32位位图解得出正确的像素与上下方向() {
        // 实测百度那份 favicon.ico 就是这个规格：64×64、32bpp、不压缩的 BMP。
        // 只认「ICO 里嵌 PNG」那一支的话，这一类站点一家图标都拿不到。
        int w = 2;
        int h = 2;
        int top = 0xFF112233;      // 上一行
        int bottom = 0xFFAABBCC;   // 下一行
        int[] argb = {top, top, bottom, bottom};
        int[] wh = new int[2];
        int[] got = FaviconCache.bmpFromIco(bmpIco32(w, h, argb), wh);
        assertEquals(w, wh[0]);
        assertEquals(h, wh[1]);
        // BMP 是自下而上存的，读的时候必须翻回来 —— 不翻的话图标会上下颠倒，
        // 而「颠倒的 logo」在一格 30dp 的磁贴上不容易被认成 bug。
        assertArrayEquals(argb, got);
    }

    @Test
    public void 调色板与压缩过的老图标直接放弃而不是猜() {
        byte[] ico = bmpIco32(2, 2, new int[] {0xFF000000, 0xFF000000, 0xFF000000, 0xFF000000});
        int off = 22;
        // bpp 改成 8（调色板）与 compression 改成 1（RLE 压缩）两种都要返回 null
        byte[] palettized = ico.clone();
        palettized[off + 14] = 8;
        assertNull(FaviconCache.bmpFromIco(palettized, new int[2]));
        byte[] compressed = ico.clone();
        compressed[off + 16] = 1;
        assertNull(FaviconCache.bmpFromIco(compressed, new int[2]));
        // 数据被截断（声称的高度比实际字节多）也不能越界读
        byte[] truncated = new byte[40];
        assertNull(FaviconCache.bmpFromIco(truncated, new int[2]));
    }

    @Test
    public void 解出来的像素被交给编码器换成PNG() {
        // 这一步在真机上用 Bitmap 完成，本地单测里换成一支假的 ——
        // 解析那半因此测得动，而「编码器被正确调用、参数是宽高」这件事也钉住了。
        int[] argb = {0xFF112233, 0xFFAABBCC, 0xFF445566, 0xFF778899};
        byte[] ico = bmpIco32(2, 2, argb);
        int[] seen = new int[3];
        FaviconCache cache = new FaviconCache(tempDir(), (px, w, h) -> {
            seen[0] = px.length;
            seen[1] = w;
            seen[2] = h;
            return png(64);
        });
        byte[] png = cache.pngFromBmpIco(ico);
        assertEquals(64, png.length);
        assertArrayEquals(new int[] {4, 2, 2}, seen);
        // 编码器抛异常（真机上 Bitmap 会 OOM）时安静地返回 null，不往上冒
        FaviconCache broken = new FaviconCache(tempDir(), (px, w, h) -> {
            throw new IllegalStateException("boom");
        });
        assertNull(broken.pngFromBmpIco(ico));
    }

    // ------------------------------------------------------------ 文件名

    @Test
    public void 主机名照原样当文件名() {
        assertEquals("www.zhihu.com", FaviconCache.fileNameFor("www.zhihu.com"));
        assertEquals("xn--fiqs8s.example", FaviconCache.fileNameFor("xn--fiqs8s.example"));
    }

    @Test
    public void 带路径或大写的主机名不会写到目录外面去() {
        // 唯一的输入校验。挡的是「构造一个能跳出缓存目录的名字」——
        // new File(dir, "../../x") 会直接写到别的目录。
        assertEquals(".._.._etc_passwd", FaviconCache.fileNameFor("../../etc/passwd"));
        assertEquals("a_b.com", FaviconCache.fileNameFor("A/B.com"));
        assertEquals("site", FaviconCache.fileNameFor(""));
        assertEquals("site", FaviconCache.fileNameFor(null));
    }

    // ------------------------------------------------------------ 夹具

    /** 造一份「字节头是 PNG 的」数据。内容无所谓 —— 这一层不解析 PNG。 */
    private static byte[] png(int n) {
        byte[] b = new byte[Math.max(n, 12)];
        b[0] = (byte) 0x89;
        b[1] = 'P';
        b[2] = 'N';
        b[3] = 'G';
        b[4] = 13;
        b[5] = 10;
        return b;
    }

    /** 按 ICO 的格式拼一个壳：ICONDIR + 每个条目的 16 字节目录项 + 数据。 */
    private static byte[] ico(byte[][] entries) {
        int header = 6 + 16 * entries.length;
        int total = header;
        for (byte[] e : entries) total += e.length;
        byte[] out = new byte[total];
        out[2] = 1;                     // type = 1（图标）
        out[4] = (byte) entries.length; // count 低字节
        int off = header;
        for (int i = 0; i < entries.length; i++) {
            int dir = 6 + i * 16;
            out[dir + 8] = (byte) (entries[i].length & 0xFF);
            out[dir + 9] = (byte) ((entries[i].length >> 8) & 0xFF);
            out[dir + 12] = (byte) (off & 0xFF);
            out[dir + 13] = (byte) ((off >> 8) & 0xFF);
            System.arraycopy(entries[i], 0, out, off, entries[i].length);
            off += entries[i].length;
        }
        return out;
    }

    /**
     * 拼一份「老式」ICO：壳里装的是一张 32bpp 不压缩的 BMP 位图。
     *
     * <p>规格照实测那份百度的 favicon.ico 来：BITMAPINFOHEADER（40 字节）+
     * 自下而上的 BGRA 像素 + 一份 1bpp 的 AND 掩码，且头部里的高度是真实高度的两倍。
     */
    private static byte[] bmpIco32(int w, int h, int[] argb) {
        int stride = w * 4;
        int maskStride = ((w + 31) / 32) * 4;
        int pxSize = stride * h;
        int bitmap = 40 + pxSize + maskStride * h;
        byte[] out = new byte[22 + bitmap];
        out[2] = 1;                     // type = 1
        out[4] = 1;                     // count = 1
        put32(out, 6 + 8, bitmap);      // 目录项：字节数
        put32(out, 6 + 12, 22);         // 目录项：偏移
        int off = 22;
        put32(out, off, 40);            // biSize
        put32(out, off + 4, w);
        put32(out, off + 8, h * 2);     // 双倍高度
        out[off + 12] = 1;              // planes
        out[off + 14] = 32;             // bpp
        int px = off + 40;
        for (int r = 0; r < h; r++) {
            int imgRow = h - 1 - r;     // 文件里第一行是图像的最后一行
            for (int x = 0; x < w; x++) {
                int c = argb[imgRow * w + x];
                int i = px + r * stride + x * 4;
                out[i] = (byte) (c & 0xFF);
                out[i + 1] = (byte) ((c >> 8) & 0xFF);
                out[i + 2] = (byte) ((c >> 16) & 0xFF);
                out[i + 3] = (byte) ((c >>> 24) & 0xFF);
            }
        }
        return out;
    }

    private static void put32(byte[] b, int i, int v) {
        b[i] = (byte) (v & 0xFF);
        b[i + 1] = (byte) ((v >> 8) & 0xFF);
        b[i + 2] = (byte) ((v >> 16) & 0xFF);
        b[i + 3] = (byte) ((v >> 24) & 0xFF);
    }

    /** 缓存目录。这一层不真写文件，但构造器要求一个目录。 */
    private static java.io.File tempDir() {
        return new java.io.File(System.getProperty("java.io.tmpdir"),
            "nova-favicon-test-" + System.nanoTime());
    }
}
