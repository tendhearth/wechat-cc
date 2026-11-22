import { join } from 'node:path'
import { readJsonObject, writeJsonAtomic } from '../../lib/json-file'

export function makeRecapSettings(stateDir: string) {
  const path = join(stateDir, 'recap', 'settings.json')
  return {
    enabled() {
      try { return readJsonObject(path).recap !== false } catch { return false }
    },
    setEnabled: (recap: boolean) => writeJsonAtomic(path, { recap }),
  }
}
