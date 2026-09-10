/**
 * image-prep.ts — 图片进模型前的整理:量尺寸、超了就缩到最长边 2048 并转 JPEG。
 *
 * 照 Codex 的 image_preparation 的形状:缩了要告诉模型(调用方把 resized 写进提示);
 * 处理不了不静默,回一句原因让调用方留在文字里。不引原生依赖 —— 用系统自带工具:
 * macOS `sips`、Windows System.Drawing(PowerShell)、Linux ImageMagick(有就用);
 * 都没有就原图照发(不超字节上限的话)。
 */
import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const IMAGE_MAX_SIDE = 2048
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024
const JPEG_QUALITY = 85

export interface ImageDims { w: number; h: number }

/** PNG / JPEG / GIF / WebP 的头部尺寸;认不出 → null。纯计算。 */
export function imageDimensions(b: Uint8Array): ImageDims | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { w: dv.getUint32(16), h: dv.getUint32(20) }
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const marker = b[i + 1]!
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      const len = dv.getUint16(i + 2)
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) }
      }
      i += 2 + len
    }
    return null
  }
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const fmt = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    if (fmt === 'VP8 ') return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff }
    if (fmt === 'VP8L') { const bits = dv.getUint32(21, true); return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 } }
    if (fmt === 'VP8X') return { w: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1, h: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1 }
  }
  return null
}

export type ExecFn = (cmd: string, args: string[], timeoutMs: number) => Promise<void>

const defaultExec: ExecFn = (cmd, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err) => err ? reject(err) : resolve())
})

/** 按平台挑缩图命令;不支持的平台 → null。输出一律 JPEG。 */
export function resizeCommand(platform: NodeJS.Platform, input: string, output: string, maxSide: number): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'sips', args: ['-Z', String(maxSide), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(JPEG_QUALITY), input, '--out', output] }
  if (platform === 'linux') return { cmd: 'convert', args: [input, '-auto-orient', '-resize', `${maxSide}x${maxSide}>`, '-quality', String(JPEG_QUALITY), output] }
  if (platform === 'win32') {
    const ps = [
      'Add-Type -AssemblyName System.Drawing',
      `$img = [System.Drawing.Image]::FromFile('${input.replace(/'/g, "''")}')`,
      `$scale = [Math]::Min(1.0, ${maxSide} / [Math]::Max($img.Width, $img.Height))`,
      '$w = [Math]::Max(1, [int]($img.Width * $scale)); $h = [Math]::Max(1, [int]($img.Height * $scale))',
      '$bmp = New-Object System.Drawing.Bitmap $w, $h',
      '$g = [System.Drawing.Graphics]::FromImage($bmp); $g.InterpolationMode = "HighQualityBicubic"; $g.DrawImage($img, 0, 0, $w, $h)',
      '$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }',
      '$ep = New-Object System.Drawing.Imaging.EncoderParameters 1',
      `$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]${JPEG_QUALITY})`,
      `$bmp.Save('${output.replace(/'/g, "''")}', $codec, $ep); $g.Dispose(); $bmp.Dispose(); $img.Dispose()`,
    ].join('; ')
    return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', ps] }
  }
  return null
}

export type PreparedImage =
  | { ok: true; data: Uint8Array; mediaType: string; dims: ImageDims | null; resized?: { from: ImageDims; to: ImageDims } }
  | { ok: false; reason: string }

export interface PrepareImageOpts {
  maxSide?: number
  maxBytes?: number
  platform?: NodeJS.Platform
  exec?: ExecFn
  tmpDir?: string
  timeoutMs?: number
}

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }

export function imageMediaType(path: string): string | null {
  const m = /\.[a-z0-9]+$/i.exec(path)
  return m ? (MIME[m[0].toLowerCase()] ?? null) : null
}

/**
 * 读文件 → 量尺寸 → 需要就缩。缩失败但没超字节上限 ⇒ 原图照发;超了又缩不了 ⇒ ok:false。
 */
export async function prepareImage(path: string, opts: PrepareImageOpts = {}): Promise<PreparedImage> {
  const maxSide = opts.maxSide ?? IMAGE_MAX_SIDE
  const maxBytes = opts.maxBytes ?? IMAGE_MAX_BYTES
  const platform = opts.platform ?? process.platform
  const exec = opts.exec ?? defaultExec
  const mediaType = imageMediaType(path)
  if (!mediaType) return { ok: false, reason: '不认识的图片格式' }
  let data: Uint8Array
  try { data = new Uint8Array(await readFile(path)) } catch (err) { return { ok: false, reason: `读不到文件:${err instanceof Error ? err.message : String(err)}` } }
  const dims = imageDimensions(data)
  const tooBig = data.length > maxBytes
  const tooWide = dims !== null && Math.max(dims.w, dims.h) > maxSide
  if (!tooBig && !tooWide) return { ok: true, data, mediaType, dims }
  const cmd = resizeCommand(platform, path, '', maxSide)
  if (cmd) {
    const out = join(opts.tmpDir ?? tmpdir(), `wcc-img-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`)
    const real = resizeCommand(platform, path, out, maxSide)!
    try {
      await exec(real.cmd, real.args, opts.timeoutMs ?? 20_000)
      const resized = new Uint8Array(await readFile(out))
      await unlink(out).catch(() => {})
      const to = imageDimensions(resized)
      if (resized.length > maxBytes) return { ok: false, reason: `缩到 ${maxSide} 像素后仍超过 ${Math.round(maxBytes / 1024 / 1024)}MB` }
      return { ok: true, data: resized, mediaType: 'image/jpeg', dims: to, ...(dims && to ? { resized: { from: dims, to } } : {}) }
    } catch {
      await unlink(out).catch(() => {})
    }
  }
  if (!tooBig) return { ok: true, data, mediaType, dims }
  return { ok: false, reason: `超过 ${Math.round(maxBytes / 1024 / 1024)}MB 且本机缩不了图` }
}
