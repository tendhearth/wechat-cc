# Guest 路径 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 非白名单好友:发消息 → 中性回复 + owner 收带码通知 → 微信内「允许/拒绝 <码>」;或 owner 发「邀请码」朋友发码直入。批准链路零模型参与、身份门授权、只写 allowFrom。

**Architecture:** 新 store(guest-requests,state-store 写透)+ 纯解析(guest-command)+ access.appendAllowFrom + mw-access guest 分支(定向 hydrate/预算/单通知)+ pipeline-deps 的 owner 命令 seam(配对码旁)+ /help 分层。批准后 `ctx.redispatch` 直接接 onboarding 既有流。

**Tech Stack:** bun + vitest(`bun --bun vitest run`);e2e 走现有 harness。

**Spec:** `docs/superpowers/specs/2026-08-18-guest-path-design.md`(§1-§5 为契约级,本 plan 不复述结构,只锚定与补文案)

## Global Constraints

- 安全红线(每个 task 的审阅重点):批准/邀请全链路**确定性、pre-LLM**;owner 命令 seam 必须 `isAdmin(msg.chatId)` 身份门;access 写入**只碰 allowFrom**;guest 文本进 owner 通知必须截断(≤60 字)+ 换行转义,**直发 `ilink.sendMessage` 绝不进 prompt**;错误邀请码与普通消息不可区分;超额与普通丢弃不可区分。
- 用户可见文案**逐字**用 spec §2/§3 的字符串。
- 测试 vitest only;`bun --bun vitest run <path>`;e2e `bun --bun vitest run --config vitest.e2e.config.ts <file>`;容忍仅有的 2 个既知插件符号链接失败;显式 git add;commit 尾行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 陌生人通知目标一律 `resolveAdminChatId`(**禁用** `resolveOperatorChatId`——spec §0 陷阱)。

---

### Task 1: `src/daemon/guest-requests.ts` — store + 码机器

**Files:** Create `src/daemon/guest-requests.ts` + `guest-requests.test.ts`

**Interfaces:** spec §1 的 `GuestRequestStore` 逐字(`upsertRequest`/`findByCode`/`resolve`/`listPending`/`createInvite`/`consumeInvite`/`wasDenied`;`makeGuestRequestStore({ stateDir, now?, store? })`)。另需 `seenMessage(id): boolean`(记录并返回是否已见——§2 步骤 1 的消息 id 去重,持久于同一文件)。

- [ ] TDD 全套(spec §6 store 行):upsert 幂等(同 chatId 二次 ⇒ fresh:false 且码不变)/notifiedAt 落盘/48h TTL 读滤+写清(注入 now)/denied 记录与 wasDenied/邀请码单次消费原子性/双命名空间防撞(mock randomInt 制造碰撞,断言重生成)/seenMessage 幂等/落盘形状快照。码生成:`String(randomInt(0,1_000_000)).padStart(6,'0')`(配对码同款,`node:crypto` randomInt)。
- [ ] 实现 → GREEN → `bunx tsc --noEmit`
- [ ] Commit `feat(guest): request store + code machinery — durable, single-notify, 48h TTL`

### Task 2: `src/core/guest-command.ts` — 纯解析

**Files:** Create `src/core/guest-command.ts` + `guest-command.test.ts`

**Interfaces:**

```ts
export type GuestCommand =
  | { kind: 'allow'; code: string } | { kind: 'deny'; code: string }
  | { kind: 'invite' } | { kind: 'pending' }
export function parseGuestCommand(text: string): GuestCommand | null
```

- [ ] TDD:`允许 483921`/`拒绝 483921`(空白宽容,码严格 6 位数字)/`邀请码`/`待批准` 精确匹配;带多余文字 ⇒ null(如「请允许 483921 吧」——确定性命令不做模糊);`允许 12345`(5 位)⇒ null。文件头注释 pair-command 同款("Deterministic pipeline-layer parse… never relies on the model noticing")。
- [ ] 实现 → GREEN → Commit `feat(guest): deterministic owner command parser`

### Task 3: `access.appendAllowFrom`

**Files:** Modify `src/lib/access.ts` + 套件

- [ ] TDD:追加成功 true(经 `saveAccess`——首个生产调用方,注释注明);已存在 false 不写;admins/trusted 字节不动断言;红线注释 + spec 指针。
- [ ] Commit `feat(access): appendAllowFrom — the only in-daemon access mutation, allowFrom-only by design`

### Task 4: mw-access guest 分支

**Files:** Modify `src/daemon/inbound/mw-access.ts` + `mw-access.test.ts`;Modify `src/daemon/wiring/pipeline-deps.ts`(deps 注入);(hydrate 助手可放 `src/daemon/ilink-glue.ts` 或 pipeline-deps,读 mw-capture-ctx 的两个调用后定夺,**不得触碰 `lastActiveRef`**——加断言测试)

**Interfaces:** `AccessMwDeps` 扩展:`guestRequests`、`hydrateChatRoute(msg)`、`sendMessage`、`notifyOwner(text)`、`budget`(`makeForwardBudget({ perSender: 3, windowMs: 3600_000 })`)。全部 optional(缺省 = 现状纯丢弃——测试/最小嵌入零改动,e2e 环境显式接上)。

- [ ] 分支顺序逐字按 spec §2(五步);文案:
  - 邀请直入:`主人邀请你来的吧,欢迎!直接跟我说话就行~`
  - 中性回复:`我需要主人确认一下,稍等哦~`
  - owner 通知:`👋 ${chatId} 想和我聊天,ta 说:"${预览}"\n回「允许 ${code}」或「拒绝 ${code}」(48 小时内有效)`(预览 ≤60 字、`\n`→空格)
- [ ] TDD 覆盖 spec §6 的 mw-access 行(七个出口各一用例 + hydrate 不触 lastActiveRef + deps 缺省时与旧行为字节一致)。
- [ ] `bun --bun vitest run src/daemon/inbound/ && bunx tsc --noEmit` → Commit `feat(guest): mw-access request branch — neutral reply, single owner notify, invite direct-entry`

### Task 5: owner 命令 seam + redispatch 接线

**Files:** Modify `src/daemon/wiring/pipeline-deps.ts`(配对码 seam 旁,同款 `isAdmin` 门)+ 套件

- [ ] seam:`parseGuestCommand` 命中且 `isAdmin` 才处理;文案逐字:
  - 允许成功:owner `✅ 已允许 ${chatId}`;guest `主人同意啦!`;然后 `dispatchInbound` 重派发 `firstMsg`(`redispatch: true`——onboarding 接管);
  - 码错/过期:`❌ 码不对或已过期(发「待批准」看当前请求)`;
  - 拒绝成功:owner `已拒绝,ta 不会再打扰你。`(guest 零消息);
  - 邀请码:`邀请码:${code}(48 小时内有效,一次一人)。把这串数字发给朋友,ta 加我微信好友后把码发给我就能聊了。`;
  - 待批准:每行 `「${code}」 ${chatId}:"${预览}"(剩 ${n} 小时)`,空 ⇒ `目前没有待批准的请求。`
- [ ] TDD:非 admin 发「允许 123456」不匹配(落回正常聊天);四命令 happy path + 错码;允许后 allowFrom 已含该 chat(注入 access 假件断言 appendAllowFrom 调用)。
- [ ] Commit `feat(guest): owner approve/deny/invite/pending commands — identity-gated, deterministic`

### Task 6: /help 分层

**Files:** Modify `src/daemon/mode-commands.ts` + 套件

- [ ] guest(`resolveTier(msg.chatId, loadAccess()) === 'guest'`——**不用 isAdmin**,spec §5 理由)只渲染:开场说明、`/whoami` `/name`、`/set split`、文件收发;隐藏 provider 切换/care/陪伴/配对块。admin/trusted 输出字节不变(断言)。
- [ ] Commit `feat(mode): /help is tier-aware — guests only see what their tier can use`

### Task 7: e2e 验收 + 全量回归 + 收尾

**Files:** Create `src/daemon/__e2e__/guest-path.e2e.test.ts`

- [ ] e2e(核心验收,harness 现有姿势;access 预置 admins:['testadmin'] 且陌生 chat 不在 allowFrom):
  ① 陌生 chat 发「帮我查天气」⇒ 收到中性回复;testadmin 收到含 6 位码的通知;陌生 chat 再发消息 ⇒ 无第二次通知;
  ② testadmin 回「允许 <码>」(从通知文本提码)⇒ owner 收 ✅;guest 收「主人同意啦!」+ onboarding 问称呼;guest 回昵称 ⇒ echo 回答「帮我查天气」(fake provider 断言);
  ③ 拒绝路径:另一陌生 chat → 「拒绝 <码>」⇒ owner 收回执、guest 无消息、后续消息纯静默;
  ④ 邀请码:testadmin 发「邀请码」拿码 → 第三个陌生 chat 直接发码 ⇒ 欢迎语 + 后续消息正常应答;同码第二人 ⇒ 当普通消息走请求流(单次使用)。
- [ ] 全量:`bunx tsc --noEmit && bun --bun vitest run`(容忍 2 既知)+ e2e 全量(全绿)。
- [ ] README.md / README.zh.md 的 access 段补一句:微信内「允许/邀请码」为新增路径,终端仍是完整管理面(admins/trusted 仅终端)。
- [ ] Commit `feat(guest): e2e acceptance + docs — the share path is live`
