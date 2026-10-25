/**
 * Companion v2 config — radically simplified from v1.
 *
 * v1 had triggers[] + per_project_persona + personas[] — all deleted.
 * Those responsibilities moved to Claude's memory/ (self-organized).
 * This config keeps only the 3 knobs that MUST live in structured state
 * because Claude can't observe them without help:
 *
 *   - enabled: is proactive tick allowed? (daemon-level gate)
 *   - default_chat_id: where to push to by default
 *   - snooze_until: temporary hard stop (set via companion_snooze)
 *   - timezone: so the scheduler's jitter respects user locality
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from './read-json-file'
import { writeFileAtomic } from './json-file'

// 2026-10-23 从 src/daemon/companion/ 挪到 lib:CLI(memory write 认主人、demo)也要读它,
// 而 CLI 不该为读一份 JSON 去链 daemon(scripts/cli-ratchet.guard.test.ts)。
// 原来留在 daemon/companion 的两个转发(config.ts、paths.ts)在 A5 · 陪伴(2026-10-25)删掉了,所有引用都直接从这里引。
export function companionDir(stateDir: string): string {
  return join(stateDir, 'companion')
}

export function configPath(stateDir: string): string {
  return join(companionDir(stateDir), 'config.json')
}

export interface CompanionConfig {
  enabled: boolean
  timezone: string
  default_chat_id: string | null
  snooze_until: string | null
  /**
   * ISO timestamp of last successful introspect tick. Persisted across
   * daemon restarts so the 24h cadence isn't reset by every reboot. Null
   * when introspect has never run on this install. See main.ts
   * maybeStartupIntrospect for the catch-up logic.
   */
  last_introspect_at: string | null
  /**
   * Opt-in: auto-import the operator's LOCAL claude/codex history (zero-LLM
   * file scan) at startup + on the 24h introspect tick, and refresh the "懂你"
   * overview once/day. Default OFF — importing all of someone's local coding
   * history into the bot is privacy-sensitive, so it's an explicit choice.
   */
  import_local_history: boolean
  /** 每晚整理长期记忆 memory.md(2026-09-25,memory/nightly.ts)。 */
  memory_nightly_enabled: boolean
  /** 每晚整理的时间点,主人时区的 HH:MM。 */
  memory_nightly_at: string
  /** CC 不定期给主人写信(2026-10-16,letters/runtime.ts)。默认关:主人说要才开。 */
  letters_enabled: boolean
  /**
   * WRITE-side knowledge ingestion loop (keeps wxgraph/wxsearch/wxfacts fresh
   * from decrypted messages). Optional; absent = ON when the companion is
   * enabled. Set false to disable ingestion independently of proactive push —
   * ingestion is silent maintenance and spends cheap-eval tokens on extraction,
   * so it gets its own off-switch.
   */
  ingest_enabled?: boolean
  /**
   * Optional MCP client to a local `hearth` server, for pushing distilled
   * knowledge into hearth's vault. Default OFF: this is a dormant capability
   * added by memory-infra Phase 1 — with hearth_enabled false (the default),
   * wechat-cc's behavior is unchanged. See src/features/companion/hearth-client.ts.
   */
  hearth_enabled: boolean
  /** Path to the hearth vault to write into. Required (non-null) for hearth_enabled to take effect. */
  hearth_vault: string | null
  /**
   * Command line to spawn the hearth MCP server, e.g. "hearth mcp serve".
   * Null → defaults to "hearth mcp serve" on PATH.
   */
  hearth_cmd: string | null
  /** CC Atelier autonomous art mode. Default off; private keeps works local. */
  atelier_mode: 'off' | 'private' | 'share'
}

export function defaultCompanionConfig(): CompanionConfig {
  return {
    enabled: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    default_chat_id: null,
    snooze_until: null,
    last_introspect_at: null,
    import_local_history: false,
    memory_nightly_enabled: true,
    memory_nightly_at: '04:00',
    letters_enabled: false,
    hearth_enabled: false,
    hearth_vault: null,
    hearth_cmd: null,
    atelier_mode: 'off',
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function loadCompanionConfig(stateDir: string): CompanionConfig {
  const p = configPath(stateDir)
  if (!existsSync(p)) return defaultCompanionConfig()
  try {
    const parsed = readJsonFile(p) as unknown
    if (!isObject(parsed)) return defaultCompanionConfig()
    const d = defaultCompanionConfig()
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : d.enabled,
      timezone: typeof parsed.timezone === 'string' && parsed.timezone ? parsed.timezone : d.timezone,
      default_chat_id: typeof parsed.default_chat_id === 'string' ? parsed.default_chat_id : null,
      snooze_until: typeof parsed.snooze_until === 'string' ? parsed.snooze_until : null,
      last_introspect_at: typeof parsed.last_introspect_at === 'string' ? parsed.last_introspect_at : null,
      import_local_history: typeof parsed.import_local_history === 'boolean' ? parsed.import_local_history : d.import_local_history,
      memory_nightly_enabled: typeof parsed.memory_nightly_enabled === 'boolean' ? parsed.memory_nightly_enabled : d.memory_nightly_enabled,
      memory_nightly_at: typeof parsed.memory_nightly_at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.memory_nightly_at) ? parsed.memory_nightly_at : d.memory_nightly_at,
      letters_enabled: typeof parsed.letters_enabled === 'boolean' ? parsed.letters_enabled : d.letters_enabled,
      ingest_enabled: typeof parsed.ingest_enabled === 'boolean' ? parsed.ingest_enabled : undefined,
      hearth_enabled: typeof parsed.hearth_enabled === 'boolean' ? parsed.hearth_enabled : d.hearth_enabled,
      hearth_vault: typeof parsed.hearth_vault === 'string' ? parsed.hearth_vault : null,
      hearth_cmd: typeof parsed.hearth_cmd === 'string' ? parsed.hearth_cmd : null,
      atelier_mode: parsed.atelier_mode === 'private' || parsed.atelier_mode === 'share' ? parsed.atelier_mode : d.atelier_mode,
    }
    // Legacy triggers/per_project_persona/triggers fields (if any) are
    // silently dropped on next save — migration path for v1.1 installs.
  } catch {
    return defaultCompanionConfig()
  }
}

export async function saveCompanionConfig(stateDir: string, cfg: CompanionConfig): Promise<void> {
  const p = configPath(stateDir)
  if (!existsSync(companionDir(stateDir))) {
    mkdirSync(companionDir(stateDir), { recursive: true })
  }
  writeFileAtomic(p, JSON.stringify(cfg, null, 2))
}
