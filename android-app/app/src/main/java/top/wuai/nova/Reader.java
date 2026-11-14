package top.wuai.nova;

/**
 * 吾爱Nova浏览器 · 移动版阅读模式（正文提取）。
 *
 * <p>算法复用桌面端 {@code src/renderer/shell.js} 里的 {@code READER_JS}：
 * 打分找出正文节点、克隆、剔除 script/iframe/nav 等噪音、再铺一层全屏阅读层。
 * 桌面那套本来就是「序列化成字符串注入页面」的形式，移动端注入同一段逻辑
 * （见 {@code assets/reader.inject.js}），只改回传格式以适配 Android。
 *
 * <h3>为什么状态不用 JSON 传</h3>
 *
 * <p>同 {@link AutoPage}：{@code evaluateJavascript} 的返回值会被 JSON 编码一次，
 * 且本地单测里 {@code org.json} 会抛 {@code Stub!}。这里让页面侧拼一个 {@code ~} 分隔的紧凑串，
 * Java 侧按位切分，文本字段里的 {@code ~} 由页面侧先替换掉。
 *
 * <h3>状态串格式</h3>
 *
 * <pre>{@code action~ok~title~length~reason}</pre>
 * <ul>
 *   <li>{@code action}：{@code on} 进入、{@code off} 退出、{@code none} 失败；</li>
 *   <li>{@code ok}：{@code 1} 成功、{@code 0} 失败；</li>
 *   <li>{@code title}：提取到的标题（页面侧已把 {@code ~} 换成 {@code /}）；</li>
 *   <li>{@code length}：正文字数；</li>
 *   <li>{@code reason}：失败原因（{@code no-content} 等），成功时为空。</li>
 * </ul>
 */
public final class Reader {

    public static final String ASSET = "reader.inject.js";

    private Reader() {}

    /** 解析页面侧回传的状态串。页面没注入、脚本抛错、返回 null —— 统统当成「没有状态」。 */
    public static Status parseStatus(String raw) {
        String s = AutoPage.unwrapJsString(raw);
        if (s.isEmpty()) return Status.EMPTY;
        String[] f = s.split("~", -1);
        if (f.length < 5) return Status.EMPTY;
        boolean ok = "1".equals(f[1].trim());
        int length;
        try {
            length = Integer.parseInt(f[3].trim());
        } catch (NumberFormatException e) {
            length = 0;
        }
        return new Status(f[0].trim(), ok, f[2], length, f[4]);
    }

    /** 页面侧回传的状态。 */
    public static final class Status {
        public final String action;
        public final boolean ok;
        public final String title;
        public final int length;
        public final String reason;

        public Status(String action, boolean ok, String title, int length, String reason) {
            this.action = action == null ? "" : action;
            this.ok = ok;
            this.title = title == null ? "" : title;
            this.length = length;
            this.reason = reason == null ? "" : reason;
        }

        public static final Status EMPTY = new Status("", false, "", 0, "");

        /** 给界面看的一句话。安静优先：失败才出声，成功只说一句。 */
        public String summary() {
            if (ok) return "已进入阅读模式";
            if ("off".equals(action)) return "已退出阅读模式";
            if ("no-content".equals(reason)) return "这个页面暂时无法提取正文";
            return "进入阅读模式失败：" + (reason.isEmpty() ? "未知原因" : reason);
        }

        /** 当前是否处于阅读模式（用于按钮文案切换）。 */
        public boolean isOn() { return ok && "on".equals(action); }
    }
}
