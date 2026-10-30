import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { buildMotionCatalog, prepareMotionKit } from './register-cc-motion.mjs'
import { buildMotionPlan } from './cc-motion-recipes.mjs'

const desktop = resolve(__dirname, '..')
const kit = join(desktop, 'src/assets/pet/cc-v1')
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

describe('motion registration', () => {
  it('describes both states with the same sample positions and safe paths', () => {
    const catalog = buildMotionCatalog(buildMotionPlan(), { samples: 96, blender: '5.2.1 LTS', sha256: 'source' }, '2026-10-29T17:00:00Z')
    const done = catalog.clips.find(c => c.id === 'done')!
    expect(done.frames.lit[0]).toBe('motion/lit/done/000.png')
    expect(done.frames.unlit[15]).toBe('motion/unlit/done/015.png')
    expect(done.masks[15]).toBe('masks/motion/done/015.png')
    expect(catalog.forms.map(f => f.id)).toEqual(['lit', 'unlit'])
    expect(catalog.artStatus).toBe('production-candidate')
    expect(() => buildMotionCatalog({ ...buildMotionPlan(), clips: [{ id: '../escape', frames: [] }] }, {}, '')).toThrow('clip')
  })

  it('refuses an incomplete render before changing the installed manifest or publishing a catalog', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'cc-motion-register-'))
    try {
      const target = join(temporary, 'kit')
      mkdirSync(target)
      const original = readFileSync(join(kit, 'manifest.json'))
      // A Windows editor may preserve the repository JSON with a UTF-8 BOM.
      writeFileSync(join(target, 'manifest.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]))
      const planPath = join(desktop, 'art/cc-v1/motion/recipes.json')
      const source = readFileSync(join(desktop, 'art/cc-v1/cc-v1.blend'))
      const progressPath = join(temporary, 'progress.json')
      writeFileSync(progressPath, JSON.stringify({ identity: {
        planSha256: digest(readFileSync(planPath)), sourceSha256: digest(source),
        rendererSha256: digest(readFileSync(join(desktop, 'scripts/render-cc.py'))), samples: 96, seed: 11, blender: '5.2.1 LTS',
        geometrySha256: digest(readFileSync(join(desktop, 'scripts/cc_motion_geometry.py'))),
      }, samples: {} }))
      expect(() => prepareMotionKit({ desktopRoot: desktop, kitRoot: target, planPath, progressPath })).toThrow('Incomplete motion sample: thinking/000')
      expect(readFileSync(join(target, 'manifest.json')).equals(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]))).toBe(true)
    } finally { rmSync(temporary, { recursive: true, force: true }) }
  })
})
