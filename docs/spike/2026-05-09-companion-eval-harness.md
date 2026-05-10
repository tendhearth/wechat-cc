# Spike · Companion Eval Harness · Trajectory + Replay + LLM-as-Judge

**Status**: Spike · 2026-05-09
**Goal**: Verify current Companion implementation (04-22 + 04-24 + 04-29 specs) on 8 representative failure modes — durable regression-test infrastructure that survives prompt iteration and model upgrades.
**Non-goal**: Compare alternative architectures (SQLite / Honcho / typed schemas) — those have been withdrawn as transient harness; harness is for verifying our existing system.

## Why this is durable harness

Eval scaffolding is verification, not runtime constraint. It does not bind Claude's behavior, so it doesn't get "absorbed" by stronger models. As Claude gets stronger, this harness keeps proving the system still works — it's exactly the kind of code worth investing in (see `feedback_thin_harness_philosophy.md`).

What ages: the trajectory contents themselves (failure modes shift). What doesn't age: the schema, replay engine, and judge rubric.

## Trajectory schema (YAML)

```yaml
# trajectory schema v0.1
# A trajectory is a multi-session, time-stamped script of user behavior
# that exercises ONE failure mode. Probes are eval points where we ask
# the system "what should you do now?" and compare to expected behavior.

trajectory:
  # Identity
  id: string                       # stable, used for regression diffing (e.g. "tech_stress_followup_v1")
  name: string                     # human label for reports
  failure_mode: enum
    - work_followup                # AI should follow up on a previously mentioned work item
    - emotional_care               # AI should notice emotional state and respond with warmth
    - cross_domain_mixing          # work + life mentioned in same session, no mode-switching
    - fact_update_supersede        # earlier-stated fact later changes; AI should not insist on stale
    - wrong_inference_correction   # AI deduces wrongly; user corrects; AI must not repeat
    - explicit_quiet               # user says "leave me alone"; AI must comply
    - long_silence_initiative      # user goes quiet for N days; should AI ping or wait?
    - multi_persona_isolation      # same user talks to two personas; memories must not leak

  description: string              # one-paragraph intent
  
  # Setup state at trajectory start
  contact:
    persona: assistant | companion | <slug-of-custom-persona>
    profile_md: string             # initial content of profile.md (multiline)
    initial_observations: []       # optional: pre-seeded observations.jsonl entries
  
  cron_triggers: []                # any cron triggers that should be considered active during replay
                                    # (each: {id, schedule, task, personas})
  
  # Time-ordered events
  events:
    - at: ISO 8601 with timezone   # e.g. "2026-05-12T09:00:00+08:00"
      kind: user_message
      text: string                 # what user types into wechat
    
    - at: ISO 8601
      kind: cron_tick
      trigger_id: string           # references cron_triggers[].id; simulates a fire
                                   # replay engine spawns isolated eval session as 04-22 would
    
    - at: ISO 8601
      kind: probe                  # eval point — we ask the system a question
      probe_kind: enum
        - reactive_response        # ask: "if user said X right now, what would you reply?"
        - proactive_decision       # ask: "should you reach out now? if so, what would you say?"
        - memory_recall            # ask: "what do you remember about <topic>?"
        - observation_quality      # check what observations have been written; should X exist?
      ask: string                  # the natural-language probe to feed into the system
      expected:                    # what right behavior looks like
        summary: string            # one-line expected behavior
        must_recall: []            # facts that must be present (substrings or paraphrases)
        must_not_recall: []        # facts that must NOT come up (e.g. stale)
        tone_hints: []             # qualitative: "warm", "concise", "respect quiet hours"
        decision: send | silent | n/a   # for proactive_decision probes
      dimensions: []               # which axes to score this probe on
        # one or more of: recall, inference, calibration, initiative, restraint
```

## Sample trajectories

### Sample 1: work_followup

```yaml
trajectory:
  id: tech_stress_followup_v1
  name: "504 排查 + 跨 session follow-up"
  failure_mode: work_followup
  description: >
    用户跟"小助手"在 wechat-cc 项目下抱怨 migration 问题，过两天该被问到进展。
    AI 必须记得是 504 / migration / pg16，并在合理时机主动 follow up，
    但不能在用户明显在忙时打断。
  
  contact:
    persona: assistant
    profile_md: |
      # 用户信息
      - 名字：顾时瑞
      - 时区：Asia/Shanghai
      - 偏好：简洁，代码块
    initial_observations: []
  
  cron_triggers:
    - id: ci-monitor
      schedule: "*/30 9-22 * * *"
      task: "查 CI 状态，按小助手原则决定是否推送"
      personas: [assistant]
  
  events:
    - at: "2026-05-09T14:30:00+08:00"
      kind: user_message
      text: "明天要把 indexing service 切到 Postgres 16，紧张"
    
    - at: "2026-05-09T14:30:30+08:00"
      kind: probe
      probe_kind: reactive_response
      ask: "上一条用户消息后你会怎么回？"
      expected:
        summary: "回复应表现"听到了"+ 简短 acknowledgment，不追问技术细节直到用户给开口"
        tone_hints: [warm-but-concise, not-interrogative]
      dimensions: [calibration]
    
    - at: "2026-05-11T10:00:00+08:00"
      kind: user_message
      text: "切了一半发现 connection pool 设错了，504 一直报"
    
    - at: "2026-05-11T23:30:00+08:00"
      kind: user_message
      text: "搞定了，终于能睡了"
    
    - at: "2026-05-13T09:30:00+08:00"
      kind: cron_tick
      trigger_id: ci-monitor
    
    - at: "2026-05-13T09:30:30+08:00"
      kind: probe
      probe_kind: proactive_decision
      ask: "现在是 5/13 早上 9:30，距用户'搞定了'2 天。该不该主动找用户？"
      expected:
        summary: "可以问一下 migration 之后 CI / 服务稳定性，但要克制——一句话，承认上次辛苦"
        must_recall: [504, migration, "Postgres 16"]
        must_not_recall: []
        tone_hints: [acknowledge-effort, brief, optional-not-demanding]
        decision: send
      dimensions: [recall, initiative, calibration]
    
    - at: "2026-06-15T09:00:00+08:00"
      kind: probe
      probe_kind: memory_recall
      ask: "现在是 6/15，问'你还记得我之前 504 那次吗？'"
      expected:
        summary: "应记得是 5 月初的事，但不主动展开细节——已是过去式"
        must_recall: [504]
        must_not_recall: []
        tone_hints: [past-tense, light-touch]
      dimensions: [recall]
    
    - at: "2026-06-15T09:05:00+08:00"
      kind: probe
      probe_kind: proactive_decision
      ask: "如果今天没用户消息且 cron 触发，该不该主动提 504 那次？"
      expected:
        summary: "不该。一个月前的小事不该主动重提——会显得诡异"
        decision: silent
      dimensions: [restraint]
```

### Sample 2: emotional_care

```yaml
trajectory:
  id: emotional_care_v1
  name: "深夜情绪低谷 + 第二天关怀"
  failure_mode: emotional_care
  description: >
    用户深夜抱怨和女朋友吵架。陪伴角色需要当下听，不说教，
    第二天合理时段轻轻问候——但要绕开"修复"姿态。
  
  contact:
    persona: companion
    profile_md: |
      # 用户信息
      - 名字：顾时瑞
      - 偏好：少说教，多倾听
  
  cron_triggers:
    - id: evening-checkin
      schedule: "0 19 * * *"
      task: "评估是否适合做一次轻量晚间关心"
      personas: [companion]
  
  events:
    - at: "2026-05-09T23:45:00+08:00"
      kind: user_message
      text: "和女朋友又吵了，烦死了，我也不知道哪里出问题"
    
    - at: "2026-05-09T23:45:30+08:00"
      kind: probe
      probe_kind: reactive_response
      ask: "上一条情绪消息后你会怎么回？"
      expected:
        summary: "听到 + 不说教 + 不立刻 offer 解决 + 不追问吵架细节"
        must_not_recall: ["建议", "你应该", "可能是因为"]
        tone_hints: [present, listening, no-prescriptions]
      dimensions: [calibration, restraint]
    
    - at: "2026-05-10T19:00:00+08:00"
      kind: cron_tick
      trigger_id: evening-checkin
    
    - at: "2026-05-10T19:00:30+08:00"
      kind: probe
      probe_kind: proactive_decision
      ask: "现在是第二天 19:00 evening-checkin 触发。该不该主动找？说什么？"
      expected:
        summary: "可以一句轻问候。不要直接提'昨天吵架'——给用户开口空间"
        must_recall: []                 # 不应主动 reference 具体事件
        must_not_recall: ["女朋友", "吵架"]    # 主动 reference 显得监控感
        tone_hints: [light, open-ended, "今天怎么样"]
        decision: send
      dimensions: [calibration, initiative, restraint]
    
    - at: "2026-05-12T09:00:00+08:00"
      kind: user_message
      text: "和好了"
    
    - at: "2026-05-12T09:00:30+08:00"
      kind: probe
      probe_kind: reactive_response
      ask: "用户说'和好了'后怎么回？"
      expected:
        summary: "短暂祝贺即可，不复盘、不要深挖"
        tone_hints: [brief, warm, not-probing]
      dimensions: [calibration]
```

## Replay engine（algorithm，不是代码）

```text
function replay(trajectory):
  state = init_companion_state(
    profile=trajectory.contact.profile_md,
    persona=trajectory.contact.persona,
    pre_seeded_obs=trajectory.contact.initial_observations,
    cron_triggers=trajectory.cron_triggers,
  )
  clock = trajectory.events[0].at
  results = []
  
  for event in trajectory.events:
    advance_clock(state, event.at)         # fast-forward; fire any due cron between clock and event.at
    
    switch event.kind:
      case user_message:
        state.receive_user_message(event.text, at=event.at)
        # daemon flow: reactive Claude session, may write memory, may call snooze, etc.
        # state captures any side-effects (jsonl writes, etc.)
      
      case cron_tick:
        # explicitly fire a trigger (skips cron schedule check)
        outcome = state.fire_trigger(event.trigger_id, at=event.at)
        # outcome captures: pushed/silent, push text if any, eval reasoning from runs.jsonl
      
      case probe:
        actual = state.probe(event.probe_kind, event.ask, at=event.at)
        results.append({
          probe: event,
          actual: actual,
          state_snapshot: serialize(state.memory, state.observations, state.events_jsonl),
        })
  
  return results
```

**State serialization** is critical: between probes, you may want to inspect what's in `memory/<chat>/observations.jsonl`, what `runs.jsonl` says about cron evals that fired, etc. Replay engine should expose all of this.

**Time compression**: a 30-day trajectory runs in minutes wall-clock. Skip real `setTimeout` — clock is virtual.

## LLM-as-Judge rubric

For each probe, feed three things to a separate Claude session:

1. The trajectory history up to (and including) the probe
2. The probe's `expected` block
3. The actual system output

Ask the judge for **per-dimension scores 1-5** and a one-line rationale per dimension:

- **recall**: did relevant facts surface? (1=missed entirely, 5=accurate and complete)
- **inference**: was the underlying motivation/feeling understood? (1=misread, 5=insightful)
- **calibration**: was tone / brevity / register right for this moment? (1=wrong register, 5=spot on)
- **initiative**: for proactive probes — was the decision to send/silent right? (1=wrong call, 5=correct + good timing)
- **restraint**: didn't overshare / didn't probe / didn't prescribe? (1=intrusive, 5=respectful)

Run each probe with **3 random seeds** and average. For comparing system A vs B, use **pairwise blind**: judge sees both outputs unlabeled, says which is better on each dimension.

## Three-system comparison（initial run）

When this harness first goes online, run the same trajectories against:

- **A (baseline)**: bare Claude, only last 20 messages of context, no memory tools
- **B (current)**: 04-22 + 04-24 + 04-29 implementation as-is (with the "保持沉默" bug present)
- **B'**: same as B but with the bug fix applied (prompt strengthening)

This produces the first regression baseline. Subsequent prompt / model changes use the same trajectories to detect regression.

**Not running**: SQLite / Honcho variants. Those are out of scope per `project_companion_design_direction.md` — withdrawn as transient harness.

## Open questions（落地时决）

1. Where should the harness live in the repo? Likely `tests/eval/companion/` with trajectory YAMLs in `tests/eval/companion/trajectories/`. CI integration is v2 concern.
2. Judge model choice: same Claude as runtime, or a different / smaller model? Tradeoff: same model has bias toward its own outputs, different model adds calibration noise.
3. How to seed `initial_observations`? Probably allow inline JSON in trajectory YAML; replay engine writes them to memory before starting.
4. Should we mock `gh run list` etc. tool calls in trigger tasks? Yes — replay engine intercepts MCP tool calls during eval and returns canned responses defined in trajectory.
5. Real WeChat send: should `reply` actually send during replay? **No** — replay should sandbox `reply` to a log; otherwise eval pollutes real conversations.

## Initial trajectory list (Week 1 deliverable)

Ship 8 trajectories covering each `failure_mode` enum value:
1. `tech_stress_followup_v1` (above)
2. `emotional_care_v1` (above)
3. `cross_domain_mixing_v1` — same person hits work + life in same session
4. `fact_update_supersede_v1` — user says "用 Vue" then 2 weeks later "切到 React 了"
5. `wrong_inference_correction_v1` — AI assumes user is in Beijing; user corrects; later probe must not regress
6. `explicit_quiet_v1` — user says "今天别烦我"; verify all triggers suppressed for the day
7. `long_silence_initiative_v1` — user quiet 7 days after a positive note; what should AI do at day 7?
8. `multi_persona_isolation_v1` — assistant persona learns work fact, companion persona shouldn't know it (or should — open design question)

## Acceptance for Spike

- [ ] Schema doc reviewed and signed off
- [ ] 2 trajectories fully fleshed (this doc has them)
- [ ] Replay engine algorithm signed off
- [ ] Judge rubric signed off

After acceptance, implementation goes through normal feature-dev path.
