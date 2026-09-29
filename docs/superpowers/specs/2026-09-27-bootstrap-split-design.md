# `bootstrap/index.ts` 全部走 `wire-*.ts`(梳理第 7 步之二)设计

日期:2026-09-27。状态:设计稿,主人已在对话中批准;代码未动。基线 origin/dev 39cf7f5f。同批:[cli 拆分](2026-09-27-cli-split-design.md)、[workbench service 拆分](2026-09-27-workbench-service-split-design.md)。

**目标:** `buildBootstrap`(198-1321,1123 行,61 个 import)里剩下的 15 个内联关注点全部抽成 `bootstrap/wire-*.ts`,`index.ts` 只剩组装(≤ 400 行);返回的 `Bootstrap` 对象**键集合与类型一个不改**(`bootstrap/types.ts` 不动),既有测试照跑。顺手立两条规矩:index 里只用一种晚绑定;可能失败的子系统全部经 `SubsystemSupervisor`。

**为什么现在:** 它是 7 月以来 churn 第一(84 次),每个新后台功能都往里加一段;头注释里「新接线进 wire-*.ts」的规矩已经写了但只做了 7/22。它**不在** Codex 热点清单里(那里是 `main.ts` / `pipeline-deps.ts`),可以先做。

## 1. 现状(39cf7f5f 行号)

已走 `wire-*`:health(207-214)、providers(675-701,`providers.ts`)、self-restart(894-921)、social(1114-1141)、a2a-server(1144-1157)、pairing(1159-1176)、delegate(1061-1080,`delegate.ts`)、fallback-reply(942-954)、mcp-specs 帮手(296-322)。

仍内联:sup(201-206)、busy + resolver(215-231)、permissionMode / conversationStore(232-242)、**canUseTool(243-287)**、claudeBin(288-294)、**plugins(324-356)**、configuredAgent(358-369)、selfId(370-380)、**knowledge(381-557,177 行)**、**model options(559-651,93 行)**、sessionStore(653-658)、watchdog(659-673)、**prompt thunks / buildInstructions(703-865,163 行)**、SessionManager(867-879)、access-change(881-892)、idle sweep(923-940)、**recordTurn + coordinator(956-1059,104 行)**、**A2A registry/client/events(1082-1113)**、mailboxPollerDeps(1178-1198)、**乙 v2(1200-1230)**。

晚绑定三套并存:`Ref/wireRef`(`wiring/index.ts`)、`let x: T | null = null`(`index.ts:1098,1112` 等)、index 访问的活引用(234-256)。

## 2. 目标形状

```
bootstrap/index.ts               # sup、configuredAgent、selfId、sessionStore、watchdog、SessionManager、
                                 # access-change、idle sweep、以及把各 slice 拼成 Bootstrap 的 return
bootstrap/wire-knowledge.ts      # 381-557,已 sup.start('knowledge')
bootstrap/wire-model-options.ts  # readAgentConfig / currentClaudeModel / currentModelFor / sdkOptionsForProject
bootstrap/wire-instructions.ts   # socialToolsWired / buildInstructions(703-865)
bootstrap/wire-permissions.ts    # busy registry + makeResolver + buildCanUseTool(215-287)
bootstrap/wire-plugins.ts        # loadPlugins / pluginMcp / pluginMcpForClaude + mcp specs(296-356)
bootstrap/wire-coordinator.ts    # recordTurn + handoffMessages + createConversationCoordinator(956-1059)
bootstrap/wire-a2a.ts            # a2a registry / client / events store / resolveOperatorChatId(1082-1113)
bootstrap/wire-yi.ts             # yiHub server + hand client(1200-1230)
bootstrap/wire-mailbox-deps.ts   # mailboxPollerDeps(1178-1198)
```

每个 `wireX` 的签名统一:`wireX(deps: Pick<BootstrapDeps, …>, ctx: BootstrapCtx): XSlice`,其中 `BootstrapCtx` 是 index 在前面几步已经造好的、多个 slice 共用的东西(`sup`、`configuredAgent`、`selfId`、`log`、`stateDir`、`refs`),类型放 `bootstrap/types.ts` 末尾(**加**类型,不改既有 `Bootstrap` / `BootstrapDeps`)。`XSlice` 就是该块今天贡献给 `Bootstrap` 返回对象的那几个键(见下表),index 用展开拼回去。

| wire | 返回给 Bootstrap 的键 |
|---|---|
| knowledge | `knowledge?` |
| model-options | `sdkOptionsForProject`(+ index 内部用的 `currentModelFor`) |
| instructions | `buildInstructions` |
| permissions | `resolve`、`holdBusy`、`busyLabels`(+ index 内部用的 `canUseTool`) |
| plugins | (index 内部用的 MCP specs;`providerNotes` 的一部分) |
| coordinator | `coordinator`、`markInboundActivity?`、`sendAssistantText?` |
| a2a | `a2aDeps?` 的输入、`resolveOperatorChatId` |
| yi | `yiHub?` |
| mailbox-deps | `mailboxPollerDeps?` |

## 3. 两条规矩

1. **晚绑定只用 `Ref/wireRef`。** index.ts 里的 `let x: T | null = null` + 闭包读取全部改成 `wiring/index.ts` 的 `Ref<T>`(fail-fast:没 wire 就读会抛)。`main.ts:191-194` 的三个 let-thunk **不动**(main.ts 是 Codex 热点,另立项)。
2. **可能返回 null 的 wire-* 一律 `sup.start(name, () => …)`。** 今天 `sup.start` 15 处覆盖了一半,另有 16 处私有 `try/catch → null`(如 1098 附近);统一后 `/v1/health.subsystems` 能看到每一块的起没起来。名字沿用现有 `SubsystemName`;新增的名字要同步加进 `health/subsystems.ts` 的清单与它的测试。

## 4. 顺序与提交粒度

按独立性从高到低,一块一个 commit,每个 commit 后 `bun run test src/daemon/bootstrap` + typecheck + depcheck 绿,index.ts 行数棘轮下调:

knowledge → model-options → instructions → permissions → plugins → coordinator → a2a → yi → mailbox-deps → 最后一个 commit 做 §3 的两条规矩(把 let-thunk 改 Ref、把私有 try/catch 改 sup.start)。

每块搬法:先给该块写一条能单独构造它的单测(用 `Pick` 出来的最小 deps 喂假件),看它红(模块不存在)→ 逐字搬代码 → 绿 → index 改成调用。**不改块内逻辑**;发现的 bug 记下来另修。

## 5. 不做

- 动 `main.ts`(Phase 1 那 40 键的 `InternalApiDeps` 内联对象与 20 个 `set*` 晚绑定)—— 等 [workbench service 拆分](2026-09-27-workbench-service-split-design.md)之后、且 Codex 第一批合入后另立项。
- 改 `Bootstrap` / `BootstrapDeps` 的既有键与类型。
- 改任何块的行为(包括 knowledge 那 177 行里的降级分支)。
- 把 `wiring/*`(tick-bodies / pipeline-deps / lifecycle-deps)一起拆 —— `pipeline-deps.ts` 是 Codex 热点。

## 6. 测试与守卫

- 每个 wire-* 一份 `wire-*.test.ts`(至少:给最小 deps 能构造、返回的键齐、可失败的块在 deps 抛错时返回 null 且 sup 记到)。
- 既有 `src/daemon/bootstrap/*.test.ts`、`src/daemon/__e2e__/*` 一行不改,全程绿。
- **新增** `scripts/bootstrap-ratchet.guard.test.ts`:`bootstrap/index.ts` 行数只降不升(初值 1321,目标 ≤ 400);`index.ts` 里 `let .*: .* \| null = null` 出现次数 ≤ N(初值 = 当前数,终值 0)。
- `docs/maintainer/rules-from-real-machines.md`「新接线进 wire-*.ts」那条改成引用本 spec 与守卫。

## 7. 交接

- 触碰文件:`src/daemon/bootstrap/index.ts`、新 `wire-*.ts` 九个(+ 各自测试)、`bootstrap/types.ts`(只加 `BootstrapCtx` 与各 slice 类型)、`health/subsystems.ts`(若加子系统名)、`scripts/bootstrap-ratchet.guard.test.ts`(新)。不碰 `main.ts` / `wiring/*` / `settings-panel.ts`。
- 与 Codex:它第一批若要给 bootstrap 加东西,直接新建 `wire-<x>.ts` 并在 index 的 return 里展开一行;别再往 index 内联。
- 实施计划另出(writing-plans)。约 10 个 commit,一个 PR 合(块与块之间没有可单独发布的价值)。
