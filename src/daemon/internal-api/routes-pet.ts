/**
 * routes-pet.ts — CC 桌宠的「在做什么」(spec 2026-09-05-cc-desktop-pet §5.1)。
 *
 * 推导在 core/pet-turn.ts(纯函数),输入在 wiring/pipeline-deps.ts 组装(主人
 * 会话在飞、最近 tool_call、回合结束、主人联系时间、待决权限)—— 这里只把那个
 * 闭包叫一下。不新增表:所有时间戳都是 daemon 内存里本来就有的信号。
 *
 * 分级 trusted:桌面拿的是 FILE token(= trusted)。admin 会让桌面 403 ——
 * 觅食台 2026-07-22 就是这么静默坏了一个月。
 */
import { errMsg, type InternalApiDeps, type RouteTable } from './types'

export function petRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/companion/pet': async () => {
      if (!deps.petTurn) return { status: 503, body: { error: 'pet_not_wired' } }
      try {
        return { status: 200, body: await deps.petTurn() }
      } catch (err) {
        // 桌宠每几秒问一次;一次推导失败(例如消息库正忙)不该让整块 UI 空白,
        // 更不该把 daemon 的这一路 dispatch 掀翻。
        return { status: 500, body: { error: errMsg(err) } }
      }
    },
  }
}
