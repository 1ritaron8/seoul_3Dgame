"""Offline illustrative render; existing building remains an unverified visual reference."""
from pathlib import Path
import sys
import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(args) != 3:
    raise ValueError("Expected -- STREET.fbx SHINYEONG.fbx OUTPUT.png")
street, building, output = [Path(arg).resolve() for arg in args]
if output.exists():
    raise FileExistsError("Choose a new preview path: " + str(output))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=str(street), use_image_search=False)
bpy.ops.import_scene.fbx(filepath=str(building), use_image_search=False)
scene = bpy.context.scene
world = bpy.data.worlds.new("PreviewWorld")
world.use_nodes = True
background = world.node_tree.nodes.get("Background")
background.inputs["Color"].default_value = (0.68, 0.79, 0.92, 1.0)
background.inputs["Strength"].default_value = 0.65
scene.world = world

bpy.ops.object.light_add(type="SUN", location=(-30, -25, 60))
sun = bpy.context.object
sun.data.energy = 2.0
sun.rotation_euler = (0.45, -0.45, -0.3)
bpy.ops.object.camera_add(location=(-43.0, -3.5, 1.65))
camera = bpy.context.object
camera.rotation_euler = (Vector((-14, 0, 8.0)) - camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.lens = 19
scene.camera = camera
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 1024
scene.render.resolution_y = 576
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(output)
bpy.ops.render.render(write_still=True)
print("PREVIEW_SAVED", str(output))
