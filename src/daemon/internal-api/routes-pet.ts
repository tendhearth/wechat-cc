/**
 * routes-pet.ts — CC 桌宠的「在做什么」(spec 2026-09-05-cc-desktop-pet §5.1)与它订的 `presence` 主题(S5)。
 *
 * 推导在 core/pet-turn.ts(纯函数),输入在 wiring/pipeline-deps.ts 组装(主人
 * 会话在飞、最近 tool_call、回合结束、主人联系时间、待决权限)—— 这里只把那个
 * 闭包叫一下。不新增表:所有时间戳都是 daemon 内存里本来就有的信号。
 *
 * 分级 trusted:桌面拿的是 FILE token(= trusted)。admin 会让桌面 403 ——
 * 觅食台 2026-07-22 就是这么静默坏了一个月。
 */
import { computePresence } from './routes-presence'
import { makePresenceTopic } from './presence-topic'
import { errMsg, type InternalApiDeps, type RouteTable } from './types'

/** 一次长轮询最多挂这么久(桌面用 20 秒,和一起做详情一样)。 */
export const PRESENCE_TOPIC_WAIT_CAP_MS = 25_000

export function petRoutes(deps: InternalApiDeps): RouteTable {
  const topic = makePresenceTopic({
    computePresence: () => computePresence(deps),
    computePet: async () => (deps.petTurn ? await deps.petTurn() : null),
  })
  deps.presenceChanged?.(() => topic.poke())
  return {
    // 桌宠自己(S5 起)订下面的 presence 主题,不再轮询这一条。留着:1.7.8 及以前的桌面还每 2 / 10 秒拉它,
    // 真实形状沙盒和 codex 审批的 e2e 也从这里读待批。桌面都升到订主题的那一版之后再删。
    'GET /v1/companion/pet': async () => {
      if (!deps.petTurn) return { status: 503, body: { error: 'pet_not_wired' } }
      try {
        return { status: 200, body: await deps.petTurn() }
      } catch (err) {
        // 一次推导失败(例如消息库正忙)不该让整块 UI 空白,
        // 更不该把 daemon 的这一路 dispatch 掀翻。
        return { status: 500, body: { error: errMsg(err) } }
      }
    },
    // `presence` 主题(骨架设计稿 §3.3):since 不给 ⇒ 马上回一份;给了 ⇒ 内容变了才回,最多挂 wait_ms。
    // 两半各自算不出来就是 null(桌面画成「联系不上」/「端点没接」),不拿旧值顶。
    'GET /v1/subscribe/presence': async (q, _body, _caller, ctx) => {
      const sinceRaw = q.get('since')
      const since = sinceRaw === null || sinceRaw === '' ? null : Number(sinceRaw)
      if (since !== null && !Number.isFinite(since)) return { status: 400, body: { error: 'since must be a number' } }
      const waitRaw = Number(q.get('wait_ms') ?? '0')
      const waitMs = Math.max(0, Math.min(Number.isFinite(waitRaw) ? waitRaw : 0, PRESENCE_TOPIC_WAIT_CAP_MS))
      return { status: 200, body: await topic.wait(since, waitMs, ctx?.signal) }
    },
  }
}
