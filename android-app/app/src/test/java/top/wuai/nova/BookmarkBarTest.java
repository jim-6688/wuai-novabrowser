package top.wuai.nova;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * BookmarkBar 是纯粹的逻辑类（只碰 String 与 boolean），不依赖 Android 框架，
 * 所以直接在本地 JVM 里验，不需要 Robolectric。
 *
 * <p>这里不单独测主机名解析：BookmarkBar 借的是 {@link NewTab#hostOf}，那一份
 * 由 NewTabTest 覆盖着（还带着「about:blank 不能被砍成 about」那个修过的 bug 的用例）。
 * 在这儿再测一遍等于把同一份实现验两次，而真正会漏的是「label 有没有按预期降级」。
 */
public class BookmarkBarTest {

    @Test
    public void 展开的三个条件() {
        assertTrue(BookmarkBar.expanded(true, false, true));
        assertFalse("用户没点过唤出键", BookmarkBar.expanded(false, false, true));
        assertFalse("新标签页上不摆出来", BookmarkBar.expanded(true, true, true));
        assertFalse("设置关掉了", BookmarkBar.expanded(true, false, false));
    }

    @Test
    public void 设置关掉时展开态也不留() {
        // 「先展开、再关设置」是最容易漏的一条：那时唤出键已经不见了，
        // 栏若还亮着就没人能把它收回去。
        assertFalse(BookmarkBar.expanded(true, false, false));
    }

    @Test
    public void 标签三级降级() {
        assertEquals("某站", BookmarkBar.label("某站", "https://a.test/"));
        assertEquals("a.test", BookmarkBar.label("", "https://a.test/"));
        assertEquals("a.test", BookmarkBar.label(null, "https://a.test/"));
        // 标题只有空白也算没有
        assertEquals("a.test", BookmarkBar.label("   ", "https://a.test/"));
    }

    @Test
    public void 标签取不到任何东西时给空串() {
        assertEquals("", BookmarkBar.label(null, null));
        assertEquals("", BookmarkBar.label("", ""));
    }

    @Test
    public void 首字母() {
        assertEquals("A", BookmarkBar.letter("abc"));
        assertEquals("A", BookmarkBar.letter("ABC"));
        assertEquals("吾", BookmarkBar.letter("吾爱Nova"));
        assertEquals("5", BookmarkBar.letter("52ta"));
    }

    @Test
    public void 首字母跳过开头的符号() {
        assertEquals("推", BookmarkBar.letter("[推荐] 某站"));
        assertEquals("X", BookmarkBar.letter("---x"));
    }

    @Test
    public void 首字母取不到时给中性点() {
        assertEquals("•", BookmarkBar.letter(null));
        assertEquals("•", BookmarkBar.letter(""));
        assertEquals("•", BookmarkBar.letter("---"));
    }
}
