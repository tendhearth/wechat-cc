import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
// 测试里直接用 node 的 spawnSync:只有它带 `input`(喂 stdin),适配层没有这一格。
import { spawnSync as cpSpawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
// WIN_DIR 下的拼接一律走 win32 实现:测试跑在 mac / linux 上,默认的 posix join
// 会拼出 `C:\Program Files\wechat-cc/cc-jobspawn.exe` 这种四不像,断言就只能写歪。
import { dirname, join, win32 as winPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from './runtime/process'
import { removeTempDir } from './test-temp'
import {
  JOBSPAWN_BASENAME,
  JOBSPAWN_PATH_ENV,
  createProcessTreeWrapper,
  jobspawnMissingLine,
  resolveJobspawn,
  type JobspawnResolution,
} from './jobspawn'

// src/lib/ → 仓库根
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RUST_SOURCE = join(REPO_ROOT, 'scripts', 'jobspawn.rs')

/** win32 上 `cc-jobspawn` 和 sidecar 并排,所以 execPath 的目录是搜索起点。 */
const WIN_EXEC = 'C:\\Program Files\\wechat-cc\\wechat-cc.exe'
const WIN_DIR = 'C:\\Program Files\\wechat-cc'

describe('resolveJobspawn', () => {
  // 平台判断一律注入 —— 这个仓库栽过「只在 Mac 上绿」,断言不能依赖跑测试的机器是什么。
  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform} 上不需要这层包装(POSIX 有进程组)`, () => {
      expect(resolveJobspawn({
        platform, arch: 'arm64', execPath: '/Applications/wechat-cc.app/x/wechat-cc',
        // 就算 env 指了、文件也在,非 win32 也不包。
        env: { [JOBSPAWN_PATH_ENV]: '/tmp/cc-jobspawn' }, exists: () => true,
      })).toEqual({ kind: 'not-needed' } satisfies JobspawnResolution)
    })
  }

  it('win32:环境变量指定的路径存在 ⇒ 用它', () => {
    expect(resolveJobspawn({
      platform: 'win32', arch: 'x64', execPath: WIN_EXEC,
      env: { [JOBSPAWN_PATH_ENV]: 'D:\\build\\cc-jobspawn.exe' },
      exists: p => p === 'D:\\build\\cc-jobspawn.exe',
    })).toEqual({ kind: 'found', path: 'D:\\build\\cc-jobspawn.exe', from: 'env' })
  })

  it('win32:环境变量指定的路径不存在 ⇒ 算找不到,**不**偷偷回落到并排的那个', () => {
    // 回落会让真机验证变成猜:你以为在验 D:\build 那个,其实验的是装机自带的。
    const r = resolveJobspawn({
      platform: 'win32', arch: 'x64', execPath: WIN_EXEC,
      env: { [JOBSPAWN_PATH_ENV]: 'D:\\build\\cc-jobspawn.exe' },
      exists: p => p === winPath.join(WIN_DIR, 'cc-jobspawn.exe'),
    })
    expect(r).toEqual({ kind: 'missing', tried: ['D:\\build\\cc-jobspawn.exe'] })
  })

  it('win32:打包版用和 execPath 并排的 cc-jobspawn.exe', () => {
    expect(resolveJobspawn({
      platform: 'win32', arch: 'x64', execPath: WIN_EXEC, env: {},
      exists: p => p === winPath.join(WIN_DIR, 'cc-jobspawn.exe'),
    })).toEqual({ kind: 'found', path: winPath.join(WIN_DIR, 'cc-jobspawn.exe'), from: 'sibling' })
  })

  it('win32:只有带 target triple 名字的产物也认(直接跑 build-sidecar 的输出目录)', () => {
    const triple = winPath.join(WIN_DIR, 'cc-jobspawn-x86_64-pc-windows-msvc.exe')
    expect(resolveJobspawn({
      platform: 'win32', arch: 'x64', execPath: WIN_EXEC, env: {}, exists: p => p === triple,
    })).toEqual({ kind: 'found', path: triple, from: 'sibling-triple' })
    const arm = winPath.join(WIN_DIR, 'cc-jobspawn-aarch64-pc-windows-msvc.exe')
    expect(resolveJobspawn({
      platform: 'win32', arch: 'arm64', execPath: WIN_EXEC, env: {}, exists: p => p === arm,
    })).toEqual({ kind: 'found', path: arm, from: 'sibling-triple' })
  })

  it('win32:一个都没有 ⇒ missing,并把找过的地方都报出来', () => {
    const r = resolveJobspawn({
      platform: 'win32', arch: 'x64', execPath: WIN_EXEC, env: {}, exists: () => false,
    })
    expect(r.kind).toBe('missing')
    expect(r.kind === 'missing' && r.tried).toEqual([
      winPath.join(WIN_DIR, 'cc-jobspawn.exe'),
      winPath.join(WIN_DIR, 'cc-jobspawn-x86_64-pc-windows-msvc.exe'),
    ])
  })
})

describe('createProcessTreeWrapper', () => {
  const found: JobspawnResolution = { kind: 'found', path: 'C:\\x\\cc-jobspawn.exe', from: 'sibling' }

  it('win32 上把命令塞进 cc-jobspawn 的参数里', () => {
    const lines: string[] = []
    const wrap = createProcessTreeWrapper({ resolve: () => found, log: l => lines.push(l) })
    expect(wrap('C:\\bin\\claude.exe', ['-p', '--resume', 'abc'])).toEqual({
      command: 'C:\\x\\cc-jobspawn.exe',
      args: ['C:\\bin\\claude.exe', '-p', '--resume', 'abc'],
    })
    expect(lines).toEqual([])
  })

  it('其他平台原样返回,而且不留痕(不是缺口,不该喊)', () => {
    const lines: string[] = []
    const wrap = createProcessTreeWrapper({ resolve: () => ({ kind: 'not-needed' }), log: l => lines.push(l) })
    expect(wrap('claude', ['-p'])).toEqual({ command: 'claude', args: ['-p'] })
    expect(wrap('codex')).toEqual({ command: 'codex', args: [] })
    expect(lines).toEqual([])
  })

  it('找不到 ⇒ 降级(照原样 spawn)+ 留痕说清后果,而且不抛错', () => {
    const lines: string[] = []
    const wrap = createProcessTreeWrapper({
      resolve: () => ({ kind: 'missing', tried: ['C:\\a\\cc-jobspawn.exe'] }),
      log: l => lines.push(l),
    })
    // 降级:命令照跑 —— 抛错会让整个功能不可用,比漏更糟。
    expect(wrap('C:\\bin\\agy.exe', ['-p', 'hi'])).toEqual({ command: 'C:\\bin\\agy.exe', args: ['-p', 'hi'] })
    // 留痕:断言的是那一行真的写出来了,不是"没抛错"。
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('C:\\a\\cc-jobspawn.exe')
    // 一眼能看出后果 + 怎么补救。
    expect(lines[0]).toContain('进程树清理已退化')
    expect(lines[0]).toContain('残留')
    expect(lines[0]).toContain(JOBSPAWN_PATH_ENV)
  })

  it('喊一次就够:第二次 spawn 不再刷日志,resolve 也只做一次', () => {
    const lines: string[] = []
    let resolves = 0
    const wrap = createProcessTreeWrapper({
      resolve: () => { resolves++; return { kind: 'missing', tried: ['x'] } },
      log: l => lines.push(l),
    })
    wrap('a'); wrap('b'); wrap('c')
    expect(lines).toHaveLength(1)
    expect(resolves).toBe(1)
  })

  it('jobspawnMissingLine 在一个候选都没有时也说得清', () => {
    expect(jobspawnMissingLine([])).toContain('(无)')
  })
})

/**
 * 「stdout 只属于被包的命令」—— 裁决 2 要求的那条钉子,两层:
 *
 * ① 静态:源码里不许有 `print!` / `println!`。spike 原型正是把 `jobspawn pid=...`
 *    打在 stdout 上,而 ACP 与 codex app-server 靠 stdin/stdout 的 JSON-RPC,那一行
 *    就是往协议流里插脏东西。这条在任何平台、不需要 rustc 都跑。
 * ② 真跑:编出来、包一个会同时往 stdout / stderr 写东西的命令,核对 stdout 一个
 *    字节不多。POSIX 上 cc-jobspawn 是直通,所以这条测试在 mac / linux 上测的是
 *    同一件事(只是不含 job 那一段),不是"只在某个平台有意义"的断言。
 */
describe('scripts/jobspawn.rs', () => {
  const source = readFileSync(RUST_SOURCE, 'utf8')
  /** 注释里提到 println! 不算违规(本文件的抬头就在讲那个 bug),只看代码。 */
  const code = source.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n')

  it('诊断一律 stderr:代码里没有任何 print!/println!', () => {
    expect(code).not.toMatch(/\bprintln!\s*\(/)
    expect(code).not.toMatch(/\bprint!\s*\(/)
    // 反面确认:它确实在用 eprintln!(否则"没有 println!"可能只是因为什么都没写)。
    expect(code).toMatch(/\beprintln!\s*\(/)
  })

  it('零外部 crate 依赖(win-test 是域机,未必连得上 crates.io)', () => {
    expect(code).not.toMatch(/\bextern\s+crate\b/)
    const uses = code.match(/^\s*(?:pub\s+)?use\s+[^;]+;/gm) ?? []
    expect(uses.length).toBeGreaterThan(0)
    for (const line of uses) {
      expect(line.replace(/^\s*(?:pub\s+)?use\s+/, '')).toMatch(/^(std|core|super|crate|self)::/)
    }
  })
})

const rustcAvailable = (() => {
  try { return spawnSync(['rustc', '--version']).exitCode === 0 } catch { return false }
})()

describe.skipIf(!rustcAvailable)('cc-jobspawn(真编译、真跑)', () => {
  let dir = ''
  let binary = ''
  const exe = process.platform === 'win32' ? '.exe' : ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-jobspawn-test-'))
    binary = join(dir, `${JOBSPAWN_BASENAME}${exe}`)
    const built = spawnSync(['rustc', '-O', '-C', 'strip=symbols', '-C', 'debuginfo=0',
      '--edition', '2021', '-o', binary, RUST_SOURCE])
    if (built.exitCode !== 0) throw new Error(`rustc 编不过 jobspawn.rs:\n${built.stderr.toString()}`)
  }, 120_000)

  afterAll(() => { if (dir) removeTempDir(dir) })

  /** 用当前运行时自己(bun / node 都认 `-e`)当被包的命令,免得引入平台特有的 shell。 */
  const run = (script: string, env: Record<string, string | undefined> = {}) =>
    spawnSync([binary, process.execPath, '-e', script], { env: { ...process.env, ...env } })

  it('stdout 只属于被包的命令,退出码原样透出', () => {
    const r = run("process.stdout.write('PURE');process.stderr.write('noise');process.exit(7)")
    expect(r.stdout.toString()).toBe('PURE')
    expect(r.exitCode).toBe(7)
    expect(r.stderr.toString()).toContain('noise')
  })

  it('开了调试开关,pid 诊断也只进 stderr —— stdout 仍然一个字节不多', () => {
    const r = run("process.stdout.write('PURE')", { WECHAT_CC_JOBSPAWN_DEBUG: '1' })
    expect(r.stdout.toString()).toBe('PURE')
    // POSIX 是直通(不建 job,所以没有 pid 行);win32 上才该看见它。
    if (process.platform === 'win32') expect(r.stderr.toString()).toContain('cc-jobspawn: pid=')
  })

  it('参数原样透传(含带空格的那种)', () => {
    const r = spawnSync([binary, process.execPath, '-e',
      'process.stdout.write(process.argv.slice(1).join("|"))', 'a b', '--x=1', ''])
    expect(r.stdout.toString()).toBe('a b|--x=1|')
    expect(r.exitCode).toBe(0)
  })

  it('stdin 是透的(JSON-RPC 就靠这个)', () => {
    // 不借 shell 管道:那要按平台拼引号(win32 的 `cmd /c` 会把带空格的路径吃掉)。
    // node:child_process 的 `input` 直接喂 stdin,两个平台同一条路。
    const script = join(dir, 'echo-stdin.js')
    writeFileSync(script, "let d='';process.stdin.on('data',c=>{d+=c});process.stdin.on('end',()=>process.stdout.write('IN:'+d.trim()))")
    const piped = cpSpawnSync(binary, [process.execPath, script], { input: 'ping\n', windowsHide: true })
    expect(piped.status).toBe(0)
    expect(String(piped.stdout)).toBe('IN:ping')
  })

  it('没给命令 ⇒ 用法写 stderr、退 2(stdout 依然空的)', () => {
    const r = spawnSync([binary])
    expect(r.exitCode).toBe(2)
    expect(r.stdout.toString()).toBe('')
    expect(r.stderr.toString()).toContain('cc-jobspawn')
  })

  it('命令不存在 ⇒ 大声报、退 6,不假装成功', () => {
    const r = spawnSync([binary, join(dir, 'definitely-not-here')])
    expect(r.exitCode).toBe(6)
    expect(r.stdout.toString()).toBe('')
    expect(r.stderr.toString()).toContain('cc-jobspawn')
  })
})

/**
 * 「真的会漏的那几个 spawn 点确实包了」—— 这条钉子的存在理由:
 *
 * 上面的用例全在测接缝本身,没有一条能发现「接缝好使,但某个 spawn 点没用它」。
 * 而这个修复的全部价值就在那 5 个点上,它们各自的测试都注入假 spawn(测的是编排,
 * 不是命令行长什么样),所以摘掉包装不会有任何东西变红。同 spawn-windowshide.test.ts
 * 的思路:用一条静态断言把清单钉住。
 *
 * 名单的判定标准是**两条同时成立**:① 这条路在 Windows 上真的会跑(被 win32 硬闸门
 * 挡掉的不算,那是「明确拒绝」,用户看得见);② 它有一条 kill 路径,在 win32 上只杀
 * 直接子进程。哪天某个点不再满足(比如改成别的机制、或者加了硬闸门),连同这行注释
 * 一起从名单里删掉,并在 PR 里说清为什么 —— 别偷偷摘。
 */
describe('会漏的 spawn 点都套了 cc-jobspawn', () => {
  const sites: Array<[string, string]> = [
    ['src/core/agy-agent-provider.ts', 'agy 一处 win32 判断都没有,kill() 只杀 agy 本身'],
    ['src/cli/self-change/runner.ts', '自改流水线的 claude -p:win32 上 MCP 与子代理留下继续烧预算'],
    ['src/daemon/cli-reply-handler.ts', '微信「@码」续接:win32 上 killAll 只杀 claude/codex 本身'],
    ['src/core/workbench/codex-config.ts', 'codex mcp list:工作台硬闸门在 provider.spawn() 里,这条路走 modelCatalog,闸门之外'],
    ['src/core/workbench/codex-model-catalog.ts', 'codex app-server 目录进程:同上,在 win32 上真的会跑'],
  ]
  for (const [file, why] of sites) {
    it(`${file} —— ${why}`, () => {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8')
      expect(text).toContain('wrapForProcessTree')
      // 不只是 import 了:真的用在了 spawn 的参数上。
      expect(text).toMatch(/wrapForProcessTree\s*\(/)
    })
  }
})

/**
 * 打包链路的静态钉子。没有这条,「cc-jobspawn 没进安装包」会以最难查的方式表现出来:
 * 产品在 Windows 上照跑、只在日志里留一行降级 —— 也就是回到修之前的状态。
 * externalBin 是 Tauri 的**数组**字段,平台覆盖文件里的数组是**整体替换**而不是合并,
 * 所以 macOS 那份必须自己也列一遍(它多一个 sd-cli)。
 */
describe('cc-jobspawn 进得了安装包', () => {
  const readJson = (rel: string) => JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as {
    bundle?: { externalBin?: string[] }
  }

  it('tauri.conf.json 的 externalBin 里有它', () => {
    expect(readJson('apps/desktop/src-tauri/tauri.conf.json').bundle?.externalBin)
      .toContain(`binaries/${JOBSPAWN_BASENAME}`)
  })

  it('macOS 的覆盖配置也列了它(数组是替换不是合并)', () => {
    expect(readJson('apps/desktop/src-tauri/tauri.macos.conf.json').bundle?.externalBin)
      .toContain(`binaries/${JOBSPAWN_BASENAME}`)
  })

  it('build-sidecar 真的会编它,而且按 target triple 命名', () => {
    const text = readFileSync(join(REPO_ROOT, 'apps/desktop/scripts/build-sidecar.ts'), 'utf8')
    // 断言的是**真的那条命令**,不是「文件里出现过 jobspawn.rs 这几个字」——
    // 第一版就是那么写的,把源文件名改错了它照样绿(注释里也有这几个字)。
    expect(text).toContain("join(root, 'scripts', 'jobspawn.rs')")
    expect(text).toContain("'-o', jobspawnOutput, jobspawnSource")
    expect(text).toContain("'rustc'")
    // Tauri 的 externalBin 按 `<name>-<rustTriple>[.exe]` 找当前 target 的文件。
    expect(text).toContain(`cc-jobspawn-${'${target.rustTriple}'}`)
  })
})
