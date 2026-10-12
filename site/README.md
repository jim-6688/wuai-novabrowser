# 吾爱Nova浏览器 · 官网

静态站点，托管在**腾讯云 EdgeOne Pages**。无构建步骤——目录下是什么，线上就是什么。

## 目录结构

```
site/
├── index.html            首页（介绍 + 下载）
├── version.json          【关键】自动更新清单，App 端与官网都从它读版本号
├── download/
│   └── nova-1.1.0.apk    官网直链安装包（每次发版覆盖同名文件）
└── assets/
    ├── css/style.css     样式（颜色令牌与 App 端 colors.xml 对应）
    └── js/app.js         读取 version.json 并渲染版本信息
```

## 一、首次接入 EdgeOne Pages

1. 打开 **腾讯云 EdgeOne 控制台** → **Pages**（边缘函数与 Pages）
2. 新建项目 → 代码来源选 **Gitee**
3. 首次会跳转到 Gitee 授权页，确认授权后回到控制台
4. 选择仓库：`jinghe-net / i-adore-the-nova-browser`
5. 构建配置：
   - **根目录**：`site`
   - **构建命令**：留空（纯静态，无需构建）
   - **输出目录**：`.`（点号，表示根目录本身）
   - **Node 版本**：任意（不参与构建）
6. 保存并部署

部署完成后会得到一个默认域名，形如 `xxx.edgeone.app`，此时官网已可访问。

## 二、绑定自己的域名

1. 在 EdgeOne Pages 项目 → **域名管理** → 添加自定义域名
2. 按提示在你的域名解析商处添加 **CNAME** 记录，指向 EdgeOne 给出的目标地址
3. 等待 DNS 生效 + 证书自动签发（通常几分钟）

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
3. 把 APK 覆盖到 `site/download/nova-<版本>.apk`
4. 更新 `site/version.json`：
   - `version` / `versionCode`
   - `updatedAt`
   - `sha256`（`sha256sum site/download/nova-<版本>.apk`）
   - `size`（字节数）
   - `changelog`
5. 推送到 Gitee：

   ```bash
   git add -A
   git commit -m "release: v<版本>"
   git push origin main
   ```

EdgeOne Pages 会自动触发重新部署，几分钟后线上即为新版。

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
