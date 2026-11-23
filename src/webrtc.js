// ════════════════════════════════════════════════════════════
//  WEBRTC — voice call
// ════════════════════════════════════════════════════════════
import { S, CS } from './state.js';

// ════════════════════════════════════════════════════════════
//  WEBRTC VOICE CALL
// ════════════════════════════════════════════════════════════
export const VC = {
  pc:           null,    // RTCPeerConnection
  localStream:  null,    // MediaStream
  sigRef:       null,    // Firebase signaling reference
  sigListeners: [],      // cleanup refs
  callId:       null,    // unique voice call session ID
  timerInterval:null,
  startTime:    0,
  role:         null,    // 'caller' | 'callee'
};

export const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ── Carer initiates voice call to patient ──
export async function startVoiceCall() {
  if (VC.pc) { toast(t('Already in a call')); return; }

  // Find the patient to call (from the current alert or first active call)
  const call = CS.activeCalls[CS.alertCallId] || Object.values(CS.activeCalls).find(c => c.status === 'active');
  if (!call) { toast('No active call to connect to'); return; }

  const roomId = call._room || S.activeRoom || S.rooms[0];
  if (!roomId) { toast(t('No room found')); return; }

  // Acknowledge the call if not already
  if (call.status === 'active') acknowledgeCall(call.id);
  dismissAlert();

  try {
    if (!navigator.mediaDevices) { toast(t("Microphone access required")); return; }
    VC.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch(e) {
    toast(t('Microphone access required'));
    return;
  }

  VC.callId = 'vc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  VC.role = 'caller';
  VC.sigRef = db.ref(`carecall/rooms/${roomId}/voiceCalls/${VC.callId}`);

  _showCallOverlay(call.fromName || 'Patient', 'Calling…');

  // Create peer connection
  VC.pc = new RTCPeerConnection(RTC_CONFIG);
  VC.localStream.getTracks().forEach(t => VC.pc.addTrack(t, VC.localStream));

  // Handle remote audio
  VC.pc.ontrack = evt => {
    const audio = new Audio();
    audio.srcObject = evt.streams[0];
    audio.play().catch(() => {});
    _setCallStatus('Connected');
    _startCallTimer();
  };

  // ICE candidates
  VC.pc.onicecandidate = evt => {
    if (evt.candidate) {
      VC.sigRef.child('callerCandidates').push(evt.candidate.toJSON());
    }
  };

  // Create offer
  const offer = await VC.pc.createOffer();
  await VC.pc.setLocalDescription(offer);
  await VC.sigRef.set({
    offer: { type: offer.type, sdp: offer.sdp },
    from: S.uid,
    fromName: S.name,
    to: call.fromUid,
    status: 'ringing',
    createdAt: firebase.database.ServerValue.TIMESTAMP,
  });

  // Listen for answer
  const answerRef = VC.sigRef.child('answer');
  answerRef.on('value', async snap => {
    const answer = snap.val();
    if (answer && VC.pc && !VC.pc.currentRemoteDescription) {
      await VC.pc.setRemoteDescription(answer);
    }
  });
  VC.sigListeners.push(() => answerRef.off());

  // Listen for callee ICE candidates
  const calleeCandRef = VC.sigRef.child('calleeCandidates');
  calleeCandRef.on('child_added', async snap => {
    if (VC.pc) {
      try { await VC.pc.addIceCandidate(snap.val()); } catch(e) {}
    }
  });
  VC.sigListeners.push(() => calleeCandRef.off());

  // Listen for call end/decline
  VC.sigRef.child('status').on('value', snap => {
    if (snap.val() === 'ended' || snap.val() === 'declined') {
      toast(snap.val() === 'declined' ? t('Call declined') : t('Call ended'));
      _cleanupVoiceCall();
    }
  });
  VC.sigListeners.push(() => VC.sigRef.child('status').off());

  // Connection state
  VC.pc.onconnectionstatechange = () => {
    if (VC.pc && (VC.pc.connectionState === 'failed' || VC.pc.connectionState === 'disconnected')) {
      toast(t('Voice call disconnected'));
      _cleanupVoiceCall();
    }
  };

  // Timeout: if not answered in 30s
  VC._ringTimeout = setTimeout(() => {
    if (VC.pc && !VC.startTime) {
      toast(t('No answer'));
      endVoiceCall();
    }
  }, 30000);
}

// ── Patient receives voice call ──
export let _vcListenerRefs = [];
export function _listenForVoiceCalls() {
  // Clean up old listeners
  _vcListenerRefs.forEach(ref => ref.off());
  _vcListenerRefs = [];
  // Listen across all rooms for incoming voice calls
  console.log(`[VC] Listening for voice calls in ${S.rooms.length} rooms, my uid: ${S.uid}`);
  S.rooms.forEach(roomId => {
    const ref = db.ref(`carecall/rooms/${roomId}/voiceCalls`);
    ref.on('child_added', snap => {
      const vc = snap.val();
      console.log(`[VC] child_added in ${roomId}:`, vc ? `from=${vc.from}, to=${vc.to}, status=${vc.status}` : 'null');
      if (!vc || vc.to !== S.uid || vc.status !== 'ringing') return;
      if (vc.from === S.uid) return; // ignore our own outgoing calls
      if (VC.pc) { console.log('[VC] Already in a call, skipping'); return; }

      VC.callId = snap.key;
      VC.sigRef = db.ref(`carecall/rooms/${roomId}/voiceCalls/${snap.key}`);

      if (S.role === 'patient') {
        // Patient: always auto-answer emergency voice calls on speakerphone
        console.log('[VC] Auto-answering as patient');
        answerVoiceCall(vc, true);
      } else {
        // Carer receiving a call (future use) — show incoming UI
        document.getElementById('vc-incoming-who').textContent = `${escHtml(vc.fromName || 'Patient')} is calling`;
        document.getElementById('vc-incoming').classList.add('show');
        if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
        VC._incomingData = vc;
      }
    });
    _vcListenerRefs.push(ref);
  });
}

export async function answerVoiceCall(vcData, autoAnswer) {
  const vc = vcData || VC._incomingData;
  if (!vc || !VC.sigRef) return;

  document.getElementById('vc-incoming').classList.remove('show');

  try {
    if (!navigator.mediaDevices) { toast(t("Microphone access required")); return; }
    VC.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch(e) {
    toast(t('Microphone access required'));
    declineVoiceCall();
    return;
  }

  VC.role = 'callee';
  _showCallOverlay(vc.fromName || 'Carer', 'Connecting…');

  VC.pc = new RTCPeerConnection(RTC_CONFIG);
  VC.localStream.getTracks().forEach(t => VC.pc.addTrack(t, VC.localStream));

  // Handle remote audio
  VC.pc.ontrack = evt => {
    const audio = new Audio();
    audio.srcObject = evt.streams[0];
    audio.play().catch(() => {});
    _setCallStatus('Connected');
    _startCallTimer();
  };

  // ICE candidates
  VC.pc.onicecandidate = evt => {
    if (evt.candidate) {
      VC.sigRef.child('calleeCandidates').push(evt.candidate.toJSON());
    }
  };

  // Set remote description (offer)
  await VC.pc.setRemoteDescription(vc.offer);

  // Listen for caller ICE candidates
  const callerCandRef = VC.sigRef.child('callerCandidates');
  callerCandRef.on('child_added', async snap => {
    if (VC.pc) {
      try { await VC.pc.addIceCandidate(snap.val()); } catch(e) {}
    }
  });
  VC.sigListeners.push(() => callerCandRef.off());

  // Create answer
  const answer = await VC.pc.createAnswer();
  await VC.pc.setLocalDescription(answer);
  await VC.sigRef.child('answer').set({ type: answer.type, sdp: answer.sdp });
  await VC.sigRef.child('status').set('connected');

  // Listen for call end
  VC.sigRef.child('status').on('value', snap => {
    if (snap.val() === 'ended') {
      toast(t('Call ended'));
      _cleanupVoiceCall();
    }
  });
  VC.sigListeners.push(() => VC.sigRef.child('status').off());

  VC.pc.onconnectionstatechange = () => {
    if (VC.pc && (VC.pc.connectionState === 'failed' || VC.pc.connectionState === 'disconnected')) {
      toast(t('Voice call disconnected'));
      _cleanupVoiceCall();
    }
  };
}

export function declineVoiceCall() {
  document.getElementById('vc-incoming').classList.remove('show');
  if (VC.sigRef) VC.sigRef.child('status').set('declined');
  VC.sigRef = null;
  VC.callId = null;
  VC._incomingData = null;
}

export function endVoiceCall() {
  if (VC.sigRef) VC.sigRef.child('status').set('ended');
  _cleanupVoiceCall();
}

export function _cleanupVoiceCall() {
  clearTimeout(VC._ringTimeout);
  _unregisterTick('vcTimer');
  VC.sigListeners.forEach(fn => { try { fn(); } catch(e) {} });
  VC.sigListeners = [];
  if (VC.pc) { try { VC.pc.close(); } catch(e) {} VC.pc = null; }
  if (VC.localStream) { VC.localStream.getTracks().forEach(t => t.stop()); VC.localStream = null; }
  // Clean up signaling data after a delay
  if (VC.sigRef) { const ref = VC.sigRef; setTimeout(() => ref.remove().catch(()=>{}), 5000); }
  VC.sigRef = null;
  VC.callId = null;
  VC.role = null;
  VC.startTime = 0;
  VC._incomingData = null;
  document.getElementById('voice-call-overlay').classList.remove('show');
  document.getElementById('vc-incoming').classList.remove('show');
}

export function _showCallOverlay(name, status) {
  document.getElementById('vc-who').textContent = name;
  document.getElementById('vc-status').textContent = status;
  document.getElementById('vc-timer').textContent = '00:00';
  document.getElementById('voice-call-overlay').classList.add('show');
}

export function _setCallStatus(status) {
  document.getElementById('vc-status').textContent = status;
}

export function _startCallTimer() {
  if (VC.startTime) return; // already started
  VC.startTime = Date.now();
  _registerTick('vcTimer', () => {
    const s = Math.floor((Date.now() - VC.startTime) / 1000);
    const m = Math.floor(s / 60);
    document.getElementById('vc-timer').textContent =
      `${String(m).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  });
}

