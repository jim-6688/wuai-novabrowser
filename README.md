# 吾爱Nova浏览器

桌面端：**Chromium / Gecko / IE(Trident) 三档运行时**（**只有 Chromium 是真内核，另两档是如实标注的兼容层**），
**内置广告拦截**、**多线程下载引擎**、**媒体嗅探**，支持 **Chromium 扩展（.crx）** 与 **火狐扩展（.xpi）**。

移动端（Android APK）：**不内置任何内核**，渲染由系统内核（Chromium）提供；**多线程下载**、
**拦截规则订阅更新**、**篡改猴（用户脚本）**、**无图模式与自动拼页**。

默认主页 `https://52ta.top/`。

> **先说清一件容易被误会的事**：295 KB 的 APK 里**零个 `.so`**，没有内置浏览器内核。
> 移动版只有一档真内核（系统内核），所以**内核选择器已从移动端删除** ——
> 只有一个选项的「选择器」是假选择。详见第十三节。
> 桌面端的三档也请先读第三节，那里有「哪一档是真内核」的逐条标注。

---

## 一、先跑起来

```bash
cd novabrowser
npm install            # electron + jsdom（Chromium 主内核随 electron 一起下来，约 104MB）
npm run engines        # 下载 Gecko / CEF 等内核程序并校验（约 240MB，见第四节）
npm run filters        # 抓取三个拦截源的规则并校验（约 5MB，见第五节）
npm start              # 启动桌面端
npm run dev            # 带 DevTools
npm run preview:ui     # 不开 Electron，直接在浏览器里点 UI（走 mock 桥，标记「UI 预览」）
npm test               # 全部 11 套测试（jsdom + 真实 HTTP 服务器，快，不需要桌面会话）
npm run check:hidden   # 真实 Chromium 下的 hidden 属性回归（Electron，需要桌面会话）
npm run check:downloads  # 真实 Electron session 下的下载接线（Cookie 透传、多分片）
npm run check:sniffer  # 真实 Electron 下的媒体嗅探（真发请求，验证响应头解析）
npm run check:mobile   # 真实 Electron 下的无图模式（唯一能证明「图片请求一条都没出门」的地方）
npm run shots          # 真实渲染截图 → screenshots/*.png
npm run test:all       # npm test + 上面四条 Electron 检查（完整门禁）
npm run test:downloader    # 只跑下载引擎的集成测试（起本地 HTTP 服务器真下载）
npm run test:downloads-ui  # 只跑下载页的界面行为测试
npm run test:sniffer       # 只跑嗅探判定逻辑的测试（上百种格式组合）
npm run test:sniffer-ui    # 只跑嗅探页的界面行为测试
npm run test:nomedia       # 只跑无图判定引擎的测试（档位 / 该拦 / 必须放行 / 台账）
npm run test:autopage      # 只跑自动拼页引擎的测试（含 3 页全链路端到端）
npm run test:mobile-ui     # 只跑移动端阅读增强的界面行为测试
```

图标与移动版：

```bash
npm run icons             # 重建全套图标（34 个文件，含两套 PNG 断言）
npm run check:design     # 设计稿体检：class 是否都定义 / 画框是否配对 / 有无编码损坏
npm run mobile:sync       # 把桌面端的拼页算法与名单同步给移动版
npm run mobile:check      # 同步门禁：桌面端改了但没同步会在这里报错
npm run mobile:build      # 门禁 + 构建 debug APK
npm run mobile:test       # 移动版 385 项单元测试（纯 JVM，不需要设备）

cd android-app && ./gradlew assembleRelease   # 出可安装的 release APK
```

构建 APK 需要本机有 Android SDK（`local.properties` 里的 `sdk.dir` 指到它）。
需要 JDK 17 以上。第一次构建会自动下载 Gradle 与依赖。

> **若 `npm run icons` 报「必须在 Electron 下运行」**：本机环境里设着
> `ELECTRON_RUN_AS_NODE=1`，它会让 electron.exe 以纯 Node 模式启动，拿不到 `app`。
> 先 `unset ELECTRON_RUN_AS_NODE`，再直接跑
> `./node_modules/electron/dist/electron.exe tools/build-icons.js`。
> 同理，其余依赖 Electron 的脚本（`check:hidden` / `check:downloads` /
> `check:sniffer` / `check:mobile` / `shots`）在这个变量存在时也都跑不起来 ——
> 这是环境配置问题，不是脚本的 bug。

规则已随本工程抓取完毕（`assets/filters/`），**不跑 `npm run filters` 也能直接用**；
该命令用于以后从上游更新订阅。

`npm run preview:ui` 后打开：

- `http://127.0.0.1:4321/src/renderer/shell.html` —— 可交互外壳（PC/移动端布局可切）
- `http://127.0.0.1:4321/src/renderer/shell.html?panel=adblock` —— 直接展开设置页的某个分区
- `http://127.0.0.1:4321/design/design-board.html` —— UI 设计稿

---

## 二、目录结构

```
novabrowser/
├─ src/main/
│  ├─ main.js            主进程：窗口、内核会话、IPC、下载接管、事件路由
│  ├─ engines.js         ★ 内核适配层：原生 / 原生桥接 / 兼容层三种运行时 + NDJSON 桥
│  ├─ adblock.js         ★ 广告拦截引擎：三源架构 + 两级索引 + ABP 语法 + 元素隐藏
│  ├─ adblock-lists.js   内置过滤清单（系统内置源：207 条网络规则 + 89 条隐藏规则）
│  ├─ extensions.js      ★ CRX/XPI 解包（自研 ZIP 读取器）+ Firefox 清单归一化
│  ├─ downloader.js      ★ 多线程下载引擎：Range 分片 + 并发写偏移 + 断点续传
│  ├─ sniffer.js         ★ 媒体嗅探引擎：分级判定 + 100 种扩展名 / 91 种 MIME 注册表
│  ├─ sniffer-wire.js    ★ 嗅探的网络层接线（单独成文件，好让真机测试能直接调）
│  ├─ nomedia.js         ★ 无图判定引擎：档位 / 拦截名单 / 放行名单 / 台账（纯 Node）
│  ├─ request-gate.js    ★ 请求闸门：无图判定与广告拦截共用同一个 onBeforeRequest
│  └─ settings.js        配置持久化（原子写入）
├─ src/preload/preload.js  白名单 API 桥（contextIsolation，渲染层拿不到 Node）
├─ src/renderer/
│  ├─ shell.html/.css/.js  外壳：标签、地址栏、内核切换、全屏设置页、移动端骨架
│  ├─ autopage.js          ★ 自动拼页引擎（算法写成顶层函数声明，序列化后注入页面执行）
│  └─ bridge-mock.js       非 Electron 环境的等价桥 + 示例数据（用于 UI 预览）
├─ design/design-board.html  UI 设计稿（令牌 / 组件态 / PC / 移动七屏 / 设置页 / 下载 / 嗅探 / 无图与拼页 / 规则）
├─ assets/
│  ├─ icon/                 ★ 图标全套（★ 34 个文件：4 份 SVG 源 + 9 档 PNG + ico + 评审预览图）
│  └─ filters/              ★ 三个拦截源的规则文件（约 5MB）+ _mirrors.txt + manifest.json
├─ native/
│  ├─ README.md            原生内核宿主协议与编译指引（真 Gecko / 真 Trident）
│  ├─ bin/                 原生宿主二进制放这里（需自行编译）
│  └─ engines/             ★ 已下载的内核程序（CEF / XULRunner）+ manifest.json
├─ android-app/             ★ 移动版（原生 Android Gradle 工程，Dart 不参与构建）
│  ├─ app/build.gradle      AGP 8.7.3 / minSdk 24 / targetSdk 35 / Java 17
│  ├─ keystore/nova-dev.jks ★ 开发签名（明文口令，仅供本地构建，正式分发务必换掉）
│  ├─ app/src/main/java/top/wuai/nova/
│  │  ├─ MainActivity.java  ★ 界面与接线（3734 行）：工具栏两态 / 五格底栏 / 弹层 / 标签总览
│  │  ├─ NoImagePolicy.java ★ 无图判定（三档，按后缀猜，边界全部写明）
│  │  ├─ RequestInterceptor.java ★ 请求拦截：宿主黑名单 + 无图 + 43 字节透明 GIF
│  │  ├─ AutoPage.java      ★ 自动拼页接线（不含算法，算法从桌面端同步过来）
│  │  ├─ EngineCatalog.java ★ 内核档位 + 「兼容层不是内核」的诚实标注
│  │  ├─ MediaRegistry.java ★ 媒体后缀表 + 广告域名表（内置与订阅两路并存）
│  │  ├─ DownloadTask.java  ★ 下载任务状态机 + 分片规划 + 文件名推断
│  │  ├─ Downloader.java    ★ 多线程下载引擎（分片 / 校验缺片 / 合并 / 续传）
│  │  ├─ DownloadTrigger.java ★ 「该不该下载」的三档优先级判定
│  │  ├─ RuleSet.java       ★ ABP / hosts / 裸域名解析 + 逐段父域匹配
│  │  ├─ RuleUpdater.java   ★ 订阅更新 + 三道落盘防线
│  │  ├─ UserScript.java    ★ 用户脚本（.user.js）解析与注入
│  │  ├─ NovaSettings.java  ★ 配置（1.1.0 新增 12 项）
│  │  ├─ NovaStore.java     ★ 落盘层：设置 / 会话 / 脚本 / 订阅规则 / assets
│  │  ├─ BookmarkStore.java ★ 书签落盘：行式（id·addedAt·title·url），纯 JVM 不依赖 Android
│  │  ├─ Tab.java           ★ 标签数据（与 WebView 分离，含缩略图生命周期）
│  │  └─ NovaAlert.java     对话框薄包装（支持自定义内容区）
│  ├─ app/src/main/assets/  ★ 三份同步产物 + SYNC.json（门禁校验用）
│  ├─ app/src/main/res/     41 个 drawable（18 个图标矢量）+ 28 个布局 + 令牌
│  └─ app/src/test/java/    ★ 385 项单元测试（23 个类，纯 JVM，不实例化 Android 组件）
├─ dist/                    ★ 构建产物：release.apk（装机用）/ debug.apk
├─ screenshots/            ★ 真实渲染截图（npm run shots 生成）
└─ tools/
   ├─ preview.js           本地静态预览服务
   ├─ check-design-board.js ★ 设计稿体检（class 是否定义 / 画框配对 / 编码完整性）
   ├─ build-icons.js       ★ 图标构建器（34 个文件 + 两套 PNG 断言 + XML 预检）
   ├─ sync-mobile.js       ★ 移动版资产同步器（真 require 桌面端模块生成，不是抄一遍）
   ├─ check-mobile-sync.js ★ 同步门禁（sha256 对拍，抓「源改了但没同步」）
   ├─ fetch-engines.sh     ★ 内核程序抓取器（curl + tar/unzip）
   ├─ check-engines.js     ★ 引擎校验 + 清单生成（纯 Node，不联网）
   ├─ pe-info.js           ★ PE/COFF 解析器：验证二进制真实性与架构
   ├─ fetch-filters.sh     ★ 规则抓取器（curl，带镜像回退与溯源记录）
   ├─ check-filters.js     ★ 规则校验 + 清单生成（纯 Node，不联网）
   ├─ check-shell.js       外壳静态一致性自检
   ├─ test-engines.js      引擎适配层 + NDJSON 协议测试
   ├─ test-adblock.js      拦截引擎测试（索引无损性对拍 + 真实规则命中 + 性能基准）
   ├─ test-engine-menu.js  内核选择器 / 设置页分区 / 拦截源行为测试（jsdom）
   ├─ test-downloader.js   ★ 下载引擎集成测试（起真实 HTTP 服务器 + sha256 逐字节比对）
   ├─ test-downloads-ui.js ★ 下载页界面行为测试（jsdom）
   ├─ test-downloader-electron.js ★ 下载接线测试（真实 Electron session 的 Cookie 透传）
   ├─ test-sniffer.js      ★ 嗅探判定测试（上百种格式组合 + 误报防线，纯 Node）
   ├─ test-sniffer-ui.js   ★ 嗅探页界面行为测试（jsdom）
   ├─ test-sniffer-electron.js ★ 嗅探真机验证（真发请求 + 响应头 + 206 体积）
   ├─ test-nomedia.js      ★ 无图判定测试（该拦 / 必须放行 / 放行机制 / 台账 / 配置变更）
   ├─ test-autopage.js     ★ 自动拼页测试（找下一页 / 绝对化 / 正文容器 / 端到端 3 页）
   ├─ test-mobile-ui.js    ★ 移动端阅读增强界面测试（jsdom）
   ├─ test-mobile-electron.js ★ 无图模式真机验证（服务端日志为空 = 图片请求真没出门）
   ├─ test-hidden-attr.js  ★ 真实 Chromium 下的 hidden 属性回归（Electron）
   └─ shot.js              真实渲染截图器（Electron → screenshots/*.png）
```

---

## 三、内核能力矩阵（**如实标注，不粉饰**）

> 这一节说的是**桌面端**。移动端只有一档真内核且不提供选择，见第十三节。

| 内核 | 当前状态 | 渲染方 | 广告拦截 | 扩展 |
|---|---|---|---|---|
| **Chromium / Blink** | ✅ 原生内核 | Electron 内嵌 Blink | ✅ 完整生效 | ✅ .crx / 已解包目录 |
| **Gecko** | ⚠️ 兼容层（可升级为原生桥接） | Chromium 渲染 + Firefox UA / moz 垫片 | ✅ 完整生效 | ⚠️ .xpi 经清单归一化装载 |
| **IE / Trident** | ⚠️ 兼容层（可升级为原生桥接） | Chromium 渲染 + IE11 UA / documentMode / attachEvent 垫片 | ✅ 完整生效 | ❌ 不支持 |

### 为什么不是三个真内核？

三个内核**无法在同一个 Electron 进程里原生共存** —— Blink 是 Electron 自带的，而 Trident(MSHTML) 与 Gecko
是需要各自原生宿主才能嵌入的引擎。国内「双核/三核」浏览器的真实做法就是分别桥接。

所以本项目的做法是：**能力收敛到 `engines.js` 一个适配层**，提供三档运行时：

```
native  进程内真实渲染           ← Chromium 走这条
bridge  原生宿主进程渲染          ← 放下 native/bin/trident-host.exe 后自动升级到这条
compat  兼容层（伪造 UA/文档模式/API 垫片，但渲染仍是 Blink）
```

**兼容层永远在界面上被标成「兼容层」**：切换器按钮不填色 + 橙色角点，进入时强制弹出降级原因提示条。
绝不会让你以为在用真 IE 内核。原生宿主的协议与编译方法见 [`native/README.md`](native/README.md)。

---

## 四、内核程序：已下载、已校验

三个内核的**真实程序**都拉到本地了（`npm run engines`），并且每个都做了 PE 校验 ——
不是"文件存在就算数"，而是解析 PE 头，确认架构正确、导出表里是该内核的特征符号。

| 内核 | 位置 | 版本 | 体积 | PE 校验结果 |
|---|---|---|---|---|
| Chromium · Electron | `node_modules/electron/dist/` | Electron 30.5.1 | 254 MB | PE32+ **x64** · 导出 3126 个 V8 符号 → `Electron / Chromium` |
| Chromium · CEF | `native/engines/chromium-cef/` | CEF 154.0.34 / Chromium 154.0.8037.98 | 422 MB | PE32+ **x64** · 导出 249 个 `cef_*` → `CEF / Chromium Embedded` |
| **Gecko** · GeckoFX 45 | `native/engines/gecko-xulrunner45/output/` | GeckoFX 45.0.6 / XULRunner 45.0.0.5873 | 74 MB | PE32 **x86** · 导出 1847 个 `NS_*` → `Gecko / XULRunner (XPCOM)` |
| Gecko · 官方 XULRunner | `native/engines/gecko-xulrunner41/xulrunner/` | XULRunner 41.0.2（2015 官方归档） | 75 MB | PE32 **x86** · 导出 1123 个 → `Gecko / XULRunner (XPCOM)` |
| **Trident** · MSHTML | `C:/Windows/System32/mshtml.dll` | 系统组件（**无需下载**） | 22 MB | PE32+ **x64** · 导出 22 个 → `Trident / MSHTML (IE)` |

Electron 的 104 MB 发布包还额外做了**上游哈希比对**：本地 SHA-256 与 npm 包内官方 `checksums.json`
记录**逐字节一致**，证明 Chromium 主内核未被篡改。另外两个归档（CEF / GeckoFX / XULRunner 41）
的 SHA-256 记在 `native/engines/manifest.json` 里，可随时复核。

### ⚠️ 一条必须知道的约束：Gecko 是 32 位的

GeckoFX 45 和 XULRunner 41 的 `xul.dll` **都是 PE32 / I386（32 位）**。所以 `gecko-host.exe` **必须编译为 x86**，
平台目标**不能选 `AnyCPU`** —— 在 64 位系统上 AnyCPU 会以 64 位进程启动，加载 32 位 `xul.dll` 会直接
`BadImageFormatException`。这条约束写进了编译指引，也写进了引擎的降级提示文案。

### 相关命令

```bash
npm run engines:fetch    # 只下载（bash tools/fetch-engines.sh，可 --only=gecko）
npm run engines:check    # 只校验并生成清单（node tools/check-engines.js）
npm run engines          # 下载 + 校验
```

设置页的**「内核」分区 → 内核二进制**里把每个内核下到哪一步、架构是什么、
PE 识别成了什么、还差哪一环，全部摊开显示。

---

## 五、广告拦截：三个源并存

不是一份清单，是**三个独立源**，各自可单独开关、单独统计：

| 源 | 规则定位 | 实测落地规模 |
|---|---|---|
| **广告终结者** | ChinaList + EasyList 修正（国内站点为主） | 网络 11,761 / 隐藏 6,906 |
| **Adblock Plus** | EasyList 官方主订阅（含 China / EasyPrivacy） | 网络 121,936 / 隐藏 30,574 |
| **系统内置拦截器** | Nova 自带清单，随包发布、零网络依赖 | 网络 207 / 隐藏 89 |

合计 **133,904 条网络规则 + 46,599 条隐藏规则 + 3,474 条例外**，均从上游实时抓取。

### ⚠️ 关于「广告终结者」必须说清的一件事

广告终结者的官方订阅域 **`sub.adtchrome.com` 已停服**（实测 HTTP 502 / 连接被拒，
`www` 主站还活着但规则接口已经不响应）。它的规则定位是「ChinaList + EasyList 的修正维护版」，
因此本实现用**同血统**的 ChinaList 2.0 维护版 + CJX's Annoyance List 还原其覆盖面，
并在界面上如实标注 —— **不假装拉到了官方源**。

抓取器里官方地址仍作为首选，一旦它恢复会自动切回去。同理，ABP 官方下载域
`easylist-downloads.adblockplus.org` 在本机网络下不可达，改用 AdGuard 维护的官方分发镜像
`filters.adtidy.org`（分发的是同一份 EasyList）。每个文件**实际命中的镜像地址**都记录在
`assets/filters/_mirrors.txt`，界面上悬停可见。

### 语法支持（自研引擎，非黑名单匹配）

| 语法 | 支持 | 说明 |
|---|---|---|
| `\|\|domain^` | ✅ | 域名锚，含任意子域 |
| `\|prefix` / `suffix\|` | ✅ | 前后锚点 |
| `*` / `^` | ✅ | 通配 / 分隔符 |
| `@@` | ✅ | 例外规则，优先级高于拦截 |
| `$third-party` `$~third-party` | ✅ | 按站点同源性判定 |
| `$script` `$image` `$xhr` … | ✅ | 13 种资源类型 |
| `$domain=a\|b` `$~domain=` | ✅ | 按顶层文档域名限定 |
| `##selector` `domain##selector` `~domain##` | ✅ | 元素隐藏（注入 user-origin CSS） |
| `#@#` | ✅ | 隐藏规则例外 |
| `$redirect=` `$csp=` `$removeparam=` … | ❌ | 需改写请求，本引擎不执行 —— **如实统计跳过行数，不假装支持** |

### 性能：十万条规则怎么做到 31 μs/次

13.4 万条网络规则逐条跑正则是 **533 μs/请求**（实测），一个页面百来个请求就是 50 毫秒纯浪费。
所以做了两级索引：

1. **域名锚索引** —— `||ads.com^` 这类规则（占 87%）按域名建表，查询时沿 hostname 后缀链查表
2. **三层 token 索引** —— 其余规则取「最长字面量片段」，按长度落到 12 / 8 / 4-gram 三层表，URL 滑窗查表

索引只做**预筛**，命中后仍跑完整正则，不影响正确性：测试里拿索引路径与「不查索引、
逐条全扫」的参考实现对拍，36 个 URL 结果完全一致。落不进索引的规则只剩 **14 条**。

```
优化前  533.0 μs/次
优化后   31.6 μs/次   (31,596 次/秒)   —— 16.9 倍
堆占用  168 MB / RSS 217 MB
```

### 元素隐藏

- 46,599 条 `##选择器` 规则，按站点拼成 CSS 注入
- 通用规则合并去重后约 **227.6 KB**，按 hostname 缓存，不重复拼接
- 认不出的扩展语法（`:has-text()`、`##+js()`、`$$`、`:style()` 等）**一律剔除**并统计 ——
  真实的 EasyList 里有 **767 行**属于这类，不剔除会让整条 CSS 解析失败

其余：每个内核**独立 session**，拦截器分挂、互不干扰；支持导入自备清单；按站点白名单；
强度分档（标准档不拦第一方资源、严格档连第一方一起拦）；实时统计与来源 Top。

---

## 六、扩展支持

统一一条流水线：**识别 → 解包 → 归一化 → 装载**

- `.crx` → 解析 CRX2/CRX3 头，取出内层 zip，解包后 `session.loadExtension`
- `.xpi` / `.zip` → 解包；`.xpi` 判定为火狐扩展，走清单归一化
- 已解包目录 → 直接装载

ZIP 解包是**自己实现的**（`zlib.inflateRawSync` + 中央目录解析），不引任何三方依赖。

### 火狐扩展的兼容处理（会在 UI 上逐条披露）

1. 移除 `browser_specific_settings` / `applications`（Chromium 不认，否则直接拒装）
2. 过滤 Gecko 专有权限（`contextualIdentities`、`menus.overrideContext`、`tabHide` …）
3. `background.scripts` → `service_worker`（MV3），语义与 Gecko 事件页不完全一致
4. 归一化 CSP 到 Chromium MV3 形态
5. 向 background 与 content_scripts 注入 `browser.* → chrome.*` 兼容桥（promise 化包装）

> **能跑 WebExtension 的通用能力子集**；依赖 Gecko 专有 API 的功能会失效。扩展卡片上会写明实际做了哪些改动，
> 不做「完全支持火狐扩展」的虚假承诺。

---

## 七、PC 与移动双端

**同一套渲染层**，靠 `<html data-layout="desktop|mobile">` 切骨架：

- `auto`（默认）按窗口宽度自动切（断点 640 px），也可在「设置 → 外观」强制指定
- **桌面端**：标题栏 → 标签条 → 工具栏（导航按钮 + 地址栏 + 拦截/扩展/菜单）→ 提示条 → 视口 → 侧边抽屉/设置页
- **移动端**：紧凑地址栏 → 视口 → 六宫格底栏（标签居中凸起，第五格「阅读」）→ 标签页卡片总览 →
  内核选择底部弹层 / 阅读增强底部弹层；触控目标 ≥ 44 px，带 `env(safe-area-inset-bottom)`

底栏为什么是六格而不是把无图 / 拼页也摊上去：**底栏格数是硬约束**，再加格每个按钮就掉到 44 px 以下。
所以这两个开关收进「阅读」开出的底部弹层 —— 详见第十一节。

### 内核选择器在地址栏右端

内核是**「当前这个标签页正在用谁」**的属性，所以选择器不放在工具栏另起一段，而是贴在地址栏最右端：

```
[🔒] [ 搜索或输入网址            ] [☆] │ [CR ▾]     ← 徽标即当前内核，点开即选
```

- 点徽标展开下拉：每项给出 **内核名 + 运行模式标签 + 厂商/缩写**，不用悬停也能读完；`is-active` 用底纹 + 勾选
- 兼容层项的橙色标签是**文字级**冗余，配合徽标的 `is-compat` 橙描边与进入时的强制提示条，保证不会被误认为真内核
- 切换后**保留 URL 与登录态**，只重建该标签页的渲染载体
- 关闭方式：点选后自动关 / 点击别处 / `Esc` / 再点一次徽标
- **移动端不提供内核选择**（宽度不足，且只有一档真内核，选择器是假选择）——
  底栏那一格在 1.1.0 起换成了「下载」，内核信息改为工具栏上的**只读标识**：
  点开只能看，不能切。看得到「现在跑在什么上面」比「假装能切」有用。

**移动端菜单（底部弹层）分三组**：浏览（首页 / 书签 / 广告拦截）、工具（阅读增强 / 下载 / 篡改猴）、应用（设置 / 关于 / 退出）。「退出」调用 `finishAffinity()` 干净结束整个任务栈；书签来自地址栏左侧的星标按钮，一键收藏、底部面板管理 / 删除 / 清空。

移动端 UA 与布局都已就位。**要出手机 App 包**，可以把这个壳套进 Capacitor / 原生 WebView：
渲染层只认 `window.nova` 这个接口（见 `src/preload/preload.js`），换一个容器实现同样的接口即可，
UI 代码一行不用改 —— `bridge-mock.js` 就是一个现成的第二个实现，可以照着写原生容器桥。

---

## 八、设置页

**独立全屏，不是抽屉。** 左侧分组导航 + 右侧内容，共 12 个分区：

| 分组 | 分区 | 内容 |
|---|---|---|
| 浏览器 | 常规 | 主页 / 新标签页（可「与主页相同」）/ 默认内核 / 搜索模板（百度·必应·Google 预设 + 自定义）/ 恢复上次会话 |
| | 外观 | 布局三档（跟随窗口·桌面端·移动端）+ 主题（浅色·深色） |
| | 移动端 | **阅读增强**：无图模式三档（关闭·无图·无图+视频）+ 本次拦截台账 + 「显示本页图片」一次性放行；自动拼页开关 + 单次页数上限 + 三条边界说明 |
| | 内核 | 三档运行时状态 + 内核二进制逐发行版披露 + 原生宿主重新探测 |
| 内容 | 广告拦截 | 三源卡片（独立开关）/ 总开关 / 拦截强度 / 白名单管理 / Top 来源 / 导入与重置 |
| | 媒体嗅探 | **页面音视频清单**：分类计数与合计体积 / 逐条置信度与判定依据 / 内联试听试看 / 一键多线程下载；嗅探开关、最小体积、是否读元数据、是否展开分片 |
| | 扩展 | 已装扩展 + 兼容处理披露 + 安装 / 移除 |
| | 书签 | 列表 / 打开 / 删除 / 清空 / 加入当前页 |
| | 历史记录 | 最近 200 条（异步载入）+ 清空 |
| | 下载 | **多线程下载引擎**：引擎状态卡 / 线程数与并发数 / 接管开关 / 下载目录 / 新建下载 / 任务列表（分段进度条、暂停·继续·取消·重试·打开·定位） |
| 系统 | 隐私与数据 | 用户数据目录 + 各内核隔离分区 / 清空历史·书签·站点数据 / 重置拦截统计 / 恢复默认设置 |
| | 关于 Nova | 运行时版本 + 内核状态 |

几处实现上的取舍：

- 导航项挂**实时角标**（拦截源 `3/3`、嗅探非分片数、扩展 3、书签 2），不用点进去才知道有多少东西
- **窄屏降级**：左侧导航变成顶部横向可滑动的胶囊条，而不是缩成汉堡抽屉
- 工具栏盾牌 / 嗅探 / 扩展按钮、菜单项、`Ctrl+Shift+A`、`?panel=adblock` 深链接，全都直达对应分区
- **不摆假开关**：`relaxThirdParty`（站点级 Cookie 策略）在配置里存在但没接到 Electron 的 session 策略上，
  所以界面上不给一个点了没反应的按钮，而是在「隐私与数据」底部写明「本版未实现」

### 移动版（1.1.0）的设置页

桌面端是左导航 + 右内容的全屏页（12 个分区，见上表）。移动端没有横向空间摊开左导航，
改用**单列分组折叠**：七个分组从上到下排，每组一个标题 + 若干行，行内右侧显示当前取值。

| 分组 | 行 |
|---|---|
| **通用** | 首页地址（输入框）/ 新标签页（空白页·首页）/ 搜索引擎 / 主题（跟随系统·浅色·深色）/ User-Agent 覆写 |
| **阅读增强** | 无图模式（关闭·无图·无图+视频）/ 自动拼页 / **加载图片**（比无图模式更彻底的总开关） |
| **广告拦截** | **总开关** / 拦截规则（四个预置源 + 自定义订阅）/ **订阅自动更新**（超过 3 天未更新才拉，静默） |
| **篡改猴** | **启用篡改猴（总开关）** / 篡改猴管理 / 安装前确认 |
| **下载** | 并行分片数（1–16）/ 自动下载媒体 / 完成通知 / **下载记录上限** / 下载目录 |
| **隐私与浏览** | 无痕模式 / 退出时清缓存 / 强制 HTTPS / 恢复上次会话 / 清除缓存 / 清除全部数据 |
| **关于** | 当前内核（真实 系统内核版本号 + 不内置内核的说明）/ 本次会话统计 / 资产清单 / **关于（独立面板）** |

三处刻意的取舍：

- **不摆假开关，也不留着不摆。** 每个开关都接到真实行为上；接不到的（`relaxThirdParty` 那一类）
  宁可不放。反过来也成立：`rulesAutoUpdate` 和 `loadImages` 曾经是「配置里有字段、界面没有行」的
  半吊子状态，这一版把开关和实现一起补上 —— 没有实现的开关不上线，上线了就必须真动。
- **主题真的会变。** 换主题走 `recreate()`：uiMode 的覆盖发生在 `attachBaseContext`，
  已经 inflate 出来的视图不会自己变色，不重建的话那一行就是假开关
  （`values-night/colors.xml` 也是为此补的 —— 中性令牌早在 `colors.xml` 里定义好了，
  却一直没有任何地方引用，深色模式因此只剩一层窗口背景）。
- **取值就地显示，不另开选择页**（除线程数这类需要枚举的）。
  手机上多一次「打开弹层 → 选 → 确认」就多两次误触。

---

## 八之二、移动版的下载模块

**不用 `android.app.DownloadManager`**，它不支持同一文件分片，也不支持断点续传。
`Downloader.java` 是自研的：固定线程池 + 每片一个 `.part<序号>` 文件 + 合并。

```
探测 ──► 分片 ──► 并发拉取 ──► 校验缺片 ──► 合并 ──► 清理
 │        │                        │           └─ 先写 .merging 再 rename
 │        │                        └─ 缺片就补下，不拿残缺文件合并
 │        └─ Range 被拒就退回单线程（见下）
 └─ HEAD / GET 看总长与是否接受 Range
```

三处必须踩对的地方，每一处都在别的下载器上踩过：

1. **服务器不认 Range 时必须退回单线程。** 有些服务器对 `Range` 请求回 `200` + 完整文件。
   这时若还按分片写，就会写出「完整文件 + 完整文件」—— **大小看起来完全正常、不报错，
   要播到一半才炸**。所以判据是「回的不是 206 且没有 `Content-Range`」就整任务降级。
2. **断点续传以文件实际长度为准，不记偏移量。** 记的偏移量在文件被系统清理、
   或写一半断电时会骗人；文件长度不会。续传时逐片 `new File(...).length()` 重新算起点。
3. **合并前校验缺片。** 任何一片短于预期就重下那一片，**不拿残缺文件去合并**。

### 什么时候判定为「该下载」

三档优先级，`DownloadTrigger.java`：

| 优先级 | 判据 | 例子 |
|---|---|---|
| 1 | `Content-Disposition: attachment` | 任何显式声明要下载的 |
| 2 | 已知媒体 / 文档后缀（与嗅探共用 `media-ext.txt`） | `.mp4 .mp3 .zip .pdf .apk` |
| 3 | URL 含 `download` / `savefile`（**仅限无后缀时**） | `/download?id=3` |

**`inline` 明确放行** —— 视频站播放器的地址常带 `inline`，当成下载会把播放器直接顶掉。

三条不判定：

- **主文档永不触发**（否则点了链接就变成下载，浏览器没法用）
- **页面资源永不触发**：`html/js/css/json/php/aspx` 等一律不碰
- **未知后缀不猜**：`.dat/.log/.woff2` 这类宁可不判 —— 猜错会让页面加载到一半白屏

### 界面

底栏下载格显示进行中任务数角标。任务行给的是**分段进度**（一格 = 一条连接），
退化成单线程时格数变 1 并如实标注，不画假格子。总长未知时百分比显示 `-1`（界面写「已下载 X」），
**不假装 0% 卡死**。

### 下载存哪

存**应用私有目录** `filesDir/downloads`。原因是不需要存储权限、卸载即清理。
代价是系统「打开」不方便，所以每条任务给「复制路径」，用户自己去文件管理器取。

---

## 八之三、移动版的篡改猴：用户脚本，不是 Chrome 扩展

**Android 系统内核不加载 Chrome 扩展** —— 它没有扩展宿主，装 `.crx` 也只是装了个空壳。
所以移动版内置**篡改猴**式的用户脚本管理器（`.user.js`，Tampermonkey 兼容），
这是 Kiwi、Firefox for Android 的通行做法。**界面上写明这一点，不假装是 Chrome 扩展。**

能力边界写在篡改猴面板里，不藏着：

| 能力 | 状态 | 为什么 |
|---|---|---|
| `@match` / `@include` / `@exclude` | ✅ | 逐条手写转义匹配 |
| `@require` | ✅ | 注入前拉取并拼接 |
| 注入时机 | ⚠️ 只有 `document-end` | 系统内核只给 `onPageStarted`，那时文档已建好，做不到真正的 document-start |
| `@grant` 特权 API | ❌ | 没有 GM_xxx 的宿主；声明了会在面板里标出 |
| 没有 `@match` / `@include` | ❌ **拒绝安装** | 否则等于「所有网站都运行」，用户不会知道 |

**没有 `@match` 就拒绝安装**，这条是硬门槛：用户脚本能改页面、能读页面内容，
「装上就全站生效」是不能默认打开的。

脚本注入包在 `try/catch` 里 —— **用户脚本的语法错误绝不能让页面崩**，
崩了就是整页白屏，用户还以为浏览器坏了。

### 内置脚本：只有一条，随包发布

首次启动会自动装上 **网页限制解除**（Cat73，v1.2.4，LGPLv3），面板里带「内置」徽章。
徽章是必要的：这是**浏览器替用户做的决定**，列表里得看得出哪些不是自己装的，
否则清理时会把自己的和内置的混在一起删。

挑它有两道门槛，**顺序不能反**：

1. **引擎跑不跑得起来** —— `@grant` 必须为空。Greasy Fork 总安装量第一是
   AC-Baidu 净化搜索（约 342 万），但它依赖 `GM_xmlhttpRequest`、`GM_setValue`，
   在本引擎里只会静默失败，**装了比不装更糟**：用户以为装上了个好用的东西，
   实际什么都没发生，还怪浏览器有 bug。
2. **口碑** —— 在过得了第 ① 关的里面取最高的。「网页限制解除」约 222 万安装、
   好评 : 中评 : 差评 ≈ 3996 : 54 : 23，且 `@grant none`、只动 DOM 与事件层。

**注入时机的折扣要说清楚**：它原定 `@run-at document-start`，靠 Hook
`EventTarget.prototype.addEventListener` 拦住网站注册的反复制监听，而我们只能做到
`document-end`，所以「页面加载瞬间注册的那批监听器」拦不到。但它并没有因此失效 ——
CSS 强制 `user-select:text`、替换 `Event.prototype.preventDefault` 与 `returnValue`
的 setter（原型方法查找是动态的，注入早晚不影响已注册的监听器最终走哪条实现）、
以及每 30 秒一轮清 `onXXX` 属性的循环都照常工作，而这几条恰好覆盖了大多数中文网站
实现「禁止复制 / 禁止右键」的方式。面板的说明行里会标出「实际按文档结束后注入」。

**卸载之后不会复活**：播种是一次性的，装过就把 key 记下来，之后再也不检查。
若按「当前装着」判断，用户卸载完重启又被装回来 —— 那个卸载按钮就是假的。

**第三方许可**：脚本版权归 Cat73，LGPLv3（允许随包分发，但要求保留版权与许可声明）。
许可证全文随包放在
`android-app/app/src/main/assets/user-scripts/LICENSE-remove-web-limits.txt`。
脚本本体**逐字节保持上游原样**，`BuiltinScripts.MANIFEST` 里记着它的 sha256，
`BuiltinScriptsTest` 每次跑测都校验一遍。换版本的正确做法是**重新审计这份脚本，
再更新那个 sha256**，而不是把断言删掉 —— 删掉就等于丢掉了「内置的是哪一份」的唯一答案。

> **`@grant none` 不是一项特权。** 这是本轮从内置脚本上暴露出来的一个真 bug：
> 原先 `@grant` 的值被无条件收进 `grants`，于是 `@grant none`（用户脚本里最常见的写法，
> 意思是「我不需要任何特权」）被判成「声明了 1 项未支持的权限」，
> 几乎所有按规范写的脚本都被误标。警告本身是真的（我们确实没有 GM_*），
> 但它指向一个不存在的问题 —— 而误报的代价是用户学会忽略这个警告，
> 真有特权的脚本也就一起被忽略了。现已修掉，并有 3 条测试钉住
> （大小写、`none` 与真特权混写时只算后者）。

---

## 九、下载引擎：多线程（桌面端）

Chromium 自带的下载器是**单连接流式**——一个 TCP 连接从头读到尾，带宽上限就是单连接的带宽。
`src/main/downloader.js` 自己重写了一个：用 HTTP `Range` 把文件切成 N 段并发拉取，
每段各自 `seek` 到目标文件的对应偏移写入，**不需要最后合并**。

### 怎么工作

```
探测 ──► 分片 ──► 并发拉取 ──► 直接写偏移 ──► 完整性校验
 │        │          │
 │        │          └─ 每段断线就从「段内游标」继续，不重头下
 │        └─ planChunks(total, threads)：均分，最后一段吸收余数
 └─ 实打实发一个 `Range: bytes=0-0`，看服务端回不回 206
```

三个必须踩对的地方：

1. **判定分片能力不能只看 `Accept-Ranges` 头** —— 这个头经常缺失但服务端其实支持。
   引擎实打实发一个 `bytes=0-0` 请求，回 `206` + `Content-Range` 才认。
2. **必须带 `Accept-Encoding: identity`** —— 服务端一旦 gzip，`Content-Length` 就不是文件真实大小，
   Range 偏移也会错位，分片拼出来的文件必坏。
3. **进度按「段内游标」记，不按「本次收了多少」记** —— 这样断线重试、暂停续传、
   甚至跨进程重启续传，都只需要重取剩余区间。

### 接管策略

页面触发的下载会被接管到 Nova 引擎（在 `will-download` 里 `preventDefault()`），
**但如果引擎一个字节都没拿到就失败了**（需要 POST、需要特殊鉴权头等），
会自动 `ses.downloadURL()` 交回 Chromium 内建下载器，并在任务上记一条「已交回内建下载器」。
用户不该因为我们想多线程就下不了东西。

Cookie / UA 从**对应内核的 session** 里取，所以靠登录态才能下的链接照样能下。

### 界面

任务卡的进度条是**一格 = 一条连接**：谁先跑完、哪几段还在补，直接把「用了几个线程」摆在脸上。
服务端不支持 Range 时格数退成 1，并如实标注「单连接（服务端不支持分片）」——
**不画假格子，也不在退化成单连接时还显示「8 线程」**。

### 能力与边界

| 能力 | 状态 |
|---|---|
| 多线程分片（Range / 206） | ✅ 默认 8 线程，可设 1 / 4 / 8 / 16 |
| 服务端不支持 Range 时退化单连接 | ✅ 自动，不会因此下载失败 |
| 暂停 / 继续 | ✅ 进度存档到 `<文件名>.novadl.json`，继续时只补剩余区间 |
| 断线重试 | ✅ 段内重试 3 次，从游标继续而非重头 |
| 跨进程重启续传 | ✅ 启动时从 sidecar 恢复游标，未完成任务标为「已暂停」等用户点继续 |
| 取消 | ✅ 连半成品一起删掉，不在下载目录留垃圾 |
| 同时多任务 | ✅ 并发上限可设 1 / 2 / 3 / 5，超出排队 |
| 重定向 | ✅ 手动跟随（换主机时摘掉 Cookie，不把 A 站凭证递给 B 站） |
| 完整性校验 | ✅ 声明了总长度就逐字节对账，对不上就报错而不是留个坏文件 |
| 需要 POST / 特殊鉴权头的下载 | ⚠️ 引擎拿不到 → 自动交回 Chromium 内建下载器 |
| 换镜像续传 | ❌ 不做 —— 换了源就等于换了文件，拼接必坏 |

### 测试

`tools/test-downloader.js` **不是 mock 测试**：起一个真实的 `http` 服务器让引擎真下载，
再拿 `sha256` 跟源数据逐字节比对。服务器侧同时统计连接数与发出字节数，用来证明两件事：

```
  PASS  并行性：8 片各延迟 150ms，总耗时远小于顺序累加的 1200ms   334 ms（顺序需 ≥1350ms）
  PASS  带延迟时服务端同时挂着 8 个连接（真并发，非流水线）          峰值 8
  PASS  下载结果与源文件 sha256 一致
  PASS  续传没有把整个文件重下一遍                                 6.00 MB（整下需 6.00 MB）
```

第一条是**墙钟时间**证据：服务端对每个分片响应前先等 150ms，顺序下载会把延迟累加成
8 × 150 = 1200ms，并发重叠则只需约 150ms。这不依赖任何计数器。

> 顺带一个量法上的坑：**并发连接峰值只能在带延迟的场景下量**。
> 本机内存响应是瞬时返回的，8 个请求会在事件循环里流水而过、窗口根本重叠不上
> （实测即时响应下峰值只有 1），那是量法的问题，不是引擎没并发。

---

## 十、媒体嗅探：把页面里的音视频挑出来

页面里的音视频往往夹在几十个请求中间，有的连扩展名都没有。`src/main/sniffer.js`
盯着每个内核 session 的**响应头**（纯旁路观察，不改写任何请求），把其中的
音频 / 视频 / 流媒体 / 字幕挑出来，汇成一份可直接下载的清单。

### 为什么判定要分级

只看扩展名会两头翻车：

- **漏** —— `/api/media?id=8123` 这类地址没有扩展名，靠扩展名一无所获；
- **错** —— `https://site.com/watch.mp4` 完全可能是返回登录页 HTML 的动态路由。

所以判定按四级走，每级带不同置信度：

| 级别 | 依据 | 置信度 | 界面标签 |
|---|---|---|---|
| 1 | 响应类型精确命中（`video/mp4`、`application/vnd.apple.mpegurl`…） | 0.95 | 确定 |
| 2 | 响应类型以 `video/` 或 `audio/` 开头（子类型没见过也收） | 0.90 | 很可能是 |
| 3 | 地址扩展名命中 | 0.75 | 可能是 |
| 4 | 通用二进制类型 + 扩展名（`application/octet-stream` + `.mkv`） | 0.70 | 存疑 |

同时**明确的非媒体响应类型有一票否决权** —— `text/html`、`image/*`、`font/*` 压过任何扩展名。
`text/` 的整体否决放在 MIME 精确表之后，所以 `text/vtt` 字幕不会被误杀。

置信度不是内部数字，是**直接标在每一条上的**（设计稿 G 里那条 `.mkv` 就挂着「存疑」）。
用户点进去之前就知道这条有多少把握。

### 格式覆盖

注册表覆盖 **100 种扩展名 / 91 种响应类型，归一为 78 个容器**（数字由代码算出来，不手写）：

- **视频** —— MP4 / M4V / MOV / WebM / MKV / AVI / FLV / F4V / WMV / ASF / MPEG / TS / M2TS /
  3GP / OGV / RealMedia / VOB / MXF / DV / AMV / WTV / Bink / RoQ / MJ2 …
- **音频** —— MP3 / M4A / AAC / FLAC / WAV / WMA / OGG / Opus / APE / ALAC / AMR / AIFF / MIDI /
  AC3 / EAC3 / DTS / RealAudio / WavPack / TTA / Speex / CAF / MOD / XM / S3M …
- **流媒体清单** —— HLS（`.m3u8`）/ DASH（`.mpd`）/ HDS（`.f4m`）/ MSS（`.ism`）/ SMIL / PLS / ASX / XSPF
- **字幕** —— SRT / VTT / ASS / SSA / SUB / SBV / LRC / TTML / SAMI

单是 HLS 一种格式就有 **8 种 MIME 写法**（`application/vnd.apple.mpegurl`、`application/x-mpegURL`、
`audio/mpegurl`、`application/mpegurl`…），各家服务端写得都不一样，全部归一到 `HLS`。

### 流媒体与分片的特殊处理

- **流媒体清单一律不自动探测元数据** —— 浏览器一旦开始解析 m3u8 就会去拉分片，
  用户的流量会在毫无察觉的情况下被吃掉。这类只做标注，不碰。
- **标注为「不可直接下载」** —— 下载得到的是切片地址表，不是文件本身。
- **HLS 分片默认折叠** —— 一个视频切几百片是常态，平铺会把正片淹掉。
  `.ts` / `.m4s` 这类「本身就是切片」的格式靠自身特征判定；`.mp4` 分片则要看
  **同源同目录有没有清单文件**，避免把真正的 mp4 视频误伤。
- **剔除浏览器自身的请求** —— 设置页里预览一次视频也会产生请求，不排除的话清单会凭空多出一条。

### 界面

工具栏盾牌旁多了一个嗅探按钮，角标是**当前页非分片媒体数**（一个 HLS 页面不会显示成几百）。
设置页新增「媒体嗅探」分区：分类计数、合计体积、逐条置信度与判定依据、内联试听试看、
一键交给多线程下载引擎（地址没有扩展名时自动按容器补上后缀）。

预览有两条如实说明：预览走的是浏览器通用会话，**不带页面所在内核的登录态**，
需要鉴权的资源可能播不了 —— 下载走对应内核会话（带 Cookie），不受此限。

### 真实体积：206 的坑

分片下载时每个分片响应都是 `206`，`Content-Length` 只是**这一段**的长度而非文件全长。
照单全收会把体积报小几十倍，所以引擎优先读 `Content-Range: bytes 0-1023/5242880` 里的总长。

### 边界（嗅不到的情况）

- 用 `blob:` 或 MSE 在页面里现拼的流（部分直播与 DRM 视频）：网络上没有可下载的完整地址；
- 加密的 HLS（`#EXT-X-KEY`）：分片能嗅到，但单独下下来也解不开；
- 需要特殊鉴权头的链接：能嗅到，下载可能被拒。

---

## 十一、移动端阅读增强：无图模式 + 自动拼页

移动端最实际的两个痛点：**流量**和**翻页**。`src/main/nomedia.js` 与 `src/renderer/autopage.js`
分别对付这两个，两者都收在底栏「阅读」开出的同一个底部弹层里（设置页「移动端」分区是同一份数据的桌面入口）。

### 无图模式：必须在请求阶段拦，不能在响应后藏

这是整个功能唯一重要的一条设计决定：

```
✅ 正确：onBeforeRequest 里 callback({cancel:true})   → 请求根本没发出去，省的是真流量
❌ 错误：等图片下载完，再用 CSS 把它 display:none     → 一个字节都没省，纯粹是视觉掩饰
```

档位三选一，拦截名单在 `LEVEL_TYPES` 里写死：

| 档位 | 拦什么 |
|---|---|
| `off` 关闭 | 什么都不拦 |
| `image` 无图 | `image` |
| `image-av` 无图 + 视频 | `image` + `media` |

**`font` 刻意不在任何档位的名单里。** 大量站点的界面图标就是字体（Iconfont / Font Awesome），
拦掉之后按钮变成一堆方框，页面直接散架，而省下的字节远不如图片和视频可观。这是一个明确的取舍，不是遗漏。

**favicon 放行是启发式名单，不是标准**：路径匹配 `/favicon/i` 或以 `.ico` 结尾就放行。
准确率不是 100%，但宁可放宽 —— 浏览器标签上的站点图标消失，用户会当成 bug 报上来。

### 一个必须先解决的冲突：`onBeforeRequest` 只有一个

Electron 的 `webRequest` **每个事件只保留一个监听器**，重复注册是静默覆盖 —— 后注册的把先注册的顶掉，
而且不会有任何报错。广告拦截早就占了 `onBeforeRequest`，所以无图模式**不能另起一个**。

于是有了 `src/main/request-gate.js`：一道闸门，两级判定，顺序固定。

```js
ses.webRequest.onBeforeRequest({ urls }, (details, callback) => {
  if (noMedia) {                                  // 1) 无图判定：纯字符串比档位，最便宜
    const blocked = noMedia.shouldBlock(details);
    if (blocked) { noMedia.record(blocked, details.webContentsId); /*…*/ callback({ cancel: true }); return; }
  }
  if (adblock) {                                  // 2) 广告拦截：规则索引查找
    const hit = adblock.check(details.url, details.resourceType, docHostFor(details.webContentsId));
    if (hit) { /*…*/ callback({ cancel: true }); return; }
  }
  callback({ cancel: false });
});
```

无图排在前面的理由不只是「便宜」：被无图拦下的图片会**先**被记进无图台账，不会同时记到广告拦截头上 ——
打着「省流量」名义的拦截，不该冒充成「拦了广告」。广告规则引擎抛异常时一律放行，绝不因为拦截失败把页面搞挂。

单独成文件还有一个测试上的理由：真机测试（`test-mobile-electron.js`）要装**同一份实现**，
写在 `main.js` 里的匿名闭包没法被测试直接调用。

### 「显示本页图片」需要一个宽限窗口

放行的动作是「记下这个标签页已放行 → 重新加载」。但重载本身会触发 `did-start-navigation`，
而常规逻辑恰恰在那里清掉放行状态 —— 结果就是刚放行马上被自己抹掉，页面重载回来还是没图。

修法是一张 `noMediaGrace: Map<webContentsId, 截止时间戳>`：放行时登记一个 4 秒宽限窗口，
清理逻辑看到窗口没到期就跳过这一次。这不是 hack，是「用户点了一次放行」这个意图必须跨越一次导航才能实现。

放行只对**这一次**有效，下一跳自动失效 —— 否则用户会以为无图模式失灵了。

### 台账刻意不给「省了多少 MB」

`snapshot()` 只报**条数**（总数 / 图片 / 音视频 / 当前标签页），界面上明确写着：

> 只统计条数，没有「省下多少 MB」—— 被拦下的请求压根没有响应头，`Content-Length` 无从得知。
> 按平均图片大小估一个数很好看，但那是编的。

给不出的数字就不给，这条在本项目里是硬规矩。

### 自动拼页：算法必须能被序列化

拼页要在**页面**里跑（要读取 DOM、要改 URL、要插节点），但逻辑又必须能在 Node 里被测试。
修法是 `autopage.js` 的算法全部写成**顶层函数声明**，靠 `Function.prototype.toString()` 拼成脚本注入：

```js
const SERIALIZABLE = [novaAbs, novaAbsolutize, novaSelectorPath, novaFindByPath,
  novaPickContentRoot, novaStripPager, novaFingerprint, novaPickNextUrl,
  novaNearBottom, novaAppendChunk].map((fn) => fn.toString()).join('\n\n');
```

于是 Node / jsdom 测试跑的就是页面里执行的那份源码，不存在「测试版本和行为版本是两份代码」。
硬约束：这些函数不能引用模块级常量或外部闭包。

### 两个必须踩对的顺序

**1. 先取下一页地址，再剔除翻页控件。**

```
✅ next = novaPickNextUrl(doc, target);  novaStripPager(src);   → 翻页控件既是「要删的」也是「地址来源」
❌ novaStripPager(src);  next = novaPickNextUrl(doc, target);   → 链接来源被自己删掉，拼到第二页必断
```

`novaPickNextUrl()` 的优先级：`link[rel~=next]` → `a[rel~=next]` → 锚文本 / `aria-label` / `title`
→ class 名兜底。class 放最后是因为最容易误伤 —— `class="next-post"` 指向的往往是「下一篇」而不是「下一页」。

**2. 拼入内容的相对地址必须绝对化，懒加载属性必须提升为真 `src`。**

站点的懒加载脚本不会跟着分片一起执行，所以 `data-src` / `data-original` / `data-lazy-src` / `data-echo`
要提升成真 `src`，`srcset` 与 `href` 要按 `<base>` 绝对化 —— 否则拼进来的一页全是 404 的破图。

### 去重、封顶与状态条

- **去重按文本指纹**（前 120 个非空白字符），且**只对长度 > 40 的段落生效** ——
  不设长度下限的话，导航项、列表项这些重复短句会被当成重复内容剔掉，正文缺行。
- **单次页数封顶**（5 / 10 / 20，默认 10）。这是**防呆，不是性能考虑**：有些站点的「下一页」
  实际指向另一篇毫不相干的文章，不封顶会一路拼下去。
- **状态条只在真拼了 / 出错了 / 正在拼时才露面**（安静优先），浮在视口底部之上、不占布局，
  上面直接就能「停止」或「撤销」；撤销把整块分片容器（`[data-nova-chunk]`）整体摘掉。
- 每片包一层容器并插一条「第 N 页」分隔线，用户能看出哪里开始是拼进来的。

> **一个由设计稿抓出来的真实缺陷。** 照实现把状态条画进设计板（画框 N）时，标签显示成
> 「自动拼页 · 已拼…」—— 被截断了。根因是绝对定位元素只写了 `left:50%`：shrink-to-fit 的
> **可用宽度 = 包含块宽 − left**，也就是只剩半个视口（约 195 px），`max-width` 是上限、救不了这个下限。
> 修法是在状态条上补 `width:max-content`（`max-width:86vw` 仍然兜底）。
> 这正是设计稿存在的意义 —— jsdom 不做真实排版，这条结构性缺陷在单元测试里量不出来，
> 于是退回一条结构性不变量断言（状态条必须声明 `width:max-content`）作为回归防线。

### 两个底部弹层是互斥的

`openReadSheet()` 里第一件事是 `closeSheet()`（内核弹层），反过来也一样。
两个底部弹层同时挂在屏幕上会互相盖住，用户点哪一层都不对。
这条也被写成断言了：打开阅读弹层后，内核弹层的计算样式必须回到 `none`。

### 真实 Electron 验证：证明「一条请求都没出门」

`npm run check:mobile`（29 项断言）起一个本地 HTTP 服务器，页面里放三张 `<img>` 加一张 CSS 背景图，
然后断言：

```
PASS  三张 <img> 一个请求都没发
PASS  CSS 背景图也没发
PASS  放行名单上的 .ico 照常通过（几个 KB，拦它没意义还会让人以为浏览器坏了）
PASS  图片在页面里确实没解码                    naturalWidth === 0
PASS  被无图拦下的请求不会记到广告拦截头上（省流量不冒充拦截广告）
PASS  放行后图片请求回来了 / 放行状态清掉后图片又被拦了
```

第一条才是这个功能的全部意义所在 —— 它区分了「真的没发请求」和「发了再藏起来」。
拿 `Content-Length` 估算节省量的做法在这里被直接否掉，因为服务端根本没收到请求。

### 边界（如实说清）

- **字体不拦** —— 很多站点的界面图标就是字体，拦掉页面散架；
- **favicon 放行是启发式** —— 路径含 `favicon` 或以 `.ico` 结尾即放行，不是标准；
- **跨域分页拼不了** —— 下一页在不同域名时会被 CORS 挡下，此时**如实报错并停下**，不会静默失败；
- **给不出字节数** —— 无图台账只有条数，没有「省了多少 MB」；
- **不给绝对数字的置信度** —— 拼页只报「已拼接 N 页」，不猜站点一共有几页。

---

## 十二、图标：星芒 + 轨道环

产品定名「吾爱Nova浏览器」之后，第一件事是给它一张能认出来的脸。

`npm run icons` 生成 **34 个文件**（源在 `assets/icon/`，一键重建）：

```
assets/icon/
├─ nova-icon.svg              ★ 主图标（≥48px 用）：星芒 + 轨道环
├─ nova-icon-compact.svg      ★ 16/24px 专用变体
├─ nova-icon-foreground.svg   Android 自适应图标 · 前景层
├─ nova-icon-background.svg   Android 自适应图标 · 背景层
├─ nova-icon-{16,24,32,48,64,128,256,512,1024}.png
├─ nova.ico                   Windows 窗口与任务栏图标
└─ nova-icon-preview.png      ★ 评审用：各规格与蒙版预演排在一张图上
```

### 构图

64×64 圆角方底，品牌蓝紫渐变（`#5B84FF → #3D6BFF → #7C5CFF`，与 `--brand` 同源），
中心一枚亮核，外裹一圈倾斜 24° 的轨道环，星芒四射。一句话：**一颗正在被引力捕获的星**。

### 三条不能省的工程决策

**① 16px 必须有单独一份，不能靠缩放。**
小尺寸下轨道环只剩 `1.6/64 × 16 ≈ 0.4px`，渲染出来是一圈灰雾，反把星芒糊掉。
所以 `compact` 变体**主动删掉轨道环与柔光**，并把星芒腰身从 3.4 加粗到 4.8。
这是「为尺寸设计」而不是「设计完再缩放」。

**② 栅格化不靠 `capturePage`。**
`capturePage` 抓的是物理像素，在 125%/150% 缩放的屏幕上会返回比逻辑尺寸更大的图 ——
16px 的图标实际拿到 20px 再缩回去必然糊。所以改成：**隐藏窗口内建 canvas，按精确 S×S 栅格化 SVG**，
与显示器缩放、窗口尺寸都无关。

**③ 每张 PNG 都有断言，不是「生成完看一眼」。**

- 图标层：圆角之外 `alpha ≤ 8`（不能有方形毛边）、中心必须近白（星芒画上了）
- 背景层：满幅不透明、中心与右下角色差 `≥ 16`（证明渐变真的画了）、中心落在品牌蓝色相里（`B > R 且 B > G`）

第一版断言把背景层也要求「中心近白」，于是报了 6 条假警 —— 自适应图标的背景层
本来就没有星芒。修法是拆成两套断言，不是放宽阈值。

### 图标里的两个坑（都踩过）

**XML 注释里不能出现连续两个连字符。**
SVG 注释里写了 CSS 变量名 `--brand`，文件当场变成非法 XML，
而 Chromium 只回一句含糊的 `The source image cannot be decoded`（`EncodingError`），
既不指文件也不指行号。
Android 的 aapt2 也会报「注释中不允许出现字符串 `--`」—— 同一个坑在两个工具链上各中一次。
**根治办法**：`tools/build-icons.js` 里有一项 `preflight`，先预检四份 SVG 能否被解析，
失败时直接把「哪一行出现了连续两个连字符」连行号和原文打出来。

**桌面端窗口图标要用 `.ico` 而不是 `.png`。**
Windows 会按 DPI 与场景（标题栏 / 任务栏 / 资源管理器）自己挑档位，
给一张 PNG 它只会拉伸。所以 `main.js` 的 `BrowserWindow.icon` 指向 `nova.ico`。

### Android 自适应图标的两个细节

- 前景层按 `translate(54 54) scale(1.7) translate(-32 -32)` 放大到 ≈64.6 单位。
  108×108 画布上只有 66×66 是**保证可见**的安全区，图标画满 108 会被各家蒙版裁掉星芒的角。
- 背景层**铺满 108，不描圆角**。圆角交给系统蒙版 —— 自己再描一遍，
  在方形蒙版机型上就会露出双层圆角的毛边。

---

## 十三、移动版（Android APK）

### ⚠️ 先把「243 KB 的浏览器有没有内核」这件事说清

有人问过一个很合理的问题：**一个浏览器才 243 KB，有内核吗？**

答案是：**没有。** 把 1.1.0 的 APK 解包逐项统计：

```
lib/                0 个 .so      ← 没有任何原生库，遑论内核
res/               234.1 KB       其中 PNG 168.4 KB（占 res 的 72%）
classes.dex        163.8 KB       ← 全部业务逻辑
assets/             21.8 KB       ← 拼页算法与名单（纯文本）
META-INF/            0.1 KB       ← 签名
                ────────────
解包总计          426.6 KB（APK 压缩后 295 KB）
```

`.so` 是 **0 个**，一行渲染代码都没有 —— 移动版的渲染完全交给
**系统 Android WebView**（Chromium 内核，由系统或 Chrome 提供并自动更新）。

体积构成在两个版本之间变了一次，值得说清：

| | 1.0.0 | 1.1.0 | 变化 |
|---|---|---|---|
| `.so` | 0 个 | 0 个 | 没变（本来就没有） |
| PNG 图标 | 164.4 KB | 168.4 KB | 图标又添了几张自适应变体 |
| `classes.dex` | 69 KB | **163.8 KB** | **多线程下载 + 篡改猴 + 规则订阅 + 扩充设置页** |
| 图标占全包 | 约 2/3 | **38.5%** | 业务代码涨上来后，图标不再是主体 |

1.0.0 时图标占了三分之二，所以「243 KB 的浏览器」听着可疑；
1.1.0 体积涨到 295 KB，**涨的部分几乎全是这五项功能的业务代码，不是内核**。
体积从来不是「有没有内核」的证据 —— 真要塞一个，量级差三个数量级。

桌面端也一样：README 第四节里那张「内核程序已下载」的表只对**开发机**成立
（`node_modules/electron` 与 `native/engines/` 是开发依赖，不进安装包）。
`assets/engines/` 这个目录**从来不存在**；桌面端跑的是 Electron 自带的 Chromium。

**真要塞一个独立内核，代价是这个量级：**

| 方案 | 体积 | 状态 |
|---|---|---|
| CEF（Chromium Embedded Framework） | 120–250 MB | 未接入 |
| GeckoView（真 Firefox 内核） | 80–100 MB × ABI | 从未验证（本机无 NDK） |

**结论：移动端不提供内核选择。** 只有一档真内核时，选择器是「假选择」——
它假装你能选，实际怎么点都是同一个。1.1.0 起这个选择器已删除：

- 那一格先换成**下载**（1.1.0），下载与阅读再**并成一格「工具」**（1.2.3，底栏由六格收成五格，
  每格才守得住 44px 触控下限；有任务在跑时标签变成「工具 N」并点亮品牌色）
- 工具栏的内核标识**保留但改为只读**：点开只能看现在跑在什么上面、真实版本号多少，**不能切**
- 设置页「关于」里写明「本应用不内置内核，由系统内核（Chromium）渲染」

### 为什么是原生 Android，而不是 Flutter

最初选的是 Flutter（同一套 UI 能同时出 iOS 与 Android）。但本机 `dart.exe`
**一旦创建带管道的子进程就失败**（`CreateFile failed 231`），而 `flutter analyze` /
`flutter test` / `flutter build apk` 全都要创建带管道的子进程。
逐步排除了所有绕路方案（放开沙箱、经 Python 派生、`cmd /c start` 分离启动），
确认是**环境级**限制而不是工具问题。

于是换纯 Android Gradle 工程（Dart 不参与构建），**36 秒构建成功**。
这是「换路线」而不是「绕过去」—— 有些限制是绕不过的，硬绕只会耗掉两小时还以为自己没找对方法。

### 产物

```
dist/
├─ 吾爱Nova浏览器-1.1.0-release.apk   295 KB  ← 装机用这个
└─ 吾爱Nova浏览器-1.1.0-debug.apk     410 KB
```

版本号**只有一处来源**：`app/build.gradle` 从 `res/values/strings.xml` 的 `app_version` 抽取。
以前是三处硬编码，结果出现过「关于页写 1.1.0、系统设置写 1.0.0、文件名是第三个」的事故 ——
现在抽取不到就构建失败（`throw new GradleException`），不留静默走错的余地。

- `applicationId` `top.wuai.nova`，versionCode 2，minSdk 24 / targetSdk 35
- 已用 `apksigner` 验签通过（v2 方案），`aapt2 dump badging` 确认
  应用名 = 「吾爱Nova浏览器」、两档自适应图标齐全、五档 mipmap 密度完整
- 仓库里带一份明文口令的**开发密钥**（`android-app/keystore/nova-dev.jks`），
  好让任何人都能一条命令构建出可直接安装的包。
  **正式分发必须换成你自己的密钥，而且那份密钥永远不要进仓库。**

### 无图模式：与桌面版的本质差别

| | 桌面版（Electron） | 移动版（Android） |
|---|---|---|
| 判定依据 | `resourceType`，Electron 直接告诉你是不是 image | **只能按 URL 后缀猜** |
| 能拦 | 任何图片，包括无后缀的 | 只有带图片后缀的 |
| 拦不到 | — | `https://cdn.x.com/a/b/c`、`/img.php?id=12` |
| 机制 | `cancel` + 注入占位 CSS | **返回 1×1 透明 GIF（43 字节）** |

Android 的 `shouldInterceptRequest` **不给资源类型**，能拿到的只有 URL、方法、是否主文档。
这不是实现偷懒，是平台能力的硬边界。由此带来两个**必须对用户讲明**的后果 ——
弹层的提示文字里直接写了，不藏着：

1. 无后缀的图拦不住。想拦就得先把响应拉回来，那就已经产生流量，省流量的意义当场归零。
2. 伪静态（`/img.php?id=12`）同理。

**为什么返回透明 GIF 而不是「无响应」**：返回空响应会让 `<img>` 变成「加载失败」——
页面布局可能塌（没算宽高的图是 0×0），控制台还会刷一串错误。
而这 43 字节是一个**合法的成功响应**，页面只会安静地显示成一张空图。
关键在于 `shouldInterceptRequest` 在**请求发出之前**被调用，返回它等于原请求根本没发生过 ——
所以「省流量」是真的省，不是「下完再扔掉」。

> 注意这与桌面端是**两条不同机制**（Electron 的 session 层能干净地 abort），
> 殊途同归，但两条路的 bug 不会是同一个，不会互相掩盖。

### 自动拼页：算法一份都不重写

移动版**不含任何拼页算法**。算法在 `src/renderer/autopage.js` 里，
由 `npm run mobile:sync` 调那个模块的 `buildScript()` 生成 `assets/autopage.inject.js`，
Java 侧只负责注入、读状态、停、撤（`AutoPage.java`，不含算法）。

为什么不重写：拼页的难点全在「找下一页链接」「剔除翻页控件」「去重」「地址绝对化」
这些脏活上，那恰恰是最容易写错、也最需要长期打磨的部分。
重写一份意味着以后每修一次 bug 都得修两遍，两边还会慢慢长歪。
桌面端那套本来就是「序列化成字符串注入页面」的形式 —— 这是它设计时就留好的复用口。

**配置必须在同一次求值里改掉。** 不能「先注入、下一句再改 `config.maxPages`」：
脚本 boot 后会挂滚动监听，首检有 600ms 延迟，看似够。但拆成两次就依赖那个延迟不出意外 ——
而这类「依赖时序恰好来得及」的写法，正是最难查的一类 bug。
所以 `AutoPage.bootSource()` 把注入与配置合成一次求值。

**为什么状态不用 JSON 传**：`evaluateJavascript` 的返回值会被 **JSON 编码一次**
（字符串结果带引号，中文还可能变成反斜杠 u 开头的十六进制形式）。
为了不在 Java 里引一个 JSON 库、也不依赖 Android 框架里那个在 JVM 上会抛 `Stub!` 的 `org.json`，
这里让页面侧拼一个 `~` 分隔的紧凑串，Java 侧按位切分。

### 同步门禁：抓「源改了但没同步」

`npm run mobile:sync` 生成三份产物 + 一份 `SYNC.json`（记录源与产物的 sha256）。
`npm run mobile:check` 靠它抓两类错：

1. **桌面端源改了，产物没重新同步** —— 表现是桌面端修好了、手机端还是老行为，
   而且**没有任何报错**。这是本项目最危险的一种错。
2. **产物被手工改过** —— 下次同步会被覆盖，所以也是错的。

工具自己也验过：往 `media-ext.txt` 追加一行，门禁立刻报「与记录不符」并退出码 1。
一个从不报错的门禁和一个没有门禁一样没用。

### 三条资产刻意不用 JSON

`media-ext.txt` / `adblock-hosts.txt` 是**纯文本行**而不是 JSON：
Android 侧读一行拆一行就够了，于是不用引 JSON 库，
本地单元测试也不用给 `org.json` 打桩。同理 `NovaSettings` 用扁平 `Map<String,String>` 落 SharedPreferences，
`SearchTemplate` 用 `java.net.URLEncoder` 而不是 `android.net.Uri.encode`
（后者是框架类，一调就抛 `Stub!`，整个配置类就没法离线验证了）。

### 标签页：数据与 WebView 分离

**刻意不一个标签配一个 WebView。** 原生 WebView 数量一多内存线性往上走，
而浏览器标签的下限天然是几十个 —— 一个标签一个 WebView 在 Android 上活不过二十个。
所以这里是「标签是数据，WebView 是唯一的」：切换标签只换数据，
真正渲染的那一个被复用，各标签的滚动位置记着，返回时还原。
缩略图切标签时抓一张 **240px 宽**的 —— 不保持原始尺寸，
否则「并排看十几个标签」会变成内存杀手（十几张全屏 Bitmap 轻松吃掉上百兆）。

弹层是用 `setContentView` 叠上去的，所以关闭走「重新装一遍主界面」而不是 `removeView`：
单纯 remove 会把 WebView 一起带走，它还挂在 window 上就再也回不来了。
而**重新 inflate 出来的 WebView 不能直接用** —— 那会每开一次弹层就丢一次页面。
所以 WebView 单独持有，重新 inflate 之后**把原来的实例搬回容器**。
这比 `saveState`/`restoreState` 可靠：后者对第三方 Cookie、JS 状态、媒体播放都保不住。

### 滚动态：顶栏两态与下拉刷新

向下滚动时，底部五格栏**整条隐去**（把 54dp 还给网页），同时**顶栏那一行由地址栏
换成胶囊搜索框**。搜索与地址栏本来就是同一件事，落在同一行上，视线不用来回找；
向上滚一段或滚回顶部，两者一起还原。

两套内容**叠在同一个 `FrameLayout` 里**（`topRow`），而不是上下相接 —— 行高必须恒定。
行高一变，下面的网页就会被整体推一下，滚动中看过去就是页面在抖。
胶囊做成 34dp（与地址栏 `omnibox` 齐平）也不是随手取的：只要它不高于常态那一行的 46dp，
它在 `GONE` 与 `VISIBLE` 之间怎么切，行高都不会变 —— **跳动从结构上被排除**，
而不是靠调动画掩盖。

判定在 `BottomBarReveal.java`（纯类，20 项测试），动画在 `MainActivity#applyReveal`。
动画收尾前会**复核一次状态**：那 300ms 里页面可能已经被拉回顶部，
照老目标收尾就会把刚回来的地址栏又藏起来、而胶囊同时被另一条动画藏起来，顶栏空成一片。

**下拉刷新**是手写的，没有引 `SwipeRefreshLayout`：

| 层面 | 在哪 | 干什么 |
|---|---|---|
| 判定 | `PullToRefresh.java`（纯类，21 项测试） | 起手资格、起手容差、阈值、两段阻尼、松手判定、中断与收尾 |
| 触摸 | `RefreshHost.java`（自定义 FrameLayout） | 拦截下拉、渲染刷新球、把「松手」转成一次刷新 |
| 接线 | `MainActivity#setupPullRefresh` | 页面在不在顶部、刷新做什么（`web.reload()`） |

三处不好绕的地方：

- **必须无视 WebView 发来的 `requestDisallowInterceptTouchEvent(true)`。**
  它在手指按下后就会发这一句（「别拦我，我要自己滚」），拦掉的正是下拉刷新赖以工作的
  那套拦截 —— 照单全收的话 `onInterceptTouchEvent` 从此不再被调用，下拉刷新整体失效，
  而且失效得毫无声息，只是「怎么拉都没反应」。androidx 的 SwipeRefreshLayout 对
  「不支持嵌套滚动的子 View」（WebView 正好是）做的就是同一件事。
- **位移是绝对量而不是增量。** 拦截那一帧，同一个 MOVE 会走 `onInterceptTouchEvent`
  与 `onTouchEvent` 两条路各调一次；按增量累加就会把这一帧算成两倍位移。
- **刷新球的行程与阈值刻意对齐。** `TRIGGER_DP(52) × SLOPE_BEFORE(0.85) ≈ 44dp`，
  正好等于球从屏幕外滑到既定位置的距离（球 34dp + 上边距 10dp）。
  于是「球完全露出来」与「可以松手了」是同一个瞬间，不必额外解释。
  单测里钉住了这条等式 —— 改任一个常量都会先红。

收尾走三条路（`onPageFinished` / `onReceivedError` / 15 秒超时兜底），
且收尾前先判 `isRefreshing()`：这三条会互相抢先，判一下才不会白播第二次收场动画。
被中断（来电、弹窗、多指）走的是 `cancel()` 而不是 `release()` ——
把「被打断」当成「松手」，一次来电就能刷出一个新页面。

### 内核：只有一档真内核，所以没有选择器

| 档位 | 真身 | 1.1.0 能不能选 |
|---|---|---|
| 系统内核（Chromium）| **真内核**（Chromium，由系统提供并自动更新） | —（唯一档位，不需要选） |
| GeckoView | 真实存在的另一套内核，**本包没内置** | ✗ **选择器已删除**，理由见上 |
| 兼容层 | **不是内核**：跑的还是系统内核（Chromium），只换了老 IE 的 UA | ✗ 同样不提供 |

**为什么删掉而不是留一个只能选一档的选择器**：一个只有一枚选项的列表不是选择器，
是装饰。而它比装饰更糟 —— 它会让用户以为「这个浏览器能换内核」，
去点了发现没反应，然后得出「这软件不行」的结论。

`EngineCatalog.java` 与它的 14 项测试**仍然保留**：它们守的是「绝不把兼容层画成真内核、
绝不静默降级」这条底线，以及 UA/文档模式的兼容层取值。
底栏换成下载格之后，工具栏的内核标识改成**只读**——能看见当前跑在什么上面、能读到真实
系统内核版本号，但不能点。这比「能点但只有一种结果」诚实。

### 广告拦截规则订阅更新

拦截名单不再只随包发布，可以从网上更新。四个预置源：EasyList、EasyList China、
uBlock Origin、AdGuard DNS，也可以自己填 URL。

**移动版只吃域名**，这是必须写在界面上的能力边界：

| 规则类型 | 移动版 | 为什么 |
|---|---|---|
| 纯域名 / hosts 格式 / ABP 域名锚（`||ads.com^`） | ✅ | 逐段向上找父域匹配 |
| 元素隐藏（`##.ad`） | ❌ 跳过并计数 | 要注入 CSS，与「不内置内核」的取舍一致 |
| 路径规则（`||cdn.com/ads/`） | ❌ 跳过并计数 | 拦掉整个 CDN 会误伤正常站点 |
| 白名单例外（`@@`） | ❌ 跳过并计数 | 缺了它就等于把用户白名单里的站点也拦掉 |

**三道防线，一条都不能少**（少一条就是「一次更新毁掉用户的拦截设置」）：

1. **解析出 0 条域名绝不落盘** —— 否则等于清空了用户现有的规则
2. **域名数锐减到原来的 1/20 以下拒绝写入** —— 抓到的往往是空壳页面或错误页
3. **返回 HTML 而不是文本时单独报错** —— 订阅地址失效后常重定向到首页，
   不查这个就会把一段 HTML 当成规则存下去

写入走「临时文件 + rename」，中途断电不会留下半份规则。
**订阅与内置名单并存，不是替换** —— 订阅更新失败不该连带把内置的也弄丢。

### 规则解析里的三个真 bug（都会误伤正常站点）

1. **行内注释剥离误伤元素隐藏规则。** 无脑按第一个 `#` 截断，`example.com##.ad` 会留下
   `example.com` —— 变成「拦掉整个 example.com」。修法是只剥「前面是行首或空白」的 `#`。
2. **hosts 格式的订阅一条都读不进来。** `0.0.0.0 ads.example.com` 以 IP 开头，
   被「纯 IP 行」分支拦掉。改成先剥注释、再判 hosts 格式（要求带空格）、最后才判纯 IP。
3. **路径规则被当成整站规则。** `||cdn.com/path/` 截断后与 `||cdn.com^` 都是 `cdn.com`，
   分不出来。改成在截断**前**检查原行的分隔符是 `/` 还是 `*`，是就整条丢弃。

还有一条：**域名匹配不能用 `endsWith`** —— 那会让 `notexample.com` 因为含
`example.com` 被误杀。改成逐段向上找父域。

### 一条必须补的权限

Android 的 release 包**默认没有 `INTERNET` 权限**（模板只在 `src/debug` 里放）。
不显式补上，你会构建出一个「所有网页都打不开」的浏览器 ——
构建不报错，启动不报错，只是每页都白屏。同理 `usesCleartextTraffic="true"`
必须开，否则 API 28+ 默认拒绝 http 明文，等于把一半中文站点挡在门外。

### 385 项单元测试

```
cd android-app && ./gradlew testDebugUnitTest
```

```
ApkProviderTest             7   MainActivityTabRefEdgeTest  6
AutoPageTest               18   MainActivityTest           28
BookmarkStoreTest           8   NoImagePolicyTest          19
BottomBarRevealEdgeTest    10   NovaSettingsCapsuleTest     9
BottomBarRevealTest        10   NovaSettingsTest           25
BuiltinScriptsTest         14   PullToRefreshTest          21
DownloadTaskTest           23   RuleSetTest                22
DownloadTriggerEdgeTest    12   TabTest                    10
DownloadTriggerTest        26   UpdateFlowTest             21
DownloadUiTest             19   UpdateManagerTest          16
EngineCatalogTest          14   UserScriptTest             30
HistoryStoreTest           17
--------------------------------------------------------------
合计 385 项（23 个测试类），失败 0，跳过 0
```

只测纯逻辑，**不实例化任何 Android 组件**（这也是它们被拆成纯逻辑的原因）。
不用 Robolectric：它能把框架在 JVM 上模拟起来，代价是每次跑测慢十几秒，
而这里不需要。`MainActivityTest` 是个例外中的例外 —— 它只调
`rulesStale` / `nightOn` 两个静态纯函数，Activity 一行都没跑起来。

**1.1.0 新增的四套测试逮到的真 bug**（不是「补覆盖率」，是真的错）：

| 类 | Bug | 症状 |
|---|---|---|
| `UserScript` | 逐字符调 `Pattern.quote` 转义 | 拼成 `\Qh\E\Qt\E`，**所有 `@match` 静默失效**，一条都匹配不上 |
| `UserScript` | 块注释元数据头尾找不到 | 尾部剥前导 `*` 后还剩 ` */`，退化成无头模式，**脚本装上但不跑** |
| `UserScript` | `matchOne` 按「有没有 `*`」分流 | `@include` 的正则里 `*` 是量词不是通配符，一条都匹配不上 |
| `RuleSet` | 见上节三条 | 会拦掉正常站点 |
| `NovaStore` | `metaTo` 写死 `#enabled:1` | **篡改猴启停状态存不住**，关掉重开又是开的 |
| `NovaStore` | `metaFrom` 用 `substring(8)` | `#enabled:` 是 9 个字符，跨过冒号取值，永远读成 false |
| `DownloadTask` | URL 末段无名字时仍拼文件名 | `https://x.com/p/` → `https___x.com_p_` 这种带 host 的怪名 |

前面几轮的测试逮到的是：

1. `Tab.hostOf("about:blank")` 返回 `"about"` —— 因为 `about:blank` 没有 `://`，
   代码就继续走「去端口」那一步，把它从冒号处砍断了。
   现在分两条分支：带 `://` 的按 authority 解析，其余原样返回。
2. `AutoPage.unwrapJsString` 把「引号被转义」的串也剥了壳 ——
   输入 `"ab\"` 看着两头都有引号，但最后那个前面是反斜杠，它是被转义的内容不是定界符。
   现在数末尾的连续反斜杠：偶数才算完整定界符。

> 写断言时猜期望值是很浪费的做法 —— 曾为 `sanitize` 的输出连错三次。
> 正确姿势是**临时打一个探针测试打印真实行为**，按真实输出改断言，然后删掉探针。
> 猜出来的断言有时候会把 bug 固化成「预期行为」。

### 尚未实现（如实说明）

- **没有真机 / 模拟器验证。** 本机装了 Android SDK 但没有系统镜像，也没有 emulator，
  所以以上全部是「编译通过 + 385 项单元测试通过 + `aapt2` / `apksigner` 静态校验」，
  **没有在真机或模拟器上跑过**。UI 接线、WebView 生命周期、真实网络请求、
  多线程下载在真实服务器上的行为 —— 这些只有跑起来才暴露的问题，现在都还没暴露。
  这是当前最大的未知项，不是可以忽略的小注脚。
  **「主题切换」「加载图片开关」「订阅自动更新」同样只过了编译与单测** ——
  主题走 `recreate()` 之后的会话恢复、`setBlockNetworkImage` 在各家 ROM 上的实际效果，
  都要装上真机才算数。
- **手势类的改动尤其没法离线验证。** 顶栏两态切换与下拉刷新都只测到了「判定」那一层
  （`BottomBarReveal` / `PullToRefresh` 是纯类，边界在单测里钉死了），
  但它们真正的成败在**触摸事件的走向**上：`RefreshHost` 的
  `onInterceptTouchEvent` 与 WebView 的抢与被抢、无视
  `requestDisallowInterceptTouchEvent` 之后 WebView 会不会有副作用、
  各家 ROM 上的 `getScaledTouchSlop()` 手感 —— 这一层只有真机能回答。
  静态能给的保证只有一条：**逻辑判定没有边界错误**，不是「手势一定跟手」。
- **下载存应用私有目录**（`filesDir/downloads`）。没有接 `FileProvider` 或 `MediaStore`，
  所以系统「用其他应用打开」不可用，只给了「复制路径」。
- **用户脚本只有 `document-end`**，做不到真正的 document-start；不支持 `@grant` 特权 API。
  理由见「八之三」。
- 移动版**没有嗅探、没有 Chrome 扩展、没有收藏、没有历史、没有书签同步**。
- 标签数上限 40，缩略图不做长期缓存。
- `native/engines/` 里的内核程序**只对开发机有效**，不进安装包（见本节开头）。

---
## 十四、设计稿

`design/design-board.html`，包含：设计令牌、内核语义的视觉编码、组件四态、
PC 主界面（画框 A / B）与侧边面板（画框 C / D）、
**全屏设置页（E）**、**下载页多线程分段进度（F）**、**媒体嗅探与置信度分层（G）**，
以及移动端**十一屏**：

| 画框 | 内容 | 变化 |
|---|---|---|
| H | 主界面 | 底栏并成**五格**（原「下载」「阅读」合一格**工具**，有任务在跑时显示「工具 N」）；内核标识为**只读态**（虚线描边 + 无下拉箭头） |
| **R** | **滚动态与下拉刷新（新增）** | 向下滚动后底栏整条隐去、**顶栏那一行由地址栏换成胶囊搜索框**（同高 52px，行高不变）；页面在顶部时往下拉唤出**刷新球**，球完全露出来即可松手 |
| I | 标签页总览 | — |
| **J** | **内核信息（只读）** | **原「内核选择」弹层整个改成只读**：不提供切换，写明「零个 `.so`、不内置内核」、真实 系统内核版本号、以及 GeckoView / CEF / Chrome 扩展三条平台边界 |
| **K** | **设置页（七个分组）** | **从「顶部横向胶囊条」改成七个分组从上到下排**；取值就地显示，不另开选择页 |
| **L** | **下载弹层** | 从桌面版布局的移植改成底栏弹层；一格进度 = 一条连接，退化成单连接时**格数变 1 并写明原因** |
| M / N | 阅读增强弹层、自动拼页运行中 | 底栏并格后入口收进「工具」那一格 |
| **O** | **拦截规则订阅弹层（新增）** | 四个预置源 + 自定义订阅；订阅与内置**并存**；**三道落盘防线**写在界面上 |
| **P** | **篡改猴弹层（新增）** | 第一句就写「这是用户脚本，不是 Chrome 扩展」；三条硬边界（document-end / 无 `@grant` / 无 `@match` 拒装） |

设计规则表也补了 1.1.0 之后的五条正反对照：
**只有一档时不给选择器**、**下载分片能力按实测判不按头猜**、
**规则订阅更新失败不许毁掉现状**、**篡改猴先讲清它不是 Chrome 扩展**、
以及 R 帧背后的两条 —— **顶栏两态必须同高**（行高一变，网页就被整体推一下）、
**刷新球的行程要与阈值对齐**（球完全露出来＝可以松手）。

样式与 `src/renderer/shell.css` **共用同一套 token**，改设计稿等于改产品。

> 本设计稿以 HTML 形式交付，是因为**当前会话没有挂载 Ardot 画布工具**（`create_design` / `batch_edit`
> 调用均返回不可用）。规格已按 Ardot 的结构组织（每个画框 = 一个 frame，每个组件 = 一个 instance），
> Ardot 画布可用时可直接 1:1 上板。

---

## 十五、已实现 / 未实现（诚实清单）

**已实现并验证**

- 三个内核的适配层 + 运行时模式自动判定（原生宿主探测 → 自动升级/降级）
- **三个内核的真实程序已下载并就位**，每个都过了 PE 校验（架构 / 导出表特征）；Electron 归档另做了官方哈希比对
- 内核清单驱动的降级文案：说清"缺的是哪一环"（是没下内核，还是没编译宿主）
- 每个内核独立 session（cookie / 缓存 / UA / 客户端提示全隔离）
- **广告拦截三源架构**：广告终结者 / Adblock Plus / 系统内置，各自独立开关与统计；
  规则全部从上游实时抓取并校验（13.4 万条网络规则 + 4.7 万条隐藏规则）
- 拦截引擎两级索引，单次判定 **31.6 μs**；索引无损性经「与全量扫描对拍」验证
- ABP 语法（域名锚 / 锚点 / 通配 / 例外 / 13 种资源类型 / `$domain=` / 元素隐藏 / 隐藏例外），
  真实规则命中用例 10/10；不支持的扩展语法如实统计跳过
- CRX2/CRX3 解包、XPI 解包、Firefox 清单归一化、browser→chrome 桥
- 标签页 / 地址栏 / 导航 / 历史 / 书签 / 快捷键
- **多线程下载引擎**（`src/main/downloader.js`）：Range 分片并发、各自写文件偏移、无需合并；
  暂停/继续/取消/重试、段内断线重试、跨进程重启续传（sidecar）、并发任务队列、
  服务端不支持 Range 时自动退化为单连接、失败自动交回 Chromium 内建下载器；
  Cookie 取自对应内核的 session（登录态可下）；实测 8 连接并发 334 ms vs 顺序 1350 ms，
  结果经 sha256 逐字节比对，且在真实 Electron session 上验过 Cookie 确实随请求发出
- **媒体嗅探**（`src/main/sniffer.js`）：响应头阶段识别页面音视频与流媒体，纯旁路不改写请求；
  判定分四级置信度并把依据逐条标出，`text/html` 等非媒体类型一票否决；
  覆盖 **100 种扩展名 / 91 种响应类型 / 78 个容器**（单一 HLS 就有 8 种 MIME 写法）；
  HLS 分片默认折叠、流媒体清单不自动探测元数据（避免偷偷拉起整条流）；
  206 响应按 `Content-Range` 取全长而非分段长度；见第十节
- **移动端无图模式**（`src/main/nomedia.js` + `src/main/request-gate.js`）：在 `onBeforeRequest` 阶段
  `cancel`，图片请求根本不发出（真机验证：服务端日志里一条都没有）；三档（关闭 / 无图 / 无图+视频）；
  与广告拦截**共用同一个闸门**（Electron 的 `onBeforeRequest` 重复注册是静默覆盖），无图排在前、
  台账不混记；`font` 任何档位都不拦，favicon 走启发式放行；「显示本页图片」带 4 秒宽限窗口跨越重载，
  放行只对本次有效；台账只报条数、如实写明给不出「省下多少 MB」；见第十一节
- **移动端自动拼页**（`src/renderer/autopage.js`）：滚到底自动接下一页，正文提取 + 翻页控件剔除 +
  文本指纹去重（只对长度 > 40 的段落生效）+ 单次页数封顶（5/10/20）；
  先取链接再删控件、相对地址绝对化、懒加载属性提升为真 `src`；
  状态条支持「停止 / 撤销」（撤销整块摘除分片容器）；算法写成顶层函数声明靠 `toString()` 序列化注入，
  保证**测试跑的就是页面里执行的那份代码**；见第十一节
- **移动版 1.1.0 的五项新能力**：
  - **去掉内核选择项**（不是「藏起来」，是删掉选择器 + 把内核标识改成只读 + 在设置与关于里
    写明「本应用不内置内核」）。删的依据是 APK 内零个 `.so`，只有一档真内核；
    保留的是「绝不把兼容层画成真内核、绝不静默降级」这条底线
  - **广告拦截规则订阅更新**（`RuleSet.java` + `RuleUpdater.java`）：四个预置源 + 自定义订阅，
    域名/hosts/ABP 域名锚三类输入，移动版只吃域名（元素隐藏/路径规则/白名单例外跳过并计数）；
    三道落盘防线（0 条拒写 / 锐减到 1/20 拒写 / 返回 HTML 单独报错）+ 临时文件 rename；
    订阅与内置名单并存而非替换
  - **篡改猴 = 用户脚本**（`UserScript.java`）：`.user.js` / Tampermonkey 格式，
    `@match`/`@include`/`@exclude`/`@require` 逐条匹配；**没有 `@match` 一律拒绝安装**；
    注入包 `try/catch`，脚本语法错误绝不让页面崩；启停状态持久化；
    界面上明确写「这不是 Chrome 扩展」，并列出 `document-end` 与无 `@grant` 两条边界
  - **丰富设置页**：七个分组、20+ 行（通用/阅读增强/广告拦截/篡改猴/下载/隐私与浏览/关于），
    取值就地显示，不摆没接行为的假开关
  - **下载模块**（`DownloadTask.java` + `Downloader.java` + `DownloadTrigger.java`）：
    自研多线程分片（不用 `DownloadManager`，它不支持同文件分片与断点续传）、
    Range 被拒时退回单线程、**断点续传以文件实际长度为准**、
    合并前校验缺片、临时文件合并后 rename；下载触发三档优先级且主文档与页面资源永不触发；
    进度通知节流（变化 >128KB 才通知，否则界面忙于回调反而卡）
- **移动版 1.1.0 收尾的三项**：
  - **首页按钮**：放工具栏地址栏左侧，**不放底栏** —— 底栏格数是硬约束（320dp 机型上每格已经
    贴着 44px 触控下限，再加一格会掉到线下），而工具栏这里原本只有一个只读内核标识，位置是空的。
    与菜单里的「首页」共用同一个 `goHome()`，不写两份
  - **设置页补齐**：补上五个「配置里有字段、界面没有行」的半吊子项 —— 广告拦截总开关、
    篡改猴总开关、订阅自动更新、加载图片、下载记录上限。其中 `rulesAutoUpdate` 与 `loadImages`
    原先**没有任何代码消费**，这一版把开关和实现一起补：前者在冷启动时静默检查、超过 3 天未更新
    才拉一次（失败不弹窗）；后者 `setLoadsImagesAutomatically` + `setBlockNetworkImage` 双写。
    顺带修掉一个既存假开关：**「主题」设置保存后从未被应用** —— 缺 `values-night/colors.xml`
    （中性令牌早在 `colors.xml` 里定义好却没人引用），且 uiMode 的覆盖只能发生在
    `attachBaseContext`，所以切换走 `recreate()`
  - **关于页重设计**：从 NovaAlert 纯文字框改成独立面板，按「身份 / 能力 / 边界 / 验证状态」
    四段展开 —— 先给能力再给边界，反过来写会让一个做了不少事的应用看起来像半成品；
    「尚未真机验证」用警示色边条框在最后，不当小注脚
- PC 与移动端双布局、浅色深色双主题、UI 预览模式（无需 Electron 也能点）
- 内核降级强制提示条（不静默降级）+ 设置页内的「内核二进制」一览
- **独立全屏设置页**：12 个分区、实时角标、窄屏降级为横向胶囊条；搜索模板 / 新标签页 /
  会话恢复（真实记录并还原标签页）/ 白名单管理 / 清空书签 / 清空站点数据 / 恢复默认设置
- **修复了一个真实浏览器才会暴露的 bug**：`hidden` 属性被作者样式表的 `display:flex` 盖掉，
  导致移动端标签总览层与内核底部弹层**一直铺满整个窗口**。用 Electron 30 实测确认后，
  用「全局 `[hidden]` 兜底 + 覆盖层 `:not([hidden])` 守卫」双保险修掉，并留下真实引擎回归脚本

**未实现（需要你补的）**

- `trident-host.exe` / `gecko-host.exe` 两个原生宿主二进制 —— **内核运行时已经下好了，只差宿主外壳**；
  协议、编译指引、Gecko 的 32 位约束都写在 `native/README.md`。本机编译被沙箱安全策略拦住
  （`csc.exe` 属"任意代码执行"，禁用），所以这一步必须你在装了 VS 的机器上做
- 原生桥接模式下的广告拦截（宿主网络栈不经过 Electron session，需宿主侧代理 —— 已在 native/README 说明）
- 移动端原生容器（Capacitor / WebView 壳）—— 接口已就绪，差一个容器实现
- **移动版的一切尚未在真机 / 模拟器上跑过** —— 见第十三节「尚未实现」第一条。
  当前所有保证都止于「编译 + 385 项单测 + 静态校验」，这是最大的未知项
- **移动版下载存私有目录**，未接 `FileProvider` / `MediaStore`，系统「用其他应用打开」不可用
- **移动版用户脚本只有 `document-end`**，做不到真正的 document-start；无 `@grant` 特权 API；
  界面已写明，不假装是完整 Tampermonkey
- **移动版篡改猴不是 Chrome 扩展** —— WebView 没有扩展宿主，这是平台边界不是实现取巧
- **下载：需要 POST 或特殊鉴权头的链接** —— 多线程引擎只能发 GET，这类下载会自动交回
  Chromium 内建下载器（不是静默失败，任务上会写明「已交回内建下载器」）
- **下载：换镜像续传** —— 不做。换了源就等于换了文件，按旧游标拼接必然产出坏文件
- **下载：BT / 磁力 / 分片校验哈希** —— 不做，本引擎只处理 HTTP(S) 的单个响应体
- **嗅探：`blob:` / MSE 现拼的流** —— 网络上没有可下载的完整地址，嗅不到（部分直播与 DRM 视频属此类）
- **嗅探：加密 HLS（`#EXT-X-KEY`）** —— 分片能嗅到，但单独下下来解不开，需要密钥与解密步骤
- **嗅探：流媒体自动合并** —— 只给出清单地址，不做 m3u8 → 完整视频的下载与合并
- **嗅探：需要特殊鉴权头的媒体** —— 能嗅到，但下载走的是通用 GET（带对应内核的 Cookie），
  若站点依赖自定义头校验则可能被拒
- **无图模式：字体一律不拦** —— 很多站点的界面图标就是字体（Iconfont / Font Awesome），
  拦掉页面直接散架，而省下的字节不如图片和视频可观。这是取舍，不是遗漏
- **无图模式：favicon 放行是启发式名单** —— 路径含 `favicon` 或以 `.ico` 结尾即放行，
  不是标准；准确率不是 100%，但宁可放宽（标签图标消失会被当成 bug 报上来）
- **无图模式：给不出「省下多少 MB」** —— 被拦下的请求压根没有响应头，`Content-Length` 无从得知。
  按平均图片大小估一个数很好看，但那是编的，所以台账只有条数
- **无图模式：只拦 `<img>` / `media` 类请求** —— 用 CSS 绘制、或用 JS 把图片当数据塞进
  `<canvas>` 的做法绕不过也拦不到，属于已知边界
- **自动拼页：跨域分页拼不了** —— 下一页在不同域名时会被 CORS 挡下，此时如实报错并停下，不会静默失败
- **自动拼页：站点自己的懒加载脚本不会跟着执行** —— 已把 `data-src` 一类属性提升为真 `src` 作为补偿，
  但依赖复杂 JS 初始化才能渲染的正文仍可能拼不全
- **自动拼页：不做站点级适配规则** —— 只靠通用启发式（`rel=next` / 锚文本 / class 兜底），
  小众模板可能找不到下一页。找不到就如实说「本页没找到下一页」，不猜
- **自动拼页：拼入内容只读** —— 分片里的表单、按钮不会带交互逻辑，撤销即整体摘除
- **广告终结者的官方规则源已停服**（`sub.adtchrome.com` 502），当前用同血统的 ChinaList 维护版
  还原其覆盖面；官方地址仍保留在抓取器首选位，恢复后自动切回
- 请求改写类规则（`$redirect=` `$csp=` `$removeparam=` 等）：不做，如实统计跳过 767 行
- **站点级 Cookie 策略开关**：`relaxThirdParty` 字段在配置里存在，但没有接到 Electron 的 session
  策略上（Electron 没暴露 per-session 的第三方 Cookie 策略 API），所以设置页里如实写明「本版未实现」，
  而不是摆一个点了没反应的开关
- 扩展商店 / 自动更新 / 同步、密码管理、PDF 阅读器

**关于「视觉验证」的分工**

本机有 `node_modules/electron`（就是真实 Chromium），所以补了四条真实引擎脚本：

- `npm run check:hidden` —— 层叠回归（唯一能判定 `hidden` 是否真的生效的地方）
- `npm run check:downloads` —— 下载接线（唯一能验证「请求带上了 session 的 Cookie」的地方）
- `npm run check:sniffer` —— 嗅探真机验证（唯一能证明 `onHeadersReceived` 真的被触发、
  且回调没有漏调的地方 —— 漏一次那个请求就会永久挂起，所以拿「页面里所有 fetch 都返回了」来证）
- `npm run check:mobile` —— 无图模式真机验证（唯一能证明「图片请求一条都没出门」的地方：
  本地 HTTP 服务器的访问日志里没有 `/img/*`，而不是「加载了再隐藏」）
- `npm run shots` —— 截图落到 `screenshots/`

`npm test`（jsdom）负责结构与交互断言，跑得快；但**jsdom 对 `!important` 的实现与规范不一致**
（同特异度时按源码顺序、忽略 `important`），凡是依赖层叠的结论都不能由它下判断，
所以那边只断言「引擎无关的不变式」（比如覆盖层规则必须带 `:not([hidden])`），实际效果交给上面的真实引擎脚本。

下载引擎与嗅探引擎各走第三条路：**真起一个 HTTP 服务器让它们真跑**
（`npm run test:downloader` / 直接调 `sniffer.observe`），不拿 mock 冒充验证。
并发这种事，只有数真实连接和量真实耗时才算数——mock 出来的计数器证明不了任何东西。

自动拼页走的是第四条路：**算法写成顶层函数声明，靠 `toString()` 序列化后注入页面执行**。
所以 jsdom 测试跑的就是页面里那份源码，而不是一份长得像它的复制品 ——
这类功能最大的风险从来不是逻辑写错，而是「测试版本和行为版本悄悄分叉」。

