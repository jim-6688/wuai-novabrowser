# 吾爱Nova浏览器 · 官网

静态站点，托管在**腾讯云 EdgeOne Pages**。无构建步骤——目录下是什么，线上就是什么。

## 正式域名

```
https://nova.52ta.top
```

App 端的更新地址在 `android-app/.../UpdateManager.java` 的 `UPDATE_URL`，
现指向 `https://nova.52ta.top/version.json`。**换域名只改这一处。**

> `UPDATE_URLS` 里还留了一个兜底地址（`nova-browser-site.app.workbuddy.host`）。
> 这是 App 唯一的自救通道，而它挂在域名这根最脆弱的线上：证书过期、DNS 改错、
> 域名忘了续，任何一个都会让「检查更新」彻底哑掉 —— 而启动那次检查是静默的，
> 用户不会收到任何提示，只会被永久钉在旧版本上。多留一个地址等于上双保险。
> 正常情况下永远用不到后者。

## 目录结构

```
site/
├── index.html            首页（介绍 + 下载）
├── version.json          【关键】自动更新清单，App 端与官网都从它读版本号
├── edgeone.json          构建与响应头声明（EdgeOne 会读它）
├── download/
│   └── nova-<版本>.apk    官网直链安装包（每次发版新增同名文件）
└── assets/
    ├── css/style.css     样式（颜色令牌与 App 端 colors.xml 对应）
    └── js/app.js         读取 version.json 并渲染版本信息
```

## 一、首次接入 EdgeOne Pages

### ⚠️ 最重要的一条：根目录必须填 `site`

仓库**根目录**下有一份 `package.json`（桌面端 Electron 用的），
它的 `devDependencies` 里挂着 `electron ^30.0.0`——一个约 100MB 的二进制。
EdgeOne 一旦把根目录当作项目根，就会执行 `npm install` 去拉 Electron，
结果不是超时就是失败。**这就是部署失败的典型根因。**

根目录填 `site` 之后，EdgeOne 只会看到这个目录里的 6 个静态文件，
既没有 `package.json` 也没有任何依赖，构建必然秒过。

### 方案 A：Git 集成（推荐，推送即发布）

1. 打开 **腾讯云 EdgeOne 控制台** → **Pages**
2. 新建项目 → 代码来源选 **Gitee**
3. 首次会跳到 Gitee 授权页，确认授权后回到控制台
4. 选择仓库：`jinghe-net / i-adore-the-nova-browser`
5. 构建部署配置：
   - **根目录**：`site` ← 必填，不能留空、不能填 `/`
   - **框架预设**：`Other`
   - 其余（构建命令 / 输出目录 / Node 版本）**留空即可**
6. 保存并部署

> 为什么其余可以留空：目录下放了 `edgeone.json`，它已经把构建行为声明清楚了——
> 不装依赖，把 `assets/`、`download/`、`index.html`、`version.json` 复制进 `dist`，
> 输出目录就是 `./dist`。控制台留空时 EdgeOne 会读这个文件。

`edgeone.json` 里另外声明了两条缓存规则，都是必要的：

| 规则 | 原因 |
| --- | --- |
| `/version.json` → `no-store` | 这个文件是自动更新的依据。若被 CDN 缓存，用户会一直读到旧版本号，更新功能形同失效 |
| `/download/*.apk` → 强制 `application/vnd.android.package-archive` | 个别节点可能识别错 MIME，导致 Android 收到后不认作安装包 |

### 方案 B：直接上传（最省事，绕开一切构建）

若 Git 集成反复失败，可完全跳过构建：

1. EdgeOne Pages → 新建项目 → 代码来源选**直接上传**
2. 上传 `site` 目录**里面的内容**（即 `assets/`、`download/`、`index.html`、`version.json`）
3. 上传完即可访问

> 注意：上传的是 `site` **目录内的内容**，不是 `site` 目录本身。
> 若把 `site` 整个传上去，线上会变成 `xxx.edgeone.app/site/index.html`，
> 而根路径 `/` 因找不到 `index.html` 而 404。

### 部署失败怎么排查

| 报错 / 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Output directory xxx does not exist!` | 输出目录没配或配错 | 根目录确认是 `site`；或改用方案 B |
| 构建日志卡在 `npm install` 不动 | 根目录填成了仓库根，正在拉 Electron | 根目录改成 `site` |
| 部署成功但访问 `/` 是 404 | 上传/输出的根里没有 `index.html` | 确认 `index.html` 在输出目录顶层 |
| `File size limit exceeded (25 MiB)` | 单文件超限 | 当前 APK 仅 300KB 左右，正常不会触发 |
| `File count exceeds project limit` | 文件数超 20000 | 当前仅 5 个文件，正常不会触发 |
| **推送后线上内容没变** | 自动部署没触发，或构建失败回滚到了上一版 | 去控制台看部署记录的状态，手动点「重新部署」 |
| **HTTPS 打不开，HTTP 可以** | 自定义域名的证书还没签发 | 域名管理里确认 HTTPS 已开启，等签发（见第二节） |

部署完成后会得到一个默认域名，形如 `xxx.edgeone.app`，此时官网已可访问。

### ⚠️ 判断线上是否更新过，别看文件大小

`1.1.0` → `1.2.0` 这类版本号替换**字节数完全相同**（都是 5 个字符），
`index.html` 改了版本但大小一个字节都没变。用大小判断会得出「已经更新」的错觉。
以内容为准：

```bash
curl -s https://你的域名/version.json | head -5   # 看 version 字段
```

## 二、绑定自己的域名

1. 在 EdgeOne Pages 项目 → **域名管理** → 添加自定义域名
2. 按提示在你的域名解析商处添加 **CNAME** 记录，指向 EdgeOne 给出的目标地址
3. 等待 DNS 生效 + 证书自动签发（通常几分钟）

### ⚠️ 证书没签发时，HTTP 能开、HTTPS 不能开

这一步最容易漏：HTTP 访问一切正常，只有 HTTPS 握手失败，
而 App 的更新检查走的是 HTTPS。

```bash
# 看服务端给的是谁的证书。不是你的域名，就说明证书还没配好
echo | openssl s_client -connect nova.52ta.top:443 -servername nova.52ta.top 2>/dev/null \
  | grep -E "subject=|verify error"
```

正常应看到 `subject=CN = nova.52ta.top` 且没有 `verify error`。
若看到 `CN=*.cdn.myqcloud.com` 这类共享证书 + `verify error:num=19`，
说明 EdgeOne 还没为这个域名签发证书：

- 去 **域名管理** 确认该域名的 HTTPS 状态是「已开启 / 证书已签发」
- 若卡在「待验证」，检查 CNAME 是否真的生效、有没有和别的记录冲突
- 签发一般几分钟，偶尔要等几十分钟

> 证书没好之前，App 的更新检查会被静默跳过（HTTPS 握手失败属于「查不到」，
> 不弹错误），此时 `UPDATE_URLS` 里的兜底地址会顶上，更新功能不会断。

> 域名生效后，**App 里的更新地址也要改一处**：
> `android-app/.../UpdateManager.java` 的 `UPDATE_URL` 常量。

## 三、发新版流程

1. 更新 App 版本号（`res/values/strings.xml` 的 `app_version`）与 `build.gradle` 的 `versionCode`
2. 构建 release APK：
   ```bash
   npm run mobile:build      # debug
   # 或
   cd android-app && ./gradlew assembleRelease
   ```
3. 把 APK 放到 `site/download/nova-<版本>.apk`
   （旧版本的 APK 顺手删掉：官网只链接最新版，留着既占仓库也没人能下到）
4. 更新 `site/version.json`：
   - `version` / `versionCode`
   - `updatedAt`
   - `sha256`（`sha256sum site/download/nova-<版本>.apk`）
   - `size`（字节数）
   - `changelog`（只写相对上一版的变化，用户关心的是「这次给我带来了什么」）
   - `downloads[]` 两条的 `url` / `size` / `sha256` 都要跟着改，
     尤其是 Gitee 那条链接里带着版本号
5. **同步改 `index.html` 里的静态链接**（第 44、109、116、117 行附近的
   版本号与 `download/nova-<版本>.apk`）。
   官网的下载按钮是静态 HTML 写的、不依赖 JS（原因见后），所以发版时
   这里必须手动跟着改，JS 读到的清单只会覆盖它、不会替你填。
6. 去 Gitee 创建 Release 并上传 APK —— **这一步没法自动化**：
   `version.json` 里的 Gitee 链接指向 `releases/download/v<版本>/`，
   而 Release 不会凭空出现。不上传的话，用户点第二个按钮是 404。
   标签名填 `v<版本>`，附件名与清单里的一致（`nova-<版本>.apk`）。
7. 推送到 Gitee：

   ```bash
   git add -A
   git commit -m "release: v<版本>"
   git push origin main
   ```

EdgeOne Pages 会自动触发重新部署，几分钟后线上即为新版。

> **推送完一定要验一次。** 自动部署可能没触发，也可能构建失败后回滚到上一版 ——
> 这两种情况控制台之外看不出来，页面照样能打开，只是内容是旧的。
> 而且**别用文件大小判断**（见第一节末尾），要看 `version.json` 里的 `version` 字段。
> 内容没变就去控制台手动点「重新部署」。

## 四、version.json 字段说明

| 字段 | 说明 |
| --- | --- |
| `version` | 展示用的版本名，如 `1.1.0` |
| `versionCode` | 整数版本号，App 端用它判断是否更新（必须递增） |
| `channel` | 渠道标识，`release` / `beta` |
| `updatedAt` | 更新日期，`yyyy-MM-dd` |
| `mandatory` | 是否强制更新 |
| `minVersionCode` | 仍可继续使用的版本码下限，低于它则强制更新 |
| `changelog` | 更新说明数组 |
| `downloads` | 下载地址数组，按顺序展示 |

`downloads[].url` 中，官网直链写成**相对路径**（如 `download/nova-1.1.0.apk`），
这样更换域名时清单文件本身无需改动，由使用方自行拼接基座地址。
