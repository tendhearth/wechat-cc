# CC 普通用户体验：协作与交接说明

状态：双方分工已由主人转达确认；仍通过主人传话，尚未建立自动通信。
日期：2026-09-27（洛杉矶）。

## 本方分配

- 负责人：本 Codex 对话「研究普通用户使用 CC 的方案」。
- 对话标识：01a0e11f-92fa-7f53-bf83-22b86c694187。
- 工作区：/Users/nategu_mac_company/.codex/worktrees/cc-user-experience/wechat-cc
- 分支：codex/cc-task-entry。
- 起点：origin/dev，39cf7f5f543587bffaae07c1cf2557948ffaf8b1。
- 本方范围：统一任务创建入口及回执、独立事项工作目录、桌面聊天交办、手机新交办/附件/续说。长期记忆纠正另设第二批，第一批不同时展开。
- 当前产物：已审阅的设计、实施计划和本说明；产品代码未修改，产品测试、构建、部署均未执行。
- 主入口：[实施总计划](2026-09-26-cc-user-experience.md)。

## 双方隔离约定

1. 各自只修改自己的工作区和分支，不给对方切分支、清理、暂存或覆盖文件。独立分支提交不会自动改变另一个工作区。
2. 本方测试用唯一临时目录（前缀cc-task-entry-）、独立数据库和动态端口；不把生产stateDir、账号数据或已安装app用作试验对象。
3. 整合者已确认是主人ggshr9。共享daemon重启、安装、部署、推dev由主人串行处理；双方只推自己的分支、开面向dev的GitHub PR，不直接推dev或自行部署。
4. 工作树只隔离文件及分支；同一接口或行为仍可能发生合并冲突。合并必须基于提交进行审查与组合测试，不用整文件覆盖消除冲突。
5. 需要共改下列部位时，先交换提交号和接口，再约定先后：src/lib/db.ts及迁移测试、src/core/workbench/service.ts、src/daemon/settings-panel.ts、wiring/pipeline-deps.ts、main.ts、手机生成物、依赖锁文件。
6. 本方不修改依赖版本。数据库迁移只追加；若对方也增加迁移，在整合时由一个负责人按实际基线排序并重跑迁移兼容测试。
7. 交付内容为基线、分支、提交列表、改动范围、测试结果和未验收项；由整合者在自己的集成工作区合入。

## 对方与分工（主人转达，已接受）

- 对方就是audit-followup中的Claude Code，工作区wechat-cc/.claude/worktrees/audit-followup，分支sweep/route-guard-crlf，起点同为39cf7f5f。
- [PR #118](https://github.com/tendhearth/wechat-cc/pull/118)已squash合并，合并提交就是双方基线；已用GitHub只读查询核实。
- [PR #119](https://github.com/tendhearth/wechat-cc/pull/119)查询时仍OPEN、目标dev，仅修改route-registry.guard.test.ts、release-pipeline.guard.test.ts和desktop.yml；与本方计划热点无交集。
- 本方第一批统一交办先行。对方在第一批合入dev之前，只做设计与无交集文档/守卫，不动settings-panel.ts、workbench/service.ts、pipeline-deps.ts、main.ts和db迁移。
- 对方后续设备token统一与loopback、service/bootstrap/cli拆分，等待本方第一批合入后以新dev基线继续。不是等本方“说完成”就解除依赖。
- 对方本轮没有迁移，报告末条v67。本方追加前仍从实际基线核对；对方后续迁移排在本方合入之后。
- 三条注册守卫、cli.ts只许变小的限制、桌面sessions模块精简、msw/log-viewer已删及总图生成规则，均纳入实施时基线检查。
- 对方报告service-one-session“醒来时重取基线”在满载偶发失败，未入ci-flakes.json。遇到先保留证据、按CI规则重试和判断归属，不直接当作通过，也不顺带扩大本批改动范围。
- 同日后续反馈：对方会话名wechat-cc-04，报告基线仍为39cf7f5f、当时无未提交改动；这是主人转达的对方状态，本方未读取其工作树复测。

## 通讯现状与下一步研究

当前没有仓库级自动消息总线，也没有已接入的Codex↔Claude桥。用户要求研究由wechat-cc承担身份登记、消息、依赖及交接；该产品方向单独调研，不能把它当作已经部署。

对方实测同机Claude对等消息可用，但会话列表只有Claude、没有当前Codex。这项由主人转达的结果支持原生消息不能直接串起双方的判断；不再把Claude侧连通性统称为完全未测。

评审后曾将首版建议收窄为本地CLI异步交接。随后专项核查确认Paseo已有跨Claude/Codex分派、发送、等待和回传，Orca已发布任务依赖/收件箱功能（仍标Experimental）；CC也已有委派工具及工作台任务接口。因此[当前建议](../reports/2026-09-27-agent-coordination-research.md#7-选择与落地顺序)优先对照这些成熟控制方式、复用现有运行时，文件交接降为未纳管外部会话的备用方案。不能由“当前两条活会话没接通”推导出产品必须先造新的协调平台。

若采用文件交接，其范围仍限分支登记、合并依赖、交接包；通用收件箱/唤醒另行评估，不引入Agent Mail试验。协调功能尚未选型或立项，现有第一批继续优先；没有新增命令、共享文件或自动查收。

拟议共享状态须由双方明确指向同一位置，不能误把各自worktree的docs目录当成共享文件夹；并发更新需要保护。docs可存格式和归档材料，活动记录的落点由后续设计确定。

Warp的UI入口对当前工具不可用。官方Claude Code原生跨会话消息、Channels、Codex App Server和MCP协作工具属于本次调研对象；使用正式授权接口接入，不操作对方终端或改写会话历史。新协调能力不会自动取得主人批准PR、部署或扩大权限的能力。

## 验证状态

- 已用Codex原生工作树工具创建并附加独立工作区。
- 已从远端核对dev基线并创建独立分支；未切换原始工作区或对方工作区的分支。
- 已归档五份计划，检查文档链接和分支状态。
- 尚未配置测试实例/启动测试服务；没有重启共享服务或部署。
- 双向分工、整合者与共享热点顺序已由主人转达确认；Claude侧同机消息由对方实测，双方跨工具通信尚未建立。
