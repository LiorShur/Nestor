// ════════════════════════════════════════════════════════════
//  BOOT — application startup
// ════════════════════════════════════════════════════════════
import { S, PS } from './state.js';

// ════════════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════════════
export async function boot() {
  // Safety timeout FIRST — guarantees spinner never hangs
  const loading = document.getElementById('loading');
  const _loadTimeout = setTimeout(() => {
    loading.classList.add('gone');
    showScreen('s-welcome');
    console.warn('[Boot] Timed out — showing welcome screen');
  }, BOOT_TIMEOUT_MS);

  if (!initFirebase()) { clearTimeout(_loadTimeout); return; }

  // Apply language and accessibility on startup
  _currentLang = localStorage.getItem('carecall_lang') || 'en';
  if (_currentLang === 'ar' || _currentLang === 'he') document.documentElement.dir = 'rtl';
  _loadA11y();
  applyTranslations();

  // ── Initialize native Capacitor features ──
  if (IS_NATIVE) {
    Native.configureStatusBar();
    Native.createNotificationChannels();
    // Listen for app state changes (foreground/background)
    Native.onAppStateChange(isActive => {
      if (isActive && S.role === 'carer') checkForMissedCalls();
      if (isActive) refreshFcmTokenIfNeeded();
    });
    // Handle local notification taps (medication, check-in)
    Native.onLocalNotificationAction(data => {
      if (data.type === 'medication') {
        const med = _medications.find(m => m.id === data.medId);
        if (med) _showMedPrompt(med);
      } else if (data.type === 'checkin') {
        _showCheckinPrompt();
      }
    });
    // Deep links: carecall://<CODE> from an external QR scanner.
    // Wire once at native init; handler tolerates early invocation
    // before S is fully loaded (stashes the code for after setup).
    try {
      const { App } = window.Capacitor && window.Capacitor.Plugins || {};
      if (App && App.addListener) {
        App.addListener('appUrlOpen', event => {
          const code = _parseQrPayload(event && event.url);
          if (code) _handleDeepLinkCode(code);
        });
      }
    } catch(_) {}
  }

  // (Safety timeout is set at the top of boot())

  // Wait for Firebase Auth to resolve. The SDK restores the persisted
  // session (email/password or anonymous) from IndexedDB automatically.
  // We listen via onAuthStateChanged rather than calling signInAnonymously
  // because Phase 1 uses email/password as the primary auth method.
  // If no session exists the user will be routed through the registration
  // flow at setupSaveName → s-auth.
  S.authFailed = false;
  const currentUser = await new Promise((resolve) => {
    const unsub = auth.onAuthStateChanged(u => { unsub(); resolve(u); });
    setTimeout(() => resolve(null), 5000);
  });

  if (currentUser) {
    S.uid = currentUser.uid;
    localStorage.setItem('carecall_uid', S.uid);
    // If the user is anonymous (pre-Phase-1 session) and has no saved
    // state in localStorage (e.g. fresh install that inherited an
    // IndexedDB auth session from a prior Capacitor build), route them
    // through the full registration flow rather than into a broken main
    // screen. They'll register, which creates a proper email account.
    if (currentUser.isAnonymous && !localStorage.getItem('carecall_state')) {
      console.warn('[Boot] Anonymous session with no local state — routing to setup.');
      clearTimeout(_loadTimeout);
      loading.classList.add('gone');
      showScreen('s-welcome');
      return;
    }
  } else {
    // No session — first-time user or someone who signed out.
    const savedUid = localStorage.getItem('carecall_uid');
    if (savedUid) {
      S.uid = savedUid;
      S.authFailed = true;
    }
  }

  // Check for saved state
  if (S.uid && loadState()) {
    // Migrate v4 users: assign personal code if missing
    if (!S.personalCode) {
      S.personalCode = genCode();
    }
    // Merge rooms from Firebase (discovers connections made by other users)
    try {
      const fbRoomsSnap = await db.ref(`carecall/users/${S.uid}/rooms`).once('value');
      const fbRooms = fbRoomsSnap.val() || [];
      fbRooms.forEach(room => { if (!S.rooms.includes(room)) S.rooms.push(room); });
      // Deduplicate rooms
      S.rooms = [...new Set(S.rooms)];
      if (!S.activeRoom && S.rooms.length) S.activeRoom = S.rooms[0];
    } catch(e) {}
    // Sync profile to Firebase (ensures code index exists)
    await syncUserProfile();
    saveState(); // persist as v5
    clearTimeout(_loadTimeout);
    loading.classList.add('gone');
    await joinAllRooms();
    launchMainScreen();
  } else {
    clearTimeout(_loadTimeout);
    loading.classList.add('gone');
    showScreen('s-welcome');
  }

  // Keep presence alive on reconnect
  db.ref('.info/connected').on('value', snap => {
    if (snap.val() && S.uid && S.rooms.length) {
      S.rooms.forEach(code => {
        const ref = db.ref(`carecall/rooms/${code}/members/${S.uid}`);
        ref.update({ online: true });
        ref.onDisconnect().update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
      });
      // Flush any med events that were written while offline / between loads
      _medQueueFlush();
    }
  });

  // Flush once at boot — covers the case where we loaded online and
  // had leftover queued entries from a prior offline session.
  _medQueueFlush();
}

// Unlock audio on first user interaction anywhere (catches returning users
// who skip the welcome screen and go straight to main screen).
// Must use 'click' or 'pointerup' — 'touchstart' is NOT a valid user
// activation for AudioContext in Chrome.
export function _firstInteraction() {
  unlockAudio();
  ['click', 'pointerup', 'keydown'].forEach(e =>
    document.removeEventListener(e, _firstInteraction));
}
['click', 'pointerup', 'keydown'].forEach(e =>
  document.addEventListener(e, _firstInteraction, { once: false, passive: true }));

// Code input: auto-uppercase
['room-code-input','add-room-input'].forEach(id=>{
  const el=document.getElementById(id);
  if (el) el.addEventListener('input',e=>{e.target.value=e.target.value.toUpperCase();});
});

// Name input: enter key
document.getElementById('name-input').addEventListener('keypress', e=>{
  if(e.key==='Enter') setupSaveName();
});


