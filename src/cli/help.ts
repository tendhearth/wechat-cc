// 从 cli.ts 逐字搬出(2026-09-27 cli 拆分 Task 1)。SUBCOMMANDS 的每个键都要在这里出现(help.test.ts 守着)。
export const HELP_TEXT = `wechat-cc — WeChat bridge for Claude Code (Agent SDK daemon)

Usage:
  wechat-cc setup [--qr-json] Scan QR + bind a WeChat bot
  wechat-cc setup-poll --qrcode TOKEN [--base-url URL] [--json]
  wechat-cc run [--dangerously]   Start the daemon (foreground)
                        --dangerously: skip permission prompts
                        (matches claude --dangerously-skip-permissions)
  wechat-cc install [--user]   Register the MCP plugin entry for claude
  wechat-cc hook install [--claude] [--codex] [--json]
                        终端里的 claude / codex 跑完一个回合、或停下来等批准时
                        推到主人微信(写 ~/.claude/settings.json 与 $CODEX_HOME/
                        hooks.json 的 hooks;幂等;只动自己的条目)。
  wechat-cc hook uninstall | status
  wechat-cc status      Show daemon status + accounts
  wechat-cc list        List bound accounts
  wechat-cc doctor [--json]        Diagnose install/setup state
  wechat-cc setup-status [--json]  Machine-readable setup status for desktop UI
  wechat-cc service <status|install|start|stop|uninstall> [--json] [--unattended true|false] [--auto-start true|false]
                        --unattended: persist into agent-config and re-write plist.
                                      Idempotent: install replaces any existing daemon.
                        --auto-start: register for boot/login auto-start
                                      (macOS RunAtLoad, systemd enable,
                                      schtasks ONLOGON). Default false: opt-in.
                        Crash-respawn (macOS KeepAlive / systemd Restart=always)
                        is always on — no longer a user-facing flag.
  wechat-cc account remove <bot-id> [--json]
                        Decommission a bound bot — wipes its account dir,
                        context_token, user_account_id, session-state entry.
                        Restart the daemon afterwards for it to take effect.
  wechat-cc daemon kill <pid> [--json]
                        Force-kill a daemon process by pid. Verifies cmdline
                        contains cli.ts or src/daemon/main.ts before signaling.
                        SIGTERM (1.5s grace) then SIGKILL.
  wechat-cc daemon a2a enable [--host HOST] [--port PORT]
                        Enable the A2A inbound server (default 127.0.0.1:8717).
                        Writes agent-config.json; restart the daemon to apply.
  wechat-cc daemon a2a disable
                        Remove the A2A inbound server config.
  wechat-cc daemon a2a status
                        Show on-disk config vs runtime; flags drift between them.
  wechat-cc memory list [--json]
                        List Companion v2 memory files (per user).
  wechat-cc memory read <user-id> <path> [--json]
                        Read one .md memory file. Path is relative to the
                        user's memory dir, traversal-safe.
  wechat-cc memory write <user-id> <path> --body-base64 <b64> [--json]
                        Write/overwrite one .md memory file. Body is
                        passed as base64 (avoids shell-quote pain with
                        multi-line markdown). Sandboxed: .md only,
                        ≤100KB, no traversal, atomic rename.
  wechat-cc memory profile status [--chat-id <id>] [--json]
                        Inspect whether _profile.json is empty/ready/fresh/stale.
  wechat-cc memory profile generate [--chat-id <id>] [--provider claude|codex] [--dry-run] [--json]
                        Generate memory/<chat-id>/_profile.json for the
                        desktop memory page.
  wechat-cc memory profile-read <user-id> [--json]
                        Read memory/<user-id>/_profile.json.
  wechat-cc events list <chat-id> [--limit N] [--json]
                        Tail Companion decisions log (push/skip/observation/milestone).
  wechat-cc observations list <chat-id> [--include-archived] [--json]
                        Active observations (default) or archive.
  wechat-cc observations archive <chat-id> <obs-id> [--json]
                        Mark an observation archived (user "ignore").
  wechat-cc milestones list <chat-id> [--json]
                        Per-chat milestones (id-deduped).
  wechat-cc sessions list-chats [--json]
                        Contacts (chats) that have sessions.
  wechat-cc sessions list-projects [--chat <chat_id>] [--json]
                        Project sessions with cached summaries.
  wechat-cc sessions read-jsonl <alias> [--chat <chat_id>] [--json]
                        Read all turns from the alias's session jsonl.
  wechat-cc sessions delete <alias> [--chat <chat_id>] [--json]
                        Remove the sessions.json entry (jsonl on disk untouched).
  wechat-cc sessions search <query> [--limit N] [--json]
                        Naive case-insensitive substring search across
                        all sessions.json-registered jsonls.
  wechat-cc demo seed [--chat-id <id>] [--json]
                        Populate sample observations + milestones + events
                        for first-impression / screenshot use. Defaults to
                        companion default_chat_id if --chat-id omitted.
  wechat-cc demo unseed [--chat-id <id>] [--json]
                        Remove items written by \`demo seed\`. Idempotent.
  wechat-cc reply [--to <chat_id>] [text] [--json]
                        Send a text reply via WeChat. Reuses the daemon's
                        on-disk state (contextToken + account routing) so
                        recipient resolution matches the running daemon.
                        --to omitted → most-recently-active chat.
                        text omitted → read from stdin.
                        Useful when the daemon's MCP server is unreachable.
  wechat-cc logs [--tail N] [--json]
                        Tail the daemon's channel.log. Default --tail 50.
                        --json returns parsed entries (timestamp, tag,
                        message). Without --json, raw lines are printed
                        (equivalent to: tail -n N channel.log).
  wechat-cc log <tag> <msg> [--fields <json>] [--json]
                        Write a structured line to channel.log (frontend
                        telemetry). --fields must be a JSON object string.
                        Exits non-zero if --fields is malformed JSON.
  wechat-cc update [--check] [--json]
                        Pull latest + reinstall deps + restart service.
                        --check probes only (no side effects); GUI calls
                        this on a timer to surface the Update button.
  wechat-cc self deploy [--binary <path>] [--app <path>] [--no-rollback]
                        [--no-sign] [--allow-unsigned] [--health-timeout-ms N] [--json]
                        自维护:原子换 sidecar 进 .app、launchd 重启、健康门,
                        失败自动回滚(仅 macOS)。见 docs/maintainer/deploy.md。
  wechat-cc self change "<需求>" [--from cli|wechat] [--budget-usd N]
                        [--no-deploy] [--json]
  wechat-cc self change --resume <id> | --list | --unhalt
  wechat-cc self change --approve <id> | --deny <id> | --abandon <id>
                        自改:执行者在专用克隆里实现,依次过测试 / 评审 / CI /
                        主人微信拍板 / 合 dev 五道闸门,再部署 + 自检,不过就
                        回滚(仅 macOS)。退出码 0 完成 / 1 失败 / 2 停机·配额·
                        平台·daemon 没起 / 3 主人回了 n / 4 没等到拍板(可
                        --resume)。微信外发不通时用 --approve / --deny 在终端
                        拍板(桌面权限卡也行)。--abandon:这条不接了,记成作废
                        并删掉它的工作树(--list 能看到哪些树还占着盘)。
                        见 docs/maintainer/self-change.md。
  wechat-cc selftest workbench --executor <id> [--image] [--resume] [--json]
                        [--timeout-ms N] [--keep]
  wechat-cc selftest chat --provider <id> [--text "…"] [--resume] [--json]
                        [--timeout-ms N]
                        自维护:daemon 在跑的前提下做一次真机闭环自检并给出
                        机器可读的结论。--keep 保留 scratch 项目目录。
                        见 docs/maintainer/verify.md。
  wechat-cc ci triage [--sha <sha|HEAD>] [--branch <b>] [--wait] [--rerun]
                        [--max-reruns N] [--timeout-min N] [--json]
                        看 CI:这个 SHA 绿了吗?红的是自己的锅,还是
                        src/cli/ci-flakes.json 里登记过的 flake。退出码
                        0 绿 / 1 真红(含判不明白)/ 2 没有运行或 gh 出错 /
                        3 是已知 flake。见 docs/maintainer/ci-and-flakes.md。
  wechat-cc agent inspect <url>       Fetch Agent Card, print metadata
  wechat-cc agent add <url> [--id ID] [--name-override N] [--outbound-key K]
                        Register an external A2A agent; generates inbound API key.
  wechat-cc agent list              List registered A2A agents
  wechat-cc agent pause <id>        Pause inbound/outbound for an agent
  wechat-cc agent resume <id>       Un-pause an agent
  wechat-cc agent remove <id>       Drop agent registration
  wechat-cc agent activity <id> [--limit N]
                        Print recent A2A events (newest first, default 20)
  wechat-cc agent info              Show A2A server status (base URL + agent count)
  wechat-cc agent edit <id> [--name N] [--url U] [--outbound-key K] [--rotate-inbound-key]
                        Patch a registered agent in place (no remove + re-add)
  wechat-cc agent test <id> [--text MSG] [--outbound]
                        Send a synthetic notify to validate inbound→chat path
                        (default) or outbound (--outbound: send to external URL)
  wechat-cc social wishes [--json]
                        List my 心愿 + effective status (needs running daemon)
  wechat-cc social enable [--status]
                        一键开启觅食台社交(merge-persist,不覆盖已有设置);
                          --status 只打印当前三项设置,不写入
  wechat-cc provider show [--json]  Show selected agent provider
  wechat-cc provider set <claude|codex|cursor|openai|gemini|agy> [--model MODEL] [--unattended true|false]
                        --unattended: when true (default for new installs), the
                          installed daemon runs the daemon with --dangerously so
                          inbound WeChat messages don't hang waiting for human
                          permission prompts. Set false for interactive mode.
                        openai: also requires --base-url (e.g. an OpenAI-compatible
                          endpoint like https://api.deepseek.com/v1) the first time
                          it's set — persists to agent-config.json so future
                          'provider set openai' calls can omit it. API key is read
                          from the WECHAT_OPENAI_API_KEY env var, never persisted.

More subcommands (each has its own --help):
  wechat-cc access list|remove      Allowlist management — the add path stays in the admin chat flow
  wechat-cc avatar info|set|remove  Avatar metadata + binary (per chat / bot / user key)
  wechat-cc backup create|list|restore  备份/恢复不可再生数据(记忆、事实库、配置)
  wechat-cc cli status|upgrade|rollback  外部 agent CLI(claude/codex/cursor/agy)版本与自动升级
  wechat-cc connection probe        Inspect this machine's WeChat connection
  wechat-cc conversations list      Per-chat conversation modes (RFC 03)
  wechat-cc dialogue <timeline|threads|search|thread-detail|backfill|lock|unlock>
  wechat-cc guard status|enable|disable  Network-guard config + live probe
  wechat-cc hand add|accept|invite|join|list|ping  一个大脑多手: hand invite → hand join <code>
  wechat-cc license status|activate|deactivate  Manage the Pro license
  wechat-cc mode set …              Conversation mode management (via running daemon)
  wechat-cc pair [<6-digit code>]   配对码 — 和朋友的 bot 建边(需运行中的 daemon)
  wechat-cc install-progress        Read service-install progress (JSON; desktop wizard polls it)
  wechat-cc mcp-server <wechat|delegate>   Internal — stdio MCP server entrypoint (spawned by the daemon)
  wechat-cc federated-source …      Expose wechat as a hearth federated source (run mode: stdio MCP)

Notes for 0.x users:
  * The old --fresh / --continue flags are ignored; --dangerously is restored.
    v1.0 uses @anthropic-ai/claude-agent-sdk; daemon manages claude
    subprocesses internally, per-project session pool.
  * /restart from WeChat is removed. Use /project switch or restart
    the daemon process.
`
