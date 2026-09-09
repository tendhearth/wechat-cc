"""CC production candidate: shared opaque entity coverage, independent material effects.
Blender 5.2.1; frozen camera measured from all eight C poses. No manifest edits.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import zlib

import bpy
import numpy as np
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

ROOT = Path(__file__).resolve().parents[1]
KIT = ROOT / 'src/assets/pet/cc-v1'
SOURCE = ROOT / 'art/cc-v1'
parser = argparse.ArgumentParser()
parser.add_argument('--samples', type=int, default=96)
parser.add_argument('--calibrate-camera', action='store_true')
parser.add_argument('--expressions-only', action='store_true')
parser.add_argument('--behavior', choices=['thinking','working','done','receive','permission','error','look','drag'])
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
assert not (args.expressions_only and args.calibrate_camera)
assert not args.behavior or args.expressions_only


def linear(hex_color):
    c = [int(hex_color[i:i+2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= .04045 else ((v + .055) / 1.055)**2.4 for v in c) + (1,)


def material(name, color, roughness, subsurface=0, emission=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = linear(color)
    mat.use_nodes = True
    node = mat.node_tree.nodes.get('Principled BSDF')
    node.inputs['Base Color'].default_value = linear(color)
    node.inputs['Roughness'].default_value = roughness
    node.inputs['Subsurface Weight'].default_value = subsurface
    node.inputs['Subsurface Radius'].default_value = (1, .48, .22)
    node.inputs['Subsurface Scale'].default_value = .16
    node.inputs['Emission Color'].default_value = linear(color)
    node.inputs['Emission Strength'].default_value = emission
    node.inputs['Specular IOR Level'].default_value = .28
    return mat


bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = args.samples
scene.cycles.use_denoising = True
scene.cycles.seed = 11
scene.render.resolution_x = scene.render.resolution_y = 512
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.color_depth = '8'
scene.view_settings.view_transform = 'AgX'
scene.view_settings.exposure = 0
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.65, .7, .8, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .18
scene['cc_contract'] = 'feet=2 eyes=2 arms=0 tails=0 mouth=false ears=0 c_appendages=1'
scene['cc_view'] = 'three-quarter; canonical/front is the legacy runtime slot'
scene['cc_anchor_px'] = [256, 470]
scene['cc_palette_light'] = '#FFF7E6 #FFECD1 #FFFFFF #EADDC4'
scene['cc_palette_dark'] = '#1A1A1A #2B2B2B #3A3A3A #FFFFFF'
light = material('Light / soft ivory porcelain', 'FFF7E6', .5, .65, 5.0)
light_shader = light.node_tree.nodes.get('Principled BSDF')
light_shader.inputs['Emission Color'].default_value = (1, .68, .36, 1)
facing = light.node_tree.nodes.new('ShaderNodeLayerWeight')
facing.inputs['Blend'].default_value = .55
emission_gain = light.node_tree.nodes.new('ShaderNodeMath')
emission_gain.operation = 'MULTIPLY_ADD'
emission_gain.inputs[1].default_value = 3.5
emission_gain.inputs[2].default_value = 0
light.node_tree.links.new(facing.outputs['Facing'], emission_gain.inputs[0])
# Art-directed world-height profile, not a claim of measured wall thickness.
# A narrow central dip sits between the luminous base and shoulder.
nodes, links = light.node_tree.nodes, light.node_tree.links
position = nodes.new('ShaderNodeNewGeometry')
height = nodes.new('ShaderNodeSeparateXYZ')
links.new(position.outputs['Position'], height.inputs[0])
normalize = nodes.new('ShaderNodeMapRange')
normalize.inputs['From Min'].default_value = .1
normalize.inputs['From Max'].default_value = 2.45
links.new(height.outputs['Z'], normalize.inputs['Value'])
profile = nodes.new('ShaderNodeValToRGB')
for element in list(profile.color_ramp.elements)[1:]:
    profile.color_ramp.elements.remove(element)
for i, (at, strength) in enumerate([(0,.50),(.12,.48),(.28,.20),(.40,.33),(.60,.48),(1,.48)]):
    element = profile.color_ramp.elements[0] if i == 0 else profile.color_ramp.elements.new(at)
    element.position = at
    element.color = (strength,strength,strength,1)
profile.color_ramp.interpolation = 'EASE'
links.new(normalize.outputs['Result'], profile.inputs[0])
spatial_gain = nodes.new('ShaderNodeMath')
spatial_gain.operation = 'MULTIPLY_ADD'
spatial_gain.inputs[1].default_value = 7
links.new(profile.outputs['Color'], spatial_gain.inputs[0])
links.new(emission_gain.outputs[0], spatial_gain.inputs[2])
links.new(spatial_gain.outputs[0], light_shader.inputs['Emission Strength'])
warmth = nodes.new('ShaderNodeValToRGB')
warmth.color_ramp.elements[0].color = (1,.65,.38,1)
warmth.color_ramp.elements[1].color = (1,.80,.54,1)
links.new(normalize.outputs['Result'], warmth.inputs[0])
links.new(warmth.outputs['Color'], light_shader.inputs['Emission Color'])
# A broad Facing response replaces the former thin Fresnel outline.
light_c = light.copy()
light_c.name = 'Light / C tube / restrained emission'
c_profile = light_c.node_tree.nodes.get(profile.name).color_ramp
for element in c_profile.elements:
    element.color = (.20,.20,.20,1)
light_c.node_tree.nodes.get(emission_gain.name).inputs[1].default_value = 7
# A localized elliptical dip avoids a horizontal stripe across the whole body.
# World-space artist control: it does not move geometry or imply measured thickness.
def scalar_math(operation, first, second=None):
    node = nodes.new('ShaderNodeMath')
    node.operation = operation
    for index, value in enumerate([first, second]):
        if value is None:
            continue
        if isinstance(value, (int, float)):
            node.inputs[index].default_value = value
        else:
            links.new(value, node.inputs[index])
    return node.outputs[0]

x_radius = scalar_math('DIVIDE', height.outputs['X'], .85)
z_center = scalar_math('SUBTRACT', height.outputs['Z'], .78)
z_radius = scalar_math('DIVIDE', z_center, .38)
radius_squared = scalar_math('ADD', scalar_math('MULTIPLY', x_radius, x_radius),
                             scalar_math('MULTIPLY', z_radius, z_radius))
soft_dip = scalar_math('EXPONENT', scalar_math('MULTIPLY', radius_squared, -1))
body_profile = scalar_math('SUBTRACT', .50, scalar_math('MULTIPLY', soft_dip, .28))
links.new(body_profile, spatial_gain.inputs[0])
dark = material('Dark / matte charcoal / NO emission', '141414', .88)
dark_shader = dark.node_tree.nodes.get('Principled BSDF')
dark_shader.inputs['Specular IOR Level'].default_value = .07
dark_shader.inputs['Sheen Weight'].default_value = .18
dark_shader.inputs['Sheen Roughness'].default_value = .85
# Subtle micro-normal texture catches broad rim reflections without glitter.
noise = dark.node_tree.nodes.new('ShaderNodeTexNoise')
noise.inputs['Scale'].default_value = 135
noise.inputs['Detail'].default_value = 2
bump = dark.node_tree.nodes.new('ShaderNodeBump')
bump.inputs['Strength'].default_value = .08
bump.inputs['Distance'].default_value = .012
dark.node_tree.links.new(noise.outputs['Fac'], bump.inputs['Height'])
dark.node_tree.links.new(bump.outputs['Normal'], dark_shader.inputs['Normal'])
black_eye = material('Light eyes / ink', '090908', 1)
black_eye.node_tree.nodes.get('Principled BSDF').inputs['Specular IOR Level'].default_value = 0
def emission_material(name, color, camera_only=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    emission = nodes.new('ShaderNodeEmission')
    emission.inputs['Color'].default_value = color
    if camera_only:
        path = nodes.new('ShaderNodeLightPath')
        links.new(path.outputs['Is Camera Ray'], emission.inputs['Strength'])
    output = nodes.new('ShaderNodeOutputMaterial')
    links.new(emission.outputs[0], output.inputs['Surface'])
    return mat


white_eye = emission_material('Dark eyes / camera-only unlit white', (1,1,1,1), True)
eye_matte_white = emission_material('Eye matte / white', (1,1,1,1))
eye_matte_black = emission_material('Eye matte / black', (0,0,0,1))
parts = []


def sphere(name, location, scale, mat, body=False):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=64, location=location)
    obj = bpy.context.object
    obj.name = name
    if body:
        # A softly seated sphere, not a flat-bottomed hemisphere.
        for v in obj.data.vertices:
            if v.co.z < -.55:
                v.co.z = -.55 + (v.co.z + .55) * .55
    obj.scale = scale
    obj.data.materials.append(mat)
    for face in obj.data.polygons:
        face.use_smooth = True
    return obj


parts.append(sphere('Body', (0, 0, .742), (1.12, .94, .93), light, True))
for x, side in [(-.64, 'L'), (.64, 'R')]:
    parts.append(sphere('Foot.' + side, (x, -.52, .15), (.21, .25, .15), light))

# A single closed manifold tube with hemispherical caps. Sampling the centerline
# keeps the attachment a single anatomical object and supports later pose tables.
# Design sheet §06 / master §08: one rooted C, eight emotional poses.
# Values are model-space control points; all use identical tube topology.
C_POSES = {
    'default': {'label': '默认', 'stretch': 1.0},
    'listening': {'label': '倾听', 'stretch': 1.0, 'lean': -.28},
    'happy': {'label': '开心', 'stretch': 1.18},
    'confused': {'label': '疑惑', 'points': [[-.1,0,1.72],[.21,0,1.97],[.27,0,2.23],[.08,0,2.43],[-.12,0,2.5]]},
    'thinking': {'label': '思考', 'points': [[-.29,0,1.64],[-.30,0,1.86],[-.12,0,2.03],[.12,-.06,2.02],[.26,-.12,1.84]]},
    'low': {'label': '低落', 'points': [[-.27,-.06,1.76],[-.32,-.30,2.05],[-.14,-.57,2.15],[.10,-.79,2.00],[.20,-.95,1.72]]},
    'angry': {'label': '生气', 'points': [[.05,0,1.65],[-.22,0,1.88],[-.32,0,2.16],[-.20,0,2.44],[-.07,0,2.61]]},
    'excited': {'label': '兴奋', 'points': [[-.20,0,1.77],[.07,0,2.01],[.28,0,2.30],[.24,0,2.54],[.12,0,2.73]]},
}
ROOT_C = [-.12 + .44 * math.cos(math.radians(265)), .015, 1.88 + .49 * math.sin(math.radians(265))]


def tube(pose):
    spec = C_POSES[pose]
    centers = []
    for t in np.linspace(0, 1, 80):
        if 'points' in spec:
            points = [Vector(ROOT_C)] + [Vector(p) for p in spec['points']]
            u = float(t) * (len(points)-1)
            i = min(int(u), len(points)-2)
            u -= i
            p0, p1, p2, p3 = [points[max(0, min(j, len(points)-1))] for j in [i-1,i,i+1,i+2]]
            center = .5 * ((2*p1) + (-p0+p2)*u + (2*p0-5*p1+4*p2-p3)*u*u + (-p0+3*p1-3*p2+p3)*u*u*u)
        else:
            theta = math.radians(265-195*t)
            z = 1.88 + .49*math.sin(theta)
            center = Vector((-.12+.44*math.cos(theta), .015+spec.get('lean',0)*t, ROOT_C[2]+(z-ROOT_C[2])*spec['stretch']))
        centers.append(center)
    radii = [.275+.030*t for t in np.linspace(0,1,80)]
    rings = []
    start_tangent = (centers[1]-centers[0]).normalized()
    end_tangent = (centers[-1]-centers[-2]).normalized()
    for a in np.linspace(-math.pi/2,0,9)[:-1]:
        rings.append((centers[0]+start_tangent*radii[0]*math.sin(a),radii[0]*max(.0001,math.cos(a)),start_tangent))
    for i, center in enumerate(centers):
        rings.append((center,radii[i],(centers[min(i+1,79)]-centers[max(i-1,0)]).normalized()))
    for a in np.linspace(0,math.pi/2,9)[1:]:
        rings.append((centers[-1]+end_tangent*radii[-1]*math.sin(a),radii[-1]*max(.0001,math.cos(a)),end_tangent))
    verts, faces = [], []
    for center, radius, tangent in rings:
        normal = Vector((0,1,0))
        normal = (normal-tangent*normal.dot(tangent)).normalized()
        cross = tangent.cross(normal).normalized()
        for j in range(48):
            a = 2*math.pi*j/48
            verts.append(center+float(radius)*(normal*math.cos(a)+cross*math.sin(a)))
    for i in range(len(rings)-1):
        for j in range(48):
            a, b = i*48+j, i*48+(j+1)%48
            faces.append((a,b,b+48,a+48))
    faces.extend([tuple(reversed(range(48))),tuple(range((len(rings)-1)*48,len(rings)*48))])
    return verts, faces


verts, faces = tube('default')
mesh = bpy.data.meshes.new('C / continuous rounded tube')
mesh.from_pydata(verts, [], faces)
mesh.update()
c_obj = bpy.data.objects.new('C', mesh)
scene.collection.objects.link(c_obj)
c_obj.data.materials.append(light_c)
for face in mesh.polygons:
    face.use_smooth = True
parts.append(c_obj)
c_obj.shape_key_add(name='Basis')
for pose in C_POSES:
    if pose == 'default':
        continue
    key = c_obj.shape_key_add(name=pose)
    for vertex, coordinate in zip(key.data, tube(pose)[0]):
        vertex.co = coordinate


def set_pose(pose):
    for key in c_obj.data.shape_keys.key_blocks:
        if key.name != 'Basis':
            key.value = float(key.name == pose)
    bpy.context.view_layer.update()



# Two narrow capsules seated on the spherical face, no mouth.
eyes = []
for x, side in [(-.27, 'L'), (.27, 'R')]:
    z = .76
    y = -.94 * math.sqrt(1 - (x/1.12)**2 - ((z-.742)/.93)**2)
    eye = sphere('Eye.' + side, (x, y-.013, z), (1, .65, 1), black_eye)
    for v in eye.data.vertices:
        v.co *= .061
        v.co.z += .075 if v.co.z >= 0 else -.075
    eyes.append(eye)


def area(name, location, energy, size, color):
    bpy.ops.object.light_add(type='AREA', location=location)
    obj = bpy.context.object
    obj.name = name
    obj.data.energy = energy
    obj.data.shape = 'DISK'
    obj.data.size = size
    obj.data.color = color
    obj.rotation_euler = (Vector((0, 0, 1.4)) - obj.location).to_track_quat('-Z', 'Y').to_euler()


area('Key / broad warm softbox', (-3.5, -4.5, 6), 380, 4, (1, .91, .78))
area('Fill / cool front', (4, -4, 3), 110, 4, (.80, .87, 1))
area('Rim / warm back', (1, 3, 4.5), 480, 3, (1, .82, .60))
area('Light / internal warm bounce', (0, -1, .1), 0, 1.8, (1, .62, .30))
warm_bounce = bpy.context.object
area('Rim / left contour', (-3,3,2.1), 80, 2.2, (1,.88,.72))
area('Rim / right contour', (3,3,2.5), 60, 2.2, (.86,.91,1))
bpy.ops.object.camera_add(location=(-3.0, -10, 2.8))
camera = bpy.context.object
camera.name = 'Camera / fixed 3-4 / 512 / baseline 470'
camera.rotation_euler = (Vector((0, 0, 1.65)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type = 'ORTHO'
scene.camera = camera


def register_camera(scale):
    camera.data.ortho_scale = scale
    camera.location = (-3.0,-10,2.8)
    bpy.context.view_layer.update()
    foot_points = [world_to_camera_view(scene,camera,o.matrix_world@v.co) for o in parts if o.name.startswith('Foot') for v in o.data.vertices]
    min_y = min(p.y for p in foot_points)
    local_up = camera.rotation_euler.to_matrix()@Vector((0,1,0))
    camera.location += local_up*((43.75/512-min_y)*-scale)
    bpy.context.view_layer.update()


# Fingerprint the actual mesh coordinates, every pose and the camera direction.
fingerprint = hashlib.sha256()
for obj in parts + eyes:
    fingerprint.update(np.array([list(v.co) for v in obj.data.vertices],dtype='<f4').tobytes())
    fingerprint.update(str((tuple(obj.location),tuple(obj.scale))).encode())
for pose in C_POSES:
    fingerprint.update(np.array(tube(pose)[0],dtype='<f4').tobytes())
fingerprint.update(str((tuple(camera.rotation_euler),43.75)).encode())
geometry_fingerprint = fingerprint.hexdigest()
fit_path = SOURCE/'camera-fit.json'
if not args.calibrate_camera:
    fit = json.loads(fit_path.read_text())
    assert fit['geometrySha256'] == geometry_fingerprint, 'Geometry changed: recalibrate all eight poses first'
    register_camera(fit['orthoScale'])
    set_pose('default')
SOURCE.mkdir(parents=True, exist_ok=True)
bpy.data.objects['Key / broad warm softbox'].data.energy = 110
bpy.data.objects['Fill / cool front'].data.energy = 35
bpy.data.objects['Rim / warm back'].data.energy = 220
# Save source with Light active; all Dark materials are retained by fake users.
for mat in [dark, white_eye]:
    mat.use_fake_user = True
bpy.context.preferences.filepaths.save_version = 0


def reference_digests():
    """Design boards live outside the public repo; fall back to the manifest's recorded digests."""
    manifest = json.loads((KIT/'manifest.json').read_text(encoding='utf-8').lstrip('\ufeff'))
    recorded = {manifest['reference']['path']: manifest['reference']['sha256'], **{s['path']: s['sha256'] for s in manifest.get('designSheets', [])}}
    return {name: (hashlib.sha256((KIT/name).read_bytes()).hexdigest() if (KIT/name).exists() else digest) for name, digest in recorded.items()}


def png(path, rgba):
    """Lossless RGBA8 output; no platform image libraries required."""
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = b''.join(b'\x00' + row.tobytes() for row in rgba)
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 512, 512, 8, 6, 0, 0, 0)) + chunk(b'sRGB', b'\x00') + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b''))


def read_render(path):
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(str(path), check_existing=False)
    values = np.array(img.pixels[:],dtype=np.float32).reshape(512,512,4)[::-1].copy()
    bpy.data.images.remove(img)
    return values


def bbox(alpha):
    yy, xx = np.where(alpha > 0)
    assert len(xx), 'Empty pose'
    return [int(xx.min()),int(yy.min()),int(xx.max()+1),int(yy.max()+1)]


if args.calibrate_camera:
    warm_bounce.data.energy = 0
    bpy.data.objects['Key / broad warm softbox'].data.energy = 180
    bpy.data.objects['Fill / cool front'].data.energy = 60
    bpy.data.objects['Rim / warm back'].data.energy = 550
    for obj in parts:
        obj.data.materials[0] = dark
    for obj in eyes:
        obj.data.materials[0] = white_eye
    target = [104,52,408,470]  # 24 px reserved for the effect envelope.
    def measure(scale, directory):
        register_camera(scale)
        directory.mkdir(parents=True,exist_ok=True)
        bounds = {}
        for pose in C_POSES:
            set_pose(pose)
            rgba = read_render(directory/(pose+'.png'))
            bounds[pose] = bbox(np.rint(rgba[:,:,3]*255))
        return bounds
    measurement = measure(6.0,SOURCE/'poses-measurement')
    ratio = max(max((256-b[0])/152,(b[2]-256)/152,(469-b[1])/(469-52)) for b in measurement.values())
    scale = math.ceil(6.0*ratio*20)/20
    while True:
        final = measure(scale,SOURCE/'poses')
        if all(b[0]>=target[0] and b[1]>=target[1] and b[2]<=target[2] and b[3]<=target[3] for b in final.values()):
            break
        scale = round(scale+.05,2)
    fit_path.write_text(json.dumps({'geometrySha256':geometry_fingerprint,'orthoScale':scale,'cameraLocation':list(camera.location),'cameraRotation':list(camera.rotation_euler),'entityTargetBbox':target,'measurementScale':6.0,'measurementBounds':measurement,'finalBounds':final,'samples':args.samples,'referenceSha256':reference_digests(),'poseLabels':{k:v['label'] for k,v in C_POSES.items()}},indent=2,ensure_ascii=False)+'\n')
    for file in (SOURCE/'poses-measurement').glob('*.png'):
        file.unlink()
    (SOURCE/'poses-measurement').rmdir()
    set_pose('default')
    warm_bounce.data.energy = 0
    bpy.data.objects['Key / broad warm softbox'].data.energy = 110
    bpy.data.objects['Fill / cool front'].data.energy = 35
    bpy.data.objects['Rim / warm back'].data.energy = 220
    for obj in parts:
        obj.data.materials[0] = light_c if obj == c_obj else light
    for obj in eyes:
        obj.data.materials[0] = black_eye
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'cc-v1.blend'))
    print('CC_CAMERA_FIT',scale,final)
    sys.exit(0)


# Blender 5.2 compositor: extract glare radiance, not a blurred silhouette.
compositor = bpy.data.node_groups.new('CC / emission bloom', 'CompositorNodeTree')
compositor.interface.new_socket(name='Image', in_out='OUTPUT', socket_type='NodeSocketColor')
render_layer = compositor.nodes.new('CompositorNodeRLayers')
glare = compositor.nodes.new('CompositorNodeGlare')
glare.inputs['Type'].default_value = 'Fog Glow'
glare.inputs['Quality'].default_value = 'High'
glare.inputs['Threshold'].default_value = 1.0
glare.inputs['Size'].default_value = .65
opaque = compositor.nodes.new('CompositorNodeSetAlpha')
opaque.inputs['Type'].default_value = 'Replace Alpha'
opaque.inputs['Alpha'].default_value = 1
output = compositor.nodes.new('NodeGroupOutput')
compositor.links.new(render_layer.outputs['Image'], glare.inputs['Image'])
compositor.links.new(glare.outputs['Glare'], opaque.inputs['Image'])
compositor.links.new(opaque.outputs['Image'], output.inputs['Image'])
compositor.use_fake_user = True
# Keep the node graph in the source, but normal scene renders output the surface.
if args.expressions_only:
    # Render from the owner-approved scene, never overwrite the frozen source.
    freeze = json.loads((SOURCE/'design-freeze.json').read_text())
    source_key = 'apps/desktop/art/cc-v1/cc-v1.blend'
    assert hashlib.sha256((SOURCE/'cc-v1.blend').read_bytes()).hexdigest() == freeze['sha256'][source_key], 'Frozen scene changed'
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE/'cc-v1.blend'))
    scene = bpy.context.scene
    scene.cycles.samples = args.samples
    camera = scene.camera
    parts = [bpy.data.objects[n] for n in ['Body','Foot.L','Foot.R','C']]
    c_obj = bpy.data.objects['C']
    eyes = [bpy.data.objects[n] for n in ['Eye.L','Eye.R']]
    light = bpy.data.materials['Light / soft ivory porcelain']
    light_c = bpy.data.materials['Light / C tube / restrained emission']
    dark = bpy.data.materials['Dark / matte charcoal / NO emission']
    black_eye = bpy.data.materials['Light eyes / ink']
    white_eye = bpy.data.materials['Dark eyes / camera-only unlit white']
    eye_matte_white = emission_material('Expression eye coverage white', (1,1,1,1))
    eye_matte_black = emission_material('Expression eye coverage black', (0,0,0,1))
    compositor = bpy.data.node_groups['CC / emission bloom']
    warm_bounce = bpy.data.objects['Light / internal warm bounce']
else:
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / 'cc-v1.blend'))

base_eyes = [(eye.location.copy(), [v.co.copy() for v in eye.data.vertices]) for eye in eyes]

def set_eyes(kind, scale):
    for eye, (location, vertices) in zip(eyes, base_eyes):
        eye.location = location.copy()
        eye.scale = (1, .65, scale)
        eye.scale.x = 1.18 if scale < .2 else 1
        for vertex, original in zip(eye.data.vertices, vertices):
            vertex.co = original
            if kind == 'crescent':
                vertex.co.x = original.z
                vertex.co.z = .045*(1-(original.z/.136)**2)+original.x*.35
        if kind == 'large':
            eye.scale.x = eye.scale.z = 1.15
        elif kind == 'look':
            eye.location.x += .07
            x, _, z = eye.location
            eye.location.y = -.94*math.sqrt(1-(x/1.12)**2-((z-.742)/.93)**2)-.013
        eye.data.update()

def render_pair(expression, pose='default', eye_scale=1, shared_entity=None, eye_kind='default', mask_name=None):
    set_pose(pose)
    set_eyes(eye_kind, eye_scale)
    bpy.context.view_layer.update()
    results = {}
    renders = {}
    bloom = None
    for form, surface, eye_mat in [('lit', light, black_eye), ('unlit', dark, white_eye)]:
        scene.view_settings.exposure = 0
        bpy.data.objects['Key / broad warm softbox'].data.energy = 110 if form == 'lit' else 180
        bpy.data.objects['Fill / cool front'].data.energy = 35 if form == 'lit' else 60
        bpy.data.objects['Rim / warm back'].data.energy = 220 if form == 'lit' else 550
        warm_bounce.data.energy = 0
        bpy.data.objects['Rim / left contour'].data.energy = 80 if form == 'lit' else 230
        bpy.data.objects['Rim / right contour'].data.energy = 60 if form == 'lit' else 180
        for obj in parts:
            obj.data.materials[0] = light_c if form == 'lit' and obj == c_obj else surface
        for obj in eyes:
            obj.data.materials[0] = eye_mat
        scene.render.filepath = str(SOURCE / (form + '-raw.png'))
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(scene.render.filepath, check_existing=False)
        # Byte-image pixels retain their display encoding; preserve the rendered RGB.
        values = np.array(img.pixels[:], dtype=np.float32).reshape(512, 512, 4)[::-1].copy()
        renders[form] = np.clip(values, 0, 1)
        bpy.data.images.remove(img)
        if expression == 'idle' and form == 'lit':
            png(SOURCE/(form+'-surface-only.png'), np.rint(renders[form]*255).astype(np.uint8))
        Path(scene.render.filepath).unlink()
        if form == 'lit':
            scene.compositing_node_group = compositor
            scene.render.image_settings.file_format = 'OPEN_EXR'
            scene.render.image_settings.color_depth = '32'
            scene.render.filepath = str(SOURCE / 'bloom.exr')
            bpy.ops.render.render(write_still=True)
            img = bpy.data.images.load(scene.render.filepath, check_existing=False)
            bloom = np.array(img.pixels[:], dtype=np.float32).reshape(512, 512, 4)[::-1, :, :3].copy()
            bpy.data.images.remove(img)
            Path(scene.render.filepath).unlink()
            scene.compositing_node_group = None
            scene.render.image_settings.file_format = 'PNG'
            scene.render.image_settings.color_depth = '8'

    # The dark eye shader contributes only to camera rays. A Standard-view coverage
    # pass avoids AgX compressing the requested display-white eyes to gray; body
    # occlusion and AA are rendered by the same camera, never hand-drawn masks.
    for obj in parts:
        obj.data.materials[0] = eye_matte_black
    for obj in eyes:
        obj.data.materials[0] = eye_matte_white
    scene.view_settings.view_transform = 'Standard'
    eye_file = SOURCE/'eye-coverage.png'
    eye_coverage = np.clip(read_render(eye_file)[:,:,:3],0,1)
    eye_file.unlink()
    scene.view_settings.view_transform = 'AgX'
    renders['unlit'][:,:,:3] = renders['unlit'][:,:,:3]*(1-eye_coverage)+eye_coverage
    for obj in parts:
        obj.data.materials[0] = light_c if obj == c_obj else light
    for obj in eyes:
        obj.data.materials[0] = black_eye

    # Quantize the opaque Dark coverage ONCE: shared entity mask, no effects.
    entity = np.rint(renders['unlit'][:,:,3]*255).astype(np.uint8)
    if shared_entity is not None:
        entity = shared_entity.copy()
    a = entity.astype(np.float32)/255
    opaque_core = entity >= 250
    y, x = np.mgrid[:512,:512]
    energy = np.maximum(bloom,0).mean(axis=2)
    halo = np.minimum(1-np.exp(-energy*5),.26)
    distance = np.where(a>.5,0.0,44.0)
    for _ in range(40):
        previous = distance
        candidates = [previous]
        for dx, dy in [(1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)]:
            candidates.append(np.roll(previous,(dy,dx),axis=(0,1))+math.hypot(dx,dy))
        distance = np.minimum.reduce(candidates)
    support = np.clip(1-distance/40,0,1)
    halo *= support*support*(3-2*support)
    assert halo[a<.01].max()>.05, 'No visible exterior HDR bloom'
    margin = np.minimum.reduce([x-80,431-x,y-28,469-y])
    fade = np.clip(margin/10,0,1)
    fade = fade*fade*(3-2*fade)
    halo *= fade
    # Contact shadow is optional. Dark uses no exterior effect at all, so a white
    # desktop cannot reveal the former shared dark halo as gray fog.
    shadow = np.exp(-((x-256)/94)**2-((y-459)/5.5)**2)*.22*fade
    for form, pixels in renders.items():
        form_halo = halo if form == 'lit' else np.zeros_like(halo)
        form_shadow = shadow if form == 'lit' else np.zeros_like(shadow)
        back_alpha = np.minimum(form_shadow+form_halo*(1-form_shadow),89/255)
        back_alpha[opaque_core] = 0
        combined = a+back_alpha*(1-a)
        alpha = np.maximum(entity,np.rint(combined*255).astype(np.uint8))
        alpha[opaque_core] = entity[opaque_core]
        alpha[entity==0] = np.minimum(alpha[entity==0],89)
        back_rgb = np.array((.12,.095,.065))*form_shadow[:,:,None]+np.array((1,.78,.43))*form_halo[:,:,None]*(1-form_shadow[:,:,None])
        back_rgb[opaque_core] = 0
        color = (pixels[:,:,:3]*a[:,:,None]+back_rgb*(1-a[:,:,None]))/np.maximum(combined[:,:,None],1e-8)
        rgba = np.zeros((512,512,4),dtype=np.uint8)
        rgba[:,:,:3] = np.rint(np.clip(color,0,1)*255).astype(np.uint8)
        rgba[:,:,3] = alpha
        rgba[alpha==0] = 0
        assert np.all(alpha>=entity)
        assert np.array_equal(alpha[opaque_core],entity[opaque_core])
        assert np.all(alpha[entity==0]<=89)
        assert np.all(alpha[(x<80)|(x>=432)|(y<28)|(y>=470)]==0), (form,bbox(alpha),[(int(xx),int(yy),int(alpha[yy,xx])) for yy,xx in zip(*np.where((alpha>0)&((x<80)|(x>=432)|(y<28)|(y>=470))))][:10])
        assert np.any(alpha[469]>0)
        if form == 'unlit':
            assert np.array_equal(alpha,entity), 'Dark must have no exterior haze'
            assert np.any(np.all(rgba[:,:,:3]==255,axis=2)&(entity==255)), 'Dark eyes must reach display white'
        destination = KIT/'canonical'/form/'front.png' if expression == 'idle' else KIT/'sprites'/form/(expression+'.png')
        png(destination,rgba)
        results[form] = rgba
    mask = np.full((512,512,4),255,dtype=np.uint8)
    mask[:,:,3] = entity
    mask[entity==0] = 0
    if mask_name is not None:
        png(KIT/'masks'/(mask_name+'.png'), mask)
    elif expression in ['idle','sleep']:
        png(KIT/'masks'/('front.png' if expression == 'idle' else 'sleep.png'),mask)
    print('CC_RENDER_PAIR',expression,pose,bbox(entity))
    return results, entity


if args.expressions_only:
    def existing_mask(name):
        img = bpy.data.images.load(str(KIT/'masks'/(name+'.png')), check_existing=False)
        alpha = np.array(img.pixels[:],dtype=np.float32).reshape(512,512,4)[::-1,:,3]
        bpy.data.images.remove(img)
        return np.rint(alpha*255).astype(np.uint8)

    masks = {'default': existing_mask('front'), 'listening': existing_mask('listening')}
    performances = [
        ('thinking','listening','default',.12),
        ('working','listening','default',1),
        ('done','happy','crescent',1),
        ('receive','happy','large',1),
        ('permission','confused','default',1),
        ('error','excited','large',1),
        ('look','default','look',1),
        ('drag','excited','default',1),
    ]
    for behavior, pose, eye_kind, eye_scale in performances:
        if args.behavior and behavior != args.behavior:
            continue
        _, coverage = render_pair(behavior, pose, eye_scale, masks.get(pose), eye_kind,
                                  None if pose in masks else pose)
        masks[pose] = coverage
    print('CC_EXPRESSIONS:', args.behavior or 'all paired performances', '; frozen canonical and transitions untouched')
else:
    canonical, entity = render_pair('idle')
    for form in ['lit','unlit']:
        rest = KIT/'sprites'/form/'rest.png'
        rest.parent.mkdir(parents=True,exist_ok=True)
        rest.write_bytes((KIT/'canonical'/form/'front.png').read_bytes())
    render_pair('blink-half', eye_scale=.48, shared_entity=entity)
    render_pair('blink-closed', eye_scale=.12, shared_entity=entity)
    render_pair('sleep', pose='low', eye_scale=.12)

    # Eight endpoint-inclusive frames, interpolated in premultiplied linear-light RGBA.
    # Transparent pixels cannot introduce dark fringes. Endpoints keep exact bytes.
    def to_linear(rgb):
        return np.where(rgb<=.04045,rgb/12.92,((rgb+.055)/1.055)**2.4)


    def to_srgb(rgb):
        return np.where(rgb<=.0031308,rgb*12.92,1.055*np.maximum(rgb,0)**(1/2.4)-.055)


    start, end = [canonical[f].astype(np.float64)/255 for f in ['unlit','lit']]
    transition_dir = KIT/'transitions/dark-to-light'
    transition_dir.mkdir(parents=True,exist_ok=True)
    for i in range(8):
        destination = transition_dir/f'{i:03}.png'
        if i in [0,7]:
            form = 'unlit' if i == 0 else 'lit'
            destination.write_bytes((KIT/'canonical'/form/'front.png').read_bytes())
            continue
        t = i/7
        alpha = start[:,:,3]*(1-t)+end[:,:,3]*t
        premul = to_linear(start[:,:,:3])*start[:,:,3,None]*(1-t)+to_linear(end[:,:,:3])*end[:,:,3,None]*t
        rgb = to_srgb(premul/np.maximum(alpha[:,:,None],1e-12))
        rgba = np.rint(np.clip(np.dstack((rgb,alpha)),0,1)*255).astype(np.uint8)
        rgba[rgba[:,:,3]==0] = 0
        assert np.all(rgba[:,:,3]>=entity)
        assert np.array_equal(rgba[:,:,3][entity>=250],entity[entity>=250])
        assert np.all(rgba[:,:,3][entity==0]<=89)
        png(destination,rgba)
    print('CC_CONTINUOUS: canonical + half/closed blink + low-C sleep + 8 transitions')
