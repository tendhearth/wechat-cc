/**
 * Unit-suite hermeticity against the operator's machine.
 *
 * Bundled-plugin discovery (`bundledPluginsDir()`) falls back to the repo's
 * own `plugins/` dir, so a dev box with e.g. `plugins/wxsearch/.venv`
 * installed makes wxsearch enabled+ready inside EVERY test that calls
 * buildBootstrap — and assertions like `mcpServers == {}` or "no
 * knowledge-orchestration section" only pass on machines without the venv.
 * Point discovery at a fresh empty temp dir by default; tests that exercise
 * bundled discovery (bootstrap.test.ts's wxsearch fixture / empty-dir cases)
 * already set and restore this env themselves, which overrides this default.
 *
 * Same posture as vitest.config.ts's WECHAT_DISABLE_LOG_FILE: tests must
 * never see (or touch) the operator's real install.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

if (!process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR) {
  process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = mkdtempSync(join(tmpdir(), 'wcc-test-no-bundled-plugins-'))
}

/**
 * `vi.waitFor` 的缺省上限跟 `expect.poll` 对齐(见 vitest.config.ts 的 `expect.poll.timeout`)。
 *
 * 2026-09-27 那次只抬了 `expect.poll` 的缺省 1s,`vi.waitFor` 没有对应的配置项,于是 18 个文件
 * 里 100 多处 `await vi.waitFor(...)` 还停在空闲机器的 1000ms 口径。2026-10-01 windows-latest:
 * service-review.test.ts「只看 review mime 的成果」红在 `expected 'queued' to be 'completed'` ——
 * 等的是一整轮真的工作台执行(排队 → 起执行者 → 落事件 → 收工,几十次 SQLite 写),任务没毛病,
 * 是测试 1 秒就放弃了。本机给假执行者的 spawn 注入 1.1s 延迟即稳定复现(该文件
 * 20 条红 15 条),本改动后 20/20 绿。条件一成立就立刻返回,只有真等不到才多等;别去逐处加 `{ timeout }`。
 * 显式传了 timeout(数字或对象)的照旧用它自己的。
 */
const WAIT_FOR_DEFAULT_TIMEOUT_MS = 10_000
const originalWaitFor = vi.waitFor.bind(vi)
vi.waitFor = ((callback: Parameters<typeof vi.waitFor>[0], options?: Parameters<typeof vi.waitFor>[1]) =>
  originalWaitFor(callback, typeof options === 'number' ? options : { timeout: WAIT_FOR_DEFAULT_TIMEOUT_MS, ...options })) as typeof vi.waitFor
