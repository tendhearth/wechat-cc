import { AsyncLocalStorage } from 'node:async_hooks'
import { replyAttributionFields, type ReplyAttribution } from '@wechat-cc/protocol'

// Only trusted execution/delivery code enters this scope. In particular, tool request bodies cannot set it.
const scope = new AsyncLocalStorage<Readonly<Partial<ReplyAttribution>>>()
export const currentReplyAttribution = (): Readonly<Partial<ReplyAttribution>> | undefined => scope.getStore()
export function withReplyAttribution<T>(attribution: Partial<ReplyAttribution>, run: () => T): T {
  return scope.run(Object.freeze({ ...replyAttributionFields(attribution) }) as Readonly<Partial<ReplyAttribution>>, run)
}

// Eval can fail over between registered providers. Capture the successful call, never the configured preference.
const evalSource = new AsyncLocalStorage<{ attribution?: ReplyAttribution }>()
export function noteReplyAttribution(attribution: ReplyAttribution): void {
  const capture = evalSource.getStore()
  if (capture) capture.attribution = { ...attribution }
}
export async function captureReplyAttribution<T>(run: () => Promise<T>): Promise<{ result: T; attribution?: ReplyAttribution }> {
  const capture: { attribution?: ReplyAttribution } = {}
  const result = await evalSource.run(capture, run)
  return { result, ...capture }
}
