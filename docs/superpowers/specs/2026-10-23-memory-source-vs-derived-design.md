# 记忆:哪些是源,哪些是生成物(第三批 3e)设计稿

> 2026-10-23 · 审查者起草,待整合者审。上位:`docs/architecture-review-2026-10-21.md` §3e「记忆定『源』:库和 memory.md 是源,其余标生成物」。

## 1. 盘点(读代码核过)

`<stateDir>/memory/<chatId>/` 底下十几样东西,外加库里的 `observations` / `milestones` / `events`。按「能不能从别的东西重新算出来」分:

| 类 | 有哪些 | 谁写 |
|---|---|---|
| **源**(丢了就没了) | `memory.md`(每轮都注入的那份)、`profile.md`(CC 自己的笔记)、`corrections.md`(主人的纠正)、`preferences.md` / `notes/` / `persona.md` / `agenda.md`、库里三张表 | nightly、主人(纠正 / 桌面编辑)、CC(MCP memory_write)、gardener |
| **生成物**(能重算) | `_overview.md`、`_profile.json`、`portrait.svg/json`、`knowledge.md` | 各自的合成任务 |
| **队列**(中间态,消费即删) | `today-draft.md` | daemon(profile.md 每次写的差异)/ nightly 读完删 |
| **账**(只追加、不重算) | `memory-log.jsonl`、`memory-sources.json`、`memory-archive/`、墓碑 `*.deleted-*`、gardener 快照 | 各写者 |

## 2. 问题(都核过)

1. **生成物几乎从不过期。** 「过期」只有一个标记(`.derived-state.json` 的 revision),全仓**只有一处**调 `invalidateDerivedMemory`:证据审阅里的「纠正 / 过期」(`routes-memory-review.ts:142`)。nightly 改了 `memory.md`、CC 写了 `profile.md`、主人在桌面编辑、gardener 压缩……都不让 `_overview.md` / `_profile.json` / 画像过期。于是串门时拿去当人设的 `_overview.md` 可以和每轮注入的 `memory.md` 说的不是一回事。
2. **主人能手改生成物,下次合成悄悄覆盖。** 桌面记忆编辑器走 CLI `memory write`,对任何 `.md` 都不设防,包括 `_overview.md`;下一次合成(含 24 小时自动的那次)直接覆盖,不提醒。证据审阅那条路倒是拒改 `_overview.md` —— 两条路说法不一。
3. **合成的输入里混进了生成物和队列。** 合成只排除了 `_overview.md` 自己;`today-draft.md`、`.json` 这些(推断,未逐条核)也流进去,生成物喂生成物。

## 3. 同类产品怎么做

- **构建系统**(make / bazel / tsc):源文件和构建产物分开放、产物不进版本库、源一变依赖它的产物就失效,产物永远不手改(手改了下次构建就没了)。
- **ChatGPT / Claude 的记忆**:主人看得见、能改的那份就是源;「摘要」「人设」之类是从源重算的视图,不给编辑入口,只给「重新生成」。
- 我们照的:**一张清单说清每样东西是哪一类;源一变,生成物一律过期;生成物不给手改入口。**(理念 1:一处声明、处处推导。)

## 4. 做法

**一张清单** `src/lib/memory-artifacts.ts`:

```ts
type Kind = 'source' | 'derived' | 'queue' | 'ledger'
export const MEMORY_ARTIFACTS: Record<string, { kind: Kind; regenerate?: 'overview' | 'profile' | 'portrait' | 'knowledge' }>
export function memoryArtifactKind(relPath: string): Kind   // 认不出的(notes/ 下的新文件)按 source 算
```

**源一变,生成物过期**:所有写源的路径收成一个 `writeMemorySource(root, relPath, content)`(写 + `invalidateDerivedMemory`)。今天写源的地方:nightly 的两处、nightly-runtime 的纠正、`lib/memory.ts` 的两个写函数(MCP memory_write 与 CLI memory write 共用)、gardener 的重写。守卫测试:扫 `src/` 里往 `memory/<chat>/` 写文件的调用(同 json-write 守卫的做法),不经 `writeMemorySource` / 合成提交函数的 ⇒ 红。

**过期是懒的**(整合者审稿):`invalidateDerivedMemory` 只记一笔(revision 变了),**不触发重算**。重算照旧只在两种时候:用到它的地方
看见过期(读 `_overview.md` 时隐藏、`_profile.json` 带 `needsRefresh`)和已有的那一拍(24 小时自动整理 / 主人点「整理记忆」),
沿用现有的冷却和花费闸门。不然 nightly 每晚改一次 `memory.md` 就固定多一次模型调用,断网时还会反复重试(违反「断网别重试风暴」)。
第 2 步要核:今天有没有哪个定时任务「看见过期就重算」—— 有的话,失效变准以后它会跑得更勤,要先给它加冷却。

**生成物不给手改**:`writeMemoryFile` 对 `kind === 'derived'` 拒写(码 `memory_derived_readonly`,进错误码表);桌面编辑器对这几个文件显示只读 + 「重新生成」。和证据审阅那条路的说法对齐。

**合成只吃源**:`memory-synthesis` 选输入改成按清单过滤 `kind === 'source'`(今天是一个手写的排除名单)。

**`knowledge.md`** 是 ingest 从知识库生成的:归 `derived`,但它的「源」不在记忆目录里,过期由 ingest 自己的节奏管,这一块不动。

## 5. 主人看得见的变化(一条,标出来,第 4 步等主人选)

今天桌面编辑器能改 `_overview.md`,改了下次合成就被悄悄覆盖。两种修法,**整合者拿给主人选,桌面界面归整合者**:

- **A. 只读 + 重新生成**:说实话,但把「在派生页上纠正 CC」这个手段拿走了。
- **B. 改动变成一条「主人更正」写进源**(整合者提的):在派生页上改的内容,存成 `corrections.md` 里的一条(或等价的源记录),
  再照常重新生成。不会被悄悄覆盖,主人纠正 CC 的手段也还在。我倾向 B。

其余(过期变得准、合成不再吃生成物)主人只会看到「串门时的人设和平时说的一致了」。

## 6. 切法

1. 清单 + `memoryArtifactKind` + 测试(每个已知文件都归了类;`MEMORY_ARTIFACTS` 的键与盘点表一致)。不改行为。
2. `writeMemorySource`,写源的几处改走它;守卫测试。行为变化:生成物在源变了以后会显示过期 / `needsRefresh`(以前不会)。
3. 合成按清单只吃源。
4. 等主人在 §5 的 A / B 里选;daemon 侧我做,桌面整合者做。

## 6b. 第 3b 步:更正要一直传到底(第 3 步之后、第 4 步之前;整合者审稿加的)

**为什么排在第 4 步前面**:今天主人点「更正」,只从 `memory.md` 删掉那一条;CC 自己的笔记(`profile.md`)和别的源里那句还在,
下一次重新生成总览就又学回来了,还可能在串门时说给外人听。主人以为 CC 忘了,其实只是暂时没说 —— 这是 CC 对主人说了假话。

原则:**能用代码确定做到的,不交给模型。** 三层:

- **(a) 清源头(确定的)。** 更正落下时,除了从 `memory.md` 删,还在 `profile.md`、`preferences.md`、`notes/*.md` 里删掉规范化后
  包含被更正那句的行。规范化同 nightly(空白合一);被更正那句太短(低于下限)就不做跨文件清理,免得一个短词误删无关的行。
  删之前像 gardener 那样把原文件快照进 `memory-archive/`,原因记 `retracted`。
  **这几个文件里有主人自己在桌面写的**:主人亲手点了更正,删是对的,但要让他知道删了什么 —— 每次清理在 `corrections.md`
  那一条旁边记上「从哪几个文件删了几行」,桌面的更正记录里看得到,能从 `memory-archive/` 找回。光记日志不够。
- **(b) 合成输出的最后一道过滤(确定的)。** 总览 / 画像提交前,逐行比对:规范化后命中任一条被更正的话就丢掉这一行,记日志,
  并且**每命中一次记一笔数**(按对话累计)。兜住 (a) 清不到的来源:库里的观察记录、`knowledge.md`、项目记忆。
  串门拿到的总览一定过这一层。
- **(c) 提示词里的约束:第一版不做。** 连「要点」都会把「要避开什么」的描述交给模型;(a) 清了源、(b) 卡了出口,模型从头到尾
  看不到那句,出口也保证没有。

**已知限制(照实写)**:(b) 是逐字比对(规范化以后),**换一种说法就漏过去**。装了 (b) 不等于万无一失:模型可能从零散素材里
重新拼出同一件事的另一种说法。(b) 的命中计数就是看这件事的数据 —— 命中多,说明模型在反复重建这个事实,那时再加 (c)(只描述
类别,比如「一条关于某个时间的承诺」,不给原话)。

`corrections.md` 不当事实喂合成的规矩不动;它成了 (a)、(b) 共读的那一张「被更正的话」清单。第 4 步的 B 方案也落在这上面:
主人在派生页上的改动 = 再加一条更正,下一次重新生成照样过 (b)。

测试要钉:(a) 跨文件清理 + 快照 + 下限 + 更正记录里写了删了哪几个文件几行;(b) 命中的行被丢、记数、未命中的原样。

## 7. 不做

- 不改 `memory.md` 的格式、nightly 的整理逻辑、gardener 的压缩策略。
- 主人在 `memory.md` 里手加的一行没有「主人」标记、nightly 可能改写它 —— 这是个真问题,但它是「整理规矩」不是「源和生成物」,另立一件。
- 不动知识库那一侧(`knowledge.md` 的源)。
