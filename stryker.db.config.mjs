// 变异测试第二份:迁移 runner(src/lib/db.ts)。`bun run test:mutation` 跑完 stryker.config.mjs 接着跑这份。
//
// 为什么单独一份:几乎每个开库的测试都 import db.ts(vitest --related 牵出 5500 多条),而 db.ts 的模块级常量
// (static 变异)每改一处都得把覆盖到它的测试全跑一遍 —— 2026-10 基线里放在主配置里跑了一个半小时还没跑完;
// 只跑库层自己的测试,同样 91 个变异 3 分钟跑完,runMigrations 主循环的变异照样全死。
// 测得的是「库层测试护住了 runner 的哪些地方」,不是「整套测试」—— 一个 store 测试因为开不了库而红,不算护住了 runner。
//
// src/lib/db/migrations/ 下的冻结迁移**不变异**(一字不许改);这里只变异跑迁移的 runner。
import base from './stryker.config.mjs'

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: ['src/lib/db.ts'],
  vitest: { configFile: 'vitest.mutation-db.config.ts', related: true },
  htmlReporter: { fileName: 'reports/mutation/db/index.html' },
  jsonReporter: { fileName: 'reports/mutation/db/mutation.json' },
  incrementalFile: 'reports/mutation/db/stryker-incremental.json',
}
