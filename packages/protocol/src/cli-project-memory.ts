// Shared startup request schema; keep the hook independent of the full desktop API graph.
import z from 'zod'

export const CliProjectMemoryRequest = z.object({
  source: z.enum(['claude', 'codex']),
  session_id: z.string().min(1).max(200),
  cwd: z.string().min(1).max(1000),
})
