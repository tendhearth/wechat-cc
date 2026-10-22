# 执行者「在不在」只判一处(3c 第三块)设计稿

> 2026-10-22 · wechat-cc arch-review 起草,待 wechat-cc-9d 审。上位:`docs/architecture-review-2026-10-21.md` §3c「注册只在一处」、`2026-10-21-executor-descriptor-design.md` §3 二进制查找 / 平台门。

## 1. 现在是什么样(读代码核过)

对话侧 `bootstrap/providers.ts` 判每家「装没装、配没配、平台支不支持」,探测 `--version`,失败交给 `createProbeRetrier` 重探,成了就注册进 `boot.registry`。

工作台 `wire-workbench.ts` **不自己判**,开机时把 `boot.registry` 抄一遍(`main.ts:759` 调一次),再各家现场补一点:codex 再跑一次 `findCodexBinary()`(接线时一次、额度监视器每次两次);cursor 走 `resolveAcpAgent`;openai 在 `workbench-api.ts` 里把三个配置再判一次;agy 直接复用对话侧那个实例。

## 2. 问题(按严重排)

1. **晚到的执行者进不了工作台。** codex / cursor / agy 开机探测失败、过一会儿重探成功(或 CLI 升级后 `reprobeProvider`)⇒ 对话侧有了,工作台要等下次重启。主人看到的是:微信里 `/codex` 能用,「一起做」里没有 codex。**这是行为 bug,不是重复代码的问题**,光去重修不好。
2. **同一个事实判两遍、判法不一样。**
   - `cursorAgentBin` 配成空串:对话侧 `??` ⇒ 当成配了、不注册;工作台 `||` ⇒ 回落 PATH、注册。面板清空一格就是空串,所以这个不是假设。doctor、cli-upgrade/locate 用 `??`,guard/targets 用真值判断,两派各占一半。
   - codex 二进制对话侧找一次、工作台再找一次;模型来源也不同(对话侧只认 `CODEX_MODEL` 环境变量,工作台 `modelForProvider`)。
   - 凭据(openai 三项、gemini 两项、cursor key)在 providers / workbench-api / doctor / guard 各写一遍,guard 和 doctor 判 openai 不看 key。
3. 显示名:`agents.ts` 写死 `'Cursor'`,没读 `EXECUTOR_FACTS`。

## 3. 同类产品怎么做

- **Home Assistant**:集成先 `async_setup_entry` 成功才算「在」,之后加载的平台(sensor、switch…)都挂在这个 entry 上;entry 晚一点 setup 成功,平台跟着上来,不用重启 HA。
- **VS Code**:扩展「激活」是一个事件,命令 / 视图在激活时才挂上,不在开机时抄一份。
- 我们照的:**「在不在」由对话侧判一次并广播,工作台订阅,不自己再判。** 理念 1(一处声明、处处推导)+ 理念 4(按事件接线,不抄快照)。

## 4. 做法(三个 PR,行为变化只在第 1、2 步,各自写明)

**第 1 步:工作台跟着注册走(修 bug)。**
- `ProviderRegistry` 加 `onRegister(cb): () => void`(同步回调,注册完立刻调;返回退订)。
- `wireWorkbench` 把现在逐家的那几段收成 `const BUILD: Partial<Record<KnownProviderId, (entry) => void>>`(claude / codex / openai / cursor / agy,内容原样搬),先对已注册的跑一遍,再 `onRegister` 补后来的。同一家已经建过就跳过(幂等)。
- 测试:boot registry 开机没有 codex ⇒ 工作台没有;之后注册 codex ⇒ 工作台有了,而且只建一次。
- 可见变化:重探成功的执行者不重启就出现在「一起做」里。

**第 2 步:`detectExecutor` 一处判「这台机器上有没有」。**
- `src/lib/executor-detect.ts`,纯函数:`detectExecutor(id, { config, env, platform, findOnPath, findCodex }) → { ok: true, bin?, credentials? } | { ok: false, reason }`。
- 规则写进 `EXECUTOR_FACTS`(新增 `binary: { names, configKey?, nvm? }`、`requires: { env?, config? }`、`platforms`),detect 只读表。
- 定一条:**配置里的路径是空串 = 没配**(面板清空就是空串),统一 `||`。这会改变对话侧一种情况:`cursorAgentBin: ''` 以前不注册 cursor,以后回落 PATH 找。写进 PR 描述。
- 读它的:providers.ts、workbench-api、`resolveAcpAgent`、doctor、guard/targets、cli-upgrade/locate。测试:每家每条门槛一个用例;六处调用方都 import 它(守卫测试扫源码,出现手写的 `findOnPath('cursor-agent')` / `process.env.GEMINI_API_KEY` 等就红)。

**第 3 步:二进制路径随注册下发,工作台不再自己找。**
- 注册时把 detect 的结果以**取值函数** `bin(): string | null` 放进 registry 那一项的 opts(每次调用现判,不缓存);工作台 codex / 额度监视器读它,删掉三次 `findCodexBinary()`。
- 还掉上位稿 §4 那笔账(codex 路径只在接线时查一次):工作台 codex **每次 spawn / resume 时**调 `bin()` 取路径,而不是接线时固化。CLI 升级换了路径,下一个回合自然用新的。

## 4.1 三条定案(9d 审稿时要求写明)

**① 换路径 / 重登记时,在跑的不断、旧的不漏。** 不做「换适配器」:registry 今天就是 `register` 遇到重复 id 直接抛,一家一个 id 只建一次,本稿不改这一点。路径变化走第 3 步的 `bin()` —— 适配器实例不换,换的只是**下一次** spawn / resume 用的可执行文件:
- 在跑的回合:用它 spawn 时的那个进程跑完,不打断(进程是那时起的,和 registry 无关)。
- 新开的、续接的:spawn 时现取 `bin()`,用新路径。
- 没有「旧适配器」要 close:实例只有一个。cursor 的常驻 ACP 连接是按会话开的、随会话关(现有逻辑),不受路径变化影响 —— 旧会话的连接照旧在会话结束时关,新会话用新路径起新连接。
- 测试钉住:假 codex 路径 A 起一个长回合 → 把 `bin()` 改成 B → 再开一个回合:第一个回合的进程仍是 A 且正常跑完、第二个用 B;两个回合结束后没有残留子进程(进程表里 A、B 都不在)。

**② 注销:只增不减,用的时候失败照实报。** 不加 `onUnregister`。执行者开机后被卸载 / 登录失效,registry 里那一项照旧在;下一次 spawn 失败,走现有的报错路径(工作台任务进 failed 并写原因、微信回「X 没起来:<原因>」),不假装成功、不静默换别家。理由:今天没有任何一条路径会注销,加一个永远不触发的回调只会是没人测过的分支;真要「卸载后从列表消失」,那是另一件事(doctor / 面板展示层),不在这一块。

**③ 「空串 = 没配」是对话侧看得见的变化**:`cursorAgentBin` / `agyBin` 配成空串,以前对话侧当成配了、不注册;以后回落 PATH 找,找到就注册。第 2 步的 PR 描述写一句,同一个 PR 往下一版发版说明(`docs/releases/desktop-v1.7.8.md`,没有就新建这一节)加一句:「设置里清空 Cursor / agy 的路径,现在等于『自动找』,不再等于『不用』。」

## 5. 这一块不做

- 不合并对话 / 工作台两套适配器(各自的 build 留着,那是「适配器合一」)。
- 不动探测和重探本身(只有一份,`provider-probe.ts`)。
- gemini 不进工作台(现状如此,不在这块定)。
- 对话侧 cursor 走 SDK 兜底时工作台要不要建 ACP cursor:维持现状(看 boot registry 有没有 cursor + detect 到二进制),不在这块改。
- 端点 host 收口:仍等真机抓连接,单独做。

## 6. 怎么证明

- 现有 providers / probe-retry / wire-workbench / bootstrap / doctor / guard 测试原样过。
- e2e 启动快照:`/v1/health` providers 段与 `/mode` 输出改前改后逐字相同(第 2 步的空串规则除外,用单测钉)。
- 第 1 步的新测试临时删掉 `onRegister` 那行要红;第 3 步「在跑的不断、旧的不漏」那条测试,临时把 `bin()` 改回接线时固化要红。
