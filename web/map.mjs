const SVG_NS = 'http://www.w3.org/2000/svg';
const byId = (id) => document.getElementById(id);
const svg = byId('map');
const stage = byId('map-stage');
const state = { plan: null, mode: 'ground', selectedId: null, selectedRoadId: null, fit: null, view: null, drag: null, dragged: false, labels: [], anchors: [], zoom: 1 };
const categoryOrder = ['landuse', 'surface', 'green', 'water', 'rail_area', 'road_surface', 'school', 'facility', 'unknown', 'road', 'path', 'railway', 'building'];

function element(tag, attributes = {}, text = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== null) node.textContent = text;
  return node;
}

function ringPath(ring) {
  return ring.map((point, index) => `${index ? 'L' : 'M'}${point[0]},${-point[1]}`).join(' ') + ' Z';
}

function linePath(line) {
  return line.map((point, index) => `${index ? 'L' : 'M'}${point[0]},${-point[1]}`).join(' ');
}

function geometryPath(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return '';
  if (geometry.type === 'Polygon') return geometry.coordinates.map(ringPath).join(' ');
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flatMap((polygon) => polygon.map(ringPath)).join(' ');
  if (geometry.type === 'LineString') return linePath(geometry.coordinates);
  if (geometry.type === 'MultiLineString') return geometry.coordinates.map(linePath).join(' ');
  return '';
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]; const b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  return pointInRing(point, polygon[0]) && !polygon.slice(1).some((ring) => pointInRing(point, ring));
}

function polygonArea(ring) {
  return Math.abs(ring.reduce((sum, a, i) => { const b = ring[(i + 1) % ring.length]; return sum + a[0] * b[1] - b[0] * a[1]; }, 0) / 2);
}

function labelPoint(zone) {
  const polygons = zone.geometry.type === 'MultiPolygon' ? zone.geometry.coordinates : [zone.geometry.coordinates];
  const boundary = state.plan.boundary.coordinates;
  const valid = (point, polygon) => pointInPolygon(point, polygon) && pointInPolygon(point, boundary);
  if (Array.isArray(zone.labelPoint) && polygons.some((polygon) => valid(zone.labelPoint, polygon))) return zone.labelPoint;
  const sorted = [...polygons].sort((a, b) => polygonArea(b[0]) - polygonArea(a[0]));
  for (const polygon of sorted) {
    const ring = polygon[0];
    const xs = ring.map((point) => point[0]); const ys = ring.map((point) => point[1]);
    const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
    const middle = [(minX + maxX) / 2, (minY + maxY) / 2];
    if (valid(middle, polygon)) return middle;
    let best = null; let bestDistance = Infinity;
    for (let row = 1; row < 20; row++) for (let column = 1; column < 20; column++) {
      const candidate = [minX + (maxX - minX) * column / 20, minY + (maxY - minY) * row / 20];
      if (valid(candidate, polygon)) {
        const distance = (candidate[0] - middle[0]) ** 2 + (candidate[1] - middle[1]) ** 2;
        if (distance < bestDistance) { best = candidate; bestDistance = distance; }
      }
    }
    if (best) return best;
  }
  return null;
}

function featureNode(feature, className = feature.category) {
  if (feature.geometry.type === 'Point') {
    return element('circle', { cx: feature.geometry.coordinates[0], cy: -feature.geometry.coordinates[1], r: 2, class: `feature ${className}`, 'data-feature-id': feature.id });
  }
  const path = geometryPath(feature.geometry);
  if (!path) return null;
  const node = element('path', { d: path, class: `feature ${className}`, 'fill-rule': 'evenodd', 'data-feature-id': feature.id });
  if (feature.category==='building') {
    if (feature.zoneId) node.dataset.zoneId=feature.zoneId;
    if (feature.complexId) node.dataset.complexId=feature.complexId;
    node.append(element('title',{},`${feature.name}${feature.complexAssignmentStatus==='official_membership_override_source_parcel_conflict' ? ' · 공식 단지 소속 보정 / 원자료 부지 외곽 충돌 미해결' : ''}`));
  }
  // ViewBox units are metres; CSS symbolic strokes must not override measured widths.
  if (['road','road-edge','path'].includes(className) && Number.isFinite(feature.roadWidthM) && feature.roadWidthM > 0 && ['measured_estimate','official_actual'].includes(feature.roadWidthStatus)) {
    node.style.vectorEffect = 'none';
    node.style.strokeWidth = String(feature.roadWidthM + (className === 'road-edge' ? .25 : 0));
    node.style.strokeDasharray = 'none';
    node.style.strokeLinecap = 'butt';
    node.dataset.widthM = String(feature.roadWidthM);
  }
  return node;
}

function renderMap() {
  const plan = state.plan;
  svg.replaceChildren();
  state.labels = []; state.anchors = [];
  svg.dataset.mode = state.mode;
  const defs = element('defs');
  const clip = element('clipPath', { id: 'boundary-clip', clipPathUnits: 'userSpaceOnUse' });
  clip.append(element('path', { d: geometryPath(plan.boundary), 'clip-rule': 'evenodd' }));
  defs.append(clip);
  const parking = element('pattern', { id: 'parking-hatch', width: 10, height: 10, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(40)' });
  parking.append(element('rect', { width: 10, height: 10, fill: '#e0e9ef' }), element('path', { d: 'M 0 0 V 10', stroke: '#92a8b9', 'stroke-width': 1.5 }));
  const roof = element('pattern', { id: 'roof-pattern', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-25)' });
  roof.append(element('path', { d: 'M 0 0 V 6', stroke: '#76a596', 'stroke-width': .8 }));
  defs.append(parking, roof); svg.append(defs);
  svg.append(element('path', { d: geometryPath(plan.boundary), class: 'map-boundary', 'fill-rule': 'evenodd' }));
  const clipped = element('g', { 'clip-path': 'url(#boundary-clip)' });
  const context = element('g', { class: 'feature-layer context-layer' });
  const zoneLayer = element('g', { class: 'zone-layer' });
  const features = element('g', { class: 'feature-layer' });
  const transport = element('g', { class: 'feature-layer transport-layer' });
  const surveyLayer = element('g', { class:'survey-layer' });
  const roofs = element('g', { class: 'roof-layer' });
  const labelLayer = element('g', { class: 'zone-label-layer' });
  const anchorLayer = element('g', { class: 'anchor-layer' });
  const zonesById = new Map(plan.zones.map((zone) => [zone.id, zone]));
  const orderedFeatures = [...plan.features].sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category));
  const baseCategories = new Set(['landuse', 'surface', 'green', 'water', 'rail_area', 'road_surface']);
  for (const feature of orderedFeatures) {
    if (!feature.geometry) continue;
    const target = baseCategories.has(feature.category) ? context : ['road','path','railway'].includes(feature.category) ? transport : features;
    if (feature.category === 'road' && ['LineString', 'MultiLineString'].includes(feature.geometry.type)) {
      const edge = featureNode(feature, 'road-edge'); if (edge) target.append(edge);
    }
    const node = featureNode(feature); if (node) target.append(node);
    if (feature.category === 'building' && zonesById.get(feature.zoneId)?.kind === 'residential') {
      roofs.append(element('path', { d: geometryPath(feature.geometry), class: 'roof-design', 'fill-rule': 'evenodd' }));
    }
  }
  for (const surface of plan.roadSurvey?.surfaces || []) {
    const node = element('path',{d:geometryPath(surface.geometry),class:`survey-surface ${surface.kind}`,'fill-rule':'evenodd','data-survey-id':surface.id});
    surveyLayer.append(node);
  }
  for (const feature of plan.features) for (const section of feature.roadWidthSegments || []) {
    if (!(section.widthM > 0) || !['measured_estimate','official_actual'].includes(section.status)) continue;
    const node = element('path',{d:geometryPath(section.localGeometry),class:`survey-width-section ${section.widthKind}`,'data-section-id':section.id,'data-width-m':section.widthM});
    node.style.strokeWidth=String(section.widthM);
    surveyLayer.append(node);
  }
  for (const zone of plan.zones) {
    const node = element('path', { d: geometryPath(zone.geometry), class: `map-zone ${zone.kind}`, 'fill-rule': 'evenodd', 'data-zone-id': zone.id });
    node.append(element('title', {}, `${zone.name} · ${zone.kind === 'school' ? '학교' : zone.kind === 'commercial' ? '생활 중심지' : '주거'} 계획`));
    node.addEventListener('click', () => { if (!state.dragged) selectZone(zone.id); });
    zoneLayer.append(node);
    const point = labelPoint(zone);
    if (point) {
      const group = element('g', { class: 'zone-label-group' });
      const leader = element('path', { class: 'label-leader', visibility: 'hidden' });
      const background = element('rect', { class: 'selected-label-background', visibility: 'hidden' });
      const dot = element('circle', { cx: point[0], cy: -point[1], class: 'commercial-dot', 'data-zone-id': zone.id, visibility: zone.kind === 'commercial' ? 'visible' : 'hidden' });
      dot.append(element('title', {}, zone.name));
      const label = element('text', { x: point[0], y: -point[1], class: `zone-label ${zone.kind}`, 'data-zone-id': zone.id }, zone.name);
      group.append(leader, background, dot, label);
      labelLayer.append(group); state.labels.push({ node: label, group, leader, background, dot, zone, point });
    }
  }
  for (const anchor of plan.anchors || []) {
    if (!Array.isArray(anchor.point) || !pointInPolygon(anchor.point, plan.boundary.coordinates)) continue;
    const group = element('g');
    const dot = element('circle', { cx: anchor.point[0], cy: -anchor.point[1], class: 'anchor-dot', r: 2 });
    const label = element('text', { x: anchor.point[0], y: -anchor.point[1], class: 'anchor-label' }, anchor.name);
    group.append(dot, label); anchorLayer.append(group); state.anchors.push({ label, dot, point: anchor.point });
  }
  const selected = element('path', { id: 'selected-outline', class: 'selection-outline', 'fill-rule': 'evenodd', visibility: 'hidden' });
  const selectedRoad = element('path', {id:'selected-road-outline', class:'road-selection', visibility:'hidden'});
  const roadCrossSections = element('g', {id:'selected-road-cross-sections',class:'road-cross-sections'});
  clipped.append(context, zoneLayer, transport, surveyLayer, features, roofs, selected, selectedRoad, roadCrossSections);
  // Only geometry is clipped. Cartographic labels may extend beyond the planning boundary.
  svg.append(clipped, labelLayer, anchorLayer);
}

function overviewName(zone) {
  if (zone.kind === 'residential') return zone.name.trim().split(/\s+/).slice(0, 2).join(' ');
  if (zone.kind === 'school') return `${zone.name.match(/초등|중등|고등/)?.[0] || '학교'}캠퍼스`;
  return zone.name.includes('코어') ? '코어 2050' : zone.name;
}

function labelPriority(zone) {
  if (zone.id === state.selectedId) return 100;
  if (zone.kind === 'commercial' && zone.name.includes('코어')) return 90;
  if (zone.kind === 'school') return 80;
  return zone.kind === 'residential' ? 40 : 10;
}

function fitView() {
  if (!state.plan) return;
  const bounds = state.plan.bounds; const rectangle = stage.getBoundingClientRect();
  const aspect = Math.max(rectangle.width, 1) / Math.max(rectangle.height, 1);
  let width = (bounds.maxX - bounds.minX) * 1.12; let height = (bounds.maxY - bounds.minY) * 1.12;
  if (width / height < aspect) width = height * aspect; else height = width / aspect;
  const view = { x: (bounds.minX + bounds.maxX - width) / 2, y: -(bounds.minY + bounds.maxY + height) / 2, width, height };
  state.fit = { ...view }; state.view = { ...view }; state.zoom = 1; updateView();
}

function updateView() {
  const view = state.view; if (!view) return;
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
  const metersPerPixel = view.width / Math.max(stage.clientWidth, 1);
  byId('zoom-level').textContent = `${Math.round(state.zoom * 100)}%`;
  const width = stage.clientWidth; const height = stage.clientHeight;
  const occupied = [{ left: 0, right: 190, top: 0, bottom: 47 }, { left: width - 55, right: width, top: 0, bottom: 77 }, { left: width - 104, right: width, top: height - 105, bottom: height }];
  const selectedFirst = [...state.labels].sort((a, b) => labelPriority(b.zone) - labelPriority(a.zone));
  for (const { node, group, leader, background, dot, zone, point } of selectedFirst) {
    const selected = zone.id === state.selectedId;
    const detailed = selected || state.zoom > 1.8;
    const size = (selected ? 12 : zone.kind === 'school' ? 10 : 9.5) * metersPerPixel;
    node.textContent = detailed ? zone.name : overviewName(zone);
    node.setAttribute('font-size', size); node.setAttribute('stroke-width', 3.6 * metersPerPixel);
    dot.setAttribute('r', (selected ? 4.5 : 3.2) * metersPerPixel);
    leader.setAttribute('visibility', 'hidden'); background.setAttribute('visibility', 'hidden');
    const originalX = (point[0] - view.x) / metersPerPixel; const originalY = (-point[1] - view.y) / metersPerPixel;
    const onScreen = originalX >= 0 && originalX <= width && originalY >= 0 && originalY <= height;
    const showText = selected || (onScreen && (zone.kind !== 'commercial' || detailed || zone.name.includes('코어')));
    const textWidth = Math.min(node.getComputedTextLength() / metersPerPixel, width - 40);
    if (node.getComputedTextLength() / metersPerPixel > width - 40) { node.setAttribute('textLength', textWidth * metersPerPixel); node.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
    else { node.removeAttribute('textLength'); node.removeAttribute('lengthAdjust'); }
    const halfWidth = textWidth / 2 + (selected ? 9 : 5); const halfHeight = selected ? 13 : 10;
    const offsets = zone.kind === 'commercial' ? [[0, -17], [0, 17], [0, -33], [0, 33]] : [[0, 0], [0, -20], [0, 20], [-25, 0], [25, 0], [0, -39], [0, 39]];
    let placement = null;
    if (showText) for (const [dx, dy] of offsets) {
      const x = Math.max(halfWidth + 12, Math.min(width - halfWidth - 12, originalX + dx));
      const y = Math.max(halfHeight + 53, Math.min(height - halfHeight - 27, originalY + dy));
      const box = { left: x - halfWidth, right: x + halfWidth, top: y - halfHeight, bottom: y + halfHeight };
      const overlaps = occupied.some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top);
      if (selected || !overlaps) { placement = { x, y, box }; break; }
    }
    node.setAttribute('visibility', placement ? 'visible' : 'hidden');
    if (placement) {
      occupied.push(placement.box);
      const x = view.x + placement.x * metersPerPixel; const y = view.y + placement.y * metersPerPixel;
      node.setAttribute('x', x); node.setAttribute('y', y);
      if (Math.hypot(placement.x - originalX, placement.y - originalY) > 10) {
        leader.setAttribute('d', `M ${point[0]} ${-point[1]} L ${x} ${y}`); leader.setAttribute('visibility', 'visible');
      }
      if (selected) {
        background.setAttribute('x', view.x + placement.box.left * metersPerPixel); background.setAttribute('y', view.y + placement.box.top * metersPerPixel);
        background.setAttribute('width', (placement.box.right - placement.box.left) * metersPerPixel); background.setAttribute('height', (placement.box.bottom - placement.box.top) * metersPerPixel);
        background.setAttribute('rx', 4 * metersPerPixel); background.setAttribute('visibility', 'visible'); group.parentNode.append(group);
      }
    }
  }
  for (const { label, dot, point } of state.anchors) {
    label.setAttribute('font-size', 10 * metersPerPixel); label.setAttribute('stroke-width', 3.5 * metersPerPixel);
    label.setAttribute('x', point[0] + 7 * metersPerPixel); label.setAttribute('y', -point[1] - 7 * metersPerPixel);
    dot.setAttribute('r', 2.4 * metersPerPixel);
    const textWidth = label.getComputedTextLength();
    label.setAttribute('x', Math.max(view.x + 14 * metersPerPixel, Math.min(view.x + view.width - textWidth - 14 * metersPerPixel, point[0] + 7 * metersPerPixel)));
  }
  const desiredMeters = 80 * metersPerPixel;
  const exponent = 10 ** Math.floor(Math.log10(desiredMeters));
  const steps = [1, 2, 5, 10];
  const distance = (steps.find((step) => step * exponent >= desiredMeters) || 10) * exponent;
  byId('scale-label').textContent = distance >= 1000 ? `${distance / 1000} km` : `${distance} m`;
  byId('scale-line').style.width = `${distance / metersPerPixel}px`;
}

function zoomAt(factor, clientX = null, clientY = null) {
  if (!state.view) return;
  const rectangle = svg.getBoundingClientRect();
  const fractionX = clientX === null ? .5 : (clientX - rectangle.left) / rectangle.width;
  const fractionY = clientY === null ? .5 : (clientY - rectangle.top) / rectangle.height;
  const nextZoom = Math.max(.7, Math.min(24, state.zoom * factor));
  const ratio = state.zoom / nextZoom; const view = state.view;
  const nextWidth = view.width * ratio; const nextHeight = view.height * ratio;
  state.view = { x: view.x + (view.width - nextWidth) * fractionX, y: view.y + (view.height - nextHeight) * fractionY, width: nextWidth, height: nextHeight };
  state.zoom = nextZoom; updateView();
}

function listContent(id, entries, fallback) {
  const list = byId(id); list.replaceChildren();
  for (const entry of Array.isArray(entries) && entries.length ? entries : [fallback]) {
    const item = document.createElement('li'); item.textContent = String(entry); list.append(item);
  }
}

function selectRoad(id) {
  const feature=state.plan?.features.find(entry=>entry.id===id && entry.roadWidthStatus);
  const outline=byId('selected-road-outline');
  const crossSections=byId('selected-road-cross-sections');
  crossSections?.replaceChildren();
  if (!feature) {
    state.selectedRoadId=null; outline?.setAttribute('visibility','hidden');
    byId('road-width-detail').textContent='구간을 선택하면 실제 폭과 별도 참조를 확인합니다.';
    byId('road-width-references').replaceChildren();
    return;
  }
  state.selectedRoadId=id;
  outline.setAttribute('d',geometryPath(feature.geometry)); outline.setAttribute('visibility','visible');
  const kind=feature.roadWidthKind==='carriageway' ? '차도' : feature.roadHighway==='cycleway' ? '자전거길' : '보행로';
  const actual=feature.roadWidthM == null ? (feature.roadWidthSegments?.length || feature.roadCrossProfiles?.length ? '전 구간 단일 폭 미확정 · 부분 구간 추정값 있음' : '미측정') : `${feature.roadWidthM}m (${feature.roadWidthStatus==='official_actual' ? '공식 실폭' : '측정 추정'})`;
  const range=feature.roadWidthRangeM ? ` · 범위 ${feature.roadWidthRangeM.join('–')}m` : '';
  byId('road-width-detail').textContent=`${id} · 경계 안 길이 약 ${Math.round(feature.roadInsideLengthM)}m · ${kind} 폭 ${actual}${range}`;
  const survey=state.plan.metadata.roadWidths;
  const refs=survey.officialReferences.filter(ref=>feature.roadWidthOfficialReferenceIds?.includes(ref.id));
  const notes=refs.map(ref=>`${ref.roadName} 등록 폭 ${ref.corridorWidthM}m · ${ref.id} · 행정 갱신 ${ref.sourceWorkTimestamp?.slice(0,8) || '시점 미상'} (실측일 아님) · 현재 ${kind} 폭 아님`);
  const profileNotes=[];
  const componentNames={mapped_road_boundary:'인도 포함 지도 도로면',left_walkway:'좌측 보도면',right_walkway:'우측 보도면',carriageway:'경계석 사이 차량공간'};
  for (const profile of feature.roadCrossProfiles || []) {
    profileNotes.push(`로드뷰 경계 배치 대조: 원본 선 ${profile.partIndex+1}번 부분·${profile.originalSegmentIndex+1}번 직선 시작부터 ${profile.startAlongSegmentM.toFixed(1)}–${profile.endAlongSegmentM.toFixed(1)}m (${(profile.endAlongSegmentM-profile.startAlongSegmentM).toFixed(0)}m 구간만·표시 단면 ${profile.samples.length}개). 좌우는 원본 선 진행 방향 기준입니다.`);
    for (const component of profile.components) {
      profileNotes.push(`${componentNames[component.kind]}: ${component.widthM==null ? '미검토 후보' : `약 ${component.widthM.toFixed(1)}m`} · ${component.rangeM ? `표본 범위 ${component.rangeM.map(value=>value.toFixed(2)).join('–')}m` : '실제 폭 미확정'} · 현장 실측/오차범위 아님`);
    }
    if (profile.reviewStatus==='curb_layout_visually_reviewed') {
      profileNotes.push(`촬영 ${profile.review.imageryDate || '시점 미상'} · 확인 ${profile.review.observedOn}. 수치는 2025 공식 지도 기하에서 계산했으며 사진은 경계석 배치의 의미를 확인했습니다.`);
      profileNotes.push(...profile.review.observations);
    }
  }
  notes.push(...profileNotes);
  for (const deferred of feature.roadWidthDeferrals || []) {
    notes.push(`폭 검토 보류: ${deferred.summaryKo || `${deferred.id || feature.id} · ${deferred.reasons.join(' / ')}`}`);
  }
  const segments=feature.roadWidthSegments || [];
  if (segments.length) {
    notes.push(`이 길의 보도 기하 추정 ${segments.length}개 구간 · 약 ${Math.round(feature.roadEstimatedInsideLengthM)}m. 나머지 약 ${Math.round(feature.roadUnmeasuredInsideLengthM)}m는 미확인입니다.`);
    for (const section of segments) notes.push(`경계 안 선 시작부터 ${section.startM.toFixed(1)}–${section.endM.toFixed(1)}m: 보도 폭 약 ${section.widthM.toFixed(1)}m · 관찰 범위 ${section.rangeM.map(value=>value.toFixed(1)).join('–')}m (통계 오차 아님)`);
  }
  const surfaceSections=feature.roadSurfaceSections || [];
  if (surfaceSections.length) {
    const length=surfaceSections.reduce((sum,section)=>sum+section.endM-section.startM,0);
    notes.push(`지도 도로면 횡단폭 ${surfaceSections.length}구간 · 약 ${Math.round(length)}m. 2025년 A001 윤곽의 기하 추정이며 실제 차도폭은 미확정입니다. 파란 가로선은 계산한 횡단 위치입니다.`);
    for (const section of surfaceSections) {
      notes.push(`경계 안 선 시작부터 ${section.startM.toFixed(1)}–${section.endM.toFixed(1)}m: 도로면 약 ${section.widthM.toFixed(1)}m · 관찰 범위 ${section.rangeM.map(value=>value.toFixed(1)).join('–')}m (정확도·통계 오차 아님)`);
      for (const sample of section.crossSections) {
        const node=element('path',{d:linePath(sample.line),class:'road-cross-section','data-section-id':section.id,'data-width-m':sample.widthM});
        node.append(element('title',{},`지도 도로면 약 ${sample.widthM.toFixed(1)}m · 실제 차도폭 미확정`));
        crossSections.append(node);
      }
    }
    notes.push('도로면 거리값은 EPSG:5186 투영좌표계의 미터이며, 원본 선을 행정경계 안으로 잘라 이어 센 거리입니다. 표시 소수점은 측량 정확도를 뜻하지 않습니다.');
  }
  for (const profile of feature.roadCrossProfiles || []) for (const sample of profile.samples) {
    for (const [component,line] of [['carriageway',sample.carriagewayLineLocalM],['left_walkway',sample.leftWalkwayLineLocalM],['right_walkway',sample.rightWalkwayLineLocalM]]) {
      if (!line) continue;
      const width=profile.components.find(entry=>entry.kind===component).widthM;
      const node=element('path',{d:linePath(line),class:`curb-cross-section ${component}`,'data-profile-id':profile.id,'data-component':component});
      node.append(element('title',{},`${componentNames[component]} 약 ${width.toFixed(1)}m · ${(profile.endAlongSegmentM-profile.startAlongSegmentM).toFixed(0)}m 구간의 지도 추정`));
      crossSections.append(node);
    }
  }
  const officialSections=feature.roadWidthOfficialSections || [];
  if (officialSections.length) {
    const values=officialSections.flatMap(section=>section.sourceWidthRangeM);
    notes.push(`2025 수치지도 경계석 외측/길어깨 폭 참조 ${officialSections.length}개 구간 · ${Math.min(...values)}–${Math.max(...values)}m. 순수 차도폭으로 확정한 값은 아닙니다.`);
  }
  for (const ref of survey.mapRepresentationReferences.filter(ref=>feature.roadWidthMapRepresentationEvidenceIds?.includes(ref.id))) notes.push(`기존 지도 표현 범위 ${ref.rangeM.join('–')}m · 차도·보도 분리 실측 아님`);
  if (feature.roadWidthOfficialAssociationStatus==='multiple_width_references') notes.push('여러 등록 폭이 대응되어 위치별 폭 확인이 필요합니다.');
  if (feature.roadLevelStatus==='bridge_tunnel_or_layer_alignment_unverified') notes.push('교량·터널·층위 대응은 추가 검증이 필요합니다.');
  listContent('road-width-references',notes,'확인된 실제 폭 또는 대응 등록 폭 자료가 없습니다.');
}

function loadRoadSurvey(plan) {
  const survey=plan.metadata?.roadWidths;
  const roads=plan.features.filter(feature=>feature.roadWidthStatus);
  const summary=survey?.summary;
  const sections=survey?.sectionSummary;
  const crossProfiles=survey?.crossProfileSummary;
  byId('road-width-summary').textContent=summary ? `조사 대상: 차량도로 ${summary.roadLines}개 선 · 보행/자전거/계단 ${summary.pathLines}개 선. ${crossProfiles ? `차도·양측 보도 경계 배치 대조 ${crossProfiles.visuallyReviewedProfileCount}구간/${crossProfiles.reviewedNativeSectionLengthM}m (현장 실측 아님). ` : ''}${sections ? `정밀 도엽 ${plan.roadSurvey.tileIds.length}개 · 지도 도로면 횡단폭 ${sections.roadSurfaceReferenceSections || 0}구간/약 ${Math.round(sections.roadSurfaceReferenceLengthM || 0)}m · 보도 기하 추정 ${sections.estimatedWalkwaySections}구간/약 ${Math.round(sections.estimatedInsideLengthM)}m · 도로 폭 속성 참조 ${sections.officialWidthReferenceSections}구간. 도로 전체의 실제 폭 검증은 미완료입니다.` : `실제 폭 입력 ${survey.explicitWidthCount}/${survey.recordCount}개 선. 등록 폭 참조는 별도입니다.`}` : '도로 폭 조사가 아직 연결되지 않았습니다.';
  const select=byId('road-select'); select.replaceChildren();
  const prompt=document.createElement('option'); prompt.value=''; prompt.textContent='구간을 선택하세요'; select.append(prompt);
  for (const road of roads.sort((a,b)=>(a.name||'').localeCompare(b.name||'','ko')||a.id.localeCompare(b.id))) {
    const option=document.createElement('option'); option.value=road.id;
    option.textContent=`${road.name || '이름 없는 길'} · ${road.roadHighway || road.category} · ${road.id}`;
    select.append(option);
  }
  select.disabled=roads.length===0;
}

function selectZone(id) {
  const zone = state.plan?.zones.find((entry) => entry.id === id); if (!zone) return;
  state.selectedId = zone.id; byId('zone-select').value = zone.id;
  byId('zone-name').textContent = zone.name; byId('zone-description').textContent = zone.description || '선택한 구역의 미래 계획을 확인하실 수 있습니다.';
  listContent('preservation-list', zone.preservation, '구체적인 보존 요소는 추가 확인이 필요합니다.');
  listContent('future-list', zone.future, '세부 지상 계획은 아직 정하지 않았습니다.');
  const architecture = zone.architectureIdentity || state.plan.zones.find(entry=>entry.kind==='residential' && zone.complexId && entry.complexId===zone.complexId)?.architectureIdentity;
  byId('architecture-identity').hidden = !architecture;
  byId('architecture-features').replaceChildren();
  if (architecture) {
    byId('architecture-name').textContent = architecture.name;
    byId('architecture-family').textContent = `${architecture.familyName} · ${architecture.phaseLabel}`;
    for (const feature of architecture.features) {
      const label = document.createElement('dt'); label.textContent = feature.label;
      const description = document.createElement('dd'); description.textContent = feature.description;
      byId('architecture-features').append(label, description);
    }
    byId('architecture-note').textContent = architecture.note;
  }
  listContent('underground-list', zone.underground, '구체적인 지하 시설 계획은 아직 정하지 않았습니다.');
  for (const node of svg.querySelectorAll('[data-zone-id]')) node.classList.toggle('is-selected', node.dataset.zoneId === zone.id);
  const outline = byId('selected-outline'); outline.setAttribute('d', geometryPath(zone.geometry)); outline.setAttribute('visibility', 'visible');
  updateView();
}

function setMode(mode) {
  state.mode = mode; svg.dataset.mode = mode;
  byId('ground-mode').setAttribute('aria-pressed', String(mode === 'ground'));
  byId('underground-mode').setAttribute('aria-pressed', String(mode === 'underground'));
  byId('underground-legend').hidden = mode !== 'underground';
  document.querySelector('.notice-index').textContent = mode === 'ground' ? 'GROUND' : 'UNDERGROUND';
  byId('mode-description').textContent = mode === 'ground' ? '기존 배치 위의 색칠·지붕선·명칭은 2050년 창작 계획입니다.' : '해칭은 지하 시설의 구상 범위입니다. 실제 매설물·주차장 입구·진출입 위치는 미확정입니다.';
}

function validatePlan(plan) {
  if (!plan || plan.year !== 2050 || !plan.bounds || !plan.boundary || plan.boundary.type !== 'Polygon' || !Array.isArray(plan.zones) || !Array.isArray(plan.features)) throw new Error('계획 데이터의 형식이 올바르지 않습니다.');
  const { minX, minY, maxX, maxY } = plan.bounds;
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) throw new Error('계획도의 좌표 범위를 확인할 수 없습니다.');
  if (!Array.isArray(plan.boundary.coordinates?.[0]) || plan.boundary.coordinates[0].length < 4) throw new Error('계획 경계를 확인할 수 없습니다.');
  for (const zone of plan.zones) if (!zone.id || !zone.name || !['Polygon', 'MultiPolygon'].includes(zone.geometry?.type)) throw new Error('일부 구역의 형식이 올바르지 않습니다.');
}

async function loadPlan() {
  byId('map-loading').hidden = false; byId('map-loading').classList.remove('has-error'); byId('retry-button').hidden = true;
  byId('loading-text').textContent = '구일의 공간을 준비하고 있습니다.';
  byId('data-status').classList.remove('error'); byId('data-status').textContent = '계획 데이터를 불러오고 있습니다.';
  try {
    const response = await fetch('/plan2050.json', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`계획 데이터를 불러오지 못했습니다. (${response.status})`);
    const plan = await response.json(); validatePlan(plan); state.plan = plan;
    byId('road-map-note').textContent = plan.roadSurvey ? '2025 공식 도로·보도 윤곽 / 점선은 폭 미확인 중심선 / 선로는 기호 / 경계는 잠정 범위' : '경계는 계획용 잠정 범위입니다. 폭 미확인 중심선·선로는 기호입니다.';
    byId('residential-count').textContent = String(plan.stats?.residentialZones ?? plan.zones.filter((zone) => zone.kind === 'residential').length);
    byId('school-count').textContent = String(plan.stats?.schools ?? plan.zones.filter((zone) => zone.kind === 'school').length);
    byId('commercial-count').textContent = String(plan.stats?.commercialZones ?? plan.zones.filter((zone) => zone.kind === 'commercial').length);
    byId('building-count').textContent = String(plan.stats?.buildings ?? plan.features.filter((feature) => feature.category === 'building').length);
    byId('data-status').textContent = `원자료 ${Number(plan.stats?.sourceFeatures ?? plan.features.length).toLocaleString('ko-KR')}개 요소 보존${plan.roadSurvey ? ` · 정밀 지도 ${plan.roadSurvey.tileIds.length}개 도엽 반영` : ''}.`;
    const select = byId('zone-select'); select.replaceChildren();
    const prompt = document.createElement('option'); prompt.value = ''; prompt.textContent = '지도에서 구역을 선택하세요'; select.append(prompt);
    for (const zone of plan.zones) { const option = document.createElement('option'); option.value = zone.id; option.textContent = zone.name; select.append(option); }
    select.disabled = false;
    listContent('notices-list', plan.notices, '계획 경계와 미래 설계는 검토용 시나리오입니다.');
    byId('sources').replaceChildren();
    const roadSources=(plan.metadata?.roadWidths?.sources || []).flatMap(source=>source.url ? [{title:source.title,url:source.url},...(source.semanticSourceURL ? [{title:'도로 등록 폭 속성의 의미 · 주소정보누리집',url:source.semanticSourceURL}] : [])] : []);
    for (const source of [...(plan.sources || []),...roadSources]) {
      let url; try { url = new URL(source.url, location.href); } catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = `${source.title} ↗`; byId('sources').append(link);
    }
    renderMap(); fitView(); setMode(state.mode); loadRoadSurvey(plan);
    if (state.selectedId) selectZone(state.selectedId);
    if (state.selectedRoadId) { byId('road-select').value=state.selectedRoadId; selectRoad(state.selectedRoadId); }
    byId('map-loading').hidden = true;
  } catch (error) {
    byId('map-loading').classList.add('has-error'); byId('retry-button').hidden = false;
    byId('loading-text').textContent = error instanceof Error ? error.message : '계획 데이터를 불러오지 못했습니다.';
    byId('data-status').textContent = '데이터를 불러오지 못했습니다. 다시 불러오기를 눌러 주세요.'; byId('data-status').classList.add('error');
  }
}

byId('ground-mode').addEventListener('click', () => setMode('ground'));
byId('underground-mode').addEventListener('click', () => setMode('underground'));
byId('zone-select').addEventListener('change', (event) => selectZone(event.target.value));
byId('road-select').addEventListener('change', (event) => selectRoad(event.target.value));
byId('zoom-in').addEventListener('click', () => zoomAt(1.35));
byId('zoom-out').addEventListener('click', () => zoomAt(1 / 1.35));
byId('fit-view').addEventListener('click', fitView);
byId('retry-button').addEventListener('click', loadPlan);
svg.addEventListener('wheel', (event) => { if (!state.view) return; event.preventDefault(); const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1); zoomAt(Math.exp(-Math.max(-250, Math.min(250, delta)) * .002), event.clientX, event.clientY); }, { passive: false });
svg.addEventListener('pointerdown', (event) => {
  if (!state.view || !event.isPrimary || event.button !== 0) return;
  state.dragged = false; state.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view: { ...state.view }, zoneId: event.target.closest('[data-zone-id]')?.dataset.zoneId };
  svg.setPointerCapture(event.pointerId); svg.classList.add('is-dragging');
});
svg.addEventListener('pointermove', (event) => {
  const drag = state.drag; if (!drag || drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
  if (Math.hypot(dx, dy) > 4) state.dragged = true;
  if (!state.dragged) return;
  state.view = { ...drag.view, x: drag.view.x - dx * drag.view.width / Math.max(svg.clientWidth, 1), y: drag.view.y - dy * drag.view.height / Math.max(svg.clientHeight, 1) }; updateView();
});
function endDrag(event) {
  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  const zoneId = state.drag.zoneId;
  state.drag = null; svg.classList.remove('is-dragging');
  if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
  if (event.type === 'pointerup' && !state.dragged && zoneId) selectZone(zoneId);
}
svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag); svg.addEventListener('lostpointercapture', () => { state.drag = null; svg.classList.remove('is-dragging'); });
svg.addEventListener('keydown', (event) => {
  if (!state.view) return;
  if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomAt(1.35); }
  else if (event.key === '-') { event.preventDefault(); zoomAt(1 / 1.35); }
  else if (event.key === 'Home') { event.preventDefault(); fitView(); }
  else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault(); const view = state.view;
    if (event.key === 'ArrowLeft') view.x -= view.width * .1;
    if (event.key === 'ArrowRight') view.x += view.width * .1;
    if (event.key === 'ArrowUp') view.y -= view.height * .1;
    if (event.key === 'ArrowDown') view.y += view.height * .1;
    updateView();
  }
});
let previousSize = null;
new ResizeObserver(() => {
  const size = { width: stage.clientWidth, height: stage.clientHeight };
  if (state.view && previousSize && size.width > 0 && size.height > 0) {
    const centerX = state.view.x + state.view.width / 2; const centerY = state.view.y + state.view.height / 2;
    const metersPerPixel = state.view.width / Math.max(previousSize.width, 1);
    state.view.width = size.width * metersPerPixel; state.view.height = size.height * metersPerPixel;
    state.view.x = centerX - state.view.width / 2; state.view.y = centerY - state.view.height / 2;
    updateView();
  }
  previousSize = size;
}).observe(stage);

loadPlan();
