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

/** One daemon owns the file. Synchronous updates preserve records for all other models. */
export function openFirstUseProbeRecords(stateDir: string, onWriteError: () => void): (id: ProbeProvider) => ProbeHistory {
  const path = join(stateDir, 'first-use-probes.json')
  const records: Partial<Record<ProbeProvider, ProbeRecord[]>> = {}
  try {
    const raw = lstatSync(path).isFile() ? readJsonObject(path) : {}
    for (const id of ['claude', 'codex'] as const) {
      // The previous format stored a single record per provider.
      const entries = raw[id]
      const valid = (Array.isArray(entries) ? entries : [entries]).filter(validRecord)
      if (valid.length) records[id] = valid.map(({ cliVersion, sdkVersion, model, at }) => ({ cliVersion, sdkVersion, model, at }))
    }
  } catch { /* A missing or unreadable cache is safe to rebuild. */ }

  const persist = () => {
    try { writeJsonAtomic(path, records) } catch { onWriteError() }
  }
  return id => ({
    read: model => records[id]?.find(record => record.model === model),
    save: record => {
      records[id] = [...(records[id] ?? []).filter(entry => entry.model !== record.model), record]
      persist()
    },
    clear: model => {
      const entries = records[id]
      if (!entries?.some(record => record.model === model)) return
      const remaining = entries.filter(record => record.model !== model)
      if (remaining.length) records[id] = remaining
      else delete records[id]
      persist()
    },
  })
}
