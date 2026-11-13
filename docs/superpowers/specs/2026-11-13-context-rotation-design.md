# 主人对话上下文轮换与当场记账（2026-11-13，第三轮修订）

最高原则：轮换为了避免撑爆窗口和记忆掉线，不是为了省 token。原生会话拿不准宁可不换；OpenAI 兼容通道每步重发完整历史，缺 usage 时以真实请求体估量作刹车。没有体检的 Claude 主人继续自然聊天，正常一天只应有一两次必要轮换；绝不按每轮工具调用机械换段。

## 核实与范围

第三轮复核起点为 `983836393`；已 fetch/rebase `origin/dev`（`530278c3a`），无须重放。

第一轮提交 d458ae5e2 在本轮 rebase 最新 origin/dev（530278c3a）后成为 5baf4578c。本轮只追加提交，不部署、不 push。维护约定见根 AGENTS.md 和 docs/maintainer/README.md。共享 app 策略负责主人对话，provider 只报观测；访客、群聊及工作台不参与主人轮换。只有主执行者写指定 worktree，代理只读核查和评审。

第一轮缺陷是把 2048 token 当默认预算、把累计计费用量当上下文、把工具未知结果预留整份预算，再叠入系统提示和历史估量，造成每轮换段。本轮取消这些语义。

## 预算与占用

- **占用**是最近一次模型请求的输入 token。Claude 读取最后一个父 assistant 请求的 input + cache read + cache creation；同一 message id 的重复块不累加，子 agent 与 result 的整轮累计 usage 不算。OpenAI 读取最后一步 prompt/input，不加 output、不加请求后产生的工具结果字节。计费用量照原样累计，二者独立。
- 原生会话新段尚无 provider 回报时占用未知，不按量轮换。系统提示字节、全部 canonical 消息、每个工具的假定大小都不作轮换证据。已有首请求输入后，最新请求缺 usage 时才可用该请求真实字节作回退；没有可信首请求基线仍不按量换。未知工具结果不预留任何 token。
- **OpenAI 兼容通道例外（真模型验收修复）**：对话、工作台、delegate、cheapEval/strongEval 和体检共用 APIModel，所有流式请求开启 `stream_options.include_usage=true`。端点首次以 400/422 明确拒绝 `stream_options` / `include_usage` 参数时，记住该端点不支持，去掉参数仅重试一次；后续该端点直接省略，其他端点不受影响。认证、模型不存在、参数值非法等不触发此降级。每次重发仍过守护与取消检查。
- **兼容通道缺 usage 时按真实发送的 UTF-8 请求体字节数 / 3 向上取整**参与按量轮换，状态为 `source=bytes`，不要求首请求 token 基线。字节由传输层在 SDK 序列化之后记录，包含本次 system、历史、工具定义、附件及协议开销，不计响应或未送出的工具结果。没有真实序列化证据时仍保持原来的未知规则；估量不冒充计费用量、实测固定开销或模型窗口。Claude 等原生会话保持未知不换，8 轮及记账边界门槛保留。
- **固定开销**取新段第一次请求的输入，包含系统提示、工具定义及首次输入。保存首次请求证据，不把后来较大的工具请求误当首请求。第一请求未测得时保持未知；恢复原段保留原基线。首次部署续接的旧原生会话没有基线时，后续的整段请求不能冒充固定开销；状态为 null，预算只用窗口×比例。真正新开段后重新测首请求。
- **历史下限**为 `max(24000, ceil(window × .15))`；**硬顶**为 `floor(window × .85)`；有基线的**预算**为 `min(硬顶, max(floor(window × ratio), fixedOverhead + historyFloor))`，无基线则 `min(硬顶, floor(window × ratio))`。固定开销加历史下限超过硬顶时仍取硬顶，状态标“窗口偏小”。只有固定开销不换，历史占用为 `max(0, occupancy - fixedOverhead)`。
- 未体检比例 .6，实测使用值夹在 [.2,.8]，原始体检分数保留；实测 0 不会给出预算 0。轮换窗口未知按 32000 假设，Claude provider 提供独立的 200000 保守轮换基线；体检仍用原来的 8192/.25 默认及展示，不把保守轮换基线冒充 SDK 观测。SDK/可信配置已知窗口优先，按 provider + 规范端点摘要 + 实际模型 id 写入原子 JSON。跨重启读取标为 persisted，新观测标为 measured，未知标为 assumed。模型 alias 不覆盖已解析的实际模型。Claude 窗口键两头去后缀并关联严格 family alias；有后缀的推导容量保守限制到 200k，避免把普通线程推到 1M。合成 API 错误不覆盖实际模型或用量；SDK result 多模型项不取首项/最大项。
- 按量换段至少相隔 8 个完成轮次，新段也至少保留 8 轮。夜间成功整理只在紧接整理的 `rotateIdle` 轮间窗口评估一次；换、不换或推迟都消费 generation，不留到白天。已知占用达到预算一半、有历史、新段已完成至少8轮才执行。并行/chatroom 模式不参与这条主人 solo 策略。

## 上下文超长恢复

错误码 `context_overflow` 在 `lib/provider-error-code.ts` 集中判定：Claude prompt-too-long、OpenAI 兼容 code/400 maximum-context、LiteLLM ContextWindowExceededError、`exceeded model token limit`、`maximum context length is N tokens`、带容量或超限说明的 `context window`、`prompt is too long`、`input is too long`、`too many tokens`、Codex contextWindowExceeded 和 ACP 错误封套。带不带 requested 数字都恢复。只处理错误通道，不扫描正常回答，不把输出上限/额度/限流当超长。

主人 solo 在同一 chat 锁内立即 forget 旧段、读取 canonical 接续并重试当前入站一次，不受8轮、审批记账水位或夜间 generation 限制；原文仍在 canonical 库，事后照常抽取。第二次失败才通知主人；新 spawn 的认证/网络失败保留原有码。两次尝试共用同一运行记录，失败片段不作为回复交付。

错误文案独立解析 limit 与 requested（支持 `requested: N` 及千位逗号）；有明确 limit 时优先将它按 provider+规范端点+实际模型原子保存为窗口实测上界，否则用拒绝输入数作上界。以后预算在已知窗口与最小实测上界中取小，跨重启保留，不污染其他端点、模型或 provider。没有任何计数的 legacy resume 仍立即恢复，但只记 `overflow_input_unknown`，不以短用户输入字节伪造整段输入并永久污染窗口。窗口读/写失败保留安全回退，打受控日志，并在 health/status 的 budgetError 显示。

**未识别错误的保险丝只用于 OpenAI 兼容主人会话**：连续两轮以同样的 4xx 失败，且第二轮实际请求体未缩小，下一轮开新段并带接续。已知认证、额度和限流不入保险丝，保留各自处理，避免换段丢掉无须丢弃的历史。相同错误按 HTTP status + 规范化错误摘要判断，变化的数字（例如 requested 数）不影响同类识别；持久化只存摘要、状态、字节和次数，不存错误正文。成功、不同错误、请求缩小或真正新段复位。保险丝不在失败当轮盲目重试，不记录虚假的窗口上界；日志标记 `reason=failure_fuse`（health 兼容使用已有 overflow 原因），绕过按量的 8 轮与记账滞后门槛，仍须无在途请求且接续读取成功。

## 安全边界与记账

在 coordinator 的每 chat 互斥锁内、下一次 acquire 前作判断；在途、pending spawn、未决审批不换。锁内只读本地状态、连续记账水位、接续资料，不同步调用抽取模型。

记账落后时登记待追赶、保留旧会话，这轮直接正常回复。成功交付后的下一 macrotask（App canonical messages 落库后）异步追赶；后续轮间再判断是否可换。失败/取消轮的入站仍纳入下一次边界判断。边界按当前 canonical 输入身份定位锚点，当前和之后排队的入站均排除；出站不按锚点截断，因此上一轮较晚送达的回答仍保留。主动原文与记账水位共用这一边界；App 当前尚未落库时兼容原路径。

追赶与当场/夜间使用同一 extractor、同库/chat 锁、水位与去重/supersede 路径。追赶补齐夜间相同的 `readWorkResults(localTopicContext)` 与 `topicMatterAccess(...).entryAllowed` 来源授权；owner 与来源在模型前后再次核验，撤权不落条目（#907）。

当场记账仍是非模型信号准入、最近 12 条/6000 字一批、5 分钟冷却、每日最多 24 次尝试，跨重启保留；不可用不拖回复。待追赶优先于普通小批记账。

状态记录推迟次数与最近受控原因，重复检查同一完成轮不重复计数；连续 20 轮或 24 小时未能轮换，通过已有 health owner_context 和事件记录给一次 accounting delayed 提示。不会把它报成 LLM 链路断线或暂停聊天。成功换段复位本次连续告警；更换主人不会向新主人报旧主人的故障。状态与 idle 轮换先按当前 alias、已注册 provider 和 solo/primary 模式筛掉已退休段；只清理策略元数据，不 forget parallel/chatroom 中仍在用的原生句柄或续接指针。

## 接续块与主动原文

接续固定最近最多 **6 轮、整个块最多 12000 字符**，与模型预算无关。先分配主人原文，再分配 CC 回复、主动消息和辅助行；超长单条保留开头、结尾及“中间省略”标记，不只留尾巴。canonical 查询单独保留最近六条主人入站，主动气泡不能把它们挤出查询。附件只放占位与文件名，不放路径/文件数据；上一已完成 chat 轮的工具给名称及可证实状态，无结果记录时明确说未记录，不伪造成功。

包含所有 `speech:*` 送达原文并标时间。普通 resume 下一轮也读取上次主人发言以来的主动原文，套同一字符上限；“你刚才说的那个”能看到 CC 实际说过的话。正在办事项取现有活动读口，一件一行；topics/recall 和 owner memory 不变。接续读失败不丢旧段。

Claude 有效 resume 明报成功；重启/idle 后继续原段不重复注入接续。只有实际新段、resume 明确失败、不能 resume 的冷启动或换 provider 才补块。其他 native provider 未确认恢复仍保持保守接续。

## 主动短会话与保留期

只有支持无原生持久化的 provider 的主人定时动作使用独立 `companion:<uuid>`，真实 chatId、人设、权限、外发节流和 claim 保持原样；访客/群继续原项目会话。独立会话开场复用同一接续（近期对话 + 在办），保留主人钉选模型。准备接续在 acquire/claim 前完成，所有 acquire 后路径进入 finally 清理。下一轮送达资料使用原文，不再是“agenda:已送达”。

provider 显式声明 `supportsEphemeralSessions` 才能隔离。短会话标记 ephemeral：Claude `persistSession:false` 防止产生原生项目 transcript，Codex thread/start ephemeral，OpenAI 使用仅内存历史且不保存 resume 指针；会后 forget。各家的实际做法：

| Provider | 主人定时动作 |
|---|---|
| Claude | 独立段，persistSession:false，会后 forget |
| Codex | 独立 thread/start ephemeral，会后 forget |
| OpenAI 兼容 | 独立内存历史，不存 resume 指针，会后 forget |
| ACP：Cursor / 自定义 | 复用主人项目会话，不创建 companion 原生段 |
| Gemini | 复用主人项目会话，维持原生命周期 |
| agy | 复用主人项目会话，维持原生命周期 |

主人钉选模型在两种做法下均保留；访客/群不新增模型钉选或 native resumedHistory 冷启动块。speech:companion 仅标主人对话；canonical 来源保留主动出处，App读口按 durable app:companion 身份仍显示手机通道；旧微信 exact-id 送达对账继续认 tagged 微信原文，App/导入记录不因此冒充微信回执。

UI 会话列表、CLI 列项目/聊天、搜索和摘要过滤内部 companion 别名，网络守护/执行冲突等安全读口保留完整运行列表。

OpenAI 恢复 **8 天**保留清扫，适用于所有对话：创建新段时只清过期、已退休且无真实 live handle/当前 resume 指针的旧段；近期旧段不删，当前段不动，崩溃遗留 active 不永久豁免。与原实现差别：不再新建就立即删除同 chat/alias 旧段，也不再无限保留所有旧段。canonical messages 不由此清扫。

## 可观测与离线验收

`/v1/health.owner_context` / status 同时展示窗口及来源、比例及来源、窗口偏小与预算存取错误、固定开销（未知为null）、历史占用、预算、已知/未知观测、完成轮数、最近轮换及推迟原因；不暴露 chatId、sessionId、原文或路径。

每项补主人连贯性正向测试，包含真实 coordinator + SessionManager 的 40 轮/每轮三次工具/四万字系统提示场景（Claude 200k 原场景不换，另加第14/28轮越预算后换段并续原文；OpenAI 未知32k占用≤窗口，第8/16/24/32轮后换段）、cold resume 不重复、provider 请求/计费分离、未知/比例零/持久窗口、6轮12000字符/长文头尾/主动原文/附件工具、可控追赶不阻塞、来源撤权、20轮/24h告警、八天回收和当前段保护、访客群旧行为、列表隐藏。

测试先红后绿；独立只读审查仅报正确性。主 Mac 同命令检查 load<8 且无 CivilizationVII 再运行 bun run verify；不跑 UI、不上 mini、不触碰 daemon/模型/生产库/已安装 App。负载门禁最多等30分钟。报告写用户指定 scratchpad，验证绿后追加 Co-Authored-By 提交，不 push。

## 验收第三轮复核补修（2026-11-13）

按量轮换使用同一份 recent 快照完成接续投影和记账门。最近一轮只有全文实际携带时可免等记账；6轮、12000字符头尾裁切及128条出站查询上限丢弃的原文，其最晚时间必须先记账。省略行缺失/非法时间保守拒换；追赶目标取门与当前已送达边界的较大值。当前入站及排队入站仍按身份和 `(ts,rowid)` 排除，上轮晚送出站仍携带。

时间水位不能冒充插入游标：后来插入同时间或更早的 canonical 消息，在插入事务中将连续水位退到该时间前1ms。抽取开批冻结插入 revision；提交水位时检查原水位及本批时间上界以内的新插入，防异步结果覆盖回退。正常到达、时间晚于本批边界的新消息不取消旧批，避免持续聊天再次阻塞补账。

新消息正文在话题抽取提示中完整送出，批次字符预算按完整正文计算；已记账的历史尾部仍可截短。单条超出批次目标时至少尝试完整这一条；若廉价模型因窗口限制拒绝，水位保持，不允许把未送出的中段当成已抽取。
