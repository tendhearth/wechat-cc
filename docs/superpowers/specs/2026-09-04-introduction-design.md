# 介绍:朋友的伙伴替我转问,两边点头就成朋友(架构重构步 6,2 跳)— 设计

日期:2026-09-04
状态:已评审(owner 拍板:转问自动、牵线两边点头、点头即成朋友;匿名层退役)
上游:`docs/superpowers/specs/2026-09-04-social-architecture-rethink.md` §3 步 6;`2026-09-04-wish-postcard-design.md`(1 跳)

## 0. 这轮要解决的事,以及为什么它很小

1 跳做完之后,心愿只能发给已有信道的朋友,认识新人只剩 6 位配对码。「介绍」补上第二条入口:**朋友的伙伴替我问它的朋友,对方答了、两边都想认识,就直接成为朋友。**

它不是新子系统。传输已经统一成信封,配对已经会开信道,所以介绍 = 把「心愿的转问」和「配对的名片交换」接在一起,再加一个人点头的门。旧的 2 跳中继(social_relay、内容盲转发、揭晓状态机)上一轮删掉了,**不重建**。

三个拍板决定的后果:
- 转问自动 → A 的主人只被告知,不审批。
- 牵线要两边点头 → 唯一的人工门在 B(被介绍的那一方)的主人手里;发起方点头体现在「我要认识 TA」这个动作本身。
- 点头即成朋友 → 名片一交换就是 peer(注册表 + 信道),中间没有「有信道但不知道是谁」的状态。关系视图里的 `anon` kind 只剩历史行。

## 1. 转问(hop 2)

角色:**我**(发心愿的)→ **A**(我的朋友,介绍人)→ **B**(A 的朋友,我不认识)。

- A 的伙伴收到 hop 1 的 `wish`,先照 1 跳的流程判官。**判「不能」才转**(默认;能帮就自己帮,朋友的朋友是兜底,也避免一条心愿在朋友圈里炸开)。
- 转的对象:A 自己的 primary 信道(`primaryChannels`)**排除来源信道**;载荷同一个 `wishId`、同一段 `text`、同一个 `expiresAt`,加 `hop: 2`。
- 预算:复用 `src/core/forward-budget.ts` 的 `makeForwardBudget({ perSender: 3, windowMs: 24h }).withinBudget(来源信道 id)`。超了就只答自己那份,日志一行。
- **hop 封顶 2**:收到 `hop: 2` 的 B 照常判官、回 postcard,**永不再转**。`parseWishPayload` 只接受 `hop ∈ {1, 2}`(缺省 1)。
- A 记一条转问索引 `<stateDir>/companion/introductions.json`:
  ```ts
  { forwards: { [wishId]: { from: string /* 来源信道 */; to: string[]; at: string } } }
  ```
  14 天过期;`readJsonFile` 读,写法同 `neighbors.json`。
- A 的主人被告知一句(替代 1 跳的「我说不知道」):「🙋 X 的伙伴来打听「…」,我答不上,帮着问了 N 个朋友」。
- 幂等:B 侧的 `wishes-seen.json` 键仍是 `wishId:信道`,天然去重;A 侧同一 wishId 只转一次(索引里有就不再转)。

## 2. 回声原路返回

- B 的 postcard 到 A:A 查 `forwards[wishId]`。是转问来的 → 转给 `from` 信道,载荷加 `hop: 2`、`replyId`(A 生成的随机 8 hex,后面牵线用它指代这张明信片而不暴露 B);A **不入日志、不打扰主人**(那不是 A 带回来的)。不是转问来的 → 走 1 跳的正常路径。
- A 在索引里记 `replies: { [replyId]: { wishId, fromChannel: B 的信道, at } }`。
- 我这边收到 hop 2 的 postcard:照常 `acceptPostcard` + 进 journal,但 `peerLabel` = 「<A 的 label> 的朋友」,微信一句话同理;**不出现 B 的任何身份**。journal 行的 `note` 前面不加东西,`title` 用「A 的朋友 回了你的心愿」;`replyId` 和 `via` 信道存进 `wishes.json` 该 wish 的 `postcards[]`(`{ replyId, via, at, text 前 40 字 }`),供「认识」引用。

## 3. 牵线:两边点头 = 一次经介绍人代递名片的配对

新信封 kind `intro`,一个 payload 三个 stage:

```ts
interface IntroPayload {
  stage: 'request' | 'forward' | 'accept' | 'decline' | 'card'
  replyId: string            // 指代那张明信片
  wishId: string
  card?: PairCard            // 只在 request(我→A)、card(A→双方)里出现
  hint?: string              // forward 阶段给 B 主人看的一句:心愿脱敏文本前 40 字
}
```

流程(每一步都是一封信封,都走已有信道):

1. **我 → A `request`**:主人微信「认识 <replyId 前缀>」或桌面心愿区里那张心愿下 hop 2 明信片旁的「想认识 TA」按钮(不在 journal 的明信片卡上,只在心愿列表这一份,只对 draft/open 状态的心愿可见,已关闭的心愿只能走微信「认识 <ref>」)→ 我的伙伴查 `wishes.json` 找到那张 hop 2 明信片的 `via` 信道和 `replyId`,发 `{ stage:'request', replyId, wishId, card: 我的名片 }` 给 A。名片就是配对用的 `PairCard` v2(self_id、name、信箱地址与公钥、信道句柄、bearer)。A 是我朋友,早就认识我;A **先收着**,不转。
2. **A → B `forward`**:A 查 `replies[replyId]` 找到 B 的信道,发 `{ stage:'forward', replyId, wishId, hint }`。**不带我的名片。** A 在索引里记 `pending: { [replyId]: { requesterChannel, requesterCard, targetChannel, at } }`。
3. **B 的主人点头**:B 的伙伴收到 `forward`,存 `<stateDir>/companion/introductions.json` 的 `offers: { [replyId]: { viaChannel, hint, at } }`,微信一句:「🤝 <A 的 label> 的朋友(就是问「<hint>」那位)想认识你。回「同意 <replyId 前缀>」或「不了 <replyId 前缀>」」。桌面心愿区多一个「待你点头」小列表(同一份数据)。这是**唯一一处人点头**。
4. **B → A `accept`**(带 B 的名片)或 **`decline`**。7 天没回 = decline(A 侧索引过期即视为拒绝,给我一句话)。
5. **A 交叉转发 `card`**:收到 accept 后,A 把 B 的名片发给我、把我的名片发给 B(两封 `{ stage:'card', replyId, wishId, card }`),然后清掉 `pending[replyId]`,并告诉自己主人一句「🤝 我把 X 介绍给了 Y」。收到 decline → 只给我转一句「A 的朋友这次不想认识新朋友」,清 pending。
6. **双方各自 `adoptPeerCard(card, mine, nonce = replyId)`**:和 6 位码配对完全相同的动作——写注册表(transport mailbox,bearer 交叉)+ 开 `intro:<replyId>` 的信道行(两侧行 id 一致)+ 关系视图立刻是 peer。之后信件、串门、心愿全部直连,不再经 A。双方主人各一句:「🤝 你和 <名字> 成了朋友(经 <A> 介绍)」。

`card` 字段的 `role`(`initiator` / `acceptor`)只是沿用配对码的名片格式:request 那边发 `initiator`、accept 那边发 `acceptor`,介绍流程里不认它、不靠它分支。

**我方名片什么时候生成:** 发 `request` 时生成密钥对和 channel_id,存进 `wishes.json` 该 postcard 的 `myIntro: { channelId, pubkey, privkey, at }`;收到 `card` 时用它开信道。B 方同理存在 `offers[replyId].myIntro`。私钥永远不出机器。

**安全边界:**
- B 点头前只看到 `hint`(脱敏心愿前 40 字)和「A 的朋友」;我点头前只看到 B 的明信片文字和「A 的朋友」。名片只在双方都点头之后经 A 交叉。
- A 短暂持有两张名片(都是朋友,且原本就能在 A 的注册表里看到)。A 不能篡改名片内容 —— 名片进信封前由发出方签名?**不做**:A 是双方都信任的朋友,这轮不防介绍人;写进 §8 待办。
- `adoptPeerCard` 里的 `id_conflict` 检查照旧:名片 self_id 撞上注册表里另一个 mailbox 地址 → 拒收 + 日志 + 告诉主人「介绍失败:身份冲突」。

## 4. 匿名层退役

- 点头之前,对方在我这里只是 `wishes.json` 里一张带 `replyId` 的明信片;点头之后直接是 peer。**没有中间态**。
- `relationships.ts` 的 `anon` kind 保留类型和渲染(旧揭晓流程可能留下历史行),不再有新的产生;注释说明。
- 上游 spec 里「anon → peer 迁移」「内容盲中继」两项:以这轮的形状**关闭**,不实现。

另一处预算(和 §1 的转问配额是两回事):被介绍方一条来源信道(A → B 那条)同时最多压 `FORWARD_PER_SENDER`(3)笔还没点头的 `offers`;超了的 `forward` 直接丢,**不打扰主人**,等其中一笔被点头(同意/不了)腾出名额再说。

## 5. 改动清单

| 层 | 改 |
|---|---|
| `src/core/wish.ts` | `WishPayload.hop?: 1\|2`(缺省 1,其它值 → null);`PostcardPayload.hop?`、`replyId?`;`WishRecord.postcards?: Array<{ replyId, via, at, preview }>`、`myIntro?` |
| `src/core/intro.ts`(新,纯) | `IntroPayload` + `parseIntroPayload` / `introEnvelope`;`introductions.json` 的三张小表(`forwards / replies / pending / offers`)的纯函数:记、查、过期清理(14 天) |
| `src/daemon/companion/intro-memory.ts`(新) | `introductions.json` 读写(`readJsonFile`) |
| `src/core/pairing.ts` | 抽出 `export function adoptPeerCard(deps, card, mine, nonce, rowPrefix: 'pair'\|'intro')`(= 现有 `writePeerFromCard` + `openPairChannel`),`makePairing` 内部改为调用它;`ownCard` 同样抽成 `buildOwnCard(deps, role, nonce, bearer, chan)` 导出 |
| `src/daemon/bootstrap/wire-wish.ts` | `handleWish`:判「不能」且 hop 1 → 转问(预算、索引、A 主人一句话);`handlePostcard`:先查转问索引,是则原路转回并记 reply,否则照旧,hop 2 时 label = 「<A> 的朋友」+ 记 `postcards[]` |
| `src/daemon/bootstrap/wire-intro.ts`(新,照 wire-visit 的形状) | `makeIntro(deps)`:`request(replyRef)`、`accept(replyRef)`、`decline(replyRef)`、`onInbound(channelRowId, env, letterId)`(五个 stage 的状态机)、`offers()`;deps 注入 `adopt`、`buildCard`(名片采纳/构造是 wire-social 拼好的闭包,包着 `adoptPeerCard`/`buildOwnCard`,这里不认识 `registry`)、`genChannel`、`channelStore`、`sendEnvelope`、`notifyOwner`、`peerLabel`、`holdBusy`、`now`、`log` |
| `wire-social.ts` | `switch (env.kind)` 加 `case 'intro'`;构造 `intro`;`social.intro` 露出 |
| `command-router.ts` | 「认识 <ref>」「同意 <ref>」「不了 <ref>」三条(admin 门,和 派/取消 同形) |
| internal-api | `POST /v1/social/intro/request {reply_id}`、`/accept`、`/decline`、`GET /v1/social/intro/offers`(trusted) |
| 桌面 | 「想认识 TA」按钮在心愿区、跟着 hop 2 明信片(心愿的 `postcards[]`,带 `reply_id`)一起渲染,不在 journal 的明信片卡上;「待你点头」列表同样在心愿区(同一份数据) |
| relationships.ts | 有信道且 known 的 peer:信道行 id(`ch.id`)以 `intro:` 开头 → 「经朋友介绍」,`pair:` 开头(及其它旧行)→「配对」 |

**不新建表**:所有状态在 `wishes.json` / `introductions.json` / `penpal_letter` / 注册表 / `penpal_channel`。

## 6. 微信与桌面文案(全部)

| 时刻 | 谁 | 一句话 |
|---|---|---|
| A 转问 | A 主人 | 🙋 X 的伙伴来打听「…」,我答不上,帮着问了 N 个朋友 |
| hop 2 明信片到我 | 我 | 📮 A 的朋友 回了你的心愿「…」:<text>(想认识就回「认识 <replyId 前 6 位>」) |
| B 收到 forward | B 主人 | 🤝 A 的朋友(就是问「<hint>」那位)想认识你。回「同意 <ref>」或「不了 <ref>」 |
| 成交 | 我 / B | 🤝 你和 <名字> 成了朋友(经 <A> 介绍) |
| 成交 | A 主人 | 🤝 我把 X 介绍给了 Y |
| 拒绝 / 超时 | 我 | A 的朋友这次不想认识新朋友 |
| 身份冲突 | 出错方 | 介绍失败:对方身份和已有联系人冲突 |

## 7. 测试

| 单元 | 测什么 |
|---|---|
| `intro.ts` 纯函数 | payload 解析(五个 stage、缺字段、card 只在 request/card 出现);索引增删查、14 天过期;`hop` 解析 |
| `intro-memory` | 空 / 坏文件 → 空;往返;BOM |
| `adoptPeerCard` | 从 `makePairing` 抽出后,现有 pairing 测试全绿;`intro:` 前缀行 id;`id_conflict` |
| 三个 daemon 同进程(照 `wire-wish.test.ts` 的 `side()`,扩到三方) | 我派 → A 判「不能」→ 转给 B → B 判「能」→ postcard 经 A 回我(label「A 的朋友」,journal 一条,`postcards[]` 一条)→ 我「认识」→ A forward → B 主人一句 → B 同意 → A 交叉名片 → 我和 B 各一条 `intro:<replyId>` open 信道、注册表互有对方、两边主人各一句、A 主人一句 |
| 分支 | B 拒绝 → 我一句话、无信道;A 预算耗尽 → 不转;hop 2 的 wish 到 B 后 B 不再转;A 判「能」→ 不转;同一 wishId 重投 A 只转一次;`request` 找不到 replyId → 主人一句「没有这张明信片」;pending 过期 → 视为拒绝 |
| 路由 / 命令 | 四条路由形状 + tier;三条微信命令的解析与文案 |
| 桌面 | 心愿区里 hop 2 明信片旁有按钮、hop 1 没有(且只对 draft/open 心愿渲染);待点头列表渲染与两个动作 |

真机:三台才能全走一遍(我 / A / B)。两台(Mac / Windows)只能验到「A 判不能就转」+ 预算 + 索引;完整链路先靠同进程三方测试,三台真机留待有第三台时。

## 8. 明确不做 / 待办

- 3 跳;B 主动发起(只有发心愿的人能说「认识」);A 的主人审批;转问「一律转」(默认「答不上才转」,想改是一行常量)
- 名片签名防介绍人篡改(A 是双方的朋友;记为待办)
- 桌面富交互(先微信 + 最小按钮)
- 旧 anon 行的迁移(保留原样)
