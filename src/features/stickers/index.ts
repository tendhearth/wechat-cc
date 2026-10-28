/**
 * 贴纸(image-stickers plan / online-sticker-search / 觅食式表情生长)—— 一个功能一个目录(架构终态 A5)。
 *
 *  - `stickers.ts`:表情库(`<stateDir>/stickers/` + 索引)、初始表情包;`cc-starter-pack.*`:打包进编译产物的那一份;
 *  - `source.ts`:联网表情源(GIPHY / 中转);`feedback.ts`:主人对每张的反应(影响以后挑哪张);
 *  - `artist.ts` + `artist-step.ts`:CC 每天给自己画一张缺的心情,交给陪伴自省那一拍(IntrospectStep 贡献点);
 *  - `routes.ts`:`/v1/wechat/*sticker*`、`/v1/stickers`(路由表标了 module: 'stickers');
 *  - 这个文件:模块清单。它要的东西(`StickersFeatureDeps`)由同目录的 `module.ts`(接进 daemon 的那一份)从上游模块里填。
 *
 * 交出去的是表情库本身(`lib`):提示词里的贴纸段、手机页 / 设置面板、App 对话、自省那一步都读同一份 ——
 * 第二份会读到过期的内存索引。必需模块(搬家前在地基里造,造不出来照样挡开机),所以 bootstrap / wired 可以 needs 它。
 */
import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
import type { InternalApiLifecycle } from '../../daemon/internal-api/lifecycle'
import { makeStickerLib, seedStarterStickers, starterStickersDir, type StickerLib } from './stickers'
import { makeGiphyRelaySource, makeGiphySource } from './source'
import { makeStickerFeedback } from './feedback'
import { stickersRoutes, type StickersRoutesDeps } from './routes'

export type { StickerLib, StickerEntry } from './stickers'
export { stickerArtistStep, type StickerArtistStepDeps } from './artist-step'
export { rasterizeSvgDarwin } from './artist'

export interface StickersFeature {
  /** 全 daemon 一份的表情库。 */
  lib: StickerLib
}

export interface StickersFeatureDeps {
  stateDir: string
  /** 发表情走的微信口(和 send_file 同一个)。 */
  ilink: StickersRoutesDeps['ilink']
  log: (tag: string, line: string) => void
}

export function stickersFeature(o: { needs: readonly string[]; deps: (ctx: ModuleCtx) => StickersFeatureDeps }): DaemonModule<StickersFeature> {
  return {
    name: 'stickers',
    needs: ['internal-api', ...o.needs],
    init(ctx) {
      const d = o.deps(ctx)
      const stickerFeedback = makeStickerFeedback(d.stateDir)
      const lib = makeStickerLib(d.stateDir, { feedback: stickerFeedback })
      // Versioned CC pack adds missing stickers; existing collections are preserved.
      {
        const packDir = starterStickersDir()
        if (packDir) seedStarterStickers(lib, packDir, d.log)
      }
      const giphyRelay = process.env.WECHAT_CC_GIPHY_RELAY_URL ?? 'https://wechat-cc-giphy-relay.moxiuwen-giphy.workers.dev/search'
      const giphyKey = process.env.WECHAT_CC_GIPHY_KEY
      const stickerSource = giphyKey ? makeGiphySource({ apiKey: giphyKey }) : makeGiphyRelaySource({ endpoint: giphyRelay })
      d.log('STICKERS', giphyKey ? 'online sticker source: GIPHY (local key)' : `online sticker source: GIPHY relay (${giphyRelay})`)
      ctx.get<InternalApiLifecycle>('internal-api').mount('stickers', stickersRoutes({ stickers: lib, stickerSource, stickerFeedback, ilink: d.ilink }))
      return { lib }
    },
  }
}
