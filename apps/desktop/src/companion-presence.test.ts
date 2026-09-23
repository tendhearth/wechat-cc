vi.mock('./api.js', () => ({ invokeApi: vi.fn() }))

import { describe, expect, it, vi } from 'vitest'
import { startCompanionPresence } from './companion-presence.js'

const ok = { presence: 'ok', activity: { kind: 'foraging', label: '觅食中', since: null }, news: { unread: 1, latest_kind: 'hunt', latest_title: 't' } }

describe('startCompanionPresence', () => {
  it('每次轮询把 sceneStateFrom(presence) 喂给场景,并把 onOpenJournal 挂到 onPropClick', async () => {
    const scene = { setState: vi.fn(), getState: () => ({}), onPropClick: null as null | (() => void) }
    const onOpenJournal = vi.fn()
    const invokeApi = vi.fn().mockResolvedValue(ok)
    const p = startCompanionPresence({ onOpenJournal, invokeApi, scene, intervalMs: 60_000 })
    await p.refresh()
    expect(scene.setState).toHaveBeenLastCalledWith(expect.objectContaining({ bearPose: 'fishing', sign: '觅食中', prop: 'bag', badge: 1 }))
    scene.onPropClick?.()
    expect(onOpenJournal).toHaveBeenCalledOnce()
    p.stop()
  })
  it('场景还没就绪(scene=null)时不炸,只是不画', async () => {
    const invokeApi = vi.fn().mockResolvedValue(ok)
    const p = startCompanionPresence({ onOpenJournal: () => {}, invokeApi, scene: null, intervalMs: 60_000 })
    await expect(p.refresh()).resolves.toBeTruthy()
    p.stop()
  })
})
