import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAX_GARDEN_FILES_PER_TICK, MIN_GARDEN_BYTES, runGarden, type GardenerDeps } from './gardener'

const TODAY = '2026-07-10'

function bigContent(seed: string, extraBytes = 500): string {
  // Comfortably over MIN_GARDEN_BYTES (2048).
  return `${seed}\n` + 'x'.repeat(MIN_GARDEN_BYTES + extraBytes)
}

describe('runGarden', () => {
  let root: string
  let memoryRoot: string
  let archiveRoot: string
  let stateFile: string
  let logs: string[]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gardener-test-'))
    memoryRoot = join(root, 'memory')
    archiveRoot = join(root, 'memory-archive')
    stateFile = join(root, 'garden_state.json')
    logs = []
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function makeDeps(overrides: Partial<GardenerDeps> = {}): GardenerDeps {
    return {
      memoryRoot,
      archiveRoot,
      stateFile,
      cheapEval: async () => 'curated content',
      log: (tag, line) => { logs.push(`${tag}|${line}`) },
      today: TODAY,
      ...overrides,
    }
  }

  function writeMemoryFile(chatId: string, relPath: string, content: string): string {
    const full = join(memoryRoot, chatId, relPath)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
    return full
  }

  it('no memoryRoot ⇒ 0/0, no throw', async () => {
    const result = await runGarden(makeDeps())
    expect(result).toEqual({ gardened: 0, skipped: 0 })
  })

  it('gate: file under MIN_GARDEN_BYTES is never gardened', async () => {
    writeMemoryFile('chat-1', 'profile.md', 'too small')
    const cheapEval = vi.fn(async () => 'curated')
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 0 })
    expect(cheapEval).not.toHaveBeenCalled()
  })

  it('gate: unchanged content (hash matches watermark) is skipped, zero LLM cost', async () => {
    // Pre-populate the watermark with the hash of the CURRENT (still large)
    // content, isolating this from the size gate — proves the hash check,
    // not "curated output happens to be short", is what causes the skip.
    const content = bigContent('v1')
    writeMemoryFile('chat-1', 'profile.md', content)
    const hash = createHash('sha256').update(content, 'utf8').digest('hex')
    mkdirSync(root, { recursive: true })
    writeFileSync(stateFile, JSON.stringify({ 'chat-1/profile.md': { hash, at: '2026-07-01' } }), 'utf8')

    const cheapEval = vi.fn(async () => 'curated')
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 0 })
    expect(cheapEval).not.toHaveBeenCalled()
  })

  it('changed + big ⇒ gardened', async () => {
    writeMemoryFile('chat-1', 'profile.md', bigContent('v1'))
    const cheapEval = vi.fn(async () => 'curated, much shorter')
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 1, skipped: 0 })
    expect(cheapEval).toHaveBeenCalledTimes(1)
  })

  it('cap: 7 eligible ⇒ 5 gardened, oldest-watermark-first', async () => {
    // Seed 7 candidate files, all already changed relative to a pre-existing
    // watermark (distinct `at` dates), so ordering is deterministic.
    const state: Record<string, { hash: string; at: string }> = {}
    const chats = ['chat-a', 'chat-b']
    const files: { chatId: string; relPath: string; at: string }[] = [
      { chatId: 'chat-a', relPath: 'profile.md', at: '2026-07-01' },
      { chatId: 'chat-a', relPath: 'preferences.md', at: '2026-07-02' },
      { chatId: 'chat-a', relPath: 'notes/n1.md', at: '2026-07-03' },
      { chatId: 'chat-b', relPath: 'profile.md', at: '2026-07-04' },
      { chatId: 'chat-b', relPath: 'preferences.md', at: '2026-07-05' },
      { chatId: 'chat-b', relPath: 'notes/n1.md', at: '2026-07-06' },
      { chatId: 'chat-b', relPath: 'notes/n2.md', at: '2026-07-07' },
    ]
    for (const f of files) {
      writeMemoryFile(f.chatId, f.relPath, bigContent(f.relPath))
      state[`${f.chatId}/${f.relPath}`] = { hash: 'stale-hash-does-not-match', at: f.at }
    }
    void chats
    mkdirSync(root, { recursive: true })
    writeFileSync(stateFile, JSON.stringify(state), 'utf8')

    const cheapEval = vi.fn(async () => 'curated')
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result.gardened).toBe(MAX_GARDEN_FILES_PER_TICK)
    expect(cheapEval).toHaveBeenCalledTimes(5)

    // The 5 oldest (2026-07-01 .. 2026-07-05) should have been gardened;
    // the 2 newest (07-06, 07-07) must remain untouched (still original content).
    const untouched1 = readFileSync(join(memoryRoot, 'chat-b', 'notes', 'n1.md'), 'utf8')
    const untouched2 = readFileSync(join(memoryRoot, 'chat-b', 'notes', 'n2.md'), 'utf8')
    expect(untouched1).toBe(bigContent('notes/n1.md'))
    expect(untouched2).toBe(bigContent('notes/n2.md'))

    const touched = readFileSync(join(memoryRoot, 'chat-a', 'profile.md'), 'utf8')
    expect(touched).toBe('curated')
  })

  it('exclusions: agenda.md, persona.md, _overview.md, archive/** are never touched', async () => {
    writeMemoryFile('chat-1', 'agenda.md', bigContent('agenda'))
    writeMemoryFile('chat-1', 'persona.md', bigContent('persona'))
    writeMemoryFile('chat-1', '_overview.md', bigContent('overview'))
    writeMemoryFile('chat-1', 'archive/old.md', bigContent('archived'))
    const cheapEval = vi.fn(async () => { throw new Error('cheapEval must not be called for excluded files') })
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 0 })
    expect(cheapEval).not.toHaveBeenCalled()
    expect(readFileSync(join(memoryRoot, 'chat-1', 'agenda.md'), 'utf8')).toBe(bigContent('agenda'))
    expect(readFileSync(join(memoryRoot, 'chat-1', 'persona.md'), 'utf8')).toBe(bigContent('persona'))
    expect(readFileSync(join(memoryRoot, 'chat-1', '_overview.md'), 'utf8')).toBe(bigContent('overview'))
    expect(readFileSync(join(memoryRoot, 'chat-1', 'archive', 'old.md'), 'utf8')).toBe(bigContent('archived'))
  })

  it('validation skip: longer output ⇒ skip, original intact, watermark NOT updated', async () => {
    const original = bigContent('v1')
    writeMemoryFile('chat-1', 'profile.md', original)
    const longer = original + original // definitely longer
    const cheapEval = vi.fn(async () => longer)
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 1 })
    expect(readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')).toBe(original)
    expect(existsSync(stateFile)).toBe(false)
    expect(logs.some(l => l.includes('GARDEN') && l.includes('longer than original'))).toBe(true)
  })

  it('validation skip: empty output ⇒ skip, original intact, watermark NOT updated', async () => {
    const original = bigContent('v1')
    writeMemoryFile('chat-1', 'profile.md', original)
    const cheapEval = vi.fn(async () => '   \n  ')
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 1 })
    expect(readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')).toBe(original)
    expect(existsSync(stateFile)).toBe(false)
    expect(logs.some(l => l.includes('GARDEN') && l.includes('empty output'))).toBe(true)
  })

  it('validation skip: auth-fail phrase ⇒ throws internally, handled as skip', async () => {
    const original = bigContent('v1')
    writeMemoryFile('chat-1', 'profile.md', original)
    const cheapEval = vi.fn(async () => 'Please run /login to continue')
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 1 })
    expect(readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')).toBe(original)
    expect(existsSync(stateFile)).toBe(false)
    expect(logs.some(l => l.includes('AUTH_FAILED'))).toBe(true)
  })

  it('archive written before overwrite; archive content equals original', async () => {
    const original = bigContent('v1')
    writeMemoryFile('chat-1', 'profile.md', original)
    const cheapEval = vi.fn(async () => 'curated shorter content')
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result.gardened).toBe(1)
    const archived = readFileSync(join(archiveRoot, 'chat-1', `profile.md.${TODAY}.md`), 'utf8')
    expect(archived).toBe(original)
    const curated = readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')
    expect(curated).toBe('curated shorter content')
  })

  it('watermark round-trip: second run with same (curated) content ⇒ 0 gardened', async () => {
    // Curated output stays >= MIN_GARDEN_BYTES (but < original) so the
    // second run's skip is genuinely the hash-watermark gate, not the
    // separate too-small gate.
    const original = bigContent('v1', 6000)
    writeMemoryFile('chat-1', 'profile.md', original)
    const curated = bigContent('curated-stable', 3000)
    expect(Buffer.byteLength(curated, 'utf8')).toBeGreaterThanOrEqual(MIN_GARDEN_BYTES)
    expect(curated.length).toBeLessThan(original.length)
    const cheapEval = vi.fn(async () => curated)

    const first = await runGarden(makeDeps({ cheapEval }))
    expect(first.gardened).toBe(1)

    const second = await runGarden(makeDeps({ cheapEval }))
    expect(second).toEqual({ gardened: 0, skipped: 0 })
    expect(cheapEval).toHaveBeenCalledTimes(1)
  })

  it('per-file error (e.g. cheapEval throws a non-auth error) ⇒ skip that file, continue with others', async () => {
    writeMemoryFile('chat-1', 'profile.md', bigContent('v1'))
    writeMemoryFile('chat-2', 'profile.md', bigContent('v2'))
    let calls = 0
    const cheapEval = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('transient network error')
      return 'curated'
    })
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 1, skipped: 1 })
    expect(cheapEval).toHaveBeenCalledTimes(2)
  })
})
