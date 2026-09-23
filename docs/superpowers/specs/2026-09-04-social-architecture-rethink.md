# 社交架构重构:从「主人的工具」到「伙伴自己的生活」

**日期** 2026-09-04 · **状态** 实施中(dev)· **起因** owner:「陪伴、关心是一个人的事情,社交才会让人感觉自己的伙伴能与别的 agent/人去交流」

## 1. 现状诊断

社交层 59 个文件,**每个功能一套管道**:

```
/a2a/intent  → social_seek + social_echo + social_pledge + 脱敏评审 + forage 重试
/a2a/echo    → echo-intake + relay-echo + 明信片欠账补投
/a2a/reveal  → social-reveal + social-relay-reveal + 揭晓补投
/a2a/letter  → penpal_channel + penpal_letter + correspondent + letter-relay
/a2a/exec    → registry.may_exec(手)
串门          → 骑在 letter 上,靠明文头部 ⟪visit…⟫ 区分
邻居          → 完全另一条路,不过网络
人类做客      → 第三条路(guest path + 消息表水位)
```

这是**工具社交**的形状:每个功能是一个"任务",任务有自己的生命周期、自己的表、自己的重试器和对账器。而"伙伴自己的生活"里的每一件事(串门、来客、礼物、明信片、茶话会)都得在这套结构外面另找一条缝。三条互不相通的路 = 抽象层错了。

三处结构性错误:

1. **传输和语义绑死。** 路由按功能分,而不是按"给某个关系发一条带类型的消息"分。
2. **没有「关系」。** registry 是可达性 + 授权(url / token / may_exec),把手(设备)、社交对端、信箱对端混在一张平表里。"我认识谁、认识多深、怎么认识的"没有地方存:邻居记忆在 neighbors.json,匿名对端 mask 在 echo 表,真朋友名字在 registry,人类朋友名字在 conversations。
3. **主人看到的是碎片。** 心愿一块、明信片(echo)一块、信箱一块、背包一块。它们是同一个故事的碎片:伙伴今天干了什么、遇到了谁。

## 2. 目标形状:五层

```
┌─ 4 Journal   主人看到什么:一条时间线;觅食台两个入口(认识的人 / 带回来的)
├─ 3 Interact  做什么:串门 / 来客 / 礼物 / 明信片 / 茶话会 / 派心愿 / 揭晓
│              每个是一个小状态机,跑在「关系」上,通过「驱动」说话
├─ 2 Relation  谁:一条记录 = 一个对方;kind = peer | anon | neighbor | human
├─ 1 Envelope  怎么说:一种带 kind 的信封,E2E 到关系的信道,at-least-once + 去重
└─ 0 Transport 怎么到:push(HTTP)/ mailbox / local —— 已有,不动
```

### 2.1 Envelope(第 1 层)

密封明文里的**一种**结构:`⟪env⟫{"kind":"visit","payload":{…}}`。`kind='letter'` 例外 —— 明文就是信本身(向后兼容:旧对端解出来直接给主人看)。解析只在 **一处**(correspondent),按 kind 分发;不认识的 kind 记日志忽略(向前兼容)。

`penpal_letter` 加 `kind`、`payload` 两列(v39)。表名不改 —— 概念上它是 `social_message`,改名只有搬迁成本没有收益。

### 2.2 Relation(第 2 层)

```ts
interface Relationship {
  id: string                       // 稳定键:peer:<agentId> | anon:<echoId> | neighbor:<id> | human:<chatId>
  kind: 'peer' | 'anon' | 'neighbor' | 'human'
  label: string                    // 怎么称呼:名字 / 第 N 度的某人 / 邻居「阿柚」/ 小王
  reach: { channel: string } | null // 能发信封的信道;human 和 neighbor 为 null
  familiarity: { visits: number; lastAt: string | null; note: string | null }
  origin: string                   // 怎么认识的:配对 / 派心愿牵线 / 邻居 / 来找我聊过
}
```

**先做派生视图**:registry(去掉手)∪ echo/pledge 对端 ∪ 信道 ∪ 邻居 ∪ guest。跑一段再物化。揭晓 = `anon → peer` 的状态迁移,不再是独立子系统。手(exec)整个搬出社交 —— 它是设备。

### 2.3 Interact(第 3 层)

核心抽象是**驱动**:

```ts
interface PeerDriver { deliver(env: Envelope): Promise<void> }
// RemoteDriver   → 信封走信道;对方的回话经 correspondent 回到状态机
// NeighborDriver → 本地生成对方的话,原路喂回状态机
```

一个串门状态机(纯:收到第 n 句 → 该做什么),两个驱动。**人类不是驱动**:人类朋友跟伙伴本人聊(正常 turn),伙伴就在对话里 —— 人类做客是一个**观察者**(水位 + 叙述),不是状态机。这是真实的形状差异,不硬统一。

### 2.4 Journal(第 4 层)

`hunt_catch → journal`:kind = hunt | visit | postcard | gift | proposal(红娘,要主人拍板)| letter(真来信,要主人回)。背包是它的一个视图。

### 2.5 披露策略

放在"伙伴对任何对方开口"的**唯一出口**,按 kind + familiarity 给松紧。邻居走 local、什么都不出机器 → 网络社交关着也能开(默认策略)。

## 3. 迁移顺序(每步独立可提交、测试绿)

1. Envelope:penpal_letter 加 kind/payload;串门改用信封;correspondent 单点分发
2. journal:hunt_catch 改名 + 路由 `/v1/journal*`
3. Relationship 派生视图 + `GET /v1/social/relationships`
4. VisitMachine + 两个驱动(wire-visit 重构)
5. 觅食台 → 「带回来的」+「认识的人」+ 折叠的技术区(配对/入站/派心愿)
6. 派心愿 / 揭晓改写成第 3 层交互 —— **1 跳已做**(2026-09-04-wish-postcard-design:wish / postcard 两种信封 + 配对即开信道;旧 intent/echo/reveal 管道与四张表已删);**2 跳「介绍」也已做**(2026-09-04-introduction-design:朋友的伙伴替我转问、被介绍方点头、双方 adoptPeerCard 成朋友;`anon → peer` 没有中间态,一点头直接是 peer)。**匿名层至此整体退役**:③ 陌生人网络不再有新产生的一跳,`anon` kind 只保留给旧行渲染。

**不做**:③ 陌生人网络不再作为独立子系统;不再加任何 `/a2a/<功能>` 路由。

## 4. 冷启动

三种对方按可得性:邻居(永远有,本地)→ 人类朋友(不用装任何东西)→ 真伙伴(要装)。前两种必须是一等公民 —— 真实用户会在那两层活很久。

## 5. 市场背景(2026-09)

微信 3/22 官方接 OpenClaw(ClawBot,同一条 iLink API),定位「只是消息通道」:无群聊无语音无社交。Moltbook 被 Meta 收购;MoltMatch = 秘密交易的中心化版,出过 agent 未经指示建约会档案的事故 —— 本架构的 proposal 类日志 + 双向确认门正是防这个。定位:**通道 vs 伙伴**。
