# 统一交办验证记录

代码实现与本地自动化验证完成，待整合者合并、部署和真机验收。分支 `codex/cc-task-entry`，独立工作区 `cc-user-experience/wechat-cc`。

2026-09-27 开工：原设计基线 `39cf7f5f`；实现前将仅含设计文档的分支同步到 `origin/dev@261a2ca10e428face03d2ad3d522fb2b627ee566`，实现起点 `d4397523`。其间上游仅变更 CI、发布和文档，产品源码及末条迁移 v67 均未变化。#119 已合入；#127 是对方后续拆分设计。

| 基线检查 | 结果 |
| --- | --- |
| Bun 1.3.14，全套，4 workers | 666 文件通过、1 跳过；8698 测试通过、10 跳过 |
| Node 26.4.0，全套，4 workers | 566 文件通过、2 跳过；7492 测试通过、11 跳过 |
| TypeScript | 通过 |
| 模块边界 | 通过；7 条既有循环依赖警告 |

使用冻结锁文件安装本工作区依赖，包清单和锁文件未改。Bun 全套先于同步运行；Node 全套在同步后运行，新增 CI 守卫另行用 Bun 验证。

本机可发现 Claude、Codex、Cursor 执行程序，但本记录不据此宣称账号已登录或执行能力可用。未读取凭据。服务层测试使用隔离主人、数据库、目录和受控执行者。

共享 daemon 的重启、部署、dev 合并和推送由 ggshr9 串行负责。实际 Tauri、真实手机、真实执行者的交办/图片/续接验收尚未进行，须分别记录结果，不能由单测代替。


已完成后端步骤 1–3：严格输入/持久登记（144 项定向测试）、独立工作目录与项目归属（38 项）、原子创建与兼容回归（独立复核后 8 文件、112 项）。新增迁移 v68；历史迁移指纹未变。独立复核发现的首次材料校验竞争与已登记目录出现未知文件，均已用失败用例复现并修复。真实双 SQLite 连接以受控交错检查单次接受；尚未以两个外部服务进程进行并发压力验收。

手机路由回归在首次 Cargo 满并发编译期间有两条既有 20 秒超时；保留超时设置，将本任务 Cargo 限为两并发后同文件 11 项全部通过。未归入已知 flake、未改超时。

Task 4: trusted desktop/phone entry routes plus current-owner desktop uploads; strict phone continuation foundation landed here. Bun 7 files / 178 tests passed, including revoked phone requests. Rust exact whitelist: 1 test passed / 5 filtered with CARGO_BUILD_JOBS=2 and process-only TAURI_CONFIG disabling externalBin resource packaging. Node initial routes run: 102 passed, one existing chunked-upload ECONNRESET during compile; isolated idle retry passed, complete Node suite remains final gate.


桌面步骤5：6文件190项定向测试通过；真实 Chromium 使用隔离服务、SQLite 与确定性执行者，12个宽/窄窗口场景无横向溢出，无页面或HTTP错误。报告及13张截图保存在 `/private/var/folders/yc/y9bc_lbd69z5_3_dqbt5bn6c0000gn/T/cc-companion-browser-evidence-BZoeQy/`。根代理检查了740px摘录预览截图。此记录证明浏览器组件与隔离HTTP接线，不等同于完整Tauri主窗口、真实模型或手机真人验收。

macOS「打开工作位置」仅向原生端传任务ID，由原生端读取daemon任务目录，检查绝对目录、路径链和本次inode再调用系统打开程序。7项新增Rust测试通过；连同工作台精确路由和body边界共11项通过，测试启动器为fixture未打开Finder。其他平台明确不支持；检查本次打开期间的目录身份，不声称核验创建以来的历史inode。


后端步骤7/8合并交付：10文件172项Bun集成验证通过。共享配额独立审查发现的预约编号跨owner/内容借用、旧桌面取消漏墓碑、handoff复制元数据漏计费，均先复现失败再修正；fresh review发现64条已绑定旧上传阻塞过期扫描，也已补失败用例并修为排除已绑定记录、游标有界推进。新增v69指纹 `2df729ce442f770e`，旧指纹未改。真实SQLite两连接交错与事务故障路径有覆盖，未宣称完成独立外部服务进程压力测试。

真实配对HTTP/加密relay handler使用公共资产 `moment-ai-offline.png`（529,448字节，大于512KiB）验证128KiB分块、重复中间/最后块、image-only创建和原回执重放；最终存储字节一致，双向密文帧均小于512KiB，撤销设备后三条材料接口及新交办接口拒绝。该12项自动化使用受控执行者，不是实际模型看图验收。


原生适配器隔离验收：`bun scripts/workbench-native-attachments-smoke.ts --run` 使用本机 Claude Code 2.1.282 与 Codex CLI 0.153.4、临时配置/目录、仅 loopback 的本地确定性模型服务。两家均通过首次图片字节、image-only补充、历史图片恢复与新图片续接、同一原生会话；Codex另验活动会话图片steer及过期请求拒绝，Claude另验PDF原生内容块。测试未访问云端模型、用户聊天或共享daemon，因此不能替代“真实模型理解图片”验收。

收尾全量首次发现两项回归：新手机材料样式硬编码圆角、legacy无owner任务的纯文字续聊被材料owner检查误拦。保留原测试修复两处，3文件83项回归通过；手机严格owner路径始终校验任务归属，新入口也不经过legacy兼容分支，独立复核确认无新增绕过。模块边界首次发现新增循环，已将EntryResult放在服务输出层，并把有界文件读取下移既有anchored-fs层；6文件128项、类型检查通过，循环警告由基线7条降为4条，未修改规则。

截图使用公开fixture，记录浏览器组件，不代表真机验收：

![桌面选择讨论材料](../../screenshots/task-entry/desktop-selected-discussion.png)

![手机原任务补充图片](../../screenshots/task-entry/phone-material-continuation.png)


最终自动化验收（2026-09-27，产品代码提交 `b15ee2a1`）：

| 检查 | 结果 |
| --- | --- |
| `bun run test --maxWorkers=4` | 676文件通过、1跳过；9038测试通过、10跳过 |
| `npm run test:node -- --maxWorkers=4` | 575文件通过、2跳过；7792测试通过、11跳过 |
| `bun run typecheck` | 根目录及手机通过 |
| `bun run depcheck` | 0错误、4条既有循环警告；基线7条，无新增 |
| `bun run build:mobile` 后生成物差异检查 | 与已提交页面一致 |
| 手机 Chromium E2E | 17项通过；包括丢创建回包恢复、大图image-only创建/补充、公开对话与可展开工具记录 |
| 桌面 Playwright 全套 | 118项通过，独立临时状态与mock服务 |
| Rust工作台定向测试 | 11项通过（含7项打开工作位置），2项非本范围过滤 |
| `apps/desktop` 中 `bun run build-sidecar` | CLI与jobspawn构建通过，版本 `1.7.0 (b15ee2a1)` |
| `bun scripts/smoke-compiled-sidecar.ts` | 编译后二进制在空状态目录正确返回daemon_required，无SDK虚拟路径崩溃 |

Task6/9以同一个前端提交交付。新增工具记录默认折叠、全部转义、无记录不占位；公开对话直接可见，同任务刷新保留展开选择。验收末轮独立审查无剩余行动项，既有微信创建/续接、项目、恢复、成果相关回归包含在全套测试中。

构建限制：本工作区缺少既有绘图组件 `sd-cli-aarch64-apple-darwin`，构建脚本已明确提示无法在此完成完整macOS Tauri打包；本轮只验证CLI/jobspawn及Rust测试，不声称完整app打包成功。测试日志里既有marked sourcemap缺失、颜色变量冲突和一次mock服务空闲超时未造成失败；没有更改超时、忽略测试或增加flake白名单。

交接顺序：ggshr9审查本分支PR并合入dev，核验GitHub合并事件与实际merge SHA后，才把新基线交给等待⑥/⑦的Claude；当前基线仍为 `261a2ca1`。迁移已占用v68/v69。合并后由整合者串行构建/部署共享daemon，跑健康门及维护者workbench/chat selftest，再做真实Tauri、Safari/微信、云端模型看图和网络切换验收。该部分保留未完成，不由HTTP/CLI投递成功替代。后续agent协调层没有混入本批产品实现。
