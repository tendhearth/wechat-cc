/**
 * 没有模块拿整个 ilink(架构终态 A6,docs/architecture-end-state-2026-10-25.md)。
 *
 * ilink 适配器按用途拆成十个窄口(src/ports/wechat.ts:`wechat.send` / `wechat.voice` / `wechat.permissions` …),
 * 由 `ilink-adapter` 模块(src/daemon/ilink/module.ts)经容器的 `ports` 交出去;别的模块 needs 口名,只拿它用的那一口。规矩:
 *  - `IlinkAdapter` 这个类型只在 ilink 自己(ilink-glue.ts 与它的测试、daemon/ilink/**)和组装的地方
 *    (foundation.ts)出现;别处要什么就引哪一口(测试的假对象也一样)。
 *  - `'ilink-adapter'` 这个模块名只在 ilink/module.ts 的那一行 `name:` 里:没有人 needs / wants / lazy 它,
 *    没有人 `ctx.get('ilink-adapter')`。
 *  - 十口都交了:ilink-glue.ts 的 `ILINK_PORTS` 每一口都有,模块上挂着 `ports: ILINK_PORTS`。
 * 零例外:下面的 EXCEPTIONS 是空的。真有一处这一步迁不了,写进去并写明为什么。
 * 注释行不算(按行跳:块注释的正则会被字符串里的 `/*` 吞代码)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 定义 `ilink-adapter` 模块的地方(2026-10-26 从 daemon-modules.ts 搬到 ilink 自己的 module.ts)。 */
const ROOT_FILE = 'src/daemon/ilink/module.ts'

/** ilink 自己 + 组装的地方:可以拿整个 IlinkAdapter。 */
function holdsWholeAdapter(f: string): boolean {
  return f === 'src/daemon/ilink-glue.ts'
    || /^src\/daemon\/ilink-glue(\.[\w-]+)?\.test\.ts$/.test(f)
    || f.startsWith('src/daemon/ilink/')
    || f === 'src/daemon/foundation.ts'
}

/** 这一步迁不了、只好整个拿的地方:文件 → 为什么。零例外。 */
const EXCEPTIONS: Record<string, string> = {}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** 去掉注释行(按行判断),剩下的代码行。 */
function codeLines(src: string): string[] {
  return src.replace(/\r\n/g, '\n').split('\n').filter(l => {
    const t = l.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  })
}

const files = walk(join(ROOT, 'src')).map(f => ({ rel: relative(ROOT, f).split('\\').join('/'), lines: codeLines(readFileSync(f, 'utf8')) }))

describe('没有模块拿整个 ilink(A6)', () => {
  it('扫得到东西(扫不到 ⇒ 守卫瞎了,先红)', () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files.find(f => f.rel === 'src/daemon/ilink-glue.ts')?.lines.some(l => /export interface IlinkAdapter\b/.test(l))).toBe(true)
  })

  it('IlinkAdapter 只在 ilink 自己和组装的地方出现', () => {
    const offenders = files
      .filter(f => !holdsWholeAdapter(f.rel) && !(f.rel in EXCEPTIONS))
      .filter(f => f.lines.some(l => /\bIlinkAdapter\b/.test(l)))
      .map(f => f.rel)
    expect(offenders, '引 src/ports/wechat.ts 里你用到的那一口(WechatSend / WechatPermissions …),别引整个 IlinkAdapter').toEqual([])
  })

  // 标题沿用搬家前的(CI 按标题核测试只增不减);那一行现在在 ROOT_FILE(ilink/module.ts)里
  it("'ilink-adapter' 只在 daemon-modules.ts 的 name 那一行:没有人 needs 它、没有人 ctx.get 它", () => {
    const hits = files.flatMap(f => f.lines.filter(l => /['"`]ilink-adapter['"`]/.test(l)).map(l => `${f.rel}: ${l.trim()}`))
    expect(hits).toEqual([`${ROOT_FILE}: name: 'ilink-adapter',`])
  })

  it('十口都交了:ILINK_PORTS 覆盖 WECHAT_PORTS 的每一口,模块上挂着它', () => {
    const ports = readFileSync(join(ROOT, 'src/ports/wechat.ts'), 'utf8')
    const table = /export const WECHAT_PORTS = \{([\s\S]*?)\} as const/.exec(ports)?.[1] ?? ''
    const keys = [...table.matchAll(/^\s+(\w+): '/gm)].map(m => m[1]!)
    expect(keys.length).toBeGreaterThanOrEqual(10)
    const glue = readFileSync(join(ROOT, 'src/daemon/ilink-glue.ts'), 'utf8')
    const given = /export const ILINK_PORTS = \{([\s\S]*?)\n\}/.exec(glue)?.[1] ?? ''
    expect(keys.filter(k => !given.includes(`[WECHAT_PORTS.${k}]`))).toEqual([])
    expect(readFileSync(join(ROOT, ROOT_FILE), 'utf8')).toMatch(/name: 'ilink-adapter',[\s\S]{0,800}?ports: ILINK_PORTS,/)
  })

  it('例外表里的文件真的还在拿整个 adapter(迁完了就删掉那一行)', () => {
    const stale = Object.keys(EXCEPTIONS).filter(rel => !files.find(f => f.rel === rel)?.lines.some(l => /\bIlinkAdapter\b/.test(l)))
    expect(stale).toEqual([])
  })
})
