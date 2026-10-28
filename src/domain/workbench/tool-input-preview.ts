const credentialKey = /(?:token|secret|password|api[_-]?key|authorization|cookie|credential|signature)/i
const omitted = '[credential omitted]'

function redactText(text: string): string {
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
export function toolInputPreview(input: unknown, pretty = false): string | null {
  try {
    const raw = JSON.stringify(input)
    if (raw === undefined || raw.length > 20_000) return null
    const preview = JSON.stringify(JSON.parse(raw), (key, value: unknown) => {
      if (credentialKey.test(key)) return omitted
      if (typeof value === 'string') return redactText(value)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>
        if ([record.name, record.key].some(name => typeof name === 'string' && credentialKey.test(name)) && Object.hasOwn(record, 'value')) return { ...record, value: omitted }
      }
      return value
    }, pretty ? 2 : undefined)
    return preview.length <= 20_000 ? preview : null
  } catch { return null }
}
