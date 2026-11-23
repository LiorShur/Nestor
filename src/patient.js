// ════════════════════════════════════════════════════════════
//  PATIENT — voice notes, patient logic, check-ins, DMS, voice activation, location, care notes
// ════════════════════════════════════════════════════════════
import { S, PS, CS } from './state.js';

// ════════════════════════════════════════════════════════════
//  VOICE NOTES
// ════════════════════════════════════════════════════════════
export let _vnRecorder = null;
export let _vnChunks = [];
export let _vnBlob = null;
export let _vnBase64 = null;
export let _vnRecording = false;
export const VN_MAX_SECONDS = 15;
export const VN_MIN_MS = 500; // minimum recording duration
export let _vnTimeout = null;
export let _vnStartTime = 0;

export function _getRecorderMimeType() {
  // Pick a supported mime type (Safari doesn't support webm)
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', ''];
  for (const t of types) {
    if (!t || MediaRecorder.isTypeSupported(t)) return t || undefined;
  }
  return undefined;
}

export async function _voiceNoteDown(evt) {
  evt.preventDefault();
  if (_vnRecording) return;
  try {
    if (!navigator.mediaDevices) { toast(t("Microphone access required")); return; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = _getRecorderMimeType();
    const options = mimeType ? { mimeType } : {};
    _vnRecorder = new MediaRecorder(stream, options);
    _vnChunks = [];
    _vnStartTime = Date.now();

    _vnRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) _vnChunks.push(e.data); };

    _vnRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const duration = Date.now() - _vnStartTime;
      if (_vnChunks.length === 0 || duration < VN_MIN_MS) {
        toast(t('Hold longer to record a voice note'));
        document.getElementById('voice-note-btn').classList.remove('recording');
        document.getElementById('vn-icon').textContent = '🎙️';
        document.getElementById('vn-label').textContent = t('Voice Note');
        return;
      }
      const blobType = _vnRecorder.mimeType || 'audio/webm';
      _vnBlob = new Blob(_vnChunks, { type: blobType });
      const reader = new FileReader();
      reader.onloadend = () => {
        _vnBase64 = reader.result;
        const secs = Math.round(duration / 1000);
        document.getElementById('vn-recorded-text').textContent = `Voice note (${secs}s)`;
        document.getElementById('vn-recorded').classList.add('show');
        document.getElementById('voice-note-btn').classList.add('has-note');
        document.getElementById('voice-note-btn').classList.remove('recording');
        document.getElementById('vn-icon').textContent = '✅';
        document.getElementById('vn-label').textContent = t('Recorded');
        toast(t('Voice note recorded') + ' (' + secs + 's)');
      };
      reader.readAsDataURL(_vnBlob);
    };

    // Use timeslice to get data during recording (not just on stop)
    _vnRecorder.start(250);
    _vnRecording = true;
    document.getElementById('voice-note-btn').classList.add('recording');
    document.getElementById('vn-icon').textContent = '⏺️';
    document.getElementById('vn-label').textContent = t('Recording…');
    if (navigator.vibrate) navigator.vibrate(50);
    // Show elapsed time on the label
    let vnSec = 0;
    _registerTick('vnTimer', () => {
      vnSec++;
      const lbl = document.getElementById('vn-label');
      if (lbl && _vnRecording) lbl.textContent = '⏺️ ' + vnSec + 's';
    });

    _vnTimeout = setTimeout(() => {
      toast(t('Voice note recorded') + ' — max 15s');
      _voiceNoteUp(evt);
    }, VN_MAX_SECONDS * 1000);
  } catch(e) {
    console.error('[VoiceNote] Error:', e);
    toast(t('Microphone access required for voice notes'));
  }
}

export function _voiceNoteUp(evt) {
  if (evt && evt.preventDefault) evt.preventDefault();
  clearTimeout(_vnTimeout);
  _unregisterTick('vnTimer');
  if (_vnRecorder && _vnRecording) {
    _vnRecording = false;
    _vnRecorder.stop();
    if (navigator.vibrate) navigator.vibrate([50, 30, 50]); // double tap = stopped
  }
}

export function playVoiceNote() {
  if (!_vnBlob) return;
  const audio = new Audio(URL.createObjectURL(_vnBlob));
  audio.play().catch(() => toast(t('Could not play audio')));
}

export function clearVoiceNote() {
  _vnBlob = null; _vnBase64 = null; _vnChunks = []; _vnStartTime = 0;
  document.getElementById('vn-recorded').classList.remove('show');
  const btn = document.getElementById('voice-note-btn');
  btn.classList.remove('has-note', 'recording');
  document.getElementById('vn-icon').textContent = '🎙️';
  document.getElementById('vn-label').textContent = t('Voice Note');
}

export function playAlertVoiceNote() {
  const vnBtn = document.getElementById('ia-vn-btn');
  if (!vnBtn._voiceNote) return;
  const audio = new Audio(vnBtn._voiceNote);
  audio.play().catch(() => toast(t('Could not play voice note')));
}

// ── Speech-to-text dictation for custom message ──
export let _dictationRecognition = null;
export let _dictating = false;

export function toggleDictation() {
  if (_dictating) {
    _stopDictation();
  } else {
    _startDictation();
  }
}

export async function _startDictation() {
  const input = document.getElementById('custom-msg');
  const btn = document.getElementById('dictate-btn');

  if (IS_NATIVE) {
    // Use Capacitor speech recognition plugin
    try {
      const { SpeechRecognition } = window.Capacitor.Plugins;
      if (!SpeechRecognition) { _startWebDictation(); return; }
      const perm = await SpeechRecognition.requestPermissions();
      if (perm.speechRecognition !== 'granted') { toast(t('Microphone access required')); return; }

      await SpeechRecognition.removeAllListeners();
      const SPEECH_LOCALES = { en:'en-US', es:'es-ES', zh:'zh-CN', hi:'hi-IN', ar:'ar-SA', he:'he-IL', ru:'ru-RU', fr:'fr-FR', am:'am-ET' };
      await SpeechRecognition.start({ language: SPEECH_LOCALES[_currentLang] || 'en-US', partialResults: true, popup: false });

      _dictating = true;
      btn.classList.add('active');

      SpeechRecognition.addListener('partialResults', (data) => {
        if (data.matches && data.matches.length) {
          input.value = data.matches[0];
        }
      });

      SpeechRecognition.addListener('listeningState', (state) => {
        if (state.status === 'stopped') _stopDictation();
      });
    } catch(e) { _startWebDictation(); }
  } else {
    _startWebDictation();
  }
}

export function _startWebDictation() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { toast('Speech recognition not available'); return; }

  const input = document.getElementById('custom-msg');
  const btn = document.getElementById('dictate-btn');

  _dictationRecognition = new SpeechRecognition();
  _dictationRecognition.continuous = false;
  _dictationRecognition.interimResults = true;
  const SPEECH_LOCALES = { en:'en-US', es:'es-ES', zh:'zh-CN', hi:'hi-IN', ar:'ar-SA', he:'he-IL', ru:'ru-RU', fr:'fr-FR', am:'am-ET' };
  _dictationRecognition.lang = SPEECH_LOCALES[_currentLang] || 'en-US';

  _dictating = true;
  btn.classList.add('active');

  _dictationRecognition.onresult = (event) => {
    let transcript = '';
    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    input.value = transcript;
  };

  _dictationRecognition.onend = () => _stopDictation();
  _dictationRecognition.onerror = () => _stopDictation();

  try { _dictationRecognition.start(); } catch(e) { _stopDictation(); }
}

export function _stopDictation() {
  _dictating = false;
  document.getElementById('dictate-btn')?.classList.remove('active');
  if (IS_NATIVE) {
    try {
      const { SpeechRecognition } = window.Capacitor.Plugins;
      if (SpeechRecognition) { SpeechRecognition.stop(); SpeechRecognition.removeAllListeners(); }
    } catch(e) {}
  }
  if (_dictationRecognition) { try { _dictationRecognition.stop(); } catch(e) {} _dictationRecognition = null; }
}

export function playCallVoiceNote(callId) {
  const call = CS.activeCalls[callId];
  if (!call || !call.voiceNote) return;
  const audio = new Audio(call.voiceNote);
  audio.play().catch(() => toast(t('Could not play voice note')));
}

// ════════════════════════════════════════════════════════════
//  PATIENT LOGIC
// ════════════════════════════════════════════════════════════
export function startPatient() {
  setPatientStatus('connecting');

  // ── Start scheduled check-ins, medication timers, and inactivity monitor ──
  _loadDmsSettings();
  _startDmsMonitor();
  _loadSafeZones();
  _loadZoneEvents();
  _loadZoneSnooze();
  _loadDwellLog();
  _startGeoFenceWatch();
  _refreshPatientZonePill();
  // Tick every minute so the mute timer expires cleanly in the pill
  // without needing a new location event first.
  setInterval(() => {
    if (!_zoneSnoozeActive() && localStorage.getItem('carecall_zone_snooze')) {
      localStorage.removeItem('carecall_zone_snooze');
      _logZoneEvent({ event: 'snooze_end', ts: Date.now() });
      _refreshPatientZonePill();
      toast(t('Safe Zone alerts resumed'));
    }
    _refreshPatientZonePill();
  }, 60 * 1000);
  _listenForAmbientRequests();
  startCheckinSchedule();
  _loadMedications();
  _scheduleAllMedNotifications();

  // ── Load settings from Firebase (carer may have configured remotely) ──
  if (S.uid) {
    // Medications
    db.ref(`carecall/users/${S.uid}/medications`).on('value', snap => {
      const meds = snap.val();
      if (meds && Array.isArray(meds)) {
        _medications = _normalizeMeds(meds);
        localStorage.setItem('carecall_meds', JSON.stringify(_medications));
        _scheduleAllMedNotifications();
      }
    });
    // Check-in settings
    db.ref(`carecall/users/${S.uid}/checkinSettings`).on('value', snap => {
      const cfg = snap.val();
      if (cfg) {
        CHECKIN.intervalMs = cfg.interval || 0;
        CHECKIN.startHour  = cfg.startHour ?? 8;
        CHECKIN.endHour    = cfg.endHour ?? 22;
        CHECKIN.timeoutMs  = cfg.timeout || 300000;
        _saveCheckinSettings();
        if (CHECKIN.intervalMs) startCheckinSchedule(); else stopCheckinSchedule();
      }
    });
  }

  // ── Firebase connectivity → enables the call button ──────
  // The button is ready as soon as we have a DB connection.
  // Carer presence is shown as an indicator only — the FCM push
  // will wake the carer even if they appear offline.
  db.ref('.info/connected').on('value', snap => {
    if (PS.status === 'calling' || PS.status === 'acked') return;
    setPatientStatus(snap.val() ? 'ready' : 'connecting');
  });

  // ── Carer presence — aggregate carers from ALL rooms ──
  // Clean up old listeners first (prevents stacking when called again)
  if (PS._memberRefs) PS._memberRefs.forEach(ref => ref.off());
  PS._memberRefs = [];
  PS._roomMembersCache = {};
  S.rooms.forEach(roomCode => {
    const ref = db.ref(`carecall/rooms/${roomCode}/members`);
    ref.on('value', snap => {
      PS._roomMembersCache[roomCode] = snap.val() || {};
      _rebuildPatientCarerList();
      _refreshSettingsConnectionsIfVisible();
    });
    PS._memberRefs.push(ref);
  });

  // ── Listen for ack on active call ──
  watchForAck();
}

export let _rebuildCarerTimer = null;
export function _rebuildPatientCarerList() {
  if (_rebuildCarerTimer) return;
  _rebuildCarerTimer = setTimeout(() => { _rebuildCarerTimer = null; _rebuildPatientCarerListNow(); }, 300);
}
export function _rebuildPatientCarerListNow() {
  // Aggregate carers across all rooms, dedup by uid (prefer online entry)
  const carerMap = {};
  Object.entries(PS._roomMembersCache || {}).forEach(([roomCode, members]) => {
    Object.entries(members).forEach(([uid, m]) => {
      if (m.role === 'carer') {
        if (!carerMap[uid] || (m.online && !carerMap[uid].online)) {
          carerMap[uid] = { uid, name: m.name, online: m.online, room: roomCode, phone: m.phone || null, availability: m.availability || 'available' };
        }
      }
    });
  });
  const carers = Object.values(carerMap);
  PS.allCarers = carers;
  // Cache for offline fallback — so phone/SMS buttons work even with no internet
  if (carers.length) localStorage.setItem('carecall_carers_cache', JSON.stringify(carers));

  // Update dropdown with carers from all rooms (tappable for selection)
  const dropdownMembers = {};
  carers.forEach(c => { dropdownMembers[c.uid] = { name: c.name, online: c.online, role: 'carer', _room: c.room, availability: c.availability || 'available' }; });
  renderRoomDropdown('p', dropdownMembers);

  // Update badge label to show selected carer name or "My Carers"
  const label = document.getElementById('p-room-label');
  if (PS.selectedCarerUid) {
    const sel = carers.find(c => c.uid === PS.selectedCarerUid);
    label.textContent = sel ? sel.name : t('My Carers');
  } else {
    label.textContent = carers.length === 1 ? carers[0].name : t('My Carers');
  }

  // Update connection pill
  if (PS.status !== 'calling' && PS.status !== 'acked' && PS.status === 'ready') {
    const carerOnline = carers.some(c => c.online);
    const pill = document.getElementById('p-conn-pill');
    const txt  = document.getElementById('p-conn-txt');
    if (carerOnline) {
      pill.className = 'conn-pill online'; txt.textContent = t('Carer online');
    } else {
      pill.className = 'conn-pill online'; txt.textContent = t('Carer notified by push');
    }
  }
}

export function setPatientStatus(status) {
  const btn  = document.getElementById('main-call-btn');
  const icon = document.getElementById('mcb-icon');
  const lbl  = document.getElementById('mcb-label');
  const pill = document.getElementById('p-conn-pill');
  const txt  = document.getElementById('p-conn-txt');

  btn.className = 'main-call-btn';
  pill.className = 'conn-pill';

  const fallback = document.getElementById('offline-fallback');

  if (status === 'connecting') {
    btn.classList.add('offline'); icon.textContent='📵'; lbl.textContent=t('No Connection');
    pill.classList.add('offline'); txt.textContent=t('Connecting…');
    _renderOfflineFallback(fallback);
    // Override the onclick when offline to show explicit warning
    btn.onclick = () => {
      if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
      _showOfflineCallWarning();
    };
  }
  if (status === 'ready') {
    icon.textContent='🆘'; lbl.textContent=t('Call for Help');
    pill.classList.add('online'); txt.textContent=t('Carer notified by push');
    fallback.classList.remove('show');
    btn.onclick = patientCallMain; // restore normal handler
  }
  if (status === 'calling') {
    btn.classList.add('calling'); icon.textContent='📞'; lbl.textContent=t('Calling…');
    pill.classList.add('calling'); txt.textContent=t('Calling carer…');
  }
  if (status === 'acked') {
    btn.classList.add('acked'); icon.textContent='✅'; lbl.textContent=t('Help Coming');
    pill.classList.add('online'); txt.textContent=t('Help on the way');
  }
  PS.status = status;
}

export function selectNeed(btn) {
  const type = btn.dataset.type;
  // Toggle this need in/out of the selection set
  if (PS.selectedNeeds.has(type)) {
    PS.selectedNeeds.delete(type);
    btn.classList.remove('selected');
  } else {
    PS.selectedNeeds.add(type);
    btn.classList.add('selected');
  }
  // Show custom text input only when 'custom' is selected
  const customRow = document.getElementById('custom-input-row');
  if (PS.selectedNeeds.has('custom')) {
    customRow.classList.add('show');
    document.getElementById('custom-msg').focus();
  } else {
    customRow.classList.remove('show');
  }
}

// ── Carer selection from dropdown (patient screen) ──
export function _selectCarer(uid, room) {
  PS.selectedCarerUid = uid;
  PS.selectedCarerRoom = room;
  // Close dropdown
  document.getElementById('p-room-dropdown').classList.remove('show');
  // Rebuild to update UI
  _rebuildPatientCarerList();
}

// ── Offline fallback: cellular call/text ──
export function _showOfflineCallWarning() {
  // Get cached carers with phone numbers
  let carerList = PS.allCarers || [];
  if (!carerList.length) { try { carerList = JSON.parse(localStorage.getItem('carecall_carers_cache') || '[]'); } catch(e) {} }
  const withPhone = carerList.filter(c => c.phone);

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:30;display:flex;align-items:center;justify-content:center;padding:16px';
  let btns = '';
  if (withPhone.length) {
    btns = withPhone.map(c => `<a href="tel:${c.phone}" style="display:block;background:var(--patient-primary);color:#fff;border:none;border-radius:14px;padding:16px;font-size:1.1rem;font-weight:700;font-family:'Outfit',sans-serif;text-decoration:none;text-align:center;margin-top:8px">📞 ${t('Call')} ${escHtml(c.name)}</a>`).join('');
  } else {
    btns = `<div style="color:#999;font-size:0.9rem;margin-top:8px">${t('No phone numbers available')}</div>`;
  }
  overlay.innerHTML = `
    <div style="background:var(--patient-surface,#F5EDE3);border-radius:20px;padding:24px;max-width:320px;width:100%;text-align:center;color:var(--patient-text,#3D2E1E)">
      <div style="font-size:2.5rem;margin-bottom:8px">📵</div>
      <div style="font-family:'Fraunces',serif;font-size:1.3rem;font-weight:700;color:var(--danger)">${t('No Connection')}</div>
      <div style="font-size:0.9rem;margin-top:6px;opacity:0.8">${t('No internet — use phone instead')}</div>
      ${btns}
      <button onclick="this.closest('div[style*=fixed]').remove()" style="margin-top:12px;background:rgba(0,0,0,0.06);border:none;border-radius:12px;padding:12px 24px;color:#666;font-size:0.9rem;font-weight:600;font-family:'Outfit',sans-serif;cursor:pointer">Close</button>
    </div>`;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

export function _renderOfflineFallback(container) {
  const btns = document.getElementById('offline-fallback-btns');
  btns.innerHTML = '';
  // Get carers with phone numbers — use live data or localStorage cache
  let carerList = PS.allCarers || [];
  if (!carerList.length) {
    try { carerList = JSON.parse(localStorage.getItem('carecall_carers_cache') || '[]'); } catch(e) {}
  }
  const carersWithPhone = carerList.filter(c => c.phone);
  if (!carersWithPhone.length) {
    container.classList.remove('show');
    return;
  }
  container.classList.add('show');
  carersWithPhone.forEach(carer => {
    const callLink = document.createElement('a');
    callLink.className = 'offline-call-btn';
    callLink.href = `tel:${carer.phone}`;
    callLink.innerHTML = `📞 Call ${escHtml(carer.name)}`;
    btns.appendChild(callLink);

    const smsLink = document.createElement('a');
    smsLink.className = 'offline-text-btn';
    smsLink.href = `sms:${carer.phone}?body=${encodeURIComponent(`${S.name || 'Patient'} needs help! (CareCall offline alert)`)}`;
    smsLink.innerHTML = `💬 Text`;
    btns.appendChild(smsLink);
  });
}

// ── Room badge dropdown (shows members on tap) ──
export function toggleRoomDropdown(prefix) {
  const badge = document.getElementById(prefix + '-room-badge');
  const dd = document.getElementById(prefix + '-room-dropdown');
  dd.classList.toggle('show');
  if (dd.classList.contains('show')) {
    // Position dropdown below the badge
    const rect = badge.getBoundingClientRect();
    dd.style.top = (rect.bottom + 4) + 'px';
    dd.style.right = (window.innerWidth - rect.right) + 'px';
    // Close on next outside tap
    setTimeout(() => {
      document.addEventListener('click', function _close(e) {
        if (!badge.contains(e.target) && !dd.contains(e.target)) { dd.classList.remove('show'); }
        document.removeEventListener('click', _close);
      });
    }, 0);
  }
}

export function renderRoomDropdown(prefix, members) {
  const dd = document.getElementById(prefix + '-room-dropdown');
  if (!dd) return;
  dd.innerHTML = '';
  let entries = Object.entries(members);
  // Patient side: only show carers
  if (prefix === 'p') entries = entries.filter(([, m]) => m.role === 'carer');
  if (!entries.length) {
    dd.innerHTML = '<div class="rbd-item" style="color:#999">No connections yet</div>';
    return;
  }

  if (prefix === 'p' && entries.length > 1) {
    // "All carers" option
    const allItem = document.createElement('div');
    allItem.className = `rbd-item rbd-selectable${PS.selectedCarerUid === null ? ' rbd-selected' : ''}`;
    allItem.innerHTML = '<div class="rbd-dot online"></div>All carers';
    allItem.onclick = (e) => { e.stopPropagation(); _selectCarer(null, null); };
    dd.appendChild(allItem);
  }

  entries.forEach(([uid, m]) => {
    const isMe = uid === S.uid;
    const item = document.createElement('div');
    if (prefix === 'p') {
      // Patient side: tappable carer selection with availability
      const isSel = PS.selectedCarerUid === uid || (entries.length === 1);
      const avail = m.availability || 'available';
      const dotClass = avail === 'available' ? 'online' : (avail === 'busy' ? 'busy' : 'offline');
      const availLabel = avail !== 'available' ? `<span class="rbd-avail rbd-avail-${avail}">${avail}</span>` : '';
      item.className = `rbd-item rbd-selectable${isSel ? ' rbd-selected' : ''}`;
      item.innerHTML = `<div class="rbd-dot ${dotClass}"></div>${escHtml(m.name)}${availLabel}`;
      item.onclick = (e) => { e.stopPropagation(); _selectCarer(uid, m._room); };
    } else {
      // Carer side: display only
      item.className = 'rbd-item';
      item.innerHTML = `<div class="rbd-dot ${m.online ? 'online' : 'offline'}"></div>` +
        `${escHtml(m.name)}${isMe ? ' (me)' : ''}` +
        `<span class="rbd-role">${m.role}</span>`;
    }
    dd.appendChild(item);
  });
}

export const ESCALATION_DELAY_MS = 120000; // 2 minutes between tiers

export async function patientCallMain() {
  if (PS.status === 'connecting' || PS.status === 'calling' || PS.status === 'acked') return;
  PS.status = 'calling'; // synchronous guard to prevent duplicate taps
  unlockAudio();

  const selectedArr = [...PS.selectedNeeds];
  const type    = selectedArr.length ? selectedArr.join(',') : 'help';
  const message = PS.selectedNeeds.has('custom') ? (document.getElementById('custom-msg').value.trim() || '') : '';

  if (!S.rooms.length) {
    toast(t('No carers connected — add a carer first'));
    PS.status = 'idle';
    return;
  }

  setPatientStatus('calling');
  if (navigator.vibrate) navigator.vibrate(200);

  const callData = {
    fromUid:   S.uid,
    fromName:  S.name,
    avatar:    S.avatar || '',
    type:      type,
    message:   message,
    timestamp: firebase.database.ServerValue.TIMESTAMP,
    status:    'active',
  };
  // Attach voice note if recorded
  if (_vnBase64) {
    callData.voiceNote = _vnBase64;
    clearVoiceNote();
  }
  // Attach location if enabled
  await _attachLocation(callData);

  const isEmergency = type === 'fall';
  const specificCarer = PS.selectedCarerUid;

  try {
    if (isEmergency || specificCarer) {
      // ── IMMEDIATE: Emergency → all rooms, or specific carer → their room ──
      const roomsToCall = isEmergency
        ? S.rooms
        : [PS.selectedCarerRoom || S.activeRoom || S.rooms[0]];
      if (specificCarer) callData.targetUid = specificCarer;

      let firstCallId = null, firstCallRoom = null;
      for (const room of roomsToCall) {
        if (!room) continue;
        const callRef = db.ref(`carecall/rooms/${room}/calls`).push();
        await callRef.set({ ...callData, id: callRef.key });
        if (!firstCallId) { firstCallId = callRef.key; firstCallRoom = room; }
      }
      PS.activeCallId = firstCallId;
      PS._activeCallRoom = firstCallRoom;
      watchForAck();
      _setCallFinalTimeout();
    } else {
      // ── ESCALATION: Sort carers by priority, notify tier by tier ──
      const sortedCarers = _getCarersByPriority();
      if (!sortedCarers.length) {
        toast(t('No available carers'));
        setPatientStatus('ready');
        return;
      }
      PS._escalationCarers = sortedCarers;
      PS._escalationIndex = 0;
      PS._escalationCallData = callData;
      await _sendToEscalationTier(0);
      watchForAck();
      // Final timeout after all tiers exhausted
      const totalTimeout = ESCALATION_DELAY_MS * sortedCarers.length + 30000;
      PS._callTimeout = setTimeout(() => {
        _clearEscalation();
        if (PS.status === 'calling') {
          setPatientStatus('ready');
          PS.activeCallId = null;
          if (PS.callListener) { PS.callListener(); PS.callListener = null; }
          _showNoResponseFallback();
        }
      }, totalTimeout);
    }
  } catch(e) {
    console.error('[Call] Failed:', e);
    toast(t('Call failed — check your connection'));
    setPatientStatus('ready');
  }
}

// Shared helper: sort an array of objects (each having a .uid) by the
// user's stored carer-priority order, preserving original order for
// entries not in the priority list.
export function _sortByCarerPriority(arr) {
  const priorityOrder = JSON.parse(localStorage.getItem('carecall_carer_priority') || '[]');
  arr.sort((a, b) => {
    const ai = priorityOrder.indexOf(a.uid);
    const bi = priorityOrder.indexOf(b.uid);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return 0;
  });
  return arr;
}

export function _getCarersByPriority() {
  const carers = (PS.allCarers || []).filter(c => c.availability !== 'off-duty');
  _sortByCarerPriority(carers);
  return carers;
}

export async function _sendToEscalationTier(tierIndex) {
  const carers = PS._escalationCarers;
  if (!carers || tierIndex >= carers.length) return;

  const carer = carers[tierIndex];
  const data = PS._escalationCallData;
  const room = carer.room;
  if (!room) return;

  console.log(`[Escalation] Tier ${tierIndex + 1}: notifying ${carer.name} in room ${room}`);
  const pillTxt = document.getElementById('p-conn-txt');
  const mainLbl = document.getElementById('mcb-label');
  if (tierIndex === 0) {
    if (pillTxt) pillTxt.textContent = t('Calling') + ' ' + carer.name + '…';
    if (mainLbl) mainLbl.textContent = t('Calling…');
  } else {
    if (pillTxt) pillTxt.textContent = t('Paging backup carer…');
    if (mainLbl) mainLbl.textContent = t('Paging backup carer…');
  }

  const callRef = db.ref(`carecall/rooms/${room}/calls`).push();
  await callRef.set({ ...data, id: callRef.key, targetUid: carer.uid });
  if (!PS.activeCallId) {
    PS.activeCallId = callRef.key;
    PS._activeCallRoom = room;
  }

  // Schedule next tier if no response
  clearTimeout(PS._escalationTimer);
  PS._escalationTimer = setTimeout(async () => {
    if (PS.status !== 'calling') return; // already acked
    const nextTier = tierIndex + 1;
    if (nextTier < carers.length) {
      toast(`No response from ${carer.name} — escalating to ${carers[nextTier].name}`);
      await _sendToEscalationTier(nextTier);
    } else {
      const pillTxtEl = document.getElementById('p-conn-txt');
      const mainLblEl = document.getElementById('mcb-label');
      if (pillTxtEl) pillTxtEl.textContent = t('All carers notified — waiting for response');
      if (mainLblEl) mainLblEl.textContent = t('All carers notified — waiting for response');
      toast(t('All carers notified — waiting for response'));
    }
  }, ESCALATION_DELAY_MS);
}

export function _clearEscalation() {
  clearTimeout(PS._escalationTimer);
  PS._escalationCarers = null;
  PS._escalationIndex = 0;
  PS._escalationCallData = null;
}

export function _setCallFinalTimeout() {
  PS._callTimeout = setTimeout(() => {
    if (PS.status === 'calling') {
      toast(t('No response yet — try calling again'));
      setPatientStatus('ready');
      PS.activeCallId = null;
      if (PS.callListener) { PS.callListener(); PS.callListener = null; }
    }
  }, CALL_FINAL_TIMEOUT_MS);
}

export function watchForAck() {
  if (!PS.activeCallId) return;
  if (PS.callListener) PS.callListener();
  // Watch all rooms we sent calls to — any ack from any room counts
  const cleanups = [];
  const roomsToWatch = (PS.selectedCarerUid === null && S.rooms.length > 1)
    ? S.rooms : [PS._activeCallRoom || S.activeRoom || S.rooms[0]];
  let acked = false;
  roomsToWatch.forEach(roomId => {
    if (!roomId) return;
    // Watch all recent active calls in this room from this patient
    const ref = db.ref(`carecall/rooms/${roomId}/calls`)
      .orderByChild('fromUid').equalTo(S.uid);
    ref.on('child_changed', snap => {
      const call = snap.val();
      if (!call || acked) return;
      if (call.status === 'acknowledged') {
        acked = true;
        showPatientAck(call);
      }
    });
    cleanups.push(() => ref.off());
  });
  PS.callListener = () => cleanups.forEach(fn => fn());
}

export function showPatientAck(call) {
  setPatientStatus('acked');
  clearTimeout(PS._callTimeout);
  _clearEscalation();
  if (PS.callListener) { PS.callListener(); PS.callListener = null; }

  document.getElementById('ack-who').textContent = `${call.ackName || t('Your carer')} ${t('Help on the way')}`;
  document.getElementById('ack-type').textContent = call.type !== 'help' ? needLabel(call.type) : '';
  document.getElementById('ack-overlay').classList.add('show');
  if (navigator.vibrate) navigator.vibrate([80,60,80,60,80]);

  // Auto-dismiss after 10s, or user can tap OK
  PS._ackDismissTimer = setTimeout(() => dismissAckOverlay(), 10000);
}

export function dismissAckOverlay() {
  clearTimeout(PS._ackDismissTimer);
  document.getElementById('ack-overlay').classList.remove('show');
  PS.activeCallId = null; PS._activeCallRoom = null;
  PS.selectedNeeds = new Set();
  document.querySelectorAll('.need-btn').forEach(b=>b.classList.remove('selected'));
  document.getElementById('custom-input-row').classList.remove('show');
  document.getElementById('custom-msg').value = '';
  setPatientStatus('ready');
}


// ════════════════════════════════════════════════════════════
//  SCHEDULED CHECK-INS
// ════════════════════════════════════════════════════════════
export const CHECKIN = {
  intervalMs:  0,       // 0 = disabled
  startHour:   8,       // active hours start
  endHour:     22,      // active hours end
  timeoutMs:   300000,  // 5 min response window
  _timer:      null,
  _promptTimer:null,
  _countdownTimer: null,
  _active:     false,
};

export const CHECKIN_INTERVALS = [0, 3600000, 7200000, 14400000, 28800000]; // off, 1h, 2h, 4h, 8h
export const CHECKIN_INTERVAL_LABELS = ['Off', '1 hour', '2 hours', '4 hours', '8 hours'];
export const CHECKIN_TIMEOUT_OPTIONS = [120000, 300000, 600000]; // 2min, 5min, 10min
export const CHECKIN_TIMEOUT_LABELS = ['2 min', '5 min', '10 min'];

export function _loadCheckinSettings() {
  try {
    const d = JSON.parse(localStorage.getItem('carecall_checkin') || 'null');
    if (d) {
      CHECKIN.intervalMs = d.interval || 0;
      CHECKIN.startHour  = d.startHour ?? 8;
      CHECKIN.endHour    = d.endHour ?? 22;
      CHECKIN.timeoutMs  = d.timeout || 300000;
    }
  } catch(e) {}
}

export function _saveCheckinSettings() {
  localStorage.setItem('carecall_checkin', JSON.stringify({
    interval:  CHECKIN.intervalMs,
    startHour: CHECKIN.startHour,
    endHour:   CHECKIN.endHour,
    timeout:   CHECKIN.timeoutMs,
  }));
  // Also save to Firebase so carers can configure remotely
  if (S.uid) {
    db.ref(`carecall/users/${S.uid}/checkinSettings`).set({
      interval:  CHECKIN.intervalMs,
      startHour: CHECKIN.startHour,
      endHour:   CHECKIN.endHour,
      timeout:   CHECKIN.timeoutMs,
    }).catch(e => console.warn('[_saveCheckinSettings] Firebase write failed:', e && e.message));
  }
}

export function startCheckinSchedule() {
  stopCheckinSchedule();
  _loadCheckinSettings();
  if (!CHECKIN.intervalMs || S.role !== 'patient') return;

  CHECKIN._active = true;
  _scheduleNextCheckin();
  console.log(`[Checkin] Started: every ${CHECKIN.intervalMs / 60000}min, ${CHECKIN.startHour}:00-${CHECKIN.endHour}:00`);
}

export function stopCheckinSchedule() {
  CHECKIN._active = false;
  clearTimeout(CHECKIN._timer);
  clearTimeout(CHECKIN._promptTimer);
  _unregisterTick('checkinCountdown');
  CHECKIN._timer = null;
  CHECKIN._promptTimer = null;
}

export function _scheduleNextCheckin() {
  if (!CHECKIN._active) return;
  clearTimeout(CHECKIN._timer);

  // Calculate delay: if outside active hours, schedule for next active period
  const now = new Date();
  const hour = now.getHours();
  let delayMs = CHECKIN.intervalMs;

  if (hour < CHECKIN.startHour) {
    // Before active hours — schedule for start of active hours
    const target = new Date(now); target.setHours(CHECKIN.startHour, 0, 0, 0);
    delayMs = target - now;
  } else if (hour >= CHECKIN.endHour) {
    // After active hours — schedule for next day's start
    const target = new Date(now); target.setDate(target.getDate() + 1); target.setHours(CHECKIN.startHour, 0, 0, 0);
    delayMs = target - now;
  }

  // Native: schedule a local notification for the check-in
  if (IS_NATIVE && delayMs > 0) {
    const checkinTime = new Date(Date.now() + delayMs);
    Native.cancelLocalNotification(20000);
    Native.scheduleLocalNotification({
      id: 20000,
      title: '👋 ' + t('Are you OK?'),
      body: t('Routine check-in'),
      at: checkinTime,
      channelId: 'carecall_reminders',
      data: { type: 'checkin' },
    });
  }

  CHECKIN._timer = setTimeout(() => {
    const h = new Date().getHours();
    if (h >= CHECKIN.startHour && h < CHECKIN.endHour) {
      _showCheckinPrompt();
    }
    _scheduleNextCheckin();
  }, delayMs);
}

export function _showCheckinPrompt() {
  if (PS.status === 'calling' || PS.status === 'acked') return; // don't interrupt active calls
  document.getElementById('checkin-prompt').classList.add('show');
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  unlockAudio();
  playBell(); // one bell tone to get attention

  // Start countdown display
  let remaining = Math.ceil(CHECKIN.timeoutMs / 1000);
  const cdEl = document.getElementById('checkin-countdown');
  cdEl.textContent = `Carers will be alerted in ${formatDuration(remaining * 1000)}`;
  _registerTick('checkinCountdown', () => {
    remaining--;
    if (remaining > 0) {
      cdEl.textContent = `Carers will be alerted in ${formatDuration(remaining * 1000)}`;
    } else {
      _unregisterTick('checkinCountdown');
    }
  });

  // Timeout: no response → alert carers
  CHECKIN._promptTimer = setTimeout(() => {
    document.getElementById('checkin-prompt').classList.remove('show');
    _unregisterTick('checkinCountdown');
    _sendCheckinAlert('checkin-missed', 'Missed scheduled check-in — no response');
  }, CHECKIN.timeoutMs);
}

export function respondCheckin(response) {
  clearTimeout(CHECKIN._promptTimer);
  _unregisterTick('checkinCountdown');
  document.getElementById('checkin-prompt').classList.remove('show');

  if (response === 'help') {
    _sendCheckinAlert('checkin-help', 'Patient requested help during check-in');
  } else {
    toast(t("Great — we'll check again later!"));
    // Log the OK response to Firebase for the dashboard
    if (S.activeRoom) {
      db.ref(`carecall/rooms/${S.activeRoom || S.rooms[0]}/checkins`).push({
        uid: S.uid, name: S.name, response: 'ok',
        timestamp: firebase.database.ServerValue.TIMESTAMP,
      });
    }
  }
}

export async function _sendCheckinAlert(type, message) {
  // Send to ALL carers (like a fall — this is urgent)
  const callData = {
    fromUid:   S.uid,
    fromName:  S.name,
    avatar:    S.avatar || '',
    type:      type,
    message:   message,
    timestamp: firebase.database.ServerValue.TIMESTAMP,
    status:    'active',
  };
  for (const room of S.rooms) {
    if (!room) continue;
    const callRef = db.ref(`carecall/rooms/${room}/calls`).push();
    await callRef.set({ ...callData, id: callRef.key });
  }
  toast(type === 'checkin-help' ? t('Calling your carers…') : t('Carers have been alerted'));
}

// ── Check-in settings UI (cycle buttons) ──
export function cycleCheckinInterval() {
  const i = CHECKIN_INTERVALS.indexOf(CHECKIN.intervalMs);
  CHECKIN.intervalMs = CHECKIN_INTERVALS[(i + 1) % CHECKIN_INTERVALS.length];
  _saveCheckinSettings();
  _refreshCheckinSettingsUI();
  // Restart schedule with new interval
  if (CHECKIN.intervalMs) startCheckinSchedule(); else stopCheckinSchedule();
}

export function cycleCheckinStart() {
  CHECKIN.startHour = (CHECKIN.startHour + 1) % 24;
  if (CHECKIN.startHour >= CHECKIN.endHour) CHECKIN.startHour = 0;
  _saveCheckinSettings();
  _refreshCheckinSettingsUI();
}

export function cycleCheckinEnd() {
  CHECKIN.endHour = (CHECKIN.endHour + 1) % 25 || 1;
  if (CHECKIN.endHour <= CHECKIN.startHour) CHECKIN.endHour = CHECKIN.startHour + 1;
  _saveCheckinSettings();
  _refreshCheckinSettingsUI();
}

export function cycleCheckinTimeout() {
  const i = CHECKIN_TIMEOUT_OPTIONS.indexOf(CHECKIN.timeoutMs);
  CHECKIN.timeoutMs = CHECKIN_TIMEOUT_OPTIONS[(i + 1) % CHECKIN_TIMEOUT_OPTIONS.length];
  _saveCheckinSettings();
  _refreshCheckinSettingsUI();
}

export function _refreshCheckinSettingsUI() {
  const intIdx = CHECKIN_INTERVALS.indexOf(CHECKIN.intervalMs);
  const btn = document.getElementById('checkin-interval-btn');
  if (btn) btn.textContent = CHECKIN_INTERVAL_LABELS[intIdx >= 0 ? intIdx : 0];

  const startBtn = document.getElementById('checkin-start-btn');
  if (startBtn) startBtn.textContent = _formatHour(CHECKIN.startHour);

  const endBtn = document.getElementById('checkin-end-btn');
  if (endBtn) endBtn.textContent = _formatHour(CHECKIN.endHour);

  const toIdx = CHECKIN_TIMEOUT_OPTIONS.indexOf(CHECKIN.timeoutMs);
  const toBtn = document.getElementById('checkin-timeout-btn');
  if (toBtn) toBtn.textContent = CHECKIN_TIMEOUT_LABELS[toIdx >= 0 ? toIdx : 1];
}

export function _formatHour(h) {
  if (h === 0 || h === 24) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}


// ════════════════════════════════════════════════════════════
//  DEAD MAN'S SWITCH (Inactivity Alert)
// ════════════════════════════════════════════════════════════
export const DMS_THRESHOLDS = [0, 3600000, 7200000, 14400000, 28800000, 43200000]; // off, 1h, 2h, 4h, 8h, 12h
export const DMS_LABELS = ['Off', '1 hour', '2 hours', '4 hours', '8 hours', '12 hours'];
export let _dmsThreshold = 0;
export let _dmsTimer = null;
export let _dmsLastActivity = Date.now();

export function _loadDmsSettings() {
  _dmsThreshold = parseInt(localStorage.getItem('carecall_dms') || '0');
}

export function cycleDmsThreshold() {
  const i = DMS_THRESHOLDS.indexOf(_dmsThreshold);
  _dmsThreshold = DMS_THRESHOLDS[(i + 1) % DMS_THRESHOLDS.length];
  localStorage.setItem('carecall_dms', _dmsThreshold);
  document.getElementById('dms-threshold-btn').textContent = DMS_LABELS[DMS_THRESHOLDS.indexOf(_dmsThreshold)];
  _startDmsMonitor();
}

export function _resetDmsActivity() {
  _dmsLastActivity = Date.now();
  if (_dmsThreshold && S.role === 'patient') _startDmsMonitor();
}

export function _startDmsMonitor() {
  clearTimeout(_dmsTimer);
  if (!_dmsThreshold || S.role !== 'patient') return;
  _dmsTimer = setTimeout(async () => {
    const h = new Date().getHours();
    if (h < 7 || h >= 22) { _startDmsMonitor(); return; } // skip nighttime
    // No activity for the threshold period — alert carers
    const callData = {
      fromUid: S.uid, fromName: S.name, avatar: S.avatar || '',
      type: 'checkin-missed', message: 'No phone activity detected for ' + DMS_LABELS[DMS_THRESHOLDS.indexOf(_dmsThreshold)],
      timestamp: firebase.database.ServerValue.TIMESTAMP, status: 'active',
    };
    for (const room of S.rooms) {
      if (!room) continue;
      const ref = db.ref(`carecall/rooms/${room}/calls`).push();
      await ref.set({ ...callData, id: ref.key });
    }
    toast(t('Carers alerted — no activity detected'));
    _startDmsMonitor(); // reschedule
  }, _dmsThreshold);
}

// Track any user interaction as "activity"
['click', 'touchstart', 'keydown', 'scroll'].forEach(evt => {
  document.addEventListener(evt, _resetDmsActivity, { passive: true });
});


// ════════════════════════════════════════════════════════════
//  VOICE-ACTIVATED CALLING
// ════════════════════════════════════════════════════════════
export let _voiceListening = false;
export let _speechRecognition = null;
export let _voiceSessionTimer = null;
export let _voiceDurationSec = 20; // default 20 seconds
export const VOICE_DURATIONS = [10, 20, 30, 60];

export function startVoiceListener() {
  if (_voiceListening) return;
  _voiceListening = true;
  _voiceRestartCount = 0;
  document.getElementById('voice-toggle')?.classList.add('active');
  document.getElementById('voice-indicator')?.classList.add('show');
  toast(t('Voice activation ON') + ` (${_voiceDurationSec}s)`);

  // Auto-stop after the configured duration
  clearTimeout(_voiceSessionTimer);
  _voiceSessionTimer = setTimeout(() => {
    if (_voiceListening) {
      stopVoiceListener();
      toast(t('Voice activation OFF'));
    }
  }, _voiceDurationSec * 1000);

  if (IS_NATIVE) {
    _startNativeSpeech();
  } else {
    _startWebSpeech();
  }
}

export let _voiceRestartCount = 0;
export const MAX_VOICE_RESTARTS = 500; // high limit — native restarts are silent

// ── Native speech recognition (Capacitor plugin) ──
// Android's SpeechRecognizer stops after ~5s of silence. We restart
// silently by removing old listeners before each restart to prevent
// stacking, and muting/unmuting to suppress the system beep.
export async function _startNativeSpeech() {
  if (!_voiceListening) return;
  try {
    const { SpeechRecognition } = window.Capacitor.Plugins;
    if (!SpeechRecognition) { _startWebSpeech(); return; }

    // Only request permission on first start
    if (_voiceRestartCount === 0) {
      const perm = await SpeechRecognition.requestPermissions();
      if (perm.speechRecognition !== 'granted') { toast(t('Microphone access required')); stopVoiceListener(); return; }
    }

    // Remove old listeners before adding new ones (prevent stacking)
    await SpeechRecognition.removeAllListeners();

    const SPEECH_LOCALES = { en:'en-US', es:'es-ES', zh:'zh-CN', hi:'hi-IN', ar:'ar-SA', he:'he-IL', ru:'ru-RU', fr:'fr-FR', am:'am-ET' };

    await SpeechRecognition.start({
      language: SPEECH_LOCALES[_currentLang] || 'en-US',
      partialResults: true,
      popup: false,
      maxResults: 5,
    });

    SpeechRecognition.addListener('partialResults', (data) => {
      if (!data.matches || !data.matches.length) return;
      _voiceRestartCount = 0; // reset on any speech detected
      const transcript = data.matches[0].toLowerCase().trim();
      console.log('[Voice Native] Heard:', transcript);
      const cmd = _parseVoiceCommand(transcript);
      if (!cmd) return;
      if (navigator.vibrate) navigator.vibrate(200);
      stopVoiceListener();
      if (cmd.type === 'emergency') {
        toast(t('Emergency Alert') + ' — ' + transcript);
        _onFallDetected(t('Emergency Alert'));
      } else if (cmd.type === 'call') {
        toast(t('Call Carer') + (cmd.need ? ' — ' + needLabel(cmd.need) : ''));
        _voiceCallCarer(cmd.need);
      }
    });

    SpeechRecognition.addListener('listeningState', (state) => {
      if (state.status === 'stopped' && _voiceListening) {
        _voiceRestartCount++;
        if (_voiceRestartCount > MAX_VOICE_RESTARTS) {
          console.warn('[Voice] Too many restarts, stopping');
          stopVoiceListener();
          toast(t('Voice activation OFF'));
          return;
        }
        // Quick restart — native plugin doesn't produce beeps
        setTimeout(() => { if (_voiceListening) _startNativeSpeech(); }, 300);
      }
    });

  } catch(e) {
    console.warn('[Voice Native] Error:', e.message);
    // Retry native before falling back to web
    _voiceRestartCount++;
    if (_voiceRestartCount < 5 && _voiceListening) {
      setTimeout(() => _startNativeSpeech(), 500);
    } else {
      _startWebSpeech();
    }
  }
}

// ── Web speech recognition (fallback for PWA — has system beeps on Android) ──
export function _startWebSpeech() {
  if (!_voiceListening) return;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { toast('Voice recognition not available'); stopVoiceListener(); return; }

  _speechRecognition = new SpeechRecognition();
  _speechRecognition.continuous = true;
  _speechRecognition.interimResults = true;
  const SPEECH_LOCALES = { en:'en-US', es:'es-ES', zh:'zh-CN', hi:'hi-IN', ar:'ar-SA', he:'he-IL', ru:'ru-RU', fr:'fr-FR', am:'am-ET' };
  _speechRecognition.lang = SPEECH_LOCALES[_currentLang] || 'en-US';

  _speechRecognition.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    if (!result.isFinal) return;
    const transcript = result[0].transcript.toLowerCase().trim();
    const cmd = _parseVoiceCommand(transcript);
    if (!cmd) return;
    if (navigator.vibrate) navigator.vibrate(200);
    stopVoiceListener();
    if (cmd.type === 'emergency') {
      toast(t('Emergency Alert') + ' — ' + transcript);
      _onFallDetected(t('Emergency Alert'));
    } else if (cmd.type === 'call') {
      toast(t('Call Carer') + (cmd.need ? ' — ' + needLabel(cmd.need) : ''));
      _voiceCallCarer(cmd.need);
    }
  };

  _speechRecognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
  };

  _speechRecognition.onend = () => {
    if (!_voiceListening) return;
    _voiceRestartCount++;
    if (_voiceRestartCount > MAX_VOICE_RESTARTS) {
      stopVoiceListener();
      toast(t('Voice activation OFF'));
      return;
    }
    setTimeout(() => { if (_voiceListening) _startWebSpeech(); }, 5000);
  };

  try { _speechRecognition.start(); } catch(e) {
    _voiceRestartCount++;
    if (_voiceRestartCount > MAX_VOICE_RESTARTS || !_voiceListening) { stopVoiceListener(); return; }
    setTimeout(() => { if (_voiceListening) _startWebSpeech(); }, 5000);
  }
}

export function stopVoiceListener() {
  _voiceListening = false;
  clearTimeout(_voiceSessionTimer);
  if (IS_NATIVE) {
    try {
      const { SpeechRecognition } = window.Capacitor.Plugins;
      if (SpeechRecognition) { SpeechRecognition.stop(); SpeechRecognition.removeAllListeners(); }
    } catch(e) {}
  }
  if (_speechRecognition) { try { _speechRecognition.stop(); } catch(e) {} _speechRecognition = null; }
  document.getElementById('voice-toggle')?.classList.remove('active');
  document.getElementById('voice-indicator')?.classList.remove('show');
}

export function cycleVoiceDuration() {
  const i = VOICE_DURATIONS.indexOf(_voiceDurationSec);
  _voiceDurationSec = VOICE_DURATIONS[(i + 1) % VOICE_DURATIONS.length];
  const el = document.getElementById('voice-dur-label');
  if (el) el.textContent = _voiceDurationSec + 's';
  toast(t('Voice activation') + ': ' + _voiceDurationSec + 's');
}

export function toggleVoiceActivation() {
  if (_voiceListening) {
    stopVoiceListener();
    toast(t('Voice activation OFF'));
  } else {
    startVoiceListener();
  }
}

// ── Voice command parser — multi-language need recognition ──
export const VOICE_COMMANDS = {
  emergency: {
    en: ['emergency', 'help me', 'i need help', 'sos', 'hey carecall'],
    es: ['emergencia', 'ayuda', 'necesito ayuda', 'socorro'],
    zh: ['紧急', '帮助', '救命', '帮帮我'],
    hi: ['आपातकाल', 'मदद', 'बचाओ', 'मुझे मदद चाहिए'],
    ar: ['طوارئ', 'مساعدة', 'ساعدوني', 'النجدة'],
    he: ['חירום', 'עזרה', 'הצילו', 'עזרו לי'],
    ru: ['помощь', 'помогите', 'экстренная', 'скорая'],
    fr: ['urgence', 'aide', 'aidez-moi', 'au secours'],
    am: ['አደጋ', 'እርዳታ', 'አዳኑኝ'],
  },
  water: {
    en: ['water', 'thirsty', 'drink', 'i need water'],
    es: ['agua', 'sed', 'tengo sed'],
    zh: ['水', '渴', '喝水'],
    hi: ['पानी', 'प्यास', 'पानी चाहिए'],
    ar: ['ماء', 'عطشان', 'أريد ماء'],
    he: ['מים', 'צמא', 'אני צמא'],
    ru: ['воду', 'вода', 'пить', 'хочу пить'],
    fr: ['eau', 'soif', 'boire'],
    am: ['ውሃ', 'ጥም'],
  },
  medication: {
    en: ['medication', 'medicine', 'pills', 'meds', 'i need my medication'],
    es: ['medicación', 'medicina', 'pastillas', 'medicamento'],
    zh: ['药', '吃药', '药物'],
    hi: ['दवाई', 'दवा', 'गोली'],
    ar: ['دواء', 'حبوب', 'أريد دواء'],
    he: ['תרופה', 'כדורים', 'תרופות'],
    ru: ['лекарство', 'таблетки', 'мне нужно лекарство'],
    fr: ['médicament', 'pilule', 'comprimé'],
    am: ['መድሃኒት', 'ክኒን'],
  },
  food: {
    en: ['food', 'hungry', 'eat', 'meal', 'i need food'],
    es: ['comida', 'hambre', 'tengo hambre', 'comer'],
    zh: ['吃饭', '饿', '食物', '饭'],
    hi: ['खाना', 'भूख', 'खाना चाहिए'],
    ar: ['طعام', 'جوعان', 'أريد أكل'],
    he: ['אוכל', 'רעב', 'אני רעב'],
    ru: ['еду', 'есть', 'голоден', 'хочу есть'],
    fr: ['nourriture', 'manger', 'faim'],
    am: ['ምግብ', 'ረሃብ'],
  },
  toilet: {
    en: ['toilet', 'bathroom', 'restroom', 'i need the toilet'],
    es: ['baño', 'necesito el baño'],
    zh: ['厕所', '卫生间', '上厕所'],
    hi: ['शौचालय', 'बाथरूम', 'टॉयलेट'],
    ar: ['حمام', 'مرحاض', 'أريد الحمام'],
    he: ['שירותים', 'אמבטיה'],
    ru: ['туалет', 'в туалет'],
    fr: ['toilettes', 'salle de bain'],
    am: ['መጸዳጃ', 'ሽንት ቤት'],
  },
  pain: {
    en: ['pain', 'hurts', 'it hurts', 'i have pain', 'in pain'],
    es: ['dolor', 'me duele', 'tengo dolor'],
    zh: ['疼', '痛', '好痛'],
    hi: ['दर्द', 'दर्द हो रहा है'],
    ar: ['ألم', 'يؤلم', 'عندي ألم'],
    he: ['כאב', 'כואב', 'יש לי כאב'],
    ru: ['боль', 'больно', 'мне больно'],
    fr: ['douleur', 'mal', 'j\'ai mal'],
    am: ['ህመም', 'ይጎዳኛል'],
  },
  call: {
    en: ['call carer', 'call nurse', 'call', 'need help', 'help'],
    es: ['llamar', 'llamar cuidador', 'necesito ayuda'],
    zh: ['呼叫', '叫人', '帮忙'],
    hi: ['कॉल करो', 'बुलाओ', 'मदद चाहिए'],
    ar: ['اتصل', 'اتصل بالمعتني', 'أحتاج مساعدة'],
    he: ['תתקשר', 'קרא למטפל', 'צריך עזרה'],
    ru: ['позвать', 'вызвать', 'нужна помощь'],
    fr: ['appeler', 'aide', 'j\'ai besoin d\'aide'],
    am: ['ጥሪ', 'እርዳታ ፈልጋለሁ'],
  },
};

export function _parseVoiceCommand(transcript) {
  const lang = _currentLang || 'en';
  // Check emergency first (highest priority)
  const emergencyPhrases = VOICE_COMMANDS.emergency[lang] || VOICE_COMMANDS.emergency.en;
  if (emergencyPhrases.some(p => transcript.includes(p))) {
    return { type: 'emergency' };
  }
  // Check specific needs
  for (const need of ['water', 'medication', 'food', 'toilet', 'pain']) {
    const phrases = (VOICE_COMMANDS[need][lang] || VOICE_COMMANDS[need].en);
    if (phrases.some(p => transcript.includes(p))) {
      return { type: 'call', need: need };
    }
  }
  // Check generic call
  const callPhrases = VOICE_COMMANDS.call[lang] || VOICE_COMMANDS.call.en;
  if (callPhrases.some(p => transcript.includes(p))) {
    return { type: 'call', need: 'help' };
  }
  return null;
}

export async function _voiceCallCarer(needType) {
  if (PS.status === 'calling' || PS.status === 'acked') return;
  if (!S.rooms.length) { toast(t('No carers connected — add a carer first')); return; }
  unlockAudio();
  setPatientStatus('calling');
  if (navigator.vibrate) navigator.vibrate(200);

  const callData = {
    fromUid: S.uid, fromName: S.name, avatar: S.avatar || '',
    type: needType || 'help',
    message: 'Voice command: ' + (needType || 'help'),
    timestamp: firebase.database.ServerValue.TIMESTAMP, status: 'active',
  };
  await _attachLocation(callData);

  const isEmergency = needType === 'fall';

  try {
    if (isEmergency) {
      // Emergency: notify ALL carers immediately
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
      _setCallFinalTimeout();
    } else {
      // Normal voice call: use escalation tier system
      const sortedCarers = _getCarersByPriority();
      if (!sortedCarers.length) { toast(t('No available carers')); setPatientStatus('ready'); return; }
      PS._escalationCarers = sortedCarers;
      PS._escalationIndex = 0;
      PS._escalationCallData = callData;
      await _sendToEscalationTier(0);
      watchForAck();
      const totalTimeout = ESCALATION_DELAY_MS * sortedCarers.length + 30000;
      PS._callTimeout = setTimeout(() => {
        _clearEscalation();
        if (PS.status === 'calling') {
          setPatientStatus('ready');
          PS.activeCallId = null;
          if (PS.callListener) { PS.callListener(); PS.callListener = null; }
          _showNoResponseFallback();
        }
      }, totalTimeout);
    }
  } catch(e) {
    toast(t('Call failed — check your connection'));
    setPatientStatus('ready');
  }
}


// ════════════════════════════════════════════════════════════
//  LOCATION SHARING
// ════════════════════════════════════════════════════════════
export let _locationSharing = localStorage.getItem('carecall_location') === '1';

export function toggleLocationSharing() {
  _locationSharing = !_locationSharing;
  localStorage.setItem('carecall_location', _locationSharing ? '1' : '');
  document.getElementById('s-location-btn').textContent = _locationSharing ? 'On' : 'Off';
  if (_locationSharing) {
    if (!navigator.geolocation) { toast('Location not available on this device'); _locationSharing = false; localStorage.setItem('carecall_location', ''); document.getElementById('s-location-btn').textContent = 'Off'; return; }
    navigator.geolocation.getCurrentPosition(() => {
      toast(t('Location sharing enabled'));
    }, () => {
      toast(t('Location permission required'));
      _locationSharing = false;
      localStorage.setItem('carecall_location', '');
      document.getElementById('s-location-btn').textContent = 'Off';
    });
  } else {
    toast(t('Location sharing disabled'));
  }
}

export async function _attachLocation(callData) {
  if (!_locationSharing) return;
  try {
    // Use native Capacitor geolocation (works in background) or web fallback
    const loc = await Native.getCurrentPosition();
    if (loc) callData.location = loc;
  } catch(e) { /* silently skip if location unavailable */ }
}


// ════════════════════════════════════════════════════════════
//  CARE NOTES
// ════════════════════════════════════════════════════════════
export function showCareNotePrompt(callId) {
  const note = prompt('Add a care note for this call:');
  if (!note || !note.trim()) return;
  const call = CS.activeCalls[callId];
  const roomId = (call && call._room) || S.activeRoom || S.rooms[0];
  if (!roomId) return;
  db.ref(`carecall/rooms/${roomId}/calls/${callId}/careNote`).set({
    text: note.trim(),
    by: S.name,
    at: firebase.database.ServerValue.TIMESTAMP,
  });
  toast(t('Care note saved'));
}

