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
export interface Capability {
  id: string
  name: string
  state: CapabilityState
  /** 稳定的原因码(如 `disk.denied`),手机按它本地化;认不出的码用 reason 原文。params 是可替换的值。 */
  code: string
  params?: Record<string, string | number>
  reason: string
  action?: { label: string; where: 'desktop' | 'settings' | 'wechat'; url?: string }
  detail?: string
}

export interface CapabilityInputs {
  wechat: { outbound: 'unknown' | 'ok' | 'degraded'; expired: number; lastError?: string | null }
  brain: { provider: string; name: string; registered: boolean; retrying: boolean; lastError?: string | null }
  /** null = 没开网络守护(不出现)。 */
  guard: { safe: boolean; paused: boolean; detail?: string | null } | null
  /** null = 不是 macOS / 判断不了(不出现)。 */
  fullDiskAccess: { granted: boolean; settingsUrl: string } | null
  /** null = 没开知识库(不出现)。embed:实际在用的那条路。 */
  knowledge: { built: boolean; embed: 'js' | 'python' | 'js_fell_back' | 'none' } | null
  /** null = 关了每晚整理(不出现)。 */
  memory: { failures: number; firstRunDone: boolean } | null
  phone: { relay: boolean; devices: number }
  subsystems: Array<{ name: string; state: 'ok' | 'degraded' | 'off'; error?: string }>
}

const SUBSYSTEM_NAMES: Record<string, string> = {
  knowledge: '知识库', 'cli-upgrade': '外部 CLI 自动升级', 'a2a-server': 'CC 之间的往来', 'customer-review': '客户回顾', guard: '网络守护',
  'mailbox-poller': '笔友信箱', 'memory-nightly': '记忆整理', pairing: '手机配对', reminders: '提醒', reports: '任务回报', 'self-restart': '空闲自动重启', social: '社交', yi: '一件事',
}

export function buildCapabilities(i: CapabilityInputs): Capability[] {
  const out: Capability[] = []

  // 微信:登录失效只有主人能修(重新扫码);外发失败多半是网络,CC 在重试。
  if (i.wechat.expired > 0) out.push({ id: 'wechat', name: '微信', state: 'needs_you', code: 'wechat.expired', reason: '微信登录失效了，CC 收不到也发不出消息。', action: { label: '重新扫码绑定', where: 'desktop' } })
  else if (i.wechat.outbound === 'degraded') out.push({ id: 'wechat', name: '微信', state: 'fallback', code: 'wechat.degraded', reason: '最近发微信消息失败，CC 在自动重试。', ...(i.wechat.lastError ? { detail: i.wechat.lastError } : {}) })
  else out.push({ id: 'wechat', name: '微信', state: 'ok', code: i.wechat.outbound === 'ok' ? 'wechat.ok' : 'wechat.idle', reason: i.wechat.outbound === 'ok' ? '收发正常。' : '已连上，还没发过消息。' })

  // 大脑:当前选的后端注册上没有。
  if (i.brain.registered) out.push({ id: 'brain', name: '大脑', state: 'ok', code: 'brain.ok', params: { name: i.brain.name }, reason: `在用 ${i.brain.name}。` })
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

  if (!i.phone.relay) out.push({ id: 'phone', name: '手机', state: 'off', code: 'phone.relay_off', reason: '没开手机连接。' })
  else if (i.phone.devices === 0) out.push({ id: 'phone', name: '手机', state: 'off', code: 'phone.no_device', reason: '还没连接手机。', action: { label: '在电脑上连接手机', where: 'desktop' } })
  else out.push({ id: 'phone', name: '手机', state: 'ok', code: 'phone.ok', params: { n: i.phone.devices }, reason: `已连接 ${i.phone.devices} 台。` })

  for (const s of i.subsystems) {
    if (s.state !== 'degraded') continue
    out.push({ id: `subsystem:${s.name}`, name: SUBSYSTEM_NAMES[s.name] ?? s.name, state: 'fallback', code: 'subsystem.degraded', reason: '开机时没起来，其它功能照常。', ...(s.error ? { detail: s.error } : {}) })
  }
  return out
}

const RANK: Record<CapabilityState, number> = { needs_you: 3, fallback: 2, off: 1, ok: 0 }
/** 最该看的那一项(needs_you > fallback;off 不算问题)。全好 ⇒ null。 */
export function worstCapability(list: readonly Capability[]): Capability | null {
  let worst: Capability | null = null
  for (const c of list) if (c.state !== 'off' && c.state !== 'ok' && (!worst || RANK[c.state] > RANK[worst.state])) worst = c
  return worst
}
