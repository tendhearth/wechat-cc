# 笔友信箱(penpal 路由 + 觅食台信箱区块)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已落地的笔友信(penpal_channel/penpal_letter + boot.penpal.sendLetter)暴露成 4 条 internal-api 路由,并在桌面觅食台加 ✉️ 信箱区块(看信 + 回信 + 未读角标)。

**Architecture:** 后端三层小改:LetterStore 加两个查询 → wire-social 把 channelStore/letterStore 挂上 `socialPenpal` → 新 `routes-penpal.ts`(镜像 routes-social.ts,inline 校验)+ route-tiers 显式定级(读 admin / 发信 trusted 带发布评审旗)。桌面:`refresh()` 加一路 `GET /v1/penpal/channels`,§② 明信片下新增信箱区块(信道卡 → 展开线程 → 回信框)。

**Tech Stack:** bun:sqlite store(现有 db.query idiom)、internal-api RouteTable(`(query: URLSearchParams, body) => {status, body}`)、桌面原生 JS + bare-object stub 测试。

**Spec:** `docs/superpowers/specs/2026-07-22-penpal-mailbox-desktop-design.md`

## Global Constraints

- **微信「回信」路径、correspondent、传输层一概不动** —— 本期只是暴露与呈现。
- **密文字段(sealed_ciphertext/nonce/tag)绝不进任何路由响应**(测试断言)。
- `route-tiers.test.ts:54` 有全量断言:**makeRoutes 里每条路由必须有显式 ROUTE_MIN_TIER 条目** —— 4 条新路由都要登记(3 admin + 1 trusted)。
- 桌面纪律(同 P3/P3.5):`fd-` 类名;`escapeHtml` 全插值;委托监听 + 鸭子守卫(`target?.dataset`);`__xxxForTest` 测试缝;`initA2AAgentsTab`/`refresh` 导出签名不变;main.js 不动;CSS 收口在 Task 4。
- 每任务 TDD:先写测试跑 FAIL,再实现跑 PASS,commit。
- 测试命令:后端 `bunx vitest run <file>`;桌面 `bunx vitest run apps/desktop/src/modules/a2a-agents.test.ts`;全量 `bun run test`(仓库根)。

---

### Task 1: LetterStore 未读计数 + 整信道标已读

**Files:**
- Modify: `src/core/penpal-letter-store.ts`
- Test: `src/core/penpal-letter-store.test.ts`

**Interfaces:**
- Produces: `LetterStore.unreadCountByChannel(): Array<{ channel_id: string; n: number }>`、`LetterStore.markAllRead(channelId: string, at: string): void` —— Task 2 的 routes 消费。

- [ ] **Step 1: 写失败测试** —— `penpal-letter-store.test.ts` 追加:

```ts
describe('unread bookkeeping (信箱)', () => {
  it('unreadCountByChannel 只计 inbound 未读,按信道分组', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeLetterStore(db)
    s.create({ id: 'a1', channelId: 'c1', direction: 'in',  sealedCiphertext: 'x', nonce: 'n1', tag: 't', plaintext: 'p1' })
    s.create({ id: 'a2', channelId: 'c1', direction: 'in',  sealedCiphertext: 'x', nonce: 'n2', tag: 't', plaintext: 'p2' })
    s.create({ id: 'a3', channelId: 'c1', direction: 'out', sealedCiphertext: 'x', nonce: 'n3', tag: 't', plaintext: 'p3' })
    s.create({ id: 'b1', channelId: 'c2', direction: 'in',  sealedCiphertext: 'x', nonce: 'n4', tag: 't', plaintext: 'p4' })
    s.markRead('b1', '2026-07-22T00:00:00.000Z')
    const rows = s.unreadCountByChannel()
    expect(rows).toEqual([{ channel_id: 'c1', n: 2 }])   // out 不计;已读的 c2 消失
  })

  it('markAllRead 只动该信道的 inbound 未读行', () => {
    const db = openDb({ path: ':memory:' })
    const s = makeLetterStore(db)
    s.create({ id: 'a1', channelId: 'c1', direction: 'in',  sealedCiphertext: 'x', nonce: 'n1', tag: 't', plaintext: 'p1' })
    s.create({ id: 'a2', channelId: 'c1', direction: 'out', sealedCiphertext: 'x', nonce: 'n2', tag: 't', plaintext: 'p2' })
    s.create({ id: 'b1', channelId: 'c2', direction: 'in',  sealedCiphertext: 'x', nonce: 'n3', tag: 't', plaintext: 'p3' })
    s.markAllRead('c1', '2026-07-22T01:00:00.000Z')
    expect(s.get('a1')!.read_at).toBe('2026-07-22T01:00:00.000Z')
    expect(s.get('a2')!.read_at).toBeNull()               // outbound 不动
    expect(s.get('b1')!.read_at).toBeNull()               // 别的信道不动
    expect(s.unreadCountByChannel()).toEqual([{ channel_id: 'c2', n: 1 }])
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bunx vitest run src/core/penpal-letter-store.test.ts`,期望新 describe 红(`unreadCountByChannel is not a function`)。

- [ ] **Step 3: 实现** —— `penpal-letter-store.ts`:

接口追加(`hasInbound` 之后):

```ts
  /** 信箱:每信道 inbound 未读计数(为 0 的信道不出现)。 */
  unreadCountByChannel(): Array<{ channel_id: string; n: number }>
  /** 信箱:整信道 inbound 标已读(幂等;不存在的信道 no-op)。 */
  markAllRead(channelId: string, at: string): void
```

实现(`makeLetterStore` 内,`selInbound` 之后加两条 prepared query,返回对象加两个方法):

```ts
  const selUnread = db.query<{ channel_id: string; n: number }, []>(
    "SELECT channel_id, COUNT(*) AS n FROM penpal_letter WHERE direction='in' AND read_at IS NULL GROUP BY channel_id")
  const updAllRead = db.query<unknown, [string, string]>(
    "UPDATE penpal_letter SET read_at = ? WHERE channel_id = ? AND direction='in' AND read_at IS NULL")
```

```ts
    unreadCountByChannel() { return selUnread.all() },
    markAllRead(channelId, at) { updAllRead.run(at, channelId) },
```

- [ ] **Step 4: 跑 PASS** —— 同命令,全绿。

- [ ] **Step 5: Commit**

```bash
git add src/core/penpal-letter-store.ts src/core/penpal-letter-store.test.ts
git commit -m "feat(social): LetterStore 未读计数 + 整信道标已读(信箱底座)"
```

---

### Task 2: 暴露面 + routes-penpal + 定级

**Files:**
- Modify: `src/daemon/bootstrap/wire-social.ts`(socialPenpal 挂 stores)
- Modify: `src/daemon/bootstrap/types.ts`(social.penpal 类型)
- Modify: `src/daemon/internal-api/types.ts`(deps.social.penpal 可选声明)
- Create: `src/daemon/internal-api/routes-penpal.ts`
- Modify: `src/daemon/internal-api/routes.ts`(注册)
- Modify: `src/daemon/internal-api/route-tiers.ts`(4 条显式定级)
- Test: `src/daemon/internal-api/routes-penpal.test.ts`(新)、`src/daemon/internal-api/route-tiers.test.ts`(4 断言)

**Interfaces:**
- Consumes: Task 1 的 `unreadCountByChannel`/`markAllRead`;`ChannelStore.list()/get()`(`status==='open'`、`seek_id`、`peer_agent_id`、`degree` 字段);`SeekStore.get(id)`(`deps.social.seekStore`,已暴露);`deps.a2a?.registry.get(id)?.name`;`boot.social.penpal.sendLetter`。
- Produces: 4 条路由(桌面 Task 3 消费):`GET /v1/penpal/channels` → `{channels:[{id,title,peer_label,degree,unread,last_preview,last_at}]}`;`GET /v1/penpal/letters?channel_id=` → `{letters:[{id,direction,plaintext,created_at,read_at}]}`(**newest-first,与 store 一致**);`POST /v1/penpal/letters {channel_id,text}` → `{ok,error?}`;`POST /v1/penpal/letters/read {channel_id}` → `{ok:true}`。

- [ ] **Step 1: 类型与暴露(非 TDD 部分,先改通编译)**

1a. `src/daemon/bootstrap/wire-social.ts` 第 128 行的声明改为:

```ts
  let socialPenpal: {
    sendLetter(channel: string, text: string): Promise<{ ok: boolean; error?: string }>
    channelStore: import('../../core/penpal-channel-store').ChannelStore
    letterStore: import('../../core/penpal-letter-store').LetterStore
  } | undefined
```

第 269 行赋值改为(channelStore/letterStore 在同一作用域已存在):

```ts
      socialPenpal = { sendLetter: (channel, text) => correspondent.sendLetter(channel, text), channelStore, letterStore }
```

1b. `src/daemon/bootstrap/types.ts` 里 `social` 的 `penpal` 字段(原 `{ sendLetter(...) }`)改为:

```ts
    penpal: {
      sendLetter(channel: string, text: string): Promise<{ ok: boolean; error?: string }>
      channelStore: import('../../core/penpal-channel-store').ChannelStore
      letterStore: import('../../core/penpal-letter-store').LetterStore
    }
```

(顶层 `penpal?: { sendLetter }` 是微信「回信」dispatch 的缝,**不动**。)

1c. `src/daemon/internal-api/types.ts` 的 `social?: {...}` 内(`revealer` 之后)追加**可选**字段(可选 = 既有测试 fixture 不用补;boot 侧永远会带上):

```ts
    /** 笔友信箱(spec 2026-07-22-penpal-mailbox-desktop)— boot.social.penpal
     *  原样带入。可选:老 fixture/未接线时 undefined ⇒ /v1/penpal/* 503。 */
    penpal?: {
      sendLetter(channel: string, text: string): Promise<{ ok: boolean; error?: string }>
      channelStore: import('../../core/penpal-channel-store').ChannelStore
      letterStore: import('../../core/penpal-letter-store').LetterStore
    }
```

main.ts:294 的 `internalApi.setSocial(boot.social)` 结构化兼容,无需改动。

- [ ] **Step 2: 写失败测试** —— 新建 `src/daemon/internal-api/routes-penpal.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { penpalRoutes } from './routes-penpal'
import type { InternalApiDeps } from './types'

const CH_OPEN = { id: 'ch1', seek_id: 's1', status: 'open', degree: 1, peer_agent_id: 'buddy', relay_via: null }
const CH_RELAY = { id: 'ch2', seek_id: 's2', status: 'open', degree: 2, peer_agent_id: null, relay_via: 'w' }
const CH_PENDING = { id: 'ch3', seek_id: 's3', status: 'pending', degree: 1, peer_agent_id: 'x', relay_via: null }
const L_IN = { id: 'l1', channel_id: 'ch1', direction: 'in', sealed_ciphertext: 'CT', nonce: 'N', tag: 'T', plaintext: '你好呀', created_at: '2026-07-22T00:00:00.000Z', read_at: null }

function makeDeps(over: Record<string, unknown> = {}) {
  const letterStore = {
    listForChannel: vi.fn(() => [L_IN]),
    unreadCountByChannel: vi.fn(() => [{ channel_id: 'ch1', n: 1 }]),
    markAllRead: vi.fn(),
  }
  const channelStore = {
    list: vi.fn(() => [CH_OPEN, CH_RELAY, CH_PENDING]),
    get: vi.fn((id: string) => [CH_OPEN, CH_RELAY, CH_PENDING].find(c => c.id === id) ?? null),
  }
  const sendLetter = vi.fn(async () => ({ ok: true }))
  const deps = {
    social: {
      penpal: { sendLetter, channelStore, letterStore },
      seekStore: { get: vi.fn((id: string) => id === 's1' ? { id: 's1', topic: '找修相机师傅' } : null) },
    },
    a2a: { registry: { get: vi.fn((id: string) => id === 'buddy' ? { id: 'buddy', name: '老王的CC' } : null) } },
    ...over,
  } as unknown as InternalApiDeps
  return { deps, letterStore, channelStore, sendLetter }
}
const q = (s = '') => new URLSearchParams(s)

describe('GET /v1/penpal/channels', () => {
  it('未接线 → 503 penpal_not_wired', async () => {
    const r = await penpalRoutes({ social: undefined } as unknown as InternalApiDeps)['GET /v1/penpal/channels']!(q(), undefined)
    expect(r.status).toBe(503)
    expect((r.body as any).error).toBe('penpal_not_wired')
  })
  it('只列 open 信道;直连查 registry 名、中转标第N度;带 unread/title/last_preview', async () => {
    const { deps } = makeDeps()
    const r = await penpalRoutes(deps)['GET /v1/penpal/channels']!(q(), undefined)
    expect(r.status).toBe(200)
    const chans = (r.body as any).channels
    expect(chans.map((c: any) => c.id)).toEqual(['ch1', 'ch2'])     // pending 不列
    expect(chans[0]).toMatchObject({ title: '找修相机师傅', peer_label: '老王的CC', unread: 1, last_preview: '你好呀' })
    expect(chans[1]).toMatchObject({ title: '', peer_label: '第2度笔友', unread: 0 })
  })
})

describe('GET /v1/penpal/letters', () => {
  it('owner 投影:密文字段绝不出现', async () => {
    const { deps } = makeDeps()
    const r = await penpalRoutes(deps)['GET /v1/penpal/letters']!(q('channel_id=ch1'), undefined)
    expect(r.status).toBe(200)
    const letters = (r.body as any).letters
    expect(letters[0]).toEqual({ id: 'l1', direction: 'in', plaintext: '你好呀', created_at: '2026-07-22T00:00:00.000Z', read_at: null })
    const raw = JSON.stringify(r.body)
    expect(raw).not.toContain('sealed_ciphertext'); expect(raw).not.toContain('nonce'); expect(raw).not.toContain('"tag"'); expect(raw).not.toContain('CT')
  })
  it('缺 channel_id → 400;未知 channel → 404', async () => {
    const { deps } = makeDeps()
    expect((await penpalRoutes(deps)['GET /v1/penpal/letters']!(q(), undefined)).status).toBe(400)
    expect((await penpalRoutes(deps)['GET /v1/penpal/letters']!(q('channel_id=nope'), undefined)).status).toBe(404)
  })
})

describe('POST /v1/penpal/letters', () => {
  it('透传 sendLetter;缺参 400', async () => {
    const { deps, sendLetter } = makeDeps()
    const r = await penpalRoutes(deps)['POST /v1/penpal/letters']!(q(), { channel_id: 'ch1', text: '回信内容' })
    expect(r.status).toBe(200); expect((r.body as any).ok).toBe(true)
    expect(sendLetter).toHaveBeenCalledWith('ch1', '回信内容')
    expect((await penpalRoutes(deps)['POST /v1/penpal/letters']!(q(), { text: 'x' })).status).toBe(400)
    expect((await penpalRoutes(deps)['POST /v1/penpal/letters']!(q(), { channel_id: 'ch1' })).status).toBe(400)
  })
})

describe('POST /v1/penpal/letters/read', () => {
  it('markAllRead 被调,幂等 ok:true', async () => {
    const { deps, letterStore } = makeDeps()
    const r = await penpalRoutes(deps)['POST /v1/penpal/letters/read']!(q(), { channel_id: 'ch1' })
    expect(r.status).toBe(200); expect((r.body as any).ok).toBe(true)
    expect(letterStore.markAllRead).toHaveBeenCalledWith('ch1', expect.any(String))
  })
})
```

`route-tiers.test.ts` 追加(放在现有 trusted 断言的 describe 内或新 it):

```ts
  it('penpal 信箱路由:读 admin,发信 trusted', () => {
    expect(minTierFor('GET /v1/penpal/channels')).toBe('admin')
    expect(minTierFor('GET /v1/penpal/letters')).toBe('admin')
    expect(minTierFor('POST /v1/penpal/letters')).toBe('trusted')
    expect(minTierFor('POST /v1/penpal/letters/read')).toBe('admin')
  })
```

- [ ] **Step 3: 跑 FAIL** —— `bunx vitest run src/daemon/internal-api/routes-penpal.test.ts src/daemon/internal-api/route-tiers.test.ts`,期望 routes-penpal 模块不存在 + tier 断言红。

- [ ] **Step 4: 实现**

4a. 新建 `src/daemon/internal-api/routes-penpal.ts`:

```ts
/**
 * internal-api 笔友信箱 routes(spec 2026-07-22-penpal-mailbox-desktop)。
 * Mirrors routes-social.ts:503 penpal_not_wired until wire-social exposes
 * the correspondent+stores. Reads are the OWNER's local plaintext thread —
 * the ciphertext columns (sealed_ciphertext/nonce/tag) NEVER leave the
 * daemon (投影只挑明文字段,测试断言)。
 */
import type { InternalApiDeps, RouteTable } from './types'

const PREVIEW_LEN = 60

export function penpalRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/penpal/channels': async () => {
      const p = deps.social?.penpal
      if (!p) return { status: 503, body: { error: 'penpal_not_wired' } }
      const unread = new Map(p.letterStore.unreadCountByChannel().map(r => [r.channel_id, r.n]))
      const channels = p.channelStore.list()
        .filter(c => c.status === 'open')
        .map(c => {
          const last = p.letterStore.listForChannel(c.id)[0] ?? null
          const seek = deps.social?.seekStore.get(c.seek_id) ?? null
          const peerLabel = c.peer_agent_id
            ? (deps.a2a?.registry.get(c.peer_agent_id)?.name ?? c.peer_agent_id)
            : `第${c.degree}度笔友`
          return {
            id: c.id,
            title: seek?.topic ?? '',
            peer_label: peerLabel,
            degree: c.degree,
            unread: unread.get(c.id) ?? 0,
            last_preview: last ? last.plaintext.slice(0, PREVIEW_LEN) : null,
            last_at: last ? last.created_at : null,
          }
        })
      return { status: 200, body: { channels } }
    },
    'GET /v1/penpal/letters': async (q) => {
      const p = deps.social?.penpal
      if (!p) return { status: 503, body: { error: 'penpal_not_wired' } }
      const channelId = q.get('channel_id') ?? ''
      if (!channelId) return { status: 400, body: { error: 'missing_channel_id' } }
      if (!p.channelStore.get(channelId)) return { status: 404, body: { error: 'unknown_channel' } }
      const letters = p.letterStore.listForChannel(channelId)
        .map(l => ({ id: l.id, direction: l.direction, plaintext: l.plaintext, created_at: l.created_at, read_at: l.read_at }))
      return { status: 200, body: { letters } }
    },
    'POST /v1/penpal/letters': async (_q, body) => {
      const p = deps.social?.penpal
      if (!p) return { status: 503, body: { error: 'penpal_not_wired' } }
      const { channel_id, text } = (body ?? {}) as { channel_id?: unknown; text?: unknown }
      if (typeof channel_id !== 'string' || channel_id.length === 0) return { status: 400, body: { error: 'missing_channel_id' } }
      if (typeof text !== 'string' || text.length === 0) return { status: 400, body: { error: 'missing_text' } }
      return { status: 200, body: await p.sendLetter(channel_id, text) }
    },
    'POST /v1/penpal/letters/read': async (_q, body) => {
      const p = deps.social?.penpal
      if (!p) return { status: 503, body: { error: 'penpal_not_wired' } }
      const channelId = ((body ?? {}) as { channel_id?: unknown }).channel_id
      if (typeof channelId !== 'string' || channelId.length === 0) return { status: 400, body: { error: 'missing_channel_id' } }
      p.letterStore.markAllRead(channelId, new Date().toISOString())
      return { status: 200, body: { ok: true } }
    },
  }
}
```

4b. `routes.ts`:`import { penpalRoutes } from './routes-penpal'`(routes-pair import 旁);表合并处 `...pairRoutes(deps),` 之后加 `...penpalRoutes(deps),`。

4c. `route-tiers.ts` 在 social/pair 条目附近追加:

```ts
  // 笔友信箱(spec 2026-07-22-penpal-mailbox-desktop)。读=admin(P2
  // seeks/echoes 读路由先例:桌面 token 是 admin)。发信=trusted —
  // ⚠️ RELEASE-REVIEW FLAG(下次 dev→master 发布时在 PR body surface):
  // 作用于已互揭的既有信道(同 reveal / a2a/send 类),不产生新广播或
  // 新关系;localhost-only internal-api + 0600 文件 token。顺带解锁
  // 未来的 CLI 回信入口。
  'GET /v1/penpal/channels': 'admin',
  'GET /v1/penpal/letters': 'admin',
  'POST /v1/penpal/letters': 'trusted',
  'POST /v1/penpal/letters/read': 'admin',
```

- [ ] **Step 5: 跑 PASS** —— `bunx vitest run src/daemon/internal-api/routes-penpal.test.ts src/daemon/internal-api/route-tiers.test.ts src/daemon/internal-api.test.ts src/daemon/bootstrap.test.ts`,全绿(后两个是接线回归;route-tiers 的全量条目断言现在覆盖 4 条新路由)。

- [ ] **Step 6: Commit**

```bash
git add src/daemon/bootstrap/wire-social.ts src/daemon/bootstrap/types.ts src/daemon/internal-api/types.ts src/daemon/internal-api/routes-penpal.ts src/daemon/internal-api/routes.ts src/daemon/internal-api/route-tiers.ts src/daemon/internal-api/routes-penpal.test.ts src/daemon/internal-api/route-tiers.test.ts
git commit -m "feat(social): /v1/penpal/* 信箱路由(读admin/发信trusted+评审旗)+ stores 暴露"
```

---

### Task 3: 桌面觅食台 ✉️ 信箱区块

**Files:**
- Modify: `apps/desktop/src/index.html`(§② 明信片 section 之后插入信箱 section)
- Modify: `apps/desktop/src/modules/a2a-agents.js`
- Test: `apps/desktop/src/modules/a2a-agents.test.ts`

**Interfaces:**
- Consumes: Task 2 的 4 条路由(响应形状见 Task 2 Produces;letters 为 newest-first,渲染前 reverse 成时间正序)。
- Produces: 测试再导出 `__onMailboxActionForTest`。

- [ ] **Step 1: index.html** —— 在明信片 section 的 `</section>`(`<div class="fd-postcards" id="fd-postcards"></div>` 所在 section)之后插入:

```html
                <!-- ✉️ 笔友信箱 -->
                <section class="fd-section">
                  <div class="fd-sec-head"><h2>✉️ 笔友信箱</h2><span class="fd-count" id="fd-mailbox-count"></span><span class="fd-hint">只有你们俩看得到 · 中间人碰不到内容</span></div>
                  <div class="fd-mailbox" id="fd-mailbox"></div>
                </section>
```

- [ ] **Step 2: 写失败测试** —— `installDom` ids 追加 `'fd-mailbox','fd-mailbox-count'`;文件末尾追加:

```ts
describe('笔友信箱', () => {
  const chan = { id: 'ch1', title: '找修相机师傅', peer_label: '老王的CC', degree: 1, unread: 2, last_preview: '你好呀', last_at: new Date().toISOString() }

  it('信道卡渲染:标题/对端/未读角标/预览;总未读进区块头', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: null, mailbox: [chan, { ...chan, id: 'ch2', unread: 0, peer_label: '第2度笔友', title: '' }] })
    const html = el['fd-mailbox'].innerHTML
    expect(html).toContain('老王的CC')
    expect(html).toContain('找修相机师傅')
    expect(html).toContain('fd-mail-unread')
    expect(html).toContain('第2度笔友')
    expect(html).toContain('data-action="mail-toggle"')
    expect(el['fd-mailbox-count'].textContent).toContain('2 封未读')
  })

  it('mailbox:null → 未启用引导;[] → 空态文案', () => {
    const el = installDom()
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: null, mailbox: null })
    expect(el['fd-mailbox'].innerHTML).toContain('social enable')
    renderForageDesk({ agents: [], seeks: [], echoes: [], inbound: null, mailbox: [] })
    expect(el['fd-mailbox'].innerHTML).toContain('还没有笔友')
  })

  function mailCard() {
    const thread = { ...fakeEl(), hidden: true }
    const badge = fakeEl()
    const bubbles = fakeEl()
    const input = fakeEl(); const note = fakeEl()
    const card = { ...fakeEl(), querySelector: (sel: string) =>
      sel === '.fd-mail-thread' ? thread : sel === '.fd-mail-unread' ? badge :
      sel === '.fd-mail-bubbles' ? bubbles : sel === '.fd-mail-input' ? input :
      sel === '.fd-mail-note' ? note : null }
    return { card, thread, badge, bubbles, input, note }
  }

  it('展开线程:拉信渲染气泡、触发标已读、去掉角标', async () => {
    installDom()
    const { card, thread, badge } = mailCard()
    const btn = fakeEl(); btn.dataset.action = 'mail-toggle'; btn.dataset.id = 'ch1'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    ;(invokeApi as any).mockResolvedValueOnce({ letters: [
      { id: 'l2', direction: 'out', plaintext: '我回的', created_at: new Date().toISOString(), read_at: null },
      { id: 'l1', direction: 'in',  plaintext: '你好呀', created_at: new Date().toISOString(), read_at: null },
    ] })
    ;(invokeApi as any).mockResolvedValue({ ok: true })   // read + 后续
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect((invokeApi as any)).toHaveBeenCalledWith('GET', '/v1/penpal/letters?channel_id=ch1')
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/penpal/letters/read', { channel_id: 'ch1' })
    expect(thread.hidden).toBe(false)
    expect(thread.innerHTML).toContain('你好呀')
    expect(thread.innerHTML).toContain('fd-out')          // 方向分侧
    expect(thread.innerHTML).toContain('data-action="mail-send"')
    expect(badge.remove).toHaveBeenCalled()
  })

  it('再点收起线程', async () => {
    installDom()
    const { card, thread } = mailCard(); thread.hidden = false; thread.innerHTML = 'x'
    const btn = fakeEl(); btn.dataset.action = 'mail-toggle'; btn.dataset.id = 'ch1'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect(thread.hidden).toBe(true)
  })

  it('回信成功:乐观追加气泡、清输入;空文本不发请求', async () => {
    installDom()
    const { card, bubbles, input, note } = mailCard()
    const btn = fakeEl(); btn.dataset.action = 'mail-send'; btn.dataset.id = 'ch1'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    input.value = '  '
    ;(invokeApi as any).mockClear()
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect((invokeApi as any)).not.toHaveBeenCalled()
    input.value = '这是一封回信'
    ;(invokeApi as any).mockResolvedValueOnce({ ok: true })
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect((invokeApi as any)).toHaveBeenCalledWith('POST', '/v1/penpal/letters', { channel_id: 'ch1', text: '这是一封回信' })
    expect(bubbles.innerHTML).toContain('这是一封回信')
    expect(input.value).toBe('')
    expect(note.hidden).toBe(true)
  })

  it.each([
    ['channel_not_open', '还没打开'],
    ['no_route', '找不到'],
    ['send_failed', '联系不上'],
  ])('回信失败 %s → 人话文案,按钮恢复', async (error, copy) => {
    installDom()
    const { card, input, note } = mailCard(); input.value = 'x'
    const btn = fakeEl(); btn.dataset.action = 'mail-send'; btn.dataset.id = 'ch1'
    ;(btn as any).closest = (sel: string) => sel === '.fd-mail-chan' ? card : null
    ;(invokeApi as any).mockResolvedValueOnce({ ok: false, error })
    const { __onMailboxActionForTest } = await import('./a2a-agents.js')
    await __onMailboxActionForTest?.({ target: btn } as any)
    expect(note.textContent).toContain(copy)
    expect(btn.disabled).toBe(false)
  })
})
```

- [ ] **Step 3: 跑 FAIL** —— `bunx vitest run apps/desktop/src/modules/a2a-agents.test.ts`,新 describe 全红,既有 41 绿。

- [ ] **Step 4: 实现** —— `a2a-agents.js`:

4a. `refresh()` 的 `Promise.all` 加第 5 路 + 传参:

```js
  const [listResp, seeksResp, echoesResp, inbound, mailResp] = await Promise.all([
    /** @type {Promise<{agents?:Array<any>}|null>}   */ (invokeApi('GET', '/v1/a2a/list').catch(() => null)),
    /** @type {Promise<{seeks?:Array<any>}|null>}    */ (invokeApi('GET', '/v1/social/seeks').catch(() => null)),
    /** @type {Promise<{echoes?:Array<any>}|null>}   */ (invokeApi('GET', '/v1/social/echoes').catch(() => null)),
    /** @type {Promise<any>}                          */ (invokeApi('GET', '/v1/social/inbound').catch(() => null)),
    /** @type {Promise<{channels?:Array<any>}|null>} */ (invokeApi('GET', '/v1/penpal/channels').catch(() => null)),
  ])
```

`renderForageDesk({...})` 调用加 `mailbox: mailResp ? (mailResp.channels ?? []) : null`;`renderForageDesk` 的 JSDoc data 类型加 `mailbox:Array<any>|null`。

4b. `renderForageDesk` 内(§② postcards 渲染块之后)加:

```js
  // ── ✉️ mailbox ───────────────────────────────────────────────────────
  const mailbox = document.getElementById('fd-mailbox')
  const mbCount = document.getElementById('fd-mailbox-count')
  const chans = Array.isArray(data.mailbox) ? data.mailbox : []
  if (mailbox) {
    if (data.mailbox == null) {
      mailbox.innerHTML = `<div class="fd-empty">笔友信箱未启用 —— 先在命令行运行 wechat-cc social enable 并重启守护进程。</div>`
    } else if (chans.length === 0) {
      mailbox.innerHTML = `<div class="fd-empty">还没有笔友 —— 等一张明信片揭晓牵线后，就能在这里通信了。</div>`
    } else {
      mailbox.innerHTML = chans.map(c => renderMailChannel(c)).join('')
    }
  }
  if (mbCount) {
    const totalUnread = chans.reduce((s, c) => s + (Number(c.unread) || 0), 0)
    mbCount.textContent = totalUnread ? `${totalUnread} 封未读` : ''
  }
```

4c. 渲染函数(`renderPostcard` 之后):

```js
/** @param {any} c — GET /v1/penpal/channels 的一行。 */
function renderMailChannel(c) {
  const unread = Number(c.unread) || 0
  return `<div class="fd-mail-chan" data-chan-id="${escapeHtml(c.id)}">` +
    `<div class="fd-mail-head" data-action="mail-toggle" data-id="${escapeHtml(c.id)}">` +
    `<span class="fd-mail-peer">${escapeHtml(c.peer_label || '笔友')}</span>` +
    (c.title ? `<span class="fd-mail-title">「${escapeHtml(c.title)}」</span>` : '') +
    (unread ? `<span class="fd-mail-unread">${unread}</span>` : '') +
    (c.last_preview ? `<span class="fd-mail-preview">${escapeHtml(c.last_preview)}</span>` : '') +
    `</div>` +
    `<div class="fd-mail-thread" hidden></div>` +
    `</div>`
}

/** @param {Array<any>} letters — 路由返回 newest-first;渲染 reverse 成正序。
 *  @param {string} channelId */
function renderMailThread(letters, channelId) {
  const bubbles = letters.slice().reverse().map(l =>
    `<div class="fd-mail-bubble ${l.direction === 'out' ? 'fd-out' : 'fd-in'}">` +
    `<div class="fd-mail-text">${escapeHtml(l.plaintext ?? '')}</div>` +
    `<div class="fd-mail-time">${escapeHtml(fdRelTime(l.created_at))}</div>` +
    `</div>`).join('')
  return `<div class="fd-mail-bubbles">${bubbles || '<div class="fd-empty">还没有信 —— 写下第一封吧。</div>'}</div>` +
    `<div class="fd-mail-replyrow">` +
    `<input class="fd-mail-input" placeholder="写封信…" maxlength="2000">` +
    `<button class="fd-btn fd-btn-primary" data-action="mail-send" data-id="${escapeHtml(channelId)}">寄出</button>` +
    `</div>` +
    `<div class="fd-mail-note" hidden></div>`
}
```

4d. handlers(`onSeekAction` 之后;鸭子守卫同款纪律):

```js
// ✉️ 信箱 — 展开看信(即读即清未读)+ 回信。同时只展开一个线程。
/** @type {any} */
let openMailThreadEl = null

const MAIL_FAIL_COPY = /** @type {Record<string, string>} */ ({
  channel_not_open: '这条信道还没打开 —— 双方都揭晓后才能通信',
  no_route: '找不到通往对方的路 —— 稍后再试',
  send_failed: '寄出失败 —— 对方的 bot 暂时联系不上，稍后再试',
})

/** @param {MouseEvent} e */
async function onMailboxAction(e) {
  const target = /** @type {any} */ (e.target)
  if (!target || !target.dataset) return
  if (target.dataset.action === 'mail-toggle') return openMailThread(target)
  if (target.dataset.action === 'mail-send') return sendMailReply(target)
}

/** @param {any} target */
async function openMailThread(target) {
  const card = typeof target.closest === 'function' ? target.closest('.fd-mail-chan') : null
  const thread = card ? card.querySelector('.fd-mail-thread') : null
  const id = target.dataset.id
  if (!card || !thread || !id) return
  if (!thread.hidden) { thread.hidden = true; thread.innerHTML = ''; openMailThreadEl = null; return }
  if (openMailThreadEl && openMailThreadEl !== thread) { openMailThreadEl.hidden = true; openMailThreadEl.innerHTML = '' }
  openMailThreadEl = thread
  thread.hidden = false
  thread.innerHTML = '<div class="fd-empty">加载中…</div>'
  try {
    const r = /** @type {{letters?:Array<any>}} */ (await invokeApi('GET', `/v1/penpal/letters?channel_id=${encodeURIComponent(id)}`))
    thread.innerHTML = renderMailThread(r?.letters ?? [], id)
    // 展开即读:后端清 + 本地摘角标(fire-and-forget,失败不打断看信)。
    invokeApi('POST', '/v1/penpal/letters/read', { channel_id: id }).catch(() => {})
    const badge = card.querySelector('.fd-mail-unread')
    if (badge && typeof badge.remove === 'function') badge.remove()
  } catch (err) {
    thread.innerHTML = `<div class="fd-empty">看信失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`
  }
}

/** @param {any} target */
async function sendMailReply(target) {
  const id = target.dataset.id
  const card = typeof target.closest === 'function' ? target.closest('.fd-mail-chan') : null
  if (!id || !card) return
  const input = card.querySelector('.fd-mail-input')
  const note = card.querySelector('.fd-mail-note')
  const text = String(input?.value ?? '').trim()
  if (!text) { if (note) { note.hidden = false; note.textContent = '先写点什么' } return }
  target.disabled = true
  try {
    const r = /** @type {{ok?:boolean, error?:string}} */ (
      await invokeApi('POST', '/v1/penpal/letters', { channel_id: id, text }))
    if (r?.ok) {
      const bubbles = card.querySelector('.fd-mail-bubbles')
      if (bubbles) bubbles.innerHTML += `<div class="fd-mail-bubble fd-out"><div class="fd-mail-text">${escapeHtml(text)}</div><div class="fd-mail-time">刚刚</div></div>`
      if (input) input.value = ''
      if (note) { note.hidden = true; note.textContent = '' }
    } else {
      if (note) { note.hidden = false; note.textContent = MAIL_FAIL_COPY[String(r?.error)] ?? `寄出失败：${String(r?.error ?? '未知错误')}` }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (note) { note.hidden = false; note.textContent = msg === 'penpal_not_wired' ? '笔友功能未启用 —— 先在命令行运行 wechat-cc social enable 并重启守护进程。' : `寄出失败：${msg}` }
  } finally {
    target.disabled = false
  }
}
```

4e. `initA2AAgentsTab` 接线(其他 fd 接线旁):

```js
  document.getElementById('fd-mailbox')?.addEventListener('click', onMailboxAction)
```

测试再导出区追加:

```js
export const __onMailboxActionForTest = onMailboxAction
```

- [ ] **Step 5: 跑 PASS** —— `bunx vitest run apps/desktop/src/modules/a2a-agents.test.ts`,全绿(41 旧 + 新)。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/index.html apps/desktop/src/modules/a2a-agents.js apps/desktop/src/modules/a2a-agents.test.ts
git commit -m "feat(desktop): 觅食台 ✉️ 笔友信箱区块 —— 信道卡/展开线程即读/回信"
```

---

### Task 4: CSS + 全量回归

**Files:**
- Modify: `apps/desktop/src/styles.css`(fd 段末尾追加)

**Interfaces:**
- Consumes: Task 3 类名:`fd-mailbox`、`fd-mail-chan`、`fd-mail-head`、`fd-mail-peer`、`fd-mail-title`、`fd-mail-unread`、`fd-mail-preview`、`fd-mail-thread`、`fd-mail-bubbles`、`fd-mail-bubble`(`fd-in`/`fd-out`)、`fd-mail-text`、`fd-mail-time`、`fd-mail-replyrow`、`fd-mail-input`、`fd-mail-note`。

- [ ] **Step 1: styles.css 追加**(P3.5 配对样式块之后):

```css
/* ── 觅食台:✉️ 笔友信箱 ───────────────────────────────────────── */
.fd-mail-chan { border: 1px solid var(--fd-line-soft); border-radius: 12px; margin-bottom: 10px; overflow: hidden; }
.fd-mail-head { display: flex; align-items: center; gap: 8px; padding: 11px 14px; cursor: pointer; flex-wrap: wrap; }
.fd-mail-peer { font-weight: 600; }
.fd-mail-title { font-size: 12.5px; opacity: .8; }
.fd-mail-unread { background: var(--fd-clay-deep); color: #fff; border-radius: 999px; font-size: 11px; line-height: 1; padding: 3px 7px; }
.fd-mail-preview { font-size: 12px; opacity: .6; flex: 1 1 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fd-mail-thread { border-top: 1px dashed var(--fd-line-soft); padding: 12px 14px; }
.fd-mail-bubbles { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.fd-mail-bubble { max-width: 78%; border-radius: 12px; padding: 8px 11px; border: 1px solid var(--fd-line-soft); }
.fd-mail-bubble.fd-in  { align-self: flex-start; }
.fd-mail-bubble.fd-out { align-self: flex-end; border-color: var(--fd-sage); }
.fd-mail-text { white-space: pre-wrap; word-break: break-word; }
.fd-mail-time { font-size: 11px; opacity: .55; margin-top: 3px; }
.fd-mail-replyrow { display: flex; gap: 8px; }
.fd-mail-input { flex: 1 1 auto; padding: 9px 12px; border: 1px solid var(--fd-line-soft); border-radius: 10px; font: inherit; color: inherit; background: transparent; }
.fd-mail-note { margin-top: 8px; font-size: 12.5px; color: var(--fd-clay-deep); }
```

- [ ] **Step 2: 全量回归** —— 仓库根 `bun run test`,全绿(本分支动了后端,任何红都先查是不是自己引的)。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/styles.css
git commit -m "style(desktop): 笔友信箱样式(信道卡/气泡线程/回信行)"
```

---

## Self-Review 结论(已跑)

- **Spec 覆盖**:store 查询=T1;暴露+4 路由+定级评审旗=T2;信箱 UI(卡/线程/即读/回信/未读角标/空态/引导)=T3;CSS=T4;密文不外传断言=T2 测试;非目标(断交/推送/CLI 回信)未实现 ✅。
- **占位符**:无。
- **一致性**:`deps.social.penpal` 可选(fixture 兼容)但 boot 侧必带;letters newest-first 在 T2 Produces 与 T3 renderMailThread reverse 注释两处一致;`MAIL_FAIL_COPY` 键与 correspondent 错误串(channel_not_open/no_route/send_failed)对齐;route-tiers 全量断言(test:54)由 4 条显式条目满足。
