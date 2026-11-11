# Codex 连接确认

CC 安装用户级 `hooks.json`，只读 Codex 的信任记录，不代用户确认。用户在 Codex 输入 `/hooks`，审阅并信任 wechat-cc。Claude Code 维持现状。

检测入口共用 `src/cli/terminal-hooks.ts`：CLI status、doctor、daemon 能力表。接线健康与信任分开；Codex 的三态是 `untrusted`、`trusted`、`changed`。连接区未确认/变更时显示具体下一步，无重装按钮。App 与桌面打开连接区时每 30 秒重读；Codex 确认后自动恢复。

## 对应源码

仓库锁定 `@openai/codex@0.144.4`，本批用户 Codex 为 0.167.0。信任来自 `$CODEX_HOME/config.toml` 的 `hooks.state`：key 是 `<hooks.json绝对路径>:<snake_case事件>:<groupIndex>:<handlerIndex>`；值含 `trusted_hash`、可选 `enabled`。

显式非空 `CODEX_HOME` 按 Codex 的 home-dir 实现先解析为绝对目录并 canonicalize，再拼接 `hooks.json`。默认 `~/.codex`（含空环境变量）不 canonicalize；`hooks.json` 文件本身是符号链接也不解析到目标文件名。目录不存在时安装器仍可创建，检测不能凭不存在目录确认信任。

哈希为规范化 handler、matcher、event 转 TOML value，再转递归排序的紧凑 JSON，计算 SHA256，前缀 `sha256:`。JSON 排版与顶层 description 不参与；路径与数组位置进入 key。命令字符串、timeout、async、statusMessage 等进入哈希。普通用户定义不摘要所执行的二进制内容，固定命令路径下 CC 升级不应触发确认。

- [官方信任说明](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)
- [0.167.0 发现、归一化与信任](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/engine/discovery.rs)
- [0.167.0 哈希算法](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/config/src/fingerprint.rs#L54)
- [0.167.0 CODEX_HOME 解析](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/utils/home-dir/src/lib.rs#L13-L61)
- [0.144.4 发现逻辑](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/hooks/src/engine/discovery.rs#L469)

0.144.4 跳过 async，尚无 SessionEnd；仅要求该版本实际发现的 SessionStart、PermissionRequest 两条。0.167.0 要求五条；SessionEnd timeout 规范化到 1–3 秒，其余默认600、最小1。版本探针使用异步 `--version`，三秒超时、64KiB 输出上限、缓存五分钟（失败也缓存），最多一个在途探针。状态读取只取缓存并发起后台刷新，冷缓存或更换二进制时先按未知版本处理；刷新期间不阻塞开工回应。未知版本不猜新哈希规则。

短命的 `hook status` / `hook install` 等待一次有界异步版本探针后输出完整快照；doctor 复用本轮已经探到的版本。daemon 能力轮询不等待探针，避免每个新 CLI 进程因冷缓存一直误报待确认。

配置读不到或版本未知时保留待确认。HTTP 请求的 source、machine 及 daemon 缓存版本不能证明实际加载的定义、数组位置或进程版本，不能给旧调用盖上当前磁盘身份重新授信；单加观测时间也无法证明确认发生在失效之后。旧 `codex-hook-evidence.json` 只用于提示定义/版本已变化，永不提升为 trusted。运行期三个入口不再读取定义或写调用旁证；安装器仍在非热路径保存定义失效标记。只有可读取的已知版本配置完全匹配当前定义和位置时显示 trusted，明确禁用优先。

范围是默认用户 profile。用户另传 `--profile`、session flags、企业 `requirements.toml` 的 managed-only 等策略不能从此文件完整推断。Codex 升级可能改变事件或归一化，版本号本身不参与摘要。

## 稳定约定

Codex 定义使用独立的固定字面量，不能随品牌文案、Claude 超时或版本号改变。守卫固定五条完整 JSON 与命令形状；重复安装保留既有分组位置。将来确需改动时，安装返回 `reconfirmationRequired`、CLI 明说“Codex 需要重新确认一次”，能力表按当前定义与记录显示重新确认。不得写 `trusted_hash` 或使用跳过信任参数。

Cursor 只调研：[官方 Hooks 文档](https://cursor.com/docs/hooks) 描述保存后自动重载；项目定义要求 workspace trusted。未发现 Codex 式逐定义哈希确认文档，不能据此断言内部绝无其它机制；本批不修改 Cursor。
