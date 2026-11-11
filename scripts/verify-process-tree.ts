/** POSIX ownership is immutable PID + start time, including the launcher. */
export interface VerifyProcess {pid:number;parent:number;birth:string;state?:string;uid?:number}
export interface VerifyTreeDeps {
  table():VerifyProcess[]|null
  signal(pid:number,signal:'SIGSTOP'|'SIGKILL'):void
  report(line:string):void
  /** Additional launch evidence, never a replacement for PID + birth checks. */
  owns?(row:VerifyProcess):boolean
}
export function createVerifyProcessTree(root:number|undefined,deps:VerifyTreeDeps) {
  const owned=new Map<number,string>(),reported=new Set<string>(),retired=new Set<number>(),marked=new Set<number>()
  let initialized=false,exited=false
  let cleanupUntil=Infinity
  const report=(message:string)=>{if(!reported.has(message)){reported.add(message);deps.report(message)}}
  const observe=(rows:VerifyProcess[]|null,recover=false):VerifyProcess[]=>{
    if(rows===null) {
      initialized=true
      report(`verify: process table unavailable; cleanup unconfirmed (root PID ${root??'?'})`)
      return []
    }
    if(!initialized) {
      initialized=true
      const first=rows.find(row=>row.pid===root)
      if(first&&!exited&&(!deps.owns||deps.owns(first))) {
        owned.set(first.pid,first.birth)
        if(deps.owns)marked.add(first.pid)
      }
      else report(`verify: root PID ${root??'?'} has no launch identity; no ownership claimed`)
    }
    for(const pid of owned.keys())if(!rows.some(row=>row.pid===pid))retired.add(pid)
    if(root!==undefined&&retired.has(root))exited=true
    if(recover&&deps.owns)for(const row of rows) {
      if(performance.now()>=cleanupUntil)break
      if(owned.has(row.pid)||retired.has(row.pid)||(row.pid===root&&exited))continue
      if(deps.owns(row)){owned.set(row.pid,row.birth);marked.add(row.pid)}
    }
    const live=new Set<number>()
    for(const row of rows) {
      const birth=owned.get(row.pid)
      if(birth===undefined)continue
      if(row.birth!==birth){retired.add(row.pid);report(`verify: PID ${row.pid} start identity changed; not signalled`);continue}
      if(retired.has(row.pid)||(row.pid===root&&exited)||row.state?.startsWith('Z'))continue
      live.add(row.pid)
    }
    let changed=true
    const anchors=new Map<number,boolean>()
    const byIdentity=new Map(rows.map(row=>[row.pid,row]))
    while(changed) {
      changed=false
      for(const row of rows) {
        if(live.has(row.pid)||!live.has(row.parent)||row.pid===root)continue
        // Never adopt a replacement of any previously seen process.
        if(retired.has(row.pid)||row.state?.startsWith('Z')||(owned.has(row.pid)&&owned.get(row.pid)!==row.birth))continue
        if(marked.has(row.parent)) {
          if(!anchors.has(row.parent))anchors.set(row.parent,!!deps.owns?.(byIdentity.get(row.parent)!))
          if(!anchors.get(row.parent))continue
        }
        live.add(row.pid);changed=true
        if(!owned.has(row.pid))owned.set(row.pid,row.birth)
      }
    }
    // ps order is unspecified. Stop ancestors before their workers can fork.
    const ordered:VerifyProcess[]=[],seen=new Set<number>()
    const byPid=new Map(rows.filter(row=>live.has(row.pid)).map(row=>[row.pid,row]))
    const visit=(row:VerifyProcess)=>{
      if(seen.has(row.pid))return
      seen.add(row.pid)
      const parent=byPid.get(row.parent);if(parent)visit(parent)
      ordered.push(row)
    }
    for(const row of byPid.values())visit(row)
    return ordered
  }
  const snapshot=(recover=false)=>observe(deps.table(),recover)
  const signal=(row:VerifyProcess,sig:'SIGSTOP'|'SIGKILL')=>{
    const rows=deps.table()
    // Identity reads are observations too: a child may lose its parent before
    // the next polling tick. Do not discard the rest of this table.
    observe(rows)
    const current=rows?.find(value=>value.pid===row.pid)
    if(retired.has(row.pid)||(row.pid===root&&exited)||!current||current.birth!==owned.get(row.pid)||(marked.has(row.pid)&&!deps.owns?.(current))) {
      if(current&&current.birth!==owned.get(row.pid))retired.add(row.pid)
      report(`verify: PID ${row.pid} exit/start identity not verified; not signalled`)
      return false
    }
    try{deps.signal(row.pid,sig);return true}catch{report(`verify: PID ${row.pid} signal ${sig} failed; cleanup unconfirmed`);return false}
  }
  const stop=(until=Infinity)=>{
    const frozen=new Map<number,VerifyProcess>()
    // Freeze validated parents, then discover children that raced the scan.
    // A fixed bound keeps cleanup itself finite; never signal an entire group.
    for(let pass=0;pass<10;pass++) {
      if(performance.now()>=until)break
      const pending=snapshot(true).filter(row=>!frozen.has(row.pid))
      if(!pending.length)break
      for(const row of pending) {
        if(performance.now()>=until)break
        if(signal(row,'SIGSTOP'))frozen.set(row.pid,row)
      }
    }
    const final=new Map(frozen)
    for(const row of snapshot())final.set(row.pid,row)
    for(const row of [...final.values()].reverse()) {
      // Exhausting the discovery budget must never strand a process we just
      // stopped. Drain that finite set, still checking identity before KILL.
      if(performance.now()>=until&&!frozen.has(row.pid))continue
      signal(row,'SIGKILL')
    }
  }
  return {snapshot,rootExited(){exited=true},stop,async cleanup(timeoutMs=3000){
    const until=performance.now()+timeoutMs
    cleanupUntil=until
    do {
      stop(until)
      // SIGSTOP/KILL delivery is asynchronous. Keep discovering until a fresh
      // table confirms death; a successful kill(2) is not that confirmation.
      await new Promise(resolve=>setTimeout(resolve,25))
      const rows=deps.table()
      const live=observe(rows,true)
      if(rows!==null&&!live.length&&root!==undefined&&owned.has(root))return true
    } while(performance.now()<until)
    // Reporting must not start another unbounded round of marker lookups.
    const rows=deps.table(),live=observe(rows)
    for(const row of live)report(`verify: residual PID ${row.pid} (start ${row.birth}); cleanup unconfirmed`)
    if(rows===null||root===undefined||!owned.has(root))report(`verify: cleanup unconfirmed (root PID ${root??'?'}; launch identity unavailable)`)
    return false
  }}
}
