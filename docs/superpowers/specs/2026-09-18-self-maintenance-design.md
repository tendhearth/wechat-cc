# 自维护三件套:selftest、self deploy、maintainer 手册 设计

日期:2026-09-18。状态:主人「好」;子代理驱动,中途不打扰。

## 背景

这几天四个功能的闭环里,单测一个真 bug 都没抓到,全靠真机 smoke;而 smoke 全是控制器临时写的 Python 脚本、拿 operator token 戳内部 API;部署是手工换 sidecar,`cp` 原地覆盖会让新二进制持续 SIGKILL;学到的规矩都在控制器的私人记忆里,仓库里没有。要让任何 LLM(包括 CC 自己)能跑完「改 → 部署 → 验 → 回滚」,这三段要变成仓库里的命令与文档。

## 目标

1. `wechat-cc selftest workbench|chat`:daemon 在跑的前提下,对指定执行者 / provider 做一次真机闭环并给出机器可读的结论;不发微信、不碰主人的聊天记忆、不改主人的默认 provider。
2. `wechat-cc self deploy`:把本地构建的 sidecar 原子换进 .app、重启 daemon、健康门,不过就自动回滚到上一版并把 launchd 的退出原因与 stderr 尾巴打出来。
3. `docs/maintainer/`:部署 / 验证 / CI 与 flake / 迁移 / 真机规矩 五份 runbook + 仓库根 `AGENTS.md` / `CLAUDE.md` 指过去;spike 抓到的 ACP 原始报文脱敏后作为 fixture 进仓库,配一个回放契约测试。

**不做**:Windows / Linux 的 `self deploy`(只做 launchd);对话侧 selftest 走真微信;新的 token 档(用现有 file token 读 health、operator token 驱动工作台、daemon 内部代 spawn 做测试对话)。

## 组件

### 1. daemon:测试对话路由 `POST /v1/selftest/converse`

- 请求 `{ providerId: string, text: string, resumeSessionId?: string }`(admin 档;operator routeAllow 加进去;新路由登记处:`route-tiers.ts`、`token-registry.ts` + 精确集合测试;桌面不调,`lib.rs` / `workbench-proxy.ts` 不加)。
- 实现 `src/daemon/selftest.ts`:
  ```ts
  export interface SelftestConverseResult { ok: boolean; providerId: string; sessionId: string | null; texts: string[]; toolCalls: string[]; error?: string; errorCode?: string; durationMs: number }
  export async function runSelftestConverse(deps: { registry: ProviderRegistry; mintSessionToken: (tier: UserTier, key: string, opts?: { routeAllow?: ReadonlySet<string> }) => string; invalidateSession: (key: string) => void; stateDir: string; log: (tag: string, line: string) => void }, input: { providerId: string; text: string; resumeSessionId?: string; timeoutMs?: number }): Promise<SelftestConverseResult>
  ```
  步骤:`registry.get(providerId)` 没有 ⇒ `{ok:false, error:'unavailable_provider'}`;`sessionKey = 'selftest/' + randomUUID()`;`mintSessionToken('trusted', sessionKey, { routeAllow: new Set(['GET /v1/health']) })`(测试对话里的 wechat MCP 只能 ping,发不了消息);`spawn({ alias: 'selftest', path: <stateDir>/selftest/project(不存在就 mkdir + 空 README) }, { tierProfile: TIER_PROFILES.trusted, permissionMode: 'dangerously', chatId: sessionKey, mcpEnv: sessionAuthEnv('trusted', token), appendInstructions: '这是一次自检对话。回答要短。', ...(resumeSessionId ? { resumeSessionId } : {}) })`;`collectTurn(session.dispatch(text), { timeoutMs })`;`session.close()`(3s 上限,超时记日志不抛);`invalidateSession(sessionKey)`;组装结果。`timeoutMs` 缺省 120_000。
- 接线:`InternalApiDeps.selftestConverse?: (input) => Promise<SelftestConverseResult>`,`main.ts` 用 thunk-over-bootRef(`bootRef?.registry`、`internalApi.mintSessionToken` / `invalidateSession`)接;路由在 `routes-daemon-control.ts`:校验 `providerId` 合法 id、`text` 非空 ≤ 4000、`resumeSessionId` 可选字符串 ≤ 500;未接线 503 `selftest_not_wired`;结果 200 原样(`ok:false` 也是 200,错误在 body 里)。

### 2. CLI `wechat-cc selftest`(`src/cli/selftest.ts`)

```
wechat-cc selftest workbench --executor <id> [--image] [--resume] [--json] [--timeout-ms N]
wechat-cc selftest chat --provider <id> [--text "…"] [--resume] [--json]
```
- 读 `STATE_DIR/internal-api-info.json`:`baseUrl`、`tokenFilePath`(file token,读 `/v1/health`)、`operatorTokenFilePath`(operator token,驱动工作台与 selftest 路由)。缺 ⇒ 退出码 2,「daemon 没在跑」。
- **workbench**:
  1. scratch 项目 `STATE_DIR/selftest/wb-<ts>`:mkdir、`README.md`、`git init` + 一次提交(git 缺失 ⇒ 跳过 git,记 warning)。
  2. `--image` ⇒ 生成 120×120 红色方块 PNG(纯 zlib 手写,不依赖库),`POST /v1/workbench/attachment { id: uuid, draftId: uuid, name:'square.png', mime:'image/png', base64 }`。
  3. `POST /v1/workbench/create { path, providerId, title:'selftest', text, draftId?, attachmentIds? }`;text 缺省「先运行 shell 命令 `uname -a` 并把输出原样告诉我，然后在项目里新建 hello.txt，内容一行 hello，然后结束。」;`--image` 时 text = 「附带的图片里画的是什么颜色的方块？只回答颜色，不要做别的。」。
  4. 轮询 `GET /v1/workbench/task?id=&since=&wait_ms=20000`(长轮询);每张 `permissions[]` 里的待决请求 ⇒ `POST /v1/workbench/permission { id, requestId, decision:'allow' }`;直到 `task.status ∈ {completed, failed, cancelled, interrupted}` 或 `phase==='replied'`;总超时 `--timeout-ms`(缺省 240_000)。
  5. `--resume` ⇒ `POST /v1/workbench/continue { id, text:'我上一句让你做的第一件事是什么？只回答一句。' }` 再轮询到答复。
  6. 检查项(每项 `{ name, ok, detail }`):`created`、`replied`(status completed / phase replied)、`text_seen`(至少一条 text 事件)、`activity_seen`(至少一条带 activity 的 tool_call;`--image` 时不要求)、`permission_roundtrip`(至少一张卡被放行;`--image` 时不要求)、`file_written`(`hello.txt` 存在且内容 `hello`;`--image` 时改为 `answer_mentions_red`:任一 text 含「红」)、`resume_replied`(`--resume` 时第二轮有 text)、`no_error_event`。
  7. 收尾:`POST /v1/workbench/archive { id, archived:true }`;scratch 目录保留(路径打印出来),`--keep` 之外默认删除。
- **chat**:`POST /v1/selftest/converse { providerId, text }`(text 缺省「调用 wechat 这个 MCP 服务器上的 ping 工具，把它返回的 daemon_pid 数字告诉我，不要做别的。」);检查项:`replied`(ok 且 texts 非空)、`tool_seen`(toolCalls 含 `wechat/ping`;`--text` 自定义时不要求)、`no_error`;`--resume` ⇒ 用第一轮的 `sessionId` 再发「我上一句让你调用的工具叫什么？只回答工具名。」,检查 `resume_replied`。
- 输出:人读版逐行 `✓ / ✗ name — detail`,末行 `PASS` / `FAIL`;`--json` ⇒ `{ ok, kind, target, checks:[…], taskId?, sessionId?, durationMs }`。退出码 0 / 1。
- 实现分层:`runWorkbenchSelftest(deps, opts)` / `runChatSelftest(deps, opts)` 纯逻辑,`deps = { fetch, readApiInfo, now, sleep, fs helpers }` 注入;`cli.ts` 只做参数与打印。

### 3. CLI `wechat-cc self deploy`(`src/cli/self-deploy.ts`)

```
wechat-cc self deploy [--binary <path>] [--app <path>] [--no-rollback] [--health-timeout-ms N] [--json]
```
- 只支持 darwin + launchd;别的平台退出码 2,说明只做了 macOS。
- 解析目标:`--app` 或从 `~/Library/LaunchAgents/com.wechat-cc.daemon.plist` 的 `ProgramArguments[0]`(`…/Contents/MacOS/wechat_cc_desktop` 或 `wechat-cc`)取 `Contents/MacOS/` ⇒ sidecar = `<dir>/wechat-cc-cli`。`--binary` 缺省 = `<repoRoot>/apps/desktop/src-tauri/binaries/wechat-cc-cli-<arch>-apple-darwin`(arch 由 `process.arch`:`arm64`→`aarch64`,`x64`→`x86_64`);源码模式下 repoRoot = cli.ts 所在目录。
- 计划(纯函数 `planSelfDeploy(input): SelfDeployPlan`,可测):
  1. `preflight`:新二进制存在、可执行、`--version` 退出 0(spawnSync,5s);输出版本串。
  2. `backup`:`<sidecar>` → `<sidecar>.prev`(`copyFile`,覆盖上一份)。
  3. `swap`:`copyFile(new, <sidecar>.new)` + `rename(<sidecar>.new, <sidecar>)` —— **必须换 inode**:原地 `cp` 覆盖会让内核沿用旧 inode 的签名缓存,新二进制持续 SIGKILL(exit 137,连 `--version` 都死,2026-09-17 真机)。`chmod 755`。
  4. `restart`:`launchctl kickstart -k gui/<uid>/com.wechat-cc.daemon`。
  5. `health`:等 `STATE_DIR/internal-api-info.json` 的 mtime 晚于 kickstart 时刻,再用 file token `GET /v1/health` 200 且 `version.cli` 等于 preflight 的版本(能拿到时)—— 上限 `--health-timeout-ms`(缺省 60_000)。
  6. 失败 ⇒ 若非 `--no-rollback`:`rename(<sidecar>.prev → <sidecar>)`(同样 copy+rename 换 inode)+ kickstart + 再等健康(同上限);无论回滚成败,打印 `launchctl print gui/<uid>/com.wechat-cc.daemon` 里的 `last exit reason` / `runs` 行与 `launchd.err.log` 尾 40 行(路径从 plist `StandardErrorPath` 取)。退出码 1;回滚也失败 ⇒ 3。
- 实现分层:`planSelfDeploy` 纯;`executeSelfDeploy(plan, deps)` 的 `deps = { spawnSync, fs, fetch, now, sleep, log }` 注入;真 `cli.ts` 传真实依赖。测试用 tmp 目录验证:swap 后 inode 变化(`statSync().ino` 不同)、健康失败触发回滚且原二进制内容恢复、`--no-rollback` 不回滚、非 darwin 退出 2。

### 4. 手册与 fixture

- `docs/maintainer/README.md`:一页索引 + 「LLM 维护者从这里开始」的最短路径(改 → `bun run test` → `self deploy` → `selftest` → 推 dev → 看 CI)。
- `docs/maintainer/deploy.md`:sidecar 构建、`self deploy` 用法、inode 陷阱、launchd 崩溃循环怎么看(`launchctl print`、`runs`、`OS_REASON_CODESIGNING`)、plist 指主二进制 `--daemon` 的原因(TCC)。
- `docs/maintainer/verify.md`:`selftest` 两种用法、operator token 与 file token 分别能到哪、待主人在场的检查清单(桌面逐字流、免审对话框、改动面板、微信真聊)。
- `docs/maintainer/ci-and-flakes.md`:三平台作业、Windows 排除清单的规矩(spawn 第一行拒绝 win32 的套件一律排除)、已知 flake 类别(probeBinaryVersion 3s、ECONNRESET、Windows hook 超时)与处置(先看是不是新文件,再 `gh run rerun --failed`)、`gh run list --commit` 要全 SHA。
- `docs/maintainer/migrations.md`:`user_version` 是计数、新迁移要改三处测试、指纹从失败输出里抄、foreign_keys 坑。
- `docs/maintainer/rules-from-real-machines.md`:真机抓到的规矩清单(MCP structuredContent 只能含 schema 声明的键;`promptCapabilities` 嵌在 `agentCapabilities` 下;凡照文档写的字段路径先对录到的报文;新路由登记五处;超时要给服务层让路;`close()` 要确认进程组退出;对话侧每条 text 事件一条微信;新后台长任务要持 holdBusy;bun:sqlite / bun:test 的 macOS-only 盲区;`gh run list --commit` 全 SHA)。
- 仓库根 `AGENTS.md` 与 `CLAUDE.md`(同一段内容):一句定位 + 指向 `docs/maintainer/README.md` + 三条硬规矩(只在 dev;master 只走 PR;不碰兄弟工作树)。
- fixture:`src/core/acp/fixtures/cursor-acp-2026-09-17.jsonl`,从 spike transcript 里取场景 `c1`、`c2shellreject`、`c4both`、`c5`、`c5load`(`dir` ∈ in/out),脱敏:`WECHAT_SESSION_TOKEN` 的 value ⇒ `<redacted>`;`/Users/<用户名>` ⇒ `/Users/owner`;`WECHAT_INTERNAL_TOKEN_FILE` 的 value ⇒ `/Users/owner/.claude/channels/wechat/internal-token`;`t` 字段保留。生成脚本 `scripts/acp-fixture-from-transcript.ts`(输入 transcript 路径,输出 fixture,幂等)。
- 回放契约测试 `src/core/acp/fixtures.test.ts`:读 fixture,对每条 `in` 的 `session/update` 过 `createAcpTranslator`(append 与 messages 两种)不抛;断言:`initialize` 结果 `agentCapabilities.loadSession === true` 且 `agentCapabilities.promptCapabilities.image === true`(钉住嵌套);`session/request_permission` 的 `options[].kind` ⊆ {allow_once, allow_always, reject_once};至少一条 `toolCallId` 含 `\n` 且 `acpActivityId` 清洗后不含;`agent_message_chunk` 全部没有 `messageId`;messages 模式回放 `c1` 得到恰好 2 条 text(工具调用前后各一条);`c4both` 里出现 `server:'wechat'`… 注意 spike 用的 server 名是 `spike-wechat`,断言 `tool:'ping'` 与 `server:'spike-wechat'`。

## 数据流

LLM 维护者:改代码 → `bun run test` → `bun run build-sidecar`(apps/desktop)→ `wechat-cc self deploy` → `wechat-cc selftest workbench --executor cursor --image --resume` / `selftest chat --provider cursor --resume` → 推 dev → CI。任何一步失败都有机器可读的输出,`self deploy` 失败自动回滚。

## 错误处理

- selftest:daemon 不在 ⇒ 2;检查失败 ⇒ 1 并列出失败项;每一步 HTTP 非 2xx 都算失败项,不抛。
- self deploy:preflight 失败不动任何文件;swap 失败(权限)⇒ 尝试删除 `.new`,退出 1;健康门失败 ⇒ 回滚。

## 测试

- selftest:纯逻辑 + 假 fetch(按 URL/method 回不同 body,记录调用序列):成功路径六项全 ✓;权限卡被放行;`--image` 生成的 PNG 头字节正确并进 upload body;`--resume` 走 continue;任务 failed ⇒ `replied` ✗ 且退出 1;daemon 不在 ⇒ 2。
- selftest converse 路由:未接线 503;参数校验 400;成功 200 原样透传;`runSelftestConverse` 用假 provider/registry:token 的 routeAllow 只有 health、close 被调、结果 texts/toolCalls 正确、provider 缺失 ⇒ ok:false。
- self deploy:上述四条 + plist 解析(两种主二进制名)+ 二进制路径推导。
- fixture 回放测试如上;生成脚本的幂等由同一 fixture 二次生成 diff 为空验证(手动)。
- 真机(控制器):`self deploy` 部署本轮构建;`selftest workbench --executor cursor --image --resume`、`selftest chat --provider cursor --resume` 全 PASS。

## 修订记录

- 2026-09-18:初稿。
