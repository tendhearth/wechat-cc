# 心愿与明信片:派心愿 / 揭晓改写成第 3 层交互(架构重构步 6,1 跳)— 设计

日期:2026-09-04
状态:已评审(owner 拍板:顺势重框、不兼容旧协议直接切换、两段式先做 1 跳、邻居不回心愿、微信两步确认保留)
上游:`docs/superpowers/specs/2026-09-04-social-architecture-rethink.md` §3 步 6

## 0. 为什么重做,以及一个隐藏事实

旧的派心愿是「主人的工具」形状:主人写心愿 → broker 扇出到注册表对端(`/a2a/intent` 推送或信箱)→ 对端判官 → 回声(`/a2a/echo`)→ 脱敏评审 → 明信片 → 双方揭晓(`/a2a/reveal`)→ 才开出一条笔友信道。四张表(social_seek / echo / pledge / relay)、三条 a2a 路由、各自的重试器与对账器。真机上四张表全是 0 行。

重构 1–5 步之后,伙伴之间说话只有一种形状:**带 kind 的信封走 E2E 信道**(信件、串门)。心愿和明信片理应也是两种 kind。

**隐藏事实(核代码发现):笔友信道只在揭晓流程里创建**(`wire-social.ts` 唯一一处 `channelStore.create`)。配对本身不开信道 —— 关系视图里注册表对端都是「配对(还没开信道)」。所以删掉揭晓之前必须先补「配对即开信道」,否则认识的人之间永远没有信道,信件、串门、心愿全断。

**范围(owner 拍板):**
- 这轮只做 **1 跳**:心愿发给已有信道的关系。2 跳(经介绍人认识新人、anon → peer 迁移、内容盲中继)留给下一轮「介绍」。
- **不兼容旧协议**:`/a2a/intent` `/a2a/echo` `/a2a/reveal` 直接删。真机只有两台且都是 owner 的,一起升级、重新配对。
- **邻居不回心愿**:邻居是本机模型演的角色,回心愿等于编造「我认识一个人」,和串门闲聊性质不同。
- **微信两步确认保留**(伙伴先复述要怎么问,主人说派才发)—— 这是防「agent 擅自替主人行事」的人工门。

## 1. 交互层:两种信封

### 1.1 载荷

```ts
// kind = 'wish'
interface WishPayload { id: string; text: string; expiresAt: string /* ISO */ }
// kind = 'postcard'
interface PostcardPayload { wishId: string; text: string }
```

信封走现有 `correspondent.sendEnvelope(channelRowId, env)`;入站在 wire-social 的 `switch (env.kind)` 各加一个 case(`'wish'` / `'postcard'`),**不加任何 `/a2a/*` 路由**。信件表 `penpal_letter` 的 kind / payload 列(v39)原样承载,不建新表。

### 1.2 发心愿的一方(seeker)

状态机(纯函数,`src/core/wish.ts`):

```
draft ──派──▶ open ──7 天──▶ expired
  │取消          │取消
  ▼              ▼
cancelled     closed
```

- **draft**:主人「派心愿 <text>」→ `gateOutbound(text, policy)`(现有披露门,唯一出口)→ 不过门就当场告诉主人哪里不能说;过门就存草稿,伙伴复述「我打算这么问朋友们:<redacted>(<id>)。派?」。
- **open**:主人「派 <id>」→ 广播 `wish` 信封给**所有 status=open 的信道**(关系视图里的 peer / anon;不排序、不挑人、不分批)。每条信道投递结果记进 `sentTo`(信箱是 store-and-forward,「投出去」就算)。同时最多 **3** 条 open 心愿,超了拒绝并说明。
- **closed**:主人「取消 <id>」。open → closed 后到达的 postcard 照常入日志(人家已经答了),只是不再算「开着」。
- **expired**:`expiresAt` = 派出时 + 7 天;过期后到达的 postcard **丢弃 + 日志**(收件方也会用 `expiresAt` 自行丢弃过期心愿,双保险)。
- 草稿和状态存 `<stateDir>/companion/wishes.json`(`{ wishes: WishRecord[] }`,同 `neighbors.json` 做法;`readJsonFile` 读)。「发出去过的」真相在 `penpal_letter`(direction=out, kind=wish);wishes.json 是它的索引 + 草稿。

每张收到的 postcard:
1. 校验 `wishId` 是我派过的、未过期、同 (wishId, 信道) 未收过(去重);
2. `journal.record({ kind: 'postcard', title: '<对方 label> 回了你的心愿', note: text, chatId: owner })` —— 于是自动进桌面「带回来的」和桌宠脚边的包袱(kind postcard → 明信片道具);
3. 微信一句话:「📮 <label> 回了你的心愿「<text 前 20 字>」:<postcard text>」;
4. `wishes.json` 里该 wish 的 `replies++`。

想接着聊:信道本来就在,用现有「回信 <信道>」。**没有 pledge、没有揭晓、没有脱敏评审队列。**

### 1.3 收到心愿的一方(answerer)

- 入站 `wish`:过期直接丢;同 (wishId, 信道) 已处理过直接丢(幂等:信箱 at-least-once)。
- 现有判官 `makeJudge`(接地 + 披露策略)判断「我主人能不能帮」。输入从 `IntentCard` 收窄为 `{ topic: string }`(判官 prompt 不变)。
- 判「能」:`gateOutbound(blurb)` → `sendEnvelope(同一条信道, { kind: 'postcard', payload: { wishId, text } })`;判「不能」:静默。
- **无论能不能,都给自己主人一句话**:「🙋 <label> 的伙伴来打听「<text>」,我回了:<blurb>」/「…我说不知道」。被问的人有权知道自己被问了(MoltMatch 教训)。不进 journal(这不是带回来的东西)。
- 处理记录:`<stateDir>/companion/wishes-seen.json`(`{ [wishId:channelId]: ISO }`,保留 14 天)—— 幂等键。

### 1.4 邻居

不参与。`wish` 只广播给有信道的关系;邻居没有信道,自然排除。关系视图不改。

## 2. 配对即开信道(替代 1 跳的揭晓)

只改 **6 位配对码**(信箱 PairCard,`src/core/pairing.ts`)。WCCP1 邀请码是「手」的授权路径,spec 上游已把手搬出社交,不碰。

- `PairCard` 加两个字段:`channel_id: string`(我的收信地址)、`channel_pub: string`(我的 X25519 公钥,spki DER base64url)。`v` 升到 2;`isCard` 校验这两项非空。
- 双方在 `writePeerFromCard` 成功后各自:
  ```ts
  const rowId = `pair:${card.nonce}`
  channelStore.create({ id: rowId, seekId: rowId, myPrivkey, myPubkey, myChannelId, degree: 1, peerAgentId: card.self_id })
  channelStore.setPeerHandle(rowId, { pubkey: card.channel_pub, channel_id: card.channel_id, mailbox: { addr: card.mailbox_addr, enc_pub: card.mailbox_enc_pub, relays: card.relays } })
  channelStore.setStatus(rowId, 'open')
  ```
  `seek_id` 列 NOT NULL,填 rowId 即可(它的语义从「哪个心愿开的」变成「怎么开的」;列不改名)。
- 我方的 X25519 密钥对在 `start()` / `accept()` 里生成,随 card 发出;`PairingDeps` 加 `channelStore`。
- 重复配对同一对端(同 self_id 同 mailbox_addr):已有 open 信道则不再建第二条(按 `peer_agent_id` 查)。
- 关系视图:配对完的对端直接以「peer + channel」出现,`origin: '配对'`;「配对(还没开信道)」这一类只剩历史遗留行。
- **旧对端**:已配对但没信道的,重新配对一次。Mac↔Windows 现有那条信道(揭晓建的)保留,行为不变。

## 3. 删除清单(直接切换)

| 层 | 删 |
|---|---|
| core | `social-broker` `social-seek-store` `social-echo-store` `social-echo-intake` `social-echo-relay` `social-echo-retry` `social-pledge-store` `social-relay-store` `social-relay-retry` `social-reveal` `social-relay-reveal` `reveal-command` `forward-budget` `penpal-relay-letter`;`a2a-intent.ts` 里 IntentCard / ForwardedEcho / MatchReceipt / Echo schema(留 `A2A_PROTO_VERSION`,升到 3);`seek-command.ts` 保留解析(`派 <id>` / `取消 <id>`)但 `resolveSeekRef` 改查 wishes.json |
| daemon | `a2a-server.ts` 的 `/a2a/intent` `/a2a/echo` `/a2a/reveal` handler;`mailbox-dispatch.ts` 三条孪生路;`wire-social.ts` 里 responder / answer / forward / echo-intake / reveal / relay 的全部接线与 `postToPeer`/`postToHand` 扇出(只剩 correspondent、串门、心愿);`social-finish-seek` `forward-budget-seam` `social-async-responder` `social-answer`;`command-router` 的「揭晓」块 |
| internal-api | `routes-social.ts` 的 seek propose/confirm/cancel、seeks、echoes、echoes/reveal、inbound 路由 + schema + tier;`Bootstrap.social` 里 broker / seekStore / echoStore / pledgeStore / revealer |
| CLI | `src/cli/social.ts` 对应子命令 |
| DB | 迁移 v41:`DROP TABLE` social_seek / social_echo / social_pledge / social_relay / social_seen_intent。真机全 0 行。journal 的 `CatchKind` 放开 `'postcard'`(表无 CHECK 约束,只改类型和 `record*`) |
| 桌面 | `a2a-agents.js` 的「我派出去的心愿」「回声」「入站」三块及其测试;换成 §5 的心愿区 |

**保留**:`social-judge`(输入收窄)、`a2a-disclosure.gateOutbound`、注册表、两套配对、信箱全套、correspondent、`wire-visit`、journal、relationships、`a2a_events`(社交往来落痕的现有写点跟着删,表和读点留)。

## 4. 新接口

| 路由 | 作用 | tier |
|---|---|---|
| `POST /v1/social/wish {text}` | 过门 + 存草稿 → `{ ok, id, preview }` 或 `{ ok:false, error, violations }` | trusted |
| `POST /v1/social/wish/send {id}` | draft → open,广播 → `{ ok, sent_to: n }` | trusted |
| `POST /v1/social/wish/cancel {id}` | → closed / cancelled | trusted |
| `GET /v1/social/wishes` | `[{ id, text, status, created_at, expires_at, sent_to, replies }]`,最近 30 天 | trusted |

微信:`派心愿 <text>` / `派 <id>` / `取消 <id>`,复用 `seek-command.ts` 的解析,后端换成 wish 状态机。「揭晓」命令删除。

`Bootstrap.social` 收成:`{ penpal: {...现有, startVisit, activeVisit}, wish: { propose(text), send(id), cancel(id), list() } }`。

## 5. 桌面

觅食台技术区(`#fd-tools`)只剩「配对」。新增一个小区块「📮 心愿」:一个输入框(→ `POST /v1/social/wish`,显示 preview + 「派」「算了」两个按钮)+ 开着的心愿列表(每条:文字、派给了几个人、几张回信、「取消」)。回信本身在「🎒 带回来的」里看(kind=postcard 卡片,已有明信片卡样式)。`people.js` 不动。

## 6. 测试

| 单元 | 测什么 |
|---|---|
| `wish.ts` 纯函数 | draft/open/closed/expired 迁移;3 条上限;过期判定;去重键;replies 计数 |
| `wishes.json` 存取 | 空 / 坏文件 → 空;读写往返;`readJsonFile` |
| 两个 daemon 同进程(照 `wire-visit.test.ts` 的 `side()` 夹具) | A 派 → B 假判官「能」→ postcard 回 A → A journal 多一条 kind=postcard、A 主人一句话、B 主人一句话;B 假判官「不能」→ A 无变化、B 主人一句话;过期 wish 被 B 丢;同 wish 重投被 B 去重;A 收到不认识的 wishId 丢 |
| 配对握手 | 双方 card 带 channel 字段;完成后双方各一条 open 信道,`peer_agent_id` 互指,`peer_mailbox` 正确;重复配对不建第二条;v1 旧 card 被拒 |
| 迁移 v41 | 四张表消失;`user_version` 计数正确(memory: migration-position-contract);已有 penpal_* 数据不动 |
| 路由 | 四条路由形状 + tier trusted;未接线 503 |
| 桌面 | 心愿区渲染 / 派 / 取消;a2a-agents 删块后现有测试收敛 |

真机:Mac + Windows 都升级 → 6 位码重新配对 → Mac「派心愿 …」→ Windows 日志见判官跑 → Mac 包袱里出现明信片 → 桌宠脚边道具。顺带验掉桌宠那轮没验的闭环。

## 7. 明确不做

- 2 跳 / 介绍 / anon → peer 迁移 / 内容盲中继(下一轮)
- 心愿的扇出重试与退避(信箱 at-least-once + 7 天过期足够;旧的重试器是给推送直连设计的)
- 按亲密度挑人、分批广播(关系数量个位数,全发)
- 邻居回心愿
- 收件方把「被问」记进 journal(只微信一句话)
- 旧协议兼容 / proto_version 选路

## 8. 冷启动

这轮结束后,认识新人的唯一入口是 6 位配对码。这是有意的:先把「认识的人之间」这一层做对(配对即有信道,心愿有去有回),再做「认识新人」。真实用户在「有一两个朋友」这一层会活很久;那一层没做对,介绍再多也没用。
