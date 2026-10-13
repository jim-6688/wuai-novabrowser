package top.wuai.nova;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * QA 补充：{@link MainActivity#indexOfTabRef} 的「按引用定位」语义验证。
 *
 * <p>团队最担心的是 {@code indexOf}/{@code equals} 的经典陷阱：列表里有多个
 * 「内容完全相同」的 Tab（同 url 同 title）时，按值定位会认错。
 * 本类专门验证这一点，并顺带证明：因为 {@link Tab} <b>没有</b>重写 {@code equals()}，
 * 该陷阱在本工程里其实<b>并未上膛</b>。
 */
public class MainActivityTabRefEdgeTest {

    private static Tab tab(String url, String title) {
        Tab t = new Tab(url);
        t.title = title;
        return t;
    }

    @Test
    public void 多个内容完全相同的实例各归各位() {
        // 三个「同 url 同 title」的标签 —— 按值定位必错，按引用必须分得清
        List<Tab> tabs = new ArrayList<>();
        Tab h1 = tab("about:blank", "");
        Tab h2 = tab("about:blank", "");
        Tab h3 = tab("about:blank", "");
        tabs.add(h1);
        tabs.add(h2);
        tabs.add(h3);

        assertEquals(0, MainActivity.indexOfTabRef(tabs, h1));
        assertEquals(1, MainActivity.indexOfTabRef(tabs, h2));
        assertEquals(2, MainActivity.indexOfTabRef(tabs, h3));
    }

    @Test
    public void 一个不在列表里的等值新对象必须定位失败() {
        // 这是「按引用」的安全底线：不能因为 url 相同就把别人的标签关掉
        List<Tab> tabs = new ArrayList<>();
        tabs.add(tab("https://x.com/", "X"));
        tabs.add(tab("https://x.com/", "X"));   // 与上一个完全同值
        Tab outsider = tab("https://x.com/", "X"); // 不在列表里，但值与成员相同

        assertEquals(-1, MainActivity.indexOfTabRef(tabs, outsider));
    }

    @Test
    public void Tab未重写equals所以indexOf也不会踩陷阱() {
        // 记录一个事实：因为 Tab 用的是 Object 身份相等，即使调用方误用
        // List.indexOf，在本工程当前实现下也不会有「关错同值标签」的问题。
        // 一旦将来给 Tab 加了按值 equals，这段保证就会消失 —— 届时 indexOfTabRef
        // 的 == 仍是正确的，但别处用 indexOf/contains 的地方会开始出错。
        List<Tab> tabs = new ArrayList<>();
        Tab a = tab("https://same.com/", "S");
        Tab b = tab("https://same.com/", "S");
        tabs.add(a);
        tabs.add(b);

        assertEquals(b, tabs.get(tabs.indexOf(b)));
        assertEquals(MainActivity.indexOfTabRef(tabs, b), tabs.indexOf(b));
    }

    @Test
    public void 大量同值标签中按引用删一个不影响其余() {
        List<Tab> tabs = new ArrayList<>();
        for (int i = 0; i < 20; i++) tabs.add(tab("about:blank", ""));
        // 取第 13 个（下标 12）作为要关的对象
        Tab victim = tabs.get(12);

        int idx = MainActivity.indexOfTabRef(tabs, victim);
        assertEquals(12, idx);
        tabs.remove(idx);

        assertEquals(19, tabs.size());
        // 删除后其余对象的引用位置整体前移，但按引用仍能各自对上
        assertEquals(12, MainActivity.indexOfTabRef(tabs, tabs.get(12)));
        // 被删的那个对象再也找不到
        assertEquals(-1, MainActivity.indexOfTabRef(tabs, victim));
    }

    @Test
    public void 同一对象在列表里重复出现时命中第一个() {
        // 极端构造：同一个 Tab 实例被放两次。按引用定位返回首个匹配即可 ——
        // 真实流程不会出现，但提前钉住「不抛异常、不越界」。
        List<Tab> tabs = new ArrayList<>();
        Tab t = tab("https://x.com/", "X");
        tabs.add(t);
        tabs.add(t);
        assertEquals(0, MainActivity.indexOfTabRef(tabs, t));
    }

    @Test
    public void 空列表与null参数一律返回负一() {
        List<Tab> empty = new ArrayList<>();
        assertEquals(-1, MainActivity.indexOfTabRef(empty, tab("about:blank", "")));
        assertEquals(-1, MainActivity.indexOfTabRef(null, tab("about:blank", "")));
        assertEquals(-1, MainActivity.indexOfTabRef(empty, null));
        tabsNonNullApisConsistent(empty);
    }

    private static void tabsNonNullApisConsistent(List<Tab> list) {
        // 只读探针，确保上面的调用没有副作用
        assertTrue(list.isEmpty());
    }
}
