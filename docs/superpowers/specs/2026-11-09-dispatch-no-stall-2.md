# 交办不中断：第二轮实测修复

用户已指定实施范围、验收与交付方式；本稿记录实施选择和安全边界。

目标：相同锁文件可复用由 CC 安全安装的依赖；沙箱任务的 uptime 不误报；大输出不误杀任务。保持 workspace-write 离线、任务独立临时目录及 #883 准备阶段安全约束，不操作真实 daemon。

## 依赖（安全审查后修订）

共享缓存只接收 **CC 自己**在干净 staging 中按锁文件安装出的依赖，绝不提升任务或 sibling 的 node_modules；quiet、成功退出、setup 成功均不能证明任务字节可信。任务收尾和脚本完成的发布接线已删除，任意 sibling 自动发现亦已删除，进行中、失败或伪造完成记录的 sibling 一律不可复用。

缓存使用 stateDir/dependency-cache/v2，完全忽略旧 v1 快照。键绑定 Git common-dir realpath、平台、架构、Node ABI，以及排序后的锁文件和 manifest 路径/内容指纹。无锁文件不缓存。已有 owner checkout 仍可走 #883 的独立复制快路，但它也不进入共享缓存。

安装输入只来自任务起点提交的 Git 对象。创建时传 `plan.start.sha`，重新打开时传持久化的 `worktree.start.sha`；缺少旧任务起点就安全 miss，不用任务分支 HEAD 替代。沿用 #883 的 SAFE_GIT、禁 hooks/filter/fsmonitor/lazy fetch/replace objects 参数，通过 ls-tree + cat-file 读取有界 blob。工作区字节仅用于比对；清单/锁增加、删除、未提交或已提交修改都不能改变安装输入，出现变化即退回执行者锁定安装提示。owner 复制快路也先做起点比对。

暂只支持 root 文本 bun.lock 的保守子集。全量检查来源后才允许任何下载：外部包必须是固定 npm 包名/版本、带 sha512 integrity、锁内无显式 tarball URL；git/git+ssh/github/file/link/http/私网等任一来源使整次 miss。根或根 workspace 成员中出现其他种类锁文件（bun.lockb / package-lock / shrinkwrap / yarn / pnpm）仍整次 miss。根 package.json 的 workspaces 决定成员，只按根 bun.lock 安装；非成员项目（docs/spike、tools/mutation 等）的清单与嵌套锁不参与安装、缓存键或变更比较。成员遗留 bun.lock 不解析、不安装，但其起点 blob 纳入键与未改动比较，变化即 miss。锁声明的 workspace 必须属于根清单成员。默认 registry.npmjs.org；仅解析同一起点提交内的 .npmrc/bunfig 明确 registry 配置（不接受 token、身份、环境替换或可执行配置）。只接受公共 https registry，无用户名、密码、查询、fragment 或非默认端口。下载前将 DNS 限定为公共 IPv4 并把验证过的地址固定到 TLS 请求；拒绝重定向，防止解析变化或跳转到内网。

CC 自己执行有界下载和 ustar 解包，不再启动 Bun/Git/SSH 安装进程。这样没有 SSH 配置、身份、known_hosts、agent、npmrc/bunfig 用户目录发现或子进程环境继承路径；不读主人配置，也不执行 package scripts。所有写入都在私有 stage，没有用户 HOME/XDG/缓存写入。宿主设置了代理环境时外部安装安全 miss，保留已有网络守护。只有工作区链接的离线安装仍可用。tar 的 PAX、稀疏、链接、特殊文件及 bundled/binDir 等未实现形状整次 miss；支持的 bin 链接只指向已校验的包内文件；workspace bin 只建立逻辑占位端点，恢复时使用新 checkout 的真实文件。先验证所有来源，再按 os/cpu 筛掉不适用的可选包，并检查物理布局中仍有全部必需依赖；libc 专属布局暂不支持，整次 miss。Windows 尾点/空格别名、设备名及 ADS 在所有平台一致拒绝。

解包路径采用统一的保守命名空间身份，与宿主是否区分大小写无关：路径字段严格解码 UTF-8，损坏字节直接拒绝；每个分量先 NFD 分解，逐码点 lower → upper，再 NFC 合成；这覆盖规范等价、大小写与展开折叠（如 ß/SS、sigma、连字），并保守合并 dotless i/I。身份键去除 Win32 尾点/空格，但原名含这些后缀、ADS/禁字符或保留设备基名即拒绝，不改写后落盘。设备基名取首点前且去尾空格，包含 COM/LPT 的 ¹²³ 及 CONIN$/CONOUT$；另拒绝 Default_Ignorable_Code_Point，避免 HFS+ 忽略字符造成别名；拒绝 `~` 分量，避免 Win32 生成的 8.3 短名与长目录合并。规则依据 [Unicode 大小写映射](https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt)、[Win32 文件命名](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)与 [HFS+ 比较规则](https://developer.apple.com/library/archive/technotes/tn/tn1150.html)。

完整 tar 预检登记每级隐式父目录、显式目录、普通文件的身份、原拼写和类型。不同原名撞身份、重复显式声明或目录/文件冲突，均在包根创建前拒绝整包；相同原拼写父目录可复用，隐式父目录可补一次显式声明。node_modules / .git 禁令按同一身份判断，不能以大写或 Unicode 别名绕过。安装计划的包根也逐级登记，防止 Tool/tool 或 @Scope/a/@scope/b 在多个包之间合并父目录。正常 Unicode 路径保留原拼写。

磁盘预算前置：写元数据前检查其双份大小、条目和剩余空间；按锁内包数及可选 unpackedSize/fileCount 做安装预检（普通 Bun 锁不声明体积，不能假装已有体积证明）。下载逐块计数，单包压缩数据最多 32 MiB；解压逐块有界，单包展开内存最多 128 MiB。tar 先校验完整 header、声明体积/条目和路径，再创建包文件。所有目录逐层计数，文件每 64 KiB 写入前检查共享字节预算、条目、剩余空间、取消与截止时间，超限立即停止，finally 清理整次 stage。同步显式安装默认数据预算 1 GiB。后台安装使用 15 分钟、4 GiB 数据上限与 20 万条目总预算，仍受 4 GiB 缓存上限的一半约束（安装展开最多 2 GiB、10 万条目），为 snapshot 留出对应空间；真实仓库约 1.8 GiB / 7.5 万条在此范围内。完成缓存仍默认 4 GiB、LRU；在建 stage 另有上述硬上限，不把运行期计数替换为写完后扫描。

安装成功后复核起点元数据与任务工作区，再经过原复制器的链接/容量/条目/时间/剩余空间预算，才写绑定完整 key 和 `committed-public-registry-portable-v2` 策略的完成记录并原子 rename。策略同时进入 scope 哈希，修复前的缓存树不会命中，也不会占据新缓存的发布路径；旧条目仍按原 LRU 预算回收。owner 一直保留到 rename 后；stage 在 mkdir 前先写外部 owner journal，避免第二次创建失败或崩溃留下不可追踪目录。daemon 启动扫尾和准备阶段共用串行锁，按死亡 PID 的记录回收 stage/journal；活跃或不明 owner 不删除。取消、失败、超时、元数据变化均不入缓存。workspace / .bin 端点仍仅保存逻辑位置，恢复使用新 checkout 的代码。

Windows 的 Git autocrlf 会让未修改的检出文本使用 CRLF、Git blob 使用 LF。已知文本清单、锁及 registry 配置的工作区比较仅容许 CRLF/LF 差异；裸 CR、JSON 转义、其他字节、末尾换行以及二进制 bun.lockb 仍严格比较。缓存键与安装输入继续使用原始起点 Git blob，不把任务文本归一后送入安装。目录链接安装可用 junction，但缓存复制保留相对链接以跨越发布 rename；系统无 symlink 权限或发布文件被锁时清理自有半成品并返回执行者锁定安装提示，不用绝对 junction 替代导致发布后指向旧 stage。

真实 Bun 锁夹具与产品准备路径一致，使用 native realpath 后再运行 Bun。Windows Bun 1.3.14 在仍含 8.3 别名的 cwd 下会生成 `../../.../pkg` workspace 锁位置；这类已提交锁仍按越界策略拒绝并退回安装提示，不能为让夹具通过而接受它。

同步 Git 的过滤器配置探测和实际命令共用原有 30 秒总期限，不再让健康的 Windows 操作提前撞上独立 5 秒探测上限；配置探测失败仍拒绝执行，错误标记 filters/command 阶段以便定位。

## 真仓库依赖缓存修正（11-09 实测）

建任务仍给 owner 独立复制 / 完成缓存恢复 15 秒；miss 立即返回现有锁定安装提示，同时入 daemon 持有的后台队列。全局每个 stateDir 串行安装，同仓库 common-dir、平台/架构/ABI、锁与清单完整 key 只保留一个在途作业；前台恢复不等待后台安装锁，也不做整缓存扫描。后台从固定起点 Git blob 安装，不接任务的取消信号或 15 秒截止时间；任务元数据安装前后变化仍不发布。开始、完成或失败原因各记一行。daemon 模块停机时先 abort 队列并等待自有 stage 清理，排队作业不再启动。

启动就绪后每分钟检查空闲（无在途对话、busy 登记为空）与一分钟负载；负载 ≥ 逻辑核数 × 1.5 时保留候选等待。只取最近 14 天交办过 project 任务的项目（普通任务创建、执行轮开始或原生接手后首次交办；只导入未交办的会话不算），独立 worktree 解析回原仓库，不受任务列表 200 条限制。每个仓库按本地 origin/dev、缺失时 HEAD 的固定提交预热一次，不 fetch、不读 owner node_modules；这条路径只用 Git blob，owner 检出与默认分支不同不妨碍预热。在读取 blob 后、队列实际开工时重查负载和空闲，推迟的候选下次再试。预热、普通 miss 和 stage recovery 共用后台发布锁，停机一并取消。

验收使用仓库自身 HEAD Git blob（含 6 个嵌套 bun.lock）及本地 HTTP 假 registry；仅在测试的 HTTPS/DNS 系统边界把公共规范 URL 路由到回环夹具，生产来源策略不放宽。覆盖非阻塞 miss、去重/串行、下一件命中、任务取消独立、后台失败/预算/停机清理、预热默认分支与负载推迟。无真实包下载或真实 daemon 操作。

## 任务内 uptime

根因是 Seatbelt 默认拒绝的 sysctl 白名单没有 `kern.boottime`，而 libuv Darwin 的 `uv_uptime` 正好读取它。本仓库唯一直接调用是 `writer-exit.ts` 的系统开机时间核对；锁定 Vitest 4.1.10 不依赖 tinypool，扫描 Vitest/Vite/tinybench 未发现 uptime 调用。没有原始失败栈，不能断言实测具体测试调用链。[Codex 基础策略](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl#L23)、[libuv 调用](https://github.com/libuv/libuv/blob/v1.51.0/src/unix/darwin.c#L167)。

CC 生成固定任务 preload，仅 `uv_uptime` 的 EPERM/EACCES（包含 Node `ERR_SYSTEM_ERROR.info`）回落；其余异常原样抛出。真实沙箱发现 Bun 1.3.14 会返回 0，因此也处理该无效结果。正常 uptime 保持原值。父进程提供系统开机基线，子进程按单调时钟推进，不用进程存活时间代替系统开机时间。同步 builtin ESM 命名导出。

Bun 1.3.14 忽略环境预加载，因此任务 PATH 使用固定 Node/Bun wrapper 显式附加 `--require`，Node 同时用 NODE_OPTIONS。preload 只在沙箱任务及其直接运行时子进程中继承；主动清空环境或另写绝对 shell 命令不改写。

固定 shim 和 wrapper 位于 CC 创建的独立随机只读 runtime 目录，处于所有任务工作区 / TMPDIR 可写根之外；文件名带 SHA256，每次使用均经锚定读取和固定内容指纹校验。权限位不是同 UID 隔离保证，真正边界是 Codex deny-default + workspace-write 且排除全局 /tmp。真实沙箱回归同时验证任务正常写入成功、外部 shim 的改写/替换/硬链接失败。宿主 Node/Bun 路径变化时建立新 bundle，旧 bundle 保留给运行中任务；进程正常退出时统一清理。

宿主 app-server 仅使用干净 workbenchCodexEnv；任务 TMP / cache / preload / PATH 只通过 shell_environment_policy.set 进入沙箱 shell。宿主通知、MCP、helper 不继承任务环境；回归用真实绝对 Node helper 和任务改写的 preload 验证。Claude 的宿主及 settings 也不接任务 preload/PATH，只保留临时目录和包缓存位置，避免把 Codex 的兼容 shim 用到沙箱外。

## 本机回环：不做

撤掉 managed proxy local binding 的启用路径与配置模块。工作台及对话的启动/续接线程明确 `sandbox_workspace_write.network_access=false`、`features.network_proxy=false`，核对有效 proxy 配置与 sandbox 网络回执；不符则不开 turn。原有显式 danger-full-access 模式仍属于用户选择的无沙箱入口，不代表沙箱网络可放开。

原因：当前 sandbox 的广泛可读权限可读同用户的 discovery/operator 凭据；全机回环会把这些文件变成可用的主人 API 与审批权限。域名 deny、NO_PROXY、0700/0600、随机端口及任务端口约定都不能提供这条隔离；stock local-binding 也不能限制为某个任务的 TCP 端口。因此需要 listen 的测试仍走原生显式审批，交给「本任务同命令放行」降低重复打扰。

将来若做，必须先有显式安全设计并以真实沙箱验证：例如凭据对执行者确实不可读的强保证、独立 OS 身份或私有网络隔离、不桥接宿主管理服务；daemon 拒绝执行者进程树请求亦须有可信内核身份而非自报 PID / 轮询父进程。只截断某份 token 不足以保护宿主其他回环服务。守卫测试写明此攻击链，任何放开先更新设计与隔离证据。离线启动守卫覆盖当前入口；新增执行者入口必须加入守卫。递归扫描 src 的已识别 app-server / thread start、resume / session 启动语法并精确登记入口；已识别语法在目录外、子目录或已有模块增加未登记入口会红。新增入口仍须补实际离线配置和恶意/缺失回执负测，静态范围见下文「已知局限」。

## 协议缓冲

保留现有结构消息上限。归属/起点未核验阶段立即丢弃明确允许列表中的通知型预览增量，累计达到原上限再记录一次降级，完成条目重建最终结果；审批请求、归属、生命周期与结束消息始终保留。压缩仅记一条不含正文/线程标识的系统事件，不产生终止性错误；仅结构消息自身超限才失败。归属核验不因输出到达而放宽。JSONL 按单帧限制，完整多帧突发不按总 chunk 大小误杀；未结束单帧超限仍拒绝。

## 验证与评审重点

四条分别留红/绿；大输出覆盖父轮确认前和子线程核验前。缓存覆盖可信安装后源删除、任务投毒、半成品 sibling、安装失败/中断、嵌套锁/清单变化、链接逃逸、LRU/容量、取消与受限复制。环境覆盖 Node/Bun 子进程继承、ESM 命名导出和宿主不加载任务 preload；大输出逐一枚举 7 类预览，单帧及未结束尾帧超限仍拒绝。相关 Bun 与 Node 测试，随后在无游戏且负载低于 8 时运行 bun run verify。无 UI 改动，不使用 mini；不 push。

## 已知局限

- 离线启动源码守卫无上下文统计 `thread/start`、`thread/resume`、`app-server` 字符串，类型声明或普通常量也可能误报。维护者应辨别调用语境，不能为压掉误报机械扩充入口白名单；将来可收窄到进程参数 / RPC 调用语境，本轮不改扫描器。
- 静态漏报包含常见 namespace import（`import * as codex` 后调用 session factory）；只扫描 `.ts`，不扫描 `.tsx/.mts/.cts/.js`，并排除 `.d.ts`、测试、test-support、__e2e__。process factory 只登记 named import，不统计每次调用；同一已导入 factory 新增调用未必变红。动态构造也没有通用识别保证。复用现有 session factory 仍受运行时网络回执约束，源码守卫不能代替新入口的行为负测。
- 路径身份有意比单一文件系统更保守；包含不可见 Unicode 字符、保留设备别名或大小写身份碰撞的包安全 miss。Unicode 映射来自运行时；Windows 已在独立临时目录实跑依赖安装、缓存、路径与命名空间回归，危险名称仍在写入前拒绝，不声称测试了 Windows 保留设备的实际 I/O 或 HFS+ 设备行为。
