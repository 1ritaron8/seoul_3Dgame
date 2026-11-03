"""Round-trip both FBXs and render QA views without modifying the deliverables."""
from pathlib import Path
import json
import math
import re
import sys

import bpy
from io_scene_fbx import parse_fbx
from mathutils import Vector
sys.path.insert(0, str(Path(__file__).resolve().parent))
from street_geometry import clip_polygon_to_rect, signed_area

STAIR_MASK = (-19.10, -10.10, -13.90, -6.50)


def fbx_axes(path):
    root, version = parse_fbx.parse(str(path))
    settings = next(e for e in root.elems if e.id == b"GlobalSettings")
    properties = next(e for e in settings.elems if e.id == b"Properties70")
    wanted = {b"UpAxis", b"UpAxisSign", b"FrontAxis", b"FrontAxisSign", b"CoordAxis", b"CoordAxisSign", b"UnitScaleFactor"}
    result = {e.props[0].decode("ascii"): e.props[4] for e in properties.elems if e.id == b"P" and e.props[0] in wanted}
    if len(result) != len(wanted):
        raise ValueError("Missing FBX axis/unit metadata: " + str(path))
    return result


def mesh_bounds(objects):
    pts = [o.matrix_world @ Vector(corner) for o in objects if o.type == "MESH" for corner in o.bound_box]
    if not pts:
        raise ValueError("No mesh bounds")
    return {"min": [min(p[i] for p in pts) for i in range(3)], "max": [max(p[i] for p in pts) for i in range(3)]}


def assert_bounds(actual, expected, tolerance=0.02):
    for side in ("min", "max"):
        for index in range(3):
            if abs(actual[side][index] - expected[side][index]) > tolerance:
                raise ValueError(f"Bounds mismatch {side}[{index}]: {actual} vs {expected}")


def aim(camera, target):
    camera.rotation_euler = (Vector(target) - camera.location).to_track_quat("-Z", "Y").to_euler()


def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(args) != 4:
        raise ValueError("Expected -- STREET.fbx SHINYEONG.fbx SHINYEONG_ROUNDTRIP.json OUTPUT_DIR")
    street_path, building_path, model_report, out_path = map(lambda x: Path(x).resolve(), args)
    out_path.mkdir(parents=True, exist_ok=True)
    for filename in ("street_first_person_preview.png", "street_top_preview.png", "qa_blender_roundtrip.json"):
        if (out_path / filename).exists():
            raise FileExistsError("Choose an empty QA output directory: " + str(out_path / filename))
    if re.search(rb"[A-Za-z]:[\\/]+Users[\\/]", street_path.read_bytes(), re.IGNORECASE):
        raise ValueError("Street FBX contains an absolute user-directory path")
    street_axes, building_axes = fbx_axes(street_path), fbx_axes(building_path)
    if street_axes != building_axes:
        raise ValueError(f"Street and reference FBX axis/unit metadata differ: {street_axes} vs {building_axes}")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(street_path), use_image_search=False)
    street_objects = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if len(street_objects) != 3:
        raise ValueError(f"Expected 3 street meshes, got {len(street_objects)}")
    street_bounds = mesh_bounds(street_objects)
    assert_bounds(street_bounds, {"min": [-65.0, -55.0, -0.12], "max": [55.0, 55.0, 0.12]})
    street_images = {im.name: im for im in bpy.data.images}
    for expected in ("GuilRoad_Stylized", "GuilWalkway_Stylized"):
        if expected not in street_images or tuple(street_images[expected].size) != (256, 256) or street_images[expected].packed_file is None:
            raise ValueError("Missing or unpacked street texture: " + expected)
    for material_name in ("M_RoadCorridor_Draft", "M_Walkway_Draft"):
        mat = bpy.data.materials.get(material_name)
        if mat is None or mat.node_tree is None or not any(n.type == "TEX_IMAGE" and n.image for n in mat.node_tree.nodes):
            raise ValueError("Street material is missing its image node: " + material_name)
    existing = set(bpy.context.scene.objects)
    bpy.ops.import_scene.fbx(filepath=str(building_path), use_image_search=False)
    building_objects = [o for o in bpy.context.scene.objects if o not in existing and o.type == "MESH"]
    if len(building_objects) != 1206:
        raise ValueError(f"Expected 1206 reference building meshes, got {len(building_objects)}")
    building_bounds = mesh_bounds(building_objects)
    model = json.loads(model_report.read_text(encoding="utf-8"))
    assert_bounds(building_bounds, model["fbxReimport"]["boundsM"])
    below = []
    for obj in building_objects:
        bounds = mesh_bounds([obj])
        if bounds["min"][2] < -0.15:
            below.append(obj.name)
            if not (STAIR_MASK[0] <= bounds["min"][0] and bounds["max"][0] <= STAIR_MASK[2]
                    and STAIR_MASK[1] <= bounds["min"][1] and bounds["max"][1] <= STAIR_MASK[3]):
                raise ValueError("Reference below-grade object outside reserved opening: " + obj.name)
    if not below:
        raise ValueError("No below-grade reference geometry found")
    vertical_uv_faces = 0
    top_face_count = 0
    for obj in street_objects:
        uv_layer = obj.data.uv_layers.active
        for polygon in obj.data.polygons:
            points = [(obj.matrix_world @ obj.data.vertices[i].co) for i in polygon.vertices]
            xy = [(p.x, p.y) for p in points]
            world_normal = (obj.matrix_world.to_3x3().inverted().transposed() @ polygon.normal).normalized()
            if abs(world_normal.z) > 0.9:
                if world_normal.z < 0.999:
                    raise ValueError("Street top face normal points away from up: " + obj.name)
                if abs(signed_area(xy)) < 1e-8:
                    raise ValueError("Street top face has zero projected area: " + obj.name)
                top_face_count += 1
                overlap = clip_polygon_to_rect(xy, STAIR_MASK)
                if overlap and abs(signed_area(overlap)) > 1e-5:
                    raise ValueError("Street surface covers reference basement access: " + obj.name)
            elif abs(world_normal.z) < 0.01 and obj.name.startswith("GUIL_Walkway"):
                if uv_layer is None:
                    raise ValueError("Sidewalk has no UV layer")
                uvs = [tuple(uv_layer.data[i].uv) for i in polygon.loop_indices]
                if abs(signed_area(uvs)) < 1e-10:
                    raise ValueError("Sidewalk vertical face has degenerate UVs")
                vertical_uv_faces += 1
            else:
                raise ValueError("Unexpected tilted face in street surface: " + obj.name)
    if vertical_uv_faces == 0:
        raise ValueError("Expected visible sidewalk edge faces")

    bpy.ops.object.camera_add(location=(-42, -4, 1.65))
    camera = bpy.context.object
    camera.name = "QA_Camera"
    camera.data.lens = 25
    aim(camera, (-12, 0, 6.0))
    scene = bpy.context.scene
    scene.camera = camera
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "BOTH"
    scene.display.shading.background_type = "WORLD"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("QA_World")
    scene.world.color = (0.68, 0.75, 0.79)
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(out_path / "street_first_person_preview.png")
    bpy.ops.render.render(write_still=True)

    camera.location = (-8, 0, 160)
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 125
    aim(camera, (-8, 0, 0))
    scene.render.filepath = str(out_path / "street_top_preview.png")
    bpy.ops.render.render(write_still=True)

    report = {"streetMeshes": len(street_objects), "streetBoundsM": street_bounds, "shinyeongMeshes": len(building_objects), "shinyeongBoundsM": building_bounds,
        "fbxAxisAndUnitMetadataMatch": True, "fbxAxisAndUnitMetadata": street_axes, "streetPackedTextureImages": ["GuilRoad_Stylized", "GuilWalkway_Stylized"], "referenceBelowGradeMeshes": len(below), "stairMaskUncovered": True, "sidewalkVerticalUvFaces": vertical_uv_faces, "upwardTopFaces": top_face_count,
        "checked": "FBX import and model bounds in Blender; not UE import, collision or a measured 2026 survey"}
    (out_path / "qa_blender_roundtrip.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print("QA_REPORT", json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
