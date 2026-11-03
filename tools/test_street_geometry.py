import unittest

from street_geometry import clean_ring, clip_polygon_to_rect, clip_segment_to_rect, horizontal_intervals, signed_area, subtract_intervals


class StreetGeometryTests(unittest.TestCase):
    def test_clean_ring_rejects_invalid_and_removes_duplicates(self):
        self.assertEqual(clean_ring([(0, 0), (2, 0), (2, 0), (0, 2), (0, 0)]), [(0, 0), (2, 0), (0, 2)])
        for ring in ([(0, 0), (1, 1), (2, 2)], [(0, 0), (1, 1), (float("nan"), 0)]):
            with self.assertRaises(ValueError):
                clean_ring(ring)

    def test_clipping_inside_outside_and_crossing(self):
        bounds = (0, 0, 1, 1)
        inside = [(0.1, 0.1), (0.8, 0.1), (0.1, 0.8)]
        self.assertAlmostEqual(abs(signed_area(clip_polygon_to_rect(inside, bounds))), abs(signed_area(inside)))
        self.assertEqual(clip_polygon_to_rect([(2, 2), (3, 2), (2, 3)], bounds), [])
        crossing = [(-1, 0.5), (2, 0.5), (0.5, 2)]
        clipped = clip_polygon_to_rect(crossing, bounds)
        self.assertAlmostEqual(abs(signed_area(clipped)), 0.5)
        self.assertTrue(all(0 <= x <= 1 and 0 <= y <= 1 for x, y in clipped))

    def test_horizontal_sections_exclude_both_walkways(self):
        corridor = [(-40, -1), (-20, -1), (-20, 1), (-40, 1)]
        walkways = [[(-40, -1), (-37, -1), (-37, 1), (-40, 1)], [(-25, -1), (-20, -1), (-20, 1), (-25, 1)]]
        base = horizontal_intervals(corridor, 0)
        cuts = [i for polygon in walkways for i in horizontal_intervals(polygon, 0)]
        self.assertEqual(subtract_intervals(base, cuts), [(-37.0, -25.0)])

    def test_invalid_bounds(self):
        with self.assertRaises(ValueError):
            clip_polygon_to_rect([(0, 0), (1, 0), (0, 1)], (1, 0, 0, 1))

    def test_segment_clipping(self):
        bounds = (0, 0, 1, 1)
        self.assertEqual(clip_segment_to_rect((-1, 0.5), (2, 0.5), bounds), ((0.0, 0.5), (1.0, 0.5)))
        self.assertIsNone(clip_segment_to_rect((-1, 2), (2, 2), bounds))
        self.assertEqual(clip_segment_to_rect((0.2, 0.2), (0.8, 0.8), bounds), ((0.2, 0.2), (0.8, 0.8)))


if __name__ == "__main__":
    unittest.main()
