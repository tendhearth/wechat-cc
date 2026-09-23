import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareNativeQA } from '../../../scripts/prepare-cc-native-qa.mjs'
const desktop = fileURLToPath(new URL('../../../', import.meta.url))
describe('native QA packaging', () => {
  it('keeps QA pages out of the production frontend and stages runnable dependencies separately', () => {
    const production = JSON.parse(readFileSync(join(desktop,'src-tauri/tauri.conf.json'),'utf8').replace(/^\uFEFF/,''))
    const qa = JSON.parse(readFileSync(join(desktop,'art/cc-v1/native-qa/tauri.qa.json'),'utf8').replace(/^\uFEFF/,''))
    expect(resolve(desktop,'src-tauri',production.build.frontendDist)).toBe(join(desktop,'src'))
    expect(resolve(desktop,'src-tauri',qa.build.frontendDist)).toBe(join(desktop,'art/cc-v1/native-qa/dist'))
    expect(qa.build.beforeBuildCommand).toContain('prepare-cc-native-qa.mjs')
    const dir = mkdtempSync(join(tmpdir(),'cc-native-stage-'))
    try {
      prepareNativeQA(dir)
      for (const name of ['cc-native-qa.html','cc-native-qa.css','cc-native-qa.js']) {
        expect(existsSync(join(desktop,'src',name))).toBe(false)
        expect(readFileSync(join(dir,name))).toEqual(readFileSync(join(desktop,'art/cc-v1/native-qa',name)))
      }
      for (const path of ['pet/pet.js','companion-window.css','fonts/geist-variable-latin.woff2','assets/pet/cc-v1/manifest.json','assets/pet/cc-v1/transitions/light-to-dark/007.png']) expect(readFileSync(join(dir,path))).toEqual(readFileSync(join(desktop,'src',path)))
      for (const path of ['CC_MASTER_V1.png','CC_DESIGN_SHEET_V1.png']) expect(existsSync(join(dir,'assets/pet/cc-v1',path))).toBe(false)
      expect(existsSync(join(desktop,'src/pet-lab.html'))).toBe(true)
    } finally { rmSync(dir,{recursive:true,force:true}) }
  })
})
