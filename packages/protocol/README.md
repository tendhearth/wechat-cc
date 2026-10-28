# @wechat-cc/protocol

手机 ↔ 中继 ↔ 后台那条加密通道的协议,**一份代码四处用**:daemon(Bun/Node)、手机网页、公网壳页 `relay/pset.src.html`、Expo/React Native app。三个客户端用同一个 `makeProtocolClient`,只说 v2;v1 在 2026-10-25 退休(架构终态 F4)。设计稿:`docs/superpowers/specs/2026-09-29-phone-protocol-v2-design.md`。

## API 一览(`src/index.ts`)

| 模块 | 导出 | 干什么 |
| --- | --- | --- |
| `b64u.ts` | `b64uEncode` `b64uDecode` | base64url,不依赖 `Buffer`/`btoa` |
| `x25519.ts` | `x25519KeyPair` `x25519Shared` | 握手用的密钥对与共享密钥(noble) |
| `v2.ts` | `deriveV2Keys` `makeV2Channel` | v2:两个方向各一把密钥、计数器 nonce、收到重复/倒退的计数一律拒绝(防重放) |
| `push.ts` | `derivePushKey` `sealPush` `openPush` | 推送载荷加密的密钥派生(推送本身在子项目 2 发) |
| `messages.ts` | `ClientHello` `ServerHello` `ReqMsg` `ResMsg` `SubMsg` `UnsubMsg` `EvMsg` `ErrMsg` `PingMsg` `PongMsg` `V2Message` … | 线上消息的模式(`shape.ts` 的小组合子,只有 `parse` / `safeParse`:这份会打进网页的 IIFE,完整版 zod 太大,`zod/mini` 跟完整版同进编译包会初始化失败);`b64Encode`/`b64Decode` |
| `client.ts` | `makeProtocolClient` | 协议客户端:握手 `{hs, v:[2]}`(网页加 `client:'web'`)、`request()`、`subscribe()`、重连退避、保活;回来的 hello 不是 v2 一律拒绝降级(`downgrade_refused`);明文 `upgrade_required` / `auth_failed` 致命 |
| `api.ts` | `PHONE_API_SCHEMAS` `PHONE_HTML_ROUTES` 及 `Matter*` `Presence` `HomeWork` `FeedEvent` … | `/m/api/*` 响应体的 zod 模式;后台有守卫测试对着真实响应核对 |
| `routes.ts`(子路径 `@wechat-cc/protocol/routes`) | `ROUTES` `PHONE_TOPIC_NAMES` | 路由表:每条路由在桌面 / 手机 / 设置页各端的档位、令牌、链接令牌放行。只是数据;daemon 的名单与桌面白名单都从它生成(`bun run gen:routes`) |
| `browser.ts` | (默认导出 `CCP`:`makeProtocolClient`、`b64u`) | 经典脚本入口,打成 IIFE 挂 `globalThis.CCP`,给不能 `import` 的手写页面(手机网页、公网壳页)用 |

客户端类型在 `client-types.ts`(`ProtocolSocket`、`ClientOpts`、`ProtocolRequest`、`ProtocolResponse`),调用方只看这一份就知道要实现什么。

## 测试向量

`vectors/{v2,push}.json` 是固定输入 → 固定输出,任何运行时的实现都得对得上,由包自己的测试守着。(v1 的向量、它的 WebCrypto 参考实现 `scripts/legacy-webcrypto-v1.ts` 与生成脚本随 v1 在 2026-10-25 删掉。)

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

- **`onOpen` 必须实现。** 客户端等 open 才发握手 `{hs, v:[2]}`;浏览器和 RN 的 `WebSocket.send` 在 open 之前会抛。所以**适配器不需要做 open 前的缓冲** —— `send` 只会在 `onOpen` 触发之后被调。
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

- **后台会忘掉流。** daemon 心跳判定到中继的连接已死、重连时,会清掉全部流状态(密钥、订阅);但中继房间让手机的旧流原样挂到新的 daemon socket 上 —— 手机那头的 WebSocket 不会断。
- 这时手机再发的任何密封帧,后台都明文回 `{error:'stream_unknown'}`(每条流 5 s 内最多回一次,防乒乓;握手进行中的流不会收到)。客户端收到后:断开、按退避重连;这条连接上**在途的可重试请求**耗一次重试、以同一 rid 在新连接上重发,**不可重试的**以 `stream_unknown` 拒绝;还没发出去的等新连接;订阅在新握手后带最后的 `{epoch, seq}` 重新 `sub`。
- **只挂订阅的客户端没有任何超时会触发**,所以有保活:v2 连接上有订阅、没有挂起请求、空闲 `keepaliveMs`(缺省 30 s,`0` 关掉)⇒ 发一个密封的 `{t:'ping', rid}`,后台回 `{t:'pong', rid}`(顺带核对令牌,被撤销就关流)。`requestTimeoutMs` 内**任何一帧**都没回来 ⇒ 当死连接丢掉、退避重连、重新订阅。后台忘了这条流时,ping 会先撞上 `stream_unknown`,恢复更快。
- 手机网页(`apps/mobile/src/transport.js`)与公网壳页用的就是这个客户端(经 `CCP`),行为一样(`apps/mobile/pairing.test.ts`、`pset-shell.test.ts` 有测试)。

## v1 退休(2026-10-25,架构终态 F4)

- daemon 收到不带 `v:[…2]` 的握手 ⇒ 明文 `{error:'upgrade_required'}` 并关流;客户端把它当致命错误(跟 `auth_failed` 一样不再重连)。
- 老 VPS 中继(`t…` id,`/tunnel/*`)一起退休。网页 / 壳页手里还是 `t…` id、或收到 `upgrade_required` / `downgrade_refused` ⇒ 显示「连接方式升级了，请在电脑上重新扫码配对」。

## 后台侧对应

- 协商与串行开流:`src/features/phone/tunnel-client.ts`、`tunnel-v2-stream.ts`(握手/识别设备/`channel.open` 串行,`req` 并发处理)。
- 订阅主题:`src/features/phone/phone-events.ts` + `phone-topic-sources.ts`,白名单 `PHONE_TOPICS`(`src/features/phone/phone-routes.ts`)。
- 真机闭环:`wechat-cc selftest phone`(见 `docs/maintainer/verify.md`)。
