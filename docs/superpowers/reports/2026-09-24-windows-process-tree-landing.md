# Windows 进程树清理 · 落地 — 2026-09-24

> 上游:[`docs/superpowers/specs/2026-09-23-windows-process-tree-spike.md`](../specs/2026-09-23-windows-process-tree-spike.md)
> (spike 已在 win-test 真机跑完,结论「可行」)。本文是那份 spike 的落地,不重新论证可行性。
> 状态:**代码与测试已在 dev 上,真机验证未做**(验证步骤见文末,由主人在 win-test 上跑)。

## 一句话

Windows 没有进程组,所以产品里 13 处 `process.kill(-pid)` 在 win32 上退化成 `child.kill()`,
只杀直接子进程。修法不在杀的那一侧:被 spawn 的命令外面套一层 `cc-jobspawn`,它把**自己**
放进 `KILL_ON_JOB_CLOSE` 的 job,子孙自动继承成员身份 ⇒ **原有的 `child.kill()` 就够用,
13 处 kill 一行都没改**,只包了 spawn。

## 交付物

| 东西 | 位置 |
|---|---|
| Rust 源码(约 200 行,含注释;零外部 crate) | `scripts/jobspawn.rs` |
| TS 接缝 | `src/lib/jobspawn.ts` |
| 测试(28 条) | `src/lib/jobspawn.test.ts` |
| 构建 | `apps/desktop/scripts/build-sidecar.ts`(编成 `binaries/cc-jobspawn-<rustTriple>[.exe]`) |
| 打包 | `apps/desktop/src-tauri/tauri.conf.json` + `tauri.macos.conf.json` 的 `externalBin` |

产物体积:`rustc -O -C strip=symbols -C debuginfo=0` 在 aarch64-apple-darwin 上 **392 KB**
(spike 在 Windows 上量到 237 KB)。

## 对 spike 原型做的三处改动

1. **诊断全部移到 stderr**(裁决 2)。原型把 `jobspawn pid=...` 打在 stdout 上 —— ACP 与
   codex app-server 都靠 stdin/stdout 的 JSON-RPC,那一行就是往协议流里插脏东西。
   而且 pid 那行**只在 `WECHAT_CC_JOBSPAWN_DEBUG` 置位时才打**:stderr 会被上层收进产品
   的错误文案里(`stderrTail` / cli-reply 的回话),平时也得干净。失败诊断无条件打 stderr。
2. **POSIX 直通分支**(裁决 1)。非 Windows 上不做任何 job 相关的事,直接 `exec` 目标命令
   **替换掉自己**:同一个 pid、同一套 stdio、退出码与信号语义完全是目标命令自己的,进程树里
   不多一层。之所以要在 POSIX 上也构建:`externalBin` 一旦加了条目,当前 target 的文件必须
   存在,否则 mac / linux 的 `tauri build` 直接失败。**TS 侧仍然只在 win32 包。**
3. **job 设置失败不再退出,改成「大声 + 继续」。** 原型在 `CreateJobObjectW` /
   `SetInformationJobObject` / `AssignProcessToJobObject` 任一失败时退 3/4/5,命令根本不跑。
   按裁决 3 的同一条理由(「抛错会让整个功能不可用,比漏更糟」)改成往 stderr 写一行说清
   「进程树清理已退化,孙子进程可能残留;命令照常执行」,然后照常执行。

## 核实:哪些 spawn 点在 Windows 上真的会漏(D 的结论)

判定标准是**两条同时成立**:① 这条路在 win32 上真的会跑(被硬闸门挡掉的不算 —— 那是
「明确拒绝」,用户看得见);② 它有一条 kill 路径,在 win32 上只杀直接子进程。

### 包了(5 处)

| 文件 | 为什么真的会漏 |
|---|---|
| `src/core/agy-agent-provider.ts`(`defaultSpawnFn`) | **零处 win32 判断**,只 `proc.kill()`;agy 在 win32 上照常注册(`bootstrap/providers.ts` 那道 win32 门只挡 cursor 的 ACP 对话 provider)。漏得最彻底的一个。 |
| `src/cli/self-change/runner.ts`(`spawnCollect`) | `detached: platform !== 'win32'`,`killGroup` 的 else 分支只杀 `claude` 本身 ⇒ MCP 服务端与 Task 子代理留下继续烧预算。 |
| `src/daemon/cli-reply-handler.ts`(`defaultRunner`) | 同上形状(`posix` 闸)。还额外坏一层:孙子拖着管道,`'close'` 永远不来。 |
| `src/core/workbench/codex-config.ts`(`discoverWorkbenchCodexConfig`) | **新发现,不在候选清单里。** codex 工作台的硬闸门在 `codex-app-server.ts:129` 的 `provider.spawn()` 里,而 `modelCatalog`(`codex-app-server.ts:121` → `codex-model-catalog.ts:9` → 这里)**走在那道门之外**,而且 `wire-workbench.ts:150` 在 win32 上照样注册 codex 执行者。也就是说这条 `codex mcp list --json` 在 Windows 上真的会跑,`stop()` 的 else 分支只杀 codex 本身。 |
| `src/core/workbench/codex-model-catalog.ts`(`discoverCodexModels`) | 同上那条路的第二个进程(`codex app-server`)。 |

### 没包,和为什么

| 文件 | 理由 |
|---|---|
| `src/core/claude-workbench-process.ts:34` | 被 `claude-workbench-runtime.ts:36` 的硬闸门挡住(裁决 4:这一轮不动)。`ownClaudeWorkbenchProcess` 只有那一个调用点,核实过没有旁路。 |
| `src/core/workbench/codex-app-server.ts:137` | 被同文件 `:129` 的硬闸门挡住(裁决 4)。 |
| `src/core/acp-agent-provider.ts:135` | 被同文件 `:133` 的硬闸门挡住(裁决 4);`bootstrap/providers.ts:399` 还有第二道门(win32 不注册 cursor 的 ACP 对话 provider)。 |
| `src/core/workbench/codex-history-rpc.ts:24` | **第四道硬闸门**,spike 与候选清单都没提:文件第 20 行 `if(process.platform==='win32')throw new Error('native_history_unsupported')`。同裁决 4 的处置 —— 明确拒绝,不属于「照跑并静默漏」。 |
| `src/core/cursor-eval.ts:27` | `defaultCursorSpawnFn` 只被 `acp-cursor-chat.ts:57` 用,而 `providers.ts:399` 在 win32 上根本不注册那个 provider ⇒ win32 上到不了。 |
| `src/daemon/self-change-spawn.ts:113`(候选清单里的) | **核实结论:不该包。** 它是 `detached: true` + `stdio:'ignore'` + `unref()` 的 fire-and-forget,**全仓没有任何地方 kill 它**(它就是那个会把 daemon 自己停掉再拉起来的进程)。没有 kill 路径就没有「杀了但漏」这回事,包了只是白加一层进程。它里面真正会漏的那一层(`claude -p`)由上面 `self-change/runner.ts` 负责。 |
| `src/daemon/wiring/pipeline-deps.ts:467`(`updateSelf`,候选清单里的) | 同上:`detached` + `stdio:'ignore'` + `unref()`,没有 kill 点。 |
| `src/daemon/bootstrap/agy-version-check.ts:32` | 有 kill(5 s 超时),`agy --version` 卡住时确实可能留下孙子。**故意先不包**:这是决定 agy 注册与否的开机闸门,万一 jobspawn 在场但本身有毛病,后果是「provider 悄悄消失」,比上面那 5 处「某一轮报错」更难查。等真机验证过再补。 |
| `src/lib/codex-autofix.ts:197` | `bun add` 的 100 s 硬杀,可能漏 postinstall 的孙子。只在源码态 + codex SDK 版本不匹配时触发,Windows 打包安装根本没有仓库。同上,记在余项。 |
| `src/core/knowledge/embed-runner.ts:91` | 嵌入子进程,单进程一问一答,没有会开孙子的形状。 |
| `src/daemon/self-restart/git-head.ts` / `src/cli/update.ts` 等 | `git rev-parse` 一类,没有孙子。 |

**13 处 `process.kill(-pid)` 一行都没改。** 没有出现「必须改」的情况 —— 方案判断成立。

## 接缝长什么样

```ts
// src/lib/jobspawn.ts
wrapForProcessTree(command, args) → { command, args }
```

win32 上返回 `(cc-jobspawn 路径, [原命令, ...原参数])`,其他平台原样返回。找 `cc-jobspawn` 的顺序:

1. `WECHAT_CC_JOBSPAWN`(绝对路径;**显式指定却不存在就算找不到**,不偷偷回落 —— 否则真机
   验证时你以为在验 A,其实验的是装机自带的 B);
2. 和 `process.execPath` 并排的 `cc-jobspawn.exe`(Tauri 的 `externalBin` 会把
   `cc-jobspawn-<triple>.exe` 装成去掉 triple 的名字,同 `wechat-cc-cli` 的既有约定);
3. 并排的带 triple 名字(直接跑 `build-sidecar` 输出目录里的二进制时)。

找不到 ⇒ **降级 + `log('JOBSPAWN', …)` 喊一次**(stderr + `channel.log`),不抛错。那一行把后果
写在句子里:「进程树清理已退化,孙子进程(claude/codex/agy 自己开的 MCP 与子代理)在任务被
取消或超时之后可能残留在系统里;设 `WECHAT_CC_JOBSPAWN=<路径>` 可以指定它」。每个进程只喊
一次(喊一万遍等于没喊),解析结果也只算一次。

分层:接缝住 `src/lib/`,被 `core` / `cli` / `daemon` 三层共用,`depcheck` 的
`lib-must-not-depend-on-anything-internal` 过(它只 import `node:path` / `node:fs` / `./log`)。

**已知边界**:包装之后,裸命令名(`cli-reply-handler` 传的 `claude` / `codex`)由 Rust std 的
PATH 查找负责(PATH + 补 `.exe`),不再由 libuv 负责。这只在「命令是 `.cmd` / `.bat` 垫片」时
有差别,而那种形状**今天在 Windows 上本来就跑不起来**(Node 从 20.12 起拒绝不带 `shell:true`
的 `.cmd`),所以不是回归。真机验证时顺手看一眼 `where claude` 是不是 `.exe`。

## 测试(28 条,bun 与 node 两个 runner 都跑)

覆盖:非 win32 不包 / win32 包 / 环境变量覆盖生效 / 覆盖指的文件不存在时不回落 / 并排与带
triple 两种命名 / 找不到时降级**且留痕**(断言那一行日志,不是断言没抛错)/ 喊一次就够 /
解析只做一次 / 文案里有后果和补救 / 「stdout 只属于被包的命令」/ 零外部 crate 依赖 /
5 个 spawn 点确实包了 / `externalBin` 与 `build-sidecar` 真的会带上它。

平台相关的一律**注入** `platform`,不读跑测试的机器;Windows 路径的拼接用 `path.win32`
(第一版用了默认的 posix `join`,在 mac 上拼出 `C:\Program Files\wechat-cc/cc-jobspawn.exe`
这种四不像,3 条用例当场红 —— 这就是「只在 Mac 上绿」的同一个病的反面)。

「stdout 只属于被包的命令」钉了两层:① 静态 —— `scripts/jobspawn.rs` 的代码里不许出现
`print!` / `println!`(注释不算),任何平台、不要 rustc 都跑;② 真跑 —— 有 rustc 时现编一份,
包一个同时往 stdout 与 stderr 写东西的命令,核对 stdout 一个字节不多,**连开着
`WECHAT_CC_JOBSPAWN_DEBUG` 也不多**。POSIX 上 cc-jobspawn 是直通,所以第二层在 mac / linux
上测的是同一件事(只少了 job 那一段),不是只在某个平台有意义的断言。

### 逐条「真改实现 → 亲眼看红 → 改回来」

24 次变异,每一次都跑了一遍完整的 `src/lib/jobspawn.test.ts`,**没有一条是空转**:

| # | 改了什么 | 变红的用例 |
|---|---|---|
| M1 | 去掉 `platform !== 'win32'` 闸门(所有平台都包) | darwin / linux「不需要这层包装」2 条 |
| M2 | env 指定的文件不存在时偷偷回落到并排的 | 「不偷偷回落」 |
| M3 | 并排查找丢掉 `.exe` | 「打包版用并排的」+「missing 报出候选」 |
| M4 | 删掉带 triple 的候选 | 「带 triple 也认」+「missing 报出候选」 |
| M5 | `found` 分支不包(原样返回) | 「把命令塞进 cc-jobspawn 的参数里」 |
| M6 | `not-needed` 也喊 | 「其他平台不留痕」 |
| M7a | 找不到时抛错(不降级) | 「降级 + 留痕 + 不抛错」、「喊一次就够」 |
| M7b | 找不到时静默(删掉 `deps.log`) | 同上两条 ← **这一条是裁决 3 的钉子** |
| M8a | 删掉 `announced` 一次性闸 | 「喊一次就够」 |
| M8b | 每次都重新 resolve(不记住) | 「喊一次就够」(`resolves === 1`) |
| M9 | 降级文案里去掉后果那半句 | 「降级 + 留痕说清后果」 |
| R1 | 把 `println!("jobspawn pid=…")` 加回 main(**原型那个 bug**) | 静态 `println!` 守卫 + 真跑的 6 条(stdout 全被污染) |
| R2 | 退出码不透传(一律 0) | 「退出码原样透出」、「命令不存在退 6」 |
| R3 | 参数少传一个(`args[2..]`) | 「参数原样透传」等 5 条 |
| R4 | `stdin(Stdio::null())` | 「stdin 是透的」 |
| R5 | 没给命令时退 0 | 「用法写 stderr、退 2」 |
| R6 | 命令不存在时退 0 | 「命令不存在 ⇒ 退 6,不假装成功」 |
| R7 | 加一个 `use serde::Serialize`(cfg 到 windows,mac 上照样编得过) | 「零外部 crate 依赖」 |
| R8 | 候选清单为空时的兜底文案去掉 | 「一个候选都没有时也说得清」 |
| S1–S5 | 5 个 spawn 点分别摘掉 `wrapForProcessTree` | 对应那一条清单用例各自变红 |
| P1 | `tauri.conf.json` 的 `externalBin` 里删掉它 | 「externalBin 里有它」 |
| P2 | `tauri.macos.conf.json` 里删掉它 | 「macOS 覆盖也列了它」 |
| P4 | 产物名不带 target triple | 「按 target triple 命名」 |

**抓到一条自己写的空转用例**:第一版的「build-sidecar 真的会编它」只断言文件里出现过
`jobspawn.rs` 这几个字,于是把源文件名改成 `nope.rs` 它**照样绿**(抬头的注释里也有这几个
字)。改成断言真正那条命令(`join(root, 'scripts', 'jobspawn.rs')` 与
`'-o', jobspawnOutput, jobspawnSource`)之后,P3'(改错源文件名)与 P5(把 rustc 参数换成
`--version`)都变红。

## 收尾验证

| 检查 | 结果 |
|---|---|
| `bun run test` | 648 文件通过 / 1 跳过;**8660 通过 / 10 跳过,0 失败** |
| `npm run test:node` | 550 文件通过 / 2 跳过;**7357 通过 / 11 跳过,0 失败** |
| `bun run typecheck` | 通过 |
| `bun run depcheck` | **0 errors / 7 warnings**(基线一致,全是既有 no-circular) |
| `cd apps/desktop && bun run build-sidecar` | 通过,产出 `cc-jobspawn-aarch64-apple-darwin`(392 KB,ad-hoc 签名 `com.tendhearth.wechat-cc.jobspawn`) |

迁移:**零**(本任务不碰任何 schema)。

## 真机验证怎么跑(win-test,`10.84.6.198`,ssh 别名 `win-test`)

那台机上 `cargo` / `rustc 1.98.0` 有,**bun / node / git 都不在 PATH**,所以下面全部不需要它们。
`scripts\jobspawn.rs` 要先从这台 Mac 拷过去(`scp` 或走共享目录)。

### ① 编译(证明零依赖 + 单文件 rustc 就够)

```powershell
rustc -O -C strip=symbols -C debuginfo=0 --edition 2021 -o C:\cc\cc-jobspawn.exe C:\cc\jobspawn.rs
```

通过 = 退 0、`C:\cc\cc-jobspawn.exe` 在(约 240 KB),**编译过程没有任何网络访问**。

### ② 直通与 stdout 纯净(不需要 daemon)

```powershell
# 退出码透传 + stdout 只属于被包的命令
C:\cc\cc-jobspawn.exe powershell -NoProfile -Command "Write-Output PURE; [Console]::Error.Write('noise'); exit 42" 1> C:\cc\o.txt 2> C:\cc\e.txt
$LASTEXITCODE            # 通过 = 42
Get-Content C:\cc\o.txt  # 通过 = 只有 PURE
Get-Content C:\cc\e.txt  # 通过 = 有 noise

# 调试开关开着,pid 行也只进 stderr
$env:WECHAT_CC_JOBSPAWN_DEBUG=1
C:\cc\cc-jobspawn.exe powershell -NoProfile -Command "Write-Output PURE" 1> C:\cc\o2.txt 2> C:\cc\e2.txt
Get-Content C:\cc\o2.txt   # 通过 = 只有 PURE(**没有** cc-jobspawn: pid=)
Get-Content C:\cc\e2.txt   # 通过 = 有一行 cc-jobspawn: pid=<n> job=kill-on-close
Remove-Item Env:\WECHAT_CC_JOBSPAWN_DEBUG
```

### ③ 整棵树被收掉(这一条才是目的)

复用 spike 那套:起一个「会自己再开孙子、孙子把自己的 PID 写文件」的脚本(**别用 `# 标记`
塞命令行做进程识别 —— `#` 会注释掉整行剩余部分,进程瞬间退出,看起来像基线不成立**;
中文 `.ps1` 必须存 UTF-8 BOM,PS 5.1 按 ANSI 读;`ProcessStartInfo.ArgumentList` 在
.NET Framework 上不存在,只有 `.Arguments`,嵌套引号很容易吃掉参数 —— 内层脚本落成文件用
`-File` 调最省事)。

```powershell
# 基线(不经 jobspawn):杀掉直接子进程,孙子仍在 → 这就是今天的病
# 经 jobspawn:同一棵树,只杀 jobspawn 那一个
Stop-Process -Id <jobspawn 的 pid>
Get-Process -Id <孙子的 pid> -ErrorAction SilentlyContinue   # 通过 = 什么都没有
```

通过 = 孙子进程**没了**(基线那一遍它活着,并且 `孙子的 ParentProcessId == 中间进程 PID`)。

### ④ 产品里真的用上了(要装一份带 jobspawn 的包,或用环境变量指)

最省事的路子是**不重打包、直接用环境变量**:

```powershell
# 必须在启动 daemon 之前设 —— 接缝在模块加载时就把 env 定下来了
[Environment]::SetEnvironmentVariable('WECHAT_CC_JOBSPAWN','C:\cc\cc-jobspawn.exe','User')
# 重启 daemon,然后在微信里对 agy 发一轮、或跑一次「自改」,再看
Select-String -Path "$env:USERPROFILE\.claude\channels\wechat\channel.log" -Pattern 'JOBSPAWN'
```

- 通过 = **`channel.log` 里一条 `[JOBSPAWN]` 都没有**(找到了就不喊),而且
  `Get-Process | Where-Object { $_.ProcessName -eq 'cc-jobspawn' }` 在一轮进行中能看见它、
  这一轮结束后看不见。
- 反面也要验一次(裁决 3 的降级路径):把变量指到一个不存在的路径、重启 daemon、发一轮,
  `channel.log` 里应当出现**恰好一条** `[JOBSPAWN] cc-jobspawn 找不到(找过:…)—— 进程树清理
  已退化…`,而且那一轮**照常跑完**(不是报错)。
- 顺手确认一句:`where claude` / `where codex` 指的是 `.exe` 而不是 `.cmd`(见上面「已知边界」)。

### ⑤ 打包路径(要不要现在验,你定)

`bun run tauri build` 会走 `beforeBuildCommand` ⇒ `build-sidecar` ⇒ 编 jobspawn ⇒
`externalBin` 把它装成 app 主二进制并排的 `cc-jobspawn.exe`。这条只有在 Windows 上真打一次
包才算验过;CI 的 Windows 作业会替我们编,但「装进 NSIS / MSI 之后名字对不对」要装一次看。

## Concerns / 余项

1. **真机零验证。** 上面 ①②③ 是 spike 已经在同一台机上跑过的形状(只是换成了落地版二进制),
   ④ 是新的 —— 产品里真的走到那一层、以及降级留痕这两件事,只在单测里成立过。
2. **三处硬闸门照裁决 4 没动。** 这个原语把它们的**理由**(进程树清理未验证)去掉了,但拆不拆
   是产品决定,而且拆了之后工作台在 Windows 上还缺什么没人查过。`codex-history-rpc.ts:20` 是
   第四道,spike 漏记了,一起留着。
3. **codex 模型目录那条路是本轮新发现的漏点**,不在 spike 的表里也不在候选清单里。它意味着
   「工作台在 Windows 上被硬闸门挡住」这句话不完整:`modelCatalog` 是从门外过去的。值得顺手
   想一想还有没有别的「闸门在 spawn 里,但同一个 provider 的其他方法不过那道门」的形状。
4. **两个故意先不包的点**:`agy-version-check.ts`(开机闸门,失败形态是 provider 悄悄消失,
   比报错难查)、`codex-autofix.ts`(`bun add` 的 postinstall 孙子,只在源码态触发)。
   等 ④ 在真机上过了再补,补的时候只是各加一行。
5. **裸命令名的 PATH 解析换了引擎**(libuv → Rust std)。判断是「不是回归」(理由见上),
   但这是一条只能在真机上最终确认的推理。
6. **jobspawn 自己成为孤儿的那条缺口没变**:daemon 被杀时 jobspawn 变孤儿,树跟着它继续活。
   POSIX 今天也一样(杀 daemon 不会杀进程组),所以不是回归,是同一条既有缺口。

---

## 真机验证结果(2026-09-24,控制器在 win-test `030-SJWJ-GSR-B` / Win10 企业版 LTSC 上跑)

**用仓库里的 `scripts/jobspawn.rs` 重新编译验证的**,不是复用 spike 那个二进制 —— 两者之间隔着
stdout→stderr 与 POSIX 直通两处修改,不重编等于没验落地的那一份。

| 步骤 | 结果 |
|---|---|
| ① `rustc -O -C strip=symbols -C debuginfo=0 --edition 2021` | **通过**,产物 228 KB,无网络、零 crate |
| ② 退出码穿透 | **通过**,`exit 42` → `$LASTEXITCODE = 42` |
| ② stdout 纯净 | **通过**。默认与 `WECHAT_CC_JOBSPAWN_DEBUG=1` 两种情况下 stdout 都**只有** `PURE`;`cc-jobspawn: pid=… job=kill-on-close` 只出现在 stderr。裁决 2 要求修掉的协议流污染,真机确认已修。 |
| ③ 整棵树(**基线对照**) | **通过**。同一棵树:不套 jobspawn ⇒ 杀掉直接子进程后孙子**活着**;套上 jobspawn ⇒ 中间层与孙子**一起没了**。两边都跑了,单看一边证明不了什么。 |
| ④ PATH 解析 | **验不了,不是通过也不是失败** —— 见下。 |

### 验不了的那两条(诚实记账)

这台机上 `claude` / `codex` / `cursor-agent` / `agy` / `bun` / `node` / `git` **全都不在 PATH**
(它的用途是验 Win 包,不从源码构建)。于是:

- **PATH 解析换引擎那条风险(libuv → Rust std)在这台机上没有可解析的对象**,无法验证。
  它要在一台**装了那些 CLI 的** Windows 上验:`where claude` / `where codex` 必须是 `.exe`
  而不是 `.cmd`(实现者的判断是"不算回归,因为 Node 20.12+ 本来就拒绝不带 `shell:true` 的 `.cmd`",
  但这条判断**还没有真机证据**)。
- **实现者报告里的第 4 步(产品真的走到那一层 + 降级留痕)也跑不了**:没有 bun、没有 CLI,
  起不了 daemon。那一步目前**只在单测里成立过**。要么给这台机装 bun + 至少一个 CLI,
  要么在装了 app 的 Windows 机器上验。

### 落地状态判定

原语本身(编译、直通、退出码、stdout 纯净、整棵树被收)**在真 Windows 上全部验过**。
没验的是**产品是否真的接上了这条路**,以及裸命令名的 PATH 解析。
所以这一轮可以认为"能力具备且可信",但**不能认为"Windows 上的静默泄漏已经消除"** ——
后者要等第 4 步。

验证用的临时文件与目录已从 win-test 上删净,未留游荡进程。

## 打包接线与 POSIX 直通(2026-09-24,macOS 上验)

win-test 在这一轮中途掉线(ping 100% 丢包),装 bun 那条走不下去;先把**不需要 Windows**
的两项验掉。

**打包接线 —— 通过。** 在 macOS 上跑 `bun run build-sidecar`:

- 产出 `apps/desktop/src-tauri/binaries/cc-jobspawn-aarch64-apple-darwin`(392 KB),
  与 CLI sidecar 同一套 target 表、同一步 ad-hoc 签名。
- `tauri.conf.json` 与 `tauri.macos.conf.json` 的 `externalBin` 都已含 `binaries/cc-jobspawn`。
- 构建产物不污染工作区(`binaries/` 是 gitignore 的)。
- 这坐实了裁决 1 的必要性与可行性:**所有平台都编**,mac 上 `externalBin` 拿得到文件,
  不需要按平台改配置。

**POSIX 直通 —— 通过,而且是真 exec、零额外进程。**

| 检查 | 结果 |
|---|---|
| 退出码 | `exit 42` → `42` |
| stdout 纯净 | 默认与 `WECHAT_CC_JOBSPAWN_DEBUG=1` 下 stdout 都只有 `PURE`,stderr 为空 |
| 是否多套一层进程 | **不是**。被包命令的父进程直接是调用方 shell(`/bin/zsh`),说明 cc-jobspawn 已 `exec` 掉自己 —— POSIX 上不残留中间进程 |
| stdin 透传 | `{"id":1}` → `{"echoed":{"id":1}}` |

### 仍然没验的(与上一节一致,原因也一样)

- **产品真的走到这一层 + 降级留痕**:需要 win-test 上有 bun 与至少一个 CLI。机器掉线,未做。
- **PATH 解析换引擎(libuv → Rust std)**:同上,且那台机上本来就没有 claude/codex 可解析。
- **Windows 包真的带上了 `cc-jobspawn.exe`**:mac 侧接线已验,Windows 侧要打一次包才算。

