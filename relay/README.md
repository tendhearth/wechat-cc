# Mailbox relay — deploy runbook (v0, single relay)

> Standalone content-blind mailbox relay for wechat-cc sub-project B. NOT part of
> the daemon. Node-builtin-only (Bun + bun:sqlite). Manually verified on the VPS
> (outside CI). See docs/superpowers/specs/2026-07-19-penpal-mailbox-transport-B-design.md.

## 0. Prereqs
- A VPS with a public HTTPS name (v0: `brain.youdamaster.cc`), Bun ≥ 1.1 installed.
- A TLS terminator in front (Caddy/nginx) — the relay itself serves plain HTTP on `RELAY_PORT`.

## 1. Copy + run the relay
```bash
# on the VPS
git clone <repo> wechat-cc && cd wechat-cc
RELAY_PORT=8787 RELAY_DB=/var/lib/mailbox/mailbox.sqlite bun relay/server.ts
```
Expected: `[relay] listening on :8787`. The SQLite file + WAL are created on first drop.

## 2. Front it with HTTPS (Caddy example)
```
mailbox.youdamaster.cc {
  reverse_proxy 127.0.0.1:8787
}
```
`caddy reload`. Confirm: `curl -sS https://mailbox.youdamaster.cc/drop -d '{}' -H 'content-type: application/json'` → `{"error":"invalid_body"}` (400) — proves the route is reachable and validating.

## 3. Run it as a service (systemd)
```ini
# /etc/systemd/system/mailbox-relay.service
[Service]
Environment=RELAY_PORT=8787 RELAY_DB=/var/lib/mailbox/mailbox.sqlite
ExecStart=/usr/local/bin/bun /opt/wechat-cc/relay/server.ts
Restart=always
```
```bash
systemctl daemon-reload && systemctl enable --now mailbox-relay && systemctl status mailbox-relay
```

## 4. Point a client daemon at the relay
Add the relay to the daemon's own advertised list (edit `agent-config.json` in the state dir, or via the CLI once wired):
```json
{ "social_enabled": true, "mailbox_relays": ["https://mailbox.youdamaster.cc"] }
```
Restart the daemon. On boot it generates `mailbox-key.json` (0600) in the state dir and the poller starts (log tag `SCHED mailbox scheduler started`). Advertise `{mailbox_addr, mailbox_enc_pub, relays}` to peers by registering them with `transport: "mailbox"`.

## 5. Manual end-to-end verification (two machines behind NAT)
1. On daemon A: `cat "$STATE_DIR/mailbox-key.json" | jq .addr` → note A's mailbox address; confirm the file is `-rw-------` (0600).
2. Register A on B (and B on A) as `transport: mailbox` with each other's `mailbox_addr` + `mailbox_enc_pub` + `relays`.
3. Complete a reveal (FoF or direct) so the channel opens and crosses mailbox addresses.
4. Send a letter from A to B; within ~2 min (poll interval + jitter) B's owner sees `📬 …给你写信了`.
5. On the relay: `sqlite3 /var/lib/mailbox/mailbox.sqlite 'SELECT recipient, length(envelope) FROM mailbox_item'` → rows exist keyed by mailbox address, and `SELECT envelope FROM mailbox_item LIMIT 1` is opaque base64url JSON (no plaintext, no channel id, no bearer). **Content-blindness confirmed.**
6. Confirm ack: after B polls, the row is gone (or TTL-swept after 7 days if B never polls).

## 6. Operational notes
- **Precondition (M1):** a mailbox peer MUST be registered with all three of `mailbox_addr`, `mailbox_enc_pub`, `relays` populated (from the peer's `mailbox-key.json` + its `mailbox_relays`). A record missing any of them silently degrades to `push` and a NAT'd peer's letters will FAIL — v0 has no pairing flow that auto-populates these.
- **Reachability envelope (v0):** the mailbox pierces NAT/offline only for reveal-completion + letters. Discovery (seek→echo) is push-only, so both endpoints must be reachable during discovery, and W must be reachable at all times. B is NOT full NAT'd-stranger connectivity.
- **TTL:** items expire after 7 days (hourly sweep). A long-offline peer may lose letters — acceptable (best-effort async).
- **Rate-limit / caps:** 16 KB envelope cap, per-IP + per-mailbox token bucket, per-mailbox depth cap 256 (oldest dropped). **Note (M2):** "drop oldest" means a flooder who leaks a mailbox address evicts UN-POLLED legitimate letters first — §10-accepted in v0. Tune in `server.ts` if a legitimate peer is throttled.
- **Anti-replay (M2):** fetch/ack sigs carry a ±5-min freshness window, no per-request jti, and don't bind `since` — harmless under TLS + content-blindness (a replay only re-reads the caller's own mailbox), a known v0 limitation.
- **v1 (NOT in v0):** multi-relay redundancy, per-connection rotating addresses, PoW anti-flood, sealed-sender metadata hardening. Single relay = single point of failure for the mailbox path (push/ws peers unaffected).
- **Metadata:** the relay operator can see "which address polls / who drops to whom" (content-blind, not metadata-blind). v0 accepts a self-hosted/trusted operator (parent spec §11).
