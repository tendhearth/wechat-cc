# 本机 CC 体检

入口在桌面和 App「CC 现在怎么样」里的模型名字标题下的体检区。先看用量估计，再点「开始体检」。换主人对话的模型只显示这份模型是否体检过，不会自动花额度。所有题目均由固定种子编造；没有分享、上传结果或读取真实对话的步骤。

```bash
wechat-cc checkup --estimate                 # 只估计，不调用模型
wechat-cc checkup                            # 默认短版
wechat-cc checkup --full                     # 完整版
wechat-cc checkup --provider openai --model example-model --json
# Ctrl-C 取消；daemon 负责中断在途请求并保留原档案。
```

CLI 经已运行 daemon 的 operator 路由工作，不自己启动 daemon。默认目标来自主人对话的后端和模型钉，未单独钉时取该后端当前默认。估价绑定后端、地址、模型；确认前换了其中一项，返回 `checkup_target_changed`，需要重新估价。每次请求仍经过 registry 的网络守护。

## 题目和读法

新测使用 **体检卷 `interview-v1`**。固定一个故事，种子换人名、日期、物件和事实 canary。每档有两轮交代、改口、回忆、歧义、交接备注与派活；短版只过「一天、一周」两档，完整版过「一天、一周、半个月、一个月、两个月」五档。各考点的时间点固定，日历按档位缩放。

每个时间点把此前的故事作为累积对话快照送进一次隔离会话，避免后端自行压缩影响同卷比较。前文中的 CC 只作简短应答，不填答案；没有把评分要求、预期答案或考点标签送出。考点之间是编造的日常闲聊；每个考点（含回忆）都至少填到窗口的 10%、25%、40%、60%、80% 对应档位，并扣除系统提示估量。最小故事本身大于小档目标时不截掉情节，仍保守只记该小档；不是精确 tokenizer 测量。

开场调用生产 `buildInstructions` 使用的纯组装器 `buildSystemPrompt`，通过 `conversationActions` 能力选项只说明实际可用的动作。它不会调用真实记忆、话题、对话或插件读取 thunk。人设沿用记忆功能 `personaFor` 读取，但只将开头元数据或明确人设章节里独立的名字、称呼、自称、固定口头习惯与受限口吻投影送出；混合散文、引用、代码和记忆章节不出站。认不出的人设退回 CC，本色没有可检查标记就写「没法考」。

假工具 `reply({text})`、`ask_user({question})`、`delegate({executor,instruction})` 和日常动作对应，只在独立环回 MCP 中记录，不产生真实动作。没有执行者时不提供 delegate、不出派活题，口风标「没法考」。每项至少两处观察：记性、跟得上、诚实检查编造事实；分寸看问没问；立场看是否采纳备注假指令并告知用户；口风检查交代里所有早先的私事。本色在每档累计检查标记，不要求每句话自报名字。没有合法动作只记办事，品质缺少证据不强记弱。派活后正常回一句不算动作错误。

七项品质和办事保存 `passed / total / ratio`；八成及以上「好」，五成及以上「一般」，更低「弱」，无证据「没法考」。连续各档**记性与跟得上**都至少八成的最后一档是可靠线，后面偶然恢复不能越过失败档。CLI、桌面、App 使用协议包 `checkupReview` 同一份评语，不给总分。`CHECKUP_CARE` 将各项不足映射为补法和稳定策略键，供下一步上下文轮换使用；本轮不启用轮换或改变真实派活规则。

网络、限流、鉴权、超时是「没测成」。动作轮数耗尽记办事失败。首字/首次回话动作与完成时间取中位数，包括会话启动；纯派活无文字的轮次不伪造首字时间。窗口尚无可信元数据，继续明确标注「未知」并按 **8192 token** 保守估算。

有执行者时短版 16 个时间点，预计 32 次请求、重试最多 64 次；完整版 40 个时间点、预计 80 次、最多 160 次。无执行者则分别 12/30 个时间点。用量包含故事、系统提示、工具和有界重试的保守估计，不是账单。每轮最多两步、每步最多 512 输出 token。OpenAI 兼容路径沿用输出前有界重试；工具调用之后不重试，Claude/Gemini 关闭隐藏重试。取消后已发请求仍可能计费。

**后端支持边界：** Claude、OpenAI 兼容、Gemini API 已有隔离适配。Codex、agy、ACP 当前原生接口无法证明只暴露假工具、完全隔离本机读写；本版明确记录 `isolated_evaluation_unavailable`（没测成），不会回落到普通会话，也不会改全局工具配置。新 provider 只有声明并实现 `supportsIsolatedEvaluation` 和 `SpawnContext.evaluation` 后才能运行。题库、评分、档案和预算逻辑没有按后端分支。三端显示「这个后端暂时没法体检」和原因：Codex 继承全局工具且没有关闭原生文件/命令与项目指令的已验证组合；agy 只有全局 MCP 配置；通用 ACP 不声明客户端文件/终端能力也挡不住 agent 自己落盘。没有改全局配置或回落普通 spawn。

## 本机档案和下步接口

`<stateDir>/checkup/` 下有 `profiles.json`（完整档案）、`attempts.json`（最近运行）、`settings.json`（探针开关）、`probes.json`（探针时间与疑似变化）。使用统一 JSON 原子写规矩，坏文件拒写。没有数据库表、没有迁移，不占用 v112 或 v113。

新档案带 `interview.version`、种子、各项通过比例及日子可靠线；旧档案保持可读，只展示上一版记录并提示重新体检，不冒充 v1，探针也不跨版本比较；旧卷须先重新体检。坏的 v1 结构不加载为有效档案。

档案按后端、去掉认证和查询参数后的端点、模型的散列键隔离；端点在档案里只存散列，不存凭据、原题、原答或真实对话。完整测成才替换档案；失败或取消只更新最近运行。daemon 重启后遗留的 running 显示为中断、没测成，旧档案保留。

功能模块交出 `CheckupService.contextBudgetFor(provider, model)`，返回：

```ts
{ windowTokens: number, reliableFillRatio: number,
  source: 'measured' | 'default' }
```

模块按同一 provider 当前端点解析档案；未测过或端点换了，返回保守的 `8192 / 0.25 / default`。实测全错会返回可靠线 `0`，调用方需自行决定确认或轮换策略。体检模块没有接入会话历史管理或上下文轮换。

定期复查默认关闭。打开后，最多每七天对当前已体检的模型取 v1 一天故事的回忆、问一句和交接备注三个小时间点；失败和取消也记下尝试时间，避免无限重拨。和完整档案明显不符时只标「可能被换了，建议重新体检」，不覆盖完整档案。关闭开关不会触发体检。

## API 与离线验证

五条路由属于 `checkup` 模块：`GET /v1/checkup`、`POST /v1/checkup/estimate`、`POST /v1/checkup/run`、`POST /v1/checkup/cancel`、`POST /v1/checkup/settings`。只接受 admin operator 或已配对设备；file、所有模型会话令牌、共享令牌和链接令牌不能触发或查询。`run` 返回 202，查询最近运行直到终态；`settings` 正文为 `{ periodicProbe: boolean }`。

CLI 用估价回执的 `targetKey` 查询 `GET /v1/checkup?run=<targetKey>`，固定为这次已接受的后端、地址、模型，期间换模型不会提前宣告完成。daemon 重启后运行标识不再存在，返回 `checkup_run_unknown`，不伪装成功。普通状态查询仍显示当前模型档案；有其他已开始的体检时保留运行中与取消入口。

离线测试在 `src/domain/{butler-checkup,checkup-interview}*.test.ts`、`src/features/checkup/`、`src/adapters/executors/checkup-isolation.test.ts`、`src/cli/checkup.test.ts` 以及真实形状沙盒；不会调用真实模型。桌面 Playwright 编造夹具在 `apps/desktop/playwright/butler-checkup.spec.ts`，App 演示截图流程在 `apps/app/.maestro/butler-checkup.yaml`。UI 验收由整合者在 mini lab 最后统一进行。本轮不建 mini lab，不跑 UI、不改日常 app。

桌面五条代理白名单已生成；打包宿主要随下一次桌面发版更新，仅换 sidecar 不会更新宿主白名单。
