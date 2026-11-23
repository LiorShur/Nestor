// ════════════════════════════════════════════════════════════
//  MEDICATIONS — medication schema, scheduling, reminders, interactions
// ════════════════════════════════════════════════════════════
import { S, PS } from './state.js';

// ════════════════════════════════════════════════════════════
//  MEDICATION REMINDERS
// ════════════════════════════════════════════════════════════
// Medication schema (v2):
// {
//   id, name,
//   dose, unit,                    // e.g., 500, 'mg'  (dose may also be a string for free text)
//   instructions,                  // free text, e.g., 'with food'
//   schedule: {
//     kind: 'fixed_times'|'interval'|'days_of_week'|'prn',
//     times: ['HH:MM', ...],       // fixed_times / days_of_week
//     days: [0..6],                // days_of_week (0=Sun)
//     interval_hours: number,      // interval
//     anchor: 'HH:MM',             // interval: first dose of the day
//     window_minutes: number,      // flex window (default 60)
//   },
//   stock, refillThreshold,
//   prn,                           // true => log-only, no auto-reminder
//   enabled, createdBy, createdAt,
// }
export let _medications = [];
export let _medTimers = [];
export let _scheduledMedNotifIds = [];          // native notif IDs we scheduled
export let _recentMedEvents = {};               // medId -> ms timestamp of last 'taken'
export let _medSnoozeCount = {};                // medId -> current snooze count for in-flight reminder
// Per-med response window now drives the auto-missed timeout
// (med.schedule.window_minutes; default 60 min via _migrateMedSchema).
export const MED_SNOOZE_MS = 15 * 60 * 1000;    // snooze duration

// Map UI language code to a BCP-47 tag for TTS engines.
export const TTS_LANG_MAP = {
  en: 'en-US', es: 'es-ES', zh: 'zh-CN', hi: 'hi-IN', ar: 'ar-SA',
  he: 'he-IL', ru: 'ru-RU', fr: 'fr-FR', am: 'am-ET',
};
export function _ttsEnabled() { return localStorage.getItem('carecall_tts') !== '0'; }
export function toggleTts() {
  const next = _ttsEnabled() ? '0' : '1';
  localStorage.setItem('carecall_tts', next);
  const btn = document.getElementById('tts-toggle-btn');
  if (btn) btn.textContent = next === '1' ? t('On') : t('Off');
  if (next === '1') {
    // Preview so the user hears it immediately after opting in
    Native.speak(t('Spoken reminder'), TTS_LANG_MAP[_currentLang] || 'en-US');
  } else {
    Native.stopSpeaking();
  }
}
export function _refreshTtsButton() {
  const btn = document.getElementById('tts-toggle-btn');
  if (btn) btn.textContent = _ttsEnabled() ? t('On') : t('Off');
}
export const MED_MAX_SNOOZES = 2;               // after this many snoozes, auto-missed on next fire
export const MED_DOUBLE_DOSE_GUARD_MS = 10 * 60 * 1000; // warn if same med 'taken' again within this window
export let _medPromptTimer = null;
export let _medCountdownTimer = null;
export let _currentMedId = null;

export function _migrateMedSchema(med) {
  if (!med || typeof med !== 'object') return null;
  let m = med;
  if (!m.schedule || typeof m.schedule !== 'object') {
    // v1 -> v2
    m = {
      id: m.id || ('med_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
      name: m.name || '',
      dose: null,
      unit: null,
      instructions: null,
      schedule: {
        kind: 'fixed_times',
        times: m.time ? [m.time] : [],
        window_minutes: 60,
      },
      stock: null,
      refillThreshold: null,
      prn: false,
      enabled: m.enabled !== false,
      createdBy: 'patient',
      createdAt: Date.now(),
    };
  }
  // Single-photo (v2a) -> multi-photo (v2b). Idempotent.
  if (!Array.isArray(m.photos)) {
    m.photos = (typeof m.photoUrl === 'string' && m.photoUrl) ? [m.photoUrl] : [];
  }
  // Strip legacy field so saves don't re-emit it
  if ('photoUrl' in m) delete m.photoUrl;
  // v2c: activeIngredient (generic / INN name) — used for interaction
  // checks instead of local commercial names so RxNav can resolve it.
  if (typeof m.activeIngredient === 'undefined') m.activeIngredient = null;
  // v2d: rxcui (RxNorm Concept Unique Identifier) — used for drug
  // interaction lookups via the NIH RxNav API.
  if (typeof m.rxcui === 'undefined') m.rxcui = null;
  // v2e: interactions (cached interaction warnings from last check)
  if (typeof m.interactions === 'undefined') m.interactions = null;
  return m;
}

export function _normalizeMeds(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(_migrateMedSchema).filter(m => m && m.name);
}

export function _loadMedications() {
  try {
    _medications = _normalizeMeds(JSON.parse(localStorage.getItem('carecall_meds') || '[]'));
  } catch(e) { _medications = []; }
}

export function _saveMedications() {
  localStorage.setItem('carecall_meds', JSON.stringify(_medications));
  if (S.uid) {
    db.ref(`carecall/users/${S.uid}/medications`).set(_medications);
  }
  // Mirror medications to every shared room so carers and family
  // members (who are room members) can read/write via medConfig.
  if (S.rooms && S.rooms.length) {
    S.rooms.forEach(room => {
      db.ref(`carecall/rooms/${room}/medConfig`).set(_medications)
        .catch(e => { /* best effort — room may not exist yet */ });
    });
  }
}

export function _medDisplayLabel(med) {
  if (!med) return 'Medication';
  const parts = [med.name];
  if (med.dose !== null && med.dose !== undefined && med.dose !== '') {
    parts.push(String(med.dose) + (med.unit || ''));
  }
  return parts.join(' ');
}

export function removeMedication(id) {
  _medications = _medications.filter(m => m.id !== id);
  _saveMedications();
  refreshSettings();
  _scheduleAllMedNotifications();
}

export function toggleMedication(id) {
  const med = _medications.find(m => m.id === id);
  if (med) { med.enabled = !med.enabled; _saveMedications(); refreshSettings(); _scheduleAllMedNotifications(); }
}

export function _medScheduleSummary(med) {
  const sch = med.schedule || {};
  let base = '';
  if (med.prn) base = t('As needed');
  else if (sch.kind === 'interval') {
    const h = sch.interval_hours || '?';
    base = t('Every') + ' ' + h + 'h (' + t('from') + ' ' + (sch.anchor || '08:00') + ')';
  } else if (sch.kind === 'days_of_week' && Array.isArray(sch.days) && sch.days.length) {
    const dayLabels = [t('Sun'), t('Mon'), t('Tue'), t('Wed'), t('Thu'), t('Fri'), t('Sat')];
    const days = sch.days.slice().sort().map(i => dayLabels[i]).join(' ');
    const times = Array.isArray(sch.times) && sch.times.length ? ' · ' + sch.times.join(', ') : '';
    base = days + times;
  } else if (Array.isArray(sch.times) && sch.times.length) {
    base = sch.times.join(', ');
  } else {
    base = '—';
  }
  if (typeof med.stock === 'number') {
    base += ' · ' + med.stock + ' ' + t('left');
  }
  return base;
}

export function _medNeedsRefill(med) {
  return typeof med.stock === 'number' &&
         typeof med.refillThreshold === 'number' &&
         med.stock <= med.refillThreshold;
}

export function _renderMedsList() {
  const list = document.getElementById('meds-list');
  if (!list) return;
  list.innerHTML = '';
  if (!_medications.length) {
    list.innerHTML = '<div style="text-align:center;padding:18px 12px;color:#6889A5;font-size:0.85rem">' + t('No medications yet. Tap + Add to set up reminders.') + '</div>';
    return;
  }
  _medications.forEach(med => {
    const item = document.createElement('div');
    item.className = 'room-item';
    item.style.opacity = med.enabled ? '1' : '0.5';
    item.style.cursor = 'pointer';
    const label = escHtml(_medDisplayLabel(med));
    const scheduleDesc = escHtml(_medScheduleSummary(med));
    const refillBadge = _medNeedsRefill(med) ? `<span class="pm-item-refill">⚠ ${t('Refill')}</span>` : '';
    item.innerHTML = `
      <div class="med-row-tap" onclick="openMedEditor('${med.id}')" style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
        <span style="font-size:1.1rem">💊</span>
        <div style="min-width:0;flex:1">
          <div class="room-item-code" style="letter-spacing:0;font-family:'Outfit',sans-serif;font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}${refillBadge}</div>
          <div style="font-size:0.75rem;color:#6889A5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${scheduleDesc}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="room-remove-btn" style="background:rgba(14,165,233,0.12);color:var(--carer-primary)" onclick="event.stopPropagation();toggleMedication('${med.id}')">${med.enabled ? t('On') : t('Off')}</button>
      </div>`;
    list.appendChild(item);
  });
}

// Returns next occurrence of HH:MM time after `from`, optionally restricted to allowedDays (0=Sun).
export function _nextOccurrence(timeStr, from, allowedDays) {
  if (!timeStr) return null;
  const parts = String(timeStr).split(':').map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
  // Build target using wall-clock constructor to avoid DST day-advance bugs
  let target = new Date(from.getFullYear(), from.getMonth(), from.getDate(), parts[0], parts[1], 0, 0);
  if (target <= from) target = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1, parts[0], parts[1], 0, 0);
  if (Array.isArray(allowedDays) && allowedDays.length > 0) {
    for (let i = 0; i < 7; i++) {
      if (allowedDays.includes(target.getDay())) return target;
      target = new Date(target.getFullYear(), target.getMonth(), target.getDate() + 1, parts[0], parts[1], 0, 0);
    }
    return null;
  }
  return target;
}

// All upcoming doses for one med within the next 24h.
export function _upcomingDosesFor(med, from) {
  if (!med.enabled || med.prn) return [];
  const sch = med.schedule || {};
  const result = [];
  if (sch.kind === 'interval') {
    const anchor = sch.anchor || (Array.isArray(sch.times) && sch.times[0]) || '08:00';
    const interval = Math.max(1, sch.interval_hours || 6);
    let tNext = _nextOccurrence(anchor, from);
    const limit = new Date(from.getTime() + 24 * 60 * 60 * 1000);
    let stepCount = 0;
    const baseDate = tNext ? new Date(tNext) : null;
    while (tNext && tNext < limit) {
      result.push(new Date(tNext));
      stepCount++;
      // Advance by wall-clock hours from base to avoid DST drift
      tNext = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), baseDate.getHours() + interval * stepCount, baseDate.getMinutes(), 0, 0);
    }
  } else {
    // fixed_times or days_of_week
    const times = Array.isArray(sch.times) ? sch.times : [];
    const days = Array.isArray(sch.days) && sch.days.length ? sch.days : null;
    times.forEach(timeStr => {
      const t2 = _nextOccurrence(timeStr, from, days);
      if (t2) result.push(t2);
    });
  }
  return result.sort((a, b) => a - b);
}

export function _scheduleAllMedNotifications() {
  // Cancel prior web timers
  _medTimers.forEach(timer => clearTimeout(timer));
  _medTimers = [];
  // Cancel prior native notifications we scheduled
  if (IS_NATIVE) {
    _scheduledMedNotifIds.forEach(id => {
      try { Native.cancelLocalNotification(id); } catch(e) {}
    });
  }
  _scheduledMedNotifIds = [];
  if (S.role !== 'patient') return;

  const now = new Date();
  let nextId = 10000;

  _medications.filter(m => m.enabled && !m.prn).forEach(med => {
    _upcomingDosesFor(med, now).forEach(target => {
      const delay = target - now;
      if (delay < 0) return;
      if (IS_NATIVE) {
        const notifId = nextId++;
        Native.scheduleLocalNotification({
          id: notifId,
          title: '💊 ' + t('Medication Time'),
          body: _medDisplayLabel(med),
          at: target,
          channelId: 'carecall_reminders',
          data: { type: 'medication', medId: med.id, scheduledAt: target.toISOString() },
        });
        _scheduledMedNotifIds.push(notifId);
      }
      // Web fallback — works when app is open
      const timer = setTimeout(() => {
        try {
          _showMedPrompt(med);
        } finally {
          _scheduleAllMedNotifications();
        }
      }, delay);
      _medTimers.push(timer);
    });
  });
}

export function _showMedPrompt(med) {
  if (PS.status === 'calling' || PS.status === 'acked') return;
  _currentMedId = med.id;
  document.getElementById('med-prompt-name').textContent = _medDisplayLabel(med);
  const instrEl = document.getElementById('med-prompt-instructions');
  if (instrEl) {
    instrEl.textContent = med.instructions || '';
    instrEl.style.display = med.instructions ? '' : 'none';
  }
  // Photos (if any) replace the generic 💊 icon for visual recognition.
  // The primary photo is shown in the tile; tapping opens the full-screen
  // viewer which lets the user flip through additional photos (pill / box
  // / insert) via swipe, arrows, or arrow-keys on desktop.
  const photoEl = document.getElementById('med-prompt-photo');
  const iconEl = document.getElementById('med-prompt-icon');
  const photos = Array.isArray(med.photos) ? med.photos.filter(Boolean) : [];
  if (photoEl && iconEl) {
    if (photos.length) {
      photoEl.style.backgroundImage = "url('" + photos[0].replace(/'/g, "\\'") + "')";
      photoEl.style.display = '';
      iconEl.style.display = 'none';
      // Dot indicators + tap-to-view wiring (rebuilt each prompt)
      photoEl.onclick = () => openPhotoViewer(photos, 0);
      photoEl.innerHTML = photos.length > 1
        ? '<div class="med-prompt-photo-dots">' + photos.map((_, i) => '<span></span>').join('') + '</div>'
        : '';
    } else {
      photoEl.style.display = 'none';
      iconEl.style.display = '';
      photoEl.onclick = null;
      photoEl.innerHTML = '';
    }
  }
  document.getElementById('med-prompt').classList.add('show');
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
  unlockAudio(); playBell();
  // Spoken reminder (if user has TTS enabled): short natural utterance
  // in the current UI language. Fires after the bell so they don't overlap
  // too harshly.
  if (_ttsEnabled()) {
    const label = _medDisplayLabel(med);
    const sayInstr = med.instructions ? '. ' + med.instructions : '';
    const phrase = t('Time to take') + ' ' + label + sayInstr;
    const lang = TTS_LANG_MAP[_currentLang] || 'en-US';
    setTimeout(() => Native.speak(phrase, lang), 650);
  }

  // Per-med flexible response window (default 60 min). The prompt stays
  // responsive for this long; carer is only alerted after it closes.
  const windowMin = Math.max(1, ((med.schedule && med.schedule.window_minutes) || 60));
  const windowMs = windowMin * 60 * 1000;
  let remaining = Math.ceil(windowMs / 1000);
  const cdEl = document.getElementById('med-countdown');
  cdEl.textContent = t('Carer alerted if not taken in') + ' ' + formatDuration(remaining * 1000);
  _registerTick('medCountdown', () => {
    remaining--;
    if (remaining > 0) {
      cdEl.textContent = t('Carer alerted if not taken in') + ' ' + formatDuration(remaining * 1000);
    } else {
      _unregisterTick('medCountdown');
    }
  });

  _medPromptTimer = setTimeout(() => {
    document.getElementById('med-prompt').classList.remove('show');
    _unregisterTick('medCountdown');
    _logMedEvent(med, 'missed');
    _sendMedAlert(med, 'med-missed', t('Missed medication') + ': ' + _medDisplayLabel(med));
    _medSnoozeCount[med.id] = 0;
  }, windowMs);
}

export function _wasRecentlyTaken(medId, withinMs) {
  const last = _recentMedEvents[medId];
  if (!last) return false;
  return (Date.now() - last) < withinMs;
}

export function respondMed(response) {
  clearTimeout(_medPromptTimer);
  clearInterval(_medCountdownTimer);
  Native.stopSpeaking();
  document.getElementById('med-prompt').classList.remove('show');
  const med = _medications.find(m => m.id === _currentMedId);
  const label = _medDisplayLabel(med);

  if (response === 'taken') {
    // Double-dose guard: prevent accidental duplicate log within the guard window
    if (med && _wasRecentlyTaken(med.id, MED_DOUBLE_DOSE_GUARD_MS)) {
      const mins = Math.round(MED_DOUBLE_DOSE_GUARD_MS / 60000);
      const ok = confirm(label + ' ' + t('was already logged recently') + ' (' + mins + ' min). ' + t('Log again?'));
      if (!ok) return;
    }
    if (navigator.vibrate) navigator.vibrate([50]);
    toast(label + ' — ' + t('logged as taken'));
    if (med) _logMedEvent(med, 'taken');
    _medSnoozeCount[_currentMedId] = 0;
    return;
  }

  if (response === 'snoozed') {
    const count = (_medSnoozeCount[_currentMedId] || 0) + 1;
    if (count > MED_MAX_SNOOZES) {
      toast(label + ' — ' + t('max snoozes reached, marked as missed'));
      if (med) {
        _logMedEvent(med, 'missed');
        _sendMedAlert(med, 'med-missed', t('Missed medication') + ': ' + label);
      }
      _medSnoozeCount[_currentMedId] = 0;
      return;
    }
    _medSnoozeCount[_currentMedId] = count;
    toast(label + ' — ' + t('snoozed 15 min'));
    if (IS_NATIVE) {
      // Schedule a native one-off so snooze survives app background/close
      const notifId = 19000 + Math.floor(Math.random() * 1000);
      Native.scheduleLocalNotification({
        id: notifId,
        title: '💊 ' + t('Medication Reminder'),
        body: label,
        at: new Date(Date.now() + MED_SNOOZE_MS),
        channelId: 'carecall_reminders',
        data: { type: 'medication', medId: _currentMedId, snoozed: true },
      });
      _scheduledMedNotifIds.push(notifId);
    } else {
      setTimeout(() => { if (med) _showMedPrompt(med); }, MED_SNOOZE_MS);
    }
    return;
  }

  // skipped
  toast(label + ' — ' + t('skipped'));
  if (med) {
    _logMedEvent(med, 'skipped');
    _sendMedAlert(med, 'med-missed', t('Skipped medication') + ': ' + label);
  }
  _medSnoozeCount[_currentMedId] = 0;
}

export function _logMedEvent(med, status) {
  if (status === 'taken') _recentMedEvents[med.id] = Date.now();

  // ── Stock tracking: decrement on 'taken', fire a refill alert when
  //    stock first drops to or below refillThreshold. One alert per
  //    threshold crossing — clearing happens on refill (handled in
  //    saveMedFromEditor / editor save path).
  if (status === 'taken' && typeof med.stock === 'number' && med.stock > 0) {
    med.stock -= 1;
    if (typeof med.refillThreshold === 'number' &&
        med.stock <= med.refillThreshold &&
        !med.refillAlerted) {
      med.refillAlerted = true;
      const label = _medDisplayLabel(med);
      const msg = t('Refill needed') + ': ' + label + ' (' + med.stock + ' ' + t('left') + ')';
      _sendMedAlert(med, 'med-refill', msg);
    }
    _saveMedications();
  }

  const room = S.activeRoom || S.rooms[0];
  if (!room) return;
  const path = `carecall/rooms/${room}/medications`;
  const payload = {
    uid: S.uid, name: S.name,
    medName: med.name, medId: med.id,
    dose: med.dose || null, unit: med.unit || null,
    status: status,
    timestamp: Date.now(), // client timestamp — survives offline queueing
  };
  _medEventEnqueueAndSend(path, payload);
}

// ──────────────────────────────────────────────────────────
//  OFFLINE-FIRST MED EVENT QUEUE
//  RTDB web SDK queues pending writes in memory only, so a page
//  reload before reconnect drops them. We persist every event to
//  localStorage first; a direct push is attempted immediately and
//  on success the entry is removed. Boot + reconnect flush the
//  queue. Client timestamps are used so replayed events keep
//  their original dose time.
// ──────────────────────────────────────────────────────────
export const MED_QUEUE_KEY = 'carecall_med_queue';
export const MED_QUEUE_MAX = 500;

export function _medQueueLoad() {
  try { return JSON.parse(localStorage.getItem(MED_QUEUE_KEY) || '[]'); }
  catch(e) { return []; }
}
export function _medQueueSave(q) {
  try { localStorage.setItem(MED_QUEUE_KEY, JSON.stringify(q)); }
  catch(e) { console.warn('[med queue] save failed', e && e.message); }
}
export function _medQueueRemove(id) {
  const q = _medQueueLoad().filter(e => e.id !== id);
  _medQueueSave(q);
}

export function _medEventEnqueueAndSend(path, data) {
  const id = 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const q = _medQueueLoad();
  q.push({ id, path, data });
  if (q.length > MED_QUEUE_MAX) q.splice(0, q.length - MED_QUEUE_MAX);
  _medQueueSave(q);
  // Fire-and-forget direct push; on success remove from queue.
  try {
    db.ref(path).push(data)
      .then(() => _medQueueRemove(id))
      .catch(err => console.warn('[med queue] push deferred', err && err.message));
  } catch(e) { console.warn('[med queue] push threw', e && e.message); }
}

export async function _medQueueFlush() {
  const q = _medQueueLoad();
  if (!q.length) return;
  let flushed = 0;
  for (const entry of q) {
    try {
      await db.ref(entry.path).push(entry.data);
      _medQueueRemove(entry.id);
      flushed++;
    } catch(e) {
      // leave in queue for next flush
    }
  }
  if (flushed) {
    console.log('[med queue] flushed', flushed, 'events');
  }
}

export async function _sendMedAlert(med, type, message) {
  const callData = {
    fromUid: S.uid, fromName: S.name, avatar: S.avatar || '',
    type: type, message: message,
    timestamp: firebase.database.ServerValue.TIMESTAMP, status: 'active',
  };
  for (const room of S.rooms) {
    if (!room) continue;
    const callRef = db.ref(`carecall/rooms/${room}/calls`).push();
    await callRef.set({ ...callData, id: callRef.key });
  }
}

// ──────────────────────────────────────────────────────────
//  BRAND → ACTIVE-INGREDIENT SEED MAP
//  A curated set of the most commonly prescribed Israeli brands
//  (English + Hebrew spellings) keyed to the WHO INN / generic
//  name RxNav can resolve. Not exhaustive — the official source
//  is the Israeli MoH "Tamrur HaTerufot" at data.gov.il; this
//  covers the ~100 most-used brands so common regimens get an
//  automatic suggestion in the editor.
// ──────────────────────────────────────────────────────────
export const IL_BRAND_SEED = [
  // Analgesics / antipyretics
  ['acamol', 'Paracetamol'], ['אקמול', 'Paracetamol'],
  ['dexamol', 'Paracetamol'], ['דקסמול', 'Paracetamol'],
  ['optalgin', 'Dipyrone'], ['אופטלגין', 'Dipyrone'],
  ['advil', 'Ibuprofen'], ['אדוויל', 'Ibuprofen'],
  ['nurofen', 'Ibuprofen'], ['נורופן', 'Ibuprofen'],
  ['ibuprofen', 'Ibuprofen'],
  // NSAIDs
  ['voltaren', 'Diclofenac'], ['וולטרן', 'Diclofenac'],
  ['naproxen', 'Naproxen'], ['narocin', 'Naproxen'],
  ['etopan', 'Etodolac'], ['אטופן', 'Etodolac'],
  ['arcoxia', 'Etoricoxib'],
  // Antibiotics
  ['augmentin', 'Amoxicillin + Clavulanic acid'], ['אוגמנטין', 'Amoxicillin + Clavulanic acid'],
  ['moxypen', 'Amoxicillin'], ['מוקסיפן', 'Amoxicillin'],
  ['rocephin', 'Ceftriaxone'],
  ['zithromax', 'Azithromycin'], ['azenil', 'Azithromycin'],
  ['ciproxin', 'Ciprofloxacin'], ['ציפרוקסין', 'Ciprofloxacin'],
  ['bactrim', 'Sulfamethoxazole + Trimethoprim'],
  ['flagyl', 'Metronidazole'],
  ['keflex', 'Cephalexin'],
  // Anti-platelet / anti-coagulant
  ['coumadin', 'Warfarin'], ['קומדין', 'Warfarin'],
  ['aspirin', 'Aspirin'], ['micropirin', 'Aspirin'], ['מיקרופירין', 'Aspirin'],
  ['cartia', 'Aspirin'], ['godamed', 'Aspirin'],
  ['plavix', 'Clopidogrel'], ['פלוויקס', 'Clopidogrel'],
  ['eliquis', 'Apixaban'], ['אליקוויס', 'Apixaban'],
  ['xarelto', 'Rivaroxaban'], ['זרלטו', 'Rivaroxaban'],
  ['pradaxa', 'Dabigatran'], ['פרדקסה', 'Dabigatran'],
  ['clexane', 'Enoxaparin'],
  // Cardiac / BP
  ['concor', 'Bisoprolol'], ['קונקור', 'Bisoprolol'],
  ['normiten', 'Atenolol'], ['tenormin', 'Atenolol'],
  ['deralin', 'Propranolol'],
  ['norvasc', 'Amlodipine'], ['נורווסק', 'Amlodipine'],
  ['amlopine', 'Amlodipine'],
  ['cozaar', 'Losartan'], ['ocsaar', 'Losartan'],
  ['tritace', 'Ramipril'], ['טריטייס', 'Ramipril'],
  ['enaladex', 'Enalapril'], ['vasotec', 'Enalapril'],
  ['cardizem', 'Diltiazem'], ['adizem', 'Diltiazem'],
  ['cordarone', 'Amiodarone'], ['קורדרון', 'Amiodarone'],
  ['fusid', 'Furosemide'], ['פוסיד', 'Furosemide'],
  ['furosemide', 'Furosemide'],
  ['disothiazide', 'Hydrochlorothiazide'],
  ['spironolactone', 'Spironolactone'], ['aldactone', 'Spironolactone'],
  // Statins
  ['crestor', 'Rosuvastatin'], ['קרסטור', 'Rosuvastatin'],
  ['lipitor', 'Atorvastatin'], ['ליפיטור', 'Atorvastatin'],
  ['torvast', 'Atorvastatin'], ['lipomar', 'Atorvastatin'],
  ['zocor', 'Simvastatin'], ['simovil', 'Simvastatin'],
  // Diabetes
  ['glucophage', 'Metformin'], ['גלוקופאג', 'Metformin'],
  ['metfogamma', 'Metformin'], ['metformin', 'Metformin'],
  ['januvia', 'Sitagliptin'], ['ינוביה', 'Sitagliptin'],
  ['galvus', 'Vildagliptin'],
  ['jardiance', 'Empagliflozin'], ['ג׳ארדיאנס', 'Empagliflozin'],
  ['forxiga', 'Dapagliflozin'],
  ['ozempic', 'Semaglutide'], ['אוזמפיק', 'Semaglutide'],
  ['trulicity', 'Dulaglutide'],
  ['lantus', 'Insulin glargine'], ['levemir', 'Insulin detemir'],
  ['humalog', 'Insulin lispro'], ['novorapid', 'Insulin aspart'],
  // Thyroid
  ['euthyrox', 'Levothyroxine'], ['אותירוקס', 'Levothyroxine'],
  ['eltroxin', 'Levothyroxine'], ['אלטרוקסין', 'Levothyroxine'],
  // GI / PPIs
  ['omeprazole', 'Omeprazole'], ['losec', 'Omeprazole'],
  ['omepradex', 'Omeprazole'],
  ['controloc', 'Pantoprazole'], ['pantoprazole', 'Pantoprazole'],
  ['nexium', 'Esomeprazole'], ['נקסיום', 'Esomeprazole'],
  ['zantac', 'Ranitidine'],
  // SSRIs / psych
  ['prozac', 'Fluoxetine'], ['פרוזק', 'Fluoxetine'],
  ['cipramil', 'Citalopram'], ['ציפרמיל', 'Citalopram'],
  ['cipralex', 'Escitalopram'],
  ['lustral', 'Sertraline'], ['לוסטרל', 'Sertraline'],
  ['seroxat', 'Paroxetine'],
  ['cymbalta', 'Duloxetine'],
  ['remeron', 'Mirtazapine'], ['מירון', 'Mirtazapine'],
  ['effexor', 'Venlafaxine'],
  // Benzos / sleep
  ['xanax', 'Alprazolam'], ['קסאנקס', 'Alprazolam'],
  ['valium', 'Diazepam'], ['אסיבאל', 'Diazepam'],
  ['rivotril', 'Clonazepam'], ['ריבוטריל', 'Clonazepam'],
  ['clonex', 'Clonazepam'],
  ['bonserin', 'Zopiclone'], ['imovane', 'Zopiclone'],
  ['stilnox', 'Zolpidem'],
  ['circadin', 'Melatonin'], ['צירקדין', 'Melatonin'],
  // Allergy
  ['claritine', 'Loratadine'], ['קלריטין', 'Loratadine'],
  ['allegra', 'Fexofenadine'], ['telfast', 'Fexofenadine'],
  ['zyrtec', 'Cetirizine'], ['histazine', 'Cetirizine'],
  ['aerius', 'Desloratadine'],
  // Resp / asthma
  ['ventolin', 'Salbutamol'], ['ונטולין', 'Salbutamol'],
  ['symbicort', 'Budesonide + Formoterol'], ['סימביקורט', 'Budesonide + Formoterol'],
  ['seretide', 'Fluticasone + Salmeterol'],
  ['pulmicort', 'Budesonide'],
  ['spiriva', 'Tiotropium'],
  ['singulair', 'Montelukast'], ['סינגולייר', 'Montelukast'],
  // Analgesics (opioid / other)
  ['tramadex', 'Tramadol'], ['tramadol', 'Tramadol'],
  ['targin', 'Oxycodone + Naloxone'],
  ['percocet', 'Oxycodone + Paracetamol'],
  // Migraine
  ['imitrex', 'Sumatriptan'], ['sumatriptan', 'Sumatriptan'],
  ['rizalt', 'Rizatriptan'], ['maxalt', 'Rizatriptan'],
  // Parkinson / neuro
  ['dopicar', 'Levodopa + Carbidopa'], ['sinemet', 'Levodopa + Carbidopa'],
  ['aricept', 'Donepezil'], ['אריספט', 'Donepezil'],
  ['exelon', 'Rivastigmine'],
  // Gout / other
  ['allopurinol', 'Allopurinol'], ['zyloric', 'Allopurinol'],
  ['colchicine', 'Colchicine'],
  // Osteoporosis
  ['fosalan', 'Alendronate'], ['fosamax', 'Alendronate'],
  ['bonefos', 'Clodronate'],
  ['prolia', 'Denosumab'],
  ['bondronat', 'Ibandronate'],
  ['aclasta', 'Zoledronic acid'],

  // Additional analgesics / NSAIDs
  ['arthrotec', 'Diclofenac + Misoprostol'],
  ['celebrex', 'Celecoxib'], ['סלברקס', 'Celecoxib'],
  ['mobic', 'Meloxicam'], ['movalis', 'Meloxicam'],
  ['brufen', 'Ibuprofen'],
  ['gofen', 'Ibuprofen'],
  ['procalmil', 'Diclofenac + Paracetamol'],
  ['rokacet', 'Paracetamol + Codeine'], ['רוקצט', 'Paracetamol + Codeine'],
  ['zomepirac', 'Zomepirac'],

  // Opioids / controlled pain
  ['oxycontin', 'Oxycodone'],
  ['targinact', 'Oxycodone + Naloxone'],
  ['percolone', 'Oxycodone'],
  ['morphine', 'Morphine'],
  ['mst', 'Morphine'],
  ['fentora', 'Fentanyl'],
  ['duragesic', 'Fentanyl'],
  ['durogesic', 'Fentanyl'],
  ['butrans', 'Buprenorphine'],

  // More antibiotics
  ['xifaxan', 'Rifaximin'],
  ['rulid', 'Roxithromycin'],
  ['klacid', 'Clarithromycin'], ['clarid', 'Clarithromycin'],
  ['tavanic', 'Levofloxacin'], ['levaquin', 'Levofloxacin'],
  ['avelox', 'Moxifloxacin'],
  ['vibramycin', 'Doxycycline'], ['doxylin', 'Doxycycline'],
  ['fucidin', 'Fusidic acid'],
  ['diflucan', 'Fluconazole'], ['דיפלוקן', 'Fluconazole'],
  ['sporanox', 'Itraconazole'],
  ['nizoral', 'Ketoconazole'],
  ['zovirax', 'Acyclovir'],
  ['valtrex', 'Valaciclovir'], ['ולטרקס', 'Valaciclovir'],
  ['septrin', 'Sulfamethoxazole + Trimethoprim'],
  ['resprim', 'Sulfamethoxazole + Trimethoprim'],

  // More cardiac / BP
  ['procoralan', 'Ivabradine'],
  ['entresto', 'Sacubitril + Valsartan'], ['אנטרסטו', 'Sacubitril + Valsartan'],
  ['atacand', 'Candesartan'],
  ['diovan', 'Valsartan'], ['דיובן', 'Valsartan'],
  ['olmetec', 'Olmesartan'], ['benicar', 'Olmesartan'],
  ['micardis', 'Telmisartan'],
  ['capoten', 'Captopril'],
  ['zestril', 'Lisinopril'], ['prinivil', 'Lisinopril'],
  ['coversyl', 'Perindopril'],
  ['accupril', 'Quinapril'],
  ['lopressor', 'Metoprolol'], ['betaloc', 'Metoprolol'],
  ['neobloc', 'Metoprolol'],
  ['dilatrend', 'Carvedilol'], ['קרוודילול', 'Carvedilol'],
  ['nebilet', 'Nebivolol'],
  ['isoptin', 'Verapamil'], ['קלן', 'Verapamil'],
  ['adalat', 'Nifedipine'],
  ['plendil', 'Felodipine'],
  ['lasix', 'Furosemide'],
  ['edecrin', 'Ethacrynic acid'],
  ['bumex', 'Bumetanide'],
  ['natrilix', 'Indapamide'], ['נטריליקס', 'Indapamide'],
  ['disalunil', 'Hydrochlorothiazide'],
  ['aldactone', 'Spironolactone'], ['אלדקטון', 'Spironolactone'],
  ['inspra', 'Eplerenone'],
  ['tambocor', 'Flecainide'],
  ['pacerone', 'Amiodarone'],

  // Statins (more)
  ['pravachol', 'Pravastatin'],
  ['lescol', 'Fluvastatin'],
  ['livalo', 'Pitavastatin'],
  // Fibrates / other lipid
  ['lopid', 'Gemfibrozil'],
  ['lipanthyl', 'Fenofibrate'], ['tricor', 'Fenofibrate'],
  ['ezetrol', 'Ezetimibe'], ['zetia', 'Ezetimibe'],
  ['repatha', 'Evolocumab'],

  // Diabetes (more)
  ['amaryl', 'Glimepiride'],
  ['glucotrol', 'Glipizide'],
  ['novonorm', 'Repaglinide'],
  ['actos', 'Pioglitazone'],
  ['avandia', 'Rosiglitazone'],
  ['victoza', 'Liraglutide'],
  ['saxenda', 'Liraglutide'],
  ['bydureon', 'Exenatide'],
  ['lyxumia', 'Lixisenatide'],
  ['xigduo', 'Dapagliflozin + Metformin'],
  ['invokana', 'Canagliflozin'],
  ['tresiba', 'Insulin degludec'],
  ['toujeo', 'Insulin glargine'],
  ['ryzodeg', 'Insulin degludec + Aspart'],

  // Psych — SSRIs / SNRIs / others
  ['celexa', 'Citalopram'],
  ['lexapro', 'Escitalopram'], ['ציפרלקס', 'Escitalopram'],
  ['paxil', 'Paroxetine'],
  ['pristiq', 'Desvenlafaxine'],
  ['effexor', 'Venlafaxine'], ['אפקסור', 'Venlafaxine'],
  ['viibryd', 'Vilazodone'],
  ['trintellix', 'Vortioxetine'], ['brintellix', 'Vortioxetine'],
  ['wellbutrin', 'Bupropion'], ['zyban', 'Bupropion'],
  ['strattera', 'Atomoxetine'],
  ['concerta', 'Methylphenidate'],
  ['ritalin', 'Methylphenidate'], ['ריטלין', 'Methylphenidate'],
  ['vyvanse', 'Lisdexamfetamine'],
  ['desyrel', 'Trazodone'],
  ['elavil', 'Amitriptyline'],
  ['anafranil', 'Clomipramine'],
  ['tryptizol', 'Amitriptyline'],
  ['sinequan', 'Doxepin'],
  ['pamelor', 'Nortriptyline'],

  // Antipsychotics
  ['risperdal', 'Risperidone'], ['ריספרדל', 'Risperidone'],
  ['zyprexa', 'Olanzapine'], ['זיפרקסה', 'Olanzapine'],
  ['seroquel', 'Quetiapine'], ['סרוקוול', 'Quetiapine'],
  ['abilify', 'Aripiprazole'], ['אביליפי', 'Aripiprazole'],
  ['rexulti', 'Brexpiprazole'],
  ['latuda', 'Lurasidone'],
  ['invega', 'Paliperidone'],
  ['geodon', 'Ziprasidone'],
  ['haldol', 'Haloperidol'], ['הלדול', 'Haloperidol'],
  ['clopixol', 'Zuclopenthixol'],
  ['leponex', 'Clozapine'],

  // Anticonvulsants
  ['lamictal', 'Lamotrigine'], ['למיקטל', 'Lamotrigine'],
  ['depakine', 'Valproate'], ['depakote', 'Valproate'],
  ['valporal', 'Valproate'],
  ['dilantin', 'Phenytoin'], ['epanutin', 'Phenytoin'],
  ['tegretol', 'Carbamazepine'], ['טגרטול', 'Carbamazepine'],
  ['trileptal', 'Oxcarbazepine'],
  ['topamax', 'Topiramate'], ['טופמקס', 'Topiramate'],
  ['keppra', 'Levetiracetam'], ['קפרה', 'Levetiracetam'],
  ['neurontin', 'Gabapentin'], ['נוירונטין', 'Gabapentin'],
  ['lyrica', 'Pregabalin'], ['ליריקה', 'Pregabalin'],
  ['vimpat', 'Lacosamide'],
  ['zonegran', 'Zonisamide'],
  ['briviact', 'Brivaracetam'],

  // Mood stabilizers
  ['lithobid', 'Lithium'], ['eskalith', 'Lithium'],
  ['lithium carbonate', 'Lithium'],

  // Sleep (more)
  ['ambien', 'Zolpidem'],
  ['lunesta', 'Eszopiclone'],
  ['rozerem', 'Ramelteon'],
  ['dalmane', 'Flurazepam'],
  ['restoril', 'Temazepam'],
  ['halcion', 'Triazolam'],
  ['ativan', 'Lorazepam'], ['אטיבן', 'Lorazepam'],
  ['klonopin', 'Clonazepam'],
  ['vesparax', 'Bromazepam'],
  ['lexotan', 'Bromazepam'],

  // GI (more)
  ['gaviscon', 'Sodium alginate'],
  ['maalox', 'Aluminium hydroxide + Magnesium hydroxide'],
  ['zantac', 'Ranitidine'],
  ['famonite', 'Famotidine'], ['pepcid', 'Famotidine'], ['פפציד', 'Famotidine'],
  ['zofran', 'Ondansetron'], ['זופרן', 'Ondansetron'],
  ['pramin', 'Metoclopramide'], ['primperan', 'Metoclopramide'],
  ['motilium', 'Domperidone'],
  ['laxadine', 'Bisacodyl'],
  ['dulcolax', 'Bisacodyl'],
  ['senokot', 'Senna'],
  ['normacol', 'Sterculia'],
  ['imodium', 'Loperamide'], ['loperamide', 'Loperamide'],
  ['buscopan', 'Hyoscine butylbromide'], ['בוסקופאן', 'Hyoscine butylbromide'],

  // Respiratory (more)
  ['alvesco', 'Ciclesonide'],
  ['flixotide', 'Fluticasone'],
  ['flovent', 'Fluticasone'],
  ['atrovent', 'Ipratropium'],
  ['serevent', 'Salmeterol'],
  ['foradil', 'Formoterol'],
  ['tiotropium', 'Tiotropium'],
  ['anoro', 'Umeclidinium + Vilanterol'],
  ['trelegy', 'Fluticasone + Umeclidinium + Vilanterol'],
  ['breo', 'Fluticasone + Vilanterol'],

  // Immunosuppressants / DMARDs
  ['methotrexate', 'Methotrexate'], ['rheumatrex', 'Methotrexate'],
  ['plaquenil', 'Hydroxychloroquine'],
  ['imuran', 'Azathioprine'], ['imuran', 'Azathioprine'],
  ['cellcept', 'Mycophenolate'],
  ['sandimmune', 'Cyclosporine'], ['neoral', 'Cyclosporine'],
  ['prograf', 'Tacrolimus'],
  ['rapamune', 'Sirolimus'],
  ['humira', 'Adalimumab'],
  ['enbrel', 'Etanercept'],
  ['remicade', 'Infliximab'],
  ['simponi', 'Golimumab'],
  ['orencia', 'Abatacept'],
  ['rituxan', 'Rituximab'], ['mabthera', 'Rituximab'],
  ['xeljanz', 'Tofacitinib'],
  ['olumiant', 'Baricitinib'],

  // Urology
  ['flomax', 'Tamsulosin'], ['flomaxtra', 'Tamsulosin'],
  ['cardura', 'Doxazosin'],
  ['minipress', 'Prazosin'],
  ['hytrin', 'Terazosin'],
  ['proscar', 'Finasteride'], ['propecia', 'Finasteride'],
  ['avodart', 'Dutasteride'],
  ['detrol', 'Tolterodine'],
  ['vesicare', 'Solifenacin'],
  ['mirabegron', 'Mirabegron'], ['betmiga', 'Mirabegron'],
  ['viagra', 'Sildenafil'], ['ויאגרה', 'Sildenafil'],
  ['cialis', 'Tadalafil'], ['סיאליס', 'Tadalafil'],
  ['levitra', 'Vardenafil'],

  // Ophthalmic (glaucoma)
  ['xalatan', 'Latanoprost'],
  ['lumigan', 'Bimatoprost'],
  ['travatan', 'Travoprost'],
  ['timoptic', 'Timolol'],
  ['trusopt', 'Dorzolamide'],
  ['alphagan', 'Brimonidine'],
  ['cosopt', 'Dorzolamide + Timolol'],

  // Glucocorticoids / endocrine
  ['dexacort', 'Dexamethasone'], ['decadron', 'Dexamethasone'],
  ['prednisone', 'Prednisone'], ['deltasone', 'Prednisone'],
  ['prednisolone', 'Prednisolone'],
  ['medrol', 'Methylprednisolone'],
  ['solumedrol', 'Methylprednisolone'],
  ['rayos', 'Prednisone'],
  ['florinef', 'Fludrocortisone'],

  // Anti-gout / rheum
  ['colchicine', 'Colchicine'], ['קולכיצין', 'Colchicine'],
  ['colchis', 'Colchicine'],
  ['zyloric', 'Allopurinol'], ['allupurinol', 'Allopurinol'],
  ['uloric', 'Febuxostat'], ['adenuric', 'Febuxostat'],
  ['probalan', 'Probenecid'],

  // Anti-migraine (more)
  ['zomig', 'Zolmitriptan'],
  ['relpax', 'Eletriptan'],
  ['frova', 'Frovatriptan'],
  ['axert', 'Almotriptan'],
  ['topamax', 'Topiramate'],
  ['emgality', 'Galcanezumab'],
  ['aimovig', 'Erenumab'],
  ['ajovy', 'Fremanezumab'],

  // Anti-nausea / vertigo
  ['betaserc', 'Betahistine'], ['בטהיסטין', 'Betahistine'],
  ['travacalm', 'Dimenhydrinate'],
  ['bonaminu', 'Meclizine'],

  // Vitamins / supplements
  ['ferrosanol', 'Iron'], ['ferritab', 'Iron'],
  ['iron', 'Iron'], ['ברזל', 'Iron'],
  ['calcium', 'Calcium'], ['סידן', 'Calcium'],
  ['calcichew', 'Calcium + Vitamin D'],
  ['vitamin d', 'Cholecalciferol'], ['ויטמין די', 'Cholecalciferol'],
  ['d-pearls', 'Cholecalciferol'],
  ['b12', 'Cyanocobalamin'],
  ['folic acid', 'Folic acid'], ['חומצה פולית', 'Folic acid'],
  ['magnesium', 'Magnesium'], ['מגנזיום', 'Magnesium'],
  ['potassium', 'Potassium'],
  ['slow-k', 'Potassium'],
  ['k-dur', 'Potassium'],

  // Miscellaneous common Israeli brands
  ['tramal', 'Tramadol'],
  ['zaldiar', 'Tramadol + Paracetamol'],
  ['exforge', 'Amlodipine + Valsartan'],
  ['co-diovan', 'Hydrochlorothiazide + Valsartan'],
  ['co-renitec', 'Enalapril + Hydrochlorothiazide'],
  ['disothiazide', 'Hydrochlorothiazide'],
  ['cortef', 'Hydrocortisone'],
  ['solu-cortef', 'Hydrocortisone'],
  ['prolia', 'Denosumab'],
  ['xgeva', 'Denosumab'],
];
export const IL_BRAND_MAP = (() => {
  const m = Object.create(null);
  IL_BRAND_SEED.forEach(([k, v]) => { m[k.toLowerCase().trim()] = v; });
  return m;
})();

// Lazy-load an optional extended brand map (e.g. an Israeli MoH
// import) from a co-hosted JSON file. Fires on first editor open,
// runs once per session, survives network failure silently. Swap
// the file contents to grow coverage without a code change.
export let _brandMapExtLoaded = false;
export let _brandMapExtPromise = null;

export function _loadExtendedBrandMap() {
  if (_brandMapExtLoaded) return Promise.resolve();
  if (_brandMapExtPromise) return _brandMapExtPromise;
  _brandMapExtPromise = (async () => {
    try {
      const resp = await fetch('brands-il.json', { cache: 'default' });
      if (!resp.ok) return;
      const json = await resp.json();
      const brands = json && json.brands;
      if (!brands || typeof brands !== 'object') return;
      let added = 0;
      Object.entries(brands).forEach(([k, v]) => {
        const key = String(k || '').toLowerCase().trim();
        if (!key || !v) return;
        if (!IL_BRAND_MAP[key]) added++;
        IL_BRAND_MAP[key] = v;
      });
      _brandMapExtLoaded = true;
      console.log('[brand map] extended with ' + added + ' new brands (' + Object.keys(brands).length + ' total entries)');
    } catch(e) {
      console.warn('[brand map] ext load failed', e && e.message);
    }
  })();
  return _brandMapExtPromise;
}

export function _findBrandInMap(query) {
  if (!query) return null;
  const q = query.trim().toLowerCase();
  if (!q) return null;
  if (IL_BRAND_MAP[q]) return IL_BRAND_MAP[q];
  // Try the first word only (handles "Acamol 500", "Augmentin ES")
  const firstWord = q.split(/[\s\-,]+/)[0];
  if (firstWord && firstWord !== q && IL_BRAND_MAP[firstWord]) return IL_BRAND_MAP[firstWord];
  // Short-prefix-of-a-key match — only when user has typed ≥4 chars so
  // "Ace" doesn't falsely suggest "Acamol" before it's clear what they mean.
  if (q.length >= 4) {
    for (const key of Object.keys(IL_BRAND_MAP)) {
      if (key.startsWith(q) || q.startsWith(key)) return IL_BRAND_MAP[key];
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────
//  MEDICATION EDITOR MODAL
// ──────────────────────────────────────────────────────────
// _meState = { medId, isNew, draft, proxy? }
// proxy = { patientUid, patientName, meds, onSaved } — when a carer
// is editing on behalf of a connected patient. `meds` is the
// current working list that gets mutated in place; `onSaved` is a
// callback to refresh the enclosing patient-meds-list modal.
export let _meState = null;

export function openMedEditor(medId, proxy) {
  document.querySelector('.med-editor-modal')?.remove();
  const srcList = proxy ? (proxy.meds || []) : _medications;
  const existing = medId ? srcList.find(m => m.id === medId) : null;
  const isNew = !existing;
  // Deep-clone the draft so cancelling leaves the original untouched
  const draft = existing ? JSON.parse(JSON.stringify(existing)) : {
    name: '', activeIngredient: null, dose: null, unit: null, instructions: '', photos: [],
    schedule: { kind: 'fixed_times', times: ['08:00'], window_minutes: 60, days: [], interval_hours: 6, anchor: '08:00' },
    stock: null, refillThreshold: null,
    prn: false, enabled: true,
  };
  if (!Array.isArray(draft.photos)) draft.photos = [];
  if (!draft.schedule) draft.schedule = { kind: 'fixed_times', times: [], window_minutes: 60 };
  if (!Array.isArray(draft.schedule.times)) draft.schedule.times = [];
  if (!Array.isArray(draft.schedule.days)) draft.schedule.days = [];
  if (!draft.schedule.kind) draft.schedule.kind = 'fixed_times';

  _meState = { medId: medId || null, isNew, draft, proxy: proxy || null };
  // Fire-and-forget: pull the extended brand map. When it lands, a
  // later input event will pick up the newly-loaded entries. First
  // render uses the seed only (already synchronous).
  _loadExtendedBrandMap().then(() => {
    if (document.querySelector('.med-editor-modal')) _medEditorUpdateBrandSuggestion();
  });
  _renderMedEditor();
}

export function _renderMedEditor() {
  const s = _meState; if (!s) return;
  const d = s.draft;
  const effectiveKind = d.prn ? 'prn' : (d.schedule.kind || 'fixed_times');
  const doseStr = (d.dose !== null && d.dose !== undefined) ? String(d.dose) : '';
  const unitStr = d.unit || '';
  document.querySelector('.med-editor-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'med-editor-modal';
  const daysOfWeek = [['Sun',0],['Mon',1],['Tue',2],['Wed',3],['Thu',4],['Fri',5],['Sat',6]];
  const proxyBanner = s.proxy ? `<div class="me-hint" style="margin-bottom:10px">${t('Managing for')} <strong style="color:#F1F5F9">${escHtml(s.proxy.patientName || '')}</strong></div>` : '';
  modal.innerHTML = `
    <div class="med-editor-card">
      <div class="me-title">${s.isNew ? t('New medication') : t('Edit medication')}</div>
      ${proxyBanner}

      <details open class="me-details">
        <summary class="me-details-summary">${t('Basic')}</summary>
        <div class="me-section">
          <label class="me-label">${t('Name')}</label>
          <div style="position:relative">
            <input class="me-input" id="me-name" value="${escHtml(d.name)}" placeholder="${t('e.g. Metformin')}" maxlength="60" autocomplete="off">
            <div id="me-rx-autocomplete" class="rx-autocomplete-dropdown" style="display:none"></div>
          </div>
          <div id="me-brand-suggestion" class="me-brand-suggest" style="display:none"></div>
          ${d.rxcui ? `<div class="me-rxcui-badge" id="me-rxcui-badge">RxCUI: ${escHtml(d.rxcui)}</div>` : '<div class="me-rxcui-badge" id="me-rxcui-badge" style="display:none"></div>'}
        </div>

        <div class="me-row me-section">
          <div style="flex:1.3">
            <label class="me-label">${t('Dose')}</label>
            <input class="me-input" id="me-dose" value="${escHtml(doseStr)}" placeholder="500" maxlength="10" autocomplete="off">
          </div>
          <div style="flex:1">
            <label class="me-label">${t('Unit')}</label>
            <input class="me-input" id="me-unit" value="${escHtml(unitStr)}" placeholder="mg" maxlength="10" autocomplete="off">
          </div>
        </div>

        <div class="me-section">
          <label class="me-label">${t('Instructions')} <span style="opacity:0.6;font-weight:400;text-transform:none;letter-spacing:0">(${t('optional')})</span></label>
          <textarea class="me-textarea" id="me-instructions" placeholder="${t('e.g. with food')}" maxlength="140">${escHtml(d.instructions || '')}</textarea>
        </div>
      </details>

      <details class="me-details">
        <summary class="me-details-summary">${t('Schedule')}</summary>
        <div class="me-section">
          <label class="me-label">${t('Schedule')}</label>
          <select class="me-select" id="me-kind">
            <option value="fixed_times" ${effectiveKind==='fixed_times'?'selected':''}>${t('At specific times')}</option>
            <option value="days_of_week" ${effectiveKind==='days_of_week'?'selected':''}>${t('Certain days only')}</option>
            <option value="interval" ${effectiveKind==='interval'?'selected':''}>${t('Every N hours')}</option>
            <option value="prn" ${effectiveKind==='prn'?'selected':''}>${t('As needed (no reminder)')}</option>
          </select>
        </div>

        <div class="me-section" id="me-sched-fixed_times" style="${effectiveKind==='fixed_times'?'':'display:none'}">
          <label class="me-label">${t('Reminder times')}</label>
          <div id="me-times-list"></div>
          <button class="me-add-time-btn" type="button" onclick="_medEditorAddTime()">+ ${t('Add time')}</button>
        </div>

        <div class="me-section" id="me-sched-days_of_week" style="${effectiveKind==='days_of_week'?'':'display:none'}">
          <label class="me-label">${t('Days of week')}</label>
          <div class="me-days" id="me-days">
            ${daysOfWeek.map(([lbl,i]) => `<button type="button" class="me-day-btn${(d.schedule.days||[]).includes(i)?' selected':''}" data-day="${i}" onclick="_medEditorToggleDay(${i})">${t(lbl)}</button>`).join('')}
          </div>
          <label class="me-label" style="margin-top:12px">${t('Reminder times')}</label>
          <div id="me-times-list-2"></div>
          <button class="me-add-time-btn" type="button" onclick="_medEditorAddTime()">+ ${t('Add time')}</button>
        </div>

        <div class="me-section" id="me-sched-interval" style="${effectiveKind==='interval'?'':'display:none'}">
          <div class="me-row">
            <div style="flex:1">
              <label class="me-label">${t('Every (hours)')}</label>
              <input class="me-input" id="me-interval-hours" type="number" min="1" max="24" value="${d.schedule.interval_hours || 6}">
            </div>
            <div style="flex:1">
              <label class="me-label">${t('First dose')}</label>
              <input class="me-time-input" id="me-anchor" type="time" value="${d.schedule.anchor || '08:00'}">
            </div>
          </div>
        </div>

        <div class="me-section" id="me-sched-prn" style="${effectiveKind==='prn'?'':'display:none'}">
          <div class="me-hint">${t('No automatic reminder. Log a dose manually when you take it.')}</div>
        </div>

        <div class="me-section" id="me-window-section" style="${effectiveKind==='prn'?'display:none':''}">
          <label class="me-label">${t('Response window')}</label>
          <select class="me-select" id="me-window">
            ${[5,15,30,60,120,240].map(w => `<option value="${w}" ${(d.schedule.window_minutes||60)===w?'selected':''}>${w===5?t('5 min (strict)'):w<60?w+' '+t('min'):(w===60?'1 '+t('hour'):(w/60)+' '+t('hours'))}</option>`).join('')}
          </select>
          <div class="me-hint" style="margin-top:6px">${t('How long the reminder stays responsive. Carer is alerted only after this window closes.')}</div>
        </div>
      </details>

      <details class="me-details">
        <summary class="me-details-summary">${t('Advanced')}</summary>
        <div class="me-section">
          <label class="me-label">${t('Active ingredient')} <span style="opacity:0.6;font-weight:400;text-transform:none;letter-spacing:0">(${t('for interaction checks')})</span></label>
          <input class="me-input" id="me-active" value="${escHtml(d.activeIngredient || '')}" placeholder="${t('e.g. Paracetamol (for Acamol)')}" maxlength="60" autocomplete="off">
        </div>

        <div class="me-row me-section">
          <div style="flex:1">
            <label class="me-label">${t('Pills in stock')} <span style="opacity:0.6;font-weight:400;text-transform:none;letter-spacing:0">(${t('optional')})</span></label>
            <input class="me-input" id="me-stock" type="number" min="0" step="1" value="${(d.stock !== null && d.stock !== undefined) ? d.stock : ''}" placeholder="—">
          </div>
          <div style="flex:1">
            <label class="me-label">${t('Alert when below')}</label>
            <input class="me-input" id="me-refill" type="number" min="0" step="1" value="${(d.refillThreshold !== null && d.refillThreshold !== undefined) ? d.refillThreshold : ''}" placeholder="—">
          </div>
        </div>

        <div class="me-section">
          <label class="me-label">${t('Photos')} <span style="opacity:0.6;font-weight:400;text-transform:none;letter-spacing:0">(${t('optional')}, ${t('e.g. pill, box, insert')})</span></label>
          <div class="me-photos-strip" id="me-photos-strip">
            ${(d.photos || []).map((url, idx) => `
              <div class="me-photo-thumb" data-idx="${idx}" style="background-image:url('${url.replace(/'/g, "\\'")}')" onclick="_medEditorOpenPhotoFromEditor(${idx})">
                <button type="button" class="me-photo-thumb-x" onclick="event.stopPropagation();_medEditorRemovePhotoAt(${idx})" aria-label="${t('Remove photo')}">×</button>
              </div>
            `).join('')}
            ${(d.photos || []).length < 3 ? `
              <button type="button" class="me-photo-add-tile" onclick="_medEditorOpenPhotoChooser()" aria-label="${t('Add photo')}">
                <div style="text-align:center">+<small>${t('Add photo')}</small></div>
              </button>` : ''}
          </div>
          <input type="file" accept="image/*" capture="environment" id="me-photo-input-camera" style="display:none" onchange="_medEditorOnPhotoSelect(event)">
          <input type="file" accept="image/*" id="me-photo-input-gallery" style="display:none" onchange="_medEditorOnPhotoSelect(event)">
        </div>
      </details>

      <div class="me-buttons">
        <button class="me-btn-primary" onclick="saveMedFromEditor()">${t('Save')}</button>
        <button class="me-btn-secondary" onclick="_closeMedEditor()">${t('Cancel')}</button>
      </div>
      ${s.isNew ? '' : `<button class="me-btn-danger" onclick="_deleteMedFromEditor()">${t('Remove medication')}</button>`}
    </div>
  `;
  modal.onclick = (e) => { if (e.target === modal) _closeMedEditor(); };
  document.body.appendChild(modal);

  // Wire brand-name auto-suggestion for Active ingredient.
  const nameInput = document.getElementById('me-name');
  if (nameInput) {
    nameInput.addEventListener('input', _medEditorUpdateBrandSuggestion);
    // Run once on open so pre-populated names still trigger a suggestion.
    _medEditorUpdateBrandSuggestion();
  }

  document.getElementById('me-kind').addEventListener('change', (e) => {
    const newKind = e.target.value;
    ['fixed_times', 'days_of_week', 'interval', 'prn'].forEach(k => {
      const el = document.getElementById('me-sched-' + k);
      if (el) el.style.display = (k === newKind) ? '' : 'none';
    });
    // Response-window section is only meaningful for scheduled meds
    const wSection = document.getElementById('me-window-section');
    if (wSection) wSection.style.display = (newKind === 'prn') ? 'none' : '';
    // Also keep _meState.draft schedule.kind in sync (not prn; prn is separate)
    if (newKind === 'prn') {
      _meState.draft.prn = true;
    } else {
      _meState.draft.prn = false;
      _meState.draft.schedule.kind = newKind;
    }
    _rebuildMedEditorTimes();
  });

  _rebuildMedEditorTimes();
}

export function _rebuildMedEditorTimes() {
  const s = _meState; if (!s) return;
  const times = s.draft.schedule.times || [];
  ['me-times-list', 'me-times-list-2'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (times.length === 0) {
      el.innerHTML = `<div class="me-hint" style="margin-top:0">${t('Tap + to add a time.')}</div>`;
      return;
    }
    el.innerHTML = '';
    times.forEach((time, idx) => {
      const row = document.createElement('div');
      row.className = 'me-time-row';
      const canRemove = times.length > 1;
      row.innerHTML = `
        <input class="me-time-input" type="time" value="${escHtml(time)}" data-idx="${idx}" onchange="_medEditorSetTime(${idx}, this.value)">
        ${canRemove ? `<button class="me-time-remove" type="button" onclick="_medEditorRemoveTime(${idx})" aria-label="${t('Remove time')}">×</button>` : ''}
      `;
      el.appendChild(row);
    });
  });
}

export function _medEditorAddTime() {
  const sch = _meState.draft.schedule;
  if (!Array.isArray(sch.times)) sch.times = [];
  // Default new time: bump one hour past the last one, else 08:00
  let defaultTime = '08:00';
  if (sch.times.length) {
    const [h, m] = String(sch.times[sch.times.length - 1]).split(':').map(Number);
    if (!isNaN(h) && !isNaN(m)) {
      const nh = (h + 1) % 24;
      defaultTime = String(nh).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }
  }
  sch.times.push(defaultTime);
  _rebuildMedEditorTimes();
}

export function _medEditorRemoveTime(idx) {
  const sch = _meState.draft.schedule;
  if (!Array.isArray(sch.times)) return;
  sch.times.splice(idx, 1);
  _rebuildMedEditorTimes();
}

export function _medEditorSetTime(idx, value) {
  if (_meState && _meState.draft.schedule.times) {
    _meState.draft.schedule.times[idx] = value;
  }
}

export function _medEditorToggleDay(dayIdx) {
  if (!_meState) return;
  const days = _meState.draft.schedule.days || [];
  const pos = days.indexOf(dayIdx);
  if (pos < 0) days.push(dayIdx); else days.splice(pos, 1);
  _meState.draft.schedule.days = days;
  document.querySelectorAll('#me-days .me-day-btn').forEach(btn => {
    const i = parseInt(btn.dataset.day, 10);
    btn.classList.toggle('selected', days.includes(i));
  });
}

// Brand-name → active-ingredient suggestion.
// Shown below the Name input when the typed brand matches our seed
// map AND the Active ingredient field is still empty. One tap to
// accept — fills the Active ingredient field and hides the chip.
export function _medEditorUpdateBrandSuggestion() {
  const nameEl = document.getElementById('me-name');
  const activeEl = document.getElementById('me-active');
  const box = document.getElementById('me-brand-suggestion');
  if (!nameEl || !activeEl || !box) return;
  const currentActive = (activeEl.value || '').trim();
  if (currentActive) { box.style.display = 'none'; return; }
  const suggestion = _findBrandInMap(nameEl.value);
  if (!suggestion) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  box.innerHTML = `💡 ${t('Looks like')}: <strong>${escHtml(suggestion)}</strong> — <a href="#" onclick="event.preventDefault();_medEditorAcceptBrandSuggestion()" style="color:var(--carer-primary);text-decoration:underline">${t('use as active ingredient')}</a>`;
  box.dataset.val = suggestion;
}

export function _medEditorAcceptBrandSuggestion() {
  const box = document.getElementById('me-brand-suggestion');
  const activeEl = document.getElementById('me-active');
  if (!box || !activeEl) return;
  const val = box.dataset.val || '';
  if (!val) return;
  activeEl.value = val;
  if (_meState) _meState.draft.activeIngredient = val;
  box.style.display = 'none';
  box.innerHTML = '';
}

// Capture current form values into the draft so a re-render
// (e.g. after picking a photo) doesn't wipe in-progress typing.
export function _snapshotMedEditorForm() {
  if (!_meState) return;
  const d = _meState.draft;
  const get = id => document.getElementById(id);
  if (get('me-name')) d.name = (get('me-name').value || '').trim();
  if (get('me-active')) d.activeIngredient = (get('me-active').value || '').trim() || null;
  if (get('me-dose')) {
    const r = (get('me-dose').value || '').trim();
    if (!r) { d.dose = null; }
    else { const n = parseFloat(r); d.dose = isNaN(n) ? r : n; }
  }
  if (get('me-unit')) d.unit = (get('me-unit').value || '').trim() || null;
  if (get('me-instructions')) d.instructions = (get('me-instructions').value || '').trim() || null;
  if (get('me-stock')) d.stock = _parseIntOrNull(get('me-stock').value);
  if (get('me-refill')) d.refillThreshold = _parseIntOrNull(get('me-refill').value);
  if (get('me-window')) d.schedule.window_minutes = parseInt(get('me-window').value, 10) || 60;
  if (get('me-interval-hours')) d.schedule.interval_hours = parseInt(get('me-interval-hours').value, 10) || 6;
  if (get('me-anchor')) d.schedule.anchor = get('me-anchor').value || '08:00';
}

// Photo picker: file from camera or gallery -> resized JPEG dataURL,
// appended to _meState.draft.photos (max 3). Resizing keeps storage
// tiny (~5-15 KB each) so even 3 photos per med stay well under RTDB
// limits.
export const MED_MAX_PHOTOS = 3;

export function _medEditorOnPhotoSelect(evt) {
  const file = evt.target.files && evt.target.files[0];
  evt.target.value = ''; // allow re-picking same file later
  if (!file || !_meState) return;
  if (file.size > 8 * 1024 * 1024) { toast(t('Image is too large')); return; }
  if (!Array.isArray(_meState.draft.photos)) _meState.draft.photos = [];
  if (_meState.draft.photos.length >= MED_MAX_PHOTOS) {
    toast(t('Maximum of {n} photos').replace('{n}', String(MED_MAX_PHOTOS)));
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 240;
      const ratio = Math.min(maxDim / img.width, maxDim / img.height, 1);
      const w = Math.max(1, Math.round(img.width * ratio));
      const h = Math.max(1, Math.round(img.height * ratio));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      _snapshotMedEditorForm();
      _meState.draft.photos.push(canvas.toDataURL('image/jpeg', 0.75));
      _renderMedEditor();
    };
    img.onerror = () => toast(t('Could not read image'));
    img.src = e.target.result;
  };
  reader.onerror = () => toast(t('Could not read image'));
  reader.readAsDataURL(file);
}

export function _medEditorRemovePhotoAt(idx) {
  if (!_meState) return;
  if (!Array.isArray(_meState.draft.photos)) return;
  _snapshotMedEditorForm();
  _meState.draft.photos.splice(idx, 1);
  _renderMedEditor();
}

export function _medEditorOpenPhotoFromEditor(idx) {
  if (!_meState || !Array.isArray(_meState.draft.photos)) return;
  openPhotoViewer(_meState.draft.photos, idx);
}

// Bottom-sheet chooser offering camera OR gallery, because mobile
// browsers behave differently with the bare capture attribute and we
// want both options explicit.
export function _medEditorOpenPhotoChooser() {
  if (!_meState) return;
  if (Array.isArray(_meState.draft.photos) && _meState.draft.photos.length >= MED_MAX_PHOTOS) {
    toast(t('Maximum of {n} photos').replace('{n}', String(MED_MAX_PHOTOS)));
    return;
  }
  document.querySelector('.photo-chooser-sheet')?.remove();
  const sheet = document.createElement('div');
  sheet.className = 'photo-chooser-sheet';
  sheet.innerHTML = `
    <div class="pcs-backdrop"></div>
    <div class="pcs-card">
      <div class="pcs-title">${t('Add photo')}</div>
      <button type="button" class="pcs-btn" onclick="_medEditorClosePhotoChooser();document.getElementById('me-photo-input-camera').click()">📷 ${t('Take photo')}</button>
      <button type="button" class="pcs-btn" onclick="_medEditorClosePhotoChooser();document.getElementById('me-photo-input-gallery').click()">🖼️ ${t('Choose from gallery')}</button>
      <button type="button" class="pcs-btn pcs-cancel" onclick="_medEditorClosePhotoChooser()">${t('Cancel')}</button>
    </div>
  `;
  sheet.querySelector('.pcs-backdrop').addEventListener('click', _medEditorClosePhotoChooser);
  document.body.appendChild(sheet);
}

export function _medEditorClosePhotoChooser() {
  document.querySelector('.photo-chooser-sheet')?.remove();
}

// ──────────────────────────────────────────────────────────
//  FULLSCREEN PHOTO VIEWER
// ──────────────────────────────────────────────────────────
export let _pvState = null; // { photos, index, touchStartX }

export function openPhotoViewer(photos, startIndex) {
  if (!Array.isArray(photos) || photos.length === 0) return;
  document.querySelector('.photo-viewer')?.remove();
  _pvState = { photos: photos.slice(), index: Math.max(0, Math.min(startIndex || 0, photos.length - 1)), touchStartX: 0 };
  const v = document.createElement('div');
  v.className = 'photo-viewer';
  v.innerHTML = `
    <button class="pv-close" onclick="closePhotoViewer()" aria-label="${t('Close')}">✕</button>
    <button class="pv-arrow prev" onclick="_pvPrev()" aria-label="${t('Previous')}" style="${photos.length>1?'':'display:none'}">‹</button>
    <img class="pv-img" id="pv-img" alt="">
    <button class="pv-arrow next" onclick="_pvNext()" aria-label="${t('Next')}" style="${photos.length>1?'':'display:none'}">›</button>
    <div class="pv-dots" id="pv-dots" style="${photos.length>1?'':'display:none'}"></div>
  `;
  // Tap backdrop (outside the image and controls) closes the viewer.
  v.addEventListener('click', (e) => {
    if (e.target === v) closePhotoViewer();
  });
  const img = v.querySelector('#pv-img');
  img.addEventListener('touchstart', (e) => { _pvState && (_pvState.touchStartX = e.touches[0].clientX); }, { passive: true });
  img.addEventListener('touchend', (e) => {
    if (!_pvState) return;
    const dx = e.changedTouches[0].clientX - _pvState.touchStartX;
    if (Math.abs(dx) > 50) { dx > 0 ? _pvPrev() : _pvNext(); }
  }, { passive: true });
  // Escape / arrow keys for desktop / PWA
  v._keyHandler = (e) => {
    if (e.key === 'Escape') closePhotoViewer();
    else if (e.key === 'ArrowLeft') _pvPrev();
    else if (e.key === 'ArrowRight') _pvNext();
  };
  document.addEventListener('keydown', v._keyHandler);
  document.body.appendChild(v);
  _pvRender();
}

export function _pvRender() {
  if (!_pvState) return;
  const img = document.getElementById('pv-img');
  const dots = document.getElementById('pv-dots');
  if (!img) return;
  img.src = _pvState.photos[_pvState.index];
  if (dots) {
    dots.innerHTML = _pvState.photos.map((_, i) => `<span class="${i === _pvState.index ? 'active' : ''}"></span>`).join('');
  }
}

export function _pvPrev() {
  if (!_pvState) return;
  _pvState.index = (_pvState.index - 1 + _pvState.photos.length) % _pvState.photos.length;
  _pvRender();
}
export function _pvNext() {
  if (!_pvState) return;
  _pvState.index = (_pvState.index + 1) % _pvState.photos.length;
  _pvRender();
}
export function closePhotoViewer() {
  const v = document.querySelector('.photo-viewer');
  if (v && v._keyHandler) document.removeEventListener('keydown', v._keyHandler);
  v?.remove();
  _pvState = null;
}

export function _closeMedEditor() {
  document.querySelector('.med-editor-modal')?.remove();
  _meState = null;
}

export function _deleteMedFromEditor() {
  const s = _meState;
  if (!s || !s.medId) return;
  if (!confirm(t('Remove this medication?'))) return;
  if (s.proxy) {
    s.proxy.meds = s.proxy.meds.filter(m => m.id !== s.medId);
    const proxyRoom = s.proxy.roomId;
    if (proxyRoom) {
      db.ref(`carecall/rooms/${proxyRoom}/medConfig`).set(s.proxy.meds)
        .catch(e => { console.warn('[carer-proxy delete]', e); toast(t('Save failed')); });
    }
    if (typeof s.proxy.onSaved === 'function') s.proxy.onSaved();
    _closeMedEditor();
    toast(t('Medication removed'));
    return;
  }
  removeMedication(s.medId);
  _closeMedEditor();
}

// ──────────────────────────────────────────────────────────
//  CARER: PROXY MEDICATION MANAGEMENT
//  Carer manages a connected patient's medications remotely.
//  Writes go to carecall/rooms/{roomId}/medConfig so that all
//  room members can read/write. The patient's device listener
//  auto-updates and reschedules.
// ──────────────────────────────────────────────────────────
export let _carerPatientCache = []; // [{uid, name, avatar, room}] snapshot from most recent picker

export async function openCarerMedsManager() {
  if (S.role !== 'carer') return;
  if (!S.rooms || !S.rooms.length) { toast(t('No connected patients')); return; }
  // Aggregate patient members across all rooms, keeping the room mapping
  const patientMap = {};
  await Promise.all(S.rooms.map(async room => {
    try {
      const snap = await db.ref(`carecall/rooms/${room}/members`).once('value');
      const members = snap.val() || {};
      Object.entries(members).forEach(([uid, m]) => {
        if (uid !== S.uid && m && m.role === 'patient') {
          patientMap[uid] = { uid, name: m.name || 'Patient', avatar: m.avatar || '', room };
        }
      });
    } catch(e) { console.warn('[carer-meds] room read', room, e); }
  }));
  const patients = Object.values(patientMap);
  _carerPatientCache = patients;
  if (patients.length === 0) { toast(t('No connected patients')); return; }
  if (patients.length === 1) {
    _openPatientMedsList(patients[0].uid, patients[0].name, patients[0].room);
  } else {
    _showPatientPicker();
  }
}

export function _showPatientPicker() {
  document.querySelector('.patient-picker-modal')?.remove();
  document.querySelector('.patient-meds-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'patient-picker-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:89;display:flex;align-items:center;justify-content:center;padding:16px';
  const items = _carerPatientCache.map(p => `
    <div class="pm-item" data-uid="${escHtml(p.uid)}">
      ${p.avatar ? `<span style="font-size:1.3rem">${escHtml(p.avatar)}</span>` : `<span style="font-size:1.1rem">👤</span>`}
      <div style="flex:1;min-width:0">
        <div class="pm-item-name">${escHtml(p.name)}</div>
      </div>
      <span class="pm-item-status">→</span>
    </div>
  `).join('');
  modal.innerHTML = `
    <div class="med-editor-card">
      <div class="me-title">💊 ${t('Select a patient')}</div>
      <div>${items}</div>
      <div class="me-buttons">
        <button class="me-btn-secondary" onclick="document.querySelector('.patient-picker-modal')?.remove()">${t('Cancel')}</button>
      </div>
    </div>
  `;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  // Wire clicks (avoids quoting hell in inline onclick)
  modal.querySelectorAll('.pm-item').forEach(el => {
    el.addEventListener('click', () => {
      const uid = el.dataset.uid;
      const p = _carerPatientCache.find(x => x.uid === uid);
      if (!p) return;
      modal.remove();
      _openPatientMedsList(p.uid, p.name, p.room);
    });
  });
  document.body.appendChild(modal);
}

export async function _openPatientMedsList(patientUid, patientName, roomId) {
  let meds = [];
  // Read medication config from the shared room path (accessible to all
  // room members — carers, family, and the patient).
  if (roomId) {
    try {
      const snap = await db.ref(`carecall/rooms/${roomId}/medConfig`).once('value');
      meds = _normalizeMeds(snap.val() || []);
    } catch(e) { console.warn('[carer-meds] fetch from room', roomId, e); }
  }
  _renderPatientMedsList(patientUid, patientName, meds, roomId);
}

export function _renderPatientMedsList(patientUid, patientName, meds, roomId) {
  document.querySelector('.patient-meds-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'patient-meds-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:89;display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow-y:auto;-webkit-overflow-scrolling:touch';
  const items = meds.length === 0
    ? `<div class="me-hint">${t('No medications configured.')}</div>`
    : meds.map(med => {
        const label = escHtml(_medDisplayLabel(med));
        const desc = escHtml(_medScheduleSummary(med));
        const refillBadge = _medNeedsRefill(med) ? `<span class="pm-item-refill">⚠ ${t('Refill')}</span>` : '';
        const statusCls = med.enabled ? '' : ' off';
        const statusText = med.enabled ? t('On') : t('Off');
        return `
          <div class="pm-item" data-medid="${escHtml(med.id)}" style="opacity:${med.enabled?1:0.55}">
            <span style="font-size:1.1rem">💊</span>
            <div style="flex:1;min-width:0">
              <div class="pm-item-name">${label}${refillBadge}</div>
              <div class="pm-item-desc">${desc}</div>
            </div>
            <span class="pm-item-status${statusCls}">${statusText}</span>
          </div>`;
      }).join('');
  modal.innerHTML = `
    <div class="med-editor-card">
      <div class="me-title">💊 ${escHtml(patientName)} — ${t('Medications')}</div>
      <div id="pm-list">${items}</div>
      <button class="me-add-time-btn" style="margin-top:12px" id="pm-add-btn">+ ${t('Add medication')}</button>
      <button class="me-add-time-btn" style="margin-top:8px" id="pm-interactions-btn">🔍 ${t('Check drug interactions')}</button>
      <button class="me-add-time-btn" style="margin-top:8px" id="pm-export-btn">📄 ${t('Adherence report (PDF)')}</button>
      <div class="me-buttons">
        <button class="me-btn-secondary" id="pm-close-btn">${t('Close')}</button>
      </div>
    </div>`;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);

  const refresh = () => _openPatientMedsList(patientUid, patientName, roomId);
  modal.querySelector('#pm-close-btn').addEventListener('click', () => modal.remove());
  modal.querySelector('#pm-add-btn').addEventListener('click', () => {
    openMedEditor(null, { patientUid, patientName, meds, roomId, onSaved: refresh });
  });
  modal.querySelector('#pm-export-btn').addEventListener('click', () => {
    exportAdherencePdf(patientUid, patientName, meds);
  });
  modal.querySelector('#pm-interactions-btn').addEventListener('click', () => {
    checkDrugInteractions(patientName, meds);
  });
  modal.querySelectorAll('.pm-item').forEach(el => {
    el.addEventListener('click', () => {
      const medId = el.dataset.medid;
      if (!medId) return;
      openMedEditor(medId, { patientUid, patientName, meds, roomId, onSaved: refresh });
    });
  });
}

// ──────────────────────────────────────────────────────────
//  ADHERENCE PDF EXPORT
//  Pulls the last ADHERENCE_WINDOW_DAYS of med events from every
//  room the carer shares with the patient, aggregates per-med
//  stats, and renders a printable report via jsPDF.
// ──────────────────────────────────────────────────────────
export const ADHERENCE_WINDOW_DAYS = 30;

export async function exportAdherencePdf(patientUid, patientName, meds) {
  // Lazy-load jsPDF on first use
  if (!window.jspdf || !window.jspdf.jsPDF) {
    try {
      toast(t('Loading PDF library…'));
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    } catch(e) { console.warn('[jsPDF] lazy-load failed:', e); }
  }
  if (!window.jspdf || !window.jspdf.jsPDF) {
    toast(t('PDF library is not loaded'));
    return;
  }
  toast(t('Preparing report…'));
  const since = Date.now() - ADHERENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  // Gather med events for this patient across all the carer's rooms
  const events = [];
  const rooms = (S && S.rooms) || [];
  await Promise.all(rooms.map(async roomId => {
    try {
      const snap = await db.ref(`carecall/rooms/${roomId}/medications`)
        .orderByChild('timestamp').startAt(since).once('value');
      snap.forEach(child => {
        const e = child.val();
        if (e && e.uid === patientUid) events.push(e);
      });
    } catch(err) { console.warn('[adherence] room read', roomId, err); }
  }));
  events.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const counts = { taken: 0, missed: 0, skipped: 0 };
  const perMed = {}; // medId -> {name, dose, unit, taken, missed, skipped}
  events.forEach(e => {
    const s = (e.status || '').toLowerCase();
    if (counts[s] !== undefined) counts[s]++;
    const key = e.medId || e.medName || '_unknown';
    if (!perMed[key]) {
      perMed[key] = {
        name: e.medName || '—',
        dose: e.dose || null, unit: e.unit || null,
        taken: 0, missed: 0, skipped: 0,
      };
    }
    if (perMed[key][s] !== undefined) perMed[key][s]++;
  });
  // Pull names/doses from live meds list when event log is missing them
  (meds || []).forEach(m => {
    const key = m.id;
    if (!perMed[key]) {
      perMed[key] = {
        name: m.name, dose: m.dose || null, unit: m.unit || null,
        taken: 0, missed: 0, skipped: 0,
      };
    } else {
      if (!perMed[key].name || perMed[key].name === '—') perMed[key].name = m.name;
      if (perMed[key].dose == null) perMed[key].dose = m.dose;
      if (perMed[key].unit == null) perMed[key].unit = m.unit;
    }
  });

  const totalScheduled = counts.taken + counts.missed;
  const adherencePct = totalScheduled > 0 ? Math.round((counts.taken / totalScheduled) * 100) : null;

  // ── Render ──
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 42; // margin
  let y = M;
  const LH = 16;

  const line = (txt, size, style) => {
    if (y > H - M - 20) { doc.addPage(); y = M; }
    doc.setFontSize(size || 11);
    doc.setFont('helvetica', style || 'normal');
    doc.text(String(txt || ''), M, y);
    y += (size >= 16 ? LH + 4 : LH);
  };
  const hr = () => {
    if (y > H - M - 20) { doc.addPage(); y = M; }
    doc.setDrawColor(220); doc.line(M, y, W - M, y); y += 10;
  };

  doc.setFillColor(14, 165, 233);
  doc.rect(0, 0, W, 26, 'F');
  doc.setTextColor(255); doc.setFontSize(12); doc.setFont('helvetica', 'bold');
  doc.text('CareCall — Medication Adherence Report', M, 17);
  doc.setTextColor(0);
  y = M + 10;

  const now = new Date();
  const start = new Date(since);
  const fmt = d => d.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
  line(`Patient: ${patientName || '—'}`, 14, 'bold');
  line(`Period: ${fmt(start)} – ${fmt(now)}  (${ADHERENCE_WINDOW_DAYS} days)`);
  line(`Prepared by: ${S.name || '—'}   ·   Generated: ${now.toLocaleString()}`);
  hr();

  line('Summary', 14, 'bold');
  line(`Overall adherence: ${adherencePct === null ? 'n/a' : adherencePct + '%'}`);
  line(`Taken: ${counts.taken}    Missed: ${counts.missed}    Skipped: ${counts.skipped}`);
  hr();

  // Per-med table
  line('Per-medication breakdown', 14, 'bold');
  y += 4;
  const cols = [
    { label: 'Medication', w: 190 },
    { label: 'Taken',      w: 55, align: 'right' },
    { label: 'Missed',     w: 55, align: 'right' },
    { label: 'Skipped',    w: 55, align: 'right' },
    { label: 'Adherence',  w: 70, align: 'right' },
  ];
  doc.setFontSize(10); doc.setFont('helvetica', 'bold');
  let x = M;
  cols.forEach(c => {
    const tx = c.align === 'right' ? x + c.w - 4 : x + 2;
    doc.text(c.label, tx, y, { align: c.align === 'right' ? 'right' : 'left' });
    x += c.w;
  });
  y += 6; doc.setDrawColor(200); doc.line(M, y, W - M, y); y += 14;
  doc.setFont('helvetica', 'normal');

  const medRows = Object.values(perMed).sort((a, b) => a.name.localeCompare(b.name));
  medRows.forEach(m => {
    if (y > H - M - 30) { doc.addPage(); y = M + 10; }
    const label = m.dose != null ? `${m.name} ${m.dose}${m.unit || ''}` : m.name;
    const sched = m.taken + m.missed;
    const adh = sched > 0 ? Math.round((m.taken / sched) * 100) + '%' : 'n/a';
    x = M;
    const vals = [label, String(m.taken), String(m.missed), String(m.skipped), adh];
    cols.forEach((c, i) => {
      const v = vals[i];
      // Truncate long names to fit column
      const fit = i === 0 && doc.getTextWidth(v) > c.w - 6
        ? v.substring(0, Math.floor((c.w - 6) / (doc.getTextWidth(v) / v.length))) + '…'
        : v;
      const tx = c.align === 'right' ? x + c.w - 4 : x + 2;
      doc.text(fit, tx, y, { align: c.align === 'right' ? 'right' : 'left' });
      x += c.w;
    });
    y += 14;
  });
  if (medRows.length === 0) { doc.setFont('helvetica', 'italic'); line('No medication data for this period.'); doc.setFont('helvetica', 'normal'); }
  hr();

  // Recent events
  line('Recent dose events', 14, 'bold');
  y += 2;
  doc.setFontSize(9);
  const maxEvents = 60;
  events.slice(0, maxEvents).forEach(e => {
    if (y > H - M - 20) { doc.addPage(); y = M + 10; }
    const d = e.timestamp ? new Date(e.timestamp) : null;
    const when = d ? d.toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
    const row = `${when}  ·  ${e.medName || '—'}${e.dose ? ' ' + e.dose + (e.unit || '') : ''}  ·  ${(e.status || '').toUpperCase()}`;
    doc.text(row, M, y); y += 12;
  });
  if (events.length > maxEvents) {
    doc.setFont('helvetica', 'italic');
    doc.text(`(+${events.length - maxEvents} older events not shown)`, M, y);
    doc.setFont('helvetica', 'normal');
    y += 12;
  }

  // Signature line at bottom of the last page
  if (y > H - M - 60) { doc.addPage(); y = M; }
  y = H - M - 40;
  doc.setDrawColor(200); doc.line(M, y, M + 200, y);
  doc.setFontSize(9); doc.setTextColor(120);
  doc.text('Clinician signature', M, y + 12);
  doc.setTextColor(0);

  const safeName = (patientName || 'patient').replace(/[^a-zA-Z0-9]+/g, '_');
  const dateTag = now.toISOString().slice(0, 10);
  const fileName = `carecall_adherence_${safeName}_${dateTag}.pdf`;
  const res = await Native.savePdf(doc, fileName);
  if (!res.ok) {
    console.error('[savePdf] failed:', res);
    toast((t('Save failed') + ': ') + (res.error || 'unknown'));
    return;
  }
  if (res.platform === 'web') toast(t('PDF downloaded'));
  else if (res.cancelled) toast(t('PDF saved to app'));
  else if (res.shared) toast(t('Report ready — choose where to save'));
  else toast(t('PDF saved to app') + (res.error ? ' (' + res.error + ')' : ''));
}

// ──────────────────────────────────────────────────────────
//  DRUG-DRUG INTERACTION CHECK (carer-only)
//  Best-effort lookup via NIH RxNav:
//    1. Resolve each med's RxCUI via /REST/rxcui.json?name=...
//    2. Query /REST/interaction/list.json?rxcuis=<joined>
//  Results are shown in a dialog on the carer side only — patients
//  never see these warnings so they can't alarm mid-reminder.
//  Note: NLM's DDI endpoint was marked retired in 2024. We handle
//  empty / error responses gracefully and recommend a clinician
//  review regardless — this is a safety net, not a replacement
//  for professional advice.
// ──────────────────────────────────────────────────────────
export const _rxcuiCache = {}; // name -> rxcui string | null

export async function _lookupRxcui(name) {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  if (key in _rxcuiCache) return _rxcuiCache[key];
  try {
    const url = 'https://rxnav.nlm.nih.gov/REST/rxcui.json?name=' + encodeURIComponent(name);
    const resp = await fetch(url);
    if (!resp.ok) { _rxcuiCache[key] = null; return null; }
    const json = await resp.json();
    const id = json && json.idGroup && Array.isArray(json.idGroup.rxnormId) && json.idGroup.rxnormId[0];
    _rxcuiCache[key] = id || null;
    return id || null;
  } catch(e) {
    console.warn('[rxcui]', name, e && e.message);
    _rxcuiCache[key] = null;
    return null;
  }
}

// ──────────────────────────────────────────────────────────
//  BUILT-IN SEVERE INTERACTION RULES
//  NLM retired the public DDI endpoint in Jan 2024, so RxNav
//  alone can no longer flag dangerous combinations. This curated
//  rule set catches the most common home-setting high-severity
//  pairings. Matches are substring, case-insensitive, on the
//  active ingredient (or commercial name as fallback). Not a
//  substitute for clinical review — the dialog says so.
// ──────────────────────────────────────────────────────────
export const KNOWN_SEVERE_INTERACTIONS = [
  // Anticoagulant + antiplatelet / NSAID → bleeding
  { a:'warfarin',   b:'aspirin',      s:'high',     d:'Warfarin + aspirin substantially increases bleeding risk.' },
  { a:'warfarin',   b:'ibuprofen',    s:'high',     d:'NSAIDs with warfarin raise INR and GI bleeding risk.' },
  { a:'warfarin',   b:'naproxen',     s:'high',     d:'NSAIDs with warfarin raise INR and GI bleeding risk.' },
  { a:'warfarin',   b:'diclofenac',   s:'high',     d:'NSAIDs with warfarin raise INR and GI bleeding risk.' },
  { a:'warfarin',   b:'etodolac',     s:'high',     d:'NSAIDs with warfarin raise INR and GI bleeding risk.' },
  { a:'warfarin',   b:'meloxicam',    s:'high',     d:'NSAIDs with warfarin raise INR and GI bleeding risk.' },
  { a:'warfarin',   b:'etoricoxib',   s:'moderate', d:'COX-2 inhibitors can still raise warfarin bleeding risk.' },
  { a:'warfarin',   b:'clopidogrel',  s:'high',     d:'Combined anticoagulant + antiplatelet — severe bleeding risk.' },
  { a:'warfarin',   b:'ticagrelor',   s:'high',     d:'Combined anticoagulant + antiplatelet — severe bleeding risk.' },
  { a:'apixaban',   b:'aspirin',      s:'high',     d:'Apixaban + aspirin substantially increases bleeding risk.' },
  { a:'rivaroxaban',b:'aspirin',      s:'high',     d:'Rivaroxaban + aspirin substantially increases bleeding risk.' },
  { a:'dabigatran', b:'aspirin',      s:'high',     d:'Dabigatran + aspirin substantially increases bleeding risk.' },
  { a:'apixaban',   b:'clopidogrel',  s:'high',     d:'DOAC + antiplatelet — severe bleeding risk unless indicated.' },
  { a:'rivaroxaban',b:'clopidogrel',  s:'high',     d:'DOAC + antiplatelet — severe bleeding risk unless indicated.' },
  { a:'apixaban',   b:'ibuprofen',    s:'high',     d:'DOACs with NSAIDs — elevated bleeding risk.' },
  { a:'rivaroxaban',b:'ibuprofen',    s:'high',     d:'DOACs with NSAIDs — elevated bleeding risk.' },
  { a:'apixaban',   b:'naproxen',     s:'high',     d:'DOACs with NSAIDs — elevated bleeding risk.' },
  // Dual anticoagulants (never-combine)
  { a:'warfarin',   b:'apixaban',     s:'high',     d:'Two anticoagulants together — severe bleeding risk.' },
  { a:'warfarin',   b:'rivaroxaban',  s:'high',     d:'Two anticoagulants together — severe bleeding risk.' },
  { a:'warfarin',   b:'dabigatran',   s:'high',     d:'Two anticoagulants together — severe bleeding risk.' },
  { a:'apixaban',   b:'rivaroxaban',  s:'high',     d:'Two direct oral anticoagulants — severe bleeding risk.' },
  { a:'apixaban',   b:'dabigatran',   s:'high',     d:'Two direct oral anticoagulants — severe bleeding risk.' },
  { a:'rivaroxaban',b:'dabigatran',   s:'high',     d:'Two direct oral anticoagulants — severe bleeding risk.' },
  { a:'enoxaparin', b:'apixaban',     s:'high',     d:'Two anticoagulants together — severe bleeding risk.' },
  { a:'enoxaparin', b:'rivaroxaban',  s:'high',     d:'Two anticoagulants together — severe bleeding risk.' },
  { a:'enoxaparin', b:'warfarin',     s:'moderate', d:'Usually intentional bridging; verify indication and overlap length.' },
  // Warfarin / DOAC CYP + P-gp interactions
  { a:'warfarin',   b:'amiodarone',   s:'high',     d:'Amiodarone potentiates warfarin — reduce dose and monitor INR.' },
  { a:'warfarin',   b:'fluconazole',  s:'high',     d:'Fluconazole markedly raises warfarin levels.' },
  { a:'warfarin',   b:'metronidazole',s:'high',     d:'Metronidazole markedly raises warfarin levels.' },
  { a:'warfarin',   b:'ciprofloxacin',s:'moderate', d:'Ciprofloxacin can raise warfarin levels.' },
  { a:'warfarin',   b:'clarithromycin',s:'moderate',d:'Clarithromycin can raise warfarin levels.' },
  { a:'warfarin',   b:'trimethoprim', s:'moderate', d:'TMP/SMX raises warfarin — monitor INR.' },
  // SSRIs + NSAIDs (GI bleed)
  { a:'sertraline', b:'ibuprofen',    s:'moderate', d:'SSRI + NSAID increases GI bleeding risk.' },
  { a:'citalopram', b:'ibuprofen',    s:'moderate', d:'SSRI + NSAID increases GI bleeding risk.' },
  { a:'escitalopram', b:'ibuprofen',  s:'moderate', d:'SSRI + NSAID increases GI bleeding risk.' },
  { a:'fluoxetine', b:'ibuprofen',    s:'moderate', d:'SSRI + NSAID increases GI bleeding risk.' },
  { a:'paroxetine', b:'ibuprofen',    s:'moderate', d:'SSRI + NSAID increases GI bleeding risk.' },
  { a:'sertraline', b:'warfarin',     s:'moderate', d:'SSRIs can potentiate warfarin — monitor INR and bleeding.' },
  { a:'citalopram', b:'warfarin',     s:'moderate', d:'SSRIs can potentiate warfarin — monitor INR and bleeding.' },
  { a:'fluoxetine', b:'warfarin',     s:'moderate', d:'SSRIs can potentiate warfarin — monitor INR and bleeding.' },
  // SSRIs / SNRIs + serotonergic drugs → serotonin syndrome
  { a:'sertraline', b:'tramadol',     s:'high',     d:'Serotonin syndrome risk with SSRI + tramadol.' },
  { a:'fluoxetine', b:'tramadol',     s:'high',     d:'Serotonin syndrome risk with SSRI + tramadol.' },
  { a:'citalopram', b:'tramadol',     s:'high',     d:'Serotonin syndrome risk with SSRI + tramadol.' },
  { a:'escitalopram',b:'tramadol',    s:'high',     d:'Serotonin syndrome risk with SSRI + tramadol.' },
  { a:'paroxetine', b:'tramadol',     s:'high',     d:'Serotonin syndrome risk with SSRI + tramadol.' },
  { a:'duloxetine', b:'tramadol',     s:'high',     d:'Serotonin syndrome risk with SNRI + tramadol.' },
  { a:'venlafaxine',b:'tramadol',     s:'high',     d:'Serotonin syndrome risk with SNRI + tramadol.' },
  { a:'sertraline', b:'mirtazapine',  s:'moderate', d:'Combined serotonergic effect — monitor for serotonin symptoms.' },
  { a:'sertraline', b:'sumatriptan',  s:'moderate', d:'SSRI + triptan — small serotonin syndrome risk.' },
  // Benzos / Z-drugs + opioids (respiratory depression)
  { a:'diazepam',   b:'tramadol',     s:'high',     d:'Benzodiazepine + opioid — profound respiratory depression risk.' },
  { a:'alprazolam', b:'tramadol',     s:'high',     d:'Benzodiazepine + opioid — profound respiratory depression risk.' },
  { a:'clonazepam', b:'tramadol',     s:'high',     d:'Benzodiazepine + opioid — profound respiratory depression risk.' },
  { a:'zolpidem',   b:'tramadol',     s:'high',     d:'Sedative + opioid — profound respiratory depression risk.' },
  { a:'zopiclone',  b:'tramadol',     s:'high',     d:'Sedative + opioid — profound respiratory depression risk.' },
  { a:'diazepam',   b:'oxycodone',    s:'high',     d:'Benzodiazepine + opioid — profound respiratory depression risk.' },
  { a:'alprazolam', b:'oxycodone',    s:'high',     d:'Benzodiazepine + opioid — profound respiratory depression risk.' },
  { a:'pregabalin', b:'tramadol',     s:'moderate', d:'CNS depression additive with opioids.' },
  { a:'gabapentin', b:'tramadol',     s:'moderate', d:'CNS depression additive with opioids.' },
  // Statins + CYP3A4 inhibitors (rhabdomyolysis)
  { a:'simvastatin',  b:'clarithromycin', s:'high',     d:'Clarithromycin raises simvastatin levels — rhabdomyolysis risk.' },
  { a:'simvastatin',  b:'erythromycin',   s:'high',     d:'Erythromycin raises simvastatin levels — rhabdomyolysis risk.' },
  { a:'simvastatin',  b:'itraconazole',   s:'high',     d:'Azole markedly raises simvastatin levels — contraindicated.' },
  { a:'simvastatin',  b:'ketoconazole',   s:'high',     d:'Azole markedly raises simvastatin levels — contraindicated.' },
  { a:'simvastatin',  b:'fluconazole',    s:'high',     d:'Azole raises simvastatin levels — rhabdomyolysis risk.' },
  { a:'atorvastatin', b:'clarithromycin', s:'moderate', d:'Clarithromycin may raise atorvastatin levels.' },
  { a:'atorvastatin', b:'erythromycin',   s:'moderate', d:'Erythromycin may raise atorvastatin levels.' },
  { a:'atorvastatin', b:'itraconazole',   s:'moderate', d:'Azoles can raise atorvastatin levels.' },
  { a:'simvastatin',  b:'gemfibrozil',    s:'high',     d:'Fibrate + statin — rhabdomyolysis risk; avoid combination.' },
  { a:'atorvastatin', b:'gemfibrozil',    s:'high',     d:'Fibrate + statin — rhabdomyolysis risk; avoid combination.' },
  // Rate/rhythm — beta-blocker + non-DHP CCB
  { a:'verapamil',  b:'bisoprolol',   s:'high',     d:'Non-DHP CCB + beta blocker — bradycardia / AV block risk.' },
  { a:'verapamil',  b:'atenolol',     s:'high',     d:'Non-DHP CCB + beta blocker — bradycardia / AV block risk.' },
  { a:'verapamil',  b:'metoprolol',   s:'high',     d:'Non-DHP CCB + beta blocker — bradycardia / AV block risk.' },
  { a:'diltiazem',  b:'bisoprolol',   s:'high',     d:'Non-DHP CCB + beta blocker — bradycardia / AV block risk.' },
  { a:'diltiazem',  b:'atenolol',     s:'high',     d:'Non-DHP CCB + beta blocker — bradycardia / AV block risk.' },
  { a:'diltiazem',  b:'metoprolol',   s:'high',     d:'Non-DHP CCB + beta blocker — bradycardia / AV block risk.' },
  // Digoxin interactions
  { a:'digoxin',    b:'amiodarone',   s:'high',     d:'Amiodarone raises digoxin levels — reduce dose, monitor toxicity.' },
  { a:'digoxin',    b:'verapamil',    s:'high',     d:'Verapamil raises digoxin levels — toxicity risk.' },
  { a:'digoxin',    b:'diltiazem',    s:'moderate', d:'Diltiazem may raise digoxin levels.' },
  { a:'digoxin',    b:'clarithromycin',s:'high',    d:'Clarithromycin markedly raises digoxin levels — toxicity risk.' },
  { a:'digoxin',    b:'furosemide',   s:'moderate', d:'Hypokalaemia from loop diuretic potentiates digoxin toxicity.' },
  { a:'digoxin',    b:'spironolactone',s:'moderate',d:'Spironolactone can raise digoxin levels; also alters K+ balance.' },
  // Dual RAAS blockade
  { a:'lisinopril', b:'losartan',     s:'high',     d:'Dual RAAS blockade — hyperkalaemia and AKI risk; avoid.' },
  { a:'ramipril',   b:'losartan',     s:'high',     d:'Dual RAAS blockade — hyperkalaemia and AKI risk; avoid.' },
  { a:'enalapril',  b:'losartan',     s:'high',     d:'Dual RAAS blockade — hyperkalaemia and AKI risk; avoid.' },
  { a:'ramipril',   b:'valsartan',    s:'high',     d:'Dual RAAS blockade — hyperkalaemia and AKI risk; avoid.' },
  // Potassium-sparing + ACE/ARB / K supplements
  { a:'spironolactone', b:'losartan',  s:'moderate', d:'Both can raise potassium — monitor serum K+.' },
  { a:'spironolactone', b:'ramipril',  s:'moderate', d:'Both can raise potassium — monitor serum K+.' },
  { a:'spironolactone', b:'enalapril', s:'moderate', d:'Both can raise potassium — monitor serum K+.' },
  { a:'spironolactone', b:'valsartan', s:'moderate', d:'Both can raise potassium — monitor serum K+.' },
  { a:'spironolactone', b:'lisinopril',s:'moderate', d:'Both can raise potassium — monitor serum K+.' },
  // PPI + clopidogrel (reduced antiplatelet effect)
  { a:'omeprazole',   b:'clopidogrel', s:'moderate', d:'Omeprazole reduces clopidogrel activation — consider pantoprazole instead.' },
  { a:'esomeprazole', b:'clopidogrel', s:'moderate', d:'Esomeprazole reduces clopidogrel activation — consider pantoprazole instead.' },
  // Dual NSAIDs
  { a:'ibuprofen',  b:'naproxen',     s:'high',     d:'Two NSAIDs add GI bleed + renal risk with no extra benefit.' },
  { a:'ibuprofen',  b:'diclofenac',   s:'high',     d:'Two NSAIDs add GI bleed + renal risk with no extra benefit.' },
  { a:'naproxen',   b:'diclofenac',   s:'high',     d:'Two NSAIDs add GI bleed + renal risk with no extra benefit.' },
  { a:'ibuprofen',  b:'etodolac',     s:'high',     d:'Two NSAIDs add GI bleed + renal risk with no extra benefit.' },
  { a:'naproxen',   b:'etodolac',     s:'high',     d:'Two NSAIDs add GI bleed + renal risk with no extra benefit.' },
  // Dual antiplatelet
  { a:'aspirin',    b:'clopidogrel',  s:'moderate', d:'Dual antiplatelet — may be intentional; monitor for bleeding.' },
  { a:'aspirin',    b:'ticagrelor',   s:'moderate', d:'Dual antiplatelet — usually intentional post-stent; monitor for bleeding.' },
  // ACE/ARB + NSAID + diuretic "triple whammy"
  { a:'ramipril',   b:'ibuprofen',    s:'moderate', d:'ACE + NSAID — AKI risk; add diuretic = "triple whammy".' },
  { a:'losartan',   b:'ibuprofen',    s:'moderate', d:'ARB + NSAID — AKI risk; add diuretic = "triple whammy".' },
  { a:'lisinopril', b:'ibuprofen',    s:'moderate', d:'ACE + NSAID — AKI risk; add diuretic = "triple whammy".' },
  { a:'valsartan',  b:'naproxen',     s:'moderate', d:'ARB + NSAID — AKI risk; add diuretic = "triple whammy".' },
  // Lithium (narrow therapeutic index)
  { a:'lithium',    b:'ibuprofen',    s:'high',     d:'NSAIDs raise lithium levels — toxicity risk.' },
  { a:'lithium',    b:'naproxen',     s:'high',     d:'NSAIDs raise lithium levels — toxicity risk.' },
  { a:'lithium',    b:'ramipril',     s:'high',     d:'ACE inhibitors raise lithium levels — toxicity risk.' },
  { a:'lithium',    b:'losartan',     s:'high',     d:'ARBs raise lithium levels — toxicity risk.' },
  { a:'lithium',    b:'furosemide',   s:'moderate', d:'Loop diuretics can raise lithium levels.' },
  // QT prolongers
  { a:'citalopram', b:'amiodarone',   s:'high',     d:'Additive QT prolongation — cardiac risk.' },
  { a:'citalopram', b:'ciprofloxacin',s:'moderate', d:'Additive QT prolongation — cardiac risk.' },
  { a:'citalopram', b:'clarithromycin',s:'moderate',d:'Additive QT prolongation — cardiac risk.' },
  { a:'amiodarone', b:'ciprofloxacin',s:'high',     d:'Additive QT prolongation — cardiac risk.' },
  { a:'amiodarone', b:'clarithromycin',s:'high',    d:'Additive QT prolongation — cardiac risk.' },
  // Levothyroxine absorption
  { a:'levothyroxine', b:'calcium',        s:'moderate', d:'Calcium reduces levothyroxine absorption — separate by ≥4h.' },
  { a:'levothyroxine', b:'iron',           s:'moderate', d:'Iron reduces levothyroxine absorption — separate by ≥4h.' },
  { a:'levothyroxine', b:'omeprazole',     s:'moderate', d:'PPIs can reduce levothyroxine absorption — monitor TSH.' },
  { a:'levothyroxine', b:'pantoprazole',   s:'moderate', d:'PPIs can reduce levothyroxine absorption — monitor TSH.' },
  // Immunosuppressant + severe combos
  { a:'allopurinol',b:'azathioprine', s:'high',     d:'Allopurinol markedly raises azathioprine toxicity — bone marrow suppression.' },
  { a:'methotrexate',b:'trimethoprim',s:'high',     d:'TMP potentiates methotrexate toxicity — avoid.' },
  { a:'methotrexate',b:'ibuprofen',   s:'moderate', d:'NSAIDs reduce methotrexate clearance — toxicity risk.' },
  // Macrolide / azole + common CYP3A4 substrates beyond statins
  { a:'clarithromycin', b:'colchicine', s:'high',   d:'Clarithromycin raises colchicine — potentially fatal toxicity.' },
  { a:'erythromycin',   b:'colchicine', s:'high',   d:'Erythromycin raises colchicine — potentially fatal toxicity.' },
  // Bisphosphonate + calcium
  { a:'alendronate',    b:'calcium',    s:'moderate',d:'Calcium impairs bisphosphonate absorption — separate by ≥30 min.' },
  // Tramadol + seizure-lowering
  { a:'tramadol',    b:'bupropion',    s:'high',    d:'Additive seizure risk — avoid combination.' },
];

export function _localInteractionCheck(meds) {
  if (!Array.isArray(meds) || meds.length < 2) return [];
  const items = meds.map(m => ({
    display: m.name,
    key: ((m.activeIngredient || m.name) || '').toLowerCase(),
  }));
  const warnings = [];
  const seenPairs = new Set();
  KNOWN_SEVERE_INTERACTIONS.forEach(rule => {
    const ia = items.findIndex(x => x.key && x.key.includes(rule.a));
    const ib = items.findIndex((x, idx) => idx !== ia && x.key && x.key.includes(rule.b));
    if (ia < 0 || ib < 0) return;
    const pairKey = [Math.min(ia, ib), Math.max(ia, ib), rule.a, rule.b].join('|');
    if (seenPairs.has(pairKey)) return;
    seenPairs.add(pairKey);
    warnings.push({
      severity: rule.s,
      description: rule.d,
      drugs: [items[ia].display, items[ib].display],
      source: 'CareCall built-in rules',
    });
  });
  return warnings;
}

export async function checkDrugInteractions(patientName, meds) {
  if (S.role !== 'carer') return; // belt-and-braces
  if (!Array.isArray(meds) || meds.length < 2) {
    _showInteractionResult(patientName, { warnings: [], unknown: [], note: t('Need at least two medications to check interactions.') });
    return;
  }
  toast(t('Checking interactions…'));
  // Always run the local rule-based check — doesn't depend on any
  // external API and catches the most dangerous home-setting combos.
  const localWarnings = _localInteractionCheck(meds);

  // Best-effort RxNav resolution to list unknowns and (optionally) to
  // augment with DDI data IF the endpoint ever comes back. NLM retired
  // the DDI endpoint in Jan 2024, so we tolerate 404s silently.
  let apiWarnings = [];
  let unknown = [];
  try {
    const lookups = await Promise.all(meds.map(async m => {
      const lookupName = (m.activeIngredient && m.activeIngredient.trim()) || m.name;
      return { displayName: m.name, lookupName, rxcui: await _lookupRxcui(lookupName) };
    }));
    const known = lookups.filter(x => x.rxcui);
    unknown = lookups.filter(x => !x.rxcui).map(x => x.displayName);

    // De-dupe RxCUIs: multiple brands with the same ingredient (Acamol
    // + Dexamol = Paracetamol) collapse to one. The DDI endpoint
    // needs at least two DIFFERENT drugs to say anything useful.
    const uniqueRxcuis = [...new Set(known.map(x => x.rxcui))];
    if (uniqueRxcuis.length >= 2) {
      try {
        const resp = await fetch('https://rxnav.nlm.nih.gov/REST/interaction/list.json?rxcuis=' + uniqueRxcuis.join('+'));
        if (resp.ok) {
          const json = await resp.json();
          const groups = (json && json.fullInteractionTypeGroup) || [];
          groups.forEach(group => {
            (group.fullInteractionType || []).forEach(typ => {
              const drugs = (typ.minConcept || []).map(c => c.name || c.rxcui).filter(Boolean);
              (typ.interactionPair || []).forEach(pair => {
                apiWarnings.push({
                  severity: (pair.severity || 'n/a').toLowerCase(),
                  description: pair.description || '',
                  drugs,
                  source: group.sourceName || 'RxNav',
                });
              });
            });
          });
        }
      } catch(_) { /* endpoint retired or offline — local rules still apply */ }
    }
  } catch (e) { console.warn('[interactions] rxcui lookup failed', e && e.message); }

  const warnings = [...apiWarnings, ...localWarnings];
  const note = (warnings.length === 0)
    ? t('No warnings from our built-in checks. This is a limited rule set — confirm the full list with a pharmacist or doctor.')
    : null;
  _showInteractionResult(patientName, { warnings, unknown, note });
}

export function _showInteractionResult(patientName, result) {
  document.querySelector('.interactions-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'interactions-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:92;display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow-y:auto;-webkit-overflow-scrolling:touch';
  const warnings = result.warnings || [];
  const unknown = result.unknown || [];
  const items = warnings.length === 0
    ? `<div class="ix-empty">${result.note ? escHtml(result.note) : t('No interactions found for the listed medications.')}</div>`
    : warnings.map(w => {
        const sev = (w.severity || '').replace(/[^a-z]/g, '') || 'med';
        const pair = (w.drugs || []).join(' ↔ ');
        return `
          <div class="ix-item">
            <div><span class="ix-severity ${sev}">${escHtml(w.severity || 'n/a')}</span><span class="ix-pair">${escHtml(pair)}</span></div>
            <div class="ix-desc">${escHtml(w.description)}</div>
            ${w.source ? `<div class="ix-src">${t('Source')}: ${escHtml(w.source)}</div>` : ''}
          </div>`;
      }).join('');
  const unknownNote = unknown.length
    ? `<div class="ix-unknown">${t('Not found in database')}: ${escHtml(unknown.join(', '))}</div>` : '';
  modal.innerHTML = `
    <div class="med-editor-card">
      <div class="me-title">🔍 ${escHtml(patientName)} — ${t('Drug interactions')}</div>
      <div class="me-hint" style="margin-bottom:10px">${t('This check is a safety net and does not replace clinician review. Warnings are based on the NIH RxNav database.')}</div>
      <div>${items}</div>
      ${unknownNote}
      ${warnings.length && result.note ? `<div class="ix-unknown" style="color:#FBBF24">${escHtml(result.note)}</div>` : ''}
      <div class="me-buttons">
        <button class="me-btn-secondary" onclick="document.querySelector('.interactions-modal')?.remove()">${t('Close')}</button>
      </div>
    </div>`;
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

export function _parseIntOrNull(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (str === '') return null;
  const n = parseInt(str, 10);
  return isNaN(n) ? null : Math.max(0, n);
}

export function saveMedFromEditor() {
  const s = _meState;
  if (!s) return;
  const name = (document.getElementById('me-name').value || '').trim();
  if (!name) { toast(t('Enter medication name')); return; }
  const activeIngredient = (document.getElementById('me-active')?.value || '').trim() || null;
  const doseRaw = (document.getElementById('me-dose').value || '').trim();
  const unit = (document.getElementById('me-unit').value || '').trim() || null;
  const instructions = (document.getElementById('me-instructions').value || '').trim() || null;
  const kind = document.getElementById('me-kind').value;
  const stock = _parseIntOrNull(document.getElementById('me-stock')?.value);
  const refillThreshold = _parseIntOrNull(document.getElementById('me-refill')?.value);
  let dose = null;
  if (doseRaw) {
    const n = parseFloat(doseRaw);
    dose = isNaN(n) ? doseRaw : n;
  }
  const prn = (kind === 'prn');
  let schedule = s.draft.schedule || { kind: 'fixed_times', times: [], window_minutes: 60 };
  // Response window — applies to all scheduled kinds. Clamp to [1, 1440] minutes.
  const windowRaw = parseInt(document.getElementById('me-window')?.value, 10);
  const windowMinutes = isNaN(windowRaw) ? (schedule.window_minutes || 60)
                                         : Math.min(1440, Math.max(1, windowRaw));

  if (kind === 'fixed_times' || kind === 'days_of_week') {
    const times = (schedule.times || []).filter(tm => tm && /^\d{1,2}:\d{2}$/.test(tm));
    if (times.length === 0) { toast(t('Add at least one time.')); return; }
    schedule = { kind, times, window_minutes: windowMinutes };
    if (kind === 'days_of_week') {
      const days = (s.draft.schedule.days || []).slice();
      if (!days.length) { toast(t('Select at least one day.')); return; }
      schedule.days = days;
    }
  } else if (kind === 'interval') {
    const hoursEl = document.getElementById('me-interval-hours');
    const anchorEl = document.getElementById('me-anchor');
    const hours = Math.min(24, Math.max(1, parseInt(hoursEl.value, 10) || 6));
    const anchor = (anchorEl.value || '08:00');
    schedule = { kind: 'interval', interval_hours: hours, anchor, window_minutes: windowMinutes };
  } else if (kind === 'prn') {
    // Preserve any previously-entered times for later reactivation
    schedule = Object.assign({}, schedule, { kind: schedule.kind || 'fixed_times' });
  }

  // If stock is topped up above the threshold, clear the refill-alert flag
  // so the next dip below the threshold fires a fresh alert.
  function _computeRefillAlerted(prevMed) {
    const was = prevMed && prevMed.refillAlerted === true;
    if (stock === null || refillThreshold === null) return false;
    if (stock > refillThreshold) return false;
    return was; // leave as-is (still alerted, or not-yet alerted)
  }

  const photos = Array.isArray(s.draft.photos)
    ? s.draft.photos.filter(p => typeof p === 'string' && p).slice(0, MED_MAX_PHOTOS)
    : [];

  if (s.proxy) {
    // Carer is editing a patient's meds remotely.
    // Mutate proxy.meds in place and persist to the patient's path.
    const targetList = s.proxy.meds;
    if (s.isNew) {
      targetList.push({
        id: 'med_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name, activeIngredient, dose, unit, instructions, photos,
        schedule, stock, refillThreshold, refillAlerted: false,
        prn, enabled: true,
        createdBy: 'carer',
        createdAt: Date.now(),
      });
    } else {
      const med = targetList.find(m => m.id === s.medId);
      if (!med) { _closeMedEditor(); return; }
      med.refillAlerted = _computeRefillAlerted(med);
      med.name = name;
      med.activeIngredient = activeIngredient;
      med.dose = dose;
      med.unit = unit;
      med.instructions = instructions;
      med.photos = photos;
      if ('photoUrl' in med) delete med.photoUrl;
      med.schedule = schedule;
      med.stock = stock;
      med.refillThreshold = refillThreshold;
      med.prn = prn;
    }
    // Write to the shared room path — accessible to all room members.
    const proxyRoom = s.proxy.roomId;
    if (proxyRoom) {
      db.ref(`carecall/rooms/${proxyRoom}/medConfig`).set(targetList)
        .catch(e => { console.warn('[carer-proxy save]', e); toast(t('Save failed')); });
    } else {
      console.warn('[carer-proxy save] no roomId on proxy — cannot persist');
      toast(t('Save failed'));
    }
    if (typeof s.proxy.onSaved === 'function') s.proxy.onSaved();
    _closeMedEditor();
    toast(s.isNew ? t('Medication added') : t('Medication updated'));
    return;
  }

  // Self-save (patient editing their own meds)
  if (s.isNew) {
    _medications.push({
      id: 'med_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name, activeIngredient, dose, unit, instructions, photos,
      schedule, stock, refillThreshold, refillAlerted: false,
      prn, enabled: true,
      createdBy: S.role === 'carer' ? 'carer' : 'patient',
      createdAt: Date.now(),
    });
  } else {
    const med = _medications.find(m => m.id === s.medId);
    if (!med) { _closeMedEditor(); return; }
    med.refillAlerted = _computeRefillAlerted(med);
    med.name = name;
    med.activeIngredient = activeIngredient;
    med.dose = dose;
    med.unit = unit;
    med.instructions = instructions;
    med.photos = photos;
    if ('photoUrl' in med) delete med.photoUrl;
    med.schedule = schedule;
    med.stock = stock;
    med.refillThreshold = refillThreshold;
    med.prn = prn;
  }

  _saveMedications();
  _scheduleAllMedNotifications();
  refreshSettings();
  _closeMedEditor();
  toast(s.isNew ? t('Medication added') : t('Medication updated'));
}

