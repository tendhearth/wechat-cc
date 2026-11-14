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
if not scenarios or any(s not in ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] for s in scenarios):
    raise SystemExit('first-run-number S1..S6 required')
for offset, scenario in enumerate(scenarios):
    state = area / ('run-' + str(first + offset))
    env = dict(os.environ, WECHAT_STATE_DIR=str(state))
    driver = ['bun', str(root / 'scripts/acceptance/relay.ts')]
    supervisor = ['python3', str(root / 'scripts/acceptance/run.py')]
    subprocess.run(driver + ['prepare'], env=env, cwd=root, check=True)
    with (state / 'supervisor-proof.jsonl').open('w') as proof:
        process = subprocess.Popen(supervisor + ['start'], env=env, cwd=root, stdout=proof, stderr=proof)
        try:
            deadline = time.monotonic() + 1250
            while not (state / 'ready.json').exists():
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('temporary daemon did not become ready')
                time.sleep(.2)
            subprocess.run(driver + ['setup'], env=env, cwd=root, check=True)
            extra = ['claude', 'relay-unregistered'] if scenario == 'S4' else []
            try:
                result = subprocess.run(driver + [scenario] + extra, env=env, cwd=root, timeout=1500)
                exit_code = result.returncode
            except subprocess.TimeoutExpired:
                exit_code = 124
            (state / 'driver-exit.json').write_text(json.dumps({'scenario': scenario, 'exitCode': exit_code}))
            subprocess.run(driver + ['inspect'], env=env, cwd=root, check=True)
            subprocess.run(supervisor + ['ps'], env=env, cwd=root, check=True, stdout=proof)
        finally:
            stopped = subprocess.run(supervisor + ['stop'], env=env, cwd=root, stdout=proof, stderr=proof)
            process.wait(timeout=35)
            if stopped.returncode:
                raise RuntimeError('temporary daemon shutdown audit failed')
    audit = json.loads((state / 'stop-audit.json').read_text())
    if audit['remainingCount'] or audit['remainingGroupMembers'] or audit['unverifiedRootCount']:
        raise RuntimeError('owned subprocess remained')
    print(json.dumps({'scenario': scenario, 'state': state.name, 'cleanupRemaining': 0}), flush=True)
