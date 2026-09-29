// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分,spec 2026-09-27-cli-split-design);行为、参数、文案不变。
import { defineCommand } from 'citty'
import { STATE_DIR } from '../../lib/config'
// ── A2A agent management — wechat-cc agent {inspect,add,list,pause,resume,remove,activity} ──
//
// Pure wrappers over createA2ARegistry / createA2AClient / makeA2AEventsStore.
// Heavy logic lives in src/cli/agent.ts (testable without a running daemon).

const agentInspectCmd = defineCommand({
  meta: { name: 'inspect', description: 'Fetch Agent Card and print metadata' },
  args: {
    url: { type: 'positional', required: true, description: 'Agent base URL (/.well-known/agent.json is appended)', valueHint: 'url' },
  },
  async run({ args }) {
    const { cmdAgentInspect } = await import('../agent.ts')
    await cmdAgentInspect(args.url)
  },
})

const agentAddCmd = defineCommand({
  meta: { name: 'add', description: 'Register a new A2A agent (fetches Agent Card, generates inbound API key)' },
  args: {
    url: { type: 'positional', required: true, description: 'Agent base URL', valueHint: 'url' },
    id: { type: 'string', description: 'Explicit agent id slug (default: slugified name from Agent Card)' },
    'name-override': { type: 'string', description: 'Override the display name from the Agent Card' },
    'outbound-key': { type: 'string', description: 'Bearer key to send when wechat-cc calls out to this agent' },
  },
  async run({ args }) {
    const { cmdAgentAdd } = await import('../agent.ts')
    await cmdAgentAdd(STATE_DIR, args.url, {
      id: args.id,
      nameOverride: args['name-override'],
      outboundKey: args['outbound-key'],
    })
  },
})

const agentListCmd = defineCommand({
  meta: { name: 'list', description: 'List registered A2A agents' },
  async run() {
    const { cmdAgentList } = await import('../agent.ts')
    cmdAgentList(STATE_DIR)
  },
})

const agentPauseCmd = defineCommand({
  meta: { name: 'pause', description: 'Pause inbound/outbound for an agent' },
  args: {
    id: { type: 'positional', required: true, description: 'Agent id', valueHint: 'agent-id' },
  },
  async run({ args }) {
    const { cmdAgentPause } = await import('../agent.ts')
    cmdAgentPause(STATE_DIR, args.id, true)
  },
})

const agentResumeCmd = defineCommand({
  meta: { name: 'resume', description: 'Un-pause an agent' },
  args: {
    id: { type: 'positional', required: true, description: 'Agent id', valueHint: 'agent-id' },
  },
  async run({ args }) {
    const { cmdAgentPause } = await import('../agent.ts')
    cmdAgentPause(STATE_DIR, args.id, false)
  },
})

const agentRemoveCmd = defineCommand({
  meta: { name: 'remove', description: 'Drop agent registration' },
  args: {
    id: { type: 'positional', required: true, description: 'Agent id', valueHint: 'agent-id' },
  },
  async run({ args }) {
    const { cmdAgentRemove } = await import('../agent.ts')
    cmdAgentRemove(STATE_DIR, args.id)
  },
})

const agentActivityCmd = defineCommand({
  meta: { name: 'activity', description: 'Print recent A2A events for an agent (newest first)' },
  args: {
    id: { type: 'positional', required: true, description: 'Agent id', valueHint: 'agent-id' },
    limit: { type: 'string', description: 'Max events to show (default 20)' },
  },
  async run({ args }) {
    const limitNum = args.limit ? Number.parseInt(args.limit, 10) : 20
    const limit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 20
    const { cmdAgentActivity } = await import('../agent.ts')
    cmdAgentActivity(STATE_DIR, args.id, limit)
  },
})

const agentInfoCmd = defineCommand({
  meta: { name: 'info', description: "Show A2A server status (base URL + registered agents) — for sharing URL with external agents" },
  async run() {
    const { cmdAgentInfo } = await import('../agent.ts')
    cmdAgentInfo(STATE_DIR)
  },
})

const agentEditCmd = defineCommand({
  meta: { name: 'edit', description: 'Edit a registered A2A agent (rotate keys, rename, change URL) without remove + re-add' },
  args: {
    id: { type: 'positional', required: true, description: 'Agent id', valueHint: 'agent-id' },
    name: { type: 'string', description: 'New display name' },
    url: { type: 'string', description: 'New URL' },
    'outbound-key': { type: 'string', description: 'Rotate outbound API key (we use this when calling the agent)' },
    'rotate-inbound-key': { type: 'boolean', description: 'Generate a fresh inbound API key (external agent uses it to call us)' },
  },
  async run({ args }) {
    const { cmdAgentEdit } = await import('../agent.ts')
    cmdAgentEdit(STATE_DIR, args.id, {
      name: args.name,
      url: args.url,
      outboundKey: args['outbound-key'],
      rotateInboundKey: Boolean(args['rotate-inbound-key']),
    })
  },
})

const agentTestCmd = defineCommand({
  meta: { name: 'test', description: 'Send a synthetic notify to validate the inbound→chat path (default) or outbound (--outbound)' },
  args: {
    id: { type: 'positional', required: true, description: 'Registered agent id', valueHint: 'agent-id' },
    text: { type: 'string', description: 'Test message text (default: "test from <id> via wechat-cc")' },
    outbound: { type: 'boolean', description: 'Test outbound (wechat-cc → external agent) instead of inbound' },
  },
  async run({ args }) {
    const text = args.text ?? `test from ${args.id} via wechat-cc`
    const { cmdAgentTest } = await import('../agent.ts')
    await cmdAgentTest(STATE_DIR, args.id, text, { outbound: Boolean(args.outbound) })
  },
})

export const agentCmd = defineCommand({
  meta: { name: 'agent', description: 'A2A agent registry — register, inspect, pause, resume, remove, and view activity' },
  subCommands: {
    inspect: agentInspectCmd,
    add: agentAddCmd,
    list: agentListCmd,
    pause: agentPauseCmd,
    resume: agentResumeCmd,
    remove: agentRemoveCmd,
    activity: agentActivityCmd,
    info: agentInfoCmd,
    edit: agentEditCmd,
    test: agentTestCmd,
  },
})

