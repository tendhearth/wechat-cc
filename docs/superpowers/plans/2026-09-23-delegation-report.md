# 交办后的回报 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「交给 CC 之后能放心离开、回来接得上」成立:从聊天里交办的事,每次答复完都回到它出生的那次交流里说一声,人不在就等人回来。

**Architecture:** `matters` 加两列记住出生地(哪次交流、哪条消息)。答复那一拍(`settleQuiet` 里 `setStatus('replied')` 的同一处)生成一条回报,**走自己的路径而不是 `matterSync`**(那个包装故意吞异常)。回报的**痕**写进原对话的流;**投递**进一张只管送达的小队列表(pending / attempts / next_at,照提醒那条路的规矩:票据过期不算失败、人回来补发、绝不烧重试)。降噪第一版用 `matter_bindings.last_seen_at` 当粗闸。回忆那半在最后两个任务,由 CC 自己写、代码先算信号再问便宜模型。

**Tech Stack:** Bun 1.3.14 + Node 24 双跑 vitest;bun:sqlite(经 `src/lib/runtime/sqlite`);内联 JS 的手机侧测试用手写假 DOM(见 `src/daemon/mobile-workbench-client.test.ts`)。

**Spec:** `docs/superpowers/specs/2026-09-23-delegation-report-design.md`(先读它的「已定(六条)」与「还没定」两节)

## Global Constraints

- 只在 `dev` 上干活;这个工作树是共享的 —— **禁止 `git stash`、禁止 `git add -A`**,要比 diff 用 `git diff HEAD -- <路径>`,提交只 `git add` 自己改的路径。
- 迁移只能**追加**,永不插队、永不就地改已发布的那些(`user_version` 只是计数,位置就是契约)。追加后 `src/lib/migration-order.test.ts` 的 `RELEASED` 锁必须同步补一行,否则最后那条断言(`Math.max(...locked) === migrations.length`)会红。
- 生产代码每个 `spawn`/`spawnSync` 带 `windowsHide: true`;测试临时目录用 `mkdtempSync` + `removeTempDir`;**路径期望一律 `join(...)` 拼,不准出现 POSIX 字面量**。
- 每个任务结束前:`bun run typecheck`、`bun run depcheck`(基线 7 warnings / 0 errors)、相关测试在 `bun x vitest run` 与 `npx vitest run -c vitest.node.config.ts` 两边都绿。提交信息中文。
- **回报不许挂进 `matterSync`**(`src/core/workbench/service.ts:972` 故意 `catch{}`)。投递失败必须留痕,否则「从来没报成功过」会伪装成「偶尔漏一条」。
- 已知 flake,不是你的锅:`routes-workbench.test.ts` 的分块上传那条在 node runner 上偶发 ECONNRESET。
- 已知别人的红(并发同事的在建代码,别去修):`src/lib/memory-synthesis.test.ts`、`src/lib/memory-derived-state.ts` 触发的仓库守卫。

---

### Task 1: 出生地两列(迁移 + store)

**Files:**
- Modify: `src/lib/db.ts`(迁移数组末尾追加 v64)、`src/lib/migration-order.test.ts`(`RELEASED` 补 `64`)
- Modify: `src/core/matters/store.ts`(`Matter` / `CreateMatter` / `SELECT` / `create`)
- Test: `src/core/matters/store.test.ts`

**Interfaces:**
- Produces:`Matter.originMatterId:string|null`、`Matter.originMessageId:string|null`;`CreateMatter.originMatterId?:string|null`、`CreateMatter.originMessageId?:string|null`。后面所有任务都从这两个字段判断「这件事要不要回报」。

- [ ] **Step 1: 先写失败的测试**(`src/core/matters/store.test.ts` 末尾追加)

```ts
it('记住出生地:从哪次交流、哪条消息里被交办的', () => {
  const db = openDb({ path: join(dir, 'state.db') })
  const store = makeMatterStore(db)
  const chat = store.ensureChat('chat-1')
  const task = store.create({ kind: 'task', title: '改首页', originMatterId: chat.id, originMessageId: 'msg-7' })
  expect(store.get(task.id)).toMatchObject({ originMatterId: chat.id, originMessageId: 'msg-7' })
  // 桌面上亲手派的没有出生地 —— 这正是「不回报」的判据,不需要额外开关。
  const handmade = store.create({ kind: 'task', title: '手动派的' })
  expect(store.get(handmade.id)).toMatchObject({ originMatterId: null, originMessageId: null })
  db.close()
})
```

- [ ] **Step 2: 跑它,确认红**

Run: `bun x vitest run src/core/matters/store.test.ts -t '记住出生地'`
Expected: FAIL —— `originMatterId` 是 `undefined`(字段还不存在)。

- [ ] **Step 3: 追加迁移 v64**(`src/lib/db.ts`,迁移数组最后一个 `},` 与 `]` 之间)

```ts
  // v64 — matter 记住出生地:哪次陪伴交流(origin_matter_id,它本身是一行 kind='chat'
  // 的 matter)、哪条消息(origin_message_id,messages.id)。两列可空:桌面上亲手派的
  // 事没有出生地,而「没有出生地 ⇒ 不回报」正是设计里的判据,不另设开关。
  (db) => {
    db.exec(`
      ALTER TABLE matters ADD COLUMN origin_matter_id TEXT REFERENCES matters(id);
      ALTER TABLE matters ADD COLUMN origin_message_id TEXT;
      CREATE INDEX IF NOT EXISTS matters_origin ON matters(origin_matter_id);
    `)
  },
```

- [ ] **Step 4: 补 `RELEASED` 锁**

Run: `bun x vitest run src/lib/migration-order.test.ts`
失败信息里会给出 v64 的新指纹(形如 `64: '<16 位十六进制>'`)。把它加到 `src/lib/migration-order.test.ts` 的 `RELEASED` 里 `63: …` 之后。**不要改 63 及以前的任何一行。**

- [ ] **Step 5: store 读写这两列**(`src/core/matters/store.ts`)

```ts
// 类型
export interface Matter {id:string;kind:MatterKind;title:string;projectPath:string|null;status:MatterStatus;ownerChatId:string|null;originMatterId:string|null;originMessageId:string|null;createdAt:number;updatedAt:number}
export interface CreateMatter {id?:string;kind:MatterKind;title:string;projectPath?:string|null;ownerChatId?:string|null;status?:MatterStatus;originMatterId?:string|null;originMessageId?:string|null}

// SELECT 与行映射
const SELECT='SELECT id,kind,title,project_path,status,owner_chat_id,origin_matter_id,origin_message_id,created_at,updated_at FROM matters'
// toMatter 里补:originMatterId:r.origin_matter_id, originMessageId:r.origin_message_id
// Row 类型里补:origin_matter_id:string|null; origin_message_id:string|null

// create 的 INSERT
db.query('INSERT INTO matters(id,kind,title,project_path,status,owner_chat_id,origin_matter_id,origin_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
  .run(id,input.kind,input.title,input.projectPath??null,status,input.ownerChatId??null,input.originMatterId??null,input.originMessageId??null,ts,ts)
```

- [ ] **Step 6: 两套 runner 跑绿 + typecheck + depcheck**

Run: `bun x vitest run src/core/matters src/lib/migration-order.test.ts src/lib/db.test.ts` 与 `npx vitest run -c vitest.node.config.ts src/core/matters src/lib/migration-order.test.ts src/lib/db.test.ts`

- [ ] **Step 7: 提交**

```bash
git add src/lib/db.ts src/lib/migration-order.test.ts src/core/matters/store.ts src/core/matters/store.test.ts
git commit -m "matter 记住出生地:origin_matter_id + origin_message_id(v64,纯加法)"
```

---

### Task 2: 交办时把出生地写进去

**Files:**
- Modify: `src/core/workbench/service.ts`(`createWechat` 那条路,以及 matter 创建处 —— 2026-09-23 时在 `:1108` 与 `:984` 附近)
- Modify: `src/core/workbench/wechat-control.ts`(把 `identity.msgId` 传下去)
- Test: `src/core/workbench/wechat-results.test.ts` 或新建 `service-origin.test.ts`

**Interfaces:**
- Consumes:Task 1 的 `CreateMatter.originMatterId/originMessageId`。
- Produces:`CreateWechatTask` 多一个可空字段 `originMessageId?:string`;task matter 创建时 `originMatterId` = `matters.ensureChat(ownerChatId).id`。

- [ ] **Step 1: 先写失败的测试**

```ts
it('从微信交办的事记住出生地;桌面亲手派的不记', () => {
  const h = harness()                        // 照 wechat-results.test.ts 现有的搭法
  const receipt = h.service.createWechat({
    ownerChatId: 'chat-1', accountId: 'acct-1', requestId: 'req-1',
    commandHash: 'hash-1', originMessageId: 'msg-7',
    projectId: h.projectId, text: '改首页',
  })
  const chat = h.matters.ensureChat('chat-1')
  expect(h.matters.get(receipt.taskId)).toMatchObject({ originMatterId: chat.id, originMessageId: 'msg-7' })

  const handmade = h.service.create({ path: h.path, providerId: 'claude', text: '手动派的' })
  expect(h.matters.get(handmade.id)).toMatchObject({ originMatterId: null, originMessageId: null })
})
```

- [ ] **Step 2: 跑它,确认红**

Run: `bun x vitest run src/core/workbench/wechat-results.test.ts -t '记住出生地'`
Expected: FAIL —— `originMatterId` 是 `null`(交办那条路还没把出生地传下去)。

- [ ] **Step 3: 实现**:`createWechat` 里,建 task matter 时带上 `originMatterId:matters.ensureChat(input.ownerChatId).id` 与 `originMessageId:input.originMessageId??null`;`wechat-control.ts` 的 `新建` 分支把 `identity.msgId` 放进 `createWechat` 的实参。

**注意**:`WechatMessageIdentity.msgId` 是**可空**的(`wechat-control.ts:14`)。没有它时 `originMessageId` 存 null —— 回报照发,只是「第几轮」这一格没有精确锚点。别为此阻塞创建。

- [ ] **Step 4: 跑绿(两套 runner)。**

- [ ] **Step 5: 提交** `git commit -m "从微信交办的事记住出生地:哪个 chat、哪条消息"`

---

### Task 3: 每轮答复生成回报,并投递到原对话

**Files:**
- Create: `src/core/matters/report.ts`(纯逻辑:该不该报、报什么)
- Create: `src/core/matters/report.test.ts`
- Modify: `src/lib/db.ts`(追加 v65:投递队列表)、`src/lib/migration-order.test.ts`
- Modify: `src/core/workbench/service.ts`(`settleQuiet` 里 `setStatus('replied')` 的同一拍)

**Interfaces:**
- Consumes:`Matter.originMatterId/originMessageId`(Task 1)。
- Produces:
```ts
export interface PendingReport {matterId:string;originMatterId:string;originMessageId:string|null;text:string}
/** 纯函数:这一轮该不该报、报什么。没有出生地 ⇒ null。只管**内容**。 */
export function renderReport(input:{matter:Matter;title:string;artifactCount:number}):PendingReport|null
/** 纯函数:现在要不要打扰人。只管**时机**,与内容无关(Task 4 实现)。 */
export function shouldDisturb(input:{lastSeenAt:number|null;now:number}):boolean
/** service 侧的可选依赖,注入便于测试;不注入就整条功能不存在(降级路径)。 */
export interface ReportSink { enqueue(matterId:string):void }
```

**为什么有一张队列表,而它不是「回报表」**:回报的**痕**在原对话的流里(spec 的方案 A,不新增事实源);这张表只管**送达**——pending / attempts / next_at,以及为了原样补发而存下的那句文本。两件事分开:痕是内容,队列是投递。

- [ ] **Step 1: 先写 `renderReport` 的失败测试**

```ts
it('没有出生地的事不报', () => {
  expect(renderReport({ matter: handmade, title: '手动派的', artifactCount: 0, quiet: true })).toBeNull()
})
it('从聊天里交办的,报一句带现成动作的话', () => {
  const r = renderReport({ matter: fromChat, title: '首页调整', artifactCount: 2, quiet: true })!
  expect(r.text).toContain('首页调整')
  expect(r.text).toContain('已答复')
  expect(r.text).toContain('生成了两份预览')      // 有成果就说几份,没有就不提
  expect(r.text).toContain(`任务 ${fromChat.id}`)  // 用现成动词,不造新命令
})
```

- [ ] **Step 2: 跑它,确认红**(模块还不存在)。

- [ ] **Step 3: 写 `renderReport`(最小实现)。** 文案模板:

```
<标题> · 已答复。<成果句>
看:任务 <id> · 接着说:任务 <id> 补充 …
```
成果句:`artifactCount===0` ⇒ 省略;`>0` ⇒ `生成了 N 份成果。`

- [ ] **Step 4: 追加迁移 v65(投递队列)+ 补 `RELEASED` 锁**

```ts
  // v65 — 回报的投递队列。回报的"痕"在原对话的流里(不新增事实源);这张表只管
  // 送达:票据过期不算失败(照提醒那条路的教训),存 pending、人回来补发、绝不烧重试。
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS matter_report_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id TEXT NOT NULL REFERENCES matters(id),
        origin_matter_id TEXT NOT NULL REFERENCES matters(id),
        origin_message_id TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','dropped')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS matter_report_outbox_due ON matter_report_outbox(status, next_at);
    `)
  },
```

- [ ] **Step 5: 在答复那一拍入队**(`service.ts` 的 `settleQuiet`)

`matterSync(m=>m.setStatus(running.taskId,'replied'))` 之后**另起一句**,不要放进 `matterSync`:

```ts
// 回报:每轮答复一次,只对从聊天里交办的事。不进 matterSync —— 那个包装故意吞掉
// 所有异常,回报挂进去会把"从来没报成功过"伪装成"偶尔漏一条"(2026-09 的教训)。
try { opts.reports?.enqueue(running.taskId) } catch (err) { opts.log?.(`[report] enqueue failed for ${running.taskId}: ${errText(err)}`) }
```

- [ ] **Step 6: 投递器**:读 `status='pending' AND next_at<=now` 的行 → 按 `origin_matter_id` 的 wechat 绑定取 chat → 发送。发送失败按原因分路:**票据过期(errcode=-2)保持 pending 并指数退避**(不计入放弃窗口);其它网络失败同样退避;明确的永久失败(chat 不存在)记 `dropped` 并 log。

**先读**:`src/daemon/main.ts` 里 `internalApi.getPresence()` 是共用的在场入口(`:724`);提醒那条路的 pending/attempts 形状在 `src/lib/db.ts:775` 的 `reminders` 表。照它们的规矩来,不要另发明退避。

- [ ] **Step 7: 两套 runner 跑绿 + typecheck + depcheck;提交。**

---

### Task 4: 粗闸降噪(明确标临时)

**Files:** Modify `src/core/matters/report.ts`、`src/core/matters/store.ts`(读 `last_seen_at`);Test:`src/core/matters/report.test.ts`

- [ ] **Step 1: 先写失败的测试**

```ts
const NOW = 1_800_000_000_000
it('这件事刚被动过 ⇒ 只静静更新,不打扰', () => {
  expect(shouldDisturb({ lastSeenAt: NOW - 10_000, now: NOW })).toBe(false)
})
it('很久没被动过 ⇒ 该响', () => {
  expect(shouldDisturb({ lastSeenAt: NOW - 120_000, now: NOW })).toBe(true)
})
it('从来没被动过(没有绑定记录)⇒ 该响', () => {
  expect(shouldDisturb({ lastSeenAt: null, now: NOW })).toBe(true)
})
```

- [ ] **Step 2: 跑它,确认红**(`shouldDisturb` 还不存在)。
- [ ] **Step 3: 实现**,并在代码注释里写明它粗在哪:

```ts
// 临时判据(2026-09-23):spec 要的信号是"这件事的详情正被人看着",而今天
// matter_bindings.last_seen_at 只在绑定时写(微信入站那下),详情读取不留痕。
// 所以这道闸会把"人刚在微信里说过话"误判成"人正在看这件事"。
// 收紧的条件:手机 /m/api/matter 与桌面长轮询开始写 viewed_at 之后换判据。
const VIEWED_RECENTLY_MS = 60_000
```

- [ ] **Step 4: 跑绿;提交。**

---

### Task 5: 回忆 —— CC 自己写的一段记述

**Files:** Create `src/core/matters/recollection.ts` + `.test.ts`;Modify journal 落地处(**先读** `src/core/companion-plan.ts`,它是"冷却到了先问便宜模型"那条已验证的路,照它的形状写)

**判据不是产出,是故事性**(spec 的「回忆」节)。代码先算候选信号,够不上门槛的**连便宜模型都不问**:

```ts
/** 起步阈值,故意保守。spec 说这种数要看真实数据再调 —— 调之前别加新信号。 */
export const STORY_SIGNALS = {
  turns: 2,             // 来回过 ≥2 轮
  returned: 1,          // 或者被打回 / 报错过 ≥1 次
  overnight: true,      // 或者跨过一夜(交办与答复不在同一天)
}
```

- [ ] **Step 1: 先写失败的测试**

```ts
it('够不上门槛的事,连便宜模型都不问', async () => {
  const asked = vi.fn()
  await maybeRecollect({ turns: 1, returned: 0, overnight: false, ask: asked, write: vi.fn() })
  expect(asked).not.toHaveBeenCalled()   // 闸在问之前 —— 省的是额度,也是噪音
})
it('来回过两轮就值得问一次', async () => {
  const asked = vi.fn(async () => '那天你让我改首页,我改错了两次。')
  const write = vi.fn()
  await maybeRecollect({ turns: 2, returned: 0, overnight: false, ask: asked, write })
  expect(asked).toHaveBeenCalledTimes(1)
  expect(write).toHaveBeenCalledWith(expect.stringContaining('改首页'))
})
it('没有模型时整条跳过,不留半条', async () => {
  const write = vi.fn()
  await maybeRecollect({ turns: 5, returned: 2, overnight: true, ask: undefined, write })
  expect(write).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 跑它,确认红**(`maybeRecollect` 还不存在)。
- [ ] **Step 3: 实现信号计算 + 闸门(闸在问之前)。**
- [ ] **Step 4: 让模型写那段话,落进 journal;没模型时整条跳过(不报错、不留半条)。**
- [ ] **Step 5: 可删** —— 回忆页那条记述能被摘掉(不问用户就写,但要能删,spec 已定 #6)。
- [ ] **Step 6: 两套 runner + typecheck + depcheck;提交。**

---

## 收尾(控制器做,不派发)

1. 全量 `bun run test` / `npm run test:node` / typecheck / depcheck;推 dev;`wechat-cc ci triage --wait --rerun`。
2. 重建 sidecar + `self deploy`,两条 selftest。
3. 真机:从微信交办一件事 → 走开 → 看回报回到那个对话;断网重连一次,确认回报没丢也没重发。
4. 把 spec 的「还没定」一节按实现结果收敛(尤其回忆的阈值),并在 spec 修订记录里写实现偏差。
