# Tendhearth app 真连接 + 配对(LiveBackend)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `apps/app` 真的连上主人家里的电脑:扫码(或粘贴链接)配对 → 长期设备令牌进钥匙串 → `LiveBackend` 经官方中继用协议包 v2 订阅主题、拉详情、提交批准 / 回答 / 说一句 / 交办;连接状态(连接中 / 在线 / 离线 / 已撤销)贯穿全部页面;设备管理(列表、给本机改名、解除本机配对)。

**Architecture:** 界面仍然只认 `Backend` 接口(`src/backend/types.ts`)。新增 `src/backend/live.ts`(纯 TS,不引 RN)用协议包的 `makeProtocolClient`,socket 由调用方注入(RN 用 `src/net/ws-socket.ts` 包 `WebSocket`;根目录的进程内端到端测试直接用内存管道)。协议客户端新增 `onStatus` 钩子喂给纯函数状态机 `src/net/connection.ts`;重连(epoch 前进)⇒ store 全部查询重新验证。所有返回过 `PHONE_API_SCHEMAS`,所有主题事件过 `topics.ts` 的 schema。语言改成「每次读都带 `lang`」,查询键不再编码语言,换语言由 store 统一判过期。

**Tech Stack:** Expo SDK 57、Expo Router、React Native 0.86、TypeScript strict、`@wechat-cc/protocol`(v2 协议客户端、zod v4 schema)、`expo-crypto`、`expo-camera`、`expo-secure-store`、vitest(app 纯逻辑 + 根目录进程内端到端)。

**Spec:** `docs/superpowers/specs/2026-09-30-tendhearth-app-v1-design.md`(§3 状态约定、§4 架构、§6 配对、§9 测试)。前序计划:`docs/superpowers/plans/2026-09-30-tendhearth-app-backend.md`(后端补全)、`docs/superpowers/plans/2026-09-30-tendhearth-app-skeleton.md`(骨架 + 演示模式,已合)。

## Global Constraints

- 工作树 `.claude/worktrees/deploy-dev`,分支 `app-live`(基于 `origin/dev` a9b3b617),PR 进 `dev`;不切分支、不碰兄弟工作树、不用 `git stash`、不暂存 `.superpowers/`。
- **只走中继**:`r…` daemon id ⇒ `wss://<中继主机>/v2/phone?id=<id>`;`t…` id ⇒ `wss://<中继主机>/tunnel/phone?id=<id>`(与 `src/cli/selftest-phone.ts` `classifyLink` 同一规则)。链接里的 `lan=` 解析并记下但**不使用**(见计划裁决 1)。
- 接口返回一律用 `PHONE_API_SCHEMAS["METHOD /path"]` 的 zod schema 解析;主题事件用 `HomeTopic / ApprovalsTopic / AgentsTopic / MatterTopic` 解析;解析失败 ⇒ 丢弃并记日志(事件)或 `BackendError('unknown')`(请求)。zod v4:`import z from 'zod'`。
- 错误映射(唯一一处:`src/net/errors.ts`):`permission_stale / question_stale / input_stale` ⇒ `stale`;传输层 `auth_failed` 或 HTTP 401 ⇒ `revoked`;`timeout` ⇒ `timeout`(store 映射成「不确定」);`unreachable / daemon_offline / closed / stream_unknown / rate_limited / quota_exceeded / too_many_streams` 及未知传输错误 ⇒ `offline`;`matter_not_found` ⇒ `not_found`;`invalid` 与 `invalid_*` ⇒ `invalid`(含 `invalid_answer`,见计划裁决 2);其余 ⇒ `unknown`。
- 回答问题:`JSON.stringify(answers).length > 20_000` 在手机上就拦下,不发;说一句正文 `> 20_000` 字同样拦下。两个上限是协议包常量 `PHONE_ANSWER_MAX_JSON` / `PHONE_SAY_MAX_CHARS`,daemon 与 app 共用。
- **状态约定(spec §3)**:离线 ⇒ 显示上次同步时间、草稿照写、发送 / 批准 / 拒绝锁住;重连后重拉(只有读),**草稿永不自动发送**;不做乐观成功;撤销 ⇒ 停止提交、清掉钥匙串里的设备令牌、显示「重新配对」,与「暂时离线」用不同文案与不同 testID。
- 令牌从不进日志、错误文案或 `console`:`LiveBackend` 的 `log` 只写错误码与路由键。
- 被根目录端到端测试 import 的 app 文件 —— `apps/app/src/backend/{live,types}.ts`、`apps/app/src/net/{connection,errors,uuid,link,pairing}.ts`、`apps/app/src/i18n/{index,en,zh-Hans}.ts` —— 必须是纯 TS(不 import `react` / `react-native` / `expo-*`),并且在**根** `tsconfig.json`(`noUncheckedIndexedAccess`、`verbatimModuleSyntax`)下也能过类型检查:类型一律 `import type`,数组下标取值带 `!` 或判空。
- daemon 行为只改一处:新增 `/set/api/apply` 的 `unpair_self` 操作(Task 2);另把两个 `20_000` 字面量换成协议包常量(不改行为)。
- 原生依赖只用 `bunx expo install` 装(版本跟 SDK 57);`ios/`、`android/` 不进 git;加了 `expo-crypto` / `expo-camera` 之后要重新 `bunx expo run:ios` 生成 development build 才能在模拟器跑。
- 所有面向用户的字符串进 `src/i18n/en.ts` 与 `src/i18n/zh-Hans.ts`,两份键一致(`i18n.test.ts` 钉住)。
- 钥匙串键:配对记录 `tendhearth.pairing.v1`、偏好 `tendhearth.prefs.v1`;`keychainAccessible: AFTER_FIRST_UNLOCK`(下一份计划的通知扩展要在锁屏后读)。
- Maestro 只跑演示与不联网的配对页(无效链接提示);真配对、真中继、撤销提示是**主人真机验收项**。
- 回路(看退出码,别 grep):
  - app:`cd apps/app && bun run test && bun run typecheck && bun run export:check`
  - 根:`bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck`
  - CI 的 `app · expo` 作业跑的就是 app 那三条;改 `packages/protocol/**` 也会触发它(还会触发 `Relay deploy` 往 staging 部署——协议改动是纯增量,安全)。

## Review Focus

1. **扫了过期(>10 分钟)的码,或者电脑没开「出门也能用」时给出的 `http://…/set?t=` 局域网链接**:给出对应的一句人话(「码过期了,请在电脑上刷新」/「请在电脑上打开出门也能用」),不存任何令牌,也不进入「已撤销」(Task 4、Task 8 测试钉住)。
2. **正在批准时电脑那边撤销了这台手机**:这次提交的结果是 `revoked`(不是「不确定」也不是「失败」),连接立刻变 `revoked`,之后不再发出任何请求(Task 7 测试)。
3. **app 在后台待了很久再回到前台**:新握手、所有主题重挂、所有查询重新验证 —— 包括离线时首次加载就失败、还在 30 秒退避里的那一页(Task 5、Task 7 测试)。
4. **冷启动时电脑关着(一次都没同步过)**:文案是「暂时连不上」而不是「这是 xx:xx 同步的内容」;提交锁住;草稿保留(Task 10 视图测试 + Task 4 状态机测试)。
5. **回答里贴了一大段(JSON 超过 20 000 字)**:手机上就拦下并提示删短,请求根本不发出(Task 7 测试 + Task 10 视图测试)。

---

## File Structure

```
packages/protocol/src/client-types.ts        + ClientStatus、ClientOpts.onStatus
packages/protocol/src/client.ts              发 onStatus(connecting / ready / down / auth_failed)
packages/protocol/src/api.ts                 + PHONE_SAY_MAX_CHARS、PHONE_ANSWER_MAX_JSON;导出 DeviceRow
packages/protocol/src/index.ts               导出上面几个
src/daemon/settings-panel.ts                 + /set/api/apply {op:'unpair_self'}(经隧道可用,只撤调用者自己)
src/daemon/mobile-workbench.ts               20_000 → PHONE_ANSWER_MAX_JSON(不改行为)
src/daemon/phone-routes.ts                   注释:unpair_self 为什么不在 LAN_ONLY_OPS
src/daemon/phone-app-live-e2e.test.ts        新:LiveBackend + 配对对着进程内真 daemon 手机端
apps/app/
  index.ts                                   新入口:先装运行时补丁,再 expo-router/entry
  package.json  app.json                     依赖、main、expo-camera 插件、图标
  assets/images/icon.png  android-icon-foreground.png   占位图标(由 CC 素材生成)
  src/net/utf8.ts                            Hermes 缺 TextEncoder/TextDecoder 时的 UTF-8 实现
  src/net/polyfills.ts                       installPolyfills(纯函数)
  src/net/install-polyfills.ts               副作用模块:expo-crypto → installPolyfills
  src/net/ws-socket.ts                       WebSocket → ProtocolSocket
  src/net/uuid.ts                            v4 uuid
  src/net/link.ts                            parsePairLink
  src/net/connection.ts                      连接状态机(纯函数)+ shouldRevalidate
  src/net/errors.ts                          mapPhoneError / transportErrorCode
  src/net/pairing.ts                         pairWithLink、PairingRecord、PairError
  src/net/credentials.ts                     钥匙串读写(注入 SecureStore,纯)
  src/net/secure-store.ts                    真 expo-secure-store 实例
  src/net/rn-connect.ts                      rnSocket / rnConnect(RN 的 WebSocket)
  src/backend/types.ts                       Backend 接口:读带 lang、设备、生命周期;Connection 加 connecting/epoch
  src/backend/live.ts                        LiveBackend
  src/backend/demo.ts                        每次读带 lang;去掉 setLang/republish;设备与生命周期空实现
  src/state/store.ts                         查询按 store 语言加载;setLang;revalidateAll
  src/state/hooks.ts                         useQuery(key, (lang) => …)
  src/state/drafts.ts                        requestIdFor
  src/state/session.tsx                      配对记录 / 偏好落钥匙串
  src/state/BackendProvider.tsx              演示 / 真连接切换、重连重拉、前后台、撤销
  src/view/connection.ts                     connectionNotice / formatSynced
  src/view/pair.ts                           linkErrorKey / pairErrorKey
  src/view/devices.ts                        devicesView
  src/view/approval.ts                       + answersTooLong
  src/ui/ConnectionNotice.tsx                离线 / 连接中 / 已撤销 提示
  src/app/pair.tsx                           扫码 / 粘贴 / 确认 / 配对
  src/app/devices.tsx                        新:设备管理
  src/app/settings.tsx  compose.tsx  approval/[id].tsx  matter/[id].tsx  (tabs)/index.tsx  (tabs)/together.tsx  _layout.tsx
  src/state/useWork.ts
  .maestro/pair-invalid.yaml                 新:不联网的配对页检查
```

---

### Task 1: 协议包 —— 连接状态钩子、两个文本上限、导出 DeviceRow

**Files:**
- Modify: `packages/protocol/src/client-types.ts`、`packages/protocol/src/client.ts`、`packages/protocol/src/api.ts`、`packages/protocol/src/index.ts`
- Modify: `src/daemon/mobile-workbench.ts:99`、`src/daemon/settings-panel.ts:731`(字面量换常量)
- Test: `packages/protocol/src/client.test.ts`

**Interfaces:**
- Produces:
  - `export type ClientStatus = 'connecting' | 'ready' | 'down' | 'auth_failed'`
  - `ClientOpts.onStatus?: (s: ClientStatus) => void`
  - `export const PHONE_SAY_MAX_CHARS = 20_000`、`export const PHONE_ANSWER_MAX_JSON = 20_000`
  - `export const DeviceRow`(已有的 zod 对象,改成导出)、`export type DeviceRowT = z.infer<typeof DeviceRow>`

- [ ] **Step 1: 写失败的测试**

在 `packages/protocol/src/client.test.ts` 末尾加一个 describe(用文件里现成的 `makeFakeDaemon` / `client` / `flush`,假时钟已在 `beforeEach` 打开):

```ts
describe('onStatus(给 app 的连接状态机)', () => {
  it('握手完成 ⇒ connecting → ready;后台关连接 ⇒ down,退避后 connecting → ready', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const seen: string[] = []
    const { c } = client(daemon, { onStatus: s => seen.push(s) })
    c.subscribe('agents', () => {})
    await flush()
    expect(seen).toEqual(['connecting', 'ready'])
    daemon.d.live().serverClose()
    await flush()
    expect(seen.at(-1)).toBe('down')
    await vi.advanceTimersByTimeAsync(600)
    expect(seen.slice(-2)).toEqual(['connecting', 'ready'])
    c.close()
  })

  it('auth_failed ⇒ 最后一条是 auth_failed,之后不再有 down / connecting', async () => {
    const daemon = makeFakeDaemon({ version: 2, token: 'some-other-token' })
    const seen: string[] = []
    const { c } = client(daemon, { onStatus: s => seen.push(s) })
    c.subscribe('agents', () => {})
    await flush()
    expect(seen.at(-1)).toBe('auth_failed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(seen.filter(s => s === 'auth_failed')).toHaveLength(1)
    expect(seen.at(-1)).toBe('auth_failed')
    c.close()
  })

  it('close() 之后不再报任何状态', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const seen: string[] = []
    const { c } = client(daemon, { onStatus: s => seen.push(s) })
    c.subscribe('agents', () => {})
    await flush()
    const n = seen.length
    c.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(seen).toHaveLength(n)
  })

  it('open() 抛错 ⇒ connecting → down,退避后再连成功', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const seen: string[] = []
    let n = 0
    const c = makeProtocolClient({
      open: () => { if (n++ === 0) throw new Error('boom'); return daemon.d.open() },
      token: TOKEN, requestTimeoutMs: 1000, onStatus: s => seen.push(s),
    })
    c.subscribe('agents', () => {})
    await flush()
    expect(seen).toEqual(['connecting', 'down'])
    await vi.advanceTimersByTimeAsync(600)
    expect(seen.slice(-2)).toEqual(['connecting', 'ready'])
    c.close()
  })

  it('钩子自己抛错不影响连接与请求', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const { c } = client(daemon, { onStatus: () => { throw new Error('hook') } })
    const p = c.request({ method: 'GET', path: '/x' })
    await flush()
    expect((await p).status).toBe(200)
    c.close()
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run packages/protocol/src/client.test.ts -t onStatus`
Expected: FAIL(`seen` 一直是空数组)。

- [ ] **Step 3: 实现**

`client-types.ts`:在 `ClientOpts` 之前加类型,在 `ClientOpts` 末尾加字段:

```ts
/** 连接状态(给 app 的连接状态机用,见 apps/app/src/net/connection.ts)。 */
export type ClientStatus = 'connecting' | 'ready' | 'down' | 'auth_failed'
```

```ts
  /**
   * 连接状态变化:开始一条新连接 `connecting`;握手完成 `ready`;这条连接作废 `down`(之后按退避重连,
   * 或没事可做就不连);明文 `auth_failed` ⇒ `auth_failed`(致命,不会再连,之后不再报)。`close()` 之后不再报。
   * 钩子抛错被吞掉。
   */
  onStatus?: (s: ClientStatus) => void
```

`client.ts`:
1. import 行加 `ClientStatus`:`import type { ProtocolSocket, ClientOpts, ProtocolRequest, ProtocolResponse, EventMeta, ProtocolClient, ClientStatus } from './client-types'`,并把 re-export 那一行也加上 `ClientStatus`。
2. 在 `subErr` 定义之后加(`closed` 在下面才声明,用函数避免 TDZ):

```ts
  function status(s: ClientStatus): void {
    if (closed) return
    try { opts.onStatus?.(s) } catch { /* 钩子自己的错不关我们的事 */ }
  }
```

3. `connect()` 开头与 open 失败处:

```ts
  function connect(): void {
    status('connecting')
    const kp = x25519KeyPair()
    let sock: ProtocolSocket
    try { sock = opts.open() } catch (e) { protoErr('open_failed', e); status('down'); scheduleReconnect(); return }
```

4. `dropConn()` 末尾(`backoffAttempt = 0` 那行之后、排重连之前):

```ts
    if (!fatal) status('down')
    if (!closed && !fatal && needsConnection()) scheduleReconnect()
```

5. `onHello()` 里 `c.readyAt = now()` 之后:`status('ready')`。
6. `onErrorFrame()` 的 `auth_failed` 分支,在 `dropConn(c)` 之后、`return` 之前:`status('auth_failed')`。

`api.ts`:把 `const DeviceRow = z.object({` 改成 `export const DeviceRow = z.object({`;在 `PhonePlainError` 之后加:

```ts
/** 手机「说一句」正文上限(settings-panel.ts 的 POST /m/api/matter/say)。app 在手机上就拦。 */
export const PHONE_SAY_MAX_CHARS = 20_000
/** 回答问题:answers 的 JSON 序列化长度上限(mobile-workbench.ts 的 POST /m/api/matter/answer)。app 在手机上就拦。 */
export const PHONE_ANSWER_MAX_JSON = 20_000
```

`api.ts` 在 `DeviceRow` 定义下面再加一行 `export type DeviceRowT = z.infer<typeof DeviceRow>`(与 `topics.ts` 的 `…T` 类型同一写法)。

`index.ts`:`client` 那行的 type 导出加 `ClientStatus`;`api` 那组 export 加 `DeviceRow, PHONE_SAY_MAX_CHARS, PHONE_ANSWER_MAX_JSON`,并加一行 `export type { DeviceRowT } from './api'`。

daemon 两处字面量:
- `src/daemon/mobile-workbench.ts:99`:`JSON.stringify(b.answers).length>20_000` → `JSON.stringify(b.answers).length>PHONE_ANSWER_MAX_JSON`,文件顶部从 `@wechat-cc/protocol` import `PHONE_ANSWER_MAX_JSON`。
- `src/daemon/settings-panel.ts:731`:`b.text.length > 20_000` → `b.text.length > PHONE_SAY_MAX_CHARS`,在该文件已有的 `@wechat-cc/protocol` import 里加上它。

- [ ] **Step 4: 跑,确认通过**

Run:
```bash
bun --bun vitest run packages/protocol src/daemon/mobile-workbench.test.ts src/daemon/settings-panel.test.ts src/daemon/phone-e2e.test.ts; echo $?
bun run typecheck; echo tc=$?
```
Expected: `0`、`tc=0`。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src src/daemon/mobile-workbench.ts src/daemon/settings-panel.ts
git commit -m "protocol:onStatus 连接状态钩子 + 说一句 / 回答上限常量 + 导出 DeviceRow

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: daemon —— 手机自己解除配对(`unpair_self`)

`revoke_device` 在 `LAN_ONLY_OPS` 里(丢了的手机不能远程把别的设备踢掉),所以手机 app 在外面没法「解除本机配对」。加一个只撤**调用者自己**的操作,经隧道可用。

**Files:**
- Modify: `src/daemon/settings-panel.ts`(`/set/api/apply` 分支,`LAN_ONLY_OPS` 检查之后)
- Modify: `src/daemon/phone-routes.ts`(`LAN_ONLY_OPS` 注释)
- Test: `src/daemon/settings-panel-registry.test.ts`

**Interfaces:**
- Produces: `POST /set/api/apply` body `{ op: 'unpair_self' }` ⇒ `{ ok: true }`(设备令牌调用:撤掉这台、注销它的推送);链接令牌调用 ⇒ `{ ok: false, error: 'device_only' }`,什么都不撤。响应形状不变(`PHONE_API_SCHEMAS['POST /set/api/apply']`)。

- [ ] **Step 1: 写失败的测试**

在 `src/daemon/settings-panel-registry.test.ts` 末尾加(用文件里现成的 `pair / post / get / devices`):

```ts
describe('unpair_self:手机 app 解除本机配对', () => {
  it('经隧道只撤调用者自己:它随即 401,另一台照常', async () => {
    const a = await pair(), b = await pair()
    expect(await (await post('/set/api/apply?_via=tunnel', a, { op: 'unpair_self' })).json()).toEqual({ ok: true })
    expect(panel.validToken(a)).toBe(false)
    expect((await get('/set/api/state', a)).status).toBe(401)
    expect(panel.validToken(b)).toBe(true)
    expect((await devices(b)).map(d => d.current)).toEqual([true])
  })

  it('链接令牌 ⇒ device_only,什么都不撤', async () => {
    const dev = await pair()
    expect(await (await post('/set/api/apply?_via=tunnel', panel.issueToken(), { op: 'unpair_self' })).json()).toEqual({ ok: false, error: 'device_only' })
    expect(panel.validToken(dev)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/settings-panel-registry.test.ts -t unpair_self`
Expected: FAIL(`panel.apply` 不认识这个 op,回的不是 `{ok:true}`)。

- [ ] **Step 3: 实现**

`src/daemon/settings-panel.ts`,`/set/api/apply` 分支里 `LAN_ONLY_OPS` 那段 `if` 之后、`return json(await panel.apply(body))` 之前:

```ts
            // 手机 app「解除配对」(spec 2026-09-30-tendhearth-app-v1 §6):只撤调用者自己这台,经隧道也行 ——
            // 撤自己不会把别人锁在门外;撤别的设备仍是 LAN_ONLY 的 revoke_device。
            if (op === 'unpair_self') {
              if (caller.origin !== 'device' || !deviceId) return json({ ok: false, error: 'device_only' })
              devices.revoke(deviceId)
              deps.push?.unregister(deviceId)
              deps.audit?.(`随身 CC:设备 ${deviceId} 自己解除配对 — 手机 app`)
              return json({ ok: true })
            }
```

`src/daemon/phone-routes.ts`,`LAN_ONLY_OPS` 注释末尾加一句:

```ts
 * `unpair_self`(只撤调用者自己)不在这里:撤自己不会把别人锁在门外,手机 app 在外面也要能解除配对。
```

- [ ] **Step 4: 跑,确认通过**

Run: `bun --bun vitest run src/daemon/settings-panel-registry.test.ts src/daemon/settings-panel.test.ts scripts/phone-routes.guard.test.ts; echo $?`
Expected: `0`。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/settings-panel.ts src/daemon/phone-routes.ts src/daemon/settings-panel-registry.test.ts
git commit -m "daemon:手机自己解除配对 unpair_self(经隧道可用,只撤调用者)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: app 运行时底座 —— UTF-8、随机数补丁、WebSocket 适配、uuid、新入口

**Files:**
- Create: `apps/app/src/net/utf8.ts`、`apps/app/src/net/polyfills.ts`、`apps/app/src/net/install-polyfills.ts`、`apps/app/src/net/ws-socket.ts`、`apps/app/src/net/uuid.ts`、`apps/app/index.ts`
- Test: `apps/app/src/net/utf8.test.ts`、`apps/app/src/net/polyfills.test.ts`、`apps/app/src/net/ws-socket.test.ts`、`apps/app/src/net/uuid.test.ts`
- Modify: `apps/app/package.json`(依赖、`main`)、`bun.lock`

**Interfaces:**
- Produces:
  - `class Utf8Encoder { encode(s?: string): Uint8Array }`、`class Utf8Decoder { decode(b?: ArrayBufferView | ArrayBuffer): string }`
  - `installPolyfills(g: PolyfillTarget, getRandomValues: (a: Uint8Array) => Uint8Array): string[]`(返回补了哪几样)
  - `type WsLike`、`type WsCtor = new (url: string) => WsLike`、`makeWsSocket(url: string, Ws: WsCtor): ProtocolSocket`
  - `uuid(rand?: (a: Uint8Array) => Uint8Array): string`(v4,小写)

- [ ] **Step 1: 装依赖**

```bash
cd apps/app
bunx expo install expo-crypto expo-camera
cd ../..
```

然后手改 `apps/app/package.json`:把 `zod` 从 `devDependencies` 挪到 `dependencies`(app 代码要在运行时直接 import 它);`"main": "expo-router/entry"` 改成 `"main": "index.ts"`。回到根目录 `bun install`,确认 `bun install --frozen-lockfile; echo $?` 为 0(CI 就这么装)。

- [ ] **Step 2: 写失败的测试**

`apps/app/src/net/utf8.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Utf8Decoder, Utf8Encoder } from './utf8'

const samples = ['', 'hello', '中文与 English 混排', 'emoji 🔥👩‍💻', '\u0000\u007f\u0080߿ࠀ￿', '𝄞 surrogate', 'x'.repeat(100_000) + '尾']

describe('UTF-8 兜底实现', () => {
  it('与平台 TextEncoder 逐字节一致', () => {
    for (const s of samples) expect([...new Utf8Encoder().encode(s)]).toEqual([...new TextEncoder().encode(s)])
  })
  it('往返不变(含长串,不爆栈)', () => {
    for (const s of samples) expect(new Utf8Decoder().decode(new Utf8Encoder().encode(s))).toBe(s)
  })
  it('解码接受 ArrayBuffer 与带偏移的视图', () => {
    const bytes = new TextEncoder().encode('ab中c')
    const buf = new Uint8Array(bytes.length + 2); buf.set(bytes, 1)
    expect(new Utf8Decoder().decode(buf.subarray(1, 1 + bytes.length))).toBe('ab中c')
    expect(new Utf8Decoder().decode(bytes.buffer.slice(0))).toBe('ab中c')
  })
  it('坏字节 ⇒ U+FFFD,不抛', () => {
    expect(new Utf8Decoder().decode(Uint8Array.from([0x61, 0xff, 0x62]))).toBe('a�b')
    expect(new Utf8Decoder().decode(Uint8Array.from([0xe4, 0xb8]))).toBe('��')
  })
  it('孤立代理项编码成 U+FFFD', () => {
    expect([...new Utf8Encoder().encode('\ud800')]).toEqual([0xef, 0xbf, 0xbd])
  })
})
```

`apps/app/src/net/polyfills.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { installPolyfills } from './polyfills'
import { Utf8Decoder, Utf8Encoder } from './utf8'

describe('installPolyfills', () => {
  it('空环境:三样都补上,随机数走注入的实现', () => {
    const g: Record<string, any> = {}
    const rand = vi.fn((a: Uint8Array) => a.fill(7))
    expect(installPolyfills(g, rand)).toEqual(['crypto.getRandomValues', 'TextEncoder', 'TextDecoder'])
    expect([...g.crypto.getRandomValues(new Uint8Array(3))]).toEqual([7, 7, 7])
    expect(g.TextEncoder).toBe(Utf8Encoder)
    expect(g.TextDecoder).toBe(Utf8Decoder)
  })
  it('已有的一律不动', () => {
    const own = { getRandomValues: (a: Uint8Array) => a }
    const g: Record<string, any> = { crypto: own, TextEncoder, TextDecoder }
    expect(installPolyfills(g, a => a)).toEqual([])
    expect(g.crypto).toBe(own)
    expect(g.TextEncoder).toBe(TextEncoder)
  })
  it('有 crypto 对象但没有 getRandomValues ⇒ 只补这一个方法,保留对象', () => {
    const cryptoObj: Record<string, unknown> = { randomUUID: () => 'x' }
    const g: Record<string, any> = { crypto: cryptoObj, TextEncoder, TextDecoder }
    expect(installPolyfills(g, a => a)).toEqual(['crypto.getRandomValues'])
    expect(g.crypto).toBe(cryptoObj)
  })
})
```

`apps/app/src/net/ws-socket.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { makeWsSocket, type WsLike } from './ws-socket'

class FakeWs implements WsLike {
  static last: FakeWs
  sent: string[] = []
  closes = 0
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  constructor(public url: string) { FakeWs.last = this }
  send(s: string) { this.sent.push(s) }
  close() { this.closes++ }
}

describe('makeWsSocket', () => {
  it('open / 文本消息 / send 原样转交', () => {
    const s = makeWsSocket('wss://relay.example/v2/phone?id=r1', FakeWs)
    const open = vi.fn(), msg = vi.fn()
    s.onOpen(open); s.onMessage(msg)
    expect(FakeWs.last.url).toBe('wss://relay.example/v2/phone?id=r1')
    FakeWs.last.onopen!()
    FakeWs.last.onmessage!({ data: '{"hs":"x"}' })
    s.send('frame')
    expect(open).toHaveBeenCalledTimes(1)
    expect(msg).toHaveBeenCalledWith('{"hs":"x"}')
    expect(FakeWs.last.sent).toEqual(['frame'])
  })
  it('二进制帧丢掉(协议只走文本)', () => {
    const s = makeWsSocket('wss://x', FakeWs)
    const msg = vi.fn(); s.onMessage(msg)
    FakeWs.last.onmessage!({ data: new ArrayBuffer(3) })
    expect(msg).not.toHaveBeenCalled()
  })
  it('只报 error 不报 close(RN 常见)⇒ 仍然 onClose 一次,并关掉底层', () => {
    const s = makeWsSocket('wss://x', FakeWs)
    const close = vi.fn(); s.onClose(close)
    FakeWs.last.onerror!({})
    FakeWs.last.onclose!({})
    expect(close).toHaveBeenCalledTimes(1)
    expect(FakeWs.last.closes).toBe(1)
  })
  it('主动 close() ⇒ onClose 一次;之后的消息不再转交', () => {
    const s = makeWsSocket('wss://x', FakeWs)
    const close = vi.fn(), msg = vi.fn()
    s.onClose(close); s.onMessage(msg)
    s.close(); s.close()
    FakeWs.last.onclose!({})
    FakeWs.last.onmessage!({ data: 'late' })
    expect(close).toHaveBeenCalledTimes(1)
    expect(msg).not.toHaveBeenCalled()
  })
})
```

`apps/app/src/net/uuid.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { uuid } from './uuid'

// 与 daemon mobile-workbench.ts / task-entry.ts 的 UUID 校验同形(小写 v4)。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuid', () => {
  it('v4 形状,且每次不同', () => {
    const a = uuid(), b = uuid()
    expect(a).toMatch(UUID); expect(b).toMatch(UUID); expect(a).not.toBe(b)
  })
  it('全 0xff 的随机源也落在 v4 / variant 位上', () => {
    expect(uuid(x => x.fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
  })
})
```

- [ ] **Step 3: 跑,确认失败**

Run: `cd apps/app && bunx vitest run src/net; echo $?`
Expected: 非 0(模块不存在)。

- [ ] **Step 4: 实现**

`apps/app/src/net/utf8.ts`:

```ts
// Hermes 缺 TextEncoder / TextDecoder 时的最小 UTF-8 实现(只做 utf-8、无 stream 选项)。
// 协议包(zod + noble + client.ts)只用到这两样的 encode / decode。已有就不装(polyfills.ts)。
export class Utf8Encoder {
  readonly encoding = 'utf-8'
  encode(s = ''): Uint8Array {
    const out: number[] = []
    for (let i = 0; i < s.length; i++) {
      let cp = s.charCodeAt(i)
      if (cp >= 0xd800 && cp <= 0xdbff) {
        const lo = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
        if (lo >= 0xdc00 && lo <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00); i++ } else cp = 0xfffd
      } else if (cp >= 0xdc00 && cp <= 0xdfff) cp = 0xfffd
      if (cp < 0x80) out.push(cp)
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    }
    return Uint8Array.from(out)
  }
}

export class Utf8Decoder {
  readonly encoding = 'utf-8'
  decode(input?: ArrayBufferView | ArrayBuffer): string {
    if (!input) return ''
    const b = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    const cont = (k: number) => k < b.length && (b[k]! & 0xc0) === 0x80
    let s = ''
    const units: number[] = []
    const flush = () => { s += String.fromCharCode(...units); units.length = 0 }
    for (let i = 0; i < b.length;) {
      const x = b[i]!
      let cp = 0xfffd, n = 1
      if (x < 0x80) cp = x
      else if (x >= 0xc2 && x < 0xe0 && cont(i + 1)) { cp = ((x & 31) << 6) | (b[i + 1]! & 63); n = 2 }
      else if (x >= 0xe0 && x < 0xf0 && cont(i + 1) && cont(i + 2)) {
        const c = ((x & 15) << 12) | ((b[i + 1]! & 63) << 6) | (b[i + 2]! & 63)
        if (c >= 0x800 && (c < 0xd800 || c > 0xdfff)) { cp = c; n = 3 }
      } else if (x >= 0xf0 && x < 0xf5 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
        const c = ((x & 7) << 18) | ((b[i + 1]! & 63) << 12) | ((b[i + 2]! & 63) << 6) | (b[i + 3]! & 63)
        if (c >= 0x10000 && c <= 0x10ffff) { cp = c; n = 4 }
      }
      if (cp > 0xffff) { const v = cp - 0x10000; units.push(0xd800 + (v >> 10), 0xdc00 + (v & 1023)) } else units.push(cp)
      if (units.length >= 4096) flush() // String.fromCharCode(...大数组) 会爆栈
      i += n
    }
    flush()
    return s
  }
}
```

`apps/app/src/net/polyfills.ts`:

```ts
import { Utf8Decoder, Utf8Encoder } from './utf8'

export type PolyfillTarget = {
  crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array; [k: string]: unknown }
  TextEncoder?: unknown
  TextDecoder?: unknown
}

/**
 * 只补缺的,已有的一律不动。必须在协议包求值之前调用(client.ts 在模块顶层就 new TextDecoder(),
 * noble 生成 X25519 密钥要 crypto.getRandomValues)—— 入口 apps/app/index.ts 先 import install-polyfills。
 * 返回补了哪几样(测试 / 开发日志用)。
 */
export function installPolyfills(g: PolyfillTarget, getRandomValues: (a: Uint8Array) => Uint8Array): string[] {
  const done: string[] = []
  if (!g.crypto) g.crypto = {}
  if (typeof g.crypto.getRandomValues !== 'function') {
    g.crypto.getRandomValues = a => getRandomValues(a)
    done.push('crypto.getRandomValues')
  }
  if (typeof g.TextEncoder !== 'function') { g.TextEncoder = Utf8Encoder; done.push('TextEncoder') }
  if (typeof g.TextDecoder !== 'function') { g.TextDecoder = Utf8Decoder; done.push('TextDecoder') }
  return done
}
```

`apps/app/src/net/install-polyfills.ts`(副作用模块,不单测 —— 它只接线):

```ts
import { getRandomValues } from 'expo-crypto'
import { installPolyfills, type PolyfillTarget } from './polyfills'

const done = installPolyfills(globalThis as unknown as PolyfillTarget, a => getRandomValues(a))
if (__DEV__ && done.length) console.log(`[tendhearth] polyfilled: ${done.join(', ')}`)
```

`apps/app/index.ts`:

```ts
// 入口:先补运行时(随机数、UTF-8),再交给 expo-router。import 按书写顺序求值,
// 所以补丁一定在任何模块 import '@wechat-cc/protocol' 之前装好。
import './src/net/install-polyfills'
import 'expo-router/entry'
```

`apps/app/src/net/ws-socket.ts`:

```ts
import type { ProtocolSocket } from '@wechat-cc/protocol'

/** RN / 浏览器形状的 WebSocket(构造函数可注入,测试用假的)。 */
export type WsLike = {
  send(s: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
}
export type WsCtor = new (url: string) => WsLike

/**
 * WebSocket → 协议包的 ProtocolSocket。协议只走文本帧;RN 有时只报 error 不报 close,
 * 这里保证 onClose 恰好一次(协议客户端据此退避重连)。
 */
export function makeWsSocket(url: string, Ws: WsCtor): ProtocolSocket {
  const ws = new Ws(url)
  let openCb: (() => void) | null = null
  let msgCb: ((s: string) => void) | null = null
  let closeCb: (() => void) | null = null
  let closed = false
  const fireClose = () => {
    if (closed) return
    closed = true
    try { ws.close() } catch { /* 已关 */ }
    closeCb?.()
  }
  ws.onopen = () => { if (!closed) openCb?.() }
  ws.onmessage = ev => { if (!closed && typeof ev.data === 'string') msgCb?.(ev.data) }
  ws.onerror = () => fireClose()
  ws.onclose = () => fireClose()
  return {
    send: s => ws.send(s),
    close: fireClose,
    onOpen: cb => { openCb = cb },
    onMessage: cb => { msgCb = cb },
    onClose: cb => { closeCb = cb },
  }
}
```

`apps/app/src/net/uuid.ts`:

```ts
type Rand = (a: Uint8Array) => Uint8Array
const defaultRand: Rand = a => (globalThis as unknown as { crypto: { getRandomValues: Rand } }).crypto.getRandomValues(a)

/** RFC 4122 v4(小写)。RN 上随机数由 install-polyfills 装好。 */
export function uuid(rand: Rand = defaultRand): string {
  const b = rand(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
```

- [ ] **Step 5: 跑,确认通过**

Run:
```bash
cd apps/app && bun run test && bun run typecheck && bun run export:check; echo app=$?; cd ../..
```
Expected: `app=0`(`export:check` 证明新入口 + expo-crypto 能打包)。

- [ ] **Step 6: Commit**

```bash
git add apps/app/index.ts apps/app/package.json apps/app/src/net bun.lock
git commit -m "app:运行时底座 —— UTF-8 兜底、随机数补丁、WebSocket 适配、uuid、新入口

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 纯逻辑 —— 配对链接解析、连接状态机、错误映射

**Files:**
- Create: `apps/app/src/net/link.ts`、`apps/app/src/net/connection.ts`、`apps/app/src/net/errors.ts`
- Modify: `apps/app/src/backend/types.ts`(`Connection` 加 `connecting` 与 `epoch`;加 `BackendCode`)、`apps/app/src/backend/demo.ts`(连接快照带 `epoch: 0`)、`apps/app/src/state/store.ts`(`same()` 比 `epoch`)
- Test: `apps/app/src/net/link.test.ts`、`apps/app/src/net/connection.test.ts`、`apps/app/src/net/errors.test.ts`

**Interfaces:**
- Consumes: `RELAY_ID_RE` from `@wechat-cc/protocol`。
- Produces:
  - `types.ts`:`export type ConnState = 'connecting' | 'online' | 'offline' | 'revoked'`;`export type Connection = { state: ConnState; lastSyncedAt: number | null; epoch: number }`;`export type BackendCode = 'stale' | 'offline' | 'revoked' | 'timeout' | 'not_found' | 'invalid' | 'unknown'`
  - `link.ts`:`type ParsedLink = { daemonId: string; linkToken: string; relayHost: string; relayUrl: string; lan: string | null }`;`type LinkError = 'not_a_link' | 'remote_off' | 'bad_link'`;`parsePairLink(raw: string): { ok: true; link: ParsedLink } | { ok: false; error: LinkError }`
  - `connection.ts`:`type ConnEvent = { t: 'status'; s: 'connecting' | 'ready' | 'down' } | { t: 'revoked' } | { t: 'synced'; at: number }`;`INITIAL_CONNECTION: Connection`;`reduceConnection(c: Connection, e: ConnEvent): Connection`(没变化返回同一个对象);`shouldRevalidate(prev: Connection, next: Connection): boolean`;`SYNC_THROTTLE_MS = 5_000`
  - `errors.ts`:`mapPhoneError(status: number, body: unknown): BackendCode | null`;`transportErrorCode(e: unknown): BackendCode`

- [ ] **Step 1: 写失败的测试**

`apps/app/src/net/link.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parsePairLink } from './link'

const RID = 'r' + 'abcdefghijklmnopqrstuvwxyz'.slice(0, 26)
const TID = 't' + '0123456789abcdef0123456789abcdef0123'
const TOK = 't' + '0123456789abcdef0123456789abcdef'
const v2 = `https://relay.tendhearth.com/pset/#id=${RID}&t=${TOK}&p=%2Fset&lan=192.168.1.5:51234`

describe('parsePairLink', () => {
  it('官方中继 v2 链接(r… id)⇒ /v2/phone', () => {
    expect(parsePairLink(v2)).toEqual({ ok: true, link: {
      daemonId: RID, linkToken: TOK, relayHost: 'relay.tendhearth.com',
      relayUrl: `wss://relay.tendhearth.com/v2/phone?id=${RID}`, lan: '192.168.1.5:51234',
    } })
  })
  it('老中继(t… id)⇒ /tunnel/phone;带端口的主机保留端口', () => {
    const r = parsePairLink(`https://relay.example.com:8443/pset/#id=${TID}&t=${TOK}&p=%2Fset&lan=10.0.0.2:1`)
    expect(r).toMatchObject({ ok: true, link: { relayHost: 'relay.example.com:8443', relayUrl: `wss://relay.example.com:8443/tunnel/phone?id=${TID}` } })
  })
  it('粘贴时带的空白与换行去掉;参数顺序无关;没有 lan 也行', () => {
    const r = parsePairLink(`  \nhttps://relay.tendhearth.com/pset/#t=${TOK}&id=${RID}\n`)
    expect(r).toMatchObject({ ok: true, link: { daemonId: RID, linkToken: TOK, lan: null } })
  })
  it('百分号编码的值会解码', () => {
    expect(parsePairLink(v2.replace(`id=${RID}`, `id=${encodeURIComponent(RID).replace('a', '%61')}`))).toMatchObject({ ok: true, link: { daemonId: RID } })
  })
  it('电脑没开「出门也能用」时的局域网链接 ⇒ remote_off', () => {
    expect(parsePairLink(`http://192.168.1.5:51234/set?t=${TOK}`)).toEqual({ ok: false, error: 'remote_off' })
  })
  it('不是配对链接 ⇒ not_a_link(随便的文字、别的网址、明文 http 的 pset)', () => {
    for (const s of ['hello', '', 'https://example.com/', `http://relay.tendhearth.com/pset/#id=${RID}&t=${TOK}`, `https://relay.tendhearth.com/other/#id=${RID}&t=${TOK}`]) {
      expect(parsePairLink(s)).toEqual({ ok: false, error: 'not_a_link' })
    }
  })
  it('形状像但内容坏 ⇒ bad_link(缺令牌、id 不合法、令牌不合法、坏的百分号编码)', () => {
    for (const s of [
      `https://relay.tendhearth.com/pset/#id=${RID}`,
      `https://relay.tendhearth.com/pset/#id=xyz&t=${TOK}`,
      `https://relay.tendhearth.com/pset/#id=${RID}&t=d123`,
      `https://relay.tendhearth.com/pset/#id=${RID}&t=${TOK}&lan=%E0%A4%A`,
    ]) expect(parsePairLink(s)).toEqual({ ok: false, error: 'bad_link' })
  })
})
```

`apps/app/src/net/connection.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { INITIAL_CONNECTION, reduceConnection, shouldRevalidate, SYNC_THROTTLE_MS, type ConnEvent } from './connection'
import type { Connection } from '../backend/types'

const run = (evs: ConnEvent[], from: Connection = INITIAL_CONNECTION) => evs.reduce(reduceConnection, from)

describe('连接状态机', () => {
  it('初始是 connecting;ready ⇒ online,epoch 1', () => {
    expect(INITIAL_CONNECTION).toEqual({ state: 'connecting', lastSyncedAt: null, epoch: 0 })
    expect(run([{ t: 'status', s: 'ready' }])).toEqual({ state: 'online', lastSyncedAt: null, epoch: 1 })
  })
  it('第一次就连不上 ⇒ offline(不会一直显示连接中)', () => {
    expect(run([{ t: 'status', s: 'down' }]).state).toBe('offline')
  })
  it('离线后的每次重试 connecting 不改状态(不闪「连接中」);再 ready ⇒ online,epoch 前进', () => {
    const c = run([{ t: 'status', s: 'ready' }, { t: 'status', s: 'down' }, { t: 'status', s: 'connecting' }])
    expect(c.state).toBe('offline')
    expect(run([{ t: 'status', s: 'ready' }], c)).toMatchObject({ state: 'online', epoch: 2 })
  })
  it('revoked 是终态:之后 ready / down / connecting 都不改', () => {
    const c = run([{ t: 'status', s: 'ready' }, { t: 'revoked' }, { t: 'status', s: 'ready' }, { t: 'status', s: 'down' }])
    expect(c.state).toBe('revoked')
  })
  it('synced 记最近同步时间,但 5 秒内的重复不换对象(省渲染)', () => {
    const a = run([{ t: 'synced', at: 1_000 }])
    expect(a.lastSyncedAt).toBe(1_000)
    expect(reduceConnection(a, { t: 'synced', at: 1_000 + SYNC_THROTTLE_MS - 1 })).toBe(a)
    expect(reduceConnection(a, { t: 'synced', at: 1_000 + SYNC_THROTTLE_MS }).lastSyncedAt).toBe(1_000 + SYNC_THROTTLE_MS)
  })
  it('没变化返回同一个对象', () => {
    const off = run([{ t: 'status', s: 'down' }])
    expect(reduceConnection(off, { t: 'status', s: 'down' })).toBe(off)
    expect(reduceConnection(off, { t: 'status', s: 'connecting' })).toBe(off)
  })
  it('shouldRevalidate:只在变成 online 且 epoch 前进时(首次连上、每次重连)', () => {
    const on1 = run([{ t: 'status', s: 'ready' }])
    expect(shouldRevalidate(INITIAL_CONNECTION, on1)).toBe(true)
    expect(shouldRevalidate(on1, reduceConnection(on1, { t: 'synced', at: 9_999_999 }))).toBe(false)
    const off = reduceConnection(on1, { t: 'status', s: 'down' })
    expect(shouldRevalidate(on1, off)).toBe(false)
    expect(shouldRevalidate(off, reduceConnection(off, { t: 'status', s: 'ready' }))).toBe(true)
  })
})
```

`apps/app/src/net/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mapPhoneError, transportErrorCode } from './errors'

describe('mapPhoneError(HTTP 状态 + 正文 → BackendCode)', () => {
  it.each([
    [200, { ok: true }, null],
    [202, { ok: true, receipt: {} }, null],
    [409, { ok: false, error: 'permission_stale' }, 'stale'],
    [409, { ok: false, error: 'question_stale' }, 'stale'],
    [409, { ok: false, error: 'input_stale' }, 'stale'],
    [401, { error: 'unauthorized' }, 'revoked'],
    [401, null, 'revoked'],
    [404, { ok: false, error: 'matter_not_found' }, 'not_found'],
    [400, { ok: false, error: 'invalid' }, 'invalid'],
    [400, { ok: false, error: 'invalid_answer' }, 'invalid'],
    [200, { ok: false, error: 'invalid_value' }, 'invalid'],
    [200, { ok: false, error: 'lan_only' }, 'unknown'],
    [503, { ok: false, error: 'insight_not_wired' }, 'unknown'],
    [500, null, 'unknown'],
    [403, { error: 'route_not_allowed' }, 'unknown'],
  ])('%s %j ⇒ %s', (status, body, want) => {
    expect(mapPhoneError(status, body)).toBe(want)
  })
})

describe('transportErrorCode(协议客户端拒绝的原因 → BackendCode)', () => {
  it.each([
    ['auth_failed', 'revoked'],
    ['timeout', 'timeout'],
    ['unreachable', 'offline'],
    ['daemon_offline', 'offline'],
    ['closed', 'offline'],
    ['stream_unknown', 'offline'],
    ['rate_limited', 'offline'],
    ['frame_too_large', 'unknown'],
    ['binary_body_needs_v2', 'unknown'],
    ['something new', 'offline'],
  ])('%s ⇒ %s', (msg, want) => {
    expect(transportErrorCode(new Error(msg))).toBe(want)
  })
  it('不是 Error ⇒ offline', () => { expect(transportErrorCode('x')).toBe('offline') })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bunx vitest run src/net/link.test.ts src/net/connection.test.ts src/net/errors.test.ts; echo $?`
Expected: 非 0(模块不存在)。

- [ ] **Step 3: 实现**

`apps/app/src/backend/types.ts`:把 `export type Connection = …` 那行换成:

```ts
export type ConnState = 'connecting' | 'online' | 'offline' | 'revoked'
/** epoch:每次握手成功 +1。store 看它前进就重新验证全部查询(首次连上、重连、回到前台)。 */
export type Connection = { state: ConnState; lastSyncedAt: number | null; epoch: number }
/** BackendError.code 的全集(映射见 src/net/errors.ts)。 */
export type BackendCode = 'stale' | 'offline' | 'revoked' | 'timeout' | 'not_found' | 'invalid' | 'unknown'
```

并把 `BackendError` 上的注释改成 `/** code 见 BackendCode;store 把 timeout 映射成「不确定」。 */`。

`apps/app/src/backend/demo.ts`:`const conn: Connection = { state: 'online', lastSyncedAt: null }` → `{ state: 'online', lastSyncedAt: null, epoch: 0 }`。

`apps/app/src/state/store.ts`:`const same = (a, b) => a.state === b.state && a.lastSyncedAt === b.lastSyncedAt` 末尾加 `&& a.epoch === b.epoch`。

`apps/app/src/net/link.ts`:

```ts
import { RELAY_ID_RE } from '@wechat-cc/protocol'

export type ParsedLink = { daemonId: string; linkToken: string; relayHost: string; relayUrl: string; lan: string | null }
export type LinkError = 'not_a_link' | 'remote_off' | 'bad_link'

const LEGACY_ID_RE = /^t[0-9a-f]{36}$/          // remote-relay-config.ts:'t' + 18 字节 hex
const LINK_TOKEN_RE = /^t[0-9a-f]{32}$/         // settings-panel.ts issueToken:'t' + 16 字节 hex
const PSET_RE = /^https:\/\/([a-z0-9.-]+(?::\d{1,5})?)\/pset\/?#(.*)$/i
const LAN_ONLY_RE = /^http:\/\/[^/\s]+\/set\?(?:.*&)?t=/i

/**
 * 解析桌面「手机上用」二维码里的链接(settings-panel.ts linkUrl() 的两种形状)。
 * 不用 URL 类:RN 的 URL 实现不全(hash / searchParams 在部分版本上直接抛)。
 * 中继规则与 selftest-phone.ts classifyLink 相同:r… ⇒ /v2/phone,t… ⇒ /tunnel/phone。
 * lan= 只记下,v1 不用(计划裁决 1)。
 */
export function parsePairLink(raw: string): { ok: true; link: ParsedLink } | { ok: false; error: LinkError } {
  const s = raw.trim()
  if (LAN_ONLY_RE.test(s)) return { ok: false, error: 'remote_off' }
  const m = PSET_RE.exec(s)
  if (!m) return { ok: false, error: 'not_a_link' }
  const host = m[1]!.toLowerCase()
  const params = new Map<string, string>()
  for (const part of m[2]!.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = eq < 0 ? part : part.slice(0, eq)
    const v = eq < 0 ? '' : part.slice(eq + 1)
    try { params.set(decodeURIComponent(k), decodeURIComponent(v)) } catch { return { ok: false, error: 'bad_link' } }
  }
  const id = params.get('id') ?? ''
  const token = params.get('t') ?? ''
  const path = RELAY_ID_RE.test(id) ? '/v2/phone' : LEGACY_ID_RE.test(id) ? '/tunnel/phone' : null
  if (!path || !LINK_TOKEN_RE.test(token)) return { ok: false, error: 'bad_link' }
  return { ok: true, link: {
    daemonId: id, linkToken: token, relayHost: host,
    relayUrl: `wss://${host}${path}?id=${encodeURIComponent(id)}`,
    lan: params.get('lan') || null,
  } }
}
```

`apps/app/src/net/connection.ts`:

```ts
import type { Connection } from '../backend/types'

export type ConnEvent =
  | { t: 'status'; s: 'connecting' | 'ready' | 'down' }
  | { t: 'revoked' }
  | { t: 'synced'; at: number }

export const INITIAL_CONNECTION: Connection = { state: 'connecting', lastSyncedAt: null, epoch: 0 }
/** 最近同步时间最多每 5 秒换一次对象:每条事件都换会让整棵树跟着重渲染。 */
export const SYNC_THROTTLE_MS = 5_000

/**
 * 连接状态机(spec §3)。connecting 只出现在「第一次还没连上也没失败」;失败过之后的重试一律显示离线,
 * 不在「连接中 / 离线」之间来回闪。revoked 是终态。没变化返回同一个对象(useSyncExternalStore 要稳定引用)。
 */
export function reduceConnection(c: Connection, e: ConnEvent): Connection {
  if (c.state === 'revoked') return c
  if (e.t === 'revoked') return { ...c, state: 'revoked' }
  if (e.t === 'synced') {
    if (c.lastSyncedAt !== null && e.at - c.lastSyncedAt < SYNC_THROTTLE_MS) return c
    return { ...c, lastSyncedAt: e.at }
  }
  if (e.s === 'ready') return { ...c, state: 'online', epoch: c.epoch + 1 }
  if (e.s === 'down') return c.state === 'offline' ? c : { ...c, state: 'offline' }
  return c
}

/** 变成 online 且 epoch 前进(首次连上、每次重连、回到前台的新握手)⇒ 全部查询重新验证。 */
export function shouldRevalidate(prev: Connection, next: Connection): boolean {
  return next.state === 'online' && next.epoch !== prev.epoch
}
```

`apps/app/src/net/errors.ts`:

```ts
import type { BackendCode } from '../backend/types'

const STALE = new Set(['permission_stale', 'question_stale', 'input_stale'])
const errOf = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null) return null
  const e = (body as { error?: unknown }).error
  return typeof e === 'string' ? e : null
}

/** 一条已到达的响应算不算失败、算哪种。成功 ⇒ null(之后再过 schema)。 */
export function mapPhoneError(status: number, body: unknown): BackendCode | null {
  const err = errOf(body)
  if (status === 401 || err === 'unauthorized') return 'revoked'
  const okFalse = typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === false
  if (!okFalse && status < 400) return null
  if (err && STALE.has(err)) return 'stale'
  if (err === 'matter_not_found') return 'not_found'
  if (err === 'invalid' || (err !== null && err.startsWith('invalid_'))) return 'invalid'
  return 'unknown'
}

/** 协议客户端拒绝请求的原因(client.ts 的 Error.message)。 */
export function transportErrorCode(e: unknown): BackendCode {
  const m = e instanceof Error ? e.message : ''
  if (m === 'auth_failed') return 'revoked'
  if (m === 'timeout') return 'timeout'
  if (m === 'frame_too_large' || m === 'binary_body_needs_v2') return 'unknown'
  return 'offline'
}
```

- [ ] **Step 4: 跑,确认通过**

Run: `cd apps/app && bun run test && bun run typecheck; echo app=$?`
Expected: `app=0`。

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/net apps/app/src/backend/types.ts apps/app/src/backend/demo.ts apps/app/src/state/store.ts
git commit -m "app:配对链接解析、连接状态机、错误映射(纯函数)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: store —— 查询按 store 语言加载、换语言与重连一律「判过期再重拉」

**Files:**
- Modify: `apps/app/src/state/store.ts`、`apps/app/src/state/hooks.ts`、`apps/app/src/state/BackendProvider.tsx`
- Modify(只改查询键与 load 签名):`apps/app/src/app/matter/[id].tsx:32-34`、`apps/app/src/app/approval/[id].tsx:40-41`、`apps/app/src/app/(tabs)/index.tsx:25`、`apps/app/src/app/compose.tsx:37`、`apps/app/src/state/useWork.ts:18`
- Test: `apps/app/src/state/store.test.ts`

**Interfaces:**
- Consumes: `Lang` from `../i18n`。
- Produces:
  - `makeStore(backend: Backend, opts?: { lang?: Lang })`
  - `store.query<T>(key: string, load: (lang: Lang) => Promise<T>): Query<T>`
  - `store.setLang(l: Lang): void`(同语言无操作)、`store.revalidateAll(): void`
  - `useQuery<T>(key: string, load: (lang: Lang) => Promise<T>, opts?)`
  - 查询键不再带语言:`matter:<id>`、`insight:<id>`、`changes:<id>`、`entryOptions`、`matters`

- [ ] **Step 1: 写失败的测试**

在 `apps/app/src/state/store.test.ts` 的 describe 里加:

```ts
  it('load 收到 store 当前语言;setLang 后有人在看的查询按新语言重拉', async () => {
    const s = makeStore({} as any, { lang: 'en' })
    const load = vi.fn(async (l: string) => l)
    const q = s.query('k', load)
    q.subscribe(() => {})
    await q.refresh()
    expect(q.get().data).toBe('en')
    s.setLang('zh-Hans')
    await vi.waitFor(() => expect(q.get().data).toBe('zh-Hans'))
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('setLang 同语言不重拉', async () => {
    const s = makeStore({} as any, { lang: 'en' })
    const load = vi.fn(async (l: string) => l)
    const q = s.query('k', load); q.subscribe(() => {})
    await q.refresh()
    s.setLang('en')
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('没人在看的查询只判过期:下次 mount 才拉(有旧数据也拉),拉完就不再拉', async () => {
    const s = makeStore({} as any)
    const load = vi.fn(async (l: string) => l)
    const q = s.query('k', load)
    await q.refresh()
    s.revalidateAll()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    await q.mount()
    expect(load).toHaveBeenCalledTimes(2)
    await q.mount()
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('首次加载失败、还在 30 秒退避里:mount 不拉;revalidateAll(重连)清掉退避立刻重拉', async () => {
    const s = makeStore({} as any)
    let fail = true
    const load = vi.fn(async () => { if (fail) throw new BackendError('offline'); return 1 })
    const q = s.query('k', load); q.subscribe(() => {})
    await q.mount()
    expect(q.get().error).toBe('offline')
    await q.mount()
    expect(load).toHaveBeenCalledTimes(1)
    fail = false
    s.revalidateAll()
    await vi.waitFor(() => expect(q.get().data).toBe(1))
    expect(q.get().error).toBeUndefined()
  })
  it('在飞期间被判过期 ⇒ 落地后(有人在看)按新语言再拉一次', async () => {
    const s = makeStore({} as any, { lang: 'en' })
    const resolvers: Array<() => void> = []
    const load = vi.fn((l: string) => new Promise<string>(r => { resolvers.push(() => r(l)) }))
    const q = s.query('k', load); q.subscribe(() => {})
    const p = q.refresh()
    s.setLang('zh-Hans')
    resolvers[0]!()
    await p
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    resolvers[1]!()
    await vi.waitFor(() => expect(q.get().data).toBe('zh-Hans'))
  })
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bunx vitest run src/state/store.test.ts; echo $?`
Expected: 非 0(`setLang` / `revalidateAll` 不存在)。

- [ ] **Step 3: 实现**

`apps/app/src/state/store.ts`:
1. import 加 `import type { Lang } from '../i18n'`。
2. 签名改成 `export function makeStore(backend: Backend, opts: { lang?: Lang } = {})`,开头加 `let lang: Lang = opts.lang ?? 'en'`。
3. `queries` 那段整段换成:

```ts
  // ── 查询缓存:同 key 共用一份,refresh 在飞复用 ──
  // key 编码 load 的全部输入**除了语言**:语言是 store 级输入,load 收到当下的 lang;换语言走 setLang ⇒ 判过期。
  type Slot = { q: Query<any>; invalidate(): void }
  const queries = new Map<string, Slot>()
  function query<T>(key: string, load: (lang: Lang) => Promise<T>): Query<T> {
    const hit = queries.get(key)
    if (hit) return hit.q as Query<T>
    let state: QueryState<T> = { loading: false }
    let inflight: Promise<void> | null = null
    let inflightAt = 0
    let failedAt = 0
    let gen = 0          // 每判一次过期 +1
    let freshGen = -1    // 最近一次成功落地时的 gen;!== gen ⇒ 过期
    const ls = listeners()
    const set = (s: QueryState<T>) => { state = s; ls.emit() }
    const q: Query<T> = {
      get: () => state,
      subscribe: ls.add,
      refresh() {
        if (inflight) return inflight
        set({ ...state, loading: true })
        const at = (inflightAt = clock())
        const g = gen, l = lang
        inflight = Promise.resolve().then(() => load(l)).then(
          data => { freshGen = g; failedAt = 0; set({ data, loading: false, syncedAt: at }) },
          e => { failedAt = Date.now(); set({ ...state, loading: false, error: e instanceof BackendError ? e.code : 'unknown' }) },
        ).finally(() => {
          inflight = null
          // 在飞期间被判过期(换语言 / 重连):有人在看就再拉一次
          if (g !== gen && ls.size > 0) void q.refresh()
        })
        return inflight
      },
      mount() {
        if (state.loading) return Promise.resolve()
        if (state.data !== undefined) return freshGen === gen ? Promise.resolve() : q.refresh()
        if (failedAt && Date.now() - failedAt < ERROR_BACKOFF_MS) return Promise.resolve()
        return q.refresh()
      },
      revalidate(since) {
        if (isFresh(state, since)) return Promise.resolve()
        if (inflight && inflightAt >= since) return inflight
        if (inflight) return inflight.then(() => q.revalidate(since))
        return q.refresh()
      },
    }
    const invalidate = () => {
      gen++
      failedAt = 0
      if (ls.size > 0 && !inflight) void q.refresh()
    }
    queries.set(key, { q, invalidate })
    return q
  }

  /** 重连 / 回到前台 / 换语言:全部判过期;有人在看的立刻重拉(连首次失败还在退避里的也拉),其余等下次挂载。只重拉读,从不重发提交。 */
  function revalidateAll(): void {
    for (const s of queries.values()) s.invalidate()
  }
  function setLang(l: Lang): void {
    if (l === lang) return
    lang = l
    revalidateAll()
  }
```

4. `return` 改成 `return { query, submit, topic, connection, clock, setLang, revalidateAll }`。
5. 原来 `mount()` 注释里「没数据、没在飞、且最近 30 秒内没失败过才加载」改成「没数据(且不在 30 秒失败退避里)或数据已过期才加载」。

`apps/app/src/state/hooks.ts`:import 加 `import type { Lang } from '../i18n'`;`useQuery` 的 `load: () => Promise<T>` 改成 `load: (lang: Lang) => Promise<T>`。

`apps/app/src/state/BackendProvider.tsx`:`store: makeStore(b)` → `store: makeStore(b, { lang })`;在现有 `useEffect` 旁边加:

```ts
  useEffect(() => { if (lang) value.store.setLang(lang) }, [value, lang])
```

(演示后端的 `setLang` / `republish` 这一步先留着,Task 6 删。)

页面(只改键与 load 签名,`backend.*` 调用本身 Task 6 再加 lang):
- `matter/[id].tsx`:
  ```ts
  const detail = useQuery(`matter:${id}`, () => backend.matter(id), { refreshOnMount: true })
  const insight = useQuery(`insight:${id}`, l => backend.insight(id, l), { refreshOnMount: true })
  ```
  `changes` 那行不变。
- `approval/[id].tsx`:同上两行。
- `(tabs)/index.tsx`:`useQuery(`insight:${taskId}`, l => backend.insight(taskId, l), { enabled: fetch })`;`NeedsYouTitle` 里的 `const lang = useLang()` 若已无其它用处就删掉。
- `compose.tsx`:`useQuery('entryOptions', () => backend.entryOptions(), { enabled: !matter })`。
- `useWork.ts`:`useQuery<MatterT[]>('matters', () => backend.matters())`,删掉 `useLang` import 与 `const lang`。

- [ ] **Step 4: 跑,确认通过**

Run: `cd apps/app && bun run test && bun run typecheck; echo app=$?`
Expected: `app=0`(旧的 store 测试 `s.query('k', vi.fn(async () => 42))` 照样过:忽略参数的 load 仍合法)。

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/state apps/app/src/app
git commit -m "app store:查询按 store 语言加载;setLang / revalidateAll 统一判过期(补上首次失败不重试的缺口)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Backend 接口 —— 读带 lang、交办带 requestId / projectId、设备与生命周期;演示后端跟上

**Files:**
- Modify: `apps/app/src/backend/types.ts`、`apps/app/src/backend/demo.ts`、`apps/app/src/state/BackendProvider.tsx`、`apps/app/src/state/drafts.ts`
- Modify(调用处):`matter/[id].tsx`、`approval/[id].tsx`、`compose.tsx`、`useWork.ts`
- Test: `apps/app/src/backend/demo.test.ts`、`apps/app/src/state/drafts.test.ts`(新)

**Interfaces:**
- Consumes: `DeviceRowT` from `@wechat-cc/protocol`(Task 1);`uuid()`(Task 3)。
- Produces(`types.ts` 的 `Backend`,完整新签名):

```ts
// DeviceRowT 与 HomeTopicT 等一起从 '@wechat-cc/protocol' re-export(见 Step 3)
export interface Backend {
  readonly mode: 'demo' | 'live'
  connection(): Connection
  onConnection(cb: (c: Connection) => void): Unsubscribe
  subscribe<T>(topic: 'home' | 'approvals' | 'agents' | `matter/${string}`, cb: (data: T) => void): Unsubscribe
  matters(lang: Lang): Promise<MatterT[]>
  matter(id: string, lang: Lang): Promise<MatterDetailT>
  insight(id: string, lang: Lang): Promise<{ explanations: Record<string, ApprovalExplanationT>; progress: ProgressSummaryT | null }>
  changes(id: string): Promise<PhoneChangesTurnT | null>
  decide(p: { id: string; runId: string; requestId: string; decision: 'allow' | 'deny' }): Promise<void>
  answer(p: { id: string; runId: string; requestId: string; answers: Record<string, string[]> | null }): Promise<void>
  say(id: string, text: string): Promise<void>
  entryOptions(lang: Lang): Promise<EntryOptionsT>
  /** requestId:同一份草稿、同样的正文重发用同一个(daemon 据此去重、超时后查回执)。projectId 缺省 ⇒ 由 CC 安排(managed)。 */
  create(p: { requestId: string; text: string; projectId?: string; providerId?: string }): Promise<{ matterId: string }>
  devices(): Promise<DeviceRowT[]>
  renameDevice(label: string): Promise<void>
  /** 解除本机配对(daemon 撤掉本机令牌)。失败抛 BackendError;调用方无论成败都清本地令牌。 */
  unpair(): Promise<void>
  /** 前台 true / 后台 false:false 关连接;true 立刻新握手、订阅全部重挂。演示后端空操作。 */
  setActive(active: boolean): void
  dispose(): void
}
```

- `drafts.ts`:`requestIdFor(key: string, text: string, mk?: () => string): string`
- `makeDemoBackend(opts)` 返回 `Backend & { reset(): void }`(不再有 `setLang` / `republish`)。

- [ ] **Step 1: 写失败的测试**

`apps/app/src/state/drafts.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { clearDrafts, deleteDraft, requestIdFor } from './drafts'

let n = 0
const mk = () => `id-${++n}`
beforeEach(() => { clearDrafts(); n = 0 })

describe('requestIdFor', () => {
  it('同一份草稿、同样正文 ⇒ 同一个 id(超时后重发由 daemon 去重)', () => {
    expect(requestIdFor('new', '整理周报', mk)).toBe('id-1')
    expect(requestIdFor('new', '整理周报', mk)).toBe('id-1')
  })
  it('正文改了 ⇒ 换新 id(否则 daemon 回 creation_conflict)', () => {
    requestIdFor('new', 'a', mk)
    expect(requestIdFor('new', 'b', mk)).toBe('id-2')
  })
  it('不同草稿互不影响;删草稿后重新发号', () => {
    requestIdFor('new', 'a', mk)
    expect(requestIdFor('m1', 'a', mk)).toBe('id-2')
    deleteDraft('new')
    expect(requestIdFor('new', 'a', mk)).toBe('id-3')
  })
})
```

`apps/app/src/backend/demo.test.ts`:
1. 全文件机械替换:`b.matters()` → `b.matters('en')`;`b.matter(X)` → `b.matter(X, 'en')`(测试里期望中文文案的那几处用 `'zh-Hans'`,见下);`b.entryOptions()` → `b.entryOptions('en')`;`b.create({ text: … })` → `b.create({ requestId: 'req-1', text: … })`。
2. 删掉三条 `setLang` 用例(「换语言不重建」「换语言:种子文案…」「语言没变不重推」),换成:

```ts
  it('每次读按请求的语言给文案;状态不因语言重建,用户自己的字不变', async () => {
    const b = makeDemoBackend({ lang: 'zh-Hans' })
    const runId = (await b.matter('a1b2c3d4', 'zh-Hans')).runId!
    await b.decide({ id: 'a1b2c3d4', runId, requestId: 'perm-demo-1', decision: 'deny' })
    await b.answer({ id: 'c9d0e1f2', runId: (await b.matter('c9d0e1f2', 'zh-Hans')).runId!, requestId: 'q-demo-1', answers: { depart: ['周一'] } })
    const { matterId } = await b.create({ requestId: 'req-1', text: '我自己的话' })
    const d = await b.matter('a1b2c3d4', 'en')
    expect(d.matter.title).toBe('A better portfolio on mobile')
    expect(d.task?.title).toBe('A better portfolio on mobile')
    expect(d.permissions.length).toBe(0)
    expect(d.events.map(e => e.text)).toEqual(['Reviewed the current homepage', 'Refined the mobile layout', 'Not now'])
    expect((await b.matter('a1b2c3d4', 'zh-Hans')).matter.title).toBe('让作品集在手机上更好看')
    expect((await b.matter('c9d0e1f2', 'en')).questions.length).toBe(0)
    expect((await b.matter('c9d0e1f2', 'en')).events.at(-1)?.text).toBe('Answered: 周一')
    const c = await b.matter(matterId, 'en')
    expect(c.matter.title).toBe('我自己的话')
    expect(c.events[0]?.text).toBe('我自己的话')
    expect(c.events[1]?.text).toBe('Got it, working on it.')
    expect((await b.matters('en')).length).toBe(4)
  })
  it('未处理的问题按读的语言出题', async () => {
    const b = makeDemoBackend({ lang: 'en' })
    expect((await b.matter('c9d0e1f2', 'zh-Hans')).questions[0]?.questions[0]?.header).toBe('出发时间')
    expect((await b.matter('c9d0e1f2', 'en')).questions[0]?.questions[0]?.header).toBe('Departure')
  })
  it('读的语言变了 ⇒ 主题按新语言补推一次;没变不推', async () => {
    const b = makeDemoBackend({ lang: 'en' })
    const got: any[] = []
    b.subscribe('agents', d => got.push(d))
    await b.matters('en'); await Promise.resolve()
    expect(got).toHaveLength(1)
    await b.matters('zh-Hans'); await Promise.resolve()
    expect(got).toHaveLength(2)
    expect(got.at(-1).tasks.find((t: any) => t.id === 'a1b2c3d4').title).toBe('让作品集在手机上更好看')
  })
  it('同一 requestId 交办两次只建一件', async () => {
    const b = makeDemoBackend()
    const a = await b.create({ requestId: 'same', text: 'x' })
    const c = await b.create({ requestId: 'same', text: 'x' })
    expect(c.matterId).toBe(a.matterId)
    expect((await b.matters('en')).length).toBe(4)
  })
  it('交办带 projectId ⇒ 事项的项目路径来自演示的项目目录', async () => {
    const b = makeDemoBackend()
    const p = (await b.entryOptions('en')).projects[0]!
    const { matterId } = await b.create({ requestId: 'r', text: 'x', projectId: p.id })
    expect((await b.matter(matterId, 'en')).matter.projectPath).toBe(p.path)
  })
  it('设备:只有「这台手机」;改名生效;setActive / dispose / unpair 不抛', async () => {
    const b = makeDemoBackend()
    expect((await b.devices()).map(d => d.current)).toEqual([true])
    await b.renameDevice('我的手机')
    expect((await b.devices())[0]?.label).toBe('我的手机')
    b.setActive(false); b.setActive(true); await b.unpair(); b.dispose()
  })
```

3. 「所有返回都符合协议包的 schema」那条加一行:`for (const d of await b.devices()) expect(() => DeviceRow.parse(d)).not.toThrow()`(解构里加 `DeviceRow`)。

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bunx vitest run src/backend/demo.test.ts src/state/drafts.test.ts; echo $?`
Expected: 非 0。

- [ ] **Step 3: 实现**

`types.ts`:把 `Backend` 整个换成上面 Interfaces 里的版本;文件顶部 `import type { … } from '@wechat-cc/protocol'` 里加 `DeviceRowT`,并 `export type { DeviceRowT }`(与 `HomeTopicT` 等同一行)。

`drafts.ts` 换成:

```ts
import { uuid } from '../net/uuid'

// 交办草稿只存内存,按 matter 参数分开('new' = 新事项)。
const drafts = new Map<string, string>()
const requestIds = new Map<string, { text: string; id: string }>()
export const getDraft = (key: string) => drafts.get(key) ?? ''
export const setDraft = (key: string, v: string) => { drafts.set(key, v) }
export const deleteDraft = (key: string) => { drafts.delete(key); requestIds.delete(key) }
export const clearDrafts = () => { drafts.clear(); requestIds.clear() }

/** 同一份草稿、同样正文重发 ⇒ 同一个 requestId(daemon 去重、超时后查回执);正文改了就换新的。 */
export function requestIdFor(key: string, text: string, mk: () => string = () => uuid()): string {
  const hit = requestIds.get(key)
  if (hit && hit.text === text) return hit.id
  const id = mk()
  requestIds.set(key, { text, id })
  return id
}
```

`demo.ts`(按下面逐条改;其余逻辑不动):
1. 签名:`export function makeDemoBackend(opts: { now?: () => number; setTimeout?: typeof setTimeout; lang?: Lang } = {}): Backend & { reset(): void }`。
2. `let lang: Lang = opts.lang ?? 'en'` 改名 `let lastLang: Lang = opts.lang ?? 'en'`,注释改成「主题快照(approvals 摘要、agents 标题)用最近一次读的语言;读本身按参数给文案」。
3. `Entry` 类型加 `titleKey?: Copy`;`buildSeed` 里三处 `add(...)` 分别把 `titleKey` 设为 `'portfolioTitle' / 'tripTitle' / 'notesTitle'`(在 `add` 里接第四个参数写进 `Entry`),种子标题用 `t(lastLang, …)` 生成(只作初值)。
4. 把出差那道题抽成函数,`buildSeed` 与读时共用:

```ts
  const tripQuestion = (l: Lang, createdAt: number): MatterDetailT['questions'][number] => ({
    id: QUESTION_ID, taskId: IDS.trip, createdAt,
    questions: [{
      id: 'depart', header: t(l, 'qHeader'), question: t(l, 'qText'),
      options: [{ label: t(l, 'optMon'), description: '' }, { label: t(l, 'optTue'), description: '' }],
      multiSelect: false, allowOther: true,
    }],
  })
```

5. 删掉 `renderEvents` 与它的所有调用(`add`、`ev`、`evText`、`create` 里);事件只存在 `e.evs`,读时渲染。加:

```ts
  const titleOf = (e: Entry, l: Lang) => (e.titleKey ? t(l, e.titleKey) : e.detail.matter.title)
  /** 读时按请求的语言出一份拷贝:标题、事件、未处理的种子问题都换成 l。状态(已批准 / 已回答 / 阶段)在 e 里,不因语言变。 */
  function localize(e: Entry, l: Lang): MatterDetailT {
    const d = structuredClone(e.detail)
    d.events = e.evs.map(r => ({ kind: r.kind, createdAt: r.createdAt, text: r.key ? t(l, r.key) + (r.extra ?? '') : (r.text ?? '') }))
    const title = titleOf(e, l)
    d.matter.title = title
    if (d.task) d.task.title = title
    d.questions = d.questions.map(q => (q.id === QUESTION_ID ? tripQuestion(l, q.createdAt) : q))
    return d
  }
  /** 读的语言变了 ⇒ 记下,并在当前调用之后把非 matter 主题按新语言补推一次(和原来 setLang 的效果一样)。 */
  function noteLang(l: Lang) {
    if (l === lastLang) return
    lastLang = l
    queueMicrotask(() => publish([]))
  }
```

6. `snapshot()`:`approvals` 里问题摘要用 `tripQuestion(lastLang, q.createdAt)` 的 `questions[0]`(若 `q.id === QUESTION_ID`),否则原样;`agents` 的 `title: e.detail.matter.title` → `title: titleOf(e, lastLang)`。
7. 读方法:

```ts
    async matters(l) { noteLang(l); return list().map(e => localize(e, l).matter).sort((a, b) => b.updatedAt - a.updatedAt) },
    async matter(id, l) { noteLang(l); return localize(get(id), l) },
    async insight(id, l) { noteLang(l); /* 原逻辑,lang 用 l */ … },
    async entryOptions(l) { noteLang(l); return entryOptions(l) },
```

8. `create`:

```ts
    async create({ requestId, text, projectId }) {
      const dup = createdBy.get(requestId)
      if (dup) return { matterId: dup }
      const projectPath = projectId ? entryOptions(lastLang).projects.find(p => p.id === projectId)?.path ?? null : null
      const matterId = `demo${(++seq).toString(16).padStart(4, '0')}`
      createdBy.set(requestId, matterId)
      …(其余照旧,把原来的 projectPath 参数换成上面这个局部变量;没有 projectPath 时 taskOf 的路径仍用 '~/Projects/portfolio')
    },
```

在闭包顶部声明 `let createdBy = new Map<string, string>()`,`reset()` 里 `createdBy = new Map()`。

9. 设备与生命周期(闭包顶部 `let deviceLabel = ''`,`reset()` 里清空):

```ts
    async devices() {
      const at = new Date(now()).toISOString()
      return [{ id: 'demo0001', created_at: at, last_seen_at: at, ...(deviceLabel ? { label: deviceLabel } : {}), current: true }]
    },
    async renameDevice(label) { deviceLabel = label.trim().slice(0, 24) },
    async unpair() {},
    setActive() {},
    dispose() {},
```

10. 删除 `setLang` 与 `republish` 两个方法。

`BackendProvider.tsx`:删掉 `const demo = value.backend as Partial<…>`、渲染期 `setLang` 与 `republish` 的 `useEffect`、`useRef` import(若不再用);保留 Task 5 加的 `store.setLang` effect。

调用处:
- `matter/[id].tsx` / `approval/[id].tsx`:`() => backend.matter(id)` → `l => backend.matter(id, l)`。
- `useWork.ts`:`() => backend.matters()` → `l => backend.matters(l)`。
- `compose.tsx`:`() => backend.entryOptions()` → `l => backend.entryOptions(l)`;提交处:

```ts
      else newId = (await backend.create({ requestId: requestIdFor(draftKey, body), text: body, projectId: project?.id, providerId: provider?.id })).matterId
```

(import `requestIdFor` from `../state/drafts`。)

- [ ] **Step 4: 跑,确认通过**

Run: `cd apps/app && bun run test && bun run typecheck && bun run export:check; echo app=$?`
Expected: `app=0`。

- [ ] **Step 5: Commit**

```bash
git add apps/app/src
git commit -m "app:Backend 读带 lang、交办带 requestId、设备与生命周期;演示后端按读的语言给文案

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: LiveBackend

**Files:**
- Create: `apps/app/src/backend/live.ts`
- Test: `apps/app/src/backend/live.test.ts`

**Interfaces:**
- Consumes: `makeProtocolClient`、`ClientOpts`、`ProtocolClient`、`ProtocolSocket`、`PHONE_API_SCHEMAS`、`PHONE_ANSWER_MAX_JSON`、`PHONE_SAY_MAX_CHARS`、`HomeTopic`、`ApprovalsTopic`、`AgentsTopic`、`MatterTopic`(协议包);`INITIAL_CONNECTION`、`reduceConnection`、`ConnEvent`(Task 4);`mapPhoneError`、`transportErrorCode`(Task 4);`uuid`(Task 3);`Backend` 等(Task 6)。
- Produces:

```ts
export type LiveDeps = {
  open: () => ProtocolSocket                    // 每次重连调一次(RN:() => rnSocket(pairing.relayUrl))
  token: string                                 // 设备令牌
  now?: () => number
  log?: (line: string) => void                  // 只写错误码与路由键,从不写令牌
  uuid?: () => string
  makeClient?: (o: ClientOpts) => ProtocolClient   // 测试注入
  clientOpts?: Partial<Pick<ClientOpts, 'requestTimeoutMs' | 'handshakeTimeoutMs' | 'keepaliveMs' | 'requestDeadlineMs'>>
}
export function makeLiveBackend(d: LiveDeps): Backend   // mode === 'live';构造即开始连接
```

- [ ] **Step 1: 写失败的测试**

`apps/app/src/backend/live.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { PHONE_API_SCHEMAS, type ClientOpts, type ProtocolClient, type ProtocolRequest } from '@wechat-cc/protocol'
import { makeLiveBackend } from './live'
import type { Connection } from './types'

// ── 真 schema 的夹具(第一条用例先证明它们本身过 PHONE_API_SCHEMAS)──
const ID = 'ab12cd34'
const RUN = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const REQ = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d'
const MATTER = { id: ID, kind: 'task', title: 'Fix the build', projectPath: '/p', status: 'open', ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 2 }
const TASK = { id: ID, title: 'Fix the build', status: 'running', phase: 'working', providerId: 'claude', path: '/p', error: null, updatedAt: 2 }
const DETAIL = { matter: MATTER, bindings: [], sessions: [], task: TASK, events: [{ kind: 'progress', text: 'ran tests', createdAt: 3 }], runId: RUN, inputMode: 'steer', permissions: [{ id: REQ, taskId: ID, tool: 'Bash', description: 'npm test', createdAt: 3 }], questions: [], artifacts: [], inputs: [] }
const CAPS = { version: 1, permissions: 'task', configuration: 'task-policy', completion: 'native', stop: 'confirmed', background: 'tracked', features: { nativeResume: true, attachments: true, executionSettings: false, modelCatalog: false } }
const OPTIONS = { status: 'ready', defaultProviderId: 'claude', providers: [{ id: 'claude', displayName: 'Claude', available: true, capabilities: CAPS }], projects: [{ id: 'p-0123456789abcdef0123', name: 'Portfolio', path: '/p', providerId: null }] }
const WB_TASK = { id: ID, title: 'x', path: '/p', providerId: 'claude', status: 'queued', workspaceKind: 'project', createdAt: 1, updatedAt: 1, error: null, archivedAt: null, phase: 'queued', canArchive: false, waitingFor: null }
const RECEIPT = { requestId: REQ, taskId: ID, matterId: ID, runId: RUN, acceptedAt: 5 }
const MODELS = { default_provider: 'claude', checked_at: null, providers: [], openai: { base_url: '', model: '', has_key: false, aliases: {} }, gemini: { has_key: false }, cheap: '', trusted_providers: null, shared_token: [], guest_blocked: [] }
const DEVICES = [{ id: 'aa11bb22', created_at: '2026-09-30T00:00:00Z', last_seen_at: '2026-09-30T01:00:00Z', current: true }, { id: 'cc33dd44', created_at: '2026-09-01T00:00:00Z', last_seen_at: '2026-09-02T00:00:00Z', label: 'Old phone', current: false }]
const STATE = { ok: true, name: '', persona: '', prefs: {}, config: {}, remote: { available: true, enabled: true, devices: DEVICES }, atelier: { model_status: null }, models: MODELS }
const PROGRESS = { summary: 'going well', steps: [{ title: 'a', detail: 'b' }], source: 'model' }

type Reply = { status: number; json: unknown } | Error
type Handler = (req: { path: string; body: any }) => Reply

/** 假协议客户端:按「METHOD /path」回夹具;每次 makeClient 都是一个新客户端(模拟重连 / 前后台)。 */
function harness(routes: Record<string, Handler | Reply> = {}) {
  const clients: Array<{ opts: ClientOpts; subs: Map<string, (d: unknown) => void>; closed: boolean }> = []
  const reqs: Array<{ key: string; path: string; body: any; retry?: boolean }> = []
  const makeClient = (opts: ClientOpts): ProtocolClient => {
    const me = { opts, subs: new Map<string, (d: unknown) => void>(), closed: false }
    clients.push(me)
    return {
      version: () => 2,
      async request(r: ProtocolRequest) {
        const key = `${r.method} ${r.path.split('?')[0]}`
        const body = typeof r.body === 'string' ? JSON.parse(r.body) : undefined
        reqs.push({ key, path: r.path, body, retry: r.retry })
        const h = routes[key]
        const out = typeof h === 'function' ? h({ path: r.path, body }) : h
        if (!out) throw new Error('timeout')
        if (out instanceof Error) throw out
        const text = JSON.stringify(out.json)
        return { status: out.status, headers: {}, body: new TextEncoder().encode(text), text: () => text, json: <T,>() => JSON.parse(text) as T }
      },
      subscribe(topic, cb) { me.subs.set(topic, d => cb(d, { epoch: 'e', seq: 1 })); return () => { me.subs.delete(topic) } },
      close() { me.closed = true },
    }
  }
  const last = () => clients.at(-1)!
  const logs: string[] = []
  const b = makeLiveBackend({ open: () => { throw new Error('unused') }, token: 'd-secret-token', makeClient, now: () => 1_000_000, uuid: () => REQ, log: l => logs.push(l) })
  return { b, clients, last, reqs, logs, status: (s: 'connecting' | 'ready' | 'down' | 'auth_failed') => last().opts.onStatus?.(s) }
}
const ok = (json: unknown, status = 200): Reply => ({ status, json })

describe('夹具本身是真形状', () => {
  it.each([
    ['GET /m/api/matters', { ok: true, matters: [MATTER] }],
    ['GET /m/api/matter', { ok: true, ...DETAIL }],
    ['GET /m/api/matter/insight', { ok: true, explanations: {}, progress: PROGRESS }],
    ['GET /m/api/matter/changes', { ok: true, turn: null }],
    ['GET /m/api/entry/options', { ok: true, ...OPTIONS }],
    ['POST /m/api/matter/create', { ok: true, receipt: RECEIPT, task: WB_TASK }],
    ['GET /set/api/state', STATE],
  ])('%s', (key, json) => { expect(PHONE_API_SCHEMAS[key]!.safeParse(json).success).toBe(true) })
})

describe('LiveBackend 读', () => {
  it('列表 / 详情 / 说明(带 lang)/ 改动 / 交办选项:路径对、返回去掉 ok', async () => {
    const { b, reqs } = harness({
      'GET /m/api/matters': ok({ ok: true, matters: [MATTER] }),
      'GET /m/api/matter': ok({ ok: true, ...DETAIL }),
      'GET /m/api/matter/insight': ok({ ok: true, explanations: {}, progress: PROGRESS }),
      'GET /m/api/matter/changes': ok({ ok: true, turn: null }),
      'GET /m/api/entry/options': ok({ ok: true, ...OPTIONS }),
    })
    expect(await b.matters('en')).toEqual([MATTER])
    expect(await b.matter(ID, 'en')).toEqual(DETAIL)
    expect(await b.insight(ID, 'zh-Hans')).toEqual({ explanations: {}, progress: PROGRESS })
    expect(await b.changes(ID)).toBeNull()
    expect(await b.entryOptions('en')).toEqual(OPTIONS)
    expect(reqs.map(r => r.path)).toEqual(['/m/api/matters', `/m/api/matter?id=${ID}`, `/m/api/matter/insight?id=${ID}&lang=zh-Hans`, `/m/api/matter/changes?id=${ID}`, '/m/api/entry/options'])
  })
  it('返回不合 schema ⇒ BackendError(unknown),记日志(不含令牌)', async () => {
    const { b, logs } = harness({ 'GET /m/api/matters': ok({ ok: true, matters: [{ id: 1 }] }) })
    await expect(b.matters('en')).rejects.toMatchObject({ code: 'unknown' })
    expect(logs.join('\n')).toContain('GET /m/api/matters')
    expect(logs.join('\n')).not.toContain('d-secret-token')
  })
  it('成功的读更新最近同步时间', async () => {
    const { b } = harness({ 'GET /m/api/matters': ok({ ok: true, matters: [] }) })
    expect(b.connection().lastSyncedAt).toBeNull()
    await b.matters('en')
    expect(b.connection().lastSyncedAt).toBe(1_000_000)
  })
  it('传输错误:daemon_offline ⇒ offline;timeout ⇒ timeout', async () => {
    const h = harness({ 'GET /m/api/matters': new Error('daemon_offline'), 'GET /m/api/matter': new Error('timeout') })
    await expect(h.b.matters('en')).rejects.toMatchObject({ code: 'offline' })
    await expect(h.b.matter(ID, 'en')).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('LiveBackend 提交', () => {
  it('批准:正文形状对、不自动重试;已被处理 ⇒ stale', async () => {
    let n = 0
    const { b, reqs } = harness({ 'POST /m/api/matter/permission': () => (n++ === 0 ? ok({ ok: true }) : ok({ ok: false, error: 'permission_stale' }, 409)) })
    const p = { id: ID, runId: RUN, requestId: REQ, decision: 'allow' as const }
    await b.decide(p)
    await expect(b.decide(p)).rejects.toMatchObject({ code: 'stale' })
    expect(reqs[0]).toMatchObject({ body: p, retry: undefined })
  })
  it('回答:JSON 超过 20 000 字 ⇒ invalid,请求根本不发', async () => {
    const { b, reqs } = harness({ 'POST /m/api/matter/answer': ok({ ok: true }) })
    await expect(b.answer({ id: ID, runId: RUN, requestId: REQ, answers: { q: ['x'.repeat(20_000)] } })).rejects.toMatchObject({ code: 'invalid' })
    expect(reqs).toHaveLength(0)
    await b.answer({ id: ID, runId: RUN, requestId: REQ, answers: { q: ['short'] } })
    expect(reqs[0]?.body).toEqual({ id: ID, runId: RUN, requestId: REQ, answers: { q: ['short'] } })
  })
  it('说一句:带 uuid requestId、可重试;超长 ⇒ invalid 不发', async () => {
    const { b, reqs } = harness({ 'POST /m/api/matter/say': ok({ ok: true, result: { kind: 'chat', reply: 'ok' } }) })
    await b.say(ID, 'hi')
    expect(reqs[0]).toMatchObject({ body: { id: ID, text: 'hi', requestId: REQ }, retry: true })
    await expect(b.say(ID, 'x'.repeat(20_001))).rejects.toMatchObject({ code: 'invalid' })
    expect(reqs).toHaveLength(1)
  })
  it('交办:有项目 ⇒ target project;没有 ⇒ managed;返回回执里的 matterId', async () => {
    const { b, reqs } = harness({ 'POST /m/api/matter/create': ok({ ok: true, receipt: RECEIPT, task: WB_TASK }, 202) })
    expect(await b.create({ requestId: REQ, text: 't', projectId: 'p-0123456789abcdef0123', providerId: 'claude' })).toEqual({ matterId: ID })
    await b.create({ requestId: REQ, text: 't' })
    expect(reqs[0]).toMatchObject({ retry: true, body: { requestId: REQ, text: 't', target: { kind: 'project', projectId: 'p-0123456789abcdef0123' }, providerId: 'claude' } })
    expect(reqs[1]?.body.target).toEqual({ kind: 'managed' })
  })
  it('交办超时 ⇒ 按 requestId 查一次回执:查到当成功,查不到仍是 timeout', async () => {
    const found = harness({ 'POST /m/api/matter/create': new Error('timeout'), 'GET /m/api/matter/create-receipt': ok({ ok: true, receipt: RECEIPT, task: WB_TASK }) })
    expect(await found.b.create({ requestId: REQ, text: 't' })).toEqual({ matterId: ID })
    expect(found.reqs[1]?.path).toBe(`/m/api/matter/create-receipt?requestId=${REQ}`)
    const missing = harness({ 'POST /m/api/matter/create': new Error('timeout'), 'GET /m/api/matter/create-receipt': ok({ ok: false, error: 'matter_not_found' }, 404) })
    await expect(missing.b.create({ requestId: REQ, text: 't' })).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('LiveBackend 撤销', () => {
  it('提交途中被撤销(auth_failed)⇒ 这次是 revoked,连接变 revoked,客户端关掉,之后一条请求都不发', async () => {
    const h = harness({ 'POST /m/api/matter/permission': new Error('auth_failed') })
    await expect(h.b.decide({ id: ID, runId: RUN, requestId: REQ, decision: 'allow' })).rejects.toMatchObject({ code: 'revoked' })
    expect(h.b.connection().state).toBe('revoked')
    expect(h.last().closed).toBe(true)
    const n = h.reqs.length
    await expect(h.b.matters('en')).rejects.toMatchObject({ code: 'revoked' })
    await expect(h.b.say(ID, 'x')).rejects.toMatchObject({ code: 'revoked' })
    expect(h.reqs.length).toBe(n)
  })
  it('协议客户端报 auth_failed 状态 ⇒ revoked;HTTP 401 ⇒ revoked', async () => {
    const a = harness()
    a.status('auth_failed')
    expect(a.b.connection().state).toBe('revoked')
    const c = harness({ 'GET /m/api/matters': ok({ error: 'unauthorized' }, 401) })
    await expect(c.b.matters('en')).rejects.toMatchObject({ code: 'revoked' })
    expect(c.b.connection().state).toBe('revoked')
  })
  it('revoked 之后 setActive(true) 不再连', () => {
    const h = harness()
    h.status('auth_failed')
    const n = h.clients.length
    h.b.setActive(false); h.b.setActive(true)
    expect(h.clients.length).toBe(n)
  })
})

describe('LiveBackend 连接与订阅', () => {
  it('onConnection 立刻回调当前值;ready ⇒ online epoch 1;down ⇒ offline', () => {
    const h = harness()
    const seen: Connection[] = []
    h.b.onConnection(c => seen.push(c))
    expect(seen[0]?.state).toBe('connecting')
    h.status('ready'); h.status('down')
    expect(seen.map(c => c.state)).toEqual(['connecting', 'online', 'offline'])
    expect(seen[1]?.epoch).toBe(1)
  })
  it('构造即常驻订阅 approvals(让协议客户端一直连着,状态机才知道电脑在不在)', () => {
    const h = harness()
    expect([...h.last().subs.keys()]).toEqual(['approvals'])
  })
  it('主题事件过 schema 才转交;坏的丢掉;后来的订阅者立刻拿到最近一份', () => {
    const h = harness()
    const got: unknown[] = []
    h.b.subscribe('agents', d => got.push(d))
    h.last().subs.get('agents')!({ running: 'many' })
    h.last().subs.get('agents')!({ running: 1, waiting: 0, tasks: [] })
    expect(got).toEqual([{ running: 1, waiting: 0, tasks: [] }])
    const late: unknown[] = []
    h.b.subscribe('agents', d => late.push(d))
    expect(late).toEqual([{ running: 1, waiting: 0, tasks: [] }])
  })
  it('最后一个订阅者退订 ⇒ 退订协议客户端;常驻的 approvals 不退', () => {
    const h = harness()
    const off1 = h.b.subscribe('agents', () => {}), off2 = h.b.subscribe('approvals', () => {})
    off1(); off2()
    expect([...h.last().subs.keys()]).toEqual(['approvals'])
  })
  it('后台 setActive(false) 关连接;回前台 setActive(true) 新客户端、全部主题重挂、旧客户端的状态被忽略', () => {
    const h = harness()
    h.b.subscribe('agents', () => {})
    const first = h.last()
    h.b.setActive(false)
    expect(first.closed).toBe(true)
    h.b.setActive(true)
    expect(h.clients.length).toBe(2)
    expect([...h.last().subs.keys()].sort()).toEqual(['agents', 'approvals'])
    first.opts.onStatus?.('down')
    expect(h.b.connection().state).toBe('connecting')
    h.status('ready')
    expect(h.b.connection()).toMatchObject({ state: 'online', epoch: 1 })
  })
  it('重连只重挂订阅,不重发任何提交', () => {
    const h = harness()
    h.b.setActive(false); h.b.setActive(true); h.status('ready')
    expect(h.reqs.filter(r => r.key.startsWith('POST'))).toEqual([])
  })
})

describe('LiveBackend 设备', () => {
  it('列表来自 /set/api/state;给本机改名用 current 那台的 id', async () => {
    const { b, reqs } = harness({ 'GET /set/api/state': ok(STATE), 'POST /set/api/apply': ok({ ok: true }) })
    expect(await b.devices()).toEqual(DEVICES)
    await b.renameDevice('My phone')
    expect(reqs.at(-1)?.body).toEqual({ op: 'label_device', id: 'aa11bb22', label: 'My phone' })
  })
  it('改名被拒(ok:false invalid_value)⇒ invalid', async () => {
    const { b } = harness({ 'GET /set/api/state': ok(STATE), 'POST /set/api/apply': ok({ ok: false, error: 'invalid_value' }) })
    await expect(b.renameDevice('')).rejects.toMatchObject({ code: 'invalid' })
  })
  it('解除配对:发 unpair_self,成功后关连接', async () => {
    const h = harness({ 'POST /set/api/apply': ok({ ok: true }) })
    await h.b.unpair()
    expect(h.reqs[0]?.body).toEqual({ op: 'unpair_self' })
    expect(h.last().closed).toBe(true)
    await expect(h.b.matters('en')).rejects.toMatchObject({ code: 'offline' })
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bunx vitest run src/backend/live.test.ts; echo $?`
Expected: 非 0(模块不存在)。

- [ ] **Step 3: 实现**

`apps/app/src/backend/live.ts`:

```ts
/**
 * live.ts — 真连接后端:经中继用协议包 v2 连回家里的 daemon(spec §4)。
 * 订阅主题拿摘要与版本号,req 拉详情;每个返回过 PHONE_API_SCHEMAS,每条事件过主题 schema;
 * 错误码映射在 net/errors.ts,连接状态机在 net/connection.ts。
 * 纯 TS,不引 react-native:socket 由调用方注入(RN 用 net/rn-connect.ts),根目录的进程内端到端测试也直接用它。
 * 日志只写错误码与路由键,从不写令牌。
 */
import {
  makeProtocolClient, PHONE_API_SCHEMAS, PHONE_ANSWER_MAX_JSON, PHONE_SAY_MAX_CHARS,
  HomeTopic, ApprovalsTopic, AgentsTopic, MatterTopic,
  type ClientOpts, type ProtocolClient, type ProtocolSocket,
} from '@wechat-cc/protocol'
import { INITIAL_CONNECTION, reduceConnection, type ConnEvent } from '../net/connection'
import { mapPhoneError, transportErrorCode } from '../net/errors'
import { uuid as makeUuid } from '../net/uuid'
import {
  BackendError,
  type ApprovalExplanationT, type Backend, type Connection, type DeviceRowT, type EntryOptionsT,
  type MatterDetailT, type MatterT, type PhoneChangesTurnT, type ProgressSummaryT, type Unsubscribe,
} from './types'

type Topic = Parameters<Backend['subscribe']>[0]
/** 常驻订阅:没人用时协议客户端不连,状态机就不知道电脑在不在。approvals 最轻,也是「此刻」最要紧的那份。 */
const LIVENESS: Topic = 'approvals'

export type LiveDeps = {
  open: () => ProtocolSocket
  token: string
  now?: () => number
  log?: (line: string) => void
  uuid?: () => string
  makeClient?: (o: ClientOpts) => ProtocolClient
  clientOpts?: Partial<Pick<ClientOpts, 'requestTimeoutMs' | 'handshakeTimeoutMs' | 'keepaliveMs' | 'requestDeadlineMs'>>
}

const schemaOf = (topic: string) =>
  topic === 'home' ? HomeTopic : topic === 'approvals' ? ApprovalsTopic : topic === 'agents' ? AgentsTopic : MatterTopic

type Reg = { topic: Topic; cbs: Set<(d: unknown) => void>; off: (() => void) | null; last?: unknown; pinned: boolean }

export function makeLiveBackend(d: LiveDeps): Backend {
  const now = d.now ?? (() => Date.now())
  const log = d.log ?? (() => {})
  const newId = d.uuid ?? (() => makeUuid())
  const mk = d.makeClient ?? makeProtocolClient
  let conn: Connection = INITIAL_CONNECTION
  const connLs = new Set<(c: Connection) => void>()
  const regs = new Map<string, Reg>()
  let client: ProtocolClient | null = null
  let gen = 0
  let disposed = false

  function dispatch(e: ConnEvent): void {
    const next = reduceConnection(conn, e)
    if (next === conn) return
    conn = next
    for (const cb of [...connLs]) cb(conn)
  }
  function closeClient(): void {
    gen++ // 旧客户端之后的回调一律作废
    const c = client
    client = null
    for (const r of regs.values()) r.off = null
    try { c?.close() } catch { /* 已关 */ }
  }
  function revoke(): void {
    dispatch({ t: 'revoked' })
    closeClient()
  }
  function onEvent(r: Reg, data: unknown): void {
    const p = schemaOf(r.topic).safeParse(data)
    if (!p.success) { log(`topic ${r.topic}: bad event dropped`); return }
    r.last = p.data
    dispatch({ t: 'synced', at: now() })
    for (const cb of [...r.cbs]) cb(p.data)
  }
  function attach(r: Reg): void {
    if (!client) return
    try { r.off = client.subscribe(r.topic, data => onEvent(r, data)) }
    catch (e) { r.off = null; log(`topic ${r.topic}: subscribe failed (${e instanceof Error ? e.message : 'unknown'})`) }
  }
  function start(): void {
    if (client || disposed || conn.state === 'revoked') return
    const my = ++gen
    client = mk({
      ...d.clientOpts,
      open: d.open,
      token: d.token,
      onStatus: s => {
        if (my !== gen) return
        if (s === 'auth_failed') revoke()
        else dispatch({ t: 'status', s })
      },
      onSubscriptionError: (topic, code) => {
        if (my !== gen) return
        if (code === 'auth_failed') revoke()
        else log(`topic ${topic}: ${code}`)
      },
      onProtocolError: reason => log(`protocol: ${reason}`),
    })
    for (const r of regs.values()) attach(r)
  }

  async function call<T>(key: string, path: string, init: { body?: unknown; retry?: boolean } = {}): Promise<T> {
    if (conn.state === 'revoked') throw new BackendError('revoked')
    if (!client) throw new BackendError('offline')
    const method = key.slice(0, key.indexOf(' '))
    let res: Awaited<ReturnType<ProtocolClient['request']>>
    try {
      res = await client.request({
        method, path,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } } : {}),
        ...(init.retry !== undefined ? { retry: init.retry } : {}),
      })
    } catch (e) {
      const code = transportErrorCode(e)
      if (code === 'revoked') revoke()
      throw new BackendError(code)
    }
    let json: unknown = null
    try { json = res.json() } catch { /* 非 JSON:交给状态码判断 */ }
    const mapped = mapPhoneError(res.status, json)
    if (mapped) {
      if (mapped === 'revoked') revoke()
      else log(`${key}: ${res.status} ${mapped}`)
      throw new BackendError(mapped)
    }
    const schema = PHONE_API_SCHEMAS[key]
    const p = schema ? schema.safeParse(json) : null
    if (!p || !p.success) { log(`${key}: response did not match schema`); throw new BackendError('unknown') }
    dispatch({ t: 'synced', at: now() })
    return p.data as T
  }
  const idq = (id: string) => `id=${encodeURIComponent(id)}`
  function strip<T extends { ok: true }>(r: T): Omit<T, 'ok'> {
    const { ok: _ok, ...rest } = r
    return rest
  }

  regs.set(LIVENESS, { topic: LIVENESS, cbs: new Set(), off: null, pinned: true })
  start()

  const backend: Backend = {
    mode: 'live',
    connection: () => conn,
    onConnection(cb) { connLs.add(cb); cb(conn); return () => { connLs.delete(cb) } },
    subscribe<T>(topic: Topic, cb: (data: T) => void): Unsubscribe {
      let reg = regs.get(topic)
      if (!reg) { reg = { topic, cbs: new Set(), off: null, pinned: false }; regs.set(topic, reg); attach(reg) }
      const r = reg
      const f = cb as (x: unknown) => void
      r.cbs.add(f)
      if (r.last !== undefined) f(r.last)
      return () => {
        r.cbs.delete(f)
        if (r.cbs.size > 0 || r.pinned || regs.get(topic) !== r) return
        regs.delete(topic)
        const off = r.off
        r.off = null
        off?.()
      }
    },
    async matters() {
      return (await call<{ matters: MatterT[] }>('GET /m/api/matters', '/m/api/matters')).matters
    },
    async matter(id) {
      return strip(await call<{ ok: true } & MatterDetailT>('GET /m/api/matter', `/m/api/matter?${idq(id)}`))
    },
    async insight(id, lang) {
      const r = await call<{ explanations: Record<string, ApprovalExplanationT>; progress: ProgressSummaryT | null }>(
        'GET /m/api/matter/insight', `/m/api/matter/insight?${idq(id)}&lang=${encodeURIComponent(lang)}`)
      return { explanations: r.explanations, progress: r.progress }
    },
    async changes(id) {
      return (await call<{ turn: PhoneChangesTurnT | null }>('GET /m/api/matter/changes', `/m/api/matter/changes?${idq(id)}`)).turn
    },
    async decide(p) {
      await call('POST /m/api/matter/permission', '/m/api/matter/permission', { body: { id: p.id, runId: p.runId, requestId: p.requestId, decision: p.decision } })
    },
    async answer(p) {
      if (p.answers !== null && JSON.stringify(p.answers).length > PHONE_ANSWER_MAX_JSON) throw new BackendError('invalid')
      await call('POST /m/api/matter/answer', '/m/api/matter/answer', { body: { id: p.id, runId: p.runId, requestId: p.requestId, answers: p.answers } })
    },
    async say(id, text) {
      if (text.length > PHONE_SAY_MAX_CHARS) throw new BackendError('invalid')
      await call('POST /m/api/matter/say', '/m/api/matter/say', { body: { id, text, requestId: newId() }, retry: true })
    },
    async entryOptions() {
      return strip(await call<{ ok: true } & EntryOptionsT>('GET /m/api/entry/options', '/m/api/entry/options'))
    },
    async create(p) {
      const body = {
        requestId: p.requestId, text: p.text,
        target: p.projectId ? { kind: 'project', projectId: p.projectId } : { kind: 'managed' },
        ...(p.providerId ? { providerId: p.providerId } : {}),
      }
      try {
        const r = await call<{ receipt: { matterId: string } }>('POST /m/api/matter/create', '/m/api/matter/create', { body, retry: true })
        return { matterId: r.receipt.matterId }
      } catch (e) {
        if (!(e instanceof BackendError) || e.code !== 'timeout') throw e
        // 超时不等于没收到:按 requestId 查一次回执,查到就当成功。
        try {
          const r = await call<{ receipt: { matterId: string } }>('GET /m/api/matter/create-receipt', `/m/api/matter/create-receipt?requestId=${encodeURIComponent(p.requestId)}`)
          return { matterId: r.receipt.matterId }
        } catch { throw e }
      }
    },
    async devices() {
      return (await call<{ remote: { devices: DeviceRowT[] } }>('GET /set/api/state', '/set/api/state')).remote.devices
    },
    async renameDevice(label) {
      const me = (await backend.devices()).find(x => x.current)
      if (!me) throw new BackendError('unknown')
      await call('POST /set/api/apply', '/set/api/apply', { body: { op: 'label_device', id: me.id, label } })
    },
    async unpair() {
      await call('POST /set/api/apply', '/set/api/apply', { body: { op: 'unpair_self' } })
      backend.dispose()
    },
    setActive(active) {
      if (disposed) return
      if (active) start()
      else closeClient()
    },
    dispose() { disposed = true; closeClient() },
  }
  return backend
}
```

注意:`matters(lang)` / `matter(id, lang)` / `entryOptions(lang)` 在 live 里不用 lang(daemon 这几条返回的是用户数据,不分语言);只有 `insight` 把 lang 发给 daemon(计划裁决 9)。实现时参数可以省略不写,TS 允许。

- [ ] **Step 4: 跑,确认通过**

Run: `cd apps/app && bun run test && bun run typecheck; echo app=$?`
Expected: `app=0`。

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/backend/live.ts apps/app/src/backend/live.test.ts
git commit -m "app:LiveBackend —— 主题 + req、schema 解析、错误映射、撤销、前后台

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 配对流程 + 钥匙串

**Files:**
- Create: `apps/app/src/net/pairing.ts`、`apps/app/src/net/credentials.ts`、`apps/app/src/net/secure-store.ts`、`apps/app/src/net/rn-connect.ts`
- Test: `apps/app/src/net/pairing.test.ts`、`apps/app/src/net/credentials.test.ts`

**Interfaces:**
- Consumes: `ParsedLink`(Task 4);`PHONE_API_SCHEMAS`、`makeProtocolClient`、`ProtocolClient`(协议包);`makeWsSocket`、`WsCtor`(Task 3)。
- Produces:
  - `pairing.ts`:`type PairingRecord = { v: 1; daemonId: string; relayHost: string; relayUrl: string; deviceToken: string; deviceId: string; pairedAt: number }`;`type PairErrorCode = 'expired' | 'device_limit' | 'offline' | 'too_old' | 'unknown'`;`class PairError extends Error { code: PairErrorCode }`;`pairWithLink(link: ParsedLink, deps: { connect(url: string, token: string): ProtocolClient; label: string; now?: () => number }): Promise<PairingRecord>`
  - `credentials.ts`:`PAIRING_KEY = 'tendhearth.pairing.v1'`、`PREFS_KEY = 'tendhearth.prefs.v1'`;`type Prefs = { lang: Lang | null }`;`type SecureStoreLike`;`interface CredentialStore { load(); save(r); clear(); loadPrefs(); savePrefs(p) }`;`makeCredentialStore(ss: SecureStoreLike, opts?: Record<string, unknown>): CredentialStore`
  - `secure-store.ts`:`export const credentials: CredentialStore`(真 expo-secure-store)
  - `rn-connect.ts`:`rnSocket(url: string): ProtocolSocket`;`rnConnect(url: string, token: string): ProtocolClient`

- [ ] **Step 1: 写失败的测试**

`apps/app/src/net/pairing.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { ProtocolClient, ProtocolRequest } from '@wechat-cc/protocol'
import { pairWithLink, PairError } from './pairing'
import type { ParsedLink } from './link'

const LINK: ParsedLink = { daemonId: 'r' + 'a'.repeat(26), linkToken: 't' + '0'.repeat(32), relayHost: 'relay.tendhearth.com', relayUrl: 'wss://relay.tendhearth.com/v2/phone?id=r' + 'a'.repeat(26), lan: null }
const DEV = 'd' + '1'.repeat(48)
const MODELS = { default_provider: 'claude', checked_at: null, providers: [], openai: { base_url: '', model: '', has_key: false, aliases: {} }, gemini: { has_key: false }, cheap: '', trusted_providers: null, shared_token: [], guest_blocked: [] }
const STATE = { ok: true, name: '', persona: '', prefs: {}, config: {}, remote: { available: true, enabled: true, devices: [{ id: 'aa11bb22', created_at: 'x', last_seen_at: 'y', current: true }] }, atelier: { model_status: null }, models: MODELS }

type Script = Record<string, { status: number; json: unknown } | Error>
function fakeConnect(byToken: Record<string, { script: Script; version?: 1 | 2 }>) {
  const log: Array<{ token: string; key: string; body?: any }> = []
  const closed: string[] = []
  const connect = (url: string, token: string): ProtocolClient => {
    expect(url).toBe(LINK.relayUrl)
    const cfg = byToken[token] ?? { script: {} }
    return {
      version: () => cfg.version ?? 2,
      async request(r: ProtocolRequest) {
        const key = `${r.method} ${r.path}`
        log.push({ token, key, body: typeof r.body === 'string' ? JSON.parse(r.body) : undefined })
        const out = cfg.script[key]
        if (!out) throw new Error('timeout')
        if (out instanceof Error) throw out
        const text = JSON.stringify(out.json)
        return { status: out.status, headers: {}, body: new TextEncoder().encode(text), text: () => text, json: <T,>() => JSON.parse(text) as T }
      },
      subscribe: () => () => {},
      close: () => { closed.push(token) },
    }
  }
  return { connect, log, closed }
}
const happyDevice = { script: { 'GET /set/api/state': { status: 200, json: STATE }, 'POST /set/api/apply': { status: 200, json: { ok: true } } } }

describe('pairWithLink', () => {
  it('链接令牌配对 → 设备令牌确认 v2 与本机 id → 给本机起名;两条连接都关掉', async () => {
    const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': { status: 200, json: { ok: true, device_token: DEV } } } }, [DEV]: happyDevice })
    const rec = await pairWithLink(LINK, { connect: f.connect, label: 'Tendhearth · iPhone', now: () => 42 })
    expect(rec).toEqual({ v: 1, daemonId: LINK.daemonId, relayHost: LINK.relayHost, relayUrl: LINK.relayUrl, deviceToken: DEV, deviceId: 'aa11bb22', pairedAt: 42 })
    expect(f.log.map(l => `${l.token === DEV ? 'dev' : 'link'} ${l.key}`)).toEqual(['link POST /set/api/pair', 'dev GET /set/api/state', 'dev POST /set/api/apply'])
    expect(f.log[2]?.body).toEqual({ op: 'label_device', id: 'aa11bb22', label: 'Tendhearth · iPhone' })
    expect(f.closed.sort()).toEqual([DEV, LINK.linkToken].sort())
  })
  it('链接令牌过期(auth_failed)⇒ expired,且根本不用设备令牌连', async () => {
    const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': new Error('auth_failed') } } })
    await expect(pairWithLink(LINK, { connect: f.connect, label: 'x' })).rejects.toMatchObject({ code: 'expired' })
    expect(f.log.every(l => l.token === LINK.linkToken)).toBe(true)
  })
  it('设备数满了 ⇒ device_limit', async () => {
    const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': { status: 200, json: { ok: false, error: 'device_limit' } } } } })
    await expect(pairWithLink(LINK, { connect: f.connect, label: 'x' })).rejects.toMatchObject({ code: 'device_limit' })
  })
  it('电脑不在线(daemon_offline / timeout)⇒ offline', async () => {
    for (const err of ['daemon_offline', 'timeout', 'unreachable']) {
      const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': new Error(err) } } })
      await expect(pairWithLink(LINK, { connect: f.connect, label: 'x' })).rejects.toMatchObject({ code: 'offline' })
    }
  })
  it('电脑上的版本太老(协商出 v1)⇒ too_old', async () => {
    const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': { status: 200, json: { ok: true, device_token: DEV } } } }, [DEV]: { ...happyDevice, version: 1 } })
    await expect(pairWithLink(LINK, { connect: f.connect, label: 'x' })).rejects.toMatchObject({ code: 'too_old' })
  })
  it('起名失败不影响配对', async () => {
    const f = fakeConnect({ [LINK.linkToken]: { script: { 'POST /set/api/pair': { status: 200, json: { ok: true, device_token: DEV } } } }, [DEV]: { script: { 'GET /set/api/state': { status: 200, json: STATE }, 'POST /set/api/apply': new Error('timeout') } } })
    expect((await pairWithLink(LINK, { connect: f.connect, label: 'x' })).deviceToken).toBe(DEV)
  })
  it('PairError 带 code', () => { expect(new PairError('expired').code).toBe('expired') })
})
```

`apps/app/src/net/credentials.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeCredentialStore, PAIRING_KEY, PREFS_KEY, type SecureStoreLike } from './credentials'
import type { PairingRecord } from './pairing'

function fakeSS() {
  const m = new Map<string, string>()
  const opts: unknown[] = []
  const ss: SecureStoreLike = {
    async getItemAsync(k, o) { opts.push(o); return m.get(k) ?? null },
    async setItemAsync(k, v, o) { opts.push(o); m.set(k, v) },
    async deleteItemAsync(k) { m.delete(k) },
  }
  return { ss, m, opts }
}
const REC: PairingRecord = { v: 1, daemonId: 'r' + 'a'.repeat(26), relayHost: 'relay.tendhearth.com', relayUrl: 'wss://relay.tendhearth.com/v2/phone?id=r' + 'a'.repeat(26), deviceToken: 'd' + '1'.repeat(48), deviceId: 'aa11bb22', pairedAt: 1 }

describe('credentials', () => {
  it('存取往返;选项原样传给 SecureStore', async () => {
    const f = fakeSS()
    const s = makeCredentialStore(f.ss, { keychainAccessible: 'AFTER_FIRST_UNLOCK' })
    expect(await s.load()).toBeNull()
    await s.save(REC)
    expect(await s.load()).toEqual(REC)
    expect(f.opts).toContainEqual({ keychainAccessible: 'AFTER_FIRST_UNLOCK' })
  })
  it('clear 只清配对,偏好留着', async () => {
    const f = fakeSS()
    const s = makeCredentialStore(f.ss)
    await s.save(REC); await s.savePrefs({ lang: 'zh-Hans' })
    await s.clear()
    expect(f.m.has(PAIRING_KEY)).toBe(false)
    expect(await s.loadPrefs()).toEqual({ lang: 'zh-Hans' })
  })
  it('坏数据(不是 JSON / 形状不对 / 令牌不像设备令牌)⇒ 当没有,并删掉', async () => {
    for (const raw of ['{', JSON.stringify({ ...REC, v: 2 }), JSON.stringify({ ...REC, deviceToken: 't' + '0'.repeat(32) })]) {
      const f = fakeSS(); f.m.set(PAIRING_KEY, raw)
      expect(await makeCredentialStore(f.ss).load()).toBeNull()
      expect(f.m.has(PAIRING_KEY)).toBe(false)
    }
  })
  it('偏好缺省 / 坏数据 ⇒ { lang: null }', async () => {
    const f = fakeSS()
    expect(await makeCredentialStore(f.ss).loadPrefs()).toEqual({ lang: null })
    f.m.set(PREFS_KEY, '{"lang":"fr"}')
    expect(await makeCredentialStore(f.ss).loadPrefs()).toEqual({ lang: null })
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bunx vitest run src/net/pairing.test.ts src/net/credentials.test.ts; echo $?`
Expected: 非 0。

- [ ] **Step 3: 实现**

`apps/app/src/net/pairing.ts`:

```ts
import { PHONE_API_SCHEMAS, type ProtocolClient } from '@wechat-cc/protocol'
import type { ParsedLink } from './link'

export type PairingRecord = { v: 1; daemonId: string; relayHost: string; relayUrl: string; deviceToken: string; deviceId: string; pairedAt: number }
export type PairErrorCode = 'expired' | 'device_limit' | 'offline' | 'too_old' | 'unknown'
export class PairError extends Error {
  constructor(public code: PairErrorCode) { super(code) }
}

const OFFLINE = new Set(['timeout', 'unreachable', 'daemon_offline', 'closed', 'stream_unknown', 'rate_limited', 'quota_exceeded', 'too_many_streams'])
function asPairError(e: unknown): PairError {
  if (e instanceof PairError) return e
  const m = e instanceof Error ? e.message : ''
  if (m === 'auth_failed') return new PairError('expired')
  if (OFFLINE.has(m)) return new PairError('offline')
  return new PairError('unknown')
}
const JSON_HEADERS = { 'content-type': 'application/json' }

/**
 * spec §6:链接令牌(10 分钟、一次性)建连 ⇒ POST /set/api/pair 拿长期设备令牌 ⇒ 换设备令牌重连,
 * 确认协商出 v2(订阅要 v2)并拿到本机设备 id ⇒ 给本机起名(失败不要紧)。两条连接用完都关。
 * 不存任何东西 —— 存钥匙串是调用方(会话)的事,失败的配对不留痕。
 */
export async function pairWithLink(
  link: ParsedLink,
  deps: { connect(url: string, token: string): ProtocolClient; label: string; now?: () => number },
): Promise<PairingRecord> {
  const now = deps.now ?? (() => Date.now())
  let deviceToken: string
  const linkClient = deps.connect(link.relayUrl, link.linkToken)
  try {
    const res = await linkClient.request({ method: 'POST', path: '/set/api/pair', body: '{}', headers: JSON_HEADERS })
    if (res.status === 401) throw new PairError('expired')
    const p = PHONE_API_SCHEMAS['POST /set/api/pair']!.safeParse(res.json())
    if (!p.success) throw new PairError('unknown')
    const data = p.data as { ok: true; device_token: string } | { ok: false; error: 'device_limit' }
    if (!data.ok) throw new PairError('device_limit')
    deviceToken = data.device_token
  } catch (e) {
    throw asPairError(e)
  } finally {
    linkClient.close()
  }

  const dev = deps.connect(link.relayUrl, deviceToken)
  try {
    const res = await dev.request({ method: 'GET', path: '/set/api/state' })
    if (dev.version() !== 2) throw new PairError('too_old')
    const s = PHONE_API_SCHEMAS['GET /set/api/state']!.safeParse(res.json())
    if (!s.success) throw new PairError('unknown')
    const state = s.data as { ok: boolean; remote?: { devices: Array<{ id: string; current: boolean }> } }
    const me = state.ok ? state.remote?.devices.find(x => x.current) : undefined
    if (!me) throw new PairError('unknown')
    try {
      await dev.request({ method: 'POST', path: '/set/api/apply', body: JSON.stringify({ op: 'label_device', id: me.id, label: deps.label }), headers: JSON_HEADERS })
    } catch { /* 名字只是锦上添花 */ }
    return { v: 1, daemonId: link.daemonId, relayHost: link.relayHost, relayUrl: link.relayUrl, deviceToken, deviceId: me.id, pairedAt: now() }
  } catch (e) {
    throw asPairError(e)
  } finally {
    dev.close()
  }
}
```

`apps/app/src/net/credentials.ts`:

```ts
import z from 'zod'
import type { Lang } from '../i18n'
import type { PairingRecord } from './pairing'

export const PAIRING_KEY = 'tendhearth.pairing.v1'
export const PREFS_KEY = 'tendhearth.prefs.v1'
export type Prefs = { lang: Lang | null }

export type SecureStoreLike = {
  getItemAsync(key: string, options?: any): Promise<string | null>
  setItemAsync(key: string, value: string, options?: any): Promise<void>
  deleteItemAsync(key: string, options?: any): Promise<void>
}
export interface CredentialStore {
  load(): Promise<PairingRecord | null>
  save(r: PairingRecord): Promise<void>
  /** 只清配对(撤销 / 解除配对);偏好留着。 */
  clear(): Promise<void>
  loadPrefs(): Promise<Prefs>
  savePrefs(p: Prefs): Promise<void>
}

const Pairing = z.object({
  v: z.literal(1),
  daemonId: z.string().min(1),
  relayHost: z.string().min(1),
  relayUrl: z.string().startsWith('wss://'),
  deviceToken: z.string().regex(/^d[0-9a-f]{48}$/),   // device-store.ts:'d' + 24 字节 hex
  deviceId: z.string().regex(/^[0-9a-f]{8}$/),
  pairedAt: z.number(),
})
const PrefsSchema = z.object({ lang: z.enum(['en', 'zh-Hans']).nullable() })

export function makeCredentialStore(ss: SecureStoreLike, opts: Record<string, unknown> = {}): CredentialStore {
  async function read(key: string): Promise<unknown> {
    const raw = await ss.getItemAsync(key, opts)
    if (raw === null) return undefined
    try { return JSON.parse(raw) } catch { return null }
  }
  return {
    async load() {
      const v = await read(PAIRING_KEY)
      if (v === undefined) return null
      const p = Pairing.safeParse(v)
      if (p.success) return p.data
      await ss.deleteItemAsync(PAIRING_KEY, opts)
      return null
    },
    save: r => ss.setItemAsync(PAIRING_KEY, JSON.stringify(r), opts),
    clear: () => ss.deleteItemAsync(PAIRING_KEY, opts),
    async loadPrefs() {
      const p = PrefsSchema.safeParse(await read(PREFS_KEY))
      return p.success ? p.data : { lang: null }
    },
    savePrefs: p => ss.setItemAsync(PREFS_KEY, JSON.stringify(p), opts),
  }
}
```

`apps/app/src/net/secure-store.ts`:

```ts
import * as SecureStore from 'expo-secure-store'
import { makeCredentialStore } from './credentials'

// AFTER_FIRST_UNLOCK:下一份计划的 iOS 通知扩展要在锁屏后台读推送密钥;与扩展共享的 access group 也在那份计划里加。
export const credentials = makeCredentialStore(SecureStore, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK })
```

`apps/app/src/net/rn-connect.ts`:

```ts
import { makeProtocolClient, type ProtocolClient, type ProtocolSocket } from '@wechat-cc/protocol'
import { makeWsSocket, type WsCtor } from './ws-socket'

/** RN 的全局 WebSocket(形状与 WsLike 一致)。 */
export const rnSocket = (url: string): ProtocolSocket => makeWsSocket(url, WebSocket as unknown as WsCtor)
/** 配对时用的一次性协议客户端。 */
export const rnConnect = (url: string, token: string): ProtocolClient => makeProtocolClient({ open: () => rnSocket(url), token })
```

- [ ] **Step 4: 跑,确认通过**

Run: `cd apps/app && bun run test && bun run typecheck; echo app=$?`
Expected: `app=0`。

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/net
git commit -m "app:配对流程(链接令牌 → 设备令牌)+ 钥匙串存取

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 进程内端到端 —— LiveBackend 与配对对着真 daemon 手机端

复用 `src/daemon/phone-e2e.test.ts` 同一套真东西(中继实现 `makeTunnelHub` + 真面板 + 真工作台,只有执行者是假的 + 真隧道客户端 + 手机事件集线器),手机这头换成 app 自己的 `makeLiveBackend` / `parsePairLink` / `pairWithLink`。放在根目录(根 vitest 跑,bun 与 node 两遍),不进 app 的 vitest。

**Files:**
- Create: `src/daemon/phone-app-live-e2e.test.ts`

**Interfaces:**
- Consumes: `makeLiveBackend`(Task 7)、`parsePairLink`(Task 4)、`pairWithLink`(Task 8)、daemon 的 `unpair_self`(Task 2)、协议包 `onStatus`(Task 1)。

- [ ] **Step 1: 写测试**

```ts
/**
 * phone-app-live-e2e.test.ts — 手机 app 的 LiveBackend 与配对,对着进程内真 daemon 手机端跑
 * (计划 docs/superpowers/plans/2026-09-30-tendhearth-app-live.md Task 9)。
 *
 * 与 phone-e2e.test.ts 同一套真东西:中继实现 + 真面板 + 真工作台(执行者是假的)+ 真隧道客户端 + 手机事件集线器;
 * 手机这头是 apps/app/src 的纯 TS 模块(不引 RN)。线上只有同步转发的内存管道。
 * 夹具有意各自一份:那边测协议,这边测 app 的映射;第三个用户出现再抽共用夹具。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeProtocolClient, type ProtocolSocket } from '@wechat-cc/protocol'
import { openDb, type Db } from '../lib/db'
import { removeTempDir } from '../lib/test-temp'
import { createProviderRegistry } from '../core/provider-registry'
import { makeMatterStore } from '../core/matters/store'
import { makeMattersService } from '../core/matters/service'
import { makeWorkbenchStore } from '../core/workbench/store'
import { makeWorkbenchService, type WorkbenchService } from '../core/workbench/service'
import { MANAGED_NATIVE_CAPABILITIES } from '../core/workbench/executor-capabilities'
import { makeSettingsPanel, type SettingsPanel } from './settings-panel'
import { makeTunnelHub, type TunnelHub } from '../../relay/tunnel'
import { makeTunnelClient, type TunnelClient, type TunnelWS } from './tunnel-client'
import { makePhoneEventsWiring } from './phone-topic-sources'
import { makeLiveBackend } from '../../apps/app/src/backend/live'
import type { Backend, ConnState } from '../../apps/app/src/backend/types'
import { parsePairLink } from '../../apps/app/src/net/link'
import { pairWithLink } from '../../apps/app/src/net/pairing'

const DAEMON = 't' + 'a'.repeat(36)   // 老中继 id 的形状,好让 parsePairLink 认;内存中继只拿它当键

let root: string, managedRoot: string, db: Db
let workbench: WorkbenchService, panel: SettingsPanel, hub: TunnelHub, tunnel: TunnelClient
let wiring: ReturnType<typeof makePhoneEventsWiring>
let deviceToken: string
let handled: string[]
const gates: Array<{ path: string; finish: () => void }> = []
const backends: Backend[] = []
const phones = new Set<() => void>()

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-live-')))
  managedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-live-managed-')))
  db = openDb({ path: join(root, 'state.db') })
  const matters = makeMatterStore(db), store = makeWorkbenchStore(db)
  gates.length = 0; handled = []
  const registry = createProviderRegistry()
  // 假执行者:init ⇒(路径以 ask 结尾先要一次权限)⇒ 等闸门 ⇒ 一段文字 ⇒ 收工。与 phone-e2e.test.ts 相同。
  registry.register('claude', { async spawn(project, ctx) {
    let finish!: () => void
    const gate = new Promise<void>(r => { finish = r })
    gates.push({ path: project.path, finish })
    return {
      async *dispatch() {
        yield { kind: 'init' as const, sessionId: 'e2e-native' }
        if (project.path.endsWith('ask')) await ctx.requestPermission!({ tool: 'Bash', description: 'Remove the one scratch probe file' })
        await gate
        yield { kind: 'text' as const, text: '做完了' }
        yield { kind: 'result' as const, sessionId: 'e2e-native', numTurns: 1, durationMs: 1 }
      },
      async close() { finish() },
    }
  } }, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  workbench = makeWorkbenchService({ store, registry, stateDir: root, managedWorkspaceRoot: managedRoot, ownerChatId: () => 'owner', defaultProvider: 'claude', matters, retainedIdleCloseMs: 0, handoffGraceMs: 0 })
  const service = makeMattersService({ store: matters, workbench })
  panel = makeSettingsPanel({
    stateDir: root, ownerChatId: () => 'owner', chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {}, log: () => {},
    // 设备列表只在接了 remote 时返回(settings-panel.ts state())。
    remote: { isEnabled: () => true, setEnabled: () => {}, requestRestart: () => {} },
    insight: { forMatter: async (_id, lang) => ({ explanations: {}, progress: { summary: `summary-${lang}`, steps: [], source: 'raw' as const } }) },
    changes: () => [],
    matters: { ...service, say: (id, text, input) => service.say(id, text, 'phone', input), seenOnPhone: id => { matters.bind(id, 'phone', 'pwa') } },
  })
  const link = panel.issueToken()
  const paired = await (await panel.handleRequest(new Request(`http://127.0.0.1/set/api/pair?t=${link}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))).json() as { device_token: string }
  deviceToken = paired.device_token

  wiring = makePhoneEventsWiring({ workbench, matters, home: panel.home, changes: workbench.changes, pollMs: 40 })
  hub = makeTunnelHub()
  let incoming: ((ev: { data?: unknown }) => void) | undefined
  const daemonSocket: TunnelWS = {
    readyState: 1,
    send(raw) { hub.onDaemonFrame(DAEMON, raw) },
    close() {},
    addEventListener(type, handler) { if (type === 'message') incoming = handler },
  }
  hub.registerDaemon(DAEMON, { readyState: 1, send(raw) { incoming?.({ data: raw }) }, close() {} })
  tunnel = makeTunnelClient({
    daemonId: DAEMON,
    knownDeviceTokens: () => panel.deviceTokens(),
    activeLinkToken: () => panel.activeLinkToken(),
    handleRequest: req => { handled.push(`${req.method} ${new URL(req.url).pathname}`); return panel.handleRequest(req) },
    connect: () => daemonSocket,
    reconnectMs: 50,
    events: wiring.events,
    log: () => {},
  })
  tunnel.start()
})

afterEach(async () => {
  for (const b of backends.splice(0)) b.dispose()
  tunnel?.stop()
  wiring?.dispose()
  for (const g of gates) g.finish()
  await workbench?.shutdown()
  db?.close()
  removeTempDir(root); removeTempDir(managedRoot)
})

/** 一条手机 ↔ 中继的内存 WebSocket(同 phone-e2e.test.ts 的 phoneLine,去掉了 v1 改写)。 */
function phoneSocket(): ProtocolSocket {
  let onMsg: ((s: string) => void) | undefined, onClose: (() => void) | undefined, onOpen: (() => void) | undefined
  let dead = false
  let streamId = ''
  const kill = () => { if (dead) return; dead = true; phones.delete(kill); hub.dropPhone(streamId); onClose?.() }
  streamId = hub.attachPhone(DAEMON, { readyState: 1, send(raw) { if (!dead) onMsg?.(raw) }, close() { kill() } }).streamId!
  phones.add(kill)
  setTimeout(() => { if (!dead) onOpen?.() }, 0)
  return {
    send(s) { if (!dead) hub.onPhoneFrame(streamId, s) },
    close: kill,
    onOpen(cb) { onOpen = cb },
    onMessage(cb) { onMsg = cb },
    onClose(cb) { onClose = cb },
  }
}
const dropAllPhones = () => { for (const k of [...phones]) k() }
function live(token = deviceToken): Backend {
  const b = makeLiveBackend({ open: phoneSocket, token, clientOpts: { requestTimeoutMs: 3000 } })
  backends.push(b)
  return b
}
function createTask(name: string) {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return workbench.create({ path, providerId: 'claude', text: name })
}
const release = (task: { path: string }) => { const i = gates.findIndex(g => g.path === task.path); gates.splice(i, 1)[0]!.finish() }

describe('手机 app LiveBackend 对着进程内真 daemon', () => {
  it('读:列表 / 详情 / 说明(lang 传到 daemon)/ 改动都过 schema;连上后 online、有同步时间', async () => {
    const b = live()
    const agents: unknown[] = []
    b.subscribe('agents', d => agents.push(d))
    await expect.poll(() => b.connection().state).toBe('online')
    await expect.poll(() => agents.length).toBeGreaterThan(0)
    const task = createTask('read-me')
    await expect.poll(async () => (await b.matters('en')).map(m => m.id)).toContain(task.id)
    expect((await b.matter(task.id, 'en')).task?.id).toBe(task.id)
    expect(await b.insight(task.id, 'zh-Hans')).toEqual({ explanations: {}, progress: { summary: 'summary-zh-Hans', steps: [], source: 'raw' } })
    expect(await b.changes(task.id)).toBeNull()
    expect(b.connection().lastSyncedAt).not.toBeNull()
    release(task)
  })

  it('批准:允许一次成功;同一条再提交 ⇒ stale', async () => {
    const b = live()
    const task = createTask('needs-ask')
    await expect.poll(async () => (await b.matter(task.id, 'en')).permissions.length).toBe(1)
    const d = await b.matter(task.id, 'en')
    const p = { id: task.id, runId: d.runId!, requestId: d.permissions[0]!.id, decision: 'allow' as const }
    await b.decide(p)
    await expect(b.decide(p)).rejects.toMatchObject({ code: 'stale' })
    release(task)
  })

  it('配对:链接 → 链接令牌配对 → 设备令牌能用、带名字;改名;本机解除配对后该令牌 revoked', async () => {
    const parsed = parsePairLink(`https://relay.example/pset/#id=${DAEMON}&t=${panel.issueToken()}&p=%2Fset&lan=10.0.0.2:1`)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const rec = await pairWithLink(parsed.link, { connect: (_url, token) => makeProtocolClient({ open: phoneSocket, token, requestTimeoutMs: 3000 }), label: 'Tendhearth · test' })
    expect(rec.deviceToken).toMatch(/^d[0-9a-f]{48}$/)
    const b = live(rec.deviceToken)
    expect((await b.devices()).find(x => x.current)).toMatchObject({ id: rec.deviceId, label: 'Tendhearth · test' })
    await b.renameDevice('My phone')
    expect((await b.devices()).find(x => x.current)?.label).toBe('My phone')
    await b.unpair()
    const again = live(rec.deviceToken)
    await expect(again.matters('en')).rejects.toMatchObject({ code: 'revoked' })
    expect(again.connection().state).toBe('revoked')
    // 别的设备不受影响
    expect((await live().matters('en'))).toBeInstanceOf(Array)
  })

  it('过期 / 用过的链接令牌 ⇒ expired', async () => {
    const stale = panel.issueToken()
    panel.issueToken()                         // 新发一枚,旧的随即作废(同一时刻只一枚)
    const parsed = parsePairLink(`https://relay.example/pset/#id=${DAEMON}&t=${stale}`)
    if (!parsed.ok) throw new Error('parse')
    await expect(pairWithLink(parsed.link, { connect: (_url, token) => makeProtocolClient({ open: phoneSocket, token, requestTimeoutMs: 3000 }), label: 'x' })).rejects.toMatchObject({ code: 'expired' })
  })

  it('电脑上忘掉所有设备 ⇒ 连接变 revoked,之后的提交一条都不发出', async () => {
    const b = live()
    b.subscribe('agents', () => {})
    await expect.poll(() => b.connection().state).toBe('online')
    expect((await panel.apply({ op: 'forget_devices' })).ok).toBe(true)
    const task = createTask('after-revoke')     // 有变化 ⇒ 集线器发事件前核对令牌 ⇒ 明文 auth_failed
    await expect.poll(() => b.connection().state, { timeout: 5000 }).toBe('revoked')
    const before = handled.length
    await expect(b.say(task.id, 'hi')).rejects.toMatchObject({ code: 'revoked' })
    expect(handled.length).toBe(before)
    release(task)
  })

  it('中继断了手机这条 ⇒ offline → online(epoch 前进),订阅续上;重连只重挂订阅,不重发任何提交', async () => {
    const b = live()
    const states: ConnState[] = []
    b.onConnection(c => states.push(c.state))
    const got: Array<{ tasks: Array<{ id: string }> }> = []
    b.subscribe<{ tasks: Array<{ id: string }> }>('agents', d => got.push(d))
    await expect.poll(() => b.connection().epoch).toBe(1)
    const posts = () => handled.filter(h => h.startsWith('POST')).length
    const p0 = posts()
    dropAllPhones()
    await expect.poll(() => b.connection().epoch, { timeout: 5000 }).toBe(2)
    expect(states).toContain('offline')
    expect(posts()).toBe(p0)
    const task = createTask('after-drop')
    await expect.poll(() => got.at(-1)?.tasks.map(t => t.id)).toEqual([task.id])
    release(task)
  })

  it('前后台:setActive(false) 关连接;setActive(true) 新握手、订阅重挂', async () => {
    const b = live()
    const got: unknown[] = []
    b.subscribe('agents', d => got.push(d))
    await expect.poll(() => b.connection().epoch).toBe(1)
    b.setActive(false)
    await expect.poll(() => phones.size).toBe(0)
    b.setActive(true)
    await expect.poll(() => b.connection().epoch).toBe(2)
    const task = createTask('after-resume')
    await expect.poll(() => (got.at(-1) as { tasks: Array<{ id: string }> }).tasks.map(t => t.id)).toEqual([task.id])
    release(task)
  })
})
```

- [ ] **Step 2: 跑**

Run:
```bash
bun --bun vitest run src/daemon/phone-app-live-e2e.test.ts; echo bun=$?
npx vitest run -c vitest.node.config.ts src/daemon/phone-app-live-e2e.test.ts; echo node=$?
```
Expected: 前面 Task 1–8 都做完时两边都 `0`。若某条红,先按 superpowers:systematic-debugging 找根因(常见:`makeSettingsPanel` 的 deps 类型与这里写的不完全一致 —— 以 `SettingsPanelDeps` 为准改夹具,不改 daemon);**不要**为了让它绿去放宽 LiveBackend 的错误映射。

- [ ] **Step 3: 根目录类型检查与模块边界**

Run:
```bash
bun run typecheck; echo tc=$?
bun run depcheck; echo dep=$?
```
Expected: `tc=0`、`dep=0`。这是「被根目录测试 import 的 app 文件在根 tsconfig 下也要过」那条约束第一次被真正检查;报错就按 Global Constraints 改 app 文件(`import type`、下标判空),别把测试挪走。

- [ ] **Step 4: Commit**

```bash
git add src/daemon/phone-app-live-e2e.test.ts apps/app/src
git commit -m "test:手机 app LiveBackend + 配对 对着进程内真 daemon 手机端端到端

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 会话落钥匙串 + 真 / 演示后端切换 + 连接提示 + 回答上限提示

**Files:**
- Create: `apps/app/src/view/connection.ts`、`apps/app/src/ui/ConnectionNotice.tsx`
- Modify: `apps/app/src/state/session.tsx`、`apps/app/src/state/BackendProvider.tsx`、`apps/app/src/app/_layout.tsx`、`apps/app/src/view/approval.ts`、`apps/app/src/app/approval/[id].tsx`、`apps/app/src/app/compose.tsx`、`apps/app/src/app/(tabs)/index.tsx`、`apps/app/src/app/(tabs)/together.tsx`、`apps/app/src/app/matter/[id].tsx`、`apps/app/src/i18n/en.ts`、`apps/app/src/i18n/zh-Hans.ts`
- Test: `apps/app/src/view/connection.test.ts`、`apps/app/src/view/approval.test.ts`

**Interfaces:**
- Consumes: `CredentialStore`、`credentials`(Task 8);`PairingRecord`(Task 8);`makeLiveBackend`(Task 7);`rnSocket`(Task 8);`shouldRevalidate`(Task 4);`store.revalidateAll / setLang`(Task 5)。
- Produces:
  - `connectionNotice(c: Connection, now: number, lang: Lang): null | { kind: 'connecting' | 'offline' | 'revoked'; text: string }`;`formatSynced(ts: number, now: number, lang: Lang): string`
  - `<ConnectionNotice />`(testID:`conn-notice-connecting` / `conn-notice-offline` / `conn-notice-revoked`,重新配对按钮 `conn-repair`)
  - `answersTooLong(answers: Record<string, string[]> | null): boolean`
  - `useSession()` 新增:`ready: boolean`、`pairing: PairingRecord | null`、`setPaired(r): Promise<void>`、`dropStoredPairing(): void`、`forgetPairing(): Promise<void>`;`SessionProvider` 新增必填 prop `store: CredentialStore`
  - `BackendProvider` props:`{ children; backend?: Backend; lang: Lang; pairing: PairingRecord | null; onRevoked(): void }`

- [ ] **Step 1: 写失败的测试**

`apps/app/src/view/connection.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { connectionNotice, formatSynced } from './connection'

const at = (h: number, m: number, day = 30) => new Date(2026, 8, day, h, m).getTime()

describe('formatSynced', () => {
  it('一分钟内 ⇒ 刚刚', () => {
    expect(formatSynced(at(14, 5), at(14, 5) + 30_000, 'zh-Hans')).toBe('刚刚')
    expect(formatSynced(at(14, 5), at(14, 5) + 30_000, 'en')).toBe('just now')
  })
  it('同一天 ⇒ HH:MM', () => { expect(formatSynced(at(9, 7), at(14, 0), 'en')).toBe('09:07') })
  it('不是同一天 ⇒ 带日期', () => {
    expect(formatSynced(at(23, 50, 29), at(8, 0), 'en')).toBe('9/29 23:50')
    expect(formatSynced(at(23, 50, 29), at(8, 0), 'zh-Hans')).toBe('9月29日 23:50')
  })
})

describe('connectionNotice', () => {
  const now = at(14, 0)
  it('在线 ⇒ 不提示', () => { expect(connectionNotice({ state: 'online', lastSyncedAt: now, epoch: 1 }, now, 'en')).toBeNull() })
  it('连接中', () => { expect(connectionNotice({ state: 'connecting', lastSyncedAt: null, epoch: 0 }, now, 'en')?.kind).toBe('connecting') })
  it('离线且同步过 ⇒ 说出上次同步时间', () => {
    const n = connectionNotice({ state: 'offline', lastSyncedAt: at(13, 42), epoch: 1 }, now, 'en')
    expect(n).toEqual({ kind: 'offline', text: expect.stringContaining('13:42') })
  })
  it('冷启动就离线(从没同步过)⇒「暂时连不上」,不提同步时间', () => {
    const n = connectionNotice({ state: 'offline', lastSyncedAt: null, epoch: 0 }, now, 'zh-Hans')
    expect(n?.kind).toBe('offline')
    expect(n?.text).toContain('暂时连不上')
    expect(n?.text).not.toContain('同步')
  })
  it('撤销与离线是两种提示', () => {
    const r = connectionNotice({ state: 'revoked', lastSyncedAt: at(13, 0), epoch: 1 }, now, 'en')
    const o = connectionNotice({ state: 'offline', lastSyncedAt: at(13, 0), epoch: 1 }, now, 'en')
    expect(r?.kind).toBe('revoked')
    expect(r?.text).not.toBe(o?.text)
  })
})
```

在 `apps/app/src/view/approval.test.ts` 末尾加:

```ts
import { answersTooLong } from './approval'

describe('answersTooLong(与 daemon 的 20 000 字 JSON 上限一致)', () => {
  it('null 与短回答 ⇒ false;JSON 超过 20 000 ⇒ true', () => {
    expect(answersTooLong(null)).toBe(false)
    expect(answersTooLong({ q: ['ok'] })).toBe(false)
    expect(answersTooLong({ q: ['x'.repeat(19_980)] })).toBe(false)
    expect(answersTooLong({ q: ['x'.repeat(20_000)] })).toBe(true)
  })
})
```

(若该测试文件顶部已经有 import 语句块,把 `answersTooLong` 并进现有的 `from './approval'` import。)

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bunx vitest run src/view/connection.test.ts src/view/approval.test.ts; echo $?`
Expected: 非 0。

- [ ] **Step 3: 文案**

`en.ts` 加(并删掉 `'pair.comingSoon'`,两份表一起删):

```ts
  'conn.connecting': 'Connecting to your home computer…',
  'conn.offline': 'Your home computer is offline. Showing what was synced at {time}. You can still write a draft.',
  'conn.offlineNever': 'Can’t reach your home computer right now. You can still write a draft.',
  'conn.justNow': 'just now',
  'conn.revokedTitle': 'This phone is no longer paired',
  'conn.revokedBody': 'Your computer removed this phone, so nothing can be sent from here. Pair again to keep going.',
  'conn.repair': 'Pair again',
  'approval.answerTooLong': 'This answer is too long to send. Please shorten it.',
```

`zh-Hans.ts` 加:

```ts
  'conn.connecting': '正在连接家里的电脑…',
  'conn.offline': '家里的电脑暂时不在线。这里是 {time} 同步的内容,你仍可以先写草稿。',
  'conn.offlineNever': '暂时连不上家里的电脑。你仍可以先写草稿。',
  'conn.justNow': '刚刚',
  'conn.revokedTitle': '这台手机已不再配对',
  'conn.revokedBody': '电脑那边移除了这台手机,这里发不出任何东西了。重新配对就能继续。',
  'conn.repair': '重新配对',
  'approval.answerTooLong': '这个回答太长了,发不出去。请删短一些。',
```

- [ ] **Step 4: 视图模型**

`apps/app/src/view/connection.ts`:

```ts
import type { Connection } from '../backend/types'
import { t, type Lang } from '../i18n'

const pad = (n: number) => String(n).padStart(2, '0')

/** 上次同步时间:一分钟内「刚刚」;同一天 HH:MM;否则带月日。用本地时区。 */
export function formatSynced(ts: number, now: number, lang: Lang): string {
  if (now - ts < 60_000) return t(lang, 'conn.justNow')
  const d = new Date(ts), n = new Date(now)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return hm
  return lang === 'zh-Hans' ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

/** spec §3:离线显示上次同步时间;撤销与离线分开表达;在线不提示。 */
export function connectionNotice(c: Connection, now: number, lang: Lang): null | { kind: 'connecting' | 'offline' | 'revoked'; text: string } {
  if (c.state === 'online') return null
  if (c.state === 'revoked') return { kind: 'revoked', text: t(lang, 'conn.revokedBody') }
  if (c.state === 'connecting') return { kind: 'connecting', text: t(lang, 'conn.connecting') }
  return {
    kind: 'offline',
    text: c.lastSyncedAt === null ? t(lang, 'conn.offlineNever') : t(lang, 'conn.offline', { time: formatSynced(c.lastSyncedAt, now, lang) }),
  }
}
```

`apps/app/src/view/approval.ts` 末尾:

```ts
import { PHONE_ANSWER_MAX_JSON } from '@wechat-cc/protocol'
/** 与 daemon POST /m/api/matter/answer 的上限一致:超了就在手机上拦下,不发。 */
export function answersTooLong(answers: Record<string, string[]> | null): boolean {
  return answers !== null && JSON.stringify(answers).length > PHONE_ANSWER_MAX_JSON
}
```

(import 挪到文件顶部。)

- [ ] **Step 5: 会话与后端接线**

`apps/app/src/state/session.tsx` 换成:

```tsx
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Lang } from '../i18n'
import { LangOverrideCtx } from '../i18n/useLang'
import type { CredentialStore } from '../net/credentials'
import type { PairingRecord } from '../net/pairing'

// 会话:配对记录与语言偏好落钥匙串;「已看过欢迎页」= 已配对,或这次打开点过「先看看」。
type Session = {
  ready: boolean
  pairing: PairingRecord | null
  setPaired(r: PairingRecord): Promise<void>
  /** 被电脑撤销:只清钥匙串;内存里的配对留着,后端停在 revoked,页面显示最后同步的内容 + 重新配对。 */
  dropStoredPairing(): void
  /** 用户解除配对:钥匙串与内存都清,回欢迎页。 */
  forgetPairing(): Promise<void>
  seenWelcome: boolean
  markWelcomeSeen(): void
  setSeenWelcome(v: boolean): void
  langOverride: Lang | null
  setLangOverride(l: Lang | null): void
}

const SessionCtx = createContext<Session | null>(null)

export function SessionProvider({ children, store }: { children: ReactNode; store: CredentialStore }) {
  const [ready, setReady] = useState(false)
  const [pairing, setPairing] = useState<PairingRecord | null>(null)
  const [seenWelcome, setSeen] = useState(false)
  const [langOverride, setLang] = useState<Lang | null>(null)
  useEffect(() => {
    let alive = true
    Promise.all([store.load(), store.loadPrefs()]).then(
      ([p, prefs]) => { if (!alive) return; setPairing(p); setSeen(p !== null); setLang(prefs.lang); setReady(true) },
      () => { if (alive) setReady(true) }, // 钥匙串读不出来 ⇒ 当没配对
    )
    return () => { alive = false }
  }, [store])
  const value = useMemo<Session>(() => ({
    ready, pairing,
    async setPaired(r) { await store.save(r); setPairing(r); setSeen(true) },
    dropStoredPairing() { void store.clear() },
    async forgetPairing() { await store.clear(); setPairing(null); setSeen(false) },
    seenWelcome, markWelcomeSeen: () => setSeen(true), setSeenWelcome: setSeen,
    langOverride,
    setLangOverride(l) { setLang(l); void store.savePrefs({ lang: l }) },
  }), [ready, pairing, seenWelcome, langOverride, store])
  return (
    <SessionCtx.Provider value={value}>
      <LangOverrideCtx.Provider value={langOverride}>{children}</LangOverrideCtx.Provider>
    </SessionCtx.Provider>
  )
}

export function useSession(): Session {
  const s = useContext(SessionCtx)
  if (!s) throw new Error('SessionProvider missing')
  return s
}
```

`apps/app/src/state/BackendProvider.tsx` 换成:

```tsx
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { AppState } from 'react-native'
import type { Backend } from '../backend/types'
import type { Lang } from '../i18n'
import { makeDemoBackend } from '../backend/demo'
import { makeLiveBackend } from '../backend/live'
import { shouldRevalidate } from '../net/connection'
import type { PairingRecord } from '../net/pairing'
import { rnSocket } from '../net/rn-connect'
import { clearDrafts } from './drafts'
import { makeStore, type Store } from './store'

type Ctx = { backend: Backend; store: Store; resetDemo(): void }
const BackendCtx = createContext<Ctx | null>(null)

// 有配对记录 ⇒ 真连接后端;没有 ⇒ 演示后端。换配对(配上 / 解除)就整个换掉后端与 store。
export function BackendProvider({ children, backend: injected, lang, pairing, onRevoked }: {
  children: ReactNode; backend?: Backend; lang: Lang; pairing: PairingRecord | null; onRevoked(): void
}) {
  const value = useMemo<Ctx>(() => {
    const demo = injected || pairing ? null : makeDemoBackend({ lang })
    const b = injected ?? (pairing
      ? makeLiveBackend({ open: () => rnSocket(pairing.relayUrl), token: pairing.deviceToken, log: l => { if (__DEV__) console.log(`[live] ${l}`) } })
      : demo!)
    return { backend: b, store: makeStore(b, { lang }), resetDemo: () => { clearDrafts(); demo?.reset() } }
    // lang 只用于初次创建;之后走 store.setLang
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injected, pairing])
  useEffect(() => () => value.backend.dispose(), [value])
  useEffect(() => { value.store.setLang(lang) }, [value, lang])

  // 重连(epoch 前进)⇒ 全部查询重新验证(只重拉读,草稿与提交从不自动发);撤销 ⇒ 让会话清钥匙串(只一次)。
  const revoked = useRef(onRevoked)
  revoked.current = onRevoked
  useEffect(() => {
    let prev = value.backend.connection()
    let told = false
    return value.backend.onConnection(c => {
      if (shouldRevalidate(prev, c)) value.store.revalidateAll()
      if (c.state === 'revoked' && !told) { told = true; revoked.current() }
      prev = c
    })
  }, [value])

  // 回到前台立刻新握手(iOS 在后台会掐 socket,别等协议客户端的退避);进后台就关。
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') value.backend.setActive(true)
      else if (s === 'background') value.backend.setActive(false)
    })
    return () => sub.remove()
  }, [value])

  return <BackendCtx.Provider value={value}>{children}</BackendCtx.Provider>
}

export function useBackendCtx(): Ctx {
  const c = useContext(BackendCtx)
  if (!c) throw new Error('BackendProvider missing')
  return c
}
```

`apps/app/src/app/_layout.tsx`:
1. 删掉顶部 `import '@wechat-cc/protocol'` 与那两行注释(真后端的 import 接替了它)。
2. `import { credentials } from '../net/secure-store'`、`import { useSession } from '../state/session'`、`import { View } from 'react-native'`(与已有 `useColorScheme` 合并)。
3. `<SessionProvider>` → `<SessionProvider store={credentials}>`。
4. `Themed()` 里:

```tsx
  const session = useSession()
  …
  if (!session.ready) return <View style={{ flex: 1, backgroundColor: c.bg }} />
  return (
    <BackendProvider lang={lang} pairing={session.pairing} onRevoked={session.dropStoredPairing}>
```

5. `Stack` 里加 `<Stack.Screen name="pair" />`、`<Stack.Screen name="devices" />` 不需要(文件路由自动登记);保持不动。

- [ ] **Step 6: 连接提示组件与放置**

`apps/app/src/ui/ConnectionNotice.tsx`:

```tsx
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Text } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useConnection } from '../state/hooks'
import { connectionNotice } from '../view/connection'
import { Button } from './Button'
import { Card } from './Card'
import { space } from './tokens'
import { useTheme } from './useTheme'

// 离线 / 连接中 / 已撤销 的一句话(spec §3)。在线时什么都不渲染。撤销给「重新配对」按钮。
export function ConnectionNotice() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id) }, [])
  const n = connectionNotice(conn, now, lang)
  if (!n) return null
  if (n.kind === 'revoked') {
    return (
      <Card testID="conn-notice-revoked" style={{ gap: space.s }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 16, fontWeight: '600' }}>{t(lang, 'conn.revokedTitle')}</Text>
        <Text accessibilityLiveRegion="polite" style={{ color: c.muted, fontSize: 14, lineHeight: 20 }}>{n.text}</Text>
        <Button kind="primary" testID="conn-repair" label={t(lang, 'conn.repair')} onPress={() => router.push('/pair')} />
      </Card>
    )
  }
  return (
    <Text testID={`conn-notice-${n.kind}`} accessibilityLiveRegion="polite" style={{ color: n.kind === 'offline' ? c.warn : c.muted, fontSize: 14, lineHeight: 20, textAlign: 'center' }}>
      {n.text}
    </Text>
  )
}
```

放置(演示后端恒在线,所以演示模式与 Maestro 看不到它):
- `approval/[id].tsx`:`status` 里那行 `{!online ? <Text testID="approval-offline" …>{t(lang, 'common.computerOffline')}</Text> : null}` 换成 `<ConnectionNotice />`;问题表单的 `onSubmit` 改成先拦超长:

```tsx
        onSubmit={answers => {
          if (answersTooLong(answers)) { setOutcome({ requestId: v.requestId, kind: 'tooLong' }); return }
          void send(v.requestId, `answer:${v.requestId}`, 'answer', () => backend.answer({ id, runId: v.runId, requestId: v.requestId, answers }))
        }}
```

  `Outcome` 类型的 `kind` 联合加 `'tooLong'`;`status` 里加一行 `{shownOutcome === 'tooLong' ? <Text testID="approval-too-long" accessibilityLiveRegion="polite" style={{ color: c.warn, fontSize: 14, lineHeight: 20 }}>{t(lang, 'approval.answerTooLong')}</Text> : null}`。`send()` 里 `r.error === 'revoked'` 不单独处理:按钮已因 `online === false` 锁住,`ConnectionNotice` 显示撤销卡。
- `compose.tsx`:`{!online ? <Text testID="compose-offline" …/> : null}` 换成 `<ConnectionNotice />`。
- `(tabs)/index.tsx`、`(tabs)/together.tsx`、`matter/[id].tsx`:在 `TopBar` 之后、内容最上面各放一个 `<ConnectionNotice />`(外面包 `<View style={{ paddingHorizontal: space.xl }}>`)。
- 若 `common.computerOffline` 已没有引用,两份文案表一起删掉这个键。

- [ ] **Step 7: 跑,确认通过**

Run: `cd apps/app && bun run test && bun run typecheck && bun run export:check; echo app=$?`
Expected: `app=0`。

- [ ] **Step 8: Commit**

```bash
git add apps/app/src
git commit -m "app:会话落钥匙串、真 / 演示后端切换、重连重拉、前后台、撤销与离线分开提示、回答上限

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 配对页 —— 扫码 / 粘贴 / 确认 / 连接

**Files:**
- Create: `apps/app/src/view/pair.ts`、`apps/app/.maestro/pair-invalid.yaml`
- Modify: `apps/app/src/app/pair.tsx`、`apps/app/app.json`、`apps/app/src/i18n/en.ts`、`apps/app/src/i18n/zh-Hans.ts`、`apps/app/README.md`(Maestro 表格)
- Test: `apps/app/src/view/pair.test.ts`

**Interfaces:**
- Consumes: `parsePairLink`、`LinkError`(Task 4);`pairWithLink`、`PairError`、`PairErrorCode`(Task 8);`rnConnect`(Task 8);`useSession().setPaired`(Task 10)。
- Produces:`linkErrorKey(e: LinkError): MessageKey`、`pairErrorKey(e: PairErrorCode): MessageKey`;配对页 testID:`pair-steps`、`pair-scan`、`pair-camera`、`pair-cancel-scan`、`pair-paste-input`、`pair-use-pasted`、`pair-confirm`、`pair-connect`、`pair-error`、`pair-open-settings`。

- [ ] **Step 1: 写失败的测试**

`apps/app/src/view/pair.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import en from '../i18n/en'
import { linkErrorKey, pairErrorKey } from './pair'

describe('配对错误 → 文案键', () => {
  it('每种链接错误、配对错误都有自己的一句话,键都在文案表里', () => {
    const keys = [
      ...(['not_a_link', 'remote_off', 'bad_link'] as const).map(linkErrorKey),
      ...(['expired', 'device_limit', 'offline', 'too_old', 'unknown'] as const).map(pairErrorKey),
    ]
    for (const k of keys) expect(en[k]).toBeTruthy()
    expect(new Set(keys).size).toBe(keys.length)
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bunx vitest run src/view/pair.test.ts; echo $?`
Expected: 非 0。

- [ ] **Step 3: 文案**

`en.ts` 加:

```ts
  'pair.scan': 'Scan the code',
  'pair.cancelScan': 'Cancel',
  'pair.pasteHint': 'Can’t scan? Copy the link under the code on your computer and paste it here.',
  'pair.pastePlaceholder': 'https://…/pset/#id=…',
  'pair.usePasted': 'Use this link',
  'pair.confirmTitle': 'Connect to your computer?',
  'pair.confirmBody': 'This phone will reach your computer through {host}. Everything is end-to-end encrypted; the relay can’t read it.',
  'pair.connect': 'Connect',
  'pair.working': 'Connecting…',
  'pair.cameraDenied': 'Tendhearth uses the camera only to scan the pairing code. Allow it in Settings, or paste the link instead.',
  'pair.openSettings': 'Open Settings',
  'pair.errNotALink': 'That isn’t a Tendhearth pairing code. On your computer choose “Use on phone” and scan the code there.',
  'pair.errBadLink': 'This pairing link looks damaged. Show a new code on your computer and try again.',
  'pair.errRemoteOff': 'Your computer only lets phones in on the same Wi-Fi. Turn on “Use when away” in Tendhearth on your computer, then scan the new code.',
  'pair.errExpired': 'This code has expired (codes last 10 minutes). Show a new one on your computer.',
  'pair.errDeviceLimit': 'Your computer already has the most paired devices it allows. Remove one on your computer first.',
  'pair.errOffline': 'Couldn’t reach your computer. Make sure it’s on and Tendhearth is running, then try again.',
  'pair.errTooOld': 'Tendhearth on your computer needs an update before this app can connect.',
  'pair.errUnknown': 'Pairing didn’t work. Show a new code on your computer and try again.',
```

`zh-Hans.ts` 加:

```ts
  'pair.scan': '扫码',
  'pair.cancelScan': '取消',
  'pair.pasteHint': '扫不了?把电脑上二维码下面的链接复制过来,粘贴在这里。',
  'pair.pastePlaceholder': 'https://…/pset/#id=…',
  'pair.usePasted': '用这个链接',
  'pair.confirmTitle': '连接你的电脑?',
  'pair.confirmBody': '这台手机会经 {host} 连到你的电脑。全程端到端加密,中继看不到内容。',
  'pair.connect': '连接',
  'pair.working': '正在连接…',
  'pair.cameraDenied': 'Tendhearth 只用相机扫配对码。可以在系统设置里允许,或者直接粘贴链接。',
  'pair.openSettings': '打开设置',
  'pair.errNotALink': '这不是 Tendhearth 的配对码。请在电脑上选择「手机上用」,扫那里显示的码。',
  'pair.errBadLink': '这个配对链接好像不完整。请在电脑上刷新一个新码再试。',
  'pair.errRemoteOff': '你的电脑现在只让同一 Wi-Fi 下的手机连。请在电脑上的 Tendhearth 里打开「出门也能用」,再扫新的码。',
  'pair.errExpired': '这个码过期了(每个码只管 10 分钟)。请在电脑上刷新一个新码。',
  'pair.errDeviceLimit': '电脑上已配对的设备到上限了。请先在电脑上移除一台。',
  'pair.errOffline': '连不上你的电脑。确认电脑开着、Tendhearth 在运行,再试一次。',
  'pair.errTooOld': '电脑上的 Tendhearth 需要先更新,才能和这个 app 连接。',
  'pair.errUnknown': '配对没成功。请在电脑上刷新一个新码再试。',
```

- [ ] **Step 4: 实现**

`apps/app/src/view/pair.ts`:

```ts
import type { MessageKey } from '../i18n'
import type { LinkError } from '../net/link'
import type { PairErrorCode } from '../net/pairing'

export function linkErrorKey(e: LinkError): MessageKey {
  return e === 'remote_off' ? 'pair.errRemoteOff' : e === 'bad_link' ? 'pair.errBadLink' : 'pair.errNotALink'
}
export function pairErrorKey(e: PairErrorCode): MessageKey {
  switch (e) {
    case 'expired': return 'pair.errExpired'
    case 'device_limit': return 'pair.errDeviceLimit'
    case 'offline': return 'pair.errOffline'
    case 'too_old': return 'pair.errTooOld'
    default: return 'pair.errUnknown'
  }
}
```

`apps/app/app.json`:`plugins` 数组里加(`microphonePermission: false` 与 `recordAudioAndroid: false` 让它不申请麦克风;先用 Context7 `/expo/expo` 核对 SDK 57 的 expo-camera 插件选项名,不同就以文档为准并在报告里记 Ruling):

```json
      [
        "expo-camera",
        {
          "cameraPermission": "Tendhearth uses the camera only to scan the pairing code shown on your computer.",
          "microphonePermission": false,
          "recordAudioAndroid": false
        }
      ]
```

`apps/app/src/app/pair.tsx` 换成:

```tsx
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Linking, Platform, ScrollView, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t, type MessageKey } from '../i18n'
import { useLang } from '../i18n/useLang'
import { parsePairLink, type ParsedLink } from '../net/link'
import { pairWithLink, PairError } from '../net/pairing'
import { rnConnect } from '../net/rn-connect'
import { useSession } from '../state/session'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { CCFigure } from '../ui/CCFigure'
import { serifFamily } from '../ui/fonts'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { useTheme } from '../ui/useTheme'
import { linkErrorKey, pairErrorKey } from '../view/pair'

type Phase =
  | { k: 'intro' }
  | { k: 'scan' }
  | { k: 'confirm'; link: ParsedLink }
  | { k: 'working'; link: ParsedLink }
  | { k: 'error'; key: MessageKey; camera?: boolean }

// 配对(spec §6):扫码或粘贴 → 显示中继主机让人确认 → 链接令牌配对、设备令牌确认 → 存钥匙串 → 回此刻。
// 失败的配对什么都不存;确认这一步挡住「扫到别人的码」。
export default function Pair() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { setPaired } = useSession()
  const [phase, setPhase] = useState<Phase>({ k: 'intro' })
  const [pasted, setPasted] = useState('')
  const [perm, requestPerm] = useCameraPermissions()
  const scanned = useRef(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const accept = (raw: string) => {
    const r = parsePairLink(raw)
    setPhase(r.ok ? { k: 'confirm', link: r.link } : { k: 'error', key: linkErrorKey(r.error) })
  }
  const startScan = async () => {
    const p = perm?.granted ? perm : await requestPerm()
    if (!alive.current) return
    if (p.granted) { scanned.current = false; setPhase({ k: 'scan' }) }
    else setPhase({ k: 'error', key: 'pair.cameraDenied', camera: true })
  }
  const connect = async (link: ParsedLink) => {
    setPhase({ k: 'working', link })
    try {
      const rec = await pairWithLink(link, { connect: rnConnect, label: Platform.OS === 'ios' ? 'Tendhearth · iPhone' : 'Tendhearth · Android' })
      await setPaired(rec)
      if (!alive.current) return
      router.dismissAll?.()
      router.replace('/')
    } catch (e) {
      if (alive.current) setPhase({ k: 'error', key: pairErrorKey(e instanceof PairError ? e.code : 'unknown') })
    }
  }
  const back = () => {
    if (phase.k === 'confirm' || phase.k === 'error') { setPhase({ k: 'intro' }); return }
    if (router.canGoBack()) router.back()
    else router.replace('/welcome')
  }

  if (phase.k === 'scan') {
    return (
      <View testID="pair-camera" style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => { if (scanned.current) return; scanned.current = true; accept(data) }}
        />
        <SafeAreaView edges={['bottom']} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: space.xl }}>
          <Button kind="secondary" testID="pair-cancel-scan" label={t(lang, 'pair.cancelScan')} onPress={() => setPhase({ k: 'intro' })} />
        </SafeAreaView>
      </View>
    )
  }

  const steps = ['pair.step1', 'pair.step2', 'pair.step3'] as const
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar onBack={back} connection="offline" showConnection={false} onAvatar={() => router.push('/settings')} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.xl, gap: space.l }}>
        <View style={{ alignItems: 'center' }}><CCFigure size={120} /></View>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 28, lineHeight: 36, fontFamily: serifFamily }}>{t(lang, 'pair.title')}</Text>
        {phase.k === 'confirm' || phase.k === 'working' ? (
          <Card testID="pair-confirm" style={{ gap: space.m }}>
            <Text style={{ color: c.ink, fontSize: 18, fontWeight: '600' }}>{t(lang, 'pair.confirmTitle')}</Text>
            <Text style={{ color: c.muted, fontSize: 15, lineHeight: 22 }}>{t(lang, 'pair.confirmBody', { host: phase.link.relayHost })}</Text>
            <Button
              kind="primary"
              testID="pair-connect"
              label={phase.k === 'working' ? t(lang, 'pair.working') : t(lang, 'pair.connect')}
              busy={phase.k === 'working'}
              onPress={() => void connect(phase.link)}
            />
          </Card>
        ) : (
          <>
            <View testID="pair-steps" style={{ gap: space.m }}>
              {steps.map((k, i) => (
                <Card key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: space.m }}>
                  <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.navOnBg, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: c.navOnInk, fontWeight: '700' }}>{i + 1}</Text>
                  </View>
                  <Text style={{ flex: 1, color: c.ink, fontSize: 16, lineHeight: 22 }}>{t(lang, k)}</Text>
                </Card>
              ))}
            </View>
            {phase.k === 'error' ? (
              <Card testID="pair-error" style={{ gap: space.s }}>
                <Text accessibilityLiveRegion="polite" style={{ color: c.warn, fontSize: 15, lineHeight: 22 }}>{t(lang, phase.key)}</Text>
                {phase.camera ? <Button kind="secondary" testID="pair-open-settings" label={t(lang, 'pair.openSettings')} onPress={() => void Linking.openSettings()} /> : null}
              </Card>
            ) : null}
            <Button kind="primary" testID="pair-scan" label={t(lang, 'pair.scan')} onPress={() => void startScan()} />
            <Text style={{ color: c.muted, fontSize: 14, lineHeight: 20 }}>{t(lang, 'pair.pasteHint')}</Text>
            <TextInput
              testID="pair-paste-input"
              value={pasted}
              onChangeText={setPasted}
              placeholder={t(lang, 'pair.pastePlaceholder')}
              placeholderTextColor={c.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ minHeight: 48, borderWidth: 1, borderColor: c.line, borderRadius: radius.button, paddingHorizontal: space.m, color: c.ink, backgroundColor: c.card }}
            />
            <Button kind="secondary" testID="pair-use-pasted" label={t(lang, 'pair.usePasted')} disabled={!pasted.trim()} onPress={() => accept(pasted)} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}
```

`apps/app/.maestro/pair-invalid.yaml`(不联网,只验页面与链接校验):

```yaml
# 配对页(不联网):欢迎 → 配对 → 粘贴一个不是配对码的链接 → 看到对应提示;再贴局域网链接 → 「打开出门也能用」提示。
appId: com.tendhearth.app
---
- runFlow: subflows/_start.yaml
- tapOn:
    id: welcome-pair
- assertVisible:
    id: pair-steps
- tapOn:
    id: pair-paste-input
- inputText: "https://example.com/"
- hideKeyboard
- tapOn:
    id: pair-use-pasted
- assertVisible:
    id: pair-error
- assertVisible: ".*Tendhearth.*配对码.*|.*isn’t a Tendhearth pairing code.*"
- tapOn:
    id: topbar-back
- tapOn:
    id: pair-paste-input
- eraseText: 40
- inputText: "http://192.168.1.5:51234/set?t=t0123456789abcdef0123456789abcdef"
- hideKeyboard
- tapOn:
    id: pair-use-pasted
- assertVisible: ".*出门也能用.*|.*Use when away.*"
```

`apps/app/README.md` 的 Maestro 表格加一行:`| .maestro/pair-invalid.yaml | 欢迎 → 配对 → 粘贴无效链接 / 局域网链接 → 各自的提示(不联网;真配对是主人真机验收) |`。

- [ ] **Step 5: 跑**

Run:
```bash
cd apps/app && bun run test && bun run typecheck && bun run export:check; echo app=$?
bunx expo run:ios            # 加了 expo-camera / expo-crypto,必须重建 development build
maestro test .maestro/       # 四个流程
cd ../..
```
Expected: `app=0`;Maestro 四个流程 PASS(把输出贴进报告)。

- [ ] **Step 6: Commit**

```bash
git add apps/app/src apps/app/app.json apps/app/.maestro apps/app/README.md
git commit -m "app:配对页 —— 扫码 / 粘贴 / 确认中继主机 / 连接;无效链接的 Maestro 流程

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: 设备管理页 + 设置(解除配对、演示里去配对)

**Files:**
- Create: `apps/app/src/view/devices.ts`、`apps/app/src/app/devices.tsx`
- Modify: `apps/app/src/app/settings.tsx`、`apps/app/src/i18n/en.ts`、`apps/app/src/i18n/zh-Hans.ts`
- Test: `apps/app/src/view/devices.test.ts`

**Interfaces:**
- Consumes: `Backend.devices / renameDevice / unpair`(Task 6/7);`useSession().forgetPairing`(Task 10);`formatSynced`(Task 10)。
- Produces:`devicesView(rows: DeviceRowT[], now: number, lang: Lang): { me: { id: string; label: string } | null; others: Array<{ id: string; label: string; lastSeen: string }> }`;testID:`devices-list`、`devices-name-input`、`devices-save`、`devices-other-<id>`、`devices-other-hint`、`settings-devices`、`settings-unpair`、`settings-pair-now`。

- [ ] **Step 1: 写失败的测试**

`apps/app/src/view/devices.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { devicesView } from './devices'

const now = new Date(2026, 8, 30, 14, 0).getTime()
const iso = (h: number, day = 30) => new Date(2026, 8, day, h, 0).toISOString()

describe('devicesView', () => {
  it('本机单列;其它设备按最近出现倒序,没名字的叫「未命名设备」', () => {
    const v = devicesView([
      { id: 'a', created_at: iso(1), last_seen_at: iso(13), label: 'Tendhearth · iPhone', current: true },
      { id: 'b', created_at: iso(1), last_seen_at: iso(9, 28), current: false },
      { id: 'c', created_at: iso(1), last_seen_at: iso(12), label: '  ', current: false },
    ], now, 'zh-Hans')
    expect(v.me).toEqual({ id: 'a', label: 'Tendhearth · iPhone' })
    expect(v.others.map(o => o.id)).toEqual(['c', 'b'])
    expect(v.others[0]?.label).toBe('未命名设备')
    expect(v.others[0]?.lastSeen).toContain('12:00')
    expect(v.others[1]?.lastSeen).toContain('9月28日')
  })
  it('列表里没有本机(刚被撤)⇒ me 为 null;坏时间 ⇒ 不显示最近出现', () => {
    const v = devicesView([{ id: 'b', created_at: 'x', last_seen_at: 'not a date', current: false }], now, 'en')
    expect(v.me).toBeNull()
    expect(v.others[0]?.lastSeen).toBe('')
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/app && bunx vitest run src/view/devices.test.ts; echo $?`
Expected: 非 0。

- [ ] **Step 3: 文案**

`en.ts`:

```ts
  'devices.title': 'Paired devices',
  'devices.thisPhone': 'This phone',
  'devices.unnamed': 'Unnamed device',
  'devices.nameLabel': 'Name shown on your computer',
  'devices.save': 'Save name',
  'devices.saved': 'Saved.',
  'devices.saveFailed': 'Couldn’t save the name. Try again when your computer is online.',
  'devices.lastSeen': 'Last seen {time}',
  'devices.others': 'Other devices',
  'devices.otherHint': 'To remove another device, use Tendhearth on your computer at home — removing devices only works from there.',
  'devices.loadFailed': 'Couldn’t load the device list. Tap to try again.',
  'settings.thisPhone': 'This phone',
  'settings.devices': 'Paired devices',
  'settings.unpair': 'Unpair this phone',
  'settings.unpairConfirmTitle': 'Unpair this phone?',
  'settings.unpairConfirmBody': 'This phone will stop reaching your computer. You can pair again any time.',
  'settings.unpairLocalOnly': 'This phone forgot the pairing, but your computer couldn’t be reached. Remove it from the device list on your computer when you’re home.',
  'settings.pairNow': 'Pair with my computer',
```

`zh-Hans.ts`:

```ts
  'devices.title': '已配对的设备',
  'devices.thisPhone': '这台手机',
  'devices.unnamed': '未命名设备',
  'devices.nameLabel': '在电脑上显示的名字',
  'devices.save': '保存名字',
  'devices.saved': '已保存。',
  'devices.saveFailed': '名字没保存上。等电脑在线时再试一次。',
  'devices.lastSeen': '最近一次 {time}',
  'devices.others': '其它设备',
  'devices.otherHint': '要移除别的设备,请在家里的电脑上操作 —— 只有在那边才能移除。',
  'devices.loadFailed': '设备列表读不到。点一下重试。',
  'settings.thisPhone': '这台手机',
  'settings.devices': '已配对的设备',
  'settings.unpair': '解除这台手机的配对',
  'settings.unpairConfirmTitle': '解除配对?',
  'settings.unpairConfirmBody': '这台手机将不再连到你的电脑。之后随时可以重新配对。',
  'settings.unpairLocalOnly': '这台手机已经忘掉配对,但没连上电脑。回家后请在电脑的设备列表里把它移除。',
  'settings.pairNow': '和我的电脑配对',
```

- [ ] **Step 4: 实现**

`apps/app/src/view/devices.ts`:

```ts
import type { DeviceRowT } from '../backend/types'
import { t, type Lang } from '../i18n'
import { formatSynced } from './connection'

export function devicesView(rows: DeviceRowT[], now: number, lang: Lang) {
  const me = rows.find(r => r.current) ?? null
  const seen = (r: DeviceRowT) => Date.parse(r.last_seen_at)
  const others = rows
    .filter(r => !r.current)
    .sort((a, b) => (seen(b) || 0) - (seen(a) || 0))
    .map(r => ({
      id: r.id,
      label: r.label?.trim() || t(lang, 'devices.unnamed'),
      lastSeen: Number.isFinite(seen(r)) ? t(lang, 'devices.lastSeen', { time: formatSynced(seen(r), now, lang) }) : '',
    }))
  return { me: me ? { id: me.id, label: me.label ?? '' } : null, others }
}
```

`apps/app/src/app/devices.tsx`:

```tsx
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection, useQuery, useSubmit } from '../state/hooks'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { serifFamily } from '../ui/fonts'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { useTheme } from '../ui/useTheme'
import { devicesView } from '../view/devices'

// 设备管理(spec §6):本机改名;别的设备只能在家里的电脑上移除(LAN_ONLY_OPS),这里只给提示。
export default function Devices() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const submit = useSubmit()
  const { backend } = useBackendCtx()
  const q = useQuery('devices', () => backend.devices(), { refreshOnMount: true })
  const v = q.data ? devicesView(q.data, Date.now(), lang) : null
  const [name, setName] = useState<string | null>(null)
  const [msg, setMsg] = useState<null | 'saved' | 'failed'>(null)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  useEffect(() => { if (name === null && v?.me) setName(v.me.label) }, [name, v?.me])
  const online = conn.state === 'online'
  const save = async () => {
    const label = (name ?? '').trim()
    if (!label || busy || !online) return
    setBusy(true); setMsg(null)
    const r = await submit('device:rename', () => backend.renameDevice(label))
    setBusy(false)
    setMsg(r === 'ok' ? 'saved' : 'failed')
    if (r === 'ok') void q.refresh()
  }
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar title={t(lang, 'devices.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/settings'))} connection={online ? 'online' : 'offline'} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.xl, gap: space.l }}>
        <ConnectionNotice />
        {!v ? (
          q.error ? (
            <Pressable testID="devices-load-failed" accessibilityRole="button" onPress={() => void q.refresh()}>
              <Text style={{ color: c.warn }}>{t(lang, 'devices.loadFailed')}</Text>
            </Pressable>
          ) : <Text style={{ color: c.muted }}>{t(lang, 'progress.loading')}</Text>
        ) : (
          <View testID="devices-list" style={{ gap: space.l }}>
            <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 18, fontFamily: serifFamily }}>{t(lang, 'devices.thisPhone')}</Text>
            <Card style={{ gap: space.s }}>
              <Text style={{ color: c.muted, fontSize: 13 }}>{t(lang, 'devices.nameLabel')}</Text>
              <TextInput
                testID="devices-name-input"
                value={name ?? ''}
                onChangeText={x => { setName(x); setMsg(null) }}
                maxLength={24}
                style={{ minHeight: 48, borderWidth: 1, borderColor: c.line, borderRadius: radius.button, paddingHorizontal: space.m, color: c.ink, backgroundColor: c.card }}
              />
              <Button kind="primary" testID="devices-save" label={t(lang, 'devices.save')} busy={busy} disabled={!online || !(name ?? '').trim()} onPress={() => void save()} />
              {msg ? <Text accessibilityLiveRegion="polite" style={{ color: msg === 'saved' ? c.muted : c.warn, fontSize: 14 }}>{t(lang, msg === 'saved' ? 'devices.saved' : 'devices.saveFailed')}</Text> : null}
            </Card>
            {v.others.length > 0 ? (
              <>
                <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 18, fontFamily: serifFamily }}>{t(lang, 'devices.others')}</Text>
                {v.others.map(o => (
                  <Pressable key={o.id} testID={`devices-other-${o.id}`} accessibilityRole="button" accessibilityLabel={o.label} onPress={() => setHint(o.id)}>
                    <Card style={{ gap: space.xs }}>
                      <Text style={{ color: c.ink, fontSize: 16 }}>{o.label}</Text>
                      {o.lastSeen ? <Text style={{ color: c.muted, fontSize: 13 }}>{o.lastSeen}</Text> : null}
                      {hint === o.id ? <Text testID="devices-other-hint" accessibilityLiveRegion="polite" style={{ color: c.muted, fontSize: 14, lineHeight: 20 }}>{t(lang, 'devices.otherHint')}</Text> : null}
                    </Card>
                  </Pressable>
                ))}
              </>
            ) : null}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}
```

`apps/app/src/app/settings.tsx`:
1. import 加 `Alert` 到 `react-native` 的 import;`const { langOverride, setLangOverride, setSeenWelcome, forgetPairing } = useSession()`;`const [unpairing, setUnpairing] = useState(false)`(import `useState`)。
2. 加两个函数:

```tsx
  const unpair = async () => {
    setUnpairing(true)
    let remote = true
    try { await backend.unpair() } catch { remote = false } // 撤销后 / 离线时 daemon 那边做不了,本机照样清
    await forgetPairing()
    if (!remote) Alert.alert(t(lang, 'settings.unpairLocalOnly'))
    router.dismissAll?.()
    router.replace('/welcome')
  }
  const confirmUnpair = () =>
    Alert.alert(t(lang, 'settings.unpairConfirmTitle'), t(lang, 'settings.unpairConfirmBody'), [
      { text: t(lang, 'common.cancel'), style: 'cancel' },
      { text: t(lang, 'settings.unpair'), style: 'destructive', onPress: () => void unpair() },
    ])
```

3. 语言区之后、`{demo ? …}` 之前加真连接区:

```tsx
        {!demo ? (
          <>
            {heading('settings.thisPhone')}
            <Card style={{ gap: space.m }}>
              <Button kind="secondary" testID="settings-devices" label={t(lang, 'settings.devices')} onPress={() => router.push('/devices')} />
              <Button kind="secondary" testID="settings-unpair" label={t(lang, 'settings.unpair')} busy={unpairing} onPress={confirmUnpair} />
            </Card>
          </>
        ) : null}
```

4. 演示区 `settings-exit-demo` 按钮之前加:

```tsx
              <Button kind="primary" testID="settings-pair-now" label={t(lang, 'settings.pairNow')} onPress={() => { resetDemo(); router.push('/pair') }} />
```

5. `TopBar` 的 `connection` 仍按 `conn.state === 'online'`。

- [ ] **Step 5: 跑,确认通过**

Run:
```bash
cd apps/app && bun run test && bun run typecheck && bun run export:check; echo app=$?
maestro test .maestro/      # 演示流程不受影响(演示后端恒在线;settings-exit-demo 仍在)
cd ../..
```
Expected: `app=0`;Maestro 四个流程 PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/app/src
git commit -m "app:设备管理页(本机改名、别的设备只提示在家移除)+ 设置里解除配对 / 演示里去配对

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: 占位图标(替换 800 KB 的模板图)

**Files:**
- Modify: `apps/app/assets/images/icon.png`(1024×1024,不透明)、`apps/app/assets/images/android-icon-foreground.png`(512×512,透明底)

- [ ] **Step 1: 用已验收的 CC 素材生成**

只用 `apps/app/assets/cc/lit.png`(即 `apps/desktop/src/assets/pet/cc-v1/canonical/lit/front.png` 的拷贝),不重画。底色用导航选中底 `#f7ead2`(比页面底色 `#faf8f3` 更能衬出 CC 的白)。本机有 Python + Pillow(已核对:Pillow 11.3):

```bash
python3 - <<'PY'
from PIL import Image
bg = (0xf7, 0xea, 0xd2)
cc = Image.open('apps/app/assets/cc/lit.png').convert('RGBA')
cc = cc.crop(cc.getbbox())                       # 去掉素材四周的留白
def place(size, frac, base):
    s = int(size * frac)
    w, h = cc.size
    k = s / max(w, h)
    fig = cc.resize((int(w * k), int(h * k)), Image.LANCZOS)
    base.alpha_composite(fig, ((size - fig.width) // 2, (size - fig.height) // 2))
    return base
icon = place(1024, 0.62, Image.new('RGBA', (1024, 1024), bg + (255,)))
icon.convert('RGB').save('apps/app/assets/images/icon.png', optimize=True)          # iOS 图标不许有透明通道
fg = place(512, 0.50, Image.new('RGBA', (512, 512), (0, 0, 0, 0)))                    # 安卓自适应图标安全区 ≈ 66%
fg.quantize(colors=128, method=Image.Quantize.FASTOCTREE).save('apps/app/assets/images/android-icon-foreground.png', optimize=True)
PY
file apps/app/assets/images/icon.png apps/app/assets/images/android-icon-foreground.png
ls -la apps/app/assets/images/icon.png apps/app/assets/images/android-icon-foreground.png
```

Expected:`icon.png` 1024×1024、`RGB`(无 alpha)、≤ 150 KB;前景图 512×512、≤ 30 KB。用 Read 工具看一眼两张图:CC 居中、没被裁。

`app.json` 的 `android.adaptiveIcon.backgroundColor` 改成 `#f7ead2`(与图标底色一致)。

- [ ] **Step 2: 打包检查**

Run: `cd apps/app && bun run export:check; echo $?; cd ../..`
Expected: `0`。

- [ ] **Step 3: Commit**

```bash
git add apps/app/assets/images/icon.png apps/app/assets/images/android-icon-foreground.png apps/app/app.json
git commit -m "app:占位图标由已验收的 CC 素材生成(800 KB → ~140 KB);正式图标另出

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: 文档 + 全量回路

**Files:**
- Modify: `apps/app/README.md`、`docs/roadmap.md`、`docs/INDEX.md`

- [ ] **Step 1: 文档**

`apps/app/README.md`:
- 开头一段改成:「这一版有**演示模式**与**真连接**:没配对时是演示后端;扫码配对后换成 `src/backend/live.ts`,经中继连回家里的电脑。」
- 「界面只认 Backend 接口」一节补:真后端在 `src/backend/live.ts`(纯 TS,socket 注入);连接状态机 `src/net/connection.ts`;错误映射 `src/net/errors.ts`;配对 `src/net/pairing.ts` + `src/app/pair.tsx`;钥匙串 `src/net/credentials.ts`(键 `tendhearth.pairing.v1` / `tendhearth.prefs.v1`)。
- 新增「真连接的规矩」小节,逐条抄 Global Constraints 里的:只走中继(`lan=` 不用)、所有返回过 schema、错误映射表、20 000 上限、撤销 ≠ 离线、草稿永不自动发、令牌不进日志、被根测试 import 的文件必须纯 TS 且过根 tsconfig。
- 「怎么跑」补一句:加了 `expo-crypto` / `expo-camera` 之后要重新 `bunx expo run:ios`;根目录 `bun --bun vitest run src/daemon/phone-app-live-e2e.test.ts` 是 LiveBackend 对着进程内真 daemon 的端到端。
- 目录表加 `src/net/`。

`docs/roadmap.md` 子项目 3 加一行:「真连接与配对完成(LiveBackend + 扫码配对 + 设备管理;进程内端到端 + 单测覆盖;真机配对待主人验收);下一份计划 = 原生通知」。

`docs/INDEX.md` 登记本计划。

- [ ] **Step 2: 全量回路**

Run:
```bash
cd apps/app && bun run test && bun run typecheck && bun run export:check; echo app=$?; cd ../..
bun run test > /tmp/app-live-final.log 2>&1; echo root=$?
npm run test:node > /tmp/app-live-final-node.log 2>&1; echo node=$?
bun run typecheck; echo tc=$?
bun run depcheck; echo dep=$?
```
Expected: 全部 `0`。任何一条非 0:看日志尾部定位,修掉再跑整组;别只重跑红的那条就宣布通过。

- [ ] **Step 3: Commit**

```bash
git add apps/app/README.md docs/roadmap.md docs/INDEX.md
git commit -m "docs:app 真连接与配对 —— README 规矩、roadmap、INDEX

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: 推送与 CI**

```bash
git push -u origin app-live
```

开 PR 到 `dev`(标题「手机 app 子项目 3 · 真连接与配对(LiveBackend)」,正文列 Task、计划裁决、主人真机验收清单,末尾 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`)。等 CI:`app · expo` 与根测试作业全绿。`wechat-cc ci triage` 的用法见 `docs/maintainer/ci-and-flakes.md`。

---

## 计划裁决

1. **不做局域网直连,只走中继**(spec §4 写的是「可优先」;任务书写了 LAN-first)。理由:daemon 的局域网口只是明文 HTTP(令牌在查询串里、Wi-Fi 上裸奔),**没有订阅**(主题只在 v2 协议里),要走还得给 iOS 开 ATS 例外、给安卓开明文流量;而且手机网页壳 2026-09-24 已经因为同样的原因删掉了「先探 LAN」(`relay/pset.src.html` 注释)。真要做,得先让 daemon 在局域网上也说 v2 协议(WebSocket),那是 daemon 的新功能,另立项。链接里的 `lan=` 照样解析、存进 `ParsedLink`,以后接上不用改解析。
2. **`invalid_answer` 映射成 `invalid`,不映射成 `stale`**(任务书写的是 invalid_answer / not-pending → stale)。「请求已不在」daemon 回的是 `permission_stale` / `question_stale` / `input_stale`(409),这些映射成 `stale` ⇒ 批准页显示「已处理」。`invalid_answer` 是回答本身不合格(超长由手机先拦,剩下的是形状问题),显示「已处理」会把一个真实的输入错误藏起来 —— 所以给「没发出去」的失败提示。
3. **daemon 新增 `unpair_self`**:`revoke_device` 在 `LAN_ONLY_OPS` 里,手机在外面没法解除本机配对。新操作只撤调用者自己,经隧道可用,链接令牌不能用。这是本计划唯一的 daemon 行为变化。
4. **协议客户端加 `onStatus` 钩子**:连接状态机要知道「握手成了 / 连接断了 / 被拒了」,协议客户端原来只暴露 `version()`。纯增量,daemon 与自检不受影响。
5. **设备列表来自 `GET /set/api/state`**,不加新路由:形状已在 `PHONE_API_SCHEMAS` 里、daemon 测试对着真返回核对;代价是这个返回比较大,v1 可以接受。
6. **离线缓存只在内存里**:同一次打开 app 期间,离线时显示上次同步的内容与时间;冷启动就离线 ⇒ 列表为空 + 「暂时连不上」。落盘的查询缓存留给「补齐页面」那份计划。
7. **中继主机不设白名单,改为让人确认**:自建中继的用户有自己的主机名;配对前显示「这台手机会经 {host} 连到你的电脑」,挡住「扫到别人的码」。
8. **配对后请求通知权限、`POST /m/api/push/register`(spec §6 的最后两步)移到下一份计划**,与原生通知扩展、推送密钥一起做。
9. **`lang` 不需要改 daemon**:daemon 只有 `GET /m/api/matter/insight` 按语言生成文本(已有 `lang` 参数);其余读返回的是用户数据。所以 `LiveBackend` 只给 insight 带 lang,`Backend` 接口的其余读也带 lang 是给演示后端用的(它自己生成两种语言的文案)。查询键不再带语言,换语言由 store 判过期再拉。
10. **图标是占位**:由已验收的 CC 素材合成(不重画)。正式图标(含安卓单色图、商店截图)由 Codex 出稿、主人认可。
11. **端到端测试放在根目录**(`src/daemon/phone-app-live-e2e.test.ts`),不放 `apps/app`:它要起真 daemon 模块(bun / node 两遍跑),app 的 vitest 与 tsconfig 不该去编 daemon。代价是被它 import 的 app 文件必须在根 tsconfig 下也能过(写进 Global Constraints)。

## 主人要做的

- **真机验收**(Maestro 覆盖不了):在真 iPhone 上扫桌面「手机上用」的码配对 → 此刻 / 进展 / 批准 / 交办各走一遍 → 电脑上撤销这台手机,看到「这台手机已不再配对」(不是「暂时不在线」)→ 关掉电脑,看到上次同步时间 → 设置里解除配对。安卓等有设备再补。
- **中继上线**:`agent-config.json` 没设 `relay_v2_url` 时,链接是老中继(`t…` id,走 `/tunnel/phone`),app 照样能连;要走官方中继 v2 按 `docs/maintainer/relay.md` 第 8 节的顺序上线。
- **正式图标**:Codex 出稿后替换 `apps/app/assets/images/*`。

## Next plan(计划 4:原生通知)

推送登记(配对后请求通知权限 → `POST /m/api/push/register`,token 刷新与重装重登)、iOS 通知服务扩展(Swift,CryptoKit 解密,钥匙串 access group 共享推送密钥)、安卓 `FirebaseMessagingService`(Kotlin)、两端跑 `packages/protocol` 的推送测试向量、点通知按 `taskId` + `requestId` 路由到批准页 / 事项页(先拉最新详情)、撤销时清推送密钥、EAS Build 与 TestFlight / Play 内部测试。
