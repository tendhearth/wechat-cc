# Tendhearth CC 文档索引 · 去哪找什么

> v1 · 2026-09-22 · **这份只回答「某件事的文档在哪、哪一份还可信」。**
> 「定了什么 / 为什么」在 [全景导图](全景导图.md);「往哪走 / 卡在哪」在 [roadmap](roadmap.md)。
> `docs/` 下有 300+ 份计划与设计,按日期命名。**不要按日期猜文件名——从这份索引进。**

产品名、角色称呼与兼容标识见[产品命名规范](reference/product-naming.md)。原生手机工程见 [apps/app](../apps/app/README.md)，浏览器/PWA 见 [apps/mobile](../apps/mobile/README.md)。

从整个 `tendhearth` 工作区或长期方向入手，先看[项目总览：项目关系、4 月以来的演变与当前交付边界](project-overview.md)。持续进展看 roadmap，各领域现状看下面的权威文档。

## 三份总图,先读这三份

| 想知道 | 读 |
|---|---|
| 这个项目定了什么、为什么这样定、什么被否决过 | [全景导图](全景导图.md)(唯一事实源,HTML 是生成物) |
| 现在往哪走、卡在哪、欠什么账 | [roadmap](roadmap.md) |
| 代码是怎么分层的 | [architecture.md](architecture.md) |

## 按主题:每个领域看哪一份

权威文档 = 描述**现状**的那份,会被持续修订。设计 spec = 当时的决策依据,**不随代码更新**,只在修订记录里补偏差。

| 主题 | 权威文档 | 最新设计 spec |
|---|---|---|
| 工作台(把 CLI 执行者派到文件夹干活) | [cc-workbench.md](cc-workbench.md) | `superpowers/specs/2026-09-21-one-folder-one-session-design.md` |
| ↑ 实时事件流 / 逐文件 diff 审阅 / 免审执行者 | 同上 | `superpowers/specs/2026-09-17-{workbench-live-stream,workbench-diff-review,unattended-executors}-design.md` |
| ACP(Cursor 走 `cursor-agent acp`) | [cc-workbench.md](cc-workbench.md#免审执行者与-acp) | `superpowers/specs/2026-09-17-acp-evaluation.md`(定案)+ `2026-09-17-acp-cursor-executor-design.md` + `2026-09-18-acp-cursor-chat-design.md` |
| 工作台文件锚定层的威胁模型(防什么 / 不防什么 / 从锚点开整条链) | [reference/workbench-file-guard.md](reference/workbench-file-guard.md) | 评审 #3 owner 定案(2026-10-01),见 roadmap 修订记录 |
| 网络守护(bx 优先;网络未受保护时暂停所有模型调用、拦在哪、刻意不拦什么、怎么验) | [reference/network-guard.md](reference/network-guard.md) | 主人拍板(2026-10-02),见 roadmap 修订记录 |
| 内部 API 鉴权(tier / token / routeAllow / 登记几处) | [reference/internal-api-auth.md](reference/internal-api-auth.md) | `superpowers/specs/2026-06-21-internal-api-tier-authz-design.md` |
| 发版(tag → 三平台构建 → Publish → R2 更新源) | [maintainer/release.md](maintainer/release.md) | — |
| 自维护(部署 / 自检 / CI 闸门) | [maintainer/](maintainer/README.md) | `superpowers/specs/2026-09-18-{self-maintenance,ci-triage}-design.md` |
| 自改流水线(`self change`) | [maintainer/self-change.md](maintainer/self-change.md) | `superpowers/specs/2026-09-18-self-change-pipeline-design.md` |
| 「一件事」matter 原语与任务入口 | [工作台现状](cc-workbench.md) | `superpowers/specs/2026-09-13-cc-unified-task-entry.md` 那一批(09-12/09-13)；[陪伴交办与手机验收记录](superpowers/reports/2026-09-22-cc-companion-task-entry.md)；[统一交办开发分支验证](superpowers/plans/2026-09-26-task-entry-validation.md) |
| 原生手机（Expo） | [roadmap.md](roadmap.md);[app 怎么跑与硬要求](../apps/app/README.md) | spec `superpowers/specs/2026-09-30-tendhearth-app-v1-design.md` + 计划 `superpowers/plans/2026-09-30-tendhearth-app-backend.md` + 计划 `superpowers/plans/2026-09-30-tendhearth-app-skeleton.md` + 计划 `superpowers/plans/2026-09-30-tendhearth-app-live.md` + 计划 `superpowers/plans/2026-09-30-tendhearth-app-push.md` + spec `superpowers/specs/2026-10-01-tendhearth-app-chat-design.md` + 计划 `superpowers/plans/2026-10-01-tendhearth-app-chat.md` + 设计稿 `design/tendhearth-app-v1/` |
| 两端设计统一 | [roadmap.md](roadmap.md) | spec `superpowers/specs/2026-10-01-tendhearth-design-unify-design.md` + 计划 `superpowers/plans/2026-10-01-tendhearth-design-unify.md`;验收截图与对稿记录在仓库外 `~/Documents/tendhearth/cc-screens-2026-10-01-design/` |
| 手机配对 | [roadmap.md](roadmap.md);[中继 §9 通用链接](maintainer/relay.md) | spec `superpowers/specs/2026-10-01-tendhearth-pairing-ux-design.md` + 计划 `superpowers/plans/2026-10-01-tendhearth-pairing-ux.md` |
| 原生会话续接 | [roadmap.md](roadmap.md) | spec `superpowers/specs/2026-10-01-tendhearth-continue-sessions-design.md` + 计划 `superpowers/plans/2026-10-01-tendhearth-continue-sessions.md` |
| 交办后的回报(形状已定,细节未完) | — | `superpowers/specs/2026-09-23-delegation-report-design.md` |
| Windows 进程树清理(**已落地** dev 2026-09-24,`src/lib/jobspawn.ts`) | [superpowers/reports/2026-09-24-windows-process-tree-landing.md](superpowers/reports/2026-09-24-windows-process-tree-landing.md) | `superpowers/specs/2026-09-23-windows-process-tree-spike.md` |
| 终端会话 ↔ 微信(`wechat-cc hook`) | [reference/features.md §10](reference/features.md) | `superpowers/specs/2026-09-09-cli-hook-push-design.md` |
| 多agent分工、消息与交接（调研，未实现协调层） | [现有协作约定](maintainer/README.md#多-agent-协作) | [业内模式与CC建议](superpowers/reports/2026-09-27-agent-coordination-research.md)；[后续交付计划](superpowers/plans/2026-09-27-cc-coordination-delivery.md)；[本次双方分工](superpowers/plans/2026-09-26-cc-agent-coordination.md) |
| 模型与后端管理 | [reference/model-management.md](reference/model-management.md) | `superpowers/specs/2026-09-08-model-management-design.md` |
| 每晚整理记忆 / 记忆视图 | [architecture.md §2.4](architecture.md) | `superpowers/specs/2026-09-25-memory-nightly-design.md` + `2026-09-26-memory-view-design.md` |
| 网页设计统一(手机 `tokens.css` 唯一色板) | [../apps/mobile/README.md](../apps/mobile/README.md) | `superpowers/specs/2026-09-26-web-design-unify.md` |
| 桌宠 CC / 美术资产 | — | `superpowers/specs/2026-09-05-cc-desktop-pet-design.md` + `2026-09-08-cc-asset-production-brief.md` + `2026-09-01-cc-atelier-design.md` |
| 社交层(信封 / 关系 / 觅食台 / 串门 / 明信片 / 介绍) | — | `superpowers/specs/2026-09-04-social-architecture-rethink.md`(重构定案)+ `2026-09-04-{wish-postcard,introduction}-design.md` |
| 伙伴状态与日程判断 | — | `superpowers/specs/2026-09-03-companion-presence-design.md` + `2026-09-05-companion-plan-design.md` |
| 手机协议 v2 与协议包 | [../packages/protocol/README.md](../packages/protocol/README.md) | `superpowers/specs/2026-09-29-phone-protocol-v2-design.md` + `superpowers/plans/2026-09-29-phone-protocol-v2.md` |
| 官方中继 v2(Cloudflare Workers + 推送) | [maintainer/relay.md](maintainer/relay.md) | `superpowers/specs/2026-09-30-relay-cloudflare-push-design.md` + `superpowers/plans/2026-09-30-relay-cloudflare-push.md` |
| 手机版 | [任务衔接现状](cc-workbench.md)；[手机页源码与规矩](../apps/mobile/README.md) | `superpowers/specs/2026-09-06-mobile-home-feed-design.md`；[手机任务验证记录](superpowers/reports/2026-09-22-cc-companion-task-entry.md) |
| provider(agy / cursor / openai 兼容 / 去重) | [reference/model-management.md](reference/model-management.md) | `superpowers/specs/2026-08-17-{agy-provider,provider-runtime-dedup}-design.md` |
| provider 失败的真实形状 / 各判定处怎么判(错误通道结构化 #4 第 1 步) | [reference/provider-error-shapes.md](reference/provider-error-shapes.md);样本 `src/daemon/diagnostics/__fixtures__/provider-errors/` | 第 2 步(边界产码)提议在该文档 §5 |
| 可靠性(降级启动 / 自动重启 / 忙登记处) | — | `superpowers/specs/2026-08-17-subsystem-degraded-boot-design.md` + `2026-08-11-daemon-busy-registry-design.md` + `2026-08-03-daemon-self-restart-on-stale-code-design.md` |
| 画像依据、来源改正与过时处理 | [`cc-memory-evidence.md`](cc-memory-evidence.md) | `src/lib/memory-synthesis.ts` + `src/daemon/internal-api/routes-memory-review.ts` |
| 知识与记忆(图 / 人物事实 / hearth 联邦) | — | `superpowers/specs/2026-08-12-knowledge-{graph,facts-person}-inproc-design.md` + `2026-08-13-hearth-*` |
| 引导与访客 | [reference/access-control.md](reference/access-control.md) | `superpowers/specs/2026-08-18-{owner-onboarding,guest-path}-design.md` |
| 提醒 | — | `superpowers/specs/2026-08-20-reminders-port-design.md` |
| 外发健康 | — | `superpowers/specs/2026-08-22-outbound-health-design.md` |
| 功能全表 / 权限模式 / 微信命令 / 运行时目录 / 访问控制 / A2A / 常见问题 | [reference/](reference/) 下同名文件 | — |
| 插件(含内置插件来源:不随包、`plugin source` 登记、按内置默认开) | [plugins.md](plugins.md);部署侧 [maintainer/deploy.md「内置插件」](maintainer/deploy.md) | `src/lib/plugins-source.ts` + `src/daemon/plugins/health.ts` |
| 桌面安装器 | [installer/desktop-installer.md](installer/desktop-installer.md) | — |
| 入站语音 STT(已通:网关形态,`stt-config.json` 门控) | [architecture.md §2.5 Voice](architecture.md) | `superpowers/specs/2026-07-23-inbound-voice-stt-design.md` |

## 目录都装什么

数量不写在这里(会漂),要看用 `ls docs/<dir> | wc -l`。

| 目录 | 装什么 | 还在写吗 |
|---|---|---|
| `superpowers/plans/` | 现行的实施计划,一件事一份 | ✅ 现行 |
| `superpowers/specs/` | 现行的设计依据,一件事一份 | ✅ 现行 |
| `superpowers/reports/` | 评审 / 调研报告 | ✅ 现行 |
| `maintainer/` | 给维护者(含 LLM 维护者)的操作手册 —— 部署、发版、自检、自改、CI、迁移、真机规矩 | ✅ 现行,**LLM 从 `maintainer/README.md` 进** |
| `releases/` | 每个版本的 release note | ✅ 现行 |
| `research/` `handoffs/` | 2026-09 工作台的参考项目与交接稿,被 README / architecture / cc-workbench 当现行资料引用 | ✅ 现行(少量) |
| `design/` `rfc/` `spike/` | 架构论证(2026-07/08)、技术预研、竞品调研 | 📖 历史,偶尔新增 |
| `ops/` `smoke/` `release-notes/` | 各只有 1–3 份历史文件 | 📖 历史 |
| `plans/` `specs/` | **2026-04 → 06 的老体系**,6 月后停用 | 🗄 归档(见目录内 README) |
| `reference/` | 参考级现状文档:功能全表、权限模式、微信命令、运行时目录、访问控制、A2A、常见问题、Demo 数据、内部 API 鉴权、模型与后端、工作台文件锚定层威胁模型、网络守护 | ✅ 现行(09-22 从 README 搬出的几份 09-27 按代码校正过一轮) |
| `installer/` | 2026-04 的桌面安装器说明 | 🗄 待核,可能过期 |
| `screenshots/` | README 用的截图(2026-04 的界面) | ✅ 现行,内容偏旧 |

## docs 根目录那几份零散文件

- [`cc-workbench.md`](cc-workbench.md)、[`architecture.md`](architecture.md)、[`plugins.md`](plugins.md)、[`roadmap.md`](roadmap.md)、[`全景导图.md`](全景导图.md) —— 权威文档,就该在根。
- 项目协作规则以 [AGENTS.md](../AGENTS.md) 为准。
- `registry.example.json` —— 插件注册表示例,配 `plugins.md` 读。
- `WeChat-cc-交互动画开发日志.md`、`WeChat-cc-桌面陪伴动画开发计划.md`、`客户回顾模块产品开发日志.md` —— 三份中文开发日志,写作期的过程记录,当历史读。
- `2026-08-14-knowledge-embed-subprocess-relative-import-bug.md` —— 单个 bug 的排查记录,当历史读。

## 修订记录

- 2026-10-02:新增 `reference/network-guard.md`(网络守护:bx 优先、全入口拦截、威胁模型与验证),入主题表与 reference 目录说明。
- 2026-10-01:新增 `reference/workbench-file-guard.md`(工作台文件锚定层威胁模型),入主题表与 reference 目录说明。
- 2026-09-27 v2:计数去数字;09-24/25/26 五份 spec/report 入表;四个「README 对应章节」改成具体 reference 文件(README 09-22 已搬空);新增鉴权 / 发版 / 模型管理三份现状文档;research/handoffs 改标现行;STT 口径改「已通」。
- 2026-09-22 v1:首份索引。此前 300+ 份 plan/spec 无索引,找一件事只能按日期猜文件名;老的 `docs/plans` / `docs/specs` 与现行的 `docs/superpowers/*` 两套并存且没有任何地方说明哪套还活着。
