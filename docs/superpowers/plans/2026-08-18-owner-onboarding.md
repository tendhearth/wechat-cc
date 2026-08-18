# Owner Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已建好的 onboarding/陪伴机械件拼装成完整的 owner 体验:修 tier bug、状态落盘、开场叙事、/help 止血、首启通知、两个养成点火 prompt 节。

**Architecture:** 全部是既有文件的小改:onboarding.ts(store 化 + 文案)、setup-flow/doctor(admins)、mode-commands(/help + 未知命令)、notify-startup(首启文案)、prompt-builder + bootstrap thunk(两个新 section)。无新子系统、无 schema 迁移。

**Tech Stack:** bun + vitest(`bun --bun vitest run`);e2e 走现有 harness。

**Spec:** `docs/superpowers/specs/2026-08-18-owner-onboarding-design.md`

## Global Constraints

- 测试 vitest only;`bun --bun vitest run <path>`;e2e `bun --bun vitest run --config vitest.e2e.config.ts <file>`;本机 2 个已知插件符号链接失败(src/daemon/bootstrap.test.ts)容忍,其余失败必须归因。
- 文案是产品面——**逐字用本 plan/spec 里的字符串**,不得改写;现有 e2e/单测里断言旧文案的期望同步更新。
- echo 重派发机制、admin 起名子步、昵称校验逻辑与文案:一律不动。
- `--dangerously` 行为、`isAdmin` 与 `resolveTier` 的语义差异:保留(各补一句指向 spec 的注释)。
- 每 task 一个 commit,显式 git add 路径,尾行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: A2 — onboarding 状态落盘

**Files:**
- Modify: `src/daemon/onboarding.ts`(`awaiting` Map → store 背书;deps 增注入缝)
- Modify: onboarding handler 的构造点(grep `makeOnboardingHandler(` in src/daemon/wiring/ — 传入 stateDir 或已构造的 store)
- Test: `src/daemon/onboarding.test.ts`(现有套件改造)+ e2e 新用例

**Interfaces:**
- `OnboardingDeps` 增 `store?: StateStore`(测试注入)与/或 `stateDir: string`(生产构造 `makeStateStore(join(stateDir,'onboarding-pending.json'), { debounceMs: 0 })`——读 wiring 现场选阻力最小的一种,报告注明)。
- 持久形状:单键 JSON `Record<chatId, { since: number; triggerText: string; phase: AwaitPhase; fromMessage: InboundMsg }>`。**先验证 `InboundMsg` 可 JSON 序列化**(来自 poll-loop 的纯数据映射;若含不可序列化字段,持久化其可序列化子集并在恢复时补默认——报告说明)。

- [ ] **Step 1: 失败测试**——现有套件加:① 同一 store、两个 handler 实例(模拟重启):实例 A 收首条消息发问候,实例 B(同 store 重建)收到昵称回复 ⇒ 正常走 setUserName + echo,不重新问候;② 过期项:`deps.now` 拨过 30 分钟 ⇒ 实例 B 当首次接触重新问候;③ 落盘文件内容快照(单键 JSON 形状)。
- [ ] **Step 2: RED 确认** `bun --bun vitest run src/daemon/onboarding.test.ts`
- [ ] **Step 3: 实现**——`awaiting` 的 get/set/delete 改经 store(读时解析 + 过期过滤;写透 debounceMs:0);DEDUP_WINDOW 逻辑保持内存(进程内语义,注释注明)。
- [ ] **Step 4: GREEN** + `bunx tsc --noEmit`
- [ ] **Step 5: e2e**——新文件或并入现有 onboarding e2e:问候 → `stateDirOverride` 双 boot(restart-persistence 既有姿势)→ 回昵称 ⇒ 续流程不重问。`bun --bun vitest run --config vitest.e2e.config.ts <该文件>`
- [ ] **Step 6: Commit** `fix(onboarding): pending state survives daemon restart (state-store backed)`

---

### Task 2: B1+B2 — 开场叙事文案

**Files:**
- Modify: `src/daemon/onboarding.ts`(两处文案)
- Test: 现有 onboarding 单测 + e2e 期望更新

- [ ] **Step 1:** turn-1 问候(~:246-252)改为逐字:
`你好呀!我是 ${deps.botName(msg.chatId)}——住在你微信里的 AI 伙伴,能聊天、帮你干活、记得你说过的事。先问一下,我应该怎么称呼你?比如「Nate」「丸子」(中文/英文都行)`
- [ ] **Step 2:** turn-2 确认句(~:111-118 的非 admin 分支)改为逐字:
`好的 ${proposed}!想看我全部玩法,随时发 /help。刚才你说「${aw.triggerText}」,回答下:`
(admin 起名子步的文案不动。)
- [ ] **Step 3:** 全仓 grep 旧文案片段(`先问一下我应该怎么称呼你` / `刚才你说「`)更新所有断言;`bun --bun vitest run src/daemon/onboarding.test.ts` + 相关 e2e 文件 + `bunx tsc --noEmit`。
- [ ] **Step 4: Commit** `feat(onboarding): warm self-intro greeting + one-shot /help pointer`

---

### Task 3: A1 — tier 引导修复

**Files:**
- Modify: `src/cli/setup-flow.ts`(~:268-278 allowFrom 写入处)
- Modify: `src/cli/doctor.ts`(新检查)
- Modify: `src/lib/access.ts` + `src/core/user-tier.ts`(各一句注释指向 spec §A1,行为零改动)
- Test: 两者现有套件

- [ ] **Step 1(TDD):** setup-flow 套件加:首绑且 `admins` 空/缺 ⇒ 写 `admins: [ilink_user_id]`;`admins` 已有内容 ⇒ 不动;同一安装第二账号 ⇒ 不动(admins 已非空)。RED → 实现(写入点与 allowFrom.push 同处,读-改-写同一 access 对象)→ GREEN。
- [ ] **Step 2(TDD):** doctor 套件加:`allowFrom` 非空且 `admins` 空 ⇒ 输出含警告与修复指引(文案:`⚠️ access.json 有 allowFrom 但 admins 为空——owner 会落到 guest 档(工具全被拒)。把你的 user_id 加进 admins: ["<user_id>"]`,user_id 取 allowFrom[0] 示例)。RED → 实现(镜像 doctor 现有检查的结构)→ GREEN。
- [ ] **Step 3:** 注释两句 + `bunx tsc --noEmit`。
- [ ] **Step 4: Commit** `fix(setup): first bind writes admins — owner no longer lands in guest tier (doctor check included)`

---

### Task 4: A3 — /help 止血 + 未知命令

**Files:**
- Modify: `src/daemon/mode-commands.ts`(/help 模式行 ~:174;末尾 fallthrough ~:580-582)
- Test: mode-commands 套件

- [ ] **Step 1:** /help 模式切换行补 `/gemini` `/agy`(与 /mode :436 的清单对齐;两处各加一行注释:新 provider 上线两处同步)。
- [ ] **Step 2(TDD):** 未知纯斜杠命令:匹配 `/^\/[a-zA-Z]{2,16}$/` 且不是任何已知命令(已知集合 = isProviderCommand 词表 + 文件中处理的所有 slash 词——从现有分支收集,不硬编码散表则加常量数组)⇒ 回复逐字 `❓ 不认识 ${原词}。看全部命令发 /help。` 并 return true(消费)。带参数/含中文/更长的照旧 return false 透传。测试:`/foobar` 消费 + 文案;`/foobar 参数`、`/中文`、`/cc` 不受影响;RED → GREEN。
- [ ] **Step 3:** `bun --bun vitest run src/daemon/mode-commands.test.ts && bunx tsc --noEmit`
- [ ] **Step 4: Commit** `feat(mode): /help catches up (+/gemini /agy); unknown slash commands get a hint instead of silent LLM prose`

---

### Task 5: A4 — 首启通知人性化

**Files:**
- Modify: `src/daemon/notify-startup.ts`(~:62-93)
- Test: 该文件套件(有则改;无则新建镜像现有注入姿势)

- [ ] **Step 1(TDD):** state 一次性标记(`makeStateStore(join(stateDir,'startup-notified.json'), {debounceMs:0})` 或该文件现有 store 惯例——读文件定)。无标记 ⇒ 发逐字 `我上线啦 👋 直接跟我说话就行;想看我能干嘛,发 /help。` 并写标记;有标记 ⇒ 现有技术版(pid/accounts/警告)不变。测试:首启文案、次启技术版、标记落盘。
- [ ] **Step 2:** GREEN + tsc;有 e2e 断言启动通知的话同步(grep `已启动` in __e2e__)。
- [ ] **Step 3: Commit** `feat(daemon): first-ever startup notice is a warm hello; later restarts keep the technical line`

---

### Task 6: C1+C2 — 养成点火 prompt 节

**Files:**
- Modify: `src/core/prompt-builder.ts`(两个新/改 section)
- Modify: `src/daemon/bootstrap/index.ts`(thunk 接线,careLevelFor/personaFor 同族)
- Modify: `src/daemon/main.ts`(如需新 per-spawn thunk 传参——镜像 stickerTagsFor 姿势)
- Test: prompt-builder 单测 + bootstrap 组装断言(既有模式)

- [ ] **Step 1(C1,TDD):** `companionOfferSection()`——注入条件:owner chat(与 personaFor 的 default_chat_id 判定同源)且 `loadCompanionConfig().enabled === false` 且该 chat 入站数 ≥ `NEW_RELATIONSHIP_MSG_COUNT`(与刚认识 section 同阈值互斥——断言两者不同时出现)。内容逐字:
`你们已经聊熟了。若对话自然聊到未来的事(约定、截止日、日程),可以顺势提一句:你能主动关心这些(用 companion_enable 工具,对方明确同意才开启)。提过一次没被接受,就别再提。`
测试:条件满足 ⇒ 出现;companion 已开启 / 非 owner chat / 消息数不足 ⇒ 不出现;与 newRelationshipSection 互斥。
- [ ] **Step 2(C2,TDD):** sticker 部分空库版——渲染条件:pref on 且 `stickerTagsFor` 返回空数组(接线处把"空数组"从"不渲染"改为"渲染空库版";非空行为不变)。内容逐字:
`你还没有表情包。聊天里遇到值得存的表情/梗图,可以用 save_sticker 存进库,以后就能发给对方。`
测试:空库 ⇒ 空库版出现;非空 ⇒ 原 section;pref off ⇒ 都不出现。
- [ ] **Step 3:** bootstrap/main 接线(镜像既有 thunk;C1 需要 chat 入站计数——`countInboundMessagesSync` 已在 main.ts:280 供 newRelationshipFor,复用同源数据);`bun --bun vitest run src/core/prompt-builder.test.ts src/daemon/bootstrap/ && bunx tsc --noEmit`。
- [ ] **Step 4: Commit** `feat(companion): ignition prompts — natural-moment companion offer + sticker cold-start unlock`

---

### Task 7: 全量回归 + 文档

- [ ] **Step 1:** `bunx tsc --noEmit && bun --bun vitest run`(容忍已知 2 失败)+ `bun --bun vitest run --config vitest.e2e.config.ts`(全绿)。
- [ ] **Step 2:** `docs/design/roadmap.md` 状态行:onboarding 标 done(2026-08-18,spec 指针);`docs/superpowers/specs/2026-07-10-onboarding-curiosity-design.md` 注一句 30/50 漂移以代码为准(spec §E)。
- [ ] **Step 3: Commit** `docs: owner onboarding landed — roadmap 4b onboarding item done`
