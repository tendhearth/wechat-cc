import { File } from 'expo-file-system'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import { base64ToBytes, type ImageCheck, type PickedImage } from '../state/image-upload'
import type { ShareImageSource } from '../view/share'
import { toPickedImage } from './image-pick'

/**
 * 分享进来的图读成 PickedImage(2026-10-18)。和相册选图同一个结果:除 GIF 外都按 quality 0.8 重编成 JPEG(HEIC 也转成电脑认的格式),
 * 再过同一道 5MB / 格式检查;读不了、转不了的那张跳过并说一声原因(和选图的 skipped 一样,只报最后一个)。
 * iOS 的 uri 是分享扩展复制进 App Group 的 file://;安卓是随分享授权的 content://。
 */
export async function readSharedImages(sources: readonly ShareImageSource[]): Promise<{ images: PickedImage[]; skipped: Exclude<ImageCheck, 'ok'> | null }> {
  const images: PickedImage[] = []
  let skipped: Exclude<ImageCheck, 'ok'> | null = null
  for (const s of sources) {
    try {
      const img = s.encode === 'raw' ? await readRaw(s) : await reencode(s)
      if (typeof img === 'string') { skipped = img; continue }
      images.push(img)
    } catch {
      skipped = 'unsupported'
    }
  }
  return { images, skipped }
}

const baseName = (name: string | null) => (name ? name.replace(/\.[^.]*$/, '') : null)

async function reencode(s: ShareImageSource) {
  const ref = await ImageManipulator.manipulate(s.uri).renderAsync()
  const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true })
  if (!out.base64) return 'unsupported' as const
  const name = baseName(s.name)
  return toPickedImage({ bytes: base64ToBytes(out.base64), mime: 'image/jpeg', name: name ? `${name}.jpg` : null, uri: out.uri })
}

async function readRaw(s: ShareImageSource) {
  const bytes = await new File(s.uri).bytes()
  return toPickedImage({ bytes, mime: s.mime, name: s.name, uri: s.uri })
}
