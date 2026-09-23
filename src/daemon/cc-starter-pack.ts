import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pack from './cc-starter-pack.json'

/** Static import is embedded by Bun compile; scratch never contains user data. */
export function materializeCcStarterPack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-ink-pack-'))
  try {
    const manifest = pack.map(({ png, ...entry }) => {
      writeFileSync(join(dir, entry.file), Buffer.from(png, 'base64'))
      return entry
    })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
    return dir
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}
