import { inflateSync } from 'node:zlib'

/** Decode the kit's noninterlaced RGBA8 PNG contract, without a native dependency. */
export function readRGBA(bytes, size = 512) {
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Error('PNG signature')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (![384, 512].includes(size) || width !== size || height !== size || bytes[24] !== 8 || bytes[25] !== 6 || bytes[26] || bytes[27] || bytes[28]) throw Error(`expected ${size}x${size} noninterlaced RGBA8`)
  const chunks = []
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    if (offset + length + 12 > bytes.length) throw Error('truncated PNG')
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
    if (type === 'IEND') break
  }
  const stride = width * 4
  const scan = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height })
  if (scan.length !== (stride + 1) * height) throw Error('PNG scanline size')
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const filter = scan[y * (stride + 1)]
    if (filter > 4) throw Error('PNG filter')
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x
      const left = x >= 4 ? rgba[i - 4] : 0
      const up = y > 0 ? rgba[i - stride] : 0
      const corner = y > 0 && x >= 4 ? rgba[i - stride - 4] : 0
      const p = left + up - corner
      const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner)
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : pa <= pb && pa <= pc ? left : pb <= pc ? up : corner
      rgba[i] = (scan[y * (stride + 1) + x + 1] + predictor) & 255
    }
  }
  const alpha = Buffer.alloc(width * height)
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3]
  return { rgba, alpha, width, height }
}
