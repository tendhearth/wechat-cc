/**
 * 原生会话续接的核对:读取器、按页重读、派发前再核一遍「主人确认过的那份记录现在还是不是那样」。
 *
 * 原来在 native 域里;execute 派发前要 validateNativeDecision,而 native 域又要 execute.start ——
 * 两个域互相要。这一块只用 admission 的两个查询和 ctx,不碰 execute,单独放在这里之后
 * execute 与 native 都依赖它,native 改到 execute 之后建,环就没了。
 */
import { canonicalProject } from '../../../adapters/workbench/artifacts'
import { historyDeadline, type NativeHistoryProvider } from '../../../adapters/workbench/native-history'
import { pageInput, type AcceptedNativeResume, type ImportPage } from '../../../adapters/workbench/native-adoption'
import type { StoredTask } from '../../../adapters/store/workbench/store'
import { directoryIdentity } from './directory-identity'
import type { ServiceCtx } from './ctx'
import type { AdmissionDomain } from './admission'

/**
 * 原生会话记下的 cwd ⇒ 工作台用的项目路径:桌面导入与手机「接着做」共用这一条规则。
 * 先 realpath(符号链接、Windows junction、macOS 的 /var → /private/var 都落到真目录),之后所有比较与守卫
 * (目录身份、「在用」判断、路径冲突、私有目录)都只看这个解析后的路径 —— 链接指到哪,就按哪个真目录判,
 * 链接本身不给任何额外的权限。悬空 / 不是目录 / 不是绝对路径 ⇒ invalid_path。
 */
export function nativeProjectPath(cwd:string|null|undefined):string {
  if(!cwd)throw new Error('invalid_path')
  return canonicalProject(cwd)
}

export interface NativeCheckDomains {
  admission: Pick<AdmissionDomain,'taskVersion'|'canResume'>
}

export function makeNativeCheck(ctx:ServiceCtx, domains:NativeCheckDomains) {
  const { store } = ctx
  const { taskVersion, canResume } = domains.admission
  function nativeReader(id:string){const reader=ctx.deps.nativeHistory?.[id as NativeHistoryProvider];if(!reader)throw new Error('native_history_unsupported');return reader}
  async function currentNativePages(task:StoredTask,pages:ImportPage[]) {
    const call=historyDeadline(),key=Buffer.from(JSON.stringify({v:1,providerId:task.providerId,nativeId:store.source(task.id)!.nativeId})).toString('base64url')
    const current:ImportPage[]=[]
    for(const page of pages){
      const preview=await call(()=>nativeReader(task.providerId).read(key,pageInput(page)))
      if(preview.session.key!==key||preview.session.cwd!==store.source(task.id)!.cwd)throw new Error('native_history_changed')
      // 记下的路径没变、可它现在解析到的不再是任务的真目录(链接被改指)⇒ 不跟过去。
      if(nativeProjectPath(preview.session.cwd)!==task.path)throw new Error('invalid_path')
      if(preview.session.remote||preview.session.observedState==='active'||ctx.deps.executionConflict?.(task.path,task.providerId,store.source(task.id)!.nativeId))throw new Error('native_session_busy')
      current.push({...page,sourceFingerprint:preview.sourceFingerprint})
    }
    return current
  }
  async function validateNativeDecision(task:StoredTask,decision:AcceptedNativeResume,dispatch=false) {
    if(decision.taskId!==task.id||decision.sourceId!==store.source(task.id)?.id||decision.expiresAt<Date.now()||(!dispatch&&decision.taskVersion!==taskVersion(task)))throw new Error('external_close_confirmation_stale')
    if(directoryIdentity(task.path)!==decision.directoryIdentity||canonicalProject(task.path)!==task.path)throw new Error('invalid_path')
    if(ctx.deps.executionConflict?.(task.path,task.providerId,decision.nativeId))throw new Error('native_session_busy')
    if(decision.mode==='native_resume'){
      if(task.sessionId!==decision.nativeId||!canResume(task))throw new Error('restart_confirmation_required')
      const current=await currentNativePages(task,decision.pages)
      if(JSON.stringify(current)!==JSON.stringify(decision.pages))throw new Error('external_close_confirmation_stale')
    }
  }
  return { nativeReader, currentNativePages, validateNativeDecision }
}
export type NativeCheck = ReturnType<typeof makeNativeCheck>
