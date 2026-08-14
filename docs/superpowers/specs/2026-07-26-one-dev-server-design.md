# 一个 dev server(合并 dev-server + test-shim)设计

**日期**: 2026-07-26
**状态**: 已批准(以 test-shim 为底合并;live 模式默认禁危险命令)
**动因**: 桌面记忆页 bug 的调试过程暴露了 dev 侧的两个问题——①浏览器 dev 打不到真后端(所有 daemon 功能静默降级成"未启用"),②两个 dev server 行为不同 = 未来分歧的温床。今天已经因"编译 vs bun"分歧吃过一次亏(见 `2026-07-23-daemon-owns-llm-memory-ops-design.md`)。

## 背景:现状与实证

**两个 dev server:**
1. `apps/desktop/dev-server.ts`(:4173)——静态服务 + SSE 热重载。`tauri.conf.json` 的 `beforeDevCommand: bun run dev-server` + `devUrl: http://127.0.0.1:4173` 用它。**普通浏览器打开时没有 Tauri IPC** → `ipc.js` 落到 `mock.js` → `api.js` 的 `getApiCredentials` 拿不到凭据 → 而 `refresh()` 各处 `.catch(() => null)` → **静默降级成"未启用"**(觅食台/信箱/配对/记忆全空)。
2. `apps/desktop/test-shim.ts`(:4174)——静态服务 + `/__invoke` → 真 `bun cli.ts` + DRY_RUN mock 状态机 + CSP 注入。Playwright 用它(`PLAYWRIGHT_SHIM_PORT`,默认 4176)。

**已实证(2026-07-26,浏览器 + 真 daemon):**
- `bun run shim:live`(:4174)里**一切是真的**:记忆库「1 个用户 · 6 文件」、完整画像、点「重新整理」真的跑完 LLM 并写文件。
- daemon internal-api **自带完整 CORS**(`OPTIONS` 204 + `Access-Control-Allow-Origin` 回显 + `Allow-Headers: authorization, content-type`),所以浏览器跨源直连 daemon 可行。
- shim 的 Tauri polyfill 是 `window.__TAURI__ = window.__TAURI__ ?? {…}`——**真 Tauri webview 里不会被覆盖**,因此 `tauri dev` 指向 shim 是安全的。

## §1 收敛:以 test-shim 为底,吸收 dev-server

难的那半已在 shim 里(CLI 桥、mock 状态机、CSP 注入);dev-server 只多**SSE 热重载**一样东西。

- shim 增加热重载:递归 watch `apps/desktop/src/`,变更去抖后经 SSE 广播 `reload`;客户端脚本以 `/__dev_reload.js`(外链,CSP `script-src 'self'` 安全)注入 index.html —— 逐条照搬 `dev-server.ts` 现有实现。
- `apps/desktop/src-tauri/tauri.conf.json`:`beforeDevCommand` 改为启动合并后的 server;`devUrl` 指向它的端口。
- 删除 `apps/desktop/dev-server.ts` 及 `package.json` 里的 `dev-server` / `preview` 脚本;`shim` / `shim:live` 收敛为下面的模式开关。
- Playwright:端口本就由 `PLAYWRIGHT_SHIM_PORT` 决定,只需指向合并后的 server(mock 模式)。

## §2 三个显式模式(页面横幅可见)

| 模式 | 启法 | CLI 通道 | daemon HTTP | 用途 |
|---|---|---|---|---|
| **tauri-dev** | `tauri dev`(beforeDevCommand 起 server) | 真 Tauri IPC(webview 自带 `__TAURI__`,polyfill 不覆盖) | 真 daemon | 日常开发 |
| **browser-live** | `bun run dev:web`(实施时改名:`dev` 已被 `tauri dev` 占用) | polyfill → `/__invoke` → 真 `bun cli.ts` | 真 daemon | 浏览器调试/验收 |
| **mock** | `bun run dev:mock`(= `WECHAT_CC_DRY_RUN=1`) | mock 状态机 + 未拦截的落到真 CLI(故阀门在此也生效) | shim 自服务的假 `/v1` | Playwright e2e |

注:`tauri-dev` 走真 Rust IPC,**不经 `/__invoke`,因此不受安全阀保护**。横幅据此只在 polyfill 真正接管 invoke 时才显示(`window.__TAURI__ === undefined`),不能让它在 `tauri dev` 里承诺一个不存在的保护。

三种模式都带热重载。模式经现有横幅显示(今天的横幅文案「开发 shim 模式 · 操作走真实 CLI(未启用 DRY_RUN)」扩展为三态 + 是否允许改状态)。

## §3 安全阀:live 模式默认禁危险命令

**动因**:同日事故——测试固件把真实 `access.json` 写坏,导致 bot 静默丢弃主人消息(见 memory `test-pollution-real-statedir`)。`shim:live` 转发真 CLI,`src/cli/setup-flow.ts` 会写 `access.json`,具备同类破坏力。

> **实施后修订(2026-07-27,两轮独立安全评审)**:本节原定的设计有三处被证明是错的,已按下面的修订实现。原文保留在 git 历史里。
>
> 1. **拒绝名单 → 放行名单**。原文写的"fail-closed 地列举"其实是黑名单,评审证明它漏得厉害:`account remove`(rmSync 递归删真实 bot 目录)、`provider set --unattended`(重写 launchd plist)、`memory write`、`mode set`、`sessions delete`、`observations archive`、`guard enable/disable` 全部放行,每个都对应仪表盘上一个按钮。**每加一个新 CLI 子命令都默认放行**,这是构造上的错误。现为 `READONLY_CLI_COMMANDS` 白名单。
> 2. **命令路径不够,flag 也必须白名单**。"只读命令 + 写入 flag"是一整类绕过:`logs --out-file <任意路径>` 经 emitJson 的 `writeFileSync` 就是任意文件覆写(指向 access.json = 复现本节动因里那次事故);`service status --unattended false` 会在判断 action 之前落盘;`update --check=false` 被 citty 解析成 false 后真的 git pull + 重启。现在全局只放行 `--json`,其余按命令列出;`--out-file` 由 server 在阀门之后自己追加,客户端无法触达。
> 3. **mock 模式同样生效**(原文写"不受此阀影响")。DRY_RUN 不是沙箱:它只拦截显式列出的命令,未命中的照样落到真 `cli.ts` 和真 state dir——`dev:mock` 下点"删除"会真删账号。阀门去掉了 dryRun 逃生口。
>
> 另:argv 以 flag 开头一律拒绝(citty 的 `findSubCommandIndex` 会跳过前导 flag,`['--json','setup']` 真的会跑 setup);`/__invoke` 与 `/attachment` 拒绝跨站请求(dev server 现在是 `tauri dev` 全程常开的)。

- `/__invoke` 默认只转发**已知只读**的命令,其余返回结构化 `{ error: 'mutating_command_blocked_in_dev', hint: … }`(前端按既有 `formatInvokeError` 显示人话)。拒绝理由分四类:命令不在名单 / 命令只读但该 flag 不行 / requireFlag 未生效 / argv 形状不对。
- 放行名单由枚举 `apps/desktop/src/**` 的全部 CLI 调用点得来,**每一条都要对照 cli.ts 的实现确认没有写原语**。目前两个有意为之的例外并已标注:`connection probe`(errcode -14 时 markExpired,但正式版每次渲染仪表盘就会跑它、且自愈)与 `log`(向固定的 channel.log 追加一行遥测,路径不可控)。
- **不受影响**:**全部 daemon HTTP 路由**——所以「重新整理」「刷新画像」照常真跑(它们走 daemon 路由,不经 `/__invoke`)。
- 显式开关:`--allow-mutations` 或 `WECHAT_CC_DEV_ALLOW_MUTATIONS=1`;开启时横幅变红提示"安全阀已关闭"。

## §4 daemon HTTP 保持直连(不做代理)

浏览器直接 fetch 真 daemon(`api-info` 给出 baseUrl+token),**不引入代理层**。理由:CORS 已由 daemon 自身解决(实证);代理会多一层转发/超时/流式语义需要维护,YAGNI。

**明确取舍**:dev 模式下 daemon token 会出现在浏览器 JS 里。可接受——dev-only、localhost-only、token 源文件 0600、且 daemon 只监听 127.0.0.1。若将来要消除,再引入同源代理(那时 token 留在服务端)。

## §5 错误处理

- daemon 未运行:`api-info` 失败 → 现有 `formatInvokeError` 已给"无法连接到 wechat-cc CLI/daemon"文案;横幅额外提示当前模式需要 daemon。
- 危险命令被拦:见 §3 的结构化错误。
- 热重载 SSE 断开:沿用 dev-server 现有退避重连(重启 server 后只触发一次 reload)。

## §6 测试

- **单测**:危险命令拦截(默认拒绝 / `--allow-mutations` 放行 / **mock 模式同样拦**)、写入 flag 拦截(`--out-file` / `--unattended` / `--check=false`)、前导 flag 形状拒绝、模式判定(三态)、热重载脚本注入(index.html 含 `/__dev_reload.js`,CSP 模式下为外链而非 inline)。
- **验收线**:`apps/desktop` 的 Playwright 全套在 **mock 模式**下与合并前同样通过——证明收敛没碰坏 e2e(该套件本就非必需红,以合并前后同结果为准,不追既有 flake)。
- 全量 `bun run test` + `bunx tsc --noEmit` 零错。

## 非目标

daemon HTTP 同源代理;把 Playwright e2e 改成跑真后端;动 Tauri Rust 侧 `#[cfg(debug_assertions)]` 的 dev-用-bun-sidecar 分支(该分歧已由「LLM=daemon-only」+ CI 编译-sidecar 冒烟覆盖,见 `2026-07-23-daemon-owns-llm-memory-ops-design.md`);把 mock 状态机做成通用 fixture 框架。
