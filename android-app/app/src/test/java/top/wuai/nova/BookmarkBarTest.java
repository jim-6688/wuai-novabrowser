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

    /** 收藏夹栏标题下面那一行（与桌面端那条栏一致）。 */
    @Test
    public void 网址行取主机名() {
        assertEquals("a.test", BookmarkBar.host("https://a.test/"));
        assertEquals("a.test", BookmarkBar.host("https://a.test/some/path?q=1"));
        assertEquals("a.test", BookmarkBar.host("http://a.test:8080/x"));
    }

    @Test
    public void 网址行去掉www前缀() {
        // www. 不携带任何区分信息（同一个站必然是同一个主机），
        // 却占掉一行里最贵的两三个字符
        assertEquals("zhihu.com", BookmarkBar.host("https://www.zhihu.com/question/1"));
        assertEquals("example.com", BookmarkBar.host("https://www.example.com/"));
        // 只去**开头**那一层，中间的 www. 是主机名的一部分，不动
        assertEquals("www.site.com", BookmarkBar.host("https://www.www.site.com/"));
    }

    @Test
    public void 网址行取不到时给空串而不是抛() {
        // 空串让调用方整行隐去；返回 null 的话调用方得写 null 判断，
        // 而忘了判的那处会在真机上崩
        assertEquals("", BookmarkBar.host(null));
        assertEquals("", BookmarkBar.host(""));
    }

    @Test
    public void 没有协议的那种原样透出_而不是空() {
        // hostOf 对不含 :// 的输入是**原样返回**（about:blank 这类），
        // 见 BookmarkBar.label 的注释。这种「主机名」其实就是整条地址 ——
        // 但它照样比一个空的第二行有用（用户能看出这是内部页而不是收藏的站），
        // 所以照透出，不在这里替它判空。
        assertEquals("about:blank", BookmarkBar.host("about:blank"));
    }
}
