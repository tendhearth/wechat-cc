"""Eight original frozen C poses, paired materials, art study only. Run after batch."""
from pathlib import Path
import hashlib
import json
import runpy
import sys
import tempfile

root = Path.cwd().resolve()
desktop = root / 'apps/desktop'
source = desktop / 'art/cc-v1'
kit = desktop / 'src/assets/pet/cc-v1'
plan_path = source / 'motion/recipes.json'
progress_path = source / 'motion/render-progress.json'
plan = json.loads(plan_path.read_text())
progress_bytes = progress_path.read_bytes()
progress = json.loads(progress_bytes)
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
expected = {f"{clip['id']}/{index:03}": sample for clip in plan['clips'] for index, sample in enumerate(clip['frames'])}
assert set(progress['samples']) == set(expected), 'Finish the primary motion batch before the pose study'
for name, sample in expected.items():
    entry = progress['samples'][name]
    assert entry['parameters'] == sample
    for path, digest in entry['files'].items():
        assert sha(kit/path) == digest
freeze = json.loads((source/'design-freeze.json').read_text())
protected = {root/path: digest for path,digest in freeze['sha256'].items()}
protected[kit/'manifest.json'] = sha(kit/'manifest.json')
protected[progress_path] = hashlib.sha256(progress_bytes).hexdigest()
for path,digest in protected.items():
    assert sha(path) == digest
output = source / 'studies/c-poses'
assert not output.exists(), 'Use a fresh study output; never overwrite a reviewed study'
# Load the exact frozen rig through a fully cached sample. This cannot rerender
# or change production files because all sample digests were validated above.
driver = desktop/'scripts/render-cc.py'
sys.argv = [str(driver), '--', '--motion-plan', str(plan_path), '--clip', 'done', '--motion-frame', '0', '--resume-motion', '--samples', str(progress['identity']['samples']), '--threads', '2']
namespace = runpy.run_path(str(driver), run_name='__main__')
render = namespace['render_pair']
context = render.__globals__
poses = context['C_POSES']
output.mkdir(parents=True)
records = []
try:
    with tempfile.TemporaryDirectory(prefix='cc-c-pose-raw-') as temporary:
        context['KIT'] = output
        context['SOURCE'] = Path(temporary)
        for pose,spec in poses.items():
            if pose == 'default':
                paths = [f'motion/{form}/{pose}/000.png' for form in ['lit','unlit']]+[f'masks/{pose}.png']
                originals = [kit/f'canonical/{form}/front.png' for form in ['lit','unlit']]+[kit/'masks/front.png']
                for path, original in zip(paths, originals):
                    destination=output/path; destination.parent.mkdir(parents=True,exist_ok=True); destination.write_bytes(original.read_bytes())
            else:
                render('000', pose=pose, eye_scale=1, mask_name=pose, motion_clip=pose)
                paths = [f'motion/{form}/{pose}/000.png' for form in ['lit','unlit']]+[f'masks/{pose}.png']
            records.append({'id':pose,'label':spec['label'],'frames':{'lit':paths[0],'unlit':paths[1]},'geometryMask':paths[2], 'sha256':{path:sha(output/path) for path in paths}})
            print('CC_POSE_STUDY',pose,flush=True)
    record = {'schemaVersion':1,'artStatus':'production-candidate','usage':'design study only; not a new runtime behavior or mood inference','source':{'sha256':progress['identity']['sourceSha256'],'rendererSha256':progress['identity']['rendererSha256'],'geometrySha256':progress['identity']['geometrySha256'],'studyScriptSha256':sha(__file__),'blender':progress['identity']['blender'],'samples':progress['identity']['samples'],'seed':11},'canvas':plan['canvas'],'poses':records}
    (output/'poses.json').write_text(json.dumps(record,indent=2,ensure_ascii=False)+'\n')
finally:
    for path,digest in protected.items():
        assert sha(path) == digest, f'Protected production input changed: {path}'
print('CC_POSE_STUDY_FINISHED',len(records),'paired original C poses; production bytes unchanged',flush=True)
