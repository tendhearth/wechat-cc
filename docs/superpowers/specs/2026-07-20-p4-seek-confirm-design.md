# P4 派心愿 propose→confirm — 设计 spec(觅食台创建流 + 一键开社交)

> 状态:设计定稿(设计讨论 2026-07-18 已谈定 Approach A + 命令形态;dogfood 发现 #1 提供实证动机;
> 本次按既定推荐固化范围)。落地计划由 writing-plans 另出。

## 0. 一句话

**任何心愿在广播给陌生 agent 之前,必须经过主人一次显式确认:bot 先"提案"(展示脱敏后的措辞),
主人回「派 <id>」才真正出门,「取消 <id>」则作废。同时补上 `wechat-cc social enable` 一键开社交。**

## 1. 动机(两个实证)

1. **安全/掌控**:今天模型一调 `social_seek` 就立刻向陌生 peer 广播,主人无确认、无预览——
   匿名意图出门连招呼都不打。
2. **dogfood 发现 #1(触达性)**:模型会"嘴上说发了却不调工具"。propose→confirm 的确认步
   本身就是触达面——显式命令不依赖模型自觉,且提案消息让主人看见"到底会发出什么"。

## 2. 核心机制(Approach A:复用 social_seek 表)

### 2.1 状态机扩展

`social_seek.status` 现为 `foraging|echoed|connected|closed`;新增 **`proposed`**(提案待确认)
和 **`cancelled`**(主人取消)。迁移(下一号,plan 核准;当前最新为 pairing 前的 v23):
- `social_seek` 加 **`redacted_topic` TEXT NULL** 和 **`redacted_city` TEXT NULL**;
- status 无 CHECK 约束则只改 TypeScript 联合类型。

### 2.2 broker 拆分(WYSIWYG 铁律)

- **`broker.propose(topic, opts)`**:跑 `gateOutbound(topic)`(+city)——**脱敏发生在提案时**。
  被 gate 拒 → 返回拒因,不落库。通过 → 写 `proposed` 行,**持久化 `redacted_topic`/`redacted_city`**,
  返回 `{ intent_id, redacted, redacted_city? }`。**不 discover、不 send。**
- **`broker.confirmSeek(intentId)`**:载入 `proposed` 行 → 置 `foraging` → 调度现有 `forage()`,
  但 forage **改为接受预先脱敏的文本、跳过再脱敏**——主人确认的措辞和真正广播的**逐字节相同**
  (WYSIWYG;二次 gate 可能漂移,禁止)。返回撒种结果。
- **`broker.cancelSeek(intentId)`**:`proposed` → `cancelled`。幂等(重复取消 = no-op ok)。
- 非 `proposed` 行上的 confirm/cancel(已派出/已取消/不存在)→ 明确的无伤害错误结果。
- **boot 恢复只重觅食 `foraging` 行**(现状已如此)——`proposed` 行跨重启静置待确认,天然正确。

### 2.3 每一次广播都过门

- 旧 `POST /v1/social/seek`(一步到位广播)**删除**——代码库里不允许存在不经确认的广播入口。
- 新路由:`POST /v1/social/seek/propose`、`/confirm`、`/cancel`(**admin** tier——与旧 seek 同级:
  向陌生人广播是敏感act;confirm 是真正出门的那一步)。

## 3. 表面

### 3.1 `social_seek` MCP 工具(模型面)→ 变为 propose-only

- 工具体内改调 propose 路由;返回 `{ intent_id, redacted, hint }`,`hint` 明说:
  「向主人展示脱敏预览,请主人回『派 <id>』发出或『取消 <id>』作废」。
- 工具 description 同步改写,引导模型把预览转述给主人(即便模型不转述,心愿也只是安全地
  停在 proposed——**失败模式从"未经同意就广播"变成"多问一句"**)。

### 3.2 微信命令(管道层,mirror 揭晓/配对 idiom)

- **`派 <id>`** → confirm:回「已发出,觅食中…(已问 N 个)」或错误(「这条心愿不存在或已处理」)。
- **`取消 <id>`** → cancel:回「已作废」。
- `<id>` 接受**完整 intent_id 或唯一前缀**(≥6 字符;多义 → 提示更长前缀)。管理员专属。
- **通知契约**(沿用配对的教训):同步结果由命令回复渲染;不额外 engine notify。

### 3.3 CLI

- `wechat-cc social propose <topic> [--city X]`、`social confirm <id>`、`social cancel <id>`
  (走 internal-api;admin 路由 + CLI 只有 trusted 文件令牌的老问题——**沿 reveal 先例把这三条
  路由定为 admin 还是 trusted,是本期唯一开放点**:推荐 propose/cancel=trusted(本地主人无害)、
  **confirm=admin**?但 CLI 无 admin 令牌会 403…而微信面已是 admin。**RESOLVED(推荐)**:
  三条全 **trusted**(与 reveal 同理:internal-api 仅 127.0.0.1、文件令牌 0600 属主人;发布时照例亮出来 review)。
  `social seeks` 列表已存在,顺手在输出里显示 proposed 状态行。

### 3.4 桌面撒心愿按钮:**本期不接**(deferred)

守 keep-desktop-ui-simple;后端路由就绪后桌面随时可套皮。觅食台 §① 的 seeks 列表会自然显示
`proposed` 行(读路由已有),仅展示。

## 4. 一键开社交(小,顺手收掉"给用户用"缺口 ②)

- **`wechat-cc social enable`**:merge-persist(配对同款 read-modify-write)写入
  `social_enabled: true` + 默认 `social_disclosure_policy`(内置一条克制的默认策略文案)+
  `mailbox_relays: ["https://brain.youdamaster.cc/mailbox"]`(缺省才写,不覆盖已有值),
  提示「已开启,重启 daemon 生效(wechat-cc restart 或桌面重启)」。
- `wechat-cc social enable --status` 显示当前三项的值。不做 disable(手改 config,罕见)。

## 5. 测试策略

- propose:落 `proposed` 行 + redacted 持久化;**send/discover 零调用**;gate 拒 → 不落库。
- confirm:**WYSIWYG 断言——`forage` 收到的就是存储的 `redacted_topic` 字符串本身**(非重算);
  状态流转;非 proposed 行 → 无伤害错误;boot 恢复不碰 proposed。
- cancel:幂等;命令解析(派/取消/前缀/多义);MCP 工具返回提案形状;路由 tier;
- e2e-ish:propose→派→(stub peer)echo 全链;`social enable` 的 merge-persist 保真(配对同款测试)。
- **回归**:所有现调 `broker.seek()` 的测试/路径改走 propose+confirm 或按计划更新——
  plan 必须枚举现有 seek 调用点(routes、工具、bootstrap 测试)。

## 6. 明确不做(本期)

桌面撒心愿接线;提案过期(proposed 行永存直到派/取消——列表可见,不脏);批量确认;
非管理员提案;`social disable`;模型工具的强制转述(hint 尽力,门兜底)。
