package top.wuai.nova;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 自动拼页状态解析的单测。
 *
 * <p>这一类里最容易错的是 {@link #unwrapJsString} ——
 * {@code evaluateJavascript} 的回传是<b>JSON 编码过</b>的一整串，
 * 忘了脱壳，界面上的状态文字就会带着引号显示出来。
 * 而这种错在真机上看起来就像「文案写错了」，没人会怀疑是解析层。
 */
public class AutoPageTest {

    // ------------------------------------------------------------ 页数上限

    @Test
    public void 页数上限只认三档() {
        assertEquals(5, AutoPage.clampMax(5));
        assertEquals(10, AutoPage.clampMax(10));
        assertEquals(20, AutoPage.clampMax(20));
    }

    @Test
    public void 非法页数落回默认() {
        // 配置文件可以被手改。读到一个 999 必须拉回默认，而不是当真。
        assertEquals(10, AutoPage.clampMax(999));
        assertEquals(10, AutoPage.clampMax(0));
        assertEquals(10, AutoPage.clampMax(-1));
        assertEquals(10, AutoPage.clampMax(Integer.MAX_VALUE));
    }

    @Test
    public void 判断合法页数() {
        assertTrue(AutoPage.isAllowedMax(5));
        assertTrue(AutoPage.isAllowedMax(20));
        assertFalse(AutoPage.isAllowedMax(7));
    }

    // ------------------------------------------------------------ 注入

    @Test
    public void 注入把配置合成同一次求值() {
        String script = "var x=1;";
        String boot = AutoPage.bootSource(script, 20);
        // 配置必须夹在同一次求值里。拆成两次就依赖「首检有 600ms 延迟」
        // 那个时序恰好来得及 —— 这类写法出问题时最难查。
        assertTrue(boot.startsWith(script));
        assertTrue(boot.contains("a.config.maxPages=20"));
    }

    @Test
    public void 注入时页数被夹() {
        assertTrue(AutoPage.bootSource("x", 999).contains("a.config.maxPages=10"));
    }

    // ------------------------------------------------------------ 状态解析

    @Test
    public void 解析正常状态() {
        AutoPage.Status s = AutoPage.parseStatus("\"3~0~1~~\"");
        assertEquals(3, s.pages);
        assertFalse(s.loading);
        assertTrue(s.hasNext);
        assertEquals("", s.error);
    }

    @Test
    public void 解析带错误状态() {
        AutoPage.Status s = AutoPage.parseStatus("\"0~0~0~加载失败:超时~拼到一半:第 3 页\"");
        assertTrue(s.error.contains("超时"));
        assertTrue(s.summary().startsWith("拼页失败"));
    }

    @Test
    public void 解析完成状态() {
        // 注意文本里不能带 ~。分隔符被数据污染是页面侧要负责替换掉的
        // （STATUS_SOURCE 里的 replace(/~/g,'/')），这里给的数据必须符合约定。
        AutoPage.Status s = AutoPage.parseStatus("\"5~0~0~~已拼完，共 5 页\"");
        assertEquals(5, s.pages);
        assertEquals("已拼完，共 5 页", s.summary());
        // 已经拼进 5 页了，所以「可撤销」成立，「可停止」也成立
        //（它是 pages>0 || loading，pages 已经有 5 了）
        assertTrue(s.canUndo());
        assertTrue(s.canStop());
    }

    @Test
    public void 空状态是空状态不是异常() {
        // 页面没注入、脚本抛错、返回 null —— 统统当「没有状态」。
        // 绝不把解析失败装成正常状态：那会让界面显示一个假的「已拼接 0 页」。
        for (String raw : new String[]{null, "", "null", "abc", "\"1~0\"", "\"x~0~0~~\""}) {
            assertEquals(raw, AutoPage.Status.EMPTY.pages, AutoPage.parseStatus(raw).pages);
        }
    }

    @Test
    public void 状态摘要安静优先() {
        // 没事发生的时候就不吭声。状态条一直挂着一句话比不显示更烦。
        assertEquals("尚未拼接", AutoPage.Status.EMPTY.summary());
    }

    // -------------------------------------------------------- 解 JSON 壳

    @Test
    public void 脱掉JSON引号() {
        // 这就是 evaluateJavascript 的真实回传形态。忘了脱壳，
        // 界面上的状态文字会带着引号显示出来。
        assertEquals("3~0~1~~", AutoPage.unwrapJsString("\"3~0~1~~\""));
    }

    @Test
    public void 脱掉转义序列() {
        // 中文可能被转成反斜杠 u 开头的十六进制形式。
        // 这三个码点正好是「已拼完」三个字。
        assertEquals("已拼完", AutoPage.unwrapJsString("\"\\u5df2\\u62fc\\u5b8c\""));
    }

    @Test
    public void 处理普通转义() {
        assertEquals("a\nb", AutoPage.unwrapJsString("\"a\\nb\""));
        assertEquals("a\tb", AutoPage.unwrapJsString("\"a\\tb\""));
        assertEquals("a\\b", AutoPage.unwrapJsString("\"a\\\\b\""));
    }

    @Test
    public void 末尾引号被转义时不当作定界符() {
        // 输入是 "ab\" —— 看着两头都有引号，但最后那个前面是反斜杠，
        // 它是被转义的内容而不是定界符。第一版就是在这儿错的：
        // 剥不掉外层引号，还把那个引号当成内容交出去，界面上凭空多一个引号。
        assertTrue(AutoPage.unwrapJsString("\"ab\\\"\"").endsWith("ab\""));
    }

    @Test
    public void 处理残缺输入() {
        // 畸形输入不能抛 —— 解析状态是在回调里跑的，抛出去会打断界面更新。
        assertEquals("", AutoPage.unwrapJsString(null));
        assertEquals("", AutoPage.unwrapJsString(""));
        assertEquals("", AutoPage.unwrapJsString("null"));
        // 以反斜杠结尾的裸串：没有引号定界，原样返回
        assertEquals("ab\\", AutoPage.unwrapJsString("ab\\"));
        // 截断的 u 转义在引号内部：引号完整（末尾没被转义），该剥掉；
        // 剩下的是「a + 一个反斜杠 + u + 两个十六进制位」，位数不够 4 位，
        // 走不到解码分支，反斜杠被丢弃只留下 u。
        // 丢弃反斜杠是有意的：它本来就是转义标记，留着一个裸露的反斜杠
        // 反而可能被误认成还没解码完的转义序列。
        assertEquals("au12", AutoPage.unwrapJsString("\"a\\u12\""));
    }

    @Test
    public void 不带引号的原样返回() {
        assertEquals("3~0~1~~", AutoPage.unwrapJsString("3~0~1~~"));
    }

    @Test
    public void 完整状态经壳后仍能解析() {
        // 端到端串一次：WebView 的真实回传 → 解析 → 摘要。
        // 单测两个函数各自对，还可能两边的约定对不上。
        String raw = "\"2~1~1~~\"";
        AutoPage.Status s = AutoPage.parseStatus(raw);
        assertEquals(2, s.pages);
        assertTrue(s.loading);
        assertTrue(s.hasNext);
        assertEquals("正在拼接第 4 页…", s.summary());
    }

    @Test
    public void 分隔符被数据污染也能解析() {
        // 页面侧会把文本里的 ~ 换掉，但万一漏了也不能整体崩 ——
        // 这里验证的是「切分按位取，字段多了不炸」。
        String raw = "\"1~0~0~a~b~c\"";
        AutoPage.Status s = AutoPage.parseStatus(raw);
        assertEquals(1, s.pages);
        assertEquals("a", s.error);
        assertEquals("b", s.finished);
    }
}