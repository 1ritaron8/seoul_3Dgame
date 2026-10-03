import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourcePath = path.join(root, 'docs/guro1_plan_2d.geojson');

export function insideRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
    if (Math.abs(cross) < 1e-7 && point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0]) && point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1])) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function contains(point, geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(polygon => insideRing(point, polygon[0]) && !polygon.slice(1).some(hole => insideRing(point, hole)));
}

function polygonCenter(ring) {
  let twiceArea = 0, x = 0, y = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1], c = a[0] * b[1] - b[0] * a[1];
    twiceArea += c;
    x += (a[0] + b[0]) * c;
    y += (a[1] + b[1]) * c;
  }
  if (Math.abs(twiceArea) > 1e-7) return [x / (3 * twiceArea), y / (3 * twiceArea)];
  return ring[0];
}

function representativePoint(geometry) {
  if (geometry.type === 'Point') return geometry.coordinates;
  if (geometry.type === 'Polygon') {
    const center = polygonCenter(geometry.coordinates[0]);
    if (contains(center, geometry)) return center;
    // A concave courtyard may contain no centroid. Find a guaranteed interior label.
    const ring = geometry.coordinates[0];
    const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += 2) {
      for (let x = Math.min(...xs); x <= Math.max(...xs); x += 2) if (contains([x, y], geometry)) return [x, y];
    }
    return ring[0];
  }
  if (geometry.type === 'MultiPolygon') return representativePoint({type:'Polygon', coordinates:geometry.coordinates[0]});
  if (geometry.type === 'LineString') return geometry.coordinates[Math.floor(geometry.coordinates.length / 2)];
  return null;
}

const residentialDefinitions = [
  ['way/253002683', '아크 리빙', '백색 세라믹·깊은 차양·실내외 돌봄 라운지', '주민 차량과 공유차를 분리 보관'],
  ['way/253002689', '벡터 레지던스', '반투명 외피·가변 루버·로봇 수리 라운지', '주차와 대형 물품 인계 구역 분리'],
  ['way/439886808', '리플 리빙', '청회색 외피·빗물 정원·그늘 보행 데크', '차수·배수 구획을 갖춘 주차 계획'],
  ['way/439886809', '캐노피 레지던스', '식재 차양·공유 온실·지상 보행정원', '충전·배터리 이상 격리 구역 분리'],
  ['way/439886810', '넥서스 리빙', '교체형 세라믹 패널·자율배송 수령실·공유 작업실', '차량 인계 후 자동 보관·보행 승강기 분리'],
  ['way/439886811', '소닉 레지던스', '흡음 루버·주민 미디어 스튜디오·생활문화 라운지', '배송 동선과 주민 주차 동선 분리'],
  ['way/439886812', '오르빗 리빙', '모듈형 차양·에너지 외피·지상 무차량 생활정원', '구역별 자율주차·전력·환기 제어'],
  ['way/439886813', '테라 레지던스', '무광 모래색 외피·우수 정원·깊은 창턱', '관리 물품 반입과 차량 보관 분리'],
  ['way/439886814', '노드 리빙', '소형 금속 패널·공유 업무실·도구 라이브러리', '공유차와 자전거 보관·차량 진입 분리'],
  ['way/439886815', '루멘 레지던스', '채광 루버·주민 온실·실내외 연결 라운지', '예약 차량 인계·충전 상태 안내'],
  ['way/439886816', '플럭스 리빙', '곡면 차양·자동 환기·기후 반응형 공용 공간', '차량과 배송 로봇 대기 구획 분리'],
  ['way/439886818', '에코드 레지던스', '철도 측 흡음 외피·반투명 보행 차양·골목 라운지', '차량 정비와 주민 통행 분리'],
  ['way/439886819', '리뉴 리빙', '재사용 금속 외피·교체 부재·생활 수리실', '대형 물품 인계·차량 인계 분리'],
  ['way/439886820', '실바 레지던스', '식재 루버·그늘 보행 네트워크·돌봄 거점', '단지 내부 구역별 자율주차 배정'],
  ['way/901730989', '프리즘 리빙', '밝은 석재 패널·깊은 차양·공동 식사 라운지', '방문차 인계와 주민 차량 보관 분리']
];
const schoolDefinitions = [
  ['way/250489312', '구일 넥스트 초등캠퍼스', '관찰 온실·교사 제어 차양·빗물 순환 학습 공간'],
  ['way/250489316', '구일 메이커 중등캠퍼스', '로봇 제작·수리실·환경 센싱·가변 실습실'],
  ['way/250489315', '구일 프런티어 고등캠퍼스', '에너지 제어·도시 시뮬레이션 연구실·협업 실험동']
];
const apartmentNames = ['래미안 1단지','힐스테이트 1단지','푸르지오 1단지','호반써밋 1단지','자이 1단지','아이파크 1단지','자이 2단지','롯데캐슬 1단지','아이파크 2단지','래미안 2단지','힐스테이트 2단지','호반써밋 2단지','푸르지오 2단지','아크로','롯데캐슬 2단지'];
const brandReferences = [
  {name:'자이',url:'https://xi.co.kr/'},
  {name:'호반써밋',url:'https://www.ihoban.co.kr/pr/bi/web'},
  {name:'래미안',url:'https://www.raemian.co.kr/brand/story/story.do'},
  {name:'힐스테이트',url:'https://www.hillstate.co.kr/brand/introduce'},
  {name:'푸르지오',url:'https://www.prugio.com/'},
  {name:'아크로',url:'https://www.acro.co.kr/Ahah_view01.action'},
  {name:'아이파크',url:'https://www.i-park.com/'},
  {name:'롯데캐슬',url:'https://www.lottecastle.co.kr/'}
];
const podiumPrograms = [
  '프리미엄 식료품·베이커리·패밀리 카페','생활 편집숍·피트니스·공유 작업실',
  '리버 카페·그린마켓·생활 세탁','주민 온실 마켓·북카페·건강관리',
  '로컬 식당·의료 라운지·수리 스튜디오','미디어숍·음악 카페·디지털 문화공간',
  '생활마트·동네 식당·돌봄 서비스','그린마켓·공예숍·조용한 카페',
  '테크숍·도구 대여·공유 오피스','건강관리·베이커리·빛 정원 카페',
  '스포츠 스튜디오·편집숍·델리','이동서비스·테이크아웃·생활 수리',
  '수리 공방·리유스숍·동네 식당','푸드홀·학습 라운지·그린마켓',
  '프리미엄 편집숍·공동식사·워크카페'
];
const commercialDefinitions = [
  ['way/252997584','구일 리버 마켓','프리미엄 식료품·베이커리·생활용품·재사용 포장 회수'],
  ['way/253000687','구일 테이블 스퀘어','외식·카페·픽업 매장·사람과 로봇 수령 동선 분리'],
  ['way/313264521','구일 데일리 허브','생활마켓·세탁·수리·모듈 진열·물품 수령'],
  ['way/1160963936','구일 프리즘 아케이드','생활 편집숍·뷰티·카페·차양 아래 보행 상가'],
  ['way/1160963937','구일 크래프트 갤러리','소규모 전문점·학습공방·수리점·층별 프로그램'],
  ['north/woosung-shop','구일 스튜디오 워크','문구·학습공방·간식·학교 밖 생활서비스'],
  ['north/queens-west-annex','구일 링크 라운지','역 주변 픽업·카페·공유 업무']
];

export function buildPlan(source, sourceSha256) {
  if (!source.features?.length || !Array.isArray(source.metadata?.local_provisional_boundary_m)) throw new Error('Missing source plan or boundary.');
  const byId = new Map(source.features.map(f => [String(f.id), f]));
  const boundary = {type:'Polygon', coordinates:[structuredClone(source.metadata.local_provisional_boundary_m)]};
  const zones = [];
  function makeZone(sourceId, name, kind, future, underground) {
    const feature = byId.get(sourceId);
    if (!feature) throw new Error(`Required anchor missing: ${sourceId}`);
    const geometry = structuredClone(feature.properties.local_geometry_m);
    const labelPoint = representativePoint(geometry);
    if (!contains(labelPoint, boundary)) throw new Error(`Zone label outside approved boundary: ${sourceId}`);
    return {
      id:`2050/${sourceId}`, sourceId, name, kind, geometry, labelPoint,
      geometryStatus:feature.properties.geometry_status,
      description:kind === 'residential' ? '기존 단지 자리와 건물 배치를 사용하는 2050 창작 주거계획입니다.' : kind === 'school' ? '학교 위치·부지·학교급을 유지하는 미래형 캠퍼스입니다.' : '기존 상가 자리의 외곽과 도로 접점을 보존하는 새 상업시설입니다.',
      preservation:['기존 2D 좌표·부지 외곽·건물자리 유지', '주변 도로·보도·시설 연결 유지'],
      future,
      underground,
      undergroundStatus:'concept_zone_not_engineering_layout',
      heightM:null, heightStatus:'2050_design_not_yet_defined'
    };
  }
  residentialDefinitions.forEach(([id, _name, appearance, parking], i) => {
    const zone=makeZone(id, `G${String(i + 1).padStart(2,'0')} ${apartmentNames[i]}`, 'residential', [appearance, `저층부 창작 상업: ${podiumPrograms[i]}`, '기존 지상 주차의 녹지·휴식 공간 전환은 보행·소방·서비스 동선 확인 후 상세 배치', '공공 도로와 학교 부지는 침범하지 않음'], ['새 지하주차장 계획', parking, '출입 경사로·승강기·피난·깊이·주차대수는 후속 설계에서 결정']);
    zone.brand=brandReferences.find(brand=>apartmentNames[i].startsWith(brand.name)).name;
    zone.brandAssignmentStatus='real_brand_fictional_2050_site_assignment';
    zone.description='실존 아파트 브랜드명을 기존 구일 부지에 배정한 2050 게임 설정입니다. 현재 실제 단지명·재개발 계약이나 해당 회사의 미래 설계가 아닙니다.';
    zones.push(zone);
  });
  schoolDefinitions.forEach(([id, name, program]) => zones.push(makeZone(id, name, 'school', [program, '태양광 차양·지역 냉난방·외부 환경 정보를 건축에 통합', '학생 보행과 급식·관리 차량 동선을 분리'], ['설비·급식 반입 구역의 지하화 검토', '인접 주거 지하주차장과 임의 연결하지 않음', '주차·피난·출입 위치는 미확정'])));
  zones.push(makeZone('south/shinyeong-footprint', '구일 코어 2050', 'commercial', ['기존 실물 외관을 새 패널·차양·투명 공용부로 교체', '식료품·카페·건강관리·수리·생활제작 업종 유지', '자율배송 수령·공유 제작·에너지 제어를 사용하는 생활 허브'], ['물품 반입·설비·차량 보관의 기능 분리 검토', '기존 기계식 주차와 외관의 재현 모델을 사용하지 않음', '실제 지하 규모·경사로 위치는 미확정']));
  for (const [id,name,program] of commercialDefinitions) {
    const zone=makeZone(id,name,'commercial',[`2050 창작 상업 프로그램: ${program}`,'기존 건물자리만 사용하며 인접 주거부지 전체를 상가로 바꾸지 않음','현재 실존 점포와 동일한 입점·면적을 주장하지 않음'],['물류·설비 반입 공간 검토','부지·지하 공간 충돌 검토 전 차량 진입과 주차 규모 미확정']);
    zone.description='기존 건물자리에 새로 제안하는 2050 상업거점입니다. 현재 입점 업종을 그대로 복제한 것이 아닙니다.';
    zones.push(zone);
  }

  const brandFreeCategories = new Set(['building','facility','landuse','school','unknown']);
  let independentBuilding = 0;
  const features = source.features.map(feature => {
    const properties = feature.properties;
    const geometry = structuredClone(properties.local_geometry_m);
    const point = representativePoint(geometry);
    // The commercial anchor has priority inside the larger residential parcel.
    const zone = zones.find(z => z.sourceId === String(feature.id)) || (properties.category === 'building' && point ? zones.find(z => contains(point, z.geometry)) : null);
    const sourceUse={building:properties.osm_tags?.building||null,amenity:properties.osm_tags?.amenity||null,landuse:properties.osm_tags?.landuse||null};
    let futureUse=zone ? `${zone.kind} 2050 창작 계획` : '2050 기능 미정';
    let name = properties.name || '';
    if (properties.category === 'road' && geometry.type === 'Point') name = '구일 모빌리티 정류장';
    if (properties.category === 'surface') name = '구일 지상 공간';
    if (properties.category === 'road_surface') name = '구일 차량 접근 공간';
    if (brandFreeCategories.has(properties.category)) {
      if (zone) name = properties.category === 'building' && String(feature.id) !== zone.sourceId ? `${zone.name} 생활동` : zone.name;
      else if (properties.category === 'building') name = `구일 도시동 ${String(++independentBuilding).padStart(2,'0')}`;
      else name = {facility:'구일 도시설비', landuse:'구일 기능구역', school:'구일 학습캠퍼스', unknown:'참조 미확인 구역'}[properties.category];
    }
    if (properties.osm_tags?.building === 'train_station') name = '구일 모빌리티 게이트';
    if (properties.category==='building' && ['garage','garages','industrial','service'].includes(sourceUse.building) && (!zone || String(feature.id)!==zone.sourceId)) {
      name=zone ? `${zone.name} 부속동 (용도 검토)` : '구일 산업·설비동 (2050 용도 미정)';
      futureUse='기존 비주거 용도 기록 유지; 2050 용도 전환 미확정';
    }
    if (String(feature.id).startsWith('south/pumping-')) {
      sourceUse.observed='빗물 펌프시설 지붕 추정';
      name='구일 수자원 설비동 (2050 설계 미정)';
      futureUse='수자원 설비의 2050 개선 계획 미정';
    }
    return {id:String(feature.id), category:properties.category, geometry, name, zoneId:zone?.id || null, sourceUse, futureUse, geometryStatus:properties.geometry_status, roadWidthM:null};
  });
  const ring = boundary.coordinates[0];
  const bounds = {minX:Math.min(...ring.map(p=>p[0])), minY:Math.min(...ring.map(p=>p[1])), maxX:Math.max(...ring.map(p=>p[0])), maxY:Math.max(...ring.map(p=>p[1]))};
  const anchors = [];
  for (const [id, name, kind] of [['relation/19442518','구일 모빌리티 게이트','station'],['way/361035206','안양천','water'],['way/311747059','레일 테크 야드','railway']]) {
    const feature = byId.get(id);
    if (!feature) continue;
    let point = representativePoint(feature.properties.local_geometry_m);
    if (!point || !contains(point, boundary)) {
      const candidate = source.metadata.map_labels.find(l => String(l.feature_id) === id && contains(l.anchor_local_m, boundary));
      point = candidate?.anchor_local_m;
    }
    if (point && contains(point, boundary)) anchors.push({id, name, point, kind});
  }
  return {
    schema:'korea2050.guil.future-plan.v1', year:2050, title:'KOREA 2050 · GUIL', createdOn:'2026-10-03', brandReferences,
    coordinateSystem:source.metadata.coordinate_system,
    boundaryStatus:source.metadata.boundary_status,
    sourceFile:'docs/guro1_plan_2d.geojson', sourceSha256, bounds, boundary, zones, features, anchors,
    stats:{sourceFeatures:features.length, buildings:features.filter(f=>f.category==='building').length, residentialZones:zones.filter(z=>z.kind==='residential').length, schools:zones.filter(z=>z.kind==='school').length, commercialZones:zones.filter(z=>z.kind==='commercial').length},
    sources:[{title:'OpenStreetMap contributors · ODbL 1.0',url:'https://www.openstreetmap.org/copyright'},{title:'기존 행정경계 참조 · 2026-07-01',url:'https://github.com/vuski/admdongkor/blob/master/ver20260701/HangJeongDong_ver20260701.geojson'}],
    notices:[
      '기존 2D 원자료 좌표를 보존한 게임용 창작 2050 계획입니다. 실제 재개발·정책 예측이 아닙니다.',
      '주거명에는 자이·호반써밋 등 실존 브랜드를 사용했습니다. 부지 배정과 단지번호는 2050 게임 설정이며 현재 실존 단지의 이름·주소가 아닙니다.',
      '행정경계·일부 건물 외곽은 잠정 자료입니다. 도로·보도 폭은 선 표시이며 실측 폭이 아닙니다.',
      '지하 모드는 해당 부지의 계획 대상 범위를 표시합니다. 실제 주차장 외곽·층수·출입구 설계가 아닙니다.',
      '빈 구역은 확인된 공터가 아닙니다. 상가 업종은 기존 건물자리의 2050 창작 제안이며, 지도 밖 실존 단지를 복제하지 않았습니다.'
    ]
  };
}

function escapeXml(text) { return String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c])); }

export function planSvg(plan) {
  const {minX,minY,maxX,maxY} = plan.bounds;
  const width=maxX-minX+120, height=maxY-minY+180;
  const projected=p=>[p[0]-minX+60,maxY-p[1]+100];
  const line=coordinates=>coordinates.map((p,i)=>`${i?'L':'M'} ${projected(p).join(' ')}`).join(' ');
  const geometryPath=g=>g.type==='Polygon' ? g.coordinates.map(r=>line(r)+' Z').join(' ') : g.type==='MultiPolygon' ? g.coordinates.map(p=>p.map(r=>line(r)+' Z').join(' ')).join(' ') : g.type==='LineString' ? line(g.coordinates) : g.type==='MultiLineString' ? g.coordinates.map(line).join(' ') : '';
  const colors={water:'#abd8e2',building:'#e8f0ed',road:'#a8b7bf',path:'#a9cbb4',railway:'#778490',green:'#dcebd2',school:'#fff1c2',facility:'#d8deda',landuse:'#e4e9e5',surface:'#e5ebea',road_surface:'#d2dbe1',rail_area:'#d5dfe0',unknown:'#f3d0ab'};
  const zoneColors={residential:'#a5d9c8',school:'#f1ce73',commercial:'#f3a784'};
  const shapes=plan.features.map(f=>{
    const d=geometryPath(f.geometry); if(!d) return '';
    const isLine=['LineString','MultiLineString'].includes(f.geometry.type);
    const strokeWidth=f.category==='road'?5:f.category==='railway'?1.2:f.category==='path'?2.2:0.7;
    return `<path d="${d}" fill="${isLine?'none':colors[f.category]||'#d8dedb'}" fill-rule="evenodd" stroke="${isLine?colors[f.category]||'#8fa7a0':'#a2b4b0'}" stroke-width="${strokeWidth}"/>`;
  }).join('');
  const zones=plan.zones.map(z=>`<path d="${geometryPath(z.geometry)}" fill="${zoneColors[z.kind]}" fill-opacity=".56" stroke="${zoneColors[z.kind]}" stroke-width="1.8"/>`).join('');
  const buildings=plan.features.filter(f=>f.category==='building').map(f=>`<path d="${geometryPath(f.geometry)}" fill="#f6faf7" stroke="#567d75" stroke-width="1.2"/>`).join('');
  const labels=plan.zones.map(z=>{const p=projected(z.labelPoint); return `<text x="${p[0]}" y="${p[1]}" text-anchor="middle" font-size="${z.kind==='commercial'?9.5:10.5}" paint-order="stroke" stroke="#ffffff" stroke-width="3" fill="#103f39">${escapeXml(z.name)}</text>`;}).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><defs><clipPath id="scope"><path d="${geometryPath(plan.boundary)}"/></clipPath></defs><rect width="100%" height="100%" fill="#f4f7f3"/><g font-family="Malgun Gothic, sans-serif"><text x="60" y="38" font-size="27" fill="#123d36">KOREA 2050 · GUIL</text><text x="60" y="64" font-size="13" fill="#52756c">기존 위치 보존 · 주거 ${plan.stats.residentialZones} / 미래캠퍼스 ${plan.stats.schools} / 상업거점 ${plan.stats.commercialZones} · 창작 계획</text><g clip-path="url(#scope)">${shapes}${zones}${buildings}${labels}</g><path d="${geometryPath(plan.boundary)}" fill="none" stroke="#367c6d" stroke-width="2"/><text x="${width-50}" y="90" font-size="17" fill="#123d36">N ↑</text><text x="60" y="${height-36}" font-size="11" fill="#52756c">잠정 경계 / 도로·보도 폭은 기호 / 지하주차장 대상은 대화형 지도에서 확인</text><text x="60" y="${height-18}" font-size="10" fill="#52756c">OpenStreetMap contributors · ODbL 1.0 / 원자료 불확실성 유지 / 실제 2050 예측 아님</text></g></svg>\n`;
}

export async function writePlan() {
  const bytes=await readFile(sourcePath);
  const source=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  const plan=buildPlan(source, createHash('sha256').update(bytes).digest('hex'));
  await writeFile(path.join(root,'docs/guil_2050_plan.json'), JSON.stringify(plan,null,2)+'\n');
  await writeFile(path.join(root,'docs/구일_2050_계획도.svg'), planSvg(plan));
  console.log(`2050 plan generated: ${plan.features.length} source features, ${plan.zones.length} future zones. Source unchanged.`);
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await writePlan();
