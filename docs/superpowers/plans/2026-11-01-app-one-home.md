# App 一个主页(U1–U3)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机 App 里「此刻」与「一起做」合成一个主页:一张状态表、一种行、一个看法函数;批准并进一件事的详情页。

**Architecture:** 纯客户端改动(`apps/app` + 协议包一张纯数据表),用今天的数据(matters / approvals / agents topic / 终端会话)在 App 里合成一份 `HomeRow[]`;页面只渲染它。批准页的正文抽成组件,由一件事详情页嵌入;旧路由重定向。终端详情页保留(等 M4),只是行和状态词统一。

**Tech Stack:** Expo Router、React Native、TypeScript、vitest、Maestro(本机模拟器)。

**Spec:** `docs/superpowers/specs/2026-10-31-one-companion-one-skeleton-design.md` §4「U:界面一个主页」

## Global Constraints

- 主页名字仍叫「此刻」(`tabs.now` 词条可改名为 `home.title`,文字「此刻」不变);品牌词「一起做」不再作为入口出现,交办按钮文案保留「交给 CC 做一件事…」。
- 分组顺序固定:**等你 → 在做 → 带回来的**;空组不出。「CC 最近在忙」这一组本计划**不做**(要 M5 的 `act`)。
- 状态词以 `docs/reference/phone-wording.md` 为准:在做 / 等你决定 / 这一轮做完了 / 完成 / 没做成 / 停下了。终端会话的状态并入同一套:`waiting→waiting`、`running→working`、`idle→replied`、`ended→done`。
- 批准页的硬要求原样保留(`approval/[id].tsx` 头注释:命令首行 + 工作目录不折叠、提交中两个按钮都锁、以返回为准、挂载后拿到新详情前锁按钮、超长回答本地拦下)。
- 设计 token、字体、CC 明暗、无深色模式、一个强调色(只给「等你」)不动。
- 动 `apps/app` 的改动合并部署前在本机模拟器跑一遍 Maestro(`[[simulator-maestro-recipe]]` 的跑法,见 `apps/app/README.md`)。
- 每个提交前 `bun run verify`;PR 走 `dev`,squash。

## Review Focus

1. 够不着电脑(`known=false`)时:等你的组不显示旧行,页面说「暂时不知道有没有等你的事」—— 合并后不能退化成显示陈旧的等你行。
2. 一件事同时有多个批准请求:行只出现一次(按任务去重),点进详情能逐个处理;第一行才主动请求说明标题(`WaitingTitle fetch={i===0}`)。
3. 旧深链 / 旧推送(`/approval/<id>?request=`、`/together`、`cli:` 前缀的终端推送)全部还能打开到对的地方。
4. 终端会话「终端自己在问」(`actionable=false`)仍明说「回电脑上答」,不显示成可在手机批准。
5. 主人对话(`kind='chat'`)和访客对话不进列表(今天 `togetherView` 的过滤)。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/protocol/src/status-table.ts`(新) | 状态 → 词条键 / 图标名 / 色调 / 分组,纯数据,三端共用 |
| `apps/app/src/view/home.ts`(新,取代 `now.ts` 的行部分与 `together.ts`) | `homeView()`:合成 `HomeRow[]` 与分组 |
| `apps/app/src/ui/MatterRow.tsx`(新,取代 `TerminalItem.tsx` 与两页里手写的行) | 一种行 |
| `apps/app/src/app/index.tsx`(新位置)/ `all.tsx`(新)/ `together.tsx`(重定向) | 主页、全部、旧路径 |
| `apps/app/src/ui/ApprovalPanel.tsx`(新,从 `approval/[id].tsx` 抽出) | 批准正文 |
| `apps/app/src/app/approval/[id].tsx` | 只剩重定向 |

删除:`src/app/(tabs)/`、`src/ui/TabBar.tsx`、`src/ui/TerminalItem.tsx`(+ 测试)、`src/view/together.ts`(+ 测试);`src/view/now.ts` 只留 `latestCCLine` / `waitingCount` 如仍有调用方,否则并入 `home.ts`。

---

### Task 1: 状态表 + 看法函数 `homeView`

**Files:**
- Create: `packages/protocol/src/status-table.ts`, `packages/protocol/src/status-table.test.ts`
- Modify: `packages/protocol/src/index.ts`(导出)
- Create: `apps/app/src/view/home.ts`, `apps/app/src/view/home.test.ts`
- Modify: `apps/app/src/view/status.ts`(加 `terminalStatusKey`)

**Interfaces:**
- Produces:
  - `export type StatusKey = 'working' | 'waiting' | 'replied' | 'done' | 'failed' | 'stopped'`(从 `status-table.ts` 导出;`apps/app/src/view/status.ts` 改为 re-export)
  - `export type HomeGroupKey = 'waiting' | 'working' | 'back'`
  - `export const STATUS_TABLE: Record<StatusKey, { word: string; icon: 'shield' | 'done' | 'alert' | 'message' | 'pause' | null; tone: 'accent' | 'inkSoft'; group: HomeGroupKey }>` — `word` 是词条键 `status.<key>`;`working` 的 icon 为 `null`(行里留 18px 空位,和今天一致)
  - `terminalStatusKey(s: 'waiting' | 'running' | 'idle' | 'ended'): StatusKey`
  - `homeView(input: HomeInput): HomeView`,其中
    ```ts
    type HomeInput = { matters: MatterT[]; approvals: ApprovalItemT[]; agents: AgentsTopicT; terminal: CliSessionRowT[]; known: boolean; now: number; lang: Lang; away?: number | null }
    type HomeRow = { id: string; source: 'matter' | 'terminal'; href: string; title: string; caption: string; detail: string | null; note: string | null; status: StatusKey; pendingRequestId: string | null; agents: string[]; agentNames?: Record<string, string>; origin: MatterOrigin | null; updatedAt: number }
    type HomeView = { waitingUnknown: boolean; groups: Array<{ key: HomeGroupKey; title: string; rows: HomeRow[] }>; waitingCount: number; moreCount: number }
    ```

- [ ] **Step 1: 写失败测试 `status-table.test.ts`**:每个 `StatusKey` 都有一行;`STATUS_TABLE.waiting.tone === 'accent'` 且只有它是 accent;`group`:waiting→waiting、working→working、其余四个→back。

- [ ] **Step 2: 写失败测试 `home.test.ts`**(用 `view/together.test.ts`、`now.test.ts`、`terminal.test.ts` 里现成的夹具):
  - `known=false` ⇒ `waitingUnknown=true`,`groups` 里没有 `waiting` 组,其余组照常(Review Focus 1)。
  - 同一 taskId 两条批准 ⇒ 等你组里一行,`pendingRequestId` = 第一条的 id(Review Focus 2)。
  - `kind:'chat'` 与 `archived` 的 matter 不出现(Review Focus 5)。
  - 终端会话 `waiting & actionable=false` ⇒ `note === t(lang,'terminal.askedLocally')`,`status==='waiting'`,但 **不计入** `waitingCount`(和今天 `terminalNeedsYou` 一致:只算手机拍得了的)(Review Focus 4)。
  - 终端 `idle` ⇒ `status==='replied'`;`ended` ⇒ `done`。
  - 「带回来的」只收 `updatedAt >= now - 24h` 的;更早的不在主页、计入 `moreCount`。
  - `away` 距 now ≥ 1h 且组里有 `updatedAt > away` 的 ⇒ back 组 `title === t(lang,'today.whileAway',{n})`,否则 `t(lang,'home.group.back')`。
  - 组内排序:`updatedAt` 倒序;等你组里任务在前、终端在后(和今天此刻一致)。
  - `href`:任务 `/matter/<id>`(有 pending 时带 `?request=<id>`),终端 `/terminal/<id>`。

- [ ] **Step 3: 跑测试确认失败**:`cd apps/app && bunx vitest run src/view/home.test.ts` 与(仓库根)`bunx vitest run packages/protocol/src/status-table.test.ts` ⇒ FAIL(模块不存在)。

- [ ] **Step 4: 实现** `status-table.ts`、`terminalStatusKey`、`homeView`。`caption` 的拼法:任务 = 有 pending 时 matter 标题、否则 `项目 · 谁在做`(`agentsLabel`);终端 = 今天 `TerminalItem` 的 caption(`项目 · 状态或旧快照提示 · ago`),`detail` = 今天的 `nowText || summary`(旧快照时 null)。

- [ ] **Step 5: 跑测试确认通过**,`cd apps/app && bun run typecheck` 绿。

- [ ] **Step 6: Commit** `feat(app): 一张状态表 + homeView(此刻与一起做合成一份看法)`

### Task 2: 一种行 `MatterRow`

**Files:**
- Create: `apps/app/src/ui/MatterRow.tsx`, `apps/app/src/ui/MatterRow.test.ts`
- Delete: `apps/app/src/ui/TerminalItem.tsx`, `apps/app/src/ui/TerminalItem.minimal.test.ts`(其中仍成立的断言搬进 `MatterRow.test.ts`)
- Modify: `apps/app/src/app/terminal/[id].tsx`(它只用 `TerminalStatusPill` ⇒ 换成按 `STATUS_TABLE` 画的 `StatusWord`,放在 `MatterRow.tsx` 里一起导出)

**Interfaces:**
- Consumes: `HomeRow`、`STATUS_TABLE`(Task 1)
- Produces: `MatterRow({ row, onOpen, fetchTitle }: { row: HomeRow; onOpen: () => void; fetchTitle?: boolean })`,`StatusWord({ status, testID }: { status: StatusKey; testID?: string })`
- testID 约定:行 `row-<source>-<id>`;为了 Maestro 平滑迁移,任务行另带 `together-item-<id>` 的别名不做 —— Task 5 一次改完流程。

- [ ] **Step 1: 失败测试**(沿用仓库里读源码 / 渲染的测试写法,参见 `TerminalItem.minimal.test.ts`):图标来自 `STATUS_TABLE`(源码里不出现 `status === 'waiting' ? 'shield'` 这类手写映射);有 `pendingRequestId` 时标题用 `WaitingTitle`;`note` 有值时单独一行;读屏标签含标题、状态词、caption、note。
- [ ] **Step 2: 确认失败** `bunx vitest run src/ui/MatterRow.test.ts`。
- [ ] **Step 3: 实现**:行高 64、留白分隔、行尾 `chevronRight`,强调色只给 `tone==='accent'` 的图标。
- [ ] **Step 4: 确认通过** + typecheck。
- [ ] **Step 5: Commit** `feat(app): 一种行 MatterRow,终端会话与一件事同一行`

### Task 3: 一个主页(去掉标签栏)

**Files:**
- Create: `apps/app/src/app/index.tsx`(由 `(tabs)/index.tsx` 改写)、`apps/app/src/app/all.tsx`(由 `(tabs)/together.tsx` 改写)、`apps/app/src/app/together.tsx`(`<Redirect href="/all" />`)
- Delete: `apps/app/src/app/(tabs)/`、`apps/app/src/ui/TabBar.tsx`、`apps/app/src/view/together.ts` + 测试
- Modify: `apps/app/src/app/_layout.tsx`(去掉 `(tabs)` 的 Stack.Screen,欢迎页重定向挪到 `index.tsx` 顶部)、`apps/app/src/view/now.ts`(删掉 `nowView` / `matterStatus`,保留 `latestCCLine`、`waitingCount`)、`apps/app/src/view/today.ts`(只留 `AWAY_MIN_MS` 等被 `home.ts` 用的;没人用的删)、i18n `zh-Hans.ts` / `en.ts`、读源码的测试 `state/quiet-lists.test.ts`、`state/home-motion.test.ts`、`state/session-reading.test.ts`、`ui/style.guard.test.ts`
- Modify: `apps/app/src/push/route.ts`(`terminal` 空 id ⇒ `/all`)

**Interfaces:**
- Consumes: `homeView`、`MatterRow`
- 主页结构(自上而下):TopBar(字标、连接状态、头像;右侧 `+` 交办 → `/compose`,`…` 菜单:保存的输入、电脑上的会话 —— 从今天一起做页的 TopBar 搬来)/ ConnectionNotice / CC(点开进对话)+ 最近一句 / `waitingUnknown` 提示 / 各组(组标题衬线小字,等你组强调色)/ 「全部 →」(`moreCount>0` 或有任何行时出现)/ CompanionCard / 底部 SayBar。`CCFigure` 动作跟踪器的 `snapshot` 改从 `HomeView` 取(等你 id、带回来的 id)。
- 「全部」页:今天一起做页的内容(三组 + 终端段 + 空状态 + 重试),但行换成 `MatterRow`,标题 `home.all`(「全部」),带回来的不限 24 小时。
- 新词条:`home.group.waiting`=「等你」、`home.group.working`=「在做」、`home.group.back`=「带回来的」、`home.all`=「全部」、`home.allLink`=「全部 →」;删掉 `tabs.*`、`together.group.*`、`today.openAll`、`today.title/done/running/stuck/partial` 中已无调用方的(`i18n.test.ts` 会查两种语言键一致)。

- [ ] **Step 1: 改读源码的测试先红**:`quiet-lists.test.ts` / `home-motion.test.ts` / `session-reading.test.ts` 的路径从 `(tabs)/index.tsx` 改到 `index.tsx`;`style.guard.test.ts` 去掉 `TabBar`;新增断言:`src/app` 下不存在 `(tabs)` 目录、`together.tsx` 只含 `Redirect`。
- [ ] **Step 2: 确认红** `cd apps/app && bun run test`。
- [ ] **Step 3: 实现** 上面的文件移动与改写。
- [ ] **Step 4: 确认绿** `bun run test && bun run typecheck`。
- [ ] **Step 5: Commit** `feat(app): 此刻与一起做合成一个主页,去掉标签栏;/together 重定向到全部`

### Task 4: 批准并进一件事的详情

**Files:**
- Create: `apps/app/src/ui/ApprovalPanel.tsx`(把 `approval/[id].tsx` 里 `Approval` 的正文 —— 拉新、卡片 / 提问两种视图、提交、结局 —— 原样搬出,props `{ taskId: string; requestId?: string; onDone?: () => void }`;页面外壳 SafeAreaView / TopBar 不搬)
- Modify: `apps/app/src/app/matter/[id].tsx`(有待处理请求时在顶部渲染 `<ApprovalPanel taskId requestId={param request} />`,原来「逐个请求 → push `/approval/…`」的列表改成切换 `requestId`)
- Modify: `apps/app/src/app/approval/[id].tsx` ⇒ `<Redirect href={/matter/<id>?request=<request>} />`
- Modify: `apps/app/src/push/route.ts`:`hrefFor({kind:'approval'})` ⇒ `/matter/<id>?request=<r>`(`PushRoute` 的 `approval` 种类保留,只改去处)
- Test: `apps/app/src/push/route.test.ts`、`apps/app/src/view/approval.test.ts`(不动逻辑,应仍绿)

- [ ] **Step 1: 失败测试**:`route.test.ts` 里 `hrefFor({kind:'approval',id:'a',request:'r'}) === '/matter/a?request=r'`;源码测试:`approval/[id].tsx` 只含 `Redirect`;`ApprovalPanel.tsx` 里仍有「挂载后拿到新详情前按钮锁」与「超长回答本地拦下」的同一段判断(按函数名 `answersTooLong`、`canSubmit` 断言出现)。
- [ ] **Step 2: 确认红**。
- [ ] **Step 3: 实现**(搬家不改逻辑;testID 保持原样,Maestro `approve.yaml` 只改入口)。
- [ ] **Step 4: 确认绿** `bun run test && bun run typecheck`。
- [ ] **Step 5: Commit** `feat(app): 批准进一件事的详情页;/approval 只剩重定向`

### Task 5: Maestro 流程 + 本机模拟器验收

**Files:**
- Modify: `apps/app/.maestro/{design-shots,connections,terminal-sessions,continue-session,worktree,approve,push-open}.yaml`(`tab-together` / `together-item-*` / `together-more` / `together-sessions` / `tab-now` ⇒ 主页上的 `row-matter-*`、`row-terminal-*`、`home-more`、`home-sessions`、`home-all`)

- [ ] **Step 1: 改流程**(按上面的 testID 映射)。
- [ ] **Step 2: 本机模拟器全量跑** —— 跑法见 `apps/app/README.md` 的 Maestro 一节;全绿才算。截图 `p09-together` 改名 `p09-home-all`。
- [ ] **Step 3: `bun run verify`**(仓库根)绿。
- [ ] **Step 4: Commit** `test(app): Maestro 流程跟着一个主页改`

### Task 6: 文档

**Files:**
- Modify: `docs/reference/phone-wording.md`(终端状态并入同一套词;「一起做」不再是入口)、`apps/app/README.md`(页面结构)、设计稿 §4 U 表加进度一行

- [ ] **Step 1: 改文档**;**Step 2: Commit** `docs: 一个主页的用词与页面结构`
