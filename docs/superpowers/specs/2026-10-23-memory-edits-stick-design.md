# 记忆:主人改了就算数(设计稿)

> 2026-10-23 · 主人当天拍板:在生成的记忆上改,**删掉 / 改掉的那一行 = 一条更正**(走现有的更正路径,随之清源头、关待办);
> **加的 / 改写成的那一行 = 主人亲口说的**:优先级最高,合成永远不改写它,标「你改过」。daemon 侧 arch-review 做,桌面整合者做。
> 这是[源与生成物设计稿](2026-10-23-memory-source-vs-derived-design.md) §5 的 B 方案落地,同时收掉那份 §7 留下的「主人在 `memory.md` 里手加的一行没有『主人』标记、nightly 可能改写它」。

## 今天的样子(读代码核过)

- 桌面记忆页对任何 `.md` 走 CLI `memory write`(`apps/desktop/src/modules/memory.js` 的 `saveCurrent`)→ `lib/memory.ts` 的 `writeMemoryFile`,整份覆盖。
- 主人能改的、而且会被机器重写的有两份:
  - `_overview.md`(生成物,`synthesizeOverview` 合成;串门当「CC 眼中的主人」、快照、桌面画像都读它)—— 改了下一次合成悄悄覆盖。
  - `memory.md`(源,但 nightly 每晚整理时会 add / update / 合并)—— 主人手加的一行没有任何标记,第二晚可能被改写或并掉。
- 更正今天只认 `memory.md` 里带编号的条目(`nightly-runtime.ts` 的 `correct(id, verdict)`);`_overview.md` 的行没有编号,改了就只是改了。
- 更正之后的三层已经有了:清源头(`purgeCorrectedFromSources`)、关待办(逐字 + 便宜模型)、合成出口过滤(`dropCorrectedLines`)。

## 对标

| | 主人改一句记忆会怎样 | 取什么 |
|---|---|---|
| Meta Muse | 记忆条目可删可改;删了的不再出现 | 删 = 更正,一路传到底(我们已有) |
| OpenAI dots / ChatGPT 记忆 | 「管理记忆」里删条目;主人说的话当记忆存,模型摘要另算 | 主人原话与模型摘要**分开存**,摘要不能改写原话 |
| 构建系统(make / tsc)| 生成物不手改;要改就改源再重算 | 生成物本身不接受手改,手改被翻译成对源的两种操作 |

理念:**主人在任何一份生成的记忆上动手,都被翻译成对源的两种操作 —— 撤一句(更正)、说一句(主人原话);生成物本身永远只由机器写。**
这样「改了下次又被覆盖」在结构上就不可能发生,不靠提醒。

## 做法

### 1. 新的源:`owner.md`(主人原话)

- 进 `src/lib/memory-artifacts.ts` 的清单:`kind: 'source'`,喂合成。
- 格式同 `memory.md` 的条目行(复用 `curated-doc.ts` 的解析):`- <原话> <!-- o:<id> · <日期> · <来自 overview|memory> -->`;
  改写来的那条额外记 `· 替换:<更正 id>`;view 把它展开成 `replaces: { correctionId, text }`。
- **只有一个写者**:下面第 3 节的编辑接口。守卫测试照 3e 第 2 步那条(扫往 `memory/<chat>/` 写文件的调用):`owner.md` 只许经 `writeOwnerAssertions` 写。
  CC 的 MCP `memory_write`(`daemon/memory/fs-api.ts`)对 `owner.md` 拒写 —— CC 不能替主人「说」话。nightly、gardener、合成都不写它。
- `owner.md` 按对话分(`memory/<chatId>/owner.md`),**只在主人自己的对话里注入**;访客 / trusted 的对话读不到它(编辑接口也只认主人的 chatId)。
- 每轮注入:排在 `memory.md` 前面,标题「主人亲手写的(和下面冲突时以这里为准)」(`prompt-builder.ts` 加一段,`main.ts` 的 `curatedMemoryFor` 旁边加 `ownerMemoryFor`)。
- nightly 整理时把它当只读素材给模型:「主人亲口说的,不要改写、不要重复写进记忆;记忆里和它冲突的条目改掉或删掉」。

### 2. 合成把主人原话原样放进去(代码放,不交给模型)

- `synthesizeOverview` 照常让模型写总览,然后**由代码**在提交前把 `owner.md` 的每一条原样插到总览最前面一节「## 你写的」,
  每行尾注 `<!-- o:<id> -->`。模型写的部分照旧过出口过滤(`dropCorrectedLines`);主人原话不过 —— 那是主人说的,不该被更正清单挡。
- 模型也看得到 `owner.md`(它是源、喂合成),提示词里写「下面这些主人已经亲口说了,总览里不要再复述」,免得说两遍。复述了也只是重复,不是错。
- **对外一律不带「你写的」那一节**:一个函数 `overviewForOthers(memoryRoot)` 读 `_overview.md` 并去掉这一节;凡是要把总览带出主人自己对话的
  (今天是 `wire-visit.ts` 的串门「CC 眼中的主人」)都经它。守卫测试扫 `src/` 里直接读 `_overview.md` 的地方,白名单只有:桌面 view、合成自己、
  主人自己在微信里「看记忆」(`pipeline-deps.ts` 的 `readOverview`)、内部素材(`snapshot.ts`、`memory-llm-ops.ts`、`portrait-artist.ts`、
  `tick-introspect.ts`,都只在主人这一侧用)。以后新加一个对外读者,不经 `overviewForOthers` 就红。
  主人是在自己的记忆页上写给 CC 看的,不等于同意说给别人的 CC 听。删掉的那一行照旧随出口过滤从对外的总览里消失(这是想要的)。

### 3. 读这一侧:`view`(桌面画「你改过」、也是编辑的底稿)

`POST /v1/memory/view`(CLI `memory view <chat> <path> --json`;`path` ∈ `_overview.md` / `memory.md` / `owner.md`):

```ts
type Replaces = { correctionId: string; text: string }   // 被替换掉的旧话;编辑回执和 view 用同一个形状
type ViewLine = {
  text: string,                     // 不带任何尾注 / 标签
  origin: 'generated' | 'owner',    // owner = 来自 owner.md,桌面画「你改过」
  lineKey?: string,                 // origin === 'generated' 时有:memory.md 的条目 = 它的编号 m:<id>;
                                    // 总览的行 = sha256(规范化文本 + '#' + 同文第几次出现) 的前 16 位 —— 不含位置,主人在上面插行不会让下面的键漂
  assertionId?: string,             // origin === 'owner' 时有
  editedAt?: string,                // 主人写下这句的日期
  replaces?: Replaces,
}
{ ok: true, path: string, baseHash: string, generatedAt: string | null, stale: boolean, lines: ViewLine[] }
```

- `origin` 只由代码根据 `owner.md` 的编号判,不看文字。主人原话和模型写的同一句话,只有前者是 `owner`。
- 生成戳、「## 你写的」这样的节标题、空行不出现在 `lines` 里。
- 更正记录照旧从现有的更正列表读;每条加 `origin: 'memory' | 'overview' | 'owner'`,桌面能分「从总览里删的」和「从记忆里删的」。

### 4. 编辑接口:回传同一个形状,不碰原文

桌面不编辑带尾注的原文(给主人看注释不行,剥掉再回传又会让每一行都变成「删 + 加」)。编辑的单位是 `view` 给的行:

`POST /v1/memory/edit`(admin 才能调;`route-tiers` 登记;CLI `memory edit <chat> <path> --base <hash> --stdin --json` 是薄壳,桌面照旧经 CLI):

```ts
// 请求
{ chatId: string, path: '_overview.md' | 'memory.md' | 'owner.md', baseHash: string,
  lines: Array<{ text: string; lineKey?: string; assertionId?: string }>,   // view 给的键原样带回
  confirmBulk?: true }
// 回
{ ok: true,
  corrections: Array<{ id: string; text: string }>,
  assertions: Array<{ id: string; text: string; replaces?: Replaces }>,
  regenerate: 'queued' | 'not_needed' }
| { ok: false, code: 'memory_changed' }                       // baseHash 对不上:磁盘一个字节没动
| { ok: false, code: 'memory_edit_bulk', count: number }      // 更正超过 5 条且没带 confirmBulk:磁盘一个字节没动
| { ok: false, code: 'memory_edit_too_large', limit: { lines: 200, bytes: 65536 } }
| { ok: false, code: 'memory_edit_path' }
```

按键比对,不做模糊 diff:

| 回来的行 | 和 view 时比 | 结果 |
|---|---|---|
| 带 `lineKey`,文字没变 | — | 什么都不做 |
| 带 `lineKey`,文字变了 | 主人改了一句生成的话 | 一条更正(旧文字)+ 一条主人原话,`replaces` 指向那条更正 |
| view 里有的 `lineKey`,回来没了 | 主人删了 | 一条更正 |
| 带 `assertionId`,文字没变 | — | 什么都不做 |
| 带 `assertionId`,文字变了 | 主人改了自己的原话 | 一条更正(旧原话)+ 一条新原话(新编号),`replaces` 指向那条更正 |
| view 里有的 `assertionId`,回来没了 | 主人收回自己的话 | 从 `owner.md` 去掉 + 一条更正(源里抄到的也该清) |
| 两个键都没有 | 新加的 | 一条主人原话 |
| 键是 view 里没有的(伪造 / 过期) | — | 整个请求 `memory_edit_path`,不写 |

- 更正:`memory.md` 的条目走现有 `correct(id, 'wrong')`;总览的行走新加的 `correctText(text, 'wrong', origin)` —— 同一条串行链、
  同样清源头 / 关待办 / 写 `corrections.md`,段名记 `[总览]`。被更正的话短于 `MIN_CORRECTED_CHARS`:照记,不做跨文件清理(现有规矩)。
- **大批删除要确认**:一次编辑会产生超过 5 条更正 ⇒ `memory_edit_bulk` + 条数,什么都不写。每条更正都会清源头、关待办,
  撤回只能去 `memory-archive/` 翻。桌面问「要删掉 N 条?CC 会把它们当成说错了的,源头也会清掉」,主人点了再带 `confirmBulk: true` 重发。
- `baseHash` = view 时那份文件内容的 sha256;和磁盘不一样(nightly / 合成在这期间写过)⇒ `memory_changed`,桌面重新读、让主人再改一次。不合并。
- 有更正或原话 ⇒ 总览过期(现有 `invalidateDerivedMemory`),`regenerate: 'queued'`;沿用现有冷却和花费闸门,不额外调模型。
- 三个新码(`memory_edit_bulk` / `memory_edit_too_large` / `memory_edit_path`)和 `memory_changed`、`memory_derived_readonly` 一起进错误码表。
- 不再允许整份覆盖:`memory write` 对 `kind === 'derived'` 拒写(`memory_derived_readonly`),对 `memory.md` / `owner.md` 也提示走 `memory edit`
  (这两份手改必须经比对,不然又绕回「改了不算数」)。

## 已知限制(照实写)

- **冲突靠提示,不靠代码**:主人写了「我不喝咖啡」,`memory.md` 里还有一条「喜欢美式」—— 注入时标了「以主人这里为准」,nightly 也被要求改掉冲突条目,
  但没有代码能判两句话矛盾。如果主人是在改写那一条(diff 里是相邻的删 + 加),旧的那条就成了更正,会被确定地清掉;只有主人另起一行写时才靠提示。
- 出口过滤是逐字的(3b 已经写过):模型换个说法重新拼出被删的那句,挡不住;命中计数照旧是看这件事的数据。

## 切法

1. `owner.md` 进清单 + 唯一写者 + MCP 拒写 + 守卫测试 + 每轮注入 + nightly 只读素材。主人还没写过原话时什么都不变。
2. `correctText`(总览的行也能更正)+ `POST /v1/memory/view` / `edit` + 按键比对 + 大批确认 + CLI 薄壳 + 错误码。
3. 合成插「你写的」一节 + `overviewForOthers` + 读 `_overview.md` 的守卫。
4. `memory write` 对生成物 / `memory.md` / `owner.md` 拒写、提示走 edit(桌面换到 edit 之后才合,整合者排)。
桌面:编辑走 `memory edit`、按 `origin` 画「你改过」、`memory_changed` 时重新读 —— 整合者做,第 2、3 步合了就能开工。

## 测试要钉住的

- 按键比对表里每一行一条;只改空白 ⇒ 什么都没有;同文出现两次删掉其中一次 ⇒ 恰好一条更正。
- 主人在开头插一行 ⇒ 下面的 `lineKey` 不变,只多一条原话。
- 伪造 / 过期的键 ⇒ `memory_edit_path`,磁盘不变。
- 6 条更正不带 `confirmBulk` ⇒ `memory_edit_bulk` + `count: 6`,磁盘不变;带上 ⇒ 6 条都落。
- `baseHash` 不对 ⇒ `memory_changed`,磁盘不变。超限 ⇒ `memory_edit_too_large` 带 `limit`。
- MCP `memory_write` 写 `owner.md` ⇒ 拒;守卫扫到别的写者 ⇒ 红。
- 重新生成后:主人原话逐字出现在「你写的」;模型那部分照旧被出口过滤;view 里这些行 `origin: 'owner'`、`replaces` 形状和编辑回执一致。
- `overviewForOthers` 去掉「你写的」;守卫扫到白名单外直接读 `_overview.md` ⇒ 红。
- 访客 / trusted 的对话 prompt 里没有 `owner.md` 的内容;非 admin 调 `/v1/memory/edit` / `/v1/memory/view` ⇒ 拒。
- 总览上删的那行:清源头、关待办、写进 `corrections.md`,段名 `[总览]`。

## 不做的

- 不做三方合并(冲突就让主人重来一次),不做模糊 diff(按键比对)。
- 不让模型判断主人原话和记忆条目是否矛盾(见已知限制)。
- 不改 `memory.md` 的格式、nightly 的整理策略、画像(`_profile.json`)—— 画像的编辑另议,这一版只读。
