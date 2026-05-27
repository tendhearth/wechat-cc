/**
 * log.ts — CLI entry point for writing a single log line to channel.log
 * from external callers (e.g. the desktop frontend via `wechat-cc log`).
 *
 * Used by Step 4 (RECONNECT_DIAGNOSE telemetry): the frontend calls
 *   wechat-cc log <tag> <msg> [--fields <json>] [--json]
 * after every reconnect click so the code-distribution can be grepped later.
 *
 * Returns { ok: true } on success.  On --fields JSON parse failure the
 * process exits non-zero with a human-readable error — no broken log line
 * is written.
 */

import { log, type LogFields } from '../lib/log.ts'

export interface RunLogCommandOptions {
  tag: string
  msg: string
  /** Raw JSON string from --fields, or undefined when the flag was omitted. */
  fieldsJson?: string
  /** stateDir is unused at call-time (log.ts reads STATE_DIR from config),
   *  but included so the signature is testable without mocking the module. */
  stateDir?: string
}

export interface LogCommandResult {
  ok: true
}

/**
 * Validate + parse `fieldsJson`, call `log()`, and return the JSON envelope.
 * Throws a `TypeError` with a clear message when `fieldsJson` is malformed.
 */
export function runLogCommand(opts: RunLogCommandOptions): LogCommandResult {
  let fields: LogFields | undefined
  if (opts.fieldsJson !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(opts.fieldsJson)
    } catch {
      throw new TypeError(`--fields must be valid JSON (got: ${JSON.stringify(opts.fieldsJson.slice(0, 80))})`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new TypeError(`--fields must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`)
    }
    fields = parsed as LogFields
  }

  log(opts.tag, opts.msg, fields)
  return { ok: true }
}
