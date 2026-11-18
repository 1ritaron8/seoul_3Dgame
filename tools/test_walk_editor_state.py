"""Exercise editor map switching and retries with a marked test file in an isolated directory."""
from pathlib import Path
import math
from types import SimpleNamespace
from uuid import uuid4
import unittest
from unittest.mock import Mock, patch

import build_shinyeong_walk as build

ORIGINAL = '/Game/User/Unmodified'
TARGET = '/Game/GuilWalk/ShinyeongWalk'


class PlayerStart:
    def __init__(self, tagged):
        self.actor_has_tag = Mock(return_value=tagged)


class StateTests(unittest.TestCase):
    def setUp(self):
        # tempfile's Windows mode=0700 creates unreadable ACLs in this sandbox.
        self.root = Path(__file__).resolve().parent / ('walk_state_' + uuid4().hex)
        self.root.mkdir()
        self.addCleanup(self.clean_owned_files)
        self.current = ORIGINAL
        self.editor = SimpleNamespace(
            is_in_play_in_editor=Mock(return_value=False), load_level=Mock(side_effect=self.load),
            get_current_level=lambda: SimpleNamespace(get_outer=lambda: SimpleNamespace(
                get_path_name=lambda: self.current + '.World')))
        self.actors = SimpleNamespace(get_all_level_actors=Mock(return_value=[]),
                                      spawn_actor_from_class=Mock())
        self.io = SimpleNamespace(get_dirty_map_packages=Mock(return_value=[]),
                                  new_blank_map=Mock(side_effect=self.blank), save_map=Mock())
        self.ue = SimpleNamespace(
            LevelEditorSubsystem='level', EditorActorSubsystem='actor', StaticMeshEditorSubsystem='mesh',
            PlayerStart=PlayerStart,
            get_editor_subsystem=lambda cls: self.editor if cls == 'level' else self.actors,
            EditorLoadingAndSavingUtils=self.io,
            Paths=SimpleNamespace(convert_relative_path_to_full=lambda p: p,
                                  project_content_dir=lambda: str(self.root),
                                  project_saved_dir=lambda: str(self.root / 'Saved')),
            log=Mock(), log_error=Mock(), log_warning=Mock())
        self.importer = SimpleNamespace(validate_sources=Mock(), import_assets=Mock(return_value=[]))
        self.patches = [patch.object(build, 'read_route', return_value={}),
                        patch.object(build, '_load_importer', return_value=self.importer),
                        patch.object(build, '_choose_game_mode', return_value=(
                            SimpleNamespace(get_path_name=lambda: '/Game/FirstPerson/Mode_C'),
                            96, 42, 45, .7))]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def clean_owned_files(self):
        self.assertEqual(self.root.parent, Path(__file__).resolve().parent)
        self.assertTrue(self.root.name.startswith('walk_state_'))
        for child in sorted(self.root.rglob('*'), key=lambda p: len(p.parts), reverse=True):
            child.rmdir() if child.is_dir() else child.unlink()
        self.root.rmdir()

    def load(self, path):
        self.current = path
        return True

    def blank(self, save_existing):
        self.assertFalse(save_existing)
        self.current = '/Temp/GeneratedWalk'
        return object()

    def run_build(self):
        return build.build_walk_level(self.root, unreal_module=self.ue)

    def assert_no_mutations(self):
        self.importer.import_assets.assert_not_called()
        self.io.new_blank_map.assert_not_called()
        self.io.save_map.assert_not_called()
        self.actors.spawn_actor_from_class.assert_not_called()

    def make_existing(self, tagged):
        path = self.root / 'GuilWalk/ShinyeongWalk.umap'
        path.parent.mkdir()
        path.write_bytes(b'USER_MAP_BYTES_MUST_SURVIVE')
        self.actors.get_all_level_actors.return_value = [PlayerStart(tagged)]
        return path

    def test_pie_refuses_without_import_new_map_save_or_load(self):
        self.editor.is_in_play_in_editor.return_value = True
        with self.assertRaises(RuntimeError):
            self.run_build()
        self.assert_no_mutations()
        self.editor.load_level.assert_not_called()
        self.assertEqual(self.current, ORIGINAL)

    def test_dirty_user_map_refuses_without_mutation(self):
        self.io.get_dirty_map_packages.return_value = [SimpleNamespace(get_name=lambda: ORIGINAL)]
        with self.assertRaises(RuntimeError):
            self.run_build()
        self.assert_no_mutations()
        self.editor.load_level.assert_not_called()
        self.assertEqual(self.current, ORIGINAL)

    def test_existing_complete_map_reopens_without_import_or_save(self):
        path = self.make_existing(True)
        result = self.run_build()
        self.assertEqual(result['status'], 'EXISTING_MAP_REOPENED_UNCHANGED')
        self.assertEqual(self.current, TARGET)
        self.assertEqual(path.read_bytes(), b'USER_MAP_BYTES_MUST_SURVIVE')
        self.assert_no_mutations()

    def test_unmarked_existing_map_preserves_bytes_and_restores_original(self):
        path = self.make_existing(False)
        with self.assertRaises(RuntimeError):
            self.run_build()
        self.assertEqual(path.read_bytes(), b'USER_MAP_BYTES_MUST_SURVIVE')
        self.assert_no_mutations()
        self.assertEqual(self.current, ORIGINAL)

    def test_failed_new_map_restores_original_without_saving_target(self):
        # Both FBX groups missing after a successful import/new-world transition.
        with self.assertRaisesRegex(RuntimeError, 'one street mesh and six'):
            self.run_build()
        self.importer.import_assets.assert_called_once()
        self.io.new_blank_map.assert_called_once_with(False)
        self.io.save_map.assert_not_called()
        self.assertEqual(self.current, ORIGINAL)
        self.assertFalse((self.root / 'GuilWalk/ShinyeongWalk.umap').exists())
        reports = list((self.root / 'Saved').glob('GuilWalk_*.json'))
        self.assertEqual(len(reports), 1)
        self.assertIn('FAILED', reports[0].read_text(encoding='utf-8'))

    def test_success_saves_a_marked_start_facing_the_front_and_the_selected_game_mode(self):
        start = (20., 10., .12)
        route = {'source_bounds_m': {}, 'eye_height_m': 1.65,
                 'waypoints': [{'id': 'opposite_sidewalk', 'position_m': start}],
                 'door_targets_m': {'front': (14., 12., 1.65)}}
        build.read_route.return_value = route
        mode = build._choose_game_mode.return_value[0]
        world = Mock()
        self.io.new_blank_map.side_effect = lambda save: world
        vector = lambda x, y, z: SimpleNamespace(x=x, y=y, z=z)
        self.ue.Vector = vector
        self.ue.Rotator = lambda **axes: SimpleNamespace(**axes)
        self.ue.DirectionalLight, self.ue.SkyLight, self.ue.SkyAtmosphere = 'sun', 'sky', 'air'
        self.ue.ComponentMobility = SimpleNamespace(MOVABLE='movable')
        player = Mock()

        def spawn(actor_class, location, rotation=None):
            if actor_class != PlayerStart:
                return Mock()
            angle = math.radians(rotation.yaw)
            player.get_actor_location.return_value = location
            player.get_actor_forward_vector.return_value = vector(math.cos(angle), math.sin(angle), 0.)
            return player

        def save(loaded_world, target):
            self.assertIs(loaded_world, world)
            self.assertEqual(target, TARGET)
            player.set_editor_property.assert_called_with('tags', [build.COMPLETE_TAG])
            world.get_world_settings().set_editor_property.assert_called_with('default_game_mode', mode)
            (self.root / 'GuilWalk/ShinyeongWalk.umap').write_bytes(b'NEW LEVEL')
            return True

        self.actors.spawn_actor_from_class.side_effect = spawn
        self.io.save_map.side_effect = save
        with (patch.object(build, '_place_meshes', return_value={'StreetDraft': [], 'ShinyeongReference': []}),
              patch.object(build, '_union_actor_bounds', return_value={}),
              patch.object(build, 'detect_transform', return_value={'order': (1,0,2), 'signs': (-1,1,1)}),
              patch.object(build, '_check_walk', return_value={'waypoint_floor_cm': {'opposite_sidewalk': 12}}),
              patch.object(build, '_check_door_views', return_value={}),
              patch.object(build, '_capsule_trace', return_value=None)):
            result = self.run_build()
        self.assertEqual(result['status'], 'BUILT_EDITOR_TRACES_PASS_PIE_NOT_VERIFIED')
        self.assertEqual(result['player_start_cm'], (-1000., 2000., 113.))
        self.assertAlmostEqual(result['player_yaw_degrees'], math.degrees(math.atan2(-600., -200.)))
        self.io.save_map.assert_called_once()

    def test_only_the_shipped_blank_editor_startup_map_is_updated(self):
        project = self.root / 'Guil2026'
        config = project / 'Config/DefaultEngine.ini'
        config.parent.mkdir(parents=True)
        original = (b'[/Script/EngineSettings.GameMapsSettings]\r\nEditorStartupMap=/Engine/Maps/Entry\r\n'
                    b'[ConsoleVariables]\r\nInterchange.FeatureFlags.Import.FBX=False\r\n')
        config.write_bytes(original)
        self.assertFalse(build._use_saved_level_on_startup(self.root, self.root / 'Other/Content'))
        self.assertEqual(config.read_bytes(), original)
        self.assertTrue(build._use_saved_level_on_startup(self.root, project / 'Content'))
        self.assertEqual(config.read_bytes(), original.replace(b'/Engine/Maps/Entry', TARGET.encode('ascii')))
        self.assertFalse(build._use_saved_level_on_startup(self.root, project / 'Content'))
        custom = original.replace(b'/Engine/Maps/Entry', b'/Game/User/MyOwnStart')
        config.write_bytes(custom)
        self.assertFalse(build._use_saved_level_on_startup(self.root, project / 'Content'))
        self.assertEqual(config.read_bytes(), custom)

    def test_competing_save_cannot_replace_the_winning_map(self):
        target = self.root / 'Content/GuilWalk/ShinyeongWalk.umap'
        def winning_save(world, level):
            with self.assertRaisesRegex(RuntimeError, 'Another editor'):
                build._save_new_map(self.ue, object(), target, self.root)
            target.write_bytes(b'FIRST MAP')
            return True
        self.io.save_map.side_effect = winning_save
        build._save_new_map(self.ue, object(), target, self.root)
        with self.assertRaisesRegex(RuntimeError, 'already exists'):
            build._save_new_map(self.ue, object(), target, self.root)
        self.io.save_map.assert_called_once()
        self.assertEqual(target.read_bytes(), b'FIRST MAP')


if __name__ == '__main__':
    unittest.main()
