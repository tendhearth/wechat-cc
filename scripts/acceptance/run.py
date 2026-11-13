#!/usr/bin/env python3
"""Foreground, gateway-only acceptance supervisor. Never defaults to user state.

WECHAT_STATE_DIR must be an explicit directory below /private/tmp/.../acc/state/.
Commands: start, resume, stop, ps, gate. Keep start/resume in a foreground session.
"""
import json
import os
from pathlib import Path
import re
import signal
import shutil
import shlex
import pwd
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[2]


def state_dir():
    value = os.environ.get('WECHAT_STATE_DIR', '')
    path = Path(value).resolve()
    if not value or not str(path).startswith('/private/tmp/') or '/acc/state/' not in str(path):
        raise SystemExit('refused: explicit temporary WECHAT_STATE_DIR below /private/tmp/.../acc/state/ required')
    return path


def processes():
    result = subprocess.run(['ps', '-axo', 'pid=,ppid=,comm='], capture_output=True, text=True, errors='replace', check=True)
    return [line.strip().split(None, 2) for line in result.stdout.splitlines() if line.strip()]


def gate(wait=False):
    deadline = time.monotonic() + (1800 if wait else 0)
    while True:
        load = os.getloadavg()[0]
        game = any('civilizationvii' in row[2].lower() for row in processes())
        allowed = load < 8 and not game
        print(json.dumps({'event': 'load_gate', 'load1': load, 'civilizationPresent': game, 'allowed': allowed}), flush=True)
        if allowed:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(min(30, max(0, deadline - time.monotonic())))


def descendants(pid):
    found = {pid}
    rows = processes()
    while True:
        more = {int(p) for p, parent, _ in rows if int(parent) in found}
        if more <= found:
            return found
        found |= more


def fingerprints():
    output = subprocess.run(['ps', '-axo', 'pid=,lstart='], capture_output=True, text=True, errors='replace', check=True).stdout
    return {int(parts[0]): parts[1] for line in output.splitlines() if len(parts := line.strip().split(None, 1)) == 2}


def process_snapshot():
    output = subprocess.run(['ps', '-axo', 'pid=,ppid=,pgid=,lstart=,comm='], capture_output=True, text=True, errors='replace', check=True).stdout
    result = {}
    for line in output.splitlines():
        parts = line.split(None, 8)
        if len(parts) == 9:
            result[int(parts[0])] = {'parent': int(parts[1]), 'group': int(parts[2]), 'start': ' '.join(parts[3:8]), 'command': parts[8]}
    return result


def group_members(groups):
    output = subprocess.run(['ps', '-axo', 'pid=,pgid='], capture_output=True, text=True, errors='replace', check=True).stdout
    return {int(pid) for line in output.splitlines() if len(parts := line.split()) == 2 for pid, group in [parts] if int(group) in groups}


def observe_owned(roots, tracked, groups):
    # Birth identity, ancestry and process group come from the same snapshot.
    rows = process_snapshot()
    stamps = {pid: row['start'] for pid, row in rows.items()}
    proven_groups = {rows[pid]['group'] for pid, stamp in list(tracked.items()) if stamps.get(pid) == stamp}
    candidates = {pid for pid, row in rows.items() if row['group'] in groups & proven_groups}
    candidates |= {root for root in roots if root in tracked and stamps.get(root) == tracked[root]}
    while True:
        more = {pid for pid, row in rows.items() if row['parent'] in candidates}
        if more <= candidates:
            break
        candidates |= more
    for pid in candidates:
        if pid in stamps and (pid not in tracked or tracked[pid] == stamps[pid]):
            tracked.setdefault(pid, stamps[pid])
            groups.add(rows[pid]['group'])
    return stamps


def ps_check(state):
    # Compare secrets entirely in memory. Neither argv nor environment is emitted.
    pids_file = state / 'pids.json'
    pids = json.loads(pids_file.read_text()) if pids_file.exists() else {}
    roots, tracked, groups = [], {}, set()
    snapshot = process_snapshot()
    for role in ('daemon', 'gateway'):
        pid = pids.get(role)
        row = snapshot.get(pid)
        if not row or row['parent'] != pids.get('supervisor'):
            continue
        command_line = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True, errors='replace').stdout
        if str(ROOT / 'scripts' / 'acceptance' / (role + '.ts')) not in command_line or pids.get('starts', {}).get(role) not in (None, row['start']):
            continue
        roots.append(pid);tracked[pid] = row['start'];groups.add(row['group'])
    observe_owned(roots, tracked, groups)
    owned = set(tracked)
    tokens = []
    for name in ('internal-token', 'internal-operator-token'):
        file = state / name
        if file.exists():
            tokens.append(file.read_text().strip())
    sessions = json.loads((state / 'session-bearers.json').read_text()) if (state / 'session-bearers.json').exists() else []
    models = [int(pid) for pid, _, comm in processes() if int(pid) in owned and ('/claude/versions/' in comm or comm.endswith('/bin/codex') or comm.endswith('/bin/claude'))]
    # Session bearer is observed only in the daemon; see /ps harness endpoint.
    values = {}
    for mode in ('args', 'environment'):
        args = ['ps', '-axww', '-o', 'command='] if mode == 'args' else ['ps', 'eww', '-p', ','.join(map(str, owned)), '-o', 'command=']
        output = subprocess.run(args, capture_output=True, text=True, errors='replace').stdout if owned else ''
        values[mode + 'ContainsSharedToken'] = any(t and t in output for t in tokens)
    live = {int(p) for p, _, _ in processes()}
    argv = subprocess.run(['ps', '-axww', '-o', 'command='], capture_output=True, text=True, errors='replace').stdout
    model_env = subprocess.run(['ps', 'eww', '-p', ','.join(map(str, models)), '-o', 'command='], capture_output=True, text=True, errors='replace').stdout if models else ''
    print(json.dumps({'event': 'ps_check', 'ownedAliveCount': len(owned & live), 'sharedTokensObserved': len(tokens), 'sessionTokensObserved': len(sessions), 'modelProcessCount': len(models), 'argvContainsSessionToken': any(t in argv for t in sessions), 'modelEnvironmentContainsSessionToken': any(t in model_env for t in sessions), **values}))


def start(state, resume=False):
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    if (state / 'pids.json').exists():
        cleanup_file = state / 'cleanup.json'
        old = json.loads((state / 'pids.json').read_text())
        live = {int(p) for p, _, _ in processes()}
        cleanup_result = json.loads(cleanup_file.read_text()) if cleanup_file.exists() else {}
        if not resume or not (state / '.acceptance-only').exists() or cleanup_result.get('remainingCount') != 0 or cleanup_result.get('remainingGroupMembers', 0) != 0 or group_members({old['daemon'], old['gateway']}) or any(old[k] in live for k in ('supervisor', 'daemon', 'gateway')):
            raise SystemExit('refused: existing run requires explicit resume, clean shutdown, and no old PID alive')
    elif resume:
        raise SystemExit('refused: resume requires an existing acceptance run')
    (state / '.acceptance-only').write_text('synthetic acceptance state; never production\n')
    home = state / 'home'
    claude = home / '.claude'
    codex = home / '.codex'
    for directory in (claude, codex, state / 'tmp', state / 'workspace', state / 'bin'):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    auth = [claude / '.credentials.json', codex / 'auth.json', claude / 'auth.json']
    cli_config = home / '.claude.json'
    config_oauth = cli_config.exists() and any(k in json.loads(cli_config.read_text()) for k in ('oauthAccount', 'oauthToken', 'claudeAiOauth'))
    print(json.dumps({'event': 'credential_proof', 'claudeLoginFilesPresent': auth[0].exists() or auth[2].exists() or config_oauth, 'codexLoginFilesPresent': auth[1].exists(), 'isolatedHome': True}), flush=True)
    if any(p.exists() for p in auth) or config_oauth:
        raise SystemExit('refused: temporary login file present')
    # The installed executable lives under ~/.codex/packages; copy only the
    # executable so the sandbox can deny the entire original configuration tree.
    codex_bin = shutil.which('codex')
    if not codex_bin:
        raise SystemExit('refused: real codex executable unavailable')
    shutil.copy2(Path(codex_bin).resolve(), state / 'bin' / 'codex')
    claude_bin = shutil.which('claude')
    if not claude_bin:
        raise SystemExit('refused: real claude executable unavailable')
    wrapper = state / 'bin' / 'claude'
    wrapper.write_text('#!/bin/sh\nif [ "$1" != "--version" ] && [ -f ' + shlex.quote(str(state / 'fail-claude-start')) + ' ]; then exit 73; fi\nexec ' + shlex.quote(str(Path(claude_bin).resolve())) + ' "$@"\n')
    wrapper.chmod(0o700)
    original_home = pwd.getpwuid(os.getuid()).pw_dir
    policy = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))'
    for forbidden in (original_home + '/.claude', original_home + '/.codex', original_home + '/Library/Keychains', '/Library/Keychains', '/Applications/Tendhearth CC.app'):
        policy += '(deny file-read* file-write* (subpath ' + json.dumps(forbidden) + '))'
    policy += '(deny mach-lookup (global-name "com.apple.securityd"))'
    # Restrict writes even if a model attempts an unintended tool action.
    policy += '(deny file-write*)(allow file-write* (subpath ' + json.dumps(str(state)) + ')(literal "/dev/null")(literal "/dev/tty"))'
    policy_file = state / 'sandbox.sb'
    policy_file.write_text(policy)
    checked = subprocess.run(['/usr/bin/sandbox-exec', '-f', str(policy_file), '/usr/bin/true'], capture_output=True)
    if checked.returncode:
        raise SystemExit('refused: sandbox policy unavailable')
    # Load/game gate and process spawn occur in this same command.
    if not gate(wait=True):
        raise SystemExit('load gate timed out after 30 minutes; no daemon started')
    base = {'PATH': str(state / 'bin') + ':' + os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(home), 'TMPDIR': str(state / 'tmp'), 'LANG': 'en_US.UTF-8', 'WECHAT_STATE_DIR': str(state), 'WECHAT_CC_STATE_DIR': str(state), 'ACCEPTANCE_SYNTHETIC': '1'}
    if resume:
        from urllib.parse import urlparse
        base['ACCEPTANCE_GATEWAY_PORT'] = str(urlparse(json.loads((state / 'gateway.json').read_text())['baseUrl']).port)
        (state / 'ready.json').unlink(missing_ok=True)
        (state / 'gateway.json').unlink(missing_ok=True)
    children = []
    tracked_ever = {}
    root_starts = {}
    owned_groups = set()
    def remember_child(child):
        children.append(child)
        row = process_snapshot().get(child.pid)
        if row:
            root_starts[child.pid] = row['start']
            tracked_ever[child.pid] = row['start']
            owned_groups.add(row['group'])
    tracking_done = threading.Event()
    def track():
        while not tracking_done.wait(1):
            observe_owned([p.pid for p in children], tracked_ever, owned_groups)
    threading.Thread(target=track, daemon=True).start()
    def cleanup(*_):
        tracked = dict(tracked_ever)
        groups = set(owned_groups)
        observe_owned([p.pid for p in children], tracked, groups)
        for child in reversed(children):
            try:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and any(p.poll() is None for p in children):
            for pid, stamp in list(tracked_ever.items()):
                tracked.setdefault(pid, stamp)
            observe_owned([p.pid for p in children], tracked, groups)
            time.sleep(.2)
        # Include detached grandchildren captured before shutdown.
        live = observe_owned([p.pid for p in children], tracked, groups)
        for pid, stamp in tracked.items():
            if live.get(pid) != stamp:
                continue
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(.2)
        live = observe_owned([p.pid for p in children], tracked, groups)
        tracking_done.set()
        result = {'event': 'cleanup', 'trackedCount': len(tracked), 'remainingCount': sum(live.get(pid) == stamp for pid, stamp in tracked.items()), 'remainingGroupMembers': len(group_members(groups))}
        (state / 'process-tracking.json').write_text(json.dumps({'fingerprints': tracked, 'groups': sorted(groups)}))
        (state / 'cleanup.json').write_text(json.dumps(result))
        print(json.dumps(result), flush=True)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(130))
    key_path = Path(os.environ.get('ACCEPTANCE_KEY_FILE', str(state.parents[1] / 'gateway.key')))
    if key_path.stat().st_mode & 0o077:
        raise SystemExit('refused: gateway key must have mode 0600')
    key = key_path.read_text().strip()
    if not key:
        raise SystemExit('refused: empty key')
    try:
        gateway = subprocess.Popen(['bun', str(ROOT / 'scripts/acceptance/gateway.ts')], cwd=ROOT, env=base, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        remember_child(gateway)
        for _ in range(100):
            if (state / 'gateway.json').exists():
                break
            if gateway.poll() is not None:
                raise RuntimeError('gateway exited')
            time.sleep(.1)
        proxy = json.loads((state / 'gateway.json').read_text())['baseUrl']
        (codex / 'config.toml').write_text('model_provider = "acceptance_gateway"\nmodel = "Kimi-Code"\nmodel_reasoning_effort = "medium"\n[model_providers.acceptance_gateway]\nname = "Acceptance gateway"\nbase_url = ' + json.dumps(proxy + '/v1') + '\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 3\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n')
        env = {**base, 'CLAUDE_CONFIG_DIR': str(claude), 'CODEX_HOME': str(codex), 'ANTHROPIC_BASE_URL': proxy, 'ANTHROPIC_AUTH_TOKEN': key, 'ANTHROPIC_API_KEY': key, 'OPENAI_API_KEY': key, 'CODEX_API_KEY': key, 'WECHAT_OPENAI_API_KEY': key, 'ANTHROPIC_DEFAULT_HAIKU_MODEL': 'Kimi-Code', 'ANTHROPIC_DEFAULT_SONNET_MODEL': 'Kimi-Code', 'ANTHROPIC_DEFAULT_OPUS_MODEL': 'Kimi-Code', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS': '8192', 'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'ENABLE_TOOL_SEARCH': 'false', 'WECHAT_CC_DAEMON_CHILD': '1', 'WECHAT_TURN_TIMEOUT_MS': '600000'}
        env['WECHAT_CLAUDE_CHEAP_MODEL'] = 'Kimi-Code'
        env['WECHAT_CODEX_CHEAP_MODEL'] = 'Kimi-Code'
        env['CODEX_MODEL'] = 'Kimi-Code'
        env['WECHAT_CC_DISABLE_CODEX_AUTOFIX'] = '1'
        env['WECHAT_DISABLE_LOG_FILE'] = '1'
        daemon = subprocess.Popen(['/usr/bin/sandbox-exec', '-f', str(policy_file), 'bun', str(ROOT / 'scripts/acceptance/daemon.ts')], cwd=state / 'workspace', env=env, start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        remember_child(daemon)
        starts = {'supervisor': process_snapshot()[os.getpid()]['start'], 'daemon': root_starts.get(daemon.pid), 'gateway': root_starts.get(gateway.pid)}
        (state / 'pids.json').write_text(json.dumps({'supervisor': os.getpid(), 'daemon': daemon.pid, 'gateway': gateway.pid, 'starts': starts}))
        with (state / 'daemon.log').open('a') as log:
            for line in daemon.stdout:
                # Never persist any credential from a provider error or debug line.
                safe = line.replace(key, '[REDACTED]')
                safe = re.sub(r'(?i)(bearer\s+)[A-Za-z0-9._-]+', r'\1[REDACTED]', safe)
                safe = re.sub(r'\b[a-f0-9]{64}\b', '[HEX64]', safe)
                log.write(safe)
                log.flush()
        raise SystemExit(daemon.wait())
    finally:
        cleanup()


if __name__ == '__main__':
    state = state_dir()
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    if command in ('start', 'resume'):
        start(state, resume=command == 'resume')
    elif command == 'stop':
        pids = json.loads((state / 'pids.json').read_text())
        # Validate supervisor identity before signalling; never signal a recycled PID.
        line = subprocess.run(['ps', '-p', str(pids['supervisor']), '-o', 'command='], capture_output=True, text=True, errors='replace').stdout
        daemon_parent = subprocess.run(['ps', '-p', str(pids['daemon']), '-o', 'ppid='], capture_output=True, text=True, errors='replace').stdout.strip()
        if 'scripts/acceptance/run.py' not in line or not any(word in line for word in (' start', ' resume')) or daemon_parent != str(pids['supervisor']):
            raise SystemExit('refused: supervisor identity mismatch')
        # This external auditor also covers supervisors started before a script
        # edit. Observe only the recorded roots/groups and PID birth identities.
        roots, tracked, groups = [], {}, set()
        rows = process_snapshot()
        supervisor_row = rows.get(pids['supervisor'])
        supervisor_start = pids.get('starts', {}).get('supervisor')
        if not supervisor_row or supervisor_start and supervisor_start != supervisor_row['start']:
            raise SystemExit('refused: supervisor birth identity mismatch')
        unverified_roots = 0
        for role in ('daemon', 'gateway'):
            pid = pids[role]
            row = rows.get(pid)
            if not row:
                continue
            command_line = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True, errors='replace').stdout
            expected_script = str(ROOT / 'scripts' / 'acceptance' / (role + '.ts'))
            stored_start = pids.get('starts', {}).get(role)
            if row['parent'] != pids['supervisor'] or expected_script not in command_line or stored_start and stored_start != row['start']:
                unverified_roots += 1
                continue
            roots.append(pid)
            tracked[pid] = row['start']
            groups.add(row['group'])
        if pids['daemon'] not in roots:
            raise SystemExit('refused: daemon root identity could not be proven; no signal sent')
        observe_owned(roots, tracked, groups)
        os.kill(pids['supervisor'], signal.SIGTERM)
        deadline = time.monotonic() + 22
        quiet_since = None
        while time.monotonic() < deadline:
            live = observe_owned(roots, tracked, groups)
            remaining = [pid for pid, stamp in tracked.items() if live.get(pid) == stamp]
            if not remaining:
                quiet_since = quiet_since or time.monotonic()
                if time.monotonic() - quiet_since >= 1:
                    break
            else:
                quiet_since = None
                if deadline - time.monotonic() < 5:
                    for pid in remaining:
                        if fingerprints().get(pid) == tracked[pid]:
                            try:
                                os.kill(pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
            time.sleep(.2)
        live = fingerprints()
        result = {'event': 'stop_audit', 'trackedCount': len(tracked), 'remainingCount': sum(live.get(pid) == stamp for pid, stamp in tracked.items()), 'remainingGroupMembers': len(group_members(groups)), 'unverifiedRootCount': unverified_roots}
        (state / 'stop-audit.json').write_text(json.dumps(result))
        print(json.dumps(result))
        raise SystemExit(0 if result['remainingCount'] == 0 and result['remainingGroupMembers'] == 0 and unverified_roots == 0 else 1)
    elif command == 'ps':
        ps_check(state)
    elif command == 'gate':
        raise SystemExit(0 if gate() else 3)
    else:
        raise SystemExit('usage: run.py start|resume|stop|ps|gate')
