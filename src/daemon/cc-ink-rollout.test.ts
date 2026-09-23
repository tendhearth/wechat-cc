import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { makeStickerLib, seedStarterStickers } from './stickers'
import { buildStickerPrompt } from './sticker-artist'
import { buildPostcardPrompt } from '../core/visit'
import { buildPortraitPrompt } from './memory-llm-ops'

describe('CC ink rollout', () => {
  it('adds the versioned pack to existing collections once, preserving old files', () => {
    const dir=mkdtempSync(join(tmpdir(),'cc-ink-'))
    try {
      const lib=makeStickerLib(join(dir,'state'), {random:()=>0})
      writeFileSync(join(dir,'bear-complete.png'),'old')
      lib.save(join(dir,'bear-complete.png'),['开心'],'小熊够到了小蜜蜂,开心')
      writeFileSync(join(dir,'cc-ink-v1-happy-light.png'),'new')
      writeFileSync(join(dir,'manifest.json'),JSON.stringify([{file:'cc-ink-v1-happy-light.png',tags:['开心'],desc:'CC 开心',pack:'cc-ink-v1'}]))
      expect(seedStarterStickers(lib,dir)).toBe(1)
      expect(seedStarterStickers(lib,dir)).toBe(0)
      expect(lib.list()).toHaveLength(2)
      expect(basename(lib.resolve('开心')!)).toBe('cc-ink-v1-happy-light.png')
    } finally {rmSync(dir,{recursive:true,force:true})}
  })
  it('shares Light/Dark identity in generated stickers and postcards, keeps portraits about the owner',()=>{
    for(const prompt of [buildStickerPrompt('开心'),buildPostcardPrompt({myName:'CC',peerLabel:'朋友',scene:'咖啡馆'})]) {
      expect(prompt).toContain('头顶')
      expect(prompt).toContain('Dark')
      expect(prompt).toContain('没有嘴')
      expect(prompt).not.toContain('小熊')
      expect(prompt).not.toContain('小白熊')
    }
    expect(buildPortraitPrompt('喜欢音乐')).toContain('不是画你自己')
    expect(buildPortraitPrompt('喜欢音乐')).not.toContain('小熊')
  })
})
