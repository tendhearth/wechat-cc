import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins:[{name:'bun-native-file-import',enforce:'pre',load(id){
    // Bun embeds this source through its file import attribute; Vite needs the path.
    if(id.endsWith('/workbench/attachments-native.c')||id.endsWith('/workbench/api-files-native.c'))return `export default ${JSON.stringify(id)}`
  }}],
  test: {
    // Never collect tests from Claude's nested worktrees: doing so runs a
    // second copy of the suite concurrently and makes every ephemeral-port
    // test contend with its duplicate.
    exclude: [
      '**/node_modules/**', '**/.claude/worktrees/**', '**/__e2e__/**', '**/playwright/**', '**/eval/**',
      // Windows 上工作台不可用,整块不跑(2026-09-16,windows-latest 466 条红里 ~440 条在这里):
      // Codex 执行者与 Claude 保留会话在 win32 明确拒绝(codex-app-server.ts / claude-workbench-runtime.ts),
      // 成果、附件、API 文件、原生历史都依赖 bun:ffi 编译的 *-native.c(openat / dirfd),win32 上
      // 一律 artifact_platform_unsupported / native_history_unsupported。这些测试在 Windows 上
      // 测的不是代码,是"平台不支持"这一个事实,每次 400 条红只会教人别看 CI。
      // 这是产品缺口,不是测试缺口:Windows 用户目前拿不到工作台,见 docs/cc-workbench.md。
      ...(process.platform === 'win32' ? [
        'src/core/workbench/**',
        'src/core/claude-workbench-runtime.test.ts',
        'src/daemon/bootstrap/wire-workbench-*.test.ts',
        'src/daemon/bootstrap/workbench-api.test.ts',
        'src/daemon/internal-api/routes-workbench.test.ts',
      ] : []),
    ],
    // Tests should never touch the operator's real ~/.claude/channels/wechat
    // channel.log. PR Phase 4 routed SESSION_INIT through src/lib/log which
    // appendFileSyncs to STATE_DIR; without this opt-out a vitest run
    // appends test garbage to a live operator's log file.
    env: { WECHAT_DISABLE_LOG_FILE: '1' },
    // Bundled-plugin hermeticity — see vitest.setup.ts: a dev box with
    // plugins/wxsearch/.venv installed must not leak wxsearch into every
    // buildBootstrap-based test.
    setupFiles: ['./vitest.setup.ts'],
    // windows-latest runners have chronically slow disk I/O: on a bad day
    // MULTIPLE unrelated suites (store, shim.e2e, powershell-validator,
    // social CLI) blow the 5s default purely on runner slowness — observed
    // 2026-08-29 across three runs, a different victim each time, all
    // "Test timed out in 5000ms". Per-test timeout bumps are whack-a-mole;
    // raise the platform default instead. macOS/Linux keep the strict 5s so
    // a genuine hang still fails fast where the signal is trustworthy.
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000,
    // ...and the same for HOOKS, which the line above did not cover. 2026-09-01:
    // knowledge/graph-store 的 `beforeEach`(mkdtempSync + openKnowledge)在
    // windows-latest 上撞了 vitest 默认的 10s hookTimeout,红了一次、重跑就绿。
    // 那种红最贵的地方不是它本身,是它教人别看 CI —— 见 desktop-e2e 那笔账。
    // 建库这类重活恰恰都在 hook 里,所以这条比 testTimeout 更该抬。
    hookTimeout: process.platform === 'win32' ? 20_000 : 10_000,
  },
})
