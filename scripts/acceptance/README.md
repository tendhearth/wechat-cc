## 分享一件事

只用于合成隔离 daemon。本机假中继仅监听 `127.0.0.1`，验证 Ed25519 登录并透明转发 v2 加密帧；来客使用协议包客户端，经真实隧道到 `settingsPanel.handleRequest`，页面、状态和说话均走隧道。`.share-acceptance` 只影响本次夹具；其他场景保持原来的配置。

每次选一个全新的状态目录（以下根目录固定，后缀自行更换）：

```sh
export WECHAT_STATE_DIR=/private/tmp/claude-501/-Users-nategu-mac-company-Documents-tendhearth-wechat-cc/f71eba2a-4407-4d17-9b28-b1eb12232935/scratchpad/acc/state/share-offline-example
mkdir -p "$WECHAT_STATE_DIR"
touch "$WECHAT_STATE_DIR/.acceptance-only" "$WECHAT_STATE_DIR/.share-acceptance"
bun scripts/acceptance/share.ts offline
```

`offline` 自动启动 `run.py start-offline`，沿用其独立 HOME、网络沙盒和进程清理。网关替身拒绝所有模型请求，不读取 gateway.key。通过仅在分享夹具启用的控制路由植入两件合成事项（真实存储、不启动执行者），验证登录、开链接、页面、投影隔离、路由隔离、view 档与撤销后隧道的 auth_failed 与面板处理器的 401；退出时停止子进程。离线没有验证自然语言开链接、确认卡和 CC 回应。

需要模型的验收由主人另选全新状态目录，建立上面两个标记后运行（`start` 会按原有约定读取网关密钥）：

```sh
python3 scripts/acceptance/run.py start
# 在另一终端设置同一个 WECHAT_STATE_DIR
bun scripts/acceptance/share.ts all
python3 scripts/acceptance/run.py stop
```

也可以依次执行 `a`、`b`、`c`、`e`、`d`：a 经 operator 建事项并等执行者结束，以自然语言先拒绝再批准分享卡；b 读页面与投影；c 来客留言并等 CC 回应、检查 gateway 请求不带工具与记忆金丝雀、等主人通知；e 只看档；d 自然语言关闭链接，在已有隧道流上验证 auth_failed，再经回环控制路由调用真实面板处理器验证 HTTP 401（这一条不经过隧道）。`all` 按此顺序运行。需要模型的部分已编写，提交前不代主人跑。

证据：`share-evidence.jsonl`（断言与计数）、`share-relay.jsonl`（登录与转发计数），结合既有 `gateway.jsonl`。不输出正文、链接或令牌。`share-fixture.json` 是 a 与后续子命令间使用的私密能力文件（0600，含链接），不要复制进报告或提交；隔离数据库也含令牌。失败时只报场景名；可查看脱敏的 `daemon.log` 和 supervisor 日志定位启动问题。离线成功必须有 `cleanup.json` 的剩余进程与进程组成员均为 0。

撤销差异：产品隧道会在面板之前拒绝无效分享令牌，所以不会返回 HTTP 401。夹具没有把 auth_failed 伪装成 HTTP 响应；只在 `.share-acceptance` 下通过加载观察器取得真实面板实例，以本机控制请求补验其 401。不启动面板的 `0.0.0.0` 监听，不改写产品函数行为。
