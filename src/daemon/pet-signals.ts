/**
 * pet-signals.ts — 桌宠要看的几个真实时间戳,内存里记一下(spec §5.1「不新增表」)。
 * 谁写:coordinator 的 onTurnEvent(tool_call)、bootstrap 的 recordTurn(回合结束)、
 * converse 路由与 permission resolve(主人联系)。谁读:GET /v1/companion/pet。
 *
 * 纯内存、无 I/O:重启就忘干净,桌宠的「在做什么」本来就只描述当下。
 */
/**
 * 每个 Map 最多记这么多个 chat。桌宠只关心「当下」,而 chatId 的总量是无界的
 * (每个来搭话的陌生人都是一个),没有上界的话这三个 Map 就是一条随 daemon
 * 寿命单调增长的内存泄漏。超了就删最老的一个 —— Map 保插入序,删掉的必然是
 * 最久没有新事件的那个 chat,它的时间戳早就没人会读了。
 */
export const MAX_TRACKED_CHATS = 256

/**
 * recordTurn 里那条 `TurnRecord` 该不该算作「这一趟回合结束了」(spec §5.1 的
 * last_done_at + 起飞标记落地)。抽出来是为了能单测,判据两条:
 *
 *  1. `outcome === 'completed'` —— 「刚忙完」是一次庆祝(spec §5.1 把它定义为
 *     provider 的 result 事件)。timeout / error / auth_failed 的回合是死掉的,
 *     不该让桌宠比个耶;起飞标记那边有 dispatch 的 finally 里的 noteTurnStop
 *     兜底,不靠这里撤。
 *  2. `mode !== 'chatroom'` —— chatroom 每个参与者每一拍都吐一条 TurnRecord
 *     (见 conversation-coordinator 的 TurnRecord 注释)。照单全收的话:第一拍
 *     就把起飞标记删了(辩论还在跑,桌宠却显示闲着),之后每一拍都把
 *     last_done_at 往前推一次,一个主人回合能放 N×轮数 次「刚忙完」。
 *     chatroom 的配对由入站分发 finally 里的 noteTurnStop 保证,不缺这一笔。
 */
export function shouldNoteTurnEnd(record: { mode: string; outcome: string }): boolean {
  return record.outcome === 'completed' && record.mode !== 'chatroom'
}

export interface PetSignals {
  noteToolCall(chatId: string, nowMs?: number): void
  noteTurnStart(chatId: string, nowMs?: number): void
  /**
   * 这一趟「进来的回合」离场了(正常结束、抛错、被命令路由截胡之后都不会走到
   * 这里 —— 截胡的根本没 start)。只撤掉起飞标记,**不动** lastResultAtMs:
   * 「刚忙完」那一笔归 recordTurn 管(它才知道回合真正的结局与结束时刻)。
   *
   * 为什么需要它:noteTurnEnd 只在 coordinator 真跑完一个 TurnRecord 时才响,
   * 而 dispatch 可能在那之前就抛错/被丢弃 —— 那样起飞标记会永久挂着。
   */
  noteTurnStop(chatId: string): void
  noteTurnEnd(chatId: string, nowMs?: number): void
  noteContact(nowMs?: number): void
  snapshot(chatId: string): {
    inFlightSinceMs: number | null
    lastToolCallAtMs: number | null
    lastResultAtMs: number | null
    lastContactMs: number | null
  }
}

export function makePetSignals(now: () => number = () => Date.now()): PetSignals {
  const toolCall = new Map<string, number>()
  const started = new Map<string, number>()
  const ended = new Map<string, number>()
  let contact: number | null = null
  const t = (ms?: number) => (typeof ms === 'number' ? ms : now())
  // 有界写入(见 MAX_TRACKED_CHATS)。Map.set 对已存在的键不改插入序,所以
  // keys().next() 拿到的永远是最早**首次**出现的那个 chat。
  const put = (map: Map<string, number>, chatId: string, ms: number): void => {
    map.set(chatId, ms)
    if (map.size > MAX_TRACKED_CHATS) {
      const oldest = map.keys().next()
      if (!oldest.done) map.delete(oldest.value)
    }
  }
  return {
    noteToolCall(chatId, ms) { put(toolCall, chatId, t(ms)) },
    noteTurnStart(chatId, ms) { put(started, chatId, t(ms)) },
    noteTurnStop(chatId) { started.delete(chatId) },
    noteTurnEnd(chatId, ms) { put(ended, chatId, t(ms)); started.delete(chatId) },
    // 只进不退:乱序到达的旧时间戳不该把「主人刚说过话」抹回去。
    noteContact(ms) { contact = Math.max(contact ?? 0, t(ms)) },
    snapshot(chatId) {
      return {
        inFlightSinceMs: started.get(chatId) ?? null,
        lastToolCallAtMs: toolCall.get(chatId) ?? null,
        lastResultAtMs: ended.get(chatId) ?? null,
        lastContactMs: contact,
      }
    },
  }
}
