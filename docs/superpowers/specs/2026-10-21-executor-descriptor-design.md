# 执行者描述表(重构第二批步 7)设计稿

> 2026-10-21 · wechat-cc-9b 起草,待 wechat-cc-54 审。上位文档:`2026-10-20-refactor-batch2-design.md` §4。
> 这一步**只统一「描述」与「注册」**;「每家三个适配器合成一个」「Policy 编译器」仍放第三批。

## 1. 为什么

每家执行者(claude / codex / cursor / openai / gemini / agy,外加自定义 ACP)的事实散在约 30 处:能力矩阵、档位缺口表、拒绝语、斜杠词、三四套显示名、登录提示、密钥环境变量名、默认模型、端点 host、`guard/targets` 自己猜「谁注册了」、`doctor` 自己找二进制…… 写两处的地方已经对不上(10-21 清点出 13 处,其中 3 处主人会碰到,已在 #494 修掉)。新加一家执行者要改十几个文件,漏一处就是一句假话。

## 2. 描述表长什么样

`src/core/executors/descriptors.ts`(core 层,零运行时依赖,只有数据 + 纯函数):

```ts
export interface ExecutorDescriptor {
  id: KnownProviderId                     // 'claude' | 'codex' | …(仍以 lib/provider-ids 为名单)
  displayName: string                     // 唯一的「主人看到的名字」
  shortName?: string                      // 回复前缀 / 窄处用(缺省 = displayName)
  slash: string                           // 微信切换词(cc / api / …)—— 吸收 #494 的 PROVIDER_SLASH
  transport: 'sdk' | 'cli' | 'acp' | 'http'
  binary?: { names: string[]; configKey?: 'cursorAgentBin' | 'agyBin'; extraSearch?: 'nvm' }  // 找二进制的唯一一处
  credentials?: { env: string[]; configKeys?: string[] }   // 「配齐了才注册」的那些键(openai / gemini / cursor-SDK)
  model: { field: 'model' | 'cursorModel' | 'openaiModel' | 'geminiModel' | 'agyModel'; default?: string }
  login: { hint: string; setup?: string } // 认证失败提示 + 怎么装 / 登录(中文,一家一条)
  endpoints: string[]                     // 网络守护 / 探测 / 分类共用的 host
  platforms?: { win32?: false }           // 不支持的平台,注册前就跳过(chat 与工作台一致)
  chat?: ChatCapabilities                 // 现 provider-capabilities.ts 那一行(原样搬)
  workbench?: WorkbenchKind               // 'managed-native' | 'managed-api' | 'acp' | 'unattended'
  tier: TierGapNote | null                // 现 KNOWN_TIER_GAPS 那一格
}
export const EXECUTORS: Readonly<Record<KnownProviderId, ExecutorDescriptor>>
```

**分两层(10-21 动手时定,依赖规则逼出来的)**:`src/lib` 是依赖树的底,不能 import core,而模型字段(`agent-config`)、密钥名(`llm-keys`)这些读者在 lib / daemon。所以纯数据(斜杠词、模型字段、安装提示、密钥环境变量名、平台、端点)放 **`src/lib/executor-facts.ts`**;带 core 类型的能力行与档位缺口,由 core 按同一个 id 拼成上面的 `ExecutorDescriptor`。两层共用 `PROVIDER_IDS`,各自有「键与名单相等」的测试。

规矩:**描述表只放「是什么」,不放「怎么造」。** 适配器的构造(SDK 选项、MCP 接线、autofix、版本核对)仍在各家的 `register` 函数里 —— 那是第三批「适配器合一」的事。

## 3. 谁改成读它(这一批)

| 现在 | 改成 |
|---|---|
| `provider-capabilities.ts` + `capability-matrix.ts` 的 `CAPABILITIES_BY_PROVIDER` | `EXECUTORS[id].chat`(矩阵变成薄薄一层读取;`capability-matrix.test` 的键相等断言照留) |
| `tier-enforcement.ts` 的 `KNOWN_TIER_GAPS` | `EXECUTORS[id].tier` |
| `provider-policy.ts` 的 `PROVIDER_SLASH`(#494) | `EXECUTORS[id].slash` |
| 显示名:`provider-display-names.ts`、`registry.register(..., {displayName})` 的七个字面量、`resolveAcpAgent` 的 'Cursor' | `EXECUTORS[id].displayName`;registry 注册时从描述表取,**不再各写各的** |
| 登录 / 安装提示:`llm-health.ts` 的 `PROVIDER_SETUP_HINTS`、capabilities 的 `authFailHint`、providers.ts 的 BOOT 日志字符串 | `EXECUTORS[id].login` |
| 密钥环境变量名:`llm-keys.ts` + providers.ts 三处字面量 + `delegate.ts` | `EXECUTORS[id].credentials` |
| 模型字段:`agent-config.ts` 的 `modelForProvider` / `withModelForProvider` if 链;默认模型:`wire-model-options.ts` 与 providers.ts 两处「靠注释保持同步」 | `EXECUTORS[id].model` |
| 端点:`net-probe.ts`、`call-classifier.ts`、`guard/targets.ts`(三份,agy / cursor 的 host 已经对不上) | `EXECUTORS[id].endpoints`(先核对哪一个才对,写进表里时附出处) |
| 二进制查找:providers.ts、`doctor.ts`(`findOnPath('codex')` 漏了 nvm)、`wire-workbench.ts` 的第二次 `findCodexBinary` | `findExecutorBinary(EXECUTORS[id])` 一处 —— **不带缓存,只管「怎么找」;「什么时候找」由调用方定,各处现有时机原样保留**(wire-workbench:187 是接线时查一次并固化进工作台 codex;:162 额度监视器每次现查) |
| 平台:只有 chat 侧的 cursor 判了 win32;工作台 ACP 与自定义 ACP 在 Windows 上先注册、spawn 时才抛(`acp-agent-provider.ts:184` 无条件 `throw`,chat 与工作台共用) | 注册前统一看 `platforms`;**标在传输上(`transport:'acp'` ⇒ win32 不注册),不只标 cursor** —— 内置 cursor 与所有自定义 ACP 在 Windows 上本来就从没跑起来过。可见变化:Windows 上工作台执行者列表少掉这几家(以前能选、一跑就报「暂不支持 Windows」),写进 PR 描述 |

**`bootstrap/providers.ts` 的 if 梯子**:六段改成对 `EXECUTORS` 的一个循环,每家只剩「门槛(二进制 / 凭据)→ 探测 → 注册 / 失败排队重探」三步的共用骨架 + 一个 `build(desc, ctx)`。三份抄出来的「失败 ⇒ scheduleProbeRetry ⇒ 重探 ⇒ registerX ⇒ assertLateRegistration」收成一份。codex 的 autofix / 版本核对、cursor 的两种传输同 id 回退、agy 的全局 MCP 这三样真不同的,留在各自的 `build` 里。

**`guard/targets.ts` 不再自己猜谁注册了**:改读 daemon 的已注册列表(在 daemon 里直接问 registry;CLI 侧走 /v1/health 已有的 providers 字段)。

## 4. 这一批不做

- **欠账(记着,不在这一批)**:工作台 codex 的二进制在接线时固化。CLI 全自动升级换 codex 时,两种装法的路径都不变(standalone 换的是 `current` 软链、npm 全局 bin 不变),所以今天碰不到 —— 但这是靠巧合。以后要么工作台每次 spawn 现查,要么 cli-upgrade 升级成功后让工作台重新接一次 codex。动它会改执行路径,放第三批。

- 不动适配器本身、不合并 chat / workbench / delegate 三套适配器(第三批)。
- 不改任何对外文案的**内容**,只把它们收到一处(显示名不一致的那几处,收的时候选哪个由我列成表给主人看一眼 —— 见 §6)。
- 客户端(桌面 `view.js` 的 `PROVIDER_LABELS`、`agent-avatars.js`、App `agents.ts`)这一批不动:它们走协议,另起一步让 daemon 把显示名下发,客户端不再各存一份。

## 5. 怎么证明行为没变

- 现有的 registration / capability / tier 测试全部原样过(`providers.test`、`providers.probe-retry.test`、`bootstrap.test` 221–530、`capability-matrix.test`、`tier-enforcement*.test`、`wire-workbench.test`、各家 error 测试)。
- **新守卫测试**(今天一条都没有):
  1. 每家 `displayName` 在 registry、回复前缀、通知文案里是同一个字符串;
  2. `slash` 与 mode-commands 解析往返(#494 已有);
  3. `model.field` 与 `modelForProvider` 一致(#494 已有,改读表后照过);
  4. `endpoints` 是 guard / 探测 / 分类三处的唯一来源(三处都 import 它);
  5. `platforms.win32 === false` 的执行者,chat 与工作台在 win32 上都不注册;
  6. `EXECUTORS` 的键与 `PROVIDER_IDS` 相等。
- 启动快照:改前改后各起一次 daemon(e2e harness),`/v1/health` 的 providers 段与 `/mode` 输出逐字相同。

## 6. 需要人定的

- **显示名统一成哪一套**(现在 openai 叫「API」「OpenAI-compatible」「自定义 AI 服务」「OpenAI」四种;agy 叫「agy」「Gemini (agy)」「Gemini · 账号连接」「Antigravity」)。我的建议:daemon 侧对主人一律用桌面现在那套(「自定义 AI 服务」「Gemini · 账号连接」),回复前缀用短名(`API`、`agy`)。这是文案,**收的时候列表给主人**,不自己拍。
- 端点 host 哪个才对(agy:`cloudcode-pa` 还是 `generativelanguage`;cursor:`api2.cursor.sh` 还是 `cursor.com`):真机抓一次连接再定,不猜。

## 7. 切法(每步一个 PR)

1. 新建 `descriptors.ts`,先只放 id / displayName / slash / model / login / credentials / platforms;`PROVIDER_SLASH`、`modelForProvider`、登录提示、密钥名改读它。+ 守卫测试 2、3、6。
2. `chat` / `tier` 搬进去,能力矩阵与档位缺口表变成读取层。+ 守卫 1。
3. 二进制查找 + 平台门统一(含 doctor、工作台);providers.ts 循环化。+ 守卫 5。
4. endpoints 收口(真机核对 host 之后)+ guard/targets 改问 registry。+ 守卫 4。
