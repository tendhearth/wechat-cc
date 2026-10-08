import {createHash} from 'node:crypto'
import type {WorkbenchExecutorCapabilities} from './executor-capabilities'
import {isWorkbenchProviderId} from './executor-capabilities'
import {normalizeExecutionChoice, PROVIDER_EXECUTION_CHOICE} from './execution-settings'
import type {ProjectCatalogEntry} from './project-catalog'
import {validBaseBranch} from './worktree-workspaces'
import {ENTRY_LIMITS, entryContentError,entryErrorStatus as sharedEntryErrorStatus} from '../../../apps/desktop/src/shared/task-entry-contract.js'
export {ENTRY_LIMITS, composeEntryPrompt, entryContentError, entryFailureKind} from '../../../apps/desktop/src/shared/task-entry-contract.js'

/** isolation:'worktree' ⇒ 在这个项目的独立工作区(git worktree)里做,不占项目目录本身(2026-10-07)。 */
export type ExecutionMode = 'auto' | 'isolated' | 'project'
export type EntryTarget = {kind: 'managed'} | {kind: 'project'; projectId: string; isolation?: 'worktree';base?:string}
export type EntryExcerpt = {role: 'user' | 'assistant'; text: string}
export type EntryInput = {
  requestId: string
  text: string
  title?: string
  target: EntryTarget
  providerId?: string
  execution?: unknown
  executionMode?: ExecutionMode
  draftId?: string
  attachmentIds?: string[]
  context?: {source: 'owner-chat'; excerpts: EntryExcerpt[]}
}
export type EntryContext = {ownerKey: string; surface: 'desktop' | 'phone' | 'wechat'}
export type EntryReceipt = {
  requestId: string
  taskId: string
  matterId: string
  runId: string
  acceptedAt: number
}
export type EntryOptions = {
  status: 'ready' | 'needs_connection'
  reason?: {code: string; message: string}
  defaultProviderId: string | null
  providers: {
    id: string
    displayName: string
    available: boolean
    unavailableReason?: {code: string; message: string}
    capabilities: WorkbenchExecutorCapabilities
  }[]
  projects: ProjectCatalogEntry[]
}

// Match the existing attachment UUID contract; new clients generate v4 IDs.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const ENTRY_KEYS = ['requestId', 'text', 'title', 'target', 'providerId', 'execution', 'draftId', 'attachmentIds', 'context', 'executionMode']
const EXECUTION_KEYS = ['defaults', 'model', 'reasoningEffort'] as const

function record(value: unknown, keys: readonly string[], error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(error)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw Error(error)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) throw Error(error)
  return value as Record<string, unknown>
}

function uuid(value: unknown, error: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw Error(error)
  return value.toLowerCase()
}

function target(value: unknown): EntryTarget {
  const input = record(value, ['kind', 'projectId', 'isolation', 'base'], 'invalid_target')
  if (input.kind === 'managed') {
    if (Object.hasOwn(input, 'projectId') || Object.hasOwn(input, 'isolation') || Object.hasOwn(input, 'base')) throw Error('invalid_target')
    return {kind: 'managed'}
  }
  if (input.kind !== 'project' || typeof input.projectId !== 'string' || !/^p-[a-f0-9]{20}$/.test(input.projectId)) {
    throw Error('invalid_target')
  }
  if (input.isolation !== undefined && input.isolation !== 'worktree') throw Error('invalid_target')
  if (input.base !== undefined && (input.isolation !== 'worktree' || !validBaseBranch(input.base))) throw Error('invalid_target')
  return input.isolation === 'worktree' ? {kind: 'project', projectId: input.projectId, isolation: 'worktree', ...(input.base !== undefined ? {base: input.base as string} : {})} : {kind: 'project', projectId: input.projectId}
}

function context(value: unknown): NonNullable<EntryInput['context']> {
  const input = record(value, ['source', 'excerpts'], 'invalid_context')
  if (input.source !== 'owner-chat' || !Array.isArray(input.excerpts) || input.excerpts.length > ENTRY_LIMITS.excerpts) {
    throw Error('invalid_context')
  }
  let length = 0
  const excerpts = Array.from(input.excerpts, value => {
    const excerpt = record(value, ['role', 'text'], 'invalid_context')
    if ((excerpt.role !== 'user' && excerpt.role !== 'assistant') || typeof excerpt.text !== 'string') {
      throw Error('invalid_context')
    }
    length += excerpt.text.length
    if (length > ENTRY_LIMITS.context) throw Error('invalid_context')
    return {role: excerpt.role, text: excerpt.text} satisfies EntryExcerpt
  })
  return {source: 'owner-chat', excerpts}
}

/** Shape-only normalization. Ownership, catalog membership and materials are checked by the service. */
export function parseEntryInput(value: unknown): EntryInput {
  const input = record(value, ENTRY_KEYS, 'invalid_entry')
  const requestId = uuid(input.requestId, 'invalid_request_id')
  if (typeof input.text !== 'string' || input.text.length > ENTRY_LIMITS.text) throw Error('invalid_text')
  const parsed: EntryInput = {requestId, text: input.text, target: target(input.target)}
  if (input.executionMode !== undefined) {
    if (!['auto','isolated','project'].includes(input.executionMode as string)) throw Error('invalid_execution_mode')
    parsed.executionMode = input.executionMode as ExecutionMode
  }
  if (parsed.target.kind === 'project' && parsed.target.isolation === 'worktree' && parsed.executionMode === 'project') throw Error('invalid_execution_mode')
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > ENTRY_LIMITS.title) throw Error('invalid_title')
    parsed.title = input.title.trim()
  }
  if (input.providerId !== undefined) {
    if (!isWorkbenchProviderId(input.providerId)) throw Error('invalid_provider')
    parsed.providerId = input.providerId
  }
  if (input.execution !== undefined) {
    const explicit = record(input.execution, EXECUTION_KEYS, 'invalid_execution')
    const normalized = normalizeExecutionChoice(explicit, PROVIDER_EXECUTION_CHOICE)
    // Validate with the normalizer, but never fill omitted choices into the user's request/hash.
    parsed.execution = Object.fromEntries(EXECUTION_KEYS.filter(key => Object.hasOwn(explicit, key))
      .map(key => [key, normalized[key]]))
  }
  if (input.draftId !== undefined) parsed.draftId = uuid(input.draftId, 'invalid_attachment')
  if (input.attachmentIds !== undefined) {
    if (!Array.isArray(input.attachmentIds) || input.attachmentIds.length > ENTRY_LIMITS.attachments) throw Error('invalid_attachment')
    const ids = Array.from(input.attachmentIds, value => uuid(value, 'invalid_attachment'))
    if (new Set(ids).size !== ids.length) throw Error('invalid_attachment')
    parsed.attachmentIds = ids
  }
  if (!parsed.text.trim() && !parsed.attachmentIds?.length) throw Error('invalid_text')
  if (input.context !== undefined) parsed.context = context(input.context)
  const contentError = entryContentError(parsed)
  if (contentError) throw Error(contentError)
  return parsed
}

/** requestId is the separate idempotency key; this hash covers the canonical request content. */
export function canonicalEntryHash(input: EntryInput): string {
  const {requestId: _requestId, ...content} = parseEntryInput(input)
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

/** v1 hashes above are immutable for existing reservations. New requests freeze auto explicitly. */
export function canonicalEntryHashV2(input: EntryInput, legacyPath?: string): string {
  const {requestId: _id, executionMode, ...content} = parseEntryInput(input)
  return createHash('sha256').update(JSON.stringify({...content,executionMode:executionMode ?? 'auto',...(legacyPath?{legacyPath}:{})})).digest('hex')
}

/** Admission codes shared by HTTP and phone, including native workspace failures. */
export function entryErrorStatus(code:string):number|undefined {
 if(['worktree_base_unsupported','git_workspace_source_unsupported','configuration_not_reproducible','git_workspace_configuration_rejected'].includes(code))return 422
 if(['git_workspace_binding_required','git_workspace_changed','git_workspace_conflict','git_workspace_needs_recovery','git_workspace_configuration_changed'].includes(code))return 409
 if(['git_timeout','git_unavailable','git_output_limit'].includes(code))return 503
 if(code==='invalid_execution_mode')return 400
 return sharedEntryErrorStatus(code)
}
