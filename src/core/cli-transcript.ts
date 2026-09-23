/**
 * cli-transcript.ts — 把两家的会话记录尾巴渲染成一页 markdown(「看 码」)。
 *
 * Claude:`~/.claude/projects/<dir>/<session>.jsonl`,行 = { type: user|assistant, message: { content } }。
 * Codex:`~/.codex/sessions/.../rollout-*.jsonl`,行 = { type: response_item, payload: { type: message, role, content } }。
 * 两边都只取文字,工具调用、思考、harness 塞的东西(system-reminder / task-notification /
 * environment_context)全部跳过 —— 主人要看的是对话,不是机器的自言自语。
 */
import type { CliSource } from './cli-events'

export interface TranscriptTurn { role: 'user' | 'assistant'; text: string }

export const TRANSCRIPT_TAIL_TURNS = 8
const TURN_MAX = 4000

function isHarnessText(t: string): boolean {
  const s = t.trimStart()
  return s.startsWith('<system-reminder>') || s.startsWith('<task-notification>') || s.startsWith('<command-message>')
    || s.startsWith('<environment_context>') || s.startsWith('<permissions instructions>') || s.startsWith('<local-command')
}

function textOf(content: unknown, kinds: string[]): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((x): x is { type: string; text?: string } => !!x && typeof x === 'object' && kinds.includes((x as { type?: string }).type ?? ''))
    .map(x => x.text ?? '')
    .join('\n')
}

export function parseTranscript(jsonl: string, source: CliSource): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let d: Record<string, unknown>
    try { d = JSON.parse(line) as Record<string, unknown> } catch { continue }
    let role: 'user' | 'assistant' | null = null
    let text = ''
    if (source === 'claude') {
      if (d['isMeta']) continue
      if (d['type'] !== 'user' && d['type'] !== 'assistant') continue
      role = d['type'] as 'user' | 'assistant'
      const m = d['message'] as { content?: unknown } | undefined
      text = textOf(m?.content, ['text'])
    } else {
      if (d['type'] !== 'response_item') continue
      const p = d['payload'] as { type?: string; role?: string; content?: unknown } | undefined
      if (!p || p.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) continue
      role = p.role
      text = textOf(p.content, ['input_text', 'output_text'])
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
        .replace(/<\/?(function|parameter)[^>]*>/g, '')
    }
    text = text.trim()
    if (!text || isHarnessText(text)) continue
    if (text.length > TURN_MAX) text = text.slice(0, TURN_MAX - 1) + '…'
    turns.push({ role, text })
  }
  return turns
}

export function renderTranscriptTail(jsonl: string, source: CliSource, opts: { turns?: number; title?: string } = {}): string {
  const all = parseTranscript(jsonl, source)
  const tail = all.slice(-(opts.turns ?? TRANSCRIPT_TAIL_TURNS))
  const lines: string[] = []
  if (opts.title) lines.push(`# ${opts.title}`, '')
  if (all.length > tail.length) lines.push(`_(共 ${all.length} 段,只显示最后 ${tail.length} 段)_`, '')
  if (tail.length === 0) lines.push('_(这条会话还没有对话文字)_')
  for (const t of tail) {
    lines.push(t.role === 'user' ? '**你**:' : `**${source}**:`, '', t.text, '', '---', '')
  }
  return lines.join('\n').trim() + '\n'
}
