import {describe, expect, it} from 'vitest'
import {readFileSync, readdirSync, statSync} from 'node:fs'
import {join, relative, resolve} from 'node:path'

/**
 * 运行时差异只许出现在 src/lib/runtime/(2026-09-16 定案,见 bun-portability-plan)。
 * depcruise 管得住 `import 'bun:*'`,管不住 `Bun.serve` 这种全局 —— 这里补上。
 * 白名单里每一条都要写清为什么还留着。
 */
const ALLOW: Record<string, string> = {
  'src/daemon/yi-ws-server.ts': 'WebSocket 服务端:Node 没有原生实现,换运行时时要引 ws 包;先留 Bun.serve。',
}

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) { if (name !== 'runtime' && name !== '__e2e__') yield* sources(path); continue }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) yield path
  }
}
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(line => !/^\s*(\/\/|\*)/.test(line)).map(line => line.replace(/\s\/\/.*$/, '')).join('\n')

describe('Bun globals stay inside src/lib/runtime', () => {
  const root = resolve(__dirname, '../../..')
  const offenders: string[] = []
  for (const file of sources(join(root, 'src'))) {
    const rel = relative(root, file).split('\\').join('/')
    if (rel.startsWith('src/lib/runtime/')) continue
    const body = stripComments(readFileSync(file, 'utf8'))
    if (/\bBun\.\w+|from ['"]bun:/.test(body) && !ALLOW[rel]) offenders.push(rel)
  }
  it('every direct use of Bun.* or bun:* outside the runtime layer is on the allow-list', () => {
    expect(offenders).toEqual([])
  })
})
