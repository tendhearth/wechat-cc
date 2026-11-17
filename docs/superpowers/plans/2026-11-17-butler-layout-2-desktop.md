# 管家的屋子 · 第 2 步:桌面两栏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面主界面改成「左:和 CC 的对话 / 右:在做名单,点一件事右栏变直通」,左侧导航收成页头。

**Architecture:** 不重写事项详情。工作台层 `#conversation-matter-layer` 仍是唯一的任务详情实现;宽窗口下它**停靠**进右栏(DOM 移进 `#roster-aside`,不切 pane,对话不隐藏),窄窗口和重工具(看改动 / 回退 / 搜索 / 交办表单)照旧全屏。终端事与无事的终端会话用 `conversation-work-detail.js` 的详情,从 `<dialog>` 改为渲染进给定容器。名单数据来自第 1 步的 `GET /v1/roster`。

**Tech Stack:** Tauri webview,纯 HTML + ES module JS(`// @ts-check`),vitest(模块测试),Playwright(只在 mini 跑)。

**Spec:** `docs/superpowers/specs/2026-11-17-butler-layout-design.md` §4.2、§4.4、§4.5;示意图 https://claude.ai/artifact/Dv64iDG3X8WsyLbPJZfh6x
**依赖:** 第 1 步(daemon 名单)已合 dev;本分支从合了第 1 步的 dev 起。

## Global Constraints

- 设计守卫照旧要绿:`design-style.test.ts`(无深色、字重 400/500、状态是字形 + 文字、无彩色圆点)、`component-appearance.guard.test.ts`、`design-tokens.guard.test.ts`;颜色 / 字号只用 tokens(`--th-*`),不新增 hex。
- 状态词、分组标题只从 `generated/status-table.js` 查;按钮词按 `docs/reference/phone-wording.md`(先不做 / 允许这一步)。
- 宽窗口阈值 1080px;名单栏 360px、直通时 400px。
- 名单轮询:窗口可见时每 3 秒 `GET /v1/roster`,带 `If-None-Match`;不可见时停。
- 设置抽屉的外部点击判定保持 `e.composedPath().includes(drawer)`(#959),设置 → 接入 AI 服务 → 「登录已有账号」→ `#brain-setup` 这条路不动。
- 主 Mac 不跑 Playwright;受影响的 spec 在 mini 上跑(`macmini-ui.mjs`,分支加进 `supportsBrowserSnapshot`)。

## Review Focus

1. 直通停靠时主人在对话框里打字、按回车:只发给 CC,不能发进停靠的工作台补充框 —— Task 4 加用例(两个 form 各自 submit)。
2. 停靠着一件事时它被归档 / 删掉:右栏回到名单并提示「这件事已经不在了」,不留空白 —— Task 4 加用例。
3. 窗口从宽拖到窄(< 1080)时正停靠着:改为全屏层显示同一件事,草稿不丢 —— Task 4 加用例。
4. 名单接口 503 / 断网:右栏显示「家里的电脑暂时连不上」(用词表),保留上一份名单并标旧时间,不清空 —— Task 3 加用例。
5. 对话里点瘦卡片时该件不在名单里(超过 24 小时的旧事):照样停靠打开,不要求先出现在名单 —— Task 5 加用例。

---

### Task 1: 页头导航取代左侧栏

**Files:**
- Modify: `apps/desktop/src/index.html`(`#dash-global-rail` 由 `<aside>` 改为页头 `<header id="dash-global-rail" class="dash-topbar">`,保留 id 免得牵连;内容:左 `#topbar-cc`(小 CC 图 + 「CC」+ 在不在,`data-pane="overview"`),右 `搜索`(`id="topbar-search"`)、`记忆`(`data-pane="memory"`)、`回忆`(`data-pane="recollections"`)、`<details class="topbar-more">⋯`(画室 / 待办 / 觅食 / 后厨 `data-backstage-entry` / 设置 `id="settings-open"`))
- Modify: `apps/desktop/src/styles.css`(dash-window 改为 `grid-template-rows: auto 1fr; grid-template-columns: 1fr auto`;删侧栏宽度相关规则;topbar 高 72px、底部 hair 线)
- Modify: `apps/desktop/src/main.js`(`#topbar-search` 走现有 search 回调;`now-hero` 的 `#now-cc` 点击逻辑挪到 `#topbar-cc`;删除 `.now-hero` 节点与 `workbench-nav-toggle` 开侧栏的逻辑)
- Modify: `apps/desktop/src/modules/now-hero.js`(CC 图的明暗 / 眼神目标改成 `#topbar-cc img`)
- Modify/Test: `apps/desktop/src/rail.test.ts` 改写为 `topbar.test.ts`(同条数以上):七个 pane 都可达、`settings-open` 与 `data-backstage-entry` 在、没有 `data-pane="workbench"`、`data-conversation="single"`、`#conversation-matter-layer`、id 唯一、不再有 `cc-life-nav-more`

**Interfaces:**
- Produces: `#topbar-cc`(含 `img.topbar-cc-light` / `img.topbar-cc-dark`)、`#topbar-search`、`.topbar-more`

- [ ] Step 1: 改写守卫为 `topbar.test.ts`,跑 `bun --bun vitest run apps/desktop/src/topbar.test.ts`,预期 FAIL。
- [ ] Step 2: 改 index.html / styles.css / main.js / now-hero.js。
- [ ] Step 3: 跑 `topbar.test.ts`、`design-style.test.ts`、`scripts/component-appearance.guard.test.ts`,全绿。
- [ ] Step 4: commit `桌面:页头导航取代左侧栏(搜索 / 记忆 / 回忆 / ⋯)`

### Task 2: 撤话题行与「N 件事等你」定位器

**Files:**
- Modify: `apps/desktop/src/main.js`(删 `mountConversationTopics` 挂载与 `#now-waiting` 搬家 / toggle 逻辑;`nowPage.setTopics` 调用随之删)
- Modify: `apps/desktop/src/index.html`(删 `#now-waiting`)
- Modify: `apps/desktop/src/modules/memory*.js`(记忆页顶部加「话题」一节:复用 `conversation-topics.js` 的列表渲染与改名 / 合并 / 删 / 标错入口;只读 `/v1/memory/topics`)
- Delete or keep: `conversation-topics.js` 保留其列表与管理函数给记忆页用,删掉「输入框上方一行」的挂载导出
- Test: `apps/desktop/src/modules/conversation-topics.test.ts`(若有)按新挂载点改;新增 `memory-topics` 用例:记忆页渲染话题列表、点「改名」走原接口

- [ ] Step 1: 写记忆页话题用例,FAIL。
- [ ] Step 2: 实现;删挂载。
- [ ] Step 3: 模块测试全绿。
- [ ] Step 4: commit `桌面:话题挪到记忆页,撤输入框上方话题行与等你定位器`

### Task 3: 右栏名单

**Files:**
- Create: `apps/desktop/src/modules/roster-pane.js`、`apps/desktop/src/modules/roster-pane.test.ts`
- Modify: `apps/desktop/src/index.html`(`dash-window` 里 `dash-main` 之后加 `<aside id="roster-aside" class="roster-aside" aria-label="在做"><div id="roster-list"></div><div id="roster-dock" hidden></div></aside>`)
- Modify: `apps/desktop/src/styles.css`(`.roster-aside` 360px、左 hair 线;`[data-docked]` 时 400px;< 1080px 时收起,页头出现「在做 N」按钮 `#topbar-roster`,点开从右滑出)
- Modify: `apps/desktop/src/daemon-client.js` / `generated/daemon-calls.js`(第 1 步登记的 `V1.roster`)
- Modify: `apps/desktop/src/main.js`(boot 里 `mountRosterPane(...)`)

**Interfaces:**
- Consumes: `GET /v1/roster` → `RosterResponse`(`packages/protocol/src/roster.ts`)
- Produces:
  - `mountRosterPane({ root, call, onOpen:(item:RosterItem)=>void, now?:()=>number, intervalMs?:number }): { refresh():Promise<void>; destroy():void; items():RosterItem[] }`
  - `renderRosterHtml(items:RosterItem[], opts:{ stale:boolean; staleAt:number|null; agentAvatars:(agents)=>string }): string`(纯函数,好测)

行的样式照示意图:头像(多 agent 叠两枚,`current` 的描边 ink、其余 hair 且半透明;等你行描边 accent)、标题(item 字号)、第二行(small,inkSoft):项目 · 状态词 · 接力「第 i 棒 / n」· quiet 时「可能卡住」(`ROW_HINT_WORDS`);等你行第二行用 accent 写「等你决定 · <waiting.summary>」;`unseen` 加「还没看」。组标题 13px、等你组 accent。空名单:中间放 `assets/pet/cc-v1/attention/lit/read-down/000.png`(或现有睡姿资源)+「都歇着」。

- [ ] Step 1: `roster-pane.test.ts` 失败用例:三组顺序与标题;多棒显示「第 2 棒 / 3」;等你行带 summary;quiet 显示「可能卡住」;空名单显示「都歇着」;接口 503 ⇒ 保留上一份 + 「家里的电脑暂时连不上」+「你看到的是 HH:MM 的样子」(Review Focus 4);304 ⇒ 不重画。
- [ ] Step 2: FAIL。
- [ ] Step 3: 实现 `roster-pane.js`(轮询只在 `document.visibilityState==='visible'` 时跑)。
- [ ] Step 4: 全绿。
- [ ] Step 5: commit `桌面:右栏「在做」名单`

### Task 4: 直通停靠

**Files:**
- Create: `apps/desktop/src/modules/roster-dock.js`、`apps/desktop/src/modules/roster-dock.test.ts`
- Modify: `apps/desktop/src/modules/workbench.js`(只加:`renderTaskControlsBase` 的补充框 label / placeholder 改为「对 <当前执行者名> 说…」,框前放当前执行者头像;导出 `setWorkbenchDocked(boolean)` 让层在停靠时隐藏「‹ 返回对话」、显示「‹ 在做」与「展开」按钮)
- Modify: `apps/desktop/src/modules/conversation-work-detail.js`(`showWorkDetail(call, detail, mount?)`:给了 `mount` 就渲染进它,不建 `<dialog>`;关闭由调用方管)
- Modify: `apps/desktop/src/main.js`(`deps.onOpenMatter` 宽窗口时改走 `dockMatter(id)`)

**Interfaces:**
- Consumes: Task 3 `mountRosterPane(...).onOpen`;`openWorkbenchTask(id)`;`openConversationWork(call,id,openTask)`
- Produces: `createRosterDock({ aside, layer, call, openTask:(id:string)=>Promise<void>, wide:()=>boolean }): { open(item:{kind:'matter'|'terminal'; id:string}):Promise<void>; close():void; current():string|null }`
  - task 事:把 `#conversation-matter-layer` 移进 `#roster-dock`、`aside.dataset.docked='1'`、`openWorkbenchTask(id)`,**不调 `switchPane`**;
  - terminal 事 / 无事会话:`showWorkDetail(call, detail, dockEl)`;
  - 「‹ 在做」⇒ `close()`:把 layer 移回原位、清 `data-docked`;
  - 「展开」⇒ `close()` 后 `switchPane('workbench')` + `openWorkbenchTask(id)`(全屏,带改动 / 回退等重工具);
  - 窄窗口:`open` 直接走全屏(现有行为);停靠中窗口变窄 ⇒ 同「展开」,补充框草稿靠工作台既有的 `saveWindowState` 保留。

- [ ] Step 1: `roster-dock.test.ts` 失败用例:宽窗口打开 task 事 ⇒ layer 在 `#roster-dock` 里、overview pane 仍可见;对话框 submit 只触发 CC 发送、补充框 submit 只触发 `send-input`(Review Focus 1);停靠的事被归档(详情 404)⇒ 回名单并提示「这件事已经不在了」(Review Focus 2);宽 → 窄 ⇒ 全屏同一件(Review Focus 3);terminal 事渲染进 dock 而不是 dialog。
- [ ] Step 2: FAIL。
- [ ] Step 3: 实现。
- [ ] Step 4: 全绿;`bun --bun vitest run apps/desktop/src/modules` 不新增红。
- [ ] Step 5: commit `桌面:点名单里的一件事,右栏直通`

### Task 5: 对话里的瘦卡片 + CC 看一眼

**Files:**
- Modify: `apps/desktop/src/modules/conversation-matters.js`(`matterReferenceHtml` 改为一行 `<a>`:头像 + 标题 + 状态词 + 「›」;删展开体与 5 秒轮询;点击 ⇒ `deps.onOpenMatter(id)`;正停靠的那件显示「在右边打开着」并 ink 描边)
- Modify: `apps/desktop/src/modules/now-hero.js`(名单里某行刚变成 waiting 或 back:CC 眼神看右(复用 `attention/lit/right` 素材)1.2 秒;同一件一天只看一次,内存记)
- Test: `conversation-matters.test.ts`(若无则建)、`now-hero` 相关单测

- [ ] Step 1: 失败用例:卡片是单行、无 `<details>`;点击调用 `onOpenMatter`;不在名单里的旧事也能打开(Review Focus 5);同一件 waiting 两次只看一次。
- [ ] Step 2–4: 实现、全绿。
- [ ] Step 5: commit `桌面:对话里的事项卡变一行,CC 往右边看一眼`

### Task 6: mini 上的界面验收与 PR

- [ ] Step 1: `bun run verify` 绿。
- [ ] Step 2: 受影响的 Playwright spec 改到新结构:`t5-conversation`、`workbench-layout`(「全局导航在每个宽度都在」改为页头在;等你计数改在 `#topbar-roster` / 名单组标题)、`now-hero`、`now-minimal-requests`、`task-detail-minimal`、`design-shots`;新增 `roster-dock.spec.ts`(宽 / 窄、停靠 / 展开 / 回名单)。分支名加进 mini lab 的 `supportsBrowserSnapshot`,新 spec 告诉整合者。
- [ ] Step 3: 在 mini 跑上述 spec 全绿,截宽 1440 / 窄 900 两张图与示意图对照。
- [ ] Step 4: 开 PR 到 dev:描述写主人 11-17 授权原话;`## 删掉/放松的测试`:`rail.test.ts` 改写为 `topbar.test.ts`(布局换了,条数不少)、上面几条 spec 的改动逐条说理由。等三平台 CI 绿交整合者。
