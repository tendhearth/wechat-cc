/**
 * 贴纸交给陪伴自省那一拍的一步(「陪伴候选」贡献点 IntrospectStep,daemon/companion/contributions.ts)——
 * 从 daemon/wiring/introspect-steps.ts 原样搬来(架构终态 A5);登记表仍在 wiring/tick-bodies.ts,排第一。
 */
import { loadCompanionConfig } from '../../daemon/companion/config'
import type { IntrospectStep } from '../../daemon/companion/contributions'
import type { SpeechPolicy } from '../../daemon/speech/policy'
import type { StickerLib } from './stickers'

/** 这一步要的(陪伴的 TickDeps 结构上就满足;跑的时候现读,跟搬家前一样)。 */
export interface StickerArtistStepDeps {
  stateDir: string
  /** 表情库;没接 ⇒ 这一步什么都不做。 */
  stickers?: StickerLib
  speech?: SpeechPolicy
  log: (tag: string, line: string) => void
}

/**
 * 新贴纸那一句(觅食式表情生长)改走 SpeechPolicy(第三批 3a):别烦我 / 免打扰 / 都送不到由门判;
 * 图跟字走同一条路(微信发文件、App 记表情引用)。图发不出去 ⇒ 什么都不说,**不退成一句光秃秃的文字**(整合者评审)。
 * 贴纸已经在库里了,以后照样会用到;这一句只是「我画了张新的」的小报告,不补发。
 */
export async function announceNewSticker(
  d: { speech?: SpeechPolicy; stickers: { resolve(tag: string): string | null }; log: (tag: string, line: string) => void },
  ownerChat: string,
  mood: string,
): Promise<void> {
  if (!d.speech) { d.log('STICKERS', 'new-sticker notice skipped: speech policy not wired'); return }
  const path = d.stickers.resolve(mood)
  if (!path) { d.log('STICKERS', `new-sticker notice skipped: no file for mood=${mood}`); return }
  const outcome = await d.speech.say({ kind: 'sticker', chatId: ownerChat }, async (turn) => {
    if (!(await turn.sendSticker(ownerChat, mood, path))) { d.log('STICKERS', `new-sticker notice not sent: sticker undeliverable (mood=${mood})`); return }
    await turn.sendText(ownerChat, `我画了张新表情!以后想说「${mood}」的时候就用它~`)
  })
  if (!('allow' in outcome)) d.log('STICKERS', `new-sticker notice ${'defer' in outcome ? 'deferred' : 'dropped'}: ${outcome.reason}`)
}

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
        notify: (mood) => ownerChat ? announceNewSticker({ speech: deps.speech, stickers: deps.stickers!, log: deps.log }, ownerChat, mood) : Promise.resolve(),
      })
    },
  }
}
