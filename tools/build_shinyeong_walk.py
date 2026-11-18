"""Build or reopen the walk using File > Execute Python Script in the UE5 Editor."""
from pathlib import Path
import hashlib
import importlib.util
import itertools
import json
import math
import os
from uuid import uuid4


DEFAULT_ROUTE = 'exports/guil-street-ue5/shinyeong_walk.json'
COORDINATES = 'BLENDER_METERS_X_EAST_Y_NORTH_Z_UP'
LEVEL_PATH = '/Game/GuilWalk/ShinyeongWalk'
COMPLETE_TAG = 'GuilWalkComplete_v1'


def finite_vector(value, label):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(label + ' must contain exactly three numbers')
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value):
        raise ValueError(label + ' must contain finite numbers')
    return tuple(float(v) for v in value)


def read_route(root, route_file=None):
    path = (root / (route_file or DEFAULT_ROUTE)).resolve(strict=True)
    if not path.is_relative_to(root):
        raise ValueError('Route must be inside REPO_ROOT')
    route = json.loads(path.read_text(encoding='utf-8-sig'))
    if route.get('coordinate_system') != COORDINATES:
        raise ValueError('Route coordinate_system must be ' + COORDINATES)
    points = route.get('waypoints', [])
    if len(points) < 2:
        raise ValueError('At least two waypoints are required')
    identifiers = []
    for point in points:
        identifiers.append(point['id'])
        finite_vector(point['position_m'], 'waypoint position_m')
    finite_vector(route['door_targets_m']['front'], 'front door')
    finite_vector(route['door_targets_m']['rear'], 'rear door')
    if (len(set(identifiers)) != len(identifiers) or identifiers[0] != 'opposite_sidewalk'
            or 'front_door_view' not in identifiers[1:-1] or identifiers[-1] != 'rear_door_view'):
        raise ValueError('The walk must start opposite the building, pass the front, and end at the rear.')
    qa = json.loads((root / 'exports/guil-street-ue5/walk/qa_shinyeong_walk.json').read_text(encoding='utf-8'))
    if qa['status'] != 'PASS_GEOMETRY_WITH_CURB_STEP_REQUIREMENT':
        raise ValueError('Route geometry verification did not pass.')
    # Axis detection uses the centers of six distinct imported groups. The whole
    # building is nearly symmetric north/south, so its overall bounds alone are ambiguous.
    route['source_bounds_m'] = qa['source_bounds_m']
    for filename, key in [(path, 'contract_sha256'),
                          (root / 'exports/guil-street-ue5/guil-street.fbx', 'street_sha256'),
                          (root / 'exports/shinyeong-ue5-transfer/shinyeong-v13-ue-groups.fbx', 'building_sha256')]:
        if hashlib.sha256(filename.read_bytes()).hexdigest() != qa[key]:
            raise ValueError('Re-run qa_shinyeong_walk.py for the changed input: ' + filename.name)
    return route


def transform_point(point, transform):
    return tuple(100.0 * transform['signs'][i] * point[transform['order'][i]] for i in range(3))


def transform_bounds(bounds, transform):
    vertices = [transform_point(v, transform) for v in itertools.product(*zip(bounds['min'], bounds['max']))]
    return {'min': tuple(min(v[i] for v in vertices) for i in range(3)),
            'max': tuple(max(v[i] for v in vertices) for i in range(3))}


def detect_transform(source_bounds, actual_bounds, tolerance_cm=1.0):
    """Infer FBX orientation from both actual imported bounds, never assume +Y/-Y.

    Only horizontal permutations/signs are allowed; height must remain positive Z.
    Returns unique match or fails before PlayerStart placement. No arbitrary rescale.
    """
    matches = []
    for order in ((0, 1, 2), (1, 0, 2)):
        for signs_xy in itertools.product((-1, 1), repeat=2):
            candidate = {'order': order, 'signs': signs_xy + (1,)}
            error = 0.0
            for name in source_bounds:
                expected = transform_bounds(source_bounds[name], candidate)
                error = max(error, *(abs(expected[k][i] - actual_bounds[name][k][i])
                                      for k in ('min', 'max') for i in range(3)))
            if error <= tolerance_cm:
                matches.append((error, candidate))
    if len(matches) != 1:
        raise RuntimeError('FBX axis/unit verification requires exactly one match; found '
                           + str(len(matches)) + '. Actual UE bounds: ' + repr(actual_bounds)
                           + '. Inspect export, units, combined/group pivots and route source_bounds_m.')
    return matches[0][1]


def _load_importer(root):
    path = root / 'tools/import_guil_fbx.py'
    spec = importlib.util.spec_from_file_location('_guil_importer_for_walk', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _choose_game_mode(ue, explicit=None):
    """Load real template class and validate its Pawn before creating a new map."""
    candidates = []
    if explicit:
        candidates = [explicit]
    else:
        for folder in ('/Game/FirstPerson', '/Game/FirstPersonBP'):
            if ue.EditorAssetLibrary.does_directory_exist(folder):
                for asset_path in ue.EditorAssetLibrary.list_assets(folder, recursive=True, include_folder=False):
                    leaf = asset_path.rsplit('/', 1)[-1].split('.')[0]
                    if 'GameMode' in leaf and 'Variant_' not in asset_path:
                        candidates.append(asset_path)
    valid = {}
    for path in candidates:
        if path.endswith('_C'):
            cls = ue.load_class(None, path)
        else:
            cls = ue.EditorAssetLibrary.load_blueprint_class(path)
        if cls is None:
            continue
        default = ue.get_default_object(cls)
        if not isinstance(default, ue.GameModeBase):
            continue
        pawn = default.get_editor_property('default_pawn_class')
        if pawn is None:
            continue
        pawn_default = ue.get_default_object(pawn)
        if not isinstance(pawn_default, ue.Character):
            continue
        # Modern template uses Enhanced Input in its actual Blueprint. Reuse it.
        movement = pawn_default.character_movement
        capsule = pawn_default.capsule_component
        if movement is None or capsule is None:
            continue
        valid[cls.get_path_name()] = (cls, float(capsule.get_scaled_capsule_half_height()),
                                     float(capsule.get_scaled_capsule_radius()),
                                     float(movement.get_editor_property('max_step_height')),
                                     float(movement.get_walkable_floor_z()))
    if len(valid) != 1:
        raise RuntimeError('Add the First Person Blueprint content pack (base variant) in Guil2026, '
                           'or pass GAME_MODE=/Game/.../BP_FirstPersonGameMode. '
                           'Exactly one real Character GameMode is required. Found: ' + repr(list(valid)))
    return next(iter(valid.values()))


def _union_actor_bounds(actors, centers_only=False):
    lo, hi = [float('inf')] * 3, [float('-inf')] * 3
    for actor in actors:
        center, extent = actor.get_actor_bounds(False)
        for i, field in enumerate(('x', 'y', 'z')):
            half_extent = 0.0 if centers_only else getattr(extent, field)
            lo[i] = min(lo[i], getattr(center, field) - half_extent)
            hi[i] = max(hi[i], getattr(center, field) + half_extent)
    return {'min': lo, 'max': hi}


def _hit_location(hit):
    if hit is None:
        return None
    # UE5.6 HitResult native break is reflected through StructBase.to_tuple;
    # individual native fields are not documented editor properties.
    values = hit.to_tuple()
    if len(values) < 8:
        raise RuntimeError('Unexpected UE HitResult tuple layout')
    if not values[0]:
        return None
    return values[5]


def _trace(ue, world, start, end, complex_trace=False):
    return ue.SystemLibrary.line_trace_single_by_profile(
        world, ue.Vector(*start), ue.Vector(*end), 'Pawn',
        complex_trace, [], ue.DrawDebugTrace.NONE, True)


def _capsule_trace(ue, world, start, end, radius, half_height):
    return ue.SystemLibrary.capsule_trace_single_by_profile(
        world, ue.Vector(*start), ue.Vector(*end), radius, half_height,
        'Pawn', False, [], ue.DrawDebugTrace.NONE, True)


def _place_meshes(ue, actors_api, paths):
    groups = {'StreetDraft': [], 'ShinyeongReference': []}
    meshes = ue.get_editor_subsystem(ue.StaticMeshEditorSubsystem)
    # Some FBX factory versions list only their principal asset in a task
    # result. Query both fresh import folders for the other static meshes.
    folders = {path.rsplit('/', 1)[0] for path in paths}
    mesh_paths = set(paths)
    for folder in folders:
        if folder.rsplit('/', 1)[-1] in groups:
            mesh_paths.update(ue.EditorAssetLibrary.list_assets(folder, recursive=True, include_folder=False))
    for path in sorted(mesh_paths):
        data = ue.EditorAssetLibrary.find_asset_data(path)
        if str(data.asset_class_path.asset_name) != 'StaticMesh':
            continue
        mesh = data.get_asset()
        if not isinstance(mesh, ue.StaticMesh):
            raise RuntimeError('Imported mesh failed to load: ' + path)
        group = next((name for name in groups if '/' + name + '/' in path), None)
        if group is None:
            raise RuntimeError('Unexpected mesh location: ' + path)
        mesh.modify()
        body = mesh.get_editor_property('body_setup')
        if body is None:
            body = ue.BodySetup(outer=mesh)
            mesh.set_editor_property('body_setup', body)
        body.modify()
        body.set_editor_property('collision_trace_flag', ue.CollisionTraceFlag.CTF_USE_COMPLEX_AS_SIMPLE)
        body.set_editor_property('double_sided_geometry', True)
        for index in range(mesh.get_num_sections(0)):
            if not meshes.is_section_collision_enabled(mesh, 0, index):
                meshes.enable_section_collision(mesh, True, 0, index)
        if not ue.EditorAssetLibrary.save_loaded_asset(mesh, False):
            raise RuntimeError('Could not save collision: ' + path)
        actor = actors_api.spawn_actor_from_class(ue.StaticMeshActor, ue.Vector(0, 0, 0))
        if actor is None or not actor.static_mesh_component.set_static_mesh(mesh):
            raise RuntimeError('Could not place mesh: ' + path)
        component = actor.static_mesh_component
        component.set_collision_profile_name('BlockAll')
        component.set_collision_enabled(ue.CollisionEnabled.QUERY_AND_PHYSICS)
        actor.set_actor_label('GuilWalk_' + mesh.get_name())
        groups[group].append(actor)
    if len(groups['StreetDraft']) != 1 or len(groups['ShinyeongReference']) != 6:
        raise RuntimeError('Expected one street mesh and six Shinyeong meshes. Check the FBX importer settings.')
    return groups


def _floor(ue, world, x, y, z_limits, floor_z, label):
    low, high = z_limits
    hit = _trace(ue, world, (x, y, high + 80), (x, y, low - 80))
    point = _hit_location(hit)
    if point is None or not low - 3 <= point.z <= high + 3 or hit.to_tuple()[7].z < floor_z:
        raise RuntimeError(f'Missing or unexpected walkable surface at {label} ({x:.0f}, {y:.0f} cm).')
    return point.z


def _check_walk(ue, world, points, radius, half_height, step_height, floor_z):
    """Trace the real Pawn shape at rest and between samples, including curb transitions."""
    def sweep(start, end):
        return _capsule_trace(ue, world, start, end, radius, half_height)

    previous = None
    previous_floor = None
    samples = 0
    step_ups = 0
    waypoint_heights = {name: _floor(ue, world, x, y, (z, z), floor_z, name)
                        for name, (x, y, z) in points}
    for segment, ((name_a, a), (name_b, b)) in enumerate(zip(points, points[1:])):
        label = name_a + ' -> ' + name_b
        count = max(1, math.ceil(math.dist(a[:2], b[:2]) / 30.0))
        for i in range(0 if segment == 0 else 1, count + 1):
            t = i / count
            x, y = (a[axis] + t * (b[axis] - a[axis]) for axis in (0, 1))
            # The foot surface changes abruptly at a curb. Do not interpolate a ramp.
            z = _floor(ue, world, x, y, (min(a[2], b[2]), max(a[2], b[2])), floor_z, label)
            if previous_floor is not None and z - previous_floor > step_height + 0.5:
                raise RuntimeError('Curb exceeds CharacterMovement step height at ' + label)
            base = z + half_height
            floor_hit = sweep((x, y, base + step_height + 6), (x, y, base - 6))
            if _hit_location(floor_hit) is None or floor_hit.to_tuple()[1]:
                raise RuntimeError('Pawn cannot settle on the route at ' + label)
            # Location is the center of the swept shape, distinct from ImpactPoint on the floor.
            contact_z = floor_hit.to_tuple()[4].z
            if not base - 4 <= contact_z <= base + step_height + 3:
                raise RuntimeError('Unexpected capsule support at ' + label)
            center = (x, y, contact_z + 3)
            if previous is not None and _hit_location(sweep(previous, center)) is not None:
                # Try an up–forward–down sweep using this Character's own step limit.
                clear_z = previous[2] + step_height
                up = (*previous[:2], clear_z)
                across = (x, y, clear_z)
                if center[2] > clear_z + 0.5 or any(
                        _hit_location(sweep(p, q)) is not None for p, q in
                        ((previous, up), (up, across), (across, center))):
                    raise RuntimeError('Pawn capsule blocked at ' + label)
                step_ups += 1
            previous, previous_floor = center, z
            samples += 1
    return {'waypoint_floor_cm': waypoint_heights, 'capsule_samples': samples,
            'clear_step_alternatives': step_ups}


def _check_door_views(ue, world, route, points, transform, buildings):
    positions = dict(points)
    errors = {}
    for waypoint, door in [('opposite_sidewalk', 'front'), ('front_door_view', 'front'),
                            ('rear_door_view', 'rear')]:
        x, y, z = positions[waypoint]
        eye = (x, y, z + 100 * route['eye_height_m'])
        target = transform_point(route['door_targets_m'][door], transform)
        distance = math.dist(eye, target)
        end = tuple(b + (b - a) * 20 / distance for a, b in zip(eye, target))
        hit = _trace(ue, world, eye, end)
        actual = _hit_location(hit)
        if actual is None or hit.to_tuple()[9] not in buildings:
            raise RuntimeError('Door not on sight line at ' + waypoint)
        error = math.dist((actual.x, actual.y, actual.z), target)
        if error > 20:
            raise RuntimeError(f'Door is occluded at {waypoint} ({error:.1f} cm from target).')
        errors[waypoint] = round(error, 2)
    return errors


def _use_saved_level_on_startup(repo, content_dir):
    """Switch the shipped project's temporary startup map after its real .umap exists."""
    project_dir = (repo / 'Guil2026').resolve()
    if content_dir.resolve().parent != project_dir:
        return False
    config = project_dir / 'Config/DefaultEngine.ini'
    original = config.read_bytes()
    lines = original.splitlines(keepends=True)
    section = b''
    for index, line in enumerate(lines):
        entry = line.rstrip(b'\r\n')
        if entry.startswith(b'['):
            section = entry
        if section != b'[/Script/EngineSettings.GameMapsSettings]' or entry != b'EditorStartupMap=/Engine/Maps/Entry':
            continue
        lines[index] = b'EditorStartupMap=' + LEVEL_PATH.encode('ascii') + line[len(entry):]
        temporary = config.with_name('DefaultEngine.' + uuid4().hex + '.tmp')
        try:
            with temporary.open('xb') as stream:
                stream.write(b''.join(lines))
            if config.read_bytes() != original:
                return False
            temporary.replace(config)
        finally:
            temporary.unlink(missing_ok=True)
        return True
    return False


def _save_new_map(ue, world, target_file, saved_dir):
    # Two editor processes may finish their independent FBX imports together.
    # Closing the handle releases the OS lock, including if an editor crashes.
    with (saved_dir / 'GuilWalk.save.lock').open('a+b') as lock:
        try:
            if os.name == 'nt':
                import msvcrt
                if lock.tell() == 0:
                    lock.write(b'0')
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError('Another editor is saving the walking level.') from exc
        if target_file.exists():
            raise RuntimeError('Target already exists. Kept existing level: ' + str(target_file))
        target_file.parent.mkdir(parents=True, exist_ok=True)
        if not ue.EditorLoadingAndSavingUtils.save_map(world, LEVEL_PATH) or not target_file.is_file():
            raise RuntimeError('Could not save walking level: ' + str(target_file))


def build_walk_level(repo_root, route_file=None, game_mode=None, unreal_module=None):
    root = Path(repo_root).resolve(strict=True)
    if unreal_module is None:
        import unreal as unreal_module
    ue = unreal_module
    editor = ue.get_editor_subsystem(ue.LevelEditorSubsystem)
    actors_api = ue.get_editor_subsystem(ue.EditorActorSubsystem)
    if editor.is_in_play_in_editor():
        raise RuntimeError('Stop PIE before building a walking map')
    # Switching levels can discard changes to the currently edited world.
    dirty_maps = list(ue.EditorLoadingAndSavingUtils.get_dirty_map_packages())
    if dirty_maps:
        raise RuntimeError('Save your current level first; no existing map was changed. Dirty maps: '
                           + repr([p.get_name() for p in dirty_maps]))
    level_path = LEVEL_PATH
    content_dir = Path(ue.Paths.convert_relative_path_to_full(ue.Paths.project_content_dir()))
    target_file = content_dir / 'GuilWalk/ShinyeongWalk.umap'
    previous_path = editor.get_current_level().get_outer().get_path_name().split('.')[0]
    can_restore = previous_path.startswith(('/Game/', '/Engine/'))
    if target_file.exists():
        if not editor.load_level(level_path):
            raise RuntimeError('Existing walking map could not be opened: ' + level_path)
        complete = [actor for actor in actors_api.get_all_level_actors()
                    if isinstance(actor, ue.PlayerStart) and actor.actor_has_tag(COMPLETE_TAG)]
        if len(complete) != 1:
            if can_restore and previous_path != level_path:
                editor.load_level(previous_path)
            raise RuntimeError('Existing map is unverified or partial; preserved unchanged: ' + level_path)
        ue.log('Existing walking map reopened unchanged: ' + level_path)
        return {'status': 'EXISTING_MAP_REOPENED_UNCHANGED', 'level': level_path}
    mode, half_height, radius, step_height, floor_z = _choose_game_mode(ue, game_mode)
    route = read_route(root, route_file)
    importer = _load_importer(root)
    run_id = uuid4().hex
    report = {'status': 'BUILDING', 'level': level_path, 'warnings': [], 'route_checks': [],
              'game_mode': mode.get_path_name(), 'capsule_half_height_cm': half_height,
              'capsule_radius_cm': radius, 'max_step_height_cm': step_height,
              'walkable_floor_z': floor_z}
    if not all(math.isfinite(v) for v in (radius, half_height, step_height, floor_z)) or not (
            0 < radius <= half_height and step_height >= 0 and 0 < floor_z <= 1):
        raise RuntimeError('Invalid Character capsule or movement settings.')
    output = Path(ue.Paths.convert_relative_path_to_full(ue.Paths.project_saved_dir())) / ('GuilWalk_' + run_id + '.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    created_world = False
    try:
        # Existing importer still guarantees fresh asset paths and validates both FBX.
        paths = importer.import_assets(root, ue)
        report['imported_paths'] = paths
        world = ue.EditorLoadingAndSavingUtils.new_blank_map(False)
        if world is None:
            raise RuntimeError('Could not create unsaved dedicated map')
        created_world = True
        groups = _place_meshes(ue, actors_api, paths)
        actual = {name: _union_actor_bounds(actors) for name, actors in groups.items()}
        actual['BuildingGroupCenters'] = _union_actor_bounds(groups['ShinyeongReference'], centers_only=True)
        transform = detect_transform(route['source_bounds_m'], actual)
        report.update({'actual_bounds_cm': actual, 'blender_to_ue': transform})
        points = [(point['id'], transform_point(point['position_m'], transform))
                  for point in route['waypoints']]
        checks = _check_walk(ue, world, points, radius, half_height, step_height, floor_z)
        report['route_checks'] = checks
        report['door_sightline_errors_cm'] = _check_door_views(
            ue, world, route, points, transform, groups['ShinyeongReference'])
        start_id, start = points[0]
        spawn = (start[0], start[1], checks['waypoint_floor_cm'][start_id] + half_height + 5)
        if _hit_location(_capsule_trace(ue, world, spawn, (*spawn[:2], spawn[2] + 0.1),
                                        radius, half_height)) is not None:
            raise RuntimeError('PlayerStart capsule overlaps geometry')
        target = transform_point(finite_vector(route['door_targets_m']['front'], 'front door'), transform)
        if math.dist(start[:2], target[:2]) < 0.01:
            raise ValueError('Front door look-at target must differ from start')
        yaw = math.degrees(math.atan2(target[1] - start[1], target[0] - start[0]))
        rotation = ue.Rotator(pitch=0, yaw=yaw, roll=0)
        starts = [actor for actor in actors_api.get_all_level_actors() if isinstance(actor, ue.PlayerStart)]
        if len(starts) > 1:
            raise RuntimeError('Unexpected PlayerStarts in the new empty world.')
        if starts:
            player = starts[0]
            player.set_actor_location_and_rotation(ue.Vector(*spawn), rotation, False, True)
        else:
            player = actors_api.spawn_actor_from_class(ue.PlayerStart, ue.Vector(*spawn), rotation)
        if player is None:
            raise RuntimeError('PlayerStart spawn failed')
        location = player.get_actor_location()
        forward = player.get_actor_forward_vector()
        heading = math.radians(yaw)
        if (math.dist((location.x, location.y, location.z), spawn) > 1.0
                or forward.x * math.cos(heading) + forward.y * math.sin(heading) < .999):
            raise RuntimeError('PlayerStart did not land on the opposite sidewalk facing the front door.')
        report['player_start_cm'] = spawn
        report['player_yaw_degrees'] = yaw
        player.set_actor_label('GuilWalk_Start_' + start_id)
        world.get_world_settings().set_editor_property('default_game_mode', mode)
        sun = actors_api.spawn_actor_from_class(ue.DirectionalLight, ue.Vector(0, 0, 10000),
                                               ue.Rotator(pitch=-40, yaw=-35, roll=0))
        sky = actors_api.spawn_actor_from_class(ue.SkyLight, ue.Vector(0, 0, 5000))
        atmosphere = actors_api.spawn_actor_from_class(ue.SkyAtmosphere, ue.Vector(0, 0, 0))
        if sun is None or sky is None or atmosphere is None:
            raise RuntimeError('Daylight actor creation failed')
        sun.light_component.set_editor_property('mobility', ue.ComponentMobility.MOVABLE)
        sun.light_component.set_editor_property('intensity', 50000.0)
        sun.light_component.set_editor_property('atmosphere_sun_light', True)
        sky.light_component.set_editor_property('mobility', ue.ComponentMobility.MOVABLE)
        sky.light_component.set_editor_property('real_time_capture', True)
        sky.light_component.set_editor_property('intensity', 1.0)
        player.set_editor_property('tags', [COMPLETE_TAG])
        _save_new_map(ue, world, target_file, output.parent)
        report['status'] = 'BUILT_EDITOR_TRACES_PASS_PIE_NOT_VERIFIED'
        try:
            report['updated_editor_startup_map'] = _use_saved_level_on_startup(root, content_dir)
        except OSError as exc:
            report['warnings'].append('Level saved. Open it in Content Browser; startup setting: ' + str(exc))
        report['warnings'].append('Editor shape sweeps check map collision. Actual character movement, '
                                  'camera input and frame rate require playing the level.')
        ue.log('Walking map saved: ' + level_path + '. Press Play with Spawn Player At = Default Player Start.')
        ue.log('Reopen /Game/GuilWalk/ShinyeongWalk from Content Browser. Re-running opens it unchanged.')
    except Exception as exc:
        report['status'] = 'FAILED_PARTIAL_NEW_ASSETS_OR_MAP_MAY_REMAIN'
        report['error'] = str(exc)
        ue.log_error('GuilWalk failed: ' + str(exc) + '. No originals were overwritten or cleaned up.')
        # Only this script-created unsaved world is discarded. Restore the clean
        # original map so retry is not blocked by our own dirty temporary world.
        if created_world and can_restore:
            if not editor.load_level(previous_path):
                ue.log_warning('Could not reopen original clean map: ' + previous_path)
        raise
    finally:
        try:
            output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            ue.log('GuilWalk diagnostic report: ' + str(output))
        except OSError as exc:
            ue.log_warning('Could not write the diagnostic report: ' + str(exc))
    return report


if __name__ == '__main__':
    root_argument = globals().get('REPO_ROOT', str(Path(__file__).resolve().parents[1]))
    build_walk_level(root_argument, globals().get('ROUTE_FILE'), globals().get('GAME_MODE'))
