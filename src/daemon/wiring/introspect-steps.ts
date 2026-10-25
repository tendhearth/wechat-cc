/**
 * 自省那一拍(每天一次)固定维护之后的几步(从 tick-introspect.ts 原样搬出,A5「陪伴候选」贡献点):
 * 小像、记忆园丁、画室。各自门控、各自失败不拖累后面的步;登记在 tick-bodies.ts,顺序就是执行顺序。
 * 贴纸那一步归贴纸功能自己(src/features/stickers 的 stickerArtistStep),在登记表里排第一。
 */
import { join } from 'node:path'
import { loadCompanionConfig } from '../companion/config'
import { runGarden } from '../../features/memory'
import { readJsonFile } from '../../lib/read-json-file'
import type { IntrospectStep } from '../companion/contributions'
import type { TickDeps } from './tick-deps'

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
