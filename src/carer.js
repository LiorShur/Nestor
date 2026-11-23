// ════════════════════════════════════════════════════════════
//  CARER — carer logic, handoff, ambient sound, wellbeing
// ════════════════════════════════════════════════════════════
import { S, PS, CS } from './state.js';

// ════════════════════════════════════════════════════════════
//  CARER LOGIC
// ════════════════════════════════════════════════════════════
export let _carerAvailability = 'available'; // 'available' | 'busy' | 'off-duty'

export function setAvailability(status) {
  _carerAvailability = status;
  // Update UI
  document.querySelectorAll('.avail-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.status === status);
  });
  // Update in all rooms
  S.rooms.forEach(roomId => {
    db.ref(`carecall/rooms/${roomId}/members/${S.uid}/availability`).set(status);
  });
  // Update user profile
  db.ref(`carecall/users/${S.uid}/availability`).set(status);
  localStorage.setItem('carecall_availability', status);

  if (status === 'available') {
    updateCarerOrb('listening', t('Waiting for patient…'));
    _checkHandoffNote(); // show any pending handoff from previous carer
  } else if (status === 'busy') {
    updateCarerOrb('listening', t('Busy') + ' — ' + t('Available'));
  } else {
    updateCarerOrb('listening', t('Off Duty'));
    // Prompt for handoff note when going off duty
    setTimeout(() => showHandoffPrompt(), 500);
  }
}

export let _carerStarted = false;
export function startCarer() {
  _carerStarted = false;
  _carerAvailability = localStorage.getItem('carecall_availability') || 'available';
  setAvailability(_carerAvailability);
  updateCarerOrb('listening', 'Waiting for patient…');
  setupCarerPush();

  // ── Clean up old listeners (prevents stacking when called again) ──
  if (CS._listenerRefs) CS._listenerRefs.forEach(ref => ref.off());
  CS._listenerRefs = [];

  // Aggregate members across ALL rooms for display
  const _carerMembersCache = {};
  function _rebuildCarerMembers() {
    const allMembers = {};
    Object.values(_carerMembersCache).forEach(members => {
      Object.entries(members).forEach(([uid, m]) => { allMembers[uid] = m; });
    });
    renderMembers(allMembers);
    renderRoomDropdown('c', allMembers);
  }

  // Listen to ALL rooms for members and calls
  S.rooms.forEach(roomId => {
    const memberRef = db.ref(`carecall/rooms/${roomId}/members`);
    memberRef.on('value', snap => {
      _carerMembersCache[roomId] = snap.val() || {};
      _rebuildCarerMembers();
      _refreshSettingsConnectionsIfVisible();
    });
    CS._listenerRefs.push(memberRef);

    const callsRef = db.ref(`carecall/rooms/${roomId}/calls`)
      .orderByChild('timestamp')
      .limitToLast(20);

    callsRef.on('child_added', snap => {
      try {
        const call = snap.val();
        if (!call) return;
        call._room = roomId;
        if (call.status === 'active') {
          addActiveCall(call);
          const age = Date.now() - (call.timestamp || 0);
          if (age < NEW_CALL_THRESHOLD_MS) showIncomingAlert(call);
        } else if (call.status === 'acknowledged') {
          // Call was already acknowledged before we started listening —
          // add it so it shows correctly (with ack badge, not green button)
          addActiveCall(call);
          setTimeout(() => removeCallCard(call.id), CALL_CARD_REMOVE_DELAY_MS);
        }
      } catch(e) { console.error('[Carer] child_added error:', e); }
    });

    callsRef.on('child_changed', snap => {
      try {
        const call = snap.val();
        if (!call) return;
        call._room = roomId;
        updateCallCard(call);
        if (call.status === 'acknowledged') {
          CS.activeCalls[call.id] = call;
          if (CS.alertCallId === call.id) dismissAlert();
          setTimeout(() => removeCallCard(call.id), CALL_CARD_REMOVE_DELAY_MS);
        }
      } catch(e) { console.error('[Carer] child_changed error:', e); }
    });
    CS._listenerRefs.push(callsRef);
  });

  setTimeout(() => { _carerStarted = true; }, 2000);
  _trackAvailHours();
}

// ── Check for active calls missed while app was backgrounded ──
// Called whenever the app comes back into focus.
export function checkForMissedCalls() {
  if (S.role !== 'carer' || !S.rooms.length || !_carerStarted) return;
  const since = Date.now() - MISSED_CALL_LOOKBACK_MS;
  // Check ALL rooms for missed calls
  S.rooms.forEach(roomId => {
    db.ref(`carecall/rooms/${roomId}/calls`)
      .orderByChild('timestamp')
      .startAt(since)
      .once('value', snap => {
        snap.forEach(child => {
          const call = child.val();
          if (!call) return;
          if (call.status === 'active' && CS.alertCallId !== call.id) {
            call._room = roomId;
            if (!CS.activeCalls[call.id]) addActiveCall(call);
            showIncomingAlert(call);
          }
        });
    });
  });
}

export function renderMembers(members) {
  const bar = document.getElementById('members-bar');
  const noTxt = document.getElementById('no-members-txt');
  // Remove existing chips
  bar.querySelectorAll('.member-chip').forEach(c=>c.remove());
  const entries = Object.entries(members);
  if (!entries.length) { noTxt.style.display=''; return; }
  noTxt.style.display = 'none';
  entries.forEach(([uid, m]) => {
    const chip = document.createElement('div');
    const isMe = uid === S.uid;
    // Check presence staleness — if lastSeen is more than 90s old, treat as offline
    const stale = m.online && m.lastSeen && (Date.now() - m.lastSeen) > 90000;
    const effectiveOnline = m.online && !stale;
    chip.className = `member-chip ${m.role === 'patient' ? 'patient-chip' : 'carer-chip'}${effectiveOnline ? '' : ' offline-chip'}`;
    const av = m.avatar ? `<span style="font-size:0.9rem">${escHtml(m.avatar)}</span>` : '<div class="mdot"></div>';
    chip.innerHTML = `${av}${escHtml(m.name)}${isMe ? ' (me)' : ''}`;
    bar.appendChild(chip);
  });
  // Update orb — treat stale presence as not truly online
  const patients = entries.filter(([,m])=>m.role==='patient' && m.online && m.lastSeen && (Date.now() - m.lastSeen) <= 90000);
  if (patients.length) {
    updateCarerOrb('connected', `${patients.length} patient${patients.length>1?'s':''} connected`);
  } else {
    updateCarerOrb('listening', 'Waiting for patient…');
  }
}

export function updateCarerOrb(state, msg) {
  const orb  = document.getElementById('carer-orb');
  const icon = document.getElementById('orb-icon');
  const lbl  = document.getElementById('orb-lbl');
  const stat = document.getElementById('orb-status');
  stat.textContent = msg; stat.className = 'orb-status';
  if (state==='listening') { orb.style.cssText=''; icon.innerHTML='<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'; lbl.textContent=t('Standby'); }
  if (state==='connected') { orb.style.cssText='border-color:rgba(16,185,129,.5);background:rgba(16,185,129,.08)'; icon.innerHTML='<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/></svg>'; lbl.textContent='On Call'; stat.classList.add('live'); }
}

export function addActiveCall(call) {
  CS.activeCalls[call.id] = call;
  renderCallCards();
}
export function updateCallCard(call) {
  CS.activeCalls[call.id] = call;
  renderCallCards();
}
export function removeCallCard(callId) {
  delete CS.activeCalls[callId];
  renderCallCards();
}

export function renderCallCards() {
  const section = document.getElementById('calls-section');
  const list    = document.getElementById('calls-list');
  const orbArea = document.getElementById('orb-area');
  const active  = Object.values(CS.activeCalls).filter(c=>c.status==='active');
  const acked   = Object.values(CS.activeCalls).filter(c=>c.status==='acknowledged');
  const all     = [...active, ...acked].sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));

  if (!all.length) {
    section.style.display = 'none';
    orbArea.style.display = 'flex';
    return;
  }
  section.style.display = 'block';
  orbArea.style.display = active.length ? 'none' : 'flex';

  list.innerHTML = '';
  all.forEach(call => {
    const isAcked = call.status === 'acknowledged';
    const card = document.createElement('div');
    card.className = `call-card${isAcked?' acked':''}`;
    card.id = `call-card-${call.id}`;
    const ts = call.timestamp ? timeAgo(call.timestamp) : '';
    card.innerHTML = `
      <div class="call-card-top">
        <div><div class="call-who">${call.avatar ? escHtml(call.avatar) + ' ' : ''}${escHtml(call.fromName)}</div><div class="call-time">${ts}</div></div>
      </div>
      <div class="call-type-badge">${needLabel(call.type)}</div>
      ${call.message ? `<div class="call-message">"${escHtml(call.message)}"</div>` : ''}
      ${call.voiceNote ? `<button class="vn-play-card-btn" onclick="playCallVoiceNote('${call.id}')">🎙️ Play voice note</button>` : ''}
      ${call.location ? `<a class="vn-play-card-btn" href="https://maps.google.com/maps?q=${call.location.lat},${call.location.lng}" target="_blank" style="text-decoration:none">📍 View location</a>` : ''}
      ${call.careNote ? `<div class="call-message" style="color:var(--carer-primary)">📝 ${escHtml(call.careNote.text)} — ${escHtml(call.careNote.by)}</div>` : ''}
      <div class="call-ack-row">
        ${isAcked
          ? `<div class="acked-badge">✅ Acknowledged by ${escHtml(call.ackName||'')}</div>
             <button class="vn-play-card-btn" onclick="showCareNotePrompt('${call.id}')" style="margin-left:auto">📝 Note</button>`
          : `<button class="ack-btn" onclick="acknowledgeCall('${call.id}')">✓ I'm on my way</button>${
               call.type === 'fall' ? '<button class="voice-call-btn" onclick="startVoiceCall()">📞</button><button class="voice-call-btn" onclick="startAmbientListen()" title="Listen">👂</button>' : ''}`}
      </div>`;
    list.appendChild(card);
  });
}

export async function showIncomingAlert(call) {
  // Don't double-show if alert already visible for this call
  if (CS.alertCallId === call.id) return;
  // Stop any previous bell before starting new one
  stopBell();
  CS.alertCallId = call.id;
  const callerAvatar = call.avatar || '';
  document.getElementById('ia-who').textContent = `${callerAvatar ? callerAvatar + ' ' : ''}${escHtml(call.fromName)} is calling!`;
  document.getElementById('ia-type-badge').innerHTML = needLabel(call.type);
  const msgEl = document.getElementById('ia-message');
  if (call.message) { msgEl.textContent = `"${call.message}"`; msgEl.style.display='block'; }
  else { msgEl.style.display='none'; }
  // Show voice note play button if call has a voice note
  const vnBtn = document.getElementById('ia-vn-btn');
  if (call.voiceNote) {
    vnBtn.style.display = '';
    vnBtn._voiceNote = call.voiceNote;
  } else {
    vnBtn.style.display = 'none';
    vnBtn._voiceNote = null;
  }
  // Show voice call button only for fall/emergency alerts
  document.getElementById('ia-voice-btn').style.display = (call.type === 'fall') ? '' : 'none';

  document.getElementById('incoming-alert').classList.add('show');
  // Resume audio context if suspended (e.g. after screen lock)
  try {
    if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {});
    }
  } catch(e) {}
  startBell();
}

export function dismissAlert() {
  document.getElementById('incoming-alert').classList.remove('show');
  stopBell(); CS.alertCallId = null;
}

export async function acknowledgeCall(callId) {
  unlockAudio();
  // Prevent double-tap
  if (CS._ackingCallId === callId) return;
  CS._ackingCallId = callId;

  const call = CS.activeCalls[callId];
  const roomId = (call && call._room) || S.activeRoom || S.rooms[0];
  if (!roomId) {
    toast(t('Call failed — check your connection'));
    CS._ackingCallId = null;
    return;
  }

  try {
    await db.ref(`carecall/rooms/${roomId}/calls/${callId}`).update({
      status:  'acknowledged',
      ackUid:  S.uid,
      ackName: S.name,
      ackAt:   firebase.database.ServerValue.TIMESTAMP,
    });
    toast(t("Patient notified — you're on the way!"));
  } catch(e) {
    console.error('[Ack] Failed:', e);
    toast(t('Failed to acknowledge — check your connection'));
  } finally {
    CS._ackingCallId = null;
  }
}

export function acknowledgeFromAlert() {
  if (CS.alertCallId) acknowledgeCall(CS.alertCallId);
  dismissAlert();
}


// ════════════════════════════════════════════════════════════
//  CARER HANDOFF NOTES v2 (Shift Change System)
//  v2 adds:
//    1. Structured status chips (mood / sleep / appetite / mobility / meds)
//    2. Auto-generated 24h snapshot at the top of the write modal so the
//       departing carer can see at a glance what happened on their shift.
//    3. Read-receipt ("Got it"): the arriving carer's ack is written back
//       into the history record so the sender sees who picked it up.
//    4. Quick reply: the arriving carer can respond without opening the
//       full handoff modal — useful for "Got it, thanks" / "Will check
//       meds at 2pm".
//    5. Urgent notes require explicit ack — they don't dismiss on tap.
// ════════════════════════════════════════════════════════════

// Status dimensions rendered as chip rows. Keys are stable; labels go
// through t() at render time.
export const HANDOFF_STATUS_DIMENSIONS = [
  { key: 'mood',     label: 'Mood',
    options: [
      { v: 'good', label: '😊 Good',       cls: 'ho-good' },
      { v: 'fair', label: '😐 Fair',       cls: 'ho-warn' },
      { v: 'bad',  label: '☹️ Concerning', cls: 'ho-bad'  },
    ] },
  { key: 'sleep',    label: 'Sleep',
    options: [
      { v: 'good', label: '💤 Well',       cls: 'ho-good' },
      { v: 'fair', label: '🌙 Restless',   cls: 'ho-warn' },
      { v: 'bad',  label: '😴 Poor',       cls: 'ho-bad'  },
    ] },
  { key: 'appetite', label: 'Appetite',
    options: [
      { v: 'good', label: '🍽️ Good',       cls: 'ho-good' },
      { v: 'fair', label: '🥄 Low',        cls: 'ho-warn' },
      { v: 'bad',  label: '❌ None',       cls: 'ho-bad'  },
    ] },
  { key: 'mobility', label: 'Mobility',
    options: [
      { v: 'good', label: '🚶 Normal',     cls: 'ho-good' },
      { v: 'fair', label: '🦯 Assisted',   cls: 'ho-warn' },
      { v: 'bad',  label: '🛏️ Limited',    cls: 'ho-bad'  },
    ] },
  { key: 'meds',     label: 'Meds',
    options: [
      { v: 'good', label: '✅ All',        cls: 'ho-good' },
      { v: 'fair', label: '⚠️ Partial',    cls: 'ho-warn' },
      { v: 'bad',  label: '❌ Missed',     cls: 'ho-bad'  },
    ] },
];

// Derive a 24h snapshot from the call log for whichever rooms this carer is
// in. Best-effort — if any query errors we skip that room silently so the
// modal still opens. Output is a short HTML string (user input is not
// reflected here, so direct interpolation is safe).
export async function _handoffSnapshot() {
  if (!S.rooms || !S.rooms.length) return '';
  const since = Date.now() - 24 * 60 * 60 * 1000;
  let calls = 0, medTaken = 0, medMissed = 0, zoneExits = 0, falls = 0, sosCount = 0;
  for (const room of S.rooms) {
    try {
      const snap = await db.ref(`carecall/rooms/${room}/calls`)
        .orderByChild('timestamp').startAt(since).once('value');
      snap.forEach(child => {
        const c = child.val();
        if (!c) return;
        if (c.type === 'med-taken') medTaken++;
        else if (c.type === 'med-missed') medMissed++;
        else if (c.type === 'zone-exit') zoneExits++;
        else if (c.type === 'fall') falls++;
        else if (c.type === 'help' || c.type === 'sos') sosCount++;
        else calls++; // water / food / toilet / custom / checkin-help etc.
      });
    } catch(e) { /* skip room */ }
  }
  const parts = [];
  if (calls)     parts.push(`<strong>${calls}</strong> ${calls === 1 ? t('call') : t('calls')}`);
  if (sosCount)  parts.push(`<strong>${sosCount}</strong> SOS`);
  if (falls)     parts.push(`<strong>${falls}</strong> ${t('falls')}`);
  if (medTaken || medMissed) {
    const missedLabel = medMissed ? (' · <strong>' + medMissed + '</strong> ' + t('missed')) : '';
    parts.push(`<strong>${medTaken}</strong> ${t('meds taken')}${missedLabel}`);
  }
  if (zoneExits) parts.push(`<strong>${zoneExits}</strong> ${t('zone exits')}`);
  if (!parts.length) return `<div class="ho-snapshot">${t('Past 24h')}: ${t('Quiet shift — nothing logged.')}</div>`;
  return `<div class="ho-snapshot">${t('Past 24h')}: ${parts.join(' · ')}</div>`;
}

export async function showHandoffPrompt() {
  document.querySelector('.handoff-modal')?.remove();
  const snapshot = await _handoffSnapshot();

  const statusHtml = HANDOFF_STATUS_DIMENSIONS.map(dim => {
    const chips = dim.options.map(opt =>
      `<button type="button" class="ho-chip ${opt.cls}" data-dim="${dim.key}" data-value="${opt.v}" onclick="_toggleHandoffStatus(this)">${opt.label}</button>`
    ).join('');
    return `
      <div class="ho-status-group">
        <div class="ho-status-label">${t(dim.label)}</div>
        <div class="ho-chips" data-dim="${dim.key}">${chips}</div>
      </div>`;
  }).join('');

  const modal = document.createElement('div');
  modal.className = 'handoff-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:90;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:#162032;border-radius:20px;padding:20px;max-width:380px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.4)">
      <div style="font-family:'Fraunces',serif;font-size:1.1rem;color:#F1F5F9;margin-bottom:8px">📋 ${t('Shift Handoff Note')}</div>
      <div style="font-size:0.75rem;color:#6889A5;margin-bottom:10px">${t('Write a note for the next carer coming on duty')}</div>
      ${snapshot}
      ${statusHtml}
      <div class="ho-status-label" style="margin-top:8px">${t('Note')}</div>
      <textarea id="handoff-text" style="width:100%;min-height:90px;background:rgba(255,255,255,0.06);border:1.5px solid #1F2F42;border-radius:12px;padding:12px;color:#F1F5F9;font-family:'Outfit',sans-serif;font-size:0.9rem;resize:vertical;outline:none" placeholder="${t('e.g. Patient had a rough night, needed help 3x. Left water by bedside. Check medication at 2pm.')}"></textarea>
      <select id="handoff-priority" style="width:100%;background:rgba(255,255,255,0.06);border:1.5px solid #1F2F42;border-radius:10px;padding:10px;color:#F1F5F9;font-family:'Outfit',sans-serif;font-size:0.85rem;margin-top:8px;outline:none">
        <option value="normal">📝 ${t('Normal note')}</option>
        <option value="important">⚠️ ${t('Important — needs attention')}</option>
        <option value="urgent">🚨 ${t('Urgent — act immediately')}</option>
      </select>
      <div style="display:flex;gap:8px;margin-top:12px;position:sticky;bottom:0;background:#162032;padding-top:10px;z-index:1">
        <button onclick="_submitHandoff()" style="flex:1;background:var(--carer-primary);color:#fff;border:none;border-radius:12px;padding:12px;font-weight:600;font-family:'Outfit',sans-serif;cursor:pointer">${t('Save Note')}</button>
        <button onclick="document.querySelector('.handoff-modal').remove()" style="flex:1;background:rgba(255,255,255,0.06);color:#94A3B8;border:none;border-radius:12px;padding:12px;font-weight:600;font-family:'Outfit',sans-serif;cursor:pointer">${t('Skip')}</button>
      </div>
    </div>`;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById('handoff-text')?.focus(), 300);
}

// Radio-style: clicking a chip replaces any other selection in the same
// dimension. Clicking the same chip again clears it.
export function _toggleHandoffStatus(btn) {
  const dim = btn.dataset.dim;
  const row = document.querySelector('.ho-chips[data-dim="' + dim + '"]');
  if (!row) return;
  const wasSelected = btn.classList.contains('selected');
  row.querySelectorAll('.ho-chip').forEach(c => c.classList.remove('selected'));
  if (!wasSelected) btn.classList.add('selected');
}

export async function _submitHandoff() {
  const text = document.getElementById('handoff-text')?.value?.trim();
  const priority = document.getElementById('handoff-priority')?.value || 'normal';
  // Collect selected status chips.
  const status = {};
  document.querySelectorAll('.handoff-modal .ho-chip.selected').forEach(c => {
    status[c.dataset.dim] = c.dataset.value;
  });
  document.querySelector('.handoff-modal')?.remove();
  if (!text && !Object.keys(status).length) return;

  const note = {
    text: text || '',
    priority,
    status,
    from: S.name,
    fromUid: S.uid,
    avatar: S.avatar || '',
    at: firebase.database.ServerValue.TIMESTAMP,
    // Empty object rather than null keeps the Firebase security rules simple.
    acks: {},
  };

  for (const room of S.rooms) {
    // Save to history (append, don't overwrite)
    const pushed = await db.ref(`carecall/rooms/${room}/handoffHistory`).push(note);
    // Also save as latest (for quick banner check)
    await db.ref(`carecall/rooms/${room}/handoff`).set({ ...note, historyKey: pushed.key });
  }
  toast(t('Care note saved'));
}

export async function _checkHandoffNote() {
  if (S.role !== 'carer' || !S.rooms.length) return;
  try {
    for (const room of S.rooms) {
      const snap = await db.ref(`carecall/rooms/${room}/handoff`).once('value');
      const handoff = snap.val();
      if (!handoff || (!handoff.text && !handoff.status)) continue;
      if (handoff.fromUid === S.uid || handoff.from === S.name) continue;
      if (handoff.at && Date.now() - handoff.at > 86400000) continue;
      // Already ack'd by me — don't re-show.
      if (handoff.acks && handoff.acks[S.uid]) continue;

      _renderHandoffBanner(handoff, room);
    }
  } catch(e) {}
}

export function _renderHandoffBanner(handoff, room) {
  // Replace any existing banner — we only show one at a time.
  document.getElementById('handoff-banner')?.remove();

  const priorityStyles = {
    urgent:    'border-left-color:var(--danger);background:rgba(239,68,68,0.08)',
    important: 'border-left-color:var(--warning);background:rgba(245,158,11,0.08)',
    normal:    'border-left-color:var(--carer-primary)',
  };
  const priorityIcons = { urgent: '🚨', important: '⚠️', normal: '📋' };
  const style = priorityStyles[handoff.priority] || priorityStyles.normal;
  const icon = priorityIcons[handoff.priority] || '📋';

  // Render status chips the sender picked, if any.
  let statusHtml = '';
  const status = handoff.status || {};
  const statusTags = Object.keys(status).map(dim => {
    const dimDef = HANDOFF_STATUS_DIMENSIONS.find(d => d.key === dim);
    if (!dimDef) return '';
    const opt = dimDef.options.find(o => o.v === status[dim]);
    if (!opt) return '';
    const cls = opt.cls.replace('ho-', '');
    return `<span class="ho-tag ${cls}">${escHtml(opt.label)}</span>`;
  }).filter(Boolean);
  if (statusTags.length) statusHtml = `<div class="ho-tags">${statusTags.join('')}</div>`;

  const banner = document.createElement('div');
  banner.id = 'handoff-banner';
  banner.className = 'insight-item';
  banner.style.cssText = `margin:0 20px;${style}`;
  const urgent = handoff.priority === 'urgent';
  const dismissHint = urgent ? t('Tap "Got it" to dismiss') : t('Tap to dismiss');
  const whenTxt = handoff.at ? new Date(handoff.at).toLocaleString() : '';
  banner.innerHTML = `
    <span class="insight-icon">${icon}</span>
    <span class="insight-text">
      <strong>${escHtml(handoff.from || '')}:</strong> ${escHtml(handoff.text || '')}
      ${statusHtml}
      <div style="font-size:0.65rem;opacity:0.6;margin-top:4px">${escHtml(whenTxt)} · ${escHtml(dismissHint)}</div>
      <div class="ho-banner-ack-row">
        <button class="ho-banner-btn got-it" onclick="_ackHandoffNote('${escHtml(room)}', '${escHtml(handoff.historyKey || '')}')">👍 ${t('Got it')}</button>
        <button class="ho-banner-btn" onclick="_replyHandoff('${escHtml(room)}', '${escHtml(handoff.historyKey || '')}')">💬 ${t('Reply')}</button>
      </div>
    </span>`;
  // Non-urgent notes can be swiped-away with a tap on the body (but not on
  // the two buttons, which have their own handlers).
  if (!urgent) {
    banner.addEventListener('click', (e) => {
      if (e.target.closest('.ho-banner-btn')) return;
      banner.remove();
    });
  }
  const carer = document.querySelector('.carer-main');
  if (carer) carer.insertBefore(banner, carer.children[1]); // after availability bar
}

// Record the ack so the sender can see who picked it up, and so we don't
// re-show the banner next time the carer comes on-shift.
export async function _ackHandoffNote(room, historyKey) {
  if (!room) return;
  const ackEntry = {
    at: firebase.database.ServerValue.TIMESTAMP,
    by: S.name || '',
    byUid: S.uid,
  };
  try {
    await db.ref(`carecall/rooms/${room}/handoff/acks/${S.uid}`).set(ackEntry);
    if (historyKey) {
      await db.ref(`carecall/rooms/${room}/handoffHistory/${historyKey}/acks/${S.uid}`).set(ackEntry);
    }
  } catch(e) {}
  document.getElementById('handoff-banner')?.remove();
  toast(t('Acknowledged'));
}

// Open the full handoff modal pre-seeded with "Reply to <name>:" so the
// conversation reads naturally in the history. Ack the original before
// opening so the banner doesn't re-fire.
export async function _replyHandoff(room, historyKey) {
  // Ack first (fire-and-forget — failures aren't blocking).
  _ackHandoffNote(room, historyKey).catch(() => {});
  await showHandoffPrompt();
  // Defer until the prompt is in the DOM.
  setTimeout(() => {
    const ta = document.getElementById('handoff-text');
    if (!ta) return;
    // Best-effort: find the sender name from the (now-removed) banner's
    // underlying handoff. We only stored room+historyKey in the handler, so
    // re-read the history entry.
    if (historyKey) {
      db.ref(`carecall/rooms/${room}/handoffHistory/${historyKey}`).once('value').then(s => {
        const h = s.val();
        if (h && h.from) {
          ta.value = `↩ ${h.from}: `;
          ta.focus();
          const end = ta.value.length;
          ta.setSelectionRange(end, end);
        } else {
          ta.focus();
        }
      }).catch(() => { ta.focus(); });
    } else {
      ta.focus();
    }
  }, 350);
}

// ── Handoff notes in the call log ──
export async function _fetchHandoffNotes(roomsToQuery) {
  const notes = [];
  for (const room of roomsToQuery) {
    try {
      const snap = await db.ref(`carecall/rooms/${room}/handoffHistory`)
        .orderByChild('at').limitToLast(50).once('value');
      snap.forEach(child => {
        const n = child.val();
        if (n) { n._room = room; n._type = 'handoff'; n._key = child.key; notes.push(n); }
      });
    } catch(e) {}
  }
  return notes;
}


// ════════════════════════════════════════════════════════════
//  AMBIENT SOUND MONITOR (One-way Listen)
// ════════════════════════════════════════════════════════════
export let _ambientStream = null;
export let _ambientTimeout = null;
export let _ambientListenerRefs = [];

export async function startAmbientListen() {
  // Carer triggers a one-way listen on the patient's phone
  const call = CS.activeCalls[CS.alertCallId] || Object.values(CS.activeCalls).find(c => c.status === 'active' || c.status === 'acknowledged');
  if (!call) { toast(t('No active call to listen to')); return; }
  const roomId = call._room || S.activeRoom || S.rooms[0];
  if (!roomId) return;
  // Signal the patient to open their mic
  await db.ref(`carecall/rooms/${roomId}/ambientListen`).set({
    from: S.uid, fromName: S.name, status: 'requesting',
    createdAt: firebase.database.ServerValue.TIMESTAMP,
  });
  toast(t('Listening request sent — waiting for audio…'));
}

export function _listenForAmbientRequests() {
  if (S.role !== 'patient') return;
  // Tear down prior listeners to prevent stacking
  _ambientListenerRefs.forEach(r => r.off());
  _ambientListenerRefs = [];
  S.rooms.forEach(roomId => {
    const ref = db.ref(`carecall/rooms/${roomId}/ambientListen`);
    _ambientListenerRefs.push(ref);
    ref.on('value', async snap => {
      const req = snap.val();
      if (!req || req.status !== 'requesting' || req.from === S.uid) return;
      // Auto-open mic and stream via WebRTC (reusing voice call infrastructure)
      try {
        if (!navigator.mediaDevices) return;
        _ambientStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        await db.ref(`carecall/rooms/${roomId}/ambientListen/status`).set('active');
        // Auto-stop after 30 seconds
        _ambientTimeout = setTimeout(() => stopAmbientListen(roomId), 30000);
        // Create a simple WebRTC connection for audio streaming
        // For simplicity, use the existing voice call mechanism
        VC.callId = 'ambient_' + Date.now();
        VC.sigRef = db.ref(`carecall/rooms/${roomId}/voiceCalls/${VC.callId}`);
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        _ambientStream.getTracks().forEach(t => pc.addTrack(t, _ambientStream));
        pc.onicecandidate = evt => { if (evt.candidate) VC.sigRef.child('calleeCandidates').push(evt.candidate.toJSON()); };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await VC.sigRef.set({
          offer: { type: offer.type, sdp: offer.sdp }, from: S.uid, to: req.from,
          status: 'ambient', createdAt: firebase.database.ServerValue.TIMESTAMP,
        });
        VC.pc = pc;
      } catch(e) { console.warn('[Ambient] Mic access failed:', e.message); }
    });
  });
}

export function stopAmbientListen(roomId) {
  clearTimeout(_ambientTimeout);
  if (_ambientStream) { _ambientStream.getTracks().forEach(t => t.stop()); _ambientStream = null; }
  if (roomId) db.ref(`carecall/rooms/${roomId}/ambientListen`).remove();
  if (VC.pc) { VC.pc.close(); VC.pc = null; }
  VC.sigRef = null;
}


// ════════════════════════════════════════════════════════════
//  CARER WELLBEING CHECK
// ════════════════════════════════════════════════════════════
export function _generateCarerWellbeingInsights(calls) {
  const insights = [];
  if (S.role !== 'carer' || calls.length < 5) return insights;

  const now = Date.now();
  const WEEK = 7 * 86400000;
  const thisWeek = calls.filter(c => c.timestamp >= now - WEEK);
  const lastWeek = calls.filter(c => c.timestamp >= now - 2*WEEK && c.timestamp < now - WEEK);

  // 1. Total calls responded to this week
  const responded = thisWeek.filter(c => c.ackName === S.name || c.ackUid === S.uid);
  if (responded.length >= 20) {
    insights.push({ icon: '💪', level: 'warn', text: `You responded to <strong>${responded.length} calls</strong> this week. That's a heavy load — consider sharing duties.` });
  }

  // 2. Compare to last week
  if (lastWeek.length) {
    const lastResponded = lastWeek.filter(c => c.ackName === S.name || c.ackUid === S.uid);
    if (responded.length > lastResponded.length * 1.5 && responded.length >= 10) {
      insights.push({ icon: '📈', level: 'warn', text: `Your call load is <strong>up ${Math.round(((responded.length - lastResponded.length) / Math.max(1, lastResponded.length)) * 100)}%</strong> from last week.` });
    }
  }

  // 3. Response time slowing (personal fatigue indicator)
  const myResponses = thisWeek.filter(c => (c.ackUid === S.uid) && c.ackAt && c.timestamp);
  if (myResponses.length >= 5) {
    const firstHalf = myResponses.slice(0, Math.floor(myResponses.length / 2));
    const secondHalf = myResponses.slice(Math.floor(myResponses.length / 2));
    const avgFirst = firstHalf.reduce((s, c) => s + (c.ackAt - c.timestamp), 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, c) => s + (c.ackAt - c.timestamp), 0) / secondHalf.length;
    if (avgSecond > avgFirst * 1.5) {
      insights.push({ icon: '⏱️', level: 'warn', text: `Your response time is getting slower this week (${formatDuration(avgFirst)} → ${formatDuration(avgSecond)}). You might be fatigued.` });
    }
  }

  // 4. Long on-duty stretches
  const availHours = parseInt(localStorage.getItem('carecall_avail_hours') || '0');
  if (availHours > 14) {
    insights.push({ icon: '🌙', level: 'warn', text: `You've been on-call for <strong>${availHours}+ hours</strong> today. Consider switching to Off Duty for rest.` });
  }

  // 5. Positive feedback
  if (!insights.length && responded.length) {
    insights.push({ icon: '💚', level: 'good', text: `Great work — ${responded.length} calls responded to this week with no signs of strain.` });
  }

  return insights;
}

// Track on-duty hours
export function _trackAvailHours() {
  if (S.role !== 'carer') return;
  setInterval(() => {
    if (_carerAvailability === 'available' || _carerAvailability === 'busy') {
      const hrs = parseInt(localStorage.getItem('carecall_avail_hours') || '0') + 1;
      localStorage.setItem('carecall_avail_hours', hrs);
    }
  }, 3600000); // track hourly
  // Reset at midnight
  const now = new Date();
  const midnight = new Date(now); midnight.setHours(24, 0, 0, 0);
  setTimeout(() => {
    localStorage.setItem('carecall_avail_hours', '0');
    setInterval(() => localStorage.setItem('carecall_avail_hours', '0'), 86400000);
  }, midnight - now);
}

