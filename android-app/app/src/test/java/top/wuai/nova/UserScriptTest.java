package top.wuai.nova;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * 用户脚本的测试。匹配逻辑的错法很隐蔽：
 * 把 {@code https://*.x.com/*} 匹配成 {@code https://x.com/*} 会漏掉全部子域；
 * @exclude 的优先级弄反会让白名单反过来当黑名单用。
 */
public class UserScriptTest {

    private static UserScript.Installed inst(String name, String runAt,
                                             List<String> match,
                                             List<String> exclude) {
        UserScript.Meta m = new UserScript.Meta();
        m.name = name;
        m.runAt = runAt;
        if (match != null) m.match.addAll(match);
        if (exclude != null) m.exclude.addAll(exclude);
        return new UserScript.Installed(name, m, "// body", 0, "测试");
    }

    // ------------------------------------------------------------ 解析

    @Test
    public void 解析标准元数据块() {
        String text = "// ==UserScript==\n"
            + "// @name         标题栏加时间戳\n"
            + "// @namespace    demo\n"
            + "// @version      1.2\n"
            + "// @description  给标题栏加个时间\n"
            + "// @match        https://*.zhihu.com/*\n"
            + "// @exclude      https://zhihu.com/question/*\n"
            + "// @grant        none\n"
            + "// ==/UserScript==\n"
            + "console.log('hi');\n";
        UserScript.Parsed p = UserScript.parse(text);
        assertTrue(p.error, p.ok());
        assertEquals("标题栏加时间戳", p.meta.name);
        assertEquals("demo", p.meta.namespace);
        assertEquals("1.2", p.meta.version);
        assertEquals(1, p.meta.match.size());
        assertEquals("https://*.zhihu.com/*", p.meta.match.get(0));
        assertEquals(1, p.meta.exclude.size());
        // 正文不能把元数据块带进去
        assertFalse(p.body.contains("==UserScript=="));
        assertTrue(p.body.contains("console.log"));
    }

    @Test
    public void 无头脚本也能装() {
        // 很多用户脚本是没有头的裸 JS
        UserScript.Parsed p = UserScript.parse("// 一个裸脚本\nalert(1);");
        assertTrue(p.error, p.ok());
        assertTrue(p.body.contains("alert(1)"));
        assertEquals(1, p.meta.match.size());
        assertEquals("*://*/*", p.meta.match.get(0));
    }

    @Test
    public void 没有任何匹配声明的脚本要拒绝() {
        // 装上会变成「所有网站都运行」，而用户几乎不会真的想要这个
        UserScript.Parsed p = UserScript.parse(
            "// ==UserScript==\n// @name  x\n// ==/UserScript==\nalert(1);");
        assertFalse(p.ok());
        assertTrue(p.error.contains("@match"));
    }

    @Test
    public void 声明特权的要标出来但不拒绝() {
        UserScript.Parsed p = UserScript.parse(
            "// ==UserScript==\n"
            + "// @name  x\n// @match *://*/*\n"
            + "// @grant  GM_xmlhttpRequest\n// ==/UserScript==\n");
        assertTrue(p.error, p.ok());
        assertTrue(p.meta.needsPrivilegeWarning());
        assertEquals(1, p.meta.grants.size());
        assertTrue(p.meta.description.contains("忽略"));
    }

    @Test
    public void grant_none_只是声明不用特权() {
        // @grant none 是用户脚本里最常见的写法，意思是「我不需要任何特权」。
        // 早先无条件把它收进 grants，于是几乎所有按规范写的脚本都被标成
        // 「声明了 1 项未支持的权限」—— 警告本身是真的（我们确实没有 GM_*），
        // 但它指向了一个不存在的问题：脚本压根什么都没请求过。
        // 而误报的代价是用户学会忽略这个警告，真有特权的脚本也就一起被忽略了。
        UserScript.Parsed p = UserScript.parse(
            "// ==UserScript==\n"
            + "// @name  x\n// @match *://*/*\n"
            + "// @grant none\n// ==/UserScript==\n");
        assertTrue(p.error, p.ok());
        assertTrue("@grant none 不该被当成一项特权", p.meta.grants.isEmpty());
        assertFalse(p.meta.needsPrivilegeWarning());
        assertFalse("说明里不该出现「已忽略」", p.meta.description.contains("忽略"));
    }

    @Test
    public void grant_的大小写和空白都要认() {
        // 元数据是用户手写的，大小写与尾随空格都很常见。
        UserScript.Parsed p = UserScript.parse(
            "// ==UserScript==\n"
            + "// @name  z\n// @match *://*/*\n"
            + "// @grant   NONE  \n// ==/UserScript==\n");
        assertTrue(p.error, p.ok());
        assertTrue("NONE 与 none 等价", p.meta.grants.isEmpty());
    }

    @Test
    public void grant_none_与真特权混写时只算后者() {
        // 一个脚本里同时写 none 和具体特权是合法的（具体的那条胜出）。
        // 这时不能因为见过 none 就把后面的真特权一起丢掉 —— 那等于把需要警告的
        // 脚本放过去，而它恰恰是会在页面上静默失败的那种。
        UserScript.Parsed p = UserScript.parse(
            "// ==UserScript==\n"
            + "// @name  y\n// @match *://*/*\n"
            + "// @grant none\n// @grant GM_setValue\n// ==/UserScript==\n");
        assertTrue(p.error, p.ok());
        assertEquals(1, p.meta.grants.size());
        assertEquals("GM_setValue", p.meta.grants.get(0));
        assertTrue(p.meta.needsPrivilegeWarning());
    }

    @Test
    public void 空文件要报错而不是崩() {
        assertFalse(UserScript.parse(null).ok());
        assertFalse(UserScript.parse("").ok());
        assertFalse(UserScript.parse("   \n  ").ok());
    }

    @Test
    public void 元数据块用不同注释符也认() {
        String text = "/* ==UserScript==\n"
            + " * @name 块注释头\n"
            + " * @match https://a.com/*\n"
            + " * ==/UserScript== */\n"
            + "alert(1);\n";
        UserScript.Parsed p = UserScript.parse(text);
        assertTrue(p.error, p.ok());
        assertEquals("块注释头", p.meta.name);
    }

    // ------------------------------------------------------------ 匹配

    @Test
    public void match通配() {
        UserScript.Installed s = inst("s", null,
            java.util.Arrays.asList("https://*.zhihu.com/*"), null);

        assertTrue(UserScript.appliesTo(s, "https://www.zhihu.com/question/1"));
        assertTrue(UserScript.appliesTo(s, "https://a.b.zhihu.com/x"));
        // 「https://*.zhihu.com/*」里的 * 必须至少匹配一段，所以裸域不命中 ——
        // 这与 Tampermonkey 一致。想连裸域一起覆盖要写两条 @match。
        assertFalse(UserScript.appliesTo(s, "https://zhihu.com/"));
        assertFalse(UserScript.appliesTo(s, "https://example.com/"));
        assertFalse(UserScript.appliesTo(s, "http://www.zhihu.com/"));
    }

    @Test
    public void match里裸域名能覆盖子域吗() {
        // 「https://zhihu.com/*」按 @match 语义是只匹配该主机，
        // 子域要显式写。这是标准语义，不是我们的简化。
        UserScript.Installed s = inst("s", null,
            java.util.Arrays.asList("https://zhihu.com/*"), null);
        assertTrue(UserScript.appliesTo(s, "https://zhihu.com/a"));
        assertFalse(UserScript.appliesTo(s, "https://www.zhihu.com/a"));
    }

    @Test
    public void match里的点必须当字面量() {
        // 这条是通配实现最容易踩的坑：把 . 也通配掉之后
        // https://a.com/ 会匹配 https://aXcom/
        UserScript.Installed s = inst("s", null,
            java.util.Arrays.asList("https://a.com/*"), null);
        assertTrue(UserScript.appliesTo(s, "https://a.com/page"));
        assertFalse(UserScript.appliesTo(s, "https://aXcom/page"));
        assertFalse(UserScript.appliesTo(s, "https://b.com/page"));
    }

    @Test
    public void 星号能跨斜杠() {
        UserScript.Installed s = inst("s", null,
            java.util.Arrays.asList("https://a.com/*"), null);
        assertTrue(UserScript.appliesTo(s, "https://a.com/x/y/z?q=1"));
    }

    @Test
    public void exclude优先于match() {
        // 顺序反了的话，白名单会反过来当黑名单用
        UserScript.Installed s = inst("s", null,
            java.util.Arrays.asList("https://a.com/*"),
            java.util.Arrays.asList("https://a.com/question/*"));
        assertTrue(UserScript.appliesTo(s, "https://a.com/article/1"));
        assertFalse(UserScript.appliesTo(s, "https://a.com/question/1"));
    }

    @Test
    public void 停用的脚本不跑() {
        UserScript.Installed s = inst("s", null,
            java.util.Arrays.asList("https://a.com/*"), null);
        assertTrue(UserScript.appliesTo(s, "https://a.com/"));
        s.enabled = false;
        assertFalse(UserScript.appliesTo(s, "https://a.com/"));
    }

    @Test
    public void 非http页面不注入() {
        UserScript.Installed s = inst("s", null,
            java.util.Arrays.asList("*://*/*"), null);
        assertFalse(UserScript.appliesTo(s, "about:blank"));
        assertFalse(UserScript.appliesTo(s, "javascript:void(0)"));
        assertFalse(UserScript.appliesTo(s, "data:text/html,<h1>x"));
        assertFalse(UserScript.appliesTo(s, null));
    }

    @Test
    public void include当正则() {
        UserScript.Installed s = new UserScript.Installed("s",
            new UserScript.Meta(), "// b", 0, "测试");
        s.meta.include.add(".*\\.example\\.com/.*");
        assertTrue(UserScript.appliesTo(s, "https://a.example.com/x"));
        assertFalse(UserScript.appliesTo(s, "https://example.org/x"));
    }

    @Test
    public void 写坏的正则不能让浏览器崩() {
        UserScript.Installed s = new UserScript.Installed("s",
            new UserScript.Meta(), "// b", 0, "测试");
        s.meta.include.add("[unclosed");
        // 不抛异常，且不匹配
        assertFalse(UserScript.appliesTo(s, "https://a.com/"));
    }

    @Test
    public void 非法match模式不匹配() {
        assertFalse(UserScript.matchPattern("", "https://a.com/"));
        assertFalse(UserScript.matchPattern(null, "https://a.com/"));
    }

    // ------------------------------------------------------------ 注入

    @Test
    public void 注入代码必须包在try里() {
        // 用户脚本里的语法错误绝不能让整个页面崩掉
        UserScript.Installed s = new UserScript.Installed("s",
            new UserScript.Meta(), "syntax ((( error", 0, "测试");
        String code = UserScript.buildInject(s, null);
        assertTrue(code.contains("try{"));
        assertTrue(code.contains("catch"));
    }

    @Test
    public void 汇总注入只含匹配的脚本() {
        UserScript.Installed a = inst("a", null,
            java.util.Arrays.asList("https://x.com/*"), null);
        a.body = "// AAA";
        UserScript.Installed b = inst("b", null,
            java.util.Arrays.asList("https://y.com/*"), null);
        b.body = "// BBB";

        String all = UserScript.buildInjectAll(
            java.util.Arrays.asList(a, b), "https://x.com/", null);
        assertTrue(all.contains("AAA"));
        assertFalse(all.contains("BBB"));

        assertEquals("", UserScript.buildInjectAll(
            java.util.Arrays.asList(a, b), "https://z.com/", null));
    }

    @Test
    public void 注入顺序稳定() {
        // 同一组脚本每次注入顺序一致，否则「先改 A 再改 B」这种脚本会时灵时不灵
        UserScript.Installed a = inst("b_id", null,
            java.util.Arrays.asList("https://x.com/*"), null);
        a.body = "// SECOND";
        UserScript.Installed b = inst("a_id", null,
            java.util.Arrays.asList("https://x.com/*"), null);
        b.body = "// FIRST";

        String s1 = UserScript.buildInjectAll(java.util.Arrays.asList(a, b),
            "https://x.com/", null);
        String s2 = UserScript.buildInjectAll(java.util.Arrays.asList(b, a),
            "https://x.com/", null);
        assertEquals(s1, s2);
        assertTrue(s1.indexOf("FIRST") < s1.indexOf("SECOND"));
    }

    @Test
    public void require依赖要放进注入() {
        UserScript.Installed s = inst("s", null,
            java.util.Arrays.asList("https://x.com/*"), null);
        String code = UserScript.buildInject(s, "var lib = {};");
        assertTrue(code.contains("var lib = {};"));
        assertTrue(code.indexOf("var lib") < code.indexOf("// body"));
    }

    // ------------------------------------------------------------ ID

    @Test
    public void id要稳定() {
        UserScript.Meta m = new UserScript.Meta();
        m.namespace = "demo";
        m.name = "标题栏";
        String a = UserScript.idOf(m, "body1");
        String b = UserScript.idOf(m, "body2");
        // 同一个脚本换了内容也要同一个 id —— 否则每次更新都变成「装了一个新的」
        assertEquals(a, b);
    }

    @Test
    public void 没有namespace时用内容摘要() {
        UserScript.Meta m = new UserScript.Meta();
        m.name = "";
        String id = UserScript.idOf(m, "hello");
        assertNotNull(id);
        assertTrue(id.startsWith("script_"));
        assertEquals(id, UserScript.idOf(m, "hello"));
        assertFalse(id.equals(UserScript.idOf(m, "world")));
    }

    @Test
    public void id里不能有空格() {
        UserScript.Meta m = new UserScript.Meta();
        m.namespace = "my ns";
        m.name = "a name";
        String id = UserScript.idOf(m, "x");
        assertFalse(id.contains(" "));
    }

    // ------------------------------------------------------------ 元数据文本形态

    @Test
    public void 元数据能原样往返() {
        UserScript.Meta m = new UserScript.Meta();
        m.name = "测试脚本";
        m.namespace = "demo";
        m.version = "2.1";
        m.description = "带=号的说明";
        m.runAt = "document-start";
        m.match.add("https://a.com/*");
        m.include.add("b");
        m.exclude.add("https://a.com/x/*");
        m.require.add("https://lib.js");
        m.grants.add("GM_x");

        UserScript.Meta back = NovaStore.metaFrom(NovaStore.metaTo(m));
        assertEquals("测试脚本", back.name);
        assertEquals("demo", back.namespace);
        assertEquals("2.1", back.version);
        // 值里含 = 号时必须按第一个 = 切，否则会被截断
        assertEquals("带=号的说明", back.description);
        assertEquals("document-start", back.runAt);
        assertEquals(1, back.match.size());
        assertEquals(1, back.include.size());
        assertEquals(1, back.exclude.size());
        assertEquals(1, back.require.size());
        assertEquals(1, back.grants.size());
    }

    @Test
    public void 启停位能往返() {
        UserScript.Meta m = new UserScript.Meta();
        m.name = "x";
        m.enabledFlag = false;
        UserScript.Meta back = NovaStore.metaFrom(NovaStore.metaTo(m));
        assertFalse(back.enabledFlag);

        m.enabledFlag = true;
        assertTrue(NovaStore.metaFrom(NovaStore.metaTo(m)).enabledFlag);
    }

    @Test
    public void 装好之后enabled取自元数据() {
        UserScript.Meta m = new UserScript.Meta();
        m.name = "x";
        m.enabledFlag = false;
        UserScript.Installed s = new UserScript.Installed("x", m, "// b", 0, "测试");
        assertFalse("启停状态只有一个来源，元数据优先", s.enabled);
    }

    @Test
    public void 原定documentStart要说明实际行为() {
        UserScript.Meta m = new UserScript.Meta();
        m.name = "x";
        m.match.add("*://*/*");
        m.runAt = "document-start";
        UserScript.Installed s = new UserScript.Installed("x", m, "// b", 0, "测试");
        // WebView 只给 onPageStarted，那时文档已建好，做不到真正的 start
        assertTrue(s.meta.summary().contains("文档结束"));
    }
}