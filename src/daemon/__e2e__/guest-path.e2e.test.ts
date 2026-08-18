// End-to-end acceptance test for the guest path (spec
// docs/superpowers/specs/2026-08-18-guest-path-design.md §6) — request +
// approve, request + deny, and invite-code direct-entry. This is the
// "the share path is live" smoke alarm: a friend a chat's owner shares the
// bot with, who previously either got silently dropped by mw-access or had
// to be hand-added to access.json from a terminal, can now reach a real
// conversation with nothing but WeChat and the owner's own phone.
//
// ONE daemon, ONE it(), four sequential phases (① request+notify,
// ② approve→onboarding→echo, ③ deny→silence, ④ invite single-use) — same
// convention as user-tier.e2e.test.ts: access.ts's module-level STATE_DIR
// (and its in-process loadAccess() cache/invalidator) are frozen/shared at
// first import, so splitting phases into separate it() blocks would need
// either a fresh process per phase or an invasive module-graph reset. The
// guest-requests.json store is ALSO deliberately stateful across phases —
// different stranger chatIds per phase keep ①-④ independent of each other
// while still exercising the SAME long-lived store an admin would use for
// real across many days.
//
// access is seeded EXPLICITLY: admins:['testadmin'], allowFrom:['testadmin']
// ONLY. The harness DEFAULT allowFrom is ['*'] (wide open) — leaving it at
// the default would make every "stranger" chat already allowlisted and skip
// the guest branch in mw-access entirely, testing nothing. testadmin must
// ALSO be pre-known (knownUsers) so its guest commands (允许/拒绝/邀请码/
// 待批准) reach the dispatch seam in pipeline-deps.ts instead of tripping
// mw-onboarding's "who are you, what should I call you" greeting first.
import { describe, it, expect } from 'vitest'
import { startTestDaemon } from './harness'
import type { OutboundMsg } from './fake-ilink-server'

const NEUTRAL_REPLY = '我需要主人确认一下,稍等哦~'
const INVITE_WELCOME = '主人邀请你来的吧,欢迎!直接跟我说话就行~'

function toAdmin(msgs: readonly OutboundMsg[]): OutboundMsg[] {
  return msgs.filter(m => m.chatId === 'testadmin' && m.endpoint === 'sendmessage')
}

function ownerNotifyCount(msgs: readonly OutboundMsg[]): number {
  return toAdmin(msgs).filter(m => (m.text ?? '').includes('👋')).length
}

function outboundCount(msgs: readonly OutboundMsg[], chatId: string): number {
  return msgs.filter(m => m.chatId === chatId && m.endpoint === 'sendmessage').length
}

// waitForReplyTo's predicate is `msgs.some(...)` but it resolves with the
// WHOLE outbox snapshot (every chat, including the 'typing' indicator
// entries interleaved by mw-typing) — `.at(-1)` on that is NOT "the reply to
// this chat", it's whatever landed last across every chat/endpoint. Find the
// actual reply explicitly instead.
function replyTextTo(msgs: readonly OutboundMsg[], chatId: string): string | undefined {
  return msgs.find(m => m.chatId === chatId && m.endpoint === 'sendmessage')?.text
}

describe('e2e: guest path — request/approve/deny/invite', () => {
  it('four scenarios: neutral-reply+single-notify, approve+onboarding-echo, deny+silence, invite single-use', async () => {
    const dispatchedTexts: string[] = []
    // Distinct createTimeMs per send, even across sequential sendText calls
    // in the same test tick — guest-requests.seenMessage() dedupes on
    // inboundMessageId(userId, createTimeMs), so two genuinely-different
    // messages from the SAME stranger landing in the same millisecond would
    // collide there and get dropped for the wrong reason (redelivery guard,
    // not the "single notify" behavior this test is actually pinning).
    let ts = Date.now()
    const nextTs = () => (ts += 1000)

    const daemon = await startTestDaemon({
      dangerously: true,
      access: { admins: ['testadmin'], allowFrom: ['testadmin'] },
      knownUsers: { testadmin: 'testadmin' },
      claudeScript: {
        async onDispatch(t) {
          dispatchedTexts.push(t)
          return { toolCalls: [], finalText: '@user 好嘞' }
        },
      },
    })

    try {
      // ── ⓪ warm-up: testadmin must send at least one message before it can
      // RECEIVE one — ilink's sendMessage requires a cached context_token,
      // captured only from an inbound FROM that chat (mw-capture-ctx). The
      // harness never fabricates one for a chat that hasn't spoken yet, so
      // without this the very first owner notify below fails to send (logged,
      // not thrown — mw-access degrades to "will retry next message" — but
      // that would make the "single notify" assertion pass for the wrong
      // reason). Doubles as a sanity check: no pending requests yet. ─────
      daemon.sendText('testadmin', '待批准', { createTimeMs: nextTs() })
      const warmup = await daemon.waitForOutbound(
        msgs => toAdmin(msgs).some(m => (m.text ?? '') === '目前没有待批准的请求。'),
        8000,
      )
      expect(toAdmin(warmup).some(m => m.text === '目前没有待批准的请求。')).toBe(true)

      // ── ① stranger's first message → neutral reply to the stranger,
      // single owner notify carrying a 6-digit code ──────────────────────
      daemon.sendText('stranger1', '帮我查天气', { createTimeMs: nextTs() })
      const neutral1 = await daemon.waitForReplyTo('stranger1', 8000)
      expect(replyTextTo(neutral1, 'stranger1')).toBe(NEUTRAL_REPLY)

      const notified1 = await daemon.waitForOutbound(msgs => ownerNotifyCount(msgs) >= 1, 8000)
      const notifyText1 = toAdmin(notified1).find(m => (m.text ?? '').includes('stranger1'))?.text ?? ''
      expect(notifyText1).toContain('stranger1')
      const code1 = notifyText1.match(/允许\s+(\d{6})/)?.[1]
      expect(code1).toBeTruthy()

      // stranger1's SECOND message → no second notify. Force ordering via a
      // deterministic admin round-trip instead of an arbitrary sleep — the
      // poll loop drains enqueued inbounds in order, so by the time 待批准's
      // reply lands, stranger1's second message has already been fully
      // handled (access-gate-drop.e2e.test.ts's convention).
      daemon.sendText('stranger1', '还在吗', { createTimeMs: nextTs() })
      daemon.sendText('testadmin', '待批准', { createTimeMs: nextTs() })
      const pendingReply1 = await daemon.waitForOutbound(
        msgs => toAdmin(msgs).some(m => (m.text ?? '').includes(code1!)),
        8000,
      )
      expect(ownerNotifyCount(pendingReply1)).toBe(1)

      // ── ② testadmin approves → owner gets ✅, guest gets the welcome
      // line + onboarding's "what should I call you" greeting; the
      // guest's nickname reply echoes their ORIGINAL question back through
      // the (fake) provider ─────────────────────────────────────────────
      daemon.sendText('testadmin', `允许 ${code1}`, { createTimeMs: nextTs() })
      const approveAck = await daemon.waitForOutbound(
        msgs => toAdmin(msgs).some(m => (m.text ?? '') === '✅ 已允许 stranger1'),
        8000,
      )
      expect(toAdmin(approveAck).some(m => m.text === '✅ 已允许 stranger1')).toBe(true)

      const greet1 = await daemon.waitForOutbound(
        msgs => msgs.some(m => m.chatId === 'stranger1' && (m.text ?? '').includes('称呼你')),
        8000,
      )
      expect(greet1.some(m => m.chatId === 'stranger1' && m.text === '主人同意啦!')).toBe(true)
      expect(greet1.some(m => m.chatId === 'stranger1' && (m.text ?? '').includes('称呼你'))).toBe(true)

      daemon.sendText('stranger1', '丸子', { createTimeMs: nextTs() })
      const ack1 = await daemon.waitForOutbound(
        msgs => msgs.some(m => m.chatId === 'stranger1' && (m.text ?? '').includes('刚才你说')),
        8000,
      )
      const ackText1 = ack1.find(m => m.chatId === 'stranger1' && (m.text ?? '').includes('刚才你说'))?.text ?? ''
      expect(ackText1).toContain('帮我查天气')

      // Falsification-grade (same posture as onboarding-restart.e2e.test.ts):
      // the fake PROVIDER actually saw the original question, not just that
      // some onboarding-shaped text landed in the outbox.
      const dispatchDeadline = Date.now() + 3000
      while (!dispatchedTexts.some(t => t.includes('帮我查天气')) && Date.now() < dispatchDeadline) {
        await new Promise(r => setTimeout(r, 50))
      }
      expect(dispatchedTexts.some(t => t.includes('帮我查天气'))).toBe(true)

      // ── ③ a second, unrelated stranger — denied ─────────────────────
      daemon.sendText('stranger2', '有人吗', { createTimeMs: nextTs() })
      const neutral2 = await daemon.waitForReplyTo('stranger2', 8000)
      expect(replyTextTo(neutral2, 'stranger2')).toBe(NEUTRAL_REPLY)

      const notified2 = await daemon.waitForOutbound(
        msgs => toAdmin(msgs).some(m => (m.text ?? '').includes('stranger2')),
        8000,
      )
      const notifyText2 = toAdmin(notified2).find(m => (m.text ?? '').includes('stranger2'))?.text ?? ''
      const code2 = notifyText2.match(/允许\s+(\d{6})/)?.[1]
      expect(code2).toBeTruthy()

      daemon.sendText('testadmin', `拒绝 ${code2}`, { createTimeMs: nextTs() })
      const denyAck = await daemon.waitForOutbound(
        msgs => toAdmin(msgs).some(m => (m.text ?? '') === '已拒绝,ta 不会再打扰你。'),
        8000,
      )
      expect(toAdmin(denyAck).some(m => m.text === '已拒绝,ta 不会再打扰你。')).toBe(true)

      // The guest gets NOTHING on top of the original neutral reply — ever.
      expect(outboundCount(daemon.ilink.outbox(), 'stranger2')).toBe(1)

      // Further messages from stranger2 produce no new notify and no reply
      // — same ordering trick as ①, this time syncing on 「待批准」 reporting
      // no pending requests at all (denied entries are excluded).
      daemon.sendText('stranger2', '还在吗', { createTimeMs: nextTs() })
      daemon.sendText('testadmin', '待批准', { createTimeMs: nextTs() })
      const pendingReply2 = await daemon.waitForOutbound(
        msgs => toAdmin(msgs).some(m => (m.text ?? '') === '目前没有待批准的请求。'),
        8000,
      )
      expect(toAdmin(pendingReply2).some(m => m.text === '目前没有待批准的请求。')).toBe(true)
      expect(outboundCount(daemon.ilink.outbox(), 'stranger2')).toBe(1)

      // ── ④ invite code: testadmin mints one, a third stranger spends it
      // directly (no request/approve round-trip), a FOURTH stranger with
      // the SAME (already-consumed) code falls into the ordinary request
      // flow instead of getting a free pass — single-use, pinned ────────
      daemon.sendText('testadmin', '邀请码', { createTimeMs: nextTs() })
      const inviteReply = await daemon.waitForOutbound(
        msgs => toAdmin(msgs).some(m => (m.text ?? '').includes('邀请码:')),
        8000,
      )
      const inviteText = toAdmin(inviteReply).find(m => (m.text ?? '').includes('邀请码:'))?.text ?? ''
      const inviteCode = inviteText.match(/邀请码:(\d{6})/)?.[1]
      expect(inviteCode).toBeTruthy()

      daemon.sendText('stranger3', inviteCode!, { createTimeMs: nextTs() })
      const welcome3 = await daemon.waitForReplyTo('stranger3', 8000)
      expect(replyTextTo(welcome3, 'stranger3')).toBe(INVITE_WELCOME)

      // Guest's NEXT message proceeds normally — onboarding greets first
      // (stranger3 is allowlisted now but still an unknown user), which is
      // the expected shape, not a bug: the flow continuing at all is what's
      // under test here.
      daemon.sendText('stranger3', '你好', { createTimeMs: nextTs() })
      const greet3 = await daemon.waitForOutbound(
        msgs => msgs.some(m => m.chatId === 'stranger3' && (m.text ?? '').includes('称呼你')),
        8000,
      )
      expect(greet3.some(m => m.chatId === 'stranger3' && (m.text ?? '').includes('称呼你'))).toBe(true)

      daemon.sendText('stranger4', inviteCode!, { createTimeMs: nextTs() })
      const neutral4 = await daemon.waitForReplyTo('stranger4', 8000)
      expect(replyTextTo(neutral4, 'stranger4')).toBe(NEUTRAL_REPLY)   // NOT the invite welcome — code already spent

      const notified4 = await daemon.waitForOutbound(
        msgs => toAdmin(msgs).some(m => (m.text ?? '').includes('stranger4')),
        8000,
      )
      expect(toAdmin(notified4).some(m => (m.text ?? '').includes('stranger4'))).toBe(true)
    } finally {
      // Belt-and-braces — access.ts's loadAccess() cache + invalidator are
      // process-global (user-tier.e2e.test.ts's convention). This test's
      // multiple appendAllowFrom writes must not leak into a sibling e2e
      // test file sharing the same worker process.
      try {
        const access = await import('../../lib/access')
        access._clearCache()
        access._resetSnapshotForTest()
      } catch { /* module not yet imported — nothing to reset */ }
      await daemon.stop()
    }
  }, 30000)
})
