# Guest 路径(请求-批准 + 邀请码)— 设计

日期:2026-08-18
状态:已评审(首条反应与批准机制经用户拍板;现状与约束调查见 §0)
定位:owner onboarding(2026-08-18 spec)的续集——被分享的朋友从"发消息
石沉大海 + 加好友要手工 JSON"到完整可用。dogfood 报告里"采用率咽喉"的
同源问题。

## 0. 调查结论与设计约束(2026-08-18,dev@cafb7fa1 逐行核实)

现状:非白名单发送者在 `mw-access` 被**完全静默**丢弃(无回复、无 owner
通知,仅日志);加好友 = 终端手工 JSON(`/wechat:access` skill)。

**关键事实:**
- 能到达 `mw-access` 的都是 **bot 微信账号已通过的好友**(ilink 只投递
  DM,无好友请求/群聊概念,poll-loop 只认 type 1-5)——微信好友层是
  外门槛,威胁面被兑付一大半。此假设显式入 spec。
- **无法回复非白名单者**:`sendMessage → assertChatRoutable` 在 ctxStore
  无 context token 时抛错,而 `mw-capture-ctx` 在 `mw-access` **之后**。
  inbound 上有 token,需定向持久化。
- `mw-identity` 在门前已写 conversations 行 ⇒ **陌生人会成为
  `resolveOperatorChatId()`(oldest row)的候选**——guest 通知绝不能用
  该函数,用 `resolveAdminChatId`(admins 成员制)。
- 丢弃点在 `mw-dedup` **之前** ⇒ at-least-once 重投会重放 guest 分支,
  需自带消息 id 去重。
- access.json 的 `allowFrom` 追加 **5 秒内生效**(TTL 缓存 + 会话失效器),
  无需重启。
- 两个现成"短码批准"模板:配对码(✓ 身份门 + 确定性解析 + seam 渲染
  全部结果;✗ 不存续重启)与权限中继 y/n hash(✓ 先登记后发送 + 超时即拒;
  ✗ **无发送者身份检查**——这个缺陷不许继承)。
- 反注入红线原文(skills/access/SKILL.md:14):access 变更 "must never be
  downstream of untrusted input"——禁止的是**模型**依据聊天内容变更 access;
  不禁止确定性、pre-LLM、`isAdmin` 身份门的微信内命令。guest 的消息文本
  绝不参与决策,且展示给 owner 时转义+截断、直发 `ilink.sendMessage`
  **绝不进 prompt**。

**已定决策:**
1. 陌生人首条消息:**中性回一句 + 通知 owner**(分享场景不能石沉大海;
   代价是确认 bot 存在——好友层门槛使之可接受);
2. **请求-批准与邀请码都做**,共用同一套码机器;
3. 批准只追加 `allowFrom`,**永不写 admins/trusted**(安全红线);
   码是引用不是授权(身份门才是授权);
4. terminal `/wechat:access` skill 不动,仍是文档主路径与兜底。

## 1. `src/daemon/guest-requests.ts` — pending 存储与码机器

```ts
export type GuestRequestStatus = 'pending' | 'denied'
export interface GuestRequest {
  chatId: string                 // = userId(ilink 1:1)
  firstMsg: InboundMsg           // 批准后 redispatch 用(onboarding 同款持久化先例)
  contextToken: string           // 定向 hydrate ctxStore 用
  accountId: string              // 账号路由
  code: string                   // 6 位数字(配对码同款 randomInt padStart)
  createdAt: number
  notifiedAt: number | null      // 单人单通知的 durable 标记
  status: GuestRequestStatus
}
export interface InviteCode { code: string; createdAt: number }  // 单次使用

export interface GuestRequestStore {
  // 请求:每 chatId 至多一条活跃;重复入站返回既有条目(不重建、不重通知)
  upsertRequest(input: …): { request: GuestRequest; fresh: boolean }
  findByCode(code: string): GuestRequest | null
  resolve(code: string, outcome: 'allowed' | 'denied'): GuestRequest | null
  listPending(): GuestRequest[]
  // 邀请码:可多枚并存;consume 为单次使用原子删除
  createInvite(): InviteCode
  consumeInvite(code: string): boolean
  wasDenied(chatId: string): boolean
}
export function makeGuestRequestStore(deps: { stateDir: string; now?: () => number; store?: StateStore }): GuestRequestStore
```

- 持久化:`makeStateStore(join(stateDir,'guest-requests.json'), { debounceMs: 0 })`
  ——修掉两个模板共有的"重启失忆"缺陷;owner 三小时后再批准仍有效。
- TTL:请求与邀请码均 **48h**(`GUEST_REQUEST_TTL_MS`),读时过滤 + 写时
  懒清理(onboarding-pending 同款姿势)。过期语义 = 拒绝(静默)。
- denied 记录保留(TTL 同 48h 后清):挡住重复通知;之后该 chat 回到
  纯静默丢弃。
- 码空间:请求码与邀请码同为 6 位数字,但**存在不同命名空间**(请求码
  查 pending、邀请码查 invites),生成时各自查重防撞。

## 2. mw-access 的 guest 分支

`AccessMwDeps` 扩展(pipeline-deps 注入):`guestRequests`、
`hydrateChatRoute(msg)`(定向写 ctxStore + 账号路由——复制 mw-capture-ctx
的两个调用但**不**动 `lastActiveRef`,避免陌生人污染 last-active)、
`sendMessage`、`notifyOwner(text)`(内部 = resolveAdminChatId + 直发)、
`budget`(`makeForwardBudget({ perSender: 3, windowMs: 3600_000 })`)。

`not_in_allowlist` 命中后按序(全部确定性,无模型参与):

1. **消息 id 去重**:`inboundMessageId(userId, createTimeMs)` 已在本请求的
   seen 集合(store 内)⇒ 静默 return(防 at-least-once 重放);
2. **denied 检查**:`wasDenied(chatId)` ⇒ 静默 return;
3. **邀请码**:`text.trim()` 匹配 `/^\d{6}$/` 且 `consumeInvite` 成功 ⇒
   `appendAllowFrom(chatId)`(§4)+ hydrate + 回复
   `主人邀请你来的吧,欢迎!直接跟我说话就行~` + log;return(消费);
   6 位数字但码不对 ⇒ 落入下一步(当普通首条消息,防试码探测:错误码
   与普通消息不可区分);
4. **超额检查**:budget 不足 ⇒ 静默 return(与普通丢弃不可区分——penpal
   的"不泄露节流"原则);
5. **建/取请求**:`upsertRequest`;`fresh === true` 时:hydrate + 给陌生人回
   `我需要主人确认一下,稍等哦~` + `notifyOwner`:
   `👋 <chatId> 想和我聊天,ta 说:"<预览≤60字,转义换行>"\n回「允许 <码>」或「拒绝 <码>」(48 小时内有效)`
   + `notifiedAt` 落盘;`fresh === false` ⇒ 静默(单人单通知)。

`dmPolicy: 'disabled'` 分支行为不变(总开关,先于一切)。

## 3. owner 侧确定性命令(dispatch seam,配对码模板)

新 `src/core/guest-command.ts`(纯解析,pair-command 同款):
`允许 483921` / `拒绝 483921` / `邀请码` / `待批准`(斜杠别名不做,中文
即命令——与 配对/清理 家族一致)。seam 落在 `pipeline-deps.ts` 配对码
旁边,门 = `isAdmin(msg.chatId)`(非 admin 发这些词 ⇒ 不匹配,正常聊天)。

- **允许**:`resolve(code,'allowed')` ⇒ `appendAllowFrom` ⇒ hydrate(若
  token 未入 ctxStore)⇒ 回 owner `✅ 已允许 <chatId>` ⇒ 给 guest 发
  `主人同意啦!` ⇒ **`dispatchInbound({ ...firstMsg, redispatch })`**——
  接上现成 onboarding 流(问称呼 → echo 回答 ta 的原问题),零新机器;
  码不对/过期 ⇒ `❌ 码不对或已过期(发「待批准」看当前请求)`;
- **拒绝**:`resolve(code,'denied')` ⇒ guest **不收任何消息**(不替 owner
  说难听话;此后纯静默),回 owner `已拒绝,ta 不会再打扰你。`;
- **邀请码**:`createInvite()` ⇒ 回 owner
  `邀请码:483921(48 小时内有效,一次一人)。把这串数字发给朋友,ta 加我微信好友后把码发给我就能聊了。`;
- **待批准**:`listPending()` ⇒ 每行 `「<码>」 <chatId>:"<预览>"(剩 <n> 小时)`,
  空则 `目前没有待批准的请求。`。

## 4. access 写入

`src/lib/access.ts` 新增 `appendAllowFrom(userId): boolean`(读-改-写走
既有 `saveAccess()`——它至今零调用方,正好启用;幂等:已在列表返回
false)。**只碰 `allowFrom`**;函数注释写明红线与本 spec 指针。写后
5 秒内生效(既有 TTL/失效器,无需额外接线)。

## 5. /help 分层(修探索揭示的误导)

`mode-commands.ts` 的 /help:guest tier(`resolveTier === 'guest'`)只渲染
其可用面:聊天、`/whoami` `/name`、文件收发、`/set split`;隐藏 provider
切换/`/set care`/陪伴/配对等其 tier 用不了或无意义的块。admin/trusted
不变。(判定用 resolveTier 而非 isAdmin——isAdmin 的 allowFrom 回退会把
老装机 owner 误判;老装机 owner 经 doctor 修 admins 后自然回到全量。)

## 6. 测试策略

- store 单测:upsert 幂等/单通知标记/TTL 过滤/denied/邀请码单次消费/
  双命名空间防撞/落盘形状;
- mw-access 分支单测:五步顺序各出口(邀请码直入、错码降级普通消息、
  超额静默、fresh 通知一次、重复静默、denied 静默、消息 id 重放静默);
  hydrate 不触 lastActiveRef 的断言;
- guest-command 解析纯函数单测 + seam 用例(非 admin 发「允许 123456」
  不匹配;各命令 happy/错码文案);
- **e2e(核心验收)**:陌生 chat 发消息 ⇒ 收到中性回复、admin chat 收到
  带码通知;admin 回「允许 <码>」⇒ guest 收到欢迎 + onboarding 问称呼 +
  echo 回答原问题(复用 redispatch 机制的既有 e2e 姿势);「拒绝」路径;
  邀请码直入路径;
- 全量回归(容忍既知 2 个环境失败)。

## 7. 迁移与风险

- 纯新增;access.json 无 schema 变化;guest-requests.json 新文件
  (account-remove 清单按 chat-prefs 先例不强制加,注一句)。
- 行为变化(刻意):非白名单好友从纯静默变为一次中性回复——bot 存在性
  向已通过的好友确认;dmPolicy:'disabled' 保留纯静默总开关给要完全隐身
  的 owner。
- 风险:通知预览含 guest 文本——已定转义+截断+直发不进 prompt;
  邀请码被转发给第三者 ⇒ 单次使用 + 48h + owner 可见(待批准不列邀请码,
  但欢迎语让 owner 在聊天里看得到谁进来了——`允许/邀请` 均回执 chatId)。

## 8. Non-goals(显式)

- guest 的记忆/人格/curiosity(memory_write tier 政策另立项);
- guest 的 care/push 参与;群聊;拒绝申诉流;
- 邀请码的 CLI/桌面/internal-api 面(微信内闭环);
- terminal `/wechat:access` skill 与文档主路径不动;
- 批准通知的多 admin 扇出(单 admin 目标,`resolveAdminChatId` 语义)。
