"""Render a new Light -> Dark performance from the frozen scene; never save it.
Mix frozen surface shader graphs, with smoothstep timing at 6 fps. The accepted
Light effect layer fades quadratically; shared entity coverage and exact endpoint
bytes remain the canonical contract. This is not reversed dark-to-light footage.
"""
from pathlib import Path
import hashlib, json, struct, zlib, tempfile
import bpy
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'art/cc-v1';KIT=ROOT/'src/assets/pet/cc-v1'
freeze=json.loads((ART/'design-freeze.json').read_text())
for path,digest in freeze['sha256'].items():
    assert hashlib.sha256((ROOT.parents[1]/path).read_bytes()).hexdigest()==digest,path
bpy.ops.wm.open_mainfile(filepath=str(ART/'cc-v1.blend'))
scene=bpy.context.scene
scene.cycles.samples=96;scene.cycles.seed=11
scene.compositing_node_group=None

def shader_group(mat):
    group=bpy.data.node_groups.new('Transition / '+mat.name,'ShaderNodeTree')
    group.interface.new_socket(name='Surface',in_out='OUTPUT',socket_type='NodeSocketShader')
    mapping={}
    for node in mat.node_tree.nodes:
        if node.type=='OUTPUT_MATERIAL':continue
        clone=group.nodes.new(node.bl_idname);mapping[node]=clone
        # Copy writable RNA settings before sockets (Math operation changes sockets).
        for prop in node.bl_rna.properties:
            if prop.is_readonly or prop.identifier in ['name','location','parent','select']:continue
            if prop.type in ['BOOLEAN','INT','FLOAT','STRING','ENUM']:
                try:setattr(clone,prop.identifier,getattr(node,prop.identifier))
                except (TypeError,AttributeError):pass
        if hasattr(node,'color_ramp'):
            a,b=node.color_ramp,clone.color_ramp
            b.interpolation=a.interpolation;b.color_mode=a.color_mode;b.hue_interpolation=a.hue_interpolation
            while len(b.elements)>2:b.elements.remove(b.elements[-1])
            for i,e in enumerate(a.elements):
                target=b.elements[i] if i<2 else b.elements.new(e.position)
                target.position=e.position;target.color=e.color
        for i,socket in enumerate(node.inputs):
            if hasattr(socket,'default_value'):
                try:clone.inputs[i].default_value=socket.default_value
                except (TypeError,ValueError,IndexError):pass
    out=group.nodes.new('NodeGroupOutput')
    for link in mat.node_tree.links:
        source=mapping[link.from_node].outputs[list(link.from_node.outputs).index(link.from_socket)]
        target=out.inputs['Surface'] if link.to_node.type=='OUTPUT_MATERIAL' else mapping[link.to_node].inputs[list(link.to_node.inputs).index(link.to_socket)]
        group.links.new(source,target)
    return group

mixes=[]
def mix_material(light_name,dark_name):
    mat=bpy.data.materials.new('Extinguish / '+light_name);mat.use_nodes=True
    tree=mat.node_tree;tree.nodes.clear()
    a,b=[tree.nodes.new('ShaderNodeGroup') for _ in range(2)]
    a.node_tree=shader_group(bpy.data.materials[light_name]);b.node_tree=shader_group(bpy.data.materials[dark_name])
    mix=tree.nodes.new('ShaderNodeMixShader');mixes.append(mix)
    out=tree.nodes.new('ShaderNodeOutputMaterial')
    tree.links.new(a.outputs[0],mix.inputs[1]);tree.links.new(b.outputs[0],mix.inputs[2]);tree.links.new(mix.outputs[0],out.inputs['Surface'])
    return mat
body=mix_material('Light / soft ivory porcelain','Dark / matte charcoal / NO emission')
c=mix_material('Light / C tube / restrained emission','Dark / matte charcoal / NO emission')
eye=mix_material('Light eyes / ink','Dark eyes / camera-only unlit white')
for name in ['Body','Foot.L','Foot.R','C','Eye.L','Eye.R']:
    bpy.data.objects[name].data.materials[0]=c if name=='C' else eye if name.startswith('Eye.') else body

def load(path):
    im=bpy.data.images.load(str(path),check_existing=False)
    result=np.array(im.pixels[:],dtype=np.float64).reshape(512,512,4)[::-1].copy()
    bpy.data.images.remove(im);return result

def save(path,rgba):
    def chunk(t,b):return struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b))
    data=b''.join(b'\0'+row.tobytes() for row in rgba)
    path.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',512,512,8,6,0,0,0))+chunk(b'sRGB',b'\0')+chunk(b'IDAT',zlib.compress(data,9))+chunk(b'IEND',b''))

lit=load(KIT/'canonical/lit/front.png');dark=load(KIT/'canonical/unlit/front.png')
mask=np.rint(load(KIT/'masks/front.png')[:,:,3]*255).astype(np.uint8)
a=mask/255
# The accepted effect includes warm bloom and subtle contact shadow. Only its
# opacity changes, independently from the surface shader interpolation.
extra=np.maximum(lit[:,:,3]-a,0)
lights=[('Key / broad warm softbox',110,180),('Fill / cool front',35,60),('Rim / warm back',220,550),('Rim / left contour',80,230),('Rim / right contour',60,180)]
out=KIT/'transitions/light-to-dark';out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='cc-extinguish-') as temp:
    for i in range(8):
        path=out/f'{i:03}.png'
        if i in [0,7]:
            path.write_bytes((KIT/f"canonical/{'lit' if i==0 else 'unlit'}/front.png").read_bytes());continue
        u=i/7;ease=u*u*(3-2*u)
        # HDR emission stays bright until very small weights; compensate its
        # nonlinear display response so the last frame is not an abrupt blackout.
        t=1-(1-ease)**3
        for mix in mixes:mix.inputs[0].default_value=t
        for name,start,end in lights:bpy.data.objects[name].data.energy=start+(end-start)*t
        scene.render.filepath=str(Path(temp)/'surface.png');bpy.ops.render.render(write_still=True)
        surface=load(scene.render.filepath)
        effect=extra*(1-ease)**2
        alpha=a+effect
        rgb=(surface[:,:,:3]*a[:,:,None]+lit[:,:,:3]*effect[:,:,None])/np.maximum(alpha[:,:,None],1e-12)
        # Camera-only white eye endpoint avoids AgX-dimmed gray eyes near the end.
        eye_coverage=np.clip((dark[:,:,:3].min(axis=2)-.9)/.1,0,1)
        rgb=rgb*(1-eye_coverage[:,:,None]*t)+eye_coverage[:,:,None]*t
        rgba=np.rint(np.clip(np.dstack([rgb,alpha]),0,1)*255).astype(np.uint8)
        rgba[:,:,3]=np.maximum(rgba[:,:,3],mask);rgba[:,:,3][mask>=250]=mask[mask>=250]
        rgba[rgba[:,:,3]==0]=0
        save(path,rgba)
        print('CC_EXTINGUISH',i,'shader mix',t)
for path,digest in freeze['sha256'].items():
    assert hashlib.sha256((ROOT.parents[1]/path).read_bytes()).hexdigest()==digest,path
