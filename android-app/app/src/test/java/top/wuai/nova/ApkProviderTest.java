package top.wuai.nova;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * 安装包分发通道的路径校验。
 *
 * <p>这是「把私有目录里的一个文件交给别的应用」这条链路上唯一的关卡。
 * 它有洞，就等于任何拿到过读权限的进程都能顺着 {@code ../} 把
 * {@code databases/}、{@code shared_prefs/} 一路读出去 ——
 * 而那里面装着 Cookie、书签和全部设置。
 *
 * <p>所以这里不满足于「读代码觉得没问题」，把规则抽成了纯函数逐条钉住。
 */
public class ApkProviderTest {

    // ------------------------------------------------------------ 允许的

    @Test
    public void 正常的更新包名放行() {
        assertTrue(ApkProvider.safeName("nova-1.2.3.apk"));
        assertTrue(ApkProvider.safeName("nova.apk"));
        assertTrue(ApkProvider.safeName("nova-1.2.3-beta.apk"));
    }

    // ------------------------------------------------------------ 拒绝的

    @Test
    public void 空名字一律拒绝() {
        assertFalse(ApkProvider.safeName(null));
        assertFalse(ApkProvider.safeName(""));
    }

    @Test
    public void 带路径分隔符的一律拒绝() {
        assertFalse("正斜杠能多走一层目录", ApkProvider.safeName("a/b.apk"));
        assertFalse("反斜杠同样不能放过", ApkProvider.safeName("a\\b.apk"));
    }

    @Test
    public void 连续两个点一律拒绝() {
        // 这是最要紧的一条：它才是真正能把私有目录读穿的那个构造。
        assertFalse(ApkProvider.safeName("../evil.apk"));
        assertFalse(ApkProvider.safeName("....apk"));
        assertFalse(ApkProvider.safeName("a..b.apk"));
        assertFalse("URL 编码过的斜杠也走不到这里，但万一走到了也必须拦住",
            ApkProvider.safeName("..%2F..%2Fdatabases%2Fcookies"));
    }

    @Test
    public void 非apk后缀一律拒绝() {
        assertFalse(ApkProvider.safeName("settings.xml"));
        assertFalse(ApkProvider.safeName("nova.db"));
        assertFalse(ApkProvider.safeName("cookies"));
        assertFalse("大小写不做兼容：我们自己生成的永远是小写",
            ApkProvider.safeName("nova.APK"));
    }

    @Test
    public void 只是名字里带apk字样不算数() {
        assertFalse(ApkProvider.safeName("apk"));
        assertFalse(ApkProvider.safeName("nova.apk.txt"));
    }

    // ------------------------------------------------------------ 跨模块不变量

    @Test
    public void 自己生成的包名一定能通过安全校验() {
        // 这条是整批测试里最值钱的一条：它把「生成端」和「校验端」绑在一起。
        // 单独看 apkName 和 safeName 都各自成立，但两边一旦各改各的，
        // 结果就是「下载好了却装不上」——而那是一个要等线上出问题才会被发现的坑。
        String[] samples = {
            "1.2.3", "v1.0.0", "1.2.3-beta", "",
            null, "   ", "../evil", "a/b", "..", ".", "1.2.3/../../x",
            "中文版本", "1.2.3+build.7",
        };
        for (String v : samples) {
            String name = UpdateManager.apkName(v);
            assertTrue("apkName(\"" + v + "\") 生成了 " + name + "，但 ApkProvider 会拒绝它",
                ApkProvider.safeName(name));
        }
    }
}
