# 一起做:回到某一轮(rewind)—— 设计

> 2026-10-21 · 状态:**定稿,可以开工**。对标任务 #2(Conductor checkpoints、Claude Code rewind;roadmap「对标三类产品挖出的任务」)。主人 10-20「继续开发,不要打扰我」⇒ 下面「待主人确认」一节按推荐项先做,主人可随时改。迁移占 **v81**。

## 为什么

一轮做坏了,现在只有两条路:逐个文件「撤回」(只认有 diff 的文本文件),或者整个丢掉独立工作区。对标的做法是 checkpoint:每轮结束记一个点,能整体回到那个点,后面的轮次撤掉。手机上尤其需要 —— 不想丢整个工作区,只想撤掉最后那一轮。

**成功的样子**:改动面板里一轮旁边「回到这一轮结束时」/ 最新一轮「撤掉这一轮」;确认框列出会撤掉哪几轮、多少文件;确认后工作区与分支回到那一刻,撤掉的轮次灰掉标「已撤掉」,能「撤销回退」;执行者下一轮被告知工作区回退了。

## 现状:现有快照不够

v62 的每轮「快照」是一份 JSON diff 报告(`finishGitReview` → `GIT_REVIEW_MIME` 制品,按 sha256 存),不是 git 对象:
- `headBefore/headAfter` 只是 `rev-parse HEAD`(分支尖),不代表工作区;
- 只给 UTF-8、≤256KB、非隐藏 / 非凭据的文本文件留 diff;二进制、点文件、超大文件都是 `not_reviewed`;有路径数 / 体积上限;
- 一轮没有可审改动 ⇒ 根本不存制品;两轮之间的变化(until 检查、setup 脚本、主人手改)不留痕;ignored 文件看不见。

`revertReviewFile` 也只对有 diff 的文本文件字节级恢复。把它倒着串起来做不到可靠回退。⇒ **v1 每轮要一个真的 checkpoint;没有 checkpoint 的旧轮次不能回退。**

## Checkpoint:每轮边界一个 commit 对象(只给独立工作区)

新模块 `src/core/workbench/checkpoints.ts`(异步 execFile,同 GitReader):
1. 对 **`wt.root`**(整个工作区,不是 task.path —— monorepo 里 task.path 可能是子目录)。
2. 临时 index 在仓库外(`GIT_INDEX_FILE=<stateDir>/tmp/cp-<rand>.index`),先拷真 index 借 stat 缓存,失败回落 `read-tree HEAD`。
3. `git add -A -- . ':(exclude,glob)**/.cc-workbench/**' ':(exclude,glob)**/.cc-workbench-inputs/**'` → `write-tree`。
4. `commit-tree <tree> -p HEAD --no-gpg-sign -m "cc checkpoint"`,身份用 `-c user.name=Tendhearth CC -c user.email=cc@localhost`。
5. `update-ref refs/tendhearth/checkpoints/<taskId>/<commit12> <commit>`(有 ref 才不会被 gc)。树与上一个 checkpoint 相同 ⇒ 复用。
6. 环境:`git-review.ts` 的 `gitEnv()`(摘 GIT_*、不读系统 / 全局配置)+ `GIT_INDEX_FILE`;`-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.autocrlf=false`;沿用 `GitReader.configure` 的过滤器中和(LFS clean/smudge 不跑)。**不跑钩子、不跑过滤器。**
7. 体积上限:`add` 前按 `status --porcelain -z --untracked-files=all` 估算;未跟踪 + 修改合计 > 200MB、单文件 > 50MB、路径 > 20k ⇒ 跳过并记原因,那一轮不可回退。

挂点:`GitBaseline.checkpoint`(这一轮开始)、`GitReview.checkpointBefore/After`;`parseGitReviewSnapshot` 保留并校验 40/64 位 hex。`service/artifacts.ts` 新 `takeBaseline(running)` 统一三处取基线(execute / inputs / retakeBaseline),只对有 worktree 记录的任务打 checkpoint。只有 not_reviewed 文件变了但 checkpoint 树变了也存制品(二进制轮不再隐身)。

## 回退

目标 `{artifactId, to:'end'|'start'}`:`end` = 回到这一轮结束时(checkpointAfter),`start` = 撤掉这一轮及之后(checkpointBefore,也覆盖第 1 轮;手机「撤掉这一轮」用它)。记目标 commit C、树 T、父 P(当时的分支尖)。

**前置(任何一条不过 ⇒ 拒绝,不做「尽量」)**
1. 只认独立工作区:有 worktree 记录且未删、任务未归档;`realpathSync.native(wt.root)` 在 `<stateDir>/worktrees/` 下、task.path 在 wt.root 下;`--git-dir ≠ --git-common-dir`(是 linked worktree,永远不是主人自己的检出);HEAD 在 `refs/heads/<wt.branch>`;没有 MERGE_HEAD / rebase / index.lock。
2. 没人占着文件夹:同 `revertReviewFile` 的闸门(writer_not_closed、reservations / writerOrphans 冲突 ⇒ `workbench_busy`)+ `executionConflict(wt.root)`。**例外**:这件事自己那条已答复、安静的保留会话 ⇒ 按 `closeForIdle` 的方式先关掉再重查。
3. 没有别的动作在碰工作区:setup / archive 没在跑、没在删(scripts 域加 `busy(id)`);run 开发服务允许但提示;until 检查没在跑(until 域加 `checking(id)`);没有未送达的 live input。
4. 目标有效:checkpoint 在(`cat-file -e C^{commit}`)、没被撤过、确实有东西可撤。
5. 不共用文件夹:还有别的未归档任务 `pathsConflict(task.path, wt.root)` 且有比 C 新的制品 ⇒ `rewind_shared_folder`(额度接手会在 source.path 上建兄弟任务)。
6. 要丢的提交没合回过项目:`P..HEAD` 里任何一个是主人项目 HEAD 的祖先 ⇒ `rewind_merged`;在 `refs/remotes/*` 里只在预览里提示。

**预览 + 确认**(同 restartToken 的两步):预览先把当前完整状态打成 checkpoint B(树 TB、父 = 当前 HEAD),回 `token = sha256({taskId, C, TB, HEAD, discardedIds})`、会撤掉的轮次、`diff-tree -r --name-status T TB` 的文件摘要(计数 + 至多 50 个路径)、`extraChanges`(TB 相对最后一轮 checkpointAfter:主人手改 / 检查输出这类)、`ignoredUntouched: true`、会话怎么处理、goal 状态。没带 / 过期 token ⇒ 409 `rewind_confirmation_required` / `rewind_confirmation_stale`。最后一轮之后的额外改动**不拒绝**:预览里列出、要 token、备份进 B。

**执行**(同步段,保原子,同 worktreeAction):
1. 重查前置,重算 TB 对 token。
2. 备份:`update-ref refs/tendhearth/rewind/<taskId>/<ms> B`(B 的父保住旧 HEAD)。
3. 工作区:临时 index `read-tree TB` 后 `read-tree -m -u TB T`(两树切换:增删、模式、软链都对;ignored 与 .cc-workbench* 不在两棵树里 ⇒ 不碰)。
4. 分支:`update-ref refs/heads/<branch> P <oldHEAD>`(CAS);真 index `read-tree P`(不带 -u)。
5. 校验:新临时 index 重建工作区树必须 = T;快照里列出的文件对 afterSha256。
6. 第 2 步之后任何失败 ⇒ 反向切回(`read-tree -m -u <current> TB` + update-ref 回旧 HEAD),报 `rewind_failed`,事件里写备份 ref。

**撤销回退**:同一套流程,目标 = B。v1 只能撤最近一次回退,且之后没有新的审阅轮次(否则 `rewind_undo_stale`,备份 ref 留着手工恢复);撤销本身也先备份。

**已知限制**:真 index 的暂存状态不恢复(重置到 P);子模块内容不更新;`.gitattributes` 的 eol 仍生效(Windows 上是 git 等价,不保证字节等价);从不 `reset --hard`、`clean`、跑钩子或过滤器。

## 数据:标「已撤掉」,不删(迁移 v81)

```sql
CREATE TABLE IF NOT EXISTS workbench_rewinds (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES workbench_tasks(id) ON DELETE CASCADE,
  target_artifact_id TEXT NOT NULL, target_point TEXT NOT NULL CHECK(target_point IN ('start','end')),
  target_commit TEXT NOT NULL, prior_head TEXT NOT NULL,
  backup_ref TEXT NOT NULL, backup_commit TEXT NOT NULL,
  discarded_json TEXT NOT NULL,
  notice_sent_at INTEGER, created_at INTEGER NOT NULL, undone_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS workbench_rewinds_task ON workbench_rewinds(task_id, created_at);
```
表存在守卫同 v80。`store.rewinds`:record / latest / discarded / pendingNotice / markNoticed / undo,都 bump。

- 制品与审阅标记不动(不可变,可能已推到微信)。`reviewList` 每轮加 `discarded?`、`rewindable:{start,end}`;对已撤掉的轮 mark / return / revert ⇒ `review_round_discarded`。
- 时间线加一条 system 事件「已回到第 N 轮结束时,撤掉了第 N+1–M 轮(可撤销)」。
- **执行者(v1)保留原会话,下一轮开头告诉它**:`execute.ts` 拼请求处前置「【工作区已被主人回到第 N 轮结束时】第 N+1–M 轮的文件改动已撤销、分支回到 <P7>;那几轮你做过的改动都不在了,以磁盘现状为准,先重新查看再继续。」dispatch 返回后 markNoticed;派发失败 ⇒ 下次还带。回退总是在没有活会话时完成 ⇒ 下一句一定走 start → execute。
- until-goal:状态不动、不退还轮数(上限是安全预算);passed 的那一轮被撤 ⇒ 只加一条说明;检查在跑 ⇒ 拒绝回退。
- 额度接手:由「不共用文件夹」拒掉;接手的目标任务没有 worktree 记录,不提供回退。
- 微信 `changesReply` 与手机 `latestChanges` 跳过已撤掉的轮。
- 删工作区时清 `refs/tendhearth/checkpoints/<taskId>/*` 与 `refs/tendhearth/rewind/<taskId>/*`。

## 入口

- **桌面**:改动面板每轮一个按钮(非最新轮「回到这一轮结束时」、最新轮「撤掉这一轮」)+ 预览确认块;撤掉的轮灰显「已撤掉」,最近一次回退旁「撤销回退」。路由 `GET /v1/workbench/rewind-preview?id&artifactId&to`、`POST /v1/workbench/rewind`({id, artifactId, to, token} 或 {id, undo});五处登记(routes-workbench + mappedError、route-tiers admin、token-registry routeAllow、workbench-proxy、lib.rs 两处)。
- **手机 / App**:只给最新一轮「撤掉这一轮」(to:'start')+ 确认页;`GET/POST /m/api/matter/rewind`,只给设备令牌(不进 LINK 路由);protocol 的 `PhoneChangesTurn` 加 `rewindable? / discarded?`。
- **微信**:v1 不开,只修 changesReply 跳过已撤掉的轮。
- service.ts 已到 171 行上限:公开面挂在现有那一行,域在 `service/rewind.ts`。

## 切片

1. **checkpoint**(无迁移、无界面、无行为变化给主人):checkpoints.ts、GitBaseline/GitReview 字段与解析、takeBaseline 三处、checkpointAfter 写入、删工作区时清 ref。
2. **回退核心 + v81**:rewind.ts、service/rewind.ts、store.rewinds、审阅闸门、execute 里的告知、scripts.busy / until.checking、微信 / 手机跳过已撤掉的轮、三处迁移测试。
3. **桌面**:路由五处 + 面板。
4. **手机**:路由、协议、App。

## 待主人确认(先按推荐做)

1. checkpoint / 备份放主人仓库的 `refs/tendhearth/…`(同 `cc/<id>` 分支所在;gc 安全,`git log --all` 看得见)—— 推荐;删工作区时一并清。
2. 回退自动关掉这件事自己那条安静的保留会话 —— 推荐(否则手机要等 ~10 分钟)。
3. 最后一轮之后的额外改动:确认后撤掉、先备份 —— 推荐(不拒绝)。
4. 执行者:保留原会话 + 一句告知 —— 推荐(另起会话以后再说)。
5. until-goal:回退后保持 active、不退还轮数 —— 推荐。
6. 没有 checkpoint 的旧轮次:不可回退 —— 推荐(不做反向 diff 兜底)。
7. 手机 v1 只有「撤掉这一轮」,「撤销回退」只在桌面;微信以后再说。
8. 体积上限 200MB / 50MB / 20k 路径。
9. 真 index 的暂存状态不恢复(重置到那一轮的 HEAD)。
