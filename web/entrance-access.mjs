/** Local exhibition controller, NOT authentication or a credential store. */
export function createDemoEntranceAccess({demoCode = '2050', openDurationMs = 5000} = {}) {
  if (typeof demoCode !== 'string' || !/^\d{4,6}$/.test(demoCode) || !Number.isFinite(openDurationMs) || openDurationMs <= 0) throw new Error('Invalid entrance demo settings.');
  let digits = '', state = 'closed', closeAtMs = null, previousTimeMs = null;
  const snapshot = () => ({state, maskedDigits: '●'.repeat(digits.length), digitCount: digits.length, closeAtMs});
  const clock = value => {
    if (!Number.isFinite(value) || value < 0 || (previousTimeMs !== null && value < previousTimeMs)) throw new Error('Entrance demo requires a finite monotonic time.');
    previousTimeMs = value;
  };
  return {
    snapshot,
    input(value) {
      if (typeof value !== 'string' || !/^\d{0,6}$/.test(value)) throw new Error('Enter up to six numeric digits.');
      if (state === 'open') return snapshot();
      digits = value; state = digits.length ? 'entering' : 'closed'; return snapshot();
    },
    submit(nowMs) {
      clock(nowMs);
      if (state === 'open') return snapshot();
      if (digits === demoCode) { state = 'open'; closeAtMs = nowMs + openDurationMs; }
      else state = 'error';
      digits = ''; return snapshot();
    },
    clear() { if (state !== 'open') { digits = ''; state = 'closed'; } return snapshot(); },
    close() { digits = ''; state = 'closed'; closeAtMs = null; return snapshot(); },
    update(nowMs) { clock(nowMs); if (state === 'open' && nowMs >= closeAtMs) { state = 'closed'; closeAtMs = null; } return snapshot(); }
  };
}
