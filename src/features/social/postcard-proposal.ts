import type { SpeechPolicy } from '../../daemon/speech/policy'

/** Peer actions enqueue the returned story; awaiting this vote would deadlock
 * the picker which is still awaiting the peer action's completion. */
export function queuePostcardProposal(d: {
  speech: SpeechPolicy
  recipient: string
  story: string
  ref?: string
  raster(): Promise<string | null> | string | null
  sendFile?: (chatId: string, path: string) => Promise<unknown>
  log(tag: string, line: string): void
}): void {
  const { speech, recipient: op, story, ref, raster, sendFile } = d
  void (async () => {
    let storySent = false, failed = false
    const o = await speech.propose({ source: 'social', summary: story.slice(0, 1000) || 'A postcard from a visit', ...(ref ? { ref: `social:${ref}` } : {}), payloadRef: { visit: ref ?? null }, kind: 'social_story', chatId: op }, async (outbound) => {
      const png = await raster()
      if (story) {
        storySent = !(await outbound.sendText(op, story)).error
        if (!storySent) { failed = true; return 'failed' }
      }
      if (png) {
        if (outbound.channel() === 'app') await outbound.sendAttachment(op, { kind: 'file', path: png })
        else if (sendFile) { const r = await sendFile(op, png); if (r !== false) outbound.confirmDelivery?.('wechat'); else failed = true }
      }
    })
    if (!storySent && (('defer' in o && o.reason !== 'delivery_unknown') || ('allow' in o && failed))) {
      const png = await raster()
      if ((png || story) && speech.keep({ kind: 'social_story', chatId: op, text: story, ...(png ? { attach: { file: png } } : {}) })) d.log('SOCIAL', `postcard deferred (${'reason' in o ? o.reason : 'send_failed'}) — kept to send later`)
    }
  })().catch(err => d.log('SOCIAL', `postcard proposal failed: ${err instanceof Error ? err.message : String(err)}`))
}
