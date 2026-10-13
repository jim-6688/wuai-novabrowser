package top.wuai.nova;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * 吾爱Nova浏览器 · 内置用户脚本：随包发布、首次启动自动装上的那几条。
 *
 * <h3>为什么要内置</h3>
 *
 * <p>篡改猴面板空着的时候，设置里那行写的是「未安装」—— 一个已经做好的功能
 * 看上去像根本没做。而要让用户自己把它用起来，得去 Greasy Fork 找脚本、
 * 下载 {@code .user.js}、再回来点「从文件安装」挑一遍，这条路上任何一步都会掉人。
 * 内置一条口碑最好的，这个功能才从「理论上能用」变成「拿来就能用」。
 *
 * <h3>为什么是「网页限制解除」，而不是安装量第一名</h3>
 *
 * <p>Greasy Fork 总安装量第一是 AC-Baidu 净化搜索（约 342 万），但它依赖
 * {@code GM_xmlhttpRequest}、{@code GM_setValue} 这类需要原生桥与网络层的特权接口
 * —— 本引擎不提供（能力边界见 {@link GmShim} 与 {@link UserScript}），
 * 装上只会静默失败。那<b>比不内置更糟</b>：用户以为装了个好用的东西，
 * 实际什么都没发生，还怪浏览器有 bug。
 *
 * <p>第二名「网页限制解除」约 222 万安装、四千余条好评（好评 : 中评 : 差评
 * ≈ 3996 : 54 : 23），且 {@code @grant none}、只动 DOM 与事件层 ——
 * 它是本引擎真能跑起来的口碑脚本里最好的那一个。这也是唯一站得住的选法：
 * 先过「跑得起来」这道硬门槛，再在剩下的里面取口碑最高的。
 *
 * <h3>注入时机的折扣，必须说清楚</h3>
 *
 * <p>该脚本原定 {@code @run-at document-start}，靠 Hook
 * {@code EventTarget.prototype.addEventListener} 拦住网站注册的反复制监听。
 * 本引擎只能做到 {@code document-end}（{@link UserScript#RUN_AT_END}，
 * 原因见那个类的注释），所以「页面加载瞬间注册的那批监听器」拦不到。
 *
 * <p>但它并没有因此失效：CSS 强制 {@code user-select:text}、替换
 * {@code Event.prototype.preventDefault} 与 {@code returnValue} 的 setter
 * （原型方法查找是动态的，注入早晚不影响已注册的监听器走哪条实现）、
 * 以及每 30 秒一轮清 {@code onXXX} 属性的循环 —— 这几条都照常工作，
 * 而它们恰好覆盖了绝大多数网站实现「禁止复制 / 禁止右键」的方式。
 * {@link UserScript.Meta#summary()} 会把这条差别标出来，不假装做到了 document-start。
 *
 * <h3>合规</h3>
 *
 * <p>脚本为 Cat73 的作品，LGPLv3 许可。该许可允许随包分发，但要求保留
 * 版权与许可声明，因此许可证全文随包放在
 * {@code assets/user-scripts/LICENSE-remove-web-limits.txt}，面板上标明作者与许可。
 * 脚本本体<b>逐字节保持上游原样</b>：改一个字符，{@link Item#sha256} 那条
 * 追溯断言就断了，而「这份内置脚本到底是不是我们审计过的那一份」将无从回答。
 *
 * <h3>卸载之后不复活</h3>
 *
 * <p>播种是一次性的：装过就把 key 记下来，之后永不再检查。否则用户卸载完
 * 重启一次它又回来了，那个卸载按钮等于是假的。这个标记记的是「播种过」，
 * 不是「当前装着」—— 两者的区别正是卸载能不能生效的关键。
 */
public final class BuiltinScripts {

    private BuiltinScripts() {}

    /** 内置脚本在 assets 里的目录。 */
    static final String DIR = "user-scripts/";

    /** 一个内置脚本的清单项。 */
    public static final class Item {
        /** 播种标记用的键。刻意不用脚本 id —— 作者改名或改内容时 id 会变，键不该跟着变。 */
        public final String key;
        /** assets 里的脚本路径。 */
        public final String scriptAsset;
        /** assets 里的许可证全文路径。 */
        public final String licenseAsset;
        /** 面板上显示的那行来源与许可。 */
        public final String credit;
        /** 脚本本体的 sha256，钉住「内置的就是我们审计过的那一份」。 */
        public final String sha256;

        public Item(String key, String scriptAsset, String licenseAsset,
                    String credit, String sha256) {
            this.key = key;
            this.scriptAsset = scriptAsset;
            this.licenseAsset = licenseAsset;
            this.credit = credit;
            this.sha256 = sha256;
        }
    }

    /**
     * 内置清单。
     *
     * <p>只放了一条，而且<strong>不打算随便加</strong>：每一条内置脚本都会在
     * 用户的每一个网页上跑起来，这是替用户做的决定。加之前先过那两道门槛 ——
     * 引擎能不能跑（有没有 {@code @grant} 特权）、口碑是不是真的高（安装量与评分）。
     */
    public static final List<Item> MANIFEST = Collections.unmodifiableList(Arrays.asList(
        new Item(
            "remove-web-limits",
            DIR + "remove-web-limits.user.js",
            DIR + "LICENSE-remove-web-limits.txt",
            "网页限制解除 v1.2.4 · Cat73 · LGPLv3",
            "53da034548435466aa22ba60143fbcfd569de050462f7e8a01822ba4fd404e11")
    ));

    /** 按 key 找清单项，找不到返回 null。 */
    public static Item byKey(String key) {
        for (Item it : MANIFEST) {
            if (it.key.equals(key)) return it;
        }
        return null;
    }

    /**
     * 由脚本 id 反查它是不是内置的那一条，不是就返回 null。
     *
     * <p>反查要走播种映射，而不是拿 id 去和清单里的字段比 ——
     * id 是脚本内容的函数（{@link UserScript#idOf}），清单里根本没有这个值。
     */
    public static Item itemOf(String id, NovaStore store) {
        if (id == null || id.isEmpty() || store == null) return null;
        for (Item it : MANIFEST) {
            if (id.equals(store.builtinSeededId(it.key))) return it;
        }
        return null;
    }

    /**
     * 把还没播种过的内置脚本装进 store，返回这次新装了几条。
     *
     * <p>在 {@code onCreate} 里同步调用。读的是几 KB 的 asset，可以接受；
     * 也因此它<b>不</b>抛异常 —— 出任何问题都只是「这次没装上」，
     * 留到下次启动再试，绝不能把启动弄崩。
     */
    public static int seed(NovaStore store) {
        if (store == null) return 0;
        int n = 0;
        for (Item it : MANIFEST) {
            // 播种过就永不回头。用户卸载之后重启不会再冒出来 —— 关键就在这一句。
            if (store.builtinSeededId(it.key) != null) continue;

            UserScript.Parsed p;
            try {
                p = UserScript.parse(store.readAssetText(it.scriptAsset));
            } catch (Exception e) {
                continue;   // 读不到就下次再说
            }
            if (!p.ok()) continue;   // 这是打包错误，BuiltinScriptsTest 会钉住

            String id = UserScript.idOf(p.meta, p.body);
            if (!hasScript(store, id)) {
                // 用户自己装过同一个脚本（同 namespace + name）就不覆盖 —— 他手上那份
                // 可能比我们内置的新，或者他自己改过。但照样标记为已播种：
                // 这是他自己的副本，删了不该由我们再装回来。
                if (!store.saveScript(new UserScript.Installed(id, p.meta, p.body,
                        System.currentTimeMillis(), it.credit))) {
                    continue;   // 写失败（存储满），不标记，下次再试
                }
            }
            store.markBuiltinSeeded(it.key, id);
            n++;
        }
        return n;
    }

    /** 已装列表里有这个 id 吗。 */
    private static boolean hasScript(NovaStore store, String id) {
        for (UserScript.Installed s : store.loadScripts()) {
            if (id.equals(s.id)) return true;
        }
        return false;
    }

    /** 所有内置脚本的 id（已播种的那些），供面板批量判断用。 */
    public static List<String> seededIds(NovaStore store) {
        List<String> out = new ArrayList<>();
        if (store == null) return out;
        for (Item it : MANIFEST) {
            String id = store.builtinSeededId(it.key);
            if (id != null && !id.isEmpty()) out.add(id);
        }
        return out;
    }
}
