// @ts-check

/** @param {Date} date */
function localDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/** @param {Date} [now] */
export function defaultReviewRange(now = new Date()) {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const targetMonthLastDay = new Date(to.getFullYear(), to.getMonth() - 2, 0).getDate()
  const from = new Date(to.getFullYear(), to.getMonth() - 3, Math.min(to.getDate(), targetMonthLastDay))
  return { from: localDate(from), to: localDate(to) }
}

/** @template {{aiStatus:'open'|'completed'}} T @param {T[]} items @returns {T[]} */
export function orderReviewItems(items) {
  const rank = { open: 0, completed: 1 }
  return [...items].sort((a, b) => rank[a.aiStatus] - rank[b.aiStatus])
}

/**
 * User-facing failure copy. Internal error codes are intentionally never
 * shown: they describe implementation checks, not an action the owner can
 * take. The wording explains why we withheld an ungrounded AI conclusion.
 * @param {string|undefined} errorCode
 */
export function reviewFailureCopy(errorCode) {
  if (/^AI_(INVALID_AI_OUTPUT|COMMITMENT_NOT_OWNER_AUTHORED|UNKNOWN_EVIDENCE|EMPTY_COMMITMENT_EVIDENCE|DUPLICATE_COMMITMENT)$/.test(errorCode || "")) {
    return {
      title: "这次没有生成可核对的结果",
      body: "为避免把聊天内容误判为承诺，我们会核对每项结论是否有充分的聊天依据。这次分析结果没有通过校验，因此没有展示任何猜测性结论。",
      hint: "你可以重新分析；如果仍然失败，尝试缩短时间范围。",
    }
  }
  if (/^AI_TOO_MANY_OPEN_COMMITMENTS|^AI_INVALID_WINDOW_CONFIG/.test(errorCode || "")) {
    return {
      title: "这段沟通范围有些大",
      body: "为了可靠地核对承诺及其完成情况，这次范围暂时无法安全合并。",
      hint: "请缩短时间范围后重新分析。",
    }
  }
  if (/^SOURCE_/.test(errorCode || "")) {
    return {
      title: "暂时无法读取这段沟通",
      body: "这次没有成功取得所选客户在该时间范围内的聊天记录。",
      hint: "请稍后重试，并确认本机聊天记录已同步。",
    }
  }
  if (/^AI_.*(MODEL_UNAVAILABLE|PROVIDER)/.test(errorCode || "")) {
    return {
      title: "分析服务暂时不可用",
      body: "这次回顾尚未开始生成结果，你的聊天记录没有被改动。",
      hint: "请稍后重新分析。",
    }
  }
  return {
    title: "这次回顾暂时没有完成",
    body: "这次没有生成可以安全展示的回顾结果。",
    hint: "请稍后重新分析。",
  }
}

/**
 * Honest progress copy: the backend reports lifecycle state, not a fake
 * percentage or exact ETA. Elapsed time remains useful without pretending we
 * know how long a model call will take.
 * @param {'queued'|'analyzing'} status
 * @param {string|undefined} createdAt
 * @param {number} [nowMs]
 */
export function reviewProgressCopy(status, createdAt, nowMs = Date.now()) {
  const startedAt = createdAt ? new Date(createdAt).getTime() : nowMs
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - (Number.isFinite(startedAt) ? startedAt : nowMs)) / 1000))
  const elapsed = elapsedSeconds < 60
    ? `已等待 ${elapsedSeconds} 秒`
    : `已等待 ${Math.floor(elapsedSeconds / 60)} 分 ${elapsedSeconds % 60} 秒`
  if (status === 'queued') {
    return {
      kicker: '正在排队',
      detail: `${elapsed} · 通常会在几秒内开始分析。`,
    }
  }
  // Honest expectations, staged by reality: a three-month range with a few
  // thousand messages measures ~3 minutes (2026-08-24: 2525 msgs ≈ 3min) —
  // the old "20–60 秒" promise made a healthy run read as a hang.
  return {
    kicker: '正在分析',
    detail: elapsedSeconds < 60
      ? `${elapsed} · 通常一到几分钟，取决于聊天量。`
      : elapsedSeconds < 180
        ? `${elapsed} · 聊天多的范围要两三分钟，可以先去别的页看看。`
        : `${elapsed} · 大量聊天记录会到三五分钟，仍在认真读。`,
  }
}
