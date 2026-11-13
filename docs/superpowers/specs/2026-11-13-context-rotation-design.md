# 主人对话上下文轮换与当场记账（2026-11-13）

目标：CC 自己控制主人对话的上下文；Claude、OpenAI 兼容及不能 resume 的后端同一规则，换段前账本追齐，主人无提示。依据 11-12 总纲「少给，要用再取」「不绑一家」「管家体检」「现状核实」及面试稿「评语→补法」。本稿的参数与落点由本次读代码确定。

## 核实与选择

基线 `origin/dev = 852ea4ec`，独立工作区 `wt-context-rotation` / `context-rotation`。`SessionManager` 回收只关进程、保留 resume；`solo.ts` 仅不能续接的冷启动补最近 12 条；OpenAI 每步重发完整历史，恢复有 192 KiB 门，新建还会清旧记录。App 在 coordinator 返回后才写 messages；抽取水位 `entriesToTs` 是连续覆盖线，不能跳过中间的消息。夜间成功落点是 `features/memory/wire.ts` 的 afterSleep / consolidateTopics.failed=0，具体整理及轮换边界抽到 `topic-sleep.ts`，测试执行真实链路，不 mock 内部模块。

采用共享 app 策略 + daemon 接线 + provider 只报占用。放在 provider 内裁剪会分叉行为并牵连工作台；只在夜里换挡不住白天积累，均不采用。现成独立 worktree 无需再建；只有主执行者写文件，代理只读检查。

## 决定与落点

- **预算与占用**：共享策略经注入调用 `CheckupService.contextBudgetFor(provider, model)`，预算为 windowTokens × reliableFillRatio（保留实测 0）；未初始化/未测默认 8192 × .25，已知窗口仍经体检接口解析。模型用会话实际钉选/目标模型。OpenAI 提供最后一次请求 input+output（不是计费累计）及当前序列化历史字节；原生后端已有的整轮 usage 可能累计多次请求，因此只作为保守上界使用（缓存字段也计入，允许偏高）；没有回报就按 UTF-8 字节 / 2 向上估，含系统提示、接续块、输入、输出。原生工具不报结果大小时先保守预留一份完整预算；后续有 usage/真实历史快照再覆盖估计。OpenAI 的字节估计还含工具定义，并独立作为进程内硬触发线。恢复缺观测用消息历史的保守估量。估量是调度信号而非精确 tokenizer；单轮可越界，绝不半轮裁剪。
- **轮换安全点**：`coordinator/solo.ts` acquire 之前，在已有每 chat 互斥锁内；共享策略检查预算/夜间待办。manager 新增安全轮换口，pending spawn / dispatch 在途均拒；外部未决审批按主人 chat 保守拒绝，提问/工具悬在 iterator 中同样挡住。抽取 await 后再查一次。/reset、换模型等原路径照旧。工作台/终端不接策略。
- **先记账再换**：使用旧段最后已完成轮对应的消息上界；精确排除本轮微信已落库的入站 id，不以到达时间截断，保留上一轮较晚送达的回答；失败/取消轮在下一边界也重新检查尾部，目标未知时不换。连续水位未到先跑现有 threads extractor，校验来源授权、去重/supersede 路径不变。不可用/失败/批次上限后仍未追齐，保留旧会话和轮换请求，下轮重试并记日志。原始 messages、jsonl、OpenAI API records 均保留；只清 resume 指针，取消 OpenAI create 的历史删除。
- **四样接续**：统一中性接续块供轮换及不能 resume 的冷启动。原文按入站分轮，默认最近 6 轮；预算给接续一小部分，超量先移除最旧的整轮，至少保留最后一轮（超大原文按每条分别保留末段并标截断，长回答不能挤掉同轮主人短句）；当前未答输入由 formatInbound 原样追加，不重复。在办事项读取现有 projects_activity/活动摘要，一件一行、无模型。每轮 topics/recall 与系统提示 owner memory 保持现状。陪伴全文不重新塞入近况，只带一行结果。主人换 provider 也走同一预算块，访客旧交接行为保留。Codex/ACP 明报实际 resume 成败；未确认的原生续接也补小块，不把提供了 id 当续接成功。
- **持久化/可观测**：小型原子 JSON 状态保存各 owner key 的占用、轮数、最近轮换时间/原因、夜间请求、当场抽取频率及陪伴一行；不存原文/凭据。`/v1/health` 增加脱敏 owner context 状态（不含 chatId/path/sessionId），现有 status CLI 展示。轮换只写 `[CONTEXT_ROTATE] reason= provider= prevTurns= carried=`，不发用户提示。
- **当场记账**：solo 成功交付之后安排下一 macrotask，确保 App 消息已落库，不 await 模型、不影响回复延迟。非模型信号：主人文本长度、决定/偏好/承诺措辞或工具结果；每对话至少间隔 5 分钟、每日最多 24 次（尝试也计数，跨重启保留）。仅最近 12 条中由新往旧选不超过 6000 字的一个后缀，确保包含触发决定；旧 backlog 存在时当场条目可写但连续水位保持；轮换补抽取及夜间抽取按同一 DB/chat 锁串行，避免倒退；同时间戳边界整组读取，受限尾窗漏了其中任何行就不推连续水位。模型不可用静默跳过。
- **陪伴短会话**：`tick-dispatch.ts` 复用 tick-job 模式，独立 alias、真实 chatId（权限、人设、外发作用域不变），前后 forget；speech、claim、外发节流和可见消息记录原样。交付成功后记录一行结果供普通下一轮及轮换接续，开始派发才消费；外发 source 标为 speech:companion，近况和换 provider 交接均过滤其全文。短 alias 不进入主人轮换状态。
- **体检补法**：记性接实际预算；读取 `CHECKUP_CARE.discretion.policy` 并保留 enabled=false 的开关位，不改提示词、不改变拿不准时的说话方式；其余映射留表。体检晚初始化通过 bootstrap/module 的工厂与 late 读口注入，避开 bootstrap 与记忆功能的依赖环；活会话端点与当前体检端点不同时退保守预算。夜间整理成功后用 coordinator 同一互斥锁立即尝试轮换；账未齐/审批中则保留请求到下一安全边界。

## 验证与边界

先写离线行为测试并记录红：三类 provider 假会话、预算与实测/默认、busy/审批拒换、抽取失败保留、最近轮原文/刚才那个/在办行、夜间成功与失败、交付之后异步记账/频率/不可用、陪伴隔离、API 旧历史保留和进程内预算。再实现跑绿，独立只读审查。主 Mac `bun run verify` 在同一命令先查 load<8 且无 CivilizationVII，否则稍后重试；不跑 UI、不上 mini、不启动真实 daemon/模型。不删/放松旧测试，不新增 skip。验证绿后带 Co-Authored-By 提交，不 push。报告写指定 scratchpad。
