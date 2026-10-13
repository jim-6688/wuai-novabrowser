package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.List;

import org.junit.Test;

/**
 * {@link GmShim} 的单元测试。
 *
 * <p>只测 Java 侧生成了什么，不测生成的 JavaScript 跑起来对不对 ——
 * 那需要真的有个 JS 引擎（纯 JVM 单测里没有）。所以这里挡的是
 * <b>「生成的代码本身是坏的」</b>这一类问题：拼串漏了逗号、字符串没转义、
 * 声明顺序影响了输出。剩下「JS 语义对不对」由构建时的手工验证兜底
 * （见 docs/gm-api.md 末节）。
 *
 * <p>纯 JVM，不碰 Android 框架 —— 与工程里其余可测类同一策略。
 */
public class GmShimTest {

    private static UserScript.Meta meta(String... grants) {
        UserScript.Meta m = new UserScript.Meta();
        m.name = "x";
        m.match.add("https://example.com/*");
        for (String g : grants) m.grants.add(g);
        return m;
    }

    private static String inject(UserScript.Meta m) {
        return UserScript.buildInject(
            new UserScript.Installed("s", m, "// BODY", 0, "测试"), null);
    }

    // ------------------------------------------------------------ 判定

    @Test
    public void 已经提供的接口认得出来() {
        assertTrue(GmShim.isSupported("GM_addStyle"));
        assertTrue(GmShim.isSupported("unsafeWindow"));
        // 元数据是手写的，大小写和首尾空白都很随意
        assertTrue(GmShim.isSupported("  gm_addstyle  "));
        assertTrue(GmShim.isSupported("GM_LOG"));
        // GM 是命名空间对象，篡改猴 4.11 起的写法
        assertTrue(GmShim.isSupported("GM"));
    }

    @Test
    public void 没提供的接口一概不认() {
        assertFalse(GmShim.isSupported("GM_setValue"));
        assertFalse(GmShim.isSupported("GM_xmlhttpRequest"));
        assertFalse(GmShim.isSupported("GM_registerMenuCommand"));
        // none 不是接口，是「我不需要任何接口」的声明
        assertFalse(GmShim.isSupported("none"));
        assertFalse(GmShim.isSupported(null));
        assertFalse(GmShim.isSupported(""));
    }

    @Test
    public void unsupported只挑真的不支持的() {
        List<String> un = GmShim.unsupported(
            Arrays.asList("GM_addStyle", "GM_setValue", "none", "GM_xmlhttpRequest"));
        assertEquals(2, un.size());
        assertTrue(un.contains("GM_setValue"));
        assertTrue(un.contains("GM_xmlhttpRequest"));
        assertFalse("已提供的接口不该出现在这里", un.contains("GM_addStyle"));
    }

    @Test
    public void unsupported会去重并忽略空白项() {
        // 同一个接口声明两遍在真实脚本里存在。不去重的话提示会写成
        // 「声明了 2 项未支持的权限」，而其实只有 1 项 ——
        // 数字对不上的警告会让人开始怀疑整条警告。
        List<String> un = GmShim.unsupported(
            Arrays.asList("GM_x", "gm_x", "  ", null, "GM_x"));
        assertEquals(1, un.size());
        assertEquals("GM_x", un.get(0));
    }

    @Test
    public void 元数据的判定与垫片用的是同一处逻辑() {
        UserScript.Meta m = meta("GM_addStyle", "GM_setValue");
        assertEquals(1, m.unsupportedGrants().size());
        assertEquals("GM_setValue", m.unsupportedGrants().get(0));
        assertTrue(m.needsPrivilegeWarning());
        assertTrue(m.summary().contains("1 项未支持的权限"));
    }

    @Test
    public void 只声明已支持的接口就不该再报警() {
        // 这是本次改动带来的行为变化：以前「凡有 @grant 就警告」，
        // 现在声明 GM_addStyle 这种已经能用的接口不该被说成缺陷。
        UserScript.Meta m = meta("GM_addStyle", "GM_info");
        assertFalse(m.needsPrivilegeWarning());
        assertTrue(m.unsupportedGrants().isEmpty());
    }

    @Test
    public void 解析时会按支持情况分别计数() {
        UserScript.Parsed p = UserScript.parse(
            "// ==UserScript==\n"
            + "// @name  mixed\n"
            + "// @match https://a.com/*\n"
            + "// @grant GM_addStyle\n"
            + "// @grant GM_xmlhttpRequest\n"
            + "// ==/UserScript==\n"
            + "void 0;\n");
        assertTrue(p.error, p.ok());
        assertTrue(p.meta.needsPrivilegeWarning());
        // 只有 GM_xmlhttpRequest 是真的缺，数字必须是 1 不是 2
        assertTrue(p.meta.description, p.meta.description.contains("已忽略 1 项"));
    }

    @Test
    public void 声明了已支持接口的脚本不再附带忽略说明() {
        UserScript.Parsed p = UserScript.parse(
            "// ==UserScript==\n"
            + "// @name  ok\n"
            + "// @match https://a.com/*\n"
            + "// @grant GM_addStyle\n"
            + "// ==/UserScript==\n"
            + "void 0;\n");
        assertTrue(p.error, p.ok());
        assertFalse(p.meta.needsPrivilegeWarning());
        assertFalse("说明里不该出现「已忽略」", p.meta.description.contains("忽略"));
    }

    // ------------------------------------------------------------ 注入参数

    @Test
    public void 只声明什么就给什么() {
        String code = inject(meta("GM_addStyle"));
        assertTrue(code.contains("GM_addStyle"));
        assertFalse("没声明 unsafeWindow 就不该白送", code.contains("unsafeWindow"));
        assertFalse(code.contains("GM_log"));
        assertFalse(code.contains("GM_info"));
        assertFalse(code.contains("GM_addElement"));
    }

    @Test
    public void 声明未支持的接口不会凭空产生参数() {
        // 声明 GM_setValue 只会得到一条安装时的警告，不会有对应的形参 ——
        // 伪造成「有」比没有更糟：脚本会调到一个不存在的函数然后崩掉。
        String code = inject(meta("GM_setValue", "GM_xmlhttpRequest"));
        assertFalse(code.contains("__g"));
        assertFalse(code.contains("GM_setValue"));
        assertTrue(code.contains("(function(){"));
    }

    @Test
    public void unsafeWindow映射到页面的window() {
        String code = inject(meta("unsafeWindow"));
        assertTrue(code.contains("(function(unsafeWindow){"));
        assertTrue(code.contains("})(window);"));
        // 只有 unsafeWindow 时用不到垫片对象，不该白带一段定义
        assertFalse(code.contains("__g"));
    }

    @Test
    public void GM命名空间里只放已经支持的几项() {
        String code = inject(meta("GM"));
        assertTrue(code.contains("(function(GM){"));
        assertTrue(code.contains("addStyle:__g.addStyle"));
        assertTrue(code.contains("addElement:__g.addElement"));
        assertTrue(code.contains("log:__g.log"));
        assertTrue(code.contains("info:"));
        assertFalse("GM 对象里不该出现没实现的接口", code.contains("setValue"));
    }

    @Test
    public void 多个接口按固定顺序排列() {
        // 顺序写死，不跟着脚本的声明顺序走 —— 同一个脚本无论 @grant 行怎么排，
        // 生成的代码都该一模一样。
        String a = inject(meta("GM_addStyle", "GM_log", "unsafeWindow"));
        String b = inject(meta("unsafeWindow", "GM_log", "GM_addStyle"));
        assertEquals(a, b);
        assertTrue(a.indexOf("GM_addStyle") < a.indexOf("GM_log"));
        assertTrue(a.indexOf("GM_log") < a.indexOf("unsafeWindow"));
    }

    @Test
    public void 没声明受支持接口时输出与旧版逐字节一致() {
        // 零回归的硬约束：改动之前一项接口都不发，所以「没声明受支持接口」
        // 的脚本拿到的代码必须和以前完全相同 —— 内置那条 remove-web-limits
        // 就是这一档（它写的是 @grant none）。
        String code = inject(meta());
        assertEquals(
            "(function(){\ntry{\n// BODY\n}catch(e){console.error('[Nova插件]',e);}\n})();\n",
            code);
    }

    @Test
    public void 用到垫片时必须定义在外层作用域() {
        // 实参 __g.addStyle 是在函数体之外求值的，__g 必须先存在于外层。
        // 定义在内层会抛 ReferenceError，而正文被 try 包着，报错看不见 ——
        // 表现只是「脚本装上了一点动静都没有」。
        String code = inject(meta("GM_addStyle"));
        int shimDecl = code.indexOf("var __g=(function(){");
        int innerFn = code.indexOf("(function(GM_addStyle){");
        int call = code.indexOf("})(__g.addStyle)");
        assertTrue("垫片要先于内层函数定义", shimDecl >= 0 && shimDecl < innerFn);
        assertTrue("实参要在内层函数之后传", innerFn < call);
        // 外层那一圈要闭合
        assertTrue(code.endsWith("})();\n"));
    }

    // ------------------------------------------------------------ 转义

    @Test
    public void 脚本名里的单引号不会撕坏注入的代码() {
        // 脚本名是用户可控的（来自下载到的 .user.js）。不转义的话，
        // 一个叫 Bob's reader 的脚本会让生成的 JS 变成语法错误，
        // 而语法错误会让整次注入失败 —— 这一页上所有脚本一起静默死掉。
        UserScript.Meta m = meta("GM_info");
        m.name = "Bob's reader";
        String info = GmShim.infoLiteral(m);
        assertTrue(info, info.contains("name:'Bob\\'s reader'"));
        assertFalse("不该出现未转义的引号", info.contains("'Bob's"));
    }

    @Test
    public void 反斜杠与换行都要转义() {
        assertEquals("'a\\nb'", GmShim.jsStr("a\nb"));
        assertEquals("'a\\rb'", GmShim.jsStr("a\rb"));
        assertEquals("'a\\tb'", GmShim.jsStr("a\tb"));
        assertEquals("'a\\\\b'", GmShim.jsStr("a\\b"));
        assertEquals("''", GmShim.jsStr(null));
    }

    @Test
    public void 行分隔符必须转义成转义序列() {
        // U+2028 / U+2029 在 JSON 里合法，在 ES2019 之前的 JavaScript 字符串
        // 字面量里非法。minSdk 24（Android 7 时期的内核）远早于 ES2019 ——
        // 脚本描述里混进这两个字符就会以同样的方式炸掉整次注入。
        assertEquals("'a\\u2028b'", GmShim.jsStr("a\u2028b"));
        assertEquals("'a\\u2029b'", GmShim.jsStr("a\u2029b"));
    }

    @Test
    public void match模式里的引号同样被转义() {
        UserScript.Meta m = meta("GM_info");
        m.match.clear();
        m.match.add("https://a.com/');alert(1);//");
        String info = GmShim.infoLiteral(m);
        // 断言「转义形式在」，而不是「原文不在」—— 转义后的串里当然还含
        // 引号加右括号那几个字符，只是前面多了个反斜杠，字符串不会被撕开。
        assertTrue(info, info.contains("\\');alert(1)"));
        // 引用处整体必须仍是单个闭合的字符串字面量
        assertTrue(info, info.contains("matches:['https://a.com/\\');alert(1);//']"));
    }
}
