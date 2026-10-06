const check = (condition, message) => { if (!condition) throw new Error(`Apartment modules: ${message}`); };
const freeze = value => { Object.values(value).forEach(item => { if (item && typeof item === 'object') freeze(item); }); return Object.freeze(value); };

/** Shared exterior dimensions, not approved construction rules or confirmed dwelling plans. */
export const APARTMENT_MODULE_PROFILE = freeze({
  id: 'guil-residential-modules.v1', units: 'metres', status: 'fictional_exterior_modules_not_unit_plans_or_engineering_rules',
  floor: {podiumHeightM: 4.8, residentialHeightM: 3.2},
  facade: {bayPitchM: 7.75, pairedBayCount: 2, balconyDepthM: 1.4, groupWallAllowanceM: 2.7},
  windows: {
    living: {widthM: 3.65, maximumHeightM: 2.2, heightFraction: .68, offsetM: -.8, sillM: .3},
    bedroom: {widthM: 1.35, maximumHeightM: 1.6, heightFraction: .49, offsetM: 2.35, sillM: .85}
  },
  entrance: {doorLeafWidthM: 1.48, doorHeightM: 2.6, frameWidthM: 3.4, frameHeightM: 2.95, plazaLengthM: 16, plazaDepthM: 6, pathWidthM: 2.4},
  parking: {rampWidthM: 6, rampLengthM: 36, basementDepthM: 3.6},
  maintenance: {pathWidthM: 2.4, barrierHeightM: 1.1},
  componentIds: ['residential-floor', 'paired-window-bay', 'paired-balcony', 'double-leaf-entrance', 'lobby-plaza', 'parking-ramp', 'maintenance-interface']
});

/** Close-range exterior detail; all values are authored design assumptions in metres. */
export const APARTMENT_DETAIL_PROFILE = freeze({
  id: 'guil-exterior-detail.v1', units: 'metres',
  window: {frameSectionM: .1, frameDepthM: .14, gasketSectionM: .018, sillHeightM: .055, sillDepthM: .32},
  door: {outerFrameSectionM: .12, leafFrameSectionM: .07, leafDepthM: .1, thresholdHeightM: .025, leafTravelM: 1.5, readerWidthM: .3, readerHeightM: .62, readerCentreHeightM: 1.38},
  balcony: {postSectionM: .045, maximumPostSpacingM: 1.6, basePlateWidthM: .1, basePlateHeightM: .02},
  podium: {panelPitchM: 1.55, jointWidthM: .012, plinthHeightM: .28}
});

/** Four bars with an empty centre, not a solid slab pretending to be a frame. */
export function createFrameParts(widthM, heightM, sectionM, depthM) {
  for (const value of [widthM, heightM, sectionM, depthM]) check(Number.isFinite(value) && value > 0, 'frame dimensions must be finite and positive.');
  check(sectionM * 2 < Math.min(widthM, heightM), 'frame section must leave a clear opening.');
  return [
    {framePart: 'left', dimensions: [sectionM, heightM, depthM], position: [-(widthM - sectionM) / 2, 0, 0]},
    {framePart: 'right', dimensions: [sectionM, heightM, depthM], position: [(widthM - sectionM) / 2, 0, 0]},
    {framePart: 'head', dimensions: [widthM - sectionM * 2, sectionM, depthM], position: [0, (heightM - sectionM) / 2, 0]},
    {framePart: 'sill', dimensions: [widthM - sectionM * 2, sectionM, depthM], position: [0, -(heightM - sectionM) / 2, 0]}
  ];
}

/** The same layout is used by the coordinate generator and height-adjustable renderer. */
export function createApartmentModuleLayout(building, heightM = building?.heightM) {
  check(building && typeof building === 'object', 'building dimensions are required.');
  const {lengthM, depthM, podiumHeightM, floorHeightM} = building;
  for (const [name, value] of Object.entries({lengthM, depthM, podiumHeightM, floorHeightM, heightM})) check(Number.isFinite(value) && value > 0, `${name} must be finite and positive.`);
  check(heightM >= 18 && heightM <= 90 && heightM > podiumHeightM, 'preview height must be 18–90m above its podium.');
  check(lengthM >= 26.8 && lengthM <= 240 && depthM >= 6 && depthM <= 80, 'footprint is outside the supported exterior module range.');
  const {baySpacingM, dwellingGroupSize, balconyDepthM} = building.facade ?? {};
  check(Number.isFinite(baySpacingM) && baySpacingM >= 6.7 && baySpacingM <= lengthM / 4, 'bay spacing is invalid.');
  check(Number.isInteger(dwellingGroupSize) && dwellingGroupSize >= 1 && dwellingGroupSize <= 4, 'group size must be 1–4 bays.');
  check(Number.isFinite(balconyDepthM) && balconyDepthM >= 1.2 && balconyDepthM <= 2, 'balcony depth is invalid.');
  const bayCount = Math.floor(lengthM / baySpacingM);
  check(bayCount <= 40 && bayCount % dwellingGroupSize === 0, 'bay count must form complete paired groups.');
  const residentialFloorCount = Math.max(1, Math.floor((heightM - podiumHeightM) / floorHeightM + 1e-8));
  check(residentialFloorCount <= 60, 'too many residential floors for this module preview.');
  const adjustedFloorHeightM = (heightM - podiumHeightM) / residentialFloorCount;
  const bayPitchM = lengthM / bayCount, groupCount = bayCount / dwellingGroupSize, groupPitchM = bayPitchM * dwellingGroupSize;
  const floorRows = Array.from({length: residentialFloorCount}, (_, floorIndex) => ({floorIndex, bottomM: podiumHeightM + floorIndex * adjustedFloorHeightM, heightM: adjustedFloorHeightM}));
  const bays = Array.from({length: bayCount}, (_, bayIndex) => ({bayIndex, centreM: -lengthM / 2 + (bayIndex + .5) * bayPitchM, groupIndex: Math.floor(bayIndex / dwellingGroupSize)}));
  const groups = Array.from({length: groupCount}, (_, groupIndex) => ({groupIndex, centreM: -lengthM / 2 + (groupIndex + .5) * groupPitchM, firstBayIndex: groupIndex * dwellingGroupSize}));
  const openings = Object.entries(APARTMENT_MODULE_PROFILE.windows).map(([role, spec]) => {
    check(Math.abs(spec.offsetM) + spec.widthM / 2 < bayPitchM / 2, `${role} opening exceeds its bay.`);
    const height = Math.min(spec.maximumHeightM, adjustedFloorHeightM * spec.heightFraction);
    check(spec.sillM + height < adjustedFloorHeightM, `${role} opening exceeds its floor.`);
    return {role, widthM: spec.widthM, heightM: height, offsetM: spec.offsetM, sillM: spec.sillM};
  });
  return {
    profileId: APARTMENT_MODULE_PROFILE.id, status: 'exterior_repeat_layout_not_dwelling_count_or_internal_plan',
    heightM, residentialFloorCount, floorCount: residentialFloorCount + 1, floorHeightM: adjustedFloorHeightM,
    bayCount, bayPitchM, groupSize: dwellingGroupSize, groupCount, groupPitchM,
    balconyDepthM, balconyWidthM: groupPitchM - APARTMENT_MODULE_PROFILE.facade.groupWallAllowanceM,
    floorRows, bays, groups, openings, entrance: structuredClone(APARTMENT_MODULE_PROFILE.entrance)
  };
}
