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
| **browser-live** | `bun run dev` | polyfill → `/__invoke` → 真 `bun cli.ts` | 真 daemon | 浏览器调试/验收 |
| **mock** | `bun run dev --mock`(= 现 `WECHAT_CC_DRY_RUN=1`) | mock 状态机 | shim 自服务的假 `/v1` | Playwright e2e |

三种模式都带热重载。模式经现有横幅显示(今天的横幅文案「开发 shim 模式 · 操作走真实 CLI(未启用 DRY_RUN)」扩展为三态 + 是否允许改状态)。

## §3 安全阀:live 模式默认禁危险命令

**动因**:同日事故——测试固件把真实 `access.json` 写坏,导致 bot 静默丢弃主人消息(见 memory `test-pollution-real-statedir`)。`shim:live` 转发真 CLI,`src/cli/setup-flow.ts` 会写 `access.json`,具备同类破坏力。

- live 模式下 `/__invoke` 对**会改变真实状态**的命令默认拒绝,返回结构化 `{ error: 'mutating_command_blocked_in_dev', hint: '--allow-mutations' }`(前端按既有 `formatInvokeError` 显示人话)。
- 拒绝名单(按 CLI 顶层子命令前缀匹配,fail-closed 地列举而非黑名单猜测):`setup`、`setup-poll`、`service`、`daemon kill`、`daemon kill-residual`、`update`。
- **不受影响**:所有读类 CLI(`memory list/read`、`doctor`、`sessions`、`conversations`、`observations`…)与**全部 daemon HTTP 路由**——所以「重新整理」「刷新画像」照常真跑(它们走 daemon 路由,不经 `/__invoke`)。
- 显式开关:`--allow-mutations` 或 `WECHAT_CC_DEV_ALLOW_MUTATIONS=1`;开启时横幅明显变色提示"可改真实状态"。
- mock 模式不受此阀影响(本就不碰真实状态)。

## §4 daemon HTTP 保持直连(不做代理)

浏览器直接 fetch 真 daemon(`api-info` 给出 baseUrl+token),**不引入代理层**。理由:CORS 已由 daemon 自身解决(实证);代理会多一层转发/超时/流式语义需要维护,YAGNI。

**明确取舍**:dev 模式下 daemon token 会出现在浏览器 JS 里。可接受——dev-only、localhost-only、token 源文件 0600、且 daemon 只监听 127.0.0.1。若将来要消除,再引入同源代理(那时 token 留在服务端)。

## §5 错误处理

- daemon 未运行:`api-info` 失败 → 现有 `formatInvokeError` 已给"无法连接到 wechat-cc CLI/daemon"文案;横幅额外提示当前模式需要 daemon。
- 危险命令被拦:见 §3 的结构化错误。
- 热重载 SSE 断开:沿用 dev-server 现有退避重连(重启 server 后只触发一次 reload)。

## §6 测试

- **单测**:危险命令拦截(live 拒绝 / `--allow-mutations` 放行 / mock 模式不拦)、模式判定(三态)、热重载脚本注入(index.html 含 `/__dev_reload.js`,CSP 模式下为外链而非 inline)。
- **验收线**:`apps/desktop` 的 Playwright 全套在 **mock 模式**下与合并前同样通过——证明收敛没碰坏 e2e(该套件本就非必需红,以合并前后同结果为准,不追既有 flake)。
- 全量 `bun run test` + `bunx tsc --noEmit` 零错。

## 非目标

daemon HTTP 同源代理;把 Playwright e2e 改成跑真后端;动 Tauri Rust 侧 `#[cfg(debug_assertions)]` 的 dev-用-bun-sidecar 分支(该分歧已由「LLM=daemon-only」+ CI 编译-sidecar 冒烟覆盖,见 `2026-07-23-daemon-owns-llm-memory-ops-design.md`);把 mock 状态机做成通用 fixture 框架。
