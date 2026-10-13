package top.wuai.nova;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 吾爱Nova浏览器 · 用户脚本特权接口（{@code GM_} 家族）的垫片层。
 *
 * <h3>为什么这东西存在</h3>
 *
 * <p>{@code GM_addStyle}、{@code GM_setValue} 这些<b>不是内核能力</b>。
 * Chromium / WebView 从来没有、也不打算提供它们 —— 它们是篡改猴这类
 * 用户脚本管理器自己用 JavaScript 加一层原生桥搓出来的门面。
 * 所以「引擎不支持」这句话本身不成立：真正缺的只是<b>那层门面</b>。
 *
 * <p>本类提供其中<b>不需要原生桥</b>的那一批 —— 全部是纯 JavaScript，
 * 所以整层实现就是一段字符串，不新增依赖、不新增权限、不改变安装包体积量级。
 *
 * <h3>只给声明过的，不多给一项</h3>
 *
 * <p>本类严格按脚本自己的 {@code @grant} 声明发放对应接口：
 * 没声明就拿不到（{@code @grant none} 或完全没有 {@code @grant} 行的脚本
 * 一项也拿不到）。这<b>不是</b>抠门，是三条理由叠在一起：
 *
 * <ol>
 *   <li>与篡改猴一致。那边 {@code @grant none} 的脚本同样拿不到任何
 *       {@code GM_} 函数，脚本作者正是按这个前提写代码的。</li>
 *   <li>让 {@code @grant} 这件事保持有意义。如果不管声明什么都发，
 *       「声明了 N 项不支持的权限」那条警告就没法只说真话。</li>
 *   <li><b>零回归</b>。改动之前一项都不发，所以「只发声明过的」这件事
 *       对现有任何脚本都不会造成行为变化 —— 只有新声明了受支持接口的脚本，
 *       才会从「静默失败」变成「真的能用」。</li>
 * </ol>
 *
 * <h3>为什么用函数参数，而不是挂在 window 上</h3>
 *
 * <p>注入形如：
 * <pre>
 * (function(GM_addStyle, unsafeWindow){
 *   ...
 * })(__g.addStyle, window);
 * </pre>
 *
 * <p>接口是作为<b>实参</b>传进脚本作用域的，不是写成 {@code window.GM_addStyle}。
 * 这么做换来三件事：
 *
 * <ul>
 *   <li><b>不污染页面</b>。挂在 window 上等于往用户的每一个网页里塞几个全局变量，
 *       页面能看见、能改名、能拿去伪装；而篡改猴也是用参数传的，行为一致。</li>
 *   <li><b>脚本之间互不干扰</b>。同一次注入里多个脚本各自拿到自己的那份，
 *       谁也没法改掉别人的。</li>
 *   <li>{@code typeof GM_xmlhttpRequest === 'function'} 这种特征检测仍然正确 ——
 *       没声明过的接口就是真的不存在，写得好一些的脚本会自己走降级分支。</li>
 * </ul>
 *
 * <h3>{@code unsafeWindow} 在这里是免费的 —— 以及为什么这不值得高兴</h3>
 *
 * <p>本引擎的注入走 {@code evaluateJavascript}，脚本跑在页面的<b>主世界</b>里，
 * 所以 {@code window} 本来就是页面的 window，{@code unsafeWindow} 直接等于它。
 * 在篡改猴里这是一项需要显式申请、用来<b>跨出</b>沙箱的特权；在这里它天然成立。
 *
 * <p>免费的原因恰恰是没有沙箱 —— <b>没有边界，也就无所谓跨越</b>。
 * 脚本和页面共享同一套全局对象：页面能检测到本脚本的存在、能篡改脚本依赖的对象。
 * 篡改猴能同时给出「干净的沙箱」和「显式的跨界出口」，本引擎当前只能给出后者。
 * 要补上沙箱得走 {@code WebViewCompat} 的隔离世界（isolated world），
 * 那需要引入 {@code androidx.webkit} 依赖 —— 属于后续档位，不在本类范围内。
 *
 * <h3>{@code GM_info} 报的是「实际」，不是「声明」</h3>
 *
 * <p>脚本原定 {@code @run-at document-start} 时，本引擎实际只能做到
 * {@code document-end}（原因见 {@link UserScript} 的注释）。{@code GM_info}
 * 里报的是<b>实际值</b>：脚本若按声明值判断「我在 document-start 跑的，可以放心
 * Hook 早期事件」，它就会走一条在这里根本走不通的路；报实际值，
 * 写得好的脚本会自己换成降级分支。
 *
 * <p>本类刻意不依赖任何 Android 框架，因此可以在纯 JVM 单测里跑 ——
 * 与工程里其余可测类同一策略。见 {@code GmShimTest}。
 */
public final class GmShim {

    private GmShim() {}

    /**
     * 本引擎真正提供的接口，按此顺序生成注入参数。
     *
     * <p>顺序写死而不是遍历脚本的声明顺序：注入结果是脚本元数据的纯函数，
     * 同一个脚本无论 {@code @grant} 行怎么排，生成的代码都该一模一样 ——
     * 否则「注入顺序稳定」这件事就只对脚本列表成立，对参数列表不成立。
     */
    public static final List<String> SUPPORTED = Collections.unmodifiableList(Arrays.asList(
        "GM_addStyle",
        "GM_addElement",
        "GM_log",
        "GM_info",
        "GM",
        "unsafeWindow"
    ));

    private static final Set<String> SUPPORTED_LOWER = lowerSet(SUPPORTED);

    /**
     * 垫片本体：定义三个纯 JavaScript 接口，返回承载它们的对象。
     *
     * <p>写成一段字符串常量而不是三份 Java 方法各自拼串 —— 它们是一个整体，
     * 拆开只会让「哪几个接口是一批」这件事从代码里消失。
     *
     * <p>每个函数都自带 try/catch：脚本传入的实参完全可能是任意类型的脏值
     * （{@code GM_addStyle(undefined)} 在真实脚本里并不罕见），而这里抛出的异常
     * 会顺着调用栈污染到脚本自己的逻辑里，让一个「样式没加上」的次要问题
     * 升级成「脚本整个挂掉」。失败就返回 null，让脚本自己去判空。
     */
    static final String SHIM_BODY =
        "var d=document;"
        + "function addStyle(css){try{"
        + "var s=d.createElement('style');"
        + "s.textContent=String(css==null?'':css);"
        + "(d.head||d.documentElement).appendChild(s);"
        + "return s;}catch(e){return null;}}"
        + "function addElement(a,b,c){try{"
        + "var parent=null,tag=a,attrs=b;"
        + "if(a&&a.nodeType===1){parent=a;tag=b;attrs=c;}"
        + "var el=d.createElement(String(tag||'div'));"
        + "if(attrs&&typeof attrs==='object'){"
        + "for(var k in attrs){"
        + "if(!Object.prototype.hasOwnProperty.call(attrs,k)){continue;}"
        + "try{if(k==='textContent'){el.textContent=attrs[k];}"
        + "else{el.setAttribute(k,attrs[k]);}}catch(e){}}}"
        + "var host=parent||d.head||d.body||d.documentElement;"
        + "if(host){host.appendChild(el);}"
        + "return el;}catch(e){return null;}}"
        + "function log(){try{"
        + "console.log.apply(console,['[NovaGM]'].concat("
        + "Array.prototype.slice.call(arguments)));}catch(e){}}"
        + "return {addStyle:addStyle,addElement:addElement,log:log};";

    // ------------------------------------------------------------ 判定

    /** 这一项 {@code @grant} 本引擎是否已经提供。大小写与首尾空白都容错。 */
    public static boolean isSupported(String grant) {
        if (grant == null) return false;
        return SUPPORTED_LOWER.contains(grant.trim().toLowerCase(Locale.ROOT));
    }

    /**
     * 从一组 {@code @grant} 里挑出<b>本引擎确实不提供</b>的那些。
     *
     * <p>这是「能力边界」唯一的判定入口 —— {@link UserScript.Meta#needsPrivilegeWarning()}
     * 和安装前的提示都走这里。所以要挡两件事：
     *
     * <ul>
     *   <li>{@code none} 要滤掉。{@link UserScript#parse} 已经在解析时就滤过一次，
     *       但本方法不该依赖调用方滤过 —— 它是判定入口，得自洽。</li>
     *   <li><b>要去重</b>。同一个接口声明两遍在真实脚本里存在，不去重的话
     *       提示会写成「声明了 2 项未支持的权限」，而其实只有 1 项 ——
     *       数字对不上的警告会让人开始怀疑整条警告的真实性。</li>
     * </ul>
     */
    public static List<String> unsupported(List<String> grants) {
        List<String> out = new ArrayList<>();
        if (grants == null) return out;
        Set<String> seen = new HashSet<>();
        for (String g : grants) {
            if (g == null) continue;
            String t = g.trim();
            if (t.isEmpty()) continue;
            if ("none".equalsIgnoreCase(t)) continue;
            if (isSupported(t)) continue;
            if (!seen.add(t.toLowerCase(Locale.ROOT))) continue;
            out.add(t);
        }
        return out;
    }

    // ------------------------------------------------------------ 生成

    /**
     * 按脚本声明生成注入用的形参表与实参表。
     *
     * <p>返回「是否用到了垫片对象」。用到了就必须由调用方把它定义在同层的
     * 外层作用域里 —— 实参表达式是在函数体<b>之外</b>求值的，
     * {@code (function(x){...})(__g.a)} 里的 {@code __g} 必须已经存在，
     * 而它恰恰不能定义在函数体内部。
     *
     * @param meta  脚本元数据；为 null 时什么都不生成（视同没有任何声明）
     * @param params 出参：形参名，按 {@link #SUPPORTED} 的顺序追加
     * @param args   出参：与 params 一一对应的实参表达式
     */
    public static boolean collect(UserScript.Meta meta,
                                  List<String> params, List<String> args) {
        if (meta == null) return false;
        Set<String> declared = lowerSet(meta.grants);
        boolean usesShim = false;

        if (declared.contains("gm_addstyle")) {
            params.add("GM_addStyle");
            args.add("__g.addStyle");
            usesShim = true;
        }
        if (declared.contains("gm_addelement")) {
            params.add("GM_addElement");
            args.add("__g.addElement");
            usesShim = true;
        }
        if (declared.contains("gm_log")) {
            params.add("GM_log");
            args.add("__g.log");
            usesShim = true;
        }
        if (declared.contains("gm_info")) {
            params.add("GM_info");
            args.add(infoLiteral(meta));
        }
        if (declared.contains("gm")) {
            // 现代写法（篡改猴 4.11 起）把接口收在 GM 这个命名空间下。
            // 这里给出的只是本引擎支持的那几项 —— 缺的部分由安装时的警告如实告知，
            // 不做成「看起来什么都有」的假象。
            params.add("GM");
            args.add("{addStyle:__g.addStyle,addElement:__g.addElement,"
                + "log:__g.log,info:" + infoLiteral(meta) + "}");
            usesShim = true;
        }
        if (declared.contains("unsafewindow")) {
            params.add("unsafeWindow");
            args.add("window");
        }
        return usesShim;
    }

    /** 构造 {@code GM_info} 的对象字面量。 */
    static String infoLiteral(UserScript.Meta m) {
        StringBuilder sb = new StringBuilder(160);
        sb.append("{scriptHandler:'Nova',script:{");
        sb.append("name:").append(jsStr(m == null ? null : m.name));
        sb.append(",namespace:").append(jsStr(m == null ? null : m.namespace));
        sb.append(",version:").append(jsStr(m == null ? null : m.version));
        sb.append(",description:").append(jsStr(m == null ? null : m.description));
        // 报实际时机，不报声明时机 —— 理由见类注释。
        sb.append(",runAt:").append(jsStr(UserScript.RUN_AT_END));
        sb.append(",matches:[");
        List<String> match = m == null ? Collections.<String>emptyList() : m.match;
        for (int i = 0; i < match.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(jsStr(match.get(i)));
        }
        sb.append("]}}");
        return sb.toString();
    }

    /**
     * 把一个 Java 字符串转成 JavaScript 单引号字符串字面量。
     *
     * <p>这一步不是「顺手写一下」——它是<b>安全相关</b>的。生成的代码要拼进
     * {@code evaluateJavascript} 的执行体里，而来源字符串是<b>用户可控</b>的
     * （脚本名、描述、{@code @match} 模式都来自下载到的 .user.js）。
     * 一个名字里带单引号的脚本（{@code Bob's reader}）不去转义就会把生成的
     * JS 撕成语法错误 —— 而语法错误会让<b>整次注入失败</b>，
     * 也就是这一页上所有脚本一起静默死掉，报错只会指向一句看不懂的
     * {@code missing ) after argument list}。
     *
     * <p>另外两个必须显式处理的是 U+2028 与 U+2029（行分隔符/段分隔符）：
     * 它们在 JSON 里合法、在 ES2019 之前的 JavaScript 字符串字面量里<b>非法</b>，
     * 而本工程 {@code minSdk 24}（Android 7 时期的内核）远早于 ES2019。
     * 不转义的话，脚本描述里混进这两个字符就会以同样的方式炸掉整次注入。
     */
    static String jsStr(String s) {
        if (s == null) return "''";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        sb.append('\'');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '\'': sb.append("\\'"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\u2028': sb.append("\\u2028"); break;
                case '\u2029': sb.append("\\u2029"); break;
                default: sb.append(c);
            }
        }
        sb.append('\'');
        return sb.toString();
    }

    private static Set<String> lowerSet(List<String> src) {
        Set<String> out = new HashSet<>();
        if (src == null) return out;
        for (String s : src) {
            if (s == null) continue;
            String t = s.trim().toLowerCase(Locale.ROOT);
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }
}
