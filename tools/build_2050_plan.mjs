import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {applyRoadWidths} from './road_widths.mjs';
import {buildRoadCrossProfiles} from './road_cross_profiles.mjs';

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
const apartmentNames = ['래미안 1단지','힐스테이트 1단지','푸르지오 1단지','호반써밋 1단지','자이 2차','아이파크 1단지','자이 1차','롯데캐슬 1단지','아이파크 오피스텔','래미안 2단지','힐스테이트 2단지','호반써밋 2단지','푸르지오 2단지','아크로','롯데캐슬 오피스텔'];
// These are game art directions, independent of real companies' product designs.
// Identity follows the existing compound; it never supplies or moves geometry.
const architectureDefinitions = [
  ['g01-deep-window-courts','깊은 창틀 중정형','raemian-courts','창틀과 중정','1단지 · 깊은 창틀',
    '거실의 넓은 창과 침실의 좁은 창을 깊은 창턱 안에서 구분',
    '수직 창틀 묶음 사이에 안으로 들어간 발코니를 반복',
    '백색 세라믹 기둥과 안쪽으로 물린 돌봄 라운지',
    '기존 단지 안에 그늘 중정과 창턱 화분을 제안',
    '가장자리가 낮은 정원과 안쪽 공용 온실'],
  ['g02-layered-shade','겹차양 생활형','hillstate-shades','겹차양과 라운지','1단지 · 가로 차양',
    '세대마다 거실창 위 차양과 별도 환기창을 구분',
    '가로 차양 띠 사이에 세로 루버를 엇갈려 배치',
    '금속 차양 아래 투명 로비와 수리 라운지',
    '차양 틈 화분과 지상 그늘 쉼터',
    '설비를 가리는 가벼운 루버 지붕과 주민 데크'],
  ['g03-rain-garden-loggias','빗물 로지아형','prugio-water-gardens','물순환과 로지아','1단지 · 빗물 정원',
    '안으로 들어간 로지아와 여닫는 거실창을 한 세대 묶음으로 구성',
    '수직 홈과 로지아를 교대로 반복해 긴 벽면을 분절',
    '청회색 무광 패널과 빗물 정원을 바라보는 카페',
    '기존 단지 안 빗물 정원과 실내외 연결 보행 데크',
    '우수 수집 화단과 조용한 산책 정원'],
  ['g04-greenhouse-canopies','온실 캐노피형','hobansummit-canopies','캐노피와 온실','1단지 · 공동 온실',
    '세대창 옆 식재 포켓과 깊은 발코니를 반복',
    '모서리 식재 프레임과 수평 차양이 이어지는 입면',
    '밝은 석재 기둥과 마켓 앞 연속 캐노피',
    '기존 지상 주차 전환을 검토하는 온실 앞 생활정원',
    '공유 온실과 그 아래 그늘 휴식 데크'],
  ['g05-living-terraces','생활 테라스형','xi-living','생활 정원 주거','2차 · 테라스',
    '넓은 세대 창호와 분리된 작은 침실·환기창',
    '쌍으로 묶인 발코니와 그 사이 세대 경계 기둥으로 입면 분절',
    '따뜻한 석재 저층부와 주거 로비·생활 상가 구분',
    '6층 간격 공중 녹화는 창작 시안이며 실제 층수·구조는 후속 설계',
    '옥상 정원과 설비를 가리는 낮은 식재·차양'],
  ['g06-acoustic-media-frames','흡음 프레임형','ipark-frames','생활 프레임','1단지 · 미디어',
    '거실창과 침실창을 흡음 측벽이 있는 발코니 안에 구분',
    '얇은 세로 흡음 핀과 깊은 창틀을 교대로 반복',
    '패널 기둥과 미디어 라운지 앞 넓은 캐노피',
    '외부 소음을 완화할 식재 띠와 조용한 안쪽 쉼터',
    '흡음 스크린 안 주민 문화 데크'],
  ['g07-living-garden-frames','생활 정원 프레임형','xi-living','생활 정원 주거','1차 · 정원 프레임',
    '2차와 같은 넓은 거실창·작은 침실창 언어에 안쪽 로지아를 적용',
    '따뜻한 세대 경계 프레임을 세로로 연결하고 발코니는 한 세대씩 분절',
    '2차와 같은 석재 계열의 저층부에 돌봄 라운지 배치',
    '연속 공중 녹화 대신 동 출입구 앞 작은 생활정원',
    '공유 텃밭과 프레임 차양 아래 휴식 공간'],
  ['g08-sandstone-bay-gardens','석재 베이 정원형','lottecastle-bays','깊은 베이와 라운지','1단지 · 주거 정원',
    '깊은 창턱과 거실창 양옆 측창이 있는 세대 베이',
    '무광 모래색 세로 베이와 안쪽 발코니가 교대',
    '깊은 석재 문주와 조용한 상가 아케이드',
    '베이 아래 우수 정원과 단지 안 그늘 산책길',
    '돌턱 화단과 공동 식사 정원'],
  ['g09-work-live-grid','작업 라운지 격자형','ipark-frames','생활 프레임','오피스텔 · 작업',
    '작은 주거 모듈마다 채광창·환기창·차양을 구분',
    '세로 프레임 안에 작은 창 묶음과 비운 공용 라운지 창을 반복',
    '모듈 금속 패널과 공유 업무실·도구 라이브러리',
    '업무 라운지 옆 휴식 테라스와 지상 자전거 쉼터',
    '가벼운 차양 아래 업무·휴식 정원'],
  ['g10-light-court-louvers','빛 중정 루버형','raemian-courts','창틀과 중정','2단지 · 채광 루버',
    '깊은 창틀 계열을 유지하면서 모서리 거실창과 환기창을 구분',
    '1단지의 수직 창틀 대신 채광 루버 묶음을 엇갈려 반복',
    '세라믹 기둥과 실내외가 연결되는 건강 라운지',
    '밝은 중정과 루버 아래 작은 식재 포켓',
    '채광 온실과 그늘 루버 데크'],
  ['g11-climate-wave-shades','곡면 기후 차양형','hillstate-shades','겹차양과 라운지','2단지 · 곡면 차양',
    '세대별 거실창 위 곡면 차양과 별도 환기창',
    '1단지의 겹차양을 곡면으로 변주하고 세대 사이 홈을 강조',
    '곡면 입구 캐노피와 스포츠 라운지의 투명 저층부',
    '바람을 완화하는 테라스 스크린과 그늘 휴식 화단',
    '곡면 차양 아래 기후 대응 공용 데크'],
  ['g12-quiet-canopy-pockets','조용한 캐노피 포켓형','hobansummit-canopies','캐노피와 온실','2단지 · 흡음 포켓',
    '흡음 측벽 안에 세대창과 안쪽 로지아를 함께 구성',
    '1단지 식재 프레임 계열을 더 깊은 세로 포켓으로 변주',
    '반투명 보행 캐노피와 골목 생활 라운지',
    '흡음 포켓의 식재와 단지 안 조용한 그늘 정원',
    '연속 온실 대신 소규모 정원 방과 흡음 스크린'],
  ['g13-repairable-garden-panels','교체 패널 정원형','prugio-water-gardens','물순환과 로지아','2단지 · 생활 수리',
    '세대창·차양·환기 부재를 별도 교체할 수 있는 모듈 제안',
    '1단지 로지아 계열에 크기가 다른 교체 패널 묶음을 반복',
    '재사용 금속 패널과 생활 수리 공방 앞 캐노피',
    '패널 식재 포켓과 빗물 회수 정원을 연결',
    '재사용 부재를 쓰는 작은 온실과 휴식 정원'],
  ['g14-vertical-garden-fins','수직 정원 핀형','acro-garden-fins','수직 정원과 큰 라운지','독립 단지 · 식재 핀',
    '모서리의 넓은 거실창과 깊은 테라스를 세대별로 구분',
    '수직 식재 핀 사이 세대창 묶음과 공용 정원층을 분절',
    '높이가 다른 석재 기둥과 큰 생활·돌봄 라운지',
    '기존 단지 안 그늘 보행 연결과 층 사이 작은 공용 정원',
    '식재 핀을 마감하는 옥상 숲과 주민 온실'],
  ['g15-compact-bay-lounges','작은 베이 라운지형','lottecastle-bays','깊은 베이와 라운지','오피스텔 · 공동 식사',
    '작은 주거 베이에 채광창·환기창·깊은 창턱을 구분',
    '1단지 석재 베이 언어를 작은 창 묶음과 공용 라운지 창으로 변주',
    '밝은 석재 아케이드와 공동 식사·업무 라운지',
    '상가와 주거 입구 사이 단지 안 작은 휴식 정원',
    '공동 식사 테라스와 그늘 정원']
];
const architectureFeatureLabels = [
  ['dwellingModule','세대 모듈'], ['facadeRhythm','입면 리듬'],
  ['podium','저층부'], ['skyLandscape','공중·지상 조경'], ['roofLandscape','옥상']
];
function architectureIdentity(index) {
  const [id,name,familyKey,familyName,phaseLabel,...descriptions] = architectureDefinitions[index];
  return {
    id,name,familyId:`architecture/${familyKey}`,familyName,phaseLabel,
    status:'fictional_2050_design_proposal_not_brand_product',
    consistencyRule:'same_compound_shared_modules_and_materials_no_merge_or_split',
    features:architectureFeatureLabels.map(([key,label],i)=>({key,label,description:descriptions[i]})),
    note:'실존 브랜드의 실제 상품을 모방하거나 재개발을 예측한 설계가 아닙니다. 단지 안에서는 같은 모듈·재료 언어를 공유하며, 치수·세대수·구조·허가사항은 확정하지 않습니다.'
  };
}
const complexMembershipReference = 'https://www.guro.go.kr/www/contents.do?key=1956';
// Compound identity is not the same thing as a spatial parcel or a shop programme.
const verifiedMembershipOverrides = new Map([
  ['way/253000688', {sourceId:'way/439886810', reference:complexMembershipReference, note:'구로구청 주공2차 118·119동 일람표. 원자료 공간상 구일우성 부지 안에 있지만 실제 단지 소속을 우선하며 외곽 좌표는 수정하지 않음.'}]
]);
const independentResidentialReferences = new Map([
  ['way/252997564','한국현대아파트'], ['way/252997565','구일현대아파트'],
  ['way/253001672','근상프리즘아파트'], ['north/hyeonjin-B','현진그린빌 B 표시동']
]);
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

function validateRoadSurfaceSection(section, surfacesById) {
  const finitePoint = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
  const finiteLine = geometry => geometry?.type === 'LineString' && geometry.coordinates?.length >= 2 && geometry.coordinates.every(finitePoint);
  if (section.widthKind !== 'road_surface_reference' || section.status !== 'geometry_estimate_not_verified_carriageway' || section.eligibility !== 'geometry_reference_only' || section.distanceBasis !== 'native_projected_metres') throw new Error('Invalid road surface section meaning or metric basis.');
  if (!Number.isFinite(section.startM) || !Number.isFinite(section.endM) || section.startM < 0 || section.endM <= section.startM || !Number.isFinite(section.widthM) || section.widthM <= 0) throw new Error('Invalid road surface section width or interval.');
  if (!Array.isArray(section.rangeM) || section.rangeM.length !== 2 || !section.rangeM.every(value=>Number.isFinite(value)&&value>0) || section.rangeM[0] > section.widthM || section.rangeM[1] < section.widthM || section.rangeStatus !== 'observed_section_variation_not_statistical_accuracy') throw new Error('Invalid road surface section observed range.');
  if (!finiteLine(section.localGeometry) || !Array.isArray(section.samples) || section.samples.length < 3 || section.sampleCount !== section.samples.length || !section.samples.every(sample=>finitePoint(sample.pointLocalM)&&Array.isArray(sample.crossSectionLocalM)&&sample.crossSectionLocalM.length===2&&sample.crossSectionLocalM.every(finitePoint)&&Number.isFinite(sample.widthM)&&sample.widthM>0)) throw new Error('Invalid road surface section geometry or samples.');
  if (!section.evidenceIds?.length || section.evidenceIds.some(id=>surfacesById.get(id)?.properties.surfaceKind !== 'road_corridor')) throw new Error('Road surface section is missing road polygon evidence.');
}

export function buildPlan(source, sourceSha256, widthData = null, roadSurveyData = null) {
  if (!source.features?.length || !Array.isArray(source.metadata?.local_provisional_boundary_m)) throw new Error('Missing source plan or boundary.');
  const byId = new Map(source.features.map(f => [String(f.id), f]));
  for (const id of verifiedMembershipOverrides.keys()) {
    const anchor=byId.get(id);
    if (!anchor || anchor.properties.category!=='building' || anchor.properties.name!=='119') throw new Error(`Verified complex membership anchor missing or changed: ${id}`);
  }
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
    zone.architectureIdentity=architectureIdentity(i);
    zone.future[0]=`단지 건축 성격: ${zone.architectureIdentity.name} · 단지 안에서는 공통 세대 모듈·재료 언어를 적용`;
    zone.description='실존 아파트 브랜드명을 기존 구일 부지에 배정한 2050 게임 설정입니다. 현재 실제 단지명·재개발 계약이나 해당 회사의 미래 설계가 아닙니다.';
    zone.complexId=`complex/${id}`;
    zone.sourceComplexName=byId.get(id).properties.name;
    zone.housingType=['way/439886814','way/901730989'].includes(id) ? 'officetel' : 'apartment';
    zone.housingTypeStatus=zone.housingType==='officetel' ? 'cross_checked_listing_and_launch_report_not_building_register' : 'source_reference';
    zone.complexPreservation='one_existing_compound_one_future_identity_no_merge_or_split';
    zone.preservation.push('기존 단지 소속·아파트/오피스텔 구분 유지 · 인접 단지와 합치거나 브랜드별로 분할하지 않음');
    if (zone.housingType==='officetel') zone.description='기존 오피스텔 단지를 독립적으로 승계하는 2050 게임 설정입니다. 아파트 단지에 합치거나 A/B동에 서로 다른 브랜드를 배정하지 않습니다. 상세 법정 용도는 건축물대장 미확인입니다.';
    if (['way/439886810','way/439886812'].includes(id)) {
      zone.complexFamilyId='family/guro-jugong';
      zone.sourcePhase=id==='way/439886812' ? 1 : 2;
      zone.membershipReference=complexMembershipReference;
    }
    zones.push(zone);
  });
  schoolDefinitions.forEach(([id, name, program]) => zones.push(makeZone(id, name, 'school', [program, '태양광 차양·지역 냉난방·외부 환경 정보를 건축에 통합', '학생 보행과 급식·관리 차량 동선을 분리'], ['설비·급식 반입 구역의 지하화 검토', '인접 주거 지하주차장과 임의 연결하지 않음', '주차·피난·출입 위치는 미확정'])));
  zones.push(makeZone('south/shinyeong-footprint', '구일 코어 2050', 'commercial', ['기존 실물 외관을 새 패널·차양·투명 공용부로 교체', '식료품·카페·건강관리·수리·생활제작 업종 유지', '자율배송 수령·공유 제작·에너지 제어를 사용하는 생활 허브'], ['물품 반입·설비·차량 보관의 기능 분리 검토', '기존 기계식 주차와 외관의 재현 모델을 사용하지 않음', '실제 지하 규모·경사로 위치는 미확정']));
  for (const [id,name,program] of commercialDefinitions) {
    const zone=makeZone(id,name,'commercial',[`2050 창작 상업 프로그램: ${program}`,'기존 건물자리만 사용하며 인접 주거부지 전체를 상가로 바꾸지 않음','현재 실존 점포와 동일한 입점·면적을 주장하지 않음'],['물류·설비 반입 공간 검토','부지·지하 공간 충돌 검토 전 차량 진입과 주차 규모 미확정']);
    zone.description='기존 건물자리에 새로 제안하는 2050 상업거점입니다. 현재 입점 업종을 그대로 복제한 것이 아닙니다.';
    zones.push(zone);
  }
  for (const zone of zones.filter(z=>z.kind==='commercial')) {
    const parent=zones.find(z=>z.kind==='residential'&&contains(zone.labelPoint,z.geometry));
    if (!parent) continue;
    zone.complexId=parent.complexId;
    zone.complexAssociationStatus='spatial_program_association_actual_annex_membership_unverified';
    zone.description+=` 2050 기능계획에서는 ${parent.name}의 단지 정체성을 분리하지 않습니다. 실제 부속동 소속은 공간상 연관만으로 확정하지 않습니다.`;
    zone.preservation.push('상업 기능은 별도 프로그램이며 인접 주거단지를 합병·분할하지 않음');
  }

  const eastRailSource=byId.get('way/311747059');
  if (!eastRailSource) throw new Error('Eastern rail-space reference is missing.');
  const transportConcept={
    id:'2050/east-integrated-metro-station', name:'동측 통합 지하철역 2050',
    sourceIds:['way/311747059','north/depot-visible-strip'],
    geometry:structuredClone(eastRailSource.properties.local_geometry_m),
    status:'user_proposed_2050_concept_not_an_existing_station',
    scope:'기존 동측 철도·차량기지 참조 공간 중 승인된 구로1동 경계 안을 통합 지하철역 구역으로 구상',
    future:['우측 철도 공간을 하나의 대형 지하철역 구역으로 사용', '새 역 건물·승강장·출입구·보행 연결은 후속 설계'],
    stationBuildingGeometry:null, platformLayout:null, entrances:null,
    verticalConfiguration:null,
    note:'실제 현재 역 또는 확정된 철도 개발계획이 아닙니다. 역 구역이라는 뜻이며 전체를 하나의 건물로 채우거나 모든 선로를 지하화한다고 확정하지 않습니다.'
  };

  const brandFreeCategories = new Set(['building','facility','landuse','school','unknown']);
  let independentBuilding = 0;
  const features = source.features.map(feature => {
    const properties = feature.properties;
    const geometry = structuredClone(properties.local_geometry_m);
    const point = representativePoint(geometry);
    // The commercial anchor has priority inside the larger residential parcel.
    const spatialZone = zones.find(z => z.sourceId === String(feature.id)) || (properties.category === 'building' && point ? zones.find(z => contains(point, z.geometry)) : null);
    const membershipOverride=verifiedMembershipOverrides.get(String(feature.id));
    const independentReference=independentResidentialReferences.get(String(feature.id));
    const zone=independentReference ? null : membershipOverride ? zones.find(z=>z.sourceId===membershipOverride.sourceId) : spatialZone;
    if (membershipOverride && (!zone || properties.category!=='building')) throw new Error(`Verified complex membership anchor missing: ${feature.id}`);
    const residentialParcel=properties.category==='building' && point ? zones.find(z=>z.kind==='residential' && contains(point,z.geometry)) : null;
    const complexZone=zone?.kind==='residential' ? zone : residentialParcel;
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
    if (transportConcept.sourceIds.includes(String(feature.id))) {
      name=transportConcept.name;
      futureUse='동측 철도 공간 전체를 통합 지하철역 구역으로 사용하는 2050 창작 구상 · 상세 배치 미정';
    }
    if (independentReference) {
      name=`구일 독립 주거 ${independentReference==='현진그린빌 B 표시동' ? 'B' : String([...independentResidentialReferences.keys()].indexOf(String(feature.id))+1)} (2050 명칭 미정)`;
      futureUse='독립 주거 건물·소속 보존; 인접 단지에 임의 편입하지 않음; 전체 단지 외곽·2050 브랜드 미정';
    }
    return {id:String(feature.id), category:properties.category, geometry, name, zoneId:zone?.id || null, spatialZoneId:spatialZone?.id || null,
      complexId:independentReference ? `complex/${feature.id}` : complexZone?.complexId || null,
      complexAssignmentStatus:membershipOverride ? 'official_membership_override_source_parcel_conflict' : independentReference ? 'independent_reference_full_compound_extent_unverified' : complexZone ? 'source_parcel_membership_not_cadastral_verification' : properties.category==='building'&&sourceUse.building==='apartments' ? 'unresolved_do_not_merge' : null,
      complexMembershipEvidence:membershipOverride || null,
      sourceUse, futureUse, geometryStatus:properties.geometry_status, roadWidthM:null};
  });
  const residentialComplexes=zones.filter(z=>z.kind==='residential').map(zone=>({
    id:zone.complexId, sourceId:zone.sourceId, sourceName:zone.sourceComplexName, futureName:zone.name,
    brand:zone.brand, housingType:zone.housingType, zoneId:zone.id, familyId:zone.complexFamilyId || null,
    sourcePhase:zone.sourcePhase || null, sourceParcelGeometryStatus:zone.geometryStatus,
    architectureIdentityId:zone.architectureIdentity.id,
    boundaryStatus:zone.sourceId==='way/439886810'||zone.sourceId==='way/439886809' ? 'source_outline_preserved_119_membership_conflict_not_cadastral_boundary' : 'source_outline_preserved_not_cadastral_boundary',
    memberFeatureIds:features.filter(f=>f.category==='building'&&f.complexId===zone.complexId).map(f=>f.id)
  }));
  for (const [sourceId,sourceName] of independentResidentialReferences) {
    const feature=features.find(f=>f.id===sourceId);
    if (!feature) throw new Error(`Independent residential reference missing: ${sourceId}`);
    residentialComplexes.push({id:feature.complexId,sourceId,sourceName,futureName:feature.name,brand:null,housingType:'residential_reference',zoneId:null,familyId:null,sourcePhase:null,boundaryStatus:'building_footprint_only_full_compound_extent_unverified',memberFeatureIds:[sourceId]});
  }
  const ring = boundary.coordinates[0];
  const bounds = {minX:Math.min(...ring.map(p=>p[0])), minY:Math.min(...ring.map(p=>p[1])), maxX:Math.max(...ring.map(p=>p[0])), maxY:Math.max(...ring.map(p=>p[1]))};
  const anchors = [];
  for (const [id, name, kind] of [['relation/19442518','구일 모빌리티 게이트','station'],['way/361035206','안양천','water'],['way/311747059','동측 통합 지하철역 2050 · 구상','railway']]) {
    const feature = byId.get(id);
    if (!feature) continue;
    let point = representativePoint(feature.properties.local_geometry_m);
    if (!point || !contains(point, boundary)) {
      const candidate = source.metadata.map_labels.find(l => String(l.feature_id) === id && contains(l.anchor_local_m, boundary));
      point = candidate?.anchor_local_m;
    }
    if (point && contains(point, boundary)) anchors.push({id, name, point, kind});
  }
  const plan = {
    schema:'korea2050.guil.future-plan.v1', year:2050, title:'KOREA 2050 · GUIL', createdOn:'2026-10-03', brandReferences,
    coordinateSystem:source.metadata.coordinate_system,
    boundaryStatus:source.metadata.boundary_status,
    sourceFile:'docs/guro1_plan_2d.geojson', sourceSha256, bounds, boundary, zones, features, anchors, transportConcept, residentialComplexes,
    stats:{sourceFeatures:features.length, buildings:features.filter(f=>f.category==='building').length, residentialZones:zones.filter(z=>z.kind==='residential').length, schools:zones.filter(z=>z.kind==='school').length, commercialZones:zones.filter(z=>z.kind==='commercial').length},
    sources:[{title:'OpenStreetMap contributors · ODbL 1.0',url:'https://www.openstreetmap.org/copyright'},{title:'기존 행정경계 참조 · 2026-07-01',url:'https://github.com/vuski/admdongkor/blob/master/ver20260701/HangJeongDong_ver20260701.geojson'},{title:'구로구청 구로1동 아파트별 지번 및 통 일람표 · 2026-06-24 수정',url:complexMembershipReference}],
    notices:[
      '기존 2D 원자료 좌표를 보존한 게임용 창작 2050 계획입니다. 실제 재개발·정책 예측이 아닙니다.',
      '주거명에는 자이·호반써밋 등 실존 브랜드를 사용했습니다. 부지 배정과 단지번호는 2050 게임 설정이며 현재 실존 단지의 이름·주소가 아닙니다.',
      '기존 아파트·오피스텔은 단지별 독립 소속을 승계합니다. 주공1차→자이1차, 주공2차→자이2차이며 119동 소속은 구청 자료로 보정했습니다. 원자료 부지 외곽의 119동 충돌은 아직 지적 경계로 보정하지 않았습니다.',
      '행정경계·일부 건물 외곽은 잠정 자료입니다. 도로·보도 폭은 선 표시이며 실측 폭이 아닙니다.',
      '지하 모드는 해당 부지의 계획 대상 범위를 표시합니다. 실제 주차장 외곽·층수·출입구 설계가 아닙니다.',
      '빈 구역은 확인된 공터가 아닙니다. 상가 업종은 기존 건물자리의 2050 창작 제안이며, 지도 밖 실존 단지를 복제하지 않았습니다.',
      '동측 철도·차량기지 공간은 통합 지하철역으로 바꿀 2050 창작 구상입니다. 선로 기호는 현재 위치 참조이며 실제 현재 지하철역이나 완성된 역 건물·승강장 배치가 아닙니다.'
    ]
  };
  if (!widthData) return plan;
  if (widthData.sourceSha256 !== sourceSha256) throw new Error('Road widths belong to a different source plan.');
  const reviewedWidths = structuredClone(widthData);
  if (roadSurveyData) {
    const {surfaces, sections} = roadSurveyData;
    if (sections.sourceSha256 !== sourceSha256) throw new Error('Survey sections belong to a different source plan.');
    if (!roadSurveyData.surfaceSha256 || sections.surfaceReferenceSha256 !== roadSurveyData.surfaceSha256) throw new Error('Survey sections refer to a different surface file checksum.');
    if (surfaces.metadata.sourceSha256 !== sourceSha256) throw new Error('Survey surfaces belong to a different source plan.');
    if (surfaces.metadata.scale !== '1:1000' || surfaces.metadata.sourceYear !== 2025) throw new Error('Expected the reviewed 2025 1:1000 road survey.');
    if (JSON.stringify(surfaces.metadata.localCoordinateSystem) !== JSON.stringify(source.metadata.coordinate_system)) throw new Error('Survey local coordinate system differs from the source.');
    const measuredById = new Map(sections.records.map(record => [record.sourceId, record]));
    if (measuredById.size !== sections.records.length || measuredById.size !== reviewedWidths.records.length) throw new Error('Survey inventory has duplicate or unexpected records.');
    const surfacesById = new Map(surfaces.features.map(feature=>[feature.id,feature]));
    const evidenceIds = new Set(surfacesById.keys());
    const roadSurfaceSectionIds = new Set();
    for (const record of reviewedWidths.records) {
      const measured = measuredById.get(record.sourceId);
      if (!measured) throw new Error(`Survey inventory is missing ${record.sourceId}.`);
      if (record.segments?.length) throw new Error('Existing reviewed segments must be reconciled before regenerating this survey.');
      for (const section of [...measured.segments,...measured.officialWidthSections,...(measured.roadSurfaceSections || [])]) for (const evidenceId of section.evidenceIds) {
        if (evidenceId.startsWith('ngii/') && !evidenceIds.has(evidenceId)) throw new Error(`Survey section refers to missing surface evidence: ${evidenceId}`);
      }
      for (const section of measured.roadSurfaceSections || []) {
        if (!section.id?.startsWith(`${record.sourceId}/`) || roadSurfaceSectionIds.has(section.id)) throw new Error('Invalid or duplicate road surface section ID.');
        validateRoadSurfaceSection(section, surfacesById);
        roadSurfaceSectionIds.add(section.id);
      }
      record.segments = structuredClone(measured.segments);
    }
    reviewedWidths.measurementStatus = 'bounded_walkway_estimates_and_separate_official_road_width_references';
  }
  const result = applyRoadWidths(plan, reviewedWidths);
  const byRoadId = new Map(reviewedWidths.records.map(record => [record.sourceId, record]));
  for (const feature of result.features) {
    const record = byRoadId.get(feature.id);
    if (!record) continue;
    feature.roadInsideLengthM = record.insideLengthM;
    feature.roadHighway = record.highway;
    feature.roadFootway = record.footway;
    feature.roadLevelStatus = record.officialLevelStatus ?? null;
  }
  result.metadata.roadWidths.summary = structuredClone(widthData.summary);
  result.metadata.roadWidths.sources = structuredClone(widthData.sources);
  if (roadSurveyData) {
    const {surfaces, sections} = roadSurveyData;
    const bySectionId = new Map(sections.records.map(record => [record.sourceId, record]));
    for (const feature of result.features) {
      const record = bySectionId.get(feature.id);
      if (!record) continue;
      feature.roadWidthOfficialSections = record.officialWidthSections.map(section => ({id:section.id, localGeometry:structuredClone(section.localGeometry), widthKind:section.widthKind, status:section.status, sourceWidthRangeM:[...section.sourceWidthRangeM], evidenceIds:[...section.evidenceIds]}));
      feature.roadSurfaceSections = (record.roadSurfaceSections || []).map(section=>({
        id:section.id, localGeometry:structuredClone(section.localGeometry), startM:section.startM, endM:section.endM,
        widthM:section.widthM, rangeM:[...section.rangeM], widthKind:section.widthKind, status:section.status,
        eligibility:section.eligibility, distanceBasis:section.distanceBasis, rangeStatus:section.rangeStatus,
        errorM:section.errorM, errorStatus:section.errorStatus, method:section.method, evidenceIds:[...section.evidenceIds],
        crossSections:section.samples.map(sample=>({point:[...sample.pointLocalM], widthM:sample.widthM, line:structuredClone(sample.crossSectionLocalM)}))
      }));
      feature.roadEstimatedInsideLengthM = record.estimatedInsideLengthM;
      feature.roadUnmeasuredInsideLengthM = record.unmeasuredInsideLengthM;
    }
    const polygonFeatures = surfaces.features.filter(feature => ['road_corridor','walkway'].includes(feature.properties.surfaceKind));
    for (const feature of polygonFeatures) {
      const geometry = feature.properties.local_geometry_m;
      if (!['Polygon','MultiPolygon'].includes(geometry?.type) || !Array.isArray(geometry.coordinates)) throw new Error('Invalid survey surface geometry.');
      const points = geometry.coordinates.flat(geometry.type === 'Polygon' ? 1 : 2);
      if (!points.every(point => point.length === 2 && point.every(Number.isFinite))) throw new Error('Survey surface contains non-finite coordinates.');
    }
    result.roadSurvey = {
      sourceYear:surfaces.metadata.sourceYear, scale:surfaces.metadata.scale,
      tileIds:[...new Set(surfaces.features.map(feature => feature.properties.tile))].sort(),
      restrictions:surfaces.metadata.restrictions,
      status:'official_reference_surfaces_not_a_claim_of_complete_width_verification',
      surfaces:polygonFeatures.map(feature => ({id:feature.id, kind:feature.properties.surfaceKind, geometry:structuredClone(feature.properties.local_geometry_m), officialWidthM:feature.properties.officialWidthM})),
      sectionSummary:structuredClone(sections.summary)
    };
    result.metadata.roadWidths.sectionSummary = structuredClone(sections.summary);
    result.metadata.roadWidths.walkwayCoverage = structuredClone(sections.diagnostics?.walkwayCoverage || null);
    if (roadSurveyData.profileCandidates) {
      const profiles = buildRoadCrossProfiles(roadSurveyData.profileCandidates, roadSurveyData.curbReviews, source, surfaces, {
        sourceSha256, surfaceSha256:roadSurveyData.surfaceSha256,
        verifiedImageHashes:roadSurveyData.verifiedImageHashes
      });
      for (const profile of profiles.profiles) {
        const owner=result.features.find(feature=>feature.id===profile.sourceId);
        if (!owner?.roadWidthStatus) throw new Error('Cross-profile owner is outside the road inventory.');
        (owner.roadCrossProfiles ||= []).push(profile);
      }
      result.metadata.roadWidths.crossProfileSummary=profiles.summary;
      for (const deferred of roadSurveyData.curbReviews.deferredScopes || []) {
        const sourceId=deferred.sourceId || deferred.id?.split('/curb-profile/')[0];
        const owner=result.features.find(feature=>feature.id===sourceId);
        if (!owner?.roadWidthStatus) throw new Error('Deferred width scope is outside the road inventory.');
        if (deferred.actualCarriagewayWidthM!==null) throw new Error('A deferred scope cannot supply a carriageway width.');
        for (const image of deferred.images || []) if (roadSurveyData.verifiedImageHashes?.[image.path]!==image.sha256) throw new Error('Deferred width image hash was not verified.');
        (owner.roadWidthDeferrals ||= []).push(structuredClone(deferred));
      }
      const lengths=[...new Set(profiles.profiles.map(profile=>profile.endAlongSegmentM-profile.startAlongSegmentM))].sort((a,b)=>a-b);
      result.notices.push(`차도·좌우 보도 단면은 검토한 ${lengths.map(length=>`${length}m`).join('·')} 구간에만 적용합니다. 로드뷰는 경계석 배치의 의미를 확인한 것이며 수치값은 공식 지도 기하 추정입니다. 노상 주차·자전거 띠·식재를 제외한 유효 통행폭이나 현장 실측값이 아닙니다.`);
    }
    result.metadata.roadWidths.sources.push({title:'국토지리정보원 · 2025년 1:1,000 도로·보도 수치지도',url:'https://map.ngii.go.kr/'});
    result.notices.push('회색 도로면·녹색 보도면은 2025년 1:1,000 공식 지도 윤곽입니다. 도로 중심선의 경계석 외측/길어깨 폭은 순수 차도폭과 구분합니다. 보도 추정값의 범위는 관찰된 변화이며 통계 오차범위가 아닙니다.');
    result.notices.push('지도 도로면 횡단폭은 A001 윤곽에서 계산한 구간 추정값입니다. 순수 차도폭·유효 통행폭은 미확정입니다. 구간 위치는 경계 안으로 자른 선의 시작부터 표시하며, 도로면 거리값은 공식 투영좌표계 미터 기준입니다.');
    result.notices.push('내려받은 수치지도와 파생 GIS는 로컬 검토용입니다. 재배포 권한 확인 전 GitHub 또는 외부 서비스에 게시하지 않습니다.');
  }
  result.notices[2] = '행정경계·일부 건물 외곽은 잠정 자료입니다. 도로별 실제 차도·보도 폭과 행정 등록 폭 참조는 구분합니다. 미측정 도로는 기호 선이며 등록 폭을 실제 차도폭으로 사용하지 않습니다.';
  return result;
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
    const strokeWidth=f.category==='road'?(plan.roadSurvey?.surfaces.length ? .6 : 5):f.category==='railway'?1.2:f.category==='path'?(plan.roadSurvey?.surfaces.length ? .5 : 2.2):0.7;
    return `<path d="${d}" fill="${isLine?'none':colors[f.category]||'#d8dedb'}" fill-rule="evenodd" stroke="${isLine?colors[f.category]||'#8fa7a0':'#a2b4b0'}" stroke-width="${strokeWidth}"/>`;
  }).join('');
  const zones=plan.zones.map(z=>`<path d="${geometryPath(z.geometry)}" fill="${zoneColors[z.kind]}" fill-opacity=".56" stroke="${zoneColors[z.kind]}" stroke-width="1.8"/>`).join('');
  const survey=(plan.roadSurvey?.surfaces || []).map(surface=>`<path data-survey-id="${escapeXml(surface.id)}" d="${geometryPath(surface.geometry)}" fill="${surface.kind==='walkway'?'#c4d8b2':'#d2dbe1'}" fill-rule="evenodd" stroke="none"/>`).join('');
  const buildings=plan.features.filter(f=>f.category==='building').map(f=>`<path d="${geometryPath(f.geometry)}" fill="#f6faf7" stroke="#567d75" stroke-width="1.2"/>`).join('');
  const crossProfiles=plan.features.flatMap(feature=>feature.roadCrossProfiles||[]).flatMap(profile=>profile.samples.map(sample=>[
    ['carriageway',sample.carriagewayLineLocalM,'#bd6234'],
    ['left_walkway',sample.leftWalkwayLineLocalM,'#4e8845'],
    ['right_walkway',sample.rightWalkwayLineLocalM,'#4e8845']
  ].filter(([,coordinates])=>coordinates).map(([kind,coordinates,color])=>`<path data-cross-profile-id="${escapeXml(profile.id)}" data-component="${kind}" d="${line(coordinates)}" fill="none" stroke="${color}" stroke-width="1.1"/>`).join(''))).join('');
  const labels=plan.zones.map(z=>{const p=projected(z.labelPoint); return `<text x="${p[0]}" y="${p[1]}" text-anchor="middle" font-size="${z.kind==='commercial'?9.5:10.5}" paint-order="stroke" stroke="#ffffff" stroke-width="3" fill="#103f39">${escapeXml(z.name)}</text>`;}).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><defs><clipPath id="scope"><path d="${geometryPath(plan.boundary)}"/></clipPath></defs><rect width="100%" height="100%" fill="#f4f7f3"/><g font-family="Malgun Gothic, sans-serif"><text x="60" y="38" font-size="27" fill="#123d36">KOREA 2050 · GUIL</text><text x="60" y="64" font-size="13" fill="#52756c">기존 위치 보존 · 주거 ${plan.stats.residentialZones} / 미래캠퍼스 ${plan.stats.schools} / 상업거점 ${plan.stats.commercialZones} · 창작 계획</text><g clip-path="url(#scope)">${shapes}${zones}${survey}${buildings}${crossProfiles}${labels}</g><path d="${geometryPath(plan.boundary)}" fill="none" stroke="#367c6d" stroke-width="2"/><text x="${width-50}" y="90" font-size="17" fill="#123d36">N ↑</text><text x="60" y="${height-36}" font-size="11" fill="#52756c">잠정 경계 / ${plan.roadSurvey ? "2025 공식 도로·보도 윤곽 / 미확인 중심선은 기호" : "도로·보도 폭은 기호"} / 지하주차장 대상은 대화형 지도에서 확인</text><text x="60" y="${height-18}" font-size="10" fill="#52756c">OpenStreetMap contributors · ODbL 1.0 / 원자료 불확실성 유지 / 실제 2050 예측 아님</text></g></svg>\n`;
}

export async function readCrossProfileInputs(rootDir = root) {
  let candidateBytes;
  try { candidateBytes=await readFile(path.join(rootDir,'docs/reference/guil_road_cross_profile_candidates.json')); }
  catch (error) { if (error.code==='ENOENT') return null; throw error; }
  const curbReviews=JSON.parse(await readFile(path.join(rootDir,'docs/reference/guil_curb_reviews.json'),'utf8'));
  if (!Array.isArray(curbReviews.records)) throw new Error('Invalid curb review records.');
  const verifiedImageHashes={};
  for (const review of [...curbReviews.records,...(curbReviews.deferredScopes || [])]) for (const image of review.images || []) {
    if (typeof image.path!=='string' || !image.path.startsWith('docs/reference/road-width-evidence/') || image.path.includes('..') || image.path.includes('\\')) throw new Error('Curb evidence path must stay inside the local evidence directory.');
    const imageBytes=await readFile(path.join(rootDir,image.path));
    verifiedImageHashes[image.path]=createHash('sha256').update(imageBytes).digest('hex');
  }
  return {profileCandidates:JSON.parse(candidateBytes),curbReviews,verifiedImageHashes};
}

export async function writePlan() {
  const bytes=await readFile(sourcePath);
  const source=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  const widthData=JSON.parse(await readFile(path.join(root,'docs/guil_road_widths.json'),'utf8'));
  let roadSurveyData = null;
  try {
    const [surfaceBytes,sectionBytes] = await Promise.all(['docs/reference/guil_ngii_road_surfaces.geojson','docs/reference/guil_ngii_road_sections.json'].map(file=>readFile(path.join(root,file))));
    roadSurveyData = {surfaces:JSON.parse(surfaceBytes),sections:JSON.parse(sectionBytes),surfaceSha256:createHash('sha256').update(surfaceBytes).digest('hex')};
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (roadSurveyData) Object.assign(roadSurveyData, await readCrossProfileInputs());
  const plan=buildPlan(source, createHash('sha256').update(bytes).digest('hex'),widthData,roadSurveyData);
  await writeFile(path.join(root,'docs/guil_2050_plan.json'), JSON.stringify(plan,null,2)+'\n');
  await writeFile(path.join(root,'docs/구일_2050_계획도.svg'), planSvg(plan));
  console.log(`2050 plan generated: ${plan.features.length} source features, ${plan.zones.length} future zones. Source unchanged.`);
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await writePlan();
