"""Pure contracts for nonruntime CC study renders; no Blender import or IO on import."""
import ast
import copy
import hashlib
import math
from pathlib import Path, PurePosixPath


def views():
    result = [{'id': f'yaw-{round(i*225):04d}', 'yaw': i*22.5, 'pitch': 0,
               'family': 'horizontal', 'label': f'{i*22.5:g}°'} for i in range(16)]
    for name, yaw, pitch in [('front-up-15', 0, 15), ('front-up-30', 0, 30),
                             ('front-left-up-15', 315, 15), ('front-left-up-30', 315, 30)]:
        result.append({'id': name, 'yaw': yaw, 'pitch': pitch, 'family': 'elevation',
                       'label': f'{yaw:g}° / +{pitch:g}°'})
    return result


def orbit(yaw, pitch, scale):
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in [yaw, pitch, scale]):
        raise ValueError('Camera parameters must be finite numbers')
    if not 0 <= yaw < 360 or not -45 <= pitch <= 45 or scale < 3.85:
        raise ValueError('Camera parameters exceed the registered study envelope')
    theta, phi = math.radians(yaw), math.radians(pitch)
    direction = [math.sin(theta)*math.cos(phi), -math.cos(theta)*math.cos(phi), math.sin(phi)]
    target = [0, 0, 1.65]
    return {'location': [target[i]+10.5*direction[i] for i in range(3)], 'target': target, 'scale': scale}


def _inside(root, path):
    try: path.relative_to(root); return True
    except ValueError: return False


def guard_output(output, protected):
    output = Path(output).resolve()
    for original in protected:
        original = Path(original).resolve()
        if _inside(original, output) or _inside(output, original):
            raise ValueError(f'Study output overlaps protected input: {original}')
    return output


def _asset(root, name):
    if not isinstance(name, str) or not name or '\\' in name or '\0' in name:
        raise ValueError('Invalid study asset path')
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or str(path) != name:
        raise ValueError('Study asset path is not a normalized relative path')
    destination = (root/name).resolve()
    if not _inside(root, destination) or destination == root:
        raise ValueError('Study asset leaves its output root')
    return destination


def sample_is_complete(root, entry, parameters, paths):
    root = Path(root).resolve()
    if not isinstance(entry, dict) or entry.get('parameters') != parameters: return False
    if entry.get('paths') != paths or not isinstance(entry.get('files'), dict): return False
    if set(entry['files']) != set(paths) or len(paths) != len(set(paths)): return False
    for name in paths:
        path = _asset(root, name)
        if not path.is_file(): return False
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry['files'][name]: return False
    return True


def validate_bootstrap(plan, checkpoint, kit, identity):
    if checkpoint.get('identity') != identity: raise ValueError('Frozen bootstrap identity changed')
    expected = {}
    for clip in plan['clips']:
        for index, parameters in enumerate(clip['frames']):
            key = f"{clip['id']}/{index:03d}"
            paths = [f'motion/{form}/{key}.png' for form in ['lit', 'unlit']] + [f'masks/motion/{key}.png']
            expected[key] = (parameters, paths)
    if not expected or set(checkpoint.get('samples', {})) != set(expected):
        raise ValueError('Complete original motion batch required before study bootstrap')
    for key, (parameters, paths) in expected.items():
        if not sample_is_complete(kit, checkpoint['samples'][key], parameters, paths):
            raise ValueError(f'Frozen bootstrap sample is missing or damaged: {key}')


def derive_render_pair(source, context):
    module = ast.parse(source)
    candidates = [n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == 'render_pair']
    if len(candidates) != 1: raise ValueError('Expected one frozen render_pair function')
    function = copy.deepcopy(candidates[0])
    eye_checks = [n for n in ast.walk(function) if isinstance(n, ast.Assert)
                  and isinstance(n.msg, ast.Constant) and n.msg.value == 'Dark eyes must reach display white']
    shadows = [n for n in ast.walk(function) if isinstance(n, ast.Assign)
               and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) and n.targets[0].id == 'shadow']
    if len(eye_checks) != 1 or len(shadows) != 1:
        raise ValueError('Frozen eye/shadow contract changed; review adapter before rendering')
    if any(a.arg == 'visible_eyes_required' for a in function.args.args + function.args.kwonlyargs):
        raise ValueError('Frozen function already defines study eye policy')
    function.args.kwonlyargs.append(ast.arg(arg='visible_eyes_required'))
    function.args.kw_defaults.append(ast.Constant(value=True))
    eye_checks[0].test = ast.BoolOp(op=ast.Or(), values=[
        ast.UnaryOp(op=ast.Not(), operand=ast.Name(id='visible_eyes_required', ctx=ast.Load())), eye_checks[0].test])
    shadows[0].value = ast.Call(func=ast.Attribute(value=ast.Name(id='np', ctx=ast.Load()), attr='zeros_like', ctx=ast.Load()),
                               args=[ast.Name(id='a', ctx=ast.Load())], keywords=[])
    derived = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
    scope = dict(context)
    exec(compile(derived, '<frozen-cc-study-adapter>', 'exec'), scope)
    return scope['render_pair']
