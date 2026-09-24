# Windows 进程树清理 · spike 边界与验收

> 2026-09-23 · 状态:**待批准,未开工**。这是一份 spike 的边界,不是设计文档,也不是实施计划。
> 起因:主人问"要不要用 Rust 重写"。结论是不重写(理由见文末「为什么不是重写」),
> 但查下来 Windows 上确实有一处 **Node/Bun 结构上做不到**的事,值得一个窄口 spike。

## 要回答的问题(一句话)

**能不能用一个很小的原生原语(Windows Job Object),把现在 12 处 `process.kill(-pid)` 在
win32 上的退化路径一次性补掉,让"杀掉整棵进程树"在 Windows 上和 POSIX 上一样可靠?**

spike 的产出是**这个问题的答案 + 一个可丢弃的原型**,不是可发布的功能。

## 为什么值得做(现状,已核实 2026-09-23)

POSIX 上产品靠 `detached: true` + `process.kill(-pid, sig)` 杀**进程组**。这一步是必须的,
不是优化:`self-change/runner.ts:196` 的注释写着原因 —— `claude -p` 会自己再开子进程,
只杀直接子进程留下的孙子会继续跑、继续烧额度、继续写文件。

Windows 没有进程组这个东西,于是这 12 处全部退化成 `child.kill()`(只杀直接子进程):

| 地方 | win32 上的现状 |
|---|---|
| `src/core/claude-workbench-runtime.ts:36` | 硬闸门抛 `claude_workbench_process_groups_unsupported` |
| `src/core/workbench/codex-app-server.ts:129` | 硬闸门抛「Codex 工作台暂不支持 Windows:尚未验证任务进程树清理」 |
| `src/core/acp-agent-provider.ts:231,236` | 有 win32 分支 |
| `src/core/agy-agent-provider.ts` | **零处 win32 判断**,只 `proc.kill()` ⇒ 照跑并漏掉进程树 |
| `src/cli/self-change/runner.ts:227` | `platform !== 'win32'` ⇒ 自改流水线在 Windows 上漏进程树 |
| `src/daemon/cli-reply-handler.ts:31,39` | 同上(`posix` 闸) |
| `codex-model-catalog.ts:25`、`codex-config.ts:82`、`codex-history-rpc.ts:33,37` | 同上 |

两类后果,**第二类才是真问题**:

1. **诚实的缺口**:claude / codex 工作台在 Windows 上明确拒绝启动。用户看得见,知道自己没有这个功能。
2. **静默泄漏**:agy、自改流水线、CLI 回话在 Windows 上照跑,然后把孙子进程留在那儿。
   没有任何日志说这件事发生了。这正是本仓库反复栽的那一类(出了错但没人告诉你)。

**Node / Bun 都没有这个能力。** 正确机制是 Windows 的 Job Object
(`CreateJobObject` + `AssignProcessToJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
或 `TerminateJobObject`)。shell 替代方案 `taskkill /T /F` **不够**:它按父 PID 走树,
中间进程先退出树就断了,而且 PID 可被复用 —— 拿它当"可靠"会制造一个更难查的假象。

仓库里已经有一个 Rust 工程(`apps/desktop/src-tauri`,1582 行),所以这不是"引入一门新语言"。

## 范围内 / 范围外

**范围内**

- 一个最小原生原语:把子进程放进一个 job,并能"杀掉这个 job 里的一切"。
- 回答它**住在哪**:① 现有 Tauri 二进制里(daemon 已是 app 主二进制 `--daemon`);
  ② 一个独立的小 sidecar,TS 侧 spawn 它、由它再 spawn 真正的命令;③ 别的。
  这一条是 spike 要**查清而不是假设**的核心未知。
- 回答 TS 侧的接缝长什么样:能不能收敛成**一个**函数(现有 runtime 适配层已有
  process 那一格),还是 12 处各自要改。
- 在**真 Windows** 上验证一次:起一个会自己开孙子进程的命令,杀掉,确认孙子也没了。

**范围外(明确不做)**

- 不重写任何现有 TS 逻辑。不碰编排、协议适配、产品语义。
- 不动 Bun → Node 那件事(09-16 已定案:Bun 是可替换引擎,与本 spike 无关)。
- 不顺手解 Windows 上别的问题(EBUSY、`bun:sqlite` 句柄 —— 那是另一张单子,见文末)。
- 不做发布、不进 CI、不写迁移。原型代码默认**丢弃**。

## 验收条件(可判真假,不是"看起来好了")

1. **真机复现基线**:在 `win-test` 上,不改代码的情况下,跑一个已知会漏的路径
   (最简单是 `cli-reply-handler` 或自改 runner 的形状),用 `Get-Process` 证明
   **孙子进程在 kill 之后仍然活着**。没有这一步就不算开始 —— 现状必须先被看见。
2. **原型达标**:同一个场景,经过原语之后,kill 之后孙子进程**没了**;进程退出码与
   既有行为一致;不需要 `taskkill`。
3. **接缝可收敛**:能写出一段不超过 20 行的 TS 侧签名,让那 12 处都能调它。
   如果做不到(必须逐处特化),这一条记为**失败**并说明为什么。
4. **诚实边界**:说清这个原语**不**解决什么(比如已经泄漏在系统里的旧进程、
   跨会话的孤儿、用户手动起的进程)。
5. **代价数字**:原型的行数、它给桌面包增加的体积、以及它把哪几处硬闸门
   变成可以拆掉的(拆不拆是后续决定,不在 spike 内)。

## 什么情况下放弃(kill criteria)

任一条命中就停下来汇报,不要往前推:

- Job Object 在我们的 spawn 形状下拿不到孙子(比如中间进程自己 `CREATE_BREAKAWAY_FROM_JOB`)。
- 住处三个选项都有硬伤(例如独立 sidecar 会引入新的信任边界或签名问题)。
- 原型需要动 12 处以上的现有代码才能验证 —— 那说明它不是一个原语,scope 判断错了。
- `win-test` 连不上超过一天(2026-09-23 当天 ssh 就是不通的)⇒ **这个 spike 不能靠 CI 日志推断**,
  必须真机。连不上就挂起,别用 GitHub Windows runner 代替(runner 上没法观察进程树,
  而且 09-23 已经吃过一次 runner 整体停摆 40 秒的教训)。

## 为什么不是重写

- 规模:生产 TS/JS 约 **12.3 万行**,测试 **11.7 万行**(2026-09-23 实测),Rust 现有 1582 行。
  测试里相当一部分是真机事故换来的,重写要重新挣一遍。
- 瓶颈不在语言:daemon 大部分时间在等外部进程、等微信、等模型。8600 条测试本机 14 秒。
- 价值在适配层,而上游都是 TS:MCP SDK、AI SDK、ACP、桌面的 JS、手机页的内联 JS。
- 这条分支七个修复轮实际栽的地方(夹具过时、静默 catch、空转测试、裁决写错、
  静音字段没人读)**换语言一个都治不了**。
- 便宜的那 80% 已经买过:09-16 的可移植性定案把 Bun 降成可替换引擎 + runtime 适配层。

真正的分工已经在那了:**需要 OS 级正确性与单二进制信任的用 Rust(Tauri 外壳、token、
wxvault 桥),编排用 TS**。本 spike 只是问"这条线要不要往前挪一格"。

## 相邻但不在本 spike 内的两张单子

- **EBUSY / `bun:sqlite` 句柄**:`db.close()` 之后 Windows 上目录仍锁着,
  最可能是缓存的 prepared statement 没 finalize。验证步骤:在 win-test 上试 `db.close(true)`。
  与本 spike 同样需要真机,可以同一趟做,但**判定分开**。
- **`removeTempDir` 的 2 秒同步税**:每次 teardown 最多 21 次 rmSync + 20×100ms
  `Atomics.wait`,CI 上几乎总以放弃收场(一次运行 333 条警告)。收敛重试总时长之前
  需要在真机量一次"重试成功 vs 重试到底失败"的比例。
