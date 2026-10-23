/** Per-chat generation fence. Raw generated files remain on disk for review. */
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from './read-json-file'
import { writeFileAtomic } from './json-file'

type DerivedKind = 'overview' | 'profile'
/**
 * 为什么过期(3e 记忆第 2 步,整合者定):
 * - added:源里多了东西(nightly 整理、CC 写笔记、gardener 压缩、导入)—— 旧生成物只是不全,不是错,贴一句标签照常用;
 * - retracted:主人删了 / 改了东西(纠正、过期、桌面编辑)—— 旧生成物里可能正好有主人要 CC 忘掉的那句,而总览会进串门人设、
 *   带到别人的 CC 那里去,所以藏起来,重新生成以后再给。
 * 一个生成物只要在这段过期里碰到过一次 retracted 就一直是 retracted,直到它重新生成。
 */
export type InvalidationReason = 'added' | 'retracted'
export type DerivedStatus = 'fresh' | 'added' | 'retracted'
interface DerivedState { version: 1; revision: string; overview: string | null; profile: string | null; retracted?: { overview?: boolean; profile?: boolean } }
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
  writeFileAtomic(path, JSON.stringify(state), { mode: 0o600 })
}

export function readDerivedRevision(memoryRoot: string): string {
  return readState(memoryRoot)?.revision ?? 'corrupt'
}

/** Persist before editing a source: any interrupted edit remains conservative. 缺省 retracted(往藏的方向兜底)。 */
export function invalidateDerivedMemory(memoryRoot: string, reason: InvalidationReason = 'retracted'): void {
  const prev = readState(memoryRoot)
  // 已经因为 retracted 过期、还没重新生成的,别被一次 added 冲掉;老版本没记原因的过期也按 retracted 算。
  const carry = (k: DerivedKind) => reason === 'retracted' || !prev || (prev[k] !== prev.revision && (prev.retracted?.[k] ?? true))
  writeState(memoryRoot, { version: 1, revision: randomUUID(), overview: null, profile: null, retracted: { overview: carry('overview'), profile: carry('profile') } })
}

/** fresh / added(不全,贴标签用)/ retracted(藏起来)。围栏坏了按 retracted。 */
export function derivedMemoryStatus(memoryRoot: string, kind: DerivedKind): DerivedStatus {
  const state = readState(memoryRoot)
  if (!state) return 'retracted'
  if (state[kind] === state.revision) return 'fresh'
  return (state.retracted?.[kind] ?? true) ? 'retracted' : 'added'
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
  writeState(memoryRoot, { ...state, [kind]: expectedRevision, retracted: { ...(state.retracted ?? {}), [kind]: false } })
  return true
}
