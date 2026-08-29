/**
 * env-file.ts — `<stateDir>/daemon.env` loader (2026-08-25, cursor-provider
 * gap): provider API keys (CURSOR_API_KEY / WECHAT_OPENAI_API_KEY /
 * GEMINI_API_KEY …) previously reached the daemon only via inherited shell
 * env — which the launchd/systemd-supervised daemon never has. This gives
 * secrets one local, restart-surviving home: a KEY=VALUE file the owner
 * writes once (chmod 600 recommended), loaded at boot into process.env for
 * keys not already set (real environment always wins).
 *
 * Values never appear in logs — callers log key NAMES only.
 */

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const stripped = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = stripped.indexOf('=')
    if (eq <= 0) continue
    const name = stripped.slice(0, eq).trim()
    if (!NAME_RE.test(name)) continue
    let value = stripped.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[name] = value
  }
  return out
}


/**
 * Update KEY=VALUE lines in an env file body, preserving every other line
 * (comments, blanks, unknown content) byte-for-byte. Existing keys are
 * replaced in place; new keys are appended. Values are written raw (callers
 * pass trimmed secrets; quoting is unnecessary for the daemon's own parser).
 */
export function upsertEnvFile(content: string, updates: Record<string, string>): string {
  const remaining = { ...updates }
  const lines = content.split('\n').map(line => {
    const stripped = (line.trim().startsWith('export ') ? line.trim().slice(7) : line.trim())
    const eq = stripped.indexOf('=')
    if (eq <= 0) return line
    const name = stripped.slice(0, eq).trim()
    if (!(name in remaining)) return line
    const value = remaining[name]!
    delete remaining[name]
    return `${name}=${value}`
  })
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  for (const [name, value] of Object.entries(remaining)) lines.push(`${name}=${value}`)
  return lines.join('\n') + '\n'
}
