# 记忆:主人的事实只有一个源(架构终态 G 设计稿)

> 2026-10-25 · 上位:[架构终态](../../architecture-end-state-2026-10-25.md) 第 7 条与阶段 G。
> 前置:[记忆改了算数](2026-10-23-memory-edits-stick-design.md)那一串已合完(`owner.md`、`POST /v1/memory/view|edit`、`overviewForOthers` 都在树上);
> 本稿沿用[源与生成物](2026-10-23-memory-source-vs-derived-design.md)的四类(源 / 生成物 / 队列 / 账)和[迁移一文件一个](2026-10-23-db-migrations-per-file-design.md)的规矩。
> 只是设计,不改代码。

## 1. 今天的样子(读代码核过)

### 1.1 主人的事实住在哪

| 东西 | 在哪 | 谁写 | 谁读 |
|---|---|---|---|
| 长期记忆 `memory.md`(五栏,条目尾注 `m:<id> · 日期`) | `memory/<chat>/`,格式 `src/features/memory/curated-doc.ts` | 每晚整理(`src/features/memory/nightly.ts` 的 ops)、更正(`nightly-runtime.ts` 的 `correct`)、记忆编辑(`nightly-runtime.ts` 的 edit,纯函数在 `src/lib/memory-edit.ts`)、导入(`src/features/memory/import-command.ts`)、证据审阅(`review-routes.ts`,整份写) | 每轮注入(`prompt-reads.ts` 的 `curatedMemoryFor`)、信(`src/features/letters/wire.ts`)、草稿去重(`today-draft.ts`)、gardener、合成 |
| 主人原话 `owner.md`(`o:<id>`,可带 `替换:<更正 id>`) | 同上,`src/lib/memory-owner.ts` | 只有 `writeOwnerAssertions`(`scripts/memory-owner-writers.guard.test.ts` 守) | 主人对话注入(`ownerMemoryFor`)、整理当只读素材、合成由代码插「## 你写的」 |
| CC 的笔记 `profile.md` / `preferences.md` / `notes/` | 同上 | CC 经 MCP `memory_write`(`src/adapters/store/memory-fs.ts`、`src/lib/memory.ts`)、gardener 压缩 | 注入(`coreMemoryFor`)、回忆(`recall.ts`)、快照(`snapshot.ts`)、合成 |
| 今天的草稿 `today-draft.md`(队列) | 同上 | `profile.md` 每次写的差异 | 注入、每晚整理读完删 |
| 待办 `agenda.md` | 同上 | CC、更正时关条目(`lib/memory-corrections.ts` 的 `dropCorrectedAgenda` / `dropAgendaItems`) | 晨报、定时、伙伴 |
| 观察 / 里程碑 / 事件 | 主库 `wechat-cc.db`(`src/daemon/observations/store.ts`、`src/daemon/milestones/store.ts`) | 伙伴、证据审阅(更正 = 归档旧行 + 插新行) | 每晚整理素材(`nightly-sources.ts`)、证据审阅 |
| 联系人事实 / 义务 `facts` 表 | `knowledge/facts.db`(`src/adapters/knowledge/store.ts`) | 抽取与判官(`src/domain/knowledge/facts.ts`:record / supersede / settle / merge)、`set_fact_status` | 待办页(`apps/desktop/src/modules/todos.js`、手机 `/m/api/todo`)、`knowledge.md` 蒸馏、MCP `contact_facts` / `find_facts`、人物画像 |
| **生成物** `_overview.md` / `_profile.json` / `portrait.*` | `memory/<chat>/` | `src/lib/memory-synthesis.ts`、`src/daemon/portrait-artist.ts` | 串门人设(`src/features/social/wire-visit.ts` 经 `overviewForOthers`)、快照、桌面、主人「看记忆」(`src/daemon/wiring/pipeline-deps.ts`)、反省(`src/daemon/wiring/introspect-steps.ts`) |
| **生成物** `knowledge.md` | `memory/<owner>/` | `src/features/companion/tick-ingest.ts` + `knowledge-distill.ts`(从 facts + graph 蒸馏) | 注入(`knowledgeMemoryFor`) |
| 账:`corrections.md`、`memory-redactions.json`、`.derived-state.json`、`memory-log.jsonl`、`memory-sources.json`、`memory-archive/` | 同上 / `<stateDir>/memory-archive/` | 各写者 | 整理、合成、view |

知识库另有三个库:`source.db`(消息)、`semantic.db`(分块 + 向量)、`graph.db`(联系人与边),都在 `<stateDir>/knowledge/`(`src/daemon/bootstrap/wire-knowledge.ts` 打开)。
四个库的表结构都在 `store.ts` 里 `CREATE TABLE IF NOT EXISTS` + 按 `PRAGMA table_info` 守着的 `ALTER TABLE`,不在迁移框架里、没有 `user_version`。

### 1.2 「收回一句话」今天有四条路

| 路 | 记在哪 | 怎么传下去 | 漏洞 |
|---|---|---|---|
| ① 更正 `corrections.md` | 追加一行 `- 日期 说法:[段 · c:<id>] 原话` + 清理说明 | 清源头(`purgeCorrectedFromSources`,删笔记里含它的行)、关待办(逐字 + 便宜模型)、整理提示词里带这张清单、整理产出逐字丢(`nightly.ts` 的 `dropCorrected`) | 清单是一份要靠正则解析的 Markdown;没有「撤销更正」 |
| ② 出口过滤 | 不记,每次现读 ① | 合成提交前 `dropCorrectedLines` / `dropCorrectedValues`,命中记进 `memory-redactions.json`;整理产出 `dropOwnerWords`;对外 `overviewForOthers` 去「你写的」 | 逐字比对,换说法就漏(已知,本稿不解决) |
| ③ `set_fact_status` | `facts.status` 改成 `resolved` / `rejected` / `superseded` / `active` | 只影响 facts 的查询;**不进 ①**:主人在待办上点「不对」,`knowledge.md` 下次蒸馏不再带它,但 `memory.md`、笔记、总览里同一件事照旧 | 和 ① 完全两套 |
| ④ 证据审阅「纠正 / 过期」 | 观察行 `archived = 1` + 事件行 | 只让生成物过期;**不进 ①** | 同上 |

结论:同一件事被主人撤掉,能不能在别处消失,取决于主人是从哪个页面撤的。

## 2. 终态

### 2.1 主库里一张事实表

主库 `wechat-cc.db` 加两张表(下一个空号的迁移):

```sql
CREATE TABLE memory_facts (
  id            INTEGER PRIMARY KEY,           -- facts.db 搬过来的行保留原 id(待办页、MCP 认的是它)
  key           TEXT NOT NULL UNIQUE,          -- 'm:<hex>' 记忆条目 / 'o:<id>' 主人原话 / 'k:<原 id>' 联系人事实 / 'c:<id>' 只剩更正的墓碑
  chat_id       TEXT NOT NULL,                 -- 哪个对话的记忆;联系人事实记主人的 chat
  subject       TEXT NOT NULL,                 -- 'owner' 或联系人 username
  section       TEXT,                          -- 记忆五栏之一;联系人事实为 NULL
  kind          TEXT, predicate TEXT, related_contact TEXT, time_ref TEXT, confidence TEXT,  -- facts.db 原列
  text          TEXT NOT NULL,                 -- 一句话本身(记忆条目 = 正文;联系人事实 = value)
  status        TEXT NOT NULL,                 -- active / retracted / outdated / superseded / resolved
  source        TEXT NOT NULL,                 -- owner / nightly / import / extract / review / legacy_correction
  scope         TEXT NOT NULL DEFAULT 'chat',  -- 'owner_only' = 只在主人对话出现、对外一律去掉(今天 owner.md 的规矩)
  evidence      TEXT,                          -- JSON:消息 key / 观察 id(今天 memory-sources.json 与 source_msg_keys)
  seen_at TEXT, valid_from INTEGER, invalidated_at INTEGER, superseded_by INTEGER,
  replaces      INTEGER,                       -- 主人改写:新原话指向被收回的那一行
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE memory_fact_events (            -- 历史,只追加
  seq INTEGER PRIMARY KEY, fact_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  action TEXT NOT NULL,                        -- added / updated / retracted / restored / superseded / resolved / redacted_on_output
  actor  TEXT NOT NULL,                        -- owner / nightly / cc / judge / import
  verdict TEXT, prev_text TEXT, note TEXT      -- note = 清源头 / 关待办的回执(今天写在 corrections.md 那条底下)
);
```

- 一个对话的「修订号」= 该 chat 最大的 `memory_fact_events.seq`。它取代 `.derived-state.json` 的 revision 和记忆编辑的 `baseHash`(`memory_changed` 语义不变)。
- `extraction_state` / `judge_state` 跟着 facts 搬进主库(名字加 `knowledge_` 前缀)。
- 店面:`src/adapters/store/memory-facts.ts`(唯一写这两张表的地方);纯类型与渲染进 `src/domain/memory/`;收回、整理落库、编辑落库这些用例进 `src/features/memory/`。

### 2.2 `memory.md` / `owner.md` / 总览变成渲染出来的

- `render(chat)` 是纯函数(`domain/memory/render.ts`),从表里取 `status = 'active'` 的行:
  - `memory.md` = 五栏 + 尾注,和 `curated-doc.ts` 的 `serializeMemoryDoc` 逐字节一样(编号、日期、顺序、`extra` 原样;头部的生成戳取该对话最后一条事件的时间);`MEMORY_CAP_CHARS` 照旧。
  - `owner.md` = `source = 'owner'` 的行,格式同 `memory-owner.ts` 的 `serializeOwnerDoc`。
  - 提示词那几段(`renderForPrompt`、`renderOwnerForPrompt`)直接从行渲染,不再先写文件再读回来。
- 文件照旧写在磁盘上,但只是**导出**:每次表一变就重写(原子写),给 CLI、桌面、老版本回滚读。daemon 里没人再读它们。
- `_overview.md`:「## 你写的」一节由代码从行渲染;模型写的那部分是缓存,存 `memory_derived(chat_id, kind, body, input_rev, generated_at)`。
  `input_rev` < 当前修订号 ⇒ 过期;过期原因(added / retracted)从这段区间里的事件算,不再另记 `.derived-state.json`。导出的 `_overview.md` = 两部分拼起来。
- `knowledge.md` 照旧从 facts + graph 蒸馏,只是读的是同一张表。

### 2.3 一种收回

```ts
retract(chatId, ref: { key: string } | { text: string }, verdict: 'wrong' | 'outdated', actor): RetractReceipt
restore(chatId, key, actor)          // 撤销收回;只恢复这一行,清掉的笔记行不回来(照实说)
```

- 落库:行 `status = 'retracted' | 'outdated'` + 一条事件(一个事务)。`{ text }` 找不到行时插一行墓碑(`source = 'legacy_correction'`),所以总览上没编号的行也能收回。
- 传下去的副作用(清笔记、关待办、生成物过期)**从事件推导**,在同一个用例里做,回执写进事件的 `note`。它们是收回的后果,不是另一套记账。
- 四条入口全部调它:记忆的更正与编辑、待办「不对」(`set_fact_status` 的 `rejected`)、证据审阅的纠正 / 过期、MCP `set_fact_status` 的 `superseded`。
  `resolved`(义务办完了)**不是收回**,走 `resolve(key)`:不清源头、不过滤出口(办完了不等于没发生过)。
- 出口过滤保留(换说法挡不住,模型会从笔记里重新拼),但它的名单来自同一张表:`retractedTexts(chat)` 取代解析 `corrections.md` 的 `correctedTexts`;
  命中写一条 `redacted_on_output` 事件,`memory-redactions.json` 删掉。
- `corrections.md` 不再写;每晚整理提示词里那段「纠正过的条目」从表渲染(同格式、同截断)。

### 2.4 知识库进迁移框架

- `src/lib/db.ts` 的 `runMigrations(db)` 改成 `runMigrations(db, list)`,主库照旧传 `src/lib/db/migrations/index.ts` 那张表。
- `source.db` / `semantic.db` / `graph.db` 各一张表:`src/adapters/knowledge/migrations/<库>/index.ts` + `v001.ts`…,`scripts/db-migrations.guard.test.ts` 同样钉住四张表(位置即契约、进了 dev 不许改)。
- 每个库的 `v001` = 今天 `store.ts` 里那段建表 + 守着的 `ALTER`,原样搬过去、保持幂等 —— 现有库的 `user_version` 是 0,跑一遍 v001 什么都不变。
- `facts.db` 不再单独迁移:它的表进主库(2.1),文件在导入后改名留档。`semantic.db` 不并进主库(向量大、能从 `source.db` 重建,和主库一起备份不划算)。

## 3. 切法(每步一个 PR,结束条件 = 旧的删掉 + 零基线守卫)

| 步 | 做什么 | 结束条件 |
|---|---|---|
| G0 金样 | 合成测试夹具 `src/test-support/fixtures/memory/`(三个对话:主人、访客、空;含 BOM、`extra`、没编号的条目、已更正又被写回的行、`替换:` 链、facts.db 各状态)。用**今天的代码**生成金样:`memory.md` / `owner.md` 序列化、四段提示词、整理提示词的纠正段、`overviewForOthers`、`knowledge.md` | 金样文件进库;之后每步都跑这组 |
| G1 知识库迁移 | 2.4;`runMigrations(db, list)` | `src/adapters/knowledge/store.ts` 里没有 `CREATE TABLE` / `ALTER TABLE`;新守卫:`src/` 里 `exec` 建表 / 改表只许在 `**/migrations/**`,基线 0 |
| G2 表与渲染 | 迁移加两张表 + `memory_derived`;`adapters/store/memory-facts.ts`;`domain/memory/render.ts`。没人写、没人读 | 金样:`render(parse(夹具))` 与 G0 逐字节相等 |
| G3 导入 | 开机一次的导入(在 memory 模块之前,按对话逐个、每个对话一个事务;见下面「数据怎么搬」)。导入完、核对通过的对话记 `memory_import(chat_id, files_hash, at)` | 导入两次结果一样;核对不过的对话留在旧路径并记日志(不半搬) |
| G4 写者切到表 | 整理落库、编辑、更正、导入命令、证据审阅、`writeOwnerAssertions` 都写表,然后导出文件。读者不动(它们读到的文件就是导出) | 扩 `memory-owner-writers` 守卫:往 `memory.md` / `owner.md` / `corrections.md` 写只许是导出器,基线 0;`writeOwnerAssertions` 的写文件版删掉 |
| G5 一种收回 | 2.3;四条入口改调 `retract` / `resolve`;`correctedTexts` 换 `retractedTexts` | 删 `corrections.md` 的解析与追加、`memory-redactions.json`、`setFactStatusById`;守卫:`UPDATE … SET status` 只在 `memory-facts.ts` 的 `retract` / `restore` / `resolve` / `supersede`,基线 0;`'corrections.md'` 字面量只在导入里 |
| G6 读者切到表 | `prompt-reads.ts`、信、回忆、快照、gardener、草稿去重、串门、`pipeline-deps` 的「看记忆」、`/v1/memory/view` 读表 | 守卫:`src/` 里读 `memory.md` / `owner.md` / `_overview.md` 文件只许 CLI 离线命令与导入,基线 0(取代 `memory-overview-readers` 守卫的白名单,对外仍必须经 `overviewForOthers`) |
| G7 facts 进主库 | 知识库的 facts 部分读写主库;`/v1/knowledge/facts/*` 与 MCP 工具形状不变(id 保留) | `'facts.db'` 字面量只在导入里;`store.ts` 不再打开它 |
| G8 生成物缓存 | 总览 / 画像改存 `memory_derived`,过期按修订号 | 删 `src/lib/memory-derived-state.ts` 与 `.derived-state.json`;守卫字面量基线 0 |

### 数据怎么搬(G3、G7)

不丢一句、不让收回的话回来,靠三条:

1. **先收回、后加**:先导 `corrections.md`(每条一行墓碑 + 一条 `retracted` 事件,带原 `c:<id>`、日期、说法、清理说明),再导 `memory.md` / `owner.md`。
   导条目时,正文规范化后(`normalizeMemoryText`,够 `MIN_CORRECTED_CHARS`)命中某条墓碑的 ⇒ 以 `retracted` 导入,不以 active 导入。今天这类行靠出口过滤挡着,搬完照样挡着。
2. **原样保留**:编号、日期、栏、顺序、`extra`、`owner.md` 的 `替换:`(指向对应墓碑的 `replaces`)、认不出的行都进表;观察 / 里程碑不搬(本来就在主库,只把证据审阅接到 `retract`)。
   facts.db 用 `ATTACH` 整表拷,id、状态、时间列一一对应;`rejected` 补一条 `retracted` 事件、`superseded` 补 `superseded` 事件(历史从这里起算,之前的时间点只有 `updated_at`)。
3. **核对后才算数**:导入后 `render` 出 `memory.md` / `owner.md`,和磁盘原文件规范化后比(去 BOM、行尾空白、头部生成戳);再比四段提示词渲染结果。全等才写 `memory_import`、把原文件改名 `*.imported-<日期>`(`facts.db` 同)。
   不等 ⇒ 这个对话不搬、日志里写出第一处差异,下一次开机再试;daemon 照旧走文件路径(G4–G6 的代码对没搬的对话保留读文件的分支,G8 之后删)。

`memory-sources.json` 并进 `evidence`;`memory-log.jsonl`、`memory-archive/` 是账,原样留着不搬。

回滚:G4 起文件一直在导出,回滚到老二进制读到的是最新内容;老二进制写的东西(G3 之后)不会进表 —— 下次开机导入时 `files_hash` 变了 ⇒ 对那个对话再跑一次「文件 → 表」的差异导入(只认新增条目和新增的更正,不删表里的行)。

## 4. 主人看得见什么

| 变化 | |
|---|---|
| 表、迁移、导入、读者换源、知识库迁移框架 | 看不见 |
| 记忆页、提示词、串门人设内容不变(金样钉住) | 看不见 |
| 在待办上点「不对」,CC 在记忆、笔记、总览里也忘掉同一件事(今天只是待办消失) | **看得见** |
| 证据审阅里纠正一条观察,同样一路传到底 | **看得见** |
| `corrections.md` 不再是一个文件,记忆页换成「收回的话」列表(从历史渲染) | **看得见** |
| 收回的话可以「恢复」 | **看得见**(新能力) |
| 直接用编辑器改磁盘上的 `memory.md`,daemon 不再读它 | **看得见** |

### 等主人点头的(附建议)

1. **待办「不对」算不算收回?** 建议:算(和记忆页删一行同一回事,一路传到底);「已办」不算,只关待办。
2. **记忆页上的 `corrections.md` 换成「收回的话」列表?** 建议:换。导出期间磁盘上照旧有一份只读的 `corrections.md`(从历史渲染),再过一个版本删。
3. **给不给「恢复」?** 建议:给,放在「收回的话」列表里;说明写清「之前随之删掉的笔记行不会回来」。
4. **主人直接改磁盘上的 `memory.md` 怎么办?** 建议:导出文件头写一行「这是生成的,改这里不算数,去记忆页改」;检测到文件被手改过(和最后一次导出的 hash 不同)时,把差异按记忆编辑那张比对表变成更正 / 原话,在微信里告诉主人一次 —— 和 10-23 定的「改了就算数」一致。不建议悄悄覆盖。
5. **搬完的旧文件留多久?** 建议:`*.imported-*` 留到下一个小版本发版后,挪进 `memory-archive/`,不删。

## 5. 风险与测试

**风险**

- 渲染和今天的序列化差一个字节,注入的提示词就变了 —— G0 金样逐字节比,G2 起每步都跑。
- 导入把收回的话当 active 导进来(墓碑先导、规范化比对、核对不过不搬);导入半截崩(一个对话一个事务)。
- 主库变大:facts 行数 = 抽取量,和 `observations` 同量级;`semantic.db` 不并。
- 整理、编辑、收回并发:都走 `memory-facts.ts` 一个事务,编辑的 `memory_changed` 改看修订号。
- 换说法的漏洞不变(出口过滤仍是逐字);本稿只让名单只有一份。
- Windows:导出照旧原子写;导入要容忍 BOM 与 CRLF(夹具里放)。

**测试**

- 金样(G0 建、G2 起每步跑):夹具 → 导入 → `render` 与原文件逐字节相等;四段提示词与 G0 快照相等;访客对话里没有 `owner_only` 的行;`overviewForOthers` 不带「你写的」。
- 收回往返(一条测试串到底):主人在总览删一行 → 表里 `retracted` + 事件 → 导出的 `memory.md` 没了 → 主人对话提示词没了 → 整理产出想加回 ⇒ 被丢 → 合成产出带它 ⇒ 被滤、记一条 `redacted_on_output` → 串门人设没有 → 待办关了 → `restore` ⇒ 行回到 `memory.md`、笔记行不回来。
  同一串对待办「不对」、证据审阅纠正、MCP `superseded` 各跑一遍,断言落的是同一种事件。
- 导入:跑两次一样;已更正又被写回的行导成 `retracted`;`替换:` 链保留;facts.db 的 id 与状态逐行一致;核对不过 ⇒ 这个对话不搬、文件不改名。
- 回滚:导出后用老格式解析器(`parseMemoryDoc` / `parseOwnerDoc`)读回,与表一致;老二进制追加的条目在下次开机被差异导入。
- 迁移:四张迁移表各自的「从 0 升上来」与「已经是今天的结构再跑 v001」两条(照 `docs/maintainer/migrations.md` 的 `migratedTo(n)` 写法)。
