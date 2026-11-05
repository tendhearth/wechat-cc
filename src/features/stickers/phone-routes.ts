/**
 * phone-routes.ts — 手机按文件名取表情库里的一张图(P3d-3 从 `features/phone/settings-panel.ts` 搬回表情这个功能)。
 * 表经 index.ts 导出,组装的地方(`wiring/wire-settings-panel.ts`)交给面板的 `featureRoutes` —— 面板不 import 别的功能。
 *
 * 键是手机独有的 `/v1` 行、前缀键 `GET /v1/stickers/file/<文件名>`(只有 phone 块,处理器在面板这一口:回的是图片原图,
 * 内部 API 的分发只认 JSON);老 App 的 `/m/api/sticker/` 是 legacy-routes.ts 的纯改名别名。回包照搬之前在面板里的样子
 * (错误与 `?b64=1` 不带 cache-control,原图只带 content-type)。
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { PhoneRouteTable } from '../../lib/phone-route-table'

export interface StickerPhoneRoutesDeps {
  /** 库里登记的文件(只认这里有的名字)。 */
  list(): Array<{ file: string }>
  /** 库目录。 */
  dir: string
}

const PREFIX = '/v1/stickers/file/'
/** 面板的 json():不带 cache-control(搬之前就是这样)。 */
const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

/** `deps` 缺省(没接表情库)⇒ 一律 404,同搬之前。 */
export function stickerPhoneRoutes(deps: StickerPhoneRoutesDeps | undefined): PhoneRouteTable {
  return {
    'GET /v1/stickers/file/': async (url: URL) => {
      if (!deps) return json({ error: 'not_found' }, 404)
      const raw = decodeURIComponent(url.pathname.slice(PREFIX.length))
      const name = basename(raw)
      // basename + known-in-library double guard — never a free file read.
      if (name !== raw || !deps.list().some(e => e.file === name)) return json({ error: 'not_found' }, 404)
      const fp = join(deps.dir, name)
      if (!existsSync(fp)) return json({ error: 'not_found' }, 404)
      const ext = name.split('.').pop()?.toLowerCase() ?? 'png'
      const type = ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png'
      // 隧道/壳模式的图片通道:隧道 body 是 JSON 文本,二进制走不了 ——
      // ?b64=1 返回 base64 载荷,页面拼 data URI(出门表情不再裂图)。
      if (url.searchParams.get('b64') === '1') {
        return json({ ok: true, mime: type, data: readFileSync(fp).toString('base64') })
      }
      return new Response(readFileSync(fp), { headers: { 'content-type': type } })
    },
  }
}
