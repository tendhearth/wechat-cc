"""Nonruntime view studies. Frozen renderer/model/production assets stay unchanged."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cc_turnaround_study import derive_render_pair, guard_output, orbit, sample_is_complete, validate_bootstrap, views

if sys.platform != 'darwin' or Path.home() != Path('/Users/home'):
    raise RuntimeError('CC study execution requires the dedicated Mac mini')
if subprocess.check_output(['/usr/sbin/scutil', '--get', 'ComputerName'], text=True).strip() != 'Home’s Mac mini':
    raise RuntimeError('CC study execution requires the dedicated Mac mini')

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

desktop = Path(__file__).resolve().parents[1]
root = desktop.parents[1]
source = desktop/'art/cc-v1'
kit = desktop/'src/assets/pet/cc-v1'
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=source/'studies/turnarounds-r2')
parser.add_argument('--samples', type=int, default=96)
parser.add_argument('--threads', type=int, default=2)
parser.add_argument('--views', help='Comma-separated subset of the twenty authored views')
parser.add_argument('--resume', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
if not 1 <= args.samples <= 96 or not 1 <= args.threads <= 2: raise ValueError('Study budget exceeds approved CPU envelope')
recipe = views()
selected = set(args.views.split(',')) if args.views else {v['id'] for v in recipe}
if not selected or not selected <= {v['id'] for v in recipe}: raise ValueError('Unknown study view')
output = args.output.resolve()
if not any(base.resolve() in output.parents for base in [source/'studies', root/'.superpowers']):
    raise ValueError('Study output must remain in the owned studies/probe workspace')

def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def inside(parent, path): return parent == path or parent in path.parents
def snapshot():
    result = {}
    for directory in [source, kit]:
        for path in directory.rglob('*'):
            if path.is_file() and not inside(output, path.resolve()): result[path.resolve()] = sha(path)
    for name in ['render-cc.py', 'cc_motion_geometry.py']:
        path = desktop/'scripts'/name; result[path] = sha(path)
    return result

protected = snapshot()
guard_output(output, protected)
plan_path = source/'motion/recipes.json'
progress_path = source/'motion/render-progress.json'
plan = json.loads(plan_path.read_text())
progress = json.loads(progress_path.read_text())
driver = desktop/'scripts/render-cc.py'
expected_identity = {
    'planSha256': sha(plan_path), 'sourceSha256': sha(source/'cc-v1.blend'),
    'rendererSha256': sha(driver), 'geometrySha256': sha(desktop/'scripts/cc_motion_geometry.py'),
    'blender': bpy.app.version_string, 'samples': progress['identity']['samples'], 'seed': 11,
}
validate_bootstrap(plan, progress, kit, expected_identity)
freeze = json.loads((source/'design-freeze.json').read_text())
for path, digest in freeze['sha256'].items():
    if sha(root/path) != digest: raise ValueError(f'Frozen input changed: {path}')

identity = {**expected_identity, 'studySamples': args.samples, 'threads': args.threads,
            'studyScriptSha256': sha(__file__), 'adapterSha256': sha(Path(__file__).with_name('cc_turnaround_study.py')),
            'recipe': recipe, 'adaptations': ['occluded-eye policy', 'no fixed screen-space contact shadow']}
checkpoint_path = output/'index.json'
if output.exists():
    if not args.resume or not checkpoint_path.is_file(): raise ValueError('Use a fresh study directory or a verified --resume')
    record = json.loads(checkpoint_path.read_text())
    if record.get('identity') != identity: raise ValueError('Study provenance changed; use a fresh output directory')
else:
    output.mkdir(parents=True)
    record = {'schemaVersion': 1, 'artStatus': 'production-candidate', 'usage': 'nonruntime directional study',
              'generatedAt': datetime.now(timezone.utc).isoformat(),
              'canvas': {'width': 512, 'height': 512, 'anchor': [256, 470], 'safeBbox': [80, 28, 432, 470]},
              'identity': identity, 'views': {}, 'complete': False}

original = study = context = None
old_camera_global = None
try:
    # Every old sample and its exact three files were checked before runpy.
    # The original script now skips this cached frame without writing old assets.
    sys.argv = [str(driver), '--', '--motion-plan', str(plan_path), '--clip', 'done', '--motion-frame', '0',
                '--resume-motion', '--samples', str(expected_identity['samples']), '--threads', str(args.threads)]
    namespace = runpy.run_path(str(driver), run_name='__main__')
    context = namespace['render_pair'].__globals__
    scene = context['scene']
    original = scene.camera
    camera_signature = (tuple(v for row in original.matrix_world for v in row), original.data.as_pointer(),
                        original.data.type, original.data.ortho_scale, original.data.shift_x, original.data.shift_y)
    if len(context['eyes']) != 2 or len(context['parts']) != 4: raise ValueError('Frozen CC anatomy changed')
    context['set_pose']('default'); context['set_eyes']('default', 1)
    bpy.context.view_layer.update()
    study = original.copy(); study.data = original.data.copy()
    study.name = 'CC study-only orbit camera'; scene.collection.objects.link(study)
    scene.camera = study
    old_camera_global = context['camera']; context['camera'] = study
    points = [obj.matrix_world @ vertex.co for obj in context['parts']+context['eyes'] for vertex in obj.data.vertices]
    feet = [obj for obj in context['parts'] if obj.name.startswith('Foot')]
    if len(feet) != 2: raise ValueError('Both frozen feet must be present')

    def position(view, scale):
        spec = orbit(view['yaw'], view['pitch'], scale)
        study.location = spec['location']
        study.rotation_euler = (Vector(spec['target'])-study.location).to_track_quat('-Z', 'Y').to_euler()
        study.data.ortho_scale = scale
        bpy.context.view_layer.update()
        low = min(world_to_camera_view(scene, study, obj.matrix_world @ v.co).y for obj in feet for v in obj.data.vertices)
        up = study.rotation_euler.to_matrix() @ Vector((0, 1, 0))
        study.location += up*((low-43.75/512)*scale)
        bpy.context.view_layer.update()
        projected = [world_to_camera_view(scene, study, point) for point in points]
        return [min(p.x for p in projected)*512, (1-max(p.y for p in projected))*512,
                max(p.x for p in projected)*512, (1-min(p.y for p in projected))*512]

    scale = 3.85
    while True:
        bounds = {view['id']: position(view, scale) for view in recipe}
        if any(b[3] > 468.4 for b in bounds.values()):
            raise ValueError('A planned view projects entity below feet; revise recipe, never crop or relax baseline')
        if all(b[0] >= 82 and b[1] >= 30 and b[2] <= 430 for b in bounds.values()): break
        scale = round(scale+.05, 2)
        if scale > 6: raise ValueError('Study framing cannot preserve useful scale inside safe bounds')
    if record.get('commonScale', scale) != scale: raise ValueError('Common framing changed')
    record['commonScale'] = scale
    record['projectedBounds'] = bounds
    scene.cycles.samples = args.samples; scene.cycles.device = 'CPU'
    scene.render.threads_mode = 'FIXED'; scene.render.threads = args.threads
    with tempfile.TemporaryDirectory(prefix='cc-turnaround-raw-') as temporary:
        derived_context = dict(context, KIT=output, SOURCE=Path(temporary))
        render = derive_render_pair(driver.read_text(), derived_context)
        for view in recipe:
            if view['id'] not in selected: continue
            name = view['id']
            paths = [f'motion/{form}/{name}/000.png' for form in ['lit', 'unlit']]+[f'masks/{name}.png']
            if sample_is_complete(output, record['views'].get(name), view, paths):
                print('CC_STUDY_SKIP', name, flush=True); continue
            position(view, scale)
            visible_eyes = min(view['yaw'], 360-view['yaw']) <= 45
            rendered, entity = render('000', mask_name=name, motion_clip=name, visible_eyes_required=visible_eyes)
            pixels = rendered['unlit']
            np = context['np']
            white = int(np.count_nonzero(np.all(pixels[:, :, :3] == 255, axis=2) & (entity == 255)))
            record['views'][name] = {'parameters': view, 'paths': paths, 'files': {p: sha(output/p) for p in paths},
                                     'cameraLocation': list(study.location), 'cameraRotation': list(study.rotation_euler),
                                     'entityBbox': context['bbox'](entity), 'whiteEyePixels': white,
                                     'visibleEyesRequired': visible_eyes}
            record['complete'] = set(record['views']) == {v['id'] for v in recipe}
            record['updatedAt'] = datetime.now(timezone.utc).isoformat()
            temp = checkpoint_path.with_suffix('.tmp'); temp.write_text(json.dumps(record, indent=2, ensure_ascii=False)+'\n'); temp.replace(checkpoint_path)
            print('CC_STUDY_PAIR', name, 'eyes', white, 'completed', len(record['views']), flush=True)
finally:
    if context is not None and original is not None:
        context['scene'].camera = original
        context['camera'] = old_camera_global if old_camera_global is not None else original
        current = (tuple(v for row in original.matrix_world for v in row), original.data.as_pointer(),
                   original.data.type, original.data.ortho_scale, original.data.shift_x, original.data.shift_y)
        if current != camera_signature: raise AssertionError('Original camera was changed')
        if study is not None:
            data = study.data; bpy.data.objects.remove(study, do_unlink=True); bpy.data.cameras.remove(data)
    for path, digest in protected.items():
        if not path.is_file() or sha(path) != digest: raise AssertionError(f'Protected input changed: {path}')
print('CC_STUDY_FINISHED', len(record['views']), 'pairs; complete', record['complete'], 'all protected bytes unchanged', flush=True)
