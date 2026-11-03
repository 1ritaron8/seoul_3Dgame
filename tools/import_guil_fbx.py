"""Run explicitly inside UE5 Editor; imports new assets, never edits levels."""
from pathlib import Path
import hashlib
import json
from uuid import uuid4


SOURCES = (
    ("StreetDraft", "exports/guil-street-ue5/guil-street.fbx"),
    ("ShinyeongReference", "exports/shinyeong-ue5-transfer/shinyeong-v13-ue-groups.fbx"),
)
ORIGINAL_BUILDING = "exports/shinyeong-ue5-transfer/shinyeong-v13.fbx"
GROUP_REPORT = "exports/shinyeong-ue5-transfer/grouping-verification.json"


def _safe_file(root, relative):
    path = (root / relative).resolve(strict=True)
    if not path.is_relative_to(root):
        raise ValueError(f"Source escapes repository: {relative}")
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError(f"Expected a nonempty file: {path}")
    return path


def _sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def validate_sources(repo_root):
    root = Path(repo_root).resolve(strict=True)
    result = []
    for name, relative in SOURCES:
        source = _safe_file(root, relative)
        if source.suffix.lower() != ".fbx":
            raise ValueError(f"Expected a nonempty FBX file: {source}")
        result.append((name, source))
    original = _safe_file(root, ORIGINAL_BUILDING)
    report_path = _safe_file(root, GROUP_REPORT)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    groups = report.get("groups_after_reimport", [])
    if report.get("status") != "PASS_BLENDER_REIMPORT_NOT_UE_VERIFIED":
        raise ValueError("Shinyeong grouping report is not a successful Blender verification")
    if (report.get("source_fbx_sha256") != _sha256(original)
            or report.get("grouped_fbx_sha256") != _sha256(result[1][1])):
        raise ValueError("Shinyeong FBX differs from the grouping verification report")
    if (not groups or report.get("output_mesh_count") != len(groups)
            or any(not isinstance(g.get("material_slot_count"), int) or not 1 <= g["material_slot_count"] <= 48 for g in groups)):
        raise ValueError("Shinyeong groups exceed the verified per-mesh material limit")
    return result


def import_assets(repo_root, unreal_module=None):
    # Validate BOTH files before any editor mutation.
    sources = validate_sources(repo_root)
    if unreal_module is None:
        try:
            import unreal as unreal_module
        except ImportError as exc:
            raise RuntimeError("Run this script inside UE5 Editor with Python Editor Script Plugin enabled.") from exc
    ue = unreal_module
    destination = "/Game/GuilImports/Run_" + uuid4().hex
    if ue.EditorAssetLibrary.does_directory_exist(destination):
        raise RuntimeError(f"Refusing existing destination: {destination}")
    tasks = []
    for name, source in sources:
        options = ue.FbxImportUI()
        for key, value in {
            "automated_import_should_detect_type": False,
            "mesh_type_to_import": ue.FBXImportType.FBXIT_STATIC_MESH,
            "import_mesh": True, "import_as_skeletal": False,
            "import_animations": False, "import_materials": True,
            "import_textures": True,
        }.items():
            options.set_editor_property(key, value)
        mesh_data = options.get_editor_property("static_mesh_import_data")
        for key, value in {
            # Shinyeong is deliberately split into groups under the UE material
            # limit; combining them again would recreate the import failure.
            "combine_meshes": name == "StreetDraft", "auto_generate_collision": False,
            "transform_vertex_to_absolute": True, "bake_pivot_in_vertex": False,
            "convert_scene": True, "convert_scene_unit": True,
            "import_uniform_scale": 1.0,
        }.items():
            mesh_data.set_editor_property(key, value)
        task = ue.AssetImportTask()
        for key, value in {
            "filename": str(source), "destination_path": destination + "/" + name,
            "destination_name": name, "automated": True, "async_": False,
            "replace_existing": False, "replace_existing_settings": False,
            "save": True, "options": options, "factory": ue.FbxFactory(),
        }.items():
            task.set_editor_property(key, value)
        tasks.append(task)
    try:
        ue.AssetToolsHelpers.get_asset_tools().import_asset_tasks(tasks)
        paths = []
        for task in tasks:
            imported = list(task.get_editor_property("imported_object_paths"))
            if not imported:
                raise RuntimeError("An FBX produced no imported object paths.")
            for asset_path in imported:
                if not asset_path.startswith(destination + "/"):
                    raise RuntimeError(f"Unexpected import destination: {asset_path}")
                if not ue.EditorAssetLibrary.does_asset_exist(asset_path):
                    raise RuntimeError(f"Imported asset cannot be found: {asset_path}")
            paths.extend(imported)
    except Exception as exc:
        raise RuntimeError(
            f"Import failed. New partial assets may remain in {destination}; inspect Output Log. "
            "No cleanup or overwrite was attempted. " + str(exc)
        ) from exc
    ue.log("Imported new FBX assets: " + ", ".join(paths))
    ue.log("No level changed. Placement, materials, collision, scale/alignment and first-person play require editor verification.")
    return paths


if __name__ == "__main__":
    root_argument = globals().get("REPO_ROOT")
    if not root_argument:
        raise RuntimeError("Set REPO_ROOT with runpy.run_path(..., init_globals={'REPO_ROOT': r'...'}).")
    import_assets(root_argument)
