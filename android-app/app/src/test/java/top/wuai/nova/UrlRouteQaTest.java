package top.wuai.nova;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * {@link MainActivity#routeUrl(String)} 的边界与错误路径（QA 独立补的用例）。
 *
 * <p>工程师写的那几条覆盖了「主路径回得对不对」，这里补的是容易悄悄坏掉的
 * 边角：大小写、前后空白、以及几种<b>判错就会出事</b>的协议 ——
 * {@code intent:} 判成 WEB 会让第三方唤起失效；{@code javascript:} /
 * {@code data:} 判成 WEB 会变成一个安全问题，所以这里把它们的去向钉住。
 */
public class UrlRouteQaTest {

    private static MainActivity.UrlRoute r(String url) {
        return MainActivity.routeUrl(url);
    }

    private static final MainActivity.UrlRoute WEB = MainActivity.UrlRoute.WEB;
    private static final MainActivity.UrlRoute COMMAND = MainActivity.UrlRoute.COMMAND;
    private static final MainActivity.UrlRoute EXTERNAL = MainActivity.UrlRoute.EXTERNAL;

    // ---------------------------------------------------- 大小写

    @Test
    public void 协议大小写不敏感() {
        // Android 的 Uri.getScheme() 保留原样大小写，页面里怎么写都有可能
        assertEquals(WEB, r("FILE:///android_asset/newtab.html?theme=dark"));
        assertEquals(WEB, r("File:///android_asset/newtab.html"));
        assertEquals(WEB, r("About:Blank"));
        assertEquals(WEB, r("ABOUT:blank"));
        assertEquals(WEB, r("HTTP://example.com/"));
        assertEquals(WEB, r("HTTPS://example.com/"));
        assertEquals(COMMAND, r("Nova://shortcut/add?label=x"));
        assertEquals(COMMAND, r("NOVA://SHORTCUT/REMOVE?url=y"));
        assertEquals(EXTERNAL, r("TEL:10086"));
        assertEquals(EXTERNAL, r("MailTo:a@b.com"));
    }

    // ---------------------------------------------------- 前后空白

    @Test
    public void 前后空白不影响判定() {
        // 页面里拼 URL 时留了空格是常事（尤其模板字符串换行缩进），
        // 不 trim 的话 " file:///..." 的 scheme 会解析成 " file" 而被送走
        assertEquals(WEB, r("  file:///android_asset/newtab.html  "));
        assertEquals(WEB, r("\thttps://example.com/\n"));
        assertEquals(COMMAND, r("  nova://shortcut/add?label=x&url=y  "));
        assertEquals(EXTERNAL, r(" tel:10086 "));
        // 全是空白等同空串
        assertEquals(WEB, r("   "));
    }

    // ---------------------------------------------------- 深链与安全

    @Test
    public void intent深链仍交回系统() {
        // 这是第三方 app 唤起的标准形式。判成 WEB 的话 WebView 会试着
        // 自己去加载一个它根本不懂的协议，唤起直接失效。
        assertEquals(EXTERNAL, r("intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;end"));
        assertEquals(EXTERNAL, r("intent://x#Intent;scheme=y;end"));
    }

    @Test
    public void javascript与data不许留在WebView里() {
        // 这两个判成 WEB 就成了安全问题：javascript: 会被当成脚本执行，
        // data: 能造出一个和源站同源的文档。交回系统等于拦下来 ——
        // 系统里没有任何组件认这两种协议，startActivity 会抛异常并被吞掉，
        // 页面上的 javascript: 链接就只是「点了没反应」，这正是我们要的。
        assertEquals(EXTERNAL, r("javascript:alert(1)"));
        assertEquals(EXTERNAL, r("JavaScript:void(0)"));
        assertEquals(EXTERNAL, r("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="));
        assertEquals(EXTERNAL, r("data:text/html,<script>alert(1)</script>"));
    }

    @Test
    public void 其它未知协议交回系统() {
        // 宁可交给系统去撞，也不要在一个自己不了解的协议上假装能渲染
        assertEquals(EXTERNAL, r("weixin://dl/business/?t=xx"));
        assertEquals(EXTERNAL, r("alipays://platformapi/startapp"));
        assertEquals(EXTERNAL, r("mqqapi://forward"));
        assertEquals(EXTERNAL, r("geo:39.9,116.3"));
        assertEquals(EXTERNAL, r("sms:10086"));
    }

    // ---------------------------------------------------- 内置页面那些档

    @Test
    public void 新标签页三档都留在本机() {
        // 「常用/最近」「空白页」「首页」三档里，前两档是 file: 与 about:
        assertEquals(WEB, r("file:///android_asset/newtab.html?theme=light&data="));
        assertEquals(WEB, r("about:blank"));
        // 第三档本来就是 https， regressions 也要守住
        assertEquals(WEB, r("https://nova.52ta.top/"));
    }

    // ---------------------------------------------------- 畸形输入

    @Test
    public void 畸形输入不崩且不去外面() {
        assertEquals(WEB, r(null));
        assertEquals(WEB, r(""));
        assertEquals(WEB, r("newtab.html?theme=dark"));   // 没有协议头
        assertEquals(WEB, r("/android_asset/newtab.html"));
        assertEquals(WEB, r(":leading-colon"));           // 冒号在第一位，没有协议名
        // 协议名里混了空格 → 解不出有效协议，同样不往外送
        assertEquals(EXTERNAL, r("weixin ://x"));
    }

    @Test
    public void 删除快捷方式那条命令没被修坏() {
        // 内置新标签页点 × 走的是 nova://shortcut/remove —— 修 file: 的时候
        // 最容易顺手把 nova: 一起并进 WEB，那样点 × 就变成一个死键
        assertEquals(COMMAND, r("nova://shortcut/remove?url=https%3A%2F%2Fexample.com%2F"));
        assertEquals(COMMAND, r("nova://shortcut/add?label=%E7%A4%BA%E4%BE%8B&url=https%3A%2F%2Fa.com%2F"));
    }
}
