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
-- 建在 v87(`src/lib/db/migrations/v087.ts`,G2);和初稿的差别见 §6
CREATE TABLE memory_facts (
  id            INTEGER PRIMARY KEY,           -- facts.db 搬过来的行保留原 id(待办页、MCP 认的是它)
  chat_id       TEXT NOT NULL,                 -- 哪个对话的记忆;联系人事实记主人的 chat
  key           TEXT NOT NULL,                 -- 'm:<hex>' 有编号的记忆条目 / 'u:<n>' 没编号的 / 'o:<id>' 主人原话 / 'x:<文档>:<n>' 认不出的行 / 'c:<id>' 只剩更正的墓碑 / 'k:<原 id>' 联系人事实
  doc           TEXT NOT NULL,                 -- memory / owner / contact:这一行属于哪份文档(CHECK)
  subject       TEXT NOT NULL,                 -- 'owner' 或联系人 username
  section       TEXT,                          -- 记忆五栏之一;别的为 NULL
  ord           INTEGER NOT NULL DEFAULT 0,    -- 在那份文档里的先后
  kind TEXT, predicate TEXT, related_contact TEXT, time_ref TEXT, confidence TEXT,  -- facts.db 原列
  text          TEXT NOT NULL,                 -- 一句话本身(记忆条目 = 正文;联系人事实 = value)
  status        TEXT NOT NULL,                 -- active / retracted / outdated / superseded / resolved(CHECK)
  source        TEXT NOT NULL,                 -- owner / nightly / import / extract / review / legacy_correction
  origin        TEXT,                          -- owner.md 原话写在哪儿:overview / memory / owner
  scope         TEXT NOT NULL DEFAULT 'chat',  -- 'owner_only' = 只在主人对话出现、对外一律去掉(今天 owner.md 的规矩;CHECK)
  evidence      TEXT,                          -- JSON:消息 key / 观察 id(今天 memory-sources.json 与 source_msg_keys)
  seen_at TEXT, valid_from INTEGER, invalidated_at INTEGER, superseded_by INTEGER,
  replaces      INTEGER REFERENCES memory_facts(id),  -- 主人改写:新原话指向被收回的那一行
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(chat_id, key)
) STRICT;
CREATE TABLE memory_fact_events (            -- 历史,只追加
  seq INTEGER PRIMARY KEY AUTOINCREMENT, fact_id INTEGER NOT NULL REFERENCES memory_facts(id), chat_id TEXT NOT NULL, ts INTEGER NOT NULL,
  action TEXT NOT NULL,                        -- added / updated / retracted / restored / superseded / resolved / redacted_on_output
  actor  TEXT NOT NULL,                        -- owner / nightly / cc / judge / import
  verdict TEXT, prev_text TEXT, note TEXT      -- note = 清源头 / 关待办的回执(今天写在 corrections.md 那条底下)
) STRICT;
CREATE TABLE memory_derived (chat_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, input_rev INTEGER NOT NULL, generated_at INTEGER NOT NULL, PRIMARY KEY(chat_id, kind)) STRICT;
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

## 6. 进度

§4 那五条主人 2026-10-26 全部照建议点头。

| 步 | 状态 | 落在哪 |
|---|---|---|
| G0 金样 | 做完 | 夹具 `src/test-support/fixtures/memory/chats/`(owner:BOM、栏外 / 认不出的行、没编号的条目、半截尾注、已更正又被写回的「下周要去杭州出差三天」「年糕是狸花猫」、`替换:` 两条、短于 `MIN_CORRECTED_CHARS` 的更正;guest:CRLF、磁盘上有 `owner.md` 但不该注入、超过注入上限的 `profile.md`;empty:什么都没有)与 `facts.json`(facts 五种状态 + 图的联系人)。金样 `fixtures/memory/golden/`,由 `src/features/memory/memory-golden.test.ts` 用今天的代码生成并逐字节比:每个对话的 `memory.md` / `owner.md` 序列化、五段注入(`curatedMemoryFor` / `ownerMemoryFor` / `coreMemoryFor` / `todayDraftFor` / `knowledgeMemoryFor`)、整理素材头两块(纠正 + 原话)、`correctedTexts` 名单、`overviewForOthers`;外加 `knowledge.md` 蒸馏。`.gitattributes` 让这棵树按字节进出 |
| G1 知识库迁移 | 做完 | `runMigrations(db, list)`(#79 的修复只对主库那张表);`src/adapters/knowledge/migrations/{source,semantic,graph,facts}/`,每个 `v001` = G1 之前 `store.ts` 的建表 + 守着的 `ALTER`,原样、幂等;`store.ts` 里没有 `CREATE TABLE` / `ALTER TABLE` 了。守卫 `scripts/schema-ddl-in-migrations.guard.test.ts`(`src/` 与 `cli.ts` 的生产代码里建表 / 改表只许在 `**/migrations/**`,基线 0);v056–v058 共用的工作台建表语句随之搬进 `src/lib/db/migrations/shared-ddl.ts`(`schema-helpers` 照原名转出,`migration-frozen` 一起冻)。`scripts/db-migrations.guard.test.ts` 钉住四张知识库迁移表,`migration-frozen` 与 CI 路径过滤加上知识库目录。升级路径测试 `src/adapters/knowledge/migrations.test.ts`(从 0、今天的结构再跑 v001、真机旧形状、`openKnowledge` 打开 G1 之前的目录) |
| G2 表与渲染 | 做完 | 迁移 v87 建 `memory_facts` / `memory_fact_events` / `memory_derived`(升级测试从真 v86 起,`src/lib/db.test.ts`);形状与「今天的文档 → 行」的纯转换 `src/domain/memory/facts.ts`(`factsFromMemoryDoc` / `factsFromOwnerDoc`,G3 导入用);渲染 `src/domain/memory/render.ts`(`renderMemoryMd` / `renderMemoryForPrompt` / `renderOwnerMd` / `renderOwnerForPrompt`);口 `src/ports/memory-facts.ts`、店面 `src/adapters/store/memory-facts.ts`(插入一批 + 每行一条 `added` 事件同一事务、按对话列、修订号、事件、生成物缓存)。没人读写。金样:`src/domain/memory/render.test.ts`(纯渲染)与 `src/adapters/store/memory-facts.test.ts`(进表再读出来)都和 G0 逐字节相等 |
| G3 导入 | 做完 | 迁移 v88 建 `memory_import`(对话 → 三份文件的总指纹)与 `memory_exports`(G4 用)。`src/features/memory/fact-import.ts`:memory 模块初始化时(在挂任何记忆路由之前)对 `<stateDir>/memory/*` 逐个对话导入,一个对话一个事务;corrections.md → 墓碑(`src/domain/memory/corrections.ts`,`c:<id>` / `c:~<n>`,说法与说明进事件)先导,memory.md 里正文等于某条收回的话(够 6 个字)的条目以 `retracted` 导入,`替换:` 指向墓碑(找不到的补占位墓碑)。核对:表渲染出的 memory.md / owner.md / corrections.md、两段注入、收回名单与今天的代码处理磁盘文件的结果逐字节相等,才记指纹;不等 ⇒ 整个对话回滚、日志写第一处差异。店面加 `mirror`(让表变成给定的样子:插 / 改 / 改状态 / 追加说明 / 没了的标 `outdated`,不删行)、`tombstones`、`atomically`、导入指纹。测试 `src/features/memory/fact-import.test.ts`(两次一样、写回的旧话导成收回、`替换:` 链、核对不过不搬、文件变了再同步、BOM / CRLF) |
| G4 写者切到表 | 做完 | `src/features/memory/memory-export.ts`(`MemoryWriter`)是 memory.md / owner.md / corrections.md 唯一的写者:`commitMemory` / `commitOwner` 先 `mirror` 落表(一个事务)、再从表导出,`addCorrection` / `addCorrectionNote` 记墓碑与说明、再导出 corrections.md;导出记 `memory_exports` 指纹并刷新导入指纹(下次开机不再同步)。每晚整理、逐条纠错、记忆编辑(`applyPlan`)、从别的助手导入、CC 后来又关掉的待办都改调它;`lib/memory-owner` 的 `writeOwnerAssertions` 删掉。没搬进表的对话照旧写今天的格式。守卫:`scripts/memory-owner-writers.guard.test.ts` 加一条「往这三份文件写只许在导出器」,基线 0。主人 10-26 第 4 条:导出的 memory.md 头部带「这是生成的:直接改这里不算数,去记忆页改」(同一行注释,解析器照旧跳过,注入不变);磁盘上那份和最后一次导出不同、头部还带这句 ⇒ 手改,开机导入不拿它当源,每晚整理那一拍前 `reconcileHandEdit` 按记忆编辑的比对表变成更正 / 原话、重新导出、微信说一次;改动多到要确认的不照办,手改的那份存进 `memory-archive/`。测试 `src/features/memory/memory-export.test.ts`、`nightly-runtime.test.ts` 的手改两条 |

读代码时发现的(金样照今天的样子钉住,不在 G0 改):

- 每轮注入的 `memory.md`(`curatedMemoryFor`)**不过**纠正名单:已更正又被整理写回的行(夹具里「年糕是狸花猫」)今天照样进主人对话的提示词。§1.2 / 「数据怎么搬」第 1 条说这类行「靠出口过滤挡着」,只对合成产出成立。G3 把它导成 `retracted` 以后,G6 读表时它就从提示词里消失了 —— 这是一处**看得见**的变化(变好),G6 的金样要单独更新这一处并在 PR 里写明。
- §2.4 只说三个库各一张迁移表、「`facts.db` 不再单独迁移」;但 G1 的结束条件是 `store.ts` 里没有建表 / 改表,而 `facts.db` 要到 G7 才搬走 ⇒ G1 给 `facts.db` 也建了一张(共四张,加主库五张)。G7 之后它只在导入时读一次,那张表留着不再追加。
- 主库这边也不只 `migrations/` 里有建表:`src/lib/db/schema-helpers.ts` 有三段被 v056–v058 调用的工作台建表语句。零基线的守卫要求它们进 `migrations/`(见上);它们本来就是冻结迁移的内容,以前没有被冻住。
- §2.1 初稿的表在落地时改了五处(上面的 SQL 已是落地的样子):① `key` 只在一个对话里唯一(`UNIQUE(chat_id, key)`):`m:` 编号是每个对话各自随机的 6 位十六进制,`o:` 也是,全库唯一会撞。② 加 `ord`:`memory.md` 要逐字节还原「顺序」,初稿没有放顺序的列。③ 加 `doc`:认不出的行(`extra`)和没编号的条目也要进表(`x:` / `u:` 两种 key),光靠 `source` 分不出一行属于 `memory.md` 还是 `owner.md`。④ 加 `origin`:`owner.md` 每条尾注里的 `overview / memory / owner` 初稿没有列放。⑤ 事件表加 `chat_id` 并按它建索引,修订号不用每次连表;`seq` 用 `AUTOINCREMENT`,保证修订号永不回头。另外只有 `doc` / `status` / `scope` 用 CHECK 钉死,`source` / `action` / `actor` 的取值在 TS 类型里(以后加值不用重建表)。
- 被 `替换:` 指到的更正在导入时必须先有一行墓碑(`replaces` 是外键);`owner.md` 渲染时从那一行的 `c:<id>` 取编号。G2 的金样测试按这个顺序造行(先墓碑、后原话)。
- G3 **不改名**原文件(「数据怎么搬」第 3 条说核对通过后改名 `*.imported-<日期>`):G3 时 daemon 的读者和写者都还在读写这些文件(写者 G4 才落表、读者 G6 才换源),改名等于当场把记忆删掉。改成第一次导入成功时**复制**一份 `*.imported-<日期>` 留档,原文件不动;按主人 10-26 第 5 条留到下一个小版本发版,再挪进 `memory-archive/`(那一步是发版时的清理,不在 G3–G5)。
- G3 期间文件仍是源,指纹变了的那次同步是**镜像**(表变成文件的样子:新条目加、改了的改、文件里没了的标 `outdated`、新的更正成墓碑并把同句收回),而不是「回滚」一节说的「只认新增」。只认新增在 G3 会让整理删掉的条目在表里一直 active,G4 一切到表就复活。G4 起导出文件,同一个镜像也就是回滚后老二进制写过的文件的正确处理(老二进制读的是最新导出)。
- §1.1 说证据审阅(`review-routes.ts`)「整份写」memory.md:读代码它只改主库的 `observations` / `events` 并让生成物过期,不写 memory.md。G4 的写者清单里没有它。
- G4 主人看得见的(都在 §4 或由主人 10-26 第 4 条定下,PR 里逐条写明):① 导出的 memory.md 头部多一句「这是生成的…」;② 已收回又被整理写回的条目(G0 夹具里的「年糕是狸花猫」「下周要去杭州出差三天」)从第一次导出起就不在 memory.md 里了,所以也不再注入主人对话 —— 这本来记在「G6 才变」,实际 G4 就变,因为读者读的就是导出;③ 手改 memory.md 变成更正 / 原话加一句微信。另一处细节:「CC 又判断…也改成 dropped」那段说明以前追加在 corrections.md 末尾,两条更正挨得很近时会落在后一条底下;现在落在它自己那一条底下。
- 证据审阅不是 memory.md 的写者(见上面 G3 那条),G4 没动它。
- 手改只对主人的对话核对(每晚整理运行时只管主人)。F6(#725)起桌面能经 `/v1/memory/file/write` 整份写别人对话的 memory.md(主人那一份照旧被 `wholeFileWriteRefusal` 拒):那种写下次开机照文件同步,不当成手改。
