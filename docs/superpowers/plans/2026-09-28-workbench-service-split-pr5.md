# workbench service 拆分 · PR 5(artifacts / 代码快照域)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 artifacts 域(回合/结算的成果收集、代码变更快照、基线重取,7 个闭包 + `artifact` / `approve` 两个入口)逐字搬进 `src/core/workbench/service/artifacts.ts`;前置是把 `service.ts` 模块级的 `directoryIdentity` 挪成 `service/directory-identity.ts`。**行为一字不变**,19 份既有 `service*.test.ts` 一行不改、全绿;棘轮再下调。

**Architecture:** 同 PR 1–4。本域不需要新的 ctx 字段(只用 `store` / `stateDir` / `state.shutdownComplete` / `state.collections` / `hub.touched`),也没有跨域动作;`approve` 里的 `service.artifact(...)` 改成域内直接调 `artifact(...)`(同一函数,少一层晚绑定)。`revokeCredentials` 夹在中间但属凭据生命周期,留给 lifecycle PR;`captureCodeChanges` 上面那段「一个文件夹,同时只有一个还能写它的会话」长注释讲的是租约语义,留在 service.ts(它紧挨 `quiet` / 空闲收工那块)。

**Tech Stack:** TypeScript(`strict` + `verbatimModuleSyntax`)、vitest、dependency-cruiser。

**Spec:** `docs/superpowers/specs/2026-09-27-workbench-service-split-design.md`(§3 第 5 项)。基线 dev `24aefd8d`(#136 之后)。

## Global Constraints

- 分支 `sweep/workbench-service-split-5`,工作树 `.claude/worktrees/deploy-dev`;进 dev 走 PR + squash。
- 不改任何行为、错误码、**事件文案**(成果收集的四句提示逐字)。逐字搬,注释一起搬。
- 不改 public 方法签名;19 份既有 `src/core/workbench/service*.test.ts` 一行不改。
- `service/*.ts` 禁止 import `../service`。
- 每个任务一个 commit,中文,结尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## Review Focus

1. **`collect` 的 promise 登记在 `state.collections`**(shutdown 用 `while(collections.size)await Promise.allSettled([...collections])` 等它们)—— 域用的必须是同一个 Set。Task 2 域单测「collect 进行中 state.collections 有它、结束后没了」钉住。
2. **`captureTaskArtifacts` 的三种失败各自的文案与 `collectionFailure` 去重**(同一种失败只记一次事件,恢复时记恢复)—— Task 2 域单测「路径失效两次只一条事件;恢复一条恢复文案」钉住。
3. **`captureCodeChanges` 复用在途 promise**(续接会 await 它再取新基线)—— Task 2 域单测「两次调用返回同一个 promise」钉住。
4. **`retakeBaseline` 的在途守卫 `baselineRetaking`**:失败也要复位为 false —— Task 2 域单测「非 git 目录 ⇒ 无基线、baselineRetaking=false」钉住。
5. **`directoryIdentity` 搬走后 service.ts 十几处调用点不改**(只换 import)—— Task 1 以 typecheck + 19 份测试为门;域单测「目录 ⇒ dev:ino;文件 ⇒ invalid_path」钉住语义。

---

### Task 1: `service/directory-identity.ts`

**Files:**
- Create: `src/core/workbench/service/directory-identity.ts`、`src/core/workbench/service/directory-identity.test.ts`
- Modify: `src/core/workbench/service.ts`(删模块级 `directoryIdentity`,加 import;`statSync` 若只剩它在用就一并删 import)

- [ ] **Step 1: 写测试(红)**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../../lib/test-temp'
import { directoryIdentity } from './directory-identity'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) removeTempDir(d) })

describe('directoryIdentity', () => {
  it('目录 ⇒ "dev:ino"(bigint,和 statSync 一致);同一目录两次相同', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-dir-id-'))); dirs.push(dir)
    const st = statSync(dir, { bigint: true })
    expect(directoryIdentity(dir)).toBe(`${st.dev}:${st.ino}`)
    expect(directoryIdentity(dir)).toBe(directoryIdentity(dir))
  })
  it('普通文件 / 不存在 ⇒ 抛(文件是 invalid_path)', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-dir-id-'))); dirs.push(dir)
    const file = join(dir, 'f.txt'); writeFileSync(file, 'x')
    expect(() => directoryIdentity(file)).toThrow('invalid_path')
    expect(() => directoryIdentity(join(dir, 'missing'))).toThrow()
  })
})
```

- [ ] **Step 2: 跑,红**(`Cannot find module './directory-identity'`)。
- [ ] **Step 3: 新建模块** —— 把 `service.ts:91-95` 逐字剪过来加 `export`,文件头注释「文件夹身份 = dev:ino;派发时记下,收集成果/截快照前核对,防项目被移动或替换(从 service.ts 挪出,域模块要用)」;`import { statSync } from 'node:fs'`。
- [ ] **Step 4: service.ts** —— 删 `:91-95`;加 `import { directoryIdentity } from './service/directory-identity'`;`grep -c "\bstatSync\b" service.ts` 若为 1(只剩 import)就删 `import { statSync } from 'node:fs'`。
- [ ] **Step 5: 验证** —— 单测 2 通过;typecheck 0;`bun --bun vitest run src/core/workbench/service` 25 文件全过。
- [ ] **Step 6: Commit** —— `workbench service 拆分 14/n:directoryIdentity 挪成 service/directory-identity.ts(artifacts 域的前置,行为不变)`

---

### Task 2: artifacts 域

**Files:**
- Create: `src/core/workbench/service/artifacts.ts`、`src/core/workbench/service/artifacts.test.ts`
- Modify: `src/core/workbench/service.ts`

**Interfaces:**
```ts
export interface ArtifactsDomain {
  collect(running:Active): Promise<void>
  collectTurnArtifacts(running:Active): void
  noteWarnings(running:Active,warnings:string[]): void
  captureTaskArtifacts(running:Active): void
  captureOutputs(running:Active): Promise<void>
  captureCodeChanges(running:Active): Promise<void>
  retakeBaseline(running:Active): Promise<void>
  artifact(id:string,artifactId:string): {name:string;mime:string;size:number;sha256:string;contentBase64:string}
  approve(id:string,artifactId:string,sha256:string): void
}
export function makeArtifactsDomain(ctx:ServiceCtx): ArtifactsDomain
```
`service.ts` 解构 `{collect,collectTurnArtifacts,captureCodeChanges,retakeBaseline}`(调用点 execute / settleQuiet / closeForIdle / submitInput 不改)。

- [ ] **Step 1: 写 `service/artifacts.test.ts`(红)**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb, type Db } from '../../../lib/db'
import { Ref } from '../../../lib/lifecycle'
import { createProviderRegistry } from '../../provider-registry'
import { makeWorkbenchStore, type WorkbenchStore } from '../store'
import { outputDirectory, saveArtifactSnapshot } from '../artifacts'
import { removeTempDir } from '../../../lib/test-temp'
import { makeRuntimeState, type Active } from './state'
import { makeArtifactsDomain } from './artifacts'
import { directoryIdentity } from './directory-identity'
import type { ServiceActions, ServiceCtx } from './ctx'

const dbs: Db[] = []; const dirs: string[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const d of dirs.splice(0)) removeTempDir(d) })

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-artifacts-domain-'))); dirs.push(root)
  const stateDir = join(root, 'state'), project = join(root, 'project')
  mkdirSync(stateDir, { recursive: true }); mkdirSync(project, { recursive: true })
  const db = openTestDb(); dbs.push(db)
  const store: WorkbenchStore = makeWorkbenchStore(db)
  const state = makeRuntimeState()
  const touched = vi.fn()
  const ctx: ServiceCtx = { store, stateDir, state, hub: { touched, bumped: vi.fn() }, deps: { ownerChatId: () => 'owner', registry: createProviderRegistry() }, ensureAccepting: () => {}, now: Date.now, actions: new Ref<ServiceActions>('t') }
  const domain = makeArtifactsDomain(ctx)
  const task = store.create({ title: '事', path: project, providerId: 'claude', ownerChatId: 'owner' })
  const running = (over: Partial<Active> = {}): Active => ({ identity: 'run-1abcdef', taskId: task.id, title: task.title, task, path: project, directoryIdentity: directoryIdentity(project), cancelled: false, finishing: false, uncertain: false, artifactsCollected: false, ...over } as unknown as Active)
  const systemEvents = () => store.events(task.id).filter(e => e.kind === 'system').map(e => e.text)
  return { store, state, domain, task, project, stateDir, touched, running, systemEvents }
}

describe('makeArtifactsDomain · 成果收集', () => {
  it('noteWarnings:同一条只记一次 system 事件、touched 一次', () => {
    const { domain, running, systemEvents, touched } = setup()
    const r = running()
    domain.noteWarnings(r, ['a', 'a', 'b']); domain.noteWarnings(r, ['b'])
    expect(systemEvents()).toEqual(['a', 'b']); expect(touched).toHaveBeenCalledTimes(2)
  })
  it('captureTaskArtifacts:成果目录里的文件进成果列表', () => {
    const { domain, running, task, project, store } = setup()
    const out = outputDirectory(project, task.id); mkdirSync(out, { recursive: true }); writeFileSync(join(out, '报告.md'), '# 好')
    domain.captureTaskArtifacts(running())
    expect(store.artifacts(task.id).map(a => a.name)).toEqual(['报告.md'])
  })
  it('captureTaskArtifacts:项目身份变了 ⇒ 一条「项目文件夹已移动…」,重复失败不重复记;恢复后一条恢复文案', () => {
    const { domain, running, systemEvents } = setup()
    const r = running({ directoryIdentity: '0:0' })
    domain.captureTaskArtifacts(r); domain.captureTaskArtifacts(r)
    expect(systemEvents()).toEqual(['项目文件夹已移动、替换或无法访问，已停止收集成果。请检查原项目位置。'])
    expect(r.collectionFailure).toBe('project')
    ;(r as { directoryIdentity: string }).directoryIdentity = directoryIdentity(r.path)
    domain.captureTaskArtifacts(r)
    expect(systemEvents().at(-1)).toBe('成果收集已恢复，文件已保存，可在成果列表查看。')
    expect(r.collectionFailure).toBeUndefined()
  })
})

describe('makeArtifactsDomain · 结算与回合', () => {
  it('collect:同一 run 复用同一个 promise,进行中登记在 state.collections、结束后移除;shutdownComplete ⇒ 直接 resolve 不标记', async () => {
    const { domain, running, state } = setup()
    const r = running()
    const p = domain.collect(r)
    expect(domain.collect(r)).toBe(p); expect(state.collections.has(p)).toBe(true)
    await p
    expect(state.collections.size).toBe(0); expect(r.artifactsCollected).toBe(true)
    state.shutdownComplete = true
    const r2 = running()
    await domain.collect(r2); expect(r2.artifactsCollected).toBe(false)
  })
  it('collectTurnArtifacts:让出一拍后收集;已结算 / 已取消的 run 不收', async () => {
    const { domain, running, task, project, store } = setup()
    const out = outputDirectory(project, task.id); mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'x.txt'), 'x')
    const r = running()
    domain.collectTurnArtifacts(r)
    expect(store.artifacts(task.id)).toEqual([])          // 还没到 setImmediate
    await r.turnCollection
    expect(store.artifacts(task.id).map(a => a.name)).toEqual(['x.txt']); expect(r.turnCollection).toBeUndefined()
    const r2 = running({ cancelled: true })
    domain.collectTurnArtifacts(r2); await r2.turnCollection
    expect(store.artifacts(task.id)).toHaveLength(1)
  })
  it('captureCodeChanges:没有基线 ⇒ 什么都不做;在途的那份被复用', async () => {
    const { domain, running, task, store } = setup()
    const r = running()
    const p = domain.captureCodeChanges(r)
    expect(domain.captureCodeChanges(r)).toBe(p)
    await p
    expect(store.artifacts(task.id)).toEqual([]); expect(r.reviewCapture).toBeUndefined()
  })
  it('retakeBaseline:cancelled ⇒ 不取;非 git 目录 ⇒ 无基线但 baselineRetaking 复位', async () => {
    const { domain, running } = setup()
    const rc = running({ cancelled: true }); await domain.retakeBaseline(rc); expect(rc.reviewBaseline).toBeUndefined()
    const r = running(); await domain.retakeBaseline(r)
    expect(r.baselineRetaking).toBe(false)
  })
})

describe('makeArtifactsDomain · 成果读取与批准', () => {
  it('artifact:返回名字/mime/大小/sha/base64;approve 后 touched;不存在 ⇒ not_found', () => {
    const { domain, task, store, stateDir, touched } = setup()
    saveArtifactSnapshot(store, task.id, { name: 'a.txt', mime: 'text/plain', bytes: Buffer.from('hi') }, stateDir)
    const id = store.artifacts(task.id)[0]!.id
    const a = domain.artifact(task.id, id)
    expect(a).toMatchObject({ name: 'a.txt', mime: 'text/plain', size: 2, contentBase64: Buffer.from('hi').toString('base64') })
    domain.approve(task.id, id, a.sha256)
    expect(touched).toHaveBeenCalledWith(task.id)
    expect(() => domain.artifact(task.id, 'nope')).toThrow('not_found')
  })
})
```

`store.events` / `store.approve` / `outputDirectory` 的形状以源文件为准;`retakeBaseline` 在非 git 目录上是 throw 还是返回 null 无所谓,断言只看 `baselineRetaking`。**不要改 store。**

- [ ] **Step 2: 跑,红**(`Cannot find module './artifacts'`)。
- [ ] **Step 3: 新建 `service/artifacts.ts`** —— 脚本抠两块逐字:A = `function collect(` 起到 `captureOutputs` 闭合 `}`;B = 「把当前基线以来的代码变更截成一份快照」那段注释的 `/**` 行起到 `retakeBaseline` 闭合 `}`;C = public 的 `artifact(` … `approve(` 两个方法。替换只有:`opts.stateDir`→`ctx.stateDir`、`touched(`→`ctx.hub.touched(`、`collections`→`state.collections`(域内 `const { store, state } = ctx`;`state.shutdownComplete` 已是 `state.` 形式)、`service.artifact(`→`artifact(`。import:`ArtifactSnapshotError, canonicalProject, collectArtifacts, readArtifactSnapshot, saveArtifactSnapshot` from `../artifacts`;`captureGitBaseline, finishGitReview, serializeGitReview, GIT_REVIEW_MIME` from `../git-review`;`directoryIdentity` from `./directory-identity`;`type Active` from `./state`;`type ServiceCtx` from `./ctx`。
- [ ] **Step 4: service.ts 接上** —— `const artifactsDomain=makeArtifactsDomain(ctx)` + `const {collect,collectTurnArtifacts,captureCodeChanges,retakeBaseline}=artifactsDomain` 放在 notices 解构之后;删 A/B/C;public 里 `artifact:artifactsDomain.artifact,` `approve:artifactsDomain.approve,`;`actions.set` 里 `artifact:(id,artifactId)=>service.artifact(id,artifactId)` 不动。删不再用的 import(`grep -c`:`ArtifactSnapshotError` `collectArtifacts` `saveArtifactSnapshot` `readArtifactSnapshot` `finishGitReview` `serializeGitReview` `GIT_REVIEW_MIME` 大概率只剩 import;`canonicalProject` `captureGitBaseline` `outputDirectory` 别处还用)。
- [ ] **Step 5: 验证** —— artifacts 单测 8 通过;typecheck 0;`bun --bun vitest run src/core/workbench/service scripts/workbench-service-ratchet.guard.test.ts` 27 文件全过(`service-turn-artifacts` / `service-report` / `service-review` 走完整链);depcheck `0 errors, 21 warnings`;逐字 diff 核对。
- [ ] **Step 6: Commit** —— `workbench service 拆分 15/n:artifacts 域搬进 service/artifacts.ts(成果收集/代码快照/基线重取 + artifact/approve,行为不变)`

---

### Task 3: 棘轮下调 + 全量闸门

- [ ] **Step 1**:量行数与内函数数(预期 ≈1500 行 / 47),改常量与注释「当前值 = PR 5 搬完 artifacts 域之后的实际值」。数字手抄。
- [ ] **Step 2**:全量 bun / node / typecheck / depcheck。Expected:bun 701 文件 / 9277 条(PR 4 后 699/9267 + 2 文件 10 条);node 全绿;0;`0 errors, 21 warnings`。
- [ ] **Step 3: Commit**(含本计划)—— `workbench service 拆分 16/n:棘轮下调到搬完 artifacts 域的实际值;附 PR 5 计划`

---

### Task 4: 推分支、PR、CI、合入后真机

同 PR 4 Task 4(`selftest workbench --image --resume` 的 `file_written`/成果那步走的正是 `collectTurnArtifacts`)。

---

## Self-Review

- **Spec 覆盖**:§3 第 5 项 artifacts ✓;§2 `service/artifacts.ts` ✓(`directory-identity.ts` 是搬家所需的共享帮手,spec 没列但 §2「域只认 ctx、不 import service」推出来的);§5 域单测 / 棘轮 / 真机 ✓;§4 不改行为 ✓。
- **占位符**:Task 2 Step 3 按行段抠、diff 核对。
- **类型一致**:`directoryIdentity` Task 1 产、Task 2 消费;四个解构名与 service.ts 调用点同名。
- **Review Focus** 归属:1→「collect 登记」;2→「三种失败去重」;3→「复用在途」;4→「baselineRetaking 复位」;5→Task 1 typecheck + 单测。
