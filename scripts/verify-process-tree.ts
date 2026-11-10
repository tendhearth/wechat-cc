/** POSIX ownership is immutable PID + start time, including the launcher. */
export interface VerifyProcess {pid:number;parent:number;birth:string}
export interface VerifyTreeDeps {
  table():VerifyProcess[]|null
  signal(pid:number,signal:'SIGSTOP'|'SIGKILL'):void
  report(line:string):void
}
export function createVerifyProcessTree(root:number|undefined,deps:VerifyTreeDeps) {
  const owned=new Map<number,string>(),reported=new Set<string>(),retired=new Set<number>()
  let initialized=false,exited=false
  const report=(message:string)=>{if(!reported.has(message)){reported.add(message);deps.report(message)}}
  const snapshot=()=>{
    const rows=deps.table()
    if(rows===null) {
      initialized=true
      report(`verify: process table unavailable; cleanup unconfirmed (root PID ${root??'?'})`)
      return []
    }
    if(!initialized) {
      initialized=true
      const first=rows.find(row=>row.pid===root)
      if(first&&!exited)owned.set(first.pid,first.birth)
      else report(`verify: root PID ${root??'?'} has no launch identity; no ownership claimed`)
    }
    if(root!==undefined&&owned.has(root)&&!rows.some(row=>row.pid===root))exited=true
    const live=new Set<number>()
    for(const row of rows) {
      const birth=owned.get(row.pid)
      if(birth===undefined)continue
      if(row.birth!==birth){retired.add(row.pid);report(`verify: PID ${row.pid} start identity changed; not signalled`);continue}
      if(retired.has(row.pid)||(row.pid===root&&exited))continue
      live.add(row.pid)
    }
    let changed=true
    while(changed) {
      changed=false
      for(const row of rows) {
        if(live.has(row.pid)||!live.has(row.parent)||row.pid===root)continue
        // Never adopt a replacement of any previously seen process.
        if(retired.has(row.pid)||(owned.has(row.pid)&&owned.get(row.pid)!==row.birth))continue
        live.add(row.pid);changed=true
        if(!owned.has(row.pid))owned.set(row.pid,row.birth)
      }
    }
    return rows.filter(row=>live.has(row.pid))
  }
  const signal=(row:VerifyProcess,sig:'SIGSTOP'|'SIGKILL')=>{
    const current=deps.table()?.find(value=>value.pid===row.pid)
    if(retired.has(row.pid)||(row.pid===root&&exited)||!current||current.birth!==owned.get(row.pid)) {
      if(current&&current.birth!==owned.get(row.pid))retired.add(row.pid)
      report(`verify: PID ${row.pid} exit/start identity not verified; not signalled`)
      return
    }
    try{deps.signal(row.pid,sig)}catch{report(`verify: PID ${row.pid} signal ${sig} failed; cleanup unconfirmed`)}
  }
  return {snapshot,rootExited(){exited=true},stop(){
    const frozen=new Map<number,VerifyProcess>()
    // Freeze validated parents, then discover children that raced the scan.
    // A fixed bound keeps cleanup itself finite; never signal an entire group.
    for(let pass=0;pass<10;pass++) {
      const pending=snapshot().filter(row=>!frozen.has(row.pid))
      if(!pending.length)break
      for(const row of pending){signal(row,'SIGSTOP');frozen.set(row.pid,row)}
    }
    const final=new Map(frozen)
    for(const row of snapshot())final.set(row.pid,row)
    for(const row of [...final.values()].reverse())signal(row,'SIGKILL')
  }}
}
