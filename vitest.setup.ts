/**
 * Keep live-process plugin discovery off the operator's checkout. Since the
 * 2026-09-30 resolver fix, an empty env directory correctly falls through;
 * it cannot serve as a product-level "disable bundled plugins" switch.
 * Only replace the machine inputs. The real resolver, registry, env fixture
 * overrides, owner pointers and pure app/repo resolution tests still run.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, vi } from 'vitest'

const pluginTestRoot = mkdtempSync(join(tmpdir(), 'wcc-test-plugin-source-'))
const inheritedBundledEnv = process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
// Do not inherit a real install. Tests may set/restore their own fixture env.
process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = pluginTestRoot

vi.mock('./src/lib/plugins-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./src/lib/plugins-source')>()
  return {
    ...actual,
    resolveBundledPlugins: (stateDir?: string) => actual.resolveBundledPluginsDir({
      env: process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR || undefined,
      stateDir,
      compiled: false,
      execPath: join(pluginTestRoot, 'test-runtime'),
      sourceRepoRoot: pluginTestRoot,
    }),
  }
})

afterAll(() => {
  if (inheritedBundledEnv === undefined) delete process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR
  else process.env.WECHAT_CC_BUNDLED_PLUGINS_DIR = inheritedBundledEnv
  rmSync(pluginTestRoot, { recursive: true, force: true })
})

/**
 * 守护按 codex 自己的配置层判 Codex 的端点(lib/codex-target.ts,2026-10-03)。不给测试一个空的
 * CODEX_HOME,凡是分类 codex 的测试都会去读主人真的 ~/.codex/config.toml —— 结果随机器而变。
 * 需要特定 codex 配置的测试自己建临时目录、显式传 env。
 */
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'wcc-test-empty-codex-home-'))

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
