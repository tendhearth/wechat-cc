/**
 * 额度用完、交给另一位执行者继续时,新任务的第一句(微信管家「交给 X 继续?」与手机确认卡共用一份)。
 * 新任务在同一个文件夹里新开,不带原会话:这一句说清从谁接手、为什么、哪件事、主人要它接着做什么。
 */
import { providerDisplayName } from '../provider-display-names'

/** 主人没说新要求(手机确认卡 / 微信只回了「是」)⇒ 接着原来的要求做。 */
export const QUOTA_TAKEOVER_DEFAULT_REQUEST = '接着原来的要求做。'

export function quotaTakeoverText(fromProviderId: string, title: string, request: string): string {
  return `接替 ${providerDisplayName(fromProviderId)}（额度用完）继续这件事：${title}\n主人刚才的要求：${request}`
}
