# 逐文件 diff 审阅(桌面)设计

日期:2026-09-17。状态:主人授权连做(diff 审阅 → ACP 评估),中途不打扰;实施用子代理驱动。

## 背景

工作台已经在**租约边界**(派活时取基线、答复时截差异、续接时重取基线、结算时再截)把代码变更存成成果:一份 `application/vnd.cc.workbench-review+json`(`src/core/workbench/git-review.ts` 的 `GitReview`,逐文件 `path / kind / preexisting / beforeSha256 / afterSha256 / diff`),内容寻址存到 `workbench_artifacts`。桌面已经能**逐文件**渲染这份 JSON(`workbench-code-review.js`,每个文件一个 `<details data-review-file>` + 手写的 hunk 着色),但它藏在「成果」列表里,要先点开那件成果;而且只有整份成果的「确认这份成果」,没有逐文件的接受 / 打回。

主人的目标:桌面在电脑前也能当主工具。「看不到改动、不能逐文件接受或打回」是第二块拼图。

## 目标

- 任务详情有一个「改动」面板:按回合列出这次任务的所有变更快照,每个快照逐文件展开看 diff;`partial / unavailable / preexisting / not_reviewed` 照实标注,不把"没展开"说成"没改"。
- 每个文件两个动作:**接受**(标记)与**打回**(写一句意见 ⇒ 变成一条续接要求发回执行者)。标记跨表面持久化,长轮询里实时刷新。
- 快照的**采集逻辑一行不动**(租约边界语义、缓存、上限、脱敏),现有「成果」面板与整份确认也保留。

**不做**:逐 hunk 接受;在编辑器里改 diff;微信端的改动视图(后续可加 `任务 <id> 改动`);实时(非 git)的逐工具文件 diff(执行者事件里刻意不带补丁)。

## 组件

### 1. 标记表(迁移 v62)

```sql
CREATE TABLE IF NOT EXISTS workbench_review_marks (
  task_id TEXT NOT NULL, artifact_sha256 TEXT NOT NULL, path TEXT NOT NULL,
  after_sha256 TEXT, mark TEXT NOT NULL CHECK(mark IN ('accepted','returned')),
  comment TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  PRIMARY KEY(task_id, artifact_sha256, path)
) STRICT;
```
一份快照里的一个文件只有一个当前标记(再标就覆盖);快照按内容 sha 而不是 artifact id 键(同内容去重后 id 可能复用)。`store.reviewMarks`:`list(taskId)`、`set({taskId, artifactSha256, path, afterSha256, mark, comment})`,写后 bump 任务 seq(详情可见 ⇒ bump)。

### 2. 服务层(`service.ts`)

- `reviewList(id): ReviewTurn[]` —— 读该任务所有 mime 为 `GIT_REVIEW_MIME` 的成果(新→旧),`readArtifactSnapshot` 解析成 `GitReview`,每个文件附上当前标记;返回 `{artifactId, sha256, name, createdAt, status, headBefore, headAfter, preexistingPaths, notes, files:[{...ReviewFile, mark?: {mark, comment, createdAt}}]}`。解析失败的快照返回 `status:'unavailable'` 加一条 note,不抛。
- `markReviewFile(id, {artifactId, path, mark:'accepted'|'returned', comment?})` —— 校验:成果属于该任务且 mime 正确;`path` 在快照里且 `kind !== 'not_reviewed'`(否则 `review_file_unmarkable`);写标记;`touched(id)`。
- `returnReviewFiles(id, {artifactId, paths[], comment, inputRequestId?})` —— 校验后组一段续接文本交给 `continueTask(id, text, {inputRequestId})`(同一道门:未确认的免审执行者、租约、状态都由它判),**续接成功之后**才给每个 path 写 `returned` 标记(`continueTask` 抛了就一条不写);重发同一个 `inputRequestId` 走 `continueTask` 的幂等分支,再写一遍同样的标记无妨:
  ```
  打回以下改动,请按意见修改:
  - <path>
  意见:<comment>

  --- <path> ---
  <该文件 diff 的前 60 行,总长 ≤ 6000 字>
  ```
  `comment` 必填(≤ 2000 字);`paths` 1–20 个;返回 `continueTask` 的结果。`continueTask` 抛什么就抛什么(`workbench_busy` 等照旧映射)。

### 3. 内部 API

- `GET /v1/workbench/review?id=` ⇒ `{reviews: ReviewTurn[]}`。
- `POST /v1/workbench/review-mark {id, artifactId, path, mark, comment?}` ⇒ `{mark}`。
- `POST /v1/workbench/review-return {id, artifactId, paths, comment, inputRequestId?}` ⇒ 202 `{task}`。
- 全部 admin 档;新路由登记**五处**(route-tiers、token-registry + 精确集合测试、lib.rs 两处、`apps/desktop/workbench-proxy.ts`)。错误:`review_file_unmarkable` / `invalid_review_reference` ⇒ 400;其余沿用 `mappedError`。

### 4. 桌面

- 任务详情在「成果」之前加 `<details id="wb-review" class="wb-disclosure">`「改动」:摘要 `N 轮 · M 个文件 · 已接受 a · 已打回 r`。每轮一组:标题「第 k 轮 · 时间 · 状态(完整 / 部分 / 不可用)」;文件行 = 种类徽章 + 路径 + `开始时已有修改` + 标记徽章(已接受 / 已打回)+ 按钮「接受」「打回」(`not_reviewed` 无按钮);展开 = 现有 `renderWorkbenchCodeReview` 的逐文件 diff 渲染(复用其 `<span data-line>` 输出,不引入 diff 库)。
- 「打回」点开一行内联表单(意见 textarea + 「发回」/「取消」),可勾选同一轮的多个文件一起打回;发回 ⇒ `POST /v1/workbench/review-return` ⇒ 成功后清空表单,任务进入续接(长轮询会把新回合刷出来)。
- 「接受」⇒ `POST /v1/workbench/review-mark`。标记变化经 seq bump 进长轮询;`structuralSignature` 加入 review 标记摘要,变了整页重画。
- 数据来源:选中任务时和每次结构性重画前拉 `GET /v1/workbench/review?id=`(与 detail 并行,失败不挡详情)。展开状态沿用 `[data-review-disclosure]` 的保持机制。

## 数据流

答复 ⇒ 快照落库(不变)⇒ seq bump ⇒ 桌面长轮询 ⇒ 结构签名变(artifacts 变)⇒ 整页重画 ⇒ 拉 `review` ⇒ 「改动」面板列出新一轮 ⇒ 主人逐文件看 / 接受 / 打回 ⇒ 打回 = 标记 + `continueTask` ⇒ 执行者续跑 ⇒ 下一轮快照。

## 错误处理

- 快照缺失 / 损坏 ⇒ 该轮 `unavailable` + note,不影响其它轮。
- 打回时任务忙(`workbench_busy`)/ 已归档 / 免审未确认 ⇒ 原错误码透传,桌面用现有的 `executionErrorMessage` 展示(补两条文案)。
- 标记的 `after_sha256` 与快照不符(重放旧 artifactId)⇒ 以快照为准写入;不做二次校验。

## 测试

- 迁移 v62 三处锁;`store.reviewMarks` 覆盖写与 bump。
- service:`reviewList` 聚合两轮快照并附标记、坏快照 ⇒ unavailable;`markReviewFile` 拒绝 `not_reviewed` 与不属于该任务的成果;`returnReviewFiles` 组出的文本包含路径、意见、diff 节选且长度受限,并真的调用 `continueTask`(用假 provider 跑通一轮);`service-review-boundary.test.ts` 原样通过。
- 路由三条 + 五处登记;桌面:面板渲染(徽章、按钮门控、汇总)、接受 / 打回的请求与重画(controller 级,假 `invoke`)、`structuralSignature` 含标记。Playwright 118 不变。

## 修订记录

- 2026-09-17:初稿。
- 2026-09-17:打回改为续接成功后才写标记(评审:restart_confirmation_required 是设计内的首次回应,标记先落会常态化"已打回但没发出")。
- 2026-09-17:按计划落地(任务 1–4);偏离:面板只就地展开最近三轮、共用一份预览额度;长轮询空转不重拉改动记录;打回表单的勾选与意见都在重画间保留。
