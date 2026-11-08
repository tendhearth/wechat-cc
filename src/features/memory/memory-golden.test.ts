/**
 * 记忆金样(架构终态 G0,设计稿 docs/superpowers/specs/2026-10-25-memory-single-source-design.md §3)。
 *
 * 夹具 `src/test-support/fixtures/memory/` 是合成的(三个对话:主人、访客、空;含 BOM、CRLF、`extra`、没编号的条目、
 * 已更正又被写回的行、`替换:` 链、facts.db 各状态)。这条测试用**今天的代码**把它们走一遍,产出逐字节钉在
 * `fixtures/memory/golden/` 里:`memory.md` / `owner.md` 的序列化、注入提示词的那几段、整理提示词的纠正段、
 * `overviewForOthers`、`knowledge.md`。G2 起「表 → 渲染」必须和这里逐字节相等;之后每一步都跑它。
 *
 * 金样是**故意**钉死的:红了先想是不是改到了主人看得见的提示词 / 记忆页。确实要变(G 之外的格式改动),
 * 重新生成并在 PR 里说明:`UPDATE_MEMORY_GOLDEN=1 bun --bun vitest run src/features/memory/memory-golden.test.ts`。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTempDir } from '../../lib/test-temp'
import { openSqlite } from '../../lib/runtime/sqlite'
import { emptyDoc, parseMemoryDoc, serializeMemoryDoc } from './curated-doc'
import { CORRECTIONS_BLOCK, OWNER_BLOCK, readCorrections } from './nightly'
import { makeMemoryWriter } from './memory-export'
import { makeMemoryFactsStore } from '../../adapters/store/memory-facts'
import { openTestDb } from '../../lib/db'
import { overviewForOthers, parseOwnerDoc, readOwnerDoc, renderOwnerForPrompt, serializeOwnerDoc } from '../../lib/memory-owner'
import { makeMemoryPromptReads } from './prompt-reads'
import { makeMemoryFS } from '../../adapters/store/memory-fs'
import { openKnowledge } from '../../adapters/knowledge/store'
import { migrations as factsMigrations } from '../../adapters/knowledge/migrations/facts'
import { importFactsDb } from '../../adapters/knowledge/facts-import'
import { makeFactsApi } from '../../domain/knowledge/facts'
import { makeGraphQueryApi } from '../../domain/knowledge/graph-query'
import { distillOwnerKnowledge } from '../companion/knowledge-distill'
import { testFences } from '../../test-support/memory-fences'
// G8:生成物围栏在主库;这个文件一份内存主库
const TEST_FENCES = testFences()

const HERE = dirname(fileURLToPath(import.meta.url))
const MEMORY_FIXTURES = join(HERE, '..', '..', 'test-support', 'fixtures', 'memory')
const GOLDEN = join(MEMORY_FIXTURES, 'golden')
const UPDATE = process.env.UPDATE_MEMORY_GOLDEN === '1'

/** 夹具目录名 → 对话 id。`empty` 没有任何文件(目录也不存在)。 */
const CHATS = { owner: 'o9fixture-owner@im.wechat', guest: 'o9fixture-guest@im.wechat', empty: 'o9fixture-empty@im.wechat' } as const
type ChatName = keyof typeof CHATS
/** 序列化 memory.md 时头部的生成戳(G2 的渲染拿同一个戳比)。 */
const GOLDEN_STAMP = '2026-10-25T03:00:00.000Z'

let stateDir = ''
let knowledgeRoot = ''

function seedKnowledge(root: string): void {
  openKnowledge(root).close()   // 建 source / semantic / graph 三个库
  // facts.db:G7 起知识库不再建它;夹具照 G1 之前的样子(facts 迁移的 v001)造一份,由开机导入搬进主库
  const fdb = openSqlite(join(root, 'facts.db'))
  factsMigrations[0]!(fdb)
  fdb.close()
  const fixture = JSON.parse(readFileSync(join(MEMORY_FIXTURES, 'facts.json'), 'utf8')) as {
    facts: Array<Record<string, unknown>>
    contacts: Array<Record<string, unknown>>
  }
  const facts = openSqlite(join(root, 'facts.db'))
  for (const f of fixture.facts) {
    facts.query(`INSERT INTO facts(id, contact, kind, predicate, value, related_contact, time_ref, confidence, source_msg_keys,
      status, created_at, updated_at, valid_from, invalidated_at, superseded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      f.id as number, f.contact as string, f.kind as string, f.predicate as string, f.value as string, (f.related_contact ?? null) as string | null,
      (f.time_ref ?? null) as string | null, f.confidence as string, JSON.stringify(f.source_msg_keys ?? []), f.status as string,
      f.created_at as number, f.updated_at as number, (f.valid_from ?? null) as number | null, (f.invalidated_at ?? null) as number | null,
      (f.superseded_by ?? null) as number | null,
    )
  }
  facts.close()
  const graph = openSqlite(join(root, 'graph.db'))
  for (const c of fixture.contacts) {
    graph.query(`INSERT INTO contacts(username, display, is_group, closeness, last_ts, total, s_volume, s_intimacy, s_recency)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      c.username as string, c.display as string, c.is_group as number, c.closeness as number, c.last_ts as number, c.total as number,
      c.s_volume as number, c.s_intimacy as number, c.s_recency as number,
    )
  }
  graph.close()
}

/** 今天的代码对夹具的全部产出:文件名 → 内容。 */
async function produce(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const memoryDir = (c: ChatName) => join(stateDir, 'memory', CHATS[c])
  const read = (c: ChatName, f: string) => { const p = join(memoryDir(c), f); return existsSync(p) ? readFileSync(p, 'utf8') : null }

  // knowledge.md:从 facts + graph 蒸馏(tick-ingest 写进主人对话的 memory 目录,注入时再读回来)
  // G7:联系人事实经开机导入进主库,知识库从主库读 —— knowledge.md 必须和 G0 一字不差
  const mainStore = makeMemoryFactsStore(openTestDb())
  importFactsDb({ store: mainStore, knowledgeRoot, archiveDir: join(stateDir, 'memory-archive', 'knowledge'), now: () => 1_761_400_000_000, log: () => {} })
  const store = openKnowledge(knowledgeRoot, { facts: mainStore.contactFacts })
  const knowledge = await distillOwnerKnowledge({ facts: makeFactsApi(store), graph: makeGraphQueryApi(store) })
  out['knowledge.md'] = knowledge
  if (knowledge) writeFileSync(join(memoryDir('owner'), 'knowledge.md'), knowledge)

  // G6 起 memory.md / owner.md 经导出器读;这里的表是空的(没导入)⇒ 走「没搬进表」那条路读夹具文件,产出必须和 G0 一样
  const reads = makeMemoryPromptReads({ stateDir, memory: makeMemoryFS({ rootDir: join(stateDir, 'memory'), fences: TEST_FENCES }), facts: makeMemoryWriter({ store: makeMemoryFactsStore(openTestDb()), stateDir }) })
  for (const name of Object.keys(CHATS) as ChatName[]) {
    const chat = CHATS[name]
    const mem = read(name, 'memory.md')
    out[`${name}/memory.md`] = serializeMemoryDoc(mem === null ? emptyDoc() : parseMemoryDoc(mem), GOLDEN_STAMP)
    const own = read(name, 'owner.md')
    out[`${name}/owner.md`] = serializeOwnerDoc(own === null ? { assertions: [], extra: [] } : parseOwnerDoc(own))
    out[`${name}/prompt-curated.txt`] = reads.curatedMemoryFor(chat)
    out[`${name}/prompt-owner.txt`] = reads.ownerMemoryFor(chat)
    out[`${name}/prompt-core.txt`] = reads.coreMemoryFor(chat)
    out[`${name}/prompt-draft.txt`] = reads.todayDraftFor(chat)
    out[`${name}/prompt-knowledge.txt`] = reads.knowledgeMemoryFor(chat)
    // 每晚整理素材最前面的两块(runMemoryNightly 里拼的那样)+ 代码里逐字拦写回的那张名单
    const root = memoryDir(name)
    // G5 起名单在表里;这里的表是空的(没导入)⇒ 导出器走「没搬进表的对话」那条路,直接读磁盘上的 corrections.md —— 产出必须和 G0 一样
    const writer = makeMemoryWriter({ store: makeMemoryFactsStore(openTestDb()), stateDir })
    const corrections = readCorrections(writer, chat)
    const ownerWords = renderOwnerForPrompt(readOwnerDoc(root))
    out[`${name}/nightly-head.txt`] = [
      corrections.block ? `### ${CORRECTIONS_BLOCK}\n${corrections.block}` : '',
      ownerWords ? `### ${OWNER_BLOCK}\n${ownerWords}` : '',
    ].filter(Boolean).join('\n\n')
    out[`${name}/corrected-texts.json`] = JSON.stringify([...writer.retractedTexts(chat)].sort(), null, 2) + '\n'
    const overview = read(name, '_overview.md')
    out[`${name}/overview-for-others.md`] = overview === null ? '' : overviewForOthers(overview)
  }
  return out
}

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'memory-golden-'))
  knowledgeRoot = join(stateDir, 'knowledge')
  for (const name of ['owner', 'guest'] as const) cpSync(join(MEMORY_FIXTURES, 'chats', name), join(stateDir, 'memory', CHATS[name]), { recursive: true })
  mkdirSync(join(stateDir, 'companion'), { recursive: true })
  writeFileSync(join(stateDir, 'companion', 'config.json'), JSON.stringify({ default_chat_id: CHATS.owner }))
  seedKnowledge(knowledgeRoot)
})
afterAll(() => { if (stateDir) removeTempDir(stateDir) })

describe('记忆金样(G0):今天的代码对合成夹具的产出逐字节不变', () => {
  it('matches every golden file, and the golden dir has nothing extra', async () => {
    const out = await produce()
    if (UPDATE) {
      for (const [rel, body] of Object.entries(out)) {
        mkdirSync(dirname(join(GOLDEN, rel)), { recursive: true })
        writeFileSync(join(GOLDEN, rel), body)
      }
    }
    const onDisk = (readdirSync(GOLDEN, { recursive: true, withFileTypes: true }) as Array<{ isFile(): boolean; name: string; parentPath?: string; path?: string }>)
      .filter(e => e.isFile())
      .map(e => join(e.parentPath ?? e.path ?? GOLDEN, e.name).slice(GOLDEN.length + 1).split('\\').join('/'))
      .sort()
    expect(onDisk).toEqual(Object.keys(out).sort())
    for (const [rel, body] of Object.entries(out)) expect(body, rel).toBe(readFileSync(join(GOLDEN, rel), 'utf8'))
  })

  it('the fixture really has the edge cases it claims (BOM, CRLF, unnumbered entries, 替换 chain)', () => {
    const ownerMem = readFileSync(join(MEMORY_FIXTURES, 'chats', 'owner', 'memory.md'), 'utf8')
    expect(ownerMem.charCodeAt(0)).toBe(0xfeff)
    expect(readFileSync(join(MEMORY_FIXTURES, 'chats', 'guest', 'memory.md'), 'utf8')).toContain('\r\n')
    const doc = parseMemoryDoc(ownerMem)
    expect(Object.values(doc.sections).flat().some(e => e.id === null)).toBe(true)
    expect(doc.extra.length).toBeGreaterThan(0)
    expect(parseOwnerDoc(readFileSync(join(MEMORY_FIXTURES, 'chats', 'owner', 'owner.md'), 'utf8')).assertions.filter(a => a.replaces).length).toBe(2)
  })
})
