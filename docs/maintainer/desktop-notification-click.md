# 桌面通知点击（S3c，随下一版桌面）

macOS 桌面使用 UserNotifications，事项 id 仅放在 `UNNotificationContent.userInfo.matterId`，不出现在通知正文。点击正文后，经原生导航 inbox 拉起或重建主窗口，打开指定事项并发送 `POST /v1/matter/seen {id, surface:'desktop'}`。多个完成事项合并通知时，打开第一个停止的事项，否则打开第一个回复的事项；待决定通知优先，打开本轮第一个有新请求的事项。其余事项不记 seen。

不带 id 或 id 格式非法的通知只拉起窗口。格式有效但事项已不存在时显示原有错误，不跳到其他事项。关闭/清除通知不算看过。应用启动时安装委托，可处理应用重启后仍在通知中心的通知；已经由旧 NSUserNotification 桥发出的历史通知仍由系统按旧机制激活应用，没有可恢复的事项 id。

未打包的 macOS 开发可执行文件保留插件的 Terminal 通知降级，不支持事项回跳；UserNotifications 要求真实 app bundle。macOS 10.13 也降级至原插件；新 framework 弱链接，原生桥仅在 10.14+ 启用。

Windows/Linux 保留 Tauri 插件的原有通知行为。该版本的桌面插件忽略 extra，未提供点击事件，因此这两平台暂不支持按通知打开事项或通知点击 seen；查看事项的现有 seen 路径仍有效。macOS 桥与编译仅在 macOS 启用。

`src/lib/desktop-notify.ts` 的 daemon 通知保持原样：AppleScript `display notification` 无 userInfo 或点击回调，notify-send / PowerShell 气泡也没有持久回跳监听器。桌面未开时不假记 seen；按设计等待用户打开事项，未看则继续升级。这一轮不增加后台监听程序或 URL scheme。

Playwright 只在 mini 离线 lab 验证通知委托输出的原生导航事件到页面/API 的链路；不声称自动点击过系统通知中心。系统授权、通知实际展示和系统点击投递仍需下一版签名桌面发布验收。
