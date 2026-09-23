/** zstd 解压:Bun 有原生 `Bun.zstdDecompressSync`;Node 22.15+ / 24 的 node:zlib 也带 zstd。 */
export function zstdDecompressSync(bytes: Uint8Array): Uint8Array {
  const bun = (globalThis as { Bun?: { zstdDecompressSync?: (b: Uint8Array) => Uint8Array } }).Bun
  if (bun?.zstdDecompressSync) return new Uint8Array(bun.zstdDecompressSync(bytes))
  const zlib = require('node:zlib') as { zstdDecompressSync: (b: Uint8Array) => Uint8Array }
  return new Uint8Array(zlib.zstdDecompressSync(bytes))
}
