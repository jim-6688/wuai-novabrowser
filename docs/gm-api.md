# 用户脚本特权接口（GM_ 家族）支持说明

本文说明吾爱Nova浏览器移动端对用户脚本 `GM_*` 接口的支持范围、实现方式、
以及**刻意不支持**的部分和原因。

对应实现：`GmShim.java`（接口定义与判定）、`UserScript.java`（注入结构）、
`GmShimTest.java`（19 条单测）。

---

## 1. 结论

**第一批（本文称为「第 0 档」）已经落地**：6 项不需要原生桥的接口。

| 接口 | 实现方式 |
|---|---|
| `GM_addStyle(css)` | 建 `<style>` 挂到 `document.head`，返回该元素 |
| `GM_addElement(tag, attrs, parent)` | 建元素、设属性、挂载；兼容 `GM_addElement(parent, tag, attrs)` 的三参形态 |
| `GM_log(...)` | 转发到 `console.log`，带 `[NovaGM]` 前缀 |
| `GM_info` | 对象字面量，含 `scriptHandler` 与 `script.{name,namespace,version,description,runAt,matches}` |
| `GM` | 命名空间对象，含 `addStyle` / `addElement` / `log` / `info`（篡改猴 4.11 起的写法） |
| `unsafeWindow` | 直接等于页面的 `window` |

**核心认知**：`GM_addStyle` 这些**不是内核能力**。Chromium / Android WebView
从来没有、也不打算提供它们 —— 它们是篡改猴这类用户脚本管理器自己用 JavaScript
加一层原生桥搭出来的门面。所以「引擎不支持 GM_」这句话本身不成立，
真正缺的只是**那层门面**。

于是「要不要支持」变成了「每一层门面要花多少代价」，答案分四档：

| 档 | 内容 | 需要什么 | 状态 |
|---|---|---|---|
| 0 | `GM_addStyle` / `GM_addElement` / `GM_log` / `GM_info` / `GM` / `unsafeWindow` | 一段 JavaScript 字符串 | **已实现** |
| 1 | `GM_setValue` / `getValue` / `deleteValue` / `listValues` / `GM_registerMenuCommand` / `GM_notification` | `addJavascriptInterface` 原生桥 + 按脚本隔离的存储命名空间 | 未做 |
| 2 | `GM_xmlhttpRequest` / `GM_download` / `GM_openInTab` / `@require` / `@resource` | 原生 HTTP 层（复用 `RuleUpdater` 的 `HttpURLConnection`）+ 手动灌 `CookieManager` 的 cookie + 目标站点白名单 | 未做 |
| 3 | `document-start` 注入、脚本隔离（isolated world） | `WebViewCompat.addDocumentStartJavaScript()` / `addWebMessageListener()`，需引入 `androidx.webkit` | 未做 |

---

## 2. 只给声明过的，不多给一项

实现严格按脚本自己的 `@grant` 发放接口：**没声明就拿不到**。
`@grant none` 或完全没有 `@grant` 行的脚本，一项也拿不到。

这不是抠门，是三条理由叠在一起：

1. **与篡改猴一致**。那边 `@grant none` 的脚本同样拿不到任何 `GM_` 函数，
   脚本作者正是按这个前提写代码的。给得比规范多，等于让脚本跑到一条
   它自己都没考虑过的路径上。
2. **让 `@grant` 保持有意义**。如果不管声明什么都发，安装时那句
   「声明了 N 项不支持的权限」就没法只说真话了。
3. **零回归**。改动之前一项都不发，所以这条规则对任何现有脚本都不会
   造成行为变化 —— 只有新声明了受支持接口的脚本，才会从「静默失败」
   变成「真的能用」。

第 3 条有硬证据：`GmShimTest.没声明受支持接口时输出与旧版逐字节一致`
把注入结果整体做成了字符串断言。内置的 `remove-web-limits` 写的是
`@grant none`，所以它拿到的代码与加垫片之前**完全相同**。

### 连带修正的一处误报

`UserScript.Meta.needsPrivilegeWarning()` 原来是 `!grants.isEmpty()` ——
凡有 `@grant` 就全警告。支持了第 0 档之后这就成了误报：一个只用
`GM_addStyle` 的脚本会被说成「声明了 1 项未支持的权限」。

现在改为 `GmShim.unsupported(grants)` 非空才警告，也就是**只警告确实缺的那些**。
`ScriptInstaller.Result.grants`（安装确认框里那句提示）同步改了 ——
它的字段注释本来就写着「但本引擎不提供的权限」，而之前装进去的是全量，
两边对不上。

---

## 3. 接口走形参，不挂 window

注入结构：

```js
(function(){var __g=(function(){ /* addStyle, addElement, log */ })();
(function(GM_addStyle,unsafeWindow){
try{
  /* @require 依赖 */
  /* 脚本正文 */
}catch(e){console.error('[Nova插件]',e);}
})(__g.addStyle,window);})();
```

接口是作为**实参**传进脚本作用域的，不是写成 `window.GM_addStyle`。三个理由：

- **不污染页面**。挂在 window 上等于往用户的每一个网页里塞几个全局变量，
  页面能看见、能改名、能拿去伪装成脚本的接口。篡改猴也是用参数传的。
- **脚本之间互不干扰**。同一次注入里多个脚本各自拿到自己那份，
  谁也没法改掉别人的。
- **特征检测仍然正确**。`typeof GM_xmlhttpRequest === 'function'`
  这种写法拿到的答案是真的 —— 没声明过的接口就是不存在，
  写得好的脚本会自己走降级分支。

### 外层那一圈不能省

`__g` 必须定义在**内层函数之外**。实参 `__g.addStyle` 是在内层函数体
之外求值的，定义在内层（与形参同一层）会直接抛
`ReferenceError: __g is not defined`，而脚本正文被 `try` 包着，
报错连页面控制台都进不去 —— 表现只是「脚本装上了一点动静都没有」。
`GmShimTest.用到垫片时必须定义在外层作用域` 钉住了这个结构。

用得着垫片时才生成外层那一圈：只用 `unsafeWindow` 或 `GM_info` 时
不需要 `__g`，就不生成。

---

## 4. `unsafeWindow` 免费，以及为什么这不值得高兴

本引擎的注入走 `evaluateJavascript`，脚本跑在页面的**主世界**，
所以 `window` 本来就是页面的 window —— `unsafeWindow` 直接等于它，
一行就够。在篡改猴里这是一项需要显式申请、用来**跨出**沙箱的特权。

免费的原因恰恰是**没有沙箱**：没有边界，也就无所谓跨越。
脚本和页面共享同一套全局对象，页面能检测到脚本的存在、能篡改脚本依赖的对象。
篡改猴能同时给出「干净的沙箱」和「显式的跨界出口」，本引擎当前只能给出后者。

要补上沙箱得走 `WebViewCompat` 的隔离世界（isolated world），
那需要引入 `androidx.webkit` —— 属于第 3 档。**该依赖已获准引入，
但本档用不到，因此当前没有加**（`dependencies` 里仍然只有
`testImplementation 'junit:junit:4.13.2'`）。

---

## 5. `GM_info` 报的是实际时机，不是声明时机

脚本原定 `@run-at document-start` 时，本引擎实际只能做到 `document-end`
（原因见 `UserScript` 的类注释）。`GM_info.script.runAt` 报的是**实际值**。

理由：脚本若按声明值判断「我在 document-start 跑的，可以放心 Hook 早期事件」，
它就会走一条在这里根本走不通的路。报实际值，写得好的脚本会自己换成降级分支。
`GmShimTest.GM_info报实际注入时机而不是声明时机` 钉住了这一点。

---

## 6. 字符串转义是安全问题，不是顺手写一下

生成的代码要拼进 `evaluateJavascript` 的执行体，而来源字符串是**用户可控**的
—— 脚本名、描述、`@match` 模式都来自下载到的 `.user.js`。

一个叫 `Bob's reader` 的脚本，名字里的单引号不去转义就会把生成的 JS
撕成语法错误。而**语法错误会让整次注入失败** —— 这一页上所有脚本一起
静默死掉，控制台只会留下一句看不懂的 `missing ) after argument list`。

另外两个必须显式处理的是 **U+2028 / U+2029**（行分隔符 / 段分隔符）：
它们在 JSON 里合法、在 ES2019 之前的 JavaScript 字符串字面量里**非法**。
本工程 `minSdk 24`（Android 7 时期的内核）远早于 ES2019，
脚本描述里混进这两个字符会以同样的方式炸掉整次注入。

---

## 7. 刻意没做的部分

| 接口 | 缺什么 | 为什么现在不做 |
|---|---|---|
| `GM_setValue` / `GM_getValue` | 原生桥 | 本工程没有 `addJavascriptInterface`，脚本没法把值交给 Java 侧 |
| `GM_registerMenuCommand` | 原生菜单 + 桥 | 同上，且需要一套「按脚本归属」的菜单注册与注销 |
| `GM_xmlhttpRequest` | 原生 HTTP + cookie 共享 + 站点白名单 | 不只是「发个请求」：不灌 cookie 会拿到未登录页面；不设白名单等于把 CSRF 能力交给脚本 |
| `GM_download` / `GM_openInTab` | 桥 | 底层能力已有（`enqueueDownload` / 新标签），缺的是调用入口 |
| `@require` / `@resource` | 下载与缓存 | `buildInjectAll(scripts, url, null)` 那个 `null` 就是它 —— 注入结构已支持传入依赖，缺的是拉取与缓存 |
| `document-start` | `WebViewCompat` | 官方解要引依赖；不引只能改写 HTML 响应，非 HTML / 流式 / 大页面三种情况全出问题 |

### 桥真正的难点不是「写个桥」

第 1 档的 `addJavascriptInterface` 会把对象暴露给**所有 frame、所有页面**。
默认情况下任何网站的 JS 都能调 `NovaBridge.getValue(...)` 去读别的脚本存的配置。

更麻烦的是：**主世界里没有「脚本身份」**。页面 JS 和脚本 JS 共享同一个
`window`，所以脚本没有任何办法向桥证明「我是脚本 A 而不是这个页面的代码」。
唯一的补丁是只认主 frame + 校验当前 URL，但那挡不住同页面上的恶意内联脚本。

这正是第 3 档「隔离世界」存在的理由 —— 也是它值得引入依赖的原因。

---

## 8. 怎么加下一档

1. 在 `GmShim.SUPPORTED` 里加上接口名。
2. 在 `GmShim.collect()` 里加一条分支，生成对应的形参名与实参表达式。
   纯 JavaScript 的接口写进 `SHIM_BODY` 就够；需要原生能力的，
   实参表达式指向原生桥对象。
3. 不需要改 `UserScript.buildInject()` —— 它是数据驱动的。
4. `needsPrivilegeWarning()` / 安装提示会自动跟着少一项，
   因为它们都走 `GmShim.unsupported()` 这一个判定入口。
5. 补 `GmShimTest` 用例。**至少要有一条钉住「没声明就绝对拿不到」**。

第 2 档的 HTTP 层可以直接复用 `RuleUpdater` 的
`HttpURLConnection` + 单线程 `Executor` + 主线程回调模式，不引 OkHttp。
但必须同时解决三件事，缺一不可：

- **Cookie 共享**：`HttpURLConnection` 不共享 WebView 的 cookie jar，
  不手动从 `CookieManager` 灌进去，所有带登录态的脚本拿到的都是未登录页面
  —— 「跑起来了但结果不对」，最难查的那种。
- **回调代际号**：请求发出后页面可能已经导航走了，回调 `evaluateJavascript`
  会注入到新页面上。必须带一代际号做作废。
- **目标站点白名单**：否则等于给了脚本「以你的身份发任意跨域请求」的能力。

---

## 9. 验证

### 单元测试

`GmShimTest` 19 条，纯 JVM（不依赖 Android 框架，与工程其余测试同一策略）。
覆盖：支持判定、`unsupported` 的去重与 `none` 过滤、形参生成、声明顺序无关性、
`@grant none` 输出的逐字节回归、垫片作用域、以及全部转义路径。

```
29 个测试类 / 497 个用例 / 0 失败 / 0 错误
```

### JavaScript 层面的验证（手工，未被自动化）

单测只能证明「生成的字符串没错」，证明不了「生成的 JS 真能跑」。
必要时用 Node 补一遍，步骤：

1. 写一个临时 `main`，把 `UserScript.buildInject()` 的真实输出打到文件
   （注意加 `-Dstdout.encoding=UTF-8`：JDK 18 起重定向用的是
   `stdout.encoding`，不是 `file.encoding`，中文会被按 GBK 写坏）。
2. 逐段 `new Function(code)` —— 语法错误会在解析阶段就抛出。
3. 用一个最小 DOM 桩真的跑一遍，检查 `typeof` 结果、插进去的节点、日志。

本轮实测结果（5 种声明组合）：

| 场景 | 结果 |
|---|---|
| 无 `@grant` | 6 项全部 `undefined`，无 DOM 操作 |
| 声明全部 6 项 | 全部就位；插入 `style` 与 `div`；`__nova` 被置 1；日志正确 |
| 只声明 `GM` | 只有 `GM.*` 可用，裸的 `GM_addStyle` 仍是 `undefined` |
| 只声明不支持的项 | 一项都拿不到，无异常 |
| 混合声明 | 只有受支持的那项可用 |

第 3 行是最有价值的一条：它同时证明了「接口真的能被脚本正文触到」
和「严规则在运行期成立」。

---

## 10. 实测数据

- release APK：**407 KB → 409 KB**（净增约 **2 KB**，来自 `GmShim` 一个类
  与约 1.1 KB 的垫片字符串常量；测试类不进 release）
- 运行时第三方依赖：**0**（未因本档引入任何依赖）
- 测试：29 个类 / 497 用例 / 0 失败 / 0 错误

---

## 11. 能捞回哪些脚本

第 0 档解决的是一批「只用 `GM_addStyle` / `GM_log` / `unsafeWindow`」的脚本
—— 在此之前它们装上会直接抛 `ReferenceError`。

更受关注的那几条**不在本档**，各自卡在不同位置：

| 脚本 | 卡在哪 | 需要哪一档 |
|---|---|---|
| 知乎增强 | `GM_registerMenuCommand`（功能开关挂在油猴菜单上） | 第 1 档 |
| AC-Baidu 净化搜索 | `GM_xmlhttpRequest` + `GM_setValue` | 第 2 档 |
| 网页翻译器 | `GM_xmlhttpRequest`（5 个 GM 接口） | 第 2 档 |
| 沉浸式翻译类 | 同上 | 第 2 档 |

值得留意的是：`GM_addStyle` 现在是**真的能用**了，而在此之前
`ScriptCatalog` 把「依赖 `GM_*`」当成了一道硬门槛。这道门槛现在
应该按接口细分 —— 只依赖第 0 档接口的脚本不该再被排除。
