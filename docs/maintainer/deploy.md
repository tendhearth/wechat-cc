# 部署(macOS / launchd)

只讲 macOS。Windows / Linux 没有 `self deploy`,那边照旧手工装包。

## 正常流程

```bash
cd apps/desktop && bun run build-sidecar && cd -
wechat-cc self deploy            # 缺省:自动挑本机架构的二进制、失败自动回滚
wechat-cc self deploy --json     # 机器可读
```

可用开关(spec §3):`--binary <path>`(源码模式缺省 `apps/desktop/src-tauri/binaries/wechat-cc-cli-<arch>-apple-darwin`,`arm64→aarch64`、`x64→x86_64`;**打包版里必填**)、`--app <path>`(缺省从 LaunchAgent plist 的 `ProgramArguments[0]` 推)、`--no-rollback`、`--no-sign`(见下「签名」)、`--allow-missing-plugins`(插件门红了也放行,记 detail + 日志;给本来就没插件的机器,不必永久 `plugin disable`)、`--health-timeout-ms N`(缺省 60000)、`--json`。

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

## 签名:换完 inode 顺手用 Developer ID 重签(2026-09-28)

公司的 `Developer ID Application: Nate Gu & Co LLC (9Y6JAPDP7A)` 证书到手之后,`self deploy` 在本机钥匙串里探到它(`security find-identity -v -p codesigning`)就多做两步,否则一切照旧(build-sidecar 打的 ad-hoc):

- **sign**(stage 之后、backup 之前):`codesign --force --sign <证书 SHA-1> --options runtime --entitlements apps/desktop/src-tauri/entitlements.plist --identifier com.tendhearth.wechat-cc.cli <sidecar>.new`,签完**再探一次** `--version`。bun 编译出来的 sidecar 是 JIT 运行时,hardened runtime 下缺 entitlement 会被内核直接 SIGKILL、一行日志都没有 —— 所以这一探必须发生在换活之前:死了就退 1,现场一个字节没动、`.prev` 也没写。`--sign` 给的是 SHA-1 不是名字:换证书那阵子新旧两张同名同时有效,按名字签 codesign 会报 ambiguous。装的就是 `.prev` 自己(回滚配方)时**跳过**这一步:它已经活过,再签只会给回滚多开失败路。
- **seal**(swap 之后、kickstart 之前):对整个 `.app` 再 `codesign --force --sign <证书 SHA-1> --options runtime --entitlements …`(不 `--deep`,跟 CI 里 tauri 一样;`.app` 里其它二进制各带各的签名)。失败 = **部署没发生**:这时还没 kickstart、老 daemon 一次都没被打断,于是把 `.prev` 的字节换回来(`restore_swap`)、再重封一次(`restore_seal`,记录、不致命),不重启,退 1;`--no-rollback` 也一样(那个开关只管健康门之后的事,不该让一个没验过的 sidecar 留在盘上等下一次主进程拉起)。健康门失败走的回滚换回 `.prev` 之后同样重封一次(`rollback_seal`)。

**为什么要重封 .app 而不只签 sidecar**:TCC 把「完全磁盘访问」这类授权记在责任进程(主二进制,plist 指的那个)的**指定要求**上。ad-hoc 签名的指定要求是一串 cdhash,`tauri build` 一次就变一次;Developer ID 的是「identifier + team」,重建、换 sidecar 都不变。权限间歇掉的根因在这,不在 sidecar。

**第一次跑要知道的事**:活着的 .app 从 ad-hoc 变成 Developer ID,系统当它是个新客户端,「完全磁盘访问」等授权要**再点一次**;之后就稳了。本地 `tauri build` 没导出 `APPLE_SIGNING_IDENTITY` 时出来的仍是 ad-hoc 包,下一次 `self deploy` 会把它重封回 Developer ID。证书有效期到 2027-02-01,到期前换一张(Team ID 不变,指定要求就不变,授权不掉)。

**DevID 封过的 .app 里永远别再放 ad-hoc sidecar(2026-09-28 事故)**:#143 合入后用**已装的**打包版 CLI 部署,它还是没有「从 `--binary` 旁找 entitlements」那条修的老构建 ⇒ 没签,把 ad-hoc sidecar 换进了 Developer ID 封好的 .app。TCC 当它是新身份弹了框,sidecar 单线程卡在 `openat`、一行日志没有、`internal-api-info.json` 不出现,健康门与回滚的健康门都 60s 超时(exit 3);主人点「允许」才起来。两条:① `self deploy` 步骤里没出现 `sign` / `seal` 就别让它往下走;② 改的是 CLI 自己的部署逻辑时,第一次要从目标分支用**源码模式** `bun cli.ts self deploy` 跑,已装的 CLI 是旧逻辑。诊断口诀:进程在、没日志、info 不出现 ⇒ `sample <sidecar pid> 1`,主线程停在 `openat` 就是权限框,看屏幕。

`entitlements.plist` 找两处:先 repoRoot,再 `--binary` 所在 `binaries/` 的上一级 —— 打包版的 CLI(`wechat-cc self deploy`,也就是标准回路)repoRoot 是 .app 的 MacOS/,只有第二处能中。两处都没有 ⇒ 不签,步骤里也不会出现 sign / seal。`--no-sign` 强制不签。

## 回滚别把备份吃了(2026-09-18 复审)

`wechat-cc self deploy --binary <sidecar>.prev` 现在是**安全**的,以前不是:那时 backup 跑在 swap 前面,于是这条命令先把**当前那个坏的** sidecar 拷成 `.prev`(好的字节当场没了),再把「新二进制」= 已经变坏的 `.prev` 装回去 —— 一条命令同时毁掉备份和现场。

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

`runs` 每隔几秒 +1 就是崩溃循环;先看 `last exit reason`(`OS_REASON_CODESIGNING` ⇒ 十有八九是上面的 inode)。回滚就一条:

```bash
wechat-cc self deploy --binary /path/to/wechat-cc.app/Contents/MacOS/wechat-cc-cli.prev
```

这条命令会跳过 backup(见上一节),`.prev` 原封不动 —— 可以放心重复跑。手工兜底就按上面的 copy+rename 换回去。

## plist 为什么指主二进制而不是 sidecar

LaunchAgent 的 `ProgramArguments[0]` 是 `…/wechat-cc.app/Contents/MacOS/wechat-cc`,参数 `--daemon`,**不是** `wechat-cc-cli`。原因是 macOS 把隐私授权(TCC)记在「责任进程」上:

- 主二进制在签了名的 bundle 里、带 Info.plist 的用途说明,系统设置里显示成「wechat-cc」;
- sidecar 是个裸二进制,显示「wechat-cc-cli」、没有说明,而且 ad-hoc 签名每次构建都变 —— 授权跟着失效,换一次 sidecar 就要重新点一次权限框。

主二进制 `--daemon` 只干一件事:把 sidecar 拉起来(`apps/desktop/src-tauri/src/daemon_mode.rs`)。claude / codex / agy / wxvault 都是它的后代,继承授权。来源与细节见 `src/lib/runtime-info.ts` 里 `appMainBinaryPath` 上面那段注释。

改 plist 之前先读那段注释;把它改回指 sidecar 会让主人每次部署都重新授权,并且间歇性掉 TCC 权限。

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
