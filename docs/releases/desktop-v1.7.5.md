# Tendhearth CC desktop v1.7.5

**Date**: 2026-10-05
**Tag**: `desktop-v1.7.5`(配套 CLI 同号)
**Scope**: macOS 上 app 改名为 **Tendhearth CC**(安装位置与进程名);桌面阅读字体改版;工作台产物可直接预览 HTML / PDF / 整个网站。

---

## macOS:app 改名为 Tendhearth CC

- 安装位置从 `/Applications/wechat-cc.app` 变成 `/Applications/Tendhearth CC.app`,活动监视器里的进程叫 `Tendhearth CC` / `tendhearth-cc-cli`。
- **自动更新会自己改名**:更新后第一次启动时,app 在原地改名(程序坞图标、别名跟着走),修好后台服务与终端 hook,再重启一次 —— 大概离线不到 1 分钟。
- 不变:bundle ID、系统授权(完全磁盘访问、麦克风等不用重给)、配置与数据目录、命令行 `wechat-cc`(新增固定入口 `~/.local/bin/wechat-cc`,app 以后再改名也不受影响)。
- 没有管理员权限、改不了 `/Applications` 的用户:保持原文件夹名,里面的程序与后台服务照样更新。
- Windows / Linux 不变。

## 桌面字体与阅读

按主人 10-04 的确认:界面字号调小,中文用苹方;英文界面与回复对齐 Claude 桌面(本机装了 Claude 时引用其字体,不打包,缺失时回退系统字体)。侧栏品牌字保留衬线。

## 产物预览

工作台里的 HTML、PDF、整个网站(多文件)可以在桌面直接打开预览。预览在沙箱里运行,拿不到 app 与 daemon 的任何权限;PDF 用打包的 pdf.js 6.3.289。

## 升级须知

无数据库迁移。更新后 app 会自动改名并重启一次。
