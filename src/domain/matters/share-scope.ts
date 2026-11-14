/**
 * 分享给合伙人的那一页能看到什么(设计稿 docs/superpowers/specs/2026-11-14-share-a-matter-design.md)。
 *
 * 和 phone-scope.ts 的 linkMatterStatus 同一个写法:只挑允许的字段往外放,不是从完整详情里往下删。
 * 以后详情里加了新字段,默认到不了合伙人那里。
 *
 * 合伙人看得到:这件事的标题、状态、每一棒是谁在做什么、记录本、产出的名字。
 * 看不到:任何编号(事、棒、会话)、本机绝对路径、批准卡和提问的内容、执行者的原始对话、主人的其他东西。
 */
import { redactSecrets } from '../cli-transcript'

/** 链接默认 14 天过期(设计稿「主人这边」)。 */
export const SHARE_TTL_MS = 14 * 24 * 60 * 60 * 1000
export const SHARE_NAME_MAX = 24
/** 一页最多给这么多条记录,从最新的往回数。 */
export const SHARE_NOTES_MAX = 60
const TEXT_MAX = 2000

/** 主人分享时给合伙人起的名字:留话署名用它,也显示在主人的分享列表里。不合格 ⇒ null。 */
export function shareName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').replace(/\s+/g, ' ').trim()
  if (!name || [...name].length > SHARE_NAME_MAX) return null
  // 冒号留给署名前缀(partner:<名字>),尖括号和反引号免得进了记录本被执行者当成标记。
  return /[:：<>`]/.test(name) ? null : name
}

export interface ShareRecord { expiresAt: number; revokedAt: number | null }
export type ShareRefusal = 'revoked' | 'expired' | 'archived' | 'not_shareable'

/**
 * 这个链接现在还能不能打开。撤销、过期、这件事归档了,都打不开;聊天不能分享,只分享交办的事。
 * 每次请求都判一遍,不靠登记令牌时的那一次。
 */
export function shareRefusal(share: ShareRecord, matter: { kind: string; archivedAt: number | null } | null, now: number): ShareRefusal | null {
  if (share.revokedAt !== null) return 'revoked'
  if (now >= share.expiresAt) return 'expired'
  if (!matter || matter.kind !== 'task') return 'not_shareable'
  if (matter.archivedAt !== null) return 'archived'
  return null
}

const SEG = '[\\p{L}\\p{N}_.@+~-]'
const ABSOLUTE_PATH = new RegExp(`(?<![\\p{L}\\p{N}_.@/\\\\-])(?:~|[A-Za-z]:)?[/\\\\](?:${SEG}+[/\\\\])+${SEG}*`, 'gu')
const SYSTEM_ROOTS = new Set(['Users', 'home', 'private', 'var', 'tmp', 'Volumes', 'opt', 'etc', 'root', 'mnt', 'Library', 'Applications'])

/**
 * 去掉本机绝对路径:项目里的写成相对路径,别处的只留最后一段。用户名、磁盘布局不该到合伙人那里。
 * 网址和相对路径不动;「/v1/health」这种两段以内、又不在系统目录下的也不动。
 */
export function withoutLocalPaths(text: string, projectPath: string | null): string {
  let out = text
  for (const root of projectRoots(projectPath)) out = out.split(root + '/').join('').split(root).join('.')
  return out.replace(ABSOLUTE_PATH, path => {
    const segments = path.split(/[/\\]/).filter(Boolean), rooted = /^(~|[A-Za-z]:)/.test(path) || SYSTEM_ROOTS.has(segments[0] ?? '')
    if (!rooted && segments.length < 3) return path
    // 「/Users/某人」本身就是要藏的东西,不留最后一段。
    return segments.length < 3 ? '…' : '…/' + segments.at(-1)
  })
}
function projectRoots(projectPath: string | null): string[] {
  if (!projectPath) return []
  const root = projectPath.replace(/\/+$/, '')
  if (root.length < 2) return []
  // macOS 的 /tmp、/var 实际在 /private 下,执行者两种写法都会用。
  const twin = root.startsWith('/private/') ? root.slice('/private'.length) : /^\/(tmp|var)\//.test(root) ? '/private' + root : null
  return [root, ...(twin ? [twin] : [])].sort((a, b) => b.length - a.length)
}

const clean = (text: unknown, projectPath: string | null): string => {
  const plain = typeof text === 'string' ? text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, c => (c === '\n' ? '\n' : ' ')) : ''
  const safe = withoutLocalPaths(redactSecrets(plain), projectPath).trim()
  return safe.length > TEXT_MAX ? safe.slice(0, TEXT_MAX - 1) + '…' : safe
}

export type SharedState = 'working' | 'waiting_owner' | 'stopped' | 'done'
export interface SharedLeg { position: number; executor: string; brief: string; status: 'queued' | 'running' | 'done' | 'stopped' }
export interface SharedNote { author: string; partner: boolean; kind: 'plan' | 'note' | 'artifact'; text: string; at: number }
export interface SharedOutput { name: string; size: number | null }
export interface SharedMatter { title: string; state: SharedState; legs: SharedLeg[]; notes: SharedNote[]; notesOmitted: number; outputs: SharedOutput[] }

export interface ShareSource {
  matter: { title: string; projectPath: string | null }
  task: { status: string; phase?: string | null; providerId?: string | null } | null
  /** 没有记录本(只有一位执行者)时为空,这时用 task 拼出唯一的一棒。 */
  agentRuns: readonly { executor: string; brief: string; position: number; status: string }[]
  notes: readonly { author: string; kind: string; text: string; createdAt: number }[]
  notesTotal: number
  /** 主人还有没处理的批准卡或提问。内容不给,只给「在等主人」。 */
  ownerPending: boolean
  artifacts: readonly { name: string; size?: number | null }[]
}

const LEG_STATUS: Record<string, SharedLeg['status']> = { queued: 'queued', running: 'running', completed: 'done', failed: 'stopped', cancelled: 'stopped', interrupted: 'stopped' }
const WORKING = new Set(['running', 'queued', 'working', 'starting'])
const DONE = new Set(['completed', 'done'])
/** 留话的署名前缀(第 2 步用);投影这里只负责把它显示成名字。 */
export const PARTNER_AUTHOR_PREFIX = 'partner:'

export function sharedMatterView(source: ShareSource): SharedMatter {
  const root = source.matter.projectPath
  const status = source.task?.status ?? ''
  // 回复过、停在那里等下一句的事(phase=replied)对合伙人来说就是这一轮做完了。
  const settled = DONE.has(status) || source.task?.phase === 'replied'
  const active = WORKING.has(status) && !settled
  const legs: SharedLeg[] = source.agentRuns.length
    ? [...source.agentRuns].sort((a, b) => a.position - b.position).map(run => ({ position: run.position, executor: clean(run.executor, null).slice(0, 64), brief: clean(run.brief, root), status: LEG_STATUS[run.status] ?? 'stopped' }))
    : source.task?.providerId ? [{ position: 1, executor: clean(source.task.providerId, null).slice(0, 64), brief: '', status: active ? 'running' : settled ? 'done' : 'stopped' }] : []
  const kept = source.notes.filter(note => note.kind === 'plan' || note.kind === 'note' || note.kind === 'artifact').slice(-SHARE_NOTES_MAX)
  const notes = kept.map((note): SharedNote => {
    const partner = note.author.startsWith(PARTNER_AUTHOR_PREFIX)
    return { author: clean(partner ? note.author.slice(PARTNER_AUTHOR_PREFIX.length) : note.author, null).slice(0, 64), partner, kind: note.kind as SharedNote['kind'], text: clean(note.text, root), at: note.createdAt }
  })
  const has = (wanted: SharedLeg['status']) => legs.some(leg => leg.status === wanted)
  const state: SharedState = source.ownerPending ? 'waiting_owner'
    : has('running') ? 'working'
    : has('stopped') ? 'stopped'
    // 上一棒刚做完、下一棒还没起的那一小会儿算在做;停住不派的(额度用完等)算停下。
    : has('queued') ? (active ? 'working' : 'stopped')
    : legs.length ? 'done'
    : active ? 'working' : settled ? 'done' : 'stopped'
  return {
    title: clean(source.matter.title, root).slice(0, 200), state, legs, notes,
    notesOmitted: Math.max(0, source.notesTotal - notes.length),
    // 只给文件名:成果目录里的相对位置也不给,名字里夹带的目录去掉。
    outputs: source.artifacts.map(file => ({ name: clean(String(file.name).split(/[/\\]/).filter(Boolean).at(-1) ?? '', null).slice(0, 200), size: typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : null })).filter(file => file.name),
  }
}
