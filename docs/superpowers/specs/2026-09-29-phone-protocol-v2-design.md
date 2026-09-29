# 手机协议包与实时通道(手机 app 子项目 1)设计

日期:2026-09-29。状态:**完成**(2026-09-29,实现计划与执行见 `docs/superpowers/plans/2026-09-29-phone-protocol-v2.md`)。基线 origin/dev d46a03d2。

> **执行中改了设计的裁决**:(1) 裁决 1 快照:断线续传只发当前状态快照,不存 64 条事件缓冲(事件本身就是主题快照)。(2) 后台 v2 流**串行开流、并发处理**——只把握手 / 识别设备 / `channel.open` 串行(计数器检查要按序),`req` 并发派发,v1 完全并发;否则一个 15 s+ 的对话轮次会堵住整条流。(3) 在场图片(约 257 KB)移出 /m 页,改走令牌门控的 `GET /m/api/art/presence`,让页面留在中继 512 KB 帧内,没有改中继上限。(4) `ProtocolSocket` 加 `onOpen`,握手期限,只对幂等请求(GET/HEAD)重试并沿用同一 rid,整体期限 `requestDeadlineMs`(缺省约 90 s,app 需自设或显示连接中)。(5) `selftest phone` 任何输出都不打印令牌,失败时指引经设置页手动撤销。另:`scripts/gen-tunnel-vectors.ts` 保留冻结的 WebCrypto v1 参考实现,防向量自证。

## 0. 背景:手机 app 项目与本子项目的位置

主人 2026-09-29 拍板:做原生手机 app,上 App Store / Google Play 给陌生用户,**海外为主**,成熟项目、AI 自动开发与维护。

- **技术:Expo(React Native,TypeScript)**,同仓库。依据:最接近的两个同类开源产品 Paseo(getpaseo/paseo)与 Orca(stablyai/orca)手机端都是 Expo;Expo SDK 56 起小组件与实时活动(灵动岛)稳定、可用 React 组件写。全仓库统一 TypeScript,加密与接口类型一份代码多处用。
- **定位:「住在你自己电脑上的个人 AI,也能替你指挥编码 agent」**(Meta Muse 的那个空间,但数据在用户自己手里),不是「手机遥控编码 agent」。**微信只是获客通道之一**,以后可换 / 加 WhatsApp 等;app 是一等操作面。
- **中继:** 官方托管,默认免费,允许自托管,给以后「官方中继进订阅」留余地。推送密钥放在官方中继。
- **拆成六个子项目**:① 协议包 + 实时通道(本稿)② 中继升级成对外服务(多用户、防滥用、推送发送、监控)③ App 第一版 ④ 灵动岛 / 锁屏实时活动 / 小组件 ⑤ 协调 agent ⑥ 通道抽象。① ② 是前提,③ 依赖它们,④ 依赖 ③,⑤ ⑥ 独立。

**本子项目的目标:** 给 app 打地基 —— 一份四个运行时(Bun/Node 后台、浏览器、React Native、中继壳页)共用的协议包;一版带防重放、响应头、二进制与服务端主动推送的协议 v2;后台侧的事件集线器与订阅主题;以及推送加密的密钥派生(推送本身在子项目 2)。

## 1. 现状(d46a03d2)

- **传输:** 手机 ↔ 中继 ↔ 后台是加密 WebSocket 里跑「HTTP 请求 / 响应」,一问一答。中继 `relay/tunnel.ts`(`makeTunnelHub`)按 daemon id 把手机连接配给后台,包一层 `{stream, frame}`,只见密文;单帧 512 KiB 上限、每条流令牌桶(突发 120、每秒 20),超限**静默丢帧**。默认 `wss://cc.tendhearth.com/tunnel/{phone,daemon}`。
- **加密:** `src/lib/tunnel-crypto.ts`:X25519 → HKDF-SHA256(`info='wechat-cc/tunnel/v1'`,**salt = 令牌的 UTF-8 字节**)→ AES-256-GCM,每帧随机 12 字节 nonce,无计数器、无防重放。握手:手机发明文 `{hs: pub}`,后台回 `{hs}`;令牌从不上网,后台拿已知令牌逐个试解第一帧来识别设备。用 `node:crypto` 的 `webcrypto.subtle` 与 `Buffer`。
- **三份手写实现:** 后台 `tunnel-crypto.ts`、手机网页 `apps/mobile/src/transport.js`(经 `TUNNEL_CLIENT_JS` 内联进 `/m` 与 `/set`)、中继壳页 `relay/pset.html`。互不共享,只有往返与篡改测试,没有固定测试向量。三份都依赖 WebCrypto 或 Node,React Native(Hermes)里都用不了。
- **后台侧:** `src/daemon/tunnel-client.ts` 解出 `{path, method, body?, rid}`,改写查询串(去掉 `d`/`t`,加上认证过的 `d=` 与 `_via=tunnel`)交给 `settingsPanel.handleRequest`,回 `{rid, status, body: string}` —— **没有响应头**,二进制只能走 base64 JSON(贴纸的 `?b64=1`)。**没有任何服务端主动推送。**
- **接口:** `/m/api/*` 由 `PHONE_ROUTES`(`src/daemon/phone-routes.ts`)守门,返回全是手拼对象,没有 schema。
- **实时:** 手机网页靠轮询(首页 15 s、打开的任务详情 3 s 拉全量)。工作台有现成的变更集线器(`src/core/workbench/task-changes.ts` 的 `publish` / `wait`)与长轮询路由(`/v1/workbench/task?since&wait_ms`),但那是内部 API 的 admin 路由,手机够不着。
- **推送:** 没有。

## 2. 协议包 `packages/protocol`

- 纯 TypeScript,**不依赖运行时**。后台(Bun / Node)、手机网页(浏览器)、app(React Native)、中继壳页都从这一份来。
- **加密实现换成 `@noble` 系列**:`@noble/curves`(X25519)、`@noble/hashes`(HKDF-SHA256、SHA-256)、`@noble/ciphers`(AES-256-GCM)。算法与参数和现状完全一致,只换实现。随机数只用 `globalThis.crypto.getRandomValues`(四个运行时都有;React Native 由 `expo-crypto` / `react-native-get-random-values` 提供)。base64url 自己写,不用 `Buffer`。
- **兼容性先钉住:** 动代码之前,用**现在的** `tunnel-crypto.ts` 生成一份固定测试向量(给定私钥、对端公钥、令牌、nonce、明文 ⇒ 派生密钥与密文),提交成 `packages/protocol/vectors/v1.json`。新实现必须逐字节对上。已配对的设备、已加主屏的网页,切换过程中一台都不能断。
- **替换:** 后台 `tunnel-crypto.ts` 改为调用协议包(对外签名不变);手机网页与中继壳页的两份手写加密,改成构建时从协议包打包生成(沿用 `apps/mobile/build.ts` 生成物 + 同步守卫的做法),不再手抄。
- **接口 schema:** 用 zod(仓库已有 v4)给 `/m/api/*` 与 `/set/api/*` 的每个返回写 schema,放在协议包里。后台测试逐条校验真实返回;app 用 `z.infer` 得到类型。后台改了字段、app 没跟上 ⇒ CI 红。
- **纯净守卫:** 测试禁止 `packages/protocol` 引用 `node:*`、`Buffer`、`crypto.subtle`、DOM 类型与 `window` / `document` / `localStorage`。它在 React Native 里一定能跑,不用等 app 做出来才发现。

## 3. 协议 v2

### 3.1 版本协商

- 客户端握手带上支持的版本:`{hs, v:[1,2]}`。新后台回 `{hs, v:2}`;老后台不认识 `v`,只回 `{hs}` ⇒ 客户端退回 v1。
- 中继不用改(只转发、不看内容)。
- 手机网页继续 v1;app 走 v2。用户的后台没升级时,app 自动退回 v1 的一问一答,只是没有实时推送。

### 3.2 加密:防重放

- 共享密钥之后,用 HKDF 按方向派生两把密钥:`info='wechat-cc/tunnel/v2/c2s'` 与 `'…/s2c'`,salt 仍是令牌的 UTF-8 字节(「令牌参与密钥派生、从不上网」不变)。
- nonce = 4 字节方向标记 + 8 字节递增计数器。接收方记录已见的最大计数器,**不增加的帧直接丢弃**。每条流从 0 开始,流一断计数器随之作废。
- 设备识别照旧:后台拿已知令牌(≤ 20 台 + 活跃链接令牌)逐个试解第一帧。

### 3.3 消息(都在加密帧里,JSON)

| 类型 | 字段 | 方向 |
|---|---|---|
| `req` | `rid, method, path, headers?, body?, bodyEncoding?('utf8'\|'base64')` | 客户端 → 后台 |
| `res` | `rid, status, headers, body, bodyEncoding` | 后台 → 客户端 |
| `sub` | `sid, topic, since?` | 客户端 → 后台 |
| `unsub` | `sid` | 客户端 → 后台 |
| `ev` | `sid, epoch, seq, data` | 后台 → 客户端 |
| `err` | `rid?` / `sid?`, `code` | 后台 → 客户端 |

- 订阅后的第一条 `ev` 就是当前状态;断线重连带 `since`(上次最后的 `seq`)续上,后台发缺的那段。集线器每个主题只保留最近 64 条事件;`since` 早于这个窗口(或后台重启过、`seq` 对不上)⇒ 直接发一条当前状态,客户端按「重新订阅」处理。`seq` 按主题单调递增,后台重启后从新的纪元开始(`ev` 带 `epoch`,客户端见到纪元变化即视为缺口)。
- 客户端每个请求自带超时与有限次重试(中继限流 / 超大帧时会静默丢帧,见 §1);让中继回显式错误帧属于子项目 2。

### 3.4 订阅主题

| 主题 | 内容 | 驱动 |
|---|---|---|
| `home` | 未读数、CC 状态、最新动态游标 | 首页、小组件 |
| `matter/<id>` | 这件事的版本号与阶段 | 详情页(不再 3 s 拉全量) |
| `approvals` | 所有任务里等主人批准的权限与问题(id、所属任务、一句摘要) | 锁屏批准、角标 |
| `agents` | 在跑的任务汇总:几个在干、几个在等、各自阶段 | 灵动岛、实时活动 |

- **事件只带小摘要与版本号,大内容照旧用 `req` 去拉。** 单帧远离 512 KiB 上限;沿用工作台的约定:漏唤醒是 bug、多唤醒只是空转,游标只认版本号。
- 同一主题的事件在发出前合并,只留最新一条;手机慢了不积压。
- 主题同样走白名单:`PHONE_TOPICS`(放在 `phone-routes.ts` 旁),设备令牌只能订阅在册主题;`matter/<id>` 的 id 与 `/m/api/matter` 一样受主人归属检查。守卫对着代码双向核对(同 `scripts/phone-routes.guard.test.ts`)。

### 3.5 推送密钥(接口在本稿定,发送在子项目 2)

- app 不在线、又发生了值得通知的事(要批准、任务做完)时:后台用这台设备的**推送密钥**把一小段通知内容加密,交给中继转发到 APNs / FCM;手机上的通知扩展(iOS Notification Service Extension、安卓推送服务)用同一把密钥本地解密再显示。中继与 Apple / Google 都看不到明文。
- 推送密钥从设备令牌派生:HKDF-SHA256,`info='wechat-cc/push/v1'`,与隧道密钥互不相通。派生函数与封装格式(`{v, iv, ct}`,AES-256-GCM,随机 nonce,内容内带时间戳防旧推送重放)进协议包,测试向量同 §2。
- 本子项目只做到「后台产出加密好的通知载荷 + 一个 `onNotify(deviceId, sealed)` 出口」;出口默认什么也不做。

## 4. 后台侧改动

- **隧道客户端**(`src/daemon/tunnel-client.ts`):握手做版本协商。v2 连接上:`req` 照旧交给面板,但 `res` 带响应头与二进制正文;`sub` / `unsub` 交给事件集线器;连接断开清理这条连接上的全部订阅。v1 行为逐字节不变。
- **事件集线器**(新 `src/daemon/phone-events.ts`):汇集四路来源 —— 工作台变更、「一件事」变更、待批准的权限与问题、首页动态 —— 按主题分发、合并、编号。工作台的 `task-changes.ts` 目前只有「等一下看变没变」(`wait`),补一个「变了就回调」(`onChange`)的接口,不改现有语义。
- **手机网页:** 加密改为构建时从协议包生成;协议仍 v1;功能不变。
- **接口 schema:** 后台测试逐条用协议包的 zod schema 校验 `/m/api/*` 真实返回。

## 5. 测试与验收

1. **兼容性向量**(§2):新实现逐字节对上现有实现的输出;v2 与推送密钥也各有一份向量。
2. **纯净守卫**(§2)。
3. **进程内端到端互通:** `makeTunnelHub`(真中继实现)+ 后台隧道客户端 + 一个用协议包写的 v2 测试客户端。覆盖:请求 / 响应(含二进制与头)、订阅收到当前状态与后续事件、断线后带 `since` 续上、重放旧帧被拒、对「老后台」退回 v1、撤销设备后连接立刻失效、同主题合并。
4. **v1 回归:** 现有隧道与手机网页测试一条不改、全绿。
5. **真机自检 `wechat-cc selftest phone`:** 临时配对一台虚拟设备,经真实中继(cc.tendhearth.com)连回本机,订阅 `agents`,派一个小任务,确认事件按序到达,最后撤销这台虚拟设备。和现有 `selftest workbench|chat` 并列,每次部署都能跑。

**算做完:**
- 已配对的手机网页一台不断(主人 iPhone 实测,顺带销一笔真机账)。
- `selftest phone` 在真实中继上 PASS。
- 全量测试(bun / node)、类型检查(看退出码)、depcheck、CI 三平台绿。

## 6. 不做

- 中继改动(多用户、防滥用、显式错误帧)与真正发推送 —— 子项目 2。
- App 本身 —— 子项目 3;灵动岛 / 小组件 —— 子项目 4。
- 局域网直连(app 第一版一律走中继)。
- 把 `/m/api` 并进内部 API dispatcher(上一轮推迟的范围 B)。
- 改动 v1 协议或手机网页的功能。

## 7. 交接

- 触碰:新 `packages/protocol/`(含 `vectors/`)、`src/lib/tunnel-crypto.ts`(改为转调)、`src/daemon/tunnel-client.ts`、新 `src/daemon/phone-events.ts`、`src/core/workbench/task-changes.ts`(加 `onChange`)、`src/daemon/phone-routes.ts`(加 `PHONE_TOPICS`)、`apps/mobile/`(transport 改生成)、`relay/pset.html`(加密改生成)、新 `selftest phone`、守卫与测试、`docs/reference/internal-api-auth.md` 与维护者手册。
- 工作区:`package.json` 需要 workspaces 或 tsconfig paths 让根与 `apps/*` 引用 `packages/protocol`;实施计划里先验证 Bun / vitest / tsc / depcheck / 桌面构建都认得它。
- 实施计划另出(writing-plans),按 §2 → §3 → §4 → §5 的顺序,每节先红后绿。
