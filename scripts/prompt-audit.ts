/**
 * prompt-audit — 每次对话的系统提示到底花多少 token？
 *
 * 用真实的 buildSystemPrompt 装配逻辑（同 bootstrap/index.ts 的
 * buildInstructions）算三样东西：
 *   1. 固定骨架：所有可选功能关掉时的最小 append
 *   2. 每个可选功能各自增加多少（单独开一项 − 骨架）
 *   3. 真机内容段：persona.md / profile.md / knowledge.md 的实际占用
 *      （读 --state 指定的状态目录，默认 ~/.claude/channels/wechat）
 *
 * 注意口径：这里量的只是 systemPrompt.append。SDK 的 claude_code preset
 * 本体 + MCP 工具 schema（bootstrap 注释估 ~2-4k tokens）在此之外。
 *
 * 用法：bun scripts/prompt-audit.ts [--state <dir>] [--chat <chatId>]
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildSystemPrompt,
  CORE_MEMORY_MAX_CHARS,
  KNOWLEDGE_MEMORY_MAX_CHARS,
  type BuildSystemPromptArgs,
} from '../src/core/prompt-builder'
import { estimateTokens } from '../src/lib/token-estimate'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const stateDir = arg('--state') ?? join(homedir(), '.claude', 'channels', 'wechat')

function readState(rel: string): string | null {
  const p = join(stateDir, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

// Owner chat — same resolution as main.ts's personaFor (companion config).
function ownerChatId(): string | null {
  const raw = readState(join('companion', 'config.json'))
  if (!raw) return null
  try {
    const id = (JSON.parse(raw) as { default_chat_id?: string }).default_chat_id ?? null
    if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) return null
    return id
  } catch {
    return null
  }
}

const chatId = arg('--chat') ?? ownerChatId()

// Same caps as main.ts's coreMemoryFor / knowledgeMemoryFor.
const persona = chatId ? readState(join('memory', chatId, 'persona.md')) : null
const profile = chatId ? (readState(join('memory', chatId, 'profile.md')) ?? '').slice(0, CORE_MEMORY_MAX_CHARS) : ''
const knowledge = chatId ? (readState(join('memory', chatId, 'knowledge.md')) ?? '').slice(0, KNOWLEDGE_MEMORY_MAX_CHARS) : ''

const BASE: BuildSystemPromptArgs = {
  providerId: 'claude',
  peerProviderId: 'codex',
  companionEnabled: false,
  delegateAvailable: false,
}

const skeleton = buildSystemPrompt(BASE)

// Each optional feature measured as (skeleton + just this feature) − skeleton.
const FEATURES: Array<[string, Partial<BuildSystemPromptArgs>]> = [
  ['delegate（跨模型转交）', { delegateAvailable: true }],
  ['companion（主动关心 tick）', { companionEnabled: true }],
  ['daemonOps（自愈/诊断，admin）', { daemonOpsAvailable: true }],
  ['fileLocate（找文件，admin）', { fileLocateAvailable: true }],
  ['care（关心写作指引）', { careEnabled: true }],
  ['newRelationship（新关系引导）', { newRelationship: true }],
  ['personaCultivate（人设培育）', { personaCultivate: true, personaEmpty: false }],
  ['bubbleReplies（分气泡回复）', { bubbleReplies: true }],
  ['sticker（表情包，样例 2 标签）', { stickerTags: ['开心', '捂脸'] }],
  ['knowledge 工具编排（admin 全开）', { knowledgeSearchAvailable: true, graphAvailable: true, factsAvailable: true, personAvailable: true }],
  ['persona.md（真机内容）', { persona: persona ?? undefined }],
  ['profile.md 核心记忆（真机内容）', { coreMemory: profile }],
  ['knowledge.md 蒸馏知识（真机内容）', { knowledgeMemory: knowledge }],
]

function row(label: string, text: string, base = 0): string {
  const chars = text.length - base
  return `${label.padEnd(30, '　')} ${String(chars).padStart(7)} 字符  ≈${String(estimateTokens(text) - (base ? estimateTokens(skeleton) : 0)).padStart(6)} tokens`
}

console.log(`状态目录: ${stateDir}`)
console.log(`审计聊天: ${chatId ?? '（未找到 owner 聊天 — 内容段为空）'}\n`)
console.log(row('固定骨架（全部可选功能关）', skeleton))
console.log('─'.repeat(66))
let missing: string[] = []
for (const [label, extra] of FEATURES) {
  const withFeature = buildSystemPrompt({ ...BASE, ...extra })
  if (withFeature.length === skeleton.length) { missing.push(label); continue }
  console.log(row(label, withFeature, skeleton.length))
}
if (missing.length) console.log(`（无增量/内容为空：${missing.join('，')}）`)

// The real deal: an admin owner-chat session with everything typically on.
const adminAll = buildSystemPrompt({
  ...BASE,
  delegateAvailable: true,
  companionEnabled: true,
  daemonOpsAvailable: true,
  fileLocateAvailable: true,
  careEnabled: true,
  personaCultivate: true,
  personaEmpty: !(persona && persona.trim()),
  bubbleReplies: true,
  stickerTags: ['开心', '捂脸'],
  knowledgeSearchAvailable: true,
  graphAvailable: true,
  factsAvailable: true,
  personAvailable: true,
  persona: persona ?? undefined,
  coreMemory: profile,
  knowledgeMemory: knowledge,
})
const guestMin = buildSystemPrompt({ ...BASE, coreMemory: profile })
console.log('─'.repeat(66))
console.log(row('admin 主人聊天（典型全开）', adminAll))
console.log(row('guest 最小会话（骨架+核心记忆）', guestMin))
console.log('\n口径：仅 systemPrompt.append；claude_code preset 本体与 MCP 工具 schema 另计（bootstrap 注释估 ~2-4k tokens）。')
