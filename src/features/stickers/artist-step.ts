/**
 * 贴纸交给陪伴自省那一拍的一步(「陪伴候选」贡献点 IntrospectStep,ports/companion-contributions.ts)——
 * 从 daemon/wiring/introspect-steps.ts 原样搬来(架构终态 A5);登记表仍在 daemon/wiring/tick-bodies.ts,排第一。
 */
import { ccActsFor } from '../../adapters/store/cc-acts'
import { loadCompanionConfig } from '../../lib/companion-config'
import type { IntrospectStep } from '../../ports/companion-contributions'
import type { SpeechPolicy } from '../../daemon/speech/policy'
import type { StickerLib } from './stickers'

/** 这一步要的(陪伴的 TickDeps 结构上就满足;跑的时候现读,跟搬家前一样)。 */
export interface StickerArtistStepDeps {
  stateDir: string
  /** 表情库;没接 ⇒ 这一步什么都不做。 */
  stickers?: StickerLib
  speech?: SpeechPolicy
  log: (tag: string, line: string) => void
  /** 有库 ⇒ 记「贴纸」那件事的轮(M5b,CC 自己做的事)。 */
  db?: import('../../lib/db').Db
}

/**
 * 新贴纸那一句(觅食式表情生长)改走 SpeechPolicy(第三批 3a):别烦我 / 免打扰 / 都送不到由门判;
 * 图跟字走同一条路(微信发文件、App 记表情引用)。图发不出去 ⇒ 什么都不说,**不退成一句光秃秃的文字**(整合者评审)。
 * 被推后(免打扰 / 都送不到)⇒ 交给门的「待说」队列,**6 小时内**过了免打扰再说(S2c,主人 11-04;kinds.ts 的 keepMs),
 * 图和字一起补;过期了就不说了(贴纸已经在库里,照样会用到)。被拒(别烦我)⇒ 不说、不补。
 */
export async function announceNewSticker(
  d: { speech?: SpeechPolicy; stickers: { resolve(tag: string): string | null }; log: (tag: string, line: string) => void },
  ownerChat: string,
  mood: string,
): Promise<'sent' | 'undeliverable' | 'deferred' | 'dropped' | 'skipped'> {
  if (!d.speech) { d.log('STICKERS', 'new-sticker notice skipped: speech policy not wired'); return 'skipped' }
  const path = d.stickers.resolve(mood)
  if (!path) { d.log('STICKERS', `new-sticker notice skipped: no file for mood=${mood}`); return 'skipped' }
  let sent = false
  const text = newStickerLine(mood)
  const outcome = await d.speech.propose({ source: 'sticker', summary: text, ref: `sticker:${ownerChat}:${path}`, validate: () => d.stickers.resolve(mood) === path, payloadRef: { mood, path }, kind: 'sticker', chatId: ownerChat }, async (turn) => {
    if (!(await turn.sendSticker(ownerChat, mood, path))) { d.log('STICKERS', `new-sticker notice not sent: sticker undeliverable (mood=${mood})`); return }
    sent = true
    await turn.sendText(ownerChat, text)
  })
  if ('defer' in outcome) {
    const kept = d.speech.keep({ kind: 'sticker', chatId: ownerChat, text, attach: { sticker: { mood, path } } })
    d.log('STICKERS', `new-sticker notice deferred: ${outcome.reason}${kept ? ' — kept to say later (6h)' : ''}`)
    return 'deferred'
  }
  if (!('allow' in outcome)) { d.log('STICKERS', `new-sticker notice dropped: ${outcome.reason}`); return 'dropped' }
  return sent ? 'sent' : 'undeliverable'
}

/** 新贴纸那一句(当时说、补说都是这一句)。 */
export const newStickerLine = (mood: string): string => `我画了张新表情!以后想说「${mood}」的时候就用它~`

/**
 * 觅食式表情生长 (2026-08-25) — once a day CC draws itself a sticker for
 * a mood the library doesn't cover yet, and announces it like a small
 * gift. Self-gating (22h marker + pool exhaustion) and every failure
 * mode non-fatal — see artist.ts.
 */
export function stickerArtistStep(deps: StickerArtistStepDeps): IntrospectStep {
  return {
    id: 'sticker-artist', logTag: 'STICKERS', failLabel: 'artist step',
    async run({ sdkEval }) {
      if (!(deps.stickers && sdkEval)) return
      const { runStickerArtist } = await import('./artist')
      const ownerChat = loadCompanionConfig(deps.stateDir).default_chat_id
      await runStickerArtist({
        stateDir: deps.stateDir,
        lib: deps.stickers,
        cheapEval: sdkEval,
        log: (t, l) => deps.log(t, l),
        notify: (mood) => ownerChat ? announceNewSticker({ speech: deps.speech, stickers: deps.stickers!, log: deps.log }, ownerChat, mood) : Promise.resolve('skipped'),
        ...(deps.db ? { acts: ccActsFor(deps.db, deps.log) } : {}),
      })
    },
  }
}
