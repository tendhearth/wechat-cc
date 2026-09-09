import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { inflateSync, deflateSync } from 'node:zlib'
import { normalizeManifest } from './manifest-loader.js'
import { resolveAnimation, resolveTransition } from './animation-resolver.js'
import { validateCCMetadata } from './cc-contract.js'
import { validateAssetKit } from '../../../scripts/validate-cc-asset-kit.mjs'
import { readRGBA } from '../../../scripts/cc-png.mjs'
import { ANATOMY, geometry, placeholderSvg, fallbackFrame, VIEWS } from '../../assets/pet/cc-v1/placeholder.js'

const root = resolve(__dirname, '../../assets/pet/cc-v1')
const raw = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))


// Real RGBA8 PNG fixtures: one opaque body pixel and an independently set test pixel.
function alphaPng(alpha: number) {
  const chunk = (type: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length)
    result.write(type, 4)
    data.copy(result, 8)
    let crc = 0xffffffff
    for (const byte of result.subarray(4, -4)) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(512); header.writeUInt32BE(512, 4); header[8] = 8; header[9] = 6
  const scan = Buffer.alloc(512 * (512 * 4 + 1))
  scan[100 * 2049 + 1 + 100 * 4 + 3] = 255
  scan[100 * 2049 + 1 + 101 * 4 + 3] = alpha
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0))])
}

function withPngKit(run: (target: string, next: any, add: (path: string, bytes: Buffer, extra?: any) => void) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-entity-mask-'))
  try {
    const target = join(dir, 'cc-v1')
    cpSync(root, target, { recursive: true })
    cpSync(resolve(root, '../props'), join(dir, 'props'), { recursive: true })
    const next = structuredClone(raw)
    const add = (path: string, bytes: Buffer, extra = next.assets[path]) => {
      writeFileSync(join(target, path), bytes)
      next.assets[path] = { ...extra, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    run(target, next, add)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('CC Asset Kit v1.0-alpha', () => {
  it.each(['artStatus', 'state', 'transition', 'asset'])('requires a known %s status and accepts production candidates', (scope) => {
    const next = structuredClone(raw)
    const entry = scope === 'artStatus' ? next : scope === 'state' ? next.forms.unlit.states.blink
      : scope === 'transition' ? next.transitions['unlit-to-lit'] : next.assets['masks/front.png']
    const error = scope === 'artStatus' ? 'artStatus' : scope === 'state' ? 'artStatus:state:unlit/blink'
      : scope === 'transition' ? 'artStatus:transition:unlit-to-lit' : 'artStatus:asset:masks/front.png'
    entry.artStatus = 'production-candidate'
    expect(validateCCMetadata(next)).toEqual([])
    entry.artStatus = 'almost-approved'
    expect(validateCCMetadata(next)).toContain(error)
    delete entry.artStatus
    expect(validateCCMetadata(next)).toContain(error)
  })

  it.each([123, {}])('rejects a non-string geometryMask without throwing: %j', (mask) => {
    withPngKit((target, next) => {
      next.assets['canonical/lit/front.png'].geometryMask = mask
      writeFileSync(join(target, 'manifest.json'), JSON.stringify(next))
      expect(validateAssetKit(target).errors).toContain('geometry_mask_missing:canonical/lit/front.png')
    })
  }, 30_000)

  it('requires a decoded PNG entity mask for every PNG frame', () => {
    withPngKit((target, next) => {
      next.assets['canonical/lit/front.png'].geometryMask = 'masks/front.svg'
      writeFileSync(join(target, 'manifest.json'), JSON.stringify(next))
      expect(validateAssetKit(target).errors).toContain('geometry_mask_missing:canonical/lit/front.png')
    })
  }, 30_000)

  it.each([
    [0, 0, true], [0, 89, true], [0, 90, false],
    [1, 0, false], [1, 1, true], [1, 89, true],
    [249, 248, false], [249, 249, true], [249, 255, true],
    [250, 249, false], [250, 250, true], [250, 251, false],
    [255, 254, false], [255, 255, true],
  ])('entity coverage %i permits form alpha %i: %s', (coverage, alpha, allowed) => {
    withPngKit((target, next, add) => {
      // Keep every other consumer of the replaced mask valid in this fixture.
      for (const [path, meta] of Object.entries(next.assets) as [string, any][]) {
        if (meta.geometryMask === 'masks/front.png') add(path, alphaPng(coverage))
      }
      add('masks/front.png', alphaPng(coverage))
      add('canonical/lit/front.png', alphaPng(alpha))
      add('canonical/unlit/front.png', alphaPng(coverage))
      writeFileSync(join(target, 'manifest.json'), JSON.stringify(next))
      const errors = validateAssetKit(target).errors
      if (allowed) expect(errors).toEqual([])
      else expect(errors).toContain('png_alpha_mask:canonical/lit/front.png')
    })
  }, 30_000)

  it('corresponding sprites share a mask path by state/view/expression, independent of filenames', () => {
    withPngKit((target, next, add) => {
      const mask = readFileSync(join(target, 'masks/front.png'))
      add('masks/duplicate.png', mask, next.assets['masks/front.png'])
      for (const form of ['lit', 'unlit']) {
        const path = `sprites/${form}/${form === 'lit' ? 'frame-a' : 'frame-b'}.png`
        add(path, readFileSync(join(target, `canonical/${form}/front.png`)), {
          ...next.assets[`canonical/${form}/front.png`], view: 'front', expression: 'working',
          geometryMask: form === 'lit' ? 'masks/front.png' : 'masks/duplicate.png',
        })
        next.forms[form].states.working.frames = [path]
      }
      writeFileSync(join(target, 'manifest.json'), JSON.stringify(next))
      expect(validateAssetKit(target).errors).toContain('pair_geometry_mask:state:working/front/working:0')
      next.assets['sprites/unlit/frame-b.png'].geometryMask = 'masks/front.png'
      writeFileSync(join(target, 'manifest.json'), JSON.stringify(next))
      expect(validateAssetKit(target).errors).toEqual([])
    })
  }, 30_000)

  it('ships every required state/view/frame with verified paths, bytes and shared vector geometry', () => {
    expect(validateAssetKit().errors).toEqual([])
    expect(validateAssetKit().assetCount).toBeGreaterThanOrEqual(37)
    expect(validateAssetKit().warnings.join(' ')).toContain('do not prove anatomy')
  })
  it('loads the first Blender batch as both forms master and idle with a shared mask', () => {
    for (const form of ['lit', 'unlit']) {
      const path = `canonical/${form}/front.png`
      expect(raw.forms[form].master).toBe(path)
      expect(raw.forms[form].states.idle.frames).toEqual([path])
      expect(raw.canonical[form]).toBe(path)
      expect(raw.turnarounds[form].front).toBe(path)
      expect(raw.assets[path].geometryMask).toBe('masks/front.png')
      const { alpha } = readRGBA(readFileSync(join(root, path)))
      expect(alpha.subarray(469 * 512, 470 * 512).some(a => a > 0)).toBe(true)
    }
  })
  it('keeps Dark free of exterior haze, with white eyes and independent Light effects', () => {
    const mask = readRGBA(readFileSync(join(root, 'masks/front.png'))).alpha
    const dark = readRGBA(readFileSync(join(root, 'canonical/unlit/front.png')))
    const light = readRGBA(readFileSync(join(root, 'canonical/lit/front.png')))
    expect(dark.alpha).toEqual(mask)
    expect(light.alpha.some((a, i) => mask[i] === 0 && a > 0)).toBe(true)
    let whiteEyes = 0
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 255 && dark.rgba[i * 4] === 255 && dark.rgba[i * 4 + 1] === 255 && dark.rgba[i * 4 + 2] === 255) whiteEyes++
    }
    expect(whiteEyes).toBeGreaterThan(20)
  })
  it.each(Object.entries(ANATOMY))('rejects contradictory anatomical metadata: %s', (key, value) => {
    const broken = structuredClone(raw)
    broken.character[key] = typeof value === 'boolean' ? !value : value + 1
    expect(validateCCMetadata(broken)).toContain(`character:${key}`)
    expect(normalizeManifest(broken).ok).toBe(false)
  })
  it('rejects different form geometry and dark intrinsic glow', () => {
    const broken = structuredClone(raw)
    broken.forms.unlit.geometryId = 'other'
    broken.forms.unlit.material.intrinsicGlow = true
    expect(validateCCMetadata(broken)).toEqual(['character:geometryId', 'material:unlit:intrinsicGlow'])
  })
  it.each(VIEWS)('same view %s has exactly one C, two feet and two anatomical eyes across materials', (view) => {
    const g = geometry(view)
    expect(g.match(/data-part="c"/g)).toHaveLength(1)
    expect(g.match(/data-part="foot-/g)).toHaveLength(2)
    expect(g.match(/data-part="eye-/g)).toHaveLength(2)
    const extract = (form: string) => placeholderSvg(form, view).match(/<g id="geometry">[\s\S]*?<\/g>/)?.[0]
    expect(extract('lit')).toBe(extract('unlit'))
    // Rear-view eyes are occluded, not additional facial features on the back.
    if (view === 'back') expect(g.match(/opacity="0"/g)).toHaveLength(2)
  })
  it('offline fallback is the identical registered placeholder, dark has zero self-light', () => {
    for (const form of ['lit', 'unlit']) expect(decodeURIComponent(fallbackFrame(form).split(',')[1]!)).toBe(placeholderSvg(form))
    expect(placeholderSvg('unlit')).toContain('id="self-light" opacity="0.0000"')
    expect(placeholderSvg('unlit')).toContain('color="#fff7e6"')
    expect(placeholderSvg('lit')).toContain('color="#151412"')
    expect(geometry()).toContain('fill="currentColor"')
  })
  it('plays only Blender geometry in declared behaviors, with matching blink endpoints', () => {
    for (const form of ['lit', 'unlit']) {
      for (const state of Object.values(raw.forms[form].states) as any[]) {
        expect(state.frames.every((p: string) => p.endsWith('.png'))).toBe(true)
      }
      const blink = raw.forms[form].states.blink.frames
      expect(blink).toEqual([`canonical/${form}/front.png`, `sprites/${form}/blink-half.png`, `sprites/${form}/blink-closed.png`, `sprites/${form}/blink-half.png`, `canonical/${form}/front.png`])
      expect(raw.assets[`sprites/${form}/sleep.png`].geometryMask).toBe('masks/sleep.png')
    }
    const idleMask = readRGBA(readFileSync(join(root, 'masks/front.png'))).alpha
    const sleepMask = readRGBA(readFileSync(join(root, 'masks/sleep.png'))).alpha
    expect(sleepMask).not.toEqual(idleMask)
    // C droops; body/feet keep their contour. Separate Cycles renders may vary
    // a few edge-coverage levels, but may not shift any half-covered pixel.
    for (let i = 300 * 512; i < idleMask.length; i++) {
      expect(sleepMask[i]! >= 128).toBe(idleMask[i]! >= 128)
      expect(Math.abs(sleepMask[i]! - idleMask[i]!)).toBeLessThanOrEqual(8)
    }
  })
  it('transitions have exact canonical endpoints and monotonic exterior coverage', () => {
    const paths: string[] = raw.transitions['unlit-to-lit'].frames
    expect(paths).toHaveLength(8)
    expect(readFileSync(join(root, paths[0]!)).equals(readFileSync(join(root, 'canonical/unlit/front.png')))).toBe(true)
    expect(readFileSync(join(root, paths.at(-1)!)).equals(readFileSync(join(root, 'canonical/lit/front.png')))).toBe(true)
    const frames = paths.map(p => readRGBA(readFileSync(join(root, p))))
    for (let k = 1; k < frames.length; k++) {
      expect(frames[k]!.alpha.every((a, i) => a >= frames[k - 1]!.alpha[i]!)).toBe(true)
    }
  })
  it('missing/empty states fail soft with same-form idle; reverse transition uses existing fade', () => {
    const broken = structuredClone(raw)
    delete broken.forms.lit.states.permission
    broken.forms.unlit.states.working.frames = []
    const loaded = normalizeManifest(broken)
    if (!loaded.ok) throw Error(loaded.reason)
    expect(resolveAnimation(loaded.manifest, 'lit', 'permission').source).toBe('same-form-idle')
    expect(resolveAnimation(loaded.manifest, 'unlit', 'working').source).toBe('same-form-idle')
    expect(resolveTransition(loaded.manifest, 'lit-to-unlit', 'unlit').kind).toBe('fade')
  })
  it('release check detects missing files and tampered geometry even when metadata counts remain correct', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-kit-'))
    try {
      cpSync(root, join(dir, 'cc-v1'), { recursive: true })
      cpSync(resolve(root, '../props'), join(dir, 'props'), { recursive: true })
      const path = join(dir, 'cc-v1/canonical/lit/front.svg')
      writeFileSync(path, readFileSync(path, 'utf8').replace('cx="170"', 'cx="171"'))
      rmSync(join(dir, 'cc-v1/sprites/lit/working.svg'))
      const errors = validateAssetKit(join(dir, 'cc-v1')).errors.join('\n')
      expect(errors).toContain('geometry_source:canonical/lit/front.svg')
      expect(errors).toContain('geometry_digest:canonical/lit/front.svg')
      expect(errors).toContain('path:sprites/lit/working.svg')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 30_000)
  it('invalid frame paths and nonfinite canvas do not reach the renderer', () => {
    const broken = structuredClone(raw)
    broken.forms.lit.states.working.frames = [null, '', ' ', 'javascript:alert(1)']
    const result = normalizeManifest(broken)
    if (!result.ok) throw Error(result.reason)
    expect(result.manifest.forms.lit.states.working).toBeUndefined()
    expect(result.manifest.warnings).toContain('frame_path_invalid:lit/working')
    broken.canvas.anchor = [NaN, 0.9]
    expect(normalizeManifest(broken).ok).toBe(false)
    broken.canvas.width = Infinity
    expect(normalizeManifest(broken).ok).toBe(false)
  })
  it('release gate rejects filtered required frames and missing asset metadata, runtime stays fail-soft', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-kit-release-'))
    try {
      cpSync(root, join(dir, 'cc-v1'), { recursive: true })
      cpSync(resolve(root, '../props'), join(dir, 'props'), { recursive: true })
      const broken = structuredClone(raw)
      broken.forms.lit.states.working.frames = [null]
      broken.transitions['unlit-to-lit'].frames = ['javascript:invalid']
      delete broken.assets[broken.forms.lit.states.thinking.frames[0]]
      writeFileSync(join(dir, 'cc-v1/manifest.json'), JSON.stringify(broken))
      expect(normalizeManifest(broken).ok).toBe(true)
      expect(validateAssetKit(join(dir, 'cc-v1')).errors).toEqual(expect.arrayContaining([
        'state_missing:lit/working', 'transition_missing:unlit-to-lit', `asset_metadata_missing:${broken.forms.lit.states.thinking.frames[0]}`,
      ]))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 30_000)
  it('accepts a reviewed PNG replacement with one shared PNG mask; rejects changed coverage and distinct paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-kit-png-'))
    try {
      const target = join(dir, 'cc-v1')
      cpSync(root, target, { recursive: true })
      cpSync(resolve(root, '../props'), join(dir, 'props'), { recursive: true })
      const next = structuredClone(raw)
      const add = (path: string, bytes: Buffer, extra = {}) => {
        writeFileSync(join(target, path), bytes)
        next.assets[path] = { artStatus: 'reviewed-production', ...extra, sha256: createHash('sha256').update(bytes).digest('hex') }
      }
      // Fixtures are rasterizations of the controlled placeholder, not approved art.
      // Coverage includes the shared shadow as well as the opaque silhouette.
      const mask = readFileSync(join(__dirname, 'fixtures/cc-v1-lit.png'))
      add('masks/production-front.png', mask)
      for (const form of ['lit', 'unlit']) {
        const path = `canonical/${form}/front.png`
        add(path, readFileSync(join(__dirname, `fixtures/cc-v1-${form}.png`)), {
          geometryMask: 'masks/production-front.png',
          visualReview: { reviewer: 'test-fixture-only', reviewedAt: '2026-09-08', referenceSha256: next.reference.sha256 },
        })
        next.canonical[form] = path
        next.forms[form].master = path
        next.forms[form].states.idle.frames = [path]
        next.turnarounds[form].front = path
      }
      writeFileSync(join(target, 'manifest.json'), JSON.stringify(next))
      expect(validateAssetKit(target).errors).toEqual([])
      expect(validateAssetKit(target).warnings).toContain('bitmap_geometry_attestation_only:front')
      // Preserve a valid PNG and update its digest, but shift its actual coverage.
      // This catches validators that only compare mask filenames or attestations.
      const path = 'canonical/lit/front.png'
      const original = readFileSync(join(target, path))
      const chunks: { type: string; bytes: Buffer }[] = []
      for (let offset = 8; offset < original.length;) {
        const length = original.readUInt32BE(offset)
        chunks.push({ type: original.toString('ascii', offset + 4, offset + 8), bytes: original.subarray(offset, offset + length + 12) })
        offset += length + 12
      }
      const scanlines = inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.bytes.subarray(8, -4))))
      scanlines[4] = scanlines[4]! ^ 127 // first pixel alpha residual, regardless of PNG row filter
      const compressed = deflateSync(scanlines)
      const idat = Buffer.alloc(compressed.length + 12)
      idat.writeUInt32BE(compressed.length)
      idat.write('IDAT', 4)
      compressed.copy(idat, 8)
      let crc = 0xffffffff
      for (const byte of idat.subarray(4, -4)) {
        crc ^= byte
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
      }
      idat.writeUInt32BE((crc ^ 0xffffffff) >>> 0, idat.length - 4)
      add(path, Buffer.concat([original.subarray(0, 8), ...chunks.filter(c => c.type !== 'IDAT' && c.type !== 'IEND').map(c => c.bytes), idat, chunks.find(c => c.type === 'IEND')!.bytes]), next.assets[path])
      writeFileSync(join(target, 'manifest.json'), JSON.stringify(next))
      expect(validateAssetKit(target).errors).toContain(`png_alpha_mask:${path}`)
      add(path, original, next.assets[path])
      // Identical bytes under different paths are not one shared mask.
      add('masks/a.png', mask)
      add('masks/b.png', mask)
      next.assets['canonical/lit/front.png'].geometryMask = 'masks/a.png'
      next.assets['canonical/unlit/front.png'].geometryMask = 'masks/b.png'
      writeFileSync(join(target, 'manifest.json'), JSON.stringify(next))
      expect(validateAssetKit(target).errors).toContain('pair_geometry_mask:front')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 30_000)
})


describe('second-batch authored performances', () => {
  const poses = { thinking: 'listening', working: 'listening', done: 'happy', receive: 'happy', permission: 'confused', error: 'excited', look: 'front', drag: 'excited' }
  it('delivers every behavior in both forms without rest placeholders', () => {
    for (const form of ['lit', 'unlit']) {
      const states = raw.forms[form].states
      expect(Object.keys(states)).toHaveLength(13)
      for (const [behavior, pose] of Object.entries(poses)) {
        const path = `sprites/${form}/${behavior}.png`
        expect(states[behavior].frames).toEqual([path])
        expect(states[behavior].todo).toBeUndefined()
        expect(raw.assets[path].geometryMask).toBe(`masks/${pose}.png`)
        expect(readFileSync(join(root, path))).not.toEqual(readFileSync(join(root, `canonical/${form}/front.png`)))
      }
      expect(states.companion.frames).toEqual(states.idle.frames)
      expect(states.wake.frames).toEqual([`sprites/${form}/blink-half.png`, `canonical/${form}/front.png`])
    }
  })
  it('preserves body and feet coverage across authored C poses', () => {
    const base = readRGBA(readFileSync(join(root, 'masks/front.png'))).alpha
    for (const pose of new Set(Object.values(poses))) {
      const mask = readRGBA(readFileSync(join(root, `masks/${pose}.png`))).alpha
      const start = 300 * 512
      expect(mask.subarray(start).every((value, i) => (value >= 128) === (base[start + i]! >= 128))).toBe(true)
      expect(mask.subarray(start).every((value, i) => Math.abs(value - base[start + i]!) <= 8)).toBe(true)
    }
  })
})


it('preserves the owner-approved scene, canonical images and transition bytes', () => {
  const freeze = JSON.parse(readFileSync(resolve(__dirname, '../../../art/cc-v1/design-freeze.json'), 'utf8'))
  for (const [path, digest] of Object.entries(freeze.sha256)) {
    expect(createHash('sha256').update(readFileSync(resolve(__dirname, '../../../../..', path))).digest('hex')).toBe(digest)
  }
})

it('renders two readable crescent/squint eyes, enlarged eyes and a shifted gaze', () => {
  const eyeComponents = (path: string) => {
    const { rgba } = readRGBA(readFileSync(join(root, path)))
    const pixels = new Set<number>()
    for (let y = 300; y < 420; y++) for (let x = 180; x < 360; x++) {
      const i = y * 512 + x
      if ([0, 1, 2, 3].every(c => rgba[i * 4 + c]! >= 250)) pixels.add(i)
    }
    const components: { width: number; height: number; area: number; centerX: number }[] = []
    while (pixels.size) {
      const queue = [pixels.values().next().value!]; pixels.delete(queue[0]!)
      for (let n = 0; n < queue.length; n++) for (const d of [-1, 1, -512, 512]) {
        const next = queue[n]! + d
        if (pixels.delete(next)) queue.push(next)
      }
      const xs = queue.map(i => i % 512), ys = queue.map(i => Math.floor(i / 512))
      components.push({ width: Math.max(...xs) - Math.min(...xs) + 1, height: Math.max(...ys) - Math.min(...ys) + 1, area: queue.length, centerX: xs.reduce((a, b) => a + b, 0) / xs.length })
    }
    expect(components).toHaveLength(2)
    return components.sort((a, b) => a.centerX - b.centerX)
  }
  const base = eyeComponents('canonical/unlit/front.png')
  for (const behavior of ['done', 'thinking']) {
    for (const eye of eyeComponents(`sprites/unlit/${behavior}.png`)) expect(eye.width).toBeGreaterThan(eye.height)
  }
  const large = eyeComponents('sprites/unlit/receive.png')
  const look = eyeComponents('sprites/unlit/look.png')
  for (let i = 0; i < 2; i++) {
    expect(large[i]!.area).toBeGreaterThan(base[i]!.area)
    expect(look[i]!.centerX).toBeGreaterThan(base[i]!.centerX)
  }
})

it('registers seven owner-reviewed standalone props as padded 384px RGBA, without sprout', () => {
  expect(Object.keys(raw.props).sort()).toEqual(['envelope','exclamation','laptop','micro-light','mug','speech-bubble','thought-bubble'])
  for (const path of Object.values(raw.props) as string[]) {
    expect(raw.assets[path]?.kind).toBe('prop')
    expect(raw.assets[path]?.artStatus).toBe('reviewed-production')
    expect(raw.assets[path]?.visualReview).toMatchObject({owner: 'ggshr9', reviewedAt: '2026-09-09', method: 'native transparent window on real wallpaper'})
    const { alpha, width, height } = readRGBA(readFileSync(join(root, path)), 384)
    expect([width, height]).toEqual([384,384])
    expect(alpha.some(a => a > 0)).toBe(true)
    expect(alpha.every((a, i) => !a || (i % 384 >= 12 && i % 384 < 372 && Math.floor(i / 384) >= 12 && Math.floor(i / 384) < 372))).toBe(true)
  }
})

it('rejects standalone prop dimensions and missing registration independently of character masks', () => {
  withPngKit((target, next, add) => {
    const path = next.props.mug
    add(path, readFileSync(join(root, 'canonical/lit/front.png')))
    writeFileSync(join(target, 'manifest.json'), JSON.stringify(next))
    expect(validateAssetKit(target).errors.some(e => e.startsWith(`prop_png:${path}:`))).toBe(true)
    delete next.assets[path]
    writeFileSync(join(target, 'manifest.json'), JSON.stringify(next))
    expect(validateAssetKit(target).errors).toContain(`asset_metadata_missing:${path}`)
    next.forms.lit.master = path
    next.canonical.lit = path
    writeFileSync(join(target, 'manifest.json'), JSON.stringify(next))
    expect(validateAssetKit(target).errors).toContain(`prop_as_character:${path}`)
  })
}, 30_000)

it('records native owner acceptance without promoting SVG placeholders', () => {
  expect(raw.artStatus).toBe('reviewed-production')
  for (const form of Object.values(raw.forms) as any[]) for (const state of Object.values(form.states) as any[]) expect(state.artStatus).toBe('reviewed-production')
  for (const [path, asset] of Object.entries(raw.assets) as [string, any][]) {
    if (path.endsWith('.svg')) expect(asset.artStatus).toBe('normative-placeholder')
    else expect(asset.artStatus).toBe('reviewed-production')
  }
})
