# 发版(桌面 + 自动更新源)

> 2026-09-27 首版。此前整条链只写在三个 workflow 的头注释里,`roadmap` 把「发版管线」链到 `deploy.md`(那页讲的是本机换 sidecar)。

`self deploy`([deploy.md](deploy.md))是**本机**换 sidecar;这页是**给用户**发版。两者共用同一个版本号(`scripts/version-consistency.guard.test.ts` 钉住四处 + `Cargo.toml`)。

## 一次发版要人做的四件事

| # | 人做什么 | 机器接着做什么 |
|---|---|---|
| 1 | 在 dev 上把版本号升到 X.Y.Z(根 `package.json`、`apps/desktop/package.json`、`apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src-tauri/Cargo.toml`;`bun --bun vitest run scripts/version-consistency.guard.test.ts` 绿),写 `docs/releases/desktop-vX.Y.Z.md`,合进 master(squash PR) | — |
| 1.5 | **squash 合进 master 之后,立刻在 dev 上补一条簿记合并**:`git merge -s ours --no-ff origin/master -m "chore: 记录 #NN 的 squash 已并入 dev(树不变,发版簿记)"` 然后推 dev。树不变,只是把 master 的 squash 提交挂成 dev 的祖先 | 少了这一步,下一次 dev→master 的 PR 会拿上一次的 merge base 比,两边都改过的文件全判冲突,GitHub 连 pull_request 作业都不跑(2026-09-27 PR #121 就是这样 CONFLICTING 的;#88–#93 每次都补了,#117 漏了) |
| 2 | 在 master 的发版提交上打 tag 并推:`git tag -a vX.Y.Z <sha> -m "desktop vX.Y.Z" && git push origin vX.Y.Z` | `mirror-desktop-tag.yml` 用 `RELEASE_PAT_WECHAT_CC` 把它镜像成 `desktop-vX.Y.Z`(GITHUB_TOKEN 推的 tag 不会触发下游 workflow,这是 v0.5.17 踩过的坑) |
| 3 | 到 Actions 里给 `Desktop Build` 的 `release-signing` 环境点**批准**(签名私钥挂在这个环境上,每次构建都要点) | `desktop.yml` 三平台构建(linux-x86_64 / macos-aarch64 / windows-x86_64;macOS Intel 跳过)→ 建 **Draft** Release 并挂产物 |
| 4 | 在 Releases 页检查 Draft(产物齐、说明对),点 **Publish**;随后再给 `Publish Update Channel` 的 `release-signing` 点一次批准 | `publish-update.yml` 用 release 自己的资产跑 `scripts/publish-update.ts --from-dir … --no-github`,生成 `latest.json` 上传 R2(`dl.tendhearth.com/wechat-cc/latest.json`;只发 darwin-aarch64 + windows-x86_64;每平台留 3 版)。老用户的 Tauri updater 从此看到新版 |

补发(某次 R2 令牌过期):Actions → `Publish Update Channel` → Run workflow,填 `desktop-vX.Y.Z`。

## 两道批准是有意的;谁来点是主人的事

签名私钥 = 让所有已安装 app 自动下载并运行任意代码的钥匙;R2 令牌 = 决定所有已安装 app 该装哪个版本。都挂在带必需审批人(`ggshr9`)的 `release-signing` 环境上,每次取用留痕。**环境门本身不要拆掉。**

2026-09-27 主人定:批准可以由主人机器上的助手(Claude Code / Codex)用主人自己的 gh 凭据经 API 通过(`POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments`,`environment_ids` 取 `release-signing` 的 id,`state: approved`),Publish 也可由助手 `gh release edit <tag> --draft=false`。安全属性没变 —— 仍然要主人的凭据,别人往分支推的 workflow 拿不到 —— 只是主人不必亲手点。前提:助手在做之前把「要发什么、产物齐不齐」报给主人一次。

## 已知坑

- `wechat-cc update` **不读** `v*` tag,它比的是 `origin/<branch>`(`src/cli/update.ts`);`v*` tag 唯一的作用是被镜像成 `desktop-v*`。
- Windows 只在 CI 编译;签名与发布固定在 Mac / CI(Win32 给环境变量赋空串等于删除,tauri 签名步骤会挂死等密码)。
- `.sig` 是 minisign 签名、平台无关;曾被发版脚本的双层过滤丢掉过(2026-09-03,已修)。
- 产物名与平台映射在 `scripts/publish-update.platforms.ts`,守卫 `scripts/release-pipeline.guard.test.ts`。1.7.5 起 macOS 的 updater 包叫 `Tendhearth CC.app.tar.gz`(GitHub release 上空格变点:`Tendhearth.CC.app.tar.gz`),dmg 叫 `Tendhearth CC_<ver>_aarch64.dmg`;R2 对象名与 latest.json 形状不变,老客户端照常更新 —— 它们把新包原地装进 `wechat-cc.app`,app 首次启动再自己改名。见 [app-rename-migration.md](app-rename-migration.md)。Windows / Linux 产物名不变。
- 发版 workflow 的 bun 版本与 CI 一样钉死(2026-09-27 起,`scripts/ci-workflow.guard.test.ts`);别改回 `latest`。
- **Cloudflare R2 令牌会过期。** 2026-09-27 发 1.7.0 时 `release-signing` 环境的 `CF_API_TOKEN` 与本机钥匙串 `wechat-cc-r2` 都已失效(`/user/tokens/verify` 401),`publish-update` 作业「降级为本地暂存」还报绿,GitHub Release 发了、`latest.json` 还停在 1.6.5。现在 CI 带 `--strict`,再失效会直接红。换令牌:Cloudflare 后台 → API Tokens → 建一枚带 `Account · Workers R2 Storage · Edit` + `Account · Account Settings · Read` 的令牌 → 本机 `security add-generic-password -a "$USER" -s wechat-cc-r2 -w '<token>' -U` → `gh secret set CF_API_TOKEN --env release-signing` → Actions 里 `Publish Update Channel` → Run workflow 填 `desktop-vX.Y.Z` 补发。探令牌是否还活着:任何真实调用(`GET /accounts`)返回 success 即可,别只看 verify。
- **公证变量空串会触发公证**(2026-09-27):macOS 上环境变量设成空串不等于没设,tauri-bundler 看到 `APPLE_TEAM_ID` 就去公证。三个公证变量只在证书 import 成功后写进 `$GITHUB_ENV`。
- **stable-diffusion.cpp 要带子模块克隆**(2026-09-27):`--depth 1` 不带 `--recurse-submodules` 时 `ggml/` 是空目录,macOS 构建在 CMake 处停。
