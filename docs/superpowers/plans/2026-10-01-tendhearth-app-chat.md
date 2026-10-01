# Tendhearth app · 跟 CC 说话、看真历史、看 CC 的连接 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机 app 的主动作变成跟 CC 本人说话(异步回复)、看到主人那条对话的完整历史并能往上翻、「一起做」只列真实在动的事且把 CC 对话置顶、进展页显示真对话、新增「CC 的连接」卡与只读的「电脑上的会话」。

**Architecture:** daemon 加三组手机路由:`/m/api/chat*`(新文件 `mobile-chat.ts`,背后是内存任务表 `phone-chat.ts` 包住 `companionConverse`,收下即回,结果经 `matter/<聊天>` 主题唤醒手机去拉)、`/m/api/connections`(纯函数 `connections.ts` 从插件快照 / 解密库时间 / 知识库 / 工作台拼出快照,手机拿去掉 `detail` 的版本,admin 的 `/v1/connections` 拿全量)、`/m/api/sessions|session`(新文件 `mobile-reads.ts`,裁剪工作台已有的 native-history,10 秒预算)。matter 的 `updated_at` 由一个节流器在微信入站与工作台事件时往前推;聊天主题版本改成「matter 时间与最新消息时间取大」。app 侧 `Backend` 加五个方法,新页 `/chat`、`/connections`、`/sessions`,视图模型全是纯函数。

**Tech Stack:** Bun daemon、TypeScript、zod v4、vitest(bun + node 两遍)、`@wechat-cc/protocol`、Expo SDK 57 / Expo Router / React Native 0.86、Maestro。

**Spec:** `docs/superpowers/specs/2026-10-01-tendhearth-app-chat-design.md`(增补 `2026-09-30-tendhearth-app-v1-design.md`)。前序计划:`2026-09-30-tendhearth-app-{backend,skeleton,live,push}.md`(规矩沿用)。依据:主人真机调查 `phone-chat-investigation.md`(A、C、路由 #3,修复排序 2–6)。

## Global Constraints

- 工作树 `.claude/worktrees/deploy-dev`,分支 `app-chat`(基于 `origin/dev` 2caf4b63),PR 进 `dev`(squash);不切分支、不碰兄弟工作树、不用 `git stash`、不暂存 `.superpowers/`。提交信息末尾空一行加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 新手机路由**三处同时登记**:`src/daemon/phone-routes.ts` 的 `PHONE_ROUTES`、`packages/protocol/src/api.ts` 的 `PHONE_API_SCHEMAS`、路由判断写成 `url.pathname === '/m/api/…'` 字面形式(`scripts/phone-routes.guard.test.ts` 靠正则抓;本计划把 `mobile-chat.ts`、`mobile-reads.ts` 加进它扫的文件)。真实返回在 `src/daemon/phone-api-schema.test.ts` 里 `parse`。
- 新内部 API 路由登记 `src/daemon/internal-api/route-tiers.ts` 的 `ROUTE_MIN_TIER`(`GET /v1/connections` = `admin`)。
- **admin 以下不给路径与原因原文**:手机拿的连接快照经 `redactConnections`(没有 `detail`);原生会话只给项目目录名(`basename(cwd)`),不给 `cwd` / `nativeId`。
- 手机路由不能让隧道等过 15 秒:读原生会话包 `PHONE_SESSIONS_BUDGET_MS = 10_000` 预算;说一句收下即回,`companionConverse` 在后台跑。
- 回包大小:对话一页至多 `CHAT_PAGE_MAX = 30` 条、每条 `CHAT_TEXT_MAX = 4000` 字(超了截断并标 `truncated: true`);原生会话一页 20 条、每条 4000 字;列表 30 行。
- 重入:工作台 `changes.onChange` 回调里只许记一笔 / 排定时器 / `events.poke()`,不同步写库、不回头读工作台(第 8 步规矩)。协议客户端 `onStatus` 钩子里不同步回调客户端(live.ts 既有规矩,本计划不碰)。
- 节流:`updated_at` 往前推每件事至多每 `MATTER_TOUCH_MIN_MS = 5_000` 一次,最后一次一定落地(trailing)。
- 不重试风暴:说一句失败不自动重发,只给「重试」按钮;同一 `requestId` 重发只在上次失败时重跑。
- zod v4 一律 `import z from 'zod'`;读 JSON 文件用 `readJsonFile`。
- 改了 `packages/protocol` ⇒ 若 `apps/mobile/build.test.ts` 报生成物不同步,跑 `bun run build:mobile` 并一起提交生成物。
- 被根目录测试 import 的 app 文件(`src/backend/{live,types}.ts`、`src/net/errors.ts`、本计划新增的 `src/view/chat.ts`)必须纯 TS:不 import `react` / `react-native` / `expo-*`,类型 `import type`,数组下标带 `!` 或判空。
- 所有面向用户的字符串进 `apps/app/src/i18n/en.ts` 与 `zh-Hans.ts`(两份键一致,`i18n.test.ts` 钉住);状态都配文字,颜色只是辅助。
- 桌面端本计划**不改**(桌面连接卡、配对三件事在 Next plan)。
- 回路(看退出码,别 grep):
  - 根:`bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck`
  - app:`cd apps/app && bun run test && bun run typecheck && bun run export:check`

## Review Focus

1. **手机刚说完一句,daemon 重启了(或 `self deploy`)**:内存任务表没了 ⇒ `GET /m/api/chat` 回 `pending: null, failed: null`,而历史里也没有这句(只有落地成功的轮次才写进 messages)。手机必须显示「这句可能没送到」而不是永远「在想…」:app 记住自己刚收到回执的 `requestId`,下一页既不 pending 也不在历史里 ⇒ 显示「没送到 · 重试」(Task 10 `chatBubbles` 测试「本地回执丢失」)。
2. **手机上那句在等回复时,主人又在微信里说了一句**:微信那轮先跑 ⇒ 手机这句 `reply_sink_busy` ⇒ 任务 `failed: busy`,手机显示「CC 正在回微信那边,等一下再发」;不自动重发(Task 3 测试)。
3. **自检 / 访客产生的大量 chat matter**:`/m/api/matters` 默认不含归档、「一起做」不列任何 chat matter(主人对话单独置顶),访客的聊天不会出现在主人手机上(Task 1、Task 10 测试)。
4. **工作台流式输出一秒几十次事件**:节流器每件事 5 秒至多写一次库,`onChange` 回调里不写库(Task 2 测试「同一拍 100 次 note 只排一次」)。
5. **连接卡说谎**:插件快照还没出来时不能显示「已连上」也不能显示「没加载」——一律「不知道」;知识库没开就不出现(不是红);路径与原因原文绝不经手机路由出去(Task 6 测试对快照做 `JSON.stringify` 断言不含 `/Users`、`/home`、`:\\`)。

---

## File Structure

```
packages/protocol/src/api.ts           + ChatMessage、ChatJob、ChatPage、CHAT_PAGE_MAX、CHAT_TEXT_MAX、ConnectionSource、Connections、
                                         NativeSessionRow、NativeSessionMessage、NativeSessionPage;PHONE_API_SCHEMAS 五条
packages/protocol/src/index.ts         导出上面这些(若 api.ts 已 export * 则不动)
src/daemon/settings-panel.ts           /m/api/matters 默认 status;挂 mobileChatRoute / mobileReadsRoute;deps + chat/connections/sessions
src/daemon/matter-activity.ts          新:节流推 updated_at(note / dispose)+ ensureChatAndNote
src/daemon/phone-chat.ts               新:说一句的内存任务表(收下即回、按 requestId 去重、一次一句)
src/daemon/mobile-chat.ts              新:GET /m/api/chat、POST /m/api/chat/say
src/daemon/connections.ts              新:buildConnections / redactConnections(纯)
src/daemon/mobile-reads.ts             新:GET /m/api/connections、/m/api/sessions、/m/api/session
src/daemon/phone-topic-sources.ts      聊天主题版本 = max(updatedAt, 最新消息时间);等回复时 phase=working
src/daemon/phone-routes.ts             PHONE_ROUTES + 5 条
src/daemon/internal-api/routes-connections.ts  新:GET /v1/connections(admin)
src/daemon/internal-api/{routes.ts,route-tiers.ts,types.ts,index.ts}   接上 + setConnections
src/daemon/wiring/pipeline-deps.ts     接线:matterActivity、phoneChat、connections、sessions;返回 connections
src/daemon/main.ts                     internalApi.setConnections(wired.connections)
src/core/knowledge/store.ts            + latestMessageAtMs()
scripts/phone-routes.guard.test.ts     扫描加 mobile-chat.ts、mobile-reads.ts
src/daemon/*.test.ts                   各自测试;phone-api-schema.test.ts、phone-app-live-e2e.test.ts 增补
apps/app/src/backend/{types,live,demo,demo-data}.ts   + chat / chatSay / connections / sessions / session
apps/app/src/net/errors.ts             chat_busy ⇒ busy;no_owner_chat / unsupported ⇒ not_found;*_not_wired、503 unavailable ⇒ unavailable
apps/app/src/view/chat.ts              新:合并分页、气泡(含 pending / failed / 本地回执丢失)
apps/app/src/view/conversation.ts      新:任务事件 ⇒ 对话
apps/app/src/view/connections.ts       新:连接卡视图
apps/app/src/view/sessions.ts          新:会话行
apps/app/src/view/{progress,together,now}.ts   骨架屏修复;一起做 / 此刻不列 chat matter
apps/app/src/state/useChat.ts          新:最新一页查询 + 主题唤醒 + 往上翻 + 发送 / 重试
apps/app/src/app/chat.tsx              新:跟 CC 说
apps/app/src/app/connections.tsx       新:CC 的连接
apps/app/src/app/sessions/index.tsx  sessions/[key].tsx   新:电脑上的会话
apps/app/src/app/{(tabs)/index,(tabs)/together,matter/[id],compose,settings}.tsx   入口改道、置顶行、对话节、交办改名、设置入口
apps/app/src/i18n/{en,zh-Hans}.ts      新文案
apps/app/.maestro/{chat,connections,compose}.yaml   新 / 改流程
docs/roadmap.md  docs/INDEX.md  apps/app/README.md
```

---

### Task 1: `/m/api/matters` 默认不含归档

**Files:**
- Modify: `src/daemon/settings-panel.ts`(`/m/api/matters` 分支,约 698–705 行)
- Test: `src/daemon/settings-panel.test.ts`(`describe` 里 `lists, details and says` 之后)

**Interfaces:**
- Produces:不带 `status` ⇒ `matters.list({ statuses: ['open','replied','done'], limit: 50 })`(带 `kind` 时多一个 `kind`);带 `status` 照旧。

- [ ] **Step 1: 写失败的测试**

```ts
  it('不带 status ⇒ 默认只要 open / replied / done(归档的自检噪声不占前 50)', async () => {
    panel = make(true)
    const { port } = await panel.start(0), base = `http://127.0.0.1:${port}`, t = panel.issueToken()
    await fetch(`${base}/m/api/matters?t=${t}`)
    expect(matters.list).toHaveBeenLastCalledWith({ statuses: ['open', 'replied', 'done'], limit: 50 })
    await fetch(`${base}/m/api/matters?kind=task&t=${t}`)
    expect(matters.list).toHaveBeenLastCalledWith({ kind: 'task', statuses: ['open', 'replied', 'done'], limit: 50 })
    await fetch(`${base}/m/api/matters?status=archived&t=${t}`)
    expect(matters.list).toHaveBeenLastCalledWith({ statuses: ['archived'], limit: 50 })
  })
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/settings-panel.test.ts -t "默认只要"`
Expected: FAIL —— 第一次调用没有 `statuses`。

- [ ] **Step 3: 实现**

把那一行 `const matters = deps.matters.list(...)` 换成:

```ts
            // 不带 status ⇒ 不含归档(真机 2026-09-30:前 50 条里 49 条是归档的自检任务,「一起做」只剩一条)。
            const statuses = (status ? status.split(',') : ['open', 'replied', 'done']) as Array<'open' | 'replied' | 'done' | 'archived'>
            const matters = deps.matters.list({ ...(kind ? { kind: kind as 'chat' | 'task' | 'companion' } : {}), statuses, limit: 50 })
```

- [ ] **Step 4: 跑,确认通过(含原有用例)**

Run: `bun --bun vitest run src/daemon/settings-panel.test.ts src/daemon/phone-api-schema.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/settings-panel.ts src/daemon/settings-panel.test.ts
git commit -m "手机 /m/api/matters 默认不含归档

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 节流推 `updated_at`(微信入站 + 工作台事件)

**Files:**
- Create: `src/daemon/matter-activity.ts`、`src/daemon/matter-activity.test.ts`
- Modify: `src/daemon/wiring/pipeline-deps.ts`(约 828 行 `matter:{ensureChat…}`;工作台 `changes.onChange` 订阅)

**Interfaces:**
- Produces:
  - `export const MATTER_TOUCH_MIN_MS = 5_000`
  - `export interface MatterActivity { note(id: string): void; dispose(): void }`
  - `export function makeMatterActivity(d: { touch(id: string): void; minIntervalMs?: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void; defer?: (fn: () => void) => void; log?: (tag: string, line: string) => void }): MatterActivity`
  - `export function ensureChatAndNote<M extends { id: string }>(ensure: (chatId: string) => M, activity: Pick<MatterActivity, 'note'> | null): (chatId: string) => M`
- 语义:`note` 本身不写库(先 `defer` 再写);距上次写不足 `min` ⇒ 排一个 trailing 定时器(每件事至多一个);`touch` 抛 `matter_not_found` 静默,其它错误记一行。

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, expect, it, vi } from 'vitest'
import { ensureChatAndNote, makeMatterActivity, MATTER_TOUCH_MIN_MS } from './matter-activity'

function rig() {
  let t = 1_000_000
  const timers: Array<{ at: number; fn: () => void; dead: boolean }> = []
  const deferred: Array<() => void> = []
  const touch = vi.fn()
  const logs: string[] = []
  const a = makeMatterActivity({
    touch, now: () => t,
    setTimer: (fn, ms) => { const h = { at: t + ms, fn, dead: false }; timers.push(h); return h },
    clearTimer: h => { (h as { dead: boolean }).dead = true },
    defer: fn => deferred.push(fn),
    log: (_tag, line) => logs.push(line),
  })
  const flush = () => { for (const f of deferred.splice(0)) f() }
  const advance = (ms: number) => { t += ms; for (const h of timers) if (!h.dead && h.at <= t) { h.dead = true; h.fn() } }
  return { a, touch, flush, advance, timers, logs }
}

describe('makeMatterActivity', () => {
  it('第一次 note 不同步写库,排到 defer 之后写一次', () => {
    const r = rig()
    r.a.note('deadbeef')
    expect(r.touch).not.toHaveBeenCalled()
    r.flush()
    expect(r.touch).toHaveBeenCalledTimes(1)
  })
  it('同一拍 100 次 note 只写一次 + 至多一个 trailing 定时器;trailing 在 5 秒后落地', () => {
    const r = rig()
    for (let i = 0; i < 100; i++) r.a.note('deadbeef')
    r.flush()
    expect(r.touch).toHaveBeenCalledTimes(1)
    expect(r.timers.filter(h => !h.dead)).toHaveLength(1)
    r.advance(MATTER_TOUCH_MIN_MS - 1); expect(r.touch).toHaveBeenCalledTimes(1)
    r.advance(1); expect(r.touch).toHaveBeenCalledTimes(2)
  })
  it('不同的事各自节流', () => {
    const r = rig()
    r.a.note('aaaaaaaa'); r.a.note('bbbbbbbb'); r.flush()
    expect(r.touch.mock.calls.map(c => c[0]).sort()).toEqual(['aaaaaaaa', 'bbbbbbbb'])
  })
  it('matter_not_found 静默;其它错误记一行,不抛', () => {
    const r = rig()
    r.touch.mockImplementationOnce(() => { throw new Error('matter_not_found') })
    r.a.note('aaaaaaaa'); r.flush()
    expect(r.logs).toEqual([])
    r.touch.mockImplementationOnce(() => { throw new Error('disk') })
    r.a.note('bbbbbbbb'); expect(() => r.flush()).not.toThrow()
    expect(r.logs).toHaveLength(1)
  })
  it('dispose 之后不再写、定时器清掉', () => {
    const r = rig()
    r.a.note('aaaaaaaa'); r.flush(); r.a.note('aaaaaaaa')
    r.a.dispose(); r.advance(MATTER_TOUCH_MIN_MS * 2); r.a.note('cccccccc'); r.flush()
    expect(r.touch).toHaveBeenCalledTimes(1)
  })
  it('ensureChatAndNote:原样返回 ensureChat 的结果并记一笔;activity 为 null 也能用', () => {
    const note = vi.fn()
    const f = ensureChatAndNote(c => ({ id: 'deadbeef', c }), { note })
    expect(f('wx@chat')).toEqual({ id: 'deadbeef', c: 'wx@chat' })
    expect(note).toHaveBeenCalledWith('deadbeef')
    expect(ensureChatAndNote(() => ({ id: 'x' }), null)('c')).toEqual({ id: 'x' })
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/matter-activity.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/daemon/matter-activity.ts`**

```ts
/**
 * matter-activity.ts — 把「这件事刚有动静」节流地写成 matters.updated_at(spec 2026-10-01 §3)。
 *
 * 为什么:微信入站只刷绑定的露面时间、任务事件只在状态变化时才动 updated_at ⇒ 天天在微信聊,
 * 聊天 matter 排不上来;一直开着的长任务往下沉(真机调查 C)。
 * 重入:工作台 changes.onChange 回调里会调 note() —— note 只记一笔、排 defer / 定时器,从不同步写库。
 */
export const MATTER_TOUCH_MIN_MS = 5_000

export interface MatterActivity { note(id: string): void; dispose(): void }

export function makeMatterActivity(d: {
  touch(id: string): void
  minIntervalMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  defer?: (fn: () => void) => void
  log?: (tag: string, line: string) => void
}): MatterActivity {
  const min = d.minIntervalMs ?? MATTER_TOUCH_MIN_MS
  const now = d.now ?? (() => Date.now())
  const setTimer = d.setTimer ?? ((fn: () => void, ms: number) => { const h = setTimeout(fn, ms); (h as { unref?: () => void }).unref?.(); return h })
  const clearTimer = d.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const defer = d.defer ?? ((fn: () => void) => queueMicrotask(fn))
  const last = new Map<string, number>()
  const timers = new Map<string, unknown>()
  let disposed = false
  const write = (id: string) => {
    if (disposed) return
    last.set(id, now())
    try { d.touch(id) } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      if (m !== 'matter_not_found') d.log?.('MATTER', `touch ${id} failed: ${m}`)
    }
  }
  const prune = () => {
    if (last.size <= 1000) return
    const cutoff = now() - min
    for (const [id, at] of last) if (at < cutoff && !timers.has(id)) last.delete(id)
  }
  return {
    note(id) {
      if (disposed || timers.has(id)) return
      const prev = last.get(id)
      const since = prev === undefined ? Infinity : now() - prev
      if (since >= min) {
        last.set(id, now())          // 先占位:同一拍里后面的 note 走 trailing,不再排第二次 defer
        defer(() => write(id))
        prune()
        return
      }
      timers.set(id, setTimer(() => { timers.delete(id); write(id) }, min - since))
    },
    dispose() {
      disposed = true
      for (const h of timers.values()) clearTimer(h)
      timers.clear()
    },
  }
}

/** 微信入站:ensureChat 之后顺手记一笔(mw-matter 的依赖形状不变)。 */
export function ensureChatAndNote<M extends { id: string }>(ensure: (chatId: string) => M, activity: Pick<MatterActivity, 'note'> | null): (chatId: string) => M {
  return chatId => { const m = ensure(chatId); activity?.note(m.id); return m }
}
```

- [ ] **Step 4: 跑,确认通过**

Run: `bun --bun vitest run src/daemon/matter-activity.test.ts`
Expected: PASS。

- [ ] **Step 5: 接线(`pipeline-deps.ts`)**

在 `const mattersService = …` 之前加:

```ts
  // 「一件事」的活动时间(spec 2026-10-01 §3):微信入站与工作台事件节流地推 updated_at。随 daemon 常驻。
  const matterActivity = opts.matters ? makeMatterActivity({ touch: id => opts.matters!.touch(id), log: (tag, line) => log(tag, line) }) : null
  // 回调里只记一笔(note 不同步写库,见 matter-activity.ts 头注释)。
  opts.workbench?.changes.onChange(taskId => matterActivity?.note(taskId))
```

把约 828 行改成:

```ts
    ...(opts.matters?{matter:{ensureChat:ensureChatAndNote((c:string)=>opts.matters!.ensureChat(c),matterActivity),log:(t:string,l:string)=>log(t,l)}}:{}),
```

文件顶部 `import { ensureChatAndNote, makeMatterActivity } from '../matter-activity'`。

- [ ] **Step 6: 回路**

Run: `bun --bun vitest run src/daemon && bun run typecheck; echo tc=$?`
Expected: PASS,`tc=0`。

- [ ] **Step 7: Commit**

```bash
git add src/daemon/matter-activity.ts src/daemon/matter-activity.test.ts src/daemon/wiring/pipeline-deps.ts
git commit -m "matter 活动时间:微信入站与工作台事件节流推 updated_at

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 说一句的内存任务表(`phone-chat.ts`)

**Files:**
- Create: `src/daemon/phone-chat.ts`、`src/daemon/phone-chat.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ChatJobStatus = 'pending' | 'replied' | 'failed'
  export type ChatJobError = 'busy' | 'unavailable' | 'not_configured'
  export interface ChatJob { requestId: string; matterId: string; text: string; status: ChatJobStatus; since: number; error?: ChatJobError }
  export interface PhoneChat {
    /** 收下即回。抛 'no_owner_chat' | 'chat_busy'。 */
    say(requestId: string, text: string): ChatJob
    state(): { pending: ChatJob | null; failed: ChatJob | null }
    /** 正在等回复的那件事的 matterId(给主题来源)。 */
    pendingMatter(): string | null
  }
  export function makePhoneChat(d: {
    converse(text: string): Promise<{ reply: string }>
    ownerMatterId(): string | null
    onSettled?(matterId: string): void
    now?: () => number
    log?: (tag: string, line: string) => void
  }): PhoneChat
  export const PHONE_CHAT_JOB_TTL_MS = 3_600_000
  ```
- 规则:同一 `requestId` 且上次是 pending / replied ⇒ 原样返回,不起第二轮;上次是 failed ⇒ 重跑(这就是「重试」)。另一句在 pending ⇒ 抛 `chat_busy`。`converse` 抛 `reply_sink_busy` / `owner_chat_in_chatroom_mode` ⇒ `error: 'busy'`;`companion_owner_chat_not_configured` ⇒ `'not_configured'`;其它 ⇒ `'unavailable'`。`failed` = 最近一次结束的任务若是失败;新的 say 被接受时清掉。表至多 50 条、过期 1 小时。结束(成功或失败)都调 `onSettled(matterId)`(抛了也不影响)。日志只写 requestId 前 8 位与错误码,不写正文。

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, expect, it, vi } from 'vitest'
import { makePhoneChat } from './phone-chat'

const RID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function rig(over: Partial<Parameters<typeof makePhoneChat>[0]> = {}) {
  const calls: Array<{ text: string; resolve: (r: { reply: string }) => void; reject: (e: Error) => void }> = []
  const settled: string[] = []
  const chat = makePhoneChat({
    converse: text => new Promise((resolve, reject) => calls.push({ text, resolve, reject })),
    ownerMatterId: () => 'c0ffee01',
    onSettled: id => settled.push(id),
    now: () => 1000,
    ...over,
  })
  return { chat, calls, settled }
}
const tick = () => new Promise(r => setTimeout(r, 0))

describe('makePhoneChat', () => {
  it('收下即回 pending;回复到了 ⇒ 不再 pending、onSettled 一次', async () => {
    const r = rig()
    const job = r.chat.say(RID(1), '你好')
    expect(job).toMatchObject({ requestId: RID(1), matterId: 'c0ffee01', status: 'pending', text: '你好' })
    expect(r.chat.pendingMatter()).toBe('c0ffee01')
    r.calls[0]!.resolve({ reply: '在呢' }); await tick()
    expect(r.chat.state()).toEqual({ pending: null, failed: null })
    expect(r.settled).toEqual(['c0ffee01'])
  })
  it('同一 requestId 再发(在飞 / 已回复)⇒ 同一份结果,不起第二轮', async () => {
    const r = rig()
    r.chat.say(RID(1), '你好'); r.chat.say(RID(1), '你好')
    expect(r.calls).toHaveLength(1)
    r.calls[0]!.resolve({ reply: 'x' }); await tick()
    expect(r.chat.say(RID(1), '你好').status).toBe('replied')
    expect(r.calls).toHaveLength(1)
  })
  it('另一句还在等 ⇒ chat_busy', () => {
    const r = rig()
    r.chat.say(RID(1), 'a')
    expect(() => r.chat.say(RID(2), 'b')).toThrow('chat_busy')
  })
  it('微信那轮在跑(reply_sink_busy)⇒ failed busy;不自动重发;同一 requestId 再发 = 重试', async () => {
    const r = rig()
    r.chat.say(RID(1), 'a')
    r.calls[0]!.reject(new Error('reply_sink_busy')); await tick()
    expect(r.chat.state().failed).toMatchObject({ requestId: RID(1), status: 'failed', error: 'busy' })
    await tick(); expect(r.calls).toHaveLength(1)
    expect(r.chat.say(RID(1), 'a').status).toBe('pending')
    expect(r.calls).toHaveLength(2)
    expect(r.chat.state().failed).toBeNull()
  })
  it('错误码映射:未配主人 ⇒ not_configured;其它 ⇒ unavailable', async () => {
    const r = rig()
    r.chat.say(RID(1), 'a'); r.calls[0]!.reject(new Error('companion_owner_chat_not_configured')); await tick()
    expect(r.chat.state().failed?.error).toBe('not_configured')
    r.chat.say(RID(2), 'b'); r.calls[1]!.reject(new Error('boom')); await tick()
    expect(r.chat.state().failed?.error).toBe('unavailable')
  })
  it('没配主人对话 ⇒ no_owner_chat,不调 converse', () => {
    const r = rig({ ownerMatterId: () => null })
    expect(() => r.chat.say(RID(1), 'a')).toThrow('no_owner_chat')
    expect(r.calls).toHaveLength(0)
  })
  it('onSettled 抛错不影响任务结束', async () => {
    const r = rig({ onSettled: () => { throw new Error('x') } })
    r.chat.say(RID(1), 'a'); r.calls[0]!.resolve({ reply: 'y' }); await tick()
    expect(r.chat.state().pending).toBeNull()
  })
  it('日志不含正文', async () => {
    const logs: string[] = []
    const r = rig({ log: (_t, l) => logs.push(l) })
    r.chat.say(RID(1), '秘密内容'); r.calls[0]!.reject(new Error('boom')); await tick()
    expect(logs.join('\n')).not.toContain('秘密内容')
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/phone-chat.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `src/daemon/phone-chat.ts`**

```ts
/**
 * phone-chat.ts — 手机「跟 CC 说」(spec 2026-10-01 §1.1、§3):收下即回,companionConverse 在后台跑,
 * 回复经 matter/<聊天> 主题唤醒手机去拉。隧道约 15 秒没流量就断,所以不能同步等回复。
 * 表只在内存:daemon 重启就忘(手机按「可能没送到」处理,见 apps/app/src/view/chat.ts)。
 */
export type ChatJobStatus = 'pending' | 'replied' | 'failed'
export type ChatJobError = 'busy' | 'unavailable' | 'not_configured'
export interface ChatJob { requestId: string; matterId: string; text: string; status: ChatJobStatus; since: number; error?: ChatJobError }
export interface PhoneChat {
  say(requestId: string, text: string): ChatJob
  state(): { pending: ChatJob | null; failed: ChatJob | null }
  pendingMatter(): string | null
}
export const PHONE_CHAT_JOB_TTL_MS = 3_600_000
const MAX_JOBS = 50

const errorOf = (e: unknown): ChatJobError => {
  const m = e instanceof Error ? e.message : ''
  if (m === 'reply_sink_busy' || m === 'owner_chat_in_chatroom_mode') return 'busy'
  if (m === 'companion_owner_chat_not_configured') return 'not_configured'
  return 'unavailable'
}

export function makePhoneChat(d: {
  converse(text: string): Promise<{ reply: string }>
  ownerMatterId(): string | null
  onSettled?(matterId: string): void
  now?: () => number
  log?: (tag: string, line: string) => void
}): PhoneChat {
  const now = d.now ?? (() => Date.now())
  const jobs = new Map<string, ChatJob>()
  let pending: ChatJob | null = null
  let failed: ChatJob | null = null
  const sweep = () => {
    const cutoff = now() - PHONE_CHAT_JOB_TTL_MS
    for (const [k, j] of jobs) if (j.status !== 'pending' && (j.since < cutoff || jobs.size > MAX_JOBS)) jobs.delete(k)
  }
  const settle = (job: ChatJob) => {
    if (pending === job) pending = null
    try { d.onSettled?.(job.matterId) } catch { /* 唤醒失败不影响结果 */ }
  }
  const run = (job: ChatJob) => {
    pending = job; failed = null
    d.converse(job.text).then(
      () => { job.status = 'replied'; settle(job) },
      e => {
        job.status = 'failed'; job.error = errorOf(e); failed = job
        d.log?.('PHONE_CHAT', `say ${job.requestId.slice(0, 8)} failed: ${job.error}`)
        settle(job)
      },
    )
  }
  return {
    say(requestId, text) {
      const seen = jobs.get(requestId)
      if (seen && seen.status !== 'failed') return { ...seen }
      if (pending && pending.requestId !== requestId) throw new Error('chat_busy')
      const matterId = d.ownerMatterId()
      if (!matterId) throw new Error('no_owner_chat')
      const job: ChatJob = { requestId, matterId, text, status: 'pending', since: now() }
      jobs.set(requestId, job); sweep()
      run(job)
      return { ...job }
    },
    state: () => ({ pending: pending ? { ...pending } : null, failed: failed ? { ...failed } : null }),
    pendingMatter: () => pending?.matterId ?? null,
  }
}
```

- [ ] **Step 4: 跑,确认通过(bun + node)**

Run: `bun --bun vitest run src/daemon/phone-chat.test.ts && npx vitest run src/daemon/phone-chat.test.ts`
Expected: PASS 两遍。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/phone-chat.ts src/daemon/phone-chat.test.ts
git commit -m "手机说一句:收下即回的内存任务表(按 requestId 去重、一次一句、失败可重试)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 手机对话路由 `GET /m/api/chat`、`POST /m/api/chat/say`

**Files:**
- Modify: `packages/protocol/src/api.ts`(schema + 常量 + `PHONE_API_SCHEMAS` 两条)
- Create: `src/daemon/mobile-chat.ts`、`src/daemon/mobile-chat.test.ts`
- Modify: `src/daemon/phone-routes.ts`、`scripts/phone-routes.guard.test.ts`、`src/daemon/settings-panel.ts`(deps + 挂路由)、`src/daemon/wiring/pipeline-deps.ts`、`src/daemon/phone-api-schema.test.ts`

**Interfaces:**
- Consumes:`PhoneChat`、`ChatJob`(Task 3);`MessageRecord`(`src/lib/messages-store.ts`)。
- Produces(协议包):
  ```ts
  export const CHAT_PAGE_MAX = 30
  export const CHAT_TEXT_MAX = 4000
  export const ChatMessage = z.object({ id: z.string(), role: z.enum(['me', 'cc']), kind: z.string(), text: z.string(), truncated: z.boolean(), at: z.number(), source: z.enum(['wechat', 'desktop', 'phone']) })
  export const ChatJob = z.object({ requestId: z.string(), text: z.string(), status: z.enum(['pending', 'replied', 'failed']), since: z.number(), error: z.enum(['busy', 'unavailable', 'not_configured']).optional() })
  export const ChatPage = z.object({ matterId: z.string(), title: z.string(), messages: z.array(ChatMessage), hasMore: z.boolean(), nextBefore: z.string().nullable(), pending: ChatJob.nullable(), failed: ChatJob.nullable() })
  // PHONE_API_SCHEMAS:
  'GET /m/api/chat': z.union([z.object({ ok: z.literal(true) }).extend(ChatPage.shape), PhoneErrorResponse]),
  'POST /m/api/chat/say': z.union([z.object({ ok: z.literal(true), matterId: z.string(), job: ChatJob }), PhoneErrorResponse]),
  ```
- Produces(daemon):
  ```ts
  export interface MobileChatDeps {
    owner(): { matterId: string; chatId: string; title: string } | null
    history(chatId: string, opts: { beforeTs?: string; limit: number }): Promise<MessageRecord[]>
    chat: PhoneChat
  }
  export async function mobileChatRoute(deps: MobileChatDeps | undefined, url: URL, req: Request): Promise<Response | null>
  ```
  `SettingsPanelDeps.chat?: MobileChatDeps`。错误:`chat_not_wired` 503、`invalid` 400、`no_owner_chat` 404、`chat_busy` 409、方法不对 405。消息投影:`direction==='in'` ⇒ `me`,否则 `cc`;`source` `'desktop'|'phone'` 原样,其余 ⇒ `'wechat'`;`at = Date.parse(ts)`;`nextBefore` = 本页最旧一条的**原始** `ts` 字符串(不重新格式化)。返回的 job 不带 `matterId`(外层已有)。

- [ ] **Step 1: 协议 schema**

在 `api.ts` 的 `PhoneChangesTurn` 之后加上面 Produces 里的常量与三个 schema;`PHONE_API_SCHEMAS` 加两条。`index.ts` 若不是 `export *`,把 `ChatMessage, ChatJob, ChatPage, CHAT_PAGE_MAX, CHAT_TEXT_MAX` 加进导出,并加类型导出 `export type ChatPageT = z.infer<typeof ChatPage>` 等三种(放 api.ts 末尾)。

- [ ] **Step 2: 写失败的路由测试 `src/daemon/mobile-chat.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest'
import { PHONE_API_SCHEMAS } from '@wechat-cc/protocol'
import { mobileChatRoute, type MobileChatDeps } from './mobile-chat'
import type { MessageRecord } from '../lib/messages-store'

const RID = '00000000-0000-4000-8000-000000000001'
const rec = (i: number, over: Partial<MessageRecord> = {}): MessageRecord => ({ id: `m${i}`, chatId: 'wx', ts: new Date(Date.UTC(2026, 8, 30, 0, 0, i)).toISOString(), direction: i % 2 ? 'out' : 'in', kind: 'text', text: `t${i}`, source: 'live', ...over })
function deps(over: Partial<MobileChatDeps> = {}): MobileChatDeps {
  return {
    owner: () => ({ matterId: 'c0ffee01', chatId: 'wx', title: '聊天' }),
    history: vi.fn(async (_c, o) => Array.from({ length: o.limit }, (_, i) => rec(i))),
    chat: { say: vi.fn(() => ({ requestId: RID, matterId: 'c0ffee01', text: 'hi', status: 'pending' as const, since: 1 })), state: () => ({ pending: null, failed: null }), pendingMatter: () => null },
    ...over,
  }
}
const get = (q = '') => new Request(`http://x/m/api/chat${q}`)
const post = (body: unknown) => new Request('http://x/m/api/chat/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const call = async (d: MobileChatDeps | undefined, r: Request) => { const res = await mobileChatRoute(d, new URL(r.url), r); return { status: res!.status, body: await res!.json() as any } }

describe('mobileChatRoute', () => {
  it('不是这两条路径 ⇒ null', async () => {
    expect(await mobileChatRoute(deps(), new URL('http://x/m/api/matters'), get())).toBeNull()
  })
  it('一页 30 条:多取一条判 hasMore,nextBefore 是本页最旧一条的原始 ts;过 schema', async () => {
    const d = deps()
    const r = await call(d, get())
    expect(d.history).toHaveBeenCalledWith('wx', { limit: 31 })
    expect(r.body.messages).toHaveLength(30)
    expect(r.body.hasMore).toBe(true)
    expect(r.body.nextBefore).toBe(rec(1).ts)
    expect(r.body.messages[0]).toMatchObject({ id: 'm1', role: 'cc', source: 'wechat', truncated: false })
    PHONE_API_SCHEMAS['GET /m/api/chat']!.parse(r.body)
  })
  it('before 原样传下去;不够一页 ⇒ hasMore false、nextBefore null', async () => {
    const d = deps({ history: vi.fn(async () => [rec(0), rec(1)]) })
    const r = await call(d, get('?before=2026-09-30T00%3A00%3A05.000Z&limit=10'))
    expect(d.history).toHaveBeenCalledWith('wx', { beforeTs: '2026-09-30T00:00:05.000Z', limit: 11 })
    expect(r.body).toMatchObject({ hasMore: false, nextBefore: null })
  })
  it('超长正文截到 4000 字并标 truncated;来源映射', async () => {
    const r = await call(deps({ history: async () => [rec(0, { text: 'x'.repeat(5000), source: 'phone' }), rec(1, { source: 'desktop' })] }), get())
    expect(r.body.messages[0].text).toHaveLength(4000)
    expect(r.body.messages[0]).toMatchObject({ truncated: true, source: 'phone', role: 'me' })
    expect(r.body.messages[1].source).toBe('desktop')
  })
  it('坏参数 ⇒ 400;没接 ⇒ 503;没主人 ⇒ 404', async () => {
    for (const q of ['?limit=0', '?limit=31', '?limit=x', '?before=nope', `?before=${'9'.repeat(70)}`]) expect((await call(deps(), get(q))).status).toBe(400)
    expect((await call(undefined, get())).status).toBe(503)
    expect((await call(deps({ owner: () => null }), get())).body).toEqual({ ok: false, error: 'no_owner_chat' })
  })
  it('say:收下即回 job,过 schema;各种坏输入 400;chat_busy 409;GET 405', async () => {
    const d = deps()
    const ok = await call(d, post({ requestId: RID, text: 'hi' }))
    expect(ok.status).toBe(200)
    expect(d.chat.say).toHaveBeenCalledWith(RID, 'hi')
    PHONE_API_SCHEMAS['POST /m/api/chat/say']!.parse(ok.body)
    expect(ok.body.job).not.toHaveProperty('matterId')
    for (const b of [{ requestId: 'x', text: 'hi' }, { requestId: RID, text: '  ' }, { requestId: RID, text: 'x'.repeat(20_001) }, { requestId: RID, text: 'hi', extra: 1 }]) expect((await call(d, post(b))).status).toBe(400)
    const busy = deps({ chat: { ...deps().chat, say: () => { throw new Error('chat_busy') } } })
    expect((await call(busy, post({ requestId: RID, text: 'hi' }))).status).toBe(409)
    expect((await call(d, new Request('http://x/m/api/chat/say'))).status).toBe(405)
  })
})
```

- [ ] **Step 3: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/mobile-chat.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现 `src/daemon/mobile-chat.ts`**

```ts
import { CHAT_PAGE_MAX, CHAT_TEXT_MAX, PHONE_SAY_MAX_CHARS } from '@wechat-cc/protocol'
import type { MessageRecord } from '../lib/messages-store'
import type { ChatJob, PhoneChat } from './phone-chat'

/**
 * mobile-chat.ts — 手机「跟 CC 说」的两条路由(spec 2026-10-01 §3)。路由字面量被
 * scripts/phone-routes.guard.test.ts 扫描,新增 / 改名要同步 PHONE_ROUTES 与 PHONE_API_SCHEMAS。
 */
export interface MobileChatDeps {
  owner(): { matterId: string; chatId: string; title: string } | null
  history(chatId: string, opts: { beforeTs?: string; limit: number }): Promise<MessageRecord[]>
  chat: PhoneChat
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const err = (error: string, status: number) => json({ ok: false, error }, status)
const wireJob = ({ requestId, text, status, since, error }: ChatJob) => ({ requestId, text, status, since, ...(error ? { error } : {}) })
const sourceOf = (s: string): 'wechat' | 'desktop' | 'phone' => (s === 'desktop' || s === 'phone' ? s : 'wechat')
const message = (r: MessageRecord) => ({
  id: r.id, role: r.direction === 'in' ? 'me' as const : 'cc' as const, kind: r.kind,
  text: r.text.length > CHAT_TEXT_MAX ? r.text.slice(0, CHAT_TEXT_MAX) : r.text, truncated: r.text.length > CHAT_TEXT_MAX,
  at: Date.parse(r.ts), source: sourceOf(r.source),
})

export async function mobileChatRoute(deps: MobileChatDeps | undefined, url: URL, req: Request): Promise<Response | null> {
  if (url.pathname === '/m/api/chat') {
    if (req.method !== 'GET') return err('method_not_allowed', 405)
    if (!deps) return err('chat_not_wired', 503)
    const rawLimit = url.searchParams.get('limit'), before = url.searchParams.get('before')
    if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > CHAT_PAGE_MAX)) return err('invalid', 400)
    if (before !== null && (before.length > 64 || !Number.isFinite(Date.parse(before)))) return err('invalid', 400)
    const owner = deps.owner()
    if (!owner) return err('no_owner_chat', 404)
    const limit = rawLimit === null ? CHAT_PAGE_MAX : Number(rawLimit)
    let rows: MessageRecord[]
    try { rows = await deps.history(owner.chatId, { ...(before !== null ? { beforeTs: before } : {}), limit: limit + 1 }) }
    catch { return err('unavailable', 503) }
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(rows.length - limit) : rows   // rows 升序:多出来的是最旧那条
    const st = deps.chat.state()
    return json({
      ok: true, matterId: owner.matterId, title: owner.title, messages: page.map(message), hasMore,
      nextBefore: hasMore && page.length ? page[0]!.ts : null,
      pending: st.pending ? wireJob(st.pending) : null, failed: st.failed ? wireJob(st.failed) : null,
    })
  }
  if (url.pathname === '/m/api/chat/say') {
    if (req.method !== 'POST') return err('method_not_allowed', 405)
    if (!deps) return err('chat_not_wired', 503)
    let body: unknown
    try { body = await req.json() } catch { return err('bad_json', 400) }
    const b = (body ?? {}) as Record<string, unknown>
    if (Object.keys(b).some(k => k !== 'requestId' && k !== 'text')) return err('invalid', 400)
    if (typeof b.requestId !== 'string' || !UUID.test(b.requestId) || typeof b.text !== 'string' || !b.text.trim() || b.text.length > PHONE_SAY_MAX_CHARS) return err('invalid', 400)
    const owner = deps.owner()
    if (!owner) return err('no_owner_chat', 404)
    try { return json({ ok: true, matterId: owner.matterId, job: wireJob(deps.chat.say(b.requestId, b.text)) }) }
    catch (e) {
      const m = e instanceof Error ? e.message : ''
      if (m === 'chat_busy') return err('chat_busy', 409)
      if (m === 'no_owner_chat') return err('no_owner_chat', 404)
      return err('unavailable', 500)
    }
  }
  return null
}
```

> 注:`hasMore` 时多取的那条在 `rows[0]`(升序),`slice(rows.length - limit)` 去掉它;测试里 `history` 返回 31 条 `rec(0..30)`,所以本页首条是 `m1`,`nextBefore = rec(1).ts`。

- [ ] **Step 5: 跑,确认通过**

Run: `bun --bun vitest run src/daemon/mobile-chat.test.ts`
Expected: PASS。

- [ ] **Step 6: 登记 + 守卫 + 面板挂载**

1. `phone-routes.ts` 的 `PHONE_ROUTES` 在 `'POST /m/api/matter/say',` 后加:
   ```ts
  // 跟 CC 说(spec 2026-10-01):主人对话一页 + 收下即回的说一句
  'GET /m/api/chat',
  'POST /m/api/chat/say',
   ```
2. `scripts/phone-routes.guard.test.ts` 的 `sourcePaths()`:`const mobile = read(...)` 改成读三份并入循环:
   ```ts
  const extra = ['mobile-workbench.ts', 'mobile-chat.ts', 'mobile-reads.ts'].map(f => read('src', 'daemon', f))
  for (const src of [panel, ...extra]) {
   ```
   (`mobile-reads.ts` 在 Task 7 才建 —— 本步先只加 `'mobile-chat.ts'`,Task 7 再加第三个。)
3. `settings-panel.ts`:deps 接口加
   ```ts
  /** 跟 CC 说(spec 2026-10-01):主人对话一页 + 说一句。缺省 ⇒ /m/api/chat* 503。 */
  chat?: import('./mobile-chat').MobileChatDeps
   ```
   在 `const mobileResponse=await mobileWorkbenchRoute(...)` 之后加:
   ```ts
          const chatResponse = await mobileChatRoute(deps.chat, url, req)
          if (chatResponse) return chatResponse
   ```
   顶部 `import { mobileChatRoute } from './mobile-chat'`。

- [ ] **Step 7: 接线(`pipeline-deps.ts`)**

在 `mattersService` 之后、`makeSettingsPanel` 之前:

```ts
  // 手机「跟 CC 说」(spec 2026-10-01):主人对话(ensureChat + 记手机露面)+ 收下即回的说一句。
  let phoneEvents: import('../phone-events').PhoneEvents | null = null
  const phoneOwner = () => {
    const chatId = ownerChatId()
    if (!chatId || !opts.matters) return null
    const m = opts.matters.ensureChat(chatId)
    try { opts.matters.bind(m.id, 'phone', 'pwa') } catch { /* 只是露面登记 */ }
    return { matterId: m.id, chatId, title: m.title }
  }
  // companionConverse 在下面才定义;这里只捕获引用,调用发生在请求到来时(与 mattersService 同一姿势)。
  const phoneChat = makePhoneChat({
    converse: text => companionConverse(text, 'phone'),
    ownerMatterId: () => phoneOwner()?.matterId ?? null,
    onSettled: id => { matterActivity?.note(id); phoneEvents?.poke() },
    log: (tag, line) => log(tag, line),
  })
```

`makeSettingsPanel({...})` 里加:

```ts
    chat: { owner: phoneOwner, history: (chatId, o) => messagesStore.listRange(chatId, o), chat: phoneChat },
```

`if (relays) {` 里 `const phone = makePhoneEventsWiring(...)` 之后加 `phoneEvents = phone.events`。顶部 `import { makePhoneChat } from '../phone-chat'`。

- [ ] **Step 8: 真实返回过 schema(`phone-api-schema.test.ts`)**

在「真实返回校验 — workbench + matters」的 `makeSettingsPanel({...})` 里加 `chat`(用真 messages store 与真 `makePhoneChat`,converse 给假的):

```ts
      chat: {
        owner: () => { const m = matters.ensureChat('owner'); return { matterId: m.id, chatId: 'owner', title: m.title } },
        history: (chatId, o) => makeMessagesStore(db).listRange(chatId, o),
        chat: makePhoneChat({ converse: async () => ({ reply: 'ok' }), ownerMatterId: () => matters.ensureChat('owner').id }),
      },
```

新用例:

```ts
  it('chat 一页与 chat/say 真实返回符合 schema', async () => {
    const ms = makeMessagesStore(db)
    for (let i = 0; i < 3; i++) await ms.append({ id: `x${i}`, chatId: 'owner', ts: new Date(Date.UTC(2026, 8, 30, 0, 0, i)).toISOString(), direction: i % 2 ? 'out' : 'in', kind: 'text', text: `t${i}`, source: 'live' })
    parseAs('GET /m/api/chat', await (await request('/m/api/chat?limit=2')).json())
    parseAs('POST /m/api/chat/say', await (await request('/m/api/chat/say', { requestId: randomUUID(), text: '你好' })).json())
  })
```

(顶部 `import { makeMessagesStore } from '../lib/messages-store'`、`import { makePhoneChat } from './phone-chat'`。)

- [ ] **Step 9: 回路**

Run: `bun --bun vitest run src/daemon scripts/phone-routes.guard.test.ts packages/protocol apps/mobile/build.test.ts && bun run typecheck; echo tc=$?`
Expected: PASS,`tc=0`。`apps/mobile/build.test.ts` 报生成物不同步 ⇒ `bun run build:mobile` 后重跑。

- [ ] **Step 10: Commit**

```bash
git add packages/protocol/src src/daemon/mobile-chat.ts src/daemon/mobile-chat.test.ts src/daemon/phone-routes.ts scripts/phone-routes.guard.test.ts src/daemon/settings-panel.ts src/daemon/wiring/pipeline-deps.ts src/daemon/phone-api-schema.test.ts
git commit -m "手机跟 CC 说:GET /m/api/chat(分页)+ POST /m/api/chat/say(收下即回)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 聊天主题版本反映真实消息 + 等回复的阶段

**Files:**
- Modify: `src/daemon/phone-topic-sources.ts`、`src/daemon/wiring/pipeline-deps.ts`
- Test: `src/daemon/phone-topic-sources.test.ts`

**Interfaces:**
- Consumes:`PhoneChat.pendingMatter()`(Task 3)。
- Produces:`PhoneTopicSourceDeps.chat?: { latestAt(chatId: string): Promise<number | null>; pendingMatter(): string | null }`。chat 类 matter 的快照 = `{ found: true, kind: 'chat', version: Math.max(m.updatedAt, latestAt ?? 0), phase: pendingMatter() === id ? 'working' : m.status }`;`latestAt` 抛 ⇒ 当 null;用 `m.ownerChatId` 当 chatId(为 null ⇒ 不查)。`matters` 依赖的 Pick 扩成 `Pick<MatterStore, 'get'>`(不变)。

- [ ] **Step 1: 写失败的测试**(加到 `phone-topic-sources.test.ts`)

```ts
describe('matter/<聊天> 主题', () => {
  const chatMatter = { id: 'c0ffee01', kind: 'chat' as const, title: '聊天', projectPath: null, status: 'open' as const, ownerChatId: 'wx', originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 100 }
  const src = (chat?: { latestAt(c: string): Promise<number | null>; pendingMatter(): string | null }) =>
    makePhoneTopicSources({ home: async () => { throw new Error('no') }, matters: { get: () => chatMatter }, ...(chat ? { chat } : {}) }).find(s => s.match('matter/c0ffee01'))!
  it('版本 = max(updatedAt, 最新消息时间):微信那边一来一回也会变', async () => {
    let latest: number | null = 50
    const s = src({ latestAt: async () => latest, pendingMatter: () => null })
    expect(await s.snapshot('matter/c0ffee01')).toEqual({ found: true, kind: 'chat', version: 100, phase: 'open' })
    latest = 500
    expect(await s.snapshot('matter/c0ffee01')).toMatchObject({ version: 500 })
  })
  it('手机那句在等回复 ⇒ phase working', async () => {
    const s = src({ latestAt: async () => null, pendingMatter: () => 'c0ffee01' })
    expect(await s.snapshot('matter/c0ffee01')).toMatchObject({ phase: 'working', version: 100 })
  })
  it('读最新消息抛错 ⇒ 退回 updatedAt;没接 chat ⇒ 原行为', async () => {
    expect(await src({ latestAt: async () => { throw new Error('db') }, pendingMatter: () => null }).snapshot('matter/c0ffee01')).toMatchObject({ version: 100 })
    expect(await src().snapshot('matter/c0ffee01')).toEqual({ found: true, kind: 'chat', version: 100, phase: 'open' })
  })
  it('快照形状仍过 MatterTopic', async () => {
    MatterTopic.parse(await src({ latestAt: async () => 7, pendingMatter: () => 'c0ffee01' }).snapshot('matter/c0ffee01'))
  })
})
```

(若测试文件还没 import `MatterTopic`,加 `import { MatterTopic } from '@wechat-cc/protocol'`。)

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/phone-topic-sources.test.ts -t "聊天"`
Expected: FAIL —— 版本仍是 100 / phase 不是 working。

- [ ] **Step 3: 实现**

`PhoneTopicSourceDeps` 加:

```ts
  /** 聊天类 matter 的真实活动:最新一条消息时间 + 手机那句是否在等回复(spec 2026-10-01 §3)。缺省 ⇒ 只看 updatedAt。 */
  chat?: { latestAt(chatId: string): Promise<number | null>; pendingMatter(): string | null }
```

把 matter 来源最后一行 `return { found: true, kind: m.kind, version: m.updatedAt, phase: m.status }` 换成:

```ts
      if (m.kind === 'chat' && deps.chat) {
        let latest: number | null = null
        if (m.ownerChatId) { try { latest = await deps.chat.latestAt(m.ownerChatId) } catch { latest = null } }
        const version = Math.max(m.updatedAt, latest !== null && Number.isFinite(latest) ? latest : 0)
        return { found: true, kind: m.kind, version, phase: deps.chat.pendingMatter() === id ? 'working' : m.status }
      }
      return { found: true, kind: m.kind, version: m.updatedAt, phase: m.status }
```

`pipeline-deps.ts` 的 `makePhoneEventsWiring({...})` 加:

```ts
      chat: {
        latestAt: async (chatId: string) => { const ts = await messagesStore.latestTs(chatId); return ts ? Date.parse(ts) : null },
        pendingMatter: () => phoneChat.pendingMatter(),
      },
```

- [ ] **Step 4: 跑,确认通过 + 守卫**

Run: `bun --bun vitest run src/daemon/phone-topic-sources.test.ts scripts/phone-routes.guard.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/phone-topic-sources.ts src/daemon/phone-topic-sources.test.ts src/daemon/wiring/pipeline-deps.ts
git commit -m "聊天主题版本跟真实消息走 + 等回复时 phase=working

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 连接快照(`connections.ts`)+ 知识库最新消息时间

**Files:**
- Modify: `src/core/knowledge/store.ts`(+ `latestMessageAtMs()`)、`src/core/knowledge/store.test.ts`
- Create: `src/daemon/connections.ts`、`src/daemon/connections.test.ts`

**Interfaces:**
- Produces(knowledge):`KnowledgeStore.latestMessageAtMs(): number | null` —— `SELECT MAX(time) AS t FROM messages`,`time` 是秒(`source-adapter.ts` 写的是 `create_time`),返回 `t * 1000`;空表 / `t <= 0` ⇒ null。
- Produces(daemon):
  ```ts
  export type SourceState = 'ready' | 'behind' | 'not_loaded' | 'unknown'
  export interface ConnectionSource { id: string; kind: 'wechat_history' | 'knowledge' | 'plugin'; name: string; state: SourceState; latestAt: number | null; syncedAt: number | null; detail?: { reason?: string; dir?: string | null } }
  export interface ConnectionsSnapshot {
    generatedAt: number
    sources: ConnectionSource[]
    computers: Array<{ id: string; label: string; online: boolean; since: number | null; version: string | null }>
    recent: Array<{ matterId: string; title: string; phase: string; at: number }>
    outputs: Array<{ matterId: string; name: string; mime: string; at: number }>
  }
  export const WECHAT_SYNC_STALE_MS = 24 * 3_600_000
  export const KNOWLEDGE_STALE_MS = 72 * 3_600_000
  export interface ConnectionsDeps {
    plugins(): PluginsHealth | null
    wechatSyncedAt(): number | null
    knowledge(): { enabled: boolean; built: boolean; latestAt: number | null }
    computer(): { label: string; since: number | null; version: string | null }
    workbench?: {
      list(q: { archived: 'exclude'; limit: number }): { tasks: Array<{ id: string; title: string; phase?: string; updatedAt: number }> }
      detail(id: string): { artifacts: Array<{ name: string; mime: string; createdAt: number }> }
    }
    now?: () => number
  }
  export function buildConnections(d: ConnectionsDeps): ConnectionsSnapshot
  export function redactConnections(s: ConnectionsSnapshot): ConnectionsSnapshot
  ```
- 判定(spec §3):
  - `plugins()` 为 null ⇒ 微信历史与每个插件都 `unknown`(插件列表此时为空 ⇒ 只有微信历史一行 `unknown`)。
  - 微信历史(`id 'wechat_history'`、`name 'wxvault'`):wxvault 在 `plugins` 里 `enabled && ready` ⇒ `syncedAt = wechatSyncedAt()`,`syncedAt === null || now - syncedAt > WECHAT_SYNC_STALE_MS` ⇒ `behind`,否则 `ready`;否则(不在、没就绪、在 `expected_missing`)⇒ `not_loaded`,`detail.reason = p.reason ?? 'missing'`、`detail.dir = bundled_dir`。`latestAt` = 知识库的 `latestAt`(有就给)。
  - 知识库(`'knowledge'`):`enabled === false` ⇒ 不出现;`built === false` ⇒ `not_loaded`;否则 `latestAt === null || now - latestAt > KNOWLEDGE_STALE_MS` ⇒ `behind`,否则 `ready`。
  - 其它插件(`id 'plugin:<name>'`,排除 wxvault):`enabled` 的才列;`ready` ⇒ `ready`,否则 `not_loaded`(`detail.reason`);`expected_missing` 里的(非 wxvault)⇒ `not_loaded`、`detail.reason='missing'`。按 name 排序。
  - `computers` = `[{ id: 'home', online: true, ...computer() }]`。
  - `recent` = `workbench.list({archived:'exclude',limit:20}).tasks` 按 `updatedAt` 降序前 3,`phase ?? 'working'`;`outputs` = 前 5 件的 `detail(id).artifacts`(`detail` 抛就跳过)合并按 `createdAt` 降序前 3。没接工作台 ⇒ 两个空数组。
  - `redactConnections` 去掉每个 source 的 `detail`,其余不动。

- [ ] **Step 1: 写知识库的失败测试**(`store.test.ts`,照该文件现有建库方式;只示意新增断言)

```ts
  it('latestMessageAtMs:空库 null;有消息 ⇒ MAX(time) 秒转毫秒', () => {
    const k = openKnowledge(dir)
    expect(k.latestMessageAtMs()).toBeNull()
    k.upsertSourceMessages([{ msg_key: 'a', conversation: 'c', sender: 's', time: 1_759_000_000, type: 'text', text: 'x', server_id: '1', local_type: 1, is_group: 0, kind: 'text' }])
    expect(k.latestMessageAtMs()).toBe(1_759_000_000_000)
  })
```

> 写入方法名以 `store.ts` 里实际的插入入口为准(约 337 行那条 `INSERT INTO messages(...)` 所属的方法);若测试文件已有造消息的 helper,直接用它。

- [ ] **Step 2: 实现 `latestMessageAtMs`**

`KnowledgeStore` 接口加:

```ts
  /** 库里最新一条微信消息的时间(毫秒);空库 null。「CC 的连接」卡用(spec 2026-10-01 §3)。 */
  latestMessageAtMs(): number | null
```

实现(紧挨 `sourceWatermark` 的 statement):

```ts
  const stmtLatestTime = db.query<{ t: number | null }, []>('SELECT MAX(time) AS t FROM messages')
  …
    latestMessageAtMs() { const t = stmtLatestTime.get()?.t ?? null; return t !== null && t > 0 ? t * 1000 : null },
```

Run: `bun --bun vitest run src/core/knowledge/store.test.ts` ⇒ PASS。

- [ ] **Step 3: 写 `connections.test.ts`(失败)**

```ts
import { describe, expect, it } from 'vitest'
import { buildConnections, redactConnections, KNOWLEDGE_STALE_MS, WECHAT_SYNC_STALE_MS, type ConnectionsDeps } from './connections'
import type { PluginsHealth } from './plugins/health'

const NOW = Date.UTC(2026, 9, 1, 12)
const health = (over: Partial<PluginsHealth> = {}): PluginsHealth => ({
  bundled_dir: '/Users/nate/app/plugins', via: 'env' as never, pointer_dir: null, pointer_broken: false, expected_missing: [],
  plugins: [
    { name: 'wxvault', source: 'bundled' as never, enabled: true, ready: true },
    { name: 'wxsearch', source: 'bundled' as never, enabled: true, ready: true },
    { name: 'wxmedia', source: 'bundled' as never, enabled: true, ready: false, reason: 'model missing at /Users/nate/x' },
    { name: 'off', source: 'bundled' as never, enabled: false, ready: false },
  ], ...over,
})
const deps = (over: Partial<ConnectionsDeps> = {}): ConnectionsDeps => ({
  plugins: () => health(),
  wechatSyncedAt: () => NOW - 3_600_000,
  knowledge: () => ({ enabled: true, built: true, latestAt: NOW - 3_600_000 }),
  computer: () => ({ label: 'Nate-Mac', since: NOW - 7_200_000, version: '1.7.1' }),
  now: () => NOW,
  ...over,
})
const byId = (s: ReturnType<typeof buildConnections>, id: string) => s.sources.find(x => x.id === id)

describe('buildConnections', () => {
  it('一切正常:微信历史 / 知识库 / wxsearch 绿,wxmedia 红,关掉的不列', () => {
    const s = buildConnections(deps())
    expect(s.sources.map(x => [x.id, x.state])).toEqual([
      ['wechat_history', 'ready'], ['knowledge', 'ready'], ['plugin:wxmedia', 'not_loaded'], ['plugin:wxsearch', 'ready'],
    ])
    expect(byId(s, 'wechat_history')).toMatchObject({ syncedAt: NOW - 3_600_000, latestAt: NOW - 3_600_000 })
    expect(s.computers).toEqual([{ id: 'home', label: 'Nate-Mac', online: true, since: NOW - 7_200_000, version: '1.7.1' }])
  })
  it('解密库超过 24 小时没动 ⇒ 微信历史 behind;从没解密过也 behind', () => {
    expect(byId(buildConnections(deps({ wechatSyncedAt: () => NOW - WECHAT_SYNC_STALE_MS - 1 })), 'wechat_history')!.state).toBe('behind')
    expect(byId(buildConnections(deps({ wechatSyncedAt: () => null })), 'wechat_history')!.state).toBe('behind')
  })
  it('wxvault 没加载(真机 09-11 起)⇒ 红,并带原因 / 目录(只在 detail 里)', () => {
    const s = buildConnections(deps({ plugins: () => health({ plugins: [], expected_missing: ['wxvault', 'wxsearch'] }) }))
    expect(byId(s, 'wechat_history')).toMatchObject({ state: 'not_loaded', detail: { reason: 'missing', dir: '/Users/nate/app/plugins' } })
    expect(byId(s, 'plugin:wxsearch')).toMatchObject({ state: 'not_loaded' })
  })
  it('知识库:没开 ⇒ 不出现;开了没建起来 ⇒ 红;超过 72 小时 / 空 ⇒ 琥珀', () => {
    expect(byId(buildConnections(deps({ knowledge: () => ({ enabled: false, built: false, latestAt: null }) })), 'knowledge')).toBeUndefined()
    expect(byId(buildConnections(deps({ knowledge: () => ({ enabled: true, built: false, latestAt: null }) })), 'knowledge')!.state).toBe('not_loaded')
    expect(byId(buildConnections(deps({ knowledge: () => ({ enabled: true, built: true, latestAt: NOW - KNOWLEDGE_STALE_MS - 1 }) })), 'knowledge')!.state).toBe('behind')
    expect(byId(buildConnections(deps({ knowledge: () => ({ enabled: true, built: true, latestAt: null }) })), 'knowledge')!.state).toBe('behind')
  })
  it('插件快照还没出来 ⇒ 不知道(不是绿也不是红)', () => {
    const s = buildConnections(deps({ plugins: () => null }))
    expect(byId(s, 'wechat_history')!.state).toBe('unknown')
    expect(s.sources.filter(x => x.kind === 'plugin')).toEqual([])
  })
  it('最近在做 / 成果:按时间取前 3;某件详情抛错就跳过', () => {
    const tasks = [1, 2, 3, 4].map(i => ({ id: `0000000${i}`, title: `t${i}`, phase: 'working', updatedAt: i }))
    const s = buildConnections(deps({ workbench: {
      list: () => ({ tasks }),
      detail: id => { if (id === '00000003') throw new Error('gone'); return { artifacts: [{ name: `${id}.md`, mime: 'text/markdown', createdAt: Number(id) }] } },
    } }))
    expect(s.recent.map(r => r.matterId)).toEqual(['00000004', '00000003', '00000002'])
    expect(s.outputs.map(o => o.name)).toEqual(['00000004.md', '00000002.md', '00000001.md'])
  })
  it('redactConnections:手机拿到的快照里没有路径与原因原文', () => {
    const s = redactConnections(buildConnections(deps({ plugins: () => health({ plugins: [{ name: 'wxmedia', source: 'bundled' as never, enabled: true, ready: false, reason: 'at /Users/nate/x' }], expected_missing: ['wxvault'] }) })))
    const text = JSON.stringify(s)
    expect(text).not.toMatch(/\/Users|\/home|[A-Za-z]:\\\\/)
    expect(s.sources.every(x => !('detail' in x))).toBe(true)
  })
})
```

- [ ] **Step 4: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/connections.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 5: 实现 `src/daemon/connections.ts`**

```ts
/**
 * connections.ts — 「CC 的连接」卡的快照(spec 2026-10-01 §1.4、§3)。纯函数:IO 全在 deps 里。
 * 永不撒谎:插件快照还没出来 ⇒ unknown;知识库没开 ⇒ 不出现(不是故障)。
 * detail(插件目录、未就绪原因)只给 admin;手机路由一律经 redactConnections。
 */
import type { PluginsHealth } from './plugins/health'

export type SourceState = 'ready' | 'behind' | 'not_loaded' | 'unknown'
export interface ConnectionSource { id: string; kind: 'wechat_history' | 'knowledge' | 'plugin'; name: string; state: SourceState; latestAt: number | null; syncedAt: number | null; detail?: { reason?: string; dir?: string | null } }
export interface ConnectionsSnapshot {
  generatedAt: number
  sources: ConnectionSource[]
  computers: Array<{ id: string; label: string; online: boolean; since: number | null; version: string | null }>
  recent: Array<{ matterId: string; title: string; phase: string; at: number }>
  outputs: Array<{ matterId: string; name: string; mime: string; at: number }>
}
export const WECHAT_SYNC_STALE_MS = 24 * 3_600_000
export const KNOWLEDGE_STALE_MS = 72 * 3_600_000
export interface ConnectionsDeps {
  plugins(): PluginsHealth | null
  wechatSyncedAt(): number | null
  knowledge(): { enabled: boolean; built: boolean; latestAt: number | null }
  computer(): { label: string; since: number | null; version: string | null }
  workbench?: {
    list(q: { archived: 'exclude'; limit: number }): { tasks: Array<{ id: string; title: string; phase?: string; updatedAt: number }> }
    detail(id: string): { artifacts: Array<{ name: string; mime: string; createdAt: number }> }
  }
  now?: () => number
}
const WXVAULT = 'wxvault'

export function buildConnections(d: ConnectionsDeps): ConnectionsSnapshot {
  const now = (d.now ?? Date.now)()
  const h = d.plugins()
  const k = d.knowledge()
  const sources: ConnectionSource[] = []

  // 微信历史(wxvault)
  if (!h) sources.push({ id: 'wechat_history', kind: 'wechat_history', name: WXVAULT, state: 'unknown', latestAt: null, syncedAt: null })
  else {
    const vault = h.plugins.find(p => p.name === WXVAULT)
    const latestAt = k.enabled && k.built ? k.latestAt : null
    if (vault?.enabled && vault.ready) {
      const syncedAt = d.wechatSyncedAt()
      sources.push({ id: 'wechat_history', kind: 'wechat_history', name: WXVAULT, state: syncedAt === null || now - syncedAt > WECHAT_SYNC_STALE_MS ? 'behind' : 'ready', latestAt, syncedAt })
    } else {
      sources.push({ id: 'wechat_history', kind: 'wechat_history', name: WXVAULT, state: 'not_loaded', latestAt, syncedAt: null, detail: { reason: vault?.reason ?? 'missing', dir: h.bundled_dir } })
    }
  }

  // 知识库(只在开了时出现)
  if (k.enabled) {
    const state: SourceState = !k.built ? 'not_loaded' : k.latestAt === null || now - k.latestAt > KNOWLEDGE_STALE_MS ? 'behind' : 'ready'
    sources.push({ id: 'knowledge', kind: 'knowledge', name: 'knowledge', state, latestAt: k.built ? k.latestAt : null, syncedAt: null })
  }

  // 其它插件
  if (h) {
    const rows: ConnectionSource[] = []
    for (const p of h.plugins) {
      if (p.name === WXVAULT || !p.enabled) continue
      rows.push({ id: `plugin:${p.name}`, kind: 'plugin', name: p.name, state: p.ready ? 'ready' : 'not_loaded', latestAt: null, syncedAt: null, ...(p.ready ? {} : { detail: { reason: p.reason ?? 'not_ready', dir: h.bundled_dir } }) })
    }
    for (const name of h.expected_missing) {
      if (name === WXVAULT || rows.some(r => r.name === name)) continue
      rows.push({ id: `plugin:${name}`, kind: 'plugin', name, state: 'not_loaded', latestAt: null, syncedAt: null, detail: { reason: 'missing', dir: h.bundled_dir } })
    }
    sources.push(...rows.sort((a, b) => a.name.localeCompare(b.name)))
  }

  let recent: ConnectionsSnapshot['recent'] = [], outputs: ConnectionsSnapshot['outputs'] = []
  if (d.workbench) {
    const tasks = [...d.workbench.list({ archived: 'exclude', limit: 20 }).tasks].sort((a, b) => b.updatedAt - a.updatedAt)
    recent = tasks.slice(0, 3).map(t => ({ matterId: t.id, title: t.title, phase: t.phase ?? 'working', at: t.updatedAt }))
    const all: ConnectionsSnapshot['outputs'] = []
    for (const t of tasks.slice(0, 5)) {
      try { for (const a of d.workbench.detail(t.id).artifacts) all.push({ matterId: t.id, name: a.name, mime: a.mime, at: a.createdAt }) }
      catch { /* 任务刚被清掉:跳过 */ }
    }
    outputs = all.sort((a, b) => b.at - a.at).slice(0, 3)
  }

  return { generatedAt: now, sources, computers: [{ id: 'home', online: true, ...d.computer() }], recent, outputs }
}

export function redactConnections(s: ConnectionsSnapshot): ConnectionsSnapshot {
  return { ...s, sources: s.sources.map(({ detail: _detail, ...rest }) => rest) }
}
```

- [ ] **Step 6: 跑,确认通过(bun + node)**

Run: `bun --bun vitest run src/daemon/connections.test.ts src/core/knowledge/store.test.ts && npx vitest run src/daemon/connections.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/core/knowledge/store.ts src/core/knowledge/store.test.ts src/daemon/connections.ts src/daemon/connections.test.ts
git commit -m "CC 的连接:快照纯函数 + 知识库最新消息时间

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 连接路由(`/m/api/connections` + admin `/v1/connections`)

**Files:**
- Modify: `packages/protocol/src/api.ts`(`ConnectionSource`、`Connections` + `PHONE_API_SCHEMAS` 一条)
- Create: `src/daemon/mobile-reads.ts`、`src/daemon/mobile-reads.test.ts`
- Create: `src/daemon/internal-api/routes-connections.ts`、`routes-connections.test.ts`
- Modify: `src/daemon/internal-api/{routes.ts,route-tiers.ts,types.ts,index.ts}`、`src/daemon/main.ts`、`src/daemon/phone-routes.ts`、`scripts/phone-routes.guard.test.ts`、`src/daemon/settings-panel.ts`、`src/daemon/wiring/pipeline-deps.ts`、`src/daemon/phone-api-schema.test.ts`

**Interfaces:**
- Consumes:`buildConnections`、`redactConnections`、`ConnectionsSnapshot`(Task 6)。
- Produces(协议):
  ```ts
  export const ConnectionSource = z.object({ id: z.string(), kind: z.enum(['wechat_history', 'knowledge', 'plugin']), name: z.string(), state: z.enum(['ready', 'behind', 'not_loaded', 'unknown']), latestAt: z.number().nullable(), syncedAt: z.number().nullable() })
  export const Connections = z.object({
    generatedAt: z.number(), sources: z.array(ConnectionSource),
    computers: z.array(z.object({ id: z.string(), label: z.string(), online: z.boolean(), since: z.number().nullable(), version: z.string().nullable() })),
    recent: z.array(z.object({ matterId: z.string(), title: z.string(), phase: z.string(), at: z.number() })),
    outputs: z.array(z.object({ matterId: z.string(), name: z.string(), mime: z.string(), at: z.number() })),
  })
  'GET /m/api/connections': z.union([z.object({ ok: z.literal(true) }).extend(Connections.shape), PhoneErrorResponse]),
  ```
- Produces(daemon):
  - `mobile-reads.ts`:`export interface MobileReadsDeps { connections?: () => ConnectionsSnapshot; sessions?: MobileSessionsDeps }`(`MobileSessionsDeps` 在 Task 8 加),`export async function mobileReadsRoute(deps: MobileReadsDeps, url: URL, req: Request, opts?: { budgetMs?: number }): Promise<Response | null>`。`GET /m/api/connections` ⇒ `{ ok: true, ...redactConnections(deps.connections()) }`;没接 ⇒ 503 `connections_not_wired`;抛 ⇒ 500 `unavailable`。
  - `SettingsPanelDeps.connections?: () => ConnectionsSnapshot`;`InternalApiDeps.connections?: () => ConnectionsSnapshot`;`InternalApi.setConnections(fn: () => ConnectionsSnapshot): void`;`buildPipelineDeps` 返回值加 `connections: () => ConnectionsSnapshot`。
  - `'GET /v1/connections': 'admin'`(带 `detail` 全量)。

- [ ] **Step 1: 协议 schema**(按上面加到 `api.ts`;`index.ts` 同 Task 4 的做法导出,加 `export type ConnectionsT = z.infer<typeof Connections>`)

- [ ] **Step 2: 写失败的测试**

`src/daemon/mobile-reads.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PHONE_API_SCHEMAS } from '@wechat-cc/protocol'
import { mobileReadsRoute } from './mobile-reads'
import type { ConnectionsSnapshot } from './connections'

const SNAP: ConnectionsSnapshot = {
  generatedAt: 1, computers: [{ id: 'home', label: 'Mac', online: true, since: 0, version: '1.7.1' }], recent: [], outputs: [],
  sources: [{ id: 'wechat_history', kind: 'wechat_history', name: 'wxvault', state: 'not_loaded', latestAt: null, syncedAt: null, detail: { reason: 'missing', dir: '/Users/nate/plugins' } }],
}
const run = async (deps: Parameters<typeof mobileReadsRoute>[0], path: string) => {
  const r = await mobileReadsRoute(deps, new URL('http://x' + path), new Request('http://x' + path))
  return r && { status: r.status, body: await r.json() as any }
}

describe('GET /m/api/connections', () => {
  it('去掉 detail,过 schema', async () => {
    const r = await run({ connections: () => SNAP }, '/m/api/connections')
    expect(r!.status).toBe(200)
    expect(JSON.stringify(r!.body)).not.toContain('/Users')
    PHONE_API_SCHEMAS['GET /m/api/connections']!.parse(r!.body)
  })
  it('没接 ⇒ 503;抛 ⇒ 500 unavailable;别的路径 ⇒ null', async () => {
    expect((await run({}, '/m/api/connections'))!.status).toBe(503)
    expect((await run({ connections: () => { throw new Error('x') } }, '/m/api/connections'))!.body).toEqual({ ok: false, error: 'unavailable' })
    expect(await run({}, '/m/api/matters')).toBeNull()
  })
})
```

`src/daemon/internal-api/routes-connections.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { connectionsRoutes } from './routes-connections'
import { minTierFor } from './route-tiers'
import type { InternalApiDeps } from './types'

describe('GET /v1/connections', () => {
  it('admin 档;带 detail 的全量;没接 503', async () => {
    expect(minTierFor('GET /v1/connections')).toBe('admin')
    const snap = { generatedAt: 1, sources: [{ id: 'wechat_history', detail: { dir: '/x' } }], computers: [], recent: [], outputs: [] }
    const r = await connectionsRoutes({ connections: () => snap } as unknown as InternalApiDeps)['GET /v1/connections']!(new URLSearchParams(), undefined)
    expect(r).toEqual({ status: 200, body: snap })
    expect((await connectionsRoutes({} as InternalApiDeps)['GET /v1/connections']!(new URLSearchParams(), undefined)).status).toBe(503)
  })
})
```

- [ ] **Step 3: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/mobile-reads.test.ts src/daemon/internal-api/routes-connections.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现**

`src/daemon/mobile-reads.ts`(本 Task 只有连接一条;Task 8 往里加会话):

```ts
import { redactConnections, type ConnectionsSnapshot } from './connections'

/**
 * mobile-reads.ts — 手机只读路由(spec 2026-10-01 §3):CC 的连接、电脑上的原生会话。
 * 路由字面量被 scripts/phone-routes.guard.test.ts 扫描。admin 以下不给路径:连接经 redactConnections。
 */
export interface MobileReadsDeps { connections?: () => ConnectionsSnapshot }
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export async function mobileReadsRoute(deps: MobileReadsDeps, url: URL, req: Request, _opts: { budgetMs?: number } = {}): Promise<Response | null> {
  if (url.pathname === '/m/api/connections') {
    if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.connections) return json({ ok: false, error: 'connections_not_wired' }, 503)
    try { return json({ ok: true, ...redactConnections(deps.connections()) }) }
    catch { return json({ ok: false, error: 'unavailable' }, 500) }
  }
  return null
}
```

`src/daemon/internal-api/routes-connections.ts`:

```ts
import type { InternalApiDeps, RouteTable } from './types'

/** 「CC 的连接」全量快照(admin:带插件目录与未就绪原因)。手机走 /m/api/connections(去掉 detail)。 */
export function connectionsRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/connections': async () => {
      if (!deps.connections) return { status: 503, body: { error: 'connections_not_wired' } }
      try { return { status: 200, body: deps.connections() } } catch { return { status: 500, body: { error: 'internal' } } }
    },
  }
}
```

接上:
1. `route-tiers.ts`:在「一件事」那组后加 `// 「CC 的连接」:带插件目录与原因,只给 admin。\n  'GET /v1/connections': 'admin',`。
2. `routes.ts` 的 `makeRoutes` 返回对象里 `...mattersRoutes(deps),` 之后加 `...connectionsRoutes(deps),`(并 import)。
3. `types.ts`:`InternalApiDeps` 加 `/** 「CC 的连接」(spec 2026-10-01);main.ts 在 pipeline 接好后 setConnections。 */ connections?: () => import('../connections').ConnectionsSnapshot`;`InternalApi` 接口加 `setConnections(fn: () => import('../connections').ConnectionsSnapshot): void`。
4. `index.ts`:`setSettingsLink` 旁加 `setConnections(fn) { deps.connections = fn },`。
5. `phone-routes.ts`:`PHONE_ROUTES` 加 `'GET /m/api/connections',`(注释「CC 的连接(spec 2026-10-01),去掉 detail」)。
6. 守卫:`sourcePaths()` 的文件列表加 `'mobile-reads.ts'`。
7. `settings-panel.ts`:deps 加 `/** 「CC 的连接」快照(spec 2026-10-01)。缺省 ⇒ /m/api/connections 503。 */ connections?: () => import('./connections').ConnectionsSnapshot`;在 `chatResponse` 之后加
   ```ts
          const readResponse = await mobileReadsRoute({ ...(deps.connections ? { connections: deps.connections } : {}) }, url, req)
          if (readResponse) return readResponse
   ```
8. `pipeline-deps.ts`:`makeSettingsPanel` 之前加
   ```ts
  // 「CC 的连接」(spec 2026-10-01):插件快照 / 解密库时间 / 知识库 / 工作台 —— 每次请求现算(都是便宜的同步读)。
  const startedAt = Date.now() - Math.round(process.uptime() * 1000)
  const connections = () => buildConnections({
    plugins: () => boot.pluginsHealth ?? null,
    wechatSyncedAt: () => { const m = maxDecryptedMtime(stateDir); return m > 0 ? m : null },
    knowledge: () => ({ enabled: (loadAgentConfig(stateDir) as { knowledge_enabled?: boolean }).knowledge_enabled === true, built: !!boot.knowledge, latestAt: boot.knowledge?.store.latestMessageAtMs() ?? null }),
    computer: () => ({ label: hostname().replace(/\.local$/, ''), since: startedAt, version: APP_VERSION }),
    ...(opts.workbench ? { workbench: opts.workbench } : {}),
  })
   ```
   `makeSettingsPanel({...})` 里加 `connections,`;`return { … }` 加 `connections`。imports:`buildConnections`(`../connections`)、`maxDecryptedMtime`(`../companion/ingest/cycle`)、`hostname`(`node:os`)、`APP_VERSION`(`../../lib/app-version`)。`BuildPipelineDepsResult` 类型加 `connections: () => import('../connections').ConnectionsSnapshot`。
9. `main.ts`:`internalApi.setSettingsLink(wired.settingsPanelLink)` 之后加 `internalApi.setConnections(wired.connections)`。

> 若 `depcheck` 不许 `wiring/` 引 `companion/ingest/cycle`,把 `maxDecryptedMtime` 挪到 `src/lib/` 下的新文件(cycle.ts 改为从那里 re-export),不要绕过模块边界规则。

- [ ] **Step 5: 真实返回过 schema(`phone-api-schema.test.ts`)**

在该 describe 的 panel 里加 `connections: () => buildConnections({ plugins: () => null, wechatSyncedAt: () => null, knowledge: () => ({ enabled: false, built: false, latestAt: null }), computer: () => ({ label: 'test', since: null, version: null }), workbench })`,新用例:

```ts
  it('connections 真实返回符合 schema', async () => {
    create('conn')
    parseAs('GET /m/api/connections', await (await request('/m/api/connections')).json())
  })
```

- [ ] **Step 6: 回路**

Run: `bun --bun vitest run src/daemon scripts packages/protocol apps/mobile/build.test.ts && bun run typecheck; echo tc=$?; bun run depcheck; echo dep=$?`
Expected: PASS,`tc=0`、`dep=0`。

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src src/daemon scripts/phone-routes.guard.test.ts
git commit -m "CC 的连接:/m/api/connections(去掉 detail)+ admin /v1/connections

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 电脑上的原生会话(`/m/api/sessions`、`/m/api/session`,只读)

**Files:**
- Modify: `packages/protocol/src/api.ts`、`src/daemon/mobile-reads.ts`、`src/daemon/mobile-reads.test.ts`、`src/daemon/phone-routes.ts`、`src/daemon/settings-panel.ts`、`src/daemon/wiring/pipeline-deps.ts`、`src/daemon/phone-api-schema.test.ts`

**Interfaces:**
- Consumes:`NativeHistoryPage`、`NativeHistoryPreview`、`NativeHistoryListInput`、`NativeHistoryReadInput`(`src/core/workbench/native-history.ts`);`workbench.listNativeHistory(providerId, input)`、`workbench.readNativeHistory(key, input)`(已有,`routes-workbench.ts` 在用)。
- Produces(协议):
  ```ts
  export const NativeSessionRow = z.object({ key: z.string(), provider: z.enum(['claude', 'codex']), title: z.string(), project: z.string().nullable(), updatedAt: z.number().nullable(), active: z.boolean() })
  export const NativeSessionMessage = z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), truncated: z.boolean() })
  export const NativeSessionPage = z.object({ session: NativeSessionRow, messages: z.array(NativeSessionMessage), nextCursor: z.string().nullable(), managed: z.boolean() })
  'GET /m/api/sessions': z.union([z.object({ ok: z.literal(true), items: z.array(NativeSessionRow), nextCursor: z.string().nullable() }), PhoneErrorResponse]),
  'GET /m/api/session': z.union([z.object({ ok: z.literal(true) }).extend(NativeSessionPage.shape), PhoneErrorResponse]),
  ```
- Produces(daemon):
  ```ts
  export const PHONE_SESSIONS_BUDGET_MS = 10_000
  export const PHONE_SESSIONS_PAGE = 30
  export const PHONE_SESSION_PAGE = 20
  export const PHONE_SESSION_TEXT_MAX = 4000
  export interface MobileSessionsDeps {
    list(provider: 'claude' | 'codex', input: NativeHistoryListInput): Promise<NativeHistoryPage>
    read(key: string, input: NativeHistoryReadInput): Promise<NativeHistoryPreview>
  }
  // MobileReadsDeps 加 sessions?: MobileSessionsDeps
  ```
  投影:`title` 截 200 字;`project = cwd ? basename(cwd) : null`;`active = observedState === 'active'`;**不给** `cwd`、`nativeId`、`remote`。消息每条截 4000 字(已截过的保留 `truncated: true`)。`managed = !!preview.managedTaskId`。错误:`provider` 不是 claude/codex、`cursor` 超过 2048 / 重复参数、`key` 缺 ⇒ 400 `invalid`;`native_history_unsupported` ⇒ 404 `unsupported`;`invalid_cursor` / `invalid_native_history_key` / `invalid_request` ⇒ 400 `invalid`;超预算 / 其它 ⇒ 503 `unavailable`。

- [ ] **Step 1: 协议 schema**(按上面加;导出 `NativeSessionRowT`、`NativeSessionPageT` 类型)

- [ ] **Step 2: 写失败的测试**(追加到 `mobile-reads.test.ts`)

```ts
import type { MobileSessionsDeps } from './mobile-reads'
const ITEM = { key: 'k1', providerId: 'claude' as const, nativeId: 'n1', title: 'T'.repeat(300), titleSource: 'first_prompt' as const, cwd: '/Users/nate/work/portfolio', updatedAt: 5, remote: false, observedState: 'active' as const }
const sessions = (over: Partial<MobileSessionsDeps> = {}): MobileSessionsDeps => ({
  list: async () => ({ items: [ITEM], nextCursor: 'c2', coverage: 'native_supported_history' }),
  read: async () => ({ session: ITEM, messages: [{ id: 'm1', role: 'user', text: 'x'.repeat(5000), truncated: false }], nextCursor: null, sourceFingerprint: 'f', page: { limit: 20, cursor: null }, truncated: false, managedTaskId: 'deadbeef' }),
  ...over,
})

describe('GET /m/api/sessions、/m/api/session', () => {
  it('列表:只给目录名,不给 cwd / nativeId;标题截 200;过 schema', async () => {
    const r = await run({ sessions: sessions() }, '/m/api/sessions?provider=claude')
    expect(r!.body.items[0]).toEqual({ key: 'k1', provider: 'claude', title: 'T'.repeat(200), project: 'portfolio', updatedAt: 5, active: true })
    expect(JSON.stringify(r!.body)).not.toContain('/Users')
    PHONE_API_SCHEMAS['GET /m/api/sessions']!.parse(r!.body)
  })
  it('读一页:每条截 4000、managed;过 schema', async () => {
    const r = await run({ sessions: sessions() }, '/m/api/session?key=k1')
    expect(r!.body.messages[0]).toMatchObject({ truncated: true }); expect(r!.body.messages[0].text).toHaveLength(4000)
    expect(r!.body.managed).toBe(true)
    PHONE_API_SCHEMAS['GET /m/api/session']!.parse(r!.body)
  })
  it('分页大小:列表 30、读 20;cursor 原样', async () => {
    const seen: unknown[] = []
    await run({ sessions: sessions({ list: async (p, i) => { seen.push([p, i]); return { items: [], nextCursor: null, coverage: 'native_supported_history' } } }) }, '/m/api/sessions?provider=codex&cursor=abc')
    expect(seen).toEqual([['codex', { q: '', limit: 30, cursor: 'abc' }]])
  })
  it('坏参数 400;不支持 404;读得慢(超预算)503 —— 隧道 15 秒前一定回', async () => {
    for (const p of ['/m/api/sessions', '/m/api/sessions?provider=gemini', `/m/api/sessions?provider=claude&cursor=${'a'.repeat(2049)}`, '/m/api/session']) expect((await run({ sessions: sessions() }, p))!.status).toBe(400)
    expect((await run({ sessions: sessions({ list: async () => { throw new Error('native_history_unsupported') } }) }, '/m/api/sessions?provider=codex'))!.body).toEqual({ ok: false, error: 'unsupported' })
    const slow = sessions({ read: () => new Promise(() => {}) })
    const t0 = Date.now()
    const r = await mobileReadsRoute({ sessions: slow }, new URL('http://x/m/api/session?key=k1'), new Request('http://x/m/api/session?key=k1'), { budgetMs: 30 })
    expect(r!.status).toBe(503); expect(Date.now() - t0).toBeLessThan(1000)
    expect((await run({}, '/m/api/sessions?provider=claude'))!.status).toBe(503)
  })
})
```

- [ ] **Step 3: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/mobile-reads.test.ts`
Expected: FAIL —— 会话路由不存在。

- [ ] **Step 4: 实现**(`mobile-reads.ts` 增补)

```ts
import { basename } from 'node:path'
import type { NativeHistoryItem, NativeHistoryListInput, NativeHistoryPage, NativeHistoryPreview, NativeHistoryReadInput } from '../core/workbench/native-history'

export const PHONE_SESSIONS_BUDGET_MS = 10_000
export const PHONE_SESSIONS_PAGE = 30
export const PHONE_SESSION_PAGE = 20
export const PHONE_SESSION_TEXT_MAX = 4000
export interface MobileSessionsDeps {
  list(provider: 'claude' | 'codex', input: NativeHistoryListInput): Promise<NativeHistoryPage>
  read(key: string, input: NativeHistoryReadInput): Promise<NativeHistoryPreview>
}
// MobileReadsDeps 改成:
export interface MobileReadsDeps { connections?: () => ConnectionsSnapshot; sessions?: MobileSessionsDeps }

const row = (i: NativeHistoryItem) => ({ key: i.key, provider: i.providerId, title: i.title.slice(0, 200), project: i.cwd ? basename(i.cwd) : null, updatedAt: i.updatedAt, active: i.observedState === 'active' })
async function withBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  let h: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([p, new Promise<never>((_, rej) => { h = setTimeout(() => rej(new Error('budget_exceeded')), ms) })]) }
  finally { if (h) clearTimeout(h) }
}
const sessionError = (e: unknown) => {
  const m = e instanceof Error ? e.message : ''
  if (m === 'native_history_unsupported') return json({ ok: false, error: 'unsupported' }, 404)
  if (['invalid_cursor', 'invalid_native_history_key', 'invalid_request'].includes(m)) return json({ ok: false, error: 'invalid' }, 400)
  return json({ ok: false, error: 'unavailable' }, 503)
}
const cursorOf = (url: URL): string | undefined | null => {
  const all = url.searchParams.getAll('cursor')
  if (all.length > 1) return null
  const c = all[0]
  if (c === undefined) return undefined
  return c && c.length <= 2048 ? c : null
}
```

`mobileReadsRoute` 里(连接分支之后)加:

```ts
  if (url.pathname === '/m/api/sessions') {
    if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.sessions) return json({ ok: false, error: 'sessions_not_wired' }, 503)
    const provider = url.searchParams.get('provider'), cursor = cursorOf(url)
    if ((provider !== 'claude' && provider !== 'codex') || url.searchParams.getAll('provider').length !== 1 || cursor === null) return json({ ok: false, error: 'invalid' }, 400)
    try {
      const page = await withBudget(deps.sessions.list(provider, { q: '', limit: PHONE_SESSIONS_PAGE, ...(cursor ? { cursor } : {}) }), opts.budgetMs ?? PHONE_SESSIONS_BUDGET_MS)
      return json({ ok: true, items: page.items.map(row), nextCursor: page.nextCursor })
    } catch (e) { return sessionError(e) }
  }
  if (url.pathname === '/m/api/session') {
    if (req.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
    if (!deps.sessions) return json({ ok: false, error: 'sessions_not_wired' }, 503)
    const key = url.searchParams.get('key'), cursor = cursorOf(url)
    if (!key || key.length > 2048 || url.searchParams.getAll('key').length !== 1 || cursor === null) return json({ ok: false, error: 'invalid' }, 400)
    try {
      const p = await withBudget(deps.sessions.read(key, { limit: PHONE_SESSION_PAGE, ...(cursor ? { cursor } : {}) }), opts.budgetMs ?? PHONE_SESSIONS_BUDGET_MS)
      return json({
        ok: true, session: row(p.session), nextCursor: p.nextCursor, managed: !!p.managedTaskId,
        messages: p.messages.map(m => ({ id: m.id, role: m.role, text: m.text.slice(0, PHONE_SESSION_TEXT_MAX), truncated: m.truncated || m.text.length > PHONE_SESSION_TEXT_MAX })),
      })
    } catch (e) { return sessionError(e) }
  }
```

(把函数签名的 `_opts` 改名为 `opts`。)

接上:`PHONE_ROUTES` 加 `'GET /m/api/sessions', 'GET /m/api/session',`(注释「电脑上的原生会话(只读,spec 2026-10-01),项目只给目录名」);`settings-panel.ts` deps 加 `sessions?: import('./mobile-reads').MobileSessionsDeps`,`mobileReadsRoute` 调用的第一个参数加 `...(deps.sessions ? { sessions: deps.sessions } : {})`;`pipeline-deps.ts` 的 `makeSettingsPanel({...})` 加 `...(opts.workbench ? { sessions: { list: (p, i) => opts.workbench!.listNativeHistory(p, i), read: (k, i) => opts.workbench!.readNativeHistory(k, i) } } : {}),`。

`phone-api-schema.test.ts`:panel 加 `sessions: { list: async () => ({ items: [], nextCursor: null, coverage: 'native_supported_history' }), read: async () => { throw new Error('native_history_unsupported') } }`,新用例对 `GET /m/api/sessions?provider=claude` 与 `GET /m/api/session?key=x`(404 走 `PhoneErrorResponse`)各 `parseAs` 一次。

- [ ] **Step 5: 回路**

Run: `bun --bun vitest run src/daemon scripts packages/protocol apps/mobile/build.test.ts && npm run test:node -- src/daemon/mobile-reads.test.ts && bun run typecheck; echo tc=$?`
Expected: PASS,`tc=0`。

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src src/daemon scripts
git commit -m "手机只读看电脑上的 Claude Code / Codex 会话(10 秒预算、只给目录名)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: app 的 `Backend`:chat / chatSay / connections / sessions / session

**Files:**
- Modify: `apps/app/src/backend/types.ts`、`live.ts`、`demo.ts`、`demo-data.ts`、`apps/app/src/net/errors.ts`
- Test: `apps/app/src/backend/live.test.ts`、`demo.test.ts`、`apps/app/src/net/errors.test.ts`、`src/daemon/phone-app-live-e2e.test.ts`

**Interfaces:**
- Consumes:协议包 `ChatPage`、`ChatJob`、`Connections`、`NativeSessionRow`、`NativeSessionPage`、`PHONE_SAY_MAX_CHARS`。
- Produces(`types.ts`):
  ```ts
  export type ChatPageT = z.infer<typeof ChatPage>
  export type ChatJobT = z.infer<typeof ChatJob>
  export type ChatMessageT = z.infer<typeof ChatMessage>
  export type ConnectionsT = z.infer<typeof Connections>
  export type NativeSessionRowT = z.infer<typeof NativeSessionRow>
  export type NativeSessionPageT = z.infer<typeof NativeSessionPage>
  // Backend 加:
  /** 主人那条对话一页(before = 上一页的 nextBefore)。没设主人 ⇒ BackendError('not_found')。 */
  chat(p: { before?: string; limit?: number }): Promise<ChatPageT>
  /** 收下即回;回复经 matter/<matterId> 主题唤醒后再 chat() 拉。上一句还在等 ⇒ BackendError('busy')。 */
  chatSay(text: string, requestId: string): Promise<ChatJobT>
  connections(): Promise<ConnectionsT>
  sessions(provider: 'claude' | 'codex', cursor?: string): Promise<{ items: NativeSessionRowT[]; nextCursor: string | null }>
  session(key: string, cursor?: string): Promise<NativeSessionPageT>
  ```
- 错误映射(`errors.ts`):`chat_busy` 加进 `BUSY`;`no_owner_chat`、`unsupported` ⇒ `not_found`;`chat_not_wired` / `connections_not_wired` / `sessions_not_wired` 与 `push_not_wired` 一起 ⇒ `unavailable`;`status === 503 && err === 'unavailable'` ⇒ `unavailable`。
- 演示后端:聊天 matter id `c0ffee01`,种子 4 条消息(微信 2、电脑 1、手机 1,中英两份);`chatSay` ⇒ 立即 pending,2 秒后追加「我」与 CC 的固定回复(`chatDemoReply`)并发 `matter/c0ffee01` 主题;同一 requestId 不重复;连接:wxvault 就绪(昨天)、知识库落后(4 天前)、wxsearch 就绪、wxmedia 没加载;会话:claude 2 条、codex 1 条,每条一页 3 句。

- [ ] **Step 1: 写失败的测试**

`errors.test.ts` 追加:

```ts
  it('跟 CC 说 / 连接 / 会话的错误码', () => {
    expect(mapPhoneError(409, { ok: false, error: 'chat_busy' })).toBe('busy')
    expect(mapPhoneError(404, { ok: false, error: 'no_owner_chat' })).toBe('not_found')
    expect(mapPhoneError(404, { ok: false, error: 'unsupported' })).toBe('not_found')
    for (const e of ['chat_not_wired', 'connections_not_wired', 'sessions_not_wired']) expect(mapPhoneError(503, { ok: false, error: e })).toBe('unavailable')
    expect(mapPhoneError(503, { ok: false, error: 'unavailable' })).toBe('unavailable')
    expect(mapPhoneError(500, { ok: false, error: 'unavailable' })).toBe('unknown')
  })
```

`live.test.ts` 追加(用该文件已有的 `rig` / 假协议客户端写法:请求按 `"METHOD /path"` 回固定 JSON;下面的 `reply(key, json)` 与 `lastReq()` 指它现有的同名或等价 helper):

```ts
  it('chat:before / limit 拼进查询串;返回过 schema', async () => {
    reply('GET /m/api/chat', { ok: true, matterId: 'c0ffee01', title: '聊天', messages: [], hasMore: false, nextBefore: null, pending: null, failed: null })
    expect((await b.chat({ before: '2026-09-30T00:00:05.000Z', limit: 10 })).matterId).toBe('c0ffee01')
    expect(lastReq().path).toBe('/m/api/chat?before=2026-09-30T00%3A00%3A05.000Z&limit=10')
    await b.chat({}); expect(lastReq().path).toBe('/m/api/chat')
  })
  it('chatSay:超长在手机上就拦;正常带 requestId,retry 打开', async () => {
    await expect(b.chatSay('x'.repeat(20_001), RID)).rejects.toMatchObject({ code: 'invalid' })
    reply('POST /m/api/chat/say', { ok: true, matterId: 'c0ffee01', job: { requestId: RID, text: 'hi', status: 'pending', since: 1 } })
    expect((await b.chatSay('hi', RID)).status).toBe('pending')
    expect(lastReq()).toMatchObject({ body: { requestId: RID, text: 'hi' }, retry: true })
  })
  it('connections / sessions / session 走对应路由', async () => {
    reply('GET /m/api/sessions', { ok: true, items: [], nextCursor: null })
    await b.sessions('codex', 'c 1'); expect(lastReq().path).toBe('/m/api/sessions?provider=codex&cursor=c%201')
    reply('GET /m/api/session', { ok: false, error: 'unsupported' })
    await expect(b.session('k')).rejects.toMatchObject({ code: 'not_found' })
  })
```

`demo.test.ts` 追加:

```ts
  it('演示聊天:说一句 ⇒ pending;2 秒后主题唤醒、历史里多了一问一答;同一 requestId 不重复', async () => {
    vi.useFakeTimers()
    const b = makeDemoBackend({ lang: 'zh-Hans' })
    const before = (await b.chat({})).messages.length
    const seen: unknown[] = []
    b.subscribe('matter/c0ffee01', d => seen.push(d))
    expect((await b.chatSay('你好', 'r1')).status).toBe('pending')
    await b.chatSay('你好', 'r1')
    expect((await b.chat({})).pending?.requestId).toBe('r1')
    await vi.advanceTimersByTimeAsync(2000)
    const after = await b.chat({})
    expect(after.messages.length).toBe(before + 2)
    expect(after.pending).toBeNull()
    expect(seen.length).toBeGreaterThan(0)
    vi.useRealTimers()
  })
  it('演示连接与会话有数据且过 schema', async () => {
    const b = makeDemoBackend()
    Connections.parse(await b.connections())
    const list = await b.sessions('claude')
    expect(list.items.length).toBe(2)
    NativeSessionPage.parse(await b.session(list.items[0]!.key))
  })
```

根 `src/daemon/phone-app-live-e2e.test.ts`:panel 加 `chat`(真 messages store + 真 `makePhoneChat`,converse 用一个可放行的闸门,放行时往 messages 里追加一问一答,模拟 `persistAppTurn`);`makePhoneEventsWiring` 加 `chat: { latestAt, pendingMatter }`;新用例:

```ts
  it('跟 CC 说:收下即回 pending → 主题唤醒 → 拉到回复;同一 requestId 重发不说两遍', async () => {
    const b = live()
    await expect.poll(() => b.connection().state, P).toBe('online')
    const first = await b.chat({})
    const versions: unknown[] = []
    b.subscribe(`matter/${first.matterId}`, d => versions.push(d))
    const rid = randomUUID()
    expect((await b.chatSay('你好', rid)).status).toBe('pending')
    await b.chatSay('你好', rid)
    expect(conversed).toHaveLength(1)
    releaseConverse('在呢')
    await expect.poll(async () => (await b.chat({})).messages.at(-1)?.text, P).toBe('在呢')
    expect(versions.length).toBeGreaterThan(1)
  })
```

(`conversed` / `releaseConverse` 是本用例在 beforeEach 里建的数组与放行函数;闸门在 afterEach 一并放行。)

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bun run test; cd ../.. && bun --bun vitest run src/daemon/phone-app-live-e2e.test.ts`
Expected: FAIL —— 方法不存在。

- [ ] **Step 3: 实现**

`errors.ts`:

```ts
const BUSY = new Set(['workbench_busy', 'input_delivery_busy', 'reply_sink_busy', 'input_conflict', 'chat_busy'])
const NOT_FOUND = new Set(['matter_not_found', 'no_owner_chat', 'unsupported'])
const UNAVAILABLE = new Set(['push_not_wired', 'chat_not_wired', 'connections_not_wired', 'sessions_not_wired'])
…
  if (err && UNAVAILABLE.has(err)) return 'unavailable'
  if (status === 503 && err === 'unavailable') return 'unavailable'
  if (err && NOT_FOUND.has(err)) return 'not_found'
```

(替换原来的 `push_not_wired`、`matter_not_found` 两行。)

`live.ts` 在 `changes` 之后加:

```ts
    async chat(p) {
      const q = [p.before ? `before=${encodeURIComponent(p.before)}` : '', p.limit ? `limit=${p.limit}` : ''].filter(Boolean).join('&')
      return strip(await call<{ ok: true } & ChatPageT>('GET /m/api/chat', `/m/api/chat${q ? '?' + q : ''}`))
    },
    async chatSay(text, requestId) {
      if (text.length > PHONE_SAY_MAX_CHARS) throw new BackendError('invalid')
      return (await call<{ job: ChatJobT }>('POST /m/api/chat/say', '/m/api/chat/say', { body: { requestId, text }, retry: true })).job
    },
    async connections() {
      return strip(await call<{ ok: true } & ConnectionsT>('GET /m/api/connections', '/m/api/connections'))
    },
    async sessions(provider, cursor) {
      const r = await call<{ items: NativeSessionRowT[]; nextCursor: string | null }>('GET /m/api/sessions', `/m/api/sessions?provider=${provider}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      return { items: r.items, nextCursor: r.nextCursor }
    },
    async session(key, cursor) {
      return strip(await call<{ ok: true } & NativeSessionPageT>('GET /m/api/session', `/m/api/session?key=${encodeURIComponent(key)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`))
    },
```

`demo-data.ts` 加文案(中英)与种子:

```ts
export const CHAT_ID = 'c0ffee01'
// copy 里加:
  chatTitle: ['和 CC 的对话', 'You & CC'],
  chatSeed1: ['今天降温了,出门记得加件外套。', 'It’s colder today. Take a jacket.'],
  chatSeed2: ['好,谢谢提醒', 'Will do, thanks'],
  chatSeed3: ['作品集那件我先放着,明天接着看?', 'Shall I park the portfolio and pick it up tomorrow?'],
  chatSeed4: ['可以', 'Sounds good'],
  chatDemoReply: ['收到。这是演示模式,真连上你的电脑后,这里就是 CC 本人在回你。', 'Got it. This is the demo; once you pair with your computer, CC itself replies here.'],
```

`demo.ts`:在闭包里加 `let chatMsgs: Array<{ id: string; role: 'me' | 'cc'; key?: Copy; text?: string; at: number; source: 'wechat' | 'desktop' | 'phone' }>`(`reset()` 时用 4 条种子重建:`cc/wechat`、`me/wechat`、`cc/desktop`、`me/phone`,时间为 `now() - 3h … now() - 1h`)、`let chatPending: ChatJobT | null`、`const chatJobs = new Map<string, ChatJobT>()`、`let chatVersion = 1`;实现:

```ts
    async chat(_p) {
      const l = lastLang
      return {
        matterId: CHAT_ID, title: t(l, 'chatTitle'), hasMore: false, nextBefore: null, failed: null,
        pending: chatPending ? { ...chatPending } : null,
        messages: chatMsgs.map(m => ({ id: m.id, role: m.role, kind: 'text', text: m.key ? t(l, m.key) : m.text ?? '', truncated: false, at: m.at, source: m.source })),
      }
    },
    async chatSay(text, requestId) {
      const seen = chatJobs.get(requestId)
      if (seen) return { ...seen }
      if (chatPending) throw new BackendError('busy')
      const job: ChatJobT = { requestId, text, status: 'pending', since: now() }
      chatJobs.set(requestId, job); chatPending = job
      const ep = epoch
      emit(`matter/${CHAT_ID}`, { found: true, kind: 'chat', version: ++chatVersion, phase: 'working' })
      schedule(() => {
        if (ep !== epoch) return
        chatMsgs.push({ id: `demo-${requestId}-in`, role: 'me', text, at: now(), source: 'phone' }, { id: `demo-${requestId}-out`, role: 'cc', key: 'chatDemoReply', at: now() + 1, source: 'phone' })
        job.status = 'replied'; chatPending = null
        emit(`matter/${CHAT_ID}`, { found: true, kind: 'chat', version: ++chatVersion, phase: 'open' })
      }, 2000)
      return { ...job }
    },
    async connections() { return demoConnections(now()) },
    async sessions(provider) { return { items: demoSessions(provider, now()), nextCursor: null } },
    async session(key) {
      const row = [...demoSessions('claude', now()), ...demoSessions('codex', now())].find(r => r.key === key)
      if (!row) throw new BackendError('not_found')
      return { session: row, managed: false, nextCursor: null, messages: demoSessionMessages(lastLang) }
    },
```

(`emit` 是 demo.ts 里已有的往订阅者发主题的函数;名字以文件实际为准。`demoConnections(now)`、`demoSessions(provider, now)`、`demoSessionMessages(lang)` 写在 `demo-data.ts`:连接四行按上面 Produces;会话 key 用 `demo-claude-1`、`demo-claude-2`、`demo-codex-1`,项目名 `portfolio` / `notes` / `trip-planner`;消息三句(user / assistant / user)中英两份。`subscribe` 对 `matter/c0ffee01` 的初始快照返回 `{ found: true, kind: 'chat', version: chatVersion, phase: chatPending ? 'working' : 'open' }`。)

`types.ts` 按 Interfaces 加类型与五个方法签名。

- [ ] **Step 4: 跑,确认通过**

Run: `cd apps/app && bun run test && bun run typecheck; echo app=$?; cd ../.. && bun --bun vitest run src/daemon/phone-app-live-e2e.test.ts && npx vitest run src/daemon/phone-app-live-e2e.test.ts && bun run typecheck; echo tc=$?`
Expected: PASS,`app=0`、`tc=0`。

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/backend apps/app/src/net src/daemon/phone-app-live-e2e.test.ts
git commit -m "app Backend:跟 CC 说 / 连接 / 原生会话(真连接 + 演示)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: app 视图模型(对话、任务对话、骨架屏修复、置顶、连接、会话)

**Files:**
- Create: `apps/app/src/view/chat.ts`、`chat.test.ts`、`conversation.ts`、`conversation.test.ts`、`connections.ts`、`connections.test.ts`、`sessions.ts`、`sessions.test.ts`
- Modify: `apps/app/src/view/progress.ts`、`progress.test.ts`、`together.ts`、`together.test.ts`、`now.ts`、`now.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // chat.ts(纯 TS,被根测试也能 import)
  export type Bubble = { key: string; side: 'me' | 'cc'; text: string; at: number; source: 'wechat' | 'desktop' | 'phone'; state: 'sent' | 'thinking' | 'failed'; failedKind?: 'busy' | 'unavailable' | 'maybeLost'; requestId?: string; truncated: boolean }
  export function mergeChatPages(latest: ChatPageT, older: ChatPageT[]): ChatMessageT[]          // 按 id 去重、按 at 再 id 升序
  export function olderCursor(latest: ChatPageT, older: ChatPageT[]): string | null               // 最后加载的那页的 nextBefore;没有更多 ⇒ null
  export function chatBubbles(msgs: ChatMessageT[], page: Pick<ChatPageT, 'pending' | 'failed'>, accepted: { requestId: string; text: string; at: number } | null): Bubble[]
  // conversation.ts
  export type ConvItem = { kind: 'me' | 'cc' | 'steps' | 'error'; text: string; at: number; count?: number }
  export function conversationView(events: MatterDetailT['events']): ConvItem[]
  // progress.ts:progressView 加第 4 个参数 insightFailed = false,返回值加 summaryState: 'loading' | 'ready' | 'failed' | 'none'
  // together.ts / now.ts:不列 kind === 'chat'
  // connections.ts
  export type Dot = 'ok' | 'warn' | 'bad' | 'unknown'
  export function connectionsView(s: ConnectionsT, now: number, lang: Lang): {
    headline: { dot: Dot; key: 'conn.headlineOk' | 'conn.headlineWarn' | 'conn.headlineBad' | 'conn.headlineUnknown'; n: number }
    sources: Array<{ id: string; name: string; dot: Dot; label: string }>
    computers: Array<{ id: string; label: string; dot: Dot; detail: string }>
    recent: Array<{ matterId: string; title: string; when: string }>
    outputs: Array<{ matterId: string; name: string; when: string }>
  }
  export function shortDate(ms: number, lang: Lang): string   // zh: 「9月8日」;en: 「Sep 8」(本地时区)
  // sessions.ts
  export function sessionRows(items: NativeSessionRowT[], now: number, lang: Lang): Array<{ key: string; title: string; meta: string; active: boolean }>
  ```
- `chatBubbles` 规则:历史消息 ⇒ `sent`;`pending` ⇒ 末尾追加「我」气泡(`state:'sent'`)+ CC 的 `thinking` 气泡;`failed` ⇒ 「我」气泡 `state:'failed'`、`failedKind = failed.error === 'busy' ? 'busy' : 'unavailable'`、带 `requestId`;`accepted`(本机刚收到回执)若既不是 pending、也不在 failed、历史里也没有同样正文的「我」消息(at ≥ accepted.at - 60 秒,来源 phone)⇒ 「我」气泡 `failed` + `failedKind:'maybeLost'`(Review Focus 1)。
- `conversationView` 规则:`user` ⇒ me、`text` ⇒ cc、连续 `tool_call` 合成一个 `steps`(`count` = 条数,`text` = 最后一条)、`error` ⇒ error、`system` 与其它 ⇒ 不显示;正文超过 4000 字截断加「…」。
- `connectionsView` 规则:`ready` ⇒ ok,`behind` ⇒ warn,`not_loaded` ⇒ bad,`unknown` ⇒ unknown;headline 取最坏(bad > warn > unknown > ok),`n` = 该级别条数;label:ready 且有 `latestAt` ⇒ `t('conn.latestOn',{date})`,ready 无 ⇒ `t('conn.ready')`,behind 有 `latestAt` ⇒ `t('conn.behindSince',{date})`、无 ⇒ `t('conn.behind')`,not_loaded ⇒ `t('conn.notLoaded')`,unknown ⇒ `t('conn.unknown')`;名称:`wechat_history` ⇒ `t('conn.src.wechat')`,`knowledge` ⇒ `t('conn.src.knowledge')`,插件原名。电脑:online ⇒ ok + `t('conn.computerOnline',{date: shortDate(since)})`。

- [ ] **Step 1: 写失败的测试**

`chat.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { chatBubbles, mergeChatPages, olderCursor } from './chat'
import type { ChatMessageT, ChatPageT } from '../backend/types'

const msg = (id: string, at: number, role: 'me' | 'cc' = 'me', text = id, source: ChatMessageT['source'] = 'wechat'): ChatMessageT => ({ id, role, kind: 'text', text, truncated: false, at, source })
const page = (messages: ChatMessageT[], over: Partial<ChatPageT> = {}): ChatPageT => ({ matterId: 'c0ffee01', title: 't', messages, hasMore: false, nextBefore: null, pending: null, failed: null, ...over })

describe('chat 视图', () => {
  it('合并:旧页在前、按时间排、按 id 去重(重拉最新页与旧页重叠)', () => {
    const latest = page([msg('b', 2), msg('c', 3)]), older = [page([msg('a', 1), msg('b', 2)], { nextBefore: 'x', hasMore: true })]
    expect(mergeChatPages(latest, older).map(m => m.id)).toEqual(['a', 'b', 'c'])
    expect(olderCursor(latest, older)).toBe('x')
    expect(olderCursor(page([], { hasMore: true, nextBefore: 'y' }), [])).toBe('y')
    expect(olderCursor(page([], { hasMore: false, nextBefore: null }), [])).toBeNull()
  })
  it('pending ⇒ 我的气泡 + CC 在想', () => {
    const b = chatBubbles([msg('a', 1, 'cc')], { pending: { requestId: 'r', text: '你好', status: 'pending', since: 5 }, failed: null }, null)
    expect(b.slice(-2).map(x => [x.side, x.state, x.text])).toEqual([['me', 'sent', '你好'], ['cc', 'thinking', '']])
  })
  it('failed busy ⇒ 可重试的失败气泡', () => {
    const b = chatBubbles([], { pending: null, failed: { requestId: 'r', text: 'hi', status: 'failed', since: 5, error: 'busy' } }, null)
    expect(b).toEqual([expect.objectContaining({ side: 'me', state: 'failed', failedKind: 'busy', requestId: 'r', text: 'hi' })])
  })
  it('本机收过回执,daemon 却既没 pending 也没历史(重启丢了)⇒ 可能没送到', () => {
    const acc = { requestId: 'r', text: '在吗', at: 1000 }
    expect(chatBubbles([], { pending: null, failed: null }, acc).at(-1)).toMatchObject({ state: 'failed', failedKind: 'maybeLost', requestId: 'r' })
    expect(chatBubbles([msg('x', 1200, 'me', '在吗', 'phone')], { pending: null, failed: null }, acc).filter(x => x.state === 'failed')).toEqual([])
  })
})
```

`conversation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { conversationView } from './conversation'
const ev = (kind: string, text: string, createdAt: number) => ({ kind, text, createdAt })
describe('conversationView', () => {
  it('用户 / CC / 合并的步骤 / 出错;系统行不显示', () => {
    expect(conversationView([ev('user', '帮我看看', 1), ev('system', '权限请求', 2), ev('tool_call', 'ListFiles', 3), ev('tool_call', 'ReadFile', 4), ev('text', '看完了', 5), ev('error', '额度用完', 6), ev('user', 'wxvault 不能看到么', 7)]))
      .toEqual([
        { kind: 'me', text: '帮我看看', at: 1 },
        { kind: 'steps', text: 'ReadFile', at: 4, count: 2 },
        { kind: 'cc', text: '看完了', at: 5 },
        { kind: 'error', text: '额度用完', at: 6 },
        { kind: 'me', text: 'wxvault 不能看到么', at: 7 },
      ])
  })
  it('超长截断', () => {
    expect(conversationView([ev('text', 'x'.repeat(5000), 1)])[0]!.text).toHaveLength(4001)
  })
})
```

`progress.test.ts` 追加:

```ts
  it('聊天类 / 没有任务 ⇒ summaryState none(不再永远转骨架屏)', () => {
    expect(progressView({ ...detail, task: null }, { progress: null }, null).summaryState).toBe('none')
    expect(progressView({ ...detail, task: null }, null, null).summaryState).toBe('none')
  })
  it('任务:还没拉到 loading;拉到 ready;失败 failed;拉到但没有 none', () => {
    expect(progressView(detail, null, null).summaryState).toBe('loading')
    expect(progressView(detail, null, null, true).summaryState).toBe('failed')
    expect(progressView(detail, { progress: { summary: 's', steps: [], source: 'raw' } }, null).summaryState).toBe('ready')
    expect(progressView(detail, { progress: null }, null).summaryState).toBe('none')
  })
```

(`detail` 是该测试文件已有的任务详情夹具;没有就用 `fixtures.ts` 里的。)

`together.test.ts` / `now.test.ts` 各追加一条:列表里放一个 `kind: 'chat'` 的 matter,断言结果里没有它。

`connections.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { connectionsView, shortDate } from './connections'
const NOW = new Date(2026, 9, 1, 12).getTime()
const src = (id: string, state: 'ready' | 'behind' | 'not_loaded' | 'unknown', latestAt: number | null = null, kind: 'wechat_history' | 'knowledge' | 'plugin' = 'plugin') => ({ id, kind, name: id, state, latestAt, syncedAt: null })
const snap = (sources: ReturnType<typeof src>[]) => ({ generatedAt: NOW, sources, computers: [{ id: 'home', label: 'Mac', online: true, since: NOW - 3_600_000, version: '1.7.1' }], recent: [], outputs: [] })
describe('connectionsView', () => {
  it('颜色与文字:绿 / 琥珀 / 红 / 灰都有字', () => {
    const v = connectionsView(snap([src('wechat_history', 'behind', new Date(2026, 8, 8, 12).getTime(), 'wechat_history'), src('wxsearch', 'ready'), src('wxmedia', 'not_loaded'), src('x', 'unknown')]), NOW, 'zh-Hans')
    expect(v.sources.map(s => [s.dot, s.label])).toEqual([['warn', '数据最新到 9月8日'], ['ok', '已连上'], ['bad', '没加载'], ['unknown', '不知道']])
    expect(v.sources[0]!.name).toBe('微信聊天记录')
    expect(v.headline).toEqual({ dot: 'bad', key: 'conn.headlineBad', n: 1 })
  })
  it('全绿 ⇒ headline ok;英文日期', () => {
    expect(connectionsView(snap([src('a', 'ready')]), NOW, 'en').headline).toEqual({ dot: 'ok', key: 'conn.headlineOk', n: 1 })
    expect(shortDate(new Date(2026, 8, 8, 12).getTime(), 'en')).toBe('Sep 8')
  })
})
```

(文案以 Step 3 加进 i18n 的为准:`conn.behindSince` 中文「数据最新到 {date}」、`conn.ready`「已连上」、`conn.notLoaded`「没加载」、`conn.unknown`「不知道」、`conn.src.wechat`「微信聊天记录」。)

`sessions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { sessionRows } from './sessions'
describe('sessionRows', () => {
  it('meta = 项目名 · 日期;没项目只给日期;没时间给「时间不明」', () => {
    const NOW = new Date(2026, 9, 1, 12).getTime()
    const rows = sessionRows([
      { key: 'k', provider: 'claude', title: 'T', project: 'portfolio', updatedAt: new Date(2026, 8, 30, 9).getTime(), active: true },
      { key: 'k2', provider: 'codex', title: 'U', project: null, updatedAt: null, active: false },
    ], NOW, 'zh-Hans')
    expect(rows).toEqual([{ key: 'k', title: 'T', meta: 'portfolio · 9月30日', active: true }, { key: 'k2', title: 'U', meta: '时间不明', active: false }])
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bun run test`
Expected: FAIL —— 模块与字段不存在。

- [ ] **Step 3: 实现**

`src/view/chat.ts`:

```ts
import type { ChatMessageT, ChatPageT } from '../backend/types'

export type Bubble = { key: string; side: 'me' | 'cc'; text: string; at: number; source: 'wechat' | 'desktop' | 'phone'; state: 'sent' | 'thinking' | 'failed'; failedKind?: 'busy' | 'unavailable' | 'maybeLost'; requestId?: string; truncated: boolean }
const LOST_WINDOW_MS = 60_000

export function mergeChatPages(latest: ChatPageT, older: ChatPageT[]): ChatMessageT[] {
  const byId = new Map<string, ChatMessageT>()
  for (const p of [...older, latest]) for (const m of p.messages) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}
export function olderCursor(latest: ChatPageT, older: ChatPageT[]): string | null {
  const last = older.length ? older[older.length - 1]! : latest
  return last.hasMore ? last.nextBefore : null
}
export function chatBubbles(msgs: ChatMessageT[], page: Pick<ChatPageT, 'pending' | 'failed'>, accepted: { requestId: string; text: string; at: number } | null): Bubble[] {
  const out: Bubble[] = msgs.map(m => ({ key: m.id, side: m.role, text: m.text, at: m.at, source: m.source, state: 'sent', truncated: m.truncated }))
  const { pending, failed } = page
  if (pending) {
    out.push({ key: `p:${pending.requestId}`, side: 'me', text: pending.text, at: pending.since, source: 'phone', state: 'sent', truncated: false })
    out.push({ key: `t:${pending.requestId}`, side: 'cc', text: '', at: pending.since, source: 'phone', state: 'thinking', truncated: false })
  } else if (failed) {
    out.push({ key: `f:${failed.requestId}`, side: 'me', text: failed.text, at: failed.since, source: 'phone', state: 'failed', failedKind: failed.error === 'busy' ? 'busy' : 'unavailable', requestId: failed.requestId, truncated: false })
  }
  if (accepted && pending?.requestId !== accepted.requestId && failed?.requestId !== accepted.requestId) {
    const landed = msgs.some(m => m.role === 'me' && m.source === 'phone' && m.text === accepted.text && m.at >= accepted.at - LOST_WINDOW_MS)
    if (!landed) out.push({ key: `l:${accepted.requestId}`, side: 'me', text: accepted.text, at: accepted.at, source: 'phone', state: 'failed', failedKind: 'maybeLost', requestId: accepted.requestId, truncated: false })
  }
  return out
}
```

`src/view/conversation.ts`:

```ts
import type { MatterDetailT } from '../backend/types'
export type ConvItem = { kind: 'me' | 'cc' | 'steps' | 'error'; text: string; at: number; count?: number }
const MAX = 4000
const clip = (s: string) => (s.length > MAX ? s.slice(0, MAX) + '…' : s)
export function conversationView(events: MatterDetailT['events']): ConvItem[] {
  const out: ConvItem[] = []
  for (const e of events) {
    if (e.kind === 'user') out.push({ kind: 'me', text: clip(e.text), at: e.createdAt })
    else if (e.kind === 'text') out.push({ kind: 'cc', text: clip(e.text), at: e.createdAt })
    else if (e.kind === 'error') out.push({ kind: 'error', text: clip(e.text), at: e.createdAt })
    else if (e.kind === 'tool_call') {
      const prev = out[out.length - 1]
      if (prev?.kind === 'steps') { prev.count = (prev.count ?? 1) + 1; prev.text = clip(e.text); prev.at = e.createdAt }
      else out.push({ kind: 'steps', text: clip(e.text), at: e.createdAt, count: 1 })
    }
  }
  return out
}
```

`progress.ts`:签名加 `insightFailed = false`,返回值加

```ts
    summaryState: !t ? 'none' : p ? 'ready' : insight ? 'none' : insightFailed ? 'failed' : 'loading',
```

(类型声明里加 `summaryState: 'loading' | 'ready' | 'failed' | 'none'`。)

`together.ts`:`.filter(m => m.status !== 'archived')` 改成 `.filter(m => m.status !== 'archived' && m.kind !== 'chat')`(注释「主人对话在顶上单独置顶;访客的聊天是 CC 的社交,不是一起做的事(spec 2026-10-01 §2)」)。`now.ts` 的 `together` 计算同样排除 `kind === 'chat'`。

`src/view/connections.ts`、`src/view/sessions.ts` 按 Interfaces 规则实现;`shortDate`:

```ts
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const shortDate = (ms: number, lang: Lang) => { const d = new Date(ms); return lang === 'zh-Hans' ? `${d.getMonth() + 1}月${d.getDate()}日` : `${MONTHS[d.getMonth()]!} ${d.getDate()}` }
```

`sessionRows` 的 meta:`[project, updatedAt === null ? null : shortDate(updatedAt, lang)].filter(Boolean).join(' · ') || t(lang, 'sessions.unknownTime')`。

i18n(两份同时加,键一致):

| 键 | zh-Hans | en |
|---|---|---|
| `conn.title` | CC 的连接 | CC’s connections |
| `conn.src.wechat` | 微信聊天记录 | WeChat history |
| `conn.src.knowledge` | 知识库 | Knowledge base |
| `conn.ready` | 已连上 | Connected |
| `conn.latestOn` | 数据最新到 {date} | Up to {date} |
| `conn.behind` | 有一阵没更新了 | Not updated lately |
| `conn.behindSince` | 数据最新到 {date} | Only up to {date} |
| `conn.notLoaded` | 没加载 | Not loaded |
| `conn.unknown` | 不知道 | Unknown |
| `conn.headlineOk` | 都连着 | All connected |
| `conn.headlineWarn` | {n} 项有点旧 | {n} running behind |
| `conn.headlineBad` | {n} 项没加载 | {n} not loaded |
| `conn.headlineUnknown` | 电脑还在启动,暂时不知道 | Still starting up |
| `conn.computers` | 家里的电脑 | Home computer |
| `conn.computerOnline` | 在线 · 自 {date} | Online since {date} |
| `conn.recent` | 最近在做 | Recently |
| `conn.outputs` | 成果 | Outputs |
| `conn.sources` | 来源 | Sources |
| `sessions.unknownTime` | 时间不明 | Time unknown |

> 注:`conn.*` 这一组若与已有的连接状态文案(`conn.revokedTitle` 等)同名前缀冲突,改用 `links.*` 前缀并同步上面测试里的键名;先 `grep -n "'conn\." src/i18n/en.ts` 确认。

- [ ] **Step 4: 跑,确认通过**

Run: `cd apps/app && bun run test && bun run typecheck; echo app=$?`
Expected: PASS,`app=0`。

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/view apps/app/src/i18n
git commit -m "app 视图:对话分页与可能没送到、任务对话、骨架屏修复、一起做不列聊天、连接卡、会话行

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: `/chat` 页 + 入口改道 + 进展页对话节 + 交办改名

**Files:**
- Create: `apps/app/src/state/useChat.ts`、`apps/app/src/app/chat.tsx`、`apps/app/.maestro/chat.yaml`
- Modify: `apps/app/src/app/(tabs)/index.tsx`、`(tabs)/together.tsx`、`matter/[id].tsx`、`compose.tsx`、`apps/app/src/i18n/{en,zh-Hans}.ts`、`apps/app/.maestro/compose.yaml`

**Interfaces:**
- Consumes:`Backend.chat` / `chatSay`(Task 9);`mergeChatPages`、`olderCursor`、`chatBubbles`、`conversationView`、`progressView(..., insightFailed)`(Task 10);`requestIdFor`、`deleteDraft`、`getDraft`、`setDraft`(`state/drafts.ts`);`useQuery`、`useTopic`、`useSubmit`、`useConnection`(`state/hooks.ts`);`canSubmit`(`view/connection.ts`)。
- Produces:
  ```ts
  // state/useChat.ts
  export function useChat(): {
    page: ChatPageT | undefined; error: unknown
    bubbles: Bubble[]; canLoadOlder: boolean; loadingOlder: boolean; loadOlder(): Promise<void>
    send(text: string): Promise<'ok' | 'busy' | 'ccBusy' | 'uncertain' | 'revoked' | 'failed' | 'tooLong'>
    retry(requestId: string, text: string): Promise<void>
  }
  ```
  testID:`chat-list`、`chat-input`、`chat-send`、`chat-handoff`、`chat-bubble-me`、`chat-bubble-cc`、`chat-thinking`、`chat-failed-<kind>`、`chat-retry`、`chat-load-older`、`chat-no-owner`、`together-pinned-chat`、`progress-conversation`。

- [ ] **Step 1: `useChat`**

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatPageT } from '../backend/types'
import { BackendError } from '../backend/types'
import { chatBubbles, mergeChatPages, olderCursor } from '../view/chat'
import { composeOutcome, composeTooLong } from '../view/compose'
import { useBackendCtx } from './BackendProvider'
import { deleteDraft, requestIdFor } from './drafts'
import { useQuery, useSubmit, useTopic } from './hooks'

/**
 * 跟 CC 说(spec 2026-10-01 §4):最新一页走查询缓存(重连 epoch 前进由 store 统一重拉);
 * matter/<聊天> 主题版本或阶段一变就重拉;往上翻的旧页只在本页内存里。
 * 发送不做乐观成功:服务端回执里的 pending 就是「我」的气泡。
 */
export function useChat() {
  const { backend } = useBackendCtx()
  const submit = useSubmit()
  const latest = useQuery('chat:latest', () => backend.chat({}), { refreshOnMount: true })
  const [older, setOlder] = useState<ChatPageT[]>([])
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [accepted, setAccepted] = useState<{ requestId: string; text: string; at: number } | null>(null)
  const topicName = latest.data ? (`matter/${latest.data.matterId}` as const) : ('home' as const)
  const topic = useTopic<{ version?: unknown; phase?: unknown }>(topicName)
  const seen = useRef<string | undefined>(undefined)
  const topicKey = latest.data && topic !== undefined ? JSON.stringify(topic) : undefined
  const { refresh } = latest
  useEffect(() => {
    if (topicKey === undefined) return
    if (seen.current !== undefined && seen.current !== topicKey) void refresh()
    seen.current = topicKey
  }, [topicKey, refresh])

  const bubbles = useMemo(() => (latest.data ? chatBubbles(mergeChatPages(latest.data, older), latest.data, accepted) : []), [latest.data, older, accepted])
  const cursor = latest.data ? olderCursor(latest.data, older) : null
  const loadOlder = useCallback(async () => {
    if (!cursor || loadingOlder) return
    setLoadingOlder(true)
    try { const p = await backend.chat({ before: cursor }); setOlder(o => [...o, p]) } catch { /* 翻不动就停在这;下次滑到顶再试 */ }
    finally { setLoadingOlder(false) }
  }, [backend, cursor, loadingOlder])

  const say = useCallback(async (text: string, requestId: string) => {
    let jobAt = 0
    const r = await submit(`chat:say`, async () => { jobAt = (await backend.chatSay(text, requestId)).since })
    if (r === 'ok') { setAccepted({ requestId, text, at: jobAt }); void refresh() }
    return r
  }, [backend, submit, refresh])

  const send = useCallback(async (raw: string) => {
    const text = raw.trim()
    if (!text) return 'failed' as const
    if (composeTooLong(text)) return 'tooLong' as const
    const r = await say(text, requestIdFor('chat', text))
    if (r === 'ok') { deleteDraft('chat'); return 'ok' as const }
    if (r === 'busy') return 'busy' as const
    return composeOutcome(r.error)
  }, [say])
  const retry = useCallback(async (requestId: string, text: string) => { await say(text, requestId) }, [say])

  return { page: latest.data, error: latest.error, bubbles, canLoadOlder: !!cursor, loadingOlder, loadOlder, send, retry }
}
```

> `submit(...)` 的返回形状与 compose.tsx 里一致(`'ok' | 'busy' | { error: string }`);若实际类型不同,以 `state/store.ts` 的 `submit` 为准调整这三处判断。`BackendError` 的 `not_found` 由页面看 `error` 显示 `chat-no-owner`。

- [ ] **Step 2: `src/app/chat.tsx`**

结构(样式沿用 matter 页与 compose 页的 token):
- `TopBar`(`onBack`,`title = t('chat.title')`,连接点、头像)+ `ConnectionNotice`。
- `latest.error` 是 `BackendError` 且 `code === 'not_found'` ⇒ 居中文字 `chat.noOwner`(`testID="chat-no-owner"`)。
- 否则 `FlatList inverted`,`data = [...bubbles].reverse()`,`onEndReached={loadOlder}`、`onEndReachedThreshold={0.2}`、`ListFooterComponent` = 有更多时 `chat-load-older` 小字(「往上滑看更早的」/ 加载中)。
- 气泡:`me` 右对齐用 `c.accentSoft` 底(若无此 token 用导航选中色 `#f7ead2` 对应的 token),`cc` 左对齐卡片底;每条下方小字来源 `chat.from.wechat|desktop|phone` + 时间(`HH:MM`);`truncated` ⇒ 末尾 `chat.truncated`;`thinking` ⇒ `chat-thinking`「在想…」(系统「减少动态效果」时不做省略号动画);`failed` ⇒ 气泡下 `chat-failed-<kind>` 文案(`chat.failedBusy` / `chat.failedUnavailable` / `chat.maybeLost`)+ `chat-retry` 按钮(离线时禁用)。
- 底部:次级按钮 `chat-handoff`「交给 CC 去做一件事」⇒ `router.push('/compose')`;输入框 `chat-input`(草稿键 `'chat'`,`getDraft/setDraft`)+ 发送 `chat-send`(`!canSubmit(conn)` 或空 ⇒ 禁用;发送中锁定);结果非 ok ⇒ 输入框上方一行提示(`busy` ⇒ `compose.busy`,`ccBusy` ⇒ `chat.ccBusy`,`uncertain` ⇒ `compose.uncertain`,`tooLong` ⇒ `compose.tooLong`,`revoked` ⇒ `conn.revokedTitle`,其它 ⇒ `compose.failed`);ok ⇒ 清空输入框。
- `KeyboardAvoidingView`(iOS `padding`)包住列表与输入区。

- [ ] **Step 3: 入口改道 + 置顶 + 进展页**

1. `(tabs)/index.tsx`:`now-say` 的 `onPress` 改 `router.push('/chat')`。
2. `(tabs)/together.tsx`:`FlatList` 的 `ListHeaderComponent` = 置顶行 `together-pinned-chat`(CC 小形象 + `t('chat.pinnedTitle')` + 最近一句预览,数据来自 `useQuery('chat:latest', () => backend.chat({}))`,失败 / 没主人时这一行不显示),点 ⇒ `/chat`;`together-say` 改 `/chat`。
3. `matter/[id].tsx`:
   - 顶部 `if (detail.data?.matter.kind === 'chat') return <Redirect href="/chat" />`(`import { Redirect } from 'expo-router'`)。
   - `progressView(d, insight.data ?? null, changes.data ?? null, !!insight.error && !insight.data)`;骨架屏分支改成按 `v.summaryState`:`loading` ⇒ 骨架;`failed` ⇒ 原「点我重试」;`none` ⇒ `t('progress.noSummary')`;`ready` ⇒ 概括。
   - 「CC 的进展」卡之后新增「对话」卡(`testID="progress-conversation"`):`conversationView(d.events)` 渲染 —— `me` 右、`cc` 左、`steps` 一行小字 `t('progress.stepsN', { n: count })` + 最后一步名称、`error` 一行 `c.warn` 字;空 ⇒ `progress.noEvents`。
   - 「过程与执行信息」sheet 里删掉「最近事件」(由对话卡取代),保留执行者与文件夹。
4. `compose.tsx`:不带 `matter` 时标题 / 眉题改用 `compose.handoffEyebrow` / `compose.handoffTitle`(「交给 CC 去做一件事」/「Hand a task to CC」),说明 `compose.handoffHint`(「CC 会在电脑上开一件事去做;只想聊聊就回到对话。」);带 `matter` 的续说不变。

i18n 新键(两份):`chat.title`(跟 CC 说 / Talk to CC)、`chat.pinnedTitle`(和 CC 的对话 / You & CC)、`chat.placeholder`(说点什么… / Say something…)、`chat.send`(发送 / Send)、`chat.handoff`(交给 CC 去做一件事 / Hand a task to CC)、`chat.thinking`(在想… / Thinking…)、`chat.failedBusy`(CC 正在回微信那边,等一下再发 / CC is replying on WeChat. Try again in a moment.)、`chat.failedUnavailable`(没送到电脑上 / Didn’t reach your computer)、`chat.maybeLost`(这句可能没送到 / This may not have arrived)、`chat.retry`(重试 / Retry)、`chat.ccBusy`(上一句 CC 还在想,等它回完再说 / CC is still on your last message)、`chat.olderHint`(往上滑看更早的 / Scroll up for earlier)、`chat.loadingOlder`(正在读更早的… / Loading earlier…)、`chat.noOwner`(电脑上还没设好主人对话 / Your computer hasn’t set up your chat with CC yet)、`chat.from.wechat`(微信 / WeChat)、`chat.from.desktop`(电脑 / Computer)、`chat.from.phone`(手机 / Phone)、`chat.truncated`(…(太长,其余在电脑上看)/ …(more on your computer))、`progress.conversation`(对话 / Conversation)、`progress.stepsN`(做了 {n} 步 / {n} steps)、`progress.noSummary`(还没有概括 / No summary yet)、`compose.handoffEyebrow`、`compose.handoffTitle`、`compose.handoffHint`。

- [ ] **Step 4: Maestro**

`.maestro/chat.yaml`:

```yaml
# 跟 CC 说:此刻 → 跟 CC 说一句 → 对话页 → 发一句 → 「在想…」→ 回复出现;一起做第一行进对话页。
appId: com.tendhearth.app
---
- runFlow: subflows/_start.yaml
- tapOn:
    id: welcome-look-first
- extendedWaitUntil:
    visible:
      id: now-say
    timeout: 10000
- tapOn:
    id: now-say
- extendedWaitUntil:
    visible:
      id: chat-input
    timeout: 5000
- tapOn:
    id: chat-input
- inputText: "Maestro hello"
- tapOn:
    id: chat-send
- extendedWaitUntil:
    visible:
      id: chat-thinking
    timeout: 3000
- extendedWaitUntil:
    visible: ".*(演示模式|This is the demo).*"
    timeout: 8000
- assertNotVisible:
    id: chat-thinking
- tapOn:
    id: topbar-back
- tapOn:
    id: tab-together
- tapOn:
    id: together-pinned-chat
- assertVisible:
    id: chat-input
```

`.maestro/compose.yaml`:`tapOn: id: now-say` 之后插入

```yaml
- extendedWaitUntil:
    visible:
      id: chat-handoff
    timeout: 5000
- tapOn:
    id: chat-handoff
```

其余不变(交办页 testID 没变);文件头注释改成「此刻 → 跟 CC 说 → 交给 CC 去做一件事 → …」。

- [ ] **Step 5: 回路**

```bash
cd apps/app && bun run test && bun run typecheck && bun run export:check; echo app=$?
maestro test .maestro/chat.yaml .maestro/compose.yaml .maestro/demo-walkthrough.yaml .maestro/approve.yaml   # 要 development build + expo start
```
Expected: `app=0`;四个流程 PASS(模拟器用 README 里的 `th-push`;同时开着多台加 `--device`)。

- [ ] **Step 6: Commit**

```bash
git add apps/app
git commit -m "app:跟 CC 说成为主动作(/chat、往上翻、可能没送到可重试)、一起做置顶对话、进展页显示真对话、交办改为显式选项

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: `/connections` 与 `/sessions` 页

**Files:**
- Create: `apps/app/src/app/connections.tsx`、`apps/app/src/app/sessions/index.tsx`、`apps/app/src/app/sessions/[key].tsx`、`apps/app/.maestro/connections.yaml`
- Modify: `apps/app/src/app/(tabs)/index.tsx`(连接一行)、`apps/app/src/app/settings.tsx`(会话入口)、i18n

**Interfaces:**
- Consumes:`Backend.connections` / `sessions` / `session`(Task 9);`connectionsView`、`sessionRows`、`shortDate`(Task 10)。
- Produces:testID `now-connections`、`connections-source-<id>`、`connections-computer-home`、`connections-recent`、`connections-outputs`、`settings-sessions`、`sessions-tab-claude|codex`、`sessions-row-<key>`、`sessions-more`、`session-message-<i>`、`session-more`、`sessions-unsupported`、`sessions-slow`。

- [ ] **Step 1: 连接页与此刻入口**

- 此刻页「CC 一两句近况」卡下面加一行 `now-connections`:圆点(按 `headline.dot` 着色)+ `t('conn.title')` + `t(headline.key, { n })` + `›`,点 ⇒ `/connections`。数据 `useQuery('connections', () => backend.connections())`;失败 ⇒ 这一行显示 `conn.unknown`,不报错。
- `connections.tsx`:`useQuery('connections', …, { refreshOnMount: true })`;四段卡片:来源(每行 `connections-source-<id>`:圆点 + 名称 + label;圆点旁一定有文字)、家里的电脑(`connections-computer-home`:label + `conn.computerOnline`)、最近在做(点 ⇒ `/matter/<id>`)、成果(只列名字 + 日期,点 ⇒ 对应进展页)。圆点颜色:ok = `c.ok`、warn = `c.warn`、bad = `c.danger`(没有就加到 `ui/tokens.ts` 两套色板,浅 `#b5533c` / 深 `#e08a74`)、unknown = `c.muted`。

- [ ] **Step 2: 会话页与设置入口**

- 设置页「设备」按钮之上加 `settings-sessions`(`t('settings.sessions')` 电脑上的会话 / Sessions on your computer),只在已配对(真连接)时显示;演示模式也显示(演示后端有数据)。
- `sessions/index.tsx`:顶部两个分段 `sessions-tab-claude` / `sessions-tab-codex`;`useQuery(\`sessions:${provider}\`, () => backend.sessions(provider))`;列表行 `sessions-row-<key>`(标题两行 + meta + 「正在进行」小字当 `active`);`nextCursor` ⇒ `sessions-more` 按钮追加;错误:`not_found` ⇒ `sessions-unsupported`(`sessions.unsupported` 这台电脑上没有它的会话记录)、`unavailable` / `timeout` ⇒ `sessions-slow`(`sessions.slow` 电脑那边读得慢,再试一次)+ 重试。
- `sessions/[key].tsx`:`backend.session(key)` 首页 + `session-more` 追加(「继续读取」);消息 `session-message-<i>`:user 右、assistant 左,`truncated` ⇒ `chat.truncated`;顶部说明 `sessions.readOnly`(只读;要接着做,请在电脑上打开)。

i18n:`settings.sessions`、`sessions.title`(电脑上的会话 / Sessions on your computer)、`sessions.claude`(Claude Code)、`sessions.codex`(Codex)、`sessions.active`(正在进行 / In progress)、`sessions.more`(继续查找 / Load more)、`sessions.readMore`(继续读取 / Read more)、`sessions.unsupported`、`sessions.slow`、`sessions.readOnly`、`sessions.empty`(还没有会话 / No sessions yet)。

- [ ] **Step 3: Maestro `.maestro/connections.yaml`**

```yaml
# 此刻 → CC 的连接(红 / 琥珀都有文字)→ 返回 → 设置 → 电脑上的会话 → 读一条
appId: com.tendhearth.app
---
- runFlow: subflows/_start.yaml
- tapOn:
    id: welcome-look-first
- extendedWaitUntil:
    visible:
      id: now-connections
    timeout: 10000
- tapOn:
    id: now-connections
- assertVisible:
    id: connections-source-wechat_history
- assertVisible: "没加载|Not loaded"
- assertVisible:
    id: connections-computer-home
- tapOn:
    id: topbar-back
- tapOn:
    id: topbar-avatar
- scrollUntilVisible:
    element:
      id: settings-sessions
- tapOn:
    id: settings-sessions
- tapOn:
    id: sessions-row-demo-claude-1
- assertVisible:
    id: session-message-0
```

(`topbar-avatar` 以 `ui/TopBar.tsx` 实际的 testID 为准。)

- [ ] **Step 4: 回路**

```bash
cd apps/app && bun run test && bun run typecheck && bun run export:check; echo app=$?
maestro test .maestro/
```
Expected: `app=0`;全部流程 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/app
git commit -m "app:CC 的连接页 + 只读看电脑上的 Claude Code / Codex 会话

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 文档、全量回路、PR

**Files:**
- Modify: `docs/roadmap.md`、`docs/INDEX.md`、`apps/app/README.md`

- [ ] **Step 1: 文档**

- `apps/app/README.md`:「计划」一行加本计划;Maestro 表加 `chat.yaml`、`connections.yaml`,改 `compose.yaml` 的描述;「真连接的规矩」加三条:「跟 CC 说走 `/m/api/chat*`,收下即回,回复靠 `matter/<聊天>` 主题唤醒;`requestIdFor('chat', 正文)`」「本机收过回执但 daemon 那边既不 pending 也没历史 ⇒ 显示『可能没送到』(daemon 重启会丢内存里的任务表)」「连接卡与会话页拿到的都是 admin 以下的投影:没有路径」;硬要求加「主动作是跟 CC 说,交办是显式选项」。
- `docs/roadmap.md`:手机 app 一节加本计划(状态:已合 dev / 待主人真机)。
- `docs/INDEX.md`:登记 spec 与计划两份文件。

- [ ] **Step 2: 全量回路**

```bash
bun run test > /tmp/app-chat-root.log 2>&1; echo root=$?
npm run test:node > /tmp/app-chat-node.log 2>&1; echo node=$?
bun run typecheck; echo tc=$?
bun run depcheck; echo dep=$?
(cd apps/app && bun run test && bun run typecheck && bun run export:check); echo app=$?
git status --short   # 不应出现 ios/、android/、.superpowers/
```
Expected: 全部 `0`。非 0 看日志尾部定位,修掉再跑整组。

- [ ] **Step 3: Commit、推送、PR**

```bash
git add docs/roadmap.md docs/INDEX.md apps/app/README.md
git commit -m "docs:手机跟 CC 说 / 真历史 / 连接卡 / 原生会话

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin app-chat
```

开 PR 到 `dev`(标题「手机 app · 跟 CC 说话、看真历史、看 CC 的连接」;正文列 Task、计划裁决、主人真机验收清单,末尾 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`)。等 CI:`wechat-cc ci triage --wait --rerun`(0 绿 / 1 真红 / 2 没运行 / 3 flake,见 `docs/maintainer/ci-and-flakes.md`)。合并后按 `docs/maintainer/deploy.md` 走 `self deploy` + `selftest chat`。

---

## 计划裁决

1. **新开 `/m/api/chat/say`,不改 `/m/api/matter/say` 的同步语义**:老网页壳(`apps/mobile`)还在用后者同步等回复;新 app 走新路由收下即回。两条最终都进 `companionConverse`。
2. **说一句的任务表只在内存**:不加迁移、不加表。代价是 daemon 重启会丢正在等的那句 —— app 用「本机回执 + 服务端没有 + 历史里也没有 ⇒ 可能没送到」兜住(Review Focus 1),由人点重试,不自动重发(不重试风暴)。
3. **一次只等一句**:上一句在等回复时发新句 ⇒ 409 `chat_busy`,草稿留着。CC 本来就按主人会话串行,排队只会让手机显示假进度。
4. **聊天主题版本 = max(matter 时间, 最新消息时间)**:不靠在每个外发点打补丁去推 `updated_at`(messages 有多个写入方),一处读就能让微信那边的一来一回、手机这边的回复都唤醒手机。`updated_at` 本身只在入站时推(排序用)。
5. **节流 5 秒、首尾都写**:主人说「节流」;5 秒让「一起做」的顺序跟得上,又不让流式输出每秒写库。工作台回调里只记一笔(重入规矩)。微信管家「最近动过的事」的候选顺序会因此更准(它读同一个 `updated_at`)。
6. **「一起做」不列任何 chat matter**:主人对话单独置顶;访客的聊天是 CC 的社交,不该出现在主人手机的「一起做的事」里。
7. **手机拿去掉 `detail` 的连接快照**:手机是主人的设备,但它不需要插件目录与原因原文;admin 的 `/v1/connections` 给全量,下一份计划的桌面卡用它。
8. **知识库没开就不出现**:没开不是故障,不显示红;开了没建起来才红。插件快照还没出来一律「不知道」(永不撒谎)。
9. **「电脑」只有这一台**:A2A / 联邦里的别的电脑放下一份计划(那要跨机读状态,不是本机信号)。
10. **原生会话只读、只给目录名、10 秒预算**:「接着做」要动工作台的续接 / 导入流程(权限、额度、确认框),放下一份计划;cwd 与 nativeId 不出 daemon。
11. **任务对话显示最近 50 条事件**(`mattersService.detail` 现有上限);任务事件的往上翻页放下一份计划。
12. **桌面一行不改**:桌面连接卡、配对三件事(含「手机扫码改设置」改名)都在 Next plan —— 改名会碰 desktop-e2e 的文案断言,单独一份计划带着它的 e2e 一起改更稳。

## 主人要做的

- **前提**:PR #160 的内置插件修复已在真机生效(`wechat-cc` 健康输出里 `plugins.expected_missing` 为空);否则手机上的 CC 照样读不到 wxvault,连接卡会如实显示红。
- **真机验收**(iOS,安卓有设备再补):
  1. 此刻 →「跟 CC 说一句」→ 说「最近我和猪大哥聊了什么」⇒ 立刻出现我的气泡 +「在想…」⇒ 回复到达(锁屏切回来也能看到);回复里用到了 wxvault。
  2. 在微信里跟 CC 聊一句 ⇒ 手机对话页一会儿就出现那一问一答(来源标「微信」);往上滑能翻到 9 月的旧对话。
  3. 「一起做」第一行是「和 CC 的对话」,下面是真实最近在动的任务(不再只有一条);打开某个任务能看到自己说的追问。
  4. 手机在等回复时到微信里也发一句 ⇒ 手机那句显示「CC 正在回微信那边,等一下再发」,点重试能发出去。
  5. CC 的连接:微信聊天记录的日期与电脑上 wxvault 的同步时间一致;关掉某个插件后变红。
  6. 设置 → 电脑上的会话:能看到 Claude Code / Codex 的会话并读几页。
- **Codex**:`/chat`、连接卡、会话页的正式视觉稿与设计验收(本计划按现有 token 落地,结构见 spec §2)。
- **确认**:裁决 6(访客聊天不进「一起做」)是否符合预期。

## Next plan

1. **配对三件事**:桌面引导直接显示二维码 +「手机扫码改设置」改名「连接手机」(带 desktop-e2e 文案同步);Universal Links / App Links(`apple-app-site-association` / `assetlinks.json` 放中继域名,`relay/` 出这两个文件,app 的 `associatedDomains` / intent filter,扫码链接 `https://<中继>/pset/…` 直接唤起 app,没装 app 照旧是网页);换手机恢复配对(iOS 钥匙串 `kSecAttrSynchronizable` 同步配对记录、推送密钥不同步;安卓 Auto Backup 规则只备份配对记录;恢复后先 `unpair_self` 旧设备 id 再登记推送,daemon 侧要能认出「同一令牌换了设备」)。
2. **桌面「CC 的连接」卡**:用 `/v1/connections`(带 detail,红色项可直接显示原因与「插件目录」),放在此刻页或 CC 角色卡里;与手机同一套判定。
3. **原生会话「接着做」**:从手机把一个 Claude Code / Codex 会话导入工作台续接(复用 `prepareNativeResume` / `continueNativeTask`,含确认与额度)。
4. **任务对话往上翻**:`GET /m/api/matter/events?id&beforeSeq`。
5. **「电脑」多台**:A2A / 联邦里的别的电脑在线状态进连接卡。
6. **调查里的次要项**:insight 便宜模型首个请求超时 ⇒ 预热或原文回退带上最后一条用户消息;打包 sidecar 里 JS 召回 `modelCacheDir` 崩溃(`[RECALL] skip`)。
7. 之后是 v1 spec 的「补齐页面」与「真机与发布」两份计划。
