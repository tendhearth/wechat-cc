# 怎么加一个微信命令

微信里主人(或访客)发一句话,先过一张**命令表**;没被任何一行认领的,才交给模型当普通聊天。这一页说新加一条命令放哪、怎么写、漏了谁会红。2026-10-22 第三批 3d 收完以后,所有命令都是「一行一条」。

## 一张表,顺序就是优先级

`src/daemon/commands/registry.ts` 的 `makeCommandRegistry`:每行 `{ id, group?, probe, handle, ownsSlash?, slashCatchAll? }`。入站流水线只有一站(`inbound/mw-command.ts`)查这张表:**按表的顺序**问每行 `probe`(只读、不许有副作用,抛错当作不认领),第一个认领并且 `handle` 返回 true 的就是它。

表在 `src/daemon/wiring/pipeline-deps.ts`,现在的顺序(读 `registry.ids` 就是真实顺序):

1. `task`(工作台「任务 …」)
2. `admin.*`(管理员命令,`admin-commands.ts` 的 `commands()`)
3. `mode.*`(斜杠命令,`mode-commands.ts` 的 `commands()`;最后一行 `mode.unknown` 是 **/词兜底**:「不认识 /xx」)
4. `onboarding` → `permission-reply` → 文本命令(定时 / 日历 / 做过的事 / 经验 / 导入记忆 / 终端,`opts.commands`)
5. `control.*`(串门 / 回信 / 配对 / 派 / 认识 / 访客,`wiring/command-router.ts` 的 `makeControlCommands`)

**唯一的整理规则**:一行声明 `ownsSlash`(「这几个 /词 归我」),建表时会给它多生成一行 `<id>:slash`,排在兜底之前。所以排在兜底**后面**的命令也能有自己的 /词(`/cli`、`/today`、`/visit`),不会被说成「不认识」。

## 放哪一族

| 你要加的是 | 放哪 | 写法 |
|---|---|---|
| 只有主人能用的管理操作(看状态、重置、维护) | `src/daemon/admin-commands.ts` 的 `ADMIN_ROWS` | `{ id, explicit?, match(text, ctx), run(deps, msg, m), background? }`;慢的(模型调用、派给别的机器)标 `background`,`run` 里自己持 `holdBusy` 的令牌 |
| 斜杠开关(切执行者、`/set`、`/help` 这一类) | `src/daemon/mode-commands.ts` 的 `slashRows` | `{ id, words, match(slashWord, tail), run(...) }`;`words` 会自动进「认得的 /词」,**`/help` 必须提到它**(有测试) |
| 社交 / 跨机器的控制命令 | `src/daemon/wiring/command-router.ts` 的 `makeControlCommands` | 用里面的 `row(name, probe, handle, extra)`;有 /词 就给 `ownsSlash` |
| 其余的中文说法命令(「定时 …」「日历」这一类) | 各自的处理器,经 `opts.commands` 接进来 | 老形状 `(text, chatId)` 的处理器用 `fromReplyHandler` 包一层 |

拿不准的时候:**谁能用**决定放哪。只给主人的放 admin(非主人发显式写法会被回「这条只有主人能用。」,日常说法不认领、进对话);访客也能用的(串门、回信)放 control。

## 每一族里:行与行两两互斥

admin、mode、control 三族各有一条测试:按一份语料逐句核,**任何一句话最多一行认领**。所以族内的先后不影响谁认领 —— 以后有人调了表的顺序,也不会悄悄改行为。两行会撞的时候,别靠「排在前面」消歧,让一行自己把另一行的情况排除掉(比如 `selfchange.start` 自己排除「自改 状态」)。

族与族之间靠表的顺序。新命令的说法如果可能被前面的族认走(尤其是 /词 和兜底),先看下面那份快照。

## 回话走哪道门

命令的回复是**回答主人刚发来的那一句**,走各处理器拿到的 `sendMessage` / `sendAssistantText`,不经 SpeechPolicy(那道门管的是 CC 主动开口)。别在命令里起定时、别在命令里主动推第二条消息 —— 那是主动开口,要走 `speech.say` / `tell`(见 `docs/superpowers/specs/2026-10-21-speech-policy-design.md`)。`scripts/speech-send.guard.test.ts` 按文件数发送调用的次数,新文件里直接调发送会红。

## 证明

```bash
bun --bun vitest run src/daemon/commands src/daemon/admin-commands src/daemon/mode-commands src/daemon/wiring/command-router src/daemon/inbound/command-baseline
bun run test:e2e      # 路由快照:语料里每一句在三档(主人 / trusted / 访客)下最后落到哪一行
```

**路由快照**(`src/daemon/__e2e__/command-routing.e2e.test.ts`)记的是「每一句话最后落到哪」。改命令必跑(只要几十秒)。它红了,**别直接 `-u`**:逐行看变的是哪几档、哪几句,每一句都要讲得出为什么该变。这份快照抓到过两次真回归 —— 一次是「同意 07」被社交命令截走(它其实是权限卡的放行词),一次是社交关着时 `/visit` 被兜底说成「不认识」。

另有一份基线快照 `src/daemon/inbound/command-baseline.test.ts`(probe / handle 对整份语料的结果)。

## 漏了哪一处,谁会告诉你

| 漏了 | 红的是 |
|---|---|
| 两行认领同一句 | 那一族的「最多一行认领」测试 |
| id 重复 | `makeCommandRegistry` 建表时直接抛 |
| 新 /词 没写进 `/help` | `mode-commands.test.ts`(主人的 /help 必须提到每个词) |
| 新 /词 排在兜底后面又没 `ownsSlash` | 路由快照:那一句变成「不认识」 |
| 改了别的命令的落点 | 路由快照 / 基线快照 |
| 命令里主动开口 | `speech-send` 守卫 |
| 管理员识别面手写了一份 | 不会再有:`isAdminCommandText` / `isExplicitAdminCommand` 都从 `ADMIN_ROWS` 推出来 |

为什么是这个形状:VS Code 的扩展把命令**声明**在一处、宿主从声明生成菜单和快捷键;我们照的是同一件事 —— 一行一条、顺序和冲突由表和测试说了算,不靠人记(架构复查 2026-10-21 理念 1)。
