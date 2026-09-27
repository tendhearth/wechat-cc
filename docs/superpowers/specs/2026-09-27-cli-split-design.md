# `cli.ts` 拆成命令登记表(梳理第 7 步之一)设计

日期:2026-09-27。状态:设计稿,主人已在对话中批准;代码未动。基线 origin/dev 39cf7f5f。同批的另两份:[bootstrap 拆分](2026-09-27-bootstrap-split-design.md)、[workbench service 拆分](2026-09-27-workbench-service-split-design.md)。

**目标:** 根 `cli.ts`(4332 行、40 个命令族、127 个 `defineCommand`)变成只剩 imports、`SUBCOMMANDS` 表和 `main` 的登记表(≤ 800 行);每个命令族的代码住在 `src/cli/commands/<family>.ts`。**纯搬家:任何命令的行为、名字、`--help` 输出逐字节不变。**

**为什么现在:** `cli.ts` 在分层规则之外(depcruise 的 `cli-must-not-depend-on-daemon` 只管 `^src/cli/`),动态 import `src/daemon` 内部 39 处,7 月以来改了 42 次;`scripts/cli-ratchet.guard.test.ts` 已把它钉在 4332 行,任何新命令都会先红。它不在 Codex `codex/cc-task-entry` 的热点清单里,可以随时做。

## 1. 目标形状

```
cli.ts                       # imports + HELP 引用 + SUBCOMMANDS + cittyRoot + main + readStdin
src/cli/help.ts              # HELP_TEXT(原 55-223 行)
src/cli/output.ts            # emitJson(原 29-38,含 out_file 绕法与注释)
src/cli/flags.ts             # parseTimeoutMsFlag / parseBudgetUsdFlag / parseCountFlag / parseBoolValue
src/cli/daemon-restart.ts    # restartDaemonAndWait(原 3809-3828)
src/cli/commands/<family>.ts # 每族一个文件,export const <family>Cmd = defineCommand({...})
```

命令族(按 39cf7f5f 的行号,拆时以实际为准):memory(1002-1592,591 行,含 `readCliApiInfo`/`resolveProfileChatId`/`profileProvider`/`makeProfileSdkEval`/`runMemoryProfileGenerate` 五个帮手)、self(2529-2854)、plugin(3905-4136)、hand(3671-3901)、sessions(510-734)、dialogue(3443-3663)、agent(3214-3359)、provider(858-994,含导出的 `computeProviderSetOutcome`)、daemon(1995-2126)、hook(1783-1905,含 `hookRelayCmd`/`hookTargets`/`hookFileFor`)、mode(3030-3138)、service(2283-2383)、selftest、ci、account、avatar、guard、events / observations / milestones / conversations、logs / log、companion、connection、demo(含 `runDemo`)、run、setup / setup-poll、install、doctor / setup-status、install-progress、reply、update、mcp-server / federated-source、social、pair、license、backup、status / list、access。

一族一个文件,族内子命令保持原有嵌套;一个族只有一条命令的也一样一个文件(登记表读起来齐整)。

## 2. 分层规则要说实话

那 39 处 `await import('./src/daemon/…')` 随命令体搬进 `src/cli/commands/`,会撞上 depcruise 的 `cli-must-not-depend-on-daemon`(error)。定案:

- `.dependency-cruiser.cjs` 加一条 `cli-commands-may-link-daemon-for-now`:`from: ^src/cli/commands/`、`to: ^src/daemon/`、severity **warn**,注释写明「这是搬家前就存在的耦合,不是许可」;原 error 规则保持对 `src/cli/` 其余部分生效。
- `scripts/cli-ratchet.guard.test.ts` 改成两把尺:`cli.ts` 行数(目标终值 ≤ 800,拆一族降一次)+ `src/cli/commands/**` 里 `from '../../daemon/`、`import('../../daemon/` 的总数(初值 = 搬完的实数,**只降不升**)。
- 真正解耦(命令改走内部 API 或 `src/core`)**不在本 spec**,另立项;本 spec 只让耦合可见、可量。

## 3. 顺序与提交粒度

按体积从大到小,一族一个 commit:memory → self → plugin → hand → sessions → dialogue → agent → provider → daemon → hook → mode → service → 其余按顺序。每个 commit:

1. 新建 `src/cli/commands/<family>.ts`,把 `defineCommand` 树与只有该族用的帮手**逐字**搬过去(注释一并搬);
2. `cli.ts` 的 `SUBCOMMANDS` 改成 `import { familyCmd } from './src/cli/commands/family'`;
3. 跑 §5 的三条守卫 + `bun run typecheck` + `bun run depcheck`;
4. 把 `cli-ratchet` 的 `MAX_LINES` 下调到当前值。

跨族共用的帮手(`emitJson`、`parse*Flag`、`restartDaemonAndWait`、`HELP_TEXT`)在第一个 commit 之前先下沉(§1 的四个新文件),各自一个 commit。

## 4. 不做

- 改任何命令的名字、参数、输出、退出码。
- 合并或删除命令(`log` vs `logs`、`setup` vs `setup-poll` 之类的历史包袱照旧)。
- 把命令改成走内部 API(§2 已说明另立项)。
- 动 `src/cli/*.ts` 里既有的实现模块(它们已经是被 cli.ts 调用的形状,只是调用方搬了家)。

## 5. 测试与守卫

- **新增** `scripts/cli-smoke.guard.test.ts`:从 `cli.ts` 导出 `SUBCOMMANDS`(或解析源码取键),对每个子命令 spawn `bun cli.ts <name> --help`,断言退出码 0 且输出非空;子命令带子子命令的(`memory`、`self`、`plugin`、`hand`、`agent`、`dialogue`、`daemon`、`sessions`、`account`、`companion`、`social`、`ci`、`selftest`、`hook`、`guard`、`provider`、`mode`、`license`、`backup`、`avatar`、`events`、`observations`、`milestones`、`conversations`、`demo`、`access`、`connection`)再各 spawn 一层。搬家漏登记、import 路径写错,这里先红。
- **新增** `src/cli/help.test.ts`:`SUBCOMMANDS` 的每个键都出现在 `HELP_TEXT` 里(反向不要求:HELP 里可以有说明性文字)。
- `scripts/cli-ratchet.guard.test.ts` 改成 §2 的两把尺。
- `bun run test` / `npm run test:node` / typecheck / depcheck 每个 commit 绿;`--help` 快照:第一个 commit 之前把 `bun cli.ts --help` 与每族 `--help` 的输出存成 `src/cli/__snapshots__/help.snap`(vitest `toMatchSnapshot`),搬完逐字节相同。

## 6. 交接

- 触碰文件:`cli.ts`、`src/cli/commands/*.ts`(新)、`src/cli/{help,output,flags,daemon-restart}.ts`(新)、`.dependency-cruiser.cjs`、`scripts/cli-ratchet.guard.test.ts`、`scripts/cli-smoke.guard.test.ts`(新)。不碰 `src/daemon`、`src/core`。
- Codex 阶段 D 若加新 CLI 命令:直接建 `src/cli/commands/<family>.ts` 并在 `SUBCOMMANDS` 登记一行;`cli.ts` 只多一行 import + 一行表项。
- 实施计划另出(writing-plans)。预计 20 个左右 commit,可以分两三个 PR 合(帮手下沉一个,大族一个,其余一个)。
