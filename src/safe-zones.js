// ════════════════════════════════════════════════════════════
//  SAFE ZONES — geofencing, zone editor, map picker
// ════════════════════════════════════════════════════════════
import { S } from './state.js';

// ════════════════════════════════════════════════════════════
//  SAFE ZONES (Geo-Fencing)
// ════════════════════════════════════════════════════════════
// _safeZones: array of zone records (migrated from legacy _geoFence).
//   { id, label, lat, lng, radiusM, dwellSec, enabled, isHome, setAt, createdBy }
// _geoFence: kept as a live pointer to the "home" zone for the
//   patient screen's quiet-confidence pill and legacy callers.
// localStorage: 'carecall_safezones' (plus legacy 'carecall_geofence')
// Firebase:     carecall/users/{uid}/safeZones
export let _safeZones = [];
export let _geoFence = null;          // convenience alias for the home zone
export let _geoWatchId = null;        // monitoring watch
export let _sazLiveWatchId = null;    // editor-open live-distance watch
export let _sazLastPos = null;
export let _sazDraft = null;          // working copy in editor
export let _zoneRuntime = {};         // zoneId -> { outsideSince, insideSince, lastAlertAt, ackPending, armTimer }
export let _zoneEvents = [];          // local history of exit/arrival/ack events (last 50)

export const SAZ_MIN_RADIUS = 25;
export const SAZ_MAX_RADIUS = 5000;
export const SAZ_DEFAULT_RADIUS = 200;
export const SAZ_DEFAULT_DWELL_SEC = 90;      // "exit dwell-time" — kills GPS-drift FPs
export const SAZ_ACK_WINDOW_MS = 120 * 1000;  // "I'm safe" prompt stays up this long
export const SAZ_ALERT_COOLDOWN_MS = 5 * 60 * 1000;
export const SAZ_WATCH_OPTS = { enableHighAccuracy: true, maximumAge: 20000, timeout: 30000 };
export const SAZ_MAX_EVENTS = 50;
export const SAZ_MAX_ZONES = 6;

// ── Dwell log for learned-zone suggestions ──────────────────
// Every DWELL_SAMPLE_MS while the Safe Zone tick runs we record
// the patient's position. After a week there are ≈2 000 samples
// and a simple single-link clustering pass surfaces where the
// patient habitually dwells, so we can offer "Add this as a
// zone?" suggestions in the zones-list modal. Client-side only —
// positions never leave the device.
export const DWELL_SAMPLE_MS = 5 * 60 * 1000;        // 5 min
export const DWELL_MAX_ENTRIES = 2016;               // ≈ 7 days
export const DWELL_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
export const LEARN_CLUSTER_EPS_M = 80;               // points within 80 m cluster together
export const LEARN_CLUSTER_MIN_DWELL_MIN = 60;       // ≥ 1 h dwell before we suggest
export let _dwellLog = [];
export let _lastDwellSampleAt = 0;
export let _dwellDirty = false;
export const DWELL_FLUSH_MS = 15 * 60 * 1000; // flush to localStorage every 15 min
export let _dwellFlushTimer = null;
export function _loadDwellLog() {
  try { _dwellLog = JSON.parse(localStorage.getItem('carecall_dwell_log') || '[]'); }
  catch(e) { _dwellLog = []; }
}
export function _saveDwellLog() {
  const cutoff = Date.now() - DWELL_RETAIN_MS;
  _dwellLog = _dwellLog.filter(p => p && p.ts >= cutoff);
  if (_dwellLog.length > DWELL_MAX_ENTRIES) _dwellLog = _dwellLog.slice(-DWELL_MAX_ENTRIES);
  try { localStorage.setItem('carecall_dwell_log', JSON.stringify(_dwellLog)); } catch(e) {}
  _dwellDirty = false;
}
export function _flushDwellIfDirty() {
  if (_dwellDirty) _saveDwellLog();
}
export function _recordDwellSample(lat, lng) {
  const now = Date.now();
  if (now - _lastDwellSampleAt < DWELL_SAMPLE_MS) return;
  _lastDwellSampleAt = now;
  _dwellLog.push({ ts: now, lat, lng });
  _dwellDirty = true;
  // Batch writes: flush every 15 min instead of on every sample
  if (!_dwellFlushTimer) {
    _dwellFlushTimer = setTimeout(() => { _dwellFlushTimer = null; _flushDwellIfDirty(); }, DWELL_FLUSH_MS);
  }
}

// Single-link clustering on the dwell log. Each point represents
// roughly DWELL_SAMPLE_MS of dwell time; we grow clusters by
// connecting any unassigned point within eps of an existing
// cluster member. Returns centroid + suggested radius + estimated
// dwell minutes, sorted by dwell desc.
export function _clusterDwellPoints(points, epsM, minDwellMin) {
  const eps = epsM || LEARN_CLUSTER_EPS_M;
  const minDwell = minDwellMin || LEARN_CLUSTER_MIN_DWELL_MIN;
  if (!points || !points.length) return [];
  const used = new Array(points.length).fill(false);
  const clusters = [];
  for (let i = 0; i < points.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const members = [i];
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < points.length; j++) {
        if (used[j]) continue;
        for (const mi of members) {
          if (_haversine(points[mi].lat, points[mi].lng, points[j].lat, points[j].lng) <= eps) {
            used[j] = true; members.push(j); changed = true; break;
          }
        }
      }
    }
    const dwellMin = Math.round(members.length * (DWELL_SAMPLE_MS / 60000));
    if (dwellMin < minDwell) continue;
    const cLat = members.reduce((s, idx) => s + points[idx].lat, 0) / members.length;
    const cLng = members.reduce((s, idx) => s + points[idx].lng, 0) / members.length;
    let maxD = 0;
    members.forEach(idx => {
      const d = _haversine(cLat, cLng, points[idx].lat, points[idx].lng);
      if (d > maxD) maxD = d;
    });
    const radiusM = Math.max(SAZ_MIN_RADIUS, Math.min(SAZ_MAX_RADIUS, Math.ceil((maxD + 30) / 10) * 10));
    clusters.push({ lat: cLat, lng: cLng, radiusM, dwellMin, count: members.length });
  }
  clusters.sort((a, b) => b.dwellMin - a.dwellMin);
  return clusters;
}

// Reverse-geocode helper (Nominatim). Best-effort; silent on failure.
export async function _reverseGeocode(lat, lng) {
  try {
    const url = 'https://nominatim.openstreetmap.org/reverse?format=json&zoom=17&addressdetails=0&lat=' + lat + '&lon=' + lng;
    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) return null;
    const json = await resp.json();
    if (!json || !json.display_name) return null;
    // Trim to the first few comma-separated parts so the suggestion
    // label stays short.
    return json.display_name.split(',').slice(0, 3).join(',').trim();
  } catch(e) { return null; }
}

export async function suggestZonesFromActivity() {
  _loadDwellLog();
  if (_dwellLog.length < 12) { // need ≥1h of samples
    toast(t('Not enough recent activity to suggest zones yet. Keep the app running for a day or two.'));
    return;
  }
  let clusters = _clusterDwellPoints(_dwellLog);
  // Drop clusters that overlap any existing zone (already covered)
  clusters = clusters.filter(c => !_safeZones.some(z => {
    const d = _haversine(z.lat, z.lng, c.lat, c.lng);
    return d < (z.radiusM + c.radiusM);
  }));
  if (!clusters.length) {
    toast(t('No new dwell locations found outside your current zones.'));
    return;
  }
  toast(t('Looking up places…'));
  // Reverse-geocode sequentially to respect Nominatim rate limit
  for (const c of clusters.slice(0, 5)) {
    c.label = await _reverseGeocode(c.lat, c.lng);
    await new Promise(r => setTimeout(r, 1100));
  }
  _renderSuggestedZonesList(clusters.slice(0, 5));
}

export function _renderSuggestedZonesList(clusters) {
  document.querySelector('.saz-suggest-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'med-editor-modal saz-suggest-modal';
  const rows = clusters.map((c, i) => {
    const title = c.label || (c.lat.toFixed(5) + ', ' + c.lng.toFixed(5));
    const hours = Math.floor(c.dwellMin / 60);
    const mins = c.dwellMin % 60;
    const dwellTxt = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
    return `
      <div class="pm-item" data-idx="${i}" style="align-items:flex-start">
        <span style="font-size:1.1rem;padding-top:3px">✨</span>
        <div style="flex:1;min-width:0">
          <div class="pm-item-name">${escHtml(title)}</div>
          <div class="pm-item-desc">${dwellTxt} ${t('dwell')} · ~${c.radiusM}${t('m')} ${t('radius')}</div>
        </div>
        <span class="pm-item-status">→</span>
      </div>`;
  }).join('');
  modal.innerHTML = `
    <div class="med-editor-card">
      <div class="me-title">✨ ${t('Suggested zones')}</div>
      <div class="me-hint" style="margin-bottom:10px">${t('Places you\'ve spent significant time in the last week. Tap one to add as a zone.')}</div>
      <div>${rows}</div>
      <div class="me-buttons">
        <button class="me-btn-secondary" onclick="this.closest('.saz-suggest-modal').remove()">${t('Close')}</button>
      </div>
    </div>`;
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
  modal.querySelectorAll('.pm-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx, 10);
      const c = clusters[idx];
      if (!c) return;
      modal.remove();
      // Pre-fill the editor with the cluster centroid + suggested radius
      _sazDraft = {
        id: _zoneId(),
        label: (c.label || '').split(',')[0].trim() || t('Suggested zone'),
        lat: c.lat, lng: c.lng, radiusM: c.radiusM,
        dwellSec: SAZ_DEFAULT_DWELL_SEC,
        enabled: true, isHome: false,
        setAt: null, createdBy: 'learned',
      };
      _sazRenderEditor();
    });
  });
}

// ── Companion / snooze mode ─────────────────────────────────
// Patient-initiated: "I'm out with my daughter — don't page
// carers while I'm away." Stored as an expiry timestamp; all
// exit-alert logic is suppressed until it passes. Arrival +
// in/out state tracking continue so the carer log still
// receives the arrival event on return.
export let _zoneSnoozeUntil = 0;
export function _zoneSnoozeActive() { return _zoneSnoozeUntil > Date.now(); }
export function _loadZoneSnooze() {
  try { _zoneSnoozeUntil = parseInt(localStorage.getItem('carecall_zone_snooze') || '0', 10) || 0; }
  catch(e) { _zoneSnoozeUntil = 0; }
}
export function _saveZoneSnooze() {
  if (_zoneSnoozeUntil > Date.now()) localStorage.setItem('carecall_zone_snooze', String(_zoneSnoozeUntil));
  else localStorage.removeItem('carecall_zone_snooze');
}
export function snoozeZoneAlerts(minutes) {
  if (!minutes || minutes <= 0) { _zoneSnoozeUntil = 0; _saveZoneSnooze(); _refreshPatientZonePill(); toast(t('Safe Zone alerts resumed')); return; }
  _zoneSnoozeUntil = Date.now() + minutes * 60 * 1000;
  _saveZoneSnooze();
  _logZoneEvent({ event: 'snooze_start', minutes, ts: Date.now() });
  _refreshPatientZonePill();
  const until = new Date(_zoneSnoozeUntil);
  toast(t('Alerts muted until') + ' ' + until.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
}

export function openZoneSnoozeSheet() {
  document.querySelector('.zone-snooze-sheet')?.remove();
  const sheet = document.createElement('div');
  sheet.className = 'photo-chooser-sheet zone-snooze-sheet';
  const active = _zoneSnoozeActive();
  const until = active ? new Date(_zoneSnoozeUntil) : null;
  const untilTxt = active ? t('Currently muted until') + ' ' + until.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
  sheet.innerHTML = `
    <div class="pcs-backdrop"></div>
    <div class="pcs-card">
      <div class="pcs-title">👥 ${t('Out with someone?')}</div>
      <div style="font-size:0.78rem;color:#94A3B8;text-align:center;margin-bottom:4px;line-height:1.4">
        ${t('Mute Safe Zone alerts while a trusted person is with you. Arrivals home are still logged.')}
      </div>
      ${active ? `<div style="font-size:0.75rem;color:#FBBF24;text-align:center">${untilTxt}</div>` : ''}
      <button type="button" class="pcs-btn" onclick="snoozeZoneAlerts(30);_closeZoneSnoozeSheet()">30 ${t('min')}</button>
      <button type="button" class="pcs-btn" onclick="snoozeZoneAlerts(60);_closeZoneSnoozeSheet()">1 ${t('hour')}</button>
      <button type="button" class="pcs-btn" onclick="snoozeZoneAlerts(120);_closeZoneSnoozeSheet()">2 ${t('hours')}</button>
      <button type="button" class="pcs-btn" onclick="snoozeZoneAlerts(240);_closeZoneSnoozeSheet()">4 ${t('hours')}</button>
      ${active ? `<button type="button" class="pcs-btn" style="background:rgba(239,68,68,0.14);color:#F87171" onclick="snoozeZoneAlerts(0);_closeZoneSnoozeSheet()">${t('Resume alerts now')}</button>` : ''}
      <button type="button" class="pcs-btn pcs-cancel" onclick="_closeZoneSnoozeSheet()">${t('Cancel')}</button>
    </div>`;
  sheet.querySelector('.pcs-backdrop').addEventListener('click', _closeZoneSnoozeSheet);
  document.body.appendChild(sheet);
}
export function _closeZoneSnoozeSheet() { document.querySelector('.zone-snooze-sheet')?.remove(); }

export function _zoneId() { return 'sz_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }

export function _migrateZone(z) {
  if (!z || typeof z !== 'object') return null;
  const migrated = {
    id: z.id || _zoneId(),
    label: z.label || 'Home',
    lat: Number(z.lat), lng: Number(z.lng),
    radiusM: Math.min(SAZ_MAX_RADIUS, Math.max(SAZ_MIN_RADIUS, Number(z.radiusM) || SAZ_DEFAULT_RADIUS)),
    dwellSec: Number.isFinite(z.dwellSec) ? z.dwellSec : SAZ_DEFAULT_DWELL_SEC,
    enabled: z.enabled !== false,
    isHome: z.isHome === true,
    setAt: z.setAt || Date.now(),
    createdBy: z.createdBy || 'patient',
  };
  if (!isFinite(migrated.lat) || !isFinite(migrated.lng)) return null;
  return migrated;
}

export function _loadSafeZones() {
  // v2: array of zones under 'carecall_safezones'
  try {
    const raw = JSON.parse(localStorage.getItem('carecall_safezones') || 'null');
    if (Array.isArray(raw)) {
      _safeZones = raw.map(_migrateZone).filter(Boolean);
    } else {
      _safeZones = [];
    }
  } catch(e) { _safeZones = []; }
  // v1: migrate legacy single _geoFence into zones array
  if (_safeZones.length === 0) {
    try {
      const legacy = JSON.parse(localStorage.getItem('carecall_geofence') || 'null');
      if (legacy) {
        const z = _migrateZone({ ...legacy, label: legacy.label || 'Home', isHome: true });
        if (z) _safeZones = [z];
      }
    } catch(e) {}
  }
  // Ensure at most one home flag
  let homeSeen = false;
  _safeZones.forEach(z => { if (z.isHome) { if (homeSeen) z.isHome = false; else homeSeen = true; } });
  if (!homeSeen && _safeZones.length) _safeZones[0].isHome = true;
  _geoFence = _safeZones.find(z => z.isHome) || null;
}

export function _saveSafeZones() {
  localStorage.setItem('carecall_safezones', JSON.stringify(_safeZones));
  if (S.uid) db.ref(`carecall/users/${S.uid}/safeZones`).set(_safeZones);
  // Also write legacy key for older clients / easier rollback
  _geoFence = _safeZones.find(z => z.isHome) || null;
  if (_geoFence) localStorage.setItem('carecall_geofence', JSON.stringify(_geoFence));
  else localStorage.removeItem('carecall_geofence');
}

// Legacy aliases — other parts of the app still call _loadGeoFence
export function _loadGeoFence() { _loadSafeZones(); }
export function _saveGeoFence() { _saveSafeZones(); }

export function _haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Settings summary / button state ─────────────────────────
export function _refreshSafeZoneButton() {
  const btn = document.getElementById('s-geofence-btn');
  const sum = document.getElementById('s-geofence-summary');
  if (!btn) return;
  const enabled = _safeZones.filter(z => z.enabled);
  if (enabled.length === 0) {
    btn.textContent = _safeZones.length ? t('Edit') : t('Set');
    btn.style.color = _safeZones.length ? '#6889A5' : '';
    if (sum) sum.textContent = _safeZones.length
      ? t('Paused — tap to enable')
      : t('Alert carers if patient leaves home area');
  } else if (enabled.length === 1) {
    btn.textContent = t('Edit');
    btn.style.color = '';
    if (sum) sum.textContent = t('{n} active').replace('{n}', 1) + ' — ' + String(enabled[0].label ?? '') + ' (' + enabled[0].radiusM + t('m') + ')';
  } else {
    btn.textContent = t('Edit');
    btn.style.color = '';
    if (sum) sum.textContent = t('{n} active').replace('{n}', enabled.length) + ' — ' + enabled.map(z => z.label).join(', ');
  }
}

// ── Zones list modal ────────────────────────────────────────
export function openSafeZoneEditor() {
  // First click from Settings lands here. Shows the zones list if
  // any exist, otherwise jumps straight into the editor for a new
  // home zone (minimises friction for first-time setup).
  if (_safeZones.length === 0) {
    openSafeZoneDetailEditor(null, { asHome: true });
  } else {
    _renderZonesList();
  }
}

export function _renderZonesList() {
  document.querySelector('.saz-list-modal')?.remove();
  document.querySelector('.saz-editor-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'med-editor-modal saz-list-modal';
  const zonesHtml = _safeZones.map(z => {
    const statusCls = z.enabled ? '' : ' off';
    const statusText = z.enabled ? t('On') : t('Off');
    const homeBadge = z.isHome ? `<span class="pm-item-refill" style="background:rgba(14,165,233,0.15);color:var(--carer-primary);margin-left:6px">🏠 ${t('Home')}</span>` : '';
    return `
      <div class="pm-item" data-zoneid="${escHtml(z.id)}" style="opacity:${z.enabled?1:0.55}">
        <span style="font-size:1.1rem">📍</span>
        <div style="flex:1;min-width:0">
          <div class="pm-item-name">${escHtml(z.label)}${homeBadge}</div>
          <div class="pm-item-desc">${z.radiusM}${t('m')} · ${t('dwell')} ${z.dwellSec || SAZ_DEFAULT_DWELL_SEC}s</div>
        </div>
        <span class="pm-item-status${statusCls}">${statusText}</span>
      </div>`;
  }).join('');
  modal.innerHTML = `
    <div class="med-editor-card">
      <div class="me-title">📍 ${t('Safe zones')}</div>
      <div class="me-hint" style="margin-bottom:10px">${t('Tap a zone to edit. Add more for day centre, family member’s home, etc.')}</div>
      <div id="saz-list">${zonesHtml}</div>
      <button class="me-add-time-btn" style="margin-top:10px" id="saz-add-btn">+ ${t('Add zone')}</button>
      <button class="me-add-time-btn" style="margin-top:8px" id="saz-suggest-btn">✨ ${t('Suggest zones from my activity')}</button>
      <div class="me-buttons">
        <button class="me-btn-secondary" id="saz-close-btn">${t('Close')}</button>
      </div>
    </div>`;
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
  modal.querySelector('#saz-close-btn').addEventListener('click', () => modal.remove());
  modal.querySelector('#saz-add-btn').addEventListener('click', () => {
    if (_safeZones.length >= SAZ_MAX_ZONES) { toast(t('Maximum of {n} safe zones').replace('{n}', SAZ_MAX_ZONES)); return; }
    modal.remove();
    openSafeZoneDetailEditor(null);
  });
  modal.querySelector('#saz-suggest-btn').addEventListener('click', () => {
    modal.remove();
    suggestZonesFromActivity();
  });
  modal.querySelectorAll('.pm-item').forEach(el => {
    el.addEventListener('click', () => {
      const zid = el.dataset.zoneid;
      if (!zid) return;
      modal.remove();
      openSafeZoneDetailEditor(zid);
    });
  });
}

// ── Zone editor (single zone at a time) ─────────────────────
export function openSafeZoneDetailEditor(zoneId, opts) {
  document.querySelector('.saz-editor-modal')?.remove();
  document.querySelector('.saz-list-modal')?.remove();
  const existing = zoneId ? _safeZones.find(z => z.id === zoneId) : null;
  const asHome = !!(opts && opts.asHome) || (!existing && _safeZones.length === 0);
  _sazDraft = existing
    ? { ...existing }
    : {
        id: _zoneId(),
        label: asHome ? 'Home' : '',
        lat: null, lng: null,
        radiusM: SAZ_DEFAULT_RADIUS,
        dwellSec: SAZ_DEFAULT_DWELL_SEC,
        enabled: true,
        isHome: asHome,
        setAt: null,
        createdBy: S.role === 'carer' ? 'carer' : 'patient',
      };
  _sazRenderEditor();
}

export function _sazRenderEditor() {
  document.querySelector('.saz-editor-modal')?.remove();
  const d = _sazDraft || {};
  const hasCenter = typeof d.lat === 'number' && typeof d.lng === 'number';
  const modal = document.createElement('div');
  modal.className = 'med-editor-modal saz-editor-modal';
  modal.innerHTML = `
    <div class="med-editor-card">
      <div class="me-title">📍 ${d.id && _safeZones.find(z => z.id === d.id) ? t('Edit safe zone') : t('New safe zone')}</div>
      <div class="me-hint" style="margin-bottom:12px">${t('Carers are alerted when the patient leaves this zone (after a short dwell to avoid false positives). Works while the app is open in the foreground.')}</div>

      <div class="me-section">
        <label class="me-label">${t('Name')}</label>
        <input class="me-input" id="saz-label" value="${escHtml(d.label || '')}" placeholder="${t('e.g. Home, Day Centre, Daughter’s')}" maxlength="40" autocomplete="off">
      </div>

      <div class="me-section">
        <label class="me-label">${t('Center point')}</label>
        <div id="saz-center-box" style="background:rgba(255,255,255,0.04);border:1.5px solid #1F2F42;border-radius:10px;padding:10px 12px;font-size:0.85rem;color:#F1F5F9">
          ${hasCenter
            ? `<div><strong>${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}</strong></div>
               <div style="font-size:0.72rem;color:#6889A5;margin-top:2px">${t('Coordinates captured')}</div>`
            : `<div style="color:#6889A5">${t('Not set yet')}</div>`}
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button type="button" class="me-add-time-btn" style="flex:1" onclick="_sazUseCurrentLocation()">📍 ${hasCenter ? t('Update with current location') : t('Use my current location')}</button>
          ${hasCenter ? `<button type="button" class="qr-scan-btn" onclick="_sazOpenInMaps()" style="flex:0 0 auto">🗺️ ${t('View')}</button>` : ''}
        </div>
        <div id="saz-center-err" class="ix-unknown" style="display:none;margin-top:8px;background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.3);color:#F87171"></div>
        <!-- Map picker: tap to move the centre, drag marker to fine-tune. Radius slider below resizes the circle live. -->
        <div id="saz-map" style="margin-top:10px"></div>
        <div style="font-size:0.72rem;color:#6889A5;margin-top:6px">${t('Tap the map to set centre, drag the marker to adjust.')}</div>
      </div>

      <div class="me-section">
        <label class="me-label">${t('Radius')}: <span id="saz-radius-label">${d.radiusM}${t('m')}</span></label>
        <input type="range" id="saz-radius-slider" min="${SAZ_MIN_RADIUS}" max="${SAZ_MAX_RADIUS}" step="25" value="${d.radiusM}" style="width:100%;accent-color:var(--carer-primary)">
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
          <input class="me-input" id="saz-radius-num" type="number" min="${SAZ_MIN_RADIUS}" max="${SAZ_MAX_RADIUS}" value="${d.radiusM}" style="flex:0 0 120px">
          <span style="font-size:0.78rem;color:#6889A5">${t('metres')} (${SAZ_MIN_RADIUS}–${SAZ_MAX_RADIUS})</span>
        </div>
      </div>

      <div class="me-section">
        <label class="me-label">${t('Current distance')}</label>
        <div id="saz-live-dist" style="background:rgba(255,255,255,0.04);border:1.5px solid #1F2F42;border-radius:10px;padding:10px 12px;font-size:0.88rem;color:#F1F5F9">
          ${hasCenter ? t('Measuring…') : t('Set a center first')}
        </div>
      </div>

      <div class="me-section">
        <label class="me-label">${t('Exit dwell time')}</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input class="me-input" id="saz-dwell-num" type="number" min="0" max="600" step="15" value="${d.dwellSec}" style="flex:0 0 110px">
          <span style="font-size:0.78rem;color:#6889A5">${t('seconds outside before alert (0 = instant)')}</span>
        </div>
      </div>

      <div class="me-toggle-row" style="display:flex;justify-content:space-between;align-items:center;padding:6px 2px">
        <div>
          <div style="font-size:0.85rem;color:#F1F5F9">${t('Monitoring enabled')}</div>
          <div style="font-size:0.72rem;color:#6889A5">${t('Turn off to pause alerts without deleting the zone')}</div>
        </div>
        <label style="cursor:pointer"><input type="checkbox" id="saz-enabled" ${d.enabled ? 'checked' : ''} style="transform:scale(1.2)"></label>
      </div>

      <div class="me-toggle-row" style="display:flex;justify-content:space-between;align-items:center;padding:6px 2px">
        <div>
          <div style="font-size:0.85rem;color:#F1F5F9">${t('Primary home')}</div>
          <div style="font-size:0.72rem;color:#6889A5">${t('Used for the “You’re home” indicator')}</div>
        </div>
        <label style="cursor:pointer"><input type="checkbox" id="saz-ishome" ${d.isHome ? 'checked' : ''} style="transform:scale(1.2)"></label>
      </div>

      <div class="me-buttons">
        <button class="me-btn-primary" onclick="_sazSave()">${t('Save')}</button>
        <button class="me-btn-secondary" onclick="_sazCloseEditor()">${t('Cancel')}</button>
      </div>
      ${_safeZones.find(z => z.id === d.id) ? `<button class="me-btn-danger" onclick="_sazRemove()">${t('Remove this zone')}</button>` : ''}
    </div>
  `;
  modal.onclick = e => { if (e.target === modal) _sazCloseEditor(); };
  document.body.appendChild(modal);

  // Keep slider and numeric input in sync
  const slider = document.getElementById('saz-radius-slider');
  const num = document.getElementById('saz-radius-num');
  const label = document.getElementById('saz-radius-label');
  const onRadiusChange = v => {
    const n = Math.min(SAZ_MAX_RADIUS, Math.max(SAZ_MIN_RADIUS, parseInt(v, 10) || SAZ_DEFAULT_RADIUS));
    if (_sazDraft) _sazDraft.radiusM = n;
    if (slider) slider.value = n;
    if (num) num.value = n;
    if (label) label.textContent = n + t('m');
    _sazUpdateLiveDistanceText(); // recompute in/out status against new radius
    _sazUpdateMapRadius(n);
  };
  if (slider) slider.addEventListener('input', e => onRadiusChange(e.target.value));
  if (num) num.addEventListener('change', e => onRadiusChange(e.target.value));

  _sazStartLiveDistance();
  // Initialise the map after the modal has laid out so Leaflet gets
  // correct container dimensions.
  requestAnimationFrame(() => requestAnimationFrame(_sazInitMap));
}

// ── Leaflet map picker (lazy-init so the editor layout is settled) ──
export let _sazMap = null, _sazMarker = null, _sazCircle = null, _sazLiveMarker = null;
export async function _sazInitMap() {
  const container = document.getElementById('saz-map');
  if (!container) return;
  // Lazy-load Leaflet on first use
  if (typeof L === 'undefined') {
    try {
      container.innerHTML = '<div style="text-align:center;padding:24px;color:#6889A5">Loading map…</div>';
      await loadCSS('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
      await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
    } catch(e) {
      container.innerHTML = '<div style="text-align:center;padding:24px;color:#F87171">Failed to load map library</div>';
      console.warn('[Leaflet] lazy-load failed:', e);
      return;
    }
    if (typeof L === 'undefined') return;
  }
  try { if (_sazMap) { _sazMap.remove(); _sazMap = null; _sazMarker = null; _sazCircle = null; _sazLiveMarker = null; } } catch(_) {}
  const d = _sazDraft || {};
  const hasCenter = typeof d.lat === 'number' && typeof d.lng === 'number';
  const defaultCenter = [31.78, 35.22]; // Jerusalem-ish fallback; any is fine
  const view = hasCenter ? [d.lat, d.lng] : defaultCenter;
  _sazMap = L.map(container, { zoomControl: true, attributionControl: true }).setView(view, hasCenter ? 16 : 5);
  // Tile layer: CARTO Voyager renders English/Latin labels globally. The
  // default OSM tileserver renders labels in each tile's local language,
  // which for Israel defaults to Arabic on many tiles even when the user
  // speaks Hebrew. Voyager is a stable, free, no-API-key raster layer
  // with attribution "© OpenStreetMap © CARTO".
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '© OpenStreetMap © CARTO',
  }).addTo(_sazMap);

  const placeOrMoveMarker = (latlng) => {
    if (!_sazMarker) {
      _sazMarker = L.marker(latlng, { draggable: true }).addTo(_sazMap);
      _sazMarker.on('drag', () => {
        const ll = _sazMarker.getLatLng();
        _sazDraft.lat = ll.lat; _sazDraft.lng = ll.lng;
        if (_sazCircle) _sazCircle.setLatLng(ll);
        _sazUpdateCenterText();
      });
    } else {
      _sazMarker.setLatLng(latlng);
    }
    if (!_sazCircle) {
      _sazCircle = L.circle(latlng, {
        radius: _sazDraft.radiusM, color: '#0EA5E9',
        fillColor: '#0EA5E9', fillOpacity: 0.12, weight: 2,
      }).addTo(_sazMap);
    } else {
      _sazCircle.setLatLng(latlng);
    }
  };
  if (hasCenter) placeOrMoveMarker([d.lat, d.lng]);
  _sazMap.on('click', e => {
    _sazDraft.lat = e.latlng.lat; _sazDraft.lng = e.latlng.lng;
    placeOrMoveMarker(e.latlng);
    _sazUpdateCenterText();
  });
  // Sometimes the map measures 0x0 before the modal has painted —
  // invalidate once layout settles to force a proper tile load.
  setTimeout(() => { try { _sazMap && _sazMap.invalidateSize(); } catch(_) {} }, 200);
}

export function _sazUpdateMapRadius(radiusM) {
  if (_sazCircle) { try { _sazCircle.setRadius(radiusM); } catch(_) {} }
}

export function _sazUpdateLiveMarker(lat, lng) {
  if (!_sazMap) return;
  const ll = [lat, lng];
  if (!_sazLiveMarker) {
    _sazLiveMarker = L.circleMarker(ll, {
      radius: 6, color: '#10B981', fillColor: '#10B981', fillOpacity: 0.95, weight: 2,
    }).addTo(_sazMap).bindTooltip(t('You'), { direction: 'top', offset: [0, -8] });
  } else {
    _sazLiveMarker.setLatLng(ll);
  }
}

export function _sazUpdateCenterText() {
  const box = document.getElementById('saz-center-box');
  if (!box || !_sazDraft) return;
  const hasCenter = typeof _sazDraft.lat === 'number' && typeof _sazDraft.lng === 'number';
  box.innerHTML = hasCenter
    ? `<div><strong>${_sazDraft.lat.toFixed(5)}, ${_sazDraft.lng.toFixed(5)}</strong></div>
       <div style="font-size:0.72rem;color:#6889A5;margin-top:2px">${t('Coordinates captured')}</div>`
    : `<div style="color:#6889A5">${t('Not set yet')}</div>`;
  _sazUpdateLiveDistanceText();
}

export function _sazStartLiveDistance() {
  _sazStopLiveDistance();
  if (!navigator.geolocation) return;
  try {
    _sazLiveWatchId = navigator.geolocation.watchPosition(
      pos => {
        _sazLastPos = pos;
        _sazUpdateLiveDistanceText();
        _sazUpdateLiveMarker(pos.coords.latitude, pos.coords.longitude);
      },
      err => {
        const el = document.getElementById('saz-live-dist');
        if (el) el.textContent = t('Location unavailable') + ' (' + (err.message || 'error') + ')';
      },
      SAZ_WATCH_OPTS
    );
  } catch(e) {
    const el = document.getElementById('saz-live-dist');
    if (el) el.textContent = t('Location unavailable');
  }
}
export function _sazStopLiveDistance() {
  if (_sazLiveWatchId && navigator.geolocation) {
    try { navigator.geolocation.clearWatch(_sazLiveWatchId); } catch(_) {}
  }
  _sazLiveWatchId = null;
}
export function _sazUpdateLiveDistanceText() {
  const el = document.getElementById('saz-live-dist');
  if (!el || !_sazDraft) return;
  if (typeof _sazDraft.lat !== 'number' || typeof _sazDraft.lng !== 'number') {
    el.textContent = t('Set a center first'); return;
  }
  if (!_sazLastPos) { el.textContent = t('Measuring…'); return; }
  const dist = Math.round(_haversine(_sazDraft.lat, _sazDraft.lng, _sazLastPos.coords.latitude, _sazLastPos.coords.longitude));
  const inside = dist <= _sazDraft.radiusM;
  el.innerHTML = inside
    ? `<span style="color:#34D399">✓ ${t('Inside safe zone')}</span> &nbsp; <span style="color:#94A3B8">(${dist}${t('m')} ${t('from centre')})</span>`
    : `<span style="color:#F87171">⚠ ${t('Outside safe zone')}</span> &nbsp; <span style="color:#94A3B8">(${dist}${t('m')} ${t('from centre')})</span>`;
}

export async function _sazUseCurrentLocation() {
  const errBox = document.getElementById('saz-center-err');
  if (errBox) errBox.style.display = 'none';
  const loc = await Native.getCurrentPosition();
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
    if (errBox) { errBox.style.display = ''; errBox.textContent = t('Could not get location — check permissions and GPS'); }
    return;
  }
  _sazDraft.lat = loc.lat;
  _sazDraft.lng = loc.lng;
  _sazRenderEditor();
}

export function _sazOpenInMaps() {
  if (!_sazDraft || typeof _sazDraft.lat !== 'number') return;
  const url = `https://www.google.com/maps?q=${_sazDraft.lat},${_sazDraft.lng}`;
  window.open(url, '_blank');
}

export function _sazCloseEditor() {
  _sazStopLiveDistance();
  try { if (_sazMap) { _sazMap.remove(); } } catch(_) {}
  _sazMap = null; _sazMarker = null; _sazCircle = null; _sazLiveMarker = null;
  document.querySelector('.saz-editor-modal')?.remove();
  _sazDraft = null;
}

export function _sazSave() {
  const d = _sazDraft;
  if (!d) return;
  const labelEl = document.getElementById('saz-label');
  const label = (labelEl && labelEl.value || '').trim();
  if (!label) { toast(t('Enter a name for this zone')); return; }
  if (typeof d.lat !== 'number' || typeof d.lng !== 'number' || isNaN(d.lat) || isNaN(d.lng)) {
    toast(t('Set a center point first.')); return;
  }
  if (!(d.radiusM >= SAZ_MIN_RADIUS && d.radiusM <= SAZ_MAX_RADIUS)) {
    toast(t('Radius must be between {min} and {max} metres').replace('{min}', SAZ_MIN_RADIUS).replace('{max}', SAZ_MAX_RADIUS));
    return;
  }
  const dwellEl = document.getElementById('saz-dwell-num');
  const dwellSec = Math.min(600, Math.max(0, parseInt(dwellEl && dwellEl.value, 10) || 0));
  const enabled = !!(document.getElementById('saz-enabled') || {}).checked;
  const isHome = !!(document.getElementById('saz-ishome') || {}).checked;

  // Upsert into the zones list. If this is a new home, demote any
  // previous home so we always have at most one.
  const idx = _safeZones.findIndex(z => z.id === d.id);
  const record = {
    id: d.id, label, lat: d.lat, lng: d.lng, radiusM: d.radiusM,
    dwellSec, enabled, isHome,
    setAt: Date.now(),
    createdBy: d.createdBy || (S.role === 'carer' ? 'carer' : 'patient'),
  };
  if (idx >= 0) _safeZones[idx] = record;
  else _safeZones.push(record);
  if (isHome) _safeZones.forEach(z => { if (z.id !== record.id) z.isHome = false; });
  // Need at least one home if any zones exist
  if (!_safeZones.some(z => z.isHome) && _safeZones.length) _safeZones[0].isHome = true;

  _saveSafeZones();
  _stopGeoFenceWatch();
  _zoneRuntime = {}; // reset per-zone state
  _startGeoFenceWatch();
  _sazCloseEditor();
  _refreshSafeZoneButton();
  toast(enabled ? t('Safe zone saved') : t('Safe zone saved (monitoring paused)'));
}

export function _sazRemove() {
  const d = _sazDraft;
  if (!d || !_safeZones.find(z => z.id === d.id)) return;
  if (!confirm(t('Remove this safe zone? You can always add it again later.'))) return;
  _safeZones = _safeZones.filter(z => z.id !== d.id);
  if (!_safeZones.some(z => z.isHome) && _safeZones.length) _safeZones[0].isHome = true;
  delete _zoneRuntime[d.id];
  _saveSafeZones();
  _stopGeoFenceWatch();
  if (_safeZones.some(z => z.enabled)) _startGeoFenceWatch();
  _sazCloseEditor();
  _refreshSafeZoneButton();
  toast(t('Safe zone removed'));
}

// Back-compat entry points.
export function setHomeLocation() { openSafeZoneEditor(); }
export function clearGeoFence() { /* retained for any external caller; no-op */ }

// ── Monitoring ──────────────────────────────────────────────
// Now routed through Native.startBackgroundLocationWatch so that on
// native Android a foreground-service watcher keeps running when the
// screen locks / app backgrounds — previously the web watchPosition
// paused the moment the app lost focus, which made the feature
// close-to-useless for its main clinical purpose.
export let _geoWatchActive = false;

export async function _stopGeoFenceWatch() {
  await Native.stopBackgroundLocationWatch();
  _geoWatchActive = false;
  _geoWatchId = null; // legacy field, kept for any external readers
}

export async function _startGeoFenceWatch() {
  if (S.role !== 'patient') return;
  if (!_safeZones.some(z => z.enabled)) return;
  if (_geoWatchActive) return;
  _geoWatchActive = true;
  const kind = await Native.startBackgroundLocationWatch(
    loc => _zoneTick(loc.lat, loc.lng, loc.accuracy),
    err => {
      const msg = (err && err.message) || '';
      console.warn('[safe-zone] location error:', err, msg);
      // Well-known Android codes from the community plugin:
      if (err && (err.code === 'NOT_AUTHORIZED' || /permission|denied/i.test(msg))) {
        toast(t('Safe Zone needs background location permission'));
      }
    }
  );
  if (!kind) { _geoWatchActive = false; console.warn('[safe-zone] no geolocation source available'); }
  else console.log('[safe-zone] monitoring via', kind);
}

// Main per-position tick: for each enabled zone, update inside/outside
// runtime state, track dwell timers, fire exit / arrival events.
// The "I'm safe" ack modal sits between exit detection and carer alert
// so patients can confirm they're OK (shopping, walking) without paging.
export function _zoneTick(lat, lng, accuracyM) {
  if (S.role !== 'patient') return;
  _recordDwellSample(lat, lng);
  const now = Date.now();
  _safeZones.filter(z => z.enabled).forEach(z => {
    const dist = _haversine(z.lat, z.lng, lat, lng);
    const inside = dist <= z.radiusM;
    let rt = _zoneRuntime[z.id];
    if (!rt) rt = _zoneRuntime[z.id] = { insideSince: null, outsideSince: null, lastAlertAt: 0, ackPending: false };
    if (inside) {
      // Arrival: was outside → now inside
      if (rt.outsideSince !== null || rt.lastAlertAt) {
        // Only fire arrival if we had previously alerted the carer about an exit
        if (rt.lastAlertAt) _onZoneArrival(z);
        rt.outsideSince = null;
        rt.lastAlertAt = 0;
        rt.ackPending = false;
        if (rt.armTimer) { clearTimeout(rt.armTimer); rt.armTimer = null; }
      }
      if (!rt.insideSince) rt.insideSince = now;
      _refreshPatientZonePill();
    } else {
      rt.insideSince = null;
      if (!rt.outsideSince) rt.outsideSince = now;
      const dwellMs = (z.dwellSec || 0) * 1000;
      const elapsed = now - rt.outsideSince;
      // Suppress ack prompt + carer alert while the patient is in
      // companion snooze. In/out state tracking continues so the
      // arrival event still fires on return.
      if (!_zoneSnoozeActive() && elapsed >= dwellMs && !rt.ackPending && (now - rt.lastAlertAt) > SAZ_ALERT_COOLDOWN_MS) {
        rt.ackPending = true;
        _showZoneAckPrompt(z, Math.round(dist));
      }
      _refreshPatientZonePill(z, Math.round(dist));
    }
  });
}

// Patient-facing "quiet confidence" pill at the top of s-patient.
// Shows "🟢 You're at Home" when inside the primary home, otherwise a
// soft reminder of the zone they've left and how far. Tappable —
// opens the companion-snooze sheet.
export function _refreshPatientZonePill(exitZone, distM) {
  const el = document.getElementById('patient-zone-pill');
  if (!el) return;
  if (!_safeZones.some(z => z.enabled)) { el.style.display = 'none'; return; }
  el.style.cursor = 'pointer';
  el.onclick = openZoneSnoozeSheet;
  if (_zoneSnoozeActive()) {
    const until = new Date(_zoneSnoozeUntil);
    el.style.display = '';
    el.className = 'patient-zone-pill neutral';
    el.textContent = '💤 ' + t('Alerts muted until') + ' ' + until.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return;
  }
  const home = _safeZones.find(z => z.isHome && z.enabled);
  const insideHome = home && _zoneRuntime[home.id] && _zoneRuntime[home.id].insideSince;
  if (insideHome) {
    el.style.display = '';
    el.className = 'patient-zone-pill home';
    el.textContent = '🟢 ' + t("You're at") + ' ' + home.label;
    return;
  }
  if (exitZone) {
    el.style.display = '';
    el.className = 'patient-zone-pill outside';
    el.textContent = '📍 ' + t('Outside') + ' ' + exitZone.label + ' · ' + distM + t('m');
    return;
  }
  el.style.display = '';
  el.className = 'patient-zone-pill neutral';
  el.textContent = '📍 ' + t('Measuring…');
}

// ── "I'm safe" ack modal ────────────────────────────────────
// After the dwell timer expires we DON'T page the carer yet — we ask the
// patient if everything is OK. If they tap "I'm safe", the exit event is
// logged locally but no call fires. If they don't respond within
// SAZ_ACK_WINDOW_MS, the carer is alerted.
export let _zoneAckTimer = null;
export function _showZoneAckPrompt(zone, distM) {
  document.querySelector('.zone-ack-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'zone-ack-modal';
  modal.innerHTML = `
    <div class="zone-ack-card">
      <div class="zone-ack-icon">🚶</div>
      <div class="zone-ack-title">${t('Everything OK?')}</div>
      <div class="zone-ack-sub">${t("You've left")} <strong>${escHtml(zone.label)}</strong> · ${distM}${t('m')} ${t('away')}</div>
      <div class="zone-ack-countdown" id="zone-ack-countdown"></div>
      <div class="zone-ack-btns">
        <button class="checkin-ok-btn" onclick="_respondZoneAck('safe')">${t("I'm safe ✓")}</button>
        <button class="checkin-help-btn" onclick="_respondZoneAck('alert')">${t('Alert carer now')}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  let remaining = Math.ceil(SAZ_ACK_WINDOW_MS / 1000);
  const cdEl = document.getElementById('zone-ack-countdown');
  if (cdEl) cdEl.textContent = t('Carer alerted in') + ' ' + formatDuration(remaining * 1000);
  _unregisterTick('zoneAckCountdown');
  _registerTick('zoneAckCountdown', () => {
    remaining--;
    if (remaining <= 0) {
      _unregisterTick('zoneAckCountdown');
      _respondZoneAck('timeout', zone, distM);
    } else if (cdEl) {
      cdEl.textContent = t('Carer alerted in') + ' ' + formatDuration(remaining * 1000);
    }
  });
  // Stash context for response handler
  modal.dataset.zoneId = zone.id;
  modal.dataset.distM = distM;
}

export async function _respondZoneAck(response, zoneArg, distArg) {
  const modal = document.querySelector('.zone-ack-modal');
  const zoneId = zoneArg ? zoneArg.id : modal && modal.dataset.zoneId;
  const distM = distArg != null ? distArg : (modal && Number(modal.dataset.distM) || 0);
  const zone = _safeZones.find(z => z.id === zoneId);
  _unregisterTick('zoneAckCountdown');
  if (modal) modal.remove();
  if (!zone) return;
  const rt = _zoneRuntime[zone.id] || (_zoneRuntime[zone.id] = {});
  rt.ackPending = false;
  if (response === 'safe') {
    _logZoneEvent({ zoneId: zone.id, label: zone.label, event: 'safe_ack', distM, ts: Date.now() });
    toast(t('Thanks — carer will not be alerted'));
    return;
  }
  // alert OR timeout → fire the carer alert
  rt.lastAlertAt = Date.now();
  _logZoneEvent({ zoneId: zone.id, label: zone.label, event: 'exit_alert', distM, ts: Date.now() });
  await _fireZoneExitCall(zone, distM);
  toast(t('Carers alerted — you left the safe zone'));
}

export async function _fireZoneExitCall(zone, distM) {
  const callData = {
    fromUid: S.uid, fromName: S.name, avatar: S.avatar || '',
    type: 'help',
    message: t('Left safe zone') + ' — ' + zone.label + ' · ' + Math.round(distM) + t('m') + ' ' + t('from centre'),
    timestamp: firebase.database.ServerValue.TIMESTAMP, status: 'active',
  };
  await _attachLocation(callData);
  for (const room of S.rooms) {
    if (!room) continue;
    const ref = db.ref(`carecall/rooms/${room}/calls`).push();
    await ref.set({ ...callData, id: ref.key });
  }
}

export async function _onZoneArrival(zone) {
  _logZoneEvent({ zoneId: zone.id, label: zone.label, event: 'arrival', ts: Date.now() });
  toast('🏠 ' + t("Arrived at") + ' ' + zone.label);
  // A quiet info-level entry in the carer's call log — no FCM push
  // (type 'help' would be loud). Use a distinct type the carer log can
  // render without waking the phone.
  const data = {
    fromUid: S.uid, fromName: S.name, avatar: S.avatar || '',
    type: 'zone-arrival', message: t('Arrived at') + ' ' + zone.label,
    timestamp: firebase.database.ServerValue.TIMESTAMP, status: 'info',
  };
  for (const room of S.rooms) {
    if (!room) continue;
    try { await db.ref(`carecall/rooms/${room}/calls`).push(data); } catch(_) {}
  }
}

export function _logZoneEvent(ev) {
  _zoneEvents.push(ev);
  if (_zoneEvents.length > SAZ_MAX_EVENTS) _zoneEvents.splice(0, _zoneEvents.length - SAZ_MAX_EVENTS);
  try { localStorage.setItem('carecall_zone_events', JSON.stringify(_zoneEvents)); } catch(_) {}
}
export function _loadZoneEvents() {
  try { _zoneEvents = JSON.parse(localStorage.getItem('carecall_zone_events') || '[]'); }
  catch(e) { _zoneEvents = []; }
}

