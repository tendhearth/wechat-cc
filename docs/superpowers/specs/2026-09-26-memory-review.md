# 手机长期记忆纠正设计（A）

日期：2026-09-26（洛杉矶）。状态：方案已审阅，未实现。只读基线：`origin/dev`，`39cf7f5f`。配套：[实施计划](../plans/2026-09-26-memory-review.md)。

用户后续要求双方协作且互不影响；本任务已从origin/dev建立独立分支codex/cc-task-entry与专属工作区。产品改动仅在该处完成；共享dev、部署和运行数据由明确整合者处理，他人工作区不接管。

## 1. 用户结果与范围

普通用户在手机「此刻」点 CC，进入「CC 眼中的你」，逐条选择：

- **改正**：看到原句、编辑、预览后保存；正文即时更新，保留原编号与栏目。
- **标过时**：确认原句后，从活动长期记忆移出；保存“曾经成立、现在过时”的操作原因。
- **从长期记忆移除**：确认原句后移出，原因与过时区分。

后两项说明文案固定为：“这会移出 CC 的长期记忆；聊天记录和历史备份仍保留。”成功文案分别为“已改正”“已标过时”“已从长期记忆移除”。不做一键撤销、跨版本合并、主动搭话 C、访客记忆或全部历史删除。微信普通聊天纠正仍可进入白天草稿；本期确定性即时纠正入口是手机页面。

保存影响后续新建对话的记忆读取；已进入运行中上下文的内容不会倒退删除。`knowledge.md`、原笔记、聊天、既有画像、备份可能保留同一事实。本功能不是全局语义遗忘，也不宣称按意思删除所有历史。

## 2. 复用与新增边界

复用 `curated-doc.ts` 的五栏、隐藏 `m:<hex>`、Markdown 往返与 3000 字上限；复用桌面 source review 的修订冲突语义和 `memory-derived-state.ts` 失效保护。`memory.md` 仍是唯一活动长期记忆正文，不建立第二知识库。

现状必须补齐：`curatedView()` 没有 revision；`gatherMaterial()` 重读旧文件；手机 `api()` 可能在 LAN 超时后从隧道重发写请求；桌面 `memory.js` 调 CLI 直接落盘；最后一条移除后 `prompt-builder.ts` 会错误回退 profile。

新增三个实现单元（名称为本设计拟新增接口，不声称基线已经存在）：

| 文件 | 职责 |
| --- | --- |
| `src/daemon/memory/curated-commit.ts` | 文档与控制记录的统一同步 CAS、journal 恢复、回执 |
| `src/daemon/memory/curated-review.ts` | 主人逐条操作、桌面整文替换、约束状态与修订读取 |
| `src/daemon/memory/nightly-material.ts` | 来源标识、版本哈希、屏蔽、预算裁剪；不做语义判断 |

每个新增文件配同名 `.test.ts`。CLI 的薄适配另放 `src/cli/curated-memory.ts` 和测试，避免继续扩大 `cli.ts`。另新增 `src/daemon/memory/curated-prompt.ts` 和测试，隔离“文件不存在 / 存在但为空”的读取契约。

## 3. 接口与操作身份

`GET /m/api/memory` 保留已有字段，增加 `revision: string | null`，每条增加 `editable: boolean`。没有文件时 revision 为 null；存在空文件时返回有效 revision。无编号条目不可编辑并提示“这条还没有编号，下次整理后可改”；已有 nightly 补编号。重复编号整份文档拒绝写入，不能按文字、数组位置或最后一个匹配猜条目。

`POST /m/api/memory/review` 输入为 `{request_id, revision, id, action, text?}`。action 是 `correct | outdated | remove`；只有 correct 接受 text。成功返回 `{ok:true, request_id, revision}`，随后 GET 刷新。request_id 为 UUID，客户端一次保存尝试生成一次，传输重试复用。revision 是“owner 身份 + 文件存在性 + 原文 + 控制 epoch”的 SHA-256。

text 先 trim，拒空、CR/LF、HTML 注释标记（防伪造隐藏编号），最多 200 个 JS UTF-16 code units；全文沿用 `docChars()` ≤3000。正文里的期限沿用现有格式，不新增日期字段。无效请求 400；未知 id 404；修订冲突、重复 id、同 request_id 不同负载 409；未授权 401；依赖未接线/恢复冲突/容量耗尽 503。响应始终有 JSON 错误码，不把正文写进服务日志。

手机 owner 只由 daemon resolver 决定，不接受 chat_id、路径或完整文档。沿用 settings-panel 的短链接/设备 token 与同一个隧道路由，不增 internal-api 的 routeAllow，不把桌面来源编辑接口暴露给手机。

## 4. 控制记录、保留与双文件恢复

在 owner 记忆目录新增隐藏侧文件：

- `.memory-review-state.json`：`version:1`、单调换新的 epoch、protected 编号及当前文本哈希、退役编号/旧文本哈希、禁止再输入的 sourceKey/versionHash、请求回执。
- `.memory-review-journal.json`：唯一在途提交，包含 before 文档/控制哈希、after 文档正文、after 控制状态、两者校验和、event_id 和审计事件。它只为恢复暂存正文，成功后删除，不被素材收集、记忆检索或模型文件读取列出。

侧文件不是另一份活动记忆：protected 文本从 `memory.md` 取，控制文件仅保存哈希与身份；journal 中的 after 正文只活到提交完成。两侧文件用 0600、目录 0700；临时文件 wx 创建、同步落盘后 rename。路径固定，拒绝目录/文件符号链接越出 owner root。

**保留界限：**回执最多 1000 条且最多 7 天，按提交时间淘汰，二者取较早边界；不含正文，仅请求哈希、结果 revision、时间。回执淘汰后旧请求的旧 epoch 必须 409，不能被当新操作重放。材料版本与退役记录不自动按时间过期，只去重；分别最多 10000 个 source/version 对、10000 个退役 id 或文本哈希；状态序列化最多 4 MiB。超限在落 journal 前返回 `review_capacity`，不得静默删保护。后续保留期管理另设计，本期不提供“自动清除旧约束”。主人显式重引入时只解除对应编号/文本保护，不清空所有材料屏蔽。

**提交算法（整个提交段无 await）：**

1. 每次读写先恢复 journal；读取原文和状态，检查 request_id 回执，再校验 expected revision。服务在异步收集materials之前先用committer.replay检查已提交回执；相同请求哈希直接返回原结果，素材源暂时故障不阻止成功重放；负载不同返回409。最终commit仍再次查回执与修订，覆盖并发变化。
2. 算出 after 文档、after 状态、全新 epoch 与回执；校验编号、容量、owner 和文件沙箱。先使既有派生画像/概要失效；失效本身失败则不提交。
3. 原子写 journal。它的存在代表“这份经 CAS 批准的操作需完成”；任何写者必须先处理它。
4. 原子替换 `memory.md`，再原子替换控制文件；写入 `memory-log.jsonl` 审计事件（event_id 去重），最后删除 journal，才返回成功。

**恢复算法：**校验 journal 结构、after 内容哈希和 owner；当前文档哈希与控制哈希各自只能等于对应 before 或 after。四种组合均以 after 为目标补齐（含“文档新、控制旧”）。已为 after 的文件不重复改写；按 event_id 补审计，然后删除 journal。任一现值不是 before/after，返回 `review_recovery_conflict` 并保留文件，禁止覆盖外部编辑。损坏 journal、控制文件读取失败同样拒绝；不回退成空约束。日志若只有损坏的末尾半行，在同一提交门内仅裁掉该半行再补写；中部损坏拒绝，不凭空重建历史。

既有 nightly 同样用此提交门提交文档和控制 epoch；控制缺失且无 journal 才视为首次空状态。单 daemon 进程是本期并发边界。任意外部编辑器不在 CAS 保证内：检测到控制记录绑定的文档哈希不一致时，模型注入与普通写入拒绝；桌面诊断读取可返回当前原文、组合revision与requiresAdoption，供主人明确采用当前文件。不得悄悄认作主人批准，未知journal冲突不能靠普通采用解除。

## 5. 夜间整理与原素材版本屏蔽

素材在裁剪前保留 `{sourceKey, versionHash, text}`。文件键为相对路径；观察/里程碑/消息键为原记录 ID；本机导入键为项目与文件逻辑键，只在现有 opt-in 打开时读取。versionHash 对原始内容计算，不对预算裁剪结果计算。

每次主人操作先取得当前可见素材快照，成功提交时将其版本加入屏蔽集合。快照沿用现有查询时间范围和数量上限，不声称覆盖从未读入的全部历史。下次 nightly 排除相同 sourceKey/versionHash 后才做预算与指纹；指纹还包含 review epoch。屏蔽的是整份旧材料版本，可能暂缓其中尚未提炼的其他信息，这是本期避免猜来源的保守取舍。新记录、修改后的文件版本可以进入；不会因读不到某项素材而假装成功拍下完整快照。

程序强制：protected 的当前编号/正文不能被 nightly update/remove/expire 改动；其 seen 可确认。退休 ID 不再分配。新增/更新命中已移除或被改正旧文本的归一化哈希时拒绝整批。归一化固定为 NFKC、trim、连续空白折叠为一个空格，不移除标点、不分词。保护规则触发返回 skipped/review_protected，不增加连续失败次数；记录原因并允许后续 tick 重算，但当天相同 material+epoch+拒绝批次哈希不重复调模型。

模型提示解释“主人明确更正优先、protected 只能确认、被移除内容不要凭旧素材重新推测”。这些提示不能保证识别换说法的同一事实。硬保证仅为旧版本不再输入、旧编号不复活、已确认条目不覆盖和完全相同的归一化文本不重加。新来源换说法仍可能记入，明确属于模型能力边界。

在模型调用前快照文档 revision 和 review epoch；返回后提交门复核二者。手机保存无需等五分钟模型调用；更正先提交，迟到 nightly 整批丢弃。已有 tick/runNow 串行链保留。

主人保存不修改 lastRunIso。审计事件增加 `actor: owner|nightly`，老记录无 actor 视作 nightly；“昨晚”只选最近 nightly 记录。待发通知携带生成时 review epoch，投递前不匹配则丢弃，防止更正后发出旧文本；旧通知视作初始 epoch。

## 6. 桌面整文编辑与统一入口

`memory.js` 当前经 CLI 直接写文件，必须封住旁路。仅对根 `memory.md`：CLI read 走现有 GET `/v1/memory/source` 返回 content/revision；CLI write 新增 `--revision`、`--request-id` 并走 POST `/v1/memory/source/review`。桌面保存携带读取版本；409 保留草稿并允许重新读取、明确按最新内容继续。daemon 不可用时不可直接落盘兜底。其余笔记沿用原路径。

现有 source review 对 curated 文件转交同一服务；会话 token 继续拒改 curated，桌面原有 file 凭据/作用域不扩大。底层 `writeMemoryFile` 与通用 `/v1/memory/write` 对 curated 文件拒绝无 CAS 写入；同样封住通用 delete，移除长期记忆使用整文空文档提交。所有服务检查绑定 owner，不能以另一 chat 的 memory.md 绕过。

桌面整文替换是主人显式决定：同 ID 文本改变更新保护；删除 ID 设退役；新条目补新 ID 并保护；重复 ID 拒绝。同 ID 未改文字保留保护。主人主动重新加入退役 ID/相同正文，允许解除该目标的旧保护并以新提交为准；不猜文本相近就是同条。去掉编号相当于删旧加新。提交前展示整文预览和影响，绝不让 nightly 重新恢复手机旧保护。新版状态记录增加“采用外部文件”显式恢复模式：桌面在读到当前外部原文及控制 revision 后确认采用，仍 CAS 比较二者，生成新约束；普通保存不能隐式清除恢复冲突。

## 7. 空记忆、显示与验收

读取契约为 `string | null`：null 才表示没有 memory.md，可回退 profile；空字符串表示存在但没有活动条目，不回退。调整 main → bootstrap → prompt-builder 全链路，测试最后一条移除与空文件两种输入。knowledge 独立注入保持可见的范围说明，不借本期悄悄改掉整个知识系统。

手机草稿仅驻内存；加载结果不能覆盖编辑中的输入。401 保留屏内草稿并提示重新连接，400/409/离线均不显示成功。提交中禁止双击；请求结果未知时可GET刷新视图，但不能凭文本相同认定保存成功。只由原POST以同request_id和同负载重发得到服务端回执确认，不生成第二次操作。所有动态文本经 esc/textarea.value；保持现有 reduced-motion、眨眼懒加载与 512KB 传输边界。

验收映射：原子提交/崩溃恢复/幂等→任务1；版本屏蔽/迟到整理→任务2；桌面显式覆盖/旁路封堵→任务3；授权及隧道→任务4；手机草稿与预览→任务5；空记忆及真实闭环→任务6。所有验证使用临时 owner 数据。完整本地闸门和真实设备验收后才能称已实现。
