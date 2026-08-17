# Provider 运行时去重 + 能力缺口修复(D4)— 设计

日期:2026-08-17
状态:已评审(方案 A;范围与取舍见 §0)
解决:docs/architecture.md 债务登记 **D4**(provider 层五次重写循环、auth-fail 三份、
McpStdioSpec 五份)+ 探索中发现的三组 live bug。

## 0. 背景与已定决策

调查结论(2026-08-17,基于 dev@d0d164a1 的逐行对照):

- 五个 provider 的 dispatch 循环合计约 **250 行可共享样板**(时长/numTurns/
  result 合成/错误语气词/closed 标志/abort 判别)对约 230 行真正 SDK 特有的
  映射;
- `McpStdioSpec` 有 **5** 份结构等同的定义(bootstrap/mcp-specs.ts:24、
  openai-mcp-bridge.ts:5、cursor-agent-provider.ts:215、
  gemini-agent-provider.ts:292、codex-agent-provider.ts:103 的
  CodexMcpStdioServer),全部靠结构赋值互通,无人转换;
- auth-fail 正则 **3** 份且集合不一致——分歧有真实原因:超集正则
  (agent-provider.ts:268)跑在合法模型输出上必须窄,codex 的跑在错误通道上
  可以宽。**单一常量是错的,单一来源 + 双通道 profile 才对**;
- 三个**结构性语义差异**使"一个循环统一五家"成为错误目标:
  1. claude 是 session 级 SDK 流(AsyncQueue 多路复用、STREAM_DROP、
     drainPromise),其余四家 turn 级;
  2. openai/gemini **自己执行工具**并同步 gate(gemini 的 ToolGate 可阻塞
     120s 等管理员微信回复),claude/codex/cursor 收到的是已执行结果;
  3. 文本事件粒度五家各异(token delta ↔ 整段),result 的出处
     (SDK 权威 ↔ 本地合成)各异。

**Live bugs(本设计一并修复):**

- **B1 — gemini tier 鉴权缺口:** gemini 的 `mcpConnect` 从不合并
  `SpawnContext.mcpEnv`(providers.ts:430-433 / gemini:328),wechat MCP 子进程
  拿不到 `WECHAT_SESSION_TOKEN/_TIER`;且只传 `spec.env`
  (gemini:304),连 PATH/HOME 都不继承。其余四家全部正确合并。
- **B2 — delegation 静默降级:** `supportsDelegation` 是死字段(零个非测试
  消费点);RFC-05 §2.4 规定的合取在 capability-matrix.ts:167 被丢掉。
  `/gemini + cc` 今天设置成功并回复"✅ 它会调 `delegate_claude`",而该工具在
  gemini 会话里不存在(gemini 注册硬编码 delegateAvailable:false,
  ProviderDeps 根本没有 delegateStdioForGemini);`/cursor + claude` 同理会在
  运行时撞 `unknown_peer: cursor`。
- **B3 — 三家不识别 auth 失败:** cursor/openai/gemini 的 dispatch 路径永不产生
  `errorCode:'auth_failed'`,API key 过期时原始报错文本经 FALLBACK_REPLY
  (conversation-coordinator.ts:487-492)直达用户,`authFailHint` 对 3/5 不可达。

**已定决策(评审记录):**

1. 范围 = 修 B1/B2/B3 + 去重基础件;**cancel() 三家补齐与文本粒度统一明确
   出圈**(见 §6)。
2. 方案 A(utilities-first):共享基础件,五个循环变薄但保留各自结构。
   方案 B(单一 runtime 对象)否决——与三个结构性差异、三个 vi.mock 测试缝、
   RFC-05 "provider 只翻译不策划"/"no auto-downgrade" 全部冲突。
3. 能力缺口按 RFC-05 §5 处理:**surface, don't paper over**——parser 明确拒绝,
   绝不自动降级。

## 1. 新共享模块(全部在 src/core)

### 1a. `mcp-stdio-spec.ts`

```ts
/** 唯一的 stdio MCP 子进程 spec —— 此前五份结构等同的定义收敛于此。 */
export interface McpStdioSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

/**
 * 子进程 env 合并的唯一出口:继承宿主 env(PATH/HOME),叠加 spec 自带 env,
 * 最后叠加会话级 mcpEnv(WECHAT_SESSION_TOKEN/_TIER)。合并顺序即优先级。
 */
export function childEnvFor(spec: McpStdioSpec, mcpEnv?: Record<string, string>): Record<string, string>
// 实现:{ ...process.env 的字符串项, ...(spec.env ?? {}), ...(mcpEnv ?? {}) }
```

五个定义点全部改为 `import type { McpStdioSpec }`(codex 的
`CodexMcpStdioServer`、cursor/gemini 的前缀版本删除,类型别名也不留);
调用点因结构等同零改动。现有 3 处近似重复的 env 合并块
(codex:206-217、cursor:255-258、mcp-specs:118)与 openai-mcp-bridge:38 的
`...process.env` 展开统一改走 `childEnvFor`。

[实现落地时收窄:codex/cursor/mcp-specs 这 3 处是 CORE 网关的
`mergeEnvIntoMcpServers` 调用——把会话级 env 并入 spec、再序列化进 SDK
config,那里继承完整宿主 env 是错的,因此维持原样未改走
`childEnvFor`;`childEnvFor` 真正落地在两处"真子进程 spawn"点:
openai-mcp-bridge 的 `connectStdio` 与 gemini 的 `connectWechatMcp`。]

### 1b. `auth-fail.ts`

```ts
/** 跑在合法模型输出上的窄集 —— 裸 OPENAI_API_KEY 会误伤,不收。 */
export const AUTH_FAIL_ASSISTANT_TEXT: RegExp   // 现 agent-provider.ts:268 的超集正则原样迁移
/** 跑在 SDK 错误通道上的宽集 —— 错误消息里裸 OPENAI_API_KEY 就是认证问题。 */
export const AUTH_FAIL_SDK_ERROR: RegExp        // 现 codex:97 的宽集,吸收 claude:162 的两个词
export type AuthFailChannel = 'assistant-text' | 'sdk-error'
export function isAuthFail(channel: AuthFailChannel, text: string): boolean
```

迁移关系:`agent-provider.ts` 的 `assertNotAuthFailed` 保留导出、改为消费
`AUTH_FAIL_ASSISTANT_TEXT`(行为不变);claude:162 与 codex:97 的私有正则删除,
各自改调 `isAuthFail`(claude 的通道是 assistant-text,codex 是 sdk-error)。
**刻意的行为变化:** claude 的流内检测从 2 词窄正则加宽到完整 assistant-text
集(同通道语义,原本就该一致)——写进 commit message 的行为变化清单。
两个 profile 的集合关系写进注释:窄集 ⊂ 宽集不强制,但每个候选词必须注明
归属哪个通道及原因。

### 1c. `async-queue.ts`

claude-agent-provider.ts:417-449 的 `AsyncQueue` **一字不动**搬出并导出。
契约注释必须保留并强化:`return()` 同步 resolve 是 `collectTurn` watchdog
(agent-provider.ts:378-381)依赖的行为;`end()` 后 buf 仍可排空;无背压;
单消费者约定。claude 改 import。不做任何"顺手改进"。

### 1d. `turn-emitter.ts`

吸收五份样板的收敛点。形状(细节实现期可调,契约不可变):

```ts
export interface TurnEmitter {
  /** 字段与现 AgentEvent 'init' 变体一致(agent-provider.ts 的联合定义为准)。 */
  init(info: Omit<Extract<AgentEvent, { kind: 'init' }>, 'kind'>): AgentEvent
  text(t: string): AgentEvent            // 内部 numTurns 不加(文本不是 turn)
  toolCall(server: string, tool: string, input?: unknown): AgentEvent  // numTurns++
  /** err → {kind:'error'};message 走 err instanceof Error 语气词;
   *  isAuthFail('sdk-error', message) 命中则 code:'auth_failed'。 */
  error(err: unknown, opts?: { code?: string }): AgentEvent
  /** result 合成:durationMs = now-startedAt,numTurns = 内部计数;
   *  overrides 允许 SDK 权威数字(claude 的 session_id/num_turns/duration_ms、
   *  cursor 的 FINISHED 实时时长)整体覆盖 —— 合成绝不克扣权威值。 */
  finish(overrides?: Partial<Omit<Extract<AgentEvent, { kind: 'result' }>, 'kind'>>): AgentEvent
}
export function makeTurnEmitter(): TurnEmitter
```

设计意图:emitter 只**制造事件对象并记账**,不接管循环、不接管工具执行、
不碰迭代器——所以 queue-pump(claude)、per-turn generator(codex/cursor)、
自持工具循环(openai/gemini)三种形状都能用同一个 emitter。B3 的修复由
`error()` 内建的 sdk-error 判别自然达成,三家不需要各写正则。

## 2. 各 provider 接入(循环保留,只换器件)

| Provider | 改动 | 明确不动 |
|---|---|---|
| claude | AsyncQueue/窄正则改 import;result 事件经 `finish(SDK 权威 overrides)` | queue-pump 结构、fake-sdk 的"每 dispatch 推一条 SDKUserMessage 等 result"契约、STREAM_DROP、cancel/close 逻辑 |
| codex | generator 内换 emitter;宽正则改 `isAuthFail` | per-turn runStreamed 结构、abort 语义 |
| cursor | generator 内换 emitter(FINISHED 实时时长走 finish overrides);`error()` 使 status:ERROR 开始产生 auth_failed(命中时) | 导出纯函数 `mapCursorMessage`/`mapCursorToolName` 签名与行为 |
| openai | 循环内换 emitter;catch 路径经 `error()` 获得 auth_failed | 自持工具循环、gateTool、token-delta 粒度(粒度统一是 non-goal) |
| gemini | 循环内换 emitter;`mcpConnect` 改收 `childEnvFor(spec, ctx.mcpEnv)`(B1);catch 经 `error()`(B3) | 导出 `runDispatchLoop` 签名、ToolGate 阻塞语义、假 resume(non-goal) |

`providers.ts` 的 gemini 注册块把会话的 `mcpEnv` 穿到 `mcpConnect`(签名加参,
gemini-agent-provider 内部传导;`runDispatchLoop` 导出签名不变)。

## 3. delegation 能力校验(B2)

1. **`mode-commands.ts`(~:218-251)**:`+peer` 解析在现有三项检查外新增第四项:
   `capabilitiesFor(primary).supportsDelegation === false ⇒ 拒绝`,回复明确原因
   (如 "❌ gemini 不支持主从模式(无法调用 delegate 工具),仍为 solo")。
   不自动降级、不发假确认。
2. **`conversation-coordinator.ts` 的 `validateMode`(~:390-400)**:同一检查,
   拦截持久化状态里翻出的旧非法组合(如历史上已写入的 gemini+primary_tool),
   处理方式与现有"provider 未注册"分支同姿势。
3. **`capability-matrix.ts:167`**:恢复 RFC-05 §2.4 合取——
   `delegate: mode === 'primary_tool' && cap.supportsDelegation ? 'loaded' : 'unloaded'`;
   :162-166 的辩解注释改写为指向本 spec 与 mode-commands 的双重防线。
   `assertMatrixComplete` 是完整性断言,不受值变化影响。

`supportsDelegation` 从死字段变成有两个消费点的活字段;cursor 的
`supportsDelegation:false` 按 RFC-05 §7#3 仍是"非永久"——将来翻转时这两个
检查自动放行,无需再改。

## 4. 测试策略

- **新模块单测**(各自 co-located):双 profile 边界用例(裸 `OPENAI_API_KEY`
  在 assistant-text 不命中、在 sdk-error 命中;`Please run /login` 双通道都命中);
  `childEnvFor` 合并优先级(mcpEnv > spec.env > process.env)与 process.env
  非字符串项过滤;`AsyncQueue` 语义快照(push/end 后排空/`return()` 同步);
  turn-emitter 计数、auth_failed 判别、finish overrides 不被合成值克扣。
- **B1 断言**:gemini 现有注入端口(`mcpConnect` 注入)断言收到的 env 含
  `WECHAT_SESSION_TOKEN/_TIER` 与 `PATH`。
- **B2 断言**:mode-commands 单测——`/gemini + cc` 拒绝且文案含原因;
  validateMode 对持久化非法组合的处理;capability-matrix 单测更新
  cursor/gemini 的 primary_tool 行 delegate:'unloaded'。
- **B3 断言**:cursor/openai/gemini 各加一条"SDK 错误文本命中宽集 ⇒
  事件带 code:'auth_failed'"。
- **不动的守护**:三个 vi.mock 路径(claude/codex/cursor SDK)与 fake-sdk.ts
  不改;导出纯函数的现有单测(cursor 405 行、gemini 343 行等)保持全绿即为
  重构不走样的证据;全量 unit + e2e 回归。
- **真机 dogfood(合并后,人工)**:openai-compatible(Kimi 网关)与 gemini
  各跑一轮真实会话,重点看 auth-fail 表现与 gemini 的 tier 生效
  (guest chat 调 admin 工具应被拒)。

## 5. 迁移与风险

- 全部改动在 src/core + providers.ts + mode-commands/coordinator 两处校验,
  无 schema/状态迁移。
- 行为变化清单(刻意、需在 commit message 里写明):
  1. gemini 的 MCP 子进程 env 从"仅 spec.env"变为完整继承+合并(B1 修复);
  2. `/gemini + cc`、`/cursor + claude` 类组合从假成功变为明确拒绝(B2);
  3. cursor/openai/gemini 的认证类错误从原文透出变为 auth_failed 节流通知(B3);
  4. capability matrix 中 cursor/gemini 的 primary_tool 行 delegate 变
     'unloaded'(与事实一致)。
- 风险点:claude 循环任何行为漂移都会被 fake-sdk 契约测试与 e2e 抓住;
  emitter 的 result 合成若克扣 SDK 权威值会破坏 session resume——finish
  overrides 的"整体覆盖"语义是硬约束,单测锁死。
- 已知债:`validateMode` 只挡"经 setMode 重新进入"这条路——一条已持久化的
  `gemini+primary_tool` 旧行不经过 setMode 就直接被派发,delegate-less 照常
  运行(capability matrix 如实报 delegate: 'unloaded',并不会挡下已存在的
  行)。是走迁移脚本还是在 dispatch 时补一条提示,刻意推迟到后续 follow-up
  决定;受影响面仅自己的开发机(目前无其他已知持久化实例)。

## 6. Non-goals(显式)

- cancel() 三家补齐(/stop 对 cursor/openai/gemini 仍为 no-op——已知,另立项);
- 文本事件粒度统一(openai token-delta 在 FALLBACK_REPLY 下的多条消息问题);
- gemini 假 resume 真实化;gemini→Antigravity 迁移(登记 deferred);
- 动态 provider 加载、provider 自有 tier 策略、自动降级(RFC-05 §5 non-goals,
  继续遵守);
- 统一文本粒度前不改 collectTurn / FALLBACK_REPLY。
