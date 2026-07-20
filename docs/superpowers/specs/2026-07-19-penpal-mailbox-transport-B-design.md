# 内容盲信箱传输 — 设计 spec（匿名笔友层 sub-project B）

> 状态：设计已定稿（2026-07-19 讨论）。这是 [匿名笔友社交层 spec](2026-07-18-anonymous-penpal-social-layer-design.md) 的
> **sub-project B**（§4.1 传输底座的落地）。sub-project A（E2E 笔友通道）已 SHIPPED 到 dev（`a1165e2`）。
> 落地计划由 writing-plans 另出。

## 0. 一句话

**一个内容盲的共享信箱中继：家用机拨出去 poll 自己的信箱、投递到对方信箱，绕过 NAT/离线。所有发往 `transport: mailbox` 对等方的 a2a 流量都被密封到对方的信箱公钥后投入中继——中继只见密文 + 信箱元数据。** 让 A 的匿名笔友通道真正在 NAT 后的真实机器之间跑起来。

## 1. 为什么（B 补的缺口）

A 的笔友通道跑在**现有传输**（`push` = HTTP POST 到对方 url / `ws` = YiHub）上。但真实家用机在 NAT 后、常离线——`push` 要公网 URL，`ws` 要一方起 hub。**没有共享中继，两台 NAT 后的机器互相够不着。** B 就是那道"够得着"的承重墙：内容盲信箱（store-and-forward），异步 poll，压力极小（笔记：1 万用户每 2 分钟 poll ≈ 83 req/s，单台 VPS 绰绰有余）。

发现/觅食**不是即时通信**——明信片晚几分钟无所谓（礼物不是通知）。所以信箱模型（拨出去、丢信取信、断开）而非保活连接，天然容忍离线、无 presence 泄露、payload KB 级。

## 2. 铁律（继承 A 的隐私铁律 + B 专属）

1. **中继内容盲**：中继只存 `{to: mailbox_pubkey, envelope: 不透明字节, cursor, ttl}`，永不解析 envelope，永不见明文、bearer、或路由。
2. **信箱地址 = 秘密能力**：一个对等方的信箱地址只通过**信任门控的 reveal**（朋友的朋友、过了 W 的真实好友门）披露；随机攻击者拿不到 → drop 可以开放（无身份门），只靠限流 + 尺寸上限 + TTL 防泄露地址后的洪泛。
3. **真身永不过中继**：信箱地址是一个 X25519 公钥（每 daemon 一个），不是真名；envelope 内的 bearer 是 a2a 配对密钥，且被密封，中继看不到。
4. **异步、低打扰**：poll ~2 分钟抖动；letters/echoes 几分钟内到达即可。

## 3. 架构总览

三块新东西 + 两处对 A/现有代码的接缝：

```
发送方 daemon                    中继 (VPS)                   接收方 daemon
  seal({path,bearer,body},   →   POST /drop {to, env}   →     (存 env by to+cursor, ttl)
       peer_mailbox_pubkey)
                                 POST /fetch {mailbox,   ←     心跳 poll (~2min 抖动)
                                   since, ts, sig}             ↓ 验签→取 env since cursor
                                 → {items:[{cursor,env}]}      openEnvelope(my_mailbox_priv)
                                 POST /ack {mailbox,up_to} ←   → {path,bearer,body}
                                                               → 复用现有 inbound dispatch
                                                                 (/a2a/reveal|/a2a/letter|…)
```

### 3.1 中继服务器（新，Bun，部署到 VPS）

- **内容盲存储**：SQLite（Bun 内置），表 `mailbox_item {to TEXT, cursor INTEGER PK autoincrement, envelope BLOB, expires_at}`。中继从不解析 envelope。
- `POST /drop` `{to, envelope}` → 追加一行，分配单调 cursor，`expires_at = now + TTL(默认7天)`。**开放**（地址即能力）；**限流**（每源 IP + 每 `to` 的速率）；**尺寸上限**（envelope 上限，如 16KB——letters 极小）；**信箱深度上限**（每 `to` 最多 N 条，超了丢最旧）。返回 `{ok}`。
- `POST /fetch` `{mailbox, since, ts, sig}` → 验 `sig` = 对 `fetch:{mailbox}:{ts}` 用 `mailbox` 私钥签名（证明拥有该信箱）+ `ts` 新鲜（防重放）→ 返回 `{items: [{cursor, envelope}], next_cursor}`（cursor > since，最多一页）。
- `POST /ack` `{mailbox, up_to_cursor, ts, sig}` → 同样验签 → 删除 `cursor <= up_to_cursor` 的项（尽早清，减存储）。未 ack 的由 TTL 扫。
- **自建、可多个**：v0 部署一台（`brain.youdamaster.cc`）；协议无状态化到"每信箱独立"，天然可多中继（v1 冗余）。
- 部署：独立进程/容器，仅监听 HTTPS；不碰 wechat-cc 主 daemon。

### 3.2 信箱密钥 + envelope 密封（复用 penpal-crypto）

- **每 daemon 一个稳定 X25519 信箱密钥**：首次启动生成一次，存 state dir（如 `mailbox-key.json`，0600）。**公钥 = 该 daemon 的信箱地址**。长期存活（区别于 A 的每关系临时 channel 密钥）。
- **envelope = sealed-box: `seal({path, bearer, body})` 给 `peer_mailbox_pubkey`**，用**每 envelope 一次性临时 X25519 密钥**（RESOLVED：临时而非发送方信箱密钥——这样中继/接收方在密码层都无法把这次 drop 关联到发送方的信箱身份，更私密；发送方在 app 层的身份靠 envelope 内的 bearer 表达，不靠 DH 公钥）。构造复用 `src/core/penpal-crypto.ts`：发送方 `deriveSharedKey(ephemeral_priv, peer_mailbox_pub)` + `sealLetter`（AES-256-GCM）；接收方 `deriveSharedKey(my_mailbox_priv, ephemeral_pub)` + `openLetter`。中继只见密文。
  - `path` = 原本的 a2a 路由（`/a2a/reveal` | `/a2a/letter` | seek/echo intake…）。
  - `bearer` = 发送方本会在 HTTP 里带的配对密钥；接收方复用**现有 verifyBearer** 校验，与 HTTP 请求一视同仁。
  - `body` = 原本的 HTTP body。
  - envelope 明文头只放**一次性临时公钥**（供接收方 ECDH）+ 密文/nonce/tag；临时公钥不泄露内容、也不泄露发送方身份（每次都不同、不可关联）。
- letters 本身已是 channel-key E2E（A）；信箱层再套一层 mailbox-key 密封 = 纵深防御，还顺带把 bearer/路由也对中继藏了。redundant 但无害。

### 3.3 传输集成（客户端）

- `A2AAgentRecord` 增 `transport: 'mailbox'` 档 + `mailbox_addr`（对方信箱公钥）+ `relays: string[]`（对方可达的中继 URL 列表）。
- **发送**：发往 mailbox 对等方时，`makeMailboxSender` 取代 `a2aClient.send(url,…)`：`seal({path,bearer,body}, peer.mailbox_addr)` → 向 `peer.relays` 里的中继 `POST /drop`。发送点在 `wire-social.ts` 的 `postReveal`/`postLetter`/`a2aClient.send` 接缝——按 `hand.transport` 分派（现有 push/ws 分派的第三档，见 `pipeline-deps.ts` 的 `makeDelegateToHand` 同款模式）。
- **poll 循环**：`makeMailboxPoller` 挂到现有心跳/scheduler（`src/daemon/guard/scheduler.ts` / `companion/scheduler.ts` 同款）。每 ~2 分钟（抖动）：对每个配置的中继 `POST /fetch {my_mailbox, since_cursor, ts, sig}` → 对每条 envelope `openEnvelope(my_mailbox_priv)` → `{path, bearer, body}` → **复用现有 inbound dispatch**（把 reveal/letter/seek 塞进它们本来的 handler，与 HTTP 路由同一路径）→ 成功后 `POST /ack`。持久化 cursor（state dir 或小表）。
- **inbound dispatch 复用**：现有 `/a2a/reveal`、`/a2a/letter` 路由已把 handler 抽出（onReveal/onLetter）；poller 直接调它们，跳过 HTTP 层但**照样 verifyBearer**（bearer 从 envelope 里来）。

### 3.4 寻址（reveal 携带信箱地址）

- **reveal 交叉时同时交叉信箱地址**：扩展 A 的 `PenpalHandle`（或并列一个字段）带上 `mailbox_addr` + `relays`。1-hop 直接交叉；2-hop 由 W 交叉（W 已经在 crossing 两边的 handle，顺带带 mailbox 地址——W 仍不看内容）。
- reveal 之后，S/Q 各自知道对方 `{channel pubkey, mailbox_addr, relays}` → **letters 直投对方信箱（relay-direct）**。

### 3.5 relay-direct letters（W 退出信件回路）

- **一旦 reveal 交换了信箱地址，2-hop letters 走 relay-direct**（S seal→drop 到 Q 信箱→Q poll），W 不再逐信转发。**更私密**（W reveal 后什么都不见）+ **更省**（无逐信过 W）。
- **A 的 Task-9 W-forwarding 降级为 fallback**：仅当对方**没有** mailbox（`push`-only、无 `mailbox_addr`）时才走 W 转发。所以 B **不删** Task-9,只是在 mailbox 可用时旁路它。

## 4. Poll 节奏

**~2 分钟抖动**。letters/echoes 几分钟内到达，符合"礼物不是通知"。抖动糊化时序关联。空 poll 便宜（一个 HTTPS 请求）。（自适应快/慢 poll = v1。）

## 5. 错误处理 / 边界

- **中继不可达**：poll 失败 → 下次心跳重试；drop 失败 → 有界重试（fire-and-forget，letters 可容忍延迟）。多中继时轮询（v0 单中继）。
- **过期项**：TTL 到点中继扫掉；接收方久离线可能丢信（可接受——异步、尽力）。
- **畸形 envelope / 解密失败**：poller 静默丢弃（GCM 验签失败 = 不是给我的/被篡改），不崩、不夹进 dispatch。与 A 的 `openLetter` 失败处理一致。
- **重放**：cursor 单调 + ack 删除；同一 cursor 不会重复取（seen-intent 去重仍在 app 层兜底）。
- **限流触发**：drop 被中继限流 → 返回错误，发送方退避重试。

## 6. 与现有代码的接缝

| 现有 | B 里 |
|---|---|
| `a2aClient.send({url,bearer,body})`（push） | 加 `transport: mailbox` 第三档：seal→drop（`makeMailboxSender`） |
| `/a2a/reveal`、`/a2a/letter` 路由 handler（onReveal/onLetter） | poller 解 envelope 后**复用**同一 handler（verifyBearer 照旧） |
| 心跳/scheduler（guard/companion） | 挂 `makeMailboxPoller`（~2min 抖动） |
| `A2AAgentRecord {id,url,transport:push\|ws,…}` | 加 `mailbox`、`mailbox_addr`、`relays[]` |
| A 的 reveal handle 交叉 | 顺带交叉 `mailbox_addr`+`relays` |
| A 的 Task-9 W-forwarding letters | 降级为 push-only fallback（mailbox 可用时旁路） |
| penpal-crypto（seal/open） | envelope 密封复用它 |
| — | **新增：中继服务器（Bun，VPS）** |
| — | **新增：每 daemon 信箱密钥（state dir）** |

## 7. 测试策略

- **中继单测**：drop→fetch(since)→ack 语义；限流/尺寸上限/深度上限；fetch 验签（错签拒绝、过期 ts 拒绝）；TTL 过期扫除；内容盲（中继从不解析 envelope）。
- **envelope round-trip**：`seal({path,bearer,body}, peerPub)` → `open(myPriv)` 复原；篡改拒绝；给错信箱（错密钥）解不开。
- **传输集成**：mailbox 对等方 send = drop 到对方信箱；poll 取回 → 正确 dispatch 到对应 handler + verifyBearer；push 对等方不受影响。
- **relay-direct letters**：reveal 交换 mailbox 地址后，2-hop letter 走 relay-direct（不过 W）；对方无 mailbox 时回落 Task-9 W-forwarding。
- **e2e**：两个模拟 NAT 后（无直连）的 daemon + 一个内存中继，跑通 reveal→letter 往返；断言中继只见密文、W 在 mailbox 路径下不碰 letter。

## 8. 分期（B 内）

大致任务组（writing-plans 细化）：
1. **中继服务器**（Bun：drop/fetch/ack/TTL/限流 + SQLite）+ 单测。
2. **信箱密钥**（生成/存 state dir）+ **envelope seal/open**（复用 penpal-crypto）+ 单测。
3. **mailbox sender**（transport:mailbox → seal→drop）+ `A2AAgentRecord` 字段 + 分派接缝。
4. **mailbox poller**（心跳挂载、fetch→open→replay-dispatch→ack、cursor 持久化）。
5. **reveal 交叉 mailbox 地址** + **relay-direct letters**（Task-9 降 fallback）。
6. **e2e**（两 NAT 模拟 daemon + 内存中继，reveal→letter 往返，内容盲断言）。
7. **部署**（VPS 上把中继跑起来——真机验证，独立于 CI）。

## 9. 明确不做（non-goals / 留 v1+）

- **每连接轮换信箱地址**（unlinkability）——v0 是每 daemon 稳定地址，接受"多个对端共知同一信箱可关联你的连接"（§11 元数据）。
- **多中继冗余 / 跨中继同步**——v0 单中继，客户端接受列表但不做冗余。
- **PoW 反洪泛**——v0 靠"地址即能力" + 限流；PoW 地板留给脱微信的 v1（父 spec §6/§9）。
- **seeks/echoes 强制走 mailbox 的完整覆盖**——v0 优先打通"发往 mailbox 对等方的所有 a2a 流量都走信箱"的通道；广播式觅食对大量 mailbox 对端的批量投递优化留后。
- **中继付费 / allowlist / sealed-sender 式元数据加固**——v1。
- **实时**——整层异步；实时留给语音子系统。

## 10. 硬骨头 / 记在案

- **中继元数据**：内容盲仍见"谁 poll 哪个信箱、谁 drop 给谁"。缓解（一次性信箱地址、抖动 poll、sealed-sender）是 v1。v0 接受自建/可信中继运营方能看到部分元数据（父 spec §11）。
- **信箱地址泄露后的洪泛**：地址是能力，但一旦泄露，攻击者可 drop（限流 + 尺寸 + 深度上限兜底，但会占额）。per-connection 地址（v1）把爆炸半径缩到一条连接。
- **久离线丢信**：TTL 到点丢；可接受（尽力异步）。真要可靠投递需 ack-持久 + 更长 TTL，留后。
- **中继 = 单点**：v0 单中继挂了则 mailbox 路径断（push/ws 对端不受影响）。多中继冗余 = v1。

---

## 附：今日已定的决策清单（供 review 核对）

1. **B 范围 = 中继服务器 + 客户端一起**，端到端真机跑通。
2. **relay-direct letters**：reveal 交换信箱地址后 2-hop letters 走中继直投，**W 只牵线不再逐信转发**；A 的 Task-9 降为 push-only fallback。
3. **所有发往 mailbox 对端的 a2a 流量走中继**，envelope = `seal({path,bearer,body}, 对方信箱公钥)`（复用 penpal-crypto），中继内容盲（连 bearer/路由都藏）。
4. **中继安全**：drop 开放（**地址即能力** + 限流/尺寸/深度/TTL）；fetch 需签名证明拥有信箱；ack 删除。SQLite。
5. **信箱密钥 = 每 daemon 一个稳定 X25519**，存 state dir，公钥即地址。
6. **poll = ~2 分钟抖动**，挂现有心跳。
7. **部署单中继**（VPS），客户端接受中继列表（多中继就绪）。
8. **v1 留**：每连接轮换地址、多中继冗余、PoW。
