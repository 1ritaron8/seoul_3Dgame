"""Re-import street/building FBXs and inspect exterior walk geometry in Blender.
Run: blender -b --python qa_shinyeong_walk.py -- --repo REPO --route ROUTE.json --output-dir OUTPUT
This checks modeled triangles, not Unreal collision or character movement.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--route', type=Path)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--no-render', action='store_true')
    parser.add_argument('--walkthrough', action='store_true', help='Render the route as a first-person MP4.')
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    return parser.parse_args(argv)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    args = parse_args()
    repo = args.repo.resolve()
    out = args.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    street_path = repo / 'exports/guil-street-ue5/guil-street.fbx'
    building_path = repo / 'exports/shinyeong-ue5-transfer/shinyeong-v13-ue-groups.fbx'
    route_path = args.route or repo / 'exports/guil-street-ue5/shinyeong_walk.json'
    data = json.loads(route_path.read_text(encoding='utf-8-sig'))
    if data['coordinate_system'] != 'BLENDER_METERS_X_EAST_Y_NORTH_Z_UP':
        raise ValueError('Expected Blender metre coordinates')
    radius = float(data['capsule_radius_m'])
    height = 2 * float(data['capsule_half_height_m'])
    if radius <= 0 or height < 2 * radius:
        raise ValueError('Invalid capsule dimensions')
    waypoints = data['waypoints']
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(street_path), use_image_search=False)
    street = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    bpy.ops.import_scene.fbx(filepath=str(building_path), use_image_search=False)
    objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    vertices, faces, building_faces, obstacle_faces, obstacle_sources = [], [], [], [], []
    for obj in objects:
        obj.data.calc_loop_triangles()
        offset = len(vertices)
        vertices.extend(obj.matrix_world @ vertex.co for vertex in obj.data.vertices)
        for triangle in obj.data.loop_triangles:
            indices = [offset + index for index in triangle.vertices]
            points = [vertices[index] for index in indices]
            faces.append(indices)
            if obj not in street:
                building_faces.append(indices)
            normal = (points[1] - points[0]).cross(points[2] - points[0]).normalized()
            # Ground top/bottom faces must not count as body obstacles.
            # All curbs and every building triangle remain in dedicated tests.
            if not (abs(normal.z) > .95 and max(point.z for point in points) <= .18):
                obstacle_faces.append(indices)
                obstacle_sources.append('street_curb' if obj in street else 'building')
    full = BVHTree.FromPolygons(vertices, faces, all_triangles=True)
    building = BVHTree.FromPolygons(vertices, building_faces, all_triangles=True)
    obstacles = BVHTree.FromPolygons(vertices, obstacle_faces, all_triangles=True)
    route = []
    route_spacing, axis_spacing = .15, .08
    for start, end in zip(waypoints, waypoints[1:]):
        p, q = Vector(start['position_m']), Vector(end['position_m'])
        count = max(1, math.ceil((q - p).length / route_spacing))
        label = start['id'] + ' -> ' + end['id']
        route.extend((label, p.lerp(q, index / count), (p.z,) if index == 0 else (p.z, q.z))
                     for index in range(count))
    last = Vector(waypoints[-1]['position_m'])
    route.append((waypoints[-1]['id'], last, (last.z,)))
    issues, support_errors, footprint_missing, supports = [], [], [], []
    minimum, building_minimum, footprint_range = math.inf, math.inf, 0
    for label, authored_feet, expected_heights in route:
        feet = authored_feet.copy()
        hit = full.ray_cast(feet + Vector((0, 0, .55)), Vector((0, 0, -1)), 1.5)
        if hit[0] is None:
            support_errors.append({'segment': label, 'point': list(feet), 'error': 'no_support'})
        else:
            delta = min(abs(hit[0].z - expected) for expected in expected_heights)
            supports.append(hit[0].z)
            if delta > .03 or hit[1].z < .7:
                support_errors.append({'segment': label, 'point': list(feet), 'support_delta_m': delta, 'normal': list(hit[1])})
            feet.z = hit[0].z
        footprint = []
        for index in range(8):
            angle = index * math.pi / 4
            probe = feet + Vector((radius * math.cos(angle), radius * math.sin(angle), .55))
            hit = full.ray_cast(probe, Vector((0, 0, -1)), 1.5)
            if hit[0] is None:
                footprint_missing.append({'segment': label, 'probe': list(probe)})
            else:
                footprint.append(hit[0].z)
        if footprint:
            footprint_range = max(footprint_range, max(footprint) - min(footprint))
        count = max(1, math.ceil((height - 2 * radius) / axis_spacing))
        closest_distance, closest_point, source = math.inf, None, None
        for index in range(count + 1):
            center = feet + Vector((0, 0, radius + (height - 2 * radius) * index / count))
            hit = building.find_nearest(center)
            if hit[0] is not None:
                building_minimum = min(building_minimum, hit[3] - radius)
            hit = obstacles.find_nearest(center)
            if hit[0] is not None and hit[3] < closest_distance:
                closest_distance, closest_point = hit[3], list(hit[0])
                source = obstacle_sources[hit[2]]
        clearance = closest_distance - radius
        minimum = min(minimum, clearance)
        if clearance < .05:
            issues.append({'segment': label, 'feet': list(feet), 'sampled_clearance_m': clearance,
                           'closest_triangle_point': closest_point, 'obstacle_source': source})
    maximum_step = max((abs(b - a) for a, b in zip(supports, supports[1:])), default=0)
    # Nearest distance is 1-Lipschitz. Include route XY spacing, measured abrupt
    # support transitions and capsule-axis spacing in an upper sampling bound.
    sampling_bound = route_spacing / 2 + maximum_step + axis_spacing / 2
    sightlines = {}
    for key, vantage, door in (('opposite_to_front', 'opposite_sidewalk', 'front'),
                               ('front', 'front_door_view', 'front'), ('rear', 'rear_door_view', 'rear')):
        waypoint = next(item for item in waypoints if item['id'] == vantage)
        eye = Vector(waypoint['position_m']) + Vector((0, 0, data['eye_height_m']))
        target = Vector(data['door_targets_m'][door])
        direction = target - eye
        hit = full.ray_cast(eye, direction.normalized(), direction.length + .1)
        sightlines[key] = {'eye': list(eye), 'target': list(target),
                          'first_hit': list(hit[0]) if hit[0] is not None else None,
                          'target_visible_within_20cm': hit[0] is not None and (hit[0] - target).length < .2}
    sys.path.insert(0, str(repo / 'tools'))
    from street_geometry import clip_polygon_to_rect, signed_area
    from qa_street_blender import STAIR_MASK, mesh_bounds
    buildings = [obj for obj in objects if obj not in street]
    bounds = [mesh_bounds([obj]) for obj in buildings]
    centers = [tuple((a + b) / 2 for a, b in zip(box['min'], box['max'])) for box in bounds]
    source_bounds = {
        'StreetDraft': mesh_bounds(street),
        'ShinyeongReference': mesh_bounds(buildings),
        'BuildingGroupCenters': {'min': list(map(min, zip(*centers))),
                                 'max': list(map(max, zip(*centers)))},
    }
    stair_overlaps = []
    for obj in street:
        for polygon in obj.data.polygons:
            points = [obj.matrix_world @ obj.data.vertices[index].co for index in polygon.vertices]
            overlap = clip_polygon_to_rect([(point.x, point.y) for point in points], STAIR_MASK)
            if overlap and abs(signed_area(overlap)) > 1e-5:
                stair_overlaps.append({'object': obj.name, 'polygon': polygon.index})
    passed = (len(street) == 3 and len(objects) - len(street) == 6
              and set(sightlines) == {'opposite_to_front', 'front', 'rear'}
              and building_minimum > sampling_bound and not support_errors
              and all(item['obstacle_source'] == 'street_curb' for item in issues)
              and not footprint_missing and not stair_overlaps
              and all(item['target_visible_within_20cm'] for item in sightlines.values()))
    result = {'status': 'PASS_GEOMETRY_WITH_CURB_STEP_REQUIREMENT' if passed else 'FAIL_GEOMETRY',
              'blender_version': bpy.app.version_string, 'contract_sha256': sha(route_path),
              'source_bounds_m': source_bounds,
              'route_horizontal_length_m': sum(
                  math.dist(a['position_m'][:2], b['position_m'][:2]) for a, b in zip(waypoints, waypoints[1:])),
              'street_sha256': sha(street_path), 'building_sha256': sha(building_path),
              'street_meshes': len(street), 'building_meshes': len(objects) - len(street),
              'route_samples': len(route), 'capsule_radius_m': radius, 'capsule_height_m': height,
              'route_spacing_max_m': route_spacing, 'axis_spacing_max_m': axis_spacing,
              'conservative_sampling_bound_m': sampling_bound,
              'building_minimum_sampled_surface_clearance_m': building_minimum,
              'building_clearance_exceeds_sampling_allowance': building_minimum > sampling_bound,
              'minimum_sampled_surface_clearance_m_including_curbs': minimum,
              'low_clearance_samples': issues, 'support_errors': support_errors,
              'support_footprint_8_rays_missing': footprint_missing,
              'support_footprint_max_height_range_m': footprint_range,
              'maximum_adjacent_support_step_m': maximum_step,
              'door_sightlines': sightlines, 'stair_opening_street_overlap': stair_overlaps,
              'limitations': ['Modeled geometry estimates, not surveyed physical dimensions.',
                             'Unreal collision and character simulation untested; curb traversal requires step handling.',
                             'Exterior door approach only; interior passage is not verified.',
                             'Static capsules overlap curb steps; these are reported separately from building obstacles.']}
    (out / 'qa_shinyeong_walk.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n',
                                               encoding='utf-8', newline='\n')
    if not args.no_render:
        render(data, out, args.walkthrough)
    print('QA_RESULT', json.dumps({key: value for key, value in result.items() if key != 'low_clearance_samples'}))
    if not passed:
        raise RuntimeError('Required geometry validation failed; inspect qa_shinyeong_walk.json')


def render(data, out, walkthrough):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 8
    scene.render.resolution_x, scene.render.resolution_y = 800, 450
    scene.render.resolution_percentage = 100
    scene.world = bpy.data.worlds.new('QA_world')
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes['Background']
    background.inputs['Color'].default_value = (.65, .7, .8, 1)
    background.inputs['Strength'].default_value = .8
    light_data = bpy.data.lights.new('QA_sun', 'SUN')
    light = bpy.data.objects.new('QA_sun', light_data)
    scene.collection.objects.link(light)
    light.rotation_euler, light_data.energy = (.4, -.5, -.6), 3
    camera_data = bpy.data.cameras.new('QA_eye')
    camera = bpy.data.objects.new('QA_eye', camera_data)
    scene.collection.objects.link(camera)
    scene.camera, camera_data.lens = camera, 24
    if walkthrough:
        render_walkthrough(scene, camera, data, out)
        return
    views = [('start', data['waypoints'][0], data['door_targets_m']['front'])]
    for key in ('front', 'rear'):
        waypoint = next(item for item in data['waypoints'] if item['id'] == key + '_door_view')
        views.append((key, waypoint, data['door_targets_m'][key]))
    for name, waypoint, target in views:
        camera.location = Vector(waypoint['position_m']) + Vector((0, 0, data['eye_height_m']))
        camera.rotation_euler = (Vector(target) - camera.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = str(out / (name + '_eye.png'))
        bpy.ops.render.render(write_still=True)


def render_walkthrough(scene, camera, data, output):
    """Move a camera along the measured route. Hand turns/curb motion are interpolated for review."""
    fps = 15
    preview_speed_mps = 4.5
    eyes = [Vector(point['position_m']) + Vector((0, 0, data['eye_height_m']))
            for point in data['waypoints']]
    ids = [point['id'] for point in data['waypoints']]
    front_index = ids.index('front_door_view')
    front_target = Vector(data['door_targets_m']['front'])
    rear_target = Vector(data['door_targets_m']['rear'])
    frame = 0
    camera.rotation_mode = 'QUATERNION'
    camera.data.lens = 22

    def angles(direction):
        return math.atan2(direction.y, direction.x), math.atan2(direction.z, math.hypot(direction.x, direction.y))

    def expose(position, yaw, pitch):
        nonlocal frame
        frame += 1
        direction = Vector((math.cos(yaw)*math.cos(pitch), math.sin(yaw)*math.cos(pitch), math.sin(pitch)))
        camera.location = position
        camera.rotation_quaternion = direction.to_track_quat('-Z', 'Y')
        camera.keyframe_insert(data_path='location', frame=frame)
        camera.keyframe_insert(data_path='rotation_quaternion', frame=frame)

    yaw, pitch = angles(front_target - eyes[0])
    for _ in range(fps):
        expose(eyes[0], yaw, pitch)
    for index, (start, end) in enumerate(zip(eyes, eyes[1:])):
        travel = end - start
        last_leg = index == len(eyes) - 2
        if index < front_index:
            desired_yaw, desired_pitch = angles(front_target - start)
        elif last_leg:
            desired_yaw, desired_pitch = angles(rear_target - start)
        else:
            # Keep some of the facade in view while turning around the building.
            desired_yaw = math.atan2(travel.y, travel.x) + math.radians(23)
            desired_pitch = math.radians(5)
        change = math.remainder(desired_yaw - yaw, 2 * math.pi)
        turn_frames = round(abs(change) / math.radians(100) * fps)
        for j in range(1, turn_frames + 1):
            t = j / turn_frames
            eased = t * t * (3 - 2 * t)
            expose(start, yaw + change * eased, pitch + (desired_pitch - pitch) * eased)
        yaw, pitch = desired_yaw, desired_pitch
        move_frames = max(1, round(math.hypot(travel.x, travel.y) / preview_speed_mps * fps))
        for j in range(1, move_frames + 1):
            position = start.lerp(end, j / move_frames)
            if index < front_index or last_leg:
                yaw, pitch = angles((rear_target if last_leg else front_target) - position)
            expose(position, yaw, pitch)
        if index + 1 == front_index or last_leg:
            for _ in range(fps):
                expose(end, yaw, pitch)

    scene.render.engine = 'BLENDER_EEVEE'
    eevee = getattr(scene, 'eevee', None)
    if hasattr(eevee, 'taa_render_samples'):
        eevee.taa_render_samples = 4
    scene.render.resolution_x, scene.render.resolution_y = 640, 360
    scene.render.fps = fps
    scene.frame_start, scene.frame_end = 1, frame
    scene.render.image_settings.media_type = 'VIDEO'
    scene.render.image_settings.file_format = 'FFMPEG'
    scene.render.ffmpeg.format = 'MPEG4'
    scene.render.ffmpeg.codec = 'H264'
    scene.render.filepath = str(output / 'shinyeong_walkthrough.mp4')
    print(f'WALKTHROUGH frames={frame} fps={fps}', flush=True)
    bpy.ops.render.render(animation=True)


if __name__ == '__main__':
    main()
