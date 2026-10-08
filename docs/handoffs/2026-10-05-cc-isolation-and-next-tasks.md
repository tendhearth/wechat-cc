# CC 项目隔离与后续任务交接

2026 年 10 月 5 日建立，10 月 8 日恢复实施。主人已用「go」批准第一批项目隔离、整段会话逐文件撤回和完整补丁导出，并在 10 月 8 日要求继续。先完成这批的接线、审阅和验收，再展开 Qwen 完整执行与浏览器操作。

## 接手先看这三处

- [批准的设计](../superpowers/specs/2026-10-05-workbench-isolation-review-design.md)
- [六项实施计划](../superpowers/plans/2026-10-05-workbench-isolation-review.md)
- [维护者入口](../maintainer/README.md)及根目录 AGENTS.md

上批桌面与跨平台收口已通过 [PR 230](https://github.com/tendhearth/wechat-cc/pull/230) 进入 dev，本批最初产品基线为 `b2ef0c71`。10 月 8 日整合树已对齐 dev `b92b46cd`，保留后来加入的工作区、执行者退出、自定义 ACP、模型及图片功能。本批 [PR 262](https://github.com/tendhearth/wechat-cc/pull/262) 仍是草稿，尚未部署。10 月 5 日的 Claude 与 Qwen3.8 真执行者证据不代替本批验收；Cursor 当时受额度限制，合入前还需重新核对远端 dev 和本机版本。

## 第一优先级 完成当前批准的一批

| 任务 | 当前状态 | 接手后的完成条件 |
| --- | --- | --- |
| Git 副本分配与补丁底层 | 模块及修复已独立审阅并整合；路径和并发预留修复 `b72adf50` 的 Bun/Node 各 52 项通过 | 继续核对实际 Windows；完整导出及源文件、源分支和真实 index 不变纳入整体验收 |
| 私有恢复快照与撤回日志 | 模块及 FIFO 修复已独立审阅并整合，目标 Bun/Node 各 45 项通过；Windows 目录处理修复中 | 精确字节、存在性、身份、版本和 daemon 崩溃恢复；不能把未知状态当可撤回 |
| 桌面和手机执行位置及桌面撤回交互 | `cf98c031` 两项复审通过并整合；原生各 119 项、桌面/PWA 各 284 项、实际浏览器 17 项通过 | 对接真实服务；未知创建冻结完整请求，未确认退出不开放撤回；只有匹配的 reverted 回执表示已撤回 |
| 原生执行配置准入 | `7323695c` 修复已独立复审并整合；各 111 项及 10 个实际分配样例通过 | 保守核对规则、配置、授权及路径等价；无法证明就拒绝，4096 项扫描上限需说明 |
| 任务创建与来源项目绑定 | 实现 `2770d2b9`，各 880 项目标测试通过；独立审阅发现微信 matter 写失败仍接受，修复中 | 微信有 MatterStore 时与其他入口同事务接受，失败零派发；保留旧回执及无 MatterStore 兼容，再定向复审 |
| 会话关闭证明及撤回和导出服务 | 待 Task 4 后串行实施，计划 Task 5 | writer 确认退出后冻结整段会话；未决日志阻挡新写入；管理员路由、权限登记和成果全部接齐 |
| 整体验收与交付 | 待整合，计划 Task 6 | 全套 Bun、Node、类型和模块边界、桌面和 Rust 检查；准确提交的 CI；dev、本机安装和真实执行者闭环 |

验收必须走新建两件同项目任务 → 并行执行 → 交给另一位检查 → 关闭会话 → 看整段改动 → 撤回一个文件 → 导出补丁 → 重启后核对未决操作。使用自建 Git 样例，保留原项目的文件、HEAD 和 index 对照。旧任务、普通逐回合 diff、保留中的会话都不能凭空获得恢复点。

## 工作区与分工

唯一整合者是本聊天的根 Codex。所有树都在 `~/.codex/worktrees/`，下表目录均以 `/wechat-cc` 结尾。

| 目录 | 分支 | 所属工作 |
| --- | --- | --- |
| `cc-closeout-integrate` | `codex/workbench-isolation-review` | 根整合、计划、交接、最终验收及部署 |
| `cc-isolation-workspaces` | `codex/cc-isolation-workspaces` | Git 模块，已提交；修改仍交原负责人 |
| `cc-isolation-restore` | `codex/cc-isolation-restore` | 恢复模块，已提交；修改仍交原负责人 |
| `cc-isolation-ui` | `codex/cc-isolation-ui` | apps 内客户端、桌面代理与原生白名单 |
| `cc-isolation-config` | `codex/cc-isolation-config` | 新配置准入 helper 和测试 |
| `cc-isolation-module-review` | `codex/cc-isolation-module-review` | Task 4 独立审阅，当前 `35c03044`，待修复复审 |
| `cc-isolation-core` | `codex/cc-isolation-core` | Task 4 后端；当前修复微信接受事务，Task 5 尚未开始 |
| `cc-isolation-dev-audit` | `codex/cc-isolation-ui-final-review` | 已转为 UI 独立复审，`cf98c031` 通过 |
| `cc-isolation-windows-ci` | `codex/cc-isolation-windows-ci` | 根据真实 Windows CI 修复配置权限夹具及目录处理 |

不要另派一位重复写这些树。根树 `.superpowers/sdd/2026-10-05-workbench-isolation-review/` 保存最新进度、接口裁决和模块报告；各实现树也有自己的交接报告。它们是本机工作记录，接手时结合 Git 实际状态核对。报告专用提交不作为产品代码合入。

主项目 checkout 和 `wechat-cc-cc-kit` 是其他工作区；10 月 5 日记录后者存在大量未提交内容，必须只读。不得替它们切分支、暂存、清理或覆盖。实现树完成后用 Codex 的归档工作区功能保存可恢复快照。

## 接线时不能丢的约定

- 新 Git 任务默认独立副本，脏项目或不安全配置明确拒绝；用户可以显式选原目录。无编号旧协议保留原目录兼容，不宣称去重。
- `Task.path` 是执行目录，来源项目另存。旧桌面创建接口保留标题和路径语义，但加稳定 requestId 和 executionMode，与新版共用回执。结果未知保留编号，修改内容或执行位置才换编号。
- 子项目保持目录范围。Git 记录的 `executionIdentity` 才对应实际执行目录；恢复 begin 使用它，不能误用更外层 worktree 的身份。
- before 在 writer 启动前冻结；retained 续接和自主唤醒属于同一段会话。实际 close 确认后才采 after；重启后没有内存对象不代表已退出。
- 撤回与新写入共用父子路径占用规则。prepared、applying、needs_recovery 持久阻挡；成功回执、路径版本及任务事件在同一个 SQLite 事务提交。
- 撤回路由返回 `{operation}`。必须匹配任务、成果、路径、changeId 和 requestId；resolved_keep_current 只表示保留现场。
- 补丁使用私有 index，含提交、暂存、未暂存和非忽略新增；排除内部材料，拒绝不完整输出。归档保留副本，本批不自动合并原项目或删除副本。
- 普通自检仍显式选原目录，避免删除 scratch 后留下依赖它的 Git 副本。隔离专项验收另建并保留自己的 source 与副本。

配置 helper 正按保守准入实施：项目或祖先原生配置、按 cwd 存的授权及无法证明安全的 stdio MCP 会被拒绝，不能静默丢工具。最终支持范围以实现审阅和验收为准，明确写入用户说明。

## 待整合时处理的检查结果

原独立审阅的三个真实问题已修复并定向复审通过：Git 缺少对象时隐式 lazy fetch、ready 重试配置等待后的身份核验、私有 blob 被替换为 FIFO 后阻塞。Git runner 要求支持禁用 lazy fetch 的 Git 版本，低于 2.45 明确拒绝。

草稿 PR 首轮准确版本 `13ae30ad` 的 Mac、Linux、Node 及后端端到端检查通过；Windows 为 3 个文件、41 项失败。Git 路径比较修复已独立通过并推送新轮；配置权限夹具和恢复目录处理仍在修复。最终整合版本要重新跑全套，不能用早期模块或 CI 绿代替。五万项真实覆盖测试已有独立时间预算，保持完整扫描和拒绝断言。

UI 分支的新增路由需要 Task 5 补 daemon 和 token 白名单后才能通过路由守卫。手机生成页由整合者按现有构建流程重建，不能忽略生成物与源码不一致。原生确认框已改为应用对话框，还要在实际安装包验收。

当前两个底层模块的目标测试通过，不等于生产功能已交付。完成审阅前不部署半接线的撤回能力；公开 master、商店和新版本发布不在这批范围。

## 第二优先级 下一批能力

1. **Qwen 等 API 模型的完整任务执行。** 目前已验图片、读文件、列目录、保存新成果和会话续接；还缺受控命令、修改项目文件、网页工具、MCP、后台执行及更多文档输入。先选真实小型编码或办公任务，再设计工具权限、取消和恢复，不能把聊天成功当完整执行能力。
2. **浏览器操作。** 先做一次网页查看、操作、证据保存的完整任务，定义登录会话、敏感操作确认和失败恢复。当前尚未开始这批实现。
3. **原生手机及发版欠账。** 核对后续改动的真 iPhone 验收、语音播放和推送体验。TestFlight 前的生产中继、APNs 与 RELAY_WATCH 按现行手机发布安排执行；所需主人在场或环境批准留到可操作时，商店和安卓继续后置。详见 [roadmap](../roadmap.md) 与 [手机维护说明](../../apps/app/README.md)。

后两批按新的具体设计推进，当前「go」不扩成任意外发、生产中继变更或公开发布授权。不要因为主人正在飞行而新增定时任务、发送微信或跳过需要实际判断的检查。
