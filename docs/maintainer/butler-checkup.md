# 本机管家体检

入口在桌面和 App「CC 现在怎么样」里的「管家状态」。先看用量估计，再点「开始体检」。换主人对话的模型只显示这份模型是否体检过，不会自动花额度。所有题目均由固定种子编造；没有分享、上传结果或读取真实对话的步骤。

```bash
wechat-cc checkup --estimate                 # 只估计，不调用模型
wechat-cc checkup                            # 默认短版
wechat-cc checkup --full                     # 完整版
wechat-cc checkup --provider openai --model example-model --json
# Ctrl-C 取消；daemon 负责中断在途请求并保留原档案。
```

CLI 经已运行 daemon 的 operator 路由工作，不自己启动 daemon。默认目标来自主人对话的后端和模型钉，未单独钉时取该后端当前默认。估价绑定后端、地址、模型；确认前换了其中一项，返回 `checkup_target_changed`，需要重新估价。每次请求仍经过 registry 的网络守护。

## 题目和读法

短版有五道记性题、三道工具题；完整版每档记性题重复三次、工具题六道。每道题均用新的一次性会话，和 `eval run` 一样收事件、设总时限并收尾，但完全不调用生产提示词组装、记忆或真实工具。三条事实分别放在对话较早、中间、较晚的位置，逐档按窗口估算的 10%、25%、40%、60%、80% 填充。按位置精确核对 JSON 答案，不用另一个模型当裁判。

每档准确率至少八成才算可靠；连续达标的最高档是可靠线。六成以上显示「好」，至少四分之一显示「一般」，更低显示「弱」。后面偶然答对不能跨过前面已经不可靠的档位。工具题核对实际假工具调用的名称、唯一调用次数和全部参数；不能用文字声称完成冒充调用。工具轮数耗尽算答错，网络、限流、鉴权、超时则是「没测成」。首字与完成时间取中位数，包括一次性会话启动耗时；没有文字的轮次不伪造首字时间。

窗口来自保守假设 **8192 token**，本版尚没有可信的后端窗口元数据，结果明确标「窗口未知」。填充和输入量按 UTF-8 字节粗估，属于测试工作点，不是账单或上游窗口的承诺。短版预计约 11 次模型请求，含重试按最多 27 次估计；完整版约 27 次，含重试最多 69 次。工具题最多两步，回答输出预算每步 512 token。OpenAI 兼容路径复用 #906 的输出前有界重试；调用工具之后不重试。Claude、Gemini 关闭体检路径内的隐藏重试。取消后已发出的请求仍可能由上游计费。

**后端支持边界：** Claude、OpenAI 兼容、Gemini API 已有隔离适配。Codex、agy、ACP 当前原生接口无法证明只暴露假工具、完全隔离本机读写；本版明确记录 `isolated_evaluation_unavailable`（没测成），不会回落到普通会话，也不会改全局工具配置。新 provider 只有声明并实现 `supportsIsolatedEvaluation` 和 `SpawnContext.evaluation` 后才能运行。题库、评分、档案和预算逻辑没有按后端分支。上述原生后端的完整支持仍是交付缺口，不能把它们当作已体检或能力弱。

## 本机档案和下步接口

`<stateDir>/checkup/` 下有 `profiles.json`（完整档案）、`attempts.json`（最近运行）、`settings.json`（探针开关）、`probes.json`（探针时间与疑似变化）。使用统一 JSON 原子写规矩，坏文件拒写。没有数据库表、没有迁移，不占用 v112 或 v113。

档案按后端、去掉认证和查询参数后的端点、模型的散列键隔离；端点在档案里只存散列，不存凭据、原题、原答或真实对话。完整测成才替换档案；失败或取消只更新最近运行。daemon 重启后遗留的 running 显示为中断、没测成，旧档案保留。

功能模块交出 `CheckupService.contextBudgetFor(provider, model)`，返回：

```ts
{ windowTokens: number, reliableFillRatio: number,
  source: 'measured' | 'default' }
```

模块按同一 provider 当前端点解析档案；未测过或端点换了，返回保守的 `8192 / 0.25 / default`。实测全错会返回可靠线 `0`，调用方需自行决定确认或轮换策略。体检模块没有接入会话历史管理或上下文轮换。

定期复查默认关闭。打开后，最多每七天对当前已体检的模型问三道小题；失败和取消也记下尝试时间，避免无限重拨。和完整档案明显不符时只标「可能被换了，建议重新体检」，不覆盖完整档案。关闭开关不会触发体检。

## API 与离线验证

五条路由属于 `checkup` 模块：`GET /v1/checkup`、`POST /v1/checkup/estimate`、`POST /v1/checkup/run`、`POST /v1/checkup/cancel`、`POST /v1/checkup/settings`。只接受 admin operator 或已配对设备；file、所有模型会话令牌、共享令牌和链接令牌不能触发或查询。`run` 返回 202，查询最近运行直到终态；`settings` 正文为 `{ periodicProbe: boolean }`。

CLI 用估价回执的 `targetKey` 查询 `GET /v1/checkup?run=<targetKey>`，固定为这次已接受的后端、地址、模型，期间换模型不会提前宣告完成。daemon 重启后运行标识不再存在，返回 `checkup_run_unknown`，不伪装成功。普通状态查询仍显示当前模型档案；有其他已开始的体检时保留运行中与取消入口。

离线测试在 `src/domain/butler-checkup*.test.ts`、`src/features/checkup/`、`src/adapters/executors/checkup-isolation.test.ts`、`src/cli/checkup.test.ts` 以及真实形状沙盒；不会调用真实模型。桌面 Playwright 编造夹具在 `apps/desktop/playwright/butler-checkup.spec.ts`，App 演示截图流程在 `apps/app/.maestro/butler-checkup.yaml`。UI 验收由整合者在 mini lab 最后统一进行。本轮不建 mini lab，不跑 UI、不改日常 app。

桌面五条代理白名单已生成；打包宿主要随下一次桌面发版更新，仅换 sidecar 不会更新宿主白名单。
