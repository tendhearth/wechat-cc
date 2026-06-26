#!/usr/bin/env bash
# Deterministic real-machine smoke checks for the 2026-06-26 robustness work.
# Covers the parts that DON'T need WeChat or a real sleep: db schema (v17 +
# new tables), the instance lock, and the dedicated heartbeat ticker firing
# independent of message traffic. The WeChat/sleep parts are a manual checklist
# in docs/smoke/2026-06-26-real-machine-smoke.md.
#
# Usage:  bash scripts/smoke-checks.sh           # daemon should be running
#         WECHAT_CC_STATE_DIR=/path bash scripts/smoke-checks.sh
set -uo pipefail

STATE_DIR="${WECHAT_CC_STATE_DIR:-$HOME/.claude/channels/wechat}"
DB="$STATE_DIR/wechat-cc.db"
HEARTBEAT="$STATE_DIR/server.heartbeat"
PIDFILE="$STATE_DIR/server.pid"

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
info() { printf '  ----  %s\n' "$1"; }

echo "state dir: $STATE_DIR"
echo

echo "[1] SQLite schema (v17 + dedup/poison tables)"
if [[ ! -f "$DB" ]]; then
  no "db not found at $DB — is the daemon set up?"
else
  ver=$(sqlite3 "$DB" 'PRAGMA user_version;' 2>/dev/null)
  [[ "$ver" == "17" ]] && ok "user_version = 17" || no "user_version = '$ver' (expected 17)"
  for t in handled_messages message_attempts; do
    n=$(sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$t';" 2>/dev/null)
    [[ "$n" == "1" ]] && ok "table $t exists" || no "table $t missing"
  done
fi
echo

echo "[2] Instance lock"
if [[ -f "$PIDFILE" ]]; then
  pid=$(cat "$PIDFILE" 2>/dev/null)
  if kill -0 "$pid" 2>/dev/null; then ok "server.pid=$pid is alive"
  else no "server.pid=$pid not alive (stale lock?)"; fi
else
  no "no server.pid — daemon not running (start it: wechat-cc service / bun run start)"
fi
echo

echo "[3] Dedicated heartbeat ticker (decoupled from poll/traffic)"
echo "    Reads server.heartbeat, waits 35s with NO messages sent, re-reads."
echo "    A 30s ticker must advance it even while the bot is idle."
if [[ -f "$HEARTBEAT" ]]; then
  h1=$(cat "$HEARTBEAT" 2>/dev/null)
  info "heartbeat now: $h1  — waiting 35s (send NO WeChat messages during this)…"
  sleep 35
  h2=$(cat "$HEARTBEAT" 2>/dev/null)
  if [[ "$h2" =~ ^[0-9]+$ && "$h1" =~ ^[0-9]+$ && "$h2" -gt "$h1" ]]; then
    ok "heartbeat advanced while idle ($h1 → $h2) — ticker is firing"
  else
    no "heartbeat did NOT advance ($h1 → $h2) — ticker may not be running"
  fi
else
  no "no server.heartbeat file — daemon not running or pre-this-build"
fi
echo

echo "─────────────────────────────────────────"
printf 'Automated checks: \033[32m%d pass\033[0m / \033[31m%d fail\033[0m\n' "$pass" "$fail"
echo "Now run the manual WeChat/sleep checklist:"
echo "  docs/smoke/2026-06-26-real-machine-smoke.md"
[[ "$fail" -eq 0 ]]
