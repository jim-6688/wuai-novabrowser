package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * 更新清单的解析与地址拼接。
 *
 * <p>这个类是 App 唯一的自救通道 —— 它一旦算错，用户不会收到任何报错，
 * 只会被悄悄钉在旧版本上。所以这里钉住的每一条都不是「顺手加的」，
 * 而是出错后<b>静默失效</b>、没人会发现的那一类。
 */
public class UpdateManagerTest {

    private static final String JSON = "{"
        + "\"version\": \"1.3.0\","
        + "\"versionCode\": 5,"
        + "\"updatedAt\": \"2026-10-20\","
        + "\"mandatory\": false,"
        + "\"minVersionCode\": 1,"
        + "\"changelog\": [\"甲\", \"乙\"],"
        + "\"downloads\": [{"
        + "  \"label\": \"官网直链\","
        + "  \"url\": \"download/nova-1.3.0.apk\","
        + "  \"size\": 123,"
        + "  \"sha256\": \"abc\""
        + "}]}";

    @Test
    public void 解析出版本号与下载地址() {
        UpdateManager.Manifest m = UpdateManager.parse(JSON);
        assertNotNull(m);
        assertEquals("1.3.0", m.version);
        assertEquals(5, m.versionCode);
        assertEquals(2, m.changelog.size());
        assertEquals("甲", m.changelog.get(0));

        UpdateManager.Link link = m.primary();
        assertNotNull(link);
        assertEquals("官网直链", link.label);
        assertEquals(123L, link.size);
        assertEquals("abc", link.sha256);
    }

    @Test
    public void 清单记下自己是从哪个地址读来的() {
        // 兜底地址读来的清单，必须用它自己的域名拼下载链接。
        // 记错来源就会出现「提示有新版，一点下载就 404」。
        String fallback = "https://mirror.example.com/version.json";
        UpdateManager.Manifest m = UpdateManager.parse(JSON, fallback);
        assertNotNull(m);
        assertEquals(fallback, m.baseUrl);
        assertEquals("https://mirror.example.com/download/nova-1.3.0.apk",
            UpdateManager.absolute(m.baseUrl, m.primary().url));
    }

    @Test
    public void 相对地址按基座补全() {
        // 清单里写相对路径，是为了换域名时清单一个字都不用改
        assertEquals("https://nova.52ta.top/download/a.apk",
            UpdateManager.absolute("https://nova.52ta.top/version.json", "download/a.apk"));
        // 清单里写的是带前导斜杠的根路径，也该拼对
        assertEquals("https://nova.52ta.top/download/a.apk",
            UpdateManager.absolute("https://nova.52ta.top/version.json", "/download/a.apk"));
    }

    @Test
    public void 已经是绝对地址就原样返回() {
        // Gitee Releases 那条是完整 https 地址，再拼一次基座会变成
        // 「https://域名/https://gitee.com/...」，下载必然失败
        String abs = "https://gitee.com/a/b.apk";
        assertEquals(abs, UpdateManager.absolute(abs));
        assertEquals(abs, UpdateManager.absolute(UpdateManager.UPDATE_URL, abs));
    }

    @Test
    public void 空地址原样返回不拼出半个链接() {
        // 清单缺 downloads 时 primary() 返回 null，出口已经拦过；
        // 这里防的是 url 字段为 null，拼出 "https://域名/null" 这种鬼东西
        assertEquals("", UpdateManager.absolute(""));
        assertNull(UpdateManager.absolute(null));
    }

    @Test
    public void 兜底地址表本身的形状必须对() {
        // 首选地址必须是 UPDATE_URL —— 顺序写反的话，正式域名就永远用不上，
        // 而且没人看得出来，因为两个地址都能读通
        assertEquals(UpdateManager.UPDATE_URL, UpdateManager.UPDATE_URLS[0]);
        assertTrue("至少要有一个兜底地址，否则域名一挂用户就锁死在旧版本",
            UpdateManager.UPDATE_URLS.length >= 2);

        // 每个地址都得带 /version.json：absolute() 靠它切出基座，
        // 少这一段会把整个域名当成目录，拼出 "https://a.com/version.json/download/x.apk"
        for (String url : UpdateManager.UPDATE_URLS) {
            assertTrue("地址必须以 /version.json 结尾，实际是 " + url,
                url.endsWith("/version.json"));
            assertTrue("自动更新不能走明文 http，实际是 " + url,
                url.startsWith("https://"));
        }
    }

    @Test
    public void 版本新旧判断() {
        UpdateManager.Manifest m = UpdateManager.parse(JSON); // versionCode 5
        assertTrue(m.newerThan(4));
        assertFalse("相同版本不算更新，否则用户会反复收到已装过的包", m.newerThan(5));
        assertFalse("装了比清单更新的版本（比如自己编译的）不该提示降级", m.newerThan(6));
    }

    @Test
    public void 强制更新与最低支持版本() {
        UpdateManager.Manifest m = UpdateManager.parse("{"
            + "\"version\":\"2.0.0\",\"versionCode\":9,"
            + "\"mandatory\":true,\"minVersionCode\":0}");
        assertNotNull(m);
        assertTrue("作者标了强制", m.mustUpdate(4));
        assertTrue(m.newerThan(4));
        assertFalse("已装的就是这个版本，不该再提示", m.newerThan(9));

        UpdateManager.Manifest low = UpdateManager.parse("{"
            + "\"version\":\"2.0.0\",\"versionCode\":9,"
            + "\"minVersionCode\":5}");
        assertNotNull(low);
        assertFalse("作者没标强制，且当前版本还够用", low.mustUpdate(5));
        assertTrue("当前版本已经低于最低支持版本，必须升", low.mustUpdate(4));
    }

    @Test
    public void 缺字段时给出安全默认值而不是崩() {
        // 清单是手写的，漏字段很常见。minVersionCode 缺了若按 0 算，
        // mustUpdate 会因为 0 > 0 不成立而放过真该强制升的版本；
        // 按 1 算才对 —— 任何装着的版本都 >= 1。
        UpdateManager.Manifest m = UpdateManager.parse(
            "{\"version\":\"1.0.0\",\"versionCode\":2}");
        assertNotNull(m);
        assertEquals(1, m.minVersionCode);
        assertTrue(m.changelog.isEmpty());
        assertTrue(m.downloads.isEmpty());
        assertNull("没有下载地址时 primary() 返回 null，调用方据此不显示下载按钮",
            m.primary());
    }

    @Test
    public void 坏输入返回null而不是抛异常() {
        assertNull(UpdateManager.parse(null));
        assertNull(UpdateManager.parse(""));
        assertNull(UpdateManager.parse("   "));
        assertNull("抓到了 HTML 错误页而不是清单", UpdateManager.parse("<html>404</html>"));
        assertNull("没有 versionCode 的清单没法比大小",
            UpdateManager.parse("{\"version\":\"1.0.0\"}"));
    }

    @Test
    public void 超长清单不会把内存吃满() throws Exception {
        // readAll 有 MAX_BYTES 上限，这里是它的行为契约：
        // 读到上限就停止，不抛也不截断出半个 JSON
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 20000; i++) sb.append('x');
        String text = UpdateManager.readAll(
            new java.io.ByteArrayInputStream(sb.toString().getBytes("UTF-8")),
            64 * 1024);
        assertTrue("应被上限截断", text.length() <= 64 * 1024);
        assertNull("截断后不是合法 JSON，解析应返回 null 而不是崩",
            UpdateManager.parse(text));
    }

    @Test
    public void 手动构造的清单也能正确工作() {
        // 单元测试与将来可能的本地缓存都要能直接造一个清单出来
        List<String> log = new ArrayList<>(Arrays.asList("修了一个问题"));
        List<UpdateManager.Link> links = new ArrayList<>();
        links.add(new UpdateManager.Link("官网直链", "download/x.apk", 1L, "s"));
        UpdateManager.Manifest m = new UpdateManager.Manifest(
            "9.9.9", 99, "2026-01-01", false, 1, log, links,
            "https://nova.52ta.top/version.json");
        assertEquals(99, m.versionCode);
        assertEquals("https://nova.52ta.top/download/x.apk",
            UpdateManager.absolute(m.baseUrl, m.primary().url));
    }

    @Test
    public void 基座为空时回落到首选域名() {
        // 来源地址丢了也不能拼出 "null/download/x.apk"
        UpdateManager.Manifest m = new UpdateManager.Manifest(
            "1.0.0", 2, "2026-01-01", false, 1,
            new ArrayList<String>(), new ArrayList<UpdateManager.Link>(), null);
        assertEquals(UpdateManager.UPDATE_URL, m.baseUrl);
    }

    // -------------------------------------------- 下载与校验（都不依赖 Android）

    @Test
    public void 安装包文件名由版本号决定() {
        assertEquals("nova-1.2.3.apk", UpdateManager.apkName("1.2.3"));
        assertEquals("nova-1.2.3.apk", UpdateManager.apkName("  1.2.3  "));
        // 版本号拿不到时不能拼出 "nova-.apk"：那个名字会被所有版本共用，
        // 于是新包会静默覆盖掉旧包，而下一次「就绪检测」就分不清谁是谁了。
        assertEquals("nova-latest.apk", UpdateManager.apkName(null));
        assertEquals("nova-latest.apk", UpdateManager.apkName(""));
        assertEquals("nova-latest.apk", UpdateManager.apkName("   "));
    }

    @Test
    public void 版本号里的路径字符会被剔掉() {
        // 清单是网络上读来的。这条挡的是「一个手误的版本号把文件写到别的目录去」。
        assertEquals("nova-1.23.apk", UpdateManager.apkName("1.2/3"));
        assertFalse(UpdateManager.apkName("a\\b").contains("\\"));

        String evil = UpdateManager.apkName("../evil");
        assertFalse("文件名里不该有路径分隔符", evil.contains("/"));
        assertFalse("连续两个点表示上一层目录，必须被压掉", evil.contains(".."));
    }

    @Test
    public void sha256算的是整包内容() throws Exception {
        File f = File.createTempFile("nova-sha", ".bin");
        try {
            // 空文件：先挡住「读不到内容也照样返回一个看起来合法的摘要」。
            assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                UpdateManager.sha256(f));

            try (java.io.FileOutputStream out = new java.io.FileOutputStream(f)) {
                out.write("abc".getBytes("UTF-8"));
            }
            assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                UpdateManager.sha256(f));

            // 多一个字节就该完全不同 —— 这条挡住的是「只算了开头几个块」的实现。
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(f, true)) {
                out.write('d');
            }
            assertNotEquals("abcd 的摘要不该等于 abc 的摘要",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                UpdateManager.sha256(f));
        } finally {
            f.delete();
        }
    }
}
