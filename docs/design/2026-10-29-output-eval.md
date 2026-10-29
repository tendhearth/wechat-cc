# AI 输出回归评测(2026-10-29)

> 主人 10-29 定:存 20–30 条真对话当固定样本,改提示词或换模型就跑一遍,硬规则 + 便宜模型打分。
> 这份是设计稿;做完在文末「进度」加一行。

## 要回答的问题

改了 `prompt-builder.ts`、早报信封、裁判提示词,或者换了默认模型 / 便宜模型之后:**以前答得对的那些,现在还对不对?**
单测钉的是代码(给定模型输出,交付对不对);这里钉的是**模型 + 提示词**这一对,单测管不到。

## 不做什么

- 不进 CI:要真模型、要花钱、要 bx。手动跑,和 `selftest` 一样是整合者的工具。
- 不复活 `eval/companion/`:那是陪伴口吻的多日轨迹,开整个 daemon + 假 ilink,一条半分钟到一分钟;目标不同,留着不动。
- **真对话不进仓库**(仓库是公开的):样本和报告都在 `<STATE_DIR>/eval/`;仓库里只有跑的代码和几条编出来的示例样本。

## 跑法

```bash
wechat-cc eval run [--only <id,…>] [--provider <id>] [--json]   # daemon 需在跑;读 <STATE_DIR>/eval/samples/*.json
wechat-cc eval diff [<runA> <runB>]                              # 缺省:最近两次;列出「上次过、这次不过」的
```

报告写 `<STATE_DIR>/eval/runs/<时间>/report.json` + `report.md`。退出码:0 全过 / 1 有样本不过 / 2 daemon 没在跑或跑不起来。
「回归」= 上一次过、这一次不过;第一次跑只出基线。

## 怎么做到「用的是生产那一套」

被测的那一下在 **daemon 里**跑(新路由 `POST /v1/eval/run`,admin + operator 令牌,同 `selftest/converse`),
因为生产的提示词、模型选择、便宜模型的挑法都只在 daemon 里装得齐。CLI 只负责读样本、调路由、判分、写报告。

| 样本类别 | daemon 里怎么跑 | 走的生产代码 |
|---|---|---|
| `reply` 回复 | 起一个一次性会话:`registry.get(p).provider.spawn`,`appendInstructions = buildInstructions(p, tier, chatId)`(**跟 session-manager 一样的那一份**,不是 selftest 的「自检对话」),只读档、不批权限;发样本里那句话;收齐事件后过 `buildTurnReply` + `splitBubbles` | 系统提示词、回复抽取、`<think>` 过滤(OpenAI 兼容家在适配器里)、分气泡 |
| `brief` 早报 | 同上起会话,tier = `JOB_PROFILE`;发 `buildBriefText({material: buildBriefMaterial(样本素材)})`;最后一段过 `parseSilence` + `attachAsks` | 早报信封、写法要求、NO_REPLY、候选拼接 |
| `reference` 指称 | `resolveTaskReference({...样本, judge: makeCheapJudge(registry.getCheapEval())})` | 指称顺序 + 裁判提示词 + 生产的便宜模型 |
| (判分) | `registry.getCheapEval()(评分提示词)` | 生产的便宜模型 |

**不发微信、不写对话库**:会话 chatId 用 `eval-<uuid>`(不能带 `/`:记忆那一层把 chatId 当目录名),不走 replyDelivery / speech;
跑完 close + 作废令牌 + 删掉组装提示词时建的空 `memory/eval-<uuid>/`。
`reply` 的 tier 跟样本走(`admin` / `trusted`),缺省 admin(主人的对话)。
提示词是给这个一次性 chatId 组装的 ⇒ 不带主人那条对话的人设 / 核心记忆:评测钉的是提示词和模型,主人的记忆变了不该算回归。权限一律不批:要动手的样本不在这一版范围里。
「只读档」具体是:**提示词**按样本的档位组装,**会话**按 `JOB_PROFILE` 起、strict、不给 `requestPermission` —— 它的 relay 是空的,
不在 allow 里的工具一律拒、不弹拍板卡(Claude 走 profileGate;Codex 是 read-only 沙箱、无应答者 ⇒ 审批拒);会话令牌按 guest 铸、
只放行 `GET /v1/health`(同 selftest),wechat MCP 里发消息 / 写记忆的工具够不着 daemon。模型按 `currentModelFor`(同 session-manager),样本可用 `input.model` 改。

## 样本格式

一条一个 JSON 文件(`<STATE_DIR>/eval/samples/<id>.json`),人能直接改:

```jsonc
{
  "id": "reply-short-greeting",
  "kind": "reply",                 // reply | brief | reference
  "note": "主人早上随口一句,应该一两句话回,别列清单",   // 为什么收这条
  "input": { "text": "早", "tier": "admin" },
  // brief:   "input": { "material": { BriefInputs }, "asks": [PickedAsk] }
  // reference: "input": { "text", "quotedText"?, "candidates": [...], "focus"? }
  "rules": [ … ],                  // 硬规则,见下
  "judge": "回复像熟人打招呼;不超过两句;不提自己是 AI"   // 可选:便宜模型按这句打 0/1
}
```

### 硬规则(代码判,不花钱)

`{ "noThink": true }`(最终文字里没有 `<think>` / `</think>` / 「思考过程」开头)、
`{ "maxChars": n }`、`{ "maxBubbles": n }`、`{ "contains": "…" }`、`{ "notContains": "…" }`、`{ "matches": "正则" }`、
`{ "silent": true | false }`(NO_REPLY 与否)、`{ "lastLine": "就这些。" }`、`{ "lines": [min, max] }`(早报条数)、
`{ "resolves": { "kind": "task", "taskId": "…" } }`(指称:kind 必比,taskId / via 写了才比)。

**所有 `reply` / `brief` 样本自动带 `noThink`**,不用每条写。

### 便宜模型打分

`judge` 写了才打。提示词固定:给样本的话、模型的回复、这条标准,只回 `1`(符合)或 `0`,单独一个数字才算数(同 `makeCheapJudge`),
别的回答记 `judge_unclear`,**不算过也不算不过**,报告里单列。每条打 1 次,不做多次投票 —— 便宜模型抖动靠「回归 = 上次过这次不过」
那一列让人去看原文,不靠平均。

## 样本从哪来

整合者从 `messages` 表挑(主人的对话,入站那句 + 当时的回复),按「回复交付 / `<think>` / 早报 / 指称」四类凑 20–30 条,
写 `note` 说为什么收。早报的素材取一天真的日报原文脱敏;指称的候选取当时的一起做列表。收进来之后**这批就是固定的**,
只有主人说「这条标准不对」才改 —— 不为了变绿改样本。

## 什么时候跑

改了 `src/domain/prompt-builder.ts`、`src/features/jobs/brief.ts` 的信封、`task-reference.ts` 的裁判提示词,换了默认模型 / 便宜模型
⇒ 合 dev 之前跑一次,PR 里贴 `eval diff` 的结果(有回归就写为什么可以接受)。先不做成守卫:跑一次要几分钟、要钱、要 bx。

## 进度

| 日期 | 做了什么 |
|---|---|
| 10-29 | 本稿 |
| 10-29 | 落地:纯规则 `src/domain/output-eval.ts`;daemon `src/features/output-eval/`(模块 `output-eval`,`POST /v1/eval/run`,`kind: reply / brief / reference / judge`;码 `eval_invalid_request` / `eval_unknown_provider` / `eval_no_cheap_model`);CLI `src/cli/output-eval.ts` + `wechat-cc eval run / diff`;示例样本 `eval/output/examples/`(复制到 `<STATE_DIR>/eval/samples/`);沙盒场景「输出评测」。与稿不同:chatId 用 `eval-<uuid>`(见上);judge 走同一条路由的 `kind: 'judge'` |
