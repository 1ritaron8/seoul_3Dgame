"""Offline tests for the measured route, UE query adapters, and curb handling."""
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import build_shinyeong_walk as build


class Hit:
    # The real UE5.6 HitResult does not expose documented editor properties.
    def __init__(self, blocking=True):
        self.point = object()
        self.values = (blocking, False, .5, 10, object(), self.point, object(), object())

    def to_tuple(self):
        return self.values


class AdapterTests(unittest.TestCase):
    def test_native_hit_result_break(self):
        hit = Hit()
        self.assertIs(build._hit_location(hit), hit.point)
        self.assertIsNone(build._hit_location(Hit(False)))
        self.assertIsNone(build._hit_location(None))

    def test_pawn_queries_use_native_profiles_and_simple_collision(self):
        system = SimpleNamespace(line_trace_single_by_profile=Mock(return_value=None),
                                 capsule_trace_single_by_profile=Mock(return_value=None))
        ue = SimpleNamespace(SystemLibrary=system, Vector=lambda *args: args,
                             DrawDebugTrace=SimpleNamespace(NONE='none'))
        build._trace(ue, 'world', (0, 1, 2), (3, 4, 5))
        self.assertEqual(system.line_trace_single_by_profile.call_args.args,
                         ('world', (0, 1, 2), (3, 4, 5), 'Pawn', False, [], 'none', True))
        build._capsule_trace(ue, 'world', (0, 1, 2), (0, 1, 3), 42, 96)
        self.assertEqual(system.capsule_trace_single_by_profile.call_args.args,
                         ('world', (0, 1, 2), (0, 1, 3), 42, 96, 'Pawn', False, [], 'none', True))

    def test_real_assets_and_project_reference_the_same_verified_walk(self):
        root = Path(build.__file__).resolve().parents[1]
        route = build.read_route(root)
        source = route['source_bounds_m']
        # Synthetic Editor result: Unreal X=-north, Y=east, with 0.3 cm of bounds noise.
        observed = {}
        for name, bounds in source.items():
            lo, hi = bounds['min'], bounds['max']
            observed[name] = {'min': [-100*hi[1]+.3, 100*lo[0], 100*lo[2]],
                              'max': [-100*lo[1]+.3, 100*hi[0], 100*hi[2]]}
        transform = build.detect_transform(source, observed)
        self.assertEqual(build.transform_point((1, 2, 3), transform), (-200, 100, 300))
        observed['StreetDraft']['max'][2] += 50
        with self.assertRaises(RuntimeError):
            build.detect_transform(source, observed)
        project = root / 'Guil2026'
        descriptor = json.loads((project / 'Guil2026.uproject').read_text(encoding='utf-8'))
        self.assertTrue({'EnhancedInput', 'PythonScriptPlugin', 'EditorScriptingUtilities'} <=
                        {item['Name'] for item in descriptor['Plugins'] if item['Enabled']})
        self.assertIn('GameDefaultMap=' + build.LEVEL_PATH,
                      (project / 'Config/DefaultEngine.ini').read_text(encoding='utf-8'))

    def test_symmetric_bounds_cannot_choose_a_facing_direction(self):
        bounds = {'model': {'min': [-1,-1,0], 'max': [1,1,2]}}
        actual = {'model': {'min': [-100,-100,0], 'max': [100,100,200]}}
        with self.assertRaises(RuntimeError):
            build.detect_transform(bounds, actual)


class StepTests(unittest.TestCase):
    @staticmethod
    def floor_z(x):
        return 0 if x < 36 else 24

    @staticmethod
    def hit(x, y, z, center_z):
        point = SimpleNamespace(x=x, y=y, z=z)
        center = SimpleNamespace(x=x, y=y, z=center_z)
        normal = SimpleNamespace(x=0, y=0, z=1)
        return SimpleNamespace(to_tuple=lambda: (True, False, 0., 0., center, point, normal, normal))

    def walk(self, step_height=45, wall=False):
        # Independent two-level fixture: the road stays flat all the way to x=36.
        points = [('road', (0, 0, 0)), ('walkway', (120, 0, 24))]
        def line(ue, world, start, end):
            x, y = start[:2]
            return self.hit(x, y, self.floor_z(x), self.floor_z(x))
        def sweep(ue, world, start, end, radius, half):
            x, y = start[:2]
            z = self.floor_z(x)
            if start[:2] == end[:2] and end[2] <= z + half <= start[2]:
                return self.hit(x, y, z, z + half)
            if start[0] < 36 <= end[0] and (wall or start[2] < 24 + half):
                return self.hit(36, y, 24, half)
            return None
        with patch.object(build, '_trace', side_effect=line), patch.object(build, '_capsule_trace', side_effect=sweep):
            return build._check_walk(None, None, points, 42, 96, step_height, .7)

    def test_curb_uses_the_characters_step_clearance(self):
        result = self.walk()
        self.assertEqual(result['waypoint_floor_cm'], {'road': 0, 'walkway': 24})
        self.assertEqual(result['clear_step_alternatives'], 1)
        self.assertGreaterEqual(result['capsule_samples'], 5)

    def test_short_step_height_and_full_height_wall_are_blocked(self):
        with self.assertRaisesRegex(RuntimeError, 'step height'):
            self.walk(step_height=20)
        with self.assertRaisesRegex(RuntimeError, 'capsule blocked'):
            self.walk(wall=True)


if __name__ == '__main__':
    unittest.main()
