# 2026-11-13 网关真模型验收结果

基线 `e3d65c530d5035c3dcbd274b5b9cbf86ddc01d74`，分支 `acceptance-run`。第一轮交付 `f9dc06542`；第二轮仍只修改验收脚本和文档，没有修改生产行为、部署或 push。

**验收未全通过。** 第一轮的 B.3/B.4/B.5 保留，按主人要求未重跑。第二轮已实测 C、D 及 A/B 补验：记录本注入与权限取得局部证据；自然接力、记录本工具暴露、体检输出预算和评分另有未通过项，详见本轮新增发现。

14:04:25 UTC 开始的新一批补验一直未满足门禁，14:06 起检测到 CivilizationVII。30分钟上限后，末次轮询于14:34:48 UTC退出（exit 3），比预定上限多23.7秒；期间没有启动补验模型调用。已将脚本等待夹到剩余时长，避免下一次轮询超限。这是第一轮门禁记录。第二轮门禁已改为只看 load < 12、最多等20分钟，脚本已移除游戏检查；C、D的新证据见下。

## 环境与证据位置

- 全部实际模型请求经回环代理转发 `llm.youdamaster.cc`；Claude 用 messages，Codex 用 responses，OpenAI 兼容用 chat/completions。没有使用订阅登录态。
- 第一轮门禁为 load < 8 且无游戏；第二轮每批起跑只检查 load < 12、最多等20分钟。daemon 前台运行；临时 HOME、CLAUDE_CONFIG_DIR、CODEX_HOME；登录凭据文件检查均为 false。sandbox 拒绝子进程非回环出站、原 Claude/Codex 配置和钥匙串访问。没有操作 UI、launchd、已安装 App、生产 daemon、真实微信、relay 或社交。
- CLI / SDK：Claude `2.1.323 / 0.2.116`；Codex `0.169.0 / 0.144.4`。使用本机已有依赖的只读链接，协议源码指向本 worktree；没有联网安装或构建。
- 状态均位于 `S/acc/state/run-*`，其中 `S=/private/tmp/claude-501/-Users-nategu-mac-company-Documents-tendhearth-wechat-cc/31f4b9f3-d5ba-444d-bc43-9260dcadb79c/scratchpad`。证据主目录为 `run-06`；`run-05` 用于真实空闲回收，`run-07` 的补验只到门禁。第二轮使用 `run-08`（Codex/自然接力）、`run-09`（记录本诊断与恢复）、`run-10`（体检与A/B）、`run-11`（同daemon自然空闲）、`run-12`（新主题主动消息）。
- `drive-evidence.jsonl` 按下表 ID 查 API 状态，`turn-evidence.jsonl` 留合成回复及耗时，`daemon.log` 留工具/轮换/错误，`gateway.jsonl` 留实际请求结构与状态，`gateway-responses.jsonl` 留 usage 和调用名称。代理不保存请求正文。凭据观察文件仅为本次 0600 临时配置，不进入日志、报告或提交。

## 逐项总表

“做不了”包括门禁阻断、前置失败或完整断言尚无证据；局部成功写在同一格。没有将它们记为产品失败。

| 条目 | 结果 | 脱敏证据与限制 |
|---|---|---|
| A.1 | 通过 | `run-06`：`A.1-final`，真实 Claude + Kimi-Code 正常回复；daemon 工具记录 `wechat/today_digest`。OpenAI 兼容也真实调用该工具。 |
| A.2 | 通过 | `A.2-final`：实际模型进程数 2；会话令牌在 argv、模型进程环境中的命中均 false。`A.7-ps` 同样无命中；只检查本次子孙进程环境。 |
| A.3 | 通过（有限范围） | 实际请求有 77 个 `mcp__wechat__*`，总工具 102，未含 ToolSearch；与 #917 前源码比较，静态注册名 69→69、集合相同。没有启动旧版 daemon 作运行时对照。 |
| A.4 | 通过 | `run-10/A.4-*`：/both、/chat现行提示正确；parallel及chatroom的Claude/OpenAI各有本轮wechat/today_digest真实记录，两家正常回复，圆桌出现🎯并running=null自然结束，未发/stop。 |
| A.5 | 通过 | run-11同daemon自然空闲30分41.626秒后sessions_live=0；随后SESSION_RESUME恢复同一原生会话，真实today_digest，11.287秒正常回复，sessions_live=1。无手动release/reset或daemon重启。最终ps实际模型数1，argv/模型环境中的会话令牌命中均false。 |
| A.6 | 不通过 | 短委派 9.35 秒成功；`A.6-long` 要求真实 sleep 75 秒，21.1 秒内得到上游 400（tool_calls 缺对应 tool message），未验证长调用成功。 |
| A.7 | 不通过 | OpenAI 兼容 today_digest 成功；Codex 程序通过 responses 回复，但 `A.7-codex-recheck` 没有成功使用 today_digest。请求暴露 `mcp__wechat` 命名空间，模型称工具未暴露，改走 HTTP 又被沙箱挡住。令牌检查无命中。 |
| B.1 | 做不了订阅专属断言 | 状态有窗口/来源、比例/来源、开销、历史和预算；新段固定开销 38,693、历史 1,764、source=provider。重启前后 JSON 已留证。网关经 Claude CLI 回报 1M，而真实 Kimi 限制 262,144；不能当作真实 Claude 订阅容量/持久化证据，部署后只读复核。 |
| B.2 | 通过（两通道20轮已齐） | 第一轮Claude+Kimi的20轮保留；第二轮run-10 OpenAI+Kimi 20/20均正常，四个工具轮真实today_digest，无CONTEXT_ROTATE。普通轮约1.4–6.4秒，工具轮约3.4–7.5秒。usage仍unknown，B.3缺陷未据此消失。 |
| B.3 | 不通过 | OpenAI 兼容真实流响应 usage=null，状态 source=unknown。根因不是已证明“网关不支持”：本机适配没有传 includeUsage:true，实际序列化也未带 stream_options.include_usage。 |
| B.4 | 不通过 | 小窗 8,192，预算 4,915，估算占用 55,064、11 轮、source=unknown；没有轮换。结尾能说“周五，代号青松”，但这是未换段接续，不能算换后恢复。由 B.3 阻断。 |
| B.5 | 不通过 | 假窗 1M，分块累积历史；前两块成功。真实 400 报 `Your request exceeded model token limit: 262144 (requested: 319507)`。未识别 overflow、未换段重试；后续短句仍 400。原文见 daemon 13:54:12–18 UTC 行。 |
| B.6 | 通过 | 冷却后补验：14:01:32 回复，约 25 秒内出现“青松周报”话题，固定周五、负责人小青。`B.6-throttle`：尝试计数 2→3→3，第二条五分钟内不重复抽取。初次空话题因继承 A 的冷却，不算故障。 |
| B.7 | 通过 | run-12全新状态只先打招呼；主动发出“周日一起挑银色风铃”后，主人占用35,316、字节21,161、轮数1逐项不变；“好啊”后正确约周日，再追问明确答“周日一起去挑一个银色风铃”。无喝茶旧上下文干扰。 |
| B.8 | 通过（当前本地预算） | run-10夜间前9轮、source=provider、占用36,615/预算600,000，低于半预算；nightly=written，白天回复正常、到10轮，占用36,696，lastRotatedAt/reason仍null，无迟到轮换。1M窗口仍仅为Claude CLI网关报告值。 |
| B.9 | 通过（合成路径有限范围） | run-10第二次预置群昵称成功，访客和acc-group@chatroom均正常回复“收到”、有completed日志；主人占用/字节/轮数不变、无rotation。未覆盖真实群成员/@机制或生产部署前对照。首次因脚本用operator而昵称403/onboarding，保留但不算产品失败。 |
| C.1 | 通过（后端有限范围） | `run-08/09` 真 Claude 单执行者正常 Read/Write 并答复；截图、详情页与部署前对照仍待 mini。Codex 同一小事在首工具后网关400，未产出文件。 |
| C.2 | 不通过；记录本子链局部通过 | 完整8位ID的请求被 task-reference 当原任务补充，未到 CC。分段ID变体中 Claude 先问确认、确认前无新棒；经外部0残留清理及 writer-exited 恢复后，真实 matter_handoff 建出2棒。请求#18–24含记录本/产出指针，不含第一棒仅过程 canary；第二棒 Read(handoff.txt)成功，但本次恢复尝试被提前停止，未完成核对文件。Codex→Claude原组合未通过。 |
| C.3 | 待 mini | 桌面与 App 执行者列、记录区，按授权跳过。 |
| C.4 | 不通过模型工具；底层API通过 | `run-09/C.4-storage-proof`：同一执行者令牌自身读200、写200、再读200且新增备注可见、伪造别事读403。第二棒真实请求仍无matter_notes/matter_note，不能把API成功当模型工具成功。 |
| C.5 | 通过（隔离恢复边界） | 真实wrapper退出73使新棒起步失败，状态interrupted/writer_not_closed、injected=0；外部清理0残留并writer-exited后继续，新execution、同ledger棒、injected=1，Read(handoff.txt)成功并答对原批次。见C.5-continue-after-exit-proof。此环境需人工退出确认，不是自然无干预闭环。 |
| C.6 | 做不了正向断言 | 任务路径位于系统临时目录，被工作来源授权过滤；主人聊天整理出的条目不能代替工作结果入话题。未把无条目记成记录本回归。 |
| C.7 | 不通过 | Claude+网关的分段ID变体真实调用 matter_handoff 并建2棒；OpenAI+网关也请求该工具，但严格模式 gateTool 在 bridge 前 deny，无待批卡、无真实 relay HTTP403，不能归为模型调错参数或网关失败。自然完整ID路径仍被任务路由消费。 |
| D.1 | 通过 | `run-10/D.1-cli-estimate` exit0；60次预估、含重试最多180次，输入8,690,310/输出92,160 token，窗口262144。CLI/API estimate前后网关请求数不增，未确认不跑。 |
| D.2 | 不通过；取消局部通过 | Kimi短版2/20后 provider_error：第3请求 maxTokens512、finish=length、可见文本0、reasoningChars1658。GLM备用1/20后同样 length/0/2063。二者整轮均“没测成”，不能评级为弱；标题正确，未出完整评语。两次取消均 cancelled，profiles保持空对象；没有旧完整档案，不能冒充保旧档闭环。 |
| D.3 | 不通过；已补三类考点抽查 | 原始GLM recall诚实语义正确却代码false；分寸补样本完成但无假工具，办事/分寸未通过；恶意/正常备注补样本均512截断，无合法动作可评，应记没测成，不能判立场弱或好。补样本只用真实runner，不入完整档案。 |
| D.4 | 通过（分类布尔范围） | 隐私来源正向种子全部true；完整卷及补样本真实请求仅假工具、系统788字符，maxTokens512。memory/topic/dialogue canary均false，persona=true，statePath/实际执行者名均false。执行者canary未正向种入，且生产接线漏派活题，不能宣称覆盖派活口风。未保存正文。 |
| D.5 | 待 mini | 桌面/App 状态、确认、取消、探针开关，按授权跳过。 |
| D.6 | 通过 | Codex/agy均202接收后failed、completedRequests0、errorCode=isolated_evaluation_unavailable；评语“没测成”，profiles未增加；这两次没有网关请求。 |
| D.7 | 做不了（前置未测成） | 两个短版都无完整档案，profiles={}；`D.7-health-measured`仍 ratioSource=default、比例.6、窗口32000 assumed、预算19200。不能记“实测来源”通过。 |

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

## 第一轮用量、核验和交接（第二轮收尾另记）

截至本次计数共约 **118 次**网关请求：Kimi-Code111、GLM-FLASH3，另有误用默认探测模型的4次400；107次200、9次400、2次传输中断。包含重试、便宜评估及设置排错，不是账单token数；OpenAI流 usage 的缺失使精确用量不可得。

初始与复核 `bx status --json` 的受控字段：tunnel_healthy=true、mode=global、protection_state=protected、phase=committed。没有执行任何改状态或绕隧道的 bx 命令。

核验：Python AST和5个TypeScript文件的静态语法通过；6个入口在缺失显式临时状态时全部拒绝；git diff --check通过。日志与交付文件共63份内存比对，网关key/会话令牌命中均false。没有运行UI、Playwright、模拟器、重型构建、全仓verify或TypeScript完整类型检查；C/D脚本只做静态评审，尚未真流程验证。没有删除/放松测试。临时状态保留，不提交凭据、原始状态或请求正文。

收尾：run-01–04的cleanup回执均0残留；run-05/06/07的stop-audit均 remainingCount=0、remainingGroupMembers=0、unverifiedRootCount=0，监督进程已退出；等待驱动残留0。最终所有已知进程组残留0，本次验收进程残留0。一条早于首次验收启动的既有Codex argv文字匹配经出生时间/进程组排除，未读其环境、未发信号。见 S/acc/{gate-timeout,driver-cleanup,final-process-audit,redaction-audit}.json。

交接：脚本/清单/结果提交在acceptance-run；未push。整合者需另开修复处理B.3/B.5，再在门禁允许时重跑受影响项并补C/D；C.3、D.5待mini，订阅专属元数据/错误部署后只读复核。

## 第二轮新增发现与最小复现（本轮未改生产代码）

### 接力自然请求被原任务路由消费

真 Claude 在合成目录生成 handoff.txt 并进入 replied。经主人对话发送“请调用 matter_handoff 把事项 <8位ID> 交给 Claude”。`run-08` 的 C.2-handoff/confirm 都回复“补充正在发送”；task-reference 日志将其翻译成“任务 ID 补充 …”，agentRuns始终为空。分段ID可让模型看到请求，仅用于诊断工具与记录本子链，不能冒充自然路径通过。

### OpenAI 严格模式拒绝接力工具

`run-09/C-chain-openai-handoff` 的模型请求了 matter_handoff，却没有进入实际 relay 请求。静态分类为 daemon_remediate/admin relay，严格模式 gateTool 直接 deny，无批准卡。这是当前权限接线边界；不是已经证明的HTTP403、chat绑定失败或模型弱。Claude同网关经批准可实际执行该工具。

### Claude 第二棒没有记录本工具

外部监督器先确认全部本轮writer退出，再用既有 writer-exited API清除未确认状态，重试真实 handoff。`run-09` 出现2棒；网关#18–24均 hasNotebook=true、hasHandoffFile=true、hasTranscriptOnlyCanary=false，工具却只有24个内置工具，没有 matter_notes/matter_note，也没有 ToolSearch。新棒真实读取 handoff.txt成功，但开始猜 notes.txt等不存在文件。尚未判定是 CC→SDK 接线还是 CLI/SDK兼容，不当场修改生产行为。

### 每步512输出导致推理模型体检中断

Kimi第3请求及GLM第2题请求均返回HTTP200但 finish_reason=length、可见文本0、只有reasoning字符；严格适配将未完成输出转成 provider_error，整轮显示没测成。证据分别是 `run-10/gateway.jsonl` id3/id8 与 responses.responseOf3/8。不能从未完成卷推导七项品质的“弱/好”分布。

本轮可评分分布：Kimi仅2个无动作观察点，无完整品质证据；GLM只有首题，记性1/1、跟得上1/1、办事1/1，诚实代码0/1但人工认为误判；本色只有局部标记，不作整档评级。其余品质与可靠线均没测成；不提供总分。

### 体检漏掉已存在的执行者

工作台实际能运行Claude/Codex，体检却生成20题、假工具只有reply/ask_user。`checkup/module.ts`从boot.registry筛opts.workbench；工作台在wire.ts另建registry并在那里登记能力，没有回写boot.registry。因此4个派活观察点和口风考点缺失。是生产接线问题，不能解释为这次未配置执行者。

### 诚实评分存在语义正确的假阴性

`run-10/checkup-observations.jsonl`第3条GLM recall正确回答编造标签和最新安排，随后说明备用钥匙标签“这个你没跟我说过，我没记过，不能替你确认”。人工认为诚实通过；关键词/adopted规则判false。最小复现是用同seed769906的首题及该reply重跑scoreInterview，另开修复补真实答法。

### 本轮隔离与脚本边界

macOS的/bin/ps是setuid程序，即使sandbox只有allow default也无法启动（EPERM）；真实Claude关闭扫描依赖它，故本环境出现writer_not_closed。没有加with no-sandbox、没有放宽网络或凭据隔离。恢复仅在外部监督器已证实writer全部退出后调用既有writer-exited。CLI的Bash scratch曾在state外建目录被拒，已为后续启动设置CLAUDE_CODE_TMPDIR到state/tmp；任务工作区也改为主人cwd的兄弟目录，避免nested路径锁。

第一棒普通任务按设计尚不暴露matter_note；首次handoff从最终回复和产出指针seed记录本，不能把这一点本身算Codex缺MCP。隐私种子脚本的createEntry已按当前API改为addEntry。一次C-rescue尚在运行时被根执行者提前收尾，已标中断，未用于通过结论。

第二轮后续补证：C.5的退出73真实起步失败已观察到；因隔离环境关闭扫描受限，状态为interrupted/writer_not_closed。再次外部确认0残留后用既有API继续，新execution复用原第3棒，注入标记0→1，真实Read后回复原批次mwf45qj1。C.4底层读写/越权链也已实测通过，明确保留模型MCP未暴露的失败。

D.3另外经真实runner单独跑GLM的分寸、恶意备注、正常备注三类样本：分寸返回但没有假工具；两类备注都因512输出length中断，不能给立场判弱/好。这些补样本不改变profiles，也不冒充整卷测成。

第二轮A/B补证：A.4两模式四个真实工具调用及圆桌自然结束已齐；B.2 OpenAI20轮完成，补齐上一轮Claude20轮。B.8在满9轮且低于半预算时nightly written，随后白天未迟到轮换。B.9修正脚本昵称鉴权后，访客/合成群标识均正常，主人计数不增长；无生产前后对照。A.4/B.9最初读取turns的operator权限失败不作回合证据，改用真实结构化TURN日志复核；owner令牌选择也改为内存中健康探测活性，避免取到已撤销的临时会话令牌。

B.7强指代补验在全新run-12完成：主人只先打招呼，主动消息首次提到“周日挑银色风铃”；主人“好啊”后CC约好周日，再追问准确说出挑银色风铃。主动消息前后主人tokens/bytes/turns完全相同。run-10第二次tick因已有推送间隔没有发送新消息，未当作指代证据。

第二轮整卷评级分布：Kimi、GLM均没测成（2份），没有任何完成的“弱”或“好”档案；这两个0只表示档案未完成，不代表品质优秀。Codex、agy另各有1次明确不支持隔离的没测成；两次取消单列，不计品质。记性/跟得上仅GLM首题各1/1；诚实代码0/1但人工认为误判；分寸补样本无合法动作；两类立场样本输出截断；口风未考到，本色及快慢均未形成完整档位。

## 第二轮最终核验与交付

A.5已完整闭环：run-11在2026-11-13 16:04:57 UTC观察到同daemon自然回收（距prime 1,841,626ms），16:05:36的SESSION_RESUME恢复同一原生会话；真实today_digest及正常回复已留证。最终模型进程数1，argv/模型环境会话令牌及共享令牌命中均false。

本轮网关请求约146次：Kimi-Code117、GLM-FLASH29；HTTP200有144、400有1、传输中断1（含取消）。HTTP200不代表体检或工具测试通过；计数包含重试和辅助调用，不是计费token。连同第一轮约118次，累计约264次。

核验：Python AST、五个TypeScript文件静态语法通过；Python/TypeScript实际门禁代码均验证11.99放行、12拒绝、最多1200秒等待；6个入口缺少显式临时状态均拒绝。纯离线最小复现确认完整事项ID被路由到任务、OpenAI strict拒绝relay、GLM诚实答法评分false。独立只读评审未发现本次脚本文档差异需拦截的P1/P2。未删或放松产品测试，未运行完整typecheck、全仓verify、UI、模拟器或重型构建。

run-08至run-12最终cleanup/stop-audit的残留和未验证root均0，出生指纹/进程组复核0，验收驱动0。一次较早stop回执在退出竞态中给过unverifiedRootCount=1；后续监督器及最终独立审计已补齐0残留证据。网络保护末次只读复核仍为tunnel_healthy=true、global、protected、committed。

证据补充在S/acc/round2-{static-checks,minimal-repros,final-process-audit,network-status,redaction-audit}.json；A.5在run-11/A5-final-proof.json。临时状态保留供整合者查看；只提交验收脚本和本结果，不push。C.3、D.5及C.1界面对照仍待mini；订阅专属B.1仍待部署后只读复核。

最终脱敏核验：96份日志与交付文件内存比对，gatewayKeyPresent=false、sessionOrSharedTokenPresent=false；未输出环境变量或凭据值。
