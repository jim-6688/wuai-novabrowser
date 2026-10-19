# 原生内核宿主（Native Kernel Host）

Nova 的双内核能力分成两层：

| 层 | 负责 | 状态 |
|---|---|---|
| **Chromium / Blink** | 进程内真实渲染 | ✅ 已实现（Electron 自带 Chromium） |
| **IE / Trident 的「原生桥接」** | 由本目录的原生宿主进程渲染，Nova 通过 NDJSON 协议收发 | ✅ 宿主随包提供（`native/bin/trident-host.exe`） |

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
| **Trident** · MSHTML | `C:/Windows/System32/mshtml.dll` | 系统组件（**无需下载**） | 22 MB | PE32+ **x64**，导出 22 |

> Electron 的 103.8 MB 发布包还额外做了**上游哈希比对**：本地 SHA-256 `443119bb…b4b3` 与 npm 包内官方
> `checksums.json` 记录**逐字节一致**，证明 Chromium 主内核未被篡改。

### 抓取与校验命令

```bash
bash tools/fetch-engines.sh              # 下载全部内核
node tools/check-engines.js              # 校验并生成 native/engines/manifest.json
node tools/check-engines.js --json       # 打印清单原文
```

---

## 一、协议（NDJSON over stdio）

宿主启动方式：把可执行文件放在 **`native/bin/`** 下，命名必须精确匹配：

```
native/bin/trident-host.exe     ← IE / MSHTML 宿主
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

## 三、接了宿主之后会发生什么

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
