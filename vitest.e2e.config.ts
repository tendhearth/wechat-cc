import { TASK_CACHE_GLOBS } from './scripts/task-cache-paths'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...TASK_CACHE_GLOBS],
    include: ['src/daemon/__e2e__/**/*.e2e.test.ts'],
    fileParallelism: false,
    // 每个文件第一次 startTestDaemon 都要冷启动 import 整个 daemon(harness 故意动态 import,好让各文件的 vi.mock 先登记,
    // 所以没法在 setupFiles 里预热)。满载下这一下就能超过 10s(10-21 dispatch-solo-claude、boot-failure-lock 假红)。
    // 30s:真挂死仍然会红,只是晚 20s。
    testTimeout: 30_000,
    hookTimeout: 15_000,
    sequence: { concurrent: false },
  },
})
