# CC 自有测试沙箱：设计与安全分析

状态：设计稿，未接产品、未启用新权限。日期：2026-11-09。

负责人：Codex；工作区 `wt-test-sandbox-design`；分支 `test-sandbox-design`；基线 `02d03029fac072eeb2d331aae6def4821cfb7a55`（#891）。只在此工作区提交，不 push，不合入、不部署。本文的「应当」均是待实现、待独立安全审查的要求。

## 1. 结论与目的

让执行者能完成项目检查，主人不必每次批准「把任务代码放到全部主人权限下运行」。登记为测试的命令仍能运行任意恶意代码；安全来自运行边界，不能来自 `verify` 这个名字。

**推荐 (a)：CC 提供受控的「运行项目检查」工具，执行者继续断网，CC 在另一棵受限进程树中代跑检查并回传结果。免审批的必要条件是测试网络与宿主隔离。** Linux 优先独立 network namespace；macOS/Windows 研究没有宿主网络桥的专用 guest。这个架构先定，后端是否可用逐平台验收。

**本次真实 Seatbelt 原型证明了四项基础能力，但没有证明可上线的严格「仅回环沙箱」。** 自身 IPv4/IPv6 TCP 通信成功，伪造凭据拒读，直接外网连接被拒，工作区外写入被拒；同时证实：

1. 沙箱可以连接本原型创建的另一个宿主回环服务。该服务可代表本机代理、调试器或管理服务；拒读 token 不会消除这个面。
2. 本机 SBPL 解析器不接受数字主机 `127.0.0.1`/`::1`，只接受 `localhost`/`*`；使用 `localhost` 的候选规则仍允许 `bind + listen` 在 `0.0.0.0` 和 `::` 上成功。**严格的「只许 bind 两个回环地址」未成立。** 没有测试外部客户端是否能连入，不能把 wildcard bind 成功直接等同 LAN 已经能传数据。

因此本稿**不建议上线「主人 UID + 全宿主回环 connect + 凭据黑名单」作为默认免审批后端**。仅 (a) 的工具入口并不会修好网络边界。在私有网络后端验收前，需 listener 的检查继续现有显式审批；不能悄悄降为全权限执行。`sandbox-exec` 可继续作为研究和 guest 内纵深防御，不将本原型当生产策略模板。

前置依据：[上一轮设计](2026-11-09-dispatch-no-stall-2.md)、[维护手册](../../maintainer/README.md)、[鉴权现状](../../reference/internal-api-auth.md)。后者有历史描述；路由判断以下文基线源码为准。

## 2. 威胁模型与读写策略

攻击者控制任务工作区、package scripts、测试、依赖中的代码、子进程、输出，以及调用工具时提交的参数。全部视为不可信。宿主 runner、策略生成器、检查登记表和预装工具链属于可信计算基；不能从工作区 import/require 任何模块到 CC 宿主进程。防止任务读取主人秘密、借本机服务执行管理操作或转发外网、修改任务范围以外文件，并限制资源耗尽。内核/虚拟化逃逸、已接管宿主的其他恶意进程不在本轮保证内。

### 2.1 白名单读为主，显式 deny 为防回归

用 `(deny default)`，只开放任务工作区、隔离的任务 tmp/cache、固定只读 runner/preload、精确工具链和确有需要的系统运行库。先 canonicalize 并锚定路径与目录身份，再生成策略；拒绝链接改指、路径替换、SBPL 注入、嵌套敏感目录等冲突。祖先只给遍历所需的 metadata；不要为解决启动失败而开放整个 HOME、`/private/var`、`/Library`、`/opt/homebrew` 或根目录递归可读。本原型的根目录 `literal "/"` 是单个目录，不是 `subpath "/"`。

**全盘可读再列黑名单不作为安全边界。** 新凭据目录、另一个浏览器、私有项目、环境变量及用户自定义配置永远列不完；0600/0700 与同 UID 无法隔离。白名单也不是秘密检测器：任务树内若本来已有 `.env`、私钥、生产库或敏感 hardlink，开放树就可能泄露。准备阶段只能传入已确认无秘密的任务副本和已验证依赖；不读真实凭据来「检测」，不复制主人 HOME 或生产状态目录。现有工作区身份与 [文件锚定威胁模型](../../reference/workbench-file-guard.md) 的边界继续适用。

以下是**生产设计应显式拒读、拒执行映射、拒写**的至少清单，用作白名单误扩时的纵深防御；不是声称本次访问过这些真实位置。路径从可信宿主提供，不从任务的 HOME 推导。拒绝整个文件/目录，不能只隐藏一个已知 token 文件。

| 敏感位置/能力 | 原因及处理 |
| --- | --- |
| `~/.claude/channels/wechat`、所有自定义 stateDir、其父级的快照/备份、任务外 CC runtime | operator/file/session discovery、微信登录、生产库、记忆和旧备份；任务 runner 不挂载、不继承 |
| `~/.claude`、`~/.codex`、`~/.gemini`、`~/.cursor`、`~/.config` 中其他 agent/provider 配置 | 模型登录、MCP 凭据、会话历史；仅另建空 HOME/XDG，不能把宿主 app-server 的登录带给测试 |
| `~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.azure`、`~/.kube`、`~/.docker`、`~/.config/gcloud`、`~/.config/gh`、`~/.config/git` | 云、Git、集群、容器身份，含凭据代理端点 |
| `~/.npmrc`、`~/.netrc`、`~/.gitconfig`、`~/.git-credentials`、`~/.bunfig.toml`、`~/.pypirc`、包管理器认证文件 | token、代理配置、credential helper、include/includeIf、可执行 hooks/filter。整份用户 Git 配置拒读；无法在文件读取层仅隐藏其中的 helper 字段 |
| `~/Library/Keychains`、`/Library/Keychains`、其他钥匙串持久位置 | 私钥及密码库；仅拒文件仍不够。默认拒 Mach/XPC `com.apple.SecurityServer` 等钥匙串能力，不运行 `/usr/bin/security`/osascript/open/LaunchServices 作为宿主 helper；二进制黑名单不能替代 IPC 拒绝 |
| `~/Library/Application Support/{Google/Chrome,Chromium,Microsoft Edge,Firefox,BraveSoftware,Arc}`、`~/Library/Safari`、Safari/其他浏览器容器及 Group Containers | cookie、登录、扩展、历史；不开放整个 Application Support/Containers/Group Containers；自定义浏览器 profile 同样在白名单之外 |
| `~/Library/Accounts`、Mail/Messages、系统账号与 app 登录容器、其他私人文件、其他项目 | 不是运行离线项目检查的输入，保持默认拒绝 |
| SSH/GPG agent、Docker/Podman、DBus、launchd、其他 Unix socket/命名管道、Mach 服务、共享内存 | 即使没有落盘凭据也可能是主人权限代理；默认不开放，IPC 与文件网络分别设门 |

清空继承环境，只传固定 PATH、虚拟 HOME/XDG、任务 TMP/TEMP/cache、必要 locale 与明确的测试参数。去掉 session/operator/API token、SSH_AUTH_SOCK、GPG_AGENT_INFO、代理、用户 NODE_OPTIONS/BUN_OPTIONS、DYLD_*、Git/包管理器发现变量；Git 使用空全局/系统配置且禁 hooks/filter/fsmonitor/credential helpers。测试若需要提交信息或 Git 元数据，用隔离的最小副本，不开放 worktree `.git` 指向的主人 common-dir。不能原样复用 CI 环境。

启动时关闭所有额外继承 FD/句柄，stdin 用空管道，stdout/stderr 只通向有界结果收集器；不得继承已连接 socket、生产库 FD、目录 FD、Mach send rights 或 runner 控制通道。文件 ACL/profile 无法追溯收回已经传入的能力。宿主结果收集不执行输出中的命令，不跟随成果中的链接，不因测试产物请求安装/提权。

写入只有任务工作区 + 任务 tmp/cache（允许 `/dev/null` 等经审查的固定设备例外）。缓存只在本任务可写；不能写共享依赖缓存、固定 preload 或登记表。共享依赖继续遵守 #891 的可信安装边界。符号链接、hardlink、rename、目录替换、已有 inode 别名均需独立负测；本次只覆盖下文列出的链接形状。

`kern.boottime` 保持拒绝，沿用 #891 的宿主开机基线 + 单调时钟 uptime 兜底及只读 bundle，处理 Node EPERM/EACCES 与 Bun 返回 0。无需为此开放泛 sysctl。该 shim 只修运行时兼容，不能当沙箱检测或安全证明。

### 2.2 Seatbelt 候选的适用范围

主 Mac 只做临时目录的 CLI 能力原型，没有跑项目 UI/构建，没有读真实凭据或调用真实 daemon。下面是已执行候选的**网络部分**，不是可发布 profile：

```scheme
(version 1)
(deny default)
; 文件/进程/少量 sysctl 的完整规则由附录脚本生成。
(allow network-bind network-inbound (local tcp "localhost:*"))
(allow network-outbound (remote tcp "localhost:*"))
```

只开 TCP，UDP/DNS/raw socket、Unix socket、Mach lookup 未加 allow。不要复制 Codex 的整份网络策略：其中包含证书、系统网络与 Mach helper 的额外权限。外网验证使用文档保留地址的数值 socket，未作 DNS、未发送 HTTP 内容，结果必须为 EPERM/EACCES，超时/无路由/连接拒绝不能算沙箱拦截。

本机 `localhost` 同时使 `127.0.0.1` 和 `::1` 通信可用，`127.0.0.2` 自身通信被拒；但不据此推导所有映射地址、所有协议或入站行为均安全。[Anthropic 的固定版本实现注释](https://github.com/anthropics/sandbox-runtime/blob/3a2954dc8ab938877fe4e279f04dfe4dd18ab40d/src/sandbox/macos-sandbox-utils.ts#L1262)也记录了 localhost 对 wildcard bind 的覆盖，这只是另一实现的一手说明，安全结论以本次实测为准。Apple 明确指出自定义 SBPL 缺乏第三方支持；需固定受测 OS 版本、持续做负测，解析失败必须停止（[Apple DTS](https://developer.apple.com/forums/thread/661939)）。

## 3. 真实 sandbox-exec 原型与结果

环境：2026-11-09 23:47 UTC，macOS 27.2 build 26B123、Darwin 27.2.0、arm64；Homebrew Python 3.15.2。`/usr/bin/sandbox-exec` 直接运行 Python 的 TCP/socket、文件和子进程探针。父进程仅创建伪造 HOME、自己的临时文件与回环服务；没有扫描端口，没有探测 daemon。

证据目录：`/private/tmp/cc-test-sandbox-design.dw9bqj`。内有 `probe.py`、五份 `.sb`、`results.json`、`observations.json` 及自有 fixtures；所有 listener 在进程退出时关闭。可复跑源代码完整收于附录，不依赖上述临时目录保留。

| 探针 | 完整候选实际结果 | 含义 |
| --- | --- | --- |
| a：进程内 `127.0.0.1:0` bind/listen/connect/accept/双向收发 | 成功 | IPv4 测试回环可用 |
| a：同样的 `::1:0` | 成功 | IPv6 测试回环可用 |
| b：假 HOME 下 `.claude/channels/wechat/operator-token` 及表中另 12 个敏感目录的 `secret` | 全部 EPERM=1 | 显式 deny 生效；只读假文件 |
| b：工作区 symlink → 假 token；exec 后代读取假 token | EPERM；后代 PermissionError | 两种已测访问形状也拒绝 |
| c：`192.0.2.1:9`、`[2001:db8::1]:9` 直接 connect | 全部 EPERM=1 | 直接 IPv4/IPv6 非回环连接被策略阻止 |
| d：工作区/任务 tmp/cache 写入 | 成功 | 正向写根可用 |
| d：临时根外侧的 sibling 文件、工作区 symlink → 该 sibling | 全部 EPERM=1；原值未变 | 写工作区外受限 |
| 创建 hardlink：假 token → 工作区 | EPERM=1 | 本次创建链接被拒；不证明预存 hardlink 一律安全 |
| `kern.boottime` | EPERM=1 | 保留 uptime 兜底前提；未重跑 #891 shim 回归 |
| 连接父进程自建宿主服务 | **成功** | **残余风险确认**，不是隔离成功 |
| `0.0.0.0:0`、`[::]:0` bind + listen | **成功** | **严格 bind 边界失败**；未作 LAN 入站测试 |

对照组也通过预期：

| 变体 | 自身 v4/v6 回环 | 宿主 fixture | 假 token |
| --- | --- | --- | --- |
| full | 成功 | 成功（风险） | 拒绝 |
| no-network-control：移除网络 allow | EPERM | EPERM | 拒绝 |
| no-deny-control：保留仅用于实验的假 HOME allow，撤显式 deny | 成功 | 成功（风险） | 可读（仅伪造数据） |
| bind-only-control：开放 bind/inbound，去掉 outbound | EPERM | EPERM | 拒绝 |
| fixed-host-port-control：outbound 只给 fixture 的固定端口 | EPERM | 成功（已指定的宿主端口） | 拒绝 |

`no-deny-control` 故意用可读的假 HOME 制造 allow/deny 重叠，证明拒读不是文件不存在；**生产不允许 HOME 整树读取**。固定端口变体证明静态端点能筛选端口，也证明「指定端口」不等于「当前任务自己的服务」。bind-only 不能满足常见 client/server 测试。

初始负证据保留在结论中：数字主机 profile 编译失败，提示 `host must be * or localhost in network address`；启动只给 `/` metadata 的极小策略曾使解释器退出，补 `literal "/"` 读与精确运行库祖先遍历后才启动；第一次严格断言 wildcard bind 应被拒时断言失败。最终脚本把两个已知缺口明确列在 `known_limitations`，不会把它们算成安全通过。

最终原型退出 0 表示「观察符合上述表格」，**不是上线安全门绿**。

```text
probe.py SHA256   390379f597daad5df416ece26e7009d8bfaff4ff6f7c8d277d22b147b8bcd19a
results.json     05a7267888036c8b6ee55bb4cab809a9ed6600da9168a02d468ac19194616998
host_fixture_hits = 3（full、no-deny、fixed-host-port）
```

## 4. 回环可达性的残余风险

### 4.1 CC 基线源码：没有匿名批准路由，但匿名不是零副作用

以下只读源码结论固定在 `02d03029f`；路径行号供实施审查复核，未向真实服务发请求。

| 监听/入口 | 没有 token 的行为 | 依据 |
| --- | --- | --- |
| internal API，`127.0.0.1:0` | 任意路径 `OPTIONS` 返回 204+CORS；其他方法先做 bearer registry 认证，失败 401，包括 `GET /v1/health`。没有匿名 health/ping/批准例外 | `src/daemon/internal-api/index.ts:427–457,577–584`；负测 `src/daemon/internal-api.test.ts:116–121` |
| 手机面板，监听 `0.0.0.0`，故回环也可达 | icon/manifest/service worker 静态资源匿名；无有效 token 的 `/m` 返回 bootstrap 页；`/set` 是 401 过期页；其他受保护路径 401 | `src/features/phone/settings-panel.ts:594–603,770–808` |
| 可选 A2A | `GET /.well-known/agent.json` 匿名公开产品/版本/能力；无 bearer 的请求仍会被解析并记录认证失败事件 | `src/adapters/a2a/a2a-server.ts:166–241,328–342,382–403` |
| 可选 Yi WS | 未认证时可 upgrade 和解析初始化协议，10 秒内需 handId/authToken，否则断开；认证前不 attach hub | `src/daemon/yi-ws-server.ts:35–75` |

`POST /a2a/pair` 无 bearer，但需要另一枚 24 随机字节、单次、10 分钟的 invitation secret，验证消费后才登记，不是匿名提权口（`a2a-server.ts:430–454`、`bootstrap/wire-a2a-server.ts:107–142`、`src/lib/a2a-pairing.ts:60–64,93–112`）。手机配对同样在 token 门后。

匿名请求仍触及 HTTP/WS 解析器、连接槽、内存/CPU；internal 401 会记日志。A2A 的认证失败回调会执行 `a2aEventsStore.append`（`src/daemon/bootstrap/wire-a2a-server.ts:144–153`），**可造成生产事件写入与磁盘消耗**。不能根据「没有无 token 管理路由」断言无影响；新路由还会改变结论。

更根本的局限：**本设计只保护测试 runner。现有执行者的 stock workspace-write 广泛可读问题没有在本次被修复。** 它仍可能读出凭据后把字节写进工作区，再让能访问宿主回环的 runner 使用；同 UID 也不能靠「不复制已知 token」排除该链。拒读必须覆盖整个可协作的不可信执行链，或用私有测试网络让 runner 无法接触宿主管理面。设计建议的私有网络不依赖测试工作区里绝无 token 才成立。

### 4.2 其他服务与缓解比较

其他本机服务可能无鉴权：HTTP/SOCKS 代理、开发服务器、调试端口、数据库、容器控制面、浏览器 remote debugging，或者带 SSRF/任意文件读/执行能力的接口。它们可代测试访问外网或主人文件。**直接外网 EPERM 不能证明无外泄。** CORS 管浏览器，不约束 native socket；随机端口、隐藏 discovery、任务端口约定、NO_PROXY、只拒 CC 当前端口都不能构成隔离。

| 缓解 | 评估 |
| --- | --- |
| daemon 按执行者进程树拒绝 | 当前 node:http TCP 入口没有可信 peer PID/audit token。HTTP 自报 PID、端口反查+PPID 轮询会受 PID 复用、进程重挂、代理和 FD 转交影响。不得据此上线。macOS `LOCAL_PEERPID/LOCAL_PEERTOKEN` 属于 local-domain socket（[XNU](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/un.h#L81)）；若改 UDS 加内核身份和持久谱系，可作另案纵深防御，但仍保护不了其他宿主服务 |
| 只允许 bind，不允许 outbound connect | 本次对照确认连自己的 client 也 EPERM；不能跑通普通 HTTP/中继测试。仅服务端与宿主外置客户端也会新增控制面、需要另行审查 |
| 固定端口白名单 | Seatbelt 能筛静态 localhost remote 端口，本次已验证；不能表达 peer listener 属于同一任务。`listen(0)` 端口事前未知，先放开再收紧有竞态。预约端口、继承 socket/代理需解决复用、抢占、取消和 FD 能力，不作为本稿已解决方案 |
| 同一 sandbox/同进程树 socket 所有权 | 没有找到 Seatbelt 能表达这种关联的受支持接口；不能把用于 signal 的 `target same-sandbox` 推导成 TCP peer 过滤。不声称已数学证明所有私有 SBPL 表达均不可能 |
| 专用 OS UID | 可使文件凭据不可读，但仍共享宿主网络；需配套防火墙/能力隔离，单独不够 |
| Linux 私有 netns / 独立 guest | 从拓扑隔离宿主 loopback；推荐作为免审批条件。guest 内仍可加 Seatbelt/ACL，拒任何宿主 socket/代理/文件服务桥接 |
| 系统扩展/Network Extension 按可信进程身份过滤 | 可另做研究，但涉及系统授权、签名、全机网络影响与版本维护，不纳入此次小型测试 runner 设计，更不能本次改主机策略 |

macOS 没有这里可直接借用的 Linux `unshare --net`。可研究无 NIC 的 Linux guest 跑可移植检查；需 Darwin 行为的检查则需独立 macOS guest/专用隔离环境，不能把 Linux 结果标成 macOS 通过。Virtualization 网络设备支持 NAT/bridge 等宿主通路，均不满足本目标（[Apple 网络设备说明](https://developer.apple.com/documentation/virtualization/network)）。本次没有建 VM、没有测 guest；这是待验证后端，不承诺立即消除 macOS 验证审批。

## 5. 谁触发、怎么回传、需要批几次

### 5.1 三种入口比较

| 方案 | 能做什么 | 结论 |
| --- | --- | --- |
| (a) CC 受控检查工具 | app-server/执行者向宿主请求一个 check ID；宿主独立启动 runner，回传有界结果；不用任务自行换 profile | **推荐入口**。隔离可独立审查，跨执行者可复用；后端仍必须满足第 4 节 |
| (b) 启动 app-server 时替换 workspace-write | 0.167 可选自定义命名权限 profile，FS 支持 deny；不能传任意 SBPL，也没有所需私有回环策略 | 不满足整套要求；可以另案收紧执行者读权限，不能仅开 local-binding 就宣称解决 |
| (c) 外层 sandbox-exec 包住整个 app-server / 用 ExternalSandbox | 父策略会约束后代，但同时约束模型网络、登录、会话与 MCP；子策略不能放宽父层 | 不推荐。为宿主职责重新开放的凭据/网络又会被测试继承。ExternalSandbox 只是声明外部已有边界，不会替你造边界 |

### 5.2 Codex 0.167 源码依据

查的是官方 tag `rust-v0.167.0`，不是凭现有安装推断。已有本地源码 `codex-rust-v0.167.0`，将 Cargo、seatbelt、permissions_toml、thread 四文件与官方 raw tag 逐字节比对一致；Cargo workspace version 在第 173 行为 `0.167.0`。`seatbelt.rs` SHA256 为 `ebd230e96ce456d95466406137995dc055cc8116ec32879b3ff4e8ddff5c65a3`。官方现行 [app-server](https://learn.chatgpt.com/docs/app-server) 与 [security](https://learn.chatgpt.com/docs/security) 文档作为产品语境，版本能力以下表源码为准。

| 问题 | 固定版本出处与答案 |
| --- | --- |
| 可否自定义权限？ | [permissions_toml.rs:111](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/config/src/permissions_toml.rs#L111)：命名 profile 有 extends/workspace_roots/filesystem/network，无 SBPL 字符串/路径；[permissions.rs:81](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/protocol/src/permissions.rs#L81)：网络 Restricted/Enabled，文件 Read/Write/Deny。**有 deny-read，不等于有任意 Seatbelt 注入** |
| app-server 是否接线？ | [thread.rs:93](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L93)：start 的实验 `permissions: Option<String>` 是 profile ID，与 sandbox 互斥；resume 第 403–408 行同样支持；[thread_processor.rs:1780](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server/src/request_processors/thread_processor.rs#L1780) 映射到 `default_permissions` |
| 底层能否直接传 profile？ | [seatbelt.rs:855](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/sandboxing/src/seatbelt.rs#L855) 接收结构化策略，程序拼接 `sandbox-exec -p`；:980–1066 编译 FS 白名单和 deny。没有给调用方一个任意 `.sbpl` 参数 |
| local-binding 能否直接借用？ | [seatbelt.rs:330](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/sandboxing/src/seatbelt.rs#L330)：允许 bind `*:*`，inbound/outbound `localhost:*`；可额外给 proxy 固定端口；[配置说明:328](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/config/src/permissions_toml.rs#L328) 明确允许直接 host-loopback connections。域名代理规则不覆盖这条直接 socket 豁免 |
| legacy 参数呢？ | [protocol.rs:1232](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/protocol/src/protocol.rs#L1232)：WorkspaceWrite 的 network_access 是 bool；ExternalSandbox 声明外部已隔离。[CLI:49](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/cli/src/lib.rs#L49) 的 permission-profile 与 TOML profile 也都不是 SBPL 路径；debug sandbox 仍走内置生成器 |

执行者已经处于 Codex 沙箱时不能自行解除父策略、也不能自行取得 CC 的宿主权限。将 `sandbox-exec` 加到 shell 命令里不会获得父层拒绝的网络能力；不能教执行者通过提权绕过这一点。

### 5.3 推荐工具的最小协议与可信边界

概念工具 `run_project_check({ checkId: "verify" })`，不接受 shell 文本、任意 argv/env/cwd/profile/端口、taskId 或可由调用方选择的 token。CC 根据已验证的执行者会话反查活跃任务、worktree identity、当前轮次与允许的项目；未知/结束/其他任务一律拒绝。走宿主已关联的动态工具或专用 stdio broker；**不新建无认证 localhost 代跑命令 API，不把 operator/session token 给测试 shell**。当前仓库尚未实现该工具。

登记表由 CC/主人预先维护且位于工作区外、任务不可写；固定 check ID → 固定可信 runtime + argv/cwd 规则、所需平台、时限/预算和隔离能力版本。项目中的 `package.json/scripts/verify.ts` 可以变化并执行任意代码，始终放在 runner 内；登记不构成提升为宿主代码的依据。新登记/扩权限在主人明确设置或后续审查中完成，不能由任务自己批准。

每次运行流程：

1. 校验调用身份、任务身份和登记版本；同一任务串行。supervisor 锚定读取并创建独立、内容绑定的输入快照；先核验快照完整性与来源，运行期间源输入只读，构建/缓存/测试产物放独立可写输出目录。原执行者与其后代不能修改此快照；不接受“执行者承诺停写”或首尾 hash 相等作为替代，避免中途改写再恢复的 ABA。需自改源码的检查暂不登记，须另做隔离设计。结果绑定快照内容指纹、依赖与 runtime 版本。
2. 在可信 supervisor 下创建新任务运行根、虚拟 HOME/tmp/cache、只读运行时/依赖与政策。策略、bootstrap、取消句柄都在任务写根以外。控制文件不能由任务提供，也不从任务 shell 启动宿主 runner。
3. 建立已验收的私有网络和最小文件视图，先跑固定自检：自身 v4/v6 成功，**受控伪造宿主服务不可达**，凭据/外网/越界写拒绝。不能用真实 daemon 做启动自检。任何能力或回执不符直接终止，绝不 fallback 为宿主 loopback 或无沙箱。
4. 只在该边界内 exec 登记入口；全部后代继承。默认同任务一次一个检查、墙钟 10 分钟、输出保留 8 MiB 尾部及截断标志、tmp/cache 总额 1 GiB、低优先级；进程数/内存预算在后端可执行时设置，达不到就声明能力不足。主 Mac 负载 ≥8 时不启动重型检查；严格资源配额在同 UID Seatbelt 下不能仅凭 rlimit 就承诺（总进程/总磁盘需真正的 supervisor/guest 配额）。
5. 超时/取消/断线/CC 重启撤销能力并结束整棵树、关闭 listener，确认无后代才清理自有运行根；PID/任务身份不明时不误杀别人的进程。输出按不可信文本处理；原始超大 stdout 在收集端限量，不能把任务输出当宿主协议。
6. 回传 `runId/checkId/inputFingerprint/policyDigest/backend/runtime/platform/exitCode/signal/duration/truncated/artifacts/cleanupStatus`。只有快照完整性保持、检查成功且清理成功才记该快照的检查通过；要作为当前任务验证回执，还需与当前待提交输入比对，变化则重跑。回执证明输入来源与执行结果，不证明恶意测试的断言诚实，也不声称穷尽其运行时动态生成的每个字节。隔离拒绝、环境缺失、检查失败分别报告。GUI/UI 检查不在这项工具自动运行范围。

对执行者：调用一次工具、等进度、拿退出码和失败摘要后继续修复，再调用同一 check ID。无需自己了解 Seatbelt，也不会收到「去沙箱外重试」的自动建议。未登记检查返回不支持；需要联网安装依赖按已有可信准备路径处理，不在测试 runner 内临时开放网络。

对主人：**后端通过独立审查、项目检查已登记后，每次检查 0 次权限批准**；首次登记/扩大权限是一次明确配置决策，不能把它伪装成每任务全权限放行。当前 macOS 原型没有满足免审批条件，审批次数仍是现行「同任务同命令」机制决定，不能承诺已降为 0。界面只需一条任务活动「正在运行项目检查」与结果；需要额外权限时说明具体缺少能力，不把实现术语塞给日常用户。

## 6. Windows / Linux 能力与退化

以下为一手文档/源码分析，本次没有这些平台的实机验收，也未建 guest。

| 平台 | 推荐能力 | 必须防止的退化 |
| --- | --- | --- |
| Linux | user + mount + PID + network namespace；只起私有 lo，不设 veth/slirp/NAT/proxy；白名单挂载，独立 tmp/shm，drop capabilities，seccomp 与可用时的 Landlock 纵深防御 | userns/bwrap/lo/文件策略不可用就停。禁止 `--unshare-user-try` 后静默共享网络；不挂宿主 `/run`、`/tmp`、HOME、Docker/DBus/SSH socket。有路径 Unix socket 仍需文件视图隔离 |
| Windows 原生 | 研究无 NIC 的专用 Hyper-V guest 或受控 Windows Sandbox；guest 内 IPv4/IPv6 回环必须实测；输入只读映射到固定 staging，输出经受限通道回收，关闭剪贴板、共享设备/目录等宿主集成 | Restricted token/ACL + Job + WFP 本身不产生每任务私有回环。Windows Sandbox 默认网络/剪贴板开放，不能用默认配置。AppContainer loopback exemption 不是私有网络 |
| Windows 上 Linux 检查 | WSL2 内再建 Linux 私有 netns，关闭 interop、共享盘、vsock 等宿主桥 | WSL2 NAT 可达宿主网关；mirrored 可直接访问 Windows localhost。不能把 WSL2 默认网络当隔离，更不能把 Linux 检查记为 Windows 原生通过 |
| macOS | 可移植检查用无 NIC Linux guest；Darwin 检查研究独立 macOS guest。Seatbelt 做额外限制 | 没有通过后端验收前，继续纯离线检查与现有显式审批；不改主人防火墙、不自动安装系统扩展 |

依据：[network_namespaces(7)](https://man7.org/linux/man-pages/man7/network_namespaces.7.html)、[user_namespaces(7)](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)、[bubblewrap 上游选项](https://github.com/containers/bubblewrap/blob/main/bwrap.xml)及[其 lo 初始化](https://github.com/containers/bubblewrap/blob/main/network.c#L151)；Windows [Restricted Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)、[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[WFP](https://learn.microsoft.com/en-us/windows/win32/fwp/windows-filtering-platform-start-page)、[AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)、[loopback 排障](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/troubleshooting-uwp-firewall)、[Sandbox 配置](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)、[WSL 网络](https://learn.microsoft.com/en-us/windows/wsl/networking)。

不能直接借 stock Codex 离线后端声称已支持这些测试：[0.167 Linux bwrap](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/linux-sandbox/src/bwrap.rs#L110)区分 Isolated 与另带桥的 ProxyOnly；[seccomp:223](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/linux-sandbox/src/seccomp.rs#L223) 在 fully restricted 模式将 socket 限 AF_UNIX。新的 runner 要在无桥 netns 内单独允许所需 IP socket，同时禁 AF_VSOCK 等旁路。Windows [allow_local_binding](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/windows-sandbox-rs/src/lib.rs#L52)是任意回环流量，[firewall:117](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/windows-sandbox-rs/src/setup_provisioning/firewall.rs#L117)会撤 TCP/UDP loopback block，也不是任务专用网络。

统一退化：能力缺失/自检失败返回「测试隔离不可用」，纯离线检查仍在原沙箱；需额外能力的检查保持原有显式审批与确切权限说明。不得自动开宿主回环、访问外网或退回 danger-full-access。UI 继续既有 mini lab 流程；本次未上 mini，也没有任何 mini 目录或 app 快照需要清理。

## 7. 不做与上线前独立审查门

本次不实现产品代码、工具接口、持久配置、daemon 改造、权限迁移、真实 token 验证、真实 API 探测、全机监听扫描、安装虚拟机/扩展、防火墙变更、UI/mini 验收、发布或 push。不改变现有执行者沙箱，不把「测试命令」归为可信程序，不承诺任意项目都能在最小白名单下运行，不解决联网集成测试、签名/钥匙串、真实模型/微信或生产数据库测试。

上线必须由**未参与实现的独立安全审查者**对具体实现、固定策略和真实平台证据逐项签核；本稿审阅不替代上线审查：

- [ ] 从全盘可读的原执行者 → 工作区 → runner → 宿主服务的跨进程链不成立；不能只测 runner 单进程 token 拒读。
- [ ] 默认拒绝、完整读白名单与敏感路径 deny，包括自定义 HOME/stateDir、备份、配置 include/helper、环境、FD/句柄、IPC/钥匙串；不读真实凭据，全部用 canary fixtures。
- [ ] 路径 canonicalization、大小写/Unicode、symlink/hardlink/rename/reparse point、已有 inode 别名、目录与 policy 注入/替换、TOCTOU 均负测；登记/runner/preload 不在任何任务可写根。
- [ ] 真实私有 v4/v6 回环正测；受控宿主 listener、代理、Unix socket/pipe/Mach/vsock 不可达；外网、DNS、UDP、raw socket、IPv4-mapped IPv6、wildcard/LAN 入站都按策略测，不能只用外网超时当拒绝证明。
- [ ] 明确解决本次 wildcard bind 与宿主回环两个失败边界；任一仍成立则 macOS 主人 UID 后端不得免审批上线。
- [ ] 所有入口包括 start/resume/重试/取消/恢复同一策略；缺失、恶意、旧版回执 fail closed。没有通用任意命令 broker，没有借工具换任务/提升权限的路径。
- [ ] 强制内容绑定的独立输入快照，源输入运行期间只读、输出单独可写，原执行者/后代不可改；覆盖中途改写再恢复的 ABA 负测。回执绑定快照/依赖/runtime/policy，当前输入已变则重跑；工具不把项目代码加载到宿主，也不从输出提权或执行。
- [ ] 进程后代、脱离会话/重挂父进程、已连接 FD、传递句柄、继承 socket 等逃逸负测；取消、超时、runner/CC 崩溃和重启后无残留服务，不能误清理其他任务。
- [ ] 时间/CPU/进程/内存/磁盘/输出预算实际执行；输出截断、OOM、低磁盘、fork bomb、日志洪泛有受控夹具，不在主机重压实测。
- [ ] Linux、Windows、macOS 各有对应真实 OS 的证据；跨 OS guest 的结果如实标注。功能探测失败不自动改全机设置、不降为无沙箱。
- [ ] daemon 全部监听的匿名面重新审计（含 OPTIONS、静态、pair/WS、可选服务和新路由）；鉴权/限流是纵深防御，不代替网络隔离。
- [ ] 原有离线沙箱守卫与 #891 依赖/uptime 机制保持；新增安全测试只增不减，恶意夹具均有明确红/绿和清理证据；通过后再按集成/部署纪律上线。

## 附录：复跑纯临时目录原型

下面保留实际执行的完整脚本；**这是带已知安全缺口的诊断，不是 runner 实现**。只支持本次所用 macOS/Python 形状；别的系统若运行时白名单不足，报错停止，不自动加权限。敏感名字全部在新建的假 HOME 下；`.npmrc/.netrc/.gitconfig` 在此故意也是装有 canary 文件的同名目录，用来检查 subpath deny，未测试真实配置内容。脚本会短暂创建空的 wildcard listener 来复核已知缺口，不接受请求/不提供文件；未测试 LAN 客户端。

从仓库根目录提取到全新临时目录运行：

```sh
python3 - <<'PY'
import pathlib, subprocess, sys, tempfile
doc = pathlib.Path('docs/superpowers/specs/2026-11-09-test-sandbox-design.md').read_text()
body = doc.split('<!-- PROBE_SOURCE_BEGIN -->\n```python\n', 1)[1].split('\n```\n<!-- PROBE_SOURCE_END -->', 1)[0] + '\n'
root = pathlib.Path(tempfile.mkdtemp(prefix='cc-test-sandbox-design.', dir='/private/tmp'))
script = root / 'probe.py'
script.write_text(body)
print(root, flush=True)
subprocess.run([sys.executable, str(script)], check=True)
PY
```

<!-- PROBE_SOURCE_BEGIN -->
```python
import ctypes, errno, json, os, pathlib, platform, socket, subprocess, sys, threading

ROOT = pathlib.Path(__file__).resolve().parent
WORK = ROOT / 'workspace'
FAKE = ROOT / 'fake-home'
TMP = ROOT / 'task-tmp'
CACHE = ROOT / 'task-cache'
TOKEN = FAKE / '.claude/channels/wechat/operator-token'
PYTHON = os.environ.get('PROBE_PYTHON') or str(pathlib.Path(sys.executable).resolve())
SENSITIVE = ['.claude/channels/wechat', '.ssh', '.gnupg', '.aws', '.config/gh',
             '.npmrc', '.netrc', '.gitconfig', 'Library/Keychains',
             'Library/Application Support/Google/Chrome', 'Library/Safari',
             'Library/Application Support/Firefox']

def attempt(fn):
    try:
        fn()
        return {'ok': True}
    except OSError as e:
        return {'ok': False, 'errno': e.errno}

def connect(host, port, family=socket.AF_INET):
    with socket.socket(family, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        s.connect((host, port))

def own_echo(host, family):
    with socket.socket(family, socket.SOCK_STREAM) as server:
        server.bind((host, 0))
        server.listen(1)
        server.settimeout(1)
        with socket.socket(family, socket.SOCK_STREAM) as client:
            client.settimeout(1)
            client.connect((host, server.getsockname()[1]))
            with server.accept()[0] as peer:
                client.sendall(b'offline-probe')
                assert peer.recv(32) == b'offline-probe'
                peer.sendall(b'pass')
                assert client.recv(4) == b'pass'

def bind(host, family=socket.AF_INET):
    with socket.socket(family, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        s.listen(1)

def child(host_port):
    out = {}
    out['own_ipv4'] = attempt(lambda: own_echo('127.0.0.1', socket.AF_INET))
    out['own_ipv6'] = attempt(lambda: own_echo('::1', socket.AF_INET6))
    out['loopback_alias'] = attempt(lambda: own_echo('127.0.0.2', socket.AF_INET))
    out['host_service'] = attempt(lambda: connect('127.0.0.1', host_port))
    out['external_ipv4'] = attempt(lambda: connect('192.0.2.1', 9))
    out['external_ipv6'] = attempt(lambda: connect('2001:db8::1', 9, socket.AF_INET6))
    out['wildcard_ipv4'] = attempt(lambda: bind('0.0.0.0'))
    out['wildcard_ipv6'] = attempt(lambda: bind('::', socket.AF_INET6))
    for item in SENSITIVE:
        out['read:' + item] = attempt(lambda item=item: (FAKE / item / 'secret').read_bytes())
    out['read_token'] = attempt(lambda: TOKEN.read_bytes())
    out['symlink_read'] = attempt(lambda: (WORK / 'token-link').read_bytes())
    out['workspace_write'] = attempt(lambda: (WORK / 'ok').write_text('ok'))
    out['tmp_write'] = attempt(lambda: (TMP / 'ok').write_text('ok'))
    out['cache_write'] = attempt(lambda: (CACHE / 'ok').write_text('ok'))
    out['outside_write'] = attempt(lambda: (ROOT / 'outside').write_text('bad'))
    out['symlink_write'] = attempt(lambda: (WORK / 'outside-link').write_text('bad'))
    out['hardlink'] = attempt(lambda: os.link(TOKEN, WORK / 'token-hardlink'))
    lib = ctypes.CDLL(None, use_errno=True)
    size = ctypes.c_size_t(32)
    data = ctypes.create_string_buffer(32)
    rc = lib.sysctlbyname(b'kern.boottime', data, ctypes.byref(size), None, 0)
    out['kern.boottime'] = {'ok': rc == 0, 'errno': ctypes.get_errno() if rc else 0}
    nested = subprocess.run([PYTHON, '-I', '-c',
        'import pathlib,sys; pathlib.Path(sys.argv[1]).read_bytes()', str(TOKEN)],
        capture_output=True, timeout=3)
    out['descendant_read_denied'] = nested.returncode != 0 and 'PermissionError' in nested.stderr.decode()
    print(json.dumps(out, sort_keys=True))

def q(value):
    return json.dumps(str(value))

def make_profile(mode, host_port):
    # FAKE is readable only as an intentional adversarial overlap/control fixture.
    reads = ['/System/Library', '/usr/lib', pathlib.Path(sys.base_prefix).resolve(),
             WORK, FAKE, ROOT / 'probe.py', TMP, CACHE]
    lines = ['(version 1)', '(deny default)', '(allow process-exec process-fork)',
             '(allow signal (target same-sandbox))',
             '(allow file-read* (literal "/"))',
             '(allow file-read* file-map-executable ' + ' '.join('(subpath '+q(p)+')' for p in reads) + ')',
             '(allow file-read* (literal '+q(PYTHON)+'))',
             '(allow file-map-executable (literal '+q(PYTHON)+'))',
             '(allow file-read-metadata (path-ancestors '+q(PYTHON)+') (path-ancestors '+q(ROOT / 'probe.py')+'))',
             '(allow file-read* file-write-data (literal "/dev/null"))',
             '(allow file-read* (literal "/dev/urandom"))',
             '(allow file-write* ' + ' '.join('(subpath '+q(p)+')' for p in [WORK,TMP,CACHE]) + ')',
             '(allow sysctl-read (sysctl-name "hw.logicalcpu") (sysctl-name "hw.ncpu") (sysctl-name "hw.machine") (sysctl-name "kern.ostype") (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion") (sysctl-name "kern.version") (sysctl-name "kern.hostname"))']
    if mode != 'no-deny-control':
        lines += ['(deny file-read* file-map-executable ' +
                  ' '.join('(subpath '+q(FAKE / p)+')' for p in SENSITIVE) + ')']
    if mode != 'no-network-control':
        lines += ['(allow network-bind network-inbound (local tcp "localhost:*"))']
    if mode not in ['no-network-control', 'bind-only-control']:
        endpoint = 'localhost:'+str(host_port) if mode == 'fixed-host-port-control' else 'localhost:*'
        lines += ['(allow network-outbound (remote tcp '+q(endpoint)+'))']
    return '\n'.join(lines) + '\n'

def main():
    assert sys.platform == 'darwin'
    assert ROOT.parent == pathlib.Path('/private/tmp') and ROOT.name.startswith('cc-test-sandbox-design.')
    for directory in [WORK,FAKE,TMP,CACHE]:
        directory.mkdir(exist_ok=True)
    for item in SENSITIVE:
        d = FAKE / item
        d.mkdir(parents=True, exist_ok=True)
        (d / 'secret').write_text('FAKE-NOT-A-CREDENTIAL')
    TOKEN.write_text('FAKE-NOT-A-CREDENTIAL')
    for name, target in [('token-link',TOKEN), ('outside-link',ROOT/'outside')]:
        p = WORK / name
        if not p.is_symlink():
            p.symlink_to(target)
    (ROOT / 'outside').write_text('unchanged')
    with socket.socket() as host:
        host.bind(('127.0.0.1',0))
        host.listen(16)
        host.settimeout(0.2)
        stop = threading.Event()
        hits = []
        def serve():
            while not stop.is_set():
                try:
                    conn,_ = host.accept()
                    hits.append(1)
                    conn.close()
                except TimeoutError:
                    pass
        t = threading.Thread(target=serve)
        t.start()
        results = {}
        env = {'HOME':str(FAKE), 'TMPDIR':str(TMP), 'PATH':'/usr/bin:/bin', 'LC_ALL':'C',
               'XDG_CACHE_HOME':str(CACHE), 'PYTHONDONTWRITEBYTECODE':'1', 'PROBE_PYTHON':PYTHON}
        try:
            for mode in ['full','no-network-control','no-deny-control','bind-only-control','fixed-host-port-control']:
                profile = ROOT / (mode+'.sb')
                profile.write_text(make_profile(mode, host.getsockname()[1]))
                run = subprocess.run(['/usr/bin/sandbox-exec','-f',str(profile),PYTHON,'-I',
                                      str(ROOT/'probe.py'),'child',str(host.getsockname()[1])],
                                     cwd=WORK, env=env, capture_output=True, text=True, timeout=12)
                if run.returncode:
                    raise RuntimeError(mode+': rc='+str(run.returncode)+' '+run.stderr)
                results[mode] = json.loads(run.stdout)
        finally:
            stop.set()
            t.join(1)
    (ROOT/'observations.json').write_text(json.dumps(results, indent=2))
    full = results['full']
    for key in ['own_ipv4','own_ipv6','host_service','workspace_write','tmp_write','cache_write']:
        assert full[key]['ok'], (key,full[key])
    for key in ['external_ipv4','external_ipv6','loopback_alias','read_token',
                'symlink_read','outside_write','symlink_write','hardlink','kern.boottime'] + ['read:'+p for p in SENSITIVE]:
        assert not full[key]['ok'] and full[key]['errno'] in [errno.EPERM,errno.EACCES], (key,full[key])
    assert full['descendant_read_denied']
    # These are observed limitations, explicitly NOT security successes.
    assert full['wildcard_ipv4']['ok'] and full['wildcard_ipv6']['ok']
    assert not results['bind-only-control']['own_ipv4']['ok']
    assert not results['bind-only-control']['host_service']['ok']
    assert results['fixed-host-port-control']['host_service']['ok']
    assert not results['fixed-host-port-control']['own_ipv4']['ok']
    for mode, keys in {
        'no-network-control': ['own_ipv4','own_ipv6','host_service'],
        'bind-only-control': ['own_ipv4','own_ipv6','host_service'],
        'fixed-host-port-control': ['own_ipv4','own_ipv6'],
    }.items():
        for key in keys:
            observed = results[mode][key]
            assert not observed['ok'] and observed['errno'] in [errno.EPERM,errno.EACCES], (mode,key,observed)
    for key in ['own_ipv4','own_ipv6','host_service','read_token'] + ['read:'+p for p in SENSITIVE]:
        assert results['no-deny-control'][key]['ok'], ('no-deny-control',key)
    assert not results['no-deny-control']['descendant_read_denied']
    assert (ROOT/'outside').read_text() == 'unchanged'
    record = {'os':platform.platform(), 'python':PYTHON, 'root':str(ROOT),
              'host_fixture_hits':len(hits),
              'known_limitations':['host loopback service reachable','wildcard bind/listen succeeds'],
              'results':results}
    (ROOT/'results.json').write_text(json.dumps(record,indent=2)+'\n')
    print(json.dumps(record,indent=2))

if __name__ == '__main__':
    if len(sys.argv)>1 and sys.argv[1]=='child':
        child(int(sys.argv[2]))
    else:
        main()
```
<!-- PROBE_SOURCE_END -->
