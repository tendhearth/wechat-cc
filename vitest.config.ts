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
    // raise the platform default instead.
    //
    // 2026-09-19:同一个病在 macOS 上也犯了,而病因不是 runner 慢 —— 是这套
    // 614 个文件的套件自己把机器吃满(18 worker / 18 核,`tests` 累计 770s
    // 挤在 113s 墙钟里),再叠上「跑套件的机器本来就在干别的活」。自改流水线
    // 的 tests 闸门恰恰跑在主人那台真机上(实测当时前台还有个程序吃掉三分之
    // 一的 CPU,load 16),同一条测试单跑和整套跑差 5~10 倍:两次连跑,受害者
    // 各不相同 —— native-qa-packaging(单跑 1.0s)5112ms、migration-order
    // (单跑 1.0s)5627ms、reminders e2e(单跑 2~4s)20511ms,全是
    // "Test timed out"。也就是说 5s 那个「信号可信」的前提只在空闲机器上成立,
    // 而这套件从来不在空闲机器上跑。按上面那条一样的理由,平台默认统一抬到
    // 20s:真挂死仍然会红,只是晚 15s;一次假红的代价却是整条流水线重跑,还
    // 教人别看红(见下面 desktop-e2e 那笔账)。
    testTimeout: 20_000,
    // ...and the same for HOOKS, which the line above did not cover. 2026-09-01:
    // knowledge/graph-store 的 `beforeEach`(mkdtempSync + openKnowledge)在
    // windows-latest 上撞了 vitest 默认的 10s hookTimeout,红了一次、重跑就绿。
    // 那种红最贵的地方不是它本身,是它教人别看 CI —— 见 desktop-e2e 那笔账。
    // 建库这类重活恰恰都在 hook 里,所以这条比 testTimeout 更该抬。
    // 2026-09-19 一并跟着 testTimeout 去掉平台分叉:满载套件里 hook 同样被
    // 放大 5~10 倍,10s 对 mkdtemp + 建库这种活一样没有余量。
    hookTimeout: 20_000,
  },
})
