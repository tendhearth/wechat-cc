/**
 * provider 枚举的**接缝守卫**(2026-09-27,梳理第 3 步)。
 *
 * 加一家 provider 要碰约 12 处,其中至少 8 份是各自手抄的 id 名单。这里只钉
 * 「每份名单都以 src/lib/provider-ids.ts 为准」:少一家 = 该处功能对新家沉默,
 * 多一家 = 引用不存在的 id。能力矩阵完整性此前只在 boot 时断言,测试里没有。
 *
 * 这些断言不测逻辑,测的是「这几份名单还对得上同一组 id」。
 */
import { EXECUTOR_FACTS } from '../src/lib/executor-facts'
import { executorNames } from '../src/core/provider-display-names'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_IDS } from '../src/lib/provider-ids'
import { capabilitiesFor } from '../src/core/capability-matrix'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const IDS = [...PROVIDER_IDS].sort()

describe('provider 名单都以 provider-ids.ts 为准', () => {
  it('能力矩阵每家一行(capabilitiesFor 对未知 id 会 throw)', () => {
    for (const id of PROVIDER_IDS) expect(() => capabilitiesFor(id)).not.toThrow()
  })

  it('每家都有自己的名字(lib/executor-facts 的 names;不靠首字母大写兜底)—— 收敛清单 ⑥', () => {
    for (const id of PROVIDER_IDS) {
      const n = EXECUTOR_FACTS[id].names
      expect(n.name.length * n.short.length * n.settings.length, id).toBeGreaterThan(0)
      expect(executorNames(id), id).toEqual(n)
    }
  })

  // 桌面 view.js 的 PROVIDER_LABELS 已删(收敛清单 ⑥):三端不存名字表,见 executor-display-names.guard.test.ts。

  // 第三批 3d 起 mode-commands 认的 /词从行表推出来,provider 那行直接取 PROVIDER_SLASH(以前是手写的 KNOWN_SLASH_COMMANDS 首行)。
  // 守卫的意思不变:微信里切 provider 的斜杠词 = provider-ids 的斜杠形式。
  it('mode-commands.ts 的 provider 那行取自 PROVIDER_SLASH(不手写),而 PROVIDER_SLASH = provider-ids 的斜杠形式', async () => {
    const src = read('src', 'daemon', 'mode-commands.ts')
    expect(src, 'mode-commands 的 provider 行不再取 PROVIDER_SLASH —— 别回到手写的斜杠词表').toMatch(/\{ id: 'provider', words: Object\.values\(PROVIDER_SLASH\)/)
    const { PROVIDER_SLASH } = await import('../src/core/provider-policy')
    // 两个历史命名:claude 的斜杠是 /cc,openai 的是 /api;其余同名
    const SLASH_OF: Record<string, string> = { claude: 'cc', openai: 'api' }
    const expected = IDS.map(id => SLASH_OF[id] ?? id).sort()
    expect(Object.values(PROVIDER_SLASH).sort()).toEqual(expected)
  })

  it('桌面「选择已有账号」芯片只列订阅 CLI 三家,且都是真 id', () => {
    const src = read('apps', 'desktop', 'src', 'main.js')
    const m = /\['claude','codex','cursor'\]\.map/.exec(src)
    expect(m, 'main.js nb-cli 芯片列表形状变了,更新这条守卫').toBeTruthy()
    for (const id of ['claude', 'codex', 'cursor']) expect(IDS).toContain(id)
  })
})
