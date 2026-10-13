package top.wuai.nova;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 吾爱Nova浏览器 · 用户脚本（「插件」）。
 *
 * <h3>为什么是用户脚本，而不是 Chrome 扩展</h3>
 *
 * <p>Android WebView <b>不加载 Chrome 扩展</b>。这不是懒得做，是平台根本没有扩展
 * 宿主（{@code androidx.webkit} 只提供 WebView 组件，不提供 extension API）。
 * 移动端浏览器要「可安装的插件」，业界可行的路子只有用户脚本（Tampermonkey
 * 那一套）—— Kiwi、Firefox Android 都是这么做的。所以这里支持
 * {@code .user.js}，格式沿用大家已经熟的那套 {@code ==UserScript==} 头。
 *
 * <p>这个取舍必须在界面上讲明，不能让用户以为装了个 Chrome 扩展。
 *
 * <h3>能力边界：{@code GM_} 接口只提供一部分</h3>
 *
 * <p>{@code GM_addStyle} 这类接口不是内核给的，是用户脚本管理器自己搭的门面
 * （详见 {@link GmShim}）。本引擎提供其中<b>不需要原生桥</b>的那一批
 * —— 清单在 {@link GmShim#SUPPORTED}，判定走 {@link GmShim#unsupported}。
 *
 * <p>其余的分两批，各自缺的东西不一样：
 *
 * <ul>
 *   <li><b>缺原生桥</b>：{@code GM_setValue} / {@code GM_getValue} 这类要落盘的。
 *       本工程没有 {@code addJavascriptInterface}，所以脚本没法把值交给 Java 侧。</li>
 *   <li><b>缺网络层</b>：{@code GM_xmlhttpRequest} 这类要跨域发请求的。
 *       还得额外解决 Cookie 共享与目标站点白名单两个问题，不只是「发个请求」。</li>
 * </ul>
 *
 * <p>这些一律<b>不假装支持</b>：声明了就拿不到对应的函数，并且
 * {@link Meta#summary()} 与安装前的确认框都会如实列出来。原因很实在 ——
 * 静默失败比不提供更糟：用户以为装了个好用的东西，实际什么都没发生，
 * 最后怪浏览器有 bug。{@code @grant} 声明也因此保持有意义，
 * 将来每补上一批接口，警告就会自动少一项。
 *
 * <h3>注入时机</h3>
 *
 * <p>只有 {@code document-end} 与 {@code document-idle} 能做到 ——
 * {@code document-start} 需要在文档创建之前注入，WebView 只给
 * {@code onPageStarted}，那时文档已经建好了，插进去也来不及。
 * 头里写了 {@code @run-at document-start} 就当成 end 处理，
 * 并在「已装插件」里标出来，不假装做到了。
 */
public final class UserScript {

    /** {@code @run-at} 支持到哪一档。 */
    public static final String RUN_AT_END = "document-end";

    /** 从元数据块解析出来的一个脚本。 */
    public static final class Meta {
        public String name = "未命名脚本";
        public String namespace = "";
        public String version = "";
        public String description = "";
        public String homepage = "";
        public String runAt = RUN_AT_END;
        public String icon = "";
        /** {@code @match} 精确模式，如 {@code https://example.com/*} */
        public final List<String> match = new ArrayList<>();
        /** {@code @include} 正则模式 */
        public final List<String> include = new ArrayList<>();
        /** {@code @exclude} */
        public final List<String> exclude = new ArrayList<>();
        /** {@code @require} 的外部依赖 */
        public final List<String> require = new ArrayList<>();
        /**
         * {@code @grant} 里声明的东西（{@code none} 已在解析时剔除）。
         *
         * <p>存的是脚本<b>声明</b>的全量，不区分本引擎支不支持 —— 支持与否是
         * {@link GmShim} 的判断，在两处各存一份迟早会对不上。
         */
        public final List<String> grants = new ArrayList<>();
        /**
         * 启停状态存在元数据文件里（跟着脚本走），而不是存在实例上 ——
         * 因为 {@link Installed#enabled} 每次加载都要被它重新填一遍，
         * 存两处迟早会对不上。
         */
        public boolean enabledFlag = true;

        /**
         * 脚本声明了、而本引擎确实不提供的那些权限项。
         *
         * <p>判定全在 {@link GmShim#unsupported}，这里只转发 —— 支持清单将来会变长，
         * 让每个调用方各自去比对，改清单时一定会漏掉某一处。
         */
        public List<String> unsupportedGrants() { return GmShim.unsupported(grants); }

        /** 声明了越界权限的脚本不能直接跑，要用户知道。 */
        public boolean needsPrivilegeWarning() { return !unsupportedGrants().isEmpty(); }

        /** 一条能显示在列表里的说明。 */
        public String summary() {
            List<String> parts = new ArrayList<>();
            if (!description.isEmpty()) parts.add(description);
            else parts.add("匹配 " + match.size() + " 个地址模式");
            List<String> un = unsupportedGrants();
            if (!un.isEmpty()) parts.add("声明了 " + un.size() + " 项未支持的权限");
            if ("document-start".equalsIgnoreCase(runAt)) parts.add("原定文档开始前，实际按文档结束后注入");
            return String.join(" · ", parts);
        }
    }

    /** 一个装好的脚本：元数据 + 正文 + 本地开关。 */
    public static final class Installed {
        public final String id;
        public Meta meta;
        public String body;
        public boolean enabled = true;
        public long installedAt;
        public String origin = "";

        public Installed(String id, Meta meta, String body, long installedAt, String origin) {
            this.id = id;
            this.meta = meta;
            this.body = body;
            this.installedAt = installedAt;
            this.origin = origin;
            // 元数据文件里的启停位是权威的，实例字段只是它的快照。
            this.enabled = meta.enabledFlag;
        }

        public String displayName() {
            if (meta.name != null && !meta.name.trim().isEmpty()) return meta.name.trim();
            return id;
        }
    }

    /** 解析结果，失败时 {@link #error} 有可展示的中文原因。 */
    public static final class Parsed {
        public Meta meta;
        public String body = "";
        public String error = "";
        public boolean ok() { return error.isEmpty() && meta != null; }
    }

    // ------------------------------------------------------------ 解析

    /**
     * 解析 {@code .user.js} 全文。
     *
     * <p>元数据块形如：
     * <pre>
     * // ==UserScript==
     * // @name         标题栏加时间戳
     * // @match        https://*.zhihu.com/*
     * // @exclude      https://zhihu.com/question/*
     * // @grant        none
     * // ==/UserScript==
     * </pre>
     *
     * <p>{@code ==UserScript==} 必须排在注释里（双斜杠、块注释、井号都认）。
     * 找到就返回 headStart，找不到就当无头脚本处理。
     * 找不到就整个当普通脚本处理 —— 很多用户脚本是没有头的裸 JS。
     */
    public static Parsed parse(String text) {
        Parsed p = new Parsed();
        if (text == null || text.trim().isEmpty()) {
            p.error = "文件是空的";
            return p;
        }
        List<String> lines = RuleSet.lines(text);

        int headStart = -1;
        int headEnd = -1;
        for (int i = 0; i < lines.size(); i++) {
            // 判头尾必须先把注释外壳剥掉。
            // 块注释的尾行是 " * ==/UserScript== */"，
            // 直接对原文 endsWith 会是 false —— 末尾那两字符是块注释的闭合符。
            // 结果就是「头找到了、尾找不到」，整个元数据块被当成不存在，
            // 脚本退化成无头模式，于是装上之后「什么都不发生」。
            String l = stripComment(lines.get(i));
            if (headStart < 0) {
                if ("==UserScript==".equals(l)) headStart = i;
            } else if ("==/UserScript==".equals(l)) {
                headEnd = i;
                break;
            }
        }
        if (headStart < 0 || headEnd < headStart) {
            // 无头脚本：给它一个自动生成的元数据，仍然可用
            Meta m = new Meta();
            m.name = firstCommentAsName(text);
            m.match.add("*://*/*");
            p.meta = m;
            p.body = text;
            return p;
        }

        Meta m = new Meta();
        for (int i = headStart + 1; i < headEnd; i++) {
            String l = stripComment(lines.get(i)).trim();
            if (!l.startsWith("@")) continue;
            int sp = l.indexOf(' ');
            String key = (sp < 0 ? l : l.substring(0, sp)).toLowerCase(Locale.ROOT);
            String val = sp < 0 ? "" : l.substring(sp + 1).trim();
            switch (key) {
                case "@name": m.name = val; break;
                case "@namespace": m.namespace = val; break;
                case "@version": m.version = val; break;
                case "@description": m.description = val; break;
                case "@homepage":
                case "@homepage-url": m.homepage = val; break;
                case "@icon": m.icon = val; break;
                case "@run-at": m.runAt = val.toLowerCase(Locale.ROOT); break;
                case "@match": m.match.add(val); break;
                case "@include": m.include.add(val); break;
                case "@exclude": m.exclude.add(val); break;
                case "@require": m.require.add(val); break;
                case "@grant":
                    // @grant none 是「我不需要任何特权」的声明，它本身不是一项特权。
                    // 无条件收进 grants 的话，几乎所有按规范写的脚本 —— 包括我们内置的
                    // 那条 —— 都会被判成「声明了 1 项未支持的权限」：警告本身是真的
                    // （我们确实不提供 GM_*），但它指向了一个不存在的问题，
                    // 脚本压根什么都没有请求过。误报比不报更耗人。
                    if (!"none".equalsIgnoreCase(val.trim())) m.grants.add(val);
                    break;
                default: break;   // 认识的元数据之外的键一律忽略，不报错
            }
        }
        // 没有 @match 也没有 @include 的脚本不该被装上 ——
        // 那意味着「在所有页面都跑」，而用户几乎不会真的想要这个。
        if (m.match.isEmpty() && m.include.isEmpty()) {
            p.meta = m;
            p.error = "脚本没有声明 @match 或 @include，"
                + "装上会变成「所有网站都运行」。请补上适用范围。";
            return p;
        }
        List<String> unsupported = m.unsupportedGrants();
        if (!unsupported.isEmpty()) {
            // 不拒绝安装，但要明确告知能力边界：声明了 GM_xmlhttpRequest
            // 这类本引擎不提供的接口，硬跑只会静默失败。
            // 数字只算「确实不支持的」，已经提供了的（如 GM_addStyle）不算 ——
            // 否则这条警告会把一件已经能做好的事说成缺陷。
            m.description = (m.description.isEmpty() ? "" : m.description + " · ")
                + "已忽略 " + unsupported.size() + " 项不支持的权限";
        }
        StringBuilder body = new StringBuilder();
        for (int i = headEnd + 1; i < lines.size(); i++) {
            body.append(lines.get(i)).append('\n');
        }
        p.meta = m;
        p.body = body.toString();
        return p;
    }

    private static String firstCommentAsName(String text) {
        for (String l : RuleSet.lines(text)) {
            String s = l.trim();
            if (s.startsWith("//")) {
                String c = s.substring(2).trim();
                if (!c.isEmpty() && !c.startsWith("=")) return c;
            }
            break;
        }
        return "未命名脚本";
    }

    /**
     * 剥掉一行的注释外壳，留下元数据本身。
     *
     * <p>要认三种形态，因为用户脚本的三种注释写法在真实文件里都常见：
     * <pre>
     *   &#47;&#47; @name  x        ← 双斜杠
     *   &#47;* @name x *&#47;        ← 块注释单行
     *   " * @name  x"       ← 块注释多行，每行前面有 " * "
     * </pre>
     * 第三种是最容易漏的：那一行 trim 之后是 {@code * @name x}，
     * 既不以双斜杠也不以块注释符开头，于是所有字段都被静默跳过 ——
     * 元数据块被识别到了，字段却是空的，脚本装上后什么都不做。
     *
     * <p>（这里刻意不写出真实的块注释符号：Javadoc 里一个裸的块注释起始符
     * 会把注释提前闭合，后面的方法体全部变成编译错误，而报错完全指不到原因。）
     */
    private static String stripComment(String line) {
        String s = line.trim();
        if (s.startsWith("/*")) s = s.substring(2).trim();
        else if (s.startsWith("//")) return s.substring(2).trim();
        else if (s.startsWith("#")) return s.substring(1).trim();

        // 块注释续行：可能有若干个前导 * 和空白
        while (s.startsWith("*")) {
            s = s.substring(1).trim();
        }
        // 还要剥掉尾部的块注释闭合符。
        // 那一行是 " * ==/UserScript== */"，剥掉前导 * 之后还剩个 " */"，
        // 不剥的话元数据块的尾行永远判不出来 —— 于是头找到了、尾没找到，
        // 整个块被当成不存在，脚本退化成无头模式，装上之后什么都不发生。
        if (s.endsWith("*/")) s = s.substring(0, s.length() - 2).trim();
        if (s.startsWith("*/")) return "";
        return s;
    }

    // ------------------------------------------------------------ 匹配

    /**
     * 判断脚本该不该在这个 URL 上运行。
     *
     * <p>顺序：先 {@code @exclude}（排除优先，与 Tampermonkey 一致），
     * 再 {@code @match}，再 {@code @include}。全都不命中就是不该跑。
     */
    public static boolean appliesTo(Installed s, String url) {
        if (!s.enabled || s.meta == null || url == null) return false;
        if (!startsSupported(url)) return false;
        if (url.startsWith("javascript:") || url.startsWith("data:")) return false;
        for (String ex : s.meta.exclude) {
            if (matchOne(ex, url)) return false;
        }
        for (String m : s.meta.match) {
            if (matchPattern(m, url)) return true;
        }
        for (String inc : s.meta.include) {
            if (matchOne(inc, url)) return true;
        }
        return false;
    }

    private static boolean startsSupported(String url) {
        return url.startsWith("http://") || url.startsWith("https://");
    }

    /**
     * 单一模式。
     *
     * <p>按「像不像地址」分流：有 {@code ://} 的当 {@code @match} 通配模式处理，
     * 其余当 {@code @include} 正则。
     *
     * <p>不能靠「有没有 {@code *}」来判断 —— {@code @include} 的正则里
     * {@code *} 是量词（{@code .*\.example\.com/.*}），把它当通配符会让
     * 「任意字符」被展开成「任意字符」之外的语义，
     * 结果是这类正则一条都匹配不上，而且没有任何报错。
     */
    static boolean matchOne(String pattern, String url) {
        if (pattern == null || pattern.isEmpty()) return false;
        String p = pattern.trim();
        if (p.contains("://")) return matchPattern(p, url);
        try {
            return url.matches(p);
        } catch (Exception e) {
            return false;   // 正则写错不该让整个浏览器崩
        }
    }

    /**
     * {@code @match} 模式的通配匹配。
     *
     * <p>逐字符扫一遍做正则转义，而不是用一串 {@code replace} 链：
     * 链式替换的顺序稍有差池就会把 {@code .} 转义和 {@code .*} 展开搅在一起
     * （{@code *://*.x.com/*} 与 {@code *://x.com/*} 必须给出不同结果，
     * 而前者里的 {@code .} 是字面点、后者展开出来的点是正则元字符）。
     * 显式分清「来自模式的部分」和「我们插入的部分」，就没有这类坑。
     */
    static boolean matchPattern(String pattern, String url) {
        if (pattern == null || url == null) return false;
        String p = pattern.trim();
        if (p.isEmpty()) return false;
        StringBuilder sb = new StringBuilder("^");
        for (int i = 0; i < p.length(); i++) {
            char c = p.charAt(i);
            if (c == '*') {
                sb.append(".*");
            } else if (c == '?') {
                // @match 允许 ? 匹配任意单个字符，包括 /
                sb.append('.');
            } else {
                // 逐字符 escape，不能用 Pattern.quote：
                // 它把整段包成 \Q…\E，逐字符调用会把每个字符都包一次，
                // 拼出来是 \Qh\E\Qt\E\Qt\E 这种东西，一条 URL 都匹配不上。
                // 而 matchPattern 失败的表现是「所有 @match 全部静默失效」——
                // 脚本装了、列表里能看到、就是不跑，没有任何报错。
                if ("\\.[]{}()+-^$|?".indexOf(c) >= 0) sb.append('\\');
                sb.append(c);
            }
        }
        sb.append('$');
        try {
            return url.matches(sb.toString());
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 生成注入用的代码包：把 {@code @require} 的依赖与 {@code GM_} 垫片一并放进去。
     *
     * <p>结构如下（{@code __g} 那一段只在脚本确实用到了垫片接口时才出现）：
     * <pre>
     * (function(){var __g=(function(){ ...三个接口的定义... })();
     * (function(GM_addStyle,unsafeWindow){
     * try{
     *   ...require 依赖...
     *   ...脚本正文...
     * }catch(e){console.error('[Nova插件]',e);}
     * })(__g.addStyle,window);})();
     * </pre>
     *
     * <p>外层那一圈不是为了好看：实参 {@code __g.addStyle} 是在内层函数体
     * <b>之外</b>求值的，所以 {@code __g} 必须先存在于外层作用域。
     * 把它定义在内层（与形参同一层）会直接抛
     * {@code ReferenceError: __g is not defined}，而脚本正文被 try 包着，
     * 报错连页面控制台都进不去 —— 表现只是「脚本装上了一点动静都没有」。
     *
     * <p>接口走形参而不是挂在 {@code window} 上，理由见 {@link GmShim} 的注释。
     * 没有任何受支持声明的脚本（绝大多数，含内置那条）拿到的输出与
     * 加垫片之前<b>逐字节一致</b>。
     */
    public static String buildInject(Installed script, String requireBodies) {
        List<String> params = new ArrayList<>();
        List<String> args = new ArrayList<>();
        boolean usesShim = GmShim.collect(script == null ? null : script.meta, params, args);

        StringBuilder sb = new StringBuilder(
            512 + (script == null || script.body == null ? 0 : script.body.length()));
        if (usesShim) {
            sb.append("(function(){var __g=(function(){")
                .append(GmShim.SHIM_BODY).append("})();");
        }
        sb.append("(function(").append(String.join(",", params)).append("){\n");
        sb.append("try{\n");
        if (requireBodies != null && !requireBodies.isEmpty()) {
            sb.append(requireBodies).append('\n');
        }
        sb.append(script == null ? "" : script.body);
        sb.append("\n}catch(e){console.error('[Nova插件]',e);}\n");
        sb.append("})(").append(String.join(",", args)).append(");");
        if (usesShim) sb.append("})();");
        sb.append('\n');
        return sb.toString();
    }

    /** 汇总要注入的代码。多脚本按 id 排序，保证同一组脚本每次注入顺序一致。 */
    public static String buildInjectAll(List<Installed> scripts, String url,
                                        java.util.Map<String, String> requireBodies) {
        List<Installed> hit = new ArrayList<>();
        for (Installed s : scripts) {
            if (appliesTo(s, url)) hit.add(s);
        }
        if (hit.isEmpty()) return "";

        // 按 id 排序，保证同一组脚本每次注入顺序一致（脚本之间可能有先后依赖）。
        //
        // 排序必须作用在脚本列表本身。早先的写法是先排一个 id 列表，再拿它去原列表
        // 里逐项找匹配并 break —— 一旦有两个脚本 id 相同（同 namespace + name
        // 但内容不同就会这样），外层会遍历两次同样的 id、内层每次都命中同一个
        // 元素：于是其中一个被注入两次，另一个永远不会被注入，全程没有任何报错，
        // 表现只是「装了两个，只跑了一个」。
        hit.sort((a, b) -> a.id.compareTo(b.id));

        StringBuilder sb = new StringBuilder();
        for (Installed s : hit) {
            String requires = requireBodies == null ? null : requireBodies.get(s.id);
            sb.append(buildInject(s, requires));
        }
        return sb.toString();
    }

    /** 脚本 id：优先用 namespace+name，没有就退到内容摘要 —— 要稳定，装一次之后 ID 不变。 */
    public static String idOf(Meta meta, String body) {
        String basis = (meta.namespace == null ? "" : meta.namespace.trim()) + "|"
            + (meta.name == null ? "" : meta.name.trim());
        basis = basis.replaceAll("\\s+", "_");
        if (basis.length() > 2 && !basis.equals("|_")) return basis;
        return "script_" + Integer.toHexString((body == null ? "" : body).hashCode());
    }
}