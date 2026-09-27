# bootstrap/index.ts 全部走 wire-*.ts 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/daemon/bootstrap/index.ts`(1321 行)里剩下的 9 个内联关注点逐字搬进 `bootstrap/wire-*.ts`,`index.ts` 只剩组装(目标 ≤ 400 行),`Bootstrap` 返回对象的键与类型一个不改。

**Architecture:** 每块一个 `wireX(deps, ctx)` 函数 + 一份能用最小假件单独构造它的测试;index 按原来的 boot 顺序调用并用展开把各 slice 拼回 `Bootstrap`。晚绑定统一用 `src/lib/lifecycle.ts` 的 `Ref<T>`;可能失败的块统一经 `deps.supervisor.start(name, …)`。行数与 `let … | null = null` 计数由新守卫 `scripts/bootstrap-ratchet.guard.test.ts` 钉住只降不升。

**Tech Stack:** Bun 1.3 / TypeScript / vitest 4;既有 `SubsystemSupervisor`(`src/daemon/subsystems.ts`)、`Ref`(`src/lib/lifecycle.ts`)。

**Spec:** `docs/superpowers/specs/2026-09-27-bootstrap-split-design.md`(基线行号按当前 dev 8911fc60 的 `index.ts`,与 spec 的 39cf7f5f 行号一致)。

## Global Constraints

- **逐字搬。** 块内逻辑、注释、日志文案一个字不改;只改缩进、`deps.x` → 参数名、import 路径。发现 bug 记进 ledger 另修。
- `bootstrap/types.ts` 的 `Bootstrap` / `BootstrapDeps` **不改既有键**;只在文件末尾**加** `BootstrapCtx` 与各 slice 类型。
- 既有 `src/daemon/bootstrap.test.ts`、`bootstrap.a2a.test.ts`、`bootstrap/*.test.ts`、`src/daemon/__e2e__/*` **一行不改**,每个 commit 后全绿。
- 不碰 `src/daemon/main.ts`、`src/daemon/wiring/*`、`settings-panel.ts`(Codex 热点)。
- 每个 commit 后:`bun --bun vitest run src/daemon/bootstrap src/daemon/bootstrap.test.ts src/daemon/bootstrap.a2a.test.ts scripts/bootstrap-ratchet.guard.test.ts` 绿、`bun run typecheck` 0、`bun run depcheck` 0 errors;并把守卫的 `MAX_LINES` 调到当前实数。
- 顺序与 spec §4 的差别(**本计划的一条裁决**):spec 写 knowledge 先;这里 **plugins 先**,因为 plugins 块的产物(`loadedPlugins` / MCP specs / `pluginMcpForClaude` / `knowledgePluginNames`)是 knowledge、model-options、instructions 三块的输入,先把它变成一个具名 slice,后面三块的 deps 才有名字可写。块内代码仍逐字,只是 commit 顺序不同。
- Windows CI 会跑 `src/daemon/bootstrap/*`:测试里的路径一律 `join(...)`,临时目录用 `mkdtempSync(join(tmpdir(), …))`,不写死 `/tmp`。

## Review Focus

1. **boot 顺序不能变。** 现在的顺序是 health → busy/resolve/permission/conversationStore → canUseTool → claudeBin → MCP specs/plugins → configuredAgent/selfId → knowledge → model options → sessionStore/turnTimeout → registerProviders → buildInstructions → SessionManager → access-change → self-restart → idle sweep → sendAssistantText/recordTurn/coordinator → dispatchDelegate → A2A infra → social → a2a-server → pairing → mailbox-deps → 乙。一个块搬走后 index 里的调用点必须留在**原位**(`resolveSelfAgentId` 有持久化副作用、`socialToolsWired` 在 social 之后置位、`turnTimeoutMs` 在 registerProviders 之前)。Task 10 加一条测试:用假 supervisor 记录 `sup.start` 的名字顺序 == `['knowledge','self-restart','social','a2a-server','pairing','yi']`。
2. **`buildInstructions` 在 social 接线前被调用。** 改成 `Ref<boolean>` 后 `deref` 会抛(fail-fast)而不是像今天 `let` 那样静默 false。今天没有这条路径(SessionManager 在 buildBootstrap 返回后才 spawn),Task 5 的测试钉住「未 set 时抛、set 后按值」。
3. **`sup.start` 同名二次调用直接 throw。** 新加的 `'yi'` 名字不能与现有五个重名;Task 8 的测试构造真 `SubsystemSupervisor` 跑一遍。
4. **`wrapCheapEvalWithAuthFailCheck` 有外部消费者**(`wire-workbench.ts:19` 从 `./index` 导入)。搬到 `wire-coordinator.ts` 后 index 继续 `export { wrapCheapEvalWithAuthFailCheck } from './wire-coordinator'`,wire-workbench 改成直接从 `./wire-coordinator` 导入(去掉 wire-* → index 的反向依赖)。Task 6 的测试从新位置导入。
5. **yi 块进 `sup.start` 是行为变化**(今天 ws 端口绑不上会让整个 boot 抛;改后降级为 `yiHub` undefined + `/v1/health.subsystems` 里 degraded)。spec §3 规矩 2 明说要这样;Task 8 用占住端口的方式钉住「绑不上 ⇒ degraded、boot 继续」。

---

### Task 0: 棘轮守卫 + `BootstrapCtx` 类型

**Files:**
- Create: `scripts/bootstrap-ratchet.guard.test.ts`
- Modify: `src/daemon/bootstrap/types.ts`(文件末尾追加)

**Interfaces:**
- Produces: `BootstrapCtx`(后面每个 wire 的第二个参数)

- [ ] **Step 1:** 写守卫

```ts
/**
 * bootstrap/index.ts 的棘轮守卫(spec 2026-09-27-bootstrap-split §6)。
 * 行数与 `let x: T | null = null` 晚绑定的个数只许降;新接线进 wire-*.ts。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(ROOT, 'src', 'daemon', 'bootstrap', 'index.ts'), 'utf8')

const MAX_LINES = 1321
const MAX_LET_NULL = 2   // cachedOperatorChatId, a2aServer

describe('bootstrap/index.ts 只许变小', () => {
  it(`行数 ≤ ${MAX_LINES}(新接线进 src/daemon/bootstrap/wire-*.ts)`, () => {
    const lines = src.split('\n').length - (src.endsWith('\n') ? 1 : 0)
    expect(lines).toBeLessThanOrEqual(MAX_LINES)
  })
  it(`\`let x: T | null = null\` 晚绑定 ≤ ${MAX_LET_NULL}(用 src/lib/lifecycle.ts 的 Ref)`, () => {
    const n = (src.match(/^\s*let \w+: [^=]*\| null = null/gm) ?? []).length
    expect(n).toBeLessThanOrEqual(MAX_LET_NULL)
  })
})
```

- [ ] **Step 2:** `bun --bun vitest run scripts/bootstrap-ratchet.guard.test.ts` → 2 passed。把 `MAX_LET_NULL` 临时改 1 再跑一次 → 红(证明正则真数到了),改回 2。
- [ ] **Step 3:** `types.ts` 末尾追加:

```ts
/**
 * bootstrap 拆分(spec 2026-09-27-bootstrap-split §2)—— index 在前几步造好、
 * 多个 wire-* 共用的东西。每个 wireX(deps, ctx) 的第二个参数。
 */
export interface BootstrapCtx {
  sup: import('../subsystems').SubsystemSupervisor
  log: BootstrapDeps['log']
  stateDir: string
  db: Db
  configuredAgent: AgentConfig
}
```

- [ ] **Step 4:** typecheck 0;commit `test(guard): bootstrap/index.ts 棘轮(行数 1321 / let-null 2)+ BootstrapCtx 类型`

### Task 1: wire-plugins(index.ts 296-356)

**Files:**
- Create: `src/daemon/bootstrap/wire-plugins.ts`、`wire-plugins.test.ts`
- Modify: `index.ts`

**Interfaces:**
- Consumes: `wechatStdioMcpSpec` / `delegateStdioMcpSpec` / `McpStdioSpec`(`./mcp-specs`)、`loadPlugins` / `pluginMcpSpecs`、`bundledPluginsDir`、`selfPkg.version`
- Produces:

```ts
export interface PluginsSlice {
  wechatStdioForClaude: McpStdioSpec | null
  wechatStdioForCodex: McpStdioSpec | null
  wechatStdioForCursor: McpStdioSpec | null
  wechatStdioForOpenai: McpStdioSpec | null
  wechatStdioForGemini: McpStdioSpec | null
  wechatStdioForAgy: McpStdioSpec | null
  delegateStdioByProvider: Partial<Record<ProviderId, McpStdioSpec>>
  delegateStdioForClaude: McpStdioSpec | null
  delegateStdioForCodex: McpStdioSpec | null
  delegateStdioForCursor: McpStdioSpec | null
  delegateStdioForOpenai: McpStdioSpec | null
  loadedPlugins: ReturnType<typeof loadPlugins>
  pluginMcp: ReturnType<typeof pluginMcpSpecs>
  knowledgePluginNames: string[]
  pluginMcpForClaude: Record<string, { type: 'stdio' } & McpStdioSpec>
}
export function wirePlugins(deps: Pick<BootstrapDeps, 'internalApi'>, ctx: Pick<BootstrapCtx, 'stateDir' | 'log'>): PluginsSlice
```

- [ ] **Step 1:** 写 `wire-plugins.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wirePlugins } from './wire-plugins'

describe('wirePlugins', () => {
  it('没有 internalApi ⇒ 所有 stdio spec 为 null,delegate 表为空', () => {
    const s = wirePlugins({}, { stateDir: mkdtempSync(join(tmpdir(), 'wp-')), log: () => {} })
    expect(s.wechatStdioForClaude).toBeNull()
    expect(s.delegateStdioForClaude).toBeNull()
    expect(Object.keys(s.delegateStdioByProvider)).toEqual([])
    expect(s.knowledgePluginNames).toEqual(Object.keys(s.pluginMcp))
  })
  it('有 internalApi ⇒ 每家 provider 一份 wechat spec;声明 defaultPeer 的家有 delegate spec', () => {
    const s = wirePlugins(
      { internalApi: { baseUrl: 'http://127.0.0.1:0', tokenFilePath: join(tmpdir(), 'tok') } },
      { stateDir: mkdtempSync(join(tmpdir(), 'wp-')), log: () => {} },
    )
    expect(s.wechatStdioForClaude?.env).toMatchObject({ WECHAT_INTERNAL_API: 'http://127.0.0.1:0' })
    expect(s.delegateStdioForClaude).not.toBeNull()   // claude 声明 defaultPeer=codex
    expect(s.wechatStdioForAgy).not.toBeNull()
    for (const v of Object.values(s.pluginMcpForClaude)) expect(v.type).toBe('stdio')
  })
})
```

- [ ] **Step 2:** 跑 → FAIL `Cannot find module './wire-plugins'`。
- [ ] **Step 3:** 建 `wire-plugins.ts`:头注释「从 bootstrap/index.ts 逐字搬出(2026-09-27 bootstrap 拆分)」,把 296-356 原样放进 `wirePlugins` 函数体,`deps.internalApi` 保持原名(参数就叫 `deps`)、`deps.stateDir`/`deps.log` 改 `ctx.stateDir`/`ctx.log`,末尾 `return { … 15 个键 … }`。import 从 index 里搬对应的 6 行(`mcp-specs`、`plugins/registry`、`plugins/paths`、`capability-matrix` 的 `capabilitiesFor`/`capabilityProviderIds`、`selfPkg`、`ProviderId` type)。
- [ ] **Step 4:** 跑 → 2 passed。
- [ ] **Step 5:** index.ts:删 296-356,原位改成 `const plugins = wirePlugins(deps, ctx)`(`ctx` 在 `const sup = deps.supervisor` 之后一行构造:`const ctxBase = { sup, log: deps.log, stateDir: deps.stateDir, db: deps.db }`;`configuredAgent` 在 368 行才有,所以 Task 1–3 用 `ctxBase`,Task 2 起 knowledge 处用 `const ctx = { ...ctxBase, configuredAgent }`)。后面所有用到 `wechatStdioForClaude` 等 15 个名字的地方前缀 `plugins.`(`registerProviders` 的入参对象、`sdkOptionsForProject`、`buildInstructions`、knowledge 的 `loadedPlugins.find`)。删掉 index 里因此不再用的 import(typecheck 不报未用 import,用 `rg -n "<name>" index.ts` 逐个确认)。
- [ ] **Step 6:** 全套(Global Constraints 那条命令)绿;typecheck 0;depcheck 0 err;`MAX_LINES` 调到 `wc -l` 实数。
- [ ] **Step 7:** commit `bootstrap: plugins / MCP specs 搬到 wire-plugins.ts(逐字);index.ts 1321 → N`

### Task 2: wire-knowledge(394-557)

**Files:** Create `wire-knowledge.ts`、`wire-knowledge.test.ts`;Modify `index.ts`

**Interfaces:**
- Consumes: `PluginsSlice['loadedPlugins']`
- Produces:

```ts
export function wireKnowledge(
  ctx: Pick<BootstrapCtx, 'sup' | 'log' | 'stateDir' | 'configuredAgent'>,
  loadedPlugins: PluginsSlice['loadedPlugins'],
): Promise<Bootstrap['knowledge']>      // 内部就是 ctx.sup.start('knowledge', …)
```

`KNOWLEDGE_EMBED_MODEL_VERSION`(118-126)随块搬走。

- [ ] **Step 1:** 写测试

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubsystemSupervisor } from '../subsystems'
import { wireKnowledge } from './wire-knowledge'

const base = () => ({ sup: new SubsystemSupervisor(() => {}), log: () => {}, stateDir: mkdtempSync(join(tmpdir(), 'wk-')) })

describe('wireKnowledge', () => {
  it('knowledge_enabled 未设 ⇒ undefined,supervisor 记 off', async () => {
    const ctx = base()
    const k = await wireKnowledge({ ...ctx, configuredAgent: {} as any }, [])
    expect(k).toBeUndefined()
    expect(ctx.sup.statuses().find(s => s.name === 'knowledge')?.state).toBe('off')
  })
  it('开着、没有 wxsearch 插件 ⇒ store/graph/facts/person 齐,embedder 缺席', async () => {
    const ctx = base()
    const k = await wireKnowledge({ ...ctx, configuredAgent: { knowledge_enabled: true } as any }, [])
    try {
      expect(k?.store).toBeDefined(); expect(k?.graph).toBeDefined(); expect(k?.facts).toBeDefined(); expect(k?.person).toBeDefined()
      expect(k?.embedder).toBeUndefined(); expect(k?.embedQuery).toBeUndefined()
      expect(ctx.sup.statuses().find(s => s.name === 'knowledge')?.state).toBe('ok')
    } finally { k?.store.close() }
  })
  it('store 打不开 ⇒ degraded,不外抛', async () => {
    const ctx = base()
    writeFileSync(join(ctx.stateDir, 'knowledge'), 'not a dir')   // 占住目录名
    const k = await wireKnowledge({ ...ctx, configuredAgent: { knowledge_enabled: true } as any }, [])
    expect(k).toBeUndefined()
    expect(ctx.sup.statuses().find(s => s.name === 'knowledge')?.state).toBe('degraded')
  })
})
```

- [ ] **Step 2:** 跑 → FAIL(模块不存在)。
- [ ] **Step 3:** 建 `wire-knowledge.ts`:118-126 常量 + 394-557 整段(含 `await sup.start('knowledge', …)`)逐字;`deps.log`→`ctx.log`、`deps.stateDir`→`ctx.stateDir`、`configuredAgent`→`ctx.configuredAgent`、`loadedPlugins` 是参数。import 搬 `openKnowledge / semanticSearch / runSourceAdapter / runIndexer / makeEmbedderService / makeJsEmbedder / withEmbedderFallback / rebuildGraphFromSource / makeGraphQueryApi / makeFactsApi / makePersonApi / runKnowledgeCycle / pluginDataDir / findOnPath`。
- [ ] **Step 4:** 跑 → 3 passed(第三条若 openKnowledge 对「路径是文件」的报错不是抛而是别的形状,改用 `chmod 0o000` 的目录;Windows 上该条 `it.skipIf(process.platform === 'win32')`)。
- [ ] **Step 5:** index:`const knowledge = await wireKnowledge(ctx, plugins.loadedPlugins)`,删原块与常量。
- [ ] **Step 6:** 全套绿、typecheck、depcheck、`MAX_LINES` 下调。
- [ ] **Step 7:** commit `bootstrap: knowledge 搬到 wire-knowledge.ts(逐字);index.ts N → M`

### Task 3: wire-permissions(215-287:busy / resolve / permissionMode / conversationStore / buildCanUseTool)

**Files:** Create `wire-permissions.ts`、`wire-permissions.test.ts`;Modify `index.ts`

**Interfaces:**
- Produces:

```ts
export interface PermissionsSlice {
  busyRegistry: ReturnType<typeof makeBusyRegistry>
  resolve: Bootstrap['resolve']
  permissionMode: PermissionMode
  conversationStore: ConversationStore
  buildCanUseTool: (chatId: string) => ReturnType<typeof makeCanUseTool>
}
export function wirePermissions(
  deps: Pick<BootstrapDeps, 'loadProjects' | 'fallbackProject' | 'dangerouslySkipPermissions' | 'conversationStore' | 'ilink'>,
  ctx: Pick<BootstrapCtx, 'db' | 'stateDir' | 'log'>,
): PermissionsSlice
```

- [ ] **Step 1:** 测试

```ts
import { describe, it, expect, vi } from 'vitest'
import { openTestDb } from '../../lib/db'            // bootstrap.test.ts 用的同一个帮手;若名字不同照它的来
import { wirePermissions } from './wire-permissions'

const deps = (over: Partial<Parameters<typeof wirePermissions>[0]> = {}) => ({
  loadProjects: () => ({ projects: { P: { path: '/p', last_active: 0 } }, current: 'P' }),
  ilink: { askUser: vi.fn() } as any,
  ...over,
})
const ctx = () => ({ db: openTestDb(), stateDir: '/tmp/state', log: () => {} })

describe('wirePermissions', () => {
  it('resolve 用 projects.current;permissionMode 随 dangerouslySkipPermissions', () => {
    const s = wirePermissions(deps(), ctx())
    expect(s.resolve('any')).toEqual({ alias: 'P', path: '/p' })
    expect(s.permissionMode).toBe('strict')
    expect(wirePermissions(deps({ dangerouslySkipPermissions: true }), ctx()).permissionMode).toBe('dangerously')
  })
  it('注入的 conversationStore 原样返回;不注入则自己造一个', () => {
    const store = { get: () => undefined } as any
    expect(wirePermissions(deps({ conversationStore: store }), ctx()).conversationStore).toBe(store)
    expect(wirePermissions(deps(), ctx()).conversationStore).toBeDefined()
  })
  it('buildCanUseTool 每次给一个函数;busyRegistry 能 hold/release', () => {
    const s = wirePermissions(deps(), ctx())
    expect(typeof s.buildCanUseTool('chat-1')).toBe('function')
    const release = s.busyRegistry.hold('t'); expect(s.busyRegistry.busy()).toBe(true); release(); expect(s.busyRegistry.busy()).toBe(false)
  })
})
```

- [ ] **Step 2:** 跑 → FAIL。
- [ ] **Step 3:** 建文件,215-287 逐字(`resolveAdminChatId`、`loadAccess`、`loadCompanionConfig`、`resolveTier`、`makeCanUseTool`、`makeResolver`、`makeConversationStore`、`makeBusyRegistry` 的 import 一起搬)。
- [ ] **Step 4:** 跑 → 3 passed。
- [ ] **Step 5:** index:`const perm = wirePermissions(deps, ctxBase)`,后文 `busyRegistry`/`resolve`/`permissionMode`/`conversationStore`/`buildCanUseTool` 改 `perm.x`(或解构一行 `const { busyRegistry, resolve, permissionMode, conversationStore, buildCanUseTool } = perm` —— 选解构,后面的调用点不用动)。
- [ ] **Step 6–7:** 全套 + 棘轮 + commit `bootstrap: busy / resolver / canUseTool 搬到 wire-permissions.ts(逐字)`

### Task 4: wire-model-options(559-651)+ claude 环境两个帮手(97-157)

**Files:** Create `wire-model-options.ts`、`wire-model-options.test.ts`、`claude-env.ts`;Modify `index.ts`

**Interfaces:**
- Consumes: `PluginsSlice`(wechatStdioForClaude / delegateStdioForClaude / pluginMcpForClaude)、`PermissionsSlice['permissionMode' | 'buildCanUseTool']`、`claudeBin`
- Produces:

```ts
// claude-env.ts(纯搬:resolveClaudeBinary 97-116、CLAUDE_AUTH_ENV_KEYS + hydrateClaudeAuthEnvFromUserSettings 128-157)
export function resolveClaudeBinary(): string | undefined
export function hydrateClaudeAuthEnvFromUserSettings(log: BootstrapDeps['log']): void

// wire-model-options.ts
export interface ModelOptionsSlice {
  readAgentConfig: ReturnType<typeof makeMtimeCachedConfigReader>
  currentClaudeModel: () => string
  currentModelFor: (providerId: ProviderId) => string | undefined
  sdkOptionsForProject: Bootstrap['sdkOptionsForProject']
}
export function wireModelOptions(
  ctx: Pick<BootstrapCtx, 'stateDir'>,
  parts: { plugins: Pick<PluginsSlice, 'wechatStdioForClaude' | 'delegateStdioForClaude' | 'pluginMcpForClaude'>; permissionMode: PermissionMode; buildCanUseTool: PermissionsSlice['buildCanUseTool']; claudeBin: string | undefined },
): ModelOptionsSlice
```

- [ ] **Step 1:** 测试(`claude-env` 的 `resolveClaudeBinary` 只测「env 覆盖优先」:设 `CLAUDE_CODE_EXECUTABLE` 指向一个 mkdtemp 里 `writeFileSync` 的文件,期望返回它,`finally` 恢复 env)

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TIER_PROFILES } from '../../core/user-tier'
import { wireModelOptions } from './wire-model-options'

const dir = () => mkdtempSync(join(tmpdir(), 'wmo-'))
const spec = { command: 'x', args: [], env: { A: '1' } }

describe('wireModelOptions', () => {
  it('sdkOptionsForProject:cwd / wechat+delegate stdio(会话 env 合并进去)/ preset 提示 / canUseTool', () => {
    const s = wireModelOptions({ stateDir: dir() }, {
      plugins: { wechatStdioForClaude: spec, delegateStdioForClaude: spec, pluginMcpForClaude: {} },
      permissionMode: 'strict', buildCanUseTool: () => (async () => ({ behavior: 'allow' })) as any, claudeBin: undefined,
    })
    const o = s.sdkOptionsForProject('P', '/p', TIER_PROFILES.admin, 'chat-1', { WECHAT_SESSION_TOKEN: 't' }, 'hello')
    expect(o.cwd).toBe('/p')
    expect((o.mcpServers as any).wechat.env).toMatchObject({ A: '1', WECHAT_SESSION_TOKEN: 't' })
    expect((o.systemPrompt as any).append).toBe('hello')
    expect(typeof o.canUseTool).toBe('function')
    expect(o.settingSources).toEqual(['project', 'local'])
  })
  it('没钉模型时 currentModelFor 报各家默认名,claude 走 currentClaudeModel', () => {
    const s = wireModelOptions({ stateDir: dir() }, { plugins: { wechatStdioForClaude: null, delegateStdioForClaude: null, pluginMcpForClaude: {} }, permissionMode: 'strict', buildCanUseTool: () => (() => {}) as any, claudeBin: undefined })
    expect(s.currentModelFor('claude')).toBe(s.currentClaudeModel())
    expect(typeof s.currentModelFor('cursor')).toBe('string')
    expect(s.currentModelFor('openai')).toBeUndefined()
  })
})
```

- [ ] **Step 2:** 跑 → FAIL。
- [ ] **Step 3:** 建 `claude-env.ts`(97-116、128-157 逐字,含头注释)与 `wire-model-options.ts`(559-651 逐字;`deps.stateDir`→`ctx.stateDir`;`wechatStdioForClaude` 等改 `parts.plugins.x`,`permissionMode`/`buildCanUseTool`/`claudeBin` 改 `parts.x`)。import 搬 `makeMtimeCachedConfigReader / modelForProvider / DEFAULT_*_MODEL / tierProfileToClaudeSdkOpts / Options / TierProfile`。
- [ ] **Step 4:** 跑 → 2 passed。
- [ ] **Step 5:** index:`hydrateClaudeAuthEnvFromUserSettings` 与 `resolveClaudeBinary` 改从 `./claude-env` 导入(调用点不动);`const model = wireModelOptions(ctxBase, { plugins, permissionMode, buildCanUseTool, claudeBin })` + 解构四个名字。
- [ ] **Step 6–7:** 全套 + 棘轮 + commit `bootstrap: model options 搬到 wire-model-options.ts,claude 环境帮手到 claude-env.ts(逐字)`

### Task 5: wire-instructions(703-865)

**Files:** Create `wire-instructions.ts`、`wire-instructions.test.ts`;Modify `index.ts`

**Interfaces:**
- Consumes: `Ref`(`src/lib/lifecycle.ts`)、`PluginsSlice['delegateStdioByProvider' | 'knowledgePluginNames']`、`defaultProviderId`、`knowledge`
- Produces:

```ts
export function wireInstructions(
  deps: Pick<BootstrapDeps, 'ilink' | 'personaFor' | 'stickerTagsFor' | 'careLevelFor' | 'newRelationshipFor' | 'companionOfferFor' | 'coreMemoryFor' | 'curatedMemoryFor' | 'knowledgeMemoryFor' | 'bubbleRepliesFor'>,
  parts: {
    plugins: Pick<PluginsSlice, 'delegateStdioByProvider' | 'knowledgePluginNames'>
    defaultProviderId: ProviderId
    knowledge: Bootstrap['knowledge']
    /** social 接线完成后 index 置位;buildInstructions 每次 deref —— 没 set 就调用是编程错误,直接抛。 */
    socialWired: Ref<boolean>
  },
): Bootstrap['buildInstructions']
```

- [ ] **Step 1:** 测试

```ts
import { describe, it, expect } from 'vitest'
import { Ref } from '../../lib/lifecycle'
import { TIER_PROFILES } from '../../core/user-tier'
import { wireInstructions } from './wire-instructions'

const deps = () => ({ ilink: { companion: { status: () => ({ enabled: false }) } } as any })
const parts = (socialWired: Ref<boolean>) => ({ plugins: { delegateStdioByProvider: {}, knowledgePluginNames: [] }, defaultProviderId: 'claude' as const, knowledge: undefined, socialWired })

describe('wireInstructions', () => {
  it('social 未接线就要提示词 ⇒ 抛(fail-fast,不是静默 false)', () => {
    const build = wireInstructions(deps(), parts(new Ref<boolean>('socialWired')))
    expect(() => build('claude', TIER_PROFILES.admin, 'c')).toThrow(/socialWired/)
  })
  it('set 之后按值:admin + social 接好 ⇒ 提示词含社交段;guest ⇒ 不含', () => {
    const ref = new Ref<boolean>('socialWired'); ref.set(true)
    const build = wireInstructions(deps(), parts(ref))
    expect(build('claude', TIER_PROFILES.admin, 'c')).toContain('替主人交朋友')
    expect(build('claude', TIER_PROFILES.guest, 'c')).not.toContain('替主人交朋友')
  })
  it('空贴纸库 + 无 memory_write ⇒ 降成 null(不提 save_sticker)', () => {
    const ref = new Ref<boolean>('socialWired'); ref.set(false)
    const build = wireInstructions({ ...deps(), stickerTagsFor: () => [] }, parts(ref))
    expect(build('claude', TIER_PROFILES.guest, 'c')).not.toContain('save_sticker')
  })
})
```
(社交段标题是 `## 替主人交朋友(管理员)`,见 `src/core/prompt-builder.ts:459`;贴纸空库段由 `stickerEmptyLibrarySection()` 渲染(同文件 ~305 行的三态分支),标记词按该函数正文里实际出现的词填。)

- [ ] **Step 2:** 跑 → FAIL。
- [ ] **Step 3:** 建 `wire-instructions.ts`:703-865 逐字,`let socialToolsWired = false` **不搬**,块内 `socialToolsWired` 改 `parts.socialWired.deref('buildInstructions')`;`delegateStdioByProvider`/`knowledgePluginNames` 改 `parts.plugins.x`;`defaultProviderId`/`knowledge` 改 `parts.x`。import 搬 `buildSystemPrompt / capabilitiesFor / TierProfile`。
- [ ] **Step 4:** 跑 → 3 passed。
- [ ] **Step 5:** index:742 行 `let socialToolsWired = false` 改 `const socialWired = new Ref<boolean>('socialWired')`;`const buildInstructions = wireInstructions(deps, { plugins, defaultProviderId, knowledge, socialWired })`;1142 行 `socialToolsWired = !!socialWiring.social` 改 `socialWired.set(!!socialWiring.social)`。
- [ ] **Step 6–7:** 全套(`bootstrap.test.ts` 里调 `b.buildInstructions` 的用例是 social 之后的路径,应照绿)+ 棘轮 + commit `bootstrap: buildInstructions 搬到 wire-instructions.ts(逐字);socialToolsWired 改 Ref`

### Task 6: wire-coordinator(954-1059 + `wrapCheapEvalWithAuthFailCheck` 166-188 + `anomalyNotes` 676)

**Files:** Create `wire-coordinator.ts`、`wire-coordinator.test.ts`;Modify `index.ts`、`wire-workbench.ts:19`

**Interfaces:**
- Produces:

```ts
export function wrapCheapEvalWithAuthFailCheck(cheapEval: CheapEval | null, log: BootstrapDeps['log']): ((prompt: string) => Promise<string>) | undefined   // 从 index 搬来,index 继续 re-export
export interface CoordinatorSlice {
  anomalyNotes: Map<ProviderId, string>
  sendAssistantText: Bootstrap['sendAssistantText']
  coordinator: ConversationCoordinator
}
export function wireCoordinator(
  deps: Pick<BootstrapDeps, 'ilink' | 'log' | 'onTurnRecord' | 'petSignals' | 'replySinks' | 'outboundTaps'>,
  ctx: Pick<BootstrapCtx, 'db'>,
  parts: { health: HealthRuntime; resolve: Bootstrap['resolve']; sessionManager: SessionManager; conversationStore: ConversationStore; registry: ProviderRegistry; defaultProviderId: ProviderId; readAgentConfig: ModelOptionsSlice['readAgentConfig']; permissionMode: PermissionMode; turnTimeoutMs: number },
): CoordinatorSlice
```

注意:`anomalyNotes` 今天在 676 行(registerProviders 之前)声明,只被 coordinator 的 `onFallbackStreak` 和 return 的 `providerNotes` 用 —— 搬进 slice 不影响顺序(Map 的创建没有副作用)。

- [ ] **Step 1:** 测试

```ts
import { describe, it, expect, vi } from 'vitest'
import { wrapCheapEvalWithAuthFailCheck, wireCoordinator } from './wire-coordinator'

describe('wrapCheapEvalWithAuthFailCheck', () => {
  it('null ⇒ undefined;auth-failed 文案 ⇒ 抛', async () => {
    expect(wrapCheapEvalWithAuthFailCheck(null, () => {})).toBeUndefined()
    const w = wrapCheapEvalWithAuthFailCheck(async () => 'Not logged in · Please run /login', () => {})!
    await expect(w('x')).rejects.toThrow()
  })
})
describe('wireCoordinator', () => {
  it('最小假件能构造;recordTurn 经 log 打 turn_record 并喂 onTurnRecord', () => {
    const log = vi.fn(); const onTurnRecord = vi.fn()
    const s = wireCoordinator(
      { ilink: { sendMessage: vi.fn(async () => ({ msgId: 'm' })) } as any, log, onTurnRecord },
      { db: openTestDb() },
      { health: { onFailure: vi.fn(), onSuccess: vi.fn(), health: { get: () => ({}) } } as any, resolve: () => null, sessionManager: {} as any, conversationStore: {} as any,
        registry: { getCheapEval: () => null, getStrongEval: () => null } as any, defaultProviderId: 'claude', readAgentConfig: () => ({}) as any, permissionMode: 'strict', turnTimeoutMs: 1000 },
    )
    expect(s.coordinator).toBeDefined(); expect(s.anomalyNotes.size).toBe(0); expect(typeof s.sendAssistantText).toBe('function')
  })
})
```
(`openTestDb` 沿用 bootstrap.test.ts 的来源。`recordTurn` 不导出 —— 它只从 coordinator 内部走;第二条只钉「能构造 + 三个键」。)

- [ ] **Step 2:** 跑 → FAIL。
- [ ] **Step 3:** 建 `wire-coordinator.ts`:166-188、676、954-1059 逐字。import 搬 `createConversationCoordinator / TurnRecord / makeMessagesStore / formatInbound / loadAccess / assertNotAuthFailed / CheapEval / makeSendAssistantText / reportLlmTurnOutcome / shouldNoteTurnEnd`。
- [ ] **Step 4:** 跑 → 3 passed。
- [ ] **Step 5:** index:删三段;`export { wrapCheapEvalWithAuthFailCheck } from './wire-coordinator'` 放在 196 行 `resolveAdminChatId` re-export 旁;`const coord = wireCoordinator(deps, ctxBase, { health, resolve, sessionManager, conversationStore, registry, defaultProviderId, readAgentConfig, permissionMode, turnTimeoutMs })` + 解构 `anomalyNotes, sendAssistantText, coordinator`。`wire-workbench.ts:19` 改 `from './wire-coordinator'`。
- [ ] **Step 6–7:** 全套(含 `wire-workbench.test.ts`)+ 棘轮 + commit `bootstrap: coordinator / recordTurn / cheap-eval 包装搬到 wire-coordinator.ts(逐字)`

### Task 7: wire-a2a(1082-1106)

**Files:** Create `wire-a2a.ts`、`wire-a2a.test.ts`;Modify `index.ts`

**Interfaces:**
- Produces:

```ts
export interface A2aSlice {
  a2aRegistry: A2ARegistry; a2aClient: A2AClient; a2aEventsStore: A2AEventsStore
  resolveOperatorChatId: () => string | null
}
export function wireA2a(ctx: Pick<BootstrapCtx, 'stateDir' | 'db'>): A2aSlice
```

`cachedOperatorChatId` 那个 `let` 是**缓存**不是晚绑定,随函数搬进文件内部(不算 spec §3 规矩 1 的对象 —— 写进 ledger 作裁决);棘轮 `MAX_LET_NULL` 因此从 2 降到 1。

- [ ] **Step 1:** 测试

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wireA2a } from './wire-a2a'

describe('wireA2a', () => {
  it('conversations 空 ⇒ null 且不缓存;有行后 ⇒ 最早 updated_at 的 chat 并缓存', () => {
    const db = openTestDb()
    const s = wireA2a({ stateDir: mkdtempSync(join(tmpdir(), 'wa-')), db })
    expect(s.resolveOperatorChatId()).toBeNull()
    db.run("INSERT INTO conversations (chat_id, mode_kind, updated_at) VALUES ('b', 'solo', '2026-01-02T00:00:00Z'), ('a', 'solo', '2026-01-01T00:00:00Z')")   // 列见 src/lib/db.ts:77(STRICT 表,updated_at 是 TEXT)
    expect(s.resolveOperatorChatId()).toBe('a')
    db.run("DELETE FROM conversations")
    expect(s.resolveOperatorChatId()).toBe('a')   // 只缓存正命中
  })
})
```

- [ ] **Step 2–4:** RED → 建文件(1082-1106 逐字 + 三个 import)→ GREEN。
- [ ] **Step 5:** index:`const a2a = wireA2a(ctxBase)` + 解构四个名字。
- [ ] **Step 6–7:** 全套 + 棘轮(`MAX_LET_NULL` → 1)+ commit `bootstrap: A2A registry/client/events 搬到 wire-a2a.ts(逐字)`

### Task 8: wire-yi(1200-1230,经 sup.start('yi'))

**Files:** Create `wire-yi.ts`、`wire-yi.test.ts`;Modify `index.ts`

**Interfaces:**
- Produces:

```ts
export function wireYi(
  ctx: Pick<BootstrapCtx, 'sup' | 'log' | 'configuredAgent'>,
  parts: { a2aRegistry: A2ARegistry; dispatchDelegate: DelegateDispatch },
): Promise<YiHub | undefined>     // sup.start('yi', …):两段都不配置 ⇒ 返回 null ⇒ off;hub 起不来 ⇒ degraded
```

块内逻辑逐字;唯一的形状变化是外面套 `ctx.sup.start('yi', async () => { …原 31 行…; return yiHub ?? null })`(spec §3 规矩 2)。

- [ ] **Step 1:** 测试

```ts
import { describe, it, expect } from 'vitest'
import { createServer } from 'node:net'
import { SubsystemSupervisor } from '../subsystems'
import { wireYi } from './wire-yi'

const parts = { a2aRegistry: { verifyBearer: () => null } as any, dispatchDelegate: (async () => '') as any }

describe('wireYi', () => {
  it('yi_hub_listen / yi_brain 都没配 ⇒ undefined,supervisor 记 off', async () => {
    const sup = new SubsystemSupervisor(() => {})
    expect(await wireYi({ sup, log: () => {}, configuredAgent: {} as any }, parts)).toBeUndefined()
    expect(sup.statuses().find(s => s.name === 'yi')?.state).toBe('off')
  })
  it('端口被占 ⇒ degraded、不外抛(boot 继续)', async () => {
    const blocker = createServer(); await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r))
    const port = (blocker.address() as { port: number }).port
    const sup = new SubsystemSupervisor(() => {})
    try {
      const hub = await wireYi({ sup, log: () => {}, configuredAgent: { yi_hub_listen: { host: '127.0.0.1', port } } as any }, parts)
      expect(hub).toBeUndefined()
      expect(sup.statuses().find(s => s.name === 'yi')?.state).toBe('degraded')
    } finally { blocker.close() }
  })
})
```

- [ ] **Step 2–4:** RED → 建文件 → GREEN(若 `createYiWsServer.start()` 端口冲突时不抛而是别的形状,第二条按实际改成「hub 起来了就 stop 掉」并把发现记 ledger)。
- [ ] **Step 5:** index:`let yiHub: YiHub | undefined` + 两段 if 删掉,换 `const yiHub = await wireYi(ctx, { a2aRegistry, dispatchDelegate })`。
- [ ] **Step 6–7:** 全套 + 棘轮 + commit `bootstrap: 乙 v2 搬到 wire-yi.ts,经 sup.start('yi')(块内逐字)`

### Task 9: wire-mailbox-deps(1178-1198)

**Files:** Create `wire-mailbox-deps.ts`、`wire-mailbox-deps.test.ts`;Modify `index.ts`

**Interfaces:**
- Produces:

```ts
export function wireMailboxDeps(
  ctx: Pick<BootstrapCtx, 'stateDir' | 'log' | 'configuredAgent'>,
  parts: { a2aRegistry: A2ARegistry; onMailboxLetter: SocialWiring['onMailboxLetter']; readAgentConfig: ModelOptionsSlice['readAgentConfig'] },
): Bootstrap['mailboxPollerDeps']
```

- [ ] **Step 1:** 测试:三个门(social_enabled / relays 非空 / onMailboxLetter 存在)缺任一 ⇒ undefined;全有 ⇒ 返回对象且 `shouldRun()` 读 `readAgentConfig().social_enabled`(传一个可变的假 reader,翻转后 shouldRun 跟着变)。
- [ ] **Step 2–4:** RED → 建文件(逐字)→ GREEN。
- [ ] **Step 5:** index 改调用。
- [ ] **Step 6–7:** 全套 + 棘轮 + commit `bootstrap: mailboxPollerDeps 搬到 wire-mailbox-deps.ts(逐字)`

### Task 10: 规矩收口 —— a2aServer 的 let、boot 顺序测试、头注释、手册

**Files:** Modify `index.ts`、`scripts/bootstrap-ratchet.guard.test.ts`、`docs/maintainer/rules-from-real-machines.md:47`;Create `src/daemon/bootstrap/boot-order.test.ts`

- [ ] **Step 1:** 写 `boot-order.test.ts`:用一个记录 `start` 名字顺序的 `SubsystemSupervisor` 子类(或 `vi.spyOn(sup, 'start')`)跑 `buildBootstrap`(deps 照 `bootstrap.test.ts` 第一条,`stateDir` 用 mkdtemp),断言名字序列 `toEqual(['knowledge', 'self-restart', 'social', 'a2a-server', 'pairing', 'yi'])`。跑 → 红(还没有 `'yi'`?—— Task 8 已加,应绿;若绿,把期望顺序故意换两个位置看它红,再改回)。
- [ ] **Step 2:** index 1112 行 `let a2aServer: … | null = null` + 1157 行赋值 ⇒ `const a2aServer = a2aWiring?.a2aServer ?? null`(紧跟 a2aWiring;pairing 的 `url:` 用它,顺序不变)。守卫 `MAX_LET_NULL` → 0。
- [ ] **Step 3:** index 头注释(1-31)改写:列 wire-* 清单(现有 + 新九个 + claude-env)、boot 顺序一句话、「新接线进 wire-*,index 只组装;`Ref` 是唯一晚绑定;可失败的块经 `sup.start`」。这是本计划唯一一处**非逐字**的文本改动。
- [ ] **Step 4:** `rules-from-real-machines.md` 47 行改成:「新接线进 `wire-*.ts`,index 只组装(spec 2026-09-27-bootstrap-split;`scripts/bootstrap-ratchet.guard.test.ts` 钉行数与 let-null 数)。晚绑定用 `src/lib/lifecycle.ts` 的 `Ref`;可能失败的块经 `supervisor.start(name)`,名字别重复(重复直接 throw)。」
- [ ] **Step 5:** `wc -l index.ts`;若 > 400,把 `sessionStore + turnTimeoutMs + SessionManager + setSessionInvalidator + idle sweep`(653-673、867-940)再搬一个 `wire-sessions.ts`(同样逐字 + 最小测试),记 ledger 裁决;≤ 400 就不动。守卫 `MAX_LINES` 调到实数。
- [ ] **Step 6:** 全套四道闸门(`bun run test` / `npm run test:node` / typecheck / depcheck)。
- [ ] **Step 7:** commit `bootstrap: 收口 —— a2aServer 去 let、boot 顺序测试、头注释与手册;index.ts N 行`

### Task 11: 推分支、PR

- [ ] `git push -u origin sweep/bootstrap-split`;`gh pr create --base dev` 标题「bootstrap/index.ts 全部走 wire-*(行为不变)」,描述贴:index.ts 行数前后、新文件清单、`MAX_LET_NULL` 2→0、`sup.start` 名单多了 `yi`(唯一行为变化:hub 起不来降级而不是 boot 失败)、四道闸门结果、已知 flake。
- [ ] 独立评审(fable)→ 修 Critical/Important → CI 绿后按主人授权合 dev(squash)。
