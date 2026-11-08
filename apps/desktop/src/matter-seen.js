// @ts-check
import { V1, v1 } from './daemon-client.js'

/**
 * A pet destination is seen only after the main window successfully opens it.
 * @param {unknown} target
 * @param {(target:any)=>Promise<unknown>} open
 * @param {(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>} call
 */
export async function openSeenMatter(target, open, call) {
  await open(target)
  const destination = /** @type {{page?:string,taskId?:string}|null} */ (target)
  if (destination?.page === 'workbench' && typeof destination.taskId === 'string' && /^[a-f0-9]{8}$/.test(destination.taskId)) {
    await v1(call, V1.matter.seen, { body: { id: destination.taskId } }).catch(() => {})
  }
}
