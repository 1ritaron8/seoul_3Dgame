"""Run after opening guil-street.blend with Blender in background mode."""
import bpy

meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if len(meshes) != 3:
    raise ValueError("Street Blender scene does not contain exactly 3 meshes")
for expected in ("GuilRoad_Stylized", "GuilWalkway_Stylized"):
    image = bpy.data.images.get(expected)
    if image is None or image.packed_file is None or not image.filepath.startswith("//"):
        raise ValueError("Packed image missing or not relative: " + expected)
print("BLEND_QA_OK", len(meshes), "meshes; 2 packed relative textures")
