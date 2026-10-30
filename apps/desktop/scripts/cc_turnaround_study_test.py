import hashlib
import math
from pathlib import Path
import tempfile
import types
import unittest

from cc_turnaround_study import (
    derive_render_pair, guard_output, orbit, sample_is_complete,
    validate_bootstrap, views,
)


class Recipes(unittest.TestCase):
    def test_twenty_unique_views_have_sixteen_even_horizontal_angles(self):
        recipe = views()
        self.assertEqual(len(recipe), 20)
        self.assertEqual(len({v['id'] for v in recipe}), 20)
        self.assertEqual([v['yaw'] for v in recipe[:16]], [i * 22.5 for i in range(16)])
        self.assertTrue(all(v['pitch'] == 0 for v in recipe[:16]))
        self.assertEqual([(v['yaw'], v['pitch']) for v in recipe[16:]], [(0, 15), (0, 30), (315, 15), (315, 30)])

    def test_front_right_and_rear_are_real_model_axes(self):
        for yaw, expected in [(0, [0, -10.5, 1.65]), (90, [10.5, 0, 1.65]), (180, [0, 10.5, 1.65])]:
            actual = orbit(yaw, 0, 3.85)
            self.assertEqual(actual['target'], [0, 0, 1.65])
            for a, b in zip(actual['location'], expected): self.assertAlmostEqual(a, b)
            self.assertEqual(actual['scale'], 3.85)

    def test_pitch_preserves_radius_and_raises_camera(self):
        location = orbit(315, 30, 4.1)['location']
        self.assertGreater(location[2], 1.65)
        self.assertAlmostEqual(sum((a-b)**2 for a, b in zip(location, [0, 0, 1.65])), 10.5**2)

    def test_invalid_or_singular_camera_parameters_are_rejected(self):
        for values in [(math.nan, 0, 3.85), (0, math.inf, 3.85), (0, 90, 3.85), (0, -90, 3.85), (-1, 0, 3.85), (360, 0, 3.85), (0, 0, 3.84), (0, 0, math.inf)]:
            with self.subTest(values=values), self.assertRaises(ValueError): orbit(*values)


class OutputAndResume(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.kit = self.root/'runtime'; self.kit.mkdir()
        self.frozen = self.root/'art/frozen.blend'; self.frozen.parent.mkdir(); self.frozen.write_bytes(b'frozen')

    def test_new_sibling_study_output_is_allowed(self):
        output = self.root/'art/studies/new'
        self.assertEqual(guard_output(output, [self.kit, self.frozen]), output.resolve())
        self.assertFalse(output.exists())

    def test_protected_ancestor_descendant_and_symlink_outputs_are_rejected(self):
        alias = self.root/'alias'; alias.symlink_to(self.kit, target_is_directory=True)
        for output in [self.kit, self.kit/'new', self.root, self.frozen.parent, alias/'new']:
            with self.subTest(output=output), self.assertRaises(ValueError): guard_output(output, [self.kit, self.frozen])

    def test_resume_requires_exact_paths_parameters_and_actual_file_hashes(self):
        paths = ['motion/lit/front/000.png', 'motion/unlit/front/000.png', 'masks/front.png']
        files = {}
        for index, name in enumerate(paths):
            p = self.root/name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(bytes([index]))
            files[name] = hashlib.sha256(p.read_bytes()).hexdigest()
        parameters = {'yaw': 0, 'pitch': 0}
        entry = {'parameters': parameters, 'paths': paths, 'files': files}
        self.assertTrue(sample_is_complete(self.root, entry, parameters, paths))
        self.assertFalse(sample_is_complete(self.root, entry, {'yaw': 90, 'pitch': 0}, paths))
        self.assertFalse(sample_is_complete(self.root, {**entry, 'files': {}}, parameters, paths))
        self.assertFalse(sample_is_complete(self.root, {**entry, 'paths': paths[:2]}, parameters, paths))
        (self.root/paths[0]).write_bytes(b'corrupt')
        self.assertFalse(sample_is_complete(self.root, entry, parameters, paths))

    def test_resume_does_not_follow_an_asset_symlink_outside_output(self):
        external = self.root/'private'; external.write_bytes(b'outside')
        output = self.root/'output'; output.mkdir(); (output/'escaped.png').symlink_to(external)
        entry = {'parameters': {}, 'paths': ['escaped.png'], 'files': {'escaped.png': hashlib.sha256(b'outside').hexdigest()}}
        with self.assertRaises(ValueError): sample_is_complete(output, entry, {}, ['escaped.png'])

    def test_bootstrap_rejects_missing_maps_before_original_renderer_can_write(self):
        plan = {'clips': [{'id': 'done', 'frames': [{'pose': {}}]}]}
        identity = {'blender': '5.2.1 LTS', 'samples': 96}
        checkpoint = {'identity': identity, 'samples': {'done/000': {'parameters': {'pose': {}}, 'paths': [], 'files': {}}}}
        with self.assertRaises(ValueError): validate_bootstrap(plan, checkpoint, self.root, identity)
        with self.assertRaises(ValueError): validate_bootstrap(plan, {**checkpoint, 'identity': {'blender': 'wrong'}}, self.root, identity)

    def test_bootstrap_validates_all_three_expected_files_for_every_sample(self):
        parameters = {'pose': {}}
        plan = {'clips': [{'id': 'done', 'frames': [parameters]}]}
        paths = ['motion/lit/done/000.png', 'motion/unlit/done/000.png', 'masks/motion/done/000.png']
        files = {}
        for name in paths:
            p = self.root/name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(name.encode())
            files[name] = hashlib.sha256(p.read_bytes()).hexdigest()
        identity = {'blender': '5.2.1 LTS', 'samples': 96}
        checkpoint = {'identity': identity, 'samples': {'done/000': {'parameters': parameters, 'paths': paths, 'files': files}}}
        validate_bootstrap(plan, checkpoint, self.root, identity)
        (self.root/paths[2]).write_bytes(b'broken mask')
        with self.assertRaises(ValueError): validate_bootstrap(plan, checkpoint, self.root, identity)


SOURCE = '''
def render_pair(form, white, entity=1):
    a = entity
    shadow = 9
    if form == 'unlit':
        assert entity == 1, 'Dark must have no exterior haze'
        assert white, 'Dark eyes must reach display white'
    return shadow
'''


class StudyAdapter(unittest.TestCase):
    def test_back_can_occlude_eyes_but_front_still_requires_them(self):
        render = derive_render_pair(SOURCE, {'np': types.SimpleNamespace(zeros_like=lambda a: 0)})
        self.assertEqual(render('unlit', False, visible_eyes_required=False), 0)
        with self.assertRaisesRegex(AssertionError, 'eyes'): render('unlit', False)
        self.assertEqual(render('unlit', True), 0)

    def test_other_entity_assertions_remain_enforced(self):
        render = derive_render_pair(SOURCE, {'np': types.SimpleNamespace(zeros_like=lambda a: 0)})
        with self.assertRaisesRegex(AssertionError, 'exterior haze'):
            render('unlit', False, entity=0, visible_eyes_required=False)

    def test_unknown_or_duplicated_source_structure_fails_closed(self):
        for text in [SOURCE.replace('Dark eyes must reach display white', 'changed contract'), SOURCE.replace('    return shadow', "    assert white, 'Dark eyes must reach display white'\n    return shadow"), SOURCE.replace('    return shadow', '    shadow = 8\n    return shadow')]:
            with self.subTest(text=text), self.assertRaises(ValueError): derive_render_pair(text, {})


if __name__ == '__main__': unittest.main()
