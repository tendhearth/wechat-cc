/**
 * mock 只许替身系统边界(docs/maintainer/verify.md「跨模块的行为至少一条走真实接线」)—— 按文件数 mock 了自己内部模块的次数,只许降。
 *
 * 单测里 mock 内部模块测的是「我以为它们怎么接」,接错了照样绿(2026-10-26 #729:boot-api 多取一样没登记的东西,单测全绿、真机开机三连败)。
 * 判法在 scripts/mock-internal-lib.ts:`vi.mock` / `vi.doMock` / bun `mock.module` 的目标按所在文件解析;node 内置、npm 包、
 * src/adapters/**、src/test-support/**、`*.test-support.*`、BOUNDARY_FILES 里写了理由的几个真边界放行,仓库里其余的都算内部;
 * spec 不是字面量也算内部。全仓库扫(测试、`__e2e__` 的 fake、vitest.setup 都在内);注释按行跳过。
 *  - **没登记的文件出现内部 mock ⇒ 红**:换成真模块、经参数 / 端口注入的假实现,或者走沙盒 / `__e2e__` 的真接线。
 *  - **登记过的文件次数只许降**:多一处红;少了也红,提示你把数字调下来(棘轮),降到 0 的行删掉。
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BOUNDARY_FILES, ROOT, classify, findMocks, scanInternalMocks } from './mock-internal-lib'

// 2026-10-26 基线(按文件)。清掉一处减一;清完的行删掉。
// @debt mock 了自己内部模块的测试(降到 0 = 只在系统边界替身)
const BASELINE: Record<string, number> = {
  'apps/app/src/state/activity-screen.test.ts': 4,
  'apps/app/src/state/chat-feedback.test.ts': 7,
  'apps/app/src/state/compose-input.test.ts': 4,
  'apps/app/src/state/home-motion.test.ts': 12,
  'apps/app/src/state/quiet-lists.test.ts': 6,
  'apps/app/src/state/session-durable.test.ts': 1,
  'apps/app/src/state/session-reading.test.ts': 5,
  'apps/app/src/state/useChat.status.test.ts': 1,
  'apps/app/src/ui/CCFigure.test.ts': 1,
  'apps/app/src/ui/HoldToTalk.feedback.test.ts': 1,
  'apps/app/src/ui/Markdown.test.ts': 4,
  'apps/app/src/ui/motion.test.ts': 1,
  'apps/app/src/ui/quiet-status.test.ts': 3,
  'apps/app/src/ui/StatusHint.test.ts': 1,
  'apps/desktop/src/modules/dialogue-page-recovery.test.ts': 1,
  'apps/desktop/src/modules/journal.reading.test.ts': 1,
  'apps/desktop/src/modules/journal.test.ts': 1,
  'apps/desktop/src/modules/memory.summary.test.ts': 4,
  'apps/desktop/src/modules/memory.test.ts': 4,
  'apps/desktop/src/modules/people.test.ts': 1,
  'apps/desktop/src/modules/postcard-album.test.ts': 1,
  'apps/desktop/src/modules/todos.test.ts': 1,
  'apps/desktop/src/modules/wishes.test.ts': 1,
  'apps/desktop/src/modules/workbench.test.ts': 1,
  'src/daemon/__e2e__/fake-media.ts': 1,
  'src/daemon/bootstrap.test.ts': 1,
  'src/daemon/ilink-glue.media-mirror.test.ts': 2,
  'src/daemon/wiring/pipeline-deps-delegate-selfid.test.ts': 1,
  'src/daemon/wiring/pipeline-deps-native-history.test.ts': 2,
  'src/daemon/wiring/pipeline-deps-pet.test.ts': 1,
  'src/daemon/wiring/pipeline-deps-phone-chat.test.ts': 1,
  'src/features/memory/llm-ops.test.ts': 2,
  'src/features/phone/settings-panel-link.test.ts': 1,
  'src/features/phone/settings-panel-phone-link.test.ts': 1,
  'src/features/workbench/service-checkpoints-deadline.test.ts': 1,
  'src/features/workbench/wire.test.ts': 1,
  'vitest.setup.ts': 1,
}

// 夹具里的调用拼出来写,免得这份守卫自己被扫到
const VM = 'vi' + '.mock'

describe('mock 只许替身系统边界:内部模块的 mock 只许减少', () => {
  const now = scanInternalMocks()
  it('没登记的文件不许 mock 内部模块(真模块 / 注入假实现 / 沙盒,三选一)', () => {
    const fresh = Object.entries(now).filter(([f]) => !(f in BASELINE)).map(([f, t]) => `${f}: ${t.join(', ')}`)
    expect(fresh).toEqual([])
  })
  it('登记过的文件:多了红;少了也红(把 BASELINE 的数字调下来,清完的行删掉)', () => {
    const drift: string[] = []
    for (const [f, want] of Object.entries(BASELINE)) {
      const got = now[f]?.length ?? 0
      if (got !== want) drift.push(`${f}: 登记 ${want},现在 ${got}${got < want ? '(少了:把基线调下来)' : ''}`)
    }
    expect(drift).toEqual([])
  })
  it('BOUNDARY_FILES 里的文件都还在(删了或搬了就把条目也改掉)', () => {
    const gone = Object.keys(BOUNDARY_FILES).filter(p => !['.ts', '.tsx', '.js'].some(ext => existsSync(join(ROOT, p + ext))))
    expect(gone).toEqual([])
  })
})

describe('判法本身', () => {
  const at = 'src/daemon/inbound/x.test.ts'
  const kinds = (text: string) => findMocks(text).map(m => classify(at, m.spec).internal)
  it('内部模块算、边界放行', () => {
    expect(kinds(`${VM}('../../domain/authorize')`)).toEqual([true])
    expect(kinds(`${VM}('../../lib/config.ts', async () => ({}))`)).toEqual([true])
    expect(kinds(`${VM}('@wechat-cc/protocol')`)).toEqual([true])
    expect(kinds(`${VM}('node:fs')\n${VM}('child_process')\nvi.doMock('@anthropic-ai/claude-agent-sdk')\nmock.module('../../adapters/a2a/a2a-client', () => ({}))`))
      .toEqual([false, false, false, false])
    expect(kinds(`${VM}('../../lib/ilink')\n${VM}('../../test-support/x')`)).toEqual([false, false])
  })
  it('spec 不是字面量:认不出来就不放', () => {
    expect(kinds(`${VM}(target)\n${VM}(\`../\${x}\`)\n${VM}(\n  '../../lib/access'\n)`)).toEqual([true, true, true])
  })
  it('注释按行跳过;字符串里的 /* 不吞掉后面的真调用', () => {
    expect(kinds(`// ${VM}('../../lib/access')\n * ${VM}('../../lib/access')\nconst g = 'src/*.ts'\n${VM}('../../lib/access')`)).toEqual([true])
  })
  it('真仓库里也认得出(活体抽查:登记过的一个文件确实有内部 mock)', () => {
    expect(scanInternalMocks()['src/daemon/bootstrap.test.ts']).toEqual(['src/daemon/bootstrap/wire-self-restart'])
  })
})
