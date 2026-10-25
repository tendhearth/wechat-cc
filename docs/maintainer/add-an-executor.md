# 怎么加一个执行者

执行者 = CC 用来干活的那一家(Claude、Codex、Cursor、自定义 AI 服务、Gemini、agy)。这一页说**加一家要动哪几处、每一处为什么、漏了会怎样**。2026-10-22 第三批 3c 收完以后,答案是:**一份事实 + 一份能力 + 两处构造**,其余全部推导,漏了由测试点名。

先判断你要的是不是「新加一家」:

- **只是一个说 ACP 的 CLI**(像 `cursor-agent acp`、`gemini --acp`):不用写代码。主人在 `agent-config.json` 的 `acp_agents` 里加一条,只进「一起做」,逐工具权限卡、逐字流都现成。见 `src/features/workbench/wire.ts` 的 `registerCustomAcpExecutors`。
- **要进微信对话、有自己的 SDK / 协议**:往下看。

## 1. 名字:`src/lib/provider-ids.ts`

在 `PROVIDER_IDS` 里加 id。这是唯一的名单,别处一律从它推。加完以后下面几步的「键与名单相等」测试会挨个红,照着红的补就行。

## 2. 「是什么」:`src/lib/executor-facts.ts`

`EXECUTOR_FACTS[id]` 一行:

| 字段 | 说的是 | 谁读 |
|---|---|---|
| `names` | 正式名 / 短名 / 设置里的写法 | 三端显示、回复前缀、`registry.namesOf` |
| `slash` | 微信里切过去的词(`/cc`、`/api`…) | `mode-commands`、拒绝语、`/help` |
| `modelField` | `agent-config` 里它读哪一格模型 | `modelForProvider` |
| `setupHint` | 没接上时怎么装 / 登录(中文) | 「CC 现在怎么样」、doctor |
| `credentialEnv` | 配齐才注册的密钥环境变量 | `executorCredential`、daemon.env 写入 |
| `detect` | 自己的二进制(名字 + 覆盖路径那一格)、必填配置 | **只有** `lib/executor-detect.ts` |

「这台机器上有没有」**只在** `lib/executor-detect.ts` 判(`executorBinary` / `executorCredential` / `executorMissingConfig`)。规则:配置里的值 trim 后为空 = 没配。`scripts/executor-detect.guard.test.ts` 会拦住任何手写的 `findOnPath('xxx')`、`xxxBin ??`、`env.XXX_API_KEY`。

## 3. 「能做到什么」:`src/domain/provider-capabilities.ts`

一份 `ProviderCapabilities`,在 `capability-matrix.ts` 的 `CAPABILITIES_BY_PROVIDER` 里登记。要紧的三格:

- **`adminMcpTools`**:wechat MCP 拿到的是不是**本会话**的档位。钉成静态 trusted 的(agy)写 false ⇒ 访客分派时就拒。
- **`confines`**:自带工具面在 读工作区以外 / 改文件 / 跑命令 / 上网 四件事上各靠什么收住(`per_tool` / `sandbox` / `none`)。**没核实过的写 `none`**,不替它说好话。有一件 `none` ⇒ `guestSafe` 推出 false ⇒ 访客用不了(`provider-policy.ts`)。
- `perToolCallback`、`sandboxLevels`、`supportsDelegation`、`replyDelivery`、`replyText`:见各字段注释。

## 4. 权限怎么翻:`src/domain/policy.ts`

在 `PolicyTarget` 加一种「怎么连的」,在 `compilePolicy` 里写这一家把 档位 × 模式 翻成什么设置(沙箱、审批、应答、开关)。provider 只读 `compilePolicy(...)` 的结果,**不在调用处判 `permissionMode`**。`policy.test.ts` 的全表快照会多出几格 —— 更新快照,PR 里让评审看见这几格。

然后看 `src/domain/enforcement-matrix.ts`:它从派发拒(`providerDenialFor`)、逐工具判定(`authorize`)和 `compilePolicy` 的 strict 设置推出每家 × 每档 × 每类工具实际会怎样。没有逐工具回调的执行者,trusted / admin 两档「要问」的那几类(删东西、删记忆、动 daemon)它做不到:**档位说「问」的,能问就必须问;问不了的**照实落成放或拒 —— 在 `unattendedAnswer` 里写清楚这一家问不了时怎么落(没写就抛)。落成放的,主人切过去时 CC 会照实说「它不会逐条问你」(`noAskNotice`,也是推出来的)。`enforcement-matrix.test.ts` 的快照会多出这一家 —— 更新快照,并在同一文件的 `WHY_GAPS` 写一条为什么;有缺口没写理由 ⇒ 规则测试红。

## 5. 对话侧构造:`src/daemon/bootstrap/providers.ts`

门槛用 detect 判 → 探测(`--version` 之类,异步、带超时)→ `registry.register(id, provider, { canResume, bin? })`。探测失败交给 `createProbeRetrier`(`provider-probe.ts`)退避重探,**不要自己写重试**。有自己的可执行文件就给 `bin: () => …`(每次现判),工作台和额度查询都读它。

## 6. 工作台(可选):`src/features/workbench/wire.ts`

要进「一起做」,在 `BUILD` 表里加一行:从 boot registry 那一项构造工作台用的适配器,带 `workbench` 能力。开机时已登记的先建,之后登记的(重探成功)由 `onRegister` 补上 —— **不要在接线时抄 registry 的快照**。路径读登记项的 `bin()`,不要自己再找一遍。

## 7. 证明

```bash
bun run typecheck && bun run depcheck
bun --bun vitest run src/domain/policy src/domain/enforcement-matrix src/domain/provider-policy src/domain/capability-matrix src/lib/executor-facts src/lib/executor-detect scripts
bun run test:e2e          # 路由快照:/<slash> 在三档下回什么
```

然后在真机上:`wechat-cc selftest chat --provider <id>`;进了工作台再 `wechat-cc selftest workbench --executor <id>`。

## 漏了哪一处,谁会告诉你

| 漏了 | 红的是 |
|---|---|
| `EXECUTOR_FACTS` / `CAPABILITIES_BY_PROVIDER` 少一行 | `executor-facts.test`、`capability-matrix.test`(键与名单相等) |
| `confines` 没写 | typecheck(必填) |
| 手写二进制查找 / 密钥判断 | `scripts/executor-detect.guard.test.ts` |
| `compilePolicy` 没这一家 | typecheck + `policy.test` 快照 |
| 没有逐工具回调、没说问不了时怎么落 | `enforcement-matrix.test`(`unattendedAnswer` 抛) |
| 有缺口没写理由 / 快照变了没接受 | `enforcement-matrix.test`(`WHY_GAPS`、快照) |
| 斜杠词和 `/help`、`PROVIDER_SLASH` 对不上 | `mode-commands.test`、`scripts/provider-registry.guard.test.ts` |
| 工作台接线时抄快照 | `features/workbench/wire.test`(晚到的执行者要出现) |

为什么是这个形状:VS Code 的扩展只**声明**命令和能力,宿主从声明生成一切;Codex 把权限编成两根正交的轴、执行时只认编译结果。我们照的是同一件事 —— 一处声明、处处推导、推导关系由测试证明(架构复查 2026-10-21 理念 1)。
