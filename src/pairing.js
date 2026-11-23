// ════════════════════════════════════════════════════════════
//  PAIRING — connection, QR codes, room management
// ════════════════════════════════════════════════════════════
import { S, CS } from './state.js';

export async function setupConnect() {
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  const err  = document.getElementById('room-err');
  if (code.length < 4) { err.textContent = t('Please enter your pair code'); return; }
  err.textContent = '';
  const btn = document.getElementById('room-join-btn');
  const restoreBtn = () => { btn.disabled = false; btn.textContent = t('Connect →'); };
  btn.disabled = true; btn.textContent = t('Connecting…');

  // Guard the whole chain so any thrown promise (permission denied,
  // offline, etc.) surfaces a visible error instead of leaving the
  // button stuck on "Connecting…" indefinitely.
  try {
    await syncUserProfile();
    const result = await connectToCode(code);
    if (result.error) { err.textContent = result.error; restoreBtn(); return; }
    if (result.alreadyConnected) toast(t('Already connected to') + ' ' + result.name);
    else if (result.pending) toast(t('Pair request sent to') + ' ' + result.name + ' — ' + t('waiting for approval'));
    else toast(t('Connected to') + ' ' + result.name + '!');
    await finishSetup();
  } catch(e) {
    console.warn('[setupConnect] failed:', e && e.message);
    err.textContent = t('Could not connect — please try again.');
    restoreBtn();
  }
}

export async function setupSkipConnect() {
  try {
    await syncUserProfile();
    await finishSetup();
  } catch(e) {
    console.warn('[setupSkipConnect] failed:', e && e.message);
    toast(t('Could not connect — please try again.'));
  }
}

export async function finishSetup() {
  if (!S.activeRoom && S.rooms.length) S.activeRoom = S.rooms[0];
  saveState();
  await joinAllRooms();
  launchMainScreen();
  // If the user opened the app via a carecall:// deep link before
  // completing setup, replay that connection now.
  const pendingQr = localStorage.getItem('carecall_pending_qr');
  if (pendingQr) {
    localStorage.removeItem('carecall_pending_qr');
    setTimeout(() => _handleDeepLinkCode(pendingQr), 600);
  }
}

// ════════════════════════════════════════════════════════════
//  FIREBASE PRESENCE & ROOM MEMBERSHIP
// ════════════════════════════════════════════════════════════
export async function joinAllRooms() {
  for (const room of S.rooms) {
    await joinRoom(room);
  }
}

export async function joinRoom(roomCode) {
  const ref = db.ref(`carecall/rooms/${roomCode}/members/${S.uid}`);
  const data = { name: S.name, role: S.role, online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP };
  if (S.phone) data.phone = S.phone;
  if (S.avatar) data.avatar = S.avatar;
  if (S.role === 'carer') data.availability = _carerAvailability || 'available';
  await ref.set(data);
  ref.onDisconnect().update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
}

export async function leaveRoom(roomCode) {
  await db.ref(`carecall/rooms/${roomCode}/members/${S.uid}`).remove();
}

// ── Bilateral connection helpers ──
export async function syncUserProfile() {
  if (!S.uid || !S.name || !S.role || !S.personalCode) return;
  const profile = { personalCode: S.personalCode, name: S.name, role: S.role, rooms: S.rooms };
  if (S.phone) profile.phone = S.phone;
  if (S.avatar) profile.avatar = S.avatar;
  // Profile write — self-only under new rules, always allowed when auth
  // is live. Let a genuine auth failure propagate so callers see it.
  await db.ref(`carecall/users/${S.uid}`).update(profile);
  // codeIndex write may fail with PERMISSION_DENIED if an entry under
  // our personalCode already exists and is owned by a DIFFERENT uid.
  // That happens when a user's auth uid has drifted between installs
  // (pre-Phase-0 anon_ fallback, cleared IndexedDB, etc.) — the code
  // still points at a dead uid that we can no longer claim. Recover
  // by issuing a fresh personalCode instead of leaving the UI stuck.
  try {
    await db.ref(`carecall/codeIndex/${S.personalCode}`).set({ uid: S.uid, name: S.name, role: S.role });
  } catch(e) {
    console.warn('[Profile] codeIndex write blocked for', S.personalCode, '— reissuing.', e && e.message);
    const oldCode = S.personalCode;
    for (let attempts = 0; attempts < 6; attempts++) {
      const fresh = genCode();
      try {
        await db.ref(`carecall/codeIndex/${fresh}`).set({ uid: S.uid, name: S.name, role: S.role });
        S.personalCode = fresh;
        try { await db.ref(`carecall/users/${S.uid}/personalCode`).set(fresh); } catch(e) { console.warn('[syncUserProfile] personalCode update failed:', e && e.message); }
        saveState();
        console.warn('[Profile] personalCode reissued:', oldCode, '→', fresh);
        setTimeout(() => {
          try { toast(t('Your pair code was refreshed:') + ' ' + fresh); } catch(_) {}
        }, 400);
        return;
      } catch(_) { /* collision or denied — try another */ }
    }
    throw new Error('Could not reserve a new pair code after 6 attempts');
  }
}

export async function lookupUserByCode(code) {
  const snap = await db.ref(`carecall/codeIndex/${code}`).once('value');
  return snap.val(); // { uid, name, role } or null
}

export async function findOrCreateRoom(myUid, theirUid) {
  // Check MY existing rooms for one that already contains the other user.
  // Any denial here means I was removed from that room — skip it.
  for (const roomId of S.rooms) {
    try {
      const snap = await db.ref(`carecall/rooms/${roomId}/members/${theirUid}`).once('value');
      if (snap.exists()) return roomId;
    } catch(_) { /* no longer a member — ignore */ }
  }
  // Check THEIR rooms list too. Under Phase 0 rules, users/{uid}/rooms
  // is self-read only, so this read is EXPECTED to be denied — we fall
  // through to creating a new room. (Pre-Phase-0 this tried to avoid
  // duplicate rooms when both sides raced to connect; the pair-approval
  // flow prevents that race structurally, so the optimisation is moot.)
  try {
    const theirRoomsSnap = await db.ref(`carecall/users/${theirUid}/rooms`).once('value');
    const theirRooms = theirRoomsSnap.val() || [];
    for (const roomId of theirRooms) {
      try {
        const snap = await db.ref(`carecall/rooms/${roomId}/members/${myUid}`).once('value');
        if (snap.exists()) return roomId;
      } catch(_) {}
    }
  } catch(_) { /* denied under new rules — expected, fall through */ }
  // Create a new room.
  const roomId = 'r_' + Math.random().toString(36).slice(2, 8) + '_' + Date.now().toString(36);
  await db.ref(`carecall/rooms/${roomId}/created`).set(firebase.database.ServerValue.TIMESTAMP);
  return roomId;
}

// ════════════════════════════════════════════════════════════════════
// PAIRING (v2 — owner-approval required)
//
// The pre-v2 connectToCode() wrote roomId directly into the *target's*
// /users/{theirUid}/rooms list. Combined with wide-open Firebase rules
// that let the attacker brute-force the 4-char codespace to mount
// themselves as a carer on any patient they could guess.
//
// The new flow separates addressing (codeIndex lookup) from pairing
// (owner consent). Typing or scanning a code merely *asks* the target
// to connect; nothing is written to the target's own profile until
// they tap Approve. The server rules enforce this:
//   - users/{uid}/rooms is self-write only
//   - users/{uid}/pendingPairs/{reqId} accepts an initial write whose
//     fromUid matches the caller; thereafter only the target can
//     mutate it (to mark approved / rejected).
// ════════════════════════════════════════════════════════════════════

export let _connectInProgress = false;
export async function connectToCode(code) {
  if (_connectInProgress) return { error: t('Connection in progress…') };
  _connectInProgress = true;
  try { return await _connectToCodeInner(code); } finally { _connectInProgress = false; }
}
export async function _connectToCodeInner(code) {
  const user = await lookupUserByCode(code);
  if (!user) return { error: t('Code not found. Check and try again.') };
  if (user.uid === S.uid) return { error: t("That's your own code!") };
  // Validate role compatibility: patients pair with carers/family, carers/family pair with patients.
  const myConnectsTo = S.role === 'patient' ? ['carer', 'family'] : ['patient'];
  if (!myConnectsTo.includes(user.role)) {
    return { error: t('That code belongs to a different role.') };
  }
  // If already paired (shared room exists), short-circuit.
  for (const roomId of S.rooms) {
    const snap = await db.ref(`carecall/rooms/${roomId}/members/${user.uid}`).once('value');
    if (snap.exists()) return { ok: true, name: user.name, alreadyConnected: true };
  }
  // De-dupe: if I already have a pending request to this person, reuse it
  // instead of piling up in their inbox.
  const sentSnap = await db.ref(`carecall/users/${S.uid}/sentPairs`).once('value');
  const sent = sentSnap.val() || {};
  for (const reqId of Object.keys(sent)) {
    const r = sent[reqId];
    if (r && r.toUid === user.uid && r.status === 'pending') {
      return { ok: true, name: user.name, pending: true };
    }
  }
  // Write the pair request to the target's pendingPairs + mirror in our
  // own sentPairs so we can track status and show a pending indicator.
  const reqRef = db.ref(`carecall/users/${user.uid}/pendingPairs`).push();
  const reqId = reqRef.key;
  const now = firebase.database.ServerValue.TIMESTAMP;
  const req = {
    fromUid:    S.uid,
    fromName:   S.name || '',
    fromRole:   S.role,
    fromAvatar: S.avatar || '',
    fromCode:   S.personalCode || '',
    fromRooms:  (S.role === 'patient' && S.rooms && S.rooms.length) ? S.rooms : null,
    at:         now,
    status:     'pending',
  };
  try {
    await reqRef.set(req);
  } catch(e) {
    console.warn('[Pairing] pendingPairs write failed:', e && e.message);
    return { error: t('Could not send pair request. Check your connection.') };
  }
  // Mirror (self-write, so rules never block).
  try {
    await db.ref(`carecall/users/${S.uid}/sentPairs/${reqId}`).set({
      toUid: user.uid, toName: user.name || '', toRole: user.role,
      at: now, status: 'pending',
    });
  } catch(e) { /* best effort — request is still live on the target side */ }
  // Start watching for the target's decision.
  _subscribeSentPair(reqId, user.uid);
  return { ok: true, name: user.name, pending: true };
}

// ── Owner side: listen for incoming pair requests ────────────────
export let _pendingPairsRef = null;
export function _subscribePendingPairs() {
  if (!S.uid) return;
  if (_pendingPairsRef) { try { _pendingPairsRef.off(); } catch(_) {} }
  _pendingPairsRef = db.ref(`carecall/users/${S.uid}/pendingPairs`);
  // Using child_added + child_changed keeps RAM flat for large inboxes.
  _pendingPairsRef.on('child_added', snap => {
    const req = snap.val();
    if (req && req.status === 'pending') _showPairRequestPrompt(snap.key, req);
  });
  _pendingPairsRef.on('child_changed', snap => {
    const req = snap.val();
    // If an existing pending request was externally marked (e.g. sender
    // cancelled in a future version), tear down the banner.
    if (req && req.status !== 'pending') {
      const existing = document.querySelector(`.pair-req-banner[data-req="${snap.key}"]`);
      if (existing) existing.remove();
    }
  });
}

export function _showPairRequestPrompt(reqId, req) {
  if (document.querySelector(`.pair-req-banner[data-req="${reqId}"]`)) return;
  const banner = document.createElement('div');
  banner.className = 'pair-req-banner insight-item';
  banner.setAttribute('data-req', reqId);
  banner.style.cssText = 'border-left-color:var(--carer-primary)';
  const when = req.at ? new Date(req.at).toLocaleString() : '';
  const avatarHtml = req.fromAvatar ? escHtml(req.fromAvatar) + ' ' : '';
  const roleLabel = t(req.fromRole === 'patient' ? 'patient' : (req.fromRole === 'carer' ? 'carer' : 'family member'));
  banner.innerHTML = `
    <span class="insight-icon">🤝</span>
    <span class="insight-text">
      <strong>${avatarHtml}${escHtml(req.fromName || t('Someone'))}</strong>
      ${escHtml(t('wants to connect as your'))} <strong>${escHtml(roleLabel)}</strong>.
      <div style="font-size:0.65rem;opacity:0.6;margin-top:2px">${escHtml(when)}</div>
      <div class="ho-banner-ack-row" style="margin-top:8px">
        <button class="ho-banner-btn got-it" data-action="approve">${escHtml(t('Approve'))}</button>
        <button class="ho-banner-btn" data-action="reject" style="background:rgba(239,68,68,0.14);color:var(--danger);border-color:rgba(239,68,68,0.3)">${escHtml(t('Reject'))}</button>
      </div>
    </span>`;
  banner.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'approve') approvePairRequest(reqId);
    else rejectPairRequest(reqId);
  });
  // Mount as a fixed overlay so it appears regardless of which screen
  // (main, settings, log, etc.) the user is currently on.
  document.body.appendChild(banner);
}

export async function approvePairRequest(reqId) {
  const reqRef = db.ref(`carecall/users/${S.uid}/pendingPairs/${reqId}`);
  const snap = await reqRef.once('value');
  const req = snap.val();
  if (!req || req.status !== 'pending') return;
  try {
    // 1. Create / find the shared room. As the approver, I (the owner)
    //    am the one creating it — rules allow first-write by any authed
    //    user, so this succeeds.
    const roomId = await findOrCreateRoom(S.uid, req.fromUid);
    // 2. Write both member entries. Self-member is always allowed; adding
    //    the requester is allowed because the room either has no members
    //    yet (freshly created) or I'm already a member of it.
    await db.ref(`carecall/rooms/${roomId}/members/${S.uid}`).update({
      name: S.name || '', role: S.role, online: true,
      lastSeen: firebase.database.ServerValue.TIMESTAMP,
      avatar: S.avatar || '',
    });
    await db.ref(`carecall/rooms/${roomId}/members/${req.fromUid}`).update({
      name: req.fromName || '', role: req.fromRole, online: false,
      lastSeen: firebase.database.ServerValue.TIMESTAMP,
      avatar: req.fromAvatar || '',
    });
    // 3. Add the room to my own rooms list (self-write).
    if (!S.rooms.includes(roomId)) {
      S.rooms.push(roomId);
      _dedupRooms();
      await _saveUserRooms(S.uid, S.rooms);
    }
    // 4. Mark the request approved. The requester is listening on this
    //    exact path and will self-add the roomId to their own rooms list.
    await reqRef.update({
      status: 'approved',
      roomId,
      decidedAt: firebase.database.ServerValue.TIMESTAMP,
    });
    // 5. If I'm a carer, register my FCM token in the new room.
    if (S.role === 'carer') _ensureFcmTokenInRoom(roomId).catch(() => {});
    await joinRoom(roomId);
    saveState();
    const roleLabel = req.fromRole === 'patient' ? t('patient') : (req.fromRole === 'carer' ? t('carer') : t('family member'));
    _showPairingSuccessBanner(req.fromName || '', roleLabel);
    // Re-run startPatient/startCarer so member listeners attach to the
    // new room. The rooms-value listener won't trigger a restart on its
    // own because S.rooms was already mutated inline before _saveUserRooms
    // wrote to Firebase — by the time the listener fires and compares,
    // it sees no new rooms.
    if (S.role === 'patient') startPatient();
    else if (S.role === 'carer') startCarer();
    else if (S.role === 'family') { _startFamilyListeners(); refreshLog(); }
    // Delay the settings refresh so the Firebase writes have propagated
    // before _renderSettingsConnections reads them back.
    setTimeout(() => { if (typeof refreshSettings === 'function') refreshSettings(); }, 600);
  } catch(e) {
    console.warn('[Pairing] approve failed:', e && e.message);
    toast(t('Could not complete pairing'));
  }
  document.querySelector(`.pair-req-banner[data-req="${reqId}"]`)?.remove();
}

export async function rejectPairRequest(reqId) {
  try {
    await db.ref(`carecall/users/${S.uid}/pendingPairs/${reqId}`).update({
      status: 'rejected',
      decidedAt: firebase.database.ServerValue.TIMESTAMP,
    });
    toast(t('Pair request rejected'));
  } catch(e) {}
  document.querySelector(`.pair-req-banner[data-req="${reqId}"]`)?.remove();
}

// ── Success banner (shown on both sides after pairing completes) ──
export function _showPairingSuccessBanner(name, roleLabel) {
  document.querySelector('.pair-success-banner')?.remove();
  const banner = document.createElement('div');
  banner.className = 'pair-success-banner';
  banner.innerHTML = `
    <span class="insight-icon">🎉</span>
    <span class="insight-text">
      <strong>${escHtml(t('Connected!'))}</strong>
      ${escHtml(t('You are now paired with'))} <strong>${escHtml(name)}</strong>
      ${roleLabel ? ` ${escHtml(t('as your'))} ${escHtml(roleLabel)}` : ''}.
    </span>`;
  banner.onclick = () => banner.remove();
  document.body.appendChild(banner);
  setTimeout(() => { try { banner.remove(); } catch(_) {} }, 8000);
}

// ── Sender side: listen for approval/rejection ───────────────────
export const _sentPairWatchers = {};
export function _subscribeSentPair(reqId, theirUid) {
  if (_sentPairWatchers[reqId]) return;
  const ref = db.ref(`carecall/users/${theirUid}/pendingPairs/${reqId}`);
  const handler = snap => {
    const req = snap.val();
    if (!req) return;
    if (req.status === 'approved') {
      ref.off('value', handler);
      delete _sentPairWatchers[reqId];
      _onPairApproved(reqId, req);
    } else if (req.status === 'rejected') {
      ref.off('value', handler);
      delete _sentPairWatchers[reqId];
      _onPairRejected(reqId, req);
    }
  };
  ref.on('value', handler);
  _sentPairWatchers[reqId] = { ref, handler };
}

export async function _onPairApproved(reqId, req) {
  const roomId = req.roomId;
  if (!roomId) return;
  if (!S.rooms.includes(roomId)) {
    S.rooms.push(roomId);
    _dedupRooms();
    await _saveUserRooms(S.uid, S.rooms);
  }
  // Reflect outcome in own sentPairs (self-write).
  try { await db.ref(`carecall/users/${S.uid}/sentPairs/${reqId}`).update({ status: 'approved', roomId }); } catch(_) {}
  if (S.role === 'carer') _ensureFcmTokenInRoom(roomId).catch(() => {});
  try { await joinRoom(roomId); } catch(e) { console.warn('[joinRoom] Failed for room', roomId, ':', e && e.message); }
  saveState();
  // req.fromName is OUR name (we sent the request); get THEIR name from
  // our sentPairs mirror which stored the target's name at send time.
  let theirName = '', theirRole = '';
  try {
    const sentSnap = await db.ref(`carecall/users/${S.uid}/sentPairs/${reqId}`).once('value');
    const sent = sentSnap.val();
    theirName = (sent && sent.toName) || '';
    theirRole = (sent && sent.toRole) || '';
  } catch(_) {}
  const roleLabel = theirRole === 'patient' ? t('patient') : (theirRole === 'carer' ? t('carer') : t('family member'));
  _showPairingSuccessBanner(theirName, roleLabel);
  // Re-run listener setup for the same reason as in approvePairRequest:
  // S.rooms was mutated before the Firebase write, so the rooms-value
  // listener won't see a change and won't call startPatient/startCarer.
  if (S.role === 'patient') startPatient();
  else if (S.role === 'carer') startCarer();
  else if (S.role === 'family') { _startFamilyListeners(); if (typeof refreshLog === 'function') refreshLog(); }
  setTimeout(() => { if (typeof refreshSettings === 'function') refreshSettings(); }, 600);
}

export async function _onPairRejected(reqId, req) {
  try { await db.ref(`carecall/users/${S.uid}/sentPairs/${reqId}`).update({ status: 'rejected' }); } catch(_) {}
  toast(t('Pair request was rejected'));
}

// Re-subscribe to any pending sentPairs on boot so reopens of the app
// still pick up approval/rejection while the user was away.
export async function _rehydrateSentPairs() {
  if (!S.uid) return;
  try {
    const snap = await db.ref(`carecall/users/${S.uid}/sentPairs`).once('value');
    const sent = snap.val() || {};
    for (const reqId of Object.keys(sent)) {
      const r = sent[reqId];
      if (r && r.status === 'pending' && r.toUid) _subscribeSentPair(reqId, r.toUid);
    }
  } catch(_) {}
}

// Ensure the carer's FCM token is registered in a specific room.
// Works whether setupCarerPush has run yet or not.
export async function _ensureFcmTokenInRoom(roomId) {
  try {
    // If messaging is already initialized, use it directly
    if (_messaging) {
      const token = await _messaging.getToken({ vapidKey: FIREBASE_CONFIG.vapidKey });
      if (token) await db.ref(`carecall/rooms/${roomId}/members/${S.uid}/fcmToken`).set(token);
      return;
    }
    // Fallback: copy token from an existing room where it's already registered
    for (const existingRoom of S.rooms) {
      if (existingRoom === roomId) continue;
      const snap = await db.ref(`carecall/rooms/${existingRoom}/members/${S.uid}/fcmToken`).once('value');
      if (snap.val()) {
        await db.ref(`carecall/rooms/${roomId}/members/${S.uid}/fcmToken`).set(snap.val());
        return;
      }
    }
  } catch(e) { console.warn('[FCM] Token registration failed for new room:', e.message); }
}

export async function _saveUserRooms(uid, rooms) {
  await db.ref(`carecall/users/${uid}/rooms`).set(rooms);
}

// Ensure S.rooms has no duplicate entries. connectToCode and the
// launchMainScreen rooms listener both push independently and can
// race — Firebase fires the listener while the direct push is
// in-flight, yielding the same roomId twice, which then shows the
// same peer twice in the connections list.
export function _dedupRooms() {
  if (!Array.isArray(S.rooms)) return;
  const seen = new Set();
  S.rooms = S.rooms.filter(r => {
    if (!r || seen.has(r)) return false;
    seen.add(r);
    return true;
  });
}

// Re-render just the "My connections" list, live. Triggered whenever
// S.rooms or any member snapshot updates, but only if the Settings
// screen is actually visible — so connecting a new patient while the
// carer sits on the Settings screen reflects immediately instead of
// requiring a close/reopen.
export async function _renderSettingsConnections() {
  const list = document.getElementById('rooms-list');
  if (!list) return;
  _dedupRooms();
  document.getElementById('s-connections-title').textContent =
    ({ patient: 'My Carers', carer: 'My Patients', family: 'My Patients' })[S.role] || 'My Connections';
  list.innerHTML = '';
  const connections = [];
  for (const roomId of S.rooms) {
    const snap = await db.ref(`carecall/rooms/${roomId}/members`).once('value');
    const members = snap.val() || {};
    const other = Object.entries(members).find(([uid, m]) => uid !== S.uid);
    if (other) {
      let theirCode = '';
      try {
        const userSnap = await db.ref(`carecall/users/${other[0]}/personalCode`).once('value');
        theirCode = userSnap.val() || '';
      } catch(e) {}
      connections.push({ roomId, uid: other[0], name: other[1].name, online: other[1].online, availability: other[1].availability, avatar: other[1].avatar || '', code: theirCode });
    } else {
      connections.push({ roomId, uid: null, name: 'Waiting for connection…', online: false, avatar: '', code: '' });
    }
  }
  // Dedup by member uid — legacy data + the "can't read their rooms" fallback
  // in findOrCreateRoom can leave two rooms for the same member pair.
  const seenUids = new Set();
  const deduped = connections.filter(c => {
    if (!c.uid) return true; // "waiting for connection" placeholder
    if (seenUids.has(c.uid)) return false;
    seenUids.add(c.uid);
    return true;
  });
  const conns = deduped;
  const isPatient = S.role === 'patient';
  if (conns.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:18px 12px;color:#6889A5;font-size:0.85rem">' + t('No connections yet — enter a pair code below to connect.') + '</div>';
    return;
  }
  if (isPatient && conns.length > 1) {
    _sortByCarerPriority(conns);
  }
  conns.forEach((conn, idx) => {
    const item = document.createElement('div');
    item.className = 'room-item';
    const tierBadge = isPatient && conns.length > 1
      ? `<span class="tier-badge">Tier ${idx + 1}</span>` : '';
    const priorityBtns = isPatient && conns.length > 1
      ? `<div class="priority-btns">
           <button class="priority-btn" onclick="_moveCarerPriority(${idx}, -1)" ${idx === 0 ? 'disabled' : ''}>▲</button>
           <button class="priority-btn" onclick="_moveCarerPriority(${idx}, 1)" ${idx === conns.length - 1 ? 'disabled' : ''}>▼</button>
         </div>` : '';
    const avatarHtml = conn.avatar
      ? `<span style="font-size:1.3rem;line-height:1;flex-shrink:0">${conn.avatar}</span>`
      : `<div style="width:8px;height:8px;border-radius:50%;background:${conn.online ? 'var(--success)' : '#6889A5'};flex-shrink:0"></div>`;
    const codeHtml = conn.code
      ? `<span style="font-size:0.6rem;color:#6889A5;letter-spacing:1px;font-weight:600">${conn.code}</span>` : '';
    item.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
        ${avatarHtml}
        <div style="overflow:hidden">
          <div class="room-item-code" style="letter-spacing:0;font-family:'Outfit',sans-serif;font-size:0.95rem;overflow:hidden;text-overflow:ellipsis">${escHtml(conn.name)}</div>
          ${codeHtml}
        </div>
        ${tierBadge}
      </div>
      <div style="display:flex;gap:4px;align-items:center">
        ${priorityBtns}
        <button class="room-remove-btn" onclick="removeConnection('${conn.roomId}')">Remove</button>
      </div>`;
    list.appendChild(item);
  });
}

export function _refreshSettingsConnectionsIfVisible() {
  const s = document.getElementById('s-settings');
  if (s && s.classList.contains('active')) {
    _renderSettingsConnections();
  }
}


// ════════════════════════════════════════════════════════════
//  QR CODE QUICK-CONNECT
// ════════════════════════════════════════════════════════════
export function showQrCode() {
  const code = S.personalCode;
  if (!code) { toast(t('No personal code yet')); return; }
  // Encode as carecall://<CODE> so external QR apps can deep-link on
  // devices that have the app installed (see AndroidManifest
  // intent-filter for the carecall scheme).
  const payload = 'carecall://' + code;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=2&data=${encodeURIComponent(payload)}`;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:90;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px;padding:20px;text-align:center;max-width:320px">
      <div style="font-family:'Fraunces',serif;font-size:1.05rem;color:#0D1520;margin-bottom:10px">${t('Your CareCall code')}</div>
      <img src="${qrUrl}" alt="QR Code" style="width:220px;height:220px;border-radius:8px;display:block;margin:0 auto">
      <div style="margin-top:14px;font-family:'Fraunces',serif;font-size:1.7rem;letter-spacing:6px;color:#0D1520">${code}</div>
      <div style="font-size:0.78rem;color:#666;margin-top:8px;line-height:1.4">${t('The other person scans this QR in their CareCall app, or types the four letters.')}</div>
    </div>
    <button onclick="this.parentElement.remove()" style="background:rgba(255,255,255,0.15);border:none;color:#fff;padding:12px 36px;border-radius:12px;font-size:0.95rem;font-weight:600;font-family:'Outfit',sans-serif;cursor:pointer">${t('Close')}</button>`;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

// ──────────────────────────────────────────────────────────
//  QR SCANNER
//  Uses html5-qrcode (loaded from CDN). On a successful scan
//  we accept either a carecall://XXXX payload, carecall:XXXX,
//  or a bare 4-char code. Target tells us which input to fill.
// ──────────────────────────────────────────────────────────
export let _qrScannerInstance = null;
export let _qrTarget = null; // 'setup' | 'settings' | 'deeplink'

export function _parseQrPayload(text) {
  if (!text) return null;
  const s = String(text).trim();
  const m = s.match(/^carecall:(?:\/\/)?([A-Za-z0-9]{4,8})/i);
  if (m) return m[1].toUpperCase();
  if (/^[A-Za-z0-9]{4}$/.test(s)) return s.toUpperCase();
  return null;
}

export async function openQrScanner(target) {
  // Lazy-load html5-qrcode on first use
  if (!window.Html5Qrcode) {
    try {
      toast(t('Loading scanner…'));
      await loadScript('https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js');
    } catch(e) { console.warn('[QR] lazy-load failed:', e); }
  }
  if (!window.Html5Qrcode) { toast(t('Scanner unavailable — check your connection')); return; }
  _qrTarget = target || 'setup';
  document.querySelector('.qr-scanner-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'qr-scanner-modal';
  modal.innerHTML = `
    <div class="qr-title">${t('Scan QR code')}</div>
    <div id="qr-reader"></div>
    <div class="qr-hint">${t('Point camera at the QR code displayed on the other device')}</div>
    <div id="qr-error" class="qr-err"></div>
    <button class="qr-cancel" onclick="closeQrScanner()">${t('Cancel')}</button>
  `;
  document.body.appendChild(modal);

  try {
    _qrScannerInstance = new Html5Qrcode('qr-reader');
    await _qrScannerInstance.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      _onQrScanSuccess,
      () => { /* per-frame decode failures are routine — ignore */ }
    );
  } catch (e) {
    const err = document.getElementById('qr-error');
    if (err) {
      err.style.display = '';
      err.innerHTML = escHtml(t('Camera not available — you can type the code manually instead.'));
    }
  }
}

export async function closeQrScanner() {
  if (_qrScannerInstance) {
    try { await _qrScannerInstance.stop(); } catch(_) {}
    try { await _qrScannerInstance.clear(); } catch(_) {}
    _qrScannerInstance = null;
  }
  document.querySelector('.qr-scanner-modal')?.remove();
}

export async function _onQrScanSuccess(decodedText) {
  const code = _parseQrPayload(decodedText);
  if (!code) return; // not a CareCall QR; keep scanning
  const target = _qrTarget;
  await closeQrScanner();
  // Prevent connecting to yourself (e.g. scanning own QR from mirror).
  if (S.personalCode && code === S.personalCode) {
    toast(t("That's your own code"));
    return;
  }
  toast(t('Code scanned') + ': ' + code);
  if (target === 'setup') {
    const el = document.getElementById('room-code-input');
    if (el) el.value = code;
    if (typeof setupConnect === 'function') setupConnect();
  } else if (target === 'settings') {
    const el = document.getElementById('add-room-input');
    if (el) el.value = code;
    if (typeof addConnectionFromSettings === 'function') addConnectionFromSettings();
  } else if (target === 'deeplink') {
    _handleDeepLinkCode(code);
  }
}

// Deep-link handler — invoked when Android opens the app via a
// carecall:// URL from an external QR reader. If the user hasn't
// finished setup yet, stash the code; we'll offer to connect right
// after onboarding.
export async function _handleDeepLinkCode(code) {
  if (!code) return;
  if (S.personalCode && code === S.personalCode) return;
  if (!S.role) {
    localStorage.setItem('carecall_pending_qr', code);
    return;
  }
  if (!confirm(t('Connect to code') + ' ' + code + '?')) return;
  const result = await connectToCode(code);
  if (result && result.error) { toast(result.error); return; }
  if (result && result.alreadyConnected) {
    toast(t('Already connected to') + ' ' + result.name);
  } else if (result && result.pending) {
    toast(t('Pair request sent to') + ' ' + result.name + ' — ' + t('waiting for approval'));
  } else {
    toast(t('Connected to') + ' ' + (result && result.name || ''));
  }
}

