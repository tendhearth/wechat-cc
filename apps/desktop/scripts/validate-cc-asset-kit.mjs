import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { normalizeManifest } from '../src/pet/assets/manifest-loader.js'
import { validateCCMetadata } from '../src/pet/assets/cc-contract.js'
import { CANVAS, VIEWS, geometry } from '../src/assets/pet/cc-v1/placeholder.js'
import { readRGBA } from './cc-png.mjs'

const defaultRoot = fileURLToPath(new URL('../src/assets/pet/cc-v1/', import.meta.url))
/** @param {string | Buffer} s */
const hash = (s) => createHash('sha256').update(s).digest('hex')
/** @param {string} p */
/** 去 BOM 再 parse,同 src/lib/read-json-file.ts 契约。 @param {string} text */
const parseJson = (text) => JSON.parse(text.replace(/^\uFEFF/, ''))
/** @param {string} p */
const realpathOrSelf = (p) => { try { return realpathSync(p) } catch { return p } }

/** Release check is stricter than the fail-soft runtime. It never certifies bitmap anatomy. */
export function validateAssetKit(root = defaultRoot) {
  /** @type {string[]} */ const errors = []
  /** @type {string[]} */ const warnings = []
  let raw
  // 仓库守卫不许直接 parse 刚读出的文件文本:Windows 上 PowerShell 写出的 JSON 带 BOM。
  // 这是 Node 脚本,进不了 src/lib/read-json-file.ts,就地去 BOM,契约相同。
  try { raw = parseJson(readFileSync(resolve(root, 'manifest.json'), 'utf8')) } catch (e) { return { errors: [`manifest:${String(e)}`], warnings } }
  errors.push(...validateCCMetadata(raw))
  if (JSON.stringify(raw.canvas) !== JSON.stringify(CANVAS)) errors.push('canvas:registration_changed')
  const normalized = normalizeManifest(raw)
  if (!normalized.ok) return { errors: [...errors, normalized.reason], warnings }
  warnings.push(...normalized.manifest.warnings)
  // 设计板(母版 / 形象板)是品牌资产,不进公开仓库,私有目录见 cc-v1/README。manifest 只留 sha256 作来源凭证:
  // 文件在就校验摘要,不在就记一条 warning 跳过,不算错误。
  const boards = [raw.reference?.path, ...(Array.isArray(raw.designSheets) ? raw.designSheets.map((s) => s?.path) : [])].filter((p) => typeof p === 'string')
  const paths = new Set(boards.filter((p) => existsSync(resolve(root, p))))
  for (const p of boards) if (!paths.has(p)) warnings.push(`reference_absent:${p}`)
  for (const form of /** @type {const} */ (['lit', 'unlit'])) {
    const required = form === 'lit' ? ['idle', 'blink', 'look', 'receive', 'thinking', 'working', 'done', 'sleep', 'permission', 'error'] : ['idle', 'blink', 'working', 'sleep']
    for (const state of required) if (!normalized.manifest.forms[form].states[state]?.frames.length) errors.push(`state_missing:${form}/${state}`)
    for (const view of VIEWS) {
      const p = raw.turnarounds?.[form]?.[view]
      if (!p) errors.push(`canonical_missing:${form}/${view}`)
      else paths.add(p)
    }
    const f = normalized.manifest.forms[form]
    paths.add(f.master)
    for (const a of Object.values(f.states)) for (const p of a.frames) paths.add(p)
  }
  if (!normalized.manifest.transitions['unlit-to-lit']?.frames.length) errors.push('transition_missing:unlit-to-lit')
  for (const a of Object.values(normalized.manifest.transitions)) for (const p of a.frames) paths.add(p)
  const characterPaths = new Set(paths)
  for (const p of Object.values(normalized.manifest.props)) paths.add(p)
  for (const p of Object.keys(raw.assets ?? {})) paths.add(p)
  const contents = new Map()
  const pixels = new Map()
  for (const p of paths) {
    try {
      if (typeof p !== 'string' || !p || p.includes('://') || p.startsWith('data:')) throw Error('not a packaged path')
      const path = realpathSync(resolve(root, p))
      // Only the kit and existing sibling standalone props may be referenced.
      // Both sides must be realpath'd: macOS tmpdir is a symlink (/var → /private/var),
      // so comparing a resolved file path against an unresolved props dir never matches.
      const local = path.startsWith(realpathSync(root) + sep)
      const prop = path.startsWith(realpathOrSelf(resolve(dirname(root), 'props')) + sep)
      if (!local && !prop) throw Error('outside kit/props')
      const bytes = readFileSync(path)
      contents.set(p, bytes)
      const board = p === raw.reference?.path ? raw.reference : (Array.isArray(raw.designSheets) ? raw.designSheets.find((s) => s?.path === p) : undefined)
      if (board) { if (hash(bytes) !== board.sha256) errors.push(`reference:digest:${p}`); continue }
      const meta = raw.assets?.[p]
      if (local && !meta) errors.push(`asset_metadata_missing:${p}`)
      if (meta && hash(bytes) !== meta.sha256) errors.push(`digest:${p}`)
      if (prop) {
        if (characterPaths.has(p)) errors.push(`prop_as_character:${p}`)
        if (!meta) errors.push(`asset_metadata_missing:${p}`)
        else {
          if (meta.kind !== 'prop') errors.push(`prop_kind:${p}`)
          if (!meta.visualReview?.reviewer || !meta.visualReview?.reviewedAt || meta.visualReview?.referenceSha256 !== raw.reference?.sha256) errors.push(`visual_review_missing:${p}`)
        }
        try {
          const decoded = readRGBA(bytes, 384)
          if (!decoded.alpha.some(a => a)) errors.push(`prop_empty:${p}`)
          if (decoded.alpha.some((a, i) => a && (i % 384 < 12 || i % 384 >= 372 || Math.floor(i / 384) < 12 || Math.floor(i / 384) >= 372))) errors.push(`prop_padding:${p}`)
        } catch (e) { errors.push(`prop_png:${p}:${String(e)}`) }
        continue
      }
      if (meta && p.endsWith('.png')) {
        try {
          const decoded = readRGBA(bytes)
          pixels.set(p, decoded)
          if (decoded.alpha.some((a, i) => a && (i % 512 < 80 || i % 512 >= 432 || Math.floor(i / 512) < 28 || Math.floor(i / 512) >= 470))) errors.push(`png_safe_bbox:${p}`)
          if (!decoded.alpha.some(a => a)) errors.push(`png_empty:${p}`)
        } catch (e) { errors.push(`png_decode:${p}:${String(e)}`) }
        if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== 512 || bytes.readUInt32BE(20) !== 512 || bytes[25] !== 6) errors.push(`png_rgba_dimensions:${p}`)
        if (!p.startsWith('masks/')) {
          if (typeof meta.geometryMask !== 'string' || !raw.assets?.[meta.geometryMask] || !meta.geometryMask.startsWith('masks/') || !meta.geometryMask.endsWith('.png')) errors.push(`geometry_mask_missing:${p}`)
          if (!meta.visualReview?.reviewer || !meta.visualReview?.reviewedAt || meta.visualReview?.referenceSha256 !== raw.reference?.sha256) errors.push(`visual_review_missing:${p}`)
        }
      }
      if (p.endsWith('.svg') && meta) {
        const svg = bytes.toString('utf8')
        if (!svg.includes('width="512" height="512" viewBox="0 0 512 512"')) errors.push(`dimensions:${p}`)
        const actual = svg.match(/<g id="geometry">[\s\S]*?<\/g>/)?.[0]
        if (!actual || hash(actual) !== meta.geometrySha256) errors.push(`geometry_digest:${p}`)
        // Structural proof is limited to this controlled vector placeholder source.
        // All geometry must exactly match the shared generator, including occlusion.
        if (meta.artStatus === 'normative-placeholder' && actual !== geometry(meta.view, meta.expression, p.startsWith('masks/'))) errors.push(`geometry_source:${p}`)
        if (/<(?:script|image|foreignObject)\b|\son\w+=/i.test(svg)) errors.push(`svg_active_content:${p}`)
      }
    } catch (e) { errors.push(`path:${p}:${String(e)}`) }
  }
  for (const [p, decoded] of pixels) {
    const mask = raw.assets[p]?.geometryMask
    if (typeof mask === 'string' && mask.endsWith('.png')) {
      const entity = pixels.get(mask)?.alpha
      // Entity coverage includes antialiasing, but excludes glow/rim/shadow.
      // Effects may increase edge/exterior alpha without eroding the entity.
      if (!entity || decoded.alpha.some((alpha, i) => alpha < entity[i]
        || (entity[i] >= 250 && alpha !== entity[i])
        || (entity[i] === 0 && alpha > 89))) errors.push(`png_alpha_mask:${p}`)
    }
  }
  for (const view of VIEWS) {
    const pair = ['lit', 'unlit'].map((form) => raw.turnarounds?.[form]?.[view])
    if (pair.every((p) => p?.endsWith('.svg'))) {
      const extract = (/** @type {string} */ p) => contents.get(p)?.toString('utf8').match(/<g id="geometry">[\s\S]*?<\/g>/)?.[0]
      if (!extract(pair[0]) || extract(pair[0]) !== extract(pair[1])) errors.push(`pair_geometry:${view}`)
    } else {
      const masks = pair.map((p) => raw.assets?.[p]?.geometryMask)
      if (!masks[0] || masks[0] !== masks[1] || !contents.has(masks[0])) errors.push(`pair_geometry_mask:${view}`)
      warnings.push(`bitmap_geometry_attestation_only:${view}`)
    }
  }
  // Match corresponding state frames by semantic identity, not filenames.
  // Repeated expressions retain their sequence order within each group.
  const groups = (form) => {
    const result = new Map()
    for (const [state, animation] of Object.entries(normalized.manifest.forms[form].states)) {
      for (const path of animation.frames) {
        if (!path.endsWith('.png')) continue
        const meta = raw.assets?.[path]
        const key = `${state}/${meta?.view ?? ''}/${meta?.expression ?? ''}`
        if (!result.has(key)) result.set(key, [])
        result.get(key).push(meta?.geometryMask)
      }
    }
    return result
  }
  const litFrames = groups('lit'), unlitFrames = groups('unlit')
  for (const [key, litMasks] of litFrames) {
    const unlitMasks = unlitFrames.get(key)
    if (!unlitMasks) continue
    for (let i = 0; i < Math.min(litMasks.length, unlitMasks.length); i++) {
      if (!litMasks[i] || litMasks[i] !== unlitMasks[i]) errors.push(`pair_geometry_mask:state:${key}:${i}`)
    }
  }
  warnings.push('Visual review required: metadata and hashes do not prove anatomy of arbitrary bitmap art.')
  if (raw.artStatus === 'normative-placeholder') warnings.push('Production art remains pending; this is a runnable normative placeholder kit.')
  return { errors, warnings, assetCount: Object.keys(raw.assets ?? {}).length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = validateAssetKit(process.argv[2] ? resolve(process.argv[2]) : defaultRoot)
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.errors.length ? 1 : 0
}
