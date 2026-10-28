import { describe, expect, it } from 'vitest'
import { SCRIPT_LINES_SHOWN, scriptOutcome, scriptsBlock } from './worktree-scripts'

const WT = { branch: 'cc/abcd1234', removed: false }

describe('工作区脚本那一行(2026-10-20)', () => {
  it('没配 / 工作区删了 / 老电脑不带 ⇒ null', () => {
    expect(scriptsBlock(undefined, 'zh-Hans')).toBeNull()
    expect(scriptsBlock(WT, 'zh-Hans')).toBeNull()
    expect(scriptsBlock({ ...WT, port: 47100 }, 'zh-Hans')).toBeNull()
    expect(scriptsBlock({ ...WT, removed: true, approved: true, run: 'idle' }, 'zh-Hans')).toBeNull()
  })
  it('没批 ⇒ 没有按钮,只说请先在电脑上确认;不给输出', () => {
    const b = scriptsBlock({ ...WT, approved: false, setup: 'pending', run: 'idle', lastLines: ['x'] }, 'zh-Hans')!
    expect(b.button).toBeNull()
    expect(b.status).toBe('工作区脚本：待在电脑上确认')
    expect(b.note).toBe('请先在电脑上确认一次这个仓库的脚本')
    expect(b.lines).toEqual([])
  })
  it('批过:setup 运行中 / 已就绪 / 失败 · 端口;运行 ⇄ 停下', () => {
    expect(scriptsBlock({ ...WT, approved: true, setup: 'running', run: 'queued', port: 47100, lastLines: ['bun i'] }, 'zh-Hans')).toEqual({ status: '工作区脚本：setup 运行中 · setup 跑完就运行 · 端口 47100', button: 'stop', note: null, lines: ['bun i'] })
    expect(scriptsBlock({ ...WT, approved: true, setup: 'done', run: 'idle', port: 47100 }, 'zh-Hans')).toEqual({ status: '工作区脚本：已就绪 · 端口 47100', button: 'run', note: null, lines: [] })
    expect(scriptsBlock({ ...WT, approved: true, setup: 'failed', run: 'idle', lastLines: ['error'] }, 'zh-Hans')).toMatchObject({ status: '工作区脚本：setup 失败', button: 'run', lines: ['error'] })
    expect(scriptsBlock({ ...WT, approved: true, setup: 'done', run: 'running', port: 47100, lastLines: ['ready'] }, 'en')).toEqual({ status: 'Workspace scripts: running · port 47100', button: 'stop', note: null, lines: ['ready'] })
  })
  it('只有 setup(没有 run 脚本)⇒ 没有按钮', () => {
    expect(scriptsBlock({ ...WT, approved: true, setup: 'done', run: 'none' }, 'zh-Hans')?.button).toBeNull()
  })
  it('认不得的状态不说成就绪,也不给按钮;在跑时没批也能停', () => {
    const b = scriptsBlock({ ...WT, approved: true, setup: 'someday', run: 'someday' }, 'zh-Hans')!
    expect(b.status).toBe('工作区脚本');expect(b.button).toBeNull()
    expect(scriptsBlock({ ...WT, approved: false, setup: 'done', run: 'running' }, 'zh-Hans')?.button).toBe('stop')
  })
  it('输出至多几行', () => {
    const lastLines = Array.from({ length: 20 }, (_, i) => `l${i}`)
    expect(scriptsBlock({ ...WT, approved: true, setup: 'done', run: 'running', lastLines }, 'zh-Hans')!.lines).toEqual(lastLines.slice(-SCRIPT_LINES_SHOWN))
  })
})

describe('点完之后那一句', () => {
  it('成功只照电脑回的状态说;停下说正在停', () => {
    expect(scriptOutcome('run', 'ok', { run: 'running' }, 'zh-Hans')).toBe('已开始运行。')
    expect(scriptOutcome('run', 'ok', { run: 'queued' }, 'zh-Hans')).toBe('setup 还在跑，跑完会接着运行。')
    expect(scriptOutcome('run', 'ok', { run: 'idle' }, 'zh-Hans')).toBe('电脑收到了，状态稍后更新。')
    expect(scriptOutcome('stop', 'ok', {}, 'zh-Hans')).toBe('正在停下，几秒内会更新。')
  })
  it('超时 ⇒ 不说成了;没批 / 在跑 / 没有 run / 收尾中各有一句', () => {
    expect(scriptOutcome('run', { error: 'uncertain' }, null, 'zh-Hans')).toBe('不确定电脑收到没有，过一会儿看看状态。')
    expect(scriptOutcome('run', { error: 'scripts_unapproved' }, null, 'zh-Hans')).toBe('请先在电脑上确认一次这个仓库的脚本')
    expect(scriptOutcome('run', { error: 'script_running' }, null, 'zh-Hans')).toBe('已经在运行了。')
    expect(scriptOutcome('run', { error: 'script_queued' }, null, 'zh-Hans')).toBe('setup 还在跑，跑完会接着运行。')
    expect(scriptOutcome('run', { error: 'no_scripts' }, null, 'zh-Hans')).toBe('这个工作区的 tendhearth.json 里没有 run 脚本。')
    expect(scriptOutcome('run', { error: 'busy' }, null, 'zh-Hans')).toBe('工作区正在收尾，稍后再试。')
    expect(scriptOutcome('run', { error: 'offline' }, null, 'en')).toBe("Didn't work. Try again later, or check on your computer.")
  })
})
