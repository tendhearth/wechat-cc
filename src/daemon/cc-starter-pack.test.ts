import { it, expect } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { materializeCcStarterPack } from './cc-starter-pack'
it('materializes all eight bundled PNGs without a repository',()=>{
 const dir=materializeCcStarterPack()
 try {
  const manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'))
  expect(manifest).toHaveLength(8)
  for(const e of manifest) {
   const png=readFileSync(join(dir,e.file))
   expect(png.subarray(1,4).toString()).toBe('PNG')
   expect(png.readUInt32BE(16)).toBe(512)
   expect(png.readUInt32BE(20)).toBe(512)
  }
 } finally {rmSync(dir,{recursive:true,force:true})}
})
