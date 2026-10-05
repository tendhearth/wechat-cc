# Tendhearth CC 产品命名

2026-09-30：对外产品名统一为 **Tendhearth CC**，角色与日常称呼为 **CC**。本次是产品文案统一，不是安装、存储或发布标识迁移。

## 在 Tendhearth 家族里的位置

2026-10-05 定：**Tendhearth 是一个宇宙**，以后会互相联动的产品住在里面：Tendhearth CC，以及动物 App leni（小羊）、rici（刺猬）、melu（狐狸）、ranu（浣熊），都由 Nate Gu & Co. 出品。CC 是宇宙里的管理员，不是动物，照看各家、会去各家串门。跨 App 联动是以后的事，先把 CC 做好。

- 大小写：Tendhearth、Tendhearth CC 是专名，首字母大写（与 1.7.4 / 1.7.5 的桌面显示名和 macOS 改名一致）；动物 App 一律小写；域名和标识用小写 `tendhearth`。
- 原生手机 App 的显示名也应是「Tendhearth CC」（目前 `apps/app/locales/*.json` 仍是「Tendhearth」，按发布批次统一）。商店名「Tendhearth CC · 个人 AI」/「Tendhearth CC · Personal AI」。
- 对外联系统一用 `developer@nateguco.com`；隐私和支持页计划放在 `cc.tendhearth.com/privacy`、`/support`（尚未上线）。`tendhearth.com` 根域名留作宇宙首页。
- 家族规范全文：`~/Documents/Project Nategu/docs/tendhearth-family.md`（本机路径，不在本仓库）。

## 怎么称呼

| 场景 | 名称 |
|---|---|
| README、产品介绍、商店及正式标题 | Tendhearth CC |
| 对话、角色称呼、按钮里的自然表达 | CC |
| 桌面、原生手机、浏览器/PWA、微信 | 同一个 Tendhearth CC 的不同入口 |
| 仓库及命令 | 保留 `wechat-cc` |
| npm 发布包 | 保留 `claude-channel-wechat` |

中文介绍：住在你自己电脑上的个人 AI。找 CC 说一句话，在桌面、手机和微信里接着做。

English: Your personal AI companion, at home on your own computer. Talk to CC, follow your work, and make decisions across desktop, mobile and WeChat.

用户先认识 CC，再按需要了解执行者、模型与工程设置。Claude Code、Codex 等是接入的执行者，不是产品名称。

## 视觉沿用桌面

沿用桌面正式 CC 资产与暖纸色体系。CC 的正式形象使用 C 形附肢和竖眼；不要用熊、其他动物或临时重画的角色代替正式资产。资产以桌面 `apps/desktop/src/assets/pet/cc-v1/canonical/` 及其验收记录为准。

2026-10-01 的[两端设计统一](../superpowers/specs/2026-10-01-tendhearth-design-unify-design.md)取代早期浅深色预览：桌面与原生手机都使用同一张暖纸，不提供深色模式。Light / Dark CC 表示真实的在场 / 连接状态，不再跟随系统主题。颜色、字体和形状以 `packages/design-tokens/src/index.ts` 为准，本文不复制另一套色板。

## 保留兼容标识

此次不修改 CLI 示例、仓库 URL、包名及内部包作用域、环境变量、配置与数据目录、服务标识、数据库字段、更新地址、应用 bundle ID、URL scheme、钥匙串键或推送凭据。这些名称出现在技术文档中是正常的，不能全局替换为产品名。

原生 app 的显示名、桌面窗口标题、关于页、权限文案、安装页面与商店截图需要按发布批次检查。显示文案可以统一；底层标识迁移应另行设计并验证升级兼容性。

### 桌面 macOS 显示名(1.7.4 起)

- 显示名来自 `apps/desktop/src-tauri/lproj/{en,zh-Hans}.lproj/InfoPlist.strings` 的 `CFBundleDisplayName` / `CFBundleName`,`Info.plist` 设 `LSHasLocalizedDisplayName`。基础名仍由 tauri 按 `productName` 生成为 `wechat-cc` —— 它必须与 `.app` 文件名一致,Finder / 程序坞才会用本地化名。
- 关于面板的名字在 `src-tauri/src/lib.rs` 的 `app_menu` 里换(tauri 默认菜单用 `productName`)。
- LaunchAgent 带 `AssociatedBundleIdentifiers`(= bundle id),登录项里显示 app 名与图标;`Label` 是技术标识,不改。
- 1.7.4 不改:`productName`、bundle id、主二进制名、sidecar 名、LaunchAgent Label、dmg 卷名。其中 macOS 的 `productName`、主二进制名、sidecar 名在 1.7.5 改(见下一段);bundle id 与 LaunchAgent Label 永远不改。它们的迁移见 [roadmap](../roadmap.md)「命名统一的后续交付」。守卫:`apps/desktop/src/display-name.test.ts`。

### macOS 文件名与进程名(1.7.5 起)

2026-10-04 主人定:macOS 上用户看得到的文件名与进程名也换掉 —— 1.7.5 起 `.app` 叫 `Tendhearth CC.app`,主二进制 `Tendhearth CC`,sidecar `tendhearth-cc-cli`(只限 macOS;bundle id、CLI 命令名 `wechat-cc`、状态目录、LaunchAgent label 不变)。设计、升级证据与真机清单见 [app-rename-migration.md](../maintainer/app-rename-migration.md)。

## 当前入口与发布状态

- 桌面与微信：继续使用现有入口。
- 原生手机：[`apps/app`](../../apps/app/README.md)，Expo / React Native。当前 dev 已包含演示模式与配对后的真连接。
- 浏览器/PWA：[`apps/mobile`](../../apps/mobile/README.md)，保留 `/m` 入口。

工程实现、真机验收、商店发布分别记录。不要仅凭目录或功能代码存在就宣布手机 app 已上架、真实通知已验收。

## 文档维护

当前 README、维护入口、索引与现行路线使用新名称。历史发布记录、旧设计稿和技术标识保留原文；旧决策与现状冲突时添加历史标记和新决定链接。全景导图先改 Markdown，再运行 `bun run build:map` 生成 HTML，不能手改生成物。
