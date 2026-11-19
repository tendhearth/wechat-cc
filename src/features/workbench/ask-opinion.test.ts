import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASK_OPINION_DELAY_MS, ASK_OPINION_TIMEOUT_MS, UNVERIFIED_CLAIMS, makeAskOpinion } from './ask-opinion'
import type { PermissionAsk } from '../../domain/permission-rules/types'
import type { CheapEval } from '../../ports/agent-provider'

const MIN = 60_000
const answer = { say: true, opinion: '允许。这次只读本地的文件。', reason: '执行者需要读取权限' }
const raw = JSON.stringify(answer)
const note = { ccOpinion: answer.opinion, questionReason: answer.reason }
const pending = (override: Partial<PermissionAsk> = {}) => ({
  kind: 'permission' as const, project: '/projects/Archive', title: '整理备份',
  ask: { surface: 'workbench', provider: 'codex', tool: 'Bash', command: 'git status', cwd: null, project: '/projects/Archive', isolatedWorktree: false, tier: 'admin', scope: 'task-1', ...override } satisfies PermissionAsk,
  preview: { command: 'API_TOKEN="synthetic-token" cat "/private/synthetic name"', authorization: 'synthetic-secret', paths: ['/private/synthetic-name with spaces'] },
})
const tick = () => vi.advanceTimersByTimeAsync(ASK_OPINION_DELAY_MS)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 18, 12))
})
afterEach(() => { vi.useRealTimers() })

it('两秒后才问，跨过默认间隔边界才问下一条普通请求', async () => {
  const model = vi.fn(async () => raw)
  const opinions = makeAskOpinion({ evaluator: () => model })
  opinions.schedule('first', pending)
  expect(opinions.get('first')).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1_999)
  expect(model).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(opinions.get('first')).toEqual(note)
  const first = Date.now()

  opinions.schedule('too-soon', pending)
  await tick()
  expect(model).toHaveBeenCalledTimes(1)
  vi.setSystemTime(first + 15 * MIN - ASK_OPINION_DELAY_MS)
  opinions.schedule('on-time', pending)
  await tick()
  expect(model).toHaveBeenCalledTimes(2)
  expect(opinions.get('too-soon')).toBeUndefined()
})

it('重的事跳过间隔，仍受每日上限，本地跨日恢复', async () => {
  const model = vi.fn(async () => raw)
  const opinions = makeAskOpinion({ evaluator: () => model, settings: () => ({ daily_limit: 2 }) })
  opinions.schedule('read', pending)
  await tick()
  const deleteFile = () => pending({ command: 'rm old.tar' })
  opinions.schedule('delete', deleteFile)
  await tick()
  opinions.schedule('over-cap', deleteFile)
  await tick()
  expect(model).toHaveBeenCalledTimes(2)
  expect(opinions.get('over-cap')).toBeUndefined()
  vi.setSystemTime(new Date(2026, 10, 19))
  opinions.schedule('new-day', deleteFile)
  await tick()
  expect(model).toHaveBeenCalledTimes(3)
})

it.each<Partial<PermissionAsk>>([
  { tool: 'commandExecution', command: 'git push' },
  { tool: 'commandExecution', command: 'cat ~/Library/Messages/chat.db' },
  { tool: 'Read', command: undefined, paths: ['/private/other/file.txt'] },
  { tool: 'Write', command: undefined, paths: ['../other/file.txt'] },
  { tool: 'mcp__wechat__message', command: undefined },
])('现有红线、项目范围和工具分类可越过间隔 %j', async override => {
  const model = vi.fn(async () => raw)
  const opinions = makeAskOpinion({ evaluator: () => model })
  opinions.schedule('read', pending)
  await tick()
  opinions.schedule('heavy', () => pending(override))
  await tick()
  expect(model).toHaveBeenCalledTimes(2)
})

it('默认本地日上限为十条，且同一时刻只发一次判断', async () => {
  const model = vi.fn(async () => raw)
  const opinions = makeAskOpinion({ evaluator: () => model })
  const heavy = () => pending({ command: 'rm old.tar' })
  for (let i = 0; i < 11; i++) {
    opinions.schedule(String(i), heavy)
    opinions.schedule('parallel-' + i, heavy)
    await tick()
  }
  expect(model).toHaveBeenCalledTimes(10)
})

it('失败从一分钟起指数退避，包括重的事', async () => {
  const model = vi.fn(async () => { throw new Error('synthetic failure') })
  const opinions = makeAskOpinion({ evaluator: () => model })
  const heavy = () => pending({ command: 'rm old.tar' })
  opinions.schedule('first', pending)
  await tick()
  const first = Date.now()
  opinions.schedule('within-first', heavy)
  await tick()
  vi.setSystemTime(first + MIN - ASK_OPINION_DELAY_MS)
  opinions.schedule('second', heavy)
  await tick()
  const second = Date.now()
  vi.setSystemTime(second + MIN)
  opinions.schedule('within-second', heavy)
  await tick()
  expect(model).toHaveBeenCalledTimes(2)
  vi.setSystemTime(second + 2 * MIN - ASK_OPINION_DELAY_MS)
  opinions.schedule('third', heavy)
  await tick()
  expect(model).toHaveBeenCalledTimes(3)
})

it('设置可关闭意见，且无模型、两秒内已答都没有模型调用', async () => {
  const model = vi.fn(async () => raw)
  const evaluator = vi.fn<() => CheapEval | null>().mockReturnValue(null)
  const opinions = makeAskOpinion({ evaluator })
  opinions.schedule('no-model', pending)
  await tick()
  expect(opinions.get('no-model')).toBeUndefined()
  evaluator.mockReturnValue(model)
  opinions.schedule('answered', pending)
  await vi.advanceTimersByTimeAsync(1_999)
  opinions.clear('answered')
  await tick()
  opinions.schedule('vanished', () => null)
  await tick()
  expect(evaluator).toHaveBeenCalledTimes(1)
  expect(model).not.toHaveBeenCalled()

  const off = makeAskOpinion({ evaluator, settings: () => ({ daily_limit: 0 }) })
  off.schedule('off', pending)
  await tick()
  expect(evaluator).toHaveBeenCalledTimes(1)
})

it('只把打码后的请求资料发给模型，日志只含结果和长度', async () => {
  const model = vi.fn(async (_prompt: string) => raw)
  const log = vi.fn()
  const opinions = makeAskOpinion({ evaluator: () => model, log })
  opinions.schedule('first', pending)
  await tick()
  const data = JSON.parse(model.mock.calls[0]![0].split('\n').at(-1)!)
  expect(data).toMatchObject({ kind: 'permission', tool: 'Bash', place: 'Archive' })
  expect(data).not.toHaveProperty('title')
  expect(data.preview).toContain('[credential omitted]')
  expect(data.preview).toContain('[路径已打码]')
  expect(data.preview).not.toMatch(/synthetic-secret|synthetic-name|synthetic-token|synthetic name|with spaces/)
  expect(log.mock.calls).toEqual([['ASK_OPINION', `given opinionLength=${answer.opinion.length} reasonLength=${answer.reason.length}`]])
  opinions.clear('first')
  expect(opinions.get('first')).toBeUndefined()
})

describe('不显示不合规回答', () => {
  it.each([
    ['不想说', '{"say":false,"opinion":"","reason":""}'],
    ['坏 JSON', 'not JSON'],
    ['多余字段', JSON.stringify({ ...answer, extra: true })],
    ['意见超长', JSON.stringify({ ...answer, opinion: '先别。'.repeat(20) })],
    ['缘由超长', JSON.stringify({ ...answer, reason: '保留档案避免遗漏。'.repeat(6) })],
    ['只有立场', JSON.stringify({ ...answer, opinion: '允许。' })],
    ['没立场', JSON.stringify({ ...answer, opinion: '这是只读操作。' })],
    ['工具名', JSON.stringify({ ...answer, reason: '需要 Bash 权限' })],
    ['编号', JSON.stringify({ ...answer, reason: '涉及 req-1234' })],
    ['绝对路径', JSON.stringify({ ...answer, reason: '需要读取 /tmp/report' })],
  ])('%s', async (_label, result) => {
    const opinions = makeAskOpinion({ evaluator: () => async () => result })
    opinions.schedule('request', pending)
    await tick()
    expect(opinions.get('request')).toBeUndefined()
  })

  it.each(UNVERIFIED_CLAIMS)('词表拦住 %s', async word => {
    const log = vi.fn()
    const opinions = makeAskOpinion({ evaluator: () => async () => JSON.stringify({ ...answer, reason: word }), log })
    opinions.schedule('request', pending)
    await tick()
    expect(opinions.get('request')).toBeUndefined()
    expect(log).toHaveBeenCalledWith('ASK_OPINION', expect.stringMatching(/^blocked_words opinionLength=\d+ reasonLength=\d+$/))
  })
})

it('超时、回答后才返回以及过期都不会留记录', async () => {
  let finish!: (text: string) => void
  const model = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
  const opinions = makeAskOpinion({ evaluator: () => model })
  opinions.schedule('timeout', pending)
  await tick()
  await vi.advanceTimersByTimeAsync(ASK_OPINION_TIMEOUT_MS)
  finish(raw)
  expect(opinions.get('timeout')).toBeUndefined()
  await vi.advanceTimersByTimeAsync(MIN)
  opinions.schedule('answered', pending)
  await tick()
  opinions.clear('answered')
  finish(raw)
  await vi.advanceTimersByTimeAsync(0)
  expect(opinions.get('answered')).toBeUndefined()
  opinions.schedule('expires', pending)
  await tick()
  finish(raw)
  await vi.advanceTimersByTimeAsync(0)
  expect(opinions.get('expires')).toEqual(note)
  await vi.advanceTimersByTimeAsync(24 * 60 * MIN)
  expect(opinions.get('expires')).toBeUndefined()
})

it('每天的判断预算也计入模型选择不说的请求', async () => {
  const model = vi.fn(async () => '{"say":false,"opinion":"","reason":""}')
  const opinions = makeAskOpinion({ evaluator: () => model, settings: () => ({ daily_limit: 1 }) })
  opinions.schedule('quiet', pending)
  await tick()
  opinions.schedule('second', pending)
  await tick()
  expect(model).toHaveBeenCalledTimes(1)
  expect(opinions.get('quiet')).toBeUndefined()
})

it('重建服务保留当天已发起次数，跨日本地预算恢复', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cc-opinion-budget-'))
  const model = vi.fn()
    .mockResolvedValueOnce(raw)
    .mockRejectedValueOnce(new Error('synthetic failure'))
    .mockResolvedValue(raw)
  const create = () => makeAskOpinion({
    evaluator: () => model, stateDir, settings: () => ({ daily_limit: 2, min_interval_ms: 0 }),
  })
  try {
    const first = create()
    first.schedule('given', pending)
    await tick()
    first.schedule('failed', pending)
    await tick()
    expect(first.get('given')).toEqual(note)
    expect(model).toHaveBeenCalledTimes(2)
    first.dispose()

    const restarted = create()
    restarted.schedule('new-request', pending)
    await tick()
    expect(model).toHaveBeenCalledTimes(2)
    expect(restarted.get('given')).toBeUndefined()
    expect(JSON.parse(readFileSync(join(stateDir, 'ask-opinion-budget.json'), 'utf8')))
      .toEqual({ day: new Date().toDateString(), count: 2 })

    vi.setSystemTime(new Date(2026, 10, 19))
    restarted.schedule('new-day', pending)
    await tick()
    expect(model).toHaveBeenCalledTimes(3)
    restarted.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

it.each([
  '我已经跑过测试', '我跑了一遍', '我试过了', '我看过文件',
  '我们已读完文件', '我刚刚查过了', '我有核对过', '我已经验完了', '我，已经确认了',
  '我已完成测试', '我测完了', '我测试了', '我查看过文件', '我读取了文件', '我刚做了测试', '我已经执行了测试',
])('驳回第一人称核对声明：%s', async claim => {
  const opinions = makeAskOpinion({
    evaluator: () => async () => JSON.stringify({ ...answer, opinion: `允许。${claim}。` }),
  })
  opinions.schedule('request', pending)
  await tick()
  expect(opinions.get('request')).toBeUndefined()
})

it.each(['已运行命令，没有报错', '已跑过测试', '运行了命令', '跑过测试', '命令已执行'])('驳回没有第一人称的执行声明：%s', async claim => {
  const opinions = makeAskOpinion({
    evaluator: () => async () => JSON.stringify({ ...answer, opinion: `允许。${claim}。` }),
  })
  opinions.schedule('request', pending)
  await tick()
  expect(opinions.get('request')).toBeUndefined()
})

it.each([
  '允许。只读取本地改动。', '先别。建议先跑一次测试。', '先问清楚再定。我建议先看文件。',
  '先别。我还没看过文件。', '先别。这条命令会删除备份。',
])('保留基于请求的描述和建议：%s', async opinion => {
  const opinions = makeAskOpinion({ evaluator: () => async () => JSON.stringify({ ...answer, opinion }) })
  opinions.schedule('request', pending)
  await tick()
  expect(opinions.get('request')?.ccOpinion).toBe(opinion)
})
