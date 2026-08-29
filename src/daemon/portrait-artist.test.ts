import { describe, expect, it, vi } from 'vitest'
import { shouldRepaintPortrait, runPortraitArtist, PORTRAIT_MIN_INTERVAL_MS } from './portrait-artist'

const DAY = 86_400_000

describe('portrait-artist', () => {
  describe('shouldRepaintPortrait', () => {
    it('paints when no portrait exists yet (first time) as long as profile material is present', () => {
      expect(shouldRepaintPortrait({ portraitAt: null, profileMtime: 1000, now: 2000 })).toBe(true)
    })
    it('skips when there is no profile material', () => {
      expect(shouldRepaintPortrait({ portraitAt: null, profileMtime: null, now: 2000 })).toBe(false)
    })
    it('skips when the profile has not changed since the last portrait', () => {
      const t = 10 * DAY
      expect(shouldRepaintPortrait({ portraitAt: t, profileMtime: t - 1000, now: t + 20 * DAY })).toBe(false)
    })
    it('skips when the profile changed but the min interval has not elapsed', () => {
      const t = 10 * DAY
      expect(shouldRepaintPortrait({ portraitAt: t, profileMtime: t + 1000, now: t + 1 * DAY })).toBe(false)
    })
    it('paints when the profile changed AND the min interval elapsed', () => {
      const t = 10 * DAY
      expect(shouldRepaintPortrait({ portraitAt: t, profileMtime: t + 1000, now: t + PORTRAIT_MIN_INTERVAL_MS + 1 })).toBe(true)
    })
  })

  describe('runPortraitArtist', () => {
    function deps(over: Partial<Parameters<typeof runPortraitArtist>[0]> = {}) {
      return {
        adminChatId: 'owner@im.wechat',
        portraitGeneratedAt: () => null as number | null,
        profileMtime: () => 1000 as number | null,
        generate: vi.fn(async () => ({ ok: true })),
        log: vi.fn(),
        now: () => 5000,
        ...over,
      }
    }

    it('regenerates when the gate passes', async () => {
      const d = deps()
      const r = await runPortraitArtist(d)
      expect(d.generate).toHaveBeenCalledWith('owner@im.wechat')
      expect(r.painted).toBe(true)
    })

    it('does not regenerate when gated off', async () => {
      const d = deps({ profileMtime: () => null })   // no material
      const r = await runPortraitArtist(d)
      expect(d.generate).not.toHaveBeenCalled()
      expect(r.painted).toBe(false)
    })

    it('a generate failure is non-fatal (logged, painted=false)', async () => {
      const d = deps({ generate: vi.fn(async () => ({ ok: false, error: 'no_profile' })) })
      const r = await runPortraitArtist(d)
      expect(r.painted).toBe(false)
      expect(d.log).toHaveBeenCalled()
    })

    it('a thrown generate never escapes', async () => {
      const d = deps({ generate: vi.fn(async () => { throw new Error('boom') }) })
      await expect(runPortraitArtist(d)).resolves.toEqual({ painted: false })
      expect(d.log).toHaveBeenCalled()
    })
  })
})
