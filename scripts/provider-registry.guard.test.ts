/**
 * provider 枚举的**接缝守卫**(2026-09-27,梳理第 3 步)。
 *
 * 加一家 provider 要碰约 12 处,其中至少 8 份是各自手抄的 id 名单。这里只钉
 * 「每份名单都以 src/lib/provider-ids.ts 为准」:少一家 = 该处功能对新家沉默,
 * 多一家 = 引用不存在的 id。能力矩阵完整性此前只在 boot 时断言,测试里没有。
 *
 * 这些断言不测逻辑,测的是「这几份名单还对得上同一组 id」。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_IDS } from '../src/lib/provider-ids'
import { capabilitiesFor } from '../src/core/capability-matrix'
import { providerDisplayName } from '../src/core/provider-display-names'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')
const IDS = [...PROVIDER_IDS].sort()

describe('provider 名单都以 provider-ids.ts 为准', () => {
  it('能力矩阵每家一行(capabilitiesFor 对未知 id 会 throw)', () => {
    for (const id of PROVIDER_IDS) expect(() => capabilitiesFor(id)).not.toThrow()
  })

  it('展示名表 KNOWN_NAMES 的键集合 = provider-ids(不靠首字母大写兜底)', () => {
    const src = read('src', 'core', 'provider-display-names.ts')
    const m = /const KNOWN_NAMES[^=]*=\s*Object\.freeze\(\{([^}]+)\}/.exec(src)
    expect(m, 'provider-display-names.ts 里找不到 KNOWN_NAMES').toBeTruthy()
    const keys = [...m![1]!.matchAll(/(\w+)\s*:/g)].map(x => x[1]!).sort()
    expect(keys).toEqual(IDS)
    for (const id of PROVIDER_IDS) expect(providerDisplayName(id).length).toBeGreaterThan(0)
  })

  it('桌面 dashboard.js 的 PROVIDER_LABELS 键集合 = provider-ids', () => {
    const src = read('apps', 'desktop', 'src', 'modules', 'dashboard.js')
    const m = /const PROVIDER_LABELS = \{([^}]+)\}/.exec(src)
    expect(m, 'dashboard.js 里找不到 PROVIDER_LABELS').toBeTruthy()
    const keys = [...m![1]!.matchAll(/(\w+)\s*:/g)].map(x => x[1]!).sort()
    expect(keys).toEqual(IDS)
  })

  it('mode-commands.ts 的 KNOWN_SLASH_COMMANDS 首行(isProviderCommand)= provider-ids 的斜杠形式', () => {
    const src = read('src', 'daemon', 'mode-commands.ts')
    const m = /const KNOWN_SLASH_COMMANDS = new Set\(\[\s*([^\n]+)\/\/ isProviderCommand/.exec(src)
    expect(m, '找不到 KNOWN_SLASH_COMMANDS 的 isProviderCommand 行').toBeTruthy()
    const slashes = [...m![1]!.matchAll(/'(\w+)'/g)].map(x => x[1]!).sort()
    // 两个历史命名:claude 的斜杠是 /cc,openai 的是 /api;其余同名
    const SLASH_OF: Record<string, string> = { claude: 'cc', openai: 'api' }
    const expected = IDS.map(id => SLASH_OF[id] ?? id).sort()
    expect(slashes).toEqual(expected)
  })

  it('桌面「选择已有账号」芯片只列订阅 CLI 三家,且都是真 id', () => {
    const src = read('apps', 'desktop', 'src', 'main.js')
    const m = /\['claude','codex','cursor'\]\.map/.exec(src)
    expect(m, 'main.js nb-cli 芯片列表形状变了,更新这条守卫').toBeTruthy()
    for (const id of ['claude', 'codex', 'cursor']) expect(IDS).toContain(id)
  })
})
