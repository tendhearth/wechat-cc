import { describe, expect, it } from 'vitest'
import { canOfferRewind, discardedLines, REWIND_MAX_PATHS, rewindBlockedNotice, rewindOutcome, rewindPreviewError, rewindSheet } from './rewind'
import type { PhoneChangesTurnT, RewindPreviewT } from '../backend/types'

const TURN: PhoneChangesTurnT = { artifactId: 'abcdef12', createdAt: 1, rewindable: true, status: 'complete', files: [], omittedFiles: 0, notes: [] }
const PREVIEW: RewindPreviewT = { token: 'f'.repeat(64), round: 3, rounds: [3], files: { count: 2, paths: [{ status: 'M', path: 'a.ts' }, { status: 'A', path: 'b.ts' }] }, extraChanges: null, droppedCommits: { count: 0, elsewhere: false }, rebuildHint: '中文那句', session: 'none', devServer: false, goalWillStop: false }

describe('撤掉这一轮的入口', () => {
  it('只在能撤、没撤掉、没停住时给按钮', () => {
    expect(canOfferRewind(TURN, false)).toBe(true)
    expect(canOfferRewind(TURN, true)).toBe(false)
    expect(canOfferRewind({ ...TURN, rewindable: undefined }, false)).toBe(false)
    expect(canOfferRewind({ ...TURN, discarded: true }, false)).toBe(false)
    expect(canOfferRewind({ ...TURN, artifactId: undefined }, false)).toBe(false)
    expect(canOfferRewind(null, false)).toBe(false)
  })
  it('停住 ⇒ 只读一句;没停住 / 老电脑不带 ⇒ null', () => {
    expect(rewindBlockedNotice({ rewind: { blocked: true } } as never, 'zh-Hans')).toBe('这件事回退时出了状况，请在电脑上处理')
    expect(rewindBlockedNotice({ rewind: { blocked: false } } as never, 'zh-Hans')).toBeNull()
    expect(rewindBlockedNotice({} as never, 'zh-Hans')).toBeNull()
    expect(rewindBlockedNotice(null, 'en')).toBeNull()
  })
  it('已撤掉灰着说一句;之后撤掉了几轮', () => {
    expect(discardedLines({ ...TURN, discarded: true }, 'zh-Hans')).toEqual({ discarded: '已撤掉', after: null })
    expect(discardedLines({ ...TURN, discardedAfter: 1 }, 'zh-Hans').after).toBe('之后的 1 轮已撤掉。')
    expect(discardedLines({ ...TURN, discardedAfter: 2 }, 'en').after).toBe('2 later rounds were undone.')
    expect(discardedLines(TURN, 'en')).toEqual({ discarded: null, after: null })
  })
})

describe('确认页', () => {
  it('第几轮、文件数 + 路径、一定提醒重新构建与先备份(用本机语言,不用电脑给的中文那句)', () => {
    const v = rewindSheet(PREVIEW, 'en')
    expect(v.title).toBe('Undo round 3')
    expect(v.filesHead).toBe('Changes to 2 files will be undone:')
    expect(v.paths).toEqual(['M a.ts', 'A b.ts']); expect(v.more).toBeNull()
    expect(v.notes.some(n => n.includes('rebuild'))).toBe(true)
    expect(v.notes.join('')).not.toContain('中文那句')
  })
  it('至多 50 个路径,其余说「还有 N 个」;额外改动 / 丢掉的提交 / 别处还有 / 会话 / 开发服务 / goal 各一句', () => {
    const many = { ...PREVIEW, files: { count: 80, paths: Array.from({ length: 60 }, (_, i) => ({ status: 'M', path: `f${i}` })) }, extraChanges: { count: 2, paths: [] }, droppedCommits: { count: 1, elsewhere: true }, session: 'will_close', devServer: true, goalWillStop: true }
    const v = rewindSheet(many, 'zh-Hans')
    expect(v.paths).toHaveLength(REWIND_MAX_PATHS); expect(v.more).toBe('…还有 30 个')
    expect(v.notes).toEqual([
      '这一轮之后又有 2 处改动（比如你手改过的），也会一起撤掉，撤之前先备份。', '分支上的 1 个提交会一起去掉。', '这些提交在别的分支或远端里还有。',
      '这件事安静着的会话会先关掉，下一句按原会话接着。', '开发服务还开着，撤完可能要重启它。', '「直到命令通过」会停下，还要检查请重新建。',
      '被 ignore 的构建产物（dist/、node_modules 这类）不会跟着回退，用之前先重新构建。', '撤之前会先把现在的样子备份；要恢复，请在电脑上「撤销回退」。',
    ])
    expect(rewindSheet({ ...PREVIEW, files: { count: 0, paths: [] } }, 'zh-Hans').filesHead).toBe('这一轮没有留下文件改动，只把分支退回去。')
  })
})

describe('确认之后', () => {
  it('成了 ⇒ 已撤掉第 N 轮;工作区刚变过 ⇒ stale(重拉);超时 ⇒ 不确定,不说成了', () => {
    expect(rewindOutcome('ok', 3, 'zh-Hans')).toEqual({ kind: 'done', text: '已撤掉第 3 轮。' })
    expect(rewindOutcome({ error: 'rewind_stale' }, 3, 'zh-Hans')).toEqual({ kind: 'stale', text: '工作区刚变过，请再看一眼' })
    const u = rewindOutcome({ error: 'uncertain' }, 3, 'zh-Hans')
    expect(u).toEqual({ kind: 'uncertain', text: '不确定电脑那边做完没有，过一会儿看看' })
    expect(u.text).not.toContain('已撤掉')
  })
  it('停住 / 切换失败 ⇒ blocked(关掉,详情那句接手);别的 ⇒ 留在确认页说为什么', () => {
    expect(rewindOutcome({ error: 'rewind_needs_owner' }, 1, 'zh-Hans').kind).toBe('blocked')
    expect(rewindOutcome({ error: 'rewind_failed' }, 1, 'zh-Hans').kind).toBe('blocked')
    expect(rewindOutcome('busy', 1, 'zh-Hans')).toEqual({ kind: 'error', text: '这件事还在做，等这一轮做完再撤。' })
    expect(rewindOutcome({ error: 'rewind_merged' }, 1, 'en').kind).toBe('error')
    expect(rewindOutcome({ error: 'offline' }, 1, 'zh-Hans')).toEqual({ kind: 'error', text: '没送到，再试一次。' })
  })
  it('拉预览失败:有专门那句就说那句;超时 / 别的 ⇒ 没拿到', () => {
    expect(rewindPreviewError('rewind_needs_owner', 'zh-Hans')).toBe('这件事回退时出了状况，请在电脑上处理')
    expect(rewindPreviewError('rewind_unavailable', 'zh-Hans')).toBe('这一轮没法撤（没有回退点，或不是独立工作区）。')
    expect(rewindPreviewError('timeout', 'zh-Hans')).toBe('没拿到要撤的内容，再试一次。')
    expect(rewindPreviewError('uncertain', 'zh-Hans')).toBe('没拿到要撤的内容，再试一次。')
  })
})
