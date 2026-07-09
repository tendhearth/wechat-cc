# Reliability / Operability Backlog — 2026-06-07

Surfaced while debugging a "bot stopped replying" incident (see the connection-owner
work on branch `feat/connection-owner-detection`). Every item below was **verified
against the code** (file:line evidence included), not speculative. Ordered by
impact × effort. Pick up from here next session.

> Incident that motivated this: a daemon mid-init crash (`no such table:
> connection_heartbeat`) took the whole bot offline silently, while a stale
> installed daemon vs. a dev GUI caused hours of confusion. Most items below are
> the systemic gaps that let that happen.

---

## 🔴 Tier 1 — reliability (decides whether the bot can silently die)

### 1. Daemon boot is all-or-nothing — one optional subsystem can take the bot offline
**Evidence:** `src/daemon/main.ts:107` opens a single `try {` wrapping the entire
boot; `:163 } catch (err) { … :165 await shutdown(); throw err }`. Every
`register*` (guard, polling, companion, a2a) + `buildLifecycleDeps`
(`makeHeartbeatStore`/`makeSessionStateStore` prepared statements) is inside that
one try. No per-subsystem isolation.
**Risk:** A failure in a NON-essential subsystem (heartbeat store, guard, a2a,
companion) aborts the whole daemon — the poll loop never starts, the bot goes
silent. This is exactly the `connection_heartbeat` missing-table crash we hit.
**Direction:** Wrap optional subsystems in their own try/catch and degrade
gracefully (log + skip). Keep fatal only: db open, provider registration, ilink
poll loop, internal-api. "Bot still receives & replies" must survive a broken
heartbeat/guard/a2a.

### 2. Network guard is a single point of failure
**Evidence:**
- `src/daemon/guard/scheduler.ts:72-73` — fires `onStateChange` when the reachable
  bit flips, including `firstPoll` (startup). **No consecutive-failure threshold** —
  one probe failure (or first poll before network is ready, or an IP change from a
  VPN/DHCP rebind) trips it.
- `src/daemon/wiring/lifecycle-deps.ts` `onStateChange` only handles the DOWN branch
  (`prev.reachable && !next.reachable → boot.sessionManager.shutdown()`) — shuts
  down **ALL** sessions. There is **no UP branch** → no proactive session restore
  when the network returns; sessions only lazy-recover on the next inbound message.
**Risk:** A transient blip silently kills the bot's sessions; in a push-heavy /
low-inbound deployment it stays dead until a user messages. Compounded by the
auto-enable bug (below).
**Direction:** Require N consecutive real failures before shutdown; add an UP-branch
that proactively re-establishes sessions; keep default-off.
**Related open bug:** network guard auto-enables itself (instrumented this session —
`[GUARD_DIAG]` in channel.log + `[guard-diag]` in console; see commit `5e4a008`).
Root cause not yet found.

### 3. "测试本机连接" probe races the daemon's poll loop
**Evidence:** The CLI `connection probe` (`cli.ts` connectionProbeCmd) calls
`ilinkGetUpdates(baseUrl, token, '', 5000)` with an **empty sync_buf** in a separate
short-lived process, with **no lock / IPC / daemon-awareness**
(`src/daemon/connection-probe.ts`, no coordination). The daemon's poll loop
(`src/daemon/poll-loop.ts`) is concurrently calling getUpdates on the **same token**
with its own cursor. The probe discards any `msgs` it receives.
**Risk (conditional):** IF ilink uses a single server-side cursor per token, the
probe can steal/duplicate/skip messages the daemon should have received. The
`connection-probe.ts:8` header flags this as `待验证`.
**Mitigated by:** hiding the test button when connected (commit `7968469`) — in
practice the button is only clickable in recovering/taken_over states where the
daemon isn't actively polling. But the CLI command + the recovering-state window
still race.
**Direction:** First **verify ilink multi-reader semantics** (run getUpdates from
two clients on one token, watch for message loss). If single-cursor: route the
probe through the daemon's internal-api (single cursor owner), or skip the separate
getUpdates when the daemon is alive.

---

## 🟡 Tier 2 — observability / consistency (cost hours of confusion this session)

### 4. No version-consistency signal (GUI vs CLI vs daemon)
**Evidence:** `/v1/health` returns only `{ ok: true, daemon_pid }`
(`src/daemon/internal-api/routes.ts:42`). `internal-api-info.json` has no version.
The doctor report exposes claude/codex versions but not the daemon's own code
version. In debug builds the GUI runs `bun cli.ts` from source
(`apps/desktop/src-tauri/src/lib.rs:103-105`) while the launchagent may point at a
stale compiled binary in `/Applications`.
**Risk:** A dev GUI + stale installed daemon (different code) is **undetectable** —
this caused the multi-hour confusion this session.
**Direction:** Stamp the daemon's version/build-id; expose via `/v1/health` +
`internal-api-info.json`; dashboard warns on GUI↔daemon skew.

### 5. Liveness is a pid-signal probe, not a health ping
**Evidence:** `src/cli/doctor.ts` `readDaemon` derives `alive` from the `server.pid`
+ a `kill(pid,0)` signal probe (`:591`). The real HTTP `/v1/health` ping
(`apps/desktop/src/health-probe.js`, `lib.rs wechat_health_ping`) is only fired on
the manual "测试本机连接" click, NOT on the 5s doctor poll. `dashboardHero` shows
"AI 正在陪伴中" when `daemonAlive && accountCount>0` (`view.js:349`).
**Risk:** A daemon that is alive-as-a-process but stuck (poll loop wedged, ilink auth
failing) still shows green.
**Direction:** Fold the HTTP `/v1/health` ping into the doctor poll so "陪伴中"
reflects a responsive daemon, not just a live PID.

### 6. syncBuf is never persisted after boot
**Evidence:** `src/daemon/ilink-glue.ts:91-92` reads `<acctDir>/sync_buf` once at
boot (or `''`); the in-memory cursor advances in `poll-loop.ts:317-318` but is
**never written back** (no writes found in src/daemon).
**Risk:** On restart the daemon re-reads the old/empty sync_buf → may replay old
messages or miss messages across restarts. With a `KeepAlive=true` crash-loop this
amplifies.
**Direction:** Persist the advancing sync_buf (debounced) so restarts resume cleanly.

---

## 🟢 Tier 3 — hygiene (low cost)

### 7. Orphan rows accumulate on supersede / account-remove
**Evidence:** `src/lib/dedupe-accounts.ts` (re-scan supersede) only `renameSync`s the
dir to `.superseded.` — no SQLite cleanup. `src/cli/account-remove.ts:80` clears the
`session_state` row but **not** `connection_heartbeat`. `readExpiredBots` /
`readHeartbeats` (doctor.ts) filter orphans by live accounts, so no UI harm — but
rows accumulate unbounded.
**Direction:** Clear `session_state` + `connection_heartbeat` (+ any future
per-account tables) on both supersede and account-remove.

### 8. `ExpiredBotEntry.botId` actually carries `account.id` — naming debt
**Evidence:** `src/cli/doctor.ts` readExpiredBots stuffs `r.id` (=account dir id)
into the `botId` field; consumers (`view.js` accountRows, `dashboard.js`) look it up
by `account.id`. Documented but misleading — this exact key overload caused repeated
bugs this session.
**Direction:** Rename the field to `accountId` (or `id`) end-to-end.

### 9. No crash-loop backoff
**Evidence:** `src/cli/service-manager.ts:413-418` hardcodes `KeepAlive=true` with
**no `ThrottleInterval`** (macOS relies on launchd's 10s default); systemd uses a
flat `RestartSec=5` (`:457`) — no exponential backoff. `notify-startup.ts:56` only
suppresses the WeChat startup message on a <60s restart ("likely KeepAlive
crash-loop") — it does not slow restarts or alert via any other channel.
**Risk:** A persistent init failure (e.g. Tier-1 #1) hot-loops silently, burning
logs/CPU with no user-visible alert.
**Direction:** Add `ThrottleInterval`/backoff; surface a persistent-crash signal to
the user (the dashboard, or a one-time WeChat admin alert).

---

## Cleanup owed before merging `feat/connection-owner-detection`
- Remove the TEMP guard diagnostics once root-caused: `[guard-diag]` MutationObserver
  + invoke wrapper (`apps/desktop/src/main.js`) and `[GUARD_DIAG]` in
  `cli.ts setGuardEnabled`. (Commits `b6ba275`, `5e4a008`.)
