# 权限只编译一次(3c 最后一块:Policy 编译器)设计稿

> 2026-10-22 · wechat-cc arch-review 起草,待 wechat-cc-9d 审。上位:`docs/architecture-review-2026-10-21.md` §3c「Policy 编译器把 Codex / agy / Cursor 的翻译层纳入证明」、理念 1(一处声明、处处推导,由测试证明)。

## 1. 现在是什么样(读代码盘点过)

档位(admin / trusted / guest,`core/user-tier.ts` 的 `TIER_PROFILES`)× 权限模式(strict / dangerously)翻成执行者设置,**每家一个翻译函数,没有一处总的**:

| 执行者 | 翻译在哪 | 怎么翻 |
|---|---|---|
| claude | `tierProfileToClaudeSdkOpts` + `permission-relay` 的 `effectivePolicy` | 逐工具:allow / deny / 问主人 |
| openai | `openai-gate.ts` 的 `gateTool` | 逐工具;**relay 一律当 deny**(从不问) |
| gemini | `makeGeminiToolGate` | 逐工具;`effectivePolicy` 的一份内联抄本 |
| codex | `tierProfileToCodexSdkOpts` | 粗粒度:dangerously ⇒ full + never;能写能跑 ⇒ workspace-write + never;否则 read-only + untrusted |
| cursor(ACP) | `acp-agent-provider` 的 `permissions:'mode'` | **只看 permissionMode,不看档位**:dangerously 全放,否则所有请求都 reject_once |
| agy | `agy-agent-provider` | 只有 dangerously ⇒ `--dangerously-skip-permissions`;MCP 钉 trusted |

分派时的拒绝在两处:`provider-policy.providerDenialFor`(访客 + trusted 名单)和协调器的 `assertSupported`。`tier-enforcement.ts` 给 guest / trusted 在 strict 下每家标「逐工具 / 分派拒 / 缺口」,缺口必须写理由(有测试)。

## 2. 问题

1. **两份说法对不上**:`capability-matrix` 的 `coarseApproval` 说 codex 在 strict 下是 `untrusted`(有测试钉着),codex 实际用的是自己函数里的 `never`。前者没人读,是一份会骗人的文档。
2. **`assertSupported` 是死代码**:所有 trait 的 `forbidden` 都是 false,而且传进去的是全 daemon 的 permissionMode,不是这个对话的 effective mode。
3. **admin 从没被核过**。strict 下 admin 的 `shell_destructive` / `memory_delete` / `daemon_remediate` 是「问主人」,codex(workspace-write + never)和 agy 根本不问;ACP Cursor 反过来,admin 的每条命令都拒。`tier-enforcement` 只覆盖 guest / trusted。
4. **ACP Cursor 不看档位**:trusted 的 shell 本该逐条问,现在一律拒,也没登记成「比档位更严」。
5. openai 把「问」收成「拒」(更严),同样没登记。
6. ~~主动 / 定时那一拍不过 `providerDenialFor`~~ —— 盘点时查到,已单独修(#562)。

## 3. 同类产品怎么做

- **Codex**:权限是两根正交的轴 `sandbox_mode × approval_policy`,执行时只认编译出来的那一对;配置层只是输入。
- **Claude Code**:allow / deny / ask 规则一份配置,每次工具调用都过同一个判定,`--dangerously-skip-permissions` 只是把 ask 翻成 allow。
- 我们照的:**档位说「要什么」,执行者说「能做到什么」,编译一次得出「这一轮实际是什么」+「差了哪几维」**;差的那几维要么在分派时拒,要么作为登记过的缺口(带理由,测试强制),不允许第三种。

## 4. 做法

**`core/policy.ts`(纯函数,零 SDK 依赖)**

```ts
type Dimension = 'fs_write' | 'shell' | 'shell_destructive' | 'network' | 'read_outside_workspace' | 'admin_mcp' | 'plugin_tool' | 'ask'
type Want = 'allow' | 'ask' | 'deny'                 // 档位 × 模式要的(由 TIER_PROFILES + effectivePermissionMode 推)
type Can  = 'per_tool' | 'coarse' | 'none'           // 执行者在这一维能做到的(每家声明一次,放进能力表)
interface CompiledPolicy {
  wants: Record<Dimension, Want>
  executor: ExecutorSettings                         // 判别联合:claude/openai/gemini 的逐工具判定、codex 的 sandbox×approval、cursor 的 ACP 应答、agy 的开关
  gaps: Array<{ dim: Dimension; want: Want; got: 'allow' | 'deny'; reason: string }>   // 想要的做不到,实际落成了什么
}
compilePolicy(executor, tier, permissionMode): CompiledPolicy
```

- 每家的翻译函数改成**只读 `compilePolicy(...).executor`**;原来那几个 `tierProfileToXxxSdkOpts` 变成编译器内部的分支(第一步行为不变,逐字搬)。
- 能力表(`provider-capabilities.ts`)每家加一行 `enforces: Record<Dimension, Can>`,和 `guestSafe` 一样必填。`guestSafe` 以后从它推出来(`read_outside_workspace` 或 `fs_write` 做不到按档位收紧 ⇒ false),不再手写。
- 删掉 `capability-matrix` 的 `coarseApproval` / `approvalPolicy` 和对应测试(那份说法从来不是真的)。
- `assertSupported` 改成读 `gaps`:**缺口落成 allow(比档位松)且没登记 ⇒ 分派时拒**;落成 deny(比档位严)只记不拒。传对话自己的 effective mode。

**证明(理念 1、5)**

- 快照测试:6 家 × 3 档 × 2 模式 = 36 格的 `CompiledPolicy` 全表,改动必须改快照,PR 里看得见哪一格变了。
- 规则测试:每一个 `got:'allow'` 且 `want≠'allow'` 的缺口,必须在 `KNOWN_POLICY_GAPS` 里有一行理由;表里多余的行也红(沿用 `tier-enforcement` 的做法,扩到 admin)。
- 现有 `tier-enforcement.proof` 里真调 claude / openai / gemini 闸门的那几条照留,codex 加一条:编出来的 sandbox / approval 与 `codex-agent-provider` 实际传给 SDK 的一致(抓 SDK 选项)。

## 5. 切法(每步一个 PR)

1. **`compilePolicy` + 快照,行为不变。** 六家翻译函数挪进去,provider 改读它;删 matrix 那份假说法;36 格快照。
2. **缺口登记扩到 admin。** 把今天 admin 的真实缺口(codex / agy 不问 destructive)登记成「已知、带理由」,规则测试上线。此步仍不改行为。
3. **`assertSupported` 读 gaps。** 没登记的「比档位松」在分派时拒。今天按第 2 步全部登记过,所以上线时没有可见变化;以后新加执行者或改档位,漏登记就红 / 就拒。
4. **`guestSafe` 从 `enforces` 推出来**,删掉手写的那一格(#556 刚改成必填,这一步把它变成推导)。

## 6. 需要主人定的(不自己拍)

- **admin 用 codex / agy 时,危险命令要不要问?** 今天不问(codex 的 never、agy 没有逐条回调)。要问的话:codex 改 `on-request` 会让每条越界命令都弹卡(会很吵);agy 没法逐条问,只能整家对 admin 也不开放 destructive。我的建议:**维持不问,登记成已知缺口**,因为主人是自己机器的主人,用 codex 时本来就预期它会自己跑;微信里切到 codex 时提示一句「codex 不会逐条问你」。
- **ACP Cursor 在 trusted / admin strict 下:继续一律拒,还是走主人拍板?** 今天一律拒(更严、安全,但 Cursor 在对话里基本跑不了命令)。工作台那边 Cursor 已经有权限卡。我的建议:**对话侧也接到权限卡**(和 claude 一样问主人),这是行为变化,单独一个 PR、主人点头再做。

## 7. 这一块不做

- 不改 `TIER_PROFILES` 本身(档位要什么不变)。
- 不合并对话 / 工作台两套适配器;工作台的执行者权限(`WorkbenchExecutorCapabilities`)不在这张表里,另说。
- gemini 已弃用,只做到「编译出来和今天一样」,不补能力。
