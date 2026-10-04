/**
 * cli.ts 拆分的**行为不变**守卫(2026-09-27,spec 2026-09-27-cli-split-design §5)。
 *
 * 1) 每个子命令(含子子命令)`--help` 的输出逐字节快照 —— 搬家改了名字/参数/描述立刻红;
 * 2) 几条只读 `--json` 命令真的跑一遍 —— `--help` 不执行 run(),动态 import 路径写错只有这里抓得到;
 * 3) 搬走的文件里不许有 `import.meta.main`。
 * 只在 bun 套件跑(vitest.node.config 不含 scripts/)。
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'cli.ts')
// 只读命令的 STATE_DIR 放系统临时目录:doctor / status 会开 sqlite,别把 .db 写进 checkout。
const STATE_DIR = mkdtempSync(join(tmpdir(), 'cli-help-guard-'))

function run(args: string[]): { code: number; out: string } {
  const r = spawnSync('bun', [CLI, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, NO_COLOR: '1', WECHAT_STATE_DIR: STATE_DIR },
  })
  return { code: r.status ?? -1, out: ((r.stdout ?? '') + (r.stderr ?? '')).replace(/\r\n/g, '\n') }
}

/** 从 cli.ts 源码读 SUBCOMMANDS 的键(不 import cli.ts —— import 会执行顶层代码)。 */
function subcommandNames(): string[] {
  const src = readFileSync(CLI, 'utf8')
  const start = src.indexOf('const SUBCOMMANDS = {')
  const end = src.indexOf('} as const', start)
  return [...src.slice(start, end).matchAll(/^\s+'?([a-z][a-z-]*)'?:/gm)].map(m => m[1]!)
}

/** 有子子命令的族:`<name> --help` 输出里的 COMMANDS 段列出它们。 */
function childrenOf(helpOut: string): string[] {
  const m = /COMMANDS\n([\s\S]*?)(?:\n\n|$)/.exec(helpOut)
  if (!m) return []
  return [...m[1]!.matchAll(/^\s+([a-z][a-z-]*)\s/gm)].map(x => x[1]!)
}

describe('cli.ts --help 快照(逐字节)', () => {
  it('root --help', () => {
    const r = run(['--help'])
    expect(r.code).toBe(0)
    expect(r.out).toMatchSnapshot()
  })
  for (const name of subcommandNames()) {
    it(`${name} --help`, () => {
      const r = run([name, '--help'])
      expect(r.code, r.out).toBe(0)
      expect(r.out).toMatchSnapshot()
      for (const child of childrenOf(r.out)) {
        const c = run([name, child, '--help'])
        expect(c.code, c.out).toBe(0)
        expect(c.out).toMatchSnapshot(`${name} ${child} --help`)
      }
    })
  }
})

describe('只读命令真的跑(动态 import 路径)', () => {
  const READ_ONLY: string[][] = [
    ['status', '--json'], ['doctor', '--json'], ['provider', 'show', '--json'],
    ['access', 'list', '--json'], ['license', 'status', '--json'], ['backup', 'list', '--json'],
    ['setup-status', '--json'],
    // 只跑各 CLI 的 `--version`(只读);不带 --check,不出门。
    ['cli', 'status', '--json'],
    // 不放 `guard status`:它真的探公网 IP(fetchPublicIp / probeReachable),单测套件不上网。
  ]
  for (const args of READ_ONLY) {
    it(args.join(' '), () => {
      const r = run(args)
      // 只要求退出码 0、有输出(内容随机器状态变,不快照;`status` / `backup list`
      // 没有 --json 也照跑 —— 要抓的是动态 import 路径,不是输出格式)。
      // 必须是 0:run() 里 import 路径写错时 main().catch 以 1 退出,`< 2` 会放过它(2026-09-27 评审抓到)。
      expect(r.code, r.out).toBe(0)
      expect(r.out, 'dynamic import failed').not.toContain('Cannot find module')
      expect(r.out.trim().length, 'no output').toBeGreaterThan(0)
    })
  }
})

describe('搬走的命令文件不许自己成为入口', () => {
  it('src/cli/commands/*.ts 里没有 import.meta.main', () => {
    const dir = join(ROOT, 'src', 'cli', 'commands')
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue
      // 只看代码,不看注释(run.ts 的注释里提到过 import.meta.main)。
      const code = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code, f).not.toContain('import.meta.main')
    }
  })
})
