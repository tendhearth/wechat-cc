/** The successful nightly topic pass and its safe owner-session boundary. */
import type { ThreadsStore } from '../../lib/threads-store'
import type { ContextRotation, RotationSessions } from '../../app/context-rotation'
import { consolidateTopics } from '../../daemon/threads/consolidate'
import { withExtractionLock } from '../../daemon/threads/extractor'

export async function consolidateAfterSleep(d: {
  chatId: string
  isOwner(chatId: string): boolean
  threads: ThreadsStore
  sdkEval: ((prompt: string) => Promise<string>) | null
  rotation?: ContextRotation
  sessions: RotationSessions
  runExclusive(chatId: string, fn: () => Promise<void>): Promise<void>
  log(tag: string, line: string): void
}) {
  const consolidated = await withExtractionLock(d.threads, d.chatId, () => consolidateTopics(d))
  if (consolidated.failed === 0 && d.isOwner(d.chatId) && d.rotation) {
    d.rotation.nightly(d.chatId, true)
    await d.runExclusive(d.chatId, () => d.rotation!.rotateIdle(d.chatId, d.sessions))
  }
  return consolidated
}
