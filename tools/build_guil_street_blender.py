"""Build the 2025-based Guil street draft. Run with Blender's Python, not system Python."""
from pathlib import Path
from array import array
import json
import math
import random
import sys

import bpy
from mathutils import Vector
from mathutils.geometry import tessellate_polygon

sys.path.insert(0, str(Path(__file__).resolve().parent))
from street_geometry import clean_ring, clip_polygon_to_rect, clip_segment_to_rect, horizontal_intervals, signed_area, subtract_intervals

# Bounds of the below-ground steps in the retained reference FBX, plus visual
# clearance. This is an asset-intersection mask, not a measured stairwell.
REFERENCE_STAIR_MASK_M = (-19.10, -10.10, -13.90, -6.50)

def parse_args():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(args) != 2:
        raise ValueError("Expected -- INPUT_REFERENCE_JSON OUTPUT_DIRECTORY")
    return Path(args[0]).resolve(), Path(args[1]).resolve()


def make_texture(name, output, mode):
    width = height = 256
    image = bpy.data.images.new(name, width=width, height=height, alpha=False)
    rng = random.Random(20261103 if mode == "walkway" else 20251103)
    values = array("f")
    tile_offsets = [[rng.uniform(-0.025, 0.025) for _ in range(8)] for _ in range(8)]
    for y in range(height):
        for x in range(width):
            if mode == "walkway":
                grout = x % 32 in (0, 1) or y % 32 in (0, 1)
                base = (0.52, 0.50, 0.45) if grout else (0.70, 0.68, 0.61)
                variation = tile_offsets[y // 32][x // 32] + rng.uniform(-0.008, 0.008)
            else:
                base = (0.30, 0.33, 0.34)
                variation = rng.uniform(-0.018, 0.018)
            values.extend((*(max(0.0, min(1.0, c + variation)) for c in base), 1.0))
    image.pixels.foreach_set(values)
    image.filepath_raw = str(output)
    image.file_format = "PNG"
    image.save()
    image.pack()
    image.filepath = "//" + output.name
    return image


def make_material(name, color, image=None):
    material = bpy.data.materials.new(name)
    material.diffuse_color = (*color, 1.0)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    shader = nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1.0)
    shader.inputs["Roughness"].default_value = 0.95
    if image:
        texture = nodes.new("ShaderNodeTexImage")
        texture.image = image
        texture.extension = "REPEAT"
        material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    return material


def build_surface(name, features, bounds, z_top, material, sides=False, side_material=None):
    vertices, faces = [], []
    side_flags = []
    clipped_area = 0.0
    source_area = 0.0
    used = []
    for feature in features:
        ring = clean_ring(feature["ring_m"])
        vectors = [Vector((x, y, 0.0)) for x, y in ring]
        triangles = tessellate_polygon([vectors])
        if not triangles:
            raise ValueError("Could not triangulate " + feature["id"])
        polygon_area = abs(signed_area(ring))
        tessellated_area = sum(abs(signed_area([ring[a], ring[b], ring[c]])) for a, b, c in triangles)
        if abs(polygon_area - tessellated_area) > max(0.03, polygon_area * 0.00002):
            raise ValueError(f"Triangulated area does not match source for {feature['id']}: {polygon_area} vs {tessellated_area}")
        source_area += polygon_area
        before = len(faces)
        for ia, ib, ic in triangles:
            clipped = clip_polygon_to_rect([ring[ia], ring[ib], ring[ic]], bounds)
            if not clipped:
                continue
            if signed_area(clipped) < 0:
                clipped.reverse()
            for index in range(1, len(clipped) - 1):
                triangle = [clipped[0], clipped[index], clipped[index + 1]]
                area = abs(signed_area(triangle))
                if area < 1e-7:
                    continue
                start = len(vertices)
                vertices.extend((x, y, z_top) for x, y in triangle)
                faces.append((start, start + 1, start + 2))
                side_flags.append(False)
                clipped_area += area
        if len(faces) > before:
            used.append(feature["id"])
        if sides:
            for a, b in zip(ring, ring[1:] + ring[:1]):
                segment = clip_segment_to_rect(a, b, bounds)
                if not segment:
                    continue
                a2, b2 = segment
                start = len(vertices)
                vertices.extend([(a2[0], a2[1], 0.0), (b2[0], b2[1], 0.0), (b2[0], b2[1], z_top), (a2[0], a2[1], z_top)])
                faces.append((start, start + 1, start + 2, start + 3))
                side_flags.append(True)
    if not faces:
        raise ValueError("No clipped geometry for " + name)
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    if mesh.validate(verbose=False):
        raise ValueError("Mesh required correction: " + name)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    if sides:
        if side_material is None:
            raise ValueError("A separate side material is required")
        obj.data.materials.append(side_material)
    uv_layer = mesh.uv_layers.new(name="PlanarMetres")
    for polygon in mesh.polygons:
        if side_flags[polygon.index]:
            polygon.material_index = 1
            loop_indices = list(polygon.loop_indices)
            first = mesh.vertices[mesh.loops[loop_indices[0]].vertex_index].co
            second = mesh.vertices[mesh.loops[loop_indices[1]].vertex_index].co
            distance = (second - first).length / 2.4
            for loop_index, uv in zip(loop_indices, [(0, 0), (distance, 0), (distance, z_top / 2.4), (0, z_top / 2.4)]):
                uv_layer.data[loop_index].uv = uv
        else:
            for loop_index in polygon.loop_indices:
                vertex = mesh.vertices[mesh.loops[loop_index].vertex_index].co
                uv_layer.data[loop_index].uv = (vertex.x / 2.4, vertex.y / 2.4)
    return obj, {"source_feature_ids": used, "source_area_m2_including_outside_clip": round(source_area, 4), "clipped_top_area_m2": round(clipped_area, 4), "mesh_faces": len(mesh.polygons), "mesh_vertices": len(mesh.vertices)}


def make_unknown_ground(bounds, material):
    xmin, ymin, xmax, ymax = bounds
    hx0, hy0, hx1, hy1 = REFERENCE_STAIR_MASK_M
    if not xmin < hx0 < hx1 < xmax or not ymin < hy0 < hy1 < ymax:
        raise ValueError("Reference stair mask is outside the pilot bounds")
    mesh = bpy.data.meshes.new("GUIL_UnknownGround_Mesh")
    vertices, faces = [], []
    for x0, y0, x1, y1 in ((xmin, ymin, hx0, ymax), (hx1, ymin, xmax, ymax), (hx0, ymin, hx1, hy0), (hx0, hy1, hx1, ymax)):
        offset = len(vertices)
        vertices.extend([(x0, y0, -0.12), (x1, y0, -0.12), (x1, y1, -0.12), (x0, y1, -0.12)])
        faces.append((offset, offset + 1, offset + 2, offset + 3))
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("GUIL_UnknownGround_Placeholder", mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    return obj


def assert_open_reference_stair_mask(objects):
    for obj in objects:
        for polygon in obj.data.polygons:
            if len(polygon.vertices) < 3:
                continue
            points = [(obj.data.vertices[i].co.x, obj.data.vertices[i].co.y) for i in polygon.vertices]
            if abs(signed_area(points)) < 1e-8:  # vertical edge faces
                continue
            overlap = clip_polygon_to_rect(points, REFERENCE_STAIR_MASK_M)
            if overlap and abs(signed_area(overlap)) > 1e-5:
                raise ValueError(f"{obj.name} occludes the retained model's stair mask")


def main():
    source, output = parse_args()
    data = json.loads(source.read_text(encoding="utf-8"))
    if data["source_dataset_year"] != 2025 or data["source_plan_sha256"] != "f4081a9a33fa0f622ce7174fce5f2a3381291c5fba8d5c152a9e609f87ad7f43":
        raise ValueError("Unexpected source date or map alignment")
    if data.get("shared_origin_local_m") != [748.20765, 763.5115] or data.get("axes") != "x east, y north, z up; metres":
        raise ValueError("Reference origin, axes, or unit do not match the Shinyeong model")
    bounds = tuple(data["clip_bounds_m"])
    if bounds != (-65.0, -55.0, 55.0, 55.0):
        raise ValueError("Unexpected pilot bounds")
    output.mkdir(parents=True, exist_ok=True)
    for name in ("T_GuilRoad.png", "T_GuilWalkway.png", "street_build_report.json", "guil-street.blend", "guil-street.fbx"):
        if (output / name).exists():
            raise FileExistsError("Output exists; choose an empty output directory to preserve manual edits: " + str(output / name))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0

    road_image = make_texture("GuilRoad_Stylized", output / "T_GuilRoad.png", "road")
    walk_image = make_texture("GuilWalkway_Stylized", output / "T_GuilWalkway.png", "walkway")
    road_material = make_material("M_RoadCorridor_Draft", (0.30, 0.33, 0.34), road_image)
    walk_material = make_material("M_Walkway_Draft", (0.70, 0.68, 0.61), walk_image)
    edge_material = make_material("M_WalkwayEdge_Draft", (0.52, 0.50, 0.45))
    ground_material = make_material("M_UnknownGround_Placeholder", (0.48, 0.52, 0.47))

    road_features = [f for f in data["features"] if f["kind"] == "road_corridor"]
    walk_features = [f for f in data["features"] if f["kind"] == "walkway"]
    road, road_report = build_surface("GUIL_RoadCorridor_2025_Draft", road_features, bounds, 0.0, road_material)
    walkway, walkway_report = build_surface("GUIL_Walkway_2025_Draft", walk_features, bounds, 0.12, walk_material, sides=True, side_material=edge_material)
    ground = make_unknown_ground(bounds, ground_material)
    assert_open_reference_stair_mask((road, walkway, ground))

    corridor_sections = [interval for f in road_features for interval in horizontal_intervals(clean_ring(f["ring_m"]), 0.0)]
    walkway_sections = [interval for f in walk_features for interval in horizontal_intervals(clean_ring(f["ring_m"]), 0.0)]
    candidate_sections = subtract_intervals(corridor_sections, walkway_sections)
    report = {
        "source_dataset_year": 2025,
        "shared_origin_local_m": data["shared_origin_local_m"],
        "source_plan_sha256": data["source_plan_sha256"],
        "clip_bounds_m": list(bounds),
        "blender_version": bpy.app.version_string,
        "fbx_export_axes": {"forward": "-Y", "up": "Z", "note": "Matches global axis metadata of the retained Shinyeong reference FBX; UE conversion still requires validation."},
        "road_corridor": road_report,
        "walkway": walkway_report,
        "cross_section_at_north_offset_0_m": {
            "corridor_intervals_east_m": corridor_sections,
            "walkway_intervals_east_m": walkway_sections,
            "remaining_candidate_intervals_east_m": candidate_sections,
            "limitation": "A single east-west intersection of 2025 polygons; not a perpendicular width measurement or 2026 road survey."
        },
        "assumed_walkway_height_m": 0.12,
        "unknown_ground_z_m": -0.12,
        "reference_model_stair_mask_m": list(REFERENCE_STAIR_MASK_M),
        "limitations": data["limitations"] + ["Road corridor contains sidewalk polygons; raised sidewalk covers it visually and the reported area includes sidewalks.", "Sidewalk is an open surface, not a closed curb solid or a validated collider.", "Ground has a rectangular visual clearance based on the old model's below-grade geometry, not a surveyed stairwell.", "Collisions, axis conversion, material appearance and placement in UE have not been tested."],
    }
    (output / "street_build_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")

    bpy.ops.object.select_all(action="DESELECT")
    for obj in (ground, road, walkway):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = road
    # Blender's FBX exporter otherwise writes absolute user paths for packed
    # textures. Supply relative filenames and export before saving the .blend,
    # so the FBX's ApplicationNativeFile field is also empty.
    from io_scene_fbx import export_fbx_bin
    if not hasattr(export_fbx_bin, "_gen_vid_path"):
        raise RuntimeError("Unsupported Blender FBX exporter: cannot safely remove absolute texture paths")
    original_path_generator = export_fbx_bin._gen_vid_path
    def relative_texture_path(image, _scene_data):
        filename = image.filepath.replace("\\", "/").split("/")[-1]
        if not filename:
            raise ValueError("Missing packed image filename")
        return filename, filename
    export_fbx_bin._gen_vid_path = relative_texture_path
    try:
        bpy.ops.export_scene.fbx(filepath=str(output / "guil-street.fbx"), use_selection=True,
            object_types={"MESH"}, axis_forward="-Y", axis_up="Z", global_scale=1.0,
            apply_unit_scale=True, bake_space_transform=False, add_leaf_bones=False,
            path_mode="COPY", embed_textures=True)
    finally:
        export_fbx_bin._gen_vid_path = original_path_generator
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "guil-street.blend"), compress=True)
    print("STREET_BUILD_REPORT", json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
