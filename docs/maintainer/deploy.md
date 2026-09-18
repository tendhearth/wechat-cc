# 部署(macOS / launchd)

只讲 macOS。Windows / Linux 没有 `self deploy`,那边照旧手工装包。

## 正常流程

```bash
cd apps/desktop && bun run build-sidecar && cd -
wechat-cc self deploy            # 缺省:自动挑本机架构的二进制、失败自动回滚
wechat-cc self deploy --json     # 机器可读
```

可用开关(spec §3):`--binary <path>`(缺省 `apps/desktop/src-tauri/binaries/wechat-cc-cli-<arch>-apple-darwin`,`arm64→aarch64`、`x64→x86_64`)、`--app <path>`(缺省从 LaunchAgent plist 的 `ProgramArguments[0]` 推)、`--no-rollback`、`--health-timeout-ms N`(缺省 60000)、`--json`。

它按顺序做五件事:

1. **preflight** —— 新二进制存在、可执行、`--version` 退出 0(5s 上限)。不过就一个文件都不动。
2. **backup** —— `<sidecar>` → `<sidecar>.prev`。
3. **swap** —— `copyFile(new, <sidecar>.new)` + `rename(.new → sidecar)`,`chmod 755`。**必须换 inode**,见下。
4. **restart** —— `launchctl kickstart -k gui/$(id -u)/com.wechat-cc.daemon`。
5. **health** —— 等 `~/.claude/channels/wechat/internal-api-info.json` 的 mtime 晚于 kickstart 时刻,再用 **file token** `GET /v1/health` 拿 200,且 `version.cli` 等于 preflight 那个版本串。

健康门不过 ⇒ 自动回滚(同样 copy+rename 换 inode)+ 再 kickstart + 再等健康;无论回滚成不成,都会打印 `launchctl print` 里的 `last exit reason` / `runs` 和 `launchd.err.log` 尾 40 行。退出码:成功 0,失败(已回滚)1,回滚也失败 3,平台不对 2。

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

`runs` 每隔几秒 +1 就是崩溃循环;先看 `last exit reason`(`OS_REASON_CODESIGNING` ⇒ 十有八九是上面的 inode)。回滚:`wechat-cc self deploy --binary <sidecar>.prev`,或手工把 `.prev` 按上面的 copy+rename 换回去。

## plist 为什么指主二进制而不是 sidecar

LaunchAgent 的 `ProgramArguments[0]` 是 `…/wechat-cc.app/Contents/MacOS/wechat-cc`,参数 `--daemon`,**不是** `wechat-cc-cli`。原因是 macOS 把隐私授权(TCC)记在「责任进程」上:

- 主二进制在签了名的 bundle 里、带 Info.plist 的用途说明,系统设置里显示成「wechat-cc」;
- sidecar 是个裸二进制,显示「wechat-cc-cli」、没有说明,而且 ad-hoc 签名每次构建都变 —— 授权跟着失效,换一次 sidecar 就要重新点一次权限框。

主二进制 `--daemon` 只干一件事:把 sidecar 拉起来(`apps/desktop/src-tauri/src/daemon_mode.rs`)。claude / codex / agy / wxvault 都是它的后代,继承授权。来源与细节见 `src/lib/runtime-info.ts` 里 `appMainBinaryPath` 上面那段注释。

改 plist 之前先读那段注释;把它改回指 sidecar 会让主人每次部署都重新授权,并且间歇性掉 TCC 权限。
