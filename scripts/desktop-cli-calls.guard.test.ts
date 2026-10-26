/**
 * 桌面里还起 CLI 的,只剩这张名单上的(架构终态 F6,主人 2026-10-26 拍板)。
 *
 * daemon 已经能回的东西,桌面一律走 `/v1`(`src/daemon-client.js` + 生成的 `V1` 表;主人私事经宿主代理 daemon_request);
 * daemon 没起就读不到,页面说「CC 没在运行」。还留在 CLI 的是 daemon 没起也得能用、或者本来就不归 daemon 的那几族,每条写着为什么。
 * 零基线:新加一处 `invoke("wechat_cli_json" | "wechat_cli_text" | "wechat_cli_json_via_file", …)`,命令不在名单上就红;
 * 名单上有、源码里已经没人调的也红(别留死条目)。参数不是字面量、也找不到 `const <名> = [...]` 定义的调用,一样红(认不出来就不放)。
 * 不扫:测试、生成物 `src/generated/`、`src/vendor/`;注释按行跳过(别用块注释正则,会吞掉字符串里的 `/*`)。
 * mock.js 是浏览器里没有 Tauri 时的假 invoke,只比较命令名、不调用,正则不匹配它。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DESKTOP_SRC = join(ROOT, 'apps/desktop/src')
const SKIP_DIRS = ['generated', 'vendor', 'node_modules']

interface Allowed {
  /** 命令的前一两个词(`daemon kill`);只认得出第一个词的调用(第二个词是变量)只能对上一个词的条目。 */
  cmd: string
  why: string
  /** 只许在这几个文件里调。 */
  only?: string[]
}

export const DESKTOP_CLI_ALLOWED: readonly Allowed[] = [
  // ── 计划里的留用名单(装服务 / 起停 / 体检 / 绑定 / 升级 / 日志):daemon 没起、或者正要把它起起来时用 ──
  { cmd: 'service', why: '装 / 起 / 停 / 查后台服务:管的就是 daemon 本身' },
  { cmd: 'install-progress', why: '装服务的进度:daemon 还没起来' },
  { cmd: 'doctor', why: '体检:daemon 坏了也得能说出哪里坏' },
  { cmd: 'daemon kill', why: '杀残留进程:daemon 卡死时用' },
  { cmd: 'daemon kill-residual', why: '同上' },
  { cmd: 'daemon api-info', why: '拿连 daemon 的地址和令牌,/v1 的引导,换不了', only: ['apps/desktop/src/api.js'] },
  { cmd: 'setup', why: '扫码绑定:还没有 daemon' },
  { cmd: 'setup-poll', why: '同上' },
  { cmd: 'update', why: '升级会换掉 daemon 本身' },
  { cmd: 'logs', why: '读日志:daemon 起不来时最要看' },
  // ── 清点后留下的(F6):daemon 没起也得能用,或者本来就不归 daemon ──
  { cmd: 'guard', why: '网络守护的开关和状态:向导第 4 步就用,那时服务还没装;装服务读的正是这份配置' },
  { cmd: 'provider', why: '选 AI / 免审 / 开机自启:向导里先于装服务写 agent-config,装服务照它装' },
  { cmd: 'connection probe', why: '「测试连接」:恰恰在 daemon 被顶掉 / 卡住时用' },
  { cmd: 'log', why: '重连诊断的埋点(RECONNECT_DIAGNOSE):写的时候 daemon 正连不上', only: ['apps/desktop/src/modules/dashboard.js'] },
  { cmd: 'account remove', why: '解绑账号(和 setup 一族):删账号目录、要重启 daemon;坏掉的账号正要靠它清' },
  { cmd: 'plugin setup', why: '插件的一次性安装:在 app 的身份下起安装子进程(完全磁盘访问权限),进度写文件给 setup-status 读' },
  { cmd: 'plugin setup-status', why: '读 plugin setup 那个进程写的进度文件', only: ['apps/desktop/src/modules/plugins.js'] },
  { cmd: 'plugin sync', why: '插件的刷新动作:同 plugin setup,起子进程', only: ['apps/desktop/src/modules/plugins.js'] },
  { cmd: 'plugin list', why: '开机刷新 wxvault 前看它在不在:GET /v1/plugins/list 按设计不列 hidden 插件,wxvault 正是', only: ['apps/desktop/src/modules/wxvault-refresh.js'] },
]

const CALL_RE = /\(\s*(['"])(wechat_cli_json|wechat_cli_text|wechat_cli_json_via_file)\1\s*,/g
/** `[ "a", "b"` 的前两个字面量;第二个不是字面量就只给第一个。 */
const LITERAL_HEAD_RE = /^\[\s*(['"])([\w-]+)\1(?:\s*,\s*(['"])([\w-]+)\3)?/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.includes(name)) walk(p, out) }
    else if (name.endsWith('.js') && !name.endsWith('.test.js')) out.push(p)
  }
  return out
}

/** 按行去掉注释行(`//` 或块注释里以 `*` 开头的行),行号不变。 */
function stripCommentLines(text: string): string {
  return text.split(/\r?\n/).map(line => {
    const t = line.trim()
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : line
  }).join('\n')
}

function headOf(literal: string): string | null {
  const m = LITERAL_HEAD_RE.exec(literal)
  if (!m) return null
  return m[4] ? `${m[2]} ${m[4]}` : m[2]!
}

export interface CliCall { file: string; line: number; cmd: string | null }

export function cliCallsIn(file: string, raw: string): CliCall[] {
  const text = stripCommentLines(raw)
  const out: CliCall[] = []
  for (const m of text.matchAll(CALL_RE)) {
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 400)
    const line = text.slice(0, m.index!).split('\n').length
    const argsM = /^\s*\{\s*args\s*(:\s*)?/.exec(after)
    let cmd: string | null = null
    if (argsM) {
      const rest = after.slice(argsM[0].length)
      if (argsM[1] && rest.trimStart().startsWith('[')) cmd = headOf(rest.trimStart())
      else {
        // `{ args }` 或 `{ args: name }`:找同一文件里的 `const name = [ ... ]`
        const name = argsM[1] ? /^([A-Za-z_$][\w$]*)/.exec(rest)?.[1] : 'args'
        if (name) {
          const def = new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*(\\[[^\\]]*)`).exec(text)
          if (def) cmd = headOf(def[1]!)
        }
      }
    }
    out.push({ file, line, cmd })
  }
  return out
}

function allowedFor(call: CliCall): Allowed | undefined {
  if (!call.cmd) return undefined
  return DESKTOP_CLI_ALLOWED.find(a =>
    (call.cmd === a.cmd || call.cmd!.startsWith(`${a.cmd} `)) && (!a.only || a.only.includes(call.file)))
}

describe('桌面里起 CLI 的只剩留用名单(架构终态 F6,零基线)', () => {
  const calls = walk(DESKTOP_SRC).flatMap(f => cliCallsIn(relative(ROOT, f).split('\\').join('/'), readFileSync(f, 'utf8')))

  it('扫得到东西(扫空 = 守卫沉默)', () => {
    expect(calls.length).toBeGreaterThan(20)
  })

  it('每一处调用的命令都在名单上(daemon 已有 / 能有路由的走 /v1:daemon-client.js 的 V1)', () => {
    const bad = calls.filter(c => !allowedFor(c)).map(c => `${c.file}:${c.line} ${c.cmd ?? '(认不出命令)'}`)
    expect(bad, '换成 v1(transport, V1.ns.m, …);daemon 没有路由就在功能模块里加一条(docs/maintainer/add-a-feature.md)').toEqual([])
  })

  it('名单上的每一条都还有人调(不留死条目)', () => {
    const unused = DESKTOP_CLI_ALLOWED.filter(a => !calls.some(c => allowedFor(c) === a)).map(a => a.cmd)
    expect(unused).toEqual([])
  })

  it('认得出:字面量、`{ args }` 简写、`{ args: name }` 加同文件的定义;第二个词是变量时只认第一个词', () => {
    const src = [
      'invoke("wechat_cli_json", { args: ["memory", "list", "--json"] })',
      'const args = ["service", action, "--json"]',
      'deps.invoke("wechat_cli_json", { args })',
      'const xs = ["setup-poll", "--qrcode", q]',
      "invoke('wechat_cli_text', { args: xs })",
      '// invoke("wechat_cli_json", { args: ["sessions", "delete"] })',
      'invoke("wechat_cli_json", { args: build() })',
    ].join('\n')
    expect(cliCallsIn('x.js', src).map(c => c.cmd)).toEqual(['memory list', 'service', 'setup-poll --qrcode', null])
  })
})
