const SVG_NS = 'http://www.w3.org/2000/svg';
const byId = (id) => document.getElementById(id);
const svg = byId('map');
const stage = byId('map-stage');
const state = { plan: null, mode: 'ground', selectedId: null, fit: null, view: null, drag: null, dragged: false, labels: [], anchors: [], zoom: 1 };
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
  return element('path', { d: path, class: `feature ${className}`, 'fill-rule': 'evenodd', 'data-feature-id': feature.id });
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
  const roofs = element('g', { class: 'roof-layer' });
  const labelLayer = element('g', { class: 'zone-label-layer' });
  const anchorLayer = element('g', { class: 'anchor-layer' });
  const zonesById = new Map(plan.zones.map((zone) => [zone.id, zone]));
  const orderedFeatures = [...plan.features].sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category));
  const baseCategories = new Set(['landuse', 'surface', 'green', 'water', 'rail_area', 'road_surface']);
  for (const feature of orderedFeatures) {
    if (!feature.geometry) continue;
    const target = baseCategories.has(feature.category) ? context : features;
    if (feature.category === 'road' && ['LineString', 'MultiLineString'].includes(feature.geometry.type)) {
      const edge = featureNode(feature, 'road-edge'); if (edge) target.append(edge);
    }
    const node = featureNode(feature); if (node) target.append(node);
    if (feature.category === 'building' && zonesById.get(feature.zoneId)?.kind === 'residential') {
      roofs.append(element('path', { d: geometryPath(feature.geometry), class: 'roof-design', 'fill-rule': 'evenodd' }));
    }
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
  clipped.append(context, zoneLayer, features, roofs, selected);
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

function selectZone(id) {
  const zone = state.plan?.zones.find((entry) => entry.id === id); if (!zone) return;
  state.selectedId = zone.id; byId('zone-select').value = zone.id;
  byId('zone-name').textContent = zone.name; byId('zone-description').textContent = zone.description || '선택한 구역의 미래 계획을 확인하실 수 있습니다.';
  listContent('preservation-list', zone.preservation, '구체적인 보존 요소는 추가 확인이 필요합니다.');
  listContent('future-list', zone.future, '세부 지상 계획은 아직 정하지 않았습니다.');
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
    byId('residential-count').textContent = String(plan.stats?.residentialZones ?? plan.zones.filter((zone) => zone.kind === 'residential').length);
    byId('school-count').textContent = String(plan.stats?.schools ?? plan.zones.filter((zone) => zone.kind === 'school').length);
    byId('commercial-count').textContent = String(plan.stats?.commercialZones ?? plan.zones.filter((zone) => zone.kind === 'commercial').length);
    byId('building-count').textContent = String(plan.stats?.buildings ?? plan.features.filter((feature) => feature.category === 'building').length);
    byId('data-status').textContent = `원자료 ${Number(plan.stats?.sourceFeatures ?? plan.features.length).toLocaleString('ko-KR')}개 요소를 바탕으로 작성했습니다.`;
    const select = byId('zone-select'); select.replaceChildren();
    const prompt = document.createElement('option'); prompt.value = ''; prompt.textContent = '지도에서 구역을 선택하세요'; select.append(prompt);
    for (const zone of plan.zones) { const option = document.createElement('option'); option.value = zone.id; option.textContent = zone.name; select.append(option); }
    select.disabled = false;
    listContent('notices-list', plan.notices, '계획 경계와 미래 설계는 검토용 시나리오입니다.');
    byId('sources').replaceChildren();
    for (const source of plan.sources || []) {
      let url; try { url = new URL(source.url, location.href); } catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = `${source.title} ↗`; byId('sources').append(link);
    }
    renderMap(); fitView(); setMode(state.mode);
    if (state.selectedId) selectZone(state.selectedId);
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
