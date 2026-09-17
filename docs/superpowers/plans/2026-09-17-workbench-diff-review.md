# 逐文件 diff 审阅(桌面)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务详情多一个「改动」面板:按回合逐文件看 diff,每个文件可「接受」或「打回」(打回 = 一条续接要求)。

**Architecture:** 采集不动(租约边界快照,`git-review.ts`)。加一张标记表(v62)+ store;service 聚合快照与标记(`reviewList`)、写标记(`markReviewFile`)、打回组文本交 `continueTask`(`returnReviewFiles`);三条内部 API(五处登记);桌面复用 `renderWorkbenchCodeReview` 的逐文件渲染,加面板、按钮与内联打回表单。

**Tech Stack:** TypeScript / Bun 1.3.14 + Node 24(vitest)、SQLite(runtime/sqlite 适配层)、桌面 vanilla JS(Tauri 2,Rust 放行清单)。

**Spec:** `docs/superpowers/specs/2026-09-17-workbench-diff-review-design.md`

## Global Constraints

- 仓库 `/Users/nategu_mac_company/Documents/tendhearth/wechat-cc-cc-kit`,分支 `dev`;不碰兄弟工作树。
- 测试 `bun --bun vitest run <paths>`;全量 `bun run test`;Node `npm run test:node`;`bun run typecheck`;`bun run depcheck`(0 errors)。业务代码不 import `bun:*`。
- **采集逻辑与 `git-review.ts` 一行不改**;`service-review-boundary.test.ts`、`git-review.test.ts`、`workbench-code-review.test.ts` 原样通过。
- 新迁移 = v62;三处锁一起改(`state-migration.test.ts` 61→62 + 注释;`migration-order.test.ts` 指纹表加 `62: '<失败输出里的指纹>'`;`db.test.ts` 若有 `toBe(61)` 改 62;若 `db.test.ts` 的升级用例做整行 `toEqual`,新表不影响它们)。
- 新路由登记**五处**:`route-tiers.ts`(admin)、`token-registry.ts` operator 放行(紧跟 `'POST /v1/workbench/unattended-ack'`)、`token-registry.test.ts` 精确集合同位置、`apps/desktop/src-tauri/src/lib.rs` `matches!` 与 ~L1376 测试表、`apps/desktop/workbench-proxy.ts` `ROUTES`。
- diff 文本全部按不可信文本转义;不引入 diff / 高亮库。
- 提交信息中文,末尾两行:`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_0192qR5eDp28Cz3Xg66oEu6c`。每任务:相关测试绿 → typecheck → 提交。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/lib/db.ts` | v62 `workbench_review_marks` |
| `src/core/workbench/review-marks.ts`(新) | `makeReviewMarkStore(db)`:`list / set` |
| `src/core/workbench/store.ts` | 挂 `reviewMarks`;`set` 后 bump |
| `src/core/workbench/review.ts`(新) | 纯函数:`parseGitReviewSnapshot(bytes)`、`composeReturnText(files, comment)` |
| `src/core/workbench/service.ts` | `reviewList` / `markReviewFile` / `returnReviewFiles` |
| `src/daemon/internal-api/routes-workbench.ts` + 五处登记 | 三条路由 |
| `apps/desktop/src/modules/workbench-review-panel.js`(新) | 面板渲染纯函数 + 摘要 |
| `apps/desktop/src/modules/workbench.js` | 拉取、渲染位置、按钮与内联表单的动作、签名 |
| `docs/cc-workbench.md` | 修订记录 |

---

### Task 1: 迁移 v62 + 标记 store

**Files:**
- Modify: `src/lib/db.ts`(migrations 末尾,v61 之后)、三处锁测试
- Create: `src/core/workbench/review-marks.ts`
- Modify: `src/core/workbench/store.ts`(挂 `reviewMarks`,`set` 后 `bump`)
- Test: `src/core/workbench/review-marks.test.ts`(新)、`src/lib/db.test.ts`(加一条表存在)

**Interfaces:**
```ts
export interface ReviewMark { taskId:string; artifactSha256:string; path:string; afterSha256:string|null; mark:'accepted'|'returned'; comment:string; createdAt:number }
export function makeReviewMarkStore(db:Db): { list(taskId:string): ReviewMark[]; set(input: Omit<ReviewMark,'createdAt'>): ReviewMark }
// store.reviewMarks = makeReviewMarkStore(db) 包一层:set 在同一事务内 bump(taskId)
```

- [ ] **Step 1: 失败的测试**

```ts
// src/core/workbench/review-marks.test.ts
import { describe, it, expect } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeWorkbenchStore } from './store'
describe('review marks', () => {
  it('同一快照同一文件只保留最新标记;写后任务 version 递增', () => {
    const db = openTestDb(), store = makeWorkbenchStore(db)
    const t = store.create({ title: 't', path: '/p', providerId: 'codex', ownerChatId: 'o' })
    const v = store.version(t.id)
    const a = store.reviewMarks.set({ taskId: t.id, artifactSha256: 'a'.repeat(64), path: 'src/x.ts', afterSha256: 'b'.repeat(64), mark: 'accepted', comment: '' })
    expect(a.mark).toBe('accepted'); expect(store.version(t.id)).toBe(v + 1)
    store.reviewMarks.set({ taskId: t.id, artifactSha256: 'a'.repeat(64), path: 'src/x.ts', afterSha256: 'b'.repeat(64), mark: 'returned', comment: '改一下' })
    const list = store.reviewMarks.list(t.id)
    expect(list).toHaveLength(1); expect(list[0]!.mark).toBe('returned'); expect(list[0]!.comment).toBe('改一下')
    expect(store.version(t.id)).toBe(v + 2)
  })
  it('按任务隔离;afterSha256 可为 null', () => {
    const db = openTestDb(), store = makeWorkbenchStore(db)
    const t1 = store.create({ title: 't', path: '/p', providerId: 'codex', ownerChatId: 'o' }), t2 = store.create({ title: 'u', path: '/q', providerId: 'codex', ownerChatId: 'o' })
    store.reviewMarks.set({ taskId: t1.id, artifactSha256: 'a'.repeat(64), path: 'gone.ts', afterSha256: null, mark: 'accepted', comment: '' })
    expect(store.reviewMarks.list(t2.id)).toEqual([]); expect(store.reviewMarks.list(t1.id)[0]!.afterSha256).toBeNull()
  })
})
```
- [ ] **Step 2: 跑,确认失败**
- [ ] **Step 3: 实现** —— db.ts v62(照 v61 的 `(db)=>{ db.exec(`CREATE TABLE IF NOT EXISTS workbench_review_marks (…) STRICT;`) }`,SQL 见 spec §1);`review-marks.ts`:`INSERT … ON CONFLICT(task_id,artifact_sha256,path) DO UPDATE SET after_sha256=excluded.after_sha256, mark=excluded.mark, comment=excluded.comment, created_at=excluded.created_at RETURNING …`;store 里 `reviewMarks:{ list:marks.list, set:(input)=>db.transaction(()=>{ const row=marks.set(input); bump(input.taskId); return row })() }`。
- [ ] **Step 4: 跑** —— 新测试 + `src/lib/db.test.ts src/lib/migration-order.test.ts src/lib/state-migration.test.ts`(按输出改三处锁)+ `src/core/workbench/store.test.ts` + typecheck
- [ ] **Step 5: 提交** —— `v62:workbench_review_marks(逐文件审阅标记)+ store.reviewMarks`

---

### Task 2: service —— `reviewList` / `markReviewFile` / `returnReviewFiles`

**Files:**
- Create: `src/core/workbench/review.ts`
- Modify: `src/core/workbench/service.ts`(返回对象新增三个方法;`artifact()` 附近)
- Test: `src/core/workbench/review.test.ts`(纯函数)、`src/core/workbench/service-review.test.ts`(新)

**Interfaces:**
```ts
// review.ts
export interface ReviewTurnFile extends ReviewFile { mark?: { mark:'accepted'|'returned'; comment:string; createdAt:number } }
export interface ReviewTurn { artifactId:string; sha256:string; name:string; createdAt:number; status:GitReview['status']; headBefore:string|null; headAfter:string|null; preexistingPaths:string[]; notes:string[]; files:ReviewTurnFile[] }
export function parseGitReviewSnapshot(bytes:Buffer): GitReview | null      // JSON.parse + 结构校验(version 1, scope, files 数组, 每项 path/kind 合法);坏 ⇒ null
export function composeReturnText(files: Array<{path:string; diff?:string}>, comment:string, limits?:{maxLinesPerFile?:number; maxTotalChars?:number}): string
//   格式见 spec §2;默认每文件 60 行、总长 6000;超出截断并加「(已截断)」
// service:
reviewList(id:string): ReviewTurn[]
markReviewFile(id:string, input:{artifactId:string; path:string; mark:'accepted'|'returned'; comment?:string}): ReviewMark
returnReviewFiles(id:string, input:{artifactId:string; paths:string[]; comment:string; inputRequestId?:string}): WorkbenchTaskView
```
- [ ] **Step 1: 失败的测试** —— `review.test.ts`:`parseGitReviewSnapshot` 接受一份合法快照、拒绝 `{}`/错 version/非数组 files;`composeReturnText` 含路径、意见、每文件截到 60 行、总长 ≤ 6000 且带「已截断」。`service-review.test.ts`(用 `openTestDb` + 真 store + `makeWorkbenchService` + 假 provider,照 `service-unattended.test.ts` 的 fixture,含 shutdown/removeTempDir):
  - 手工往任务塞两份 review 成果(`saveArtifactSnapshot`,mime `GIT_REVIEW_MIME`,内容用 `serializeGitReview` 生成的 JSON 或直接 JSON 字符串)+ 一份坏 JSON ⇒ `reviewList` 返回 3 轮,新→旧,坏的 `status:'unavailable'` 且 notes 非空;
  - `markReviewFile` 对 `kind:'not_reviewed'` 的 path 抛 `review_file_unmarkable`;对不存在的 path 抛 `invalid_review_reference`;对别的任务的 artifactId 抛 `not_found`;成功后 `reviewList` 的该文件带 `mark`;
  - `returnReviewFiles`:两个 path + 意见 ⇒ 两个 `returned` 标记;续接文本(从 `detail(id).events` 最后一条 `user` 事件读)含两个路径、意见与 diff 节选;任务重新排队并跑完(`vi.waitFor` 到 completed);`paths` 空或 >20 / `comment` 空 ⇒ `invalid_review_reference`。
- [ ] **Step 2: 跑,确认失败**
- [ ] **Step 3: 实现** —— `reviewList`:`store.artifacts(id)` 过滤 `mime===GIT_REVIEW_MIME`(已是 created_at DESC),逐个 `readArtifactSnapshot` + `parseGitReviewSnapshot`,失败 ⇒ `{…, status:'unavailable', files:[], notes:['快照无法读取或已损坏']}`;把 `store.reviewMarks.list(id)` 按 `sha256+path` 合上。`markReviewFile`:`store.artifact(id, artifactId)`(不属于 ⇒ not_found)→ 解析 → 找 path → 门控 → `store.reviewMarks.set`。`returnReviewFiles`:校验 → 逐个 set `returned` → `composeReturnText` → `service.continueTask(id, text, { inputRequestId })`(内部直接调同对象的方法)。
- [ ] **Step 4: 跑** —— `bun --bun vitest run src/core/workbench` + typecheck
- [ ] **Step 5: 提交** —— `工作台 service:逐文件审阅(reviewList / markReviewFile / returnReviewFiles ⇒ 续接)`

---

### Task 3: 三条路由 + 五处登记

**Files:** `routes-workbench.ts`、`routes-workbench.test.ts`、`route-tiers.ts`、`token-registry.ts`(+test)、`lib.rs`(两处)、`apps/desktop/workbench-proxy.ts`(+test)

- [ ] **Step 1: 失败的测试**(照本文件 `start(service(...))` + `request` 的写法;fake service 加 `reviewList: vi.fn(()=>[])`, `markReviewFile: vi.fn(()=>MARK)`, `returnReviewFiles: vi.fn(()=>TASK)`):`GET /v1/workbench/review?id=deadbeef` ⇒ 200 `{reviews:[]}`;缺 id / 坏 id ⇒ 400;`POST review-mark` 校验(`mark` 只认两值、`path` 非空 ≤ 4096、`comment` ≤ 2000)⇒ 200 `{mark}`;`POST review-return` 校验(`paths` 1–20 个字符串、`comment` 非空)⇒ 202 `{task}`;service 抛 `review_file_unmarkable` / `invalid_review_reference` ⇒ 400;`workbench_busy` ⇒ 409;trusted token ⇒ 403;tier 测试三条 admin;token-registry 精确集合三条(紧跟 unattended-ack);`workbench-proxy.test` 三条放行。
- [ ] **Step 2: 跑,确认失败**
- [ ] **Step 3: 实现**(`mappedError` 加两条 400 映射;三条 handler;五处登记;`cargo check`)
- [ ] **Step 4: 跑** —— `bun --bun vitest run src/daemon/internal-api apps/desktop/workbench-proxy.test.ts` + typecheck
- [ ] **Step 5: 提交** —— `内部 API:GET /v1/workbench/review、POST review-mark、POST review-return;五处放行`

---

### Task 4: 桌面「改动」面板

**Files:**
- Create: `apps/desktop/src/modules/workbench-review-panel.js` + `.test.js`
- Modify: `apps/desktop/src/modules/workbench.js`(状态 `state.reviews`、拉取、渲染位置、动作、`structuralSignature` 输入)、`apps/desktop/src/modules/workbench-live.js`(`structuralSignature` 加 `detail.reviewMarksSignature`?—— 改为:签名加 `state.reviewsSignature`,由 `workbench.js` 在拉到 reviews 后计算 `JSON.stringify(reviews.map(r=>[r.sha256, r.files.map(f=>[f.path,f.mark?.mark])]))`)、`workbench-execution.js`(两条文案:`review_file_unmarkable`、`invalid_review_reference`)、`apps/desktop/src/styles/workbench.css`(面板样式,复用 `.wb-review-diff`)
- Test: `workbench-review-panel.test.js`、`workbench.test.ts`(controller 级)

**Interfaces(`workbench-review-panel.js`,纯函数,不碰 document):**
```js
export function reviewSummary(reviews)                    // {turns, files, accepted, returned}
export function renderReviewPanel(reviews, opts)          // opts={escapeHtml, formatTime, renderDiff:(file)=>html, openFiles:Set<string>} ⇒ <details id="wb-review">…;每轮 <section data-review-turn="<sha256>">;每文件 <details id="wb-review-<sha8>-<idx>" data-review-disclosure data-review-file-path="…">,徽章、标记、按钮 data-action="review-accept|review-return" data-artifact-id data-path(not_reviewed 无按钮);内联打回表单 <form data-action="review-return-submit" data-artifact-id> 含 checkbox(name="paths")+textarea(name="comment")
export function reviewsSignature(reviews)
```
`renderDiff` 由 `workbench.js` 提供:复用 `workbench-code-review.js` —— 导出一个 `renderReviewFileDiff(file, escapeHtml)`(把现有逐文件 `<pre class="wb-review-diff">` 的那段抽成函数,原 `renderWorkbenchCodeReview` 调它,行为不变)。

- [ ] **Step 1: 失败的测试** —— 面板:两轮 + 标记 ⇒ 摘要数字、徽章文本、`not_reviewed` 无按钮、已接受的文件按钮变「已接受」且仍可打回、XSS 转义(路径含 `<script>`);controller:选中任务后拉 `/v1/workbench/review?id=`;点接受 ⇒ `POST review-mark` 且重画;打回表单提交 ⇒ `POST review-return` 带勾选的 paths + comment ⇒ 成功后表单清空;拉取失败 ⇒ 面板显示「改动记录暂时读不到」而详情照常;`reviewsSignature` 变 ⇒ `structuralSignature` 变。
- [ ] **Step 2: 跑,确认失败**
- [ ] **Step 3: 实现**(渲染位置:`artifactHtml` 之前;`state.reviews` 随 `selectTask` 与结构性重画后刷新;`mutate` 复用)
- [ ] **Step 4: 跑** —— `bun --bun vitest run apps/desktop` + typecheck + `cd apps/desktop && bun x playwright test`(118)
- [ ] **Step 5: 提交** —— `桌面工作台:「改动」面板,逐文件 diff、接受 / 打回(打回 ⇒ 续接)`

---

### Task 5: 文档、全量、推送、CI(部署与真机由控制者做)

- [ ] `docs/cc-workbench.md` 修订记录末尾:
```md
- **2026-09-17**：逐文件 diff 审阅。任务详情新增「改动」面板：按回合列出租约边界的变更快照（采集逻辑不变），逐文件展开 diff，每个文件可「接受」或「打回」；打回 = 一句意见 + 该文件 diff 节选组成一条续接要求（`POST /v1/workbench/review-return` ⇒ `continueTask`，同一道门）。标记持久化在 `workbench_review_marks`（v62），跨表面经长轮询同步。`GET /v1/workbench/review?id=`、`POST /v1/workbench/review-mark`。设计：`docs/superpowers/specs/2026-09-17-workbench-diff-review-design.md`。
```
- [ ] `bun run test` → `npm run test:node` → `bun run typecheck` → `bun run depcheck`(负载抖动单跑即绿,报告里列)
- [ ] 提交、`git push origin dev`、`gh run watch`(Windows 超时 ⇒ `--failed` 重跑至多两次)

---

## Self-review

- 覆盖:§1 T1;§2 T2;§3 T3;§4 T4;错误处理 T2/T3/T4;测试各任务;文档 T5。
- 类型一致:`ReviewTurn`/`ReviewTurnFile`(T2 → T4 读同形状);`ReviewMark`(T1 → T2/T3);错误码 `review_file_unmarkable` / `invalid_review_reference`(T2/T3/T4);路由名三条五处一致。
- 未决:`continueTask` 在 T2 内部调用时需要 `inputRequestId` —— 没给就 `randomUUID()`;`returnReviewFiles` 若 `continueTask` 抛错,标记已写(接受这个不一致:标记是"我想打回",续接失败桌面会显示错误,主人可重试)。
