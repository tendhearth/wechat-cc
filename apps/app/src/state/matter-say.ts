import { useEffect, useRef, useState } from 'react'
import { BackendError, type MatterInputT } from '../backend/types'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from './BackendProvider'
import { useConnection, useQuery, useSubmit } from './hooks'
import { useInputRecovery, useMatterInputs } from './useMatterInputs'
import { consumeMatterInputDraft, matchesMatterInput, matterInputState, matterInputs, updateMatterInput, type InputSnapshot } from './matter-inputs'
import { InputJournalError } from './input-journal'
import { getDraft, setDraft, materialDraftId, pairingGen } from './drafts'
import { bytesToBase64, uploadImages, type PickedImage } from './image-upload'
import { canSubmit } from '../view/connection'
import { inputFailure, inputRows } from '../view/matter-input'
import { composeTooLong } from '../view/compose'
import { useTerminalActions } from './useTerminal'

export type SayTarget = {kind:'matter';id:string}|{kind:'terminal';sessionId:string}
const NO_INPUTS: readonly MatterInputT[] = []
/** Same durable request/receipt path for attachment compose and inline task input. */
export function useMatterSay(target: SayTarget, options: {images?:PickedImage[];onImagesSent?(ids:string[]):void;enabled?:boolean} = {}) {
  const {backend,inputScope} = useBackendCtx(), lang=useLang()
  const conn=useConnection(), recovery=useInputRecovery(), submit=useSubmit()
  const id=target.kind==='matter'?target.id:''
  const draftKey=target.kind==='matter'?target.id:`terminal:${target.sessionId}`
  const draftKeyRef=useRef(draftKey); draftKeyRef.current=draftKey
  const [text,setTextState]=useState(()=>getDraft(draftKey)), textRef=useRef(text)
  const setText=(value:string)=>{textRef.current=value;setDraft(draftKey,value);setTextState(value)}
  const [busy,setBusy]=useState(false), [inputNotice,setInputNotice]=useState<string|null>(null)
  const sending=useRef(false), images=options.images??[]
  const detail=useQuery(`matter:${id}`, l=>backend.matter(id,l), {enabled:!!id && options.enabled!==false,refreshOnMount:true})
  const localInputs=useMatterInputs(id, detail.data?.inputs??NO_INPUTS)
  const refreshDetail=detail.refresh
  const online=canSubmit(conn) && recovery.phase==='ready' && (backend.mode!=='live'||!!recovery.scope&&recovery.scope===inputScope)
  const terminal=useTerminalActions()
  useEffect(()=>{textRef.current=getDraft(draftKey);setTextState(textRef.current);setInputNotice(null)},[draftKey,backend])
  useEffect(()=>{
    let alive=true
    if(id)void consumeMatterInputDraft(id).then(cleared=>{if(cleared&&alive&&draftKeyRef.current===id){textRef.current=getDraft(id);setTextState(textRef.current)}}).catch(()=>{})
    return ()=>{alive=false}
  },[id,localInputs])
  const sendInput = async (rawText: string, runId?: string, retry?: InputSnapshot) => {
    if (sending.current || !online) return
    const atGen = pairingGen()
    const journalGen = matterInputState.generation()
    sending.current = true; setBusy(true); setInputNotice(null)
    let snapshot: InputSnapshot
    try {
      // 补一句带的图(2026-10-06):新的一句才带当前选的图;重发沿用记录里那一组(图已经在电脑上了)
      const materials = !retry && images.length ? { draftId: materialDraftId(id), attachmentIds: images.map(i => i.id) } : undefined
      snapshot = await matterInputState.prepare(id, rawText, runId, retry, backend.mode === 'live', materials)
    } catch (e) {
      sending.current = false
      if (atGen === pairingGen()) {
        setBusy(false)
        setInputNotice(e instanceof InputJournalError && e.code === 'input_scope' ? null : t(lang, e instanceof InputJournalError && e.code === 'input_capacity' ? 'input.capacity' : 'input.storageNotSent'))
      }
      return
    }
    if (atGen !== pairingGen() || journalGen !== matterInputState.generation() || !canSubmit(backend.connection())) { sending.current = false; setBusy(false); return }
    const r = await submit(`compose:${snapshot.taskId}`, async () => {
      const withImages = snapshot.attachmentIds?.length && snapshot.draftId ? { draftId: snapshot.draftId, attachmentIds: snapshot.attachmentIds } : undefined
      // 这一屏里还拿着图的就先传(断点续传;传完的不再传);只剩记录、图已不在手里的,直接按 id 引用
      if (withImages) {
        const local = images.filter(i => withImages.attachmentIds.includes(i.id))
        if (local.length) await uploadImages(backend, withImages.draftId, local, bytesToBase64)
      }
      const opts = { ...(snapshot.runId ? { runId: snapshot.runId } : {}), ...(withImages ?? {}) }
      const result = await backend.say(snapshot.taskId, snapshot.text, snapshot.requestId, Object.keys(opts).length ? opts : undefined)
      if (result.kind !== 'task' || result.task.id !== snapshot.taskId) throw new BackendError('unknown')
      if (result.input && !matchesMatterInput(snapshot, result.input)) throw new BackendError('input_conflict')
      // A subscription/GET may already have a newer receipt while this POST waited.
      // Compare the prepared row itself so even a later retry cannot accept this response.
      const current = matterInputs(snapshot.taskId).find(row => row.requestId === snapshot.requestId)
      if (current !== snapshot || current.status !== 'submitting') return
      await updateMatterInput(snapshot, { status: result.input?.status ?? 'accepted' }, atGen, journalGen)
    })
    sending.current = false
    if (atGen !== pairingGen() || journalGen !== matterInputState.generation() || draftKeyRef.current !== snapshot.taskId) return
    setBusy(false)
    if (r === 'ok' && snapshot.attachmentIds?.length) { options.onImagesSent?.(snapshot.attachmentIds) }
    if (r !== 'ok') {
      // 重连查询若已核实真正回执,较晚的传输错误不能把它降成“不确定”。
      const current = matterInputs(snapshot.taskId).find(row => row.requestId === snapshot.requestId)
      if (!current || ['submitting', 'accepted', 'uncertain', 'failed', 'refused'].includes(current.status)) {
        await updateMatterInput(snapshot, inputFailure(r === 'busy' ? 'busy' : r.error), atGen, journalGen).catch(() => {})
      }
    }
    void refreshDetail()
  }
  const send = async () => {
    const raw=textRef.current, body=raw.trim()
    if(!body||!online||busy||!id)return
    if(composeTooLong(body)){setInputNotice(t(lang,'compose.tooLong'));return}
    const retry=matterInputs(id).findLast(row=>row.text===body&&['uncertain','failed'].includes(row.status))
    if(retry){await sendInput(retry.rawText,retry.runId,retry);return}
    // Accepted or pending snapshots are read-only until their exact receipt is known.
    if(matterInputs(id).some(row=>row.text===body&&['submitting','accepted','sending'].includes(row.status)))return
    if(!detail.fresh||detail.loading||detail.error)return
    await sendInput(raw,detail.data?.runId)
  }
  return {text,setText,busy,online,detail,send,sendInput,inputNotice,
    rows:inputRows(detail.data?.inputs??NO_INPUTS,localInputs),
    sendTerminal:terminal.say,
    terminalPending:terminal.pending}
}
