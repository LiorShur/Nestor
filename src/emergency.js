// ════════════════════════════════════════════════════════════
//  EMERGENCY — fall detection, emergency button, emergency card
// ════════════════════════════════════════════════════════════
import { S, PS } from './state.js';

// ════════════════════════════════════════════════════════════
//  FALL DETECTION
// ════════════════════════════════════════════════════════════
export const FD = {
  active:       false,
  wakeLock:     null,
  sensitivity:  'medium',  // 'low' | 'medium' | 'high'

  // Algorithm state
  buffer:       [],        // rolling {svm, ax, ay, az, t} buffer
  phase:        'idle',    // 'idle' | 'detected'
  lastAlertAt:  0,
  COOLDOWN:     30000,

  // Countdown state
  countdownTimer: null,
  countdownSec:   15,
};

// Sensitivity presets: { freefallG, impactG, freefallMs, stillVar, stillMs, impactWindow, orientDeg }
export const FD_PRESETS = {
  low:    { freefallG: 0.4, impactG: 3.5, freefallMs: 150, stillVar: 0.25, stillMs: 2500, impactWindow: 500, orientDeg: 50 },
  medium: { freefallG: 0.6, impactG: 2.0, freefallMs: 80,  stillVar: 0.4,  stillMs: 2000, impactWindow: 600, orientDeg: 40 },
  high:   { freefallG: 0.8, impactG: 1.5, freefallMs: 50,  stillVar: 0.5,  stillMs: 1500, impactWindow: 800, orientDeg: 30 },
};

export async function toggleFallMonitoring() {
  if (FD.active) {
    stopFallMonitoring();
  } else {
    await startFallMonitoring();
  }
}

export async function startFallMonitoring() {
  // iOS 13+ requires explicit permission via user gesture
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceMotionEvent.requestPermission();
      if (perm !== 'granted') {
        toast(t('Motion sensor permission required for fall detection'));
        return;
      }
    } catch(e) {
      toast('Could not access motion sensors: ' + (e.message || e));
      return;
    }
  } else if (typeof DeviceMotionEvent === 'undefined') {
    toast(t('Motion sensors not available on this device'));
    return;
  }

  FD.active = true;
  FD.phase = 'idle';
  FD.buffer = [];

  document.getElementById('fall-toggle').classList.add('active');
  document.getElementById('fall-indicator').classList.add('show');
  _updateSensitivityLabel();

  window.addEventListener('devicemotion', _onDeviceMotion);

  // Verify we actually receive events (some devices/browsers silently fail)
  FD._verifyTimer = setTimeout(() => {
    if (FD.active && FD.buffer.length === 0) {
      toast('No motion data received — sensor may not be available');
      stopFallMonitoring();
    }
  }, 2000);

  // Request wake lock to keep screen on during monitoring
  try {
    if ('wakeLock' in navigator) {
      FD.wakeLock = await navigator.wakeLock.request('screen');
      FD.wakeLock.addEventListener('release', () => { FD.wakeLock = null; });
    }
  } catch(e) {}

  toast(t('Fall detection active — keep phone on your body'));
}

export function stopFallMonitoring() {
  FD.active = false;
  FD.phase = 'idle';
  clearTimeout(FD._verifyTimer);
  window.removeEventListener('devicemotion', _onDeviceMotion);

  document.getElementById('fall-toggle').classList.remove('active');
  document.getElementById('fall-indicator').classList.remove('show');

  if (FD.wakeLock) { FD.wakeLock.release().catch(()=>{}); FD.wakeLock = null; }
}

export function cycleFallSensitivity() {
  const levels = ['low', 'medium', 'high'];
  const i = levels.indexOf(FD.sensitivity);
  FD.sensitivity = levels[(i + 1) % levels.length];
  _updateSensitivityLabel();
  toast(t('Fall Detection') + ': ' + FD.sensitivity);
}

export function _updateSensitivityLabel() {
  const el = document.getElementById('fall-sensitivity-label');
  if (el) el.textContent = FD.sensitivity;
}

export function _onDeviceMotion(evt) {
  // Use acceleration (without gravity) if available, else fall back to accelerationIncludingGravity
  let a = evt.acceleration;
  let includesGravity = false;
  if (!a || a.x === null || a.y === null) {
    a = evt.accelerationIncludingGravity;
    includesGravity = true;
  }
  if (!a || a.x === null) return;

  const now = Date.now();
  const ax = a.x, ay = a.y, az = a.z;
  // SVM in g-force
  let svm = Math.sqrt(ax*ax + ay*ay + az*az) / 9.81;
  // If using accelerationIncludingGravity, at rest svm ≈ 1g
  // If using acceleration (no gravity), at rest svm ≈ 0g

  // Store raw gravity vector for orientation change detection
  const g = evt.accelerationIncludingGravity;
  const gx = g ? (g.x || 0) : 0;
  const gy = g ? (g.y || 0) : 0;
  const gz = g ? (g.z || 0) : 0;

  FD.buffer.push({ svm, gx, gy, gz, t: now, incGrav: includesGravity });
  if (FD.buffer.length > 200) FD.buffer.shift();

  if (now - FD.lastAlertAt < FD.COOLDOWN) return;
  if (FD.phase !== 'idle') return;

  const P = FD_PRESETS[FD.sensitivity];

  // ── DETECTION PATH 1: Classic free-fall → impact → stillness ──
  // Check for recent free-fall in the buffer
  const freefallSamples = _findFreeFall(now, P);
  if (freefallSamples) {
    const impact = _findImpact(freefallSamples.endTime, now, P);
    if (impact) {
      const still = _checkStillness(impact.time, now, P);
      if (still) { _onFallDetected(); return; }
    }
  }

  // ── DETECTION PATH 2: Sudden impact + orientation change + stillness ──
  // Catches softer/cushioned falls that may lack a clean free-fall phase
  const recentImpact = _findRecentImpact(now, P);
  if (recentImpact) {
    const orientChanged = _checkOrientationChange(recentImpact.time, now, P);
    const still = _checkStillness(recentImpact.time, now, P);
    if (orientChanged && still) { _onFallDetected(); return; }
  }
}

export function _findFreeFall(now, P) {
  // Look for a stretch of low SVM in recent buffer
  let start = 0, count = 0;
  for (let i = FD.buffer.length - 1; i >= 0; i--) {
    const s = FD.buffer[i];
    if (now - s.t > 3000) break; // only look back 3s
    // For accelerationIncludingGravity, free-fall means svm drops TOWARD 0 (below freefallG)
    // For acceleration (no gravity), free-fall means svm is near 0
    const threshold = s.incGrav ? P.freefallG : (P.freefallG * 0.5);
    if (s.svm < threshold) {
      count++;
      start = s.t;
    } else if (count > 0) {
      // Check if the stretch was long enough
      const endT = FD.buffer[i + 1] ? FD.buffer[i + 1].t : now;
      if (endT - start >= P.freefallMs) {
        return { startTime: start, endTime: endT };
      }
      count = 0;
    }
  }
  // Check trailing sequence
  if (count > 0) {
    const endT = FD.buffer[FD.buffer.length - 1].t;
    if (endT - start >= P.freefallMs) {
      return { startTime: start, endTime: endT };
    }
  }
  return null;
}

export function _findImpact(afterTime, now, P) {
  for (let i = FD.buffer.length - 1; i >= 0; i--) {
    const s = FD.buffer[i];
    if (s.t < afterTime) break;
    if (s.t > afterTime + P.impactWindow) continue;
    if (s.svm > P.impactG) return { time: s.t, svm: s.svm };
  }
  return null;
}

export function _findRecentImpact(now, P) {
  // Find the highest SVM spike in the last 3 seconds
  let best = null;
  for (let i = FD.buffer.length - 1; i >= 0; i--) {
    const s = FD.buffer[i];
    if (now - s.t > 3000) break;
    if (s.svm > P.impactG && (!best || s.svm > best.svm)) {
      best = { time: s.t, svm: s.svm };
    }
  }
  return best;
}

export function _checkStillness(afterTime, now, P) {
  const elapsed = now - afterTime;
  if (elapsed < P.stillMs) return false;
  const window = FD.buffer.filter(s => s.t >= afterTime && s.t <= afterTime + P.stillMs);
  if (window.length < 10) return false;
  const mean = window.reduce((s, r) => s + r.svm, 0) / window.length;
  const variance = window.reduce((s, r) => s + (r.svm - mean) ** 2, 0) / window.length;
  return variance < P.stillVar;
}

export function _checkOrientationChange(sinceTime, now, P) {
  // Compare gravity vector direction before the event vs after
  // A fall typically changes orientation by 40-90 degrees (upright → horizontal)
  const before = FD.buffer.filter(s => s.t < sinceTime && s.t > sinceTime - 1000);
  const after  = FD.buffer.filter(s => s.t > sinceTime + 500 && s.t <= now);
  if (before.length < 5 || after.length < 5) return false;

  const avgVec = (samples) => {
    const n = samples.length;
    return {
      x: samples.reduce((s, r) => s + r.gx, 0) / n,
      y: samples.reduce((s, r) => s + r.gy, 0) / n,
      z: samples.reduce((s, r) => s + r.gz, 0) / n,
    };
  };
  const bv = avgVec(before), av = avgVec(after);

  // Angle between the two vectors (dot product / magnitudes)
  const dot = bv.x*av.x + bv.y*av.y + bv.z*av.z;
  const magB = Math.sqrt(bv.x*bv.x + bv.y*bv.y + bv.z*bv.z);
  const magA = Math.sqrt(av.x*av.x + av.y*av.y + av.z*av.z);
  if (magB < 0.1 || magA < 0.1) return false;

  const cosAngle = Math.max(-1, Math.min(1, dot / (magB * magA)));
  const angleDeg = Math.acos(cosAngle) * (180 / Math.PI);

  return angleDeg >= P.orientDeg;
}

export function _onFallDetected(alertTitle) {
  FD.lastAlertAt = Date.now();
  if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);

  // Show countdown overlay — auto-calls carer if not cancelled
  document.getElementById('fall-alert-title').textContent = alertTitle || t('Fall Detected');
  const alert = document.getElementById('fall-alert');
  alert.classList.add('show');
  FD.countdownSec = 5; // short for testing — increase to 15 for production
  document.getElementById('fall-countdown').textContent = FD.countdownSec;

  _registerTick('fallCountdown', () => {
    FD.countdownSec--;
    document.getElementById('fall-countdown').textContent = FD.countdownSec;
    if (navigator.vibrate) navigator.vibrate(100);
    if (FD.countdownSec <= 0) {
      _unregisterTick('fallCountdown');
      document.getElementById('fall-alert').classList.remove('show');
      _sendFallCall();
    }
  });
}

// ── Emergency button: hold-to-activate safety mechanism ──
export let _emergencyTimer = null;
export let _emergencyStart = 0;
export const EMERGENCY_HOLD_MS = 3000; // 3 seconds to activate
export let _emergencyAnimFrame = null;

export function _emergencyDown(evt) {
  evt.preventDefault();
  if (PS.status === 'calling' || PS.status === 'acked') return;
  _emergencyStart = Date.now();
  const btn = document.getElementById('emergency-btn');
  const hint = btn.querySelector('.emergency-hint');
  btn.classList.add('charging');
  // Countdown haptics and visual: 3... 2... 1...
  let sec = 3;
  if (hint) hint.textContent = sec + '...';
  if (navigator.vibrate) navigator.vibrate(50);
  _registerTick('emergencyCountdown', () => {
    sec--;
    if (sec > 0) {
      if (hint) hint.textContent = sec + '...';
      if (navigator.vibrate) navigator.vibrate(50);
    } else {
      _unregisterTick('emergencyCountdown');
    }
  });
  _emergencyTimer = setTimeout(() => {
    _unregisterTick('emergencyCountdown');
    _emergencyStart = 0;
    btn.classList.remove('charging');
    if (hint) hint.textContent = 'Hold 3s';
    _cancelEmergencyAnim();
    if (navigator.vibrate) navigator.vibrate(300);
    _onFallDetected(t('Emergency Alert'));
  }, EMERGENCY_HOLD_MS);
  _animateEmergencyRing();
}

export function _emergencyUp(evt) {
  evt.preventDefault();
  if (_emergencyTimer) {
    _unregisterTick('emergencyCountdown');
    clearTimeout(_emergencyTimer);
    _emergencyTimer = null;
  }
  _emergencyStart = 0;
  const btn = document.getElementById('emergency-btn');
  btn.classList.remove('charging');
  const hint = btn.querySelector('.emergency-hint');
  if (hint) hint.textContent = 'Hold 3s';
  _cancelEmergencyAnim();
  document.getElementById('emergency-ring-fill').style.strokeDashoffset = '289';
}

export function _animateEmergencyRing() {
  const ring = document.getElementById('emergency-ring-fill');
  const circumference = 289; // 2 * pi * 46
  function frame() {
    if (!_emergencyStart) return;
    const elapsed = Date.now() - _emergencyStart;
    const progress = Math.min(elapsed / EMERGENCY_HOLD_MS, 1);
    ring.style.strokeDashoffset = String(circumference * (1 - progress));
    if (progress < 1) _emergencyAnimFrame = requestAnimationFrame(frame);
  }
  _emergencyAnimFrame = requestAnimationFrame(frame);
}

export function _cancelEmergencyAnim() {
  if (_emergencyAnimFrame) { cancelAnimationFrame(_emergencyAnimFrame); _emergencyAnimFrame = null; }
}

export function cancelFallAlert() {
  _unregisterTick('fallCountdown');
  document.getElementById('fall-alert').classList.remove('show');
  toast(t("Alert cancelled — glad you're OK!"));
}

export async function _sendFallCall() {
  // Auto-send a call with type "fall" to all carers
  if (PS.status === 'calling' || PS.status === 'acked') return;
  if (!S.rooms.length) { toast(t('No carers connected')); return; }

  unlockAudio();
  setPatientStatus('calling');
  if (navigator.vibrate) navigator.vibrate(200);

  const callData = {
    fromUid:   S.uid,
    fromName:  S.name,
    avatar:    S.avatar || '',
    type:      'fall',
    message:   _buildEmergencyMessage(),
    timestamp: firebase.database.ServerValue.TIMESTAMP,
    status:    'active',
  };
  await _attachLocation(callData);

  try {
    let firstCallId = null, firstCallRoom = null;
    for (const room of S.rooms) {
      if (!room) continue;
      const callRef = db.ref(`carecall/rooms/${room}/calls`).push();
      await callRef.set({ ...callData, id: callRef.key });
      if (!firstCallId) { firstCallId = callRef.key; firstCallRoom = room; }
    }
    PS.activeCallId = firstCallId;
    PS._activeCallRoom = firstCallRoom;
    watchForAck();
    // Auto-timeout after 2 minutes
    PS._callTimeout = setTimeout(() => {
      if (PS.status === 'calling') {
        setPatientStatus('ready');
        PS.activeCallId = null;
        if (PS.callListener) { PS.callListener(); PS.callListener = null; }
      }
    }, CALL_FINAL_TIMEOUT_MS);
  } catch(e) {
    console.error('[FallCall] Failed:', e);
    toast(t('Call failed — check your connection'));
    setPatientStatus('ready');
  }
}

// ════════════════════════════════════════════════════════════
//  EMERGENCY INFO CARD (v2 — grouped layout, med auto-fill,
//  paramedic view, share/copy to clipboard)
// ════════════════════════════════════════════════════════════
export function _buildEmergencyMessage() {
  const info = _getEmergencyInfo();
  const parts = ['Fall detected'];
  if (info.fields) {
    info.fields.forEach(f => {
      if (!f.value) return;
      // Skip private identifiers from alert message; paramedic view / full card still shows them.
      if (f.key === 'dob' || f.key === 'idNumber') return;
      parts.push(f.label + ': ' + f.value);
    });
  }
  return parts.join(' | ');
}

export function _getEmergencyInfo() {
  return JSON.parse(localStorage.getItem('carecall_emergency_info') || '{"fields":[]}');
}

export function _saveEmergencyInfo(info) {
  localStorage.setItem('carecall_emergency_info', JSON.stringify(info));
  if (S.uid) db.ref(`carecall/users/${S.uid}/emergencyInfo`).set(info);
}

// Field catalogue. `group` drives the section in the view. Keeping keys stable
// (bloodType / conditions / …) means we can migrate users who already have
// the pre-v2 seed without losing their values. Weight is captured as a number
// because hospital dosing is per-kg; advanceDirectives is a short string so
// users can write "DNR on file" / "Living will with Dr X" / "None".
export const EI_DEFAULT_FIELDS = [
  { key: 'dob',               label: 'Date of Birth',         group: 'identity', value: '' },
  { key: 'idNumber',          label: 'ID / Insurance Number', group: 'identity', value: '' },
  { key: 'language',          label: 'Primary Language',      group: 'identity', value: '' },
  { key: 'weightKg',          label: 'Weight (kg)',           group: 'identity', value: '' },
  { key: 'bloodType',         label: 'Blood Type',            group: 'medical',  value: '' },
  { key: 'conditions',        label: 'Medical Conditions',    group: 'medical',  value: '' },
  { key: 'allergies',         label: 'Allergies',             group: 'medical',  value: '' },
  { key: 'advanceDirectives', label: 'Advance Directives',    group: 'medical',  value: '' },
  { key: 'preferredHospital', label: 'Preferred Hospital',    group: 'medical',  value: '' },
  { key: 'doctor',            label: 'Doctor (Name & Phone)', group: 'contacts', value: '' },
  { key: 'nextOfKin',         label: 'Next of Kin',           group: 'contacts', value: '' },
];

// Suggestion chips — tapped in edit mode to append to the field without
// overwriting. English seeds only (t() translates at render time).
export const EI_CHIP_SUGGESTIONS = {
  bloodType:  ['O+', 'O−', 'A+', 'A−', 'B+', 'B−', 'AB+', 'AB−', 'Unknown'],
  conditions: ['Diabetes Type 2', 'Hypertension', 'Dementia', 'Stroke history', 'Heart disease',
               'COPD', 'Parkinson\u2019s', 'Atrial fibrillation', 'Kidney disease', 'Cancer'],
  allergies:  ['Penicillin', 'Peanuts', 'Latex', 'Aspirin', 'Shellfish', 'Iodine / contrast',
               'Sulfa drugs', 'NSAIDs', 'None known'],
  advanceDirectives: ['DNR on file', 'Living will on file', 'Full resuscitation', 'None'],
};

// Migration: keep existing user values, add any missing default fields,
// and force the canonical label/group on default keys. The canonical
// label matters because the edit modal now renders it as a non-editable
// heading and feeds it through t() for translation — pre-existing
// user-edited labels wouldn't translate cleanly.
export function _migrateEmergencyInfo(info) {
  const existing = Array.isArray(info.fields) ? info.fields : [];
  const byKey = {};
  existing.forEach(f => { if (f.key) byKey[f.key] = f; });
  const merged = [];
  const seen = new Set();
  EI_DEFAULT_FIELDS.forEach(def => {
    if (byKey[def.key]) {
      const f = byKey[def.key];
      // Force canonical label + group on default keys.
      f.label = def.label;
      f.group = def.group;
      merged.push(f);
    } else {
      merged.push({ ...def });
    }
    seen.add(def.key);
  });
  // Preserve any user-added custom fields that aren't in the default set.
  existing.forEach(f => {
    if (!f.key || !seen.has(f.key)) {
      f.group = f.group || 'custom';
      merged.push(f);
    }
  });
  info.fields = merged;
  return info;
}

// Pretty medication line for the card — uses the richer v2 schedule helpers
// rather than the old (m.name, m.time) shape that didn't exist anymore after
// the medication-v2 overhaul. PRN meds are flagged separately so paramedics
// know they weren't taken on a schedule.
export function _emergencyMedLines() {
  let meds;
  try { meds = JSON.parse(localStorage.getItem('carecall_meds') || '[]'); }
  catch(_) { meds = []; }
  const active = meds.filter(m => m && m.enabled !== false);
  return active.map(m => {
    const label = _medDisplayLabel(m);
    const sch = m.prn ? t('As needed') : _medScheduleSummary(m);
    const ing = m.activeIngredient ? ' · ' + t('Active') + ': ' + m.activeIngredient : '';
    return { name: label, schedule: sch, prn: !!m.prn, activeIngredient: m.activeIngredient || '' };
  });
}

export const EI_GROUP_META = {
  identity: { icon: '👤', title: 'Identity' },
  medical:  { icon: '🩺', title: 'Medical' },
  contacts: { icon: '📞', title: 'Contacts' },
  custom:   { icon: '✏️', title: 'Other' },
};

export function _telLink(raw) {
  if (!raw) return '';
  // Grab the longest phone-number-looking run; keep leading + and digits.
  const match = String(raw).match(/\+?[0-9][0-9\s\-()]{5,}/);
  if (!match) return '';
  const cleaned = match[0].replace(/[\s()\-]/g, '');
  return cleaned;
}

// Normalise a free-form date string to YYYY-MM-DD (the format required by
// <input type="date">). Returns '' when the input is empty or unparseable
// so we can leave the native picker blank rather than show a misleading
// fallback. Accepts what Date.parse accepts: ISO, RFC 2822, and common
// locale-formatted strings like "March 12, 1945" or "1945-03-12".
export function _toIsoDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  // Fast path: already YYYY-MM-DD.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY or DD.MM.YYYY — treat as day-first (common outside the US).
  const dmy = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const parsed = Date.parse(s);
  if (isNaN(parsed)) return '';
  const d = new Date(parsed);
  const yy = d.getFullYear();
  if (yy < 1900 || yy > 2100) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function showEmergencyCard(editMode) {
  const info = _migrateEmergencyInfo(_getEmergencyInfo());
  _saveEmergencyInfo(info);

  const medLines = _emergencyMedLines();
  const carers = (PS.allCarers || []);

  document.querySelector('.ei-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'ei-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:95;display:flex;align-items:center;justify-content:center;padding:12px';

  // Group fields for display. In edit mode we render them as a flat list so
  // the user can add custom fields at the bottom; in view mode we group.
  const groups = { identity: [], medical: [], contacts: [], custom: [] };
  info.fields.forEach(f => {
    const g = groups[f.group] ? f.group : 'custom';
    groups[g].push(f);
  });

  let body = '';

  if (editMode) {
    // Build a set of default-field keys so we can render their labels as
    // plain headings (not editable inputs) — those labels are canonical
    // and shouldn't be overwritten by the user. Custom fields keep the
    // editable label input + remove button.
    const defaultKeys = new Set(EI_DEFAULT_FIELDS.map(d => d.key));
    const indexByField = new Map();
    info.fields.forEach((f, i) => indexByField.set(f, i));

    const renderEditField = (f, i) => {
      const isDefault = defaultKeys.has(f.key);
      const chips = EI_CHIP_SUGGESTIONS[f.key];
      const chipHtml = chips ? `<div class="ei-chip-row">${chips.map(c =>
        `<span class="ei-chip" onclick="_appendEiValue(${i}, ${JSON.stringify(c).replace(/"/g,'&quot;')})">${escHtml(c)}</span>`
      ).join('')}</div>` : '';
      // DOB gets a native date picker. Try to normalise the stored value
      // to YYYY-MM-DD so the picker can surface it; if the existing value
      // isn't parseable we leave the picker empty — the user's raw value
      // is preserved until they interact with the picker. Max date is
      // today; min is 1900-01-01 (covers realistic patient ages).
      let inputEl;
      if (f.key === 'dob') {
        const iso = _toIsoDate(f.value);
        const today = new Date();
        const todayIso = today.toISOString().slice(0, 10);
        inputEl = `<input type="date" class="ei-value-input" id="ei-value-${i}"
          value="${escHtml(iso)}" data-idx="${i}" data-type="value"
          min="1900-01-01" max="${todayIso}">`;
      } else {
        inputEl = `<input type="text" class="ei-value-input" id="ei-value-${i}"
          value="${escHtml(f.value)}" data-idx="${i}" data-type="value"
          placeholder="${escHtml(t('Value'))}">`;
      }
      if (isDefault) {
        // Heading + value (no editable label, no remove button — the
        // migration would just re-add a removed default on next render).
        return `
          <div class="ei-field-row ei-field-row-fixed">
            <div class="ei-field-heading">${escHtml(t(f.label))}</div>
            ${inputEl}
          </div>
          ${chipHtml}`;
      }
      // Custom field: editable label + value + remove.
      return `
        <div class="ei-field-row">
          <input class="ei-label-input" value="${escHtml(f.label)}" data-idx="${i}" data-type="label" placeholder="${escHtml(t('Field name'))}">
          <button class="ei-remove-btn" onclick="_removeEiField(${i})" aria-label="${escHtml(t('Remove'))}">✕</button>
          ${inputEl}
        </div>
        ${chipHtml}`;
    };

    // Render in the same grouped order as view mode so the form matches
    // the read-only layout users will see after saving.
    const renderGroupEdit = (key) => {
      const rows = groups[key];
      if (!rows || !rows.length) return '';
      const meta = EI_GROUP_META[key] || EI_GROUP_META.custom;
      let html = `<div class="ei-group-title">${meta.icon} ${t(meta.title)}</div>`;
      rows.forEach(f => { html += renderEditField(f, indexByField.get(f)); });
      return html;
    };
    body += renderGroupEdit('identity');
    body += renderGroupEdit('medical');
    body += renderGroupEdit('contacts');
    body += renderGroupEdit('custom');
  } else {
    const renderGroup = (key) => {
      const rows = groups[key];
      if (!rows || !rows.length) return '';
      const visible = rows.filter(f => f.value);
      if (!visible.length) return '';
      const meta = EI_GROUP_META[key] || EI_GROUP_META.custom;
      let html = `<div class="ei-group-title">${meta.icon} ${t(meta.title)}</div>`;
      const defaultKeys = new Set(EI_DEFAULT_FIELDS.map(d => d.key));
      visible.forEach(f => {
        const phone = (f.key === 'doctor' || f.key === 'nextOfKin') ? _telLink(f.value) : '';
        const call = phone ? `<a class="ei-call-btn" href="tel:${escHtml(phone)}">📞 ${t('Call')}</a>` : '';
        const label = defaultKeys.has(f.key) ? t(f.label) : f.label;
        html += `<div class="ei-field"><strong>${escHtml(label)}:</strong> ${escHtml(f.value)}${call}</div>`;
      });
      return html;
    };
    body += renderGroup('identity');
    body += renderGroup('medical');
    body += renderGroup('contacts');
    body += renderGroup('custom');
    if (!body) body = `<div class="ei-field" style="opacity:0.6;text-align:center;padding:12px">${t('Tap Edit to add your details.')}</div>`;
  }

  // Auto-fill medications from the med list (always rendered — this is the
  // value-add of the card for paramedics).
  let medsHtml = '';
  if (medLines.length) {
    medsHtml = medLines.map(m => {
      const prnTag = m.prn ? `<span class="ei-med-prn">[${t('PRN')}]</span> ` : '';
      const meta = m.schedule ? ` <span class="ei-med-meta">${escHtml(m.schedule)}</span>` : '';
      const ing = m.activeIngredient ? ` <span class="ei-med-meta">(${escHtml(m.activeIngredient)})</span>` : '';
      return `<div class="ei-med-row">${prnTag}<span class="ei-med-name">${escHtml(m.name)}</span>${meta}${ing}</div>`;
    }).join('');
  } else {
    medsHtml = `<div class="ei-med-row" style="opacity:0.6">${t('No medications on file.')}</div>`;
  }

  let contactsHtml = '';
  if (carers.length) {
    contactsHtml = carers.map(c => {
      const phone = _telLink(c.phone);
      const call = phone ? `<a class="ei-call-btn" href="tel:${escHtml(phone)}">📞 ${t('Call')}</a>` : '';
      return `<div>${escHtml(c.name)}${c.phone ? ' — ' + escHtml(c.phone) : ''}${call}</div>`;
    }).join('');
  } else {
    contactsHtml = `<div style="opacity:0.6">${t('No carers connected')}</div>`;
  }

  const patientPhone = _telLink(S.phone);
  const autoSection = editMode ? '' : `
    <div class="ei-auto-section">
      <div class="ei-group-title">💊 ${t('Current Medications')}</div>
      ${medsHtml}
      <div class="ei-group-title">👥 ${t('Care Team')}</div>
      ${contactsHtml}
      ${S.phone ? `<div class="ei-field" style="margin-top:6px"><strong>${t('Patient Phone')}:</strong> ${escHtml(S.phone)}${patientPhone ? ` <a class="ei-call-btn" href="tel:${escHtml(patientPhone)}">📞 ${t('Call')}</a>` : ''}</div>` : ''}
    </div>`;

  overlay.innerHTML = `
    <div class="ei-card">
      <div class="ei-header">
        <div style="font-size:2rem">🏥</div>
        <div class="ei-title">${t('EMERGENCY INFO')}</div>
        <div class="ei-name">${escHtml(S.name || t('Patient'))}</div>
      </div>
      <div class="ei-fields" id="ei-fields">${body}</div>
      ${editMode ? `<button class="ei-add-field-btn" onclick="_addEiField()">+ ${t('Add Custom Field')}</button>` : ''}
      ${autoSection}
      <div class="ei-buttons">
        ${editMode
          ? `<div class="ei-buttons-row">
               <button class="ei-btn-primary" onclick="_saveEiFromModal()">${t('Save')}</button>
               <button class="ei-btn-secondary" onclick="showEmergencyCard(false)">${t('Cancel')}</button>
             </div>`
          : `<button class="ei-btn-danger" onclick="showParamedicView()">🚑 ${t('Show to Paramedic')}</button>
             <div class="ei-buttons-row">
               <button class="ei-btn-ghost" onclick="_shareEmergencyCard()">📤 ${t('Share')}</button>
               <button class="ei-btn-ghost" onclick="_copyEmergencyCard()">📋 ${t('Copy')}</button>
             </div>
             <div class="ei-buttons-row">
               <button class="ei-btn-primary" onclick="showEmergencyCard(true)">${t('Edit')}</button>
               <button class="ei-btn-secondary" onclick="document.querySelector('.ei-overlay').remove()">${t('Close')}</button>
             </div>`
        }
      </div>
    </div>`;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

export function _appendEiValue(idx, chipText) {
  const el = document.getElementById('ei-value-' + idx);
  if (!el) return;
  const cur = (el.value || '').trim();
  // Don't duplicate — skip if already present.
  const parts = cur ? cur.split(/\s*,\s*/) : [];
  if (parts.includes(chipText)) return;
  parts.push(chipText);
  el.value = parts.join(', ');
  el.focus();
}

export function _saveEiFromModal() {
  const info = _getEmergencyInfo();
  document.querySelectorAll('.ei-label-input').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    if (info.fields[idx]) info.fields[idx].label = el.value.trim();
  });
  document.querySelectorAll('.ei-value-input').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    if (info.fields[idx]) info.fields[idx].value = el.value.trim();
  });
  _saveEmergencyInfo(info);
  toast(t('Emergency info saved'));
  showEmergencyCard(false);
}

export function _addEiField() {
  const info = _getEmergencyInfo();
  info.fields.push({ key: 'custom_' + Date.now(), label: '', value: '', group: 'custom' });
  _saveEmergencyInfo(info);
  showEmergencyCard(true);
}

export function _removeEiField(idx) {
  const info = _getEmergencyInfo();
  info.fields.splice(idx, 1);
  _saveEmergencyInfo(info);
  showEmergencyCard(true);
}

// Produce a human-readable plain-text summary of the whole card for copy /
// share. Ordered like the on-screen layout.
export function _emergencyCardText() {
  const info = _migrateEmergencyInfo(_getEmergencyInfo());
  const lines = [];
  lines.push('=== EMERGENCY INFO ===');
  lines.push(S.name || 'Patient');
  lines.push('');
  const groupOrder = ['identity', 'medical', 'contacts', 'custom'];
  groupOrder.forEach(key => {
    const rows = info.fields.filter(f => (f.group || 'custom') === key && f.value);
    if (!rows.length) return;
    const meta = EI_GROUP_META[key] || EI_GROUP_META.custom;
    lines.push('-- ' + meta.title.toUpperCase() + ' --');
    rows.forEach(f => lines.push(f.label + ': ' + f.value));
    lines.push('');
  });
  const medLines = _emergencyMedLines();
  if (medLines.length) {
    lines.push('-- CURRENT MEDICATIONS --');
    medLines.forEach(m => {
      const tag = m.prn ? '[PRN] ' : '';
      const ing = m.activeIngredient ? ' (' + m.activeIngredient + ')' : '';
      lines.push('• ' + tag + m.name + ' — ' + (m.schedule || '') + ing);
    });
    lines.push('');
  }
  const carers = PS.allCarers || [];
  if (carers.length) {
    lines.push('-- CARE TEAM --');
    carers.forEach(c => lines.push((c.name || '') + (c.phone ? ' — ' + c.phone : '')));
    lines.push('');
  }
  if (S.phone) lines.push('Patient Phone: ' + S.phone);
  return lines.join('\n');
}

export async function _copyEmergencyCard() {
  const text = _emergencyCardText();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback for older webviews
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    toast(t('Copied to clipboard'));
  } catch(e) {
    toast(t('Copy failed'));
  }
}

export async function _shareEmergencyCard() {
  const text = _emergencyCardText();
  const title = 'CareCall — ' + (S.name || 'Emergency Info');
  try {
    if (navigator.share) {
      await navigator.share({ title, text });
      return;
    }
  } catch(e) { /* user cancelled share sheet — silent */ }
  // No Web Share → fall back to copy
  _copyEmergencyCard();
}

export function showParamedicView() {
  const info = _migrateEmergencyInfo(_getEmergencyInfo());
  const medLines = _emergencyMedLines();
  const carers = PS.allCarers || [];

  const byKey = {};
  info.fields.forEach(f => { if (f.key) byKey[f.key] = f; });
  const pick = key => (byKey[key] && byKey[key].value) || '';

  const row = (label, value, phone) => {
    if (!value) return '';
    const call = phone ? ` <a class="ei-call-btn" href="tel:${escHtml(phone)}">📞 Call</a>` : '';
    return `<div class="pm-row"><strong>${escHtml(label)}:</strong> ${escHtml(value)}${call}</div>`;
  };

  const medsHtml = medLines.length
    ? medLines.map(m => {
        const prn = m.prn ? '[PRN] ' : '';
        const ing = m.activeIngredient ? ' — ' + escHtml(m.activeIngredient) : '';
        return `<div class="pm-med"><strong>${prn}${escHtml(m.name)}</strong><br>${escHtml(m.schedule || '')}${ing}</div>`;
      }).join('')
    : `<div class="pm-med">${t('No medications on file.')}</div>`;

  const carerRows = carers.map(c => {
    const phone = _telLink(c.phone);
    return row(c.name || '', c.phone || '', phone);
  }).join('');

  const doctorPhone = _telLink(pick('doctor'));
  const kinPhone = _telLink(pick('nextOfKin'));
  const patientPhone = _telLink(S.phone);

  // Request screen-wake while card is showing so it stays readable in a
  // crisis. Silent-fail on browsers without WakeLock.
  let wakeLock = null;
  if ('wakeLock' in navigator) {
    try { navigator.wakeLock.request('screen').then(l => { wakeLock = l; }).catch(() => {}); }
    catch(_) {}
  }

  document.querySelector('.paramedic-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'paramedic-overlay';
  overlay.innerHTML = `
    <div class="pm-banner">EMERGENCY INFO</div>
    <h2>${escHtml(S.name || 'Patient')}</h2>
    <div class="pm-sub">
      ${pick('dob') ? 'DOB ' + escHtml(pick('dob')) : ''}
      ${pick('weightKg') ? ' · ' + escHtml(pick('weightKg')) + ' kg' : ''}
      ${pick('language') ? ' · ' + escHtml(pick('language')) : ''}
    </div>

    <div class="pm-section-title">Medical</div>
    ${row('Blood Type', pick('bloodType'))}
    ${row('Conditions', pick('conditions'))}
    ${row('Allergies', pick('allergies'))}
    ${row('Advance Directives', pick('advanceDirectives'))}
    ${row('Preferred Hospital', pick('preferredHospital'))}

    <div class="pm-section-title">Current Medications</div>
    ${medsHtml}

    <div class="pm-section-title">Contacts</div>
    ${row('Doctor', pick('doctor'), doctorPhone)}
    ${row('Next of Kin', pick('nextOfKin'), kinPhone)}
    ${S.phone ? row('Patient Phone', S.phone, patientPhone) : ''}
    ${carerRows ? '<div class="pm-section-title">Care Team</div>' + carerRows : ''}
    ${pick('idNumber') ? `<div class="pm-section-title">Identifiers</div>${row('ID / Insurance', pick('idNumber'))}` : ''}

    <button class="pm-close" onclick="this.closest('.paramedic-overlay')._dismiss()">${t('Close')}</button>`;
  overlay._dismiss = () => {
    if (wakeLock && wakeLock.release) { try { wakeLock.release(); } catch(_) {} }
    overlay.remove();
  };
  document.body.appendChild(overlay);
}

// Alias for backward compat (settings button calls this)
export function editEmergencyInfo() { showEmergencyCard(true); }

