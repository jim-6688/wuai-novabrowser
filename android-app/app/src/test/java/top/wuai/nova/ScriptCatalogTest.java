package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.HashSet;
import java.util.Set;

/**
 * 可选脚本库清单的单测。
 *
 * <p>这里验的不是「有没有内容」，而是「清单本身会不会把用户带进坑里」。
 * 最要紧的一条是下面的空格编码：{@code URLEncoder} 会把空格编成 {@code +}，
 * 而 {@code +} 在 URL 路径里是<b>字面加号</b>，于是中文脚本名一含空格，
 * 拼出来的地址就指向一个不存在的文件，表现为 404 且看不出原因。
 */
public class ScriptCatalogTest {

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
        }
    }

    @Test
    public void 直链指向GreasyFork的更新地址() {
        // 用 update.greasyfork.org 而不是脚本页面：前者直接返回 .user.js 正文，
        // 后者是一张 HTML 页面，得再抓一次才拿得到源码。
        ScriptCatalog.Item it = ScriptCatalog.byKey("dom-cleaner");
        String url = ScriptCatalog.installUrl(it);
        assertTrue(url.startsWith("https://update.greasyfork.org/scripts/"));
        assertTrue(url.contains("/" + it.scriptId + "/"));
        assertTrue(url.endsWith(".user.js"));
    }

    @Test
    public void 空格编成百分号而不是加号() {
        assertEquals("a%20b", ScriptCatalog.pathEncode("a b"));
        assertFalse(ScriptCatalog.pathEncode("a b").contains("+"));
    }

    @Test
    public void 中文被逐字节编码() {
        // 「通用 DOM 清理器」。中文按 UTF-8 逐字节编，ASCII 与空格保留规则不变。
        String e = ScriptCatalog.pathEncode("通用 DOM 清理器");
        assertTrue(e.startsWith("%E9%80%9A%E7%94%A8%20DOM%20"));
        assertTrue(e.endsWith("%E6%B8%85%E7%90%86%E5%99%A8"));
        assertFalse(e.contains("+"));
    }

    @Test
    public void 保留字符不被编码() {
        // RFC 3986 的非保留字符原样保留，编了也能用但地址会变得难读
        assertEquals("-._~Az09", ScriptCatalog.pathEncode("-._~Az09"));
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
        assertNull(ScriptCatalog.fromOrigin(""));
        assertNull(ScriptCatalog.fromOrigin(null));
    }

    @Test
    public void 按key查不到返回空() {
        assertNull(ScriptCatalog.byKey("不存在的key"));
        assertNull(ScriptCatalog.byKey(null));
        assertNotNull(ScriptCatalog.byKey("dom-cleaner"));
    }

    @Test
    public void 每个分类都有条目() {
        // 分类是面板上的一级结构。空分类会在界面上留下一个没有内容的标题。
        for (ScriptCatalog.Category c : ScriptCatalog.Category.values()) {
            assertFalse("分类「" + c.label + "」下没有条目",
                ScriptCatalog.of(c).isEmpty());
        }
    }

    @Test
    public void 至少有一条已确认的脚本() {
        // 「已确认」是这份清单的价值所在。如果一条都没有，
        // 整份清单对用户来说全是「未确认」，等于没提供任何信息 ——
        // 那还不如不做这个标记。
        boolean any = false;
        for (ScriptCatalog.Item it : ScriptCatalog.ALL) {
            if (it.verified) any = true;
        }
        assertTrue(any);
    }

    @Test
    public void 已确认与未确认都在清单里() {
        // 两个状态都要有：只有已确认说明清单太保守，只有未确认说明没人核过任何一条。
        // 更重要的是界面上这两种徽章都得能渲染出来。
        boolean confirmed = false, unchecked = false;
        for (ScriptCatalog.Item it : ScriptCatalog.ALL) {
            if (it.verified) confirmed = true; else unchecked = true;
        }
        assertTrue("没有已确认的条目", confirmed);
        assertTrue("没有未确认的条目", unchecked);
    }
}
