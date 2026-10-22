# 记忆:哪些是源,哪些是生成物(第三批 3e)设计稿

> 2026-10-23 · wechat-cc arch-review 起草,待 wechat-cc-9d 审。上位:`docs/architecture-review-2026-10-21.md` §3e「记忆定『源』:库和 memory.md 是源,其余标生成物」。

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

**生成物不给手改**:`writeMemoryFile` 对 `kind === 'derived'` 拒写(码 `memory_derived_readonly`,进错误码表);桌面编辑器对这几个文件显示只读 + 「重新生成」。和证据审阅那条路的说法对齐。

**合成只吃源**:`memory-synthesis` 选输入改成按清单过滤 `kind === 'source'`(今天是一个手写的排除名单)。

**`knowledge.md`** 是 ingest 从知识库生成的:归 `derived`,但它的「源」不在记忆目录里,过期由 ingest 自己的节奏管,这一块不动。

## 5. 主人看得见的变化(一条,标出来)

- 桌面记忆编辑器里 `_overview.md` / `_profile.json` 变成只读,旁边一个「重新生成」。**以前能改,但改了下次就被覆盖、不提醒** —— 现在说实话。这是主人看得见的一处变化,PR 描述和发版说明各写一句;如果整合者认为要主人先点头,这一步可以单独拆出去等。

其余(过期变得准、合成不再吃生成物)主人只会看到「串门时的人设和平时说的一致了」。

## 6. 切法

1. 清单 + `memoryArtifactKind` + 测试(每个已知文件都归了类;`MEMORY_ARTIFACTS` 的键与盘点表一致)。不改行为。
2. `writeMemorySource`,写源的几处改走它;守卫测试。行为变化:生成物在源变了以后会显示过期 / `needsRefresh`(以前不会)。
3. 合成按清单只吃源。
4. 生成物只读(§5 那一条),桌面只读 + 重新生成。

## 7. 不做

- 不改 `memory.md` 的格式、nightly 的整理逻辑、gardener 的压缩策略。
- 主人在 `memory.md` 里手加的一行没有「主人」标记、nightly 可能改写它 —— 这是个真问题,但它是「整理规矩」不是「源和生成物」,另立一件。
- 不动知识库那一侧(`knowledge.md` 的源)。
