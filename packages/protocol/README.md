# @wechat-cc/protocol

手机 ↔ 中继 ↔ 后台那条加密通道的协议,**一份代码四处用**:daemon(Bun/Node)、手机网页、公网壳页 `relay/pset.src.html`、以后的 Expo/React Native app。设计稿:`docs/superpowers/specs/2026-09-29-phone-protocol-v2-design.md`。

## API 一览(`src/index.ts`)

| 模块 | 导出 | 干什么 |
| --- | --- | --- |
| `b64u.ts` | `b64uEncode` `b64uDecode` | base64url,不依赖 `Buffer`/`btoa` |
| `x25519.ts` | `x25519KeyPair` `x25519Shared` | 握手用的密钥对与共享密钥(noble) |
| `v1.ts` | `deriveV1Key` `sealV1` `openV1` | 老协议:HKDF(salt=令牌)+ AES-GCM 随机 nonce,无防重放。只为兼容老后台/老页面 |
| `v2.ts` | `deriveV2Keys` `makeV2Channel` | v2:两个方向各一把密钥、计数器 nonce、收到重复/倒退的计数一律拒绝(防重放) |
| `push.ts` | `derivePushKey` `sealPush` `openPush` | 推送载荷加密的密钥派生(推送本身在子项目 2 发) |
| `messages.ts` | `ClientHello` `ServerHello` `ReqMsg` `ResMsg` `SubMsg` `UnsubMsg` `EvMsg` `ErrMsg` `PingMsg` `PongMsg` `V2Message` … | 线上消息的 zod 模式;`b64Encode`/`b64Decode` |
| `client.ts` | `makeProtocolClient` | 协议客户端:握手协商 v1/v2、`request()`、`subscribe()`、重连退避、保活;`requireV2` 拒绝降级(协商是明文,中继可剥掉 `v` 把双方降到无防重放的 v1;原生 app 打开) |
| `api.ts` | `PHONE_API_SCHEMAS` `PHONE_HTML_ROUTES` 及 `Matter*` `Presence` `HomeWork` `FeedEvent` … | `/m/api/*` 响应体的 zod 模式;后台有守卫测试对着真实响应核对 |
| `browser.ts` | (默认导出 `CCP`) | 经典脚本入口,打成 IIFE 挂 `globalThis.CCP`,给不能 `import` 的手写页面用 |

客户端类型在 `client-types.ts`(`ProtocolSocket`、`ClientOpts`、`ProtocolRequest`、`ProtocolResponse`),调用方只看这一份就知道要实现什么。

## 测试向量

`vectors/{v1,v2,push}.json` 是固定输入 → 固定输出,任何运行时的实现都得对得上。

- v2、push 的向量由包自己的测试守着。
- **v1 向量再生:`bun scripts/gen-tunnel-vectors.ts`。** 这个脚本**故意保留自己的一份冻结的 WebCrypto 参考实现**(`node:crypto` 的 `webcrypto.subtle` + HKDF + AES-GCM),不 import 协议包也不 import `src/lib/tunnel-crypto.ts`。原因:v1 已经换成 noble 实现,如果生成器也用它,再生出来的向量就是「实现验证实现」,永远绿,抓不到实现漂移。向量必须锚在另一套独立实现上。代价是一份小的重复代码。

## 纯净规则(为什么)

`src/` 下的非测试代码**不许**碰:`node:*`(静态或动态 import)、`require(`、`Buffer`、`crypto.subtle`、`window`、`document`、`localStorage`。随机数只走 `globalThis.crypto.getRandomValues`。

为什么:这个包要在 React Native(Hermes)里跑,那里没有 Node 内置模块、没有 `Buffer`、没有 `crypto.subtle`,也没有浏览器全局。症状只在目标平台出现,本地 Bun 下测不出来。`scripts/protocol-purity.guard.test.ts` 逐行扫,违者红。加密全走纯 JS 的 noble,所以也不依赖 Web Crypto 的 subtle。

改了包之后要跑 `bun run build:mobile`:它把 `browser.ts` 打成 `apps/mobile/src/protocol-generated.js`,并生成 `relay/pset.html`(见 `apps/mobile/build.ts`,`apps/mobile/build.test.ts` 盯着生成物同步)。

## ProtocolSocket 适配器契约

调用方把 RN / 浏览器 / Node 的 WebSocket 包成:

```ts
interface ProtocolSocket {
  send(s: string): void
  close(): void
  onOpen(cb: () => void): void
  onMessage(cb: (s: string) => void): void
  onClose(cb: () => void): void
}
```

- **`onOpen` 必须实现。** 客户端等 open 才发握手 `{hs, v:[1,2]}`;浏览器和 RN 的 `WebSocket.send` 在 open 之前会抛。所以**适配器不需要做 open 前的缓冲** —— `send` 只会在 `onOpen` 触发之后被调。
- `send` 抛错会被客户端吞掉并记为 `send_failed`。
- 每次重连客户端调一次 `ClientOpts.open()` 拿新连接;`close()` 要可重复调用。
- 一个协议客户端里,每条流的 v2 通道(`V2Channel`)**只建一次、不重建**;重新握手得到新密钥。拿同一对密钥重建通道会复用 nonce,AES-GCM 下等于泄密。

## 重试语义与超时

- **默认只重试 GET/HEAD。** 其它方法(POST 等)重发可能被后台执行两遍(批准、发消息),要在请求里显式 `request({ ..., retry: true })` 才重试。
- **重试沿用同一个 rid**,后台以后可以据此去重。
- 次数由 `retries` 定(缺省 1)。只有「已经在一条建立好的连接上发出去」的尝试才耗次数;一直连不上的不耗。请求超时时若这条连接自发出后什么都没收到,先丢掉连接,重试走新握手(手机网络会悄悄死掉)。
- 握手有自己的期限 `handshakeTimeoutMs`(缺省 = `requestTimeoutMs`),超时断开按退避重连。
- **整体期限 `requestDeadlineMs`。** 缺省 = (`requestTimeoutMs` + `handshakeTimeoutMs` + 15 s 退避封顶) × (可用重试次数 + 1)。按默认值(15 s / 15 s / 重试 1),**后台连不上的 GET 大约 90 秒后才以 `unreachable` 失败**。
- **app 必须自己处理这个:** 要么设 `requestDeadlineMs`(比如首屏 10–20 s),要么在等连接时显示「连接中」而不是转圈 90 秒。到期还没发出去 ⇒ `unreachable`;到期时已在途 ⇒ 这次超时后不再重试。

## 保活与 stream_unknown

- **后台会忘掉流。** daemon 心跳判定到中继的连接已死、重连时,会清掉全部流状态(密钥、订阅);但中继(`relay/tunnel.ts` 的 `registerDaemon`)让手机的旧流原样挂到新 socket 上 —— 手机那头的 WebSocket 不会断。
- 这时手机再发的任何密封帧,后台都明文回 `{error:'stream_unknown'}`(每条流 5 s 内最多回一次,防乒乓;握手进行中的流不会收到)。客户端收到后:断开、按退避重连;这条连接上**在途的可重试请求**耗一次重试、以同一 rid 在新连接上重发,**不可重试的**以 `stream_unknown` 拒绝;还没发出去的等新连接;订阅在新握手后带最后的 `{epoch, seq}` 重新 `sub`。
- **只挂订阅的客户端没有任何超时会触发**,所以有保活:v2 连接上有订阅、没有挂起请求、空闲 `keepaliveMs`(缺省 30 s,`0` 关掉)⇒ 发一个密封的 `{t:'ping', rid}`,后台回 `{t:'pong', rid}`(顺带核对令牌,被撤销就关流)。`requestTimeoutMs` 内**任何一帧**都没回来 ⇒ 当死连接丢掉、退避重连、重新订阅。后台忘了这条流时,ping 会先撞上 `stream_unknown`,恢复更快。
- v1 连接从不发 ping(老后台不认)。老手机网页(`apps/mobile/src/transport.js`)把任何明文 `{error}` 当「挂起请求全失败、关连接」,下一次 `api()` 自然重连 —— `stream_unknown` 走的就是这条路(`apps/mobile/pairing.test.ts` 有测试)。

## 后台侧对应

- 协商与串行开流:`src/daemon/tunnel-client.ts`、`tunnel-v2-stream.ts`(握手/识别设备/`channel.open` 串行,`req` 并发处理)。
- 订阅主题:`src/daemon/phone-events.ts` + `phone-topic-sources.ts`,白名单 `PHONE_TOPICS`(`src/daemon/phone-routes.ts`)。
- 真机闭环:`wechat-cc selftest phone`(见 `docs/maintainer/verify.md`)。
