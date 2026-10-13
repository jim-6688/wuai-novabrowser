package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 下载结果的解析单测。
 *
 * <p>这一层挡的是一个真实且危险的坑：{@link UserScript#parse} 对没有元数据头的
 * 文本会兜底成「匹配所有地址」，也就是「所有网站都运行」。于是一张
 * HTML 错误页（脚本已下架、地址被重定向到首页）会被安静地装成一个
 * <b>全站脚本</b> —— 用户以为装了个清理器，实际上它在每个网页上跑。
 * 所以进 parse 之前必须先排除「这是网页」。
 */
public class ScriptInstallerTest {

    @Test
    public void 网页会被拒绝() {
        String html = "<!DOCTYPE html>\n<html><head><title>404</title></head></html>";
        ScriptInstaller.Result r = ScriptInstaller.parseDownloaded(html);
        assertFalse(r.ok);
        assertNull(r.pending);
        assertTrue(r.message.contains("网页"));
    }

    @Test
    public void 小写doctype也会被拒绝() {
        ScriptInstaller.Result r = ScriptInstaller.parseDownloaded("<!doctype html><html>...");
        assertFalse(r.ok);
        assertNull(r.pending);
    }

    @Test
    public void 带前导空白的网页也会被拒绝() {
        // trim 之后再判断。前导空行与 BOM 在真实响应里都存在。
        ScriptInstaller.Result r =
            ScriptInstaller.parseDownloaded("\n\n   <html><body>x</body></html>");
        assertFalse(r.ok);
    }

    @Test
    public void 空内容被拒绝() {
        assertFalse(ScriptInstaller.parseDownloaded("").ok);
        assertFalse(ScriptInstaller.parseDownloaded("   \n  ").ok);
        assertFalse(ScriptInstaller.parseDownloaded(null).ok);
    }

    @Test
    public void 正常脚本能解析出来() {
        String src = "// ==UserScript==\n"
            + "// @name         测试脚本\n"
            + "// @namespace    nova.test\n"
            + "// @match        https://example.com/*\n"
            + "// @grant        none\n"
            + "// ==/UserScript==\n"
            + "console.log('hi');\n";
        ScriptInstaller.Result r = ScriptInstaller.parseDownloaded(src);
        assertTrue(r.message, r.ok);
        assertNotNull(r.pending);
        assertEquals("测试脚本", r.pending.meta.name);
        assertFalse(r.headless);
        assertTrue(r.grants.isEmpty());
    }

    @Test
    public void 声明了GM特权会被记下来() {
        // 不拒绝安装（有些脚本只有部分功能用到特权），但必须报出来 ——
        // 用户有权知道「装上了，但那部分不会生效」。
        String src = "// ==UserScript==\n"
            + "// @name 要特权的脚本\n"
            + "// @match https://example.com/*\n"
            + "// @grant GM_xmlhttpRequest\n"
            + "// @grant GM_setValue\n"
            + "// ==/UserScript==\n"
            + "void 0;\n";
        ScriptInstaller.Result r = ScriptInstaller.parseDownloaded(src);
        assertTrue(r.message, r.ok);
        assertEquals(2, r.grants.size());
        assertTrue(r.grants.contains("GM_xmlhttpRequest"));
    }

    @Test
    public void grantNone不算特权() {
        // @grant none 是「我不需要任何特权」的声明，它本身不是一项特权。
        // 当成特权的话，几乎所有按规范写的脚本都会被误报。
        String src = "// ==UserScript==\n"
            + "// @name 干净的脚本\n"
            + "// @match https://example.com/*\n"
            + "// @grant none\n"
            + "// ==/UserScript==\n"
            + "void 0;\n";
        ScriptInstaller.Result r = ScriptInstaller.parseDownloaded(src);
        assertTrue(r.message, r.ok);
        assertTrue(r.grants.isEmpty());
    }

    @Test
    public void 无头脚本被标出来() {
        // 没有 ==UserScript== 就没有 @match，parse 会兜底成「所有网站都运行」。
        // 这不是错误，但用户装之前必须知道。
        ScriptInstaller.Result r = ScriptInstaller.parseDownloaded("console.log('bare');");
        assertTrue(r.message, r.ok);
        assertTrue(r.headless);
        assertNotNull(r.pending);
    }

    @Test
    public void 正文含html字符串的正常脚本不受影响() {
        // 只认「开头」，不认「包含」—— 往页面插元素的脚本正文里当然有 HTML 字符串。
        // 用「包含」判断会把这类正常脚本误伤成网页，那是另一种错。
        String src = "// ==UserScript==\n"
            + "// @name 插元素\n"
            + "// @match https://example.com/*\n"
            + "// @grant none\n"
            + "// ==/UserScript==\n"
            + "document.body.insertAdjacentHTML('beforeend', '<div>hi</div>');\n";
        ScriptInstaller.Result r = ScriptInstaller.parseDownloaded(src);
        assertTrue(r.message, r.ok);
        assertNotNull(r.pending);
    }
}
