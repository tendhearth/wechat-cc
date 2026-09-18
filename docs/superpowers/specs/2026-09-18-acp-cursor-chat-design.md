# 对话侧 Cursor 也走 ACP,退休 print 模式 设计

日期:2026-09-18。状态:主人「go」(接 09-17 ACP 客户端落地后的第一个候选);子代理驱动,中途不打扰。

## 背景

工作台的 Cursor 已经走 ACP(`docs/superpowers/specs/2026-09-17-acp-cursor-executor-design.md`)。对话侧(微信 `/cursor`、桌面「模型与后端」、App 一轮)仍是 print 模式:每轮起一次 `cursor-agent -p --output-format stream-json … --trust [--resume id] [--yolo]`(`src/core/cursor-cli-provider.ts` 306 行 + `cursor-cli-stream.ts` 134 行),MCP 工具靠 boot 时往 **全局** `~/.cursor/mcp.json` 塞一个命名空间 `wechat-cc:wechat`、**一把长期 trusted 钥匙**(`bootstrap/cursor-mcp-config.ts` 153 行)。由此:

- 主人聊天也拿不到 admin 工具(`adminMcpTools:false`,社交工具那一族对 Cursor 永远不注册);
- 一把静态钥匙躺在主人的全局配置文件里,daemon 崩溃时留在那儿;
- `tool_call` 回报的 server 名是命名空间键,要靠 `CURSOR_WECHAT_MCP_NAMESPACE_ID` 别名折回;
- 每轮冷启动一个进程。

spike(09-17)第 4 条已证明 `session/new.mcpServers[].env` 的逐会话 token **真到模型手里**(坏 token 那份回 401)。这正是对话侧缺的那一块。

## 目标

- 对话侧 Cursor 改由同一个 ACP 客户端驱动:每个会话一个常驻 `cursor-agent acp` 进程;wechat / delegate MCP 按会话注入,带逐会话 token 与 tier ⇒ **`adminMcpTools: true`**;`server` 名直接就是规范名 `wechat`。
- 删除 print 路(provider + 流解析器 + 全局 mcp.json 写入),只保留一次性评估(`cheapEval` / `strongEval`,无工具、无会话,print 模式最省)。
- 工作台行为**一行不变**(现有 `acp-workbench-provider.test.ts` 原样通过)。
- Cursor SDK(`CURSOR_API_KEY`)兜底路径不动。

**不做**:微信 y/n 逐工具审批(对话侧 strict 模式与今天一样:没有卡就拒;`perToolCallback` 仍 false);ACP 版的 cheapEval;附件;`elicitation`;agy。

## 组件

### 1. `src/core/acp/events.ts` —— 两处扩展

```ts
export interface AcpTranslatorOptions { text?: 'append' | 'messages' }   // 缺省 'append'
export interface AcpTranslator {
  update(update: unknown): AgentEvent[]
  beginTurn(): void
  /** messages 模式:把攒着的助理文本作为一条 text 事件吐出(没有就空数组);append 模式恒空。 */
  endTurn(): AgentEvent[]
}
export function createAcpTranslator(options?: AcpTranslatorOptions): AcpTranslator
```

- **MCP 身份**:`tool_call` / `tool_call_update` 里 `rawInput.providerIdentifier` 与 `rawInput.toolName` 都是字符串时记住 `server` / `tool`(**只读这两个身份字段,不读 args**);事件变成 `{ kind:'tool_call', server, tool, activity }`。没有这两项时沿用 `tool: name ?? kind ?? 'tool'`、无 `server`。`server` 经 `normalizeWechatMcpServer` 折回规范名(以后别家再有命名空间也不怕)。workbench 的活动行不变。
- **messages 模式**(对话侧:solo 协调器给每条 `text` 事件发一条微信,token 级 chunk 会发成几十条):chunk 只攒进缓冲;遇到 `tool_call`(先吐缓冲再吐 tool_call)或 `endTurn()` 时吐一条 `{ kind:'text', text }`(无 itemId、无 textMode)。空白缓冲不吐。

### 2. `src/core/acp-agent-provider.ts` —— 通用 ACP provider(工作台版改成薄封装)

`acp-workbench-provider.ts` 的实现整体搬到这里,改名 `createAcpProvider(options)`;`acp-workbench-provider.ts` 只剩:

```ts
export { ACP_NOTICE_FOR /* 若有 */ } …
export const acpNotice = …            // 原样
export function createAcpWorkbenchProvider(o: AcpWorkbenchProviderOptions) { return createAcpProvider({ ...o, permissions: 'bridge', text: 'append' }) }
```

新增选项(其余不变):

```ts
export interface AcpMcpServer { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
export interface AcpProviderOptions extends AcpWorkbenchProviderOptions {
  /** 'bridge':context.requestPermission(工作台);'mode':permissionMode 'dangerously' ⇒ allow_once,'strict' ⇒ reject_once(对话侧,与 print 模式无卡即拒同义)。 */
  permissions: 'bridge' | 'mode'
  /** 'append':token 级 chunk 带 itemId(工作台逐字流);'messages':每条助理消息一条 text 事件(对话侧)。 */
  text: 'append' | 'messages'
  /** 按会话构造 session/new.mcpServers(缺省 []);session/load 也带同一份。 */
  mcpServers?: (context: SpawnContext) => AcpMcpServer[]
  /** 会话打开后要钉的模型;返回 undefined / 'auto' ⇒ 不动。 */
  model?: (context: SpawnContext) => string | undefined
  /** 'strict':session/load 失败照抛(工作台,身份不能错);'fallback':失败 ⇒ 记一行日志、改走 session/new(对话侧,丢上下文好过整段挂掉)。缺省 'strict'。 */
  resume?: 'strict' | 'fallback'
  /** 给 spawn 时的提示(reportNotice);缺省工作台那句;对话侧传 null ⇒ 不报。 */
  notice?: string | null
}
```

行为:

- `mcpServers`:`session/new { cwd, mcpServers }` / `session/load { sessionId, cwd, mcpServers }`。
- `model`:`session/new` 结果的 `configOptions[]` 里找 `id === 'model'`(或 `category === 'model'`)的项;目标值在其 `options[].value` 里 ⇒ `session/set_config_option { sessionId, configId, value }`(60s 上限,失败只记日志不抛);不在 ⇒ `logOnce('model', …)`;`session/load` 后不改模型(沿用会话原状)。
- `permissions:'mode'`:不看 `context.requestPermission`;`dangerously` ⇒ `acpPermissionOption(options, true)`;`strict` ⇒ `acpPermissionOption(options, false)`;找不到 ⇒ cancelled。描述不可显示(null)在 mode 下**不**停任务(没有主人在看卡),只 cancelled + logOnce。重复 id / 上限两条守卫保留。
- `text:'messages'`:translator 用 messages 模式;`dispatch` 在 push `result` / `error` 之前先 push `translator.endTurn()` 的事件。
- `resume:'fallback'`:`session/load` 抛错(含 loadSession 不支持)⇒ `logOnce('resume', …)` ⇒ `session/new`;`init`/`result` 报**新** sessionId(协调器据此换存)。
- 进程 env:`workbenchSubprocessEnv()`(与工作台同,WECHAT_* 不进 cursor-agent 自己的环境;MCP 子进程的凭据走 `mcpServers[].env` 显式给)。

### 3. `src/core/acp-cursor-chat.ts` —— 对话侧 Cursor

```ts
export const DEFAULT_CURSOR_MODEL = 'auto'          // 从 cursor-cli-provider 搬来
export const ACP_CURSOR_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: false,
  adminMcpTools: true,        // 逐会话 token/tier 经 session/new.mcpServers[].env 注入
  sandboxLevels: new Set(),
  supportsDelegation: false,
  supportsResume: true,
  defaultPeer: 'claude',
  authFailHint: 'cursor 登录态失效,请在电脑上跑一次 `cursor-agent login` 重新登录后再发消息。',
}
export interface AcpCursorChatOptions {
  bin: string; model: string; log: (tag: string, line: string) => void
  /** boot 给的 MCP spec(名字就是规范名:'wechat' / 'delegate');null ⇒ 不注入。 */
  mcpSpecs: { wechat: McpStdioSpec | null; delegate: McpStdioSpec | null }
  /** 一次性评估的注入座(测试);缺省真 spawn。 */
  evalSpawn?: CursorSpawnFn
  spawn?: typeof import('node:child_process').spawn
}
export function acpMcpServersFor(specs: AcpCursorChatOptions['mcpSpecs'], mcpEnv?: Record<string, string>): AcpMcpServer[]
export function createAcpCursorChatProvider(o: AcpCursorChatOptions): AgentProvider
```

- `acpMcpServersFor`:每个非 null spec 一项 `{ name, command, args: spec.args ?? [], env }`,`env` = `PATH`、`HOME`(取自 `process.env`,有才带)+ `spec.env` + `mcpEnv`(只有 `CORE_MCP_SERVER_NAMES` 里的名字才叠 `mcpEnv`,与 `mergeEnvIntoMcpServers` 同一条规矩)→ 转成 `[{name,value}]`。
- provider = `createAcpProvider({ command: bin, args: ['acp'], displayName: 'Cursor', permissions:'mode', text:'messages', resume:'fallback', notice: null, mcpServers: ctx => acpMcpServersFor(specs, ctx.mcpEnv), model: ctx => ctx.model ?? o.model, log })` + `cheapEval` / `strongEval` / `cheapEvalBudgetMs: 20_000`(来自 `cursor-eval.ts`)。

### 4. `src/core/cursor-eval.ts` —— 一次性评估(从 print provider 搬出)

`cursorBaseArgs`、`oneShotEval`、`readLines`、`CursorSpawnFn` / `CursorSpawnHandle`、`defaultCursorSpawnFn(bin)` 原样搬来;解析器仍用 `cursor-cli-stream.ts`(纯函数、有测试,评估只吃它的 text / result / error 三种事件,**不删**)。`assertNotAuthFailed` 照旧。

### 5. 删除 / 收口

- 删:`src/core/cursor-cli-provider.ts` + `.test.ts`(`cursor-cli-stream.ts` 留给一次性评估)。
- `src/daemon/bootstrap/cursor-mcp-config.ts`:删 `setupCursorGlobalMcp`,保留 `removeCursorGlobalMcp`(改成 **boot 时**调用:清掉上一版留下的 `wechat-cc:wechat` 静态钥匙;`main.ts` 的关机钩子删掉);测试只留 remove 的。`CURSOR_WECHAT_MCP_NAMESPACE_ID` 从 `agent-provider.ts` 删除,常量搬进 cursor-mcp-config.ts 私有(`normalizeWechatMcpServer` 的别名集只剩 agy)。
- `providers.ts` cursor 分支:`createAcpCursorChatProvider({ bin, model, mcpSpecs:{ wechat: wechatStdioForCursor, delegate: delegateStdioForCursor }, log })`,注册项 `{ displayName:'Cursor', canResume: () => true }` 不变;先 `removeCursorGlobalMcp({ log })`(非测试)。
- `capability-matrix.ts`:`cursor: ACP_CURSOR_CAPABILITIES`(SDK 兜底也按会话合并 mcpEnv,`adminMcpTools:true` 对它同样成立)。
- `bootstrap/index.ts`:`DEFAULT_CURSOR_MODEL` 改从 `acp-cursor-chat.ts` 取;那段「agy/cursor 静态配置 ⇒ SESSION_IS_ADMIN 永假」的注释改成只说 agy。
- `external-cli-contract.live.test.ts`:cursor 那半改从 `cursor-eval.ts` 取 `cursorBaseArgs` / `DEFAULT_CURSOR_MODEL`(print 流样本仍是评估路的真机对照)。

## 数据流

微信 `/cursor` 聊天 → session-manager `spawn`(带 `mcpEnv` = 本会话 token/tier、`appendInstructions`、`model`)→ 起 `cursor-agent acp` → `initialize` → `session/new { mcpServers:[wechat(+delegate)] }` → 钉模型 → 每轮 `session/prompt`;chunk 攒成整条助理消息;`tool_call` 带 `server:'wechat'` ⇒ `isReplyToolCall` 认得出 ⇒ 不再兜底重发;`result.sessionId` 存起来 ⇒ 下次 `session/load` 接上(失败改新会话)。会话释放 / `/stop` ⇒ `cancel` / `close` 杀进程组。

## 错误处理

- 登录失效:`session/new` -32000 ⇒ `acp_auth_required` ⇒ 协调器现有的 auth 失败提示(`authFailHint`)。
- `session/load` 失败(对话侧)⇒ 新会话 + 日志,不报错给用户。
- 模型不在 Cursor 列表里 ⇒ 用它的默认,日志一行。
- 进程意外退出 ⇒ 回合 `error` 事件 ⇒ 协调器丢弃会话自愈(与今天 print 路 exit≠0 同一条路)。

## 测试

- events:messages 模式攒文本、tool_call 前先吐、`endTurn` 吐、空白不吐;MCP 身份 server/tool 取自 providerIdentifier/toolName 且不读 args;server 折回规范名。
- provider(在现有 FakeProcess 上):`mcpServers` 进 `session/new` / `session/load` 参数;`model` ⇒ `session/set_config_option` 只在 configOptions 提供该值时发;`permissions:'mode'` dangerously ⇒ allow-once、strict ⇒ reject-once、无 bridge 调用;`text:'messages'` 一轮两条助理消息(中间夹 tool_call)⇒ 两条 text 事件;`resume:'fallback'` load 失败 ⇒ session/new 且 init 报新 id;`notice:null` 不 reportNotice;现有工作台测试原样通过。
- chat:`acpMcpServersFor` 只给 CORE 名叠 mcpEnv、带 PATH/HOME、null spec 跳过;`createAcpCursorChatProvider` 的 cheapEval 走 print 一次性(假 spawnFn)且 auth 失败抛 `auth_failed`。
- bootstrap:cursor 分支注册 ACP provider、boot 时调 remove(有 cursorConfigDir 才写)、不再 upsert;`capability-matrix` 行;删文件后 typecheck / depcheck 干净;全量 bun + node 绿。
- 真机(部署前,operator token 当会话钥匙的一次性 harness,只调 `ping`):一轮里 text 事件数 = 助理消息数、`tool_call{server:'wechat',tool:'ping'}` 出现、`result.sessionId` 可 `session/load` 接上;不发微信消息。

## 修订记录

- 2026-09-18:初稿。
- 2026-09-18:按计划落地(任务 1–4)。
- 2026-09-18:评审后:换模型时删掉该 provider 的会话存档行,下一次 spawn 冷启动并钉模型(session/load 不改模型)。
- 2026-09-18:评审后:本地取消的回合无论 agent 回什么 stopReason 都以 acp_turn_cancelled 收尾(工作台同样适用,比原先"取消却报成功"更准)。
- 2026-09-18:评审后:cursor 对 guest 关门(ProviderCapabilities.guestSafe:false)—— 它在工作区内的文件编辑不经过权限卡,访客的 tier 约束不到它;共享钥匙那条门(adminMcpTools)确实不再挡它,但换成了这条。
- 2026-09-18:评审后:Windows 上不注册 ACP 对话 provider(进程组清理未验证),BOOT 记一行并照旧落到 SDK 兜底。
