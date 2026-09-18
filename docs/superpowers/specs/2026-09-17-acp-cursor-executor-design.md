# ACP 客户端:Cursor 以 `cursor-agent acp` 进工作台 设计

日期:2026-09-17。状态:主人「go」授权实施(备忘 `2026-09-17-acp-evaluation.md` 的判定与真机 spike 结果是本设计的前提);实施用子代理驱动,中途不打扰。

## 背景

工作台今天把 Cursor 当「免审执行者」(`UNATTENDED_CAPABILITIES`,`cursor-agent -p --yolo`):看不到单步、拦不下任何操作、时间线只有文字、要主人在桌面确认一次。真机 spike(备忘末节)证明 `cursor-agent acp` 能给出:

- `session/request_permission`:shell 命令(`kind:"execute"`)每次弹卡,拒绝后**真的没跑**;
- `tool_call` / `tool_call_update`:每个工具调用有 id、kind、status、locations;
- `agent_message_chunk` 逐 token 文本(**没有 `messageId`**);
- `session/cancel` 4s 内落定,`session/load` 能接上同一会话;
- 不声明 `fs/*`、`terminal/*` 客户端能力,Cursor 仍自己落盘。

**但 cwd 内的文件编辑从不弹卡**(Cursor 自己的 allowlist 模式,ACP 面上没有开关)。所以 Cursor 走 ACP 是「命令有卡片、编辑仍免审」的**中间档**,不是与 Claude / Codex 同档。这一点必须对主人明说,不能靠标签暗示。

## 目标

- 工作台的 Cursor 执行者改由 ACP 客户端驱动:执行者列表不再标「免审」,不再要求一次性免审确认;命令逐次进权限卡(桌面 + 微信 y/n),时间线有逐条活动行(读 / 改 / 检索 / 命令 / 工具),逐字流照旧走 `DeltaCoalescer`。
- 每个任务开跑时在时间线记一条公开提示:「Cursor 通过 ACP 执行：命令会逐次请求批准；工作区内的文件编辑由 Cursor 直接执行，不经过权限卡。」
- `stop:'confirmed'` 语义保持:`close()` 必须确认进程组真的退出,否则抛错让服务层标「未确认退出」。
- agy 保持免审不动;对话侧(微信 `/cursor`、桌面「模型与后端」)的 print 模式 Cursor provider **一行不动**。
- **不删** `cursor-cli-provider.ts` 等(对话侧仍在用);备忘里「转完即删」指的是把 Cursor 的两条路都换掉之后,不在本轮。

**不做**:`elicitation`(spike 里 Cursor 一次没发;不声明该客户端能力,收到未知请求回 -32601);附件(`promptCapabilities.image:true` 但 `embeddedContext:false`,留待下一轮);模型 / 推理档选择(`session/set_config_option` 有,但目录接线是另一件事);`allow_always`(daemon 的权限桥是逐次布尔,永远只回 `allow_once` / `reject_once`);agy / gemini 的 ACP;向会话注入 MCP 服务器(工作台任务本来就不给执行者 wechat MCP —— Codex 适配器明确禁用、token 的 routeAllow 为空;这里 `mcpServers: []`)。

## 组件

### 1. `src/core/acp/rpc.ts` —— 换行分隔 JSON-RPC over stdio

```ts
export interface AcpRpcMessage { jsonrpc?: '2.0'; id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }
export interface AcpConnectionOptions {
  rpcTimeoutMs: number
  /** agent → client 请求(有 id 有 method)。返回值作为 result 回复;抛错 ⇒ error 回复(code 取 err.code 数字,否则 -32603)。 */
  onRequest(method: string, params: unknown, id: string | number): Promise<unknown>
  onNotification(method: string, params: unknown): void
  /** 协议层无法继续(解析失败、行超长、写失败)。只触发一次。 */
  onFatal(error: Error): void
}
export interface AcpConnection {
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>
  notify(method: string, params: unknown): void
  /** 拒绝所有挂起请求,之后 request 直接 reject。 */
  dispose(reason: Error): void
}
export function createAcpConnection(stdin: NodeJS.WritableStream, stdout: NodeJS.ReadableStream, options: AcpConnectionOptions): AcpConnection
```

- 一行一条 JSON;单行上限 4 MiB,超过 ⇒ `onFatal(Error('acp_line_too_long'))`;JSON 解析失败 ⇒ `onFatal(Error('acp_invalid_protocol_message'))`。
- 我方请求 id 用递增整数;响应按 id 配对,未知 id 的响应丢弃。`timeoutMs`(缺省 `rpcTimeoutMs`)到 ⇒ reject `Error('acp_rpc_timeout: <method>')`;`0` 表示不限时(`session/prompt` 用它,回合由服务层 watchdog 兜底)。
- agent → client 请求:`onRequest` 的 Promise 落定后回 `{id, result}` 或 `{id, error}`;`dispose` 后仍到达的请求回 `{id, error:{code:-32603}}`。
- 写入失败(stdin 已关)⇒ `onFatal(Error('acp_protocol_write_failed'))`。

### 2. `src/core/acp/events.ts` —— `session/update` → `AgentEvent`

```ts
export interface AcpTranslator {
  /** 返回 0..n 个事件。忽略 agent_thought_chunk / user_message_chunk / plan / available_commands_update / current_mode_update / config_option_update / usage_update。 */
  update(update: unknown): AgentEvent[]
  /** 新一轮 prompt 开始:文本条目计数归零。 */
  beginTurn(): void
}
export function createAcpTranslator(): AcpTranslator
export function acpActivityId(toolCallId: string): string
export function acpPermissionDescription(params: unknown): string | null
export function acpPermissionOption(options: unknown, allow: boolean): string | null
```

- **文本条目 id**(spike 意外 #1):`agent_message_chunk` 有 `messageId` ⇒ `itemId = 'acp:msg:' + messageId`;没有 ⇒ 合成 `'acp:turn:<turnSeq>:<msgSeq>'`,`msgSeq` 在**同一轮里遇到 `tool_call` 且之后再来文本**时 +1(工具调用前后是两条助理消息)。`textMode:'append'`。`content.type !== 'text'` 的块忽略。
- **活动**:`tool_call` / `tool_call_update` ⇒ `{kind:'tool_call', tool: name ?? kind ?? 'tool', activity}`;`activity.id = acpActivityId(toolCallId)`(把控制字符换成 `_`,截到 200 字 —— spike 意外 #7:Cursor 的 toolCallId 里嵌着换行);`tool_call_update` 与之前的同 id 事件合并(kind / title / status / locations 记在 translator 里,更新只带变化字段)。
  - `kind` → `type` / `label`:`read`→`read`/「读取文件」;`edit`→`edit`/「修改文件」;`delete`→`edit`/「删除文件」;`move`→`edit`/「移动文件」;`search`→`search`/「检索文件」;`execute`→`command`/「运行命令」;`fetch`→`search`/「获取网页」;`think`→忽略(不发事件);`switch_mode`/`other`/缺省→`tool`/「调用工具」。
  - `status` → `pending`/`in_progress`→`running`;`completed`→`completed`;`failed`→`failed`;缺省/未知 ⇒ 首次 `running`。
  - `detail`:只取 `locations[].path`(≤12 条,去重,每条 ≤300 字,总 ≤2000);`other` 类再取 `title`(≤120 字,去控制字符)当工具身份。**永不**复制 `rawInput` / `rawOutput` / `content` 到活动里(与 codex-activity 同一条隐私规矩)。
- `acpPermissionDescription(params)`:`toolCall.kind==='execute'` ⇒ `rawInput.command`(字符串)+ `content[]` 里 `type:'content'` 且 `content.type:'text'` 的文本(如 `Not in allowlist: uname`)+ `locations` 路径;其它 kind ⇒ `title` + 路径。总长 ≤ 20_000,否则返回 `null`(不可完整显示 ⇒ 拒绝并停任务,与 Codex 同规矩)。`toolCall` 缺失或 `options` 不是数组 ⇒ `null`。
- `acpPermissionOption(options, allow)`:`allow` ⇒ 第一个 `kind==='allow_once'`;否则第一个 `kind==='reject_once'`;找不到 ⇒ `null`(调用方回 `outcome:'cancelled'`)。**绝不**选 `allow_always` / `reject_always`。

### 3. `src/core/acp/agents.ts` —— 启动描述与发现

```ts
export interface AcpAgentLaunch { id: 'cursor'; displayName: string; command: string; args: string[] }
/** 只认 cursor:`cursorAgentBin` 覆盖 > PATH 上的 `cursor-agent`;找不到 ⇒ null。不探测 --version、不起进程。 */
export function resolveAcpAgent(id: 'cursor', config: Pick<AgentConfig, 'cursorAgentBin'>, findOnPath: (cmd: string) => string | null): AcpAgentLaunch | null
```

### 4. `src/core/acp-workbench-provider.ts` —— `AgentProvider`

```ts
export interface AcpWorkbenchProviderOptions {
  command: string; args: string[]; displayName: string
  rpcTimeoutMs?: number      // 缺省 60_000(initialize / session/new / session/load)
  closeTimeoutMs?: number    // 缺省 3_000
  spawn?: typeof import('node:child_process').spawn   // 测试注入
}
export function createAcpWorkbenchProvider(options: AcpWorkbenchProviderOptions): AgentProvider
```

`spawn(project, context)`:

1. `process.platform === 'win32'` ⇒ 抛 `Error('Cursor 工作台暂不支持 Windows：尚未验证任务进程树清理。')`(与 Claude / Codex 同一句式)。
2. `spawn(command, args, { cwd: project.path, env: process.env, stdio: ['pipe','pipe','pipe'], detached: true, windowsHide: true })`;`stderr` 丢弃(`resume()`);`exit` ⇒ 若不在 closing 中 ⇒ fatal(`acp_process_exited: <signal|code>`)。
3. `initialize { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'cc_workbench', title: 'CC Workbench', version: '0.6.4' } }`。结果 `protocolVersion !== 1` ⇒ 抛 `acp_protocol_version_unsupported`。记下 `agentCapabilities.loadSession === true`。
4. `context.resumeSessionId` 有:`loadSession` 不为 true ⇒ 抛 `acp_resume_unsupported`;否则 `session/load { sessionId, cwd: project.path, mcpServers: [] }`,**结果返回前收到的所有 `session/update` 一律丢弃**(那是历史重放);sessionId 沿用请求里的。没有:`session/new { cwd: project.path, mcpServers: [] }`,结果 `sessionId` 必须是非空、≤500 字、无控制字符的字符串,否则抛 `acp_missing_session_id`。
   - 这两步的 JSON-RPC error:`code === -32000` 或 message 命中 `isAuthFail('sdk-error', …)` ⇒ 抛 `Error('acp_auth_required')`;其它 ⇒ 抛 `Error('acp_session_failed: <message>')`。任一步抛错前先 `close()`(best effort)。
5. `context.reportNotice?.('Cursor 通过 ACP 执行：命令会逐次请求批准；工作区内的文件编辑由 Cursor 直接执行，不经过权限卡。')`。
6. `context.permissionMode` 忽略(ACP 无此开关;服务层对 `permissions:'task'` 传 `'strict'`,记录在注释里)。`context.mcpEnv` 忽略(不注入 MCP)。`context.execution` / `model` 忽略(能力声明 `executionSettings:false`,服务层已在 `requireInput` 拒绝)。

`dispatch(text, attachments)`:

- `attachments?.length` ⇒ 抛 `acp_attachments_unsupported`(能力层已拦,这里是纵深)。
- 同时只允许一轮在飞:有在飞 ⇒ 抛 `acp_turn_already_running`;closed / broken ⇒ 抛 `acp_session_closed`。
- 第一轮把 `context.appendInstructions` 前置:`${instructions}\n\n---\n\n${text}`(与 print 模式、Codex `developerInstructions` 同一做法;ACP 没有系统提示槽位)。
- 事件队列用 `AsyncQueue<AgentEvent>`:先 push `{kind:'init', sessionId}`(每轮一次,服务层据此登记会话);`translator.beginTurn()`;发 `session/prompt { sessionId, prompt: [{ type:'text', text }] }`(不限时);期间 `session/update` 经 translator 逐条 push。
- prompt 结果 `stopReason`:`end_turn` ⇒ `{kind:'result', sessionId, numTurns:1, durationMs}`;`cancelled` ⇒ 若是我们 `cancel()` 的 ⇒ `{kind:'error', message:'acp_turn_cancelled'}`,否则同 `end_turn`(agent 自己收的);`max_tokens` / `max_turn_requests` / `refusal` ⇒ `{kind:'error', message:'acp_stop_<reason>'}`。RPC 错误 ⇒ `makeTurnEmitter().errorText(message)`(自动识别 auth)。之后 `queue.end()`。
- 队列迭代器的 `return()`(服务层 `collectWorkbenchTurn` 的 finally 会调)⇒ 若该轮仍在飞 ⇒ 发 `session/cancel`。

agent → client 请求(`onRequest`):

- `session/request_permission`:`sessionId` 不符或当前没有在飞回合 ⇒ 回 `{outcome:{outcome:'cancelled'}}`。`acpPermissionDescription` 为 `null` ⇒ 回 cancelled 并 fatal(`无法核实或完整显示本次 Cursor 权限请求，工作台已停止任务。`)。否则 `context.requestPermission({ tool: toolCall.kind ?? 'tool', description }, signal)`(没有桥 ⇒ 视为 false);布尔 ⇒ `acpPermissionOption`;`null` ⇒ cancelled。回合结束 / cancel / close 时 abort 所有挂起权限请求并回 cancelled。同一 id 重复请求 ⇒ fatal(`acp_duplicate_permission_request`)。挂起数 ≥ 100 ⇒ fatal(`acp_request_limit`)。
- 其它任何请求(`fs/*`、`terminal/*`、`elicitation/create`…)⇒ 抛 `{code:-32601, message:'client capability not declared: <method>'}`。

`cancel()`:有在飞回合 ⇒ 标 `cancelled`、abort 挂起权限、`session/cancel` 通知;没有 ⇒ 空操作。不等 prompt 结果(`close()` 负责进程)。

`close()`:幂等(返回同一个 Promise)。步骤:标 closing;abort 挂起权限并回 cancelled;若在飞 ⇒ `session/cancel`;`connection.dispose`;`stdin.end()`;`process.kill(-pid, 'SIGTERM')`(ESRCH 忽略);轮询 15ms 直到 `exit` 事件到 **且** `process.kill(-pid, 0)` 抛 ESRCH;到 `closeTimeoutMs` 的最后 1/4 时 `SIGKILL` 进程组;deadline 到仍活着 ⇒ 抛 `Error('acp_process_not_exited')`。spike 意外 #6:关 stdin 不会让 `cursor-agent acp` 退出,所以 SIGTERM/SIGKILL 进程组是必经之路,不是兜底。

`fatal(message)`:只生效一次;若有在飞回合 ⇒ push `{kind:'error', message}` + `queue.end()`;之后 `dispatch` 抛 `acp_session_closed`。

### 5. 能力与注册

- `executor-capabilities.ts` 新常量:
  ```ts
  export const ACP_CAPABILITIES: WorkbenchExecutorCapabilities = Object.freeze({
    version:1, permissions:'task', configuration:'task-policy', completion:'native', stop:'confirmed', background:'disabled',
    features: Object.freeze({ nativeResume:true, attachments:false, executionSettings:false, modelCatalog:false }),
  })
  ```
  `isWorkbenchExecutorCapabilities` 不用改(全是已有取值)。「不按品牌准入」不变式不动。
- `wire-workbench.ts`:
  ```ts
  export function registerAcpExecutors(target: ProviderRegistry, source: Pick<ProviderRegistry,'get'>, config: Pick<AgentConfig,'cursorAgentBin'>, deps?: { findOnPath?: (cmd:string)=>string|null; create?: typeof createAcpWorkbenchProvider }): string[]
  ```
  boot registry 有 `cursor` **且** `resolveAcpAgent('cursor', config, findOnPath)` 非 null ⇒ `target.register('cursor', createAcpWorkbenchProvider({command,args,displayName}), { ...entry.opts, workbench: ACP_CAPABILITIES })`。
  `registerUnattendedExecutors` 只剩 `agy`(签名不变,返回值不再含 cursor)。`wireWorkbench` 里先 `registerAcpExecutors`,再 `registerUnattendedExecutors`;boot 有 cursor 但二进制解析不到(理论上不会,因为 boot 正是靠它注册的)⇒ 不注册,不退回免审,日志一行。
- `service.ts` **不改**:`permissionMode` 由 `isUnattendedExecutor` 决定(ACP 拿 `'strict'`),`requireInput` 只看能力。

### 6. 文案

- `execution-settings.ts` `executionFailureMessage` 与桌面 `workbench-execution.js` `executionErrorMessage` 各加:
  - `acp_auth_required`:「Cursor 登录态失效，请在电脑上跑一次 `cursor-agent login` 后再试。」
  - `acp_protocol_version_unsupported` / `acp_session_failed` / `acp_process_exited` / `acp_invalid_protocol_message` / `acp_line_too_long` / `acp_protocol_write_failed`:「Cursor 的 ACP 会话无法建立或中断，请确认 `cursor-agent` 是支持 `acp` 子命令的版本后重试。」(桌面同句;`acp_session_failed: …` 带后缀时按前缀匹配)
  - `acp_resume_unsupported`:「这个版本的 Cursor 不支持接着原会话，请带记录重新开始。」
  - `acp_process_not_exited`:沿用现有「执行程序未确认退出」路径(服务层已有文案,不新增)。
- `wechat-control.ts` 的 `unattended_ack_required` 文案把「agy / Cursor」改成「agy」;桌面 `workbench-unattended.js` 顶部注释与对话框标题同改(对话框正文四条不变)。
- `docs/cc-workbench.md`:执行者覆盖表加 Cursor(ACP)一行(命令有卡、编辑免审、无附件 / 模型、按 `session/load` 恢复);修订记录一条。

## 数据流

选 Cursor 新建任务 → `requireInput`(`ACP_CAPABILITIES`,无 ack 门)→ `spawn`:起 `cursor-agent acp`、`initialize`、`session/new` → 提示落时间线 → `dispatch`:`init` → `session/prompt` → `agent_message_chunk` 逐条 `text`(合成 itemId,coalescer 合并)/ `tool_call` 活动行 / `session/request_permission` → 权限卡(桌面 / 微信 y/n)→ `allow_once` / `reject_once` → `stopReason` → `result` → 服务层照旧截 diff 快照、结算、租约。停止 → `cancel()` 发 `session/cancel` → `close()` 杀进程组并确认退出。

## 错误处理

- 权限请求无法完整显示 ⇒ 拒绝 + 停任务(不静默放行)。
- agent 进程意外退出 ⇒ 在飞回合收 `error`,任务失败;`close()` 仍走完确认。
- `close()` 超时 ⇒ 抛 `acp_process_not_exited` ⇒ 服务层现有的 `markUncertain` + 「执行程序未确认退出」。
- `session/load` 后 agent 报的 sessionId 与请求不符(结果里若带 `sessionId`)⇒ 抛 `acp_resume_session_mismatch`。
- Cursor 全局 `~/.cursor/mcp.json` 里的 `wechat-cc:wechat`(对话侧静态 trusted 钥匙)在 ACP 会话里仍可见 —— 与今天的免审路径相同,任务提示词禁止调用;不在本轮解决,写进 docs 已知限制。

## 测试

- `rpc.test.ts`(PassThrough 假流):请求 / 响应配对、超时、不限时、agent→client 请求的 result / error 回复、行超长 fatal、解析失败 fatal、dispose 后请求 reject 且晚到请求回 -32603。
- `events.test.ts`:无 messageId 的 chunk 合成 itemId 且跨 tool_call 翻条、有 messageId 用它;tool_call 各 kind 的 type/label/status、update 合并、控制字符 id 清洗、detail 不含 rawInput/rawOutput/命令;`acpPermissionDescription` 三种形状与 null;`acpPermissionOption` 只选 once 档。
- `acp-workbench-provider.test.ts`(仿 codex 的 FakeProcess,mock `node:child_process`):initialize 参数(不声明 fs/terminal,protocolVersion 1)、session/new 与 sessionId 校验、resume 走 session/load 且重放被丢弃、loadSession 缺失 ⇒ `acp_resume_unsupported`、首轮前置 instructions、init/text/tool_call/result 顺序、权限请求 ⇒ `requestPermission` 参数与 allow_once/reject_once 回复、桥缺失 ⇒ reject_once、超长 ⇒ cancelled + error、未知请求 ⇒ -32601、cancel ⇒ `session/cancel` + error 事件、close ⇒ stdin end + 进程组信号 + 等退出、超时 ⇒ `acp_process_not_exited`、进程意外退出 ⇒ error 事件、-32000 ⇒ `acp_auth_required`、win32 拒绝、attachments 拒绝。
- `wire-workbench.test.ts`:cursor 走 ACP 能力、agy 仍免审、找不到二进制不注册;`executor-capabilities.test.ts` 加 `ACP_CAPABILITIES` 通过校验;`service-capabilities.test.ts` 原样通过。
- Playwright 118 不变(桌面只改文案)。

## 修订记录

- 2026-09-17:初稿(按 spike 判定:Cursor 走 ACP 是命令有卡、编辑免审的中间档;agy 不动;对话侧不动)。
