// 变异测试(StrykerJS + vitest runner)—— 定期跑的「测试到底护住了什么」传感器,不进 verify / 每个 PR 的 CI。
// 怎么跑、什么时候跑:docs/maintainer/verify.md「变异测试」。基线:docs/maintainer/mutation-baseline-2026-10.md。
//
// 依赖在 tools/mutation/(独立 package.json + bun.lock,不进根 workspace):Stryker 10 带 @babel/core 8,装进根
// lockfile 会把 bun 隔离安装的兜底目录 node_modules/.bun/node_modules/@babel/core 从 7 换成 8,手机 app 那边的
// Expo / Metro 有可能靠它兜底解析;为一个定期传感器冒这个险不值。
//
// 跑在 Node 上(Stryker 进程里直接起 vitest),所以用 vitest.node.config.ts —— 跟 CI 的 `node · core suite` 同一份。
//
// 只变异最要紧的纯逻辑。
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: {
    configFile: 'vitest.node.config.ts',
    // 只跑 import 图上牵连到被变异文件的测试(vitest --related)。
    related: true,
  },
  mutate: [
    // 「能不能做」的唯一判定 + 它组合的那几层
    'src/domain/authorize.ts',
    'src/domain/policy.ts',
    'src/domain/tool-decision.ts',
    'src/domain/user-tier.ts',
    // 主人的放行规则:红线 / 低风险初审 / 规则匹配 / 路径归一 / 对话侧
    'src/adapters/permission-rules/decide.ts',
    'src/adapters/permission-rules/floor.ts',
    'src/adapters/permission-rules/paths.ts',
    'src/adapters/permission-rules/chat.ts',
    'src/adapters/permission-rules/rules-file.ts',
    // 记忆:渲染 / 纠错撤回 / 事实
    'src/domain/memory/render.ts',
    'src/domain/memory/corrections.ts',
    'src/domain/memory/facts.ts',
    // 迁移 runner(src/lib/db.ts)单独一份配置:stryker.db.config.mjs(为什么见那边)。
  ],
  // 沙箱(.stryker-tmp/sandbox-*)自己做一个 git 根:有测试断言「cwd 就是仓库根」(permission-gate.test.ts 的 projectRootOf)。
  buildCommand: 'git init -q',
  // 只给被变异的源码加 // @ts-nocheck(默认会去碰 apps/mobile 的 .html 模板,解析不了)。
  disableTypeChecks: 'src/**/*.ts',
  // perTest:每个变异只跑覆盖到它的那几条测试,快一个量级。
  coverageAnalysis: 'perTest',
  // 主人在用这台机器:默认 2 个 worker(load 过 20 就别跑),机器空着可以 --concurrency 6。
  concurrency: 2,
  // 满载机器上测试会被放大 5~10 倍(vitest.config.ts 的注释);超时判成 Timeout 不算存活,但太紧会把正常的判成超时。
  timeoutMS: 20_000,
  timeoutFactor: 2,
  // 首轮(不变异,跑一遍牵连到的 4000 多条测试、记覆盖)在空闲机器上约 4 分钟;默认 5 分钟上限在主人用机时会被打穿。
  dryRunTimeoutMinutes: 30,
  // 沙箱不复制手机原生 app、桌面的 Rust 壳、本工具目录(src/ 有 import apps/desktop/src/shared 的,docs 有测试在读)。
  ignorePatterns: [
    // gitignore 写法,一律从仓库根锚定(不锚的 'reports' 会顺手把 src/features/reports 也扔了)。
    '/apps/app', '/apps/desktop/src-tauri', '/tools', '/.claude', '/reports', '*.log',
  ],
  reporters: ['clear-text', 'progress', 'html', 'json'],
  // 终端里只要分数表;哪一行哪个变异活下来看 HTML 报告(逐条列出来上千行)。
  clearTextReporter: { reportTests: false, reportMutants: false },
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  thresholds: { high: 80, low: 60, break: null },
  // 增量:中断了接着跑、下次只重测改过的文件 / 测试(--force 全量重来)。
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
}
