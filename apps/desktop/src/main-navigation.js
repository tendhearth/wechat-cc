// @ts-check
/** @typedef {'overview'|'a2a-agents'|'converse'|'chat'|'all'|'together'} LegacyDestination */
/** @typedef {LegacyDestination | {page:'workbench',taskId:string}} MainDestination */
const legacy = (/** @type {unknown} */ page) => page === 'overview' || page === 'a2a-agents' || page === 'converse' || page === 'chat' || page === 'all' || page === 'together'
/** Parse the whole untrusted target, retaining legacy pages and copying task IDs.
 * @param {unknown} value @returns {MainDestination|null}
 */
export function mainDestination(value) {
  if(legacy(value))return /** @type {LegacyDestination} */(value)
  if(!value||typeof value!=='object'||Array.isArray(value))return null
  const target=/** @type {Record<string,unknown>} */(value),keys=Object.keys(target)
  if(keys.length===1&&keys[0]==='page'&&legacy(target.page))return /** @type {LegacyDestination} */(target.page)
  if(keys.length===2&&keys.includes('page')&&keys.includes('taskId')&&target.page==='workbench'&&typeof target.taskId==='string'&&/^[a-f0-9]{8}$/.test(target.taskId))return {page:'workbench',taskId:target.taskId}
  return null
}

/** Keep requests until their destination can receive focus.
 * @param {(destination: MainDestination) => void} navigate
 */
export function createMainNavigation(navigate) {
  let ready = false, generation = 0
  /** @type {MainDestination|null} */ let queued = null
  const request = (/** @type {unknown} */ value) => {
    const destination = mainDestination(value)
    if (!destination) return false
    generation++
    if (ready) navigate(destination)
    else queued = destination
    return true
  }
  return {
    request,
    /** @param {boolean} value */
    setReady(value) {
      ready = value
      if (ready && queued) { const destination = queued; queued = null; navigate(destination) }
    },
    /** A newer live event wins over an older asynchronous boot response.
     * @param {Promise<unknown>} pending
     */
    restore(pending) { return pending.then(value => generation === 0 ? request(value) : false).catch(() => false) },
  }
}

/** Only the installed listener may mark the native inbox ready. A failed
 * install leaves pending targets intact and can be retried without blocking boot.
 * @param {{navigation:ReturnType<typeof createMainNavigation>,listen:(name:string,callback:(event:{payload?:unknown})=>void)=>Promise<unknown>,takePending:()=>Promise<unknown>,onError?:(error:unknown)=>void}} options
 */
export function createNativeNavigation({navigation,listen,takePending,onError=console.warn}) {
  let installed=false
  /** @type {Promise<boolean>|null} */ let inflight=null
  return function connect() {
    if(installed)return Promise.resolve(true)
    if(inflight)return inflight
    inflight=(async()=>{
      try {
        await listen('wechat-cc:navigate',event=>navigation.request(event?.payload))
        installed=true
        void navigation.restore(Promise.resolve().then(takePending))
        return true
      }catch(error){onError(error);return false}
    })().finally(()=>{inflight=null})
    return inflight
  }
}
