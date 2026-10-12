# 原生内核宿主（Native Kernel Host）

Nova 的三内核能力分成两层：

| 层 | 负责 | 状态 |
|---|---|---|
| **Chromium / Blink** | 进程内真实渲染 | ✅ 已实现（Electron 自带 Chromium） |
| **Gecko / Trident 的「原生桥接」** | 由本目录的原生宿主进程渲染，Nova 通过 NDJSON 协议收发 | ⚠️ 内核二进制**已下载就位**，宿主二进制待编译 |

没有宿主二进制时，内核适配层会**如实降级为兼容层**（Chromium 渲染 + 伪造该内核的 UA / 客户端提示 / 文档模式 / API 垫片），
并在界面上明确标注「兼容层」+ 弹出降级原因提示条。**绝不静默伪装成真内核。**

---

## 〇、内核二进制：已下载，并已做 PE 校验

用 `bash tools/fetch-engines.sh` 拉取，`node tools/check-engines.js` 校验。
当前 `native/engines/` 的实际内容（每个都验过 PE 头、架构、导出表）：

| 内核 | 位置 | 版本 | 体积 | PE 校验 |
|---|---|---|---|---|
| Chromium · Electron | `node_modules/electron/dist/` | Electron 30.5.1 | 254 MB | PE32+ **x64**，导出 3126（V8） |
| Chromium · CEF | `native/engines/chromium-cef/` | CEF 154.0.34 / Chromium 154.0.8037.98 | 422 MB | PE32+ **x64**，导出 249（`cef_*`） |
| **Gecko** · GeckoFX 45 | `native/engines/gecko-xulrunner45/output/` | XULRunner 45.0.0.5873 | 74 MB | PE32 **x86**，导出 1847（`NS_*`） |
| Gecko · 官方 XULRunner | `native/engines/gecko-xulrunner41/xulrunner/` | XULRunner 41.0.2（2015 官方归档） | 75 MB | PE32 **x86**，导出 1123 |
| **Trident** · MSHTML | `C:/Windows/System32/mshtml.dll` | 系统组件（**无需下载**） | 22 MB | PE32+ **x64**，导出 22 |

> Electron 的 103.8 MB 发布包还额外做了**上游哈希比对**：本地 SHA-256 `443119bb…b4b3` 与 npm 包内官方
> `checksums.json` 记录**逐字节一致**，证明 Chromium 主内核未被篡改。

### ⚠️ 一条必须记住的约束：Gecko 是 32 位的

GeckoFX 45 与 XULRunner 41 的 `xul.dll` **都是 PE32 / I386（32 位）**。
这直接决定了两件事：

1. `gecko-host.exe` **必须编译为 x86**（平台目标选 `x86`，**不要用 `AnyCPU`** —— 在 64 位系统上 AnyCPU 会以 64 位进程启动，加载 32 位 `xul.dll` 必然失败，报 `BadImageFormatException`）。
2. 如果做成 x86 宿主，它与 Nova 主进程（x64）之间**只能走进程间通信**，不能用同进程指针 —— 这正是本目录 NDJSON 协议存在的原因。

Chromium/CEF 那侧是 x64，与 Electron 主进程同架构；Trident 两种位宽的 `mshtml.dll` 系统里都有，宿主按需要选。

### 抓取与校验命令

```bash
bash tools/fetch-engines.sh              # 下载全部三个内核（可 --only=gecko 只抓 Gecko）
node tools/check-engines.js              # 校验并生成 native/engines/manifest.json
node tools/check-engines.js --json       # 打印清单原文
```

---

## 一、协议（NDJSON over stdio）

宿主启动方式：把可执行文件放在 **`native/bin/`** 下，命名必须精确匹配：

```
native/bin/trident-host.exe     ← IE / MSHTML 宿主
native/bin/gecko-host.exe       ← Gecko / GeckoFX 宿主
```

Nova 以 `spawn(exe, ['--ndjson'])` 启动，stdin/stdout 上跑**换行分隔的 JSON**（每行一个完整 JSON 对象，UTF-8）。

### 1. 握手（宿主 → Nova）

宿主初始化完成后必须**立刻**输出一行：

```json
{"t":"ready","kernel":"trident","version":"11.0.9600.19574"}
```

Nova 收到 `ready` 才把该内核标记为 `bridge`（原生桥接）；5 秒内没收到则判定失败并降级为 `compat`。

### 2. Nova → 宿主（指令）

每条指令都带自增 `id`，宿主需在同一次交互里回一条同 `id` 的 `reply`。

| t | 载荷 | 说明 |
|---|---|---|
| `create` | `{id, w, h}` | 创建一个渲染视图，返回 `viewId` |
| `navigate` | `{id, viewId, url}` | 导航 |
| `resize` | `{id, viewId, w, h}` | 改尺寸 |
| `input` | `{id, viewId, kind, ...}` | 输入事件，见下 |
| `eval` | `{id, viewId, code}` | 执行脚本，reply 带 `result` |
| `destroy` | `{id, viewId}` | 销毁视图 |
| `stop` | `{id}` | 退出前清理 |

`input` 的 `kind`：

```json
{"t":"input","id":9,"viewId":1,"kind":"mouse","type":"down","button":"left","x":300,"y":180}
{"t":"input","id":10,"viewId":1,"kind":"mouse","type":"move","x":301,"y":181}
{"t":"input","id":11,"viewId":1,"kind":"wheel","deltaX":0,"deltaY":-120,"x":300,"y":180}
{"t":"input","id":12,"viewId":1,"kind":"key","type":"down","key":"Enter","code":"Enter","mods":["ctrl"]}
{"t":"input","id":13,"viewId":1,"kind":"text","text":"你好"}
```

### 3. 宿主 → Nova（事件与回执）

```json
{"t":"reply","id":9,"ok":true,"viewId":1}
{"t":"frame","viewId":1,"seq":1043,"w":1024,"h":768,"format":"bgra","data":"<base64>"}
{"t":"title","viewId":1,"title":"示例站点"}
{"t":"url","viewId":1,"url":"https://example.com/login.aspx"}
{"t":"cursor","viewId":1,"cursor":"pointer"}
{"t":"log","viewId":1,"level":"info","message":"documentMode=11"}
{"t":"error","id":9,"message":"导航失败：DNS 解析错误"}
```

**`frame` 的帧格式约定**：`format` 只支持 `bgra`，`data` 是 **base64 编码的 BGRA 原始像素**（每像素 4 字节，
stride = `w * 4`，无 padding）。Nova 侧直接用 `Buffer.from(data,'base64')` 解出，再用
`nativeImage.createFromBitmap(buffer, {width, height})` 变成可绘制的图。
选择 BGRA 原始像素而不是 PNG/JPEG，是为了避免每帧一次 codec，代价是带宽大 —— 所以宿主**必须做帧率合并**：
同一 `viewId` 在 16 ms 内只推最后一帧，且只在内容真正变化时推。

---

## 二、Trident 宿主（`trident-host.exe`）怎么搭

用 C# / .NET Framework 4.x 写一个控制台宿主，核心就三件事：

```csharp
// 1) MSHTML：进程内 WebBrowser 控件（底层即 IE11 的 Trident）
var browser = new WebBrowser();
browser.ScriptErrorsSuppressed = true;
browser.DocumentCompleted += (s, e) => Emit("url", browser.Url.ToString());

// 2) 强行钉死在 IE11 文档模式（否则会掉进 IE7 兼容视图）
SetFeatureBrowserEmulation(11001); // HKCU\...\FEATURE_BROWSER_EMULATION = 11001
browser.Navigate(url);

// 3) 把控件渲染结果抓成位图推给 Nova
using (var bmp = new Bitmap(w, h)) {
    browser.DrawToBitmap(bmp, new Rectangle(0, 0, w, h));
    var px = bmp.LockBits(new Rectangle(0,0,w,h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    // Format32bppArgb 在内存里就是 BGRA，直接 base64 推 frame
    PushFrame(viewId, w, h, px.Scan0, px.Stride);
}
```

要点与坑：

- `WebBrowser` 依赖 **WebBrowser 控件所在的 STA 线程**；宿主主循环要标 `[STAThread]`，并且渲染与协议 IO 分线程。
- `DrawToBitmap` 抓的是控件自身的绘制，**不能抓 GPU 合成层**；IE11 在 WebBrowser 控件里默认走软件渲染，所以可行。
- 想拿真·硬件加速 + 更全的 IE11 行为，改走 **`IWebBrowser2` + `IViewObject::Draw`** 或
  **Edge WebView2 的 IE 模式**（`--ie-mode`，但那是 Edge 侧能力，需要 Edge 已安装）。
- `FEATURE_BROWSER_EMULATION` 必须写进注册表，键名 = 宿主的可执行文件名（`trident-host.exe`），
  值 `11001` = IE11 edge 模式，`11000` = IE11 默认模式。写完需要重启宿主进程。

---

## 三、Gecko 宿主（`gecko-host.exe`）怎么搭

**运行时已经下好了**，直接指向它即可：

```
native/engines/gecko-xulrunner45/output/     ← xul.dll / omni.ja / nss3.dll / mozglue.dll …
native/engines/gecko-xulrunner45/lib/        ← Geckofx-Core.dll / Geckofx-Winforms.dll（.NET 绑定）
```

**路径 A：GeckoFX（推荐，.NET）**

```csharp
// 工程必须把「平台目标」设为 x86 —— 见上文 §0 的 32 位约束
Xpcom.Initialize(@"D:\...\novabrowser\native\engines\gecko-xulrunner45\output");

var browser = new GeckoWebBrowser { Dock = DockStyle.Fill };
browser.DocumentCompleted += (s, e) => Emit("url", browser.Url.ToString());
browser.Navigate(url);
// 帧推送同 Trident：抓位图 → BGRA → base64
```

- `Xpcom.Initialize` 的参数是**含 `xul.dll` 的那一层目录**（本仓库里是 `…/output`，不是它的上级）。
- 需要的引用：`Geckofx-Core.dll`、`Geckofx-Winforms.dll`（在 `lib/`）。把 `output/` 整个目录复制到宿主输出目录，
  或让宿主运行时按上面的绝对路径初始化。
- `Xpcom.Initialize` **只能调用一次**；协议里的 `create` 要支持多视图时共用同一个 Xpcom。
- GeckoFX 与 Gecko 版本强绑定（这里是 45 ↔ 45.0.0.5873），升级必须成对升。
- 若改用官方 XULRunner 41（`native/engines/gecko-xulrunner41/xulrunner/`），需要配套 **GeckoFX 41**，
  当前仓库里的 GeckoFX 是 45 版，**不能混用**。

**路径 B：内嵌 Firefox 的 `-embedding`（已废弃，仅作参考）**

旧版 Firefox 支持 `-embedding` 提供嵌入窗口句柄，新版已移除。除非你自己编译 Gecko，否则不要走这条。

> 备注：官方 XULRunner 归档只到 **41.0.2**（2015 年 Mozilla 停止发布），所以 Gecko 45 只能从 NuGet 的
> `GeckoFX` 包取（该包内嵌了 XULRunner 45 运行时）。这是当前唯一拿得到 Gecko 45 的渠道。

---

## 四、接了宿主之后会发生什么

1. 把 `trident-host.exe` 放进 `native/bin/`。
2. 在 Nova 里打开 **设置 → 内核桥接 → 重新探测原生内核宿主**。
3. 对应内核的模式徽标从 <span>兼容层</span> 变成 **原生桥接**，切换器上的橙色角点消失，提示条不再弹出。
4. 该内核的 `partition` 仍然独立，广告拦截仍然生效（拦截发生在 Nova 的 session 层，
   但**原生宿主自己的网络栈不走 Electron session** —— 见下）。

> ⚠️ **已知边界（必须知道）**
> 一旦走原生宿主，页面由宿主的网络栈加载，**Nova 的 `webRequest` 广告拦截不再覆盖该内核的页面请求**。
> 想在这条路径上保留拦截能力，有两种做法：
> - 宿主实现系统级代理，并把请求交给 Nova 的规则引擎判定（推荐，可用本地 HTTP 代理 + 规则查询接口）；
> - 或在宿主内嵌一份规则引擎（相当于把 `src/main/adblock.js` 的 matcher 移植过去）。
> 这两种都还没实现，属于下一阶段工作。当前 `compat` 模式下拦截是完整生效的。
