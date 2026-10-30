package top.wuai.nova;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;

/**
 * 移动版的落盘层：设置读写、会话保存、assets 同步资产加载。
 *
 * <p>刻意独立成类，是因为这一层是<b>唯一能在纯 JVM 里测的部分</b> ——
 * 界面、WebView、生命周期都离不开 Android 框架，而读写键值和解析文本行不需要。
 * 把能测的留在能测的地方，测试才不是摆设。
 */
public final class NovaStore {

    /**
     * SharedPreferences 文件名。设为 public 是因为 {@code MainActivity.attachBaseContext}
     * 要在加载完整设置之前单独读一个主题键 —— 那个时机比 onCreate 还早，
     * 不能走 {@link #load()}。写死一份字符串的话，改名时两边会悄悄不一致。
     */
    public static final String PREFS = "nova";
    private static final String K_TABS = "session.tabs";
    private static final String K_ACTIVE = "session.active";

    private final Context ctx;
    private final SharedPreferences prefs;
    private final BookmarkStore bookmarkStore;
    private final HistoryStore historyStore;

    public NovaStore(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.prefs = this.ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.bookmarkStore = new BookmarkStore(this.ctx.getFilesDir());
        this.historyStore = new HistoryStore(this.ctx.getFilesDir());
    }

    // ---------------------------------------------------------------- 设置

    public NovaSettings load() {
        Map<String, String> m = new HashMap<>();
        for (Map.Entry<String, ?> e : prefs.getAll().entrySet()) {
            String k = e.getKey();
            if (!k.startsWith(NovaSettings.KEY)) continue;
            Object v = e.getValue();
            m.put(k.substring(NovaSettings.KEY.length()), v == null ? "" : String.valueOf(v));
        }
        return NovaSettings.fromMap(m);
    }

    public void save(NovaSettings s) {
        SharedPreferences.Editor ed = prefs.edit();
        for (Map.Entry<String, String> e : s.toMap().entrySet()) {
            ed.putString(NovaSettings.KEY + e.getKey(), e.getValue());
        }
        ed.apply();
    }

    // ------------------------------------------------------------ 会话恢复

    /**
     * 存会话。
     *
     * <p>存 URL 列表而不是存 WebView 内部状态：要恢复得准就得连滚动位置都存，
     * 那要走 {@code saveState}，而它对多标签的支持并不靠谱（要么丢，要么只在同一进程内有效）。
     * URL 列表足够把用户带回原处，滚动位置丢了就丢了 —— 这是明确的取舍，不是省事。
     */
    public void saveSession(List<String> urls, int active) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < urls.size(); i++) {
            if (i > 0) sb.append('\n');
            sb.append(urls.get(i));
        }
        prefs.edit().putString(K_TABS, sb.toString()).putInt(K_ACTIVE, active).apply();
    }

    public List<String> loadSession() {
        List<String> out = new ArrayList<>();
        String raw = prefs.getString(K_TABS, "");
        if (raw == null || raw.isEmpty()) return out;
        for (String line : raw.split("\n")) {
            String u = line.trim();
            if (!u.isEmpty()) out.add(u);
        }
        return out;
    }

    public int loadActive() {
        return prefs.getInt(K_ACTIVE, 0);
    }

    // ------------------------------------------------------- 同步资产加载

    /**
     * 读 assets 里的文本行。
     *
     * <p>编码必须显式给 UTF-8：{@code InputStreamReader} 不给编码时会用平台默认。
     * 而「已跳过 N 条」这个数字恰恰藏在中文注释里，乱码会让它读不回来 ——
     * 那是一个只有肉眼能发现的静默错误。
     */
    public static List<String> readAssetLines(Context ctx, String name) throws IOException {
        List<String> out = new ArrayList<>();
        try (InputStream in = ctx.getAssets().open(name);
             BufferedReader r = new BufferedReader(
                 new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) out.add(line);
        }
        return out;
    }

    public String readAssetText(String name) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (String line : readAssetLines(ctx, name)) sb.append(line).append('\n');
        return sb.toString();
    }

    /**
     * 加载移动版的两份同步资产。
     *
     * <p>读失败<b>不抛</b>，而是返回一个 {@code loaded()} 为 false 的注册表，
     * 由界面把原因显示出来。浏览器因为一个名单文件读不到就打不开，比「功能少一点」糟糕得多。
     *
     * <p>失败时的兜底是<b>空表</b>，不是内置兜底名单：媒体表空了只剩最高档失效，
     * 域名表空了等于不拦。宁可功能少一点也不自己编一份顶上 ——
     * 那种「兜底名单」会悄悄变成第二份真相，之后没人知道哪份在生效。
     */
    public MediaRegistry loadMediaRegistry() {
        List<String> mediaLines = null;
        List<String> hostLines = null;
        StringBuilder errs = new StringBuilder();
        try {
            mediaLines = readAssetLines(ctx, MediaRegistry.MEDIA_ASSET);
        } catch (Exception e) {
            errs.append(MediaRegistry.MEDIA_ASSET).append(" 读取失败");
        }
        try {
            hostLines = readAssetLines(ctx, MediaRegistry.ADBLOCK_ASSET);
        } catch (Exception e) {
            if (errs.length() > 0) errs.append("；");
            errs.append(MediaRegistry.ADBLOCK_ASSET).append(" 读取失败");
        }

        HashSet<String> media = mediaLines == null
            ? new HashSet<>() : new HashSet<>(MediaRegistry.parseMediaExts(mediaLines));
        MediaRegistry.Hosts hosts = hostLines == null
            ? new MediaRegistry.Hosts() : MediaRegistry.parseAdblockHosts(hostLines);

        // 用户订阅与内置表并存。订阅读失败就当没有 —— 内置那份还在工作，
        // 而因为订阅坏了就整个不拦，比不订阅更糟。
        java.util.Set<String> user = loadUserRules();

        return new MediaRegistry(media, hosts.hosts, hosts.skipped, errs.toString(),
            user, rulesSourceLabel(), rulesStamp());
    }

    // ------------------------------------------------- 拦截规则：订阅与更新

    private static final String K_RULES_STAMP = "rules.stamp";
    private static final String K_RULES_URL = "rules.url";
    private static final String K_RULES_SOURCE = "rules.source";
    private static final String K_RULES_UNSUPPORTED = "rules.unsupported";
    /**
     * 订阅写入的机器可读时间（epoch 毫秒）。
     *
     * <p>{@link #rulesStamp()} 是给人看的「yyyy-MM-dd HH:mm」，拿它算过期
     * 要反向解析，Locale 一改格式就可能变 —— 判断 staleness 必须用机器格式。
     * 写入时机就是保存成功的时刻，不额外传参：保存即更新。
     */
    private static final String K_RULES_AT = "rules.at";
    /** 用户订阅的规则。放 filesDir 而不是 assets：assets 打包后只读，更新不了。 */
    private static final String RULES_FILE = "rules-user.txt";

    public String rulesStamp() { return prefs.getString(K_RULES_STAMP, ""); }
    public String rulesUrl() { return prefs.getString(K_RULES_URL, ""); }
    public int rulesUnsupported() { return prefs.getInt(K_RULES_UNSUPPORTED, 0); }
    /** 订阅上次成功写入的时刻；从未订阅过返回 0。 */
    public long rulesUpdatedAt() { return prefs.getLong(K_RULES_AT, 0L); }

    /** 订阅来源的名字，只用于界面显示（「当前：EasyList」）。 */
    public String rulesSourceLabel() { return prefs.getString(K_RULES_SOURCE, ""); }

    public boolean hasUserRules() {
        java.io.File f = new java.io.File(ctx.getFilesDir(), RULES_FILE);
        return f.exists() && f.length() > 0;
    }

    /**
     * 读用户订阅的域名集合。没有就返回 null，让调用方继续用内置的。
     *
     * <p>刻意返回 null 而不是空集合：空集合和「没订阅」在效果上一样（都不拦），
     * 但在语义上完全不同，界面要显示不同的说明。
     */
    public java.util.Set<String> loadUserRules() {
        try {
            java.io.File f = new java.io.File(ctx.getFilesDir(), RULES_FILE);
            if (!f.exists() || f.length() == 0) return null;
            return new HashSet<>(RuleSet.parse(readLines(f)).hosts);
        } catch (Exception e) {
            return null;
        }
    }

    /** 落盘订阅结果。返回 false 表示写失败（磁盘满/权限），调用方要报错不能装作成功。 */
    public boolean saveUserRules(java.util.Set<String> hosts, String url, String label,
                                 int unsupported, String stamp) {
        java.io.File f = new java.io.File(ctx.getFilesDir(), RULES_FILE);
        java.io.File tmp = new java.io.File(ctx.getFilesDir(), RULES_FILE + ".tmp");
        try {
            writeLines(tmp, RuleSet.toLines(hosts, stamp, url, unsupported));
            // 先写临时文件再改名：写一半断电时不会把原来那份好规则弄成半截。
            if (f.exists() && !f.delete()) return false;
            if (!tmp.renameTo(f)) {
                tmp.delete();
                return false;
            }
            prefs.edit()
                .putString(K_RULES_URL, url == null ? "" : url)
                .putString(K_RULES_SOURCE, label == null ? "" : label)
                .putString(K_RULES_STAMP, stamp == null ? "" : stamp)
                .putInt(K_RULES_UNSUPPORTED, unsupported)
                .putLong(K_RULES_AT, System.currentTimeMillis())
                .apply();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    public void clearUserRules() {
        java.io.File f = new java.io.File(ctx.getFilesDir(), RULES_FILE);
        if (f.exists()) f.delete();
        prefs.edit().remove(K_RULES_URL).remove(K_RULES_SOURCE)
            .remove(K_RULES_STAMP).remove(K_RULES_UNSUPPORTED).remove(K_RULES_AT)
            .apply();
    }

    // ------------------------------------------------------------ 用户脚本

    private static final String K_SCRIPTS = "scripts.index";

    /**
     * 读已装脚本列表。
     *
     * <p>元数据存 SharedPreferences，正文存成 {@code filesDir/scripts/<id>.js}。
     * 分开存是因为正文可能有几百 KB，塞进 SharedPreferences 会让每次读写都
     * 把那一大块 JSON 反复解析一遍，而且单条损坏就整个列表都没了。
     */
    public java.util.List<UserScript.Installed> loadScripts() {
        java.util.List<UserScript.Installed> out = new ArrayList<>();
        String raw = prefs.getString(K_SCRIPTS, "");
        if (raw == null || raw.isEmpty()) return out;
        java.io.File dir = scriptsDir();
        if (!dir.exists()) return out;
        for (String line : raw.split("\n")) {
            String id = line.trim();
            if (id.isEmpty()) continue;
            java.io.File meta = new java.io.File(dir, id + ".meta");
            java.io.File body = new java.io.File(dir, id + ".js");
            if (!meta.exists() || !body.exists()) continue;   // 悬空索引，跳过
            try {
                UserScript.Meta m = metaFrom(readLines(meta));
                String b = readText(body);
                out.add(new UserScript.Installed(id, m, b, meta.lastModified(),
                    "本机安装"));
            } catch (Exception ignored) {
                // 单个脚本读坏不该让整个列表空掉
            }
        }
        return out;
    }

    /** 保存（覆盖）一个脚本。ID 相同视为更新。 */
    public boolean saveScript(UserScript.Installed s) {
        java.io.File dir = scriptsDir();
        if (!dir.exists() && !dir.mkdirs()) return false;
        try {
            writeLines(new java.io.File(dir, s.id + ".meta"), metaTo(s.meta));
            writeText(new java.io.File(dir, s.id + ".js"), s.body);
            java.util.List<String> index = new java.util.ArrayList<>();
            for (UserScript.Installed x : loadScripts()) index.add(x.id);
            if (!index.contains(s.id)) index.add(s.id);
            StringBuilder sb = new StringBuilder();
            for (String id : index) {
                if (sb.length() > 0) sb.append('\n');
                sb.append(id);
            }
            prefs.edit().putString(K_SCRIPTS, sb.toString()).apply();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** 记录启停状态。只改索引行不动文件 —— 启停是高频操作，不该重写整个脚本。 */
    public void setScriptEnabled(String id, boolean enabled) {
        java.io.File dir = scriptsDir();
        java.io.File meta = new java.io.File(dir, id + ".meta");
        if (!meta.exists()) return;
        try {
            java.util.List<String> lines = readLines(meta);
            java.util.List<String> out = new ArrayList<>();
            boolean replaced = false;
            for (String l : lines) {
                if (l.trim().startsWith("#enabled:")) {
                    out.add("#enabled:" + (enabled ? "1" : "0"));
                    replaced = true;
                } else {
                    out.add(l);
                }
            }
            // 元数据里没有这一行（比如老版本写的文件）：补上，
            // 否则这次「停用」会被静默丢掉，开关按了没反应。
            if (!replaced) out.add(1, "#enabled:" + (enabled ? "1" : "0"));
            writeLines(meta, out);
        } catch (Exception ignored) {
            // 启停失败下次打开会丢一次状态，不致命
        }
    }

    public void removeScript(String id) {
        java.io.File dir = scriptsDir();
        new java.io.File(dir, id + ".meta").delete();
        new java.io.File(dir, id + ".js").delete();
        try {
            String raw = prefs.getString(K_SCRIPTS, "");
            if (raw == null) return;
            java.util.List<String> keep = new ArrayList<>();
            for (String line : raw.split("\n")) {
                String t = line.trim();
                if (!t.isEmpty() && !t.equals(id)) keep.add(t);
            }
            StringBuilder sb = new StringBuilder();
            for (String t : keep) {
                if (sb.length() > 0) sb.append('\n');
                sb.append(t);
            }
            prefs.edit().putString(K_SCRIPTS, sb.toString()).apply();
        } catch (Exception ignored) {
            // 同上
        }
    }

    private java.io.File scriptsDir() {
        return new java.io.File(ctx.getFilesDir(), "scripts");
    }

    // -------------------------------------------------------- 内置脚本播种

    /**
     * 内置脚本的播种记录，{@code key=id} 一行一条。
     *
     * <p>记的是「播种过」，不是「当前装着」。这个差别很要紧：若按「当前装着」
     * 判断，用户卸载完下次启动又会被装回来，那个卸载按钮就成了摆设。
     *
     * <p>与已装列表分开存，是因为它会比列表活得久 —— 卸载会把脚本从
     * {@link #K_SCRIPTS} 里摘掉，但这里那行必须留着。
     */
    private static final String K_BUILTIN = "scripts.builtin";

    /** 这个内置项播种过了吗？是则返回当时装上去的脚本 id，没播种过返回 null。 */
    public String builtinSeededId(String key) {
        if (key == null || key.isEmpty()) return null;
        for (String line : seededLines()) {
            int i = line.indexOf('=');
            if (i > 0 && line.substring(0, i).equals(key)) return line.substring(i + 1);
        }
        return null;
    }

    /** 记下某个内置项已播种，连同它当时的脚本 id。 */
    public void markBuiltinSeeded(String key, String id) {
        if (key == null || key.isEmpty() || id == null || id.isEmpty()) return;
        java.util.List<String> out = new ArrayList<>();
        boolean replaced = false;
        for (String line : seededLines()) {
            int i = line.indexOf('=');
            if (i > 0 && line.substring(0, i).equals(key)) {
                out.add(key + "=" + id);
                replaced = true;
            } else {
                out.add(line);
            }
        }
        if (!replaced) out.add(key + "=" + id);
        StringBuilder sb = new StringBuilder();
        for (String t : out) {
            if (sb.length() > 0) sb.append('\n');
            sb.append(t);
        }
        prefs.edit().putString(K_BUILTIN, sb.toString()).apply();
    }

    /** 读播种记录，返回 {@code key=id} 行列表。 */
    private java.util.List<String> seededLines() {
        java.util.List<String> out = new ArrayList<>();
        String raw = prefs.getString(K_BUILTIN, "");
        if (raw == null || raw.isEmpty()) return out;
        for (String line : raw.split("\n")) {
            String t = line.trim();
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }

    // ------------------------------------------------------ 新标签页快捷方式

    /**
     * 用户自己加的快捷方式，{@code 名称<TAB>网址} 一行一条。
     *
     * <p>与「按访问次数自动填的那些」分开存，是因为它们的语义不同：
     * 自动的是**候选**（可以随时间被挤掉），用户加的是**他明确要的**（不该自己消失）。
     * 混在一起的后果是用户加的第七个磁贴，某天被一个访问次数更高的站点顶掉了。
     */
    private static final String K_NTP_ADDED = "ntp.shortcut.added";

    /**
     * 用户点掉过的站点，一行一个**归一化主机名**（见 {@link NewTab#hostKey}）。
     *
     * <p>这一份必须单独留着：历史记录不会因为用户在新标签页上点了个 × 就把那几条删掉，
     * 不记下来的话，下次生成候选时那家站点立刻又爬回来 ——
     * 用户的感受是「这个 × 是假的」。
     */
    private static final String K_NTP_REMOVED = "ntp.shortcut.removed";

    private static java.util.List<String> linesOf(String raw) {
        java.util.List<String> out = new ArrayList<>();
        if (raw == null || raw.isEmpty()) return out;
        for (String line : raw.split("\n")) {
            String t = line.trim();
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }

    private static String joinLines(java.util.List<String> lines) {
        StringBuilder sb = new StringBuilder();
        for (String t : lines) {
            if (sb.length() > 0) sb.append('\n');
            sb.append(t);
        }
        return sb.toString();
    }

    /** 用户自己加（或固定）的快捷方式，按加入顺序。 */
    public java.util.List<NewTab.Row> ntpAdded() {
        java.util.List<NewTab.Row> out = new ArrayList<>();
        for (String line : linesOf(prefs.getString(K_NTP_ADDED, ""))) {
            int tab = line.indexOf('\t');
            // 只有网址没有名称的行也认（名称让页面退回域名），
            // 但整行没有制表符说明这条记录是坏的，跳过
            if (tab < 0) continue;
            String label = line.substring(0, tab).trim();
            String url = line.substring(tab + 1).trim();
            if (url.isEmpty()) continue;
            out.add(new NewTab.Row(label, url, 0, true));
        }
        return out;
    }

    /** 用户点掉过的站点（归一化主机名）。 */
    public java.util.Set<String> ntpRemoved() {
        return new java.util.LinkedHashSet<>(linesOf(prefs.getString(K_NTP_REMOVED, "")));
    }

    /**
     * 加一条快捷方式。
     *
     * <p>顺手把这个站点的「已被移除」记录清掉 —— 用户先删后加同一个站点时，
     * 不清的话它会被自己的历史挡在门外，表现是「加了但没出现」。
     */
    public void ntpAdd(String label, String url) {
        if (url == null || url.isEmpty()) return;
        String name = NewTab.sanitize(label);
        if (name.isEmpty()) name = NewTab.hostKey(url);

        java.util.List<String> lines = linesOf(prefs.getString(K_NTP_ADDED, ""));
        java.util.List<String> out = new ArrayList<>();
        String key = NewTab.hostKey(url);
        for (String line : lines) {
            int tab = line.indexOf('\t');
            String u = tab < 0 ? "" : line.substring(tab + 1).trim();
            // 同一家站点只留一条：页面上本来就是按主机名去重的，
            // 这里不去的话，存储里会攒下一堆永远不会显示的重复项
            if (!u.isEmpty() && NewTab.hostKey(u).equals(key)) continue;
            out.add(line);
        }
        out.add(name + "\t" + url);

        java.util.List<String> removed = new ArrayList<>(ntpRemoved());
        removed.remove(key);
        prefs.edit()
            .putString(K_NTP_ADDED, joinLines(out))
            .putString(K_NTP_REMOVED, joinLines(removed))
            .apply();
    }

    /**
     * 点掉一个磁贴。返回是否真的改动了什么。
     *
     * <p>两条路都要走：从「自己加的」里摘掉（如果本来就在里面），
     * 并且把这个主机名记进「已被移除」。只做前者的话，一个既在历史里、
     * 又被用户加过的站点会立刻从历史那边回来。
     */
    public boolean ntpRemove(String url) {
        if (url == null || url.isEmpty()) return false;
        String key = NewTab.hostKey(url);

        java.util.List<String> lines = linesOf(prefs.getString(K_NTP_ADDED, ""));
        java.util.List<String> out = new ArrayList<>();
        boolean hit = false;
        for (String line : lines) {
            int tab = line.indexOf('\t');
            String u = tab < 0 ? "" : line.substring(tab + 1).trim();
            if (!u.isEmpty() && NewTab.hostKey(u).equals(key)) {
                hit = true;
                continue;
            }
            out.add(line);
        }

        java.util.List<String> removed = new ArrayList<>(ntpRemoved());
        if (!key.isEmpty() && !removed.contains(key)) {
            removed.add(key);
            hit = true;
        }
        if (!hit) return false;

        prefs.edit()
            .putString(K_NTP_ADDED, joinLines(out))
            .putString(K_NTP_REMOVED, joinLines(removed))
            .apply();
        return true;
    }

    // ------------------------------------------------------- 元数据的文本形态

    /**
     * 脚本元数据落成纯文本行，和设置那一套保持同一风格。
     *
     * <p>不引 JSON：这里全是字符串列表，一行一条最省事，也不用给框架的
     * {@code org.json} 打桩来跑单测。
     */
    static java.util.List<String> metaTo(UserScript.Meta m) {
        java.util.List<String> out = new ArrayList<>();
        out.add("#meta");
        // 启停位必须跟着 meta 里的真值落盘。原先这里写死成 "#enabled:1"，
        // 于是「停用一个脚本」存下去再读回来永远又是启用的 ——
        // 而界面上那个开关看起来是正常工作的，只是每次重开都白按一次。
        out.add("#enabled:" + (m.enabledFlag ? "1" : "0"));
        out.add("@name=" + m.name);
        out.add("@namespace=" + m.namespace);
        out.add("@version=" + m.version);
        out.add("@description=" + m.description);
        out.add("@homepage=" + m.homepage);
        out.add("@icon=" + m.icon);
        out.add("@run-at=" + m.runAt);
        for (String x : m.match) out.add("@match=" + x);
        for (String x : m.include) out.add("@include=" + x);
        for (String x : m.exclude) out.add("@exclude=" + x);
        for (String x : m.require) out.add("@require=" + x);
        for (String x : m.grants) out.add("@grant=" + x);
        return out;
    }

    static UserScript.Meta metaFrom(java.util.List<String> lines) {
        UserScript.Meta m = new UserScript.Meta();
        boolean enabled = true;
        final String flag = "#enabled:";
        for (String raw : lines) {
            String l = raw == null ? "" : raw.trim();
            if (l.startsWith(flag)) {
                // 偏移用常量长度，不写死数字。
                // 写死 8 会越过冒号取到 ":0"，于是 "#enabled:1" 被判成 false ——
                // 于是「启用」永远存成「停用」，界面上那个开关等于坏了。
                enabled = "1".equals(l.substring(flag.length()).trim());
                continue;
            }
            int eq = l.indexOf('=');
            if (eq < 0) continue;
            String k = l.substring(0, eq);
            String v = l.substring(eq + 1);
            switch (k) {
                case "@name": m.name = v; break;
                case "@namespace": m.namespace = v; break;
                case "@version": m.version = v; break;
                case "@description": m.description = v; break;
                case "@homepage": m.homepage = v; break;
                case "@icon": m.icon = v; break;
                case "@run-at": m.runAt = v; break;
                case "@match": m.match.add(v); break;
                case "@include": m.include.add(v); break;
                case "@exclude": m.exclude.add(v); break;
                case "@require": m.require.add(v); break;
                case "@grant": m.grants.add(v); break;
                default: break;
            }
        }
        m.enabledFlag = enabled;
        return m;
    }

    // ------------------------------------------------------------ 文件小工具

    static java.util.List<String> readLines(java.io.File f) throws IOException {
        java.util.List<String> out = new ArrayList<>();
        try (java.io.BufferedReader r = new java.io.BufferedReader(
            new java.io.InputStreamReader(new java.io.FileInputStream(f),
                StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) out.add(line);
        }
        return out;
    }

    static String readText(java.io.File f) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (String l : readLines(f)) sb.append(l).append('\n');
        return sb.toString();
    }

    static void writeLines(java.io.File f, java.util.List<String> lines) throws IOException {
        java.io.File parent = f.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("无法创建目录：" + parent);
        }
        try (java.io.OutputStream out = new java.io.FileOutputStream(f, false)) {
            for (String l : lines) {
                out.write(l.getBytes(StandardCharsets.UTF_8));
                out.write('\n');
            }
        }
    }

    static void writeText(java.io.File f, String text) throws IOException {
        java.io.File parent = f.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("无法创建目录：" + parent);
        }
        try (java.io.OutputStream out = new java.io.FileOutputStream(f, false)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    // ---------------------------------------------------------------- 其他

    /** 清掉全部落盘数据。设置页的「清除数据」用它。 */
    public void clearAll() {
        java.io.File f = new java.io.File(ctx.getFilesDir(), RULES_FILE);
        if (f.exists()) f.delete();
        bookmarkStore.clear();
        historyStore.clear();
        java.io.File sd = scriptsDir();
        java.io.File[] kids = sd.listFiles();
        if (kids != null) {
            for (java.io.File k : kids) k.delete();
        }
        prefs.edit().clear().apply();
    }

    // ---------------------------------------------------------- 书签 / 收藏

    /** 书签委托给纯存储类，自己不碰文件细节（也方便单测）。 */
    public List<BookmarkStore.Bookmark> bookmarks() {
        return bookmarkStore.list();
    }

    /** 当前 url 是否已被收藏。 */
    public boolean isBookmarked(String url) {
        return bookmarkStore.isBookmarked(url);
    }

    /**
     * 收藏一条。已存在（同 url）则不动，避免重复。
     * 返回是否是「新加的」—— 调用方靠这个决定弹「已收藏」还是「已取消收藏」。
     */
    public boolean addBookmark(String url, String title) {
        return bookmarkStore.add(url, title);
    }

    /** 取消收藏。按 url 删（一个 url 只会有一条）。 */
    public void removeBookmark(String url) {
        bookmarkStore.remove(url);
    }

    /**
     * 批量收藏（导入用）。一次落盘，返回真正新增的条数。
     * 与 {@link #addBookmark} 的区别只在性能与去重范围：这里同批内的重复也一并吃掉。
     */
    public int addBookmarks(List<BookmarkStore.Draft> items) {
        return bookmarkStore.addAll(items);
    }

    /** 清空全部书签。 */
    public void clearBookmarks() {
        bookmarkStore.clear();
    }

    // ------------------------------------------------------------ 浏览历史

    /** 历史同样委托给纯存储类。按最近访问倒序。 */
    public List<HistoryStore.Entry> history() {
        return historyStore.list();
    }

    /** 按关键字搜历史（标题或网址命中），空关键字等于列出全部。 */
    public List<HistoryStore.Entry> searchHistory(String keyword) {
        return historyStore.search(keyword);
    }

    /**
     * 记一次访问。
     *
     * <p>该不该记由调用方决定（无痕模式不该记），这里只管落盘。
     * 返回是否真的记下了 —— {@code about:blank}、{@code file://}
     * 这些不入历史，见 {@link HistoryStore#recordable}。
     */
    public boolean recordHistory(String url, String title) {
        return historyStore.record(url, title);
    }

    /** 删掉历史里的某一条。 */
    public void removeHistory(String url) {
        historyStore.remove(url);
    }

    /** 清空全部历史。 */
    public void clearHistory() {
        historyStore.clear();
    }
}