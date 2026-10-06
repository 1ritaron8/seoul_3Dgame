const check = (condition, message) => { if (!condition) throw new Error(`Pilot environment: ${message}`); };
const radians = value => value * Math.PI / 180;
const degrees = value => value * 180 / Math.PI;
const finitePoint = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);

/** NOAA fractional-year approximation; local standard time, no refraction or terrain. */
export function approximateSolarPosition({year, month, day, hour, latitudeDeg, longitudeDeg, utcOffsetHours}) {
  check(Number.isInteger(year) && year >= 1900 && year <= 2100, 'year must be 1900–2100.');
  check(Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(day), 'invalid calendar date.');
  const date = new Date(Date.UTC(year, month - 1, day));
  check(date.getUTCMonth() === month - 1 && date.getUTCDate() === day, 'invalid calendar date.');
  check(Number.isFinite(hour) && hour >= 0 && hour < 24, 'local standard hour must be 0–24.');
  check(Number.isFinite(latitudeDeg) && Math.abs(latitudeDeg) < 89.9 && Number.isFinite(longitudeDeg) && Math.abs(longitudeDeg) <= 180, 'invalid latitude/longitude.');
  check(Number.isFinite(utcOffsetHours) && utcOffsetHours >= -12 && utcOffsetHours <= 14, 'invalid time zone offset.');
  const daysInYear = new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1 ? 366 : 365;
  const dayOfYear = 1 + (date.getTime() - Date.UTC(year, 0, 1)) / 86400000;
  const gamma = 2 * Math.PI / daysInYear * (dayOfYear - 1 + (hour - 12) / 24);
  const equationOfTimeMin = 229.18 * (.000075 + .001868 * Math.cos(gamma) - .032077 * Math.sin(gamma) - .014615 * Math.cos(2 * gamma) - .040849 * Math.sin(2 * gamma));
  const declination = .006918 - .399912 * Math.cos(gamma) + .070257 * Math.sin(gamma) - .006758 * Math.cos(2 * gamma) + .000907 * Math.sin(2 * gamma) - .002697 * Math.cos(3 * gamma) + .00148 * Math.sin(3 * gamma);
  const solarTimeMin = ((hour * 60 + equationOfTimeMin + 4 * longitudeDeg - 60 * utcOffsetHours) % 1440 + 1440) % 1440;
  const hourAngle = radians(solarTimeMin / 4 - 180), latitude = radians(latitudeDeg);
  const sineAltitude = Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sineAltitude)));
  const azimuth = (Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude)) + Math.PI + 2 * Math.PI) % (2 * Math.PI);
  return {
    altitudeDeg: degrees(altitude), azimuthDegNorthClockwise: degrees(azimuth), aboveHorizon: altitude > 0,
    directionEastNorthUp: [Math.cos(altitude) * Math.sin(azimuth), Math.cos(altitude) * Math.cos(azimuth), Math.sin(altitude)],
    status: 'approximate_solar_direction_no_atmospheric_refraction_not_daylight_compliance'
  };
}

export function flatGroundShadowLengthM(heightM, altitudeDeg) {
  check(Number.isFinite(heightM) && heightM > 0 && Number.isFinite(altitudeDeg) && altitudeDeg >= -90 && altitudeDeg <= 90, 'invalid shadow inputs.');
  return altitudeDeg > 0 ? heightM / Math.tan(radians(altitudeDeg)) : null;
}

/** Direct precipitation only: no pipe capacity, topography or upstream runoff inferred. */
export function directRainfallScenario({areaM2, rainfallMmPerHour, durationMinutes, runoffCoefficient}) {
  for (const [name, value] of Object.entries({areaM2, rainfallMmPerHour, durationMinutes})) check(Number.isFinite(value) && value > 0, `${name} must be finite and positive.`);
  check(Number.isFinite(runoffCoefficient) && runoffCoefficient >= 0 && runoffCoefficient <= 1, 'runoff coefficient must be 0–1.');
  return {
    areaM2, rainfallMmPerHour, durationMinutes, runoffCoefficient,
    inflowLitresPerSecond: areaM2 * rainfallMmPerHour * runoffCoefficient / 3600,
    volumeM3: areaM2 * rainfallMmPerHour * runoffCoefficient * durationMinutes / 60000,
    status: 'direct_rain_sensitivity_scenario_not_design_storm_or_drain_capacity'
  };
}

export function buildPilotEnvironment(scene, evidence) {
  check(scene?.futureDesign && evidence?.schema === 'guil-pilot-site-evidence.v1', 'scene and site evidence are required.');
  check(evidence.localOnly === true && evidence.publicationAllowed === false && evidence.sourcePlanSha256 === scene.provenance.sourceSha256, 'site evidence must match the retained local source.');
  check(evidence.scope?.pilotBuildingId === scene.building.sourceId && evidence.scope.designZoneId === scene.futureDesign.siteZoneId, 'site evidence scope differs.');
  const {latitudeDeg, longitudeDeg} = evidence.siteLocation ?? {};
  check(Number.isFinite(latitudeDeg) && Number.isFinite(longitudeDeg), 'site location is missing.');
  const design = scene.futureDesign, building = design.building, ramp = design.parking.ramp;
  check(finitePoint(ramp.startLocalM) && finitePoint(ramp.endLocalM) && finitePoint(ramp.normalLocalM), 'ramp references are missing.');
  const sunCases = [{month: 12, day: 21, label: '겨울'}, {month: 6, day: 21, label: '여름'}].flatMap(season => [9, 12, 15].map(hour => {
    const inputs = {year: 2050, month: season.month, day: season.day, hour, latitudeDeg, longitudeDeg, utcOffsetHours: 9};
    const sun = approximateSolarPosition(inputs);
    return {id: `${season.month}-${hour}`, label: `${season.label} ${hour}시`, inputs, ...sun, flatGroundShadowLengthM: flatGroundShadowLengthM(building.heightM, sun.altitudeDeg)};
  }));
  const neighbourMasses = scene.contextBuildings.map(item => {
    const record = evidence.buildingEvidence?.find(value => value.sourceId === item.sourceId);
    check(record && Number.isInteger(record.storeys) && record.storeys > 0 && record.physicalHeightM === null, `unverified neighbour evidence: ${item.sourceId}`);
    return {sourceId: item.sourceId, storeys: record.storeys, assumedFloorHeightM: 3.2, heightM: record.storeys * 3.2, physicalHeightM: null,
      geometryLocalM: structuredClone(item.geometryLocalM), status: 'verified_storeys_times_assumed_floor_height_not_measured_height_or_2050_design'};
  });
  const crossLine = point => [-1, 1].map(sign => point.map((value, axis) => value + sign * ramp.normalLocalM[axis] * ramp.widthM / 2));
  const rainfallCases = [50, 100].map(rainfallMmPerHour => ({
    rainfallMmPerHour, durationMinutes: 30,
    roof: directRainfallScenario({areaM2: building.lengthM * building.depthM, rainfallMmPerHour, durationMinutes: 30, runoffCoefficient: 1}),
    ramp: directRainfallScenario({areaM2: ramp.lengthM * ramp.widthM, rainfallMmPerHour, durationMinutes: 30, runoffCoefficient: 1})
  }));
  return {
    schema: 'guil-pilot-environment.v1', scope: 'current_118_pilot_only', status: 'concept_sensitivity_analysis_not_certified_engineering',
    sunlight: {method: 'NOAA_fractional_year_approximation_no_refraction', sourceUrl: 'https://www.gml.noaa.gov/grad/solcalc/solareqns.PDF', sunCases,
      assessment: 'game_shadows_with_optional_assumed_neighbour_masses_not_legal_daylight_hours', fullInfluenceAreaCovered: false, groundAssumption: 'flat_relative_zero'},
    neighbourMasses,
    wind: {status: 'geometry_screen_only_no_wind_speed_or_CFD', neighbourGapToHeight: design.engineeringReview.clearances.neighbourClearances.map(item => ({
      sourceId: item.toFeatureId, gapM: item.distanceM, designHeightM: building.heightM, gapToHeightRatio: item.distanceM / building.heightM
    })), windSpeedMPerSecond: null, windComfortVerified: false, missingEvidence: ['현지 풍향·풍속', '전체 주변 높이·지형', 'CFD 또는 풍동 검증']},
    drainage: {status: 'direct_rain_and_ramp_fall_concept_not_runoff_routing_or_pipe_design', rainfallCases,
      rainStatus: '50_and_100_mm_per_hour_are_assumed_stress_cases_not_official_local_design_rainfall', groundSurfaceVerified: false,
      rampFallDirection: {startLocalM: [...ramp.startLocalM], endLocalM: [...ramp.endLocalM], startElevationM: ramp.startElevationM, endElevationM: ramp.endElevationM, slopeRatio: ramp.slopeRatio},
      proposedInlets: [{id: 'ramp-crest', lineLocalM: crossLine(ramp.startLocalM), elevationM: ramp.startElevationM}, {id: 'ramp-bottom', lineLocalM: crossLine(ramp.endLocalM), elevationM: ramp.endElevationM}],
      proposedInletStatus: 'concept_positions_only_not_sized_or_connected', pumpCapacityLitresPerSecond: null, dischargeNetworkVerified: false,
      limitations: ['옥상·램프의 직접 강우량만 별도 계산, 도로·인접 부지 유입은 미포함', '옥상수가 램프로 배수된다고 가정하지 않음', '집수구·펌프·차수·비상 월류·관망 용량은 미설계']},
    engineeringSafetyConclusion: 'not_assessed', replicationGate: 'hold_pending_review',
    notices: ['건물 높이를 변경하면 태양 고도별 그림자 길이와 간격/높이 비를 다시 계산합니다.', '2050년 6월·12월 21일은 비교 날짜이며 연속 일조시간 계산이나 정확한 하지·동지 시각을 의미하지 않습니다.', '측량 지반 대신 평지 가정으로 표현하며 실제 경사·침수·풍속·구조 안전 판정을 하지 않습니다.']
  };
}
