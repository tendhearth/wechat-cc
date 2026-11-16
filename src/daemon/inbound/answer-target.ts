import type { AnswerTarget } from '../../domain/answer-target'
import type { Intent } from './intent'
import type { Decision } from './mw-task-reference'

export interface AnswerProvider { id: string; names: readonly string[]; available: boolean }
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 整句以明确指令开头；问句、否定、引用或仅提名字均不猜。名字只来自可信目录。 */
export function explicitAnswerName(text: string, names: readonly string[]): boolean {
  const alternatives = names.filter(n => n.trim() && n.toLowerCase() !== 'cc').map(escape).sort((a, b) => b.length - a.length).join('|')
  if (!alternatives) return false
  // 「让 Codex 回答这个问题吗?」「让它答吧」是在商量要不要,不是点名;留给 CC。
  if (/[吗呢么嘛吧][？?。!！]?\s*$/.test(text.trim())) return false
  const who = `(?:让|请|请让)\\s*(?:${alternatives})\\s*(?:来)?`
  const end = `(?:[。！!？?]?|\\s*[:：，,]\\s*[\\s\\S]+)`
  // 「回答」后面可以直接接正文(让 Claude 回答一下为什么会失败);单字「答」只认结尾或带分隔的正文,免得「答应」被当成点名。
  const long = `${who}回答(?:这(?:个问题|个|句|一道题)|一下)?(?:${end}|\\s*[^\\s:：，,。！!？?][\\s\\S]*)`
  const short = `${who}答(?:这(?:个问题|个|句|一道题)|一下)?${end}`
  const suffix = `(?:这(?:个问题|个|句))\\s*(?:让|请让)\\s*(?:${alternatives})\\s*(?:来)?(?:回答|答)${end}`
  return new RegExp(`^(?:${long}|${short}|${suffix})$`, 'i').test(text.trim())
}

export function namedAnswerTarget(text: string, providers: readonly AnswerProvider[], unavailableNames: readonly string[] = []): AnswerTarget | null {
  const switchNames = [...new Set([...providers.flatMap(p => [p.id, ...p.names]), ...unavailableNames])].filter(n => n.trim()).map(escape).sort((a, b) => b.length - a.length)
  if (switchNames.length && new RegExp(`^(?:换成|用|切回|切到)\\s*(?:${switchNames.join('|')})(?:\\s*[。！!]?|[，,:：][\\s\\S]*)$`, 'i').test(text.trim())) {
    return Object.freeze({ kind: 'cc', reason: 'persistent_provider_switch' })
  }
  const matches = providers.filter(p => explicitAnswerName(text, [p.id, ...p.names]))
  if (matches.length > 1) return Object.freeze({ kind: 'cc', reason: 'uncertain_provider' })
  const p = matches[0]
  if (p) return Object.freeze(p.available
    ? { kind: 'oneoff', provider: p.id, reason: 'explicit_provider' }
    : { kind: 'clarify', provider: p.id, reason: 'provider_unavailable' })
  if (explicitAnswerName(text, unavailableNames)) return Object.freeze({ kind: 'clarify', reason: 'provider_unavailable' })
  return null
}

export function matterAnswerTarget(matterId: string): AnswerTarget {
  return Object.freeze({ kind: 'matter', matterId, reason: 'explicit_matter' })
}

export function intentAnswerTarget(intent: Intent): AnswerTarget {
  if (intent.kind === 'command') return Object.freeze({ kind: 'cc', reason: 'existing_command' })
  if (intent.kind === 'task-reference') {
    const d = intent.data as Decision | undefined
    const matterId = d && ('picked' in d ? d.picked.id : 'taskId' in d ? d.taskId : 'task' in d ? d.task.id : 'offer' in d ? d.offer.task.id : undefined)
    if (matterId) return Object.freeze({ kind: 'matter', matterId, reason: 'existing_matter_reference' })
    return Object.freeze({ kind: 'clarify', reason: 'existing_matter_choice' })
  }
  return Object.freeze({ kind: 'cc', reason: 'default_cc' })
}

/** 白名单回执，绝不展开 ctx/msg 或解析结果（其中有正文）。 */
export function recordAnswerTarget(log: (tag: string, line: string) => void, requestId: string, target: AnswerTarget): void {
  log('ANSWER_TARGET', JSON.stringify({ requestId, kind: target.kind, ...('matterId' in target ? { matterId: target.matterId } : {}), ...('provider' in target && target.provider ? { provider: target.provider } : {}), reason: target.reason }))
}
