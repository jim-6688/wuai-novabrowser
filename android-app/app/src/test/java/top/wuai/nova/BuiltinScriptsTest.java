package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;

/**
 * 内置用户脚本的清单与资产。
 *
 * <p>这些脚本是<b>第三方代码，随包发给每一个用户</b>，而且是浏览器替用户装上的 ——
 * 用户从没做过「我要装它」这个决定。所以这里要钉住的不是「代码逻辑对不对」，
 * 而是三件更要紧的事：
 *
 * <ol>
 *   <li><b>审计过的那一份有没有被悄悄换掉</b>：脚本本体对 sha256，清单里记着值。
 *       改一个字符就会红 —— 这不是麻烦，这正是「内置的是哪一份」唯一的答案。</li>
 *   <li><b>它在本引擎里到底跑不跑得起来</b>：引擎不提供任何 {@code @grant} 特权，
 *       声明了特权的脚本只会静默失败。所以「不许有 @grant」是一条硬门槛，
 *       将来加内置脚本来，这条会先拦住。</li>
 *   <li><b>它会不会真的被注入</b>：只看 {@code @match} 非空不够 ——
 *       模式写错了同样是非空，而结果是一条都不匹配、脚本装了却不跑。</li>
 * </ol>
 */
public class BuiltinScriptsTest {

    /** assets 在源码树里的位置。单测跑在模块目录下，读的是源文件不是打包后的 apk。 */
    private static File asset(String rel) {
        return new File("src/main/assets", rel);
    }

    // ------------------------------------------------------------ 清单形状

    @Test
    public void 每一项的键都非空且互不相同() {
        Set<String> seen = new HashSet<>();
        for (BuiltinScripts.Item it : BuiltinScripts.MANIFEST) {
            assertFalse("key 不能是空的", it.key.trim().isEmpty());
            assertTrue("key 重复了：" + it.key, seen.add(it.key));
        }
    }

    @Test
    public void 每一项的资产路径都在脚本目录下() {
        for (BuiltinScripts.Item it : BuiltinScripts.MANIFEST) {
            assertTrue(it.key + " 的脚本应放在 " + BuiltinScripts.DIR + " 下，实际是 "
                + it.scriptAsset, it.scriptAsset.startsWith(BuiltinScripts.DIR));
            assertTrue(it.key + " 的许可证应放在 " + BuiltinScripts.DIR + " 下，实际是 "
                + it.licenseAsset, it.licenseAsset.startsWith(BuiltinScripts.DIR));
            assertFalse(it.key + " 的来源说明不能为空", it.credit.trim().isEmpty());
        }
    }

    @Test
    public void 哈希字段必须是64位小写十六进制() {
        for (BuiltinScripts.Item it : BuiltinScripts.MANIFEST) {
            assertTrue(it.key + " 的 sha256 形状不对：" + it.sha256,
                it.sha256.matches("[0-9a-f]{64}"));
        }
    }

    @Test
    public void 按key能查回清单项() {
        for (BuiltinScripts.Item it : BuiltinScripts.MANIFEST) {
            assertSame(it, BuiltinScripts.byKey(it.key));
        }
        assertNull(BuiltinScripts.byKey("没有这个键"));
        assertNull(BuiltinScripts.byKey(null));
    }

    @Test
    public void 反查对空输入是安全的() {
        // 面板每画一行都会反查一次，而 store 在某些时序下确实可能是空的。
        // 这里让它抛异常的话，表现是「插件面板打不开」，且看不出跟内置有关。
        assertNull(BuiltinScripts.itemOf(null, null));
        assertNull(BuiltinScripts.itemOf("", null));
        assertNull(BuiltinScripts.itemOf("随便一个 id", null));
        assertTrue(BuiltinScripts.seededIds(null).isEmpty());
    }

    @Test
    public void 存储为空时播种直接返回零() {
        assertEquals(0, BuiltinScripts.seed(null));
    }

    // ------------------------------------------------------------ 资产本身

    @Test
    public void 脚本与许可证文件都真实存在() {
        String cwd = new File(".").getAbsolutePath();
        for (BuiltinScripts.Item it : BuiltinScripts.MANIFEST) {
            assertTrue(it.scriptAsset + " 不存在（当前目录 " + cwd + "）",
                asset(it.scriptAsset).isFile());
            assertTrue(it.licenseAsset + " 不存在（当前目录 " + cwd + "）",
                asset(it.licenseAsset).isFile());
        }
    }

    @Test
    public void 脚本本体与清单记录的哈希一致() throws Exception {
        // 整批测试里最要紧的一条。脚本是第三方代码，随包发给每一个用户；
        // 它在审计之后被人动过一个字符，只有这里能发现。
        //
        // 失败时该做的是「重新审计这份脚本，再把清单里的 sha256 换成新的」，
        // 而不是把这条测试删掉 —— 那等于把「内置的是哪一份」这个问题彻底丢掉。
        for (BuiltinScripts.Item it : BuiltinScripts.MANIFEST) {
            assertEquals(it.key + " 的脚本内容与清单记录不符。"
                    + "换版本请重新审计并更新 BuiltinScripts.MANIFEST 里的 sha256",
                it.sha256, sha256(asset(it.scriptAsset)));
        }
    }

    @Test
    public void 许可证全文不能是空的() throws Exception {
        // LGPLv3 要求随分发提供许可证全文。文件在但内容被清空的话，
        // 打包一样能过、界面一样正常 —— 只有这里看得出来。
        for (BuiltinScripts.Item it : BuiltinScripts.MANIFEST) {
            String text = read(asset(it.licenseAsset));
            assertTrue(it.licenseAsset + " 太短了，不像是一份完整许可证",
                text.length() > 1000);
            assertTrue(it.licenseAsset + " 不像 LGPL 全文",
                text.contains("GNU LESSER GENERAL PUBLIC LICENSE")
                    || text.contains("GNU General Public License"));
        }
    }

    // ------------------------------------------------------------ 能不能跑

    @Test
    public void 每条内置脚本都能被解析出来() {
        for (BuiltinScripts.Item it : BuiltinScripts.MANIFEST) {
            UserScript.Parsed p = UserScript.parse(read(asset(it.scriptAsset)));
            assertTrue(it.key + " 解析失败：" + p.error, p.ok());
            assertFalse(it.key + " 解析出来没有名字", p.meta.name.trim().isEmpty());
        }
    }

    @Test
    public void 内置脚本一律不许声明特权() {
        // 选品的硬门槛，不是风格偏好：引擎不提供任何 @grant 特权
        // （见 UserScript 的类注释），声明了只会静默失败。
        // 而「装了个好评脚本但什么都没发生」比一开始就不内置更伤人 ——
        // 用户会以为浏览器坏了。
        for (BuiltinScripts.Item it : BuiltinScripts.MANIFEST) {
            UserScript.Parsed p = UserScript.parse(read(asset(it.scriptAsset)));
            assertTrue(it.key + " 声明了特权 " + p.meta.grants
                    + "。引擎不提供 GM_* 接口，请换一个 @grant none 的脚本",
                p.meta.grants.isEmpty());
        }
    }

    @Test
    public void 内置脚本必须声明适用范围() {
        // 没有 @match 也没有 @include 的脚本等于「所有网站都跑」，
        // UserScript.parse 会直接拒绝安装。内置的要是撞上这条，
        // 表现是设置里永远写着「未安装」。
        for (BuiltinScripts.Item it : BuiltinScripts.MANIFEST) {
            UserScript.Parsed p = UserScript.parse(read(asset(it.scriptAsset)));
            assertFalse(it.key + " 没有声明 @match 或 @include",
                p.meta.match.isEmpty() && p.meta.include.isEmpty());
        }
    }

    @Test
    public void 内置脚本在普通网页上确实会被注入() {
        // 端到端的一小步。只看 @match 非空是不够的：模式写错（比如漏了 *://）
        // 同样是非空，而结果是一条网址都匹配不上 —— 脚本装着、列表里看得见、
        // 就是不运行，且没有任何报错。
        for (BuiltinScripts.Item it : BuiltinScripts.MANIFEST) {
            UserScript.Parsed p = UserScript.parse(read(asset(it.scriptAsset)));
            UserScript.Installed inst = new UserScript.Installed(
                UserScript.idOf(p.meta, p.body), p.meta, p.body, 0L, it.credit);
            assertTrue(it.key + " 在 https 页面上不会被注入",
                UserScript.appliesTo(inst, "https://example.com/a/b?c=1"));
            assertTrue(it.key + " 在 http 页面上不会被注入",
                UserScript.appliesTo(inst, "http://example.com/"));
        }
    }

    @Test
    public void 内置脚本默认是启用的() {
        // 内置的意义就是「拿来就能用」。默认停用的话，设置里显示「已装 1 个」
        // 但网页上什么都没发生 —— 比「未安装」更让人摸不着头脑。
        for (BuiltinScripts.Item it : BuiltinScripts.MANIFEST) {
            UserScript.Parsed p = UserScript.parse(read(asset(it.scriptAsset)));
            assertTrue(it.key + " 解析出来是停用状态", p.meta.enabledFlag);
        }
    }

    // ------------------------------------------------------------ 工具

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
