# 主人对话上下文轮换与当场记账（2026-11-13，第二轮修订）

最高原则：轮换为了避免撑爆窗口和记忆掉线，不是为了省 token。拿不准宁可不换。没有体检的 Claude 主人继续自然聊天，正常一天只应有一两次必要轮换；绝不按每轮工具调用机械换段。

## 核实与范围

第一轮提交 d458ae5e2 在本轮 rebase 最新 origin/dev（530278c3a）后成为 5baf4578c。本轮只追加提交，不部署、不 push。维护约定见根 AGENTS.md 和 docs/maintainer/README.md。共享 app 策略负责主人对话，provider 只报观测；访客、群聊及工作台不参与主人轮换。只有主执行者写指定 worktree，代理只读核查和评审。

第一轮缺陷是把 2048 token 当默认预算、把累计计费用量当上下文、把工具未知结果预留整份预算，再叠入系统提示和历史估量，造成每轮换段。本轮取消这些语义。

## 预算与占用

- **占用**是最近一次模型请求的输入 token。Claude 读取最后一个父 assistant 请求的 input + cache read + cache creation；同一 message id 的重复块不累加，子 agent 与 result 的整轮累计 usage 不算。OpenAI 读取最后一步 prompt/input，不加 output、不加请求后产生的工具结果字节。计费用量照原样累计，二者独立。
- 新段尚无 provider 回报时占用未知，不按量轮换。系统提示字节、全部 canonical 消息、每个工具的假定大小都不作轮换证据。已有首请求输入后，最新请求缺 usage 时才可用该请求真实字节作回退；没有可信首请求基线仍不按量换。未知工具结果不预留任何 token。
- **固定开销**取新段第一次请求的输入，包含系统提示、工具定义及首次输入。保存首次请求证据，不把后来较大的工具请求误当首请求。第一请求未测得时保持未知；恢复原段保留原基线。
- **历史下限**为 `max(24000, ceil(window × .15))`；**预算**为 `max(floor(window × ratio), fixedOverhead + historyFloor)`。只有固定开销不换，历史占用为 `max(0, occupancy - fixedOverhead)`。
- 未体检比例 .6，实测使用值夹在 [.2,.8]，原始体检分数保留；实测 0 不会给出预算 0。窗口未知按 32000 假设；SDK/可信配置已知窗口优先，按 provider + 规范端点摘要 + 实际模型 id 写入原子 JSON。跨重启读取标为 persisted，新观测标为 measured，未知标为 assumed。模型 alias 不覆盖已解析的实际模型。
- 按量换段至少相隔 8 个完成轮次，新段也至少保留 8 轮。夜间成功整理仍请求换段，但只有已知占用达到预算一半且已有历史才执行；低于一半保留原段。

## 安全边界与记账

在 coordinator 的每 chat 互斥锁内、下一次 acquire 前作判断；在途、pending spawn、未决审批不换。锁内只读本地状态、连续记账水位、接续资料，不同步调用抽取模型。

记账落后时登记待追赶、保留旧会话，这轮直接正常回复。成功交付后的下一 macrotask（App canonical messages 落库后）异步追赶；后续轮间再判断是否可换。失败/取消轮的入站仍纳入下一次边界判断。边界按当前输入身份排除，不能按其到达时间截断，因此上一轮较晚送达的回答仍保留。

追赶与当场/夜间使用同一 extractor、同库/chat 锁、水位与去重/supersede 路径。追赶补齐夜间相同的 `readWorkResults(localTopicContext)` 与 `topicMatterAccess(...).entryAllowed` 来源授权；owner 与来源在模型前后再次核验，撤权不落条目（#907）。

当场记账仍是非模型信号准入、最近 12 条/6000 字一批、5 分钟冷却、每日最多 24 次尝试，跨重启保留；不可用不拖回复。待追赶优先于普通小批记账。

状态记录推迟次数与最近受控原因，重复检查同一完成轮不重复计数；连续 20 轮或 24 小时未能轮换，通过已有 health owner_context 和事件记录给一次 accounting delayed 提示。不会把它报成 LLM 链路断线或暂停聊天。成功换段复位本次连续告警；更换主人不会向新主人报旧主人的故障。

## 接续块与主动原文

接续固定最近最多 **6 轮、整个块最多 12000 字符**，与模型预算无关。先分配主人原文，再分配 CC 回复、主动消息和辅助行；超长单条保留开头、结尾及“中间省略”标记，不只留尾巴。canonical 查询单独保留最近六条主人入站，主动气泡不能把它们挤出查询。附件只放占位与文件名，不放路径/文件数据；上一已完成 chat 轮的工具给名称及可证实状态，无结果记录时明确说未记录，不伪造成功。

包含所有 `speech:*` 送达原文并标时间。普通 resume 下一轮也读取上次主人发言以来的主动原文，套同一字符上限；“你刚才说的那个”能看到 CC 实际说过的话。正在办事项取现有活动读口，一件一行；topics/recall 和 owner memory 不变。接续读失败不丢旧段。

Claude 有效 resume 明报成功；重启/idle 后继续原段不重复注入接续。只有实际新段、resume 明确失败、不能 resume 的冷启动或换 provider 才补块。其他 native provider 未确认恢复仍保持保守接续。

## 主动短会话与保留期

只有主人定时动作使用独立 `companion:<uuid>`，真实 chatId、人设、权限、外发节流和 claim 保持原样；访客/群继续原项目会话。独立会话开场复用同一接续（近期对话 + 在办），保留主人钉选模型。准备接续在 acquire/claim 前完成，所有 acquire 后路径进入 finally 清理。下一轮送达资料使用原文，不再是“agenda:已送达”。

短会话标记 ephemeral：Claude `persistSession:false` 防止产生原生项目 transcript，Codex thread/start ephemeral，OpenAI 使用仅内存历史且不保存 resume 指针；会后 forget。UI 会话列表、CLI 列项目/聊天、搜索和摘要过滤内部 companion 别名，网络守护/执行冲突等安全读口保留完整运行列表。

OpenAI 恢复 **8 天**保留清扫，适用于所有对话：创建新段时只清过期、已退休且无真实 live handle/当前 resume 指针的旧段；近期旧段不删，当前段不动，崩溃遗留 active 不永久豁免。与原实现差别：不再新建就立即删除同 chat/alias 旧段，也不再无限保留所有旧段。canonical messages 不由此清扫。

## 可观测与离线验收

`/v1/health.owner_context` / status 同时展示窗口及来源、比例及来源、固定开销、历史占用、预算、已知/未知观测、完成轮数、最近轮换及推迟原因；不暴露 chatId、sessionId、原文或路径。

每项补主人连贯性正向测试，包含真实 coordinator + SessionManager 的 40 轮/每轮三次工具/四万字系统提示场景（Claude 200k 不换、OpenAI 未知窗口轮换间隔≥8）、cold resume 不重复、provider 请求/计费分离、未知/比例零/持久窗口、6轮12000字符/长文头尾/主动原文/附件工具、可控追赶不阻塞、来源撤权、20轮/24h告警、八天回收和当前段保护、访客群旧行为、列表隐藏。

测试先红后绿；独立只读审查仅报正确性。主 Mac 同命令检查 load<8 且无 CivilizationVII 再运行 bun run verify；不跑 UI、不上 mini、不触碰 daemon/模型/生产库/已安装 App。负载门禁最多等30分钟。报告写用户指定 scratchpad，验证绿后追加 Co-Authored-By 提交，不 push。
