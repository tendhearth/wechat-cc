# Tendhearth 配对体验 Implementation Plan(plan 7a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 电脑上点「连接手机」出一个只能用一次的码,系统相机一扫就打开 Tendhearth app 的确认卡;中继没开通时诚实说明;重装 / 换机后 app 先核对再说话;重新配对时退掉旧设备位。

**Architecture:** daemon 侧把链接令牌改成「换到设备令牌即作废」,新增 admin 路由 `POST /v1/phone/link` / `GET /v1/phone/devices`(按需打开远程隧道、只在 v2 中继就绪时出码),照 plan 6 的四处白名单让桌面经原生宿主调用。桌面一个可注入时钟的流程模块同时驱动设置抽屉的弹层与引导页最后一步。中继 Worker 发 AASA / assetlinks;app 用配置插件声明关联域名与 App Links,系统链接先进一格暂存再到配对页确认卡;启动核验与旧位清理都是纯函数 + 薄接线。

**Tech Stack:** TypeScript、Bun + vitest(根目录 bun / node 两遍)、Cloudflare Workers(`@cloudflare/vitest-plugin`)、vanilla JS + CSS(Tauri 2 webview)、Rust(Tauri 宿主白名单)、Playwright(desktop-e2e,端口 4176)、Expo SDK 57 / Expo Router / React Native 0.86 / expo-linking、Maestro。

**Spec:** `docs/superpowers/specs/2026-10-01-tendhearth-pairing-ux-design.md`(下称 spec)。控制者裁决与 spec §2 的补充决定 D1–D8 都有约束力。

## Global Constraints

- 工作树 `/Users/nategu_mac_company/Documents/tendhearth/wechat-cc/.claude/worktrees/deploy-dev`,分支 `pairing-ux`(基于 `origin/dev` c2f35af4),PR 进 `dev`(squash)。不切分支、不碰兄弟工作树、不用裸 `git stash`、不暂存 `.superpowers/`。提交信息用中文,末尾空一行加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- **绝不提交机密**:`.p8`、`google-services.json`、任何 `ANDROID_CERT_SHA256` 的真实值、任何令牌。`git add` 只加本任务列出的文件。
- **单次配对**:链接令牌被第一次成功的 `POST /set/api/pair` 消耗(`tokens.invalidateSession('link')`);第二次 ⇒ `401 { error: 'unauthorized' }`(app 映射成 `PairError('expired')`);重发码作废旧码;`device_limit` 不消耗;非链接令牌配对 ⇒ `403 { ok: false, error: 'link_only' }`。
- **链接永远先到确认卡**:任何系统链接 / 粘贴 / 扫码只能把配对页推到 `confirm`,永不自动调用 `pairWithLink`。令牌不进路由参数、不进日志。
- **不碰 `relay_v2_url`**:代码只读它;打开远程隧道只写 `remote_tunnel: true`。
- **设计原则**:只留功能、全衬线(沿用 plan 6 的 token)、一个强调色、无深色模式、CC 是唯一插画(弹层 / 引导块里不加 CC、不加图标、不加阴影);样式只用 `var(--th-*)`,不写字面色值;`font-weight` 只许 400 / 500;状态色只上点。
- **文案 zh + en**:手机进 `apps/app/src/i18n/{zh-Hans,en}.ts`(键一致);桌面进 `apps/desktop/src/modules/phone-connect-copy.js` 的 `{ zh, en }`(键一致,界面渲染 zh)。中文全角标点(,。?:()),引号「」;英文弯引号 “” 与 ’。文案以 spec §9 表为准,一字不改。
- **桌面新路由四处登记**:`route-tiers.ts`(admin)→ `token-registry.ts` operator `routeAllow` → `apps/desktop/workbench-proxy.ts` `ROUTES` → `apps/desktop/src-tauri/src/lib.rs` `workbench_request_allowed`(+ 其单测两张表)。渲染进程只经 `invokeWorkbenchApi`。
- **id / testID 不改名**:`#open-phone-settings`、`#phone-settings-modal`、`#settings-open`、`#enter-dashboard`、`#screen-service`,以及手机现有 testID。新增的 id 见各任务。
- 根目录测试会 import 的手机文件(`apps/app/src/net/*.ts`、`apps/app/src/view/*.ts`、`apps/app/src/state/wiring.ts`、`apps/app/src/push/open.ts`)必须纯 TS:不 import `react` / `react-native` / `expo-*`。
- 回路(看退出码,别 grep 输出):
  - 根:`bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck`
  - 手机:`cd apps/app && bun run test && bun run typecheck && bun run export:check`
  - 桌面单测:`bun --bun vitest run apps/desktop`(根目录)
  - 桌面 e2e:`cd apps/desktop && bun x playwright test`(先 `lsof -i :4176` 确认端口空)
  - 中继:`cd apps/relay && bun run typecheck && bun run test`
  - Rust:`cd apps/desktop/src-tauri && cargo test`

## Review Focus

- **两台手机几乎同时扫同一个码**:只有一台配上,另一台得到「用过或过期」。Task 2 的并发配对用例钉住(两次 `handleRequest` 同时发)。
- **daemon 正在重启时桌面请求失败**:打开隧道后 `POST /v1/phone/link` 连不上是预期的,弹层继续显示「正在打开手机连接」而不是报错;45 秒还没好才说「还没打开」。Task 5 的 `makePhoneLinkFlow` 用例(starting 之后抛错 ⇒ 继续等 ⇒ ready)钉住。
- **设备名是用户内容**:`label` 里带 `<img src=x onerror=…>` 时弹层与引导块只显示文字。Task 5 的 happy-dom 用例钉住(渲染后没有 `img` 元素)。
- **恢复回来的配对遇到电脑不在线**:不清配对、不回欢迎页(分不清是关机还是失效),只有「连上之前就被拒」或「这台 id 对不上」才清。Task 10 的 `watchConnection` / `watchLaunch` 用例(offline 不触发、读设备失败 ⇒ unknown 不触发)钉住。
- **配对进行中又来一个系统链接**:正在 `working` 时不替换当前流程(不打断、不重开确认卡)。Task 9 的 `acceptsIncomingLink` 用例钉住。

---

### Task 1: 锚点探针 —— 通用链接的 `#…` 能不能活到 JS(源码证据 + 结论写回 spec)

**Files:**
- Create: `apps/app/plugins/link-fragment.guard.test.ts`
- Modify: `docs/superpowers/specs/2026-10-01-tendhearth-pairing-ux-design.md`(§6.3 的结论表)

**Interfaces:**
- Consumes: 无。
- Produces: 结论表(spec §6.3)。不论结论如何,Task 9 都同时实现主路径(`redirectSystemPath` 的 `path` 带锚点)与兜底(`Linking.getLinkingURL()` 再试一次;都没锚点 ⇒ `pair.errLinkIncomplete`,用 app 内扫码)。本任务只决定结论表里写「源码证据:保留」还是「源码证据:丢失」。

- [ ] **Step 1: 写守卫测试** `apps/app/plugins/link-fragment.guard.test.ts`

```ts
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import base from '../app.json'

// 锚点探针(spec 2026-10-01-tendhearth-pairing-ux §6.3):配对码的令牌在 # 锚点里,中继看不到。
// 系统相机扫码 → 通用链接 / App Link → app 时,锚点能不能活到 JS 的 redirectSystemPath,取决于下面这些别人的实现。
// 升级依赖时这里先红;红了先去真机 / 模拟器验(Task 9 的 Maestro、Task 12 的真机),再改这里。
const require = createRequire(import.meta.url)
const pkgDir = (name: string) => dirname(require.resolve(`${name}/package.json`))
const read = (...p: string[]) => readFileSync(join(...p), 'utf8')

describe('expo-router 把系统交来的原样 URL 交给 +native-intent 的 redirectSystemPath', () => {
  const router = pkgDir('expo-router')
  it('冷启动:getInitialURL 的结果(不改写)进 redirectSystemPath', () => {
    const src = read(router, 'build', 'getLinkingConfig.js')
    expect(src).toContain('nativeLinking.redirectSystemPath({ path: initialUrl, initial: true })')
    expect(src).toContain('return nativeLinking.redirectSystemPath({ path: url, initial: true })')
  })
  it('热启动:url 事件的原样字符串(只过 applyRedirects)进 redirectSystemPath', () => {
    const src = read(router, 'build', 'link', 'linking.js')
    expect(src).toContain('let href = (0, getRoutesRedirects_1.applyRedirects)(url, redirects);')
    expect(src).toContain('href = await nativeLinking.redirectSystemPath({ path: href, initial: false });')
  })
  it('没有重定向表时 applyRedirects 原样返回;我们的 app.json 没配 redirects', () => {
    expect(read(router, 'build', 'getRoutesRedirects.js')).toMatch(/if \(typeof url !== 'string' \|\| !redirects\) \{\s*return url;/)
    expect(base.expo.plugins).toContain('expo-router')   // 字符串形式 = 无选项 = 无 redirects
  })
})

describe('iOS:通用链接的 webpageURL 以 absoluteString(含锚点)交给 JS', () => {
  it('场景委托把冷启动的 userActivities 与热启动的 continue 转给 AppDelegate 订阅者', () => {
    const src = read(pkgDir('expo'), 'ios', 'AppDelegates', 'ExpoAppSceneDelegate.swift')
    expect(src).toContain('connectionOptions.userActivities.forEach { forwarder.continue($0) }')
    expect(src).toContain('open func scene(_ scene: UIScene, continue userActivity: NSUserActivity)')
  })
  it('expo-linking 记下 webpageURL,给 JS 的是 absoluteString', () => {
    const dir = join(pkgDir('expo-linking'), 'ios')
    expect(read(dir, 'LinkingAppDelegateSubscriber.swift')).toContain('userActivity.webpageURL')
    const mod = read(dir, 'ExpoLinkingModule.swift')
    expect(mod).toContain('ExpoLinkingRegistry.shared.initialURL?.absoluteString')
    expect(mod).toContain('["url": url.absoluteString]')
  })
})

describe('安卓:App Link 的 intent data 以 uri.toString()(含锚点)交给 JS', () => {
  const rn = join(pkgDir('react-native'), 'ReactAndroid', 'src', 'main', 'java', 'com', 'facebook', 'react', 'modules')
  it('冷启动 getInitialURL', () => {
    expect(read(rn, 'intent', 'IntentModule.kt')).toContain('uri.toString()')
  })
  it('热启动 url 事件', () => {
    expect(read(rn, 'core', 'DeviceEventManagerModule.kt')).toContain('put("url", uri.toString())')
  })
})
```

- [ ] **Step 2: 跑**

Run: `cd apps/app && bun x vitest run plugins/link-fragment.guard.test.ts`
Expected: PASS(7 个用例)。如果某条 FAIL:先读那个文件当前的写法,判断锚点是否仍被保留 —— 仍保留 ⇒ 把断言改成当前写法并在用例名里注明版本;**确实丢失** ⇒ 断言改成钉住「丢失」的写法,Step 3 的结论表写「丢失」。

- [ ] **Step 3: 把结论写回 spec §6.3 的表**

把三行「(Task 1 填…)」替换为(全部 PASS 时):

```markdown
| expo-router → `redirectSystemPath` 拿到原样 URL | 保留(源码,expo-router 57.0.24) | `plugins/link-fragment.guard.test.ts` |
| iOS 通用链接 → JS 保留锚点 | 保留(源码:场景委托转发 + `webpageURL.absoluteString`);真机见 Task 12 | 同上 |
| 安卓 App Link → JS 保留锚点 | 保留(源码:`uri.toString()` 冷 / 热两路);真机见 Task 12 | 同上 |
```

某行为「丢失」时写「丢失(源码:<文件>)⇒ 靠兜底:`pair.errLinkIncomplete` + app 内扫码」。

- [ ] **Step 4: 手机回路**

Run: `cd apps/app && bun run test && bun run typecheck`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/app/plugins/link-fragment.guard.test.ts docs/superpowers/specs/2026-10-01-tendhearth-pairing-ux-design.md
git commit -m "配对体验 Task 1:锚点探针 —— 通用链接 / App Link 的 # 锚点活到 JS 的源码证据链与守卫

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 单次配对(daemon)+ 网页壳与 `/m` 的诚实性修补

**Files:**
- Modify: `src/daemon/settings-panel.ts`(`/set/api/pair` 分支,约 641–645 行)
- Create: `src/daemon/settings-panel-pair-once.test.ts`
- Modify: `src/daemon/settings-panel.test.ts`(推送路由的 `up()`)、`src/daemon/phone-api-schema.test.ts`(两处配对之后)、`src/daemon/settings-panel-workbench.test.ts`(两处配对之后)
- Modify: `apps/mobile/src/transport.js`、`apps/mobile/src/nav.js`、`apps/mobile/src/home.js`
- Modify: `apps/mobile/pairing.test.ts`
- Modify: `relay/pset.src.html`(失效文案)、`apps/mobile/pset-shell.test.ts`;生成物 `relay/pset.html`(`bun run build:mobile` 写出)

**Interfaces:**
- Consumes: `tokens.invalidateSession(sessionKey)`、`devices.pair()`(已有)。
- Produces:
  - `POST /set/api/pair`:链接令牌 ⇒ 成功后令牌作废;非链接令牌 ⇒ `403 { ok: false, error: 'link_only' }`。
  - 网页全局函数(`apps/mobile/src/transport.js`):`resetTunnel(): void`、`onUnauthorized(sentAs: string): void`。

- [ ] **Step 1: 写失败的 daemon 测试** `src/daemon/settings-panel-pair-once.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSettingsPanel, type SettingsPanel } from './settings-panel'

// 单次配对(spec 2026-10-01-tendhearth-pairing-ux §3、D1、D2)。
const OWNER = 'owner_chat@im.wechat'
let dir: string
let panel: SettingsPanel

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pair-once-'))
  mkdirSync(join(dir, 'memory', OWNER), { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
  panel = makeSettingsPanel({
    stateDir: dir, ownerChatId: () => OWNER,
    chatPrefs: { get: () => ({}), set: (_c, p) => p },
    getUserName: () => '大人', setUserName: async () => {}, log: () => {},
  })
})
afterEach(async () => { await panel.stop(); rmSync(dir, { recursive: true, force: true }) })

const post = (q: string) => panel.handleRequest(new Request(`http://127.0.0.1/set/api/pair?${q}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))

describe('一个码只能配一台(裁决 1)', () => {
  it('第一次成功;同一个码第二次 ⇒ 401 unauthorized;隧道也不再认它', async () => {
    const link = panel.issueToken()
    const first = await post(`t=${link}`)
    expect(first.status).toBe(200)
    const body = await first.json() as { ok: boolean; device_token: string }
    expect(body.ok).toBe(true)
    expect(panel.validToken(body.device_token)).toBe(true)
    expect(panel.validToken(link)).toBe(false)
    expect(panel.activeLinkToken()).toBeNull()
    const second = await post(`t=${link}`)
    expect(second.status).toBe(401)
    expect(await second.json()).toEqual({ error: 'unauthorized' })
  })
  it('重发码作废旧码(不变)', async () => {
    const old = panel.issueToken()
    const fresh = panel.issueToken()
    expect((await post(`t=${old}`)).status).toBe(401)
    expect((await post(`t=${fresh}`)).status).toBe(200)
  })
  it('设备满了 ⇒ device_limit,码不消耗', async () => {
    for (let i = 0; i < 20; i++) expect((await post(`t=${panel.issueToken()}`)).status).toBe(200)
    const link = panel.issueToken()
    expect(await (await post(`t=${link}`)).json()).toEqual({ ok: false, error: 'device_limit' })
    expect(panel.validToken(link)).toBe(true)
  })
  it('设备令牌不能再铸设备令牌 ⇒ 403 link_only(D1)', async () => {
    const dev = (await (await post(`t=${panel.issueToken()}`)).json() as { device_token: string }).device_token
    const r = await post(`d=${dev}`)
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ ok: false, error: 'link_only' })
  })
  it('两台手机几乎同时用同一个码:恰好一台配上(Review Focus 1)', async () => {
    const link = panel.issueToken()
    const [a, b] = await Promise.all([post(`t=${link}`), post(`t=${link}`)])
    expect([a.status, b.status].sort()).toEqual([200, 401])
    expect(panel.deviceTokens()).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/settings-panel-pair-once.test.ts`
Expected: FAIL(第一个用例里 `panel.validToken(link)` 仍是 `true`;`link_only` 用例拿到 200)

- [ ] **Step 3: 实现** —— `src/daemon/settings-panel.ts` 里把 `/set/api/pair` 分支整段换成:

```ts
          if (url.pathname === '/set/api/pair' && req.method === 'POST') {
            // 单次配对(spec 2026-10-01-tendhearth-pairing-ux §3):只有链接令牌能换设备令牌(D1),
            // 换成功立刻作废这枚链接令牌 —— 一个码只配一台;设备满了不消耗。
            if (caller.origin !== 'link') return json({ ok: false, error: 'link_only' }, 403)
            const paired = devices.pair()
            if (!paired) return json({ ok: false, error: 'device_limit' })
            tokens.invalidateSession('link')
            deps.log('SETTINGS', `phone device paired (id ${paired.id}); link token consumed`)
            return json({ ok: true, device_token: paired.token })
          }
```

- [ ] **Step 4: 跑,确认通过**

Run: `bun --bun vitest run src/daemon/settings-panel-pair-once.test.ts`
Expected: PASS(5 个用例)

- [ ] **Step 5: 修「配对后还拿旧码请求」的现有测试**

`src/daemon/settings-panel.test.ts` 推送路由的 `up()`,把 `return { link, token: r.device_token, id, call }` 换成:

```ts
      // 链接令牌一次性(plan 7a):配对后给一枚新码,「链接令牌不许登记」那条要的是一枚还活着的链接令牌。
      return { link: p.issueToken(), token: r.device_token, id, call }
```

`src/daemon/phone-api-schema.test.ts` 两处 `const paired = await (await post('/set/api/pair', {})).json()…` 的下一行各加:

```ts
    token = panel.issueToken()   // 链接令牌一次性(plan 7a):配对后用新码继续
```

`src/daemon/settings-panel-workbench.test.ts` 两处 `…await request('/set/api/pair',{})…` 的下一行各加:

```ts
    token=panel.issueToken() // 链接令牌一次性(plan 7a)
```

Run: `bun run test`
Expected: 全绿。若还有别的测试在配对之后拿同一枚链接令牌请求而得到 401,照同一个办法(配对后 `issueToken()` 换新码,或改用返回的设备令牌)修,不要放宽 daemon。

- [ ] **Step 6: 写网页的失败测试** —— `apps/mobile/pairing.test.ts`:`runNav` 的 `env` 里加 `resetTunnel: vi.fn(),`,第一个用例末尾加 `expect(env.resetTunnel).toHaveBeenCalledTimes(1)`;文件末尾追加:

```ts
describe('配对换令牌之后的 401(plan 7a 单次配对)', () => {
  function runTransport(T0: string) {
    const store = new Map<string, string>([['deviceToken', 'dNEW']])
    const env = {
      WebSocket: class {}, crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob,
      T: T0, REMOTE: null, q: (p: string) => p, window: {}, fetch: vi.fn(),
      localStorage: { removeItem: (k: string) => { store.delete(k) } },
      location: { replace: vi.fn() },
    }
    const api = new Function(...Object.keys(env), `${readMobileSource('transport.js')}\nreturn { onUnauthorized, resetTunnel }`)(...Object.values(env)) as
      { onUnauthorized(sentAs: string): void; resetTunnel(): void }
    return { api, env, store }
  }
  it('发请求时的令牌就是现在的令牌 ⇒ 本机令牌失效:清掉、回 /m', () => {
    const { api, env, store } = runTransport('dNEW')
    api.onUnauthorized('dNEW')
    expect(store.has('deviceToken')).toBe(false)
    expect(env.location.replace).toHaveBeenCalledWith('/m')
  })
  it('刚配对换了令牌,在飞的旧短令牌请求回 401 ⇒ 什么都不动', () => {
    const { api, env, store } = runTransport('dNEW')
    api.onUnauthorized('tLINK')
    expect(store.get('deviceToken')).toBe('dNEW')
    expect(env.location.replace).not.toHaveBeenCalled()
  })
  it('没有隧道时 resetTunnel 不抛', () => {
    expect(() => runTransport('dNEW').api.resetTunnel()).not.toThrow()
  })
  it('home.js 的 401 一律走 onUnauthorized,不再直接删令牌', () => {
    const src = readMobileSource('home.js')
    expect(src).not.toContain('localStorage.removeItem("deviceToken")')
    expect(src.match(/onUnauthorized\(sent\)/g)?.length).toBe(2)
  })
})
```

`apps/mobile/pset-shell.test.ts` 里把期望文案 `'链接过期啦,回微信跟 CC 再要一个'` 改成 `'这个链接已经用过或过期了，回微信跟 CC 再要一个'`。

- [ ] **Step 7: 跑,确认失败**

Run: `bun --bun vitest run apps/mobile/pairing.test.ts apps/mobile/pset-shell.test.ts`
Expected: FAIL(`resetTunnel` / `onUnauthorized` 未定义;pset 文案不符)

- [ ] **Step 8: 实现网页**

`apps/mobile/src/transport.js`:在 `var tun = null` 下一行加 `var tunWs = null`;`tunnel()` 里 `var ws = new WebSocket(…)` 的下一行加 `tunWs = ws`;在 `function api(` 之前加:

```js
// 配对换了令牌(nav.js)之后,绑着旧短令牌的隧道作废:关掉,下一次 api() 用新令牌重新握手(plan 7a)。
function resetTunnel() {
  var w = tunWs
  tunWs = null; tun = null
  if (w) { try { w.close() } catch (e) {} }
}
// 401:只有「发请求时用的令牌」就是现在这枚,才说明本机令牌失效;刚配对换令牌时在飞的旧请求回 401 不算(plan 7a)。
/** @param {string} sentAs */
function onUnauthorized(sentAs) {
  if (sentAs !== T) return
  try { localStorage.removeItem("deviceToken") } catch (e) {}
  location.replace("/m")
}
```

`apps/mobile/src/nav.js`:成功分支里 `T = r.device_token; isDevice = true` 的下一行加 `resetTunnel()`。

`apps/mobile/src/home.js`:`loadHome()` 与 `load()` 两处,把 `api("/m/api/…").then(function(r) {` 前加 `var sent = T`,并把
`if (r.status === 401) { try { localStorage.removeItem("deviceToken") } catch (e) {}; location.replace("/m"); return null }`
换成
`if (r.status === 401) { onUnauthorized(sent); return null }`。

`relay/pset.src.html`:两处 `"链接过期啦,回微信跟 CC 再要一个"` 换成 `"这个链接已经用过或过期了，回微信跟 CC 再要一个"`。然后:

Run: `bun run build:mobile`
Expected: 写出 `relay/pset.html`(`git status` 里能看到它变了)

- [ ] **Step 9: 跑**

Run: `bun --bun vitest run apps/mobile && bun run typecheck`
Expected: PASS;typecheck 退出码 0(`tsc -p apps/mobile` 认得新全局函数,因为同一批脚本一起检查)

- [ ] **Step 10: 根回路**

Run: `bun run test && npm run test:node && bun run depcheck`
Expected: 全绿

- [ ] **Step 11: Commit**

```bash
git add src/daemon/settings-panel.ts src/daemon/settings-panel-pair-once.test.ts src/daemon/settings-panel.test.ts src/daemon/phone-api-schema.test.ts src/daemon/settings-panel-workbench.test.ts apps/mobile/src/transport.js apps/mobile/src/nav.js apps/mobile/src/home.js apps/mobile/pairing.test.ts apps/mobile/pset-shell.test.ts relay/pset.src.html relay/pset.html
git commit -m "配对体验 Task 2:一个码只配一台(配上即作废、设备令牌不能再铸);网页配对后换隧道、旧请求的 401 不误删令牌

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: daemon「连接手机」接口 —— `phoneLinkState`、`POST /v1/phone/link`、`GET /v1/phone/devices`

**Files:**
- Create: `src/daemon/phone-link.ts`、`src/daemon/phone-link.test.ts`
- Create: `src/daemon/settings-panel-phone-link.test.ts`
- Create: `src/daemon/internal-api/routes-phone.ts`、`src/daemon/internal-api/routes-phone.test.ts`
- Modify: `src/daemon/settings-panel.ts`(deps `relayV2Configured`;方法 `phoneLink` / `phoneDevices`;`linkUrl` 改用 `psetUrl`)
- Modify: `src/daemon/internal-api/types.ts`、`src/daemon/internal-api/index.ts`、`src/daemon/internal-api/lifecycle.ts`、`src/daemon/internal-api/routes.ts`、`src/daemon/internal-api/route-tiers.ts`
- Modify: `src/daemon/wiring/pipeline-deps.ts`、`src/daemon/wiring/index.ts`、`src/daemon/main.ts`

**Interfaces:**
- Consumes: `RELAY_ID_RE`(`@wechat-cc/protocol`)、`SETTINGS_LINK_TTL_MS`、`lanIp()`、`deps.remote`、`deps.remoteInfo`、`DeviceRow`(`./device-store`)。
- Produces:
  - `src/daemon/phone-link.ts`:
    - `export type PhoneLinkState = 'ready' | 'starting' | 'remote_off' | 'relay_not_configured' | 'relay_unavailable' | 'no_owner'`
    - `export type PhoneLinkResult = { ok: true; state: 'ready'; url: string; expires_at: number } | { ok: false; state: Exclude<PhoneLinkState, 'ready'> }`
    - `export interface PhoneLinkInputs { owner: boolean; v2Configured: boolean; tunnelOn: boolean; bootRemoteId: string | null }`
    - `export function phoneLinkState(i: PhoneLinkInputs): PhoneLinkState`
    - `export function psetUrl(remote: { relay: string; id: string }, token: string, lan: string | null): string`
  - `SettingsPanelDeps.relayV2Configured?: () => boolean`
  - `SettingsPanel.phoneLink(opts: { enableRemote: boolean }): Promise<PhoneLinkResult>`、`SettingsPanel.phoneDevices(): DeviceRow[]`
  - `src/daemon/internal-api/types.ts`:`export interface PhoneConnectDep { link(opts: { enableRemote: boolean }): Promise<import('../phone-link').PhoneLinkResult>; devices(): import('../device-store').DeviceRow[] }`;`InternalApiDeps.phoneConnect?: PhoneConnectDep`;`InternalApi.setPhoneConnect(p: PhoneConnectDep): void`
  - 路由(admin):`POST /v1/phone/link` 正文 `{ enable_remote?: boolean }` ⇒ `200 PhoneLinkResult`;`GET /v1/phone/devices` ⇒ `200 { ok: true, devices: DeviceRow[] }`
  - `BuildPipelineDepsResult.phoneConnect: PhoneConnectDep`、`WiredDeps.phoneConnect: PhoneConnectDep`

- [ ] **Step 1: 写纯函数的失败测试** `src/daemon/phone-link.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { phoneLinkState, psetUrl } from './phone-link'

const RID = 'r' + 'a'.repeat(26)
const LEGACY = 't' + '0'.repeat(36)
const base = { owner: true, v2Configured: true, tunnelOn: true, bootRemoteId: RID }

describe('phoneLinkState(spec §4.1 的表,按顺序判)', () => {
  it.each([
    [{ ...base, owner: false, v2Configured: false }, 'no_owner'],
    [{ ...base, v2Configured: false, tunnelOn: false }, 'relay_not_configured'],
    [{ ...base, tunnelOn: false, bootRemoteId: null }, 'remote_off'],
    [{ ...base, bootRemoteId: null }, 'starting'],
    [{ ...base, bootRemoteId: LEGACY }, 'relay_unavailable'],
    [base, 'ready'],
  ] as const)('%o ⇒ %s', (i, want) => {
    expect(phoneLinkState(i)).toBe(want)
  })
})

describe('psetUrl:与原 linkUrl 同形', () => {
  it('v2 中继、带局域网地址', () => {
    expect(psetUrl({ relay: 'wss://relay.tendhearth.com/v2/phone', id: RID }, 't' + 'f'.repeat(32), '192.168.1.5:51234'))
      .toBe(`https://relay.tendhearth.com/pset/#id=${RID}&t=t${'f'.repeat(32)}&p=%2Fset&lan=192.168.1.5:51234`)
  })
  it('没有局域网地址就不带 lan=', () => {
    expect(psetUrl({ relay: 'wss://relay-staging.tendhearth.com/v2/phone', id: RID }, 'tx', null))
      .toBe(`https://relay-staging.tendhearth.com/pset/#id=${RID}&t=tx&p=%2Fset`)
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/phone-link.test.ts`
Expected: FAIL(`Cannot find module './phone-link'`)

- [ ] **Step 3: 实现** `src/daemon/phone-link.ts`

```ts
/**
 * 桌面「连接手机」的状态判定与链接拼法(spec 2026-10-01-tendhearth-pairing-ux §4.1)。纯函数,无 IO。
 * 只读 relay_v2_url 是否配置(主人事项,这里从不写它)。
 */
import { RELAY_ID_RE } from '@wechat-cc/protocol'

export type PhoneLinkState = 'ready' | 'starting' | 'remote_off' | 'relay_not_configured' | 'relay_unavailable' | 'no_owner'
export type PhoneLinkResult =
  | { ok: true; state: 'ready'; url: string; expires_at: number }
  | { ok: false; state: Exclude<PhoneLinkState, 'ready'> }

export interface PhoneLinkInputs {
  /** 绑了微信主人没有。 */
  owner: boolean
  /** agent-config.json 的 relay_v2_url 非空(现在的配置,不是开机时的)。 */
  v2Configured: boolean
  /** agent-config.json 的 remote_tunnel === true(现在的配置)。 */
  tunnelOn: boolean
  /** 这次启动实际连上的远程隧道 id(开机时定的);没开隧道 ⇒ null。 */
  bootRemoteId: string | null
}

export function phoneLinkState(i: PhoneLinkInputs): PhoneLinkState {
  if (!i.owner) return 'no_owner'
  if (!i.v2Configured) return 'relay_not_configured'
  if (!i.tunnelOn) return 'remote_off'
  if (i.bootRemoteId === null) return 'starting'
  if (!RELAY_ID_RE.test(i.bootRemoteId)) return 'relay_unavailable'
  return 'ready'
}

/** 中继上的公网壳页链接;令牌在 # 锚点里(锚点不上服务器,中继看不到)。 */
export function psetUrl(remote: { relay: string; id: string }, token: string, lan: string | null): string {
  const base = remote.relay.replace(/^wss:/, 'https:').replace(/\/(tunnel|v2)\/phone$/, '')
  return `${base}/pset/#id=${encodeURIComponent(remote.id)}&t=${token}&p=${encodeURIComponent('/set')}${lan ? `&lan=${lan}` : ''}`
}
```

- [ ] **Step 4: 跑,确认通过**

Run: `bun --bun vitest run src/daemon/phone-link.test.ts`
Expected: PASS(8 个用例)

- [ ] **Step 5: 写面板方法的失败测试** `src/daemon/settings-panel-phone-link.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSettingsPanel, SETTINGS_LINK_TTL_MS, type SettingsPanel } from './settings-panel'

const OWNER = 'owner_chat@im.wechat'
const RID = 'r' + 'a'.repeat(26)
const V2 = { relay: 'wss://relay.tendhearth.com/v2/phone', id: RID }
let dir: string
const panels: SettingsPanel[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phone-link-'))
  mkdirSync(join(dir, 'memory', OWNER), { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ provider: 'claude', relay_v2_url: 'wss://relay.tendhearth.com' }))
})
afterEach(async () => { for (const p of panels.splice(0)) await p.stop(); rmSync(dir, { recursive: true, force: true }) })

function mk(o: { v2?: boolean; tunnel?: boolean; remote?: { relay: string; id: string } | null; owner?: string | null; wired?: boolean } = {}) {
  const calls = { enabled: [] as boolean[], restarts: 0, audit: [] as string[] }
  let tunnel = o.tunnel ?? false
  const panel = makeSettingsPanel({
    stateDir: dir, ownerChatId: () => (o.owner === undefined ? OWNER : o.owner),
    chatPrefs: { get: () => ({}), set: (_c, p) => p },
    getUserName: () => '大人', setUserName: async () => {}, log: () => {}, now: () => 1_000_000,
    audit: s => { calls.audit.push(s) },
    relayV2Configured: () => o.v2 ?? true,
    ...(o.remote ? { remoteInfo: () => o.remote! } : {}),
    ...(o.wired === false ? {} : { remote: { isEnabled: () => tunnel, setEnabled: (on: boolean) => { tunnel = on; calls.enabled.push(on) }, requestRestart: () => { calls.restarts++ } } }),
  })
  panels.push(panel)
  return { panel, calls }
}

describe('settingsPanel.phoneLink(spec §4.1)', () => {
  it('中继没开通 ⇒ relay_not_configured;不开隧道、不铸码', async () => {
    const { panel, calls } = mk({ v2: false })
    expect(await panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'relay_not_configured' })
    expect(calls.enabled).toEqual([])
    expect(panel.activeLinkToken()).toBeNull()
  })
  it('隧道关着 + enableRemote ⇒ 打开、审计、重启,回 starting;agent-config 一个字节都没被面板改', async () => {
    const before = readFileSync(join(dir, 'agent-config.json'), 'utf8')
    const { panel, calls } = mk({ tunnel: false })
    expect(await panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'starting' })
    expect(calls.enabled).toEqual([true])
    expect(calls.restarts).toBe(1)
    expect(calls.audit.some(a => a.includes('连接手机'))).toBe(true)
    expect(readFileSync(join(dir, 'agent-config.json'), 'utf8')).toBe(before)
    expect(panel.activeLinkToken()).toBeNull()
  })
  it('隧道关着、不许打开 ⇒ remote_off;没接 remote 时同样', async () => {
    expect(await mk({ tunnel: false }).panel.phoneLink({ enableRemote: false })).toEqual({ ok: false, state: 'remote_off' })
    expect(await mk({ wired: false }).panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'remote_off' })
  })
  it('配置已开、这次启动还没隧道 ⇒ starting;隧道是老中继 id ⇒ relay_unavailable', async () => {
    expect(await mk({ tunnel: true }).panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'starting' })
    expect(await mk({ tunnel: true, remote: { relay: 'wss://cc.tendhearth.com/tunnel/phone', id: 't' + '0'.repeat(36) } }).panel.phoneLink({ enableRemote: true }))
      .toEqual({ ok: false, state: 'relay_unavailable' })
  })
  it('没主人 ⇒ no_owner', async () => {
    expect(await mk({ owner: null, tunnel: true, remote: V2 }).panel.phoneLink({ enableRemote: true })).toEqual({ ok: false, state: 'no_owner' })
  })
  it('ready ⇒ 铸一枚链接令牌,链接指向 v2 壳页,10 分钟后过期', async () => {
    const { panel } = mk({ tunnel: true, remote: V2 })
    const r = await panel.phoneLink({ enableRemote: true })
    if (!r.ok) throw new Error(`expected ready, got ${r.state}`)
    expect(r.url).toMatch(new RegExp(`^https://relay\\.tendhearth\\.com/pset/#id=${RID}&t=t[0-9a-f]{32}&p=%2Fset(&lan=[^&]+)?$`))
    expect(r.expires_at).toBe(1_000_000 + SETTINGS_LINK_TTL_MS)
    expect(r.url).toContain(`t=${panel.activeLinkToken()}`)
  })
  it('phoneDevices:配对后列出,不带令牌', async () => {
    const { panel } = mk({ tunnel: true, remote: V2 })
    await panel.handleRequest(new Request(`http://127.0.0.1/set/api/pair?t=${panel.issueToken()}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))
    const list = panel.phoneDevices()
    expect(list).toHaveLength(1)
    expect(Object.keys(list[0]!).sort()).toEqual(['created_at', 'id', 'last_seen_at'])
  })
})
```

- [ ] **Step 6: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/settings-panel-phone-link.test.ts`
Expected: FAIL(`panel.phoneLink is not a function`;typecheck 也会报 `relayV2Configured` 不在 deps 里)

- [ ] **Step 7: 实现面板**

`src/daemon/settings-panel.ts`:
- `SettingsPanelDeps` 里 `remoteInfo?` 之后加:

```ts
  /** agent-config.json 的 relay_v2_url 现在非空吗(桌面「连接手机」用;只读,主人事项)。缺省 ⇒ 当没开通。 */
  relayV2Configured?: () => boolean
```

- `SettingsPanel` 接口里 `linkUrl()` 之后加:

```ts
  /** 桌面「连接手机」(spec 2026-10-01-tendhearth-pairing-ux §4.1):按需打开远程隧道;只在 v2 中继就绪时铸码。 */
  phoneLink(opts: { enableRemote: boolean }): Promise<PhoneLinkResult>
  /** 已配对设备(不含令牌),桌面轮询「已连上」用。 */
  phoneDevices(): DeviceRow[]
```

- 文件里 `import { LAN_ONLY_OPS, … } from './phone-routes'` 下一行加 `import { phoneLinkState, psetUrl, type PhoneLinkResult } from './phone-link'`。
- `linkUrl()` 里远程分支的两行(`const base = …` 与 `return \`${base}/pset/#…\``)换成 `return psetUrl(remote, token, \`${ip}:${port}\`)`。
- 在 `panel` 对象里 `linkUrl` 之后加:

```ts
    async phoneLink(opts) {
      const remote = deps.remoteInfo?.() ?? null
      const state = phoneLinkState({
        owner: !!deps.ownerChatId(),
        v2Configured: deps.relayV2Configured?.() ?? false,
        tunnelOn: deps.remote?.isEnabled() ?? false,
        bootRemoteId: remote?.id ?? null,
      })
      if (state === 'remote_off' && opts.enableRemote && deps.remote) {
        // 桌面就是主人自己的电脑(裁决 4):点「连接手机」= 打开远程隧道。只写 remote_tunnel,不碰 relay_v2_url。
        deps.remote.setEnabled(true)
        deps.audit?.('remote_tunnel: → true — 桌面「连接手机」')
        deps.remote.requestRestart()
        return { ok: false, state: 'starting' }
      }
      if (state !== 'ready' || !remote) return { ok: false, state: state === 'ready' ? 'starting' : state }
      const token = panel.issueToken()
      const ip = lanIp()
      const lan = ip ? `${ip}:${(await panel.start()).port}` : null
      return { ok: true, state: 'ready', url: psetUrl(remote, token, lan), expires_at: now() + SETTINGS_LINK_TTL_MS }
    },

    phoneDevices() {
      return devices.list()
    },
```

Run: `bun --bun vitest run src/daemon/settings-panel-phone-link.test.ts src/daemon/settings-panel.test.ts`
Expected: PASS

- [ ] **Step 8: 写路由的失败测试** `src/daemon/internal-api/routes-phone.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest'
import { phoneRoutes } from './routes-phone'
import { minTierFor } from './route-tiers'
import type { InternalApiDeps } from './types'

const q = new URLSearchParams()
const DEV = { id: 'aa11bb22', created_at: '2026-10-01T00:00:00.000Z', last_seen_at: '2026-10-01T00:00:00.000Z', label: 'Tendhearth · iPhone' }

describe('POST /v1/phone/link · GET /v1/phone/devices(spec §4.1)', () => {
  it('两条都是 admin', () => {
    expect(minTierFor('POST /v1/phone/link')).toBe('admin')
    expect(minTierFor('GET /v1/phone/devices')).toBe('admin')
  })
  it('link:enable_remote 透传(缺省 false);类型不对 400;没接 503;抛 503', async () => {
    const link = vi.fn(async () => ({ ok: false as const, state: 'starting' as const }))
    const r = phoneRoutes({ phoneConnect: { link, devices: () => [] } } as unknown as InternalApiDeps)
    expect(await r['POST /v1/phone/link']!(q, { enable_remote: true })).toEqual({ status: 200, body: { ok: false, state: 'starting' } })
    expect(link).toHaveBeenLastCalledWith({ enableRemote: true })
    await r['POST /v1/phone/link']!(q, undefined)
    expect(link).toHaveBeenLastCalledWith({ enableRemote: false })
    expect((await r['POST /v1/phone/link']!(q, { enable_remote: 'yes' })).status).toBe(400)
    expect((await phoneRoutes({} as InternalApiDeps)['POST /v1/phone/link']!(q, {})).status).toBe(503)
    const boom = phoneRoutes({ phoneConnect: { link: async () => { throw new Error('x') }, devices: () => [] } } as unknown as InternalApiDeps)
    expect(await boom['POST /v1/phone/link']!(q, {})).toEqual({ status: 503, body: { error: 'unavailable' } })
  })
  it('devices:列表原样;没接 503', async () => {
    const r = phoneRoutes({ phoneConnect: { link: vi.fn(), devices: () => [DEV] } } as unknown as InternalApiDeps)
    expect(await r['GET /v1/phone/devices']!(q, undefined)).toEqual({ status: 200, body: { ok: true, devices: [DEV] } })
    expect((await phoneRoutes({} as InternalApiDeps)['GET /v1/phone/devices']!(q, undefined)).status).toBe(503)
  })
})
```

- [ ] **Step 9: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/internal-api/routes-phone.test.ts`
Expected: FAIL(`Cannot find module './routes-phone'`)

- [ ] **Step 10: 实现路由与接线**

`src/daemon/internal-api/routes-phone.ts`:

```ts
import type { InternalApiDeps, RouteTable } from './types'

/**
 * 桌面「连接手机」(spec 2026-10-01-tendhearth-pairing-ux §4.1)。admin 档:桌面经原生宿主的 operator 凭据调用,
 * 渲染进程拿不到令牌。出码会铸 admin 档的链接令牌,所以绝不能降到 trusted(普通聊天会话也是 trusted)。
 */
export function phoneRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'POST /v1/phone/link': async (_q, body) => {
      if (!deps.phoneConnect) return { status: 503, body: { error: 'phone_not_wired' } }
      const b = (body ?? {}) as { enable_remote?: unknown }
      if (b.enable_remote !== undefined && typeof b.enable_remote !== 'boolean') return { status: 400, body: { error: 'invalid_request' } }
      try { return { status: 200, body: await deps.phoneConnect.link({ enableRemote: b.enable_remote === true }) } }
      catch { return { status: 503, body: { error: 'unavailable' } } }
    },
    'GET /v1/phone/devices': async () => {
      if (!deps.phoneConnect) return { status: 503, body: { error: 'phone_not_wired' } }
      try { return { status: 200, body: { ok: true, devices: deps.phoneConnect.devices() } } }
      catch { return { status: 503, body: { error: 'unavailable' } } }
    },
  }
}
```

`src/daemon/internal-api/route-tiers.ts`:在 `'GET /v1/connections': 'admin',` 下一行加:

```ts
  // 桌面「连接手机」(plan 7a):铸 admin 链接令牌 / 打开远程隧道,只给 operator 凭据。
  'POST /v1/phone/link': 'admin',
  'GET /v1/phone/devices': 'admin',
```

`src/daemon/internal-api/types.ts`:在 `connections?: …` 那一项之后加:

```ts
  /** 桌面「连接手机」(plan 7a);main.ts 在 pipeline 接好后 setPhoneConnect。 */
  phoneConnect?: PhoneConnectDep
```

并在文件里(`InternalApiDeps` 之前)加:

```ts
export interface PhoneConnectDep {
  link(opts: { enableRemote: boolean }): Promise<import('../phone-link').PhoneLinkResult>
  devices(): import('../device-store').DeviceRow[]
}
```

在 `InternalApi` 接口 `setConnections(…)` 下一行加 `setPhoneConnect(p: PhoneConnectDep): void`。

`src/daemon/internal-api/index.ts`:`setConnections(fn) { deps.connections = fn },` 下一行加 `setPhoneConnect(p) { deps.phoneConnect = p },`。

`src/daemon/internal-api/lifecycle.ts`:接口里 `setConnections(…)` 下一行加 `setPhoneConnect(p: NonNullable<InternalApiDeps['phoneConnect']>): void`;映射对象里 `setConnections: (fn) => api.setConnections(fn),` 下一行加 `setPhoneConnect: (p) => api.setPhoneConnect(p),`。

`src/daemon/internal-api/routes.ts`:`import { connectionsRoutes } from './routes-connections'` 下一行加 `import { phoneRoutes } from './routes-phone'`;`...connectionsRoutes(deps),` 下一行加 `...phoneRoutes(deps),`。

`src/daemon/wiring/pipeline-deps.ts`:
- `BuildPipelineDepsResult` 里 `connections: …` 之后加 `/** 桌面「连接手机」(plan 7a)。 */ phoneConnect: import('../internal-api/types').PhoneConnectDep`。
- `makeSettingsPanel({` 的参数里(`stateDir,` 附近)加:

```ts
    relayV2Configured: () => {
      const v = (loadAgentConfig(stateDir) as { relay_v2_url?: unknown }).relay_v2_url
      return typeof v === 'string' && v.trim() !== ''
    },
```

- 文件末尾的 `return { pipelineDeps, …, connections }` 改成在 `connections` 后加 `, phoneConnect: { link: (o) => settingsPanel.phoneLink(o), devices: () => settingsPanel.phoneDevices() }`。

`src/daemon/wiring/index.ts`:`WiredDeps` 里 `connections: …` 下一行加 `/** 桌面「连接手机」;main.ts setPhoneConnect 到 internal-api。 */ phoneConnect: import('../internal-api/types').PhoneConnectDep`;解构 `const { …, connections } = buildPipelineDeps(…)` 加上 `phoneConnect`,返回对象 `connections,` 下一行加 `phoneConnect,`。

`src/daemon/main.ts`:`internalApi.setConnections(wired.connections)` 下一行加 `internalApi.setPhoneConnect(wired.phoneConnect)`。

- [ ] **Step 11: 跑**

Run: `bun --bun vitest run src/daemon/internal-api/routes-phone.test.ts src/daemon/phone-link.test.ts src/daemon/settings-panel-phone-link.test.ts && bun run typecheck`
Expected: PASS;typecheck 退出码 0

- [ ] **Step 12: 根回路**

Run: `bun run test && npm run test:node && bun run depcheck`
Expected: 全绿(`scripts/route-registry.guard.test.ts` 也绿 —— 只加了 tier,白名单下一任务加)

- [ ] **Step 13: Commit**

```bash
git add src/daemon/phone-link.ts src/daemon/phone-link.test.ts src/daemon/settings-panel.ts src/daemon/settings-panel-phone-link.test.ts src/daemon/internal-api/routes-phone.ts src/daemon/internal-api/routes-phone.test.ts src/daemon/internal-api/types.ts src/daemon/internal-api/index.ts src/daemon/internal-api/lifecycle.ts src/daemon/internal-api/routes.ts src/daemon/internal-api/route-tiers.ts src/daemon/wiring/pipeline-deps.ts src/daemon/wiring/index.ts src/daemon/main.ts
git commit -m "配对体验 Task 3:daemon「连接手机」接口 —— 按需打开远程隧道、只在 v2 中继就绪时出码、设备列表(admin)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 桌面可达 —— 四处白名单 + dev 代理 + test-shim 演示路由

**Files:**
- Modify: `src/daemon/internal-api/token-registry.ts`、`src/daemon/internal-api/token-registry.test.ts`
- Modify: `apps/desktop/workbench-proxy.ts`
- Modify: `apps/desktop/src-tauri/src/lib.rs`(`workbench_request_allowed` + 测试 `allows_only_the_exact_workbench_method_route_pairs` 的两张表)
- Modify: `apps/desktop/test-shim.ts`
- Test: `scripts/route-registry.guard.test.ts`(不改,应当继续绿)

**Interfaces:**
- Consumes: Task 3 的两条路由。
- Produces:
  - operator 令牌可调 `POST /v1/phone/link`、`GET /v1/phone/devices`;打包版宿主与 dev 代理都放行这两条(别的方法一律拒)。
  - test-shim:`demo.seed { phone?: { link?: unknown[]; devices?: unknown[][] } }`(依次回,最后一项一直回;没 seed ⇒ ready 码 + 空列表);命令 `mock.phone-calls` ⇒ `{ result: { calls: unknown[] } }`(记 `POST /v1/phone/link` 的请求正文)。

- [ ] **Step 1: 写失败的测试**

`src/daemon/internal-api/token-registry.test.ts`:「resolves an operator token as admin…」那个精确集合里,`'GET /v1/connections',` 下一行加:

```ts
      'POST /v1/phone/link',
      'GET /v1/phone/devices',
```

`apps/desktop/src-tauri/src/lib.rs` 测试 `allows_only_the_exact_workbench_method_route_pairs`:放行表里 `("GET", "/v1/connections"),` 下一行加 `("POST", "/v1/phone/link"), ("GET", "/v1/phone/devices"),`;拒绝表里 `("POST", "/v1/connections"),` 下一行加 `("GET", "/v1/phone/link"), ("POST", "/v1/phone/devices"), ("POST", "/v1/phone/link/extra"), ("GET", "/v1/phone/../connections"),`。

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/internal-api/token-registry.test.ts && (cd apps/desktop/src-tauri && cargo test allows_only_the_exact_workbench_method_route_pairs)`
Expected: vitest FAIL(集合不等);cargo FAIL(`expected POST /v1/phone/link to be allowed`)

- [ ] **Step 3: 实现**

`src/daemon/internal-api/token-registry.ts` operator `routeAllow`:`'GET /v1/connections',` 下一行加:

```ts
          // 桌面「连接手机」(plan 7a):设置抽屉弹层与引导页的码、轮询「已连上」。
          'POST /v1/phone/link',
          'GET /v1/phone/devices',
```

`apps/desktop/src-tauri/src/lib.rs` `workbench_request_allowed` 的 `matches!` 里 `| ("GET", "/v1/connections")` 下一行加:

```rust
            // 「连接手机」(plan 7a):出码(必要时打开远程隧道)与轮询已配对设备。
            | ("POST", "/v1/phone/link")
            | ("GET", "/v1/phone/devices")
```

`apps/desktop/workbench-proxy.ts`:`ROUTES` 里 `'GET /v1/connections',` 下一行加 `'POST /v1/phone/link','GET /v1/phone/devices',`;把

```ts
    const connections=url.pathname==='/v1/connections'
    if(!connections&&url.pathname!=='/v1/workbench'&&!url.pathname.startsWith('/v1/workbench/'))return null
    if(connections&&opts.dryRun)return null
```

换成

```ts
    // /v1/connections(此刻的连接浮层)与 /v1/phone/*(连接手机)也走这里;mock 模式下交给 test-shim 的演示路由
    const ownerSurface=url.pathname==='/v1/connections'||url.pathname.startsWith('/v1/phone/')
    if(!ownerSurface&&url.pathname!=='/v1/workbench'&&!url.pathname.startsWith('/v1/workbench/'))return null
    if(ownerSurface&&opts.dryRun)return null
```

`apps/desktop/test-shim.ts`:
- `__mockState` 的类型里 `connections?: unknown` 之后加:

```ts
  // 「连接手机」(plan 7a):POST /v1/phone/link 依次回 phone.link 的项、GET /v1/phone/devices 依次回 phone.devices 的项
  // (都是最后一项一直回);没 seed ⇒ ready 码 + 空列表。phoneCalls 记 link 的请求正文(mock.phone-calls 读)。
  phone?: { link?: unknown[]; devices?: unknown[][] }
  phoneCalls: unknown[]
```

- `__mockState` 初始值对象里加 `phoneCalls: []`。
- `demo.seed` 的 `args` 类型里加 `phone?: { link?: unknown[]; devices?: unknown[][] }`,并在 `__mockState.connections = …` 下一行加:

```ts
          __mockState.phone = args?.phone ? { link: [...(args.phone.link ?? [])], devices: [...(args.phone.devices ?? [])] } : undefined
          __mockState.phoneCalls = []
```

- 在 `mock.doctor` 命令之后加:

```ts
        if (body.command === 'mock.phone-calls') {
          return Response.json({ result: { calls: __mockState.phoneCalls } })
        }
```

- 在 dry-run 的 `/v1/connections` 路由之前加:

```ts
    if (dryRun && url.pathname === '/v1/phone/link' && req.method === 'POST') {
      let body: unknown = {}
      try { body = await req.json() } catch { body = {} }
      __mockState.phoneCalls.push(body)
      const q = __mockState.phone?.link
      if (q && q.length > 0) return Response.json(q.length > 1 ? q.shift() : q[0])
      return Response.json({ ok: true, state: 'ready', url: `https://relay.tendhearth.com/pset/#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`, expires_at: Date.now() + 600_000 })
    }
    if (dryRun && url.pathname === '/v1/phone/devices' && req.method === 'GET') {
      const q = __mockState.phone?.devices
      if (q && q.length > 0) return Response.json({ ok: true, devices: q.length > 1 ? q.shift() : q[0] })
      return Response.json({ ok: true, devices: [] })
    }
```

- [ ] **Step 4: 跑**

Run: `bun --bun vitest run src/daemon/internal-api/token-registry.test.ts scripts/route-registry.guard.test.ts && (cd apps/desktop/src-tauri && cargo test)`
Expected: PASS(守卫:lib.rs ⊆ proxy ⊆ routeAllow ⊆ ROUTE_MIN_TIER 仍成立)

- [ ] **Step 5: 回路**

Run: `bun run test && bun run typecheck && cd apps/desktop && bun x playwright test && cd -`
Expected: 全绿(桌面还没调用新路由,e2e 不受影响)

- [ ] **Step 6: Commit**

```bash
git add src/daemon/internal-api/token-registry.ts src/daemon/internal-api/token-registry.test.ts apps/desktop/workbench-proxy.ts apps/desktop/src-tauri/src/lib.rs apps/desktop/test-shim.ts
git commit -m "配对体验 Task 4:「连接手机」两条路由登记进 operator / dev 代理 / 打包宿主白名单,test-shim 加演示路由

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 桌面「连接手机」弹层(改名 + 出码 + 诚实状态 + 已连上)

**Files:**
- Create: `apps/desktop/src/modules/phone-connect-copy.js`
- Create: `apps/desktop/src/modules/phone-connect.js`
- Create: `apps/desktop/src/modules/phone-connect.test.ts`
- Create: `apps/desktop/playwright/phone-connect.spec.ts`
- Modify: `apps/desktop/src/index.html:297`(按钮)
- Modify: `apps/desktop/src/main.js:678-703`(换成挂载器)
- Modify: `apps/desktop/src/modules/atelier-gallery.js:31`(画室空状态文案)及其测试 `apps/desktop/src/modules/atelier-gallery.test.js`(若断言了旧文案)
- Modify: `apps/desktop/src/styles.css`(`.phone-settings-btn`、`#phone-settings-modal` 一段)

**Interfaces:**
- Consumes: `invokeWorkbenchApi(method, path, body?)`(`./api.js`);Tauri 命令 `render_qr_svg { text } → string`;Task 4 的 test-shim `demo.seed { phone }` / `mock.phone-calls`。
- Produces(`apps/desktop/src/modules/phone-connect.js`):
  - `linkView(r: LinkResult): View`
  - `newDevice(before: Set<string>, now: Device[]): Device | null`
  - `pairedLine(d: Device): string`
  - `makePhoneLinkFlow(deps: { call: Call; onView(v: View): void; now?(): number; sleep?(ms: number): Promise<void>; pollMs?: number; startTimeoutMs?: number; labelWaits?: number }): { start(): Promise<void>; stop(): void }`
  - `mountPhoneConnect(deps: { call: Call; renderQr(text: string): Promise<string>; writeClipboard?(text: string): Promise<void>; flowDeps?: object; doc?: Document }): { open(): void; close(): void }`
  - 类型:`View = { kind: 'loading' } | { kind: 'qr'; url: string; expiresAt: number } | { kind: 'starting' } | { kind: 'notice'; title: string; body: string } | { kind: 'expired' } | { kind: 'paired'; line: string } | { kind: 'error'; text: string }`
  - `phone-connect-copy.js`:`PHONE_COPY: { zh: Record<string,string>; en: Record<string,string> }`、`phoneCopy = PHONE_COPY.zh`
  - DOM id:`#phone-connect-title`、`#phone-connect-body`、`#phone-connect-qr`、`#phone-connect-note`、`#phone-connect-copy`、`#phone-connect-starting`、`#phone-connect-notice`、`#phone-connect-expired`、`#phone-connect-renew`、`#phone-connect-paired`、`#phone-connect-error`、`#phone-connect-close`

- [ ] **Step 1: 写文案模块** `apps/desktop/src/modules/phone-connect-copy.js`(文案即 spec §9,一字不改)

```js
// @ts-check
// 「连接手机」的文案(spec 2026-10-01-tendhearth-pairing-ux §9、D6):zh / en 两份键一致;桌面今天只渲染 zh。
export const PHONE_COPY = {
  zh: {
    button: '连接手机',
    buttonTitle: '用手机扫码连上这台电脑（码 10 分钟内有效，只能用一次）',
    title: '连接手机',
    loading: '正在准备二维码……',
    readyNote: '用手机相机扫一下。10 分钟内有效，只能用一次。',
    readySub: '没装 Tendhearth 的手机会打开网页版设置。',
    copyLink: '复制链接',
    copied: '已复制',
    starting: '正在打开手机连接，CC 会重启一下。',
    startTimeout: '手机连接还没打开。稍后再点一次「连接手机」。',
    relayNotConfiguredTitle: '手机连接服务还没开通',
    relayNotConfiguredBody: '开通之后，这里会出现二维码。',
    relayUnavailableTitle: '手机连接服务这次没启动起来',
    relayUnavailableBody: '重启一下 CC 再试。',
    remoteOffTitle: '手机连接没打开',
    remoteOffBody: '重启一下 CC 再试。',
    noOwnerTitle: '先用微信扫码登录，再来连接手机。',
    expired: '这个码过期了。',
    renew: '换一个',
    paired: '已连上 {label}',
    pairedNoLabel: '已连上手机',
    done: '完成',
    error: '生成不了二维码：{why}',
    close: '关闭',
    later: '之后再连也可以：在设置里点「连接手机」。',
  },
  en: {
    button: 'Connect phone',
    buttonTitle: 'Scan with your phone to connect it to this computer (each code works once, for 10 minutes)',
    title: 'Connect phone',
    loading: 'Preparing a code…',
    readyNote: 'Scan it with your phone’s camera. It works once, for 10 minutes.',
    readySub: 'Phones without Tendhearth open the web settings instead.',
    copyLink: 'Copy link',
    copied: 'Copied',
    starting: 'Turning on phone connections. CC will restart for a moment.',
    startTimeout: 'Phone connections aren’t on yet. Try “Connect phone” again in a moment.',
    relayNotConfiguredTitle: 'The phone connection service isn’t open yet',
    relayNotConfiguredBody: 'Once it’s open, a code will appear here.',
    relayUnavailableTitle: 'The phone connection service didn’t start this time',
    relayUnavailableBody: 'Restart CC and try again.',
    remoteOffTitle: 'Phone connections are off',
    remoteOffBody: 'Restart CC and try again.',
    noOwnerTitle: 'Sign in with WeChat first, then connect your phone.',
    expired: 'This code has expired.',
    renew: 'New code',
    paired: 'Connected: {label}',
    pairedNoLabel: 'Phone connected',
    done: 'Done',
    error: 'Couldn’t make a code: {why}',
    close: 'Close',
    later: 'You can do this later: in Settings, choose “Connect phone”.',
  },
}
export const phoneCopy = PHONE_COPY.zh
```

- [ ] **Step 2: 写失败的单测** `apps/desktop/src/modules/phone-connect.test.ts`

```ts
// @vitest-environment happy-dom
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import { PHONE_COPY } from './phone-connect-copy.js'
import { linkView, makePhoneLinkFlow, mountPhoneConnect, newDevice, pairedLine } from './phone-connect.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const URL1 = `https://relay.tendhearth.com/pset/#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`
const dev = (id: string, label?: string, at = '2026-10-01T10:00:00.000Z') => ({ id, created_at: at, last_seen_at: at, ...(label ? { label } : {}) })

/** 假时钟 + 立即返回的 sleep;call 按脚本回。 */
function harness(script: { link: Array<object | Error>; devices: Array<object[] | Error> }) {
  let clock = 1_000_000
  const views: Array<{ kind: string; [k: string]: unknown }> = []
  const link = [...script.link], devices = [...script.devices]
  const next = <T,>(q: T[]) => (q.length > 1 ? q.shift()! : q[0]!)
  const call = vi.fn(async (method: string, path: string) => {
    if (method === 'POST' && path === '/v1/phone/link') { const r = next(link); if (r instanceof Error) throw r; return r }
    if (method === 'GET' && path === '/v1/phone/devices') { const r = next(devices); if (r instanceof Error) throw r; return { ok: true, devices: r } }
    throw new Error(`unexpected ${method} ${path}`)
  })
  const flow = makePhoneLinkFlow({ call, onView: v => views.push(v as never), now: () => clock, sleep: async ms => { clock += ms }, pollMs: 2000, startTimeoutMs: 45_000 })
  return { flow, views, call, tick: (ms: number) => { clock += ms } }
}
const ready = (expiresIn = 600_000) => ({ ok: true, state: 'ready', url: URL1, expires_at: 1_000_000 + expiresIn })

describe('文案(D6)', () => {
  it('zh / en 键一致、没有空串;中文不用半角逗号句号', () => {
    expect(Object.keys(PHONE_COPY.zh).sort()).toEqual(Object.keys(PHONE_COPY.en).sort())
    for (const v of [...Object.values(PHONE_COPY.zh), ...Object.values(PHONE_COPY.en)]) expect(v.trim()).not.toBe('')
    for (const [k, v] of Object.entries(PHONE_COPY.zh)) expect(v, k).not.toMatch(/[一-鿿][,.:?]|[,.:?][一-鿿]/)
  })
  it('桌面面向用户处不再有「手机扫码改设置」', () => {
    const files = ['index.html', 'main.js', ...readdirSync(join(SRC, 'modules')).filter(f => f.endsWith('.js')).map(f => join('modules', f))]
    for (const f of files) expect(readFileSync(join(SRC, f), 'utf8'), f).not.toContain('手机扫码改设置')
    expect(readFileSync(join(SRC, 'index.html'), 'utf8')).toMatch(/id="open-phone-settings"[^>]*>\s*连接手机\s*</)
  })
})

describe('linkView', () => {
  it('每个 state 一种画法;中继没开通不出码', () => {
    expect(linkView(ready() as never)).toEqual({ kind: 'qr', url: URL1, expiresAt: 1_600_000 })
    expect(linkView({ ok: false, state: 'starting' })).toEqual({ kind: 'starting' })
    expect(linkView({ ok: false, state: 'relay_not_configured' })).toEqual({ kind: 'notice', title: '手机连接服务还没开通', body: '开通之后，这里会出现二维码。' })
    expect(linkView({ ok: false, state: 'relay_unavailable' })).toMatchObject({ kind: 'notice', title: '手机连接服务这次没启动起来' })
    expect(linkView({ ok: false, state: 'remote_off' })).toMatchObject({ kind: 'notice', title: '手机连接没打开' })
    expect(linkView({ ok: false, state: 'no_owner' })).toEqual({ kind: 'notice', title: '先用微信扫码登录，再来连接手机。', body: '' })
  })
})

describe('newDevice / pairedLine', () => {
  it('出码前没有的 id 才算新;多台取最新', () => {
    expect(newDevice(new Set(['a']), [dev('a')])).toBeNull()
    expect(newDevice(new Set(['a']), [dev('a'), dev('b', 'x', '2026-10-01T10:00:00.000Z'), dev('c', 'y', '2026-10-01T11:00:00.000Z')])?.id).toBe('c')
  })
  it('有名字说名字,没有说「已连上手机」', () => {
    expect(pairedLine(dev('b', 'Tendhearth · iPhone'))).toBe('已连上 Tendhearth · iPhone')
    expect(pairedLine(dev('b'))).toBe('已连上手机')
  })
})

describe('makePhoneLinkFlow', () => {
  it('ready ⇒ 出码 ⇒ 新设备出现 ⇒ 已连上;请求带 enable_remote: true', async () => {
    const h = harness({ link: [ready()], devices: [[dev('old')], [dev('old')], [dev('old'), dev('new1', 'Tendhearth · iPhone')]] })
    await h.flow.start()
    expect(h.views.map(v => v.kind)).toEqual(['loading', 'qr', 'paired'])
    expect(h.views.at(-1)).toEqual({ kind: 'paired', line: '已连上 Tendhearth · iPhone' })
    expect(h.call).toHaveBeenCalledWith('POST', '/v1/phone/link', { enable_remote: true })
  })
  it('starting ⇒ 重试;重启中请求抛错也继续等(Review Focus 2)⇒ ready', async () => {
    const h = harness({ link: [{ ok: false, state: 'starting' }, new Error('workbench_connection_unavailable'), ready()], devices: [[], [dev('n', 'Tendhearth · Android')]] })
    await h.flow.start()
    expect(h.views.map(v => v.kind)).toEqual(['loading', 'starting', 'starting', 'qr', 'paired'])
  })
  it('一上来就抛错(不是重启中)⇒ 报错,不重试', async () => {
    const h = harness({ link: [new Error('boom')], devices: [[]] })
    await h.flow.start()
    expect(h.views.at(-1)).toEqual({ kind: 'error', text: '生成不了二维码：boom' })
    expect(h.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(1)
  })
  it('45 秒还在 starting ⇒ 「还没打开」', async () => {
    const h = harness({ link: [{ ok: false, state: 'starting' }], devices: [[]] })
    await h.flow.start()
    expect(h.views.at(-1)).toEqual({ kind: 'notice', title: '手机连接还没打开。稍后再点一次「连接手机」。', body: '' })
  })
  it('到期没人扫 ⇒ 过期', async () => {
    const h = harness({ link: [ready(5_000)], devices: [[]] })
    await h.flow.start()
    expect(h.views.at(-1)).toEqual({ kind: 'expired' })
  })
  it('新设备还没名字 ⇒ 再等两轮;仍没有 ⇒ 「已连上手机」', async () => {
    const h = harness({ link: [ready()], devices: [[], [dev('n')]] })
    await h.flow.start()
    expect(h.views.at(-1)).toEqual({ kind: 'paired', line: '已连上手机' })
    expect(h.call.mock.calls.filter(c => c[0] === 'GET').length).toBe(4)   // 出码前快照 + 3 轮(看到没名字、再等、放弃等)
  })
  it('stop 之后不再回调', async () => {
    const h = harness({ link: [{ ok: false, state: 'starting' }], devices: [[]] })
    const p = h.flow.start()
    h.flow.stop()
    await p
    expect(h.views.map(v => v.kind)).toEqual(['loading'])
  })
})

describe('mountPhoneConnect(弹层)', () => {
  it('出码、可复制;连上后按钮变「完成」;设备名按文字渲染(Review Focus 3)', async () => {
    document.body.innerHTML = ''
    const h = harness({ link: [ready()], devices: [[], [dev('x', '<img src=x onerror=alert(1)>')]] })
    const writeClipboard = vi.fn(async () => {})
    const m = mountPhoneConnect({ call: h.call, renderQr: async t => `<svg data-text="${t.length}"></svg>`, writeClipboard, flowDeps: { now: () => 1_000_000, sleep: async () => {}, labelWaits: 0 } })
    m.open()
    await vi.waitFor(() => expect(document.querySelector('#phone-connect-paired')).not.toBeNull())
    expect(document.querySelector('#phone-connect-paired')!.textContent).toBe('已连上 <img src=x onerror=alert(1)>')
    expect(document.querySelector('#phone-settings-modal img')).toBeNull()
    expect(document.querySelector('#phone-connect-close')!.textContent).toBe('完成')
    expect(document.querySelector('#phone-connect-title')!.textContent).toBe('连接手机')
    m.close()
    expect(document.querySelector('#phone-settings-modal')).toBeNull()
  })
  it('Esc 关闭并停轮询', async () => {
    document.body.innerHTML = ''
    const h = harness({ link: [ready()], devices: [[]] })
    const m = mountPhoneConnect({ call: h.call, renderQr: async () => '<svg></svg>', flowDeps: { now: () => 1_000_000, sleep: () => new Promise(r => setTimeout(r, 5)) } })
    m.open()
    await vi.waitFor(() => expect(document.querySelector('#phone-connect-qr')).not.toBeNull())
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('#phone-settings-modal')).toBeNull()
    const n = h.call.mock.calls.length
    await new Promise(r => setTimeout(r, 30))
    expect(h.call.mock.calls.length).toBeLessThanOrEqual(n + 1)
  })
})
```

- [ ] **Step 3: 跑,确认失败**

Run: `bun --bun vitest run apps/desktop/src/modules/phone-connect.test.ts`
Expected: FAIL(`Cannot find module './phone-connect.js'`)

- [ ] **Step 4: 实现** `apps/desktop/src/modules/phone-connect.js`

```js
// @ts-check
/// <reference lib="dom" />
/**
 * 「连接手机」(spec 2026-10-01-tendhearth-pairing-ux §4.3、§5):设置抽屉的弹层与引导页最后一步共用一个流程。
 * daemon:POST /v1/phone/link(必要时打开远程隧道;只在 v2 中继就绪时出码)、GET /v1/phone/devices(轮询「已连上」)。
 * 两条都是 admin,经原生宿主的 operator 凭据(invokeWorkbenchApi),渲染进程拿不到令牌。设备名是用户内容,一律 textContent。
 */
import { phoneCopy as c } from './phone-connect-copy.js'

/** @typedef {'ready'|'starting'|'remote_off'|'relay_not_configured'|'relay_unavailable'|'no_owner'} LinkState */
/** @typedef {{ ok: true, state: 'ready', url: string, expires_at: number } | { ok: false, state: Exclude<LinkState, 'ready'> }} LinkResult */
/** @typedef {{ id: string, label?: string, created_at: string, last_seen_at: string }} Device */
/** @typedef {{ kind: 'loading' } | { kind: 'qr', url: string, expiresAt: number } | { kind: 'starting' } | { kind: 'notice', title: string, body: string } | { kind: 'expired' } | { kind: 'paired', line: string } | { kind: 'error', text: string }} View */
/** @typedef {(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<unknown>} Call */
/** @typedef {{ now?: () => number, sleep?: (ms: number) => Promise<void>, pollMs?: number, startTimeoutMs?: number, labelWaits?: number }} FlowTuning */

/** @param {LinkResult} r @returns {View} */
export function linkView(r) {
  if (r.ok) return { kind: 'qr', url: r.url, expiresAt: r.expires_at }
  switch (r.state) {
    case 'starting': return { kind: 'starting' }
    case 'relay_not_configured': return { kind: 'notice', title: c.relayNotConfiguredTitle, body: c.relayNotConfiguredBody }
    case 'relay_unavailable': return { kind: 'notice', title: c.relayUnavailableTitle, body: c.relayUnavailableBody }
    case 'remote_off': return { kind: 'notice', title: c.remoteOffTitle, body: c.remoteOffBody }
    case 'no_owner': return { kind: 'notice', title: c.noOwnerTitle, body: '' }
    default: return { kind: 'error', text: c.error.replace('{why}', 'unknown_state') }
  }
}

/** 出码前快照里没有的 id 才算新;多台取最新创建的。 @param {Set<string>} before @param {Device[]} now @returns {Device | null} */
export function newDevice(before, now) {
  const fresh = now.filter(d => !before.has(d.id))
  if (fresh.length === 0) return null
  return [...fresh].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
}

/** @param {Device} d */
export function pairedLine(d) {
  return d.label ? c.paired.replace('{label}', d.label) : c.pairedNoLabel
}

/** @param {unknown} err */
const why = err => (err instanceof Error ? err.message : String(err))

/**
 * 一次「连接手机」:要码(必要时等 daemon 重启)→ 出码 → 盯设备列表 → 连上 / 过期。
 * start() 重入即重来(旧的那一轮自动作废);stop() 之后不再回调。
 * @param {{ call: Call, onView: (v: View) => void } & FlowTuning} deps
 */
export function makePhoneLinkFlow(deps) {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const pollMs = deps.pollMs ?? 2000
  const startTimeoutMs = deps.startTimeoutMs ?? 45_000
  let run = 0
  /** @returns {Promise<Device[] | null>} */
  const devices = async () => {
    try {
      const r = /** @type {{ ok?: boolean, devices?: Device[] }} */ (await deps.call('GET', '/v1/phone/devices'))
      return r && r.ok && Array.isArray(r.devices) ? r.devices : null
    } catch { return null }
  }
  async function start() {
    const mine = ++run
    const alive = () => mine === run
    /** @param {View} v */
    const show = v => { if (alive()) deps.onView(v) }
    show({ kind: 'loading' })
    const first = await devices()
    /** @type {Set<string> | null} */
    let baseline = first ? new Set(first.map(d => d.id)) : null
    const t0 = now()
    let sawStarting = false
    /** @type {{ ok: true, state: 'ready', url: string, expires_at: number } | null} */
    let ready = null
    while (alive()) {
      /** @type {LinkResult} */
      let r
      try {
        r = /** @type {LinkResult} */ (await deps.call('POST', '/v1/phone/link', { enable_remote: true }))
      } catch (err) {
        if (!sawStarting) { show({ kind: 'error', text: c.error.replace('{why}', why(err)) }); return }
        r = { ok: false, state: 'starting' }   // daemon 正在重启:连不上是预期的(Review Focus 2)
      }
      if (!alive()) return
      if (r.ok) { ready = r; break }
      if (r.state !== 'starting') { show(linkView(r)); return }
      sawStarting = true
      if (now() - t0 >= startTimeoutMs) { show({ kind: 'notice', title: c.startTimeout, body: '' }); return }
      show({ kind: 'starting' })
      await sleep(pollMs)
    }
    if (!ready || !alive()) return
    show(linkView(ready))
    let labelWaits = deps.labelWaits ?? 2
    while (alive()) {
      if (now() >= ready.expires_at) { show({ kind: 'expired' }); return }
      await sleep(pollMs)
      if (!alive()) return
      const list = await devices()
      if (!list) continue
      if (!baseline) { baseline = new Set(list.map(d => d.id)); continue }
      const d = newDevice(baseline, list)
      if (!d) continue
      if (!d.label && labelWaits-- > 0) continue
      show({ kind: 'paired', line: pairedLine(d) })
      return
    }
  }
  return { start, stop() { run++ } }
}

/**
 * @param {Document} doc @param {string} tag @param {Record<string, string>} [attrs] @param {string} [text]
 * @returns {HTMLElement}
 */
function el(doc, tag, attrs = {}, text = '') {
  const n = doc.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
  if (text) n.textContent = text
  return n
}

/**
 * 设置抽屉的「连接手机」弹层(#phone-settings-modal,一张卡、无阴影)。
 * @param {{ call: Call, renderQr: (text: string) => Promise<string>, writeClipboard?: (text: string) => Promise<void>, flowDeps?: FlowTuning, doc?: Document }} deps
 */
export function mountPhoneConnect(deps) {
  const doc = deps.doc ?? document
  /** @type {HTMLElement | null} */ let modal = null
  /** @type {ReturnType<typeof makePhoneLinkFlow> | null} */ let flow = null
  let seq = 0
  /** @param {KeyboardEvent} ev */
  const onKey = ev => { if (ev.key === 'Escape') close() }
  function close() {
    flow?.stop(); flow = null
    modal?.remove(); modal = null
    doc.removeEventListener('keydown', onKey)
  }
  /** @param {View} v */
  async function render(v) {
    if (!modal) return
    const mine = ++seq
    const body = /** @type {HTMLElement} */ (modal.querySelector('#phone-connect-body'))
    const closeBtn = /** @type {HTMLElement} */ (modal.querySelector('#phone-connect-close'))
    closeBtn.textContent = v.kind === 'paired' ? c.done : c.close
    if (v.kind === 'qr') {
      let svg
      try { svg = await deps.renderQr(v.url) } catch (err) { if (mine === seq) void render({ kind: 'error', text: c.error.replace('{why}', why(err)) }); return }
      if (mine !== seq || !modal) return
      const qr = el(doc, 'div', { id: 'phone-connect-qr', class: 'qr-svg' })
      qr.innerHTML = svg   // render_qr_svg 的产物(Rust 生成),不含用户内容
      const copy = el(doc, 'button', { type: 'button', class: 'btn ghost', id: 'phone-connect-copy' }, c.copyLink)
      copy.addEventListener('click', async () => {
        try { await (deps.writeClipboard ?? (t => navigator.clipboard.writeText(t)))(v.url); copy.textContent = c.copied } catch { /* 复制不了就不改字 */ }
      })
      body.replaceChildren(qr, el(doc, 'p', { class: 'qr-note', id: 'phone-connect-note' }, c.readyNote), el(doc, 'p', { class: 'qr-sub' }, c.readySub), copy)
      return
    }
    if (v.kind === 'loading') body.replaceChildren(el(doc, 'p', { class: 'qr-note' }, c.loading))
    else if (v.kind === 'starting') body.replaceChildren(el(doc, 'p', { class: 'qr-note', id: 'phone-connect-starting' }, c.starting))
    else if (v.kind === 'notice') body.replaceChildren(el(doc, 'p', { class: 'qr-notice', id: 'phone-connect-notice' }, v.title), ...(v.body ? [el(doc, 'p', { class: 'qr-note' }, v.body)] : []))
    else if (v.kind === 'error') body.replaceChildren(el(doc, 'p', { class: 'qr-note', id: 'phone-connect-error' }, v.text))
    else if (v.kind === 'paired') body.replaceChildren(el(doc, 'p', { class: 'qr-paired', id: 'phone-connect-paired' }, v.line))
    else if (v.kind === 'expired') {
      const renew = el(doc, 'button', { type: 'button', class: 'btn ghost', id: 'phone-connect-renew' }, c.renew)
      renew.addEventListener('click', () => { void flow?.start() })
      body.replaceChildren(el(doc, 'p', { class: 'qr-note', id: 'phone-connect-expired' }, c.expired), renew)
    }
  }
  return {
    open() {
      close()
      modal = el(doc, 'div', { id: 'phone-settings-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'phone-connect-title' })
      const card = el(doc, 'div', { class: 'qr-card' })
      const closeBtn = el(doc, 'button', { type: 'button', class: 'btn ghost', id: 'phone-connect-close' }, c.close)
      closeBtn.addEventListener('click', close)
      card.append(el(doc, 'h2', { id: 'phone-connect-title' }, c.title), el(doc, 'div', { id: 'phone-connect-body' }), closeBtn)
      modal.append(card)
      modal.addEventListener('click', ev => { if (ev.target === modal) close() })
      doc.addEventListener('keydown', onKey)
      doc.body.append(modal)
      flow = makePhoneLinkFlow({ ...(deps.flowDeps ?? {}), call: deps.call, onView: v => { void render(v) } })
      void flow.start()
    },
    close,
  }
}
```

- [ ] **Step 5: 接线与改名**

`apps/desktop/src/index.html:297` 换成:

```html
            <button id="open-phone-settings" class="phone-settings-btn" type="button" title="用手机扫码连上这台电脑（码 10 分钟内有效，只能用一次）">连接手机</button>
```

`apps/desktop/src/main.js`:顶部 import 区加 `import { mountPhoneConnect } from "./modules/phone-connect.js"`;把 `// 手机上改设置 — …` 那段 `document.getElementById("open-phone-settings")?.addEventListener("click", async () => { … })`(约 678–703 行)整段换成:

```js
  // 连接手机(spec 2026-10-01-tendhearth-pairing-ux §4.3):admin 路由走原生宿主(invokeWorkbenchApi),渲染进程拿不到令牌。
  const phoneConnect = mountPhoneConnect({
    call: (method, path, body) => invokeWorkbenchApi(method, path, body),
    renderQr: text => /** @type {Promise<string>} */ (deps.invoke("render_qr_svg", { text })),
  })
  document.getElementById("open-phone-settings")?.addEventListener("click", () => phoneConnect.open())
```

`apps/desktop/src/modules/atelier-gallery.js:31` 的 `off` 分支换成:

```js
  if (data.mode === "off") return { title: "画室尚未开启", detail: "在设置里点「连接手机」，用手机打开设置，开启「让 CC 自己画画」。首次需下载约 5GB 的画笔。", action: "home" }
```

(若 `atelier-gallery.test.js` 断言了旧文案,同步改成新文案。)

`apps/desktop/src/styles.css`:`.phone-settings-btn` 去掉 `gap`(没有图标了);在 `#phone-settings-modal .qr-note { … }` 之后加(只用 token):

```css
#phone-settings-modal .qr-card { display: flex; flex-direction: column; align-items: center; gap: var(--th-space-m); max-width: 360px; }
#phone-settings-modal #phone-connect-title { margin: 0; font-size: var(--th-size-title); line-height: var(--th-lh-title); font-weight: 500; color: var(--th-ink); }
#phone-settings-modal .qr-notice, #phone-settings-modal .qr-paired { margin: 0; font-size: var(--th-size-item); line-height: var(--th-lh-item); color: var(--th-ink); }
#phone-settings-modal .qr-sub { margin: 0; font-size: var(--th-size-small); color: var(--th-ink-soft); }
#phone-settings-modal { background: var(--th-scrim); }
```

- [ ] **Step 6: 跑单测**

Run: `bun --bun vitest run apps/desktop`
Expected: PASS(含 phone-connect 全部用例;atelier 用例跟着新文案)

- [ ] **Step 7: 写 e2e** `apps/desktop/playwright/phone-connect.spec.ts`

```ts
// 「连接手机」(plan 7a):设置抽屉的弹层。驱动 test-shim(DRY_RUN)的 /v1/phone/* 演示路由。
import { test, expect, reveal } from './fixtures'

const URL1 = `https://relay.tendhearth.com/pset/#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`
const ready = () => ({ ok: true, state: 'ready', url: URL1, expires_at: Date.now() + 600_000 })
const dev = (id: string, label?: string) => ({ id, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), ...(label ? { label } : {}) })

async function bootIntoDashboard(page: import('@playwright/test').Page, shimUrl: string) {
  await page.goto(shimUrl)
  await page.waitForFunction(() => { const m = document.documentElement.dataset.mode; return m !== undefined && m !== 'loading' }, { timeout: 15_000 })
  await page.evaluate(() => { document.documentElement.dataset.mode = 'dashboard' })
}
async function openConnect(page: import('@playwright/test').Page) {
  await reveal(page, '#open-phone-settings')
  await expect(page.locator('#open-phone-settings')).toHaveText('连接手机')
  await page.locator('#open-phone-settings').click()
  await expect(page.locator('#phone-connect-title')).toHaveText('连接手机')
}

test('出码 → 手机配上 → 「已连上 Tendhearth · iPhone」;请求带 enable_remote', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { link: [ready()], devices: [[dev('old')], [dev('old')], [dev('old'), dev('new1', 'Tendhearth · iPhone')]] } })
  await bootIntoDashboard(page, shimUrl)
  await openConnect(page)
  await expect(page.locator('#phone-connect-qr')).toBeVisible()
  await expect(page.locator('#phone-connect-note')).toHaveText('用手机相机扫一下。10 分钟内有效，只能用一次。')
  await expect(page.locator('#phone-connect-paired')).toHaveText('已连上 Tendhearth · iPhone', { timeout: 15_000 })
  await expect(page.locator('#phone-connect-close')).toHaveText('完成')
  const calls = await shim.invoke('mock.phone-calls') as { result: { calls: unknown[] } }
  expect(calls.result.calls[0]).toEqual({ enable_remote: true })
  await page.locator('#phone-connect-close').click()
  await expect(page.locator('#phone-settings-modal')).toHaveCount(0)
})

test('中继没开通 ⇒ 说明,不出码', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { link: [{ ok: false, state: 'relay_not_configured' }], devices: [[]] } })
  await bootIntoDashboard(page, shimUrl)
  await openConnect(page)
  await expect(page.locator('#phone-connect-notice')).toHaveText('手机连接服务还没开通')
  await expect(page.locator('#phone-connect-qr')).toHaveCount(0)
})

test('正在打开隧道 ⇒ 等一下 ⇒ 出码', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { link: [{ ok: false, state: 'starting' }, ready()], devices: [[]] } })
  await bootIntoDashboard(page, shimUrl)
  await openConnect(page)
  await expect(page.locator('#phone-connect-starting')).toHaveText('正在打开手机连接，CC 会重启一下。')
  await expect(page.locator('#phone-connect-qr')).toBeVisible({ timeout: 10_000 })
})

test('页面上再也没有「手机扫码改设置」', async ({ page, shimUrl, shim }) => {
  await shim.invoke('demo.seed', { chat_id: 'test_chat' })
  await bootIntoDashboard(page, shimUrl)
  expect(await page.content()).not.toContain('手机扫码改设置')
})
```

- [ ] **Step 8: 跑 e2e**

Run: `lsof -i :4176; cd apps/desktop && bun x playwright test phone-connect && bun x playwright test && cd -`
Expected: `phone-connect` 4 个用例 PASS;全量 PASS

- [ ] **Step 9: 根回路**

Run: `bun run test && bun run typecheck`
Expected: 全绿(含 plan 6 的样式守卫:新 CSS 没有字面色值、字重只有 500)

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/modules/phone-connect-copy.js apps/desktop/src/modules/phone-connect.js apps/desktop/src/modules/phone-connect.test.ts apps/desktop/playwright/phone-connect.spec.ts apps/desktop/src/index.html apps/desktop/src/main.js apps/desktop/src/modules/atelier-gallery.js apps/desktop/src/styles.css
git add apps/desktop/src/modules/atelier-gallery.test.js 2>/dev/null || true
git commit -m "配对体验 Task 5:桌面「手机扫码改设置」改名「连接手机」—— 出码、中继未开通直说、打开隧道时等一下、已连上谁

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 引导页最后一步直接给码

**Files:**
- Modify: `apps/desktop/src/modules/phone-connect.js`(加 `mountOnboardPhone`)
- Modify: `apps/desktop/src/modules/phone-connect.test.ts`
- Modify: `apps/desktop/src/index.html`(`#screen-service` 里 `.wz-foot` 之前)
- Modify: `apps/desktop/src/main.js`(`showStep`、`setMode`、`wireDoctorSubscribers`、`wireEvents`)
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/playwright/phone-connect.spec.ts`

**Interfaces:**
- Consumes: Task 5 的 `makePhoneLinkFlow`、`phoneCopy`、`View`;`doctorPoller.current`(`checks.daemon.alive`)。
- Produces:
  - `mountOnboardPhone(deps: { host: HTMLElement; call: Call; renderQr(text: string): Promise<string>; flowDeps?: FlowTuning }): { sync(s: { active: boolean; alive: boolean }): void }`
  - DOM:`#onboard-phone`(默认 `hidden`)、`#onboard-phone-title`、`#onboard-phone-qr`、`#onboard-phone-status`、`#onboard-phone-renew`(默认 `hidden`)、`#onboard-phone-later`

- [ ] **Step 1: 写失败的单测** —— 追加到 `apps/desktop/src/modules/phone-connect.test.ts`(顶部 import 加 `mountOnboardPhone`):

```ts
describe('mountOnboardPhone(引导页,裁决 3)', () => {
  function host() {
    document.body.innerHTML = `<div id="onboard-phone" hidden><h3 id="onboard-phone-title"></h3><div id="onboard-phone-qr"></div><p id="onboard-phone-status"></p><button id="onboard-phone-renew" hidden></button><p id="onboard-phone-later"></p></div>`
    return document.getElementById('onboard-phone')!
  }
  const fast = { now: () => 1_000_000, sleep: async () => {} }
  it('拿到 ready 才显示整块;文案来自文案模块', async () => {
    const h = host()
    const t = harness({ link: [ready()], devices: [[], [dev('n', 'Tendhearth · iPhone')]] })
    const m = mountOnboardPhone({ host: h, call: t.call, renderQr: async () => '<svg id="q"></svg>', flowDeps: fast })
    expect(h.hidden).toBe(true)
    m.sync({ active: true, alive: true })
    await vi.waitFor(() => expect(document.getElementById('onboard-phone-status')!.textContent).toBe('已连上 Tendhearth · iPhone'))
    expect(h.hidden).toBe(false)
    expect(document.getElementById('onboard-phone-title')!.textContent).toBe('连接手机')
    expect(document.getElementById('onboard-phone-later')!.textContent).toBe('之后再连也可以：在设置里点「连接手机」。')
  })
  it('中继没开通 ⇒ 整块一直藏着', async () => {
    const h = host()
    const t = harness({ link: [{ ok: false, state: 'relay_not_configured' }], devices: [[]] })
    mountOnboardPhone({ host: h, call: t.call, renderQr: async () => '<svg></svg>', flowDeps: fast }).sync({ active: true, alive: true })
    await vi.waitFor(() => expect(t.call).toHaveBeenCalledWith('POST', '/v1/phone/link', { enable_remote: true }))
    await new Promise(r => setTimeout(r, 10))
    expect(h.hidden).toBe(true)
  })
  it('daemon 没活 ⇒ 不请求;离开这一步 ⇒ 停、藏;同一步里重复 sync 不重开', async () => {
    const h = host()
    const t = harness({ link: [ready()], devices: [[]] })
    const m = mountOnboardPhone({ host: h, call: t.call, renderQr: async () => '<svg></svg>', flowDeps: { now: () => 1_000_000, sleep: () => new Promise(r => setTimeout(r, 5)) } })
    m.sync({ active: true, alive: false })
    expect(t.call).not.toHaveBeenCalled()
    m.sync({ active: true, alive: true })
    m.sync({ active: true, alive: true })
    await vi.waitFor(() => expect(h.hidden).toBe(false))
    expect(t.call.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(1)
    m.sync({ active: false, alive: true })
    expect(h.hidden).toBe(true)
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run apps/desktop/src/modules/phone-connect.test.ts`
Expected: FAIL(`mountOnboardPhone` 未导出)

- [ ] **Step 3: 实现** —— `apps/desktop/src/modules/phone-connect.js` 末尾追加:

```js
/**
 * 引导页最后一步(#screen-service)的码(spec §5):只有拿到 ready 的码才显示整块;别的状态整块藏着;永不挡「进入控制台」。
 * sync({ active, alive }):在这一步且 daemon 活着 ⇒ 开始(只开一次);离开这一步 ⇒ 停、藏。
 * @param {{ host: HTMLElement, call: Call, renderQr: (text: string) => Promise<string>, flowDeps?: FlowTuning }} deps
 */
export function mountOnboardPhone(deps) {
  const { host } = deps
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (host.querySelector(`#${id}`))
  $('onboard-phone-title').textContent = c.title
  $('onboard-phone-later').textContent = c.later
  const renew = $('onboard-phone-renew')
  renew.textContent = c.renew
  let started = false
  let seq = 0
  /** @param {View} v */
  async function show(v) {
    const mine = ++seq
    if (v.kind === 'loading' || v.kind === 'starting') return   // 藏着就继续藏着,出码再出现
    if (v.kind === 'qr') {
      let svg
      try { svg = await deps.renderQr(v.url) } catch { return }
      if (mine !== seq || !started) return
      $('onboard-phone-qr').innerHTML = svg   // render_qr_svg 的产物,不含用户内容
      $('onboard-phone-status').textContent = c.readyNote
      renew.hidden = true
      host.hidden = false
      return
    }
    // 连上 / 过期只会发生在出过码之后(出码那次的 renderQr 可能被这一帧抢先作废,所以这里也要亮出整块)
    if (v.kind === 'paired') { $('onboard-phone-qr').replaceChildren(); $('onboard-phone-status').textContent = v.line; renew.hidden = true; host.hidden = false; return }
    if (v.kind === 'expired') { $('onboard-phone-qr').replaceChildren(); $('onboard-phone-status').textContent = c.expired; renew.hidden = false; host.hidden = false; return }
    host.hidden = true
  }
  const flow = makePhoneLinkFlow({ ...(deps.flowDeps ?? {}), call: deps.call, onView: v => { void show(v) } })
  renew.addEventListener('click', () => { void flow.start() })
  return {
    /** @param {{ active: boolean, alive: boolean }} s */
    sync(s) {
      if (!s.active) {
        if (started) { started = false; flow.stop() }
        host.hidden = true
        return
      }
      if (s.alive && !started) { started = true; void flow.start() }
    },
  }
}
```

- [ ] **Step 4: 跑单测**

Run: `bun --bun vitest run apps/desktop/src/modules/phone-connect.test.ts`
Expected: PASS

- [ ] **Step 5: 标记与接线**

`apps/desktop/src/index.html`:`#screen-service` 里 `<div class="wz-foot" style="border:0; padding: 4px 0 0;">` 之前插入(文字由脚本填,见 `mountOnboardPhone`):

```html
            <div id="onboard-phone" class="onboard-phone" hidden>
              <h3 id="onboard-phone-title"></h3>
              <div id="onboard-phone-qr" class="qr-svg"></div>
              <p id="onboard-phone-status" class="qr-note"></p>
              <button id="onboard-phone-renew" class="btn ghost" type="button" hidden></button>
              <p id="onboard-phone-later" class="qr-sub"></p>
            </div>
```

`apps/desktop/src/main.js`:
- import 行改成 `import { mountPhoneConnect, mountOnboardPhone } from "./modules/phone-connect.js"`。
- 模块级(`function showStep` 之前)加:

```js
// 引导页最后一步的码(spec 2026-10-01-tendhearth-pairing-ux §5):在 #screen-service 且 daemon 活着才要码。
/** @type {ReturnType<typeof mountOnboardPhone> | null} */ let onboardPhone = null
function syncOnboardPhone(report = doctorPoller.current) {
  const active = document.documentElement.dataset.mode === "wizard" && !!document.getElementById("screen-service")?.classList.contains("active")
  onboardPhone?.sync({ active, alive: !!report?.checks?.daemon?.alive })
}
```

- `showStep(name)` 里 `wizardShowStep(state, name)` 的下一行加 `syncOnboardPhone()`。
- `setMode(mode)` 里 `document.documentElement.dataset.mode = mode` 的下一行加 `syncOnboardPhone()`。
- `wireDoctorSubscribers()` 里加一行 `doctorPoller.subscribe(report => syncOnboardPhone(report))`。
- `wireEvents()` 里(Task 5 的 `phoneConnect` 挂载之后)加:

```js
  const onboardHost = document.getElementById("onboard-phone")
  if (onboardHost) onboardPhone = mountOnboardPhone({
    host: onboardHost,
    call: (method, path, body) => invokeWorkbenchApi(method, path, body),
    renderQr: text => /** @type {Promise<string>} */ (deps.invoke("render_qr_svg", { text })),
  })
```

`apps/desktop/src/styles.css` 加(只用 token):

```css
.onboard-phone { display: flex; flex-direction: column; align-items: center; gap: var(--th-space-s); padding: var(--th-space-l) 0; border-top: 1px solid var(--th-hair); }
.onboard-phone[hidden] { display: none; }
.onboard-phone h3 { margin: 0; font-size: var(--th-size-item); line-height: var(--th-lh-item); font-weight: 500; color: var(--th-ink); }
.onboard-phone .qr-svg svg { width: 180px; height: 180px; }
.onboard-phone .qr-note { margin: 0; color: var(--th-ink); }
.onboard-phone .qr-sub { margin: 0; font-size: var(--th-size-small); color: var(--th-ink-soft); }
```

- [ ] **Step 6: 写 e2e** —— 追加到 `apps/desktop/playwright/phone-connect.spec.ts`:

```ts
const SERVICE_STEP_REPORT = {
  ready: false, stateDir: '/tmp/wechat-cc-shim', runtime: 'source', wslDetected: false,
  checks: {
    bun: { ok: true, path: '/usr/local/bin/bun' }, git: { ok: true, path: '/usr/bin/git' },
    claude: { ok: true, path: '/usr/local/bin/claude' }, codex: { ok: true, path: '/usr/local/bin/codex' },
    cursor: { ok: false, apiKeySet: false, sdkInstalled: true },
    accounts: { ok: true, count: 1, items: [{ id: 'bot1-im-bot', botId: 'bot1', userId: 'u1', baseUrl: '' }] },
    access: { ok: true, dmPolicy: 'allowlist', allowFromCount: 1 },
    provider: { ok: true, provider: 'claude', binaryPath: '/usr/local/bin/claude' },
    daemon: { alive: true, pid: 12345 },
    service: { installed: false, kind: 'launchagent' },
  },
  userNames: { u1: 'Test User' }, expiredBots: [], nextActions: [],
}

test.describe('引导页最后一步', () => {
  test.afterEach(async ({ shim }) => { await shim.invoke('mock.doctor', { report: null }) })

  test('中继就绪 ⇒ 码直接出现;「进入控制台」照样能点', async ({ page, shimUrl, shim }) => {
    await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { link: [ready()], devices: [[]] } })
    await shim.invoke('mock.doctor', { report: SERVICE_STEP_REPORT })
    await page.goto(shimUrl)
    await expect(page.locator('#screen-service')).toHaveClass(/active/, { timeout: 15_000 })
    await expect(page.locator('#onboard-phone')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#onboard-phone-title')).toHaveText('连接手机')
    await expect(page.locator('#onboard-phone-later')).toHaveText('之后再连也可以：在设置里点「连接手机」。')
    await expect(page.locator('#enter-dashboard')).toBeEnabled()
  })

  test('中继没开通 ⇒ 整块不出现', async ({ page, shimUrl, shim }) => {
    await shim.invoke('demo.seed', { chat_id: 'test_chat', phone: { link: [{ ok: false, state: 'relay_not_configured' }], devices: [[]] } })
    await shim.invoke('mock.doctor', { report: SERVICE_STEP_REPORT })
    await page.goto(shimUrl)
    await expect(page.locator('#screen-service')).toHaveClass(/active/, { timeout: 15_000 })
    await expect.poll(async () => ((await shim.invoke('mock.phone-calls')) as { result: { calls: unknown[] } }).result.calls.length).toBeGreaterThan(0)
    await expect(page.locator('#onboard-phone')).toBeHidden()
  })
})
```

- [ ] **Step 7: 跑 e2e**

Run: `cd apps/desktop && bun x playwright test phone-connect wizard && bun x playwright test && cd -`
Expected: 全 PASS(`wizard.spec.ts` 的「四个屏」「step n of 4」不受影响)

- [ ] **Step 8: 回路**

Run: `bun --bun vitest run apps/desktop && bun run test && bun run typecheck`
Expected: 全绿

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/modules/phone-connect.js apps/desktop/src/modules/phone-connect.test.ts apps/desktop/src/index.html apps/desktop/src/main.js apps/desktop/src/styles.css apps/desktop/playwright/phone-connect.spec.ts
git commit -m "配对体验 Task 6:引导页最后一步直接给码(可跳过、中继没开通就不出现、不挡进入控制台)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 中继 Worker 发 `/.well-known/apple-app-site-association` 与 `assetlinks.json`

**Files:**
- Create: `apps/relay/src/well-known.ts`
- Create: `apps/relay/test/well-known.test.ts`
- Modify: `apps/relay/src/index.ts`、`apps/relay/src/env.d.ts`
- Modify: `docs/maintainer/relay.md`(§4 Secrets 加名字、新增「通用链接 / App Links」一节)

**Interfaces:**
- Consumes: 无。
- Produces(`apps/relay/src/well-known.ts`):
  - `APPLE_APP_ID = '9Y6JAPDP7A.com.tendhearth.app'`、`ANDROID_PACKAGE = 'com.tendhearth.app'`
  - `appleAppSiteAssociation(): object`
  - `androidCertFingerprints(raw: string | undefined): string[]`
  - `assetLinks(raw: string | undefined): object[]`
  - `wellKnown(pathname: string, env: { ANDROID_CERT_SHA256?: string }): Response | null`
  - `Env.ANDROID_CERT_SHA256?: string`(Worker secret,逗号分隔)

- [ ] **Step 1: 写失败的测试** `apps/relay/test/well-known.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'
import { APPLE_APP_ID, androidCertFingerprints, appleAppSiteAssociation, assetLinks } from '../src/well-known'

const fp = (seed: number) => Array.from({ length: 32 }, (_, i) => ((i + seed) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':')
const FP1 = fp(0), FP2 = fp(7)

describe('.well-known(spec 2026-10-01-tendhearth-pairing-ux §6.1)', () => {
  it('AASA:只认 /pset 与 /pset/*;appID = 团队 + bundle id', () => {
    expect(APPLE_APP_ID).toBe('9Y6JAPDP7A.com.tendhearth.app')
    expect(appleAppSiteAssociation()).toEqual({
      applinks: { details: [{ appIDs: ['9Y6JAPDP7A.com.tendhearth.app'], components: [{ '/': '/pset' }, { '/': '/pset/*' }] }] },
    })
  })
  it('指纹:逗号分隔、去空格、小写规范成大写、畸形丢掉、去重', () => {
    expect(androidCertFingerprints(undefined)).toEqual([])
    expect(androidCertFingerprints('')).toEqual([])
    expect(androidCertFingerprints(` ${FP1.toLowerCase()} , nope, ${FP2},${FP1}`)).toEqual([FP1, FP2])
  })
  it('assetlinks:有指纹 ⇒ 一条 handle_all_urls;没有 ⇒ [](合法 JSON,验证失败、浏览器兜底)', () => {
    expect(assetLinks(undefined)).toEqual([])
    expect(assetLinks('garbage')).toEqual([])
    expect(assetLinks(FP1)).toEqual([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: 'com.tendhearth.app', sha256_cert_fingerprints: [FP1] },
    }])
  })
  it('入口:两个文件都是 200 JSON、不重定向、可缓存;测试环境没设 secret ⇒ assetlinks 是 []', async () => {
    const a = await SELF.fetch('https://relay.test/.well-known/apple-app-site-association', { redirect: 'manual' })
    expect(a.status).toBe(200)
    expect(a.headers.get('content-type')).toContain('application/json')
    expect(a.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await a.json()).toEqual(appleAppSiteAssociation())
    const b = await SELF.fetch('https://relay.test/.well-known/assetlinks.json')
    expect(b.status).toBe(200)
    expect(await b.json()).toEqual([])
    expect((await SELF.fetch('https://relay.test/.well-known/other')).status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/relay && bun run test`
Expected: FAIL(`Cannot find module '../src/well-known'`)

- [ ] **Step 3: 实现**

`apps/relay/src/well-known.ts`:

```ts
/**
 * iOS 通用链接 / 安卓 App Links 的两份声明(spec 2026-10-01-tendhearth-pairing-ux §6.1)。
 * 只覆盖配对壳页 /pset:系统相机扫桌面「连接手机」的码 ⇒ 打开 Tendhearth app(装了的话),否则照旧开网页壳。
 * 安卓签名指纹不在仓库:Worker secret ANDROID_CERT_SHA256(逗号分隔);没设 ⇒ [](验证失败,浏览器兜底)。
 */
export const APPLE_APP_ID = '9Y6JAPDP7A.com.tendhearth.app'
export const ANDROID_PACKAGE = 'com.tendhearth.app'
const SHA256_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' }

export function appleAppSiteAssociation() {
  return { applinks: { details: [{ appIDs: [APPLE_APP_ID], components: [{ '/': '/pset' }, { '/': '/pset/*' }] }] } }
}

export function androidCertFingerprints(raw: string | undefined): string[] {
  const out: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const fp = part.trim().toUpperCase()
    if (SHA256_RE.test(fp) && !out.includes(fp)) out.push(fp)
  }
  return out
}

export function assetLinks(raw: string | undefined) {
  const fps = androidCertFingerprints(raw)
  if (fps.length === 0) return []
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: fps },
  }]
}

export function wellKnown(pathname: string, env: { ANDROID_CERT_SHA256?: string }): Response | null {
  if (pathname === '/.well-known/apple-app-site-association') return new Response(JSON.stringify(appleAppSiteAssociation()), { headers: HEADERS })
  if (pathname === '/.well-known/assetlinks.json') return new Response(JSON.stringify(assetLinks(env.ANDROID_CERT_SHA256)), { headers: HEADERS })
  return null
}
```

`apps/relay/src/env.d.ts`:`interface Env` 里 `FCM_TOKEN_URL?: string` 下一行加:

```ts
  /** 安卓 App Links 的签名证书 SHA-256(逗号分隔;Play 应用签名密钥 + 上传 / 内部分发密钥)。secret。 */
  ANDROID_CERT_SHA256?: string
```

`apps/relay/src/index.ts`:import 区加 `import { wellKnown } from './well-known'`;`if (url.pathname === '/pset/' || url.pathname === '/pset') {` 之前加:

```ts
    const wk = wellKnown(url.pathname, env)
    if (wk) return wk
```

- [ ] **Step 4: 跑**

Run: `cd apps/relay && bun run typecheck && bun run test && cd -`
Expected: PASS(含原有 `entry.test.ts`)

- [ ] **Step 5: 维护文档** —— `docs/maintainer/relay.md`:
- §4 Worker secrets 那行的名字列表末尾加 `、`ANDROID_CERT_SHA256`(可选;逗号分隔的安卓签名 SHA-256,见 §9)`。
- 文件末尾加:

```markdown
## 9. 通用链接 / App Links(plan 7a)

- Worker 在两个主机上都发 `/.well-known/apple-app-site-association`(appID `9Y6JAPDP7A.com.tendhearth.app`,只覆盖 `/pset`、`/pset/*`)与 `/.well-known/assetlinks.json`(`com.tendhearth.app`)。代码 `apps/relay/src/well-known.ts`。
- 安卓指纹:Play Console → 应用完整性 → 应用签名密钥证书的 SHA-256(EAS / 上传密钥的也加上),逗号分隔:`bunx wrangler secret put ANDROID_CERT_SHA256 --env staging`(production 同理)。没设时 assetlinks 是 `[]`,安卓扫码照旧开网页壳。
- 自查:`curl -sI https://relay.tendhearth.com/.well-known/apple-app-site-association`(200、`application/json`、无重定向);`curl -s https://relay.tendhearth.com/.well-known/assetlinks.json`。Apple 走自己的 CDN 缓存 AASA,改完可能要等;开发构建可在设备「开发者 → 关联域名开发」里绕过。
```

- [ ] **Step 6: 根回路**

Run: `bun run typecheck && bun run test`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add apps/relay/src/well-known.ts apps/relay/test/well-known.test.ts apps/relay/src/index.ts apps/relay/src/env.d.ts docs/maintainer/relay.md
git commit -m "配对体验 Task 7:中继发 AASA 与 assetlinks(安卓指纹走 Worker secret,没设就空表)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: app 声明关联域名(iOS)与 App Links(安卓)

**Files:**
- Create: `apps/app/plugins/with-app-links.js`
- Create: `apps/app/plugins/app-links.test.ts`
- Modify: `apps/app/app.config.js`
- Modify: `apps/app/plugins/app-config.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces(`apps/app/plugins/with-app-links.js`,CommonJS):
  - `PROD_HOST = 'relay.tendhearth.com'`、`STAGING_HOST = 'relay-staging.tendhearth.com'`
  - `linkHosts(dev: boolean): string[]`、`associatedDomains(dev: boolean): string[]`
  - `applyAssociatedDomains(plist: object, dev: boolean): object`
  - `androidIntentFilters(dev: boolean): object[]`
  - 默认导出插件 `withAppLinks(config, { dev })`(只写 iOS entitlements)
- `app.config.js`:`dev = apnsEnv !== 'production'`;`plugins` 加 `['./plugins/with-app-links', { dev }]`;`android.intentFilters = androidIntentFilters(dev)`。

- [ ] **Step 1: 写失败的测试** `apps/app/plugins/app-links.test.ts`

```ts
import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'

const require = createRequire(import.meta.url)
const links = require('./with-app-links.js') as {
  PROD_HOST: string; STAGING_HOST: string
  linkHosts(dev: boolean): string[]; associatedDomains(dev: boolean): string[]
  applyAssociatedDomains(plist: Record<string, unknown>, dev: boolean): Record<string, unknown>
  androidIntentFilters(dev: boolean): unknown[]
}

describe('with-app-links(spec §6.2)', () => {
  it('发布构建只认生产中继;开发构建再加 staging', () => {
    expect(links.associatedDomains(false)).toEqual(['applinks:relay.tendhearth.com'])
    expect(links.associatedDomains(true)).toEqual(['applinks:relay.tendhearth.com', 'applinks:relay-staging.tendhearth.com'])
  })
  it('entitlements:写 associated-domains,别的键原样留着(钥匙串组归 with-ios-notify)', () => {
    const out = links.applyAssociatedDomains({ 'keychain-access-groups': ['x'] }, false)
    expect(out).toEqual({ 'keychain-access-groups': ['x'], 'com.apple.developer.associated-domains': ['applinks:relay.tendhearth.com'] })
  })
  it('安卓:autoVerify 的 https VIEW,只覆盖 /pset', () => {
    expect(links.androidIntentFilters(false)).toEqual([{
      action: 'VIEW', autoVerify: true, category: ['BROWSABLE', 'DEFAULT'],
      data: [{ scheme: 'https', host: 'relay.tendhearth.com', path: '/pset' }, { scheme: 'https', host: 'relay.tendhearth.com', pathPrefix: '/pset/' }],
    }])
    const dev = links.androidIntentFilters(true) as Array<{ data: Array<{ host: string }> }>
    expect(dev[0]!.data.map(d => d.host)).toEqual(['relay.tendhearth.com', 'relay.tendhearth.com', 'relay-staging.tendhearth.com', 'relay-staging.tendhearth.com'])
  })
})
```

`apps/app/plugins/app-config.test.ts`:第一个用例(默认 = 开发)末尾加:

```ts
    expect(c.plugins).toContainEqual(['./plugins/with-app-links', { dev: true }])
    expect(c.android.intentFilters).toEqual(require('./with-app-links.js').androidIntentFilters(true))
    expect(c.ios.associatedDomains).toBeUndefined()   // 关联域名只由插件写(与钥匙串组同一约定)
```

第二个用例(`TENDHEARTH_APNS_ENV=production`)末尾加:

```ts
    expect(c.plugins).toContainEqual(['./plugins/with-app-links', { dev: false }])
    expect(c.android.intentFilters).toEqual(require('./with-app-links.js').androidIntentFilters(false))
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bun x vitest run plugins/app-links.test.ts plugins/app-config.test.ts`
Expected: FAIL(`Cannot find module './with-app-links.js'`)

- [ ] **Step 3: 实现**

`apps/app/plugins/with-app-links.js`:

```js
// 通用链接 / App Links(spec 2026-10-01-tendhearth-pairing-ux §6.2):系统相机扫桌面「连接手机」的码 ⇒ 打开 app 的配对确认卡。
// iOS 的 associated-domains 是 entitlement,按 app.config.js 的约定只由插件写;安卓的 intentFilters 是普通配置,由 app.config.js 用这里导出的同一份主机表设置。
// 开发构建(APNs 沙盒)多认 staging 中继。只覆盖 /pset,别的路径照旧开浏览器。
const { withEntitlementsPlist } = require('expo/config-plugins')

const PROD_HOST = 'relay.tendhearth.com'
const STAGING_HOST = 'relay-staging.tendhearth.com'

const linkHosts = dev => (dev ? [PROD_HOST, STAGING_HOST] : [PROD_HOST])
const associatedDomains = dev => linkHosts(dev).map(h => `applinks:${h}`)
const applyAssociatedDomains = (plist, dev) => ({ ...plist, 'com.apple.developer.associated-domains': associatedDomains(dev) })
const androidIntentFilters = dev => [{
  action: 'VIEW',
  autoVerify: true,
  category: ['BROWSABLE', 'DEFAULT'],
  data: linkHosts(dev).flatMap(host => [{ scheme: 'https', host, path: '/pset' }, { scheme: 'https', host, pathPrefix: '/pset/' }]),
}]

const withAppLinks = (config, { dev = false } = {}) =>
  withEntitlementsPlist(config, c => {
    c.modResults = applyAssociatedDomains(c.modResults, dev)
    return c
  })

module.exports = withAppLinks
module.exports.PROD_HOST = PROD_HOST
module.exports.STAGING_HOST = STAGING_HOST
module.exports.linkHosts = linkHosts
module.exports.associatedDomains = associatedDomains
module.exports.applyAssociatedDomains = applyAssociatedDomains
module.exports.androidIntentFilters = androidIntentFilters
```

`apps/app/app.config.js`:
- 顶部注释加一行 `// - 通用链接 / App Links:开发构建(apnsEnv=development)多认 staging 中继(plugins/with-app-links.js)`。
- `require('./plugins/with-ios-notify')` 下一行加 `const { androidIntentFilters } = require('./plugins/with-app-links')`。
- `const apnsEnv = …` 下一行加 `const dev = apnsEnv !== 'production'`。
- `android: { ...config.android, ...(gs ? { googleServicesFile: gs } : {}) },` 改成 `android: { ...config.android, intentFilters: androidIntentFilters(dev), ...(gs ? { googleServicesFile: gs } : {}) },`。
- `plugins` 数组 `'./plugins/with-ios-scene',` 之后加 `['./plugins/with-app-links', { dev }],`。

- [ ] **Step 4: 跑**

Run: `cd apps/app && bun run test && bun run typecheck && bun run export:check && cd -`
Expected: 全绿(export:check 能跑完说明插件在 prebuild 前的配置阶段不报错)

- [ ] **Step 5: Commit**

```bash
git add apps/app/plugins/with-app-links.js apps/app/plugins/app-links.test.ts apps/app/app.config.js apps/app/plugins/app-config.test.ts
git commit -m "配对体验 Task 8:app 声明关联域名(iOS)与 autoVerify 的 App Links(安卓),只覆盖 /pset

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 系统链接进 app → 配对确认卡(含锚点兜底与文案改名)

**Files:**
- Create: `apps/app/src/net/system-link.ts`、`apps/app/src/net/system-link.test.ts`
- Modify: `apps/app/src/push/open.ts`、`apps/app/src/push/open.test.ts`
- Modify: `apps/app/src/view/pair.ts`、`apps/app/src/view/pair.test.ts`
- Modify: `apps/app/src/app/pair.tsx`
- Modify: `apps/app/src/i18n/zh-Hans.ts`、`apps/app/src/i18n/en.ts`、`apps/app/src/i18n/i18n.test.ts`
- Modify: `apps/app/src/net/link.ts`(注释)、`apps/app/src/net/link.test.ts`(用例名)
- Create: `apps/app/.maestro/pair-link.yaml`;Modify: `apps/app/.maestro/pair-invalid.yaml`

**Interfaces:**
- Consumes: `parsePairLink`、`ParsedLink`、`LinkError`(`../net/link`);`linkErrorKey`(`./pair`);`expo-linking` 的 `getLinkingURL()`。
- Produces:
  - `src/net/system-link.ts`:`systemPairLink(url: string, dev: boolean): string | null`、`setPendingLink(raw: string): void`、`takePendingLink(): string | null`
  - `rewriteSystemPath(path: string, dev: boolean, stash?: (raw: string) => void): string`(命中配对链接 ⇒ `/pair?from=link&n=<序号>`)
  - `src/view/pair.ts`:`linkIntake(cands: Array<string | null | undefined>): { ok: true; link: ParsedLink } | { ok: false; key: MessageKey }`、`acceptsIncomingLink(phase: 'intro' | 'scan' | 'confirm' | 'working' | 'error'): boolean`
  - 新文案键:`pair.errLinkIncomplete`(本任务);`welcome.howTo`、`welcome.stale` 留给 Task 10

- [ ] **Step 1: 写失败的测试**

`apps/app/src/net/system-link.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { setPendingLink, systemPairLink, takePendingLink } from './system-link'

const FRAG = `#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`

describe('systemPairLink(spec §6.3、D7)', () => {
  it('生产中继的 /pset 链接 ⇒ 规范化的 https 链接(锚点原样)', () => {
    expect(systemPairLink(`https://relay.tendhearth.com/pset/${FRAG}`, false)).toBe(`https://relay.tendhearth.com/pset/${FRAG}`)
    expect(systemPairLink(`https://Relay.Tendhearth.com/pset${FRAG}`, false)).toBe(`https://relay.tendhearth.com/pset/${FRAG}`)
  })
  it('锚点丢了也认出来(交给配对页说「没带全」)', () => {
    expect(systemPairLink('https://relay.tendhearth.com/pset/', false)).toBe('https://relay.tendhearth.com/pset/')
  })
  it('staging 与自定义 scheme 只在开发构建', () => {
    expect(systemPairLink(`https://relay-staging.tendhearth.com/pset/${FRAG}`, false)).toBeNull()
    expect(systemPairLink(`https://relay-staging.tendhearth.com/pset/${FRAG}`, true)).toBe(`https://relay-staging.tendhearth.com/pset/${FRAG}`)
    expect(systemPairLink(`tendhearth://relay.tendhearth.com/pset/${FRAG}`, false)).toBeNull()
    expect(systemPairLink(`tendhearth://relay.tendhearth.com/pset/${FRAG}`, true)).toBe(`https://relay.tendhearth.com/pset/${FRAG}`)
  })
  it('别的主机、别的路径、带查询串 ⇒ null', () => {
    expect(systemPairLink(`https://evil.example/pset/${FRAG}`, true)).toBeNull()
    expect(systemPairLink('https://relay.tendhearth.com/healthz', false)).toBeNull()
    expect(systemPairLink(`https://relay.tendhearth.com/pset/?x=1${FRAG}`, false)).toBeNull()
    expect(systemPairLink('tendhearth://push-open?kind=task_done&taskId=a1b2c3d4', true)).toBeNull()
  })
})

describe('暂存一格,取后即焚(令牌不进路由参数)', () => {
  it('取一次就没了;新的覆盖旧的', () => {
    expect(takePendingLink()).toBeNull()
    setPendingLink('a'); setPendingLink('b')
    expect(takePendingLink()).toBe('b')
    expect(takePendingLink()).toBeNull()
  })
})
```

`apps/app/src/push/open.test.ts` 追加:

```ts
describe('rewriteSystemPath —— 配对链接(plan 7a)', () => {
  const FRAG = `#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`
  it('通用链接 ⇒ 暂存原链接,去配对页(路由参数里没有令牌);每次序号不同', () => {
    const got: string[] = []
    const a = rewriteSystemPath(`https://relay.tendhearth.com/pset/${FRAG}`, false, r => got.push(r))
    const b = rewriteSystemPath(`https://relay.tendhearth.com/pset/${FRAG}`, false, r => got.push(r))
    expect(a).toMatch(/^\/pair\?from=link&n=\d+$/)
    expect(b).not.toBe(a)
    expect(a).not.toContain('t0000')
    expect(got).toEqual([`https://relay.tendhearth.com/pset/${FRAG}`, `https://relay.tendhearth.com/pset/${FRAG}`])
  })
  it('发布构建不认 staging / 自定义 scheme 的配对链接(原样放行给路由)', () => {
    const got: string[] = []
    expect(rewriteSystemPath(`tendhearth://relay.tendhearth.com/pset/${FRAG}`, false, r => got.push(r))).not.toMatch(/^\/pair/)
    expect(got).toEqual([])
  })
})
```

`apps/app/src/view/pair.test.ts` 追加(顶部 import 加 `acceptsIncomingLink, linkIntake`):

```ts
describe('linkIntake(系统链接 → 确认卡)', () => {
  const OK = `https://relay.tendhearth.com/pset/#id=r${'a'.repeat(26)}&t=t${'0'.repeat(32)}&p=%2Fset`
  it('第一个能解析的胜出', () => {
    const r = linkIntake([null, 'https://relay.tendhearth.com/pset/', OK])
    expect(r.ok && r.link.relayHost).toBe('relay.tendhearth.com')
  })
  it('都没锚点 / 都是空 ⇒ 「没带全」', () => {
    expect(linkIntake(['https://relay.tendhearth.com/pset/', null])).toEqual({ ok: false, key: 'pair.errLinkIncomplete' })
    expect(linkIntake([null, undefined])).toEqual({ ok: false, key: 'pair.errLinkIncomplete' })
  })
  it('锚点在但内容坏了 ⇒ 坏链接', () => {
    expect(linkIntake(['https://relay.tendhearth.com/pset/#id=nope&t=x'])).toEqual({ ok: false, key: 'pair.errBadLink' })
  })
})

describe('acceptsIncomingLink(Review Focus 5)', () => {
  it('正在配对时不接新链接;其余都接', () => {
    expect(acceptsIncomingLink('working')).toBe(false)
    for (const k of ['intro', 'scan', 'confirm', 'error'] as const) expect(acceptsIncomingLink(k)).toBe(true)
  })
})
```

`apps/app/src/i18n/i18n.test.ts` 追加:

```ts
  it('桌面入口统一叫「连接手机」(plan 7a):旧叫法一个不留', () => {
    for (const [k, v] of Object.entries(zh)) expect(v, k).not.toMatch(/手机上用|配对手机|出门也能用/)
    for (const [k, v] of Object.entries(en)) expect(v, k).not.toMatch(/Use on phone|Pair phone|Use when away/)
    expect(zh['pair.step2']).toBe('选择「连接手机」')
    expect(en['pair.step2']).toBe('Choose “Connect phone”')
    expect(zh['pair.errExpired']).toContain('只能用一次')
  })
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bun x vitest run src/net/system-link.test.ts src/push/open.test.ts src/view/pair.test.ts src/i18n/i18n.test.ts`
Expected: FAIL(模块不存在 / 文案不符)

- [ ] **Step 3: 实现**

`apps/app/src/net/system-link.ts`:

```ts
// 系统交给 app 的配对链接(spec 2026-10-01-tendhearth-pairing-ux §6.3)。纯逻辑:不 import react / expo。
// 发布构建只认 https://relay.tendhearth.com/pset…;开发构建再认 staging 主机与 tendhearth://<主机>/pset/#…(D7,给模拟器 / Maestro)。
// 令牌在锚点里,不进路由参数:rewriteSystemPath 把原链接放进这一格,配对页取走即焚。

const PROD = 'relay.tendhearth.com'
const STAGING = 'relay-staging.tendhearth.com'
const SYS_RE = /^(https|tendhearth):\/\/([a-z0-9.-]+)\/pset\/?(#.*)?$/i

export function systemPairLink(url: string, dev: boolean): string | null {
  const m = SYS_RE.exec(url.trim())
  if (!m) return null
  const scheme = m[1]!.toLowerCase()
  const host = m[2]!.toLowerCase()
  if (scheme === 'tendhearth' && !dev) return null
  if (host !== PROD && !(dev && host === STAGING)) return null
  return `https://${host}/pset/${m[3] ?? ''}`
}

let pending: string | null = null
export function setPendingLink(raw: string): void { pending = raw }
export function takePendingLink(): string | null {
  const p = pending
  pending = null
  return p
}
```

`apps/app/src/push/open.ts`:import 区加 `import { setPendingLink, systemPairLink } from '../net/system-link'`;`rewriteSystemPath` 换成先判配对链接:

```ts
let pairSeq = 0
export function rewriteSystemPath(path: string, dev: boolean, stash: (raw: string) => void = setPendingLink): string {
  // 配对链接(plan 7a):原链接进暂存格(令牌不进路由参数),去配对页;序号让 app 已在配对页时也能重新触发。
  const pair = systemPairLink(path, dev)
  if (pair !== null) { stash(pair); pairSeq += 1; return `/pair?from=link&n=${pairSeq}` }
  const rest = path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/+/, '')
  const q = rest.indexOf('?')
  // 路由比较忽略大小写与结尾斜杠(路由器匹配也宽松,别让 Dev-Push-Key/ 绕过)。
  const route = (q < 0 ? rest : rest.slice(0, q)).split('#')[0]!.replace(/\/+$/, '').toLowerCase()
  if (route === 'dev-push-key') return dev ? path : '/'
  if (route !== 'push-open') return path
  const query = q < 0 ? '' : rest.slice(q + 1).split('#')[0]!
  let target
  try {
    const sp = new URLSearchParams(query)
    target = targetFromParams({ kind: sp.get('kind') ?? undefined, taskId: sp.get('taskId') ?? undefined, requestId: sp.get('requestId') ?? undefined })
  } catch {
    return '/'
  }
  return target?.taskId ? pushOpenHref(target) : '/'
}
```

(`const rest` 起往下与原函数逐行相同;文件头注释「其余路径原样放行」前加一句「配对链接 ⇒ 原链接进暂存格、去 /pair?from=link」。)

`apps/app/src/view/pair.ts` 追加(import 区加 `import { parsePairLink, type ParsedLink } from '../net/link'`,并把已有的 `import type { LinkError } from '../net/link'` 合进去):

```ts
/**
 * 系统链接 → 确认卡(spec §6.3):候选依次是暂存格里的原链接、expo-linking 的 getLinkingURL()(兜底)。
 * 第一个能解析的胜出;都解析不了且没有一个是「锚点在但坏了」⇒ 「没带全」(用 app 内扫码再扫一次)。
 */
export function linkIntake(cands: Array<string | null | undefined>): { ok: true; link: ParsedLink } | { ok: false; key: MessageKey } {
  let worst: LinkError | null = null
  for (const c of cands) {
    if (!c) continue
    const r = parsePairLink(c)
    if (r.ok) return r
    if (r.error !== 'not_a_link') worst = r.error
  }
  return { ok: false, key: worst ? linkErrorKey(worst) : 'pair.errLinkIncomplete' }
}

/** 正在配对(working)时来的新链接不打断当前流程(Review Focus 5)。 */
export function acceptsIncomingLink(phase: 'intro' | 'scan' | 'confirm' | 'working' | 'error'): boolean {
  return phase !== 'working'
}
```

`apps/app/src/app/pair.tsx`:
- import 区:`import * as Linking from 'expo-linking'`;`import { Stack, useLocalSearchParams, useRouter } from 'expo-router'`;`import { systemPairLink, takePendingLink } from '../net/system-link'`;`import { acceptsIncomingLink, linkErrorKey, linkIntake, makeGate, pairErrorKey } from '../view/pair'`。
- 在 `const gate = useRef(makeGate()).current` 之后加:

```tsx
  // 系统相机扫码 / 通用链接进来(spec §6.3):只到确认卡,永不自动配对;正在配对时不打断。
  const { from, n } = useLocalSearchParams<{ from?: string; n?: string }>()
  const phaseRef = useRef(phase.k)
  phaseRef.current = phase.k
  useEffect(() => {
    if (from !== 'link' || gate.busy() || !acceptsIncomingLink(phaseRef.current)) return
    let fallback: string | null = null
    try { const u = Linking.getLinkingURL(); fallback = u ? systemPairLink(u, __DEV__) : null } catch { fallback = null }
    const r = linkIntake([takePendingLink(), fallback])
    setPhase(r.ok ? { k: 'confirm', link: r.link } : { k: 'error', key: r.key })
  }, [from, n, gate])
```

`apps/app/src/i18n/zh-Hans.ts` / `en.ts`:按 spec §9 改 `pair.steps`、`pair.step2`、`pair.errNotALink`、`pair.errRemoteOff`、`pair.errExpired`,新增 `pair.errLinkIncomplete`(值逐字取 spec §9 表)。

`apps/app/src/net/link.ts:12` 注释「桌面「手机上用」二维码」改成「桌面「连接手机」二维码」;`link.test.ts:27` 用例名「电脑没开「出门也能用」时的局域网链接」改成「只能在同一 Wi-Fi 下用的老链接」。

`apps/app/.maestro/pair-invalid.yaml`:首行注释的「「打开出门也能用」提示」改成「「扫新出来的码」提示」;最后的 `visible:` 改成 `".*同一 Wi-Fi 下用的旧链接.*|.*older Wi-Fi-only link.*"`。

`apps/app/.maestro/pair-link.yaml`:

```yaml
# 系统链接进配对页(plan 7a,开发构建;D7 的自定义 scheme 走与通用链接同一条 JS 链路):
# 打开配对链接 ⇒ 确认卡出现、显示中继主机;没有自动配对(「连接」按钮还在,没进「正在连接」)。
# 再开一个锚点丢了的链接 ⇒ 「没带全」提示。真机的 https 通用链接见计划 Task 12。
appId: com.tendhearth.app
---
- runFlow: subflows/_start.yaml
- openLink: "tendhearth://relay.tendhearth.com/pset/#id=raaaaaaaaaaaaaaaaaaaaaaaaaa&t=t00000000000000000000000000000000&p=%2Fset"
- runFlow: subflows/_open-link-guard.yaml
- extendedWaitUntil:
    visible:
      id: pair-confirm
    timeout: 10000
- assertVisible: ".*relay\\.tendhearth\\.com.*"
- assertVisible:
    id: pair-connect
- assertNotVisible: ".*正在连接.*|.*Connecting….*"
- openLink: "tendhearth://relay.tendhearth.com/pset/"
- runFlow: subflows/_open-link-guard.yaml
- extendedWaitUntil:
    visible: ".*没带全.*|.*arrived incomplete.*"
    timeout: 10000
```

(注:`raaa…` 是 `r` + 26 个 `a`,`t000…` 是 `t` + 32 个 `0`,与单测里的形状一致。)

- [ ] **Step 4: 跑**

Run: `cd apps/app && bun run test && bun run typecheck && bun run export:check && cd -`
Expected: 全绿

- [ ] **Step 5: Maestro(模拟器上装好开发构建)**

Run: `cd apps/app && maestro test .maestro/pair-link.yaml && maestro test .maestro/pair-invalid.yaml && cd -`
Expected: 两个流 PASS。若 `pair-link.yaml` 卡在「没带全」而不是确认卡:说明锚点在 JS 之前就丢了 —— 回到 Task 1 的结论表,把对应行改成「丢失(真机 / 模拟器)」,兜底分支(「没带全」+ app 内扫码)已经在,本任务照样提交。

- [ ] **Step 6: Commit**

```bash
git add apps/app/src/net/system-link.ts apps/app/src/net/system-link.test.ts apps/app/src/push/open.ts apps/app/src/push/open.test.ts apps/app/src/view/pair.ts apps/app/src/view/pair.test.ts apps/app/src/app/pair.tsx apps/app/src/i18n/zh-Hans.ts apps/app/src/i18n/en.ts apps/app/src/i18n/i18n.test.ts apps/app/src/net/link.ts apps/app/src/net/link.test.ts apps/app/.maestro/pair-link.yaml apps/app/.maestro/pair-invalid.yaml
git commit -m "配对体验 Task 9:系统相机扫码 / 通用链接直达配对确认卡(令牌不进路由、锚点丢了有兜底、配对中不打断);入口统一叫「连接手机」

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 重装 / 换机后的启动核验(过期配对诚实地回欢迎页)

**Files:**
- Modify: `apps/app/src/state/wiring.ts`、`apps/app/src/state/wiring.test.ts`
- Modify: `apps/app/src/state/BackendProvider.tsx`、`apps/app/src/state/session.tsx`、`apps/app/src/app/_layout.tsx`、`apps/app/src/app/welcome.tsx`
- Modify: `apps/app/src/i18n/zh-Hans.ts`、`apps/app/src/i18n/en.ts`
- Modify: `apps/app/plugins/native-guards.test.ts`

**Interfaces:**
- Consumes: `Backend`(`connection` / `onConnection` / `devices`)、`Connection`、`INITIAL_CONNECTION`、`clearStored`、`quietly`。
- Produces:
  - `watchConnection(backend, store, onRevoked: () => void, onStale?: () => void): Unsubscribe` —— 这次还没 `online` 过就 `revoked` ⇒ `onStale`(给了的话),否则 `onRevoked`
  - `verifyLaunch(backend: Pick<Backend, 'devices'>, deviceId: string): Promise<'ok' | 'stale' | 'unknown'>`
  - `watchLaunch(backend: Pick<Backend, 'connection' | 'onConnection' | 'devices'>, deviceId: string, onStale: () => void): Unsubscribe`
  - `Session.forgetStale(): void`、`Session.staleNotice: boolean`
  - `BackendProvider` 新 prop `onStale?(): void`
  - 文案键 `welcome.howTo`、`welcome.stale`;testID `welcome-how-to`、`welcome-stale`

- [ ] **Step 1: 写失败的测试** —— `apps/app/src/state/wiring.test.ts` 追加(import 加 `verifyLaunch, watchLaunch`,以及 `INITIAL_CONNECTION` 来自 `'../net/connection'`):

```ts
describe('启动核验(spec §7、D8)', () => {
  type Conn = { state: 'connecting' | 'online' | 'offline' | 'revoked'; lastSyncedAt: number | null; epoch: number }
  function fakeBackend(devices: () => Promise<Array<{ id: string; current: boolean; created_at: string; last_seen_at: string }>>) {
    let c: Conn = { state: 'connecting', lastSyncedAt: null, epoch: 0 }
    const subs = new Set<(c: Conn) => void>()
    return {
      connection: () => c,
      onConnection: (cb: (c: Conn) => void) => { subs.add(cb); return () => { subs.delete(cb) } },
      devices,
      emit(next: Partial<Conn>) { c = { ...c, ...next }; for (const s of subs) s(c) },
      subs,
    }
  }
  const row = (id: string, current: boolean) => ({ id, current, created_at: 'x', last_seen_at: 'x' })

  it('启动时从不先画「在线」', () => {
    expect(INITIAL_CONNECTION.state).toBe('connecting')
  })
  it('verifyLaunch:这台的 id 对上 ⇒ ok;对不上 / 没有这台 ⇒ stale;读失败 ⇒ unknown', async () => {
    expect(await verifyLaunch({ devices: async () => [row('aa11bb22', true)] } as never, 'aa11bb22')).toBe('ok')
    expect(await verifyLaunch({ devices: async () => [row('ffffffff', true)] } as never, 'aa11bb22')).toBe('stale')
    expect(await verifyLaunch({ devices: async () => [row('aa11bb22', false)] } as never, 'aa11bb22')).toBe('stale')
    expect(await verifyLaunch({ devices: async () => { throw new Error('timeout') } } as never, 'aa11bb22')).toBe('unknown')
  })
  it('watchLaunch:第一次 online 才核对,只核对一次;对不上 ⇒ onStale', async () => {
    const b = fakeBackend(async () => [row('ffffffff', true)])
    const onStale = vi.fn()
    watchLaunch(b as never, 'aa11bb22', onStale)
    b.emit({ state: 'offline' })
    expect(onStale).not.toHaveBeenCalled()
    b.emit({ state: 'online', epoch: 1 })
    b.emit({ state: 'online', epoch: 2 })
    await vi.waitFor(() => expect(onStale).toHaveBeenCalledTimes(1))
  })
  it('watchLaunch:电脑不在线 / 读设备失败 ⇒ 不清(Review Focus 4);取消订阅后结果作废', async () => {
    const onStale = vi.fn()
    const offline = fakeBackend(async () => [row('aa11bb22', true)])
    watchLaunch(offline as never, 'aa11bb22', onStale)
    offline.emit({ state: 'offline' })
    const failing = fakeBackend(async () => { throw new Error('timeout') })
    watchLaunch(failing as never, 'aa11bb22', onStale)
    failing.emit({ state: 'online', epoch: 1 })
    let release!: () => void
    const slow = fakeBackend(() => new Promise(r => { release = () => r([row('ffffffff', true)]) }))
    const off = watchLaunch(slow as never, 'aa11bb22', onStale)
    slow.emit({ state: 'online', epoch: 1 })
    off()
    release()
    await new Promise(r => setTimeout(r, 0))
    expect(onStale).not.toHaveBeenCalled()
  })
  it('watchConnection:还没连上过就被拒 ⇒ onStale;连上过之后被拒 ⇒ onRevoked(维持现状)', () => {
    const store = { revalidateAll: vi.fn() }
    const a = fakeBackend(async () => [])
    const r1 = vi.fn(), s1 = vi.fn()
    watchConnection(a as never, store, r1, s1)
    a.emit({ state: 'revoked' })
    expect([r1.mock.calls.length, s1.mock.calls.length]).toEqual([0, 1])
    const b = fakeBackend(async () => [])
    const r2 = vi.fn(), s2 = vi.fn()
    watchConnection(b as never, store, r2, s2)
    b.emit({ state: 'online', epoch: 1 })
    b.emit({ state: 'revoked' })
    expect([r2.mock.calls.length, s2.mock.calls.length]).toEqual([1, 0])
  })
})
```

`apps/app/plugins/native-guards.test.ts` 追加:

```ts
describe('恢复配对的前提(spec §7)', () => {
  it('iOS:配对记录用 AFTER_FIRST_UNLOCK(随加密备份 / 设备迁移走),不是 THIS_DEVICE_ONLY', () => {
    const src = read(here, '..', 'src', 'net', 'secure-store.ts')
    expect(src).toContain('keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }')
    expect(src).not.toContain('THIS_DEVICE_ONLY')
  })
  it('安卓:expo-secure-store 的备份规则把 SecureStore 排除在外 ⇒ 7a 不承诺安卓恢复(以后走 Block Store)', () => {
    const xml = join(pkgDir('expo-secure-store'), 'android', 'src', 'main', 'res', 'xml')
    expect(read(xml, 'secure_store_backup_rules.xml')).toContain('<exclude domain="sharedpref" path="SecureStore"/>')
    expect(read(xml, 'secure_store_data_extraction_rules.xml')).toContain('<exclude domain="sharedpref" path="SecureStore"/>')
  })
})
```

`apps/app/src/i18n/i18n.test.ts` 追加:

```ts
  it('欢迎页的两句(plan 7a)', () => {
    expect(zh['welcome.howTo']).toBe('在电脑上点「连接手机」，用相机扫一下。')
    expect(en['welcome.howTo']).toBe('On your computer, choose “Connect phone” and scan with your camera.')
    expect(zh['welcome.stale']).toBe('这台手机和电脑的配对已经失效了。')
    expect(en['welcome.stale']).toBe('This phone is no longer paired with your computer.')
  })
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bun x vitest run src/state/wiring.test.ts plugins/native-guards.test.ts src/i18n/i18n.test.ts`
Expected: FAIL(`verifyLaunch` / `watchLaunch` 未导出;文案键缺失;native-guards 两条应当 PASS —— 它们钉的是现状)

- [ ] **Step 3: 实现**

`apps/app/src/state/wiring.ts`:import 区加 `import type { Connection } from '../backend/types'`(与已有的 `Backend, Unsubscribe` 合并);`watchConnection` 换成:

```ts
/**
 * 重连(epoch 前进)⇒ store 全部查询重新验证(只重拉读,草稿与提交从不自动发);撤销 ⇒ onRevoked(只一次)。
 * 这次启动还没连上过就被拒(恢复回来的旧配对,D8)⇒ onStale(给了的话)。回调里只碰钥匙串 / 会话。
 */
export function watchConnection(backend: Backend, store: { revalidateAll(): void }, onRevoked: () => void, onStale?: () => void): Unsubscribe {
  let prev = backend.connection()
  let told = false
  let everOnline = prev.state === 'online'
  return backend.onConnection(c => {
    if (shouldRevalidate(prev, c)) store.revalidateAll()
    if (c.state === 'online') everOnline = true
    if (c.state === 'revoked' && !told) {
      told = true
      if (!everOnline && onStale) onStale()
      else onRevoked()
    }
    prev = c
  })
}

/** 启动核验(spec §7、D8):「这台」的 id 必须就是记录里的 deviceId。对不上 / 没有「这台」⇒ stale;读失败 ⇒ unknown(不下结论)。 */
export async function verifyLaunch(backend: Pick<Backend, 'devices'>, deviceId: string): Promise<'ok' | 'stale' | 'unknown'> {
  let list
  try { list = await backend.devices() } catch { return 'unknown' }
  const me = list.find(d => d.current)
  return me && me.id === deviceId ? 'ok' : 'stale'
}

/** 这次启动第一次 online 时核对一次;对不上 ⇒ onStale。电脑不在线不核对(分不清关机还是失效)。取消订阅后在飞的结果作废。 */
export function watchLaunch(backend: Pick<Backend, 'connection' | 'onConnection' | 'devices'>, deviceId: string, onStale: () => void): Unsubscribe {
  let checked = false
  let cancelled = false
  const check = (c: Connection) => {
    if (checked || c.state !== 'online') return
    checked = true
    void verifyLaunch(backend, deviceId).then(v => { if (v === 'stale' && !cancelled) onStale() })
  }
  check(backend.connection())
  const off = backend.onConnection(check)
  return () => { cancelled = true; off() }
}
```

`apps/app/src/state/BackendProvider.tsx`:
- import 改成 `import { backendFor, watchConnection, watchLaunch } from './wiring'`。
- props 加 `onStale?(): void`(签名里 `onRevoked(): void` 之后)。
- `const revoked = useRef(onRevoked)` 下面加 `const stale = useRef(onStale); stale.current = onStale`。
- `useEffect(() => watchConnection(value.backend, value.store, () => revoked.current()), [value])` 换成:

```tsx
  useEffect(() => watchConnection(value.backend, value.store, () => revoked.current(), () => (stale.current ?? revoked.current)()), [value])
  // 启动核验(D8):有配对、真后端时,这次第一次连上就核对「这台」。
  useEffect(() => {
    if (!pairing || value.backend.mode !== 'live') return
    return watchLaunch(value.backend, pairing.deviceId, () => (stale.current ?? revoked.current)())
  }, [value, pairing])
```

`apps/app/src/state/session.tsx`:
- `Session` 类型里 `forgetPairing()` 之后加:

```ts
  /** 启动核验发现配对已失效(恢复回来的旧记录,D8):清钥匙串与内存,回欢迎页并说明。 */
  forgetStale(): void
  staleNotice: boolean
```

- 状态:`const [staleNotice, setStale] = useState(false)`。
- `value` 里:`setPaired` 改成 `async setPaired(r) { await store.save(r); setPairing(r); setSeen(true); setStale(false) },`;加 `forgetStale() { quietly(clearStored(store, push), 'clear'); setPairing(null); setSeen(false); setStale(true) },`、`staleNotice,`;依赖数组加 `staleNotice`。

`apps/app/src/app/_layout.tsx`:`<BackendProvider lang={lang} pairing={session.pairing} onRevoked={session.dropStoredPairing}>` 改成加 `onStale={session.forgetStale}`。

`apps/app/src/app/welcome.tsx`:`const { markWelcomeSeen } = useSession()` 改成 `const { markWelcomeSeen, staleNotice } = useSession()`;`welcome.body` 那行之后加:

```tsx
        {staleNotice ? <Txt testID="welcome-stale" role="body" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'welcome.stale')}</Txt> : null}
```

底部按钮区 `welcome-pair` 按钮之前加:

```tsx
        <Txt testID="welcome-how-to" role="meta" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'welcome.howTo')}</Txt>
```

`zh-Hans.ts` / `en.ts`:新增 `welcome.howTo`、`welcome.stale`(值见 spec §9)。

- [ ] **Step 4: 跑**

Run: `cd apps/app && bun run test && bun run typecheck && bun run export:check && cd -`
Expected: 全绿

- [ ] **Step 5: Maestro 冒烟(开发构建)**

Run: `cd apps/app && maestro test .maestro/pair-invalid.yaml && maestro test .maestro/demo-walkthrough.yaml && cd -`
Expected: PASS(欢迎页多了一行说明,不影响既有流程)

- [ ] **Step 6: Commit**

```bash
git add apps/app/src/state/wiring.ts apps/app/src/state/wiring.test.ts apps/app/src/state/BackendProvider.tsx apps/app/src/state/session.tsx apps/app/src/app/_layout.tsx apps/app/src/app/welcome.tsx apps/app/src/i18n/zh-Hans.ts apps/app/src/i18n/en.ts apps/app/src/i18n/i18n.test.ts apps/app/plugins/native-guards.test.ts
git commit -m "配对体验 Task 10:恢复回来的配对先核对 —— 失效就清掉、回欢迎页说明;欢迎页写明「在电脑上点连接手机」

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 重新配对时退掉旧设备位(旧令牌自己 `unpair_self`)

**Files:**
- Modify: `apps/app/src/net/pairing.ts`、`apps/app/src/net/pairing.test.ts`
- Modify: `apps/app/src/app/pair.tsx`
- Create: `src/daemon/settings-panel-retire.test.ts`

**Interfaces:**
- Consumes: `PairingRecord`、`ProtocolClient`(`@wechat-cc/protocol`);daemon 已有的 `POST /set/api/apply { op: 'unpair_self' }`(设备令牌、经隧道可用)。
- Produces:`retirePrevious(prev: PairingRecord | null, next: PairingRecord, deps: { connect(url: string, token: string): ProtocolClient }): Promise<'retired' | 'skipped' | 'failed'>`(从不抛)。

- [ ] **Step 1: 写失败的测试**

`apps/app/src/net/pairing.test.ts` 追加(import 加 `retirePrevious`、`type PairingRecord`):

```ts
describe('retirePrevious(spec §8、D5)', () => {
  const OLD = 'd' + '2'.repeat(48)
  const rec = (deviceToken: string, deviceId: string, daemonId = LINK.daemonId): PairingRecord =>
    ({ v: 1, daemonId, relayHost: LINK.relayHost, relayUrl: LINK.relayUrl, deviceToken, deviceId, pairedAt: 1 })
  function client(out: { status: number; json: unknown } | Error, log: string[], closed: string[]) {
    return (url: string, token: string): ProtocolClient => ({
      version: () => 2,
      async request(r: ProtocolRequest) {
        log.push(`${url} ${token} ${r.method} ${r.path} ${r.body}`)
        if (out instanceof Error) throw out
        const text = JSON.stringify(out.json)
        return { status: out.status, headers: {}, body: new TextEncoder().encode(text), text: () => text, json: <T,>() => JSON.parse(text) as T }
      },
      subscribe: () => () => {},
      close: () => { closed.push(token) },
    })
  }
  it('用旧令牌连旧电脑说 unpair_self;令牌不进正文;用完即关', async () => {
    const log: string[] = [], closed: string[] = []
    expect(await retirePrevious(rec(OLD, 'bb22cc33'), rec(DEV, 'aa11bb22'), { connect: client({ status: 200, json: { ok: true } }, log, closed) })).toBe('retired')
    expect(log).toEqual([`${LINK.relayUrl} ${OLD} POST /set/api/apply {"op":"unpair_self"}`])
    expect(closed).toEqual([OLD])
  })
  it('没有旧记录 / 同一枚令牌 ⇒ skipped,不连', async () => {
    const log: string[] = [], closed: string[] = []
    const connect = client({ status: 200, json: { ok: true } }, log, closed)
    expect(await retirePrevious(null, rec(DEV, 'aa11bb22'), { connect })).toBe('skipped')
    expect(await retirePrevious(rec(DEV, 'aa11bb22'), rec(DEV, 'aa11bb22'), { connect })).toBe('skipped')
    expect(log).toEqual([])
  })
  it('旧令牌早已失效(auth_failed)/ 电脑不在线 / 回 ok:false ⇒ failed,不抛,照样关', async () => {
    for (const out of [new Error('auth_failed'), new Error('daemon_offline'), { status: 403, json: { ok: false, error: 'device_only' } }] as const) {
      const log: string[] = [], closed: string[] = []
      expect(await retirePrevious(rec(OLD, 'bb22cc33'), rec(DEV, 'aa11bb22'), { connect: client(out, log, closed) })).toBe('failed')
      expect(closed).toEqual([OLD])
    }
  })
})
```

`src/daemon/settings-panel-retire.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSettingsPanel, type SettingsPanel } from './settings-panel'

// 重新配对退旧位(spec 2026-10-01-tendhearth-pairing-ux §8、D5):app 用旧令牌经隧道 unpair_self,只撤它自己。
const OWNER = 'owner_chat@im.wechat'
let dir: string
let panel: SettingsPanel
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'retire-'))
  mkdirSync(join(dir, 'memory', OWNER), { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({ provider: 'claude' }))
  panel = makeSettingsPanel({ stateDir: dir, ownerChatId: () => OWNER, chatPrefs: { get: () => ({}), set: (_c, p) => p }, getUserName: () => '大人', setUserName: async () => {}, log: () => {} })
})
afterEach(async () => { await panel.stop(); rmSync(dir, { recursive: true, force: true }) })

const req = (path: string, q: string, body: unknown) =>
  panel.handleRequest(new Request(`http://127.0.0.1${path}?${q}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
const pair = async () => (await (await req('/set/api/pair', `t=${panel.issueToken()}`, {})).json() as { device_token: string }).device_token

describe('旧令牌经隧道 unpair_self', () => {
  it('A、B 两台;A 的令牌 unpair_self ⇒ 只剩 B,A 失效、B 照常', async () => {
    const a = await pair(), b = await pair()
    const r = await req('/set/api/apply', `d=${a}&_via=tunnel`, { op: 'unpair_self' })
    expect(await r.json()).toEqual({ ok: true })
    expect(panel.validToken(a)).toBe(false)
    expect(panel.validToken(b)).toBe(true)
    expect(panel.deviceTokens()).toEqual([b])
  })
  it('撤过一次再撤 ⇒ 401(app 当 failed 吞掉)', async () => {
    const a = await pair()
    await req('/set/api/apply', `d=${a}&_via=tunnel`, { op: 'unpair_self' })
    expect((await req('/set/api/apply', `d=${a}&_via=tunnel`, { op: 'unpair_self' })).status).toBe(401)
  })
})
```

- [ ] **Step 2: 跑,确认失败 / 现状**

Run: `cd apps/app && bun x vitest run src/net/pairing.test.ts; cd - && bun --bun vitest run src/daemon/settings-panel-retire.test.ts`
Expected: app 侧 FAIL(`retirePrevious` 未导出);daemon 侧 PASS(钉住已有行为,不需要改 daemon)

- [ ] **Step 3: 实现**

`apps/app/src/net/pairing.ts` 末尾追加:

```ts
/**
 * 重新配对后退掉旧设备位(spec §8、D5):用**旧令牌**连旧电脑,POST unpair_self(只撤自己)。
 * 证明就是那次加密握手(只有持有旧令牌的人握得上),令牌从不进正文。没有旧记录 / 同一枚 ⇒ skipped;
 * 任何失败(旧令牌早已失效、电脑不在线、回 ok:false)⇒ failed —— 从不抛,调用方不等它。
 */
export async function retirePrevious(
  prev: PairingRecord | null,
  next: PairingRecord,
  deps: { connect(url: string, token: string): ProtocolClient },
): Promise<'retired' | 'skipped' | 'failed'> {
  if (!prev || prev.deviceToken === next.deviceToken) return 'skipped'
  let old: ProtocolClient | null = null
  try {
    old = deps.connect(prev.relayUrl, prev.deviceToken)
    const res = await old.request({ method: 'POST', path: '/set/api/apply', body: JSON.stringify({ op: 'unpair_self' }), headers: JSON_HEADERS })
    const body = res.status === 200 ? (res.json() as { ok?: unknown }) : null
    return body?.ok === true ? 'retired' : 'failed'
  } catch {
    return 'failed'
  } finally {
    try { old?.close() } catch { /* 关不掉也不要紧 */ }
  }
}
```

`apps/app/src/app/pair.tsx`:import 加 `retirePrevious`(`import { pairWithLink, PairError, retirePrevious } from '../net/pairing'`);`const { setPaired } = useSession()` 改成 `const { setPaired, pairing } = useSession()`;`connect()` 里把

```tsx
      await pairAndSave(
        () => pairWithLink(link, { connect: rnConnect, label: Platform.OS === 'ios' ? 'Tendhearth · iPhone' : 'Tendhearth · Android' }),
        setPaired,
      )
```

换成

```tsx
      const prev = pairing
      const rec = await pairAndSave(
        () => pairWithLink(link, { connect: rnConnect, label: Platform.OS === 'ios' ? 'Tendhearth · iPhone' : 'Tendhearth · Android' }),
        setPaired,
      )
      // 新配对已存好之后才退旧位(D5);不等它,结果不影响这次配对。
      void retirePrevious(prev, rec, { connect: rnConnect })
```

- [ ] **Step 4: 跑**

Run: `cd apps/app && bun run test && bun run typecheck && bun run export:check && cd - && bun --bun vitest run src/daemon/settings-panel-retire.test.ts`
Expected: 全绿

- [ ] **Step 5: 根回路**

Run: `bun run test && npm run test:node`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add apps/app/src/net/pairing.ts apps/app/src/net/pairing.test.ts apps/app/src/app/pair.tsx src/daemon/settings-panel-retire.test.ts
git commit -m "配对体验 Task 11:重新配对存好之后,用旧令牌自己 unpair_self 退掉旧设备位(只凭握手证明,从不按 id)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: 全量回路、真机验收清单与文档登记

**Files:**
- Modify: `docs/roadmap.md`(「下一步」或现状段落里加一条 plan 7a;「欠的真机账」加配对验收;「已定未做」加 Block Store / iCloud 钥匙串同步 / `/v1/settings/link` 升档)
- Modify: `docs/INDEX.md`(加一行 plan 7a)
- Modify: `docs/superpowers/specs/2026-10-01-tendhearth-pairing-ux-design.md`(§6.3 结论表的真机列,只在跑了真机时填)

**Interfaces:**
- Consumes: Task 1–11 的全部产物。
- Produces: 文档登记;真机结论(有设备时)。

- [ ] **Step 1: 全量回路(每条看退出码)**

Run:

```bash
bun run test && npm run test:node && bun run typecheck && bun run depcheck
bun --bun vitest run apps/desktop
(cd apps/relay && bun run typecheck && bun run test)
(cd apps/app && bun run test && bun run typecheck && bun run export:check)
(cd apps/desktop/src-tauri && cargo test)
lsof -i :4176; (cd apps/desktop && bun x playwright test)
```

Expected: 全部退出码 0。任何一条红:回到对应任务修,不在这里打补丁。

- [ ] **Step 2: 本机端到端(daemon 真跑时)**

```bash
cd apps/desktop && bun run build-sidecar && cd -
wechat-cc self deploy
wechat-cc selftest phone --executor cursor --relay v2
```

Expected:`self deploy` 健康门通过;若本机已设 `relay_v2_url`,`selftest phone` PASS(它用 `GET /v1/settings/link` 配一次,单次配对不影响);没设 ⇒ 记下「中继未开通,selftest phone 跳过」,桌面点「连接手机」应显示「手机连接服务还没开通」(截图存仓库外 `~/Documents/tendhearth/cc-screens-2026-10-01-pairing/`)。

- [ ] **Step 3: 真机验收清单(有设备就跑,没有就原样写进 roadmap 的「欠的真机账」)**

1. 中继 staging 部署后:`curl -sI https://relay-staging.tendhearth.com/.well-known/apple-app-site-association` ⇒ 200 `application/json`。
2. iPhone(开发构建,装好 app):桌面「连接手机」→ 系统相机扫 ⇒ 直接进 app 的确认卡(主机名对)⇒「连接」⇒ 回此刻、CC 变 Light;桌面弹层变「已连上 Tendhearth · iPhone」。把 §6.3 表的 iOS 行补上「真机:保留」。
3. 同一个码再扫一次(另一台手机或删掉 app 重装后)⇒「这个码已经用过或过期了…」。
4. 安卓(设了 `ANDROID_CERT_SHA256` 后):同 2;没设时扫码打开浏览器的网页壳(预期)。补 §6.3 表安卓行。
5. 重新配对:已配对的手机在设置里扫新码 ⇒ 电脑的设备列表里旧的那台消失。
6. iOS 备份恢复(主人事项 §11.3):加密备份 → 恢复到另一台 ⇒ 打开直接连上;电脑上撤掉这台后再恢复 ⇒ 回欢迎页、显示「这台手机和电脑的配对已经失效了。」。

- [ ] **Step 4: 文档登记**

`docs/INDEX.md`:在「设计统一(plan 6…)」那行之后加:

```markdown
| 配对体验(plan 7a:单次配对、桌面「连接手机」、引导页给码、通用链接 / App Links、恢复核验、退旧位) | [roadmap.md](roadmap.md);[中继 §9 通用链接](maintainer/relay.md) | spec `superpowers/specs/2026-10-01-tendhearth-pairing-ux-design.md` + 计划 `superpowers/plans/2026-10-01-tendhearth-pairing-ux.md` |
```

`docs/roadmap.md`:在「设计统一(plan 6)」那条之后加:

```markdown
- **配对体验(plan 7a)**(2026-10-01,`pairing-ux` 分支):一个码只配一台(配上即作废、设备令牌不能再铸)、桌面「手机扫码改设置」改名「连接手机」并按需打开远程隧道(中继没开通就直说)、引导页最后一步直接给码、中继发 AASA / assetlinks、app 声明关联域名 / App Links 且链接只到确认卡、恢复回来的配对先核对、重新配对退旧位。spec `docs/superpowers/specs/2026-10-01-tendhearth-pairing-ux-design.md`。下一份 = 7b(手机上接着电脑上的会话)。
```

「欠的真机账」段加一条:「配对体验真机六项(计划 7a Task 12 Step 3),其中 iOS 备份恢复与安卓指纹是主人的」。「已定未做」段加三条:「安卓凭据恢复走 Google Block Store」「iCloud 钥匙串同步(kSecAttrSynchronizable)—— 待主人定」「`GET /v1/settings/link` 由 trusted 升 admin(selftest phone 改用 operator 令牌)—— 待主人定」。

- [ ] **Step 5: Commit**

```bash
git add docs/roadmap.md docs/INDEX.md docs/superpowers/specs/2026-10-01-tendhearth-pairing-ux-design.md
git commit -m "配对体验 Task 12:全量回路通过;roadmap / INDEX 登记 plan 7a,真机验收清单与主人事项入账

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: 推送并看 CI**

```bash
git push -u origin pairing-ux && wechat-cc ci triage --wait --rerun
```

Expected: 退出码 0(绿)。3(flake)⇒ 已自动重跑;1(真红)⇒ 回对应任务。
