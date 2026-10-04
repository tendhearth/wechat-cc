# macOS 改名迁移:`wechat-cc.app` → `Tendhearth CC.app`(1.7.5)

> 2026-10-04 首版。主人定：用户在系统里看到的「wechat-cc」都换成 Tendhearth CC，包括 .app 名和活动监视器里的两个进程名。显示名（登录项、通知、dmg 卷名）由 1.7.4 另一个 PR 改，这一页不管。

## 改了什么，没改什么

| 东西 | 1.7.4 及以前 | 1.7.5 起(只限 macOS) | 在哪定 |
|---|---|---|---|
| .app 名 / productName | `wechat-cc.app` | `Tendhearth CC.app` | `apps/desktop/src-tauri/tauri.macos.conf.json` |
| 主二进制(CFBundleExecutable,活动监视器里的 app 和 `--daemon` 进程) | `wechat_cc_desktop` | `Tendhearth CC` | 同上 `mainBinaryName` |
| sidecar(daemon 本体 + CLI + MCP 服务) | `wechat-cc-cli` | `tendhearth-cc-cli` | 同上 `externalBin`;`apps/desktop/scripts/build-sidecar.ts` |
| updater 包 | `wechat-cc.app.tar.gz` | `Tendhearth CC.app.tar.gz`(GitHub 上是 `Tendhearth.CC.app.tar.gz`) | `scripts/publish-update.platforms.ts` |
| R2 对象名 / latest.json 形状 | `wechat-cc_<ver>_darwin-aarch64.app.tar.gz` | **不变** | 同上 |

下面这些**永远不变**:bundle id `com.tendhearth.wechat-cc`、CLI 命令名 `wechat-cc`、状态目录 `~/.claude/channels/wechat`、LaunchAgent label `com.wechat-cc.daemon`、URL scheme、钥匙串键、更新地址。

Windows 和 Linux 不改：NSIS 的安装目录和卸载注册表键挂在 productName 上，改了会装出并排的第二份；deb/rpm 包名同理。计划任务和 systemd unit 里写死的是 `wechat-cc-cli`。所以改名只写在 `tauri.macos.conf.json` 里，基础 `tauri.conf.json` 不动。守卫在 `src/lib/app-identity.test.ts`。

新旧名字的对照表只有一张:`src/lib/app-identity.ts`(TS)和 `apps/desktop/src-tauri/src/bundle_migrate.rs`(Rust)。凡是需要认出「这是我们自己的二进制」的地方都得认整张表，新名字在前：单实例锁、`daemon kill`、`binary-detect`、`self deploy`、`resolveAppMainBinary`、`daemon_mode.rs`。

## 证据:tauri updater 原地安装，不认新包名

版本是 tauri-plugin-updater 2.10.1(`apps/desktop/src-tauri/Cargo.lock`)。看了源码，也拿一次性 bundle 实跑过一遍。

**源码**(`~/.cargo/registry/src/*/tauri-plugin-updater-2.10.1/src/updater.rs`):

- 第 319–324 行和第 1353–1380 行:`extract_path` 从 `current_exe()` 往上推。路径里含 `Contents/MacOS` 时取再往上两级，得到**正在运行的那个** `.app`。
- 第 1238 行:`entry.path()?.iter().skip(1)`。tar 包的顶层目录名(`Tendhearth CC.app/`)直接丢掉，从不使用。
- 第 1255–1302 行：先把旧包 rename 到临时备份，再把解出来的临时目录 rename 到 `extract_path`。没权限时(第 1266 行)改走管理员 AppleScript `rm -rf src && mv new src`,目标路径还是同一个。

**实跑**:tauri 2.10.3 mock app 加 updater 2.10.1,本地 http 服务 latest.json 和一次性 minisign 签的 `Tendhearth CC.app.tar.gz`,`executable_path` 指向临时目录里的 `Applications/wechat-cc.app/Contents/MacOS/wechat_cc_desktop`:

```
BEFORE: 108484872 wechat-cc.app   Contents/MacOS: wechat_cc_desktop        CFBundleExecutable=wechat_cc_desktop
RUN:    update found 0.1.0 -> 9.9.9; GET /Tendhearth%20CC.app.tar.gz 200; download_and_install OK
AFTER:  108535133 wechat-cc.app   Contents/MacOS: Tendhearth CC, tendhearth-cc-cli   CFBundleExecutable=Tendhearth CC
```

从中得出:

1. **不会出现 `Tendhearth CC.app`**。老用户更新完路径还是 `wechat-cc.app`,里面已经是新内容。
2. **旧文件名一个不留**。`wechat_cc_desktop` 和 `wechat-cc-cli` 都没了，所以 LaunchAgent 的 `ProgramArguments[0]`、终端 hook 命令行、脚本里写死的全路径，在更新那一刻全部失效。
3. bundle 目录换了 inode(新目录 rename 进来),属组从 wheel 变成 staff(继承 `$TMPDIR`)。
4. 重启没问题:tauri 2.10.3 `process.rs` 第 92–131 行的 `restart_macos_app` 会重新读 `Contents/Info.plist` 的 `CFBundleExecutable`,拉起的是 `wechat-cc.app/Contents/MacOS/Tendhearth CC`。

本地实打一个包核对(`tauri build --bundles app`,ad-hoc):产物是 `bundle/macos/Tendhearth CC.app`,`Contents/MacOS` 里有 `Tendhearth CC`、`tendhearth-cc-cli`、`cc-jobspawn`、`sd-cli`;`CFBundleExecutable` / `CFBundleName` / `CFBundleDisplayName` 都是 `Tendhearth CC`,`CFBundleIdentifier` 是 `com.tendhearth.wechat-cc`。

## 选的方案：原地更新 + 首次启动自己改名(方案 a)

**方案 b**(老安装留在原路径，只有新装用新名)被否决，原因三条:

- 老用户在 Finder、Spotlight、Launchpad 里看到的永远是「wechat-cc」(这几处显示的是文件名，不是 CFBundleName)。这和主人「用户看到的 wechat-cc 都换掉」的目标正面冲突。
- 老用户哪天从网站下了新 dmg 拖进 Applications,就会得到两个同 bundle id 的 app 并排:LaunchServices 随机选一个,LaunchAgent 指着另一个。
- 改主二进制和 sidecar 的名字反正会让 LaunchAgent 失效，自修逻辑无论如何都要写。方案 a 只在它之外多一步 rename。

**方案 a 的流程**(`bundle_migrate.rs`,只在 macOS release 构建、`main()` 里任何窗口创建之前执行):

1. 判断：当前包名在旧名表里(`wechat-cc.app`),**而且**正好在 `/Applications` 或 `~/Applications` 下，而且目标 `Tendhearth CC.app` 不存在。不满足就不改名：开发构建、隔离运行(AppTranslocation)、挂载的 dmg、用户自己起的名字、目标已存在，一律跳过。
2. `rename(<dir>/wechat-cc.app, <dir>/Tendhearth CC.app)`:同目录、同卷，原子操作，inode 不变。普通用户对 root 拥有的 /Applications 没写权限(EACCES)时，留在原路径照常工作。
3. 同步执行**新路径里的** sidecar:`tendhearth-cc-cli service repair --json`(见下)。
4. `sh -c 'sleep 1; open -n "<新路径>"'`,当前进程退出。必须重启：当前进程的 `current_exe()` 和 tauri-plugin-shell 的 sidecar 解析，在 rename 之后都指向旧路径。

其余每次启动：在后台执行一次 `service repair --json`。正常情况下它什么都不做。

### `wechat-cc service repair`(`src/cli/service-repair.ts`、`src/cli/app-relocation.ts`)

只有一条规则：**旧目标不存在才改**。旧目标还在，说明那是另一份合法安装(比如主人的开发包),一律不动。自己跑在 `…/bundle/macos/`、`target/release/`、AppTranslocation 或 `/Volumes/` 下时，也不把 LaunchAgent 指向自己。

1. **LaunchAgent**:改写 `ProgramArguments[0]`(老形状指向 sidecar 的就换成自己的 sidecar),再把 `WorkingDirectory` 以及所有以旧 `.app/` 开头的路径(比如 `WECHAT_CC_BUNDLED_PLUGINS_DIR`)换成新包，其余键原样保留。原子写入，权限 0600。然后 `launchctl bootout` + `bootstrap` + `kickstart` 重新加载(`reloadService`,不重新生成 plist)。光改文件没用:launchd 是照着**已加载的**旧定义去 respawn 的。
2. **终端 hook**:`~/.claude/settings.json` 和 `$CODEX_HOME/hooks.json` 里，我们自己写的 hook 条目如果指向一个已经不存在的 sidecar,就按现行格式重写一遍(重写后四个事件都会挂上)。
3. **转发脚本 `~/.local/bin/wechat-cc`**:内容是 `exec '<当前 sidecar>' "$@"`,第二行是自家标记。文件不存在就写；带标记就更新；不带标记(别人的同名文件)不动。这个入口不随 app 改名或换位置而失效。脚本里写死的 `…/wechat-cc.app/Contents/MacOS/wechat-cc-cli` 全路径应该改成用它。

开关:`--no-reload`(只写文件)、`--json`,以及 `WECHAT_CC_DRY_RUN=1`(什么都不写)。**HOME 被覆盖时绝不碰 launchd**(`homedir() !== userInfo().homedir` 会直接拒绝):launchctl 的 `gui/<uid>` 域只有一个，在临时 HOME 里演练时 `bootout` 一样会打到真 daemon 上。2026-10-04 写这段时就真打到过一次，详见文末。

### 重载等于重启 daemon,为什么不等空闲

只有旧目标已经不存在时才会重载。那时正在跑的 daemon 是旧包留下的进程(inode 还在),一旦退出,launchd 就拉不起来了。`self-restart` 的 exec-identity 检查也读不到旧路径(`readExecIdentity` 返回 null),它永远不会自己重启。所以不能等：早重载早安全。触发点是用户点了「重启 CC」之后的第一次启动，用户本来就预期会有一次重启。

## 每一项的影响

| | 主二进制改名 | sidecar 改名 | .app 改名 |
|---|---|---|---|
| **TCC 责任进程** | 不受影响。指定要求是 `identifier "com.tendhearth.wechat-cc" and anchor apple generic and … leaf[subject.OU] = "9Y6JAPDP7A"`(已装 1.7.3 用 `codesign -d -r-` 实测),既不含路径也不含文件名。责任进程是 `--daemon` 那个主二进制，它就是包的 CFBundleExecutable | 不是责任进程(LaunchAgent 起的是主二进制 `--daemon`,sidecar 是子进程，继承授权)。它自己的签名 identifier 本来就不稳定(已装包里是 `wechat-cc-cli`,`self deploy` 重签后是 `com.tendhearth.wechat-cc.cli`) | 不受影响。rename 不碰包内容，签名、公证票据、TCC 记录全都原样 |
| **LaunchAgent ProgramArguments** | 原地更新后立刻失效 → `service repair` 修 | 不在里面(除非是 09-04 以前的老形状，同样能修) | 改名后失效 → 同步修 |
| **self deploy** | `--app` 从 plist 推导；plist 过期时报 `launchagent_stale`,不会往死目录里部署 | 包里实际叫什么就换什么(新包 `tendhearth-cc-cli`,老包或回滚后 `wechat-cc-cli`);构建产物也挑新名字 | `--app "/Applications/Tendhearth CC.app"`,路径带空格，全程按参数数组传 |
| **自动升级** | updater 重启读 Info.plist,不受影响 | 无关 | 下一次更新的 `extract_path` 就是新路径 |
| **回滚到 1.7.4** | updater 默认不降级(只装版本号更大的),回滚只能手工装 1.7.4 的 dmg ⇒ 得到并排的 `wechat-cc.app`;LaunchAgent 仍指向还存在的 `Tendhearth CC`,要切到旧版就在旧 app 里重做一次「安装后台服务」(`service install`)| 1.7.4 的单实例锁不认 `tendhearth-cc-cli`:新 daemon 还活着时起旧 daemon 会被当成 PID 复用而抢锁 ⇒ 回滚前先停 daemon(`self deploy` 的回滚是 kickstart -k,先杀后起,不受影响) | 新包不会自动改回旧名;删掉 `Tendhearth CC.app` 之前先把 LaunchAgent 切走 |
| **钥匙串** | 不受影响(读写都走 `/usr/bin/security`) | 同左 | 同左 |
| **Dock 固定 / Finder 替身** | — | — | 同卷 rename 保留 inode,书签跟得上。Spotlight 和 Launchpad 按新名字重新索引 |
| **Gatekeeper / 隔离属性** | — | — | rename 不加 quarantine;updater 写入的文件本来就没有 quarantine |
| **「完全磁盘访问」列表** | 按 bundle id 记 | — | 需要真机核对显示名和开关状态(清单第 6 项) |

## 首次真实更新 1.7.4 → 1.7.5 的真机验证清单(主人的 Mac)

先记下基线，再点更新:

```bash
launchctl print gui/$(id -u)/com.wechat-cc.daemon | grep -E 'program =|pid =|runs ='
plutil -p ~/Library/LaunchAgents/com.wechat-cc.daemon.plist | grep -A2 ProgramArguments
grep -o '"command": "[^"]*hook[^"]*"' ~/.claude/settings.json | head -1
codesign -d -r- /Applications/wechat-cc.app 2>&1 | tail -1
```

1. **更新本身**:横幅 →「现在更新」→ 下载到 100% →「重启 CC」。重启时会短暂出现两次窗口(第二次是改名后从新路径拉起的)。
2. **只剩一个 app**:`ls -d /Applications/*.app | grep -iE 'wechat|tendhearth'` 只有 `Tendhearth CC.app`;`ls "/Applications/Tendhearth CC.app/Contents/MacOS"` 里是 `Tendhearth CC`、`tendhearth-cc-cli`、`cc-jobspawn`、`sd-cli`。
3. **LaunchAgent**:`launchctl print …` 里的 `program = /Applications/Tendhearth CC.app/Contents/MacOS/Tendhearth CC`,`runs` 比基线多 1,`last exit code` 正常;plist 里 `WorkingDirectory` 指向新包。
4. **daemon 真活着，而且是新版**:`/v1/health` 返回 200,`version` 是 1.7.5;微信发一句能收到回复。
5. **活动监视器**:能看到 `Tendhearth CC`(app 和 daemon 守护)以及 `tendhearth-cc-cli`,搜「wechat」只剩下微信本身。
6. **TCC**:系统设置 → 隐私与安全性 →「完全磁盘访问」和「文件与文件夹」里，条目显示为 Tendhearth CC,开关仍然打开;客户回顾 / wxvault 能读微信库，没有新弹框。`codesign -d -r- "/Applications/Tendhearth CC.app"` 跟基线一致(identifier + team)。
7. **入口**:Dock 固定图标还能点开;Spotlight 搜「Tendhearth」能找到，搜「wechat-cc」不再出现这个 app;Launchpad 显示新名字。
8. **终端 hook**:`~/.claude/settings.json` 里的 hook 命令指向 `…/Tendhearth CC.app/Contents/MacOS/tendhearth-cc-cli`;开一个终端 claude 会话跑完一轮，没有 hook 报错，微信收到推送。
9. **命令行入口**:`~/.local/bin/wechat-cc --version` 输出 1.7.5(没加进 PATH 的话先加，或者改 alias)。主人自己脚本和记忆里写死的 `/Applications/wechat-cc.app/Contents/MacOS/wechat-cc-cli` 换成 `~/.local/bin/wechat-cc`。
10. **其它外部配置**:`~/.gemini/config/mcp_config.json` 的 `wechat-cc-wechat.command` 已被 daemon 启动时重写成新 sidecar 路径;codex 和 cursor 的 MCP 是每个会话现生成的，不用管。
11. **self deploy**:从 dev 走一遍 `cd apps/desktop && bun run build-sidecar && cd - && ~/.local/bin/wechat-cc self deploy`,`--app` 自动推导到新包，换的是 `tendhearth-cc-cli`,健康门通过。
12. **下一次更新**(1.7.5 → 1.7.6,或者用 workflow_dispatch 发一个测试版本):装进 `Tendhearth CC.app` 本身，不再重命名，LaunchAgent 不再重载(`service repair` 返回 `reason: ok`)。

任何一项不对，先 `launchctl print` 加 `~/.claude/channels/wechat/launchd.err.log` 尾巴。如果 daemon 起不来，手工执行 `"/Applications/Tendhearth CC.app/Contents/MacOS/tendhearth-cc-cli" service repair --json`;实在不行就 `service install`。

## 已知边界

- **普通用户(不在 admin 组)**:对 /Applications 没写权限，改不了名，留在 `wechat-cc.app`,主二进制和 sidecar 已经是新名字,LaunchAgent 照常修。Finder 里显示的还是 wechat-cc。
- **1.7.5 dmg 和老的 `wechat-cc.app` 并存**(用户手动下载新 dmg 拖进来):目标已存在，不改名，两个 app 并排。LaunchAgent 跟着最后启动的那份走(仅限另一份已经失效时)。旧的那份需要用户自己删。
- **更新后一直不点「重启 CC」**:旧 daemon 继续跑旧代码，一旦崩溃 launchd 就拉不起来，要等到下次打开 app 才修。
- **回滚**:见上表。手工装旧 dmg,先停 daemon,再在旧 app 里执行 `service install`。

## 2026-10-04 的事故(为什么 repair 拒绝在 HOME 被覆盖时碰 launchd)

当时用一次性 HOME 加真编译的 sidecar 演练 `service repair --no-reload`。citty 把 `--no-reload` 解析成 `reload:false`,声明的 `no-reload` 键是 undefined,于是开关没生效。`bootout` 按 label 打中了主人真的 `com.wechat-cc.daemon`,`bootstrap` 又把临时目录里的构建装了上去。这份构建大约跑了一分半，用的是真实状态目录;启动通知因为 errcode=-2 没有发出去,agy 的 MCP 配置被它改过一次，真 daemon 重新起来后已经写回。之后已经手工 bootout,并从未被改动过的 `~/Library/LaunchAgents/com.wechat-cc.daemon.plist` 重新 bootstrap 加 kickstart 恢复。现在两种拼法都认，并且多了上面那道 HOME 闸。
