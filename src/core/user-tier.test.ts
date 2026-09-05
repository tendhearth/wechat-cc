import { describe, it, expect } from 'vitest'
import { resolveTier, resolveEffectiveTier, TIER_PROFILES, ALL_KINDS, type UserTier, type ToolKind } from './user-tier'
import type { Access } from '../lib/access'

const baseAccess: Access = {
  dmPolicy: 'allowlist',
  allowFrom: ['admin1', 'trusted1', 'guest1'],
  admins: ['admin1'],
  trusted: ['trusted1'],
}

describe('resolveTier', () => {
  it('returns admin when chatId is in admins', () => {
    expect(resolveTier('admin1', baseAccess)).toBe('admin')
  })

  it('returns trusted when chatId is in trusted but not admins', () => {
    expect(resolveTier('trusted1', baseAccess)).toBe('trusted')
  })

  it('returns guest for allowed-but-unclassified chats', () => {
    expect(resolveTier('guest1', baseAccess)).toBe('guest')
  })

  it('returns guest when admins is empty', () => {
    expect(resolveTier('any', { ...baseAccess, admins: [] })).toBe('guest')
  })

  it('admin takes precedence over trusted if both lists include the chatId', () => {
    expect(resolveTier('dupe', {
      ...baseAccess, admins: ['dupe'], trusted: ['dupe'],
    })).toBe('admin')
  })
})

describe('resolveEffectiveTier — --dangerously override', () => {
  it('strict mode: behaves identically to resolveTier', () => {
    expect(resolveEffectiveTier('admin1', baseAccess, 'strict')).toBe('admin')
    expect(resolveEffectiveTier('trusted1', baseAccess, 'strict')).toBe('trusted')
    expect(resolveEffectiveTier('guest1', baseAccess, 'strict')).toBe('guest')
    expect(resolveEffectiveTier('unknown', baseAccess, 'strict')).toBe('guest')
  })

  it('dangerously mode: every chat is promoted to admin', () => {
    // The operator launched `wechat-cc run --dangerously` expecting all
    // chats to bypass sandbox/relay. Pre-fix, only access.admins chats
    // got admin perms; guest/trusted chats silently kept their reduced
    // sandbox (codex guest → read-only + untrusted, claude trusted →
    // canUseTool relay) regardless of the daemon flag.
    expect(resolveEffectiveTier('admin1', baseAccess, 'dangerously')).toBe('admin')
    expect(resolveEffectiveTier('trusted1', baseAccess, 'dangerously')).toBe('admin')
    expect(resolveEffectiveTier('guest1', baseAccess, 'dangerously')).toBe('admin')
    expect(resolveEffectiveTier('unknown', baseAccess, 'dangerously')).toBe('admin')
  })
})

describe('TIER_PROFILES', () => {
  for (const tier of ['admin', 'trusted', 'guest'] as UserTier[]) {
    it(`tier=${tier}: allow ∪ relay ∪ deny covers every ToolKind exactly once`, () => {
      const p = TIER_PROFILES[tier]
      const seen = new Set<ToolKind>()
      for (const k of p.allow) seen.add(k)
      for (const k of p.relay) {
        expect(p.allow.has(k)).toBe(false)
        seen.add(k)
      }
      for (const k of p.deny) {
        expect(p.allow.has(k)).toBe(false)
        expect(p.relay.has(k)).toBe(false)
        seen.add(k)
      }
      for (const k of ALL_KINDS) {
        expect(seen.has(k)).toBe(true)
      }
    })
  }

  it('admin relays destructive ops only (post-RFC-05 / C4)', () => {
    // Post-RFC-05: admin tier is no longer "auto-bypass everything".
    // Destructive Bash and memory_delete now relay to the admin chat
    // (which is the admin themselves per resolveAdminChatId), giving
    // a "are you sure?" gate. Operators wanting zero prompts launch
    // with `--dangerously`.
    expect(TIER_PROFILES.admin.relay.has('shell_destructive')).toBe(true)
    expect(TIER_PROFILES.admin.relay.has('memory_delete')).toBe(true)
    // daemon_remediate also relays for admin (destructive daemon ops → confirm).
    expect(TIER_PROFILES.admin.relay.has('daemon_remediate')).toBe(true)
    expect(TIER_PROFILES.admin.relay.size).toBe(3)
    expect(TIER_PROFILES.admin.deny.size).toBe(0)
    // Non-destructive ops stay auto-allowed.
    expect(TIER_PROFILES.admin.allow.has('shell')).toBe(true)
    expect(TIER_PROFILES.admin.allow.has('fs_read')).toBe(true)
    expect(TIER_PROFILES.admin.allow.has('a2a_send')).toBe(true)
  })

  it('trusted relays shell_destructive and memory_delete; denies only admin-only tools', () => {
    expect(TIER_PROFILES.trusted.relay.has('shell_destructive')).toBe(true)
    expect(TIER_PROFILES.trusted.relay.has('memory_delete')).toBe(true)
    // trusted denies all admin-exclusive tools (was 0 before
    // self-diagnosis / remediation / plugin tools existed).
    expect(TIER_PROFILES.trusted.deny.size).toBe(12)
    expect(TIER_PROFILES.trusted.deny.has('daemon_introspect')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.has('daemon_remediate')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.has('file_locate')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.has('plugin_tool')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.has('social_seek')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.has('social_act')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.has('knowledge_search')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.has('federated_query')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.has('graph_query')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.has('facts_query')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.has('person_query')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.has('config_admin')).toBe(true)
  })

  it('guest allows only reply/share_page/memory_read/observations_read', () => {
    expect(TIER_PROFILES.guest.allow.has('reply')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('share_page')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('memory_read')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('observations_read')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('shell')).toBe(false)
    expect(TIER_PROFILES.guest.allow.has('fs_write')).toBe(false)
  })

  it('daemon_introspect (self-diagnosis tools) is admin-only — denied for trusted and guest', () => {
    // The read-only daemon diagnostic tools (turns / sessions / health) let
    // the operator ask the bot "check why X is broken". Only the admin should
    // see daemon internals; a trusted or guest chat must be refused.
    expect(TIER_PROFILES.admin.allow.has('daemon_introspect')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.has('daemon_introspect')).toBe(true)
    expect(TIER_PROFILES.trusted.allow.has('daemon_introspect')).toBe(false)
    expect(TIER_PROFILES.guest.deny.has('daemon_introspect')).toBe(true)
  })

  it('plugin_tool (any third-party plugin MCP tool) is admin-only — denied for trusted and guest', () => {
    // A plugin (e.g. wxvault = the owner's WeChat history) spawns arbitrary code
    // and can expose owner-private data. Fail closed: only the owner (admin) can
    // call a plugin's tools by default.
    expect(TIER_PROFILES.admin.allow.has('plugin_tool')).toBe(true)
    expect(TIER_PROFILES.trusted.deny.has('plugin_tool')).toBe(true)
    expect(TIER_PROFILES.trusted.allow.has('plugin_tool')).toBe(false)
    expect(TIER_PROFILES.guest.deny.has('plugin_tool')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('plugin_tool')).toBe(false)
  })

  it('daemon_remediate (release/restart/model-set) is admin-only and relays even for admin', () => {
    // Remediation actions can release sessions, switch model, restart the
    // daemon — strictly operator-only, and even admin gets an "are you sure?"
    // relay (it's a destructive op). Denied outright for trusted and guest.
    expect(TIER_PROFILES.admin.relay.has('daemon_remediate')).toBe(true)
    expect(TIER_PROFILES.admin.allow.has('daemon_remediate')).toBe(false)
    expect(TIER_PROFILES.trusted.deny.has('daemon_remediate')).toBe(true)
    expect(TIER_PROFILES.trusted.allow.has('daemon_remediate')).toBe(false)
    expect(TIER_PROFILES.guest.deny.has('daemon_remediate')).toBe(true)
  })
})

import { tierNameFromProfile } from './user-tier'

describe('tierNameFromProfile', () => {
  // Round-trip invariant over EVERY tier: tierNameFromProfile is a reverse
  // derivation (it capability-sniffs the profile to recover the name), and that
  // name becomes the minted token's authority + the wechat child's
  // WECHAT_SESSION_TIER admin gate. Looping over Object.keys means a future 4th
  // tier whose profile breaks the inference (e.g. a non-admin tier that allows
  // daemon_introspect) is caught here automatically, not silently mislabeled.
  it('round-trips every TIER_PROFILES entry back to its own name', () => {
    for (const name of Object.keys(TIER_PROFILES) as Array<keyof typeof TIER_PROFILES>) {
      expect(tierNameFromProfile(TIER_PROFILES[name]), `tier '${name}' must reverse-derive to itself`).toBe(name)
    }
  })
})

import { classifyToolUse } from './user-tier'

describe('classifyToolUse', () => {
  it('reply → reply', () => {
    expect(classifyToolUse('mcp__wechat__reply', {})).toBe('reply')
  })
  it('share_page → share_page', () => {
    expect(classifyToolUse('mcp__wechat__share_page', {})).toBe('share_page')
  })
  it('memory_list / memory_read → memory_read', () => {
    expect(classifyToolUse('mcp__wechat__memory_list', {})).toBe('memory_read')
    expect(classifyToolUse('mcp__wechat__memory_read', {})).toBe('memory_read')
  })
  it('memory_write / memory_edit → memory_write', () => {
    expect(classifyToolUse('mcp__wechat__memory_write', {})).toBe('memory_write')
    expect(classifyToolUse('mcp__wechat__memory_edit', {})).toBe('memory_write')
  })
  it('memory_delete → memory_delete', () => {
    expect(classifyToolUse('mcp__wechat__memory_delete', {})).toBe('memory_delete')
  })
  it('observations_list / observations_read → observations_read', () => {
    expect(classifyToolUse('mcp__wechat__observations_list', {})).toBe('observations_read')
    expect(classifyToolUse('mcp__wechat__observations_read', {})).toBe('observations_read')
  })
  it('observations_write / observations_archive → observations_write', () => {
    expect(classifyToolUse('mcp__wechat__observations_write', {})).toBe('observations_write')
    expect(classifyToolUse('mcp__wechat__observations_archive', {})).toBe('observations_write')
  })
  it('set_chat_pref → memory_write (a write must not classify as a read)', () => {
    expect(classifyToolUse('mcp__wechat__set_chat_pref', {})).toBe('memory_write')
  })
  it('send_sticker → reply, save_sticker → memory_write, list_stickers → memory_read', () => {
    expect(classifyToolUse('mcp__wechat__send_sticker', {})).toBe('reply')
    expect(classifyToolUse('mcp__wechat__search_online_sticker', {})).toBe('reply')
    expect(classifyToolUse('mcp__wechat__save_sticker', {})).toBe('memory_write')
    expect(classifyToolUse('mcp__wechat__list_stickers', {})).toBe('memory_read')
  })
  it('diagnostic_turns / diagnostic_sessions / diagnostic_health / model_get → daemon_introspect', () => {
    expect(classifyToolUse('mcp__wechat__diagnostic_turns', {})).toBe('daemon_introspect')
    expect(classifyToolUse('mcp__wechat__diagnostic_sessions', {})).toBe('daemon_introspect')
    expect(classifyToolUse('mcp__wechat__diagnostic_health', {})).toBe('daemon_introspect')
    expect(classifyToolUse('mcp__wechat__model_get', {})).toBe('daemon_introspect')
  })
  it('session_release / model_set / daemon_restart → daemon_remediate', () => {
    expect(classifyToolUse('mcp__wechat__session_release', {})).toBe('daemon_remediate')
    expect(classifyToolUse('mcp__wechat__model_set', {})).toBe('daemon_remediate')
    expect(classifyToolUse('mcp__wechat__daemon_restart', {})).toBe('daemon_remediate')
  })
  it('an unrecognized daemon-family wechat tool fails CLOSED into an admin-only kind', () => {
    // Name drift / new sibling tools must not silently drop to fs_read (which
    // trusted allows). Prefix classification keeps the family admin-only.
    expect(classifyToolUse('mcp__wechat__diagnostic_new_thing', {})).toBe('daemon_introspect')
    expect(classifyToolUse('mcp__wechat__daemon_shutdown', {})).toBe('daemon_remediate')
    expect(classifyToolUse('mcp__wechat__session_evict', {})).toBe('daemon_remediate')
    // A non-daemon unknown wechat tool still uses the permissive query default.
    expect(classifyToolUse('mcp__wechat__some_query_tool', {})).toBe('fs_read')
  })
  it('third-party plugin MCP tools → plugin_tool (admin-only, fail-closed)', () => {
    // Any non-wechat, non-delegate MCP server is a plugin; its tools must not
    // reach trusted/guest by default (wxvault would leak the owner's WeChat DB).
    expect(classifyToolUse('mcp__wxvault__get_messages', {})).toBe('plugin_tool')
    expect(classifyToolUse('mcp__wxvault__search_messages', {})).toBe('plugin_tool')
    expect(classifyToolUse('mcp__someplugin__anything', {})).toBe('plugin_tool')
  })
  it('delegate MCP tools stay subagent (owner cross-provider delegation, not a plugin)', () => {
    expect(classifyToolUse('mcp__delegate__delegate_claude', {})).toBe('subagent')
    expect(classifyToolUse('mcp__delegate__delegate_codex', {})).toBe('subagent')
  })
  it('Read / Glob / Grep / LS → fs_read', () => {
    expect(classifyToolUse('Read', {})).toBe('fs_read')
    expect(classifyToolUse('Glob', {})).toBe('fs_read')
    expect(classifyToolUse('Grep', {})).toBe('fs_read')
    expect(classifyToolUse('LS', {})).toBe('fs_read')
  })
  it('Write / Edit / NotebookEdit → fs_write', () => {
    expect(classifyToolUse('Write', {})).toBe('fs_write')
    expect(classifyToolUse('Edit', {})).toBe('fs_write')
    expect(classifyToolUse('NotebookEdit', {})).toBe('fs_write')
  })
  it('Bash with non-destructive command → shell', () => {
    expect(classifyToolUse('Bash', { command: 'ls -la' })).toBe('shell')
    expect(classifyToolUse('Bash', { command: 'git status' })).toBe('shell')
    expect(classifyToolUse('Bash', { command: 'echo hello' })).toBe('shell')
  })
  it('Bash with destructive patterns → shell_destructive', () => {
    expect(classifyToolUse('Bash', { command: 'rm -rf /tmp/foo' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'rm file.txt' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'git reset --hard HEAD~1' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'git push origin main --force' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'git push --force-with-lease' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'git branch -D feature' })).toBe('shell_destructive')
  })
  it('Bash with destructive command inside bash -c "..." → shell_destructive', () => {
    // AI agents routinely chain commands via `bash -c "..."`; the destructive
    // intent inside quotes must still trigger the relay. Trigger class
    // includes `'` and `"` for this reason.
    expect(classifyToolUse('Bash', { command: 'bash -c "rm -rf /tmp/important"' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: "bash -c 'rm -rf /tmp/important'" })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'sh -c "git reset --hard HEAD~1"' })).toBe('shell_destructive')
    expect(classifyToolUse('Bash', { command: 'bash -c "cd foo && git push --force"' })).toBe('shell_destructive')
  })
  it('Bash echoing a destructive string is a known false positive (relay-side)', () => {
    // Conservative classifier: prefer over-prompting to under-prompting.
    // `echo "rm is dangerous"` doesn't actually delete anything, but the
    // tier policy classifies it as destructive so the operator sees a
    // relay prompt. Acceptable trade since the intent is preventing
    // accidents, not stopping a determined adversary.
    expect(classifyToolUse('Bash', { command: 'echo "rm is dangerous"' })).toBe('shell_destructive')
  })
  it('Bash with rm-substring inside path is not destructive', () => {
    // The word-boundary anchor (`\s+` after rm) requires rm to look like a
    // command token, so `/var/farm/...` stays classified as plain shell.
    expect(classifyToolUse('Bash', { command: 'ls /var/farm/data' })).toBe('shell')
    expect(classifyToolUse('Bash', { command: 'cd /home/uname/' })).toBe('shell')
  })
  it('KillShell → shell', () => {
    expect(classifyToolUse('KillShell', { shell_id: 'x' })).toBe('shell')
  })
  it('WebFetch / WebSearch → network', () => {
    expect(classifyToolUse('WebFetch', {})).toBe('network')
    expect(classifyToolUse('WebSearch', {})).toBe('network')
  })
  it('Task → subagent', () => {
    expect(classifyToolUse('Task', {})).toBe('subagent')
  })
  it('unknown tool defaults to subagent (treated as untrusted)', () => {
    expect(classifyToolUse('SomeNewToolNobodyDocumented', {})).toBe('subagent')
  })
})

describe('user-tier — a2a_send', () => {
  it('classifies mcp__wechat__a2a_send as ToolKind a2a_send', () => {
    expect(classifyToolUse('mcp__wechat__a2a_send', { agent_id: 'x', text: 'hi' })).toBe('a2a_send')
  })

  it('admin tier allows a2a_send', () => {
    expect(TIER_PROFILES.admin.allow.has('a2a_send')).toBe(true)
  })

  it('trusted tier relays a2a_send (requires approval)', () => {
    expect(TIER_PROFILES.trusted.relay.has('a2a_send')).toBe(true)
    expect(TIER_PROFILES.trusted.allow.has('a2a_send')).toBe(false)
  })

  it('guest tier denies a2a_send', () => {
    expect(TIER_PROFILES.guest.allow.has('a2a_send')).toBe(false)
    expect(TIER_PROFILES.guest.relay.has('a2a_send')).toBe(false)
  })
})

describe('file_locate tier kind', () => {
  it('classifies locate_* wechat tools as file_locate (admin-only, prefix fail-closed)', () => {
    expect(classifyToolUse('mcp__wechat__locate_file', {})).toBe('file_locate')
    expect(classifyToolUse('mcp__wechat__locate_anything', {})).toBe('file_locate')
  })
  it('non-locate_ wechat tools still classify as fs_read (pin the prefix boundary)', () => {
    expect(classifyToolUse('mcp__wechat__something_new', {})).toBe('fs_read')
  })
  it('admin allows file_locate; trusted and guest deny it', () => {
    expect(TIER_PROFILES.admin.allow.has('file_locate')).toBe(true)
    expect(TIER_PROFILES.admin.relay.has('file_locate')).toBe(false)
    expect(TIER_PROFILES.trusted.deny.has('file_locate')).toBe(true)
    expect(TIER_PROFILES.guest.deny.has('file_locate')).toBe(true)
  })
})

describe('social_seek tier kind (M1 T6)', () => {
  it('classifies mcp__wechat__social_seek as ToolKind social_seek', () => {
    expect(classifyToolUse('mcp__wechat__social_seek', { topic: 'x' })).toBe('social_seek')
  })
  it('admin allows social_seek; trusted and guest deny it', () => {
    // social_seek initiates outbound social contact with external A2A agents
    // (unlike a2a_send, which replies to an already-established peer) —
    // admin-only, no relay path: trusted/guest are denied outright.
    expect(TIER_PROFILES.admin.allow.has('social_seek')).toBe(true)
    expect(TIER_PROFILES.admin.relay.has('social_seek')).toBe(false)
    expect(TIER_PROFILES.trusted.deny.has('social_seek')).toBe(true)
    expect(TIER_PROFILES.trusted.allow.has('social_seek')).toBe(false)
    expect(TIER_PROFILES.guest.deny.has('social_seek')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('social_seek')).toBe(false)
  })
})

describe('knowledge_search tier kind (agent-facing search AS T4)', () => {
  it('classifies mcp__wechat__knowledge_search as ToolKind knowledge_search', () => {
    expect(classifyToolUse('mcp__wechat__knowledge_search', { query: 'x' })).toBe('knowledge_search')
  })
  it('admin allows knowledge_search; trusted and guest deny it', () => {
    // knowledge_search runs a semantic query over the owner's WeChat message
    // history — same private-data trust class as file_locate/social_seek —
    // admin-only, no relay path: trusted/guest are denied outright.
    expect(TIER_PROFILES.admin.allow.has('knowledge_search')).toBe(true)
    expect(TIER_PROFILES.admin.relay.has('knowledge_search')).toBe(false)
    expect(TIER_PROFILES.trusted.deny.has('knowledge_search')).toBe(true)
    expect(TIER_PROFILES.trusted.allow.has('knowledge_search')).toBe(false)
    expect(TIER_PROFILES.guest.deny.has('knowledge_search')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('knowledge_search')).toBe(false)
  })
})

describe('federated_query tier kind (memory-infra Phase 2a HF W1)', () => {
  it('classifies mcp__wechat__federated_query as ToolKind federated_query', () => {
    expect(classifyToolUse('mcp__wechat__federated_query', { question: 'x' })).toBe('federated_query')
  })
  it('admin allows federated_query; trusted and guest deny it', () => {
    // federated_query reshapes the same knowledge_search retrieval into
    // hearth-compatible cited hits for a federated memory layer — same
    // private-data trust class as knowledge_search — admin-only, no relay
    // path: trusted/guest are denied outright.
    expect(TIER_PROFILES.admin.allow.has('federated_query')).toBe(true)
    expect(TIER_PROFILES.admin.relay.has('federated_query')).toBe(false)
    expect(TIER_PROFILES.trusted.deny.has('federated_query')).toBe(true)
    expect(TIER_PROFILES.trusted.allow.has('federated_query')).toBe(false)
    expect(TIER_PROFILES.guest.deny.has('federated_query')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('federated_query')).toBe(false)
  })
})

describe('graph_query tier kind (Knowledge Graph inproc GR T5)', () => {
  it('classifies the Graph Query MCP tools as ToolKind graph_query', () => {
    expect(classifyToolUse('mcp__wechat__contact_profile', { name: 'x' })).toBe('graph_query')
    expect(classifyToolUse('mcp__wechat__top_contacts', {})).toBe('graph_query')
    expect(classifyToolUse('mcp__wechat__relationship_subgraph', {})).toBe('graph_query')
    expect(classifyToolUse('mcp__wechat__connectors', { name_a: 'a', name_b: 'b' })).toBe('graph_query')
    expect(classifyToolUse('mcp__wechat__graph_status', {})).toBe('graph_query')
  })
  it('admin allows graph_query; trusted and guest deny it', () => {
    // graph_query reads the owner's full contact/relationship graph — same
    // private-data trust class as knowledge_search/file_locate/social_seek —
    // admin-only, no relay path: trusted/guest are denied outright.
    expect(TIER_PROFILES.admin.allow.has('graph_query')).toBe(true)
    expect(TIER_PROFILES.admin.relay.has('graph_query')).toBe(false)
    expect(TIER_PROFILES.trusted.deny.has('graph_query')).toBe(true)
    expect(TIER_PROFILES.trusted.allow.has('graph_query')).toBe(false)
    expect(TIER_PROFILES.guest.deny.has('graph_query')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('graph_query')).toBe(false)
  })
})

describe('facts_query / person_query tier kinds (Knowledge Facts/Person inproc FP T5)', () => {
  it('classifies the 6 Facts MCP tools as ToolKind facts_query', () => {
    expect(classifyToolUse('mcp__wechat__extraction_batch', {})).toBe('facts_query')
    expect(classifyToolUse('mcp__wechat__record_facts', { batch_id: 'x' })).toBe('facts_query')
    expect(classifyToolUse('mcp__wechat__contact_facts', { name: 'x' })).toBe('facts_query')
    expect(classifyToolUse('mcp__wechat__find_facts', {})).toBe('facts_query')
    expect(classifyToolUse('mcp__wechat__set_fact_status', { id: 1, status: 'resolved' })).toBe('facts_query')
    expect(classifyToolUse('mcp__wechat__extraction_status', {})).toBe('facts_query')
  })
  it('classifies config_get/config_set as ToolKind config_admin (admin-only)', () => {
    expect(classifyToolUse('mcp__wechat__config_get', {})).toBe('config_admin')
    expect(classifyToolUse('mcp__wechat__config_set', { key: 'model', value: 'x', reason: 'r' })).toBe('config_admin')
    expect(TIER_PROFILES.guest.deny.has('config_admin')).toBe(true)
  })

  it('classifies the person_brief MCP tool as ToolKind person_query', () => {
    expect(classifyToolUse('mcp__wechat__person_brief', { name: 'x' })).toBe('person_query')
  })
  it('admin allows facts_query/person_query; trusted and guest deny both', () => {
    // Same private-data trust class as graph_query/knowledge_search/
    // file_locate/social_seek — admin-only, no relay path: trusted/guest
    // are denied outright.
    for (const kind of ['facts_query', 'person_query'] as const) {
      expect(TIER_PROFILES.admin.allow.has(kind)).toBe(true)
      expect(TIER_PROFILES.admin.relay.has(kind)).toBe(false)
      expect(TIER_PROFILES.trusted.deny.has(kind)).toBe(true)
      expect(TIER_PROFILES.trusted.allow.has(kind)).toBe(false)
      expect(TIER_PROFILES.guest.deny.has(kind)).toBe(true)
      expect(TIER_PROFILES.guest.allow.has(kind)).toBe(false)
    }
  })
})

describe('social_act tier kind (social-tools 2026-09-05)', () => {
  const NAMES = ['wish_list', 'wish_send', 'wish_cancel', 'intro_request', 'intro_accept', 'intro_decline', 'intro_offers', 'relationships', 'visit'] as const
  it('classifies the nine mcp__wechat__ social tools as ToolKind social_act', () => {
    for (const n of NAMES) expect(classifyToolUse(`mcp__wechat__${n}`, {})).toBe('social_act')
  })
  it('leaves social_seek on its own kind', () => {
    expect(classifyToolUse('mcp__wechat__social_seek', { topic: 'x' })).toBe('social_seek')
  })
  it('admin allows social_act; trusted and guest deny it, no relay path', () => {
    // 认识 / 同意 / 不了 / 串门 / 查心愿都是替主人对外动作或读主人的社交状态,
    // 和 social_seek 同一信任档:只有主人能调,不走中继。
    expect(TIER_PROFILES.admin.allow.has('social_act')).toBe(true)
    expect(TIER_PROFILES.admin.relay.has('social_act')).toBe(false)
    expect(TIER_PROFILES.trusted.deny.has('social_act')).toBe(true)
    expect(TIER_PROFILES.trusted.allow.has('social_act')).toBe(false)
    expect(TIER_PROFILES.guest.deny.has('social_act')).toBe(true)
    expect(TIER_PROFILES.guest.allow.has('social_act')).toBe(false)
  })
})
