/**
 * capabilities.ts — 「CC 现在怎么样」(2026-10-06,主人:做一个一眼看懂的状态总览)。
 *
 * 把已经存在的各路信号(微信外发 / 登录失效、大脑注册与重探、网络守护、完全磁盘访问、知识库向量化走哪条路、
 * 记忆整理、手机、可选子系统)拼成一张「能力」表:每项四态之一 + 一句人话 + 至多一个动作。纯函数,IO 在调用方。
 *
 * 四态:
 *   ok        —— 正常;
 *   fallback  —— 在跑,但走的是退路 / 部分能力(例:向量化退回 Python、正在重连);
 *   needs_you —— 只有主人能修(重新扫码、开权限、连 bx、选一个大脑);
 *   off       —— 没开(不是故障)。
 * 不适用的项不出现(没开知识库、没开网络守护、不是 macOS 的磁盘权限),免得一屏「关」。
 * 原始错误只进 detail(admin 才有;手机经 redactConnections 去掉),reason 只放人话。
 */

export type CapabilityState = 'ok' | 'fallback' | 'needs_you' | 'off'
/** 桌面按钮直接能跑的动作。cli_hooks_install = POST /v1/cli/hooks/install(接上终端里的 Claude Code / Codex)。 */
export type CapabilityRun = 'cli_hooks_install'
export interface Capability {
  id: string
  name: string
  state: CapabilityState
  /** 稳定的原因码(如 `disk.denied`),手机按它本地化;认不出的码用 reason 原文。params 是可替换的值。 */
  code: string
  params?: Record<string, string | number>
  reason: string
  /** run:桌面能当场做的动作(点了先确认,再调对应路由);手机只把 label 说成一句提示。 */
  action?: { label: string; where: 'desktop' | 'settings' | 'wechat'; url?: string; run?: CapabilityRun }
  detail?: string
}

export interface CapabilityInputs {
  /** ownerWindowClosedSince:主人那一路的主动推送窗口关着(errcode=-2)的起始时间。 */
  wechat: { outbound: 'unknown' | 'ok' | 'degraded'; expired: number; lastError?: string | null; ownerWindowClosedSince?: string | null }
  /** refused:真回合里被这一家拒着(provider-refusals.ts;目前只有地区不可用)。注册上了也可能被拒 —— 开机探测只跑 --version。 */
  brain: { provider: string; name: string; registered: boolean; retrying: boolean; lastError?: string | null; refused?: { code: string; since: string } | null }
  /** null = 没开网络守护(不出现)。 */
  guard: { safe: boolean; paused: boolean; detail?: string | null } | null
  /** null = 不是 macOS / 判断不了(不出现)。 */
  fullDiskAccess: { granted: boolean; settingsUrl: string } | null
  /** null = 没开知识库(不出现)。embed:实际在用的那条路。 */
  knowledge: { built: boolean; embed: 'js' | 'python' | 'js_fell_back' | 'none' } | null
  /** null = 关了每晚整理(不出现)。 */
  memory: { failures: number; firstRunDone: boolean } | null
  /** 后台判断(便宜模型)连续真失败的次数;null = 读不到(不出现)。 */
  background?: { failures: number; lastError: string | null } | null
  phone: { relay: boolean; devices: number }
  /**
   * 终端里的 Claude Code / Codex(2026-10-14):只有接了 hooks,终端会话才到得了 CC。
   * sources 只列这台机上有的那几家(CLI 找得到或已装过 hook);空 / null ⇒ 不出现。
   * sessions7d = 登记处里最近 7 天有动静的终端会话数。
   */
  terminal?: { sources: Array<{ source: 'claude' | 'codex' | 'cursor'; health: 'missing' | 'stale' | 'ok' }>; sessions7d: number } | null
  subsystems: Array<{ name: string; state: 'ok' | 'degraded' | 'off'; error?: string }>
}

export const SUBSYSTEM_NAMES: Record<string, string> = {
  knowledge: '知识库', 'cli-upgrade': '外部 CLI 自动升级', 'a2a-server': 'CC 之间的往来', guard: '网络守护',
  'mailbox-poller': '笔友信箱', 'memory-nightly': '记忆整理', pairing: 'CC 之间配对', reminders: '提醒', reports: '任务回报', 'self-restart': '空闲自动重启', social: '社交', yi: '另一台电脑当手',
}

/** 一两次失败多半是一时的(模型偶尔吐坏格式);连着 3 次才说。 */
const BACKGROUND_FAILING_AFTER = 3

export function buildCapabilities(i: CapabilityInputs): Capability[] {
  const out: Capability[] = []

  // 微信:登录失效只有主人能修(重新扫码);外发失败多半是网络,CC 在重试。
  if (i.wechat.expired > 0) out.push({ id: 'wechat', name: '微信', state: 'needs_you', code: 'wechat.expired', reason: '微信登录失效了，CC 收不到也发不出消息。', action: { label: '重新扫码绑定', where: 'desktop' } })
  else if (i.wechat.outbound === 'degraded') out.push({ id: 'wechat', name: '微信', state: 'fallback', code: 'wechat.degraded', reason: '最近发微信消息失败，CC 在自动重试。', ...(i.wechat.lastError ? { detail: i.wechat.lastError } : {}) })
  else if (i.wechat.ownerWindowClosedSince) out.push({ id: 'wechat', name: '微信', state: 'needs_you', code: 'wechat.window_closed', reason: '你有一阵没在微信里跟 CC 说话，微信暂时不让 CC 主动发消息，完成通知和提醒会收不到。', action: { label: '在微信里随便回 CC 一句', where: 'wechat' } })
  else out.push({ id: 'wechat', name: '微信', state: 'ok', code: i.wechat.outbound === 'ok' ? 'wechat.ok' : 'wechat.idle', reason: i.wechat.outbound === 'ok' ? '收发正常。' : '已连上，还没发过消息。' })

  // 大脑:当前选的后端注册上没有。
  if (i.brain.registered && i.brain.refused?.code === 'region_unavailable') out.push({ id: 'brain', name: '大脑', state: 'needs_you', code: 'brain.region_unavailable', params: { name: i.brain.name }, reason: `${i.brain.name} 说你现在的网络出口所在地区用不了它(不是登录问题)。`, action: { label: '换一个出口地区,或在设置里换一个大脑', where: 'settings' }, detail: `从 ${i.brain.refused.since} 起;之后有一轮真的答上来了就恢复` })
  else if (i.brain.registered) out.push({ id: 'brain', name: '大脑', state: 'ok', code: 'brain.ok', params: { name: i.brain.name }, reason: `在用 ${i.brain.name}。` })
  else if (i.brain.retrying) out.push({ id: 'brain', name: '大脑', state: 'fallback', code: 'brain.retrying', params: { name: i.brain.name }, reason: `${i.brain.name} 开机时没连上，正在重试。`, ...(i.brain.lastError ? { detail: i.brain.lastError } : {}) })
  else out.push({ id: 'brain', name: '大脑', state: 'needs_you', code: 'brain.unavailable', params: { name: i.brain.name }, reason: `选的大脑 ${i.brain.name} 用不了。`, action: { label: '在设置里换一个大脑', where: 'settings' } })

  if (i.guard) {
    if (!i.guard.safe) out.push({ id: 'guard', name: '网络守护', state: 'needs_you', code: 'guard.unsafe', reason: '网络没受保护，需要保护的模型调用先停着。', action: { label: '连上 bx', where: 'desktop' }, ...(i.guard.detail ? { detail: i.guard.detail } : {}) })
    else if (i.guard.paused) out.push({ id: 'guard', name: '网络守护', state: 'fallback', code: 'guard.paused', reason: '有任务因为网络暂停过，正在恢复。' })
    else out.push({ id: 'guard', name: '网络守护', state: 'ok', code: 'guard.ok', reason: '网络受保护。' })
  }

  if (i.fullDiskAccess) {
    out.push(i.fullDiskAccess.granted
      ? { id: 'disk', name: '完全磁盘访问', state: 'ok', code: 'disk.ok', reason: '能读微信记录和你的文件夹。' }
      : { id: 'disk', name: '完全磁盘访问', state: 'needs_you', code: 'disk.denied', reason: '没有完全磁盘访问，读不到微信记录，聊天记录也不再更新。', action: { label: '打开系统设置', where: 'settings', url: i.fullDiskAccess.settingsUrl } })
  }

  if (i.knowledge) {
    const k = i.knowledge
    if (!k.built) out.push({ id: 'knowledge', name: '知识库', state: 'fallback', code: 'knowledge.not_built', reason: '知识库没建起来，CC 暂时查不了以前的聊天。' })
    else if (k.embed === 'none') out.push({ id: 'knowledge', name: '知识库', state: 'fallback', code: 'knowledge.keyword_only', reason: '语义搜索不可用，只能按关键词查。' })
    else if (k.embed === 'js_fell_back') out.push({ id: 'knowledge', name: '知识库', state: 'fallback', code: 'knowledge.fell_back', reason: '向量化退回了 Python（能用，慢一些）。' })
    else out.push({ id: 'knowledge', name: '知识库', state: 'ok', code: 'knowledge.ok', reason: '能查以前的聊天。' })
  }

  if (i.memory) {
    if (i.memory.failures >= 3) out.push({ id: 'memory', name: '记忆整理', state: 'fallback', code: 'memory.failing', params: { n: i.memory.failures }, reason: `每晚整理连续 ${i.memory.failures} 次没成功，记忆停在上一次。` })
    else out.push({ id: 'memory', name: '记忆整理', state: 'ok', code: i.memory.firstRunDone ? 'memory.ok' : 'memory.first', reason: i.memory.firstRunDone ? '每晚整理一次。' : '今晚第一次整理。' })
  }

  if (i.background && i.background.failures >= BACKGROUND_FAILING_AFTER) out.push({ id: 'background', name: '后台判断', state: 'fallback', code: 'background.failing', params: { n: i.background.failures }, reason: `后台判断(整理聊天、记忆、提醒等)连续 ${i.background.failures} 次失败。`, action: { label: '在设置里换后台用的模型', where: 'settings' }, ...(i.background.lastError ? { detail: i.background.lastError } : {}) })

  if (i.terminal && i.terminal.sources.length > 0) out.push(terminalCapability(i.terminal))

  if (!i.phone.relay) out.push({ id: 'phone', name: '手机', state: 'off', code: 'phone.relay_off', reason: '没开手机连接。' })
  else if (i.phone.devices === 0) out.push({ id: 'phone', name: '手机', state: 'off', code: 'phone.no_device', reason: '还没连接手机。', action: { label: '在电脑上连接手机', where: 'desktop' } })
  else out.push({ id: 'phone', name: '手机', state: 'ok', code: 'phone.ok', params: { n: i.phone.devices }, reason: `已连接 ${i.phone.devices} 台。` })

  for (const s of i.subsystems) {
    if (s.state !== 'degraded') continue
    out.push({ id: `subsystem:${s.name}`, name: SUBSYSTEM_NAMES[s.name] ?? s.name, state: 'fallback', code: 'subsystem.degraded', reason: '开机时没起来，其它功能照常。', ...(s.error ? { detail: s.error } : {}) })
  }
  return out
}

const CLI_NAME: Record<'claude' | 'codex' | 'cursor', string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' }
const TERMINAL_RUN = 'cli_hooks_install' as const

/**
 * 四种样子:有接错位置的 ⇒ needs_you「修复」;一家都没接 ⇒ off「接上」(没开不是故障);
 * 接了一部分 ⇒ ok,但带「接上」把剩下的接上;全接上 ⇒ ok + 最近 7 天几个会话。
 */
function terminalCapability(t: NonNullable<CapabilityInputs['terminal']>): Capability {
  const names = (list: typeof t.sources) => list.map(s => CLI_NAME[s.source]).join(' / ')
  const name = `终端里的 ${names(t.sources)}`
  const stale = t.sources.filter(s => s.health === 'stale')
  const missing = t.sources.filter(s => s.health === 'missing')
  const base = { id: 'terminal', name }
  if (stale.length > 0) return { ...base, state: 'needs_you', code: 'terminal.stale', params: { names: names(stale) }, reason: `${names(stale)} 的接线指向一个已经不在的位置（多半是 CC 换过位置），终端里的会话报不到 CC。`, action: { label: '修复', where: 'desktop', run: TERMINAL_RUN } }
  if (missing.length === t.sources.length) return { ...base, state: 'off', code: 'terminal.not_connected', params: { names: names(missing) }, reason: `装了 ${names(missing)}，还没接上：终端里的会话 CC 看不到，做完、等你批准也不会通知你。`, action: { label: '接上', where: 'desktop', run: TERMINAL_RUN } }
  if (missing.length > 0) return { ...base, state: 'ok', code: 'terminal.partial', params: { n: t.sessions7d, names: names(missing) }, reason: `已接上，最近 7 天 ${t.sessions7d} 个终端会话；${names(missing)} 还没接上。`, action: { label: '接上', where: 'desktop', run: TERMINAL_RUN } }
  return { ...base, state: 'ok', code: 'terminal.ok', params: { n: t.sessions7d }, reason: `已接上，最近 7 天 ${t.sessions7d} 个终端会话。` }
}

const RANK: Record<CapabilityState, number> = { needs_you: 3, fallback: 2, off: 1, ok: 0 }
/** 最该看的那一项(needs_you > fallback;off 不算问题)。全好 ⇒ null。 */
export function worstCapability(list: readonly Capability[]): Capability | null {
  let worst: Capability | null = null
  for (const c of list) if (c.state !== 'off' && c.state !== 'ok' && (!worst || RANK[c.state] > RANK[worst.state])) worst = c
  return worst
}
