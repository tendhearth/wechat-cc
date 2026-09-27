# 让 CC 承担 agent 协调：模式调研与产品建议

日期：2026-09-27（洛杉矶）。性质：调研与建议，未实现、未安装新工具、未启用自动通信。
本地代码基线：39cf7f5f；本方计划提交：9d67b72b。当前双方约定见[协作说明](../plans/2026-09-26-cc-agent-coordination.md)。

## 结论

wechat-cc适合承担“主人只交代目标，CC替执行者传递上下文、维护分工、等依赖、整理交接”的角色。建议采用：**统一协调入口 + 持久任务/消息记录 + 独立执行工作区 + 主人掌握集成与发布**。

成熟的是这些组成模式。跨任意品牌、任意运行中终端会话、无需预先接入便可靠唤醒执行的通用产品，本次资料不能证明已经存在。先解决当前两个agent需要主人转述的具体链路，再扩展自动分解任务。

本报告将官方产品能力、社区项目能力与对CC的设计建议分开。没有把能发送消息当作已接单，也没有把协议兼容当作代码冲突已经解决。

## 1. 业内已经成立的模式

| 模式 | 一手证据与成熟度 | 对CC的意义 |
| --- | --- | --- |
| 一个协调者负责用户结果，专业执行者做限定工作 | OpenAI Agents SDK明确区分manager与handoff；Anthropic有生产Research案例 | 用户始终与CC交谈，执行者身份可在详情查看 |
| 持久任务状态、检查点、人工介入后恢复 | LangGraph提供checkpointer与interrupt | 离线、等主人确认、daemon重启都不丢责任关系 |
| 独立会话收件箱、任务声明、文件范围预约 | Claude有官方跨会话通信；MCP Agent Mail有跨工具的实用实现 | 自动传发现、阻塞和交接，替代人工复制 |
| 通用agent服务互操作 | A2A定义发现、任务、消息和产物；MCP提供工具接入口；ACP提供客户端/执行器会话接口 | 分层采用，不把全部协议一次堆入第一版 |

### 协调者与执行者

OpenAI官方将“主agent保留最终答复权、把专业agent当工具”与“专业agent接管对话”分开。CC要保留普通用户的单一入口，前者更贴合。[OpenAI：Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration)

Anthropic的生产Research采用协调者分派目标明确的子任务，使用成果引用、恢复与观测。其经验同时指出：多agent成本更高，编码工作未必像研究那样容易并行。不能把这个案例解释为所有任务都应该拆成多agent。[Anthropic生产实践](https://www.anthropic.com/engineering/multi-agent-research-system)

**建议：**CC的路由、存储、去重、依赖检查由代码负责；模型用于理解目标、整理必要上下文、提出分工与冲突解决建议。投递每条状态消息不必再调用一次大模型。

### 可靠状态优先于持续群聊

LangGraph的interrupt会保存执行状态，凭thread_id恢复；恢复可能重跑节点，因此副作用仍需幂等。持久后端与内存保存不是同一种保障。[Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)、[Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)

它还明确区分sync、async、exit等持久化时机，可靠性有具体代价和崩溃边界。[Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers)

**建议：**借用可靠性原则，不为本项目重写成LangGraph。现有SQLite已经能承担第一版状态账本。

## 2. 与当前传话问题最直接相关的产品

### Claude Code：原生跨会话消息已经存在

官方提供ListAgents/SendMessage，可向独立Claude会话传文字；活动会话在工具调用间接收，空闲会话可因消息开始新一轮。消息来自另一个agent，不等于主人授权。本机claude --version实测2.1.282，满足文档版本门槛；未验证当前会话的接收策略和实际连通性。[官方跨会话消息](https://code.claude.com/docs/en/cross-session-messaging)

这比操作Warp窗口合适，但它是Claude体系内的功能，不等于当前Codex对话已经能调用该工具。产品桥接应使用公开接口与明确接入，不能直接写私有socket、邮箱格式或会话日志。

Claude Agent Teams提供team lead、独立上下文、共享任务与消息；官方仍标为experimental，且存在队友恢复、任务状态滞后等限制。它适合作参考，不能当作跨Claude/Codex的完整成熟底座。[Agent Teams](https://code.claude.com/docs/en/agent-teams)

### MCP Agent Mail：最贴近“不同工具之间的协作邮箱”

作者原项目为Dicklesworthstone/mcp_agent_mail，提供身份、线程、收发箱、收件确认和文件范围预约。预约是advisory，收件确认不等于任务完成；hook提醒也不能保证任意休眠宿主被唤醒。它是实用参考与试验候选，0.x版本记录不能证明生产SLA。[原仓库](https://github.com/Dicklesworthstone/mcp_agent_mail)、[更新记录](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/main/CHANGELOG.md)

**选择：**若只想最快验证两个工具能传话，可评估该项目作为临时接入；若要让CC把消息、任务、审批、成果统一呈现，协调数据应由CC掌握。不能同时造两个“哪个任务完成了”的权威账本。

## 3. 协议各负责什么

| 接口 | 合适的位置 | 不应据此承诺 |
| --- | --- | --- |
| MCP | agent调用CC的登记、查信、回复、交接等工具 | 所有客户端收到通知后都会自动启动一轮模型 |
| ACP | CC驱动支持ACP的执行器，接收会话/工具事件及权限请求 | 能直接控制任意已经打开的CLI进程 |
| Codex App Server | CC自己连接和管理的Codex线程及turn | 启动另一个app-server就能操控当前Codex桌面里的活线程 |
| Claude Channels | 已明确启用的Claude会话接收外部事件 | 普通MCP配置天然有推送能力，或所有认证提供商都支持 |
| A2A | 跨独立服务、机器或组织的任务/产物互操作 | 提供本机工作树锁、代码合并、完整产品调度与审批 |

MCP可以承载agent之间的协作工具，具体负责人、交接验收和冲突语义由应用实现。[MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

版本要按客户端实际能力选择：MCP 2026-07-28将Tasks移到扩展，并改变协议级会话/初始化机制；不能假定仓库当前SDK与各CLI都已兼容最新版。[MCP变更记录](https://modelcontextprotocol.io/specification/2026-07-28/changelog) 当前Tasks扩展可提供任务句柄、状态查询、补充输入、取消与订阅通知，但需能力协商，取消也不等于进程已停止。[Tasks扩展](https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html)

ACP的load/resume取决于执行器声明能力和它认识的session ID；v2仍为草案。[ACP架构](https://agentclientprotocol.com/get-started/architecture)、[会话设置](https://agentclientprotocol.com/protocol/v1/session-setup)、[v2草案](https://agentclientprotocol.com/protocol/v2/draft/overview)

Codex App Server有thread/start、resume、turn/start、turn/steer和事件通知；steer要求匹配活动turn。它提供真实受控入口，本次未测试任意外部桌面实例的可接入性。[Codex App Server](https://learn.chatgpt.com/docs/app-server)

Claude Channels可将MCP事件推入已启用的运行中会话，但仍是research preview，有认证、组织和启用条件。仅写进MCP配置不够。[Claude Channels](https://code.claude.com/docs/en/channels)

A2A已有稳定v1.0，提供Agent Card、task/context、message、artifact及可选流式/push能力；长期交互与编码harness集成仍有路线图事项。适合以后做外部适配，不是CC本机协调的前置。[A2A规范](https://a2a-protocol.org/latest/specification/)、[v1.0公告](https://a2a-protocol.org/dev/blog/2026/03/12/a2a-protocol-ships-v10-production-ready-standard-for-agent-to-agent-communication/)、[路线图](https://a2a-protocol.org/latest/roadmap/)

## 4. CC现有基础与真实缺口

以下判断来自本仓库源码，只读核查，未做运行验收。

| 已有模块 | 可以复用 | 需要补的部分 |
| --- | --- | --- |
| [CLI hooks](../../../src/cli/hook.ts)、[cli-events](../../../src/core/cli-events.ts) | session/cwd与会话事件 | 当前内存观察改为独立持久成员登记；不能把扫描到进程当成已接入 |
| [MCP接线](../../../src/daemon/bootstrap/mcp-specs.ts)、[token registry](../../../src/daemon/internal-api/token-registry.ts) | 工具注册、限时限路由token | 成员级身份和窄协作权限，不能共用file token冒认发送者 |
| [live-inputs](../../../src/core/workbench/live-inputs.ts)、[control receipts](../../../src/core/workbench/control-receipts.ts) | 去重、回执、待确认状态的实现模式 | 单独的跨agent持久收件箱，不混进现有任务补充状态机 |
| [AgentProvider](../../../src/core/agent-provider.ts)、[Codex传输](../../../src/core/workbench/codex-app-server.ts) | 已托管会话的投递与原生接受证据 | 各宿主的接收/唤醒适配能力 |
| [execution claims](../../../src/core/workbench/execution-claims.ts)、[scheduler](../../../src/core/workbench/scheduler.ts) | 托管目录/会话互斥 | 跨工作树同一个repo文件范围与任务依赖 |
| [handoff records](../../../src/core/workbench/handoff-record.ts) | 固定材料版本、引用和hash | 开发交接：base/head commit、PR、验证、限制与接收确认 |
| [外部agent注册](../../../src/core/a2a-registry.ts)、[接线](../../../src/daemon/bootstrap/wire-a2a-server.ts) | 外部服务配对/通知的参考 | 现有通知终点是主人，不能当作开发agent收件箱；也不据名称宣称A2A v1.0兼容 |

关键边界：现在的“恢复CLI会话”会另起进程继续历史；它不是向已有终端会话送信。未证明独占控制前，不应并发resume同一个活动session。托管会话、已接入外部会话、仅发现未接入会话，应分别显示能力。

## 5. 推荐的CC协调层

这是架构建议，尚未形成待实施API契约。

**成员登记。** 一个执行者记录成员ID、owner、宿主/原生session ID、实例代次、仓库身份、分支/工作区/基线、能力和心跳。工作任务ID与provider session ID分开，重连或换执行器不丢事项归属。

**持久收件箱。** 消息先落盘，包含来源、收件人、事项/关联ID、消息ID、正文或材料引用。投递采用可重试机制，消费和回执幂等；分别显示“CC已保存”“客户端已收到”“执行者已确认”，工作完成另由成果与验收证明。断电、离线、重复通知都不能被界面误写为成功。

**分工与依赖。** 保存谁承诺做什么、依赖哪项结果以及暂时避让的范围。热点键使用规范repo身份＋仓库相对路径/逻辑资源，不能只看各自绝对cwd。发现同一热点就提出顺序安排；外部CLI的预约是协作承诺，不是文件系统强制锁。心跳过期只表示失联，不能自动证明它已经停止写入。

**结构化交接。** 交付至少包括base/head commit、PR、改动范围、验证证据、已知限制和下一步。小摘要附原始记录/产物引用；避免把几百轮完整聊天转给所有执行者。验收数据来自实际提交与测试，不能只听一句“做完了”。

**事件驱动。** 有新消息、阻塞、成果、PR合并或需要主人决定时才推动下一步。只接收相关依赖事件，限制自动来回消息与重复唤醒；没有变化时保持安静。模型可以建议分工，程序负责边界和可靠推进。

**权限。** 主人先确定可自动协作的范围；agent消息始终带来源，不能变成主人批准。当前项目仍由ggshr9合dev及部署，消息通道不转移这项权力。暂不接管外部终端，不依赖私有socket格式。

## 6. 本次双方协作如何变成产品流程

现已确认：Codex与audit-followup的Claude基线相同；PR119只改守卫和构建流程，可以独立进行。对方的设备鉴权和大文件拆分要等待本方第一批合入dev。

接入后的理想流程：

1. 双方分别向CC登记并确认身份/范围；CC记录本方第一批优先及Claude暂缓热点。
2. Claude提交PR119，CC记录它与第一批范围不冲突；各自继续，无需主人搬运说明。
3. 本方报告第一批完成，CC整理PR、验证与限制，交给主人审阅合并。
4. 主人合入后，CC从GitHub已核验的合并事件取得新dev提交，再把交接包发给Claude。
5. Claude确认收到并检查基线；若存在本地改动，先报告，不被CC强制切分支或reset。
6. 主人平常只看一句进度；出现范围冲突、需要取舍或发布决定才介入。

这里第4步不能由“agent说完成”替代，也不能由HTTP投递成功替代第5步。

## 7. 选择与落地顺序

| 选择 | 适用情况 | 判断 |
| --- | --- | --- |
| 引入现成Agent Mail做接入试验 | 先验证当前两个宿主能否收发，允许临时独立工具 | 最快获得能力证据；不能据此宣称CC已统一任务 |
| 在CC内补轻量coordination服务，MCP/CLI作适配 | 目标是普通用户始终使用CC，延续现有审批与成果 | 推荐产品方向；复用SQLite和已有执行能力 |
| 直接建设完整A2A联邦、通用多agent平台 | 要接大量独立组织/远程服务 | 当前需求不需要，后续再加适配 |

先做一个受控的接入验证：**Claude和Codex两端都能登记、互发带来源的消息、确认收件；接收方空闲时是否可唤醒有真实测试结果。** 若某宿主只能查收，就明确显示“待查收”，不卖成实时托管。

该验证通过后，再设计持久邮箱、热点与依赖、交接UI。验证必须覆盖daemon重启、对方离线、重复投递、旧实例代次、撤销接入、消息中伪称主人批准等情况。现有第一批交办计划保持原顺序，不因本调研偷偷加入新的数据库迁移或大模块改造。

产品验收的一句话：**用户交代目标后，不再为两个已接入执行者复制粘贴工作说明；CC能证明谁收到了、在等什么、交付了什么。**

## 本轮完成与未完成

已完成官方资料核查、本地代码落点核查、双方分工记录与方案比较；已只读核实PR118合并提交和PR119的OPEN状态及三文件范围。

未实现协调层，未安装Agent Mail、未修改Claude/Codex接入配置、未发送自动agent消息、未运行产品测试或部署。上文“接入后的流程”均为拟议能力。
