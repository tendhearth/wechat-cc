import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createA2AServer, type NotifyEvent, type A2AServerOpts, type A2AServer } from '../../core/a2a-server'
import { verifyAndConsumeInvite } from '../../lib/a2a-pairing'
import type { A2ARegistry } from '../../core/a2a-registry'
import type { A2AClient } from '../../core/a2a-client'
import type { A2AEventsStore, AppendInput } from '../../core/a2a-events-store'
import type { DelegateDispatch } from './delegate'
import type { SendAssistantText } from './fallback-reply'
import type { AgentConfig } from '../../lib/agent-config'
import type { BootstrapDeps, Bootstrap } from './types'
import selfPkg from '../../../package.json' with { type: 'json' }

export interface A2aServerDeps {
  log: BootstrapDeps['log']
  stateDir: string
  configuredAgent: AgentConfig
  a2aRegistry: A2ARegistry
  a2aClient: A2AClient
  a2aEventsStore: A2AEventsStore
  dispatchDelegate: DelegateDispatch
  resolveOperatorChatId: () => string | null
  sendAssistantText: SendAssistantText | undefined
  onIntent: A2AServerOpts['onIntent']
  onReveal: A2AServerOpts['onReveal']
}

export interface A2aServerWiring {
  a2aServer: A2AServer | null
  a2aDeps: Bootstrap['a2aDeps']
}

export async function wireA2aServer(deps: A2aServerDeps): Promise<A2aServerWiring> {
  const {
    a2aRegistry, a2aClient, a2aEventsStore, dispatchDelegate,
    resolveOperatorChatId, sendAssistantText, configuredAgent,
    onIntent: socialOnIntent, onReveal: socialOnReveal,
  } = deps

  // onNotify: route inbound A2A notification → operator chat via sendAssistantText.
  // Formats the message as `[A2A:<agentId>] <text>` so the operator can
  // visually distinguish A2A pushes from regular assistant replies.
  async function routeA2ANotify(event: NotifyEvent): Promise<void> {
    const operatorChatId = resolveOperatorChatId()
    if (!operatorChatId) {
      deps.log('A2A_NOTIFY_IN', `dropping notify from ${event.agent.id}: no operator chat bound yet`)
      // Record the drop so operator sees it in the activity drawer instead
      // of wondering "the test said delivered, why didn't I get anything?"
      a2aEventsStore.append({
        direction: 'in', agent_id: event.agent.id, text: event.text,
        urgency: event.urgency, status: 'dropped_no_operator_chat',
      })
      return
    }
    const formatted = `[A2A:${event.agent.id}] ${event.text}`
    if (sendAssistantText) {
      await sendAssistantText(operatorChatId, formatted)
    }
    a2aEventsStore.append({
      direction: 'in', agent_id: event.agent.id, text: event.text,
      urgency: event.urgency, status: 'ok',
    })
  }

  // Server only starts if a2a_listen is configured. When absent, the
  // a2aServer handle is null and POST /v1/a2a/send still works (outbound
  // only — the daemon won't receive inbound pushes without a listener).
  let a2aServer: ReturnType<typeof createA2AServer> | null = null
  if (configuredAgent.a2a_listen) {
    a2aServer = createA2AServer({
      host: configuredAgent.a2a_listen.host,
      port: configuredAgent.a2a_listen.port,
      registry: a2aRegistry,
      onNotify: routeA2ANotify,
      // "Hand" capability (one-brain-many-hands): a registered peer can POST
      // /a2a/exec to run THIS machine's local agent on a task and get the
      // result, via the same one-shot delegate dispatcher used by /v1/delegate.
      onExec: (event) => dispatchDelegate(event.peer, event.prompt, event.cwd),
      // Smooth pairing (一条命令配对): a brain that holds a fresh invite secret
      // (from `hand invite` on this machine) POSTs /a2a/pair to auto-register
      // itself as an allowed delegator. Verify+consume the one-time secret,
      // then register the brain with the exec key it minted (re-pair refreshes
      // the key). Same record shape as `hand accept`, just no manual token copy.
      onPair: async ({ secret, brainId, execKey }) => {
        if (!verifyAndConsumeInvite(deps.stateDir, secret, Date.now())) {
          return { ok: false, error: 'invalid_or_expired_invite' }
        }
        const existing = a2aRegistry.get(brainId)
        if (existing) {
          a2aRegistry.update(brainId, { inbound_api_key: execKey })
        } else {
          a2aRegistry.add({
            id: brainId,
            name: brainId,
            url: 'http://brain.local/a2a',   // placeholder; exec replies inline, no callback needed
            inbound_api_key: execKey,        // brain presents this → hand verifies
            outbound_api_key: 'unused',      // hand → brain unused for exec; schema needs ≥1
            capabilities: [],
            paused: false,
            transport: 'push',
          })
        }
        a2aEventsStore.append({
          direction: 'in',
          agent_id: brainId,
          text: '<paired via invite code>',
          status: 'ok',
        })
        deps.log('A2A', `paired with brain "${brainId}" via invite code`)
        return { ok: true }
      },
      // Observability: 401/403 failures with an identifiable agent_id_claimed
      // get a `status='auth_failed'` row so the operator sees auth attempts
      // in the dashboard activity drawer + `wechat-cc agent activity <id>`.
      onAuthFailed: (event) => {
        a2aEventsStore.append({
          direction: 'in',
          agent_id: event.agent_id_claimed,
          text: `<auth_failed: ${event.reason}>`,
          status: 'auth_failed',
        })
      },
      // Agent-social M1 (T7b-core) — only wired when social_enabled +
      // social_disclosure_policy are configured (see wiring block above).
      // Undefined ⇒ /a2a/intent and /a2a/reveal both 501, exactly like
      // every other optional A2A capability.
      ...(socialOnIntent ? { onIntent: socialOnIntent } : {}),
      ...(socialOnReveal ? { onReveal: socialOnReveal } : {}),
      daemonInfo: { name: 'wechat-cc', version: selfPkg.version },
    })
    await a2aServer.start()
    deps.log('A2A', `server listening on http://${configuredAgent.a2a_listen.host}:${a2aServer.port()}`)
  }

  // Discovery file — non-sensitive (no token), tells CLI + dashboard the
  // daemon's A2A server status. Operator runs `wechat-cc agent info`,
  // which reads this file directly (no internal-api round-trip needed).
  // Mode 0644 because there's no secret here, just an HTTP base URL.
  const a2aInfoPath = join(deps.stateDir, 'a2a-info.json')
  try {
    writeFileSync(
      a2aInfoPath,
      JSON.stringify({
        enabled: !!a2aServer,
        base_url: a2aServer ? a2aServer.baseUrl() : null,
        host: a2aServer ? configuredAgent.a2a_listen!.host : null,
        port: a2aServer ? a2aServer.port() : null,
        pid: process.pid,
        ts: Date.now(),
      }, null, 2),
      { mode: 0o644 },
    )
  } catch { /* non-fatal: CLI falls back to internal-api lookup */ }

  const a2aDeps = {
    registry: a2aRegistry,
    client: a2aClient,
    eventsStore: a2aEventsStore,
    recordEvent: (event: AppendInput) => a2aEventsStore.append(event),
    serverEnabled: !!configuredAgent.a2a_listen,
    baseUrl: a2aServer ? a2aServer.baseUrl() : null,
  }

  return { a2aServer, a2aDeps }
}
