"""Additive CC attention renders using the preserved production renderer's definitions.

The old renderer is also provenance for shipped performances: keep its bytes intact.
Load its definition/scene section only, never its asset-writing batch entry point.
Render pairs in a temporary kit, validate them, then install only new attention paths.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile

SCRIPT = Path(__file__).resolve()
DESKTOP = SCRIPT.parents[1]
KIT = DESKTOP / 'src/assets/pet/cc-v1'
ART = DESKTOP / 'art/cc-v1'
BASE = SCRIPT.with_name('render-cc.py')
sha = lambda data: hashlib.sha256(data).hexdigest()
parser = argparse.ArgumentParser()
parser.add_argument('--plan', type=Path, default=ART / 'attention/recipes.json')
parser.add_argument('--samples', type=int, default=96)
parser.add_argument('--threads', type=int, default=2)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
plan = json.loads(args.plan.read_text())
assert plan['schemaVersion'] == 4 and plan['forms'] == ['lit', 'unlit'] and plan['artStatus'] == 'production-candidate'
assert {c['id'] for c in plan['clips']} == {'left', 'right', 'input-up', 'read-down', 'speaking'}
freeze = json.loads((ART / 'design-freeze.json').read_text())
for path, digest in freeze['sha256'].items():
    assert sha((DESKTOP.parents[1] / path).read_bytes()) == digest, path

source = BASE.read_text()
marker = '\nif motion_plan:\n    # Each completed pair has its own digest checkpoint.'
assert source.count(marker) == 1, 'Production definition boundary changed; review the adapter'
definitions = source.split(marker)[0]
env = {'__file__': str(BASE), '__name__': 'cc_attention_production_definitions'}
original_argv = sys.argv
try:
    sys.argv = [str(BASE), '--', '--expressions-only', '--samples', str(args.samples), '--threads', str(args.threads)]
    exec(compile(definitions, str(BASE), 'exec'), env)
finally:
    sys.argv = original_argv
env['performance_mode'] = True
env['motion_plan'] = plan
identity = {
    'sourceSha256': sha((ART / 'cc-v1.blend').read_bytes()),
    'rendererSha256': sha(SCRIPT.read_bytes()), 'baseRendererSha256': sha(BASE.read_bytes()),
    'planSha256': sha(args.plan.read_bytes()),
    'geometrySha256': sha(SCRIPT.with_name('cc_motion_geometry.py').read_bytes()),
    'performanceGeometrySha256': sha(SCRIPT.with_name('cc_performance_geometry.py').read_bytes()),
    'blender': env['bpy'].app.version_string, 'samples': args.samples, 'seed': 11,
}
progress = {'identity': identity, 'samples': {}}
for clip in plan['clips']:
    assert clip['fps'] == 6 and clip['loop'] is False
    assert len(clip['frames']) == (4 if clip['id'] == 'speaking' else 1)
    for i, sample in enumerate(clip['frames']):
        assert set(sample) == {'pose','eyeScale','crescent','gaze','gazeUp','crestTilt','body','feet'}
        assert sample['pose'] == {} and sample['crescent'] == sample['crestTilt'] == 0
        assert .9 <= sample['eyeScale'] <= 1 and abs(sample['gaze']) <= .07 and -.04 <= sample['gazeUp'] <= .12
        assert set(sample['body']) == {'lean','squash','rise','shift'}
        assert abs(sample['body']['lean']) <= .012 and .995 <= sample['body']['squash'] <= 1.006
        assert sample['body']['rise'] == sample['body']['shift'] == 0
        assert sample['feet'] == {side: {'lift':0,'stride':0,'roll':0} for side in ['left','right']}
        key = f"{clip['id']}/{i:03}"
        paths = [f"attention/{form}/{key}.png" for form in ['lit','unlit']] + [f"masks/attention/{key}.png"]
        rest = sample['body'] == {'lean':0,'squash':1,'rise':0,'shift':0} and sample['gaze'] == sample['gazeUp'] == 0 and sample['eyeScale'] == 1
        with tempfile.TemporaryDirectory(prefix='cc-attention-') as temp:
            env['KIT'] = Path(temp)
            if rest:
                data = [(KIT / f'canonical/{form}/front.png').read_bytes() for form in ['lit','unlit']] + [(KIT / 'masks/front.png').read_bytes()]
            else:
                env['render_pair'](f'{i:03}', sample['pose'], sample['eyeScale'], mask_name=f'attention/{key}', motion_clip=clip['id'], gaze=sample['gaze'], performance=sample)
                data = [(Path(temp) / f"performance/{form}/{key}.png").read_bytes() for form in ['lit','unlit']] + [(Path(temp) / paths[2]).read_bytes()]
            for path, content in zip(paths, data):
                destination = KIT / path
                if destination.exists():
                    assert destination.read_bytes() == content, 'Refusing to replace existing frame: ' + path
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(content)
        progress['samples'][key] = {'parameters': sample, 'paths': paths, 'files': {p: sha(b) for p,b in zip(paths,data)}}
        print('CC_ATTENTION_PAIR', key, flush=True)
for path, digest in freeze['sha256'].items():
    assert sha((DESKTOP.parents[1] / path).read_bytes()) == digest, path
target = ART / 'attention/render-progress.json'
target.write_text(json.dumps(progress, indent=2) + '\n')
print('CC_ATTENTION_FINISHED; frozen and existing files unchanged', flush=True)
