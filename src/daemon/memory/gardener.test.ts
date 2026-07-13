import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  contentOverlap,
  MAX_GARDEN_CURATED_BYTES,
  MAX_GARDEN_FILES_PER_TICK,
  MIN_GARDEN_BYTES,
  runGarden,
  type GardenerDeps,
} from './gardener'

const TODAY = '2026-07-10'

function bigContent(seed: string, extraBytes = 500): string {
  // Comfortably over MIN_GARDEN_BYTES (2048). Padded with repeated "filler "
  // WORDS rather than one giant character run so a curation that genuinely
  // reuses the original's vocabulary (see `curatedFromPrompt` below) can
  // satisfy the contentOverlap heuristic — one long run of the same char is
  // a single token, and two runs of different lengths never string-match.
  const padLen = MIN_GARDEN_BYTES + extraBytes
  const filler = 'filler '.repeat(Math.ceil(padLen / 'filler '.length)).slice(0, padLen)
  return `${seed}\n${filler}`
}

/**
 * Derives a valid "curated" fixture straight from the prompt the gardener
 * actually sent — shorter than the original, and built only from words the
 * original contains (its first line + a prefix of the shared "filler" pad),
 * so it satisfies the byte-shrink, shrink-floor, and vocabulary-overlap
 * validation gates the way a real curation would. Used by tests where the
 * point is "gardening succeeds", not "here's what the curated text says".
 *
 * Keeps 60% of the post-first-line content (not just a token or two) —
 * validateCuration's shrink floor rejects anything under
 * `min(512, 0.2 * originalBytes)`, so a curated fixture that's nearly empty
 * (as a bare "<firstLine> filler" used to be) would now be REJECTED as
 * over_shrunk before ever reaching the overlap check.
 */
function curatedFromPrompt(prompt: string): string {
  const marker = '--- 原文件内容 ---\n'
  const idx = prompt.indexOf(marker)
  const original = idx >= 0 ? prompt.slice(idx + marker.length) : prompt
  const firstLine = original.split('\n')[0] ?? ''
  const rest = original.slice(firstLine.length + 1)
  const kept = rest.slice(0, Math.ceil(rest.length * 0.6))
  return `${firstLine}\n${kept}`.trim()
}

/**
 * Like `curatedFromPrompt`, but keeps an arbitrary fraction of the
 * post-first-line content instead of a fixed 60% — used to build a
 * "legitimate aggressive curation" fixture (e.g. ~30% of original bytes)
 * that's still built entirely from the original's own vocabulary.
 */
function curatedFromPromptRatio(original: string, ratio: number): string {
  const firstLine = original.split('\n')[0] ?? ''
  const rest = original.slice(firstLine.length + 1)
  const kept = rest.slice(0, Math.ceil(rest.length * ratio))
  return `${firstLine}\n${kept}`.trim()
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
    const cheapEval = vi.fn(async (prompt: string) => curatedFromPrompt(prompt))
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

    const cheapEval = vi.fn(async (prompt: string) => curatedFromPrompt(prompt))
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
    expect(touched).toBe(curatedFromPrompt(bigContent('profile.md')))
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

  it('validation skip: longer output ⇒ skip, original intact, watermark hash NOT advanced (fail count recorded)', async () => {
    const original = bigContent('v1')
    writeMemoryFile('chat-1', 'profile.md', original)
    const longer = original + original // definitely longer
    const cheapEval = vi.fn(async () => longer)
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 1 })
    expect(readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')).toBe(original)
    // Fail-tracking (fix #4) now persists a counter, but the hash sentinel
    // ('') never matches real content, so the file stays eligible on retry —
    // this is NOT the same as a successful watermark advance.
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    expect(state['chat-1/profile.md']).toEqual({ hash: '', at: TODAY, fails: 1 })
    expect(logs.some(l => l.includes('GARDEN') && l.includes('longer than original'))).toBe(true)
  })

  it('validation skip: empty output ⇒ skip, original intact, watermark hash NOT advanced (fail count recorded)', async () => {
    const original = bigContent('v1')
    writeMemoryFile('chat-1', 'profile.md', original)
    const cheapEval = vi.fn(async () => '   \n  ')
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 1 })
    expect(readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')).toBe(original)
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    expect(state['chat-1/profile.md']).toEqual({ hash: '', at: TODAY, fails: 1 })
    expect(logs.some(l => l.includes('GARDEN') && l.includes('empty output'))).toBe(true)
  })

  it('validation skip: LLM refusal text ⇒ skip (reason=refusal_shape), original intact', async () => {
    const original = bigContent('v1')
    writeMemoryFile('chat-1', 'profile.md', original)
    // Repeated (not single-sentence) so it clears the new shrink floor
    // (min(512, 0.2 * originalBytes)) and the refusal check is reached at
    // all, rather than being pre-empted by over_shrunk.
    const refusal = '我不能帮助整理这份记忆文件，因为这可能涉及隐私信息。'.repeat(8)
    expect(Buffer.byteLength(refusal, 'utf8')).toBeGreaterThan(0.2 * Buffer.byteLength(original, 'utf8'))
    expect(Buffer.byteLength(refusal, 'utf8')).toBeLessThan(Buffer.byteLength(original, 'utf8'))
    const cheapEval = vi.fn(async () => refusal)
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 1 })
    expect(readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')).toBe(original)
    expect(logs.some(l => l.includes('reason=refusal_shape'))).toBe(true)
  })

  it('validation skip: invented content with low vocabulary overlap ⇒ skip (reason=low_overlap)', async () => {
    const original = bigContent('用户喜欢喝咖啡，住在北京，是一名软件工程师')
    writeMemoryFile('chat-1', 'profile.md', original)
    // Repeated (not single-sentence) so it clears the new shrink floor and
    // the low_overlap check is actually the one that fires — but still
    // shares essentially no vocabulary with the CJK original, a hallmark of
    // invention rather than curation of the existing content.
    const invented = 'Completely unrelated fabricated text about spaceships and dinosaurs having a picnic on Mars while wearing tiny hats. '.repeat(6)
    expect(Buffer.byteLength(invented, 'utf8')).toBeGreaterThan(0.2 * Buffer.byteLength(original, 'utf8'))
    expect(Buffer.byteLength(invented, 'utf8')).toBeLessThan(Buffer.byteLength(original, 'utf8'))
    const cheapEval = vi.fn(async () => invented)
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 1 })
    expect(readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')).toBe(original)
    expect(logs.some(l => l.includes('reason=low_overlap'))).toBe(true)
  })

  it('validation skip: output far smaller than original ⇒ skip (reason=over_shrunk), original intact', async () => {
    const original = bigContent('用户喜欢喝咖啡，住在北京，是一名软件工程师')
    writeMemoryFile('chat-1', 'profile.md', original)
    // Tiny relative to the (large) original, so the shrink-floor guard fires
    // before overlap is even considered — this is the exploit fixed here:
    // a small output built ENTIRELY from the original's own vocabulary used
    // to score overlap ~1.0 under curated-only normalization.
    const curated = '我在北京。'
    const cheapEval = vi.fn(async () => curated)
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 1 })
    expect(readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')).toBe(original)
    expect(logs.some(l => l.includes('reason=over_shrunk') || l.includes('reason=low_overlap'))).toBe(true)
  })

  it('refusal appended after mostly-verbatim content ⇒ skip (reason=refusal_shape) — full-string scan catches it past char 80', async () => {
    // 10 sentences of varied prose (well past the old slice(0,80) cutoff),
    // reused nearly verbatim, with a refusal tacked on at the very end. The
    // old refusal check only scanned curated.slice(0, 80) — content this
    // long would have hidden the refusal past the scanned prefix and been
    // ACCEPTED. The full-string scan (fix #1) must catch it regardless of
    // position.
    const sentences = [
      'The user is a software engineer based in Seattle who enjoys hiking on weekends.',
      'They have two cats named Mochi and Biscuit and adopted both from a local shelter.',
      'Their favorite programming language is TypeScript, though they started with Python.',
      'They prefer tea over coffee in the morning and usually work from a standing desk.',
      'On weekends they like to visit the farmers market near Pike Place for fresh produce.',
      'They mentioned wanting to learn woodworking sometime next year as a new hobby.',
      'Their partner works in healthcare and they often cook dinner together on Fridays.',
      'They have a running goal of finishing a half marathon before the end of the year.',
      'They keep a small vegetable garden on their apartment balcony during the summer.',
      'They are currently reading a book about the history of the Pacific Northwest.',
    ]
    const original = bigContent(sentences.join(' '))
    writeMemoryFile('chat-1', 'profile.md', original)
    // Curated: keep the sentences nearly verbatim (real vocabulary reuse,
    // comfortably above the shrink floor) but append a refusal clause after
    // more than 80 characters of genuine content.
    const curated = `${sentences.join(' ')} I'm sorry, I can't include some of the sensitive details.`
    expect(curated.length).toBeGreaterThan(80)
    expect(Buffer.byteLength(curated, 'utf8')).toBeGreaterThan(0.2 * Buffer.byteLength(original, 'utf8'))
    expect(Buffer.byteLength(curated, 'utf8')).toBeLessThan(Buffer.byteLength(original, 'utf8'))
    const cheapEval = vi.fn(async () => curated)
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 1 })
    expect(readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')).toBe(original)
    expect(logs.some(l => l.includes('reason=refusal_shape'))).toBe(true)
  })

  it('legit aggressive curation (~30% of original bytes, vocabulary drawn from original) ⇒ ACCEPTED, not blocked by the new guards', async () => {
    // Guards must not block real tightening: a large profile genuinely
    // condensed down to ~30% of its original size, using only words that
    // appear in the original, should still be gardened successfully.
    const original = bigContent('用户喜欢喝咖啡，住在北京，是一名软件工程师，喜欢徒步和摄影')
    writeMemoryFile('chat-1', 'profile.md', original)
    const originalBytes = Buffer.byteLength(original, 'utf8')
    const curated = curatedFromPromptRatio(original, 0.3)
    const curatedBytes = Buffer.byteLength(curated, 'utf8')
    expect(curatedBytes).toBeLessThan(originalBytes)
    expect(curatedBytes).toBeGreaterThan(0.2 * originalBytes) // clears the shrink floor
    const cheapEval = vi.fn(async () => curated)
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 1, skipped: 0 })
    expect(readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')).toBe(curated)
  })

  it('validation skip: CJK output has fewer chars but MORE utf8 bytes than original ⇒ skip on byte length, not JS .length', async () => {
    // ASCII original: 1 byte/char. CJK curated: 3 bytes/char in utf8. Make
    // the curated string have fewer JS string units yet strictly more bytes.
    const original = 'x'.repeat(MIN_GARDEN_BYTES + 500) // ascii: chars === bytes
    writeMemoryFile('chat-1', 'profile.md', original)
    const curated = '记'.repeat(Math.floor((MIN_GARDEN_BYTES + 500) / 3) + 50) // fewer JS chars, more utf8 bytes
    expect(curated.length).toBeLessThan(original.length)
    expect(Buffer.byteLength(curated, 'utf8')).toBeGreaterThan(Buffer.byteLength(original, 'utf8'))
    const cheapEval = vi.fn(async () => curated)
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 1 })
    expect(readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')).toBe(original)
    expect(logs.some(l => l.includes('reason=longer'))).toBe(true)
  })

  it('validation skip: curated output over the absolute 100KB byte cap ⇒ skip regardless of original size', async () => {
    const original = bigContent('v1', 200_000) // huge original, so the "shorter than original" gate alone wouldn't catch this
    writeMemoryFile('chat-1', 'profile.md', original)
    const curated = 'y'.repeat(MAX_GARDEN_CURATED_BYTES + 1)
    expect(curated.length).toBeLessThan(original.length)
    const cheapEval = vi.fn(async () => curated)
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 1 })
    expect(readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')).toBe(original)
    expect(logs.some(l => l.includes('reason=too_large'))).toBe(true)
  })

  it('concurrency: a live write landing mid-cheapEval-call is detected and skipped, concurrent content preserved', async () => {
    const original = bigContent('v1')
    const fullPath = writeMemoryFile('chat-1', 'profile.md', original)
    const concurrentContent = bigContent('written-while-gardening')
    const cheapEval = vi.fn(async (prompt: string) => {
      // Simulate a live memory_write landing on this exact file while the
      // gardener is mid-LLM-call.
      writeFileSync(fullPath, concurrentContent, 'utf8')
      return curatedFromPrompt(prompt)
    })
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 0, skipped: 1 })
    expect(readFileSync(fullPath, 'utf8')).toBe(concurrentContent)
    expect(existsSync(stateFile)).toBe(false) // watermark left untouched
    expect(logs.some(l => l.includes('reason=concurrent_write'))).toBe(true)
  })

  it('livelock guard: 3 consecutive validation fails ⇒ 4th tick does not retry; a content change re-enables it', async () => {
    const original = bigContent('v1')
    writeMemoryFile('chat-1', 'profile.md', original)
    const cheapEval = vi.fn(async () => '   ') // always empty after trim — always fails validation

    const first = await runGarden(makeDeps({ cheapEval }))
    expect(first).toEqual({ gardened: 0, skipped: 1 })
    const second = await runGarden(makeDeps({ cheapEval }))
    expect(second).toEqual({ gardened: 0, skipped: 1 })
    const third = await runGarden(makeDeps({ cheapEval }))
    expect(third).toEqual({ gardened: 0, skipped: 1 })
    expect(cheapEval).toHaveBeenCalledTimes(3)
    expect(logs.some(l => l.includes('giving_up'))).toBe(true)

    // 4th tick: watermark hash was advanced to the (still-original) content
    // hash on give-up, so this file is no longer eligible — no LLM call.
    const fourth = await runGarden(makeDeps({ cheapEval }))
    expect(fourth).toEqual({ gardened: 0, skipped: 0 })
    expect(cheapEval).toHaveBeenCalledTimes(3)
    expect(readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')).toBe(original)

    // Changing the file content makes it eligible again.
    const changed = bigContent('v2-changed')
    writeMemoryFile('chat-1', 'profile.md', changed)
    const cheapEvalOk = vi.fn(async (prompt: string) => curatedFromPrompt(prompt))
    const fifth = await runGarden(makeDeps({ cheapEval: cheapEvalOk }))
    expect(fifth).toEqual({ gardened: 1, skipped: 0 })
    expect(cheapEvalOk).toHaveBeenCalledTimes(1)
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
    const cheapEval = vi.fn(async (prompt: string) => curatedFromPrompt(prompt))
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result.gardened).toBe(1)
    const archived = readFileSync(join(archiveRoot, 'chat-1', `profile.md.${TODAY}.md`), 'utf8')
    expect(archived).toBe(original)
    const curated = readFileSync(join(memoryRoot, 'chat-1', 'profile.md'), 'utf8')
    expect(curated).toBe(curatedFromPrompt(bigContent('v1')))
  })

  it('watermark round-trip: second run with same (curated) content ⇒ 0 gardened', async () => {
    // Curated output stays >= MIN_GARDEN_BYTES (but < original) so the
    // second run's skip is genuinely the hash-watermark gate, not the
    // separate too-small gate. Reuses the ORIGINAL's own seed ('v1') so it
    // also clears the vocabulary-overlap gate like a real curation would.
    const original = bigContent('v1', 6000)
    writeMemoryFile('chat-1', 'profile.md', original)
    const curated = bigContent('v1', 3000)
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
    const cheapEval = vi.fn(async (prompt: string) => {
      calls++
      if (calls === 1) throw new Error('transient network error')
      return curatedFromPrompt(prompt)
    })
    const result = await runGarden(makeDeps({ cheapEval }))
    expect(result).toEqual({ gardened: 1, skipped: 1 })
    expect(cheapEval).toHaveBeenCalledTimes(2)
  })

  describe('contentOverlap', () => {
    it('identical text ⇒ overlap 1', () => {
      expect(contentOverlap('hello world', 'hello world')).toBe(1)
    })

    it('English: curation reusing original words ⇒ high overlap', () => {
      const original = 'The user likes coffee and lives in Seattle. They work as a software engineer.'
      const curated = 'User likes coffee, lives in Seattle, works as a software engineer.'
      expect(contentOverlap(original, curated)).toBeGreaterThanOrEqual(0.5)
    })

    it('English: a refusal string shares almost no vocabulary with the original ⇒ low overlap', () => {
      const original = 'The user likes coffee and lives in Seattle. They work as a software engineer.'
      const refusal = "I'm sorry, but I can't help with that request."
      expect(contentOverlap(original, refusal)).toBeLessThan(0.5)
    })

    it('CJK: tokenizes per-character, so a curated subset of the same characters ⇒ high overlap', () => {
      const original = '用户喜欢喝咖啡，住在北京，是一名软件工程师。'
      const curated = '用户喜欢喝咖啡，住在北京。'
      expect(contentOverlap(original, curated)).toBeGreaterThanOrEqual(0.5)
    })

    it('CJK: a refusal string shares almost no characters with the original ⇒ low overlap', () => {
      const original = '用户喜欢喝咖啡，住在北京，是一名软件工程师。'
      const refusal = '我不能帮助整理这份记忆文件，因为这可能涉及隐私信息。'
      expect(contentOverlap(original, refusal)).toBeLessThan(0.5)
    })

    it('mixed CJK + English: overlap counts both scripts', () => {
      const original = '用户 likes coffee 喜欢喝咖啡 and lives in Seattle 住在北京'
      const curated = '用户 likes coffee 喜欢喝咖啡'
      expect(contentOverlap(original, curated)).toBeGreaterThanOrEqual(0.5)
    })

    it('empty curated ⇒ overlap 0', () => {
      expect(contentOverlap('some original content here', '')).toBe(0)
    })
  })
})
