import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonObject, writeJsonAtomic } from '../../lib/json-file'
import type { ProbeHistory, ProbeRecord } from '../../app/first-use-probe'

type ProbeProvider = 'claude' | 'codex'

function validRecord(value: unknown): value is ProbeRecord {
  if (!value || typeof value !== 'object') return false
  const { cliVersion, sdkVersion, model, at } = value as Partial<ProbeRecord>
  return [cliVersion, sdkVersion, model].every(field => typeof field === 'string' && field.trim()) &&
    typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 && at <= 8.64e15
}

/** One daemon owns both entries. Synchronous updates preserve the other provider's entry. */
export function openFirstUseProbeRecords(stateDir: string, onWriteError: () => void): (id: ProbeProvider) => ProbeHistory {
  const path = join(stateDir, 'first-use-probes.json')
  const records: Partial<Record<ProbeProvider, ProbeRecord>> = {}
  try {
    const raw = lstatSync(path).isFile() ? readJsonObject(path) : {}
    for (const id of ['claude', 'codex'] as const) {
      if (validRecord(raw[id])) {
        const { cliVersion, sdkVersion, model, at } = raw[id]
        records[id] = { cliVersion, sdkVersion, model, at }
      }
    }
  } catch { /* A missing or unreadable cache is safe to rebuild. */ }

  const persist = () => {
    try { writeJsonAtomic(path, records) } catch { onWriteError() }
  }
  return id => ({
    read: () => records[id],
    save: record => { records[id] = record; persist() },
    clear: () => {
      if (!records[id]) return
      delete records[id]
      persist()
    },
  })
}
