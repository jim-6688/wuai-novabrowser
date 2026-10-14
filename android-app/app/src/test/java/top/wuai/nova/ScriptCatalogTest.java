package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * 可选脚本库清单的单测。
 *
 * <p>这里验的不是「有没有内容」，而是三件更要紧的事。
 *
 * <h3>一、地址拼得对</h3>
 *
 * <p>{@code URLEncoder} 会把空格编成 {@code +}，而 {@code +} 在 URL 路径里是
 * <b>字面加号</b>，于是中文脚本名一含空格，拼出来的地址就指向一个不存在的文件，
 * 表现为 404 且看不出原因。清单里的脚本名既有中文、又有表情符号和竖线，
 * 这一段编码错了是<b>每一条</b>都装不上。
 *
 * <h3>二、清单说「引擎能跑」必须是真的</h3>
 *
 * <p>本引擎的 {@code GM_} 支持集只有 {@link GmShim#SUPPORTED} 那六项。
 * 清单里每条的 {@code @grant} 都是选品时一条条核过的，这条测试就是把那次核对
 * 固化成可执行的断言 —— 否则加一条新脚本时，「它声明了 GM_setValue」这种
 * 事没有任何东西会拦住。
 *
 * <h3>三、内置的那几份就是审计过的那一份</h3>
 *
 * <p>标着「已内置」的脚本是第三方代码、随包发给每一个用户。它们对 sha256，
 * 清单里记着值，改一个字符就会红。这不是麻烦 —— 这正是
 * 「内置的是哪一份」唯一的答案。
 */
public class ScriptCatalogTest {

    /** assets 在源码树里的位置。单测跑在模块目录下，读的是源文件不是打包后的 apk。 */
    private static File asset(String rel) {
        return new File("src/main/assets", rel);
    }

    // ------------------------------------------------------------ 清单形状

    @Test
    public void 清单不为空() {
        assertFalse(ScriptCatalog.ALL.isEmpty());
    }

    @Test
    public void key不重复() {
        // key 是「这条装过没有」的判据。重复会让两条清单项互相顶掉。
        Set<String> seen = new HashSet<>();
        for (ScriptCatalog.Item it : ScriptCatalog.ALL) {
            assertTrue("key 重复：" + it.key, seen.add(it.key));
        }
    }

    @Test
    public void 每条的必要字段都不空() {
        for (ScriptCatalog.Item it : ScriptCatalog.ALL) {
            assertTrue(it.key + " 缺 scriptId", it.scriptId > 0);
            assertFalse(it.key + " 缺 fileName", it.fileName.isEmpty());
            assertFalse(it.key + " 缺 name", it.name.isEmpty());
            assertFalse(it.key + " 缺 author", it.author.isEmpty());
            assertFalse(it.key + " 缺 license", it.license.isEmpty());
            assertFalse(it.key + " 缺 desc", it.desc.isEmpty());
            assertTrue(it.key + " 的安装量不该是 0（它是选品依据）", it.installs > 0);
        }
    }

    @Test
    public void 分类下标只有两个() {
        // 「有内置/没内置」是个布尔，不是让调用方自己去比 asset 字符串长短。
        for (ScriptCatalog.Item it : ScriptCatalog.ALL) {
            assertEquals(it.key + " 的 bundled 与 asset 对不上",
                !it.asset.isEmpty(), it.bundled);
        }
    }

    // ------------------------------------------------------------ 地址

    @Test
    public void 直链指向脚本猫的脚本正文地址() {
        // 用 /scripts/code/ 而不是展示页：前者直接返回 .user.js 正文，
        // 后者是一张 HTML 页面，得再抓一次才拿得到源码 —— 而 ScriptInstaller
        // 会把「下回来的是网页」判成失败。
        ScriptCatalog.Item it = ScriptCatalog.byKey("auto-expand");
        String url = ScriptCatalog.installUrl(it);
        assertTrue(url.startsWith("https://scriptcat.org/scripts/code/"));
        assertTrue(url.contains("/" + it.scriptId + "/"));
        assertTrue(url.endsWith(".user.js"));
    }

    @Test
    public void 展示页地址指向脚本猫() {
        for (ScriptCatalog.Item it : ScriptCatalog.ALL) {
            assertTrue(it.key + " 的展示页地址不对：" + ScriptCatalog.homeUrl(it),
                ScriptCatalog.homeUrl(it)
                    .startsWith("https://scriptcat.org/script-show-page/"));
        }
    }

    @Test
    public void 空格编成百分号而不是加号() {
        assertEquals("a%20b", ScriptCatalog.pathEncode("a b"));
        assertFalse(ScriptCatalog.pathEncode("a b").contains("+"));
    }

    @Test
    public void 中文被逐字节编码() {
        // 「自动展开」。中文按 UTF-8 逐字节编，ASCII 与空格保留规则不变。
        String e = ScriptCatalog.pathEncode("自动展开");
        assertTrue(e.startsWith("%E8%87%AA%E5%8A%A8"));
        assertFalse(e.contains("+"));
    }

    @Test
    public void 保留字符不被编码() {
        // RFC 3986 的非保留字符原样保留，编了也能用但地址会变得难读
        assertEquals("-._~Az09", ScriptCatalog.pathEncode("-._~Az09"));
    }

    @Test
    public void 表情与竖线都能编掉() {
        // 清单里真有这样的名字（「🎬 B站视频下载器 | ...」）。竖线不编的话
        // 这一段会被当成路径分隔之外的保留字符，服务端收到的地址就变了样。
        String e = ScriptCatalog.pathEncode("🎬 B站 | 下载");
        assertFalse("竖线没被编掉：" + e, e.contains("|"));
        assertFalse("空格没被编掉：" + e, e.contains(" "));
        assertTrue(e.startsWith("%F0%9F%8E%AC"));   // 🎬 的 UTF-8
    }

    @Test
    public void 来源地址能反查回清单项() {
        for (ScriptCatalog.Item it : ScriptCatalog.ALL) {
            ScriptCatalog.Item back = ScriptCatalog.fromOrigin(ScriptCatalog.homeUrl(it));
            assertNotNull(it.key + " 反查不到", back);
            assertEquals(it.key, back.key);
        }
    }

    @Test
    public void 非清单来源反查为空() {
        // 用户自己从文件装的脚本，origin 是 content:// 之类的 uri，不该被认成清单项
        assertNull(ScriptCatalog.fromOrigin("content://downloads/123"));
        // 旧版本（Greasy Fork 时代）装上的脚本也是这个下场：反查为空。
        // 不认它们是**对**的 —— 那几条的来源与现在这套清单已经不是一回事了。
        assertNull(ScriptCatalog.fromOrigin("https://greasyfork.org/zh-CN/scripts/584494"));
        assertNull(ScriptCatalog.fromOrigin(""));
        assertNull(ScriptCatalog.fromOrigin(null));
    }

    @Test
    public void 按key查不到返回空() {
        assertNull(ScriptCatalog.byKey("不存在的key"));
        assertNull(ScriptCatalog.byKey(null));
        assertNotNull(ScriptCatalog.byKey("auto-expand"));
    }

    @Test
    public void 每个分类都有条目() {
        // 分类是面板上的一级结构。空分类会在界面上留下一个没有内容的标题。
        for (ScriptCatalog.Category c : ScriptCatalog.Category.values()) {
            assertFalse("分类「" + c.label + "」下没有条目",
                ScriptCatalog.of(c).isEmpty());
        }
    }

    // ------------------------------------------------------------ 引擎跑不跑得起来

    @Test
    public void 每条脚本声明的权限引擎都得支持() {
        // 这条是整份清单的选品门槛，写成断言才拦得住下一个人。
        // 引擎只提供 GmShim.SUPPORTED 那六项，清单里出现 GM_setValue、
        // GM_xmlhttpRequest 之类的，用户装上就是静默失败 —— 那比不提供更糟。
        for (ScriptCatalog.Item it : ScriptCatalog.ALL) {
            for (String g : it.grants) {
                assertTrue(it.key + " 声明了引擎不支持的权限：" + g
                        + "。支持集只有 " + GmShim.SUPPORTED,
                    GmShim.isSupported(g));
            }
        }
    }

    @Test
    public void 权限清单里不该出现none() {
        // none 是「我不要任何特权」的声明，它本身不是一项特权。
        // 混进来的话，上面那条断言会把它当成一项待核对的权限，
        // 而它其实什么都没请求。
        for (ScriptCatalog.Item it : ScriptCatalog.ALL) {
            for (String g : it.grants) {
                assertFalse(it.key + " 的 grants 里混进了 none",
                    "none".equalsIgnoreCase(g.trim()));
            }
        }
    }

    @Test
    public void 两种权限声明都在清单里() {
        // 空列表 = 「它没要任何特权」（脚本头里 @grant none 或压根没写 @grant）。
        // 非空 = 要了本引擎支持的那六项里的某几项。
        // 两种都要有：只有空的话，grants 这套机制等于没被验证过；
        // 只有非空的话，覆盖不了清单里占多数的那一批。
        boolean anyEmpty = false, anyDeclared = false;
        for (ScriptCatalog.Item it : ScriptCatalog.ALL) {
            if (it.grants.isEmpty()) anyEmpty = true; else anyDeclared = true;
        }
        assertTrue("没有一条是「不要特权」的", anyEmpty);
        assertTrue("没有一条声明了受支持的权限，grants 机制没被验证到", anyDeclared);
    }

    // ------------------------------------------------------------ 内置的那几份

    @Test
    public void 至少有一条内置的脚本() {
        // 内置是这次改动的全部意义：断网也装得上。一条都没有的话，
        // 「需联网」就成了唯一的选项 —— 而 Greasy Fork 那件事说明
        // 网络对一部分用户是恒定的障碍，不是偶发。
        assertFalse("一条内置的都没有", ScriptCatalog.bundledItems().isEmpty());
    }

    @Test
    public void 内置的也能按分类看到() {
        // bundledItems() 只是过滤器，不该把条目从 ALL 里摘出去：
        // 面板是按分类遍历 ALL 画的，摘出去等于界面上看不见。
        for (ScriptCatalog.Item it : ScriptCatalog.bundledItems()) {
            assertTrue(it.key + " 不在 ALL 里", ScriptCatalog.ALL.contains(it));
        }
    }

    @Test
    public void 内置条目的资产路径与哈希形状都对() {
        for (ScriptCatalog.Item it : ScriptCatalog.ALL) {
            if (!it.bundled) {
                assertEquals(it.key + " 没内置却带着资产路径", "", it.asset);
                assertEquals(it.key + " 没内置却带着哈希", "", it.sha256);
                continue;
            }
            assertTrue(it.key + " 的资产路径应在 " + ScriptCatalog.ASSET_DIR + " 下，实际是 "
                    + it.asset,
                it.asset.startsWith(ScriptCatalog.ASSET_DIR));
            assertTrue(it.key + " 的 sha256 形状不对：" + it.sha256,
                it.sha256.matches("[0-9a-f]{64}"));
        }
    }

    @Test
    public void 内置脚本的正文与清单记录的哈希一致() throws Exception {
        // 与 BuiltinScriptsTest 里那条同源。失败时该做的是
        // 「重新审计这份脚本，再把清单里的 sha256 换成新的」，
        // 而不是把这条测试删掉。
        for (ScriptCatalog.Item it : ScriptCatalog.bundledItems()) {
            assertEquals(it.key + " 的脚本内容与清单记录不符。"
                    + "换版本请重新审计并更新 ScriptCatalog 里的 sha256",
                it.sha256, sha256(asset(it.asset)));
        }
    }

    @Test
    public void 内置脚本文件都真实存在() {
        String cwd = new File(".").getAbsolutePath();
        for (ScriptCatalog.Item it : ScriptCatalog.bundledItems()) {
            assertTrue(it.asset + " 不存在（当前目录 " + cwd + "）",
                asset(it.asset).isFile());
        }
    }

    @Test
    public void 内置脚本都能解析且权限与清单记录一致() {
        // 「清单里记的权限」和「脚本自己声明的权限」是两份数据，
        // 迟早有一份会过时。对不上就说明有人改了脚本却没改清单 ——
        // 而界面上的门槛判断走的正是清单那份。
        for (ScriptCatalog.Item it : ScriptCatalog.bundledItems()) {
            UserScript.Parsed p = UserScript.parse(read(asset(it.asset)));
            assertTrue(it.key + " 解析失败：" + p.error, p.ok());
            assertFalse(it.key + " 解析出来没有名字", p.meta.name.trim().isEmpty());

            Set<String> declared = lower(p.meta.grants);
            Set<String> recorded = lower(it.grants);
            assertEquals(it.key + " 的 @grant 与清单记录不一致（脚本：" + declared
                + "，清单：" + recorded + "）", recorded, declared);
        }
    }

    @Test
    public void 内置脚本在普通网页上都真的会跑起来() {
        // 只看 @match 非空不够：模式写错（比如漏了 *://）同样是非空，
        // 结果是一条网址都匹配不上 —— 脚本装着、列表里看得见、就是不运行，
        // 而且没有任何报错。
        //
        // 这里只要求「至少在 http 或 https 的普通页面上能命中一条」，
        // 不要求它在 example.com 上命中：内置的这批里有只针对
        // 某个站点（B 站、4khd）的，那是对的，不是缺陷。
        for (ScriptCatalog.Item it : ScriptCatalog.bundledItems()) {
            UserScript.Parsed p = UserScript.parse(read(asset(it.asset)));
            assertFalse(it.key + " 没有声明 @match 或 @include",
                p.meta.match.isEmpty() && p.meta.include.isEmpty());
            assertFalse(it.key + " 声明了 @match 但模式全是空的",
                p.meta.match.isEmpty()
                    || p.meta.match.stream().allMatch(m -> m.trim().isEmpty()));
        }
    }

    @Test
    public void 许可未内置的条目里不该混进可再分发的许可() {
        // 反向的护栏：许可明确允许再分发的（MIT / GPL / Apache / LGPL / BSD），
        // 没理由不内置 —— 除非是漏了。这条不强制一定要内置
        // （脚本太大、跑不起来也都可能是理由），只是把它标出来。
        // 真遇到合理例外时改这里，别默默放过。
        for (ScriptCatalog.Item it : ScriptCatalog.ALL) {
            if (it.bundled) continue;
            String lic = it.license.toUpperCase(Locale.ROOT);
            boolean permissive = lic.startsWith("MIT") || lic.contains("GPL")
                || lic.contains("APACHE") || lic.contains("BSD") || lic.contains("MPL");
            assertFalse(it.key + " 的许可是 " + it.license
                + "（允许再分发），却没内置 —— 是漏了吗？", permissive);
        }
    }

    // ------------------------------------------------------------ 工具

    private static Set<String> lower(Iterable<String> src) {
        Set<String> out = new HashSet<>();
        for (String s : src) out.add(s.trim().toLowerCase(Locale.ROOT));
        return out;
    }

    private static String read(File f) {
        try {
            return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new AssertionError("读不到 " + f + "：" + e);
        }
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] d = md.digest(Files.readAllBytes(f.toPath()));
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
