import * as Crypto from 'expo-crypto'
import * as ImagePicker from 'expo-image-picker'
import { base64ToBytes, checkImage, type ImageCheck, type PickedImage } from '../state/image-upload'
import { uuid } from './uuid'

/**
 * 从相册选图(2026-10-06,跟 CC 说 / 交办共用)。iOS 14+ 走系统 PHPicker:只拿到选中的那几张,不需要相册权限弹框。
 * quality < 1 ⇒ 重新编码成 JPEG(HEIC 也转成电脑认的格式),一般几百 KB。超过 5MB / 格式不认的那张跳过并说一声原因。
 * 用户取消 ⇒ null。
 */
export async function pickImages(max: number): Promise<{ images: PickedImage[]; skipped: Exclude<ImageCheck, 'ok'> | null } | null> {
  if (max <= 0) return { images: [], skipped: null }
  const r = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'], allowsMultipleSelection: max > 1, selectionLimit: max, quality: 0.8, base64: true, exif: false,
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  })
  if (r.canceled) return null
  const images: PickedImage[] = []
  let skipped: Exclude<ImageCheck, 'ok'> | null = null
  for (const a of r.assets.slice(0, max)) {
    if (!a.base64) { skipped = 'unsupported'; continue }
    const img = await toPickedImage({ bytes: base64ToBytes(a.base64), mime: a.mimeType ?? 'image/jpeg', name: a.fileName, uri: a.uri })
    if (typeof img === 'string') { skipped = img; continue }
    images.push(img)
  }
  return { images, skipped }
}

/** 读到手的一张图 ⇒ PickedImage(相册选图与分享进来的共用):过同一道 5MB / 格式检查,id 在这一刻定下,算好 sha256。 */
export async function toPickedImage(p: { bytes: Uint8Array; mime: string; name?: string | null; uri: string }): Promise<PickedImage | Exclude<ImageCheck, 'ok'>> {
  const { bytes, mime, uri } = p
  const check = checkImage({ mime, size: bytes.length })
  if (check !== 'ok') return check
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as Uint8Array<ArrayBuffer>)
  const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
  const ext = mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : mime === 'image/webp' ? 'webp' : 'jpg'
  return { id: uuid(), name: p.name?.replace(/[\\/\u0000-\u001f]/g, '').slice(0, 120) || `photo.${ext}`, mime, size: bytes.length, sha256, bytes, uri }
}
