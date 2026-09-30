// 交办草稿只存内存,按 matter 参数分开('new' = 新事项)。
const drafts = new Map<string, string>()
export const getDraft = (key: string) => drafts.get(key) ?? ''
export const setDraft = (key: string, v: string) => { drafts.set(key, v) }
export const deleteDraft = (key: string) => { drafts.delete(key) }
export const clearDrafts = () => { drafts.clear() }
