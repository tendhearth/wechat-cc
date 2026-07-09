/**
 * memory-synthesis — build a holistic "overview memory" for the admin from
 * their local Claude Code per-project memory.
 *
 * The admin's own claude/codex memory lives, per project, under
 *   ~/.claude/projects/<encoded-cwd>/memory/   (MEMORY.md index + *.md files)
 * That raw memory is owned by Claude Code (we never edit or copy-mirror it —
 * see the design note in the import-claude-codex memory). Instead, on demand
 * (desktop "刷新" button, or the admin asking the bot in WeChat), we run a
 * single cheap LLM pass that reads across ALL project memories and writes ONE
 * synthesized file —
 *   <stateDir>/memory/<adminChatId>/_overview.md
 * — capturing "who the admin is / what they're working on" plus a project map
 * (project name + one-liner each). buildMemorySnapshot() reads that dir, so
 * the overview is automatically fed to the bot as the admin's "懂我" context.
 * Only the synthesized overview is fed to the bot — the raw per-project memory
 * is kept out of the prompt to save tokens (it stays viewable in the desktop
 * memory pane as provenance).
 *
 * This module is provider-agnostic: the LLM call is an injected `sdkEval`
 * (same pattern as summarizer-runtime), so the CLI wires the admin's provider
 * (claude/codex) and tests pass a mock.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
/**
 * Injected accessor for the daemon-owned "life" stores. Declared here (the
 * consumer) as a plain interface so this CLI module needs no `src/daemon`
 * import — the daemon supplies the implementation via `makeLifeStoresReader`.
 * Each method returns the raw bodies oldest→newest; gatherLifeContext filters
 * + keeps the most recent.
 */
export interface LifeStoresReader {
  listObservations(adminChatId: string): Promise<string[]>
  listMilestones(adminChatId: string): Promise<string[]>
}
import { readMemoryProfileFile, writeMemoryFile, writeMemoryProfileFile } from './memory'
import { surveyFiles, formatFileSurvey, defaultLifeDirs, type SurveyResult } from './file-survey'

/** Default root for Claude Code's per-project memory dirs. */
export function defaultClaudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

/** Filename of the synthesized overview written into the admin memory dir. */
export const OVERVIEW_FILENAME = '_overview.md'
export const PROFILE_FILENAME = '_profile.json'

// Keep the prompt bounded: cap per-project content and total embedded bytes
// so a project with a huge memory store can't blow up the eval. MEMORY.md
// (the index) is always kept; individual files are truncated past the cap.
const PER_FILE_CAP = 4_000
const PER_PROJECT_CAP = 12_000
const TOTAL_CAP = 40_000

export interface ProjectMemory {
  /** Encoded project dir name, e.g. "-Users-me-Documents-sec-company". */
  encodedDir: string
  /** Best-effort human project name, e.g. "sec-company". */
  displayName: string
  /** MEMORY.md index content, if present. */
  index: string | null
  /** Other .md files (excludes MEMORY.md), path relative to the memory dir. */
  files: Array<{ path: string; content: string }>
  /** Sum of bytes across index + files (pre-truncation). */
  totalBytes: number
}

// Path segments we treat as "containers" (drop the leading one so the name
// reads as the project, not its parent folder).
const CONTAINER_SEGMENTS = new Set([
  'documents', 'desktop', 'downloads', 'projects', 'project', 'code', 'src',
  'repos', 'repositories', 'workspace', 'work', 'git',
])

/**
 * Best-effort project name from the encoded dir. Claude encodes the absolute
 * cwd by replacing every non-alphanumeric char with '-' (so both '/' and '_'
 * collapse to '-' — not perfectly invertible). We strip the encoded home
 * prefix (re-encoding os.homedir() the same way) and a leading container
 * segment (Documents/projects/…), then re-join the rest with '-'. Falls back
 * to the trailing segment. The LLM also sees the memory content, so a rough
 * name here is fine — it can relabel from content.
 */
export function projectDisplayName(encodedDir: string, home: string = homedir()): string {
  const encode = (s: string): string => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const encHome = encode(home)
  let rest = encodedDir.replace(/^-+/, '')
  if (encHome && rest.toLowerCase().startsWith(`${encHome.toLowerCase()}-`)) {
    rest = rest.slice(encHome.length).replace(/^-+/, '')
  }
  const segs = rest.split('-').filter(Boolean)
  if (segs.length > 1 && CONTAINER_SEGMENTS.has(segs[0]!.toLowerCase())) segs.shift()
  return segs.join('-') || encodedDir.replace(/^-+/, '') || encodedDir
}

function listMd(dir: string): string[] {
  const out: string[] = []
  const walk = (sub: string): void => {
    const here = sub ? join(dir, sub) : dir
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(here, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.includes('.tmp-')) continue
      const rel = sub ? `${sub}/${e.name}` : e.name
      if (e.isDirectory()) walk(rel)
      else if (e.isFile() && e.name.endsWith('.md')) out.push(rel)
    }
  }
  walk('')
  return out.sort()
}

/**
 * Scan `projectsRoot` for per-project memory dirs and read their .md files.
 * Projects with no memory dir (or an empty one) are skipped.
 */
export function discoverProjectMemory(projectsRoot: string): ProjectMemory[] {
  if (!existsSync(projectsRoot)) return []
  let projectDirs: string[]
  try {
    projectDirs = readdirSync(projectsRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
  } catch {
    return []
  }
  const out: ProjectMemory[] = []
  for (const encodedDir of projectDirs) {
    const memDir = join(projectsRoot, encodedDir, 'memory')
    if (!existsSync(memDir)) continue
    const relPaths = listMd(memDir)
    if (relPaths.length === 0) continue
    let index: string | null = null
    const files: Array<{ path: string; content: string }> = []
    let totalBytes = 0
    for (const rel of relPaths) {
      let content: string
      let size: number
      try {
        const abs = join(memDir, rel)
        content = readFileSync(abs, 'utf8')
        size = statSync(abs).size
      } catch {
        continue
      }
      totalBytes += size
      if (rel === 'MEMORY.md') index = content
      else files.push({ path: rel, content })
    }
    if (index === null && files.length === 0) continue
    out.push({ encodedDir, displayName: projectDisplayName(encodedDir), index, files, totalBytes })
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return out
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s
  return `${s.slice(0, cap)}\n…(截断, 共 ${s.length} 字)`
}

/**
 * Parse absolute directories from the admin's locations.md (sub-project 1's
 * learned file locations). File-ish paths (basename has an extension) collapse
 * to their parent dir; dir paths are used as-is. Best-effort: missing file → [].
 */
function parseLocationRoots(stateDir: string, adminChatId: string): string[] {
  try {
    const text = readFileSync(join(stateDir, 'memory', adminChatId, 'locations.md'), 'utf8')
    const out = new Set<string>()
    for (const line of text.split('\n')) {
      const m = line.match(/(?:→|->|:)\s*(\/.+?)\s*$/)   // path = tail after delimiter; may contain spaces
      const raw = m?.[1]
      if (!raw) continue
      out.add(/\.[^/]+$/.test(raw) ? dirname(raw) : raw.replace(/\/+$/, ''))
    }
    return [...out]
  } catch { return [] }
}

/**
 * Gather the file-side survey for the overview. Roots default to the life dirs
 * plus locations.md dirs; callers (tests) may override via `roots`. Best-effort:
 * any failure → empty survey (mirrors gatherLifeContext).
 */
export function gatherFileSurvey(opts: { stateDir: string; adminChatId: string; roots?: string[] }): SurveyResult {
  try {
    const roots = opts.roots ?? [...parseLocationRoots(opts.stateDir, opts.adminChatId), ...defaultLifeDirs()]
    return surveyFiles({ roots })
  } catch { return { folders: [], truncated: false } }
}

/**
 * Build the synthesis prompt. The model produces a single Chinese markdown
 * document = the admin's "overview memory" spanning WORK (project memory) AND
 * LIFE (companion observations/milestones/notes) as one whole person. Embedded
 * content is capped to keep the prompt bounded.
 */
export function formatSynthesisPrompt(projects: ProjectMemory[], life?: LifeContext | null, survey?: SurveyResult | null): string {
  const hasLife = !lifeIsEmpty(life ?? null)
  const hasSurvey = !!survey && survey.folders.length > 0
  const header = [
    hasSurvey
      ? '你是这台电脑主人(下称「管理员」)的个人助理。下面是关于管理员的记忆,分三类:'
      : '你是这台电脑主人(下称「管理员」)的个人助理。下面是关于管理员的记忆,分两类:',
    'A) 工作侧 —— 他在本机各项目里积累的记忆/笔记;',
    hasLife
      ? 'B) 生活侧 —— 你(bot)在微信里观察到的他这个人、在意的人和事、偏好、近况。'
      : '(本次没有生活侧数据。)',
    hasSurvey
      ? 'C) 文件侧 —— 他电脑常用目录里的文件夹结构与文件名概览(只有结构,没有内容)。'
      : '(本次没有文件侧数据。)',
    hasSurvey
      ? '请综合成一份「总体记忆」——让你整体「懂这个人」的精炼画像。工作、生活、电脑里在忙的东西不要分开看,他是一个完整的人。'
      : '请综合成一份「总体记忆」——让你整体「懂这个人」的精炼画像。工作和生活不要分开看,他是一个完整的人。',
    '',
    '要求:',
    '1. 用中文输出一份 markdown,直接作为记忆内容,不要寒暄、不要解释你在做什么。',
    '2. 开头「整体理解」:这个人是谁、在做什么、在意什么、偏好 —— 工作和生活揉在一起写。',
    '3. 一节「## 项目地图」,每个工作项目一行: `- 项目名 — 一句话概述`(项目名用易读的名字)。',
    hasLife ? '4. 一节「## 生活与关系」:他在意的人/事、近况、性格偏好(只写生活侧有依据的)。' : '4. (无生活侧,跳过生活与关系一节。)',
    hasSurvey ? '5. 把文件侧也算进「他在做什么」——从文件夹和文件名推断他最近在忙什么,提炼信号,别逐个罗列文件。' : '5. (无文件侧,忽略。)',
    '6. 简洁,总长 ~600 字内。只写有依据的,别编造。',
    '',
    `工作侧:共 ${projects.length} 个项目`,
    '',
  ].join('\n')

  const blocks: string[] = []
  let budget = TOTAL_CAP
  for (const p of projects) {
    if (budget <= 0) {
      blocks.push(`\n--- 项目: ${p.displayName} (目录 ${p.encodedDir}) ---\n(略, prompt 长度已达上限)`)
      continue
    }
    const sections: string[] = [`\n--- 项目: ${p.displayName} (目录 ${p.encodedDir}) ---`]
    let projBudget = Math.min(PER_PROJECT_CAP, budget)
    if (p.index) {
      const t = truncate(p.index, Math.min(PER_FILE_CAP, projBudget))
      sections.push(`# MEMORY.md (索引)\n${t}`)
      projBudget -= t.length
    }
    for (const f of p.files) {
      if (projBudget <= 0) break
      const t = truncate(f.content, Math.min(PER_FILE_CAP, projBudget))
      sections.push(`# ${f.path}\n${t}`)
      projBudget -= t.length
    }
    const block = sections.join('\n')
    blocks.push(block)
    budget -= block.length
  }

  let lifeBlock = ''
  if (hasLife && life) {
    const parts: string[] = ['\n\n========== 生活侧(微信观察) ==========']
    if (life.observations.length) parts.push(`\n【近期观察】\n${life.observations.map(o => `- ${o}`).join('\n')}`)
    if (life.milestones.length) parts.push(`\n【里程碑】\n${life.milestones.map(m => `- ${m}`).join('\n')}`)
    for (const n of life.memoryNotes) {
      parts.push(`\n【记忆: ${n.name}】\n${truncate(n.content, PER_FILE_CAP)}`)
    }
    lifeBlock = truncate(parts.join('\n'), TOTAL_CAP)
  }

  let surveyBlock = ''
  if (hasSurvey && survey) {
    const rendered = formatFileSurvey(survey)
    if (rendered) surveyBlock = truncate(`\n\n========== 文件侧(本机文件概览) ==========\n${rendered}`, TOTAL_CAP)
  }

  return `${header}${blocks.join('\n')}${lifeBlock}${surveyBlock}\n`
}

/** Read-only metadata view of one project's memory, for the desktop viewer. */
export interface ProjectMemorySummary {
  name: string
  encodedDir: string
  /** MEMORY.md index content, if present. */
  index: string | null
  files: Array<{ path: string; bytes: number; content: string }>
  totalBytes: number
}

/**
 * Lightweight read-only listing of all project memories — what the desktop
 * "项目记忆(原始素材)" layer renders. Content is included (the dirs are
 * local and small in practice); the bot never sees this — only the
 * synthesized overview is fed to the model.
 */
export function summarizeProjectMemories(projectsRoot?: string): ProjectMemorySummary[] {
  const projects = discoverProjectMemory(projectsRoot ?? defaultClaudeProjectsRoot())
  return projects.map(p => ({
    name: p.displayName,
    encodedDir: p.encodedDir,
    index: p.index,
    files: p.files.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.content, 'utf8'), content: f.content })),
    totalBytes: p.totalBytes,
  }))
}

/**
 * The "life" side of the admin — what the WeChat companion layer has gathered:
 * observations + milestones + the per-contact memory notes the bot wrote about
 * the admin. Folded into the overview alongside the work (project) memory so
 * the synthesized "CC 眼中的你" spans the whole person, not just their code.
 */
export interface LifeContext {
  observations: string[]
  milestones: string[]
  memoryNotes: Array<{ name: string; content: string }>
}

/** True when there's no life-side signal at all. */
function lifeIsEmpty(life: LifeContext | null): boolean {
  return !life || (life.observations.length === 0 && life.milestones.length === 0 && life.memoryNotes.length === 0)
}

/**
 * Gather the admin's life-side memory from the daemon's stores + their WeChat
 * memory dir. Best-effort: every source is independently try/caught so a
 * missing table / file degrades to empty rather than failing the synthesis.
 * Excludes `_overview.md` (our own output — never feed it back in).
 */
export async function gatherLifeContext(opts: { stores?: LifeStoresReader | null; stateDir: string; adminChatId: string }): Promise<LifeContext> {
  const { stores, stateDir, adminChatId } = opts
  const memoryRoot = join(stateDir, 'memory')
  const out: LifeContext = { observations: [], milestones: [], memoryNotes: [] }
  // Stores return oldest→newest (ORDER BY ts ASC), so take the LAST N — the
  // most RECENT life context is what makes the overview feel current ("懂你"
  // is about now, not the first things ever noticed).
  if (stores) {
    try { out.observations = (await stores.listObservations(adminChatId)).filter(Boolean).slice(-20) } catch { /* best-effort */ }
    try { out.milestones = (await stores.listMilestones(adminChatId)).filter(Boolean).slice(-20) } catch { /* best-effort */ }
  }
  try {
    const dir = join(memoryRoot, adminChatId)
    for (const rel of listMd(dir)) {
      if (rel === OVERVIEW_FILENAME) continue  // don't feed our own output back
      try { out.memoryNotes.push({ name: rel, content: readFileSync(join(dir, rel), 'utf8') }) } catch { /* skip */ }
    }
  } catch { /* best-effort */ }
  return out
}

export interface SynthesizeDeps {
  stateDir: string
  /** Admin's chat_id (== userId); the overview is written under its memory dir. */
  adminChatId: string
  /** LLM call (injected; CLI wires admin's provider, tests pass a mock). */
  sdkEval: (prompt: string) => Promise<string>
  /** Defaults to ~/.claude/projects. */
  projectsRoot?: string
  /** When true, discover + build prompt but make no LLM call and no write. */
  dryRun?: boolean
  /**
   * When provided, also fold in the "life" side (observations / milestones /
   * admin memory notes) so the overview spans work AND life. Callers with a db
   * (CLI synthesize, daemon pipeline) pass `makeLifeStoresReader(db, stateDir)`;
   * unit tests omit it.
   */
  lifeStores?: LifeStoresReader
  /** When true, gather + fold the file-side survey into the overview. */
  includeFileSurvey?: boolean
  /** Override survey roots (tests). Defaults to life dirs + locations.md dirs. */
  surveyRoots?: string[]
}

export interface SynthesizeResult {
  projectsFound: number
  projectNames: string[]
  filesScanned: number
  promptChars: number
  /** Life-side counts (0 when no lifeStores were passed). */
  observationsFound: number
  milestonesFound: number
  memoryNotesFound: number
  /** Synthesized overview text (omitted on dryRun or empty result). */
  overview?: string
  /** Write result (omitted on dryRun). */
  written?: { path: string; bytesWritten: number }
  /** Folders included in the file-side survey (0 when not surveyed). */
  foldersScanned: number
}

/**
 * Run the full synthesis: discover project memory (work) + gather life context
 * when a db is given → build prompt → (unless dryRun) eval → write
 * `_overview.md` under the admin's memory dir.
 */
export async function synthesizeOverview(deps: SynthesizeDeps): Promise<SynthesizeResult> {
  const projectsRoot = deps.projectsRoot ?? defaultClaudeProjectsRoot()
  const projects = discoverProjectMemory(projectsRoot)
  const filesScanned = projects.reduce((n, p) => n + (p.index ? 1 : 0) + p.files.length, 0)
  const life = deps.lifeStores ? await gatherLifeContext({ stores: deps.lifeStores, stateDir: deps.stateDir, adminChatId: deps.adminChatId }) : null
  const survey = deps.includeFileSurvey
    ? gatherFileSurvey({ stateDir: deps.stateDir, adminChatId: deps.adminChatId, roots: deps.surveyRoots })
    : null
  const prompt = formatSynthesisPrompt(projects, life, survey)
  const base: SynthesizeResult = {
    projectsFound: projects.length,
    projectNames: projects.map(p => p.displayName),
    filesScanned,
    promptChars: prompt.length,
    observationsFound: life?.observations.length ?? 0,
    milestonesFound: life?.milestones.length ?? 0,
    memoryNotesFound: life?.memoryNotes.length ?? 0,
    foldersScanned: survey?.folders.length ?? 0,
  }
  // Nothing to synthesize only when ALL three sides are empty.
  if (deps.dryRun || (projects.length === 0 && lifeIsEmpty(life) && (!survey || survey.folders.length === 0))) return base

  const raw = await deps.sdkEval(prompt)
  const overview = raw.trim()
  if (overview.length === 0) return base

  const stamped = `<!-- 由 wechat-cc 从本机 Claude 记忆整理生成 · ${new Date().toISOString()} -->\n\n${overview}\n`
  const written = writeMemoryFile(deps.stateDir, deps.adminChatId, OVERVIEW_FILENAME, stamped)
  return { ...base, overview, written: { path: OVERVIEW_FILENAME, bytesWritten: written.bytesWritten } }
}

export interface MemoryProfileCard {
  title: string
  body: string
  sources?: string[]
}

export interface MemoryProfileSourceStats {
  projectsFound: number
  filesScanned: number
  observationsFound: number
  milestonesFound: number
  memoryNotesFound: number
  foldersScanned: number
  promptChars: number
}

export interface MemoryProfileDoc {
  version: 1
  generatedAt: string
  chatId: string
  generatedBy?: 'auto' | 'manual'
  modelProvider?: string
  minRefreshAfter?: string
  sourceStats?: MemoryProfileSourceStats
  sourceFingerprint?: string
  insight: string
  summary: string
  tags: string[]
  traits: MemoryProfileCard[]
  preferences: MemoryProfileCard[]
  rememberedEvents: MemoryProfileCard[]
}

export interface SynthesizeProfileDeps extends SynthesizeDeps {
  generatedBy?: 'auto' | 'manual'
  modelProvider?: string
}

export interface SynthesizeProfileResult {
  projectsFound: number
  projectNames: string[]
  filesScanned: number
  promptChars: number
  observationsFound: number
  milestonesFound: number
  memoryNotesFound: number
  foldersScanned: number
  profile?: MemoryProfileDoc
  written?: { path: string; bytesWritten: number }
}

export type MemoryProfileStatusKind = 'empty' | 'ready' | 'fresh' | 'stale'

export interface MemoryProfileStatusResult {
  chatId: string
  status: MemoryProfileStatusKind
  exists: boolean
  canGenerate: boolean
  canAutoGenerate: boolean
  reason: string
  generatedAt: string | null
  minRefreshAfter: string | null
  sourceStats: MemoryProfileSourceStats
  sourceFingerprint: string
  previousSourceFingerprint: string | null
  changed: boolean
  daysSinceGenerated: number | null
}

const AUTO_REFRESH_DAYS = 7
const MIN_MEMORY_NOTES_FOR_PROFILE = 3
const MIN_LIFE_SIGNALS_FOR_PROFILE = 5
const MIN_PROMPT_CHARS_FOR_PROFILE = 3_000

function formatProfilePrompt(projects: ProjectMemory[], life: LifeContext | null, survey: SurveyResult | null): string {
  const source = formatSynthesisPrompt(projects, life, survey)
  return `${source}

你现在要把上面的长期记忆整理成“数字人格画像”的结构化 JSON。

只输出 JSON,不要 Markdown,不要代码块。字段必须完全符合:
{
  "insight": "一句话人格洞察，60-120字",
  "summary": "给用户看的总体描述，80-160字",
  "tags": ["2-8个短标签"],
  "traits": [{"title":"情绪表达|社交模式|关系模式|压力状态或更贴切标题","body":"基于真实记忆的描述，35-90字","sources":["来源名"]}],
  "preferences": [{"title":"喜欢|不喜欢|需要|风险或更贴切标题","body":"基于真实记忆的描述，35-90字","sources":["来源名"]}],
  "rememberedEvents": [{"title":"用户能感到被记住的小标题","body":"具体事件/长期线索的抽象表达，35-90字","sources":["来源名"]}]
}

要求:
- 只能根据来源里确实出现的长期记忆、观察、里程碑、项目记忆来写。
- 所有给用户看的文字都必须使用第二人称“你”，不要用“他/她/用户/这个人”等第三人称称呼。
- 不要写文件名本身，不要暴露系统实现。
- rememberedEvents 要像“CC把你的事情放在心上”，不是列记忆文件。
- 如果证据不足，少写，不要编造。
- traits 最多 4 条，preferences 最多 4 条，rememberedEvents 最多 4 条。
`
}

function parseProfileJson(raw: string, chatId: string): MemoryProfileDoc | null {
  const trimmed = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data: unknown
  try {
    data = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
  const obj = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const secondPerson = (value: unknown): string => String(value || '')
    .trim()
    .replace(/^他(?=是|在|会|希望|更|长期|曾|明确|近期|已经|对|把|也)/, '你')
    .replace(/^她(?=是|在|会|希望|更|长期|曾|明确|近期|已经|对|把|也)/, '你')
    .replace(/这个用户/g, '你')
  const cards = (value: unknown): MemoryProfileCard[] => Array.isArray(value)
    ? value.map(item => {
        const card = item && typeof item === 'object' ? item as Record<string, unknown> : {}
        return {
          title: secondPerson(card.title),
          body: secondPerson(card.body),
          sources: Array.isArray(card.sources) ? card.sources.map(s => String(s)).filter(Boolean).slice(0, 4) : [],
        }
      }).filter(item => item.title && item.body).slice(0, 4)
    : []
  const tags = Array.isArray(obj.tags) ? obj.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 8) : []
  const profile: MemoryProfileDoc = {
    version: 1,
    generatedAt: new Date().toISOString(),
    chatId,
    generatedBy: 'manual',
    insight: secondPerson(obj.insight),
    summary: secondPerson(obj.summary),
    tags,
    traits: cards(obj.traits),
    preferences: cards(obj.preferences),
    rememberedEvents: cards(obj.rememberedEvents),
  }
  if (!profile.insight && !profile.summary && profile.traits.length === 0 && profile.preferences.length === 0 && profile.rememberedEvents.length === 0) return null
  return profile
}

function sourceFingerprint(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex')
}

function profileSourceStats(opts: {
  projects: ProjectMemory[]
  filesScanned: number
  life: LifeContext | null
  survey: SurveyResult | null
  promptChars: number
}): MemoryProfileSourceStats {
  return {
    projectsFound: opts.projects.length,
    filesScanned: opts.filesScanned,
    observationsFound: opts.life?.observations.length ?? 0,
    milestonesFound: opts.life?.milestones.length ?? 0,
    memoryNotesFound: opts.life?.memoryNotes.length ?? 0,
    foldersScanned: opts.survey?.folders.length ?? 0,
    promptChars: opts.promptChars,
  }
}

function hasEnoughProfileSource(stats: MemoryProfileSourceStats): boolean {
  return stats.memoryNotesFound >= MIN_MEMORY_NOTES_FOR_PROFILE
    || stats.observationsFound + stats.milestonesFound >= MIN_LIFE_SIGNALS_FOR_PROFILE
    || stats.promptChars >= MIN_PROMPT_CHARS_FOR_PROFILE
}

function addDays(iso: string, days: number): string | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return new Date(t + days * 86_400_000).toISOString()
}

function daysSince(iso: string): number | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.floor((Date.now() - t) / 86_400_000)
}

function readExistingProfile(stateDir: string, chatId: string): MemoryProfileDoc | null {
  try {
    const raw = readMemoryProfileFile(stateDir, chatId)
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as MemoryProfileDoc : null
  } catch {
    return null
  }
}

async function buildProfileSource(opts: {
  stateDir: string
  adminChatId: string
  projectsRoot?: string
  lifeStores?: LifeStoresReader
  includeFileSurvey?: boolean
  surveyRoots?: string[]
}): Promise<{
  projects: ProjectMemory[]
  projectNames: string[]
  filesScanned: number
  life: LifeContext | null
  survey: SurveyResult | null
  prompt: string
  stats: MemoryProfileSourceStats
  fingerprint: string
}> {
  const projectsRoot = opts.projectsRoot ?? defaultClaudeProjectsRoot()
  const projects = discoverProjectMemory(projectsRoot)
  const filesScanned = projects.reduce((n, p) => n + (p.index ? 1 : 0) + p.files.length, 0)
  const life = opts.lifeStores ? await gatherLifeContext({ stores: opts.lifeStores, stateDir: opts.stateDir, adminChatId: opts.adminChatId }) : null
  const survey = opts.includeFileSurvey
    ? gatherFileSurvey({ stateDir: opts.stateDir, adminChatId: opts.adminChatId, roots: opts.surveyRoots })
    : null
  const prompt = formatProfilePrompt(projects, life, survey)
  const stats = profileSourceStats({ projects, filesScanned, life, survey, promptChars: prompt.length })
  return {
    projects,
    projectNames: projects.map(p => p.displayName),
    filesScanned,
    life,
    survey,
    prompt,
    stats,
    fingerprint: sourceFingerprint(prompt),
  }
}

export async function synthesizeProfile(deps: SynthesizeProfileDeps): Promise<SynthesizeProfileResult> {
  const source = await buildProfileSource(deps)
  const base: SynthesizeProfileResult = {
    projectsFound: source.stats.projectsFound,
    projectNames: source.projectNames,
    filesScanned: source.filesScanned,
    promptChars: source.stats.promptChars,
    observationsFound: source.stats.observationsFound,
    milestonesFound: source.stats.milestonesFound,
    memoryNotesFound: source.stats.memoryNotesFound,
    foldersScanned: source.stats.foldersScanned,
  }
  if (deps.dryRun || !hasEnoughProfileSource(source.stats) || (source.projects.length === 0 && lifeIsEmpty(source.life) && (!source.survey || source.survey.folders.length === 0))) return base

  const raw = await deps.sdkEval(source.prompt)
  const profile = parseProfileJson(raw, deps.adminChatId)
  if (!profile) return base
  profile.generatedBy = deps.generatedBy ?? 'manual'
  profile.modelProvider = deps.modelProvider
  profile.sourceStats = source.stats
  profile.sourceFingerprint = source.fingerprint
  profile.minRefreshAfter = addDays(profile.generatedAt, AUTO_REFRESH_DAYS) ?? undefined
  const body = `${JSON.stringify(profile, null, 2)}\n`
  const written = writeMemoryProfileFile(deps.stateDir, deps.adminChatId, body)
  return { ...base, profile, written: { path: PROFILE_FILENAME, bytesWritten: written.bytesWritten } }
}

export async function getMemoryProfileStatus(opts: {
  stateDir: string
  adminChatId: string
  projectsRoot?: string
  lifeStores?: LifeStoresReader
  includeFileSurvey?: boolean
  surveyRoots?: string[]
}): Promise<MemoryProfileStatusResult> {
  const source = await buildProfileSource(opts)
  const existing = readExistingProfile(opts.stateDir, opts.adminChatId)
  const enough = hasEnoughProfileSource(source.stats)
  const generatedAt = existing?.generatedAt ?? null
  const minRefreshAfter = existing?.minRefreshAfter ?? (generatedAt ? addDays(generatedAt, AUTO_REFRESH_DAYS) : null)
  const previousSourceFingerprint = existing?.sourceFingerprint ?? null
  const changed = previousSourceFingerprint ? previousSourceFingerprint !== source.fingerprint : false
  const days = generatedAt ? daysSince(generatedAt) : null
  const oldEnough = days === null ? false : days >= AUTO_REFRESH_DAYS
  let status: MemoryProfileStatusKind = 'empty'
  let reason = '还没有足够的长期记忆'
  if (!existing && enough) {
    status = 'ready'
    reason = '已有足够记忆，可以生成画像'
  } else if (existing && (!changed || !oldEnough)) {
    status = 'fresh'
    reason = changed && !oldEnough ? '记忆有变化，但自动刷新间隔还没到' : '画像仍然新鲜'
  } else if (existing && changed && oldEnough) {
    status = 'stale'
    reason = '画像已超过刷新周期，且来源记忆有变化'
  }
  return {
    chatId: opts.adminChatId,
    status,
    exists: !!existing,
    canGenerate: enough,
    canAutoGenerate: enough && (status === 'ready' || status === 'stale'),
    reason,
    generatedAt,
    minRefreshAfter,
    sourceStats: source.stats,
    sourceFingerprint: source.fingerprint,
    previousSourceFingerprint,
    changed,
    daysSinceGenerated: days,
  }
}
