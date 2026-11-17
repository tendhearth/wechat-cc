/** A non-secret success receipt from the visible Grok login, not a new network probe.
 * Presence of old auth.json alone cannot prove that this login succeeded.
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export interface CliSetupReceipt { command: string; completed(): boolean; dispose(): void }
export function makeCliSetupReceipt(stateDir: string, platform: string): CliSetupReceipt {
  const dir = join(stateDir, 'cli-setup')
  mkdirSync(dir, { mode: 0o700, recursive: true })
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('invalid_setup_receipt_directory')
  chmodSync(dir, 0o700)
  const path = join(dir, randomUUID() + '.ok')
  const quote = (v: string) => "'" + v.replaceAll("'", platform === 'win32' ? "''" : "'\\''") + "'"
  const expires = Date.now() + 15 * 60_000
  let done = false, disposed = false
  const dispose = () => { disposed = true; try { unlinkSync(path) } catch { /* no receipt yet */ } }
  return {
    command: platform === 'win32' ? `[System.IO.File]::WriteAllText(${quote(path)}, 'ok')` : `printf ok > ${quote(path)}`,
    completed() {
      if (disposed || Date.now() > expires) { dispose(); return false }
      if (done) return true
      try {
        const file = lstatSync(path)
        done = file.isFile() && !file.isSymbolicLink() && file.size === 2 && readFileSync(path, 'utf8') === 'ok'
        if (done) unlinkSync(path)
      } catch { /* not finished, cancelled, or failed login */ }
      return done
    },
    dispose,
  }
}
