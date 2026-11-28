# 部署(macOS / launchd)

**合并队列三平台绿 = 合入门 = 部署门**(2026-11-27 起)。进 `dev` 的 PR 只跑 Linux(快速反馈,不要求先跟 dev 同步);`ci land` 把它排进 GitHub 合并队列,队列把「dev + 排在前面的 + 这一个」拼成一个提交,在 `merge_group` 上跑三平台和全套作业,绿了才快进进 `dev`,红了踢出来。唯一的必过检查是汇总作业 `ci · gate`。`dev` 推送先比对 `git rev-parse HEAD^{tree}` 与已成功的队列(或三平台 PR)CI 的 tree 回执;完全相同才复用,轻量作业会写明 PR run URL。回执缺失/过期、API 不可用、旧版两平台运行、tree 不同(例如分支落后 dev)都走原有完整 CI;`master` 一律照旧全跑。纯 Markdown 的路径跳过规则保留。

部署前不再本机 `verify --full`,除非部署的 tree 没被 CI 跑过;这时先补验证,重型测试放专用 Mac mini。部署后主动跑 `selftest phone`、`selftest chat`、`selftest workbench` 和本次新增路由的闭环。4h soak 后台跑,只有改开机/关机/重启顺序才等待它,并用 `--min-restarts 1`。

只讲 macOS。Windows / Linux 没有 `self deploy`,那边照旧手工装包。

## 正常流程

```bash
cd apps/desktop && bun run build-sidecar && cd -
wechat-cc self deploy            # 缺省:自动挑本机架构的二进制、失败自动回滚
wechat-cc self deploy --json     # 机器可读
```

> 1.7.5 起 macOS 的包叫 `Tendhearth CC.app`,主二进制 `Tendhearth CC`,sidecar `tendhearth-cc-cli`;老安装 / 回滚后还是 `wechat-cc.app` / `wechat_cc_desktop` / `wechat-cc-cli`。下文的 `<sidecar>` 指包里实际那个名字,`self deploy` 自己会挑。改名迁移见 [app-rename-migration.md](app-rename-migration.md)。

可用开关(spec §3):`--binary <path>`(源码模式缺省 `apps/desktop/src-tauri/binaries/tendhearth-cc-cli-<arch>-apple-darwin`,老 checkout 回落 `wechat-cc-cli-…`,`arm64→aarch64`、`x64→x86_64`;**打包版里必填**)、`--app <path>`(缺省从 LaunchAgent plist 的 `ProgramArguments[0]` 推;它指的文件已经不在 ⇒ `launchagent_stale`,先打开一次 app 或跑 `<sidecar> service repair`)、`--no-rollback`、`--no-sign`(见下「签名」)、`--allow-unsigned`、`--allow-missing-plugins`(插件门红了也放行,记 detail + 日志;给本来就没插件的机器,不必永久 `plugin disable`)、`--health-timeout-ms N`(缺省 60000)、`--wait-tasks`、`--force`(见下)、`--json`。

### 在跑的交办任务（2026-11-09）

`self deploy` 改文件之前、`self ship` 构建之前都会查询交办任务；构建后进入底层部署时再检查一次。使用 operator token 读取完整分页，列出仍在工作的任务 id、标题与阶段。已答复且没有后台工作或待决问题的保留会话，是可中断点，不阻挡部署。

- 交互运行：有任务在跑时选择「等它们到可中断点 / 强制继续」，回车默认等待。每轮最多等 20 分钟，到点再问；输入 `force` 强制继续，输入「取消」或 `q` 结束部署。
- 非交互运行：有任务在跑时必须明确加 `--wait-tasks` 或 `--force`。前者最多等 20 分钟，超时非零退出，任务仍继续运行；后者列出任务后继续。两个选项互斥。
- 读不到任务状态会拒绝部署；修复未运行的 daemon 时可明确用 `--force`。从 `<sidecar>.prev` 回滚始终保留救援通道，不被任务等待阻挡。

这道门不关闭任务，也不封住新任务入口。若检查后又来了任务或选择强制部署，部署的优雅关停会把被打断的原运行身份写进状态目录的 `workbench-restart-continuations.json`，任务错误记为 `daemon_restarted`。关停开始仅保存准备记录；只有旧写者 `close()` 确认成功（或该轮明确从未调用 spawn）才升级为可续接。关停中崩溃、第二次停止信号或缺证明的旧格式记录，都进入「执行程序没确认退出」的主人确认流程；本轮已知进程组供现有退出守望核对，空组清除上轮残留证据。新 daemon 仅消费已确认记录一次，沿原生会话发一轮「CC 重启打断了上一轮。先检查停在哪里，再接着完成原任务。」；请求 id 由原运行身份生成，重复投递不会开第二轮。

主人已经停止（包括关停等待 close 时停止）、归档、有新输入或新运行的任务不会被旧凭据唤醒。续接绑定原目录的设备/inode 身份，路径被替换时不派发。执行程序尚未确认退出、或重启时仍有待批准/待回答事项时不自动续接；原生会话无法恢复也不擅自新开，时间线说明需要确认后继续。明确仍在排队、从未开始执行的首请求保留原要求和材料重新派发，不使用历史重开令牌。执行者开机探测尚未成功时，凭据留盘，等它登记后再试一次。

只有有新鲜部署重启标记的关停会留下续接凭据，普通关机/取消及无凭据的开机对账仍不重跑。已经运行着旧版本 daemon 的首次升级，没有这份关停凭据时无法补造自动续接。

它按顺序做六件事(钥匙串里有 Developer ID 时再多两步,见「签名」):

1. **preflight** —— 新二进制存在、可执行、`--version` 退出 0(5s 上限)。不过就一个文件都不动。
2. **stage** —— `copyFile(new, <sidecar>.new)` + `chmod 755`。**在 backup 之前**,理由见下面「回滚别把备份吃了」。
3. **backup** —— `<sidecar>` → `<sidecar>.prev`。两种情况**故意不覆盖** `.prev`(都算这一步成功):
   - 这次装的就是 `.prev` 自己(`--binary <sidecar>.prev`);
   - 当前 sidecar 自己 `--version` 都过不了(崩溃循环 / 被 SIGKILL)—— 拿一个坏的去盖掉最后一个好的备份,等于把唯一的退路删了。这时步骤详情写 `kept previous backup: current sidecar is broken`。
4. **swap** —— `rename(<sidecar>.new → sidecar)`。**必须换 inode**,见下。
5. **restart** —— `launchctl kickstart -k gui/$(id -u)/com.wechat-cc.daemon`。
6. **health** —— 等 `~/.claude/channels/wechat/internal-api-info.json` 的 mtime 晚于 kickstart 时刻,再用 **file token** `GET /v1/health` 拿 200。`version.cli` 跟 preflight 那个版本串**对不上只记一条 detail 警告,不判失败**(daemon 报的构建元信息跟 sidecar 的 `--version` 串本来就可能不同形)。回滚那一次的健康门比对的是**旧版本**(backup 那步顺手探到的 `<sidecar> --version`),所以回滚成功不会冒出一条假的 version mismatch。

另外两步(2026-09-30,见下「内置插件」):重启之前 **plugins_source**(登记插件来源,永不致命);健康 200 之后 **plugins**(daemon 报了 `health.plugins` 才有这一步:先等它从 `null` 变成对象;「该在的」= 登记来源时记下的插件名 ∪ `plugins.json` 明确开着的 − 明确关掉的,其中有没被发现的,或登记的来源里已经一个插件都没有 ⇒ 红,走回滚;`--allow-missing-plugins` 放行)。

健康门不过 ⇒ 自动回滚(同样 copy+rename 换 inode)+ 再 kickstart + 再等健康;无论回滚成不成,都会打印 `launchctl print` 里的 `last exit reason` / `runs` 和 `launchd.err.log` 尾 40 行。退出码:成功 0,失败(已回滚)1,回滚也失败 3,平台不对 2。

## 一条命令走完:`wechat-cc self ship`(2026-10-23)

整合者合完一批以后用它,不再手敲「构建 → 部署 → 两条自检」四步。顺序就是该检查的顺序,**什么都还没动的时候**先问能不能动:

0. **装的是哪棵树**:工作区有未提交的改动 ⇒ 不装,退 6(没有开关能放行);HEAD 不是 `origin/dev`(先 fetch)⇒ 退 6,真要试一条分支加 `--allow-off-dev`,会照实打出 HEAD 和 origin/dev。不查的话 soak 会把一条功能分支的版本当 dev 报。在整合者自己那棵 detached、站在 origin/dev 上的树里跑。
1. **负载**:1 分钟负载 / 核数 > 1.0(`--max-load` 改)⇒ 不动,退 3。`--wait-min N` 每分钟再看一次,最多等 N 分钟。满载下自检超时会被当成真红、白白回滚(2026-10-22 主人玩游戏 + Xcode,load 328)。它看的是「机器给不给得出公正的判决」,不是「主人在不在」。
2. **网络守护**:读不到、或开着但不安全 ⇒ 不动,退 5。自检要调模型,直连会封号;部署完才发现跑不了自检,只能回滚。
3. **交办任务**：按上述等待规则处理，没到可中断点或状态未知 ⇒ 构建前退 3。随后**构建 sidecar**(`--skip-build` 跳过)⇒ 红退 4。
4. **`self deploy`**(上面六步,它自己红了自己回滚)⇒ 红退 1。
5. **自检**:工作台 + 对话,跟自改同一套,执行者 / 供应商取 agent-config 的 `self_change.selftest_executor` / `selftest_provider`(缺省 claude)。红 ⇒ 回滚到 `.prev`,退 2。
6. 绿 ⇒ 退 0,提示过几个小时看 `self soak`。

自改流水线的 deploy 步过的是同一道门:机器忙最多等一个小时,还忙就 `machine_busy`;守护不安全就 `network_unprotected`。两种都停在 deploy、不推 `fail_streak`,`--resume` 接着来。

## 合完自动部署

维护用 macOS 可以在 `dev` 的 CI 通过后自动部署，默认关闭。在源码工作区运行 `wechat-cc self autoship --enable` 会记下仓库地址。打包版也可从 `self_change.repo_url` 或已有中枢仓库查到地址。自动轮需要 `git`、`gh`、`bun` 和 `rustc`，以及访问仓库和 GitHub Actions 的权限。

- `wechat-cc self autoship --disable` 关闭自动部署，已启动的轮次会在备份与换盘前的最终复核中重读开关。
- `wechat-cc self autoship --status` 显示上次有效结论、当前跳过原因、暂停原因、未完成事务与停机状态。窗外另显示下次窗口。
- 独立配置文件为 `$STATE_DIR/self-change/autoship-config.json`，由 CLI 原子写入，权限为 0600。`auto_ship_interval_min` 缺省 20 分钟，最短 5 分钟。时间窗缺省为本地时间 01:00–07:00，含起点、不含终点；窗外但这台电脑已经 `auto_ship_idle_min`（缺省 30、最少 5）分钟没人碰过键鼠，也放行，探不到空闲时长按「有人」算。加这一条是因为 Mac 夜里多半睡着，睡着时 daemon 的定时器不走，只认夜间窗几乎装不上（2026-11-28 实测：03:03 装完一次后，到 04:29 一轮都没起）。用 `"auto_ship_window": {"start": "22:30", "end": "04:15"}` 可配置跨午夜窗口。手动 `self ship` 全天可用。daemon 每分钟重读配置。上一个 detached CLI 活着时，定时器继续等它退出。`wechat-cc self autoship` 的部署轮由 daemon 拉起，终端可直接运行带管理选项的命令。

每轮只尝试拿一次自改的中枢互斥锁，再尝试部署锁。遇到活跃的自改锁、残留的锁或接管标记，只跳过并在 `--status` 记录原因。准备失败也会暂停并通知一次，例如中枢 `origin` 与配置不符、建不了工作树或工作树有改动。修复后用 `--unhalt` 恢复。短暂 fetch 失败留给下一轮重试。

只有发起轮次的打包 daemon 与已加载的日用 LaunchAgent 匹配时才继续。CLI 通过本地 API 验证 PID、启动时间、状态目录和 sidecar 路径，再核对 LaunchAgent 的启动程序和当前 PID。源码和独立实例的跳过原因记在状态里。

自动轮 fetch `origin/dev` 后，要求已装 sidecar 的提交能确认为它的祖先。已是顶端、tree 相同或只有 Markdown 差异时结束。候选 SHA 必须有已绿的 dev 推送轮，包含 CI 明确复用队列回执的轻量轮。CI 红按 SHA 只尝试通知一次。部署失败记录包含 Git tree 和忽略 Markdown 后的内容指纹，相同 tree 或只改 Markdown 的候选继续跳过。自改部署相关失败，以及已知构建来源的手动 ship 自检或换盘后的健康、插件、拉消息门失败，共享该记录。账本故障使自动轮暂停并报告原因，部署结果、失败计数及通知照常处理。`--unhalt` 保留有效账本，遇到损坏内容时备份原文件后重建。

构建使用 `<workdir>/autoship` 中钉住候选 SHA 的工作树。负载、网络守护、交办门放行后运行 `bun install --frozen-lockfile` 并构建。签完暂存产物后，在备份与换盘前做最终复核。先核对远端 dev 顶端、工作树和已装版本。临门 fetch 上限为 25 秒，刷新失败或远端顶端变化时放弃本轮。再检查交办和负载，查询发起轮次的 daemon 有无在途会话、后台工作或关机，并确认网络守护放行。CLI 最后重读开关和时间窗。复核拒绝时清理暂存文件，安装文件和 `.prev` 保持原样，重启次数为零。复核通过后备份、换盘、重签整包并重启，再跑健康门和自检。

换盘后，打包 daemon 的自重启定时器可能先发现 inode 变化并由 launchd 拉起新版。结果同样是新版在运行，部署健康门和自检照常执行。

构建、部署或自检失败经 daemon 向主人尝试通知，带 SHA、阶段、回滚结果和当前版本。连续两次此类故障停机，成功或 `--unhalt` 清零。上次有效结论写入 `autoship.json`，当前跳过写入 `autoship-skip.json`，停机与计数写入 `autoship-state.json`，均在 `$STATE_DIR/self-change/`，原子写、0600。自改停机单独解除。`self change --no-deploy` 只限制这条自改，合入的提交仍可能被自动部署。

### 已知限制

- 评审 7：构建产物与健康门还没有用完整目标 SHA 做强绑定。
- 最终就绪查询是一次快照（最终复核也重读时间窗和空闲时长）。从复核通过到 launchd 执行重启，仍有备份、换盘和整包重签的间隔。这期间 daemon 仍可能收到新工作或开始关机；空闲放行时主人也可能正好回来，配置也可能变化。临近窗口终点放行的轮次可能在终点之后完成重启。
- 自改入口自己的 PID 锁仍沿用既有回收方式。`--unhalt` 只取部署锁。自改锁或 `lock.steal` 残留需要另行确认处理。
- 部署 CLI 被强制终止时，SQLite 锁由操作系统释放，已启动的系统命令可能短暂继续。已经进入换盘阶段的事务会留档，需要检查安装和备份。
- 评审 11：通知去重先落盘，当前没有待投通知账和补投。
- 评审 12：不同克隆对旧 sidecar 的短 SHA 可能有不同解释。
- 直接手动运行 `self deploy` 时，CLI 无法确认二进制的构建来源。健康门失败会走部署自身的回滚流程，共享部署失败账本不记这次失败，同一构建内容仍可能被自动轮选中。

## 部署完稳不稳:`wechat-cc self soak`(2026-10-23)

以前「部署后跑满一整天才合下一步」,大半是空等。现在看信号:从日志里最后一次 self deploy 的重启算起,有没有意外重启、`[MODULES]` 失败 / 降级、`uncaughtException`、开机失败、关机被迫退出;健康接口上子系统、心跳、拉消息是不是都好。够时长(缺省 4 小时)且干净 ⇒ 退 0;有异常 ⇒ 退 1;还不够时长 ⇒ 退 2。只读。

- 改到开机 / 关机顺序的(核心链那几步):`--min-restarts 1`,要求部署后至少优雅重启过一次 —— 没重启过,关机那条路这一版就没走过。手动走一次:`launchctl kickstart -k gui/$(id -u)/<label>`(整合者做,别的执行者不碰真机 daemon)。
- 日志轮转掉了部署那一行 ⇒ 判红并让你 `--since <ISO>`。
- 风险大的一步要更久,就 `--min-hours 24`;时长只是其中一条。

## 签名:换完 inode 顺手用 Developer ID 重签(2026-09-28)

公司的 `Developer ID Application: Nate Gu & Co LLC (9Y6JAPDP7A)` 证书到手之后,`self deploy` 在本机钥匙串里探到它(`security find-identity -v -p codesigning`)就多做两步,否则一切照旧(build-sidecar 打的 ad-hoc):

- **sign**(stage 之后、backup 之前):`codesign --force --sign <证书 SHA-1> --options runtime --entitlements apps/desktop/src-tauri/entitlements.plist --identifier com.tendhearth.wechat-cc.cli <sidecar>.new`,签完**再探一次** `--version`。bun 编译出来的 sidecar 是 JIT 运行时,hardened runtime 下缺 entitlement 会被内核直接 SIGKILL、一行日志都没有 —— 所以这一探必须发生在换活之前:死了就退 1,现场一个字节没动、`.prev` 也没写。`--sign` 给的是 SHA-1 不是名字:换证书那阵子新旧两张同名同时有效,按名字签 codesign 会报 ambiguous。装的就是 `.prev` 自己(回滚配方)时**跳过**这一步:它已经活过,再签只会给回滚多开失败路。
- **seal**(swap 之后、kickstart 之前)会用 `codesign --force --sign <证书 SHA-1> --options runtime --entitlements …` 重签整个 `.app`，沿用 CI 的 Tauri 签法，包内其它二进制各带自己的签名。首次重签失败时，CLI 尝试换回 `.prev`（`restore_swap`）并再次重签（`restore_seal`），记录结果并退出 1，期间不会发出 kickstart。`--no-rollback` 只控制健康门阶段的回滚。健康门失败时，换回 `.prev` 后同样会重签（`rollback_seal`）。

**为什么要重封 .app 而不只签 sidecar**:TCC 把「完全磁盘访问」这类授权记在责任进程(主二进制,plist 指的那个)的**指定要求**上。ad-hoc 签名的指定要求是一串 cdhash,`tauri build` 一次就变一次;Developer ID 的是「identifier + team」,重建、换 sidecar 都不变。权限间歇掉的根因在这,不在 sidecar。

**第一次跑要知道的事**:活着的 .app 从 ad-hoc 变成 Developer ID,系统当它是个新客户端,「完全磁盘访问」等授权要**再点一次**;之后就稳了。本地 `tauri build` 没导出 `APPLE_SIGNING_IDENTITY` 时出来的仍是 ad-hoc 包,下一次 `self deploy` 会把它重封回 Developer ID。证书有效期到 2027-02-01,到期前换一张(Team ID 不变,指定要求就不变,授权不掉)。

**DevID 封过的 .app 里永远别再放 ad-hoc sidecar(2026-09-28 事故)**:#143 合入后用**已装的**打包版 CLI 部署,它还是没有「从 `--binary` 旁找 entitlements」那条修的老构建 ⇒ 没签,把 ad-hoc sidecar 换进了 Developer ID 封好的 .app。TCC 当它是新身份弹了框,sidecar 单线程卡在 `openat`、一行日志没有、`internal-api-info.json` 不出现,健康门与回滚的健康门都 60s 超时(exit 3);主人点「允许」才起来。两条:① `self deploy` 步骤里没出现 `sign` / `seal` 就别让它往下走;② 改的是 CLI 自己的部署逻辑时,第一次要从目标分支用**源码模式** `bun cli.ts self deploy` 跑,已装的 CLI 是旧逻辑。诊断口诀:进程在、没日志、info 不出现 ⇒ `sample <sidecar pid> 1`,主线程停在 `openat` 就是权限框,看屏幕。

`entitlements.plist` 找两处:先 repoRoot,再 `--binary` 所在 `binaries/` 的上一级 —— 打包版的 CLI(`wechat-cc self deploy`,也就是标准回路)repoRoot 是 .app 的 MacOS/,只有第二处能中。两处都没有 ⇒ 不签,步骤里也不会出现 sign / seal。`--no-sign` 强制不签。

**不签却往 Developer ID 封好的包里换 ⇒ 拒绝**(2026-10-10):不签时先 `codesign -dv` 看一眼 .app,带 TeamIdentifier ⇒ `signing` 步骤失败、什么都不动(09-28 事故:ad-hoc sidecar 塞进 DevID 包,TCC 框把 daemon 堵死)。从 `.prev` 回滚不拦;确实要换就加 `--allow-unsigned`。

**部署锁**位于 `~/.wechat-cc-self-deploy.lock.sqlite`。手动 ship、手动 deploy、自改和自动轮共用 SQLite 独占事务，持到健康门、自检或回滚结束。内层部署复用已持的锁。进程退出时系统释放锁，SQLite 文件保留。手动 deploy 和 ship 争锁退出 1，自动轮争锁退出 2。重启命令限时 30 秒，诊断查询限时 5 秒。

**部署事务记录**与锁文件相邻（后缀 `.transaction.json`）。原子更新备份后、换盘之前写入新旧版本、目标 sidecar、备份位置和开始时间。自动轮同时记录完整目标 SHA。日用状态目录中的旧 `autoship-transaction.json` 也会被读取。发现遗留记录时，所有前进部署都会拒绝，自动轮停机并尝试通知。可以用源码 CLI `bun cli.ts self deploy --binary <记录中的备份>` 救援。核对现场后运行 `self autoship --unhalt` 确认清理，救援回滚本身保留记录。正常部署通过健康门、外层自检全绿或确认自动回滚后会结清自己的事务。自改若从中断的 `selftest` 恢复，会先检查记录并停在原步骤。手动验收或回滚并确认事务后，可用 `self change --abandon <id>` 归档这条已合入的自改。

## 回滚别把备份吃了(2026-09-18 复审)

`bun cli.ts self deploy --binary <sidecar>.prev` 从源码工作区安装备份。早期实现会先把当前坏掉的 sidecar 复制到 `.prev`，再把这份坏文件装回去，同时毁掉备份和现场。

现在 stage 先把要装的字节拷到 `<sidecar>.new`(新 inode)再动别的,并且上面 backup 那两条豁免保证 `.prev` 不会被坏二进制盖掉。

## inode 陷阱(2026-09-17 真机,一整夜)

原地 `cp` 覆盖 `wechat-cc.app/Contents/MacOS/wechat-cc-cli` **一定会出事**:内核沿用旧 inode 的代码签名缓存,新二进制一起来就被 SIGKILL。症状长这样:

- 手敲 `.../wechat-cc-cli --version` 直接死,退出码 137;
- daemon 崩溃循环,`launchctl print gui/$(id -u)/com.wechat-cc.daemon` 里 `runs` 一路涨,`last exit reason` 可能写 `OS_REASON_CODESIGNING`;
- `internal-api-info.json` 永远不出现(daemon 根本没活到监听那一步),于是所有 CLI 都报「daemon 没在跑」。

**修法只有一个:换 inode。**

```bash
cp new-binary /path/to/wechat-cc.app/Contents/MacOS/wechat-cc-cli.new
mv -f /path/to/wechat-cc.app/Contents/MacOS/wechat-cc-cli.new /path/to/wechat-cc.app/Contents/MacOS/wechat-cc-cli
chmod 755 /path/to/wechat-cc.app/Contents/MacOS/wechat-cc-cli
launchctl kickstart -k gui/$(id -u)/com.wechat-cc.daemon
```

`self deploy` 干的就是这件事;手工兜底时别图省事写成 `cp -f`。

## 崩溃循环怎么看

```bash
launchctl print gui/$(id -u)/com.wechat-cc.daemon | grep -E 'runs|last exit reason|state'
tail -40 "$(plutil -extract StandardErrorPath raw ~/Library/LaunchAgents/com.wechat-cc.daemon.plist)"
ls -l ~/.claude/channels/wechat/internal-api-info.json    # mtime 没更新 = 这次没起来
```

`runs` 每隔几秒 +1 就是崩溃循环，先看 `last exit reason`（`OS_REASON_CODESIGNING` 通常指向上面的 inode 问题）。在带有 `apps/desktop/src-tauri/entitlements.plist` 的源码工作区运行下面的救援命令。

```bash
bun cli.ts self deploy --binary /path/to/wechat-cc.app/Contents/MacOS/wechat-cc-cli.prev
```

这条命令保留 `.prev`。Developer ID 包救援时，检查 `seal` 步骤成功。打包 CLI 可能找不到 entitlement，跳过重签后仍尝试重启。若重签失败或未执行，先用可用的 Developer ID 签名身份和源码里的 entitlement 完成整包重签，再重启。手工换回备份时同样先用 copy+rename 换 inode，再完成所需的重签。

## plist 为什么指主二进制而不是 sidecar

LaunchAgent 的 `ProgramArguments[0]` 是 app 主二进制(`…/Tendhearth CC.app/Contents/MacOS/Tendhearth CC`;老包 `…/wechat-cc.app/Contents/MacOS/wechat_cc_desktop`),参数 `--daemon`,**不是** sidecar。app 搬家 / 改名 / 原地更新换了二进制名之后,app 启动时的 `service repair` 会把它改过来并重新加载(见 [app-rename-migration.md](app-rename-migration.md))。原因是 macOS 把隐私授权(TCC)记在「责任进程」上:

- 主二进制在签了名的 bundle 里、带 Info.plist 的用途说明,系统设置里显示成「wechat-cc」;
- sidecar 是个裸二进制,显示「wechat-cc-cli」、没有说明,而且 ad-hoc 签名每次构建都变 —— 授权跟着失效,换一次 sidecar 就要重新点一次权限框。

主二进制 `--daemon` 只干一件事:把 sidecar 拉起来(`apps/desktop/src-tauri/src/daemon_mode.rs`)。claude / codex / agy / wxvault 都是它的后代,继承授权。来源与细节见 `src/lib/runtime-info.ts` 里 `appMainBinaryPath` 上面那段注释。

改 plist 之前先读那段注释;把它改回指 sidecar 会让主人每次部署都重新授权,并且间歇性掉 TCC 权限。

## 部署不会在微信里播报重启(2026-10-04)

`self deploy` 在每次 `kickstart`(含回滚那次)**之前**往状态目录写 `planned-restart.json`(reason = `self-deploy` / `self-deploy-rollback`);daemon 收到 SIGTERM/SIGINT 时也会先写 `clean-shutdown.json`。新 daemon 开机最早一步(写第一跳心跳之前)把两张纸条连同上一跳心跳读出来、删掉,`daemon/notify-startup.ts` 据此判断:

- 有任一张纸条 ⇒ **计划内**(部署、回滚、空闲加载新代码、换后端、`POST /v1/daemon/restart`、App 更新换包、`service` 命令、注销关机)⇒ 永不通知;
- 都没有 ⇒ **意外**(崩溃、SIGKILL / OOM、断电)⇒ 停机 ≥ 2 分钟或一小时内意外 ≥ 3 次才说一句人话(「CC 刚才意外重启了一次(大约 N 分钟没在线),现在已经恢复。」),每 6 小时至多一条,约 90 秒发不出去就丢弃,**从不补发**。阈值在 `agent-config.json` 的 `restart_notice`(`enabled` / `min_downtime_s` / `min_interval_h`)。技术细节只进日志:`grep NOTIFY channel.log`。

planned 纸条 10 分钟过期,只用一次。

## 「想访问其他 App 的数据」反复弹框 ⇒ 重新勾一次完全磁盘访问(2026-10-04)

症状:daemon 每次重启后弹「"wechat-cc" would like to access data from other apps」,点了「允许」下次重启又弹。根因(统一日志,`subsystem == "com.apple.TCC"`):

1. 访问者是知识库每 5 分钟(以及开机第 1 秒)跑的 wxvault `sync.py --changed-only`,读 `~/Library/Containers/com.tencent.xinWeChat/`;
2. tccd 先查完全磁盘访问:`Failed to match existing code requirement for subject com.tendhearth.wechat-cc and service kTCCServiceSystemPolicyAllFiles` —— 系统设置里的勾是 09-28 换 Developer ID **之前**(ad-hoc,cdhash 当指定要求)勾的,对现在的签名不算数;
3. 于是落到 `kTCCServiceSystemPolicyAppData`,它的「允许」按进程会话记(`Session scoped auth is invalid for client`),daemon 一重启就作废。

代码侧:后台刷新先用不弹框的探针(打开 TCC.db,无 FDA 时静默 EPERM)确认有完全磁盘访问,没有就跳过并在 `/v1/health.fs_access.full_disk_access` / `doctor` 里说。主人侧**一次性**:系统设置 › 隐私与安全性 › 完全磁盘访问,把 Tendhearth CC(#218 之前的包显示为 wechat-cc)用「−」删掉、再「+」加回 `/Applications/wechat-cc.app` 并打开(只拨开关不会刷新旧的指定要求),然后重启 daemon。现在的指定要求是「identifier + Team ID」,之后换包、重签都不会再掉。

## 中继壳页 `relay/pset.html` 是生成物(2026-09-29)

它由 `relay/pset.src.html` + 协议包的 IIFE 生成:改源文件后跑 `bun run build:mobile`,不要手改。它**不随 daemon 发布**,合并后仍要手动拷到 VPS 静态目录,步骤与哈希核对见 [relay/README.md](../../relay/README.md) 的「壳页 pset」。手机协议 v2 这一轮没有改中继代码(`relay/*.ts`),中继本体不用重新部署。

## 内置插件:不随包,靠登记的来源(2026-09-30)

wxvault / wxsearch / wxmedia / wxperson / wxfacts / wxgraph 这些一等插件**按设计不进安装包**(1747de09:目录通配曾把 wxvault 软链后面 105MB 解密私人微信库打进安装包;解密代码也有法律风险)。`build-sidecar` 的资源断言守着这条,每次构建也会打一行「内置插件不随包」。**也不要把插件拷进 `.app`**:wxvault 目录里有 `keys.jsonl` 和 `out/decrypted/`,整包重封还会把几百 MB 的模型缓存一起哈希。

打包版 daemon 找插件的顺序(`src/daemon/plugins/paths.ts`,只认真有 `<name>/wechat-cc.plugin.json` 的目录,只有 README 的空壳不算):

1. `WECHAT_CC_BUNDLED_PLUGINS_DIR`(plist 里显式给的 / app 传的);
2. **状态目录里登记的来源** `~/.claude/channels/wechat/plugins/bundled-source.json`;
3. `.app` 自己:`<MacOS>/plugins`、`Resources/plugins`、`Resources/_up_/_up_/_up_/plugins`;源码模式是 `<repo>/plugins`。

登记来源两种办法,都写在状态目录里(换 sidecar、重打 .app 都不丢):

```bash
wechat-cc plugin source ~/Documents/tendhearth/wechat-cc/plugins   # 手动;不带参数 = 查看当前解析结果
bun cli.ts self deploy                                             # 源码模式部署时自动登记:本 checkout 的 plugins/,
                                                                   # 没有就取主 checkout 的(git common dir 的上一级)
```

插件本身是主 checkout `plugins/` 下的本机软链(gitignore),指向 `~/Documents/tendhearth/wxvault`、`~/Documents/tendhearth/wechat-cc-plugins/packages/*`;新机器照 `plugins/README.md` 自己建。daemon 要能读 `~/Documents`(health 的 `fs_access`)。

**信任口径**:登记的来源按「内置」算,默认开 —— 那个文件夹里新放进去的东西下次启动就会跑,不用 `plugin enable`。只登记自己掌控的目录;第三方插件放用户目录(默认关)。`/v1/health` 是 guest 档:admin 以下只看得到 `plugins` 的计数和缺了哪些名字,路径和 not-ready 原因只给 admin。

**09-11 → 09-30 事故**:LaunchAgent 从 `bun cli.ts`(主 checkout,`<repo>/plugins` 找得到)换成 `.app` 之后,打包版 daemon 一个插件都没加载,三周里只有客户回顾那行 `disabled` 作旁证。现在每次启动都打 `[BOOT] plugin: bundled plugins dir … (via …)` 或 `no bundled plugins dir found`,开着却丢了的插件打 `WARNING`,`/v1/health.plugins` 给出快照,部署健康门据此判红。
