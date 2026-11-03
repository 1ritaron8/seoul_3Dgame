"""Check source provenance and observed geometry without a 3D engine."""
from pathlib import Path
import json
import unittest

from street_geometry import clean_ring, horizontal_intervals, signed_area, subtract_intervals

SOURCE = Path(__file__).resolve().parents[1] / "exports/guil-street-ue5/street_reference_2025.json"


class StreetReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads(SOURCE.read_text(encoding="utf-8"))

    def test_source_and_coordinate_contract(self):
        self.assertEqual(self.data["source_dataset_year"], 2025)
        self.assertEqual(self.data["source_dataset_scale"], "1:1000")
        self.assertEqual(self.data["shared_origin_local_m"], [748.20765, 763.5115])
        self.assertEqual(self.data["axes"], "x east, y north, z up; metres")
        self.assertEqual(self.data["clip_bounds_m"], [-65.0, -55.0, 55.0, 55.0])
        self.assertEqual(self.data["source_plan_sha256"], "f4081a9a33fa0f622ce7174fce5f2a3381291c5fba8d5c152a9e609f87ad7f43")

    def test_unique_supported_valid_geometry(self):
        features = self.data["features"]
        self.assertEqual(len(features), 10)
        self.assertEqual(len({f["id"] for f in features}), len(features))
        self.assertEqual({f["kind"] for f in features}, {"road_corridor", "walkway"})
        for feature in features:
            with self.subTest(feature=feature["id"]):
                self.assertGreater(abs(signed_area(clean_ring(feature["ring_m"]))), 0.01)

    def test_observed_road_corridor_includes_walkways(self):
        corridor, walkways = [], []
        for feature in self.data["features"]:
            sections = horizontal_intervals(clean_ring(feature["ring_m"]), 0.0)
            (corridor if feature["kind"] == "road_corridor" else walkways).extend(sections)
        remaining = subtract_intervals(corridor, walkways)
        self.assertEqual(len(remaining), 1)
        # A single axis-aligned section; not an official or general road-width measurement.
        self.assertAlmostEqual(remaining[0][1] - remaining[0][0], 12.020926, places=4)


if __name__ == "__main__":
    unittest.main()
