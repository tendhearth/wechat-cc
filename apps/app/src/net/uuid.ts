type Rand = (a: Uint8Array) => Uint8Array
const defaultRand: Rand = a => (globalThis as unknown as { crypto: { getRandomValues: Rand } }).crypto.getRandomValues(a)

/** RFC 4122 v4(小写)。RN 上随机数由 install-polyfills 装好。 */
export function uuid(rand: Rand = defaultRand): string {
  const b = rand(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
