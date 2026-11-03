import { expect, it } from 'vitest'
import { assetPath } from '../art/cc-v1/motion/catalog.mjs'

it('previews registered coordinated frames while still refusing path traversal and remote assets',()=>{
  expect(assetPath('performance/lit/walk/003.png')).toBe('performance/lit/walk/003.png')
  for(const path of ['performance/../private.png','performance/lit/../../private.png','https://host/performance/lit/a.png','performance/lit/a.svg']) {
    expect(()=>assetPath(path)).toThrow('unsafe PNG path')
  }
})
