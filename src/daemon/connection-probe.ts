/**
 * connection-probe.ts — answer "does THIS machine currently hold the ilink
 * bot connection?" by doing one short getUpdates and reading the result.
 *
 * The only ground-truth signal ilink gives is errcode=-14 ("session timeout"
 * — token rebound on another device). No -14 within the short poll window
 * means the server accepted our session (we are the live connection, or it
 * long-polled with nothing to send). See the design doc's "待验证" note on
 * multi-reader semantics.
 */
import type { GetUpdatesResp } from '../lib/ilink'

export type ConnectionState = 'connected' | 'taken_over' | 'inconclusive'

export interface ProbeVerdict {
  state: ConnectionState
  detail?: string
}

export function classifyProbeResult(input: { resp?: GetUpdatesResp; error?: unknown }): ProbeVerdict {
  if (input.error) {
    return { state: 'inconclusive', detail: input.error instanceof Error ? input.error.message : String(input.error) }
  }
  const resp = input.resp ?? {}
  if (resp.errcode === -14 || resp.ret === -14) {
    return { state: 'taken_over', ...(resp.errmsg ? { detail: resp.errmsg } : {}) }
  }
  return { state: 'connected' }
}
