"""Verify the street FBX and the six-mesh Shinyeong reference together in Blender."""
from pathlib import Path
import hashlib
import json
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from qa_street_blender import STAIR_MASK, assert_bounds, fbx_axes, mesh_bounds
from street_geometry import clip_polygon_to_rect, signed_area


def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(args) != 4:
        raise ValueError("Expected -- STREET.fbx GROUPED.fbx GROUP_REPORT.json OUTPUT.json")
    street_path, grouped_path, report_path, output_path = [Path(p).resolve() for p in args]
    if output_path.exists():
        raise FileExistsError("Choose a new QA report path")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if not report["status"].startswith("PASS"):
        raise ValueError("Building grouping report did not pass")
    if hashlib.sha256(grouped_path.read_bytes()).hexdigest() != report["grouped_fbx_sha256"]:
        raise ValueError("Grouped FBX differs from its verification report")
    if fbx_axes(street_path) != fbx_axes(grouped_path):
        raise ValueError("Street and grouped building FBX axes differ")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(street_path), use_image_search=False)
    street = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if len(street) != 3:
        raise ValueError("Expected three street meshes")
    assert_bounds(mesh_bounds(street), {"min": [-65, -55, -0.12], "max": [55, 55, 0.12]})
    existing = set(bpy.context.scene.objects)
    bpy.ops.import_scene.fbx(filepath=str(grouped_path), use_image_search=False)
    grouped = [o for o in bpy.context.scene.objects if o.type == "MESH" and o not in existing]
    if len(grouped) != 6 or any(len(o.data.materials) > 48 for o in grouped):
        raise ValueError("Building should have six meshes with at most 48 materials each")
    assert_bounds(mesh_bounds(grouped), {"min": [-20.3779392, -9.8755436, -1.825], "max": [24.1786995, 9.8894234, 18.26]})
    below = []
    for obj in grouped:
        for vertex in obj.data.vertices:
            point = obj.matrix_world @ vertex.co
            if point.z < -0.15:
                below.append(point)
                if not (STAIR_MASK[0] <= point.x <= STAIR_MASK[2] and STAIR_MASK[1] <= point.y <= STAIR_MASK[3]):
                    raise ValueError("Below-grade reference vertex is outside the stair opening")
    if not below:
        raise ValueError("No below-grade reference vertices found")
    for obj in street:
        for polygon in obj.data.polygons:
            xy = [(obj.matrix_world @ obj.data.vertices[i].co)[:2] for i in polygon.vertices]
            if abs(signed_area(xy)) < 1e-7:
                continue
            overlap = clip_polygon_to_rect(xy, STAIR_MASK)
            if overlap and abs(signed_area(overlap)) > 1e-5:
                raise ValueError("Street blocks the reference stair opening")
    result = {"street_meshes": len(street), "grouped_building_meshes": len(grouped), "material_slots": [len(o.data.materials) for o in grouped],
        "below_grade_vertices_in_opening": len(below), "shared_axes_verified_in_blender": True,
        "grouped_fbx_sha256": report["grouped_fbx_sha256"], "limitations": "Unreal import, collision, materials and FPS untested"}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print("GROUPED_STREET_QA", json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
