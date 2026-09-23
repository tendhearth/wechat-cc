# 工作台实时事件流(桌面)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务运行时桌面逐字显示两家执行者的文字、即时显示工具调用、停止立刻有反应,页面不整块重建。

**Architecture:** daemon 侧给每个任务一个持久化的变更序号 `seq`(任务表一列 + 事件行一列)和一个内存 waiter 中心 `TaskChangeHub`;`GET /v1/workbench/task` 加 `since`/`wait_ms` 做长轮询,只回变过的事件行。Claude 执行者打开 SDK 的 partial messages 发逐字 append,两家的 append 经 `DeltaCoalescer` 150ms 合并后落库。桌面对选中任务改长轮询循环,按事件 id 合并,正在跑的那一组做增量 DOM 补丁,结构变化才整页重画。

**Tech Stack:** TypeScript / Bun 1.3.14 + Node 24 双跑(vitest)、SQLite(`src/lib/runtime/sqlite.ts` 适配层)、`@anthropic-ai/claude-agent-sdk`(`includePartialMessages`)、桌面 vanilla JS(Tauri 2,Rust `reqwest` 代理)。

**Spec:** `docs/superpowers/specs/2026-09-17-workbench-live-stream-design.md`

## Global Constraints

- 仓库:`/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit`,分支 `dev`。不要碰兄弟工作树 `…/wechat-cc`(在 `feat/cli-hook-push`)。
- 跑测试:`bun --bun vitest run <paths>`;全量 `bun run test`;Node 出口 `npm run test:node`(必须经 npm 脚本跑,PATH 里才有 `node_modules/.bin`);`bun run typecheck`;`bun run depcheck`(0 errors 即可,7 warnings 是既有)。
- 业务代码不得直接 import `bun:*`(`src/lib/runtime/no-bun-globals.test.ts` 守着);sqlite 走 `db.query(...).run/get/all`、`db.exec`、`db.transaction`。
- 新迁移 = v61。迁移阶梯在 `src/lib/db.ts` 的 `migrations` 数组末尾追加;`user_version` 是**计数**。三处锁要一起改:`src/lib/migration-order.test.ts`(指纹表加 `61: '<指纹>'`,指纹从失败输出里抄)、`src/lib/state-migration.test.ts`(`expect(v).toBe(61)`)、`src/lib/db.test.ts`(如有 `toBe(60)` 改 61)。
- 事件文本上限 40 000 字符(既有 `slice(0,40_000)`),不放宽。
- 长轮询上限 20 000ms(路由钳住),Rust 代理超时 35s。
- 提交信息中文,末尾带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` 与 `Claude-Session: https://claude.ai/code/session_0192qR5eDp28Cz3Xg66oEu6c`。
- 每个任务结束:相关测试绿 → `bun run typecheck` 干净 → 提交。全部做完再跑全量 Bun + Node + depcheck,推 `origin dev`,看 CI,`cd apps/desktop && bun run build-sidecar` 换进 .app 重启(见 `docs/cc-workbench.md` 修订记录里的部署步骤;memory `driving-real-workbench`)。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/core/workbench/task-changes.ts`(新) | `TaskChangeHub`:每任务 seq 的内存缓存 + waiters;`bump/seq/wait/dispose` |
| `src/lib/db.ts` | v61:`workbench_tasks.seq`、`workbench_events.seq` + 索引 |
| `src/core/workbench/timeline-events.ts` | INSERT/UPDATE 写 `seq`;`events(id, since?)` |
| `src/core/workbench/store.ts` | `bump(id)` 持久化 seq;所有写点后 bump;`detail(id,{since})` 带 `version` |
| `src/core/workbench/delta-coalescer.ts`(新) | append 文本 150ms 合并 |
| `src/core/workbench/service.ts` | 注入 coalescer;`detail(id, opts)`;`changes.wait`;权限/提问/成果写点后 bump |
| `src/core/claude-workbench-runtime.ts` | `includePartialMessages` + `stream_event` 分支 + itemId 对账 |
| `src/daemon/internal-api/routes-workbench.ts` | `since`/`wait_ms`;cancel 透传 `expectedRunId` |
| `apps/desktop/src/modules/workbench-live.js`(新) | `mergeEvents`、`structuralSignature`、`patchLiveTimeline`、`createLongPoll` |
| `apps/desktop/src/modules/workbench.js` | 选中任务走长轮询;增量路径 |
| `apps/desktop/src-tauri/src/lib.rs` | `workbench_api` 超时 35s |
| `docs/cc-workbench.md` | 修订记录 |

---

### Task 1: `TaskChangeHub`

**Files:**
- Create: `src/core/workbench/task-changes.ts`
- Test: `src/core/workbench/task-changes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TaskChangeHub {
    /** 记住这个任务当前的持久化 seq(store 写完后调);唤醒 waiters。 */
    publish(taskId: string, seq: number): void
    /** 内存里已知的 seq;不知道 ⇒ 0。 */
    seq(taskId: string): number
    /** seq > since 立即返回;否则等 publish 或超时;返回当时的 seq。 */
    wait(taskId: string, since: number, maxMs: number): Promise<number>
    dispose(): void
  }
  export function makeTaskChangeHub(opts?: { maxWaitersPerTask?: number }): TaskChangeHub
  ```

- [ ] **Step 1: 写失败的测试**

```ts
// src/core/workbench/task-changes.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeTaskChangeHub } from './task-changes'

describe('TaskChangeHub', () => {
  it('seq > since ⇒ 立即返回当前 seq;不知道的任务 seq=0', async () => {
    const hub = makeTaskChangeHub()
    expect(hub.seq('t1')).toBe(0)
    hub.publish('t1', 3)
    expect(hub.seq('t1')).toBe(3)
    await expect(hub.wait('t1', 2, 1000)).resolves.toBe(3)
  })
  it('挂起直到 publish;多个 waiter 一起醒;别的任务不受影响', async () => {
    const hub = makeTaskChangeHub()
    hub.publish('t1', 1)
    const a = hub.wait('t1', 1, 5000), b = hub.wait('t1', 1, 5000), other = hub.wait('t2', 0, 30)
    let settled = false; void a.then(() => { settled = true })
    await new Promise(r => setTimeout(r, 5)); expect(settled).toBe(false)
    hub.publish('t1', 2)
    await expect(a).resolves.toBe(2); await expect(b).resolves.toBe(2)
    await expect(other).resolves.toBe(0)   // 超时返回当前值
  })
  it('超时返回当时的 seq', async () => {
    vi.useFakeTimers()
    const hub = makeTaskChangeHub(); hub.publish('t1', 1)
    const p = hub.wait('t1', 1, 100)
    vi.advanceTimersByTime(100)
    await expect(p).resolves.toBe(1)
    vi.useRealTimers()
  })
  it('每任务 waiter 上限:超出的直接返回当前 seq,不挂', async () => {
    const hub = makeTaskChangeHub({ maxWaitersPerTask: 2 })
    hub.publish('t1', 1)
    const a = hub.wait('t1', 1, 5000), b = hub.wait('t1', 1, 5000)
    await expect(hub.wait('t1', 1, 5000)).resolves.toBe(1)
    hub.publish('t1', 2); await a; await b
  })
  it('dispose 唤醒所有 waiter', async () => {
    const hub = makeTaskChangeHub(); hub.publish('t1', 1)
    const p = hub.wait('t1', 1, 5000); hub.dispose()
    await expect(p).resolves.toBe(1)
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/core/workbench/task-changes.test.ts`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
// src/core/workbench/task-changes.ts
/**
 * task-changes — 任务详情"变了"的信号(docs/superpowers/specs/2026-09-17-workbench-live-stream-design.md §1)。
 * 持久化的 seq 在 workbench_tasks.seq(store 负责 +1);这里只缓存最新值并让长轮询挂着等。
 * 不是事件总线:只有 publish / wait,照抄 cli-permission-relay 的 waiters 写法。
 */
export interface TaskChangeHub {
  publish(taskId: string, seq: number): void
  seq(taskId: string): number
  wait(taskId: string, since: number, maxMs: number): Promise<number>
  dispose(): void
}
type Waiter = () => void
export function makeTaskChangeHub(opts: { maxWaitersPerTask?: number } = {}): TaskChangeHub {
  const max = opts.maxWaitersPerTask ?? 8
  const seqs = new Map<string, number>()
  const waiters = new Map<string, Waiter[]>()
  const wake = (taskId: string) => { const list = waiters.get(taskId); if (!list) return; waiters.delete(taskId); for (const w of list) w() }
  return {
    publish(taskId, seq) { if (seq > (seqs.get(taskId) ?? 0)) seqs.set(taskId, seq); wake(taskId) },
    seq: taskId => seqs.get(taskId) ?? 0,
    wait(taskId, since, maxMs) {
      const current = seqs.get(taskId) ?? 0
      if (current > since) return Promise.resolve(current)
      const list = waiters.get(taskId) ?? []
      if (list.length >= max) return Promise.resolve(current)
      return new Promise(resolve => {
        let done = false
        const finish = () => { if (done) return; done = true; clearTimeout(t); resolve(seqs.get(taskId) ?? 0) }
        const t = setTimeout(finish, maxMs)
        ;(t as { unref?: () => void }).unref?.()
        list.push(finish); waiters.set(taskId, list)
      })
    },
    dispose() { for (const id of [...waiters.keys()]) wake(id); seqs.clear() },
  }
}
```

- [ ] **Step 4: 跑,确认通过**

Run: `bun --bun vitest run src/core/workbench/task-changes.test.ts`
Expected: 5 passed

- [ ] **Step 5: 提交**

```bash
git add src/core/workbench/task-changes.ts src/core/workbench/task-changes.test.ts
git commit -m "工作台:任务变更信号 TaskChangeHub(publish/wait,长轮询的等待原语)"
```

---

### Task 2: 迁移 v61 —— `seq` 列

**Files:**
- Modify: `src/lib/db.ts`(`migrations` 数组末尾,v60 块之后)
- Modify: `src/lib/migration-order.test.ts:115` 附近指纹表、`src/lib/state-migration.test.ts:111-112`、`src/lib/db.test.ts`(若断言 60)
- Test: `src/lib/db.test.ts`(新增一条)

**Interfaces:**
- Produces:表列 `workbench_tasks.seq INTEGER NOT NULL DEFAULT 0`、`workbench_events.seq INTEGER NOT NULL DEFAULT 0`、索引 `workbench_events_task_seq(task_id, seq)`。

- [ ] **Step 1: 写失败的测试**(加到 `src/lib/db.test.ts` 末尾)

```ts
it('v61: workbench_tasks / workbench_events 都有 seq 列,事件表有 (task_id, seq) 索引', () => {
  const db = openTestDb()
  const cols = (t: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${t})`).all().map(c => c.name)
  expect(cols('workbench_tasks')).toContain('seq')
  expect(cols('workbench_events')).toContain('seq')
  const idx = db.query<{ name: string }, []>("PRAGMA index_list('workbench_events')").all().map(i => i.name)
  expect(idx).toContain('workbench_events_task_seq')
  db.close()
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/lib/db.test.ts -t "v61"`
Expected: FAIL(没有 seq 列)

- [ ] **Step 3: 加迁移**(`src/lib/db.ts`,`migrations` 数组里 v60 那个函数之后追加)

```ts
  // v61: 工作台实时事件流 —— 任务变更序号(持久化)与事件行的 seq(长轮询只取 seq > since 的行)。
  (db) => {
    const has = (table: string, column: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some(c => c.name === column)
    if (!has('workbench_tasks', 'seq')) db.exec('ALTER TABLE workbench_tasks ADD COLUMN seq INTEGER NOT NULL DEFAULT 0')
    if (!has('workbench_events', 'seq')) db.exec('ALTER TABLE workbench_events ADD COLUMN seq INTEGER NOT NULL DEFAULT 0')
    db.exec('CREATE INDEX IF NOT EXISTS workbench_events_task_seq ON workbench_events(task_id, seq)')
  },
```

- [ ] **Step 4: 跑迁移锁测试,按输出改三处**

Run: `bun --bun vitest run src/lib/db.test.ts src/lib/migration-order.test.ts src/lib/state-migration.test.ts`
Expected: 先红。把 `state-migration.test.ts` 的 `expect(v).toBe(60)` 改 61(注释加一行 `// v61: seq 列`);`migration-order.test.ts` 指纹表加 `61: '<失败输出里打印的指纹>'`;`db.test.ts` 若有 `toBe(60)` 改 61。再跑到绿。

- [ ] **Step 5: 提交**

```bash
git add src/lib/db.ts src/lib/db.test.ts src/lib/migration-order.test.ts src/lib/state-migration.test.ts
git commit -m "v61:workbench_tasks.seq + workbench_events.seq(实时事件流的变更序号)"
```

---

### Task 3: store —— 写点 bump、事件行 seq、`detail(id,{since})`

**Files:**
- Modify: `src/core/workbench/timeline-events.ts`
- Modify: `src/core/workbench/store.ts:64-90,176-178,193,203,205`
- Test: `src/core/workbench/store-seq.test.ts`(新)

**Interfaces:**
- Consumes: Task 1 `TaskChangeHub`(store 不持有它;store 只负责持久化 +1 并返回新值,service 把值 publish 出去)。
- Produces:
  ```ts
  // timeline-events
  makeTimelineEvents(db) 现在返回 { events(id, since?), addEvent(...,seq), recordAgentEvent(taskId, runId, event, seq), finishRunActivities(taskId, runId, status, seq) }
  // store
  store.bump(id): number                       // UPDATE workbench_tasks SET seq=seq+1 … RETURNING;不存在 ⇒ 抛 not_found
  store.version(id): number                    // 当前 seq
  store.addEvent(id, kind, text, sourceId?, runId?, attachments?)   // 内部 bump 并把 seq 写进行;签名不变
  store.recordAgentEvent(taskId, runId, event)                      // 同上
  store.finishRunActivities(taskId, runId, status)                  // 同上
  store.update(id, status, error?)                                  // 内部 bump
  store.addArtifact / approve / session / recordHandoffEvent        // 内部 bump
  store.detail(id, opts?: { since?: number })  // events 只含 seq > since;返回值多一个 version: number
  ```
  规则:**store 的每个写方法自己 bump**(一次事务里先 +1 拿到 seq 再写行),service 只在"store 之外"的状态(权限队列、提问队列、运行快照)变化时另外调 `store.bump` 并 publish。

- [ ] **Step 1: 写失败的测试**

```ts
// src/core/workbench/store-seq.test.ts
import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeWorkbenchStore } from './store'

const mk = () => { const db = openTestDb(); const store = makeWorkbenchStore(db); const t = store.create({ title: 't', path: '/p', providerId: 'codex', ownerChatId: 'o' }); return { db, store, id: t.id } }

describe('store seq(每个写点都让 version 递增)', () => {
  it('新任务 version=0;每种写点各 +1', () => {
    const { store, id } = mk()
    expect(store.version(id)).toBe(0)
    const before = () => store.version(id)
    let v = before(); store.addEvent(id, 'system', 'x'); expect(before()).toBe(v + 1)
    v = before(); store.recordAgentEvent(id, 'run1', { kind: 'text', text: 'a', itemId: 'i1', textMode: 'append' }); expect(before()).toBe(v + 1)
    v = before(); store.recordAgentEvent(id, 'run1', { kind: 'text', text: 'b', itemId: 'i1', textMode: 'append' }); expect(before()).toBe(v + 1)
    v = before(); store.update(id, 'running'); expect(before()).toBe(v + 1)
    v = before(); store.finishRunActivities(id, 'run1', 'cancelled'); expect(before()).toBe(v + 1)
    v = before(); store.session(id, 's1'); expect(before()).toBe(v + 1)
    v = before(); expect(store.bump(id)).toBe(v + 1)
  })
  it('detail({since}) 只回 seq > since 的行;追加过的旧行也算"变过";version 随行', () => {
    const { store, id } = mk()
    store.addEvent(id, 'user', '要求')                                              // seq 1
    store.recordAgentEvent(id, 'run1', { kind: 'text', text: '你', itemId: 'i1', textMode: 'append' })   // seq 2 (insert)
    const d1 = store.detail(id, { since: 0 })
    expect(d1.version).toBe(2); expect(d1.events.map(e => e.text)).toEqual(['要求', '你'])
    store.recordAgentEvent(id, 'run1', { kind: 'text', text: '好', itemId: 'i1', textMode: 'append' })   // seq 3 (update 同一行)
    const d2 = store.detail(id, { since: 2 })
    expect(d2.version).toBe(3); expect(d2.events).toHaveLength(1); expect(d2.events[0]!.text).toBe('你好')
    expect(store.detail(id, { since: 3 }).events).toEqual([])
    expect(store.detail(id).events).toHaveLength(2)    // 不带 since 行为不变
  })
  it('bump 不存在的任务 ⇒ not_found', () => {
    const { store } = mk(); expect(() => store.bump('nope0000')).toThrow('not_found')
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/core/workbench/store-seq.test.ts`
Expected: FAIL(`version` 不是函数)

- [ ] **Step 3: 改 timeline-events.ts**

```ts
// 三个写函数都多一个尾参 seq:number,写进行;events 多一个可选 since
const events=(id:string,since?:number)=>(since===undefined
  ?db.query<EventRow,[string]>(SELECT+' WHERE task_id=? ORDER BY id').all(id)
  :db.query<EventRow,[string,number]>(SELECT+' WHERE task_id=? AND seq>? ORDER BY id').all(id,since)).map(publicEvent)
const addEvent=(id:string,kind:TaskEvent['kind'],text:string,sourceId:string|null,runId:string|null,attachments:readonly Attachment[],seq:number)=>Number(
  db.query('INSERT INTO workbench_events(task_id,kind,text,created_at,source_id,run_id,attachments_json,seq) VALUES(?,?,?,?,?,?,?,?)')
    .run(id,kind,text.slice(0,40_000),Date.now(),sourceId,runId,JSON.stringify(attachments),seq).lastInsertRowid)
// recordAgentEvent(taskId,runId,event,seq):UPDATE 加 `seq=?`,INSERT 加 seq 列
//   db.query('UPDATE workbench_events SET text=?,activity_json=?,seq=? WHERE id=?').run(text,activity?JSON.stringify(activity):null,seq,previous.id)
//   INSERT …(task_id,kind,text,created_at,run_id,event_key,activity_json,seq) VALUES(?,?,?,?,?,?,?,?)
// finishRunActivities(taskId,runId,status,seq):UPDATE 加 `seq=?`
```

- [ ] **Step 4: 改 store.ts**

```ts
// makeWorkbenchStore 内:
const {events,addEvent:insertEvent,recordAgentEvent:upsertAgentEvent,finishRunActivities:finishActivities}=makeTimelineEvents(db)
const bump=(id:string):number=>{
  const row=db.query<{seq:number},[number,string]>('UPDATE workbench_tasks SET seq=seq+1,updated_at=? WHERE id=? RETURNING seq').get(Date.now(),id)
  if(!row)throw new Error('not_found')
  return row.seq
}
const version=(id:string)=>db.query<{seq:number},[string]>('SELECT seq FROM workbench_tasks WHERE id=?').get(id)?.seq??0
// 返回对象里:
get, artifacts, events, bump, version,
addEvent:(id,kind,text,sourceId=null,runId=null,attachments=[])=>db.transaction(()=>insertEvent(id,kind,text,sourceId,runId,attachments,bump(id)))(),
recordAgentEvent:(taskId,runId,event)=>db.transaction(()=>upsertAgentEvent(taskId,runId,event,bump(taskId)))(),
finishRunActivities:(taskId,runId,status)=>db.transaction(()=>{finishActivities(taskId,runId,status,bump(taskId))})(),
// update / session / addArtifact / approve / recordHandoffEvent / recordHandoffNative:各自在现有 SQL 后追加 `bump(id)`(在同一 transaction 内;update 用 task id,addArtifact/approve 用 taskId)
// recover():每个 id 的 finishRunActivities/UPDATE/addEvent 已各自 bump,不再额外处理
// detail:
detail(id:string,opts:{since?:number}={}) { const origin=source(id);return {handoffs:handoffs(id),...(origin?{source:publicSource(origin)}:{}), task: publicTask(get(id)), events: events(id,opts.since), artifacts: artifacts(id).map(publicArtifact), version: version(id) } }
```
注意:`update()` 里已有 `updated_at=?`;`bump` 也写 `updated_at`,无害。`RETURNING` 需要 SQLite ≥ 3.35(Bun 内置与 Node 24 的 `node:sqlite` 都满足)。

- [ ] **Step 5: 跑,确认通过 + 既有 store/service 测试不红**

Run: `bun --bun vitest run src/core/workbench/store-seq.test.ts src/core/workbench/store.test.ts src/core/workbench/service.test.ts src/core/workbench/timeline-events.test.ts` 然后 `bun run typecheck`
Expected: 全绿(若 timeline-events 有直接调用旧签名的测试,按新尾参补 `seq` 0)

- [ ] **Step 6: 提交**

```bash
git add src/core/workbench/timeline-events.ts src/core/workbench/store.ts src/core/workbench/store-seq.test.ts
git commit -m "工作台 store:每个写点递增任务 seq,事件行记 seq,detail({since}) 只回变过的行并带 version"
```

---

### Task 4: service —— hub 接入、`detail(id,{since})`、`wait`、非 store 状态的 bump

**Files:**
- Modify: `src/core/workbench/service.ts:32-51`(Options)、`:1148-1160`(detail)、`:527`(requestPermission)、提问处、`reportExecution`(`:515`)、`liveInputs` 写点(`:633-660`,`:703-710`)、`:1219-1225`(cancel)
- Test: `src/core/workbench/service-live.test.ts`(新)

**Interfaces:**
- Consumes: Task 1 `makeTaskChangeHub`;Task 3 `store.bump/version/detail(id,{since})`。
- Produces:
  ```ts
  service.detail(id: string, opts?: { since?: number }): Promise<Detail & { version: number }>
  service.changes: { wait(id: string, since: number, maxMs: number): Promise<number> }
  ```
  service 内部持有 `const changes = opts.changes ?? makeTaskChangeHub()`;一个小助手 `const touched = (id: string, seq = store.version(id)) => changes.publish(id, seq)`。
  - store 的写方法返回后调 `touched(id)`(把持久化 seq 送进 hub)。最省事的落点:在 service 里包一层 `const store = wrapStorePublish(opts.store, touched)`?—— **不做**代理魔法;改成:所有 service 里直接调 `store.addEvent/recordAgentEvent/update/finishRunActivities/session/addArtifact/approve/recordHandoffEvent` 的地方,后面跟一句 `touched(taskId)`。为了不漏,在本任务的测试里用表格覆盖。
  - 非 store 状态变化处调 `touched(id, store.bump(id))`:`requestPermission` 进入与 `finally`、`running.permissions.resolve/rejectAll` 之后、提问 `questions` 的登记与关闭、`reportExecution`、`runtimeSnapshot` 会变的时刻(runtime 的 `retained/foreground` 只在事件里变,已随 recordAgentEvent bump,不另加)。
  - `shutdown()` 里 `changes.dispose()`。

- [ ] **Step 1: 写失败的测试**

```ts
// src/core/workbench/service-live.test.ts
import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeWorkbenchStore } from './store'
import { makeWorkbenchService } from './service'
import { createProviderRegistry } from '../provider-registry'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'

function setup() {
  const db = openTestDb(), store = makeWorkbenchStore(db), stateDir = mkdtempSync(join(tmpdir(), 'wb-live-'))
  const service = makeWorkbenchService({ store, registry: createProviderRegistry(), stateDir, ownerChatId: () => 'owner' })
  const task = store.create({ title: 't', path: stateDir, providerId: 'codex', ownerChatId: 'owner' })
  return { store, service, id: task.id }
}

describe('service 实时流面', () => {
  it('detail 带 version;since 只回变过的行', async () => {
    const { store, service, id } = setup()
    store.addEvent(id, 'user', '要求'); store.recordAgentEvent(id, 'r1', { kind: 'text', text: '你', itemId: 'i', textMode: 'append' })
    const full = await service.detail(id); expect(full.version).toBe(2); expect(full.events).toHaveLength(2)
    const part = await service.detail(id, { since: 1 }); expect(part.events.map(e => e.text)).toEqual(['你']); expect(part.version).toBe(2)
  })
  it('changes.wait:store 直接写不经 service 时 hub 不知道,但 wait 先看持久化 version 再挂', async () => {
    const { store, service, id } = setup()
    store.addEvent(id, 'user', '要求')             // version 1,hub 不知道
    await expect(service.changes.wait(id, 0, 1000)).resolves.toBe(1)   // wait 用 store.version 兜底
    const p = service.changes.wait(id, 1, 5000)
    store.addEvent(id, 'system', 'x'); await service.detail(id)        // detail 顺手 publish 当前 version
    await expect(p).resolves.toBe(2)
  })
  it('cancel 后 version 递增(cancelling 落库即 bump)', async () => {
    const { store, service, id } = setup()
    const v = store.version(id)
    await expect(service.cancel(id)).resolves.toMatchObject({ id })
    expect(store.version(id)).toBeGreaterThan(v)
  })
})
```
注:`wait` 的实现是 `const current=Math.max(changes.seq(id), store.version(id)); if(current>since) return current; changes.publish(id,current); return changes.wait(id,since,maxMs)`,这样任何绕过 hub 的写也能被下一次 detail/wait 发现;`detail()` 末尾 `changes.publish(id, result.version)`。

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/core/workbench/service-live.test.ts`
Expected: FAIL(`version` undefined / `changes` undefined)

- [ ] **Step 3: 实现**(要点)

```ts
// Options 加:
  /** 变更信号中心(长轮询);不传就自建。 */
  changes?: TaskChangeHub
// makeWorkbenchService 内:
  const changes = opts.changes ?? makeTaskChangeHub()
  const touched = (id: string, seq?: number) => { try { changes.publish(id, seq ?? store.version(id)) } catch { /* 信号丢了只是多等一轮 */ } }
// detail:
    async detail(id:string,options:{since?:number}={}) {
      const detail=store.detail(id,options)
      … 现有拼装 …
      const result={...detail,…}
      touched(id, detail.version)
      return result
    },
// 新字段:
    changes: {
      async wait(id: string, since: number, maxMs: number) {
        const current = Math.max(changes.seq(id), store.version(id))
        if (current > since) return current
        changes.publish(id, current)
        return changes.wait(id, since, maxMs)
      },
    },
// 权限:
    requestPermission:(request,signal) => {running.interactionAt=Date.now();touched(task.id,store.bump(task.id));return running.permissions.request(request,signal).finally(()=>{running.interactionAt=null;touched(task.id,store.bump(task.id))})},
// resolvePermission():resolve 成功后 touched(id, store.bump(id))
// 提问(questions.ask / answer / close):同样各加一句
// reportExecution(:515):写完 execution 后 touched(task.id, store.bump(task.id))
// execute 消费循环(:559):recordAgentEvent 之后 touched(task.id)
// 其余 store.update/addEvent 调用点:每处后面跟 touched(task.id)(用 grep 'store.update(\|store.addEvent(\|finishRunActivities(' 逐个补)
// cancel 路径 :787:store.update(running.taskId,'cancelling') 之后 touched(running.taskId)
// shutdown():changes.dispose()
```

- [ ] **Step 4: 跑,确认通过 + 整个 workbench 目录不红**

Run: `bun --bun vitest run src/core/workbench src/daemon/internal-api/routes-workbench.test.ts && bun run typecheck`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/core/workbench/service.ts src/core/workbench/service-live.test.ts
git commit -m "工作台 service:接 TaskChangeHub,detail 带 version 与 since,changes.wait 兜底持久化 seq,权限/提问/执行者切换也 bump"
```

---

### Task 5: 路由 —— `since` / `wait_ms` 长轮询,cancel 透传 `expectedRunId`

**Files:**
- Modify: `src/daemon/internal-api/routes-workbench.ts:186-196,248-258`
- Test: `src/daemon/internal-api/routes-workbench.test.ts`(在现有 `service()` 假件基础上加 `changes` 与 `detail(id, opts)`)

**Interfaces:**
- Consumes: Task 4 `service.detail(id,{since})`、`service.changes.wait`。
- Produces: `GET /v1/workbench/task?id=&since=<n>&wait_ms=<ms>`;`POST /v1/workbench/cancel {id, expectedRunId?}`。

- [ ] **Step 1: 写失败的测试**(加到 `routes-workbench.test.ts`;`service()` 假件加 `changes: { wait: vi.fn(async () => 5) }`,`detail: vi.fn((_id, opts) => ({ task: TASK, events: [], artifacts: [], version: 5, since: opts?.since }))`)

```ts
describe('GET /v1/workbench/task 长轮询', () => {
  it('不带 since ⇒ 不等待,detail 不带 opts', async () => {
    const svc = service(); const api = createApi(svc)   // 沿用本文件已有的建 api 方式
    const r = await get(api, '/v1/workbench/task?id=deadbeef')
    expect(r.status).toBe(200); expect(svc.changes.wait).not.toHaveBeenCalled(); expect(svc.detail).toHaveBeenCalledWith('deadbeef', {})
  })
  it('带 since 与 wait_ms ⇒ 先 wait(钳到 20000),再 detail({since})', async () => {
    const svc = service(); const api = createApi(svc)
    const r = await get(api, '/v1/workbench/task?id=deadbeef&since=4&wait_ms=99999')
    expect(r.status).toBe(200); expect(svc.changes.wait).toHaveBeenCalledWith('deadbeef', 4, 20000); expect(svc.detail).toHaveBeenCalledWith('deadbeef', { since: 4 })
    expect(r.body.version).toBe(5)
  })
  it('since / wait_ms 非法 ⇒ 400', async () => {
    const api = createApi(service())
    for (const q of ['since=-1', 'since=abc', 'since=1&wait_ms=x', 'since=1&since=2']) expect((await get(api, `/v1/workbench/task?id=deadbeef&${q}`)).status).toBe(400)
  })
})
it('POST /v1/workbench/cancel 透传 expectedRunId', async () => {
  const svc = service(); const api = createApi(svc)
  await post(api, '/v1/workbench/cancel', { id: 'deadbeef', expectedRunId: 'run-1' })
  expect(svc.cancel).toHaveBeenCalledWith('deadbeef', 'run-1')
})
```
(`createApi` / `get` / `post` 用本文件已有的辅助;没有就照文件里其它用例的写法。)

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/internal-api/routes-workbench.test.ts -t "长轮询|expectedRunId"`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
const WAIT_MAX_MS = 20_000
const nonNegInt = (v: string | null) => v !== null && /^\d{1,12}$/.test(v) ? Number(v) : null
// GET /v1/workbench/task:
    'GET /v1/workbench/task': async (query) => {
      const id = query.get('id')
      if (!id || !TASK_ID.test(id)) return invalid()
      if (query.getAll('since').length > 1 || query.getAll('wait_ms').length > 1) return invalid()
      const sinceRaw = query.get('since'), waitRaw = query.get('wait_ms')
      const since = sinceRaw === null ? undefined : nonNegInt(sinceRaw)
      const waitMs = waitRaw === null ? 0 : nonNegInt(waitRaw)
      if (since === null || waitMs === null) return invalid()
      if (!deps.workbench) return { status: 503, body: { error: 'workbench_not_wired' } }
      try {
        if (since !== undefined && waitMs > 0) await deps.workbench.changes.wait(id, since, Math.min(waitMs, WAIT_MAX_MS))
        return { status: 200, body: await deps.workbench.detail(id, since === undefined ? {} : { since }) }
      } catch (err) { return mappedError(err) }
    },
// cancel:
      const expectedRunId = typeof value?.expectedRunId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value.expectedRunId) ? value.expectedRunId : undefined
      … await deps.workbench.cancel(id, expectedRunId) …
```
`since` 存在但 `wait_ms` 缺省 ⇒ 不等待、只做增量返回(桌面首帧用)。

- [ ] **Step 4: 跑,确认通过**

Run: `bun --bun vitest run src/daemon/internal-api/routes-workbench.test.ts src/daemon/internal-api/token-registry.test.ts && bun run typecheck`
Expected: 全绿(路由路径没变,放行清单不用动)

- [ ] **Step 5: 提交**

```bash
git add src/daemon/internal-api/routes-workbench.ts src/daemon/internal-api/routes-workbench.test.ts
git commit -m "内部 API:GET /v1/workbench/task 支持 since + wait_ms 长轮询(≤20s);cancel 透传 expectedRunId"
```

---

### Task 6: `DeltaCoalescer` 并接进 execute 消费循环

**Files:**
- Create: `src/core/workbench/delta-coalescer.ts`
- Modify: `src/core/workbench/service.ts:553-562`(消费循环)与 `:593`(finally)
- Test: `src/core/workbench/delta-coalescer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DeltaCoalescer { push(event: AgentEvent): void; flush(): void; dispose(): void }
  export function makeDeltaCoalescer(sink: (event: AgentEvent) => void, opts?: { windowMs?: number; now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout }): DeltaCoalescer
  ```
  行为:`text` 且 `textMode==='append'` 的事件按 `itemId` 拼接进缓冲(同 itemId 连续);定时器 `windowMs`(默认 150)到期 flush;收到任何**非** append 事件 ⇒ 先 flush 再原样 sink;`replace` 事件先 flush 同 itemId 再 sink;`flush()` 把所有缓冲按 itemId 各 sink 一条 append。`dispose` 清定时器并 flush。

- [ ] **Step 1: 写失败的测试**

```ts
// src/core/workbench/delta-coalescer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeDeltaCoalescer } from './delta-coalescer'
import type { AgentEvent } from '../agent-provider'

const append = (itemId: string, text: string): AgentEvent => ({ kind: 'text', text, itemId, textMode: 'append' })
describe('DeltaCoalescer', () => {
  it('150ms 内的同 itemId 增量合成一条', () => {
    vi.useFakeTimers()
    const out: AgentEvent[] = []; const c = makeDeltaCoalescer(e => out.push(e), { windowMs: 150 })
    c.push(append('a', '你')); c.push(append('a', '好')); c.push(append('a', '呀'))
    expect(out).toEqual([])
    vi.advanceTimersByTime(150)
    expect(out).toEqual([append('a', '你好呀')])
    vi.useRealTimers()
  })
  it('非 append 事件到来 ⇒ 先 flush 再原样放行;replace 先 flush 同 itemId', () => {
    const out: AgentEvent[] = []; const c = makeDeltaCoalescer(e => out.push(e), { windowMs: 10_000 })
    c.push(append('a', '你')); c.push({ kind: 'tool_call', tool: 'Bash', activity: { id: 'x', type: 'command', status: 'running', label: 'ls' } } as AgentEvent)
    expect(out.map(e => e.kind)).toEqual(['text', 'tool_call'])
    c.push(append('a', '好')); c.push({ kind: 'text', text: '你好', itemId: 'a', textMode: 'replace' })
    expect(out.slice(2)).toEqual([append('a', '好'), { kind: 'text', text: '你好', itemId: 'a', textMode: 'replace' }])
  })
  it('不同 itemId 各自一条,flush 按先后', () => {
    const out: AgentEvent[] = []; const c = makeDeltaCoalescer(e => out.push(e), { windowMs: 10_000 })
    c.push(append('a', '1')); c.push(append('b', '2')); c.push(append('a', '3')); c.flush()
    expect(out).toEqual([append('a', '13'), append('b', '2')])
  })
  it('dispose 也 flush 且不再触发定时器', () => {
    vi.useFakeTimers()
    const out: AgentEvent[] = []; const c = makeDeltaCoalescer(e => out.push(e))
    c.push(append('a', 'x')); c.dispose(); expect(out).toHaveLength(1)
    vi.advanceTimersByTime(1000); expect(out).toHaveLength(1)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/core/workbench/delta-coalescer.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/core/workbench/delta-coalescer.ts
import type { AgentEvent } from '../agent-provider'
/** 逐字增量 150ms 合一次再落库(spec §4):每个 token 一次 SQLite UPDATE 太贵,而人眼 150ms 看不出差别。 */
export interface DeltaCoalescer { push(event: AgentEvent): void; flush(): void; dispose(): void }
type Append = Extract<AgentEvent, { kind: 'text' }> & { textMode: 'append' }
export function makeDeltaCoalescer(sink: (event: AgentEvent) => void, opts: { windowMs?: number } = {}): DeltaCoalescer {
  const windowMs = opts.windowMs ?? 150
  const buffers = new Map<string, string>()      // 插入顺序 = 先后
  let timer: ReturnType<typeof setTimeout> | null = null
  const flushOne = (itemId: string) => { const text = buffers.get(itemId); if (text === undefined) return; buffers.delete(itemId); sink({ kind: 'text', text, itemId, textMode: 'append' }) }
  const flush = () => { if (timer) { clearTimeout(timer); timer = null } for (const id of [...buffers.keys()]) flushOne(id) }
  const isAppend = (e: AgentEvent): e is Append => e.kind === 'text' && e.textMode === 'append' && typeof e.itemId === 'string'
  return {
    push(event) {
      if (isAppend(event)) {
        buffers.set(event.itemId, (buffers.get(event.itemId) ?? '') + event.text)
        if (!timer) { timer = setTimeout(() => { timer = null; flush() }, windowMs); (timer as { unref?: () => void }).unref?.() }
        return
      }
      if (event.kind === 'text' && event.textMode === 'replace' && typeof event.itemId === 'string') flushOne(event.itemId)
      else flush()
      sink(event)
    },
    flush,
    dispose() { flush() },
  }
}
```
(测试里 `vi.useFakeTimers()` 会接管 `setTimeout`,不需要注入。)

- [ ] **Step 4: 接进 service.execute**(`:553-562`)

```ts
      const coalescer = makeDeltaCoalescer(ev => {
        if (ev.kind==='text'||ev.kind==='tool_call'||ev.kind==='error') { store.recordAgentEvent(task.id,running.identity,ev); touched(task.id) }
      })
      let summary
      try {
        summary=await collectWorkbenchTurn(stream,running.stop,opts.timeoutMs ?? 10*60_000,
          ev => {
            if (running.cancelled) return
            … 现有 liveInputs / init / quota 逻辑不动 …
            coalescer.push(ev)      // 取代原来的 store.recordAgentEvent(task.id,running.identity,ev)
          })
      } finally { coalescer.dispose() }
```
注意 `quota.note` 等只看 `ev.kind==='error'` 的分支保持原位(在 push 之前或之后都可以,它不读库)。

- [ ] **Step 5: 跑**

Run: `bun --bun vitest run src/core/workbench && bun run typecheck`
Expected: 全绿。若 `service.test.ts` 里有"事件立刻可见"的断言因 150ms 延迟变红,在那些用例里等 `await new Promise(r=>setTimeout(r,200))` 或改用 `vi.useFakeTimers` 推进;**不要**把 windowMs 改成 0。

- [ ] **Step 6: 提交**

```bash
git add src/core/workbench/delta-coalescer.ts src/core/workbench/delta-coalescer.test.ts src/core/workbench/service.ts
git commit -m "工作台:逐字增量 150ms 合并后落库(DeltaCoalescer),两家执行者共用"
```

---

### Task 7: Claude 逐字流

**Files:**
- Modify: `src/core/claude-workbench-runtime.ts:41-42`(options)、`:112`(receive 开头加分支)、`:177-195`(assistant 文本块的 itemId 对账)
- Test: `src/core/claude-workbench-runtime.test.ts`(沿用文件里的 `vi.mock('@anthropic-ai/claude-agent-sdk')` 假 query 与 `native.emit`)

**Interfaces:**
- Produces: 事件序列 `{kind:'text', itemId:'claude:<message.id>:text:<index>', textMode:'append', text}` ×N,随后整条 `assistant` 到达时 `{kind:'text', itemId: 同上, textMode:'replace', text: 全文}`。

- [ ] **Step 1: 写失败的测试**(加到 `claude-workbench-runtime.test.ts`;参考文件里已有用例怎样 `start()`、`native.emit(...)`、收 `events`)

```ts
it('打开 partial messages:text_delta 逐条 append,整条 assistant 到达用同一 itemId replace', async () => {
  const { native, events, ... } = harness()   // 沿用文件里的建法
  native.emit({ type: 'system', subtype: 'init', session_id: 's1', claude_code_version: '2.1.267', model: 'claude' })
  native.emit({ type: 'stream_event', uuid: 'u1', session_id: 's1', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } } })
  native.emit({ type: 'stream_event', uuid: 'u2', session_id: 's1', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  native.emit({ type: 'stream_event', uuid: 'u3', session_id: 's1', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } } })
  native.emit({ type: 'stream_event', uuid: 'u4', session_id: 's1', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } } })
  native.emit({ type: 'assistant', uuid: 'a1', session_id: 's1', parent_tool_use_id: null, message: { id: 'msg_1', model: 'claude', content: [{ type: 'text', text: '你好' }] } })
  await tick()
  const texts = events.filter(e => e.kind === 'text')
  expect(texts).toEqual([
    { kind: 'text', text: '你', itemId: 'claude:msg_1:text:0', textMode: 'append' },
    { kind: 'text', text: '好', itemId: 'claude:msg_1:text:0', textMode: 'append' },
    { kind: 'text', text: '你好', itemId: 'claude:msg_1:text:0', textMode: 'replace' },
  ])
})
it('query 的 options 带 includePartialMessages:true', () => {
  const { native } = harness()
  expect(native.options.includePartialMessages).toBe(true)     // 假 query 记下 options(文件里 query 假件已收到 options,存到 native.options)
})
it('子代理(parent_tool_use_id)的 stream_event 忽略;缺字段的 delta 忽略,不影响整条 replace', async () => {
  const { native, events } = harness()
  native.emit({ type: 'system', subtype: 'init', session_id: 's1', claude_code_version: '2.1.267' })
  native.emit({ type: 'stream_event', uuid: 'u1', session_id: 's1', parent_tool_use_id: 'tool-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '子' } } })
  native.emit({ type: 'stream_event', uuid: 'u2', session_id: 's1', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta' } } })
  native.emit({ type: 'assistant', uuid: 'a1', session_id: 's1', parent_tool_use_id: null, message: { id: 'msg_2', content: [{ type: 'text', text: '整条' }] } })
  await tick()
  expect(events.filter(e => e.kind === 'text')).toEqual([{ kind: 'text', text: '整条', itemId: 'claude:a1:text:0', textMode: 'replace' }])
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/core/claude-workbench-runtime.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现**

```ts
// options(:41):
  const options: Options = { ...baseOptions, abortController: abort, spawnClaudeCodeProcess: processOwner.spawn, includePartialMessages: true,
    extraArgs: { ...baseOptions.extraArgs, 'replay-user-messages': null } }
// 状态(与 operations 同级):
  let streamMessageId: string | null = null                       // 当前正在流的 API message id
  const streamed = new Map<string, string>()                      // itemId → 已流出的全文(用于 assistant 对账)
// receive 开头(在 system 分支之前):
    if (message.type === 'stream_event') {
      if (id(message.parent_tool_use_id)) return                  // 子代理的流不进主时间线
      const ev = object(message.event) ? message.event : null
      if (!ev) return
      if (ev.type === 'message_start') { streamMessageId = id(object(ev.message) ? ev.message.id : undefined) ?? null; return }
      if (ev.type === 'content_block_delta' && streamMessageId !== null && typeof ev.index === 'number') {
        const delta = object(ev.delta) ? ev.delta : null
        if (!delta || delta.type !== 'text_delta' || typeof delta.text !== 'string' || !delta.text) return
        const itemId = `claude:${streamMessageId}:text:${ev.index}`
        streamed.set(itemId, (streamed.get(itemId) ?? '') + delta.text)
        foreground = 'running'
        output.push({ kind: 'text', text: delta.text, itemId, textMode: 'append' })
        return
      }
      if (ev.type === 'message_stop') streamMessageId = null
      return
    }
// assistant 文本块(:190-191),不带 owner 的那条改为:
          if (!owner) {
            const apiId = id(message.message?.id)
            const streamedKey = apiId ? [...streamed.keys()].find(k => k.startsWith(`claude:${apiId}:text:`) && streamed.get(k) === block.text) : undefined
            const itemId = streamedKey ?? `claude:${key}`
            if (streamedKey) streamed.delete(streamedKey)
            output.push({ kind: 'text', text: block.text, itemId, textMode: 'replace' })
          }
```
对账规则:整条 assistant 的文本块若与某条已流出的 `claude:<msg.id>:text:<i>` 全文相同,就用那个 itemId replace(同一行);否则照旧用 uuid 的 key(新行)。这样 Claude Code 把多块拆成多条 assistant 消息(index 都是 0)时也对得上,对不上只会多一行而不会丢文本。

- [ ] **Step 4: 跑,确认通过**

Run: `bun --bun vitest run src/core/claude-workbench-runtime.test.ts src/core/claude-agent-provider.test.ts && bun run typecheck`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/core/claude-workbench-runtime.ts src/core/claude-workbench-runtime.test.ts
git commit -m "Claude 执行者逐字流:includePartialMessages + stream_event 增量,整条到达按同一 itemId replace"
```

---

### Task 8: 桌面 —— 长轮询循环、事件合并、增量补丁

**Files:**
- Create: `apps/desktop/src/modules/workbench-live.js`
- Test: `apps/desktop/src/modules/workbench-live.test.js`(vitest,无 DOM 环境 —— 补丁函数只依赖 `querySelector`/`textContent`/`dataset`/`insertAdjacentHTML`/`className`,测试用手写假节点)
- Modify: `apps/desktop/src/modules/workbench.js:305-310`(paint)、`:400-430`(selectTask)、`:572`(render)、`:989-990`(timer)
- Modify: `apps/desktop/src-tauri/src/lib.rs:1067`(30 → 35 秒)

**Interfaces:**
- Consumes: Task 5 的 `GET /v1/workbench/task?id=&since=&wait_ms=`(返回 `{…detail, version, events: 变过的行}`)。
- Produces(`workbench-live.js`):
  ```js
  export function mergeEvents(existing, incoming)        // 按 event.id 合并:已有 ⇒ 整条替换(保留原位置);新 ⇒ 按 id 升序插入
  export function structuralSignature(detail)            // JSON 串:status/phase/error/runId/permissions ids/questions ids/artifacts (id,sha256)/inputs/runtime.retained/attachments 数;事件不算
  export function patchLiveTimeline(root, changedEvents, render)   // render = { message(event), operation(event), eventId(event) }
  //   对每条 changed:找 `#<eventId>`;找到 ⇒ text/user 用 render.message 生成新 HTML 替换 outerHTML;活动事件 ⇒ 替换 outerHTML;
  //   没找到 ⇒ 追加到最后一个 `[data-timeline-group]:not(details)`(live 组)末尾的 `.wb-operation-list`,是 text/user 就追加到 `.wb-content .wb-dialogue` 末尾;返回 {patched, appended, missing}
  export function createLongPoll({ fetchDetail, onDetail, onError, waitMs = 20000, backoff = [1000, 2000, 5000, 10000] })
  //   start(id, version) / stop();循环:fetchDetail(id, version, waitMs) → onDetail(detail) → version = detail.version;错误退避;stop 后不再回调
  ```

- [ ] **Step 1: 写失败的测试**

```js
// apps/desktop/src/modules/workbench-live.test.js
import { describe, it, expect, vi } from 'vitest'
import { mergeEvents, structuralSignature, patchLiveTimeline, createLongPoll } from './workbench-live.js'

const ev = (id, text, extra = {}) => ({ id, taskId: 't', kind: 'text', text, createdAt: id, ...extra })
describe('mergeEvents', () => {
  it('已有 id 原位替换,新 id 按 id 升序插入', () => {
    const merged = mergeEvents([ev(1, 'a'), ev(3, 'c')], [ev(3, 'cc'), ev(2, 'b'), ev(4, 'd')])
    expect(merged.map(e => [e.id, e.text])).toEqual([[1, 'a'], [2, 'b'], [3, 'cc'], [4, 'd']])
  })
  it('空 incoming 返回同一引用', () => { const a = [ev(1, 'a')]; expect(mergeEvents(a, [])).toBe(a) })
})
describe('structuralSignature', () => {
  const base = { task: { status: 'running', phase: 'working', error: null }, runId: 'r', permissions: [{ id: 'p1' }], questions: [], artifacts: [{ id: 'a', sha256: 'x' }], inputs: [], runtime: { retained: false }, attachments: [], events: [ev(1, 'a')] }
  it('事件变化不改签名;状态/权限/成果变化改签名', () => {
    expect(structuralSignature({ ...base, events: [ev(1, 'a'), ev(2, 'b')] })).toBe(structuralSignature(base))
    expect(structuralSignature({ ...base, task: { ...base.task, status: 'completed' } })).not.toBe(structuralSignature(base))
    expect(structuralSignature({ ...base, permissions: [] })).not.toBe(structuralSignature(base))
    expect(structuralSignature({ ...base, artifacts: [{ id: 'a', sha256: 'y' }] })).not.toBe(structuralSignature(base))
  })
})
describe('patchLiveTimeline', () => {
  const node = (id) => ({ id, outerHTML: '', replaced: null, replaceWith(html) { this.replaced = html } })
  const fakeRoot = (ids, liveList) => ({
    querySelector(sel) {
      if (sel.startsWith('#')) return ids.includes(sel.slice(1)) ? node(sel.slice(1)) : null
      if (sel === '[data-timeline-group]:not(details) .wb-operation-list') return liveList
      if (sel === '.wb-dialogue') return liveList
      return null
    },
  })
  it('找得到的替换,找不到的追加到 live 组', () => {
    const list = { appended: [], insertAdjacentHTML(_pos, html) { this.appended.push(html) } }
    const root = fakeRoot(['wb-event-1'], list)
    const render = { eventId: e => `wb-event-${e.id}`, message: e => `<m>${e.text}</m>`, operation: e => `<o>${e.text}</o>` }
    // replaceWith 走 outerHTML 赋值:补丁函数用 `el.outerHTML = html`,假节点用 setter 记录
    const r = patchLiveTimeline(root, [ev(1, 'x'), ev(2, 'y', { kind: 'tool_call', activity: { id: 'a', type: 'command', status: 'running', label: 'ls' } })], render)
    expect(r).toEqual({ patched: 1, appended: 1, missing: 0 }); expect(list.appended).toEqual(['<o>y</o>'])
  })
})
describe('createLongPoll', () => {
  it('循环拉取、带上 version、stop 后不再回调、错误退避', async () => {
    vi.useFakeTimers()
    const calls = []; let fail = false
    const fetchDetail = vi.fn(async (id, since, waitMs) => { calls.push([id, since, waitMs]); if (fail) throw new Error('net'); return { version: since + 1, events: [] } })
    const onDetail = vi.fn(), onError = vi.fn()
    const poll = createLongPoll({ fetchDetail, onDetail, onError, waitMs: 20000, backoff: [100, 200] })
    poll.start('t', 0)
    await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(0)
    expect(calls.slice(0, 2)).toEqual([['t', 0, 20000], ['t', 1, 20000]]); expect(onDetail).toHaveBeenCalledTimes(2)
    fail = true; await vi.advanceTimersByTimeAsync(0); expect(onError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100); expect(onError).toHaveBeenCalledTimes(2)     // 100ms 后重试又失败
    poll.stop(); fail = false; await vi.advanceTimersByTimeAsync(5000)
    expect(onDetail).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run apps/desktop/src/modules/workbench-live.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `workbench-live.js`**

```js
// apps/desktop/src/modules/workbench-live.js
/** 工作台实时流的纯函数(spec §8):事件合并、结构签名、live 组增量补丁、长轮询循环。不碰全局。 */
export function mergeEvents(existing, incoming) {
  if (!incoming?.length) return existing
  const byId = new Map(existing.map((e, i) => [e.id, i]))
  const out = existing.slice()
  const fresh = []
  for (const e of incoming) { const i = byId.get(e.id); if (i === undefined) fresh.push(e); else out[i] = e }
  if (!fresh.length) return out
  return [...out, ...fresh].sort((a, b) => Number(a.id) - Number(b.id))
}
export function structuralSignature(detail) {
  if (!detail) return ''
  const t = detail.task ?? {}
  return JSON.stringify([t.status, t.phase, t.error, t.archivedAt ?? null, detail.runId ?? null, detail.inputMode ?? null,
    (detail.permissions ?? []).map(p => p.id), (detail.questions ?? []).map(q => q.id), (detail.artifacts ?? []).map(a => [a.id, a.sha256]),
    (detail.inputs ?? []).map(i => [i.id, i.status]), detail.runtime?.retained ?? null, detail.runtime?.foreground ?? null, (detail.attachments ?? []).length,
    detail.execution ?? null, (detail.handoffs ?? []).length, (detail.wechatNotifications?.notices ?? []).length])
}
export function patchLiveTimeline(root, changed, render) {
  let patched = 0, appended = 0, missing = 0
  for (const event of changed) {
    const html = event.kind === 'user' || event.kind === 'text' ? render.message(event) : render.operation(event)
    const el = root.querySelector(`#${render.eventId(event)}`)
    if (el) { el.outerHTML = html; patched++; continue }
    const host = event.kind === 'user' || event.kind === 'text' ? root.querySelector('.wb-dialogue') : root.querySelector('[data-timeline-group]:not(details) .wb-operation-list')
    if (host) { host.insertAdjacentHTML('beforeend', html); appended++ } else missing++
  }
  return { patched, appended, missing }
}
export function createLongPoll({ fetchDetail, onDetail, onError, waitMs = 20000, backoff = [1000, 2000, 5000, 10000] }) {
  let gen = 0, timer = null
  const loop = async (id, version, myGen, failures) => {
    if (myGen !== gen) return
    let detail
    try { detail = await fetchDetail(id, version, waitMs) }
    catch (error) {
      if (myGen !== gen) return
      onError?.(error)
      const delay = backoff[Math.min(failures, backoff.length - 1)]
      timer = setTimeout(() => { void loop(id, version, myGen, failures + 1) }, delay)
      return
    }
    if (myGen !== gen) return
    onDetail(detail)
    void loop(id, typeof detail?.version === 'number' ? detail.version : version, myGen, 0)
  }
  return {
    start(id, version = 0) { this.stop(); const myGen = ++gen; void loop(id, version, myGen, 0) },
    stop() { gen++; if (timer) { clearTimeout(timer); timer = null } },
  }
}
```
测试里假节点的 `outerHTML` 赋值要能被观察:把 `node()` 改成 `{ id, set outerHTML(v) { this.replaced = v } }`,断言 `patched===1` 即可。

- [ ] **Step 4: 跑,确认通过**

Run: `bun --bun vitest run apps/desktop/src/modules/workbench-live.test.js`
Expected: 全绿

- [ ] **Step 5: 接进 `workbench.js`**

要点(按行号):
1. `import { mergeEvents, structuralSignature, patchLiveTimeline, createLongPoll } from './workbench-live.js'`。
2. `state.version = 0` 初始化;`selectTask()`(:400-430)拿到 `result` 后 `state.version = result.version ?? 0`,并 `livePoll.start(id, state.version)`;`newTask()` / `destroy()` / 选中 matter 时 `livePoll.stop()`。
3. `livePoll = createLongPoll({ fetchDetail: (id, since, waitMs) => deps.invokeWorkbenchApi('GET', `/v1/workbench/task?id=${encodeURIComponent(id)}&since=${since}&wait_ms=${waitMs}`), onDetail: applyLiveDetail, onError: () => {} })`。
4. `applyLiveDetail(detail)`:若 `detail.task.id !== state.selectedId` 丢弃;`const prevSig = structuralSignature(state.detail)`;`state.detail = { ...detail, events: mergeEvents(state.detail?.events ?? [], detail.events) }`;`state.version = detail.version`;若 `structuralSignature(state.detail) !== prevSig` ⇒ `paint(true)`(整页);否则 `const r = patchLiveTimeline(root, detail.events, { eventId: workbenchTimelineEventId, message: renderMessage, operation: renderOperationForPatch })` —— `renderMessage` 目前是 `renderWorkbench` 内的闭包(:248),要把它和 `renderOperation`(`workbench-timeline.js` 内部函数)导出成可独立调用的形式:`workbench-timeline.js` 导出 `renderOperation(event, options)`;`workbench.js` 把 `renderMessage` 提成模块级函数 `renderMessageFor(detail, helper, handoffs, actionable, lastReply, otherProvider, origin)`,补丁时用当前 state 组装。`r.missing > 0` ⇒ 退回 `paint(true)`。补丁后若 `atEnd` 为真则 `content.scrollTop = content.scrollHeight`。
5. `paint()`(:305-310)的比较从 `JSON.stringify(state)` 改成 `structuralSignature(state.detail) + JSON.stringify({ ...state, detail: undefined })`;增量路径不经 paint。
6. 3 秒定时器(:990)只做 `refresh()` 列表:把 `refresh()` 里 `else if (state.selectedId) await this.selectTask(state.selectedId)` 改为仅在 `!livePoll.active` 时才重拉详情(`createLongPoll` 加一个 `get active()`);选中任务的详情交给长轮询。
7. 停止按钮:`mutate('POST', '/v1/workbench/cancel', { id, expectedRunId: controller.state.detail?.runId })`。

- [ ] **Step 6: Rust 超时**

`apps/desktop/src-tauri/src/lib.rs:1067`:`Duration::from_secs(30)` → `Duration::from_secs(35)`。`cd apps/desktop/src-tauri && cargo check`(仅编译检查;不做 `tauri build`)。

- [ ] **Step 7: 跑桌面测试**

Run: `bun --bun vitest run apps/desktop && (cd apps/desktop && bun x playwright test)`(Playwright 4176 端口别被占)
Expected: vitest 绿;Playwright 118 + 0 新(本步不加 Playwright 用例:假 daemon 不支持工作台详情)

- [ ] **Step 8: 提交**

```bash
git add apps/desktop/src/modules/workbench-live.js apps/desktop/src/modules/workbench-live.test.js apps/desktop/src/modules/workbench.js apps/desktop/src/modules/workbench-timeline.js apps/desktop/src-tauri/src/lib.rs
git commit -m "桌面工作台:选中任务改长轮询,事件按 id 合并,正在跑的一组增量补丁,结构变化才整页重画;停止带 expectedRunId"
```

---

### Task 9: 文档、全量验证、部署、真机

**Files:**
- Modify: `docs/cc-workbench.md`(修订记录末尾)、`docs/superpowers/specs/2026-09-17-workbench-live-stream-design.md`(修订记录)
- 部署:`apps/desktop` sidecar;桌面 JS/Rust 改了 ⇒ 需要 `tauri build`(主人在场时做)

- [ ] **Step 1: 修订记录**

```md
- **2026-09-17**:工作台实时事件流(桌面)。daemon:每个任务一个持久化 `seq`(`workbench_tasks.seq`,v61),事件行记 `seq`;`GET /v1/workbench/task?since=&wait_ms=` 长轮询(≤20s)只回变过的行并带 `version`;Claude 执行者打开逐字流(`includePartialMessages`),两家的增量 150ms 合并后落库;`cancel` 认 `expectedRunId`。桌面:选中任务改长轮询,事件按 id 合并,正在跑的一组增量补丁,结构变化才整页重画。设计:`docs/superpowers/specs/2026-09-17-workbench-live-stream-design.md`。
```

- [ ] **Step 2: 全量**

Run: `bun run test && npm run test:node && bun run typecheck && bun run depcheck`
Expected: Bun / Node 全绿(5 秒超时的负载抖动单跑即绿);depcheck 0 errors

- [ ] **Step 3: 提交并推送,看 CI**

```bash
git add docs/cc-workbench.md docs/superpowers/specs/2026-09-17-workbench-live-stream-design.md
git commit -m "docs:工作台实时事件流修订记录"
git push origin dev
gh run list --workflow ci.yml --commit $(git rev-parse HEAD) --json databaseId -q '.[0].databaseId'   # 然后 gh run watch <id> --exit-status
```
Windows 作业若是 20s hook 超时 ⇒ `gh run rerun <id> --failed`。

- [ ] **Step 4: 部署 sidecar(daemon 侧立即生效)**

```bash
cd apps/desktop && bun run build-sidecar && cd ../..
APP=apps/desktop/src-tauri/target/release/bundle/macos/wechat-cc.app/Contents/MacOS
cp apps/desktop/src-tauri/binaries/wechat-cc-cli-aarch64-apple-darwin $APP/wechat-cc-cli.new && mv -f $APP/wechat-cc-cli.new $APP/wechat-cc-cli
launchctl kickstart -k gui/$(id -u)/com.wechat-cc.daemon
```
就绪判定:operator token `GET /v1/workbench` → 200(token 路径在 `~/.claude/channels/wechat/internal-api-info.json`)。

- [ ] **Step 5: 真机(主人在场)**

`cd apps/desktop && bun run tauri build`(或 dev)后:开一个 Claude 任务、一个 Codex 任务,目测逐字出现;工具调用即时;按「停止」1 秒内变「正在停止…」;`grep APP_INBOUND\|INBOUND ~/.claude/channels/wechat/launchd.err.log` 不需要看,看 `sqlite3 …/wechat-cc.db 'select id,seq from workbench_tasks order by updated_at desc limit 3'` seq 在涨。结果记进 memory `driving-real-workbench`。

---

## Self-review(写完计划后对照 spec)

- 覆盖:§1 hub(T1)、§2 事件 seq + 迁移(T2/T3)、§3 bump 落点(T3/T4)、§4 coalescer(T6)、§5 Claude 流(T7)、§6 路由(T5)、§7 Rust(T8 Step 6)、§8 桌面(T8)、错误处理(T1 超时 / T8 backoff / T6 finally dispose / T7 缺字段忽略)、测试(各任务)、真机(T9)。
- 类型一致:`store.detail(id,{since})` → `service.detail(id,{since})` → 路由 `detail(id, since===undefined?{}:{since})`;`changes.wait(id, since, maxMs)` 三处同名同序;`itemId` 前缀 `claude:<msg.id>:text:<index>` 在 T7 测试与实现一致;桌面 `version` 字段名与路由返回一致。
- 未决:T3 里"store 每个写方法自己 bump"与 T4 里"service 再 publish"的分工 —— store 只持久化,不知道 hub;service 的 `touched()` 负责 publish。不要在 store 里 import hub。
