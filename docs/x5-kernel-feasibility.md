# X5 内核接入可行性预研

> 版本：**v1** · 范围：仅 Android 移动端（`android-app/`）。PC 端已是真实多内核（`native/engines/` 下有 CEF + 两套 XULRunner），不在本次讨论内。
> 结论：**当前形态下不建议接入**。核心理由是收益（跨机型一致性）与 Nova 现有定位（386KB / 零依赖 / 诚实降级）不成比例，且 X5 的可用性是**运行期状态**，与 `EngineCatalog` 的**编译期常量模型**存在结构性冲突。

---

## 0. 结论摘要

| 接入方式 | 拿到什么 | 付出什么 | 建议 |
|---|---|---|---|
| **动态集成**（推荐评估路径） | SDK 只增约 1MB；用户设备首次静默下载 ~30MB 内核；内核可更新 | 首次启动白屏/回退率高（官方称在线加载成功率约 90%）；130 处 WebView 调用点全改；需要网络下载 | ⚠️ 可评估，但需先重构抽象层 |
| **静态集成** | 内核必定可用，无下载失败 | **APK 直接 +20～30MB**（社区案例中 `assets/tbs` 两个 `.tbs` 合计 90MB+） | ❌ 与项目体积哲学正面冲突 |
| **双内核并存**（X5 + 系统 WebView 用户自选） | 最符合 Nova「用户自己选」的设计 | 改造量约等于前两者之和 + 一套抽象层；且两套内核**无法真正同时存在** | ❌ 工作量与收益严重失衡 |

**如果一定要动，唯一有独立价值的动作是 §7 的「路径 B」**：先把 WebView 使用面收敛到一层接口后面。这件事本身就是架构收益，无论最终接不接 X5。

---

## 1. 基线：移动端现在的内核状况

### 1.1 `EngineCatalog` 的三档（当前实现）

| id | label | `nature` | `bundled` | 实际行为 |
|---|---|---|---|---|
| `chromium` | 系统 WebView | `REAL_KERNEL` | `true` | **唯一真内核**，Android 自带 |
| `gecko` | GeckoView | `NOT_BUNDLED` | `false` | 选了给提示，回退系统内核 |
| `trident` | 兼容层 | `COMPAT_LAYER` | `true` | 跑的还是系统 WebView，只改 UA |

设计原则（`EngineCatalog` 类注释原文）：

> 这是整个产品的底线约定：绝不把兼容层画成真内核，也绝不静默降级。

### 1.2 量化基线

| 指标 | 当前值 | 备注 |
|---|---|---|
| release APK | **386 KB** | `app-release.apk` |
| 第三方运行时依赖 | **0** | `dependencies` 只有 `junit`（test scope） |
| `minSdk` / `targetSdk` | 24 / 35 | |
| `MainActivity.java` | **4364 行** | 单文件，占全部移动端代码 37% |
| WebView 相关调用点 | **约 130 处**（11 个文件） | 见 §2.3 |
| 单元测试 | 纯 JVM，不引 Robolectric | `testOptions.unitTests.returnDefaultValues = true` |

**386KB + 零依赖**是这个预研最重要的前提。GeckoView 被列为 `NOT_BUNDLED` 的理由，代码里写得很直白：

> 会给安装包平添几十兆

按同一把尺子量，X5 静态集成的 20～30MB **没有理由被接受**。

---

## 2. 接入要做什么

### 2.1 两种集成方式

**动态集成（官网默认方案）**

```groovy
dependencies {
    implementation 'com.tencent.tbs:tbssdk:44286'   // 版本号以官网为准
}
```

在 `Application.onCreate()` 初始化，内核由 SDK 静默下载：

```java
QbSdk.initX5Environment(context, new QbSdk.PreInitCallback() {
    @Override public void onCoreInitFinished() { }
    @Override public void onViewInitFinished(boolean isX5) { /* false 即回退系统内核 */ }
});
```

**静态集成**：从官网下载 `.tbs` 内核包放进 `assets/`，启动时 `QbSdk.installLocalTbsCore()`。内核必定可用，代价是包体积。

> ⚠️ 探明的事实：官方**已关闭静态集成的文档与下载入口**，社区主流做法是从微信里提取内核（`core_private/x5.debug.tbs`）。这条路有**合规与版权风险**，且内核来源不可信，不建议 Nova 采用。

### 2.2 类替换映射（最关键的一张表）

X5 不是「换一个开关」，而是**换掉整套 WebView 宿主 API**。所有 `android.webkit.*` 都要换成 `com.tencent.smtt.*`：

| 现在（系统） | 换成（X5） |
|---|---|
| `android.webkit.WebView` | `com.tencent.smtt.sdk.WebView` |
| `android.webkit.WebViewClient` | `com.tencent.smtt.sdk.WebViewClient` |
| `android.webkit.WebChromeClient` | `com.tencent.smtt.sdk.WebChromeClient` |
| `android.webkit.WebSettings` | `com.tencent.smtt.sdk.WebSettings` |
| `android.webkit.CookieManager` | `com.tencent.smtt.sdk.CookieManager` |
| `android.webkit.DownloadListener` | `com.tencent.smtt.sdk.DownloadListener` |
| `android.webkit.ValueCallback` | `com.tencent.smtt.sdk.ValueCallback` |
| `android.webkit.WebResourceRequest` | `com.tencent.smtt.export.external.interfaces.WebResourceRequest` |
| `android.webkit.WebResourceResponse` | `com.tencent.smtt.export.external.interfaces.WebResourceResponse` |
| `android.webkit.WebResourceError` | `com.tencent.smtt.export.external.interfaces.WebResourceError` |
| `android.webkit.RenderProcessGoneDetail` | `com.tencent.smtt.export.external.interfaces.RenderProcessGoneDetail` |

**两处最容易漏、也最容易被 IDE 自动补全坑掉的地方（本项目正好都用了）：**

1. **`ValueCallback` 必须换包**。`AutoPage` 的自动翻页链路是：

   ```java
   web.evaluateJavascript(AutoPage.STATUS_SOURCE, raw -> { ... });
   ```

   在 X5 下 `evaluateJavascript` 的签名期望的是 `com.tencent.smtt.sdk.ValueCallback`，传 `android.webkit.ValueCallback` 虽然能编译（因为是两个不同重载），但**内核根本不会回调它**——表现为自动翻页的状态永远不回来。这类「编译通过、运行静默失效」的 bug 在 4364 行里极难定位。

2. **`RenderProcessGoneDetail` 在 `export.external.interfaces` 下**，不在 `smtt.sdk` 里。`MainActivity#onRenderProcessGone` 和 `recoverFromRenderGone` 都要跟着改。

### 2.3 现有代码的改造面（实测统计）

| 文件 | WebView 相关调用点 | 占比 |
|---|---|---|
| `MainActivity.java` | **91** | 70% |
| `RequestInterceptor.java` | 11 | |
| `RefreshHost.java` | 7 | |
| `EngineCatalog.java` | 5 | 注释与文案为主 |
| `Tab.java` | 4 | |
| `AutoPage.java` | 3 | ← `ValueCallback` 陷阱所在 |
| `UserScript.java` | 3 | |
| `NovaStore.java` | 2 | |
| `NovaSettings.java` / `DownloadTrigger.java` / `RuleSet.java` | 各 1 | |
| **合计** | **约 130 处，11 个文件** | |

改造**不是**全局替换 11 个 import 那么简单：

- `MainActivity` 里的 `web` 字段类型、lambda 推断、`ViewGroup.addView` 的类型全部跟着变；
- `RequestInterceptor` 实现的是系统 `WebViewClient.shouldInterceptRequest`，换成 X5 后签名不同（X5 早期版本用的是 `WebResourceResponse` 的老接口，且部分版本对 `shouldInterceptRequest` 的支持有偏差）；
- 还有个隐蔽项：X5 的 `WebView` 是**聚合包装**，取真实 View 要 `webView.getView()`。`RefreshHost` / `PullToRefresh` 里所有拿 `web` 当普通 `View` 用的地方（宽高、滚动、手势）都要过一遍。

### 2.4 初始化、清单与构建配置

| 项 | 变更 |
|---|---|
| `AndroidManifest.xml` | 新增 `WRITE_EXTERNAL_STORAGE`（读内核）、多进程声明、X5 相关 Activity |
| `Application` 类 | **当前不存在**，要新建，并在 `onCreate` 里初始化 |
| 多进程判断 | `getPackageName().equals(QbSdk.getCurrentProcessName(this))`，否则内核会被初始化多次 |
| 混淆规则 | `release` 当前 `minifyEnabled false`，**暂时不受影响**；一旦开启混淆，必须补 TBS 的 keep 规则，否则 release 包直接罢工 |
| ABI | 需保留 `armeabi-v7a` + `arm64-v8a`；X5 **不支持 x86**，模拟器测不了 |
| 存储 | 内核安装需要 **>50MB** 空闲空间 |

### 2.5 工作量估算

| 阶段 | 内容 | 相对量级 |
|---|---|---|
| T1 | 抽象层设计 + 系统 WebView 实现搬迁（**不含 X5**） | 大 |
| T2 | X5 实现 + 初始化链路 + 回退逻辑 | 中 |
| T3 | 130 处调用点适配、`ValueCallback`/`RenderProcessGoneDetail` 等陷阱排查 | 大 |
| T4 | 真机矩阵验证 + 降级提示设计 | 中 |
| T5 | `EngineCatalog` 模型扩展（§4.1） | 小但**牵一发动全身** |

> T1 是唯一可以独立交付、且本身就有价值的阶段。

---

## 3. 体积与运行时成本

| 维度 | 系统 WebView（现状） | X5 动态集成 | X5 静态集成 |
|---|---|---|---|
| APK 体积 | 386 KB | +约 1MB | **+20～30MB** |
| 用户流量消耗 | 0 | **首次约 30MB** | 0 |
| 首次启动 | 立即可用 | 可能白屏数秒～数十秒 | 立即可用 |
| 内核可用率 | 100% | **约 90%**（官方口径） | 100% |
| 离线可用 | 是 | 否（内核未下载完时） | 是 |
| 内核更新 | 跟随系统 | 可后台更新 | 需发新版 |

**「约 90% 成功率」这条要特别留意**：它的含义不是「10% 的用户装不上」，而是**约 10% 的设备会长期跑在系统内核上**。企业 WiFi 拦截腾讯域名、安全软件拦截下载、存储不足、弱网——都是真实高频场景。

---

## 4. 与 `EngineCatalog` 的四个冲突（本预研的核心）

这一节是判断「值不值得做」的真正依据。X5 不是一个普通功能，它**动摇了当前内核模型的三个基本假设**。

### 4.1 `bundled` 是编译期常量，X5 的可用性是运行期状态

现在的模型：

```java
public final boolean bundled;                       // 编译期就定死
public boolean selectable() { return bundled; }     // 纯函数，无副作用
```

`gecko` 为什么能被诚实处理？因为「带没带」在编译期就有答案，`selectable()` 是个纯函数，测试也是纯 JVM 单测。

X5 引入了一个**新状态**：**「带了，但此刻还不能用」**。它取决于：内核是否下载完、下载是否失败、是否被拦、存储是否够。`selectable()` 无法再是纯函数。

要么扩展 `Nature` 枚举（例如加 `PENDING`），要么给 `Engine` 加运行期就绪判定——**两个方案都会波及 `EngineCatalogTest` 的全部断言**，而那个测试文件现在有 20+ 条断言、全部按「纯静态」写的。

### 4.2 「约 90% 成功率」会把降级提示变成常态噪声

`resolve()` 的设计是对的，X5 恰好能复用：

```java
return new Outcome(want, fallback, true,
    want.label + " 未内置在本安装包里，已回退到" + fallback.label);
```

但语义变了：

- **现在**：降级是**一次性、静态的**——用户选了没带的内核，看到一次提示，之后就知道了。
- **X5 下**：降级是**运行期、反复的**。约 10% 的设备每次启动都回退，用户每次都会看到「已回退到系统 WebView」。

**「诚实提示」和「噪声轰炸」之间只有一线之隔。** 需要额外设计提示频率控制（首次 + 手动查看？），这跟 Nova 现有做法的直觉是相反的。

### 4.3 两套内核**无法真正同时存在**

这是与 PC 端最大的结构差异：

- **PC 端**能开三套真引擎，因为 CEF / XULRunner 是三个独立进程，`native/engines/` 里各带各的 so。
- **Android 端做不到**：X5 是**替换宿主**——一旦引入 SDK，你的 `WebView` 变量就是 `smtt` 的类。想同时保留系统内核，就得维护**两套宿主代码**，或者抽一层接口。

所以「双内核让用户选」在移动端不是「多加一个选项」，而是**整机架构翻倍**。这跟 PC 端「自然支持多引擎」的体验对称性，在移动端**天然无法达成**。

> 顺带一个诚实的推论：`gecko` 那条 `NOT_BUNDLED` 文案里写的「需要换掉整套 WebView 宿主」——**X5 也完全一样**。它当时用来拒绝 GeckoView 的理由，同样适用于 X5。

### 4.4 测试策略的张力

现有单测全部是**纯 JVM、不依赖 Android 框架**，这是刻意的克制（`build.gradle` 注释里明确拒绝了 Robolectric，理由是「每次跑测慢十几秒」）。

X5 的核心行为——初始化、下载、`canLoadX5`、回退——**全是运行期 + 真机依赖**的。要覆盖只能写仪器测试，而仪器测试必须有真机、且**必须是 arm 架构**（X5 不支持 x86，模拟器不可用）。

这意味着 X5 接入会**打破项目当前的测试策略**，引入一类无法在 CI 里跑的测试。

---

## 5. 风险清单

| 级别 | 风险 | 说明 |
|---|---|---|
| **高** | `ValueCallback` 静默失效 | 编译通过、运行无回调。自动翻页链路（`AutoPage`）首当其冲 |
| **高** | Cookie 操作时机 | `smtt` 的 `CookieManager` 必须在 **X5 WebView 创建之后**调用，否则只作用于系统内核。Nova 的登录态/下载 cookie 会静默丢失 |
| **高** | 回退瞬间的崩溃 | 内核下载中 → 先用系统内核 → 下载完成切 X5，这个「切换瞬间」是崩溃与白屏高发区 |
| **高** | 网络下载被拦 | 企业 WiFi / 安全软件拦截腾讯域名，导致内核永久下载失败 |
| **中** | `shouldInterceptRequest` 偏差 | 广告拦截（`RequestInterceptor`）依赖该回调，X5 各版本支持度不一致 |
| **中** | 取真实 View | `webView.getView()`，影响下拉刷新与滚动手势（`RefreshHost` / `PullToRefresh`） |
| **中** | 混淆 | 当前未开混淆故不触发；一旦开启必须补 keep 规则 |
| **中** | 架构不支持 | x86 不可用，模拟器无法验证；需保留 32/64 位 ABI |
| **低** | 存储空间 | 需 >50MB 空闲 |
| **合规** | 静态集成的内核来源 | 官方已关闭静态集成入口，社区做法是从微信提取，**来源不可信 + 版权风险** |

---

## 6. 测试方案（若决定推进）

| 层次 | 内容 | 可行性 |
|---|---|---|
| 纯 JVM 单测 | 扩展后的 `EngineCatalog` 状态机（若模型改造得当，仍可保持纯 JVM） | ✅ 可 CI |
| 真机仪器测试 | `canLoadX5` 真伪、内核下载成功/失败/超时三条路径 | ⚠️ 需 arm 真机，CI 不可跑 |
| 真机矩阵 | 至少有微信/QQ 的机器、无腾讯系 App 的裸机、弱网、存储不足、拦截环境 | ⚠️ 人力密集 |
| 回归重点 | 自动翻页状态回传、广告拦截、登录态保持、下拉刷新、渲染进程崩溃恢复 | ⚠️ 这是 130 处改动的验证成本 |

**最关键的一条**：必须专门验证「**选了 X5 但内核没就绪**」这条路径下，界面提示、UA、Cookie 是否都正确落到了系统内核——即 §4.1 的新状态是否被诚实处理。

---

## 7. 建议路径

### 路径 A：不接入（推荐）

理由汇成一句：**X5 解决的是「跨机型渲染不一致」，而 Nova 当前的核心竞争力是「轻、快、诚实」**。为了一个尚未被验证的真实痛点，付出 30MB / 130 处改动 / 常态降级提示，性价比不成立。

建议先做一件更便宜的事：**收集真实的兼容性抱怨**。如果确实有用户因为系统 WebView 太旧而无法访问某些站点，再启动接入也不迟——那时需求是真实的，且可以用数据说服自己。

### 路径 B：只做抽象层（有条件推荐）

把 130 处调用点收敛到一层接口（如 `NovaWebView` + `NovaWebViewClient`）后面，**先只保留系统 WebView 一个实现**。

- **收益独立成立**：主 Activity 从 4364 行瘦身、便于测试、未来接任何内核都受益；
- **风险低**：不引入依赖、不改行为、不动体积；
- **可随时中止**：做完了不接 X5 也不亏。这恰好也是 §2.5 中的 T1。

**这是唯一「无论最终接不接都值得做」的动作。**

### 路径 C：完整接入

只有在路径 B 完成、且收集到明确的需求证据后再启动。

---

## 8. 待实测确认的问题

预研阶段无法在代码层面回答的，留作动手前的验证项：

1. `com.tencent.tbs:tbssdk` 的**确切最新坐标与版本号**（本文档中的 `44286` 来自社区资料，需以官网 `x5.tencent.com` 为准）。
2. 动态集成后 **SDK 对 APK 体积的真实增量**（社区口径「约 300KB～1MB」，需实测）。
3. 在本项目的 `minSdk 24` / `targetSdk 35` 下，X5 是否存在分区存储或高版本 Android 的兼容问题。
4. `RequestInterceptor` 的 `shouldInterceptRequest` 在目标 X5 版本上的实际可用性。
5. 内核在线加载成功率在**国内真实环境**下的实测值（官方口径 90% 偏乐观，企业网络环境下可能显著更低）。

---

## 附录：一句话对照

| | 系统 WebView | X5 内核 |
|---|---|---|
| 内核归谁 | 系统 / 厂商 | App / 腾讯 |
| 与 Nova 哲学 | **一致**（轻、零依赖、诚实） | 冲突（重、闭源、运行期不确定） |
| 与 `EngineCatalog` | **天然契合** | 需改造模型（§4.1） |
| 与 PC 端对称性 | — | **无法达成**（§4.3） |
| 结论 | 保持 | 暂不接入 |
