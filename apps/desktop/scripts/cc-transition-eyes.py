"""Blender eye-coverage pass + canonical eye cut at frame 004, both directions.
Run after either transition renderer. No scene/source save; no body RGB or alpha
changes. Canonical eye pixels (including their authored AA edge) are copied only
inside the camera-rendered eye support; we never interpolate eye colors.
"""
from pathlib import Path
import hashlib,json,struct,zlib,tempfile
import bpy
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
KIT=ROOT/'src/assets/pet/cc-v1';ART=ROOT/'art/cc-v1'
freeze=json.loads((ART/'design-freeze.json').read_text())
source=ART/'cc-v1.blend'
assert hashlib.sha256(source.read_bytes()).hexdigest()==freeze['sha256']['apps/desktop/art/cc-v1/cc-v1.blend']
bpy.ops.wm.open_mainfile(filepath=str(source));scene=bpy.context.scene
scene.compositing_node_group=None
scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA';scene.render.image_settings.color_depth='8'
scene.view_settings.view_transform='Standard';scene.view_settings.exposure=0
scene.cycles.samples=96;scene.cycles.seed=11;scene.cycles.use_denoising=False

def matte(name,value):
    mat=bpy.data.materials.new(name);mat.use_nodes=True
    nodes=mat.node_tree.nodes;nodes.clear()
    emission=nodes.new('ShaderNodeEmission');emission.inputs['Color'].default_value=(value,value,value,1)
    output=nodes.new('ShaderNodeOutputMaterial');mat.node_tree.links.new(emission.outputs[0],output.inputs['Surface'])
    return mat
black=matte('Eye coverage / black',0);white=matte('Eye coverage / white',1)
for name in ['Body','Foot.L','Foot.R','C','Eye.L','Eye.R']:
    bpy.data.objects[name].data.materials[0]=white if name.startswith('Eye.') else black

def read(path):
    im=bpy.data.images.load(str(path),check_existing=False)
    rgba=np.rint(np.clip(np.array(im.pixels[:]).reshape(512,512,4)[::-1],0,1)*255).astype(np.uint8)
    bpy.data.images.remove(im);return rgba

def write(path,rgba):
    def chunk(t,b):return struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b))
    data=b''.join(b'\0'+row.tobytes() for row in rgba)
    path.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',512,512,8,6,0,0,0))+chunk(b'sRGB',b'\0')+chunk(b'IDAT',zlib.compress(data,9))+chunk(b'IEND',b''))
with tempfile.TemporaryDirectory(prefix='cc-eye-coverage-') as temp:
    scene.render.filepath=str(Path(temp)/'eyes.png');bpy.ops.render.render(write_still=True)
    coverage=read(scene.render.filepath)[:,:,0]
# Exclude one-level display dithering outside the eye mesh projections.
y,x=np.indices((512,512));support=(coverage>1)&(y>300)&(y<420)&(x>180)&(x<360)
assert 200<support.sum()<1600, support.sum()
mask=np.full((512,512,4),255,dtype=np.uint8);mask[:,:,3]=support.astype(np.uint8)*255;mask[~support]=0
write(ART/'transition-eyes-mask.png',mask)
canonical={form:read(KIT/f'canonical/{form}/front.png') for form in ['lit','unlit']}
records=[]
for folder,start,end in [('dark-to-light','unlit','lit'),('light-to-dark','lit','unlit')]:
    for i in range(1,7):
        path=KIT/f'transitions/{folder}/{i:03}.png';rgba=read(path);before=rgba.copy()
        form=start if i<4 else end
        rgba[support,:3]=canonical[form][support,:3]
        assert np.array_equal(rgba[:,:,3],before[:,:,3])
        assert np.array_equal(rgba[~support],before[~support])
        write(path,rgba)
        records.append({'path':str(path.relative_to(KIT)),'eyeForm':form,'outsideEyeSha256':hashlib.sha256(rgba[~support].tobytes()).hexdigest(),'alphaSha256':hashlib.sha256(rgba[:,:,3].tobytes()).hexdigest()})
(ART/'transition-eyes-verification.json').write_text(json.dumps({'switchFrame':4,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'supportPixels':int(support.sum()),'frames':records},indent=2)+'\n')
print('CC_EYE_CUT',int(support.sum()),'pixels;',len(records),'frames; source unchanged')
