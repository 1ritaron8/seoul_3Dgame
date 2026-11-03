"""Blender 5.2 offline material grouping, with independent FBX re-import checks.
Writes only inside this project. Does not save a .blend or copy the source FBX.
"""
import bpy
import hashlib
import json
import re
import argparse
import sys
from collections import Counter, defaultdict
from itertools import product
from math import floor
from pathlib import Path
from io_scene_fbx import parse_fbx, export_fbx_bin

ROOT = Path(__file__).resolve().parent.parent
POSITION_TOLERANCE_M = 0.00001


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fbx_info(path):
    tree, version = parse_fbx.parse(str(path))
    settings = next(n for n in tree.elems if n.id == b'GlobalSettings')
    settings = next(n for n in settings.elems if n.id == b'Properties70')
    settings = {n.props[0].decode(): n.props[-1] for n in settings.elems if n.id == b'P'}
    keys = ['UpAxis', 'UpAxisSign', 'FrontAxis', 'FrontAxisSign', 'CoordAxis', 'CoordAxisSign',
            'OriginalUpAxis', 'OriginalUpAxisSign', 'UnitScaleFactor', 'OriginalUnitScaleFactor']
    video = []
    absolute_strings = []
    def visit(node):
        for typ, prop in zip(node.props_type, node.props):
            if typ == ord('S') and isinstance(prop, bytes):
                # Only decoded string properties; embedded PNG bytes are not paths.
                text = prop.decode('utf-8', errors='replace')
                if re.search(r'(?:[A-Za-z]:[\\/]|\\\\|/Users/|/home/)', text):
                    absolute_strings.append(text)
        if node.id == b'Video':
            content = next((n.props[0] for n in node.elems if n.id == b'Content'), b'')
            video.append({'name': str(node.props[1]), 'embedded': bool(content),
                          'sha256': sha(content) if content else None})
        for child in node.elems:
            visit(child)
    visit(tree)
    return {'version': version, 'global_settings': {k: settings[k] for k in keys},
            'videos': video, 'absolute_strings': absolute_strings}


def image_hash(image):
    assert image.packed_file, ('Unpacked image cannot be verified', image.name)
    return sha(bytes(image.packed_file.data))


def bindings():
    result = {}
    for material in bpy.data.materials:
        images = []
        if material.use_nodes:
            images = sorted(image_hash(n.image) for n in material.node_tree.nodes
                            if n.type == 'TEX_IMAGE' and n.image)
        result[material.name] = images
    return result


def material_parameters():
    result = {}
    for material in bpy.data.materials:
        nodes = material.node_tree.nodes if material.node_tree else []
        principled = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
        assert principled, ('Expected Principled shader', material.name)
        parameters = {}
        for key in ('Base Color','Metallic','Roughness','Alpha','Emission Color','Emission Strength'):
            value = principled.inputs[key].default_value
            parameters[key] = list(value) if hasattr(value, '__len__') else [float(value)]
        result[material.name] = parameters
    return result


def snapshot():
    bpy.context.view_layer.update()
    triangles = Counter()
    by_material = Counter()
    # Round world-space position at 10 micrometers and UV at 1e-6 for stable signatures.
    points = []
    raw_triangles = []
    object_reports = []
    for obj in sorted((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: o.name):
        mesh = obj.data
        mesh.calc_loop_triangles()
        coords = [tuple(obj.matrix_world @ v.co) for v in mesh.vertices]
        points.extend(coords)
        local_counts = Counter()
        uv = mesh.uv_layers.active
        normal_matrix = obj.matrix_world.to_3x3().inverted().transposed()
        for tri in mesh.loop_triangles:
            material = mesh.materials[tri.material_index]
            assert material
            name = material.name
            corners = []
            raw_corners = []
            for vi, li in zip(tri.vertices, tri.loops):
                position = tuple(round(c / POSITION_TOLERANCE_M) for c in coords[vi])
                texcoord = tuple(round(float(c) * 1e6) for c in uv.data[li].uv) if uv else (0, 0)
                corners.append((position, texcoord))
                raw_corners.append((coords[vi], tuple(uv.data[li].uv) if uv else (0.0,0.0),
                                    tuple((normal_matrix @ mesh.corner_normals[li].vector).normalized())))
            # Cyclic canonicalization preserves winding while ignoring start vertex.
            rotations = [tuple(corners[i:] + corners[:i]) for i in range(3)]
            key = (name, min(rotations))
            triangles[key] += 1
            local_counts[key] += 1
            by_material[name] += 1
            raw_triangles.append((obj.name, name, raw_corners))
        bounds = [[min(p[i] for p in coords) for i in range(3)],
                  [max(p[i] for p in coords) for i in range(3)]]
        object_reports.append({'name': obj.name, 'bounds_m': bounds,
                               'triangles': sum(local_counts.values()),
                               'signature_counts': local_counts})
    return {'counter': triangles, 'raw_triangles':raw_triangles, 'material_triangles': dict(sorted(by_material.items())),
            'bounds_m': [[min(p[i] for p in points) for i in range(3)],
                         [max(p[i] for p in points) for i in range(3)]],
            'objects': object_reports, 'triangle_count': sum(triangles.values()),
            'material_image_hashes': bindings(), 'material_parameters':material_parameters()}


def verify_snapshots(before, after):
    assert before['material_triangles'] == after['material_triangles'], 'Material triangle counts changed'
    assert before['material_image_hashes'] == after['material_image_hashes'], 'Texture bindings changed'
    max_material_error = 0.0
    assert before['material_parameters'].keys() == after['material_parameters'].keys()
    for name, parameters in before['material_parameters'].items():
        for key, values in parameters.items():
            error = max(abs(a-b) for a,b in zip(values,after['material_parameters'][name][key]))
            assert error <= 1e-5, ('Material parameter changed', name,key,values,after['material_parameters'][name][key])
            max_material_error = max(max_material_error,error)
    # Neighboring spatial cells prevent false failures at quantization boundaries.
    def cell(corners):
        return tuple(floor(sum(c[0][axis] for c in corners)/3 / POSITION_TOLERANCE_M) for axis in range(3))
    buckets = defaultdict(list)
    for index, (_, material, corners) in enumerate(after['raw_triangles']):
        buckets[(material, cell(corners))].append(index)
    used = set()
    matched_points = defaultdict(list)
    max_position_error = max_uv_error = max_normal_error = 0.0
    for object_name, material, corners in before['raw_triangles']:
        location = cell(corners)
        match = None
        for delta in product((-1,0,1), repeat=3):
            key = (material, tuple(location[i]+delta[i] for i in range(3)))
            for index in buckets.get(key, []):
                if index in used:
                    continue
                candidate = after['raw_triangles'][index][2]
                for shift in range(3):
                    rotated = candidate[shift:] + candidate[:shift]
                    position_error = max(abs(a[0][i]-b[0][i]) for a,b in zip(corners,rotated) for i in range(3))
                    uv_error = max(abs(a[1][i]-b[1][i]) for a,b in zip(corners,rotated) for i in range(2))
                    normal_error = max(abs(a[2][i]-b[2][i]) for a,b in zip(corners,rotated) for i in range(3))
                    if position_error <= POSITION_TOLERANCE_M and uv_error <= 1e-6 and normal_error <= 0.0005:
                        match = (index, rotated, position_error, uv_error, normal_error)
                        break
                if match:
                    break
            if match:
                break
        assert match, ('Unmatched world triangle/UV/winding/normal', object_name, material, corners)
        index, rotated, pe, ue, ne = match
        used.add(index)
        matched_points[object_name].extend(c[0] for c in rotated)
        max_position_error = max(max_position_error, pe)
        max_uv_error = max(max_uv_error, ue)
        max_normal_error = max(max_normal_error, ne)
    assert len(used) == len(after['raw_triangles']) == len(before['raw_triangles'])
    segments = []
    for original in before['objects']:
        points = matched_points[original['name']]
        bounds = [[min(p[i] for p in points) for i in range(3)], [max(p[i] for p in points) for i in range(3)]]
        error = max(abs(a-b) for ba,bb in zip(bounds, original['bounds_m']) for a,b in zip(ba,bb))
        assert error <= POSITION_TOLERANCE_M, ('Segment bounds changed', original['name'], error)
        segments.append({'name':original['name'], 'source_bounds_m':original['bounds_m'],
                         'matched_output_bounds_m':bounds, 'max_bounds_error_m':error,
                         'triangles':original['triangles'], 'all_triangles_matched':True})
    bounds_error = max(abs(a-b) for ba, bb in zip(before['bounds_m'], after['bounds_m']) for a,b in zip(ba,bb))
    assert bounds_error <= POSITION_TOLERANCE_M, ('Bounds changed', bounds_error)
    return {'max_bounds_error_m':bounds_error, 'max_position_component_error_m':max_position_error,
            'max_uv_component_error':max_uv_error,'max_normal_component_error':max_normal_error,
            'max_material_parameter_error':max_material_error,
            'segments':segments}


def main():
    source_hash = sha(SOURCE.read_bytes())
    source_info = fbx_info(SOURCE)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    assert bpy.ops.import_scene.fbx(filepath=str(SOURCE), use_image_search=False) == {'FINISHED'}
    before = snapshot()
    source_meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    assert len(source_meshes) == 1206
    assert all(len(o.data.materials) == 1 for o in source_meshes), 'Expected single-material input meshes'
    materials = sorted({o.data.materials[0] for o in source_meshes}, key=lambda m: m.name)
    assert len(materials) == 287
    material_members = {m: [o for o in source_meshes if o.data.materials[0] == m] for m in materials}
    for number, start in enumerate(range(0, len(materials), 48), 1):
        batch = materials[start:start+48]
        members = [o for material in batch for o in material_members[material]]
        name = f'Shinyeong_Group_{number:02d}'
        vertices, faces, face_materials, loop_uvs, loop_normals, smooth = [], [], [], [], [], []
        for member in members:
            mesh = member.data
            assert not mesh.color_attributes, 'Color attributes need an explicit preservation path'
            mesh.calc_loop_triangles()
            offset = len(vertices)
            vertices.extend(tuple(member.matrix_world @ vertex.co) for vertex in mesh.vertices)
            uv_layer = mesh.uv_layers.active
            normal_matrix = member.matrix_world.to_3x3().inverted().transposed()
            material_index = batch.index(mesh.materials[0])
            for triangle in mesh.loop_triangles:
                faces.append(tuple(offset + vertex for vertex in triangle.vertices))
                face_materials.append(material_index)
                smooth.append(mesh.polygons[triangle.polygon_index].use_smooth)
                for loop in triangle.loops:
                    loop_uvs.append(tuple(uv_layer.data[loop].uv) if uv_layer else (0.0,0.0))
                    loop_normals.append(tuple((normal_matrix @ mesh.corner_normals[loop].vector).normalized()))
        new_mesh = bpy.data.meshes.new(name)
        new_mesh.from_pydata(vertices, [], faces)
        for material in batch:
            new_mesh.materials.append(material)
        uv_layer = new_mesh.uv_layers.new(name='UVMap')
        for loop, uv in zip(uv_layer.data, loop_uvs):
            loop.uv = uv
        for polygon, material_index, use_smooth in zip(new_mesh.polygons, face_materials, smooth):
            polygon.material_index = material_index
            polygon.use_smooth = use_smooth
        new_mesh.normals_split_custom_set(loop_normals)
        new_mesh.update()
        group = bpy.data.objects.new(name, new_mesh)
        bpy.context.collection.objects.link(group)
        for member in members:
            bpy.data.objects.remove(member, do_unlink=True)
        assert len(group.data.materials) <= 48
    combined = snapshot()
    memory_validation = verify_snapshots(before, combined)
    # Packed bytes are embedded directly; only portable hash-based paths enter FBX.
    original_path_function = export_fbx_bin._gen_vid_path
    def portable_video_path(image, scene_data):
        # Each Video gets its own path so the exporter embeds even duplicate content.
        portable_name = re.sub(r'[^A-Za-z0-9_.-]', '_', image.name)
        relative = 'textures/' + image_hash(image) + '_' + portable_name + '.png'
        return relative, relative
    export_fbx_bin._gen_vid_path = portable_video_path
    try:
        # Reserve a NEW file exclusively. FBX export then writes only this reserved file.
        with OUTPUT.open('xb'):
            pass
        bpy.context.scene.unit_settings.system = 'METRIC'
        bpy.context.scene.unit_settings.scale_length = 1.0
        bpy.ops.object.select_all(action='DESELECT')
        for obj in bpy.data.objects:
            if obj.type == 'MESH':
                obj.select_set(True)
        assert bpy.ops.export_scene.fbx(filepath=str(OUTPUT), use_selection=True, object_types={'MESH'},
            axis_forward='-Y', axis_up='Z', global_scale=1.0, apply_unit_scale=True,
            apply_scale_options='FBX_SCALE_NONE', use_mesh_modifiers=False, bake_anim=False,
            mesh_smooth_type='FACE', path_mode='COPY', embed_textures=True,
            use_custom_props=False, add_leaf_bones=False) == {'FINISHED'}
    finally:
        export_fbx_bin._gen_vid_path = original_path_function
    output_info = fbx_info(OUTPUT)
    assert source_info['global_settings'] == output_info['global_settings'], 'FBX axes or units changed'
    assert not output_info['absolute_strings'], 'Absolute machine path leaked into FBX'
    source_texture_hashes = {v['sha256'] for v in source_info['videos'] if v['embedded']}
    output_texture_hashes = {v['sha256'] for v in output_info['videos'] if v['embedded']}
    assert source_texture_hashes == output_texture_hashes, 'Embedded image bytes changed or missing'
    assert all(v['embedded'] for v in output_info['videos']), 'An exported Video is not embedded'
    bpy.ops.wm.read_factory_settings(use_empty=True)
    assert bpy.ops.import_scene.fbx(filepath=str(OUTPUT), use_image_search=False) == {'FINISHED'}
    after = snapshot()
    validation = verify_snapshots(before, after)
    meshes = sorted((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o:o.name)
    assert len(meshes) == 6
    reference_matrix = meshes[0].matrix_world
    for obj in meshes:
        assert len(obj.data.materials) <= 48
        assert all(abs(v) <= 1e-8 for v in obj.location), 'Group origin moved'
        assert max(abs(obj.matrix_world[i][j] - reference_matrix[i][j])
                   for i in range(4) for j in range(4)) <= 1e-8, 'Group frames differ'
    assert source_hash == sha(SOURCE.read_bytes()), 'Source file changed'
    result = {
        'status': 'PASS_BLENDER_REIMPORT_NOT_UE_VERIFIED', 'blender': bpy.app.version_string,
        'source_fbx_sha256': source_hash, 'grouped_fbx_sha256': sha(OUTPUT.read_bytes()),
        'source_mesh_count': len(source_meshes), 'output_mesh_count': len(meshes),
        'source_material_count': len(materials), 'triangles': before['triangle_count'],
        'source_bounds_m': before['bounds_m'], 'output_bounds_m': after['bounds_m'],
        'max_bounds_error_m': validation['max_bounds_error_m'],
        'max_position_component_error_m':validation['max_position_component_error_m'],
        'max_uv_component_error':validation['max_uv_component_error'],
        'max_normal_component_error':validation['max_normal_component_error'],
        'max_material_parameter_error':validation['max_material_parameter_error'],
        'memory_max_bounds_error_m': memory_validation['max_bounds_error_m'],
        'position_tolerance_m': POSITION_TOLERANCE_M, 'uv_tolerance': 1e-6, 'normal_tolerance':0.0005,
        'all_world_triangle_winding_uv_material_counts_equal': True,
        'material_triangle_counts_before': before['material_triangles'],
        'material_triangle_counts_after': after['material_triangles'],
        'source_segment_bounds_and_geometry_verification': validation['segments'],
        'groups_after_reimport': [{'name': o.name, 'material_slot_count': len(o.data.materials),
           'material_names': [m.name for m in o.data.materials],
           'location': list(o.location), 'rotation': list(o.rotation_euler), 'scale': list(o.scale)} for o in meshes],
        'fbx_global_settings_before': source_info['global_settings'],
        'fbx_global_settings_after': output_info['global_settings'],
        'source_embedded_video_count': len(source_info['videos']),
        'output_embedded_video_count': len(output_info['videos']),
        'all_embedded_texture_hashes_equal': True, 'unique_embedded_texture_count':len(output_texture_hashes),
        'embedded_texture_sha256': sorted(output_texture_hashes),
        'material_image_hashes_before': before['material_image_hashes'],
        'material_image_hashes_after': after['material_image_hashes'],
        'material_parameters_before':before['material_parameters'],
        'material_parameters_after':after['material_parameters'],
        'sample_sign_material_hashes': dict(list((k,v) for k,v in before['material_image_hashes'].items() if v)[:8]),
        'absolute_path_string_count_in_output_fbx': len(output_info['absolute_strings']),
        'source_file_unchanged': True,
        'limitations': ['UE5 import/render/collision/play untested',
                       'Original 1206 object names/hierarchy merged; doors and stairs remain static geometry',
                       'FBX material rendering is not pixel-identical verification',
                       'Positions/UVs/normals compared with documented numerical tolerances, not bit-exact floats'],
    }
    with REPORT.open('x', encoding='utf-8') as stream:
        json.dump(result,stream,ensure_ascii=False,indent=2)
    print('VERIFIED_GROUPS', json.dumps({k: result[k] for k in ['output_mesh_count','triangles','max_bounds_error_m',
          'unique_embedded_texture_count','grouped_fbx_sha256']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--report',type=Path)
    arguments = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    SOURCE = arguments.source.resolve(strict=True)
    OUTPUT = arguments.output.resolve()
    REPORT = (arguments.report or OUTPUT.with_suffix('.verification.json')).resolve()
    # Keep authoring output in this project; source is read-only.
    for target in (OUTPUT, REPORT):
        if not target.is_relative_to(ROOT) or target == ROOT:
            raise ValueError('Output/report must stay inside the project directory: ' + str(ROOT))
        if target.exists():
            raise FileExistsError('Refusing existing output/report: ' + str(target))
    if OUTPUT == REPORT:
        raise ValueError('Output and report must be distinct')
    if OUTPUT.suffix.lower() != '.fbx' or REPORT.suffix.lower() != '.json':
        raise ValueError('Output must be .fbx; report must be .json')
    for target in (OUTPUT, REPORT):
        target.parent.mkdir(parents=True,exist_ok=True)
    try:
        main()
    except Exception as error:
        if not REPORT.exists():
            with REPORT.open('x', encoding='utf-8') as stream:
                json.dump({'status':'FAILED','error':str(error)},stream,indent=2)
        raise
