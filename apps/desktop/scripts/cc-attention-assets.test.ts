import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { validateAssetKit } from './validate-cc-asset-kit.mjs'

const root = resolve(__dirname, '../../..')
const kit = resolve(root, 'apps/desktop/src/assets/pet/cc-v1')
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

it('adds paired gaze and one planted-foot response from the frozen scene without changing approved inputs', () => {
  const manifest = read(`${kit}/manifest.json`)
  const freeze = read(`${root}/apps/desktop/art/cc-v1/design-freeze.json`)
  for (const [path, digest] of Object.entries(freeze.sha256)) expect(sha(resolve(root, path))).toBe(digest)
  const provenance = read(`${root}/apps/desktop/art/cc-v1/attention/render-progress.json`)
  expect(manifest.attention.source).toEqual(provenance.identity)
  expect(provenance.identity.rendererSha256).toBe(sha(`${root}/apps/desktop/scripts/render-cc-attention.py`))
  expect(provenance.identity.baseRendererSha256).toBe(sha(`${root}/apps/desktop/scripts/render-cc.py`))
  for (const entry of Object.values(provenance.samples) as any[]) {
    expect(entry.parameters.feet).toEqual({ left: { lift: 0, stride: 0, roll: 0 }, right: { lift: 0, stride: 0, roll: 0 } })
    for (const [path, digest] of Object.entries(entry.files)) expect(sha(`${kit}/${path}`)).toBe(digest)
  }
  for (const name of ['left', 'right', 'input-up', 'read-down', 'speaking']) {
    const a = manifest.forms.lit.states[`attention-${name}`]
    const b = manifest.forms.unlit.states[`attention-${name}`]
    expect(a.artStatus).toBe('production-candidate')
    expect(a.frames.length).toBe(name === 'speaking' ? 4 : 1)
    expect(b.frames).toHaveLength(a.frames.length)
    a.frames.forEach((path: string, i: number) => {
      expect(manifest.assets[path].geometryMask).toBe(manifest.assets[b.frames[i]].geometryMask)
      expect(manifest.assets[path].source).toBe('frozen-blender-rig')
    })
  }
  expect(manifest.forms.lit.states.blink.artStatus).toBe('reviewed-production')
  expect(validateAssetKit(kit).errors).toEqual([])
}, 20_000)
