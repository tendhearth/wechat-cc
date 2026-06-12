# Dialogue Real Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面端"对话"页从静态 mockup 接到真实数据:规范消息存储(messages 表 + 回填)、introspect 搭车的话题线索抽取(threads,多 facet 滤镜模型)、桌面端时间线/滤镜/搜索/私密锁。

**Architecture:** daemon 收发路径落 `messages` 表(单一事实源);introspect tick 追加一次独立 haiku eval 增量抽取 `threads`(任务/知识/生活 facet + 私密 flag + tag);桌面端经 `wechat_cli_json` 调新的 `wechat-cc dialogue *` 子命令读 SQLite。Spec: `docs/superpowers/specs/2026-06-11-dialogue-real-data-design.md`。

**Tech Stack:** bun:sqlite(append-only migrations)、citty CLI、vitest、daemon e2e harness(fake-sdk)、原生 JS 桌面端(Tauri shim)。

**Spec 偏差(实施时生效):** 抽取水位不放 `session_state`(那是 bot 健康表,按 bot_id 键),新建 `thread_extract_state(chat_id PK, extracted_to_ts)`。

**前置:** 实施前 `git pull --ff-only origin dev`,从 dev 最新开工。全程在 dev 上小步提交(项目惯例),不开 feature 分支。

---

### Task 1: DB migration — messages / threads / thread_extract_state + events CHECK 重建

**Files:**
- Modify: `src/lib/db.ts`(migrations 数组末尾追加一个 entry;**绝不**改动已发布条目)
- Test: `src/lib/db.test.ts`(已有文件,追加用例)

- [ ] **Step 1: 写失败测试**

在 `src/lib/db.test.ts` 追加:

```ts
describe('dialogue migration', () => {
  it('creates messages / threads / thread_extract_state tables', () => {
    const db = openTestDb()
    // 三张新表可写入
    db.exec(`INSERT INTO messages(id, chat_id, ts, direction, kind, text, source)
             VALUES ('m1', 'c1', '2026-06-11T00:00:00Z', 'in', 'text', 'hi', 'live')`)
    db.exec(`INSERT INTO threads(id, chat_id, title, facets, created_ts, last_active)
             VALUES ('t1', 'c1', '排产', '["task"]', '2026-06-11T00:00:00Z', '2026-06-11T00:00:00Z')`)
    db.exec(`INSERT INTO thread_extract_state(chat_id, extracted_to_ts)
             VALUES ('c1', '2026-06-11T00:00:00Z')`)
    expect(db.query('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 1 })
  })

  it('messages.direction is constrained to in/out', () => {
    const db = openTestDb()
    expect(() => db.exec(
      `INSERT INTO messages(id, chat_id, ts, direction, kind, text, source)
       VALUES ('m2', 'c1', '2026-06-11T00:00:00Z', 'sideways', 'text', 'x', 'live')`,
    )).toThrow()
  })

  it('events accepts the new threads_extracted kind and still accepts old kinds', () => {
    const db = openTestDb()
    db.exec(`INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning)
             VALUES ('e1', 'c1', '2026-06-11T00:00:00Z', 'threads_extracted', 'introspect', 'r')`)
    db.exec(`INSERT INTO events(id, chat_id, ts, kind, trigger, reasoning)
             VALUES ('e2', 'c1', '2026-06-11T00:00:00Z', 'observation_written', 'cron', 'r')`)
    expect(db.query('SELECT COUNT(*) c FROM events').get()).toEqual({ c: 2 })
  })

  it('events rows survive the CHECK rebuild', () => {
    // openTestDb 跑全部 migrations,等价于老库升级后再查 —— 这里验证重建后
    // 旧 kind 仍可插入即可;真实数据保留由 INSERT INTO ... SELECT 保证。
    const db = openTestDb()
    const cols = db.query(`SELECT name FROM pragma_table_info('events')`).all() as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('observation_id')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```
bun --bun vitest run src/lib/db.test.ts
```
预期:FAIL,`no such table: messages`。

- [ ] **Step 3: 实现 migration**

在 `src/lib/db.ts` 的 `migrations` 数组**末尾**追加:

```ts
  // vN — dialogue real data: canonical messages store, topic threads,
  // extraction watermark; events gains 'threads_extracted' kind (CHECK
  // constraints can't be altered in SQLite → rebuild events in place).
  // Spec: docs/superpowers/specs/2026-06-11-dialogue-real-data-design.md
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id        TEXT PRIMARY KEY NOT NULL,
        chat_id   TEXT NOT NULL,
        ts        TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        kind      TEXT NOT NULL DEFAULT 'text',
        text      TEXT NOT NULL,
        provider  TEXT,
        source    TEXT NOT NULL DEFAULT 'live'
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts);

      CREATE TABLE IF NOT EXISTS threads (
        id          TEXT PRIMARY KEY NOT NULL,
        chat_id     TEXT NOT NULL,
        title       TEXT NOT NULL,
        summary     TEXT NOT NULL DEFAULT '',
        facets      TEXT NOT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        private     INTEGER NOT NULL DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','done')),
        episodes    TEXT NOT NULL DEFAULT '[]',
        created_ts  TEXT NOT NULL,
        last_active TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_threads_chat ON threads(chat_id, last_active);

      CREATE TABLE IF NOT EXISTS thread_extract_state (
        chat_id         TEXT PRIMARY KEY NOT NULL,
        extracted_to_ts TEXT NOT NULL
      ) STRICT;
    `)
    // events CHECK 重建:新建 → 拷贝 → 换名。列集与既有 schema 一致,仅 kind 集合扩大。
    db.exec(`
      CREATE TABLE events_new (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'cron_eval_pushed', 'cron_eval_skipped', 'cron_eval_failed',
          'observation_written', 'milestone',
          'memory_deleted', 'threads_extracted'
        )),
        trigger TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        push_text TEXT,
        observation_id TEXT,
        milestone_id TEXT,
        jsonl_session_id TEXT,
        memory_path TEXT
      ) STRICT;
      INSERT INTO events_new SELECT * FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
    `)
  },
```

- [ ] **Step 4: 跑测试确认通过**

```
bun --bun vitest run src/lib/db.test.ts
```
预期:PASS(全部既有 + 新增用例)。

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts src/lib/db.test.ts
git commit -m "feat(db): messages/threads/thread_extract_state tables + events threads_extracted kind"
```

---

### Task 2: messages store

**Files:**
- Create: `src/daemon/messages/store.ts`
- Test: `src/daemon/messages/store.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeMessagesStore, inboundMessageId } from './store'

describe('messages store', () => {
  it('append + listRange returns rows in ts order', async () => {
    const s = makeMessagesStore(openTestDb())
    await s.append({ id: 'b', chatId: 'c1', ts: '2026-06-11T00:01:00Z', direction: 'out', kind: 'text', text: 'world', provider: 'claude', source: 'live' })
    await s.append({ id: 'a', chatId: 'c1', ts: '2026-06-11T00:00:00Z', direction: 'in', kind: 'text', text: 'hello', source: 'live' })
    const rows = await s.listRange('c1', { limit: 10 })
    expect(rows.map(r => r.text)).toEqual(['hello', 'world'])
  })

  it('append is idempotent on id (INSERT OR IGNORE)', async () => {
    const s = makeMessagesStore(openTestDb())
    const rec = { id: 'dup', chatId: 'c1', ts: '2026-06-11T00:00:00Z', direction: 'in' as const, kind: 'text', text: 'x', source: 'live' }
    await s.append(rec)
    await s.append(rec)
    expect((await s.listRange('c1', { limit: 10 })).length).toBe(1)
  })

  it('listRange pages backwards with beforeTs', async () => {
    const s = makeMessagesStore(openTestDb())
    for (let i = 0; i < 5; i++)
      await s.append({ id: `m${i}`, chatId: 'c1', ts: `2026-06-11T00:0${i}:00Z`, direction: 'in', kind: 'text', text: `t${i}`, source: 'live' })
    const page = await s.listRange('c1', { limit: 2, beforeTs: '2026-06-11T00:03:00Z' })
    expect(page.map(r => r.text)).toEqual(['t1', 't2'])  // 紧邻 beforeTs 之前的两条,升序
  })

  it('search matches text within one chat only', async () => {
    const s = makeMessagesStore(openTestDb())
    await s.append({ id: '1', chatId: 'c1', ts: '2026-06-11T00:00:00Z', direction: 'in', kind: 'text', text: 'compass 排产计划', source: 'live' })
    await s.append({ id: '2', chatId: 'c2', ts: '2026-06-11T00:00:00Z', direction: 'in', kind: 'text', text: '排产无关', source: 'live' })
    const hits = await s.search('c1', '排产', 10)
    expect(hits.length).toBe(1)
    expect(hits[0]!.id).toBe('1')
  })

  it('latestTs returns newest ts or null', async () => {
    const s = makeMessagesStore(openTestDb())
    expect(await s.latestTs('c1')).toBeNull()
    await s.append({ id: '1', chatId: 'c1', ts: '2026-06-11T00:05:00Z', direction: 'in', kind: 'text', text: 'x', source: 'live' })
    expect(await s.latestTs('c1')).toBe('2026-06-11T00:05:00Z')
  })

  it('inboundMessageId mirrors the dedupe key', () => {
    expect(inboundMessageId('u@im.wechat', 1780000000000)).toBe('u@im.wechat:1780000000000')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```
bun --bun vitest run src/daemon/messages/store.test.ts
```
预期:FAIL,模块不存在。

- [ ] **Step 3: 实现 store**

`src/daemon/messages/store.ts`(对齐 `observations/store.ts` 的工厂 + prepared statement 风格):

```ts
/**
 * messages store — canonical per-chat conversation log (spec D4).
 * Written by mw-messages (inbound) + ilink-glue (outbound) + backfill.
 * Read by `wechat-cc dialogue *` CLI and the threads extractor.
 */
import type { Db } from '../../lib/db'

export type MessageDirection = 'in' | 'out'

export interface MessageRecord {
  id: string
  chatId: string
  ts: string
  direction: MessageDirection
  kind: string          // text | image | file | voice | command
  text: string
  provider?: string
  source: string        // live | backfill:claude | backfill:codex
}

export interface ListRangeOpts {
  limit: number
  /** 取该时间点(不含)之前的最后 limit 条,升序返回 —— 向上翻页。缺省 = 最新一页。 */
  beforeTs?: string
}

export interface MessagesStore {
  append(rec: MessageRecord): Promise<void>
  listRange(chatId: string, opts: ListRangeOpts): Promise<MessageRecord[]>
  search(chatId: string, query: string, limit: number): Promise<MessageRecord[]>
  latestTs(chatId: string): Promise<string | null>
  /** 抽取器输入:某水位之后的所有消息,升序。 */
  listSince(chatId: string, sinceTs: string, limit: number): Promise<MessageRecord[]>
}

export function inboundMessageId(userId: string, createTimeMs: number): string {
  return `${userId}:${createTimeMs}`
}

interface Row {
  id: string; chat_id: string; ts: string; direction: string
  kind: string; text: string; provider: string | null; source: string
}

function rowToRecord(r: Row): MessageRecord {
  return {
    id: r.id, chatId: r.chat_id, ts: r.ts,
    direction: r.direction as MessageDirection,
    kind: r.kind, text: r.text, source: r.source,
    ...(r.provider !== null ? { provider: r.provider } : {}),
  }
}

export function makeMessagesStore(db: Db): MessagesStore {
  const stmtInsert = db.query(
    `INSERT OR IGNORE INTO messages(id, chat_id, ts, direction, kind, text, provider, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  return {
    async append(rec) {
      stmtInsert.run(rec.id, rec.chatId, rec.ts, rec.direction, rec.kind, rec.text, rec.provider ?? null, rec.source)
    },
    async listRange(chatId, opts) {
      const rows = (opts.beforeTs
        ? db.query<Row, [string, string, number]>(
            `SELECT * FROM (
               SELECT * FROM messages WHERE chat_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?
             ) ORDER BY ts ASC`,
          ).all(chatId, opts.beforeTs, opts.limit)
        : db.query<Row, [string, number]>(
            `SELECT * FROM (
               SELECT * FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT ?
             ) ORDER BY ts ASC`,
          ).all(chatId, opts.limit))
      return rows.map(rowToRecord)
    },
    async search(chatId, query, limit) {
      const rows = db.query<Row, [string, string, number]>(
        `SELECT * FROM messages WHERE chat_id = ? AND text LIKE '%' || ? || '%'
         ORDER BY ts DESC LIMIT ?`,
      ).all(chatId, query, limit)
      return rows.map(rowToRecord)
    },
    async latestTs(chatId) {
      const r = db.query<{ ts: string }, [string]>(
        'SELECT ts FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT 1',
      ).get(chatId)
      return r?.ts ?? null
    },
    async listSince(chatId, sinceTs, limit) {
      const rows = db.query<Row, [string, string, number]>(
        'SELECT * FROM messages WHERE chat_id = ? AND ts > ? ORDER BY ts ASC LIMIT ?',
      ).all(chatId, sinceTs, limit)
      return rows.map(rowToRecord)
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```
bun --bun vitest run src/daemon/messages/store.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/daemon/messages/
git commit -m "feat(messages): canonical messages store — append/listRange/search/listSince"
```

---

### Task 3: inbound 落库 — mw-messages middleware

**Files:**
- Create: `src/daemon/inbound/mw-messages.ts`
- Test: `src/daemon/inbound/mw-messages.test.ts`
- Modify: `src/daemon/inbound/build.ts`(管线注册)+ 其 deps 接口
- Modify: `src/daemon/wiring/` 中构造 `buildInbound` deps 的调用点(grep `activity:` 同位注入;构造 `makeMessagesStore(db)` 已有 db 实例)

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { makeMwMessages } from './mw-messages'
import type { InboundCtx } from './types'

function ctx(text: string, consumed?: InboundCtx['consumedBy']): InboundCtx {
  return {
    msg: { chatId: 'c1', userId: 'u1', text, msgType: 'text', createTimeMs: 1780000000000, accountId: 'a1' } as InboundCtx['msg'],
    receivedAtMs: 1780000000500,
    requestId: 'r1',
    ...(consumed ? { consumedBy: consumed } : {}),
  }
}

describe('mw-messages', () => {
  it('records inbound text before next() so consumed commands still land', async () => {
    const appended: Array<Record<string, unknown>> = []
    const mw = makeMwMessages({
      append: async rec => { appended.push(rec as unknown as Record<string, unknown>) },
      log: () => {},
    })
    // next() 模拟 admin 消费该消息
    const c = ctx('/health')
    await mw(c, async () => { c.consumedBy = 'admin' })
    expect(appended.length).toBe(1)
    expect(appended[0]).toMatchObject({ id: 'u1:1780000000000', kind: 'command', direction: 'in', text: '/health' })
  })

  it('plain text records kind=text', async () => {
    const appended: Array<Record<string, unknown>> = []
    const mw = makeMwMessages({ append: async rec => { appended.push(rec as never) }, log: () => {} })
    await mw(ctx('你好'), async () => {})
    expect(appended[0]).toMatchObject({ kind: 'text', text: '你好' })
  })

  it('append failure logs but does not break the pipeline', async () => {
    const logs: string[] = []
    const mw = makeMwMessages({
      append: async () => { throw new Error('disk full') },
      log: (_tag, line) => { logs.push(line) },
    })
    let nextRan = false
    await mw(ctx('hi'), async () => { nextRan = true })
    expect(nextRan).toBe(true)
    expect(logs.join(' ')).toContain('disk full')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```
bun --bun vitest run src/daemon/inbound/mw-messages.test.ts
```

- [ ] **Step 3: 实现 middleware**

`src/daemon/inbound/mw-messages.ts`:

```ts
/**
 * mw-messages — mirror every allow-listed inbound message into the
 * canonical messages table (spec D4). Runs BEFORE next() so messages
 * consumed by command routing (admin / mode / onboarding) still land,
 * with kind='command'. Placed after access (denied senders never reach
 * here) — see build.ts ordering.
 */
import type { Middleware } from './types'
import type { MessageRecord } from '../messages/store'
import { inboundMessageId } from '../messages/store'

export interface MessagesMwDeps {
  append(rec: MessageRecord): Promise<void>
  log: (tag: string, line: string) => void
}

export function makeMwMessages(deps: MessagesMwDeps): Middleware {
  return async (ctx, next) => {
    const when = new Date(ctx.msg.createTimeMs || ctx.receivedAtMs)
    const rec: MessageRecord = {
      id: inboundMessageId(ctx.msg.userId, ctx.msg.createTimeMs || ctx.receivedAtMs),
      chatId: ctx.msg.chatId,
      ts: when.toISOString(),
      direction: 'in',
      kind: ctx.msg.text.startsWith('/') ? 'command'
        : ctx.msg.msgType !== 'text' ? ctx.msg.msgType
        : 'text',
      text: ctx.msg.text,
      source: 'live',
    }
    try { await deps.append(rec) } catch (err) {
      deps.log('MESSAGES', `inbound record failed for ${ctx.msg.chatId}: ${err instanceof Error ? err.message : err}`)
    }
    await next()
  }
}
```

- [ ] **Step 4: 注册进管线**

`src/daemon/inbound/build.ts`:在 deps 接口加 `messages: MessagesMwDeps`,管线里 **`makeMwAccess(d.access)` 之后、`makeMwCaptureCtx` 之前**插入 `makeMwMessages(d.messages)`。wiring 构造处(grep `activity:` 的同一个对象字面量)加:

```ts
messages: {
  append: rec => messagesStore.append(rec),   // messagesStore = makeMessagesStore(db),与 activity 同处构造
  log: deps.log,
},
```

- [ ] **Step 5: 单测 + 既有 e2e 全绿**

```
bun --bun vitest run src/daemon/inbound/ && bun --bun vitest run -c vitest.e2e.config.ts
```
预期:PASS(e2e harness 走真 bootstrap,新 middleware 生效不破坏既有断言)。

- [ ] **Step 6: 追加 e2e 断言(messages 真落库)**

在 `src/daemon/__e2e__/` 新建 `messages-record.e2e.test.ts`:起 harness(参考 `dispatch-solo-codex.e2e.test.ts` 的最小形态),`daemon.sendText('chat1', '你好')` + `waitForReplyTo` 后,用 harness 的 stateDir 打开 db(`openWechatDb(stateDir)`)断言 `messages` 含 1 条 `direction='in'`。跑过。

- [ ] **Step 7: Commit**

```bash
git add src/daemon/inbound/ src/daemon/wiring/ src/daemon/__e2e__/messages-record.e2e.test.ts
git commit -m "feat(messages): record inbound via mw-messages (commands included, kind tagged)"
```

---

### Task 4: outbound 落库 — ilink-glue 发送成功后记录

**Files:**
- Modify: `src/daemon/ilink-glue.ts:193` 附近(`sendReplyOnce` 成功路径)
- Test: e2e 追加断言(`messages-record.e2e.test.ts`)

- [ ] **Step 1: 在 e2e 测试追加失败断言**

`messages-record.e2e.test.ts` 中,bot 回复送达后断言 db 有 `direction='out'` 行且 `text` 等于 fake provider 的回复文本、`provider` 字段非空。跑,预期 FAIL(只有 in)。

- [ ] **Step 2: 实现**

`ilink-glue.ts` 的发送函数(193 行 `const result = await sendReplyOnce(chatId, text, stateDir)` 所在函数)注入 `messagesStore`(从构造该模块的 wiring 传入,同 db 实例),成功分支追加:

```ts
if (result.ok) {
  void messagesStore.append({
    id: `out:${chatId}:${Date.now()}:${outSeq++}`,   // outSeq: module-level counter,防同毫秒撞 id
    chatId,
    ts: new Date().toISOString(),
    direction: 'out',
    kind: 'text',
    text,
    provider: providerId ?? undefined,   // 该调用点已有 provider 上下文;没有则 undefined
    source: 'live',
  }).catch(err => log('MESSAGES', `outbound record failed: ${err instanceof Error ? err.message : err}`))
}
```

注意:`ilink-glue.ts:127` 的 expired-notify 路径是系统通知,**不**记录(非对话内容)。`fallback-reply.ts` 与 CLI `wechat-cc reply` 不在 daemon 进程,不落库(v1 接受,避免 CLI 进程写 WAL 与 daemon 抢写)。

- [ ] **Step 3: e2e 转绿 + Commit**

```bash
bun --bun vitest run -c vitest.e2e.config.ts messages-record
git add src/daemon/ilink-glue.ts src/daemon/__e2e__/messages-record.e2e.test.ts src/daemon/wiring/
git commit -m "feat(messages): record outbound replies at the ilink-glue send path"
```

---

### Task 5: 回填 CLI — `wechat-cc dialogue backfill`

**Files:**
- Create: `src/cli/dialogue.ts`(本任务先实现 backfill;Task 9 在同文件加查询命令)
- Test: `src/cli/dialogue.test.ts`
- Modify: `cli.ts`(注册 `dialogue` 命名空间,仿 `daemonA2A` 的 subCommands 模式)

- [ ] **Step 1: 写失败测试(解析与幂等,纯函数层)**

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openTestDb } from '../lib/db'
import { backfillFromClaudeJsonl, claudeTurnToMessages } from './dialogue'

describe('dialogue backfill', () => {
  it('claudeTurnToMessages maps user/assistant turns to in/out records', () => {
    const recs = claudeTurnToMessages(
      { type: 'user', ts: '2026-06-01T00:00:00Z', text: '你好' },
      'chat1', 'sess1', 0,
    )
    expect(recs[0]).toMatchObject({ chatId: 'chat1', direction: 'in', text: '你好', source: 'backfill:claude', id: 'bf:claude:sess1:0' })
  })

  it('backfill is idempotent — second run adds nothing', async () => {
    const db = openTestDb()
    const dir = mkdtempSync(join(tmpdir(), 'bf-'))
    writeFileSync(join(dir, 's1.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: '第一句' }, timestamp: '2026-06-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '回复' }] }, timestamp: '2026-06-01T00:00:05Z' }),
    ].join('\n'))
    const r1 = await backfillFromClaudeJsonl(db, dir, 'chat1')
    const r2 = await backfillFromClaudeJsonl(db, dir, 'chat1')
    expect(r1.inserted).toBe(2)
    expect(r2.inserted).toBe(0)
    expect(db.query('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 2 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败,然后实现**

`src/cli/dialogue.ts` 核心(JSONL 行解析格式以 `sessions read-jsonl` 既有实现为准 —— 实现本任务时先读 `src/cli/` 中该命令的解析代码并复用其行→turn 函数;若不可直接复用,以下独立实现):

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../lib/db'
import { makeMessagesStore, type MessageRecord } from '../daemon/messages/store'

export interface SimpleTurn { type: 'user' | 'assistant'; ts: string; text: string }

export function claudeTurnToMessages(turn: SimpleTurn, chatId: string, sessionKey: string, idx: number): MessageRecord[] {
  return [{
    id: `bf:claude:${sessionKey}:${idx}`,
    chatId, ts: turn.ts,
    direction: turn.type === 'user' ? 'in' : 'out',
    kind: 'text', text: turn.text,
    ...(turn.type === 'assistant' ? { provider: 'claude' } : {}),
    source: 'backfill:claude',
  }]
}

function parseClaudeJsonlLine(line: string): SimpleTurn | null {
  try {
    const o = JSON.parse(line) as Record<string, unknown>
    const ts = typeof o.timestamp === 'string' ? o.timestamp : null
    if (!ts) return null
    if (o.type === 'user') {
      const m = o.message as { content?: unknown } | undefined
      const text = typeof m?.content === 'string' ? m.content : null
      return text ? { type: 'user', ts, text } : null
    }
    if (o.type === 'assistant') {
      const m = o.message as { content?: Array<{ type: string; text?: string }> } | undefined
      const text = (m?.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
      return text ? { type: 'assistant', ts, text } : null
    }
    return null
  } catch { return null }
}

export async function backfillFromClaudeJsonl(db: Db, dir: string, chatId: string, dryRun = false): Promise<{ scanned: number; inserted: number }> {
  const store = makeMessagesStore(db)
  let scanned = 0, inserted = 0
  for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    const sessionKey = f.replace(/\.jsonl$/, '')
    const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)
    let idx = 0
    for (const line of lines) {
      const turn = parseClaudeJsonlLine(line)
      idx++
      if (!turn) continue
      scanned++
      if (dryRun) continue
      const before = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM messages').get()!.c
      for (const rec of claudeTurnToMessages(turn, chatId, sessionKey, idx)) await store.append(rec)
      const after = db.query<{ c: number }, []>('SELECT COUNT(*) c FROM messages').get()!.c
      inserted += after - before
    }
  }
  return { scanned, inserted }
}
```

codex 源:同构函数 `backfillFromCodexJsonl`,用 `readCodexJsonlAsClaudeTurns`(`src/daemon/sessions/codex-jsonl.ts`)把 rollout 转成 ClaudeShapeTurn 再走同一映射,id 前缀 `bf:codex:`,source `backfill:codex`。

CLI command(`cli.ts` 注册,目录定位:claude 的 session JSONL 目录按 `sessions read-jsonl` 现行实现的同一路径推导;`--chat-id` 缺省 = `access.json` 唯一 admin,多 admin 时要求显式传参并报错提示):

```ts
const dialogueBackfillCmd = defineCommand({
  meta: { name: 'backfill', description: 'Import history from agent session JSONLs into the messages table' },
  args: {
    'chat-id': { type: 'string', description: 'attribute history to this chat (default: sole admin)' },
    'dry-run': { type: 'boolean', default: false },
  },
  async run({ args }) { /* resolve dirs → run both backfills → print {scanned, inserted} per source */ },
})
```

- [ ] **Step 3: 测试通过 + 手动 dry-run 验证**

```
bun --bun vitest run src/cli/dialogue.test.ts
bun cli.ts dialogue backfill --dry-run
```
预期:dry-run 打印各源 scanned 数,inserted 0。

- [ ] **Step 4: Commit**

```bash
git add src/cli/dialogue.ts src/cli/dialogue.test.ts cli.ts
git commit -m "feat(cli): dialogue backfill — import claude/codex session history into messages"
```

---

### Task 6: threads store

**Files:**
- Create: `src/daemon/threads/store.ts`
- Test: `src/daemon/threads/store.test.ts`

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeThreadsStore } from './store'

describe('threads store', () => {
  it('create + list returns thread with parsed facets/tags', async () => {
    const s = makeThreadsStore(openTestDb())
    await s.create({ chatId: 'c1', title: 'compass 排产', summary: '排产改造', facets: ['task'], tags: ['compass'], private: false, episodes: [{ from_ts: 'a', to_ts: 'b' }] })
    const all = await s.list('c1')
    expect(all.length).toBe(1)
    expect(all[0]).toMatchObject({ title: 'compass 排产', facets: ['task'], tags: ['compass'], status: 'active' })
  })

  it('update merges fields and bumps last_active', async () => {
    const s = makeThreadsStore(openTestDb())
    const id = await s.create({ chatId: 'c1', title: 't', summary: '', facets: ['life'], tags: [], private: true, episodes: [] })
    await s.update(id, { status: 'done', tags: ['股票'], lastActive: '2026-06-12T00:00:00Z' })
    const t = (await s.list('c1'))[0]!
    expect(t.status).toBe('done')
    expect(t.tags).toEqual(['股票'])
    expect(t.private).toBe(true)
  })

  it('tagVocabulary returns tags by frequency across chats', async () => {
    const s = makeThreadsStore(openTestDb())
    await s.create({ chatId: 'c1', title: 'a', summary: '', facets: ['task'], tags: ['compass', '排产'], private: false, episodes: [] })
    await s.create({ chatId: 'c2', title: 'b', summary: '', facets: ['task'], tags: ['compass'], private: false, episodes: [] })
    expect((await s.tagVocabulary(10))[0]).toBe('compass')
  })

  it('watermark get/set roundtrip', async () => {
    const s = makeThreadsStore(openTestDb())
    expect(await s.getWatermark('c1')).toBeNull()
    await s.setWatermark('c1', '2026-06-11T00:00:00Z')
    expect(await s.getWatermark('c1')).toBe('2026-06-11T00:00:00Z')
  })
})
```

- [ ] **Step 2: 实现**

`src/daemon/threads/store.ts`:`ThreadRecord { id, chatId, title, summary, facets: Facet[], tags: string[], private: boolean, status, episodes: Array<{from_ts,to_ts}>, createdTs, lastActive }`,`Facet = 'task' | 'knowledge' | 'life'`。方法:`create`(生成 `thr_` id + created/last_active=now)、`update(id, partial)`(只 SET 传入字段;`lastActive` 显式传入)、`list(chatId)`(last_active DESC)、`get(id)`、`tagVocabulary(n)`(SQL:`SELECT value FROM threads, json_each(threads.tags) GROUP BY value ORDER BY COUNT(*) DESC LIMIT ?`)、`getWatermark/setWatermark`(`thread_extract_state` 表,`INSERT ... ON CONFLICT(chat_id) DO UPDATE`)。JSON 列序列化/解析集中在 rowToRecord/serialize 两个函数。

- [ ] **Step 3: 测试通过 + Commit**

```bash
bun --bun vitest run src/daemon/threads/store.test.ts
git add src/daemon/threads/
git commit -m "feat(threads): threads store with facets/tags/episodes + extraction watermark"
```

---

### Task 7: 抽取 prompt — 构建与防御性解析

**Files:**
- Create: `src/daemon/threads/extract-prompt.ts`
- Test: `src/daemon/threads/extract-prompt.test.ts`

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { buildExtractPrompt, parseExtractResponse } from './extract-prompt'

describe('extract prompt', () => {
  it('prompt embeds new messages, existing threads and tag vocabulary', () => {
    const p = buildExtractPrompt({
      newMessages: [{ ts: '2026-06-11T00:00:00Z', direction: 'in', text: '排产又要改' }],
      existingThreads: [{ id: 'thr_1', title: 'compass 排产', facets: ['task'], tags: ['compass'], summary: '' }],
      tagVocabulary: ['compass', '股票'],
    })
    expect(p).toContain('排产又要改')
    expect(p).toContain('thr_1')
    expect(p).toContain('compass')
    // 升格门槛(D6)与 tag 纪律(D7)必须写进 prompt
    expect(p).toMatch(/反复出现|第二次/)
    expect(p).toMatch(/复用|已有 tag/)
  })

  it('parses ops from a fenced json response', () => {
    const ops = parseExtractResponse('```json\n{"ops":[{"op":"create","title":"股票观察","facets":["life"],"tags":["股票"],"private":false,"summary":"s","episode":{"from_ts":"a","to_ts":"b"}}]}\n```')
    expect(ops).toEqual([expect.objectContaining({ op: 'create', title: '股票观察' })])
  })

  it('rejects malformed responses with null (never throws)', () => {
    expect(parseExtractResponse('not json at all')).toBeNull()
    expect(parseExtractResponse('{"ops": "nope"}')).toBeNull()
    // 非法 facet 整批拒绝 —— 宁可这轮不动,不写脏数据
    expect(parseExtractResponse('{"ops":[{"op":"create","title":"x","facets":["mood"]}]}')).toBeNull()
  })

  it('accepts update/touch ops referencing existing ids', () => {
    const ops = parseExtractResponse('{"ops":[{"op":"touch","id":"thr_1","episode":{"from_ts":"a","to_ts":"b"}},{"op":"update","id":"thr_1","status":"done"}]}')
    expect(ops?.length).toBe(2)
  })
})
```

- [ ] **Step 2: 实现**

`extract-prompt.ts`:
- `ExtractOp = { op:'create', title, summary, facets, tags, private, episode } | { op:'update', id, ...partial } | { op:'touch', id, episode }`
- `buildExtractPrompt(input)`:中文 prompt,信息块依次为已有线索摘要(id+title+facets+tags)、tag 词表、新增消息(ts/方向/文本,截断单条 >500 字)。规则段落写明:**升格门槛**(只为"已有线索又出现的内容"touch/update;新建仅当"该话题在本片段中 ≥10 轮深入讨论"或"已有线索列表外的话题明显是再次出现"——单次寥寥数语不建);**tag 纪律**(优先复用词表、每线索 ≤3、新造需明显反复);**私密初判**(情绪/私人生活倾向 → private:true);输出要求 = 仅一个 JSON 对象 `{"ops":[...]}`,没有可做的就 `{"ops":[]}`。
- `parseExtractResponse(raw)`:剥 ```json fence → JSON.parse(try/catch)→ zod 校验(`facets ⊆ ['task','knowledge','life']`、op 枚举、create 必填 title/facets)。任何一处不合法 → 返回 null。

- [ ] **Step 3: 测试通过 + Commit**

```bash
bun --bun vitest run src/daemon/threads/extract-prompt.test.ts
git add src/daemon/threads/extract-prompt*
git commit -m "feat(threads): extraction prompt builder + defensive response parser"
```

---

### Task 8: 抽取 runtime + introspect tick 集成

**Files:**
- Create: `src/daemon/threads/extractor.ts`
- Test: `src/daemon/threads/extractor.test.ts`
- Modify: `src/daemon/wiring/tick-bodies.ts:163` 附近(introspect tick 体内追加调用)
- Test: `src/daemon/__e2e__/threads-extract.e2e.test.ts`

- [ ] **Step 1: 失败测试(runtime 纯逻辑,fake sdkEval)**

```ts
import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeMessagesStore } from '../messages/store'
import { makeThreadsStore } from './store'
import { runThreadsExtraction } from './extractor'

function setup() {
  const db = openTestDb()
  return { db, messages: makeMessagesStore(db), threads: makeThreadsStore(db) }
}

describe('threads extractor', () => {
  it('applies create ops and advances watermark to last message ts', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T01:00:00Z', direction: 'in', kind: 'text', text: '排产', source: 'live' })
    const res = await runThreadsExtraction({
      chatId: 'c1', messages, threads, log: () => {},
      recordEvent: async () => {},
      sdkEval: async () => '{"ops":[{"op":"create","title":"排产","summary":"s","facets":["task"],"tags":[],"private":false,"episode":{"from_ts":"2026-06-11T01:00:00Z","to_ts":"2026-06-11T01:00:00Z"}}]}',
    })
    expect(res.applied).toBe(1)
    expect((await threads.list('c1')).length).toBe(1)
    expect(await threads.getWatermark('c1')).toBe('2026-06-11T01:00:00Z')
  })

  it('no new messages → skips eval entirely', async () => {
    const { messages, threads } = setup()
    let evalCalls = 0
    await runThreadsExtraction({ chatId: 'c1', messages, threads, log: () => {}, recordEvent: async () => {}, sdkEval: async () => { evalCalls++; return '{"ops":[]}' } })
    expect(evalCalls).toBe(0)
  })

  it('parse failure → watermark does NOT advance (retry next tick)', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T01:00:00Z', direction: 'in', kind: 'text', text: 'x', source: 'live' })
    await runThreadsExtraction({ chatId: 'c1', messages, threads, log: () => {}, recordEvent: async () => {}, sdkEval: async () => 'garbage' })
    expect(await threads.getWatermark('c1')).toBeNull()
  })

  it('update op on unknown id is skipped, others still apply', async () => {
    const { messages, threads } = setup()
    await messages.append({ id: '1', chatId: 'c1', ts: '2026-06-11T01:00:00Z', direction: 'in', kind: 'text', text: 'x', source: 'live' })
    const res = await runThreadsExtraction({
      chatId: 'c1', messages, threads, log: () => {}, recordEvent: async () => {},
      sdkEval: async () => '{"ops":[{"op":"touch","id":"thr_ghost","episode":{"from_ts":"a","to_ts":"b"}},{"op":"create","title":"y","summary":"","facets":["life"],"tags":[],"private":false,"episode":{"from_ts":"a","to_ts":"b"}}]}',
    })
    expect(res.applied).toBe(1)
    expect(res.skipped).toBe(1)
  })
})
```

- [ ] **Step 2: 实现 runtime**

`src/daemon/threads/extractor.ts`:

```ts
/**
 * threads extractor — one isolated eval per introspect tick (spec D3).
 * Incremental: reads messages after the per-chat watermark, asks the
 * cheap model for thread ops, applies them, advances the watermark.
 * Parse failure → no watermark advance → retried next tick.
 */
import type { MessagesStore } from '../messages/store'
import type { ThreadsStore } from './store'
import { buildExtractPrompt, parseExtractResponse } from './extract-prompt'

const BATCH_LIMIT = 500   // 单轮最多消化 500 条;更多留给下一轮(水位推进到本批末)

export interface ExtractorDeps {
  chatId: string
  messages: MessagesStore
  threads: ThreadsStore
  sdkEval: (prompt: string) => Promise<string>
  recordEvent: (reasoning: string) => Promise<void>   // events kind=threads_extracted
  log: (tag: string, line: string) => void
}

export async function runThreadsExtraction(deps: ExtractorDeps): Promise<{ applied: number; skipped: number }> {
  const since = (await deps.threads.getWatermark(deps.chatId)) ?? '1970-01-01T00:00:00Z'
  const batch = await deps.messages.listSince(deps.chatId, since, BATCH_LIMIT)
  if (batch.length === 0) return { applied: 0, skipped: 0 }

  const existing = await deps.threads.list(deps.chatId)
  const prompt = buildExtractPrompt({
    newMessages: batch.map(m => ({ ts: m.ts, direction: m.direction, text: m.text })),
    existingThreads: existing.map(t => ({ id: t.id, title: t.title, facets: t.facets, tags: t.tags, summary: t.summary })),
    tagVocabulary: await deps.threads.tagVocabulary(30),
  })
  const raw = await deps.sdkEval(prompt)
  const ops = parseExtractResponse(raw)
  if (ops === null) {
    deps.log('THREADS', `extract parse failed for ${deps.chatId}; watermark held at ${since}`)
    return { applied: 0, skipped: 0 }
  }

  let applied = 0, skipped = 0
  const lastTs = batch[batch.length - 1]!.ts
  for (const op of ops) {
    if (op.op === 'create') {
      await deps.threads.create({ chatId: deps.chatId, title: op.title, summary: op.summary, facets: op.facets, tags: op.tags, private: op.private, episodes: [op.episode] })
      applied++
    } else {
      const t = await deps.threads.get(op.id)
      if (!t) { skipped++; continue }
      if (op.op === 'touch') {
        await deps.threads.update(op.id, { episodes: [...t.episodes, op.episode], lastActive: lastTs })
      } else {
        await deps.threads.update(op.id, { ...op, lastActive: lastTs })
      }
      applied++
    }
  }
  await deps.threads.setWatermark(deps.chatId, lastTs)
  await deps.recordEvent(`batch=${batch.length} ops=${ops.length} applied=${applied} skipped=${skipped}`)
  return { applied, skipped }
}
```

- [ ] **Step 3: tick 集成**

`src/daemon/wiring/tick-bodies.ts` introspect tick 体(163 行 `runIntrospectTick` 之后)追加 —— 独立 try/catch,失败不影响 observation 流;`sdkEval` 复用 introspect agent 的同一注入(同 haiku 单次调用构造);`recordEvent` 写 events 表 kind=`threads_extracted`、trigger=`introspect`:

```ts
try {
  await runThreadsExtraction({ chatId, messages: messagesStore, threads: threadsStore, sdkEval, recordEvent, log: deps.log })
} catch (err) {
  deps.log('THREADS', `extraction failed: ${err instanceof Error ? err.message : err}`)
}
```

- [ ] **Step 4: e2e(fake eval 注入路径与 introspect e2e 同款)**

`threads-extract.e2e.test.ts`:harness 起 daemon → 发几条消息 → 手动触发 introspect tick(harness 已有该入口;没有则调 `runIntrospectOnce` 暴露的测试钩子)→ 断言 threads 表有行、events 有 `threads_extracted`。fake sdkEval 返回一条 create op。

- [ ] **Step 5: 全部测试 + Commit**

```bash
bun --bun vitest run src/daemon/threads/ && bun --bun vitest run -c vitest.e2e.config.ts threads-extract
git add src/daemon/threads/ src/daemon/wiring/tick-bodies.ts src/daemon/__e2e__/threads-extract.e2e.test.ts
git commit -m "feat(threads): incremental extraction on the introspect tick — watermark, ops, events"
```

---

### Task 9: 查询 CLI — `dialogue timeline / threads / search / thread-detail`

**Files:**
- Modify: `src/cli/dialogue.ts` + `cli.ts`(subCommands 补全)
- Test: `src/cli/dialogue.test.ts` 追加

- [ ] **Step 1: 失败测试**

对每个命令测纯函数层(传 openTestDb,断言 JSON 形状):
- `dialogueTimeline(db, chatId, {limit, beforeTs})` → `{ messages: MessageRecord[], hasMore: boolean }`(hasMore = 取 limit+1 判断)
- `dialogueThreads(db, chatId, {facet?, includePrivate})` → `{ threads: [...] }`(facet 过滤用 `json_each(facets)`;`includePrivate=false` 时滤掉 private)
- `dialogueSearch(db, chatId, q, limit)` → `{ hits: [...] }`
- `dialogueThreadDetail(db, id)` → `{ thread, episodes: [{from_ts, to_ts, messages: [...]}] }`(每段 episode 取区间内消息,上限 200 条/段)

- [ ] **Step 2: 实现 + 注册**

`cli.ts` 增加(置于 sessions 命名空间旁):

```ts
const dialogueCmd = defineCommand({
  meta: { name: 'dialogue', description: 'Dialogue page data — timeline / threads / search / backfill' },
  subCommands: { timeline: dialogueTimelineCmd, threads: dialogueThreadsCmd, search: dialogueSearchCmd, 'thread-detail': dialogueThreadDetailCmd, backfill: dialogueBackfillCmd },
})
```

各命令统一 `--json` 输出(桌面端唯一消费方),`--chat-id` 必填(timeline/threads/search)。db 以 `openWechatDb(STATE_DIR)` 打开(WAL 并发读安全)。

- [ ] **Step 3: 测试 + 手动验证 + Commit**

```bash
bun --bun vitest run src/cli/dialogue.test.ts
bun cli.ts dialogue timeline --chat-id <真实chatId> --json | head -3
git add src/cli/dialogue.ts src/cli/dialogue.test.ts cli.ts
git commit -m "feat(cli): dialogue query commands for the desktop page"
```

---

### Task 10: 桌面端 — dialogue-page.js 重写 + main.js 接线

**Files:**
- Rewrite: `apps/desktop/src/modules/dialogue-page.js`(删除全部 mock 数据与 `PRIVATE_PASSWORD`)
- Modify: `apps/desktop/src/main.js`(421 行 pane 切换处传 deps;移除 `modules/sessions.js` 中被取代接线的 import 与调用)
- Modify: `apps/desktop/src/index.html`(`#dialogue-root` 保留;无需静态锚点 —— 动态结构见下)
- Modify: `apps/desktop/src/styles.css`(沿用 bb47712 的 dialogue 样式类;补 `dialogue-timeline` 分页 loader 与锁态样式)

**结构契约(shim 测试与 Playwright 都以此为准):**

```
#dialogue-root
  aside.dialogue-sidebar
    #dialogue-chat-switcher        (chat 列表,sessions list-chats 数据)
    input#dialogue-search          (防抖 250ms → dialogue search)
    nav#dialogue-views             (按钮:data-view=timeline|task|knowledge|life)
    #dialogue-groups               (当前视图内容:timeline 时隐藏;facet 视图 = 线索卡列表)
  section.dialogue-stage
    #dialogue-timeline             (文档式消息流,向上滚动翻页 → timeline beforeTs)
    #dialogue-thread-detail        (hidden;线索详情:summary + episodes 渲染)
  #privacy-dialog                  (保留设计稿结构;提交校验改为 invoke dialogue 锁配置,见下)
```

- [ ] **Step 1: 重写 dialogue-page.js**

要点(完整实现,无 mock 残留):
- `initDialoguePage(deps)`:`deps.invoke` 与 sessions.js 同款注入;首次渲染骨架 DOM(上述契约),然后 `loadChats()` → 默认选第一个 chat → `loadTimeline()`。
- `loadTimeline(chatId, beforeTs?)`:`invoke('wechat_cli_json', { args: ['dialogue','timeline','--chat-id',chatId,'--json', ...(beforeTs?['--before',beforeTs]:[])] })`;渲染沿用设计稿 `dialogue-turn`/`dialogue-avatar` 类(direction in=user/out=ai;头像用真实 avatar 接口,无则首字气泡);滚到顶部且 hasMore → 取上一页插入顶部并保持滚动位置。
- facet 视图:`dialogue threads --facet task --json` → 线索卡(title/tags/status 徽标/last_active 相对时间);点击 → `thread-detail` 渲染。
- 私密:threads 响应里 private 线索默认不返回(CLI `includePrivate=false`);解锁流程 = privacy-dialog 提交 → `invoke('wechat_cli_json', {args:['dialogue','unlock','--passphrase',v,'--json']})` 校验 scrypt 哈希(`agent-config.json` 新字段 `dialogue_lock_hash`,CLI `dialogue lock set` 设置 —— 本任务一并加这两个小命令,无哈希时 UI 不显示锁区)。会话内解锁状态存模块变量,刷新即锁。
- 搜索:命中列表点击 → 切 timeline 并 `beforeTs=hit.ts` 定位加载。
- `export default` 仅 `initDialoguePage`;mock 的 `groups/conversationHtml/avatar(假名)` 全删。

- [ ] **Step 2: main.js 接线 + sessions.js 清理**

main.js:`if (name === "sessions") initDialoguePage({ invoke })`;移除 import 列表中被取代的 sessions.js 符号(`wireSearch/loadSessionsList/...` —— 保留仍被其他 pane 用到的;逐个 grep 确认无引用后从 sessions.js 删除死函数)。

- [ ] **Step 3: 手动验证(shim)**

```
cd apps/desktop && bun test-shim.ts &
# 浏览器开 http://localhost:<shim端口>,对话 tab:真实 chat 列表、时间线渲染、翻页、搜索
```
验证后**保持 shim 运行**(用户偏好:不杀 shim)。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/
git commit -m "feat(desktop): dialogue page on real data — timeline/lenses/search/privacy lock"
```

---

### Task 11: 测试对齐 — shim 锚点 + Playwright specs

**Files:**
- Modify: `apps/desktop/shim.e2e.test.ts`(锚点列表:删 `sessions-search` 等 `sessions-*` 系,改为 `dialogue-root` 静态锚点 + 动态结构断言挪到 Playwright)
- Modify: `apps/desktop/playwright/sessions-pane.spec.ts`、`sessions-multichat.spec.ts`、`interactions.spec.ts`(对齐新 DOM 契约:chat 切换、timeline 渲染、facet 视图、搜索)
- Create: `apps/desktop/playwright/dialogue-timeline.spec.ts`(翻页 + 私密锁两条 spec;mock 数据走 shim `__mockState` 机制,参考既有 specs 的 fixtures)

- [ ] **Step 1: shim 锚点改绿**

```
bun --bun vitest run apps/desktop/shim.e2e.test.ts
```

- [ ] **Step 2: Playwright 全量**

```
cd apps/desktop && bun x playwright test
```
预期:全绿(改名/重写的 specs + 新增 2 条)。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/
git commit -m "test(desktop): reconcile shim anchors + playwright specs with dialogue page"
```

---

### Task 12: 收尾验证 + 真机回填 + push

- [ ] **Step 1: 全套验证**

```
bun --bun vitest run && bun --bun vitest run -c vitest.e2e.config.ts && bun x tsc --noEmit && bun run depcheck
```
全绿才继续。

- [ ] **Step 2: 真机回填 + daemon 重启**

```
bun cli.ts dialogue backfill --dry-run        # 看 scanned 比例
bun cli.ts dialogue backfill                  # 正式导入
systemctl --user restart wechat-cc            # 新 daemon 带 mw-messages / tick 扩展
bun cli.ts dialogue timeline --chat-id <admin> --json | head -3   # 真数据冒烟
```

- [ ] **Step 3: Push**

```bash
git push origin dev
```

---

## Self-Review 记录

- **Spec 覆盖**:D1-D7 → Task 7(prompt 规则)/Task 2+5(D4)/Task 8(D3)/Task 10(D1/D2/D5 UI);spec"写路径/回填/抽取/桌面端/测试"五节 → Task 3-4 / 5 / 6-8 / 10 / 11。导出 markdown 保留:沿用 sessions.js 既有 export 函数挂在 timeline 视图(Task 10 Step 1 实现时纳入)。
- **类型一致性**:`MessageRecord`/`MessagesStore` 定义于 Task 2,Task 3/4/5/8/9 引用同名同形;`ThreadsStore` 定义于 Task 6,Task 8/9 引用;`ExtractOp` 定义于 Task 7,Task 8 消费。
- **已知留白(显式,非占位符)**:Claude JSONL 行格式以 `sessions read-jsonl` 现行解析为准(Task 5 实施时先读后写,plan 给了独立实现兜底);harness 触发 introspect 的测试钩子若缺需小幅暴露(Task 8 Step 4 注明)。
