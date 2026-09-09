"""Seven standalone CC prop candidates. Never opens or modifies the frozen character scene."""
from pathlib import Path
import argparse, math, struct, sys, zlib
import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT/'src/assets/pet/props'
ART = ROOT/'art/cc-v1/props'
ART.mkdir(parents=True, exist_ok=True)
SIZE = 384
NAMES = ['micro-light','laptop','envelope','speech-bubble','thought-bubble','exclamation','mug']
parser=argparse.ArgumentParser()
parser.add_argument('--props', nargs='+', choices=NAMES, default=NAMES)
selected=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []).props
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 96
scene.cycles.seed = 11
scene.cycles.use_denoising = True
scene.render.resolution_x = scene.render.resolution_y = SIZE
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.color_depth = '8'
scene.view_settings.view_transform = 'AgX'
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.7,.75,.85,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .25

def linear(code):
    rgb = [int(code[i:i+2],16)/255 for i in (0,2,4)]
    return tuple(v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in rgb)+(1,)

def material(name, color, roughness=.7, sss=0, emission=0):
    mat=bpy.data.materials.new(name);mat.use_nodes=True
    p=mat.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value=linear(color)
    p.inputs['Roughness'].default_value=roughness
    p.inputs['Specular IOR Level'].default_value=.15
    p.inputs['Subsurface Weight'].default_value=sss
    p.inputs['Subsurface Scale'].default_value=.12
    p.inputs['Emission Color'].default_value=linear(color)
    p.inputs['Emission Strength'].default_value=emission
    return mat

ivory=material('Props / warm soft porcelain','FFF7E6',.65,.25)
charcoal=material('Props / matte charcoal','1A1A1A',.88)
seam=material('Props / quiet inset details','9F8870',.9)
keys=material('Props / charcoal keys','373737',.9)
tea=material('Props / warm dark tea','34291F',.35)
gold=material('Props / warm signal','F45B08',.65,0)
glow=material('Props / micro light','FFC052',.65,.2,6)

for name,location,energy,size,color in [
    ('Key',(-3,-4,6),450,4,(1,.91,.78)),
    ('Fill',(4,-3,3),150,4,(.8,.87,1)),
    ('Rim',(1,3,4),500,3,(1,.85,.65)),
]:
    bpy.ops.object.light_add(type='AREA',location=location);o=bpy.context.object
    o.name=name;o.data.energy=energy;o.data.shape='DISK';o.data.size=size;o.data.color=color
    o.rotation_euler=(Vector((0,0,.6))-o.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(2.3,-8,3.7));camera=bpy.context.object
camera.rotation_euler=(Vector((0,0,.65))-camera.location).to_track_quat('-Z','Y').to_euler()
camera.data.type='ORTHO';camera.data.ortho_scale=3.35;scene.camera=camera

objects=[]
def finish(o,name,mat):
    o.name=name;o.data.materials.append(mat);objects.append(o)
    if o.type=='MESH':
        for face in o.data.polygons:face.use_smooth=True
    return o

def sphere(name,location,scale,mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64,ring_count=32,location=location)
    o=bpy.context.object;o.scale=scale
    return finish(o,name,mat)

def box(name,location,scale,mat,bevel=.08):
    bpy.ops.mesh.primitive_cube_add(size=1,location=location);o=bpy.context.object;o.scale=scale
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    m=o.modifiers.new('Soft edges','BEVEL');m.width=bevel;m.segments=6
    o.modifiers.new('Broad face normals','WEIGHTED_NORMAL')
    return finish(o,name,mat)

def curve(name,points,radius,mat):
    data=bpy.data.curves.new(name,'CURVE');data.dimensions='3D';data.resolution_u=16
    data.bevel_depth=radius;data.bevel_resolution=5
    s=data.splines.new('POLY');s.points.add(len(points)-1)
    for v,p in zip(s.points,points):v.co=(*p,1)
    o=bpy.data.objects.new(name,data);scene.collection.objects.link(o)
    return finish(o,name,mat)

def plaque(name,points,depth,mat,bevel=.06):
    n=len(points);verts=[(x,y,z) for y in [-depth/2,depth/2] for x,z in points]
    faces=[tuple(reversed(range(n))),tuple(range(n,n*2))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update()
    o=bpy.data.objects.new(name,mesh);scene.collection.objects.link(o)
    b=o.modifiers.new('Soft rim','BEVEL');b.width=bevel;b.segments=6
    o.modifiers.new('Soft face normals','WEIGHTED_NORMAL')
    return finish(o,name,mat)

def build(name):
    if name=='micro-light':
        def star(cx,cz,size):
            pts=[]
            for i in range(10):
                t=math.pi/2+i*math.pi/5;r=size*(1 if i%2==0 else .60)
                pts.append((cx+r*math.cos(t),cz+r*math.sin(t)))
            plaque('Soft five-point light',pts,.30,glow,.14*size)
        star(-.10,.7,.80);star(.83,1.46,.20);star(-.91,.23,.15)
    elif name=='laptop':
        box('Rounded base',(0,0,.04),(1.95,1.22,.16),charcoal,.08)
        for row in range(3):
            for col in range(8):box('Key',(-.72+col*.205,-.18+row*.18,.137),(.15,.13,.035),keys,.025)
        box('Trackpad',(0,-.43,.134),(.60,.24,.02),seam,.03)
        panel=box('Open lid',(0,.43,.83),(1.94,.16,1.52),charcoal,.10)
        box('Quiet screen',(0,.335,.86),(1.65,.025,1.22),keys,.08)
        curve('Screen cursor',[(-.47,.309,.90),(-.20,.309,.90)],.025,ivory)
        curve('Screen line',[(-.47,.309,.69),(.38,.309,.69)],.018,seam)
    elif name=='envelope':
        box('Envelope',(0,0,.70),(1.95,.24,1.28),ivory,.12)
        curve('Fold',[(-.84,-.132,1.20),(0,-.144,.65),(.84,-.132,1.20)],.020,seam)
        curve('Lower left fold',[(-.83,-.132,.17),(-.30,-.14,.60)],.014,seam)
        curve('Lower right fold',[(.83,-.132,.17),(.30,-.14,.60)],.014,seam)
    elif name=='speech-bubble':
        pts=[]
        for i in range(64):
            t=2*math.pi*i/64
            if i==42:pts.append((-.73,-.05))
            else:pts.append((.98*math.cos(t),.82+.64*math.sin(t)))
        plaque('Speech',pts,.34,ivory,.10)
    elif name=='thought-bubble':
        cloud=[]
        for x,z,s in [(-.53,.88,.55),(0,1.12,.67),(.57,.9,.54),(0,.67,.67)]:cloud.append(sphere('Cloud',(x,0,z),(s,.29,s*.72),ivory))
        bpy.ops.object.select_all(action='DESELECT')
        for o in cloud:o.select_set(True)
        bpy.context.view_layer.objects.active=cloud[0];bpy.ops.object.join();merged=cloud[0]
        objects[:]=[o for o in objects if o==merged]
        remesh=merged.modifiers.new('Joined soft cloud','REMESH');remesh.mode='VOXEL';remesh.voxel_size=.035;remesh.use_smooth_shade=True
        smooth=merged.modifiers.new('Cloud smoothing','SMOOTH');smooth.factor=1;smooth.iterations=10
        sub=merged.modifiers.new('Soft cloud surface','SUBSURF');sub.levels=1
        sphere('Thought dot large',(-.55,-.01,.16),(.16,.13,.14),ivory)
        sphere('Thought dot small',(-.78,-.01,-.16),(.09,.08,.09),ivory)
    elif name=='exclamation':
        sphere('Signal stem',(0,0,.97),(.18,.18,.66),gold)
        sphere('Signal dot',(0,0,.05),(.19,.18,.19),gold)
    elif name=='mug':
        # Lathed hollow cup: outer wall, rolled lip, inner wall and interior base.
        profile=[(0,.05),(.50,.05),(.60,.14),(.64,.85),(.62,.98),(.56,1.01),(.50,.95),(.51,.24),(0,.24)]
        verts=[(r*math.cos(t),r*math.sin(t),z) for r,z in profile for t in np.linspace(0,2*math.pi,96,endpoint=False)]
        faces=[]
        for k in range(len(profile)-1):
            for j in range(96):a=k*96+j;b=k*96+(j+1)%96;faces.append((a,b,b+96,a+96))
        mesh=bpy.data.meshes.new('Hollow cup');mesh.from_pydata(verts,[],faces);mesh.update()
        o=bpy.data.objects.new('Porcelain mug',mesh);scene.collection.objects.link(o);finish(o,'Porcelain mug',ivory)
        smooth=o.modifiers.new('Round porcelain','SUBSURF');smooth.levels=2
        curve('Handle',[(.58+.42*math.cos(t),0,.55+.36*math.sin(t)) for t in np.linspace(-math.pi/2,math.pi/2,64)],.12,ivory)
        bpy.ops.mesh.primitive_cylinder_add(vertices=96,radius=.505,depth=.015,location=(0,0,.77));finish(bpy.context.object,'Tea',tea)

def rgba_png(path,rgba):
    def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
    rows=b''.join(b'\0'+row.tobytes() for row in rgba)
    path.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',SIZE,SIZE,8,6,0,0,0))+chunk(b'sRGB',b'\0')+chunk(b'IDAT',zlib.compress(rows,9))+chunk(b'IEND',b''))

def star_bloom():
    # Export the actual HDR Fog Glow separately; transparent film must not erase it.
    group=bpy.data.node_groups.new('Micro light HDR bloom','CompositorNodeTree')
    group.interface.new_socket(name='Image',in_out='OUTPUT',socket_type='NodeSocketColor')
    source=group.nodes.new('CompositorNodeRLayers')
    glare=group.nodes.new('CompositorNodeGlare')
    for key,value in [('Type','Fog Glow'),('Quality','High'),('Threshold',1.0),('Size',.7)]:
        glare.inputs[key].default_value=value
    opaque=group.nodes.new('CompositorNodeSetAlpha')
    opaque.inputs['Type'].default_value='Replace Alpha';opaque.inputs['Alpha'].default_value=1
    output=group.nodes.new('NodeGroupOutput')
    group.links.new(source.outputs['Image'],glare.inputs['Image'])
    group.links.new(glare.outputs['Glare'],opaque.inputs['Image'])
    group.links.new(opaque.outputs['Image'],output.inputs['Image'])
    scene.compositing_node_group=group
    scene.render.image_settings.file_format='OPEN_EXR';scene.render.image_settings.color_depth='32'
    scene.render.filepath='/tmp/cc-prop-micro-light-bloom.exr'
    bpy.ops.render.render(write_still=True)
    img=bpy.data.images.load(scene.render.filepath,check_existing=False)
    hdr=np.array(img.pixels[:],dtype=np.float32).reshape(SIZE,SIZE,4)[::-1].copy()
    bpy.data.images.remove(img)
    scene.compositing_node_group=None
    scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_depth='8'
    # Smoothly fade the measured bloom before the contractual clear border.
    yy,xx=np.indices((SIZE,SIZE))
    margin=np.minimum.reduce([xx,yy,SIZE-1-xx,SIZE-1-yy])
    fade=np.clip((margin-12)/18,0,1);fade=fade*fade*(3-2*fade)
    return np.minimum(.48,1-np.exp(-hdr[:,:,:3].mean(axis=2)*24))*fade

for name in selected:
    for o in list(objects):bpy.data.objects.remove(o,do_unlink=True)
    objects.clear();build(name)
    scene.render.filepath=str(OUT/(name+'.png'));bpy.ops.render.render(write_still=True)
    img=bpy.data.images.load(scene.render.filepath,check_existing=False)
    pixels=np.array(img.pixels[:],dtype=np.float32).reshape(SIZE,SIZE,4)[::-1].copy();bpy.data.images.remove(img)
    if name=='micro-light':
        halo=star_bloom()
        body=pixels[:,:,3].copy()
        alpha=body+halo*(1-body)
        # Straight-alpha union of rendered surface and warm HDR-driven light.
        pixels[:,:,:3]=(pixels[:,:,:3]*body[:,:,None]+np.array([1,.68,.22])*((1-body)*halo)[:,:,None])/np.maximum(alpha[:,:,None],1e-8)
        pixels[:,:,3]=alpha
    # Keep Blender's display RGB and real coverage; normalize transparent RGB.
    rgba=np.rint(np.clip(pixels,0,1)*255).astype(np.uint8);rgba[rgba[:,:,3]==0]=0
    yy,xx=np.where(rgba[:,:,3]>0)
    assert len(xx) and xx.min()>=12 and yy.min()>=12 and xx.max()<SIZE-12 and yy.max()<SIZE-12,(name,xx.min(),yy.min(),xx.max(),yy.max())
    rgba_png(OUT/(name+'.png'),rgba)
    print('CC_PROP',name,[int(xx.min()),int(yy.min()),int(xx.max()+1),int(yy.max()+1)])
