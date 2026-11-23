// ════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════

export const S = {
  uid:          null,
  name:         null,
  role:         null,    // 'patient' | 'carer' | 'family'
  personalCode: null,    // unique 4-char code for this user
  phone:        null,    // optional phone number for offline fallback
  avatar:       null,    // emoji avatar for visual identification
  rooms:        [],      // array of auto-generated room IDs (hidden from user)
  activeRoom:   null,    // currently displayed room
  prevScreen:   null,
};

// Patient-specific
export const PS = {
  status:      'idle',  // 'idle' | 'calling' | 'acked'
  selectedNeeds: new Set(),  // multi-select set of need types
  activeCallId: null,
  selectedCarerUid: null,    // null = all carers, uid = specific carer
  selectedCarerRoom: null,   // room code for the selected carer
  allCarers: [],             // [{uid, name, online, room}] across all rooms
  roomMembers: {},           // cached members for dropdown/picker
  callListener: null,
};

// Carer-specific
export const CS = {
  activeCalls: {},   // callId -> { data, timerId }
  alertCallId: null,
};

export let _roomsListenerRef = null;
export function _setRoomsListenerRef(ref) { _roomsListenerRef = ref; }

// These are populated by other modules (family, ambient, webrtc, pairing)
export let _familyListenerRefs = [];
export function _setFamilyListenerRefs(refs) { _familyListenerRefs = refs; }
export let _ambientListenerRefs = [];
export function _setAmbientListenerRefs(refs) { _ambientListenerRefs = refs; }
export let _vcListenerRefs = [];
export function _setVcListenerRefs(refs) { _vcListenerRefs = refs; }
export let _pendingPairsRef = null;
export function _setPendingPairsRef(ref) { _pendingPairsRef = ref; }

// Unified listener teardown — prevents Firebase leaks across role switches,
// sign-out, and launchMainScreen re-entry.
export function _teardownAllListeners() {
  if (PS._memberRefs) { PS._memberRefs.forEach(r => { try { r.off(); } catch(_) {} }); PS._memberRefs = []; }
  if (CS._listenerRefs) { CS._listenerRefs.forEach(r => { try { r.off(); } catch(_) {} }); CS._listenerRefs = []; }
  if (_familyListenerRefs) { _familyListenerRefs.forEach(r => { try { r.off(); } catch(_) {} }); _familyListenerRefs = []; }
  if (_ambientListenerRefs) { _ambientListenerRefs.forEach(r => { try { r.off(); } catch(_) {} }); _ambientListenerRefs = []; }
  if (_vcListenerRefs) { _vcListenerRefs.forEach(r => { try { r.off(); } catch(_) {} }); _vcListenerRefs = []; }
  if (_roomsListenerRef) { try { _roomsListenerRef.off(); } catch(_) {} _roomsListenerRef = null; }
  if (_pendingPairsRef) { try { _pendingPairsRef.off(); } catch(_) {} _pendingPairsRef = null; }
}

export function saveState() {
  // Guard: never persist incomplete state — if name or role is missing
  // the next boot's loadState() would discard it, forcing re-setup and
  // creating duplicate rooms.
  if (!S.name || !S.role) {
    console.warn('[saveState] skipped — incomplete state (name=' + S.name + ', role=' + S.role + ')');
    return;
  }
  localStorage.setItem('carecall_v5', JSON.stringify({
    uid:          S.uid,
    name:         S.name,
    role:         S.role,
    personalCode: S.personalCode,
    phone:        S.phone,
    avatar:       S.avatar,
    rooms:        S.rooms,
    activeRoom:   S.activeRoom,
  }));
}

export async function loadState() {
  try {
    // Try v5 first, then migrate from v4
    let d = JSON.parse(localStorage.getItem('carecall_v5') || 'null');
    if (!d) {
      d = JSON.parse(localStorage.getItem('carecall_v4') || 'null');
      if (d) d._migrated = true; // flag for migration in boot()
    }
    const VALID_ROLES = ['patient', 'carer', 'family'];
    if (d && d.uid && d.name && VALID_ROLES.includes(d.role)) {
      Object.assign(S, d);
      console.log('[loadState] restored role=' + d.role);
      return true;
    }
    // If we have a uid but name/role are missing, try recovering from
    // Firebase instead of discarding — this prevents the re-setup loop
    // that creates duplicate rooms.
    if (d && d.uid && (!d.name || !VALID_ROLES.includes(d.role))) {
      console.warn('[loadState] incomplete local state (uid=' + d.uid + '), attempting Firebase recovery…');
      try {
        if (typeof db !== 'undefined' && db) {
          const snap = await db.ref('carecall/users/' + d.uid).once('value');
          const profile = snap.val();
          if (profile && profile.name && VALID_ROLES.includes(profile.role)) {
            d.name = profile.name;
            d.role = profile.role;
            d.personalCode = profile.personalCode || d.personalCode;
            d.rooms = profile.rooms || d.rooms || [];
            d.phone = profile.phone || d.phone || '';
            d.avatar = profile.avatar || d.avatar || '';
            Object.assign(S, d);
            console.log('[loadState] recovered from Firebase: role=' + d.role);
            return true;
          }
        }
      } catch(e) {
        console.warn('[loadState] Firebase recovery failed:', e && e.message);
      }
    }
    if (d) console.warn('[loadState] discarding invalid state', d);
  } catch(e) {}
  return false;
}
