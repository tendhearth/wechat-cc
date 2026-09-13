// @ts-check
import {executionSignature} from './workbench-execution.js'
/** @typedef {import('./workbench-execution.js').ExecutionChoice} ExecutionChoice */
import {attachmentSignature,renderMessageAttachments} from './workbench-attachments.js'
/** @typedef {import('./workbench-attachments.js').Attachment} Attachment */
/** @typedef {{id:string,header:string,question:string,options:Array<{label:string,description:string}>,multiSelect?:boolean,allowOther?:boolean}} Question */
/** @typedef {{id:string,taskId:string,createdAt:number,questions:Question[]}} QuestionRequest */
/** @typedef {{id:string,taskId:string,runId:string,text:string,status:'pending'|'sending'|'delivered'|'held'|'withdrawn',createdAt:number,error:string|null,attachments?:Attachment[],execution?:ExecutionChoice}} LiveInput */
/** @typedef {Record<string,{selected:string[],other:string}>} AnswerDraft */
/** @typedef {{busy:boolean,error:string,resolved?:boolean}} ActionState */
/** @typedef {{id:string,runId:string,text:string,draftText?:string,acknowledged?:boolean,attachments?:Attachment[],execution?:ExecutionChoice,draftExecution?:ExecutionChoice|null,kind?:'continue'}} InputAttempt */
/** @typedef {Pick<Storage,'getItem'|'setItem'|'removeItem'>} StorageLike */
/** @typedef {ReturnType<typeof createWorkbenchInteractions>} Interactions */
/** @param {InputAttempt} attempt */
const attemptDraftExecution=attempt=>attempt.draftExecution!==undefined?attempt.draftExecution:attempt.execution
const PREFIX = 'cc.workbench.interaction.v1:'
const escape = (/** @type {unknown} */ value) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
const keyFor = (/** @type {string} */ taskId, /** @type {string} */ requestId) => JSON.stringify([taskId, requestId])
const fieldId = (/** @type {string} */ requestId, /** @type {string} */ questionId) => `wb-question-${encodeURIComponent(requestId)}-${encodeURIComponent(questionId)}`

/** Answers and submission identities are persisted per window; provider question text never enters storage.
 * @param {{invokeWorkbenchApi:(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>,storage?:StorageLike|null,inputAttempts?:Map<string,InputAttempt>,changed?:()=>void}} deps */
export function createWorkbenchInteractions(deps) {
  const storage = deps.storage ?? null
  /** @type {Map<string,AnswerDraft>} */ const drafts = new Map()
  /** @type {Map<string,InputAttempt>} */ const attempts = deps.inputAttempts ?? new Map()
  /** @type {Map<string,ActionState>} */ const states = new Map()
  const read = (/** @type {string} */ key) => { try { return JSON.parse(storage?.getItem(PREFIX + key) ?? 'null') } catch { return null } }
  const write = (/** @type {string} */ key, /** @type {unknown} */ value) => {
    try { if (value === null) storage?.removeItem(PREFIX + key); else storage?.setItem(PREFIX + key, JSON.stringify(value)) }
    catch { try { storage?.removeItem(PREFIX + key) } catch { /* memory remains available */ } }
  }
  const stateFor = (/** @type {string} */ key) => { if (!states.has(key)) states.set(key, { busy: false, error: '' }); return /** @type {ActionState} */ (states.get(key)) }
  const changed = () => deps.changed?.()
  const acknowledge = (/** @type {string} */ taskId, /** @type {string} */ requestId) => {
    const current = attempts.get(taskId) ?? read('input:' + taskId)
    if (current?.id === requestId && !current.acknowledged) {
      const accepted = { ...current, acknowledged: true }
      attempts.set(taskId, accepted); write('input:' + taskId, accepted)
    }
  }
  const errorText = (/** @type {unknown} */ error) => /stale|not_found|closed|not_active|not_running|archived|not_pending/.test(String(error))
    ? '这项请求已结束或状态已更新。你的文字仍保留，请查看最新任务。'
    : /too_long|too_large/.test(String(error)) ? '文字太长，请缩短后重试。' : '暂时没能确认提交结果。文字已保留，可以重试。'
  return {
    /** @param {string} taskId @param {string} requestId */
    getDraft(taskId, requestId) {
      const key = keyFor(taskId, requestId)
      if (!drafts.has(key)) {
        const saved = read('answer:' + key)
        /** @type {AnswerDraft} */ const valid = Object.create(null)
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) for (const [id, value] of Object.entries(saved)) {
          if (value && Array.isArray(value.selected) && value.selected.every((/** @type {unknown} */ item) => typeof item === 'string') && typeof value.other === 'string') valid[id] = { selected: value.selected.slice(0, 30), other: value.other.slice(0, 4000) }
        }
        drafts.set(key, valid)
      }
      return structuredClone(/** @type {AnswerDraft} */ (drafts.get(key)))
    },
    /** @param {string} taskId @param {string} requestId @param {AnswerDraft} value */
    setDraft(taskId, requestId, value) {
      if (this.questionState(taskId, requestId).resolved) return
      const key = keyFor(taskId, requestId), draft = structuredClone(value)
      drafts.set(key, draft); write('answer:' + key, draft)
    },
    /** @param {string} taskId */
    inputState(taskId) { return stateFor('input:' + taskId) },
    /** Explicitly composing different content starts a new supplement; polling never calls this.
     * @param {string} taskId @param {string} text @param {Attachment[]} [attachments] @param {ExecutionChoice} [execution] */
    editInputDraft(taskId, text, attachments=[],execution) {
      const attempt = attempts.get(taskId) ?? read('input:' + taskId)
      if (attempt && typeof attempt.text === 'string' && (attempt.acknowledged || attempt.text.trim() !== text.trim() || attachmentSignature(attempt.attachments)!==attachmentSignature(attachments)||executionSignature(attemptDraftExecution(attempt))!==executionSignature(execution))) this.resetInput(taskId, attempt.id)
    },
    /** A terminal continuation gets its run ID only after the service accepts it.
     * Persist its request identity before sending so reloads can retry or reconcile it.
     * @param {string} taskId @param {string} text @param {Attachment[]} [attachments] @param {ExecutionChoice} [execution] */
    continuationRequest(taskId,text,attachments=[],execution) {
      const previous=attempts.get(taskId)??read('input:'+taskId)
      const same=previous?.kind==='continue'&&typeof previous.id==='string'&&typeof previous.text==='string'&&previous.text.trim()===text.trim()&&attachmentSignature(previous.attachments)===attachmentSignature(attachments)&&executionSignature(previous.execution)===executionSignature(execution)
      /** @type {InputAttempt} */
      const attempt={id:same?previous.id:crypto.randomUUID(),kind:'continue',runId:'',text:text.trim(),draftText:text,...(execution?{execution:structuredClone(execution)}:{}),...(attachments.length?{attachments:structuredClone(attachments)}:{})}
      attempts.set(taskId,attempt);write('input:'+taskId,attempt)
      return attempt.id
    },
    /** Putting a held record back is an explicit new send decision.
     * @param {string} taskId @param {string} requestId */
    resetInput(taskId, requestId) {
      const attempt = attempts.get(taskId) ?? read('input:' + taskId)
      if (attempt?.id === requestId) { attempts.delete(taskId); write('input:' + taskId, null) }
    },
    /** Reconcile a preserved composer only against its own durable receipt.
     * @param {string} taskId @param {LiveInput[]} inputs @param {Attachment[]} [attachments] @param {ExecutionChoice} [execution] @returns {string|null} */
    acknowledgedInputDraft(taskId, inputs, attachments=[],execution) {
      const attempt = attempts.get(taskId) ?? read('input:' + taskId)
      if (!attempt || typeof attempt.text !== 'string' || attachmentSignature(attempt.attachments)!==attachmentSignature(attachments)||executionSignature(attemptDraftExecution(attempt))!==executionSignature(execution)) return null
      const receipt = inputs.find(input => input.id === attempt.id && input.taskId === taskId && (attempt.kind==='continue'||input.runId === attempt.runId) && input.text === attempt.text.trim() && attachmentSignature(input.attachments)===attachmentSignature(attempt.attachments)&&(!attempt.execution||executionSignature(input.execution)===executionSignature(attempt.execution)))
      if (!receipt || !['pending', 'sending', 'delivered', 'held', 'withdrawn'].includes(receipt.status)) return null
      acknowledge(taskId, attempt.id)
      return attempt.draftText ?? attempt.text
    },
    /** @param {string} taskId @param {string} requestId */
    questionState(taskId, requestId) { return stateFor('answer:' + keyFor(taskId, requestId)) },
    /** @param {string} taskId @param {string} runId @param {string} text @param {{attachments?:Attachment[],draftId?:string,execution?:ExecutionChoice,draftExecution?:ExecutionChoice}} [files] @returns {Promise<LiveInput|null>} */
    async sendInput(taskId, runId, text, files={}) {
      const attachments=files.attachments??[],execution=files.execution,draftExecution='draftExecution' in files?files.draftExecution:execution
      const draftText = text
      text = text.trim()
      const state = this.inputState(taskId)
      if (state.busy || !taskId || !runId || (!text&&!attachments.length)) return null
      if (text.length > 20000) { state.error = '补充最多 20,000 字，请缩短后发送。'; changed(); return null }
      const previous = attempts.get(taskId) ?? read('input:' + taskId)
      const sameDraft=previous&&typeof previous.id==='string'&&typeof previous.text==='string'&&previous.text.trim()===text&&attachmentSignature(previous.attachments)===attachmentSignature(attachments)&&executionSignature(attemptDraftExecution(previous))===executionSignature(draftExecution)
      // A pending terminal request retains its original accepted choice even if
      // another window starts a later run. A live supplement otherwise belongs
      // to the current run, separately from the composer's next-turn settings.
      /** @type {InputAttempt} */
      const attempt=sameDraft&&previous.kind==='continue'
        ? {...previous,draftText}
        : {id:sameDraft&&previous.runId===runId&&executionSignature(previous.execution)===executionSignature(execution)?previous.id:crypto.randomUUID(),runId,text,draftText,draftExecution:structuredClone(draftExecution??null),...(execution?{execution:structuredClone(execution)}:{}),...(attachments.length?{attachments:structuredClone(attachments)}:{})}
      attempts.set(taskId, attempt); write('input:' + taskId, attempt)
      state.busy = true; state.error = ''; changed()
      try {
        const result = /** @type {{input?:LiveInput}} */ (await deps.invokeWorkbenchApi('POST', '/v1/workbench/input', { id: taskId, runId, requestId: attempt.id, text, ...(attachments.length?{attachmentIds:attachments.map(a=>a.id),draftId:files.draftId}:{}) }))
        const receipt = result?.input
        if (!receipt || receipt.id !== attempt.id || receipt.taskId !== taskId || receipt.runId !== runId || receipt.text !== text || attachmentSignature(receipt.attachments)!==attachmentSignature(attachments) || (attempt.execution&&executionSignature(receipt.execution)!==executionSignature(attempt.execution)) || !['pending', 'sending', 'delivered', 'held', 'withdrawn'].includes(receipt.status)) throw new Error('unconfirmed_receipt')
        // A remounted composer can still show this text when the old request settles.
        // Keep its identity so an immediate retry cannot dispatch it a second time.
        acknowledge(taskId, attempt.id)
        return receipt
      } catch (error) { state.error = errorText(error); return null }
      finally { state.busy = false; changed() }
    },
    /** @param {QuestionRequest} request @param {boolean} [decline] */
    async answer(request, decline = false) {
      const state = this.questionState(request.taskId, request.id)
      if (state.busy || state.resolved) return false
      /** @type {Record<string,string[]>|null} */ const answers = decline ? null : Object.create(null)
      if (answers) {
        const draft = this.getDraft(request.taskId, request.id)
        let total = 0
        for (const question of request.questions) {
          const value = draft[question.id], other = value?.other?.trim() ?? ''
          const selected = [...new Set(value?.selected ?? [])].filter(label => question.options.some(option => option.label === label))
          const allowOther = question.allowOther !== false || !question.options.length
          const result = other && allowOther ? question.multiSelect ? [...selected, other] : [other] : selected
          total += result.reduce((sum, answer) => sum + answer.length, 0)
          if (!result.length || (!question.multiSelect && result.length !== 1) || result.some(answer => answer.length > 4000) || total > 20000) {
            state.error = '请回答每个问题；每项回答最多 4,000 字，总共最多 20,000 字。'; changed(); return false
          }
          answers[question.id] = result
        }
      }
      state.busy = true; state.error = ''; changed()
      try {
        const result = /** @type {{ok?:boolean}} */ (await deps.invokeWorkbenchApi('POST', '/v1/workbench/answer', { id: request.taskId, requestId: request.id, answers }))
        if (result?.ok !== true) throw new Error('unconfirmed_answer')
        state.resolved = true
        const key = keyFor(request.taskId, request.id)
        drafts.delete(key); write('answer:' + key, null)
        return true
      } catch (error) { state.error = errorText(error); return false }
      finally { state.busy = false; changed() }
    },
    /** @param {string} taskId @param {string} requestId */
    async withdraw(taskId, requestId) {
      const state = stateFor('withdraw:' + keyFor(taskId, requestId))
      if (state.busy) return false
      state.busy = true; state.error = ''; changed()
      try {
        const result = /** @type {{ok?:boolean}} */ (await deps.invokeWorkbenchApi('POST', '/v1/workbench/withdraw-input', { id: taskId, requestId }))
        if (result?.ok !== true) throw new Error('unconfirmed_withdrawal')
        return true
      } catch (error) { state.error = errorText(error); return false }
      finally { state.busy = false; changed() }
    },
    /** @param {string} taskId @param {string} requestId */
    withdrawalState(taskId, requestId) { return stateFor('withdraw:' + keyFor(taskId, requestId)) },
  }
}

/** @param {string} taskId @param {QuestionRequest[]} requests @param {Interactions} [interactions] */
export function renderWorkbenchQuestions(taskId, requests, interactions) {
  const own = requests.filter(request => request.taskId === taskId && !interactions?.questionState(taskId, request.id).resolved)
  if (!own.length) return ''
  return `<section class="wb-questions" aria-label="等待回答的问题"><header><h3>有问题想问你</h3><span>${own.length} 项</span></header>${own.map(request => {
    const state = interactions?.questionState(taskId, request.id), draft = interactions?.getDraft(taskId, request.id) ?? {}
    return `<form class="wb-question-form" data-action="answer-question" data-owner-task="${escape(taskId)}" data-request-id="${escape(request.id)}">${request.questions.map(question => {
      const id = fieldId(request.id, question.id), value = draft[question.id]
      const other = question.allowOther !== false || !question.options.length
      return `<fieldset data-question-id="${escape(question.id)}"><legend><span>${escape(question.header)}</span>${escape(question.question)}</legend>${question.multiSelect ? '<small>可选择多项</small>' : ''}<div class="wb-question-options">${question.options.map((option, index) => `<label for="${escape(id)}-${index}"><input id="${escape(id)}-${index}" name="${escape(id)}" type="${question.multiSelect ? 'checkbox' : 'radio'}" value="${escape(option.label)}"${value?.selected.includes(option.label) ? ' checked' : ''}><span>${escape(option.label)}${option.description ? `<small>${escape(option.description)}</small>` : ''}</span></label>`).join('')}</div>${other ? `<label class="wb-question-other" for="${escape(id)}-other">${question.options.length ? question.multiSelect ? '也可以补充' : '或自行填写（填写后使用这段回答）' : '你的回答'}<textarea id="${escape(id)}-other" data-question-other rows="2" maxlength="4000">${escape(value?.other ?? '')}</textarea></label>` : ''}</fieldset>`
    }).join('')}${state?.error ? `<p class="wb-interaction-error" role="alert">${escape(state.error)}</p>` : ''}<div class="wb-question-actions"><button id="${escape(fieldId(request.id, 'decline'))}" class="wb-btn" type="button" data-action="decline-question" data-owner-task="${escape(taskId)}" data-request-id="${escape(request.id)}"${state?.busy ? ' disabled' : ''}>跳过问题</button><button id="${escape(fieldId(request.id, 'submit'))}" class="wb-btn wb-btn-primary" type="submit"${state?.busy ? ' disabled' : ''}>${state?.busy ? '正在提交…' : '提交回答'}</button></div></form>`
  }).join('')}</section>`
}

/** Keep a single choice unambiguous while allowing extra text with checkboxes.
 * @param {HTMLInputElement|HTMLTextAreaElement} target */
export function syncWorkbenchQuestionChoice(target) {
  const fieldset = target.closest('fieldset[data-question-id]')
  if (!fieldset) return
  if ('questionOther' in target.dataset && target.value.trim()) {
    for (const radio of fieldset.querySelectorAll('input[type="radio"]')) /** @type {HTMLInputElement} */ (radio).checked = false
  } else if (target instanceof Object && 'type' in target && target.type === 'radio' && 'checked' in target && target.checked) {
    const other = /** @type {HTMLTextAreaElement|null} */ (fieldset.querySelector('[data-question-other]'))
    if (other) other.value = ''
  }
}

/** @param {HTMLElement} root @param {Interactions} interactions */
export function captureWorkbenchQuestionDrafts(root, interactions) {
  for (const form of root.querySelectorAll?.('form[data-action="answer-question"]') ?? []) {
    const owner = /** @type {HTMLElement} */ (form).dataset
    if (!owner.ownerTask || !owner.requestId) continue
    /** @type {AnswerDraft} */ const draft = Object.create(null)
    for (const fieldset of form.querySelectorAll('fieldset[data-question-id]')) {
      const id = /** @type {HTMLElement} */ (fieldset).dataset.questionId
      if (id) draft[id] = { selected: [...fieldset.querySelectorAll('input:checked')].map(field => /** @type {HTMLInputElement} */ (field).value), other: /** @type {HTMLTextAreaElement|null} */ (fieldset.querySelector('[data-question-other]'))?.value ?? '' }
    }
    interactions.setDraft(owner.ownerTask, owner.requestId, draft)
  }
}

/** @param {string} taskId @param {LiveInput[]} inputs @param {Interactions} [interactions] */
export function renderWorkbenchInputs(taskId, inputs, interactions) {
  const own = inputs.filter(input => input.taskId === taskId).slice(-50)
  if (!own.length) return ''
  const labels = { pending: '等待下一轮', sending: '等待交付确认', delivered: '已交付', held: '未发送', withdrawn: '已撤回' }
  const unresolved = own.some(input => ['pending', 'sending', 'held'].includes(input.status))
  return `<details id="wb-inputs" class="wb-disclosure wb-inputs"${unresolved ? ' open' : ''}><summary>补充记录 <small>${own.length} 条</small></summary>${own.map(input => {
    const state = interactions?.withdrawalState(taskId, input.id)
    const uncertain = input.status === 'held' && input.error?.startsWith('未确认执行者收到')
    return `<article class="wb-input-record" data-input-status="${escape(input.status)}"><header><span>${uncertain ? '未确认交付' : labels[input.status] ?? '等待确认'}</span>${input.status === 'pending' ? `<button type="button" class="wb-new" data-action="withdraw-input" data-owner-task="${escape(taskId)}" data-request-id="${escape(input.id)}"${state?.busy ? ' disabled' : ''}>${state?.busy ? '正在撤回…' : '撤回'}</button>` : input.status === 'held' ? `<button type="button" class="wb-new" data-action="copy-held-input" data-owner-task="${escape(taskId)}" data-request-id="${escape(input.id)}">放回输入框</button>` : ''}</header><p>${escape(input.text)}</p>${renderMessageAttachments(taskId,input.attachments)}${uncertain ? '<small>请先检查当前对话，再决定是否重发。</small>' : input.status === 'held' ? '<small>已保留，未自动重试。放回输入框后可修改并决定是否发送。</small>' : input.status === 'sending' ? '<small>尚未确认执行者收到；请勿重复发送。</small>' : ''}${state?.error ? `<p class="wb-interaction-error" role="alert">${escape(state.error)}</p>` : ''}</article>`
  }).join('')}</details>`
}
