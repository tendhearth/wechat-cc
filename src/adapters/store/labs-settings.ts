import { join } from 'node:path'
import { readJsonObject, writeJsonAtomic } from '../../lib/json-file'

export function makeLabsSettings(stateDir: string) {
  const path = join(stateDir, 'labs', 'settings.json')
  return {
    placeMapEnabled() {
      try { return readJsonObject(path).placeMap === true }
      catch { return false }
    },
    setPlaceMap(placeMap: boolean) {
      writeJsonAtomic(path, { placeMap })
    },
  }
}
