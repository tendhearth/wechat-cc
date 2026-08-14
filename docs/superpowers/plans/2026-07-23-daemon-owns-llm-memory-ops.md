# daemon 独占 LLM 记忆操作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面的两个 LLM 记忆操作(综合 _overview / 生成 _profile)从编译 sidecar 改走 daemon HTTP 路由,并加两道护栏(编译环境委托 daemon + CI 冒烟),消除"编译 vs bun"运行时分歧这一类 bug。

**Architecture:** daemon 侧的 LLM 综合早已 provider 注入式(`src/lib/memory-synthesis.ts` 的 `synthesizeOverview`/`synthesizeProfile`)并已在 `pipeline-deps.ts:219 synthesizeMemory` 用 daemon registry cheapEval 正确接线。抽一个共享工厂 `makeMemoryLlmOps` 供 pipeline-deps(微信命令)+ 新 internal-api 路由(桌面)共用;桌面改调路由;cli.ts 用现成 `isCompiledBundle()` 在编译环境委托 daemon 而非 inline `query()`;CI 冒烟编译 sidecar。

**Tech Stack:** internal-api RouteTable、late-bind setter(setSocial 模式)、`src/lib/runtime-info.ts` 的 `isCompiledBundle()`、CLI 现有 `internal-api-info.json` → baseUrl+token → fetch POST 模式、`bun build --compile`。

**Spec:** `docs/superpowers/specs/2026-07-23-daemon-owns-llm-memory-ops-design.md`

## Global Constraints

- **原则**:LLM/claude 调用只在 daemon 运行时发生;编译 sidecar 永不 inline spawn claude。
- **零回归**:`bun cli.ts`(dev,`isCompiledBundle()===false`)保持 inline `query()` 不变;微信「整理记忆」admin-command 路径不变;memory list/read/write/projects/profile-read/observations 等纯 IO 命令不动。
- 新路由定级 **trusted**(桌面文件 token);`route-tiers.ts` 显式登记(全量条目断言 test:54 要求每条 makeRoutes 路由有条目)。挂发布评审旗。
- **`bun run test`(vitest)不做类型检查** —— 每个动 .ts 的任务必须 `bunx tsc --noEmit`(仓库根)。backend 单文件 `bun test <file>`。
- 每任务 TDD;完成即 commit。

---

### Task 1: 抽共享 makeMemoryLlmOps 工厂

**Files:**
- Create: `src/daemon/memory-llm-ops.ts`
- Modify: `src/daemon/wiring/pipeline-deps.ts`(synthesizeMemory 改用工厂)
- Test: `src/daemon/memory-llm-ops.test.ts`

**Interfaces:**
- Consumes: `synthesizeOverview`/`synthesizeProfile`(`src/lib/memory-synthesis.ts`);`makeLifeStoresReader`;boot 的 `coordinator.getMode` + `registry`。
- Produces: `makeMemoryLlmOps(deps): { synthesize(adminChatId: string): Promise<SynthesizeResult>, generateProfile(adminChatId: string): Promise<ProfileResult> }`,deps = `{ stateDir: string, db: Db, getMode: (chatId) => Mode | undefined, registry: { get(id): {provider:{cheapEval?}}|undefined, getCheapEval(): CheapEval | null } }`。Task 2/3 消费。

- [ ] **Step 1: 写失败测试** —— `memory-llm-ops.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeMemoryLlmOps } from './memory-llm-ops'

vi.mock('../../lib/memory-synthesis', () => ({
  synthesizeOverview: vi.fn(async (o: any) => ({ ok: true, written: { path: '_overview.md', bytesWritten: 10 }, _eval: await o.sdkEval('x') })),
  synthesizeProfile: vi.fn(async (o: any) => ({ ok: true, written: { path: '_profile.json', bytesWritten: 5 }, _eval: await o.sdkEval('y') })),
  OVERVIEW_FILENAME: '_overview.md',
}))
vi.mock('./life-stores', () => ({ makeLifeStoresReader: () => ({}) }))

function make(over: Record<string, any> = {}) {
  const cheapEval = vi.fn(async (p: string) => `EVAL:${p}`)
  const deps = {
    stateDir: '/tmp/s', db: {} as any,
    getMode: vi.fn(() => ({ kind: 'solo', provider: 'claude' })),
    registry: { get: vi.fn(() => ({ provider: { cheapEval } })), getCheapEval: () => cheapEval },
    ...over,
  }
  return { ops: makeMemoryLlmOps(deps as any), cheapEval, deps }
}

describe('makeMemoryLlmOps', () => {
  it('synthesize 用会话 provider 的 cheapEval', async () => {
    const { ops, cheapEval } = make()
    const r = await ops.synthesize('admin1') as any
    expect(r.written.path).toBe('_overview.md')
    expect(cheapEval).toHaveBeenCalled()          // sdkEval routed to the daemon cheapEval
  })
  it('generateProfile 用同一 cheapEval', async () => {
    const { ops, cheapEval } = make()
    const r = await ops.generateProfile('admin1') as any
    expect(r.written.path).toBe('_profile.json')
    expect(cheapEval).toHaveBeenCalled()
  })
  it('会话非 solo → 回落 registry.getCheapEval', async () => {
    const cheap = vi.fn(async () => 'X')
    const { ops } = make({ getMode: () => ({ kind: 'parallel' }), registry: { get: () => undefined, getCheapEval: () => cheap } })
    await ops.synthesize('a')
    expect(cheap).toHaveBeenCalled()
  })
  it('无任何 provider → 抛 no LLM provider', async () => {
    const { ops } = make({ getMode: () => undefined, registry: { get: () => undefined, getCheapEval: () => null } })
    await expect(ops.synthesize('a')).rejects.toThrow(/no LLM provider/)
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun test src/daemon/memory-llm-ops.test.ts`(模块不存在)。

- [ ] **Step 3: 实现** —— `src/daemon/memory-llm-ops.ts`(把 pipeline-deps:219 的 synthesizeMemory 逻辑提出来,加 generateProfile 对称版):

```ts
/**
 * memory-llm-ops.ts — the daemon's LLM-backed memory operations (overview
 * synthesis + profile generation), wired with the daemon's OWN provider
 * cheapEval (claude path resolved correctly). Shared by BOTH the WeChat
 * admin-command path (pipeline-deps synthesizeMemory) and the internal-api
 * routes the desktop calls (routes-memory). This is the single place LLM
 * memory ops run — NEVER the compiled CLI sidecar (spec §1).
 */
import type { Db } from '../lib/db'

export interface MemoryLlmOpsDeps {
  stateDir: string
  db: Db
  getMode: (chatId: string) => { kind: string; provider?: string } | undefined
  registry: {
    get(id: string): { provider: { cheapEval?: (p: string) => Promise<string> } } | undefined
    getCheapEval(): ((p: string) => Promise<string>) | null
  }
}

export interface MemoryLlmOps {
  synthesize(adminChatId: string): Promise<import('../lib/memory-synthesis').SynthesizeResult>
  generateProfile(adminChatId: string): Promise<import('../lib/memory-synthesis').ProfileResult>
}

export function makeMemoryLlmOps(deps: MemoryLlmOpsDeps): MemoryLlmOps {
  // Follow the admin conversation's provider; fall back to the registry's
  // cheapest eval. (Lifted verbatim from pipeline-deps synthesizeMemory.)
  const resolveCheapEval = (adminChatId: string) => {
    const mode = deps.getMode(adminChatId)
    const provider = mode && mode.kind === 'solo' ? mode.provider : undefined
    const cheapEval = (provider ? deps.registry.get(provider)?.provider.cheapEval : null) ?? deps.registry.getCheapEval()
    if (!cheapEval) throw new Error('no LLM provider available for synthesis')
    return cheapEval
  }
  return {
    async synthesize(adminChatId) {
      const { synthesizeOverview } = await import('../lib/memory-synthesis')
      const { makeLifeStoresReader } = await import('./life-stores')
      const cheapEval = resolveCheapEval(adminChatId)
      return synthesizeOverview({ stateDir: deps.stateDir, adminChatId, sdkEval: (p) => cheapEval(p), lifeStores: makeLifeStoresReader(deps.db, deps.stateDir), includeFileSurvey: true })
    },
    async generateProfile(adminChatId) {
      const { synthesizeProfile } = await import('../lib/memory-synthesis')
      const { makeLifeStoresReader } = await import('./life-stores')
      const mode = deps.getMode(adminChatId)
      const modelProvider = mode && mode.kind === 'solo' ? (mode.provider ?? 'claude') : 'claude'
      const cheapEval = resolveCheapEval(adminChatId)
      return synthesizeProfile({ stateDir: deps.stateDir, adminChatId, sdkEval: (p) => cheapEval(p), lifeStores: makeLifeStoresReader(deps.db, deps.stateDir), generatedBy: 'manual', modelProvider })
    },
  }
}
```

（若 `SynthesizeResult`/`ProfileResult` 未从 memory-synthesis.ts 导出,顺手 export;以现文件为准。）

`pipeline-deps.ts:219`:`synthesizeMemory: async (adminChatId) => makeMemoryLlmOps({ stateDir, db, getMode: (c)=>boot.coordinator.getMode(c), registry: boot.registry }).synthesize(adminChatId)`(或在 pipeline-deps 顶部构造一次工厂复用)。行为不变(现有 admin-command 测试须仍绿)。

- [ ] **Step 4: 跑 PASS** —— 本文件 + `bun test src/daemon/wiring/*.test.ts`(接线回归);`bunx tsc --noEmit`。
- [ ] **Step 5: Commit** —— `git commit -m "refactor(memory): 抽 makeMemoryLlmOps 共享工厂(synthesize+generateProfile,daemon cheapEval)"`

---

### Task 2: internal-api 两条 memory 路由 + late-bind + 定级

**Files:**
- Modify: `src/daemon/internal-api/types.ts`(InternalApiDeps.memory + setMemory)
- Modify: `src/daemon/internal-api/index.ts`(setMemory 实现,照 setSocial)
- Create: `src/daemon/internal-api/routes-memory.ts`
- Modify: `src/daemon/internal-api/routes.ts`(注册)
- Modify: `src/daemon/internal-api/route-tiers.ts`(2 条 trusted + 评审旗)
- Modify: `src/daemon/main.ts`(setMemory 接线)
- Test: `src/daemon/internal-api/routes-memory.test.ts`、`route-tiers.test.ts`(+2 断言)

**Interfaces:**
- Consumes: Task 1 `MemoryLlmOps`。
- Produces: `POST /v1/memory/synthesize` `{chat_id?}` → `{ok, ...SynthesizeResult}` | 503;`POST /v1/memory/profile/generate` `{chat_id?}` → `{ok, ...ProfileResult}` | 503。chat_id 缺省=access.json 单一 admin(复用 CLI 的解析或注入 resolveAdminChatId)。

- [ ] **Step 1: 写失败测试** —— `routes-memory.test.ts`(镜像 routes-social.test.ts 的注入 idiom):

```ts
import { describe, it, expect, vi } from 'vitest'
import { memoryRoutes } from './routes-memory'
import type { InternalApiDeps } from './types'
const q = () => new URLSearchParams()

function deps(over: Record<string, unknown> = {}): InternalApiDeps {
  return {
    memory: {
      synthesize: vi.fn(async () => ({ ok: true, written: { path: '_overview.md', bytesWritten: 10 } })),
      generateProfile: vi.fn(async () => ({ ok: true, written: { path: '_profile.json', bytesWritten: 5 } })),
    },
    resolveAdminChatId: () => 'admin1',
    ...over,
  } as unknown as InternalApiDeps
}

describe('POST /v1/memory/synthesize', () => {
  it('未接线 → 503', async () => {
    const r = await memoryRoutes(deps({ memory: undefined }))['POST /v1/memory/synthesize']!(q(), {})
    expect(r.status).toBe(503)
  })
  it('透传 synthesize;缺省 chat_id 用 resolveAdminChatId', async () => {
    const d = deps(); const r = await memoryRoutes(d)['POST /v1/memory/synthesize']!(q(), {})
    expect(r.status).toBe(200); expect((r.body as any).written.path).toBe('_overview.md')
    expect((d.memory as any).synthesize).toHaveBeenCalledWith('admin1')
  })
  it('body.chat_id 覆盖', async () => {
    const d = deps(); await memoryRoutes(d)['POST /v1/memory/synthesize']!(q(), { chat_id: 'c9' })
    expect((d.memory as any).synthesize).toHaveBeenCalledWith('c9')
  })
})
describe('POST /v1/memory/profile/generate', () => {
  it('透传 generateProfile', async () => {
    const d = deps(); const r = await memoryRoutes(d)['POST /v1/memory/profile/generate']!(q(), { chat_id: 'c9' })
    expect(r.status).toBe(200); expect((r.body as any).written.path).toBe('_profile.json')
    expect((d.memory as any).generateProfile).toHaveBeenCalledWith('c9')
  })
})
```

`route-tiers.test.ts` 追加:
```ts
  it('memory LLM 路由 trusted', () => {
    expect(minTierFor('POST /v1/memory/synthesize')).toBe('trusted')
    expect(minTierFor('POST /v1/memory/profile/generate')).toBe('trusted')
  })
```

- [ ] **Step 2: 跑 FAIL** —— `bun test src/daemon/internal-api/routes-memory.test.ts src/daemon/internal-api/route-tiers.test.ts`。

- [ ] **Step 3: 实现**

3a. `types.ts`:InternalApiDeps 增
```ts
  /** LLM 记忆操作(daemon-only,spec 2026-07-23)。late-bound by main.ts。
   *  undefined ⇒ /v1/memory/{synthesize,profile/generate} 503。 */
  memory?: import('../memory-llm-ops').MemoryLlmOps
  /** 解析缺省 admin chat_id(access.json 单一 admin);已有则复用。 */
  resolveAdminChatId?: () => string | null
```
（`resolveAdminChatId` 若 InternalApiDeps 已有则不重复。）+ lifecycle/index setter `setMemory(m)`.

3b. `routes-memory.ts`:
```ts
import type { InternalApiDeps, RouteTable } from './types'

export function memoryRoutes(deps: InternalApiDeps): RouteTable {
  const resolveChat = (body: unknown): string | null => {
    const cid = (body as { chat_id?: unknown })?.chat_id
    if (typeof cid === 'string' && cid) return cid
    return deps.resolveAdminChatId?.() ?? null
  }
  return {
    'POST /v1/memory/synthesize': async (_q, body) => {
      if (!deps.memory) return { status: 503, body: { error: 'memory_not_wired' } }
      const chatId = resolveChat(body)
      if (!chatId) return { status: 400, body: { error: 'no_admin_chat_id' } }
      return { status: 200, body: { ok: true, ...(await deps.memory.synthesize(chatId)) } }
    },
    'POST /v1/memory/profile/generate': async (_q, body) => {
      if (!deps.memory) return { status: 503, body: { error: 'memory_not_wired' } }
      const chatId = resolveChat(body)
      if (!chatId) return { status: 400, body: { error: 'no_admin_chat_id' } }
      return { status: 200, body: { ok: true, ...(await deps.memory.generateProfile(chatId)) } }
    },
  }
}
```

3c. `routes.ts`:import + `...memoryRoutes(deps),`。
3d. `route-tiers.ts`:
```ts
  // LLM 记忆操作(spec 2026-07-23-daemon-owns-llm-memory-ops)。trusted:桌面/CLI
  // 唯一凭据是 0600 文件 token;localhost、动主人自己的记忆、烧一次 LLM。
  // ⚠️ RELEASE-REVIEW FLAG(下次 dev→master surface)。
  'POST /v1/memory/synthesize': 'trusted',
  'POST /v1/memory/profile/generate': 'trusted',
```
3e. `main.ts`:在 `if (boot.social) internalApi.setSocial(boot.social)` 旁:
```ts
    internalApi.setMemory(makeMemoryLlmOps({ stateDir, db, getMode: (c) => boot.coordinator.getMode(c), registry: boot.registry }))
```
（`stateDir`/`db`/`boot` 在 main.ts 作用域;`makeMemoryLlmOps` import。若 db 不在 main 作用域,用 boot 上等价物——以现文件为准。）

- [ ] **Step 4: 跑 PASS** —— `bun test src/daemon/internal-api/routes-memory.test.ts src/daemon/internal-api/route-tiers.test.ts src/daemon/internal-api.test.ts src/daemon/main.test.ts 2>/dev/null`;`bunx tsc --noEmit`。
- [ ] **Step 5: Commit** —— `git commit -m "feat(memory): /v1/memory/synthesize + /profile/generate 路由(trusted+评审旗)+ setMemory 接线"`

---

### Task 3: 护栏① —— CLI 编译环境委托 daemon(共享 sdkEval)

**Files:**
- Create: `src/lib/cli-llm-eval.ts`(共享 eval 工厂 + 委托)
- Modify: `cli.ts`(synthesize / profile generate / summarizer refresh 三处 query 改用工厂)
- Test: `src/lib/cli-llm-eval.test.ts`

**Interfaces:**
- Consumes: `isCompiledBundle()`(`src/lib/runtime-info.ts`);现有 `internal-api-info.json` → baseUrl+token 读取(提成 helper)。
- Produces: `makeCliSdkEval(opts): (prompt) => Promise<string>` —— `isCompiledBundle()===false` → inline `query()`/Codex(现状);`===true` → **抛 `CompiledLlmError`**(供 CLI 命令捕获后走委托或明确报错)。外加 `delegateMemoryOp(op, {chatId?}): Promise<Result>` —— 读 api-info + POST `/v1/memory/{synthesize|profile/generate}`;daemon 未起 → 结构化错误 `{ok:false, error:'daemon_required'}`。

**说明**:综合/画像命令本就调注入式 `synthesizeOverview`/`synthesizeProfile`。护栏做法:命令层先判 `isCompiledBundle()` —— 若编译,**不本地跑核心**,直接 `delegateMemoryOp` 委托 daemon(daemon 有正确 provider);否则本地 inline(dev)。summarizer refresh(fire-and-forget)同样在编译环境跳过 inline query,记一行日志(后台操作,不阻断)。

- [ ] **Step 1: 写失败测试** —— `cli-llm-eval.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeCliSdkEval, delegateMemoryOp, CompiledLlmError } from './cli-llm-eval'

describe('makeCliSdkEval', () => {
  it('非编译 → inline eval 被调', async () => {
    const inline = vi.fn(async () => 'OUT')
    const ev = makeCliSdkEval({ isCompiled: () => false, inline })
    expect(await ev('p')).toBe('OUT')
  })
  it('编译 → 抛 CompiledLlmError(不 inline spawn)', async () => {
    const inline = vi.fn()
    const ev = makeCliSdkEval({ isCompiled: () => true, inline })
    await expect(ev('p')).rejects.toBeInstanceOf(CompiledLlmError)
    expect(inline).not.toHaveBeenCalled()
  })
})

describe('delegateMemoryOp', () => {
  it('POST 到 daemon 路由;成功透传', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, written: { path: '_overview.md' } }) }))
    const r = await delegateMemoryOp('synthesize', { chatId: 'a' }, {
      readApiInfo: () => ({ baseUrl: 'http://127.0.0.1:9', token: 't' }),
      fetch: fetchMock as any,
    })
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:9/v1/memory/synthesize', expect.objectContaining({ method: 'POST' }))
    expect((r as any).written.path).toBe('_overview.md')
  })
  it('daemon 未起 → {ok:false, error:daemon_required}', async () => {
    const r = await delegateMemoryOp('synthesize', {}, { readApiInfo: () => null, fetch: (async () => {}) as any })
    expect(r).toEqual({ ok: false, error: 'daemon_required' })
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bun test src/lib/cli-llm-eval.test.ts`。
- [ ] **Step 3: 实现** —— `cli-llm-eval.ts`(`CompiledLlmError` class;`makeCliSdkEval` 编译则抛;`delegateMemoryOp` 读 api-info + fetch POST,注入式 readApiInfo/fetch 便于测)。cli.ts 的 synthesize/profile-generate `run()`:开头 `if (isCompiledBundle()) { const r = await delegateMemoryOp('synthesize', {chatId}); print(r); return }` 否则现状 inline。summarizer refresh:`if (isCompiledBundle()) { log skip; return }`。
- [ ] **Step 4: 跑 PASS** —— 本文件 + `bunx tsc --noEmit`。
- [ ] **Step 5: Commit** —— `git commit -m "feat(cli): 护栏① 编译 sidecar 里 LLM 记忆操作委托 daemon(不 inline spawn claude);dev 保持 inline"`

---

### Task 4: 桌面改调 daemon 路由

**Files:**
- Modify: `apps/desktop/src/modules/memory.js`
- Test: `apps/desktop/src/modules/memory.test.ts`(如存在;否则相应现有测试)

**Interfaces:**
- Consumes: Task 2 两条路由;`invokeApi`(`apps/desktop/src/api.js`)。

- [ ] **Step 1: 写失败测试** —— memory.test.ts 断言 `synthesizeMemory`/profile-generate 调 `invokeApi('POST', '/v1/memory/synthesize')` / `.../profile/generate`,不再 `invoke('wechat_cli_json', {args:['memory','synthesize']})`;503 → 显示"需要守护进程运行"文案。

- [ ] **Step 2: 跑 FAIL** —— `bunx vitest run apps/desktop/src/modules/memory.test.ts`。
- [ ] **Step 3: 实现** —— memory.js:`synthesizeMemory`(line ~312)`deps.invoke("wechat_cli_json", {args:["memory","synthesize","--json"]})` → `deps.invokeApi("POST","/v1/memory/synthesize")`(注入 invokeApi dep);profile-generate(line ~384)同理 → `invokeApi("POST","/v1/memory/profile/generate", { chat_id: chatId })`。503/网络错 → 清楚文案。synthesize 是慢操作(LLM)→ 用 45s+ 超时(同 propose 先例,`invokeApi` 的 timeoutMs)。
- [ ] **Step 4: 跑 PASS** —— 本文件 + `bunx tsc --noEmit`(桌面基线已净)。
- [ ] **Step 5: Commit** —— `git commit -m "feat(desktop): 记忆综合/画像改调 daemon /v1/memory/* 路由(消除编译 sidecar LLM 分歧)"`

---

### Task 5: 护栏② —— CI 编译 sidecar 冒烟

**Files:**
- Modify: `.github/workflows/ci.yml`（build job 加一步 / 新 job）
- Create: `scripts/smoke-compiled-sidecar.ts`（冒烟脚本）

**Interfaces:** 无代码消费者;CI 门。

- [ ] **Step 1: 冒烟脚本** —— `scripts/smoke-compiled-sidecar.ts`:`bun build --compile cli.ts` 出 sidecar(照 build-sidecar.ts 的 target),在**无 daemon**环境跑 `<sidecar> memory synthesize --json`,断言输出是**结构化 JSON** 含 `ok:false` + `error:'daemon_required'`(护栏①的委托-无daemon 分支),**而非** bunfs 崩溃 / `Claude Code process exited` / 非 JSON。退出码据断言。
- [ ] **Step 2: ci.yml** —— build job(ubuntu)加步骤 `Compiled-sidecar smoke: bun scripts/smoke-compiled-sidecar.ts`(只在 linux 跑,省 matrix)。
- [ ] **Step 3: 本地验证** —— 本地跑 `bun scripts/smoke-compiled-sidecar.ts`,绿(证明护栏①在真编译产物里生效——这是本弧最硬的端到端证据:编译版不再崩、而是干净委托)。
- [ ] **Step 4: Commit** —— `git commit -m "ci(guard): 编译 sidecar 冒烟——LLM 记忆操作在编译环境干净委托 daemon(防编译-vs-bun 分歧复发)"`

---

### Task 6: 全量回归 + 架构记忆

**Files:** 无代码(验证 + 文档)。

- [ ] **Step 1: 全量** —— 仓库根 `bun run test` 全绿 + `bunx tsc --noEmit` 0 错。
- [ ] **Step 2: grep 守卫** —— `grep -rn "query(" cli.ts` 的每处都在 `isCompiledBundle()` 门后(或经 makeCliSdkEval);`grep -rn "memory.*synthesize\|profile.*generate" apps/desktop/src/modules/memory.js` 命中的是 invokeApi 不是 wechat_cli_json。
- [ ] **Step 3: 架构记忆** —— 更新 `architecture-conventions` memory:加"LLM=daemon-only,编译 sidecar=仅 daemon-down 生命周期;新 LLM 功能走 daemon HTTP 路由;CI 有编译-sidecar 冒烟守卫"。
- [ ] **Step 4: Commit（若 1-2 无代码改动则跳过）**

---

## Self-Review 结论(已跑)

- **Spec 覆盖**:§1 原则=Task 6 记忆;§2 两路由+定级=Task 1(工厂)+Task 2;§3 桌面=Task 4;§4 护栏①=Task 3、护栏②=Task 5。测试逐条对应。无缺口。
- **占位符**:无 TBD;接线细节标注"以现文件为准"是对既有 idiom 的引用(setSocial/api-info helper),非缺失。
- **一致性**:`MemoryLlmOps` 形状 T1 定义、T2 路由/main.ts 消费一致;`delegate` 的路由路径与 T2 注册一致;trusted 定级 T2 登记 + route-tiers 全量断言;桌面 45s 超时复用 propose 先例的 `invokeApi.timeoutMs`。
