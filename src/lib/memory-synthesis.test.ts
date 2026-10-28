import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDb } from './db'
import { makeObservationsStore } from '../daemon/observations/store'
import { makeMilestonesStore } from '../daemon/milestones/store'
import { makeLifeStoresReader } from '../daemon/life-stores'
import { readMemoryProfileFile, writeMemoryFile } from './memory'
import { MemoryProfileDocument } from '../cli/schema'
import { testFences } from '../test-support/memory-fences'
import {
  discoverProjectMemory,
  formatSynthesisPrompt,
  gatherFileSurvey,
  gatherLifeContext,
  getMemoryProfileStatus,
  projectDisplayName,
  summarizeProjectMemories,
  synthesizeOverview,
  synthesizeProfile,
  OVERVIEW_FILENAME,
} from './memory-synthesis'

let projectsRoot: string
let stateDir: string

// Lay down a Claude-style per-project memory dir under projectsRoot.
function seedProject(encodedDir: string, files: Record<string, string>): void {
  const memDir = join(projectsRoot, encodedDir, 'memory')
  mkdirSync(memDir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(memDir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
}

beforeEach(() => {
  FENCES = testFences()
  projectsRoot = mkdtempSync(join(tmpdir(), 'wcc-proj-'))
  stateDir = mkdtempSync(join(tmpdir(), 'wcc-state-'))
})
afterEach(() => {
  rmSync(projectsRoot, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

/** G8:生成物围栏在主库;每个测试一份内存主库(beforeEach 里换),合成和测试自己的「改源」用同一个。 */
let FENCES = testFences()
const FENCE = () => FENCES('test-chat')
/** G5:收回名单由记忆功能从表里给;这里给定的几句,命中记进 redactedHits。 */
const redactedHits: Array<[string, readonly string[]]> = []
const retractionsOf = (texts: string[], ownerDoc: import('./memory-owner').OwnerDoc = { assertions: [], extra: [] }) => ({ retractedTexts: () => new Set(texts), redacted: (kind: string, hits: readonly string[]) => { redactedHits.push([kind, hits]) }, ownerDoc: () => ownerDoc, memoryMd: () => null, get fence() { return FENCE() } })
const noRetractions = retractionsOf([])

describe('projectDisplayName', () => {
  it('strips home prefix + container, keeps hyphenated project names', () => {
    expect(projectDisplayName('-Users-me-Documents-sec-company', '/Users/me')).toBe('sec-company')
    expect(projectDisplayName('-Users-me-Documents-wechat-cc', '/Users/me')).toBe('wechat-cc')
    expect(projectDisplayName('-Users-me-Documents-kawanco-dev', '/Users/me')).toBe('kawanco-dev')
  })
  it('handles underscore-containing home dirs (encoded same as path sep)', () => {
    // /Users/na_me → "-Users-na-me-"; project "my-proj" under Documents
    expect(projectDisplayName('-Users-na-me-Documents-my-proj', '/Users/na_me')).toBe('my-proj')
  })
  it('falls back to the de-prefixed dir when home does not match', () => {
    expect(projectDisplayName('-some-other-path', '/Users/me')).toBe('some-other-path')
  })
})

describe('discoverProjectMemory', () => {
  it('finds projects with a memory dir, splitting MEMORY.md from other files', () => {
    seedProject('-Users-me-Documents-alpha', {
      'MEMORY.md': '- [x](x.md) — hook',
      'x.md': 'fact x',
    })
    seedProject('-Users-me-Documents-beta', { 'note.md': 'fact y' })
    const found = discoverProjectMemory(projectsRoot)
    expect(found.length).toBe(2)
    const alpha = found.find(p => p.encodedDir.endsWith('alpha'))!
    expect(alpha.index).toContain('hook')
    expect(alpha.files.map(f => f.path)).toEqual(['x.md'])
    const beta = found.find(p => p.encodedDir.endsWith('beta'))!
    expect(beta.index).toBeNull()
    expect(beta.files.length).toBe(1)
  })

  it('skips project dirs with no memory dir and empty memory dirs', () => {
    mkdirSync(join(projectsRoot, '-no-memory-here'), { recursive: true })
    mkdirSync(join(projectsRoot, '-empty', 'memory'), { recursive: true })
    seedProject('-real', { 'a.md': 'x' })
    const found = discoverProjectMemory(projectsRoot)
    expect(found.map(p => p.encodedDir)).toEqual(['-real'])
  })

  it('returns [] when projectsRoot does not exist', () => {
    expect(discoverProjectMemory(join(projectsRoot, 'nope'))).toEqual([])
  })
})

describe('summarizeProjectMemories', () => {
  it('returns read-only per-project metadata + content', () => {
    seedProject('-real-alpha', { 'MEMORY.md': 'idx', 'a.md': 'hello' })
    const out = summarizeProjectMemories(projectsRoot)
    expect(out.length).toBe(1)
    expect(out[0]!.index).toBe('idx')
    expect(out[0]!.files).toEqual([{ path: 'a.md', bytes: 5, content: 'hello' }])
    expect(out[0]!.totalBytes).toBeGreaterThan(0)
  })
})

describe('formatSynthesisPrompt', () => {
  it('embeds project names, counts, and content', () => {
    const prompt = formatSynthesisPrompt([
      { encodedDir: '-p-alpha', displayName: 'alpha', index: 'idx', files: [{ path: 'a.md', content: 'detail-a' }], totalBytes: 10 },
    ])
    expect(prompt).toContain('共 1 个项目')
    expect(prompt).toContain('alpha')
    expect(prompt).toContain('detail-a')
    expect(prompt).toContain('项目地图')
  })

  it('folds in the social side (D) when given plugin knowledge (D1)', () => {
    const proj = [{ encodedDir: '-p', displayName: 'p', index: null, files: [], totalBytes: 0 }]
    const withSocial = formatSynthesisPrompt(proj, null, null, '**未了义务**\n- 帮张三改简历')
    expect(withSocial).toContain('社交侧')
    expect(withSocial).toContain('帮张三改简历')
    expect(withSocial).toContain('分3类')          // A work + B life + D social
    // byte-identical when social absent OR whitespace (no spurious lines)
    const withoutSocial = formatSynthesisPrompt(proj, null, null)
    expect(formatSynthesisPrompt(proj, null, null, '   ')).toBe(withoutSocial)
    expect(withoutSocial).not.toContain('社交侧')
  })
})

describe('synthesizeOverview', () => {
  // 3b (b) 卡出口:模型合成出来的总览里,含主人更正过的话的行在写盘前丢掉、记数;返回给调用方的也是过滤后的。
  it('drops overview lines that repeat a corrected sentence before writing, and counts the hit', async () => {
    const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
    seedProject('-alpha', { 'MEMORY.md': 'idx', 'x.md': 'fact' })
    const chat = join(stateDir, 'memory', 'admin@im.wechat')
    mkdirSync(chat, { recursive: true })
    redactedHits.length = 0
    const res = await synthesizeOverview({ memory: retractionsOf(['住在 杭州西湖区']), stateDir, adminChatId: 'admin@im.wechat', projectsRoot, sdkEval: async () => '他喜欢爬山\n他住在 杭州西湖区\n养了一只猫' })
    expect(res.overview).toBe('他喜欢爬山\n养了一只猫')
    expect(readFileSync(join(chat, '_overview.md'), 'utf8')).not.toContain('西湖区')
    expect(redactedHits).toEqual([['overview', ['住在 杭州西湖区']]])
  })
  // 记忆编辑第 3 步:主人原话由代码逐字插在最前面「## 你写的」,不过出口过滤;模型看不到它(不喂合成),也伪造不了那一节。
  it('puts the owner\'s own words verbatim at the top, never shows them to the model, and drops a model-made 你写的 section', async () => {
    const { serializeOwnerDoc } = await import('./memory-owner')
    seedProject('-alpha', { 'MEMORY.md': 'idx', 'x.md': 'fact' })
    const chat = join(stateDir, 'memory', 'admin@im.wechat')
    mkdirSync(chat, { recursive: true })
    const ownerDoc = { assertions: [{ id: 'a1b2', text: '我不喝咖啡', date: '2026-10-23', origin: 'overview' as const }], extra: [] }
    writeFileSync(join(chat, 'owner.md'), serializeOwnerDoc(ownerDoc))   // G6:磁盘上这份不再被读,原话由 memory.ownerDoc 给
    // 主人原话恰好也是一条被更正的话的超集:出口过滤不该挡它
    let prompt = ''
    const res = await synthesizeOverview({ memory: retractionsOf(['喝咖啡'], ownerDoc), stateDir, adminChatId: 'admin@im.wechat', projectsRoot, sdkEval: async (p) => { prompt = p; return '## 你写的\n- 模型编的\n## 他是谁\n他喜欢爬山' } })
    expect(prompt).not.toContain('我不喝咖啡')
    const onDisk = readFileSync(join(chat, '_overview.md'), 'utf8')
    expect(onDisk).toContain('## 你写的\n- 我不喝咖啡 <!-- o:a1b2 -->')
    expect(onDisk).not.toContain('模型编的')
    expect(onDisk.indexOf('我不喝咖啡')).toBeLessThan(onDisk.indexOf('他喜欢爬山'))
    expect(res.overview).toBe('## 他是谁\n他喜欢爬山')
  })
  it('dry-run discovers without calling eval or writing', async () => {
    seedProject('-alpha', { 'MEMORY.md': 'idx', 'x.md': 'fact' })
    let called = false
    const res = await synthesizeOverview({ memory: noRetractions,
      stateDir,
      adminChatId: 'admin@im.wechat',
      projectsRoot,
      dryRun: true,
      sdkEval: async () => { called = true; return 'should not run' },
    })
    expect(called).toBe(false)
    expect(res.projectsFound).toBe(1)
    expect(res.projectNames).toEqual(['alpha'])
    expect(res.filesScanned).toBe(2)
    expect(res.written).toBeUndefined()
  })

  it('writes _overview.md under the admin memory dir on a real run', async () => {
    seedProject('-Users-me-Documents-alpha', { 'MEMORY.md': 'idx', 'x.md': 'fact' })
    const res = await synthesizeOverview({ memory: noRetractions,
      stateDir,
      adminChatId: 'admin@im.wechat',
      projectsRoot,
      sdkEval: async (p) => `整理结果(based on ${p.length} chars)`,
    })
    expect(res.written?.path).toBe(OVERVIEW_FILENAME)
    const onDisk = readFileSync(join(stateDir, 'memory', 'admin@im.wechat', OVERVIEW_FILENAME), 'utf8')
    expect(onDisk).toContain('整理结果')
    expect(onDisk).toContain('由 wechat-cc') // provenance stamp
  })

  it('no projects → no eval, no write', async () => {
    let called = false
    const res = await synthesizeOverview({ memory: noRetractions,
      stateDir,
      adminChatId: 'admin@im.wechat',
      projectsRoot,
      sdkEval: async () => { called = true; return 'x' },
    })
    expect(called).toBe(false)
    expect(res.projectsFound).toBe(0)
    expect(res.written).toBeUndefined()
  })

  it('empty eval result is not written', async () => {
    seedProject('-p', { 'a.md': 'x' })
    const res = await synthesizeOverview({ memory: noRetractions,
      stateDir,
      adminChatId: 'admin@im.wechat',
      projectsRoot,
      sdkEval: async () => '   ',
    })
    expect(res.written).toBeUndefined()
  })

  it('folds the life side (observations / milestones / admin notes) into the prompt', async () => {
    seedProject('-real-work', { 'MEMORY.md': 'idx', 'a.md': 'wrote code' })
    const db = openTestDb()
    const adminChatId = 'admin@im.wechat'
    await makeObservationsStore(db, adminChatId, {}).append({ body: '他最近在准备搬家' })
    await makeMilestonesStore(db, adminChatId, {}).fire({ id: 'ms_test', body: '第一次用语音功能' })
    writeMemoryFile(stateDir, adminChatId, 'profile.md', '喜欢猫', FENCE())

    let prompt = ''
    const res = await synthesizeOverview({ memory: noRetractions,
      stateDir, adminChatId, projectsRoot, lifeStores: makeLifeStoresReader(db, stateDir),
      sdkEval: async (p) => { prompt = p; return '整理结果' },
    })
    db.close()
    expect(res.observationsFound).toBe(1)
    expect(res.milestonesFound).toBe(1)
    expect(res.memoryNotesFound).toBe(1)
    expect(prompt).toContain('搬家')
    expect(prompt).toContain('语音')
    expect(prompt).toContain('喜欢猫')
    expect(prompt).toContain('生活侧')
    expect(res.written).toBeDefined()
  })

  it('gatherLifeContext keeps the MOST RECENT observations (last 20), not the oldest', async () => {
    const db = openTestDb()
    const adminChatId = 'admin@im.wechat'
    const { makeObservationsStore } = await import('../daemon/observations/store')
    const store = makeObservationsStore(db, adminChatId, {})
    for (let i = 1; i <= 25; i++) await store.append({ body: `obs-${i}` })
    const life = await gatherLifeContext({ stores: makeLifeStoresReader(db, stateDir), stateDir, adminChatId })
    db.close()
    expect(life.observations.length).toBe(20)
    expect(life.observations).toContain('obs-25')  // newest kept
    expect(life.observations).not.toContain('obs-1')  // oldest dropped
  })

  it('synthesizes from life alone when there are zero projects', async () => {
    const db = openTestDb()
    const adminChatId = 'admin@im.wechat'
    await makeObservationsStore(db, adminChatId, {}).append({ body: '生活观察一条' })
    let called = false
    const res = await synthesizeOverview({ memory: noRetractions,
      stateDir, adminChatId, projectsRoot, lifeStores: makeLifeStoresReader(db, stateDir),  // projectsRoot empty → 0 projects
      sdkEval: async () => { called = true; return 'ok' },
    })
    db.close()
    expect(res.projectsFound).toBe(0)
    expect(res.observationsFound).toBe(1)
    expect(called).toBe(true)
    expect(res.written).toBeDefined()
  })
})

describe('file survey in synthesis', () => {
  it('formatSynthesisPrompt includes the 文件侧 block when survey non-empty, omits when empty', () => {
    const survey = { folders: [{ path: '/home/me/工作', fileCount: 3, subdirs: [], sample: ['Q3预算.xlsx'] }], truncated: false }
    const withSurvey = formatSynthesisPrompt([], null, survey)
    expect(withSurvey).toContain('文件侧')
    expect(withSurvey).toContain('Q3预算.xlsx')
    const without = formatSynthesisPrompt([], null, { folders: [], truncated: false })
    expect(without).not.toContain('文件侧(本机文件概览)')
  })

  it('synthesizeOverview synthesizes from a survey alone (no projects/life)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcc-syn-survey-'))
    const fileRoot = mkdtempSync(join(tmpdir(), 'wcc-syn-files-'))
    mkdirSync(join(fileRoot, '工作'), { recursive: true })
    writeFileSync(join(fileRoot, '工作', 'Q3预算.xlsx'), 'x')
    let prompt = ''
    const res = await synthesizeOverview({ memory: noRetractions,
      stateDir: dir,
      adminChatId: 'admin@im.wechat',
      projectsRoot: join(dir, 'no-projects'),
      includeFileSurvey: true,
      surveyRoots: [fileRoot],
      sdkEval: async (p) => { prompt = p; return '整理结果' },
    })
    expect(res.foldersScanned).toBeGreaterThan(0)
    expect(prompt).toContain('Q3预算.xlsx')
    expect(res.overview).toBe('整理结果')
    rmSync(dir, { recursive: true, force: true }); rmSync(fileRoot, { recursive: true, force: true })
  })

  it('gatherFileSurvey includes dirs parsed from locations.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcc-loc-'))
    const fileRoot = mkdtempSync(join(tmpdir(), 'wcc-loc-files-'))
    writeFileSync(join(fileRoot, '报告.docx'), 'x')
    mkdirSync(join(dir, 'memory', 'admin@im.wechat'), { recursive: true })
    writeFileSync(join(dir, 'memory', 'admin@im.wechat', 'locations.md'), `- 报告 → ${join(fileRoot, '报告.docx')}\n`)
    const survey = gatherFileSurvey({ stateDir: dir, adminChatId: 'admin@im.wechat' })
    // fileRoot (dirname of the mapped file) is surveyed → its file appears
    expect(survey.folders.some(f => f.sample.includes('报告.docx'))).toBe(true)
    rmSync(dir, { recursive: true, force: true }); rmSync(fileRoot, { recursive: true, force: true })
  })

  // Fix 1: paths with spaces in locations.md must not be truncated at the space
  it('gatherFileSurvey includes dirs when the mapped path contains a space', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wcc-loc-sp-'))
    const outerRoot = mkdtempSync(join(tmpdir(), 'wcc-loc-sp-files-'))
    const spacedDir = join(outerRoot, 'My Files')
    mkdirSync(spacedDir)
    writeFileSync(join(spacedDir, '报告.docx'), 'x')
    mkdirSync(join(dir, 'memory', 'admin@im.wechat'), { recursive: true })
    writeFileSync(
      join(dir, 'memory', 'admin@im.wechat', 'locations.md'),
      `- 工作报告 → ${join(spacedDir, '报告.docx')}\n`,
    )
    const survey = gatherFileSurvey({ stateDir: dir, adminChatId: 'admin@im.wechat' })
    // spacedDir (dirname of the file with a space in its path) must be surveyed
    expect(survey.folders.some(f => f.sample.includes('报告.docx'))).toBe(true)
    rmSync(dir, { recursive: true, force: true }); rmSync(outerRoot, { recursive: true, force: true })
  })

  // Fix 3: survey intro line is conditional on hasSurvey
  it('formatSynthesisPrompt uses survey-aware intro line (电脑里在忙的东西 only when survey present)', () => {
    const filledSurvey = { folders: [{ path: '/x', fileCount: 1, subdirs: [], sample: [] }], truncated: false }
    const withSurvey = formatSynthesisPrompt([], null, filledSurvey)
    expect(withSurvey).toContain('电脑里在忙的东西')

    const emptySurvey = { folders: [], truncated: false }
    const withoutSurvey = formatSynthesisPrompt([], null, emptySurvey)
    expect(withoutSurvey).not.toContain('电脑里在忙的东西')
    expect(withoutSurvey).toContain('工作和生活不要分开看')
  })
})

describe('profile evidence', () => {
  const adminChatId = 'owner@im.wechat'
  const tokensIn = (prompt: string): Array<{ token: string; label: string }> =>
    [...prompt.matchAll(/【依据 (e_[a-f0-9]{16})】([^\n]+)\n/g)].map(m => ({ token: m[1]!, label: m[2]! }))

  it('keeps real store IDs aligned with the recent bodies while preserving legacy readers', async () => {
    const db = openTestDb()
    try {
      const observations = makeObservationsStore(db, adminChatId)
      const ids = []
      for (let i = 0; i < 22; i++) ids.push(await observations.append({ body: `观察 ${i}` }))
      await observations.archive(ids[0]!)
      await makeMilestonesStore(db, adminChatId).fire({ id: 'ms_first', body: '第一次散步' })
      const reader = makeLifeStoresReader(db, stateDir)
      const life = await gatherLifeContext({ stores: reader, stateDir, adminChatId })
      expect(await reader.listObservations(adminChatId)).toHaveLength(21)
      expect(await reader.listMilestones(adminChatId)).toEqual(['第一次散步'])
      expect(life.observationRecords).toHaveLength(20)
      expect(life.observationRecords?.[0]).toEqual({ id: ids[2], body: '观察 2' })
      expect(life.observations[0]).toBe('观察 2')
      expect(life.milestoneRecords).toEqual([{ id: 'ms_first', body: '第一次散步' }])
    } finally { db.close() }
  })

  it('resolves only catalog tokens to exact memory, observation, milestone and project sources', async () => {
    const db = openTestDb()
    try {
      const obsId = await makeObservationsStore(db, adminChatId).append({ body: '喜欢清晨散步' })
      await makeMilestonesStore(db, adminChatId).fire({ id: 'ms_walk', body: '完成了第一次远足' })
      writeMemoryFile(stateDir, adminChatId, 'preferences.md', '偏爱安静的树林', FENCE())
      writeMemoryFile(stateDir, adminChatId, 'family.md', '记挂家人', FENCE())
      writeMemoryFile(stateDir, adminChatId, 'notes.md', '每周运动', FENCE())
      seedProject('-alpha', { 'MEMORY.md': '你在做 alpha', 'routine.md': '你会认真检查改动' })
      seedProject('-beta', { 'routine.md': '你会记录读书笔记' })
      const result = await synthesizeProfile({ memory: noRetractions,
        stateDir, adminChatId, projectsRoot, lifeStores: makeLifeStoresReader(db, stateDir),
        sdkEval: async prompt => {
          const entries = tokensIn(prompt)
          const selected = ['preferences.md', '观察：喜欢清晨散步', '里程碑：完成了第一次远足', 'alpha · routine.md']
            .map(label => entries.find(entry => entry.label === label)?.token)
          expect(selected.every(Boolean)).toBe(true)
          return JSON.stringify({
            insight: '你喜欢自然', summary: '你愿意为重要的事情花时间', tags: [],
            sourceRefs: [{ kind: 'memory', path: 'fabricated.md', label: '伪造' }],
            traits: [{ title: '你的习惯', body: '你会坚持关注在意的事情', sources: ['旧名称'], sourceRefs: [
              'e_0000000000000000', { kind: 'memory', path: '../secrets.md', label: '伪造' }, ...selected, selected[0],
            ] }],
            preferences: [], rememberedEvents: [],
          })
        },
      })
      const expected = [
        { kind: 'memory', path: 'preferences.md', label: 'preferences.md' },
        { kind: 'observation', id: obsId, label: '观察：喜欢清晨散步' },
        { kind: 'milestone', id: 'ms_walk', label: '里程碑：完成了第一次远足' },
        { kind: 'project', project: '-alpha', path: 'routine.md', label: 'alpha · routine.md' },
      ]
      expect(result.profile?.traits[0]?.sourceRefs).toEqual(expected)
      expect(result.profile?.traits[0]?.sources).toEqual(['旧名称'])
      expect(result.profile).not.toHaveProperty('sourceRefs')
      const persisted = JSON.parse(readFileSync(join(stateDir, 'memory', adminChatId, '_profile.json'), 'utf8'))
      expect(MemoryProfileDocument.parse(persisted).traits[0]?.sourceRefs).toEqual(expected)
    } finally { db.close() }
  })

  it('never upgrades legacy source names or fabricated ref objects into links', async () => {
    for (const name of ['preferences.md', 'family.md', 'notes.md']) writeMemoryFile(stateDir, adminChatId, name, '你的一条记忆', FENCE())
    const result = await synthesizeProfile({ memory: noRetractions,
      stateDir, adminChatId, projectsRoot,
      lifeStores: { listObservations: async () => ['旧观察'], listMilestones: async () => [] },
      sdkEval: async () => JSON.stringify({
        insight: '你关心生活', summary: '', tags: [],
        traits: [{ title: '你的偏好', body: '你喜欢安静', sources: ['preferences.md', '旧观察'],
          sourceRefs: ['preferences.md', 'e_0000000000000000', { kind: 'memory', path: 'preferences.md', label: '伪造' }] }],
        preferences: [], rememberedEvents: [],
      }),
    })
    expect(result.profile?.traits[0]?.sources).toEqual(['preferences.md', '旧观察'])
    expect(result.profile?.traits[0]?.sourceRefs).toBeUndefined()
    expect(MemoryProfileDocument.parse(result.profile).traits[0]?.sourceRefs).toBeUndefined()
  })

  it('retains personal-memory evidence when project content exhausts the work budget', async () => {
    for (let i = 0; i < 5; i++) seedProject(`-project-${i}`, {
      'a.md': '项目内容'.repeat(1000), 'b.md': '项目内容'.repeat(1000), 'c.md': '项目内容'.repeat(1000),
    })
    writeMemoryFile(stateDir, adminChatId, 'personal.md', '你会记得给家人打电话', FENCE())
    const result = await synthesizeProfile({ memory: noRetractions, stateDir, adminChatId, projectsRoot,
      lifeStores: { listObservations: async () => [], listMilestones: async () => [] },
      sdkEval: async prompt => {
        const token = tokensIn(prompt).find(entry => entry.label === 'personal.md')?.token
        expect(token).toBeDefined()
        return JSON.stringify({ insight: '你关心家人', traits: [{ title: '你的关系', body: '你在意与家人的联系', sourceRefs: [token] }] })
      },
    })
    expect(result.profile?.traits[0]?.sourceRefs).toEqual([{ kind: 'memory', path: 'personal.md', label: 'personal.md' }])
  })

  it('does not accept a previously valid reference when its material was omitted by the prompt budget', async () => {
    const stores = { listObservations: async () => [], listMilestones: async () => [] }
    writeMemoryFile(stateDir, adminChatId, 'zz-hidden.md', '只存在于最后一份笔记的依据'.repeat(400), FENCE())
    let originalToken = ''
    await synthesizeProfile({ memory: noRetractions,
      stateDir, adminChatId, projectsRoot, lifeStores: stores,
      sdkEval: async prompt => {
        originalToken = tokensIn(prompt).find(entry => entry.label === 'zz-hidden.md')?.token ?? ''
        return JSON.stringify({ insight: '你有长期记忆' })
      },
    })
    expect(originalToken).toMatch(/^e_[a-f0-9]{16}$/)
    for (let i = 0; i < 15; i++) writeMemoryFile(stateDir, adminChatId, `a${i}.md`, '已提供的内容'.repeat(1000), FENCE())
    const result = await synthesizeProfile({ memory: noRetractions,
      stateDir, adminChatId, projectsRoot, lifeStores: stores,
      sdkEval: async prompt => {
        expect(prompt).not.toContain('只存在于最后一份笔记的依据')
        expect(prompt).not.toContain(originalToken)
        expect(prompt.length).toBeLessThan(43_000)
        return JSON.stringify({ insight: '你有长期记忆', traits: [{ title: '你的习惯', body: '你喜欢记录', sourceRefs: [originalToken] }] })
      },
    })
    expect(result.profile?.traits[0]?.sourceRefs).toBeUndefined()
  })
})

describe('derived memory generation fences', () => {
  const adminChatId = 'owner@im.wechat'
  const lifeStores = { listObservations: async () => [], listMilestones: async () => [] }
  const seedNotes = () => {
    for (const name of ['preferences.md', 'family.md', 'notes.md']) writeMemoryFile(stateDir, adminChatId, name, '你的一条记忆', FENCE())
  }

  it.each(['overview', 'profile'] as const)('rejects late %s output if a correction lands during the model call', async kind => {
    seedNotes()
    const synthesize = kind === 'overview' ? synthesizeOverview : synthesizeProfile
    const result = await synthesize({ memory: noRetractions, stateDir, adminChatId, projectsRoot, lifeStores, sdkEval: async () => {
      FENCE().invalidate()
      writeMemoryFile(stateDir, adminChatId, 'preferences.md', '你更正后的偏好', FENCE())
      return kind === 'overview' ? '迟到的概要' : JSON.stringify({ insight: '迟到的画像' })
    } })
    expect(result.written).toBeUndefined()
    expect(FENCE().isStale('overview')).toBe(true)
    expect(FENCE().isStale('profile')).toBe(true)
  })

  it.each(['overview', 'profile'] as const)('does not overwrite %s after a correction during the model call', async kind => {
    seedNotes()
    const synthesize = kind === 'overview' ? synthesizeOverview : synthesizeProfile
    const output = (text: string) => kind === 'overview' ? text : JSON.stringify({ insight: text })
    await synthesize({ memory: noRetractions, stateDir, adminChatId, projectsRoot, lifeStores, sdkEval: async () => output('旧的画像') })
    const file = join(stateDir, 'memory', adminChatId, kind === 'overview' ? '_overview.md' : '_profile.json')
    const before = readFileSync(file, 'utf8')
    const result = await synthesize({ memory: noRetractions, stateDir, adminChatId, projectsRoot, lifeStores, sdkEval: async () => {
      FENCE().invalidate()
      return output('过时的推断')
    } })
    expect(result.written).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(FENCE().isStale(kind)).toBe(true)
  })

  it.each(['overview', 'profile'] as const)('does not overwrite %s when source text changed outside the correction API', async kind => {
    seedNotes()
    const synthesize = kind === 'overview' ? synthesizeOverview : synthesizeProfile
    const result = await synthesize({ memory: noRetractions, stateDir, adminChatId, projectsRoot, lifeStores, sdkEval: async () => {
      writeMemoryFile(stateDir, adminChatId, 'preferences.md', '现在你喜欢户外活动', FENCE())
      return kind === 'overview' ? '根据旧材料生成' : JSON.stringify({ insight: '根据旧材料生成' })
    } })
    expect(result.written).toBeUndefined()
  })

  it('reports a recently corrected profile as stale and makes a successful refresh fresh', async () => {
    seedNotes()
    const deps = { memory: noRetractions, stateDir, adminChatId, projectsRoot, lifeStores, sdkEval: async () => JSON.stringify({ insight: '你喜欢生活' }) }
    await synthesizeProfile(deps)
    const root = join(stateDir, 'memory', adminChatId)
    FENCE().invalidate()
    const stale = await getMemoryProfileStatus(deps)
    expect(stale).toMatchObject({ status: 'stale', changed: true, needsRefresh: true, canAutoGenerate: true, daysSinceGenerated: 0 })
    expect(MemoryProfileDocument.parse(JSON.parse(readMemoryProfileFile(stateDir, adminChatId, FENCE()))).needsRefresh).toBe(true)
    await synthesizeProfile(deps)
    expect(FENCE().isStale('profile')).toBe(false)
    expect(FENCE().isStale('overview')).toBe(true)
    expect(MemoryProfileDocument.parse(JSON.parse(readMemoryProfileFile(stateDir, adminChatId, FENCE()))).needsRefresh).toBeUndefined()
    expect(await getMemoryProfileStatus(deps)).toMatchObject({ status: 'fresh', changed: false, needsRefresh: false })
  })

  it('captures the revision before awaiting source readers', async () => {
    seedNotes()
    let read = false
    const result = await synthesizeProfile({ memory: noRetractions, stateDir, adminChatId, projectsRoot,
      lifeStores: { ...lifeStores, listObservations: async () => {
        if (!read) FENCE().invalidate()
        read = true
        return []
      } },
      sdkEval: async () => JSON.stringify({ insight: '你喜欢生活' }),
    })
    expect(result.written).toBeUndefined()
  })
})

// 3e 记忆第 3 步:合成只吃源 —— 生成物(_overview / knowledge.md)、队列(today-draft)、和复述被纠正原话的 corrections.md 都不当素材。
describe('gatherLifeContext reads only source memory', () => {
  it('feeds memory.md / profile.md / notes, and skips derived, queue and corrections files', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const stateDir = mkdtempSync(join(tmpdir(), 'synth-sources-'))
    try {
      const dir = join(stateDir, 'memory', 'owner1')
      mkdirSync(join(dir, 'notes'), { recursive: true })
      for (const [f, body] of [['memory.md', 'm'], ['profile.md', 'p'], ['notes/trip.md', 'n'], ['_overview.md', 'o'], ['knowledge.md', 'k'], ['today-draft.md', 'd'], ['corrections.md', '主人说这条已经过时:旧地址']] as const) writeFileSync(join(dir, f), body)
      // G6:memory.md 的内容由记忆功能从表里给(memoryMd),不读磁盘上那份
      const life = await gatherLifeContext({ stores: null, stateDir, adminChatId: 'owner1', memoryMd: () => 'm(来自表)' })
      expect(life.memoryNotes.map(n => n.name).sort()).toEqual(['memory.md', 'notes/trip.md', 'profile.md'])
      expect(life.memoryNotes.find(n => n.name === 'memory.md')!.content).toBe('m(来自表)')
      // 没给 ⇒ 不喂 memory.md,也不去读那个文件
      expect((await gatherLifeContext({ stores: null, stateDir, adminChatId: 'owner1' })).memoryNotes.map(n => n.name).sort()).toEqual(['notes/trip.md', 'profile.md'])
      expect(JSON.stringify(life.memoryNotes)).not.toContain('旧地址')
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })
})
