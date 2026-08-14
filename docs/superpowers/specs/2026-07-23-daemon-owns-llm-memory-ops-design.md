# daemon 独占 LLM 记忆操作(消除编译-sidecar 运行时分歧)设计

**日期**: 2026-07-23
**状态**: 已批准(彻底解决 + 防复发护栏,非补丁)
**根因来源**: 桌面「重新整理」按钮报 `Claude Code process exited with code 1` —— 编译 sidecar(`bun build --compile`)里 claude-agent-sdk 的 `query()` 在 bunfs 虚拟文件系统找不到 claude(findClaudePath 陷阱);daemon(bun 直跑,`pathToClaudeCodeExecutable` 已传)不受影响。

## 背景与目标

wechat-cc 有**两个后端运行时**:①**daemon**(launchd 起 `bun cli.ts run`,常驻,真 node_modules,claude 路径解析正确);②**编译 sidecar**(桌面 app bundle 里的 `wechat-cc-cli`,每次调用起一个,bunfs)。桌面对部分命令走 sidecar。任何从**编译 sidecar** 发起的 LLM 调用(claude-agent-sdk `query()` / Codex)都会踩 findClaudePath 陷阱 → "dev 好好的、装出来就坏"的一类 bug。

本设计**消除这一类分歧**,而非给 sidecar 打 claude-路径补丁:确立"LLM 只在 daemon 运行时"的原则,把桌面的两个 LLM 记忆操作改走 daemon HTTP 路由,并加两道护栏让此类分歧无法再静默复发。

## §1 架构原则(写进 spec + `architecture-conventions` memory)

**LLM/claude 调用只在 daemon 运行时里发生。编译 sidecar 只承担 daemon-down 的生命周期/巡检命令(setup / doctor / service / update / daemon kill 等),永不触碰 claude-agent-sdk 或 Codex SDK。** 每个客户端(web dev / 桌面 / 未来 app)都是 daemon HTTP API 的瘦客户端 —— 一份运行时、一处日志、一个可调试面。

## §2 daemon 侧:两条 LLM 记忆路由

两个 LLM 记忆操作的核心早已是 provider 注入式(`src/lib/memory-synthesis.ts`:`synthesizeOverview` + `synthesizeProfile`,sdkEval 注入),daemon 侧 `synthesizeMemory`(`pipeline-deps.ts:219`)已用 daemon registry 的 cheapEval 正确接线。只需把它们暴露成 internal-api 路由:

- **`POST /v1/memory/synthesize`** → 复用现成 `synthesizeMemory(adminChatId)`(daemon cheapEval + lifeStores)。body 可选 `{chat_id}`(缺省=access.json 单一 admin,同 CLI 解析)。返回 `SynthesizeResult`(path/bytesWritten/projectsFound…)。
- **`POST /v1/memory/profile/generate`** → 新 daemon dep `generateProfile(adminChatId)` = `synthesizeProfile({ stateDir, adminChatId, sdkEval: daemonCheapEval, lifeStores, generatedBy:'manual', modelProvider })`(镜像 synthesizeMemory 的接线)。body 可选 `{chat_id}`。返回 profile 生成结果。
- **暴露**:`InternalApiDeps` 增 `memory?: { synthesize(chatId?): Promise<...>, generateProfile(chatId?): Promise<...> }`,由 main.ts 从 boot 组装(registry cheapEval + stateDir + db lifeStores,复用 pipeline-deps synthesizeMemory 的构造)。未接线(无 provider)→ 路由 503,同 voice_not_wired 姿势。
- **定级 trusted**:桌面/CLI 的唯一凭据是 0600 文件 token(=trusted),同今天那批读路由降级。理由:localhost-only,动的是主人自己的记忆,烧一次 LLM;`route-tiers.ts` 两条显式登记(全量条目断言要求),挂发布评审旗。

## §3 桌面:改调 daemon 路由

`apps/desktop/src/modules/memory.js`:
- `synthesizeMemory`(重新整理)从 `invoke("wechat_cli_json", {args:["memory","synthesize","--json"]})` 改为 `invokeApi("POST", "/v1/memory/synthesize")`。
- profile generate(刷新画像)从 `args:["memory","profile","generate",...]` 改为 `invokeApi("POST", "/v1/memory/profile/generate", { chat_id })`。
- daemon 未起 / 503 → 清楚文案("需要守护进程运行后才能重新整理记忆")。其余 memory 命令(list/read/write/projects/profile-read/observations)是纯文件/db IO 不碰 claude,**保持 sidecar 不动**。

## §4 护栏(防这一类 bug 复发)

- **护栏①(运行时委托)**:cli.ts 的 `memory synthesize` / `memory profile generate` 用现成 `isCompiledBundle()`(`src/lib/runtime-info.ts`)判断:**在编译 sidecar 里不 inline `query()`**,而是委托 daemon internal-api(经 `daemon api-info` 拿 baseUrl+文件 token,POST 上面两条路由);daemon 没起 → 明确报错 `LLM 操作需要守护进程运行(编译环境不自行 spawn claude)`。**bun 直跑(dev/终端,`isCompiledBundle()===false`)保持 inline `query()` 不变**(有真 node_modules)。这样任何编译二进制都不可能静默踩 findClaudePath 坑。
- **护栏②(CI 冒烟)**:CI 加一步 `bun build --compile` 出 sidecar,冒烟断言:编译版 `memory synthesize --json`(daemon 不在时)返回**结构化的"需要守护进程"错误**(而不是 bunfs 崩溃 / exit 1 stack)。以后任何"编译 vs bun"分歧发版前就红。

## 数据流

```
桌面「重新整理」 → invokeApi POST /v1/memory/synthesize
  → daemon(bun,claude 路径正确) synthesizeMemory → synthesizeOverview(cheapEval) → 写 _overview.md → 200
CLI `wechat-cc memory synthesize`(编译版) → isCompiledBundle() → 委托同一条 daemon 路由
CLI `bun cli.ts memory synthesize`(dev) → inline query()(真 node_modules)
微信「整理记忆」 → 既有 admin-command synthesizeMemory(不变)
```

## 错误处理 / 测试 / 非目标

**错误处理**:路由 503 当 memory dep 未接线;daemon-down 委托给清晰错误;synthesizeOverview 内部错误透传(同现状)。

**测试**:
- 路由单测(`routes` 或新 `routes-memory.test.ts`):synthesize/profile-generate 透传 daemon dep、503 未接线、trusted 定级断言(route-tiers.test 加 2 条 + 全量条目断言覆盖)。
- 护栏①单测:`isCompiledBundle()===true` 时 synthesize/profile-generate 走委托分支(注入 stub daemon caller,断言不调 inline query;daemon-down → 结构化错误)。
- 护栏②:CI job（compiled-sidecar-smoke)——`bun build --compile` + 运行断言(见 §4)。
- 桌面模块测试:memory.js 两个按钮改调 invokeApi 的路径 + 503 文案。
- 全量回归 + `bunx tsc --noEmit`。

**非目标**:改 setup/doctor/service/update 等无 LLM 的 sidecar 命令;改 memory list/read/write/projects(纯 IO);把 daemon 也变成"必须常驻"(dev 无 daemon 仍可 `bun cli.ts` 跑 LLM);第三处 query()(sessions 摘要 refresh,后台 fire-and-forget,非桌面按钮)——同属该类,但本弧聚焦桌面两个按钮 + 通用护栏,摘要 refresh 若在编译环境跑也会被护栏①覆盖(它在编译 sidecar 里同样应委托),纳入护栏①的统一处理点。
