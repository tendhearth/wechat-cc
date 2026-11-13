/** Pure, seeded, invented conversations. This module must have no I/O imports. */
import type { CheckupEstimate, CheckupProfile } from '@wechat-cc/protocol'

export const DEFAULT_CHECKUP_WINDOW = 8192
export const DEFAULT_RELIABLE_FILL = .25
export const CHECKUP_SEED = 769906
export const CHECKUP_RATIOS = [.1, .25, .4, .6, .8] as const
export const RELIABLE_ACCURACY = .8
import type { InterviewSample } from './checkup-interview'
export type CheckupSample =
  | InterviewSample
  | { kind: 'memory'; prompt: string; answers: string[]; fillRatio: number; estimatedTokens: number }
  | { kind: 'tool'; prompt: string; tool: string; input: Record<string, string>; estimatedTokens: number }
import type { CheckupTurn } from './checkup-types'
export type { CheckupTurn } from './checkup-types'
export interface PlanOptions { windowTokens: number; full: boolean; seed?: number }

/** Conservative byte-based planning, not a provider tokenizer or billing receipt. */
export const estimateTokens = (text: string): number => Math.ceil(new TextEncoder().encode(text).length / 3)

export function buildCheckupPlan(o: PlanOptions): { memory: Extract<CheckupSample, {kind:'memory'}>[]; tools: Extract<CheckupSample, {kind:'tool'}>[] } {
  let seed = (o.seed ?? CHECKUP_SEED) >>> 0
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed.toString(36).padStart(7, '0') }
  const memory: Extract<CheckupSample, {kind:'memory'}>[] = []
  for (const fillRatio of CHECKUP_RATIOS) for (let repeat = 0; repeat < (o.full ? 3 : 1); repeat++) {
    const answers = [next(), next(), next()]
    const header = '这是一段完全虚构的对话，人物、物品和代号都是编造的。只根据对话作答。\n'
    const question = '\n请按顺序回忆：虚构人物阿圆的包裹代号、小澄的车票代号、阿沐的盆栽代号。只回 JSON 字符串数组，不解释。'
    const facts = answers.map((a, i) => `用户：${['阿圆的包裹', '小澄的车票', '阿沐的盆栽'][i]}代号是 ${a}。\n助手：记下这个编造的代号了。\n`)
    const targetChars = Math.max(600, Math.floor(o.windowTokens * fillRatio * 3))
    const fillerLength = Math.max(0, targetChars - estimateTokens(header + question + facts.join('')) * 3)
    // Different invented filler every line; prevents a repeated-token compression trick.
    let filler = ''
    while (filler.length < fillerLength) filler += `User: In the invented market, paper ticket ${next()} sits on a wooden shelf.\nAssistant: Another ordinary fictional detail.\n`
    filler = filler.slice(0, fillerLength)
    const n = filler.length
    const prompt = header + filler.slice(0, Math.floor(n*.1)) + facts[0] + filler.slice(Math.floor(n*.1), Math.floor(n*.5)) + facts[1] + filler.slice(Math.floor(n*.5), Math.floor(n*.9)) + facts[2] + filler.slice(Math.floor(n*.9)) + question
    memory.push({ kind: 'memory', prompt, answers, fillRatio, estimatedTokens: estimateTokens(prompt) })
  }
  const tools: Extract<CheckupSample, {kind:'tool'}>[] = []
  for (let i = 0; i < (o.full ? 6 : 3); i++) {
    const tool = ['checkup_lookup', 'checkup_reserve', 'checkup_label'][i % 3]!
    const input = { code: next(), place: ['纸城', '云岛', '木港'][i % 3]! }
    const prompt = `这是虚构的工具练习。必须调用一次 ${tool}，参数严格是 ${JSON.stringify(input)}。不要调用其他工具，不要只用文字说已经做了。完成后只答「好了」。`
    tools.push({ kind: 'tool', prompt, tool, input, estimatedTokens: estimateTokens(prompt) + 180 })
  }
  return { memory, tools }
}

export function estimateCheckup(o: PlanOptions & { windowKnown?: boolean }): Omit<CheckupEstimate,'targetKey'> {
  const plan = buildCheckupPlan(o), samples = [...plan.memory, ...plan.tools]
  const requests = plan.memory.length + plan.tools.length * 2
  // #906: at most 3 attempts before any output; no retry after a tool ran.
  const maxRequests = plan.memory.length * 3 + plan.tools.length * 4
  return { requests, maxRequests, inputTokens: samples.reduce((n, s) => n + (s.estimatedTokens + 256) * 3, 0) + plan.tools.reduce((n,s)=>n+s.estimatedTokens+1024,0), outputTokens: maxRequests * 512, windowKnown: o.windowKnown ?? false }
}

export function scoreMemory(text: string, answers: string[]): number {
  try {
    const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
    if (!Array.isArray(value)) return 0
    return answers.filter((a, i) => value[i] === a).length / answers.length
  } catch { return 0 }
}

export function gradeMemory(stages: CheckupProfile['stages']): Pick<CheckupProfile, 'memory'|'reliableFillRatio'> {
  // A later lucky answer cannot make an already unreliable smaller context reliable.
  let reliableFillRatio = 0
  for (const s of stages) { if (s.accuracy < RELIABLE_ACCURACY) break; reliableFillRatio = s.fillRatio }
  return { reliableFillRatio, memory: reliableFillRatio >= .6 ? 'good' : reliableFillRatio >= .25 ? 'fair' : 'weak' }
}
export function scoreTool(sample: Extract<CheckupSample, {kind:'tool'}>, turn: CheckupTurn): number {
  if (turn.toolError || turn.toolCalls.length !== 1) return 0
  const call = turn.toolCalls[0]!
  const input = call.input
  return call.name === sample.tool && !!input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).length === Object.keys(sample.input).length
    && Object.entries(sample.input).every(([k,v]) => (input as Record<string,unknown>)[k] === v) ? 1 : 0
}
export function median(values: number[]): number {
  const sorted = [...values].sort((a,b) => a-b), n = sorted.length
  return n === 0 ? 0 : n % 2 ? sorted[Math.floor(n/2)]! : (sorted[n/2-1]! + sorted[n/2]!) / 2
}
