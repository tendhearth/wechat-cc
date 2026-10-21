import type { Middleware } from './types'
import { routedAway } from './intent'
import type { CommandRegistry } from '../commands/registry'

/**
 * 「命令」这一站(重构第二批步 2):查 CommandRegistry,命中就处理、不进模型。
 * 以前叫 cli-reply,只是「看 码 / @码」;后来定时 / 日历 / 经验…都挂在它名下,名字不对了。
 * 排在权限 y/n 之后、管家指称之前;排在 llm-health 与 recall **之前** —— 不用模型的命令,模型挂了照常能用。
 */
export interface MwCommandDeps {
  registry: CommandRegistry
  log: (tag: string, line: string) => void
}

export function makeMwCommand(deps: MwCommandDeps): Middleware {
  return async (ctx, next) => {
    if (routedAway(ctx, 'command')) { await next(); return }
    const hit = await deps.registry.handle(ctx.msg)
    if (hit) {
      deps.log('COMMAND', `${hit.id} consumed from chat=${ctx.msg.chatId}`)
      // 沿用老标签(admin / mode / onboarding / permission-reply / command):trace、welcome、milestone、activity 不用改
      ctx.consumedBy = hit.group as NonNullable<typeof ctx.consumedBy>
      return
    }
    await next()
  }
}
