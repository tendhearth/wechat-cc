# agy provider(订阅版 Gemini,经 Antigravity CLI)— 设计

日期:2026-08-17
状态:已评审(身份与 v1 范围经用户拍板;spike 证据见 §0)
背景:操作者的 Gemini 访问走 **agy CLI(Antigravity,Google AI Pro 订阅 OAuth)**,
没有 `GEMINI_API_KEY`;现有 gemini provider(`@google/genai` + API key)对该
形态不可用。债务登记早有 "gemini→agy 迁移 deferred" 一笔,本设计落地它的
v1。

## 0. Spike 证据(2026-08-17,本机 agy 1.1.13 实测)

- 无头单发可用:`agy -p "<prompt>" --output-format stream-json --model
  gemini-3.7-flash-low` 真实跑通(答"2",3.6s,订阅额度)。
- 事件流(NDJSON,每行一个 `{event, ...}`):
  - `init`:`conversation_id`、`model`、`cwd`、`tools[]`(**含 `call_mcp_tool`**)、
    `permission_mode`;
  - `step_update`:`step_index`/`state`(ACTIVE|DONE)/`step_type`
    (`user_input`|`agent_response`|`checkpoint`|…)/`text_delta`/`usage`;
  - `result`:`status`("SUCCESS"|…)、`response`、`num_turns`、`usage`、
    `conversation_id`。
- Resume:`--conversation <id>` 原生续聊(conversation_id 即句柄)。
- 权限旋钮:`--dangerously-skip-permissions`、`--mode (accept-edits|plan)`、
  `--sandbox`;print 缺省 `permission_mode:"request-review"`。
- 模型(订阅):`gemini-3.7/3.6/3.5-flash-{high,medium,low}`、`gemini-3.1-pro-{high,low}`。
- 配置家:`~/.gemini/`(oauth_creds.json、settings.json);MCP 全局配置
  `~/.gemini/config/mcp_config.json`;二进制字符串确认
  `allow_mcp_servers`/`allowed_mcp_servers` 设置面存在。
- 未拍到的形状(plan 首任务补,2026-08-17 spike 结论,详见 scratchpad
  `agy-spike-findings.md`):
  - **工具调用步**:普通 `step_update`(`step_type:"tool"`),同一
    `step_index` 两行(ACTIVE→DONE/ERROR);`tool_name`/`tool_info.parameters`/
    `tool_info.output`(或 `.error`)。MCP 调用固定 `tool_name:"call_mcp_tool"`,
    `parameters:{Arguments,ServerName,ToolName}`——`ServerName` 即 server 归属
    字段,§1 的需求成立。
  - **strict(无 dangerously)权限行为**:自动拒绝、非阻塞,turn 正常
    `SUCCESS` 收尾(exit 0);工具步 `state:"ERROR"` +
    `tool_info.error:{type,message}`;stderr 有一行 `jetski:` 提示文案。
    不需要 `--mode plan` 兜底——strict 天然满足"工具被拒但 turn 能完成"。
  - **MCP 配置档位**:env-var 与 cwd 级均**探测不到**(`GEMINI_CONFIG_DIR`
    试验为负,cwd `.gemini/config/mcp_config.json` 试验为负);仅**全局**
    `~/.gemini/config/mcp_config.json` 生效(bundled 文档 `docs/mcp_servers.md`
    确认只有 Global/Plugin 两个位置)。⇒ **走档位 C**(决策见 §3)。
  - **登出/凭证失效**:未探测(HARD SAFETY 规则禁止主动登出;真实遇到再补
    auth 文案,遵循 auth-fail.ts 既有规矩)。
  - **额外发现(非原六项,但影响 §1)**:`agy` 的工具执行(`run_command`/
    `write_to_file`/…)**不**跟随进程 OS 级 cwd,而是跟随内部"project"绑定
    (`~/.gemini/projects.json` 路径→项目名映射);仅传 spawn `{cwd}` 不够,
    必须加 `--new-project`(首轮)或稳定 `--project <id>`(续聊/后续轮),
    否则会静默在 agy 自己的状态目录(而非 `project.path`)下执行工具——
    §1 的 dispatch 参数组装需补这一条,否则是隐蔽的目录错位 bug。

**已定决策:**
1. **新 provider id `agy`**,现有 gemini(genai+key)provider 原样保留——
   零风险共存,回退清晰;
2. **v1 = solo 对话 + cheapEval + 真 resume**;`supportsDelegation:false`、
   不接 delegate MCP、不进 parallel/chatroom。

## 1. Provider 形状(src/core/agy-agent-provider.ts)

最近的同类是 codex:**每 turn 一次 CLI 调用**,进程即 turn。

```ts
export interface AgySpawnFn {
  (args: string[], opts: { cwd: string }): {
    stdout: AsyncIterable<Uint8Array | string>   // NDJSON 行流
    stderr: Promise<string>                       // 收尾时取
    exited: Promise<number>
    kill(): void
  }
}
export interface AgyAgentProviderOptions {
  /** agy 二进制路径(bootstrap 探测后传入)。 */
  bin: string
  /** 缺省模型(agyModel 配置;per-spawn ctx.model 覆盖)。 */
  model: string
  /** 注入缝:测试用假 agy(吐 NDJSON 的脚本/内存实现);缺省 Bun.spawn。 */
  spawnFn?: AgySpawnFn
  log: (tag: string, line: string) => void
}
export function createAgyAgentProvider(opts: AgyAgentProviderOptions): AgentProvider
```

每次 `dispatch(text)`:

- 组装参数:`-p <text> --output-format stream-json --model <ctx.model ?? opts.model>`
  + 续聊时 `--conversation <conversationId>` + 权限旗标(§4);cwd =
  project.path;
- 逐行解析 NDJSON → `AgentEvent`(经 turn-emitter):
  - `init` → 记录 `conversationId`(= sessionId,真 resume 句柄)+ `em.init`;
    仅首个 dispatch 对外发 init(与 openai 的 firstRef 姿势一致);
  - `step_update` 的 `text_delta` **按 step 聚合**:同一 `step_index` 的
    delta 拼接,step `state:"DONE"` 且 `step_type:"agent_response"` 时发一条
    完整 `text`(**消息粒度**,与 codex 对齐;刻意避开 token-delta 在
    FALLBACK_REPLY 下一 token 一条微信的坑——粒度统一是 D4 的 non-goal,
    新 provider 不再新增 delta 粒度的实例);
  - 工具步 → `em.toolCall(tool, server?)`(确切 step 形状由 plan 任务 1 的
    spike 拍板;MCP 工具应能从事件里辨认出 server);
  - `result.status === 'SUCCESS'` → `em.finish({ sessionId: conversationId,
    numTurns: result.num_turns })`;非 SUCCESS → `em.errorText(status+详情)`;
  - 进程非零退出且未发过 result → `em.error(new Error(stderr 摘要))`
    (auth 判别走 `isAuthFailError` 的消息兜底;agy 登出文案实测后若不命中
    宽集,加 agy 专用词条并注明通道归属——auth-fail.ts 的既有规矩);
- **`cancel()`:kill 子进程**(v1 即支持,/stop 对 agy 生效——强于
  cursor/openai/gemini);`close()`:kill + 状态清理。
- 串行约束:同 session 重叠 dispatch 直接 throw(claude 同姿势)——
  `--conversation` 对并发写入的行为未知,不赌。

## 2. 注册、命令与 capabilities

- `AGY_CAPABILITIES`:`{ defaultPeer: 'claude', perToolCallback: false,
  sandboxLevels: ∅(v1 不映射 --sandbox), supportsDelegation: false,
  supportsResume: true, authFailHint: 'agy 登录态失效,终端里跑一次
  `agy` 重新登录' }`;`assertMatrixComplete` 自动强制矩阵补 agy 行,
  B2 的三道防线自动生效(agy 当 primary_tool 主导会被拒)。
- `providers.ts` 注册块(lazy,同 cursor/gemini 姿势):门槛 =
  `agy` 二进制可解析(`configuredAgent.agyBin ?? PATH 上的 'agy'`)且
  `--version` 退出码 0;不满足 ⇒ 不注册 + BOOT 日志一行。
- `agent-config.ts`:新增 `agyModel?: string`(own-field,走
  `modelForProvider` 的既有 per-provider 规则)、`agyBin?: string`(escape
  hatch)。缺省模型 `gemini-3.7-flash-medium`。
- `mode-commands.ts`:`/agy` 进 slash 词表;`/agy <model>` 类比 `/api <model>`
  (切 solo+agy 并 pin agyModel,宽松模型名校验同 /api)。
- **已拍板**:`agy` 故意不进 `agent-config.ts` 的全局默认 provider 枚举
  (`AgentProviderKind`/`config.provider` 的 `z.enum([...])`,当前仍是
  `claude|codex|cursor|openai|gemini`)——只能走每聊天 `/agy` 单独切,
  v1 不支持把它设成整个 daemon 的默认 provider,strongEval 在 v1 也够
  不着它(§0 决策 2 的 solo-only 范围一致)。
- cheapEval:`-p --model gemini-3.7-flash-low` 单发,文本走既有
  `assertNotAuthFailed`;`CHEAP_EVAL_PREFERENCE` 里排在 openai 之后、claude
  之前(订阅额度、无按 token 计费)。

## 3. MCP 与 tier(v1 的核心取舍)

agy 的 MCP 配置在全局 `~/.gemini/config/mcp_config.json`——静态文件装不下
每会话的 `WECHAT_SESSION_TOKEN/_TIER`。plan 任务 1 按序探(spike):

1. **配置目录/env 级覆盖**(如 config-dir 重定向环境变量):有 ⇒ 每 spawn
   一个临时配置目录,mcp_config.json 内嵌该会话的 token/tier env——完整
   tier 隔离,最优;
2. **工作区级配置**(cwd 下 .gemini/ 或 settings 局部覆盖):可接受,
   同样每会话可控;
3. **都没有** ⇒ **v1 限制:`/agy` 仅 admin/trusted chat 可切**(mode-commands
   在 `/agy` 分支查 tier,guest ⇒ 明确拒绝文案),全局 mcp_config.json 写一个
   固定的 wechat 条目(env 带 boot 期铸的长期 token,tier=trusted)。
   宁可缩小可用面,也不给 guest 发一个共享 trusted token 的假隔离——
   surface, don't paper over。

**[决策(2026-08-17 spike,证据见 §0 与 scratchpad `agy-spike-findings.md`)：
选定档位 C(全局 only)。** 依据:strings 未发现任何 config-dir 重定向 env
var(`GEMINI_CONFIG_DIR` 等候选试验为负);cwd 级 `.gemini/config/mcp_config.json`
同样试验为负;仅全局 `~/.gemini/config/mcp_config.json` 生效(agy 自带文档
`docs/mcp_servers.md` 明确只有 Global/Plugin 两个配置位置,无 workspace/env
覆盖机制)。验证法:注册一个最小 stdio echo server(`spike_ping`),读后写
备份全局 `mcp_config.json`、加一条测试 server、跑 `call_mcp_tool` 步确认
真实调用(`output` 精确等于 server 返回值,非模型读源码猜测),再 diff
恢复原文件字节一致。`mcp_config.json` schema:
`{"mcpServers":{"<id>":{"command","args","env"}}}`(stdio)或
`{"serverUrl"}`(SSE)——字段名 `command`/`args`/`env`/`serverUrl` 均已核实。
后续任务据此实现:`/agy` 限 admin/trusted、全局条目固定长期 token。]**

无论哪档:只把 **wechat** MCP 喂给 agy(v1 不喂 delegate、不喂插件 MCP);
写入任何配置文件前先读后写、只增改自己命名空间的条目(如 `wechat-cc`
前缀),绝不覆盖用户手写内容。

**残留风险(2026-08-17 final-review fix wave,登记而非消除)：**档位 C 的
代价是 `agy-static` 这一枚 `trusted` token 常驻磁盘(`~/.gemini/config/
mcp_config.json`),不是 token-registry.ts 文档的"session token 只活在
env、per-spawn 铸造"的常态——它是该规则一个显式记录的例外(token-
registry.ts 模块头注释已同步)。两道闸门把这个例外的暴露面压到最小但
不是零：flip-time(mode-commands.ts 的 `/agy` 拒 guest)只挡得住通过
slash 命令切换的路径；final-review 发现它可绕过（`/both`/`/chat` 把
agy 塞进参与者列表、trusted-token 的 `POST /v1/conversation/set-mode`
不查 tier、以及一个曾经合法的 solo+agy 记录在 chat 被降级为 guest 后
仍然存活）——修复把 agy 结构性地排除出 parallel/chatroom(coordinator
的 `validateMode`/`resolveParticipants` 双保险 + mode-commands 的用户
可见拒绝文案),并在 `dispatchSolo` 加了一道 dispatch-time 闸门:不管
mode 是怎么落到 provider='agy' 的,当场重查该 chat 的 tier,guest 一律
拒绝、不 spawn。仍然遗留、本轮不处理的口子：①卸载/降级 agy 后
`wechat-cc:wechat` 这条命名空间条目会留在全局 `mcp_config.json` 里当
死条目(没有卸载回调清理它)——后续任务;②`mintSessionToken` 目前不接
受按路由收窄的 `routeAllow`(token-registry.ts 的 `MintTokenOpts.routeAllow`
机制存在,但 `BootstrapDeps['mintSessionToken']` 的签名只有
`(tier, sessionKey)`,agy-static 拿到的是全 wechat MCP server 的完整
路由集,不是"只给它需要的那几个工具")——若想收窄,需要给
`BootstrapDeps.mintSessionToken` 加一个可选 `options` 参数并穿透
providers.ts→agy-mcp-config.ts,这是签名改动,本轮不做,登记为后续
任务。

## 4. 权限映射

- `permissionMode === 'dangerously'` ⇒ `--dangerously-skip-permissions`;
- `strict` ⇒ 不加旗标(print 缺省 request-review);其在 print 模式下的实际
  行为(阻塞?自动拒?)由 plan 任务 1 spike 确认,若会阻塞 ⇒ strict 下
  追加最保守的可用组合(如 `--mode plan` 或经 `--sandbox`),以"工具被拒
  但 turn 能完成"为验收线;
- 不接 permission relay(non-goal,与 openai v1 同姿势)。agy 自带的
  browser/web 工具集 v1 不做白名单裁剪(是操作者自己的订阅 agent),
  `--sandbox` 细调留给后续。

## 5. 测试策略

- **单测**(agy-agent-provider.test.ts):经 `spawnFn` 注入假 agy(内存
  NDJSON 流)覆盖——init/文本聚合(多 delta 一条 text)/工具步映射/result
  成功与失败/非零退出→error(含 auth 文案命中)/cancel kill/重叠 dispatch
  throw/resume 参数拼装(第二次 dispatch 带 --conversation)。
- **childEnv/配置生成**:§3 选定档位的配置写入逻辑单测(临时目录)。
- **真机验收**(实现内探针,scratchpad,不入库):好账号一轮对话;
  `--conversation` 续聊一轮;一次真实工具调用拍事件形状;cheapEval 单发。
  登出态不主动制造(不能登出用户的 agy),auth 文案等真实遇到再补词条。
- e2e 不新增(无 SDK 可 mock,与 openai/gemini 同姿势);现有全量回归保绿。

## 6. 迁移与风险

- 纯新增,无 schema/状态迁移;gemini(genai)provider 一行不动。
- 风险①:stream-json 事件形状是 1.1.x 的观测结果,无版本契约——parser
  对未知 `event`/`step_type` 必须静默跳过(向前兼容),version-check 只做
  软告警(codex-version-check 的轻量版:记日志不拒启)。
- 风险②:MCP 配置档位探测结果决定 §3 走哪档——plan 任务 1 是**决策点**,
  探测结论写回本 spec(bracketed annotation)再继续后续任务。
- 风险③:print 模式超时缺省 5m(`--print-timeout`)——设为
  `turnTimeoutMs` 对齐值,collectTurn watchdog 仍是外层保险。

## 7. Non-goals(显式)

- delegation(supportsDelegation:false;B2 防线自动拒绝 agy 主导的主从模式);
- parallel/chatroom 参与;permission relay;`--sandbox` 细调与工具白名单;
- gemini(genai)provider 的任何改动或下线;
- agy 侧的 skills/plugins/subagent 生态接入;
- 桌面 UI 变化(keep-desktop-ui-simple)。
