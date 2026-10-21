# SpeechPolicy:CC 开口只有一道门(第三批 3a,设计稿)

> 来源:[架构复查 10-21](../../architecture-review-2026-10-21.md) 理念 3。主人 10-21 让我自己定;这份写完给整合那一路(9d)审,再动代码。

## 为什么

CC 有九条路会在没人问它的时候开口,每条路自己判能不能说。复查量出来的结果:

| # | 路 | 免打扰 | care 档 | 频率 | 微信降级 |
|---|---|---|---|---|---|
| A | 伙伴一拍:到点的事、打猎、问候、串门 | 看 | 看 | 看 | 走 App |
| B | 来访叙述 | ~~不看~~ #506 已补 | ~~不看~~ #506 已补 | 有水位 | 丢掉,直接调 ilink |
| C | 新贴纸 | 不看 | 不看 | 22 小时 | 照发,直接调 ilink |
| D | 定时任务、周报 | 不看 | 不看 | 每天上限 | 走 App |
| E | 晨报 | 不看 | 不看 | 记台账 | 走 App |
| F | 信 | 看 | 不看 | 自己的日程 | 走 App(自己写的一套) |
| G | 夜里整理记忆的通知 | 不看(用最早几点代替) | 看 | 20 小时 | 等着,直接调 ilink |
| H | 提醒 | 不看(合理) | 不看(合理) | 退避 | 走 App |
| I | 一件事做完的回报 | 用「主人正忙就先压着」代替 | 不看 | 退避 | 一直重试,直接调 ilink |

另外还有两处直接调 ilink:「定时审阅错过了」的通知、CLI 升级完的通知。

**问题不在某一条判错了,在于没有一个地方能回答「此刻 CC 能不能开口」。** 每加一条新路,都要自己想起来抄哪几道闸。B 就是没想起来的那一条:主人说了「别烦我」,朋友来过以后 CC 照样开口。

## 同类产品怎么做

- **iOS 通知的打断级别**(`UNNotificationInterruptionLevel`):应用只声明这条通知是 passive / active / time-sensitive / critical。专注模式下能不能打断,由系统统一判;只有 time-sensitive 以上能穿过专注模式,而且用户能在设置里收回这个权限。
- **Android 通知渠道**:每类通知先声明一个渠道,重要程度和免打扰例外都挂在渠道上,用户按渠道关。应用发通知时只说「我是哪个渠道」。
- **OpenAI dots、Meta Muse 这类常驻助理**:「主动」好不好,大半在分寸。分寸是产品的一部分,不是每个功能自带的细节。

我们照这个形状做。**每条路只声明「我是哪一类话」;能不能说、什么时候说、走哪条通道,由一处来定。**

## 设计

### 1. 一张话的种类表(单一声明)

`src/core/speech/kinds.ts`:

```ts
export type SpeechOrigin = 'requested' | 'report' | 'initiative'
export const SPEECH_KINDS = {
  reminder:        { origin: 'requested',  label: '提醒' },
  job:             { origin: 'requested',  label: '定时任务' },
  matter_report:   { origin: 'report',     label: '一件事的回报' },
  review_missed:   { origin: 'report',     label: '定时审阅错过了' },
  upgrade_notice:  { origin: 'report',     label: '升级完成' },
  brief:           { origin: 'initiative', label: '晨报' },
  recap:           { origin: 'initiative', label: '周报' },
  letter:          { origin: 'initiative', label: '信' },
  companion:       { origin: 'initiative', label: '伙伴' },      // 到点的事 / 打猎 / 问候 / 串门
  guest_visit:     { origin: 'initiative', label: '来访' },
  sticker:         { origin: 'initiative', label: '新贴纸' },
  memory_notice:   { origin: 'initiative', label: '整理记忆' },
} as const satisfies Record<string, { origin: SpeechOrigin; label: string }>
```

**origin 跟着种类走,调用方不能自己传**,所以没有哪条路能把自己说成 requested 来绕过闸。

**归类的准绳**(9d 评审 #507):看这一句的**内容**是不是主人点名要的,不看开关是谁开的。
- `requested`:内容是主人点名的,时间也是他定的,比如提醒、「每天 9 点看邮箱」。对应 iOS 的 time-sensitive。
- `report`:主人交办的事有了结果,CC 来回话。内容 CC 定,起因是主人。
- `initiative`:CC 自己挑内容。晨报的开关是主人开的,但内容是 CC 挑的,所以算这一类。

### 2. 判定:一个纯函数

`src/core/speech/decide.ts`:

```ts
decide(req: { kind; chatId; nowIso }, ctx: { care: CareLevel; inQuiet: boolean; quietEndsIso?: string;
  deliverable: boolean; perKind?: { ok: true } | { ok: false; reason: string } })
  → { allow: true } | { defer: true; until?: string; reason } | { drop: true; reason }
```

| | requested | report | initiative |
|---|---|---|---|
| care off(别烦我) | 照说 | 照说 | **drop** `care_off` |
| 免打扰时段 | 照说 | **defer** 到时段结束 | **defer** 到时段结束(定时的那几样见下) |
| 每种自己的频率(现在的 `shouldSpeak` 冷却、22 小时、20 小时……) | 不看 | 不看 | 看,不过 ⇒ drop |
| 微信降级、App 也收不到 | **defer**,不重试、不调模型(no-retry-storm) | 同左 | 同左 |

- **定时触发的 initiative**(晨报、周报)赶上免打扰:当天记 `skipped:quiet`,不往后推。定时运行器只在到点后有 10 分钟窗口,推到时段结束会悄悄变成 `missed`;记成 `skipped:quiet`,主人在定时列表里看得见为什么没发。这比「晚了几小时再发晨报」诚实。
- **care off 时,initiative 的内容算看过**:来访推进水位,到点的事不打勾也不补发。打开之后不翻旧账,跟 #506 一致。
- 频率仍由每种自己的规则判(`perKind`),表里不重写那些冷却。这一步只把「哪几道闸适用」收成一处,不改每种的节奏。

### 3. 一个出口:想说话只能经过它

`src/daemon/speech/policy.ts`:

```ts
policy.say(req, async (turn: ProactiveTurn) => { /* 产出并发送 */ }) → Promise<SpeechOutcome>
```

- 先 `decide`。是 allow 才 `proactiveOutbound.open(chatId)` 拿到一轮,交给生产者;发完 `turn.finish()`。
- 生产者拿不到别的发送原语,直接调 ilink 的那几处(B、C、G、I 和两处通知)全部改走这里。微信降级时一律由 `proactive-channel` 选 App,不再有五种分支。
- **贵的事放在判定之后**:要调模型的生产者(伙伴、来访、晨报)在 allow 之后才调。被拒、被推后都不花模型。
- **外发账**:每次判定写一行 `speech_log`(SQLite,一张新表),字段是 kind、origin、chatId、结果(allowed / deferred / dropped + reason)、channel、ts。用来回答「CC 昨天为什么说了这句、为什么没说那句」。「你不在的这 N 小时」和日报直接读它。只记种类和原因,不记正文。

### 4. 守卫(交给机器)

- 扫 `src/daemon`、`src/core` 里的 `ilink.sendMessage(` 和 `sendWechat(` 调用点,只许出现在三处:`speech/policy.ts`、`proactive-channel.ts`、回复交付(`reply-delivery` / `turn-reply`,回复是被问的那一句,不属于主动开口)。再多一处就红。
- `SPEECH_KINDS` 的每一种都至少有一个 `policy.say({ kind: '…' })` 调用;每一个 `say` 的 kind 都在表里(类型保证)。
- 一张一致性测试:每个 origin × {care off, 免打扰, 降级} 的结果钉死在上面那张表上。

## 分几步合(每步单独能合、单独能回滚)

1. **只加不接**:`kinds.ts` + `decide.ts` + 一致性测试 + `speech_log` 迁移 + `policy.say`。不改任何调用方,行为不变。
2. **直接调 ilink 的六处**改走 `say`(B、C、G、I、审阅错过、升级通知)。行为变化:微信降级时这几条改成走 App,不再丢掉或一直重试。I 的「主人正忙就先压着」保留,作为它的 `perKind`。
3. **D、E、F**(定时任务、周报、晨报、信)改走 `say`。行为变化:晨报、周报、信开始认 care off 和免打扰。**主人这台核对过**:主人那条对话没设 care 档(默认 low),也没设免打扰,所以对他没有变化。
4. **A 伙伴一拍**改走 `say`,`shouldSpeak` 退成伙伴的 `perKind`。`pushTickForChat` 里那两道手写的闸删掉。
5. 守卫上线。顺带把 `tick-bodies.ts`(1303 行)按生产者拆开(伙伴 / 来访 / 吸收 / 内省那一包),文案移到 `prompts.ts`。全树 7 处 `?? 'Asia/Shanghai'` 的死代码一起删。

## 明确不做

- **不加全局「每天最多几句」的上限。** 现在每种有自己的节奏,合起来一天会说几句没量过。先让 `speech_log` 记上一周,看真数据再定要不要加、加多少。上限会让某句话被挤掉,那是产品决定,不能凭猜。
- **不做排队补发。** 被 defer 的话不进队列,生产者下一拍自己再问。现在每条路都有自己的「下一拍」,加一个队列就多一份状态、多一个会出错的地方。
- **不改回复那条路。** 回复是被问到的,不经过这道门。

## 要 9d 看的

- 三类的归法,和「定时的 initiative 赶上免打扰记 skipped:quiet」这一条。
- 守卫允许直接发送的那三处,够不够、有没有漏。
- 第 2 步里 I(一件事的回报)改走 App 的行为变化。它在你那块(工作台),要你点头。
