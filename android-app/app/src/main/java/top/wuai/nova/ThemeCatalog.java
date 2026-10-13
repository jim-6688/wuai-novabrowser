package top.wuai.nova;

import java.util.Locale;

/**
 * 吾爱Nova浏览器 · 主题配色目录。
 *
 * <p>主题与「深浅模式」正交：深浅决定明暗（走系统 uiMode），主题决定主色相。
 * 每套主题都有浅色、深色两种表现（主色不变，只是背景变深），所以这里只存
 * 「主色（brand）+ 强调色（accent）」两个色值 —— 它们不随深浅变。
 *
 * <p>为什么色值硬编码在这里而不是 {@code colors.xml}：主题要能运行时切换
 * （换主题不必重装应用、也不必走 {@code values-*} 资源限定符），而
 * {@code @color} 是编译期固定的。把每套主题的三原色写进枚举，运行时按 id
 * 取色、动态染到界面上，是最简单也最不易漏的方式。
 *
 * <p>主色用于「品牌强调」——底栏主按钮、分段选中态、胶囊描边、状态栏；
 * 强调色用于「次级强调」——刷新/分享等动作图标、AI 图标的渐变终点。
 */
public final class ThemeCatalog {

    /** 一套主题：唯一 id、显示名、主色、深主色、强调色。 */
    public static final class Theme {
        public final String id;
        public final String name;
        public final int brand;       // 主色，argb
        public final int brandStrong; // 主色的深一档（按压/状态栏深色用）
        public final int accent;      // 强调色，argb

        Theme(String id, String name, int brand, int brandStrong, int accent) {
            this.id = id;
            this.name = name;
            this.brand = brand;
            this.brandStrong = brandStrong;
            this.accent = accent;
        }
    }

    /**
     * 五套主题。顺序即设置页里的展示顺序，第一套是默认。
     *
     * <p>色值选择上刻意拉开色相：蓝、青、紫、橙、再加上一套纯黑 AMOLED
     * （黑底省电，主色仍用蓝点缀）。每套的深主色都比主色低 10~15% 亮度，
     * 保证状态栏深色与主色层次分明。
     */
    public static final Theme[] ALL = {
        new Theme("blue",    "默认蓝", 0xFF3D6BFF, 0xFF2E56D9, 0xFF00B8A2),
        new Theme("teal",    "青绿",   0xFF00B8A2, 0xFF009C8B, 0xFF3D6BFF),
        new Theme("purple",  "粉紫",   0xFF8B5CF6, 0xFF7C3AED, 0xFFEC4899),
        new Theme("orange",  "暖橙",   0xFFF97316, 0xFFEA580C, 0xFFF59E0B),
        new Theme("amoled",  "纯黑",   0xFF3D6BFF, 0xFF2E56D9, 0xFF00B8A2),
    };

    /** 默认主题（蓝色）。 */
    public static final String DEFAULT_ID = "blue";

    /** 按 id 取主题，取不到回落到默认蓝。 */
    public static Theme byId(String id) {
        if (id != null) {
            for (Theme t : ALL) {
                if (t.id.equals(id)) return t;
            }
        }
        return ALL[0];
    }

    /** id 是否合法（用于反序列化校验）。 */
    public static boolean known(String id) {
        if (id == null) return false;
        for (Theme t : ALL) if (t.id.equals(id)) return true;
        return false;
    }

    /** 主色转成 {@code #AARRGGBB} 十六进制串，给新标签页传参用。 */
    public static String hex(Theme t) {
        return String.format(Locale.ROOT, "#%06X", t.brand & 0xFFFFFF);
    }
}
