import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonObject, writeJsonAtomic } from '../../lib/json-file'
import { probeCombinationKey, type ProbeHistory, type ProbeRecord } from '../../app/first-use-probe'

type ProbeProvider = 'claude' | 'codex'

function validRecord(value: unknown): value is ProbeRecord {
  if (!value || typeof value !== 'object') return false
  const { cliVersion, sdkVersion, model, endpoint, at } = value as Partial<ProbeRecord>
  return [cliVersion, sdkVersion, model].every(field => typeof field === 'string' && field.trim()) &&
    (endpoint === undefined || endpoint === 'native' || (typeof endpoint === 'string' && /^[a-f0-9]{64}$/.test(endpoint))) &&
    typeof at === 'number' && Number.isSafeInteger(at) && at >= 0 && at <= 8.64e15
}

/** One daemon owns the file. Updates preserve other models and endpoints. */
export function openFirstUseProbeRecords(stateDir: string, onWriteError: () => void): (id: ProbeProvider) => ProbeHistory {
  const path = join(stateDir, 'first-use-probes.json')
  const records: Partial<Record<ProbeProvider, ProbeRecord[]>> = {}
  try {
    const raw = lstatSync(path).isFile() ? readJsonObject(path) : {}
    for (const id of ['claude', 'codex'] as const) {
      // The previous format stored a single record per provider.
      const entries = raw[id]
      const valid = (Array.isArray(entries) ? entries : [entries]).filter(validRecord)
      if (valid.length) records[id] = valid.map(({ cliVersion, sdkVersion, model, endpoint, at, confirmedByTurn }) => ({
        cliVersion, sdkVersion, model, endpoint, at, ...(confirmedByTurn === true ? { confirmedByTurn } : {}),
      }))
    }
  } catch { /* A missing or unreadable cache is safe to rebuild. */ }

  const persist = () => {
    try { writeJsonAtomic(path, records) } catch { onWriteError() }
  }
  return id => ({
    read: target => records[id]?.find(record => probeCombinationKey(record) === probeCombinationKey(target)),
    save: record => {
      records[id] = [...(records[id] ?? []).filter(entry =>
        !(entry.model === record.model && (entry.endpoint === undefined ||
          (entry.endpoint === record.endpoint && (!entry.confirmedByTurn || entry.sdkVersion !== record.sdkVersion)))) &&
        probeCombinationKey(entry) !== probeCombinationKey(record)), record]
      persist()
    },
    clear: target => {
      const entries = records[id]
      if (!entries) return
      const remaining = entries.filter(record => probeCombinationKey(record) !== probeCombinationKey(target))
      if (remaining.length === entries.length) return
      if (remaining.length) records[id] = remaining
      else delete records[id]
      persist()
    },
  })
}
