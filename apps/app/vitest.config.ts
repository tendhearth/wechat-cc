import { TASK_CACHE_GLOBS } from '../../scripts/task-cache-paths'
import { configDefaults, defineConfig } from 'vitest/config'
export default defineConfig({ test: {
    exclude: [...configDefaults.exclude, ...TASK_CACHE_GLOBS], include: ['src/**/*.test.ts', 'plugins/**/*.test.ts', 'scripts/**/*.test.ts'], environment: 'node' } })
