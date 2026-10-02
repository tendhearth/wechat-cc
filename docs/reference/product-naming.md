# Tendhearth CC 产品命名

2026-09-30：对外产品名统一为 **Tendhearth CC**，角色与日常称呼为 **CC**。本次是产品文案统一，不是安装、存储或发布标识迁移。

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

## 当前入口与发布状态

- 桌面与微信：继续使用现有入口。
- 原生手机：[`apps/app`](../../apps/app/README.md)，Expo / React Native。当前 dev 已包含演示模式与配对后的真连接。
- 浏览器/PWA：[`apps/mobile`](../../apps/mobile/README.md)，保留 `/m` 入口。

工程实现、真机验收、商店发布分别记录。不要仅凭目录或功能代码存在就宣布手机 app 已上架、真实通知已验收。

## 文档维护

当前 README、维护入口、索引与现行路线使用新名称。历史发布记录、旧设计稿和技术标识保留原文；旧决策与现状冲突时添加历史标记和新决定链接。全景导图先改 Markdown，再运行 `bun run build:map` 生成 HTML，不能手改生成物。
