/**
 * dependency-cruiser config — enforces module-boundary rules introduced
 * in PR5 of the architecture cleanup. Run via `bun run depcheck`.
 *
 * Layered architecture (top → bottom; higher layers may import lower):
 *
 *   src/cli/           ← CLI subcommand handlers (only `cli.ts` invokes these)
 *   src/daemon/        ← Long-running runtime (ilink, internal-api, schedulers)
 *   src/mcp-servers/   ← Standalone stdio MCP children (talk to daemon via HTTP)
 *   src/core/          ← Provider abstraction, conversation coordinator (no I/O)
 *   src/lib/           ← Shared utilities + send-reply (used by both cli + daemon)
 *
 * Cross-layer rules:
 *   - lib MUST NOT import from cli, daemon, core, mcp-servers (it's the floor)
 *   - core MUST NOT import from cli, daemon, mcp-servers (platform-agnostic)
 *   - mcp-servers MUST NOT import from cli, daemon (talks via internal-api HTTP)
 *   - cli MUST NOT import from daemon (daemon is a runtime, cli is a launcher
 *     of subcommands; if they need the daemon they should spawn it, not link)
 *   - daemon MAY import from cli (for the moment — handoff.ts, etc.). Tighten later.
 *
 * Tests (*.test.ts) are exempt — integration tests legitimately cross
 * boundaries (e.g. mcp-servers/wechat/integration.test.ts spins up the
 * full daemon internal-api).
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies hide architectural mistakes. Refactor. 2026-10-10 清零后升为 error(type-only 也算):Claude 的能力声明在 claude-capabilities.ts、TaskEvent 在 timeline-events.ts。',
      from: {},
      to: { circular: true },
    },
    {
      name: 'workbench-service-no-circular',
      severity: 'error',
      comment: '2026-09-28 workbench service 拆分:service.ts 与 service/<domain>.ts 之间不许有环(type-only 也算);域只认 ctx,动作走 ctx.actions 晚绑定。store 层的环已于 2026-10-10 清零,由 no-circular 兜住。',
      from: { path: '^src/core/workbench/service(/|\\.ts$)' },
      to: { circular: true, viaOnly: { path: '^src/core/workbench/(service(/|\\.ts$)|wechat-control\\.ts$)' } },
    },
    {
      name: 'wechat-control-must-not-link-service',
      severity: 'error',
      comment: '2026-09-28:wechat-control.ts 需要的三个类型在 wechat-types.ts;回头 import ./service 就是环。',
      from: { path: '^src/core/workbench/wechat-control\\.ts$' },
      to: { path: '^src/core/workbench/service\\.ts$' },
    },
    {
      name: 'bun-builtins-only-in-runtime',
      severity: 'error',
      comment: 'Bun 专属模块(bun:sqlite / bun:ffi …)只许出现在 src/lib/runtime/;别处走适配层,保住换运行时的出口(2026-09-16)。测试暂不受限。',
      from: { path: '^src/', pathNot: ['^src/lib/runtime/', '\\.test\\.ts$'] },
      to: { path: '^bun:' },
    },
    {
      name: 'lib-must-not-depend-on-anything-internal',
      severity: 'error',
      comment: 'src/lib/ is the bottom of the dependency tree — utilities only.',
      from: { path: '^src/lib/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(cli|daemon|core|mcp-servers)/' },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment: '架构终态 E1:src/domain 是纯规则(档位、开口、伙伴判定、提示词 ……)。运行时只许依赖 domain 自己和 src/lib 里不碰 I/O 的那些;只引类型可以(core 还没拆完)。零例外。',
      from: { path: '^src/domain/', pathNot: '\\.test\\.ts$' },
      to: {
        path: ['^src/(core|daemon|cli|features|mcp-servers|test-support|adapters|app)/', '^src/lib/(runtime|db|json-file|read-json-file|log|access|agent-config|messages-store|project-registry|ilink|send-reply|config)'],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'ports-are-interfaces',
      severity: 'error',
      comment: '架构终态 E1:src/ports 是接口(执行者的口 AgentProvider / AgentSession 等)。运行时只许依赖 ports、domain 与 lib 里不碰 I/O 的;零例外。',
      from: { path: '^src/ports/', pathNot: '\\.test\\.ts$' },
      to: {
        path: ['^src/(core|app|daemon|cli|features|mcp-servers|test-support|adapters)/', '^src/lib/(runtime|db|json-file|read-json-file|log|access|agent-config|messages-store|project-registry|ilink|send-reply|config)'],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'adapters-implement-ports',
      severity: 'error',
      comment: '架构终态 E2:src/adapters 是对外的实现(各家执行者、以后的 store / git)。不许往上依赖 app / daemon / cli / features / mcp-servers / test-support;只引类型也不行(适配器不该知道用例)。零例外。',
      from: { path: '^src/adapters/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(app|daemon|cli|features|mcp-servers|test-support)/' },
    },
    {
      name: 'app-does-not-reach-up',
      severity: 'error',
      comment: '架构终态 E1:src/app 是用例(协调器、会话管理、执行者登记)。不许往上依赖 daemon / cli / features / mcp-servers / test-support,也不碰 node 内置。过渡期还能用 core 里没搬完的(store、工作台);adapters 搬出来以后收紧成「只经 ports」。',
      from: { path: '^src/app/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(daemon|cli|features|mcp-servers|test-support)/' },
    },
    {
      name: 'app-no-node',
      severity: 'error',
      comment: '架构终态 E1:app 不碰 node / bun 内置。',
      from: { path: '^src/app/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'domain-no-node',
      severity: 'error',
      comment: '架构终态 E1:domain 不碰 node / bun 内置模块。',
      from: { path: '^src/domain/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'test-support-only-from-tests',
      severity: 'error',
      comment: '架构终态 B3:src/test-support 是测试替身(照剧本说话的假执行者 …),生产代码不许 import;测试与 scripts/experiments 才用。',
      from: { path: '^src/', pathNot: ['\\.test\\.ts$', '^src/test-support/'] },
      to: { path: '^src/test-support/' },
    },
    {
      name: 'features-only-from-above',
      severity: 'error',
      comment: '架构终态 A3:src/features/<名> 是一个功能一个目录。core / lib / mcp-servers 是它下面的层,不许反过来依赖功能。',
      from: { path: '^src/(core|lib|mcp-servers)/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/features/' },
    },
    {
      name: 'features-through-their-index',
      severity: 'error',
      comment: '架构终态 A3:功能目录外面(daemon、别的功能)只经 src/features/<名>/index.ts 用它;目录里的文件是它自己的事。测试不受限。',
      from: { pathNot: ['^src/features/([^/]+)/', '\\.test\\.ts$'] },
      to: { path: '^src/features/[^/]+/(?!index\\.ts$)' },
    },
    {
      name: 'features-not-into-each-other',
      severity: 'error',
      comment: '架构终态 A3:一个功能不许伸进另一个功能的内部文件;要用就经对方的 index.ts(并在模块清单里 needs 它)。',
      from: { path: '^src/features/([^/]+)/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/features/(?!$1/)[^/]+/(?!index\\.ts$)' },
    },
    {
      name: 'core-must-not-depend-on-runtime',
      severity: 'error',
      comment: 'src/core/ is platform-agnostic; runtime modules (cli/daemon/mcp) belong above it.',
      from: { path: '^src/core/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(cli|daemon|mcp-servers)/' },
    },
    {
      name: 'mcp-servers-must-not-link-daemon',
      severity: 'error',
      comment: 'MCP servers are independent stdio subprocesses — they talk to the daemon over HTTP, not by linking.',
      from: { path: '^src/mcp-servers/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(cli|daemon)/' },
    },
    {
      name: 'cli-commands-may-link-daemon-for-now',
      severity: 'warn',
      comment: '2026-09-27 cli.ts 拆分:命令体从根 cli.ts 搬进 src/cli/commands/ 时把 39 处 daemon 动态 import 一起带了过来。这是搬家前就存在的耦合,不是许可;总数由 scripts/cli-ratchet.guard.test.ts 钉住只降不升,真正解耦另立项。',
      from: { path: '^src/cli/commands/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/daemon/' },
    },
    {
      name: 'cli-must-not-depend-on-daemon',
      severity: 'error',
      comment: 'CLI subcommand handlers are short-lived; they should spawn the daemon, not link to its internals.',
      from: { path: '^src/cli/', pathNot: ['\\.test\\.ts$', '^src/cli/commands/'] },
      to: { path: '^src/daemon/' },
    },
    {
      name: 'mobile-page-talks-http-only',
      severity: 'error',
      comment: '手机页(apps/mobile)只通过 /m/api/* 跟 daemon 说话,源码与构建脚本不链接 src/(2026-09-24)。',
      from: { path: '^apps/mobile/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/' },
    },
    {
      name: 'daemon-reads-mobile-only-via-generated',
      severity: 'error',
      comment: 'daemon 只吃 src/daemon/mobile-page.generated.json;import apps/mobile 在本地能跑,编译后的 sidecar 没有源码树就挂了。',
      from: { path: '^src/', pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/mobile/' },
    },
    {
      name: 'inbound-must-not-link-main',
      severity: 'error',
      comment: 'inbound mw 通过工厂注入 deps，不能 import main.ts',
      from: { path: '^src/daemon/inbound/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/daemon/main\\.ts$' },
    },
    {
      name: 'inbound-must-not-link-other-lifecycle',
      severity: 'error',
      comment: 'inbound mw 不能 import 其他子系统的 lifecycle 文件',
      from: { path: '^src/daemon/inbound/', pathNot: '\\.test\\.ts$' },
      to: { path: '(lifecycle\\.ts$|-lifecycle\\.ts$)' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Unreachable files are usually dead code. Verify and delete. apps/mobile/src 是经典脚本,由构建期 {{>…}} 包含而非 import —— 天生"孤儿"。',
      from: { orphan: true, pathNot: ['(\\.test\\.ts|\\.d\\.ts|tsconfig\\.json|\\.dependency-cruiser\\.cjs)$', '^apps/mobile/src/'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '(node_modules|docs/spike|apps/desktop/src-tauri|dist)',
    },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
}
