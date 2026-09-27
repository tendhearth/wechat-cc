# 发版(桌面 + 自动更新源)

> 2026-09-27 首版。此前整条链只写在三个 workflow 的头注释里,`roadmap` 把「发版管线」链到 `deploy.md`(那页讲的是本机换 sidecar)。

`self deploy`([deploy.md](deploy.md))是**本机**换 sidecar;这页是**给用户**发版。两者共用同一个版本号(`scripts/version-consistency.guard.test.ts` 钉住四处 + `Cargo.toml`)。

## 一次发版要人做的四件事

| # | 人做什么 | 机器接着做什么 |
|---|---|---|
| 1 | 在 dev 上把版本号升到 X.Y.Z(根 `package.json`、`apps/desktop/package.json`、`apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src-tauri/Cargo.toml`;`bun --bun vitest run scripts/version-consistency.guard.test.ts` 绿),写 `docs/releases/desktop-vX.Y.Z.md`,合进 master(squash PR) | — |
| 2 | 在 master 的发版提交上打 tag 并推:`git tag -a vX.Y.Z <sha> -m "desktop vX.Y.Z" && git push origin vX.Y.Z` | `mirror-desktop-tag.yml` 用 `RELEASE_PAT_WECHAT_CC` 把它镜像成 `desktop-vX.Y.Z`(GITHUB_TOKEN 推的 tag 不会触发下游 workflow,这是 v0.5.17 踩过的坑) |
| 3 | 到 Actions 里给 `Desktop Build` 的 `release-signing` 环境点**批准**(签名私钥挂在这个环境上,每次构建都要点) | `desktop.yml` 三平台构建(linux-x86_64 / macos-aarch64 / windows-x86_64;macOS Intel 跳过)→ 建 **Draft** Release 并挂产物 |
| 4 | 在 Releases 页检查 Draft(产物齐、说明对),点 **Publish**;随后再给 `Publish Update Channel` 的 `release-signing` 点一次批准 | `publish-update.yml` 用 release 自己的资产跑 `scripts/publish-update.ts --from-dir … --no-github`,生成 `latest.json` 上传 R2(`dl.tendhearth.com/wechat-cc/latest.json`;只发 darwin-aarch64 + windows-x86_64;每平台留 3 版)。老用户的 Tauri updater 从此看到新版 |

补发(某次 R2 令牌过期):Actions → `Publish Update Channel` → Run workflow,填 `desktop-vX.Y.Z`。

## 两道人工批准是有意的

签名私钥 = 让所有已安装 app 自动下载并运行任意代码的钥匙;R2 令牌 = 决定所有已安装 app 该装哪个版本。都挂在带必需审批人的 `release-signing` 环境上,每次取用留痕。**不要自动化掉。**

## 已知坑

- `wechat-cc update` **不读** `v*` tag,它比的是 `origin/<branch>`(`src/cli/update.ts`);`v*` tag 唯一的作用是被镜像成 `desktop-v*`。
- Windows 只在 CI 编译;签名与发布固定在 Mac / CI(Win32 给环境变量赋空串等于删除,tauri 签名步骤会挂死等密码)。
- `.sig` 是 minisign 签名、平台无关;曾被发版脚本的双层过滤丢掉过(2026-09-03,已修)。
- 产物名与平台映射在 `scripts/publish-update.platforms.ts`,守卫 `scripts/release-pipeline.guard.test.ts`。
- 发版 workflow 的 bun 版本与 CI 一样钉死(2026-09-27 起,`scripts/ci-workflow.guard.test.ts`);别改回 `latest`。
