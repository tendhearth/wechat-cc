/**
 * pet-signals.ts — 桌宠要看的几个真实时间戳,内存里记一下(spec §5.1「不新增表」)。
 * 谁写:coordinator 的 onTurnEvent(tool_call)、bootstrap 的 recordTurn(回合结束)、
 * converse 路由与 permission resolve(主人联系)。谁读:GET /v1/companion/pet。
 *
 * 纯内存、无 I/O:重启就忘干净,桌宠的「在做什么」本来就只描述当下。
 */
export interface PetSignals {
  noteToolCall(chatId: string, nowMs?: number): void
  noteTurnStart(chatId: string, nowMs?: number): void
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
  return {
    noteToolCall(chatId, ms) { toolCall.set(chatId, t(ms)) },
    noteTurnStart(chatId, ms) { started.set(chatId, t(ms)) },
    noteTurnEnd(chatId, ms) { ended.set(chatId, t(ms)); started.delete(chatId) },
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
