import { TASK_CACHE_GLOBS } from './scripts/task-cache-paths'
import { defineConfig } from 'vitest/config'

// Local-only config for running the eval harness's own unit tests.
// Default vitest config excludes eval/** so `bun run test` skips the slow
// real-SDK suite; this config opts back in by removing that exclude.
// Not invoked by CI — used during eval-harness development only.
export default defineConfig({
  test: {
    exclude: [...TASK_CACHE_GLOBS,'**/node_modules/**'],
  },
})
