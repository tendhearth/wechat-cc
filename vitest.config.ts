import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Never collect tests from Claude's nested worktrees: doing so runs a
    // second copy of the suite concurrently and makes every ephemeral-port
    // test contend with its duplicate.
    exclude: [
      '**/node_modules/**', '**/.claude/worktrees/**', '**/__e2e__/**', '**/playwright/**', '**/eval/**',
      // win32 上不跑的(2026-09-16 起工作台的文件层已是纯 JS,大部分工作台测试在 Windows 也跑):
      // - Codex 执行者 / Claude 保留会话 / Codex 原生历史在 win32 明确抛错(进程树清理未验证),
      //   这些测试在 Windows 上测的只是"平台不支持"这个事实;
      // - 用到 mkfifo 的夹具(Windows 没有 FIFO);
      // - git-review 在 Windows 上另有一堆路径 / CRLF 差异,单独一件事。
      ...(process.platform === 'win32' ? [
        'src/core/workbench/codex-app-server.test.ts',
        // ACP 执行者(cursor-agent acp)同样在 win32 第一行就拒绝,套件在 Windows 上只会等 spawn 超时。
        'src/core/acp-workbench-provider.test.ts',
        'src/core/acp-agent-provider.test.ts',
        'src/core/workbench/codex-history-rpc.test.ts',
        'src/core/claude-workbench-runtime.test.ts',
        'src/core/workbench/artifacts.test.ts',
        'src/core/workbench/api-files.test.ts',
        'src/core/workbench/git-review.test.ts',
        // 原生历史读取器的夹具是 POSIX 路径('/fixture'),win32 上 path.join 写成反斜杠,测的不再是同一件事。
        'src/core/workbench/native-claude-history.test.ts',
        'src/core/workbench/native-codex-history.test.ts',
        'src/core/workbench/native-history.test.ts',
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
