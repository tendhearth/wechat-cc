import { TASK_CACHE_GLOBS } from '../../scripts/task-cache-paths'
import { configDefaults, defineConfig } from 'vitest/config'

// 端到端:plain node 下跑(不是 workerd 池),Worker 由 wrangler unstable_startWorker 在本地 workerd 起。
export default defineConfig({ test: {
    exclude: [...configDefaults.exclude, ...TASK_CACHE_GLOBS], include: ['test/e2e/**/*.e2e.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 } })
