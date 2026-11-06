# S4：全局预算，统一挑选（设计稿）

2026-11-06 · 实现进行中：S4a 先接送达事实与影子预算，S4b / S4c 尚未完成。

主人 11-06 决定（整合者转达）：A 已批准，全局最小间隔 20 小时；B 已批准，未知交付暂占一个间隔；C 已批准，扩展 fallback 排序；D 不做，纯出门动作不受开口间隔限制。信 / 早报计入 noReplyCount 不在本次范围。

源码核对：源码核对基线：`s4-design`，`9a150ed0d23a2f950ad49409f29f6c044ef42a95`。下文 `src/` 路径均相对仓库根目录，行号以此提交为准。

CC 刚寄完信、刚发过早报，就不必再另找由头问候。各功能判断自己有没有值得提的事；在场层决定这次说哪一件、什么时候说。主人交代的提醒、等主人批准的卡和做事回报不能被这个挑选器吞掉。

## 依据与边界

承接[骨架稿](2026-10-31-one-companion-one-skeleton-design.md) §4 S4、§5「寄信、早报也算主动开口，问候会相应少一点」（主人：照建议），以及 §8.7–8：

- 预算只管 `initiative`；早报、周报按点发、不等预算，但计入预算；各类别自己的间隔保留。
- 功能定时器保留，只产提议。在场层收到提议以及每 20 分钟一拍时判定；普通 initiative 落选即结束本次提议，下次由来源再提。report / blocking 不参加竞选。
- [S1](2026-10-31-one-companion-one-skeleton-design.md) 已把日程、问候、打猎接入 SpeechPolicy；[S2](2026-11-04-s2-one-pending-queue-design.md) 已统一退避和 `speech_pending`，贴纸保留 6 小时、见闻 24 小时且一次最多一条，是已批准的可靠性交付例外。
- [S3](2026-11-05-s3-one-proposal-design.md) 已有 S3a、S3b；S3b-2 与 S3c 尚有未落地部分。S4 不假定完整升级梯子已存在，不顺带批准 S3 的 A–D 选项。
- S4 在 [M5](2026-11-04-m5-cc-acts-design.md) 之后。M5a–c 与 M5d 已有进度；act 表示做事，不等于已经开口。问候不建 act。M5d 明确保留的打猎出门前登记、早报共用状态、问候 activity 记录不能借 S4 顺手删掉。

本稿的接口、事务与拆分是实现建议；涉及新增可见规则的地方标 **待主人点头**，不能把设计提交当作这些规则已获批准。

## 今天是谁先开口

这里的「先开口」包括系统异步回话，不等于全都归 initiative。分类唯一来源是 `domain/speech/kinds.ts:24` 的 `SPEECH_KINDS`，调用者不能传 origin、优先级或豁免。

| 发起方与源码入口 | 今天怎么决定 | SpeechPolicy 路径与 S4 去向 |
|---|---|---|
| agenda 关心：`features/companion/tick-push.ts:66–99` | 取最早到期的自写 agenda；`calibration.ts:105` 用 20 小时冷却；优先于后面的三个候选 | 已过：`tick-dispatch.ts:121` say(companion)。改为 agenda 提议，不再抢先执行 |
| 安静后的问候：`features/companion/gap-action.ts:16`；`tick-push.ts:103–211` | low 7 天 / high 2 天；看最近入站和主动时间；两次没回暂停；便宜模型只在 hunt / visit / gap 中挑 | 已过：同 dispatch say(companion)。改为 gap 提议 |
| 打猎：`features/hunt/action.ts:26` | 仅主人、默认关、显式开启；20 小时与两次没回限制；被选中才出门，先登记 | 已过：同 dispatch say(companion)，M5 act 事后记录。提议归 hunt act，保留出门登记语义 |
| 伙伴串门：`daemon/wiring/companion-actions.ts:25` | 主人、社交接好、visit 未关；20 小时、两次没回；同一个旧 picker，先登记再出门 | 出门本身不经 say，是对端动作而非给主人开口；回来那一句走 social_story。移除独立 picker 后仍可提交动作提议，但出门不能虚记一次给主人说话 |
| 人类访客走后讲一句：`features/companion/tick-push.ts:274–322` | 访客离开 30 分钟，按 narrated 水位去重，care off 时视作看过；放行后才调模型 | 已过 say(guest_visit)。改成带访客会话水位的提议，落选不前移水位 |
| 自发寄信与断点续寄：`features/letters/runtime.ts:358–406`；`letters/wire.ts:119` | 15 分钟检查；随机 dueAt、晚间窗口、素材与 pending；既有信间隔保留 | 已过 say(letter)，但多页投递内部直接用 sendFile / sendText（`:295–297`）。改为提议 + 授权后的投递适配器；一封多页只占一次 |
| 主人当面要信：`features/letters/runtime.ts:419–437` | 主人明确要求，或续寄 requested 信 | 已过 say(letter_asked)，requested，立即走门，不竞选、不占主动预算 |
| 早报：`features/jobs/brief.ts:149`；周报：`features/jobs/recap.ts:81` | jobs runner 每 60 秒；到点 10 分钟窗口、每日上限、busy / failStreak / NO_REPLY；runner `:60–88` | 已过 `companion/tick-job.ts:49` say(brief / recap, scheduled)。提交定点提议，按点执行、不等预算，但实际开口计入预算 |
| 普通定时任务与点名审阅：`features/jobs/wire.ts:97,173–182` | 主人指定内容和时间；定时上限、错过窗口、连续失败暂停；审阅点名即触发 | 已过 tick-job say(job / review)，暂停和错过走 module.ts:36 tell(job_notice / review_missed)。requested / report，不竞选 |
| 记忆整理后的通知：`features/memory/nightly-runtime.ts:84–117,396,438` | 整理本身按 nightly 节奏；只在首轮或有需核对变化时留 pendingNotice；通知窗口 / 过期、20 小时与未回复门 | 已过 say(memory_notice, perKind)。整理继续独立，通知提交提议，引用已有 actTurn，不把整理完成当开口 |
| 新贴纸：`features/stickers/artist.ts:145–184`；`artist-step.ts:33–45,73` | introspect 步骤，按每日 / 每周阶段画好后通知；画画尝试与开口两件事 | 已过 say(sticker)，推后 keep 6 小时。画作留库，通知及补发都进统一挑选 |
| 社交见闻 / 明信片：`features/social/social-tell.ts:33–35`；`wire-social.ts:257–283` | 串门、邻居或明信片事件回调；文字 tell、图片 say；推后 24 小时，一次最多一条 | 已过 tell / say(social_story)。文本与附件作为一个提议；补发同样参与挑选 |
| 社交申请、结果、笔友来信：`features/social/wire-social.ts:222–257,308,341` | 心愿、介绍、信箱事件通过 notifyOwner 标注 social_ask / result / mail | 已过 social-tell → tell；blocking / report，不竞选。不能因其中有社交二字就全归主动预算 |
| 提醒：`features/reminders/sweeper.ts:183–220` | 每 60 秒扫到期提醒，原表 claim、退避与放弃窗口 | 已过 say(reminder)，requested。不改时间、不占预算；只把发送责任交在场层 |
| 工作台完成 / 失败 / 权限 / 提问：`features/phone/phone-notifier.ts:39–134`；`features/workbench/wire-notifications.ts:26–95`；`features/reports/sweeper.ts:171–182` | 状态变化、持久 notices、原对话 report outbox；S3 事件 ref 合账，人在电脑前可先桌面 | 已过 ask / say(permission_ask / matter_report)；`daemon/speech/matter-proposals.ts:57–65` 处理桌面一级。桌面自轮询通知 `apps/desktop/src/modules/workbench-attention.js:93–130` 仍有不过门的旧路径，归 S3c，S4 不宣称已清零 |
| 终端会话 / 放行规则：`features/terminal/wire.ts:104–122,161,194,271–276`；`app/cli-events.ts:246–292` | hub 合批、键鼠在场、过期拍板码、会话状态；人在桌前发桌面，否则微信与 App | 微信已过 tell(cli_session / rules_notice)，App 经 push-gate；桌面 notifyDesktop 不过 SpeechPolicy。沿用 S3 的边界，不借预算改为升级通知 |
| 自改拍板与进展：`daemon/self-change-glue.ts:88,119` | 自改状态机，卡有期限 | 已过 tell(self_change_progress) / say(self_change_ask)，report / blocking，不能竞选 |
| 访客申请：`daemon/inbound/guest-notify.ts:22`；A2A 捎话：`daemon/bootstrap/wire-a2a-server.ts:58` | 权限申请或对端事件 | 已过 tell(guest_request / a2a_notify)，blocking / report |
| 配对结果：`daemon/bootstrap/wire-pairing.ts:55–73` | 主人发起配对后，成功 / 过期等异步结果 | 已过 makeTellOwnerAs(pairing) → social-tell → tell，requested，不竞选 |
| 开机异常、重启、旧卡作废、升级：`daemon/runtime/boot-report.ts:33`；`daemon/startup-sweeps.ts:88`；`daemon/pending-cards.ts:116`；`daemon/cli-upgrade/module.ts:43` | 开机检查、重启恢复、升级结果 | 已过 tell(boot_notice / restart_notice / restart_voided_cards / upgrade_notice)，report |

补充边界：画室 `features/atelier/tick.ts:33–116` 只创作、存档和记录 act，没有主动给主人发图；`features/atelier/routes.ts` 的分享是主人点击。`outbound_health` 在 `domain/speech/kinds.ts:35` 有登记，但当前源码未检出生产调用，不能把登记当作已经运行的发起方；未来接线仍须按 report 过门。普通对话、命令回复、主人点击发表情 / 分享 / 广播属于应答，不改为主动提议。发送原语与例外清单见 `scripts/speech-send.guard.test.ts:24–100`；该守卫目前证明的是入口数量和部分授权形状，不能证明“所有入口都参与同一个 picker”。

## 一个预算：账是事实，预留解决并发

### 事实怎么取

预算按接收人归一：主人的微信 chat 和 App 都映射到同一个 owner 接收键，跨通道共享；别的显式开启 care 的对话各自独立，不能用访客的一句话替主人耗预算。查询不按 kind 拆账，不按微信 / App 拆账。

`speech_log` 新增独立的 `spoken_at`（可空），含义是这次提议第一次有外发成功证据的时间。`lastInitiativeAt = MAX(spoken_at)`，条件为该接收人且 `origin = initiative`。不能用 `at`：S3 同 ref 会更新 at、追加通道；也不能直接用 outcome=allowed：`daemon/speech/policy.ts:213–260` 的 ask 放行即记 allowed，say 的生产者正常返回也可能什么都没发，文件头和接口已明确区分门与送达。

- 文字、附件、多页信、App 存入对话等由各投递适配器回结构化 receipt。第一次确认交付就写 spoken_at，后续页、同 ref 重试、通道追加不前移；一封信只是一笔。
- NO_REPLY、网络守护拒绝、选中后会话忙、defer、drop、过期、明确的全失败，不写 spoken_at；有一页已成功而后页失败仍算开过口。App 推送的门放行或 fanout 到 0 台不算成功。
- `ref` 对每次逻辑提议稳定，沿用 S3 同事件一行；不能拿整个长期 act 的 matterId 当 ref。周期任务用 jobId + 本地计划日期 / 时刻，信用 letterId，记忆通知用 actTurn，贴纸用作品 id；问候用本次生成的提议 id，来源重试复用它。
- 历史 allowed 行缺少送达证据，不能伪造成功。S4a 将能从已归档信的 delivery 步 / 明确消息引用证明的记录关联回填；其余标为 legacy_unknown，保留原账。切换前影子比较覆盖最长现有 gap 窗口（7 天），再删旧字段；不为补齐历史读取生产私人库。

### 预算规则及尚未批准的数值

保留每种自己的资格门：信的随机节奏、gap 的 7 / 2 天、打猎 / 串门 / 记忆的 20 小时与未回复暂停。gap 和 agenda 原来读 lastProactiveAtIso 的地方改读 lastInitiativeAt，所有 initiative（含早报 / 周报）都能把它们往后挪。

骨架稿只定“至少隔多久”，没有定全局间隔数值。**主人 11-06 已批准 A：全局最小间隔 20 小时**，沿用现有主动关心中常见的间隔；不是每天自然日发一次，不补攒余额，不另加每日条数。这个值会明显减少打猎、记忆、贴纸与信在同一天分别出现的机会，不能当成已批准参数。A 未定时可做 S4a 与接口搬迁，不启用新节流值、不宣称 S4 全部完成。

早报 / 周报的 scheduled 豁免由 kinds 的中央规则决定，只免全局等待，不免 care off、免打扰、可达性、10 分钟窗口等原门。它们仍经过同一个调度器，按点执行，不交模型否决。即使刚寄过信，到点早报也照旧尝试；成功后新的 lastInitiativeAt 使普通候选继续等待。requested / report / blocking 完全不读、不消费此预算。

### 在发送前占住位置

每个接收人只有一个串行调度循环；选中后在 SQLite 事务中重读预算并建立持久 reservation（扩展 speech_pending 的结构化 payload / 状态，具体迁移编号由实现时分配）。预算读取、同 ref 去重、占位必须原子化，不能仅用内存布尔或先查后写。占位不是开口事实，不更新 spoken_at。

定点提议不被普通预算挡住，但与正在执行的发送串行；普通执行前重判时必须看定点已成功的事实。模型生成不持数据库事务；选择过期、配置改变、入站到来、通道掉线均在执行前重判。

明确未发则释放占位；守护拒绝也释放，不记“做过”、不推进来源水位。崩溃后的 sending / 结果未知不自动重发，先凭 receipt / 幂等投递 id 恢复；无法确认则保留 unknown 并按原来源的至多一次契约收尾，不能把超时租约直接当作可再发。**主人 11-06 已批准 B：未知交付暂按占用一个全局间隔处理**，但另记 reservation 状态而不伪造 spoken_at；这可能少说一次。已知失败则继续沿用 S2 共用退避，不能在同一拍轮流执行剩余候选直到有一条成功。

## 提议形状与归属

示意接口（不是本次代码改动）：

```ts
type SpeechProposal = {
  id: string                 // 本次提议；来源重提同一件待送内容时稳定
  ref: string                // 同事件账键，跨通道和补发稳定
  kind: SpeechKind           // origin、scheduled 豁免、保留期由中央表推
  recipient: string
  source: string             // 登记表验证，不作为调用者自选的权限
  matterId?: string          // M5 act / S3 matter；问候可无 act
  turnId?: string
  createdAt: number
  notBefore: number
  expiresAt?: number         // 不能每次重提就续命
  summary: string            // 有界、供挑选；正文仍在原存档
  payloadRef: object         // 来源 id / 版本、附件引用，不序列化闭包
}
// 内存适配器：validate(proposal)、produce(proposal, authorizedOutbound)
// 返回 receipt / silent / blocked / failed；不能自己获取 ilink 或新开 say。
```

各定时器只收集资格和提交 proposal，不调挑选模型、不自行 claim“已做”、不发消息。制作和宣布拆开：记忆整理、画画可按原节奏完成，只有“告诉主人”竞选；信等原来门后才生成的仍在选中后生成，避免落选也花生成费用。M5 轮继续记真实执行，提议不是一轮；不凭空把社交每个动作都建成新 act。

一次调度取“此刻已经到达”的全部合格提议快照；同一事件合并，来源最多交一个当前候选，普通提议不为等下一轮定时器而延迟。调度期间到达的新提议进下一轮，执行前仍需预算复查。因此“统一挑选”不是承诺能预知一分钟后才到来的候选。

普通落选 / none 的提议从本轮移除，不更改来源到期状态，不标已寄 / 已通知。定时器到下次时可再提。S2 已保留的贴纸 / 见闻 payload 仍在 speech_pending 到原过期时间；落选结束的是本次投票，不是删除获批保留的内容。flushPending 遇 initiative 只能重新提交，不能直接 say 绕开 picker。未选中、预算等待是 defer，不算网络失败，不增加退避次数；到期仍记 expired，见闻每次最多最新一条的规则保留。

## 一个挑选器：先门，再便宜模型，再约束

1. 收到提议或 20 分钟兜底一拍，加载来源快照。requested / blocking / report 交既有 SpeechPolicy / S3 路径，立即按自己的规则处理，不等待模型。
2. 定点早报 / 周报走上述豁免路径；普通 initiative 先过 care、免打扰、到期 / 过期、来源资格、未回复限制、预算、reservation、通道和会话可执行性。所有昂贵的上下文构造和便宜模型调用都在这些门之后。纯出门 visit 使用对端链路资格，不能因主人微信断线一概拒掉；不消耗“给主人开口”的预算。
3. 无候选不问模型；普通候选交 registry.getCheapEval，同一个 prompt 能看见 agenda / gap / hunt / visit、信、记忆、贴纸、见闻、来访等全部当下候选。早报 / 周报及其他已发生开口作为上下文，而非可被否决的定点候选。沿用现有有界观察、persona、背包未读、最近入站、选择历史；仅给摘要与 id，来源文本是数据，不是指令。
4. 输出仅 `{id: 候选id | null, why, target?}`；null 即 none。严格解析，候选 id、版本、target 必须来自快照，模型不能新造动作、改 kind、改预算或选多个。constrainPlan 的“只能少做”保留；候选外降为 none。执行前重新判门、原子占位；失效不临时换另一个执行。
5. 复用 20 秒超时、模型 none / 降级后的 90 分钟再问间隔。只约束普通竞选，不挡定点任务和 requested / blocking / report。保留到下次再问所需的 plan-log，不能因删除 lastProactiveAtIso 一起删它。
6. 无模型、超时、解析错误、普通模型错误：走一次确定性 fallback，同样先过门；网络守护拒绝单独处理，整拍跳过，不 fallback、不记做过、不前移时间戳。断线或 cooldown 时不得每次触发都调模型。

**主人 11-06 已批准 C：扩展后的 fallback 排序**按最早 expiresAt，再按 createdAt、id 稳定排序；没有期限排最后，最多选一条。原来固定 hunt → visit → gap 只覆盖三类，扩展后排序会改变无模型时的体验。C 未点头时保留三类原排序，新种类无模型则不自动选；信等仍保有来源状态，S2 保留内容到期按既有规则处理。不得把“没有模型”解释成全部逐条发。

visit 目前混在旧 picker，却不是给主人讲话：S4b 仍让同一调度器处理其动作选择，实际 social_story 返回时另交开口提议。是否让纯出门动作也被 20 小时全局开口间隔拦住属于额外减少出门，**主人 11-06 决定 D 不做**；保留既有动作节奏及未回复门。

## S4a / S4b / S4c

| 步 | 改什么、删什么 | 交付与闸门 |
|---|---|---|
| S4a：账能回答“上次说过” | 为 speech_log 加 spoken_at 与查询索引，接各投递 receipt、稳定 ref、接收人归一与预算只读查询；影子计算，不节流。保留旧 lastProactiveAtIso 作为比较，不再新增来源私账 | 迁移、S3 ref 合账、首次交付时间不变、多页 / 部分失败 / NO_REPLY / 0 设备测试。旧数据证据不足明确 unknown；影子覆盖 7 天后再切读，不拿 allowed 猜送达 |
| S4b：来源只提议，一个调度 | 依次迁 companion 三类 + agenda / 来访、信、定点早周报、记忆、社交、贴纸与 S2 补发；其余异步通知提供非竞选 submit 适配。picker 搬到 speech，在场层唯一拥有外发授权；接持久 reservation。每迁一类删其自行 say / tell / send 权限与旧 picker 分支，保留来源业务数据 | 先接口搬迁保持行为；统一竞选的行为切换遵守已批范围，启用跨来源间隔须 A，fallback 新排序须 C，未知交付策略须 B。每类证明未选中不运行 produce，选择与发送并发不超发。S3 与 reminders 原有持久语义不改 |
| S4c：切读与退休 | gap / agenda / prompt 统一读 speech_log；删 lastProactiveAtIso 类型、读写、claim 分支及旧三选一 picker。旧 care 文件只忽略该字段，保留 noReplyCount、lastHunt / Visit / Memory 与定向撤回；不重写他人状态目录 | 守卫对 retired 字段和第二个主动 picker 零基线；主动来源外发原语零绕行，允许应答和受授权适配器；完整沙盒与受影响验证通过，再交整合者部署观察 |

“一功能一提议”不是把 reminders / report outbox 全搬表。它们的 claim、状态和业务重试仍由原持久层负责，调度层只接交付合同，防止双份队列都负责重试。同样，S3 尚存的桌面和终端例外列入守卫的具名边界，不以扩大 S4 范围偷偷改变免打扰或升级行为。

源码层最终界线：主动来源能提交数据、读回结果；只有在场层授权后调用的投递适配器能拿 ProactiveTurn。信的续页、社交图片、工作台严格 client_id 发送可作为适配器保留，不能有定时器直接调用其发送方法。现有 speech-send 数量守卫之外增加来源依赖守卫和运行时授权测试，不能只把旧直发改名 submit 就算完成。

## 验收与主人看得见的变化

已批准：寄出自发信、发过早报或周报后，问候会少一点；所有普通主动念头一起挑，一次最多选一个；没有合适的就安静。主人点名要的信、提醒、定时任务、批准卡、工作回报维持各自交付规则。S2 的推后补发和过期规则保留；S3 的在场通知继续按它自身的进度实施。

待主人点头的可见新增只有：A（建议至少隔 20 小时，影响所有普通 initiative）、B（崩溃后未知交付暂占间隔，宁少一次）、C（无模型时扩展排序）。D 是是否连出门也受开口间隔限制，建议不做。不新增“统一日额度”设置、不合并不同话题正文、不把当面要的信算作主动，不更改两次未回复暂停的覆盖范围；把信 / 早报也计入 noReplyCount、自动暂停更多类别是另一项产品变化，**待主人点头，S4 不做**。

实现时必须用隔离假时钟、假模型、假通道验证：

- 刚寄信 → gap 延后；早报在已耗预算时仍按点尝试，成功再延后普通提议；requested / blocking / report 从不被竞选挡住。
- 信、记忆、贴纸同拍到达，模型看见所有合格候选，只调用一个 produce；空候选、免打扰、care off、不可达、预算不足均零模型调用；非法 id 只能 none。
- 无模型 / 超时按获批 fallback 一次；守护拒绝不 fallback。模型 none 不在每个来源下一拍重新烧钱，定点早报仍能按点跑。
- 两个来源并发及重启恢复只占一个普通名额；send 后记账前崩溃结果未知不自动重复；部分页成功算一次；NO_REPLY 和明确失败不算说过。
- S2 贴纸 / 见闻补发也参与竞选，6 / 24 小时不被重提续命，落选不抹掉保留内容，到期有账；S3 同 ref 追加通道不前移 spoken_at。
- M5 的 act 开轮 / 收轮、信存档、记忆整理结果、问候 activity、打猎出门前 claim 与 noReply 定向撤回均保留，不能用“统一预算”掩盖执行幂等退化。

本稿验证仅需检查来源、链接、差异与规则一致性，无需构建或操作真实 daemon。后续实现按仓库 verify 跑受影响检查；重型、UI 与真实形状沙盒放专用 Mac mini 的隔离离线工作区，不启动真实 CC、不调真实模型 / 微信。部署、soak 与推送仅由整合者另行串行执行。
