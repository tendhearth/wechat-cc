# CC 双态动作与位置原生验收

这个独立测试应用复用当前分支的真实 companion 页面、pet 运行时和 Rust 窗口命令，用于检查 WebKit 显示、缩放、位置恢复和「找 CC」。主窗口只展示本地演示数据，不表示日常 CC 的任务状态。新增美术仍是 `production-candidate`。

测试配置、页面和生成目录都位于 art 下，正式前端入口与正式打包配置不变。暂未登记或仍在制作的帧不进入测试包，私有设计板也不进入。构建前先完成需要验收的素材登记。

从仓库根目录构建自己的低优先级测试包：

```sh
CARGO_TARGET_DIR="$PWD/.superpowers/cc-motion-native-target" \
CARGO_BUILD_JOBS=2 nice -n 20 \
  bun run --cwd apps/desktop tauri build --debug --bundles app --no-sign \
  --config art/cc-v1/native-motion-qa/tauri.qa.json
```

通过专用启动器运行刚构建的包：

```sh
node apps/desktop/scripts/launch-cc-motion-native-qa.mjs \
  "$PWD/.superpowers/cc-motion-native-target/debug/bundle/macos/Tendhearth CC Motion QA.app"
```

启动器先核对专属 identifier 与包内执行文件，再创建权限为 0700 的空目录，替换两个 daemon 凭据目录并关闭包迁移。它保留 HOME，不安装、签名、部署或启动后台。必须用完整的测试包路径启动；系统可能把执行文件显示为 Tendhearth CC。

前端 API 仅返回合成的连接、工作和权限事实；额外后台请求被拒绝。IPC 包装只转发本测试应用的窗口命令，权限按钮仅清除演示卡。这个包装不是原生命令 ACL：测试时的后台凭据隔离由启动器的空目录提供。动作偏好在测试浮窗内只保存在内存，位置偏好写在专属 QA identifier 的 app-data 下。

主窗口可读出实际尺寸、坐标和缩放。复验顺序：

1. 打开浮窗，放大、缩小，检查实际读数和位置偏好。关闭前就检查保存，避免关窗保存掩盖缩放或恢复的错误。
2. 移动或改变尺寸后，点击「回到屏幕边缘」，等命令返回，再于关窗前读取偏好。关闭、重开，核对恢复值。
3. 切换连接、工作和权限演示。它们只刷新既有 poller，不伪装文档恢复事件。检查安静期间连接与权限仍可读。
4. 在暖纸与 QA 灰板、48/96/128/256 px 检查两态；减少动作时检查静止、重播及当前事实。

2026-10-29 的本机 2× Retina 实测发现并修正了 AppKit 对小数逻辑尺寸向上取整导致确认超时的问题。修正后 240×300 → 269×336 → 240×300，操作后、关窗前的偏好与实际尺寸一致。整数尺寸的回边缘及关窗重开也已实测。实际不同 DPI 的多显示器和 Windows 仍须在对应机器验证；已有排队适配器和布局回归不能代替这些原生检查。新动作与后续视觉检查另记在本批交付报告，不能以此替代主人美术验收。

「模拟过两小时」仅在当前测试浮窗内推进 Date.now，performance.now 与系统时钟保持正常；不让电脑睡眠。先开启安静，确认回执记录 `quiet=true`、`quietPressed="true"`、`quietAction="恢复动作"`，再执行模拟。完成事件在推进前生成，两条真实 poller 随后刷新，回执应保留每次通知携带的行为快照。修复后的最终回执必须同时为 `quiet=false`、`quietPressed="false"`、`quietAction="安静一小时"` 和 `quietOffApplied=true`，且不出现补播的 done；随后选择新的「完成事件 · 演示」还应确实出现 done，证明动作恢复。重新打开浮窗会重置测试时钟。这验证实际 WebKit 中的双时钟不连续场景，不等于一次真实的操作系统休眠测试。
