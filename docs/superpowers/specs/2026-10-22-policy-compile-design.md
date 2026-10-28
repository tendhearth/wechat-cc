# 权限只编译一次(3c 最后一块:Policy 编译器)设计稿

> 2026-10-22 · 审查者起草,待整合者审。上位:`docs/architecture-review-2026-10-21.md` §3c「Policy 编译器把 Codex / agy / Cursor 的翻译层纳入证明」、理念 1(一处声明、处处推导,由测试证明)。

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
3. **删掉 `assertSupported` 这道假检查。** ⟨10-22 动手时改:原计划让它读 gaps 在分派时拒;但第 2 步之后已知执行者的缺口全由规则测试守(漏登记 CI 红),运行时那一拒对已知执行者永远走不到,对未知 id 又拿不到能力行 —— 写一道永远不触发的运行时检查,就是再造一个 `forbidden`。按理念 5「规矩交给机器」,守在测试里,运行时删掉。(#566)⟩
4. **`guestSafe` 从 `enforces` 推出来**,删掉手写的那一格(#556 刚改成必填,这一步把它变成推导)。

## 6. 准绳(整合者同意)与两步待主人点头

整合者审稿时指出:admin 下 codex 删东西不问、ACP Cursor 却全拒 —— 对同一个主人,两家做法正好相反。定一条准绳,两家都照它:

> **档位说「问」的,执行者能问就必须问;问不了的,登记成已知缺口,并在主人切过去时说一句。**

- **ACP Cursor:能问 ⇒ 改成问。** 它每条命令都发 `session/request_permission`,做得到逐条问;今天一律 `reject_once` 是「能问却不问、直接拒」,不符合准绳。改成:按编译出的 `wants` 应答 —— allow 的放、deny 的拒、ask 的走和 claude 同一条权限卡(`permission-relay` → 微信 / 手机,拍板码),超时按拒。guest 不受影响(本来就分派时拒)。这是行为变化,单独一个 PR(第 5 步),上线时写进发版说明。
- **Codex / agy:问不了 ⇒ 维持不问,登记 + 说一句。** codex 的 approval 只有整轮粗粒度(`on-request` 会让每条越界命令都弹卡,而且分不出 destructive),agy 没有逐条回调。两家在 admin / trusted strict 下 `shell_destructive` 等「问」的维度登记为已知缺口(第 2 步),并在微信 `/codex`、`/agy` 切过去时回一句「它不会逐条问你,删东西也不会」—— CC 不骗人,主人知道再选。
- openai 的「问 ⇒ 拒」:它有自己的循环,做得到问;按准绳也该改成问。放在 Cursor 之后,同样单独一个 PR(第 6 步)。

**准绳和 codex / agy 的处理(登记 + 切过去说一句,不改执行行为)已定,随第 1–4 步做。第 5、6 步停在稿子里,等主人点头**:它们改变主人每天用 Cursor / 自定义 AI 服务的感受(以前一律拒,以后每条命令弹卡),「你做决定」的授权管不到这种天天看得见的行为变化(整合者审稿意见,已转给主人)。

于是 §5 的切法补两步(待主人点头):

5. **ACP Cursor 按编译结果应答,「问」走权限卡。** 测试:trusted strict 下 shell 请求弹卡、拍板放行才执行、超时拒;admin dangerously 全放不变;guest 照旧分派时拒。
6. **openai 的 relay 接权限卡**(同上)。

## 7. 这一块不做

- 不改 `TIER_PROFILES` 本身(档位要什么不变)。
- 不合并对话 / 工作台两套适配器;工作台的执行者权限(`WorkbenchExecutorCapabilities`)不在这张表里,另说。
- gemini 已弃用,只做到「编译出来和今天一样」,不补能力。
