const byId = id => document.getElementById(id);
const stage = byId('pilot-stage');
const modeNames = {orbit: '전체 입체', eye: '사람 눈높이', plan: '수직 평면'};
let disposePreview = null;

async function loadPreview() {
  const response = await fetch('/pilot/data.json');
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  if (data.schema !== 'guil-pilot3d.v1' || data.units !== 'metres' || data.building.sourceId !== 'way/252997590') {
    throw new Error('118동 크기 검증용 좌표 데이터가 아닙니다.');
  }
  const [THREE, {OrbitControls}, geometryHelpers, architecture, environmentHelpers, entranceAccess] = await Promise.all([
    import('three'), import('three/addons/controls/OrbitControls.js'), import('/pilot/geometry.mjs'), import('/pilot/architecture.mjs'), import('/pilot/pilot-environment.mjs'), import('/pilot/entrance-access.mjs')
  ]);
  const {worldPoint, createPolygonGeometry, createReferenceHuman} = geometryHelpers;
  const {createFutureApartment, withDisplayHole, disposeArchitecture} = architecture;
  const entranceController = entranceAccess.createDemoEntranceAccess();
  const futureDesign = data.futureDesign;
  const environment = futureDesign?.conceptAnalysis, evidence = data.siteEvidence;
  if (environment?.schema !== 'guil-pilot-environment.v1' || environment.engineeringSafetyConclusion !== 'not_assessed' || evidence?.schema !== 'guil-pilot-site-evidence.v1') {
    throw new Error('공식 근거·환경 비교 자료가 없습니다. build:pilot으로 다시 생성하십시오.');
  }
  const {flatGroundShadowLengthM} = environmentHelpers;
  const currentEvidence = evidence.buildingEvidence.find(item => item.sourceId === data.building.sourceId);
  byId('site-building-evidence').textContent = `공식 2025 지도: 118동 ${currentEvidence.storeys}층 / 113·117동 12층. 실제 높이(m)는 미확인입니다. 주변 비교 모형은 12층 × 가정 3.2m = 38.4m입니다.`;
  byId('site-terrain-evidence').textContent = `범위 안 표고점 ${evidence.terrain.pilotInternalPointCount}개. 10m 등고선 2개만으로 경사·출입구 단차를 확정하지 않고, 상대 지면 0m 가정을 유지합니다.`;
  const rain = environment.drainage.rainfallCases.find(item => item.rainfallMmPerHour === 100);
  byId('environment-rain').textContent = `가정 100mm/h·30분: 램프 직접 강우 ${rain.ramp.volumeM3.toFixed(1)}m³ (${rain.ramp.inflowLitresPerSecond.toFixed(1)}L/s), 옥상 ${rain.roof.volumeM3.toFixed(1)}m³를 별도 계산. 외부 유입·관망은 미확인, 램프 양 끝 파란 선은 집수구 위치 구상입니다.`;
  for (const sunCase of environment.sunlight.sunCases) {
    const option = document.createElement('option'); option.value = sunCase.id; option.textContent = `2050 ${sunCase.inputs.month}/${sunCase.inputs.day} · ${sunCase.label}`; byId('sun-case').append(option);
  }
  if (futureDesign?.validation?.status !== 'passed') throw new Error('2050 시안의 부지 배치 검증이 완료되지 않았습니다.');
  const exteriorIdentity = futureDesign.architectureIdentity;
  if (exteriorIdentity?.id !== 'g05-living-terraces') throw new Error('이 단지의 생활 테라스형 외관 기준이 없습니다.');
  byId('architecture-name').textContent = exteriorIdentity.name;
  byId('architecture-summary').textContent = `${exteriorIdentity.familyName} · ${exteriorIdentity.phaseLabel}. 쌍 발코니·거실/침실 창호·석재 저층을 적용한 외관 시안이며 세대 평면은 미설계입니다.`;
  byId('architecture-features').replaceChildren();
  for (const feature of exteriorIdentity.features) {
    const item = document.createElement('li');
    const title = document.createElement('strong'); title.textContent = `${feature.label}: `;
    item.append(title, document.createTextNode(feature.description)); byId('architecture-features').append(item);
  }
  const review = futureDesign.engineeringReview;
  if (review?.schema !== 'guil-engineering-review.v1' || review.safetyConclusion !== 'not_assessed' || review.replicationGate !== 'hold_pending_review'
    || !Array.isArray(review.checks) || review.checks.length !== 8 || review.checks.some(check => !['unverified', 'needs_revision'].includes(check.status))) {
    throw new Error('기하 검사와 별개인 공학 검토 기록이 없거나 상태가 올바르지 않습니다.');
  }
  const clearanceRecords = [...review.clearances.neighbourClearances, review.clearances.nearestWalkway, review.clearances.rampClearance];
  if (clearanceRecords.some(record => !Number.isFinite(record?.distanceM) || record.distanceM < 0 || record.status !== 'measured_2d_not_engineering_clearance')) {
    throw new Error('주변과의 지도상 간격 기록이 올바르지 않습니다.');
  }
  const revisionCount = review.checks.filter(check => check.status === 'needs_revision').length;
  byId('engineering-summary').textContent = `지도 기하만 검사됨 · 공학 검토 ${review.checks.length}분야 미완료 · ${revisionCount}분야 수정 필요. 이 한 동의 다른 곳 복제는 보류합니다.`;
  byId('engineering-clearances').replaceChildren();
  for (const record of clearanceRecords) {
    const item = document.createElement('li');
    item.textContent = `${record.label}: 약 ${record.distanceM.toFixed(2)}m`;
    byId('engineering-clearances').append(item);
  }
  byId('engineering-checks').replaceChildren();
  for (const check of review.checks) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = `${check.label} · ${check.status === 'needs_revision' ? '수정 필요' : '미검증'}: `;
    item.append(title, document.createTextNode(`${check.interaction}. 필요 자료: ${check.missingEvidence.join(' / ')}.`));
    byId('engineering-checks').append(item);
  }
  byId('engineering-warning').textContent = review.checks.filter(check => check.knownIssue).map(check => check.knownIssue).join('. ');
  byId('engineering-resolved').replaceChildren();
  for (const issue of review.resolvedGeometryIssues) {
    const item = document.createElement('li');
    item.textContent = `${issue.id === 'ramp_interface' ? '램프 인접 평면 간격' : '보도 연결 공백'}: ${issue.beforeDistanceM.toFixed(1)} → ${issue.afterDistanceM.toFixed(1)}m · 기하 수정, 안전 판정 아님`;
    byId('engineering-resolved').append(item);
  }
  const access = futureDesign.access, maintenance = futureDesign.maintenance;
  if (access?.fire?.status !== 'needs_revision' || access.fire.turnaroundVerified !== false || !maintenance || futureDesign.entrance.sidewalkGapM !== 0) {
    throw new Error('보행 접점·램프 관리 공간·미완료 소방 동선 기록이 없습니다.');
  }
  byId('access-summary').textContent = `건물·광장 ${futureDesign.frame.relocationAlongShortAxisM.toFixed(1)}m 재배치 · 램프 위치 유지 · 원래 도로·보도·단지 경계 보존`;
  const accessItems = [
    `보도 22 → ${futureDesign.entrance.pathWidthM.toFixed(1)}m 보행로 → 광장 → 로비: 전폭 평면 접점 연결`,
    `램프 옆 평면 공간 ${review.clearances.rampClearance.distanceM.toFixed(1)}m / 관리 통로 ${maintenance.widthM.toFixed(1)}m / 보호 경계 ${maintenance.barrier.heightM.toFixed(1)}m 높이 시안`,
    `지도 도로 3 → 보도 23 횡단 → ${access.vehicle.approach.widthM.toFixed(1)}m 차량 연결 → 지하 램프`,
    `서비스 통로 → 보도 22 횡단 → 도로 1: ${access.vehicle.exit.widthM.toFixed(1)}m 전폭 진출로, 막다른 구간 평면 해소`,
    `보도 23·22 교차 면: 보행 우선·차량 양보 시안 / 별도 ${access.service.widthM}×${access.service.lengthM}m 측면 후보 면 · 소방차 검증값 아님`
  ];
  byId('access-checks').replaceChildren();
  for (const text of accessItems) {
    const item = document.createElement('li'); item.textContent = text; byId('access-checks').append(item);
  }
  byId('access-warning').textContent = '평면 통과 동선은 연결했지만 소방 차량 궤적·활동 공간·보행 보호 성능은 미검증입니다. 도로 3 진입부의 미등록 띠 공간과 통행 권원·도로 연결 승인을 확인해야 합니다.';
  let designMode = 'future', parkingCutaway = false;
  if (THREE.REVISION !== '180') throw new Error(`이 검증 화면은 기존 Three.js 0.180.0을 사용합니다. 현재 revision: ${THREE.REVISION}`);
  const origin = data.coordinates.originLocalM;
  const bounds = data.scope.boundsLocalM;
  const lower = worldPoint([bounds.minX, bounds.maxY], origin);
  const upper = worldPoint([bounds.maxX, bounds.minY], origin);
  const renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: 'high-performance'});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Retain complete source polygon rings. Only their displayed scope is clipped.
  renderer.clippingPlanes = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -lower.x),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), upper.x),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -lower.z),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), upper.z)
  ];
  renderer.domElement.id = 'pilot-canvas';
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label', '118동 자리의 2050 재건축 시안. 드래그로 회전하고 휠로 확대하며 원래 건물 윤곽과 비교할 수 있습니다.');
  stage.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e5ede8');
  const perspectiveCamera = new THREE.PerspectiveCamera(52, 1, .05, 900);
  const planCamera = new THREE.OrthographicCamera(-70, 70, 50, -50, .1, 600);
  let camera = perspectiveCamera;
  const controls = new OrbitControls(perspectiveCamera, renderer.domElement);
  const planControls = new OrbitControls(planCamera, renderer.domElement);
  planControls.enabled = false;
  planControls.enableRotate = false;
  planControls.enablePan = false;
  planControls.minZoom = .5;
  planControls.maxZoom = 12;
  controls.enableDamping = true;
  controls.dampingFactor = .09;
  controls.minDistance = 2;
  controls.maxDistance = 350;
  controls.maxPolarAngle = Math.PI * .493;
  controls.screenSpacePanning = false;
  scene.add(new THREE.HemisphereLight('#f9fff9', '#758572', 1.25));
  const sun = new THREE.DirectionalLight('#fff0d7', 2);
  sun.position.set(-80, 145, 75);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -110; sun.shadow.camera.right = 110;
  sun.shadow.camera.top = 110; sun.shadow.camera.bottom = -110;
  sun.shadow.camera.far = 600;
  sun.shadow.bias = -.00015;
  sun.shadow.normalBias = .045;
  scene.add(sun, sun.target);
  // Optional inspection fill, never part of the date-based sunlight comparison.
  const inspectionFill = new THREE.DirectionalLight('#f3f8ff', 2);
  inspectionFill.visible = false;
  scene.add(inspectionFill, inspectionFill.target);

  function groundMaterial(color, layer, options = {}) {
    return new THREE.MeshStandardMaterial({color, roughness: .95, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -layer, polygonOffsetUnits: -layer, ...options});
  }
  const groundOutline = {type: 'Polygon', coordinates: [[[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY], [bounds.maxX, bounds.maxY], [bounds.minX, bounds.maxY], [bounds.minX, bounds.minY]]]};
  const ground = new THREE.Mesh(createPolygonGeometry(withDisplayHole(groundOutline, futureDesign.parking.ramp.geometryLocalM), origin), groundMaterial('#eceee3', -1));
  ground.receiveShadow = true;
  scene.add(ground);
  const zoneColors = {residential: '#d7e3d4', commercial: '#eae1c1', school: '#e0e5c4'};
  const zoneMeshes = [];
  for (const zone of data.contextZones) {
    if (!['Polygon', 'MultiPolygon'].includes(zone.geometryLocalM.type)) continue;
    const displayedGeometry = zone.id === futureDesign.siteZoneId ? withDisplayHole(zone.geometryLocalM, futureDesign.parking.ramp.geometryLocalM) : zone.geometryLocalM;
    const mesh = new THREE.Mesh(createPolygonGeometry(displayedGeometry, origin), groundMaterial(zoneColors[zone.kind] || '#e5e7df', 0));
    mesh.receiveShadow = true;
    mesh.userData.sourceId = zone.sourceId;
    mesh.renderOrder = 1;
    scene.add(mesh);
    zoneMeshes.push({zone, mesh});
  }
  const roadMaterial = groundMaterial('#65827d', 1);
  const walkwayMaterial = groundMaterial('#b1ca90', 2);
  for (const surface of [...data.surfaces].sort((a, b) => (a.kind === 'walkway') - (b.kind === 'walkway'))) {
    const mesh = new THREE.Mesh(createPolygonGeometry(surface.geometryLocalM, origin), surface.kind === 'walkway' ? walkwayMaterial : roadMaterial);
    mesh.name = surface.id;
    mesh.receiveShadow = true;
    mesh.renderOrder = surface.kind === 'walkway' ? 3 : 2;
    scene.add(mesh);
  }
  // Raster-depth offsets distinguish coincident planar layers; they are not invented curb heights.
  const contextMaterial = groundMaterial('#e8e9e0', 3);
  const contextLineMaterial = new THREE.LineBasicMaterial({color: '#9caea0'});
  const neighbourGroup = new THREE.Group(); neighbourGroup.name = 'assumed-neighbour-masses'; neighbourGroup.visible = false; scene.add(neighbourGroup);
  const neighbourMaterial = new THREE.MeshStandardMaterial({color: '#bbbec2', roughness: .85});
  for (const mass of environment.neighbourMasses) {
    const mesh = new THREE.Mesh(createPolygonGeometry(mass.geometryLocalM, origin, mass.heightM), neighbourMaterial);
    mesh.name = `neighbour-assumption-${mass.sourceId}`; mesh.userData = {sourceId: mass.sourceId, status: mass.status, physicalHeightM: null};
    mesh.castShadow = true; mesh.receiveShadow = true; neighbourGroup.add(mesh);
  }
  for (const footprint of data.contextBuildings) {
    if (!['Polygon', 'MultiPolygon'].includes(footprint.geometryLocalM.type)) continue;
    const geometry = createPolygonGeometry(footprint.geometryLocalM, origin);
    const mesh = new THREE.Mesh(geometry, contextMaterial);
    mesh.userData.sourceId = footprint.sourceId;
    mesh.userData.complexId = footprint.complexId;
    mesh.renderOrder = 4;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), contextLineMaterial);
    outline.position.y = .025;
    scene.add(outline);
  }
  const grid = new THREE.GridHelper(400, 80, '#b5c1ad', '#c3cdba');
  grid.position.y = .005;
  grid.material.transparent = true;
  grid.material.opacity = .19;
  grid.material.depthWrite = false;
  scene.add(grid);

  const buildingMaterial = new THREE.MeshStandardMaterial({color: '#85afac', roughness: .65, metalness: .12});
  const building = new THREE.Mesh(createPolygonGeometry(data.building.geometryLocalM, origin, data.building.heightM), buildingMaterial);
  building.castShadow = true; building.receiveShadow = true;
  building.userData.sourceId = data.building.sourceId;
  building.userData.complexId = data.building.complexId;
  scene.add(building);
  const buildingEdges = new THREE.LineSegments(new THREE.EdgesGeometry(building.geometry), new THREE.LineBasicMaterial({color: '#558c8c'}));
  scene.add(buildingEdges);
  building.visible = false; buildingEdges.visible = false;
  let futureBuilding = createFutureApartment(futureDesign, origin);
  scene.add(futureBuilding);
  const human = createReferenceHuman(data.referenceHuman.heightM);
  human.position.copy(worldPoint(data.referenceHuman.positionLocalM, origin));
  scene.add(human);

  const vehicleLineMaterial = new THREE.LineBasicMaterial({color: '#e69444'});
  const walkLineMaterial = new THREE.LineBasicMaterial({color: '#427c62'});
  const labels = [];
  function label(text, point, className = '') {
    const node = document.createElement('span');
    node.className = `measurement-label ${className}`;
    node.textContent = text;
    byId('measurement-labels').append(node);
    const item = {node, point}; labels.push(item); return item;
  }
  byId('road-metrics').replaceChildren();
  for (const profile of data.roadProfiles) {
    for (const section of [...profile.endpointChecks, ...profile.samples]) {
      for (const [kind, points] of [['carriageway', section.carriagewayLineLocalM], ['left_walkway', section.leftWalkwayLineLocalM], ['right_walkway', section.rightWalkwayLineLocalM]]) {
        if (!points) continue;
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map(point => worldPoint(point, origin, .055))), kind === 'carriageway' ? vehicleLineMaterial : walkLineMaterial);
        line.userData.profileId = profile.id;
        line.userData.component = kind;
        line.renderOrder = 6;
        scene.add(line);
      }
    }
    const sample = profile.samples[1], carLine = sample.carriagewayLineLocalM;
    const midpoint = [(carLine[0][0] + carLine[1][0]) / 2, (carLine[0][1] + carLine[1][1]) / 2];
    const carWidth = profile.components.find(component => component.kind === 'carriageway').widthM;
    label(`차량공간 ${carWidth.toFixed(1)}m · 지도 추정`, worldPoint(midpoint, origin, .1));
    const card = document.createElement('div'); card.className = 'road-profile-card';
    const title = document.createElement('strong'); title.textContent = `${profile.startAlongSegmentM}–${profile.endAlongSegmentM}m · 확인한 20m만`;
    const text = document.createElement('span');
    const side = kind => profile.components.find(component => component.kind === kind).widthM.toFixed(1);
    text.textContent = `차량공간 ${carWidth.toFixed(1)}m / 좌 보도 ${side('left_walkway')}m / 우 보도 ${side('right_walkway')}m`;
    card.append(title, text); byId('road-metrics').append(card);
  }
  const ring = data.building.geometryLocalM.coordinates[0];
  const corners = ring.slice(0, -1);
  const sourceCenterLocal = corners.reduce((center, point) => [center[0] + point[0] / corners.length, center[1] + point[1] / corners.length], [0, 0]);
  const edgeLengths = corners.map((point, index) => Math.hypot(point[0] - corners[(index + 1) % corners.length][0], point[1] - corners[(index + 1) % corners.length][1]));
  byId('footprint-size').textContent = `${Math.max(...edgeLengths).toFixed(1)} × ${Math.min(...edgeLengths).toFixed(1)} m`;
  let centerLocal = futureDesign.frame.centerLocalM;
  const heightLabel = label(`2050 · ${futureDesign.building.heightM}m`, worldPoint(centerLocal, origin, futureDesign.building.heightM + 1.8), 'temporary');
  const humanLabel = label('사람 1.8m', worldPoint(data.referenceHuman.positionLocalM, origin, 2.5), 'human');
  const parkingLabel = label('B1 · 지하주차장 구상 −3.6m', worldPoint(futureDesign.parking.deck.centerLocalM, origin, futureDesign.parking.deck.elevationM + .2), 'temporary');
  const neighbourLabels = environment.neighbourMasses.map(mass => {
    const corners = mass.geometryLocalM.coordinates[0].slice(0, -1);
    const centroid = corners.reduce((value, point) => value.map((component, axis) => component + point[axis] / corners.length), [0, 0]);
    const name = evidence.buildingEvidence.find(item => item.sourceId === mass.sourceId).currentReferenceName.match(/\d+동$/)?.[0] ?? mass.sourceId;
    return label(`${name} · 12층×3.2m 가정`, worldPoint(centroid, origin, mass.heightM + 1.5), 'assumed');
  });
  const center = worldPoint(centerLocal, origin);
  let heightM = futureDesign.building.heightM, mode = 'orbit', eyePoint = 'sidewalk', eyeYaw = 0, eyePitch = 0, eyeDrag = null;
  let previousCameraHeight = '';
  let entranceProgress = 0, previousEntranceFrameMs = performance.now();
  const entranceDialog = byId('entrance-dialog'), entranceCode = byId('entrance-code');
  const keypadButtons = [...document.querySelectorAll('[data-entrance-digit]')];
  const entranceHandlers = [];
  function listenEntrance(element, event, handler) { element.addEventListener(event, handler); entranceHandlers.push(() => element.removeEventListener(event, handler)); }
  function openEntranceKeypad() {
    if (designMode !== 'future' || entranceDialog.open || entranceController.snapshot().state === 'open') return;
    parkingCutaway = false; eyePoint = 'entrance'; updateCutaway(); setView('eye');
    entranceController.clear(); entranceCode.value = '';
    byId('entrance-feedback').textContent = '시연 비밀번호 2050을 입력하십시오.';
    entranceDialog.showModal(); entranceCode.focus();
  }
  function onEntranceCodeInput() {
    entranceCode.value = entranceCode.value.replace(/\D/g, '').slice(0, 6);
    entranceController.input(entranceCode.value);
    byId('entrance-feedback').textContent = '입력 후 확인을 누르십시오.';
  }
  listenEntrance(entranceCode, 'input', onEntranceCodeInput);
  for (const button of keypadButtons) listenEntrance(button, 'click', () => {
    entranceCode.value = (entranceCode.value + button.dataset.entranceDigit).slice(0, 6); onEntranceCodeInput();
  });
  listenEntrance(byId('entrance-clear'), 'click', () => { entranceController.clear(); entranceCode.value = ''; byId('entrance-feedback').textContent = '다시 입력하십시오.'; entranceCode.focus(); });
  listenEntrance(byId('entrance-cancel'), 'click', () => entranceDialog.close());
  listenEntrance(entranceDialog, 'close', () => { if (entranceController.snapshot().state !== 'open') entranceController.clear(); entranceCode.value = ''; });
  listenEntrance(byId('entrance-form'), 'submit', event => {
    event.preventDefault();
    entranceController.input(entranceCode.value);
    const result = entranceController.submit(performance.now()); entranceCode.value = '';
    if (result.state === 'open') entranceDialog.close();
    else { byId('entrance-feedback').textContent = '비밀번호가 맞지 않습니다. 시연 번호는 2050입니다.'; entranceCode.focus(); }
  });
  listenEntrance(window, 'keydown', event => {
    if (!event.repeat && !entranceDialog.open && event.key.toLowerCase() === 'e' && mode === 'eye' && eyePoint === 'entrance') { event.preventDefault(); openEntranceKeypad(); }
  });
  listenEntrance(byId('entrance-keypad'), 'click', openEntranceKeypad);

  function updateEnvironment() {
    const selected = environment.sunlight.sunCases.find(item => item.id === byId('sun-case').value);
    inspectionFill.visible = !selected && mode === 'eye' && eyePoint === 'entrance' && designMode === 'future' && !parkingCutaway;
    if (!selected) {
      sun.target.position.set(0, 0, 0); sun.position.set(-80, 145, 75); sun.intensity = 2;
      byId('solar-metrics').textContent = '고정 조명 · 일조 계산 아님';
    } else {
      const [east, north, up] = selected.directionEastNorthUp;
      sun.target.position.set(center.x, 0, center.z);
      sun.position.set(center.x + east * 250, up * 250, center.z - north * 250);
      sun.intensity = selected.aboveHorizon ? 2 : 0;
      const shadow = flatGroundShadowLengthM(heightM, selected.altitudeDeg);
      byId('solar-metrics').textContent = `${selected.label} · 고도 ${selected.altitudeDeg.toFixed(1)}° · 평지 그림자 길이 ${shadow === null ? '계산 불가' : `약 ${shadow.toFixed(1)}m`} · 근사값`;
    }
    sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
    const showNeighbours = byId('neighbour-masses').checked && !parkingCutaway;
    neighbourGroup.visible = showNeighbours;
    renderer.domElement.dataset.sunCase = selected?.id ?? 'art';
    renderer.domElement.dataset.neighbourHeightAssumption = showNeighbours ? 'verified_12_floors_times_assumed_3.2m_not_measured' : 'off';
    const designHeight = futureBuilding.userData.heightM;
    byId('environment-wind').textContent = `2050 외곽 간격/설계 높이(${designHeight.toFixed(1)}m): ${review.clearances.neighbourClearances.map(item => `${item.label} ${(item.distanceM / designHeight).toFixed(2)}`).join(' / ')}. 간격의 상대 크기만 비교하며 풍속·안전 한계값은 계산하지 않습니다.`;
    const layout = futureDesign.modules.layout;
    byId('module-summary').textContent = `공통 ${futureDesign.modules.profile.componentIds.length}모듈: 주거층·창호·쌍 발코니·양개문·광장·램프·관리 접점. 2050 모듈 주거 ${futureBuilding.userData.residentialFloorCount}층 / 한 면 ${layout.bayCount}베이·${layout.groupCount}쌍. 높이 변경 시 층·창호 간격을 재계산하고 문 크기는 유지합니다.`;
    renderer.domElement.dataset.inspectionFill = String(inspectionFill.visible);
  }
  byId('sun-case').disabled = false; byId('neighbour-masses').disabled = false;
  byId('sun-case').addEventListener('change', updateEnvironment);
  byId('neighbour-masses').addEventListener('change', updateEnvironment);

  function setView(nextMode) {
    mode = nextMode;
    if (mode !== 'eye') eyePoint = 'sidewalk';
    eyeDrag = null;
    camera = mode === 'plan' ? planCamera : perspectiveCamera;
    controls.enabled = mode === 'orbit';
    planControls.enabled = mode === 'plan';
    controls.enablePan = mode === 'orbit';
    controls.enableRotate = mode === 'orbit';
    controls.enableZoom = mode !== 'eye';
    human.visible = mode !== 'eye';
    humanLabel.node.hidden = mode === 'eye';
    if (camera.isPerspectiveCamera) camera.fov = 52;
    camera.updateProjectionMatrix();
    if (mode === 'eye') {
      const closeup = eyePoint === 'entrance' && designMode === 'future';
      const localBuilding = futureBuilding.getObjectByName('future-building-local');
      camera.position.copy(closeup ? new THREE.Vector3(0, data.referenceHuman.eyeHeightM, -futureDesign.building.depthM / 2 - 3.2).applyMatrix4(localBuilding.matrixWorld) : worldPoint(data.referenceHuman.positionLocalM, origin, data.referenceHuman.eyeHeightM));
      const target = closeup ? new THREE.Vector3(0, data.referenceHuman.eyeHeightM, -futureDesign.building.depthM / 2).applyMatrix4(localBuilding.matrixWorld) : worldPoint(centerLocal, origin, data.referenceHuman.eyeHeightM);
      inspectionFill.position.copy(camera.position); inspectionFill.position.y += 1;
      inspectionFill.target.position.copy(target); inspectionFill.target.updateMatrixWorld();
      const look = target.sub(camera.position);
      eyeYaw = Math.atan2(look.x, -look.z);
      eyePitch = Math.atan2(look.y, Math.hypot(look.x, look.z));
      updateEyeLook();
    } else if (mode === 'plan') {
      planControls.target.set((lower.x + upper.x) / 2, 0, (lower.z + upper.z) / 2);
      planCamera.position.set(planControls.target.x, Math.max(110, (upper.z - lower.z) * 1.25), planControls.target.z + .001);
      planCamera.zoom = 1;
      planCamera.updateProjectionMatrix();
      planControls.update();
    } else {
      controls.target.set(center.x - 10, heightM * .32, center.z - 4);
      camera.position.set(center.x - 87, Math.max(68, heightM * 1.55), center.z - 104);
      controls.update();
    }
    byId('view-label').textContent = mode === 'eye' && eyePoint === 'entrance' ? '입구 근접 · 눈높이' : modeNames[mode];
    byId('view-help').textContent = mode === 'eye' ? eyePoint === 'entrance' ? '공동현관 · E 또는 옆 키패드 클릭 · 시연 번호 2050 · 문 열림만 시연 / 이동·실내 미구현' : '같은 보도점의 눈높이 1.65m 고정 · 드래그: 둘러보기 · 창작 외관 시안'
      : mode === 'plan' ? '북쪽이 위 · 휠: 확대 · 높이 없는 주변 윤곽은 2D 참조입니다.' : '드래그: 회전 · 휠: 확대 · 오른쪽 드래그: 이동';
    for (const name of Object.keys(modeNames)) byId(`view-${name}`).setAttribute('aria-pressed', String(mode === name));
    byId('entrance-closeup').setAttribute('aria-pressed', String(mode === 'eye' && eyePoint === 'entrance'));
    renderer.domElement.dataset.eyePoint = mode === 'eye' ? eyePoint : 'none';
    updateEnvironment();
  }
  function updateEyeLook() {
    const direction = new THREE.Vector3(Math.sin(eyeYaw) * Math.cos(eyePitch), Math.sin(eyePitch), -Math.cos(eyeYaw) * Math.cos(eyePitch));
    camera.lookAt(camera.position.clone().add(direction));
  }
  const onPointerDown = event => {
    if (mode !== 'eye' || event.button !== 0) return;
    eyeDrag = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false};
    renderer.domElement.setPointerCapture(event.pointerId);
  };
  const onPointerMove = event => {
    if (!eyeDrag || event.pointerId !== eyeDrag.pointerId || mode !== 'eye') return;
    eyeDrag.moved ||= Math.hypot(event.clientX - eyeDrag.startX, event.clientY - eyeDrag.startY) > 5;
    eyeYaw -= (event.clientX - eyeDrag.x) * .005;
    eyePitch = Math.max(-1.3, Math.min(1.48, eyePitch - (event.clientY - eyeDrag.y) * .005));
    eyeDrag.x = event.clientX; eyeDrag.y = event.clientY;
    updateEyeLook();
  };
  const onPointerEnd = event => {
    if (eyeDrag?.pointerId !== event.pointerId) return;
    const clicked = event.type === 'pointerup' && !eyeDrag.moved; eyeDrag = null;
    if (!clicked || mode !== 'eye' || eyePoint !== 'entrance' || designMode !== 'future') return;
    const rect = renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(pointer, camera);
    if (ray.intersectObject(futureBuilding.getObjectByName('communal-entrance-keypad'), true).length) openEntranceKeypad();
  };
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerEnd);
  renderer.domElement.addEventListener('pointercancel', onPointerEnd);
  renderer.domElement.addEventListener('lostpointercapture', onPointerEnd);
  for (const name of Object.keys(modeNames)) {
    byId(`view-${name}`).disabled = false;
    byId(`view-${name}`).addEventListener('click', () => { eyePoint = 'sidewalk'; setView(name); });
  }
  function updateDesignMetrics() {
    byId('footprint-title').textContent = designMode === 'future' ? '새 동 외곽 · 2050 설계값' : '원자료 외곽 · 실제 측량값 아님';
    byId('footprint-size').textContent = designMode === 'future' ? `${futureDesign.building.lengthM} × ${futureDesign.building.depthM} m` : `${Math.max(...edgeLengths).toFixed(1)} × ${Math.min(...edgeLengths).toFixed(1)} m`;
    byId('height-value').textContent = heightM.toFixed(1).replace(/\.0$/, '');
    byId('floor-count').textContent = designMode === 'future' ? `${futureBuilding.userData.floorCount}층 · 주거 ${futureBuilding.userData.residentialFloorCount}` : `공식 ${currentEvidence.storeys}층 · 부피 높이는 가정`;
    byId('height-control').value = String(heightM);
    heightLabel.node.textContent = `${designMode === 'future' ? '2050 시안' : '원래 윤곽 · 임시'} ${heightM.toFixed(1).replace(/\.0$/, '')}m`;
    heightLabel.point.copy(worldPoint(centerLocal, origin, heightM + 1.8));
    renderer.domElement.dataset.designMode = designMode;
    byId('engineering-assumptions').textContent = designMode === 'source'
      ? '위 간격은 2050 시안의 입면 검사용 외곽 기준입니다. 현재 표시한 원래 윤곽의 간격이나 안전 판정이 아닙니다.'
      : `위 수치는 현재 평면 외곽 기준입니다. 표시 높이 ${heightM.toFixed(1)}m의 일조·바람·피난·구조는 미검증이며 높이를 바꾸면 재검토해야 합니다.`;
    byId('access-assumptions').textContent = designMode === 'source'
      ? '위 동선 기록은 2050 시안입니다. 원래 윤곽 비교에서는 새 통로·차량선·관리 공간을 숨깁니다.'
      : '지상 동선은 높이 0m 가정입니다. 실제 단차·유효폭·회전 궤적·보호 시설 성능·도로 연결 승인은 검증하지 않았습니다.';
    updateEnvironment();
  }
  function updateCutaway() {
    const cutaway = designMode === 'future' && parkingCutaway;
    ground.visible = !cutaway; zoneMeshes.forEach(({mesh}) => { mesh.visible = !cutaway; }); grid.visible = !cutaway;
    futureBuilding.visible = designMode === 'future';
    futureBuilding.getObjectByName('future-superstructure').visible = !cutaway;
    futureBuilding.getObjectByName('future-site-landscape').visible = !cutaway;
    byId('parking-cutaway').disabled = designMode !== 'future';
    byId('entrance-closeup').disabled = designMode !== 'future';
    byId('entrance-keypad').disabled = designMode !== 'future';
    byId('parking-cutaway').setAttribute('aria-pressed', String(cutaway));
    byId('design-state').textContent = cutaway ? '지표·상부 건물을 숨긴 지하 모식도 / 굴착 설계 아님' : designMode === 'future' ? `${exteriorIdentity.name} / 단지·도로 보존 · 창작 외관` : '원자료 외곽 비교 / 48m는 측정 높이 아님';
    renderer.domElement.dataset.parkingCutaway = String(cutaway);
    updateEnvironment();
  }
  function setDesign(nextMode) {
    designMode = nextMode; parkingCutaway = false; eyePoint = 'sidewalk'; entranceController.close();
    centerLocal = designMode === 'future' ? futureDesign.frame.centerLocalM : sourceCenterLocal;
    center.copy(worldPoint(centerLocal, origin));
    heightM = designMode === 'future' ? futureBuilding.userData.heightM : data.building.heightM;
    building.geometry.dispose(); buildingEdges.geometry.dispose();
    building.geometry = createPolygonGeometry(data.building.geometryLocalM, origin, data.building.heightM);
    buildingEdges.geometry = new THREE.EdgesGeometry(building.geometry);
    building.visible = designMode === 'source'; buildingEdges.visible = designMode === 'source';
    ground.geometry.dispose(); ground.geometry = createPolygonGeometry(designMode === 'future' ? withDisplayHole(groundOutline, futureDesign.parking.ramp.geometryLocalM) : groundOutline, origin);
    const siteZone = zoneMeshes.find(({zone}) => zone.id === futureDesign.siteZoneId);
    siteZone.mesh.geometry.dispose(); siteZone.mesh.geometry = createPolygonGeometry(designMode === 'future' ? withDisplayHole(siteZone.zone.geometryLocalM, futureDesign.parking.ramp.geometryLocalM) : siteZone.zone.geometryLocalM, origin);
    for (const choice of ['future', 'source']) byId(`design-${choice}`).setAttribute('aria-pressed', String(choice === designMode));
    updateDesignMetrics(); updateCutaway(); setView(mode);
  }
  for (const choice of ['future', 'source']) {
    byId(`design-${choice}`).disabled = false;
    byId(`design-${choice}`).addEventListener('click', () => setDesign(choice));
  }
  byId('parking-cutaway').disabled = false;
  byId('parking-cutaway').addEventListener('click', () => { parkingCutaway = !parkingCutaway; updateCutaway(); setView('plan'); });
  byId('entrance-closeup').addEventListener('click', () => {
    if (designMode !== 'future') return;
    parkingCutaway = false; eyePoint = 'entrance'; updateCutaway(); setView('eye');
  });
  byId('parking-metrics').textContent = `경사로 ${futureDesign.parking.ramp.lengthM} × ${futureDesign.parking.ramp.widthM}m · 0 → ${futureDesign.parking.ramp.endElevationM}m / 주차층 ${futureDesign.parking.deck.lengthM} × ${futureDesign.parking.deck.depthM}m. 주차대수 미산정.`;
  byId('height-control').disabled = false;
  byId('height-control').addEventListener('input', event => {
    const nextHeight = Number(event.target.value);
    if (!Number.isFinite(nextHeight) || nextHeight < 18 || nextHeight > 90) return;
    heightM = nextHeight;
    if (designMode === 'future') {
      scene.remove(futureBuilding); disposeArchitecture(futureBuilding);
      futureBuilding = createFutureApartment(futureDesign, origin, {heightM}); scene.add(futureBuilding); updateCutaway();
    } else {
      building.geometry.dispose(); buildingEdges.geometry.dispose();
      building.geometry = createPolygonGeometry(data.building.geometryLocalM, origin, heightM);
      buildingEdges.geometry = new THREE.EdgesGeometry(building.geometry);
    }
    updateDesignMetrics();
    if (mode === 'orbit') setView('orbit');
  });
  function resize() {
    const width = Math.max(1, stage.clientWidth), height = Math.max(1, stage.clientHeight);
    renderer.setSize(width, height, false);
    const aspect = width / height;
    perspectiveCamera.aspect = aspect;
    perspectiveCamera.updateProjectionMatrix();
    const planHeight = Math.max((upper.z - lower.z) * 1.13, (upper.x - lower.x) * 1.13 / aspect);
    planCamera.left = -planHeight * aspect / 2; planCamera.right = planHeight * aspect / 2;
    planCamera.top = planHeight / 2; planCamera.bottom = -planHeight / 2;
    planCamera.updateProjectionMatrix();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  function frame() {
    const nowMs = performance.now(), entranceSnapshot = entranceController.update(nowMs);
    const dt = Math.max(0, Math.min(.1, (nowMs - previousEntranceFrameMs) / 1000)); previousEntranceFrameMs = nowMs;
    entranceProgress += ((entranceSnapshot.state === 'open' ? 1 : 0) - entranceProgress) * Math.min(1, dt * 9);
    const entryModule = futureBuilding.getObjectByName('double-leaf-entrance-module');
    for (const [name, sign] of [['entrance-left-leaf', -1], ['entrance-right-leaf', 1]]) entryModule.getObjectByName(name).position.x = sign * (.78 + entryModule.userData.doorLeafTravelM * entranceProgress);
    renderer.domElement.dataset.entranceState = entranceSnapshot.state;
    renderer.domElement.dataset.entranceOpenFraction = entranceProgress.toFixed(3);
    const stateLabel = byId('entrance-state');
    stateLabel.hidden = designMode !== 'future' || mode !== 'eye' || eyePoint !== 'entrance';
    const stateText = entranceSnapshot.state === 'open' ? '공동현관 열림 · 5초 뒤 자동 닫힘 · 시연' : '공동현관 잠김 · E / 키패드 · 시연 2050';
    if (stateLabel.textContent !== stateText) stateLabel.textContent = stateText;
    if (mode === 'orbit') controls.update();
    if (mode === 'plan') planControls.update();
    renderer.render(scene, camera);
    const cameraHeight = `카메라 ${camera.position.y.toFixed(2)}m`;
    if (cameraHeight !== previousCameraHeight) {
      byId('camera-height').textContent = `카메라 ${camera.position.y.toFixed(2)}m`;
      previousCameraHeight = cameraHeight;
    }
    const width = stage.clientWidth, height = stage.clientHeight;
    const compassStart = center.clone().project(camera);
    const compassEnd = center.clone().add(new THREE.Vector3(0, 0, -10)).project(camera);
    const northAngle = Math.atan2((compassEnd.x - compassStart.x) * width, (compassEnd.y - compassStart.y) * height);
    byId('north-arrow').style.transform = `rotate(${northAngle}rad)`;
    const occupiedLabels = [];
    const priority = item => item === humanLabel ? 3 : item === heightLabel ? 2 : 1;
    for (const item of [...labels].sort((a, b) => priority(b) - priority(a))) {
      if (neighbourLabels.includes(item) && (!neighbourGroup.visible || item.point.x < lower.x || item.point.x > upper.x || item.point.z < lower.z || item.point.z > upper.z)) { item.node.hidden = true; continue; }
      if ((item === parkingLabel && !(designMode === 'future' && parkingCutaway)) || (item === heightLabel && parkingCutaway)) { item.node.hidden = true; continue; }
      if (item === humanLabel && mode === 'eye') { item.node.hidden = true; continue; }
      const point = item.point.clone().project(camera);
      const visible = point.z >= -1 && point.z <= 1 && Math.abs(point.x) < .95 && Math.abs(point.y) < .95;
      item.node.hidden = !visible;
      if (visible) {
        const x = (point.x * .5 + .5) * width, y = (-point.y * .5 + .5) * height;
        const halfWidth = item.node.offsetWidth / 2, halfHeight = item.node.offsetHeight / 2;
        const offsets = [[0, 0], [0, -30], [0, 30], [0, -60], [0, 60], [-90, 0], [90, 0]];
        let placement = null;
        for (const [dx, dy] of offsets) {
          const box = {left: x + dx - halfWidth - 4, right: x + dx + halfWidth + 4, top: y + dy - halfHeight - 3, bottom: y + dy + halfHeight + 3};
          if (box.left < 12 || box.right > width - 12 || box.top < 90 || box.bottom > height - 44) continue;
          if (occupiedLabels.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue;
          placement = {x: x + dx, y: y + dy, box}; break;
        }
        item.node.hidden = !placement;
        if (placement) {
          occupiedLabels.push(placement.box);
          item.node.style.left = `${placement.x}px`; item.node.style.top = `${placement.y}px`;
        }
      }
    }
  }
  const onVisibility = () => renderer.setAnimationLoop(document.hidden ? null : frame);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onVisibility);
  updateDesignMetrics(); updateCutaway(); resize(); setView('orbit'); frame();
  renderer.setAnimationLoop(frame);
  byId('pilot-loading').hidden = true;
  byId('pilot-status').textContent = `2050 한 동 시안 · 본체 비겹침·지정 보행 접점/차량 횡단 구간 검사 완료. 공학 ${review.checks.length}분야 미완료, ${revisionCount}분야 수정 필요. 지도면 ${data.surfaces.length}개·검토 도로 40m·1단위=1m. 단지 전체나 안전 검증 완성본은 아닙니다.`;
  renderer.domElement.dataset.sourceBuildingId = data.building.sourceId;
  renderer.domElement.dataset.unitScale = '1';
  renderer.domElement.dataset.architectureIdentity = exteriorIdentity.id;
  renderer.domElement.dataset.exteriorDetailProfile = futureBuilding.getObjectByName('future-building-local').userData.detailProfileId;
  renderer.domElement.dataset.engineeringStatus = review.status;
  renderer.domElement.dataset.sceneReady = 'true';
  disposePreview = () => {
    entranceHandlers.forEach(remove => remove());
    renderer.setAnimationLoop(null); resizeObserver.disconnect(); controls.dispose(); planControls.dispose();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onVisibility);
    const geometries = new Set(), materials = new Set();
    scene.traverse(object => { if (object.geometry) geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) materials.add(material); });
    geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose()); renderer.dispose();
  };
}

window.addEventListener('pagehide', event => {
  if (event.persisted) return; // Back/forward cache keeps this view and its GPU resources alive.
  disposePreview?.(); disposePreview = null;
});
loadPreview().catch(error => {
  byId('pilot-loading').hidden = false;
  byId('pilot-loading').textContent = `3D 미리보기를 열지 못했습니다. ${error.message} · 현재 2D 지도는 그대로 사용할 수 있습니다. Three.js 신규 설치는 승인 없이 진행하지 않습니다.`;
  byId('pilot-status').textContent = '3D 초기화 미완료 · 원자료나 기존 2D 지도를 변경하지 않았습니다.';
  console.error('Pilot initialization failed:', error);
});
