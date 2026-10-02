# 中继搬上 Cloudflare + 推送 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把手机隧道搬到 Cloudflare Workers + Durable Objects(每个 daemon 一个「房间」),daemon 用 Ed25519 密钥在 socket 里挑战登录,房间代发 APNs / FCM 加密推送,并加上面向陌生人的限额与显式错误;过渡期 daemon 同时连老 VPS 中继与新中继。

**Architecture:** 新 `apps/relay` Workers 项目:入口 Worker 按路径分流,`Room` Durable Object(休眠 WebSocket API)持有一台 daemon 的 socket 与手机流、执行限额、存推送登记并调 APNs / FCM。身份与线上控制帧的形状放进 `@wechat-cc/protocol`(`relay.ts`),Worker 与 daemon 共用。daemon 侧:`relay-identity.ts`(密钥)、`tunnel-client.ts`(登录 + 控制帧)、`phone-push.ts`(登记 / 封装 / 结果)、`phone-notifier.ts`(从事件集线器的 approvals / agents 快照里判「该叫醒手机了」)、面板两条新手机路由、`pipeline-deps.ts` 双连接接线。

**Tech Stack:** Cloudflare Workers / Durable Objects(SQLite 后端、休眠 WebSocket、alarm)、wrangler 4.144、`@cloudflare/vitest-plugin` 1.3(vitest 4)、`@noble/curves` ed25519、Web Crypto(只在 Worker 里:ES256 / RS256 JWT)、zod v4、Bun daemon。

**Spec:** `docs/superpowers/specs/2026-09-30-relay-cloudflare-push-design.md`

## Global Constraints

- 只在 `dev` 分支(本工作树的特性分支 `relay-cf` 最后 PR 进 `dev`)上干活;进 `master` 只走 squash PR;不碰兄弟工作树。
- 中继**不解密任何东西**;不记 daemon id、不保留 query string(Workers invocation logs 关掉,`console.log` 里不许出现 id / token / URL)。
- daemon id = `'r' + base32小写(sha256(公钥原始 32 字节))` 前 26 字符;签名内容 = UTF-8 `wechat-cc/relay/v2/login:<challenge>:<daemonId>`;挑战 32 字节随机 base64url;10 秒内不登录 ⇒ `login_failed` 并关闭。
- 同一 id 第二条已认证连接替换第一条;关闭处理只在「关的正是当前 socket」时才动手机流。
- 限额(每 daemon):1 条 daemon 连接;最多 16 条手机流;单帧 512 KiB;手机流 每秒 20 帧、突发 120;daemon 帧 每秒 200、突发 1000;每天 500 条推送;每天 1 GB 流量(超了当天拒绝新手机流)。
- 显式错误码(明文 `{error:<code>}`):`daemon_offline`、`frame_too_large`、`rate_limited`、`quota_exceeded`、`too_many_streams`、`login_failed`。
- 推送载荷 `{ts, kind, title, body, taskId}`,`sealPush` 封装后 ≤ 约 3 KB;APNs alert + `mutable-content: 1` + 占位文字「CC 有新动态」;FCM HTTP v1 data message;APNs 410 / FCM `UNREGISTERED` ⇒ 删登记并回 `push_invalid`;失效 token 不重试。
- 正在用实时订阅连着的手机不推送。
- 凭据(APNs `.p8`、Firebase 服务账号、Cloudflare 令牌)只进 Worker secrets / GitHub environment secrets,绝不进仓库;`.p8` 永不复制进仓库(全局规矩)。测试用的密钥是测试里现生成的,不是真凭据。
- `packages/protocol/src` 非测试代码不许用 `node:*`、`Buffer`、`crypto.subtle`、`window`、`document`、`localStorage`(`scripts/protocol-purity.guard.test.ts`);随机数只走 `globalThis.crypto.getRandomValues`。
- zod v4 一律 `import z from 'zod'`(具名导入在 vitest 下是 undefined)。
- 类型检查看**退出码**,不要 grep `error TS`(输出带颜色,grep 永远空)。
- 新手机路由登记在 `src/daemon/phone-routes.ts` 的 `PHONE_ROUTES` + `packages/protocol/src/api.ts` 的 `PHONE_API_SCHEMAS`,`scripts/phone-routes.guard.test.ts` 双向核对。
- 环境:staging `relay-staging.tendhearth.com`、生产 `relay.tendhearth.com`;agent-config 新键 `relay_v2_url`(缺省 `wss://relay.tendhearth.com`),老 `remote_relay_url` 含义不变。
- 标准回路:`bun run test`、`npm run test:node`、`bun run typecheck`、`bun run depcheck`;中继自己的:`cd apps/relay && bun run test`。

## Review Focus

1. **daemon 丢了 / 坏了身份文件**:`relay-identity.json` 存在但损坏时绝不能悄悄重生成(那等于换了台电脑,所有手机要重配)—— 应该报错、这次不连 v2、老中继照常。Task 8 有测试钉住。
2. **休眠唤醒后的房间**:DO 被驱逐 / 休眠后内存里的「当前 daemon」、限流桶、流映射全没了;必须能从 socket attachment 恢复出同样的路由,且不会把一个被替换掉的旧 socket 当成当前。Task 5 用 `ctx.getWebSockets()` 重建的路径有测试。
3. **推送结果的对应**:同一台设备连发几条推送,`push_result` 必须按 `ref` 对上各自的等待者;超时的等待者不能泄漏。Task 10 有测试。
4. **过渡期两条隧道同时在**:同一台手机可能从老中继、新中继各连一条,`subscribedDevices` 要把两边合并,否则在线的手机照样被推送。Task 13 有测试。
5. **限流触发后手机端**:`rate_limited` / `quota_exceeded` 发完就关流,客户端必须退避 ≥ 30 秒而不是 500 ms 就重连把房间打爆。Task 2 有测试。

---

## File Structure

**新建**
- `packages/protocol/src/relay.ts` —— base32、daemon id 派生、登录签名 / 验签、错误码、子协议名、推送平台与 token 校验、daemon↔房间控制帧 zod schema。
- `packages/protocol/src/relay.test.ts`
- `apps/relay/package.json`、`apps/relay/tsconfig.json`、`apps/relay/wrangler.toml`、`apps/relay/vitest.config.ts`、`apps/relay/src/env.d.ts`
- `apps/relay/src/index.ts` —— 入口 Worker(路由)。
- `apps/relay/src/room.ts` —— `Room` Durable Object。
- `apps/relay/src/limits.ts` —— 令牌桶、限额常量、`limitsFrom(env)`、`utcDay`、`utf8Len`。
- `apps/relay/src/push-apns.ts`、`apps/relay/src/push-fcm.ts`、`apps/relay/src/push.ts` —— 两个发送方 + 分派。
- `apps/relay/src/metrics.ts` —— Analytics Engine 计数(无 id)。
- `apps/relay/test/*.test.ts`、`apps/relay/test/helpers.ts`
- `apps/relay/test/e2e/relay-v2.e2e.test.ts` + `apps/relay/vitest.e2e.config.ts` —— node 下起本地 Worker,跑真 daemon 模块。
- `src/daemon/relay-identity.ts` + test
- `src/daemon/phone-push.ts` + test
- `src/daemon/phone-notifier.ts` + test
- `src/daemon/remote-relay-config.ts` + test —— 从 agent-config 解析老 / 新两条中继与 remoteInfo。
- `.github/workflows/relay.yml` —— staging 自动部署、生产审批部署。
- `.github/workflows/relay-watch.yml` —— 每 15 分钟查生产健康与推送失败率。
- `docs/maintainer/relay.md`

**修改**
- `packages/protocol/src/index.ts`(导出)、`packages/protocol/src/client.ts`(新错误码)、`packages/protocol/src/api.ts`(两条推送路由 schema)
- `src/daemon/tunnel-client.ts`、`src/daemon/tunnel-v2-stream.ts`(`subscriptionCount`)
- `src/daemon/phone-topic-sources.ts`(删掉空的 `PhoneNotify` 出口)
- `src/daemon/settings-panel.ts`、`src/daemon/phone-routes.ts`
- `src/daemon/wiring/pipeline-deps.ts`
- `src/lib/agent-config.ts`
- `relay/pset.src.html`(+ 重新生成 `relay/pset.html`)
- `src/cli/selftest-phone.ts`、`src/cli/commands/selftest.ts`
- `package.json`(typecheck 脚本)、根 `tsconfig.json` / `vitest.config.ts` / `vitest.node.config.ts` / `.dependency-cruiser.cjs`(排除 `apps/relay`)
- `.github/workflows/ci.yml`、`scripts/ci-workflow.guard.test.ts`
- `relay/README.md`、`docs/INDEX.md`、`docs/roadmap.md`、`docs/maintainer/README.md`

---

### Task 1: 协议包 —— 中继身份与控制帧(`relay.ts`)

**Files:**
- Create: `packages/protocol/src/relay.ts`
- Create: `packages/protocol/src/relay.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Produces:
  - `base32Lower(bytes: Uint8Array): string`
  - `RELAY_ID_RE: RegExp`(`/^r[a-z2-7]{26}$/`)
  - `relayIdFromPub(pub: Uint8Array): string`
  - `relayKeyPair(seed?: Uint8Array): { seed: Uint8Array; pub: Uint8Array }`
  - `relayLoginMessage(challenge: string, daemonId: string): Uint8Array`
  - `signRelayLogin(seed: Uint8Array, challenge: string, daemonId: string): { pub: string; sig: string }`(b64url)
  - `verifyRelayLogin(daemonId: string, challenge: string, pub: string, sig: string): boolean`
  - `RELAY_SUBPROTOCOL = 'wcc.relay.v2'`、`relayIdProtocol(id): string`(`'id.' + id`)
  - `RELAY_ERRORS`(六个码的只读数组)、`type RelayError`
  - `PushPlatform`(zod enum `'apns' | 'apns_sandbox' | 'fcm'`)、`type PushPlatformT`
  - `pushTokenValid(platform: PushPlatformT, token: string): boolean`
  - `DaemonControl`(zod union:`{pub,sig}` 登录、`{push_reg:{device,platform,token}}`、`{push_unreg:{device}}`、`{push:{device,sealed,collapseId?,ref?}}`)
  - `RoomControl`(zod union:`{challenge,ts}`、`{login_ok:true}`、`{push_result:{device,ok,code,ref?}}`、`{push_invalid:{device}}`、`{error}`)
  - `PUSH_SEALED_MAX_CHARS = 3500`

- [ ] **Step 1: 写失败的测试**

`packages/protocol/src/relay.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  base32Lower, relayIdFromPub, relayKeyPair, signRelayLogin, verifyRelayLogin, RELAY_ID_RE,
  pushTokenValid, DaemonControl, RoomControl, relayIdProtocol, RELAY_SUBPROTOCOL,
} from './relay'

describe('base32Lower', () => {
  it('RFC 4648 向量(小写、无填充)', () => {
    const e = (s: string) => base32Lower(new TextEncoder().encode(s))
    expect(e('')).toBe('')
    expect(e('f')).toBe('my')
    expect(e('fo')).toBe('mzxq')
    expect(e('foo')).toBe('mzxw6')
    expect(e('foob')).toBe('mzxw6yq')
    expect(e('fooba')).toBe('mzxw6ytb')
    expect(e('foobar')).toBe('mzxw6ytboi')
  })
})

describe('daemon id', () => {
  it('由公钥派生:r + 26 个 base32 字符,同一把钥匙永远同一个 id', () => {
    const { seed, pub } = relayKeyPair()
    const id = relayIdFromPub(pub)
    expect(id).toMatch(RELAY_ID_RE)
    expect(relayIdFromPub(relayKeyPair(seed).pub)).toBe(id)
  })
  it('公钥不是 32 字节 ⇒ 抛', () => {
    expect(() => relayIdFromPub(new Uint8Array(31))).toThrow()
  })
  it('子协议名', () => {
    expect(RELAY_SUBPROTOCOL).toBe('wcc.relay.v2')
    expect(relayIdProtocol('rabc')).toBe('id.rabc')
  })
})

describe('登录签名', () => {
  const { seed, pub } = relayKeyPair()
  const id = relayIdFromPub(pub)
  it('正确签名通过', () => {
    const r = signRelayLogin(seed, 'chal-1', id)
    expect(verifyRelayLogin(id, 'chal-1', r.pub, r.sig)).toBe(true)
  })
  it('挑战不同 ⇒ 不通过', () => {
    const r = signRelayLogin(seed, 'chal-1', id)
    expect(verifyRelayLogin(id, 'chal-2', r.pub, r.sig)).toBe(false)
  })
  it('id 不是这把公钥派生的 ⇒ 不通过(哪怕签名本身对)', () => {
    const other = relayKeyPair()
    const otherId = relayIdFromPub(other.pub)
    const r = signRelayLogin(seed, 'c', otherId)   // 用自己的钥匙签别人的 id
    expect(verifyRelayLogin(otherId, 'c', r.pub, r.sig)).toBe(false)
  })
  it('畸形输入 ⇒ false,不抛', () => {
    expect(verifyRelayLogin(id, 'c', '!!', '??')).toBe(false)
    expect(verifyRelayLogin(id, 'c', '', '')).toBe(false)
  })
})

describe('推送 token 校验', () => {
  it('APNs:64–200 位十六进制', () => {
    expect(pushTokenValid('apns', 'a'.repeat(64))).toBe(true)
    expect(pushTokenValid('apns_sandbox', 'F'.repeat(64))).toBe(true)
    expect(pushTokenValid('apns', 'g'.repeat(64))).toBe(false)
    expect(pushTokenValid('apns', 'a'.repeat(63))).toBe(false)
  })
  it('FCM:20–4096 个 [A-Za-z0-9:_-]', () => {
    expect(pushTokenValid('fcm', 'abc:DEF_ghi-' + 'x'.repeat(20))).toBe(true)
    expect(pushTokenValid('fcm', 'short')).toBe(false)
    expect(pushTokenValid('fcm', 'has space ' + 'x'.repeat(20))).toBe(false)
  })
})

describe('控制帧 schema', () => {
  it('daemon → 房间', () => {
    expect(DaemonControl.safeParse({ pub: 'p', sig: 's' }).success).toBe(true)
    expect(DaemonControl.safeParse({ push_reg: { device: 'ab12cd34', platform: 'apns', token: 'a'.repeat(64) } }).success).toBe(true)
    expect(DaemonControl.safeParse({ push_unreg: { device: 'ab12cd34' } }).success).toBe(true)
    expect(DaemonControl.safeParse({ push: { device: 'ab12cd34', sealed: { v: 1, iv: 'i', ct: 'c' }, collapseId: 't1', ref: 'r1' } }).success).toBe(true)
    expect(DaemonControl.safeParse({ push: { device: '../x', sealed: { v: 1, iv: 'i', ct: 'c' } } }).success).toBe(false)
    expect(DaemonControl.safeParse({ push: { device: 'ab12cd34', sealed: { v: 1, iv: 'i', ct: 'c'.repeat(3501) } } }).success).toBe(false)
  })
  it('房间 → daemon', () => {
    expect(RoomControl.safeParse({ challenge: 'c', ts: 1 }).success).toBe(true)
    expect(RoomControl.safeParse({ login_ok: true }).success).toBe(true)
    expect(RoomControl.safeParse({ push_result: { device: 'ab12cd34', ok: false, code: 'BadDeviceToken', ref: 'r' } }).success).toBe(true)
    expect(RoomControl.safeParse({ push_invalid: { device: 'ab12cd34' } }).success).toBe(true)
    expect(RoomControl.safeParse({ error: 'rate_limited' }).success).toBe(true)
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run packages/protocol/src/relay.test.ts`
Expected: FAIL,`Cannot find module './relay'` / `Failed to resolve import "./relay"`。

- [ ] **Step 3: 实现**

`packages/protocol/src/relay.ts`:

```ts
/**
 * relay.ts — 官方中继 v2(Cloudflare,spec 2026-09-30)的身份与控制帧。Worker 与 daemon 共用。
 *
 * daemon 身份:Ed25519。id = 'r' + base32小写(sha256(公钥原始 32 字节)) 前 26 字符 —— id 由公钥
 * 派生,中继不需要另存「这个 id 属于哪把钥匙」,冒名者拿不出能派生出该 id 的公钥。
 * 登录:房间发 {challenge, ts};daemon 回 {pub, sig},签 UTF-8 `wechat-cc/relay/v2/login:<challenge>:<id>`。
 *
 * 纯净约束(protocol-purity 守卫):不用 node:*、Buffer、crypto.subtle;随机数走 getRandomValues。
 */
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import z from 'zod'
import { b64uDecode, b64uEncode } from './b64u'

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

export function base32Lower(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export const RELAY_ID_RE = /^r[a-z2-7]{26}$/
export const RELAY_SUBPROTOCOL = 'wcc.relay.v2'
export const relayIdProtocol = (id: string): string => `id.${id}`

export function relayIdFromPub(pub: Uint8Array): string {
  if (pub.length !== 32) throw new Error('relay_pub_length')
  return 'r' + base32Lower(sha256(pub)).slice(0, 26)
}

export function relayKeyPair(seed?: Uint8Array): { seed: Uint8Array; pub: Uint8Array } {
  const s = seed ?? globalThis.crypto.getRandomValues(new Uint8Array(32))
  return { seed: s, pub: ed25519.getPublicKey(s) }
}

export function relayLoginMessage(challenge: string, daemonId: string): Uint8Array {
  return new TextEncoder().encode(`wechat-cc/relay/v2/login:${challenge}:${daemonId}`)
}

export function signRelayLogin(seed: Uint8Array, challenge: string, daemonId: string): { pub: string; sig: string } {
  const pub = ed25519.getPublicKey(seed)
  const sig = ed25519.sign(relayLoginMessage(challenge, daemonId), seed)
  return { pub: b64uEncode(pub), sig: b64uEncode(sig) }
}

export function verifyRelayLogin(daemonId: string, challenge: string, pub: string, sig: string): boolean {
  try {
    const pubBytes = b64uDecode(pub)
    if (relayIdFromPub(pubBytes) !== daemonId) return false
    return ed25519.verify(b64uDecode(sig), relayLoginMessage(challenge, daemonId), pubBytes)
  } catch {
    return false
  }
}

export const RELAY_ERRORS = ['daemon_offline', 'frame_too_large', 'rate_limited', 'quota_exceeded', 'too_many_streams', 'login_failed'] as const
export type RelayError = (typeof RELAY_ERRORS)[number]

/** apns_sandbox:Xcode 调试包拿到的是沙盒 token,要打 api.sandbox.push.apple.com(计划裁决 1)。 */
export const PushPlatform = z.enum(['apns', 'apns_sandbox', 'fcm'])
export type PushPlatformT = z.infer<typeof PushPlatform>

export function pushTokenValid(platform: PushPlatformT, token: string): boolean {
  if (platform === 'fcm') return /^[A-Za-z0-9:_-]{20,4096}$/.test(token)
  return /^[0-9a-fA-F]{64,200}$/.test(token)
}

export const PUSH_SEALED_MAX_CHARS = 3500
const Device = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const Ref = z.string().max(64)
const SealedPushShape = z.object({ v: z.literal(1), iv: z.string().max(64), ct: z.string().max(PUSH_SEALED_MAX_CHARS) })

export const DaemonControl = z.union([
  z.object({ pub: z.string().max(128), sig: z.string().max(256) }),
  z.object({ push_reg: z.object({ device: Device, platform: PushPlatform, token: z.string().max(4096) }) }),
  z.object({ push_unreg: z.object({ device: Device }) }),
  z.object({ push: z.object({ device: Device, sealed: SealedPushShape, collapseId: z.string().max(64).optional(), ref: Ref.optional() }) }),
])
export type DaemonControlT = z.infer<typeof DaemonControl>

export const RoomControl = z.union([
  z.object({ challenge: z.string(), ts: z.number() }),
  z.object({ login_ok: z.literal(true) }),
  z.object({ push_result: z.object({ device: Device, ok: z.boolean(), code: z.string(), ref: Ref.optional() }) }),
  z.object({ push_invalid: z.object({ device: Device }) }),
  z.object({ error: z.string() }),
])
export type RoomControlT = z.infer<typeof RoomControl>
```

在 `packages/protocol/src/index.ts` 末尾追加:

```ts
export {
  base32Lower, RELAY_ID_RE, RELAY_SUBPROTOCOL, relayIdProtocol, relayIdFromPub, relayKeyPair, relayLoginMessage,
  signRelayLogin, verifyRelayLogin, RELAY_ERRORS, PushPlatform, pushTokenValid, PUSH_SEALED_MAX_CHARS, DaemonControl, RoomControl,
} from './relay'
export type { RelayError, PushPlatformT, DaemonControlT, RoomControlT } from './relay'
```

- [ ] **Step 4: 跑,确认通过 + 纯净守卫**

Run: `bun --bun vitest run packages/protocol/src/relay.test.ts scripts/protocol-purity.guard.test.ts`
Expected: PASS(全部)。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/relay.ts packages/protocol/src/relay.test.ts packages/protocol/src/index.ts
git commit -m "协议包:中继 v2 身份(Ed25519 + 由公钥派生的 id)与控制帧 schema"
```

---

### Task 2: 协议客户端认识中继的新错误码

**Files:**
- Modify: `packages/protocol/src/client.ts`(`onErrorFrame`、`scheduleReconnect`、常量)
- Test: `packages/protocol/src/client.test.ts`

**Interfaces:**
- Consumes: 无(错误码是字符串,与 Task 1 的 `RELAY_ERRORS` 一致)。
- Produces: 客户端行为 —— `frame_too_large` ⇒ 已在这条连接上发出的请求立刻以 `frame_too_large` 拒绝(不重试),未发出的留着等新连接;`rate_limited` / `quota_exceeded` / `too_many_streams` ⇒ 全部挂起请求以该码拒绝,下一次重连不早于 30 秒后。

- [ ] **Step 1: 写失败的测试**

在 `client.test.ts` 里 `'中继明文 daemon_offline …'` 那条之后加(沿用文件里的 `makeFakeDaemon` / `client` / `flush` 助手与假时钟):

```ts
  it('中继明文 frame_too_large ⇒ 已发出的请求立刻失败、不重试;订阅照常重连', async () => {
    const daemon = makeFakeDaemon({ version: 2 })
    const { c, open } = client(daemon)
    c.subscribe('now', () => {})
    daemon.d.dropNextReqs = 1
    const p = c.request({ method: 'GET', path: '/big' })
    const assertion = expect(p).rejects.toThrow('frame_too_large')
    await flush()
    daemon.d.live().raw(JSON.stringify({ error: 'frame_too_large' }))
    await flush()
    await assertion
    await vi.advanceTimersByTimeAsync(500)
    expect(open).toHaveBeenCalledTimes(2)
    // 被拒本身就证明没进重试(重试的请求会继续挂着等新连接)。
    c.close()
  })

  for (const code of ['rate_limited', 'quota_exceeded', 'too_many_streams']) {
    it(`中继明文 ${code} ⇒ 挂起请求以它拒绝,至少 30 s 后才重连`, async () => {
      const daemon = makeFakeDaemon({ version: 2 })
      const { c, open } = client(daemon)
      c.subscribe('now', () => {})
      daemon.d.dropNextReqs = 1
      const p = c.request({ method: 'GET', path: '/x' })
      const assertion = expect(p).rejects.toThrow(code)
      await flush()
      daemon.d.live().raw(JSON.stringify({ error: code }))
      await flush()
      await assertion
      await vi.advanceTimersByTimeAsync(29_000)
      expect(open).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_500)
      expect(open).toHaveBeenCalledTimes(2)
      c.close()
    })
  }
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run packages/protocol/src/client.test.ts -t "frame_too_large|rate_limited|quota_exceeded|too_many_streams"`
Expected: FAIL —— frame_too_large 那条请求被 failAll 拒了,但 `rate_limited` 几条在 500 ms 就重连(`open` 调用 2 次早于 29 s)。

- [ ] **Step 3: 实现**

`client.ts` 常量区(`BACKOFF_CAP_MS` 下面)加:

```ts
/** 中继说「你太快了 / 今天用超了 / 流太多」:至少这么久之后才重连,别把房间打爆(spec §6)。 */
const RELAY_BUSY_BACKOFF_MS = 30_000
```

状态区(`let backoffAttempt = 0` 下面)加:

```ts
  let busyUntil = 0
```

`scheduleReconnect` 里把 delay 改成:

```ts
    const delay = Math.max(Math.min(BACKOFF_BASE_MS * 2 ** backoffAttempt, BACKOFF_CAP_MS), busyUntil - now())
```

`onErrorFrame` 里,`stream_unknown` 分支之后、`failAll(new Error(code))` 之前插入:

```ts
    if (code === 'frame_too_large') {
      // 中继拒了一帧(太大)。是哪一条请求中继不知道(密文),但重发同一帧只会再被拒:
      // 这条连接上已发出的请求一律以它失败,不重试;没发出去的留给新连接。
      for (const p of [...byRid.values()]) {
        if (!p.sent || p.sentOn !== c) continue
        settle(p.rid, q => q.reject(new Error(code)))
      }
      dropConn(c)
      return
    }
    if (code === 'rate_limited' || code === 'quota_exceeded' || code === 'too_many_streams') {
      busyUntil = now() + RELAY_BUSY_BACKOFF_MS
    }
```

文件头注释里 `其它明文错误(中继的 daemon_offline 等)` 那一行下补一句:`frame_too_large ⇒ 已发出的请求失败不重试;rate_limited / quota_exceeded / too_many_streams ⇒ 至少 30 s 后才重连。`

- [ ] **Step 4: 跑整份客户端测试**

Run: `bun --bun vitest run packages/protocol/src/client.test.ts`
Expected: PASS(含原有「指数退避封顶 15 s」—— `busyUntil` 初值 0 不影响它)。

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/client.ts packages/protocol/src/client.test.ts
git commit -m "协议客户端:frame_too_large 立刻失败不重试;限流 / 超额 / 流太多退避 ≥30 s"
```

---

### Task 3: `apps/relay` 骨架 + 限额工具 + 入口 Worker

**Files:**
- Create: `apps/relay/package.json`、`apps/relay/tsconfig.json`、`apps/relay/wrangler.toml`、`apps/relay/vitest.config.ts`、`apps/relay/src/env.d.ts`
- Create: `apps/relay/src/limits.ts`、`apps/relay/src/metrics.ts`、`apps/relay/src/index.ts`、`apps/relay/src/room.ts`(本任务只放最小占位类,Task 4 填)
- Create: `apps/relay/test/limits.test.ts`、`apps/relay/test/entry.test.ts`
- Modify: 根 `package.json`(typecheck)、`tsconfig.json`、`vitest.config.ts`、`vitest.node.config.ts`、`.dependency-cruiser.cjs`(若它扫到 apps/relay)

**Interfaces:**
- Produces:
  - `interface Env { ROOM: DurableObjectNamespace; METRICS?: AnalyticsEngineDataset; RELAY_VERSION?: string; RELAY_ENV?: string; RELAY_DAILY_BYTES?: string; RELAY_DAILY_PUSHES?: string; RELAY_LOGIN_TIMEOUT_MS?: string; APNS_KEY_P8?: string; APNS_KEY_ID?: string; APNS_TEAM_ID?: string; APNS_TOPIC?: string; APNS_HOST?: string; APNS_SANDBOX_HOST?: string; FCM_SERVICE_ACCOUNT?: string; FCM_HOST?: string; FCM_TOKEN_URL?: string }`
  - `limits.ts`:`LIMITS`(常量对象)、`limitsFrom(env): Limits`、`makeBucket(capacity, refillPerSec): TokenBucket`(`take(now): boolean`)、`utcDay(ms): string`、`utf8Len(s): number`
  - `metrics.ts`:`count(env, event: string): void`
  - 入口路由:`GET /healthz` → `{ok:true, version, env, apns:boolean, fcm:boolean}`;`GET /pset/`(或 `/pset`)→ 壳页 HTML;`GET /v2/daemon`(必须 websocket 升级 + 子协议含 `wcc.relay.v2` 与合法 `id.<rid>`)→ 转 `ROOM.idFromName(id)`,加头 `x-relay-role: daemon`、`x-relay-id`;`GET /v2/phone?id=<rid>`(必须升级)→ 同一房间,`x-relay-role: phone`;其余 404。

- [ ] **Step 1: 装依赖与配置**

`apps/relay/package.json`:

```json
{
  "name": "@wechat-cc/relay",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:e2e": "vitest run -c vitest.e2e.config.ts",
    "typecheck": "tsc --noEmit",
    "deploy:staging": "wrangler deploy --env staging",
    "deploy:production": "wrangler deploy --env production"
  },
  "dependencies": {
    "@wechat-cc/protocol": "workspace:*"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "1.3.3",
    "@cloudflare/workers-types": "^5.20260930.1",
    "wrangler": "4.144.0"
  }
}
```

`apps/relay/wrangler.toml`:

```toml
name = "wechat-cc-relay"
main = "src/index.ts"
compatibility_date = "2026-09-01"
# 手机壳页与中继同一份源码(relay/pset.src.html → apps/mobile/build.ts 生成 relay/pset.html)。
rules = [{ type = "Text", globs = ["**/*.html"], fallthrough = true }]

[observability]
enabled = true
[observability.logs]
# spec §7:手机 URL 带 ?id=,Workers 的请求日志一律不留 —— 只留我们自己打的(不含 id 的)console 行。
invocation_logs = false

[[durable_objects.bindings]]
name = "ROOM"
class_name = "Room"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Room"]

[vars]
RELAY_ENV = "local"

[env.staging]
name = "wechat-cc-relay-staging"
routes = [{ pattern = "relay-staging.tendhearth.com", custom_domain = true }]
vars = { RELAY_ENV = "staging" }
durable_objects.bindings = [{ name = "ROOM", class_name = "Room" }]
analytics_engine_datasets = [{ binding = "METRICS", dataset = "wechat_cc_relay_staging" }]

[env.production]
name = "wechat-cc-relay"
routes = [{ pattern = "relay.tendhearth.com", custom_domain = true }]
vars = { RELAY_ENV = "production" }
durable_objects.bindings = [{ name = "ROOM", class_name = "Room" }]
analytics_engine_datasets = [{ binding = "METRICS", dataset = "wechat_cc_relay" }]
```

`apps/relay/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-plugin/types"],
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["test/e2e/**"]
}
```

`apps/relay/vitest.config.ts`:

```ts
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // 测试里把限额调小,好在几十帧内触发;推送主机指向假地址(本地 workerd 连不了 APNs,workerd#4841)。
      miniflare: {
        bindings: {
          RELAY_VERSION: 'test',
          RELAY_DAILY_BYTES: '200000',
          RELAY_DAILY_PUSHES: '3',
          RELAY_LOGIN_TIMEOUT_MS: '10000',
          APNS_HOST: 'https://fake-apns.test',
          APNS_SANDBOX_HOST: 'https://fake-apns-sandbox.test',
          FCM_HOST: 'https://fake-fcm.test',
          FCM_TOKEN_URL: 'https://fake-oauth.test/token',
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'], exclude: ['test/e2e/**'] },
})
```

> 执行者注意:`@cloudflare/vitest-plugin` 1.x 的确切导出名 / 类型入口(`cloudflareTest`、`@cloudflare/vitest-plugin/types`、`cloudflare:test` 里的 `env` / `SELF` / `runInDurableObject` / `runDurableObjectAlarm`)先用 Context7(`/cloudflare/workers-sdk`)核对一次;名字不同就按实际改,在账本记一条 Ruling。

`apps/relay/src/env.d.ts`:

```ts
declare module '*.html' {
  const html: string
  export default html
}

interface Env {
  ROOM: DurableObjectNamespace
  METRICS?: AnalyticsEngineDataset
  RELAY_VERSION?: string
  RELAY_ENV?: string
  RELAY_DAILY_BYTES?: string
  RELAY_DAILY_PUSHES?: string
  RELAY_LOGIN_TIMEOUT_MS?: string
  APNS_KEY_P8?: string
  APNS_KEY_ID?: string
  APNS_TEAM_ID?: string
  APNS_TOPIC?: string
  APNS_HOST?: string
  APNS_SANDBOX_HOST?: string
  FCM_SERVICE_ACCOUNT?: string
  FCM_HOST?: string
  FCM_TOKEN_URL?: string
}
```

根目录修改:
- `tsconfig.json` 的 `exclude` 加 `"apps/relay/**"`(它的类型是 Workers 的,跟 bun 类型冲突)。
- `package.json` 的 `typecheck` 改为 `tsc --noEmit && tsc --noEmit -p apps/mobile && tsc --noEmit -p apps/relay`。
- `vitest.config.ts` 的 `exclude` 加 `'apps/relay/**'`(中继测试要跑在 workerd 里,由它自己的配置跑)。`vitest.node.config.ts` 的 include 本来不含 `apps/relay`,不用改。
- `.dependency-cruiser.cjs`:`depcheck` 只扫 `src cli.ts setup.ts docs.ts apps/mobile`,不含 `apps/relay`,不用改;确认一次即可。

Run: `bun install`
Expected: 装上 wrangler / vitest-plugin / workers-types,`bun.lock` 更新。

- [ ] **Step 2: 写失败的测试**

`apps/relay/test/limits.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { LIMITS, limitsFrom, makeBucket, utcDay, utf8Len } from '../src/limits'

describe('limits', () => {
  it('spec §6 的缺省值', () => {
    expect(LIMITS).toMatchObject({
      maxPhoneStreams: 16, maxFrameBytes: 512 * 1024,
      phoneRate: { capacity: 120, refillPerSec: 20 }, daemonRate: { capacity: 1000, refillPerSec: 200 },
      dailyPushes: 500, dailyBytes: 1_000_000_000, loginTimeoutMs: 10_000,
    })
  })
  it('env 覆盖(字符串),非法值回落缺省', () => {
    expect(limitsFrom({ RELAY_DAILY_PUSHES: '3', RELAY_DAILY_BYTES: 'x' } as Env)).toMatchObject({ dailyPushes: 3, dailyBytes: 1_000_000_000 })
  })
  it('令牌桶:突发用完即拒,按时间补', () => {
    const b = makeBucket(2, 1)
    expect(b.take(0)).toBe(true)
    expect(b.take(0)).toBe(true)
    expect(b.take(0)).toBe(false)
    expect(b.take(1000)).toBe(true)
  })
  it('utcDay / utf8Len', () => {
    expect(utcDay(Date.UTC(2026, 8, 30, 23, 59))).toBe('2026-09-30')
    expect(utf8Len('a中')).toBe(4)
  })
})
```

`apps/relay/test/entry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

describe('入口 Worker', () => {
  it('/healthz', async () => {
    const r = await SELF.fetch('https://relay.test/healthz')
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ ok: true, version: 'test', apns: false, fcm: false })
  })
  it('/pset/ 回壳页', async () => {
    const r = await SELF.fetch('https://relay.test/pset/')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(await r.text()).toContain('new WebSocket(')   // Task 13 改成断言 '/v2/phone'
  })
  it('未知路径 404', async () => {
    expect((await SELF.fetch('https://relay.test/tunnel/phone?id=x')).status).toBe(404)
  })
  it('/v2/daemon 不是升级 ⇒ 426;子协议缺 / id 畸形 ⇒ 400', async () => {
    expect((await SELF.fetch('https://relay.test/v2/daemon')).status).toBe(426)
    const up = { Upgrade: 'websocket' }
    expect((await SELF.fetch('https://relay.test/v2/daemon', { headers: up })).status).toBe(400)
    expect((await SELF.fetch('https://relay.test/v2/daemon', { headers: { ...up, 'Sec-WebSocket-Protocol': 'wcc.relay.v2, id.NOPE' } })).status).toBe(400)
  })
  it('/v2/phone 缺 id / id 畸形 ⇒ 400', async () => {
    const up = { Upgrade: 'websocket' }
    expect((await SELF.fetch('https://relay.test/v2/phone', { headers: up })).status).toBe(400)
    expect((await SELF.fetch('https://relay.test/v2/phone?id=t123', { headers: up })).status).toBe(400)
  })
})
```

(`/pset/` 那条要等 Task 13 改了 `relay/pset.src.html` 才会含 `/v2/phone` —— 本任务先断言壳页里有 `new WebSocket(`,Task 13 改成 `'/v2/phone'`。)

- [ ] **Step 3: 跑,确认失败**

Run: `cd apps/relay && bun run test`
Expected: FAIL,`../src/limits` 不存在 / 入口未实现。

- [ ] **Step 4: 实现**

`apps/relay/src/limits.ts`:

```ts
/** 限额(spec §6)。房间内执行;测试用 env 字符串把它们调小。 */
export const LIMITS = {
  maxPhoneStreams: 16,
  maxFrameBytes: 512 * 1024,
  phoneRate: { capacity: 120, refillPerSec: 20 },
  daemonRate: { capacity: 1000, refillPerSec: 200 },
  dailyPushes: 500,
  dailyBytes: 1_000_000_000,
  loginTimeoutMs: 10_000,
  maxPushRegistrations: 20,
}
export type Limits = typeof LIMITS

const num = (s: string | undefined, dflt: number): number => {
  const n = s === undefined ? NaN : Number(s)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

export function limitsFrom(env: Env): Limits {
  return {
    ...LIMITS,
    dailyPushes: num(env.RELAY_DAILY_PUSHES, LIMITS.dailyPushes),
    dailyBytes: num(env.RELAY_DAILY_BYTES, LIMITS.dailyBytes),
    loginTimeoutMs: num(env.RELAY_LOGIN_TIMEOUT_MS, LIMITS.loginTimeoutMs),
  }
}

export interface TokenBucket { take(now: number): boolean }

export function makeBucket(capacity: number, refillPerSec: number): TokenBucket {
  let tokens = capacity
  let last: number | null = null
  return {
    take(now) {
      if (last !== null) tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec)
      last = now
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

const enc = new TextEncoder()
/** 字符串 UTF-8 字节数;明显远低于上限时走快路(每个 UTF-16 单元最多 3 字节)。 */
export function utf8Len(s: string): number {
  return enc.encode(s).byteLength
}
```

`apps/relay/src/metrics.ts`:

```ts
/** 只记计数、不带任何 id(spec §7)。没绑 Analytics Engine(本地 / 测试)⇒ 空操作。 */
export function count(env: Env, event: string): void {
  try { env.METRICS?.writeDataPoint({ blobs: [event], doubles: [1] }) } catch { /* 指标丢了不影响转发 */ }
}
```

`apps/relay/src/room.ts`(本任务的占位,Task 4 替换整个文件):

```ts
import { DurableObject } from 'cloudflare:workers'

export class Room extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return new Response('not implemented', { status: 501 })
  }
}
```

`apps/relay/src/index.ts`:

```ts
/**
 * 官方中继 v2 入口(spec 2026-09-30 §3)。只分流:daemon / 手机的 WebSocket 交给按 daemon id
 * 命名的房间(Durable Object),壳页与健康检查就地回。**不解密任何东西,不记 id。**
 *
 * daemon 的 id 不进 URL(spec §7):放在 WebSocket 子协议里(`wcc.relay.v2, id.<rid>`),
 * 所有 WebSocket 实现都能带子协议,且不会出现在任何 URL 日志里。
 */
import { RELAY_ID_RE, RELAY_SUBPROTOCOL } from '@wechat-cc/protocol'
import PSET_HTML from '../../../relay/pset.html'
import { count } from './metrics'

export { Room } from './room'

function toRoom(req: Request, env: Env, id: string, role: 'daemon' | 'phone'): Promise<Response> {
  const h = new Headers(req.headers)
  h.set('x-relay-role', role)
  h.set('x-relay-id', id)
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  return stub.fetch(new Request('https://room/' + role, { headers: h }))
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') {
      return Response.json({
        ok: true, version: env.RELAY_VERSION ?? 'dev', env: env.RELAY_ENV ?? 'local',
        apns: !!(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC),
        fcm: !!env.FCM_SERVICE_ACCOUNT,
      })
    }
    if (url.pathname === '/pset/' || url.pathname === '/pset') {
      return new Response(PSET_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    }
    const isUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket'
    if (url.pathname === '/v2/daemon') {
      if (!isUpgrade) return new Response('expected websocket', { status: 426 })
      const protos = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map(s => s.trim())
      const id = protos.find(p => p.startsWith('id.'))?.slice(3) ?? ''
      if (!protos.includes(RELAY_SUBPROTOCOL) || !RELAY_ID_RE.test(id)) return new Response('bad subprotocol', { status: 400 })
      count(env, 'daemon_connect')
      return toRoom(req, env, id, 'daemon')
    }
    if (url.pathname === '/v2/phone') {
      if (!isUpgrade) return new Response('expected websocket', { status: 426 })
      const id = url.searchParams.get('id') ?? ''
      if (!RELAY_ID_RE.test(id)) return new Response('bad id', { status: 400 })
      count(env, 'phone_connect')
      return toRoom(req, env, id, 'phone')
    }
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
```

- [ ] **Step 5: 跑,确认通过 + 类型检查**

Run: `cd apps/relay && bun run test && bun run typecheck`
Expected: PASS;`typecheck` 退出码 0。

Run: `bun run typecheck; echo "exit=$?"`(仓库根)
Expected: `exit=0`。

- [ ] **Step 6: Commit**

```bash
git add apps/relay package.json bun.lock tsconfig.json vitest.config.ts
git commit -m "apps/relay:Workers 骨架 —— 入口路由、限额工具、healthz、壳页"
```

---

### Task 4: 房间 —— daemon 挑战登录、替换、僵尸 socket

**Files:**
- Modify: `apps/relay/src/room.ts`(整份替换占位)
- Create: `apps/relay/test/helpers.ts`、`apps/relay/test/room-login.test.ts`

**Interfaces:**
- Consumes: Task 1 `verifyRelayLogin`、`DaemonControl`、`relayKeyPair`、`relayIdFromPub`、`signRelayLogin`、`RELAY_SUBPROTOCOL`;Task 3 `limitsFrom`、`count`。
- Produces(`Room` 内部,Task 5/7 在同一文件里接着写):
  - `type Att = DaemonAtt | PhoneAtt`,`DaemonAtt = { role: 'daemon'; id: string; challenge: string; openedAt: number; authed: boolean; authedAt: number; replaced: boolean }`,`PhoneAtt = { role: 'phone'; stream: string }`
  - `private currentDaemon(exclude?: WebSocket): WebSocket | null`
  - `private sendJson(ws: WebSocket, obj: unknown): void`
  - `private fail(ws: WebSocket, code: RelayError, closeCode: number): void`(发 `{error}` 再关)
  - 私有钩子(本任务留空实现):`onDaemonData(ws, raw, obj)`、`onPhoneOpen(req)`、`onPhoneMessage(ws, raw)`、`onPhoneClose(ws)`、`onDaemonGone()`
  - 测试助手 `helpers.ts`:`connectDaemon(opts?)`、`connectPhone(id)`、`nextMessage(ws)`、`waitClose(ws)`、`newIdentity()`。

- [ ] **Step 1: 写测试助手与失败的测试**

`apps/relay/test/helpers.ts`:

```ts
import { SELF } from 'cloudflare:test'
import { relayIdFromPub, relayKeyPair, signRelayLogin, RELAY_SUBPROTOCOL } from '@wechat-cc/protocol'

export interface Ident { seed: Uint8Array; id: string }
export function newIdentity(): Ident {
  const { seed, pub } = relayKeyPair()
  return { seed, id: relayIdFromPub(pub) }
}

export interface Sock { ws: WebSocket; msgs: unknown[]; closed: Promise<number>; next(): Promise<any> }

function wrap(ws: WebSocket): Sock {
  const msgs: unknown[] = []
  const waiters: Array<(m: unknown) => void> = []
  ws.addEventListener('message', ev => {
    const m = JSON.parse(String(ev.data))
    const w = waiters.shift()
    if (w) w(m); else msgs.push(m)
  })
  const closed = new Promise<number>(res => ws.addEventListener('close', ev => res(ev.code)))
  return {
    ws, msgs, closed,
    next: () => msgs.length ? Promise.resolve(msgs.shift()) : new Promise(res => waiters.push(res)),
  }
}

export async function openDaemonSocket(id: string, protocols = `${RELAY_SUBPROTOCOL}, id.${id}`): Promise<Sock> {
  const r = await SELF.fetch('https://relay.test/v2/daemon', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocols } })
  if (r.status !== 101 || !r.webSocket) throw new Error(`daemon upgrade failed: ${r.status}`)
  r.webSocket.accept()
  return wrap(r.webSocket)
}

/** 连上并完成挑战登录,返回已认证的 socket。 */
export async function connectDaemon(ident: Ident = newIdentity()): Promise<Sock & { ident: Ident }> {
  const s = await openDaemonSocket(ident.id)
  const ch = await s.next()
  s.ws.send(JSON.stringify(signRelayLogin(ident.seed, ch.challenge, ident.id)))
  const ok = await s.next()
  if (!ok.login_ok) throw new Error('login failed: ' + JSON.stringify(ok))
  return Object.assign(s, { ident })
}

export async function connectPhone(id: string): Promise<Sock> {
  const r = await SELF.fetch(`https://relay.test/v2/phone?id=${id}`, { headers: { Upgrade: 'websocket' } })
  if (r.status !== 101 || !r.webSocket) throw new Error(`phone upgrade failed: ${r.status}`)
  r.webSocket.accept()
  return wrap(r.webSocket)
}
```

`apps/relay/test/room-login.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test'
import { signRelayLogin } from '@wechat-cc/protocol'
import { connectDaemon, newIdentity, openDaemonSocket } from './helpers'

describe('房间:daemon 登录', () => {
  it('升级回包带选中的子协议;先发挑战,签对了回 login_ok', async () => {
    const ident = newIdentity()
    const r = await SELF.fetch('https://relay.test/v2/daemon', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `wcc.relay.v2, id.${ident.id}` } })
    expect(r.status).toBe(101)
    expect(r.headers.get('sec-websocket-protocol')).toBe('wcc.relay.v2')
    r.webSocket!.accept()
    const d = await connectDaemon()
    expect(d.ident.id).toMatch(/^r/)
  })

  it('错签名 ⇒ login_failed 并关闭', async () => {
    const ident = newIdentity()
    const s = await openDaemonSocket(ident.id)
    const ch = await s.next()
    s.ws.send(JSON.stringify(signRelayLogin(ident.seed, ch.challenge + 'x', ident.id)))
    expect(await s.next()).toEqual({ error: 'login_failed' })
    expect(await s.closed).toBe(4001)
  })

  it('id 与公钥不符(拿别人的 id 连)⇒ login_failed', async () => {
    const victim = newIdentity(), attacker = newIdentity()
    const s = await openDaemonSocket(victim.id)
    const ch = await s.next()
    s.ws.send(JSON.stringify(signRelayLogin(attacker.seed, ch.challenge, victim.id)))
    expect(await s.next()).toEqual({ error: 'login_failed' })
  })

  it('闹钟到点前不关刚连上、还没登录的 socket', async () => {
    const ident = newIdentity()
    const s = await openDaemonSocket(ident.id)
    await s.next()   // challenge
    const stub = env.ROOM.get(env.ROOM.idFromName(ident.id))
    await runDurableObjectAlarm(stub)
    expect(s.msgs).toEqual([])   // 真正的过期判定由下面 expiredLogins 的纯函数测试覆盖
  })

  it('ping 自动回 pong(不唤醒房间)', async () => {
    const d = await connectDaemon()
    d.ws.send('{"ping":1}')
    expect(await d.next()).toEqual({ pong: 1 })
  })
})
```

> 「10 s 超时」:`runDurableObjectAlarm` 只能立刻跑闹钟、推不动 workerd 里的 `Date.now()`。所以超时判定写成房间里的纯函数 `expiredLogins(atts, now, timeoutMs)`,导出并在同一测试文件里直接测:

```ts
import { expiredLogins } from '../src/room'
it('expiredLogins:未认证且 openedAt + 超时 ≤ now 的才算过期', () => {
  const a = { role: 'daemon', id: 'r', challenge: 'c', openedAt: 0, authed: false, authedAt: 0, replaced: false } as const
  expect(expiredLogins([a], 9_999, 10_000)).toEqual([])
  expect(expiredLogins([a], 10_000, 10_000)).toEqual([a])
  expect(expiredLogins([{ ...a, authed: true }], 99_999, 10_000)).toEqual([])
})
```

(「同 id 替换」与「僵尸 socket」两条要靠手机转发来观察,放在 Task 5 Step 1,与转发同一任务实现。)

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/relay && bun run test test/room-login.test.ts`
Expected: FAIL —— 占位房间回 501,`daemon upgrade failed: 501`。

- [ ] **Step 3: 实现房间(登录部分 + 后续任务要用的骨架)**

`apps/relay/src/room.ts`:

```ts
/**
 * Room —— 每个 daemon 一个的 Durable Object(spec §3–§6)。
 *
 * 持有这台 daemon 唯一的已认证 WebSocket 与连进来的手机流,沿用老中继的 `{stream, frame}` 包装转发;
 * 执行限额;存推送登记并调 APNs / FCM。休眠 API:内存状态随时会丢,一切路由都能从 socket
 * attachment 重建 —— daemon socket 的 attachment 记着 authed / authedAt / replaced,手机的记着 stream。
 *
 * 僵尸 socket(老中继的 bug,spec §2 #2):关闭处理只在「关掉的正是当前 daemon、且没有别的当前 daemon」
 * 时才清手机流;被替换的、没登录的 socket 断开什么也不动。
 */
import { DurableObject } from 'cloudflare:workers'
import { b64uEncode, DaemonControl, RELAY_SUBPROTOCOL, verifyRelayLogin, type RelayError } from '@wechat-cc/protocol'
import { limitsFrom, type Limits } from './limits'
import { count } from './metrics'

export type DaemonAtt = { role: 'daemon'; id: string; challenge: string; openedAt: number; authed: boolean; authedAt: number; replaced: boolean }
export type PhoneAtt = { role: 'phone'; stream: string }
export type Att = DaemonAtt | PhoneAtt

export function expiredLogins(atts: readonly DaemonAtt[], now: number, timeoutMs: number): DaemonAtt[] {
  return atts.filter(a => !a.authed && a.openedAt + timeoutMs <= now)
}

export class Room extends DurableObject<Env> {
  protected limits: Limits

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.limits = limitsFrom(env)
    // daemon 心跳用固定串,边缘直接回、不唤醒房间(tunnel-client 发 {"ping":1})。
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"ping":1}', '{"pong":1}'))
  }

  protected att(ws: WebSocket): Att | null {
    try { return ws.deserializeAttachment() as Att | null } catch { return null }
  }

  protected sendJson(ws: WebSocket, obj: unknown): void {
    try { ws.send(JSON.stringify(obj)) } catch { /* 已经关了 */ }
  }

  protected fail(ws: WebSocket, code: RelayError, closeCode: number): void {
    count(this.env, `error_${code}`)
    this.sendJson(ws, { error: code })
    try { ws.close(closeCode, code) } catch { /* 已经关了 */ }
  }

  /** 当前 daemon:已认证、未被替换、authedAt 最大的那条(可排除一条正在关的)。 */
  protected currentDaemon(exclude?: WebSocket): WebSocket | null {
    let best: WebSocket | null = null
    let bestAt = -1
    for (const ws of this.ctx.getWebSockets('daemon')) {
      if (ws === exclude) continue
      const a = this.att(ws)
      if (a?.role !== 'daemon' || !a.authed || a.replaced) continue
      if (a.authedAt > bestAt) { best = ws; bestAt = a.authedAt }
    }
    return best
  }

  async fetch(req: Request): Promise<Response> {
    const role = req.headers.get('x-relay-role')
    const id = req.headers.get('x-relay-id') ?? ''
    if (role === 'daemon') return this.openDaemon(id)
    if (role === 'phone') return this.onPhoneOpen()
    return new Response('bad role', { status: 400 })
  }

  private async openDaemon(id: string): Promise<Response> {
    const pair = new WebSocketPair()
    const server = pair[1]
    this.ctx.acceptWebSocket(server, ['daemon'])
    const challenge = b64uEncode(crypto.getRandomValues(new Uint8Array(32)))
    const a: DaemonAtt = { role: 'daemon', id, challenge, openedAt: Date.now(), authed: false, authedAt: 0, replaced: false }
    server.serializeAttachment(a)
    this.sendJson(server, { challenge, ts: a.openedAt })
    const due = a.openedAt + this.limits.loginTimeoutMs
    const cur = await this.ctx.storage.getAlarm()
    if (cur === null || cur > due) await this.ctx.storage.setAlarm(due)
    return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': RELAY_SUBPROTOCOL } })
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    const socks = this.ctx.getWebSockets('daemon')
    const pending: Array<[WebSocket, DaemonAtt]> = []
    for (const ws of socks) { const a = this.att(ws); if (a?.role === 'daemon' && !a.authed) pending.push([ws, a]) }
    const expired = new Set(expiredLogins(pending.map(p => p[1]), now, this.limits.loginTimeoutMs))
    let next: number | null = null
    for (const [ws, a] of pending) {
      if (expired.has(a)) this.fail(ws, 'login_failed', 4001)
      else next = Math.min(next ?? Infinity, a.openedAt + this.limits.loginTimeoutMs)
    }
    if (next !== null) await this.ctx.storage.setAlarm(next)
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return   // 协议全是 JSON 文本
    const a = this.att(ws)
    if (!a) return
    if (a.role === 'phone') { await this.onPhoneMessage(ws, a, message); return }
    if (!a.authed) { this.onLogin(ws, a, message); return }
    await this.onDaemonData(ws, message)
  }

  private onLogin(ws: WebSocket, a: DaemonAtt, raw: string): void {
    let obj: unknown
    try { obj = JSON.parse(raw) } catch { this.fail(ws, 'login_failed', 4001); return }
    const m = DaemonControl.safeParse(obj)
    if (!m.success || !('pub' in m.data) || !verifyRelayLogin(a.id, a.challenge, m.data.pub, m.data.sig)) {
      this.fail(ws, 'login_failed', 4001)
      return
    }
    // 新的已认证连接替换旧的:先把旧的标成 replaced 再关,它的 close 回调就什么也不动。
    for (const old of this.ctx.getWebSockets('daemon')) {
      if (old === ws) continue
      const oa = this.att(old)
      if (oa?.role === 'daemon' && oa.authed && !oa.replaced) {
        old.serializeAttachment({ ...oa, replaced: true })
        try { old.close(4000, 'replaced') } catch { /* 已经关了 */ }
      }
    }
    ws.serializeAttachment({ ...a, authed: true, authedAt: Date.now(), challenge: '' })
    count(this.env, 'daemon_login')
    this.sendJson(ws, { login_ok: true })
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code) } catch { /* 已经关了 */ }
    const a = this.att(ws)
    if (!a) return
    if (a.role === 'phone') { this.onPhoneClose(ws, a); return }
    if (a.authed && !a.replaced && !this.currentDaemon(ws)) this.onDaemonGone()
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011)
  }

  // ── Task 5 / Task 7 填的钩子 ───────────────────────────────────────
  protected async onDaemonData(_ws: WebSocket, _raw: string): Promise<void> { /* Task 5 */ }
  protected async onPhoneOpen(): Promise<Response> { return new Response('not implemented', { status: 501 }) }
  protected async onPhoneMessage(_ws: WebSocket, _a: PhoneAtt, _raw: string): Promise<void> { /* Task 5 */ }
  protected onPhoneClose(_ws: WebSocket, _a: PhoneAtt): void { /* Task 5 */ }
  protected onDaemonGone(): void { /* Task 5 */ }
}
```

- [ ] **Step 4: 跑,确认通过**

Run: `cd apps/relay && bun run test test/room-login.test.ts && bun run typecheck`
Expected: PASS;typecheck 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/room.ts apps/relay/test/helpers.ts apps/relay/test/room-login.test.ts
git commit -m "中继房间:daemon 挑战登录、同 id 替换、登录超时闹钟、心跳自动回复"
```

---

### Task 5: 房间 —— 手机流转发、限额、显式错误、休眠恢复

**Files:**
- Modify: `apps/relay/src/room.ts`(填 Task 4 的五个钩子)
- Create: `apps/relay/test/room-streams.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `Room` 骨架、`Att`、`currentDaemon`、`fail`;Task 3 `makeBucket`、`utf8Len`、`utcDay`。
- Produces:
  - 手机 → daemon:`{stream, frame}`;daemon → 手机:按 `stream` 找 socket(tag = stream id),发 `JSON.stringify(frame)`;手机断开 ⇒ daemon 收 `{stream, closed:true}`。
  - daemon 断开(且是当前)⇒ 每条手机流收 `{error:'daemon_offline'}` 后关闭(1011)。
  - `protected usage(): Promise<{ day: string; bytes: number; pushes: number }>`、`protected addBytes(n: number): Promise<void>`、`protected async bumpPushes(): Promise<boolean>`(Task 7 用;超额返回 false)。
  - 错误:手机连上时无当前 daemon ⇒ `daemon_offline`;手机流已满 16 ⇒ `too_many_streams`;当天字节超额 ⇒ `quota_exceeded`;手机帧超 512 KiB ⇒ `frame_too_large` 并关(1009);手机超速 ⇒ `rate_limited` 并关(1008);daemon 帧超 512 KiB ⇒ 回 daemon `{error:'frame_too_large'}` 丢帧;daemon 发给某流的帧超 512 KiB 由上一条覆盖(整帧就超);daemon 超速 ⇒ 回 daemon `{error:'rate_limited'}`(每秒最多一次)丢帧,不关。

- [ ] **Step 1: 写失败的测试**

`apps/relay/test/room-streams.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import { connectDaemon, connectPhone, newIdentity, openDaemonSocket } from './helpers'

describe('房间:手机流', () => {
  it('daemon 不在线 ⇒ 手机收 daemon_offline 后被关', async () => {
    const p = await connectPhone(newIdentity().id)
    expect(await p.next()).toEqual({ error: 'daemon_offline' })
    await p.closed
  })

  it('双向转发 + 手机断开通知 daemon', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    p.ws.send(JSON.stringify({ hs: 'pub' }))
    const up = await d.next()
    expect(up).toMatchObject({ frame: { hs: 'pub' } })
    expect(typeof up.stream).toBe('string')
    d.ws.send(JSON.stringify({ stream: up.stream, frame: { hs: 'dpub', v: 2 } }))
    expect(await p.next()).toEqual({ hs: 'dpub', v: 2 })
    p.ws.close(1000)
    expect(await d.next()).toEqual({ stream: up.stream, closed: true })
  })

  it('daemon 发给不存在的流 ⇒ 静默丢(不回错、不崩)', async () => {
    const d = await connectDaemon()
    d.ws.send(JSON.stringify({ stream: 'nope', frame: { x: 1 } }))
    d.ws.send('{"ping":1}')
    expect(await d.next()).toEqual({ pong: 1 })
  })

  it('同一 id 第二条已认证连接替换第一条;旧的被关(4000),新连接收手机帧', async () => {
    const first = await connectDaemon()
    const second = await connectDaemon(first.ident)
    expect(await first.closed).toBe(4000)
    const p = await connectPhone(first.ident.id)
    p.ws.send(JSON.stringify({ hs: 'x' }))
    expect(await second.next()).toMatchObject({ frame: { hs: 'x' } })
  })

  it('僵尸:未认证的冒名 socket 断开,不踢已认证 daemon 的手机', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    const imposter = await openDaemonSocket(d.ident.id)
    await imposter.next()
    imposter.ws.close(1000)
    await imposter.closed
    p.ws.send(JSON.stringify({ hs: 'y' }))
    expect(await d.next()).toMatchObject({ frame: { hs: 'y' } })
  })

  it('当前 daemon 断开 ⇒ 手机收 daemon_offline 并被关', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    d.ws.close(1000)
    expect(await p.next()).toEqual({ error: 'daemon_offline' })
    await p.closed
  })

  it('第 17 条手机流 ⇒ too_many_streams', async () => {
    const d = await connectDaemon()
    for (let i = 0; i < 16; i++) await connectPhone(d.ident.id)
    const extra = await connectPhone(d.ident.id)
    expect(await extra.next()).toEqual({ error: 'too_many_streams' })
  })

  it('手机帧超 512 KiB ⇒ frame_too_large 并关', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    p.ws.send(JSON.stringify({ ct: 'x'.repeat(512 * 1024) }))
    expect(await p.next()).toEqual({ error: 'frame_too_large' })
    expect(await p.closed).toBe(1009)
  })

  it('手机超速(突发 120)⇒ 第 121 帧收 rate_limited 并关', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    for (let i = 0; i < 121; i++) p.ws.send(JSON.stringify({ ct: String(i) }))
    let err: any
    while (!(err = p.msgs.find((m: any) => m.error)) ) await new Promise(r => setTimeout(r, 5))
    expect(err).toEqual({ error: 'rate_limited' })
    expect(await p.closed).toBe(1008)
  })

  it('daemon 帧超 512 KiB ⇒ 回 daemon frame_too_large,连接不关', async () => {
    const d = await connectDaemon()
    d.ws.send(JSON.stringify({ stream: 's', frame: { ct: 'x'.repeat(512 * 1024) } }))
    expect(await d.next()).toEqual({ error: 'frame_too_large' })
    d.ws.send('{"ping":1}')
    expect(await d.next()).toEqual({ pong: 1 })
  })

  it('当天流量超额(测试上限 200000 字节)⇒ 新手机流 quota_exceeded', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    const chunk = JSON.stringify({ ct: 'x'.repeat(60_000) })
    for (let i = 0; i < 4; i++) { p.ws.send(chunk); await d.next() }
    const late = await connectPhone(d.ident.id)
    expect(await late.next()).toEqual({ error: 'quota_exceeded' })
  })

  it('休眠恢复:清掉内存状态后,流映射从 attachment 重建', async () => {
    const d = await connectDaemon()
    const p = await connectPhone(d.ident.id)
    p.ws.send(JSON.stringify({ hs: 'a' }))
    const up = await d.next()
    const stub = env.ROOM.get(env.ROOM.idFromName(d.ident.id))
    await runInDurableObject(stub, (room: any) => { room.forgetMemory() })
    d.ws.send(JSON.stringify({ stream: up.stream, frame: { ok: 1 } }))
    expect(await p.next()).toEqual({ ok: 1 })
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/relay && bun run test test/room-streams.test.ts`
Expected: FAIL —— 手机升级回 501(`onPhoneOpen` 占位)。

- [ ] **Step 3: 实现**

在 `room.ts` 顶部 import 补:`import { makeBucket, utcDay, utf8Len, type TokenBucket } from './limits'`。

在 `Room` 类里加内存状态与 `forgetMemory()`(测试用来模拟休眠后丢内存):

```ts
  private buckets = new Map<string, TokenBucket>()
  private usageCache: { day: string; bytes: number; pushes: number; flushedBytes: number } | null = null
  private lastDaemonRateErr = 0
  private streamSeq = 0

  /** 模拟休眠:扔掉全部内存状态(测试用;真休眠由运行时做)。 */
  forgetMemory(): void {
    this.buckets.clear()
    this.usageCache = null
    this.lastDaemonRateErr = 0
  }

  private bucket(key: string, rate: { capacity: number; refillPerSec: number }): TokenBucket {
    let b = this.buckets.get(key)
    if (!b) { b = makeBucket(rate.capacity, rate.refillPerSec); this.buckets.set(key, b) }
    return b
  }

  protected async usage(): Promise<{ day: string; bytes: number; pushes: number }> {
    const day = utcDay(Date.now())
    if (!this.usageCache || this.usageCache.day !== day) {
      const stored = await this.ctx.storage.get<{ bytes: number; pushes: number }>(`usage:${day}`)
      this.usageCache = { day, bytes: stored?.bytes ?? 0, pushes: stored?.pushes ?? 0, flushedBytes: stored?.bytes ?? 0 }
    }
    return this.usageCache
  }

  private async flushUsage(): Promise<void> {
    const u = this.usageCache
    if (!u) return
    u.flushedBytes = u.bytes
    await this.ctx.storage.put(`usage:${u.day}`, { bytes: u.bytes, pushes: u.pushes })
  }

  /** 字节计数:内存累加,每多 1 MiB 落一次盘(休眠丢掉的最多 1 MiB,可接受)。 */
  protected async addBytes(n: number): Promise<void> {
    const u = await this.usage()
    ;(u as { bytes: number }).bytes += n
    if (this.usageCache && this.usageCache.bytes - this.usageCache.flushedBytes >= 1024 * 1024) await this.flushUsage()
  }

  /** 推送计数:超额返回 false;每条都落盘(推送量小)。 */
  protected async bumpPushes(): Promise<boolean> {
    const u = await this.usage()
    if (u.pushes >= this.limits.dailyPushes) return false
    ;(u as { pushes: number }).pushes += 1
    await this.flushUsage()
    return true
  }
```

替换五个钩子:

```ts
  protected async onPhoneOpen(): Promise<Response> {
    const pair = new WebSocketPair()
    const server = pair[1]
    const stream = `s${Date.now().toString(36)}${(this.streamSeq++).toString(36)}${b64uEncode(crypto.getRandomValues(new Uint8Array(3)))}`
    this.ctx.acceptWebSocket(server, ['phone', stream])
    server.serializeAttachment({ role: 'phone', stream } satisfies PhoneAtt)
    const others = this.ctx.getWebSockets('phone').filter(w => w !== server).length
    if (!this.currentDaemon()) this.fail(server, 'daemon_offline', 1011)
    else if (others >= this.limits.maxPhoneStreams) this.fail(server, 'too_many_streams', 1013)
    else if ((await this.usage()).bytes >= this.limits.dailyBytes) this.fail(server, 'quota_exceeded', 1013)
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  protected async onPhoneMessage(ws: WebSocket, a: PhoneAtt, raw: string): Promise<void> {
    const size = utf8Len(raw)
    if (size > this.limits.maxFrameBytes) { this.fail(ws, 'frame_too_large', 1009); return }
    if (!this.bucket(`p:${a.stream}`, this.limits.phoneRate).take(Date.now())) { this.fail(ws, 'rate_limited', 1008); return }
    const daemon = this.currentDaemon()
    if (!daemon) { this.fail(ws, 'daemon_offline', 1011); return }
    let frame: unknown
    try { frame = JSON.parse(raw) } catch { return }   // 必须是 JSON 信封,内容不透明
    this.sendJson(daemon, { stream: a.stream, frame })
    await this.addBytes(size)
  }

  protected onPhoneClose(_ws: WebSocket, a: PhoneAtt): void {
    this.buckets.delete(`p:${a.stream}`)
    const daemon = this.currentDaemon()
    if (daemon) this.sendJson(daemon, { stream: a.stream, closed: true })
  }

  protected onDaemonGone(): void {
    for (const p of this.ctx.getWebSockets('phone')) this.fail(p, 'daemon_offline', 1011)
  }

  protected async onDaemonData(ws: WebSocket, raw: string): Promise<void> {
    const size = utf8Len(raw)
    if (size > this.limits.maxFrameBytes) { this.sendJson(ws, { error: 'frame_too_large' }); return }
    const now = Date.now()
    if (!this.bucket('daemon', this.limits.daemonRate).take(now)) {
      if (now - this.lastDaemonRateErr >= 1000) { this.lastDaemonRateErr = now; this.sendJson(ws, { error: 'rate_limited' }) }
      return
    }
    let msg: Record<string, unknown>
    try { msg = JSON.parse(raw) as Record<string, unknown> } catch { return }
    if (msg.ping !== undefined) { this.sendJson(ws, { pong: msg.ping }); return }   // 非固定串的老式 ping
    if (typeof msg.stream === 'string') {
      const phone = this.ctx.getWebSockets(msg.stream)[0]
      if (!phone) return   // 未知 / 已关的流 —— 丢
      this.sendJson(phone, msg.frame ?? {})
      await this.addBytes(size)
      return
    }
    await this.onDaemonControl(ws, msg)
  }

  /** Task 7:push_reg / push_unreg / push。 */
  protected async onDaemonControl(_ws: WebSocket, _msg: Record<string, unknown>): Promise<void> { /* Task 7 */ }
```

注意 `onPhoneOpen` 里对 tag 的约定:手机 socket 有两个 tag(`'phone'` 与它的 stream id),所以 `getWebSockets(stream)` 能直接取到它 —— 这就是休眠后的流映射,不需要内存表。

- [ ] **Step 4: 跑整套中继测试**

Run: `cd apps/relay && bun run test && bun run typecheck`
Expected: PASS;typecheck 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/room.ts apps/relay/test/room-streams.test.ts
git commit -m "中继房间:手机流转发、每项限额与显式错误码、只清当前 daemon 的流、休眠后按 tag 恢复"
```

---

### Task 6: 推送发送方 —— APNs(ES256 JWT)与 FCM(HTTP v1)

**Files:**
- Create: `apps/relay/src/push-apns.ts`、`apps/relay/src/push-fcm.ts`、`apps/relay/src/push.ts`
- Create: `apps/relay/test/push-senders.test.ts`

**Interfaces:**
- Consumes: Task 1 `PushPlatformT`、`SealedPush` 形状。
- Produces:
  - `type PushOutcome = { ok: true; code: 'ok' } | { ok: false; code: string; invalid: boolean }`
  - `sendApns(opts: { keyP8: string; keyId: string; teamId: string; topic: string; host: string; token: string; sealed: SealedPush; collapseId?: string; now: number; fetch: typeof fetch }): Promise<PushOutcome>`
  - `sendFcm(opts: { serviceAccount: string; host: string; tokenUrl: string; token: string; sealed: SealedPush; collapseId?: string; now: number; fetch: typeof fetch }): Promise<PushOutcome>`
  - `sendPush(env: Env, reg: { platform: PushPlatformT; token: string }, sealed: SealedPush, collapseId: string | undefined, fetchImpl?: typeof fetch): Promise<PushOutcome>`(没配凭据 ⇒ `{ok:false, code:'not_configured', invalid:false}`)
  - JWT 缓存:APNs 50 分钟、FCM OAuth token 按 `expires_in - 60 s`(模块级 Map,按 keyId / client_email 键)。
  - 失效判定:APNs 410,或 400 且 reason ∈ {`BadDeviceToken`, `DeviceTokenNotForTopic`} ⇒ `invalid:true`;FCM 404 或 error.details 里 `errorCode` = `UNREGISTERED` ⇒ `invalid:true`;网络异常 ⇒ `{ok:false, code:'network', invalid:false}`。
  - APNs 请求:`POST {host}/3/device/{token}`,头 `authorization: bearer <jwt>`、`apns-topic`、`apns-push-type: alert`、`apns-priority: 10`、`apns-expiration: now+1h`、`apns-collapse-id`(有才带);体 `{"aps":{"alert":{"title":"CC","body":"CC 有新动态"},"mutable-content":1,"sound":"default"},"wcc":<sealed>}`。
  - FCM 请求:`POST {host}/v1/projects/{project_id}/messages:send`,体 `{"message":{"token":…,"data":{"wcc":JSON.stringify(sealed)},"android":{"priority":"HIGH","collapse_key":…,"ttl":"3600s"}}}`。

- [ ] **Step 1: 写失败的测试**

`apps/relay/test/push-senders.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { sendApns } from '../src/push-apns'
import { sendFcm } from '../src/push-fcm'

const SEALED = { v: 1 as const, iv: 'aXY', ct: 'Y3Q' }

async function p256Pem(): Promise<string> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey) as ArrayBuffer)
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`
}
async function rsaPem(): Promise<string> {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey) as ArrayBuffer)
  let b = ''; for (const x of der) b += String.fromCharCode(x)
  return `-----BEGIN PRIVATE KEY-----\n${btoa(b)}\n-----END PRIVATE KEY-----`
}
const b64uJson = (s: string) => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')))

describe('APNs', () => {
  it('请求形状:路径、头、占位 alert、mutable-content、加密块;JWT 是 ES256 + kid/iss', async () => {
    const keyP8 = await p256Pem()
    const f = vi.fn(async () => new Response(null, { status: 200 }))
    const r = await sendApns({ keyP8, keyId: 'KID1', teamId: '9Y6JAPDP7A', topic: 'com.example.cc', host: 'https://fake-apns.test', token: 'ab'.repeat(32), sealed: SEALED, collapseId: 't1', now: 1_700_000_000_000, fetch: f as never })
    expect(r).toEqual({ ok: true, code: 'ok' })
    const [url, init] = f.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe(`https://fake-apns.test/3/device/${'ab'.repeat(32)}`)
    const h = new Headers(init.headers)
    expect(h.get('apns-topic')).toBe('com.example.cc')
    expect(h.get('apns-push-type')).toBe('alert')
    expect(h.get('apns-collapse-id')).toBe('t1')
    const [hdr, claims] = h.get('authorization')!.replace('bearer ', '').split('.')
    expect(b64uJson(hdr!)).toEqual({ alg: 'ES256', kid: 'KID1' })
    expect(b64uJson(claims!)).toEqual({ iss: '9Y6JAPDP7A', iat: 1_700_000_000 })
    const body = JSON.parse(String(init.body))
    expect(body.aps).toEqual({ alert: { title: 'CC', body: 'CC 有新动态' }, 'mutable-content': 1, sound: 'default' })
    expect(body.wcc).toEqual(SEALED)
  })
  it('410 ⇒ invalid;400 BadDeviceToken ⇒ invalid;403 InvalidProviderToken ⇒ 不是 invalid', async () => {
    const keyP8 = await p256Pem()
    const base = { keyP8, keyId: 'K2', teamId: 'T', topic: 'x', host: 'https://h', token: 'cd'.repeat(32), sealed: SEALED, now: 1_700_000_000_000 }
    const resp = (status: number, reason?: string) => vi.fn(async () => new Response(reason ? JSON.stringify({ reason }) : null, { status })) as never
    expect(await sendApns({ ...base, fetch: resp(410, 'Unregistered') })).toEqual({ ok: false, code: 'Unregistered', invalid: true })
    expect(await sendApns({ ...base, fetch: resp(400, 'BadDeviceToken') })).toEqual({ ok: false, code: 'BadDeviceToken', invalid: true })
    expect(await sendApns({ ...base, fetch: resp(403, 'InvalidProviderToken') })).toEqual({ ok: false, code: 'InvalidProviderToken', invalid: false })
  })
  it('网络异常 ⇒ network', async () => {
    const keyP8 = await p256Pem()
    const r = await sendApns({ keyP8, keyId: 'K3', teamId: 'T', topic: 'x', host: 'https://h', token: 'ef'.repeat(32), sealed: SEALED, now: 1, fetch: (async () => { throw new Error('boom') }) as never })
    expect(r).toEqual({ ok: false, code: 'network', invalid: false })
  })
})

describe('FCM', () => {
  it('先换 OAuth token(缓存),再发 data message', async () => {
    const sa = JSON.stringify({ project_id: 'proj', client_email: 'svc@proj.iam.gserviceaccount.com', private_key: await rsaPem() })
    const f = vi.fn(async (url: string) => url.includes('oauth')
      ? Response.json({ access_token: 'AT', expires_in: 3600 })
      : Response.json({ name: 'projects/proj/messages/1' }))
    const opts = { serviceAccount: sa, host: 'https://fake-fcm.test', tokenUrl: 'https://fake-oauth.test/token', token: 'fcm-token-' + 'x'.repeat(20), sealed: SEALED, collapseId: 't1', now: 1_700_000_000_000, fetch: f as never }
    expect(await sendFcm(opts)).toEqual({ ok: true, code: 'ok' })
    expect(await sendFcm(opts)).toEqual({ ok: true, code: 'ok' })
    expect(f.mock.calls.filter(c => String(c[0]).includes('oauth'))).toHaveLength(1)
    const send = f.mock.calls.find(c => String(c[0]).includes('messages:send'))! as unknown as [string, RequestInit]
    expect(send[0]).toBe('https://fake-fcm.test/v1/projects/proj/messages:send')
    expect(new Headers(send[1].headers).get('authorization')).toBe('Bearer AT')
    const msg = JSON.parse(String(send[1].body)).message
    expect(msg.token).toBe(opts.token)
    expect(JSON.parse(msg.data.wcc)).toEqual(SEALED)
    expect(msg.android).toEqual({ priority: 'HIGH', collapse_key: 't1', ttl: '3600s' })
  })
  it('UNREGISTERED ⇒ invalid', async () => {
    const sa = JSON.stringify({ project_id: 'p2', client_email: 'a@p2.iam.gserviceaccount.com', private_key: await rsaPem() })
    const f = vi.fn(async (url: string) => url.includes('oauth')
      ? Response.json({ access_token: 'AT', expires_in: 3600 })
      : Response.json({ error: { status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, { status: 404 }))
    const r = await sendFcm({ serviceAccount: sa, host: 'https://h', tokenUrl: 'https://oauth.test', token: 't'.repeat(30), sealed: SEALED, now: 1, fetch: f as never })
    expect(r).toEqual({ ok: false, code: 'UNREGISTERED', invalid: true })
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/relay && bun run test test/push-senders.test.ts`
Expected: FAIL,`../src/push-apns` 不存在。

- [ ] **Step 3: 实现**

`apps/relay/src/push-apns.ts`:

```ts
/**
 * APNs 发送(spec §5):token-based(.p8,ES256 JWT),alert 推送 + mutable-content,加密块放 `wcc`,
 * 手机通知扩展本地解开后换成真正的标题正文。Cloudflare 边缘替 Worker 跟 Apple 说 HTTP/2(生产可用;
 * 本地 workerd 连不了,workerd#4841 —— 所以测试一律注入假 fetch)。
 */
import type { SealedPush } from '@wechat-cc/protocol'

export type PushOutcome = { ok: true; code: 'ok' } | { ok: false; code: string; invalid: boolean }

const b64u = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64uText = (s: string) => b64u(new TextEncoder().encode(s))

export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const jwtCache = new Map<string, { jwt: string; iat: number }>()
const JWT_TTL_S = 50 * 60   // Apple:20–60 分钟内复用同一枚

async function apnsJwt(keyP8: string, keyId: string, teamId: string, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000)
  const hit = jwtCache.get(keyId)
  if (hit && iat - hit.iat < JWT_TTL_S) return hit.jwt
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(keyP8), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const signingInput = `${b64uText(JSON.stringify({ alg: 'ES256', kid: keyId }))}.${b64uText(JSON.stringify({ iss: teamId, iat }))}`
  // Web Crypto 的 ECDSA 签名本来就是 JWS 要的 r||s(IEEE P1363)格式,不用转 DER。
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput)))
  const jwt = `${signingInput}.${b64u(sig)}`
  jwtCache.set(keyId, { jwt, iat })
  return jwt
}

const INVALID_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'])

export async function sendApns(o: {
  keyP8: string; keyId: string; teamId: string; topic: string; host: string
  token: string; sealed: SealedPush; collapseId?: string; now: number; fetch: typeof fetch
}): Promise<PushOutcome> {
  let res: Response
  try {
    const jwt = await apnsJwt(o.keyP8, o.keyId, o.teamId, o.now)
    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      'apns-topic': o.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(o.now / 1000) + 3600),
      'content-type': 'application/json',
    }
    if (o.collapseId) headers['apns-collapse-id'] = o.collapseId
    const body = JSON.stringify({ aps: { alert: { title: 'CC', body: 'CC 有新动态' }, 'mutable-content': 1, sound: 'default' }, wcc: o.sealed })
    res = await o.fetch(`${o.host}/3/device/${o.token}`, { method: 'POST', headers, body })
  } catch {
    return { ok: false, code: 'network', invalid: false }
  }
  if (res.status === 200) return { ok: true, code: 'ok' }
  let reason = `http_${res.status}`
  try { const j = await res.json() as { reason?: unknown }; if (typeof j.reason === 'string') reason = j.reason } catch { /* 没体 */ }
  return { ok: false, code: reason, invalid: res.status === 410 || (res.status === 400 && INVALID_REASONS.has(reason)) }
}
```

`apps/relay/src/push-fcm.ts`:

```ts
/**
 * FCM HTTP v1(spec §5):服务账号 RS256 JWT 换 OAuth access token(缓存到过期前 60 s),
 * 发 data message,加密块放 data.wcc;安卓 app 的消息服务解密后显示。
 */
import type { SealedPush } from '@wechat-cc/protocol'
import { pemToDer, type PushOutcome } from './push-apns'

const b64uText = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64u = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }

const tokenCache = new Map<string, { token: string; exp: number }>()

async function accessToken(sa: { client_email: string; private_key: string }, tokenUrl: string, nowMs: number, f: typeof fetch): Promise<string> {
  const hit = tokenCache.get(sa.client_email)
  if (hit && nowMs < hit.exp) return hit.token
  const iat = Math.floor(nowMs / 1000)
  const claims = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }
  const input = `${b64uText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64uText(JSON.stringify(claims))}`
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input)))
  const res = await f(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${input}.${b64u(sig)}`,
  })
  if (!res.ok) throw new Error(`oauth_${res.status}`)
  const j = await res.json() as { access_token: string; expires_in: number }
  tokenCache.set(sa.client_email, { token: j.access_token, exp: nowMs + (j.expires_in - 60) * 1000 })
  return j.access_token
}

export async function sendFcm(o: {
  serviceAccount: string; host: string; tokenUrl: string
  token: string; sealed: SealedPush; collapseId?: string; now: number; fetch: typeof fetch
}): Promise<PushOutcome> {
  let res: Response
  try {
    const sa = JSON.parse(o.serviceAccount) as { project_id: string; client_email: string; private_key: string }
    const at = await accessToken(sa, o.tokenUrl, o.now, o.fetch)
    const android: Record<string, string> = { priority: 'HIGH', ttl: '3600s' }
    if (o.collapseId) android.collapse_key = o.collapseId
    res = await o.fetch(`${o.host}/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: o.token, data: { wcc: JSON.stringify(o.sealed) }, android } }),
    })
  } catch {
    return { ok: false, code: 'network', invalid: false }
  }
  if (res.ok) return { ok: true, code: 'ok' }
  let code = `http_${res.status}`
  try {
    const j = await res.json() as { error?: { status?: string; details?: Array<{ errorCode?: string }> } }
    code = j.error?.details?.find(d => d.errorCode)?.errorCode ?? j.error?.status ?? code
  } catch { /* 没体 */ }
  return { ok: false, code, invalid: code === 'UNREGISTERED' || res.status === 404 }
}
```

(测试里 `android` 断言 `{ priority, collapse_key, ttl }` —— `toEqual` 不管键顺序。)

`apps/relay/src/push.ts`:

```ts
import type { PushPlatformT, SealedPush } from '@wechat-cc/protocol'
import { sendApns, type PushOutcome } from './push-apns'
import { sendFcm } from './push-fcm'

export type { PushOutcome }

export async function sendPush(
  env: Env, reg: { platform: PushPlatformT; token: string }, sealed: SealedPush, collapseId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<PushOutcome> {
  const now = Date.now()
  if (reg.platform === 'fcm') {
    if (!env.FCM_SERVICE_ACCOUNT) return { ok: false, code: 'not_configured', invalid: false }
    return sendFcm({
      serviceAccount: env.FCM_SERVICE_ACCOUNT, host: env.FCM_HOST ?? 'https://fcm.googleapis.com',
      tokenUrl: env.FCM_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
      token: reg.token, sealed, ...(collapseId ? { collapseId } : {}), now, fetch: fetchImpl,
    })
  }
  if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) return { ok: false, code: 'not_configured', invalid: false }
  const host = reg.platform === 'apns_sandbox' ? (env.APNS_SANDBOX_HOST ?? 'https://api.sandbox.push.apple.com') : (env.APNS_HOST ?? 'https://api.push.apple.com')
  return sendApns({
    keyP8: env.APNS_KEY_P8, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC, host,
    token: reg.token, sealed, ...(collapseId ? { collapseId } : {}), now, fetch: fetchImpl,
  })
}
```

- [ ] **Step 4: 跑,确认通过**

Run: `cd apps/relay && bun run test test/push-senders.test.ts && bun run typecheck`
Expected: PASS;typecheck 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/push-apns.ts apps/relay/src/push-fcm.ts apps/relay/src/push.ts apps/relay/test/push-senders.test.ts
git commit -m "中继:APNs(ES256 JWT)与 FCM(HTTP v1)发送方,失效 token 判定"
```

---

### Task 7: 房间 —— 推送登记、发送、每日配额、失效清理

**Files:**
- Modify: `apps/relay/src/room.ts`(`onDaemonControl`)
- Create: `apps/relay/test/room-push.test.ts`

**Interfaces:**
- Consumes: Task 1 `DaemonControl`、`pushTokenValid`;Task 5 `bumpPushes`;Task 6 `sendPush`。
- Produces(房间 ↔ daemon 协议):
  - `{push_reg:{device,platform,token}}` ⇒ 存 `reg:<device>` = `{platform, token, at}`;token 不合法或已满 20 台(且是新设备)⇒ 回 `{push_result:{device, ok:false, code:'invalid_token'|'too_many_devices'}}`。
  - `{push_unreg:{device}}` ⇒ 删。
  - `{push:{device,sealed,collapseId?,ref?}}` ⇒ 没登记 ⇒ `push_result code:'not_registered'`;超额 ⇒ `code:'quota_exceeded'`;否则调 `sendPush`,结果 ⇒ `{push_result:{device, ok, code, ref}}`;`invalid` ⇒ 先删登记再额外回 `{push_invalid:{device}}`。
  - 房间里 `protected pushFetch: typeof fetch = (...a) => fetch(...a)`(测试替换)。

- [ ] **Step 1: 写失败的测试**

`apps/relay/test/room-push.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import { connectDaemon } from './helpers'

const SEALED = { v: 1, iv: 'aXY', ct: 'Y3Q' }
const TOKEN = 'ab'.repeat(32)

async function withApns(id: string, status: number, reason?: string) {
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  await runInDurableObject(stub, (room: any) => {
    room.env = { ...room.env, APNS_KEY_P8: 'unused', APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_TOPIC: 'x' }
    room.pushSend = async () => status === 200 ? { ok: true, code: 'ok' } : { ok: false, code: reason ?? `http_${status}`, invalid: status === 410 || reason === 'BadDeviceToken' }
  })
}

describe('房间:推送', () => {
  it('没登记 ⇒ not_registered', async () => {
    const d = await connectDaemon()
    d.ws.send(JSON.stringify({ push: { device: 'ab12cd34', sealed: SEALED, ref: 'r1' } }))
    expect(await d.next()).toEqual({ push_result: { device: 'ab12cd34', ok: false, code: 'not_registered', ref: 'r1' } })
  })

  it('登记后发送成功 ⇒ push_result ok', async () => {
    const d = await connectDaemon()
    await withApns(d.ident.id, 200)
    d.ws.send(JSON.stringify({ push_reg: { device: 'ab12cd34', platform: 'apns', token: TOKEN } }))
    d.ws.send(JSON.stringify({ push: { device: 'ab12cd34', sealed: SEALED, collapseId: 't1', ref: 'r2' } }))
    expect(await d.next()).toEqual({ push_result: { device: 'ab12cd34', ok: true, code: 'ok', ref: 'r2' } })
  })

  it('失效 token ⇒ 删登记 + push_invalid,再发就是 not_registered', async () => {
    const d = await connectDaemon()
    await withApns(d.ident.id, 400, 'BadDeviceToken')
    d.ws.send(JSON.stringify({ push_reg: { device: 'dev1', platform: 'apns', token: TOKEN } }))
    d.ws.send(JSON.stringify({ push: { device: 'dev1', sealed: SEALED, ref: 'a' } }))
    const got = [await d.next(), await d.next()]
    expect(got).toContainEqual({ push_invalid: { device: 'dev1' } })
    expect(got).toContainEqual({ push_result: { device: 'dev1', ok: false, code: 'BadDeviceToken', ref: 'a' } })
    d.ws.send(JSON.stringify({ push: { device: 'dev1', sealed: SEALED, ref: 'b' } }))
    expect(await d.next()).toMatchObject({ push_result: { code: 'not_registered' } })
  })

  it('push_unreg 之后 ⇒ not_registered', async () => {
    const d = await connectDaemon()
    d.ws.send(JSON.stringify({ push_reg: { device: 'dev2', platform: 'fcm', token: 'f'.repeat(30) } }))
    d.ws.send(JSON.stringify({ push_unreg: { device: 'dev2' } }))
    d.ws.send(JSON.stringify({ push: { device: 'dev2', sealed: SEALED } }))
    expect(await d.next()).toMatchObject({ push_result: { code: 'not_registered' } })
  })

  it('token 不合法 ⇒ invalid_token', async () => {
    const d = await connectDaemon()
    d.ws.send(JSON.stringify({ push_reg: { device: 'dev3', platform: 'apns', token: 'zz' } }))
    expect(await d.next()).toEqual({ push_result: { device: 'dev3', ok: false, code: 'invalid_token' } })
  })

  it('每日配额(测试上限 3)⇒ 第 4 条 quota_exceeded', async () => {
    const d = await connectDaemon()
    await withApns(d.ident.id, 200)
    d.ws.send(JSON.stringify({ push_reg: { device: 'dev4', platform: 'apns', token: TOKEN } }))
    for (let i = 0; i < 4; i++) d.ws.send(JSON.stringify({ push: { device: 'dev4', sealed: SEALED, ref: String(i) } }))
    const codes = [] as string[]
    for (let i = 0; i < 4; i++) codes.push((await d.next()).push_result.code)
    expect(codes).toEqual(['ok', 'ok', 'ok', 'quota_exceeded'])
  })

  it('没配凭据 ⇒ not_configured(用真 sendPush)', async () => {
    const d = await connectDaemon()
    d.ws.send(JSON.stringify({ push_reg: { device: 'dev5', platform: 'apns', token: TOKEN } }))
    d.ws.send(JSON.stringify({ push: { device: 'dev5', sealed: SEALED } }))
    expect(await d.next()).toMatchObject({ push_result: { ok: false, code: 'not_configured' } })
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `cd apps/relay && bun run test test/room-push.test.ts`
Expected: FAIL —— `onDaemonControl` 是空的,`d.next()` 永远等不到 ⇒ 测试超时。

- [ ] **Step 3: 实现**

`room.ts` import 补:`import { pushTokenValid, type PushPlatformT, type SealedPush } from '@wechat-cc/protocol'` 与 `import { sendPush, type PushOutcome } from './push'`。

在类里加:

```ts
  /** 测试替换点:真实现是 sendPush(env, …)。 */
  protected pushSend = (reg: { platform: PushPlatformT; token: string }, sealed: SealedPush, collapseId: string | undefined): Promise<PushOutcome> =>
    sendPush(this.env, reg, sealed, collapseId)

  protected async onDaemonControl(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const m = DaemonControl.safeParse(msg)
    if (!m.success) return
    const c = m.data
    if ('push_reg' in c) {
      const { device, platform, token } = c.push_reg
      if (!pushTokenValid(platform, token)) { this.sendJson(ws, { push_result: { device, ok: false, code: 'invalid_token' } }); return }
      const existing = await this.ctx.storage.get(`reg:${device}`)
      if (!existing) {
        const n = (await this.ctx.storage.list({ prefix: 'reg:' })).size
        if (n >= this.limits.maxPushRegistrations) { this.sendJson(ws, { push_result: { device, ok: false, code: 'too_many_devices' } }); return }
      }
      await this.ctx.storage.put(`reg:${device}`, { platform, token, at: Date.now() })
      return
    }
    if ('push_unreg' in c) { await this.ctx.storage.delete(`reg:${c.push_unreg.device}`); return }
    if ('push' in c) {
      const { device, sealed, collapseId, ref } = c.push
      const reply = (ok: boolean, code: string) => this.sendJson(ws, { push_result: { device, ok, code, ...(ref !== undefined ? { ref } : {}) } })
      const reg = await this.ctx.storage.get<{ platform: PushPlatformT; token: string }>(`reg:${device}`)
      if (!reg) { reply(false, 'not_registered'); return }
      if (!(await this.bumpPushes())) { count(this.env, 'push_quota'); reply(false, 'quota_exceeded'); return }
      const r = await this.pushSend(reg, sealed as SealedPush, collapseId)
      count(this.env, r.ok ? 'push_ok' : 'push_fail')
      if (!r.ok && r.invalid) {
        await this.ctx.storage.delete(`reg:${device}`)
        this.sendJson(ws, { push_invalid: { device } })
      }
      reply(r.ok, r.code)
    }
    // 登录帧({pub,sig})在已认证之后再来:忽略。
  }
```

- [ ] **Step 4: 跑整套中继测试**

Run: `cd apps/relay && bun run test && bun run typecheck`
Expected: PASS;typecheck 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/room.ts apps/relay/test/room-push.test.ts
git commit -m "中继房间:推送登记 / 发送 / 每日配额 / 失效 token 清理"
```

---

### Task 8: daemon 身份文件(`relay-identity.ts`)

**Files:**
- Create: `src/daemon/relay-identity.ts`
- Create: `src/daemon/relay-identity.test.ts`

**Interfaces:**
- Consumes: Task 1 `relayKeyPair`、`relayIdFromPub`、`signRelayLogin`、`b64uEncode/b64uDecode`。
- Produces:
  - `DEFAULT_RELAY_V2_URL = 'wss://relay.tendhearth.com'`
  - `interface RelayIdentity { id: string; sign(challenge: string): { pub: string; sig: string } }`
  - `loadOrCreateRelayIdentity(stateDir: string): RelayIdentity` —— 文件不存在 ⇒ 生成并写 `relay-identity.json`(`{v:1, seed}`,0600,`wx` 独占创建);存在但坏 ⇒ **抛** `Error('relay_identity_corrupt')`,不重生成。

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyRelayLogin, RELAY_ID_RE } from '@wechat-cc/protocol'
import { loadOrCreateRelayIdentity } from './relay-identity'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'relay-ident-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('relay-identity', () => {
  it('首次生成:id 形状对、文件 0600、再读是同一个 id', () => {
    const a = loadOrCreateRelayIdentity(dir)
    expect(a.id).toMatch(RELAY_ID_RE)
    if (process.platform !== 'win32') expect(statSync(join(dir, 'relay-identity.json')).mode & 0o777).toBe(0o600)
    expect(loadOrCreateRelayIdentity(dir).id).toBe(a.id)
  })
  it('签名能被中继验过', () => {
    const a = loadOrCreateRelayIdentity(dir)
    const { pub, sig } = a.sign('chal')
    expect(verifyRelayLogin(a.id, 'chal', pub, sig)).toBe(true)
  })
  it('文件损坏 ⇒ 抛,绝不悄悄换一台「新电脑」', () => {
    writeFileSync(join(dir, 'relay-identity.json'), '{"v":1,"seed":"短"}')
    expect(() => loadOrCreateRelayIdentity(dir)).toThrow('relay_identity_corrupt')
    expect(readFileSync(join(dir, 'relay-identity.json'), 'utf8')).toBe('{"v":1,"seed":"短"}')
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/relay-identity.test.ts`
Expected: FAIL,模块不存在。

- [ ] **Step 3: 实现**

```ts
/**
 * 官方中继 v2 的 daemon 身份(spec 2026-09-30 §4)。Ed25519 私钥种子存 `<stateDir>/relay-identity.json`
 * (0600),与老中继的 `tunnel-id.json` 分开。id 由公钥派生(`r…`)。
 *
 * 丢了私钥 = 换了一台新「电脑」:新 id,手机要重新配对。所以文件在但读不出时**抛出**而不是重生成 ——
 * 上层记一条日志、这次不连 v2,老中继照常;修文件(或主人明确删掉它)之后重启即恢复。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { b64uDecode, b64uEncode, relayIdFromPub, relayKeyPair, signRelayLogin } from '@wechat-cc/protocol'

export const DEFAULT_RELAY_V2_URL = 'wss://relay.tendhearth.com'
const FILE = 'relay-identity.json'

export interface RelayIdentity {
  id: string
  sign(challenge: string): { pub: string; sig: string }
}

function readSeed(path: string): Uint8Array {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { v?: unknown; seed?: unknown }
    if (raw.v === 1 && typeof raw.seed === 'string') {
      const s = b64uDecode(raw.seed)
      if (s.length === 32) return s
    }
  } catch { /* 落到下面的抛 */ }
  throw new Error('relay_identity_corrupt')
}

export function loadOrCreateRelayIdentity(stateDir: string): RelayIdentity {
  const path = join(stateDir, FILE)
  let seed: Uint8Array
  if (existsSync(path)) {
    seed = readSeed(path)
  } else {
    seed = relayKeyPair().seed
    try {
      writeFileSync(path, JSON.stringify({ v: 1, seed: b64uEncode(seed) }), { mode: 0o600, flag: 'wx' })
    } catch (e) {
      // 并发启动时另一个进程先写了:用它的。
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') seed = readSeed(path)
      else throw e
    }
  }
  const id = relayIdFromPub(relayKeyPair(seed).pub)
  return { id, sign: (challenge) => signRelayLogin(seed, challenge, id) }
}
```

- [ ] **Step 4: 跑(bun 与 node 两边)**

Run: `bun --bun vitest run src/daemon/relay-identity.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/relay-identity.test.ts`
Expected: 两边都 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/relay-identity.ts src/daemon/relay-identity.test.ts
git commit -m "daemon:中继 v2 身份文件(Ed25519,损坏时拒绝重生成)"
```

---

### Task 9: 隧道客户端 —— 挑战登录、控制帧、在线订阅设备

**Files:**
- Modify: `src/daemon/tunnel-client.ts`、`src/daemon/tunnel-v2-stream.ts`
- Test: `src/daemon/tunnel-client.test.ts`(新 describe 块)

**Interfaces:**
- Consumes: Task 1 `RELAY_SUBPROTOCOL`、`relayIdProtocol`;Task 8 `RelayIdentity`(结构化:只要 `sign`)。
- Produces:
  - `TunnelClientDeps` 新字段:`login?: { sign(challenge: string): { pub: string; sig: string } }`、`onControl?: (msg: Record<string, unknown>) => void`、`onLogin?: () => void`;`connect?: (url: string, protocols?: string[]) => TunnelWS`。
  - `TunnelClient` 新方法:`sendControl(msg: object): boolean`(v2 模式要已登录)、`subscribedDeviceTokens(): Set<string>`。
  - `V2Stream.subscriptionCount(): number`。
  - 心跳 payload 统一为固定 `{"ping":1}`(让新中继的边缘自动回复,不唤醒房间;老中继照样回显)。
  - v2 模式:URL 不带 `?id=`,子协议 `[RELAY_SUBPROTOCOL, 'id.<daemonId>']`;收到 `{challenge}` ⇒ 回 `login.sign(challenge)`;收到 `{login_ok:true}` ⇒ 标记已登录、调 `onLogin`;非流帧 `push_result` / `push_invalid` / `error` ⇒ `onControl`(`error` 另记一行日志)。

- [ ] **Step 1: 写失败的测试**

在 `tunnel-client.test.ts` 末尾加:

```ts
describe('tunnel-client:中继 v2 登录与控制帧', () => {
  function v2Client(extra: Partial<Parameters<typeof makeTunnelClient>[0]> = {}) {
    const sock = fakeSocket()
    const connect = vi.fn((_url: string, _protocols?: string[]) => sock.ws as never)
    const client = makeTunnelClient({
      daemonId: 'rabc', knownDeviceTokens: () => [DTOK],
      handleRequest: async () => new Response('x'),
      connect, log: () => {}, relayUrl: 'wss://relay.test/v2/daemon',
      login: { sign: (c: string) => ({ pub: 'P', sig: `S(${c})` }) },
      ...extra,
    })
    return { sock, connect, client }
  }

  it('URL 不带 id,id 走子协议', () => {
    const { connect, client } = v2Client()
    client.start()
    expect(connect).toHaveBeenCalledWith('wss://relay.test/v2/daemon', ['wcc.relay.v2', 'id.rabc'])
    client.stop()
  })

  it('收到挑战 ⇒ 回签名;login_ok ⇒ onLogin,之后 sendControl 才发得出去', () => {
    const onLogin = vi.fn()
    const { sock, client } = v2Client({ onLogin })
    client.start(); sock.emitOpen()
    expect(client.sendControl({ push_unreg: { device: 'd1' } })).toBe(false)
    sock.emitMessage(JSON.stringify({ challenge: 'CH', ts: 1 }))
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ pub: 'P', sig: 'S(CH)' })
    sock.emitMessage(JSON.stringify({ login_ok: true }))
    expect(onLogin).toHaveBeenCalledTimes(1)
    expect(client.sendControl({ push_unreg: { device: 'd1' } })).toBe(true)
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ push_unreg: { device: 'd1' } })
    client.stop()
  })

  it('push_result / push_invalid / error ⇒ onControl', () => {
    const onControl = vi.fn()
    const { sock, client } = v2Client({ onControl })
    client.start(); sock.emitOpen()
    sock.emitMessage(JSON.stringify({ push_result: { device: 'd', ok: true, code: 'ok', ref: 'r' } }))
    sock.emitMessage(JSON.stringify({ push_invalid: { device: 'd' } }))
    sock.emitMessage(JSON.stringify({ error: 'rate_limited' }))
    expect(onControl.mock.calls.map(c => Object.keys(c[0])[0])).toEqual(['push_result', 'push_invalid', 'error'])
    client.stop()
  })

  it('断线重连后要重新登录:sendControl 回到 false', () => {
    vi.useFakeTimers()
    try {
      const { sock, client } = v2Client()
      client.start(); sock.emitOpen()
      sock.emitMessage(JSON.stringify({ challenge: 'C', ts: 1 }))
      sock.emitMessage(JSON.stringify({ login_ok: true }))
      sock.emitClose()
      expect(client.sendControl({ x: 1 })).toBe(false)
      client.stop()
    } finally { vi.useRealTimers() }
  })

  it('老模式(无 login):URL 带 ?id=,不传子协议;心跳是固定的 {"ping":1}', () => {
    vi.useFakeTimers()
    try {
      const sock = fakeSocket()
      const connect = vi.fn((_u: string, _p?: string[]) => sock.ws as never)
      const client = makeTunnelClient({ daemonId: 'tabc', knownDeviceTokens: () => [], handleRequest: async () => new Response(''), connect, log: () => {}, relayUrl: 'wss://old/tunnel/daemon', pingIntervalMs: 100 })
      client.start(); sock.emitOpen()
      expect(connect).toHaveBeenCalledWith('wss://old/tunnel/daemon?id=tabc', undefined)
      vi.advanceTimersByTime(100)
      expect(sock.sent).toContain('{"ping":1}')
      client.stop()
    } finally { vi.useRealTimers() }
  })
})
```

`subscribedDeviceTokens` 的测试放进 `src/daemon/tunnel-client-v2.test.ts`(那里有 v2 手机夹具):按该文件现有夹具走完一次 v2 握手 + 首帧识别 + 一条 `sub`,断言 `client.subscribedDeviceTokens()` 含该设备令牌;`unsub` 之后不含;流 `closed` 之后不含。照该文件已有的「sub 走到集线器」那条测试的写法组织(复用它的 helper,不另造夹具):

```ts
  it('subscribedDeviceTokens:有订阅的已识别流才算在线', async () => {
    const h = await setupV2Stream()          // 该文件已有的助手:握手 + 首帧识别完成
    expect(h.client.subscribedDeviceTokens().has(h.token)).toBe(false)
    await h.sendSub('s1', 'agents')
    expect(h.client.subscribedDeviceTokens().has(h.token)).toBe(true)
    await h.sendUnsub('s1')
    expect(h.client.subscribedDeviceTokens().has(h.token)).toBe(false)
  })
```

(`setupV2Stream` / `sendSub` / `sendUnsub` 是示意名 —— 用该文件实际已有的助手;若没有现成的组合,就在该文件里把现有测试开头那几行抽成一个本地助手,算本任务的一部分。)

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/tunnel-client.test.ts src/daemon/tunnel-client-v2.test.ts`
Expected: FAIL —— `sendControl is not a function`、`connect` 被带着 `?id=` 调用、心跳发的是 `{"ping":0}`。

- [ ] **Step 3: 实现**

`tunnel-v2-stream.ts`:`V2Stream` 接口加 `subscriptionCount(): number`,`makeV2Stream` 返回对象加 `subscriptionCount: () => subs.size`。

`tunnel-client.ts`:
- import 补 `import { RELAY_SUBPROTOCOL, relayIdProtocol } from '@wechat-cc/protocol'`。
- `TunnelClientDeps` 加上面三个字段;`connect` 签名改成 `(url: string, protocols?: string[]) => TunnelWS`。
- `TunnelClient` 接口改为 `{ start(): void; stop(): void; sendControl(msg: object): boolean; subscribedDeviceTokens(): Set<string> }`。
- `defaultConnect`:`(url, protocols) => new WebSocket(url, protocols)`(沿用原来的 globalThis 强转写法,构造器类型加第二参)。
- 状态加 `let loggedIn = false`。
- 心跳里 `sock.send(JSON.stringify({ ping: now() }))` 改为 `sock.send('{"ping":1}')`,注释补一句「固定串:新中继的边缘直接回 pong 不唤醒房间」。
- `open()`:

```ts
  function open(): void {
    if (stopped) return
    loggedIn = false
    ws = deps.login
      ? connect(relayUrl, [RELAY_SUBPROTOCOL, relayIdProtocol(deps.daemonId)])
      : connect(`${relayUrl}?id=${encodeURIComponent(deps.daemonId)}`, undefined)
    …(open / close / error 监听照旧)
```

- message 监听里,`if (msg.pong !== undefined) return` 之后、`if (typeof msg.stream !== 'string') return` 之前插入:

```ts
      if (deps.login && typeof (msg as { challenge?: unknown }).challenge === 'string') {
        try { ws?.send(JSON.stringify(deps.login.sign((msg as { challenge: string }).challenge))) } catch { /* close 会接手 */ }
        return
      }
      if ((msg as { login_ok?: unknown }).login_ok === true) {
        loggedIn = true
        log('TUNNEL', 'relay v2 login ok')
        try { deps.onLogin?.() } catch (e) { log('TUNNEL', `onLogin threw: ${String(e)}`) }
        return
      }
      if (typeof msg.stream !== 'string') {
        const m = msg as Record<string, unknown>
        if (typeof m.error === 'string') log('TUNNEL', `relay error ${m.error}`)
        if (m.push_result !== undefined || m.push_invalid !== undefined || typeof m.error === 'string') {
          try { deps.onControl?.(m) } catch (e) { log('TUNNEL', `onControl threw: ${String(e)}`) }
        }
        return
      }
```

(并删掉原来那行 `if (typeof msg.stream !== 'string') return`。)
- close 监听里 `ws = null` 之前加 `loggedIn = false`。
- 返回对象加:

```ts
    sendControl(msg) {
      if (!ws || (deps.login && !loggedIn)) return false
      try { ws.send(JSON.stringify(msg)); return true } catch { return false }
    },
    subscribedDeviceTokens() {
      const out = new Set<string>()
      for (const st of streams.values()) if (st.device && st.v2s && st.v2s.subscriptionCount() > 0) out.add(st.device)
      return out
    },
```

- 文件头注释补一段:「中继 v2(2026-09-30):给了 `login` ⇒ id 走子协议、socket 里挑战登录;登录后才发控制帧(推送登记 / 发送)。」

- [ ] **Step 4: 跑隧道相关全部测试(bun + node)**

Run: `bun --bun vitest run src/daemon/tunnel-client src/daemon/tunnel-v2-stream src/daemon/phone-e2e.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/tunnel-client src/daemon/phone-e2e.test.ts`
Expected: PASS。原有「心跳」测试断言 `includes('"ping"')`,固定串仍满足;若有测试断言 ping 值等于 `now()`,把期望改成 `1` 并在账本记 Ruling。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/tunnel-client.ts src/daemon/tunnel-v2-stream.ts src/daemon/tunnel-client.test.ts src/daemon/tunnel-client-v2.test.ts
git commit -m "隧道客户端:中继 v2 子协议 + 挑战登录 + 控制帧出入口 + 在线订阅设备"
```

---

### Task 10: daemon 推送登记与发送(`phone-push.ts`)

**Files:**
- Create: `src/daemon/phone-push.ts`
- Create: `src/daemon/phone-push.test.ts`

**Interfaces:**
- Consumes: Task 1 `PushPlatformT`、`pushTokenValid`;协议包 `derivePushKey`、`sealPush`、`openPush`(测试里验封装)。
- Produces:
  - `type PushKind = 'permission' | 'question' | 'task_done' | 'task_failed' | 'test'`
  - `interface PushPayload { kind: PushKind; title: string; body: string; taskId?: string }`
  - `interface PhonePush { register(deviceId: string, platform: PushPlatformT, token: string): boolean; unregister(deviceId: string): void; forgetAll(): void; registered(): string[]; resync(): void; notify(deviceId: string, p: PushPayload): boolean; test(deviceId: string): Promise<{ ok: boolean; code: string }>; onControl(msg: Record<string, unknown>): void }`
  - `makePhonePush(deps: { stateDir: string; send(msg: object): boolean; deviceToken(deviceId: string): string | null; deviceIds(): string[]; onChange?: () => void; now?: () => number; resultTimeoutMs?: number; log: (tag: string, line: string) => void }): PhonePush`
  - 落盘 `<stateDir>/phone-push.json` = `{ [deviceId]: { platform, token, at } }`(0600,临时文件 + rename)。
  - `resync()`:先删掉已不在 `deviceIds()` 里的登记(并发 `push_unreg`),再对每条发 `push_reg`。
  - 载荷裁剪:title ≤ 60 字、body ≤ 300 字(按码点)。`collapseId` = `taskId ?? kind`。每条 `push` 带 `ref`(`p` + 递增计数 + 随机后缀)。
  - `test()`:没登记 ⇒ `{ok:false, code:'not_registered'}`;中继没连上 ⇒ `'relay_offline'`;`resultTimeoutMs`(缺省 15000)内没回 ⇒ `'timeout'`;否则回中继的 `{ok, code}`。
  - `onControl`:`push_result` 按 `ref` 结清等待者并在失败时记一行日志;`push_invalid` ⇒ 删本地登记(不再回发 unreg)并 `onChange`;`error` 忽略(隧道客户端已记日志)。

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { derivePushKey, openPush } from '@wechat-cc/protocol'
import { makePhonePush } from './phone-push'

const APNS = 'ab'.repeat(32)
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'phone-push-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function setup(over: Partial<Parameters<typeof makePhonePush>[0]> = {}) {
  const sent: any[] = []
  const onChange = vi.fn()
  const push = makePhonePush({
    stateDir: dir, send: (m) => { sent.push(m); return true },
    deviceToken: (id) => ({ dev1: 'dtok-1', dev2: 'dtok-2' } as Record<string, string>)[id] ?? null,
    deviceIds: () => ['dev1', 'dev2'], onChange, now: () => 1_700_000_000_000, log: () => {},
    ...over,
  })
  return { push, sent, onChange }
}

describe('phone-push', () => {
  it('登记:校验 token、落盘 0600、发 push_reg、触发 onChange', () => {
    const { push, sent, onChange } = setup()
    expect(push.register('dev1', 'apns', 'zz')).toBe(false)
    expect(push.register('dev1', 'apns', APNS)).toBe(true)
    expect(sent).toContainEqual({ push_reg: { device: 'dev1', platform: 'apns', token: APNS } })
    expect(JSON.parse(readFileSync(join(dir, 'phone-push.json'), 'utf8')).dev1.token).toBe(APNS)
    expect(push.registered()).toEqual(['dev1'])
    expect(onChange).toHaveBeenCalled()
  })

  it('notify:用该设备的推送密钥封装,手机能解开;collapseId 按任务;超长标题正文被截', () => {
    const { push, sent } = setup()
    push.register('dev1', 'apns', APNS)
    expect(push.notify('dev1', { kind: 'permission', title: '标'.repeat(100), body: '正'.repeat(1000), taskId: 'ab12cd34' })).toBe(true)
    const m = sent.at(-1).push
    expect(m.device).toBe('dev1')
    expect(m.collapseId).toBe('ab12cd34')
    const pt = openPush(derivePushKey('dtok-1'), m.sealed, 1_700_000_000_000)
    expect(pt).toMatchObject({ kind: 'permission', taskId: 'ab12cd34' })
    expect([...(pt.title as string)].length).toBe(60)
    expect([...(pt.body as string)].length).toBe(300)
    expect(JSON.stringify(m.sealed).length).toBeLessThan(3500)
  })

  it('notify 没登记 / 设备令牌没了 ⇒ false(后者顺手删登记)', () => {
    const { push } = setup({ deviceToken: () => null })
    expect(push.notify('dev1', { kind: 'test', title: 't', body: 'b' })).toBe(false)
    push.register('dev1', 'apns', APNS)
    expect(push.notify('dev1', { kind: 'test', title: 't', body: 'b' })).toBe(false)
    expect(push.registered()).toEqual([])
  })

  it('test():按 ref 对上各自的结果;连发两条不串', async () => {
    const { push, sent } = setup()
    push.register('dev1', 'apns', APNS)
    const a = push.test('dev1'), b = push.test('dev1')
    const [ra, rb] = sent.filter(m => m.push).map(m => m.push.ref)
    push.onControl({ push_result: { device: 'dev1', ok: false, code: 'BadDeviceToken', ref: rb } })
    push.onControl({ push_result: { device: 'dev1', ok: true, code: 'ok', ref: ra } })
    expect(await a).toEqual({ ok: true, code: 'ok' })
    expect(await b).toEqual({ ok: false, code: 'BadDeviceToken' })
  })

  it('test():超时 ⇒ timeout;中继没连上 ⇒ relay_offline;没登记 ⇒ not_registered', async () => {
    vi.useFakeTimers()
    try {
      const { push } = setup({ resultTimeoutMs: 1000 })
      expect(await push.test('dev1')).toEqual({ ok: false, code: 'not_registered' })
      push.register('dev1', 'apns', APNS)
      const p = push.test('dev1')
      await vi.advanceTimersByTimeAsync(1000)
      expect(await p).toEqual({ ok: false, code: 'timeout' })
      const off = setup({ send: () => false }).push
      off.register('dev2', 'fcm', 'f'.repeat(30))
      expect(await off.test('dev2')).toEqual({ ok: false, code: 'relay_offline' })
    } finally { vi.useRealTimers() }
  })

  it('push_invalid ⇒ 删本地登记,不回发 unreg', () => {
    const { push, sent, onChange } = setup()
    push.register('dev1', 'apns', APNS)
    const before = sent.length
    push.onControl({ push_invalid: { device: 'dev1' } })
    expect(push.registered()).toEqual([])
    expect(sent.length).toBe(before)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('resync:修剪已撤销的设备(发 unreg),其余重发 push_reg', () => {
    const { push, sent } = setup({ deviceIds: () => ['dev2'] })
    push.register('dev1', 'apns', APNS)
    push.register('dev2', 'fcm', 'f'.repeat(30))
    sent.length = 0
    push.resync()
    expect(sent).toEqual([
      { push_unreg: { device: 'dev1' } },
      { push_reg: { device: 'dev2', platform: 'fcm', token: 'f'.repeat(30) } },
    ])
    expect(push.registered()).toEqual(['dev2'])
  })

  it('unregister / forgetAll 发 push_unreg;文件跟着清', () => {
    const { push, sent } = setup()
    push.register('dev1', 'apns', APNS)
    push.register('dev2', 'fcm', 'f'.repeat(30))
    push.unregister('dev1')
    expect(sent).toContainEqual({ push_unreg: { device: 'dev1' } })
    push.forgetAll()
    expect(sent).toContainEqual({ push_unreg: { device: 'dev2' } })
    expect(push.registered()).toEqual([])
    expect(existsSync(join(dir, 'phone-push.json'))).toBe(true)
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/phone-push.test.ts`
Expected: FAIL,模块不存在。

- [ ] **Step 3: 实现**

```ts
/**
 * phone-push.ts — daemon 这头的推送(spec 2026-09-30 §5)。
 *
 * 登记:手机经端到端隧道 POST /m/api/push/register 把 APNs / FCM token 交给自己的 daemon;这里落盘
 * `<stateDir>/phone-push.json`(0600)并经已登录的中继 socket 发 `{push_reg}`。每次登录(onLogin)
 * 都 resync 一遍:中继换过(staging → 生产)、或房间存储丢了也能自愈;顺手修剪已撤销的设备。
 *
 * 发送:用该设备的推送密钥(derivePushKey(设备令牌),子项目 1)把 `{ts,kind,title,body,taskId}`
 * sealPush,交给房间转 APNs / FCM。中继与苹果谷歌只看得到密文。
 *
 * 结果:房间回 `{push_result:{…,ref}}`,按 ref 结清等待者(test() 用);`{push_invalid}` ⇒ 删本地登记。
 */
import { randomBytes } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { derivePushKey, pushTokenValid, sealPush, type PushPlatformT } from '@wechat-cc/protocol'
import { readJsonFile } from '../lib/read-json-file'

export type PushKind = 'permission' | 'question' | 'task_done' | 'task_failed' | 'test'
export interface PushPayload { kind: PushKind; title: string; body: string; taskId?: string }

export interface PhonePush {
  register(deviceId: string, platform: PushPlatformT, token: string): boolean
  unregister(deviceId: string): void
  forgetAll(): void
  registered(): string[]
  resync(): void
  notify(deviceId: string, p: PushPayload): boolean
  test(deviceId: string): Promise<{ ok: boolean; code: string }>
  onControl(msg: Record<string, unknown>): void
}

type Row = { platform: PushPlatformT; token: string; at: number }
const FILE = 'phone-push.json'
const TITLE_MAX = 60
const BODY_MAX = 300
const clip = (s: string, n: number) => [...s].slice(0, n).join('')

export function makePhonePush(deps: {
  stateDir: string
  send(msg: object): boolean
  deviceToken(deviceId: string): string | null
  deviceIds(): string[]
  onChange?: () => void
  now?: () => number
  resultTimeoutMs?: number
  log: (tag: string, line: string) => void
}): PhonePush {
  const path = join(deps.stateDir, FILE)
  const now = deps.now ?? (() => Date.now())
  const timeoutMs = deps.resultTimeoutMs ?? 15_000
  const pending = new Map<string, (r: { ok: boolean; code: string }) => void>()
  let refSeq = 0

  const read = (): Record<string, Row> => {
    try { const r = readJsonFile(path) as Record<string, Row>; return r && typeof r === 'object' ? r : {} } catch { return {} }
  }
  const write = (rows: Record<string, Row>) => {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 })
    renameSync(tmp, path)
  }
  const changed = () => { try { deps.onChange?.() } catch { /* 通知方自己的事 */ } }

  function drop(deviceId: string, tellRelay: boolean): void {
    const rows = read()
    if (!rows[deviceId]) return
    delete rows[deviceId]
    write(rows)
    if (tellRelay) deps.send({ push_unreg: { device: deviceId } })
    changed()
  }

  function sendPush(deviceId: string, p: PushPayload): string | null {
    if (!read()[deviceId]) return null
    const token = deps.deviceToken(deviceId)
    if (!token) { drop(deviceId, true); return null }
    const payload = { ts: now(), kind: p.kind, title: clip(p.title, TITLE_MAX), body: clip(p.body, BODY_MAX), ...(p.taskId ? { taskId: p.taskId } : {}) }
    const ref = `p${(refSeq++).toString(36)}${randomBytes(3).toString('hex')}`
    const ok = deps.send({ push: { device: deviceId, sealed: sealPush(derivePushKey(token), payload), collapseId: p.taskId ?? p.kind, ref } })
    return ok ? ref : ''
  }

  return {
    register(deviceId, platform, token) {
      if (!pushTokenValid(platform, token)) return false
      const rows = read()
      rows[deviceId] = { platform, token, at: now() }
      write(rows)
      deps.send({ push_reg: { device: deviceId, platform, token } })
      changed()
      return true
    },
    unregister(deviceId) { drop(deviceId, true) },
    forgetAll() {
      const rows = read()
      for (const id of Object.keys(rows)) deps.send({ push_unreg: { device: id } })
      write({})
      if (Object.keys(rows).length) changed()
    },
    registered: () => Object.keys(read()),
    resync() {
      const live = new Set(deps.deviceIds())
      const rows = read()
      let pruned = false
      for (const id of Object.keys(rows)) {
        if (live.has(id)) continue
        delete rows[id]
        deps.send({ push_unreg: { device: id } })
        pruned = true
      }
      if (pruned) { write(rows); changed() }
      for (const [id, r] of Object.entries(rows)) deps.send({ push_reg: { device: id, platform: r.platform, token: r.token } })
    },
    notify(deviceId, p) {
      const ref = sendPush(deviceId, p)
      return !!ref
    },
    test(deviceId) {
      const ref = sendPush(deviceId, { kind: 'test', title: 'CC', body: '这是一条测试通知' })
      if (ref === null) return Promise.resolve({ ok: false, code: 'not_registered' })
      if (ref === '') return Promise.resolve({ ok: false, code: 'relay_offline' })
      return new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(ref); resolve({ ok: false, code: 'timeout' }) }, timeoutMs)
        pending.set(ref, (r) => { clearTimeout(timer); pending.delete(ref); resolve(r) })
      })
    },
    onControl(msg) {
      const r = msg.push_result as { device?: string; ok?: boolean; code?: string; ref?: string } | undefined
      if (r && typeof r.ok === 'boolean' && typeof r.code === 'string') {
        if (!r.ok) deps.log('PUSH', `push to ${r.device} failed: ${r.code}`)
        if (typeof r.ref === 'string') pending.get(r.ref)?.({ ok: r.ok, code: r.code })
        return
      }
      const inv = msg.push_invalid as { device?: string } | undefined
      if (inv && typeof inv.device === 'string') {
        deps.log('PUSH', `push token for ${inv.device} is no longer valid — unregistered`)
        drop(inv.device, false)
      }
    },
  }
}
```

(注意 test 里「连发两条不串」:`test()` 的 `sendPush` 返回 ref,等待者按 ref 进表 —— 结果先到后到都对得上。)

- [ ] **Step 4: 跑(bun + node)**

Run: `bun --bun vitest run src/daemon/phone-push.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/phone-push.test.ts`
Expected: 两边 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/phone-push.ts src/daemon/phone-push.test.ts
git commit -m "daemon:推送登记 / 封装 / 结果对应(phone-push)"
```

---

### Task 11: 「该叫醒手机了」判定(`phone-notifier.ts`)

**Files:**
- Create: `src/daemon/phone-notifier.ts`
- Create: `src/daemon/phone-notifier.test.ts`
- Modify: `src/daemon/phone-topic-sources.ts`(删 `PhoneNotify` / `noopPhoneNotify` / `onNotify`)、`src/daemon/phone-topic-sources.test.ts`(若引用了它们)

**Interfaces:**
- Consumes: `PhoneEvents.subscribe`(phone-events.ts)、`ApprovalSummary`(phone-topic-sources.ts)、Task 10 `PhonePush`(`registered`、`notify`)。
- Produces:
  - `makePhoneNotifier(deps: { events: Pick<PhoneEvents, 'subscribe'>; push: Pick<PhonePush, 'registered' | 'notify'>; subscribedDevices(): Set<string>; taskInfo(taskId: string): { title: string; status: string } | null; log: (tag: string, line: string) => void }): { refresh(): void; dispose(): void }`
  - 行为:有登记设备时才订阅 `approvals` 与 `agents`(没有就退订,别让集线器空转);每个主题第一份快照只做基线;
    - approvals 新出现的条目(键 `taskId:kind:id`)⇒ `permission`「需要你批准」/ `question`「CC 有问题问你」,body = `任务标题:摘要`;
    - agents 里某任务 phase 从 `working`/`queued` 变成 `replied` ⇒ `task_done`「做完了」;
    - 上一份有、这一份没有的任务 ⇒ `taskInfo(id).status`:`completed` 且上一份 phase 不是 `replied` ⇒ `task_done`;`failed` / `interrupted` ⇒ `task_failed`「没做成」;其余(cancelled、查不到)不推;
    - agents 里 phase 直接出现 `failed` / `interrupted` 也按 `task_failed`(防御:来源已过滤终态,这里只防万一);
    - 每条都推给 `registered()` 里、**不在** `subscribedDevices()` 里的每台设备。

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, it, expect, vi } from 'vitest'
import { makePhoneNotifier } from './phone-notifier'

function harness(opts: { registered?: string[]; online?: string[]; tasks?: Record<string, { title: string; status: string }> } = {}) {
  const handlers = new Map<string, (ev: { epoch: string; seq: number; data: unknown }) => void>()
  const unsubs: string[] = []
  const events = {
    subscribe: vi.fn((topic: string, _since: unknown, send: (ev: any) => void) => { handlers.set(topic, send); return () => { unsubs.push(topic); handlers.delete(topic) } }),
  }
  let registered = opts.registered ?? ['dev1', 'dev2']
  const notify = vi.fn(() => true)
  const n = makePhoneNotifier({
    events, push: { registered: () => registered, notify },
    subscribedDevices: () => new Set(opts.online ?? []),
    taskInfo: (id) => opts.tasks?.[id] ?? null,
    log: () => {},
  })
  let seq = 0
  const emit = (topic: string, data: unknown) => handlers.get(topic)!({ epoch: 'e', seq: ++seq, data })
  return { n, events, handlers, unsubs, notify, emit, setRegistered: (r: string[]) => { registered = r } }
}

const agents = (tasks: Array<{ id: string; title: string; phase: string }>) => ({ running: 0, waiting: 0, tasks })

describe('phone-notifier', () => {
  it('没登记设备就不订阅;有了才订阅,没了退订', () => {
    const h = harness({ registered: [] })
    h.n.refresh()
    expect(h.events.subscribe).not.toHaveBeenCalled()
    h.setRegistered(['dev1']); h.n.refresh()
    expect([...h.handlers.keys()].sort()).toEqual(['agents', 'approvals'])
    h.setRegistered([]); h.n.refresh()
    expect(h.unsubs.sort()).toEqual(['agents', 'approvals'])
  })

  it('第一份快照是基线,不推;新出现的待批准 ⇒ 推给不在线的设备', () => {
    const h = harness({ online: ['dev2'], tasks: { ab12cd34: { title: '修登录', status: 'running' } } })
    h.n.refresh()
    h.emit('approvals', [{ taskId: 'ab12cd34', kind: 'permission', id: 'p1', summary: 'Bash: rm -rf build' }])
    expect(h.notify).not.toHaveBeenCalled()
    h.emit('approvals', [
      { taskId: 'ab12cd34', kind: 'permission', id: 'p1', summary: 'Bash: rm -rf build' },
      { taskId: 'ab12cd34', kind: 'question', id: 'q1', summary: '用哪个分支?' },
    ])
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(h.notify).toHaveBeenCalledWith('dev1', { kind: 'question', title: 'CC 有问题问你', body: '修登录:用哪个分支?', taskId: 'ab12cd34' })
  })

  it('working → replied ⇒ task_done;离开列表且 failed ⇒ task_failed;cancelled 不推', () => {
    const h = harness({ registered: ['dev1'], tasks: { t1: { title: 'A', status: 'running' }, t2: { title: 'B', status: 'failed' }, t3: { title: 'C', status: 'cancelled' } } })
    h.n.refresh()
    h.emit('agents', agents([{ id: 't1', title: 'A', phase: 'working' }, { id: 't2', title: 'B', phase: 'working' }, { id: 't3', title: 'C', phase: 'working' }]))
    h.emit('agents', agents([{ id: 't1', title: 'A', phase: 'replied' }]))
    const kinds = h.notify.mock.calls.map(c => (c[1] as any).kind + ':' + (c[1] as any).taskId).sort()
    expect(kinds).toEqual(['task_done:t1', 'task_failed:t2'])
  })

  it('已经 replied 的任务再离开列表(completed)不重复推', () => {
    const h = harness({ registered: ['dev1'], tasks: { t1: { title: 'A', status: 'completed' } } })
    h.n.refresh()
    h.emit('agents', agents([{ id: 't1', title: 'A', phase: 'working' }]))
    h.emit('agents', agents([{ id: 't1', title: 'A', phase: 'replied' }]))
    h.emit('agents', agents([]))
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('两台都在线 ⇒ 一条不推', () => {
    const h = harness({ online: ['dev1', 'dev2'] })
    h.n.refresh()
    h.emit('approvals', [])
    h.emit('approvals', [{ taskId: 'x', kind: 'permission', id: 'p', summary: 's' }])
    expect(h.notify).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/phone-notifier.test.ts`
Expected: FAIL,模块不存在。

- [ ] **Step 3: 实现**

```ts
/**
 * phone-notifier.ts — 判断「该叫醒手机了」(spec 2026-09-30 §5「发送」第 1 步)。
 *
 * 不另造信号:像一台手机一样订阅事件集线器的 `approvals` 与 `agents` 两个主题(同一份摘要、同一套
 * poke),比较前后两份快照 —— 新的待批准 / 待回答、任务本轮做完(working → replied)、任务失败。
 * 第一份快照只做基线(daemon 重启不补发)。有登记设备才订阅,没有就退订,别让集线器空转。
 * 正在用实时订阅连着的手机不推(它自己看得见)。
 */
import type { PhoneEvents } from './phone-events'
import type { ApprovalSummary } from './phone-topic-sources'
import type { PhonePush, PushPayload } from './phone-push'

type AgentsSnap = { tasks: Array<{ id: string; title: string; phase: string }> }

export function makePhoneNotifier(deps: {
  events: Pick<PhoneEvents, 'subscribe'>
  push: Pick<PhonePush, 'registered' | 'notify'>
  subscribedDevices(): Set<string>
  taskInfo(taskId: string): { title: string; status: string } | null
  log: (tag: string, line: string) => void
}): { refresh(): void; dispose(): void } {
  let offs: Array<() => void> = []
  let approvalsSeen: Set<string> | null = null
  let agentsPrev: Map<string, { title: string; phase: string }> | null = null

  function fanout(p: PushPayload): void {
    const online = deps.subscribedDevices()
    for (const id of deps.push.registered()) {
      if (online.has(id)) continue
      if (!deps.push.notify(id, p)) deps.log('PUSH', `notify ${p.kind} → ${id} not sent (relay offline / unregistered)`)
    }
  }

  function onApprovals(data: unknown): void {
    const list = Array.isArray(data) ? data as ApprovalSummary[] : []
    const keys = new Map(list.map(a => [`${a.taskId}:${a.kind}:${a.id}`, a]))
    const prev = approvalsSeen
    approvalsSeen = new Set(keys.keys())
    if (!prev) return
    for (const [k, a] of keys) {
      if (prev.has(k)) continue
      const title = deps.taskInfo(a.taskId)?.title ?? ''
      fanout({
        kind: a.kind,
        title: a.kind === 'permission' ? '需要你批准' : 'CC 有问题问你',
        body: title ? `${title}:${a.summary}` : a.summary,
        taskId: a.taskId,
      })
    }
  }

  function onAgents(data: unknown): void {
    const tasks = (data as AgentsSnap | null)?.tasks ?? []
    const cur = new Map(tasks.map(t => [t.id, { title: t.title, phase: t.phase }]))
    const prev = agentsPrev
    agentsPrev = cur
    if (!prev) return
    for (const [id, t] of cur) {
      const was = prev.get(id)?.phase
      if (t.phase === 'replied' && (was === 'working' || was === 'queued')) fanout({ kind: 'task_done', title: '做完了', body: t.title, taskId: id })
      else if ((t.phase === 'failed' || t.phase === 'interrupted') && was !== t.phase) fanout({ kind: 'task_failed', title: '没做成', body: t.title, taskId: id })
    }
    for (const [id, was] of prev) {
      if (cur.has(id)) continue
      const info = deps.taskInfo(id)
      if (!info) continue
      if (info.status === 'completed' && was.phase !== 'replied') fanout({ kind: 'task_done', title: '做完了', body: info.title, taskId: id })
      else if (info.status === 'failed' || info.status === 'interrupted') fanout({ kind: 'task_failed', title: '没做成', body: info.title, taskId: id })
    }
  }

  function stop(): void {
    for (const off of offs) { try { off() } catch { /* 集线器自己的事 */ } }
    offs = []
    approvalsSeen = null
    agentsPrev = null
  }

  return {
    refresh() {
      const want = deps.push.registered().length > 0
      if (want && offs.length === 0) {
        offs = [
          deps.events.subscribe('approvals', undefined, ev => onApprovals(ev.data)),
          deps.events.subscribe('agents', undefined, ev => onAgents(ev.data)),
        ]
      } else if (!want && offs.length > 0) {
        stop()
      }
    },
    dispose: stop,
  }
}
```

`phone-topic-sources.ts`:删掉 `PhoneNotify`、`noopPhoneNotify`,`makePhoneEventsWiring` 的 deps 去掉 `onNotify`,返回类型改成 `{ events: PhoneEvents; dispose(): void }`,删掉返回对象里的 `onNotify`;文件里指向「子项目 2」的那段注释换成一句「推送判定在 phone-notifier.ts」。`grep -rn "onNotify\|noopPhoneNotify\|PhoneNotify" src` 应只剩零处(pipeline-deps 里没用到返回的 onNotify —— 核对)。

- [ ] **Step 4: 跑(bun + node)**

Run: `bun --bun vitest run src/daemon/phone-notifier.test.ts src/daemon/phone-topic-sources.test.ts src/daemon/phone-events.test.ts && npx vitest run -c vitest.node.config.ts src/daemon/phone-notifier.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/phone-notifier.ts src/daemon/phone-notifier.test.ts src/daemon/phone-topic-sources.ts src/daemon/phone-topic-sources.test.ts
git commit -m "daemon:从 approvals / agents 快照判定何时叫醒手机(取代空的 PhoneNotify 出口)"
```

---

### Task 12: 手机路由 —— 推送登记与测试通知

**Files:**
- Modify: `src/daemon/settings-panel.ts`(deps、两条路由、撤销 / 全忘时退登记)
- Modify: `src/daemon/phone-routes.ts`(`PHONE_ROUTES`)
- Modify: `packages/protocol/src/api.ts`(两条 schema)
- Test: `src/daemon/settings-panel.test.ts`(或该面板现有的路由测试文件,按 `grep -ln "/m/api/seen" src/daemon/*.test.ts` 找到同类测试放一起)、`src/daemon/phone-api-schema.test.ts`

**Interfaces:**
- Consumes: Task 1 `PushPlatform`、`pushTokenValid`;Task 10 `PhonePush` 的 `register` / `test` / `unregister` / `forgetAll`。
- Produces:
  - `SettingsPanelDeps.push?: { register(deviceId: string, platform: PushPlatformT, token: string): boolean; test(deviceId: string): Promise<{ ok: boolean; code: string }>; unregister(deviceId: string): void; forgetAll(): void }`
  - `POST /m/api/push/register` 体 `{platform, token}` ⇒ `{ok:true}`;没接线 503 `push_not_wired`;非设备令牌(链接令牌)403 `device_only`;体坏 400 `bad_json` / `invalid`。
  - `POST /m/api/push/test` ⇒ `{ok:true, result:{ok, code}}`;同样的 503 / 403。
  - `apply` 的 `revoke_device` 成功后 `deps.push?.unregister(id)`;`forget_devices` 后 `deps.push?.forgetAll()`。
  - `PHONE_API_SCHEMAS['POST /m/api/push/register']`、`['POST /m/api/push/test']`。

- [ ] **Step 1: 写失败的测试**

在面板路由测试里(沿用该文件建面板、配对拿设备令牌、发请求的现有助手;下面用 `makePanel` / `pairDevice` / `call` 示意,换成文件里的实际名字):

```ts
describe('推送路由', () => {
  it('设备令牌登记 APNs token ⇒ 交给 push.register(按设备 id)', async () => {
    const push = { register: vi.fn(() => true), test: vi.fn(), unregister: vi.fn(), forgetAll: vi.fn() }
    const { panel } = makePanel({ push })
    const { token, id } = await pairDevice(panel)
    const r = await call(panel, 'POST', '/m/api/push/register', token, { platform: 'apns', token: 'ab'.repeat(32) })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
    expect(push.register).toHaveBeenCalledWith(id, 'apns', 'ab'.repeat(32))
  })
  it('链接令牌不许登记 ⇒ 403 device_only', async () => {
    const push = { register: vi.fn(), test: vi.fn(), unregister: vi.fn(), forgetAll: vi.fn() }
    const { panel } = makePanel({ push })
    const r = await call(panel, 'POST', '/m/api/push/register', panel.issueToken(), { platform: 'apns', token: 'ab'.repeat(32) })
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ ok: false, error: 'device_only' })
  })
  it('平台 / token 不合法 ⇒ 400 invalid;没接线 ⇒ 503', async () => {
    const push = { register: vi.fn(() => false), test: vi.fn(), unregister: vi.fn(), forgetAll: vi.fn() }
    const { panel } = makePanel({ push })
    const { token } = await pairDevice(panel)
    expect((await call(panel, 'POST', '/m/api/push/register', token, { platform: 'sms', token: 'x' })).status).toBe(400)
    expect((await call(panel, 'POST', '/m/api/push/register', token, { platform: 'apns', token: 'zz' })).status).toBe(400)
    const bare = makePanel({})
    const t2 = (await pairDevice(bare.panel)).token
    expect((await call(bare.panel, 'POST', '/m/api/push/register', t2, { platform: 'apns', token: 'ab'.repeat(32) })).status).toBe(503)
  })
  it('测试通知 ⇒ 回中继结果', async () => {
    const push = { register: vi.fn(), test: vi.fn(async () => ({ ok: false, code: 'BadDeviceToken' })), unregister: vi.fn(), forgetAll: vi.fn() }
    const { panel } = makePanel({ push })
    const { token, id } = await pairDevice(panel)
    const r = await call(panel, 'POST', '/m/api/push/test', token, {})
    expect(await r.json()).toEqual({ ok: true, result: { ok: false, code: 'BadDeviceToken' } })
    expect(push.test).toHaveBeenCalledWith(id)
  })
  it('撤销 / 全忘设备 ⇒ 同时退推送登记', async () => {
    const push = { register: vi.fn(), test: vi.fn(), unregister: vi.fn(), forgetAll: vi.fn() }
    const { panel } = makePanel({ push })
    const { id } = await pairDevice(panel)
    await panel.apply({ op: 'revoke_device', id })
    expect(push.unregister).toHaveBeenCalledWith(id)
    await panel.apply({ op: 'forget_devices' })
    expect(push.forgetAll).toHaveBeenCalled()
  })
})
```

`phone-api-schema.test.ts`:按该文件对每条路由「拿真实面板回包 parse 对应 schema」的现有写法,补两条:register 成功 / device_only,test 成功。

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/settings-panel src/daemon/phone-api-schema.test.ts scripts/phone-routes.guard.test.ts`
Expected: FAIL —— 路由 403 `route_not_allowed`(不在 `PHONE_ROUTES`)。

- [ ] **Step 3: 实现**

`phone-routes.ts` 的 `PHONE_ROUTES` 在 `// 交办与材料` 那组之后加:

```ts
  // 推送(中继 v2,spec 2026-09-30 §5):登记 APNs / FCM token、发一条测试通知。只认设备令牌。
  'POST /m/api/push/register',
  'POST /m/api/push/test',
```

`api.ts` 的 `PHONE_API_SCHEMAS` 末尾加:

```ts
  'POST /m/api/push/register': z.union([z.object({ ok: z.literal(true) }), PhoneErrorResponse]),
  'POST /m/api/push/test': z.union([z.object({ ok: z.literal(true), result: z.object({ ok: z.boolean(), code: z.string() }) }), PhoneErrorResponse]),
```

`settings-panel.ts`:
- import 补 `import { PushPlatform, pushTokenValid, type PushPlatformT } from '@wechat-cc/protocol'`。
- `SettingsPanelDeps` 加(放在 `curatedMemory` 附近):

```ts
  /** 推送(中继 v2,spec 2026-09-30 §5)。缺省 ⇒ /m/api/push/* 503。按设备 id,不是令牌。 */
  push?: {
    register(deviceId: string, platform: PushPlatformT, token: string): boolean
    test(deviceId: string): Promise<{ ok: boolean; code: string }>
    unregister(deviceId: string): void
    forgetAll(): void
  }
```

- `routeRequest` 里 `/m/api/seen` 分支之后加:

```ts
          if ((url.pathname === '/m/api/push/register' || url.pathname === '/m/api/push/test') && req.method === 'POST') {
            if (!deps.push) return json({ ok: false, error: 'push_not_wired' }, 503)
            if (caller.origin !== 'device' || !deviceId) return json({ ok: false, error: 'device_only' }, 403)
            if (url.pathname === '/m/api/push/test') return json({ ok: true, result: await deps.push.test(deviceId) })
            let body: unknown
            try { body = await req.json() } catch { return json({ ok: false, error: 'bad_json' }, 400) }
            const b = (body ?? {}) as { platform?: unknown; token?: unknown }
            const platform = PushPlatform.safeParse(b.platform)
            if (!platform.success || typeof b.token !== 'string' || !pushTokenValid(platform.data, b.token)) return json({ ok: false, error: 'invalid' }, 400)
            if (!deps.push.register(deviceId, platform.data, b.token)) return json({ ok: false, error: 'invalid' }, 400)
            deps.log('SETTINGS', `push registered for device ${deviceId} (${platform.data})`)
            return json({ ok: true })
          }
```

- `apply` 里:`forget_devices` 分支 `devices.forgetAll()` 之后加 `deps.push?.forgetAll()`;`revoke_device` 分支成功路径(`devices.revoke(b.id)` 为真之后)加 `deps.push?.unregister(b.id)`。

- [ ] **Step 4: 跑**

Run: `bun --bun vitest run src/daemon/settings-panel src/daemon/phone-api-schema.test.ts scripts/phone-routes.guard.test.ts && bun run typecheck; echo "exit=$?"`
Expected: PASS;`exit=0`。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/settings-panel.ts src/daemon/phone-routes.ts packages/protocol/src/api.ts src/daemon/*.test.ts
git commit -m "手机路由:推送登记 + 测试通知(只认设备令牌);撤销设备同时退登记"
```

---

### Task 13: 接线 —— `relay_v2_url`、双连接、remoteInfo、壳页按 id 选路径

**Files:**
- Create: `src/daemon/remote-relay-config.ts`、`src/daemon/remote-relay-config.test.ts`
- Modify: `src/lib/agent-config.ts`(三处:接口、zod、解析)
- Modify: `src/daemon/wiring/pipeline-deps.ts`
- Modify: `src/daemon/settings-panel.ts`(`linkUrl` 的 base 去尾)
- Modify: `relay/pset.src.html` + 重新生成 `relay/pset.html`;`apps/mobile/pset-shell.test.ts`
- Modify: `apps/relay/test/entry.test.ts`(把 `/pset/` 断言改回 `'/v2/phone'`)

**Interfaces:**
- Consumes: Task 8 `loadOrCreateRelayIdentity`、`DEFAULT_RELAY_V2_URL`;Task 9 新 `TunnelClient`;Task 10 `makePhonePush`;Task 11 `makePhoneNotifier`;Task 12 `SettingsPanelDeps.push`;`deviceIdOf`(device-store.ts)。
- Produces:
  - `resolveRemoteRelays(stateDir: string, cfg: { remote_tunnel?: boolean; remote_relay_url?: string; relay_v2_url?: string }, log): null | { legacy: { id: string; daemonUrl: string; phoneUrl: string }; v2: { identity: RelayIdentity; daemonUrl: string; phoneUrl: string } | null; remoteInfo: { id: string; relay: string } }`
    - 老:id 读 / 建 `tunnel-id.json`(原逻辑搬过来),`phoneUrl = remote_relay_url ?? 'wss://cc.tendhearth.com/tunnel/phone'`,`daemonUrl` = 把 `/tunnel/phone` 换成 `/tunnel/daemon`。
    - 新:`base = (relay_v2_url ?? DEFAULT_RELAY_V2_URL)` 去尾斜杠;`daemonUrl = base + '/v2/daemon'`、`phoneUrl = base + '/v2/phone'`;身份文件坏 ⇒ `v2: null` 并记日志。
    - `remoteInfo` = 有 v2 用 v2(`{id: r…, relay: phoneUrl}`),否则老的。
  - agent-config 键 `relay_v2_url?: string`。
  - 壳页规则:id 以 `r` 开头 ⇒ `/v2/phone`,否则 `/tunnel/phone`。
  - `linkUrl` 的 base:`remote.relay.replace(/^wss:/, 'https:').replace(/\/(tunnel|v2)\/phone$/, '')`。

- [ ] **Step 1: 写失败的测试**

`src/daemon/remote-relay-config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRemoteRelays } from './remote-relay-config'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'remote-relay-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('resolveRemoteRelays', () => {
  it('远程访问关 ⇒ null', () => {
    expect(resolveRemoteRelays(dir, {}, () => {})).toBeNull()
  })
  it('开:老中继照旧 + 新中继缺省生产;remoteInfo 用新的', () => {
    const r = resolveRemoteRelays(dir, { remote_tunnel: true }, () => {})!
    expect(r.legacy.id).toMatch(/^t[0-9a-f]{36}$/)
    expect(r.legacy.daemonUrl).toBe('wss://cc.tendhearth.com/tunnel/daemon')
    expect(r.v2!.daemonUrl).toBe('wss://relay.tendhearth.com/v2/daemon')
    expect(r.remoteInfo).toEqual({ id: r.v2!.identity.id, relay: 'wss://relay.tendhearth.com/v2/phone' })
  })
  it('relay_v2_url 覆盖(去尾斜杠)', () => {
    const r = resolveRemoteRelays(dir, { remote_tunnel: true, relay_v2_url: 'wss://relay-staging.tendhearth.com/' }, () => {})!
    expect(r.v2!.phoneUrl).toBe('wss://relay-staging.tendhearth.com/v2/phone')
  })
  it('身份文件坏 ⇒ 只连老中继,remoteInfo 回老的,记日志', () => {
    writeFileSync(join(dir, 'relay-identity.json'), 'garbage')
    const log = vi.fn()
    const r = resolveRemoteRelays(dir, { remote_tunnel: true }, log)!
    expect(r.v2).toBeNull()
    expect(r.remoteInfo).toEqual({ id: r.legacy.id, relay: 'wss://cc.tendhearth.com/tunnel/phone' })
    expect(log).toHaveBeenCalledWith('TUNNEL', expect.stringContaining('relay_identity_corrupt'))
  })
  it('老 id 稳定(第二次读同一个)', () => {
    const a = resolveRemoteRelays(dir, { remote_tunnel: true }, () => {})!
    const b = resolveRemoteRelays(dir, { remote_tunnel: true }, () => {})!
    expect(b.legacy.id).toBe(a.legacy.id)
    expect(b.v2!.identity.id).toBe(a.v2!.identity.id)
  })
})
```

`apps/mobile/pset-shell.test.ts` 加一条(按该文件读生成物的现有方式):

```ts
it('按 daemon id 前缀选中继路径:r… ⇒ /v2/phone,其余 ⇒ /tunnel/phone', () => {
  const html = readFileSync(new URL('../../relay/pset.html', import.meta.url), 'utf8')
  expect(html).toContain('ID.charAt(0) === "r" ? "/v2/phone" : "/tunnel/phone"')
})
```

面板 `linkUrl` 测试(同 Task 12 的面板测试文件):`remoteInfo: () => ({ id: 'rabc', relay: 'wss://relay.tendhearth.com/v2/phone' })` 时,`await panel.linkUrl()` 以 `https://relay.tendhearth.com/pset/#id=rabc&t=` 开头。

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/daemon/remote-relay-config.test.ts apps/mobile/pset-shell.test.ts src/daemon/settings-panel`
Expected: FAIL(模块不存在;壳页没有新规则;linkUrl 留着 `/v2/phone`)。

- [ ] **Step 3: 实现**

`src/daemon/remote-relay-config.ts`:

```ts
/**
 * 远程隧道的两条中继(spec 2026-09-30 §8 过渡):老 VPS 中继(`t…` id,已配对的手机网页)
 * + 官方中继 v2(`r…` id,新配对与 app)。过渡期两边都连;新生成的链接指向 v2。
 * 身份文件坏了 ⇒ 这次只连老中继(relay-identity.ts 不会悄悄换 id)。
 */
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../lib/read-json-file'
import { DEFAULT_RELAY_V2_URL, loadOrCreateRelayIdentity, type RelayIdentity } from './relay-identity'

const LEGACY_PHONE_URL = 'wss://cc.tendhearth.com/tunnel/phone'

export interface RemoteRelays {
  legacy: { id: string; daemonUrl: string; phoneUrl: string }
  v2: { identity: RelayIdentity; daemonUrl: string; phoneUrl: string } | null
  remoteInfo: { id: string; relay: string }
}

export function resolveRemoteRelays(
  stateDir: string,
  cfg: { remote_tunnel?: boolean; remote_relay_url?: string; relay_v2_url?: string },
  log: (tag: string, line: string) => void,
): RemoteRelays | null {
  if (cfg.remote_tunnel !== true) return null
  const idPath = join(stateDir, 'tunnel-id.json')
  let did: string
  try { did = (readJsonFile(idPath) as { id: string }).id }
  catch { did = 't' + randomBytes(18).toString('hex'); try { writeFileSync(idPath, JSON.stringify({ id: did }), { mode: 0o600 }) } catch { /* best effort */ } }
  const phoneUrl = cfg.remote_relay_url ?? LEGACY_PHONE_URL
  const legacy = { id: did, phoneUrl, daemonUrl: phoneUrl.replace('/tunnel/phone', '/tunnel/daemon') }

  let v2: RemoteRelays['v2'] = null
  try {
    const base = (cfg.relay_v2_url ?? DEFAULT_RELAY_V2_URL).replace(/\/+$/, '')
    v2 = { identity: loadOrCreateRelayIdentity(stateDir), daemonUrl: `${base}/v2/daemon`, phoneUrl: `${base}/v2/phone` }
  } catch (e) {
    log('TUNNEL', `relay v2 disabled this boot: ${e instanceof Error ? e.message : String(e)} (legacy relay still on)`)
  }
  const remoteInfo = v2 ? { id: v2.identity.id, relay: v2.phoneUrl } : { id: legacy.id, relay: legacy.phoneUrl }
  return { legacy, v2, remoteInfo }
}
```

`src/lib/agent-config.ts`:在 `remote_relay_url?: string` 下加 `/** 官方中继 v2 的地址(wss 源,不带路径);缺省生产 wss://relay.tendhearth.com。 */ relay_v2_url?: string`;zod 里 `remote_relay_url: z.string().optional(),` 下加 `relay_v2_url: z.string().optional(),`;解析里 `remote_relay_url` 那行下加 `...(typeof parsed.relay_v2_url === 'string' ? { relay_v2_url: parsed.relay_v2_url } : {}),`。

`relay/pset.src.html` 第 51 行:

```js
  var relay = "wss://" + location.host + (ID.charAt(0) === "r" ? "/v2/phone" : "/tunnel/phone")
```

然后 `bun run build:mobile` 重新生成 `relay/pset.html`(以及其它两份生成物,若有变化一并提交)。

`settings-panel.ts` `linkUrl` 里 `.replace(/\/tunnel\/phone$/, '')` 改为 `.replace(/\/(tunnel|v2)\/phone$/, '')`。

`pipeline-deps.ts`:
- 删掉现在的 `remoteCfg` / `remoteTunnel` / `tunnel-id.json` 那一段,换成:

```ts
  const remoteCfg = loadAgentConfig(stateDir) as { remote_tunnel?: boolean; remote_relay_url?: string; relay_v2_url?: string }
  const relays = resolveRemoteRelays(stateDir, remoteCfg, (tag, line) => log(tag, line))
  const remoteTunnel = relays?.remoteInfo ?? null
  // 推送(中继 v2):先建,面板与隧道都要它;发送走 v2 隧道客户端(稍后才建 —— 懒绑定)。
  let v2Tunnel: import('../tunnel-client').TunnelClient | null = null
  let legacyTunnel: import('../tunnel-client').TunnelClient | null = null
  let notifier: { refresh(): void } | null = null
  const phonePush = relays?.v2 ? makePhonePush({
    stateDir,
    send: (m) => v2Tunnel?.sendControl(m) ?? false,
    deviceToken: (id) => settingsPanel.deviceTokens().find(t => deviceIdOf(t) === id) ?? null,
    deviceIds: () => settingsPanel.deviceTokens().map(deviceIdOf),
    onChange: () => notifier?.refresh(),
    log: (tag, line) => log(tag, line),
  }) : null
```

  (`settingsPanel` 在这之后才定义:这两个闭包只在运行时调用,与文件里 `companionConverse` 的写法同一姿势 —— 在注释里写明。)
- `makeSettingsPanel({...})` 里加 `...(phonePush ? { push: phonePush } : {}),`;`remoteInfo` 那行不变(`remoteTunnel` 现在是 `relays.remoteInfo`)。
- 隧道段改成:

```ts
  if (relays) {
    const phone = makePhoneEventsWiring({ …原样… })
    import('../tunnel-client').then(({ makeTunnelClient }) => {
      const common = {
        events: phone.events,
        handleRequest: (req: Request) => settingsPanel.handleRequest(req),
        knownDeviceTokens: () => settingsPanel.deviceTokens(),
        activeLinkToken: () => settingsPanel.activeLinkToken(),
        log: (tag: string, line: string) => log(tag, line),
      }
      // 过渡期(spec §8):老中继照连,已配对的手机网页还指着它。
      legacyTunnel = makeTunnelClient({ ...common, daemonId: relays.legacy.id, relayUrl: relays.legacy.daemonUrl })
      legacyTunnel.start()
      if (relays.v2) {
        v2Tunnel = makeTunnelClient({
          ...common,
          daemonId: relays.v2.identity.id,
          relayUrl: relays.v2.daemonUrl,
          login: relays.v2.identity,
          onLogin: () => phonePush?.resync(),
          onControl: (m) => phonePush?.onControl(m),
        })
        v2Tunnel.start()
      }
      if (phonePush && opts.workbench) {
        const wb = opts.workbench
        const n = makePhoneNotifier({
          events: phone.events,
          push: phonePush,
          // 两条隧道合并(Review Focus 4):同一台手机从哪条连着都算在线。
          subscribedDevices: () => new Set([...(legacyTunnel?.subscribedDeviceTokens() ?? []), ...(v2Tunnel?.subscribedDeviceTokens() ?? [])].map(deviceIdOf)),
          taskInfo: (id) => { try { const d = wb.detail(id); return { title: d.task.title, status: d.task.status } } catch { return null } },
          log: (tag, line) => log(tag, line),
        })
        notifier = n
        n.refresh()
      }
      log('TUNNEL', `remote tunnel enabled — legacy ${relays.legacy.id.slice(0, 8)}…${relays.v2 ? `, v2 ${relays.v2.identity.id.slice(0, 8)}…` : ''}`)
    }).catch(err => log('TUNNEL', `tunnel client load failed: ${err instanceof Error ? err.message : err}`))
  }
```

- import 补:`resolveRemoteRelays`、`makePhonePush`、`makePhoneNotifier`、`deviceIdOf`;删掉不再用的 `randomBytes` / `writeFileSync` / `readJsonFile`(若别处没用 —— `tsc` 会告诉你)。

合并去重的那一行需要一个单测(Review Focus 4)。把它抽成 `remote-relay-config.ts` 里的小函数 `mergeOnlineDevices(sets: Array<Iterable<string>>, idOf: (t: string) => string): Set<string>`,在 `remote-relay-config.test.ts` 里加:

```ts
import { mergeOnlineDevices } from './remote-relay-config'
it('两条隧道的在线设备合并(按设备 id 去重)', () => {
  const idOf = (t: string) => t.slice(0, 2)
  expect([...mergeOnlineDevices([['aa1'], ['aa2', 'bb1']], idOf)].sort()).toEqual(['aa', 'bb'])
})
```

```ts
export function mergeOnlineDevices(sets: Array<Iterable<string>>, idOf: (token: string) => string): Set<string> {
  const out = new Set<string>()
  for (const s of sets) for (const t of s) out.add(idOf(t))
  return out
}
```

pipeline-deps 的 `subscribedDevices` 用它:`() => mergeOnlineDevices([legacyTunnel?.subscribedDeviceTokens() ?? [], v2Tunnel?.subscribedDeviceTokens() ?? []], deviceIdOf)`。

`apps/relay/test/entry.test.ts` 的 `/pset/` 断言改回 `expect(await r.text()).toContain('/v2/phone')`。

- [ ] **Step 4: 全量回路**

Run: `bun run test > $CLAUDE_JOB_DIR/tmp/t13.log 2>&1; echo "exit=$?"; tail -30 $CLAUDE_JOB_DIR/tmp/t13.log`
Expected: `exit=0`。

Run: `npm run test:node > $CLAUDE_JOB_DIR/tmp/t13n.log 2>&1; echo "exit=$?"; tail -15 $CLAUDE_JOB_DIR/tmp/t13n.log`
Expected: `exit=0`。

Run: `bun run typecheck; echo "exit=$?"; bun run depcheck; echo "exit=$?"; (cd apps/relay && bun run test); echo "exit=$?"`
Expected: 三个 `exit=0`。

- [ ] **Step 5: Commit**

```bash
git add src/daemon/remote-relay-config.ts src/daemon/remote-relay-config.test.ts src/lib/agent-config.ts src/daemon/wiring/pipeline-deps.ts src/daemon/settings-panel.ts relay/pset.src.html relay/pset.html apps/mobile apps/relay/test/entry.test.ts
git commit -m "接线:过渡期双中继、relay_v2_url、推送与叫醒判定接进 daemon、壳页按 id 选中继"
```

---

### Task 14: 端到端 —— 本地 Worker + 真 daemon 模块

**Files:**
- Create: `apps/relay/vitest.e2e.config.ts`
- Create: `apps/relay/test/e2e/relay-v2.e2e.test.ts`

**Interfaces:**
- Consumes: wrangler `unstable_startWorker`(本地 workerd 起 `apps/relay`);Task 8 `loadOrCreateRelayIdentity`;Task 9 `makeTunnelClient`;Task 10 `makePhonePush`;协议包 `makeProtocolClient`。
- Produces: 一条 node 下的 e2e:登录 → 手机连 → 请求往返 → 推送到达假 APNs(本地 HTTP 服务器;Worker 的 `APNS_HOST` 指向它)→ 同 id 重连不踢新连接。

- [ ] **Step 1: 写测试(先失败)**

`apps/relay/vitest.e2e.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/e2e/**/*.e2e.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 } })
```

`apps/relay/test/e2e/relay-v2.e2e.test.ts`:

```ts
/**
 * 端到端(spec §9.2):本地 workerd 跑真中继,daemon 侧用真模块(身份 / 隧道客户端 / 推送),
 * 手机侧用真协议客户端。APNs 用本地假服务器(本地 workerd 连不了 Apple,workerd#4841)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { unstable_startWorker } from 'wrangler'
import { makeProtocolClient, type ProtocolSocket } from '@wechat-cc/protocol'
import { loadOrCreateRelayIdentity } from '../../../../src/daemon/relay-identity'
import { makeTunnelClient } from '../../../../src/daemon/tunnel-client'
import { makePhonePush } from '../../../../src/daemon/phone-push'

const DEVICE_TOKEN = 'd' + 'e'.repeat(47)
let worker: Awaited<ReturnType<typeof unstable_startWorker>>
let apns: Server
const apnsHits: Array<{ path: string; body: any; headers: Record<string, unknown> }> = []
let base: string
let stateDir: string

function adapt(ws: WebSocket): ProtocolSocket {
  return {
    send: s => ws.send(s), close: () => ws.close(),
    onOpen: cb => { ws.onopen = () => cb() }, onMessage: cb => { ws.onmessage = ev => cb(String(ev.data)) }, onClose: cb => { ws.onclose = () => cb() },
  }
}
const until = async (pred: () => boolean, ms = 10_000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 50)) } }

beforeAll(async () => {
  apns = createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c }); req.on('end', () => { apnsHits.push({ path: req.url!, body: JSON.parse(b), headers: req.headers }); res.writeHead(200).end() })
  })
  await new Promise<void>(r => apns.listen(0, '127.0.0.1', r))
  const port = (apns.address() as { port: number }).port
  const p8 = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  worker = await unstable_startWorker({
    config: new URL('../../wrangler.toml', import.meta.url).pathname,
    bindings: {
      APNS_KEY_P8: { type: 'plain_text', value: p8 }, APNS_KEY_ID: { type: 'plain_text', value: 'KID' },
      APNS_TEAM_ID: { type: 'plain_text', value: '9Y6JAPDP7A' }, APNS_TOPIC: { type: 'plain_text', value: 'com.test.cc' },
      APNS_HOST: { type: 'plain_text', value: `http://127.0.0.1:${port}` },
    },
    dev: { server: { port: 0 }, inspector: false },
  })
  base = (await worker.url).toString().replace(/^http/, 'ws').replace(/\/$/, '')
  stateDir = mkdtempSync(join(tmpdir(), 'relay-e2e-'))
})
afterAll(async () => { await worker?.dispose(); apns?.close(); rmSync(stateDir, { recursive: true, force: true }) })

describe('中继 v2 端到端', () => {
  it('登录 → 手机请求往返 → 推送到达假 APNs → 同 id 重连不踢新连接', async () => {
    const ident = loadOrCreateRelayIdentity(stateDir)
    const logins: number[] = []
    let push: ReturnType<typeof makePhonePush>
    const mk = () => makeTunnelClient({
      daemonId: ident.id, relayUrl: `${base}/v2/daemon`, login: ident,
      knownDeviceTokens: () => [DEVICE_TOKEN],
      handleRequest: async (req) => Response.json({ path: new URL(req.url).pathname }),
      onLogin: () => { logins.push(Date.now()); push.resync() },
      onControl: (m) => push.onControl(m),
      log: () => {},
    })
    const d1 = mk()
    push = makePhonePush({ stateDir, send: m => d1.sendControl(m), deviceToken: () => DEVICE_TOKEN, deviceIds: () => ['dev1'], log: () => {} })
    d1.start()
    await until(() => logins.length === 1)

    const phone = makeProtocolClient({ open: () => adapt(new WebSocket(`${base}/v2/phone?id=${ident.id}`)), token: DEVICE_TOKEN })
    const r = await phone.request({ method: 'GET', path: '/m/api/home' })
    expect(r.json()).toEqual({ path: '/m/api/home' })
    expect(phone.version()).toBe(2)

    expect(push.register('dev1', 'apns', 'ab'.repeat(32))).toBe(true)
    expect(await push.test('dev1')).toEqual({ ok: true, code: 'ok' })
    expect(apnsHits.at(-1)!.path).toBe(`/3/device/${'ab'.repeat(32)}`)
    expect(apnsHits.at(-1)!.body.aps['mutable-content']).toBe(1)

    // 同 id 再起一个客户端(daemon 重连):新连接登录成功,老的被替换;手机再请求能到。
    const d2 = mk()
    d2.start()
    await until(() => logins.length >= 2)
    d1.stop()   // 旧进程退场(否则两份同身份的 daemon 会互相替换)
    const r2 = await phone.request({ method: 'GET', path: '/m/api/feed' })
    expect(r2.json()).toEqual({ path: '/m/api/feed' })
    phone.close(); d2.stop()
  })
})
```

(`unstable_startWorker` 的参数形状以 wrangler 4.144 实际为准 —— 先 `grep -n "unstable_startWorker" node_modules/wrangler/wrangler-dist/cli.d.ts` 看签名,不同就按实际改并记 Ruling。本地 workerd 连 `http://127.0.0.1` 的假 APNs 是允许的;连真 Apple 不行。)

- [ ] **Step 2: 跑,确认它真的在测东西**

Run: `cd apps/relay && bun run test:e2e`
Expected: PASS(Task 1–13 都完成后这条应当直接绿)。**再做一次反向核对**:临时把 `room.ts` `onLogin` 里替换旧连接那段注释掉,重跑 —— 应当 FAIL 在第二次请求(旧连接没被替换、流量去了已死的 socket)或 `logins` 等待;确认后还原。把这次反向核对的结果写进账本。

- [ ] **Step 3: Commit**

```bash
git add apps/relay/vitest.e2e.config.ts apps/relay/test/e2e/relay-v2.e2e.test.ts
git commit -m "中继 v2 端到端:本地 workerd + 真 daemon 模块 + 假 APNs"
```

---

### Task 15: `selftest phone --relay v2`

**Files:**
- Modify: `src/cli/selftest-phone.ts`、`src/cli/commands/selftest.ts`
- Test: `src/cli/selftest-phone.test.ts`

**Interfaces:**
- Consumes: Task 12 两条推送路由;Task 13 的链接形状(`/pset/#id=r…`)。
- Produces:
  - `classifyLink`:`relayWsUrl` 路径按 id 前缀选(`r` ⇒ `/v2/phone`,否则 `/tunnel/phone`)。
  - `runPhoneSelftest(deps, opts: { executor: string; timeoutMs?: number; relay?: 'v2' })`:`relay: 'v2'` 时额外检查 ——
    - `relay_v2_link`:链接的 id 以 `r` 开头(否则 FAIL 并停);
    - `relay_healthz`:`GET https://<host>/healthz` 返回 `ok:true` 且 `apns:true`;
    - `push_registered`:设备客户端 `POST /m/api/push/register {platform:'apns', token:'0'.repeat(64)}` 回 `ok:true`;
    - `apns_auth_accepted`:`POST /m/api/push/test` 的 `result.code` ∈ {`BadDeviceToken`, `DeviceTokenNotForTopic`}(假 token 被拒 = Apple 已认可我们的 JWT;`InvalidProviderToken` / `not_configured` / `timeout` 都算 FAIL,detail 带上 code)。
    - 这几项插在 `device_id` 之后、订阅 agents 之前;收尾撤销设备照旧(撤销会连带退登记)。
  - CLI:`wechat-cc selftest phone --relay v2`。

- [ ] **Step 1: 写失败的测试**

在 `selftest-phone.test.ts` 里沿用现有的假 `deps` / 假 `connect`(它在 `ProtocolClient` 层造假)写:

```ts
  it('--relay v2:链接是 r… id ⇒ 连 /v2/phone,查 healthz,登记假 APNs token,Apple 认可 JWT 即 PASS', async () => {
    const h = makeHarness({ linkUrl: 'https://relay.tendhearth.com/pset/#id=rabcdefghijklmnopqrstuvwxyz&t=tlink&p=%2Fset&lan=192.168.1.2:8080' })
    h.fetchRoutes['https://relay.tendhearth.com/healthz'] = { ok: true, version: 'x', env: 'production', apns: true, fcm: false }
    h.deviceRoutes['POST /m/api/push/register'] = { ok: true }
    h.deviceRoutes['POST /m/api/push/test'] = { ok: true, result: { ok: false, code: 'BadDeviceToken' } }
    const r = await runPhoneSelftest(h.deps, { executor: 'cursor', relay: 'v2' })
    expect(h.connectedUrls[0]).toBe('wss://relay.tendhearth.com/v2/phone?id=rabcdefghijklmnopqrstuvwxyz')
    for (const n of ['relay_v2_link', 'relay_healthz', 'push_registered', 'apns_auth_accepted']) expect(r.checks.find(c => c.name === n)?.ok).toBe(true)
  })
  it('--relay v2 但链接还是老 t… id ⇒ relay_v2_link FAIL', async () => {
    const h = makeHarness({ linkUrl: 'https://cc.tendhearth.com/pset/#id=tdeadbeef&t=tlink&p=%2Fset&lan=192.168.1.2:8080' })
    const r = await runPhoneSelftest(h.deps, { executor: 'cursor', relay: 'v2' })
    expect(r.checks.find(c => c.name === 'relay_v2_link')?.ok).toBe(false)
    expect(r.ok).toBe(false)
  })
  it('--relay v2:InvalidProviderToken ⇒ apns_auth_accepted FAIL,detail 带 code', async () => {
    const h = makeHarness({ linkUrl: 'https://relay.tendhearth.com/pset/#id=rabcdefghijklmnopqrstuvwxyz&t=tlink&p=%2Fset&lan=192.168.1.2:8080' })
    h.fetchRoutes['https://relay.tendhearth.com/healthz'] = { ok: true, apns: true }
    h.deviceRoutes['POST /m/api/push/register'] = { ok: true }
    h.deviceRoutes['POST /m/api/push/test'] = { ok: true, result: { ok: false, code: 'InvalidProviderToken' } }
    const r = await runPhoneSelftest(h.deps, { executor: 'cursor', relay: 'v2' })
    expect(r.checks.find(c => c.name === 'apns_auth_accepted')).toMatchObject({ ok: false, detail: expect.stringContaining('InvalidProviderToken') })
  })
  it('不带 --relay:老 t… 链接照旧连 /tunnel/phone,不做推送检查', async () => {
    const h = makeHarness({ linkUrl: 'https://cc.tendhearth.com/pset/#id=tdeadbeef&t=tlink&p=%2Fset&lan=192.168.1.2:8080' })
    await runPhoneSelftest(h.deps, { executor: 'cursor' })
    expect(h.connectedUrls[0]).toBe('wss://cc.tendhearth.com/tunnel/phone?id=tdeadbeef')
  })
```

(`makeHarness` / `fetchRoutes` / `deviceRoutes` / `connectedUrls` 是示意名:该测试文件已有造 deps 的方式,按它扩出这几个可配置点;扩助手本身算本任务的一部分。)

- [ ] **Step 2: 跑,确认失败**

Run: `bun --bun vitest run src/cli/selftest-phone.test.ts`
Expected: FAIL(`relay` 选项不认、URL 仍是 `/tunnel/phone`)。

- [ ] **Step 3: 实现**

- `classifyLink` 里:`const path = daemonId.startsWith('r') ? '/v2/phone' : '/tunnel/phone'`,`relayWsUrl: \`wss://${u.host}${path}?id=…\``;返回的 `link` 加 `host: u.host`、`daemonId`。
- `runPhoneSelftest` 的 `opts` 加 `relay?: 'v2'`;`rec.push('remote_enabled', true)` 之后:

```ts
    if (opts.relay === 'v2') {
      const isV2 = cls.link.daemonId.startsWith('r')
      rec.push('relay_v2_link', isV2, isV2 ? undefined : 'link still points at the legacy relay (t… id) — is relay_v2_url set and the daemon redeployed?')
      if (!isV2) stop()
      const hz = await jsonCall(deps, `https://${cls.link.host}/healthz`, null, 'GET')
      const hzOk = hz.ok && hz.json?.ok === true && hz.json?.apns === true
      rec.push('relay_healthz', hzOk, hzOk ? undefined : `healthz: ${JSON.stringify(hz.json ?? httpErrorDetail(hz))}`)
    }
```

- `device_id` 检查之后、`subscribe('agents'…)` 之前:

```ts
    if (opts.relay === 'v2') {
      let regOk = false, code = 'no_response'
      try {
        const reg = await deviceClient.request({ method: 'POST', path: '/m/api/push/register', body: JSON.stringify({ platform: 'apns', token: '0'.repeat(64) }) })
        regOk = reg.json<{ ok?: boolean }>().ok === true
        rec.push('push_registered', regOk, regOk ? undefined : reg.text())
        if (regOk) {
          const t = await deviceClient.request({ method: 'POST', path: '/m/api/push/test', body: '{}' })
          code = t.json<{ result?: { code?: string } }>().result?.code ?? 'no_result'
        }
      } catch (err) {
        rec.push('push_registered', false, err instanceof Error ? err.message : String(err))
      }
      if (regOk) {
        const accepted = code === 'BadDeviceToken' || code === 'DeviceTokenNotForTopic'
        rec.push('apns_auth_accepted', accepted, accepted ? `APNs rejected the synthetic token with ${code} — auth OK` : `APNs said ${code}`)
      }
    }
```

- `src/cli/commands/selftest.ts` 的 phone 子命令:参数加 `relay: { type: 'string', description: '只认 v2:核对链接指向官方中继 v2、healthz、APNs 认可推送凭据' }`,把 `relay === 'v2' ? { relay: 'v2' } : {}` 传进 `runPhoneSelftest`;传了别的值就报错退出码 1。`scripts/cli-help.guard.test.ts` 若对 help 文本有快照,按它的提示更新。

- [ ] **Step 4: 跑**

Run: `bun --bun vitest run src/cli/selftest-phone.test.ts scripts/cli-help.guard.test.ts scripts/cli-ratchet.guard.test.ts && bun run typecheck; echo "exit=$?"`
Expected: PASS;`exit=0`。

- [ ] **Step 5: Commit**

```bash
git add src/cli/selftest-phone.ts src/cli/selftest-phone.test.ts src/cli/commands/selftest.ts scripts
git commit -m "selftest phone --relay v2:核对新中继链接、healthz、APNs 认可推送凭据"
```

---

### Task 16: CI、部署工作流、巡检、文档

**Files:**
- Modify: `.github/workflows/ci.yml`、`scripts/ci-workflow.guard.test.ts`
- Create: `.github/workflows/relay.yml`、`.github/workflows/relay-watch.yml`
- Create: `docs/maintainer/relay.md`
- Modify: `relay/README.md`、`docs/INDEX.md`、`docs/roadmap.md`、`docs/maintainer/README.md`

**Interfaces:**
- Produces:
  - ci.yml:`changes` 作业多一个输出 `relay`(`apps/relay/**`、`packages/protocol/**`、`relay/pset.src.html`);新作业 `relay`(ubuntu,`needs: changes`,`if: needs.changes.outputs.relay == 'true'`,bun 1.3.14,`bun install`,`cd apps/relay && bun run typecheck && bun run test && bun run test:e2e`)。
  - relay.yml:`push` 到 `dev` 且 `apps/relay/**` 或 `packages/protocol/**` 变了 ⇒ 部署 staging(environment `relay-staging`);`workflow_dispatch` 输入 `target: production` ⇒ 部署生产(environment `relay-production`,需审批)。都用 secret `CLOUDFLARE_API_TOKEN` + var `CLOUDFLARE_ACCOUNT_ID`;部署前跑一遍中继测试;部署后 `curl -fsS https://<host>/healthz`,`RELAY_VERSION` 用 `--var RELAY_VERSION:${GITHUB_SHA::8}` 注入。
  - relay-watch.yml:每 15 分钟 `curl` 生产 `/healthz`(非 200 或 `ok!=true` ⇒ 作业失败 ⇒ GitHub 给主人发失败邮件);再用 Analytics Engine SQL API 查过去 1 小时 `push_ok` / `push_fail`,`fail ≥ 20 且 fail/(ok+fail) > 0.5` ⇒ 失败。secret `CF_ANALYTICS_TOKEN`(Account Analytics Read)缺失时只跳过这一步并打印提示。

- [ ] **Step 1: 守卫测试先行**

`scripts/ci-workflow.guard.test.ts` 加:

```ts
describe('ci.yml —— 中继作业', () => {
  it('changes 算出 relay 输出,relay 作业依赖它', () => {
    const changes = jobs.changes!
    expect(changes.outputs?.relay).toBeDefined()
    const filter = changes.steps?.find(s => s.id === 'filter')?.with?.filters as string
    expect(filter).toContain('apps/relay/**')
    expect(filter).toContain('packages/protocol/**')
    const relay = jobs.relay!
    expect(relay.needs).toContain('changes')
    expect(relay.if).toContain("needs.changes.outputs.relay == 'true'")
  })
  it('relay 作业的 setup-bun 也钉 1.3.14', () => {
    const bun = jobs.relay!.steps?.find(s => s.uses?.startsWith('oven-sh/setup-bun'))
    expect(bun?.with?.['bun-version']).toBe('1.3.14')
  })
})
```

同时把文件里「三处 setup-bun 都钉 1.3.14」的断言(若是按固定次数数的)改成「每一处」。

Run: `bun --bun vitest run scripts/ci-workflow.guard.test.ts`
Expected: FAIL(没有 relay 输出 / 作业)。

- [ ] **Step 2: 改 ci.yml**

`changes` 作业:`outputs` 加 `relay: ${{ steps.filter.outputs.relay }}`;`filters` 加:

```yaml
            relay:
              - 'apps/relay/**'
              - 'packages/protocol/**'
              - 'relay/pset.src.html'
```

新作业(放在 `node` 作业后面):

```yaml
  # 官方中继 v2(apps/relay,Cloudflare Workers)。测试跑在本地 workerd 里,只在 Linux 上跑一份;
  # 只在中继、协议包或壳页源码动过时跑(跟 desktop-e2e 同一个 changes 输出机制)。
  relay:
    name: relay · workers
    needs: changes
    if: needs.changes.outputs.relay == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - run: bun install --frozen-lockfile
      - name: Typecheck
        working-directory: apps/relay
        run: bun run typecheck
      - name: Unit (workerd)
        working-directory: apps/relay
        run: bun run test
      - name: End-to-end (local workerd + daemon modules)
        working-directory: apps/relay
        run: bun run test:e2e
```

Run: `bun --bun vitest run scripts/ci-workflow.guard.test.ts`
Expected: PASS。

- [ ] **Step 3: 部署与巡检工作流**

`.github/workflows/relay.yml`:

```yaml
name: Relay deploy

on:
  push:
    branches: [dev]
    paths: ['apps/relay/**', 'packages/protocol/**', 'relay/pset.src.html']
  workflow_dispatch:
    inputs:
      target:
        description: 'staging 或 production(production 需要 relay-production 环境审批)'
        required: true
        default: staging
        type: choice
        options: [staging, production]

concurrency:
  group: relay-deploy-${{ github.event.inputs.target || 'staging' }}
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: ${{ github.event.inputs.target == 'production' && 'relay-production' || 'relay-staging' }}
    env:
      TARGET: ${{ github.event.inputs.target || 'staging' }}
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - run: bun install --frozen-lockfile
      - name: Test before deploy
        working-directory: apps/relay
        run: bun run typecheck && bun run test
      - name: Deploy
        working-directory: apps/relay
        run: bunx wrangler deploy --env "$TARGET" --var "RELAY_VERSION:${GITHUB_SHA::8}"
      - name: Health
        run: |
          host=$([ "$TARGET" = production ] && echo relay.tendhearth.com || echo relay-staging.tendhearth.com)
          for i in 1 2 3 4 5 6; do
            if curl -fsS "https://$host/healthz" | tee /dev/stderr | grep -q "\"version\":\"${GITHUB_SHA::8}\""; then exit 0; fi
            sleep 10
          done
          echo "healthz never reported ${GITHUB_SHA::8}"; exit 1
```

`.github/workflows/relay-watch.yml`:

```yaml
name: Relay watch

on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:

jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - name: Production healthz
        run: |
          body=$(curl -fsS --max-time 15 https://relay.tendhearth.com/healthz)
          echo "$body"
          echo "$body" | grep -q '"ok":true'
      - name: Push failure rate (last hour)
        env:
          TOKEN: ${{ secrets.CF_ANALYTICS_TOKEN }}
          ACCOUNT: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          if [ -z "$TOKEN" ]; then echo "CF_ANALYTICS_TOKEN not set — skipping push-rate check"; exit 0; fi
          q="SELECT blob1 AS ev, SUM(_sample_interval) AS n FROM wechat_cc_relay WHERE timestamp > NOW() - INTERVAL '1' HOUR AND blob1 IN ('push_ok','push_fail') GROUP BY ev FORMAT JSON"
          out=$(curl -fsS -H "Authorization: Bearer $TOKEN" --data "$q" "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/analytics_engine/sql")
          echo "$out"
          ok=$(echo "$out" | jq '[.data[] | select(.ev=="push_ok") | .n|tonumber] | add // 0')
          fail=$(echo "$out" | jq '[.data[] | select(.ev=="push_fail") | .n|tonumber] | add // 0')
          echo "push ok=$ok fail=$fail"
          if [ "$fail" -ge 20 ] && [ $((fail * 2)) -gt $((ok + fail)) ]; then echo "push failure spike"; exit 1; fi
```

`release-pipeline.guard.test.ts` 若对 `.github/workflows/*.yml` 做全量约束(比如「所有 setup-bun 钉版本」),跑一遍确认新文件满足:

Run: `bun --bun vitest run scripts/`
Expected: PASS。

- [ ] **Step 4: 文档**

`docs/maintainer/relay.md`(新),至少这几节,每节写实际命令:
1. 这是什么(一段白话 + 指向 spec)。
2. 本地:`cd apps/relay && bun run test`、`bun run test:e2e`、`bunx wrangler dev`(本地连不了 APNs,workerd#4841)。
3. 部署:dev 推 `apps/relay/**` ⇒ staging 自动;生产 = Actions → Relay deploy → `production` → 在 `relay-production` 环境批准;回滚 = `bunx wrangler rollback --env production`。
4. Secrets(名字,不含值):`APNS_KEY_P8`、`APNS_KEY_ID`、`APNS_TEAM_ID`(9Y6JAPDP7A)、`APNS_TOPIC`、`FCM_SERVICE_ACCOUNT`,`wrangler secret put <NAME> --env <env>`;GitHub:`CLOUDFLARE_API_TOKEN`(Workers Scripts Edit + Workers Routes Edit + Account Read,两个环境各一份或共用)、`CF_ANALYTICS_TOKEN`、var `CLOUDFLARE_ACCOUNT_ID`。
5. 验收:`wechat-cc selftest phone --executor cursor --relay v2`。
6. 过渡:daemon 双连;`relay_v2_url` 切 staging 的方法(`agent-config.json` 里设 `"relay_v2_url": "wss://relay-staging.tendhearth.com"` 后重启);老中继隧道何时关由主人定。
7. 排障:`login_failed`(身份文件 / 时钟无关 —— 挑战签名不看时间)、`not_configured`(secrets 没设)、`InvalidProviderToken`(.p8 / key id / team id 不对)、`DeviceTokenNotForTopic`(`APNS_TOPIC` 与 app bundle id 不符)。

`relay/README.md` 顶部加一段:「手机隧道已迁到官方中继 v2(`apps/relay`,见 docs/maintainer/relay.md);本目录的 `/tunnel/*` 只在过渡期服务老的已配对手机网页,mailbox 仍在这里。」
`docs/INDEX.md`:登记 spec、本计划、`docs/maintainer/relay.md`。
`docs/roadmap.md`:子项目 2 状态改为「代码完成,等上线(凭据 / 付费计划 / 域名)」。
`docs/maintainer/README.md`:回路一节加 `cd apps/relay && bun run test`。

- [ ] **Step 5: Commit**

```bash
git add .github/workflows scripts/ci-workflow.guard.test.ts docs relay/README.md
git commit -m "中继 v2:CI 作业、staging 自动 / 生产审批部署、生产巡检、维护手册"
```

---

### Task 17: 上线(主人参与的步骤 + 收尾验收)

这一任务**有外部副作用**,每一步都在账本记录;标 ⛔ 的是必须主人亲手做或明确点头的(付费、苹果 / 谷歌后台、给 CI 发权限更大的令牌)。代码任务 1–16 不依赖这里。

- [ ] **Step 1: 合进 dev 并看 CI**

```bash
git push -u origin relay-cf
gh pr create --base dev --title "官方中继 v2:Cloudflare + 推送(手机 app 子项目 2)" --body "$(cat <<'EOF'
实现 docs/superpowers/specs/2026-09-30-relay-cloudflare-push-design.md(计划 docs/superpowers/plans/2026-09-30-relay-cloudflare-push.md)。

- apps/relay:入口 Worker + 每 daemon 一个 Room(休眠 WebSocket),挑战登录、替换、限额与显式错误码、APNs / FCM 加密推送
- daemon:Ed25519 身份、过渡期双中继、推送登记 / 发送 / 叫醒判定、两条手机推送路由
- 协议包:身份与控制帧 schema;客户端认识新错误码
- selftest phone --relay v2;CI relay 作业;staging 自动 / 生产审批部署;生产巡检

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

CI 绿后 squash 合进 dev(`gh pr merge --squash`)。

- [ ] **Step 2: ⛔ 主人:Cloudflare 付费计划与令牌**

主人在 Cloudflare 后台开 Workers Paid($5 / 月;SQLite 后端的 Durable Objects 免费档也能用,但付费档的请求 / 时长额度才够陌生用户 —— 让主人拍板)。然后二选一(让主人选):
- 主人自己在后台建一枚 API 令牌(Workers Scripts:Edit、Workers Routes:Edit、Account Settings:Read、Zone `tendhearth.com` Workers Routes:Edit),交给我存进钥匙串 `cloudflare-workers-deploy` 与 GitHub 两个环境的 `CLOUDFLARE_API_TOKEN`;或
- 主人明确同意我用钥匙串里的 `cloudflare-global-api-key` 调 API 代建这枚令牌(安全敏感,必须明确同意)。

另建 `relay-staging`(无审批)与 `relay-production`(审批人 = 主人)两个 GitHub environment,`vars.CLOUDFLARE_ACCOUNT_ID` = 钥匙串 `cloudflare-account-id`。

- [ ] **Step 3: 部署 staging 并自检**

```bash
cd apps/relay && CLOUDFLARE_API_TOKEN=$(security find-generic-password -s cloudflare-workers-deploy -w) bunx wrangler deploy --env staging
curl -fsS https://relay-staging.tendhearth.com/healthz
```

Expected: `{"ok":true,…,"env":"staging","apns":false,"fcm":false}`(凭据还没设)。

本机临时指 staging:`agent-config.json` 加 `"relay_v2_url": "wss://relay-staging.tendhearth.com"`,然后部署 daemon 并跑不带推送的自检:

```bash
cd apps/desktop && bun run build-sidecar && cd -
"$CLI" self deploy
"$CLI" selftest phone --executor cursor
```

(`CLI=/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit/apps/desktop/src-tauri/target/release/bundle/macos/wechat-cc.app/Contents/MacOS/wechat-cc-cli` —— 后台 shell 没有 `wechat-cc` 别名。)
Expected: PASS,链接 id 以 `r` 开头,连的是 `relay-staging`。老中继的已配对手机网页照常(`selftest phone` 不覆盖它 —— 用 `grep TUNNEL` 看日志里两条隧道都 connected)。

- [ ] **Step 4: ⛔ 主人:APNs 认证密钥与 Firebase**

主人在 Apple Developer → Keys 建一枚勾选 APNs 的认证密钥(`.p8`,只能下载一次),连同 Key ID 交给我;Firebase 建项目、生成服务账号 JSON。我只用 `wrangler secret put` 从本地文件读入(`cat 文件 | bunx wrangler secret put APNS_KEY_P8 --env staging`),**不复制进仓库**、不打印内容;`.p8` 存进 `~/.private_keys/`(跟 App Store Connect 密钥放一起)。`APNS_TOPIC` 先用计划中的 app bundle id(主人定;子项目 3 建 app 记录时用同一个)。

```bash
curl -fsS https://relay-staging.tendhearth.com/healthz   # 期望 apns:true, fcm:true
"$CLI" selftest phone --executor cursor --relay v2
```

Expected: PASS,`apns_auth_accepted — APNs rejected the synthetic token with BadDeviceToken — auth OK`。

- [ ] **Step 5: 生产**

GitHub Actions → Relay deploy → `production` → 主人批准。然后把 secrets 同样设到 `--env production`,去掉本机 `agent-config.json` 里的 `relay_v2_url`(回到缺省生产),`self deploy`,再跑:

```bash
curl -fsS https://relay.tendhearth.com/healthz
"$CLI" selftest phone --executor cursor --relay v2
"$CLI" selftest workbench --executor cursor --image --resume
"$CLI" selftest chat --provider cursor --resume
```

Expected: 全部 PASS。GitHub 仓库设置里给 `relay-watch` 加 `CF_ANALYTICS_TOKEN`(Account Analytics:Read),手动触发一次 Relay watch,绿。

- [ ] **Step 6: 验收清单(spec §9「算做完」)**

- staging 与生产都部署,`/healthz` 正常 —— 命令输出贴进账本;
- `selftest phone --relay v2` 在生产 PASS;
- 已配对的手机网页经老中继照常(daemon 日志两条隧道都 connected;手头有老手机就实点一次);
- `bun run test`、`npm run test:node`、`bun run typecheck`(看退出码)、`bun run depcheck`、CI 三平台 + relay 作业绿。

---

## 计划裁决(写计划时做的决定,执行者照此执行)

1. **推送平台多一个 `apns_sandbox`**:Xcode 调试包拿到的是沙盒 token,必须打沙盒主机;spec 只写了 `apns | fcm`。代价若错:多一个枚举值,app 端不用就是了。
2. **daemon id 放在 WebSocket 子协议里**(`wcc.relay.v2, id.<rid>`):入口 Worker 必须在升级前就知道去哪个房间,而 spec 要求 id 不进 URL;子协议所有 WebSocket 实现都支持(Bun、浏览器、RN),请求头不行(浏览器 / Node 的 WebSocket 不能自定义头)。代价若错:换成别的通道只改入口与 tunnel-client 两处。
3. **心跳改成固定串 `{"ping":1}`**:新中继边缘自动回复、不唤醒房间(省钱);老中继本来就回显,不受影响。
4. **daemon 超速不关连接**:回 `rate_limited`(每秒最多一次)并丢帧 —— 关掉 daemon 等于把它所有手机一起踢了,惩罚过重。
5. **frame_too_large 从 daemon 来时不关 daemon**,回错丢帧;从手机来时关那条手机流(1009)。
6. **登录超时用 DO alarm**,超时判定是可单测的纯函数 `expiredLogins`(测试推不动 workerd 里的 `Date.now()`)。
7. **流量字节计数每满 1 MiB 落一次盘**:每帧写存储太贵;休眠丢掉的最多 1 MiB。
8. **指标只记连接、登录、推送成败与错误码计数**,不记每帧(Analytics Engine 按写入计费)。
9. **APNs / FCM 不引第三方库**(JSR 上的 cloudflare-apns2 就是 fetch + ES256 JWT):自己 60 行,依赖面更小,测试直接注入 fetch。
10. **`PhoneNotify` 空出口删掉**,由 `phone-notifier.ts` 订阅集线器实现;「任务完成」按工作台的 phase `working → replied`(本轮做完、等主人下一句)与终态 `completed` 判定,不是只看终态 —— 工作台任务大多不进终态。
11. **selftest 的「APNs 接受」= Apple 用 `BadDeviceToken` / `DeviceTokenNotForTopic` 拒了假 token**:没有真手机就拿不到真 token;这两个码只会在 JWT 已通过认证之后出现,正好证明「凭据对、链路通」。
12. **报警**:用 GitHub 定时工作流查 `/healthz` 与 Analytics Engine 里的推送失败率,失败即 GitHub 邮件给主人;Cloudflare 自带通知里没有按自定义指标的报警类型。
13. **房间不另存「这个 id 的公钥」**(spec §4 说「公钥由房间第一次见到时记住」):id 就是公钥的哈希,`verifyRelayLogin` 已核对「公钥派生出这个 id」,另存一份永远只会等于它。代价若错:以后换 id 派生方式时要补这一步。
