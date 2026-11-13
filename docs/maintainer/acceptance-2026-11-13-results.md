# 2026-11-13 网关真模型验收结果

基线 `e3d65c530d5035c3dcbd274b5b9cbf86ddc01d74`，分支 `acceptance-run`。本轮只修改验收脚本和文档，没有修改生产行为、部署或 push。

**验收未全通过，不能据此部署。** 已发现两处产品阻塞：OpenAI 兼容适配未请求流式 usage；真实网关超长文案未识别，导致后续短消息持续失败。另有 Codex 工具调用与长委派的 CLI × 网关兼容问题。

14:04:25 UTC 开始的新一批补验一直未满足门禁，14:06 起检测到 CivilizationVII。30分钟上限后，末次轮询于14:34:48 UTC退出（exit 3），比预定上限多23.7秒；期间没有启动补验模型调用。已将脚本等待夹到剩余时长，避免下一次轮询超限。C、D没有执行结果，不能把脚本或源码预审当成通过。

## 环境与证据位置

- 全部实际模型请求经回环代理转发 `llm.youdamaster.cc`；Claude 用 messages，Codex 用 responses，OpenAI 兼容用 chat/completions。没有使用订阅登录态。
- 每次 daemon/验收驱动起跑先检查 load < 8、无 CivilizationVII。daemon 前台运行；临时 HOME、CLAUDE_CONFIG_DIR、CODEX_HOME；登录凭据文件检查均为 false。sandbox 拒绝子进程非回环出站、原 Claude/Codex 配置和钥匙串访问。没有操作 UI、launchd、已安装 App、生产 daemon、真实微信、relay 或社交。
- CLI / SDK：Claude `2.1.323 / 0.2.116`；Codex `0.169.0 / 0.144.4`。使用本机已有依赖的只读链接，协议源码指向本 worktree；没有联网安装或构建。
- 状态均位于 `S/acc/state/run-*`，其中 `S=/private/tmp/claude-501/-Users-nategu-mac-company-Documents-tendhearth-wechat-cc/31f4b9f3-d5ba-444d-bc43-9260dcadb79c/scratchpad`。证据主目录为 `run-06`；`run-05` 用于真实空闲回收，`run-07` 的补验只到门禁。
- `drive-evidence.jsonl` 按下表 ID 查 API 状态，`turn-evidence.jsonl` 留合成回复及耗时，`daemon.log` 留工具/轮换/错误，`gateway.jsonl` 留实际请求结构与状态，`gateway-responses.jsonl` 留 usage 和调用名称。代理不保存请求正文。凭据观察文件仅为本次 0600 临时配置，不进入日志、报告或提交。

## 逐项总表

“做不了”包括门禁阻断、前置失败或完整断言尚无证据；局部成功写在同一格。没有将它们记为产品失败。

| 条目 | 结果 | 脱敏证据与限制 |
|---|---|---|
| A.1 | 通过 | `run-06`：`A.1-final`，真实 Claude + Kimi-Code 正常回复；daemon 工具记录 `wechat/today_digest`。OpenAI 兼容也真实调用该工具。 |
| A.2 | 通过 | `A.2-final`：实际模型进程数 2；会话令牌在 argv、模型进程环境中的命中均 false。`A.7-ps` 同样无命中；只检查本次子孙进程环境。 |
| A.3 | 通过（有限范围） | 实际请求有 77 个 `mcp__wechat__*`，总工具 102，未含 ToolSearch；与 #917 前源码比较，静态注册名 69→69、集合相同。没有启动旧版 daemon 作运行时对照。 |
| A.4 | 做不了完整断言 | `/both`、`/chat` 按现行设计只提示去桌面。内部 set-mode 的 parallel/chatroom 均有两家回复，OpenAI 实际调工具；Claude 该轮复用了前文，未取得“两家各新调一次”的完整证据。见 `A.4-*`。 |
| A.5 | 做不了完整闭环 | 手动 release 后 5.5 秒续接，仍调 today_digest，`A.5-manual-*`。`run-05/idle-observation.json`：14:11:04 UTC，真实空闲超过 30 分钟后 `sessionsLive=0`。空闲后真实续接被游戏/负载门禁阻断。 |
| A.6 | 不通过 | 短委派 9.35 秒成功；`A.6-long` 要求真实 sleep 75 秒，21.1 秒内得到上游 400（tool_calls 缺对应 tool message），未验证长调用成功。 |
| A.7 | 不通过 | OpenAI 兼容 today_digest 成功；Codex 程序通过 responses 回复，但 `A.7-codex-recheck` 没有成功使用 today_digest。请求暴露 `mcp__wechat` 命名空间，模型称工具未暴露，改走 HTTP 又被沙箱挡住。令牌检查无命中。 |
| B.1 | 做不了订阅专属断言 | 状态有窗口/来源、比例/来源、开销、历史和预算；新段固定开销 38,693、历史 1,764、source=provider。重启前后 JSON 已留证。网关经 Claude CLI 回报 1M，而真实 Kimi 限制 262,144；不能当作真实 Claude 订阅容量/持久化证据，部署后只读复核。 |
| B.2 | 做不了两通道全覆盖 | Claude 程序 + Kimi-Code 连续 20 轮全部成功，含多次工具，未出现 CONTEXT_ROTATE；普通确认约 2 秒，工具轮约 4–5 秒。OpenAI 兼容另 20 轮驱动停在门禁，没有启动。 |
| B.3 | 不通过 | OpenAI 兼容真实流响应 usage=null，状态 source=unknown。根因不是已证明“网关不支持”：本机适配没有传 includeUsage:true，实际序列化也未带 stream_options.include_usage。 |
| B.4 | 不通过 | 小窗 8,192，预算 4,915，估算占用 55,064、11 轮、source=unknown；没有轮换。结尾能说“周五，代号青松”，但这是未换段接续，不能算换后恢复。由 B.3 阻断。 |
| B.5 | 不通过 | 假窗 1M，分块累积历史；前两块成功。真实 400 报 `Your request exceeded model token limit: 262144 (requested: 319507)`。未识别 overflow、未换段重试；后续短句仍 400。原文见 daemon 13:54:12–18 UTC 行。 |
| B.6 | 通过 | 冷却后补验：14:01:32 回复，约 25 秒内出现“青松周报”话题，固定周五、负责人小青。`B.6-throttle`：尝试计数 2→3→3，第二条五分钟内不重复抽取。初次空话题因继承 A 的冷却，不算故障。 |
| B.7 | 做不了完整闭环 | `B.7-tick/outbox` 真实发到合成收件箱“要不要一起喝杯茶？”。独立 companion 会话后主人计数/字节/轮数逐项不变；原主会话的“好啊”被 B.5 超长故障挡住。全新状态补验停在门禁。 |
| B.8 | 做不了完整半预算断言 | 手动 nightly 返回 written；其后未出现迟到轮换。该轮 OpenAI 占用未知；全新 Claude 状态的“已满8轮、已知占用低于半预算”补验没有越过门禁。 |
| B.9 | 做不了完整比较 | 合成访客正常由 Claude 回复且未进入主人轮换；合成群 ID 因未预置名字进入 onboarding，未覆盖群对话。没有读取生产/部署前聊天来作对照。 |
| C.1 | 做不了 | 普通任务后端执行被门禁阻断；截图对照待 mini。 |
| C.2 | 做不了 | 真 Codex 文件→主人确认→Claude 接棒未执行；驱动已准备，未拿真实开场/文件证据。 |
| C.3 | 待 mini | 桌面与 App 执行者列、记录区，按授权跳过。 |
| C.4 | 做不了 | 真第二棒记录本读写、跨事项拒绝未执行。脚本要求同令牌先读自身 200、再读别事 403，401不算通过。 |
| C.5 | 做不了 | 起步失败与继续未执行。临时 wrapper 只通过绝对路径 flag 注入退出73；必须观察真实失败后才能测继续，未改生产开关。 |
| C.6 | 做不了 | 未运行到任务终结和话题。另：当前系统临时任务路径会被话题来源授权过滤；不能把无条目当作记录本 bug。 |
| C.7 | 做不了 | 网关对话模型 matter_handoff 重做未执行。 |
| D.1 | 做不了 | CLI/API estimate 没有启动验收，不能把源码“不会请求模型”当作实际回执。 |
| D.2 | 做不了 | Kimi 短版、取消和保档未执行。源码输出上限512与 Kimi 推理预算要求存在兼容风险，尚无实测结论。 |
| D.3 | 做不了 | 没有真实体检假工具记录，不能完成三个考点的人工判分。 |
| D.4 | 做不了 | 没有体检实际出站请求。代理只报分类布尔/长度、隐私来源正向种子及真实 runner 观察器已准备，未作为隐私通过证据。 |
| D.5 | 待 mini | 桌面/App 状态、确认、取消、探针开关，按授权跳过。 |
| D.6 | 做不了 | Codex / agy 的“没测成”运行回执未取得，源码预审不记通过。 |
| D.7 | 做不了 | 未生成体检档案，未验证比例来源变“实测”。 |

## 问题与最小复现（按严重度）

### P1：OpenAI 兼容没有请求流式 usage，按量轮换失效

在本次临时状态配置 OpenAI 兼容 Kimi-Code、窗口262144，正常对话一轮，再改窗口8192继续超过8轮。状态 source=unknown，估算占用超过预算而不轮换。`src/adapters/executors/openai/api-model.ts` 的 createOpenAICompatible 未传 includeUsage:true；本机依赖仅此选项为真才发送 stream_options.include_usage。无网络序列化诊断为 `{hasStreamOptions:false,includeUsage:false,stream:true}`，真实响应58–74的 usage 均 null。

这是产品适配问题；尚不能断言网关不回 usage。另开修复后先确认真实 usage 与首请求基线，再重跑 B.3/B.4；本分支未改生产代码。

### P1：真实超长错误未识别，主会话持续不可用

把该通道窗口临时配1M，以每轮10,000条编号的编造周报短句累积历史。前两轮成功，第三轮请求319,507 token，网关限制262,144。真实错误：

```text
litellm.BadRequestError: OpenAIException - Invalid request: Your request exceeded model token limit: 262144 (requested: 319507). Received Model Group=Kimi-Code
```

`src/lib/provider-error-code.ts` 未识别这组措辞，日志无 CONTEXT_ROTATE。随后一句短问题仍带已超长历史，再报418,647 token并失败。使用已有 `/reset` 才恢复。修复应另开 PR 补真实错误形状，并验证换段只重试一次；不要把正常回复中的相同文字当错误。

### P2：长委派的工具消息链被网关拒绝（CLI × 网关）

Claude 程序 + Kimi-Code 主对话调用 delegate_codex，要求在隔离工作区真实执行 sleep75 后回复。短的2+2委派成功，长例在 Codex 使用工具后收到400：assistant tool_calls 没有对应工具结果消息。没有在本轮把它归因于 CC 的超时或修生产代码；需要固定 CLI/SDK 与网关 Responses 工具消息转换联验。

### P2：Codex 主人对话未用上 MCP（CLI × 网关）

临时 CODEX_HOME 的 gateway provider、model=Kimi-Code、wire_api=responses。程序和首次探测都能回复；要求重新调用 today_digest 时，出站包含 mcp__wechat 命名空间，模型没有成功调用。版本为 CLI0.169.0 / SDK0.144.4；兼容探测成功不等于 MCP 工具协议已兼容。未擅自降级 CLI 或改生产工具暴露方式。

### P2：Claude CLI 的网关容量不能当真实模型容量（CLI × 网关）

同一 Kimi-Code，Claude CLI/SDK 状态回报1M，网关实际拒绝阈值262,144。验收配置的262,144有真实错误支撑；1M没有。订阅真实模型名/窗口及其超长措辞仍需部署后只读复核。

## 其他发现与脚本自身修正

- `/both`、`/chat` 已按10-21设计退出微信开讨论；旧清单应改走内部模式接口，无需生产修复。
- 无数字的 Kimi-Code / DeepSeek / GLM-FLASH 会被现有 model-set 入口拒绝；本轮只写临时配置/模式，不改校验。主模型和两个便宜探测模型都须显式选网关模型，否则会请求网关不存在的默认 Haiku / gpt-5.4-mini（仍然只连内部网关）。
- 验收脚本曾缺依赖链接、ps 模型进程匹配不完整、观察器递归导致 checkup 模块降级；均是脚本问题，已修并重启。B 的正式轮次在健康模块下运行，不把降级记为产品 bug。
- 独立只读评审要求：持续追踪到停机结束、按出生指纹/进程组审计；retained任务按 replied识别；跨事项先有正向凭据控制；唯一文件批次；体检前种下并核验隐私来源。脚本已据此调整。C/D 这些调整仍未经过真流程验证。

## 用量、核验和交接

截至本次计数共约 **118 次**网关请求：Kimi-Code111、GLM-FLASH3，另有误用默认探测模型的4次400；107次200、9次400、2次传输中断。包含重试、便宜评估及设置排错，不是账单token数；OpenAI流 usage 的缺失使精确用量不可得。

初始与复核 `bx status --json` 的受控字段：tunnel_healthy=true、mode=global、protection_state=protected、phase=committed。没有执行任何改状态或绕隧道的 bx 命令。

核验：Python AST和5个TypeScript文件的静态语法通过；6个入口在缺失显式临时状态时全部拒绝；git diff --check通过。日志与交付文件共63份内存比对，网关key/会话令牌命中均false。没有运行UI、Playwright、模拟器、重型构建、全仓verify或TypeScript完整类型检查；C/D脚本只做静态评审，尚未真流程验证。没有删除/放松测试。临时状态保留，不提交凭据、原始状态或请求正文。

收尾：run-01–04的cleanup回执均0残留；run-05/06/07的stop-audit均 remainingCount=0、remainingGroupMembers=0、unverifiedRootCount=0，监督进程已退出；等待驱动残留0。最终所有已知进程组残留0，本次验收进程残留0。一条早于首次验收启动的既有Codex argv文字匹配经出生时间/进程组排除，未读其环境、未发信号。见 S/acc/{gate-timeout,driver-cleanup,final-process-audit,redaction-audit}.json。

交接：脚本/清单/结果提交在acceptance-run；未push。整合者需另开修复处理B.3/B.5，再在门禁允许时重跑受影响项并补C/D；C.3、D.5待mini，订阅专属元数据/错误部署后只读复核。
