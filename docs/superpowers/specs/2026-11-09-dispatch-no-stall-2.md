# 交办不中断：第二轮实测修复

用户已指定实施范围、验收与交付方式；本稿记录实施选择和安全边界。

目标：相同锁文件的任务首次安装后可复用依赖；测试不因系统 uptime 或本机回环限制重复请求批准；大输出不再误杀任务。保持 workspace-write、任务独立临时目录及 #883 准备阶段全部安全约束，不操作真实 daemon。

## 依赖

采用 stateDir 下独立快照缓存，而非仅依赖主工作区当前提交。键由排序后的相对锁文件路径与内容哈希组成，另校验清单内容与平台；同仓库其他匹配工作区作为补充来源。无锁文件不缓存。缓存是独立 COW/受预算复制，不共享可写 node_modules。

沿用原复制器的安全元数据读取、链接两端核验、分阶段发布、取消、时间/条目/实际复制字节/剩余空间预算；Windows 不假定支持 COW。缓存总量默认 4 GiB，另按逻辑文件大小计费，LRU 淘汰，写入和恢复串行；中断只清理本次拥有的临时目录。准备阶段不执行仓库代码。快照通过重定位复制形成，不保存指向发布任务的链接；workspace / .bin 指向普通工作区文件时只保留空的逻辑端点，恢复时仍使用并核验新 checkout 的实际文件，不从缓存覆盖源码；发布前后复核锁文件和清单。保留安装来源与任务目录隔离。

执行者确认安静或退出、已批准的 setup 成功后，尽力发布安装快照；不确定仍有写入者时不发布。失败不影响任务结果。原项目匹配时保留 #883 直接复制快路，否则查询缓存和同仓库工作区；其他工作区仅作当前任务的复制源，不推断其安装已完成或直接入缓存，最终才提示锁定安装。

## 任务内 uptime

根因是 Seatbelt 默认拒绝的 sysctl 白名单没有 `kern.boottime`，而 libuv Darwin 的 `uv_uptime` 正好读取它。本仓库唯一直接调用是 `writer-exit.ts` 的系统开机时间核对；锁定 Vitest 4.1.10 不依赖 tinypool，扫描 Vitest/Vite/tinybench 未发现 uptime 调用。没有原始失败栈，不能断言实测具体测试调用链。[Codex 基础策略](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl#L23)、[libuv 调用](https://github.com/libuv/libuv/blob/v1.51.0/src/unix/darwin.c#L167)。

CC 生成固定任务 preload，仅 `uv_uptime` 的 EPERM/EACCES（包含 Node `ERR_SYSTEM_ERROR.info`）回落；其余异常原样抛出。真实沙箱发现 Bun 1.3.14 会返回 0，因此也处理该无效结果。正常 uptime 保持原值。父进程提供系统开机基线，子进程按单调时钟推进，不用进程存活时间代替系统开机时间。同步 builtin ESM 命名导出。

Bun 1.3.14 实测忽略环境里的预加载参数，故任务 PATH 里生成固定 Node/Bun shim，显式附加 `--require`，Node 同时保留 NODE_OPTIONS。任务 preload 将当前运行时的直接 child_process / Bun.spawn 子进程附加同一预加载，覆盖 `process.execPath` 路径。帮助文件只在任务保留目录里，升级后原子更新独立 inode，拒绝链接；不会修改全局环境、系统权限或 daemon 的 os 模块。任意显式清空环境、另一个绝对运行时、手写绝对 shell 命令属于执行者自身选择，不将字符串 shell 改写成另一套命令。

## 本机回环

核对版本是 **Codex rust-v0.167.0 / 086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a**。SandboxPolicy 只有网络布尔值，没有独立的回环字段；但 managed network proxy 支持 `allow_local_binding`，Seatbelt 将直接网络限制在代理端点与 localhost。采用此原生能力，不实现沙箱外测试命令代理。单凭命令白名单不能约束测试代码权限；改用 Unix socket 也不能覆盖现有任意 HTTP/WS 测试。

启动先用原有离线配置探明版本，只有精确 0.167.0 才关闭探针、重启增强配置，避免旧版无法解析 feature table。增强启动仍 `network_access=false`。配置：network_proxy.enabled / allow_local_binding=true；mode=full；upstream proxy、SOCKS/UDP、非回环代理、任意 Unix socket、credential broker 全关。domains 的 `?*` 明确 deny 所有非空主机：裸 `*` 被原生 denylist 拒绝，`?*` 根据官方 matcher 的 `?` 单字节加 `*` 任意后缀语义匹配所有非空主机；明确 deny 在 DNS、allow 与策略 decider 之前生效。该通配符结论是对以下源码的推导。

启动 `config/read` 必须逐项验证 table；`experimentalFeature/list` 验证有效 feature，`configRequirements/read` 拒绝影响网络/权限 profile 选择的 managed 覆盖。继承的 Unix socket allow 也拒绝，空 table 合并不能清除它们。然后 thread/start/resume 镜像配置并覆盖 `network_access=true`，核对线程 sandbox 与可写根，首次 turn 前再次核对线程有效 feature。任何核对失败都不开 turn。线程初始化先成功启动代理才发已配置事件，代理失败不会退回开放网络。旧/未知版本继续离线，不猜测兼容性。

[原生代理会为本机绑定模式设置 NO_PROXY](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/network-proxy/src/proxy.rs#L819)，使本机 HTTP 请求直连；代理绕过名单不会增加 OS 权限。

原生能力允许**本机全部回环端口**，没有任务专属 TCP 端口选项；因而本地已有服务也在可达范围内。外部域名/IP 的代理访问明确拒绝，直接外部 TCP/UDP 仍由原生 OS 策略拒绝。Unix socket 不新增授权。此前已有的用户 execpolicy 前缀放行能够让原生 Codex 绕过沙箱，是原生原有边界，本次不增加任何该类规则。

官方依据：

- [SandboxPolicy 类型](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server-protocol/schema/typescript/v2/SandboxPolicy.ts)、[回环 Seatbelt 规则](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/sandboxing/src/seatbelt.rs#L328)。
- [denylist 通配符校验](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/network-proxy/src/policy.rs#L122)、[matcher](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/network-proxy/src/domain_matcher.rs#L162)、[deny 优先](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/network-proxy/src/runtime.rs#L883)。
- [请求配置覆盖启动配置](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/config_manager.rs#L704)、[线程先启动代理](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/core/src/session/session.rs#L1624)。
- [有效 feature 查询](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/request_processors/catalog_processor.rs#L358)、[原生网络回归](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/sandboxing/src/seatbelt_network_tests.rs#L18)。

## 协议缓冲

保留现有结构消息上限。归属/起点未核验阶段立即丢弃明确允许列表中的通知型预览增量，累计达到原上限再记录一次降级，完成条目重建最终结果；审批请求、归属、生命周期与结束消息始终保留。压缩仅记一条不含正文/线程标识的系统事件，不产生终止性错误；仅结构消息自身超限才失败。归属核验不因输出到达而放宽。JSONL 按单帧限制，完整多帧突发不按总 chunk 大小误杀；未结束单帧超限仍拒绝。

## 验证与评审重点

四条分别留红/绿；大输出覆盖父轮确认前和子线程核验前。缓存覆盖源工作区删除、嵌套锁/清单变化、链接逃逸、LRU/容量、取消与受限复制。环境覆盖 Node/Bun 子进程继承和 ESM 命名导出。相关 Bun 与 Node 测试，随后在无游戏且负载低于 8 时运行 bun run verify。无 UI 改动，不使用 mini；不 push。
