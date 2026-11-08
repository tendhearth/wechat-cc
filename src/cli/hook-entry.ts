import { STATE_DIR } from '../lib/config'
import { readStdin } from './stdin'
import { shouldSkipHook } from './hook-api'
import { sessionStartBudget } from './hook-session-start-budget'
import type { HookSource } from './hook'

/** Read once before choosing the tiny SessionStart path or the existing event relay. */
export async function runHookEntry(source: HookSource): Promise<void> {
  if (shouldSkipHook(process.env)) return
  const budget = sessionStartBudget()
  const remaining = () => budget.hardMs - process.uptime() * 1000
  let deadline: ReturnType<typeof setTimeout> | undefined
  if (source !== 'cursor') {
    if (remaining() <= 0) return
    // Also bounds a pipe that never reaches EOF. Ordinary relays drop this limit after parsing.
    deadline = setTimeout(() => process.exit(0), remaining())
  }
  try {
    const raw = await readStdin()
    const stdinReadyAt = performance.now()
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch {
      if (process.env.WECHAT_CC_HOOK_DEBUG === '1') console.error('hook: stdin is not JSON')
      return
    }
    if (source !== 'cursor' && parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).hook_event_name === 'SessionStart') {
      if (deadline !== undefined) clearTimeout(deadline)
      if (remaining() <= 0) return
      deadline = setTimeout(() => process.exit(0), Math.min(budget.softMs, remaining()))
      try {
        const { sessionStartOutput } = await import('./hook-session-start')
        const timeoutMs = Math.min(budget.requestMs - (performance.now() - stdinReadyAt), remaining())
        if (timeoutMs <= 0) return
        const output = await sessionStartOutput(STATE_DIR, source, parsed, { timeoutMs, deadlineAt: stdinReadyAt + budget.requestMs })
        if (output) process.stdout.write(output + '\n')
      } catch { /* startup failures are silent, including in debug mode */ }
      return
    }
    if (deadline !== undefined) { clearTimeout(deadline); deadline = undefined }
    const { relayHookPayload } = await import('./hook-relay')
    await relayHookPayload(source, parsed)
  } catch (err) {
    if (process.env.WECHAT_CC_HOOK_DEBUG === '1') console.error(`hook: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (deadline !== undefined) clearTimeout(deadline)
  }
}
