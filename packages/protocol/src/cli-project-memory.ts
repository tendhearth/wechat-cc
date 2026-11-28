// Shared startup request schema; keep the hook independent of the full desktop API graph.
import z from 'zod'
import { terminalLocationWire } from './terminal-location'

export const CliProjectMemoryRequest = z.object({
  source: z.enum(['claude', 'codex']),
  session_id: z.string().min(1).max(200),
  cwd: z.string().min(1).max(1000),
  terminal: terminalLocationWire,
})
