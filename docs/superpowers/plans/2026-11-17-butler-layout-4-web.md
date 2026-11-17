# 管家的屋子 · 第 4 步:网页 / PWA 名单条 + 直通 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已配对网页(设备令牌)对话顶部多一条「在做」名单条;点一件事进现有详情 `#m-detail`,页头「在跟 X 说」,底部第一次能直接对那件事说话;撤掉 `#chat-waiting` 与输入框上方 `#topic-row`,话题改从对话工具栏「话题」进。

**Architecture:** 名单只读 `GET /v1/roster`(设备令牌,第 1 步);短链接页不变(拿不到名单,也不出名单条)。详情沿用 `workbench.js` 的 `openMatter` 与 `layers.js` 的层;新增直通输入框,任务事发 `POST /v1/matter/say`(带 requestId),终端发 `POST /v1/cli/session-say`。

**Tech Stack:** 纯 HTML + 内联 JS(`apps/mobile/src/*`,`bun apps/mobile/build.ts` 拼成 phone 页),vitest(`apps/mobile/*.test.ts`),Playwright(`apps/mobile/playwright`,只在 mini 跑)。

**Spec:** `docs/superpowers/specs/2026-11-17-butler-layout-design.md` §4.3、§4.4;示意图 https://claude.ai/artifact/Dv64iDG3X8WsyLbPJZfh6x(手机两张)

## Global Constraints

- 只对设备令牌(`isDevice`)显示名单条与直通输入框;链接令牌页面一字不变(`docs/reference/phone-wording.md` 与 `phone-link-token` 规矩:送话给执行者只给设备)。
- 名单条规格同 App:只放 waiting + working、最多 5 个头像(40px 圆,等你 accent 2px 描边,其余 hair 1px,多棒叠两枚),末尾「在做 N ›」;全空不渲染。头像复用 `agent-avatars.css` 与共享头像渲染。
- 颜色只用 `tokens.css` 变量;状态词用 `CCP.STATUS_WORDS`。
- 名单轮询:页面可见时每 5 秒 `GET /v1/roster`,带 `If-None-Match`;不可见停。
- 手机网页传输预算守卫(构建后体积)要继续绿;新增 JS 尽量小。
- Playwright 只在 mini 跑。

## Review Focus

1. 链接令牌打开页面:不出现名单条、不出现直通输入框、不请求 `/v1/roster` —— Task 1 用例。
2. 直通发出后断网:原文保留、显示「结果待核对」,恢复后按 requestId 核对,不重发 —— Task 2 用例。
3. 详情层打开时浏览器返回键:先关详情回对话,草稿保留 —— Task 2 用例(沿用 `layers.js`)。
4. 宽屏(≥ 900px)详情作为侧栏打开时,两个输入框同时可见:各自只发给各自的目标 —— Task 2 用例。
5. 名单接口 503:保留上一份并显示「家里的电脑暂时连不上」—— Task 1 用例。

---

### Task 1: 名单条

**Files:**
- Create: `apps/mobile/src/roster.js`(`renderRosterStrip(items, opts)` 纯函数 + `startRoster({ call, isDevice, onOpen })` 轮询与挂载)
- Modify: `apps/mobile/src/conversation.html`(`#conversation` 顶部、`#chat-messages` 之前加 `<nav id="roster-strip" aria-label="在做" hidden></nav>`)、`apps/mobile/src/phone.html`(拼入 `roster.js`)、`apps/mobile/src/conversation.css`
- Test: `apps/mobile/roster.test.ts`

- [ ] Step 1: 失败用例:只取 waiting + working、最多 5;总数含 back;等你描边;多棒 current 在前;链接令牌不启动轮询(Review Focus 1);503 保留旧名单 + 提示(Review Focus 5);304 不重画。
- [ ] Step 2–4: 实现、`bun --bun vitest run apps/mobile/roster.test.ts` 绿;`apps/mobile/build.test.ts` 与传输预算守卫绿。
- [ ] Step 5: commit `网页:对话顶部「在做」名单条`

### Task 2: 直通

**Files:**
- Modify: `apps/mobile/src/workbench.js`(`#m-detail` 页头改「‹ CC」+ 当前那家圆标 + 事名 + 「项目 · 第 i 棒 / n」;设备令牌时在详情底部加 `<form id="m-say">`,placeholder「对 <名字> 说…」;任务事 `POST /v1/matter/say {id,text,requestId}`,终端事 `POST /v1/cli/session-say {session_id,text}`;发出失败或不确定显示「结果待核对」并保留原文;恢复后按 requestId 查回执)
- Modify: `apps/mobile/src/phone.html`(删 `.m-elsewhere` 里「对话记录…在 App 或电脑上看」那句——设备令牌已能直接说;链接令牌照旧显示)
- Test: `apps/mobile/conversation.test.ts` 或新 `apps/mobile/direct.test.ts`

- [ ] Step 1: 失败用例:Review Focus 2、3、4;链接令牌详情没有 `#m-say`。
- [ ] Step 2–4: 实现并绿。
- [ ] Step 5: commit `网页:详情底部直接对那家 agent 说`

### Task 3: 撤等你定位器与话题行,话题挪进工具栏

**Files:**
- Modify: `apps/mobile/src/conversation.html`(删 `#chat-waiting`、`#topic-row`;`.conversation-tools` 加 `<button id="topic-open" type="button">话题</button>`)
- Modify: `apps/mobile/src/topics.js`(`#topic-open` 打开现有 `#topic-panel` 的 `#topic-all` 列表;删话题行渲染)、`apps/mobile/src/conversation.js`(删 chat-waiting 逻辑)
- Test: `apps/mobile/topics.test.ts`、`apps/mobile/conversation.test.ts` 按新入口改

- [ ] Step 1: 改用例:点「话题」打开列表;不再渲染 `#topic-row`。
- [ ] Step 2–4: 实现并绿。
- [ ] Step 5: commit `网页:话题从工具栏进,撤话题行与等你定位器`

### Task 4: e2e 与 PR

- [ ] Step 1: `bun run build:mobile` 后 `bun run verify` 绿。
- [ ] Step 2: `apps/mobile/playwright/conversation.e2e.test.ts`、`minimal.e2e.test.ts` 按新结构改;新增名单条 → 详情 → 直通发送 → 返回 用例(宽 / 窄各一)。分支加进 mini lab 浏览器快照白名单,告诉整合者。
- [ ] Step 3: mini 上跑网页 e2e 全绿。
- [ ] Step 4: PR 到 dev,写主人 11-17 授权原话与 `## 删掉/放松的测试`。
