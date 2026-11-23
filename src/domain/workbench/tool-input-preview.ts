const credentialKey = /(?:token|secret|password|api[_-]?key|authorization|cookie|credential|signature)/i
const omitted = '[credential omitted]'

export function redactPreviewText(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"']+/gi, raw => {
    try {
      const url = new URL(raw)
      const authenticated = !!(url.username || url.password)
      url.username = ''; url.password = ''
      let changed = authenticated
      for (const key of new Set(url.searchParams.keys())) if (credentialKey.test(key)) {
        url.searchParams.set(key, omitted); changed = true
      }
      // OAuth fragments can carry the same named fields as query strings.
      const fragment = new URLSearchParams(url.hash.slice(1))
      for (const key of new Set(fragment.keys())) if (credentialKey.test(key)) {
        fragment.set(key, omitted); url.hash = fragment.toString(); changed = true
      }
      return changed ? url.toString() : raw
    } catch { return raw }
  }).replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, (_, scheme: string) => `${scheme} ${omitted}`)
}

/** Bounded approval preview. Redacts common credential fields, URL auth and
 * named header pairs; arbitrary secrets in free prose cannot be inferred. */
export function toolApprovalInput(input: unknown): unknown {
  try {
    const raw = JSON.stringify(input)
    if (raw === undefined || raw.length > 20_000) return undefined
    const redact = (key: string, value: unknown): unknown => {
      if (credentialKey.test(key)) return omitted
      if (typeof value === 'string') return redactPreviewText(value)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>
        if ([record.name, record.key].some(name => typeof name === 'string' && credentialKey.test(name)) && Object.hasOwn(record, 'value')) return { ...record, value: omitted }
      }
      return value
    }
    function visit(key: string, value: unknown): unknown {
      const redacted = redact(key, value)
      if (Array.isArray(redacted)) return redacted.map((item, index) => visit(String(index), item))
      if (redacted && typeof redacted === 'object') return Object.fromEntries(
        Object.entries(redacted).map(([name, item]) => [name, visit(name, item)]))
      return redacted
    }
    return visit('', JSON.parse(raw))
  } catch { return undefined }
}

export function toolInputPreview(input: unknown, pretty = false): string | null {
  const safe = toolApprovalInput(input)
  if (safe === undefined) return null
  try {
    const preview = JSON.stringify(safe, null, pretty ? 2 : undefined)
    return preview.length <= 20_000 ? preview : null
  } catch { return null }
}
