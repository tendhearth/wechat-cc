import type {AgentExecutionChoice, AgentExecutionModel, AgentModelCatalog} from '../agent-provider'

const invalid = () => new Error('model_catalog_invalid')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const nativeModelId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
function field(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw invalid()
  return value
}
function entries(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 200 || value.some(item => !object(item))) throw invalid()
  return value
}
function id(value: unknown): string { if (!nativeModelId(value)) throw invalid(); return value }
function unique(models: AgentExecutionModel[]): AgentExecutionModel[] {
  const byId = new Map<string, AgentExecutionModel>()
  for (const model of models) {
    const previous = byId.get(model.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(model)) throw invalid()
    byId.set(model.id, model)
  }
  if (!byId.size) throw new Error('model_catalog_unavailable')
  return [...byId.values()]
}
export function claudeModelCatalog(raw: unknown): AgentModelCatalog {
  const models = entries(raw).map(value => {
    for (const key of ['supportsEffort', 'supportsAdaptiveThinking', 'supportsFastMode', 'supportsAutoMode']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw invalid()
    const efforts = value.supportedEffortLevels ?? []
    if (!Array.isArray(efforts) || efforts.length > 5 || efforts.some(level => !['low','medium','high','xhigh','max'].includes(level)) || (value.supportsEffort === false && efforts.length)) throw invalid()
    return {id:id(value.value), displayName:field(value.displayName,500), ...(value.description !== undefined ? {description:field(value.description,4000)} : {}), reasoningEfforts:[...new Set(efforts)] as string[]}
  })
  return {source:'native', models:unique(models)}
}
export function codexModelCatalog(raw: unknown, config: unknown): AgentModelCatalog {
  if (!object(config)) throw invalid()
  const values = entries(raw)
  const models = values.map(value => {
    id(value.id)
    const efforts = entries(value.supportedReasoningEfforts)
    if (efforts.length > 32 || typeof value.isDefault !== 'boolean') throw invalid()
    const modalities = value.inputModalities
    if (modalities !== undefined && (!Array.isArray(modalities) || modalities.length > 3 || modalities.some(item => !['text','image','audio'].includes(item)))) throw invalid()
    // Codex id identifies a picker preset; model is the slug accepted by thread start/resume.
    // CC's shared id is an execution key, so never expose the preset id as a task override.
    return {id:id(value.model), displayName:field(value.displayName,500), ...(value.description !== undefined ? {description:field(value.description,4000)} : {}), reasoningEfforts:[...new Set(efforts.map(effort => id(effort.reasoningEffort)))], defaultReasoningEffort:id(value.defaultReasoningEffort), ...(modalities !== undefined ? {inputModalities:[...new Set(modalities as string[])]} : {})}
  })
  const defaultModel = config.model == null ? values.find(value => value.isDefault)?.model : config.model
  return {source:'native',models:unique(models),...(defaultModel == null ? {} : {defaultModel:id(defaultModel)})}
}
export type CatalogRequest = (method: string, params: Record<string, unknown>) => Promise<Record<string, any>>
export async function readCodexModelCatalog(request: CatalogRequest, cwd: string): Promise<AgentModelCatalog> {
  const values: unknown[] = [], cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; ; page++) {
    if (page >= 20) throw invalid()
    const result = await request('model/list', {limit:100, includeHidden:false, ...(cursor ? {cursor} : {})})
    values.push(...entries(result.data))
    if (values.length > 200) throw invalid()
    if (result.nextCursor == null) break
    cursor = field(result.nextCursor, 1000)
    if (cursors.has(cursor)) throw invalid()
    cursors.add(cursor)
  }
  const result = await request('config/read', {cwd, includeLayers:false})
  return codexModelCatalog(values, result.config)
}
/** Unknown inherited/custom defaults remain usable until an explicit effort needs validation. */
export function executionModel(catalog: AgentModelCatalog, choice: AgentExecutionChoice, resolvedModel?: string): AgentExecutionModel | undefined {
  const selected = choice.model ?? resolvedModel ?? catalog.defaultModel
  const model = catalog.models.find(entry => entry.id === selected)
  if (choice.model && !model) throw new Error('execution_model_unsupported')
  if (choice.reasoningEffort && !model) throw new Error('execution_model_unknown')
  if (choice.reasoningEffort && !model!.reasoningEfforts.includes(choice.reasoningEffort)) throw new Error('execution_effort_unsupported')
  return model
}
