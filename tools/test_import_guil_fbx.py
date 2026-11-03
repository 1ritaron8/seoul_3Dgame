"""Offline contract tests. Stub success is not a real UE import test."""
import shutil
import hashlib
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
from import_guil_fbx import GROUP_REPORT, ORIGINAL_BUILDING, SOURCES, import_assets, validate_sources


class Object:
    def __init__(self):
        self.values = {}

    def set_editor_property(self, key, value):
        self.values[key] = value

    def get_editor_property(self, key):
        if key == "static_mesh_import_data":
            return self.values.setdefault(key, Object())
        return self.values[key]


class Stub:
    FBXImportType = SimpleNamespace(FBXIT_STATIC_MESH="static")
    FbxImportUI = AssetImportTask = FbxFactory = Object

    def __init__(self, occupied=False, outcome="success"):
        self.tasks = []
        self.assets = set()
        self.outcome = outcome
        self.EditorAssetLibrary = SimpleNamespace(
            does_directory_exist=lambda path: occupied,
            does_asset_exist=lambda path: path in self.assets,
        )
        self.AssetToolsHelpers = SimpleNamespace(get_asset_tools=lambda: self)

    def log(self, message):
        pass

    def import_asset_tasks(self, tasks):
        self.tasks = tasks
        if self.outcome == "exception":
            raise RuntimeError("simulated importer failure")
        for task in tasks:
            path = task.values["destination_path"] + "/Mesh.Mesh"
            paths = [] if self.outcome == "empty" else [path]
            task.values["imported_object_paths"] = paths
            self.assets.update(paths)


class ImportTests(unittest.TestCase):
    def setUp(self):
        # Keep all fixtures and automatic cleanup within this tool's directory.
        tool_root = Path(__file__).resolve().parent
        self.root = tool_root / ("fixture_" + uuid4().hex)
        self.root.mkdir()
        assert self.root.resolve().parent == tool_root
        self.addCleanup(shutil.rmtree, self.root)
        for _, source in SOURCES:
            file = self.root / source
            file.parent.mkdir(parents=True)
            file.write_bytes(b"stub fixture; not a real FBX")
        original = self.root / ORIGINAL_BUILDING
        original.write_bytes(b"original fixture; not a real FBX")
        grouped = self.root / SOURCES[1][1]
        report = {
            "status": "PASS_BLENDER_REIMPORT_NOT_UE_VERIFIED",
            "source_fbx_sha256": hashlib.sha256(original.read_bytes()).hexdigest(),
            "grouped_fbx_sha256": hashlib.sha256(grouped.read_bytes()).hexdigest(),
            "output_mesh_count": 2,
            "groups_after_reimport": [{"material_slot_count": 48}, {"material_slot_count": 47}],
        }
        (self.root / GROUP_REPORT).write_text(json.dumps(report), encoding="utf-8")

    def test_success_and_safety_contract(self):
        ue = Stub()
        paths = import_assets(self.root, ue)
        self.assertEqual(len(paths), 2)
        for task in ue.tasks:
            self.assertFalse(task.values["replace_existing"])
            self.assertFalse(task.values["replace_existing_settings"])
            self.assertFalse(task.values["async_"])
            self.assertTrue(task.values["options"].values["import_materials"])
            self.assertTrue(task.values["options"].values["import_textures"])
            mesh = task.values["options"].values["static_mesh_import_data"].values
            self.assertTrue(mesh["transform_vertex_to_absolute"])
            self.assertEqual(mesh["import_uniform_scale"], 1.0)
            self.assertFalse(mesh["auto_generate_collision"])
        self.assertTrue(ue.tasks[0].values["options"].values["static_mesh_import_data"].values["combine_meshes"])
        self.assertFalse(ue.tasks[1].values["options"].values["static_mesh_import_data"].values["combine_meshes"])

    def test_missing_second_file_prevents_all_imports(self):
        (self.root / SOURCES[1][1]).unlink()
        ue = Stub()
        with self.assertRaises(FileNotFoundError):
            import_assets(self.root, ue)
        self.assertEqual(ue.tasks, [])

    def test_empty_file(self):
        (self.root / SOURCES[0][1]).write_bytes(b"")
        with self.assertRaises(ValueError):
            validate_sources(self.root)

    def test_existing_destination_aborts(self):
        ue = Stub(occupied=True)
        with self.assertRaisesRegex(RuntimeError, "Refusing existing"):
            import_assets(self.root, ue)
        self.assertEqual(ue.tasks, [])

    def test_failure_reports_partial_assets(self):
        for outcome in ("empty", "exception"):
            with self.subTest(outcome=outcome):
                with self.assertRaisesRegex(RuntimeError, "partial assets may remain"):
                    import_assets(self.root, Stub(outcome=outcome))

    def test_repeated_runs_have_separate_destinations(self):
        first, second = Stub(), Stub()
        self.assertNotEqual(import_assets(self.root, first), import_assets(self.root, second))

    def test_missing_root(self):
        with self.assertRaises(FileNotFoundError):
            validate_sources(self.root / "missing")

    def test_stale_grouping_stops_before_import(self):
        (self.root / SOURCES[1][1]).write_bytes(b"modified grouped data")
        ue = Stub()
        with self.assertRaisesRegex(ValueError, "differs from"):
            import_assets(self.root, ue)
        self.assertEqual(ue.tasks, [])

    def test_too_many_materials_stops_before_import(self):
        report_path = self.root / GROUP_REPORT
        report = json.loads(report_path.read_text(encoding="utf-8"))
        report["groups_after_reimport"][0]["material_slot_count"] = 65
        report_path.write_text(json.dumps(report), encoding="utf-8")
        ue = Stub()
        with self.assertRaisesRegex(ValueError, "material limit"):
            import_assets(self.root, ue)
        self.assertEqual(ue.tasks, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
