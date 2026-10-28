/**
 * 启停只有一种写法(第三批 3b,设计稿 docs/superpowers/specs/2026-10-22-daemon-module-design.md)—— 守卫先上,按违规计数。
 *
 * 2026-10-22 盘点:一个功能的启停散在五套机制里。目标是全部收进 DaemonModule 容器(src/daemon/modules/container.ts):
 * 定时器只经 `ctx.interval`、资源只经 `ctx.own`、晚绑定只经 `ctx.lazy`、可选子系统只经 `optional: true`。
 * 规矩(跟 speech-send 守卫一个做法):
 *  - **没登记的文件出现这几种调用 ⇒ 红**:新代码写成模块。
 *  - **登记过的文件次数只许降**:多一处红;少了也红,提示你把数字调下来(棘轮)。
 *  - 全部降到 0 ⇒ 删掉 LifecycleSet、Ref、SubsystemSupervisor、收尾清单这四样。
 * 只扫生产代码(排除 *.test.ts,整合者评审 #541);注释行不算。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DAEMON = join(ROOT, 'src', 'daemon')
/** 功能目录(架构终态 A3 起):一个功能一个模块,同一套规矩。 */
const FEATURES = join(ROOT, 'src', 'features')

const KINDS = {
  setInterval: /\bsetInterval\(/g,                // 裸定时器 ⇒ ctx.interval
  Ref: /\bnew Ref</g,                             // 晚绑定 ⇒ needs(不是环)或 ctx.lazy(真环)
  'lc.register': /\blc\.register\(/g,             // LifecycleSet ⇒ ctx.own / ctx.interval
  'teardown.add': /\b\w*[Tt]eardown\.add\(/g,     // bootstrap 收尾清单(#508)⇒ 同上
  'phoneLc.add': /\bphoneLc\.add\(/g,             // 手机那一簇的收尾 ⇒ 同上
  'sup.start': /\bsup\.start\(/g,                 // SubsystemSupervisor ⇒ optional: true
} as const
type Kind = keyof typeof KINDS

/** 这几处的 setInterval 不是模块的生命周期,永久不算(每一条写明为什么)。 */
const NOT_LIFECYCLE: Record<string, string> = {
  'src/features/phone/settings-panel-html.ts': '(A5 起在 features/phone)在发给浏览器的 HTML 字符串里,是页面自己的 JS,不在 daemon 里跑',
  'src/daemon/inbound/mw-typing.ts': '一轮回复期间的「正在输入」,在那一轮结束时清掉,跟模块启停无关',
  // 下面两处随工作台搬进 src/features/workbench(架构终态 A5;以前在 src/core,这个守卫没扫到):
  'src/features/workbench/script-runner.ts': '一次脚本运行结束后盯孤儿进程组,组空了自己停,跟模块启停无关',
  'src/features/workbench/service/lifecycle.ts': '等写手退出的证据:有要等的才起、等完自己停(shutdown 也停),跟模块启停无关',
}
/** 容器自己:定义 ctx.interval 的地方。 */
const CONTAINER = 'src/daemon/modules/container.ts'

// 2026-10-22 基线(按文件)。迁一处减一;迁完的行删掉。
// @debt daemon 里还没进模块容器的启停(Ref / lc.register / setInterval …;核心链在迁)
const BASELINE: Record<string, Partial<Record<Kind, number>>> = {
  'src/daemon/cli-upgrade/wire.ts': { setInterval: 1 },
  'src/daemon/guard/pause-policy.ts': { setInterval: 1 },
  'src/daemon/ilink/context.ts': { setInterval: 1 },
  'src/features/phone/phone-events.ts': { setInterval: 1 },     // 手机搬进 src/features/phone(架构终态 A5),数没变
  'src/daemon/single-instance.ts': { setInterval: 1 },
  'src/daemon/speech/pending-notices.ts': { setInterval: 1 },
  'src/features/phone/tunnel-client.ts': { setInterval: 1 },    // 同上
  'src/daemon/wiring/pipeline-deps.ts': { Ref: 1 },
  'src/daemon/wiring/wire-phone.ts': { 'phoneLc.add': 6 },
  // 回退备份 ref 每天清一次:service 自己起、shutdown 里停(模块经 ctx.own 停 service)。随工作台搬进 features 才被扫到(架构终态 A5),
  // 该换成 ctx.interval,搬家不改逻辑,单独做
  'src/features/workbench/service/rewind.ts': { setInterval: 1 },
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== '__e2e__' && name !== 'node_modules') walk(p, out) }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}
/** 去掉注释行再数(按行判:块注释里的字符串、glob 不会把真代码吞掉)。 */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
}
function counts(): Record<string, Partial<Record<Kind, number>>> {
  const out: Record<string, Partial<Record<Kind, number>>> = {}
  for (const abs of [...walk(DAEMON), ...walk(FEATURES)]) {
    const rel = relative(ROOT, abs).split('\\').join('/')
    if (rel === CONTAINER) continue
    const code = codeOf(abs)
    for (const [k, re] of Object.entries(KINDS) as Array<[Kind, RegExp]>) {
      if (k === 'setInterval' && rel in NOT_LIFECYCLE) continue
      const n = code.match(re)?.length ?? 0
      if (n) (out[rel] ??= {})[k] = n
    }
  }
  return out
}

describe('启停只有一种写法:旧的五套机制只许减少', () => {
  const now = counts()
  it('没登记的文件不许出现(新代码写成模块:ctx.interval / ctx.own / ctx.lazy / optional)', () => {
    expect(Object.keys(now).filter(f => !(f in BASELINE))).toEqual([])
  })
  it('登记过的文件:多了红;少了也红(把 BASELINE 的数字调下来,迁完的行删掉)', () => {
    const drift: string[] = []
    for (const [f, base] of Object.entries(BASELINE)) {
      for (const k of Object.keys(KINDS) as Kind[]) {
        const want = base[k] ?? 0, got = now[f]?.[k] ?? 0
        if (want !== got) drift.push(`${f} [${k}]: 登记 ${want},现在 ${got}`)
      }
    }
    expect(drift).toEqual([])
  })
  it('豁免的文件都还在,而且确实在用 setInterval(删了或改了就把豁免也删掉)', () => {
    for (const f of Object.keys(NOT_LIFECYCLE)) expect(codeOf(join(ROOT, f))).toMatch(/\bsetInterval\(/)
  })
})
