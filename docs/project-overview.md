# Tendhearth 项目总览

> 2026-10-01 核对至 dev `d8141c14`（#167）。[详细调研与提交证据](https://github.com/tendhearth/wechat-cc/blob/eee886631eb47222452963576ae4b2760444e55f/docs/project-overview.md)保留为历史快照；持续进展以 [roadmap](roadmap.md) 为准。

## 产品与底座

**Tendhearth CC 是住在自己电脑上的个人 AI。** 用户找 CC 说话、交办事情、查看结果和作决定。桌面、微信、原生手机与浏览器/PWA 访问同一个后台；Claude Code、Codex、Cursor 和 API 模型提供执行与推理能力。

| 项目 | 职责 |
|---|---|
| `wechat-cc` · **Tendhearth CC** | 主产品：自身记忆、对话、事项、执行与各端入口 |
| [hearth](https://github.com/tendhearth/hearth) | 笔记变更治理与跨源查询权限；CC 可作为消费者和数据源 |
| [wxvault](https://github.com/tendhearth/wxvault) | 本人本机微信资料取回、解密、查询与按需同步 |
| [插件库](https://github.com/tendhearth/wechat-cc-plugins) | 扩展源码及市场登记；部分知识工具已退役到 daemon 内核 |

附属仓库依据本机源码核查，未验证其当前运行环境。资料目录和同仓库工作树的分类见本机 `~/Documents/tendhearth/README.md`。

本地优先指持久化与控制权在自己电脑。手机中继转发加密数据；调用模型时，选定上下文会送到用户配置的 AI 服务。数据流与权限见 [architecture](architecture.md) 和 [app 隐私要求](../apps/app/README.md)。

## 四月以来的变化

| 阶段 | 重点 |
|---|---|
| 4 月初—中旬 | 微信连接正在运行的 Claude Code 会话 |
| 4 月下旬 | 常驻 daemon、个人记忆与桌面入口 |
| 5—6 月 | 多执行者协作、独立的记忆与权限边界 |
| 7—8 月 | 陪伴、真实生活资料、本地知识与 PWA 随身入口 |
| 9 月 | 工作台、统一事项、权限决定、成果与自维护 |
| 9 月末—10 月初 | 原生手机、聊天、通知、配对、会话续接与两端设计统一 |

现存 Git 历史从 4 月 6 日（洛杉矶时间）开始；仓库外的构想可能更早。各阶段证据与 hearth / 插件库的变化见上面的详细调研。

## 当前边界

核查时公开桌面版本为 1.7.1。原生手机各批次已合 dev，真实配对、APNs/FCM 投递、双平台续接和商店发布仍分别验收；**合入代码不等于完成发布**。当前状态与清单只在 [roadmap](roadmap.md)、[app README](../apps/app/README.md) 维护。

已有对话协作与任务交接能力，完整的跨宿主持久协调层仍属后续设计，见[协调交付计划](superpowers/plans/2026-09-27-cc-coordination-delivery.md)。

产品称 **Tendhearth CC**，日常称 **CC**。两端使用暖纸、衬线与一个深绿动作色；界面不切深色，CC 明暗来自真实在场信号。规范以[产品命名](reference/product-naming.md)和[设计统一](superpowers/specs/2026-10-01-tendhearth-design-unify-design.md)为准。

## 文档维护

| 文档 | 只负责什么 |
|---|---|
| 本机 Tendhearth README | 目录、资料与工作区导航 |
| 本文 | 项目关系与长期演变 |
| [INDEX](INDEX.md) | 每个领域该读哪份文档 |
| [roadmap](roadmap.md) | 当前主线、进度与验收欠账 |
| [全景导图](全景导图.md) | 已定 / 已否决及原因 |

剩余整理：优先校正架构中的旧鉴权 / 知识 / 插件描述，以及协调计划已过期的等待条件；随后按各仓库规则更新 hearth、插件库和 wxvault 的现行说明。旧简报、设计稿与截图标明历史或验收范围，保留原始证据。
