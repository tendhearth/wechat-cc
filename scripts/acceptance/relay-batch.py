#!/usr/bin/env python3
"""Serial runs, with unconditional audited shutdown. No production defaults."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[2]
area = Path(os.environ.get('ACCEPTANCE_STATE_ROOT', ''))
if not str(area).startswith('/private/tmp/') or not str(area).endswith('/acc/state'):
    raise SystemExit('explicit temporary ACCEPTANCE_STATE_ROOT required')
first = int(sys.argv[1])
scenarios = sys.argv[2:]
if not scenarios or any(s not in ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S7-missing', 'probe'] for s in scenarios):
    raise SystemExit('first-run-number S1..S7|S7-missing|probe required')
for offset, scenario in enumerate(scenarios):
    state = area / ('run-' + str(first + offset))
    env = dict(os.environ, WECHAT_STATE_DIR=str(state))
    driver = ['bun', str(root / 'scripts/acceptance/relay.ts')]
    supervisor = ['python3', str(root / 'scripts/acceptance/run.py')]
    prepare_extra = [str(area.parent / 'projects' / state.name), 'same-cwd' if scenario == 'S7' else 'missing-project'] if scenario in ('S7','S7-missing') else []
    subprocess.run(driver + ['prepare'] + prepare_extra, env=env, cwd=root, check=True)
    with (state / 'supervisor-proof.jsonl').open('w') as proof:
        process = subprocess.Popen(supervisor + ['start'], env=env, cwd=root, stdout=proof, stderr=proof)
        try:
            deadline = time.monotonic() + 1250
            while not (state / 'ready.json').exists():
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('temporary daemon did not become ready')
                time.sleep(.2)
            subprocess.run(driver + ['setup'], env=env, cwd=root, check=True)
            # An API opening baton exits without a retained native writer. Keep
            # both real executors while reaching the later acceptance nodes.
            extra = ['openai', 'claude'] if scenario in ('S2', 'S3', 'S4', 'S6') else []
            try:
                result = subprocess.run(driver + ['S7' if scenario == 'S7-missing' else scenario] + extra, env=env, cwd=root, timeout=1500)
                exit_code = result.returncode
            except subprocess.TimeoutExpired:
                exit_code = 124
            (state / 'driver-exit.json').write_text(json.dumps({'scenario': scenario, 'exitCode': exit_code}))
            subprocess.run(driver + ['inspect'], env=env, cwd=root, check=True)
            subprocess.run(supervisor + ['ps'], env=env, cwd=root, check=True, stdout=proof)
        finally:
            if (state / 'pids.json').exists():
                stopped = subprocess.run(supervisor + ['stop'], env=env, cwd=root, stdout=proof, stderr=proof)
                process.wait(timeout=35)
                if stopped.returncode:
                    raise RuntimeError('temporary daemon shutdown audit failed')
            else:
                # Before load gate approval this exact child owns no daemon or
                # gateway. Terminate only our Popen, never an unverified PID.
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=35)
    audit = json.loads((state / 'stop-audit.json').read_text())
    if audit['remainingCount'] or audit['remainingGroupMembers'] or audit['unverifiedRootCount']:
        raise RuntimeError('owned subprocess remained')
    print(json.dumps({'scenario': scenario, 'state': state.name, 'cleanupRemaining': 0}), flush=True)
