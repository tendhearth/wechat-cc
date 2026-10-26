import { describe, expect, it } from 'vitest'
import { enforcementMatrix, noAskNotice, ENFORCEMENT_TIERS, type EnforcementOutcome } from './enforcement-matrix'
import { KNOWN_PROVIDER_IDS } from './capability-matrix'

// 架构终态 C3:以前 tier-enforcement.ts 手写「每家每档靠哪一层守住」+ 一个手设的 doesNotAsk 标记;现在整张表从
// providerDenialFor / authorize / decideTool / compilePolicy / 能力表推出来(enforcement-matrix.ts),这里钉快照。
// 能力表、档位、authorize、compilePolicy 哪一样改了,快照就有 diff,评审要看着接受(`vitest -u`)。

/**
 * 为什么这几家有「档位说的≠实际」的格子(strict 下)。从 tier-enforcement.ts 的 KNOWN_TIER_GAPS 搬来,按推导的结果核过。
 * 有箭头格子的执行者必须在这里有一条理由;不再有箭头的,删掉这条(下面的守卫两头都查)。
 */
const WHY_GAPS: Readonly<Record<string, string>> = {
  // trusted:ask→allow(shell_destructive / memory_delete / a2a_send)。admin 自 2026-10-26 起没有缺口(见下)。
  codex: 'trusted 的对话:strict 下 workspace-write 沙箱 + approval never,破坏性 shell 和 wechat MCP 上要问的那几类都不会停下来问'
    + '(审批卡发给主人,问的却是别人的对话 —— 主人只点头了自己对话的逐条问),问不了 ⇒ 维持不问,切过去时照实说'
    + '(设计稿 2026-10-22-policy-compile-design.md §6)。admin 专用工具靠 wechat MCP 按档注册挡住。'
    + '主人自己的对话(admin):approval on-request,codex 报上来的每一条过 authorize(codex-chat-gate.ts);MCP 每次调用都报'
    + '(default_tools_approval_mode = prompt),所以 memory_delete / daemon_remediate 是真问;shell_destructive 记成「问」靠的是 codex'
    + '自己会把越出沙箱 / 它认为危险的命令报上来 —— 沙箱里它觉得不危险的破坏性命令(比如工作目录里的某些删除)不会报,这是 codex 判断的边界。',
  // trusted / admin:ask→deny。
  cursor: 'ACP 对话侧按模式应答(compilePolicy 的 cursor-acp):strict 下每条权限请求都拒 —— 档位说问,它直接拒,比档位严,不用提醒。'
    + '执行命令有权限卡(拒掉);改文件不弹卡(trusted / admin 本来允许改)。只挂 wechat MCP(按会话档位注册),不挂插件和 delegate。'
    + '改成真的问是设计稿 §6 第 5 步,等主人点头。注意:wechat MCP 上要问的那几类(memory_delete / a2a_send / daemon_remediate)'
    + '算成拒,依据是「每条权限请求都拒」这条编译设置;Cursor 对 MCP 调用发不发权限请求没有单独登记的事实。',
  // trusted / admin:ask→deny(档位说问的,一律拒)。
  openai: '自研循环有逐工具闸门,但「问」还没接通道:compilePolicy 的 relayAs 是 deny,档位说问的一律拒(设计稿 §6 第 6 步待主人点头)。',
  // trusted:ask→allow;admin:ask→allow(shell_destructive / memory_delete)、allow→deny / ask→deny(admin 专用工具)。
  agy: '没有逐工具回调,也没有映射的沙箱(confines 全是 none):shell_destructive / memory_delete / a2a_send 不会停下来问;问不了 ⇒ 维持不问,'
    + '主人切过去时照实说(设计稿 §6)。wechat MCP 是钉死 trusted 的静态配置(adminMcpTools 为假),主人聊天里 admin 专用工具'
    + '(含 daemon_remediate)也不注册,所以那几格是调不到(比档位严)。',
}

/** 按结果分组,一家一档一行一组,好读、diff 也好看。 */
function grouped(): Record<string, Record<string, Partial<Record<EnforcementOutcome, string[]>>>> {
  const m = enforcementMatrix()
  return Object.fromEntries(Object.entries(m).map(([p, tiers]) => [p, Object.fromEntries(Object.entries(tiers).map(([t, kinds]) => {
    const g: Partial<Record<EnforcementOutcome, string[]>> = {}
    for (const [k, o] of Object.entries(kinds)) (g[o] ??= []).push(k)
    for (const v of Object.values(g)) v.sort()
    return [t, Object.fromEntries(Object.entries(g).sort(([a], [b]) => a.localeCompare(b)))]
  }))]))
}

const isGap = (o: EnforcementOutcome) => o.includes('→')

describe('provider × tier × tool-kind enforcement (derived)', () => {
  it('the derived matrix is what the code does today (snapshot)', () => {
    expect(grouped()).toMatchSnapshot()
  })

  it('covers every registered provider', () => {
    expect(Object.keys(enforcementMatrix()).sort()).toEqual([...KNOWN_PROVIDER_IDS].sort())
  })

  // 以前的「访客不许是缺口」:访客要么被派发时拒,要么每一格都照档位办(逐工具)。
  it('guests are never a gap: refused at dispatch, or every cell is enforced as the tier says', () => {
    const m = enforcementMatrix()
    for (const p of KNOWN_PROVIDER_IDS) {
      const cells = Object.values(m[p]!.guest)
      if (cells.includes('refused')) expect(new Set(cells), p).toEqual(new Set(['refused']))
      else for (const c of cells) expect(isGap(c), `${p}/guest`).toBe(false)
    }
  })

  it('no executor ever lets through a kind the tier denies', () => {
    const m = enforcementMatrix()
    for (const p of KNOWN_PROVIDER_IDS) for (const t of ENFORCEMENT_TIERS) for (const [k, o] of Object.entries(m[p]![t])) expect(o, `${p}/${t}/${k}`).not.toBe('deny→allow')
  })

  it('every executor with a gap has its reason written down; a reason with no gap left is stale', () => {
    const m = enforcementMatrix()
    const withGaps = KNOWN_PROVIDER_IDS.filter(p => ENFORCEMENT_TIERS.some(t => Object.values(m[p]![t]).some(isGap))).sort()
    expect(Object.keys(WHY_GAPS).sort(), '有缺口的执行者要在 WHY_GAPS 写理由;没有缺口了就删掉那条').toEqual(withGaps)
  })

  // 准绳(稿 §6):问不了、于是放行的那几家,主人切过去时照实说一句;比档位严的(cursor / openai 直接拒)不用提醒。
  it('the "it will not ask you" notice goes exactly to the executors that let ask-kinds through', () => {
    expect(KNOWN_PROVIDER_IDS.filter(p => noAskNotice(p) !== null).sort()).toEqual(['agy', 'codex'])
    // 按切换的那个对话的档位说(2026-10-26):codex 在主人自己的对话里逐条问 ⇒ 不提醒;信任的对话照旧提醒。
    expect(KNOWN_PROVIDER_IDS.filter(p => noAskNotice(p, 'admin') !== null).sort()).toEqual(['agy'])
    expect(KNOWN_PROVIDER_IDS.filter(p => noAskNotice(p, 'trusted') !== null).sort()).toEqual(['agy', 'codex'])
    expect(KNOWN_PROVIDER_IDS.filter(p => noAskNotice(p, 'guest') !== null)).toEqual([])
    expect(noAskNotice('codex')).toBe('提醒:它不会逐条问你,删东西也不会。')
    expect(noAskNotice('agy')).toBe('提醒:它不会逐条问你,删东西也不会。')
    expect(noAskNotice('claude')).toBeNull()
    expect(noAskNotice('cursor')).toBeNull()
    expect(noAskNotice('some-custom-acp')).toBeNull()
  })
})
