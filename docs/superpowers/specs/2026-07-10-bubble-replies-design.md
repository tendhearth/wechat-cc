# Design: 行为流式气泡回复 (bubble replies)

Date: 2026-07-10
Status: approved design → implementation (single-task)
Origin: dogfood feedback — splitting works but replies should ARRIVE faster, and regex splitting is not 真人 enough.

## 1. Why not true streaming

Replies are sent via the `reply` MCP tool; tool-call arguments only reach us
fully generated (SDK mechanics) — the transport cannot flush partial text.
First-bubble latency = full-generation time today.

## 2. What (behavioral streaming)

A prompt section teaches the agent to reply like a person typing: **send the
first complete thought as a `reply` call immediately, keep thinking/working,
send the next bubble as another call** — instead of one big reply at the end.

- Faster: bubble 1 goes out when the first thought is done, not after the
  whole answer.
- 真人: bubble boundaries are SEMANTIC (the model knows where a thought ends;
  code naturally stays whole in one bubble); inter-bubble gaps are real
  generation time, not artificial sleeps.
- Guidance: 每条一个完整意思; 2-4 条封顶; 代码完整放一条(别切代码);
  短回答就一条,别为拆而拆; 先说结论/直接回应,再补充。

## 3. Interplay & gating

- Route-level `splitReply` stays UNCHANGED as the fallback (agent sends one
  big text anyway ⇒ mechanical split still saves it). No threshold changes
  (v1; dogfood may adjust).
- Gated by the SAME per-chat `split` pref (`/set split off` ⇒ neither route
  splitting nor bubble guidance — the user-facing meaning of 拆分 covers
  both). New thunk `bubbleRepliesFor?: (chatId) => boolean` on BootstrapDeps;
  main.ts wires `chatPrefs.get(c).split !== false`. Absent ⇒ section off
  (tests/embedded byte-identical).
- Multiple `reply` calls per turn already work (boolean `replyToolCalled`,
  per-call route sends); chatroom denies reply tools regardless — unaffected.

## 4. Non-goals

Transport-level token streaming (claude SDK partial-messages + flush — future
option); threshold tuning; per-chat bubble-count config.

## 5. Testing

Section content (先发第一条/2-4条/代码完整/别为拆而拆); gating byte-identical
off; bootstrap threading + guest/trusted irrelevant (reply is guest-allowed —
NO tier gate needed, unlike care); full + e2e green (e2e fakes call reply
once with short text — unaffected).
