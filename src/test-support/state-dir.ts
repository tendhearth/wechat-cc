/**
 * 测试用的状态目录:建一个临时目录,把 `WECHAT_STATE_DIR` 指过去,文件跑完还原并删掉。
 *
 * 不用 `vi.mock('…/lib/config')` 去改 STATE_DIR(2026-10-27 清内部 mock):读状态目录的地方(access.ts 等)
 * 本来就在**调用时**读 `WECHAT_STATE_DIR`(见 lib/access-path.test.ts),e2e 起 daemon 走的也是这条;
 * 而 vi.mock 在 bun 原生 runner 下不一定生效 —— 2026-07-26 access.test.ts 就是这样把夹具写进了主人真的
 * access.json(见 lib/config.ts 的 TEST-RUNNER GUARD)。环境变量两个 runner 都认。
 *
 * 在测试文件顶层调用(要注册文件级的 afterAll)。同一个文件里别再手动改 `WECHAT_STATE_DIR`。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

export function useTempStateDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const prev = process.env.WECHAT_STATE_DIR
  process.env.WECHAT_STATE_DIR = dir
  afterAll(() => {
    if (prev === undefined) delete process.env.WECHAT_STATE_DIR
    else process.env.WECHAT_STATE_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}
