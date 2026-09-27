# 让 CC 承担 agent 协调：模式调研与产品建议

日期：2026-09-27（洛杉矶）。性质：调研与建议，未实现、未安装新工具、未启用自动通信。
本地代码基线：39cf7f5f；本方计划提交：9d67b72b。当前双方约定见[协作说明](../plans/2026-09-26-cc-agent-coordination.md)。
同日修订：纳入主人转达的Claude评审和会话实测；第一版建议收窄为异步分支交接，尚未立项或形成实施契约。

## 结论

wechat-cc适合承担“主人只交代目标，CC替执行者传递上下文、维护分工、等依赖、整理交接”的角色。建议采用：**统一协调入口 + 持久任务/消息记录 + 独立执行工作区 + 主人掌握集成与发布**。

这是长期方向。第一版建议只验证**分支登记 + 依赖已核验的合并事件 + 交接包**，由执行者主动查收；通用成员注册、收件箱、热点预约和唤醒延后。建议在对方第⑦步大模块拆分后另行立项，不阻塞本方现有第一批。

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

**建议：**借用可靠性原则，不为本项目重写成LangGraph。现有SQLite可供将来的daemon协调层复用；第一版CLI交接验证不因此要求新增数据库表或迁移。

## 2. 与当前传话问题最直接相关的产品

### Claude Code：原生跨会话消息已经存在

官方提供ListAgents/SendMessage，可向独立Claude会话传文字；活动会话在工具调用间接收，空闲会话可因消息开始新一轮。消息来自另一个agent，不等于主人授权。本机claude --version实测2.1.282，满足文档版本门槛。[官方跨会话消息](https://code.claude.com/docs/en/cross-session-messaging)

**对方实测，主人转达：**Claude会话名wechat-cc-04，同机Claude对等消息可用，列表只出现其他Claude会话，未出现当前Codex会话。本方未独立复测其消息记录；这项反馈为Claude体系内的连通性提供了证据，未建立Claude↔Codex通道。

这比操作Warp窗口合适，但它是Claude体系内的功能，不等于当前Codex对话已经能调用该工具。产品桥接应使用公开接口与明确接入，不能直接写私有socket、邮箱格式或会话日志。

Claude Agent Teams提供team lead、独立上下文、共享任务与消息；官方仍标为experimental，且存在队友恢复、任务状态滞后等限制。它适合作参考，不能当作跨Claude/Codex的完整成熟底座。[Agent Teams](https://code.claude.com/docs/en/agent-teams)

### MCP Agent Mail：最贴近“不同工具之间的协作邮箱”

作者原项目为Dicklesworthstone/mcp_agent_mail，提供身份、线程、收发箱、收件确认和文件范围预约。预约是advisory，收件确认不等于任务完成；hook提醒也不能保证任意休眠宿主被唤醒。它是实用参考与试验候选，0.x版本记录不能证明生产SLA。[原仓库](https://github.com/Dicklesworthstone/mcp_agent_mail)、[更新记录](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/main/CHANGELOG.md)

**修订后的选择：**保留该项目作为设计参考，不为当前异步交接验证引入第三方服务。先用两端都能调用的本地CLI验证共享交接记录是否有用；需要真正的通用消息能力时再比较接入成本。CC最终应只有一个任务状态的权威来源。

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

## 5. 后续完整协调层的候选能力

这是长期架构建议，尚未形成待实施API契约，也不是第一版功能清单。新增daemon路由、工具、权限和运行状态的接线成本，必须结合service/bootstrap等大模块拆分一起核算。

**成员登记。** 一个执行者记录成员ID、owner、宿主/原生session ID、实例代次、仓库身份、分支/工作区/基线、能力和心跳。工作任务ID与provider session ID分开，重连或换执行器不丢事项归属。

**持久收件箱。** 消息先落盘，包含来源、收件人、事项/关联ID、消息ID、正文或材料引用。投递采用可重试机制，消费和回执幂等；分别显示“CC已保存”“客户端已收到”“执行者已确认”，工作完成另由成果与验收证明。断电、离线、重复通知都不能被界面误写为成功。

**分工与依赖。** 先保存分支需要等待哪个PR合入哪个目标分支；当前最重要的是合入先后。以后确有文件预约需求时，热点键再使用规范repo身份＋仓库相对路径/逻辑资源，不能只看各自绝对cwd。这种路径预约主要适用于同仓库多工作树，不能替代合并依赖或发现全部行为冲突。外部CLI的预约是协作承诺，不是文件系统强制锁；心跳过期也不能证明它停止写入。

**结构化交接。** 交付至少包括base/head commit、PR、改动范围、验证证据、已知限制和下一步。小摘要附原始记录/产物引用；避免把几百轮完整聊天转给所有执行者。验收数据来自实际提交与测试，不能只听一句“做完了”。

**事件驱动。** 有新消息、阻塞、成果、PR合并或需要主人决定时才推动下一步。只接收相关依赖事件，限制自动来回消息与重复唤醒；没有变化时保持安静。模型可以建议分工，程序负责边界和可靠推进。

**权限。** 主人先确定可自动协作的范围；agent消息始终带来源，不能变成主人批准。当前项目仍由ggshr9合dev及部署，消息通道不转移这项权力。暂不接管外部终端，不依赖私有socket格式。

## 6. 本次双方协作如何变成产品流程

现已确认：Codex与audit-followup的Claude基线相同；PR119只改守卫和构建流程，可以独立进行。对方的设备鉴权和大文件拆分要等待本方第一批合入dev。

接入后的目标流程如下；第一版以主动查询和读取交接包实现，不承诺自动通知或启动空闲会话：

1. 双方分别向CC登记并确认身份/范围；CC记录本方第一批优先及Claude暂缓热点。
2. Claude提交PR119，CC记录它与第一批范围不冲突；各自继续，无需主人搬运说明。
3. 本方报告第一批完成，CC整理PR、验证与限制，交给主人审阅合并。
4. 主人合入后，CC在查询时从GitHub核验目标仓库、PR、目标分支、合并状态与合并提交，更新依赖记录并提供交接包。若dev随后继续前进，区分该PR的合并提交与当前已核验的dev头，不把它们都叫“新基线”。
5. Claude确认收到并检查基线；若存在本地改动，先报告，不被CC强制切分支或reset。
6. 两端在开工、交接和继续依赖工作前查收；无需主人搬运说明。自动提醒和空闲唤醒留给后续能力。

这里第4步不能由“agent说完成”替代，也不能由HTTP投递成功替代第5步。

## 7. 选择与落地顺序

| 选择 | 适用情况 | 判断 |
| --- | --- | --- |
| 纯本地coord CLI与共享交接记录 | 当前两个宿主都能调用CLI，接受主动查收 | 第一版建议；先验证合并依赖与交接，尚未实现 |
| 引入现成Agent Mail | 后续确实需要通用跨工具收件箱 | 保留参考，当前不引入 |
| 在CC内补coordination服务，MCP/CLI作适配 | 异步交接已证明价值，需要产品内统一呈现和可靠投递 | 后续方向；先核算大模块与注册成本 |
| 直接建设完整A2A联邦、通用多agent平台 | 要接大量独立组织/远程服务 | 当前需求不需要，后续再加适配 |

第一版只验证三件事：分支登记（仓库、负责人、工作区、base/head）；依赖合并事件（PR及目标分支、核验结果）；交接包（提交、范围、验证与限制、接收者确认）。GitHub暂不可访问时保留未核验状态，不能凭agent声明解除依赖。拟议命令放src/cli/coord.ts一类独立模块；仍要遵守CLI分发与体积守卫，不给现有汇点继续堆业务逻辑。

源码核查支持这条减法：纯本地CLI不需要HTTP路由、tier、operator白名单或MCP登记；所谓“登记税”取决于实际暴露面，参见[鉴权登记说明](../../reference/internal-api-auth.md)。但仍需更新根命令登记、手写帮助和顶层命令集合测试。基线39cf7f5f的cli.ts有4332行，恰好达到[守卫上限](../../../scripts/cli-ratchet.guard.test.ts)，不能提高上限来加入口。⑦拆分后应以新基线重估接线成本；CLI模块不得依赖daemon内部实现。

**对“仓库目录里同一份JSON”的修正：**独立worktree各有自己的docs目录，同名路径并不共享；依赖git提交后再同步也不能解决即时查收。docs/superpowers/coordination/适合存格式、示例和已归档交接包。活动记录应由双方CLI显式指向同一个共享状态位置，可在设计阶段利用Git common directory识别本机同仓库，但不去改对方工作树。共享位置、同机限制和清理归属须先写清。

同一份JSON还存在并发读改写覆盖；原子替换只防半写，不能防丢更新。轻量实现也需要串行写入/跨进程锁，或每条记录独立落盘的简单约束。此处仅列设计必须回答的问题，本轮不创建共享状态或改任何执行者配置。

建议的验收是：两端从各自工作区读取同一交接记录，重复更新与并发写不丢记录；PR未合入、合错目标、网络失败都不能解除依赖；接收者确认后能指出准确提交。明确显示“待查收”，不承诺空闲时自动继续，也不为首轮引入daemon路由、MCP工具、通用收件箱或唤醒测试。

顺序：本方第一批交办先行；对方⑥⑦仍等第一批合入。协调CLI建议在⑦之后另行立项、设计和审查，当前反馈不代表实施排期已经批准。既有发布操作由主人按当前发布安排串行完成，本报告不触发合并、重打tag或批准。

第一版验收的一句话：**双方主动查收同一份交接记录，就能知道在等哪个合并、应使用哪个提交；主人不再复制粘贴这些说明。**

## 本轮完成与未完成

已完成官方资料核查、本地代码落点核查、双方分工记录与方案比较；前次查询已只读核实PR118合并提交和PR119当时的OPEN状态及三文件范围。同日根据主人转达的评审收窄第一版范围，记录Claude原生消息实测的来源与局限。

未实现协调层，未安装Agent Mail、未修改Claude/Codex接入配置、未发送自动agent消息、未运行产品测试或部署。上文“接入后的流程”均为拟议能力。
