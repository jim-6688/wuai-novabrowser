# 吾爱Nova浏览器 · ProGuard 规则
#
# 本工程 minifyEnabled = false，这些规则当前不生效。
# 保留它们是为了将来打开混淆时不用从头踩坑 ——
# 而下面这几条正是「打开就一定会踩」的。

# 保留源文件名与行号：崩溃报告里没有它们就没法定位问题。
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# 拼页脚本通过 window.__novaAutoPage 交互，但注入的是 assets 里的 JS，
# 不涉及 Java 反射，所以这里不需要保留方法名。
#
# 需要保留的是这些纯数据类：它们被测试和跨类引用，
# 混淆掉字段名会让 toMap/fromMap 的键名对不上（键名是手写的字符串，不是反射）。
-keep class top.wuai.nova.NovaSettings { *; }
-keep class top.wuai.nova.AutoPage { *; }

# JUnit 单测不会进 release 包，所以这里不需要 test 相关规则。