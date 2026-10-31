"""Actual rendered before/after proof; run in offline Blender on dedicated Mini."""
from pathlib import Path
import hashlib, json, subprocess, sys
import bpy
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cc_prop_glow import glow_alpha

assert Path.home() == Path('/Users/home')
root = Path(__file__).resolve().parents[3]
study = root/'apps/desktop/art/cc-v1/studies/prop-polish-r2'
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def read(path):
    image = bpy.data.images.load(str(path), check_existing=False)
    try: return np.rint(np.clip(np.array(image.pixels[:]).reshape(384,384,4)[::-1],0,1)*255).astype(np.uint8)
    finally: bpy.data.images.remove(image)
before, after, body = [read(study/name) for name in ['before.png','source/micro-light.png','source/micro-light-body.png']]
support = glow_alpha(np.ones((384,384,3)), body[:,:,3].astype(np.float32)/255, radius=28)
far = (support == 0) & (body[:,:,3] == 0)
old_far = int(np.count_nonzero(before[:,:,3][far]))
new_far = int(np.count_nonzero(after[:,:,3][far]))
assert old_far > 0, 'Before image did not reproduce the distant rectangular support'
assert new_far == 0, 'New image retains distant halo support'
core = body[:,:,3] == 255
assert np.array_equal(after[core],body[core]), 'Opaque star pixels changed during composition'
assert np.all(after[:,:,3] >= body[:,:,3]), 'Surface coverage eroded'
assert np.all(after[after[:,:,3] == 0] == 0), 'Transparent RGB is not zero'
exterior = (body[:,:,3] == 0) & (after[:,:,3] > 0)
assert np.any(exterior), 'Glow was deleted instead of repaired'
assert not any(np.any(a) for a in [after[:12,:,3],after[-12:,:,3],after[:,:12,3],after[:,-12:,3]])
freeze=json.loads((root/'apps/desktop/art/cc-v1/design-freeze.json').read_text())
for name,digest in freeze['sha256'].items(): assert sha(root/name)==digest, name
for name in ['laptop','envelope','speech-bubble','thought-bubble','exclamation','mug']:
    path='apps/desktop/src/assets/pet/props/'+name+'.png'
    old=subprocess.check_output(['git','show','10e15dab:'+path],cwd=root)
    assert hashlib.sha256(old).hexdigest()==sha(root/path), path
result={'ok':True,'radius':28,'beforeFarAlphaPixels':old_far,'afterFarAlphaPixels':new_far,'nearExteriorPixels':int(np.count_nonzero(exterior)),
        'opaqueCoreUnchanged':True,'frozenFiles':len(freeze['sha256']),'otherPropsUnchanged':6,'beforeSha256':sha(study/'before.png'),'afterSha256':sha(study/'source/micro-light.png')}
(study/'pixel-check.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result),flush=True)
