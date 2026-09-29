/**
 * artifacts 域:每回合 / 结算时的成果收集、代码变更快照、基线重取,以及 artifact / approve 两个入口。
 * 从 service.ts 逐字搬来(spec 2026-09-27-workbench-service-split §3 第 5 项);只认 ctx,无跨域动作。
 * collect 的 promise 登记在 state.collections —— shutdown 靠它等收尾,必须是同一个 Set。
 */
import { ArtifactSnapshotError, canonicalProject, collectArtifacts, readArtifactSnapshot, saveArtifactSnapshot } from '../artifacts'
import { captureGitBaseline, finishGitReview, serializeGitReview, GIT_REVIEW_MIME } from '../git-review'
import { directoryIdentity } from './directory-identity'
import type { Active } from './state'
import type { ServiceCtx } from './ctx'

export interface ArtifactsDomain {
  collect(running:Active): Promise<void>
  collectTurnArtifacts(running:Active): void
  noteWarnings(running:Active,warnings:string[]): void
  captureTaskArtifacts(running:Active): void
  captureOutputs(running:Active): Promise<void>
  captureCodeChanges(running:Active): Promise<void>
  retakeBaseline(running:Active): Promise<void>
  artifact(id:string,artifactId:string): {name:string;mime:string;size:number;sha256:string;contentBase64:string}
  approve(id:string,artifactId:string,sha256:string): void
}

export function makeArtifactsDomain(ctx:ServiceCtx):ArtifactsDomain {
  const { store, state } = ctx
  function collect(running:Active):Promise<void> {
    if(running.collection)return running.collection
    if(state.shutdownComplete)return Promise.resolve()
    const pending=captureOutputs(running)
    running.collection=pending;state.collections.add(pending)
    void pending.then(()=>state.collections.delete(pending),()=>state.collections.delete(pending))
    return pending
  }
  /**
   * 回合结束就把成果登记上。会话保留时这条 run 不会结算,`collect` 也就不会跑,
   * 于是文件躺在成果目录里而详情的成果列表是空的 —— 主人得先「取消」才看得见
   * 自己刚拿到的东西(2026-09-15 真机)。`collectArtifacts` 按 name+sha256 去重,
   * 重复调用安全;结算时那次照旧,代码变更快照仍然只在那里生成。
   */
  function collectTurnArtifacts(running:Active) {
    if (running.artifactsCollected || state.shutdownComplete || running.turnCollection) return
    const pending=(async()=>{
      // 先让出事件流回调:目录扫描 + 哈希是同步的,别让它卡在 SDK 流的消费点上。
      await new Promise<void>(resolve=>setImmediate(resolve))
      if (state.shutdownComplete || running.artifactsCollected || running.uncertain || running.finishing || running.cancelled) return
      captureTaskArtifacts(running)
    })()
    running.turnCollection=pending;state.collections.add(pending)
    const clear=()=>{state.collections.delete(pending);if(running.turnCollection===pending)running.turnCollection=undefined}
    void pending.then(clear,clear)
  }
  function noteWarnings(running:Active,warnings:string[]) {
    const seen=(running.warned??=new Set())
    for (const warning of warnings) { if (seen.has(warning)) continue; seen.add(warning); store.addEvent(running.taskId,'system',warning); ctx.hub.touched(running.taskId) }
  }
  /** Every turn and final settlement use the same collector and failure semantics. */
  function captureTaskArtifacts(running:Active) {
    let stage:'project'|'output'='project'
    try {
      if(canonicalProject(running.path)!==running.path || directoryIdentity(running.path)!==running.directoryIdentity)throw new Error('invalid_path')
      stage='output'
      const warnings=collectArtifacts(store,running.taskId,running.path,ctx.stateDir)
      noteWarnings(running,warnings)
      if(running.collectionFailure) {
        store.addEvent(running.taskId,'system',warnings.length?'成果收集已恢复，部分文件仍未收集，请查看具体提示。':'成果收集已恢复，文件已保存，可在成果列表查看。')
        running.collectionFailure=undefined
      }
      ctx.hub.touched(running.taskId)
    } catch(error) {
      const failure=error instanceof ArtifactSnapshotError?'storage':stage
      const message=failure==='storage'
        ?'成果快照保存失败；原文件可能仍在项目中，但尚未全部保存到成果列表。请检查 CC 数据目录的空间和写入权限。'
        :failure==='project'
          ?'项目文件夹已移动、替换或无法访问，已停止收集成果。请检查原项目位置。'
          :'本轮成果目录无法读取，请检查目录权限及是否被移动或替换为链接。已保存的成果仍可查看。'
      try {
        if(running.collectionFailure!==failure)store.addEvent(running.taskId,'system',message)
        running.collectionFailure=failure
        ctx.hub.touched(running.taskId)
      } catch { /* The task database itself may be unavailable. */ }
    }
  }
  async function captureOutputs(running:Active) {
    if (running.artifactsCollected || state.shutdownComplete) return
    running.artifactsCollected=true
    // Let any turn collection finish before the final attempt, so a recovery
    // message cannot race with an older failure. Code review is independent.
    await running.turnCollection
    await captureCodeChanges(running)
    captureTaskArtifacts(running)
  }
  /**
   * 把当前基线以来的代码变更截成一份快照,然后丢掉基线。差异边界 = 回合边界:回合安静时
   * (以及结算时)截一次,续接时重新取基线 —— 同文件夹里别人改的文件不会被记到这条任务头上
   * (别人根本进不来:文件夹一直是它的)。
   */
  function captureCodeChanges(running:Active):Promise<void> {
    // 正在截的那份就是答案:续接会先 await 它再取新基线,所以这里复用不会把新回合的改动截进来。
    if (running.reviewCapture) return running.reviewCapture
    const pending=(async()=>{
      const baseline=running.reviewBaseline
      if (!baseline || !running.session) return
      running.reviewBaseline=undefined
      try {
        const report=await finishGitReview(baseline)
        if(state.shutdownComplete)return
        if(canonicalProject(running.path)!==running.path || directoryIdentity(running.path)!==running.directoryIdentity)throw new Error('invalid_path')
        if(!report||!report.files.some(f=>f.kind!=='not_reviewed'))return
        const seq=(running.reviewSeq??0)+1; running.reviewSeq=seq
        saveArtifactSnapshot(store,running.taskId,{name:`代码变更-${running.identity.slice(0,8)}${seq>1?`-${seq}`:''}.json`,mime:GIT_REVIEW_MIME,bytes:serializeGitReview(report)},ctx.stateDir)
        ctx.hub.touched(running.taskId)
      } catch { try { store.addEvent(running.taskId,'system','代码对比未能保存；其他成果仍会单独收集。');ctx.hub.touched(running.taskId) } catch { /* storage unavailable */ } }
    })()
    running.reviewCapture=pending
    void pending.then(()=>{if(running.reviewCapture===pending)running.reviewCapture=undefined},()=>{if(running.reviewCapture===pending)running.reviewCapture=undefined})
    return pending
  }
  /** 给「自己醒来的那一轮」重取一份差异基线。异步且吞异常(同 `submitInput` 里那一格);
   *  期间要是别人已经放了一份(主人正好也续接了),就不覆盖它。
   *  `baselineRetaking` 是在途守卫:基线要到结尾才落位,`!reviewBaseline` 挡不住在途的那一份,
   *  而一段自动续作会连着抖好几次 quiet↔busy —— 每次都开一个 `captureGitBaseline` 就是白跑一串
   *  git 子进程(BASE 用 `autonomousTurn` 挡的是同一件事,评审修复轮 #7)。 */
  async function retakeBaseline(running:Active):Promise<void> {
    if (running.baselineRetaking||running.reviewBaseline||running.cancelled||running.finishing||running.uncertain) return
    running.baselineRetaking=true
    try {
      const baseline=await captureGitBaseline(running.path,{})
      if (!running.reviewBaseline&&!running.cancelled&&!running.finishing&&!running.uncertain) running.reviewBaseline=baseline
    } catch { /* 没基线就没有这一轮的代码对比,其他成果照收 */ }
    finally { running.baselineRetaking=false }
  }
  /** 一件成果的字节与元数据(桌面下载、微信投递都从这里拿)。 */
  function artifact(id:string,artifactId:string) {
      const a=store.artifact(id,artifactId),bytes=readArtifactSnapshot(a.storagePath,ctx.stateDir,a.sha256)
      return {name:a.name,mime:a.mime,size:bytes.length,sha256:a.sha256,contentBase64:bytes.toString('base64')}
  }
  function approve(id:string,artifactId:string,sha256:string) { artifact(id,artifactId); store.approve(id,artifactId,sha256); ctx.hub.touched(id) }

  return { collect,collectTurnArtifacts,noteWarnings,captureTaskArtifacts,captureOutputs,captureCodeChanges,retakeBaseline,artifact,approve }
}
