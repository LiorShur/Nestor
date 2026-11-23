// ════════════════════════════════════════════════════════════
//  UTILITIES & SHARED HELPERS
// ════════════════════════════════════════════════════════════

export function genCode(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const n = len || 6;
  return Array.from({length: n}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + (s % 60) + 's';
}

export function needLabel(type) {
  const map = { water:'💧 Water', medication:'💊 Medication', food:'🍽️ Food', toilet:'🚽 Toilet', pain:'😣 Pain', custom:'✏️ Message', fall:'🚨 Fall Detected', 'checkin-missed':'⚠️ Missed Check-in', 'checkin-help':'🆘 Check-in Help', 'med-missed':'💊 Missed Medication', 'med-taken':'💊 Medication Taken', 'med-refill':'💊 Refill Needed', 'zone-arrival':'🏠 Arrived Safely', help:'🆘 Help' };
  if (type && type.includes(',')) {
    return type.split(',').map(t => map[t] || escHtml(t)).join(' · ');
  }
  return map[type] || '🆘 Help';
}

export function _haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function _toIsoDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY or DD.MM.YYYY
  const dmy = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (dmy) return dmy[3] + '-' + dmy[2].padStart(2, '0') + '-' + dmy[1].padStart(2, '0');
  // English "Month DD, YYYY"
  const months = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
  const eng = s.match(/^(\w+)\s+(\d{1,2}),?\s*(\d{4})$/);
  if (eng) {
    const mm = months[(eng[1] || '').toLowerCase()];
    if (mm) return eng[3] + '-' + mm + '-' + eng[2].padStart(2, '0');
  }
  return '';
}

export function _telLink(raw) {
  if (!raw) return '';
  const digits = raw.replace(/[^\d+]/g, '');
  return digits.length >= 7 ? 'tel:' + digits : '';
}

export function _parseIntOrNull(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

// Audio
export let audioCtx = null;
export let bellTimer = null;
let _silentNode = null;

export function unlockAudio() {
  if (audioCtx && audioCtx.state === 'running') return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.1, audioCtx.sampleRate);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start();
    if (_silentNode) { try { _silentNode.stop(); } catch(e){} }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.00001;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    _silentNode = osc;
  } catch(e) { console.warn('[Audio] unlock failed:', e); }
}

export async function playBell() {
  try {
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const ctx = audioCtx, t = ctx.currentTime;
    [[880,.75],[1760,.38],[2640,.2],[3520,.1],[4400,.05]].forEach(([f,g]) => {
      const o = ctx.createOscillator(), gn = ctx.createGain();
      o.connect(gn); gn.connect(ctx.destination);
      o.frequency.value = f;
      gn.gain.setValueAtTime(g, t);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
      o.start(t); o.stop(t + 3.2);
    });
    if (navigator.vibrate) navigator.vibrate([500,150,500,150,800]);
  } catch(e) { console.warn('[Audio] playBell failed:', e); }
}
export function startBell() {
  if (bellTimer) clearInterval(bellTimer);
  playBell();
  bellTimer = setInterval(playBell, 3400);
}
export function stopBell() {
  if (bellTimer) { clearInterval(bellTimer); bellTimer = null; }
}
