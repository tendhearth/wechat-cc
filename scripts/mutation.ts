/**
 * `bun run test:mutation [-- <stryker 参数>]`:变异测试,定期跑的传感器(不进 verify / 每个 PR 的 CI)。
 * 先装 tools/mutation 的独立依赖,再依次跑 stryker.config.mjs(权限 / 红线 / 记忆)和 stryker.db.config.mjs(迁移 runner),
 * 后面的参数(`--concurrency 6`、`--force`)两份都带上。怎么读结果:docs/maintainer/verify.md「变异测试」。
 */
import { spawnSync } from 'node:child_process'

const extra = process.argv.slice(2)
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
run('bun', ['install', '--cwd', 'tools/mutation', '--frozen-lockfile', '--no-summary'])
const stryker = 'tools/mutation/node_modules/@stryker-mutator/core/bin/stryker.js'
for (const config of ['stryker.config.mjs', 'stryker.db.config.mjs']) run('node', [stryker, 'run', config, ...extra])
