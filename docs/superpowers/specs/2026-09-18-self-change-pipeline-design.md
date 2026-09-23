# 自改流水线:CC 自己给自己做一次改动

日期:2026-09-18。承接 `2026-09-18-self-maintenance-design.md`(自维护三件套)与 `2026-09-18-ci-triage-design.md`(CI 闸门叶子)。对应「LLM 自动化开发和维护 CC」缺口清单的第 7 项(流水线原语)+ 第 8 项(护栏)+ 第 5 项(CI 信号)。

## 一句话

`wechat-cc self change "<需求>"`(或主人在微信说「自改 <需求>」)让 CC 在**自己的专用克隆**里,用 Claude 执行者实现改动,依次过五道闸门(本地测试 → 评审 → CI → 主人拍板 → 合 dev),然后在 daemon 之外完成 `self deploy` + `selftest`,不过就回滚,全程进展发到主人微信。

## 为什么是这个形状

- **流水线跑在 daemon 外面的 CLI 进程里**,和 `self deploy` 同一层:最后一步要重启 daemon,daemon 里的状态机会被自己杀掉。daemon 只做两件事:从微信接单后 `spawn(detached)` 这个进程;给这个进程提供「发通知」和「问主人 y/n」两条路由。
- **实现步骤直接起 `claude -p`,不走工作台。** 工作台的 Claude 会话强制 `plugins: []`、`disableAllHooks`,拿不到 superpowers(brainstorming → writing-plans → SDD 子代理评审),而这几天四个功能全靠这套流程的质量。`claude -p` 不带 `--bare` 时插件照常加载、Task 子代理可用、`--max-budget-usd` / `--max-turns` 封顶、`--output-format json` 给 `session_id` 和费用、`--resume` 做修复轮。代价:桌面工作台面板看不到这个会话;补偿是主人 `~/.claude/settings.json` 里已装的 `wechat-cc hook`(Stop 钩子)会照常把会话完成推到微信,`看 码` 也能用。
- **专用克隆,不碰任何人类工作树。** `~/Documents/tendhearth/` 下有多个 checkout,主人可能正在其中一个上干活。流水线只在 `<workdir>/repo`(默认 `~/Library/Caches/wechat-cc/self-change/repo`)里操作,不在 STATE_DIR 下(执行者在 `--dangerously-skip-permissions` 下跑,不能离钥匙一个 `..`),不在 tmpdir(克隆要复用)。
- **一次只跑一条。** 锁文件 `STATE_DIR/self-change/lock`(含 pid);第二条进来报 `self_change_busy`。

## 非目标

- 不做 Codex / Cursor / agy 执行者的适配(接口留出:`ImplementRunner`,v1 只有 claude)。
- 不做「进件口」的其他来源(selftest 定时红、外发健康报警);v1 只有 CLI 与微信「自改」。
- 不做 master 合并与发版:`dev → master` 仍是主人的 PR。
- 不做 Windows / Linux:`self deploy` 是 launchd 专属,流水线整体 darwin-only(其他平台 `self_change_unsupported_platform`,退出码 2)。
- 不做多条并行、不做 hunk 级评审、不做桌面面板。

## 流程与闸门

```
intake ─► repo ─► implement ─► guard ─► tests ─► review ─► push+ci ─► approval ─► merge ─► deploy ─► selftest ─► report
                     ▲            │ fix ◄──┘ fix ◄──┘    fix ◄──┘
                     └────────────┴────────────────────────┘   (每处最多 N 轮,见「修复轮」)
```

每一步是 `src/cli/self-change/steps/*.ts` 里一个纯函数 `(ctx, deps) => Promise<StepResult>`,状态写进 `STATE_DIR/self-change/<id>.json`;`--resume <id>` 从 `state.step` 继续。

1. **intake**:生成 `id`(8 位 hex)、写 state、`holdBusy` 不需要(进程在 daemon 外),但要向 daemon 报一句 `POST /v1/self-change/notice`「自改 #id 开始:<需求>」。日配额检查(`max_per_day`,按 state 目录里当天的记录数)、停机检查(`halted_at`)。
2. **repo**:没有克隆就 `git clone <repo_url> repo`;有就 `git fetch origin`。`git checkout -B self/<id> origin/<branch>`。`bun install --frozen-lockfile`。克隆里若有脏改动(上次中断留下的)⇒ `git reset --hard && git clean -fd`(这是流水线自己的克隆,没有人类改动可丢)。
3. **implement**:`claude -p` 在克隆里跑,prompt = 需求 + 系统追加提示(见下);要求执行者**自己提交**。结束后检查:`git status --porcelain` 干净且 `origin/<branch>..HEAD` ≥ 1 个提交,否则 `no_changes`(不进修复轮,直接失败——没有改动没什么可修)。
4. **guard**:`git diff --name-only origin/<branch>...HEAD` 与禁改清单求交,非空 ⇒ `forbidden_paths` 失败,列出文件。禁改清单是代码常量,不是配置:
   - `.github/workflows/publish-update.yml`、`.github/workflows/mirror-desktop-tag.yml`、`.github/workflows/desktop.yml`(能发版的)
   - `scripts/publish-update*.ts`、`scripts/update-hosting.json`
   - `apps/desktop/src-tauri/tauri.conf.json`(签名 / 更新源)
   - `src/cli/self-change/policy.ts`(禁改清单和缺省值本身)
   - `src/cli/self-deploy.ts`(回滚配方)
5. **tests**:在克隆里依次 `bun run typecheck`、`bun run depcheck`、`bun run test`、`npm run test:node -- --reporter=dot`,每条带超时(缺省 20 分钟)。任一红 ⇒ 修复轮:把失败输出尾巴(≤ 200 行,去 ANSI)作为 `--resume <session>` 的 prompt 交回实现会话,再从 guard 重来。
6. **review**:**新会话**的 `claude -p`,`--disallowedTools Edit,Write,MultiEdit,NotebookEdit`,prompt = 需求 + `git diff origin/<branch>...HEAD` 的说明 + 输出契约(最后一个 ```json 块:`{ "verdict": "approve" | "changes", "findings": [{ "severity": "critical" | "important" | "minor", "file", "line", "summary" }] }`)。评审后检查克隆仍干净、HEAD 未动;脏了 ⇒ `git checkout -- . && git clean -fd`,verdict 按 `changes` 处理并加一条 finding「评审会话改了文件」。`critical` / `important` ⇒ 修复轮(交给实现会话 `--resume`),再从 guard 重来;只有 `minor` 或 `approve` ⇒ 通过,minor 带进拍板卡。解析不出 JSON ⇒ 视作 `changes`,finding 是原文前 20 行。
7. **push + ci**:`git push -u origin self/<id>`(强推允许:分支是流水线私有的);`runCiTriage({ sha, branch: 'self/<id>', wait: true, rerun: true })`。`green` ⇒ 过;`flake` 已由 triage 重跑;`real` / `unknown` ⇒ 修复轮(prompt 是 triage 的人读输出),再从 guard 重来。CI 要在 `self/**` 分支上跑:`ci.yml` 的 `push.branches` 加 `self/**`。
8. **approval**:`POST /v1/self-change/ask` 把拍板卡发到主人微信(内容:需求、分支、改动文件数与前 15 个、测试摘要、评审 verdict + 残余 minor、CI 链接、费用、`回「y <码>」合并并部署,「n <码>」放弃`),然后轮询 `GET /v1/self-change/decision?hash=`。`allow` ⇒ 继续;`deny` ⇒ `declined`,分支保留 24 小时后由下次运行清理;`timeout`(缺省 24 小时)⇒ state 停在 `approval`,进程退出码 4,`--resume` 会重新发卡。
9. **merge**:`git fetch origin` → `git rebase origin/<branch>`(冲突 ⇒ `git rebase --abort`,失败 `merge_conflict`,分支保留)→ 若 rebase 动了 HEAD 则**不重跑 CI**(记录 `ci_sha ≠ merge_sha` 到报告里;这是 v1 的取舍:dev 上并发提交少,rebase 后重跑 CI 会让主人再等一轮)→ `git checkout <branch> && git reset --hard origin/<branch> && git merge --ff-only self/<id>` → `git push origin <branch>` → `git push origin --delete self/<id>`。
10. **deploy**:克隆里 `cd apps/desktop && bun run build-sidecar`,然后进程内调 `planSelfDeploy({ repoRoot: <克隆> })` + `executeSelfDeploy`。失败(自带回滚)⇒ `deploy_failed`,`fail_streak++`。
11. **selftest**:进程内 `runWorkbenchSelftest({ executor: selftest_executor })` 与 `runChatSelftest({ provider: selftest_provider, resume: true })`。任一 FAIL ⇒ `executeSelfDeploy` 从 `<sidecar>.prev` 回滚,`selftest_failed_rolled_back`,`fail_streak++`。**代码已经在 dev 上了**——回滚只回二进制;报告里明确写「dev 上的提交需要人处理」。
12. **report**:一条微信 + state `done`;`fail_streak` 归零。

**修复轮**:tests / review / ci 三处各自独立计数,各最多 2 轮;超了 ⇒ 失败(`tests_exhausted` / `review_exhausted` / `ci_exhausted`),分支保留供人看。

**停机**:`fail_streak ≥ 2`(deploy 或 selftest 连续两次失败)⇒ `agent-config.self_change.halted_at` 写入,后续运行在 intake 就拒绝(`self_change_halted`),直到 `wechat-cc self change --unhalt`。

## 执行者调用(v1:claude)

```
claude -p --output-format json --dangerously-skip-permissions \
  --max-budget-usd <implement_budget_usd> --max-turns <max_turns> \
  --append-system-prompt-file <brief.md> "<需求>"
```

- cwd = 克隆;env = `workbenchSubprocessEnv(process.env)` 再删掉 `CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT`(不然从 Claude Code 会话里起流水线会被嵌套守卫拒绝);`windowsHide: true`;stdout 全收(json 一行),stderr 尾巴 200 行进 state。
- 结果解析:`{ session_id, result, total_cost_usd, num_turns, is_error, subtype }`;`is_error` 或 `subtype` 不是 `success` ⇒ 步骤失败,原文进 state。
- 修复轮:`claude -p --output-format json --dangerously-skip-permissions --resume <session_id> --max-budget-usd <剩余> "<修复说明>"`。
- 评审:同上但新会话、`--disallowedTools Edit,Write,MultiEdit,NotebookEdit`、`--max-budget-usd <review_budget_usd>`。
- 系统追加提示(`brief.md`,由流水线生成到 `<workdir>/briefs/<id>.md`):你在 wechat-cc 的专用克隆里、分支 `self/<id>`;先读 `AGENTS.md` 与 `docs/maintainer/README.md`;只在这个目录里改;禁改清单;必须自己 `git commit`(可多次),不要 push,不要改分支;结束时用一段话说明改了什么、怎么验的;可用 superpowers 的 brainstorming / writing-plans / subagent-driven-development;不要发微信、不要碰 `~/.claude/channels`。

`ImplementRunner` 接口:`run(input: { cwd, prompt, systemPromptFile, budgetUsd, maxTurns, resume?: string, readOnly?: boolean }) => Promise<{ ok, sessionId, text, costUsd, turns, stderrTail }>`。v1 实现 `claudeRunner(deps)`。

## daemon 侧

新路由(admin;进 `ROUTE_MIN_TIER` 与 operator `routeAllow`,不进 lib.rs / workbench-proxy):

- `POST /v1/self-change/notice` `{ text }` → `adapter.sendMessage(ownerChatId, text)`;没有主人 chat ⇒ 409 `owner_chat_unknown`。
- `POST /v1/self-change/ask` `{ prompt, timeoutMs }` → `PendingPermissions.register(hash, timeoutMs, { chatId: owner, prompt })`,发卡(复用 ilink-glue 里现成的「回 y <码>」卡片文案函数),返回 `{ hash, code }`。
- `GET /v1/self-change/decision?hash=` → `{ decision: 'pending' | 'allow' | 'deny' | 'timeout' }`。daemon 侧要把 `register()` 返回的 promise 结果缓存到一张 `Map<hash, decision>`(TTL 1 小时),因为 `PendingPermissions.consume()` 之后条目就没了。
- 微信「自改 <需求>」(admin 命令,`makeAdminCommands` 里加):校验是主人;spawn detached(源码模式 `bun cli.ts self change --json --from wechat "<需求>"`,打包版 `<execPath 同目录>/wechat-cc-cli …`;找不到 ⇒ 回「这台机器没法自改:<原因>」);env 用 `workbenchSubprocessEnv`;回「自改 #<id> 开始了,进展发这里」。`自改 状态` ⇒ 列最近 5 条 state 的 `id · step · 结果`。

## 配置(`agent-config.json`,全部可选)

```ts
self_change?: {
  repo_url?: string            // 缺省:源码模式取 `git remote get-url origin`;打包版必填
  branch?: string              // 'dev'
  workdir?: string             // ~/Library/Caches/wechat-cc/self-change
  implement_budget_usd?: number // 20
  review_budget_usd?: number    // 5
  max_turns?: number            // 300
  max_per_day?: number          // 5
  approval_timeout_h?: number   // 24
  selftest_executor?: string    // 'claude'
  selftest_provider?: string    // 'claude'
  halted_at?: number; halt_reason?: string; fail_streak?: number
}
```

## CLI

```
wechat-cc self change "<需求>" [--json] [--from wechat] [--budget-usd N] [--no-deploy]
wechat-cc self change --resume <id>
wechat-cc self change list
wechat-cc self change --unhalt
wechat-cc ci triage [...]        # 见 ci-triage 设计;流水线在进程内调它的 runCiTriage
```

退出码:0 done;1 失败(任何 `*_failed` / `*_exhausted` / `forbidden_paths` / `no_changes` / `merge_conflict`);2 平台不支持 / daemon 没起 / 停机 / 配额;3 `declined`;4 `approval_timeout`(可 `--resume`)。`--no-deploy`:合完 dev 就结束(用于只想让 CC 提交代码的场景),报告里注明「未部署」。

## 状态文件

`STATE_DIR/self-change/<id>.json`:

```ts
{ id, request, from: 'cli' | 'wechat', branch: 'self/<id>', baseSha, step, startedAt, updatedAt,
  implement: { sessionId, costUsd, turns, rounds: { tests: 0, review: 0, ci: 0 } },
  review: { sessionId, costUsd, verdict, findings },
  ci: { runId, url, verdict, sha }, approval: { hash, code, decision, askedAt },
  merge: { sha, rebased }, deploy: { ok, version }, selftest: { workbench, chat },
  result?: 'done' | 'declined' | 'approval_timeout' | '<失败码>', error?: string, stderrTail?: string[] }
```

## 验证

- 单测:每个 step 用注入的 `exec` / `fs` / `fetch` / `runner` 假件;guard 的禁改清单、review 的 JSON 解析(含无 JSON、多块、脏工作树)、修复轮计数、退出码、日配额、停机、锁。
- 集成测(`src/cli/self-change/run.integration.test.ts`):真 git(临时 bare 远端 + 克隆),`ImplementRunner` 是一个会改文件并提交的假件,tests 假件第一次红第二次绿,review 假件返回一条 important 再 approve,ci / approval / deploy / selftest 假件;断言 dev 分支 ff 合入、`self/<id>` 远端删除、state 逐步推进、通知文本序列。
- 真机 dogfood:`bun cli.ts self change "在 docs/maintainer/ci-and-flakes.md 的 flake 表里加一行 …"`,拍板用 `POST /v1/permissions/resolve`(桌面同款),看它合进 dev、部署、自检全绿;再跑一次 `--no-deploy` 的。主人验收:微信里说「自改 …」,只回「y <码>」。

## 与其他文档

- `docs/maintainer/self-change.md`(新):怎么用、闸门、退出码、停机与 `--unhalt`、禁改清单、费用。README / AGENTS.md 加一行入口。
- `docs/superpowers/specs/2026-09-18-ci-triage-design.md`:triage 改为 `wechat-cc ci triage` 子命令(纯逻辑 `src/cli/ci-triage.ts`,登记表 `src/cli/ci-flakes.json`),不再是 `scripts/ci/`;`ci.yml` 的 push 分支加 `self/**`。

## 修订记录

- **2026-09-19 实现偏差与 v1.1a / v1.1b(真机两跑之后)**
  - CLI:`self change --list` 是开关不是子命令;新增 `--approve <id>` / `--deny <id>`(读存盘里的 hash,走 `POST /v1/permissions/resolve`)。
  - 拍板:daemon 侧不再用 `askUser` 的失败即删 —— glue 自己 register + 发卡,微信发不出去(`errcode=-2`)登记项也保留,`ask` 多返回 `delivered`;approval 步一拿到 hash 就落盘(不然 `--approve` 看不到);`--resume` 先清掉上次的 result。
  - 修复轮范围纪律:tests 闸门失败文件与本次改动无关就先重跑一次(只对两条 vitest 命令);修复轮提示词禁止改无关测试 / 超时 / 配置;评审把越界记 `scope:<file>`(important),修复轮对这些文件是**还原**不是修,文件名要与本次 diff 相交才算数;为本次改动新增的测试与夹具不算越界。
  - CI 闸门:`ci triage` 退 2 ⇒ `ci_unavailable`,不算修复轮;`--wait` 期间 gh 连错 3 次才放弃。
  - 部署 / 自检的异常也算失败(bump `fail_streak`);拍板超时钳在 [1h, 48h];禁改清单扩到 `.github/workflows/**`(例外 `ci.yml`)与 `package.json`。
  - selftest:保留会话的执行者(claude)续接走 `POST /v1/workbench/input`,且要等到新的 text 事件;收了工的(cursor)才走 `continue`(409 重试)。
  - 未做:deny 后分支 24h 自动清理;通知发送失败只 log;拍板临近超时时重问会 400;`apps/desktop/package.json` 在 build-sidecar 期间可被改。
