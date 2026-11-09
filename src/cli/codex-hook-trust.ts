/** Read-only mirror of openai/codex rust-v0.144.4 / rust-v0.167.0 trust identities.
 * See docs/reference/codex-hook-trust.md. Never writes config.toml or grants trust.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse } from 'smol-toml'
import { ownedHookDefinitions } from './hook'
import { readJsonFile } from '../lib/read-json-file'
import { writeFileAtomic } from '../lib/json-file'

import type { CodexTrustState, CodexHookTrust } from '../domain/codex-hook-trust'
export { codexTrustMessage, type CodexHookTrust } from '../domain/codex-hook-trust'
type Options = { evidenceFile?: string; version?: string | null }
const labels: Record<string, string> = { SessionStart: 'session_start', Stop: 'stop', PermissionRequest: 'permission_request', UserPromptSubmit: 'user_prompt_submit', SessionEnd: 'session_end' }
const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, sorted(x)])) : v
const digest = (v: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(sorted(v))).digest('hex')}`
const legacy = (version?: string | null) => /(?:^|\s)(?:codex-cli )?0\.144\.4(?:$|\s)/.test(version ?? '')
const known = (version?: string | null) => legacy(version) || /(?:^|\s)(?:codex-cli )?0\.167\.0(?:$|\s)/.test(version ?? '')
const versionKey = (version?: string | null) => version?.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? version ?? null

export function codexHookDefinitions(file: string, version?: string | null) {
  return ownedHookDefinitions(file, 'codex').flatMap(d => {
    const h = d.handler, event = labels[d.event]
    if (!event || (legacy(version) && (d.event === 'SessionEnd' || h.async === true))) return []
    const timeout = typeof h.timeout === 'number' ? h.timeout : d.event === 'SessionEnd' && !legacy(version) ? 1 : 600
    const normalized: Record<string, unknown> = {
      type: 'command', command: process.platform === 'win32' ? h.commandWindows ?? h.command_windows ?? h.command : h.command,
      timeout: d.event === 'SessionEnd' && !legacy(version) ? Math.max(1, Math.min(3, timeout)) : Math.max(1, timeout), async: h.async ?? false,
      ...(typeof h.statusMessage === 'string' ? { statusMessage: h.statusMessage } : {}),
    }
    if (!legacy(version) && ['SessionStart', 'UserPromptSubmit'].includes(d.event) && typeof h.additionalContextLimit === 'number' && h.additionalContextLimit !== 2500) normalized.additionalContextLimit = h.additionalContextLimit
    const matcher = ['SessionStart', 'PermissionRequest', ...(!legacy(version) ? ['SessionEnd'] : [])].includes(d.event) ? d.matcher : undefined
    return [{ event: d.event, key: `${file}:${event}:${d.groupIndex}:${d.handlerIndex}`, hash: digest({ event_name: event, ...(typeof matcher === 'string' ? { matcher } : {}), hooks: [normalized] }) }]
  })
}

/** Includes raw owned definitions and positions; evidence cannot survive any definition change. */
function fingerprint(file: string): string { return digest({ file, definitions: ownedHookDefinitions(file, 'codex') }) }
export function codexEvidencePath(stateDir: string): string { return join(stateDir, 'codex-hook-evidence.json') }

export function recordCodexHookDefinitionChange(evidenceFile: string): void {
  try {
    mkdirSync(dirname(evidenceFile), { recursive: true })
    writeFileAtomic(evidenceFile, JSON.stringify({ fingerprint: 'definition-changed', changedAt: Date.now() }) + '\n')
  } catch { /* Install succeeds even when optional local evidence is unwritable. */ }
}

/** Called only after a validated local Codex request reaches the daemon. CC's file, not Codex's trust store. */
export function recordCodexHookInvocation(file: string, evidenceFile: string, version?: string | null): void {
  try {
    const definitions = ownedHookDefinitions(file, 'codex')
    if (!definitions.length) return
    mkdirSync(dirname(evidenceFile), { recursive: true })
    writeFileAtomic(evidenceFile, JSON.stringify({ fingerprint: fingerprint(file), version: versionKey(version), observedAt: Date.now() }) + '\n')
  } catch { /* Optional evidence must never delay or fail the hook. */ }
}

export function readCodexHookTrust(file: string, options: Options = {}): CodexHookTrust {
  const result = (state: CodexTrustState, evidence: CodexHookTrust['evidence'], disabled = false): CodexHookTrust => ({ state, evidence, ...(disabled ? { disabled: true } : {}), version: options.version ?? null })
  let observed: string | undefined
  let observedVersion: string | null | undefined
  try {
    if (options.evidenceFile) {
      const saved = readJsonFile<{ fingerprint: string; version?: string | null }>(options.evidenceFile)
      observed = saved.fingerprint; observedVersion = saved.version
    }
  } catch { /* no evidence */ }
  let current: string
  try { current = fingerprint(file) } catch { return result('untrusted', 'none') }
  let config: Record<string, any> | undefined
  try {
    const path = join(dirname(file), 'config.toml'), st = statSync(path)
    if (!st.isFile() || st.size > 2 * 1024 * 1024) throw Error('not_small_config')
    config = parse(readFileSync(path, 'utf8'))
  } catch { /* Missing, inaccessible or future config: use local invocation evidence only. */ }
  if ((config?.features?.hooks ?? config?.features?.codex_hooks) === false) return result('untrusted', 'config', true)
  const states = config?.hooks?.state ?? {}
  const defs = codexHookDefinitions(file, options.version)
  if (defs.some(d => states[d.key]?.enabled === false)) return result('untrusted', 'config', true)
  if (config && known(options.version)) {
    if (defs.length > 0 && defs.every(d => states[d.key]?.trusted_hash === d.hash)) return result('trusted', 'config')
    const changed = defs.some(d => typeof states[d.key]?.trusted_hash === 'string' && states[d.key].trusted_hash !== d.hash)
      || Object.entries(states).some(([key, state]: [string, any]) => key.startsWith(`${file}:`) && defs.some(d => d.hash === state?.trusted_hash && d.key !== key))
    return result(changed || (!!observed && observed !== current) ? 'changed' : 'untrusted', 'config')
  }
  if (observed === current && observedVersion === versionKey(options.version)) return result('trusted', 'invocation')
  return result(observed ? 'changed' : 'untrusted', 'none')
}
