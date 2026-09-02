import { describe, it, expect } from 'vitest'
import { peerMailboxOf, chooseTransport } from './mailbox-dispatch-seam'
import type { A2AAgentRecord } from '../../lib/agent-config'

const base = {
  id: 'cc-peer', name: 'peer', inbound_api_key: 'x'.repeat(16), outbound_api_key: 'y',
  capabilities: [] as string[], paused: false,
}

const mailboxCoords = {
  mailbox_addr: 'MCowBQYDK2VwAyEAaaaa',
  mailbox_enc_pub: 'MCowBQYDK2VuAyEAbbbb',
  relays: ['https://cc.tendhearth.com/mailbox'],
}

describe('chooseTransport', () => {
  /**
   * WHY(2026-09-01,Mac↔Windows 真机闭环的最后一程死在这里):
   * wire-social.ts 里有**两套互相矛盾的传输选择规则**。
   * - postToHand(心愿/回声):先看 peerMailboxOf,信箱优先,注释标着
   *   「spec §1 selection rule」
   * - postPeerReveal(揭晓):`if (!hand.url)` 才走信箱,url 优先
   *
   * 六位配对码建立的对端**永远是 transport:'mailbox'**,但配对卡片里可能
   * 带着一个 url。于是同一个对端:心愿到了、回声到了、揭晓 peer_unreachable。
   * 症状极其难读 —— 链路明明通着,偏偏最后一步不通。
   *
   * 修法是抽成这一个纯函数,两处共用:**让两套规则在结构上无法再分叉**,
   * 而不只是把今天这一处对齐。
   */
  it('transport 声明为 mailbox 时,即使记录里有 url 也走信箱', () => {
    const hand = { ...base, transport: 'mailbox', url: 'http://127.0.0.1:8790', ...mailboxCoords } satisfies A2AAgentRecord
    expect(chooseTransport(hand)).toEqual({ kind: 'mailbox', peer: peerMailboxOf(hand)! })
  })

  it('mailbox 坐标不全时回落 url —— 声明了信箱却没坐标,不能变成不可达', () => {
    const hand = { ...base, transport: 'mailbox', url: 'https://peer.example' } satisfies A2AAgentRecord
    expect(chooseTransport(hand)).toEqual({ kind: 'push', url: 'https://peer.example' })
  })

  it('push 对端走 url', () => {
    const hand = { ...base, transport: 'push', url: 'https://peer.example' } satisfies A2AAgentRecord
    expect(chooseTransport(hand)).toEqual({ kind: 'push', url: 'https://peer.example' })
  })

  it('既无 url 又无完整信箱坐标 ⇒ 真的不可达', () => {
    const hand = { ...base, transport: 'push' } satisfies A2AAgentRecord
    expect(chooseTransport(hand)).toEqual({ kind: 'unreachable' })
  })
})
