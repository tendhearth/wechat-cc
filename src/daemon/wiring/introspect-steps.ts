/**
 * 自省那一拍(每天一次)固定维护之后的几步(从 tick-introspect.ts 原样搬出,A5「陪伴候选」贡献点):
 * 贴纸、小像、记忆园丁、画室。各自门控、各自失败不拖累后面的步;登记在 tick-bodies.ts,顺序就是执行顺序。
 */
import { join } from 'node:path'
import { loadCompanionConfig } from '../companion/config'
import { runGarden } from '../memory/gardener'
import { readJsonFile } from '../../lib/read-json-file'
import type { IntrospectStep } from '../companion/contributions'
import type { TickDeps } from './tick-deps'

/**
 * 新贴纸那一句(觅食式表情生长)改走 SpeechPolicy(第三批 3a):别烦我 / 免打扰 / 都送不到由门判;
 * 图跟字走同一条路(微信发文件、App 记表情引用)。图发不出去 ⇒ 什么都不说,**不退成一句光秃秃的文字**(整合者评审)。
 * 贴纸已经在库里了,以后照样会用到;这一句只是「我画了张新的」的小报告,不补发。
 */
export async function announceNewSticker(
  d: { speech?: import('../speech/policy').SpeechPolicy; stickers: { resolve(tag: string): string | null }; log: (tag: string, line: string) => void },
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
 * mode non-fatal — see sticker-artist.ts.
 */
export function stickerArtistStep(deps: TickDeps): IntrospectStep {
  return {
    id: 'sticker-artist', logTag: 'STICKERS', failLabel: 'artist step',
    async run({ sdkEval }) {
      if (!(deps.stickers && sdkEval)) return
      const { runStickerArtist } = await import('../sticker-artist')
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

/**
 * CC 画的你,慢慢长 (2026-08-27) — 档案比上次画像新且过了最短间隔时,
 * 静默重画小像。自我门控 + 每失败非致命,见 portrait-artist.ts。
 */
export function portraitArtistStep(deps: TickDeps): IntrospectStep {
  return {
    id: 'portrait-artist', logTag: 'PORTRAIT', failLabel: 'artist step',
    async run() {
      if (!deps.generatePortrait) return
      const { runPortraitArtist } = await import('../portrait-artist')
      const { existsSync, statSync } = await import('node:fs')
      const ownerChat = loadCompanionConfig(deps.stateDir).default_chat_id
      if (!ownerChat) return
      const memDir = join(deps.stateDir, 'memory', ownerChat)
      await runPortraitArtist({
        adminChatId: ownerChat,
        generate: deps.generatePortrait,
        portraitGeneratedAt: () => {
          try {
            const j = readJsonFile(join(memDir, 'portrait.json')) as { generated_at?: string }
            return j.generated_at ? Date.parse(j.generated_at) : null
          } catch { return null }
        },
        profileMtime: () => {
          let newest: number | null = null
          for (const f of ['_profile.json', '_overview.md', 'profile.md']) {
            const fp = join(memDir, f)
            if (existsSync(fp)) { const m = statSync(fp).mtimeMs; if (newest === null || m > newest) newest = m }
          }
          return newest
        },
        log: (t, l) => deps.log(t, l),
      })
    },
  }
}

/**
 * Memory gardener — daily curation pass over each chat's freeform memory
 * files (profile.md, preferences.md, notes/*.md). Same resolved sdkEval
 * as the steps before it. See docs/superpowers/specs/2026-07-10-
 * memory-gardener-design.md.
 */
export function memoryGardenStep(deps: TickDeps): IntrospectStep {
  return {
    id: 'memory-garden', logTag: 'GARDEN', failLabel: 'tick',
    async run({ sdkEval, memoryRoot, today }) {
      const { gardened, skipped } = await runGarden({
        memoryRoot,
        archiveRoot: join(deps.stateDir, 'memory-archive'),
        stateFile: join(deps.stateDir, 'garden_state.json'),
        cheapEval: sdkEval,
        log: deps.log,
        today,
      })
      if (gardened > 0 || skipped > 0) {
        deps.log('GARDEN', `tick complete: gardened=${gardened} skipped=${skipped}`)
      }
    },
  }
}

/**
 * CC Atelier is an optional, default-off extension point. Deliberately after
 * introspection/gardening and isolated: no renderer or planner failure may
 * break the existing 24h maintenance tick.
 */
export function atelierStep(deps: TickDeps): IntrospectStep {
  return {
    id: 'atelier', logTag: 'ATELIER', failLabel: 'tick',
    async run({ nowIso }) {
      if (!deps.runAtelierTick) return
      await deps.runAtelierTick({ nowIso })
    },
  }
}
