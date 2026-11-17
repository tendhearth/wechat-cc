# 管家的屋子 · 第 1 步:daemon 名单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** daemon 算出一张「在做」名单(一件事 + 没挂进事的终端会话),桌面经 `GET /v1/roster`、手机经 `GET /v1/roster`(设备令牌) 与 hub 主题 `roster` 拿到,三端以后只用这一套分组规则。

**Architecture:** 状态判定(`statusOf` / `statusOfMatter` / `terminalStatusKey`)从 App 搬进协议包,daemon 和 App 共用;名单本身是 `src/domain/roster.ts` 里的纯函数 `buildRoster`,由 `src/features/roster/` 的读取器从 MatterStore、工作台、终端登记处、看过记录取数据后调用。只读投影,不加迁移。

**Tech Stack:** Bun + TypeScript,zod(协议包),bun:test。

**Spec:** `docs/superpowers/specs/2026-11-17-butler-layout-design.md` §4.1

## Global Constraints

- 分组 / 状态键只认 `packages/protocol/src/status-table.ts` 的 `STATUS_TABLE`;名单不带任何本地化文字(端上查表)。
- 进名单:`task`、`terminal` 事 → `kind:"matter"`;无 `matter_id` 的 CLI 会话 → `kind:"terminal"`;**`act` 与 `chat` 不进**(主人 10-31 定「CC 自己做的事不混排」,`apps/app/src/view/home.ts` 现行规则)。
- 归档的事、`ended` 的终端会话不进;`back` 组只收 `now - 24h` 以内。
- 排序:waiting(按等待开始时间升序)→ working(按 updatedAt 降序)→ back(unseen 在前,再按 updatedAt 降序)。
- `unseen` 只对 matter 行:`back` 组且 `matterSeen(id, updatedAt) === null`;终端行恒 false。
- 手机令牌(device / link):matter 先过 `phoneMayOpenMatter`;**link 令牌回 403 `forbidden`**(短链接不看名单);终端行的 `project` 只给目录名(沿用 `phoneCliSession`)。
- 不加迁移;下一个迁移号保持 v117 不动。
- 主 Mac 只跑 `bun run verify`,不跑 Playwright。

## Review Focus

1. 一条终端会话既有 `matter_id`、那件事又是 `terminal` kind:只出一行(matter 行),不能出两行 —— Task 2 加用例。
2. 任务事已完成但还有遗留的待批请求(权限卡没撤):应算 waiting,不算 back —— Task 2 加用例(`pending>0` 优先)。
3. 工作台 `detail()` 对某件抛错(刚被清掉):整张名单照常返回、那件按 matter 行自己的 state 判 —— Task 3 加用例。
4. 终端会话 stale(登记处已折算):仍列,status 用折算后的值 —— Task 2 加用例。
5. 没有任何活着的事:返回 `{items:[]}`,不是 404 / 503 —— Task 3 加用例。

---

### Task 1: 状态判定进协议包 + 名单的线上类型

**Files:**
- Create: `packages/protocol/src/status-of.ts`
- Create: `packages/protocol/src/status-of.test.ts`(从 `apps/app/src/view/status.test.ts` 搬 `statusOf` / `statusOfMatter` / `terminalStatusKey` 的用例,原文件留剩下的)
- Modify: `packages/protocol/src/index.ts`(导出)
- Modify: `apps/app/src/view/status.ts`(三个函数改为 `export { … } from '@wechat-cc/protocol'`,其余不动)
- Modify: `packages/protocol/src/api.ts`(加 `RosterItem` / `RosterResponse`)
- Test: `packages/protocol/src/status-of.test.ts`、`packages/protocol/src/shape.test.ts`

**Interfaces:**
- Produces:
  - `statusOf(task: {status:string; phase?:string}, pending:number): StatusKey`
  - `statusOfMatter(matter, task|null|undefined, pending:number): StatusKey`(签名同现 App 版)
  - `terminalStatusKey(s:'waiting'|'running'|'idle'|'ended'): StatusKey`
  - `RosterItem`(zod):`{ key:string; kind:'matter'|'terminal'; id:string; title:string; project?:string; group:'waiting'|'working'|'back'; status:StatusKey; agents:{id:string; name?:string; current:boolean}[]; relay?:{index:number; total:number}; waiting?:{kind:'permission'|'question'; requestId:string; summary:string; count:number}; quiet:boolean; updatedAt:number; unseen:boolean; terminal?:{sessionId:string; code:string; liveWindow?:boolean; actionable?:boolean} }`
  - `RosterResponse = { items: RosterItem[]; version: string }`

- [ ] **Step 1:** 搬测试到 `status-of.test.ts`,import 改指协议包新文件;跑 `bun test packages/protocol/src/status-of.test.ts`,预期 FAIL(模块不存在)。
- [ ] **Step 2:** 建 `status-of.ts`,把三函数原样搬过去(它们只依赖 `StatusKey`、`MatterStateT`,都在协议包);App 的 `status.ts` 改成再导出。
- [ ] **Step 3:** 在 `api.ts` 加 `RosterItem` / `RosterResponse`;`shape.test.ts` 加一条:一个最小合法 RosterItem 能 parse、`group:'done'` 被拒。
- [ ] **Step 4:** `bun test packages/protocol apps/app/src/view` 全绿;`bun run typecheck` 退出码 0(别 grep 输出,看退出码)。
- [ ] **Step 5:** commit `协议包:状态判定共用 + 名单的线上类型`

### Task 2: 纯函数 `buildRoster`

**Files:**
- Create: `src/domain/roster.ts`
- Test: `src/domain/roster.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `statusOfMatter` / `terminalStatusKey` / `RosterItem`
- Produces:
```ts
export interface RosterInput {
  matters: Array<{ id:string; kind:string; title:string; state?:MatterStateT; archivedAt?:number|null; updatedAt:number; agents?:string[]; agentNames?:Record<string,string>; project?:string|null }>
  tasks: Map<string, { status:string; phase?:string }>          // 工作台里还活着的任务
  pending: Map<string, Array<{ kind:'permission'|'question'; id:string; summary:string; since:number }>>
  relays: Map<string, { index:number; total:number; currentAgent:string }>
  terminals: Array<{ session_id:string; code:string; source:string; displayName?:string; status:'running'|'waiting'|'idle'|'ended'; project:string; last_summary:string|null; last_event_at:number; matter_id?:string; live_window?:boolean; pending:{ since:number; actionable?:boolean }|null }>
  seen: (matterId:string, sinceMs:number) => string | null
  now: number
}
export const ROSTER_BACK_WINDOW_MS = 24 * 3_600_000
export function buildRoster(input: RosterInput): RosterItem[]
```
`quiet` = working 且 `now - updatedAt > QUIET_AFTER_MS`(协议包已有常量)。`agents[].current`:有 relay 时只有 `currentAgent` 为 true;没有 relay 时全部 true。terminal 事的 `agents` 用其会话的 `source`。

- [ ] **Step 1: 写失败用例**(每条一个 `it`,断言用具体值):
  - `task 事在跑 ⇒ group working、kind matter、key "matter:<id>"`
  - `task 事有 2 条待批 ⇒ waiting,waiting.count 2,waiting.requestId 为 since 最早那条`
  - `已完成的 task 事仍有待批 ⇒ waiting 不是 back`(Review Focus 2)
  - `act / chat / 归档的事不出现`
  - `terminal 事与它的会话只出一行 matter 行,agents=[{id:"claude",current:true}]`(Review Focus 1)
  - `无 matter_id 的 running 会话 ⇒ kind terminal、key "terminal:<session_id>"、terminal.code 带上`
  - `ended 会话不出现;stale 会话按折算后的 status 出现`(Review Focus 4)
  - `back 只收 24 小时内:25 小时前完成的不出现`
  - `relay {index:2,total:3,currentAgent:"codex"} ⇒ relay 带上,agents 里只有 codex current`
  - `working 31 分钟没动 ⇒ quiet true`
  - `back 组未看过的排在看过的前面;seen 回 "phone" ⇒ unseen false`
  - `排序:waiting 按等待开始升序 → working 按 updatedAt 降序 → back`
- [ ] **Step 2:** `bun test src/domain/roster.test.ts`,预期 FAIL。
- [ ] **Step 3:** 实现 `buildRoster`(纯函数,不读时钟、不碰 IO)。
- [ ] **Step 4:** 同命令全绿。
- [ ] **Step 5:** commit `名单:纯函数 buildRoster(分组 / 排序 / 去重 / 看过)`

### Task 3: 读取器 + 路由 `GET /v1/roster`

**Files:**
- Create: `src/features/roster/reader.ts`、`src/features/roster/routes.ts`
- Test: `src/features/roster/routes.test.ts`
- Modify: 注册路由的地方(与 `mattersRoutes` 同一处,`src/daemon/internal-api/routes.ts`);`src/features/phone/legacy-routes.ts` 加别名 `'GET /v1/roster' → GET /v1/roster`(照 `/m/api/matters` 那条写);`packages/protocol/src/routes.ts` 与 `desktop-calls.ts` / `phone-calls.ts` 的路由登记(守卫 `scripts/phone-routes.guard.test.ts` 会要求)
- Modify: `src/daemon/wiring/` 里装配 internal-api deps 的那份,给 `roster` 读取器接上 matters store、workbench、cli hub、`makeMatterSeen`、relay 读口(`features/workbench/service/relay.ts` 里读当前棒的函数)

**Interfaces:**
- Consumes: Task 2 `buildRoster`
- Produces:
  - `makeRosterReader(deps: { matters: Pick<MatterStore,'list'>; workbench?: Pick<WorkbenchService,'list'|'attention'|'detail'>; terminals: () => CliSessionView[]; seen: MatterSeen; relay?: (matterId:string) => {index:number;total:number;currentAgent:string}|null; executorName?: (id:string)=>string; now?: () => number }): { read(scope:'operator'|'device'): RosterResponse }`
  - `version` = 名单稳定序列化后的短哈希(给桌面 `If-None-Match` / `etag` 用)
  - 路由:operator / device → 200 `RosterResponse`;link → 403 `{error:'forbidden'}`;读取器抛 → 503 `{error:'unavailable'}`;请求带 `If-None-Match` 等于 version → 304

- [ ] **Step 1: 失败用例**(`routes.test.ts`,用假 store / 假工作台 / 假终端列表):
  - `operator 拿到 items 与 version`
  - `device 看不到别人聊天的事`(经 `phoneMayOpenMatter`)
  - `link 令牌 403`
  - `If-None-Match 命中 ⇒ 304`
  - `工作台 detail 对某件抛错 ⇒ 仍 200,那件按 matter state 判`(Review Focus 3)
  - `没有活着的事 ⇒ 200 {items:[]}`(Review Focus 5)
- [ ] **Step 2:** 跑,预期 FAIL。
- [ ] **Step 3:** 实现读取器与路由;装配接线;别名与路由登记。
- [ ] **Step 4:** `bun test src/features/roster scripts/phone-routes.guard.test.ts` 全绿。
- [ ] **Step 5:** commit `名单:GET /v1/roster(手机别名 /v1/roster,短链接 403)`

### Task 4: hub 主题 `roster` + 终端会话的变化提示

**Files:**
- Modify: `packages/protocol/src/routes.ts`(`PHONE_TOPIC_NAMES` 加 `'roster'`)
- Modify: `src/features/phone/phone-topic-sources.ts`(加 roster 来源;`makePhoneEventsWiring` 的 poke 规则里 `roster` 跟随 matter 变化、`matter`/`cli` 提示)
- Modify: `src/lib/write-hints.ts`(`WriteHint` 加 `{ kind:'cli'; sessionId:string }`)
- Modify: `src/adapters/store/cli-session-store.ts`(写会话行时:有 matter 照旧 hint matter,**另外**一律 hint `cli`)
- Test: `src/features/phone/phone-topic-sources.test.ts`、`src/adapters/store/cli-session-store.test.ts`、`scripts/phone-routes.guard.test.ts`

**Interfaces:**
- Consumes: Task 3 `makeRosterReader(...).read('device')`
- Produces: 主题 `roster` 快照 `{ version: string; waiting: number; working: number }`(只带摘要,端上收到再拉 `/v1/roster`)

- [ ] **Step 1: 失败用例:**
  - `phoneTopicAllowed('roster') === true`
  - `roster 来源快照 = {version, waiting, working}`,与读取器同一 version
  - `终端会话 upsert(无 matter)⇒ 发出 {kind:'cli'} 提示`;`有 matter ⇒ matter 与 cli 两条都发`
  - `cli 提示 ⇒ 只 poke roster 主题`
- [ ] **Step 2:** 跑,预期 FAIL。
- [ ] **Step 3:** 实现;`deps` 加可选 `roster?: () => RosterResponse`,缺省时快照抛 `roster_unavailable`(同 topics 写法)。
- [ ] **Step 4:** `bun test src/features/phone src/adapters/store/cli-session-store.test.ts scripts/phone-routes.guard.test.ts` 全绿。
- [ ] **Step 5:** commit `名单:hub 主题 roster,终端会话变化也提示`

### Task 5: 收尾验证与 PR

- [ ] **Step 1:** `bun run verify` 全绿(只跑牵连到的 + 守卫)。
- [x] **Step 2:** 设计稿 §4.1 的 act 规则已与本计划对齐(不进)。
- [ ] **Step 3:** push 分支,开 PR 到 dev。PR 描述写:主人 11-17 授权本次界面重排(「都可以改,甚至推倒重来……按照你的建议」);本 PR 只加 daemon 名单、界面不变;`## 删掉/放松的测试`:无(status 用例是搬家,条数不少);不是修 bug,不带红/绿。
- [ ] **Step 4:** 等 PR 三平台 CI 绿,发给整合者(wechat-cc-24)合入。
