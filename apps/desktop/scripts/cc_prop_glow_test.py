import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import unittest
import numpy as np
from cc_prop_glow import glow_alpha, composite_glow


class GlowSupport(unittest.TestCase):
    def fixture(self):
        body = np.zeros((96, 96), dtype=np.float32); body[40:56, 40:56] = 1
        hdr = np.full((96, 96, 3), .001, dtype=np.float32)
        pixels = np.zeros((96, 96, 4), dtype=np.float32)
        pixels[40:56, 40:56] = [1, .85, .50, 1]
        return body, hdr, pixels

    def test_weak_hdr_has_no_distant_rectangular_support_but_keeps_near_glow(self):
        body, hdr, _ = self.fixture(); halo = glow_alpha(hdr, body, radius=20)
        self.assertEqual(float(halo[20, 20]), 0)
        self.assertEqual(float(halo[18, 48]), 0)
        self.assertGreater(float(halo[38, 48]), 0)
        self.assertGreater(float(halo[30, 48]), 0)
        self.assertTrue(np.all(halo[:12] == 0)); self.assertTrue(np.all(halo[:, -12:] == 0))

    def test_composite_preserves_opaque_star_and_does_not_mutate_source(self):
        _, hdr, pixels = self.fixture(); original = pixels.copy()
        result = composite_glow(pixels, hdr, radius=20)
        np.testing.assert_array_equal(pixels, original)
        np.testing.assert_array_equal(result[40:56, 40:56], pixels[40:56, 40:56])
        self.assertTrue(np.all(result[result[:, :, 3] == 0] == 0))
        self.assertTrue(np.any((result[:, :, 3] > 0) & (pixels[:, :, 3] == 0)))

    def test_support_is_not_a_wraparound_image_border(self):
        body, hdr, _ = self.fixture(); body[:] = 0; body[20:30, 14:20] = 1
        halo = glow_alpha(hdr, body, radius=20)
        self.assertTrue(np.all(halo[:, 60:] == 0))
        self.assertGreater(float(halo[25, 22]), 0)

    def test_bad_or_empty_inputs_fail_instead_of_certifying_invisible_glow(self):
        body, hdr, pixels = self.fixture()
        for radius in [0, -1, 65, float('nan')]:
            with self.assertRaises(ValueError): glow_alpha(hdr, body, radius=radius)
        with self.assertRaises(ValueError): glow_alpha(hdr, body * 0)
        with self.assertRaises(ValueError): glow_alpha(hdr[:5], body)
        hdr[0, 0, 0] = np.nan
        with self.assertRaises(ValueError): composite_glow(pixels, hdr)


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(GlowSupport))
    if not result.wasSuccessful(): raise RuntimeError('Glow regression failed')
