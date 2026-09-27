import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HELP_TEXT } from './help'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli.ts')

describe('HELP_TEXT 与 SUBCOMMANDS 对得上', () => {
  it('SUBCOMMANDS 的每个键都在 HELP_TEXT 里出现(反向不要求)', () => {
    const src = readFileSync(CLI, 'utf8')
    const start = src.indexOf('const SUBCOMMANDS = {')
    const end = src.indexOf('} as const', start)
    const names = [...src.slice(start, end).matchAll(/^\s+'?([a-z][a-z-]*)'?:/gm)].map(m => m[1]!)
    expect(names.length).toBeGreaterThan(30)
    const missing = names.filter(n => !new RegExp(`(^|\\s)${n}(\\s|$)`, 'm').test(HELP_TEXT))
    expect(missing, 'SUBCOMMANDS 里有、HELP_TEXT 里没提的命令').toEqual([])
  })
})
