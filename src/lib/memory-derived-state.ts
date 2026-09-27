/** Per-chat generation fence. Raw generated files remain on disk for review. */
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from './read-json-file'

type DerivedKind = 'overview' | 'profile'
interface DerivedState { version: 1; revision: string; overview: string | null; profile: string | null }
const STATE_FILE = '.derived-state.json'
const INITIAL = 'initial'

function readState(root: string): DerivedState | null {
  const path = join(root, STATE_FILE)
  try {
    if (!lstatSync(path).isFile()) return null
    const value = readJsonFile(path) as DerivedState
    if (value.version !== 1 || typeof value.revision !== 'string' || !value.revision ||
      ![value.overview, value.profile].every(v => v === null || typeof v === 'string')) return null
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, revision: INITIAL, overview: INITIAL, profile: INITIAL }
    }
    return null
  }
}

function writeState(root: string, state: DerivedState): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = join(root, STATE_FILE)
  const tmp = `${path}.tmp-${randomUUID()}`
  writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  renameSync(tmp, path)
}

export function readDerivedRevision(memoryRoot: string): string {
  return readState(memoryRoot)?.revision ?? 'corrupt'
}

/** Persist before editing a source: any interrupted edit remains conservative. */
export function invalidateDerivedMemory(memoryRoot: string): void {
  writeState(memoryRoot, { version: 1, revision: randomUUID(), overview: null, profile: null })
}

/** Explicit generation may repair a corrupt fence, but never bless old artifacts. */
export function beginDerivedGeneration(memoryRoot: string): string {
  if (!readState(memoryRoot)) invalidateDerivedMemory(memoryRoot)
  return readDerivedRevision(memoryRoot)
}

export function isDerivedMemoryStale(memoryRoot: string, kind: DerivedKind): boolean {
  const state = readState(memoryRoot)
  return !state || state[kind] !== state.revision
}

/** No await between revision comparison, artifact write and freshness marker. */
export function commitDerivedMemory(memoryRoot: string, kind: DerivedKind, expectedRevision: string, write: () => void): boolean {
  const state = readState(memoryRoot)
  if (!state || state.revision !== expectedRevision) return false
  write()
  // A synchronous writer may itself invalidate; never undo its newer fence.
  if (readDerivedRevision(memoryRoot) !== expectedRevision) return false
  writeState(memoryRoot, { ...state, [kind]: expectedRevision })
  return true
}
