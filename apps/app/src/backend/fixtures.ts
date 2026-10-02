/**
 * fixtures.ts — 过真 PHONE_API_SCHEMAS 的共用测试夹具(live.test.ts 第一条用例钉住它们是真形状)。
 * LiveBackend / 配对 / 端到端测试共用这一份,别在各个测试里各抄一遍。纯数据,不引任何运行时。
 */
export const ID = 'ab12cd34'
export const RUN = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
export const REQ = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d'
export const MATTER = { id: ID, kind: 'task', title: 'Fix the build', projectPath: '/p', status: 'open', ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 2 }
export const TASK = { id: ID, title: 'Fix the build', status: 'running', phase: 'working', providerId: 'claude', path: '/p', error: null, updatedAt: 2 }
export const DETAIL = { matter: MATTER, bindings: [], sessions: [], task: TASK, events: [{ kind: 'progress', text: 'ran tests', createdAt: 3 }], runId: RUN, inputMode: 'steer', permissions: [{ id: REQ, taskId: ID, tool: 'Bash', description: 'npm test', createdAt: 3 }], questions: [], artifacts: [], inputs: [] }
export const CAPS = { version: 1, permissions: 'task', configuration: 'task-policy', completion: 'native', stop: 'confirmed', background: 'tracked', features: { nativeResume: true, attachments: true, executionSettings: false, modelCatalog: false } }
export const OPTIONS = { status: 'ready', defaultProviderId: 'claude', providers: [{ id: 'claude', displayName: 'Claude', available: true, capabilities: CAPS }], projects: [{ id: 'p-0123456789abcdef0123', name: 'Portfolio', path: '/p', providerId: null }] }
export const WB_TASK = { id: ID, title: 'x', path: '/p', providerId: 'claude', status: 'queued', workspaceKind: 'project', createdAt: 1, updatedAt: 1, error: null, archivedAt: null, phase: 'queued', canArchive: false, waitingFor: null }
export const RECEIPT = { requestId: REQ, taskId: ID, matterId: ID, runId: RUN, acceptedAt: 5 }
export const MODELS = { default_provider: 'claude', checked_at: null, providers: [], openai: { base_url: '', model: '', has_key: false, aliases: {} }, gemini: { has_key: false }, cheap: '', trusted_providers: null, shared_token: [], guest_blocked: [] }
export const DEVICES = [{ id: 'aa11bb22', created_at: '2026-09-30T00:00:00Z', last_seen_at: '2026-09-30T01:00:00Z', current: true }, { id: 'cc33dd44', created_at: '2026-09-01T00:00:00Z', last_seen_at: '2026-09-02T00:00:00Z', label: 'Old phone', current: false }]
/** GET /set/api/state 的成功返回;devices 可换(配对测试只要一台 current)。 */
export const stateWith = (devices: readonly unknown[]) => ({ ok: true, name: '', persona: '', prefs: {}, config: {}, remote: { available: true, enabled: true, devices }, atelier: { model_status: null }, models: MODELS })
export const STATE = stateWith(DEVICES)
export const PROGRESS = { summary: 'going well', steps: [{ title: 'a', detail: 'b' }], source: 'model' }
