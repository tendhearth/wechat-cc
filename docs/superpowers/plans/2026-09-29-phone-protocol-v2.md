# 手机协议包与实时通道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给手机 app 打地基:四个运行时共用的协议包(加密、消息、接口 schema、客户端),协议 v2(防重放、响应头、二进制、订阅推送),后台事件集线器与订阅主题,推送加密的密钥派生,以及 `selftest phone` 真机自检。

**Architecture:** 新 workspace 包 `packages/protocol`(纯 TS,`@noble` 纯 JS 加密,无运行时依赖)。后台 `tunnel-crypto.ts` 改为转调它;手机网页与中继壳页的加密改成构建时从它打包生成。v2 在握手时协商,老客户端 / 老后台自动退回 v1。后台新增 `phone-events.ts` 集线器:按主题算快照、版本变了就推,触发源是工作台的变更回调加上「有订阅时每 2 s 重算一次」。

**Tech Stack:** TypeScript、Bun / Node、`@noble/curves` `@noble/hashes` `@noble/ciphers`(2.4.0)、zod v4、vitest。

**Spec:** `docs/superpowers/specs/2026-09-29-phone-protocol-v2-design.md`

## Global Constraints

- v1 线上格式逐字节不变:`info='wechat-cc/tunnel/v1'`、salt = 令牌 UTF-8 字节(空令牌 ⇒ 空 salt)、AES-256-GCM、随机 12 字节 nonce、帧 `{iv, ct}` base64url(无填充)、握手 `{hs: <raw 32 字节 X25519 公钥 base64url>}`。
- 已配对设备与已加主屏的网页(含 service worker 缓存的旧 JS)在整个过程中不能断。
- `packages/protocol` 不得引用 `node:*`、`Buffer`、`crypto.subtle`、`window` / `document` / `localStorage`;随机数只用 `globalThis.crypto.getRandomValues`。
- 事件只带小摘要与版本号;单帧远离中继 512 KiB 上限。
- 类型检查一律看退出码(`bun run typecheck >/dev/null 2>&1; echo $?`),不 grep 输出(tsc 输出带颜色码)。
- 测试里的路径拼接用 `join` 或 posix 明确选择,别写死 `/`(Windows runner)。

## 执行前裁决(相对设计稿)

1. **断线续传只发当前状态,不存 64 条事件。** 事件本身就是主题的状态快照(§3.4 已定「同主题合并只留最新」),中间态补发无意义。`since < 当前 seq` 或纪元不同 ⇒ 发一条当前状态。代价:无 —— 客户端本来就按「最新状态」渲染。
2. **主题数据由注入的「来源函数」计算,集线器本身是通用的**:快照做稳定序列化后比较,变了就 `seq+1` 推送。触发:工作台 `onChange` 回调(即时)+ 有订阅者时每 2 s 重算一次(兜底,覆盖没有回调的来源)。服务端算版本号比手机每 3 s 拉全量便宜得多。
3. **v2 帧格式:** `{c, ct}`,`c` 是计数器十进制字符串,nonce = 4 字节方向标记(c2s = 1,s2c = 2,大端)+ 8 字节大端计数器。接收方要求 `c` 严格大于已见最大值。
4. **每条流的帧串行处理**(一个 promise 链):v2 的计数器检查依赖到达顺序,而 `onStreamFrame` 目前是 `void` 并发调用。v1 也一并串行,顺序本来就该保持。
5. **推送载荷格式:** `{v:1, iv, ct}`,明文 JSON 内含 `ts`(毫秒),接收方拒绝 10 分钟前的推送。

## Review Focus

1. 旧网页(service worker 缓存的 WebCrypto 版 transport.js)对新后台:v1 握手、首帧设备识别、请求往返必须照常。
2. 新 v2 客户端对「没升级的老后台」(回 `{hs}` 不带 `v`):必须退回 v1,不能卡死。
3. 中继静默丢帧(限流 / 超大):v2 客户端请求超时后重试,不无限挂起;订阅在重连后自动续上。
4. 撤销设备后,已建立的 v2 流上后续 `req` 与 `ev` 都停止(不是只挡新连接)。
5. 一个订阅者慢或断开,不拖住别的订阅者和工作台本身(推送失败只丢该订阅)。

---

### Task 1: 协议包骨架 + 纯净守卫

**Files:**
- Create: `packages/protocol/package.json`、`packages/protocol/src/index.ts`、`packages/protocol/src/b64u.ts`、`packages/protocol/src/b64u.test.ts`
- Create: `scripts/protocol-purity.guard.test.ts`
- Modify: `package.json`(`workspaces` 加 `"packages/*"`)、`vitest.config.ts` 与 `vitest.node.config.ts`(include 加 `packages/**/*.test.ts`)

**Interfaces — Produces:** `b64uEncode(bytes: Uint8Array): string`、`b64uDecode(s: string): Uint8Array`(RFC 4648 §5,无填充;解码容忍填充)。包名 `@wechat-cc/protocol`,`exports: { ".": "./src/index.ts" }`。

- [ ] `bun add @noble/curves@2.4.0 @noble/hashes@2.4.0 @noble/ciphers@2.4.0 --cwd packages/protocol`(先写好 package.json;确认根 `bun install` 后 `import '@wechat-cc/protocol'` 在 src/ 下可解析)。
- [ ] 测试(红):`b64u` 往返任意字节(0、1、2、3、255 长度,含全 0xff);与 `Buffer.from(x).toString('base64url')` 对照(只在测试里用 Buffer)。
- [ ] 守卫(红 → 先让它抓到一个故意的违规再删):扫描 `packages/protocol/src/**/*.ts`(不含 `.test.ts`),禁止 `from 'node:`、`require(`、`\bBuffer\b`、`crypto.subtle`、`\bwindow\b`、`\bdocument\b`、`localStorage`;断言扫到的文件数 ≥ 1。
- [ ] 实现 b64u;绿;`bun run typecheck` 退出码 0;`bun run depcheck` 退出码 0(若新包触发规则,按「protocol 包不依赖任何仓库内代码」加一条规则);提交。

### Task 2: v1 测试向量(用现有实现生成)+ noble 版 v1

**Files:**
- Create: `scripts/gen-tunnel-vectors.ts`(一次性脚本,保留在仓库以便复核)、`packages/protocol/vectors/v1.json`
- Create: `packages/protocol/src/x25519.ts`、`packages/protocol/src/v1.ts`、`packages/protocol/src/v1.test.ts`

**Interfaces — Produces:**
```ts
export interface KeyPair { priv: Uint8Array; pub: Uint8Array }        // 各 32 字节
export function x25519KeyPair(priv?: Uint8Array): KeyPair             // 不给 priv ⇒ getRandomValues
export function x25519Shared(priv: Uint8Array, theirPub: Uint8Array): Uint8Array   // 32 字节
export function deriveV1Key(shared: Uint8Array, bind: string): Uint8Array           // HKDF-SHA256(salt=utf8(bind) 或空, info='wechat-cc/tunnel/v1') → 32 字节
export interface SealedFrameV1 { iv: string; ct: string }
export function sealV1(key: Uint8Array, plaintext: Uint8Array, iv?: Uint8Array): SealedFrameV1
export function openV1(key: Uint8Array, frame: SealedFrameV1): Uint8Array   // 认证失败抛错
```

- [ ] 写 `scripts/gen-tunnel-vectors.ts`:用 **现有** `src/lib/tunnel-crypto.ts` 与 `node:crypto.webcrypto`,生成 8 组向量:两对 JWK 导出的 X25519 私钥(`d`)与公钥(`x`),令牌取 `''`、`'t' + 32 hex`、`'d' + 48 hex`、含中文的串;明文取空、短 JSON、4 KiB 随机;固定 iv。记录 `privA, pubA, privB, pubB, shared(=deriveSharedBits 结果), bind, iv, plaintext, ct`(全部 base64url)。运行一次,提交 `vectors/v1.json`。
- [ ] 测试(红):对每组向量,`x25519KeyPair(privA).pub === pubA`、`x25519Shared(privA, pubB) === shared`、`sealV1(deriveV1Key(shared, bind), plaintext, iv).ct === ct`、`openV1` 还原明文;篡改一位 ⇒ 抛。
- [ ] 实现(`@noble/curves/ed25519` 的 `x25519`、`@noble/hashes/hkdf` + `sha256`、`@noble/ciphers/aes` 的 `gcm`);绿;提交。

### Task 3: 后台 `tunnel-crypto.ts` 改为转调协议包

**Files:**
- Modify: `src/lib/tunnel-crypto.ts`(保留全部导出名与 async 签名;`TunnelKeypair` / 密钥改为不透明对象,内部持 `Uint8Array`)
- Modify: `src/lib/tunnel-crypto.test.ts`(只改依赖 WebCrypto 对象形状的断言;保留「公钥是 raw 32 字节、能被 WebCrypto 导入」)
- Test: 新增「WebCrypto 一端 ⇄ 新实现一端」互通用例(模拟旧手机网页):WebCrypto 生成密钥对并按 transport.js 的方式派生密钥、加密请求;新实现的后台一端解开并回包;WebCrypto 一端解开回包。

**Interfaces — Consumes:** Task 2。**Produces:** `tunnel-crypto.ts` 的导出名与调用方式不变(`generateTunnelKeypair`、`exportPublicKeyB64`、`importPublicKeyB64`、`deriveSharedBits`、`hkdfAesKey`、`deriveSharedKey`、`sealFrame`、`openFrame`)。

- [ ] 先写互通用例(红:在改之前它应该已经绿 —— 这是回归钉子;确认它确实跑的是 WebCrypto 一端)。
- [ ] 改实现;`src/lib/tunnel-crypto.test.ts`、`src/daemon/tunnel-client.test.ts`、`src/daemon/settings-panel-workbench.test.ts` 全绿;bun 与 `npm run test:node` 两边跑;提交。

### Task 4: 手机网页与中继壳页的加密改为生成

**Files:**
- Create: `packages/protocol/src/browser.ts`(暴露 `CCP = { b64u, x25519KeyPair, x25519Shared, deriveV1Key, sealV1, openV1 }` 给 IIFE)
- Create: `apps/mobile/src/protocol.generated.js`(由构建写出:`Bun.build({ entrypoints:['packages/protocol/src/browser.ts'], format:'iife', minify:true })`,挂到 `globalThis.CCP`)
- Modify: `apps/mobile/src/transport.js`(`crypto.subtle` 全部换成 `CCP.*`,协议与行为不变)、`apps/mobile/assemble.ts` / `sources.ts`(把 `protocol.generated.js` 排在 transport 之前)
- Create: `relay/pset.src.html`(把现 pset.html 的内联加密换成 `/*@@CCP@@*/` 占位与 `CCP.*` 调用);`relay/pset.html` 变成生成物
- Modify: `apps/mobile/build.ts`(同时写出 `protocol.generated.js` 与 `relay/pset.html`)、`apps/mobile/build.test.ts`(同步守卫覆盖两个新生成物,LF 行尾)

- [ ] 测试(红):同步守卫对两个新生成物;`pset-shell.test.ts` / `pairing.test.ts` 等现有手机页测试保持;新增一条「生成的 IIFE 在无 `crypto.subtle` 的沙箱里(`vm` + 只给 `crypto.getRandomValues`、`TextEncoder`)能跑完 v1 往返」。
- [ ] 实现;`bun run build:mobile`;绿;`bun --bun vitest run apps/mobile` 与桌面无关;提交。

### Task 5: v2 加密(双向密钥 + 计数器 nonce + 防重放)

**Files:** Create `packages/protocol/src/v2.ts`、`v2.test.ts`、`vectors/v2.json`

**Interfaces — Produces:**
```ts
export function deriveV2Keys(shared: Uint8Array, bind: string): { c2s: Uint8Array; s2c: Uint8Array }  // info 'wechat-cc/tunnel/v2/c2s' | '/s2c'
export interface SealedFrameV2 { c: string; ct: string }
export interface V2Channel { seal(pt: Uint8Array): SealedFrameV2; open(f: SealedFrameV2): Uint8Array }   // open:认证失败或 c 不增 ⇒ 抛 'replay' / 'auth'
export function makeV2Channel(keys: { c2s: Uint8Array; s2c: Uint8Array }, side: 'client' | 'server'): V2Channel
```

- [ ] 测试(红):两端往返;同一帧投递两次 ⇒ 第二次抛 `replay`;乱序(先 c=2 再 c=1)⇒ c=1 抛;方向反了(客户端用 s2c 发)⇒ 抛;`c` 非十进制 ⇒ 抛;计数器到 2^53-1 ⇒ `seal` 抛(不回绕)。向量:固定 shared / bind ⇒ 两把密钥、前 3 帧密文,写入 `vectors/v2.json` 并在测试里对照(回归钉子)。
- [ ] 实现;绿;提交。

### Task 6: v2 消息、握手协商与客户端

**Files:** Create `packages/protocol/src/messages.ts`(zod)、`client.ts`、`client.test.ts`

**Interfaces — Produces:**
```ts
// 握手(明文):客户端 {hs, v:[1,2]};后台 {hs, v?:number}
// 加密内的消息(zod discriminatedUnion 't'):
//  req {t:'req', rid, method, path, headers?: Record<string,string>, body?: string, bodyEncoding?: 'utf8'|'base64'}
//  res {t:'res', rid, status, headers: Record<string,string>, body: string, bodyEncoding: 'utf8'|'base64'}
//  sub {t:'sub', sid, topic, since?: {epoch: string; seq: number}}   unsub {t:'unsub', sid}
//  ev  {t:'ev', sid, epoch, seq, data: unknown}                       err {t:'err', rid?, sid?, code}
export interface ProtocolSocket { send(s: string): void; close(): void; onMessage(cb: (s: string) => void): void; onClose(cb: () => void): void }
export interface ClientOpts { open: () => ProtocolSocket; token: string; requestTimeoutMs?: number; retries?: number; now?: () => number }
export interface ProtocolClient {
  version(): 1 | 2 | null
  request(r: { method: string; path: string; headers?: Record<string,string>; body?: string | Uint8Array }): Promise<{ status: number; headers: Record<string,string>; body: Uint8Array; text(): string; json<T>(): T }>
  subscribe(topic: string, onEvent: (data: unknown, meta: { epoch: string; seq: number }) => void): () => void   // v1 下抛 'subscriptions_need_v2'
  close(): void
}
export function makeProtocolClient(opts: ClientOpts): ProtocolClient
```
客户端:断线自动重连(指数退避,封顶 15 s)并用各订阅最后的 `{epoch, seq}` 重新 `sub`;请求超时后按 `retries`(缺省 1)重发新 `rid`;`auth_failed` 明文错误 ⇒ 所有挂起请求以 `auth_failed` 拒绝且不再重连。

- [ ] 测试(红,用进程内假后台,基于协议包自身的加密):v2 协商成功;假后台只回 `{hs}` ⇒ `version()===1`、`request` 走 v1、`subscribe` 抛;请求 / 响应含 base64 二进制与头;假后台吞掉一帧 ⇒ 超时后重试成功;断线重连后订阅带 `since` 续上;`auth_failed` ⇒ 拒绝且不重连;zod 拒绝畸形消息(不抛到外面,记为协议错误并丢弃)。
- [ ] 实现;绿;提交。

### Task 7: 推送密钥与推送载荷

**Files:** Create `packages/protocol/src/push.ts`、`push.test.ts`、`vectors/push.json`

**Interfaces — Produces:**
```ts
export function derivePushKey(deviceToken: string): Uint8Array   // HKDF-SHA256(ikm=utf8(token), salt=空, info='wechat-cc/push/v1')
export interface SealedPush { v: 1; iv: string; ct: string }
export function sealPush(key: Uint8Array, payload: { ts: number; [k: string]: unknown }, iv?: Uint8Array): SealedPush
export function openPush(key: Uint8Array, sealed: SealedPush, now: number): Record<string, unknown>   // ts 早于 now-10min ⇒ 抛 'stale'
```
- [ ] 测试(红):往返;篡改 ⇒ 抛;过期 ⇒ `stale`;不同令牌密钥不同;与隧道 v1 / v2 密钥都不相等(同一令牌);向量回归钉子。
- [ ] 实现;绿;提交。

### Task 8: 工作台变更回调 `onChange`

**Files:** Modify `src/core/workbench/task-changes.ts`(+ test)、`src/core/workbench/service.ts`(`changes` 暴露 `onChange`)

**Interfaces — Produces:** `TaskChangeHub.onChange(cb: (taskId: string, seq: number) => void): () => void`;只在 `publish` 前进时回调(与唤醒同一条件);回调抛错不影响 publish 与其他回调;`dispose` 清空。`WorkbenchService.changes.onChange` 同名转出。

- [ ] 测试(红):前进时回调、不前进 / 回落时不回调、退订后不再回调、一个回调抛错其余照常;service 层经 `create` 一个任务能收到回调。
- [ ] 实现;`src/core/workbench` 全绿;棘轮守卫(`scripts/workbench-service-ratchet.guard.test.ts`)不超;提交。

### Task 9: 事件集线器 + `PHONE_TOPICS`

**Files:** Create `src/daemon/phone-events.ts`、`phone-events.test.ts`;Modify `src/daemon/phone-routes.ts`(加 `PHONE_TOPICS` 与 `phoneTopicAllowed`)、`scripts/phone-routes.guard.test.ts`(主题也双向核对)

**Interfaces — Produces:**
```ts
export const PHONE_TOPICS: ReadonlySet<string>   // 'home' | 'approvals' | 'agents' | 'matter/'(前缀)
export function phoneTopicAllowed(topic: string): boolean   // 'matter/' 后必须是 [A-Za-z0-9_-]{1,64}
export interface TopicSource { match(topic: string): boolean; snapshot(topic: string): Promise<unknown> }
export interface PhoneEvents {
  subscribe(topic: string, since: { epoch: string; seq: number } | undefined, send: (ev: { epoch: string; seq: number; data: unknown }) => void): () => void
  poke(): void          // 所有有订阅者的主题立即重算
  dispose(): void
}
export function makePhoneEvents(opts: { sources: TopicSource[]; pollMs?: number; now?: () => number; log?: (tag: string, line: string) => void }): PhoneEvents
```
行为:订阅即算一次快照并发出(`seq` 为当前值;`since` 与当前 `{epoch, seq}` 相同则不重复发);快照稳定序列化(键排序)后与上次比较,变了 `seq+1` 发给该主题所有订阅者;`send` 抛错 ⇒ 只移除那个订阅;来源抛错 ⇒ 记一条日志、本轮跳过;没有订阅者的主题不计算;`pollMs` 缺省 2000,定时器 `unref`。

- [ ] 测试(红):用假来源与假时钟覆盖上述每条;`phoneTopicAllowed` 拒绝 `matter/`、`matter/../x`、未知主题;守卫对着 `phone-events` 的来源注册与 `PHONE_TOPICS` 双向核对。
- [ ] 实现;绿;提交。

### Task 10: 隧道客户端支持 v2

**Files:** Modify `src/daemon/tunnel-client.ts`(+ `tunnel-client.test.ts`)

**Interfaces — Consumes:** Tasks 5、6(消息 schema)、9。**Produces:** `TunnelClientDeps` 加 `events?: PhoneEvents` 与 `onDeviceRevoked?` 不需要(撤销靠每次请求 / 每条事件前重新 `resolve` 设备令牌:令牌已失效 ⇒ 关流)。

行为:
- 每条流一个 promise 链,帧串行处理(裁决 4)。
- 握手收到 `v` 数组含 2 ⇒ 回 `{hs, v:2}`,流标记 v2;否则按 v1 原样。
- v2 首帧照旧按已知令牌逐个试(用 v2 的 c2s 密钥)识别设备。
- `req`:同 v1 的 URL 改写与面板调用;`res` 带全部响应头;正文按 content-type 判断:`text/*`、`application/json`、`application/javascript` ⇒ utf8,其余 base64。
- `sub`:`phoneTopicAllowed` 不过 ⇒ `err{sid, code:'topic_not_allowed'}`;否则 `events.subscribe`,`send` 里先确认设备令牌仍有效(否则退订并关流),再封帧发出。
- `unsub` / 流关闭 / 重连:退订该流全部订阅。
- v1 流行为逐字节不变。

- [ ] 测试(红):v2 协商;v1 客户端照旧(现有用例全绿);`res` 带头与 base64 二进制(贴纸);重放帧被丢且流不崩;`sub` 收到当前状态与后续事件;不在册主题 ⇒ `err`;撤销设备后下一条事件前关流;流关闭后集线器里没有残留订阅。
- [ ] 实现;绿;提交。

### Task 11: 接线 + 进程内端到端互通

**Files:** Modify `src/daemon/wiring/pipeline-deps.ts`(建 `makePhoneEvents`,四个来源,传给 tunnel client;工作台 `changes.onChange` ⇒ `events.poke()`;`onNotify` 出口先是空函数并留注释指向子项目 2)。Create `src/daemon/phone-e2e.test.ts`。

四个来源(执行时读真实形状再定字段,只取摘要):
- `home`:`{unread, presenceState, nextCursor}`,来自面板 `/m/api/home?limit=1` 的同一构建函数(抽出可复用的函数,不经 HTTP)。
- `matter/<id>`:`{version, phase}`;工作台任务取 `detail(id).version` 与阶段,聊天事项取 matters 服务的更新时间。
- `approvals`:`[{taskId, kind:'permission'|'question', id, summary}]`,来自 `workbench.attention()` / 各任务 `detail().permissions` 与待答问题。
- `agents`:`{running, waiting, tasks:[{id, title, phase}]}`,来自 `workbench.list()`(只取未归档、未终态)。

- [ ] 端到端测试(红 → 绿):真 `makeTunnelHub` + 真面板(同 `settings-panel-workbench.test.ts` 的搭法,真工作台与假执行者)+ 真隧道客户端 + 协议包客户端。覆盖 Spec §5.3 全部:请求 / 响应(含二进制与头)、订阅 `agents` 看到任务从排队到完成、断线后续上、重放被拒、对老后台(把握手回包里的 `v` 去掉)退回 v1、撤销设备后连接失效、同主题合并(快速连发只到最新)。
- [ ] 实现接线;`src/daemon` 全绿;提交。

### Task 12: 接口 schema

**Files:** Create `packages/protocol/src/api.ts`(zod:`/m/api/*` 与 `/set/api/*` 每个返回);Create `src/daemon/phone-api-schema.test.ts`

- [ ] 测试(红):对面板真实返回(沿用现有面板测试的搭法),每条路由用对应 schema `parse`;schema 用 `.strict()` 以外的宽松对象(允许新字段),但必需字段缺失或类型错 ⇒ 红;守卫:`PHONE_ROUTES` 里每条 `GET` / `POST` 在 `api.ts` 都有 schema(反向也核对)。
- [ ] 按真实返回写 schema;绿;提交。

### Task 13: `wechat-cc selftest phone`

**Files:** Modify `src/cli/selftest.ts`(+ test)、`src/cli/commands/selftest*.ts`(命令注册)、帮助快照

流程:读 `internal-api-info.json` ⇒ `GET /v1/settings/link`(file token)取链接令牌与 daemon id、中继地址 ⇒ 用协议包客户端以链接令牌连中继、`POST /set/api/pair` 换设备令牌 ⇒ 以设备令牌连 v2、订阅 `agents` ⇒ 用 operator token 经内部 API 建一个最小工作台任务(复用 `selftest workbench` 的建任务与清理)⇒ 断言事件按序到达、含该任务、最终到终态 ⇒ 经局域网 `POST /set/api/apply {op:'revoke_device'}` 撤销(局域网地址来自链接的 `lan=`)⇒ 断言该令牌再连 `auth_failed`。输出与 `selftest workbench` 同格式(✓ / ✗ 行 + PASS / FAIL),退出码 0 / 1。

- [ ] 单测(红):用假依赖覆盖成功路径、中继不通、配对超限、事件超时、撤销失败(必须报 FAIL 并提示手工撤销的命令)。
- [ ] 实现;绿;提交。

### Task 14: 文档

- `docs/reference/internal-api-auth.md`:手机令牌一节加 v2 与主题白名单。
- `docs/maintainer/verify.md`:标准回路加 `selftest phone`。
- `docs/maintainer/README.md` / `docs/INDEX.md`:协议包的位置与「新运行时接入」一句话。
- `packages/protocol/README.md`:API 一览、向量怎么再生、纯净规则。
- 设计稿状态改「完成」;roadmap 手机 app 一行。
- [ ] 全量 bun / node、typecheck(退出码)、depcheck、`bun run build:mobile` 同步;提交。

## 收尾

整支 PR 一次独立评审(opus);合 dev 后 `self deploy` + `selftest workbench|chat|phone`;主人 iPhone 上已配对的网页实测一轮(首页、详情、上传、设置页)。
