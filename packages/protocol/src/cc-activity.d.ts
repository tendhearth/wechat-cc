export type CCPhase = 'idle' | 'listening' | 'thinking' | 'speaking'
export type CCStream = { scope?: string; activityReady?: boolean; running: { turnId: string } | null; events: readonly { id: string; turnId: string | null; kind: string; text: string }[] }
export const CC_ACTIVITY: Readonly<{ speechMs: 900; leaseMs: 2500; typingMs: 1600; attentionMs: 12000 }>
export function createCCActivity(): {
  observe(stream: CCStream | null | undefined, now: number, animate?: boolean): void
  phase(facts: { connected: boolean; now: number; typing?: boolean; waiting?: boolean; blocked?: boolean }): CCPhase
  nextChangeAt(now: number): number
}
export function successfulCCResults<T extends { status: string }>(rows: readonly T[]): T[]
export const CC_RESPONSE: Readonly<{ frameMs: 167; frames: 4; cooldownMs: 2400 }>
export function createCCResponsePerformance(): { frame(phase: CCPhase, now: number, active?: boolean): number | null }
