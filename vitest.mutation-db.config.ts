import base from './vitest.node.config'

/**
 * 只给 stryker.db.config.mjs 用(变异测试的迁移 runner 那一份):库层自己的测试 + 迁移守卫。
 * 不用 mergeConfig —— 它会把 include 数组拼起来,等于没收窄。
 */
export default {
  ...base,
  test: {
    ...base.test,
    include: ['src/lib/*.test.ts', 'src/adapters/knowledge/**/*.test.ts', 'scripts/db-migrations.guard.test.ts'],
  },
}
