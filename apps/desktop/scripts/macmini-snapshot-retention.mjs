import * as nativeFs from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { isInsideLab } from './macmini-ui-protocol.mjs'

const snapshotName = /^(app|browser)-[0-9a-f]{40}-([0-9]+)$/

function* pathReferences(value) {
  if (typeof value === 'string' && isAbsolute(value)) yield value
  else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) yield* pathReferences(child)
  }
}

// A receipt path may be missing even though the snapshot containing it exists.
async function resolveExistingAncestor(path, fs) {
  try {
    return await fs.realpath(path)
  } catch (error) {
    const parent = dirname(path)
    if (error.code !== 'ENOENT' || parent === path) throw error
    return resolveExistingAncestor(parent, fs)
  }
}

/** Best-effort retention after active.json has been replaced, under the machine lock. */
export async function pruneInactiveSnapshots(labHome, { fs = nativeFs, warn = console.warn } = {}) {
  const report = (path, error) => warn(JSON.stringify({ step: 'prune-snapshots', path, error: String(error) }))
  const snapshots = []
  const referenced = new Set()
  let lab, names
  try {
    lab = await fs.realpath(labHome)
    const active = JSON.parse(await fs.readFile(join(lab, 'active.json'), 'utf8'))
    if (!active || typeof active !== 'object' || Array.isArray(active)) throw Error('Invalid active.json')
    const protect = (root, path) => {
      if (isInsideLab(root, path)) referenced.add(relative(root, path).split(sep)[0])
    }
    for (const path of pathReferences(active)) {
      protect(labHome, path)
      protect(lab, path)
      protect(lab, await resolveExistingAncestor(path, fs))
    }
    names = await fs.readdir(lab)
  } catch (error) {
    report(labHome, error)
    return
  }

  for (const name of names) {
    const match = snapshotName.exec(name)
    if (!match || referenced.has(name)) continue
    const path = join(lab, name)
    try {
      if ((await fs.lstat(path)).isDirectory() && await fs.realpath(path) === path) {
        snapshots.push({ path, kind: match[1], timestamp: BigInt(match[2]) })
      }
    } catch (error) {
      report(path, error)
    }
  }

  snapshots.sort((a, b) => a.timestamp === b.timestamp
    ? a.path.localeCompare(b.path)
    : a.timestamp > b.timestamp ? -1 : 1)
  const kept = { app: 0, browser: 0 }
  for (const { path, kind } of snapshots) {
    if (kept[kind]++ < 2) continue
    try {
      await fs.rm(path, { recursive: true, force: true })
    } catch (error) {
      report(path, error)
    }
  }
}
