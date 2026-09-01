import { describe, it, expect, vi } from 'vitest'
import { openDb } from '../lib/db'
import { makePledgeStore } from './social-pledge-store'
import { makeEchoRetry } from './social-echo-retry'

function fixture(postEcho: any) {
  const db = openDb({ path: ':memory:' })
  const pledgeStore = makePledgeStore(db)
  const logs: string[] = []
  const retry = makeEchoRetry({ pledgeStore, postEcho, log: (_t, l) => logs.push(l) })
  return { pledgeStore, retry, logs }
}

// 2026-09-01:答话的一方 match:'yes' 之后建 pledge 行、发明信片。发失败时
// 只有一行日志(而在信箱腿上连那行都不会打 —— 见 social-post-seam.ts),
// 没有任何人会再发一次。求助的一方于是什么都收不到,答话的一方却留着
// pledge 行以为自己回过了。和揭晓那个 bug 是同一个病:投递失败没人补。
describe('makeEchoRetry —— 明信片没送到就得补', () => {
  it('把「记了要发、但没送到」的明信片重发一遍,成功的标记已送达', async () => {
    const post = vi.fn<any>(async () => true)
    const { pledgeStore, retry } = fixture(post)
    pledgeStore.create({ id: 'i1:cca', intentId: 'i1', seekerAgentId: 'cca', topic: 't' })
    pledgeStore.setPendingEcho('i1:cca', '我认识一位在鼓楼修相机的师傅', 1, new Date().toISOString())

    expect(await retry.retryUndeliveredEchoes()).toBe(1)
    expect(post).toHaveBeenCalledWith('cca', { intent_id: 'i1', echo: { blurb: '我认识一位在鼓楼修相机的师傅', degree: 1 } })
    expect(pledgeStore.get('i1:cca')!.echo_delivered_at).not.toBeNull()

    // 补过就安静了
    post.mockClear()
    expect(await retry.retryUndeliveredEchoes()).toBe(0)
    expect(post).not.toHaveBeenCalled()
  })

  it('还是发不出去就不标记,下一拍再来', async () => {
    const post = vi.fn<any>(async () => false)
    const { pledgeStore, retry } = fixture(post)
    pledgeStore.create({ id: 'i1:cca', intentId: 'i1', seekerAgentId: 'cca', topic: 't' })
    pledgeStore.setPendingEcho('i1:cca', 'b', 1, new Date().toISOString())

    expect(await retry.retryUndeliveredEchoes()).toBe(0)
    expect(pledgeStore.get('i1:cca')!.echo_delivered_at).toBeNull()
    expect(await retry.retryUndeliveredEchoes()).toBe(0)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('没记过明信片的 pledge 不碰(judge 说 no 的、或历史行)', async () => {
    const post = vi.fn<any>(async () => true)
    const { pledgeStore, retry } = fixture(post)
    pledgeStore.create({ id: 'i2:cca', intentId: 'i2', seekerAgentId: 'cca', topic: 't' })

    expect(await retry.retryUndeliveredEchoes()).toBe(0)
    expect(post).not.toHaveBeenCalled()
  })

  it('超过 14 天的不再自动补 —— 与揭晓补投同一条 no-retry-storm 界', async () => {
    const post = vi.fn<any>(async () => true)
    const { pledgeStore, retry } = fixture(post)
    pledgeStore.create({ id: 'i3:cca', intentId: 'i3', seekerAgentId: 'cca', topic: 't' })
    // 排队时刻由调用方给(与 setSelfRevealed 同一姿态),测试直接给个老的
    pledgeStore.setPendingEcho('i3:cca', 'b', 1, new Date(Date.now() - 15 * 864e5).toISOString())

    expect(await retry.retryUndeliveredEchoes()).toBe(0)
    expect(post).not.toHaveBeenCalled()
  })
})
