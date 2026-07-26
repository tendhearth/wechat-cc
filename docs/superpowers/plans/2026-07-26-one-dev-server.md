# 一个 dev server(合并 dev-server + test-shim)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面 dev 只保留一个 server(以 `test-shim.ts` 为底,吸收 `dev-server.ts` 的 SSE 热重载),三个显式模式(tauri-dev / browser-live / mock),live 模式默认拒绝会改真实状态的 CLI 命令。

**Architecture:** 两个新的小模块承担新职责——`apps/desktop/dev-reload.ts`(热重载:SSE + 客户端脚本 + HTML 注入,从 dev-server.ts 提取)和 `apps/desktop/dev-guard.ts`(安全阀:纯函数判定命令是否会改真实状态)。test-shim.ts 只做接线(它已 1400+ 行,按仓库的 god-file 约定不再往里堆逻辑)。然后重指 `tauri.conf.json` / package.json / Playwright,删掉 dev-server.ts。

**Tech Stack:** Bun.serve、`node:fs` watch、SSE(ReadableStream)、vitest 单测、Playwright(既有 `playwright/dev-server.spec.ts` 转为合并后 server 的热重载验收)。

**Spec:** `docs/superpowers/specs/2026-07-26-one-dev-server-design.md`

## Global Constraints

- **shim 的 Tauri polyfill 必须保持 `window.__TAURI__ = window.__TAURI__ ?? {…}` 的守卫写法** —— 真 Tauri webview 里绝不能被覆盖(这是 `tauri dev` 能指向 shim 的前提)。
- **mock 模式行为零变化**:Playwright 全套在 mock 模式下与合并前同结果(该套件本就非必需红,以"合并前后同结果"为准,不追既有 flake)。
- 安全阀只拦 `/__invoke` 转发的 CLI 命令;**所有 daemon HTTP 路由不受影响**(记忆整理/画像走 daemon 路由,必须照常真跑)。
- 热重载客户端脚本必须以**外链** `/__dev_reload.js` 注入(CSP `script-src 'self'`,不能 inline)。
- 新模块要能单测(纯函数 / 注入式),不要求起服务器。
- **`bun run test`(vitest)不做类型检查** —— 每个动 .ts 的任务跑 `bunx tsc --noEmit`(仓库根)。
- 每任务 TDD:先测试跑 FAIL,再实现跑 PASS,commit。

---

### Task 1: dev-guard.ts —— 安全阀(纯函数)

**Files:**
- Create: `apps/desktop/dev-guard.ts`
- Test: `apps/desktop/dev-guard.test.ts`

**Interfaces:**
- Produces: `MUTATING_CLI_COMMANDS: ReadonlyArray<ReadonlyArray<string>>`(前缀列表);`isMutatingCli(args: string[]): boolean`;`guardCliInvoke(args: string[], opts: { dryRun: boolean; allowMutations: boolean }): { ok: true } | { ok: false; error: string; hint: string }`。Task 3 在 `runCli` 里消费。

- [ ] **Step 1: 写失败测试** —— `apps/desktop/dev-guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isMutatingCli, guardCliInvoke } from './dev-guard'

describe('isMutatingCli', () => {
  it('认出会改真实状态的命令(按子命令前缀)', () => {
    expect(isMutatingCli(['setup'])).toBe(true)
    expect(isMutatingCli(['setup-poll'])).toBe(true)
    expect(isMutatingCli(['service', 'install'])).toBe(true)
    expect(isMutatingCli(['daemon', 'kill'])).toBe(true)
    expect(isMutatingCli(['daemon', 'kill-residual'])).toBe(true)
    expect(isMutatingCli(['update'])).toBe(true)
  })

  it('读类命令不算(整理/画像走 daemon 路由,不经这里)', () => {
    expect(isMutatingCli(['memory', 'list', '--json'])).toBe(false)
    expect(isMutatingCli(['memory', 'read', 'u', 'p', '--json'])).toBe(false)
    expect(isMutatingCli(['doctor', '--json'])).toBe(false)
    expect(isMutatingCli(['sessions', 'list', '--json'])).toBe(false)
    expect(isMutatingCli(['daemon', 'api-info', '--json'])).toBe(false)  // daemon 但只读
    expect(isMutatingCli([])).toBe(false)
  })
})

describe('guardCliInvoke', () => {
  const live = { dryRun: false, allowMutations: false }

  it('live 模式拦危险命令,给结构化错误 + hint', () => {
    const r = guardCliInvoke(['service', 'install'], live)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('mutating_command_blocked_in_dev')
      expect(r.hint).toContain('--allow-mutations')
    }
  })

  it('live 模式放行读类命令', () => {
    expect(guardCliInvoke(['memory', 'list', '--json'], live).ok).toBe(true)
  })

  it('--allow-mutations 显式放行', () => {
    expect(guardCliInvoke(['setup'], { dryRun: false, allowMutations: true }).ok).toBe(true)
  })

  it('mock 模式不拦(本就不碰真实状态)', () => {
    expect(guardCliInvoke(['setup'], { dryRun: true, allowMutations: false }).ok).toBe(true)
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bunx vitest run apps/desktop/dev-guard.test.ts`,期望红(模块不存在)。

- [ ] **Step 3: 实现** —— `apps/desktop/dev-guard.ts`:

```ts
/**
 * dev-guard — the dev server's safety valve (spec 2026-07-26 §3).
 *
 * WHY: in live mode the dev server forwards `/__invoke` to a REAL
 * `bun cli.ts`. Some CLI commands mutate the operator's real machine —
 * `setup`/`setup-poll` write accounts + access.json, `service` hits
 * launchctl, `daemon kill*` stops the live bot, `update` moves the repo.
 * A same-day incident (memory: test-pollution-real-statedir) showed how
 * badly fixture-grade writes into real state end: the operator was removed
 * from access.json's allowFrom and their bot silently dropped their own
 * WeChat messages. So live mode refuses these by default.
 *
 * NOT gated: every read-ish CLI command, and ALL daemon HTTP routes (memory
 * synthesize / profile generate go through the daemon, never through here).
 */

/** Deny list as子命令前缀 — matched positionally against the CLI argv. */
export const MUTATING_CLI_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ['setup'],
  ['setup-poll'],
  ['service'],
  ['daemon', 'kill'],
  ['daemon', 'kill-residual'],
  ['update'],
]

/** True when argv starts with any deny-listed prefix. */
export function isMutatingCli(args: string[]): boolean {
  return MUTATING_CLI_COMMANDS.some(prefix => prefix.every((seg, i) => args[i] === seg))
}

export function guardCliInvoke(
  args: string[],
  opts: { dryRun: boolean; allowMutations: boolean },
): { ok: true } | { ok: false; error: string; hint: string } {
  // mock 模式不碰真实状态;显式开关放行。
  if (opts.dryRun || opts.allowMutations) return { ok: true }
  if (!isMutatingCli(args)) return { ok: true }
  return {
    ok: false,
    error: 'mutating_command_blocked_in_dev',
    hint: `dev server live 模式默认不跑会改真实状态的命令(${args.slice(0, 2).join(' ')})。需要时加 --allow-mutations 或 WECHAT_CC_DEV_ALLOW_MUTATIONS=1。`,
  }
}
```

- [ ] **Step 4: 跑 PASS** —— 同命令全绿;`bunx tsc --noEmit`(仓库根)无新错。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/dev-guard.ts apps/desktop/dev-guard.test.ts
git commit -m "feat(dev): dev-guard 安全阀 —— live 模式默认拒绝会改真实状态的 CLI 命令"
```

---

### Task 2: dev-reload.ts —— 热重载模块(从 dev-server 提取)

**Files:**
- Create: `apps/desktop/dev-reload.ts`
- Test: `apps/desktop/dev-reload.test.ts`

**Interfaces:**
- Produces: `RELOAD_SCRIPT_TAG: string`(= `<script src="/__dev_reload.js"></script>`);`injectReloadScript(html: string): string`;`makeLiveReload(opts: { root: string; log?: (line: string) => void }): { handle(pathname: string): Response | null; notify(filename: string | null): void; watch(): void; close(): void }`。Task 3 接线消费。

- [ ] **Step 1: 写失败测试** —— `apps/desktop/dev-reload.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RELOAD_SCRIPT_TAG, injectReloadScript, makeLiveReload } from './dev-reload'

describe('injectReloadScript', () => {
  it('注在最后一个 </body> 之前(字符串字面量里的 </body> 不算)', () => {
    const html = `<html><body><script>const s = "</body>";</script><p>x</p></body></html>`
    const out = injectReloadScript(html)
    expect(out).toContain(RELOAD_SCRIPT_TAG)
    expect(out.indexOf(RELOAD_SCRIPT_TAG)).toBeLessThan(out.lastIndexOf('</body>'))
  })

  it('没有 </body> 时追加到末尾', () => {
    const out = injectReloadScript('<p>no body tag</p>')
    expect(out.trimEnd().endsWith(RELOAD_SCRIPT_TAG)).toBe(true)
  })

  it('外链而非 inline(CSP script-src self)', () => {
    expect(RELOAD_SCRIPT_TAG).toBe('<script src="/__dev_reload.js"></script>')
    expect(injectReloadScript('<body></body>')).not.toContain('<script>(function')
  })
})

describe('makeLiveReload', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-reload-test-'))

  it('/__dev_reload.js 返回客户端脚本(js content-type)', async () => {
    const lr = makeLiveReload({ root })
    const res = lr.handle('/__dev_reload.js')!
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(await res.text()).toContain("EventSource('/__dev_reload')")
    lr.close()
  })

  it('/__dev_reload 返回 SSE 流', async () => {
    const lr = makeLiveReload({ root })
    const res = lr.handle('/__dev_reload')!
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    lr.close()
  })

  it('其他路径返回 null(交给宿主 server)', () => {
    const lr = makeLiveReload({ root })
    expect(lr.handle('/index.html')).toBeNull()
    lr.close()
  })

  it('notify 去抖后向已连接客户端广播 reload 事件', async () => {
    const lr = makeLiveReload({ root })
    const res = lr.handle('/__dev_reload')!
    const reader = res.body!.getReader()
    await reader.read()                     // ': connected'
    lr.notify('main.js'); lr.notify('main.js'); lr.notify('main.js')
    const chunk = await reader.read()
    const text = new TextDecoder().decode(chunk.value!)
    expect(text).toContain('event: reload')
    lr.close()
  })

  it('watch() 监视 root 下的变更并触发广播', async () => {
    const lr = makeLiveReload({ root })
    const res = lr.handle('/__dev_reload')!
    const reader = res.body!.getReader()
    await reader.read()
    lr.watch()
    writeFileSync(join(root, 'touched.js'), '// x')
    const chunk = await reader.read()
    expect(new TextDecoder().decode(chunk.value!)).toContain('event: reload')
    lr.close()
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bunx vitest run apps/desktop/dev-reload.test.ts`。

- [ ] **Step 3: 实现** —— `apps/desktop/dev-reload.ts`。把 `dev-server.ts` 的热重载三块**逐字搬过来**(客户端脚本、SSE 端点、watch+50ms 去抖),封装成注入式模块:

```ts
/**
 * dev-reload — SSE live reload for the desktop dev server.
 *
 * Lifted verbatim from the retired apps/desktop/dev-server.ts so the single
 * merged dev server (test-shim.ts) keeps the same behavior: watch src/,
 * coalesce burst saves in a 50ms window, push one `reload` event over SSE.
 * The client script is served as a same-origin .js file (NOT inline) so it
 * passes tauri's `script-src 'self'` CSP. See spec 2026-07-26 §1.
 */
import { watch, type FSWatcher } from 'node:fs'

const RELOAD_CLIENT_JS = `// dev live-reload client
(function () {
  let reconnectDelay = 250
  function connect() {
    const es = new EventSource('/__dev_reload')
    es.addEventListener('reload', () => {
      console.log('[dev] reload')
      location.reload()
    })
    es.onopen = () => { reconnectDelay = 250 }
    es.onerror = () => {
      es.close()
      // backoff so a server restart triggers exactly one reload when it
      // comes back up, not a tight loop.
      setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 3000)
    }
  }
  connect()
})()
`

export const RELOAD_SCRIPT_TAG = '<script src="/__dev_reload.js"></script>'

/** Inject before the LAST </body> (greedy lookahead so a </body> inside a
 *  string literal or comment doesn't grab it); append when absent. */
export function injectReloadScript(html: string): string {
  const bodyClose = /<\/body\s*>(?![\s\S]*<\/body\s*>)/i
  if (bodyClose.test(html)) return html.replace(bodyClose, (m) => `  ${RELOAD_SCRIPT_TAG}\n  ${m}`)
  return `${html}\n${RELOAD_SCRIPT_TAG}\n`
}

type Send = (msg: string) => void

export function makeLiveReload(opts: { root: string; log?: (line: string) => void }) {
  const log = opts.log ?? (() => {})
  const clients = new Set<Send>()
  let pending: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null

  function broadcast() {
    const payload = `event: reload\ndata: ${Date.now()}\n\n`
    for (const send of clients) {
      try { send(payload) } catch { clients.delete(send) }
    }
  }

  return {
    /** Handle the two reload endpoints; null = not ours. */
    handle(pathname: string): Response | null {
      if (pathname === '/__dev_reload.js') {
        return new Response(RELOAD_CLIENT_JS, {
          headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      if (pathname !== '/__dev_reload') return null
      let send!: Send
      const stream = new ReadableStream({
        start(controller) {
          send = (msg: string) => {
            try { controller.enqueue(new TextEncoder().encode(msg)) }
            catch { clients.delete(send) }
          }
          clients.add(send)
          send(': connected\n\n')   // keeps proxies from buffering the stream
        },
        cancel() { clients.delete(send) },
      })
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
        },
      })
    },

    /** Debounced (50ms) reload broadcast — editor saves fire in bursts. */
    notify(filename: string | null): void {
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = null
        if (filename) log(`reload (${filename})`)
        broadcast()
      }, 50)
    },

    watch(): void {
      if (watcher) return
      watcher = watch(opts.root, { recursive: true }, (_event, filename) => {
        if (!filename) return
        // Ignore editor swap files, etc.
        if (/(^|\/)\..+\.sw[a-z]$|~$/.test(String(filename))) return
        this.notify(String(filename))
      })
    },

    close(): void {
      if (pending) { clearTimeout(pending); pending = null }
      watcher?.close(); watcher = null
      clients.clear()
    },
  }
}
```

（`watch()` 里用 `this.notify` 需要对象方法上下文——返回的是对象字面量,`this` 指该对象,可用;若实现者偏好,可提到闭包里的具名 `notify` 函数再由两处引用,行为等价。)

- [ ] **Step 4: 跑 PASS** —— 同命令全绿;`bunx tsc --noEmit` 无新错。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/dev-reload.ts apps/desktop/dev-reload.test.ts
git commit -m "feat(dev): dev-reload 模块 —— 从 dev-server 提取 SSE 热重载(外链客户端脚本,50ms 去抖)"
```

---

### Task 3: 接线进 test-shim(三模式 + 安全阀 + 热重载)

**Files:**
- Modify: `apps/desktop/test-shim.ts`
- Modify: `apps/desktop/src/main.js`(横幅三态,`showDevBannerIfShim` at ~1227)
- Test: `apps/desktop/test-shim-wiring.test.ts`(新,纯断言源码接线,不起服务器)

**Interfaces:**
- Consumes: Task 1 `guardCliInvoke`;Task 2 `makeLiveReload` / `injectReloadScript`。
- Produces: shim 注入的三个 window 标记:`__WECHAT_CC_SHIM__`(已有)、`__WECHAT_CC_DRY_RUN__`(已有)、**新增 `__WECHAT_CC_ALLOW_MUTATIONS__`**;env `WECHAT_CC_DEV_ALLOW_MUTATIONS=1` / CLI 参数 `--allow-mutations`。

- [ ] **Step 1: 写失败测试** —— `apps/desktop/test-shim-wiring.test.ts`(接线守卫,和 `src/daemon/inbound/build.test.ts` 的源码顺序守卫同思路):

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const shim = readFileSync(join(import.meta.dirname, 'test-shim.ts'), 'utf8')
const mainJs = readFileSync(join(import.meta.dirname, 'src', 'main.js'), 'utf8')

describe('test-shim 接线', () => {
  it('runCli 经 guardCliInvoke 把关(安全阀在唯一的 CLI 出口)', () => {
    expect(shim).toContain("from './dev-guard'")
    const guardIdx = shim.indexOf('guardCliInvoke(')
    const spawnIdx = shim.indexOf("spawn(['bun'")
    expect(guardIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(spawnIdx)   // 拦在 spawn 之前
  })

  it('热重载已接:模块导入 + handle 分派 + index.html 注入 + watch 启动', () => {
    expect(shim).toContain("from './dev-reload'")
    expect(shim).toContain('makeLiveReload(')
    expect(shim).toContain('.handle(')
    expect(shim).toContain('injectReloadScript(')
    expect(shim).toContain('.watch()')
  })

  it('polyfill 仍守卫真 __TAURI__(tauri dev 指向本 server 的前提)', () => {
    expect(shim).toContain('window.__TAURI__ = window.__TAURI__ ??')
  })

  it('注入 allow-mutations 标记供横幅使用', () => {
    expect(shim).toContain('__WECHAT_CC_ALLOW_MUTATIONS__')
  })
})

describe('横幅三态', () => {
  it('main.js 横幅区分 mock / live / live+可改状态', () => {
    expect(mainJs).toContain('__WECHAT_CC_ALLOW_MUTATIONS__')
    expect(mainJs).toContain('演示模式')          // mock 态文案保留
    expect(mainJs).toContain('可改真实状态')       // allow-mutations 态新文案
  })
})
```

- [ ] **Step 2: 跑 FAIL** —— `bunx vitest run apps/desktop/test-shim-wiring.test.ts`。

- [ ] **Step 3: 实现**

3a. `test-shim.ts` 顶部 import + 模式常量(`dryRun` 常量已存在于 line ~35 附近):

```ts
import { guardCliInvoke } from './dev-guard'
import { makeLiveReload, injectReloadScript } from './dev-reload'
```
```ts
// live 模式默认不跑会改真实状态的 CLI 命令(spec 2026-07-26 §3)。
const allowMutations = process.env.WECHAT_CC_DEV_ALLOW_MUTATIONS === '1'
  || process.argv.includes('--allow-mutations')
```

3b. **安全阀**——改 `runCli`(line ~218,是所有真 CLI 转发的唯一出口,3 个调用点都经过它)。在 spawn 之前:

```ts
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const verdict = guardCliInvoke(args, { dryRun, allowMutations })
  if (!verdict.ok) {
    // 抛出去由 /__invoke 的 try/catch 变成 { error } 交给前端
    // (ipc.js 的 formatInvokeError 会原样展示这段人话)。
    throw new Error(`${verdict.error}: ${verdict.hint}`)
  }
  const proc = spawn(['bun', join(ROOT, 'cli.ts'), ...args], { /* 原样不动 */ })
  // …原实现不变
}
```

3c. **热重载**——`Bun.serve`(line ~250)之前建实例、之后启动 watch:

```ts
const liveReload = makeLiveReload({ root: SRC, log: (l) => console.error(`[dev] ${l}`) })
```
`fetch(req)` 开头(取到 `url` 之后)优先分派:
```ts
    const reloadRes = liveReload.handle(url.pathname)
    if (reloadRes) return reloadRes
```
`index.html` 服务块(line ~1377)在既有 CSP+polyfill 注入之后再注入 reload 脚本:
```ts
    if (path === '/index.html') {
      const html = await file.text()
      const polyfillTag = injectCsp ? POLYFILL_EXTERNAL : POLYFILL_INLINE
      const injection = `${CSP_META}\n${polyfillTag}\n</head>`
      return new Response(injectReloadScript(html.replace('</head>', injection)), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
```
`Bun.serve({…})` 之后:
```ts
liveReload.watch()
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { liveReload.close(); process.exit(0) })
}
```

3d. **polyfill 增标记**(POLYFILL_BODY 尾部,`__WECHAT_CC_DRY_RUN__` 那行旁):
```ts
window.__WECHAT_CC_ALLOW_MUTATIONS__ = ${allowMutations ? 'true' : 'false'}
```

3e. **启动横幅**(文件末尾 console.log 处)三态化,并把危险命令提示改成事实:
```ts
console.log(`shim: http://localhost:${PORT}  root=${ROOT}  mode=${dryRun ? 'mock' : 'live'}  mutations=${allowMutations ? 'ALLOWED' : 'blocked'}`)
if (!dryRun && allowMutations) {
  console.log('  ⚠️  --allow-mutations 已开:setup / service / daemon kill / update 会真实生效。')
}
```

3f. `src/main.js` 的 `showDevBannerIfShim`(~1227)三态:
```js
  const allowMut = w.__WECHAT_CC_ALLOW_MUTATIONS__
  banner.innerHTML = w.__WECHAT_CC_DRY_RUN__
    ? `<b>演示模式 (DRY_RUN)</b> · service install / stop / start 不会真实生效，但能演练交互流程`
    : allowMut
      ? `<b>开发模式 · 可改真实状态</b> · setup / service / daemon kill / update 会真实生效`
      : `<b>开发模式</b> · 操作走真实 CLI 与真实 daemon；会改真实状态的命令已拦下`
```

- [ ] **Step 4: 跑 PASS** —— `bunx vitest run apps/desktop/test-shim-wiring.test.ts apps/desktop/dev-guard.test.ts apps/desktop/dev-reload.test.ts` 全绿;`bunx tsc --noEmit` 无新错。**手动冒烟**:`cd apps/desktop && bun test-shim.ts` → 浏览器开 `http://localhost:4174/` 看到横幅"开发模式 · …已拦下";改一下 `src/styles.css` 存盘,页面应自动刷新。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/test-shim.ts apps/desktop/src/main.js apps/desktop/test-shim-wiring.test.ts
git commit -m "feat(dev): test-shim 接入热重载 + 安全阀 + 三模式横幅(合并 dev-server 的能力)"
```

---

### Task 4: 重指 tauri/scripts/Playwright + 删 dev-server

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`(`beforeDevCommand` / `devUrl`)
- Modify: `apps/desktop/package.json`(scripts)
- Modify: `apps/desktop/playwright/dev-server.spec.ts`(改为起合并后的 server)
- Delete: `apps/desktop/dev-server.ts`
- Test: 既有 `apps/desktop/playwright/dev-server.spec.ts`(转为合并 server 的热重载验收)

**Interfaces:**
- Consumes: Task 3 接线后的 `test-shim.ts`(env `WECHAT_CC_SHIM_PORT` 定端口,`WECHAT_CC_DRY_RUN=1` 进 mock 模式)。

- [ ] **Step 1: package.json scripts** —— 删 `dev-server` / `preview`,`shim`/`shim:live` 收敛为显式三入口(`tauri` / `build` / `build-sidecar` / `test:e2e:browser` 保持不动):

> **计划缺陷更正(实施时发现)**:下面这段把浏览器入口命名为 `dev`,但 `dev` 早已存在且等于 `tauri dev`(启动桌面应用)。照抄会①删掉唯一启动应用的入口,②与 Step 2 的 `beforeDevCommand: "bun run dev"` 构成无限递归。实际实现改为四入口:`dev` 保持 `tauri dev`,浏览器入口叫 `dev:web`,`beforeDevCommand` 指向 `bun run dev:web`。

```json
    "dev": "tauri dev",
    "dev:web": "bun test-shim.ts",
    "dev:mock": "WECHAT_CC_DRY_RUN=1 bun test-shim.ts",
    "dev:unsafe": "WECHAT_CC_DEV_ALLOW_MUTATIONS=1 bun test-shim.ts",
```
（`shim` / `shim:live` 别名删除;CI 的 desktop-e2e 由 spec fixture 自己 spawn,不依赖这些 script 名——见 ci.yml 注释"The spec fixture spawns its own DRY_RUN test-shim"。)

- [ ] **Step 2: tauri.conf.json** —— `beforeDevCommand` 与 `devUrl` 指向合并后的 server(端口与 shim 默认一致 4174):

```json
  "build": {
    "frontendDist": "../src",
    "beforeDevCommand": "bun run dev:web",
    "beforeBuildCommand": "bun run build-sidecar",
    "devUrl": "http://127.0.0.1:4174"
  },
```

- [ ] **Step 3: 改 `playwright/dev-server.spec.ts` 起合并后的 server** —— 它现在 `spawn('bun', ['dev-server.ts'], { env: { PORT } })`(line ~48)。改为:

```ts
      proc = spawn('bun', ['test-shim.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, WECHAT_CC_SHIM_PORT: String(PORT), WECHAT_CC_DRY_RUN: '1' },
        stdio: 'pipe',
        shell: process.platform === 'win32',
      })
```
并把 spec 顶部注释与 describe 名从 `dev-server` 改为合并后的 server(断言本身不动——它测的正是 `<script src="/__dev_reload.js">` 注入位置与 SSE,合并后行为相同)。同时把日志前缀 `[dev-server]` 改为 `[dev]`。

（注意 `PORT` 常量是 4175,与默认 4174 不冲突,保持不变。）

- [ ] **Step 4: 删除 dev-server.ts** —— `git rm apps/desktop/dev-server.ts`;`grep -rn "dev-server" apps/desktop --include="*.ts" --include="*.json" --include="*.js" | grep -v playwright/dev-server.spec` 应只剩注释/历史引用,逐个清掉或改写。

- [ ] **Step 5: 验证** —— `bunx vitest run apps/desktop/` 全绿;`bunx tsc --noEmit` 无新错;`cd apps/desktop && bun x playwright test playwright/dev-server.spec.ts` 绿(热重载验收在合并后的 server 上通过)。

- [ ] **Step 6: Commit**

```bash
git add -A apps/desktop
git commit -m "refactor(dev): 收敛为一个 dev server —— tauri/scripts/playwright 重指 test-shim,删 dev-server.ts"
```

---

### Task 5: 全量回归 + Playwright mock 平价验收

**Files:** 无代码改动(验证)。

- [ ] **Step 1: 全量** —— 仓库根 `bun run test` 全绿 + `bunx tsc --noEmit` 零错。
- [ ] **Step 2: Playwright 平价** —— `cd apps/desktop && bun x playwright test` 跑全套,与合并前**同结果**(该套件既有 flake 不追;逐条对比通过/失败清单,新增失败即回归)。若本机缺 chromium,`bun x playwright install chromium` 后再跑。
- [ ] **Step 3: 三模式手动冒烟**(每个一句话确认)——
  - `bun run dev` → 浏览器 4174:横幅"已拦下";记忆页显示真实"1 个用户 · N 文件";点「重新整理」真跑(走 daemon 路由,不受安全阀影响)。
  - `bun run dev:mock` → 横幅"演示模式";记忆页是 mock 数据。
  - `bun run dev:unsafe` → 横幅"可改真实状态"。
- [ ] **Step 4: grep 守卫** —— `grep -rn "dev-server.ts" apps/desktop` 零命中(除本计划/spec 文档);`grep -n "guardCliInvoke" apps/desktop/test-shim.ts` 命中一次。
- [ ] **Step 5: Commit(仅当上述步骤需要微调时)**

---

## Self-Review 结论(已跑)

- **Spec 覆盖**:§1 收敛(热重载搬迁=T2,重指+删除=T4);§2 三模式(标记+横幅=T3,scripts=T4);§3 安全阀(=T1+T3);§4 daemon 直连(不做代理——无任务,属"保持现状",T5 冒烟确认整理按钮仍真跑);§5 错误处理(T1 结构化错误 + T3 横幅/启动日志);§6 测试(各任务单测 + T5 平价与全量)。无缺口。
- **占位符**:无;每个代码步骤都给了可粘贴的实现。
- **一致性**:`guardCliInvoke(args, {dryRun, allowMutations})` 在 T1 定义、T3 调用签名一致;`makeLiveReload({root, log})` / `handle` / `notify` / `watch` / `close` 与 T3 接线用法一致;`__WECHAT_CC_ALLOW_MUTATIONS__` 在 T3 的 shim 注入与 main.js 消费两处同名;端口约定统一为 4174(tauri devUrl 与 shim 默认一致),Playwright 自用 4175 不冲突。
