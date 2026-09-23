# CC 多项目任务并行：验证记录

基线：`ed4bc53c`。范围：`2026-09-12-cc-task-entry-scope.md` 第二段。本文随实际验证补充；未完成的检查不会记为通过。

## 参考项目复核

2026-09-12 读取官方仓库，并只读检查以下版本的源码；没有执行其代码，也没有移植其实现。

| 来源 | 实际核对 | 对 CC 的影响 |
| --- | --- | --- |
| [Paseo d1b705a0](https://github.com/getpaseo/paseo/commit/d1b705a0cd91617a5707fae25d80cb0be3057950) | [agentId 下的操作队列](https://github.com/getpaseo/paseo/blob/d1b705a0cd91617a5707fae25d80cb0be3057950/packages/server/src/server/agent/agent-manager.ts#L2764)、[按 agent/request 回复权限](https://github.com/getpaseo/paseo/blob/d1b705a0cd91617a5707fae25d80cb0be3057950/packages/server/src/server/agent/agent-manager.ts#L2935) | 执行与操作归属任务，避免一个全局 busy 阻塞所有任务；目录冲突单独调度。 |
| [Orca 403b62a8](https://github.com/stablyai/orca/commit/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7) | [session acquisition 的代次和身份](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/codex/codex-structured-session-state.ts#L143)、[确认退出的 close](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/codex/codex-structured-session-close.ts#L59)、[跨线程请求 ID 碰撞测试](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/codex/codex-structured-prompt-replies.test.ts#L110) | 保留每轮会话身份；晚到的清理不能释放新任务。停止请求不等于执行程序退出，确认退出前不能释放相同目录。 |
| [CC Switch 官方仓库](https://github.com/farion1231/cc-switch) | 保留上一段已采用的现有配置/登录复用原则；本轮没有改动配置读取或导入功能 | 用户无需再次填写模型连接表单。外部历史恢复与交接仍是第三段。 |

不能照搬的部分：[Orca 的 worktree terminal lock](https://github.com/stablyai/orca/blob/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/src/main/runtime/worktree-terminal-mutation-lock.ts#L1) 允许共享 spawn，主要协调 sleep；Paseo 的逻辑取消超时也不是文件写入者已经退出的证明。CC 本轮的规范路径、相同/父子目录 FIFO 是为普通文件夹设计的独立实现。

## 设计边界

- 不同的、不互相包含的已选文件夹可以并行；相同文件夹、链接到同一文件夹的路径、父子文件夹等待。较晚的冲突任务不越过较早的等待者。
- 仍使用原生 Claude/Codex 的权限策略。调度器协调 CC 拥有的任务和它们声明的目录，不构成 OS 读取沙箱；在外部终端运行的程序及用户另外允许的目录外写入不在该目录调度范围。
- 本轮没有增加自动 Git 工作副本、并发设置表单、外部会话导入或跨执行者交接。
- 服务重启不会自动重放未完成的请求；用户须检查原进程与已生成文件，再继续任务。

## 真实 Claude / Codex 检查

使用独立预览服务与临时合成数据，未操作日常 companion 状态。所有任务均经真实工作台 HTTP 接口交给已安装的原生执行者，权限和停止通过实际页面操作。

| 任务 | 证据 |
| --- | --- |
| 北区销售 · Claude `7becacb2` | 与南区同时处于 running，各自出现一个真实权限请求。北区计算 600 / mug 330；在等待删除专用测试文件的审批时点停止，权限立即清除，测试文件仍在，停止前生成的 result.md 被保存为快照。 |
| 南区销售 · Codex `d5f69ef7` | Claude 停止后仍在等待自己的本机连接审批。单次允许后返回本机常量 `cc-parallel-local-probe-ok`，结果为 900 / mug 520，独立 result.md 快照已读取核对。 |
| 北区销售 · 排队复核 `7297677d` | 与 Claude 使用同一文件夹，等待原因 same_path。Claude 退出后自动开始，生成包含 `NORTH_QUEUE_OK` 和总额 600 的 verify.md。 |
| 北区备注 · 取消排队验证 `a1dc186a` | 使用 north/notes 子文件夹，等待原因 nested_path。在页面取消后未启动，原生 sessionId 为 null，无文字回复、成果或任务输出文件夹。 |

两份原 CSV 的字节保持不变：north SHA-256 `8d1aa365d6d4f95acce4b7a886d0e59c652d842cde427c04d59734218c972e63`；south `6824b57fbffe54ba42126df534a799d7994624150a3a4181e34a3c3283bf8c37`。

初轮真实执行覆盖工作树中的并发实现。随后在 `d83f62b3` 重启服务，北区和南区再次同时续接完成，并核对原生会话编号保持：

- Claude：`27e15c2a-9782-42cd-bc8d-e30348bfbb49`，回复 `FINAL_RESUME_NORTH`，保留北区 600 / mug 330。
- Codex：`01a0968c-6414-7483-b49a-9a0cfb7410a8`，回复 `FINAL_RESUME_SOUTH`，保留南区 900 / mug 520。

这些是 CC 已拥有的会话续接，不能据此声称外部正在运行的 CLI 会话接管或不同执行者之间的上下文交接完成。

## 页面检查

- 实际页面同时显示两项「进行中 / 等你确认」，排队项显示真实阻塞任务；已存在用户消息的排队项仍显示同目录或父子目录说明。
- 给北区、南区和备注任务分别输入不同草稿，切换后逐个恢复正确；停止/完成不将草稿转移到其他任务。检查后只清理本次输入的测试草稿。
- 在 1440×1000、1024×900 及默认浏览器尺寸检查两栏、权限卡、停止按钮、成果展开/预览；无横向溢出。
- 全局「此刻 / 一起做 / 回忆」在工作模式收起，CC 按钮可展开，Escape 收回且不切换当前任务。已恢复临时窗口尺寸设置。
- 预览保留已完成的真实任务和成果供查看。未重建正式 Tauri 应用，本轮视觉证据来自真实浏览器页面；原生 Claude/Codex 执行来自本机进程。

## 自动验证与审查

- HTTP 元数据保真回归：15 项通过，包括 waitingFor 和任务权限数量，不改变原有严格路由校验。
- UI：50 项工作台/导航测试通过。独立审查发现「有历史时等待说明消失」，以三个非空对话场景先重现后修正；复审通过。
- 在 `d83f62b3` 的综合定向验证：19 个文件、277 项通过；全仓 `bun run typecheck` 通过。
- 后端独立审查另发现两处存储读取异常会漏掉启动/关停清理的问题，已在 `1439a541` 修复并复审通过：启动使用已接受的任务快照；内部取消不依赖 HTTP 响应读取；关停逐项隔离失败。错误路径通过存储故障注入验证，没有破坏真实任务库来模拟故障。
- 最终 `1439a541`：19 个文件、279 项定向测试全部通过，全仓 `bun run typecheck` 通过；冻结角色/Blender 资产相对 `ed4bc53c` 无差异。
- 独立审查和修订复审均完成，没有未处理的阻塞项。最终预览服务已重启加载审过的代码，未推送或合并分支。

已知原有警告：vendored marked 的 source map 文件缺失。测试通过，这不是本轮引入的问题。

## 本轮交付选择

采用冲突范围内排队，保留普通文件夹支持；不增加自动 Git 工作副本或并发配置页面。因此，即便两个同目录任务实际上只读，也会排队。不同目录的用户发起任务可以并行，实际资源和服务额度仍取决于机器及已连接执行者。

未确认退出的程序只占用其冲突目录；相关新任务等待，其他目录继续。这个限制防止 CC 同时派两个程序改同一目录，不保证用户在其他应用启动的进程也受管理。第三段的外部历史发现/导入和 Claude ↔ Codex 明确交接仍未实现。
