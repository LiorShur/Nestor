// ════════════════════════════════════════════════════════════
//  FCM — push notifications
// ════════════════════════════════════════════════════════════
import { S } from './state.js';

// ════════════════════════════════════════════════════════════
//  FCM PUSH — keeps carer reachable when app is backgrounded
// ════════════════════════════════════════════════════════════
export let _messaging = null;

export async function setupCarerPush() {
  if (S.role !== 'carer') return;

  // ── Native push (Capacitor) — use native FCM SDK ──
  if (IS_NATIVE) {
    try {
      const nativeToken = await Native.initPush();
      if (nativeToken) {
        for (const room of S.rooms) {
          await db.ref(`carecall/rooms/${room}/members/${S.uid}/fcmToken`).set(nativeToken);
        }
        console.log('[Native FCM] Token registered for', S.rooms.length, 'room(s)');
        Native.onPushReceived(notification => {
          checkForMissedCalls();
        });
      } else {
        console.warn('[Native FCM] No token returned');
      }
    } catch(e) {
      console.error('[Native FCM] Setup failed:', e.message);
    }
    return;
  }

  // ── Web push (PWA) — use Firebase JS SDK ──
  if (!firebase.messaging.isSupported()) {
    console.log('[FCM] Messaging not supported in this browser');
    return;
  }
  try {
    _messaging = firebase.messaging();

    // Get the existing SW registration (registered by sw.js boot code).
    // FCM needs this to send background messages — we pass it to getToken().
    let swReg = null;
    if ('serviceWorker' in navigator) {
      try {
        // Wait for the main SW to be ready
        swReg = await navigator.serviceWorker.ready;
      } catch(e) {}
      if (!swReg) {
        // Fallback: register messaging SW directly
        swReg = await navigator.serviceWorker.register(
          BASE_PATH + '/firebase-messaging-sw.js',
          { scope: BASE_PATH + '/' }
        );
      }
    }

    // Request notification permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast(t('Notification permission denied'));
      return;
    }

    // Get FCM token
    const token = await _messaging.getToken({
      vapidKey:       FIREBASE_CONFIG.vapidKey,
      serviceWorkerRegistration: swReg,
    });

    if (!token) return;

    // Store token against this carer in all rooms
    for (const room of S.rooms) {
      await db.ref(`carecall/rooms/${room}/members/${S.uid}/fcmToken`).set(token);
    }
    console.log('[FCM] Token registered for', S.rooms.join(', '));

    // onMessage fires when a push arrives and app IS in the foreground.
    // The Firebase DB child_added listener already handles this case,
    // but onMessage is a useful backup for edge cases.
    _messaging.onMessage(payload => {
      console.log('[FCM] Foreground message received');
      // DB listener handles this — just trigger a missed-call check
      setTimeout(checkForMissedCalls, 300);
    });

    // Handle messages from the service worker
    navigator.serviceWorker.addEventListener('message', evt => {
      if (evt.data && evt.data.type === 'incoming-call') {
        checkForMissedCalls();
      }
      // Diagnostic logs from SW push handler — visible in main console
      if (evt.data && evt.data.type === 'sw-log') {
        console.log(evt.data.message);
      }
    });

    // Verify push subscription is active
    if (swReg && swReg.pushManager) {
      const sub = await swReg.pushManager.getSubscription();
      if (sub) {
        console.log('[FCM] Push subscription active, endpoint:', sub.endpoint.slice(0, 60) + '...');
      } else {
        console.warn('[FCM] No push subscription found — notifications will not work');
      }
    }

  } catch(err) {
    console.warn('[FCM] Push setup failed:', err.message);
  }
}

// Refresh FCM token when it changes (e.g. after reinstall).
// Errors were previously swallowed silently; now we log them and, for
// the two classes we actually care about (revoked / not-registered),
// evict the stale token from every room so we don't keep addressing it.
export async function refreshFcmTokenIfNeeded() {
  if (S.role !== 'carer') return;

  // ── Native token refresh (Capacitor) ──
  if (IS_NATIVE) {
    try {
      const token = await Native.initPush();
      if (token) {
        for (const room of S.rooms) {
          try {
            await db.ref(`carecall/rooms/${room}/members/${S.uid}/fcmToken`).set(token);
          } catch(writeErr) {
            console.warn('[Native FCM] Could not write token for room', room, ':', writeErr && writeErr.message);
          }
        }
        console.log('[Native FCM] Token refreshed on app resume');
      }
    } catch(e) {
      console.warn('[Native FCM] Token refresh failed:', e && e.message);
    }
    return;
  }

  // ── Web token refresh ──
  if (!_messaging) return;
  try {
    const token = await _messaging.getToken({ vapidKey: FIREBASE_CONFIG.vapidKey });
    if (!token) {
      console.warn('[FCM] getToken returned empty — permissions may have been revoked');
      return;
    }
    for (const room of S.rooms) {
      try {
        await db.ref(`carecall/rooms/${room}/members/${S.uid}/fcmToken`).set(token);
      } catch(writeErr) {
        console.warn('[FCM] Could not write token for room', room, ':', writeErr && writeErr.message);
      }
    }
  } catch(e) {
    const code = (e && (e.code || '')) + '';
    console.warn('[FCM] Token refresh failed:', code, e && e.message);
    // On definitive-bad-token errors, evict our own stale token entries
    // so subsequent pushes aren't aimed at a dead device.
    if (code.includes('messaging/token-unsubscribe-failed') ||
        code.includes('messaging/registration-token-not-registered') ||
        code.includes('unregistered')) {
      for (const room of S.rooms) {
        try { await db.ref(`carecall/rooms/${room}/members/${S.uid}/fcmToken`).remove(); }
        catch(_) {}
      }
    }
  }
}

// Refresh token when page becomes visible again (covers token expiry after long sleep)
export let _wasHidden = false;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    _wasHidden = true;
    _flushDwellIfDirty(); // persist dwell samples before app sleeps
  }
  if (document.visibilityState === 'visible' && _wasHidden) {
    _wasHidden = false;
    refreshFcmTokenIfNeeded();
    // Re-check for calls that arrived while app was backgrounded
    // Small delay to let Firebase connection re-establish after wake
    setTimeout(checkForMissedCalls, 800);
  }
});

boot();


