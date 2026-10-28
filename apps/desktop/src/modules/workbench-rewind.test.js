import { describe, expect, it } from 'vitest'
import { renderReviewPanel, renderTurn, reviewsSignature } from './workbench-review-panel.js'
import { REWIND_STALE_NOTICE, renderRewindBlocked, renderRewindConfirm, rewindErrorMessage } from './workbench-rewind.js'

/** @param {unknown} value */
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
const formatTime = (/** @type {number} */ value) => `T${value}`
const renderDiff = () => ''
const options = (/** @type {Record<string,unknown>} */ extra = {}) => ({ escapeHtml, formatTime, renderDiff, ...extra })
const file = (/** @type {Record<string,unknown>} */ o = {}) => ({ path: 'src/app.ts', preexisting: false, kind: 'modified', diff: '@@ -1 +1 @@\n-a\n+b', ...o })
const turn = (/** @type {Record<string,unknown>} */ o = {}) => ({ artifactId: 'ART-1', sha256: 'a'.repeat(64), name: 'x.json', createdAt: 100, status: 'complete', headBefore: null, headAfter: null, preexistingPaths: [], notes: [], files: [file()], ...o })
const preview = (/** @type {Record<string,unknown>} */ o = {}) => ({
  token: 'c'.repeat(64), target: { artifactId: 'ART-1', to: 'end', round: 1 }, discarded: [{ artifactId: 'ART-2', round: 2 }, { artifactId: 'ART-3', round: 3 }],
  files: { count: 2, paths: [{ status: 'A', path: 'src/new.ts' }, { status: 'M', path: 'src/<a>.ts' }] }, extraChanges: { count: 0, paths: [] },
  droppedCommits: { count: 0, elsewhere: false }, ignoredUntouched: true, rebuildHint: '用之前先重新构建。', refsNote: 'refs', session: 'none', devServer: false, goal: null, ...o,
})

describe('回到某一轮:改动面板', () => {
  it('老后台(没有 rewindable / discarded)渲出来和以前一字不差,签名也不变', () => {
    const plain = renderTurn(turn(), 1, 0, options())
    expect(plain).not.toContain('rewind')
    expect(plain).not.toContain('已撤掉')
    expect(plain).toContain('<section class="wb-review-turn" data-review-turn=')
    expect(renderReviewPanel([turn()], options())).toBe(renderReviewPanel([turn()], options({ rewind: { open: null, view: null } })))
    expect(reviewsSignature([turn()])).toBe(JSON.stringify([['a'.repeat(64), 'complete', [['src/app.ts', null, '']]]]))
  })

  it('最新一轮「撤掉这一轮」(to:start),更早的「回到这一轮结束时」(to:end);没有回退点不给', () => {
    const reviews = [turn({ artifactId: 'ART-2', sha256: 'b'.repeat(64), rewindable: { start: true, end: true } }), turn({ rewindable: { start: true, end: true } })]
    const html = renderReviewPanel(reviews, options())
    expect(html).toContain('data-action="rewind-open" data-artifact-id="ART-2" data-to="start" data-round="2">撤掉这一轮</button>')
    expect(html).toContain('data-action="rewind-open" data-artifact-id="ART-1" data-to="end" data-round="1">回到这一轮结束时</button>')
    const none = renderReviewPanel([turn({ rewindable: { start: false, end: true } })], options())
    expect(none).not.toContain('rewind-open')
  })

  it('撤掉的轮:灰掉、标「已撤掉」、不给按钮;它下面那一轮成了「最新」;最近一次回退给「撤销回退」', () => {
    const reviews = [turn({ artifactId: 'ART-2', sha256: 'b'.repeat(64), discarded: true, rewindable: { start: false, end: false } }), turn({ rewindable: { start: true, end: true } })]
    const html = renderReviewPanel(reviews, options({ rewind: { view: { undo: { rewindId: 'R-1', createdAt: 5 }, blocked: null } } }))
    expect(html).toContain('<section class="wb-review-turn is-discarded"')
    expect(html).toContain('<span class="wb-review-badge" data-mark="discarded">已撤掉</span>')
    const gone = html.slice(html.indexOf('is-discarded'), html.indexOf('</section>'))
    expect(gone).not.toContain('review-accept'); expect(gone).not.toContain('review-revert'); expect(gone).not.toContain('rewind-open')
    expect(html).toContain('data-artifact-id="ART-1" data-to="start" data-round="1">撤掉这一轮</button>')
    expect(html).toContain('data-action="rewind-undo" data-rewind-id="R-1">撤销回退</button>')
    expect(reviewsSignature(reviews)).not.toBe(reviewsSignature([{ ...reviews[0], discarded: undefined }, reviews[1]]))
  })

  it('确认块:撤掉哪几轮、文件(转义)、额外改动、重新构建、远端提示、会话;只有「确认回退」是主按钮', () => {
    const open = { artifactId: 'ART-1', to: /** @type {const} */ ('end'), round: 1, status: /** @type {const} */ ('ready'), preview: preview({ extraChanges: { count: 1, paths: [{ status: 'A', path: 'notes.txt' }] }, droppedCommits: { count: 2, elsewhere: true }, session: 'will_close', devServer: true, goal: { status: 'active', willStop: true } }) }
    const html = renderTurn(turn({ rewindable: { start: true, end: true } }), 1, 1, options({ rewind: { open } }), false)
    expect(html).not.toContain('rewind-open')
    expect(html).toContain('回到第 1 轮结束时')
    expect(html).toContain('会撤掉第 2–3 轮。')
    expect(html).toContain('2 个文件会变回那一刻的样子')
    expect(html).toContain('会删掉</span><span class="wb-review-path">src/new.ts')
    expect(html).toContain('src/&lt;a&gt;.ts')
    expect(html).toContain('又有 1 处改动'); expect(html).toContain('notes.txt')
    expect(html).toContain('撤掉 2 个提交；这些提交在别的分支或远端里还有一份')
    expect(html).toContain('用之前先重新构建。')
    expect(html).toContain('安静着的会话会先关掉'); expect(html).toContain('开发服务还在跑'); expect(html).toContain('「直到检查通过」会停下')
    expect(html.match(/wb-btn-primary/g)).toHaveLength(1)
    expect(html).toContain('data-action="rewind-confirm">确认回退</button>')
    expect(html).toContain('data-action="rewind-cancel">算了</button>')
    expect(html).not.toMatch(/th-bad|wb-error/)
    const many = renderRewindConfirm({ ...open, preview: preview({ files: { count: 80, paths: Array.from({ length: 50 }, (_, i) => ({ status: 'M', path: `f${i}` })) } }) }, escapeHtml)
    expect(many).toContain('80 个文件会变回那一刻的样子（下面列出前 50 个）')
    expect(renderRewindConfirm({ ...open, notice: REWIND_STALE_NOTICE }, escapeHtml)).toContain('工作区刚变过')
    expect(renderRewindConfirm({ ...open, status: 'loading', preview: undefined }, escapeHtml)).toContain('正在核对工作区')
    expect(renderRewindConfirm({ ...open, status: 'error', error: '回不去', preview: undefined }, escapeHtml)).toContain('回不去')
    expect(renderRewindConfirm(open, escapeHtml, true)).toContain('data-action="rewind-confirm" disabled')
  })

  it('停住时的提示:时间线那句原因 + 两个选择;恢复要再确认;没停住不画', () => {
    const detail = { task: { error: 'rewind_needs_owner' }, rewind: { undo: null, blocked: { rewindId: 'R', backupRef: 'refs/tendhearth/rewind/x/1', reason: '回退没做成（x），也没能完整恢复原样。' } } }
    const html = renderRewindBlocked(detail, false, escapeHtml)
    expect(html).toContain('回退没做成（x）'); expect(html).toContain('refs/tendhearth/rewind/x/1')
    expect(html).toContain('data-action="rewind-keep">保留现在的样子</button>')
    expect(html).toContain('data-action="rewind-restore">恢复到回退之前</button>')
    expect(html).not.toContain('wb-btn-primary')
    const confirm = renderRewindBlocked(detail, true, escapeHtml)
    expect(confirm).toContain('data-action="rewind-restore-confirm">确认恢复</button>'); expect(confirm).toContain('rewind-restore-cancel')
    expect(renderRewindBlocked({ task: { error: 'rewind_needs_owner' } }, false, escapeHtml)).toContain('上次回退没做完')
    expect(renderRewindBlocked({ task: { error: null } }, false, escapeHtml)).toBe('')
  })

  it('错误码说成人话(带 :reason 的也认)', () => {
    expect(rewindErrorMessage(new Error('rewind_unavailable:branch_moved'))).toContain('不在这件事自己的分支上')
    expect(rewindErrorMessage(new Error('rewind_unavailable'))).toContain('Git 出错了')
    expect(rewindErrorMessage(new Error('rewind_merged'))).toContain('合回项目')
    expect(rewindErrorMessage(new Error('rewind_failed:rewind_verify_file'))).toContain('没做成')
    expect(rewindErrorMessage(new Error('something_else'))).toBeNull()
  })
})
