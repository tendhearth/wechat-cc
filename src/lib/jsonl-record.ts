/** Decode one complete JSONL record. Partial or malformed lines carry no metadata. */
export function parseJsonlRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}
