# 每晚整理记忆 + 看得见(B)设计

- 日期:2026-09-25
- 状态:owner 已逐节认可(对话),待审本文
- 来源:研究 Meta Muse(2026-09-08 上线,产品设计公开承认借鉴 OpenClaw)的 `MEMORY.md`:Facts / Preferences / Commitments、每晚整理、每次对话读、用户可改、改了会告诉你。

## 背景与问题

现状(2026-09-25 勘察):

- 每次对话注入的是 `profile.md`(CC 自己随手写,1500 字上限,`src/core/prompt-builder.ts:504`)和 `knowledge.md`(ingest tick 提炼,无 LLM,`:526`)。
- 「整理记忆」产出的 `_overview.md`(`src/lib/memory-synthesis.ts:451`)**不进普通对话**;它的 24h 自动整理挂在 `companion.import_local_history` 开关后面(`src/daemon/companion/tick-bodies.ts:907-915`),默认关 —— 本机 `_overview.md` 自 2026-08-24 起没再更新。
- 园丁(`src/daemon/memory/gardener.ts`)每天压缩大笔记,**静默**。
- 没有「几点」的定时任务(introspect 是开机起算 24h,会漂);手机和微信看不了、改不了记忆;没有分栏的长期记忆。

owner 要的是四件事,按 **B(看得见)→ A(准:逐条纠错)→ C(活:第二天说一句「我注意到…」)** 的顺序分三步做。**本文只设计 B。**

## 定案(owner 逐项拍板)

1. 整理后的那份就是 CC 的长期记忆,**每次对话都读**;`profile.md` 退回白天草稿,只当整理素材。
2. 只在**值得说的变化**时告诉主人;其余安静更新。
3. 五栏:**关于你 / 偏好 / 承诺 / 身边的人 / 近况**(近况两周没提就淡出)。
4. 实现走「**一份 `.md` + 每条隐藏编号 + 模型只报改动**」,不走 JSON 存储(守住「记忆保留 `.md` 自建」的旧定案,`docs/roadmap.md:70`)。

## 1. 文件与格式

路径:`<stateDir>/memory/<ownerChatId>/memory.md`。

```markdown
<!-- wechat-cc 记忆 · 每晚整理 · 最近整理 2026-09-25T04:00+08:00 · 编号是给整理用的,别删;删了也不会丢,只会被当成新条目 -->
## 关于你
- 全栈开发兼产品,在做 wechat-cc <!-- m:7f3a · 2026-08-24 -->
## 偏好
- 回复直接,别客套 <!-- m:91c2 · 2026-09-10 -->
## 承诺
- 周五前给 X 回话(期限 2026-09-27) <!-- m:b01e · 2026-09-24 -->
## 身边的人
- …
## 近况
- 这周在赶手机页发版 <!-- m:4d7c · 2026-09-24 -->
```

- 每条一行列表项;尾注 `<!-- m:<id> · <最后确认日期> -->`。id 为 4 位以上小写 hex,文件内唯一。
- 承诺期限写在正文 `(期限 YYYY-MM-DD)`,程序按此解析。
- 栏标题固定为上述五个;未知栏、栏外文字在解析时保留原样(不丢主人手写内容)。
- 总长上限 3000 字(不含尾注)。

**写入权**

- 每晚整理任务:主要写入方。
- 主人:桌面记忆面板直接编辑(现有能力,`apps/desktop/src/modules/memory.js`)。
- CC 白天:MCP `memory_write` / `memory_delete` 对 `memory.md` 拒绝,回提示「记到 profile.md 或 notes/,今晚会整理进去」(`src/mcp-servers/wechat/tools-memory.ts`,在 daemon 侧路由 `src/daemon/internal-api/routes.ts:211-256` 拦,MCP 端只透传)。
- 无编号条目(主人手写 / 其它途径漏进来):解析时照常读入,整理时补编号。

**进对话**

- `buildSystemPrompt` 的核心记忆段(`prompt-builder.ts:504` 附近)改注入 `memory.md` 正文(去尾注)。`memory.md` 不存在时回退注入 `profile.md`(旧行为),保证升级第一晚之前不空。
- `profile.md` 不再每轮注入。
- `knowledge.md` 照旧注入(本步不动;等 `承诺` / `身边的人` 稳定后另议撤掉)。

**旧 `_overview.md`**:第一次整理时作为素材读入,之后不再更新;微信「查看记忆」改读 `memory.md`。旧文件保留不删。

## 2. 每晚整理

**调度**(新模块,`src/daemon/memory/nightly.ts` + 在 `bootstrap/wire-*.ts` 接线,守 bootstrap 拆分约定)

- 每 15 分钟检查一次 `due(now)`:按 companion 时区(`companion/config.ts:66`)算「今天 04:00」,已过且今天(同时区日期)尚未成功整理 → 跑。睡眠 / 重启 / 断电后自然补上,无需单独补跑逻辑。
- 主人会话正忙(有在途轮次或 3 分钟内有入站)→ 本次跳过,15 分钟后再看。
- 运行期 `holdBusy('memory-nightly')`。
- 状态(最近成功日期、最近指纹、连续失败次数)存 `<stateDir>/companion/memory-nightly.json`。

**素材**(只取上次成功整理之后新增 / 变动的)

- `profile.md`、变动过的 `notes/*.md`、`agenda.md`、`knowledge.md`
- 期间的 observations / milestones、每日聊天摘要(与手机 feed 同源的 turn_records 日摘要)
- 本机 Claude 记忆:仅当 `import_local_history` 开
- 第一次:`_overview.md`
- 全部素材算指纹;与上次相同 → 跳过,不调模型。

**模型与改动清单**

- 模型:`memoryLlmOps` 同一 cheapEval 选择(`src/lib/memory-llm-ops.ts:33-47`,尊重 `cheap_eval_provider`)。
- 输入:当前 `memory.md`(带编号)+ 素材 + 今天日期 + 五栏定义 + 3000 字上限。
- 输出(JSON):
  - `add: [{ section, text, due? }]`
  - `update: [{ id, text, due?, reversal: boolean }]` —— `reversal` 标「推翻原意」vs「改措辞」
  - `confirm: [id]` —— 仍然成立,刷新最后确认日期
  - `remove: [{ id, reason }]`

**校验(程序,不信模型)**

- id 必须存在;section 必须是五栏之一;单条 ≤ 200 字;`due` 为合法日期。
- 一晚 `remove` 超过现有条目 30% → 整批作废。
- 输出不是合法 JSON / 字段不全 → 整批作废。

**到期新陈代谢(程序)**

- 承诺:期限已过 7 天以上 → 移入归档。
- 近况:最后确认日期超过 14 天 → 移入归档。
- 归档:`memory/<ownerChatId>/memory-archive.md`,按日期追加,不进对话。

**超长**:应用改动后超 3000 字 → 先按最后确认日期淡出最旧的近况;仍超 → 整批作废,保留昨天版本。

**写入**

- 调模型前记下 `memory.md` 的修订(内容哈希);写入前复核,变了(主人正在改)→ 本次作废,15 分钟后重跑。
- 写前把旧版存入现有记忆备份目录;原子写。
- 本次实际应用的改动(含到期归档)追加到 `memory/<ownerChatId>/memory-log.jsonl`:`{ at, ops: [{ kind, id, section, text, before?, reversal?, reason? }] }`。第 3 节与步骤 A 都读它。

**出错**:模型失败 / 超时 / 被作废 → 今天不再试(明天再来),`failures += 1`;连续 3 天失败 → 日志告警 + 「查看记忆」顶部提示。不在同一天内重试。

`整理记忆` 管理命令(`admin-commands.ts:171`)与 `POST /v1/memory/synthesize` 改为立即跑本流程(忽略 due,仍走指纹 / 校验 / 修订检查)。新增 CLI `wechat-cc memory nightly --now`。

## 3. 告诉主人

**值得说**(程序读当晚 `memory-log.jsonl` 判断):

- `add` 进「承诺」;
- `update` 且 `reversal: true`,且栏为「偏好」或「关于你」;
- 模型发起的 `remove`(到期归档 / 近况淡出不算);
- 第一次成功整理:单独一条介绍「我把对你的理解整理成了一份记忆,发『查看记忆』就能看」。

**发送时机**:整理结果先入待发;在主人时区 09:00 之后的下一次 push tick 发出。遵守 care 规则(`companion/care-ledger.ts`、`calibration.ts:31-43`):care=off 不发;连续两次未回复暂停;新 kind `memory`,约 20h 一条。外发通道不健康(`ilink/outbound-health.ts`)→ 保留待发,恢复后 24h 内补发,超时作废;不重试轰炸。

**内容**:程序拼装,直接 `ilink.sendMessage`,不走 AI 轮次;最多列 3 条,多出的「还有 N 条,发『查看记忆』看全部」;不放链接(设置页令牌 10 分钟过期,聊天里只会留下死链接)。

> 昨晚整理记忆,有几件想跟你对一下:
> · 新记下:周五前给 X 回话
> · 改了:你现在更想先上线再优化(原来是先打磨再上线)
> · 删了:在准备搬家(你之后没再提)
> 不对的话直接跟我说。

主人回「不对」:步骤 A 之前,由 CC 在普通对话里把纠正记进 `profile.md` / `notes/`,当晚整理修正。

## 4. 在哪看

- **微信**:「查看记忆」(`admin-commands.ts:175`)回 `memory.md` 正文(去尾注),首行「最近整理:… · 改了 N 处」;连续失败时首行换成失败提示。
- **手机 `/m`**:「回忆」页新增只读折叠区「CC 记得你」(`apps/mobile/src/phone.html` 与 `home.js`),五栏展示;当晚改过的条目标小点;承诺显示期限。新接口 `GET /m/api/memory`(令牌校验同其它 `/m/api/*`,隧道可用),返回 `{ ok, updated_at, sections: [{ name, items: [{ id, text, due?, changed }] }] }`。
- **桌面**:不改界面;现有记忆面板自动列出 `memory.md`,可编辑。

## 5. 上线与验证

- 配置:`memory.nightly.enabled`(默认 true)、`memory.nightly.at`(默认 `"04:00"`)。
- 测试(TDD):
  - Markdown 解析 / 写回往返:手写内容、无编号条目、未知栏不丢
  - 改动清单校验:非法 id / 栏、超长单条、删除超 30% 整批作废、非法 JSON
  - 到期新陈代谢:承诺过期 7 天、近况 14 天
  - 超长处理
  - 「值得说」判定规则
  - `due()`:时区、跨日、睡眠后补跑、当天已跑不重复、会话忙推迟
  - 修订冲突:整理期间主人改了文件 → 作废
  - 提示词:有 `memory.md` 注入它、没有回退 `profile.md`
  - `memory_write` / `memory_delete` 拒写 `memory.md`
  - `/m/api/memory` 与「查看记忆」输出
- 真机验收:先 `wechat-cc memory nightly --now` 手动跑一次,把改动清单与生成的 `memory.md` 给 owner 过目,再放开每晚自动跑;第一晚后核对早上那条消息。

## 不做(本步)

- 逐条「不对 / 过时 / 删掉」按钮(步骤 A)。
- 「我注意到…」主动搭话(步骤 C)。
- 撤掉 `knowledge.md` 注入、删除 `_overview.md` / `_profile.json`。
- 桌面新界面、手机端编辑。
- 非 owner 聊天(访客 / 群)的长期记忆 —— 本步只做 owner。
