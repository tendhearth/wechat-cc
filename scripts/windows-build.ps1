# windows-build.ps1 — Windows 端一键构建 + 发布(2026-08-26)
#
# 用法(PowerShell,普通权限即可;首次跑会装依赖,约 10-20 分钟):
#   powershell -ExecutionPolicy Bypass -File scripts\windows-build.ps1
#
# 前置(两个机密文件,从 Mac 安全拷贝过来):
#   $env:USERPROFILE\.tauri\wechat-cc-updater.key   ← 更新签名私钥(同一把)
#   $env:USERPROFILE\Desktop\cloudflare_key.txt     ← CF token(发布用;没有则只构建不发布)
#
# 产出:NSIS 安装器 + updater 签名包;有 CF token 时自动把 windows-x86_64
# 合并进 https://dl.tendhearth.com/wechat-cc/latest.json(保留 mac 条目)。

$ErrorActionPreference = "Stop"

function Ensure-Tool($name, $wingetId) {
  if (Get-Command $name -ErrorAction SilentlyContinue) { Write-Host "✓ $name 已安装"; return }
  Write-Host "… 安装 $name ($wingetId)"
  winget install --id $wingetId -e --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# 1. 依赖:git / bun / rust(MSVC 工具链会由 rustup 提示安装 VS BuildTools)
Ensure-Tool git Git.Git
Ensure-Tool bun Oven-sh.Bun
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Write-Host "… 安装 Rust(rustup,MSVC 默认)"
  winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
  rustup default stable-msvc
}
# WebView2 运行时:Win11 自带;Win10 若缺,NSIS 安装器会替最终用户装,构建机不需要

# 2. 代码:优先用当前目录(脚本随仓库走);否则克隆
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not (Test-Path (Join-Path $repo "package.json"))) {
  throw "请在 wechat-cc 仓库内运行本脚本(scripts\windows-build.ps1)"
}
Set-Location $repo
bun install

# 3. 构建(带 updater 签名)
$keyPath = Join-Path $env:USERPROFILE ".tauri\wechat-cc-updater.key"
if (-not (Test-Path $keyPath)) { throw "缺少签名私钥:$keyPath(从 Mac 拷贝 ~/.tauri/wechat-cc-updater.key)" }
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
Set-Location (Join-Path $repo "apps\desktop")
bun install
bunx tauri build --bundles nsis

# 4. 发布(合并进 latest.json;无 token 自动降级为本地暂存)
Set-Location $repo
bun scripts/publish-update.ts --notes "Windows 版上线(含悬浮窗卡死修复)"

Write-Host ""
Write-Host "完成。顺手验证:双击安装器装上后,试一下「浮到桌面」(悬浮窗死锁修复)。"
