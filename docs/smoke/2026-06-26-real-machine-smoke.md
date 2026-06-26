# Real-machine smoke test — 2026-06-26 robustness work

Verifies the fixes that are **only unit-tested**: sleep/wake dedup + heartbeat,
companion at-most-once, context-token durability, `/model` hot-reload, admin
self-heal, poison bound. Run on the actual Mac that sleeps, with a real WeChat
account bound.

**Paths** (default; override with `WECHAT_CC_STATE_DIR`):
- state: `~/.claude/channels/wechat/`
- db: `…/wechat-cc.db` · heartbeat: `…/server.heartbeat` · pid: `…/server.pid`
- logs: `…/channel.log.jsonl` (or `wechat-cc logs` / `wechat-cc log`)

**Tip:** keep a log tail open in another terminal:
`tail -f ~/.claude/channels/wechat/channel.log.jsonl`

---

## 0. Automated pre-checks (no WeChat needed)
```
bash scripts/smoke-checks.sh
```
Expect: db `user_version=17`, `handled_messages` + `message_attempts` tables,
live `server.pid`, and **heartbeat advances while idle** (the decoupled ticker).

---

## 1. Baseline — bot replies
1. From your phone, send the bot a normal message.
2. **Expect:** a reply within a few seconds.
- Verify: a turn appears — `wechat-cc sessions` shows a live session; log shows the inbound + reply.

## 2. Sleep/wake — NO re-reply of old messages  *(the original bug + dedup + heartbeat)*
1. Have a short recent conversation (2–3 answered messages).
2. **Close the lid** (or `pmset sleepnow`). Wait **≥3 min**.
3. Open the lid. **Do not send anything yet.** Watch the log for ~60s.
4. **Expect:** NO replies to the already-answered messages. If the cursor
   regressed, you'll instead see `[DEDUP] skip redelivered message … already
   handled` — that's the guard working (redelivery happened but was swallowed).
5. **Fail signal:** the bot re-answers an old message with a fresh reply.
- Also: only ONE `server.pid` / one daemon process (`pgrep -fl 'daemon/main'`) —
  no second daemon stole the lock. Heartbeat file mtime is recent (just woke).

## 3. Sleep/wake — prompt response after waking  *(reconnect; informational)*
1. Right after waking (step 2), send a NEW message.
2. **Expect:** reply reasonably promptly. A multi-tens-of-seconds lag would
   suggest the stale long-poll didn't reconnect fast — note it (not fixed this
   round, candidate follow-up).

## 4. Companion proactive push — at-most-once across sleep  *(at-most-once fix)*
1. Enable companion (WeChat: `/companion` enable, or it's already on).
2. Get the agent to record a near-future agenda item — tell it e.g. "5 分钟后提醒我喝水"
   (it should write `- [ ] due:<today> …` to agenda.md).
3. **Sleep across that due time** (lid closed past the 5 min).
4. Wake.
5. **Expect:** at most ONE proactive push for that item — never two.
- Verify: agenda.md shows the item flipped to `- [x] done:…` exactly once;
  log shows a single push dispatch for it.

## 5. context-token survives a hard kill  *(write-through fix)*
1. Send a message so a context token is captured for that chat.
2. Hard-kill the daemon: `kill -9 $(cat ~/.claude/channels/wechat/server.pid)`.
3. Confirm it persisted WITHOUT a graceful flush:
   `cat ~/.claude/channels/wechat/context_tokens.json` → your chat id is present.
4. Restart the daemon, send a message.
5. **Expect:** the bot replies (no "no context_token cached" error).
- Fail signal (pre-fix behavior): the chat id missing from the json after kill -9.

## 6. `/model` hot-reload — codex/cursor without restart  *(model seam)*
*(Only meaningful if your daemon's configured provider is codex or cursor; for
claude it already worked.)*
1. Note current model: in WeChat (admin chat) ask the bot to run `model_get`,
   or `wechat-cc provider` / check agent-config.json.
2. Switch it: admin chat → ask to `model_set` to a valid versioned id (e.g. a
   different codex/cursor model), OR edit `agent-config.json` `model`/`cursorModel`.
3. **Without restarting**, send a NEW message (new chat or after the current
   session is idle-evicted).
4. **Expect:** the next session uses the new model — `model_get` read-back shows
   it, and the turn runs on it. No daemon restart needed.

## 7. Admin self-heal loop  *(prompt nudge + diagnostic/remediation tools)*
*(From the admin chat — your own owner chat.)*
1. Say something like: "检查下为什么有的对话不回消息了" / "daemon 还好吗".
2. **Expect:** the agent reaches for `diagnostic_health` / `diagnostic_turns` /
   `diagnostic_sessions` on its own, reports what it found in plain language,
   and — if something's wedged — offers/asks before `session_release` /
   `daemon_restart` (those relay-confirm).
3. Optional: deliberately wedge nothing; just confirm it *can* diagnose unasked.
- Verify: log/turns show the `diagnostic_*` tool calls.
- **Non-admin check:** from a non-admin allow-listed chat, the same ask must NOT
  expose those tools (they aren't registered for non-admin sessions).

## 8. Poison-message bound  *(narrow; optional)*
Hard to trigger naturally (needs a turn that persistently throws + restarts).
If you ever see the SAME message re-answered on every daemon start, grep:
`grep 'giving up on poison message' channel.log.jsonl` — after `maxAttempts`
(5) it should stop and mark handled. Mostly a "watch the log" item.

---

## Result
- [ ] §0 automated checks pass
- [ ] §2 no re-reply after sleep/wake (most important)
- [ ] §4 companion push at-most-once
- [ ] §5 context token survives kill -9
- [ ] §6 codex/cursor model hot-reload (if applicable)
- [ ] §7 admin self-heal fires; non-admin can't

Note anything that failed or felt off (esp. §3 reconnect latency) — those feed
the next round.
