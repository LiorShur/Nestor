
// ── Platform detection & base path for Capacitor compatibility ──
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const BASE_PATH = IS_NATIVE ? '.' : import.meta.env.BASE_URL.replace(/\/$/, '');

// ── Lazy-loading helpers for heavy libraries ──
const _loadedScripts = {};
async function loadScript(url) {
  if (_loadedScripts[url]) return;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url; s.onload = () => { _loadedScripts[url] = true; resolve(); };
    s.onerror = reject; document.head.appendChild(s);
  });
}
async function loadCSS(url) {
  if (document.querySelector(`link[href="${url}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = url; document.head.appendChild(l);
}

// ── Global tick loop — single setInterval for 1-second cadence timers ──
const _tickHandlers = new Map();
let _tickInterval = null;
function _registerTick(key, fn) {
  _tickHandlers.set(key, fn);
  if (!_tickInterval) _tickInterval = setInterval(_runTick, 1000);
}
function _unregisterTick(key) {
  _tickHandlers.delete(key);
  if (_tickHandlers.size === 0 && _tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
}
function _runTick() {
  for (const fn of _tickHandlers.values()) { try { fn(); } catch(e) { console.warn('[tick]', e); } }
}

// ════════════════════════════════════════════════════════════
//  NATIVE BRIDGE — Capacitor plugins with web fallbacks
//  Pattern A: Use native when available, fall back to web APIs
// ════════════════════════════════════════════════════════════
const Native = {
  // ── Push Notifications ──
  async initPush() {
    if (!IS_NATIVE) return null;
    try {
      const { PushNotifications } = window.Capacitor.Plugins;
      if (!PushNotifications) return null;
      const perm = await PushNotifications.requestPermissions();
      if (perm.receive !== 'granted') return null;

      const tokenPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), 15000);
        PushNotifications.addListener('registration', token => {
          clearTimeout(timeout);
          resolve(token.value);
        });
        PushNotifications.addListener('registrationError', err => {
          clearTimeout(timeout);
          console.warn('[Native] Push registration error:', err);
          resolve(null);
        });
      });

      await PushNotifications.register();
      return await tokenPromise;
    } catch(e) { console.warn('[Native] Push init error:', e.message); return null; }
  },

  async onPushReceived(callback) {
    if (!IS_NATIVE) return;
    const { PushNotifications } = window.Capacitor.Plugins;
    PushNotifications.addListener('pushNotificationReceived', callback);
    PushNotifications.addListener('pushNotificationActionPerformed', action => {
      callback(action.notification);
    });
  },

  // ── Local Notifications (medication reminders, check-ins) ──
  async scheduleLocalNotification(opts) {
    if (!IS_NATIVE) return false; // web uses setTimeout
    try {
      const { LocalNotifications } = window.Capacitor.Plugins;
      const perm = await LocalNotifications.requestPermissions();
      if (perm.display !== 'granted') return false;
      await LocalNotifications.schedule({
        notifications: [{
          id: opts.id || Math.floor(Math.random() * 100000),
          title: opts.title,
          body: opts.body,
          schedule: opts.at ? { at: opts.at } : undefined,
          sound: opts.sound || 'default',
          channelId: opts.channelId || 'carecall_reminders',
          extra: opts.data || {},
        }],
      });
      return true;
    } catch(e) { console.warn('[Native] Local notification failed:', e.message); return false; }
  },

  async cancelLocalNotification(id) {
    if (!IS_NATIVE) return;
    try {
      const { LocalNotifications } = window.Capacitor.Plugins;
      await LocalNotifications.cancel({ notifications: [{ id }] });
    } catch(e) {}
  },

  async onLocalNotificationAction(callback) {
    if (!IS_NATIVE) return;
    const { LocalNotifications } = window.Capacitor.Plugins;
    LocalNotifications.addListener('localNotificationActionPerformed', action => {
      callback(action.notification.extra || {});
    });
  },

  // ── Geolocation (background-capable on native) ──
  async getCurrentPosition() {
    if (IS_NATIVE) {
      try {
        const { Geolocation } = window.Capacitor.Plugins;
        const perm = await Geolocation.requestPermissions();
        if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') return null;
        const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 });
        return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      } catch(e) { return null; }
    }
    // Web fallback
    if (!navigator.geolocation) return null;
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000, enableHighAccuracy: true });
      });
      return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
    } catch(e) { return null; }
  },

  // ── Text-to-speech (medication reminders) ──
  // Prefers @capacitor-community/text-to-speech on native; falls back to
  // the Web Speech API (window.speechSynthesis) on PWA. Silent no-op when
  // neither is available.
  async speak(text, lang, opts) {
    if (!text) return false;
    const rate = (opts && opts.rate) || 0.95;
    const pitch = (opts && opts.pitch) || 1.0;
    const volume = (opts && opts.volume) || 1.0;
    if (IS_NATIVE) {
      try {
        const { TextToSpeech } = window.Capacitor.Plugins;
        if (TextToSpeech && TextToSpeech.speak) {
          try { await TextToSpeech.stop(); } catch(_) {}
          await TextToSpeech.speak({
            text,
            lang: lang || 'en-US',
            rate, pitch, volume,
            category: 'playback',
          });
          return true;
        }
      } catch(e) { console.warn('[TTS native]', e && e.message); }
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = lang || 'en-US';
        utter.rate = rate; utter.pitch = pitch; utter.volume = volume;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utter);
        return true;
      } catch(e) { console.warn('[TTS web]', e && e.message); }
    }
    return false;
  },

  async stopSpeaking() {
    if (IS_NATIVE) {
      try {
        const { TextToSpeech } = window.Capacitor.Plugins;
        if (TextToSpeech && TextToSpeech.stop) await TextToSpeech.stop();
      } catch(_) {}
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch(_) {}
    }
  },

  // ── Background location (Safe Zone monitoring) ──
  // Uses @capacitor-community/background-geolocation on native so a
  // screen-lock or app-background doesn't stop watchPosition. Web PWA
  // falls back to navigator.geolocation.watchPosition which DOES pause
  // when the tab is backgrounded — documented limitation.
  _bgLocWatcher: null,
  _webLocWatchId: null,
  async startBackgroundLocationWatch(onLocation, onError) {
    if (IS_NATIVE) {
      try {
        const { BackgroundGeolocation } = window.Capacitor.Plugins;
        if (BackgroundGeolocation && BackgroundGeolocation.addWatcher) {
          if (this._bgLocWatcher) {
            try { await BackgroundGeolocation.removeWatcher({ id: this._bgLocWatcher }); } catch(_) {}
            this._bgLocWatcher = null;
          }
          const id = await BackgroundGeolocation.addWatcher({
            backgroundMessage: 'Monitoring your safe zone.',
            backgroundTitle: 'CareCall safety companion',
            requestPermissions: true,
            stale: false,
            distanceFilter: 15,
          }, (location, err) => {
            if (err) {
              console.warn('[bg-geoloc]', err);
              if (typeof onError === 'function') onError(err);
              return;
            }
            if (!location) return;
            onLocation({
              lat: location.latitude,
              lng: location.longitude,
              accuracy: location.accuracy,
              ts: location.time || Date.now(),
            });
          });
          this._bgLocWatcher = id;
          return 'native';
        }
      } catch (e) {
        console.warn('[bg-geoloc] native path failed:', e && e.message);
      }
    }
    // Web fallback — foreground only
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      this._webLocWatchId = navigator.geolocation.watchPosition(
        pos => onLocation({
          lat: pos.coords.latitude, lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy, ts: Date.now(),
        }),
        err => { if (typeof onError === 'function') onError(err); },
        { enableHighAccuracy: true, maximumAge: 15000 }
      );
      return 'web';
    }
    return null;
  },
  async stopBackgroundLocationWatch() {
    if (this._bgLocWatcher && IS_NATIVE) {
      try {
        const { BackgroundGeolocation } = window.Capacitor.Plugins;
        if (BackgroundGeolocation && BackgroundGeolocation.removeWatcher) {
          await BackgroundGeolocation.removeWatcher({ id: this._bgLocWatcher });
        }
      } catch(_) {}
      this._bgLocWatcher = null;
    }
    if (this._webLocWatchId != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      try { navigator.geolocation.clearWatch(this._webLocWatchId); } catch(_) {}
      this._webLocWatchId = null;
    }
  },

  // ── Save/share a PDF (generated in-app, e.g. adherence report) ──
  // Returns { ok, platform, shared, cancelled, uri, error } so the
  // caller can toast accurately. On native Android, jsPDF's browser
  // download path does nothing — we write the file into app cache
  // and surface the native Share sheet so the user can route it.
  async savePdf(jsPdfDoc, fileName) {
    if (!jsPdfDoc) return { ok: false, error: 'No document' };
    if (IS_NATIVE) {
      const plugins = (window.Capacitor && window.Capacitor.Plugins) || {};
      const { Filesystem, Share } = plugins;
      if (!Filesystem) {
        return { ok: false, platform: 'native',
          error: 'Filesystem plugin missing — rebuild APK (npm install + cap sync)' };
      }
      let uri;
      try {
        const dataUri = jsPdfDoc.output('datauristring');
        const base64 = dataUri.indexOf(',') >= 0 ? dataUri.split(',')[1] : dataUri;
        // Directory enum is only exported from the ES module — since we're
        // loading Capacitor via the global, pass the string value directly.
        // 'CACHE' = app's private cache dir (writable, matches cache-path
        // in android/app/src/main/res/xml/file_paths.xml for FileProvider).
        const writeRes = await Filesystem.writeFile({
          path: fileName,
          data: base64,
          directory: 'CACHE',
          recursive: true,
        });
        uri = writeRes.uri;
      } catch (e) {
        return { ok: false, platform: 'native',
          error: 'Write failed: ' + (e && e.message || e) };
      }
      if (!Share) {
        return { ok: true, platform: 'native', shared: false, uri,
          error: 'Share plugin missing — file saved to app cache only' };
      }
      try {
        await Share.share({ title: fileName, files: [uri], dialogTitle: fileName });
        return { ok: true, platform: 'native', shared: true, uri };
      } catch (e) {
        const msg = (e && e.message) || String(e);
        // Common cancellation strings across Capacitor versions
        if (/cancell?ed|dismiss/i.test(msg) || msg === 'User cancelled') {
          return { ok: true, platform: 'native', shared: false, cancelled: true, uri };
        }
        return { ok: false, platform: 'native', uri,
          error: 'Share failed: ' + msg };
      }
    }
    // Web / fallback
    try { jsPdfDoc.save(fileName); return { ok: true, platform: 'web' }; }
    catch (e) { return { ok: false, platform: 'web', error: 'Save failed: ' + (e && e.message || e) }; }
  },

  // ── App lifecycle ──
  async onAppStateChange(callback) {
    if (!IS_NATIVE) return;
    try {
      const { App } = window.Capacitor.Plugins;
      App.addListener('appStateChange', state => {
        callback(state.isActive);
      });
    } catch(e) {}
  },

  // ── Status bar ──
  async configureStatusBar() {
    if (!IS_NATIVE) return;
    try {
      const { StatusBar } = window.Capacitor.Plugins;
      await StatusBar.setBackgroundColor({ color: '#0D1520' });
      await StatusBar.setStyle({ style: 'DARK' });
    } catch(e) {}
  },

  // ── Create notification channels (Android 8+) ──
  async createNotificationChannels() {
    if (!IS_NATIVE) return;
    try {
      const { LocalNotifications } = window.Capacitor.Plugins;
      await LocalNotifications.createChannel({
        id: 'carecall_alerts',
        name: 'Care Alerts',
        description: 'Incoming patient calls and emergencies',
        importance: 5, // IMPORTANCE_HIGH
        visibility: 1, // PUBLIC
        vibration: true,
        sound: 'default',
        lights: true,
      });
      await LocalNotifications.createChannel({
        id: 'carecall_reminders',
        name: 'Reminders',
        description: 'Medication reminders and scheduled check-ins',
        importance: 4, // IMPORTANCE_DEFAULT
        vibration: true,
        sound: 'default',
      });
    } catch(e) { console.warn('[Native] Channel creation failed:', e.message); }
  },
};

// ════════════════════════════════════════════════════════════
//  GLOBAL ERROR HANDLERS — catch silent failures early
// ════════════════════════════════════════════════════════════
window.onerror = function(msg, src, line, col, err) {
  console.error('[CareCall Error]', msg, src, line, col, err);
  // Don't break the app — just log
  return false;
};
window.addEventListener('unhandledrejection', function(event) {
  console.error('[CareCall Unhandled Promise]', event.reason);
});

/* ═══════════════════════════════════════════════════════════
   FIREBASE CONFIGURATION
   Replace these values with your own Firebase project config.
   See SETUP.md for step-by-step instructions.
   ═══════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBStlDFW0WFpA_U1o_2QC0YE4iAo6d9cQc",
  authDomain: "carecall-2afa6.firebaseapp.com",
  databaseURL: "https://carecall-2afa6-default-rtdb.firebaseio.com",
  projectId: "carecall-2afa6",
  storageBucket: "carecall-2afa6.firebasestorage.app",
  messagingSenderId: "332197805860",
  appId: "1:332197805860:web:d734289d18c69e88a27db1",
  // Get this from Firebase Console → Project Settings → Cloud Messaging → Web Push certificates
  vapidKey:          "BJZwSJg--JOr8NnYdEsxZalvTyy_gJ_mcRNCTdKeMs0zxD9sBhPNXqd4Mqcq_uwAsZtfza8BGP9Q2CG0a20M4zg"
};
/* ═══════════════════════════════════════════════════════════ */



// ════════════════════════════════════════════════════════════
//  FIREBASE INIT
// ════════════════════════════════════════════════════════════
let db   = null;
let auth = null;

function isFirebaseConfigured() {
  return FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY";
}

function initFirebase() {
  if (!isFirebaseConfigured()) {
    document.getElementById('loading').innerHTML = `
      <div class="loading-logo">Care<em>Call</em></div>
      <div class="config-warning">
        <h3>⚙️ Firebase Not Configured</h3>
        <p>Open this HTML file and replace the FIREBASE_CONFIG values at the top with your Firebase project credentials.<br><br>See the included SETUP.md for step-by-step instructions.</p>
      </div>`;
    return false;
  }
  firebase.initializeApp(FIREBASE_CONFIG);
  db   = firebase.database();
  auth = firebase.auth();
  return true;
}

// ════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════
const S = {
  uid:          null,
  name:         null,
  role:         null,    // 'patient' | 'carer' | 'family'
  personalCode: null,
  phone:        null,
  avatar:       null,
  rooms:        [],
  activeRoom:   null,
  prevScreen:   null,
  emergencyNumber: null,
  tier:         'pro', // 'basic' | 'plus' | 'pro' — set to 'pro' for pilot
};

// ── Freemium tier gating ──
const TIER_FEATURES = {
  basic:  new Set(['sos','needs','push','log_7d','night_mode','1_carer','1_family']),
  plus:   new Set(['sos','needs','push','log_unlimited','night_mode','unlimited_carers','unlimited_family','sms_unlimited','medications','checkins','fall_detection','voice_activation','voice_notes','emergency_card','escalation','temp_carer','calendar','drug_interactions','documents','health_tracking']),
  pro:    new Set(['sos','needs','push','log_unlimited','night_mode','unlimited_carers','unlimited_family','sms_unlimited','medications','checkins','fall_detection','voice_activation','voice_notes','emergency_card','escalation','temp_carer','safe_zones','inactivity','location_sharing','adherence_report','remote_settings','wellness_score','handoff_notes','pin_lock','priority_support','calendar','drug_interactions','documents','health_tracking']),
};
function _hasTierFeature(feature) {
  const tier = S.tier || 'basic';
  return TIER_FEATURES[tier] && TIER_FEATURES[tier].has(feature);
}
function _requireTier(feature, minTier) {
  if (_hasTierFeature(feature)) return true;
  _showUpgradePrompt(minTier, feature);
  return false;
}
function _showUpgradePrompt(tier, feature) {
  const tierNames = { plus: 'CareCall Plus', pro: 'CareCall Pro' };
  const tierPrices = { plus: '$4.99/mo', pro: '$9.99/mo' };
  const name = tierNames[tier] || tier;
  const price = tierPrices[tier] || '';
  const overlay = document.createElement('div');
  overlay.className = 'upgrade-overlay';
  overlay.innerHTML = `
    <div class="upgrade-card">
      <div class="upgrade-icon">⭐</div>
      <div class="upgrade-title">${name}</div>
      <div class="upgrade-desc">${t('This feature requires')} ${name} ${price ? '(' + price + ')' : ''}</div>
      <button class="upgrade-btn" onclick="this.closest('.upgrade-overlay').remove()">
        ${t('Upgrade')}
      </button>
      <button class="upgrade-dismiss" onclick="this.closest('.upgrade-overlay').remove()">
        ${t('Not now')}
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
}

// Patient-specific
const PS = {
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
const CS = {
  activeCalls: {},   // callId -> { data, timerId }
  alertCallId: null,
};

let _roomsListenerRef = null;
let _tempCarerActive = false;
let _realRole = null; // stash the user's permanent role during temp-carer
let _appOnline = true; // tracks Firebase connectivity

// Unified listener teardown — prevents Firebase leaks across role switches,
// sign-out, and launchMainScreen re-entry.
function _teardownAllListeners() {
  if (PS._memberRefs) { PS._memberRefs.forEach(r => { try { r.off(); } catch(_) {} }); PS._memberRefs = []; }
  if (CS._listenerRefs) { CS._listenerRefs.forEach(r => { try { r.off(); } catch(_) {} }); CS._listenerRefs = []; }
  if (_familyListenerRefs) { _familyListenerRefs.forEach(r => { try { r.off(); } catch(_) {} }); _familyListenerRefs = []; }
  if (_ambientListenerRefs) { _ambientListenerRefs.forEach(r => { try { r.off(); } catch(_) {} }); _ambientListenerRefs = []; }
  if (_vcListenerRefs) { _vcListenerRefs.forEach(r => { try { r.off(); } catch(_) {} }); _vcListenerRefs = []; }
  if (_roomsListenerRef) { try { _roomsListenerRef.off(); } catch(_) {} _roomsListenerRef = null; }
  if (_pendingPairsRef) { try { _pendingPairsRef.off(); } catch(_) {} _pendingPairsRef = null; }
  if (typeof _stopCalendarListeners === 'function') _stopCalendarListeners();
  if (typeof _stopDocumentListeners === 'function') _stopDocumentListeners();
  if (typeof _stopHealthListeners === 'function') _stopHealthListeners();
}

function saveState() {
  // Guard: never persist incomplete state — if name or role is missing
  // the next boot's loadState() would discard it, forcing re-setup and
  // creating duplicate rooms.
  if (!S.name || !S.role) {
    console.warn('[saveState] skipped — incomplete state (name=' + S.name + ', role=' + S.role + ')');
    return;
  }
  // Always persist the REAL role, not the temporary carer role.
  // _realRole is set when temp-carer is active; otherwise S.role is the real role.
  const persistRole = _tempCarerActive && _realRole ? _realRole : S.role;
  localStorage.setItem('carecall_v5', JSON.stringify({
    uid:          S.uid,
    name:         S.name,
    role:         persistRole,
    personalCode: S.personalCode,
    phone:        S.phone,
    avatar:       S.avatar,
    rooms:        S.rooms,
    activeRoom:   S.activeRoom,
    emergencyNumber: S.emergencyNumber,
    tier:         S.tier,
  }));
}

async function loadState() {
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
        if (db) {
          const snap = await db.ref(`carecall/users/${d.uid}`).once('value');
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

// ════════════════════════════════════════════════════════════
//  VOICE NOTES
// ════════════════════════════════════════════════════════════
let _vnRecorder = null;
let _vnChunks = [];
let _vnBlob = null;
let _vnBase64 = null;
let _vnRecording = false;
const VN_MAX_SECONDS = 15;
const VN_MIN_MS = 500; // minimum recording duration
let _vnTimeout = null;
let _vnStartTime = 0;

function _getRecorderMimeType() {
  // Pick a supported mime type (Safari doesn't support webm)
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', ''];
  for (const t of types) {
    if (!t || MediaRecorder.isTypeSupported(t)) return t || undefined;
  }
  return undefined;
}

async function _voiceNoteDown(evt) {
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

function _voiceNoteUp(evt) {
  if (evt && evt.preventDefault) evt.preventDefault();
  clearTimeout(_vnTimeout);
  _unregisterTick('vnTimer');
  if (_vnRecorder && _vnRecording) {
    _vnRecording = false;
    _vnRecorder.stop();
    if (navigator.vibrate) navigator.vibrate([50, 30, 50]); // double tap = stopped
  }
}

function playVoiceNote() {
  if (!_vnBlob) return;
  const audio = new Audio(URL.createObjectURL(_vnBlob));
  audio.play().catch(() => toast(t('Could not play audio')));
}

function clearVoiceNote() {
  _vnBlob = null; _vnBase64 = null; _vnChunks = []; _vnStartTime = 0;
  document.getElementById('vn-recorded').classList.remove('show');
  const btn = document.getElementById('voice-note-btn');
  btn.classList.remove('has-note', 'recording');
  document.getElementById('vn-icon').textContent = '🎙️';
  document.getElementById('vn-label').textContent = t('Voice Note');
}

function playAlertVoiceNote() {
  const vnBtn = document.getElementById('ia-vn-btn');
  if (!vnBtn._voiceNote) return;
  const audio = new Audio(vnBtn._voiceNote);
  audio.play().catch(() => toast(t('Could not play voice note')));
}

// ── Speech-to-text dictation for custom message ──
let _dictationRecognition = null;
let _dictating = false;

function toggleDictation() {
  if (_dictating) {
    _stopDictation();
  } else {
    _startDictation();
  }
}

async function _startDictation() {
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

function _startWebDictation() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { toast(t('Speech recognition not available')); return; }

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

function _stopDictation() {
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

function playCallVoiceNote(callId) {
  const call = CS.activeCalls[callId];
  if (!call || !call.voiceNote) return;
  const audio = new Audio(call.voiceNote);
  audio.play().catch(() => toast(t('Could not play voice note')));
}

// ════════════════════════════════════════════════════════════
//  FALL DETECTION
// ════════════════════════════════════════════════════════════
const FD = {
  active:       false,
  wakeLock:     null,
  sensitivity:  'medium',  // 'low' | 'medium' | 'high'

  // Algorithm state
  buffer:       [],        // rolling {svm, ax, ay, az, t} buffer
  phase:        'idle',    // 'idle' | 'detected'
  lastAlertAt:  0,
  COOLDOWN:     30000,

  // Countdown state
  countdownTimer: null,
  countdownSec:   15,
};

// Sensitivity presets: { freefallG, impactG, freefallMs, stillVar, stillMs, impactWindow, orientDeg }
const FD_PRESETS = {
  low:    { freefallG: 0.4, impactG: 3.5, freefallMs: 150, stillVar: 0.25, stillMs: 2500, impactWindow: 500, orientDeg: 50 },
  medium: { freefallG: 0.6, impactG: 2.0, freefallMs: 80,  stillVar: 0.4,  stillMs: 2000, impactWindow: 600, orientDeg: 40 },
  high:   { freefallG: 0.8, impactG: 1.5, freefallMs: 50,  stillVar: 0.5,  stillMs: 1500, impactWindow: 800, orientDeg: 30 },
};

async function toggleFallMonitoring() {
  if (!FD.active && !_requireTier('fall_detection', 'plus')) return;
  if (FD.active) {
    stopFallMonitoring();
  } else {
    await startFallMonitoring();
  }
}

async function startFallMonitoring() {
  // iOS 13+ requires explicit permission via user gesture
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceMotionEvent.requestPermission();
      if (perm !== 'granted') {
        toast(t('Motion sensor permission required for fall detection'));
        return;
      }
    } catch(e) {
      toast(t('Could not access motion sensors') + ': ' + (e.message || e));
      return;
    }
  } else if (typeof DeviceMotionEvent === 'undefined') {
    toast(t('Motion sensors not available on this device'));
    return;
  }

  FD.active = true;
  FD.phase = 'idle';
  FD.buffer = [];

  document.getElementById('fall-toggle').classList.add('active');
  document.getElementById('fall-indicator').classList.add('show');
  _updateSensitivityLabel();

  window.addEventListener('devicemotion', _onDeviceMotion);

  // Verify we actually receive events (some devices/browsers silently fail)
  FD._verifyTimer = setTimeout(() => {
    if (FD.active && FD.buffer.length === 0) {
      toast(t('No motion data received — sensor may not be available'));
      stopFallMonitoring();
    }
  }, 2000);

  // Request wake lock to keep screen on during monitoring
  try {
    if ('wakeLock' in navigator) {
      FD.wakeLock = await navigator.wakeLock.request('screen');
      FD.wakeLock.addEventListener('release', () => { FD.wakeLock = null; });
    }
  } catch(e) {}

  toast(t('Fall detection active — keep phone on your body'));
}

function stopFallMonitoring() {
  FD.active = false;
  FD.phase = 'idle';
  clearTimeout(FD._verifyTimer);
  window.removeEventListener('devicemotion', _onDeviceMotion);

  document.getElementById('fall-toggle').classList.remove('active');
  document.getElementById('fall-indicator').classList.remove('show');

  if (FD.wakeLock) { FD.wakeLock.release().catch(()=>{}); FD.wakeLock = null; }
}

function cycleFallSensitivity() {
  const levels = ['low', 'medium', 'high'];
  const i = levels.indexOf(FD.sensitivity);
  FD.sensitivity = levels[(i + 1) % levels.length];
  _updateSensitivityLabel();
  _syncSettingsToggles();
  toast(t('Fall Detection') + ': ' + FD.sensitivity);
}

function _updateSensitivityLabel() {
  const el = document.getElementById('fall-sensitivity-label');
  if (el) el.textContent = FD.sensitivity;
  const shEl = document.getElementById('sh-fall-sensitivity');
  if (shEl) shEl.textContent = FD.sensitivity;
}

function _onDeviceMotion(evt) {
  // Use acceleration (without gravity) if available, else fall back to accelerationIncludingGravity
  let a = evt.acceleration;
  let includesGravity = false;
  if (!a || a.x === null || a.y === null) {
    a = evt.accelerationIncludingGravity;
    includesGravity = true;
  }
  if (!a || a.x === null) return;

  const now = Date.now();
  const ax = a.x, ay = a.y, az = a.z;
  // SVM in g-force
  let svm = Math.sqrt(ax*ax + ay*ay + az*az) / 9.81;
  // If using accelerationIncludingGravity, at rest svm ≈ 1g
  // If using acceleration (no gravity), at rest svm ≈ 0g

  // Store raw gravity vector for orientation change detection
  const g = evt.accelerationIncludingGravity;
  const gx = g ? (g.x || 0) : 0;
  const gy = g ? (g.y || 0) : 0;
  const gz = g ? (g.z || 0) : 0;

  FD.buffer.push({ svm, gx, gy, gz, t: now, incGrav: includesGravity });
  if (FD.buffer.length > 200) FD.buffer.shift();

  if (now - FD.lastAlertAt < FD.COOLDOWN) return;
  if (FD.phase !== 'idle') return;

  const P = FD_PRESETS[FD.sensitivity];

  // ── DETECTION PATH 1: Classic free-fall → impact → stillness ──
  // Check for recent free-fall in the buffer
  const freefallSamples = _findFreeFall(now, P);
  if (freefallSamples) {
    const impact = _findImpact(freefallSamples.endTime, now, P);
    if (impact) {
      const still = _checkStillness(impact.time, now, P);
      if (still) { _onFallDetected(); return; }
    }
  }

  // ── DETECTION PATH 2: Sudden impact + orientation change + stillness ──
  // Catches softer/cushioned falls that may lack a clean free-fall phase
  const recentImpact = _findRecentImpact(now, P);
  if (recentImpact) {
    const orientChanged = _checkOrientationChange(recentImpact.time, now, P);
    const still = _checkStillness(recentImpact.time, now, P);
    if (orientChanged && still) { _onFallDetected(); return; }
  }
}

function _findFreeFall(now, P) {
  // Look for a stretch of low SVM in recent buffer
  let start = 0, count = 0;
  for (let i = FD.buffer.length - 1; i >= 0; i--) {
    const s = FD.buffer[i];
    if (now - s.t > 3000) break; // only look back 3s
    // For accelerationIncludingGravity, free-fall means svm drops TOWARD 0 (below freefallG)
    // For acceleration (no gravity), free-fall means svm is near 0
    const threshold = s.incGrav ? P.freefallG : (P.freefallG * 0.5);
    if (s.svm < threshold) {
      count++;
      start = s.t;
    } else if (count > 0) {
      // Check if the stretch was long enough
      const endT = FD.buffer[i + 1] ? FD.buffer[i + 1].t : now;
      if (endT - start >= P.freefallMs) {
        return { startTime: start, endTime: endT };
      }
      count = 0;
    }
  }
  // Check trailing sequence
  if (count > 0) {
    const endT = FD.buffer[FD.buffer.length - 1].t;
    if (endT - start >= P.freefallMs) {
      return { startTime: start, endTime: endT };
    }
  }
  return null;
}

function _findImpact(afterTime, now, P) {
  for (let i = FD.buffer.length - 1; i >= 0; i--) {
    const s = FD.buffer[i];
    if (s.t < afterTime) break;
    if (s.t > afterTime + P.impactWindow) continue;
    if (s.svm > P.impactG) return { time: s.t, svm: s.svm };
  }
  return null;
}

function _findRecentImpact(now, P) {
  // Find the highest SVM spike in the last 3 seconds
  let best = null;
  for (let i = FD.buffer.length - 1; i >= 0; i--) {
    const s = FD.buffer[i];
    if (now - s.t > 3000) break;
    if (s.svm > P.impactG && (!best || s.svm > best.svm)) {
      best = { time: s.t, svm: s.svm };
    }
  }
  return best;
}

function _checkStillness(afterTime, now, P) {
  const elapsed = now - afterTime;
  if (elapsed < P.stillMs) return false;
  const window = FD.buffer.filter(s => s.t >= afterTime && s.t <= afterTime + P.stillMs);
  if (window.length < 10) return false;
  const mean = window.reduce((s, r) => s + r.svm, 0) / window.length;
  const variance = window.reduce((s, r) => s + (r.svm - mean) ** 2, 0) / window.length;
  return variance < P.stillVar;
}

function _checkOrientationChange(sinceTime, now, P) {
  // Compare gravity vector direction before the event vs after
  // A fall typically changes orientation by 40-90 degrees (upright → horizontal)
  const before = FD.buffer.filter(s => s.t < sinceTime && s.t > sinceTime - 1000);
  const after  = FD.buffer.filter(s => s.t > sinceTime + 500 && s.t <= now);
  if (before.length < 5 || after.length < 5) return false;

  const avgVec = (samples) => {
    const n = samples.length;
    return {
      x: samples.reduce((s, r) => s + r.gx, 0) / n,
      y: samples.reduce((s, r) => s + r.gy, 0) / n,
      z: samples.reduce((s, r) => s + r.gz, 0) / n,
    };
  };
  const bv = avgVec(before), av = avgVec(after);

  // Angle between the two vectors (dot product / magnitudes)
  const dot = bv.x*av.x + bv.y*av.y + bv.z*av.z;
  const magB = Math.sqrt(bv.x*bv.x + bv.y*bv.y + bv.z*bv.z);
  const magA = Math.sqrt(av.x*av.x + av.y*av.y + av.z*av.z);
  if (magB < 0.1 || magA < 0.1) return false;

  const cosAngle = Math.max(-1, Math.min(1, dot / (magB * magA)));
  const angleDeg = Math.acos(cosAngle) * (180 / Math.PI);

  return angleDeg >= P.orientDeg;
}

function _onFallDetected(alertTitle) {
  FD.lastAlertAt = Date.now();
  if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);

  // Show countdown overlay — auto-calls carer if not cancelled
  document.getElementById('fall-alert-title').textContent = alertTitle || t('Fall Detected');
  const alert = document.getElementById('fall-alert');
  alert.classList.add('show');
  FD.countdownSec = 5; // short for testing — increase to 15 for production
  document.getElementById('fall-countdown').textContent = FD.countdownSec;

  _registerTick('fallCountdown', () => {
    FD.countdownSec--;
    document.getElementById('fall-countdown').textContent = FD.countdownSec;
    if (navigator.vibrate) navigator.vibrate(100);
    if (FD.countdownSec <= 0) {
      _unregisterTick('fallCountdown');
      document.getElementById('fall-alert').classList.remove('show');
      _sendFallCall();
    }
  });
}

// ── Emergency button: hold-to-activate safety mechanism ──
let _emergencyTimer = null;
let _emergencyStart = 0;
const EMERGENCY_HOLD_MS = 3000; // 3 seconds to activate
let _emergencyAnimFrame = null;

function _emergencyDown(evt) {
  evt.preventDefault();
  if (PS.status === 'calling' || PS.status === 'acked') return;
  _emergencyStart = Date.now();
  const btn = document.getElementById('emergency-btn');
  const hint = btn.querySelector('.emergency-hint');
  btn.classList.add('charging');
  // Countdown haptics and visual: 3... 2... 1...
  let sec = 3;
  if (hint) hint.textContent = sec + '...';
  if (navigator.vibrate) navigator.vibrate(50);
  _registerTick('emergencyCountdown', () => {
    sec--;
    if (sec > 0) {
      if (hint) hint.textContent = sec + '...';
      if (navigator.vibrate) navigator.vibrate(50);
    } else {
      _unregisterTick('emergencyCountdown');
    }
  });
  _emergencyTimer = setTimeout(() => {
    _unregisterTick('emergencyCountdown');
    _emergencyStart = 0;
    btn.classList.remove('charging');
    if (hint) hint.textContent = 'Hold 3s';
    _cancelEmergencyAnim();
    if (navigator.vibrate) navigator.vibrate(300);
    _onFallDetected(t('Emergency Alert'));
  }, EMERGENCY_HOLD_MS);
  _animateEmergencyRing();
}

function _emergencyUp(evt) {
  evt.preventDefault();
  if (_emergencyTimer) {
    _unregisterTick('emergencyCountdown');
    clearTimeout(_emergencyTimer);
    _emergencyTimer = null;
  }
  _emergencyStart = 0;
  const btn = document.getElementById('emergency-btn');
  btn.classList.remove('charging');
  const hint = btn.querySelector('.emergency-hint');
  if (hint) hint.textContent = 'Hold 3s';
  _cancelEmergencyAnim();
  document.getElementById('emergency-ring-fill').style.strokeDashoffset = '289';
}

function _animateEmergencyRing() {
  const ring = document.getElementById('emergency-ring-fill');
  const circumference = 289; // 2 * pi * 46
  function frame() {
    if (!_emergencyStart) return;
    const elapsed = Date.now() - _emergencyStart;
    const progress = Math.min(elapsed / EMERGENCY_HOLD_MS, 1);
    ring.style.strokeDashoffset = String(circumference * (1 - progress));
    if (progress < 1) _emergencyAnimFrame = requestAnimationFrame(frame);
  }
  _emergencyAnimFrame = requestAnimationFrame(frame);
}

function _cancelEmergencyAnim() {
  if (_emergencyAnimFrame) { cancelAnimationFrame(_emergencyAnimFrame); _emergencyAnimFrame = null; }
}

function cancelFallAlert() {
  _unregisterTick('fallCountdown');
  document.getElementById('fall-alert').classList.remove('show');
  toast(t("Alert cancelled — glad you're OK!"));
}

async function _sendFallCall() {
  // Auto-send a call with type "fall" to all carers
  if (PS.status === 'calling' || PS.status === 'acked') return;
  if (!S.rooms.length) { toast(t('No carers connected')); return; }

  unlockAudio();
  setPatientStatus('calling');
  if (navigator.vibrate) navigator.vibrate(200);

  const callData = {
    fromUid:   S.uid,
    fromName:  S.name,
    avatar:    S.avatar || '',
    type:      'fall',
    message:   _buildEmergencyMessage(),
    timestamp: firebase.database.ServerValue.TIMESTAMP,
    status:    'active',
  };
  await _attachLocation(callData);

  try {
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
    // Auto-timeout after 2 minutes
    PS._callTimeout = setTimeout(() => {
      if (PS.status === 'calling') {
        setPatientStatus('ready');
        PS.activeCallId = null;
        if (PS.callListener) { PS.callListener(); PS.callListener = null; }
        _showEmergencyCallPrompt();
      }
    }, CALL_FINAL_TIMEOUT_MS);
  } catch(e) {
    console.error('[FallCall] Failed:', e);
    _showOfflineCallWarning();
    setPatientStatus('ready');
  }
}

// ════════════════════════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════════════════════════
function genCode(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const n = len || 6;
  return Array.from({length: n}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function toast(msg, dur=3000) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(()=>el.classList.remove('show'), dur);
  // Tap to dismiss
  el.onclick = () => { clearTimeout(el._t); el.classList.remove('show'); };
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

function needLabel(type) {
  const map = { water:'💧 Water', medication:'💊 Medication', food:'🍽️ Food', toilet:'🚽 Toilet', pain:'😣 Pain', custom:'✏️ Message', fall:'🚨 Fall Detected', 'checkin-missed':'⚠️ Missed Check-in', 'checkin-help':'🆘 Check-in Help', 'med-missed':'💊 Missed Medication', 'med-taken':'💊 Medication Taken', 'med-refill':'💊 Refill Needed', 'zone-arrival':'🏠 Arrived Safely', help:'🆘 Help' };
  // Handle multi-select: comma-separated types
  if (type && type.includes(',')) {
    return type.split(',').map(t => map[t] || escHtml(t)).join(' · ');
  }
  return map[type] || '🆘 Help';
}

// ── Call / alert timing constants ──
const MISSED_CALL_LOOKBACK_MS = 90000;   // 90s — how far back to scan for missed calls
const CALL_FINAL_TIMEOUT_MS   = 120000;  // 2min — auto-timeout for unanswered calls
const CALL_CARD_REMOVE_DELAY_MS = 8000;  // delay before removing acknowledged-call cards
const NEW_CALL_THRESHOLD_MS   = 60000;   // calls newer than this trigger the incoming alert
const BELL_CADENCE_MS         = 3400;    // interval between bell replays
const BOOT_TIMEOUT_MS         = 8000;    // safety timeout for the boot spinner

// Audio
let audioCtx = null, bellTimer = null, _silentNode = null;
let _bellAudioEl = null; // HTML audio element for iOS fallback

// Generate a short alarm tone as a WAV data URI
function _generateAlarmWav() {
  const sampleRate = 22050, duration = 2, numSamples = sampleRate * duration;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  function writeStr(offset, str) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const freq = (Math.floor(t * 4) % 2 === 0) ? 880 : 1320;
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.5;
    const fade = Math.min(1, (duration - t) * 4, t * 20);
    view.setInt16(44 + i * 2, sample * fade * 32767, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(binary);
}

function _ensureBellAudio() {
  if (_bellAudioEl) return;
  try {
    _bellAudioEl = new Audio(_generateAlarmWav());
    _bellAudioEl.loop = true;
    _bellAudioEl.volume = 1.0;
    // On iOS, calling load() during a user gesture primes the element
    _bellAudioEl.load();
  } catch(e) { console.warn('[Audio] Could not create bell audio element:', e); }
}

function playBellFallback() {
  _ensureBellAudio();
  if (_bellAudioEl) {
    _bellAudioEl.currentTime = 0;
    _bellAudioEl.play().catch(() => {});
  }
}

function stopBellFallback() {
  if (_bellAudioEl) {
    _bellAudioEl.pause();
    _bellAudioEl.currentTime = 0;
  }
}

// Must be called inside a user gesture (tap).
// Creates AudioContext + plays a silent buffer to unlock iOS.
// Then starts a silent oscillator loop to keep context from
// being suspended again (iOS kills suspended contexts).
function unlockAudio() {
  _ensureBellAudio();
  if (audioCtx && audioCtx.state === 'running') return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    // Play a real (silent) buffer — required by iOS to unlock
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.1, audioCtx.sampleRate);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start();
    // Keep context alive with a continuous silent oscillator
    if (_silentNode) { try { _silentNode.stop(); } catch(e){} }
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.00001; // essentially silent
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    _silentNode = osc;
  } catch(e) { console.warn('[Audio] unlock failed:', e); }
}

async function playBell() {
  try {
    if (!audioCtx) return; // Not unlocked yet — wait for user gesture
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
function startBell() {
  if (bellTimer) clearInterval(bellTimer);
  playBell();
  bellTimer = setInterval(playBell, BELL_CADENCE_MS);
  // HTML audio fallback for iOS (WebAudio may be suspended)
  playBellFallback();
}
function stopBell() {
  if (bellTimer) { clearInterval(bellTimer); bellTimer = null; }
  stopBellFallback();
}

// ════════════════════════════════════════════════════════════
//  NAVIGATION
// ════════════════════════════════════════════════════════════
const _screenHistory = [];

function showScreen(id) {
  // PIN gate: if settings is PIN-locked, intercept and show the PIN
  // overlay. On correct entry, proceed to settings normally.
  if (id === 's-settings' && _isPinLocked()) {
    _showPinOverlay(() => showScreen('s-settings'));
    return;
  }
  // Re-arm the PIN lock when leaving settings so the next entry requires it.
  const prev = document.querySelector('.screen.active');
  if (prev && prev.id === 's-settings' && id !== 's-settings') {
    _pinUnlockedAt = 0;
  }
  // Push current screen to history before switching
  if (prev && prev.id !== id) {
    _screenHistory.push(prev.id);
    // Keep history bounded to prevent leaks
    if (_screenHistory.length > 20) _screenHistory.splice(0, _screenHistory.length - 20);
  }
  if (prev) prev.classList.remove('active');
  const next = document.getElementById(id);
  if (next) next.classList.add('active');
  else console.warn('[showScreen] Screen not found:', id);

  // Refresh log/settings/calendar when opened
  if (id === 's-log') refreshLog();
  if (id === 's-settings') refreshSettings();
  if (id === 's-calendar') {
    _calSelectedDate = _todayStr();
    const todayParts = _calSelectedDate.split('-');
    _calYear = parseInt(todayParts[0]);
    _calMonth = parseInt(todayParts[1]) - 1;
    renderCalendar();
  }
}

function _homeScreen() {
  if (S.role === 'family') return 's-log';
  return S.role === 'carer' ? 's-carer' : 's-patient';
}

function goBack() {
  // Pop from history if available, otherwise fall back to home screen
  const prevScreen = _screenHistory.pop();
  const target = prevScreen || _homeScreen();
  showScreen(target);
}

// ════════════════════════════════════════════════════════════
//  SETUP FLOW
// ════════════════════════════════════════════════════════════
let _pendingRole = null;

function setupChooseRole(role) {
  unlockAudio(); // iOS: must unlock inside direct user gesture
  _pendingRole = role;
  showScreen('s-name');
  setTimeout(()=>document.getElementById('name-input').focus(), 400);
}

function setupSaveName() {
  const name = document.getElementById('name-input').value.trim();
  if (!name) { toast(t('Please enter your name')); return; }
  S.name = name;
  S.role = _pendingRole;
  // Route to auth screen (register/login) before showing the code screen.
  _authSwitchTab('register');
  showScreen('s-auth');
  setTimeout(() => document.getElementById('auth-email')?.focus(), 300);
}

// Called after auth completes (register or login). Generates code + shows room screen.
// Async because syncUserProfile must complete before we display the code —
// otherwise the codeIndex entry may not exist yet when the other user scans it,
// producing a "code not found" error.
async function _setupPostAuth() {
  if (!S.personalCode) S.personalCode = genCode();
  // Ensure the codeIndex entry exists in Firebase BEFORE showing the code to
  // the user. Without this, a carer could share a code that isn't in codeIndex
  // yet, causing "code not found" on the patient side.
  try { await syncUserProfile(); } catch(e) {
    console.warn('[_setupPostAuth] syncUserProfile failed, continuing:', e && e.message);
  }
  document.getElementById('new-room-code').textContent = S.personalCode;

  const roleToTitle = { carer: t('Your Carer Code'), family: t('Your Family Code'), patient: t('Your Patient Code') };
  document.getElementById('room-title').textContent = roleToTitle[S.role] || t('Your Personal Code');
  document.getElementById('room-sub').textContent = t('Share this code to connect');
  document.getElementById('room-code-hint').textContent = t('Share this code to connect');
  const connectLabels = { carer: t("Enter patient's code"), family: t("Enter patient's code"), patient: t("Enter carer or family code") };
  const connectLabel = connectLabels[S.role] || t("Enter pair code");
  document.getElementById('connect-input-label').textContent = connectLabel;
  showScreen('s-room');

  // Prompt carers to add their phone number for offline safety fallback
  if (S.role === 'carer' && !S.phone) {
    setTimeout(() => _showCarerPhonePrompt(), 600);
  }
}

function _showCarerPhonePrompt() {
  const overlay = document.createElement('div');
  overlay.id = 'carer-phone-prompt';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:35;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px;padding:28px 20px;max-width:340px;width:100%;text-align:center">
      <div style="font-size:2rem;margin-bottom:8px">📱</div>
      <div style="font-family:'Fraunces',serif;font-size:1.2rem;font-weight:700;margin-bottom:8px">${t('Add Your Phone Number')}</div>
      <div style="font-size:0.9rem;color:#666;margin-bottom:16px">${t('Your patient needs your phone number as a safety fallback.')}</div>
      <input id="carer-phone-input" type="tel" placeholder="+1 555 123 4567" style="width:100%;padding:12px;border:2px solid #ddd;border-radius:12px;font-size:1rem;font-family:'Outfit',sans-serif;box-sizing:border-box;margin-bottom:12px">
      <button onclick="_saveCarerPhoneFromPrompt()" style="background:var(--patient-primary,#2563eb);color:#fff;border:none;border-radius:14px;padding:14px;font-size:1rem;font-weight:700;font-family:'Outfit',sans-serif;cursor:pointer;width:100%">${t('Save')}</button>
      <button onclick="document.getElementById('carer-phone-prompt').remove()" style="margin-top:8px;background:transparent;border:none;color:#999;font-size:0.85rem;cursor:pointer;font-family:'Outfit',sans-serif">${t('Skip for now')}</button>
    </div>`;
  document.body.appendChild(overlay);
}

function _saveCarerPhoneFromPrompt() {
  const input = document.getElementById('carer-phone-input');
  const phone = (input && input.value || '').trim();
  if (phone) {
    S.phone = phone;
    saveState();
    S.rooms.forEach(code => {
      db.ref(`carecall/rooms/${code}/members/${S.uid}/phone`).set(S.phone);
    });
    syncUserProfile();
    toast(t('Phone number saved'));
  }
  const overlay = document.getElementById('carer-phone-prompt');
  if (overlay) overlay.remove();
}

// ════════════════════════════════════════════════════════════════════
// AUTH — email/password registration, login, forgot-password
// ════════════════════════════════════════════════════════════════════
let _authMode = 'register'; // 'register' | 'login'

// Returning user flow: tap "Already have an account?" on the welcome
// screen → go straight to auth screen in login mode, bypassing role
// and name selection. On successful login, the profile (name, role,
// rooms) is loaded from Firebase and the user goes to their main screen.
function showReturningSignIn() {
  _authSwitchTab('login');
  showScreen('s-auth');
  // Hide the Register tab — returning users should only log in.
  // If they need a new account, they go back and use the normal
  // flow (role → name → auth) which sets S.name and S.role first.
  const regTab = document.getElementById('auth-tab-register');
  if (regTab) regTab.style.display = 'none';
  const backBtn = document.querySelector('#s-auth .btn-link[onclick*="s-name"]');
  if (backBtn) backBtn.setAttribute('onclick', "showScreen('s-welcome');document.getElementById('auth-tab-register').style.display=''");
  setTimeout(() => document.getElementById('auth-email')?.focus(), 300);
}

function _authSwitchTab(mode) {
  _authMode = mode;
  const el = (id) => document.getElementById(id);
  if (!el('auth-tab-register')) return;
  el('auth-tab-register').classList.toggle('selected', mode === 'register');
  el('auth-tab-login').classList.toggle('selected', mode === 'login');
  if (el('auth-confirm-group')) el('auth-confirm-group').style.display = mode === 'register' ? '' : 'none';
  if (el('auth-phone-group')) el('auth-phone-group').style.display = mode === 'register' ? '' : 'none';
  if (el('auth-consent-row')) el('auth-consent-row').style.display = mode === 'register' ? '' : 'none';
  if (el('auth-forgot')) el('auth-forgot').style.display = mode === 'login' ? '' : 'none';
  if (el('auth-submit-btn')) el('auth-submit-btn').textContent = mode === 'register' ? t('Create Account') : t('Log in');
  if (el('auth-title')) el('auth-title').textContent = mode === 'register' ? t('Create your account') : t('Log in to your account');
  if (el('auth-err')) el('auth-err').textContent = '';
}

function _authPasswordStrength(pw) {
  if (!pw) return '';
  const hasLetter = /[a-zA-Z]/.test(pw);
  const hasDigit = /\d/.test(pw);
  const hasSpecial = /[^a-zA-Z0-9]/.test(pw);
  const len = pw.length;
  if (len < 8) return 'weak';
  const variety = (hasLetter ? 1 : 0) + (hasDigit ? 1 : 0) + (hasSpecial ? 1 : 0);
  if (len >= 12 && variety >= 2) return 'strong';
  if (variety >= 2) return 'fair';
  return 'weak';
}

// Live strength indicator on password input
document.addEventListener('input', e => {
  if (e.target.id !== 'auth-password') return;
  const strength = _authPasswordStrength(e.target.value);
  const el = document.getElementById('auth-strength');
  if (!el) return;
  el.className = 'auth-strength ' + strength;
  const labels = { weak: t('Weak'), fair: t('Fair'), strong: t('Strong') };
  el.textContent = e.target.value ? (labels[strength] || '') : '';
});

async function _authSubmit() {
  const email = (document.getElementById('auth-email').value || '').trim().toLowerCase();
  const password = document.getElementById('auth-password').value || '';
  const errEl = document.getElementById('auth-err');
  errEl.textContent = '';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.textContent = t('Please enter a valid email address');
    return;
  }

  if (_authMode === 'register') {
    const confirm = document.getElementById('auth-confirm').value || '';
    if (password.length < 8) { errEl.textContent = t('Password must be at least 8 characters'); return; }
    if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      errEl.textContent = t('Password must contain both letters and numbers');
      return;
    }
    if (password !== confirm) { errEl.textContent = t('Passwords do not match'); return; }
    if (!document.getElementById('auth-consent-check').checked) {
      errEl.textContent = t('Please accept the data consent to continue');
      return;
    }
    const phone = (document.getElementById('auth-phone').value || '').trim();
    if (phone) S.phone = phone;

    const btn = document.getElementById('auth-submit-btn');
    btn.disabled = true; btn.textContent = t('Creating account…'); btn.classList.add('loading');
    try {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      S.uid = cred.user.uid;
      localStorage.setItem('carecall_uid', S.uid);
      // Send verification email (non-blocking — user can continue).
      try { await cred.user.sendEmailVerification(); } catch(_) {}
      saveState();
      toast(t('Account created! A verification email has been sent.'));
      btn.classList.remove('loading');
      await _setupPostAuth();
    } catch(e) {
      btn.disabled = false; btn.textContent = t('Create Account'); btn.classList.remove('loading');
      errEl.textContent = _authErrorMessage(e);
    }
  } else {
    // Login
    const btn = document.getElementById('auth-submit-btn');
    btn.disabled = true; btn.textContent = t('Signing in…'); btn.classList.add('loading');
    try {
      const cred = await auth.signInWithEmailAndPassword(email, password);
      S.uid = cred.user.uid;
      localStorage.setItem('carecall_uid', S.uid);
      // Returning user: try to load their saved state from Firebase.
      try {
        const snap = await db.ref(`carecall/users/${S.uid}`).once('value');
        const profile = snap.val();
        if (profile) {
          S.name = profile.name || S.name;
          S.role = profile.role || S.role;
          S.personalCode = profile.personalCode || S.personalCode;
          S.rooms = profile.rooms || [];
          S.phone = profile.phone || S.phone || '';
          S.avatar = profile.avatar || S.avatar || '';
          S.activeRoom = S.rooms[0] || null;
        }
      } catch(_) {}
      saveState();
      btn.disabled = false; btn.classList.remove('loading');
      if (S.name && S.role) {
        // Full returning user — go straight to main screen.
        await syncUserProfile();
        await joinAllRooms();
        launchMainScreen();
      } else if (S.role && !S.name) {
        // Role known but name missing — send back to name entry.
        btn.textContent = t('Log in');
        showScreen('s-name');
      } else if (!S.role && S.name) {
        // Name known but role missing — send to welcome for role pick.
        btn.textContent = t('Log in');
        showScreen('s-welcome');
        toast(t('Please choose your role'));
      } else {
        // Account exists but profile is completely empty (e.g. DB was
        // cleared). Send back to role/welcome screen.
        btn.textContent = t('Log in');
        showScreen('s-welcome');
        toast(t('Please complete your profile'));
      }
    } catch(e) {
      btn.disabled = false; btn.textContent = t('Log in'); btn.classList.remove('loading');
      errEl.textContent = _authErrorMessage(e);
    }
  }
}

function _authErrorMessage(e) {
  const code = (e && e.code) || '';
  if (code.includes('email-already-in-use')) return t('This email is already registered. Try logging in.');
  if (code.includes('invalid-email')) return t('Please enter a valid email address');
  if (code.includes('weak-password')) return t('Password is too weak — use at least 8 characters with letters and numbers');
  if (code.includes('user-not-found')) return t('No account found with this email');
  if (code.includes('wrong-password') || code.includes('invalid-credential')) return t('Incorrect password');
  if (code.includes('too-many-requests')) return t('Too many attempts. Please wait a moment and try again.');
  if (code.includes('network-request-failed')) return t('Network error — check your connection');
  return (e && e.message) || t('Something went wrong');
}

async function _authForgotPassword() {
  const email = (document.getElementById('auth-email').value || '').trim().toLowerCase();
  const errEl = document.getElementById('auth-err');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.textContent = t('Enter your email above, then tap Forgot password');
    return;
  }
  try {
    await auth.sendPasswordResetEmail(email);
    toast(t('Password reset email sent. Check your inbox.'));
  } catch(e) {
    errEl.textContent = _authErrorMessage(e);
  }
}

// Sign out (available in Settings)
async function signOut() {
  if (!confirm(t('Sign out? You will need your email and password to sign back in.'))) return;
  _teardownAllListeners();
  try { await auth.signOut(); } catch(_) {}
  localStorage.clear();
  location.reload();
}

// ════════════════════════════════════════════════════════════════════
// TAP-TO-REVEAL CODE MASKING
// ════════════════════════════════════════════════════════════════════
let _codeRevealed = false;
let _codeRevealTimer = null;

function _toggleCodeReveal() {
  const el = document.getElementById('s-personal-code');
  if (!el) return;
  if (_codeRevealed) {
    el.textContent = '•'.repeat((S.personalCode || '').length || 6);
    _codeRevealed = false;
    clearTimeout(_codeRevealTimer);
  } else {
    el.textContent = S.personalCode || '';
    _codeRevealed = true;
    _codeRevealTimer = setTimeout(() => {
      el.textContent = '•'.repeat((S.personalCode || '').length || 6);
      _codeRevealed = false;
    }, 30000);
  }
}

async function _copyPersonalCode() {
  if (!S.personalCode) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(S.personalCode);
    } else {
      const ta = document.createElement('textarea');
      ta.value = S.personalCode; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    toast(t('Code copied'));
  } catch(_) { toast(t('Copy failed')); }
}

// ════════════════════════════════════════════════════════════════════
// PIN LOCK ON SETTINGS
// ════════════════════════════════════════════════════════════════════
let _pinUnlockedAt = 0;
const PIN_TIMEOUT_MS = 5 * 60 * 1000;

function _getPinHash() {
  return localStorage.getItem('carecall_pin_hash') || '';
}

async function _hashPin(pin) {
  const data = new TextEncoder().encode('carecall_salt_' + pin);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function _isPinLocked() {
  if (!_getPinHash()) return false;
  return (Date.now() - _pinUnlockedAt) > PIN_TIMEOUT_MS;
}

function _showPinOverlay(onSuccess) {
  document.querySelector('.pin-overlay')?.remove();
  let entered = '';
  const overlay = document.createElement('div');
  overlay.className = 'pin-overlay';

  const updateDots = () => {
    overlay.querySelectorAll('.pin-dot').forEach((d, i) => {
      d.classList.toggle('filled', i < entered.length);
    });
  };

  const tryPin = async () => {
    const hash = await _hashPin(entered);
    if (hash === _getPinHash()) {
      _pinUnlockedAt = Date.now();
      overlay.remove();
      if (onSuccess) onSuccess();
    } else {
      entered = '';
      updateDots();
      overlay.querySelector('.pin-error').textContent = t('Incorrect PIN');
      if (navigator.vibrate) navigator.vibrate(200);
    }
  };

  const press = (digit) => {
    if (entered.length >= 4) return;
    entered += digit;
    updateDots();
    if (entered.length === 4) setTimeout(tryPin, 150);
  };

  const backspace = () => {
    entered = entered.slice(0, -1);
    updateDots();
    overlay.querySelector('.pin-error').textContent = '';
  };

  overlay.innerHTML = `
    <div style="font-family:'Fraunces',serif;font-size:1.3rem;color:#F1F5F9">🔒 ${escHtml(t('Enter PIN'))}</div>
    <div class="pin-dots">${'<div class="pin-dot"></div>'.repeat(4)}</div>
    <div class="pin-error" style="font-size:0.78rem;color:var(--danger);min-height:1.2em"></div>
    <div class="pin-keypad">
      ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="pin-key" data-d="${n}">${n}</button>`).join('')}
      <button class="pin-key empty"></button>
      <button class="pin-key" data-d="0">0</button>
      <button class="pin-key backspace" data-d="back">⌫</button>
    </div>
    <button class="btn-link" onclick="_pinForgot()" style="margin-top:16px;font-size:0.78rem">${escHtml(t('Forgot PIN?'))}</button>
    <button class="btn-link" onclick="this.closest('.pin-overlay').remove();goBack()" style="margin-top:4px">${escHtml(t('Cancel'))}</button>`;

  overlay.addEventListener('click', e => {
    const key = e.target.closest('.pin-key');
    if (!key) return;
    const d = key.dataset.d;
    if (d === 'back') backspace();
    else press(d);
  });
  document.body.appendChild(overlay);
}

async function _setupPin() {
  if (!_requireTier('pin_lock', 'pro')) return;
  const pin = prompt(t('Choose a 4-digit PIN to lock Settings:'));
  if (!pin || !/^\d{4}$/.test(pin.trim())) { toast(t('PIN must be exactly 4 digits')); return; }
  const confirm2 = prompt(t('Confirm your PIN:'));
  if (confirm2 !== pin.trim()) { toast(t('PINs do not match')); return; }
  const hash = await _hashPin(pin.trim());
  localStorage.setItem('carecall_pin_hash', hash);
  _pinUnlockedAt = Date.now();
  toast(t('PIN set'));
  refreshSettings();
}

function _removePin() {
  if (!confirm(t('Remove the PIN lock from Settings?'))) return;
  localStorage.removeItem('carecall_pin_hash');
  toast(t('PIN removed'));
  refreshSettings();
}

async function _pinForgot() {
  const user = auth.currentUser;
  if (!user || !user.email) {
    toast(t('No email account linked — cannot reset PIN.'));
    return;
  }
  const password = prompt(t('Enter your account password to reset PIN:'));
  if (!password) return;
  try {
    const credential = firebase.auth.EmailAuthProvider.credential(user.email, password);
    await user.reauthenticateWithCredential(credential);
    localStorage.removeItem('carecall_pin_hash');
    _pinUnlockedAt = Date.now();
    document.querySelector('.pin-overlay')?.remove();
    toast(t('PIN cleared — you can set a new one in Settings.'));
    showScreen('s-settings');
  } catch(e) {
    const code = (e && e.code) || '';
    if (code.includes('wrong-password') || code.includes('invalid-credential')) {
      toast(t('Incorrect password'));
    } else {
      toast(t('Could not verify — check your connection.'));
    }
  }
}

async function setupConnect() {
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  const err  = document.getElementById('room-err');
  if (code.length < 4) { err.textContent = t('Please enter your pair code'); return; }
  err.textContent = '';
  const btn = document.getElementById('room-join-btn');
  const restoreBtn = () => { btn.disabled = false; btn.textContent = t('Connect →'); btn.classList.remove('loading'); };
  btn.disabled = true; btn.textContent = t('Connecting…'); btn.classList.add('loading');

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

async function setupSkipConnect() {
  try {
    if (!S.personalCode) S.personalCode = genCode();
    await syncUserProfile();
    await finishSetup();
  } catch(e) {
    console.warn('[setupSkipConnect] failed:', e && e.message);
    toast(t('Could not connect — please try again.'));
  }
}

async function finishSetup() {
  if (!S.name || !S.role) {
    console.warn('[finishSetup] Incomplete state — name:', S.name, 'role:', S.role);
    showScreen('s-welcome');
    toast(t('Please complete registration first.'));
    return;
  }
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
async function joinAllRooms() {
  for (const room of S.rooms) {
    await joinRoom(room);
  }
}

async function joinRoom(roomCode) {
  if (!S.name || !S.role) {
    console.warn('[joinRoom] Skipping — name or role not set yet');
    return;
  }
  const ref = db.ref(`carecall/rooms/${roomCode}/members/${S.uid}`);
  // When temp-carer is active, S.role is locally 'carer' for UI routing,
  // but the room entry must keep the real role ('family') to avoid identity confusion.
  const roomRole = _tempCarerActive && _realRole ? _realRole : S.role;
  const data = { name: S.name, role: roomRole, online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP };
  if (S.phone) data.phone = S.phone;
  if (S.avatar) data.avatar = S.avatar;
  if (S.role === 'carer') data.availability = _carerAvailability || 'available';
  // Use .update() not .set() — .set() replaces the entire entry, so if
  // any field is null (e.g. during boot before loadState completes), the
  // existing data is wiped. .update() only overwrites provided fields.
  await ref.update(data);
  ref.onDisconnect().update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
}

async function leaveRoom(roomCode) {
  await db.ref(`carecall/rooms/${roomCode}/members/${S.uid}`).remove();
}

// ── Bilateral connection helpers ──
async function syncUserProfile() {
  if (!S.uid || !S.name || !S.role || !S.personalCode) return;
  // Always persist the REAL role, not the temporary carer role.
  const profileRole = _tempCarerActive && _realRole ? _realRole : S.role;
  const profile = { personalCode: S.personalCode, name: S.name, role: profileRole, rooms: S.rooms };
  if (S.phone) profile.phone = S.phone;
  if (S.avatar) profile.avatar = S.avatar;
  if (S.emergencyNumber) profile.emergencyNumber = S.emergencyNumber;
  // Profile write — self-only under new rules, always allowed when auth
  // is live. Let a genuine auth failure propagate so callers see it.
  await db.ref(`carecall/users/${S.uid}`).update(profile);
  // codeIndex: use a transaction to atomically claim the code. A plain
  // .set() can silently overwrite another user's code when rules allow
  // (e.g. if the old entry was deleted). The transaction checks current
  // value: if null or already ours, claim it; otherwise abort and retry
  // with a fresh code.
  const _claimCode = async (code) => {
    const codeRef = db.ref(`carecall/codeIndex/${code}`);
    const { committed } = await codeRef.transaction(current => {
      if (current === null || current.uid === S.uid) {
        return { uid: S.uid, name: S.name, role: profileRole };
      }
      return undefined; // abort — owned by someone else
    });
    return committed;
  };
  let claimed = false;
  try { claimed = await _claimCode(S.personalCode); } catch(_) {}
  if (!claimed) {
    console.warn('[Profile] codeIndex collision for', S.personalCode, '— reissuing.');
    const oldCode = S.personalCode;
    for (let attempts = 0; attempts < 6; attempts++) {
      const fresh = genCode();
      try {
        const ok = await _claimCode(fresh);
        if (!ok) continue;
        S.personalCode = fresh;
        try { await db.ref(`carecall/users/${S.uid}/personalCode`).set(fresh); } catch(_) {}
        saveState();
        console.warn('[Profile] personalCode reissued:', oldCode, '→', fresh);
        setTimeout(() => {
          try { toast(t('Your pair code was refreshed:') + ' ' + fresh); } catch(_) {}
        }, 400);
        return;
      } catch(_) {}
    }
    throw new Error('Could not reserve a new pair code after 6 attempts');
  }
}

async function lookupUserByCode(code) {
  const snap = await db.ref(`carecall/codeIndex/${code}`).once('value');
  return snap.val(); // { uid, name, role } or null
}

async function findOrCreateRoom(myUid, theirUid) {
  // Check MY existing rooms for one that already contains the other user.
  // First pass: direct member lookup (fast, single-key read).
  // Second pass: read full members list as fallback in case the direct
  // key check missed it (e.g. member was written under a variant path).
  for (const roomId of S.rooms) {
    try {
      const snap = await db.ref(`carecall/rooms/${roomId}/members/${theirUid}`).once('value');
      if (snap.exists()) return roomId;
    } catch(_) { /* no longer a member — ignore */ }
  }
  // Second pass: read each room's full members map and check if theirUid
  // appears — this catches rooms where the first pass's single-key read
  // was denied but we can still read the members collection as a whole.
  for (const roomId of S.rooms) {
    try {
      const snap = await db.ref(`carecall/rooms/${roomId}/members`).once('value');
      const members = snap.val();
      if (members && members[theirUid]) return roomId;
    } catch(_) { /* permission denied — skip */ }
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

let _connectInProgress = false;
async function connectToCode(code) {
  if (_connectInProgress) return { error: t('Connection in progress…') };
  _connectInProgress = true;
  try { return await _connectToCodeInner(code); } finally { _connectInProgress = false; }
}
async function _connectToCodeInner(code) {
  // Guard: refuse to send a pair request if our identity isn't complete.
  // This catches cases where the user reached the code screen without
  // finishing registration (e.g. via "Sign in" → switch to Register tab).
  if (!S.name || !S.role || !S.uid) {
    return { error: t('Please complete registration first.') };
  }
  const user = await lookupUserByCode(code);
  if (!user) return { error: t('Code not found. Check and try again.') };
  if (user.uid === S.uid) return { error: t("That's your own code!") };
  // Validate role compatibility: patients pair with carers/family, carers/family pair with patients.
  const effectiveRole = _tempCarerActive && _realRole ? _realRole : S.role;
  const myConnectsTo = effectiveRole === 'patient' ? ['carer', 'family'] : ['patient'];
  if (!myConnectsTo.includes(user.role)) {
    return { error: t('That code belongs to a different role.') };
  }
  // Force-refresh S.rooms from Firebase to catch rooms added since boot.
  try {
    const freshSnap = await db.ref(`carecall/users/${S.uid}/rooms`).once('value');
    const fresh = freshSnap.val() || [];
    fresh.forEach(r => { if (r && !S.rooms.includes(r)) S.rooms.push(r); });
    _dedupRooms();
  } catch(_) {}
  // If already paired (shared room exists), short-circuit.
  for (const roomId of S.rooms) {
    try {
      const snap = await db.ref(`carecall/rooms/${roomId}/members/${user.uid}`).once('value');
      if (snap.exists()) return { ok: true, name: user.name, alreadyConnected: true };
    } catch(_) {}
  }
  // De-dupe: block if we already have ANY request to this person —
  // pending OR recently approved (within 5 min). Without the approved
  // check, re-entering the same code after the first request was
  // approved creates a second request → second room.
  const sentSnap = await db.ref(`carecall/users/${S.uid}/sentPairs`).once('value');
  const sent = sentSnap.val() || {};
  for (const reqId of Object.keys(sent)) {
    const r = sent[reqId];
    if (!r || r.toUid !== user.uid) continue;
    if (r.status === 'pending') {
      return { ok: true, name: user.name, pending: true };
    }
    if (r.status === 'approved') {
      return { ok: true, name: user.name, alreadyConnected: true };
    }
  }
  // Write the pair request to the target's pendingPairs + mirror in our
  // own sentPairs so we can track status and show a pending indicator.
  const reqRef = db.ref(`carecall/users/${user.uid}/pendingPairs`).push();
  const reqId = reqRef.key;
  const now = firebase.database.ServerValue.TIMESTAMP;
  // Use the REAL role for pairing, not the temp-carer role. If a family
  // member is in temp-carer mode, their pair request must still say
  // 'family' so the approval code triggers the family-joins-existing-rooms
  // path instead of creating a direct room.
  const pairingRole = _tempCarerActive && _realRole ? _realRole : S.role;
  const req = {
    fromUid:    S.uid,
    fromName:   S.name || '',
    fromRole:   pairingRole,
    fromAvatar: S.avatar || '',
    fromCode:   S.personalCode || '',
    fromRooms:  (pairingRole === 'patient' && S.rooms && S.rooms.length) ? S.rooms : null,
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
let _pendingPairsRef = null;
function _subscribePendingPairs() {
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

function _showPairRequestPrompt(reqId, req) {
  if (document.querySelector(`.pair-req-banner[data-req="${reqId}"]`)) return;
  // Auto-dismiss QR code display + scanner — the other person already
  // scanned, so the QR overlay is no longer needed.
  _dismissQrDisplay();
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

let _approveInProgress = new Set();
async function approvePairRequest(reqId) {
  // Guard against concurrent approvals of the same request (listener re-fire,
  // double-tap) which could create duplicate rooms for the same pair.
  if (_approveInProgress.has(reqId)) return;
  _approveInProgress.add(reqId);
  try { await _approvePairRequestInner(reqId); } finally { _approveInProgress.delete(reqId); }
}
async function _approvePairRequestInner(reqId) {
  const reqRef = db.ref(`carecall/users/${S.uid}/pendingPairs/${reqId}`);
  const snap = await reqRef.once('value');
  const req = snap.val();
  if (!req || req.status !== 'pending') return;
  // Guard: reject requests with incomplete identity data.
  if (!req.fromUid || !req.fromRole || !req.fromName) {
    console.warn('[Pairing] Rejecting incomplete pair request:', reqId, req);
    await reqRef.update({ status: 'rejected', decidedAt: firebase.database.ServerValue.TIMESTAMP }).catch(() => {});
    toast(t('Pair request was incomplete — ask them to try again.'));
    document.querySelector(`.pair-req-banner[data-req="${reqId}"]`)?.remove();
    return;
  }
  try {
    // 0a. Force-refresh S.rooms from Firebase so findOrCreateRoom sees the
    //     latest list — the rooms listener may not have fired yet, so S.rooms
    //     could be stale, causing a duplicate room to be created.
    try {
      const freshRoomsSnap = await db.ref(`carecall/users/${S.uid}/rooms`).once('value');
      const freshRooms = freshRoomsSnap.val() || [];
      freshRooms.forEach(r => { if (r && !S.rooms.includes(r)) S.rooms.push(r); });
      _dedupRooms();
    } catch(_) {}
    // 0b. Run pair dedup synchronously BEFORE creating/finding a room.
    //     This removes any duplicate rooms that were created by prior races
    //     so findOrCreateRoom won't miss them.
    await _deduplicateRoomsByPair();

    // ── Determine if this is a family↔patient pairing ──
    const isFamilyPatientPairing =
      (S.role === 'family' && req.fromRole === 'patient') ||
      (S.role === 'patient' && req.fromRole === 'family');
    const patientUid = S.role === 'patient' ? S.uid : req.fromUid;
    const familyUid  = S.role === 'family'  ? S.uid : req.fromUid;
    const familyName  = S.role === 'family' ? (S.name || '') : (req.fromName || '');
    const familyAvatar = S.role === 'family' ? (S.avatar || '') : (req.fromAvatar || '');
    const familyRole  = 'family';

    let roomId;
    const extraRoomIds = [];

    if (isFamilyPatientPairing) {
      // ── FAMILY↔PATIENT: add family to ALL existing patient rooms ──
      // Do NOT create a direct family-patient room. The family member
      // joins the patient's existing carer rooms as an observer.
      let patientRooms = [];
      if (patientUid === S.uid) {
        patientRooms = [...S.rooms];
      } else {
        try {
          const prSnap = await db.ref(`carecall/users/${patientUid}/rooms`).once('value');
          patientRooms = prSnap.val() || [];
        } catch(_) {
          if (req.fromRole === 'patient' && Array.isArray(req.fromRooms)) {
            patientRooms = req.fromRooms;
          }
        }
      }

      // Add family member to each patient room
      for (const pRoom of patientRooms) {
        try {
          await db.ref(`carecall/rooms/${pRoom}/members/${familyUid}`).update({
            name: familyName, role: familyRole, online: false,
            lastSeen: firebase.database.ServerValue.TIMESTAMP,
            avatar: familyAvatar,
          });
          extraRoomIds.push(pRoom);
          console.log('[Pairing] Added family to room', pRoom);
        } catch(e) { console.warn('[Pairing] Could not add family to room', pRoom, ':', e && e.message); }
      }

      // If family was added to at least one existing room, use the first
      // as the "primary" roomId. Otherwise fall back to creating a direct room.
      if (extraRoomIds.length) {
        roomId = extraRoomIds[0];
      } else {
        console.warn('[Pairing] No existing patient rooms found — creating direct room');
        roomId = await findOrCreateRoom(S.uid, req.fromUid);
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
      }

      // Add all rooms to my rooms list
      const allRooms = [roomId, ...extraRoomIds.filter(r => r !== roomId)];
      let changed = false;
      for (const r of allRooms) {
        if (!S.rooms.includes(r)) { S.rooms.push(r); changed = true; }
      }
      if (changed) {
        _dedupRooms();
        await _saveUserRooms(S.uid, S.rooms);
      }
    } else {
      // ── NORMAL PAIRING (carer↔patient): create/find a direct room ──
      roomId = await findOrCreateRoom(S.uid, req.fromUid);
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
      if (!S.rooms.includes(roomId)) {
        S.rooms.push(roomId);
        _dedupRooms();
        await _saveUserRooms(S.uid, S.rooms);
      }

      // ── Auto-add existing family members to the new carer-patient room ──
      // When the patient approves, scan other rooms for family members and
      // add them to the new room so they maintain full visibility.
      if (S.role === 'patient') {
        for (const existingRoom of S.rooms) {
          if (existingRoom === roomId) continue;
          try {
            const memberSnap = await db.ref(`carecall/rooms/${existingRoom}/members`).once('value');
            const members = memberSnap.val() || {};
            for (const [uid, m] of Object.entries(members)) {
              if (uid === S.uid || uid === req.fromUid) continue;
              if (m.role === 'family' || m.tempCarer) {
                try {
                  await db.ref(`carecall/rooms/${roomId}/members/${uid}`).update({
                    name: m.name || '', role: m.role || 'family', online: false,
                    lastSeen: firebase.database.ServerValue.TIMESTAMP,
                    avatar: m.avatar || '', phone: m.phone || '',
                    tempCarer: m.tempCarer || null,
                  });
                } catch(e) { console.warn('[Pairing] Could not auto-add family', uid, 'to new room:', e?.message); }
              }
            }
          } catch(_) {}
        }
      }
    }

    // 4. Mark the request approved.
    const allApprovedRooms = [roomId, ...extraRoomIds.filter(r => r !== roomId)];
    await reqRef.update({
      status: 'approved',
      roomId,
      extraRoomIds: extraRoomIds.length ? extraRoomIds : null,
      decidedAt: firebase.database.ServerValue.TIMESTAMP,
    });
    // 4b. Auto-approve any OTHER pending requests from the same fromUid.
    // If the sender tapped "connect" multiple times, each created a
    // separate pending request. Approve them all with the same roomId
    // so the sender's _onPairApproved doesn't create duplicate rooms.
    try {
      const allPendingSnap = await db.ref(`carecall/users/${S.uid}/pendingPairs`).once('value');
      const allPending = allPendingSnap.val() || {};
      for (const [otherReqId, otherReq] of Object.entries(allPending)) {
        if (otherReqId === reqId) continue;
        if (otherReq && otherReq.fromUid === req.fromUid && otherReq.status === 'pending') {
          console.log('[Pairing] Auto-approving duplicate request', otherReqId, 'from', req.fromUid);
          await db.ref(`carecall/users/${S.uid}/pendingPairs/${otherReqId}`).update({
            status: 'approved', roomId,
            extraRoomIds: extraRoomIds.length ? extraRoomIds : null,
            decidedAt: firebase.database.ServerValue.TIMESTAMP,
          });
        }
      }
    } catch(e) { console.warn('[Pairing] Auto-approve scan failed:', e?.message); }
    // 4c. Write the room to the REQUESTER's rooms list directly. The
    // requester's _onPairApproved listener should do this too, but if
    // they're offline or the listener hasn't fired, their rooms list
    // stays empty and they can't access the shared room on next boot.
    try {
      const theirRoomsSnap = await db.ref(`carecall/users/${req.fromUid}/rooms`).once('value');
      const theirRooms = theirRoomsSnap.val() || [];
      let theirChanged = false;
      for (const r of allApprovedRooms) {
        if (!theirRooms.includes(r)) { theirRooms.push(r); theirChanged = true; }
      }
      if (theirChanged) await db.ref(`carecall/users/${req.fromUid}/rooms`).set(theirRooms);
    } catch(e) {
      // Expected: Phase 0 rules block writing to another user's profile.
      // The requester's _onPairApproved listener will handle it instead.
      console.log('[Pairing] Could not write requester rooms (expected under Phase 0):', e?.message);
    }
    // 5. If I'm a carer, register my FCM token in the new room.
    if (S.role === 'carer') _ensureFcmTokenInRoom(roomId).catch(() => {});
    for (const r of allApprovedRooms) { await joinRoom(r); }
    saveState();
    const roleLabel = req.fromRole === 'patient' ? t('patient') : (req.fromRole === 'carer' ? t('carer') : t('family member'));
    _showPairingSuccessBanner(req.fromName || '', roleLabel);
    // Re-run startPatient/startCarer so member listeners attach to the
    // new room. The rooms-value listener won't trigger a restart on its
    // own because S.rooms was already mutated inline before _saveUserRooms
    // wrote to Firebase — by the time the listener fires and compares,
    // it sees no new rooms.
    if (S.role === 'patient') {
      startPatient();
      // Sync existing medications to the new room(s). The patient may
      // have entered meds before pairing — at that point S.rooms was
      // empty so _saveMedications had nowhere to mirror.
      if (typeof _saveMedications === 'function') _saveMedications();
    }
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

async function rejectPairRequest(reqId) {
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
function _showPairingSuccessBanner(name, roleLabel) {
  _dismissQrDisplay();
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
const _sentPairWatchers = {};
function _subscribeSentPair(reqId, theirUid) {
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

const _pairApprovedProcessed = new Set();
async function _onPairApproved(reqId, req) {
  // Guard against duplicate processing (listener re-fire can deliver
  // the same approved snapshot twice before ref.off() takes effect).
  if (_pairApprovedProcessed.has(reqId)) return;
  _pairApprovedProcessed.add(reqId);
  const roomId = req.roomId;
  if (!roomId) return;
  // Force-refresh S.rooms from Firebase before adding the new room, so we
  // don't end up with duplicates if the rooms listener hasn't fired yet.
  try {
    const freshRoomsSnap = await db.ref(`carecall/users/${S.uid}/rooms`).once('value');
    const freshRooms = freshRoomsSnap.val() || [];
    freshRooms.forEach(r => { if (r && !S.rooms.includes(r)) S.rooms.push(r); });
    _dedupRooms();
  } catch(_) {}
  // Collect all room IDs: primary + any extra rooms from family↔patient pairing
  const allRoomIds = [roomId];
  if (req.extraRoomIds && Array.isArray(req.extraRoomIds)) {
    req.extraRoomIds.forEach(r => { if (r && !allRoomIds.includes(r)) allRoomIds.push(r); });
  }
  let changed = false;
  for (const rid of allRoomIds) {
    if (!S.rooms.includes(rid)) {
      S.rooms.push(rid);
      changed = true;
    }
  }
  if (changed) {
    _dedupRooms();
    await _saveUserRooms(S.uid, S.rooms);
  }
  // Reflect outcome in own sentPairs (self-write).
  try { await db.ref(`carecall/users/${S.uid}/sentPairs/${reqId}`).update({ status: 'approved', roomId }); } catch(_) {}
  if (S.role === 'carer') _ensureFcmTokenInRoom(roomId).catch(() => {});
  for (const rid of allRoomIds) {
    try { await joinRoom(rid); } catch(e) { console.warn('[joinRoom] Failed for room', rid, ':', e && e.message); }
  }
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
  // ── Auto-add existing family members to the new carer-patient room ──
  // When the patient is the sender (carer approved), the patient's
  // _onPairApproved fires. Scan other rooms for family and add them.
  if (S.role === 'patient' && theirRole === 'carer') {
    for (const existingRoom of S.rooms) {
      if (existingRoom === roomId) continue;
      try {
        const memberSnap = await db.ref(`carecall/rooms/${existingRoom}/members`).once('value');
        const members = memberSnap.val() || {};
        for (const [uid, m] of Object.entries(members)) {
          if (uid === S.uid) continue;
          if (m.role === 'family' || m.tempCarer) {
            try {
              await db.ref(`carecall/rooms/${roomId}/members/${uid}`).update({
                name: m.name || '', role: m.role || 'family', online: false,
                lastSeen: firebase.database.ServerValue.TIMESTAMP,
                avatar: m.avatar || '', phone: m.phone || '',
                tempCarer: m.tempCarer || null,
              });
            } catch(e) { console.warn('[Pairing] Could not auto-add family', uid, 'to new room:', e?.message); }
          }
        }
      } catch(_) {}
    }
  }

  // Re-run listener setup for the same reason as in approvePairRequest:
  // S.rooms was mutated before the Firebase write, so the rooms-value
  // listener won't see a change and won't call startPatient/startCarer.
  if (S.role === 'patient') {
    startPatient();
    if (typeof _saveMedications === 'function') _saveMedications();
  }
  else if (S.role === 'carer') startCarer();
  else if (S.role === 'family') { _startFamilyListeners(); if (typeof refreshLog === 'function') refreshLog(); }
  setTimeout(() => { if (typeof refreshSettings === 'function') refreshSettings(); }, 600);
}

async function _onPairRejected(reqId, req) {
  try { await db.ref(`carecall/users/${S.uid}/sentPairs/${reqId}`).update({ status: 'rejected' }); } catch(_) {}
  toast(t('Pair request was rejected'));
}

// Re-subscribe to any pending sentPairs on boot so reopens of the app
// still pick up approval/rejection while the user was away.
async function _rehydrateSentPairs() {
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
async function _ensureFcmTokenInRoom(roomId) {
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

async function _saveUserRooms(uid, rooms) {
  await db.ref(`carecall/users/${uid}/rooms`).set(rooms);
}

// Ensure S.rooms has no duplicate entries. connectToCode and the
// launchMainScreen rooms listener both push independently and can
// race — Firebase fires the listener while the direct push is
// in-flight, yielding the same roomId twice, which then shows the
// same peer twice in the connections list.
function _dedupRooms() {
  if (!Array.isArray(S.rooms)) return;
  const seen = new Set();
  S.rooms = S.rooms.filter(r => {
    if (!r || seen.has(r)) return false;
    seen.add(r);
    return true;
  });
}

// Deduplicate rooms that connect the SAME pair of users. findOrCreateRoom
// can't read the other user's rooms list (Phase 0 rules), so retries or
// listener re-fires can create multiple rooms for one pair. This scans all
// rooms, groups by the "other" member's uid, keeps the earliest room for
// each pair, and prunes the rest from S.rooms + Firebase.
let _pairDedupRunning = false;
async function _deduplicateRoomsByPair() {
  if (_pairDedupRunning) return;
  _pairDedupRunning = true;
  try {
    const pairMap = {}; // memberKey -> [roomId, ...]
    for (const roomId of S.rooms) {
      try {
        const snap = await db.ref(`carecall/rooms/${roomId}/members`).once('value');
        const members = snap.val() || {};
        // Build a composite key from ALL other members (sorted) so rooms
        // with different member sets are never mistakenly treated as
        // duplicates. Previously only the first other member was used,
        // which could collapse rooms with different member sets.
        const otherUids = Object.keys(members).filter(uid => uid !== S.uid).sort();
        if (!otherUids.length) continue;
        const key = otherUids.join(',');
        if (!pairMap[key]) pairMap[key] = [];
        pairMap[key].push(roomId);
      } catch(_) { /* permission denied or room gone — skip */ }
    }
    const toRemove = [];
    for (const [, roomIds] of Object.entries(pairMap)) {
      if (roomIds.length <= 1) continue;
      // Keep the first room (oldest by array position), remove duplicates.
      for (let i = 1; i < roomIds.length; i++) {
        toRemove.push(roomIds[i]);
      }
    }
    if (toRemove.length) {
      console.log('[dedup] Removing', toRemove.length, 'duplicate pair room(s):', toRemove);
      S.rooms = S.rooms.filter(r => !toRemove.includes(r));
      _dedupRooms();
      await _saveUserRooms(S.uid, S.rooms);
      saveState();
      // Clean up member entries in removed rooms
      for (const roomId of toRemove) {
        try { await db.ref(`carecall/rooms/${roomId}/members/${S.uid}`).remove(); } catch(_) {}
        // Clean up presence cache if active
        if (PS._roomMembersCache) delete PS._roomMembersCache[roomId];
      }
    }
  } catch(e) {
    console.warn('[dedup] pair dedup error:', e && e.message);
  } finally {
    _pairDedupRunning = false;
  }
}

// Re-render just the "My connections" list, live. Triggered whenever
// S.rooms or any member snapshot updates, but only if the Settings
// screen is actually visible — so connecting a new patient while the
// carer sits on the Settings screen reflects immediately instead of
// requiring a close/reopen.
let _settingsRenderGen = 0;
async function _renderSettingsConnections() {
  const gen = ++_settingsRenderGen;
  const list = document.getElementById('rooms-list');
  if (!list) return;
  _dedupRooms();
  document.getElementById('s-connections-title').textContent =
    ({ patient: 'My Carers', carer: 'My Patients', family: 'My Patients' })[S.role] || 'My Connections';
  // Don't clear list.innerHTML here — defer until data is ready to avoid
  // a visible flicker when the async fetches below take a moment.
  const connections = [];
  const _roomsToClean = [];
  for (const roomId of S.rooms) {
    const snap = await db.ref(`carecall/rooms/${roomId}/members`).once('value');
    if (gen !== _settingsRenderGen) return; // a newer render started; bail
    const members = snap.val() || {};
    // In shared rooms (patient + carer + family), show ALL other members
    // as separate connection entries — not just the first one.
    const others = Object.entries(members).filter(([uid]) => uid !== S.uid);
    if (others.length) {
      for (const [uid, m] of others) {
        let theirCode = '';
        try {
          const userSnap = await db.ref(`carecall/users/${uid}/personalCode`).once('value');
          if (gen !== _settingsRenderGen) return;
          theirCode = userSnap.val() || '';
        } catch(e) {}
        connections.push({ roomId, uid, name: m.name, online: m.online, availability: m.availability, avatar: m.avatar || '', code: theirCode, phone: m.phone || null, role: m.role || null, tempCarer: m.tempCarer || false });
      }
    } else {
      _roomsToClean.push(roomId);
    }
  }
  // If a newer render was triggered during the async loop, abandon this
  // stale render entirely — otherwise both would write to the DOM and
  // cause duplicate entries.
  if (gen !== _settingsRenderGen) return;
  // Auto-prune orphaned rooms (where we're the only member left).
  if (_roomsToClean.length) {
    S.rooms = S.rooms.filter(r => !_roomsToClean.includes(r));
    _dedupRooms();
    _saveUserRooms(S.uid, S.rooms).catch(() => {});
    saveState();
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
  // Clear list only now (after async fetches complete) to prevent flicker.
  list.innerHTML = '';
  if (conns.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:18px 12px;color:#6889A5;font-size:0.85rem">' + t('No connections yet — enter a pair code below to connect.') + '</div>';
    return;
  }

  // Helper to render a single connection row
  function _renderConnRow(conn, { tierBadge, priorityBtns, tempTag, observerTag }) {
    const item = document.createElement('div');
    item.className = 'room-item';
    const avatarHtml = conn.avatar
      ? `<span style="font-size:1.3rem;line-height:1;flex-shrink:0;cursor:pointer" onclick="openProfileModal('${escHtml(conn.uid)}')">${escHtml(conn.avatar)}</span>`
      : `<div style="width:8px;height:8px;border-radius:50%;background:${conn.online ? 'var(--success)' : '#6889A5'};flex-shrink:0;cursor:pointer" onclick="openProfileModal('${escHtml(conn.uid)}')"></div>`;
    const codeHtml = conn.code
      ? `<span style="font-size:0.6rem;color:#6889A5;letter-spacing:1px;font-weight:600">${escHtml(conn.code)}</span>` : '';
    const noPhoneWarning = (isPatient && (conn.role === 'carer' || conn.tempCarer) && !conn.phone)
      ? `<div style="font-size:0.75rem;color:#d97706;margin-top:2px">⚠️ ${t('No phone — offline calls won\'t reach this carer')}</div>` : '';
    item.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer" onclick="openProfileModal('${escHtml(conn.uid)}')">
        ${avatarHtml}
        <div style="overflow:hidden">
          <div class="room-item-code" style="letter-spacing:0;font-family:'Outfit',sans-serif;font-size:0.95rem;overflow:hidden;text-overflow:ellipsis">${escHtml(conn.name)}${tempTag}${observerTag}</div>
          ${codeHtml}
          ${noPhoneWarning}
        </div>
        ${tierBadge}
      </div>
      <div style="display:flex;gap:4px;align-items:center">
        ${priorityBtns}
        <button class="room-remove-btn" onclick="removeConnection('${conn.roomId}')">Remove</button>
      </div>`;
    list.appendChild(item);
  }

  if (isPatient) {
    // Split connections into escalation group vs observer group
    const escalationMembers = conns.filter(c => c.role === 'carer' || (c.role === 'family' && c.tempCarer));
    const observerMembers = conns.filter(c => c.role === 'family' && !c.tempCarer);

    // Auto-initialize / sync the priority array from current escalation UIDs
    if (escalationMembers.length > 0) {
      let order = JSON.parse(localStorage.getItem('carecall_carer_priority') || '[]');
      const currentUids = escalationMembers.map(c => c.uid);
      // Add new UIDs not yet in order
      currentUids.forEach(uid => { if (!order.includes(uid)) order.push(uid); });
      // Remove UIDs no longer in the list
      order = order.filter(uid => currentUids.includes(uid));
      localStorage.setItem('carecall_carer_priority', JSON.stringify(order));

      _sortByCarerPriority(escalationMembers);
    }

    // Render escalation group with tier badges + priority buttons
    escalationMembers.forEach((conn, idx) => {
      const tierBadge = escalationMembers.length > 1
        ? `<span class="tier-badge">Tier ${idx + 1}</span>` : '';
      const priorityBtns = escalationMembers.length > 1
        ? `<div class="priority-btns">
             <button class="priority-btn" onclick="_moveCarerPriorityByUid('${conn.uid}', -1)" ${idx === 0 ? 'disabled' : ''}>▲</button>
             <button class="priority-btn" onclick="_moveCarerPriorityByUid('${conn.uid}', 1)" ${idx === escalationMembers.length - 1 ? 'disabled' : ''}>▼</button>
           </div>` : '';
      const tempTag = conn.tempCarer ? ` <span style="font-size:0.7rem;color:#6889A5">(${t('temp')})</span>` : '';
      _renderConnRow(conn, { tierBadge, priorityBtns, tempTag, observerTag: '' });
    });

    // Render observer group — no tier, no priority buttons
    observerMembers.forEach(conn => {
      const observerTag = ` <span style="font-size:0.7rem;color:#6889A5">(${t('Observer')})</span>`;
      _renderConnRow(conn, { tierBadge: '', priorityBtns: '', tempTag: '', observerTag });
    });
  } else {
    // Non-patient roles: show all connections without tier/priority
    conns.forEach(conn => {
      _renderConnRow(conn, { tierBadge: '', priorityBtns: '', tempTag: '', observerTag: '' });
    });
  }
}

function _refreshSettingsConnectionsIfVisible() {
  const s = document.getElementById('s-settings');
  if (s && s.classList.contains('active')) {
    _renderSettingsConnections();
  }
}

// ════════════════════════════════════════════════════════════
//  LAUNCH MAIN SCREEN
// ════════════════════════════════════════════════════════════
function launchMainScreen() {
  // Tear down all existing Firebase listeners before re-attaching to
  // prevent leaks across role switches and repeated launchMainScreen calls.
  _teardownAllListeners();

  // Subscribe to incoming pair requests (all roles — owner approval
  // is mandatory for new connections). Runs once per launch; the
  // function is idempotent and tears down any prior listener.
  _subscribePendingPairs();
  _rehydrateSentPairs();

  // Watch for new connections added by the other user in real time
  if (_roomsListenerRef) _roomsListenerRef.off();
  _roomsListenerRef = db.ref(`carecall/users/${S.uid}/rooms`);
  _roomsListenerRef.on('value', snap => {
    const fbRooms = snap.val() || [];
    let changed = false;
    // Add new rooms
    fbRooms.forEach(room => {
      if (room && !S.rooms.includes(room)) { S.rooms.push(room); changed = true; }
    });
    // Remove rooms no longer in Firebase (other user removed us)
    const removed = S.rooms.filter(r => !fbRooms.includes(r));
    if (removed.length) {
      S.rooms = S.rooms.filter(r => fbRooms.includes(r));
      changed = true;
      // Clean up presence cache & member listeners for removed rooms
      removed.forEach(r => {
        if (PS._roomMembersCache) delete PS._roomMembersCache[r];
      });
      if (PS._memberRefs) {
        PS._memberRefs = PS._memberRefs.filter(ref => {
          const path = ref.toString();
          const isRemoved = removed.some(r => path.includes(`/rooms/${r}/`));
          if (isRemoved) { try { ref.off(); } catch(_) {} }
          return !isRemoved;
        });
      }
      // Also clean up carer-side listeners for removed rooms
      if (CS._listenerRefs) {
        CS._listenerRefs = CS._listenerRefs.filter(ref => {
          const path = ref.toString();
          const isRemoved = removed.some(r => path.includes(`/rooms/${r}/`));
          if (isRemoved) { try { ref.off(); } catch(_) {} }
          return !isRemoved;
        });
      }
    }
    const before = S.rooms.length;
    _dedupRooms();
    if (S.rooms.length !== before) changed = true;
    if (changed) {
      if (!S.activeRoom || !S.rooms.includes(S.activeRoom)) S.activeRoom = S.rooms[0] || null;
      saveState();
      joinAllRooms().then(() => {
        _listenForVoiceCalls();
        _startCalendarListeners();
        if (S.role === 'patient') startPatient();
        else if (S.role === 'carer') startCarer();
        else if (S.role === 'family') { _startFamilyListeners(); refreshLog(); }
        // After listeners restart, run pair dedup in the background
        _deduplicateRoomsByPair().catch(() => {});
      });
      // Reflect the new connection immediately in an open Settings screen
      _refreshSettingsConnectionsIfVisible();
    }
  });

  // Start listening for incoming voice calls (both roles)
  _listenForVoiceCalls();

  // Restore temp-carer state from localStorage before routing —
  // this mutates S.role from 'family' to 'carer' if the user had
  // the toggle on in a previous session.
  _restoreTempCarerOnBoot();
  _showTempCarerToggleIfFamily();

  // Update greeting headers immediately for all roles so the name
  // is always visible as soon as the main screen appears.
  _updateGreetingHeaders();

  if (S.role === 'patient') {
    document.getElementById('p-room-label').textContent = t('My Carers');
    showScreen('s-patient');
    startPatient();
  } else if (S.role === 'family') {
    // Family members go straight to the log/dashboard as their main screen
    // Update the log topbar header to "Family Dashboard"
    const logLogo = document.querySelector('#s-log .topbar-logo');
    if (logLogo) { logLogo.innerHTML = 'Family <em style="color:#C084FC;font-style:italic">' + t('Dashboard') + '</em>'; }
    showScreen('s-log');
    refreshLog();
    // Set up real-time listeners so the log auto-updates
    _startFamilyListeners();
  } else if (S.role === 'carer') {
    document.getElementById('c-room-label').textContent = t('My Patients');
    showScreen('s-carer');
    startCarer();
    // If this is a temp-carer (family acting as carer), set up push too
    if (_tempCarerActive) setupCarerPush();
  } else {
    // Unknown/missing role — never silently land on a role screen.
    console.warn('[launchMainScreen] unknown role, routing to welcome:', S.role);
    showScreen('s-welcome');
  }

  // ── Start calendar listeners for all roles ──
  _startCalendarListeners();

  // ── Presence heartbeat: periodically update online/lastSeen ──
  // Writes every 30 ticks (30 seconds) so staleness can be detected
  // within the 90-second threshold used by _isPresenceStale().
  _registerTick('presenceHeartbeat', () => {
    if (!S.uid || !S.rooms.length) return;
    if (!window._presenceTickCount) window._presenceTickCount = 0;
    if (++window._presenceTickCount % 30 !== 0) return;
    for (const room of S.rooms) {
      db.ref(`carecall/rooms/${room}/members/${S.uid}`).update({
        online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP
      }).catch(() => {});
    }
  });

  // Show persistent banner if the user is on an anonymous session
  _showAnonAuthBannerIfNeeded();

  // Update greeting when time of day changes (every 60 ticks = 1 minute)
  _registerTick('greetingUpdate', () => {
    if (!window._greetingTickCount) window._greetingTickCount = 0;
    if (++window._greetingTickCount % 60 !== 0) return;
    _updateGreetingHeaders();
  });
}

function _showAnonAuthBannerIfNeeded() {
  // Remove any existing banner first
  const existing = document.getElementById('anon-auth-banner');
  if (existing) existing.remove();
  try {
    if (!auth.currentUser || !auth.currentUser.isAnonymous) return;
  } catch(e) { return; }
  const banner = document.createElement('div');
  banner.id = 'anon-auth-banner';
  banner.style.cssText = 'background:#FEF3C7;color:#92400E;padding:10px 16px;text-align:center;cursor:pointer;font-size:14px;font-weight:500;border-bottom:1px solid #F59E0B;position:relative;z-index:100;';
  banner.textContent = t('Your account is not yet secured — tap to register with email.');
  banner.onclick = function() { _authSwitchTab('register'); showScreen('s-auth'); };
  // Insert at the top of the currently visible main screen
  const screenId = S.role === 'patient' ? 's-patient' : S.role === 'carer' ? 's-carer' : S.role === 'family' ? 's-log' : null;
  if (!screenId) return;
  const screen = document.getElementById(screenId);
  if (screen && screen.firstChild) screen.insertBefore(banner, screen.firstChild);
  else if (screen) screen.appendChild(banner);
}

// ════════════════════════════════════════════════════════════
//  PATIENT LOGIC
// ════════════════════════════════════════════════════════════
async function startPatient() {
  setPatientStatus('connecting');

  // Prune duplicate rooms before attaching listeners.
  // Must await so that S.rooms is stable before we set up member listeners.
  await _deduplicateRoomsByPair();

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
  // Single source of truth for medications: rooms/{id}/medConfig (listener below).
  // Single source of truth for check-in settings: rooms/{id}/patientSettings/checkin (listener below).
  // Legacy users/{uid}/medications and users/{uid}/checkinSettings listeners removed.

  // ── Listen for carer-configured patient settings on each room ──
  // Clean up old room-settings listeners first
  if (PS._roomSettingsRefs) PS._roomSettingsRefs.forEach(ref => ref.off());
  PS._roomSettingsRefs = [];
  S.rooms.forEach(roomCode => {
    const ref = db.ref(`carecall/rooms/${roomCode}/patientSettings`);
    ref.on('value', snap => {
      const cfg = snap.val();
      if (!cfg) return;
      // Apply check-in settings from carer
      if (cfg.checkin) {
        CHECKIN.intervalMs = cfg.checkin.interval || 0;
        CHECKIN.startHour  = cfg.checkin.startHour ?? 8;
        CHECKIN.endHour    = cfg.checkin.endHour ?? 22;
        CHECKIN.timeoutMs  = cfg.checkin.timeout || 300000;
        _saveCheckinSettings();
        if (CHECKIN.intervalMs) startCheckinSchedule(); else stopCheckinSchedule();
        _refreshCheckinSettingsUI();
      }
      // Apply DMS (inactivity) threshold
      if (cfg.dms !== undefined) {
        _dmsThreshold = cfg.dms || 0;
        localStorage.setItem('carecall_dms', _dmsThreshold);
        _startDmsMonitor();
        const dmsBtn = document.getElementById('dms-threshold-btn');
        if (dmsBtn) dmsBtn.textContent = DMS_LABELS[DMS_THRESHOLDS.indexOf(_dmsThreshold)] || 'Off';
      }
      // Apply location sharing toggle
      if (cfg.locationSharing !== undefined) {
        _locationSharing = !!cfg.locationSharing;
        localStorage.setItem('carecall_location', _locationSharing ? '1' : '');
        const locBtn = document.getElementById('s-location-btn');
        if (locBtn) locBtn.textContent = _locationSharing ? 'On' : 'Off';
      }
      // Apply safe zone monitoring toggle
      if (cfg.safeZoneMonitoring !== undefined) {
        const enable = !!cfg.safeZoneMonitoring;
        if (!enable) {
          _stopGeoFenceWatch();
        } else if (_safeZones && _safeZones.some(z => z.enabled)) {
          _startGeoFenceWatch();
        }
      }
      // Apply safe zones from carer
      if (cfg.safeZones && Array.isArray(cfg.safeZones)) {
        _safeZones = cfg.safeZones.map(_migrateZone).filter(Boolean);
        // Ensure at most one home flag
        let _hSeen = false;
        _safeZones.forEach(z => { if (z.isHome) { if (_hSeen) z.isHome = false; else _hSeen = true; } });
        if (!_hSeen && _safeZones.length) _safeZones[0].isHome = true;
        localStorage.setItem('carecall_safezones', JSON.stringify(_safeZones));
        _geoFence = _safeZones.find(z => z.isHome) || null;
        if (_geoFence) localStorage.setItem('carecall_geofence', JSON.stringify(_geoFence));
        if (_safeZones.some(z => z.enabled)) _startGeoFenceWatch();
        _refreshPatientZonePill();
      }
      // Apply remote emergency info
      if (cfg.emergencyInfo) {
        _saveEmergencyInfo(cfg.emergencyInfo);
      }
    });
    PS._roomSettingsRefs.push(ref);

    // Listen for carer-written medication config on each room
    const medRef = db.ref(`carecall/rooms/${roomCode}/medConfig`);
    medRef.on('value', snap => {
      const meds = snap.val();
      if (meds && Array.isArray(meds)) {
        _medications = _normalizeMeds(meds);
        localStorage.setItem('carecall_meds', JSON.stringify(_medications));
        _scheduleAllMedNotifications();
      }
    });
    PS._roomSettingsRefs.push(medRef);
  });

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

  // ── Update greeting, photo, carers list ──
  _updateGreetingHeaders();
  _updateSettingsPhotoThumb();
  if (S.uid && db) {
    db.ref(`carecall/users/${S.uid}/photo`).once('value', snap => {
      const photo = snap.val();
      if (photo) { S._photoUrl = photo; localStorage.setItem('carecall_photo', photo); _updateGreetingHeaders(); }
    });
  }
  _watchMemberPhotos();
  _registerTick('statusCards', updateStatusCards);

  // ── Start health vitals listeners for status card ──
  if (_hasTierFeature('health_tracking')) {
    _startHealthListeners();
  }

  // ── First-run guidance card ──
  _showFirstRunGuide();
}

function _showFirstRunGuide() {
  if (localStorage.getItem('carecall_first_run_seen')) return;
  const guide = document.createElement('div');
  guide.id = 'first-run-guide';
  guide.style.cssText = 'position:fixed;inset:0;z-index:50;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:20px';
  guide.innerHTML = `
    <div style="background:#fff;border-radius:20px;padding:24px;max-width:320px;text-align:center;color:#1a1a1a">
      <div style="font-size:2.5rem;margin-bottom:12px">🔔</div>
      <div style="font-family:'Fraunces',serif;font-size:1.2rem;font-weight:700;margin-bottom:8px">${t('Welcome to CareCall')}</div>
      <div style="font-size:0.9rem;line-height:1.5;color:#555;margin-bottom:16px">${t('Tap the big button to call your carer. Select what you need first (water, food, pain, etc.) for a faster response.')}</div>
      <div style="font-size:0.85rem;color:#888;margin-bottom:16px">${t('The red SOS button is for emergencies — hold it for 3 seconds.')}</div>
      <button onclick="document.getElementById('first-run-guide').remove();localStorage.setItem('carecall_first_run_seen','1')" style="background:var(--patient-primary);color:#fff;border:none;border-radius:14px;padding:14px 32px;font-size:1rem;font-weight:700;font-family:'Outfit',sans-serif;cursor:pointer">${t('Got it!')}</button>
    </div>`;
  document.body.appendChild(guide);
}

let _rebuildCarerTimer = null;
function _rebuildPatientCarerList() {
  if (_rebuildCarerTimer) return;
  _rebuildCarerTimer = setTimeout(() => { _rebuildCarerTimer = null; _rebuildPatientCarerListNow(); }, 300);
}
function _isPresenceStale(m) {
  if (!m.online) return false;
  if (!m.lastSeen) return false;
  // When WE are offline, our clock keeps ticking but their lastSeen is
  // frozen at the last sync. Don't mark them stale — show last known state.
  if (!_appOnline) return false;
  return (Date.now() - m.lastSeen) > 90000;
}

function _rebuildPatientCarerListNow() {
  // Aggregate carers across all rooms, dedup by uid (prefer online entry)
  const carerMap = {};
  Object.entries(PS._roomMembersCache || {}).forEach(([roomCode, members]) => {
    Object.entries(members).forEach(([uid, m]) => {
      if (m.role === 'carer' || (m.role === 'family' && m.tempCarer)) {
        const stale = _isPresenceStale(m);
        const effectiveOnline = m.online && !stale;
        if (!carerMap[uid] || (effectiveOnline && !carerMap[uid].online)) {
          carerMap[uid] = { uid, name: m.name, online: effectiveOnline, stale: stale, lastSeen: m.lastSeen || null, room: roomCode, phone: m.phone || null, availability: m.availability || 'available', tempCarer: m.tempCarer || false };
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
  carers.forEach(c => { dropdownMembers[c.uid] = { name: c.name, online: c.online, stale: c.stale || false, lastSeen: c.lastSeen || null, role: 'carer', _room: c.room, availability: c.availability || 'available' }; });
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
      pill.className = 'conn-pill online'; txt.textContent = '✓ ' + t('Carer online');
    } else {
      pill.className = 'conn-pill online'; txt.textContent = '📡 ' + t('Carer notified by push');
    }
  }

  // Warn if any connected carer lacks a phone number
  let noPhoneBanner = document.getElementById('no-phone-warning');
  const carersWithoutPhone = carers.filter(c => !c.phone);
  if (carersWithoutPhone.length > 0) {
    if (!noPhoneBanner) {
      noPhoneBanner = document.createElement('div');
      noPhoneBanner.id = 'no-phone-warning';
      noPhoneBanner.style.cssText = 'text-align:center;font-size:0.8rem;color:#d97706;padding:4px 12px;margin-top:4px';
      const patientScreen = document.getElementById('s-patient');
      if (patientScreen) {
        const pill = document.getElementById('p-conn-pill');
        if (pill && pill.parentNode) pill.parentNode.insertBefore(noPhoneBanner, pill.nextSibling);
      }
    }
    if (noPhoneBanner) noPhoneBanner.textContent = t('Some carers don\'t have phone numbers set — offline fallback may not work.');
  } else if (noPhoneBanner) {
    noPhoneBanner.remove();
  }

  // Show/hide "no carer connected" empty state
  const emptyState = document.getElementById('patient-no-carer');
  if (emptyState) {
    if (carers.length === 0) {
      emptyState.style.display = '';
      emptyState.querySelector('.pnc-code').textContent = S.personalCode || '';
    } else {
      emptyState.style.display = 'none';
    }
  }

  // Update the carers list UI
  renderCarersList();
}

function setPatientStatus(status) {
  const btn  = document.getElementById('main-call-btn');
  const icon = document.getElementById('mcb-icon');
  const lbl  = document.getElementById('mcb-label');
  const pill = document.getElementById('p-conn-pill');
  const txt  = document.getElementById('p-conn-txt');

  btn.className = 'main-call-btn';
  pill.className = 'conn-pill';

  const fallback = document.getElementById('offline-fallback');

  const offlineMsg = document.getElementById('offline-call-msg');
  if (status === 'connecting') {
    btn.classList.add('offline'); icon.textContent='📵'; lbl.textContent=t('No Connection');
    pill.classList.add('offline'); txt.textContent='⏳ ' + t('Connecting…');
    _renderOfflineFallback(fallback);
    if (offlineMsg) offlineMsg.classList.add('show');
    // Override the onclick when offline to show explicit warning
    btn.onclick = () => {
      if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
      _showOfflineCallWarning();
    };
  }
  if (status === 'ready') {
    icon.textContent='🆘'; lbl.textContent=t('Call for Help');
    pill.classList.add('online'); txt.textContent=t('Ready to request help');
    fallback.classList.remove('show');
    if (offlineMsg) offlineMsg.classList.remove('show');
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

function selectNeed(btn) {
  const type = btn.dataset.type;
  if (PS.selectedNeeds.has(type)) {
    PS.selectedNeeds.delete(type);
    btn.classList.remove('selected');
    btn.setAttribute('aria-pressed', 'false');
  } else {
    PS.selectedNeeds.add(type);
    btn.classList.add('selected');
    btn.setAttribute('aria-pressed', 'true');
  }
  const customRow = document.getElementById('custom-input-row');
  if (PS.selectedNeeds.has('custom')) {
    customRow.classList.add('show');
    document.getElementById('custom-msg').focus();
  } else {
    customRow.classList.remove('show');
  }
  _updateNeedsIndicator();
}

const _needLabels = {
  water:'💧 Water', medication:'💊 Meds', food:'🍽️ Food',
  toilet:'🚽 Toilet', pain:'😣 Pain', custom:'✏️ Message',
};
function _updateNeedsIndicator() {
  const el = document.getElementById('needs-selected');
  const trigger = document.getElementById('needs-trigger');
  if (!el) return;
  if (!PS.selectedNeeds || !PS.selectedNeeds.size) {
    el.style.display = 'none';
    if (trigger) trigger.innerHTML = '<span class="needs-trigger-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span> ' + t('What do you need?');
    return;
  }
  const tags = [...PS.selectedNeeds].map(t => _needLabels[t] || t);
  el.innerHTML = tags.map(t => '<span class="needs-selected-tag">' + t + '</span>').join('');
  el.style.display = 'flex';
  if (trigger) trigger.innerHTML = '<span class="needs-trigger-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span> ' + tags.join(' · ');
}

function openNeedsSheet() {
  const sheet = document.getElementById('needs-sheet');
  if (sheet) {
    sheet.classList.add('open');
    sheet.addEventListener('click', _needsSheetBackdrop);
    sheet.querySelector('.sheet-close')?.focus();
  }
}
function closeNeedsSheet() {
  const sheet = document.getElementById('needs-sheet');
  if (sheet) {
    sheet.classList.remove('open');
    sheet.removeEventListener('click', _needsSheetBackdrop);
    document.getElementById('needs-trigger')?.focus();
  }
  _updateNeedsIndicator();
}
function _needsSheetBackdrop(e) {
  if (e.target.classList.contains('needs-sheet')) closeNeedsSheet();
}

// ── Carer selection from dropdown (patient screen) ──
function _selectCarer(uid, room) {
  PS.selectedCarerUid = uid;
  PS.selectedCarerRoom = room;
  // Close dropdown
  document.getElementById('p-room-dropdown').classList.remove('show');
  // Rebuild to update UI
  _rebuildPatientCarerList();
}

// ── Offline fallback: cellular call/text ──
function _showOfflineCallWarning() {
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

function _renderOfflineFallback(container) {
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
function toggleRoomDropdown(prefix) {
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

function renderRoomDropdown(prefix, members) {
  const dd = document.getElementById(prefix + '-room-dropdown');
  if (!dd) return;
  dd.innerHTML = '';
  let entries = Object.entries(members);
  // Patient side: show carers + temp-carers (family members stepping in)
  if (prefix === 'p') entries = entries.filter(([, m]) => m.role === 'carer' || (m.role === 'family' && m.tempCarer));
  if (!entries.length) {
    dd.innerHTML = '<div class="rbd-item" style="color:#999">' + t('No connections yet — add a patient or carer in Settings') + '</div>';
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

const ESCALATION_DELAY_MS = 120000; // 2 minutes between tiers

// Widget SOS: fired by the home-screen widget via carecall://sos deep link.
// Waits for boot to finish (S.role populated), then fires patientCallMain
// as if the patient tapped the big call button. On non-patient roles it's
// a no-op (the widget should only be placed on a patient's phone).
function _widgetSosTrigger() {
  function attempt() {
    if (!S.role) { setTimeout(attempt, 500); return; }
    if (S.role !== 'patient') { console.warn('[Widget] SOS ignored — role is', S.role); return; }
    if (typeof patientCallMain === 'function') patientCallMain();
  }
  attempt();
}

async function patientCallMain() {
  if (PS.status === 'connecting' || PS.status === 'calling' || PS.status === 'acked') return;
  // Block calls when auth session has expired
  if (!auth.currentUser) {
    toast(t('Session expired — please sign in'));
    _showSessionExpiredOverlay();
    return;
  }
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
      // Broadcast a log-only copy to rooms not directly called (e.g.
      // family rooms) so observers see the event in their call log.
      _broadcastCallToObserverRooms(callData, roomsToCall);
      watchForAck();
      _setCallFinalTimeout();
    } else {
      // ── BROADCAST: Send to ALL available carers simultaneously ──
      // Every available carer should be notified at once so no one is
      // missed. Escalation (tier-by-tier) was previously used here, but
      // it would only notify one carer at a time, causing the call to
      // route to a single carer instead of all of them.
      const sortedCarers = _getCarersByPriority();
      if (!sortedCarers.length) {
        toast(t('No available carers'));
        setPatientStatus('ready');
        return;
      }
      // Collect unique rooms for all available carers
      const roomsToCall = [...new Set(sortedCarers.map(c => c.room).filter(Boolean))];
      let firstCallId = null, firstCallRoom = null;
      for (const room of roomsToCall) {
        const callRef = db.ref(`carecall/rooms/${room}/calls`).push();
        await callRef.set({ ...callData, id: callRef.key });
        if (!firstCallId) { firstCallId = callRef.key; firstCallRoom = room; }
      }
      PS.activeCallId = firstCallId;
      PS._activeCallRoom = firstCallRoom;
      // Broadcast to observer rooms (family members)
      _broadcastCallToObserverRooms(callData, roomsToCall);
      watchForAck();
      _setCallFinalTimeout();
    }
  } catch(e) {
    console.error('[Call] Failed:', e);
    _showOfflineCallWarning();
    setPatientStatus('ready');
  }
}

// Shared helper: sort an array of objects (each having a .uid) by the
// user's stored carer-priority order, preserving original order for
// entries not in the priority list.
function _sortByCarerPriority(arr) {
  const priorityOrder = JSON.parse(localStorage.getItem('carecall_carer_priority') || '[]');
  arr.sort((a, b) => {
    // Real carers always come before temp-carers (family stepping in).
    // Temp-carers are identified by the tempCarer flag in their room member entry.
    const aTemp = a.tempCarer ? 1 : 0;
    const bTemp = b.tempCarer ? 1 : 0;
    if (aTemp !== bTemp) return aTemp - bTemp;
    // Within the same tier (both real or both temp), use priority order
    const ai = priorityOrder.indexOf(a.uid);
    const bi = priorityOrder.indexOf(b.uid);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return 0;
  });
  return arr;
}

function _getCarersByPriority() {
  // Include all carers except those explicitly off-duty. Previously this
  // used a strict === 'available' check which excluded 'busy' carers and
  // any carer whose availability field was unset (despite the default).
  const carers = (PS.allCarers || []).filter(c => c.availability !== 'off-duty');
  _sortByCarerPriority(carers);
  return carers;
}

async function _sendToEscalationTier(tierIndex) {
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
      toast(t('No response yet — try calling again') + ' (' + carer.name + ' → ' + carers[nextTier].name + ')');
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

// Broadcast a log-only copy of the call to rooms that weren't directly
// called. With the family-joins-existing-rooms architecture, family members
// are already in the carer's rooms and see calls automatically. This is
// kept as a no-op stub for backward compatibility (callers still invoke it).
function _broadcastCallToObserverRooms(_callData, _alreadyCalledRooms) {
  // No-op: family members now share the patient↔carer rooms directly.
}

function _clearEscalation() {
  clearTimeout(PS._escalationTimer);
  PS._escalationCarers = null;
  PS._escalationIndex = 0;
  PS._escalationCallData = null;
}

// ── Emergency number auto-detection and last-resort prompt ──
function _getDefaultEmergencyNumber() {
  const lang = (navigator.language || 'en').toLowerCase();
  if (lang.startsWith('he')) return '101';
  if (lang === 'en-us') return '911';
  return '112';
}

function _getEmergencyNumberForUser() {
  return S.emergencyNumber || _getDefaultEmergencyNumber();
}

function _showEmergencyCallPrompt() {
  const number = _getEmergencyNumberForUser();
  const overlay = document.createElement('div');
  overlay.id = 'emergency-call-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:40;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px;padding:28px 20px;max-width:320px;width:100%;text-align:center">
      <div style="font-size:2.5rem;margin-bottom:8px">🚨</div>
      <div style="font-family:'Fraunces',serif;font-size:1.3rem;font-weight:700;color:var(--danger,#dc2626);margin-bottom:6px">${t('No carer responded')}</div>
      <div style="font-size:0.95rem;color:#666;margin-bottom:16px">${t('Call emergency services?')}</div>
      <a href="tel:${escHtml(number)}" style="display:block;background:#dc2626;color:#fff;border:none;border-radius:14px;padding:18px;font-size:1.2rem;font-weight:700;font-family:'Outfit',sans-serif;text-decoration:none;text-align:center">🚑 ${t('Call')} ${escHtml(number)}</a>
      <button onclick="this.closest('div[style*=fixed]').remove()" style="margin-top:12px;background:rgba(0,0,0,0.06);border:none;border-radius:12px;padding:12px 24px;color:#666;font-size:0.9rem;font-weight:600;font-family:'Outfit',sans-serif;cursor:pointer;width:100%">${t('Dismiss')}</button>
    </div>`;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

function editEmergencyNumber() {
  const current = S.emergencyNumber || _getDefaultEmergencyNumber();
  const num = prompt(t('Emergency number:'), current);
  if (num === null) return;
  S.emergencyNumber = num.trim() || null;
  saveState();
  if (S.uid) {
    db.ref(`carecall/users/${S.uid}/emergencyNumber`).set(S.emergencyNumber || null);
  }
  refreshSettings();
  toast(t('Emergency number updated'));
}

function _setCallFinalTimeout() {
  PS._callTimeout = setTimeout(() => {
    if (PS.status === 'calling') {
      setPatientStatus('ready');
      PS.activeCallId = null;
      if (PS.callListener) { PS.callListener(); PS.callListener = null; }
      _showNoResponseFallback();
    }
  }, CALL_FINAL_TIMEOUT_MS);
}

// When no carer responds: show tel/sms links to all carers PLUS
// emergency services as a last resort — all in one overlay.
function _showNoResponseFallback() {
  const carers = PS.allCarers || JSON.parse(localStorage.getItem('carecall_carers_cache') || '[]');
  const emergNum = _getEmergencyNumberForUser();
  document.getElementById('emergency-call-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'emergency-call-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:40;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto';

  let phoneHtml = '';
  const phonedCarers = carers.filter(c => c.phone);
  if (phonedCarers.length) {
    phoneHtml = `<div style="font-size:0.85rem;color:#666;margin-bottom:8px;font-weight:600">${t('Try calling directly:')}</div>`;
    phonedCarers.forEach(c => {
      const tel = c.phone.replace(/[\s()\-]/g, '');
      phoneHtml += `
        <div style="display:flex;gap:8px;margin-bottom:6px">
          <a href="tel:${escHtml(tel)}" style="flex:1;background:#0EA5E9;color:#fff;border:none;border-radius:12px;padding:14px;font-size:0.95rem;font-weight:600;text-decoration:none;text-align:center">📞 ${escHtml(c.name)}</a>
          <a href="sms:${escHtml(tel)}" style="background:rgba(14,165,233,0.15);color:#0EA5E9;border:none;border-radius:12px;padding:14px 16px;font-size:0.95rem;font-weight:600;text-decoration:none">💬</a>
        </div>`;
    });
  } else {
    phoneHtml = `<div style="font-size:0.85rem;color:#999;margin-bottom:8px">${t('No phone numbers available')}</div>`;
  }

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px;padding:24px 20px;max-width:340px;width:100%;text-align:center">
      <div style="font-size:2rem;margin-bottom:6px">⚠️</div>
      <div style="font-family:'Fraunces',serif;font-size:1.2rem;font-weight:700;color:#1a1a1a;margin-bottom:4px">${t('No carer responded')}</div>
      <div style="font-size:0.85rem;color:#888;margin-bottom:14px">${t('Try reaching them by phone, or call emergency services.')}</div>
      ${phoneHtml}
      <div style="border-top:1px solid #eee;margin:14px 0;padding-top:14px">
        <a href="tel:${escHtml(emergNum)}" style="display:block;background:#dc2626;color:#fff;border:none;border-radius:14px;padding:16px;font-size:1.1rem;font-weight:700;font-family:'Outfit',sans-serif;text-decoration:none;text-align:center">🚑 ${t('Call Emergency')} ${escHtml(emergNum)}</a>
      </div>
      <button onclick="this.closest('div[style*=fixed]').remove()" style="margin-top:10px;background:rgba(0,0,0,0.06);border:none;border-radius:12px;padding:12px 24px;color:#666;font-size:0.9rem;font-weight:600;font-family:'Outfit',sans-serif;cursor:pointer;width:100%">${t('Dismiss')}</button>
    </div>`;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

function watchForAck() {
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

function showPatientAck(call) {
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

function dismissAckOverlay() {
  clearTimeout(PS._ackDismissTimer);
  document.getElementById('ack-overlay').classList.remove('show');
  PS.activeCallId = null; PS._activeCallRoom = null;
  PS.selectedNeeds = new Set();
  document.querySelectorAll('.need-row,.need-pill,.need-btn').forEach(b=>b.classList.remove('selected'));
  _updateNeedsIndicator();
  document.getElementById('custom-input-row').classList.remove('show');
  document.getElementById('custom-msg').value = '';
  setPatientStatus('ready');
}

// ════════════════════════════════════════════════════════════
//  FAMILY LOGIC — real-time log updates
// ════════════════════════════════════════════════════════════

// Shared helper: for a family user, returns the list of rooms to query.
// With the family-joins-existing-rooms architecture, family members are
// already added to all patient↔carer rooms at pairing time, so this
// simply returns a copy of S.rooms.
async function _expandFamilyRooms() {
  return [...S.rooms];
}

let _familyListenerRefs = [];
let _familyRefreshTimer = null;
async function _startFamilyListeners() {
  // Clean up old listeners
  _familyListenerRefs.forEach(ref => ref.off());
  _familyListenerRefs = [];

  // Debounced refresh — avoids hammering Firebase when multiple events fire
  function _debouncedRefresh() {
    clearTimeout(_familyRefreshTimer);
    _familyRefreshTimer = setTimeout(() => refreshLog(), 500);
  }

  // Family members are now added to all patient↔carer rooms at pairing
  // time, so S.rooms already contains every room we need to listen to.
  S.rooms.forEach(roomId => {
    const ref = db.ref(`carecall/rooms/${roomId}/calls`).orderByChild('timestamp').limitToLast(50);
    ref.on('child_added', _debouncedRefresh);
    ref.on('child_changed', _debouncedRefresh);
    _familyListenerRefs.push(ref);

    // Listen for medication config changes so family can see patient meds
    const medRef = db.ref(`carecall/rooms/${roomId}/medConfig`);
    medRef.on('value', _debouncedRefresh);
    _familyListenerRefs.push(medRef);

    // Listen for patient settings so family can see them
    const settingsRef = db.ref(`carecall/rooms/${roomId}/patientSettings`);
    settingsRef.on('value', _debouncedRefresh);
    _familyListenerRefs.push(settingsRef);
  });
}

// ════════════════════════════════════════════════════════════
//  TEMP CARER TOGGLE — lets family members temporarily act as carers
// ════════════════════════════════════════════════════════════
function toggleTempCarer() {
  if (!_tempCarerActive && !_requireTier('temp_carer', 'plus')) return;
  if (_tempCarerActive) {
    _deactivateTempCarer();
  } else {
    _activateTempCarer();
  }
}

async function _activateTempCarer() {
  _tempCarerActive = true;
  _realRole = S.role; // preserve permanent role
  localStorage.setItem('carecall_temp_carer', '1');
  // Flag-only: set tempCarer flag but keep role as 'family' in the room.
  // S.role is set to 'carer' locally for UI routing, but the room entry stays 'family'.
  for (const room of S.rooms) {
    try {
      await db.ref(`carecall/rooms/${room}/members/${S.uid}`).update({ tempCarer: true });
    } catch(e) { console.warn('[TempCarer] flag update failed for room', room, e && e.message); }
  }
  // Set up carer functionality
  S.role = 'carer'; // temporarily
  showScreen('s-carer');
  startCarer();
  setupCarerPush();
  _updateTempCarerUI(true);
  toast(t('You are now acting as a temporary carer'));
}

async function _deactivateTempCarer() {
  _tempCarerActive = false;
  localStorage.removeItem('carecall_temp_carer');
  // Flag-only: clear tempCarer flag. Don't mutate role — it stays 'family' in the room.
  for (const room of S.rooms) {
    try {
      await db.ref(`carecall/rooms/${room}/members/${S.uid}`).update({ tempCarer: null });
    } catch(e) { console.warn('[TempCarer] flag revert failed for room', room, e && e.message); }
  }
  // Remove FCM tokens from rooms (stop receiving call pushes)
  for (const room of S.rooms) {
    try {
      await db.ref(`carecall/rooms/${room}/members/${S.uid}/fcmToken`).remove();
    } catch(_) {}
  }
  // Tear down carer listeners
  if (CS._listenerRefs) { CS._listenerRefs.forEach(r => { try { r.off(); } catch(_) {} }); CS._listenerRefs = []; }
  S.role = _realRole || 'family';
  _realRole = null;
  showScreen('s-log');
  _startFamilyListeners();
  refreshLog();
  _updateTempCarerUI(false);
  toast(t('Back to observer mode'));
}

function _updateTempCarerUI(active) {
  const btn = document.getElementById('temp-carer-btn');
  const banner = document.getElementById('temp-carer-banner');
  const settingsBtn = document.getElementById('s-temp-carer-btn');
  if (btn) {
    btn.textContent = active ? t('Back to Observer') : ('🔔 ' + t('Step in as Carer'));
    btn.style.background = active ? 'rgba(220,38,38,0.15)' : 'rgba(14,165,233,0.15)';
    btn.style.color = active ? '#DC2626' : '#0EA5E9';
  }
  if (banner) banner.style.display = active ? '' : 'none';
  if (settingsBtn) settingsBtn.textContent = active ? t('On') : t('Off');
}

function _showTempCarerToggleIfFamily() {
  const btn = document.getElementById('temp-carer-btn');
  const section = document.getElementById('s-temp-carer-section');
  const isFamily = (S.role === 'family') || (_tempCarerActive && _realRole === 'family');
  if (btn) btn.style.display = isFamily ? '' : 'none';
  if (section) section.style.display = isFamily ? '' : 'none';
}

// Check on boot whether the user had temp-carer active in a previous session
function _restoreTempCarerOnBoot() {
  if (localStorage.getItem('carecall_temp_carer') === '1' && S.role === 'family') {
    _tempCarerActive = true;
    _realRole = 'family';
    S.role = 'carer';
    _updateTempCarerUI(true);
    // Actual carer listeners/push will be set up by launchMainScreen
  }
}

// ════════════════════════════════════════════════════════════
//  CARER LOGIC
// ════════════════════════════════════════════════════════════
let _carerAvailability = 'available'; // 'available' | 'busy' | 'off-duty'

function setAvailability(status) {
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

let _carerStarted = false;
function startCarer() {
  _carerStarted = false;
  _carerAvailability = localStorage.getItem('carecall_availability') || 'available';
  setAvailability(_carerAvailability);
  updateCarerOrb('listening', 'Waiting for patient…');
  setupCarerPush();
  _updateGreetingHeaders();
  _updateSettingsPhotoThumb();
  _watchMemberPhotos();

  // Prune duplicate rooms before attaching listeners — prevents
  // the same patient appearing twice from two rooms for the same pair.
  _deduplicateRoomsByPair();

  // ── Clean up old listeners (prevents stacking when called again) ──
  if (CS._listenerRefs) CS._listenerRefs.forEach(ref => ref.off());
  CS._listenerRefs = [];

  // Aggregate members across ALL rooms for display
  const _carerMembersCache = {};
  window._carerMembersCache = _carerMembersCache;
  function _rebuildCarerMembers() {
    const allMembers = {};
    Object.values(_carerMembersCache).forEach(members => {
      Object.entries(members).forEach(([uid, m]) => {
        if (uid === S.uid) return; // skip self from member lists
        const stale = _isPresenceStale(m);
        const effectiveOnline = m.online && !stale;
        const existing = allMembers[uid];
        const existingOnline = existing && existing.online && !_isPresenceStale(existing);
        // Prefer the entry that shows the user as effectively online.
        if (!existing || (effectiveOnline && !existingOnline)) {
          allMembers[uid] = m;
        }
      });
    });
    // Re-add self (from any room — just need presence)
    Object.values(_carerMembersCache).forEach(members => {
      if (members[S.uid] && !allMembers[S.uid]) allMembers[S.uid] = members[S.uid];
    });
    renderMembers(allMembers);
    renderRoomDropdown('c', allMembers);
    renderPatientsList(allMembers);
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
function checkForMissedCalls() {
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

function renderMembers(members) {
  const bar = document.getElementById('members-bar');
  const noTxt = document.getElementById('no-members-txt');
  bar.querySelectorAll('.member-chip').forEach(c=>c.remove());
  // Belt-and-braces: dedup by uid (skip self) in case duplicate rooms
  // leaked through from _rebuildCarerMembers.
  const seen = new Set();
  const entries = Object.entries(members).filter(([uid]) => {
    if (uid === S.uid) return true; // always show self once
    if (seen.has(uid)) return false;
    seen.add(uid);
    return true;
  });
  if (!entries.length) { noTxt.style.display=''; return; }
  noTxt.style.display = 'none';
  entries.forEach(([uid, m]) => {
    const chip = document.createElement('div');
    const isMe = uid === S.uid;
    const stale = _isPresenceStale(m);
    const effectiveOnline = m.online && !stale;
    const chipRole = (m.role === 'family' && m.tempCarer) ? 'carer' : m.role;
    chip.className = `member-chip ${chipRole === 'patient' ? 'patient-chip' : 'carer-chip'}${effectiveOnline ? '' : ' offline-chip'}`;
    const av = m.avatar ? `<span style="font-size:0.9rem">${escHtml(m.avatar)}</span>` : '<div class="mdot"></div>';
    const staleLabel = stale && m.lastSeen ? ` <span style="font-size:0.7rem;color:#d97706">(${t('last seen')} ${timeAgo(m.lastSeen)})</span>` : '';
    chip.innerHTML = `${av}${escHtml(m.name)}${isMe ? ' (me)' : ''}${staleLabel}`;
    bar.appendChild(chip);
  });
  // Update orb — treat stale presence as not truly online
  const patients = entries.filter(([,m])=>m.role==='patient' && m.online && !_isPresenceStale(m));
  if (patients.length) {
    updateCarerOrb('connected', `${patients.length} patient${patients.length>1?'s':''} connected`);
  } else {
    updateCarerOrb('listening', 'Waiting for patient…');
  }
}

function updateCarerOrb(state, msg) {
  const orb  = document.getElementById('carer-orb');
  const icon = document.getElementById('orb-icon');
  const lbl  = document.getElementById('orb-lbl');
  const stat = document.getElementById('orb-status');
  stat.textContent = msg; stat.className = 'orb-status';
  if (state==='listening') { orb.style.cssText=''; icon.innerHTML='<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'; lbl.textContent=t('Standby'); }
  if (state==='connected') { orb.style.cssText='border-color:rgba(16,185,129,.5);background:rgba(16,185,129,.08)'; icon.innerHTML='<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/></svg>'; lbl.textContent='On Call'; stat.classList.add('live'); }
  // Update orb info with patient count and today's call count
  _updateOrbInfo();
}

function _updateOrbInfo() {
  const infoEl = document.getElementById('orb-info');
  if (!infoEl) return;
  // Count connected patients from members bar
  const patientChips = document.querySelectorAll('#members-bar .member-chip.patient-chip:not(.offline-chip)');
  const patientCount = patientChips.length;
  // Count today's calls from cache
  const today = new Date(); today.setHours(0,0,0,0);
  const todayCalls = _allLogCalls ? _allLogCalls.filter(c => c.timestamp && c.timestamp >= today.getTime() && !c._type).length : 0;
  if (patientCount || todayCalls) {
    infoEl.textContent = t('Monitoring') + ' ' + patientCount + ' ' + (patientCount === 1 ? t('patient') : t('patients')) + ' — ' + todayCalls + ' ' + (todayCalls === 1 ? t('call') : t('calls')) + ' ' + t('Today').toLowerCase();
  } else {
    infoEl.textContent = '';
  }
}

function addActiveCall(call) {
  CS.activeCalls[call.id] = call;
  renderCallCards();
}
function updateCallCard(call) {
  CS.activeCalls[call.id] = call;
  renderCallCards();
}
function removeCallCard(callId) {
  delete CS.activeCalls[callId];
  renderCallCards();
}

function renderCallCards() {
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

// Queue of pending calls — when multiple patients call simultaneously,
// the carer sees one alert at a time. After acking/dismissing, the
// next queued call fires automatically. A "+N more" badge shows how
// many calls are waiting.
const _callQueue = [];

async function showIncomingAlert(call) {
  if (CS.alertCallId === call.id) return;
  if (_callQueue.some(c => c.id === call.id)) return;
  // If an alert is already showing, queue this one
  if (CS.alertCallId && document.getElementById('incoming-alert').classList.contains('show')) {
    _callQueue.push(call);
    _updateCallQueueBadge();
    return;
  }
  _showAlertForCall(call);
}

async function _showAlertForCall(call) {
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

  _updateCallQueueBadge();
  document.getElementById('incoming-alert').classList.add('show');
  // On native: fire repeated local notifications so the alert is persistent
  // even when the app is backgrounded. iOS only shows system notifications
  // when the app isn't in the foreground.
  if (IS_NATIVE) {
    // Immediate notification
    Native.scheduleLocalNotification({
      id: 99990,
      title: '🚨 ' + call.fromName + ' is calling!',
      body: needLabel(call.type) + ' — tap to respond',
      sound: 'default',
      channelId: 'carecall_alerts',
    }).catch(() => {});
    // Follow-up at 15 seconds
    Native.scheduleLocalNotification({
      id: 99991,
      title: '🚨 ' + call.fromName + ' still needs help!',
      body: 'Open CareCall to respond',
      sound: 'default',
      channelId: 'carecall_alerts',
      at: new Date(Date.now() + 15000),
    }).catch(() => {});
    // Follow-up at 30 seconds
    Native.scheduleLocalNotification({
      id: 99992,
      title: '⚠️ Urgent: ' + call.fromName + ' is waiting',
      body: 'No response yet — tap to open CareCall',
      sound: 'default',
      channelId: 'carecall_alerts',
      at: new Date(Date.now() + 30000),
    }).catch(() => {});
  }
  try {
    if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {});
    }
  } catch(e) {}
  startBell();
}

function _updateCallQueueBadge() {
  let badge = document.getElementById('ia-queue-badge');
  if (_callQueue.length > 0) {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'ia-queue-badge';
      badge.style.cssText = 'position:absolute;top:12px;left:12px;background:var(--warning);color:#000;font-size:0.85rem;font-weight:800;border-radius:999px;padding:4px 12px;font-family:Outfit,sans-serif;z-index:101';
      document.getElementById('incoming-alert')?.appendChild(badge);
    }
    badge.textContent = '+' + _callQueue.length + ' ' + t('more');
  } else if (badge) {
    badge.remove();
  }
}

function dismissAlert() {
  document.getElementById('incoming-alert').classList.remove('show');
  stopBell(); CS.alertCallId = null;
  // Show the next queued call if any
  if (_callQueue.length > 0) {
    const next = _callQueue.shift();
    setTimeout(() => _showAlertForCall(next), 400);
  }
}

async function acknowledgeCall(callId) {
  unlockAudio();
  // Cancel follow-up alert notifications
  if (IS_NATIVE) {
    Native.cancelLocalNotification(99991).catch(() => {});
    Native.cancelLocalNotification(99992).catch(() => {});
  }
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
    const ackData = {
      status:  'acknowledged',
      ackUid:  S.uid,
      ackName: S.name,
      ackAt:   firebase.database.ServerValue.TIMESTAMP,
    };
    await db.ref(`carecall/rooms/${roomId}/calls/${callId}`).update(ackData);
    // Broadcast-copy sync removed: family members now share the
    // patient↔carer rooms directly and see ack updates in real time.
    toast(t("Patient notified — you're on the way!"));
  } catch(e) {
    console.error('[Ack] Failed:', e);
    toast(t('Failed to acknowledge — check your connection'));
  } finally {
    CS._ackingCallId = null;
  }
}

function acknowledgeFromAlert() {
  if (CS.alertCallId) acknowledgeCall(CS.alertCallId);
  dismissAlert();
}

// ════════════════════════════════════════════════════════════
//  LOG
// ════════════════════════════════════════════════════════════
let _allLogCalls = [];  // cached for filtering + export
let _logFilter = 'all'; // current filter
let _logLastFetched = 0;
const LOG_CACHE_MS = 30000;

async function refreshLog(forceRefresh) {
  const content = document.getElementById('log-content');
  const dashboard = document.getElementById('log-dashboard');
  const skeleton = document.getElementById('log-skeleton');
  const ptrIndicator = document.getElementById('ptr-indicator');
  if (!db || !S.rooms.length) {
    content.innerHTML = '<div class="log-empty">' + t('No connections yet — add a patient or carer in Settings') + '</div>';
    if (dashboard) dashboard.style.display = 'none';
    if (skeleton) skeleton.style.display = 'none';
    return;
  }
  // Return cached data if fresh enough (unless force-refresh requested)
  if (!forceRefresh && _allLogCalls.length && (Date.now() - _logLastFetched) < LOG_CACHE_MS) {
    renderLogEntries();
    return;
  }
  // Show skeleton loading while fetching
  if (skeleton && !_allLogCalls.length) skeleton.style.display = 'block';
  if (forceRefresh && ptrIndicator) ptrIndicator.classList.add('show');
  content.innerHTML = '<div class="log-empty">' + t('Loading…') + '</div>';

  // Family members are now added to all patient↔carer rooms at pairing
  // time, so S.rooms already contains every room we need to query.
  let roomsToQuery = [...S.rooms];

  // Fetch calls from ALL relevant rooms
  const allCalls = [];
  const fetches = roomsToQuery.map(roomCode =>
    db.ref(`carecall/rooms/${roomCode}/calls`)
      .orderByChild('timestamp')
      .limitToLast(100)
      .once('value')
      .then(snap => {
        snap.forEach(c => {
          const call = c.val();
          call._room = roomCode;
          allCalls.push(call);
        });
      })
  );
  await Promise.all(fetches);

  // Merge handoff notes into the timeline
  const handoffNotes = await _fetchHandoffNotes(roomsToQuery);
  handoffNotes.forEach(n => { n.timestamp = n.at; allCalls.push(n); });

  allCalls.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  _allLogCalls = allCalls;
  _logLastFetched = Date.now();

  // Hide skeleton and pull-to-refresh indicator
  const skeleton2 = document.getElementById('log-skeleton');
  if (skeleton2) skeleton2.style.display = 'none';
  const ptrInd2 = document.getElementById('ptr-indicator');
  if (ptrInd2) ptrInd2.classList.remove('show');

  // Build filter buttons from unique names
  buildLogFilters(allCalls);
  renderLogEntries();
}

function buildLogFilters(calls) {
  const bar = document.getElementById('log-filters');
  bar.innerHTML = '';
  const names = new Set();
  calls.forEach(c => {
    if (c.fromName) names.add(c.fromName);
    if (c.from && c._type === 'handoff') names.add(c.from);
    if (c.ackName) names.add(c.ackName);
  });

  const mkBtn = (label, value) => {
    const btn = document.createElement('button');
    btn.className = `log-filter-btn${_logFilter === value ? ' selected' : ''}`;
    btn.dataset.filter = value;
    btn.textContent = label;
    btn.onclick = () => setLogFilter(value, btn);
    bar.appendChild(btn);
  };

  mkBtn('All', 'all');
  mkBtn('📋 Notes', 'handoff');
  names.forEach(name => mkBtn(name, name));
}

function setLogFilter(value) {
  _logFilter = value;
  document.querySelectorAll('.log-filter-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.filter === value);
  });
  renderLogEntries();
}

// ── Pull-to-refresh on log screen ──
(function _initPullToRefresh() {
  let _ptrStartY = 0, _ptrActive = false;
  document.addEventListener('DOMContentLoaded', () => {
    const logScreen = document.getElementById('s-log');
    if (!logScreen) return;
    logScreen.addEventListener('touchstart', (e) => {
      if (logScreen.scrollTop <= 0) { _ptrStartY = e.touches[0].clientY; _ptrActive = true; }
    }, { passive: true });
    logScreen.addEventListener('touchmove', (e) => {
      if (!_ptrActive) return;
    }, { passive: true });
    logScreen.addEventListener('touchend', (e) => {
      if (!_ptrActive) return;
      const dy = e.changedTouches[0].clientY - _ptrStartY;
      _ptrActive = false;
      if (dy > 80 && logScreen.scrollTop <= 0) {
        refreshLog(true);
      }
    }, { passive: true });
  });
})();

function renderLogEntries() {
  const content = document.getElementById('log-content');
  const dashboard = document.getElementById('log-dashboard');
  let calls = _allLogCalls;
  if (_logFilter === 'handoff') {
    calls = calls.filter(c => c._type === 'handoff');
  } else if (_logFilter !== 'all') {
    calls = calls.filter(c => c.fromName === _logFilter || c.ackName === _logFilter || c.from === _logFilter);
  }
  if (!calls.length) {
    content.innerHTML = '<div class="log-empty">📞 No calls yet<br><span style="font-size:0.8rem;opacity:0.6">Your call history will appear here</span></div>';
    dashboard.style.display = 'none';
    return;
  }

  // ── Analytics dashboard ──
  dashboard.style.display = '';
  const acked = calls.filter(c => c.status === 'acknowledged' && c.ackAt && c.timestamp);
  const responseTimes = acked.map(c => c.ackAt - c.timestamp).filter(t => t > 0);
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayCalls = calls.filter(c => c.timestamp >= todayStart.getTime());

  document.getElementById('dash-total').textContent = calls.length;
  document.getElementById('dash-responded').textContent = acked.length;
  document.getElementById('dash-today').textContent = todayCalls.length;

  if (responseTimes.length) {
    const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    const fastest = Math.min(...responseTimes);
    const slowest = Math.max(...responseTimes);
    document.getElementById('dash-avg-response').textContent = formatDuration(avg);
    document.getElementById('dash-fastest').textContent = formatDuration(fastest);
    document.getElementById('dash-slowest').textContent = formatDuration(slowest);
  } else {
    document.getElementById('dash-avg-response').textContent = '—';
    document.getElementById('dash-fastest').textContent = '—';
    document.getElementById('dash-slowest').textContent = '—';
  }

  // Most common needs
  const needCounts = {};
  calls.forEach(c => {
    const types = (c.type || 'help').split(',');
    types.forEach(t => { needCounts[t] = (needCounts[t] || 0) + 1; });
  });
  const sortedNeeds = Object.entries(needCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const needsEl = document.getElementById('dash-needs');
  needsEl.innerHTML = sortedNeeds.map(([t, n]) =>
    `<span class="dash-need-chip">${needLabel(t).split(' ')[0]} ${needLabel(t).split(' ').slice(1).join(' ')} (${n})</span>`
  ).join('');

  // ── AI Insights: rule-based pattern detection ──
  _renderWellnessScore(calls);
  _renderInsights(calls);

  content.innerHTML = '';
  const multiRoom = S.rooms.length > 1;
  calls.forEach(call => {
    const ts = call.timestamp ? new Date(call.timestamp).toLocaleString() : '';
    const entry = document.createElement('div');

    // Handoff notes have a distinct visual style
    if (call._type === 'handoff') {
      const priorityColors = { urgent: 'var(--danger)', important: 'var(--warning)', normal: 'var(--carer-primary)' };
      const priorityIcons = { urgent: '🚨', important: '⚠️', normal: '📋' };
      const color = priorityColors[call.priority] || priorityColors.normal;
      const icon = priorityIcons[call.priority] || '📋';
      // v2: render status chips if present
      let statusTagsHtml = '';
      if (call.status && typeof call.status === 'object') {
        const tags = Object.keys(call.status).map(dim => {
          const dimDef = HANDOFF_STATUS_DIMENSIONS.find(d => d.key === dim);
          if (!dimDef) return '';
          const opt = dimDef.options.find(o => o.v === call.status[dim]);
          if (!opt) return '';
          const cls = opt.cls.replace('ho-', '');
          return `<span class="ho-tag ${cls}">${escHtml(opt.label)}</span>`;
        }).filter(Boolean);
        if (tags.length) statusTagsHtml = `<div class="ho-tags">${tags.join('')}</div>`;
      }
      // v2: show who acked (read-receipt) — list other carers who tapped "Got it".
      let acksHtml = '';
      if (call.acks && typeof call.acks === 'object') {
        const names = Object.values(call.acks)
          .filter(a => a && a.byUid !== call.fromUid)
          .map(a => escHtml(a.by || ''))
          .filter(Boolean);
        if (names.length) {
          acksHtml = `<div class="log-ack" style="color:var(--success)">👍 ${t('Read by')}: ${names.join(', ')}</div>`;
        }
      }
      entry.className = 'log-entry';
      entry.style.borderLeft = `3px solid ${color}`;
      entry.innerHTML = `
        <div class="log-icon-col" style="background:rgba(14,165,233,0.1)">${icon}</div>
        <div class="log-body">
          <div class="log-who">${call.avatar ? escHtml(call.avatar) + ' ' : ''}${escHtml(call.from)} <span style="font-size:0.7rem;color:#6889A5;font-weight:400">· ${t('Shift Note')}</span></div>
          ${call.text ? `<div class="log-msg" style="color:#F1F5F9;font-style:normal;font-size:0.85rem">"${escHtml(call.text)}"</div>` : ''}
          ${statusTagsHtml}
          <div class="log-meta">📅 ${ts}</div>
          ${acksHtml}
        </div>`;
    } else {
      // Regular call entry
      const responseMs = call.ackAt && call.timestamp ? call.ackAt - call.timestamp : null;
      const responseTxt = responseMs ? formatDuration(responseMs) : null;
      entry.className = 'log-entry';
      entry.innerHTML = `
        <div class="log-icon-col ${call.status==='acknowledged'?'acked':'active'}">${needLabel(call.type).split(' ')[0]}</div>
        <div class="log-body">
          <div class="log-who">${call.avatar ? escHtml(call.avatar) + ' ' : ''}${escHtml(call.fromName)}${multiRoom ? `<span class="log-room-tag">${escHtml(call._room)}</span>` : ''}</div>
          <div class="log-type">${needLabel(call.type)}</div>
          ${call.message ? `<div class="log-msg">"${escHtml(call.message)}"</div>` : ''}
          <div class="log-meta">📅 ${ts}</div>
          ${call.status==='acknowledged'
            ? `<div class="log-ack">✅ ${escHtml(call.ackName||'')} responded${responseTxt ? ` in ${responseTxt}` : ''}</div>`
            : `<div class="log-unacked">⏳ No response recorded</div>`}
          ${call.careNote ? `<div class="log-msg" style="color:var(--carer-primary)">📝 ${escHtml(call.careNote.text)} — ${escHtml(call.careNote.by)}</div>` : ''}
          ${call.location ? `<div class="log-meta"><a href="https://maps.google.com/maps?q=${call.location.lat},${call.location.lng}" target="_blank" style="color:var(--carer-primary);text-decoration:none">📍 View location</a></div>` : ''}
        </div>`;
    }
    content.appendChild(entry);
  });

  // Fire-and-forget: fetch med events and render the trendline + missed
  // charts. Separate path from _allLogCalls because those are room call
  // records; medication events live at carecall/rooms/{room}/medications.
  _renderMedChartsInLog();
  // Family members: show a read-only medication list from shared room medConfig
  if (S.role === 'family') _renderFamilyMedsList();
}

async function _renderFamilyMedsList() {
  let container = document.getElementById('family-meds-section');
  if (!container) {
    // Create the container on first call — insert after the dashboard
    container = document.createElement('div');
    container.id = 'family-meds-section';
    container.style.cssText = 'padding:0 20px 16px;width:100%';
    const dashboard = document.getElementById('log-dashboard');
    if (dashboard) dashboard.after(container);
    else return;
  }
  // Read medConfig from all rooms
  const allMeds = [];
  const seen = new Set();
  for (const roomId of S.rooms) {
    try {
      const snap = await db.ref(`carecall/rooms/${roomId}/medConfig`).once('value');
      const meds = snap.val();
      if (Array.isArray(meds)) {
        meds.forEach(m => {
          if (m && m.id && !seen.has(m.id)) { seen.add(m.id); allMeds.push(m); }
        });
      }
    } catch(_) {}
  }
  if (!allMeds.length) {
    container.innerHTML = '';
    return;
  }
  let html = `<div style="font-size:0.7rem;letter-spacing:2px;text-transform:uppercase;color:#6889A5;font-weight:600;margin-bottom:8px">${escHtml(t('Patient Medications'))}</div>`;
  allMeds.forEach(m => {
    const dose = m.dose ? ` ${m.dose}${m.unit || ''}` : '';
    const schedule = m.prn ? t('As needed') : (m.schedule && m.schedule.times ? m.schedule.times.join(', ') : '');
    const ingredient = m.activeIngredient ? ` <span style="color:#6889A5;font-size:0.75rem">(${escHtml(m.activeIngredient)})</span>` : '';
    const enabled = m.enabled !== false;
    html += `
      <div style="background:#162032;border-radius:12px;padding:12px 14px;margin-bottom:6px;opacity:${enabled ? '1' : '0.5'}">
        <div style="font-weight:600;color:#F1F5F9">💊 ${escHtml(m.name)}${dose}${ingredient}</div>
        <div style="font-size:0.78rem;color:#6889A5;margin-top:2px">${escHtml(schedule)}</div>
      </div>`;
  });
  container.innerHTML = html;
}

// Renders the 30-day adherence trendline + most-missed-med bar chart
// in the log dashboard. Runs for all roles; scopes data by role:
//   - patient: only their own events
//   - family / carer: all medication events in their rooms
async function _renderMedChartsInLog() {
  const row = document.getElementById('med-charts-row');
  const missedRow = document.getElementById('med-missed-row');
  if (!row || !missedRow) return;
  const rooms = (S && S.rooms) || [];
  if (!rooms.length) { row.style.display = 'none'; missedRow.style.display = 'none'; return; }

  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const events = [];
  await Promise.all(rooms.map(async r => {
    try {
      const snap = await db.ref(`carecall/rooms/${r}/medications`)
        .orderByChild('timestamp').startAt(since).once('value');
      snap.forEach(c => { const v = c.val(); if (v) events.push(v); });
    } catch(e) { /* ignore */ }
  }));

  const filtered = (S.role === 'patient')
    ? events.filter(e => e.uid === S.uid)
    : events;

  if (!filtered.length) { row.style.display = 'none'; missedRow.style.display = 'none'; return; }

  const dayBuckets = {};
  const missedByMed = {};
  filtered.forEach(e => {
    const d = new Date(e.timestamp || Date.now());
    const key = d.toISOString().slice(0, 10);
    if (!dayBuckets[key]) dayBuckets[key] = { taken: 0, scheduled: 0 };
    const status = (e.status || '').toLowerCase();
    if (status === 'taken') dayBuckets[key].taken++;
    if (status === 'taken' || status === 'missed') dayBuckets[key].scheduled++;
    if (status === 'missed') {
      const name = _medLabelForEvent(e);
      missedByMed[name] = (missedByMed[name] || 0) + 1;
    }
  });

  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const b = dayBuckets[key];
    const pct = b && b.scheduled > 0 ? (b.taken / b.scheduled) * 100 : null;
    days.push({ date: key, pct });
  }

  _renderAdherenceSvg(days);
  _renderMostMissed(missedByMed);
  row.style.display = '';
  missedRow.style.display = Object.keys(missedByMed).length ? '' : 'none';
}

function _medLabelForEvent(e) {
  const n = e.medName || '—';
  if (e.dose != null) return n + ' ' + e.dose + (e.unit || '');
  return n;
}

function _renderAdherenceSvg(days) {
  const svg = document.getElementById('adherence-trend');
  if (!svg) return;
  const W = 300, H = 80, padY = 8;
  const n = days.length;
  const xFor = i => (i / (n - 1)) * W;
  const yFor = pct => H - padY - (pct / 100) * (H - 2 * padY);

  const pts = days.map((d, i) => d.pct === null ? null : [xFor(i), yFor(d.pct)]);
  let pathD = '';
  pts.forEach((p, i) => {
    if (!p) return;
    pathD += (i === 0 || !pts[i - 1]) ? `M${p[0]},${p[1]}` : ` L${p[0]},${p[1]}`;
  });

  const defined = days.filter(d => d.pct !== null);
  const overall = defined.length
    ? Math.round(defined.reduce((s, d) => s + d.pct, 0) / defined.length)
    : null;

  const lastDefinedIdx = pts.map((p, i) => p ? i : -1).filter(i => i >= 0).pop();
  const firstDefinedIdx = pts.findIndex(p => p);
  const fillPath = (pathD && firstDefinedIdx >= 0 && lastDefinedIdx >= 0)
    ? pathD + ` L${xFor(lastDefinedIdx)},${H} L${xFor(firstDefinedIdx)},${H} Z`
    : '';

  svg.innerHTML = `
    <defs>
      <linearGradient id="adhFill" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="#0EA5E9" stop-opacity="0.45"/>
        <stop offset="1" stop-color="#0EA5E9" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line x1="0" y1="${yFor(80)}" x2="${W}" y2="${yFor(80)}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="2,3"/>
    <line x1="0" y1="${yFor(50)}" x2="${W}" y2="${yFor(50)}" stroke="rgba(255,255,255,0.05)" stroke-dasharray="2,3"/>
    ${fillPath ? `<path d="${fillPath}" fill="url(#adhFill)"/>` : ''}
    ${pathD ? `<path d="${pathD}" fill="none" stroke="#0EA5E9" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
  `;

  const summary = document.getElementById('adherence-summary');
  if (summary) {
    summary.textContent = overall === null
      ? t('No medication data yet.')
      : t('30-day average') + ': ' + overall + '%';
  }
}

function _renderMostMissed(missedByMed) {
  const el = document.getElementById('most-missed-list');
  if (!el) return;
  const arr = Object.entries(missedByMed).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!arr.length) {
    el.innerHTML = `<div style="font-size:0.78rem;color:#6889A5;padding:4px 0">${t('No missed doses in the last 30 days 🎉')}</div>`;
    return;
  }
  const max = arr[0][1];
  el.innerHTML = arr.map(([name, cnt]) => {
    const pct = Math.max(10, (cnt / max) * 100);
    return `
      <div class="mm-row">
        <div class="mm-label" title="${escHtml(name)}">${escHtml(name)}</div>
        <div class="mm-bar-wrap"><div class="mm-bar" style="width:${pct}%"></div></div>
        <div class="mm-count">${cnt}</div>
      </div>`;
  }).join('');
}

function _renderWellnessScore(calls) {
  const card = document.getElementById('wellness-card');
  if (!card || calls.length < 3) { if (card) card.style.display = 'none'; return; }
  card.style.display = 'flex';

  const now = Date.now();
  const WEEK = 7 * 86400000;
  const thisWeek = calls.filter(c => c.timestamp >= now - WEEK);
  const lastWeek = calls.filter(c => c.timestamp >= now - 2*WEEK && c.timestamp < now - WEEK);

  let score = 10;
  const factors = [];

  // 1. Call frequency trend (0-2 points deduction)
  if (thisWeek.length && lastWeek.length) {
    const change = (thisWeek.length - lastWeek.length) / lastWeek.length;
    if (change > 0.5) { score -= 2; factors.push({ text: 'Calls up ' + Math.round(change*100) + '%', level: 'bad' }); }
    else if (change > 0.2) { score -= 1; factors.push({ text: 'Calls rising', level: 'warn' }); }
    else if (change < -0.2) { factors.push({ text: 'Calls decreasing', level: 'good' }); }
  }

  // 2. Response rate (0-2 points deduction)
  if (thisWeek.length >= 3) {
    const unresponded = thisWeek.filter(c => c.status !== 'acknowledged').length;
    const rate = unresponded / thisWeek.length;
    if (rate > 0.3) { score -= 2; factors.push({ text: Math.round(rate*100) + '% unanswered', level: 'bad' }); }
    else if (rate > 0.1) { score -= 1; factors.push({ text: 'Some unanswered', level: 'warn' }); }
    else { factors.push({ text: 'All answered', level: 'good' }); }
  }

  // 3. Pain/fall events (0-2 points deduction)
  const painCalls = thisWeek.filter(c => (c.type||'').includes('pain'));
  const fallCalls = thisWeek.filter(c => c.type === 'fall');
  if (fallCalls.length >= 2) { score -= 2; factors.push({ text: fallCalls.length + ' falls', level: 'bad' }); }
  else if (fallCalls.length === 1) { score -= 1; factors.push({ text: '1 fall', level: 'warn' }); }
  if (painCalls.length >= 3) { score -= 1; factors.push({ text: painCalls.length + ' pain calls', level: 'bad' }); }

  // 4. Medication adherence (0-2 points deduction)
  const medMissed = thisWeek.filter(c => c.type === 'med-missed');
  const medTotal = thisWeek.filter(c => c.type === 'med-missed' || c.type === 'med-taken');
  if (medTotal.length >= 3) {
    const adherence = (medTotal.length - medMissed.length) / medTotal.length;
    if (adherence < 0.7) { score -= 2; factors.push({ text: 'Meds ' + Math.round(adherence*100) + '%', level: 'bad' }); }
    else if (adherence < 0.9) { score -= 1; factors.push({ text: 'Meds ' + Math.round(adherence*100) + '%', level: 'warn' }); }
    else { factors.push({ text: 'Meds ' + Math.round(adherence*100) + '%', level: 'good' }); }
  }

  // 5. Missed check-ins (0-1 point deduction)
  const missedCheckins = thisWeek.filter(c => c.type === 'checkin-missed');
  if (missedCheckins.length >= 3) { score -= 1; factors.push({ text: missedCheckins.length + ' missed check-ins', level: 'warn' }); }

  // 6. Night activity (0-1 point deduction)
  const nightCalls = thisWeek.filter(c => { const h = new Date(c.timestamp).getHours(); return h >= 22 || h < 6; });
  if (nightCalls.length >= 3) { score -= 1; factors.push({ text: nightCalls.length + ' night calls', level: 'warn' }); }

  score = Math.max(1, Math.min(10, score));

  // Render
  const scoreEl = document.getElementById('ws-score');
  const ringEl = document.getElementById('ws-ring-fill');
  const labelEl = document.getElementById('ws-label');
  const factorsEl = document.getElementById('ws-factors');

  scoreEl.textContent = score;
  const circumference = 264; // 2 * pi * 42
  ringEl.style.strokeDashoffset = String(circumference * (1 - score / 10));
  ringEl.style.stroke = score >= 8 ? 'var(--success)' : score >= 5 ? 'var(--warning)' : 'var(--danger)';

  const labels = ['', 'Critical', 'Very Poor', 'Poor', 'Concerning', 'Fair', 'Moderate', 'Good', 'Very Good', 'Excellent', 'Excellent'];
  labelEl.textContent = labels[score] || 'Calculating…';

  factorsEl.innerHTML = factors.map(f => `<span class="ws-factor ${f.level}">${f.text}</span>`).join('');
}

function _renderInsights(calls) {
  const el = document.getElementById('dash-insights');
  if (!el) return;
  const insights = _generateInsights(calls);
  el.innerHTML = '';
  if (!insights.length) return;
  // Build each insight via DOM APIs so any future insight generator that
  // forgets to escape user-controlled text (e.g. a patient's display name
  // slipping into the body copy) cannot execute script. Today's generators
  // interpolate only numbers/durations/fixed labels, but that's a fragile
  // invariant — the defence-in-depth here makes the pattern safe by default.
  // The existing rich text (e.g. <strong> tags) is preserved via innerHTML
  // into a *dedicated* text span whose content is fully controlled here.
  insights.forEach(i => {
    const row = document.createElement('div');
    row.className = 'insight-item ' + (i.level || '');
    const icon = document.createElement('span');
    icon.className = 'insight-icon';
    icon.textContent = i.icon || '';
    const text = document.createElement('span');
    text.className = 'insight-text';
    // i.text is generated in-app; keep the <strong> markup by letting it
    // render as HTML here — but ALL interpolated substrings that reach
    // this point must be numeric or from a fixed vocabulary. Audit the
    // generators (_generateInsights / _generateRoutineInsights /
    // _generateCarerWellbeingInsights) before adding any user-derived
    // string to i.text.
    text.innerHTML = i.text || '';
    row.appendChild(icon);
    row.appendChild(text);
    el.appendChild(row);
  });
}

function _generateInsights(calls) {
  const insights = [];
  if (calls.length < 2) return insights;

  const now = Date.now();
  const DAY = 86400000;
  const WEEK = 7 * DAY;

  // Split calls into time periods
  const thisWeek = calls.filter(c => c.timestamp >= now - WEEK);
  const lastWeek = calls.filter(c => c.timestamp >= now - 2*WEEK && c.timestamp < now - WEEK);
  const today = calls.filter(c => c.timestamp >= now - DAY);
  const yesterday = calls.filter(c => c.timestamp >= now - 2*DAY && c.timestamp < now - DAY);

  // ── 1. Call frequency trend ──
  if (thisWeek.length && lastWeek.length) {
    const change = ((thisWeek.length - lastWeek.length) / lastWeek.length * 100).toFixed(0);
    if (change > 30) {
      insights.push({ icon: '📈', level: 'warn', text: `Call frequency <strong>up ${change}%</strong> this week (${thisWeek.length} vs ${lastWeek.length} last week). Consider checking on the patient.` });
    } else if (change < -30) {
      insights.push({ icon: '📉', level: 'good', text: `Call frequency <strong>down ${Math.abs(change)}%</strong> this week (${thisWeek.length} vs ${lastWeek.length} last week).` });
    }
  }

  // ── 2. Response time trend ──
  const getAvgResponse = (list) => {
    const times = list.filter(c => c.ackAt && c.timestamp).map(c => c.ackAt - c.timestamp).filter(t => t > 0);
    return times.length ? times.reduce((a,b) => a+b, 0) / times.length : null;
  };
  const thisWeekAvg = getAvgResponse(thisWeek);
  const lastWeekAvg = getAvgResponse(lastWeek);
  if (thisWeekAvg && lastWeekAvg) {
    const changePct = ((thisWeekAvg - lastWeekAvg) / lastWeekAvg * 100).toFixed(0);
    if (changePct > 50) {
      insights.push({ icon: '⏱️', level: 'warn', text: `Average response time <strong>increased ${changePct}%</strong> (${formatDuration(thisWeekAvg)} vs ${formatDuration(lastWeekAvg)} last week). Carers may need support.` });
    } else if (changePct < -30) {
      insights.push({ icon: '⚡', level: 'good', text: `Response time <strong>improved ${Math.abs(changePct)}%</strong> this week (${formatDuration(thisWeekAvg)} avg).` });
    }
  }

  // ── 3. Unresponded calls ──
  const unresponded = thisWeek.filter(c => c.status !== 'acknowledged');
  if (unresponded.length >= 3) {
    insights.push({ icon: '⚠️', level: 'alert', text: `<strong>${unresponded.length} calls</strong> this week had no response. Ensure carers have notifications enabled.` });
  }

  // ── 4. New need types appearing ──
  const thisWeekTypes = new Set(); const lastWeekTypes = new Set();
  thisWeek.forEach(c => (c.type||'help').split(',').forEach(t => thisWeekTypes.add(t)));
  lastWeek.forEach(c => (c.type||'help').split(',').forEach(t => lastWeekTypes.add(t)));
  const newTypes = [...thisWeekTypes].filter(t => !lastWeekTypes.has(t) && t !== 'help');
  if (newTypes.length && lastWeek.length >= 3) {
    const labels = newTypes.map(t => needLabel(t)).join(', ');
    insights.push({ icon: '🆕', level: 'warn', text: `New need type this week: <strong>${labels}</strong>. This may indicate a change in condition.` });
  }

  // ── 5. Pain/fall frequency ──
  const painCalls = thisWeek.filter(c => (c.type||'').includes('pain'));
  if (painCalls.length >= 3) {
    insights.push({ icon: '😣', level: 'alert', text: `<strong>${painCalls.length} pain-related calls</strong> this week. Consider consulting a healthcare professional.` });
  }
  const fallCalls = thisWeek.filter(c => c.type === 'fall');
  if (fallCalls.length >= 2) {
    insights.push({ icon: '🚨', level: 'alert', text: `<strong>${fallCalls.length} falls detected</strong> this week. Fall risk assessment recommended.` });
  }

  // ── 6. Peak hours pattern ──
  if (thisWeek.length >= 5) {
    const hourBuckets = {};
    thisWeek.forEach(c => {
      if (!c.timestamp) return;
      const h = new Date(c.timestamp).getHours();
      hourBuckets[h] = (hourBuckets[h] || 0) + 1;
    });
    const peak = Object.entries(hourBuckets).sort((a,b) => b[1] - a[1])[0];
    if (peak && peak[1] >= 3) {
      const h = parseInt(peak[0]);
      const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h-12} PM`;
      const isNight = h >= 22 || h < 6;
      if (isNight) {
        insights.push({ icon: '🌙', level: 'warn', text: `<strong>${peak[1]} calls around ${label}</strong> — nighttime calls may indicate sleep disturbance or discomfort.` });
      } else {
        insights.push({ icon: '📊', level: '', text: `Peak call time: <strong>${label}</strong> (${peak[1]} calls this week).` });
      }
    }
  }

  // ── 7. Medication adherence ──
  const medMissed = thisWeek.filter(c => c.type === 'med-missed');
  const medTotal = thisWeek.filter(c => c.type === 'med-missed' || c.type === 'med-taken');
  if (medTotal.length >= 3) {
    const adherence = ((medTotal.length - medMissed.length) / medTotal.length * 100).toFixed(0);
    if (adherence < 80) {
      insights.push({ icon: '💊', level: 'alert', text: `Medication adherence is <strong>${adherence}%</strong> this week (${medMissed.length} missed). Consider reminding the patient or adjusting the schedule.` });
    } else if (adherence >= 95) {
      insights.push({ icon: '💊', level: 'good', text: `Excellent medication adherence: <strong>${adherence}%</strong> this week.` });
    }
  }

  // ── 8. Check-in misses ──
  const checkinMissed = thisWeek.filter(c => c.type === 'checkin-missed');
  if (checkinMissed.length >= 2) {
    insights.push({ icon: '👋', level: 'warn', text: `<strong>${checkinMissed.length} missed check-ins</strong> this week. Patient may not be responding to prompts.` });
  }

  // ── 9. Activity today vs usual ──
  if (today.length && thisWeek.length >= 7) {
    const dailyAvg = thisWeek.length / 7;
    if (today.length > dailyAvg * 2 && today.length >= 3) {
      insights.push({ icon: '🔥', level: 'warn', text: `<strong>${today.length} calls today</strong> — more than double the daily average (${dailyAvg.toFixed(1)}). Check on the patient.` });
    }
  }

  // ── 10. Positive: good week ──
  if (thisWeek.length && !insights.some(i => i.level === 'alert' || i.level === 'warn')) {
    const responseRate = thisWeek.filter(c => c.status === 'acknowledged').length;
    insights.push({ icon: '✅', level: 'good', text: `Good week — <strong>${thisWeek.length} calls</strong>, ${responseRate} responded. No concerns detected.` });
  }

  // Add routine learning insights (needs 2+ weeks of data)
  const routineInsights = _generateRoutineInsights(calls);
  insights.push(...routineInsights);

  // Add carer wellbeing insights
  const wellbeingInsights = _generateCarerWellbeingInsights(calls);
  insights.push(...wellbeingInsights);

  return insights;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function exportLogCSV() {
  if (!_allLogCalls.length) { toast(t('No calls to export')); return; }
  let calls = _allLogCalls;
  if (_logFilter === 'handoff') {
    calls = calls.filter(c => c._type === 'handoff');
  } else if (_logFilter !== 'all') {
    calls = calls.filter(c => c.fromName === _logFilter || c.ackName === _logFilter || c.from === _logFilter);
  }

  const rows = [['Date', 'Time', 'Room', 'Patient', 'Need Type', 'Message', 'Status', 'Carer', 'Response Time (s)', 'Acknowledged At']];
  calls.forEach(call => {
    const d = call.timestamp ? new Date(call.timestamp) : null;
    const date = d ? d.toLocaleDateString() : '';
    const time = d ? d.toLocaleTimeString() : '';
    const ackD = call.ackAt ? new Date(call.ackAt) : null;
    const ackTs = ackD ? ackD.toLocaleString() : '';
    const respSec = call.ackAt && call.timestamp ? Math.round((call.ackAt - call.timestamp) / 1000) : '';
    const types = call.type ? call.type.split(',').join('; ') : 'help';
    rows.push([
      date, time, call._room || '', call.fromName || '',
      types, call.message || '', call.status || '',
      call.ackName || '', respSec, ackTs,
    ]);
  });

  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const filterSuffix = _logFilter !== 'all' ? `_${_logFilter.replace(/\s+/g, '_')}` : '';
  a.download = `carecall_log${filterSuffix}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(t('CSV downloaded'));
}

// ════════════════════════════════════════════════════════════
//  SETTINGS
// ════════════════════════════════════════════════════════════
async function refreshSettings() {
  const nameDisplay = document.getElementById('s-name-display');
  if (nameDisplay) nameDisplay.textContent = S.name || '—';
  const roleLabels = { patient: '🛏️ Patient', carer: '🔔 Carer', family: '👨‍👩‍👧 Family' };
  const roleDisplay = document.getElementById('s-role-display');
  if (roleDisplay) roleDisplay.textContent = roleLabels[S.role] || S.role;
  // Mask personal code by default; user taps 👁️ to reveal.
  _codeRevealed = false;
  document.getElementById('s-personal-code').textContent = '•'.repeat((S.personalCode || '').length || 6);
  const phoneDisplay = document.getElementById('s-phone-display');
  if (phoneDisplay) phoneDisplay.textContent = S.phone || 'Not set';
  const avatarDisplay = document.getElementById('s-avatar-display');
  if (avatarDisplay) avatarDisplay.textContent = S.avatar || '👤';

  await _renderSettingsConnections();

  // ── Role-based settings visibility ──
  // Patient: sees everything (care plan, safety, location)
  // Carer: sees account, connections, notifications. Care plan + safety
  //        are shown but relabeled as "Patient Settings (remote)" since
  //        carers configure these on behalf of their patients.
  // Family: sees account, connections, notifications only. No care plan
  //         or safety settings (read-only observer role).
  const isPatient = S.role === 'patient';
  const isCarer = S.role === 'carer';
  const isFamily = S.role === 'family';

  // Care Plan group: patient + carer (carer manages remotely)
  const sgCare = document.getElementById('sg-care');
  if (sgCare) sgCare.style.display = (isPatient || isCarer) ? '' : 'none';

  // Safety group: patient + carer
  const sgSafety = document.getElementById('sg-safety');
  if (sgSafety) sgSafety.style.display = (isPatient || isCarer) ? '' : 'none';

  // Settings grid cards: show/hide based on role
  const scMeds = document.getElementById('sc-meds');
  if (scMeds) scMeds.style.display = (isPatient || isCarer) ? '' : 'none';
  const scCheckin = document.getElementById('sc-checkin');
  if (scCheckin) scCheckin.style.display = isPatient ? '' : 'none';
  const scSafety = document.getElementById('sc-safety');
  if (scSafety) scSafety.style.display = (isPatient || isCarer) ? '' : 'none';
  const scHealth = document.getElementById('sc-health');
  if (scHealth) scHealth.style.display = (isPatient || isCarer || isFamily) ? '' : 'none';

  // Patient-only sections within care plan
  const checkinSection = document.getElementById('s-checkin-section');
  const dmsSection = document.getElementById('s-dms-section');
  const medsSection = document.getElementById('s-meds-section');

  if (isPatient) {
    if (checkinSection) checkinSection.style.display = '';
    if (dmsSection) dmsSection.style.display = '';
    if (medsSection) medsSection.style.display = '';
  } else if (isCarer) {
    // Carers see meds (they can manage remotely via openCarerMedsManager)
    // but not check-in/DMS (those run on the patient's device only)
    if (checkinSection) checkinSection.style.display = 'none';
    if (dmsSection) dmsSection.style.display = 'none';
    if (medsSection) medsSection.style.display = 'none';
  } else {
    // Family sees none
    if (checkinSection) checkinSection.style.display = 'none';
    if (dmsSection) dmsSection.style.display = 'none';
    if (medsSection) medsSection.style.display = 'none';
  }

  // Remote Patient Settings section — carer only
  const remotePatientSection = document.getElementById('s-remote-patient-section');
  if (remotePatientSection) remotePatientSection.style.display = isCarer ? '' : 'none';

  // Security section — PIN state + account email
  const pinBtn = document.getElementById('s-pin-btn');
  if (pinBtn) pinBtn.textContent = _getPinHash() ? t('On') : t('Off');
  const emailRow = document.getElementById('s-email-row');
  const emailDisplay = document.getElementById('s-email-display');
  if (emailRow && auth.currentUser && auth.currentUser.email) {
    emailRow.style.display = '';
    if (emailDisplay) emailDisplay.textContent = auth.currentUser.email;
  } else if (emailRow) {
    emailRow.style.display = 'none';
  }

  // Populate care plan + safety sections (only if visible for this role)
  const locBtn = document.getElementById('s-location-btn');
  if (locBtn) locBtn.textContent = _locationSharing ? 'On' : 'Off';

  if (isPatient || isCarer) {
    _loadCheckinSettings();
    _refreshCheckinSettingsUI();
    _loadDmsSettings();
    const dmsBtn = document.getElementById('dms-threshold-btn');
    if (dmsBtn) dmsBtn.textContent = DMS_LABELS[DMS_THRESHOLDS.indexOf(_dmsThreshold)] || 'Off';
    _loadGeoFence();
    _refreshSafeZoneButton();
    _loadMedications();
    _renderMedsList();
    _refreshTtsButton();
  }

  // Emergency number row
  const emergEl = document.getElementById('s-emergency-number');
  if (emergEl) {
    emergEl.textContent = S.emergencyNumber || _getDefaultEmergencyNumber();
  } else {
    // Dynamically inject emergency number setting if not yet in DOM
    const checkinSection = document.getElementById('s-checkin-section');
    if (checkinSection) {
      const row = document.createElement('div');
      row.className = 'setting-row';
      row.setAttribute('data-filter', 'emergency number safety');
      row.innerHTML = `
        <div class="setting-label">🚨 ${t('Emergency Number')}</div>
        <button id="s-emergency-number" class="setting-btn" onclick="editEmergencyNumber()">${S.emergencyNumber || _getDefaultEmergencyNumber()}</button>`;
      checkinSection.parentNode.insertBefore(row, checkinSection);
    }
  }

  _updateLangDisplay();
  refreshNotifStatus();
}

function _moveCarerPriority(currentIdx, direction) {
  const order = JSON.parse(localStorage.getItem('carecall_carer_priority') || '[]');
  const newIdx = currentIdx + direction;
  if (newIdx < 0 || newIdx >= order.length) return;
  // Swap
  [order[currentIdx], order[newIdx]] = [order[newIdx], order[currentIdx]];
  localStorage.setItem('carecall_carer_priority', JSON.stringify(order));
  // Persist to Firebase so priority survives device changes
  if (S.uid) db.ref(`carecall/users/${S.uid}/carerPriority`).set(order).catch(() => {});
  refreshSettings();
}

function _moveCarerPriorityByUid(uid, direction) {
  let order = JSON.parse(localStorage.getItem('carecall_carer_priority') || '[]');
  const idx = order.indexOf(uid);
  if (idx === -1) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= order.length) return;
  [order[idx], order[newIdx]] = [order[newIdx], order[idx]];
  localStorage.setItem('carecall_carer_priority', JSON.stringify(order));
  if (S.uid) db.ref(`carecall/users/${S.uid}/carerPriority`).set(order).catch(() => {});
  refreshSettings();
}

async function addConnectionFromSettings() {
  const code = document.getElementById('add-room-input').value.trim().toUpperCase();
  const err  = document.getElementById('add-room-err');
  if (code.length < 4) { err.textContent = t('Please enter your pair code'); return; }
  err.textContent = '';
  const result = await connectToCode(code);
  if (result.error) { err.textContent = result.error; return; }
  document.getElementById('add-room-input').value = '';
  refreshSettings();
  if (result.alreadyConnected) toast(t('Already connected to') + ' ' + result.name);
  else if (result.pending) toast(t('Pair request sent to') + ' ' + result.name + ' — ' + t('waiting for approval'));
  else toast(t('Connected to') + ' ' + result.name + '!');
}

async function removeConnection(roomId) {
  // Under Phase 0 rules we can't modify the other user's rooms list
  // (users/{uid}/rooms is self-write only). The other user will discover
  // the room is gone on their next boot when the member read returns
  // empty — it cleans up organically. We just remove ourselves.
  await leaveRoom(roomId);
  S.rooms = S.rooms.filter(r => r !== roomId);
  if (S.activeRoom === roomId) S.activeRoom = S.rooms[0] || null;
  // Update our own Firebase rooms list
  await _saveUserRooms(S.uid, S.rooms);
  saveState();
  await refreshSettings();
  if (S.role === 'patient') { startPatient(); renderCarersList(); }
  else if (S.role === 'carer') startCarer();
  toast(t('Connection removed'));
}

async function refreshNotifStatus() {
  const el = document.getElementById('s-notif-status');
  if (!el) return;
  if (!('Notification' in window)) { el.textContent = '❌ Not supported in this browser'; return; }
  if (Notification.permission === 'denied') { el.textContent = '❌ Blocked — enable in browser settings'; return; }
  if (Notification.permission === 'default') { el.textContent = '⚠️ Not yet granted'; return; }
  // Permission is 'granted'
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    el.textContent = sub ? '✅ Active' : '⚠️ No push subscription';
  } catch(e) {
    el.textContent = '⚠️ ' + e.message;
  }
}

async function testNotification() {
  console.log('[Test] Starting notification test…');
  try {
    // 1. Check permission
    if (Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast(t('Notification permission denied')); return; }
    }
    // 2. Clear any previous test notifications
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.getNotifications({ tag: 'carecall-test' });
    existing.forEach(n => n.close());

    // 3. Show notification via SW registration (same path as push handler)
    const now = new Date().toLocaleTimeString();
    await reg.showNotification('CareCall Test', {
      body: `Test at ${now} — if you see this, notifications work!`,
      icon: BASE_PATH + '/icon-192.svg',
      badge: BASE_PATH + '/icon-192.svg',
      vibrate: [300, 100, 300],
      requireInteraction: true,
      tag: 'carecall-test',
      renotify: true,
    });
    console.log('[Test] showNotification() succeeded');
    toast(t('Test notification sent. If nothing appears, check device notification settings.'));
  } catch(e) {
    console.error('[Test] Notification failed:', e);
    toast(t('Notification failed') + ': ' + e.message);
  }
}

function editName() {
  const name = prompt(t('Your name') + ':', S.name);
  if (!name || !name.trim()) return;
  S.name = name.trim();
  saveState();
  // Update in all rooms + user profile
  S.rooms.forEach(code => {
    db.ref(`carecall/rooms/${code}/members/${S.uid}/name`).set(S.name);
  });
  syncUserProfile();
  refreshSettings();
  toast(t('Name updated'));
}

function editPhone() {
  const phone = prompt(t('Phone Number') + ' (' + t('with country code') + '):', S.phone || '');
  if (phone === null) return; // cancelled
  S.phone = phone.trim() || null;
  saveState();
  // Update in all rooms + user profile
  S.rooms.forEach(code => {
    if (S.phone) {
      db.ref(`carecall/rooms/${code}/members/${S.uid}/phone`).set(S.phone);
    } else {
      db.ref(`carecall/rooms/${code}/members/${S.uid}/phone`).remove();
    }
  });
  syncUserProfile();
  refreshSettings();
  toast(S.phone ? t('Phone number saved') : t('Phone number removed'));
}

const AVATAR_OPTIONS = ['👤','👩','👨','👵','👴','👩‍🦳','👨‍🦳','👩‍🦰','👨‍🦰','👱‍♀️','👱‍♂️','👩‍⚕️','👨‍⚕️','🧑‍⚕️','👼','🧓','🤶','🎅','🦸‍♀️','🦸‍♂️','😊','😎','🥰','🤗','💪','❤️','⭐','🌻','🌈','🐱','🐶','🦋'];

function openSettingsSheet(id) {
  const sheet = document.getElementById(id);
  if (sheet) {
    sheet.classList.add('open');
    _syncSettingsToggles();
    // Re-render connections when the connections sheet is opened,
    // in case the async render from refreshSettings hasn't completed yet.
    if (id === 'sh-connections') _renderSettingsConnections();
    sheet._backdropHandler = (e) => {
      if (e.target === sheet) closeSettingsSheet(id);
    };
    sheet.addEventListener('click', sheet._backdropHandler);
  }
}
function closeSettingsSheet(id) {
  const sheet = document.getElementById(id);
  if (sheet) {
    sheet.classList.remove('open');
    if (sheet._backdropHandler) {
      sheet.removeEventListener('click', sheet._backdropHandler);
      sheet._backdropHandler = null;
    }
  }
}
function _syncSettingsToggles() {
  const ft = document.getElementById('fall-toggle');
  const sft = document.getElementById('sh-fall-toggle');
  if (ft && sft) {
    sft.classList.toggle('active', ft.classList.contains('active'));
  }
  const vt = document.getElementById('voice-toggle');
  const svt = document.getElementById('sh-voice-toggle');
  if (vt && svt) {
    svt.classList.toggle('active', vt.classList.contains('active'));
  }
  const fsl = document.getElementById('fall-sensitivity-label');
  const sfsl = document.getElementById('sh-fall-sensitivity');
  if (fsl && sfsl) sfsl.textContent = fsl.textContent;
  const vdl = document.getElementById('voice-dur-label');
  const svdl = document.getElementById('sh-voice-dur');
  if (vdl && svdl) svdl.textContent = vdl.textContent;
  const sfs = document.getElementById('sh-fall-status');
  if (sfs && ft) sfs.textContent = ft.classList.contains('active') ? 'Active' : 'Off';
  const svs = document.getElementById('sh-voice-status');
  if (svs && vt) svs.textContent = vt.classList.contains('active') ? 'Active' : 'Off';
}

function toggleSettingsGroup(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const wasOpen = el.classList.contains('open');
  el.classList.toggle('open');
  // After expanding, scroll so the header is at the top of the viewport
  // if the section extends below the fold. Settings screen is the
  // scrollable container (.screen with overflow-y:auto). Use two RAFs
  // to wait for the open animation to lay out properly.
  if (!wasOpen) {
    const screen = document.getElementById('s-settings');
    if (!screen) return;
    const scrollToHeader = () => {
      const header = el.querySelector('.settings-group-header');
      if (!header) return;
      const hRect = header.getBoundingClientRect();
      const sRect = screen.getBoundingClientRect();
      const bodyEl = el.querySelector('.settings-group-body');
      const bodyBottom = bodyEl
        ? bodyEl.getBoundingClientRect().bottom
        : hRect.bottom;
      // Only act if the section extends below the visible bottom
      if (bodyBottom > sRect.bottom - 6) {
        // Align the header to the top of the scrollable viewport
        const delta = hRect.top - sRect.top - 8;
        screen.scrollTo({ top: screen.scrollTop + delta, behavior: 'smooth' });
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(scrollToHeader));
  }
}

function _filterSettings(query) {
  const q = (query || '').toLowerCase().trim();
  const groups = document.querySelectorAll('#s-settings .settings-group');
  groups.forEach(group => {
    if (!q) { group.style.display = ''; return; }
    const text = group.textContent.toLowerCase();
    group.style.display = text.includes(q) ? '' : 'none';
  });
}

function toggleAvatarPicker() {
  const picker = document.getElementById('avatar-picker');
  picker.classList.toggle('show');
  if (picker.classList.contains('show') && !picker.children.length) {
    _renderAvatarOptions();
  }
}

function _renderAvatarOptions() {
  const picker = document.getElementById('avatar-picker');
  picker.innerHTML = '';
  AVATAR_OPTIONS.forEach(emoji => {
    const btn = document.createElement('button');
    btn.className = `avatar-option${S.avatar === emoji ? ' selected' : ''}`;
    btn.textContent = emoji;
    btn.onclick = () => _selectAvatar(emoji);
    picker.appendChild(btn);
  });
}

function _selectAvatar(emoji) {
  S.avatar = emoji;
  saveState();
  // Update in all rooms + profile
  S.rooms.forEach(code => {
    db.ref(`carecall/rooms/${code}/members/${S.uid}/avatar`).set(emoji);
  });
  syncUserProfile();
  document.getElementById('s-avatar-display').textContent = emoji;
  document.getElementById('avatar-picker').classList.remove('show');
  toast(t('Avatar updated'));
}

function resetApp() {
  if (!confirm(t('This will clear all saved data and restart setup. Are you sure?'))) return;
  // Leave all rooms
  S.rooms.forEach(code => {
    db.ref(`carecall/rooms/${code}/members/${S.uid}`).remove();
  });
  // Clean up user profile and code index
  if (S.personalCode) db.ref(`carecall/codeIndex/${S.personalCode}`).remove();
  if (S.uid) db.ref(`carecall/users/${S.uid}`).remove();
  localStorage.removeItem('carecall_v4');
  localStorage.removeItem('carecall_v5');
  location.reload();
}

// ════════════════════════════════════════════════════════════
//  SHARED HELPERS
// ════════════════════════════════════════════════════════════
function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ════════════════════════════════════════════════════════════
//  INTERNATIONALIZATION (i18n)
// ════════════════════════════════════════════════════════════
const LANGS = ['en', 'es', 'zh', 'hi', 'ar', 'he', 'ru', 'fr', 'am'];
const LANG_NAMES = {
  en: 'English', es: 'Español', zh: '中文', hi: 'हिन्दी', ar: 'العربية',
  he: 'עברית', ru: 'Русский', fr: 'Français', am: 'አማርኛ'
};
const LANG_ENGLISH_NAMES = {
  en: 'English', es: 'Spanish', zh: 'Chinese', hi: 'Hindi', ar: 'Arabic',
  he: 'Hebrew', ru: 'Russian', fr: 'French', am: 'Amharic'
};
let _currentLang = localStorage.getItem('carecall_lang') || 'en';

// Translation dictionary — English is the key, other languages are values.
// Only non-English translations are stored; English falls through to the key itself.
const I18N = {
  // ── Core patient UI ──
  'Call Carer':       { es:'Llamar Cuidador', zh:'呼叫护理员', hi:'केयरर को कॉल करें', ar:'اتصل بالمُعتني', he:'התקשר למטפל' },
  'Not Ready':        { es:'No Listo', zh:'未就绪', hi:'तैयार नहीं', ar:'غير جاهز', he:'לא מוכן' },
  'Calling…':         { es:'Llamando…', zh:'呼叫中…', hi:'कॉल कर रहे हैं…', ar:'جارٍ الاتصال…', he:'מתקשר…' },
  'Coming!':          { es:'¡Viene!', zh:'正在来！', hi:'आ रहे हैं!', ar:'قادم!', he:'בדרך!' },
  'Connecting…':      { es:'Conectando…', zh:'连接中…', hi:'कनेक्ट हो रहा है…', ar:'جارٍ الاتصال…', he:'מתחבר…' },
  'Carer online':     { es:'Cuidador en línea', zh:'护理员在线', hi:'केयरर ऑनलाइन', ar:'المُعتني متصل', he:'מטפל מחובר' },
  'Carer notified by push': { es:'Cuidador notificado', zh:'已推送通知护理员', hi:'केयरर को सूचित किया गया', ar:'تم إشعار المُعتني', he:'המטפל יקבל התראה' },
  'Calling carer…':   { es:'Llamando cuidador…', zh:'正在呼叫护理员…', hi:'केयरर को कॉल कर रहे हैं…', ar:'جارٍ الاتصال بالمُعتني…', he:'מתקשר למטפל…' },
  'Already calling…': { es:'Ya llamando…', zh:'正在呼叫中…', hi:'पहले से कॉल कर रहे हैं…', ar:'جارٍ الاتصال بالفعل…', he:'כבר מתקשר…' },
  'Night mode is for patients only': { es:'El modo nocturno es solo para pacientes', zh:'夜间模式仅适用于患者', hi:'नाइट मोड केवल रोगियों के लिए', ar:'الوضع الليلي للمرضى فقط', he:'מצב לילה מיועד למטופלים בלבד' },
  'Exit Bedside Mode': { es:'Salir del modo mesilla', zh:'退出床头模式', hi:'बेडसाइड मोड से बाहर निकलें', ar:'الخروج من وضع السرير', he:'יציאה ממצב שידה' },
  'Swipe down to exit': { es:'Desliza hacia abajo para salir', zh:'下滑退出', hi:'बाहर निकलने के लिए नीचे स्वाइप करें', ar:'اسحب لأسفل للخروج', he:'החלק למטה ליציאה' },
  'Already have an account? Sign in': { es:'¿Ya tienes cuenta? Iniciar sesión', zh:'已有账户？登录', hi:'पहले से खाता है? साइन इन करें', ar:'لديك حساب بالفعل؟ تسجيل الدخول', he:'כבר יש לך חשבון? התחבר' },
  'more':                { es:'más', zh:'更多', hi:'और', ar:'المزيد', he:'עוד' },
  'Help on the way':  { es:'Ayuda en camino', zh:'帮助在路上', hi:'मदद आ रही है', ar:'المساعدة في الطريق', he:'עזרה בדרך' },
  // ── Needs ──
  'What do you need?':{ es:'¿Qué necesitas?', zh:'你需要什么？', hi:'आपको क्या चाहिए?', ar:'ماذا تحتاج؟', he:'מה אתה צריך?' },
  'Water':            { es:'Agua', zh:'水', hi:'पानी', ar:'ماء', he:'מים' },
  'Medication':       { es:'Medicación', zh:'药物', hi:'दवाई', ar:'دواء', he:'תרופה' },
  'Food':             { es:'Comida', zh:'食物', hi:'खाना', ar:'طعام', he:'אוכל' },
  'Toilet':           { es:'Baño', zh:'厕所', hi:'शौचालय', ar:'مرحاض', he:'שירותים' },
  'Pain':             { es:'Dolor', zh:'疼痛', hi:'दर्द', ar:'ألم', he:'כאב' },
  'Message':          { es:'Mensaje', zh:'消息', hi:'संदेश', ar:'رسالة', he:'הודעה' },
  'Voice Note':       { es:'Nota de Voz', zh:'语音备注', hi:'वॉयस नोट', ar:'ملاحظة صوتية', he:'הודעה קולית' },
  // ── Emergency ──
  'SOS':              { es:'SOS', zh:'SOS', hi:'SOS', ar:'SOS', he:'SOS' },
  'Hold 3s':          { es:'Mantén 3s', zh:'按住3秒', hi:'3 सेकंड दबाएं', ar:'اضغط 3 ثوانٍ', he:'החזק 3 שניות' },
  'Fall Detected':    { es:'Caída Detectada', zh:'检测到跌倒', hi:'गिरावट का पता चला', ar:'تم اكتشاف سقوط', he:'זוהתה נפילה' },
  'Emergency Alert':  { es:'Alerta de Emergencia', zh:'紧急警报', hi:'आपातकालीन अलर्ट', ar:'تنبيه طوارئ', he:'התראת חירום' },
  'Calling your carer in': { es:'Llamando a tu cuidador en', zh:'将在以下时间呼叫护理员', hi:'आपके केयरर को कॉल करना', ar:'الاتصال بالمُعتني في', he:'מתקשר למטפל בעוד' },
  "I'm OK — Cancel":  { es:'Estoy Bien — Cancelar', zh:'我没事 — 取消', hi:'मैं ठीक हूँ — रद्द करें', ar:'أنا بخير — إلغاء', he:'אני בסדר — ביטול' },
  'Fall Detection':   { es:'Detección de Caídas', zh:'跌倒检测', hi:'गिरावट पहचान', ar:'كشف السقوط', he:'זיהוי נפילות' },
  // ── Check-in ──
  'Are you OK?':      { es:'¿Estás bien?', zh:'你还好吗？', hi:'क्या आप ठीक हैं?', ar:'هل أنت بخير؟', he:'הכל בסדר?' },
  'Routine check-in': { es:'Control rutinario', zh:'例行检查', hi:'नियमित जांच', ar:'فحص روتيني', he:'בדיקה שגרתית' },
  "I'm OK":           { es:'Estoy Bien', zh:'我没事', hi:'मैं ठीक हूँ', ar:'أنا بخير', he:'אני בסדר' },
  'Need Help':        { es:'Necesito Ayuda', zh:'需要帮助', hi:'मदद चाहिए', ar:'أحتاج مساعدة', he:'צריך עזרה' },
  // ── Medication ──
  'Medication Time':  { es:'Hora de Medicación', zh:'服药时间', hi:'दवाई का समय', ar:'وقت الدواء', he:'זמן תרופה' },
  'Medication Reminder': { es:'Recordatorio de medicación', zh:'服药提醒', hi:'दवाई अनुस्मारक', ar:'تذكير بالدواء', he:'תזכורת תרופה' },
  'Take your medication': { es:'Toma tu medicación', zh:'请服用药物', hi:'अपनी दवाई लें', ar:'تناول دواءك', he:'קח את התרופה' },
  'Taken ✓':          { es:'Tomada ✓', zh:'已服用 ✓', hi:'ले ली ✓', ar:'تم تناوله ✓', he:'נלקחה ✓' },
  'Snooze 15 min':    { es:'Posponer 15 min', zh:'稍后提醒 15 分钟', hi:'15 मिनट बाद याद दिलाएं', ar:'تأجيل 15 دقيقة', he:'דחייה 15 דק׳' },
  'Skip':             { es:'Omitir', zh:'跳过', hi:'छोड़ें', ar:'تخطي', he:'דלג' },
  'Enter medication name': { es:'Introduce el nombre', zh:'输入药品名称', hi:'दवाई का नाम दर्ज करें', ar:'أدخل اسم الدواء', he:'הזן שם תרופה' },
  'Set a time':       { es:'Establece una hora', zh:'设置时间', hi:'समय निर्धारित करें', ar:'حدّد وقتًا', he:'קבע שעה' },
  'As needed':        { es:'Según necesidad', zh:'按需', hi:'जरूरत पड़ने पर', ar:'عند الحاجة', he:'לפי הצורך' },
  'Every':            { es:'Cada', zh:'每', hi:'हर', ar:'كل', he:'כל' },
  'Remove':           { es:'Eliminar', zh:'移除', hi:'हटाएं', ar:'إزالة', he:'הסר' },
  'Carer alerted if not taken in': { es:'Cuidador alertado si no se toma en', zh:'若未服用将通知看护者', hi:'न लेने पर देखभालकर्ता को सूचित', ar:'سيتم تنبيه المعتني إذا لم تتناوله خلال', he:'תישלח התראה למטפל אם לא נלקחה בתוך' },
  'Missed medication': { es:'Medicación perdida', zh:'漏服药物', hi:'छूटी दवाई', ar:'دواء فائت', he:'תרופה הוחמצה' },
  'Skipped medication': { es:'Medicación omitida', zh:'跳过的药物', hi:'छोड़ी गई दवाई', ar:'دواء تم تخطيه', he:'תרופה שדולגה' },
  'logged as taken':  { es:'registrada como tomada', zh:'已记录为服用', hi:'ली गई के रूप में दर्ज', ar:'سُجِّل كمُتناوَل', he:'תועדה כנלקחה' },
  'snoozed 15 min':   { es:'pospuesta 15 min', zh:'已延后 15 分钟', hi:'15 मिनट के लिए टाली', ar:'تم التأجيل 15 دقيقة', he:'נדחתה ב-15 דק׳' },
  'skipped':          { es:'omitida', zh:'已跳过', hi:'छोड़ दी', ar:'تم تخطيها', he:'דולגה' },
  'max snoozes reached, marked as missed': { es:'máx. posposiciones alcanzado, marcado como perdido', zh:'已达最大延后次数,标记为漏服', hi:'अधिकतम स्नूज़ पहुंच गया, छूटी के रूप में चिह्नित', ar:'بلغ الحد الأقصى للتأجيلات، تم وضع علامة فائتة', he:'הגעת למקסימום דחיות — סומנה כהוחמצה' },
  'was already logged recently': { es:'ya se registró recientemente', zh:'最近已记录', hi:'हाल ही में दर्ज किया गया', ar:'تم تسجيله مؤخرًا', he:'כבר תועדה לאחרונה' },
  'Log again?':       { es:'¿Registrar de nuevo?', zh:'再次记录?', hi:'फिर से दर्ज करें?', ar:'هل تريد تسجيلها مجددًا؟', he:'לתעד שוב?' },
  // ── Medication editor ──
  '+ Add medication': { es:'+ Añadir medicación', zh:'+ 添加药物', hi:'+ दवाई जोड़ें', ar:'+ إضافة دواء', he:'+ הוסף תרופה' },
  'New medication':   { es:'Nueva medicación', zh:'新药物', hi:'नई दवाई', ar:'دواء جديد', he:'תרופה חדשה' },
  'Edit medication':  { es:'Editar medicación', zh:'编辑药物', hi:'दवाई संपादित करें', ar:'تعديل الدواء', he:'ערוך תרופה' },
  'Medication added': { es:'Medicación añadida', zh:'药物已添加', hi:'दवाई जोड़ी गई', ar:'تمت إضافة الدواء', he:'התרופה נוספה' },
  'Medication updated': { es:'Medicación actualizada', zh:'药物已更新', hi:'दवाई अपडेट की गई', ar:'تم تحديث الدواء', he:'התרופה עודכנה' },
  'Name':             { es:'Nombre', zh:'名称', hi:'नाम', ar:'الاسم', he:'שם' },
  'Active ingredient': { es:'Principio activo', zh:'有效成分', hi:'सक्रिय घटक', ar:'المادة الفعّالة', he:'חומר פעיל' },
  'for interaction checks': { es:'para comprobar interacciones', zh:'用于相互作用检查', hi:'पारस्परिक क्रिया जाँच के लिए', ar:'لفحص التفاعلات', he:'לבדיקת אינטראקציות' },
  'e.g. Paracetamol (for Acamol)': {
    es:'p. ej. Paracetamol (para Acamol)',
    zh:'例如对乙酰氨基酚 (Acamol 的有效成分)',
    hi:'जैसे पैरासिटामोल (Acamol के लिए)',
    ar:'مثال: باراسيتامول (للأسيكامول)',
    he:'למשל פרצטמול (עבור אקמול)'
  },
  'Looks like':       { es:'Parece', zh:'看起来是', hi:'यह शायद', ar:'يبدو أنه', he:'נראה שזה' },
  'use as active ingredient': { es:'usar como principio activo', zh:'用作有效成分', hi:'सक्रिय घटक के रूप में उपयोग करें', ar:'استخدم كمادة فعّالة', he:'השתמש כחומר פעיל' },
  'No warnings from our built-in checks. This is a limited rule set — confirm the full list with a pharmacist or doctor.': {
    es: 'Nuestras comprobaciones integradas no devuelven avisos. Es un conjunto limitado — confirma con un farmacéutico o médico.',
    zh: '内置检查未发现警告。这是一个有限的规则集 — 请与药剂师或医生确认。',
    hi: 'अंतर्निहित जाँच में कोई चेतावनी नहीं मिली। यह सीमित नियम है — फार्मासिस्ट या डॉक्टर से पुष्टि करें।',
    ar: 'لا توجد تحذيرات من الفحوصات المضمنة. هذه مجموعة قواعد محدودة — راجع قائمة الأدوية كاملة مع الصيدلي أو الطبيب.',
    he: 'לא נמצאו התראות בבדיקות המובנות. זהו מאגר כללים מוגבל — אמת את הרשימה המלאה עם רוקח או רופא.'
  },
  'Dose':             { es:'Dosis', zh:'剂量', hi:'खुराक', ar:'الجرعة', he:'מינון' },
  'Unit':             { es:'Unidad', zh:'单位', hi:'इकाई', ar:'الوحدة', he:'יחידה' },
  'Instructions':     { es:'Instrucciones', zh:'说明', hi:'निर्देश', ar:'التعليمات', he:'הוראות' },
  'optional':         { es:'opcional', zh:'可选', hi:'वैकल्पिक', ar:'اختياري', he:'אופציונלי' },
  'e.g. Metformin':   { es:'ej. Metformina', zh:'例如:二甲双胍', hi:'जैसे: मेटफॉर्मिन', ar:'مثال: ميتفورمين', he:'לדוגמה: מטפורמין' },
  'e.g. with food':   { es:'ej. con comida', zh:'例如:随餐', hi:'जैसे: भोजन के साथ', ar:'مثال: مع الطعام', he:'לדוגמה: עם אוכל' },
  'Schedule':         { es:'Horario', zh:'时间安排', hi:'समय-सूची', ar:'الجدول', he:'מועדים' },
  'At specific times': { es:'En horarios específicos', zh:'在特定时间', hi:'निश्चित समय पर', ar:'في أوقات محددة', he:'בשעות קבועות' },
  'Certain days only': { es:'Solo ciertos días', zh:'仅在特定日期', hi:'केवल कुछ दिन', ar:'في أيام محددة فقط', he:'בימים מסוימים בלבד' },
  'Every N hours':    { es:'Cada N horas', zh:'每 N 小时', hi:'हर N घंटे', ar:'كل N ساعة', he:'כל N שעות' },
  'As needed (no reminder)': { es:'Según necesidad (sin recordatorio)', zh:'按需 (无提醒)', hi:'जरूरत पड़ने पर (कोई रिमाइंडर नहीं)', ar:'عند الحاجة (بدون تذكير)', he:'לפי הצורך (ללא תזכורת)' },
  'Reminder times':   { es:'Horarios de recordatorio', zh:'提醒时间', hi:'रिमाइंडर समय', ar:'أوقات التذكير', he:'זמני תזכורת' },
  'Add time':         { es:'Añadir hora', zh:'添加时间', hi:'समय जोड़ें', ar:'إضافة وقت', he:'הוסף זמן' },
  'Tap + to add a time.': { es:'Toca + para añadir una hora.', zh:'点击 + 添加时间。', hi:'समय जोड़ने के लिए + दबाएं।', ar:'اضغط + لإضافة وقت.', he:'הקש + כדי להוסיף זמן.' },
  'Remove time':      { es:'Eliminar hora', zh:'移除时间', hi:'समय हटाएं', ar:'إزالة الوقت', he:'הסר זמן' },
  'Days of week':     { es:'Días de la semana', zh:'星期几', hi:'सप्ताह के दिन', ar:'أيام الأسبوع', he:'ימים בשבוע' },
  'Every (hours)':    { es:'Cada (horas)', zh:'每 (小时)', hi:'हर (घंटे)', ar:'كل (ساعات)', he:'כל (שעות)' },
  'First dose':       { es:'Primera dosis', zh:'首次剂量', hi:'पहली खुराक', ar:'أول جرعة', he:'מנה ראשונה' },
  'No automatic reminder. Log a dose manually when you take it.': {
    es:'Sin recordatorio automático. Registra cada dosis manualmente al tomarla.',
    zh:'无自动提醒。请在服药时手动记录。',
    hi:'कोई स्वचालित रिमाइंडर नहीं। जब आप लें, तब मैन्युअली रिकॉर्ड करें।',
    ar:'لا يوجد تذكير تلقائي. سجِّل الجرعة يدويًا عند تناولها.',
    he:'אין תזכורת אוטומטית. תעד מנה ידנית כשאתה לוקח אותה.'
  },
  'No automatic reminder': { es:'Sin recordatorio automático', zh:'无自动提醒', hi:'कोई स्वचालित रिमाइंडर नहीं', ar:'لا يوجد تذكير تلقائي', he:'אין תזכורת אוטומטית' },
  'How long the reminder stays on screen': {
    es:'Cuánto tiempo permanece el recordatorio en pantalla',
    zh:'提醒在屏幕上停留多长时间',
    hi:'रिमाइंडर स्क्रीन पर कितनी देर रहता है',
    ar:'مدة بقاء التذكير على الشاشة',
    he:'כמה זמן התזכורת נשארת על המסך'
  },
  'e.g. Paracetamol':  { es:'p. ej. Paracetamol', zh:'例如对乙酰氨基酚', hi:'जैसे पैरासिटामोल', ar:'مثال: باراسيتامول', he:'לדוגמה: פרצטמול' },
  'Save':             { es:'Guardar', zh:'保存', hi:'सहेजें', ar:'حفظ', he:'שמור' },
  'Cancel':           { es:'Cancelar', zh:'取消', hi:'रद्द', ar:'إلغاء', he:'בטל' },
  'Remove this medication?': { es:'¿Eliminar esta medicación?', zh:'移除此药物?', hi:'यह दवाई हटाएं?', ar:'إزالة هذا الدواء؟', he:'להסיר תרופה זו?' },
  'Remove medication': { es:'Eliminar medicación', zh:'移除药物', hi:'दवाई हटाएं', ar:'إزالة الدواء', he:'הסר תרופה' },
  'Add at least one time.': { es:'Añade al menos una hora.', zh:'请至少添加一个时间。', hi:'कम से कम एक समय जोड़ें।', ar:'أضف وقتًا واحدًا على الأقل.', he:'הוסף לפחות זמן אחד.' },
  'Select at least one day.': { es:'Selecciona al menos un día.', zh:'请至少选择一天。', hi:'कम से कम एक दिन चुनें।', ar:'اختر يومًا واحدًا على الأقل.', he:'בחר לפחות יום אחד.' },
  'from':             { es:'desde', zh:'从', hi:'से', ar:'من', he:'מ-' },
  'Sun':{es:'Dom',zh:'日',hi:'रवि',ar:'أحد',he:'א'},
  'Mon':{es:'Lun',zh:'一',hi:'सोम',ar:'إثنين',he:'ב'},
  'Tue':{es:'Mar',zh:'二',hi:'मंगल',ar:'ثلاثاء',he:'ג'},
  'Wed':{es:'Mié',zh:'三',hi:'बुध',ar:'أربعاء',he:'ד'},
  'Thu':{es:'Jue',zh:'四',hi:'गुरु',ar:'خميس',he:'ה'},
  'Fri':{es:'Vie',zh:'五',hi:'शुक्र',ar:'جمعة',he:'ו'},
  'Sat':{es:'Sáb',zh:'六',hi:'शनि',ar:'سبت',he:'ש'},
  // ── Carer-proxy medication management ──
  'Patient medications': { es:'Medicamentos del paciente', zh:'患者药物', hi:'मरीज की दवाइयाँ', ar:'أدوية المريض', he:'תרופות המטופל' },
  'No connected patients': { es:'No hay pacientes conectados', zh:'没有已连接的患者', hi:'कोई जुड़ा हुआ मरीज नहीं', ar:'لا يوجد مرضى متصلون', he:'אין מטופלים מחוברים' },
  'Select a patient': { es:'Selecciona un paciente', zh:'选择一位患者', hi:'मरीज चुनें', ar:'اختر مريضًا', he:'בחר מטופל' },
  'Medications':      { es:'Medicamentos', zh:'药物', hi:'दवाइयाँ', ar:'الأدوية', he:'תרופות' },
  'No medications configured.': { es:'No hay medicamentos configurados.', zh:'未配置药物。', hi:'कोई दवाई नहीं जोड़ी गई है।', ar:'لم تُضَف أدوية.', he:'לא הוגדרו תרופות.' },
  'Managing for':     { es:'Gestionando para', zh:'管理', hi:'के लिए प्रबंधन', ar:'تدار نيابةً عن', he:'ניהול עבור' },
  'Medication removed': { es:'Medicación eliminada', zh:'药物已移除', hi:'दवाई हटाई गई', ar:'تمت إزالة الدواء', he:'התרופה הוסרה' },
  'Save failed':      { es:'No se pudo guardar', zh:'保存失败', hi:'सहेजने में विफल', ar:'فشل الحفظ', he:'השמירה נכשלה' },
  'Close':            { es:'Cerrar', zh:'关闭', hi:'बंद', ar:'إغلاق', he:'סגור' },
  // ── Refill tracking ──
  'Pills in stock':   { es:'Existencias', zh:'库存数量', hi:'स्टॉक में गोलियाँ', ar:'الكمية المتوفرة', he:'כדורים במלאי' },
  'Alert when below': { es:'Alertar por debajo de', zh:'低于此数量时提醒', hi:'इस से कम होने पर सूचित करें', ar:'تنبيه عندما تقل عن', he:'התרעה כשנשאר פחות מ' },
  'left':             { es:'restantes', zh:'剩余', hi:'बचे', ar:'متبقٍّ', he:'נותרו' },
  'Refill':           { es:'Reponer', zh:'补货', hi:'फिर से भरें', ar:'تجديد', he:'חידוש' },
  'Refill needed':    { es:'Reposición necesaria', zh:'需要补货', hi:'फिर से भरने की जरूरत', ar:'يحتاج إلى تجديد', he:'נדרש חידוש' },
  // ── Response window ──
  'Response window':  { es:'Ventana de respuesta', zh:'响应窗口', hi:'प्रतिक्रिया विंडो', ar:'نافذة الاستجابة', he:'חלון תגובה' },
  '5 min (strict)':   { es:'5 min (estricto)', zh:'5 分钟 (严格)', hi:'5 मिनट (सख्त)', ar:'5 دقائق (صارم)', he:'5 דק׳ (קפדני)' },
  'min':              { es:'min', zh:'分钟', hi:'मिनट', ar:'دقيقة', he:'דק׳' },
  'hour':             { es:'hora', zh:'小时', hi:'घंटा', ar:'ساعة', he:'שעה' },
  'hours':            { es:'horas', zh:'小时', hi:'घंटे', ar:'ساعات', he:'שעות' },
  'How long the reminder stays responsive. Carer is alerted only after this window closes.': {
    es: 'Cuánto tiempo permanece activo el recordatorio. El cuidador es alertado solo después de que se cierre esta ventana.',
    zh: '提醒保持响应的时间。窗口关闭后才通知看护者。',
    hi: 'रिमाइंडर कितनी देर सक्रिय रहता है। केवल विंडो बंद होने के बाद ही देखभालकर्ता को सूचित किया जाता है।',
    ar: 'مدة بقاء التذكير مستجيبًا. يتم تنبيه المعتني فقط بعد إغلاق هذه النافذة.',
    he: 'משך הזמן שהתזכורת נשארת פעילה. המטפל יקבל התראה רק לאחר סגירת החלון הזה.'
  },
  // ── Per-med photo ──
  'Photo':            { es:'Foto', zh:'照片', hi:'फोटो', ar:'صورة', he:'תמונה' },
  'Photos':           { es:'Fotos', zh:'照片', hi:'फोटो', ar:'الصور', he:'תמונות' },
  'Add photo':        { es:'Añadir foto', zh:'添加照片', hi:'फोटो जोड़ें', ar:'إضافة صورة', he:'הוסף תמונה' },
  'Take photo':       { es:'Hacer foto', zh:'拍照', hi:'फोटो लें', ar:'التقاط صورة', he:'צלם תמונה' },
  'Choose from gallery': { es:'Elegir de la galería', zh:'从相册选择', hi:'गैलरी से चुनें', ar:'اختر من المعرض', he:'בחר מהגלריה' },
  // ── Spoken reminder (TTS) ──
  'Spoken reminder':  { es:'Recordatorio hablado', zh:'语音提醒', hi:'बोलकर याद दिलाना', ar:'تذكير منطوق', he:'תזכורת מדוברת' },
  "Read the medication name aloud when it's time": {
    es:'Leer el nombre del medicamento en voz alta cuando sea la hora',
    zh:'到时间时朗读药物名称',
    hi:'जब समय हो तो दवाई का नाम बोलकर सुनाएं',
    ar:'قراءة اسم الدواء بصوت عالٍ عند حلول الموعد',
    he:'הקראה של שם התרופה כשמגיע הזמן'
  },
  'Time to take':     { es:'Hora de tomar', zh:'现在该服用', hi:'लेने का समय है', ar:'حان وقت تناول', he:'זמן לקחת' },
  // ── Adherence PDF export ──
  'Adherence report (PDF)': { es:'Informe de adherencia (PDF)', zh:'依从性报告 (PDF)', hi:'अनुपालन रिपोर्ट (PDF)', ar:'تقرير الالتزام (PDF)', he:'דוח היענות (PDF)' },
  'Preparing report…': { es:'Preparando informe…', zh:'正在准备报告…', hi:'रिपोर्ट तैयार हो रही है…', ar:'يتم إعداد التقرير…', he:'מכין דוח…' },
  'PDF downloaded':   { es:'PDF descargado', zh:'PDF 已下载', hi:'PDF डाउनलोड किया गया', ar:'تم تنزيل PDF', he:'ה-PDF הורד' },
  'Report ready — choose where to save': {
    es:'Informe listo — elige dónde guardar',
    zh:'报告已就绪 — 请选择保存位置',
    hi:'रिपोर्ट तैयार — कहाँ सहेजें चुनें',
    ar:'التقرير جاهز — اختر مكان الحفظ',
    he:'הדוח מוכן — בחר היכן לשמור'
  },
  'PDF saved to app': { es:'PDF guardado en la app', zh:'PDF 已保存到应用', hi:'PDF ऐप में सहेजा गया', ar:'تم حفظ PDF داخل التطبيق', he:'ה-PDF נשמר באפליקציה' },
  'PDF library is not loaded': { es:'Biblioteca PDF no cargada', zh:'PDF 库未加载', hi:'PDF लाइब्रेरी लोड नहीं है', ar:'مكتبة PDF غير محملة', he:'ספריית ה-PDF לא נטענה' },
  // ── Drug interactions (carer-only) ──
  'Check drug interactions': { es:'Verificar interacciones de fármacos', zh:'检查药物相互作用', hi:'दवाइयों की पारस्परिक क्रिया जांचें', ar:'فحص تفاعلات الأدوية', he:'בדוק אינטראקציות בין תרופות' },
  'Drug interactions': { es:'Interacciones', zh:'药物相互作用', hi:'दवाई पारस्परिक क्रिया', ar:'تفاعلات الأدوية', he:'אינטראקציות' },
  'Drug Interaction Warning': { es:'Aviso de interaccion', zh:'药物相互作用警告', hi:'दवा इंटरैक्शन चेतावनी', ar:'تحذير تفاعل دوائي', he:'אזהרת אינטראקציה' },
  'The following interactions were detected with existing medications:': {
    es:'Se detectaron las siguientes interacciones con medicamentos existentes:',
    zh:'检测到与现有药物存在以下相互作用:',
    hi:'मौजूदा दवाइयों के साथ निम्नलिखित इंटरैक्शन पाए गए:',
    ar:'تم اكتشاف التفاعلات التالية مع الأدوية الحالية:',
    he:'זוהו האינטראקציות הבאות עם תרופות קיימות:'
  },
  'Save Anyway': { es:'Guardar de todos modos', zh:'仍然保存', hi:'फिर भी सहेजें', ar:'حفظ على أي حال', he:'שמור בכל זאת' },
  'Has known interactions': { es:'Tiene interacciones conocidas', zh:'存在已知相互作用', hi:'ज्ञात इंटरैक्शन हैं', ar:'له تفاعلات معروفة', he:'יש אינטראקציות ידועות' },
  'This is a safety net — confirm with a pharmacist or doctor.': {
    es:'Esto es una red de seguridad — confirme con un farmacéutico o médico.',
    zh:'这是安全网 — 请与药剂师或医生确认。',
    hi:'यह सुरक्षा जाल है — फार्मासिस्ट या डॉक्टर से पुष्टि करें।',
    ar:'هذه شبكة أمان — تأكد من صيدلي أو طبيب.',
    he:'זו רשת בטיחות — אמת עם רוקח או רופא.'
  },
  'Checking interactions…': { es:'Comprobando interacciones…', zh:'正在检查…', hi:'जांच हो रही है…', ar:'يتم الفحص…', he:'בודק…' },
  'Need at least two medications to check interactions.': {
    es:'Se necesitan al menos dos medicamentos para comprobar interacciones.',
    zh:'需要至少两种药物才能检查相互作用。',
    hi:'पारस्परिक क्रिया जांचने के लिए कम से कम दो दवाइयाँ चाहिए।',
    ar:'يلزم دواءان على الأقل للفحص.',
    he:'נדרשות לפחות שתי תרופות כדי לבדוק אינטראקציות.'
  },
  'Could not identify enough medications in the drug database.': {
    es:'No se pudieron identificar suficientes medicamentos en la base.',
    zh:'无法在药物数据库中识别足够的药物。',
    hi:'पर्याप्त दवाइयाँ डेटाबेस में नहीं मिलीं।',
    ar:'تعذّر التعرف على أدوية كافية في قاعدة البيانات.',
    he:'לא זוהו מספיק תרופות במאגר.'
  },
  'Interaction service is unavailable right now.': {
    es:'El servicio de interacciones no está disponible ahora.',
    zh:'相互作用服务目前不可用。',
    hi:'इंटरैक्शन सेवा अभी उपलब्ध नहीं है।',
    ar:'خدمة التفاعلات غير متاحة حاليًا.',
    he:'שירות האינטראקציות אינו זמין כעת.'
  },
  'No interaction data returned by the service.': {
    es:'El servicio no devolvió datos de interacción.',
    zh:'服务未返回相互作用数据。',
    hi:'सेवा से कोई डेटा नहीं मिला।',
    ar:'لم تُرجع الخدمة بيانات تفاعل.',
    he:'השירות לא החזיר נתוני אינטראקציה.'
  },
  'Could not reach the interaction service.': {
    es:'No se pudo contactar el servicio.',
    zh:'无法连接到服务。',
    hi:'सेवा तक नहीं पहुँच सके।',
    ar:'تعذّر الوصول إلى الخدمة.',
    he:'לא ניתן להגיע לשירות.'
  },
  'No interactions found for the listed medications.': {
    es:'No se encontraron interacciones para los medicamentos listados.',
    zh:'未发现所列药物之间的相互作用。',
    hi:'सूचीबद्ध दवाइयों के बीच कोई इंटरैक्शन नहीं मिला।',
    ar:'لم يتم العثور على تفاعلات بين الأدوية المدرجة.',
    he:'לא נמצאו אינטראקציות לתרופות הרשומות.'
  },
  'Not found in database': { es:'No están en la base', zh:'未在数据库中', hi:'डेटाबेस में नहीं', ar:'غير موجودة في قاعدة البيانات', he:'לא נמצאו במאגר' },
  'Source':           { es:'Fuente', zh:'来源', hi:'स्रोत', ar:'المصدر', he:'מקור' },
  'This check is a safety net and does not replace clinician review. Warnings are based on the NIH RxNav database.': {
    es:'Esta comprobación es una red de seguridad y no reemplaza la revisión clínica. Las advertencias se basan en la base NIH RxNav.',
    zh:'此检查作为安全网,不能替代临床审查。警告基于 NIH RxNav 数据库。',
    hi:'यह जाँच सुरक्षा जाल है और चिकित्सक की समीक्षा का विकल्प नहीं है। चेतावनियाँ NIH RxNav डेटाबेस पर आधारित हैं।',
    ar:'هذا الفحص شبكة أمان ولا يحل محل مراجعة الطبيب. التحذيرات مستندة إلى قاعدة NIH RxNav.',
    he:'הבדיקה הזו היא רשת בטיחות ואינה מחליפה סקירה קלינית. ההתראות מבוססות על מאגר NIH RxNav.'
  },
  'The following interactions were detected between your medications:': {
    es:'Se detectaron las siguientes interacciones entre sus medicamentos:',
    zh:'检测到您的药物之间存在以下相互作用:',
    hi:'आपकी दवाइयों के बीच निम्नलिखित इंटरैक्शन पाए गए:',
    ar:'تم اكتشاف التفاعلات التالية بين أدويتك:',
    he:'זוהו האינטראקציות הבאות בין התרופות שלך:'
  },
  'This check is a safety net and does not replace clinician review.': {
    es:'Esta comprobación es una red de seguridad y no reemplaza la revisión clínica.',
    zh:'此检查作为安全网,不能替代临床审查。',
    hi:'यह जाँच सुरक्षा जाल है और चिकित्सक की समीक्षा का विकल्प नहीं है।',
    ar:'هذا الفحص شبكة أمان ولا يحل محل مراجعة الطبيب.',
    he:'הבדיקה הזו היא רשת בטיחות ואינה מחליפה סקירה קלינית.'
  },
  'Need at least two medications to check interactions': {
    es:'Se necesitan al menos dos medicamentos para comprobar interacciones',
    zh:'需要至少两种药物才能检查相互作用',
    hi:'पारस्परिक क्रिया जांचने के लिए कम से कम दो दवाइयाँ चाहिए',
    ar:'يلزم دواءان على الأقل لفحص التفاعلات',
    he:'נדרשות לפחות שתי תרופות כדי לבדוק אינטראקציות'
  },
  'No warnings found — these medications appear safe together.': {
    es:'No se encontraron advertencias — estos medicamentos parecen seguros juntos.',
    zh:'未发现警告 — 这些药物一起使用似乎安全。',
    hi:'कोई चेतावनी नहीं मिली — ये दवाइयाँ एक साथ सुरक्षित प्रतीत होती हैं।',
    ar:'لم يتم العثور على تحذيرات — يبدو أن هذه الأدوية آمنة معًا.',
    he:'לא נמצאו אזהרות — תרופות אלו נראות בטוחות יחד.'
  },
  'Checking interactions...': {
    es:'Comprobando interacciones...',
    zh:'正在检查相互作用...',
    hi:'इंटरैक्शन की जांच हो रही है...',
    ar:'يتم فحص التفاعلات...',
    he:'בודק אינטראקציות...'
  },
  // ── Log dashboard: med charts ──
  'Medication adherence (30 days)': { es:'Adherencia (30 días)', zh:'服药依从性 (30 天)', hi:'30 दिन अनुपालन', ar:'الالتزام خلال 30 يومًا', he:'היענות (30 יום)' },
  'Most-missed medications': { es:'Más olvidados', zh:'最常漏服', hi:'सबसे अधिक छूटी दवाइयाँ', ar:'الأكثر فوتًا', he:'התרופות שהוחמצו הכי הרבה' },
  '30-day average':   { es:'Promedio 30 días', zh:'30 天平均', hi:'30 दिन औसत', ar:'متوسط 30 يومًا', he:'ממוצע 30 יום' },
  'No medication data yet.': { es:'Aún no hay datos.', zh:'暂无药物数据。', hi:'अभी कोई दवाई डेटा नहीं।', ar:'لا توجد بيانات بعد.', he:'עדיין אין נתונים.' },
  'No missed doses in the last 30 days 🎉': { es:'Sin dosis perdidas en 30 días 🎉', zh:'30 天未漏服 🎉', hi:'30 दिनों में कोई छूटी खुराक नहीं 🎉', ar:'لا جرعات فائتة خلال 30 يومًا 🎉', he:'אין מנות שהוחמצו ב-30 הימים האחרונים 🎉' },
  'Replace photo':    { es:'Reemplazar foto', zh:'更换照片', hi:'फोटो बदलें', ar:'استبدال الصورة', he:'החלף תמונה' },
  'Remove photo':     { es:'Quitar foto', zh:'移除照片', hi:'फोटो हटाएं', ar:'إزالة الصورة', he:'הסר תמונה' },
  'Image is too large': { es:'La imagen es demasiado grande', zh:'图片太大', hi:'छवि बहुत बड़ी है', ar:'الصورة كبيرة جدًا', he:'התמונה גדולה מדי' },
  'Could not read image': { es:'No se pudo leer la imagen', zh:'无法读取图片', hi:'छवि नहीं पढ़ सकी', ar:'تعذرت قراءة الصورة', he:'לא ניתן לקרוא את התמונה' },
  'e.g. pill, box, insert': { es:'p. ej. pastilla, caja, prospecto', zh:'例如药丸、盒子、说明书', hi:'जैसे गोली, बॉक्स, इंसर्ट', ar:'مثال: الحبة، العلبة، النشرة', he:'לדוגמה כדור, קופסה, עלון' },
  'Maximum of {n} photos': { es:'Máximo de {n} fotos', zh:'最多 {n} 张照片', hi:'अधिकतम {n} फोटो', ar:'حد أقصى {n} صور', he:'מקסימום {n} תמונות' },
  'Previous':         { es:'Anterior', zh:'上一张', hi:'पिछला', ar:'السابق', he:'הקודם' },
  'Next':             { es:'Siguiente', zh:'下一张', hi:'अगला', ar:'التالي', he:'הבא' },
  // ── Carer UI ──
  'Available':        { es:'Disponible', zh:'可用', hi:'उपलब्ध', ar:'متاح', he:'זמין' },
  'Busy':             { es:'Ocupado', zh:'忙碌', hi:'व्यस्त', ar:'مشغول', he:'עסוק' },
  'Off Duty':         { es:'Fuera de Servicio', zh:'下班', hi:'ऑफ ड्यूटी', ar:'خارج الخدمة', he:'לא בתפקיד' },
  'Online:':          { es:'En línea:', zh:'在线:', hi:'ऑनलाइन:', ar:'متصل:', he:'מחוברים:' },
  'Standby':          { es:'En Espera', zh:'待机', hi:'स्टैंडबाय', ar:'استعداد', he:'המתנה' },
  'Active Calls':     { es:'Llamadas Activas', zh:'活跃呼叫', hi:'सक्रिय कॉल', ar:'مكالمات نشطة', he:'שיחות פעילות' },
  "✓ I'm on my way":  { es:'✓ Voy en camino', zh:'✓ 我在路上', hi:'✓ मैं आ रहा हूँ', ar:'✓ أنا في الطريق', he:'✓ אני בדרך' },
  'Waiting for patient…': { es:'Esperando paciente…', zh:'等待患者…', hi:'मरीज की प्रतीक्षा…', ar:'في انتظار المريض…', he:'ממתין למטופל…' },
  // ── Ack overlay ──
  'Help is on the way': { es:'La ayuda está en camino', zh:'帮助在路上', hi:'मदद आ रही है', ar:'المساعدة في الطريق', he:'עזרה בדרך' },
  // ── Voice call ──
  'End Call':         { es:'Terminar', zh:'结束通话', hi:'कॉल समाप्त', ar:'إنهاء المكالمة', he:'סיים שיחה' },
  'Voice Call':       { es:'Llamada de Voz', zh:'语音通话', hi:'वॉयस कॉल', ar:'مكالمة صوتية', he:'שיחה קולית' },
  'Connected':        { es:'Conectado', zh:'已连接', hi:'कनेक्टेड', ar:'متصل', he:'מחובר' },
  // ── Welcome ──
  'I need care':      { es:'Necesito cuidado', zh:'我需要护理', hi:'मुझे देखभाल चाहिए', ar:'أحتاج رعاية', he:'אני צריך טיפול' },
  'I provide care':   { es:'Brindo cuidado', zh:'我提供护理', hi:'मैं देखभाल करता/करती हूँ', ar:'أقدم الرعاية', he:'אני מטפל/ת' },
  "What's your name?":{ es:'¿Cómo te llamas?', zh:'你叫什么名字？', hi:'आपका नाम क्या है?', ar:'ما اسمك؟', he:'מה שמך?' },
  'Continue →':       { es:'Continuar →', zh:'继续 →', hi:'जारी रखें →', ar:'← متابعة', he:'המשך →' },
  '← Back':           { es:'← Atrás', zh:'← 返回', hi:'← वापस', ar:'الرجوع →', he:'← חזור' },
  'Your carer':       { es:'Tu cuidador', zh:'你的护理员', hi:'आपका केयरर', ar:'المُعتني بك', he:'המטפל שלך' },
  'Your Code':        { es:'Tu Código', zh:'你的代码', hi:'आपका कोड', ar:'رمزك', he:'הקוד שלך' },
  'Connect →':        { es:'Conectar →', zh:'连接 →', hi:'कनेक्ट करें →', ar:'← اتصال', he:'התחבר →' },
  'Skip for now →':   { es:'Omitir por ahora →', zh:'暂时跳过 →', hi:'अभी छोड़ें →', ar:'← تخطي الآن', he:'דלג לעת עתה →' },
  // ── Setup screens ──
  'Simple, reliable care alerts for home and assisted living': { es:'Alertas de cuidado simples y confiables', zh:'简单可靠的护理警报', hi:'सरल, विश्वसनीय देखभाल अलर्ट', ar:'تنبيهات رعاية بسيطة وموثوقة', he:'התראות טיפול פשוטות ואמינות' },
  'Patient, resident, or assisted person': { es:'Paciente, residente o persona asistida', zh:'患者、居民或受助者', hi:'मरीज, निवासी या सहायता प्राप्त व्यक्ति', ar:'مريض أو مقيم أو شخص يحتاج مساعدة', he:'מטופל, דייר או אדם הזקוק לסיוע' },
  'Carer or nurse':   { es:'Cuidador o enfermero', zh:'护理员或护士', hi:'केयरर या नर्स', ar:'مُعتنٍ أو ممرض', he:'מטפל או אחות' },
  'Family member':    { es:'Familiar', zh:'家属', hi:'परिवार का सदस्य', ar:'فرد من العائلة', he:'בן משפחה' },
  'View call history and care notes': { es:'Ver historial y notas de cuidado', zh:'查看通话记录和护理备注', hi:'कॉल इतिहास और केयर नोट्स देखें', ar:'عرض سجل المكالمات وملاحظات الرعاية', he:'צפה בהיסטוריית שיחות והערות טיפול' },
  'This is shown to the other person': { es:'Esto se muestra a la otra persona', zh:'这将显示给对方', hi:'यह दूसरे व्यक्ति को दिखाया जाता है', ar:'يظهر هذا للشخص الآخر', he:'זה מוצג לאדם השני' },
  // ── Settings ──
  'Settings':         { es:'Configuración', zh:'设置', hi:'सेटिंग्स', ar:'الإعدادات', he:'הגדרות' },
  'Push Notifications':{ es:'Notificaciones Push', zh:'推送通知', hi:'पुश नोटिफिकेशन', ar:'إشعارات الدفع', he:'התראות דחיפה' },
  'Scheduled Check-ins':{ es:'Controles Programados', zh:'定时检查', hi:'निर्धारित चेक-इन', ar:'فحوصات مجدولة', he:'בדיקות מתוזמנות' },
  'Medication Reminders':{ es:'Recordatorios de Medicación', zh:'服药提醒', hi:'दवाई अनुस्मारक', ar:'تذكيرات الأدوية', he:'תזכורות תרופות' },
  'Location & Safety': { es:'Ubicación y Seguridad', zh:'位置与安全', hi:'स्थान और सुरक्षा', ar:'الموقع والسلامة', he:'מיקום ובטיחות' },
  'Accessibility':    { es:'Accesibilidad', zh:'无障碍', hi:'सुगम्यता', ar:'إمكانية الوصول', he:'נגישות' },
  'My Profile':       { es:'Mi Perfil', zh:'我的资料', hi:'मेरी प्रोफ़ाइल', ar:'ملفي الشخصي', he:'הפרופיל שלי' },
  'My Code':          { es:'Mi Código', zh:'我的代码', hi:'मेरा कोड', ar:'رمزي', he:'הקוד שלי' },
  'My Carers':        { es:'Mis Cuidadores', zh:'我的护理员', hi:'मेरे केयरर', ar:'المُعتنون بي', he:'המטפלים שלי' },
  'My Patients':      { es:'Mis Pacientes', zh:'我的患者', hi:'मेरे मरीज', ar:'مرضاي', he:'המטופלים שלי' },
  'Notifications':    { es:'Notificaciones', zh:'通知', hi:'सूचनाएं', ar:'الإشعارات', he:'התראות' },
  'Language':         { es:'Idioma', zh:'语言', hi:'भाषा', ar:'اللغة', he:'שפה' },
  'Danger Zone':      { es:'Zona de Peligro', zh:'危险区域', hi:'खतरनाक क्षेत्र', ar:'منطقة الخطر', he:'אזור מסוכן' },
  'Reset & Start Over': { es:'Restablecer', zh:'重置并重新开始', hi:'रीसेट और फिर से शुरू करें', ar:'إعادة تعيين والبدء من جديد', he:'אפס והתחל מחדש' },
  'Edit':             { es:'Editar', zh:'编辑', hi:'संपादित करें', ar:'تعديل', he:'ערוך' },
  // ── Log ──
  'Total Calls':      { es:'Total Llamadas', zh:'总呼叫', hi:'कुल कॉल', ar:'إجمالي المكالمات', he:'סה"כ שיחות' },
  'Responded':        { es:'Respondidas', zh:'已响应', hi:'जवाब दिया', ar:'تم الرد', he:'נענו' },
  'Avg Response':     { es:'Resp. Promedio', zh:'平均响应', hi:'औसत प्रतिक्रिया', ar:'متوسط الاستجابة', he:'תגובה ממוצעת' },
  'Fastest':          { es:'Más Rápida', zh:'最快', hi:'सबसे तेज़', ar:'الأسرع', he:'מהיר ביותר' },
  'Slowest':          { es:'Más Lenta', zh:'最慢', hi:'सबसे धीमा', ar:'الأبطأ', he:'איטי ביותר' },
  'Today':            { es:'Hoy', zh:'今天', hi:'आज', ar:'اليوم', he:'היום' },
  'Most Common Needs':{ es:'Necesidades Comunes', zh:'最常见需求', hi:'सबसे सामान्य ज़रूरतें', ar:'الاحتياجات الأكثر شيوعاً', he:'צרכים נפוצים' },
  'No calls yet':     { es:'Sin llamadas aún', zh:'暂无呼叫', hi:'अभी तक कोई कॉल नहीं', ar:'لا مكالمات بعد', he:'אין שיחות עדיין' },
  'All':              { es:'Todas', zh:'全部', hi:'सभी', ar:'الكل', he:'הכل' },
  // ── Setup/Profile ──
  'Please enter your name': { es:'Ingresa tu nombre', zh:'请输入你的名字', hi:'कृपया अपना नाम दर्ज करें', ar:'الرجاء إدخال اسمك', he:'נא הזן את שמך' },
  'Your name':        { es:'Tu nombre', zh:'你的名字', hi:'आपका नाम', ar:'اسمك', he:'השם שלך' },
  'Phone Number':     { es:'Teléfono', zh:'电话号码', hi:'फ़ोन नंबर', ar:'رقم الهاتف', he:'מספר טלפון' },
  'Not set':          { es:'No configurado', zh:'未设置', hi:'सेट नहीं', ar:'غير محدد', he:'לא הוגדר' },
  'Share this code to connect': { es:'Comparte este código', zh:'分享此代码以连接', hi:'कनेक्ट करने के लिए यह कोड शेयर करें', ar:'شارك هذا الرمز للاتصال', he:'שתף קוד זה כדי להתחבר' },
  'Name updated':     { es:'Nombre actualizado', zh:'名字已更新', hi:'नाम अपडेट किया गया', ar:'تم تحديث الاسم', he:'השם עודכן' },
  'Avatar updated':   { es:'Avatar actualizado', zh:'头像已更新', hi:'अवतार अपडेट किया गया', ar:'تم تحديث الصورة', he:'הסמל עודכן' },
  'Connection removed': { es:'Conexión eliminada', zh:'已断开连接', hi:'कनेक्शन हटाया गया', ar:'تم إزالة الاتصال', he:'החיבור הוסר' },
  // ── Offline/Connection ──
  'No internet — use phone instead': { es:'Sin internet — usa el teléfono', zh:'无网络 — 请用电话', hi:'इंटरनेट नहीं — फ़ोन का उपयोग करें', ar:'لا إنترنت — استخدم الهاتف', he:'אין אינטרנט — השתמש בטלפון' },
  'No carers connected — add a carer first': { es:'Sin cuidadores — agrega uno primero', zh:'未连接护理员 — 请先添加', hi:'कोई केयरर नहीं — पहले जोड़ें', ar:'لا مُعتنين — أضف واحداً أولاً', he:'אין מטפלים מחוברים — הוסף קודם' },
  'No connections yet — add a patient or carer in Settings': { es:'Sin conexiones — agrega en Configuración', zh:'暂无连接 — 在设置中添加', hi:'कोई कनेक्शन नहीं — सेटिंग्स में जोड़ें', ar:'لا اتصالات — أضف في الإعدادات', he:'אין חיבורים — הוסף בהגדרות' },
  'Call failed — check your connection': { es:'Llamada fallida — verifica tu conexión', zh:'呼叫失败 — 检查连接', hi:'कॉल विफल — अपना कनेक्शन जांचें', ar:'فشلت المكالمة — تحقق من اتصالك', he:'השיחה נכשלה — בדוק חיבור' },
  'No response yet — try calling again': { es:'Sin respuesta — intenta de nuevo', zh:'暂无回应 — 请重试', hi:'अभी तक कोई प्रतिक्रिया नहीं — फिर से कॉल करें', ar:'لا استجابة — حاول مرة أخرى', he:'אין תגובה — נסה שוב' },
  // ── Carer responses ──
  "Patient notified — you're on the way!": { es:'Paciente notificado — ¡vas en camino!', zh:'已通知患者 — 你在路上！', hi:'मरीज को सूचित किया गया — आप रास्ते में हैं!', ar:'تم إشعار المريض — أنت في الطريق!', he:'המטופל קיבל הודעה — אתה בדרך!' },
  'Failed to acknowledge — check your connection': { es:'Error al confirmar — verifica tu conexión', zh:'确认失败 — 检查连接', hi:'स्वीकार करने में विफल — कनेक्शन जांचें', ar:'فشل في التأكيد — تحقق من اتصالك', he:'האישור נכשל — בדוק חיבור' },
  // ── Fall detection ──
  'Monitoring for falls': { es:'Monitoreando caídas', zh:'正在监测跌倒', hi:'गिरावट की निगरानी', ar:'مراقبة السقوط', he:'מנטר נפילות' },
  'Fall detection active — keep phone on your body': { es:'Detección activa — lleva el teléfono contigo', zh:'跌倒检测已启动 — 请随身携带手机', hi:'गिरावट पहचान चालू — फ़ोन शरीर पर रखें', ar:'كشف السقوط نشط — احتفظ بالهاتف معك', he:'זיהוי נפילות פעיל — שמור טלפון על הגוף' },
  "Alert cancelled — glad you're OK!": { es:'Alerta cancelada — ¡qué bueno que estás bien!', zh:'警报已取消 — 很高兴你没事！', hi:'अलर्ट रद्द — खुशी है कि आप ठीक हैं!', ar:'تم إلغاء التنبيه — سعيد أنك بخير!', he:'ההתראה בוטלה — שמח שאתה בסדר!' },
  // ── Check-in ──
  'Check-in interval': { es:'Intervalo', zh:'检查间隔', hi:'चेक-इन अंतराल', ar:'فترة الفحص', he:'מרווח בדיקה' },
  'Active hours':     { es:'Horas activas', zh:'活跃时段', hi:'सक्रिय घंटे', ar:'ساعات النشاط', he:'שעות פעילות' },
  'Response window':  { es:'Ventana de respuesta', zh:'回应窗口', hi:'प्रतिक्रिया समय', ar:'نافذة الاستجابة', he:'חלון תגובה' },
  "Great — we'll check again later!": { es:'Bien — ¡revisaremos después!', zh:'很好 — 稍后再检查！', hi:'अच्छा — बाद में फिर जांचेंगे!', ar:'رائع — سنتحقق لاحقاً!', he:'מעולה — נבדוק שוב מאוחר יותר!' },
  // ── Medication ──
  'Medication name':  { es:'Nombre del medicamento', zh:'药物名称', hi:'दवाई का नाम', ar:'اسم الدواء', he:'שם התרופה' },
  // ── Location ──
  'Share location with calls': { es:'Compartir ubicación', zh:'通话时共享位置', hi:'कॉल के साथ स्थान साझा करें', ar:'مشاركة الموقع مع المكالمات', he:'שתף מיקום עם שיחות' },
  'Location sharing enabled': { es:'Ubicación compartida', zh:'位置共享已启用', hi:'स्थान साझाकरण सक्षम', ar:'تم تفعيل مشاركة الموقع', he:'שיתוף מיקום מופעל' },
  'Location sharing disabled': { es:'Ubicación desactivada', zh:'位置共享已关闭', hi:'स्थान साझाकरण अक्षम', ar:'تم تعطيل مشاركة الموقع', he:'שיתוף מיקום כבוי' },
  // ── Accessibility ──
  'Large Text':       { es:'Texto Grande', zh:'大字体', hi:'बड़ा टेक्स्ट', ar:'نص كبير', he:'טקסט גדול' },
  'High Contrast':    { es:'Alto Contraste', zh:'高对比度', hi:'उच्च कंट्रास्ट', ar:'تباين عالي', he:'ניגודיות גבוהה' },
  // ── Care notes ──
  'Care note saved':  { es:'Nota guardada', zh:'护理备注已保存', hi:'केयर नोट सहेजा गया', ar:'تم حفظ ملاحظة الرعاية', he:'הערת טיפול נשמרה' },
  // ── Voice call ──
  'Voice call disconnected': { es:'Llamada desconectada', zh:'语音通话已断开', hi:'वॉयस कॉल डिस्कनेक्ट', ar:'انقطعت المكالمة الصوتية', he:'שיחה קולית נותקה' },
  'Microphone access required': { es:'Se requiere micrófono', zh:'需要麦克风权限', hi:'माइक्रोफ़ोन की अनुमति चाहिए', ar:'مطلوب إذن الميكروفون', he:'נדרשת גישה למיקרופון' },
  'Call ended':       { es:'Llamada terminada', zh:'通话结束', hi:'कॉल समाप्त', ar:'انتهت المكالمة', he:'השיחה הסתיימה' },
  'Call declined':    { es:'Llamada rechazada', zh:'通话被拒', hi:'कॉल अस्वीकार', ar:'تم رفض المكالمة', he:'השיחה נדחתה' },
  'No answer':        { es:'Sin respuesta', zh:'无人接听', hi:'कोई जवाब नहीं', ar:'لا إجابة', he:'אין מענה' },
  'Answer':           { es:'Contestar', zh:'接听', hi:'उत्तर दें', ar:'رد', he:'ענה' },
  'Decline':          { es:'Rechazar', zh:'拒绝', hi:'अस्वीकार', ar:'رفض', he:'דחה' },
  'Incoming voice call': { es:'Llamada de voz entrante', zh:'来电语音通话', hi:'आने वाला वॉयस कॉल', ar:'مكالمة صوتية واردة', he:'שיחה קולית נכנסת' },
  // ── Reset ──
  'This will clear all saved data and restart setup. Are you sure?': { es:'Esto borrará todos los datos. ¿Estás seguro?', zh:'这将清除所有数据并重新设置。确定吗？', hi:'यह सभी डेटा हटा देगा। क्या आप सुनिश्चित हैं?', ar:'سيؤدي هذا إلى مسح جميع البيانات. هل أنت متأكد؟', he:'פעולה זו תמחק את כל הנתונים. בטוח?' },
  // ── Dashboard insights ──
  'On':               { es:'Sí', zh:'开', hi:'चालू', ar:'تشغيل', he:'פעיל' },
  'Off':              { es:'No', zh:'关', hi:'बंद', ar:'إيقاف', he:'כבוי' },
  'Loading…':         { es:'Cargando…', zh:'加载中…', hi:'लोड हो रहा है…', ar:'جارٍ التحميل…', he:'טוען…' },
  'Waiting for connection…': { es:'Esperando conexión…', zh:'等待连接…', hi:'कनेक्शन की प्रतीक्षा…', ar:'في انتظار الاتصال…', he:'ממתין לחיבור…' },
  'No one connected yet': { es:'Nadie conectado aún', zh:'暂无人连接', hi:'अभी तक कोई कनेक्ट नहीं', ar:'لا أحد متصل بعد', he:'אף אחד עדיין לא מחובר' },
  'CSV downloaded':   { es:'CSV descargado', zh:'CSV 已下载', hi:'CSV डाउनलोड किया गया', ar:'تم تنزيل CSV', he:'CSV הורד' },
  'is calling!':      { es:'está llamando!', zh:'正在呼叫！', hi:'बुला रहा है!', ar:'يتصل!', he:'מתקשר!' },
  'No calls to export': { es:'Sin llamadas para exportar', zh:'没有可导出的呼叫', hi:'निर्यात करने के लिए कोई कॉल नहीं', ar:'لا مكالمات للتصدير', he:'אין שיחות לייצוא' },
  'Phone number saved': { es:'Teléfono guardado', zh:'电话号码已保存', hi:'फ़ोन नंबर सहेजा गया', ar:'تم حفظ رقم الهاتف', he:'מספר טלפון נשמר' },
  'Phone number removed': { es:'Teléfono eliminado', zh:'电话号码已删除', hi:'फ़ोन नंबर हटाया गया', ar:'تم إزالة رقم الهاتف', he:'מספר טלפון הוסר' },
  // ── Voice notes ──
  'Hold longer to record a voice note': { es:'Mantén más tiempo para grabar', zh:'按住更久来录音', hi:'रिकॉर्ड करने के लिए लंबे समय तक दबाएं', ar:'اضغط لفترة أطول للتسجيل', he:'החזק יותר זמן כדי להקליט' },
  'Voice note recorded': { es:'Nota de voz grabada', zh:'语音备注已录制', hi:'वॉयस नोट रिकॉर्ड किया गया', ar:'تم تسجيل الملاحظة الصوتية', he:'הודעה קולית הוקלטה' },
  'Recording…':      { es:'Grabando…', zh:'录音中…', hi:'रिकॉर्ड हो रहा है…', ar:'جارٍ التسجيل…', he:'מקליט…' },
  'Recorded':         { es:'Grabado', zh:'已录制', hi:'रिकॉर्ड किया गया', ar:'تم التسجيل', he:'הוקלט' },
  'Microphone access required for voice notes': { es:'Se requiere acceso al micrófono', zh:'需要麦克风权限', hi:'माइक्रोफ़ोन की अनुमति चाहिए', ar:'مطلوب إذن الميكروفون', he:'נדרשת גישה למיקרופון' },
  'Could not play audio': { es:'No se pudo reproducir', zh:'无法播放', hi:'ऑडियो नहीं चला सका', ar:'تعذر تشغيل الصوت', he:'לא ניתן להשמיע' },
  // ── Fall detection ──
  'Motion sensor permission required for fall detection': { es:'Se requiere permiso del sensor', zh:'需要运动传感器权限', hi:'सेंसर की अनुमति चाहिए', ar:'مطلوب إذن المستشعر', he:'נדרשת גישה לחיישן' },
  'Motion sensors not available on this device': { es:'Sensores no disponibles', zh:'此设备无运动传感器', hi:'यह डिवाइस पर सेंसर उपलब्ध नहीं', ar:'المستشعرات غير متوفرة', he:'חיישנים לא זמינים' },
  // ── Connection ──
  'Already connected to': { es:'Ya conectado a', zh:'已连接到', hi:'पहले से जुड़े हैं', ar:'متصل بالفعل بـ', he:'כבר מחובר ל' },
  'Connected to': { es:'Conectado a', zh:'已连接到', hi:'जुड़ गए', ar:'تم الاتصال بـ', he:'מחובר ל' },
  'No available carers': { es:'Sin cuidadores disponibles', zh:'没有可用的护理员', hi:'कोई उपलब्ध केयरर नहीं', ar:'لا يوجد مُعتنين متاحين', he:'אין מטפלים זמינים' },
  'All carers notified — waiting for response': { es:'Todos notificados — esperando respuesta', zh:'所有护理员已通知 — 等待回应', hi:'सभी केयरर को सूचित किया — प्रतिक्रिया की प्रतीक्षा', ar:'تم إشعار جميع المُعتنين — في انتظار الرد', he:'כל המטפלים קיבלו הודעה — ממתין לתגובה' },
  'Notification permission denied': { es:'Permiso de notificación denegado', zh:'通知权限被拒绝', hi:'सूचना अनुमति अस्वीकार', ar:'تم رفض إذن الإشعار', he:'הרשאת התראות נדחתה' },
  // ── Check-in / Medication ──
  'Calling your carers…': { es:'Llamando a tus cuidadores…', zh:'正在呼叫你的护理员…', hi:'आपके केयरर को कॉल कर रहे हैं…', ar:'جارٍ الاتصال بالمُعتنين…', he:'מתקשר למטפלים שלך…' },
  'Carers have been alerted': { es:'Cuidadores alertados', zh:'护理员已收到警报', hi:'केयरर को सूचित किया गया', ar:'تم تنبيه المُعتنين', he:'המטפלים קיבלו התראה' },
  'Carers alerted — no activity detected': { es:'Cuidadores alertados — sin actividad', zh:'护理员已通知 — 未检测到活动', hi:'केयरर को सूचित किया — कोई गतिविधि नहीं', ar:'تم تنبيه المُعتنين — لم يتم اكتشاف نشاط', he:'המטפלים קיבלו התראה — לא זוהה פעילות' },
  // ── Geo / Location ──
  'Could not get location': { es:'No se pudo obtener ubicación', zh:'无法获取位置', hi:'स्थान प्राप्त नहीं हो सका', ar:'تعذر الحصول على الموقع', he:'לא ניתן לקבל מיקום' },
  'Safe zone cleared': { es:'Zona segura eliminada', zh:'安全区域已清除', hi:'सेफ ज़ोन हटाया गया', ar:'تم مسح المنطقة الآمنة', he:'אזור בטוח נמחק' },
  'Carers alerted — you left the safe zone': { es:'Cuidadores alertados — saliste de la zona', zh:'护理员已通知 — 你离开了安全区域', hi:'केयरर को सूचित किया — आप सेफ ज़ोन से बाहर', ar:'تم تنبيه المُعتنين — غادرت المنطقة الآمنة', he:'המטפלים קיבלו התראה — יצאת מהאזור הבטוח' },
  'Emergency info saved': { es:'Info de emergencia guardada', zh:'急救信息已保存', hi:'आपातकालीन जानकारी सहेजी गई', ar:'تم حفظ معلومات الطوارئ', he:'מידע חירום נשמר' },
  // ── Voice activation ──
  'Voice activation OFF': { es:'Activación de voz APAGADA', zh:'语音激活已关闭', hi:'वॉयस एक्टिवेशन बंद', ar:'التنشيط الصوتي معطل', he:'הפעלה קולית כבויה' },
  'Voice command detected — calling carer': { es:'Comando detectado — llamando', zh:'语音命令检测到 — 正在呼叫', hi:'वॉयस कमांड पहचाना — कॉल कर रहे हैं', ar:'تم اكتشاف أمر صوتي — جارٍ الاتصال', he:'פקודה קולית זוהתה — מתקשר' },
  'No personal code yet': { es:'Sin código personal', zh:'还没有个人代码', hi:'अभी तक कोई व्यक्तिगत कोड नहीं', ar:'لا يوجد رمز شخصي بعد', he:'אין קוד אישי עדיין' },
  // ── Setup flow ──
  'Your Carer Code': { es:'Tu Código de Cuidador', zh:'你的护理员代码', hi:'आपका केयरर कोड', ar:'رمز المُعتني الخاص بك', he:'קוד המטפל שלך' },
  'Your Patient Code': { es:'Tu Código de Paciente', zh:'你的患者代码', hi:'आपका पेशेंट कोड', ar:'رمز المريض الخاص بك', he:'קוד המטופל שלך' },
  'Your Family Code': { es:'Tu Código Familiar', zh:'你的家庭代码', hi:'आपका फैमिली कोड', ar:'رمز العائلة الخاص بك', he:'קוד המשפחה שלך' },
  'Please enter a 4-character code': { es:'Ingresa un código de 4 caracteres', zh:'请输入4位代码', hi:'कृपया 4-अक्षर का कोड दर्ज करें', ar:'الرجاء إدخال رمز من 4 أحرف', he:'נא הזן קוד בן 4 תווים' },
  // ── Ambient listen ──
  'No active call to listen to': { es:'Sin llamada activa', zh:'没有活跃通话可监听', hi:'सुनने के लिए कोई सक्रिय कॉल नहीं', ar:'لا توجد مكالمة نشطة للاستماع', he:'אין שיחה פעילה להאזנה' },
  'Listening request sent — waiting for audio…': { es:'Solicitud enviada — esperando audio…', zh:'监听请求已发送 — 等待音频…', hi:'सुनने का अनुरोध भेजा — ऑडियो की प्रतीक्षा…', ar:'تم إرسال طلب الاستماع — في انتظار الصوت…', he:'בקשת האזנה נשלחה — ממתין לשמע…' },
  // ── Misc UI ──
  'Standby':          { es:'En Espera', zh:'待机', hi:'स्टैंडबाय', ar:'استعداد', he:'המתנה' },
  'On Call':          { es:'En Servicio', zh:'值班中', hi:'ऑन कॉल', ar:'في الخدمة', he:'בתורנות' },
  'QR Code':          { es:'Código QR', zh:'二维码', hi:'QR कोड', ar:'رمز QR', he:'קוד QR' },
  'Your CareCall code': { es:'Tu código CareCall', zh:'你的 CareCall 代码', hi:'आपका CareCall कोड', ar:'رمز CareCall الخاص بك', he:'הקוד שלך ב-CareCall' },
  'The other person scans this QR in their CareCall app, or types the four letters.': {
    es: 'La otra persona escanea este QR en su app CareCall, o escribe las cuatro letras.',
    zh: '对方在 CareCall 应用中扫描此二维码,或输入四个字母。',
    hi: 'दूसरा व्यक्ति अपने CareCall ऐप में यह QR स्कैन करे, या चार अक्षर टाइप करे।',
    ar: 'يفحص الشخص الآخر رمز QR هذا في تطبيق CareCall الخاص به، أو يكتب الأحرف الأربعة.',
    he: 'האדם השני סורק את קוד ה-QR הזה באפליקציית CareCall שלו, או מקליד את ארבע האותיות.'
  },
  '📷 Scan QR instead': { es:'📷 Escanear QR', zh:'📷 扫描二维码', hi:'📷 QR स्कैन करें', ar:'📷 فحص QR', he:'📷 סרוק QR' },
  'Scan QR code':     { es:'Escanear código QR', zh:'扫描二维码', hi:'QR कोड स्कैन करें', ar:'فحص رمز QR', he:'סרוק קוד QR' },
  'The other person scans this QR code to connect': {
    es:'La otra persona escanea este código QR para conectarse',
    zh:'对方扫描此二维码以连接',
    hi:'दूसरा व्यक्ति कनेक्ट करने के लिए यह QR कोड स्कैन करे',
    ar:'يقوم الشخص الآخر بفحص رمز QR هذا للاتصال',
    he:'האדם השני סורק את קוד ה-QR הזה כדי להתחבר'
  },
  'Point camera at the QR code': {
    es:'Apunte la cámara al código QR',
    zh:'将摄像头对准二维码',
    hi:'कैमरा QR कोड पर इंगित करें',
    ar:'صوِّب الكاميرا على رمز QR',
    he:'כוון את המצלמה אל קוד ה-QR'
  },
  'Point camera at the QR code displayed on the other device': {
    es: 'Apunta la cámara al código QR mostrado en el otro dispositivo',
    zh: '将摄像头对准另一台设备上显示的二维码',
    hi: 'कैमरा दूसरे डिवाइस पर दिखाए QR कोड पर इंगित करें',
    ar: 'صوِّب الكاميرا على رمز QR الظاهر على الجهاز الآخر',
    he: 'כוון את המצלמה אל קוד ה-QR המוצג במכשיר השני'
  },
  'Could not access the camera.': { es:'No se pudo acceder a la cámara.', zh:'无法访问摄像头。', hi:'कैमरा तक नहीं पहुँच सके।', ar:'تعذر الوصول إلى الكاميرا.', he:'לא ניתן לגשת למצלמה.' },
  'Scanner unavailable — check your connection': { es:'Escáner no disponible — revisa tu conexión', zh:'扫描器不可用 — 请检查网络', hi:'स्कैनर उपलब्ध नहीं — अपना कनेक्शन जाँचें', ar:'الماسح غير متوفر — تحقق من الاتصال', he:'הסורק אינו זמין — בדוק חיבור' },
  'Code scanned':     { es:'Código escaneado', zh:'已扫描代码', hi:'कोड स्कैन किया गया', ar:'تم مسح الرمز', he:'קוד נסרק' },
  "That's your own code": { es:'Ese es tu propio código', zh:'这是你自己的代码', hi:'यह आपका अपना कोड है', ar:'هذا رمزك أنت', he:'זה הקוד שלך' },
  'Connect to code':  { es:'Conectar al código', zh:'连接到代码', hi:'कोड से कनेक्ट करें', ar:'الاتصال بالرمز', he:'התחבר לקוד' },
  'Already connected to': { es:'Ya conectado a', zh:'已连接到', hi:'पहले से जुड़ा है', ar:'متصل بالفعل بـ', he:'כבר מחובר ל-' },
  'Connected to':     { es:'Conectado a', zh:'已连接到', hi:'कनेक्टेड', ar:'متصل بـ', he:'מחובר ל-' },
  // ── Safe Zone editor ──
  'Safe Zone':        { es:'Zona segura', zh:'安全区', hi:'सुरक्षित क्षेत्र', ar:'المنطقة الآمنة', he:'אזור בטוח' },
  'Edit':             { es:'Editar', zh:'编辑', hi:'संपादित करें', ar:'تعديل', he:'ערוך' },
  'Active — {n}m radius': { es:'Activa — radio {n}m', zh:'已激活 — 半径 {n} 米', hi:'सक्रिय — {n} मीटर त्रिज्या', ar:'نشطة — نصف قطر {n} م', he:'פעיל — רדיוס {n} מ׳' },
  'Paused — tap to enable': { es:'Pausada — toca para activar', zh:'已暂停 — 点击启用', hi:'रुका हुआ — सक्षम करने के लिए टैप करें', ar:'متوقفة — اضغط للتفعيل', he:'מושהה — הקש להפעלה' },
  'Alert carers if patient leaves home area': { es:'Alertar cuidadores si el paciente sale del área', zh:'患者离开区域时通知看护者', hi:'रोगी के क्षेत्र छोड़ने पर देखभालकर्ता को सूचित करें', ar:'تنبيه المعتنين إذا غادر المريض المنطقة', he:'התראה למטפלים אם המטופל יוצא מהאזור' },
  'Carers are alerted when the patient leaves this zone. Works while the app is open in the foreground.': {
    es:'Los cuidadores son alertados cuando el paciente sale de esta zona. Funciona mientras la app está abierta en primer plano.',
    zh:'当患者离开此区域时,看护者会收到通知。仅在应用处于前台时工作。',
    hi:'जब रोगी इस क्षेत्र से बाहर जाता है तो देखभालकर्ताओं को सूचित किया जाता है। यह ऐप के खुले रहने पर काम करता है।',
    ar:'يتم تنبيه المعتنين عندما يغادر المريض هذه المنطقة. يعمل أثناء فتح التطبيق في المقدمة.',
    he:'המטפלים מקבלים התראה כשהמטופל יוצא מהאזור. עובד כשהאפליקציה פתוחה בחזית.'
  },
  'Center point':     { es:'Punto central', zh:'中心点', hi:'केंद्र बिंदु', ar:'نقطة المركز', he:'נקודת מרכז' },
  'Coordinates captured': { es:'Coordenadas capturadas', zh:'已获取坐标', hi:'निर्देशांक प्राप्त किए गए', ar:'تم التقاط الإحداثيات', he:'הקואורדינטות נקלטו' },
  'Not set yet':      { es:'Aún no configurado', zh:'尚未设置', hi:'अभी तक सेट नहीं', ar:'لم يُحدَّد بعد', he:'עדיין לא נקבע' },
  'Use my current location': { es:'Usar mi ubicación actual', zh:'使用当前位置', hi:'मेरी वर्तमान लोकेशन का उपयोग करें', ar:'استخدم موقعي الحالي', he:'השתמש במיקום הנוכחי' },
  'Update with current location': { es:'Actualizar con ubicación actual', zh:'更新为当前位置', hi:'वर्तमान लोकेशन से अपडेट करें', ar:'التحديث بالموقع الحالي', he:'עדכן למיקום הנוכחי' },
  'View':             { es:'Ver', zh:'查看', hi:'देखें', ar:'عرض', he:'הצג' },
  'Radius':           { es:'Radio', zh:'半径', hi:'त्रिज्या', ar:'نصف القطر', he:'רדיוס' },
  'metres':           { es:'metros', zh:'米', hi:'मीटर', ar:'متر', he:'מטרים' },
  'm':                { es:'m', zh:'米', hi:'मी', ar:'م', he:'מ׳' },
  'Current distance': { es:'Distancia actual', zh:'当前距离', hi:'वर्तमान दूरी', ar:'المسافة الحالية', he:'מרחק נוכחי' },
  'Measuring…':       { es:'Midiendo…', zh:'测量中…', hi:'मापा जा रहा है…', ar:'يجري القياس…', he:'מודד…' },
  'Set a center first': { es:'Establece primero un centro', zh:'请先设置中心', hi:'पहले केंद्र सेट करें', ar:'حدّد نقطة المركز أولًا', he:'קבע תחילה נקודת מרכז' },
  'Inside safe zone': { es:'Dentro de la zona', zh:'在安全区内', hi:'सुरक्षित क्षेत्र के अंदर', ar:'داخل المنطقة الآمنة', he:'בתוך האזור הבטוח' },
  'Outside safe zone': { es:'Fuera de la zona', zh:'在安全区外', hi:'सुरक्षित क्षेत्र के बाहर', ar:'خارج المنطقة الآمنة', he:'מחוץ לאזור הבטוח' },
  'from centre':      { es:'desde el centro', zh:'距离中心', hi:'केंद्र से', ar:'من المركز', he:'מהמרכז' },
  'Location unavailable': { es:'Ubicación no disponible', zh:'无法获取位置', hi:'लोकेशन उपलब्ध नहीं', ar:'الموقع غير متاح', he:'המיקום לא זמין' },
  'Could not get location — check permissions and GPS': { es:'No se pudo obtener la ubicación — revisa permisos y GPS', zh:'无法获取位置 — 请检查权限和 GPS', hi:'लोकेशन नहीं मिल सकी — अनुमतियाँ और GPS जाँचें', ar:'تعذر الحصول على الموقع — تحقق من الأذونات وGPS', he:'לא ניתן לקבל מיקום — בדוק הרשאות ו-GPS' },
  'Monitoring enabled': { es:'Monitoreo activado', zh:'监控已启用', hi:'निगरानी सक्षम', ar:'المراقبة مفعّلة', he:'הניטור פעיל' },
  'Turn off to pause alerts without deleting the zone': { es:'Desactiva para pausar alertas sin borrar la zona', zh:'关闭以暂停警报但保留区域', hi:'अलर्ट रोकने के लिए बंद करें, क्षेत्र नहीं हटेगा', ar:'أوقفها لإيقاف التنبيهات دون حذف المنطقة', he:'כבה כדי להשהות התראות בלי למחוק את האזור' },
  'Set a center point first.': { es:'Primero establece un punto central.', zh:'请先设置中心点。', hi:'पहले केंद्र बिंदु सेट करें।', ar:'حدّد نقطة المركز أولًا.', he:'קבע תחילה נקודת מרכז.' },
  'Radius must be between {min} and {max} metres': {
    es:'El radio debe estar entre {min} y {max} metros',
    zh:'半径必须在 {min} 到 {max} 米之间',
    hi:'त्रिज्या {min} और {max} मीटर के बीच होनी चाहिए',
    ar:'يجب أن يكون نصف القطر بين {min} و{max} متر',
    he:'הרדיוס חייב להיות בין {min} ל-{max} מ׳'
  },
  'Safe zone saved':  { es:'Zona segura guardada', zh:'安全区已保存', hi:'सुरक्षित क्षेत्र सहेजा गया', ar:'تم حفظ المنطقة الآمنة', he:'האזור הבטוח נשמר' },
  'Safe zone saved (monitoring paused)': { es:'Zona guardada (monitoreo pausado)', zh:'已保存 (监控已暂停)', hi:'सहेजा गया (निगरानी रुकी)', ar:'تم الحفظ (المراقبة متوقفة)', he:'נשמר (הניטור מושהה)' },
  'Remove the safe zone? You can always set a new one later.': { es:'¿Eliminar la zona segura? Puedes configurar una nueva más adelante.', zh:'删除安全区? 以后随时可以重新设置。', hi:'सुरक्षित क्षेत्र हटाएं? बाद में नया सेट कर सकते हैं।', ar:'إزالة المنطقة الآمنة؟ يمكنك إعداد واحدة جديدة لاحقًا.', he:'להסיר את האזור? ניתן להגדיר חדש מאוחר יותר.' },
  'Remove safe zone': { es:'Eliminar zona segura', zh:'移除安全区', hi:'सुरक्षित क्षेत्र हटाएं', ar:'إزالة المنطقة الآمنة', he:'הסר אזור בטוח' },
  'Safe zone cleared': { es:'Zona segura eliminada', zh:'安全区已清除', hi:'सुरक्षित क्षेत्र साफ किया गया', ar:'تم مسح المنطقة الآمنة', he:'האזור נוקה' },
  'Left safe zone':   { es:'Salió de la zona segura', zh:'已离开安全区', hi:'सुरक्षित क्षेत्र छोड़ा', ar:'غادر المنطقة الآمنة', he:'יצא מהאזור הבטוח' },
  'Carers alerted — you left the safe zone': { es:'Cuidadores alertados — saliste de la zona', zh:'已通知看护者 — 你离开了安全区', hi:'देखभालकर्ता को सूचित किया गया — आपने क्षेत्र छोड़ा', ar:'تم تنبيه المعتنين — غادرت المنطقة الآمنة', he:'המטפלים קיבלו התראה — יצאת מהאזור' },
  // ── Multi-zone, dwell, ack ──
  'Safe zones':       { es:'Zonas seguras', zh:'安全区', hi:'सुरक्षित क्षेत्र', ar:'المناطق الآمنة', he:'אזורים בטוחים' },
  'Tap a zone to edit. Add more for day centre, family member’s home, etc.': { es:'Toca una zona para editar. Añade más para centro de día, casa de familiar, etc.', zh:'点击一个区域进行编辑。可为日间中心、家人家等添加更多。', hi:'संपादित करने के लिए ज़ोन पर टैप करें। डे-सेंटर, परिजन के घर आदि के लिए और जोड़ें।', ar:'اضغط منطقة لتعديلها. أضف المزيد لمركز النهار أو منزل قريب.', he:'הקש על אזור כדי לערוך. הוסף אזורים נוספים (מרכז יום, בית קרוב משפחה).' },
  'Add zone':         { es:'Añadir zona', zh:'添加区域', hi:'ज़ोन जोड़ें', ar:'إضافة منطقة', he:'הוסף אזור' },
  'Maximum of {n} safe zones': { es:'Máximo {n} zonas seguras', zh:'最多 {n} 个安全区', hi:'अधिकतम {n} ज़ोन', ar:'الحد الأقصى {n} مناطق آمنة', he:'מקסימום {n} אזורים בטוחים' },
  'New safe zone':    { es:'Nueva zona segura', zh:'新建安全区', hi:'नया सुरक्षित क्षेत्र', ar:'منطقة آمنة جديدة', he:'אזור בטוח חדש' },
  'Edit safe zone':   { es:'Editar zona segura', zh:'编辑安全区', hi:'सुरक्षित क्षेत्र संपादित करें', ar:'تعديل المنطقة الآمنة', he:'ערוך אזור בטוח' },
  'Enter a name for this zone': { es:'Introduce un nombre', zh:'输入区域名称', hi:'इस ज़ोन का नाम दर्ज करें', ar:'أدخل اسمًا للمنطقة', he:'הזן שם לאזור' },
  'e.g. Home, Day Centre, Daughter’s': { es:'ej. Casa, Centro de día, Casa de hija', zh:'例如:家、日间中心、女儿家', hi:'जैसे घर, डे-सेंटर, बेटी का घर', ar:'مثال: البيت، مركز النهار، بيت الابنة', he:'למשל: בית, מרכז יום, בית הבת' },
  'Exit dwell time':  { es:'Tiempo de salida (dwell)', zh:'离开判定延时', hi:'एग्ज़िट ड्वेल टाइम', ar:'زمن المكوث خارج المنطقة', he:'זמן המתנה ליציאה' },
  'seconds outside before alert (0 = instant)': { es:'segundos fuera antes de alertar (0 = inmediato)', zh:'提醒前在外秒数 (0 = 立即)', hi:'अलर्ट से पहले बाहर के सेकंड (0 = तुरंत)', ar:'ثوانٍ خارج المنطقة قبل التنبيه (0 = فوري)', he:'שניות מחוץ לאזור לפני התראה (0 = מיידי)' },
  'Primary home':     { es:'Casa principal', zh:'主要居所', hi:'प्राथमिक घर', ar:'المنزل الأساسي', he:'בית ראשי' },
  'Used for the “You’re home” indicator': { es:'Usado para el indicador "Estás en casa"', zh:'用于"你在家"指示', hi:'"आप घर पर हैं" संकेतक के लिए', ar:'يُستخدم لمؤشر "أنت في المنزل"', he:'משמש לחיווי "אתה בבית"' },
  'Remove this zone': { es:'Eliminar esta zona', zh:'移除此区域', hi:'यह ज़ोन हटाएं', ar:'إزالة هذه المنطقة', he:'הסר את האזור' },
  'Remove this safe zone? You can always add it again later.': { es:'¿Eliminar esta zona segura? Puedes añadirla de nuevo más adelante.', zh:'移除此安全区? 以后可再次添加。', hi:'यह ज़ोन हटाएं? बाद में फिर जोड़ सकते हैं।', ar:'إزالة هذه المنطقة الآمنة؟ يمكنك إضافتها لاحقًا.', he:'להסיר את האזור? ניתן להוסיפו מחדש בהמשך.' },
  'Safe zone removed': { es:'Zona eliminada', zh:'已移除安全区', hi:'सुरक्षित क्षेत्र हटाया गया', ar:'تمت إزالة المنطقة الآمنة', he:'האזור הוסר' },
  'Home':             { es:'Casa', zh:'家', hi:'घर', ar:'المنزل', he:'בית' },
  'dwell':            { es:'dwell', zh:'延时', hi:'ड्वेल', ar:'مكوث', he:'המתנה' },
  '{n} active':       { es:'{n} activa(s)', zh:'{n} 个活跃', hi:'{n} सक्रिय', ar:'{n} نشطة', he:'{n} פעילים' },
  "You're at":        { es:'Estás en', zh:'你在', hi:'आप हैं', ar:'أنت في', he:'אתה ב' },
  'Outside':          { es:'Fuera de', zh:'不在', hi:'बाहर', ar:'خارج', he:'מחוץ ל' },
  "Everything OK?":   { es:'¿Todo bien?', zh:'一切正常吗?', hi:'सब ठीक है?', ar:'كل شيء على ما يرام؟', he:'הכל בסדר?' },
  "You've left":      { es:'Has salido de', zh:'你离开了', hi:'आपने छोड़ा', ar:'لقد غادرت', he:'יצאת מ' },
  'away':             { es:'de distancia', zh:'远', hi:'दूर', ar:'بعيدًا', he:'מהמרכז' },
  'Carer alerted in': { es:'Cuidador alertado en', zh:'看护者将在下面时间内收到通知', hi:'देखभालकर्ता को सूचित होगा', ar:'سيتم تنبيه المعتني خلال', he:'התראה למטפל בעוד' },
  "I'm safe ✓":       { es:'Estoy bien ✓', zh:'我安全 ✓', hi:'मैं ठीक हूँ ✓', ar:'أنا بخير ✓', he:'אני בסדר ✓' },
  'Alert carer now':  { es:'Alertar ahora', zh:'立即通知', hi:'अभी सूचित करें', ar:'تنبيه الآن', he:'התרע עכשיו' },
  'Thanks — carer will not be alerted': { es:'Gracias — no se alertará al cuidador', zh:'谢谢 — 不会通知看护者', hi:'धन्यवाद — देखभालकर्ता को सूचित नहीं किया जाएगा', ar:'شكرًا — لن يتم تنبيه المعتني', he:'תודה — המטפל לא יקבל התראה' },
  'Arrived at':       { es:'Llegó a', zh:'已到达', hi:'पहुँच गए', ar:'وصل إلى', he:'הגיע ל' },
  'Tap the map to set centre, drag the marker to adjust.': {
    es: 'Toca el mapa para fijar el centro, arrastra el marcador para ajustarlo.',
    zh: '点击地图设置中心,拖动标记微调位置。',
    hi: 'केंद्र सेट करने के लिए मानचित्र पर टैप करें, समायोजित करने के लिए मार्कर खींचें।',
    ar: 'اضغط على الخريطة لتحديد المركز، واسحب العلامة للضبط.',
    he: 'הקש על המפה לקביעת מרכז, גרור את הסמן להתאמה.'
  },
  'You':              { es:'Tú', zh:'你', hi:'आप', ar:'أنت', he:'אתה' },
  'Safe Zone needs background location permission': {
    es: 'La Zona segura necesita permiso de ubicación en segundo plano',
    zh: '安全区需要后台定位权限',
    hi: 'सुरक्षित क्षेत्र के लिए बैकग्राउंड लोकेशन अनुमति चाहिए',
    ar: 'تحتاج المنطقة الآمنة إلى إذن الموقع في الخلفية',
    he: 'אזור בטוח צריך הרשאת מיקום ברקע'
  },
  'Tap the map to set the centre of the safe zone': {
    es:'Toque el mapa para establecer el centro de la zona segura',
    zh:'点击地图以设置安全区的中心',
    hi:'सुरक्षित क्षेत्र का केंद्र सेट करने के लिए मानचित्र पर टैप करें',
    ar:'اضغط على الخريطة لتحديد مركز المنطقة الآمنة',
    he:'הקש על המפה כדי לקבוע את מרכז האזור הבטוח'
  },
  'Carers are alerted when patient leaves this area': {
    es:'Los cuidadores reciben una alerta cuando el paciente sale de esta área',
    zh:'当患者离开此区域时,看护者会收到警报',
    hi:'जब रोगी इस क्षेत्र से बाहर जाता है तो देखभालकर्ताओं को सूचित किया जाता है',
    ar:'يتم تنبيه المعتنين عندما يغادر المريض هذه المنطقة',
    he:'המטפלים מקבלים התראה כשהמטופל עוזב את האזור'
  },
  'Location permission is required for safe zones': {
    es:'Se requiere permiso de ubicación para las zonas seguras',
    zh:'安全区功能需要位置权限',
    hi:'सुरक्षित क्षेत्रों के लिए स्थान अनुमति आवश्यक है',
    ar:'يتطلب تحديد المناطق الآمنة إذن الموقع',
    he:'נדרשת הרשאת מיקום עבור אזורים בטוחים'
  },
  'Out with someone?': { es:'¿Sales con alguien?', zh:'和人外出?', hi:'किसी के साथ बाहर?', ar:'هل خرجت مع شخص ما؟', he:'יוצא עם מישהו?' },
  'Mute Safe Zone alerts while a trusted person is with you. Arrivals home are still logged.': {
    es: 'Silencia las alertas de Zona segura mientras alguien de confianza esté contigo. Las llegadas a casa se siguen registrando.',
    zh: '在信任的人陪同时静音安全区警报。到家仍会记录。',
    hi: 'जब कोई विश्वसनीय व्यक्ति आपके साथ हो तो अलर्ट म्यूट करें। घर वापसी अभी भी दर्ज होगी।',
    ar: 'كتم تنبيهات المنطقة الآمنة عندما يكون برفقتك شخص موثوق. يتم تسجيل العودة إلى المنزل.',
    he: 'השתק התראות אזור בטוח כשאדם מהימן איתך. חזרה הביתה עדיין מתועדת.'
  },
  'Alerts muted until': { es:'Alertas silenciadas hasta', zh:'警报已静音至', hi:'अलर्ट बंद हैं तक', ar:'التنبيهات مكتومة حتى', he:'התראות מושתקות עד' },
  'Currently muted until': { es:'Silenciado hasta', zh:'已静音至', hi:'अभी बंद हैं तक', ar:'مكتومة حاليًا حتى', he:'מושתקות עד' },
  'Resume alerts now': { es:'Reanudar alertas', zh:'立即恢复警报', hi:'अलर्ट पुनः सक्रिय करें', ar:'استئناف التنبيهات', he:'חידוש התראות' },
  'Safe Zone alerts resumed': { es:'Alertas reanudadas', zh:'安全区警报已恢复', hi:'अलर्ट फिर सक्रिय', ar:'استؤنفت التنبيهات', he:'ההתראות חודשו' },
  // ── Learned safe zones ──
  'Suggest zones from my activity': { es:'Sugerir zonas por actividad', zh:'根据活动推荐安全区', hi:'गतिविधि से क्षेत्र सुझाएं', ar:'اقترح مناطق من نشاطي', he:'הצע אזורים לפי הפעילות' },
  'Suggested zones':  { es:'Zonas sugeridas', zh:'推荐的安全区', hi:'सुझाए गए क्षेत्र', ar:'المناطق المقترحة', he:'אזורים מוצעים' },
  "Places you've spent significant time in the last week. Tap one to add as a zone.": {
    es: 'Lugares donde has pasado tiempo significativo en la última semana. Toca uno para añadirlo.',
    zh: '过去一周你经常待的地方。点击即可添加为安全区。',
    hi: 'पिछले हफ्ते आपने जहाँ काफी समय बिताया। टैप करके क्षेत्र में जोड़ें।',
    ar: 'أماكن قضيت فيها وقتًا كبيرًا الأسبوع الماضي. اضغط لإضافتها كمنطقة.',
    he: 'מקומות שבהם שהית הרבה בשבוע האחרון. הקש כדי להוסיפם כאזור.'
  },
  'Not enough recent activity to suggest zones yet. Keep the app running for a day or two.': {
    es: 'Aún no hay suficiente actividad. Mantén la app activa uno o dos días.',
    zh: '近期活动数据不足。请保持应用运行一两天。',
    hi: 'अभी पर्याप्त डेटा नहीं। ऐप को एक-दो दिन चलाने दें।',
    ar: 'لا يوجد نشاط كافٍ بعد. أبقِ التطبيق قيد التشغيل ليوم أو اثنين.',
    he: 'אין עדיין מספיק נתוני פעילות. השאר את האפליקציה פועלת יום-יומיים.'
  },
  'No new dwell locations found outside your current zones.': {
    es: 'No se encontraron nuevos lugares fuera de tus zonas actuales.',
    zh: '在你当前安全区之外未发现新的常驻地点。',
    hi: 'आपके मौजूदा क्षेत्रों के बाहर कोई नया स्थान नहीं मिला।',
    ar: 'لم يُعثر على أماكن تردّد جديدة خارج مناطقك الحالية.',
    he: 'לא נמצאו מקומות שהייה חדשים מחוץ לאזורים שלך.'
  },
  'Not enough recent activity': {
    es:'Actividad reciente insuficiente',
    zh:'近期活动数据不足',
    hi:'पर्याप्त हाल की गतिविधि नहीं',
    ar:'لا يوجد نشاط كافٍ مؤخرًا',
    he:'אין מספיק פעילות אחרונה'
  },
  'No new dwell locations detected': {
    es:'No se detectaron nuevos lugares de permanencia',
    zh:'未检测到新的常驻地点',
    hi:'कोई नया ठहराव स्थान नहीं मिला',
    ar:'لم يتم اكتشاف مواقع تردّد جديدة',
    he:'לא זוהו מקומות שהייה חדשים'
  },
  'Looking up places…': { es:'Buscando lugares…', zh:'正在查询地点…', hi:'स्थान खोजे जा रहे हैं…', ar:'يتم البحث عن الأماكن…', he:'מחפש מקומות…' },
  'radius':           { es:'radio', zh:'半径', hi:'त्रिज्या', ar:'نصف قطر', he:'רדיוס' },
  'Suggested zone':   { es:'Zona sugerida', zh:'推荐的安全区', hi:'सुझाया गया क्षेत्र', ar:'منطقة مقترحة', he:'אזור מוצע' },
  'Inactivity Alert': { es:'Alerta de Inactividad', zh:'无活动警报', hi:'निष्क्रियता अलर्ट', ar:'تنبيه عدم النشاط', he:'התראת חוסר פעילות' },
  // ── Emergency Info Card v2 ──
  'EMERGENCY INFO':    { es:'INFO DE EMERGENCIA', zh:'紧急信息', hi:'आपातकालीन जानकारी', ar:'معلومات الطوارئ', he:'מידע חירום' },
  'Patient':           { es:'Paciente', zh:'患者', hi:'रोगी', ar:'المريض', he:'מטופל' },
  'Identity':          { es:'Identidad', zh:'身份信息', hi:'पहचान', ar:'الهوية', he:'זהות' },
  'Medical':           { es:'Médico', zh:'医疗信息', hi:'चिकित्सा', ar:'طبي', he:'רפואי' },
  'Contacts':          { es:'Contactos', zh:'联系人', hi:'संपर्क', ar:'جهات الاتصال', he:'אנשי קשר' },
  'Other':             { es:'Otros', zh:'其他', hi:'अन्य', ar:'أخرى', he:'אחר' },
  'Field name':        { es:'Nombre del campo', zh:'字段名称', hi:'फ़ील्ड का नाम', ar:'اسم الحقل', he:'שם שדה' },
  'Value':             { es:'Valor', zh:'值', hi:'मान', ar:'القيمة', he:'ערך' },
  'Call':              { es:'Llamar', zh:'通话', hi:'कॉल', ar:'اتصال', he:'חיוג' },
  'Tap Edit to add your details.': { es:'Toca Editar para añadir tus datos.', zh:'点击“编辑”以添加信息。', hi:'विवरण जोड़ने के लिए संपादित करें टैप करें।', ar:'انقر فوق تعديل لإضافة معلوماتك.', he:'הקש על עריכה כדי להוסיף פרטים.' },
  'Current Medications': { es:'Medicación actual', zh:'当前用药', hi:'वर्तमान दवाइयाँ', ar:'الأدوية الحالية', he:'תרופות נוכחיות' },
  'No medications on file.': { es:'Sin medicamentos registrados.', zh:'未记录任何药物。', hi:'कोई दवा दर्ज नहीं।', ar:'لا توجد أدوية مسجّلة.', he:'אין תרופות רשומות.' },
  'PRN':               { es:'PRN', zh:'按需', hi:'आवश्यकतानुसार', ar:'عند الحاجة', he:'לפי הצורך' },
  'Active':            { es:'Principio', zh:'活性成分', hi:'सक्रिय तत्व', ar:'المادة الفعالة', he:'חומר פעיל' },
  'Care Team':         { es:'Equipo de cuidado', zh:'照护团队', hi:'देखभाल टीम', ar:'فريق الرعاية', he:'צוות הטיפול' },
  'No carers connected': { es:'Sin cuidadores conectados', zh:'未连接任何照护者', hi:'कोई देखभालकर्ता नहीं जुड़ा', ar:'لا يوجد مُعتنون متصلون', he:'אין מטפלים מחוברים' },
  'Patient Phone':     { es:'Teléfono del paciente', zh:'患者电话', hi:'रोगी का फ़ोन', ar:'هاتف المريض', he:'טלפון המטופל' },
  'Add Custom Field':  { es:'Añadir campo', zh:'添加自定义字段', hi:'कस्टम फ़ील्ड जोड़ें', ar:'إضافة حقل مخصص', he:'הוסף שדה מותאם' },
  'Show to Paramedic': { es:'Mostrar al paramédico', zh:'给救护员查看', hi:'पैरामेडिक को दिखाएँ', ar:'اعرض للمسعف', he:'הצג לפרמדיק' },
  'Share':             { es:'Compartir', zh:'分享', hi:'साझा करें', ar:'مشاركة', he:'שתף' },
  'Copy':              { es:'Copiar', zh:'复制', hi:'कॉपी', ar:'نسخ', he:'העתק' },
  'Edit':              { es:'Editar', zh:'编辑', hi:'संपादित करें', ar:'تعديل', he:'ערוך' },
  'Save':              { es:'Guardar', zh:'保存', hi:'सहेजें', ar:'حفظ', he:'שמור' },
  'Cancel':            { es:'Cancelar', zh:'取消', hi:'रद्द', ar:'إلغاء', he:'בטל' },
  'Remove':            { es:'Quitar', zh:'移除', hi:'हटाएँ', ar:'إزالة', he:'הסר' },
  // ── Emergency Card default field labels ──
  'Date of Birth':         { es:'Fecha de nacimiento', zh:'出生日期', hi:'जन्म तिथि', ar:'تاريخ الميلاد', he:'תאריך לידה' },
  'ID / Insurance Number': { es:'ID / Número de seguro', zh:'身份证 / 保险号', hi:'आईडी / बीमा संख्या', ar:'الهوية / رقم التأمين', he:'ת״ז / מספר ביטוח' },
  'Primary Language':      { es:'Idioma principal', zh:'主要语言', hi:'मुख्य भाषा', ar:'اللغة الأساسية', he:'שפה עיקרית' },
  'Weight (kg)':           { es:'Peso (kg)', zh:'体重 (公斤)', hi:'वजन (किग्रा)', ar:'الوزن (كغم)', he:'משקל (ק״ג)' },
  'Blood Type':            { es:'Grupo sanguíneo', zh:'血型', hi:'रक्त समूह', ar:'فصيلة الدم', he:'סוג דם' },
  'Medical Conditions':    { es:'Condiciones médicas', zh:'病情', hi:'चिकित्सीय स्थिति', ar:'الحالات الطبية', he:'מצבים רפואיים' },
  'Allergies':             { es:'Alergias', zh:'过敏', hi:'एलर्जी', ar:'الحساسية', he:'אלרגיות' },
  'Advance Directives':    { es:'Directivas anticipadas', zh:'预先医疗指示', hi:'अग्रिम निर्देश', ar:'توجيهات مسبقة', he:'הנחיות רפואיות מקדימות' },
  'Preferred Hospital':    { es:'Hospital preferido', zh:'首选医院', hi:'पसंदीदा अस्पताल', ar:'المستشفى المفضّل', he:'בית חולים מועדף' },
  'Doctor (Name & Phone)': { es:'Médico (nombre y teléfono)', zh:'医生 (姓名和电话)', hi:'डॉक्टर (नाम और फ़ोन)', ar:'الطبيب (الاسم والهاتف)', he:'רופא (שם וטלפון)' },
  'Next of Kin':           { es:'Pariente más cercano', zh:'紧急联系人', hi:'निकटतम संबंधी', ar:'أقرب الأقارب', he:'קרוב משפחה ראשון' },
  // ── Pair-request / approval flow (Phase 0 security) ──
  'Connection in progress…': { es:'Conexión en curso…', zh:'连接中…', hi:'कनेक्शन जारी है…', ar:'جارٍ الاتصال…', he:'מתחבר…' },
  'Code not found. Check and try again.': { es:'Código no encontrado. Verifica e inténtalo de nuevo.', zh:'代码未找到,请检查后重试。', hi:'कोड नहीं मिला। जाँच कर पुनः प्रयास करें।', ar:'الرمز غير موجود. تحقق وحاول مرة أخرى.', he:'הקוד לא נמצא. בדוק ונסה שוב.' },
  "That's your own code!": { es:'¡Ese es tu propio código!', zh:'这是你自己的代码!', hi:'यह आपका अपना कोड है!', ar:'هذا هو الرمز الخاص بك!', he:'זה הקוד שלך!' },
  'That code belongs to a different role.': { es:'Ese código pertenece a otro rol.', zh:'该代码属于其他角色。', hi:'यह कोड भिन्न भूमिका का है।', ar:'هذا الرمز يخصّ دورًا مختلفًا.', he:'הקוד שייך לתפקיד אחר.' },
  'Could not send pair request. Check your connection.': { es:'No se pudo enviar la solicitud. Revisa tu conexión.', zh:'无法发送配对请求。请检查网络。', hi:'जोड़ी अनुरोध नहीं भेजा जा सका। कनेक्शन जांचें।', ar:'تعذّر إرسال طلب الاقتران. تحقق من الاتصال.', he:'לא ניתן לשלוח בקשת חיבור. בדוק את הרשת.' },
  'Could not complete pairing': { es:'No se pudo completar la conexión', zh:'无法完成配对', hi:'जोड़ी पूरी नहीं हो सकी', ar:'تعذّر إتمام الاقتران', he:'לא ניתן להשלים את החיבור' },
  'Could not sign in — check your connection.': { es:'No se pudo iniciar sesión — revisa tu conexión.', zh:'无法登录 — 请检查网络。', hi:'साइन-इन विफल — कनेक्शन जांचें।', ar:'تعذّر تسجيل الدخول — تحقق من الاتصال.', he:'ההתחברות נכשלה — בדוק את הרשת.' },
  'Pair request sent to': { es:'Solicitud enviada a', zh:'配对请求已发送给', hi:'जोड़ी अनुरोध भेजा गया', ar:'تم إرسال طلب الاقتران إلى', he:'בקשת חיבור נשלחה אל' },
  'waiting for approval': { es:'esperando aprobación', zh:'等待批准', hi:'स्वीकृति प्रतीक्षित', ar:'بانتظار الموافقة', he:'ממתין לאישור' },
  'wants to connect as your': { es:'quiere conectarse como tu', zh:'希望作为你的以下身份连接:', hi:'आपके रूप में जुड़ना चाहता है:', ar:'يرغب في الاتصال بصفتك', he:'מבקש להתחבר בתור' },
  'patient':               { es:'paciente', zh:'患者', hi:'रोगी', ar:'مريض', he:'מטופל' },
  'carer':                 { es:'cuidador', zh:'照护者', hi:'देखभालकर्ता', ar:'مُعتنٍ', he:'מטפל' },
  'family member':         { es:'familiar', zh:'家人', hi:'परिजन', ar:'فرد من العائلة', he:'בן משפחה' },
  'Someone':               { es:'Alguien', zh:'某人', hi:'कोई', ar:'شخص ما', he:'מישהו' },
  'Approve':               { es:'Aprobar', zh:'批准', hi:'स्वीकारें', ar:'الموافقة', he:'אשר' },
  'Reject':                { es:'Rechazar', zh:'拒绝', hi:'अस्वीकार', ar:'رفض', he:'דחה' },
  'Paired with':           { es:'Conectado con', zh:'已配对:', hi:'जुड़ा:', ar:'تم الاقتران مع', he:'חובר עם' },
  'Pairing approved!':     { es:'¡Conexión aprobada!', zh:'配对已批准!', hi:'जोड़ी स्वीकृत!', ar:'تمت الموافقة على الاقتران!', he:'החיבור אושר!' },
  'Pair request rejected': { es:'Solicitud rechazada', zh:'请求已拒绝', hi:'अनुरोध अस्वीकृत', ar:'تم رفض الطلب', he:'הבקשה נדחתה' },
  'Pair request was rejected': { es:'Tu solicitud fue rechazada', zh:'你的请求被拒绝', hi:'आपका अनुरोध अस्वीकार कर दिया गया', ar:'تم رفض طلبك', he:'הבקשה שלך נדחתה' },
  // ── Phase 1: Auth + codes + security ──
  'Create your account':  { es:'Crea tu cuenta', zh:'创建账户', hi:'अपना खाता बनाएं', ar:'أنشئ حسابك', he:'צור את חשבונך' },
  'Log in to your account': { es:'Inicia sesión', zh:'登录你的账户', hi:'अपने खाते में लॉगिन करें', ar:'سجّل الدخول', he:'התחבר לחשבונך' },
  'Your data is protected by email and password': { es:'Tus datos están protegidos con email y contraseña', zh:'你的数据受邮箱和密码保护', hi:'आपका डेटा ईमेल और पासवर्ड से सुरक्षित है', ar:'بياناتك محمية بالبريد الإلكتروني وكلمة المرور', he:'המידע שלך מוגן בדוא״ל וסיסמה' },
  'Register':            { es:'Registrar', zh:'注册', hi:'पंजीकरण', ar:'تسجيل', he:'הרשמה' },
  'Log in':              { es:'Iniciar sesión', zh:'登录', hi:'लॉगिन', ar:'تسجيل الدخول', he:'התחברות' },
  'Email':               { es:'Correo electrónico', zh:'电子邮件', hi:'ईमेल', ar:'البريد الإلكتروني', he:'דוא״ל' },
  'Password':            { es:'Contraseña', zh:'密码', hi:'पासवर्ड', ar:'كلمة المرور', he:'סיסמה' },
  'Confirm password':    { es:'Confirmar contraseña', zh:'确认密码', hi:'पासवर्ड की पुष्टि', ar:'تأكيد كلمة المرور', he:'אשר סיסמה' },
  'Phone number (optional)': { es:'Teléfono (opcional)', zh:'电话号码 (可选)', hi:'फ़ोन नंबर (वैकल्पिक)', ar:'رقم الهاتف (اختياري)', he:'מספר טלפון (אופציונלי)' },
  'Create Account':      { es:'Crear cuenta', zh:'创建账户', hi:'खाता बनाएं', ar:'إنشاء حساب', he:'צור חשבון' },
  'Creating account…':   { es:'Creando cuenta…', zh:'正在创建账户…', hi:'खाता बना रहे हैं…', ar:'جارٍ إنشاء الحساب…', he:'יוצר חשבון…' },
  'Signing in…':         { es:'Iniciando sesión…', zh:'正在登录…', hi:'साइन इन हो रहा है…', ar:'جارٍ تسجيل الدخول…', he:'מתחבר…' },
  'Forgot password?':    { es:'¿Olvidaste tu contraseña?', zh:'忘记密码？', hi:'पासवर्ड भूल गए?', ar:'نسيت كلمة المرور؟', he:'שכחת סיסמה?' },
  'Please enter a valid email address': { es:'Ingresa un email válido', zh:'请输入有效的电子邮件', hi:'कृपया मान्य ईमेल दर्ज करें', ar:'أدخل بريدًا إلكترونيًا صالحًا', he:'נא הזן כתובת דוא״ל תקינה' },
  'Password must be at least 8 characters': { es:'La contraseña debe tener al menos 8 caracteres', zh:'密码至少需要 8 个字符', hi:'पासवर्ड कम से कम 8 अक्षर का होना चाहिए', ar:'يجب أن تكون كلمة المرور 8 أحرف على الأقل', he:'הסיסמה חייבת להיות 8 תווים לפחות' },
  'Password must contain both letters and numbers': { es:'La contraseña debe contener letras y números', zh:'密码必须包含字母和数字', hi:'पासवर्ड में अक्षर और अंक दोनों होने चाहिए', ar:'يجب أن تحتوي كلمة المرور على حروف وأرقام', he:'הסיסמה חייבת לכלול אותיות ומספרים' },
  'Passwords do not match': { es:'Las contraseñas no coinciden', zh:'密码不匹配', hi:'पासवर्ड मेल नहीं खाते', ar:'كلمتا المرور غير متطابقتين', he:'הסיסמאות אינן תואמות' },
  'Please accept the data consent to continue': { es:'Acepta el consentimiento para continuar', zh:'请接受数据同意以继续', hi:'जारी रखने के लिए सहमति दें', ar:'يرجى قبول الموافقة على البيانات للمتابعة', he:'נא לאשר את הסכמת הנתונים כדי להמשיך' },
  'Account created! A verification email has been sent.': { es:'¡Cuenta creada! Se envió un email de verificación.', zh:'账户已创建！验证邮件已发送。', hi:'खाता बन गया! सत्यापन ईमेल भेजा गया।', ar:'تم إنشاء الحساب! تم إرسال بريد التحقق.', he:'החשבון נוצר! נשלח דוא״ל לאימות.' },
  'Password reset email sent. Check your inbox.': { es:'Email de restablecimiento enviado. Revisa tu bandeja.', zh:'密码重置邮件已发送。请检查收件箱。', hi:'पासवर्ड रीसेट ईमेल भेजा गया। अपना इनबॉक्स जांचें।', ar:'تم إرسال بريد إعادة تعيين كلمة المرور. تحقق من بريدك.', he:'נשלח דוא״ל לאיפוס סיסמה. בדוק את תיבת הדואר.' },
  'This email is already registered. Try logging in.': { es:'Este email ya está registrado. Intenta iniciar sesión.', zh:'该邮箱已注册。请尝试登录。', hi:'यह ईमेल पहले से पंजीकृत है। लॉगिन करें।', ar:'هذا البريد مسجل بالفعل. حاول تسجيل الدخول.', he:'הדוא״ל הזה כבר רשום. נסה להתחבר.' },
  'No account found with this email': { es:'No se encontró cuenta con este email', zh:'未找到此邮箱对应的账户', hi:'इस ईमेल से कोई खाता नहीं मिला', ar:'لم يُعثر على حساب بهذا البريد', he:'לא נמצא חשבון עם דוא״ל זה' },
  'Incorrect password':  { es:'Contraseña incorrecta', zh:'密码错误', hi:'गलत पासवर्ड', ar:'كلمة المرور غير صحيحة', he:'סיסמה שגויה' },
  'Too many attempts. Please wait a moment and try again.': { es:'Demasiados intentos. Espera y vuelve a intentar.', zh:'尝试次数过多。请稍后重试。', hi:'बहुत अधिक प्रयास। कुछ देर बाद पुनः प्रयास करें।', ar:'محاولات كثيرة. انتظر لحظة ثم حاول مجددًا.', he:'יותר מדי ניסיונות. המתן רגע ונסה שוב.' },
  'Network error — check your connection': { es:'Error de red — revisa tu conexión', zh:'网络错误 — 检查连接', hi:'नेटवर्क त्रुटि — कनेक्शन जांचें', ar:'خطأ في الشبكة — تحقق من الاتصال', he:'שגיאת רשת — בדוק את החיבור' },
  'Something went wrong': { es:'Algo salió mal', zh:'出错了', hi:'कुछ गलत हो गया', ar:'حدث خطأ ما', he:'משהו השתבש' },
  'Sign out? You will need your email and password to sign back in.': { es:'¿Cerrar sesión? Necesitarás tu email y contraseña para volver.', zh:'退出登录？重新登录需要邮箱和密码。', hi:'साइन आउट? वापस आने के लिए ईमेल और पासवर्ड चाहिए।', ar:'تسجيل الخروج؟ ستحتاج بريدك وكلمة مرورك للعودة.', he:'להתנתק? תצטרך דוא״ל וסיסמה כדי לחזור.' },
  'Sign Out':            { es:'Cerrar sesión', zh:'退出', hi:'साइन आउट', ar:'تسجيل الخروج', he:'התנתק' },
  'Weak':                { es:'Débil', zh:'弱', hi:'कमज़ोर', ar:'ضعيفة', he:'חלשה' },
  'Fair':                { es:'Regular', zh:'一般', hi:'ठीक', ar:'مقبولة', he:'סבירה' },
  'Strong':              { es:'Fuerte', zh:'强', hi:'मज़बूत', ar:'قوية', he:'חזקה' },
  'Code copied':         { es:'Código copiado', zh:'代码已复制', hi:'कोड कॉपी हुआ', ar:'تم نسخ الرمز', he:'הקוד הועתק' },
  'Enter PIN':           { es:'Ingresa PIN', zh:'输入 PIN', hi:'PIN दर्ज करें', ar:'أدخل رمز PIN', he:'הזן קוד PIN' },
  'Incorrect PIN':       { es:'PIN incorrecto', zh:'PIN 错误', hi:'गलत PIN', ar:'رمز PIN غير صحيح', he:'קוד PIN שגוי' },
  'Settings PIN Lock':   { es:'Bloqueo PIN de ajustes', zh:'设置 PIN 锁', hi:'सेटिंग्स PIN लॉक', ar:'قفل PIN للإعدادات', he:'נעילת PIN להגדרות' },
  'Protect settings with a 4-digit PIN': { es:'Protege los ajustes con un PIN de 4 dígitos', zh:'用 4 位 PIN 保护设置', hi:'4-अंकीय PIN से सेटिंग्स सुरक्षित करें', ar:'احمِ الإعدادات برمز PIN من 4 أرقام', he:'הגן על ההגדרות עם PIN בן 4 ספרות' },
  'Choose a 4-digit PIN to lock Settings:': { es:'Elige un PIN de 4 dígitos:', zh:'选择 4 位 PIN 来锁定设置:', hi:'सेटिंग्स लॉक के लिए 4-अंकीय PIN चुनें:', ar:'اختر رمز PIN من 4 أرقام:', he:'בחר קוד PIN בן 4 ספרות:' },
  'Confirm your PIN:':   { es:'Confirma tu PIN:', zh:'确认 PIN:', hi:'अपना PIN पुष्ट करें:', ar:'أكد رمز PIN:', he:'אשר את ה-PIN:' },
  'PIN must be exactly 4 digits': { es:'El PIN debe tener 4 dígitos', zh:'PIN 必须是 4 位数字', hi:'PIN 4 अंकों का होना चाहिए', ar:'يجب أن يكون PIN من 4 أرقام', he:'ה-PIN חייב להיות 4 ספרות בדיוק' },
  'PINs do not match':   { es:'Los PINs no coinciden', zh:'PIN 不匹配', hi:'PIN मेल नहीं खाते', ar:'رموز PIN غير متطابقة', he:'קודי ה-PIN אינם תואמים' },
  'PIN set':             { es:'PIN establecido', zh:'PIN 已设置', hi:'PIN सेट हो गया', ar:'تم تعيين PIN', he:'ה-PIN הוגדר' },
  'Remove the PIN lock from Settings?': { es:'¿Quitar el bloqueo PIN?', zh:'移除设置 PIN 锁？', hi:'सेटिंग्स से PIN लॉक हटाएं?', ar:'إزالة قفل PIN؟', he:'להסיר את נעילת ה-PIN?' },
  'PIN removed':         { es:'PIN eliminado', zh:'PIN 已移除', hi:'PIN हटाया गया', ar:'تمت إزالة PIN', he:'ה-PIN הוסר' },
  'Forgot PIN?':         { es:'¿Olvidaste el PIN?', zh:'忘记 PIN?', hi:'PIN भूल गए?', ar:'نسيت رمز PIN؟', he:'שכחת PIN?' },
  'No email account linked — cannot reset PIN.': { es:'Sin cuenta de email — no se puede restablecer.', zh:'未关联邮箱 — 无法重置 PIN。', hi:'कोई ईमेल खाता नहीं — PIN रीसेट नहीं हो सकता।', ar:'لا يوجد حساب بريد — لا يمكن إعادة تعيين PIN.', he:'אין חשבון דוא״ל — לא ניתן לאפס PIN.' },
  'Enter your account password to reset PIN:': { es:'Ingresa tu contraseña para restablecer el PIN:', zh:'输入账户密码以重置 PIN:', hi:'PIN रीसेट के लिए अपना पासवर्ड दर्ज करें:', ar:'أدخل كلمة مرور حسابك لإعادة تعيين PIN:', he:'הזן את סיסמת החשבון לאיפוס PIN:' },
  'PIN cleared — you can set a new one in Settings.': { es:'PIN eliminado — puedes configurar uno nuevo en Ajustes.', zh:'PIN 已清除 — 可在设置中重新设置。', hi:'PIN साफ — सेटिंग्स में नया सेट करें।', ar:'تم مسح PIN — يمكنك تعيين واحد جديد في الإعدادات.', he:'ה-PIN נמחק — ניתן להגדיר חדש בהגדרות.' },
  'Could not verify — check your connection.': { es:'No se pudo verificar — revisa tu conexión.', zh:'无法验证 — 检查网络。', hi:'सत्यापन विफल — कनेक्शन जांचें।', ar:'تعذّر التحقق — تحقق من الاتصال.', he:'לא ניתן לאמת — בדוק את החיבור.' },
  'Please enter your pair code': { es:'Ingresa el código de conexión', zh:'请输入配对代码', hi:'अपना पेयर कोड दर्ज करें', ar:'أدخل رمز الاقتران', he:'נא הזן את קוד ההתאמה' },
  'Account':             { es:'Cuenta', zh:'账户', hi:'खाता', ar:'الحساب', he:'חשבון' },
  'Security':            { es:'Seguridad', zh:'安全', hi:'सुरक्षा', ar:'الأمان', he:'אבטחה' },
  'I agree to the collection and use of my care data as described in the app. My information will only be shared with my connected carers.': {
    es: 'Acepto la recopilación y uso de mis datos de cuidado según lo descrito en la aplicación. Mi información solo se compartirá con mis cuidadores conectados.',
    zh: '我同意按应用所述收集和使用我的护理数据。我的信息仅与我连接的照护者共享。',
    hi: 'मैं ऐप में वर्णित अनुसार अपने देखभाल डेटा के संग्रह और उपयोग से सहमत हूं। मेरी जानकारी केवल मेरे जुड़े देखभालकर्ताओं के साथ साझा की जाएगी।',
    ar: 'أوافق على جمع واستخدام بيانات رعايتي كما هو موضح في التطبيق. لن تتم مشاركة معلوماتي إلا مع المُعتنين المتصلين بي.',
    he: 'אני מסכים/ה לאיסוף ולשימוש במידע הטיפולי שלי כמתואר באפליקציה. המידע ישותף רק עם המטפלים המחוברים אליי.'
  },
  'Your pair code was refreshed:': { es:'Tu código se ha actualizado:', zh:'你的配对代码已刷新:', hi:'आपका पेयर कोड अद्यतन हुआ:', ar:'تم تحديث رمز الاقتران:', he:'קוד ההתאמה שלך עודכן:' },
  'Could not connect — please try again.': { es:'No se pudo conectar — inténtalo de nuevo.', zh:'无法连接 — 请重试。', hi:'कनेक्ट नहीं हो सका — पुनः प्रयास करें।', ar:'تعذّر الاتصال — حاول مرة أخرى.', he:'לא ניתן להתחבר — נסה שוב.' },
  'Connected!':           { es:'¡Conectado!', zh:'已连接!', hi:'कनेक्ट हो गया!', ar:'تم الاتصال!', he:'מחובר!' },
  'You are now paired with': { es:'Ahora estás conectado con', zh:'您已与以下用户配对:', hi:'अब आप जुड़े हुए हैं', ar:'أنت الآن مقترن مع', he:'אתה מחובר כעת עם' },
  'as your':              { es:'como tu', zh:'作为你的', hi:'के रूप में', ar:'بصفتك', he:'בתור' },
  'Copied to clipboard': { es:'Copiado al portapapeles', zh:'已复制到剪贴板', hi:'क्लिपबोर्ड पर कॉपी हुआ', ar:'تم النسخ إلى الحافظة', he:'הועתק ללוח' },
  'Copy failed':       { es:'Error al copiar', zh:'复制失败', hi:'कॉपी विफल', ar:'فشل النسخ', he:'ההעתקה נכשלה' },
  'Emergency info saved': { es:'Información de emergencia guardada', zh:'紧急信息已保存', hi:'आपातकालीन जानकारी सहेजी गई', ar:'تم حفظ معلومات الطوارئ', he:'מידע חירום נשמר' },
  // ── Handoff Notes v2 ──
  'Shift Handoff Note': { es:'Nota de cambio de turno', zh:'交班笔记', hi:'शिफ्ट हैंडओवर नोट', ar:'ملاحظة تسليم المناوبة', he:'הערת חילופי משמרת' },
  'Write a note for the next carer coming on duty': { es:'Escribe una nota para el próximo cuidador', zh:'给下一班照护者留言', hi:'अगले देखभालकर्ता के लिए नोट लिखें', ar:'اكتب ملاحظة للمُعتني التالي', he:'כתוב הערה למטפל הבא במשמרת' },
  'Past 24h':          { es:'Últimas 24 h', zh:'过去 24 小时', hi:'पिछले 24 घंटे', ar:'آخر 24 ساعة', he:'24 השעות האחרונות' },
  'Quiet shift — nothing logged.': { es:'Turno tranquilo — sin registros.', zh:'班次平静 — 无记录。', hi:'शांत शिफ्ट — कुछ दर्ज नहीं।', ar:'مناوبة هادئة — لا سجلات.', he:'משמרת שקטה — אין רישום.' },
  'call':              { es:'llamada', zh:'次呼叫', hi:'कॉल', ar:'مكالمة', he:'שיחה' },
  'calls':             { es:'llamadas', zh:'次呼叫', hi:'कॉल', ar:'مكالمات', he:'שיחות' },
  'falls':             { es:'caídas', zh:'次摔倒', hi:'गिरने की घटनाएँ', ar:'حالات سقوط', he:'נפילות' },
  'meds taken':        { es:'dosis tomadas', zh:'次服药', hi:'खुराकें ली गईं', ar:'جرعات تم تناولها', he:'מנות שנלקחו' },
  'missed':            { es:'omitidas', zh:'次漏服', hi:'छूटीं', ar:'فائتة', he:'הוחמצו' },
  'zone exits':        { es:'salidas de zona', zh:'次离开安全区', hi:'क्षेत्र से बाहर', ar:'خروج من المنطقة', he:'יציאות מאזור' },
  'Mood':              { es:'Ánimo', zh:'情绪', hi:'मनोदशा', ar:'المزاج', he:'מצב רוח' },
  'Sleep':             { es:'Sueño', zh:'睡眠', hi:'नींद', ar:'النوم', he:'שינה' },
  'Appetite':          { es:'Apetito', zh:'食欲', hi:'भूख', ar:'الشهية', he:'תיאבון' },
  'Mobility':          { es:'Movilidad', zh:'活动能力', hi:'गतिशीलता', ar:'الحركة', he:'ניידות' },
  'Meds':              { es:'Medicación', zh:'用药', hi:'दवाएँ', ar:'الأدوية', he:'תרופות' },
  'Note':              { es:'Nota', zh:'备注', hi:'नोट', ar:'ملاحظة', he:'הערה' },
  'e.g. Patient had a rough night, needed help 3x. Left water by bedside. Check medication at 2pm.': {
    es: 'p. ej. Noche difícil, pidió ayuda 3 veces. Dejé agua en la mesilla. Revisar medicación a las 14:00.',
    zh: '例如: 昨晚较差,3 次呼叫。床边留了水。下午 2 点检查用药。',
    hi: 'उदा. रात कठिन थी, 3 बार मदद मांगी। पलंग के पास पानी रखा। 2 बजे दवा देखें।',
    ar: 'مثال: ليلة صعبة، طلب مساعدة 3 مرات. وضعت ماءً بجانب السرير. تحقق من الدواء في الساعة الثانية ظهرًا.',
    he: 'למשל: לילה לא קל, ביקש עזרה 3 פעמים. השארתי מים ליד המיטה. בדוק תרופה ב-14:00.'
  },
  'Normal note':       { es:'Nota normal', zh:'普通备注', hi:'सामान्य नोट', ar:'ملاحظة عادية', he:'הערה רגילה' },
  'Important — needs attention': { es:'Importante — requiere atención', zh:'重要 — 需要关注', hi:'महत्वपूर्ण — ध्यान दें', ar:'مهم — يتطلب الانتباه', he:'חשוב — דורש תשומת לב' },
  'Urgent — act immediately': { es:'Urgente — actuar de inmediato', zh:'紧急 — 立即处理', hi:'तत्काल — तुरंत कार्रवाई', ar:'عاجل — تصرف فورًا', he:'דחוף — פעל מיד' },
  'Save Note':         { es:'Guardar nota', zh:'保存备注', hi:'नोट सहेजें', ar:'حفظ الملاحظة', he:'שמור הערה' },
  'Skip':              { es:'Omitir', zh:'跳过', hi:'छोड़ें', ar:'تخطَّ', he:'דלג' },
  'Care note saved':   { es:'Nota guardada', zh:'备注已保存', hi:'नोट सहेजा गया', ar:'تم حفظ الملاحظة', he:'ההערה נשמרה' },
  'Tap "Got it" to dismiss': { es:'Toca "Entendido" para descartar', zh:'点击“知道了”关闭', hi:'बंद करने के लिए “मिल गया” टैप करें', ar:'اضغط "فهمت" للإخفاء', he:'הקש "הבנתי" לסגירה' },
  'Tap to dismiss':    { es:'Toca para descartar', zh:'点击关闭', hi:'बंद करने के लिए टैप करें', ar:'اضغط للإخفاء', he:'הקש כדי לסגור' },
  'Got it':            { es:'Entendido', zh:'知道了', hi:'मिल गया', ar:'فهمت', he:'הבנתי' },
  'Reply':             { es:'Responder', zh:'回复', hi:'उत्तर दें', ar:'الرد', he:'השב' },
  'Acknowledged':      { es:'Confirmado', zh:'已确认', hi:'स्वीकार किया', ar:'تم التأكيد', he:'אושר' },
  'Shift Note':        { es:'Nota de turno', zh:'交班笔记', hi:'शिफ्ट नोट', ar:'ملاحظة المناوبة', he:'הערת משמרת' },
  'Read by':           { es:'Leído por', zh:'已读', hi:'पढ़ा', ar:'قرأها', he:'נקרא על ידי' },
  'Your account is not yet secured — tap to register with email.': { es:'Tu cuenta aún no está protegida — toca para registrarte con email.', zh:'您的帐户尚未保护 — 点击以使用电子邮件注册。', hi:'आपका खाता अभी सुरक्षित नहीं है — ईमेल से रजिस्टर करने के लिए टैप करें।', ar:'حسابك غير مؤمّن بعد — انقر للتسجيل بالبريد الإلكتروني.', he:'החשבון שלך עדיין לא מאובטח — הקש כדי להירשם עם אימייל.' },
  // ── Phase 7 UX Polish ──
  'Calling': { es:'Llamando', zh:'呼叫', hi:'कॉल कर रहे हैं', ar:'جارٍ الاتصال', he:'מתקשר אל' },
  'Paging backup carer…': { es:'Llamando cuidador de respaldo…', zh:'呼叫备用护理员…', hi:'बैकअप केयरर को पेज कर रहे हैं…', ar:'استدعاء مُعتنٍ احتياطي…', he:'מזעיק מטפל גיבוי…' },
  'No medications yet. Tap + Add to set up reminders.': { es:'Sin medicamentos aún. Toca + Añadir para configurar recordatorios.', zh:'暂无药物。点击 + 添加以设置提醒。', hi:'अभी कोई दवाई नहीं। रिमाइंडर सेट करने के लिए + जोड़ें टैप करें।', ar:'لا أدوية بعد. اضغط + إضافة لإعداد التذكيرات.', he:'אין תרופות עדיין. הקש + הוסף כדי להגדיר תזכורות.' },
  'No connections yet — enter a pair code below to connect.': { es:'Sin conexiones aún — ingresa un código abajo para conectar.', zh:'暂无连接 — 在下方输入配对码以连接。', hi:'अभी कोई कनेक्शन नहीं — कनेक्ट करने के लिए नीचे पेयर कोड दर्ज करें।', ar:'لا اتصالات بعد — أدخل رمز الاقتران أدناه للاتصال.', he:'אין חיבורים עדיין — הזן קוד התאמה למטה כדי להתחבר.' },
  'Camera not available — you can type the code manually instead.': { es:'Cámara no disponible — puedes escribir el código manualmente.', zh:'摄像头不可用 — 你可以手动输入代码。', hi:'कैमरा उपलब्ध नहीं — आप कोड मैन्युअली टाइप कर सकते हैं।', ar:'الكاميرا غير متاحة — يمكنك كتابة الرمز يدويًا.', he:'המצלמה אינה זמינה — ניתן להקליד את הקוד ידנית.' },
  'Basic': { es:'Básico', zh:'基本', hi:'बुनियादी', ar:'أساسي', he:'בסיסי' },
  'Advanced': { es:'Avanzado', zh:'高级', hi:'उन्नत', ar:'متقدم', he:'מתקדם' },
  'Filter settings…': { es:'Filtrar ajustes…', zh:'筛选设置…', hi:'सेटिंग्स फ़िल्टर करें…', ar:'تصفية الإعدادات…', he:'סנן הגדרות…' },
  // ── Connectivity hardening (auth, emergency, phone, presence) ──
  'Session Expired': { es:'Sesión expirada', zh:'会话已过期', hi:'सत्र समाप्त', ar:'انتهت الجلسة', he:'הפגישה פגה' },
  'Please sign in again to continue': { es:'Inicia sesión de nuevo para continuar', zh:'请重新登录以继续', hi:'जारी रखने के लिए कृपया फिर से साइन इन करें', ar:'يرجى تسجيل الدخول مجدداً للمتابعة', he:'אנא התחבר שוב כדי להמשיך' },
  'Sign In': { es:'Iniciar sesión', zh:'登录', hi:'साइन इन करें', ar:'تسجيل الدخول', he:'התחבר' },
  'Session expired — please sign in': { es:'Sesión expirada — inicia sesión', zh:'会话已过期 — 请登录', hi:'सत्र समाप्त — कृपया साइन इन करें', ar:'انتهت الجلسة — يرجى تسجيل الدخول', he:'הפגישה פגה — אנא התחבר' },
  'No carer responded': { es:'Ningún cuidador respondió', zh:'没有护理员回应', hi:'किसी केयरर ने जवाब नहीं दिया', ar:'لم يستجب أي مُعتنٍ', he:'אף מטפל לא הגיב' },
  'Try reaching them by phone, or call emergency services.': { es:'Intenta llamarles por teléfono o llama a emergencias.', zh:'请尝试直接拨打电话，或拨打急救电话。', hi:'फ़ोन से संपर्क करें, या आपातकालीन सेवाओं को कॉल करें।', ar:'حاول الاتصال بهم هاتفيًا، أو اتصل بالطوارئ.', he:'נסה להתקשר אליהם ישירות, או חייג לשירותי חירום.' },
  'Try calling directly:': { es:'Intenta llamar directamente:', zh:'直接拨打电话:', hi:'सीधे कॉल करें:', ar:'حاول الاتصال مباشرة:', he:'נסה להתקשר ישירות:' },
  'Call Emergency': { es:'Llamar emergencias', zh:'拨打急救', hi:'आपातकालीन कॉल', ar:'اتصل بالطوارئ', he:'חיוג חירום' },
  'Call emergency services?': { es:'¿Llamar a servicios de emergencia?', zh:'拨打急救电话？', hi:'आपातकालीन सेवाओं को कॉल करें?', ar:'الاتصال بخدمات الطوارئ؟', he:'להתקשר לשירותי חירום?' },
  'Emergency Number': { es:'Número de emergencia', zh:'急救号码', hi:'आपातकालीन नंबर', ar:'رقم الطوارئ', he:'מספר חירום' },
  'Emergency number:': { es:'Número de emergencia:', zh:'急救号码：', hi:'आपातकालीन नंबर:', ar:'رقم الطوارئ:', he:'מספר חירום:' },
  'Emergency number updated': { es:'Número de emergencia actualizado', zh:'急救号码已更新', hi:'आपातकालीन नंबर अपडेट किया गया', ar:'تم تحديث رقم الطوارئ', he:'מספר חירום עודכן' },
  'Add Your Phone Number': { es:'Agrega tu número de teléfono', zh:'添加您的电话号码', hi:'अपना फ़ोन नंबर जोड़ें', ar:'أضف رقم هاتفك', he:'הוסף את מספר הטלפון שלך' },
  'Your patient needs your phone number as a safety fallback.': { es:'Tu paciente necesita tu número como respaldo de seguridad.', zh:'您的患者需要您的电话号码作为安全备用。', hi:'आपके मरीज को सुरक्षा फ़ॉलबैक के रूप में आपके फ़ोन नंबर की आवश्यकता है।', ar:'يحتاج مريضك إلى رقم هاتفك كاحتياط للسلامة.', he:'המטופל שלך צריך את מספר הטלפון שלך כגיבוי בטיחותי.' },
  'Skip for now': { es:'Omitir por ahora', zh:'暂时跳过', hi:'अभी के लिए छोड़ें', ar:'تخطّ الآن', he:'דלג לעת עתה' },
  'No phone — offline calls won\'t reach this carer': { es:'Sin teléfono — las llamadas offline no llegarán a este cuidador', zh:'无电话 — 离线呼叫无法联系此护理员', hi:'कोई फ़ोन नहीं — ऑफ़लाइन कॉल इस केयरर तक नहीं पहुंचेगी', ar:'بدون هاتف — المكالمات بلا إنترنت لن تصل هذا المُعتني', he:'ללא טלפון — שיחות ללא חיבור לא יגיעו למטפל זה' },
  'Some carers don\'t have phone numbers set — offline fallback may not work.': { es:'Algunos cuidadores no tienen teléfono — el respaldo offline puede no funcionar.', zh:'部分护理员未设置电话号码 — 离线备用可能无法使用。', hi:'कुछ केयरर्स के पास फ़ोन नंबर नहीं हैं — ऑफ़लाइन फ़ॉलबैक काम नहीं कर सकता।', ar:'بعض المُعتنين ليس لديهم أرقام هواتف — الاحتياط بلا إنترنت قد لا يعمل.', he:'לחלק מהמטפלים אין מספרי טלפון — גיבוי ללא חיבור עשוי לא לעבוד.' },
  'last seen': { es:'visto por última vez', zh:'最后在线', hi:'आखिरी बार देखा गया', ar:'آخر ظهور', he:'נראה לאחרונה' },
  'Dismiss': { es:'Cerrar', zh:'关闭', hi:'खारिज करें', ar:'إغلاق', he:'סגור' },
  // ── Remote Patient Settings (carer-side) ──
  'Patient Settings': { es:'Ajustes del Paciente', zh:'患者设置', hi:'मरीज सेटिंग्स', ar:'إعدادات المريض', he:'הגדרות מטופל' },
  'Remote Patient Settings': { es:'Ajustes Remotos del Paciente', zh:'远程患者设置', hi:'रिमोट मरीज सेटिंग्स', ar:'إعدادات المريض عن بُعد', he:'הגדרות מטופל מרחוק' },
  'Location sharing': { es:'Compartir ubicación', zh:'位置共享', hi:'स्थान साझा करना', ar:'مشاركة الموقع', he:'שיתוף מיקום' },
  'Safe zone monitoring': { es:'Monitoreo de zona segura', zh:'安全区监控', hi:'सुरक्षित क्षेत्र निगरानी', ar:'مراقبة المنطقة الآمنة', he:'ניטור אזור בטוח' },
  'Emergency Info': { es:'Info de Emergencia', zh:'急救信息', hi:'आपातकालीन जानकारी', ar:'معلومات الطوارئ', he:'מידע חירום' },
  'Configure': { es:'Configurar', zh:'配置', hi:'कॉन्फ़िगर करें', ar:'تكوين', he:'הגדר' },
  'Check-ins, alerts, location, emergency info': { es:'Check-ins, alertas, ubicación, info de emergencia', zh:'签到、警报、位置、急救信息', hi:'चेक-इन, अलर्ट, स्थान, आपातकालीन जानकारी', ar:'فحوصات، تنبيهات، موقع، معلومات طوارئ', he:'בדיקות, התראות, מיקום, מידע חירום' },
  'Changes apply immediately on the patient\'s device.': { es:'Los cambios se aplican inmediatamente en el dispositivo del paciente.', zh:'更改会立即应用到患者的设备上。', hi:'परिवर्तन तुरंत मरीज के डिवाइस पर लागू होते हैं।', ar:'التغييرات تُطبَّق فورًا على جهاز المريض.', he:'השינויים חלים מיד במכשיר המטופל.' },
  'Configure check-ins, inactivity alerts, location, and emergency info for your patients remotely.': { es:'Configure check-ins, alertas de inactividad, ubicación e info de emergencia de sus pacientes de forma remota.', zh:'远程配置患者的签到、无活动警报、位置和急救信息。', hi:'अपने मरीजों की चेक-इन, निष्क्रियता अलर्ट, स्थान और आपातकालीन जानकारी को दूर से कॉन्फ़िगर करें।', ar:'قم بتكوين الفحوصات وتنبيهات عدم النشاط والموقع ومعلومات الطوارئ لمرضاك عن بُعد.', he:'הגדר מרחוק בדיקות, התראות חוסר פעילות, מיקום ומידע חירום עבור מטופליך.' },
  'Patient settings': { es:'Ajustes del paciente', zh:'患者设置', hi:'मरीज सेटिंग्स', ar:'إعدادات المريض', he:'הגדרות מטופל' },
  'to': { es:'a', zh:'至', hi:'से', ar:'إلى', he:'עד' },
  // ── Temp Carer Toggle ──
  'Step in as Carer':  { es:'Actuar como Cuidador', zh:'临时担任护理员', hi:'केयरर के रूप में कार्य करें', ar:'تولَّ دور المُعتني', he:'פעל כמטפל זמני' },
  'Back to Observer':  { es:'Volver a Observador', zh:'返回观察者模式', hi:'पर्यवेक्षक मोड पर वापस', ar:'العودة للمراقبة', he:'חזרה למצב צפייה' },
  'You are now acting as a temporary carer': { es:'Ahora actúas como cuidador temporal', zh:'您现在是临时护理员', hi:'आप अब अस्थायी केयरर के रूप में कार्य कर रहे हैं', ar:'أنت الآن تعمل كمُعتنٍ مؤقت', he:'אתה פועל כעת כמטפל זמני' },
  'Back to observer mode': { es:'De vuelta al modo observador', zh:'已返回观察者模式', hi:'पर्यवेक्षक मोड पर वापस', ar:'العودة لوضع المراقبة', he:'חזרה למצב צפייה' },
  'You are acting as a temporary carer': { es:'Estás actuando como cuidador temporal', zh:'您正在作为临时护理员', hi:'आप अस्थायी केयरर के रूप में कार्य कर रहे हैं', ar:'أنت تعمل كمُعتنٍ مؤقت', he:'אתה פועל כמטפל זמני' },
  'Temporary Carer':   { es:'Cuidador Temporal', zh:'临时护理员', hi:'अस्थायी केयरर', ar:'مُعتنٍ مؤقت', he:'מטפל זמני' },
  'Temporarily act as a carer to receive and respond to calls': { es:'Actúa temporalmente como cuidador para recibir y responder llamadas', zh:'临时担任护理员以接收和回应呼叫', hi:'कॉल प्राप्त करने और जवाब देने के लिए अस्थायी रूप से केयरर के रूप में कार्य करें', ar:'تولَّ دور المُعتني مؤقتاً لتلقي المكالمات والرد عليها', he:'פעל באופן זמני כמטפל כדי לקבל ולהגיב לשיחות' },
  'On':  { es:'Encendido', zh:'开', hi:'चालू', ar:'مُفعَّل', he:'פעיל' },
  'Off': { es:'Apagado', zh:'关', hi:'बंद', ar:'مُعطَّل', he:'כבוי' },
  // ── UX Polish additions ──
  'Voice activation': { es:'Activación de voz', zh:'语音激活', hi:'वॉयस एक्टिवेशन', ar:'التنشيط الصوتي', he:'הפעלה קולית' },
  'Voice activation ON': { es:'Activación de voz ENCENDIDA', zh:'语音激活已开启', hi:'वॉयस एक्टिवेशन चालू', ar:'التنشيط الصوتي مُفعَّل', he:'הפעלה קולית מופעלת' },
  'Already in a call': { es:'Ya en una llamada', zh:'正在通话中', hi:'पहले से कॉल में', ar:'في مكالمة بالفعل', he:'כבר בשיחה' },
  'Password is too weak — use at least 8 characters with letters and numbers': { es:'Contraseña demasiado débil — usa al menos 8 caracteres con letras y números', zh:'密码太弱 — 请使用至少8个包含字母和数字的字符', hi:'पासवर्ड बहुत कमज़ोर — कम से कम 8 अक्षर, अक्षरों और अंकों के साथ उपयोग करें', ar:'كلمة المرور ضعيفة جدًا — استخدم 8 أحرف على الأقل مع حروف وأرقام', he:'הסיסמה חלשה מדי — השתמש ב-8 תווים לפחות עם אותיות ומספרים' },
  'Monitoring': { es:'Monitoreando', zh:'正在监控', hi:'निगरानी कर रहे हैं', ar:'مراقبة', he:'מנטר' },
  'patients': { es:'pacientes', zh:'位患者', hi:'मरीज़', ar:'مرضى', he:'מטופלים' },
  'Dashboard': { es:'Panel', zh:'仪表板', hi:'डैशबोर्ड', ar:'لوح�� المعلومات', he:'לוח בקרה' },
  'Speech recognition not available': { es:'Reconocimiento de voz no disponible', zh:'语音识别不可用', hi:'वाक् पहचान उपलब्ध नहीं', ar:'التعرف على الكلام غير متاح', he:'זיהוי דיבור אינו זמין' },
  'Voice recognition not available': { es:'Reconocimiento de voz no disponible', zh:'语音识别不可用', hi:'वॉयस ���हचान उपलब्ध नहीं', ar:'التعرف على الصوت غير متاح', he:'זיהוי קולי אינו זמין' },
  'No motion data received — sensor may not be available': { es:'No se recibieron datos de movimiento — el sensor puede no estar disponible', zh:'未收到运动数据 — 传感器可能不可用', hi:'कोई मोशन डेटा प्राप्त नहीं हुआ — सेंसर उपलब्ध नहीं हो सकता', ar:'لم يتم استقبال بيانات الحركة — قد لا يكون المستشعر متاحًا', he:'לא התקבלו נתוני תנועה — ייתכן שהחיישן אינו זמין' },
  'Could not access motion sensors': { es:'No se pudo acceder a los sensores de movimiento', zh:'无法访问运动传感器', hi:'मोशन सेंसर तक पहुँच नहीं हो सकी', ar:'تعذر الوصول إلى مستشعرات الحركة', he:'לא ניתן לגשת לחיישני תנועה' },
  'Test notification sent. If nothing appears, check device notification settings.': { es:'Notificación de prueba enviada. Si no aparece, revisa la configuración de notificaciones.', zh:'测试通知已发送。如未显示,请检查设备通知设置。', hi:'टेस्ट नोटिफिकेशन भेजा गया। अगर कुछ नहीं दिखे, डिवाइस नोटिफिकेशन सेटिंग्स जांचें।', ar:'تم إرسال إشعار تجريبي. إذا ل�� يظهر، تحقق من إعدادات الإشعارات.', he:'הודעת בדיקה נשלחה. אם לא מופיע, בדוק הגדרות התראות במכשיר.' },
  'Notification failed': { es:'Notificación fallida', zh:'通知失败', hi:'नोटिफिकेशन विफल', ar:'فشل الإشعار', he:'ההתראה נכשלה' },
  'Location not available on this device': { es:'Ubicación no disponible en este dispositivo', zh:'此设备上无法获取位置', hi:'इस डिवाइस पर स्थान उपलब्ध नहीं', ar:'الموقع غير متاح على هذا الجهاز', he:'מיקום לא זמין במכשיר זה' },
  'No active call to connect to': { es:'No hay llamada activa para conectar', zh:'没有活跃通话可连接', hi:'कनेक्ट करने के लिए कोई सक्रिय कॉल नहीं', ar:'لا توجد مكالمة نشطة للاتصال بها', he:'אין שיחה פעילה להתחבר אליה' },
  'CareCall installed!': { es:'¡CareCall instalado!', zh:'CareCall 已安装！', hi:'CareCall इंस्टॉल हो गया!', ar:'تم تثبيت CareCall!', he:'CareCall הותקן!' },
  'Add a care note for this call:': { es:'Añadir una nota de cuidado para esta llamada:', zh:'为此呼叫添加护理备注:', hi:'इस कॉल के लिए केयर नोट जोड़ें:', ar:'أضف ملاحظة رعاية لهذه المكالمة:', he:'הוסף הערת טיפול לשיחה זו:' },
  'with country code': { es:'con código de país', zh:'含国家代码', hi:'देश कोड के साथ', ar:'مع رمز الدولة', he:'עם קידומת מדינה' },
  'Step 1 of 4': { es:'Paso 1 de 4', zh:'第 1 步，共 4 步', hi:'चरण 1 / 4', ar:'الخطوة 1 من 4', he:'שלב 1 מתוך 4' },
  'e.g. ABCD12': { es:'ej. ABCD12', zh:'例如 ABCD12', hi:'जैसे ABCD12', ar:'مثال ABCD12', he:'לדוגמה ABCD12' },
  '🌙 Night Mode': { es:'🌙 Modo Nocturno', zh:'🌙 夜间模式', hi:'🌙 नाइट मोड', ar:'🌙 الوضع الليلي', he:'🌙 מצב לילה' },
  'Big clock & easy call': { es:'Reloj grande y llamada fácil', zh:'大时钟和便捷呼叫', hi:'बड़ी घड़ी और आसान कॉल', ar:'ساعة كبيرة ومكالمة سهلة', he:'שעון גדול ושיחה קלה' },
  '📵 No internet connection — tap for phone fallback': { es:'📵 Sin conexión a internet — toca para respaldo telefónico', zh:'📵 无网络连接 — 点击使用电话备用', hi:'📵 इंटरनेट कनेक्शन नहीं — फ़ोन फ़ॉलबैक के लिए टैप करें', ar:'📵 لا يوجد اتصال بالإنترنت — انقر للرجوع إلى الهاتف', he:'📵 אין חיבור אינטרנט — הקש לגיבוי טלפוני' },
  'Family Dashboard': { es:'Panel Familiar', zh:'家庭仪表板', hi:'परिवार डैशबोर्ड', ar:'لوحة العائلة', he:'לוח משפחה' },
  'Patient Medications': { es:'Medicación del paciente', zh:'患者用药', hi:'रोगी की दवाइयाँ', ar:'أدوية المريض', he:'תרופות המטופל' },
  'Please complete registration first.': { es:'Complete el registro primero.', zh:'请先完成注册。', hi:'कृपया पहले पंजीकरण पूरा करें।', ar:'يرجى إكمال التسجيل أولاً.', he:'נא להשלים את ההרשמה תחילה.' },
  'Please complete your profile': { es:'Completa tu perfil', zh:'请完善您的个人资料', hi:'कृपया अपना प्रोफ़ाइल पूरा करें', ar:'يرجى إكمال ملفك الشخصي', he:'נא להשלים את הפרופיל שלך' },
  'You are offline': { es:'Estás sin conexión', zh:'您已离线', hi:'आप ऑफ़लाइन हैं', ar:'أنت غير متصل', he:'אתה במצב לא מקוון' },
  'No internet connection': { es:'Sin conexión a internet', zh:'无网络连接', hi:'इंटरनेट कनेक्शन नहीं है', ar:'لا يوجد اتصال بالإنترنت', he:'אין חיבור לאינטרנט' },
  'Reconnect wifi or mobile data for full functionality. Watch for incoming SMS — patients can still reach you.': { es:'Reconecta wifi o datos móviles. Esté atento a SMS entrantes — los pacientes aún pueden contactarte.', zh:'请重新连接WiFi或移动数据。注意接收短信——患者仍然可以联系您。', hi:'पूर्ण कार्यक्षमता के लिए वाईफाई या मोबाइल डेटा पुनः कनेक्ट करें। आने वाले एसएमएस पर ध्यान दें।', ar:'أعد الاتصال بالواي فاي أو البيانات. انتبه للرسائل النصية الواردة.', he:'התחבר מחדש לוויפי או נתונים סלולריים. שים לב להודעות SMS נכנסות — מטופלים עדיין יכולים להגיע אליך.' },
  'Your call will be sent as SMS when you reconnect, or use the phone fallback below.': { es:'Tu llamada se enviará por SMS al reconectarte, o usa el teléfono de respaldo.', zh:'重新连接后您的呼叫将通过短信发送，或使用下方电话备用方案。', hi:'पुनः कनेक्ट होने पर आपका कॉल एसएमएस के रूप में भेजा जाएगा।', ar:'سيتم إرسال مكالمتك كرسالة نصية عند إعادة الاتصال.', he:'השיחה שלך תישלח כ-SMS כשתתחבר מחדש, או השתמש בגיבוי הטלפוני למטה.' },
  "Enter patient's code": { es:'Ingresa el código del paciente', zh:'输入患者代码', hi:'मरीज़ का कोड दर्ज करें', ar:'أدخل رمز المريض', he:'הזן קוד מטופל' },
  'Enter carer or family code': { es:'Ingresa el código del cuidador o familiar', zh:'输入护理人员或家属代码', hi:'देखभालकर्ता या परिवार का कोड दर्ज करें', ar:'أدخل رمز مقدم الرعاية أو العائلة', he:'הזן קוד מטפל או בן משפחה' },
  'Enter pair code': { es:'Ingresa el código de emparejamiento', zh:'输入配对代码', hi:'पेयर कोड दर्ज करें', ar:'أدخل رمز الاقتران', he:'הזן קוד חיבור' },
  'Pair request was incomplete — ask them to try again.': { es:'Solicitud incompleta — pídales que lo intenten de nuevo.', zh:'配对请求不完整 — 请让对方重试。', hi:'अनुरोध अधूरा था — उनसे पुनः प्रयास करने को कहें।', ar:'طلب الاقتران غير مكتمل — اطلب منهم المحاولة مرة أخرى.', he:'בקשת החיבור לא הושלמה — בקש מהם לנסות שוב.' },
  '🌐 Language': { es:'🌐 Idioma', zh:'🌐 语言', hi:'🌐 भाषा', ar:'🌐 اللغة', he:'🌐 שפה' },
  'Increase text size across the app': { es:'Aumentar el tamaño del texto en la app', zh:'增大应用中的文字大小', hi:'ऐप में टेक्स्ट का आकार बढ़ाएं', ar:'زيادة حجم النص في التطبيق', he:'הגדל את גודל הטקסט באפליקציה' },
  'Stronger colours and borders': { es:'Colores y bordes más fuertes', zh:'更强的颜色和边框', hi:'मज़बूत रंग और बॉर्डर', ar:'ألوان وحدود أقوى', he:'צבעים וגבולות חזקים יותר' },
  'Display': { es:'Pantalla', zh:'显示', hi:'प्रदर्शन', ar:'العرض', he:'תצוגה' },
  'Inactivity threshold': { es:'Umbral de inactividad', zh:'无活动阈值', hi:'निष्क्रियता सीमा', ar:'حد عدم النشاط', he:'סף חוסר פעילות' },
  'Inactivity description': { es:'Alertar si no hay actividad durante horas activas.', zh:'无手机活动时通知护理员。', hi:'फ़ोन गतिविधि न होने पर केयरर को सूचित।', ar:'تنبيه إذا لم يكن هناك نشاط هاتفي.', he:'התראה אם אין פעילות טלפון בשעות ערות.' },
  'Check-in description': { es:'Indicaciones periódicas. Sin respuesta, se alerta a los cuidadores.', zh:'定期提示。无回应则通知护理员。', hi:'नियमित संकेत। कोई जवाब नहीं तो केयरर को सूचित।', ar:'تنبيهات دورية. إذا لم يُرد، يتم تنبيه المُعتنين.', he:'בדיקות תקופתיות. אם אין תגובה, המטפלים מקבלים ��תראה.' },
  'Medication description': { es:'Recordatorios programados. Notificación si se omite.', zh:'定时提醒。遗漏则通知。', hi:'निर्धारित अनुस्मारक। छोड़ने पर सूचना।', ar:'تذكيرات مجدولة. إشعار إذا فات.', he:'תזכורות בזמנים קבועים. הודעה אם פוספסה.' },
  'Notification help': { es:'Si no aparece — revise la configuración', zh:'如���显示 — 检查通知设置', hi:'अगर नहीं दिखे — सूचना सेटिंग्स जांचें', ar:'إذا لم يظهر — تحقق من إعدادات الإشعارات', he:'אם לא מופיע — בדוק הגדרות התראות' },
  'Read medication name aloud': { es:'Leer el nombre del medicamento en voz alta', zh:'朗读药物名称', hi:'दवाई का नाम बोलकर सुनाएं', ar:'قراءة اسم الدواء بصوت عالٍ', he:'הקראת שם התרופה בקול' },
  '📄 Adherence report (PDF)': { es:'📄 Informe de adherencia (PDF)', zh:'📄 依从性报告 (PDF)', hi:'📄 अनुपालन रिपोर्ट (PDF)', ar:'📄 تقرير ا��التزام (PDF)', he:'📄 דוח היענות (PDF)' },
  'Used as offline fallback': { es:'Respaldo sin internet', zh:'离线备用', hi:'ऑफ़लाइन फ़ॉलबैक', ar:'بديل بدون إنترنت', he:'גיבוי ללא אינטרנט' },
  'Carers see your location': { es:'Los cuidadores ven tu ubicación', zh:'护理员可见你的位置', hi:'केयरर आपका स्थान देखें', ar:'يرى المُعتنون موقعك', he:'המטפלים רואים את מיקומך' },
  'Alert if patient leaves home': { es:'Alertar si el paciente sale', zh:'患者离开时警报', hi:'मरीज घर छोड़ने पर अलर्ट', ar:'تنبيه إذا غادر المريض', he:'התראה אם המטופל עוזב' },
  'Emergency Info Card': { es:'Tarjeta de Emergencia', zh:'急救信息卡', hi:'आपातकालीन जानकारी कार्ड', ar:'بطاقة معلومات الطوارئ', he:'כרטיס מידע חירום' },
  'Test': { es:'Probar', zh:'测试', hi:'टेस्ट', ar:'اختبار', he:'בדיקה' },
  'Change': { es:'Cambiar', zh:'更改', hi:'बदलें', ar:'تغيير', he:'שנה' },
  'View / Edit': { es:'Ver / Editar', zh:'查看 / 编辑', hi:'देखें / संपादित', ar:'عرض / تعديل', he:'צפה / ערוך' },
  'Set': { es:'Establecer', zh:'设置', hi:'सेट', ar:'تعيين', he:'הגדר' },
  'Protect settings with a 4-digit PIN': { es:'Protege los ajustes con un PIN de 4 dígitos', zh:'用 4 位 PIN 保护设置', hi:'4-अंकीय PIN से सेटिंग्स सुरक्षित करें', ar:'احمِ الإعدادات برمز PIN من 4 أرقام', he:'הגן על ההגדרות עם PIN בן 4 ספרות' },
  'Confirm password': { es:'Confirmar contraseña', zh:'确认密码', hi:'पासवर्ड की पुष्टि', ar:'تأكيد كلمة المرور', he:'אשר סיסמה' },
  'Phone number (optional)': { es:'Teléfono (opcional)', zh:'电话号码 (可选)', hi:'फ़ोन नंबर (वैकल्पिक)', ar:'رقم الهاتف (اختياري)', he:'מספר טלפון (אופציונלי)' },
  'Register': { es:'Registrar', zh:'注册', hi:'पंजीकरण', ar:'تسجيل', he:'הרשמה' },
  'Log in': { es:'Iniciar sesión', zh:'登录', hi:'लॉगिन', ar:'تسجيل الدخول', he:'התחברות' },
  'Create Account': { es:'Crear cuenta', zh:'创建账户', hi:'खाता बनाएं', ar:'إنشاء حساب', he:'צור חשבון' },
  'Email': { es:'Correo electrónico', zh:'电子邮件', hi:'ईमेल', ar:'البريد الإلكتروني', he:'דוא״ל' },
  'Password': { es:'Contraseña', zh:'密码', hi:'पासवर्ड', ar:'كلمة المرور', he:'סיסמה' },
  'Forgot password?': { es:'¿Olvidaste tu contraseña?', zh:'忘记密码？', hi:'पासवर्ड भूल गए?', ar:'نسيت كلمة المرور؟', he:'שכחת סיסמה?' },
  'Location & Safety': { es:'Ubicación y Seguridad', zh:'位置与安全', hi:'स्थान और सुरक्षा', ar:'الموقع والسلامة', he:'מיקום ובטיחות' },
  'Reset & Start Over': { es:'Restablecer', zh:'重置并重新开始', hi:'रीसेट और फिर से शुरू करें', ar:'إعادة تعيين والبدء من جديد', he:'אפס והתחל מחדש' },
  'Not connected to a carer yet': { es:'Aún no conectado a un cuidador', zh:'尚未连接到护理员', hi:'अभी तक किसी केयरर से नहीं जुड़े', ar:'لم يتم الاتصال بمُعتنٍ بعد', he:'עדיין לא מחובר ל��טפל' },
  'Share your code to connect:': { es:'Comparte tu código para conectar:', zh:'分享你的代码以连接:', hi:'कनेक्ट करने के लिए अपना कोड साझा करें:', ar:'شارك رمزك للاتصال:', he:'שתף את הקוד שלך כדי להתחבר:' },
  'Go to Settings to connect': { es:'Ir a Configuración para conectar', zh:'前往设置以连接', hi:'कनेक्ट करने के लिए सेटिंग्स पर जाएं', ar:'اذهب إلى الإعدادات للاتصال', he:'עבור להגדרות כדי להתחבר' },
  'Share this with your carer or patient': { es:'Comparte esto con tu cuidador o paciente', zh:'与你的护理员或患者分享', hi:'अपने केयरर या मरीज के साथ साझा करें', ar:'شارك هذا مع المُعتني أو المريض', he:'שתף עם המטפל או המטופל שלך' },
  'Log': { es:'Registro', zh:'日志', hi:'लॉग', ar:'السجل', he:'יומן' },
  'Emergency': { es:'Emergencia', zh:'紧急', hi:'आपातकाल', ar:'طوارئ', he:'חירום' },
  'Home': { es:'Inicio', zh:'首页', hi:'होम', ar:'الرئيسية', he:'בית' },
  'Account': { es:'Cuenta', zh:'账户', hi:'खाता', ar:'الحساب', he:'חשבון' },
  'Create your account': { es:'Crea tu cuenta', zh:'创建账户', hi:'अपना खाता बनाएं', ar:'أنشئ حسابك', he:'צור את חשבונך' },
  'Your data is protected by email and password': { es:'Tus datos están protegidos con email y contraseña', zh:'你的数据受邮箱和密码保护', hi:'आपका डेटा ईमेल और पासवर्ड से सुरक्षित है', ar:'بياناتك محمية بالبريد الإلكتروني وكلمة المرور', he:'המידע שלך מוגן בדוא״ל וסיסמה' },
  'Connect →': { es:'Conectar →', zh:'连接 →', hi:'कनेक्ट करें →', ar:'← اتصال', he:'התחבר →' },
  'Skip for now →': { es:'Omitir por ahora →', zh:'暂时跳过 →', hi:'अभी छोड़ें →', ar:'← تخطي الآن', he:'דלג לעת עתה →' },
  '📷 Scan QR instead': { es:'📷 Escanear QR', zh:'📷 扫描二维码', hi:'📷 QR स्कैन करें', ar:'📷 فحص QR', he:'📷 סרוק QR' },
  'Your Code': { es:'Tu Código', zh:'你的代码', hi:'आपका कोड', ar:'رمزك', he:'הקוד שלך' },
  '🌙 Bedside Mode': { es:'🌙 Modo Mesilla', zh:'🌙 床头模式', hi:'🌙 बेडसाइड मोड', ar:'🌙 وضع السرير', he:'🌙 מצב שידה' },
  'Exit Bedside Mode': { es:'Salir del modo mesilla', zh:'退出床头模式', hi:'बेडसाइड मोड से बाहर निकलें', ar:'الخروج من وضع السرير', he:'יציאה ממצב שידה' },
  'Exit Night Mode': { es:'Salir del modo nocturno', zh:'退出夜间模式', hi:'नाइट मोड से बाहर निकलें', ar:'الخروج من الوضع الليلي', he:'יציאה ממצב לילה' },
  'temp': { es:'temp', zh:'临时', hi:'अस्थायी', ar:'مؤقت', he:'זמני' },
  'Observer': { es:'Observador', zh:'观察者', hi:'पर्यवेक्षक', ar:'مراقب', he:'צופה' },
  'Online': { es:'En línea', zh:'在线', hi:'ऑनलाइन', ar:'متصل', he:'מחובר' },
  'Offline': { es:'Desconectado', zh:'离线', hi:'ऑफ़लाइन', ar:'غير متصل', he:'לא מחובר' },
  // ── Shared Care Calendar ──
  'Calendar':         { es:'Calendario', zh:'日历', hi:'कैलेंडर', ar:'التقويم', he:'יומן' },
  'New Event':        { es:'Nuevo Evento', zh:'新事件', hi:'नया इवेंट', ar:'حدث جديد', he:'אירוע חדש' },
  'Edit Event':       { es:'Editar Evento', zh:'编辑事件', hi:'इवेंट संपादित करें', ar:'تعديل الحدث', he:'ערוך אירוע' },
  'Delete Event':     { es:'Eliminar Evento', zh:'删除事件', hi:'इवेंट हटाएं', ar:'حذف الحدث', he:'מחק אירוע' },
  'No events this day': { es:'Sin eventos este día', zh:'今天没有事件', hi:'इस दिन कोई इवेंट नहीं', ar:'لا أحداث هذا اليوم', he:'אין אירועים ביום זה' },
  'Appointment':      { es:'Cita', zh:'预约', hi:'अपॉइंटमेंट', ar:'موعد', he:'פגישה' },
  'Shift':            { es:'Turno', zh:'轮班', hi:'शिफ्ट', ar:'وردية', he:'משמרת' },
  'Other':            { es:'Otro', zh:'其他', hi:'अन्य', ar:'أخرى', he:'אחר' },
  'Notes':            { es:'Notas', zh:'备注', hi:'टिप्पणियाँ', ar:'ملاحظات', he:'הערות' },
  'Priority':         { es:'Prioridad', zh:'优先', hi:'प्राथमिकता', ar:'أولوية', he:'עדיפות' },
  'Flag as important': { es:'Marcar como importante', zh:'标记为重要', hi:'महत्वपूर्ण चिन्हित करें', ar:'وضع علامة مهم', he:'סמן כחשוב' },
  'Event added':      { es:'Evento añadido', zh:'事件已添加', hi:'इवेंट जोड़ा गया', ar:'تمت إضافة الحدث', he:'האירוע נוסף' },
  'Event updated':    { es:'Evento actualizado', zh:'事件已更新', hi:'इवेंट अपडेट किया गया', ar:'تم تحديث الحدث', he:'האירוע עודכן' },
  'Event deleted':    { es:'Evento eliminado', zh:'事件已删除', hi:'इवेंट हटाया गया', ar:'تم حذف الحدث', he:'האירוע נמחק' },
  'Delete this event?': { es:'¿Eliminar este evento?', zh:'删除此事件？', hi:'यह इवेंट हटाएं?', ar:'هل تريد حذف هذا الحدث؟', he:'למחוק אירוע זה?' },
  'Please enter a title': { es:'Ingresa un título', zh:'请输入标题', hi:'कृपया शीर्षक दर्ज करें', ar:'يرجى إدخال عنوان', he:'נא הזן כותרת' },
  'Please select a date': { es:'Selecciona una fecha', zh:'请选择日期', hi:'कृपया तारीख चुनें', ar:'يرجى تحديد تاريخ', he:'נא בחר תאריך' },
  'No room available': { es:'Sin sala disponible', zh:'没有可用的房间', hi:'कोई कमरा उपलब्ध नहीं', ar:'لا توجد غرفة متاحة', he:'אין חדר זמין' },
  'Delete failed':    { es:'Error al eliminar', zh:'删除失败', hi:'हटाना विफल', ar:'فشل الحذف', he:'המחיקה נכשלה' },
  '+ New Event':      { es:'+ Nuevo Evento', zh:'+ 新事件', hi:'+ नया इवेंट', ar:'+ حدث جديد', he:'+ אירוע חדש' },
  'Untitled':         { es:'Sin título', zh:'无标题', hi:'शीर्षकहीन', ar:'بدون عنوان', he:'ללא כותרת' },
  'Title':            { es:'Título', zh:'标题', hi:'शीर्षक', ar:'العنوان', he:'כותרת' },
  'Date':             { es:'Fecha', zh:'日期', hi:'तारीख', ar:'التاريخ', he:'תאריך' },
  'Time':             { es:'Hora', zh:'时间', hi:'समय', ar:'الوقت', he:'שעה' },
  '(optional)':       { es:'(opcional)', zh:'(可选)', hi:'(वैकल्पिक)', ar:'(اختياري)', he:'(אופציונלי)' },
  'Type':             { es:'Tipo', zh:'类型', hi:'प्रकार', ar:'النوع', he:'סוג' },
  'On':               { es:'Sí', zh:'开', hi:'चालू', ar:'مفعّل', he:'מופעל' },
  'Off':              { es:'No', zh:'关', hi:'बंद', ar:'معطّل', he:'כבוי' },
  'January':          { es:'Enero', zh:'一月', hi:'जनवरी', ar:'يناير', he:'ינואר' },
  'February':         { es:'Febrero', zh:'二月', hi:'फरवरी', ar:'فبراير', he:'פברואר' },
  'March':            { es:'Marzo', zh:'三月', hi:'मार्च', ar:'مارس', he:'מרץ' },
  'April':            { es:'Abril', zh:'四月', hi:'अप्रैल', ar:'أبريل', he:'אפריל' },
  'May':              { es:'Mayo', zh:'五月', hi:'मई', ar:'مايو', he:'מאי' },
  'June':             { es:'Junio', zh:'六月', hi:'जून', ar:'يونيو', he:'יוני' },
  'July':             { es:'Julio', zh:'七月', hi:'जुलाई', ar:'يوليو', he:'יולי' },
  'August':           { es:'Agosto', zh:'八月', hi:'अगस्त', ar:'أغسطس', he:'אוגוסט' },
  'September':        { es:'Septiembre', zh:'九月', hi:'सितंबर', ar:'سبتمبر', he:'ספטמבר' },
  'October':          { es:'Octubre', zh:'十月', hi:'अक्टूबर', ar:'أكتوبر', he:'אוקטובר' },
  'November':         { es:'Noviembre', zh:'十一月', hi:'नवंबर', ar:'نوفمبر', he:'נובמבר' },
  'December':         { es:'Diciembre', zh:'十二月', hi:'दिसंबर', ar:'ديسمبر', he:'דצמבר' },
  // ── Health Tracking ──
  'Health':           { es:'Salud', zh:'健康', hi:'स्वास्थ्य', ar:'الصحة', he:'בריאות' },
  'Health Log':       { es:'Registro de Salud', zh:'健康日志', hi:'स्वास्थ्य लॉग', ar:'سجل الصحة', he:'יומן בריאות' },
  'Vitals':           { es:'Signos vitales', zh:'生命体征', hi:'जीवन लक्षण', ar:'العلامات الحيوية', he:'סימנים חיוניים' },
  'BP':               { es:'PA', zh:'血压', hi:'बीपी', ar:'ض.د', he:'ל.ד' },
  'HR':               { es:'FC', zh:'心率', hi:'एचआर', ar:'ن.ق', he:'דופק' },
  'Sugar':            { es:'Azúcar', zh:'血糖', hi:'शुगर', ar:'سكر', he:'סוכר' },
  'Temp':             { es:'Temp', zh:'体温', hi:'तापमान', ar:'حرارة', he:'חום' },
  'Weight':           { es:'Peso', zh:'体重', hi:'वजन', ar:'الوزن', he:'משקל' },
  'O2':               { es:'O2', zh:'血氧', hi:'O2', ar:'أكسجين', he:'חמצן' },
  'Mood':             { es:'Ánimo', zh:'心情', hi:'मूड', ar:'المزاج', he:'מצב רוח' },
  'Blood Pressure':   { es:'Presión Arterial', zh:'血压', hi:'रक्तचाप', ar:'ضغط الدم', he:'לחץ דם' },
  'Heart Rate':       { es:'Frecuencia Cardíaca', zh:'心率', hi:'हृदय गति', ar:'معدل نبض القلب', he:'קצב לב' },
  'Blood Sugar':      { es:'Azúcar en Sangre', zh:'血糖', hi:'रक्त शर्करा', ar:'سكر الدم', he:'סוכר בדם' },
  'Temperature':      { es:'Temperatura', zh:'体温', hi:'तापमान', ar:'الحرارة', he:'טמפרטורה' },
  'Oxygen Saturation':{ es:'Saturación de Oxígeno', zh:'血氧饱和度', hi:'ऑक्सीजन संतृप्ति', ar:'تشبع الأكسجين', he:'רוויון חמצן' },
  'Pain Level':       { es:'Nivel de Dolor', zh:'疼痛等级', hi:'दर्द का स्तर', ar:'مستوى الألم', he:'רמת כאב' },
  'Systolic':         { es:'Sistólica', zh:'收缩压', hi:'सिस्टोलिक', ar:'انقباضي', he:'סיסטולי' },
  'Diastolic':        { es:'Diastólica', zh:'舒张压', hi:'डायस्टोलिक', ar:'انبساطي', he:'דיאסטולי' },
  'Measurement saved':{ es:'Medición guardada', zh:'测量已保存', hi:'माप सहेजा गया', ar:'تم حفظ القياس', he:'המדידה נשמרה' },
  'Recent Entries':   { es:'Entradas Recientes', zh:'最近记录', hi:'हाल की प्रविष्टियाँ', ar:'الإدخالات الأخيرة', he:'רשומות אחרונות' },
  'No health entries yet': { es:'Sin entradas de salud aún', zh:'暂无健康记录', hi:'अभी तक कोई स्वास्थ्य प्रविष्टि नहीं', ar:'لا توجد إدخالات صحية بعد', he:'אין רשומות בריאות עדיין' },
  'Yesterday':        { es:'Ayer', zh:'昨天', hi:'कल', ar:'أمس', he:'אתמול' },
  'Enter valid blood pressure values': { es:'Ingrese valores válidos de presión arterial', zh:'请输入有效的血压值', hi:'मान्य रक्तचाप मान दर्ज करें', ar:'أدخل قيم ضغط دم صالحة', he:'הזן ערכי לחץ דם תקינים' },
  'Enter a valid heart rate': { es:'Ingrese una frecuencia cardíaca válida', zh:'请输入有效的心率', hi:'मान्य हृदय गति दर्ज करें', ar:'أدخل معدل نبض صالح', he:'הזן קצב לב תקין' },
  'Enter a valid blood sugar value': { es:'Ingrese un valor de azúcar válido', zh:'请输入有效的血糖值', hi:'मान्य रक्त शर्करा मान दर्ज करें', ar:'أدخل قيمة سكر صالحة', he:'הזן ערך סוכר תקין' },
  'Enter a valid temperature': { es:'Ingrese una temperatura válida', zh:'请输入有效的体温', hi:'मान्य तापमान दर्ज करें', ar:'أدخل حرارة صالحة', he:'הזן טמפרטורה תקינה' },
  'Enter a valid weight': { es:'Ingrese un peso válido', zh:'请输入有效的体重', hi:'मान्य वजन दर्ज करें', ar:'أدخل وزنًا صالحًا', he:'הזן משקל תקין' },
  'Enter a valid oxygen saturation': { es:'Ingrese una saturación válida', zh:'请输入有效的血氧值', hi:'मान्य ऑक्सीजन संतृप्ति दर्ज करें', ar:'أدخل تشبع أكسجين صالح', he:'הזן רוויון חמצן תקין' },
  'Select a pain level': { es:'Seleccione un nivel de dolor', zh:'请选择疼痛等级', hi:'दर्द का स्तर चुनें', ar:'اختر مستوى الألم', he:'בחר רמת כאב' },
  'Select a mood':    { es:'Seleccione un estado de ánimo', zh:'请选择心情', hi:'मूड चुनें', ar:'اختر المزاج', he:'בחר מצב רוח' },
  // ── Navigation & Tabs ──
  'Profile':          { es:'Perfil', zh:'个人资料', hi:'प्रोफ़ाइल', ar:'الملف الشخصي', he:'פרופיל' },
  'Connections':      { es:'Conexiones', zh:'连接', hi:'कनेक्शन', ar:'الاتصالات', he:'חיבורים' },
  'Alerts':           { es:'Alertas', zh:'警报', hi:'अलर्ट', ar:'التنبيهات', he:'התראות' },
  'Safety':           { es:'Seguridad', zh:'安全', hi:'सुरक्षा', ar:'السلامة', he:'בטיחות' },
  'Documents':        { es:'Documentos', zh:'文档', hi:'दस्तावेज़', ar:'المستندات', he:'מסמכים' },
  'Check-ins':        { es:'Controles', zh:'签到', hi:'चेक-इन', ar:'تسجيل الحضور', he:'צ\'ק-אין' },
  'System':           { es:'Sistema', zh:'系统', hi:'सिस्टम', ar:'النظام', he:'מערכת' },
  'About':            { es:'Acerca de', zh:'关于', hi:'के बारे में', ar:'حول', he:'אודות' },
  'Features':         { es:'Funciones', zh:'功能', hi:'सुविधाएँ', ar:'الميزات', he:'תכונות' },
  'Done':             { es:'Hecho', zh:'完成', hi:'पूर्ण', ar:'تم', he:'סיום' },
  'Category':         { es:'Categoría', zh:'分类', hi:'श्रेणी', ar:'الفئة', he:'קטגוריה' },
  'Delete':           { es:'Eliminar', zh:'删除', hi:'हटाएं', ar:'حذف', he:'מחק' },
  'File':             { es:'Archivo', zh:'文件', hi:'फ़ाइल', ar:'ملف', he:'קובץ' },
  'Upload':           { es:'Subir', zh:'上传', hi:'अपलोड', ar:'رفع', he:'העלאה' },
  'Insurance':        { es:'Seguro', zh:'保险', hi:'बीमा', ar:'التأمين', he:'ביטוח' },
  'Legal':            { es:'Legal', zh:'法律', hi:'कानूनी', ar:'قانوني', he:'משפטי' },
  'Prescriptions':    { es:'Recetas', zh:'处方', hi:'नुस्खे', ar:'الوصفات الطبية', he:'מרשמים' },
  'Carer':            { es:'Cuidador', zh:'护理员', hi:'केयरर', ar:'المُعتني', he:'מטפל' },
  'Avatar':           { es:'Avatar', zh:'头像', hi:'अवतार', ar:'الصورة الرمزية', he:'אווטאר' },
  'Night Mode':       { es:'Modo Nocturno', zh:'夜间模式', hi:'नाइट मोड', ar:'الوضع الليلي', he:'מצב לילה' },
  'Voice Activation': { es:'Activación por Voz', zh:'语音激活', hi:'वॉयस एक्टिवेशन', ar:'التفعيل الصوتي', he:'הפעלה קולית' },
  'Profile Photo':    { es:'Foto de Perfil', zh:'个人照片', hi:'प्रोफ़ाइल फ़ोटो', ar:'صورة الملف الشخصي', he:'תמונת פרופיל' },
  'Call for Help':    { es:'Pedir Ayuda', zh:'呼叫帮助', hi:'मदद के लिए कॉल करें', ar:'طلب المساعدة', he:'קריאה לעזרה' },
  // ── Documents ──
  'Document Name':    { es:'Nombre del Documento', zh:'文档名称', hi:'दस्तावेज़ का नाम', ar:'اسم المستند', he:'שם המסמך' },
  'Document deleted': { es:'Documento eliminado', zh:'文档已删除', hi:'दस्तावेज़ हटाया गया', ar:'تم حذف المستند', he:'המסמך נמחק' },
  'Document saved':   { es:'Documento guardado', zh:'文档已保存', hi:'दस्तावेज़ सहेजा गया', ar:'تم حفظ المستند', he:'המסמך נשמר' },
  'No documents yet': { es:'Sin documentos aún', zh:'暂无文档', hi:'अभी तक कोई दस्तावेज़ नहीं', ar:'لا توجد مستندات بعد', he:'אין מסמכים עדיין' },
  'Add Document':     { es:'Agregar Documento', zh:'添加文档', hi:'दस्तावेज़ जोड़ें', ar:'إضافة مستند', he:'הוסף מסמך' },
  '+ Add Document':   { es:'+ Agregar Documento', zh:'+ 添加文档', hi:'+ दस्तावेज़ जोड़ें', ar:'+ إضافة مستند', he:'+ הוסף מסמך' },
  'Delete this document?': { es:'¿Eliminar este documento?', zh:'删除此文档？', hi:'यह दस्तावेज़ हटाएं?', ar:'هل تريد حذف هذا المستند؟', he:'למחוק מסמך זה?' },
  'Saving document…': { es:'Guardando documento…', zh:'正在保存文档…', hi:'दस्तावेज़ सहेजा जा रहा है…', ar:'جارٍ حفظ المستند…', he:'שומר מסמך…' },
  'Upload a photo from camera or gallery': { es:'Suba una foto desde la cámara o la galería', zh:'从相机或相册上传照片', hi:'कैमरा या गैलरी से फ़ोटो अपलोड करें', ar:'ارفع صورة من الكاميرا أو المعرض', he:'העלה תמונה מהמצלמה או מהגלריה' },
  'Uploaded by':      { es:'Subido por', zh:'上传者', hi:'द्वारा अपलोड किया गया', ar:'تم الرفع بواسطة', he:'הועלה על ידי' },
  'Download PDF':     { es:'Descargar PDF', zh:'下载PDF', hi:'PDF डाउनलोड करें', ar:'تنزيل PDF', he:'הורד PDF' },
  // ── Upgrade & Premium ──
  'Upgrade':          { es:'Actualizar', zh:'升级', hi:'अपग्रेड', ar:'ترقية', he:'שדרוג' },
  'Not now':          { es:'Ahora no', zh:'暂时不', hi:'अभी नहीं', ar:'ليس الآن', he:'לא עכשיו' },
  'This feature requires': { es:'Esta función requiere', zh:'此功能需要', hi:'इस सुविधा के लिए आवश्यक है', ar:'هذه الميزة تتطلب', he:'תכונה זו דורשת' },
  // ── Greetings ──
  'Good morning,':    { es:'Buenos días,', zh:'早上好，', hi:'सुप्रभात,', ar:'صباح الخير،', he:'בוקר טוב,' },
  'Good afternoon,':  { es:'Buenas tardes,', zh:'下午好，', hi:'नमस्कार,', ar:'مساء الخير،', he:'צהריים טובים,' },
  'Good evening,':    { es:'Buenas noches,', zh:'晚上好，', hi:'शुभ संध्या,', ar:'مساء الخير،', he:'ערב טוב,' },
  // ── Onboarding ──
  'Welcome to CareCall': { es:'Bienvenido a CareCall', zh:'欢迎使用CareCall', hi:'CareCall में आपका स्वागत है', ar:'مرحبًا بك في CareCall', he:'ברוכים הבאים ל-CareCall' },
  'Your Personal Code': { es:'Su Código Personal', zh:'您的个人代码', hi:'आपका व्यक्तिगत कोड', ar:'رمزك الشخصي', he:'הקוד האישי שלך' },
  'Share your code to connect': { es:'Comparta su código para conectarse', zh:'分享您的代码以连接', hi:'कनेक्ट करने के लिए अपना कोड साझा करें', ar:'شارك رمزك للاتصال', he:'שתף את הקוד שלך כדי להתחבר' },
  // ── Connection status ──
  'No carer connected': { es:'Ningún cuidador conectado', zh:'未连接护理员', hi:'कोई केयरर कनेक्ट नहीं', ar:'لا يوجد مُعتنٍ متصل', he:'אין מטפל מחובר' },
  'No patients connected yet': { es:'Ningún paciente conectado aún', zh:'尚未连接患者', hi:'अभी तक कोई मरीज कनेक्ट नहीं', ar:'لا يوجد مرضى متصلون بعد', he:'אין מטופלים מחוברים עדיין' },
  'No Connection':    { es:'Sin Conexión', zh:'无连接', hi:'कोई कनेक्शन नहीं', ar:'لا يوجد اتصال', he:'אין חיבור' },
  'Offline — will be notified': { es:'Sin conexión — será notificado', zh:'离线 — 将收到通知', hi:'ऑफ़लाइन — सूचित किया जाएगा', ar:'غير متصل — سيتم إشعاره', he:'לא מחובר — יקבל התראה' },
  'No phone numbers available': { es:'No hay números de teléfono disponibles', zh:'没有可用的电话号码', hi:'कोई फ़ोन नंबर उपलब्ध नहीं', ar:'لا توجد أرقام هاتف متاحة', he:'אין מספרי טלפון זמינים' },
  'No room found':    { es:'No se encontró sala', zh:'未找到房间', hi:'कोई कमरा नहीं मिला', ar:'لم يتم العثور على غرفة', he:'לא נמצא חדר' },
  'Called as last resort': { es:'Llamado como último recurso', zh:'作为最后手段呼叫', hi:'अंतिम उपाय के रूप में कॉल किया गया', ar:'تم الاتصال كملاذ أخير', he:'התקשר כמוצא אחרון' },
  'Please choose your role': { es:'Por favor elija su rol', zh:'请选择您的角色', hi:'कृपया अपनी भूमिका चुनें', ar:'الرجاء اختيار دورك', he:'אנא בחר את תפקידך' },
  // ── Status messages ──
  'Got it!':          { es:'¡Entendido!', zh:'收到！', hi:'समझ गया!', ar:'فهمت!', he:'הבנתי!' },
  'Help Coming':      { es:'Ayuda en Camino', zh:'帮助即将到来', hi:'मदद आ रही है', ar:'المساعدة قادمة', he:'עזרה בדרך' },
  // ── Photo ──
  'Take Photo':       { es:'Tomar Foto', zh:'拍照', hi:'फ़ोटो लें', ar:'التقاط صورة', he:'צלם תמונה' },
  'Choose from Gallery': { es:'Elegir de la Galería', zh:'从相册选择', hi:'गैलरी से चुनें', ar:'اختر من المعرض', he:'בחר מהגלריה' },
  'Photo updated':    { es:'Foto actualizada', zh:'照片已更新', hi:'फ़ोटो अपडेट की गई', ar:'تم تحديث الصورة', he:'התמונה עודכנה' },
  'Photo upload failed': { es:'Error al subir la foto', zh:'照片上传失败', hi:'फ़ोटो अपलोड विफल', ar:'فشل رفع الصورة', he:'העלאת התמונה נכשלה' },
  // ── Validation & Errors ──
  'Please enter a document name': { es:'Por favor ingrese un nombre de documento', zh:'请输入文档名称', hi:'कृपया दस्तावेज़ का नाम दर्ज करें', ar:'الرجاء إدخال اسم المستند', he:'נא הזן שם מסמך' },
  'Please select a file': { es:'Por favor seleccione un archivo', zh:'请选择文件', hi:'कृपया फ़ाइल चुनें', ar:'الرجاء تحديد ملف', he:'נא בחר קובץ' },
  'File too large (max 2MB)': { es:'Archivo demasiado grande (máx 2MB)', zh:'文件过大（最大2MB）', hi:'फ़ाइल बहुत बड़ी (अधिकतम 2MB)', ar:'الملف كبير جدًا (الحد الأقصى 2 ميجابايت)', he:'הקובץ גדול מדי (מקסימום 2MB)' },
  'Loading scanner…': { es:'Cargando escáner…', zh:'正在加载扫描仪…', hi:'स्कैनर लोड हो रहा है…', ar:'جارٍ تحميل الماسح…', he:'טוען סורק…' },
  'Location permission required': { es:'Se requiere permiso de ubicación', zh:'需要位置权限', hi:'स्थान अनुमति आवश्यक', ar:'إذن الموقع مطلوب', he:'נדרשת הרשאת מיקום' },
  'Microphone access required — check app permissions': { es:'Se requiere acceso al micrófono — verifique los permisos', zh:'需要麦克风权限 — 请检查应用权限', hi:'माइक्रोफ़ोन एक्सेस आवश्यक — ऐप अनुमतियां जांचें', ar:'مطلوب إذن الميكروفون — تحقق من أذونات التطبيق', he:'נדרשת גישה למיקרופון — בדוק הרשאות אפליקציה' },
  'Microphone not available on this device': { es:'Micrófono no disponible en este dispositivo', zh:'此设备上麦克风不可用', hi:'इस डिवाइस पर माइक्रोफ़ोन उपलब्ध नहीं', ar:'الميكروفون غير متاح على هذا الجهاز', he:'המיקרופון אינו זמין במכשיר זה' },
  'Could not play voice note': { es:'No se pudo reproducir la nota de voz', zh:'无法播放语音备注', hi:'वॉयस नोट नहीं चला सका', ar:'تعذر تشغيل الملاحظة الصوتية', he:'לא ניתן להשמיע הודעה קולית' },
  'Enter your email above, then tap Forgot password': { es:'Ingrese su correo arriba y luego toque Olvidé mi contraseña', zh:'在上方输入您的邮箱，然后点击忘记密码', hi:'ऊपर अपना ईमेल दर्ज करें, फिर पासवर्ड भूल गए पर टैप करें', ar:'أدخل بريدك الإلكتروني أعلاه، ثم انقر نسيت كلمة المرور', he:'הזן את האימייל למעלה, ואז לחץ על שכחתי סיסמה' },
};

// ── Russian, French, Amharic translations ──
const I18N_EXTRA = {
  'Call Carer': { ru:'Вызвать', fr:'Appeler', am:'ተንከባካቢ ጥሪ' },
  'Not Ready': { ru:'Не готово', fr:'Pas prêt', am:'ዝግጁ አይደለም' },
  'Calling…': { ru:'Вызов…', fr:'Appel…', am:'በመደወል…' },
  'Coming!': { ru:'Идёт!', fr:'En route!', am:'እየመጣ!' },
  'Connecting…': { ru:'Подключение…', fr:'Connexion…', am:'በማገናኘት…' },
  'Carer online': { ru:'Опекун онлайн', fr:'Aidant en ligne', am:'ተንከባካቢ መስመር ላይ' },
  'Carer notified by push': { ru:'Опекун уведомлён', fr:'Aidant notifié', am:'ተንከባካቢ ተነግሯል' },
  'Calling carer…': { ru:'Вызов опекуна…', fr:'Appel de l\'aidant…', am:'ተንከባካቢን በመጥራት…' },
  'Help on the way': { ru:'Помощь в пути', fr:'Aide en chemin', am:'እርዳታ በመንገድ ላይ' },
  'What do you need?': { ru:'Что вам нужно?', fr:'De quoi avez-vous besoin?', am:'ምን ይፈልጋሉ?' },
  'Water': { ru:'Вода', fr:'Eau', am:'ውሃ' },
  'Medication': { ru:'Лекарство', fr:'Médicament', am:'መድሃኒት' },
  'Food': { ru:'Еда', fr:'Nourriture', am:'ምግብ' },
  'Toilet': { ru:'Туалет', fr:'Toilettes', am:'መጸዳጃ' },
  'Pain': { ru:'Боль', fr:'Douleur', am:'ህመም' },
  'Message': { ru:'Сообщение', fr:'Message', am:'መልእክት' },
  'Voice Note': { ru:'Голосовая заметка', fr:'Note vocale', am:'የድምፅ ማስታወሻ' },
  'SOS': { ru:'SOS', fr:'SOS', am:'SOS' },
  'Hold 3s': { ru:'Держите 3с', fr:'Maintenez 3s', am:'3 ሰከንድ ያዙ' },
  'Fall Detected': { ru:'Обнаружено падение', fr:'Chute détectée', am:'መውደቅ ተገኝቷል' },
  'Emergency Alert': { ru:'Экстренный вызов', fr:'Alerte d\'urgence', am:'የአደጋ ማንቂያ' },
  "I'm OK — Cancel": { ru:'Я в порядке — Отмена', fr:'Je vais bien — Annuler', am:'ደህና ነኝ — ይቅር' },
  'Fall Detection': { ru:'Обнаружение падений', fr:'Détection de chutes', am:'መውደቅ ማወቂያ' },
  'Are you OK?': { ru:'Вы в порядке?', fr:'Ça va?', am:'ደህና ነዎት?' },
  'Routine check-in': { ru:'Плановая проверка', fr:'Vérification de routine', am:'መደበኛ ፍተሻ' },
  "I'm OK": { ru:'Я в порядке', fr:'Je vais bien', am:'ደህና ነኝ' },
  'Need Help': { ru:'Нужна помощь', fr:'Besoin d\'aide', am:'እርዳታ ይፈልጋሉ' },
  'Medication Time': { ru:'Время лекарства', fr:'Heure du médicament', am:'የመድሃኒት ሰዓት' },
  'Take your medication': { ru:'Примите лекарство', fr:'Prenez votre médicament', am:'መድሃኒትዎን ይውሰዱ' },
  'Taken ✓': { ru:'Принято ✓', fr:'Pris ✓', am:'ተወስዷል ✓' },
  'Skip': { ru:'Пропустить', fr:'Passer', am:'ዝለል' },
  'Available': { ru:'Доступен', fr:'Disponible', am:'ዝግጁ' },
  'Busy': { ru:'Занят', fr:'Occupé', am:'ስራ ላይ' },
  'Off Duty': { ru:'Не на смене', fr:'Hors service', am:'ከስራ ውጪ' },
  'Standby': { ru:'Ожидание', fr:'En attente', am:'በመጠባበቅ' },
  'Active Calls': { ru:'Активные вызовы', fr:'Appels actifs', am:'ንቁ ጥሪዎች' },
  "✓ I'm on my way": { ru:'✓ Я в пути', fr:'✓ J\'arrive', am:'✓ እየመጣሁ ነው' },
  'Waiting for patient…': { ru:'Ожидание пациента…', fr:'En attente du patient…', am:'ታካሚ በመጠበቅ…' },
  'Help is on the way': { ru:'Помощь в пути', fr:'L\'aide arrive', am:'እርዳታ በመንገድ ላይ' },
  'End Call': { ru:'Завершить', fr:'Fin d\'appel', am:'ጥሪ አብቃ' },
  'Voice Call': { ru:'Голосовой вызов', fr:'Appel vocal', am:'የድምፅ ጥሪ' },
  'Connected': { ru:'Подключено', fr:'Connecté', am:'ተገናኝቷል' },
  'I need care': { ru:'Мне нужен уход', fr:'J\'ai besoin de soins', am:'እንክብካቤ እፈልጋለሁ' },
  'I provide care': { ru:'Я ухаживаю', fr:'Je prodigue des soins', am:'እንክብካቤ እሰጣለሁ' },
  "What's your name?": { ru:'Как вас зовут?', fr:'Comment vous appelez-vous?', am:'ስምዎ ማን ነው?' },
  'Continue →': { ru:'Продолжить →', fr:'Continuer →', am:'ቀጥል →' },
  '← Back': { ru:'← Назад', fr:'← Retour', am:'← ተመለስ' },
  'Your Code': { ru:'Ваш код', fr:'Votre code', am:'የእርስዎ ኮድ' },
  'Connect →': { ru:'Подключить →', fr:'Connecter →', am:'ያገናኙ →' },
  'Skip for now →': { ru:'Пропустить →', fr:'Passer →', am:'ለጊዜው ዝለል →' },
  'Settings': { ru:'Настройки', fr:'Paramètres', am:'ቅንብሮች' },
  'My Profile': { ru:'Мой профиль', fr:'Mon profil', am:'የእኔ መገለጫ' },
  'My Code': { ru:'Мой код', fr:'Mon code', am:'የእኔ ኮድ' },
  'My Carers': { ru:'Мои опекуны', fr:'Mes aidants', am:'ተንከባካቢዎቼ' },
  'My Patients': { ru:'Мои пациенты', fr:'Mes patients', am:'ታካሚዎቼ' },
  'Notifications': { ru:'Уведомления', fr:'Notifications', am:'ማሳወቂያዎች' },
  'Language': { ru:'Язык', fr:'Langue', am:'ቋንቋ' },
  'Danger Zone': { ru:'Опасная зона', fr:'Zone de danger', am:'አደገኛ ቦታ' },
  'Reset & Start Over': { ru:'Сбросить', fr:'Réinitialiser', am:'ዳግም ጀምር' },
  'Edit': { ru:'Изменить', fr:'Modifier', am:'አርትዕ' },
  'Total Calls': { ru:'Всего вызовов', fr:'Total appels', am:'ጠቅላላ ጥሪዎች' },
  'Responded': { ru:'Отвечено', fr:'Répondu', am:'ተመልሷል' },
  'Avg Response': { ru:'Ср. ответ', fr:'Rép. moy.', am:'አማካይ ምላሽ' },
  'Fastest': { ru:'Быстрый', fr:'Plus rapide', am:'ፈጣን' },
  'Slowest': { ru:'Медленный', fr:'Plus lent', am:'ቀርፋፋ' },
  'Today': { ru:'Сегодня', fr:'Aujourd\'hui', am:'ዛሬ' },
  'Most Common Needs': { ru:'Частые потребности', fr:'Besoins fréquents', am:'የተለመዱ ፍላጎቶች' },
  'No calls yet': { ru:'Нет вызовов', fr:'Pas encore d\'appels', am:'ገና ጥሪዎች የሉም' },
  'All': { ru:'Все', fr:'Tous', am:'ሁሉም' },
  'Phone Number': { ru:'Телефон', fr:'Téléphone', am:'ስልክ ቁጥር' },
  'Not set': { ru:'Не задано', fr:'Non défini', am:'አልተዘጋጀም' },
  'Share this code to connect': { ru:'Поделитесь кодом', fr:'Partagez ce code', am:'ለመገናኘት ኮዱን ያጋሩ' },
  'Name updated': { ru:'Имя обновлено', fr:'Nom mis à jour', am:'ስም ተዘምኗል' },
  'Connection removed': { ru:'Связь удалена', fr:'Connexion supprimée', am:'ግንኙነት ተወግዷል' },
  'No internet — use phone instead': { ru:'Нет интернета — звоните', fr:'Pas d\'internet — téléphonez', am:'ኢንተርኔት የለም — ስልክ ይጠቀሙ' },
  'No carers connected — add a carer first': { ru:'Нет опекунов — добавьте', fr:'Pas d\'aidant — ajoutez-en', am:'ተንከባካቢ የለም — ያክሉ' },
  'Call failed — check your connection': { ru:'Вызов не удался', fr:'Appel échoué — vérifiez', am:'ጥሪ አልተሳካም' },
  'No response yet — try calling again': { ru:'Нет ответа — повторите', fr:'Pas de réponse — réessayez', am:'ምላሽ የለም — እንደገና ይሞክሩ' },
  "Patient notified — you're on the way!": { ru:'Пациент уведомлён!', fr:'Patient prévenu!', am:'ታካሚ ተነግሯል!' },
  'Failed to acknowledge — check your connection': { ru:'Ошибка подтверждения', fr:'Échec de confirmation', am:'ማረጋገጥ አልተሳካም' },
  "Alert cancelled — glad you're OK!": { ru:'Отменено — рады что в порядке!', fr:'Annulé — content que ça va!', am:'ተሰርዟል — ደህና ነዎት!' },
  "Great — we'll check again later!": { ru:'Отлично — проверим позже!', fr:'Super — on vérifiera plus tard!', am:'ጥሩ — በኋላ እንፈትሻለን!' },
  'CSV downloaded': { ru:'CSV скачан', fr:'CSV téléchargé', am:'CSV ወርዷል' },
  'Loading…': { ru:'Загрузка…', fr:'Chargement…', am:'በመጫን…' },
  'On': { ru:'Вкл', fr:'Activé', am:'በርቷል' },
  'Off': { ru:'Выкл', fr:'Désactivé', am:'ጠፍቷል' },
  'Push Notifications': { ru:'Push-уведомления', fr:'Notifications push', am:'ፑሽ ማሳወቂያዎች' },
  'Scheduled Check-ins': { ru:'Плановые проверки', fr:'Vérifications planifiées', am:'የታቀዱ ፍተሻዎች' },
  'Medication Reminders': { ru:'Напоминания о лекарствах', fr:'Rappels de médicaments', am:'የመድሃኒት ማስታወሻዎች' },
  'Accessibility': { ru:'Доступность', fr:'Accessibilité', am:'ተደራሽነት' },
  'Large Text': { ru:'Крупный текст', fr:'Grand texte', am:'ትልቅ ጽሑፍ' },
  'High Contrast': { ru:'Высокий контраст', fr:'Contraste élevé', am:'ከፍተኛ ንፅፅር' },
  'Check-in interval': { ru:'Интервал проверки', fr:'Intervalle', am:'የፍተሻ ክፍተት' },
  'Active hours': { ru:'Активные часы', fr:'Heures actives', am:'ንቁ ሰዓታት' },
  'Response window': { ru:'Окно ответа', fr:'Délai de réponse', am:'የምላሽ መስኮት' },
  'Share location with calls': { ru:'Делиться геолокацией', fr:'Partager la position', am:'ከጥሪ ጋር ቦታ ያጋሩ' },
  'Location & Safety': { ru:'Геолокация', fr:'Localisation & Sécurité', am:'ቦታ እና ደህንነት' },
  'Inactivity Alert': { ru:'Оповещение о бездействии', fr:'Alerte d\'inactivité', am:'እንቅስቃሴ አልባ ማንቂያ' },
  'Your Carer Code': { ru:'Ваш код опекуна', fr:'Votre code d\'aidant', am:'የተንከባካቢ ኮድዎ' },
  'Your Patient Code': { ru:'Ваш код пациента', fr:'Votre code patient', am:'የታካሚ ኮድዎ' },
  'Your Family Code': { ru:'Ваш семейный код', fr:'Votre code famille', am:'የቤተሰብ ኮድዎ' },
  'Please enter a 4-character code': { ru:'Введите 4-значный код', fr:'Entrez un code à 4 caractères', am:'የ4-ፊደል ኮድ ያስገቡ' },
  'QR Code': { ru:'QR-код', fr:'Code QR', am:'QR ኮድ' },
  'This will clear all saved data and restart setup. Are you sure?': { ru:'Это удалит все данные. Уверены?', fr:'Cela effacera toutes les données. Êtes-vous sûr?', am:'ሁሉንም ይሰርዛል። እርግጠኛ ነዎት?' },
  'Family member': { ru:'Член семьи', fr:'Membre de la famille', am:'የቤተሰብ አባል' },
  'Simple, reliable care alerts for home and assisted living': { ru:'Простые и надёжные оповещения', fr:'Alertes de soins simples et fiables', am:'ቀላል እና አስተማማኝ የእንክብካቤ ማንቂያዎች' },
  'Patient, resident, or assisted person': { ru:'Пациент или подопечный', fr:'Patient ou résident', am:'ታካሚ ወይም ነዋሪ' },
  'Carer or nurse': { ru:'Опекун или медсестра', fr:'Aidant ou infirmier', am:'ተንከባካቢ ወይም ነርስ' },
  'This is shown to the other person': { ru:'Это видит другой человек', fr:'Ceci est affiché à l\'autre personne', am:'ይህ ለሌላው ሰው ይታያል' },
  'Your name': { ru:'Ваше имя', fr:'Votre nom', am:'ስምዎ' },
  'View call history and care notes': { ru:'Просмотр истории и заметок', fr:'Voir l\'historique et les notes', am:'የጥሪ ታሪክ እና ማስታወሻ ይመልከቱ' },
  'Monitoring for falls': { ru:'Мониторинг падений', fr:'Surveillance des chutes', am:'መውደቅ በመከታተል' },
  'Answer': { ru:'Ответить', fr:'Répondre', am:'መልስ' },
  'Decline': { ru:'Отклонить', fr:'Refuser', am:'ውድቅ' },
  'Call ended': { ru:'Вызов завершён', fr:'Appel terminé', am:'ጥሪ አልቋል' },
  'Call declined': { ru:'Вызов отклонён', fr:'Appel refusé', am:'ጥሪ ውድቅ ተደረገ' },
  'No answer': { ru:'Нет ответа', fr:'Pas de réponse', am:'ምላሽ የለም' },
  'Microphone access required': { ru:'Нужен микрофон', fr:'Micro requis', am:'ማይክሮፎን ያስፈልጋል' },
  'Voice call disconnected': { ru:'Связь прервана', fr:'Appel déconnecté', am:'የድምፅ ጥሪ ተቋርጧል' },
  'Care note saved': { ru:'Заметка сохранена', fr:'Note enregistrée', am:'የእንክብካቤ ማስታወሻ ተቀምጧል' },
  'Phone number saved': { ru:'Телефон сохранён', fr:'Numéro enregistré', am:'ስልክ ቁጥር ተቀምጧል' },
  'Phone number removed': { ru:'Телефон удалён', fr:'Numéro supprimé', am:'ስልክ ቁጥር ተወግዷል' },
  'Avatar updated': { ru:'Аватар обновлён', fr:'Avatar mis à jour', am:'ምስል ተዘምኗል' },
  'Online:': { ru:'Онлайн:', fr:'En ligne:', am:'መስመር ላይ:' },
  'No one connected yet': { ru:'Никто не подключен', fr:'Personne connecté', am:'ገና ማንም አልተገናኘም' },
  'No calls to export': { ru:'Нет вызовов для экспорта', fr:'Pas d\'appels à exporter', am:'ለመላክ ጥሪ የለም' },
  'Waiting for connection…': { ru:'Ожидание подключения…', fr:'En attente de connexion…', am:'ግንኙነት በመጠበቅ…' },
  'No connections yet — add a patient or carer in Settings': { ru:'Нет подключений — добавьте в Настройках', fr:'Pas de connexions — ajoutez dans Paramètres', am:'ግንኙነት የለም — በቅንብሮች ያክሉ' },
  'Notification permission denied': { ru:'Уведомления отклонены', fr:'Notifications refusées', am:'ማሳወቂያ ፈቃድ ተከልክሏል' },
  'Already connected to': { ru:'Уже подключен к', fr:'Déjà connecté à', am:'ቀድሞ ተገናኝቷል' },
  'Connected to': { ru:'Подключен к', fr:'Connecté à', am:'ተገናኝቷል ከ' },
  'No available carers': { ru:'Нет доступных опекунов', fr:'Pas d\'aidants disponibles', am:'ዝግጁ ተንከባካቢ የለም' },
  'All carers notified — waiting for response': { ru:'Все уведомлены — ожидание', fr:'Tous notifiés — en attente', am:'ሁሉም ተንከባካቢዎች ተነግረዋል' },
  'Calling your carers…': { ru:'Вызов опекунов…', fr:'Appel des aidants…', am:'ተንከባካቢዎችን በመጥራት…' },
  'Carers have been alerted': { ru:'Опекуны оповещены', fr:'Aidants alertés', am:'ተንከባካቢዎች ተነግረዋል' },
  'Carers alerted — no activity detected': { ru:'Оповещены — нет активности', fr:'Alertés — aucune activité', am:'ተንከባካቢዎች ተነገሩ — እንቅስቃሴ አልተገኘም' },
  // ── Settings labels ──
  'Used as offline fallback': { ru:'Резервный без интернета', fr:'Secours hors ligne', am:'ከኢንተርኔት ውጪ ምትክ', es:'Respaldo sin internet', zh:'离线备用', hi:'ऑफ़लाइन फ़ॉलबैक', ar:'بديل بدون إنترنت', he:'גיבוי ללא אינטרנט' },
  'Inactivity threshold': { ru:'Порог бездействия', fr:'Seuil d\'inactivité', am:'የእንቅስቃሴ ገደብ', es:'Umbral de inactividad', zh:'无活动阈值', hi:'निष्क्रियता सीमा', ar:'حد عدم النشاط', he:'סף חוסר פעילות' },
  'Carers see your location': { ru:'Опекуны видят ваше местоположение', fr:'Les aidants voient votre position', am:'ተንከባካቢዎች ቦታዎን ያያሉ', es:'Los cuidadores ven tu ubicación', zh:'护理员可见你的位置', hi:'केयरर आपका स्थान देखें', ar:'يرى المُعتنون موقعك', he:'המטפלים רואים את מיקומך' },
  'Safe Zone': { ru:'Безопасная зона', fr:'Zone sûre', am:'ደህና ቦታ', es:'Zona Segura', zh:'安全区域', hi:'सेफ ज़ोन', ar:'المنطقة الآمنة', he:'אזור בטוח' },
  'Alert if patient leaves home': { ru:'Оповещение при уходе', fr:'Alerte si le patient sort', am:'ታካሚ ቤት ከለቀቀ ማንቂያ', es:'Alertar si el paciente sale', zh:'患者离开时警报', hi:'मरीज घर छोड़ने पर अलर्ट', ar:'تنبيه إذا غادر المريض', he:'התראה אם המטופל עוזב' },
  'Emergency Info Card': { ru:'Карта экстренной помощи', fr:'Fiche d\'urgence', am:'የአደጋ መረጃ ካርድ', es:'Tarjeta de Emergencia', zh:'急救信息卡', hi:'आपातकालीन जानकारी कार्ड', ar:'بطاقة معلومات الطوارئ', he:'כרטיס מידע חירום' },
  'Test': { ru:'Тест', fr:'Tester', am:'ሞክር', es:'Probar', zh:'测试', hi:'टेस्ट', ar:'اختبار', he:'בדיקה' },
  'Change': { ru:'Изменить', fr:'Changer', am:'ቀይር', es:'Cambiar', zh:'更改', hi:'बदलें', ar:'تغيير', he:'שנה' },
  'Call for Help': { ru:'Позвать на помощь', fr:'Appeler à l\'aide', am:'እርዳታ ጥሪ', es:'Pedir Ayuda', zh:'呼救', hi:'मदद के लिए कॉल', ar:'اطلب المساعدة', he:'קרא לעזרה' },
  'No Connection': { ru:'Нет связи', fr:'Pas de connexion', am:'ግንኙነት የለም', es:'Sin Conexión', zh:'无连接', hi:'कोई कनेक्शन नहीं', ar:'لا يوجد اتصال', he:'אין חיבור' },
  'Help Coming': { ru:'Помощь идёт', fr:'Aide en route', am:'እርዳታ እየመጣ', es:'Ayuda en camino', zh:'帮助来了', hi:'मदद आ रही है', ar:'المساعدة قادمة', he:'עזרה בדרך' },
  'Call': { ru:'Позвонить', fr:'Appeler', am:'ደውል', es:'Llamar', zh:'拨打', hi:'कॉल', ar:'اتصل', he:'התקשר' },
  'No phone numbers available': { ru:'Нет номеров', fr:'Pas de numéros', am:'ስልክ ቁጥር የለም', es:'Sin números', zh:'没有号码', hi:'कोई नंबर नहीं', ar:'لا أرقام', he:'אין מספרים' },
  'View / Edit': { ru:'Просмотр', fr:'Voir / Modifier', am:'ይመልከቱ / ያርትዑ', es:'Ver / Editar', zh:'查看 / 编辑', hi:'देखें / संपादित', ar:'عرض / تعديل', he:'צפה / ערוך' },
  'Set': { ru:'Установить', fr:'Définir', am:'አዘጋጅ', es:'Establecer', zh:'设置', hi:'सेट', ar:'تعيين', he:'הגדר' },
  'Clear': { ru:'Очистить', fr:'Effacer', am:'አጥፋ', es:'Borrar', zh:'清除', hi:'हटाएं', ar:'مسح', he:'נקה' },
  'Check-in description': { ru:'Периодические проверки. Если нет ответа — опекуны оповещены.', fr:'Prompts périodiques. Sans réponse, les aidants sont alertés.', am:'ወቅታዊ ፍተሻዎች። ምላሽ ከሌለ ተንከባካቢዎች ይነገራሉ።', es:'Indicaciones periódicas. Sin respuesta, se alerta a los cuidadores.', zh:'定期提示。无回应则通知护理员。', hi:'नियमित संकेत। कोई जवाब नहीं तो केयरर को सूचित।', ar:'تنبيهات دورية. إذا لم يُرد، يتم تنبيه المُعتنين.', he:'בדיקות תקופתיות. אם אין תגובה, המטפלים מקבלים התראה.' },
  'Inactivity description': { ru:'Оповестить опекунов если нет активности телефона.', fr:'Alerter si aucune activité téléphonique.', am:'የስልክ እንቅስቃሴ ከሌለ ተንከባካቢዎችን ያንቁ።', es:'Alertar si no hay actividad durante horas activas.', zh:'无手机活动时通知护理员。', hi:'फ़ोन गतिविधि न होने पर केयरर को सूचित।', ar:'تنبيه إذا لم يكن هناك نشاط هاتفي.', he:'התראה אם אין פעילות טלפון בשעות ערות.' },
  'Medication description': { ru:'Напоминания по расписанию. Уведомление если пропущено.', fr:'Rappels programmés. Notification si manqué.', am:'በሰዓቱ ማስታወሻ። ከተዘለለ ማሳወቂያ።', es:'Recordatorios programados. Notificación si se omite.', zh:'定时提醒。遗漏则通知。', hi:'निर्धारित अनुस्मारक। छोड़ने पर सूचना।', ar:'تذكيرات مجدولة. إشعار إذا فات.', he:'תזכורות בזמנים קבועים. הודעה אם פוספסה.' },
  'Notification help': { ru:'Если не показывает — проверьте настройки уведомлений', fr:'Si rien ne s\'affiche — vérifiez les paramètres', am:'ካልታየ — የማሳወቂያ ቅንብሮችን ያረጋግጡ', es:'Si no aparece — revise la configuración', zh:'如未显示 — 检查通知设置', hi:'अगर नहीं दिखे — सूचना सेटिंग्स जांचें', ar:'إذا لم يظهر — تحقق من إعدادات الإشعارات', he:'אם לא מופיע — בדוק הגדרות התראות' },
  // ── Phase 7 UX Polish (ru/fr/am) ──
  'Calling': { ru:'Вызов', fr:'Appel de', am:'በመደወል' },
  'Paging backup carer…': { ru:'Вызов резервного опекуна…', fr:'Appel de l\'aidant de secours…', am:'ተጠባባቂ ተንከባካቢን በመጥራት…' },
  'No medications yet. Tap + Add to set up reminders.': { ru:'Нет лекарств. Нажмите + чтобы добавить.', fr:'Pas de médicaments. Appuyez sur + pour en ajouter.', am:'ገና መድሃኒቶች የሉም። ማስታወሻ ለማዘጋጀት + ይጫኑ።' },
  'No connections yet — enter a pair code below to connect.': { ru:'Нет подключений — введите код ниже.', fr:'Pas de connexions — entrez un code ci-dessous.', am:'ገና ግንኙነቶች የሉም — ከታች ኮድ ያስገቡ።' },
  'Camera not available — you can type the code manually instead.': { ru:'Камера недоступна — введите код вручную.', fr:'Caméra indisponible — saisissez le code manuellement.', am:'ካሜራ አይገኝም — ኮዱን በእጅ ያስገቡ።' },
  'Basic': { ru:'Основное', fr:'Base', am:'መሰረታዊ' },
  'Advanced': { ru:'Дополнительно', fr:'Avancé', am:'የላቀ' },
  'Filter settings…': { ru:'Фильтр настроек…', fr:'Filtrer les paramètres…', am:'ቅንብሮችን አጣራ…' },
  'Welcome to CareCall': { ru:'Добро пожаловать в CareCall', fr:'Bienvenue sur CareCall', am:'ወደ CareCall እንኳን ደህና መጡ' },
  'Tap the big button to call your carer. Select what you need first (water, food, pain, etc.) for a faster response.': { ru:'Нажмите большую кнопку, чтобы вызвать опекуна. Сначала выберите, что нужно (вода, еда, боль и т.д.) для быстрого ответа.', fr:'Appuyez sur le gros bouton pour appeler votre aidant. Sélectionnez d\'abord ce dont vous avez besoin (eau, nourriture, douleur, etc.) pour une réponse plus rapide.', am:'ተንከባካቢዎን ለመጥራት ትልቁን ቁልፍ ይጫኑ። ፈጣን ምላሽ ለማግኘት መጀመሪያ የሚፈልጉትን ይምረጡ (ውሃ, ምግብ, ህመም, ወዘተ)።' },
  'The red SOS button is for emergencies — hold it for 3 seconds.': { ru:'Красная кнопка SOS — для экстренных случаев. Удерживайте 3 секунды.', fr:'Le bouton SOS rouge est pour les urgences — maintenez-le pendant 3 secondes.', am:'ቀይ SOS ቁልፍ ለአደጋ ጊዜ ነው — 3 ሰከንድ ያዙት።' },
  'Got it!': { ru:'Понятно!', fr:'Compris !', am:'ገባኝ!' },
  'Not connected to a carer yet': { ru:'Ещё не подключены к опекуну', fr:'Pas encore connecté à un aidant', am:'ገና ከተንከባካቢ ጋር አልተገናኘም' },
  'Share your code to connect:': { ru:'Поделитесь кодом для подключения:', fr:'Partagez votre code pour vous connecter :', am:'ለመገናኘት ኮድዎን ያጋሩ:' },
  'Go to Settings to connect': { ru:'Перейти в Настройки', fr:'Aller aux Paramètres', am:'ለመገናኘት ወደ ቅንብሮች ይሂዱ' },
  'Home': { ru:'Главная', fr:'Accueil', am:'ቤት' },
  'Log': { ru:'Журнал', fr:'Journal', am:'ምዝግብ' },
  'Emergency': { ru:'Экстренная', fr:'Urgence', am:'አደጋ' },
  'Large Text': { ru:'Крупный текст', fr:'Grand texte', am:'ትልቅ ጽሑፍ' },
  'High Contrast': { ru:'Высокий контраст', fr:'Contraste élevé', am:'ከፍተኛ ንፅፅር' },
  'Increase text size across the app': { ru:'Увеличить размер текста', fr:'Augmenter la taille du texte', am:'በመተግበሪያ ሁሉ የጽሑፍ መጠንን ይጨምሩ' },
  'Stronger colours and borders': { ru:'Более яркие цвета и границы', fr:'Couleurs et bordures plus fortes', am:'ጠንካራ ቀለሞች እና ድንበሮች' },
  'Display': { ru:'Отображение', fr:'Affichage', am:'ማሳያ' },
  // ── Calendar (ru/fr/am) ──
  'Calendar': { ru:'Календарь', fr:'Calendrier', am:'ቀን መቁጠሪያ' },
  'New Event': { ru:'Новое событие', fr:'Nouvel événement', am:'አዲስ ክስተት' },
  'Edit Event': { ru:'Редактировать', fr:'Modifier l\'événement', am:'ክስተት አርትዕ' },
  'Delete Event': { ru:'Удалить событие', fr:'Supprimer l\'événement', am:'ክስተት ሰርዝ' },
  'No events this day': { ru:'Нет событий', fr:'Aucun événement', am:'ዛሬ ምንም ክስተት የለም' },
  'Appointment': { ru:'Приём', fr:'Rendez-vous', am:'ቀጠሮ' },
  'Shift': { ru:'Смена', fr:'Quart', am:'ፈረቃ' },
  'Other': { ru:'Другое', fr:'Autre', am:'ሌላ' },
  'Notes': { ru:'Заметки', fr:'Notes', am:'ማስታወሻዎች' },
  'Priority': { ru:'Приоритет', fr:'Priorité', am:'ቅድሚያ' },
  'Flag as important': { ru:'Отметить как важное', fr:'Marquer comme important', am:'አስፈላጊ ምልክት' },
  'Event added': { ru:'Событие добавлено', fr:'Événement ajouté', am:'ክስተት ተጨምሯል' },
  'Event updated': { ru:'Событие обновлено', fr:'Événement mis à jour', am:'ክስተት ተዘምኗል' },
  'Event deleted': { ru:'Событие удалено', fr:'Événement supprimé', am:'ክስተት ተሰርዟል' },
  'Delete this event?': { ru:'Удалить это событие?', fr:'Supprimer cet événement ?', am:'ይህን ክስተት ይሰርዙ?' },
  'Please enter a title': { ru:'Введите название', fr:'Veuillez saisir un titre', am:'እባክዎ ርዕስ ያስገቡ' },
  'Please select a date': { ru:'Выберите дату', fr:'Veuillez sélectionner une date', am:'እባክዎ ቀን ይምረጡ' },
  'No room available': { ru:'Нет доступной комнаты', fr:'Aucune salle disponible', am:'ክፍል አይገኝም' },
  'Title': { ru:'Название', fr:'Titre', am:'ርዕስ' },
  'Date': { ru:'Дата', fr:'Date', am:'ቀን' },
  'Time': { ru:'Время', fr:'Heure', am:'ሰዓት' },
  'Type': { ru:'Тип', fr:'Type', am:'ዓይነት' },
  '(optional)': { ru:'(необязательно)', fr:'(optionnel)', am:'(አማራጭ)' },
  'On': { ru:'Вкл', fr:'Activé', am:'በርቷል' },
  'Off': { ru:'Выкл', fr:'Désactivé', am:'ጠፍቷል' },
  'January': { ru:'Январь', fr:'Janvier', am:'ጃንዋሪ' },
  'February': { ru:'Февраль', fr:'Février', am:'ፌብሩዋሪ' },
  'March': { ru:'Март', fr:'Mars', am:'ማርች' },
  'April': { ru:'Апрель', fr:'Avril', am:'ኤፕሪል' },
  'May': { ru:'Май', fr:'Mai', am:'ሜይ' },
  'June': { ru:'Июнь', fr:'Juin', am:'ጁን' },
  'July': { ru:'Июль', fr:'Juillet', am:'ጁላይ' },
  'August': { ru:'Август', fr:'Août', am:'ኦገስት' },
  'September': { ru:'Сентябрь', fr:'Septembre', am:'ሴፕቴምበር' },
  'October': { ru:'Октябрь', fr:'Octobre', am:'ኦክቶበር' },
  'November': { ru:'Ноябрь', fr:'Novembre', am:'ኖቬምበር' },
  'December': { ru:'Декабрь', fr:'Décembre', am:'ዲሴምበር' },
  // ── Health Tracking ──
  'Health': { ru:'Здоровье', fr:'Santé', am:'ጤና' },
  'Health Log': { ru:'Журнал здоровья', fr:'Journal de santé', am:'የጤና ምዝገባ' },
  'Vitals': { ru:'Показатели', fr:'Signes vitaux', am:'የሕይወት ምልክቶች' },
  'Blood Pressure': { ru:'Артериальное давление', fr:'Pression artérielle', am:'የደም ግፊት' },
  'Heart Rate': { ru:'Пульс', fr:'Fréquence cardiaque', am:'የልብ ምት' },
  'Blood Sugar': { ru:'Сахар в крови', fr:'Glycémie', am:'የደም ስኳር' },
  'Temperature': { ru:'Температура', fr:'Température', am:'ሙቀት' },
  'Oxygen Saturation': { ru:'Сатурация', fr:'Saturation en oxygène', am:'የኦክሲጅን ሙላት' },
  'Pain Level': { ru:'Уровень боли', fr:'Niveau de douleur', am:'የህመም ደረጃ' },
  'Mood': { ru:'Настроение', fr:'Humeur', am:'ስሜት' },
  'Measurement saved': { ru:'Измерение сохранено', fr:'Mesure enregistrée', am:'ልኬት ተቀምጧል' },
  'Recent Entries': { ru:'Недавние записи', fr:'Entrées récentes', am:'የቅርብ ጊዜ ግቤቶች' },
  'No health entries yet': { ru:'Записей пока нет', fr:'Aucune entrée de santé', am:'ገና የጤና ግቤቶች የሉም' },
  'Yesterday': { ru:'Вчера', fr:'Hier', am:'ትናንት' },
  'Systolic': { ru:'Систолическое', fr:'Systolique', am:'ሲስቶሊክ' },
  'Diastolic': { ru:'Диастолическое', fr:'Diastolique', am:'ዲያስቶሊክ' },
  'Already calling…': { ru:'Уже вызывается…', fr:'Appel déjà en cours…', am:'ቀድሞ በመደወል…' },
  'Night mode is for patients only': { ru:'Ночной режим только для пациентов', fr:'Le mode nuit est réservé aux patients', am:'የሌሊት ሁነታ ለታካሚዎች ብቻ ነው' },
  'Exit Bedside Mode': { ru:'Выйти из режима «у кровати»', fr:'Quitter le mode chevet', am:'ከአልጋ ዳር ሁነታ ውጣ' },
  'Swipe down to exit': { ru:'Проведите вниз для выхода', fr:'Balayez vers le bas pour quitter', am:'ለመውጣት ወደ ታች ያንሸራትቱ' },
  'Already have an account? Sign in': { ru:'Уже есть аккаунт? Войти', fr:'Vous avez déjà un compte ? Connectez-vous', am:'መለያ አለዎት? ይግቡ' },
  'more': { ru:'ещё', fr:'plus', am:'ተጨማሪ' },
  'Calling your carer in': { ru:'Вызов вашего опекуна через', fr:'Appel de votre aidant dans', am:'ተንከባካቢዎን በመጥራት በ' },
  'Medication Reminder': { ru:'Напоминание о лекарстве', fr:'Rappel de médicament', am:'የመድሃኒት ማስታወሻ' },
  'Snooze 15 min': { ru:'Отложить 15 мин', fr:'Reporter 15 min', am:'15 ደቂቃ ደግም' },
  'Enter medication name': { ru:'Введите название лекарства', fr:'Entrez le nom du médicament', am:'የመድሃኒት ስም ያስገቡ' },
  'Set a time': { ru:'Установите время', fr:'Définissez une heure', am:'ሰዓት ያዘጋጁ' },
  'As needed': { ru:'По необходимости', fr:'Au besoin', am:'እንደ ፍላጎት' },
  'Every': { ru:'Каждые', fr:'Toutes les', am:'በየ' },
  'Remove': { ru:'Удалить', fr:'Supprimer', am:'አስወግድ' },
  'Carer alerted if not taken in': { ru:'Опекун оповещён, если не принято в течение', fr:'L\'aidant est alerté si non pris dans', am:'ካልተወሰደ ተንከባካቢ ይነገራል በ' },
  'Missed medication': { ru:'Пропущенное лекарство', fr:'Médicament manqué', am:'የተዘለለ መድሃኒት' },
  'Skipped medication': { ru:'Лекарство пропущено', fr:'Médicament sauté', am:'የተቀረ መድሃኒት' },
  'logged as taken': { ru:'отмечено как принятое', fr:'enregistré comme pris', am:'እንደተወሰደ ተመዝግቧል' },
  'snoozed 15 min': { ru:'отложено на 15 мин', fr:'reporté de 15 min', am:'15 ደቂቃ ተደግሟል' },
  'skipped': { ru:'пропущено', fr:'sauté', am:'ተዘልሏል' },
  'max snoozes reached, marked as missed': { ru:'достигнут лимит отсрочек — отмечено как пропущенное', fr:'reports max atteints, marqué comme manqué', am:'ከፍተኛ ደግሞ ደርሷል፣ እንደተዘለለ ተመዝግቧል' },
  'was already logged recently': { ru:'уже отмечено недавно', fr:'déjà enregistré récemment', am:'ቅርብ ጊዜ ቀድሞ ተመዝግቧል' },
  'Log again?': { ru:'Записать снова?', fr:'Enregistrer à nouveau ?', am:'እንደገና ይመዝገቡ?' },
  '+ Add medication': { ru:'+ Добавить лекарство', fr:'+ Ajouter un médicament', am:'+ መድሃኒት ያክሉ' },
  'New medication': { ru:'Новое лекарство', fr:'Nouveau médicament', am:'አዲስ መድሃኒት' },
  'Edit medication': { ru:'Редактировать лекарство', fr:'Modifier le médicament', am:'መድሃኒት አርትዕ' },
  'Medication added': { ru:'Лекарство добавлено', fr:'Médicament ajouté', am:'መድሃኒት ተጨምሯል' },
  'Medication updated': { ru:'Лекарство обновлено', fr:'Médicament mis à jour', am:'መድሃኒት ተዘምኗል' },
  'Name': { ru:'Название', fr:'Nom', am:'ስም' },
  'Active ingredient': { ru:'Действующее вещество', fr:'Principe actif', am:'ንቁ ንጥረ ነገር' },
  'for interaction checks': { ru:'для проверки взаимодействий', fr:'pour vérifier les interactions', am:'የግንኙነት ፍተሻ' },
  'e.g. Paracetamol (for Acamol)': { ru:'напр. Парацетамол (для Акамола)', fr:'ex. Paracétamol (pour Acamol)', am:'ለምሳሌ ፓራሲታሞል (ለአካሞል)' },
  'Looks like': { ru:'Похоже на', fr:'Ressemble à', am:'ይመስላል' },
  'use as active ingredient': { ru:'использовать как действующее вещество', fr:'utiliser comme principe actif', am:'እንደ ንቁ ንጥረ ነገር ተጠቀም' },
  'No warnings from our built-in checks. This is a limited rule set — confirm the full list with a pharmacist or doctor.': { ru:'Встроенные проверки не выявили предупреждений. Это ограниченный набор правил — подтвердите полный список у фармацевта или врача.', fr:'Aucun avertissement de nos vérifications intégrées. Cet ensemble de règles est limité — confirmez la liste complète auprès d\'un pharmacien ou d\'un médecin.', am:'ከእኛ ቅጥ-ውስጥ ፍተሻዎች ምንም ማስጠንቀቂያ አልተገኘም። ይህ ውስን ህግ ነው — ሙሉ ዝርዝሩን ከፋርማሲስት ወይም ዶክተር ያረጋግጡ።' },
  'Dose': { ru:'Дозировка', fr:'Dose', am:'መጠን' },
  'Unit': { ru:'Единица', fr:'Unité', am:'ክፍል' },
  'Instructions': { ru:'Указания', fr:'Instructions', am:'መመሪያዎች' },
  'optional': { ru:'необязательно', fr:'facultatif', am:'አማራጭ' },
  'e.g. Metformin': { ru:'напр. Метформин', fr:'ex. Metformine', am:'ለምሳሌ ሜትፎርሚን' },
  'e.g. with food': { ru:'напр. с едой', fr:'ex. avec de la nourriture', am:'ለምሳሌ ከምግብ ጋር' },
  'Schedule': { ru:'Расписание', fr:'Horaire', am:'መርሃ ግብር' },
  'At specific times': { ru:'В определённое время', fr:'À des heures précises', am:'በተወሰኑ ሰዓታት' },
  'Certain days only': { ru:'Только в определённые дни', fr:'Certains jours seulement', am:'በተወሰኑ ቀናት ብቻ' },
  'Every N hours': { ru:'Каждые N часов', fr:'Toutes les N heures', am:'በየ N ሰዓት' },
  'As needed (no reminder)': { ru:'По необходимости (без напоминания)', fr:'Au besoin (pas de rappel)', am:'እንደ ፍላጎት (ያለ ማስታወሻ)' },
  'Reminder times': { ru:'Время напоминаний', fr:'Heures de rappel', am:'የማስታወሻ ሰዓታት' },
  'Add time': { ru:'Добавить время', fr:'Ajouter une heure', am:'ሰዓት ያክሉ' },
  'Tap + to add a time.': { ru:'Нажмите +, чтобы добавить время.', fr:'Appuyez sur + pour ajouter une heure.', am:'ሰዓት ለማከል + ይጫኑ።' },
  'Remove time': { ru:'Удалить время', fr:'Supprimer l\'heure', am:'ሰዓት አስወግድ' },
  'Days of week': { ru:'Дни недели', fr:'Jours de la semaine', am:'የሳምንት ቀናት' },
  'Every (hours)': { ru:'Каждые (часы)', fr:'Toutes les (heures)', am:'በየ (ሰዓታት)' },
  'First dose': { ru:'Первая доза', fr:'Première dose', am:'የመጀመሪያ መጠን' },
  'No automatic reminder. Log a dose manually when you take it.': { ru:'Без автоматического напоминания. Запишите приём вручную.', fr:'Pas de rappel automatique. Enregistrez une dose manuellement.', am:'ራስ-ሰር ማስታወሻ የለም። ሲወስዱ በእጅ ይመዝግቡ።' },
  'No automatic reminder': { ru:'Без автоматического напоминания', fr:'Pas de rappel automatique', am:'ራስ-ሰር ማስታወሻ የለም' },
  'How long the reminder stays on screen': { ru:'Как долго напоминание остаётся на экране', fr:'Durée d\'affichage du rappel à l\'écran', am:'ማስታወሻው ምን ያህል ጊዜ በማያ ገጹ ላይ ይቆያል' },
  'e.g. Paracetamol': { ru:'напр. Парацетамол', fr:'ex. Paracétamol', am:'ለምሳሌ ፓራሲታሞል' },
  'Save': { ru:'Сохранить', fr:'Enregistrer', am:'አስቀምጥ' },
  'Cancel': { ru:'Отмена', fr:'Annuler', am:'ይቅር' },
  'Remove this medication?': { ru:'Удалить это лекарство?', fr:'Supprimer ce médicament ?', am:'ይህን መድሃኒት ያስወግዱ?' },
  'Remove medication': { ru:'Удалить лекарство', fr:'Supprimer le médicament', am:'መድሃኒት አስወግድ' },
  'Add at least one time.': { ru:'Добавьте хотя бы одно время.', fr:'Ajoutez au moins une heure.', am:'ቢያንስ አንድ ሰዓት ያክሉ።' },
  'Select at least one day.': { ru:'Выберите хотя бы один день.', fr:'Sélectionnez au moins un jour.', am:'ቢያንስ አንድ ቀን ይምረጡ።' },
  'from': { ru:'от', fr:'de', am:'ከ' },
  'Sun': { ru:'Вс', fr:'Dim', am:'እሑድ' },
  'Mon': { ru:'Пн', fr:'Lun', am:'ሰኞ' },
  'Tue': { ru:'Вт', fr:'Mar', am:'ማክሰ' },
  'Wed': { ru:'Ср', fr:'Mer', am:'ረቡዕ' },
  'Thu': { ru:'Чт', fr:'Jeu', am:'ሐሙስ' },
  'Fri': { ru:'Пт', fr:'Ven', am:'ዓርብ' },
  'Sat': { ru:'Сб', fr:'Sam', am:'ቅዳሜ' },
  'Patient medications': { ru:'Лекарства пациента', fr:'Médicaments du patient', am:'የታካሚ መድሃኒቶች' },
  'No connected patients': { ru:'Нет подключённых пациентов', fr:'Aucun patient connecté', am:'የተገናኙ ታካሚዎች የሉም' },
  'Select a patient': { ru:'Выберите пациента', fr:'Sélectionnez un patient', am:'ታካሚ ይምረጡ' },
  'Medications': { ru:'Лекарства', fr:'Médicaments', am:'መድሃኒቶች' },
  'No medications configured.': { ru:'Лекарства не настроены.', fr:'Aucun médicament configuré.', am:'መድሃኒቶች አልተዘጋጁም።' },
  'Managing for': { ru:'Управление для', fr:'Gestion pour', am:'ለ… ማስተዳደር' },
  'Medication removed': { ru:'Лекарство удалено', fr:'Médicament supprimé', am:'መድሃኒት ተወግዷል' },
  'Save failed': { ru:'Не удалось сохранить', fr:'Échec de l\'enregistrement', am:'ማስቀመጥ አልተሳካም' },
  'Close': { ru:'Закрыть', fr:'Fermer', am:'ዝጋ' },
  'Pills in stock': { ru:'Таблеток в наличии', fr:'Comprimés en stock', am:'በክምችት ያሉ እንክብሎች' },
  'Alert when below': { ru:'Оповещение при менее чем', fr:'Alerter quand en dessous de', am:'ከዚህ ሲቀንስ ማንቂያ' },
  'left': { ru:'осталось', fr:'restants', am:'ቀሪ' },
  'Refill': { ru:'Пополнить', fr:'Renouveler', am:'ሙላ' },
  'Refill needed': { ru:'Требуется пополнение', fr:'Renouvellement nécessaire', am:'ሙሌት ያስፈልጋል' },
  '5 min (strict)': { ru:'5 мин (строго)', fr:'5 min (strict)', am:'5 ደቂቃ (ጥብቅ)' },
  'min': { ru:'мин', fr:'min', am:'ደቂቃ' },
  'hour': { ru:'час', fr:'heure', am:'ሰዓት' },
  'hours': { ru:'часов', fr:'heures', am:'ሰዓታት' },
  'How long the reminder stays responsive. Carer is alerted only after this window closes.': { ru:'Как долго напоминание остаётся активным. Опекун оповещается только после закрытия окна.', fr:'Durée pendant laquelle le rappel reste actif. L\'aidant n\'est alerté qu\'après la fermeture de ce délai.', am:'ማስታወሻው ምን ያህል ጊዜ ንቁ ይሆናል። ተንከባካቢ ይህ መስኮት ከተዘጋ በኋላ ብቻ ይነገራል።' },
  'Photo': { ru:'Фото', fr:'Photo', am:'ፎቶ' },
  'Photos': { ru:'Фото', fr:'Photos', am:'ፎቶዎች' },
  'Add photo': { ru:'Добавить фото', fr:'Ajouter une photo', am:'ፎቶ ያክሉ' },
  'Take photo': { ru:'Сделать фото', fr:'Prendre une photo', am:'ፎቶ አንሱ' },
  'Choose from gallery': { ru:'Выбрать из галереи', fr:'Choisir dans la galerie', am:'ከማዕከለ-ስዕል ይምረጡ' },
  'Spoken reminder': { ru:'Голосовое напоминание', fr:'Rappel vocal', am:'የተነገረ ማስታወሻ' },
  'Read the medication name aloud when it\'s time': { ru:'Произнести название лекарства вслух в нужное время', fr:'Lire le nom du médicament à voix haute à l\'heure prévue', am:'ሰዓቱ ሲደርስ የመድሃኒቱን ስም ጮክ ብሎ ያንብቡ' },
  'Time to take': { ru:'Пора принять', fr:'Heure de prendre', am:'የመውሰጃ ጊዜ' },
  'Adherence report (PDF)': { ru:'Отчёт о приёме (PDF)', fr:'Rapport d\'observance (PDF)', am:'የአዘውታሪነት ሪፖርት (PDF)' },
  'Preparing report…': { ru:'Подготовка отчёта…', fr:'Préparation du rapport…', am:'ሪፖርት በማዘጋጀት…' },
  'PDF downloaded': { ru:'PDF скачан', fr:'PDF téléchargé', am:'PDF ወርዷል' },
  'Report ready — choose where to save': { ru:'Отчёт готов — выберите, куда сохранить', fr:'Rapport prêt — choisissez où enregistrer', am:'ሪፖርት ዝግጁ ነው — የት እንደሚቀመጥ ይምረጡ' },
  'PDF saved to app': { ru:'PDF сохранён в приложении', fr:'PDF enregistré dans l\'application', am:'PDF በመተግበሪያ ተቀምጧል' },
  'PDF library is not loaded': { ru:'Библиотека PDF не загружена', fr:'La bibliothèque PDF n\'est pas chargée', am:'PDF ቤተ-መጽሐፍት አልተጫነም' },
  'Check drug interactions': { ru:'Проверить взаимодействия лекарств', fr:'Vérifier les interactions médicamenteuses', am:'የመድሃኒት ግንኙነቶችን ይፈትሹ' },
  'Drug interactions': { ru:'Взаимодействия лекарств', fr:'Interactions médicamenteuses', am:'የመድሃኒት ግንኙነቶች' },
  'Drug Interaction Warning': { ru:'Предупреждение о взаимодействии', fr:'Avertissement d\'interaction', am:'የመድሃኒት ግንኙነት ማስጠንቀቂያ' },
  'The following interactions were detected with existing medications:': { ru:'Обнаружены следующие взаимодействия с текущими лекарствами:', fr:'Les interactions suivantes ont été détectées avec les médicaments existants :', am:'ከነባር መድሃኒቶች ጋር የሚከተሉ ግንኙነቶች ተገኝተዋል:' },
  'Save Anyway': { ru:'Сохранить всё равно', fr:'Enregistrer quand même', am:'ያንንም ሆኖ አስቀምጥ' },
  'Has known interactions': { ru:'Есть известные взаимодействия', fr:'Interactions connues', am:'የታወቁ ግንኙነቶች አሉት' },
  'This is a safety net — confirm with a pharmacist or doctor.': { ru:'Это мера предосторожности — подтвердите у фармацевта или врача.', fr:'Ceci est un filet de sécurité — confirmez auprès d\'un pharmacien ou d\'un médecin.', am:'ይህ የደህንነት ጥበቃ ነው — ከፋርማሲስት ወይም ዶክተር ያረጋግጡ።' },
  'Checking interactions…': { ru:'Проверка взаимодействий…', fr:'Vérification des interactions…', am:'ግንኙነቶችን በመፈተሽ…' },
  'Need at least two medications to check interactions.': { ru:'Для проверки нужны минимум два лекарства.', fr:'Il faut au moins deux médicaments pour vérifier les interactions.', am:'ግንኙነቶችን ለመፈተሽ ቢያንስ ሁለት መድሃኒቶች ያስፈልጋሉ።' },
  'Could not identify enough medications in the drug database.': { ru:'Не удалось распознать достаточно лекарств в базе данных.', fr:'Impossible d\'identifier suffisamment de médicaments dans la base de données.', am:'በመድሃኒት ዳታቤዝ ውስጥ በቂ መድሃኒቶች ለይቶ ማወቅ አልተቻለም።' },
  'Interaction service is unavailable right now.': { ru:'Сервис взаимодействий сейчас недоступен.', fr:'Le service d\'interactions est actuellement indisponible.', am:'የግንኙነት አገልግሎት አሁን አይገኝም።' },
  'No interaction data returned by the service.': { ru:'Сервис не вернул данных о взаимодействиях.', fr:'Aucune donnée d\'interaction renvoyée par le service.', am:'ከአገልግሎቱ የግንኙነት መረጃ አልተመለሰም።' },
  'Could not reach the interaction service.': { ru:'Не удалось подключиться к сервису.', fr:'Impossible de joindre le service d\'interactions.', am:'የግንኙነት አገልግሎቱን ማግኘት አልተቻለም።' },
  'No interactions found for the listed medications.': { ru:'Взаимодействий для указанных лекарств не обнаружено.', fr:'Aucune interaction trouvée pour les médicaments listés.', am:'ለተዘረዘሩ መድሃኒቶች ግንኙነቶች አልተገኙም።' },
  'Not found in database': { ru:'Не найдено в базе данных', fr:'Non trouvé dans la base de données', am:'በዳታቤዝ ውስጥ አልተገኘም' },
  'Source': { ru:'Источник', fr:'Source', am:'ምንጭ' },
  'This check is a safety net and does not replace clinician review. Warnings are based on the NIH RxNav database.': { ru:'Эта проверка — мера предосторожности и не заменяет осмотр врача. Предупреждения основаны на базе NIH RxNav.', fr:'Cette vérification est un filet de sécurité et ne remplace pas l\'avis d\'un clinicien. Les avertissements sont basés sur la base de données NIH RxNav.', am:'ይህ ፍተሻ የደህንነት ጥበቃ ነው እና የሐኪም ምርመራን አይተካም። ማስጠንቀቂያዎች በ NIH RxNav ዳታቤዝ ላይ የተመሰረቱ ናቸው።' },
  'The following interactions were detected between your medications:': { ru:'Обнаружены следующие взаимодействия между вашими лекарствами:', fr:'Les interactions suivantes ont été détectées entre vos médicaments :', am:'በመድሃኒቶችዎ መካከል የሚከተሉ ግንኙነቶች ተገኝተዋል:' },
  'This check is a safety net and does not replace clinician review.': { ru:'Эта проверка — мера предосторожности и не заменяет осмотр врача.', fr:'Cette vérification est un filet de sécurité et ne remplace pas l\'avis d\'un clinicien.', am:'ይህ ፍተሻ የደህንነት ጥበቃ ነው እና የሐኪም ምርመራን አይተካም።' },
  'Need at least two medications to check interactions': { ru:'Для проверки нужны минимум два лекарства', fr:'Il faut au moins deux médicaments pour vérifier les interactions', am:'ግንኙነቶችን ለመፈተሽ ቢያንስ ሁለት መድሃኒቶች ያስፈልጋሉ' },
  'No warnings found — these medications appear safe together.': { ru:'Предупреждений не обнаружено — эти лекарства совместимы.', fr:'Aucun avertissement — ces médicaments semblent sûrs ensemble.', am:'ምንም ማስጠንቀቂያ አልተገኘም — እነዚህ መድሃኒቶች አብረው ደህና ይመስላሉ።' },
  'Checking interactions...': { ru:'Проверка взаимодействий...', fr:'Vérification des interactions...', am:'ግንኙነቶችን በመፈተሽ...' },
  'Medication adherence (30 days)': { ru:'Приём лекарств (30 дней)', fr:'Observance médicamenteuse (30 jours)', am:'የመድሃኒት አዘውታሪነት (30 ቀን)' },
  'Most-missed medications': { ru:'Чаще всего пропускаемые', fr:'Médicaments les plus manqués', am:'ብዙ ጊዜ የተዘለሉ' },
  '30-day average': { ru:'Среднее за 30 дней', fr:'Moyenne 30 jours', am:'30 ቀን አማካይ' },
  'No medication data yet.': { ru:'Данных о лекарствах пока нет.', fr:'Pas encore de données médicamenteuses.', am:'ገና የመድሃኒት ውሂብ የለም።' },
  'No missed doses in the last 30 days 🎉': { ru:'Ни одного пропуска за 30 дней 🎉', fr:'Aucune dose manquée ces 30 derniers jours 🎉', am:'ባለፉት 30 ቀናት ምንም የተዘለለ የለም 🎉' },
  'Replace photo': { ru:'Заменить фото', fr:'Remplacer la photo', am:'ፎቶ ቀይር' },
  'Remove photo': { ru:'Удалить фото', fr:'Supprimer la photo', am:'ፎቶ አስወግድ' },
  'Image is too large': { ru:'Изображение слишком большое', fr:'L\'image est trop grande', am:'ምስሉ በጣም ትልቅ ነው' },
  'Could not read image': { ru:'Не удалось прочитать изображение', fr:'Impossible de lire l\'image', am:'ምስል ማንበብ አልተቻለም' },
  'e.g. pill, box, insert': { ru:'напр. таблетка, коробка, вкладыш', fr:'ex. comprimé, boîte, notice', am:'ለምሳሌ እንክብል, ሳጥን, ገላጭ' },
  'Maximum of {n} photos': { ru:'Максимум {n} фото', fr:'Maximum {n} photos', am:'ከፍተኛ {n} ፎቶዎች' },
  'Previous': { ru:'Предыдущий', fr:'Précédent', am:'ቀዳሚ' },
  'Next': { ru:'Следующий', fr:'Suivant', am:'ቀጣይ' },
  'Your carer': { ru:'Ваш опекун', fr:'Votre aidant', am:'ተንከባካቢዎ' },
  'Please enter your name': { ru:'Пожалуйста, введите ваше имя', fr:'Veuillez entrer votre nom', am:'እባክዎ ስምዎን ያስገቡ' },
  'Fall detection active — keep phone on your body': { ru:'Обнаружение падений активно — держите телефон при себе', fr:'Détection de chutes active — gardez le téléphone sur vous', am:'የመውደቅ ማወቂያ ንቁ ነው — ስልክዎን ከሰውነትዎ ጋር ያስቀምጡ' },
  'Medication name': { ru:'Название лекарства', fr:'Nom du médicament', am:'የመድሃኒት ስም' },
  'Location sharing enabled': { ru:'Передача геолокации включена', fr:'Partage de position activé', am:'ቦታ ማጋራት ነቅቷል' },
  'Location sharing disabled': { ru:'Передача геолокации отключена', fr:'Partage de position désactivé', am:'ቦታ ማጋራት ጠፍቷል' },
  'Incoming voice call': { ru:'Входящий голосовой вызов', fr:'Appel vocal entrant', am:'ገቢ የድምፅ ጥሪ' },
  'is calling!': { ru:'звонит!', fr:'appelle !', am:'እየደወለ ነው!' },
  'Hold longer to record a voice note': { ru:'Удерживайте дольше для записи', fr:'Maintenez plus longtemps pour enregistrer', am:'ለመቅዳት ረዘም ብለው ያዙ' },
  'Voice note recorded': { ru:'Голосовая заметка записана', fr:'Note vocale enregistrée', am:'የድምፅ ማስታወሻ ተቀርጿል' },
  'Recording…': { ru:'Запись…', fr:'Enregistrement…', am:'በመቅረጽ…' },
  'Recorded': { ru:'Записано', fr:'Enregistré', am:'ተቀርጿል' },
  'Microphone access required for voice notes': { ru:'Для голосовых заметок нужен микрофон', fr:'L\'accès au micro est nécessaire pour les notes vocales', am:'ለድምፅ ማስታወሻ ማይክሮፎን ያስፈልጋል' },
  'Could not play audio': { ru:'Не удалось воспроизвести', fr:'Impossible de lire l\'audio', am:'ድምፅ ማጫወት አልተቻለም' },
  'Motion sensor permission required for fall detection': { ru:'Для обнаружения падений нужен доступ к датчикам', fr:'Autorisation du capteur requise pour la détection de chutes', am:'ለመውደቅ ማወቂያ የአንቀሳቃሽ ዳሳሽ ፈቃድ ያስፈልጋል' },
  'Motion sensors not available on this device': { ru:'Датчики движения недоступны на этом устройстве', fr:'Capteurs de mouvement indisponibles sur cet appareil', am:'በዚህ መሳሪያ ላይ ዳሳሽ አይገኝም' },
  'Could not get location': { ru:'Не удалось получить местоположение', fr:'Impossible d\'obtenir la position', am:'ቦታ ማግኘት አልተቻለም' },
  'Safe zone cleared': { ru:'Безопасная зона удалена', fr:'Zone sûre effacée', am:'ደህና ቦታ ተጽዳ' },
  'Carers alerted — you left the safe zone': { ru:'Опекуны оповещены — вы вышли из безопасной зоны', fr:'Aidants alertés — vous avez quitté la zone sûre', am:'ተንከባካቢዎች ተነግረዋል — ከደህና ቦታ ወጥተዋል' },
  'Emergency info saved': { ru:'Экстренная информация сохранена', fr:'Info d\'urgence enregistrée', am:'የአደጋ መረጃ ተቀምጧል' },
  'Voice activation OFF': { ru:'Голосовая активация ВЫКЛ', fr:'Activation vocale DÉSACTIVÉE', am:'የድምፅ ማግበር ጠፍቷል' },
  'Voice command detected — calling carer': { ru:'Голосовая команда — вызов опекуна', fr:'Commande vocale détectée — appel de l\'aidant', am:'የድምፅ ትዕዛዝ ተገኝቷል — ተንከባካቢን በመጥራት' },
  'No personal code yet': { ru:'Нет личного кода', fr:'Pas encore de code personnel', am:'ገና የግል ኮድ የለም' },
  'No active call to listen to': { ru:'Нет активного вызова', fr:'Pas d\'appel actif à écouter', am:'የሚደመጥ ንቁ ጥሪ የለም' },
  'Listening request sent — waiting for audio…': { ru:'Запрос отправлен — ожидание звука…', fr:'Demande envoyée — en attente de l\'audio…', am:'የመስማት ጥያቄ ተልኳል — ድምፅ በመጠበቅ…' },
  'On Call': { ru:'На вызове', fr:'De garde', am:'በጥሪ ላይ' },
  'Your CareCall code': { ru:'Ваш код CareCall', fr:'Votre code CareCall', am:'የ CareCall ኮድዎ' },
  'The other person scans this QR in their CareCall app, or types the four letters.': { ru:'Другой человек сканирует этот QR в CareCall или вводит четыре буквы.', fr:'L\'autre personne scanne ce QR dans son appli CareCall, ou saisit les quatre lettres.', am:'ሌላው ሰው ይህን QR በ CareCall መተግበሪያቸው ይቃኛል ወይም አራቱን ፊደሎች ይጽፋል።' },
  '📷 Scan QR instead': { ru:'📷 Сканировать QR', fr:'📷 Scanner le QR', am:'📷 QR ይቃኙ' },
  'Scan QR code': { ru:'Сканировать QR-код', fr:'Scanner le code QR', am:'QR ኮድ ይቃኙ' },
  'The other person scans this QR code to connect': { ru:'Другой человек сканирует этот QR для подключения', fr:'L\'autre personne scanne ce code QR pour se connecter', am:'ሌላው ሰው ለመገናኘት ይህን QR ኮድ ይቃኛል' },
  'Point camera at the QR code': { ru:'Направьте камеру на QR-код', fr:'Dirigez la caméra vers le code QR', am:'ካሜራውን ወደ QR ኮድ ያመልክቱ' },
  'Point camera at the QR code displayed on the other device': { ru:'Направьте камеру на QR-код на другом устройстве', fr:'Dirigez la caméra vers le code QR affiché sur l\'autre appareil', am:'ካሜራውን በሌላ መሳሪያ ላይ ወደሚታየው QR ኮድ ያመልክቱ' },
  'Could not access the camera.': { ru:'Не удалось получить доступ к камере.', fr:'Impossible d\'accéder à la caméra.', am:'ካሜራ ማግኘት አልተቻለም።' },
  'Scanner unavailable — check your connection': { ru:'Сканер недоступен — проверьте соединение', fr:'Scanner indisponible — vérifiez votre connexion', am:'ቃኝ አይገኝም — ግንኙነትዎን ያረጋግጡ' },
  'Code scanned': { ru:'Код отсканирован', fr:'Code scanné', am:'ኮድ ተቃኝቷል' },
  'Connect to code': { ru:'Подключиться к коду', fr:'Se connecter au code', am:'ወደ ኮድ ይገናኙ' },
  'Active — {n}m radius': { ru:'Активна — радиус {n} м', fr:'Active — rayon {n} m', am:'ንቁ — {n} ሜ. ራዲየስ' },
  'Paused — tap to enable': { ru:'Приостановлена — нажмите для включения', fr:'En pause — appuyez pour activer', am:'ቆሟል — ለማንቃት ይጫኑ' },
  'Alert carers if patient leaves home area': { ru:'Оповестить опекунов при уходе пациента', fr:'Alerter les aidants si le patient quitte la zone', am:'ታካሚ ከቤት ቦታ ከወጣ ተንከባካቢዎችን ያንቁ' },
  'Carers are alerted when the patient leaves this zone. Works while the app is open in the foreground.': { ru:'Опекуны оповещаются, когда пациент покидает зону. Работает при открытом приложении.', fr:'Les aidants sont alertés quand le patient quitte cette zone. Fonctionne quand l\'appli est ouverte au premier plan.', am:'ታካሚ ከዚህ ቦታ ሲወጣ ተንከባካቢዎች ይነገራሉ። መተግበሪያው ክፍት ሆኖ ሲሰራ ይሰራል።' },
  'Center point': { ru:'Центральная точка', fr:'Point central', am:'ማዕከላዊ ነጥብ' },
  'Coordinates captured': { ru:'Координаты получены', fr:'Coordonnées capturées', am:'መጋጠሚያዎች ተይዘዋል' },
  'Not set yet': { ru:'Ещё не задано', fr:'Pas encore défini', am:'ገና አልተዘጋጀም' },
  'Use my current location': { ru:'Использовать моё текущее местоположение', fr:'Utiliser ma position actuelle', am:'የአሁኑን ቦታዬን ተጠቀም' },
  'Update with current location': { ru:'Обновить текущим местоположением', fr:'Mettre à jour avec ma position actuelle', am:'በአሁኑ ቦታ ያዘምኑ' },
  'View': { ru:'Просмотр', fr:'Voir', am:'ይመልከቱ' },
  'Radius': { ru:'Радиус', fr:'Rayon', am:'ራዲየስ' },
  'metres': { ru:'метров', fr:'mètres', am:'ሜትሮች' },
  'm': { ru:'м', fr:'m', am:'ሜ' },
  'Current distance': { ru:'Текущее расстояние', fr:'Distance actuelle', am:'የአሁኑ ርቀት' },
  'Measuring…': { ru:'Измерение…', fr:'Mesure…', am:'በመለካት…' },
  'Set a center first': { ru:'Сначала задайте центр', fr:'Définissez d\'abord un centre', am:'መጀመሪያ ማዕከል ያዘጋጁ' },
  'Inside safe zone': { ru:'Внутри безопасной зоны', fr:'Dans la zone sûre', am:'ደህና ቦታ ውስጥ' },
  'Outside safe zone': { ru:'Вне безопасной зоны', fr:'En dehors de la zone sûre', am:'ከደህና ቦታ ውጪ' },
  'from centre': { ru:'от центра', fr:'du centre', am:'ከማዕከል' },
  'Location unavailable': { ru:'Местоположение недоступно', fr:'Position indisponible', am:'ቦታ አይገኝም' },
  'Could not get location — check permissions and GPS': { ru:'Не удалось определить местоположение — проверьте разрешения и GPS', fr:'Impossible d\'obtenir la position — vérifiez les autorisations et le GPS', am:'ቦታ ማግኘት አልተቻለም — ፈቃዶችን እና GPS ያረጋግጡ' },
  'Monitoring enabled': { ru:'Мониторинг включён', fr:'Surveillance activée', am:'ክትትል ነቅቷል' },
  'Turn off to pause alerts without deleting the zone': { ru:'Отключите для паузы оповещений без удаления зоны', fr:'Désactivez pour suspendre les alertes sans supprimer la zone', am:'ቦታውን ሳይሰርዙ ማንቂያዎችን ለማቆም ያጥፉ' },
  'Set a center point first.': { ru:'Сначала задайте центральную точку.', fr:'Définissez d\'abord un point central.', am:'መጀመሪያ ማዕከላዊ ነጥብ ያዘጋጁ።' },
  'Radius must be between {min} and {max} metres': { ru:'Радиус должен быть от {min} до {max} м', fr:'Le rayon doit être entre {min} et {max} mètres', am:'ራዲየስ ከ {min} እስከ {max} ሜትር መሆን አለበት' },
  'Safe zone saved': { ru:'Безопасная зона сохранена', fr:'Zone sûre enregistrée', am:'ደህና ቦታ ተቀምጧል' },
  'Safe zone saved (monitoring paused)': { ru:'Зона сохранена (мониторинг приостановлен)', fr:'Zone enregistrée (surveillance en pause)', am:'ደህና ቦታ ተቀምጧል (ክትትል ቆሟል)' },
  'Remove the safe zone? You can always set a new one later.': { ru:'Удалить безопасную зону? Вы всегда сможете создать новую.', fr:'Supprimer la zone sûre ? Vous pourrez toujours en créer une nouvelle.', am:'ደህና ቦታ ይሰርዙ? በኋላ አዲስ ማዘጋጀት ይችላሉ።' },
  'Remove safe zone': { ru:'Удалить безопасную зону', fr:'Supprimer la zone sûre', am:'ደህና ቦታ አስወግድ' },
  'Left safe zone': { ru:'Покинул безопасную зону', fr:'A quitté la zone sûre', am:'ደህና ቦታን ለቅቋል' },
  'Safe zones': { ru:'Безопасные зоны', fr:'Zones sûres', am:'ደህና ቦታዎች' },
  'Tap a zone to edit. Add more for day centre, family member’s home, etc.': { ru:'Нажмите на зону для редактирования. Добавьте для дневного центра, дома родственника и т.д.', fr:'Appuyez sur une zone pour modifier. Ajoutez-en pour le centre de jour, la maison d\'un proche, etc.', am:'ለማርትዕ ቦታ ላይ ይጫኑ። ለቀን ማዕከል, ለቤተሰብ ቤት, ወዘተ ተጨማሪ ያክሉ።' },
  'Add zone': { ru:'Добавить зону', fr:'Ajouter une zone', am:'ቦታ ያክሉ' },
  'Maximum of {n} safe zones': { ru:'Максимум {n} безопасных зон', fr:'Maximum {n} zones sûres', am:'ከፍተኛ {n} ደህና ቦታዎች' },
  'New safe zone': { ru:'Новая безопасная зона', fr:'Nouvelle zone sûre', am:'አዲስ ደህና ቦታ' },
  'Edit safe zone': { ru:'Редактировать зону', fr:'Modifier la zone sûre', am:'ደህና ቦታ አርትዕ' },
  'Enter a name for this zone': { ru:'Введите название зоны', fr:'Entrez un nom pour cette zone', am:'ለዚህ ቦታ ስም ያስገቡ' },
  'e.g. Home, Day Centre, Daughter’s': { ru:'напр. Дом, Дневной центр, Дочь', fr:'ex. Maison, Centre de jour, Fille', am:'ለምሳሌ ቤት, ቀን ማዕከል, ሴት ልጅ' },
  'Exit dwell time': { ru:'Время ожидания при выходе', fr:'Temps de séjour à la sortie', am:'የመውጫ ቆይታ ጊዜ' },
  'seconds outside before alert (0 = instant)': { ru:'секунд снаружи до оповещения (0 = сразу)', fr:'secondes à l\'extérieur avant alerte (0 = instantané)', am:'ከማንቂያ በፊት ውጪ ያለ ሰከንዶች (0 = ወዲያው)' },
  'Primary home': { ru:'Основной дом', fr:'Domicile principal', am:'ዋና ቤት' },
  'Used for the “You’re home” indicator': { ru:'Используется для индикатора «Вы дома»', fr:'Utilisé pour l\'indicateur « Vous êtes chez vous »', am:'«ቤት ነዎት» አመልካች ለ' },
  'Remove this zone': { ru:'Удалить эту зону', fr:'Supprimer cette zone', am:'ይህን ቦታ አስወግድ' },
  'Remove this safe zone? You can always add it again later.': { ru:'Удалить эту зону? Вы всегда сможете добавить её снова.', fr:'Supprimer cette zone sûre ? Vous pourrez toujours la rajouter.', am:'ይህን ደህና ቦታ ያስወግዱ? በኋላ እንደገና ማከል ይችላሉ።' },
  'Safe zone removed': { ru:'Зона удалена', fr:'Zone sûre supprimée', am:'ደህና ቦታ ተወግዷል' },
  'dwell': { ru:'ожидание', fr:'séjour', am:'ቆይታ' },
  '{n} active': { ru:'{n} активных', fr:'{n} active(s)', am:'{n} ንቁ' },
  'Outside': { ru:'Вне', fr:'En dehors', am:'ውጪ' },
  'away': { ru:'от центра', fr:'de distance', am:'ርቀት' },
  'Carer alerted in': { ru:'Опекун оповещён через', fr:'Aidant alerté dans', am:'ተንከባካቢ ይነገራል በ' },
  'I\'m safe ✓': { ru:'Я в безопасности ✓', fr:'Je suis en sécurité ✓', am:'ደህና ነኝ ✓' },
  'Alert carer now': { ru:'Оповестить сейчас', fr:'Alerter maintenant', am:'አሁን ተንከባካቢ ያንቁ' },
  'Thanks — carer will not be alerted': { ru:'Спасибо — опекун не будет оповещён', fr:'Merci — l\'aidant ne sera pas alerté', am:'አመሰግናለሁ — ተንከባካቢ አይነገርም' },
  'Arrived at': { ru:'Прибыл в', fr:'Arrivé à', am:'ደርሰዋል ወደ' },
  'Tap the map to set centre, drag the marker to adjust.': { ru:'Нажмите на карту, чтобы задать центр, перетащите маркер.', fr:'Appuyez sur la carte pour définir le centre, faites glisser le marqueur.', am:'ማዕከል ለማዘጋጀት ካርታውን ይጫኑ, ማርከርውን ይጎትቱ።' },
  'You': { ru:'Вы', fr:'Vous', am:'እርስዎ' },
  'Safe Zone needs background location permission': { ru:'Для безопасной зоны нужен доступ к местоположению в фоне', fr:'La zone sûre nécessite l\'autorisation de position en arrière-plan', am:'ደህና ቦታ የጀርባ ቦታ ፈቃድ ያስፈልገዋል' },
  'Tap the map to set the centre of the safe zone': { ru:'Нажмите на карту, чтобы задать центр зоны', fr:'Appuyez sur la carte pour définir le centre de la zone sûre', am:'ደህና ቦታ ማዕከል ለማዘጋጀት ካርታውን ይጫኑ' },
  'Carers are alerted when patient leaves this area': { ru:'Опекуны оповещаются при выходе пациента', fr:'Les aidants sont alertés quand le patient quitte cette zone', am:'ታካሚ ይህን ቦታ ሲለቅ ተንከባካቢዎች ይነገራሉ' },
  'Location permission is required for safe zones': { ru:'Для безопасных зон нужно разрешение геолокации', fr:'L\'autorisation de localisation est requise pour les zones sûres', am:'ለደህና ቦታዎች የቦታ ፈቃድ ያስፈልጋል' },
  'Out with someone?': { ru:'Выходите с кем-то?', fr:'Sortie avec quelqu\'un ?', am:'ከሰው ጋር ወጥተዋል?' },
  'Mute Safe Zone alerts while a trusted person is with you. Arrivals home are still logged.': { ru:'Отключите оповещения, пока вы с доверенным лицом. Прибытие домой всё равно фиксируется.', fr:'Couper les alertes de zone sûre quand une personne de confiance est avec vous. Les arrivées à domicile sont toujours enregistrées.', am:'ታማኝ ሰው ከእርስዎ ጋር ሲሆን ማንቂያዎችን ያጥፉ። ወደ ቤት መድረስ አሁንም ይመዘገባል።' },
  'Alerts muted until': { ru:'Оповещения отключены до', fr:'Alertes désactivées jusqu\'au', am:'ማንቂያዎች ጠፍተዋል እስከ' },
  'Currently muted until': { ru:'Сейчас отключено до', fr:'Actuellement désactivé jusqu\'au', am:'አሁን ጠፍቷል እስከ' },
  'Resume alerts now': { ru:'Возобновить оповещения', fr:'Reprendre les alertes', am:'ማንቂያዎችን ቀጥል' },
  'Safe Zone alerts resumed': { ru:'Оповещения возобновлены', fr:'Alertes reprises', am:'ማንቂያዎች ቀጥለዋል' },
  'Suggest zones from my activity': { ru:'Предложить зоны по моей активности', fr:'Suggérer des zones à partir de mon activité', am:'ከእንቅስቃሴዬ ቦታዎች ይጠቁሙ' },
  'Suggested zones': { ru:'Предложенные зоны', fr:'Zones suggérées', am:'የተጠቆሙ ቦታዎች' },
  'Places you\'ve spent significant time in the last week. Tap one to add as a zone.': { ru:'Места, где вы часто бывали за последнюю неделю. Нажмите, чтобы добавить как зону.', fr:'Endroits où vous avez passé du temps la semaine dernière. Appuyez pour ajouter en tant que zone.', am:'ባለፈው ሳምንት ብዙ ጊዜ ያሳለፉባቸው ቦታዎች። እንደ ቦታ ለማከል ይጫኑ።' },
  'Not enough recent activity to suggest zones yet. Keep the app running for a day or two.': { ru:'Недостаточно данных об активности. Оставьте приложение включённым на день-два.', fr:'Pas assez d\'activité récente. Gardez l\'appli active un jour ou deux.', am:'ቦታዎች ለመጠቆም በቂ ቅርብ ጊዜ እንቅስቃሴ የለም። መተግበሪያውን ለአንድ ወይም ሁለት ቀን ያንቁ።' },
  'No new dwell locations found outside your current zones.': { ru:'Новых частых мест вне ваших зон не обнаружено.', fr:'Aucun nouveau lieu fréquenté en dehors de vos zones actuelles.', am:'ከነባር ቦታዎችዎ ውጪ አዲስ ቆይታ ቦታ አልተገኘም።' },
  'Not enough recent activity': { ru:'Недостаточно данных', fr:'Activité récente insuffisante', am:'በቂ ቅርብ ጊዜ እንቅስቃሴ የለም' },
  'No new dwell locations detected': { ru:'Новых частых мест не обнаружено', fr:'Aucun nouveau lieu fréquenté détecté', am:'አዲስ ቆይታ ቦታ አልተገኘም' },
  'Looking up places…': { ru:'Поиск мест…', fr:'Recherche de lieux…', am:'ቦታዎችን በመፈለግ…' },
  'radius': { ru:'радиус', fr:'rayon', am:'ራዲየስ' },
  'Suggested zone': { ru:'Предложенная зона', fr:'Zone suggérée', am:'የተጠቆመ ቦታ' },
  'EMERGENCY INFO': { ru:'ЭКСТРЕННАЯ ИНФОРМАЦИЯ', fr:'INFO D\'URGENCE', am:'የአደጋ መረጃ' },
  'Patient': { ru:'Пациент', fr:'Patient', am:'ታካሚ' },
  'Identity': { ru:'Личные данные', fr:'Identité', am:'ማንነት' },
  'Medical': { ru:'Медицинское', fr:'Médical', am:'ህክምና' },
  'Contacts': { ru:'Контакты', fr:'Contacts', am:'ግንኙነቶች' },
  'Field name': { ru:'Название поля', fr:'Nom du champ', am:'የመስክ ስም' },
  'Value': { ru:'Значение', fr:'Valeur', am:'ዋጋ' },
  'Tap Edit to add your details.': { ru:'Нажмите «Изменить» для добавления данных.', fr:'Appuyez sur Modifier pour ajouter vos détails.', am:'ዝርዝሮችዎን ለማከል አርትዕ ይጫኑ።' },
  'Current Medications': { ru:'Текущие лекарства', fr:'Médicaments actuels', am:'የአሁን መድሃኒቶች' },
  'No medications on file.': { ru:'Нет сохранённых лекарств.', fr:'Aucun médicament enregistré.', am:'ምንም መድሃኒት አልተመዘገበም።' },
  'PRN': { ru:'По необходимости', fr:'Si besoin', am:'እንደ ፍላጎት' },
  'Active': { ru:'Действующее вещество', fr:'Principe actif', am:'ንቁ ንጥረ ነገር' },
  'Care Team': { ru:'Команда ухода', fr:'Équipe soignante', am:'የእንክብካቤ ቡድን' },
  'No carers connected': { ru:'Нет подключённых опекунов', fr:'Aucun aidant connecté', am:'የተገናኙ ተንከባካቢዎች የሉም' },
  'Patient Phone': { ru:'Телефон пациента', fr:'Téléphone du patient', am:'የታካሚ ስልክ' },
  'Add Custom Field': { ru:'Добавить поле', fr:'Ajouter un champ', am:'ብጁ መስክ ያክሉ' },
  'Show to Paramedic': { ru:'Показать парамедику', fr:'Montrer au secouriste', am:'ለአምቡላንስ ሰራተኛ ያሳዩ' },
  'Share': { ru:'Поделиться', fr:'Partager', am:'ያጋሩ' },
  'Copy': { ru:'Копировать', fr:'Copier', am:'ቅዳ' },
  'Date of Birth': { ru:'Дата рождения', fr:'Date de naissance', am:'የልደት ቀን' },
  'ID / Insurance Number': { ru:'ИД / Номер страховки', fr:'ID / Numéro d\'assurance', am:'መታወቂያ / የመድህን ቁጥር' },
  'Primary Language': { ru:'Основной язык', fr:'Langue principale', am:'ዋና ቋንቋ' },
  'Weight (kg)': { ru:'Вес (кг)', fr:'Poids (kg)', am:'ክብደት (ኪግ)' },
  'Blood Type': { ru:'Группа крови', fr:'Groupe sanguin', am:'የደም ዓይነት' },
  'Medical Conditions': { ru:'Медицинские состояния', fr:'Conditions médicales', am:'ሕክምና ሁኔታዎች' },
  'Allergies': { ru:'Аллергии', fr:'Allergies', am:'አለርጂዎች' },
  'Advance Directives': { ru:'Предварительные распоряжения', fr:'Directives anticipées', am:'ቅድመ-ትዕዛዞች' },
  'Preferred Hospital': { ru:'Предпочитаемая больница', fr:'Hôpital préféré', am:'ተመራጭ ሆስፒታል' },
  'Doctor (Name & Phone)': { ru:'Врач (имя и телефон)', fr:'Médecin (nom et téléphone)', am:'ዶክተር (ስም እና ስልክ)' },
  'Next of Kin': { ru:'Ближайший родственник', fr:'Proche parent', am:'ቅርብ ዘመድ' },
  'Connection in progress…': { ru:'Подключение…', fr:'Connexion en cours…', am:'ግንኙነት እየተደረገ ነው…' },
  'Code not found. Check and try again.': { ru:'Код не найден. Проверьте и попробуйте снова.', fr:'Code non trouvé. Vérifiez et réessayez.', am:'ኮድ አልተገኘም። ያረጋግጡ እና እንደገና ይሞክሩ።' },
  'That\'s your own code!': { ru:'Это ваш собственный код!', fr:'C\'est votre propre code !', am:'ይህ የእርስዎ ኮድ ነው!' },
  'That code belongs to a different role.': { ru:'Этот код принадлежит другой роли.', fr:'Ce code appartient à un rôle différent.', am:'ያ ኮድ ለተለየ ሚና ነው።' },
  'Could not send pair request. Check your connection.': { ru:'Не удалось отправить запрос. Проверьте соединение.', fr:'Impossible d\'envoyer la demande. Vérifiez votre connexion.', am:'ጥያቄ መላክ አልተቻለም። ግንኙነትዎን ያረጋግጡ።' },
  'Could not complete pairing': { ru:'Не удалось завершить подключение', fr:'Impossible de terminer l\'appariement', am:'ማጣመር ማጠናቀቅ አልተቻለም' },
  'Could not sign in — check your connection.': { ru:'Не удалось войти — проверьте соединение.', fr:'Impossible de se connecter — vérifiez votre connexion.', am:'መግባት አልተቻለም — ግንኙነትዎን ያረጋግጡ።' },
  'Pair request sent to': { ru:'Запрос отправлен', fr:'Demande envoyée à', am:'ጥያቄ ተልኳል ወደ' },
  'waiting for approval': { ru:'ожидание одобрения', fr:'en attente d\'approbation', am:'ፈቃድ በመጠበቅ' },
  'wants to connect as your': { ru:'хочет подключиться как ваш', fr:'souhaite se connecter en tant que votre', am:'እንደ እርስዎ ለመገናኘት ይፈልጋል' },
  'patient': { ru:'пациент', fr:'patient', am:'ታካሚ' },
  'carer': { ru:'опекун', fr:'aidant', am:'ተንከባካቢ' },
  'family member': { ru:'член семьи', fr:'membre de la famille', am:'የቤተሰብ አባል' },
  'Someone': { ru:'Кто-то', fr:'Quelqu\'un', am:'አንድ ሰው' },
  'Approve': { ru:'Одобрить', fr:'Approuver', am:'ፍቀድ' },
  'Reject': { ru:'Отклонить', fr:'Refuser', am:'ውድቅ' },
  'Paired with': { ru:'Подключён к', fr:'Apparié avec', am:'ተጣምሯል ከ' },
  'Pairing approved!': { ru:'Подключение одобрено!', fr:'Appariement approuvé !', am:'ጣመር ተፈቅዷል!' },
  'Pair request rejected': { ru:'Запрос отклонён', fr:'Demande refusée', am:'ጥያቄ ውድቅ ተደርጓል' },
  'Pair request was rejected': { ru:'Ваш запрос был отклонён', fr:'Votre demande a été refusée', am:'ጥያቄዎ ውድቅ ተደርጓል' },
  'Create your account': { ru:'Создайте аккаунт', fr:'Créez votre compte', am:'መለያዎን ይፍጠሩ' },
  'Log in to your account': { ru:'Войдите в аккаунт', fr:'Connectez-vous à votre compte', am:'ወደ መለያዎ ይግቡ' },
  'Your data is protected by email and password': { ru:'Ваши данные защищены электронной почтой и паролем', fr:'Vos données sont protégées par email et mot de passe', am:'ውሂብዎ በኢሜል እና በይለፍ ቃል ተጠብቋል' },
  'Register': { ru:'Зарегистрироваться', fr:'S\'inscrire', am:'ይመዝገቡ' },
  'Log in': { ru:'Войти', fr:'Se connecter', am:'ይግቡ' },
  'Email': { ru:'Электронная почта', fr:'E-mail', am:'ኢሜል' },
  'Password': { ru:'Пароль', fr:'Mot de passe', am:'የይለፍ ቃል' },
  'Confirm password': { ru:'Подтвердите пароль', fr:'Confirmez le mot de passe', am:'የይለፍ ቃል ያረጋግጡ' },
  'Phone number (optional)': { ru:'Телефон (необязательно)', fr:'Téléphone (facultatif)', am:'ስልክ ቁጥር (አማራጭ)' },
  'Create Account': { ru:'Создать аккаунт', fr:'Créer un compte', am:'መለያ ፍጠር' },
  'Creating account…': { ru:'Создание аккаунта…', fr:'Création du compte…', am:'መለያ በመፍጠር…' },
  'Signing in…': { ru:'Вход…', fr:'Connexion…', am:'በመግባት…' },
  'Forgot password?': { ru:'Забыли пароль?', fr:'Mot de passe oublié ?', am:'የይለፍ ቃል ረሱ?' },
  'Please enter a valid email address': { ru:'Введите действительный адрес электронной почты', fr:'Veuillez entrer une adresse e-mail valide', am:'እባክዎ ትክክለኛ ኢሜል ያስገቡ' },
  'Password must be at least 8 characters': { ru:'Пароль должен содержать не менее 8 символов', fr:'Le mot de passe doit contenir au moins 8 caractères', am:'የይለፍ ቃል ቢያንስ 8 ቁምፊ መሆን አለበት' },
  'Password must contain both letters and numbers': { ru:'Пароль должен содержать буквы и цифры', fr:'Le mot de passe doit contenir des lettres et des chiffres', am:'የይለፍ ቃል ፊደላት እና ቁጥሮች መያዝ አለበት' },
  'Passwords do not match': { ru:'Пароли не совпадают', fr:'Les mots de passe ne correspondent pas', am:'የይለፍ ቃሎች አይዛመዱም' },
  'Please accept the data consent to continue': { ru:'Примите согласие на обработку данных', fr:'Veuillez accepter le consentement aux données pour continuer', am:'ለመቀጠል የውሂብ ስምምነትን ይቀበሉ' },
  'Account created! A verification email has been sent.': { ru:'Аккаунт создан! Письмо для подтверждения отправлено.', fr:'Compte créé ! Un e-mail de vérification a été envoyé.', am:'መለያ ተፈጥሯል! የማረጋገጫ ኢሜል ተልኳል።' },
  'Password reset email sent. Check your inbox.': { ru:'Письмо для сброса пароля отправлено. Проверьте почту.', fr:'E-mail de réinitialisation envoyé. Vérifiez votre boîte de réception.', am:'የይለፍ ቃል ዳግም ማስጀመሪያ ኢሜል ተልኳል። ገቢ ሳጥንዎን ያረጋግጡ።' },
  'This email is already registered. Try logging in.': { ru:'Этот адрес уже зарегистрирован. Попробуйте войти.', fr:'Cet e-mail est déjà enregistré. Essayez de vous connecter.', am:'ይህ ኢሜል ቀድሞ ተመዝግቧል። መግባት ይሞክሩ።' },
  'No account found with this email': { ru:'Аккаунт с этим адресом не найден', fr:'Aucun compte trouvé avec cet e-mail', am:'በዚህ ኢሜል መለያ አልተገኘም' },
  'Incorrect password': { ru:'Неверный пароль', fr:'Mot de passe incorrect', am:'ትክክል ያልሆነ የይለፍ ቃል' },
  'Too many attempts. Please wait a moment and try again.': { ru:'Слишком много попыток. Подождите и попробуйте снова.', fr:'Trop de tentatives. Veuillez patienter et réessayer.', am:'በጣም ብዙ ሙከራዎች። እባክዎ ትንሽ ይጠብቁ እና እንደገና ይሞክሩ።' },
  'Network error — check your connection': { ru:'Ошибка сети — проверьте соединение', fr:'Erreur réseau — vérifiez votre connexion', am:'የአውታረ መረብ ስህተት — ግንኙነትዎን ያረጋግጡ' },
  'Something went wrong': { ru:'Что-то пошло не так', fr:'Une erreur est survenue', am:'ችግር ተፈጥሯል' },
  'Sign out? You will need your email and password to sign back in.': { ru:'Выйти? Для повторного входа потребуется электронная почта и пароль.', fr:'Se déconnecter ? Vous aurez besoin de votre e-mail et mot de passe pour vous reconnecter.', am:'ይውጡ? መልሰው ለመግባት ኢሜል እና የይለፍ ቃል ያስፈልግዎታል።' },
  'Sign Out': { ru:'Выйти', fr:'Se déconnecter', am:'ውጣ' },
  'Weak': { ru:'Слабый', fr:'Faible', am:'ደካማ' },
  'Fair': { ru:'Средний', fr:'Correct', am:'ቀርተኛ' },
  'Strong': { ru:'Надёжный', fr:'Fort', am:'ጠንካራ' },
  'Code copied': { ru:'Код скопирован', fr:'Code copié', am:'ኮድ ተቀድቷል' },
  'Enter PIN': { ru:'Введите PIN', fr:'Entrez le PIN', am:'PIN ያስገቡ' },
  'Incorrect PIN': { ru:'Неверный PIN', fr:'PIN incorrect', am:'ትክክል ያልሆነ PIN' },
  'Settings PIN Lock': { ru:'PIN-блокировка настроек', fr:'Verrouillage PIN des paramètres', am:'የቅንብሮች PIN ቁልፍ' },
  'Protect settings with a 4-digit PIN': { ru:'Защитите настройки 4-значным PIN', fr:'Protégez les paramètres avec un PIN à 4 chiffres', am:'ቅንብሮችን በ4-ቁጥር PIN ይጠብቁ' },
  'Choose a 4-digit PIN to lock Settings:': { ru:'Выберите 4-значный PIN для блокировки:', fr:'Choisissez un PIN à 4 chiffres pour verrouiller :', am:'ቅንብሮችን ለመቆለፍ 4-ቁጥር PIN ይምረጡ:' },
  'Confirm your PIN:': { ru:'Подтвердите PIN:', fr:'Confirmez votre PIN :', am:'PIN ያረጋግጡ:' },
  'PIN must be exactly 4 digits': { ru:'PIN должен содержать ровно 4 цифры', fr:'Le PIN doit contenir exactement 4 chiffres', am:'PIN ልክ 4 ቁጥሮች መሆን አለበት' },
  'PINs do not match': { ru:'PIN-коды не совпадают', fr:'Les PIN ne correspondent pas', am:'PIN ኮዶች አይዛመዱም' },
  'PIN set': { ru:'PIN установлен', fr:'PIN défini', am:'PIN ተዘጋጅቷል' },
  'Remove the PIN lock from Settings?': { ru:'Убрать PIN-блокировку из настроек?', fr:'Supprimer le verrouillage PIN des paramètres ?', am:'ከቅንብሮች PIN ቁልፍ ያስወግዱ?' },
  'PIN removed': { ru:'PIN удалён', fr:'PIN supprimé', am:'PIN ተወግዷል' },
  'Forgot PIN?': { ru:'Забыли PIN?', fr:'PIN oublié ?', am:'PIN ረሱ?' },
  'No email account linked — cannot reset PIN.': { ru:'Нет привязанной почты — невозможно сбросить PIN.', fr:'Aucun compte e-mail lié — impossible de réinitialiser le PIN.', am:'ኢሜል መለያ አልተገናኘም — PIN ዳግም ማስጀመር አይቻልም።' },
  'Enter your account password to reset PIN:': { ru:'Введите пароль аккаунта для сброса PIN:', fr:'Entrez le mot de passe de votre compte pour réinitialiser le PIN :', am:'PIN ዳግም ለማስጀመር የመለያ የይለፍ ቃልዎን ያስገቡ:' },
  'PIN cleared — you can set a new one in Settings.': { ru:'PIN сброшен — можно задать новый в настройках.', fr:'PIN effacé — vous pouvez en définir un nouveau dans les paramètres.', am:'PIN ጸድቷል — በቅንብሮች ውስጥ አዲስ ማዘጋጀት ይችላሉ።' },
  'Could not verify — check your connection.': { ru:'Не удалось проверить — проверьте соединение.', fr:'Impossible de vérifier — vérifiez votre connexion.', am:'ማረጋገጥ አልተቻለም — ግንኙነትዎን ያረጋግጡ።' },
  'Please enter your pair code': { ru:'Введите код подключения', fr:'Veuillez entrer votre code d\'appariement', am:'እባክዎ የጣመር ኮድዎን ያስገቡ' },
  'Account': { ru:'Аккаунт', fr:'Compte', am:'መለያ' },
  'Security': { ru:'Безопасность', fr:'Sécurité', am:'ደህንነት' },
  'I agree to the collection and use of my care data as described in the app. My information will only be shared with my connected carers.': { ru:'Я согласен на сбор и использование моих данных ухода, как описано в приложении. Моя информация будет доступна только подключённым опекунам.', fr:'J\'accepte la collecte et l\'utilisation de mes données de soins telles que décrites dans l\'application. Mes informations ne seront partagées qu\'avec mes aidants connectés.', am:'በመተግበሪያው ውስጥ እንደተገለጸው የእንክብካቤ ውሂቤ እንዲሰበሰብ እና ጥቅም ላይ እንዲውል እስማማለሁ። መረጃዬ ከተገናኙ ተንከባካቢዎቼ ጋር ብቻ ይጋራል።' },
  'Your pair code was refreshed:': { ru:'Ваш код обновлён:', fr:'Votre code a été actualisé :', am:'የጣመር ኮድዎ ታድሷል:' },
  'Could not connect — please try again.': { ru:'Не удалось подключиться — попробуйте снова.', fr:'Impossible de se connecter — veuillez réessayer.', am:'መገናኘት አልተቻለም — እባክዎ እንደገና ይሞክሩ።' },
  'Connected!': { ru:'Подключено!', fr:'Connecté !', am:'ተገናኝቷል!' },
  'You are now paired with': { ru:'Вы подключены к', fr:'Vous êtes maintenant apparié avec', am:'አሁን ተጣምረዋል ከ' },
  'as your': { ru:'в роли вашего', fr:'en tant que votre', am:'እንደ' },
  'Copied to clipboard': { ru:'Скопировано в буфер', fr:'Copié dans le presse-papiers', am:'ወደ ቅንጥብ ሰሌዳ ተቀድቷል' },
  'Copy failed': { ru:'Не удалось скопировать', fr:'Échec de la copie', am:'መቅዳት አልተሳካም' },
  'Shift Handoff Note': { ru:'Заметка передачи смены', fr:'Note de relève', am:'የፈረቃ ልውውጥ ማስታወሻ' },
  'Write a note for the next carer coming on duty': { ru:'Напишите заметку для следующего опекуна', fr:'Écrivez une note pour le prochain aidant de garde', am:'ለሚቀጥለው ተንከባካቢ ማስታወሻ ይፃፉ' },
  'Past 24h': { ru:'За последние 24 ч', fr:'Dernières 24 h', am:'ባለፉት 24 ሰዓታት' },
  'Quiet shift — nothing logged.': { ru:'Спокойная смена — ничего не зафиксировано.', fr:'Quart calme — rien à signaler.', am:'ጸጥ ያለ ፈረቃ — ምንም አልተመዘገበም።' },
  'call': { ru:'вызов', fr:'appel', am:'ጥሪ' },
  'calls': { ru:'вызовов', fr:'appels', am:'ጥሪዎች' },
  'falls': { ru:'падений', fr:'chutes', am:'ውድቀቶች' },
  'meds taken': { ru:'лекарств принято', fr:'médicaments pris', am:'የተወሰዱ መድሃኒቶች' },
  'missed': { ru:'пропущено', fr:'manqués', am:'የተዘለሉ' },
  'zone exits': { ru:'выходов из зоны', fr:'sorties de zone', am:'ከቦታ መውጣት' },
  'Sleep': { ru:'Сон', fr:'Sommeil', am:'እንቅልፍ' },
  'Appetite': { ru:'Аппетит', fr:'Appétit', am:'ምግብ ፍላጎት' },
  'Mobility': { ru:'Подвижность', fr:'Mobilité', am:'እንቅስቃሴ' },
  'Meds': { ru:'Лекарства', fr:'Médicaments', am:'መድሃኒቶች' },
  'Note': { ru:'Заметка', fr:'Note', am:'ማስታወሻ' },
  'e.g. Patient had a rough night, needed help 3x. Left water by bedside. Check medication at 2pm.': { ru:'напр. Тяжёлая ночь, 3 раза нужна помощь. Вода у кровати. Проверить лекарства в 14:00.', fr:'ex. Nuit difficile, a eu besoin d\'aide 3 fois. Eau laissée au chevet. Vérifier le médicament à 14h.', am:'ለምሳሌ ታካሚ ከባድ ሌሊት አሳልፏል፣ 3 ጊዜ እርዳታ ያስፈልገው ነበር። ውሃ ከአልጋ ዳር ተቀምጧል። ከሰዓት 2 ላይ መድሃኒት ያረጋግጡ።' },
  'Normal note': { ru:'Обычная заметка', fr:'Note normale', am:'መደበኛ ማስታወሻ' },
  'Important — needs attention': { ru:'Важно — требует внимания', fr:'Important — nécessite attention', am:'አስፈላጊ — ትኩረት ያስፈልጋል' },
  'Urgent — act immediately': { ru:'Срочно — действуйте немедленно', fr:'Urgent — agissez immédiatement', am:'አስቸኳይ — ወዲያው እርምጃ ይውሰዱ' },
  'Save Note': { ru:'Сохранить заметку', fr:'Enregistrer la note', am:'ማስታወሻ አስቀምጥ' },
  'Tap "Got it" to dismiss': { ru:'Нажмите «Понятно» для закрытия', fr:'Appuyez sur « Compris » pour fermer', am:'ለመዝጋት "ገባኝ" ይጫኑ' },
  'Tap to dismiss': { ru:'Нажмите для закрытия', fr:'Appuyez pour fermer', am:'ለመዝጋት ይጫኑ' },
  'Got it': { ru:'Понятно', fr:'Compris', am:'ገባኝ' },
  'Reply': { ru:'Ответить', fr:'Répondre', am:'መልስ' },
  'Acknowledged': { ru:'Подтверждено', fr:'Reçu', am:'ተረጋግጧል' },
  'Shift Note': { ru:'Заметка смены', fr:'Note de quart', am:'የፈረቃ ማስታወሻ' },
  'Read by': { ru:'Прочитано', fr:'Lu par', am:'ያነበበው' },
  'Your account is not yet secured — tap to register with email.': { ru:'Ваш аккаунт ещё не защищён — нажмите для регистрации.', fr:'Votre compte n\'est pas encore sécurisé — appuyez pour vous inscrire par e-mail.', am:'መለያዎ ገና አልተጠበቀም — በኢሜል ለመመዝገብ ይጫኑ።' },
  'Session Expired': { ru:'Сессия истекла', fr:'Session expirée', am:'ክፍለ ጊዜ አልቋል' },
  'Please sign in again to continue': { ru:'Пожалуйста, войдите снова', fr:'Veuillez vous reconnecter pour continuer', am:'ለመቀጠል እባክዎ እንደገና ይግቡ' },
  'Sign In': { ru:'Войти', fr:'Se connecter', am:'ይግቡ' },
  'Session expired — please sign in': { ru:'Сессия истекла — войдите снова', fr:'Session expirée — veuillez vous connecter', am:'ክፍለ ጊዜ አልቋል — እባክዎ ይግቡ' },
  'No carer responded': { ru:'Ни один опекун не ответил', fr:'Aucun aidant n\'a répondu', am:'ምንም ተንከባካቢ አልመለሰም' },
  'Try reaching them by phone, or call emergency services.': { ru:'Попробуйте позвонить им напрямую или вызвать скорую.', fr:'Essayez de les joindre par téléphone, ou appelez les urgences.', am:'በስልክ ለማግኘት ይሞክሩ ወይም የአደጋ ጊዜ አገልግሎቶችን ይደውሉ።' },
  'Try calling directly:': { ru:'Попробуйте позвонить напрямую:', fr:'Essayez d\'appeler directement :', am:'በቀጥታ ለመደወል ይሞክሩ:' },
  'Call Emergency': { ru:'Вызов скорой', fr:'Appeler les urgences', am:'ድንገተኛ ጥሪ' },
  'Call emergency services?': { ru:'Вызвать экстренные службы?', fr:'Appeler les services d\'urgence ?', am:'የአደጋ ጊዜ አገልግሎት ይደውሉ?' },
  'Emergency Number': { ru:'Номер экстренной помощи', fr:'Numéro d\'urgence', am:'የአደጋ ቁጥር' },
  'Emergency number:': { ru:'Номер экстренной помощи:', fr:'Numéro d\'urgence :', am:'የአደጋ ቁጥር:' },
  'Emergency number updated': { ru:'Номер экстренной помощи обновлён', fr:'Numéro d\'urgence mis à jour', am:'የአደጋ ቁጥር ተዘምኗል' },
  'Add Your Phone Number': { ru:'Добавьте номер телефона', fr:'Ajoutez votre numéro de téléphone', am:'ስልክ ቁጥርዎን ያክሉ' },
  'Your patient needs your phone number as a safety fallback.': { ru:'Вашему пациенту нужен ваш номер как резервный способ связи.', fr:'Votre patient a besoin de votre numéro comme solution de secours.', am:'ታካሚዎ ስልክ ቁጥርዎ እንደ ደህንነት ምትክ ያስፈልገዋል።' },
  'Skip for now': { ru:'Пропустить', fr:'Passer pour l\'instant', am:'ለጊዜው ዝለል' },
  'No phone — offline calls won\'t reach this carer': { ru:'Нет телефона — офлайн-вызовы не дойдут', fr:'Pas de téléphone — les appels hors ligne ne parviendront pas', am:'ስልክ የለም — ከመስመር ውጪ ጥሪዎች አይደርሱም' },
  'Some carers don\'t have phone numbers set — offline fallback may not work.': { ru:'Не у всех опекунов указан телефон — резервный способ связи может не работать.', fr:'Certains aidants n\'ont pas de numéro — le secours hors ligne peut ne pas fonctionner.', am:'አንዳንድ ተንከባካቢዎች ስልክ ቁጥር የሌላቸው — ከመስመር ውጪ ምትክ ላይሰራ ይችላል።' },
  'last seen': { ru:'последний раз онлайн', fr:'vu pour la dernière fois', am:'ለመጨረሻ ጊዜ የታየ' },
  'Dismiss': { ru:'Закрыть', fr:'Fermer', am:'ዝጋ' },
  'Patient Settings': { ru:'Настройки пациента', fr:'Paramètres du patient', am:'የታካሚ ቅንብሮች' },
  'Remote Patient Settings': { ru:'Удалённые настройки пациента', fr:'Paramètres patient à distance', am:'የርቀት ታካሚ ቅንብሮች' },
  'Location sharing': { ru:'Передача местоположения', fr:'Partage de position', am:'ቦታ ማጋራት' },
  'Safe zone monitoring': { ru:'Мониторинг безопасной зоны', fr:'Surveillance de zone sûre', am:'ደህና ቦታ ክትትል' },
  'Emergency Info': { ru:'Экстренная информация', fr:'Info d\'urgence', am:'የአደጋ መረጃ' },
  'Configure': { ru:'Настроить', fr:'Configurer', am:'ያዋቅሩ' },
  'Check-ins, alerts, location, emergency info': { ru:'Проверки, оповещения, геолокация, экстренная информация', fr:'Vérifications, alertes, position, info d\'urgence', am:'ፍተሻዎች, ማንቂያዎች, ቦታ, የአደጋ መረጃ' },
  'Changes apply immediately on the patient\'s device.': { ru:'Изменения применяются немедленно на устройстве пациента.', fr:'Les modifications s\'appliquent immédiatement sur l\'appareil du patient.', am:'ለውጦች ወዲያው በታካሚው መሳሪያ ላይ ይተገበራሉ።' },
  'Configure check-ins, inactivity alerts, location, and emergency info for your patients remotely.': { ru:'Удалённо настройте проверки, оповещения о бездействии, геолокацию и экстренную информацию.', fr:'Configurez à distance les vérifications, alertes d\'inactivité, la position et les infos d\'urgence.', am:'ለታካሚዎችዎ ፍተሻዎችን, እንቅስቃሴ-አልባ ማንቂያዎችን, ቦታ, እና የአደጋ መረጃን ከርቀት ያዋቅሩ።' },
  'Patient settings': { ru:'Настройки пациента', fr:'Paramètres patient', am:'የታካሚ ቅንብሮች' },
  'to': { ru:'до', fr:'à', am:'ወደ' },
  'Step in as Carer': { ru:'Стать опекуном', fr:'Prendre le rôle d\'aidant', am:'እንደ ተንከባካቢ ይገቡ' },
  'Back to Observer': { ru:'Вернуться к наблюдению', fr:'Retour en observateur', am:'ወደ ታዛቢ ተመለስ' },
  'You are now acting as a temporary carer': { ru:'Вы сейчас выступаете как временный опекун', fr:'Vous agissez maintenant comme aidant temporaire', am:'አሁን እንደ ጊዜያዊ ተንከባካቢ እየሰሩ ነው' },
  'Back to observer mode': { ru:'Возврат в режим наблюдения', fr:'Retour en mode observateur', am:'ወደ ታዛቢ ሁነታ ተመልሷል' },
  'You are acting as a temporary carer': { ru:'Вы — временный опекун', fr:'Vous agissez comme aidant temporaire', am:'እንደ ጊዜያዊ ተንከባካቢ እየሰሩ ነው' },
  'Temporary Carer': { ru:'Временный опекун', fr:'Aidant temporaire', am:'ጊዜያዊ ተንከባካቢ' },
  'Temporarily act as a carer to receive and respond to calls': { ru:'Временно примите роль опекуна для приёма вызовов', fr:'Agissez temporairement comme aidant pour recevoir et répondre aux appels', am:'ጥሪዎችን ለመቀበል እና ለመመለስ ጊዜያዊ ተንከባካቢ ሁን' },
  'Voice activation': { ru:'Голосовая активация', fr:'Activation vocale', am:'የድምፅ ማግበር' },
  'Voice activation ON': { ru:'Голосовая активация ВКЛ', fr:'Activation vocale ACTIVÉE', am:'የድምፅ ማግበር ነቅቷል' },
  'Already in a call': { ru:'Уже в вызове', fr:'Déjà en appel', am:'ቀድሞ ጥሪ ላይ ነዎት' },
  'Password is too weak — use at least 8 characters with letters and numbers': { ru:'Пароль слишком слабый — не менее 8 символов с буквами и цифрами', fr:'Le mot de passe est trop faible — utilisez au moins 8 caractères avec des lettres et des chiffres', am:'የይለፍ ቃል በጣም ደካማ ነው — ቢያንስ 8 ቁምፊ ከፊደላት እና ቁጥሮች ጋር ይጠቀሙ' },
  'Monitoring': { ru:'Мониторинг', fr:'Surveillance', am:'ክትትል' },
  'patients': { ru:'пациентов', fr:'patients', am:'ታካሚዎች' },
  'Dashboard': { ru:'Панель', fr:'Tableau de bord', am:'ዳሽቦርድ' },
  'Speech recognition not available': { ru:'Распознавание речи недоступно', fr:'Reconnaissance vocale indisponible', am:'የንግግር ለይቶ ማወቂያ አይገኝም' },
  'Voice recognition not available': { ru:'Голосовое распознавание недоступно', fr:'Reconnaissance vocale indisponible', am:'የድምፅ ለይቶ ማወቂያ አይገኝም' },
  'No motion data received — sensor may not be available': { ru:'Нет данных о движении — датчик может быть недоступен', fr:'Aucune donnée de mouvement — le capteur est peut-être indisponible', am:'የእንቅስቃሴ ውሂብ አልተቀበለም — ዳሳሽ ላይገኝ ይችላል' },
  'Could not access motion sensors': { ru:'Не удалось получить доступ к датчикам', fr:'Impossible d\'accéder aux capteurs de mouvement', am:'የእንቅስቃሴ ዳሳሾች ማግኘት አልተቻለም' },
  'Test notification sent. If nothing appears, check device notification settings.': { ru:'Тестовое уведомление отправлено. Если ничего не появилось, проверьте настройки уведомлений.', fr:'Notification test envoyée. Si rien n\'apparaît, vérifiez les paramètres de notification.', am:'የሙከራ ማሳወቂያ ተልኳል። ምንም ካልታየ የማሳወቂያ ቅንብሮችን ያረጋግጡ።' },
  'Notification failed': { ru:'Уведомление не удалось', fr:'Échec de la notification', am:'ማሳወቂያ አልተሳካም' },
  'Location not available on this device': { ru:'Местоположение недоступно на этом устройстве', fr:'Position indisponible sur cet appareil', am:'በዚህ መሳሪያ ላይ ቦታ አይገኝም' },
  'No active call to connect to': { ru:'Нет активного вызова', fr:'Pas d\'appel actif à rejoindre', am:'የሚገናኙበት ንቁ ጥሪ የለም' },
  'CareCall installed!': { ru:'CareCall установлен!', fr:'CareCall installé !', am:'CareCall ተጭኗል!' },
  'Add a care note for this call:': { ru:'Добавьте заметку для этого вызова:', fr:'Ajoutez une note de soins pour cet appel :', am:'ለዚህ ጥሪ የእንክብካቤ ማስታወሻ ያክሉ:' },
  'with country code': { ru:'с кодом страны', fr:'avec indicatif pays', am:'ከሀገር ኮድ ጋር' },
  'Step 1 of 4': { ru:'Шаг 1 из 4', fr:'Étape 1 sur 4', am:'ደረጃ 1 ከ 4' },
  'e.g. ABCD12': { ru:'напр. ABCD12', fr:'ex. ABCD12', am:'ለምሳሌ ABCD12' },
  '🌙 Night Mode': { ru:'🌙 Ночной режим', fr:'🌙 Mode nuit', am:'🌙 የሌሊት ሁነታ' },
  'Big clock & easy call': { ru:'Большие часы и простой вызов', fr:'Grande horloge et appel facile', am:'ትልቅ ሰዓት እና ቀላል ጥሪ' },
  '📵 No internet connection — tap for phone fallback': { ru:'📵 Нет интернета — нажмите для телефонного звонка', fr:'📵 Pas de connexion internet — appuyez pour l\'appel téléphonique', am:'📵 ኢንተርኔት ግንኙነት የለም — ለስልክ ምትክ ይጫኑ' },
  'Family Dashboard': { ru:'Семейная панель', fr:'Tableau de bord familial', am:'የቤተሰብ ዳሽቦርድ' },
  'Patient Medications': { ru:'Лекарства пациента', fr:'Médicaments du patient', am:'የታካሚ መድሃኒቶች' },
  'Please complete registration first.': { ru:'Сначала завершите регистрацию.', fr:'Veuillez d\'abord terminer l\'inscription.', am:'እባክዎ መጀመሪያ ምዝገባውን ያጠናቅቁ።' },
  'Please complete your profile': { ru:'Пожалуйста, заполните профиль', fr:'Veuillez compléter votre profil', am:'እባክዎ መገለጫዎን ያጠናቅቁ' },
  'You are offline': { ru:'Вы не в сети', fr:'Vous êtes hors ligne', am:'ከመስመር ውጪ ነዎት' },
  'No internet connection': { ru:'Нет интернет-подключения', fr:'Pas de connexion internet', am:'ኢንተርኔት ግንኙነት የለም' },
  'Reconnect wifi or mobile data for full functionality. Watch for incoming SMS — patients can still reach you.': { ru:'Подключитесь к Wi-Fi или мобильному интернету. Следите за входящими SMS — пациенты всё ещё могут с вами связаться.', fr:'Reconnectez le Wi-Fi ou les données mobiles. Surveillez les SMS entrants — les patients peuvent toujours vous joindre.', am:'ሙሉ ተግባር ለማግኘት ዋይፋይ ወይም ሞባይል ዳታ ያገናኙ። ገቢ SMS ይጠብቁ — ታካሚዎች አሁንም ሊደርሱዎት ይችላሉ።' },
  'Your call will be sent as SMS when you reconnect, or use the phone fallback below.': { ru:'Ваш вызов будет отправлен как SMS при подключении, или воспользуйтесь телефоном ниже.', fr:'Votre appel sera envoyé par SMS à la reconnexion, ou utilisez le téléphone ci-dessous.', am:'ሲገናኙ ጥሪዎ እንደ SMS ይላካል ወይም ከታች ያለውን ስልክ ምትክ ይጠቀሙ።' },
  'Enter patient\'s code': { ru:'Введите код пациента', fr:'Entrez le code du patient', am:'የታካሚ ኮድ ያስገቡ' },
  'Enter carer or family code': { ru:'Введите код опекуна или семьи', fr:'Entrez le code de l\'aidant ou de la famille', am:'የተንከባካቢ ወይም ቤተሰብ ኮድ ያስገቡ' },
  'Enter pair code': { ru:'Введите код подключения', fr:'Entrez le code d\'appariement', am:'የጣመር ኮድ ያስገቡ' },
  'Pair request was incomplete — ask them to try again.': { ru:'Запрос не завершён — попросите повторить.', fr:'La demande était incomplète — demandez-leur de réessayer.', am:'ጥያቄ አልተጠናቀቀም — እንደገና እንዲሞክሩ ይጠይቋቸው።' },
  '🌐 Language': { ru:'🌐 Язык', fr:'🌐 Langue', am:'🌐 ቋንቋ' },
  'Read medication name aloud': { ru:'Произнести название лекарства вслух', fr:'Lire le nom du médicament à voix haute', am:'የመድሃኒት ስም ጮክ ብሎ ያንብቡ' },
  '📄 Adherence report (PDF)': { ru:'📄 Отчёт о приёме (PDF)', fr:'📄 Rapport d\'observance (PDF)', am:'📄 የአዘውታሪነት ሪፖርት (PDF)' },
  'Share this with your carer or patient': { ru:'Поделитесь с вашим опекуном или пациентом', fr:'Partagez avec votre aidant ou patient', am:'ከተንከባካቢዎ ወይም ታካሚዎ ጋር ያጋሩ' },
  '🌙 Bedside Mode': { ru:'🌙 Режим «у кровати»', fr:'🌙 Mode chevet', am:'🌙 የአልጋ ዳር ሁነታ' },
  'Exit Night Mode': { ru:'Выйти из ночного режима', fr:'Quitter le mode nuit', am:'ከሌሊት ሁነታ ውጣ' },
  'temp': { ru:'врем.', fr:'temp.', am:'ጊዜያዊ' },
  'Observer': { ru:'Наблюдатель', fr:'Observateur', am:'ታዛቢ' },
  'Online': { ru:'Онлайн', fr:'En ligne', am:'መስመር ላይ' },
  'Offline': { ru:'Офлайн', fr:'Hors ligne', am:'ከመስመር ውጪ' },
  'Delete failed': { ru:'Не удалось удалить', fr:'Échec de la suppression', am:'መሰረዝ አልተሳካም' },
  '+ New Event': { ru:'+ Новое событие', fr:'+ Nouvel événement', am:'+ አዲስ ክስተት' },
  'Untitled': { ru:'Без названия', fr:'Sans titre', am:'ያልተሰየመ' },
  'BP': { ru:'АД', fr:'TA', am:'ደ.ግ' },
  'HR': { ru:'ЧСС', fr:'FC', am:'ል.ም' },
  'Sugar': { ru:'Сахар', fr:'Sucre', am:'ስኳር' },
  'Temp': { ru:'Темп.', fr:'Temp.', am:'ሙቀት' },
  'Weight': { ru:'Вес', fr:'Poids', am:'ክብደት' },
  'O2': { ru:'O₂', fr:'O₂', am:'O₂' },
  'Enter valid blood pressure values': { ru:'Введите допустимые значения давления', fr:'Entrez des valeurs de tension valides', am:'ትክክለኛ የደም ግፊት ዋጋዎች ያስገቡ' },
  'Enter a valid heart rate': { ru:'Введите допустимую частоту пульса', fr:'Entrez une fréquence cardiaque valide', am:'ትክክለኛ የልብ ምት ያስገቡ' },
  'Enter a valid blood sugar value': { ru:'Введите допустимое значение сахара', fr:'Entrez une valeur de glycémie valide', am:'ትክክለኛ የደም ስኳር ዋጋ ያስገቡ' },
  'Enter a valid temperature': { ru:'Введите допустимую температуру', fr:'Entrez une température valide', am:'ትክክለኛ ሙቀት ያስገቡ' },
  'Enter a valid weight': { ru:'Введите допустимый вес', fr:'Entrez un poids valide', am:'ትክክለኛ ክብደት ያስገቡ' },
  'Enter a valid oxygen saturation': { ru:'Введите допустимое значение кислорода', fr:'Entrez une saturation en oxygène valide', am:'ትክክለኛ የኦክሲጅን ሙላት ያስገቡ' },
  'Select a pain level': { ru:'Выберите уровень боли', fr:'Sélectionnez un niveau de douleur', am:'የህመም ደረጃ ይምረጡ' },
  'Select a mood': { ru:'Выберите настроение', fr:'Sélectionnez une humeur', am:'ስሜት ይምረጡ' },
  'Everything OK?': { ru:'Всё в порядке?', fr:'Tout va bien ?', am:'ሁሉም ነገር ደህና ነው?' },
  'You\'ve left': { ru:'Вы покинули', fr:'Vous avez quitté', am:'ለቅቀዋል' },
  'That\'s your own code': { ru:'Это ваш собственный код', fr:'C\'est votre propre code', am:'ይህ የእርስዎ ኮድ ነው' },
  // ── Navigation & Tabs ──
  'Profile': { ru:'Профиль', fr:'Profil', am:'መገለጫ' },
  'Connections': { ru:'Подключения', fr:'Connexions', am:'ግንኙነቶች' },
  'Alerts': { ru:'Оповещения', fr:'Alertes', am:'ማንቂያዎች' },
  'Safety': { ru:'Безопасность', fr:'Sécurité', am:'ደህንነት' },
  'Documents': { ru:'Документы', fr:'Documents', am:'ሰነዶች' },
  'Check-ins': { ru:'Проверки', fr:'Vérifications', am:'ፍተሻዎች' },
  'System': { ru:'Система', fr:'Système', am:'ስርዓት' },
  'About': { ru:'О приложении', fr:'À propos', am:'ስለ' },
  'Features': { ru:'Функции', fr:'Fonctionnalités', am:'ባህሪያት' },
  'Done': { ru:'Готово', fr:'Terminé', am:'ተከናውኗል' },
  'Category': { ru:'Категория', fr:'Catégorie', am:'ምድብ' },
  'Delete': { ru:'Удалить', fr:'Supprimer', am:'ሰርዝ' },
  'File': { ru:'Файл', fr:'Fichier', am:'ፋይል' },
  'Upload': { ru:'Загрузить', fr:'Téléverser', am:'ስቀል' },
  'Insurance': { ru:'Страхование', fr:'Assurance', am:'ኢንሹራንስ' },
  'Legal': { ru:'Юридические', fr:'Juridique', am:'ሕጋዊ' },
  'Prescriptions': { ru:'Рецепты', fr:'Ordonnances', am:'የመድሃኒት ማዘዣ' },
  'Carer': { ru:'Опекун', fr:'Aidant', am:'ተንከባካቢ' },
  'Avatar': { ru:'Аватар', fr:'Avatar', am:'አቫታር' },
  'Night Mode': { ru:'Ночной режим', fr:'Mode nuit', am:'የሌሊት ሁነታ' },
  'Voice Activation': { ru:'Голосовая активация', fr:'Activation vocale', am:'በድምፅ ማግበር' },
  'Profile Photo': { ru:'Фото профиля', fr:'Photo de profil', am:'የመገለጫ ፎቶ' },
  // ── Documents ──
  'Document Name': { ru:'Название документа', fr:'Nom du document', am:'የሰነድ ስም' },
  'Document deleted': { ru:'Документ удалён', fr:'Document supprimé', am:'ሰነድ ተሰርዟል' },
  'Document saved': { ru:'Документ сохранён', fr:'Document enregistré', am:'ሰነድ ተቀምጧል' },
  'No documents yet': { ru:'Документов пока нет', fr:'Aucun document pour le moment', am:'እስካሁን ሰነዶች የሉም' },
  'Add Document': { ru:'Добавить документ', fr:'Ajouter un document', am:'ሰነድ ያክሉ' },
  '+ Add Document': { ru:'+ Добавить документ', fr:'+ Ajouter un document', am:'+ ሰነድ ያክሉ' },
  'Delete this document?': { ru:'Удалить этот документ?', fr:'Supprimer ce document ?', am:'ይህን ሰነድ ይሰርዙ?' },
  'Saving document…': { ru:'Сохранение документа…', fr:'Enregistrement du document…', am:'ሰነድ በማስቀመጥ…' },
  'Upload a photo from camera or gallery': { ru:'Загрузите фото с камеры или из галереи', fr:'Téléversez une photo depuis l\'appareil photo ou la galerie', am:'ከካሜራ ወይም ከማዕከለ-ስዕላት ፎቶ ይስቀሉ' },
  'Uploaded by': { ru:'Загружено', fr:'Téléversé par', am:'የጫነው' },
  'Download PDF': { ru:'Скачать PDF', fr:'Télécharger le PDF', am:'PDF አውርድ' },
  // ── Upgrade & Premium ──
  'Upgrade': { ru:'Обновить', fr:'Mettre à niveau', am:'ያሻሽሉ' },
  'Not now': { ru:'Не сейчас', fr:'Pas maintenant', am:'አሁን አይደለም' },
  'This feature requires': { ru:'Эта функция требует', fr:'Cette fonctionnalité nécessite', am:'ይህ ባህሪ ይፈልጋል' },
  // ── Greetings ──
  'Good morning,': { ru:'Доброе утро,', fr:'Bonjour,', am:'እንደምን አደሩ,' },
  'Good afternoon,': { ru:'Добрый день,', fr:'Bon après-midi,', am:'እንደምን ዋሉ,' },
  'Good evening,': { ru:'Добрый вечер,', fr:'Bonsoir,', am:'እንደምን አመሹ,' },
  // ── Onboarding ──
  'Your Personal Code': { ru:'Ваш личный код', fr:'Votre code personnel', am:'የእርስዎ የግል ኮድ' },
  'Share your code to connect': { ru:'Поделитесь кодом для подключения', fr:'Partagez votre code pour vous connecter', am:'ለመገናኘት ኮድዎን ያጋሩ' },
  'Enter patient\'s code': { ru:'Введите код пациента', fr:'Entrez le code du patient', am:'የታካሚውን ኮድ ያስገቡ' },
  // ── Connection status ──
  'No carer connected': { ru:'Опекун не подключён', fr:'Aucun aidant connecté', am:'ተንከባካቢ አልተገናኘም' },
  'No patients connected yet': { ru:'Пациенты ещё не подключены', fr:'Aucun patient connecté pour le moment', am:'እስካሁን ታካሚዎች አልተገናኙም' },
  'Offline — will be notified': { ru:'Не в сети — будет уведомлён', fr:'Hors ligne — sera notifié', am:'ከመስመር ውጭ — ይነገራል' },
  'No room found': { ru:'Комната не найдена', fr:'Aucune salle trouvée', am:'ክፍል አልተገኘም' },
  'Called as last resort': { ru:'Позвонил как последнее средство', fr:'Appelé en dernier recours', am:'እንደ መጨረሻ አማራጭ ተደውሏል' },
  'Please choose your role': { ru:'Пожалуйста, выберите свою роль', fr:'Veuillez choisir votre rôle', am:'እባክዎ ሚናዎን ይምረጡ' },
  // ── Status messages ──
  "I'm safe ✓": { ru:'Я в безопасности ✓', fr:'Je suis en sécurité ✓', am:'ደህና ነኝ ✓' },
  // ── Photo ──
  'Take Photo': { ru:'Сделать фото', fr:'Prendre une photo', am:'ፎቶ አንሱ' },
  'Choose from Gallery': { ru:'Выбрать из галереи', fr:'Choisir dans la galerie', am:'ከማዕከለ-ስዕላት ይምረጡ' },
  'Photo updated': { ru:'Фото обновлено', fr:'Photo mise à jour', am:'ፎቶ ተዘምኗል' },
  'Photo upload failed': { ru:'Не удалось загрузить фото', fr:'Échec du téléversement de la photo', am:'ፎቶ መስቀል አልተሳካም' },
  // ── Validation & Errors ──
  'Please enter a document name': { ru:'Введите название документа', fr:'Veuillez entrer un nom de document', am:'እባክዎ የሰነድ ስም ያስገቡ' },
  'Please select a file': { ru:'Выберите файл', fr:'Veuillez sélectionner un fichier', am:'እባክዎ ፋይል ይምረጡ' },
  'File too large (max 2MB)': { ru:'Файл слишком большой (макс. 2 МБ)', fr:'Fichier trop volumineux (max 2 Mo)', am:'ፋይል በጣም ትልቅ ነው (ከፍተኛ 2 ሜባ)' },
  'Loading scanner…': { ru:'Загрузка сканера…', fr:'Chargement du scanner…', am:'ስካነር በመጫን…' },
  'Location permission required': { ru:'Требуется разрешение на местоположение', fr:'Autorisation de localisation requise', am:'የአካባቢ ፈቃድ ያስፈልጋል' },
  'Microphone access required — check app permissions': { ru:'Требуется доступ к микрофону — проверьте разрешения', fr:'Accès au microphone requis — vérifiez les autorisations', am:'የማይክሮፎን ፈቃድ ያስፈልጋል — የመተግበሪያ ፈቃዶችን ይፈትሹ' },
  'Microphone not available on this device': { ru:'Микрофон недоступен на этом устройстве', fr:'Microphone non disponible sur cet appareil', am:'በዚህ መሣሪያ ላይ ማይክሮፎን አይገኝም' },
  'Could not play voice note': { ru:'Не удалось воспроизвести голосовое сообщение', fr:'Impossible de lire la note vocale', am:'የድምፅ ማስታወሻ ማጫወት አልተቻለም' },
  'Enter your email above, then tap Forgot password': { ru:'Введите электронную почту выше, затем нажмите Забыли пароль', fr:'Entrez votre adresse e-mail ci-dessus, puis appuyez sur Mot de passe oublié', am:'ከላይ ኢሜልዎን ያስገቡ፣ ከዚያ የይለፍ ቃል ረሳሁ የሚለውን ይንኩ' },
};
// Merge extra translations into main I18N
Object.entries(I18N_EXTRA).forEach(([key, langs]) => {
  if (I18N[key]) Object.assign(I18N[key], langs);
  else I18N[key] = langs;
});

function t(key) {
  if (_currentLang === 'en') return key;
  const entry = I18N[key];
  return (entry && entry[_currentLang]) || key;
}

// ── Accessibility toggles ──
function toggleA11y(mode) {
  const key = 'carecall_a11y_' + mode;
  const isOn = document.body.classList.toggle(mode === 'largeText' ? 'a11y-large' : 'a11y-contrast');
  localStorage.setItem(key, isOn ? '1' : '');
  _refreshA11yButtons();
}
function _loadA11y() {
  if (localStorage.getItem('carecall_a11y_largeText') === '1') document.body.classList.add('a11y-large');
  if (localStorage.getItem('carecall_a11y_highContrast') === '1') document.body.classList.add('a11y-contrast');
  _refreshA11yButtons();
}
function _refreshA11yButtons() {
  const lg = document.getElementById('a11y-large-btn');
  const hc = document.getElementById('a11y-contrast-btn');
  if (lg) lg.textContent = document.body.classList.contains('a11y-large') ? 'On' : 'Off';
  if (hc) hc.textContent = document.body.classList.contains('a11y-contrast') ? 'On' : 'Off';
}

function selectLanguage(code) {
  _currentLang = code;
  localStorage.setItem('carecall_lang', _currentLang);
  document.documentElement.dir = (_currentLang === 'ar' || _currentLang === 'he') ? 'rtl' : 'ltr';
  _updateLangDisplay();
  applyTranslations();
  // Close modal
  document.querySelector('.lang-modal')?.remove();
  toast(LANG_NAMES[_currentLang]);
}

function _updateLangDisplay() {
  const el = document.getElementById('s-lang-display');
  if (el) el.textContent = LANG_NAMES[_currentLang] + ' (' + LANG_ENGLISH_NAMES[_currentLang] + ')';
}

function showLanguageModal() {
  // Remove existing modal if any
  document.querySelector('.lang-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'lang-modal show';
  let html = '<div class="lang-modal-card"><div class="lang-modal-title">🌐 ' + t('Language') + '</div>';
  LANGS.forEach(code => {
    const sel = _currentLang === code ? ' selected' : '';
    html += `<div class="lang-option${sel}" onclick="selectLanguage('${code}')">
      <div>
        <div class="lang-option-native">${LANG_NAMES[code]}</div>
        <div class="lang-option-english">${LANG_ENGLISH_NAMES[code]}</div>
      </div>
      <span class="lang-option-check">✓</span>
    </div>`;
  });
  html += '</div>';
  modal.innerHTML = html;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

function applyTranslations() {
  // Re-render all translatable elements marked with data-t attribute
  document.querySelectorAll('[data-t]').forEach(el => {
    el.textContent = t(el.dataset.t);
  });
  // Re-render dynamic UI
  if (S.role === 'patient') {
    setPatientStatus(PS.status);
    _rebuildPatientCarerList();
  } else if (S.role === 'carer') {
    setAvailability(_carerAvailability);
  }
}

// ════════════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════════════
async function boot() {
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

  // ── Initialize Android back button ──
  _initAndroidBackButton();

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
          const url = event && event.url;
          // Widget SOS tap: carecall://sos — fire call immediately.
          if (url && url.toLowerCase().startsWith('carecall://sos')) {
            _widgetSosTrigger();
            return;
          }
          const code = _parseQrPayload(url);
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
    }
  }

  // Check for saved state
  if (S.uid && await loadState()) {
    // Migrate v4 users: assign personal code if missing
    if (!S.personalCode) {
      S.personalCode = genCode();
    }
    // Use Firebase as the AUTHORITATIVE rooms list. localStorage may have
    // stale room IDs from prior sessions (e.g. if the database was cleared
    // but localStorage wasn't). Writing member entries to stale rooms would
    // create orphan rooms in the database.
    try {
      const fbRoomsSnap = await db.ref(`carecall/users/${S.uid}/rooms`).once('value');
      const fbRooms = fbRoomsSnap.val() || [];
      // Firebase is AUTHORITATIVE. If it says no rooms, clear local rooms
      // too — stale localStorage would otherwise cause joinAllRooms to
      // write presence to deleted rooms, creating orphan entries.
      S.rooms = [...new Set(fbRooms)];
      if (!S.activeRoom && S.rooms.length) S.activeRoom = S.rooms[0];
    } catch(e) {
      // Read failed (offline / auth mismatch) — keep local as fallback
    }
    // Sync profile to Firebase (ensures code index exists)
    await syncUserProfile();
    // Restore carer priority from Firebase if localStorage is empty
    if (!localStorage.getItem('carecall_carer_priority') && S.role === 'patient') {
      try {
        const cpSnap = await db.ref(`carecall/users/${S.uid}/carerPriority`).once('value');
        const cp = cpSnap.val();
        if (cp && Array.isArray(cp)) localStorage.setItem('carecall_carer_priority', JSON.stringify(cp));
      } catch(_) {}
    }
    saveState(); // persist as v5
    clearTimeout(_loadTimeout);
    loading.classList.add('gone');
    await joinAllRooms();
    // Clean up any duplicate rooms for the same pair (legacy data or past races)
    _deduplicateRoomsByPair().catch(() => {});
    launchMainScreen();
  } else {
    clearTimeout(_loadTimeout);
    loading.classList.add('gone');
    showScreen('s-welcome');
  }

  // Keep presence alive on reconnect
  db.ref('.info/connected').on('value', snap => {
    const wasOffline = !_appOnline;
    _appOnline = !!snap.val();
    _updateOfflineBanner();
    if (_appOnline && S.uid && S.rooms.length) {
      S.rooms.forEach(code => {
        const ref = db.ref(`carecall/rooms/${code}/members/${S.uid}`);
        ref.update({ online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP });
        ref.onDisconnect().update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
      });
      _medQueueFlush();
      // Came back online — refresh member lists so stale states clear
      if (wasOffline) {
        if (S.role === 'patient') _rebuildPatientCarerList();
        else if (S.role === 'carer') startCarer();
      }
    }
  });

  // Flush once at boot — covers the case where we loaded online and
  // had leftover queued entries from a prior offline session.
  _medQueueFlush();

  // ── Persistent auth listener — detect session expiry mid-use ──
  auth.onAuthStateChanged(user => {
    if (!user && S.uid) {
      // Session expired mid-use — show re-login overlay
      _showSessionExpiredOverlay();
    } else if (user && S.uid) {
      // Session restored (e.g. after re-login) — dismiss overlay if present
      const overlay = document.getElementById('session-expired-overlay');
      if (overlay) overlay.remove();
    }
  });
}

// ── Offline banner — warns carer/patient when connectivity is lost ──
function _updateOfflineBanner() {
  let banner = document.getElementById('offline-banner');
  if (_appOnline) {
    if (banner) banner.remove();
    return;
  }
  if (banner) return; // already showing
  banner = document.createElement('div');
  banner.id = 'offline-banner';
  banner.className = 'offline-banner';
  if (S.role === 'carer') {
    banner.innerHTML = `
      <div class="ob-icon">📵</div>
      <div class="ob-text">
        <strong>${t('You are offline')}</strong>
        <span>${t('Reconnect wifi or mobile data for full functionality. Watch for incoming SMS — patients can still reach you.')}</span>
      </div>
    `;
  } else {
    banner.innerHTML = `
      <div class="ob-icon">📵</div>
      <div class="ob-text">
        <strong>${t('No internet connection')}</strong>
        <span>${t('Your call will be sent as SMS when you reconnect, or use the phone fallback below.')}</span>
      </div>
    `;
  }
  document.body.appendChild(banner);
}

// ── Session-expired overlay — blocks interaction until re-login ──
function _showSessionExpiredOverlay() {
  if (document.getElementById('session-expired-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'session-expired-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px;padding:32px 24px;max-width:340px;width:100%;text-align:center">
      <div style="font-size:2.5rem;margin-bottom:12px">🔒</div>
      <div style="font-family:'Fraunces',serif;font-size:1.3rem;font-weight:700;margin-bottom:8px">${t('Session Expired')}</div>
      <div style="font-size:0.95rem;color:#666;margin-bottom:20px">${t('Please sign in again to continue')}</div>
      <button onclick="_sessionExpiredSignIn()" style="background:var(--patient-primary,#2563eb);color:#fff;border:none;border-radius:14px;padding:14px 32px;font-size:1rem;font-weight:700;font-family:'Outfit',sans-serif;cursor:pointer;width:100%">${t('Sign In')}</button>
    </div>`;
  document.body.appendChild(overlay);
}

function _sessionExpiredSignIn() {
  const overlay = document.getElementById('session-expired-overlay');
  if (overlay) overlay.remove();
  showScreen('s-auth');
  _authSwitchTab('login');
}

// Unlock audio on first user interaction anywhere (catches returning users
// who skip the welcome screen and go straight to main screen).
// Must use 'click' or 'pointerup' — 'touchstart' is NOT a valid user
// activation for AudioContext in Chrome.
function _firstInteraction() {
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


// ════════════════════════════════════════════════════════════
//  SCHEDULED CHECK-INS
// ════════════════════════════════════════════════════════════
const CHECKIN = {
  intervalMs:  0,       // 0 = disabled
  startHour:   8,       // active hours start
  endHour:     22,      // active hours end
  timeoutMs:   300000,  // 5 min response window
  _timer:      null,
  _promptTimer:null,
  _countdownTimer: null,
  _active:     false,
};

const CHECKIN_INTERVALS = [0, 3600000, 7200000, 14400000, 28800000]; // off, 1h, 2h, 4h, 8h
const CHECKIN_INTERVAL_LABELS = ['Off', '1 hour', '2 hours', '4 hours', '8 hours'];
const CHECKIN_TIMEOUT_OPTIONS = [120000, 300000, 600000]; // 2min, 5min, 10min
const CHECKIN_TIMEOUT_LABELS = ['2 min', '5 min', '10 min'];

function _loadCheckinSettings() {
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

function _saveCheckinSettings() {
  const checkinData = {
    interval:  CHECKIN.intervalMs,
    startHour: CHECKIN.startHour,
    endHour:   CHECKIN.endHour,
    timeout:   CHECKIN.timeoutMs,
  };
  localStorage.setItem('carecall_checkin', JSON.stringify(checkinData));
  // Single source of truth: rooms/{id}/patientSettings/checkin.
  if (S.rooms && S.rooms.length) {
    S.rooms.forEach(room => {
      db.ref(`carecall/rooms/${room}/patientSettings/checkin`).set(checkinData)
        .catch(e => console.warn('[_saveCheckinSettings] Firebase write failed:', e && e.message));
    });
  }
}

function startCheckinSchedule() {
  stopCheckinSchedule();
  _loadCheckinSettings();
  if (!CHECKIN.intervalMs || S.role !== 'patient') return;

  CHECKIN._active = true;
  _scheduleNextCheckin();
  console.log(`[Checkin] Started: every ${CHECKIN.intervalMs / 60000}min, ${CHECKIN.startHour}:00-${CHECKIN.endHour}:00`);
}

function stopCheckinSchedule() {
  CHECKIN._active = false;
  clearTimeout(CHECKIN._timer);
  clearTimeout(CHECKIN._promptTimer);
  _unregisterTick('checkinCountdown');
  CHECKIN._timer = null;
  CHECKIN._promptTimer = null;
}

function _scheduleNextCheckin() {
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

function _showCheckinPrompt() {
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

function respondCheckin(response) {
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

async function _sendCheckinAlert(type, message) {
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
function cycleCheckinInterval() {
  if (!_requireTier('checkins', 'plus')) return;
  const i = CHECKIN_INTERVALS.indexOf(CHECKIN.intervalMs);
  CHECKIN.intervalMs = CHECKIN_INTERVALS[(i + 1) % CHECKIN_INTERVALS.length];
  _saveCheckinSettings();
  _refreshCheckinSettingsUI();
  // Restart schedule with new interval
  if (CHECKIN.intervalMs) startCheckinSchedule(); else stopCheckinSchedule();
}

function cycleCheckinStart() {
  CHECKIN.startHour = (CHECKIN.startHour + 1) % 24;
  if (CHECKIN.startHour >= CHECKIN.endHour) CHECKIN.startHour = 0;
  _saveCheckinSettings();
  _refreshCheckinSettingsUI();
}

function cycleCheckinEnd() {
  CHECKIN.endHour = (CHECKIN.endHour + 1) % 25 || 1;
  if (CHECKIN.endHour <= CHECKIN.startHour) CHECKIN.endHour = CHECKIN.startHour + 1;
  _saveCheckinSettings();
  _refreshCheckinSettingsUI();
}

function cycleCheckinTimeout() {
  const i = CHECKIN_TIMEOUT_OPTIONS.indexOf(CHECKIN.timeoutMs);
  CHECKIN.timeoutMs = CHECKIN_TIMEOUT_OPTIONS[(i + 1) % CHECKIN_TIMEOUT_OPTIONS.length];
  _saveCheckinSettings();
  _refreshCheckinSettingsUI();
}

function _refreshCheckinSettingsUI() {
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

function _formatHour(h) {
  if (h === 0 || h === 24) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

// ════════════════════════════════════════════════════════════
//  DEAD MAN'S SWITCH (Inactivity Alert)
// ════════════════════════════════════════════════════════════
const DMS_THRESHOLDS = [0, 3600000, 7200000, 14400000, 28800000, 43200000]; // off, 1h, 2h, 4h, 8h, 12h
const DMS_LABELS = ['Off', '1 hour', '2 hours', '4 hours', '8 hours', '12 hours'];
let _dmsThreshold = 0;
let _dmsTimer = null;
let _dmsLastActivity = Date.now();

function _loadDmsSettings() {
  _dmsThreshold = parseInt(localStorage.getItem('carecall_dms') || '0');
}

function cycleDmsThreshold() {
  if (!_requireTier('inactivity', 'pro')) return;
  const i = DMS_THRESHOLDS.indexOf(_dmsThreshold);
  _dmsThreshold = DMS_THRESHOLDS[(i + 1) % DMS_THRESHOLDS.length];
  localStorage.setItem('carecall_dms', _dmsThreshold);
  document.getElementById('dms-threshold-btn').textContent = DMS_LABELS[DMS_THRESHOLDS.indexOf(_dmsThreshold)];
  _startDmsMonitor();
}

function _resetDmsActivity() {
  _dmsLastActivity = Date.now();
  if (_dmsThreshold && S.role === 'patient') _startDmsMonitor();
}

function _startDmsMonitor() {
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
const HANDOFF_STATUS_DIMENSIONS = [
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
async function _handoffSnapshot() {
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

async function showHandoffPrompt() {
  if (!_requireTier('handoff_notes', 'pro')) return;
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
function _toggleHandoffStatus(btn) {
  const dim = btn.dataset.dim;
  const row = document.querySelector('.ho-chips[data-dim="' + dim + '"]');
  if (!row) return;
  const wasSelected = btn.classList.contains('selected');
  row.querySelectorAll('.ho-chip').forEach(c => c.classList.remove('selected'));
  if (!wasSelected) btn.classList.add('selected');
}

async function _submitHandoff() {
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

async function _checkHandoffNote() {
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

function _renderHandoffBanner(handoff, room) {
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
async function _ackHandoffNote(room, historyKey) {
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
async function _replyHandoff(room, historyKey) {
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
async function _fetchHandoffNotes(roomsToQuery) {
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
//  QR CODE QUICK-CONNECT
// ════════════════════════════════════════════════════════════
function showQrCode() {
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
  overlay.id = 'qr-display-overlay';
  document.body.appendChild(overlay);
}

// Dismiss the QR display overlay (called when a pair request arrives
// or when pairing completes — the QR is no longer needed).
function _dismissQrDisplay() {
  document.getElementById('qr-display-overlay')?.remove();
  document.querySelectorAll('.qr-scanner-modal').forEach(el => el.remove());
}
//  Uses html5-qrcode (loaded from CDN). On a successful scan
//  we accept either a carecall://XXXX payload, carecall:XXXX,
//  or a bare 4-char code. Target tells us which input to fill.
// ──────────────────────────────────────────────────────────
let _qrScannerInstance = null;
let _qrTarget = null; // 'setup' | 'settings' | 'deeplink'

function _parseQrPayload(text) {
  if (!text) return null;
  const s = String(text).trim();
  const m = s.match(/^carecall:(?:\/\/)?([A-Za-z0-9]{4,8})/i);
  if (m) return m[1].toUpperCase();
  if (/^[A-Za-z0-9]{4}$/.test(s)) return s.toUpperCase();
  return null;
}

async function openQrScanner(target) {
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

async function closeQrScanner() {
  if (_qrScannerInstance) {
    try { await _qrScannerInstance.stop(); } catch(_) {}
    try { await _qrScannerInstance.clear(); } catch(_) {}
    _qrScannerInstance = null;
  }
  document.querySelector('.qr-scanner-modal')?.remove();
}

async function _onQrScanSuccess(decodedText) {
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
async function _handleDeepLinkCode(code) {
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

// ════════════════════════════════════════════════════════════
//  EMERGENCY INFO CARD (v2 — grouped layout, med auto-fill,
//  paramedic view, share/copy to clipboard)
// ════════════════════════════════════════════════════════════
function _buildEmergencyMessage() {
  const info = _getEmergencyInfo();
  const parts = ['Fall detected'];
  if (info.fields) {
    info.fields.forEach(f => {
      if (!f.value) return;
      // Skip private identifiers from alert message; paramedic view / full card still shows them.
      if (f.key === 'dob' || f.key === 'idNumber') return;
      parts.push(f.label + ': ' + f.value);
    });
  }
  return parts.join(' | ');
}

function _getEmergencyInfo() {
  return JSON.parse(localStorage.getItem('carecall_emergency_info') || '{"fields":[]}');
}

function _saveEmergencyInfo(info) {
  localStorage.setItem('carecall_emergency_info', JSON.stringify(info));
  if (S.uid) db.ref(`carecall/users/${S.uid}/emergencyInfo`).set(info);
  // Mirror to rooms so carers/family can see patient-initiated edits
  if (S.rooms && S.rooms.length) {
    for (const room of S.rooms) {
      db.ref(`carecall/rooms/${room}/patientSettings/emergencyInfo`).set(info).catch(() => {});
    }
  }
}

// Field catalogue. `group` drives the section in the view. Keeping keys stable
// (bloodType / conditions / …) means we can migrate users who already have
// the pre-v2 seed without losing their values. Weight is captured as a number
// because hospital dosing is per-kg; advanceDirectives is a short string so
// users can write "DNR on file" / "Living will with Dr X" / "None".
const EI_DEFAULT_FIELDS = [
  { key: 'dob',               label: 'Date of Birth',         group: 'identity', value: '' },
  { key: 'idNumber',          label: 'ID / Insurance Number', group: 'identity', value: '' },
  { key: 'language',          label: 'Primary Language',      group: 'identity', value: '' },
  { key: 'weightKg',          label: 'Weight (kg)',           group: 'identity', value: '' },
  { key: 'bloodType',         label: 'Blood Type',            group: 'medical',  value: '' },
  { key: 'conditions',        label: 'Medical Conditions',    group: 'medical',  value: '' },
  { key: 'allergies',         label: 'Allergies',             group: 'medical',  value: '' },
  { key: 'advanceDirectives', label: 'Advance Directives',    group: 'medical',  value: '' },
  { key: 'preferredHospital', label: 'Preferred Hospital',    group: 'medical',  value: '' },
  { key: 'doctor',            label: 'Doctor (Name & Phone)', group: 'contacts', value: '' },
  { key: 'nextOfKin',         label: 'Next of Kin',           group: 'contacts', value: '' },
];

// Suggestion chips — tapped in edit mode to append to the field without
// overwriting. English seeds only (t() translates at render time).
const EI_CHIP_SUGGESTIONS = {
  bloodType:  ['O+', 'O−', 'A+', 'A−', 'B+', 'B−', 'AB+', 'AB−', 'Unknown'],
  conditions: ['Diabetes Type 2', 'Hypertension', 'Dementia', 'Stroke history', 'Heart disease',
               'COPD', 'Parkinson\u2019s', 'Atrial fibrillation', 'Kidney disease', 'Cancer'],
  allergies:  ['Penicillin', 'Peanuts', 'Latex', 'Aspirin', 'Shellfish', 'Iodine / contrast',
               'Sulfa drugs', 'NSAIDs', 'None known'],
  advanceDirectives: ['DNR on file', 'Living will on file', 'Full resuscitation', 'None'],
};

// Migration: keep existing user values, add any missing default fields,
// and force the canonical label/group on default keys. The canonical
// label matters because the edit modal now renders it as a non-editable
// heading and feeds it through t() for translation — pre-existing
// user-edited labels wouldn't translate cleanly.
function _migrateEmergencyInfo(info) {
  const existing = Array.isArray(info.fields) ? info.fields : [];
  const byKey = {};
  existing.forEach(f => { if (f.key) byKey[f.key] = f; });
  const merged = [];
  const seen = new Set();
  EI_DEFAULT_FIELDS.forEach(def => {
    if (byKey[def.key]) {
      const f = byKey[def.key];
      // Force canonical label + group on default keys.
      f.label = def.label;
      f.group = def.group;
      merged.push(f);
    } else {
      merged.push({ ...def });
    }
    seen.add(def.key);
  });
  // Preserve any user-added custom fields that aren't in the default set.
  existing.forEach(f => {
    if (!f.key || !seen.has(f.key)) {
      f.group = f.group || 'custom';
      merged.push(f);
    }
  });
  info.fields = merged;
  return info;
}

// Pretty medication line for the card — uses the richer v2 schedule helpers
// rather than the old (m.name, m.time) shape that didn't exist anymore after
// the medication-v2 overhaul. PRN meds are flagged separately so paramedics
// know they weren't taken on a schedule.
function _emergencyMedLines() {
  let meds;
  try { meds = JSON.parse(localStorage.getItem('carecall_meds') || '[]'); }
  catch(_) { meds = []; }
  const active = meds.filter(m => m && m.enabled !== false);
  return active.map(m => {
    const label = _medDisplayLabel(m);
    const sch = m.prn ? t('As needed') : _medScheduleSummary(m);
    const ing = m.activeIngredient ? ' · ' + t('Active') + ': ' + m.activeIngredient : '';
    return { name: label, schedule: sch, prn: !!m.prn, activeIngredient: m.activeIngredient || '' };
  });
}

const EI_GROUP_META = {
  identity: { icon: '👤', title: 'Identity' },
  medical:  { icon: '🩺', title: 'Medical' },
  contacts: { icon: '📞', title: 'Contacts' },
  custom:   { icon: '✏️', title: 'Other' },
};

function _telLink(raw) {
  if (!raw) return '';
  // Grab the longest phone-number-looking run; keep leading + and digits.
  const match = String(raw).match(/\+?[0-9][0-9\s\-()]{5,}/);
  if (!match) return '';
  const cleaned = match[0].replace(/[\s()\-]/g, '');
  return cleaned;
}

// Normalise a free-form date string to YYYY-MM-DD (the format required by
// <input type="date">). Returns '' when the input is empty or unparseable
// so we can leave the native picker blank rather than show a misleading
// fallback. Accepts what Date.parse accepts: ISO, RFC 2822, and common
// locale-formatted strings like "March 12, 1945" or "1945-03-12".
function _toIsoDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  // Fast path: already YYYY-MM-DD.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY or DD.MM.YYYY — treat as day-first (common outside the US).
  const dmy = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const parsed = Date.parse(s);
  if (isNaN(parsed)) return '';
  const d = new Date(parsed);
  const yy = d.getFullYear();
  if (yy < 1900 || yy > 2100) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function showEmergencyCard(editMode) {
  const info = _migrateEmergencyInfo(_getEmergencyInfo());
  _saveEmergencyInfo(info);

  const medLines = _emergencyMedLines();
  const carers = (PS.allCarers || []);

  document.querySelector('.ei-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'ei-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:95;display:flex;align-items:center;justify-content:center;padding:12px';

  // Group fields for display. In edit mode we render them as a flat list so
  // the user can add custom fields at the bottom; in view mode we group.
  const groups = { identity: [], medical: [], contacts: [], custom: [] };
  info.fields.forEach(f => {
    const g = groups[f.group] ? f.group : 'custom';
    groups[g].push(f);
  });

  let body = '';

  if (editMode) {
    // Build a set of default-field keys so we can render their labels as
    // plain headings (not editable inputs) — those labels are canonical
    // and shouldn't be overwritten by the user. Custom fields keep the
    // editable label input + remove button.
    const defaultKeys = new Set(EI_DEFAULT_FIELDS.map(d => d.key));
    const indexByField = new Map();
    info.fields.forEach((f, i) => indexByField.set(f, i));

    const renderEditField = (f, i) => {
      const isDefault = defaultKeys.has(f.key);
      const chips = EI_CHIP_SUGGESTIONS[f.key];
      const chipHtml = chips ? `<div class="ei-chip-row">${chips.map(c =>
        `<span class="ei-chip" onclick="_appendEiValue(${i}, ${JSON.stringify(c).replace(/"/g,'&quot;')})">${escHtml(c)}</span>`
      ).join('')}</div>` : '';
      // DOB gets a native date picker. Try to normalise the stored value
      // to YYYY-MM-DD so the picker can surface it; if the existing value
      // isn't parseable we leave the picker empty — the user's raw value
      // is preserved until they interact with the picker. Max date is
      // today; min is 1900-01-01 (covers realistic patient ages).
      let inputEl;
      if (f.key === 'dob') {
        const iso = _toIsoDate(f.value);
        const today = new Date();
        const todayIso = today.toISOString().slice(0, 10);
        inputEl = `<input type="date" class="ei-value-input" id="ei-value-${i}"
          value="${escHtml(iso)}" data-idx="${i}" data-type="value"
          min="1900-01-01" max="${todayIso}">`;
      } else {
        inputEl = `<input type="text" class="ei-value-input" id="ei-value-${i}"
          value="${escHtml(f.value)}" data-idx="${i}" data-type="value"
          placeholder="${escHtml(t('Value'))}">`;
      }
      if (isDefault) {
        // Heading + value (no editable label, no remove button — the
        // migration would just re-add a removed default on next render).
        return `
          <div class="ei-field-row ei-field-row-fixed">
            <div class="ei-field-heading">${escHtml(t(f.label))}</div>
            ${inputEl}
          </div>
          ${chipHtml}`;
      }
      // Custom field: editable label + value + remove.
      return `
        <div class="ei-field-row">
          <input class="ei-label-input" value="${escHtml(f.label)}" data-idx="${i}" data-type="label" placeholder="${escHtml(t('Field name'))}">
          <button class="ei-remove-btn" onclick="_removeEiField(${i})" aria-label="${escHtml(t('Remove'))}">✕</button>
          ${inputEl}
        </div>
        ${chipHtml}`;
    };

    // Render in the same grouped order as view mode so the form matches
    // the read-only layout users will see after saving.
    const renderGroupEdit = (key) => {
      const rows = groups[key];
      if (!rows || !rows.length) return '';
      const meta = EI_GROUP_META[key] || EI_GROUP_META.custom;
      let html = `<div class="ei-group-title">${meta.icon} ${t(meta.title)}</div>`;
      rows.forEach(f => { html += renderEditField(f, indexByField.get(f)); });
      return html;
    };
    body += renderGroupEdit('identity');
    body += renderGroupEdit('medical');
    body += renderGroupEdit('contacts');
    body += renderGroupEdit('custom');
  } else {
    const renderGroup = (key) => {
      const rows = groups[key];
      if (!rows || !rows.length) return '';
      const visible = rows.filter(f => f.value);
      if (!visible.length) return '';
      const meta = EI_GROUP_META[key] || EI_GROUP_META.custom;
      let html = `<div class="ei-group-title">${meta.icon} ${t(meta.title)}</div>`;
      const defaultKeys = new Set(EI_DEFAULT_FIELDS.map(d => d.key));
      visible.forEach(f => {
        const phone = (f.key === 'doctor' || f.key === 'nextOfKin') ? _telLink(f.value) : '';
        const call = phone ? `<a class="ei-call-btn" href="tel:${escHtml(phone)}">📞 ${t('Call')}</a>` : '';
        const label = defaultKeys.has(f.key) ? t(f.label) : f.label;
        html += `<div class="ei-field"><strong>${escHtml(label)}:</strong> ${escHtml(f.value)}${call}</div>`;
      });
      return html;
    };
    body += renderGroup('identity');
    body += renderGroup('medical');
    body += renderGroup('contacts');
    body += renderGroup('custom');
    if (!body) body = `<div class="ei-field" style="opacity:0.6;text-align:center;padding:12px">${t('Tap Edit to add your details.')}</div>`;
  }

  // Auto-fill medications from the med list (always rendered — this is the
  // value-add of the card for paramedics).
  let medsHtml = '';
  if (medLines.length) {
    medsHtml = medLines.map(m => {
      const prnTag = m.prn ? `<span class="ei-med-prn">[${t('PRN')}]</span> ` : '';
      const meta = m.schedule ? ` <span class="ei-med-meta">${escHtml(m.schedule)}</span>` : '';
      const ing = m.activeIngredient ? ` <span class="ei-med-meta">(${escHtml(m.activeIngredient)})</span>` : '';
      return `<div class="ei-med-row">${prnTag}<span class="ei-med-name">${escHtml(m.name)}</span>${meta}${ing}</div>`;
    }).join('');
  } else {
    medsHtml = `<div class="ei-med-row" style="opacity:0.6">${t('No medications on file.')}</div>`;
  }

  let contactsHtml = '';
  if (carers.length) {
    contactsHtml = carers.map(c => {
      const phone = _telLink(c.phone);
      const call = phone ? `<a class="ei-call-btn" href="tel:${escHtml(phone)}">📞 ${t('Call')}</a>` : '';
      return `<div>${escHtml(c.name)}${c.phone ? ' — ' + escHtml(c.phone) : ''}${call}</div>`;
    }).join('');
  } else {
    contactsHtml = `<div style="opacity:0.6">${t('No carers connected')}</div>`;
  }

  const patientPhone = _telLink(S.phone);
  const autoSection = editMode ? '' : `
    <div class="ei-auto-section">
      <div class="ei-group-title">💊 ${t('Current Medications')}</div>
      ${medsHtml}
      <div class="ei-group-title">👥 ${t('Care Team')}</div>
      ${contactsHtml}
      ${S.phone ? `<div class="ei-field" style="margin-top:6px"><strong>${t('Patient Phone')}:</strong> ${escHtml(S.phone)}${patientPhone ? ` <a class="ei-call-btn" href="tel:${escHtml(patientPhone)}">📞 ${t('Call')}</a>` : ''}</div>` : ''}
    </div>`;

  overlay.innerHTML = `
    <div class="ei-card">
      <div class="ei-header">
        <div style="font-size:2rem">🏥</div>
        <div class="ei-title">${t('EMERGENCY INFO')}</div>
        <div class="ei-name">${escHtml(S.name || t('Patient'))}</div>
      </div>
      <div class="ei-fields" id="ei-fields">${body}</div>
      ${editMode ? `<button class="ei-add-field-btn" onclick="_addEiField()">+ ${t('Add Custom Field')}</button>` : ''}
      ${autoSection}
      <div class="ei-buttons">
        ${editMode
          ? `<div class="ei-buttons-row">
               <button class="ei-btn-primary" onclick="_saveEiFromModal()">${t('Save')}</button>
               <button class="ei-btn-secondary" onclick="showEmergencyCard(false)">${t('Cancel')}</button>
             </div>`
          : `<button class="ei-btn-danger" onclick="showParamedicView()">🚑 ${t('Show to Paramedic')}</button>
             <div class="ei-buttons-row">
               <button class="ei-btn-ghost" onclick="_shareEmergencyCard()">📤 ${t('Share')}</button>
               <button class="ei-btn-ghost" onclick="_copyEmergencyCard()">📋 ${t('Copy')}</button>
             </div>
             <div class="ei-buttons-row">
               <button class="ei-btn-primary" onclick="showEmergencyCard(true)">${t('Edit')}</button>
               <button class="ei-btn-secondary" onclick="document.querySelector('.ei-overlay').remove()">${t('Close')}</button>
             </div>`
        }
      </div>
    </div>`;
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

function _appendEiValue(idx, chipText) {
  const el = document.getElementById('ei-value-' + idx);
  if (!el) return;
  const cur = (el.value || '').trim();
  // Don't duplicate — skip if already present.
  const parts = cur ? cur.split(/\s*,\s*/) : [];
  if (parts.includes(chipText)) return;
  parts.push(chipText);
  el.value = parts.join(', ');
  el.focus();
}

function _saveEiFromModal() {
  const info = _getEmergencyInfo();
  document.querySelectorAll('.ei-label-input').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    if (info.fields[idx]) info.fields[idx].label = el.value.trim();
  });
  document.querySelectorAll('.ei-value-input').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    if (info.fields[idx]) info.fields[idx].value = el.value.trim();
  });
  _saveEmergencyInfo(info);
  toast(t('Emergency info saved'));
  showEmergencyCard(false);
}

function _addEiField() {
  const info = _getEmergencyInfo();
  info.fields.push({ key: 'custom_' + Date.now(), label: '', value: '', group: 'custom' });
  _saveEmergencyInfo(info);
  showEmergencyCard(true);
}

function _removeEiField(idx) {
  const info = _getEmergencyInfo();
  info.fields.splice(idx, 1);
  _saveEmergencyInfo(info);
  showEmergencyCard(true);
}

// Produce a human-readable plain-text summary of the whole card for copy /
// share. Ordered like the on-screen layout.
function _emergencyCardText() {
  const info = _migrateEmergencyInfo(_getEmergencyInfo());
  const lines = [];
  lines.push('=== EMERGENCY INFO ===');
  lines.push(S.name || 'Patient');
  lines.push('');
  const groupOrder = ['identity', 'medical', 'contacts', 'custom'];
  groupOrder.forEach(key => {
    const rows = info.fields.filter(f => (f.group || 'custom') === key && f.value);
    if (!rows.length) return;
    const meta = EI_GROUP_META[key] || EI_GROUP_META.custom;
    lines.push('-- ' + meta.title.toUpperCase() + ' --');
    rows.forEach(f => lines.push(f.label + ': ' + f.value));
    lines.push('');
  });
  const medLines = _emergencyMedLines();
  if (medLines.length) {
    lines.push('-- CURRENT MEDICATIONS --');
    medLines.forEach(m => {
      const tag = m.prn ? '[PRN] ' : '';
      const ing = m.activeIngredient ? ' (' + m.activeIngredient + ')' : '';
      lines.push('• ' + tag + m.name + ' — ' + (m.schedule || '') + ing);
    });
    lines.push('');
  }
  const carers = PS.allCarers || [];
  if (carers.length) {
    lines.push('-- CARE TEAM --');
    carers.forEach(c => lines.push((c.name || '') + (c.phone ? ' — ' + c.phone : '')));
    lines.push('');
  }
  if (S.phone) lines.push('Patient Phone: ' + S.phone);
  return lines.join('\n');
}

async function _copyEmergencyCard() {
  const text = _emergencyCardText();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback for older webviews
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    toast(t('Copied to clipboard'));
  } catch(e) {
    toast(t('Copy failed'));
  }
}

async function _shareEmergencyCard() {
  const text = _emergencyCardText();
  const title = 'CareCall — ' + (S.name || 'Emergency Info');
  try {
    if (navigator.share) {
      await navigator.share({ title, text });
      return;
    }
  } catch(e) { /* user cancelled share sheet — silent */ }
  // No Web Share → fall back to copy
  _copyEmergencyCard();
}

function showParamedicView() {
  const info = _migrateEmergencyInfo(_getEmergencyInfo());
  const medLines = _emergencyMedLines();
  const carers = PS.allCarers || [];

  const byKey = {};
  info.fields.forEach(f => { if (f.key) byKey[f.key] = f; });
  const pick = key => (byKey[key] && byKey[key].value) || '';

  const row = (label, value, phone) => {
    if (!value) return '';
    const call = phone ? ` <a class="ei-call-btn" href="tel:${escHtml(phone)}">📞 Call</a>` : '';
    return `<div class="pm-row"><strong>${escHtml(label)}:</strong> ${escHtml(value)}${call}</div>`;
  };

  const medsHtml = medLines.length
    ? medLines.map(m => {
        const prn = m.prn ? '[PRN] ' : '';
        const ing = m.activeIngredient ? ' — ' + escHtml(m.activeIngredient) : '';
        return `<div class="pm-med"><strong>${prn}${escHtml(m.name)}</strong><br>${escHtml(m.schedule || '')}${ing}</div>`;
      }).join('')
    : `<div class="pm-med">${t('No medications on file.')}</div>`;

  const carerRows = carers.map(c => {
    const phone = _telLink(c.phone);
    return row(c.name || '', c.phone || '', phone);
  }).join('');

  const doctorPhone = _telLink(pick('doctor'));
  const kinPhone = _telLink(pick('nextOfKin'));
  const patientPhone = _telLink(S.phone);

  // Request screen-wake while card is showing so it stays readable in a
  // crisis. Silent-fail on browsers without WakeLock.
  let wakeLock = null;
  if ('wakeLock' in navigator) {
    try { navigator.wakeLock.request('screen').then(l => { wakeLock = l; }).catch(() => {}); }
    catch(_) {}
  }

  document.querySelector('.paramedic-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'paramedic-overlay';
  overlay.innerHTML = `
    <div class="pm-banner">EMERGENCY INFO</div>
    <h2>${escHtml(S.name || 'Patient')}</h2>
    <div class="pm-sub">
      ${pick('dob') ? 'DOB ' + escHtml(pick('dob')) : ''}
      ${pick('weightKg') ? ' · ' + escHtml(pick('weightKg')) + ' kg' : ''}
      ${pick('language') ? ' · ' + escHtml(pick('language')) : ''}
    </div>

    <div class="pm-section-title">Medical</div>
    ${row('Blood Type', pick('bloodType'))}
    ${row('Conditions', pick('conditions'))}
    ${row('Allergies', pick('allergies'))}
    ${row('Advance Directives', pick('advanceDirectives'))}
    ${row('Preferred Hospital', pick('preferredHospital'))}

    <div class="pm-section-title">Current Medications</div>
    ${medsHtml}

    <div class="pm-section-title">Contacts</div>
    ${row('Doctor', pick('doctor'), doctorPhone)}
    ${row('Next of Kin', pick('nextOfKin'), kinPhone)}
    ${S.phone ? row('Patient Phone', S.phone, patientPhone) : ''}
    ${carerRows ? '<div class="pm-section-title">Care Team</div>' + carerRows : ''}
    ${pick('idNumber') ? `<div class="pm-section-title">Identifiers</div>${row('ID / Insurance', pick('idNumber'))}` : ''}

    <button class="pm-close" onclick="this.closest('.paramedic-overlay')._dismiss()">${t('Close')}</button>`;
  overlay._dismiss = () => {
    if (wakeLock && wakeLock.release) { try { wakeLock.release(); } catch(_) {} }
    overlay.remove();
  };
  document.body.appendChild(overlay);
}

// Alias for backward compat (settings button calls this)
function editEmergencyInfo() { showEmergencyCard(true); }

// ════════════════════════════════════════════════════════════
//  SAFE ZONES (Geo-Fencing)
// ════════════════════════════════════════════════════════════
// _safeZones: array of zone records (migrated from legacy _geoFence).
//   { id, label, lat, lng, radiusM, dwellSec, enabled, isHome, setAt, createdBy }
// _geoFence: kept as a live pointer to the "home" zone for the
//   patient screen's quiet-confidence pill and legacy callers.
// localStorage: 'carecall_safezones' (plus legacy 'carecall_geofence')
// Firebase:     carecall/rooms/{id}/patientSettings/safeZones
let _safeZones = [];
let _geoFence = null;          // convenience alias for the home zone
let _geoWatchId = null;        // monitoring watch
let _sazLiveWatchId = null;    // editor-open live-distance watch
let _sazLastPos = null;
let _sazDraft = null;          // working copy in editor
let _zoneRuntime = {};         // zoneId -> { outsideSince, insideSince, lastAlertAt, ackPending, armTimer }
let _zoneEvents = [];          // local history of exit/arrival/ack events (last 50)

const SAZ_MIN_RADIUS = 25;
const SAZ_MAX_RADIUS = 5000;
const SAZ_DEFAULT_RADIUS = 200;
const SAZ_DEFAULT_DWELL_SEC = 90;      // "exit dwell-time" — kills GPS-drift FPs
const SAZ_ACK_WINDOW_MS = 120 * 1000;  // "I'm safe" prompt stays up this long
const SAZ_ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const SAZ_WATCH_OPTS = { enableHighAccuracy: true, maximumAge: 20000, timeout: 30000 };
const SAZ_MAX_EVENTS = 50;
const SAZ_MAX_ZONES = 6;

// ── Dwell log for learned-zone suggestions ──────────────────
// Every DWELL_SAMPLE_MS while the Safe Zone tick runs we record
// the patient's position. After a week there are ≈2 000 samples
// and a simple single-link clustering pass surfaces where the
// patient habitually dwells, so we can offer "Add this as a
// zone?" suggestions in the zones-list modal. Client-side only —
// positions never leave the device.
const DWELL_SAMPLE_MS = 5 * 60 * 1000;        // 5 min
const DWELL_MAX_ENTRIES = 2016;               // ≈ 7 days
const DWELL_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const LEARN_CLUSTER_EPS_M = 80;               // points within 80 m cluster together
const LEARN_CLUSTER_MIN_DWELL_MIN = 60;       // ≥ 1 h dwell before we suggest
let _dwellLog = [];
let _lastDwellSampleAt = 0;
let _dwellDirty = false;
const DWELL_FLUSH_MS = 15 * 60 * 1000; // flush to localStorage every 15 min
let _dwellFlushTimer = null;
function _loadDwellLog() {
  try { _dwellLog = JSON.parse(localStorage.getItem('carecall_dwell_log') || '[]'); }
  catch(e) { _dwellLog = []; }
}
function _saveDwellLog() {
  const cutoff = Date.now() - DWELL_RETAIN_MS;
  _dwellLog = _dwellLog.filter(p => p && p.ts >= cutoff);
  if (_dwellLog.length > DWELL_MAX_ENTRIES) _dwellLog = _dwellLog.slice(-DWELL_MAX_ENTRIES);
  try { localStorage.setItem('carecall_dwell_log', JSON.stringify(_dwellLog)); } catch(e) {}
  _dwellDirty = false;
}
function _flushDwellIfDirty() {
  if (_dwellDirty) _saveDwellLog();
}
function _recordDwellSample(lat, lng) {
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
function _clusterDwellPoints(points, epsM, minDwellMin) {
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
async function _reverseGeocode(lat, lng) {
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

async function suggestZonesFromActivity() {
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

function _renderSuggestedZonesList(clusters) {
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
let _zoneSnoozeUntil = 0;
function _zoneSnoozeActive() { return _zoneSnoozeUntil > Date.now(); }
function _loadZoneSnooze() {
  try { _zoneSnoozeUntil = parseInt(localStorage.getItem('carecall_zone_snooze') || '0', 10) || 0; }
  catch(e) { _zoneSnoozeUntil = 0; }
}
function _saveZoneSnooze() {
  if (_zoneSnoozeUntil > Date.now()) localStorage.setItem('carecall_zone_snooze', String(_zoneSnoozeUntil));
  else localStorage.removeItem('carecall_zone_snooze');
}
function snoozeZoneAlerts(minutes) {
  if (!minutes || minutes <= 0) { _zoneSnoozeUntil = 0; _saveZoneSnooze(); _refreshPatientZonePill(); toast(t('Safe Zone alerts resumed')); return; }
  _zoneSnoozeUntil = Date.now() + minutes * 60 * 1000;
  _saveZoneSnooze();
  _logZoneEvent({ event: 'snooze_start', minutes, ts: Date.now() });
  _refreshPatientZonePill();
  const until = new Date(_zoneSnoozeUntil);
  toast(t('Alerts muted until') + ' ' + until.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
}

function openZoneSnoozeSheet() {
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
function _closeZoneSnoozeSheet() { document.querySelector('.zone-snooze-sheet')?.remove(); }

function _zoneId() { return 'sz_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }

function _migrateZone(z) {
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

function _loadSafeZones() {
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

function _saveSafeZones() {
  localStorage.setItem('carecall_safezones', JSON.stringify(_safeZones));
  // Single source of truth: rooms/{id}/patientSettings/safeZones.
  // Mirror to all rooms so carers can see safe zone config.
  if (S.rooms && S.rooms.length) {
    S.rooms.forEach(room => {
      db.ref(`carecall/rooms/${room}/patientSettings/safeZones`).set(_safeZones)
        .catch(e => console.warn('[_saveSafeZones] room write failed:', e && e.message));
    });
  }
  // Also write legacy key for older clients / easier rollback
  _geoFence = _safeZones.find(z => z.isHome) || null;
  if (_geoFence) localStorage.setItem('carecall_geofence', JSON.stringify(_geoFence));
  else localStorage.removeItem('carecall_geofence');
}

// Legacy aliases — other parts of the app still call _loadGeoFence
function _loadGeoFence() { _loadSafeZones(); }
function _saveGeoFence() { _saveSafeZones(); }

function _haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Settings summary / button state ─────────────────────────
function _refreshSafeZoneButton() {
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
function openSafeZoneEditor() {
  if (!_requireTier('safe_zones', 'pro')) return;
  // First click from Settings lands here. Shows the zones list if
  // any exist, otherwise jumps straight into the editor for a new
  // home zone (minimises friction for first-time setup).
  if (_safeZones.length === 0) {
    openSafeZoneDetailEditor(null, { asHome: true });
  } else {
    _renderZonesList();
  }
}

function _renderZonesList() {
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
function openSafeZoneDetailEditor(zoneId, opts) {
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

function _sazRenderEditor() {
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
let _sazMap = null, _sazMarker = null, _sazCircle = null, _sazLiveMarker = null;
async function _sazInitMap() {
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

function _sazUpdateMapRadius(radiusM) {
  if (_sazCircle) { try { _sazCircle.setRadius(radiusM); } catch(_) {} }
}

function _sazUpdateLiveMarker(lat, lng) {
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

function _sazUpdateCenterText() {
  const box = document.getElementById('saz-center-box');
  if (!box || !_sazDraft) return;
  const hasCenter = typeof _sazDraft.lat === 'number' && typeof _sazDraft.lng === 'number';
  box.innerHTML = hasCenter
    ? `<div><strong>${_sazDraft.lat.toFixed(5)}, ${_sazDraft.lng.toFixed(5)}</strong></div>
       <div style="font-size:0.72rem;color:#6889A5;margin-top:2px">${t('Coordinates captured')}</div>`
    : `<div style="color:#6889A5">${t('Not set yet')}</div>`;
  _sazUpdateLiveDistanceText();
}

function _sazStartLiveDistance() {
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
function _sazStopLiveDistance() {
  if (_sazLiveWatchId && navigator.geolocation) {
    try { navigator.geolocation.clearWatch(_sazLiveWatchId); } catch(_) {}
  }
  _sazLiveWatchId = null;
}
function _sazUpdateLiveDistanceText() {
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

async function _sazUseCurrentLocation() {
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

function _sazOpenInMaps() {
  if (!_sazDraft || typeof _sazDraft.lat !== 'number') return;
  const url = `https://www.google.com/maps?q=${_sazDraft.lat},${_sazDraft.lng}`;
  window.open(url, '_blank');
}

function _sazCloseEditor() {
  _sazStopLiveDistance();
  try { if (_sazMap) { _sazMap.remove(); } } catch(_) {}
  _sazMap = null; _sazMarker = null; _sazCircle = null; _sazLiveMarker = null;
  document.querySelector('.saz-editor-modal')?.remove();
  _sazDraft = null;
}

function _sazSave() {
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

function _sazRemove() {
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
function setHomeLocation() { openSafeZoneEditor(); }
function clearGeoFence() { /* retained for any external caller; no-op */ }

// ── Monitoring ──────────────────────────────────────────────
// Now routed through Native.startBackgroundLocationWatch so that on
// native Android a foreground-service watcher keeps running when the
// screen locks / app backgrounds — previously the web watchPosition
// paused the moment the app lost focus, which made the feature
// close-to-useless for its main clinical purpose.
let _geoWatchActive = false;

async function _stopGeoFenceWatch() {
  await Native.stopBackgroundLocationWatch();
  _geoWatchActive = false;
  _geoWatchId = null; // legacy field, kept for any external readers
}

async function _startGeoFenceWatch() {
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
function _zoneTick(lat, lng, accuracyM) {
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
function _refreshPatientZonePill(exitZone, distM) {
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
let _zoneAckTimer = null;
function _showZoneAckPrompt(zone, distM) {
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

async function _respondZoneAck(response, zoneArg, distArg) {
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

async function _fireZoneExitCall(zone, distM) {
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

async function _onZoneArrival(zone) {
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

function _logZoneEvent(ev) {
  _zoneEvents.push(ev);
  if (_zoneEvents.length > SAZ_MAX_EVENTS) _zoneEvents.splice(0, _zoneEvents.length - SAZ_MAX_EVENTS);
  try { localStorage.setItem('carecall_zone_events', JSON.stringify(_zoneEvents)); } catch(_) {}
}
function _loadZoneEvents() {
  try { _zoneEvents = JSON.parse(localStorage.getItem('carecall_zone_events') || '[]'); }
  catch(e) { _zoneEvents = []; }
}

// ════════════════════════════════════════════════════════════
//  ROUTINE LEARNING (Pattern Detection)
// ════════════════════════════════════════════════════════════
function _generateRoutineInsights(calls) {
  // Needs 2+ weeks of data to detect patterns
  const insights = [];
  if (calls.length < 14) return insights;

  const now = Date.now();
  const WEEK = 7 * 86400000;
  const thisWeek = calls.filter(c => c.timestamp >= now - WEEK);
  const prevWeeks = calls.filter(c => c.timestamp < now - WEEK);
  if (prevWeeks.length < 7) return insights;

  // Build historical "usual" patterns
  const prevDailyAvg = prevWeeks.length / Math.max(1, Math.ceil((now - WEEK - Math.min(...prevWeeks.map(c=>c.timestamp))) / 86400000));
  const thisDailyAvg = thisWeek.length / 7;

  // 1. Daily call count deviation
  const today = calls.filter(c => c.timestamp >= now - 86400000);
  if (today.length > prevDailyAvg * 2.5 && today.length >= 4) {
    insights.push({ icon: '🔍', level: 'warn', text: `<strong>Unusual activity:</strong> ${today.length} calls today vs average ${prevDailyAvg.toFixed(1)}/day. Pattern deviation detected.` });
  }

  // 2. Missing routine calls
  const prevTypes = {};
  prevWeeks.forEach(c => { const t = c.type || 'help'; prevTypes[t] = (prevTypes[t] || 0) + 1; });
  const thisTypes = {};
  thisWeek.forEach(c => { const t = c.type || 'help'; thisTypes[t] = (thisTypes[t] || 0) + 1; });
  Object.entries(prevTypes).forEach(([type, count]) => {
    const weeklyRate = count / Math.max(1, Math.ceil(prevWeeks.length / 7));
    if (weeklyRate >= 3 && (!thisTypes[type] || thisTypes[type] < weeklyRate * 0.3)) {
      insights.push({ icon: '🔍', level: 'warn', text: `<strong>${needLabel(type)}</strong> calls dropped significantly — usually ${weeklyRate.toFixed(0)}/week, only ${thisTypes[type] || 0} this week.` });
    }
  });

  // 3. Response time getting consistently slower
  const getAvgResp = (list) => {
    const times = list.filter(c => c.ackAt && c.timestamp).map(c => c.ackAt - c.timestamp).filter(t => t > 0);
    return times.length >= 3 ? times.reduce((a,b) => a+b, 0) / times.length : null;
  };
  const prevResp = getAvgResp(prevWeeks);
  const thisResp = getAvgResp(thisWeek);
  if (prevResp && thisResp && thisResp > prevResp * 1.8) {
    insights.push({ icon: '🔍', level: 'warn', text: `<strong>Response pattern change:</strong> carers taking ${formatDuration(thisResp)} avg vs historical ${formatDuration(prevResp)}. Consistent slowdown detected.` });
  }

  return insights;
}

// ════════════════════════════════════════════════════════════
//  AMBIENT SOUND MONITOR (One-way Listen)
// ════════════════════════════════════════════════════════════
let _ambientStream = null;
let _ambientTimeout = null;
let _ambientListenerRefs = [];

async function startAmbientListen() {
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

function _listenForAmbientRequests() {
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
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
        _ambientStream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(e => {
          console.warn('[Ambient] Mic access failed:', e && e.message);
          return null;
        });
        if (!_ambientStream) return;
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

function stopAmbientListen(roomId) {
  clearTimeout(_ambientTimeout);
  if (_ambientStream) { _ambientStream.getTracks().forEach(t => t.stop()); _ambientStream = null; }
  if (roomId) db.ref(`carecall/rooms/${roomId}/ambientListen`).remove();
  if (VC.pc) { VC.pc.close(); VC.pc = null; }
  VC.sigRef = null;
}

// ════════════════════════════════════════════════════════════
//  CARER WELLBEING CHECK
// ════════════════════════════════════════════════════════════
function _generateCarerWellbeingInsights(calls) {
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
function _trackAvailHours() {
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

// ════════════════════════════════════════════════════════════
//  VOICE-ACTIVATED CALLING
// ════════════════════════════════════════════════════════════
let _voiceListening = false;
let _speechRecognition = null;
let _voiceSessionTimer = null;
let _voiceDurationSec = 20; // default 20 seconds
const VOICE_DURATIONS = [10, 20, 30, 60];

function startVoiceListener() {
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

let _voiceRestartCount = 0;
const MAX_VOICE_RESTARTS = 500; // high limit — native restarts are silent

// ── Native speech recognition (Capacitor plugin) ──
// Android's SpeechRecognizer stops after ~5s of silence. We restart
// silently by removing old listeners before each restart to prevent
// stacking, and muting/unmuting to suppress the system beep.
async function _startNativeSpeech() {
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
function _startWebSpeech() {
  if (!_voiceListening) return;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { toast(t('Voice recognition not available')); stopVoiceListener(); return; }

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

function stopVoiceListener() {
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

function cycleVoiceDuration() {
  const i = VOICE_DURATIONS.indexOf(_voiceDurationSec);
  _voiceDurationSec = VOICE_DURATIONS[(i + 1) % VOICE_DURATIONS.length];
  const el = document.getElementById('voice-dur-label');
  if (el) el.textContent = _voiceDurationSec + 's';
  toast(t('Voice activation') + ': ' + _voiceDurationSec + 's');
}

function toggleVoiceActivation() {
  if (!_voiceListening && !_requireTier('voice_activation', 'plus')) return;
  if (_voiceListening) {
    stopVoiceListener();
    toast(t('Voice activation OFF'));
  } else {
    startVoiceListener();
  }
}

// ── Voice command parser — multi-language need recognition ──
const VOICE_COMMANDS = {
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

function _parseVoiceCommand(transcript) {
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

async function _voiceCallCarer(needType) {
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
      // Normal voice call: broadcast to ALL available carers simultaneously
      const sortedCarers = _getCarersByPriority();
      if (!sortedCarers.length) { toast(t('No available carers')); setPatientStatus('ready'); return; }
      const roomsToCall = [...new Set(sortedCarers.map(c => c.room).filter(Boolean))];
      let firstCallId = null, firstCallRoom = null;
      for (const room of roomsToCall) {
        const callRef = db.ref(`carecall/rooms/${room}/calls`).push();
        await callRef.set({ ...callData, id: callRef.key });
        if (!firstCallId) { firstCallId = callRef.key; firstCallRoom = room; }
      }
      PS.activeCallId = firstCallId;
      PS._activeCallRoom = firstCallRoom;
      watchForAck();
      _setCallFinalTimeout();
    }
  } catch(e) {
    console.error('[Call] Failed:', e);
    _showOfflineCallWarning();
    setPatientStatus('ready');
  }
}

// ════════════════════════════════════════════════════════════
//  LOCATION SHARING
// ════════════════════════════════════════════════════════════
let _locationSharing = localStorage.getItem('carecall_location') === '1';

function toggleLocationSharing() {
  if (!_requireTier('location_sharing', 'pro')) return;
  _locationSharing = !_locationSharing;
  localStorage.setItem('carecall_location', _locationSharing ? '1' : '');
  document.getElementById('s-location-btn').textContent = _locationSharing ? 'On' : 'Off';
  if (_locationSharing) {
    if (!navigator.geolocation) { toast(t('Location not available on this device')); _locationSharing = false; localStorage.setItem('carecall_location', ''); document.getElementById('s-location-btn').textContent = 'Off'; return; }
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

async function _attachLocation(callData) {
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
function showCareNotePrompt(callId) {
  const note = prompt(t('Add a care note for this call:'));
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
let _medications = [];
let _medTimers = [];
let _scheduledMedNotifIds = [];          // native notif IDs we scheduled
let _recentMedEvents = {};               // medId -> ms timestamp of last 'taken'
let _medSnoozeCount = {};                // medId -> current snooze count for in-flight reminder
// Per-med response window now drives the auto-missed timeout
// (med.schedule.window_minutes; default 60 min via _migrateMedSchema).
const MED_SNOOZE_MS = 15 * 60 * 1000;    // snooze duration

// Map UI language code to a BCP-47 tag for TTS engines.
const TTS_LANG_MAP = {
  en: 'en-US', es: 'es-ES', zh: 'zh-CN', hi: 'hi-IN', ar: 'ar-SA',
  he: 'he-IL', ru: 'ru-RU', fr: 'fr-FR', am: 'am-ET',
};
function _ttsEnabled() { return localStorage.getItem('carecall_tts') !== '0'; }
function toggleTts() {
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
function _refreshTtsButton() {
  const btn = document.getElementById('tts-toggle-btn');
  if (btn) btn.textContent = _ttsEnabled() ? t('On') : t('Off');
}
const MED_MAX_SNOOZES = 2;               // after this many snoozes, auto-missed on next fire
const MED_DOUBLE_DOSE_GUARD_MS = 10 * 60 * 1000; // warn if same med 'taken' again within this window
let _medPromptTimer = null;
let _medCountdownTimer = null;
let _currentMedId = null;

function _migrateMedSchema(med) {
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

function _normalizeMeds(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(_migrateMedSchema).filter(m => m && m.name);
}

function _loadMedications() {
  try {
    _medications = _normalizeMeds(JSON.parse(localStorage.getItem('carecall_meds') || '[]'));
  } catch(e) { _medications = []; }
}

function _saveMedications() {
  localStorage.setItem('carecall_meds', JSON.stringify(_medications));
  // Single source of truth: rooms/{id}/medConfig.
  // If not yet paired, localStorage acts as a buffer until rooms are available.
  if (S.rooms && S.rooms.length) {
    S.rooms.forEach(room => {
      db.ref(`carecall/rooms/${room}/medConfig`).set(_medications)
        .catch(e => { /* best effort — room may not exist yet */ });
    });
  }
}

function _medDisplayLabel(med) {
  if (!med) return 'Medication';
  const parts = [med.name];
  if (med.dose !== null && med.dose !== undefined && med.dose !== '') {
    parts.push(String(med.dose) + (med.unit || ''));
  }
  return parts.join(' ');
}

function removeMedication(id) {
  _medications = _medications.filter(m => m.id !== id);
  _saveMedications();
  refreshSettings();
  _scheduleAllMedNotifications();
}

function toggleMedication(id) {
  const med = _medications.find(m => m.id === id);
  if (med) { med.enabled = !med.enabled; _saveMedications(); refreshSettings(); _scheduleAllMedNotifications(); }
}

function _medScheduleSummary(med) {
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

function _medNeedsRefill(med) {
  return typeof med.stock === 'number' &&
         typeof med.refillThreshold === 'number' &&
         med.stock <= med.refillThreshold;
}

// Returns a map: medId -> true, for each med that has at least one
// known interaction with another med in the list.
function _computeMedInteractionFlags(meds) {
  if (!Array.isArray(meds) || meds.length < 2) return {};
  const warnings = _localInteractionCheck(meds);
  const flags = {};
  // Map drug display names back to med IDs
  const nameToIds = {};
  meds.forEach(m => {
    const key = m.name;
    if (!nameToIds[key]) nameToIds[key] = [];
    nameToIds[key].push(m.id);
  });
  warnings.forEach(w => {
    (w.drugs || []).forEach(dName => {
      const ids = nameToIds[dName];
      if (ids) ids.forEach(id => { flags[id] = true; });
    });
  });
  return flags;
}

function _renderMedsList() {
  const list = document.getElementById('meds-list');
  if (!list) return;
  list.innerHTML = '';
  if (!_medications.length) {
    list.innerHTML = '<div style="text-align:center;padding:18px 12px;color:#6889A5;font-size:0.85rem">' + t('No medications yet. Tap + Add to set up reminders.') + '</div>';
    return;
  }
  // Pre-compute which medications have known interactions
  const interactionFlags = _hasTierFeature('drug_interactions') ? _computeMedInteractionFlags(_medications) : {};
  _medications.forEach(med => {
    const item = document.createElement('div');
    item.className = 'room-item';
    item.style.opacity = med.enabled ? '1' : '0.5';
    item.style.cursor = 'pointer';
    const label = escHtml(_medDisplayLabel(med));
    const scheduleDesc = escHtml(_medScheduleSummary(med));
    const refillBadge = _medNeedsRefill(med) ? `<span class="pm-item-refill">⚠ ${t('Refill')}</span>` : '';
    const interactionBadge = interactionFlags[med.id] ? '<span class="med-interaction-badge" title="' + t('Has known interactions') + '">⚠️</span>' : '';
    item.innerHTML = `
      <div class="med-row-tap" onclick="openMedEditor('${med.id}')" style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
        <span style="font-size:1.1rem">💊</span>
        <div style="min-width:0;flex:1">
          <div class="room-item-code" style="letter-spacing:0;font-family:'Outfit',sans-serif;font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${interactionBadge}${label}${refillBadge}</div>
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
function _nextOccurrence(timeStr, from, allowedDays) {
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
function _upcomingDosesFor(med, from) {
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

function _scheduleAllMedNotifications() {
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

function _showMedPrompt(med) {
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

function _wasRecentlyTaken(medId, withinMs) {
  const last = _recentMedEvents[medId];
  if (!last) return false;
  return (Date.now() - last) < withinMs;
}

function respondMed(response) {
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

function _logMedEvent(med, status) {
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
const MED_QUEUE_KEY = 'carecall_med_queue';
const MED_QUEUE_MAX = 500;

function _medQueueLoad() {
  try { return JSON.parse(localStorage.getItem(MED_QUEUE_KEY) || '[]'); }
  catch(e) { return []; }
}
function _medQueueSave(q) {
  try { localStorage.setItem(MED_QUEUE_KEY, JSON.stringify(q)); }
  catch(e) { console.warn('[med queue] save failed', e && e.message); }
}
function _medQueueRemove(id) {
  const q = _medQueueLoad().filter(e => e.id !== id);
  _medQueueSave(q);
}

function _medEventEnqueueAndSend(path, data) {
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

async function _medQueueFlush() {
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

async function _sendMedAlert(med, type, message) {
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
const IL_BRAND_SEED = [
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
const IL_BRAND_MAP = (() => {
  const m = Object.create(null);
  IL_BRAND_SEED.forEach(([k, v]) => { m[k.toLowerCase().trim()] = v; });
  return m;
})();

// Lazy-load an optional extended brand map (e.g. an Israeli MoH
// import) from a co-hosted JSON file. Fires on first editor open,
// runs once per session, survives network failure silently. Swap
// the file contents to grow coverage without a code change.
let _brandMapExtLoaded = false;
let _brandMapExtPromise = null;

function _loadExtendedBrandMap() {
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

function _findBrandInMap(query) {
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
let _meState = null;

function openMedEditor(medId, proxy) {
  if (!_requireTier('medications', 'plus')) return;
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

function _renderMedEditor() {
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
    // Wire RxNav autocomplete search (debounced)
    nameInput.addEventListener('input', _medEditorOnNameInput);
    // Run once on open so pre-populated names still trigger a suggestion.
    _medEditorUpdateBrandSuggestion();
  }
  // Close autocomplete dropdown when clicking outside
  document.addEventListener('click', function _rxAcClose(e) {
    const dd = document.getElementById('me-rx-autocomplete');
    if (dd && !dd.contains(e.target) && e.target.id !== 'me-name') {
      dd.style.display = 'none';
    }
    if (!document.querySelector('.med-editor-modal')) {
      document.removeEventListener('click', _rxAcClose);
    }
  });

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

function _rebuildMedEditorTimes() {
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

function _medEditorAddTime() {
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

function _medEditorRemoveTime(idx) {
  const sch = _meState.draft.schedule;
  if (!Array.isArray(sch.times)) return;
  sch.times.splice(idx, 1);
  _rebuildMedEditorTimes();
}

function _medEditorSetTime(idx, value) {
  if (_meState && _meState.draft.schedule.times) {
    _meState.draft.schedule.times[idx] = value;
  }
}

function _medEditorToggleDay(dayIdx) {
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
function _medEditorUpdateBrandSuggestion() {
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

function _medEditorAcceptBrandSuggestion() {
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
function _snapshotMedEditorForm() {
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
const MED_MAX_PHOTOS = 3;

function _medEditorOnPhotoSelect(evt) {
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

function _medEditorRemovePhotoAt(idx) {
  if (!_meState) return;
  if (!Array.isArray(_meState.draft.photos)) return;
  _snapshotMedEditorForm();
  _meState.draft.photos.splice(idx, 1);
  _renderMedEditor();
}

function _medEditorOpenPhotoFromEditor(idx) {
  if (!_meState || !Array.isArray(_meState.draft.photos)) return;
  openPhotoViewer(_meState.draft.photos, idx);
}

// Bottom-sheet chooser offering camera OR gallery, because mobile
// browsers behave differently with the bare capture attribute and we
// want both options explicit.
function _medEditorOpenPhotoChooser() {
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

function _medEditorClosePhotoChooser() {
  document.querySelector('.photo-chooser-sheet')?.remove();
}

// ──────────────────────────────────────────────────────────
//  FULLSCREEN PHOTO VIEWER
// ──────────────────────────────────────────────────────────
let _pvState = null; // { photos, index, touchStartX }

function openPhotoViewer(photos, startIndex) {
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

function _pvRender() {
  if (!_pvState) return;
  const img = document.getElementById('pv-img');
  const dots = document.getElementById('pv-dots');
  if (!img) return;
  img.src = _pvState.photos[_pvState.index];
  if (dots) {
    dots.innerHTML = _pvState.photos.map((_, i) => `<span class="${i === _pvState.index ? 'active' : ''}"></span>`).join('');
  }
}

function _pvPrev() {
  if (!_pvState) return;
  _pvState.index = (_pvState.index - 1 + _pvState.photos.length) % _pvState.photos.length;
  _pvRender();
}
function _pvNext() {
  if (!_pvState) return;
  _pvState.index = (_pvState.index + 1) % _pvState.photos.length;
  _pvRender();
}
function closePhotoViewer() {
  const v = document.querySelector('.photo-viewer');
  if (v && v._keyHandler) document.removeEventListener('keydown', v._keyHandler);
  v?.remove();
  _pvState = null;
}

function _closeMedEditor() {
  document.querySelector('.med-editor-modal')?.remove();
  _meState = null;
}

function _deleteMedFromEditor() {
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
let _carerPatientCache = []; // [{uid, name, avatar, room}] snapshot from most recent picker

async function openCarerMedsManager() {
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

function _showPatientPicker() {
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

async function _openPatientMedsList(patientUid, patientName, roomId) {
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

function _renderPatientMedsList(patientUid, patientName, meds, roomId) {
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
//  CARER REMOTE PATIENT SETTINGS
//  Lets carers configure check-in, DMS, location sharing,
//  safe zone monitoring, and emergency info for connected
//  patients. Settings are stored in the shared room at
//  carecall/rooms/{roomId}/patientSettings so both parties
//  can read/write (no Firebase rule changes needed).
// ──────────────────────────────────────────────────────────

async function openCarerPatientSettings() {
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
    } catch(e) { console.warn('[carer-settings] room read', room, e); }
  }));
  const patients = Object.values(patientMap);
  if (patients.length === 0) { toast(t('No connected patients')); return; }
  if (patients.length === 1) {
    _openPatientSettingsPanel(patients[0]);
  } else {
    _showPatientPickerForSettings(patients);
  }
}

function _showPatientPickerForSettings(patients) {
  document.querySelector('.patient-settings-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'patient-settings-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:89;display:flex;align-items:center;justify-content:center;padding:16px';
  const items = patients.map(p => `
    <div class="pm-item" data-uid="${escHtml(p.uid)}" data-room="${escHtml(p.room)}">
      ${p.avatar ? `<span style="font-size:1.3rem">${escHtml(p.avatar)}</span>` : `<span style="font-size:1.1rem">👤</span>`}
      <div style="flex:1;min-width:0">
        <div class="pm-item-name">${escHtml(p.name)}</div>
      </div>
      <span class="pm-item-status">&rarr;</span>
    </div>
  `).join('');
  modal.innerHTML = `
    <div class="med-editor-card">
      <div class="me-title">⚙️ ${t('Select a patient')}</div>
      <div>${items}</div>
      <div class="me-buttons">
        <button class="me-btn-secondary" onclick="document.querySelector('.patient-settings-modal')?.remove()">${t('Cancel')}</button>
      </div>
    </div>
  `;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  modal.querySelectorAll('.pm-item').forEach(el => {
    el.addEventListener('click', () => {
      const uid = el.dataset.uid;
      const room = el.dataset.room;
      const p = patients.find(x => x.uid === uid);
      if (!p) return;
      p.room = room;
      modal.remove();
      _openPatientSettingsPanel(p);
    });
  });
  document.body.appendChild(modal);
}

async function _openPatientSettingsPanel(patient) {
  const { uid, name, room } = patient;
  // Read current settings from the room
  let cfg = {};
  try {
    const snap = await db.ref(`carecall/rooms/${room}/patientSettings`).once('value');
    cfg = snap.val() || {};
  } catch(e) { console.warn('[carer-settings] read', e); }

  const checkin = cfg.checkin || {};
  const curInterval = checkin.interval || 0;
  const curStart = checkin.startHour ?? 8;
  const curEnd = checkin.endHour ?? 22;
  const curTimeout = checkin.timeout || 300000;
  const curDms = cfg.dms || 0;
  const curLocSharing = cfg.locationSharing !== undefined ? !!cfg.locationSharing : false;
  const curSafeZoneMon = cfg.safeZoneMonitoring !== undefined ? !!cfg.safeZoneMonitoring : true;

  document.querySelector('.patient-settings-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'patient-settings-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:89;display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow-y:auto;-webkit-overflow-scrolling:touch';

  const intIdx = CHECKIN_INTERVALS.indexOf(curInterval);
  const intLabel = CHECKIN_INTERVAL_LABELS[intIdx >= 0 ? intIdx : 0];
  const toIdx = CHECKIN_TIMEOUT_OPTIONS.indexOf(curTimeout);
  const toLabel = CHECKIN_TIMEOUT_LABELS[toIdx >= 0 ? toIdx : 1];
  const dmsIdx = DMS_THRESHOLDS.indexOf(curDms);
  const dmsLabel = DMS_LABELS[dmsIdx >= 0 ? dmsIdx : 0];

  modal.innerHTML = `
    <div class="med-editor-card" style="max-width:420px;width:100%">
      <div class="me-title">⚙️ ${escHtml(name)} — ${t('Patient Settings')}</div>

      <div style="margin-bottom:16px">
        <div class="pm-item-desc" style="color:#6889A5;font-size:0.75rem;margin-bottom:8px">${t('Changes apply immediately on the patient\'s device.')}</div>
      </div>

      <div style="font-size:0.82rem;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;margin:12px 0 8px">${t('Scheduled Check-ins')}</div>
      <div class="settings-row">
        <div class="settings-row-label">${t('Check-in interval')}</div>
        <button class="btn-link" id="rps-interval-btn" data-val="${curInterval}">${intLabel}</button>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">${t('Active hours')}</div>
        <div style="display:flex;gap:4px;align-items:center">
          <button class="btn-link" id="rps-start-btn" data-val="${curStart}">${_formatHour(curStart)}</button>
          <span style="color:#6889A5;font-size:0.8rem">${t('to')}</span>
          <button class="btn-link" id="rps-end-btn" data-val="${curEnd}">${_formatHour(curEnd)}</button>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">${t('Response window')}</div>
        <button class="btn-link" id="rps-timeout-btn" data-val="${curTimeout}">${toLabel}</button>
      </div>

      <div style="font-size:0.82rem;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;margin:16px 0 8px">${t('Inactivity Alert')}</div>
      <div class="settings-row">
        <div class="settings-row-label">${t('Inactivity threshold')}</div>
        <button class="btn-link" id="rps-dms-btn" data-val="${curDms}">${dmsLabel}</button>
      </div>

      <div style="font-size:0.82rem;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;margin:16px 0 8px">${t('Location & Safety')}</div>
      <div class="settings-row">
        <div class="settings-row-label">${t('Location sharing')}</div>
        <button class="btn-link" id="rps-loc-btn" data-val="${curLocSharing ? 1 : 0}">${curLocSharing ? t('On') : t('Off')}</button>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">${t('Safe zone monitoring')}</div>
        <button class="btn-link" id="rps-safezone-btn" data-val="${curSafeZoneMon ? 1 : 0}">${curSafeZoneMon ? t('On') : t('Off')}</button>
      </div>

      <div style="font-size:0.82rem;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;margin:16px 0 8px">${t('Emergency Info Card')}</div>
      <div class="settings-row">
        <div class="settings-row-label">${t('Emergency Info Card')}</div>
        <button class="btn-link" id="rps-emergency-btn">${t('View / Edit')}</button>
      </div>

      <div class="me-buttons" style="margin-top:16px">
        <button class="me-btn-secondary" id="rps-close-btn">${t('Close')}</button>
      </div>
    </div>
  `;

  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);

  // Helper to write a single field to room patientSettings
  function _writeRoomSetting(path, value) {
    db.ref(`carecall/rooms/${room}/patientSettings/${path}`).set(value)
      .catch(e => console.warn('[carer-settings] write failed:', e && e.message));
  }

  // Wire up check-in interval cycling
  modal.querySelector('#rps-interval-btn').addEventListener('click', function() {
    let val = parseInt(this.dataset.val) || 0;
    const i = CHECKIN_INTERVALS.indexOf(val);
    val = CHECKIN_INTERVALS[(i + 1) % CHECKIN_INTERVALS.length];
    this.dataset.val = val;
    const idx = CHECKIN_INTERVALS.indexOf(val);
    this.textContent = CHECKIN_INTERVAL_LABELS[idx >= 0 ? idx : 0];
    _writeRoomSetting('checkin/interval', val);
  });

  // Wire up active hours start cycling
  modal.querySelector('#rps-start-btn').addEventListener('click', function() {
    let val = parseInt(this.dataset.val) || 0;
    const endVal = parseInt(modal.querySelector('#rps-end-btn').dataset.val) || 22;
    val = (val + 1) % 24;
    if (val >= endVal) val = 0;
    this.dataset.val = val;
    this.textContent = _formatHour(val);
    _writeRoomSetting('checkin/startHour', val);
  });

  // Wire up active hours end cycling
  modal.querySelector('#rps-end-btn').addEventListener('click', function() {
    let val = parseInt(this.dataset.val) || 22;
    const startVal = parseInt(modal.querySelector('#rps-start-btn').dataset.val) || 8;
    val = (val + 1) % 25 || 1;
    if (val <= startVal) val = startVal + 1;
    this.dataset.val = val;
    this.textContent = _formatHour(val);
    _writeRoomSetting('checkin/endHour', val);
  });

  // Wire up response window cycling
  modal.querySelector('#rps-timeout-btn').addEventListener('click', function() {
    let val = parseInt(this.dataset.val) || 300000;
    const i = CHECKIN_TIMEOUT_OPTIONS.indexOf(val);
    val = CHECKIN_TIMEOUT_OPTIONS[(i + 1) % CHECKIN_TIMEOUT_OPTIONS.length];
    this.dataset.val = val;
    const idx = CHECKIN_TIMEOUT_OPTIONS.indexOf(val);
    this.textContent = CHECKIN_TIMEOUT_LABELS[idx >= 0 ? idx : 1];
    _writeRoomSetting('checkin/timeout', val);
  });

  // Wire up DMS threshold cycling
  modal.querySelector('#rps-dms-btn').addEventListener('click', function() {
    let val = parseInt(this.dataset.val) || 0;
    const i = DMS_THRESHOLDS.indexOf(val);
    val = DMS_THRESHOLDS[(i + 1) % DMS_THRESHOLDS.length];
    this.dataset.val = val;
    const idx = DMS_THRESHOLDS.indexOf(val);
    this.textContent = DMS_LABELS[idx >= 0 ? idx : 0];
    _writeRoomSetting('dms', val);
  });

  // Wire up location sharing toggle
  modal.querySelector('#rps-loc-btn').addEventListener('click', function() {
    const on = this.dataset.val === '0';
    this.dataset.val = on ? '1' : '0';
    this.textContent = on ? t('On') : t('Off');
    _writeRoomSetting('locationSharing', on);
  });

  // Wire up safe zone monitoring toggle
  modal.querySelector('#rps-safezone-btn').addEventListener('click', function() {
    const on = this.dataset.val === '0';
    this.dataset.val = on ? '1' : '0';
    this.textContent = on ? t('On') : t('Off');
    _writeRoomSetting('safeZoneMonitoring', on);
  });

  // Wire up emergency info view/edit
  modal.querySelector('#rps-emergency-btn').addEventListener('click', async () => {
    // Read emergency info from room or fall back to user path
    let info = null;
    try {
      const snap = await db.ref(`carecall/rooms/${room}/patientSettings/emergencyInfo`).once('value');
      info = snap.val();
    } catch(e) {}
    if (!info) info = { fields: [] };
    _showRemoteEmergencyCard(info, room, name);
  });

  // Close button
  modal.querySelector('#rps-close-btn').addEventListener('click', () => modal.remove());
}

function _showRemoteEmergencyCard(info, roomId, patientName) {
  // Ensure info has the default fields structure
  if (!info.fields || !Array.isArray(info.fields)) info = { fields: [] };
  if (info.fields.length === 0) {
    // Seed with the default fields
    const defaults = [
      { key: 'dob', label: 'Date of Birth', group: 'identity', value: '' },
      { key: 'idNumber', label: 'ID / Insurance Number', group: 'identity', value: '' },
      { key: 'bloodType', label: 'Blood Type', group: 'medical', value: '' },
      { key: 'conditions', label: 'Conditions / Diagnoses', group: 'medical', value: '' },
      { key: 'allergies', label: 'Allergies', group: 'medical', value: '' },
      { key: 'weight', label: 'Weight (kg)', group: 'medical', value: '' },
      { key: 'advanceDirectives', label: 'Advance Directives', group: 'medical', value: '' },
      { key: 'emergencyContact', label: 'Emergency Contact', group: 'contacts', value: '' },
      { key: 'doctor', label: 'Doctor / GP', group: 'contacts', value: '' },
      { key: 'pharmacy', label: 'Pharmacy', group: 'contacts', value: '' },
      { key: 'insuranceProvider', label: 'Insurance Provider', group: 'contacts', value: '' },
    ];
    info.fields = defaults;
  }

  document.querySelector('.ei-remote-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'ei-remote-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:96;display:flex;align-items:center;justify-content:center;padding:12px;overflow-y:auto;-webkit-overflow-scrolling:touch';

  let editMode = false;
  function render() {
    const groups = { identity: [], medical: [], contacts: [], custom: [] };
    info.fields.forEach(f => {
      const g = groups[f.group] ? f.group : 'custom';
      groups[g].push(f);
    });

    const groupTitles = {
      identity: '🆔 ' + t('Identity'),
      medical: '⚕️ ' + t('Medical'),
      contacts: '📞 ' + t('Contacts'),
      custom: '🔖 ' + t('Other'),
    };

    let html = '';
    if (editMode) {
      info.fields.forEach((f, i) => {
        html += `<div class="settings-row" style="flex-direction:column;align-items:stretch;gap:4px;padding:6px 0">
          <label style="font-size:0.78rem;color:#94A3B8">${escHtml(t(f.label))}</label>
          <input class="text-input" data-idx="${i}" value="${escHtml(f.value || '')}" style="font-size:0.88rem;padding:8px 10px">
        </div>`;
      });
    } else {
      Object.entries(groups).forEach(([gKey, fields]) => {
        const filled = fields.filter(f => f.value);
        if (filled.length === 0 && gKey !== 'identity') return;
        html += `<div style="font-size:0.82rem;font-weight:600;color:#94A3B8;margin:12px 0 6px">${groupTitles[gKey] || gKey}</div>`;
        fields.forEach(f => {
          html += `<div class="settings-row" style="padding:4px 0">
            <span class="settings-row-label" style="font-size:0.85rem">${escHtml(t(f.label))}</span>
            <span class="settings-row-value" style="font-size:0.85rem;color:#F1F5F9">${escHtml(f.value || '—')}</span>
          </div>`;
        });
      });
    }

    overlay.innerHTML = `
      <div class="med-editor-card" style="max-width:420px;width:100%">
        <div class="me-title">🏥 ${escHtml(patientName)} — ${t('Emergency Info')}</div>
        ${html}
        <div class="me-buttons" style="margin-top:14px">
          ${editMode
            ? `<button class="me-btn-primary" id="rei-save">${t('Save')}</button>
               <button class="me-btn-secondary" id="rei-cancel">${t('Cancel')}</button>`
            : `<button class="me-btn-primary" id="rei-edit">${t('Edit')}</button>
               <button class="me-btn-secondary" id="rei-close">${t('Close')}</button>`
          }
        </div>
      </div>
    `;

    if (editMode) {
      overlay.querySelector('#rei-save').addEventListener('click', () => {
        overlay.querySelectorAll('input[data-idx]').forEach(inp => {
          const idx = parseInt(inp.dataset.idx);
          if (info.fields[idx]) info.fields[idx].value = inp.value.trim();
        });
        db.ref(`carecall/rooms/${roomId}/patientSettings/emergencyInfo`).set(info)
          .then(() => toast(t('Emergency info saved')))
          .catch(e => console.warn('[carer-settings] ei write', e));
        editMode = false;
        render();
      });
      overlay.querySelector('#rei-cancel').addEventListener('click', () => {
        editMode = false;
        render();
      });
    } else {
      overlay.querySelector('#rei-edit').addEventListener('click', () => {
        editMode = true;
        render();
      });
      overlay.querySelector('#rei-close').addEventListener('click', () => overlay.remove());
    }
  }

  render();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// ──────────────────────────────────────────────────────────
//  ADHERENCE PDF EXPORT
//  Pulls the last ADHERENCE_WINDOW_DAYS of med events from every
//  room the carer shares with the patient, aggregates per-med
//  stats, and renders a printable report via jsPDF.
// ──────────────────────────────────────────────────────────
const ADHERENCE_WINDOW_DAYS = 30;

async function exportAdherencePdf(patientUid, patientName, meds) {
  if (!_requireTier('adherence_report', 'pro')) return;
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
const _rxcuiCache = {}; // name -> rxcui string | null

async function _lookupRxcui(name) {
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
//  RxNav DRUG SEARCH + AUTOCOMPLETE
//  Searches RxNav /REST/drugs.json to find matching drugs
//  and their RxCUIs. Used in the medication editor for
//  autocomplete suggestions as the user types.
// ──────────────────────────────────────────────────────────
const _rxSearchCache = {}; // query -> [{name, rxcui}]
let _rxSearchTimer = null;

async function _searchRxNav(query) {
  if (!query || query.length < 2) return [];
  const key = query.trim().toLowerCase();
  if (key in _rxSearchCache) return _rxSearchCache[key];
  try {
    const url = 'https://rxnav.nlm.nih.gov/REST/drugs.json?name=' + encodeURIComponent(query);
    const resp = await fetch(url);
    if (!resp.ok) { _rxSearchCache[key] = []; return []; }
    const json = await resp.json();
    const results = [];
    const seen = new Set();
    const groups = (json && json.drugGroup && json.drugGroup.conceptGroup) || [];
    groups.forEach(g => {
      (g.conceptProperties || []).forEach(c => {
        if (c.rxcui && c.name && !seen.has(c.rxcui)) {
          seen.add(c.rxcui);
          results.push({ name: c.name, rxcui: c.rxcui });
        }
      });
    });
    // Limit to 8 suggestions
    const limited = results.slice(0, 8);
    _rxSearchCache[key] = limited;
    return limited;
  } catch(e) {
    console.warn('[rxSearch]', query, e && e.message);
    _rxSearchCache[key] = [];
    return [];
  }
}

function _medEditorOnNameInput() {
  clearTimeout(_rxSearchTimer);
  if (!_hasTierFeature('drug_interactions')) return;
  const nameEl = document.getElementById('me-name');
  const dropdown = document.getElementById('me-rx-autocomplete');
  if (!nameEl || !dropdown) return;
  const q = (nameEl.value || '').trim();
  if (q.length < 2) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; return; }
  _rxSearchTimer = setTimeout(async () => {
    const results = await _searchRxNav(q);
    if (!document.getElementById('me-rx-autocomplete')) return; // editor closed
    const current = (document.getElementById('me-name')?.value || '').trim();
    if (current.toLowerCase() !== q.toLowerCase()) return; // stale
    if (results.length === 0) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; return; }
    dropdown.style.display = '';
    dropdown.innerHTML = results.map((r, i) => `
      <div class="rx-ac-item" data-idx="${i}" data-rxcui="${escHtml(r.rxcui)}" data-name="${escHtml(r.name)}">
        <span class="rx-ac-name">${escHtml(r.name)}</span>
        <span class="rx-ac-cui">${escHtml(r.rxcui)}</span>
      </div>
    `).join('');
    dropdown.querySelectorAll('.rx-ac-item').forEach(el => {
      el.addEventListener('click', () => {
        const name = el.dataset.name;
        const rxcui = el.dataset.rxcui;
        const nameInput = document.getElementById('me-name');
        if (nameInput) nameInput.value = name;
        if (_meState) {
          _meState.draft.rxcui = rxcui;
          _meState.draft.name = name;
        }
        dropdown.style.display = 'none';
        dropdown.innerHTML = '';
        // Also update brand suggestion
        _medEditorUpdateBrandSuggestion();
      });
    });
  }, 300);
}

function _medEditorSelectRxAutocomplete(el) {
  // Handled via click listener in _medEditorOnNameInput
}

// ──────────────────────────────────────────────────────────
//  INTERACTION CHECK ON SAVE
//  When saving a medication, check if the new/edited med
//  interacts with any existing medications. Shows a warning
//  modal if interactions are found.
// ──────────────────────────────────────────────────────────
async function _checkInteractionsOnSave(newMedData, allMeds, onProceed) {
  if (!_hasTierFeature('drug_interactions')) { onProceed(); return; }
  // Build full list: existing meds + the new/edited one
  const otherMeds = allMeds.filter(m => m.id !== newMedData.id && m.enabled !== false);
  if (otherMeds.length === 0) { onProceed(); return; }
  // Use local interaction check first (fast, offline-capable)
  const checkList = [...otherMeds, newMedData];
  const localWarnings = _localInteractionCheck(checkList);
  // Also try RxNav API-based interaction check if we have RxCUIs
  let apiWarnings = [];
  try {
    // Resolve RxCUIs for all meds
    const lookups = await Promise.all(checkList.map(async m => {
      // Use cached rxcui if available
      if (m.rxcui) return { name: m.name, rxcui: m.rxcui };
      const lookupName = (m.activeIngredient && m.activeIngredient.trim()) || m.name;
      return { name: m.name, rxcui: await _lookupRxcui(lookupName) };
    }));
    const rxcuis = [...new Set(lookups.filter(x => x.rxcui).map(x => x.rxcui))];
    if (rxcuis.length >= 2) {
      try {
        const resp = await fetch('https://rxnav.nlm.nih.gov/REST/interaction/list.json?rxcuis=' + rxcuis.join('+'));
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
  } catch(e) { console.warn('[interaction-check-save] rxcui lookup failed', e && e.message); }

  const allWarnings = [...apiWarnings, ...localWarnings];
  if (allWarnings.length === 0) { onProceed(); return; }
  // Show the interaction warning modal
  _showInteractionWarning(allWarnings, onProceed);
}

function _showInteractionWarning(warnings, onProceed) {
  document.querySelector('.interaction-warning-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'interaction-warning-overlay';
  const items = warnings.map(w => {
    const sev = (w.severity || '').replace(/[^a-z]/g, '') || 'med';
    const pair = (w.drugs || []).join(' ↔ ');
    return `
      <div class="iw-item">
        <strong><span class="ix-severity ${sev}">${escHtml(w.severity || 'n/a')}</span> ${escHtml(pair)}</strong>
        <p>${escHtml(w.description)}</p>
      </div>`;
  }).join('');
  overlay.innerHTML = `
    <div class="interaction-warning">
      <div class="iw-icon">⚠️</div>
      <div class="iw-title">${t('Drug Interaction Warning')}</div>
      <div class="iw-subtitle">${t('The following interactions were detected with existing medications:')}</div>
      <div class="iw-list">${items}</div>
      <div class="iw-disclaimer">${t('This is a safety net — confirm with a pharmacist or doctor.')}</div>
      <button class="iw-save-anyway" id="iw-save-btn">${t('Save Anyway')}</button>
      <button class="iw-cancel" id="iw-cancel-btn">${t('Cancel')}</button>
    </div>
  `;
  overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); } };
  document.body.appendChild(overlay);
  document.getElementById('iw-save-btn').addEventListener('click', () => {
    overlay.remove();
    onProceed();
  });
  document.getElementById('iw-cancel-btn').addEventListener('click', () => {
    overlay.remove();
  });
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
const KNOWN_SEVERE_INTERACTIONS = [
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

function _localInteractionCheck(meds) {
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

async function checkDrugInteractions(patientName, meds) {
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

function _showInteractionResult(patientName, result) {
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

function _parseIntOrNull(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (str === '') return null;
  const n = parseInt(str, 10);
  return isNaN(n) ? null : Math.max(0, n);
}

function saveMedFromEditor() {
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

  // Capture rxcui from draft (set by autocomplete selection)
  const rxcui = s.draft.rxcui || null;

  // Build a temporary med object for the interaction check
  const tempMed = {
    id: s.medId || ('med_temp_' + Date.now()),
    name, activeIngredient, dose, unit, rxcui,
    enabled: true, prn,
  };

  // Determine the list of existing meds to check against
  const existingMeds = s.proxy ? (s.proxy.meds || []) : _medications;

  // The actual save logic, extracted so it can be called after interaction check
  function _doSave() {
    if (s.proxy) {
      // Carer is editing a patient's meds remotely.
      const targetList = s.proxy.meds;
      if (s.isNew) {
        targetList.push({
          id: 'med_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name, activeIngredient, dose, unit, instructions, photos, rxcui,
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
        med.rxcui = rxcui;
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
        name, activeIngredient, dose, unit, instructions, photos, rxcui,
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
      med.rxcui = rxcui;
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

  // Run interaction check before saving (gated behind 'plus' tier)
  _checkInteractionsOnSave(tempMed, existingMeds, _doSave);
}

// ════════════════════════════════════════════════════════════
//  WEBRTC VOICE CALL
// ════════════════════════════════════════════════════════════
const VC = {
  pc:           null,    // RTCPeerConnection
  localStream:  null,    // MediaStream
  sigRef:       null,    // Firebase signaling reference
  sigListeners: [],      // cleanup refs
  callId:       null,    // unique voice call session ID
  timerInterval:null,
  startTime:    0,
  role:         null,    // 'caller' | 'callee'
};

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ── Carer initiates voice call to patient ──
async function startVoiceCall() {
  if (VC.pc) { toast(t('Already in a call')); return; }

  const call = CS.activeCalls[CS.alertCallId] || Object.values(CS.activeCalls).find(c => c.status === 'active');
  if (!call) { toast(t('No active call to connect to')); return; }

  const roomId = call._room || S.activeRoom || S.rooms[0];
  if (!roomId) { toast(t('No room found')); return; }

  if (call.status === 'active') acknowledgeCall(call.id);
  dismissAlert();

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast(t('Microphone not available on this device'));
      return;
    }
    VC.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch(e) {
    console.warn('[VoiceCall] Mic access failed:', e && e.message);
    toast(t('Microphone access required — check app permissions'));
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
let _vcListenerRefs = [];
function _listenForVoiceCalls() {
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

async function answerVoiceCall(vcData, autoAnswer) {
  const vc = vcData || VC._incomingData;
  if (!vc || !VC.sigRef) return;

  document.getElementById('vc-incoming').classList.remove('show');

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast(t('Microphone not available on this device'));
      return;
    }
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

function declineVoiceCall() {
  document.getElementById('vc-incoming').classList.remove('show');
  if (VC.sigRef) VC.sigRef.child('status').set('declined');
  VC.sigRef = null;
  VC.callId = null;
  VC._incomingData = null;
}

function endVoiceCall() {
  if (VC.sigRef) VC.sigRef.child('status').set('ended');
  _cleanupVoiceCall();
}

function _cleanupVoiceCall() {
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

function _showCallOverlay(name, status) {
  document.getElementById('vc-who').textContent = name;
  document.getElementById('vc-status').textContent = status;
  document.getElementById('vc-timer').textContent = '00:00';
  document.getElementById('voice-call-overlay').classList.add('show');
}

function _setCallStatus(status) {
  document.getElementById('vc-status').textContent = status;
}

function _startCallTimer() {
  if (VC.startTime) return; // already started
  VC.startTime = Date.now();
  _registerTick('vcTimer', () => {
    const s = Math.floor((Date.now() - VC.startTime) / 1000);
    const m = Math.floor(s / 60);
    document.getElementById('vc-timer').textContent =
      `${String(m).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  });
}

// ════════════════════════════════════════════════════════════
//  FCM PUSH — keeps carer reachable when app is backgrounded
// ════════════════════════════════════════════════════════════
let _messaging = null;

async function setupCarerPush() {
  if (S.role !== 'carer' && !_tempCarerActive) return;

  // ── Native push (Capacitor) — use native FCM SDK ──
  if (IS_NATIVE) {
    try {
      const nativeToken = await Native.initPush();
      // On iOS, Capacitor returns the raw APNs token (hex). The AppDelegate
      // converts it to an FCM token and calls window._updateNativeFcmToken().
      // Wait briefly for it, then prefer it.
      let fcmToken = nativeToken;
      if (nativeToken && !window._nativeFcmToken) {
        for (let i = 0; i < 50; i++) {
          await new Promise(r => setTimeout(r, 200));
          if (window._nativeFcmToken) break;
        }
      }
      if (window._nativeFcmToken) {
        fcmToken = window._nativeFcmToken;
        console.log('[Native FCM] Using FCM token from AppDelegate:', fcmToken.substring(0, 20) + '…');
      } else {
        console.log('[Native FCM] Falling back to Capacitor token:', nativeToken ? (nativeToken.substring(0, 20) + '…') : 'NULL');
      }
      if (fcmToken) {
        for (const room of S.rooms) {
          await db.ref(`carecall/rooms/${room}/members/${S.uid}/fcmToken`).set(fcmToken);
        }
        console.log('[Native FCM] Token registered for', S.rooms.length, 'room(s)');
        // If AppDelegate delivers the FCM token later, update all rooms.
        window._updateNativeFcmToken = async (token) => {
          window._nativeFcmToken = token;
          if (!S.uid || !S.rooms.length) return;
          for (const room of S.rooms) {
            try { await db.ref(`carecall/rooms/${room}/members/${S.uid}/fcmToken`).set(token); } catch(_) {}
          }
          console.log('[Native FCM] Late token update for', S.rooms.length, 'room(s):', token.substring(0, 20) + '…');
        };
        Native.onPushReceived(notification => {
          const data = notification.data || {};
          if (data.callId && data.fromName) {
            showIncomingAlert({
              id: data.callId,
              fromName: data.fromName,
              type: data.type || 'help',
              message: data.message || '',
              _room: data.roomCode,
            });
          }
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
async function refreshFcmTokenIfNeeded() {
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
let _wasHidden = false;
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


// ════════════════════════════════════════════════════════════
//  PWA — Service Worker + Install Prompt
// ════════════════════════════════════════════════════════════
let _installPrompt = null;

// Register service worker + auto-update logic (skip in native Capacitor)
if ('serviceWorker' in navigator && !IS_NATIVE) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(BASE_PATH + '/sw.js', { scope: BASE_PATH + '/' });
      console.log('[SW] Registered');

      // When a new SW is found, wait for it to install then let it activate.
      // skipWaiting() in sw.js makes it activate immediately.
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'activated') {
            console.log('[SW] New version activated');
          }
        });
      });

      // Periodically check for SW updates (every 30 min)
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);

      // Also check when app returns to foreground
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          reg.update().catch(() => {});
        }
      });

    } catch(e) {
      console.warn('[SW] Registration failed:', e);
    }
  });

  // When a new SW takes control, reload to pick up updated assets.
  // This fires after skipWaiting() + clients.claim() in the new SW.
  let _refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_refreshing) return;
    _refreshing = true;
    console.log('[SW] New version — reloading');
    window.location.reload();
  });
}

// Catch the browser's install prompt (Chrome/Android)
window.addEventListener('beforeinstallprompt', evt => {
  evt.preventDefault();
  _installPrompt = evt;
  // Show banner only if not already installed and not dismissed recently
  if (!localStorage.getItem('pwa_dismissed')) {
    setTimeout(() => document.getElementById('install-banner').classList.add('show'), 2000);
  }
});

// Detect iOS Safari (no beforeinstallprompt support)
function isIosSafari() {
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  const isSafari = /safari/i.test(ua) && !/chrome|crios|fxios/i.test(ua);
  return isIos && isSafari;
}
function isInStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

// Show iOS instructions if on iOS Safari and not installed yet
window.addEventListener('load', () => {
  if (isIosSafari() && !isInStandaloneMode() && !localStorage.getItem('pwa_dismissed')) {
    setTimeout(() => document.getElementById('install-banner').classList.add('show'), 2000);
    // iOS banner taps open the instruction sheet instead
    document.getElementById('install-btn').textContent = 'How to Install';
    document.getElementById('install-btn').onclick = () => {
      document.getElementById('ios-sheet').classList.add('show');
      document.getElementById('install-banner').classList.remove('show');
    };
  }
});

// Installed successfully — hide banner
window.addEventListener('appinstalled', () => {
  document.getElementById('install-banner').classList.remove('show');
  _installPrompt = null;
  toast(t('CareCall installed!'));
});

function triggerInstall() {
  if (!_installPrompt) return;
  _installPrompt.prompt();
  _installPrompt.userChoice.then(choice => {
    if (choice.outcome === 'accepted') {
      document.getElementById('install-banner').classList.remove('show');
    }
    _installPrompt = null;
  });
}

function dismissInstall() {
  document.getElementById('install-banner').classList.remove('show');
  localStorage.setItem('pwa_dismissed', '1');
  // Allow it to show again after 7 days
  setTimeout(() => localStorage.removeItem('pwa_dismissed'), 7 * 24 * 60 * 60 * 1000);
}



// ════════════════════════════════════════════════════════════
//  NIGHT / BEDSIDE MODE
//  Full-screen dim SOS button with wake lock. Designed for
//  nightstand use — phone becomes a dedicated call button.
// ════════════════════════════════════════════════════════════
let _nightWakeLock = null;
let _nightClockInterval = null;

let _nightSwipeStartY = 0;

function enterNightMode() {
  const el = document.getElementById('night-mode');
  if (!el) return;
  el.classList.add('active');
  document.getElementById('night-status').textContent = '';
  _updateNightClock();
  _nightClockInterval = setInterval(_updateNightClock, 30000);
  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen')
      .then(l => { _nightWakeLock = l; })
      .catch(() => {});
  }
  el.style.filter = 'brightness(0.6)';
  // Swipe-down gesture to exit
  el.addEventListener('touchstart', _nightTouchStart, { passive: true });
  el.addEventListener('touchend', _nightTouchEnd, { passive: true });
}

function _nightTouchStart(e) {
  _nightSwipeStartY = e.touches[0].clientY;
}

function _nightTouchEnd(e) {
  const dy = e.changedTouches[0].clientY - _nightSwipeStartY;
  if (dy > 120) exitNightMode();
}

function exitNightMode() {
  const el = document.getElementById('night-mode');
  if (el) {
    el.classList.remove('active');
    el.removeEventListener('touchstart', _nightTouchStart);
    el.removeEventListener('touchend', _nightTouchEnd);
  }
  if (_nightClockInterval) { clearInterval(_nightClockInterval); _nightClockInterval = null; }
  if (_nightWakeLock) { try { _nightWakeLock.release(); } catch(_) {} _nightWakeLock = null; }
}

function _updateNightClock() {
  const el = document.getElementById('night-clock');
  if (!el) return;
  const now = new Date();
  el.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
}

function nightModeSos() {
  const statusEl = document.getElementById('night-status');
  const btn = document.getElementById('night-sos-btn');
  const iconEl = document.getElementById('night-sos-btn')?.querySelector('.night-sos-icon');
  const labelEl = document.getElementById('night-sos-btn')?.querySelector('.night-sos-label');
  if (S.role !== 'patient') {
    if (statusEl) statusEl.textContent = t('Night mode is for patients only');
    return;
  }
  if (PS.status === 'calling' || PS.status === 'acked') {
    if (statusEl) statusEl.textContent = t('Already calling…');
    return;
  }
  // Visual feedback: button pulses via CSS animation + status text
  if (statusEl) statusEl.textContent = t('Calling carer…');
  if (btn) { btn.classList.add('calling'); btn.classList.remove('acked'); }
  if (labelEl) labelEl.textContent = 'CALLING…';
  if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
  patientCallMain();
  // Watch for ack to update the night status + button
  const checkAck = setInterval(() => {
    if (PS.status === 'acked') {
      if (statusEl) statusEl.textContent = '✓ ' + t('Help on the way');
      if (btn) { btn.classList.remove('calling'); btn.classList.add('acked'); }
      if (iconEl) iconEl.textContent = '✓';
      if (labelEl) labelEl.textContent = t('COMING');
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      clearInterval(checkAck);
      // Reset button after 30s so they can call again if needed
      setTimeout(() => _resetNightSosButton(), 30000);
    } else if (PS.status === 'idle' || PS.status === 'ready') {
      _resetNightSosButton();
      clearInterval(checkAck);
    }
  }, 1000);
  setTimeout(() => clearInterval(checkAck), 300000);
}

function _resetNightSosButton() {
  const btn = document.getElementById('night-sos-btn');
  const iconEl = btn?.querySelector('.night-sos-icon');
  const labelEl = btn?.querySelector('.night-sos-label');
  const statusEl = document.getElementById('night-status');
  if (btn) { btn.classList.remove('calling', 'acked'); }
  if (iconEl) iconEl.textContent = '🔔';
  if (labelEl) labelEl.textContent = 'CALL';
  if (statusEl) statusEl.textContent = '';
}

// ════════════════════════════════════════════════════════════
//  UI REDESIGN — GREETING, CARERS LIST, PROFILE, PHOTO, BACK
// ════════════════════════════════════════════════════════════

function _getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return t('Good morning,');
  if (h < 17) return t('Good afternoon,');
  return t('Good evening,');
}

function _updateGreetingHeaders() {
  const greeting = _getGreeting();
  const pGreeting = document.getElementById('p-greeting');
  const cGreeting = document.getElementById('c-greeting');
  const pName = document.getElementById('p-name');
  const cName = document.getElementById('c-name');
  if (pGreeting) pGreeting.textContent = greeting;
  if (cGreeting) cGreeting.textContent = greeting;
  if (pName) pName.textContent = S.name || '····';
  if (cName) cName.textContent = S.name || '····';
  ['p-avatar-btn', 'c-avatar-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const photo = S._photoUrl || localStorage.getItem('carecall_photo');
    if (photo) {
      btn.innerHTML = `<img src="${photo}" alt="avatar">`;
    } else {
      btn.textContent = S.avatar || '👤';
    }
  });
}

function toggleCarerDropdown() {
  const container = document.getElementById('my-carers');
  if (container) container.classList.toggle('open');
}

function renderCarersList() {
  const carers = PS.allCarers || [];
  const avatarEl = document.getElementById('primary-carer-avatar');
  const nameEl = document.getElementById('primary-carer-name');
  const statusEl = document.getElementById('primary-carer-status');
  const dropdown = document.getElementById('carer-dropdown');
  if (!avatarEl || !nameEl || !statusEl || !dropdown) return;

  if (carers.length === 0) {
    nameEl.textContent = t('No carer connected');
    nameEl.onclick = null;
    avatarEl.onclick = null;
    statusEl.textContent = t('Share your code to connect');
    statusEl.className = 'carer-status';
    avatarEl.textContent = '🔗';
    dropdown.innerHTML = '';
    return;
  }

  const sorted = [...carers].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  const primary = sorted[0];
  const pPhoto = _getMemberPhoto(primary.uid);
  if (pPhoto) {
    avatarEl.innerHTML = `<img src="${pPhoto}" alt="">`;
  } else {
    avatarEl.textContent = primary.avatar || '👤';
    avatarEl.querySelectorAll('img').forEach(i => i.remove());
  }
  nameEl.textContent = primary.name || t('Carer');
  // Allow tapping the primary carer name or avatar to open their profile
  nameEl.onclick = (e) => { e.stopPropagation(); openProfileModal(primary.uid); };
  avatarEl.onclick = (e) => { e.stopPropagation(); openProfileModal(primary.uid); };
  const avail = primary.availability || 'available';
  if (!primary.online) {
    statusEl.textContent = t('Offline — will be notified');
    statusEl.className = 'carer-status offline';
  } else if (avail === 'busy') {
    statusEl.textContent = '⏳ ' + t('Busy');
    statusEl.className = 'carer-status busy';
  } else if (avail === 'off-duty') {
    statusEl.textContent = '💤 ' + t('Off Duty');
    statusEl.className = 'carer-status offline';
  } else {
    statusEl.textContent = '✓ ' + t('Online');
    statusEl.className = 'carer-status online';
  }

  if (sorted.length <= 1) {
    dropdown.innerHTML = '';
    const arrow = document.querySelector('.carer-dropdown-arrow');
    if (arrow) arrow.style.display = 'none';
  } else {
    const arrow = document.querySelector('.carer-dropdown-arrow');
    if (arrow) arrow.style.display = '';
    dropdown.innerHTML = sorted.slice(1).map(c => {
      const photo = _getMemberPhoto(c.uid);
      const avatarHtml = photo
        ? `<div class="cdi-avatar"><img src="${photo}" alt=""></div>`
        : `<div class="cdi-avatar">${escHtml(c.avatar || '👤')}</div>`;
      const ca = c.availability || 'available';
      const dotClass = !c.online ? 'offline' : (ca === 'available' ? 'online' : 'busy');
      return `<div class="carer-dropdown-item" onclick="openProfileModal('${escHtml(c.uid)}')">
        ${avatarHtml}
        <div class="cdi-name">${escHtml(c.name || t('Carer'))}</div>
        <div class="cdi-dot ${dotClass}"></div>
      </div>`;
    }).join('');
  }
}

function renderPatientsList(members) {
  const listEl = document.getElementById('my-patients-list');
  if (!listEl) return;
  const patients = [];
  Object.entries(members || {}).forEach(([uid, m]) => {
    if (m.role === 'patient') {
      const stale = _isPresenceStale(m);
      patients.push({ uid, name: m.name, online: m.online && !stale, avatar: m.avatar, phone: m.phone });
    }
  });
  if (patients.length === 0) {
    listEl.innerHTML = '<div class="no-patients-msg">' + t('No patients connected yet') + '</div>';
    return;
  }
  listEl.innerHTML = patients.map(p => {
    const photo = _getMemberPhoto(p.uid);
    const avatarHtml = photo
      ? `<div class="pli-avatar"><img src="${photo}" alt=""></div>`
      : `<div class="pli-avatar">${escHtml(p.avatar || '🛏️')}</div>`;
    return `<div class="patient-list-item" onclick="openProfileModal('${escHtml(p.uid)}')">
      ${avatarHtml}
      <div class="pli-info">
        <div class="pli-name">${escHtml(p.name || t('Patient'))}</div>
        <div class="pli-status ${p.online ? 'online' : ''}">${p.online ? '✓ ' + t('Online') : t('Offline')}</div>
      </div>
      <div class="pli-dot ${p.online ? 'online' : 'offline'}"></div>
    </div>`;
  }).join('');
}

let _profileModalData = {};
async function openProfileModal(uid) {
  if (!uid) return;
  const modal = document.getElementById('profile-modal');
  const photoEl = document.getElementById('pm-photo');
  const nameEl = document.getElementById('pm-name');
  const roleEl = document.getElementById('pm-role');
  const statusEl = document.getElementById('pm-status');
  const phoneEl = document.getElementById('pm-phone');
  if (!modal) return;

  let memberData = null;
  if (uid === S.uid) {
    memberData = { name: S.name, role: S.role, phone: S.phone, avatar: S.avatar, online: true, availability: 'available' };
  } else {
    const caches = [PS._roomMembersCache, window._carerMembersCache];
    for (const cache of caches) {
      if (!cache) continue;
      for (const roomMembers of Object.values(cache)) {
        if (roomMembers[uid]) { memberData = roomMembers[uid]; break; }
      }
      if (memberData) break;
    }
    if (!memberData) {
      const carer = (PS.allCarers || []).find(c => c.uid === uid);
      if (carer) memberData = carer;
    }
  }

  if (!memberData) {
    // Fallback: search rooms in Firebase directly so we never show "Unknown"
    // when the member exists but the local cache hasn't been populated yet.
    memberData = { name: 'Unknown', role: '?', online: false };
    if (db && S.rooms && S.rooms.length) {
      for (const room of S.rooms) {
        try {
          const snap = await db.ref(`carecall/rooms/${room}/members/${uid}`).once('value');
          const m = snap.val();
          if (m && m.name) { memberData = m; break; }
        } catch(_) {}
      }
    }
  }

  _renderProfileModalContent(modal, uid, memberData, photoEl, nameEl, roleEl, statusEl, phoneEl);
}

function _renderProfileModalContent(modal, uid, memberData, photoEl, nameEl, roleEl, statusEl, phoneEl) {
  const photo = _getMemberPhoto(uid);
  if (photo) {
    photoEl.innerHTML = `<img src="${photo}" alt="">`;
  } else {
    photoEl.textContent = memberData.avatar || '👤';
    photoEl.querySelectorAll('img').forEach(i => i.remove());
  }

  nameEl.textContent = memberData.name || '—';
  const roleLabels = { patient: t('Patient'), carer: t('Carer'), family: t('Family member') };
  roleEl.textContent = roleLabels[memberData.role] || memberData.role || '';
  const isOnline = uid === S.uid ? true : (memberData.online && !_isPresenceStale(memberData));
  const avail = memberData.availability || 'available';
  if (!isOnline) {
    statusEl.textContent = t('Offline');
    statusEl.className = 'profile-status offline';
  } else if (avail === 'busy') {
    statusEl.textContent = t('Busy');
    statusEl.className = 'profile-status busy';
  } else if (avail === 'off-duty') {
    statusEl.textContent = t('Off Duty');
    statusEl.className = 'profile-status offline';
  } else {
    statusEl.textContent = t('Online');
    statusEl.className = 'profile-status online';
  }
  if (memberData.phone) {
    phoneEl.innerHTML = `<a href="tel:${memberData.phone}">${escHtml(memberData.phone)}</a>`;
  } else {
    phoneEl.textContent = '';
  }

  modal.classList.add('show');
  _profileModalData = { uid };
  modal.onclick = (e) => { if (e.target === modal) closeProfileModal(); };
}

function closeProfileModal() {
  const modal = document.getElementById('profile-modal');
  if (modal) modal.classList.remove('show');
}

function _getMemberPhoto(uid) {
  if (uid === S.uid) {
    return S._photoUrl || localStorage.getItem('carecall_photo') || null;
  }
  try {
    const cache = JSON.parse(localStorage.getItem('carecall_member_photos') || '{}');
    return cache[uid] || null;
  } catch(e) { return null; }
}

function _setMemberPhoto(uid, dataUrl) {
  if (uid === S.uid) {
    S._photoUrl = dataUrl;
    localStorage.setItem('carecall_photo', dataUrl);
  }
  try {
    const cache = JSON.parse(localStorage.getItem('carecall_member_photos') || '{}');
    cache[uid] = dataUrl;
    localStorage.setItem('carecall_member_photos', JSON.stringify(cache));
  } catch(e) {}
}

function _pickProfilePhoto() {
  // iOS: use Capacitor Camera plugin (native action sheet works well)
  const isIos = IS_NATIVE && window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'ios';
  if (isIos && window.Capacitor.Plugins.Camera) {
    _pickProfilePhotoNative();
    return;
  }
  // Android native + web: show our own chooser dialog
  _showPhotoChooser();
}
function _showPhotoChooser() {
  const existing = document.getElementById('photo-chooser-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'photo-chooser-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:flex-end;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px 20px 0 0;width:100%;max-width:400px;padding:20px 16px calc(env(safe-area-inset-bottom,0px)+16px);display:flex;flex-direction:column;gap:8px">
      <div style="font-size:1.1rem;font-weight:700;color:#1A202C;text-align:center;padding-bottom:8px">${t('Profile Photo')}</div>
      <button onclick="_photoFromCamera()" style="width:100%;padding:16px;border:none;border-radius:14px;background:#F7FAFC;font-size:1rem;font-weight:600;color:#1A202C;font-family:inherit;cursor:pointer">📷 ${t('Take Photo')}</button>
      <button onclick="_photoFromGallery()" style="width:100%;padding:16px;border:none;border-radius:14px;background:#F7FAFC;font-size:1rem;font-weight:600;color:#1A202C;font-family:inherit;cursor:pointer">🖼️ ${t('Choose from Gallery')}</button>
      <button onclick="document.getElementById('photo-chooser-overlay').remove()" style="width:100%;padding:14px;border:none;border-radius:14px;background:transparent;font-size:0.95rem;font-weight:500;color:#718096;font-family:inherit;cursor:pointer">${t('Cancel')}</button>
    </div>
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}
function _photoFromCamera() {
  document.getElementById('photo-chooser-overlay')?.remove();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.onchange = _handlePhotoFileSelect;
  input.click();
}
function _photoFromGallery() {
  document.getElementById('photo-chooser-overlay')?.remove();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = _handlePhotoFileSelect;
  input.click();
}
function _handlePhotoFileSelect(evt) {
  const file = evt.target.files && evt.target.files[0];
  if (!file) return;
  _compressPhoto(file, 200, 200, 0.8, (dataUrl) => {
    if (!dataUrl) { toast(t('Photo upload failed')); return; }
    _saveProfilePhoto(dataUrl);
  });
}
async function _pickProfilePhotoNative() {
  try {
    const { Camera } = window.Capacitor.Plugins;
    const photo = await Camera.getPhoto({
      quality: 70,
      width: 300,
      height: 300,
      allowEditing: false,
      resultType: 'base64',
      source: 'PROMPT',
      promptLabelHeader: t('Profile Photo'),
      promptLabelPhoto: t('Choose from Gallery'),
      promptLabelPicture: t('Take Photo'),
      promptLabelCancel: t('Cancel'),
    });
    if (photo && photo.base64String) {
      const dataUrl = 'data:image/jpeg;base64,' + photo.base64String;
      _saveProfilePhoto(dataUrl);
    }
  } catch(e) {
    if (e && e.message && (e.message.includes('cancel') || e.message.includes('User') || e.message.includes('dismissed'))) return;
    console.warn('[Photo] Native capture failed:', e && e.message);
    _pickProfilePhotoWeb();
  }
}
function _pickProfilePhotoWeb() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = (evt) => {
    const file = evt.target.files && evt.target.files[0];
    if (!file) return;
    _compressPhoto(file, 200, 200, 0.8, (dataUrl) => {
      if (!dataUrl) { toast(t('Photo upload failed')); return; }
      _saveProfilePhoto(dataUrl);
    });
  };
  input.click();
}
function _saveProfilePhoto(dataUrl) {
  S._photoUrl = dataUrl;
  localStorage.setItem('carecall_photo', dataUrl);
  _updateSettingsPhotoThumb();
  _updateGreetingHeaders();
  if (S.uid && db) {
    db.ref(`carecall/users/${S.uid}/photo`).set(dataUrl).catch(() => {});
    S.rooms.forEach(room => {
      db.ref(`carecall/rooms/${room}/members/${S.uid}/photo`).set(dataUrl).catch(() => {});
    });
  }
  toast(t('Photo updated'));
}
function handleProfilePhotoUpload(evt) {
  const file = evt.target.files && evt.target.files[0];
  if (!file) return;
  _compressPhoto(file, 200, 200, 0.8, (dataUrl) => {
    if (!dataUrl) { toast(t('Photo upload failed')); return; }
    _saveProfilePhoto(dataUrl);
  });
}

function _compressPhoto(file, maxW, maxH, quality, callback) {
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxW || h > maxH) {
        const ratio = Math.min(maxW / w, maxH / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      callback(dataUrl);
    };
    img.onerror = function() { callback(null); };
    img.src = e.target.result;
  };
  reader.onerror = function() { callback(null); };
  reader.readAsDataURL(file);
}

function _updateSettingsPhotoThumb() {
  const thumb = document.getElementById('s-photo-thumb');
  if (!thumb) return;
  const photo = S._photoUrl || localStorage.getItem('carecall_photo');
  if (photo) {
    thumb.innerHTML = `<img src="${photo}" alt="">`;
  } else {
    thumb.textContent = S.avatar || '👤';
    thumb.querySelectorAll('img').forEach(i => i.remove());
  }
}

function updateStatusCards() {
  const lastCallEl = document.getElementById('sc-last-call-val');
  if (lastCallEl && _allLogCalls) {
    const patientCalls = _allLogCalls.filter(c => !c._type && c.timestamp);
    if (patientCalls.length) {
      patientCalls.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      lastCallEl.textContent = timeAgo(patientCalls[0].timestamp);
    } else {
      lastCallEl.textContent = '—';
    }
  }
  const nextMedCard = document.getElementById('sc-next-med');
  const nextMedVal = document.getElementById('sc-next-med-val');
  if (nextMedCard && nextMedVal && typeof _medications !== 'undefined' && _medications.length) {
    const now = Date.now();
    let nextTime = Infinity;
    _medications.forEach(med => {
      if (!med.enabled) return;
      const upcoming = typeof _upcomingDosesFor === 'function' ? _upcomingDosesFor(med) : [];
      upcoming.forEach(dose => {
        if (dose.time && dose.time > now && dose.time < nextTime) {
          nextTime = dose.time;
        }
      });
    });
    if (nextTime < Infinity) {
      nextMedCard.style.display = '';
      const diffMin = Math.round((nextTime - now) / 60000);
      if (diffMin < 60) {
        nextMedVal.textContent = diffMin + ' min';
      } else {
        const h = Math.floor(diffMin / 60);
        const m = diffMin % 60;
        nextMedVal.textContent = h + 'h ' + (m > 0 ? m + 'm' : '');
      }
    } else {
      nextMedCard.style.display = 'none';
    }
  }
}

function _initAndroidBackButton() {
  if (!IS_NATIVE) return;
  try {
    const { App } = window.Capacitor.Plugins;
    if (!App || !App.addListener) return;
    App.addListener('backButton', () => {
      const profileModal = document.getElementById('profile-modal');
      if (profileModal && profileModal.classList.contains('show')) {
        closeProfileModal();
        return;
      }
      const carerContainer = document.getElementById('my-carers');
      if (carerContainer && carerContainer.classList.contains('open')) {
        carerContainer.classList.remove('open');
        return;
      }
      if (_screenHistory.length > 0) {
        goBack();
      } else {
        try { App.minimizeApp(); } catch(e) {}
      }
    });
  } catch(e) {
    console.warn('[BackButton] init error:', e && e.message);
  }
}

function _watchMemberPhotos() {
  if (!S.uid || !db) return;
  S.rooms.forEach(roomCode => {
    const ref = db.ref(`carecall/rooms/${roomCode}/members`);
    ref.on('value', snap => {
      const members = snap.val() || {};
      Object.entries(members).forEach(([uid, m]) => {
        if (m.photo && uid !== S.uid) {
          _setMemberPhoto(uid, m.photo);
        }
      });
      if (S.role === 'patient') renderCarersList();
      else if (S.role === 'carer') renderPatientsList(members);
    });
  });
}

// ════════════════════════════════════════════════════════════
//  SHARED CARE CALENDAR
// ════════════════════════════════════════════════════════════
let _calYear = new Date().getFullYear();
let _calMonth = new Date().getMonth(); // 0-based
let _calSelectedDate = _todayStr(); // YYYY-MM-DD
let _calEvents = {}; // { roomId: { eventId: eventObj } }
let _calListenerRefs = []; // Firebase listener references

function _todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const _CAL_MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

const _CAL_DOW_NAMES = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

const _CAL_TYPE_ICONS = {
  appointment: '🏥',
  medication: '💊',
  shift: '👤',
  other: '📌'
};

function _calGetAllEvents() {
  // Merge events from all rooms into a flat array
  const all = [];
  for (const roomId of Object.keys(_calEvents)) {
    const roomEvts = _calEvents[roomId];
    if (!roomEvts) continue;
    for (const evtId of Object.keys(roomEvts)) {
      all.push({ ...roomEvts[evtId], id: evtId, _roomId: roomId });
    }
  }
  return all;
}

function _calEventsForDate(dateStr) {
  return _calGetAllEvents()
    .filter(e => e.date === dateStr)
    .sort((a, b) => {
      // Sort by time (events without time go last), then by title
      if (a.time && b.time) return a.time.localeCompare(b.time);
      if (a.time) return -1;
      if (b.time) return 1;
      return (a.title || '').localeCompare(b.title || '');
    });
}

function _calDatesWithEvents() {
  // Returns a map: dateStr -> { hasEvents: true, hasPriority: bool }
  const map = {};
  for (const e of _calGetAllEvents()) {
    if (!e.date) continue;
    if (!map[e.date]) map[e.date] = { hasEvents: true, hasPriority: false };
    if (e.priority) map[e.date].hasPriority = true;
  }
  return map;
}

let _calExpanded = false;

function calNavPrev() { _calExpanded ? calPrevMonth() : calPrevWeek(); }
function calNavNext() { _calExpanded ? calNextMonth() : calNextWeek(); }

function calToggleExpand() {
  _calExpanded = !_calExpanded;
  renderCalendar();
}

function calSelectDow(dowIndex) {
  // dowIndex: 0=Mon, 1=Tue, ..., 6=Sun
  const parts = (_calSelectedDate || _todayStr()).split('-');
  const current = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const currentDow = _dayToMonday(current.getDay());
  const diff = dowIndex - currentDow;
  current.setDate(current.getDate() + diff);
  _calSelectedDate = current.getFullYear() + '-' + String(current.getMonth() + 1).padStart(2, '0') + '-' + String(current.getDate()).padStart(2, '0');
  _calYear = current.getFullYear();
  _calMonth = current.getMonth();
  renderCalendar();
}

function calPrevWeek() {
  const parts = (_calSelectedDate || _todayStr()).split('-');
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  d.setDate(d.getDate() - 7);
  _calSelectedDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  _calYear = d.getFullYear();
  _calMonth = d.getMonth();
  renderCalendar();
}

function calNextWeek() {
  const parts = (_calSelectedDate || _todayStr()).split('-');
  const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  d.setDate(d.getDate() + 7);
  _calSelectedDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  _calYear = d.getFullYear();
  _calMonth = d.getMonth();
  renderCalendar();
}

function _initCalSwipe() {
  const grid = document.getElementById('cal-grid-wrap');
  if (!grid || grid._swipeInit) return;
  grid._swipeInit = true;
  let startX = 0, startY = 0;
  grid.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });
  grid.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (_calExpanded) {
        if (dx < 0) calNextMonth(); else calPrevMonth();
      } else {
        if (dx < 0) calNextWeek(); else calPrevWeek();
      }
    }
  }, { passive: true });
}

/**
 * Convert JS day (0=Sun) to Monday-first index (Mon=0 .. Sun=6)
 */
function _dayToMonday(jsDay) {
  return (jsDay + 6) % 7;
}

function renderCalendar() {
  const titleEl = document.getElementById('cal-month-title');
  const gridEl = document.getElementById('cal-grid');
  const dowRow = document.getElementById('cal-dow-row');
  const wrap = document.getElementById('cal-grid-wrap');
  const expandBtn = document.getElementById('cal-expand-btn');
  const expandIcon = document.getElementById('cal-expand-icon');
  if (!titleEl || !gridEl || !dowRow) return;

  // Header title
  titleEl.textContent = t(_CAL_MONTH_NAMES[_calMonth]) + ' ' + _calYear;

  // Day-of-week labels (Mon first) — tapping jumps to that day of current week
  dowRow.innerHTML = _CAL_DOW_NAMES.map((d, i) =>
    '<div class="cal-dow-cell" onclick="calSelectDow(' + i + ')">' + t(d) + '</div>'
  ).join('');

  // Expand toggle icon
  if (expandIcon) expandIcon.textContent = _calExpanded ? '▲' : '▼';
  if (expandBtn) expandBtn.classList.toggle('expanded', _calExpanded);

  const today = _todayStr();
  const evtMap = _calDatesWithEvents();

  // Helper to build a day cell
  function _dayCell(dateStr, dayNum, otherMonth) {
    const isToday = dateStr === today;
    const isSelected = dateStr === _calSelectedDate;
    let cls = 'cal-day';
    if (otherMonth) cls += ' other-month';
    if (isToday) cls += ' today';
    if (isSelected && !isToday) cls += ' selected';

    let dots = '';
    if (evtMap[dateStr]) {
      const dotCls = evtMap[dateStr].hasPriority ? 'cal-dot priority' : 'cal-dot';
      dots = '<div class="cal-day-dots"><div class="' + dotCls + '"></div></div>';
    }
    return '<div class="' + cls + '" onclick="calSelectDate(\'' + dateStr + '\')">' + dayNum + dots + '</div>';
  }

  function _fmtDate(y, m, d) {
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  let html = '';

  if (!_calExpanded) {
    // ── WEEK MODE: render only the 7 days of the week containing the selected date ──
    const selParts = (_calSelectedDate || today).split('-');
    const selDate = new Date(parseInt(selParts[0]), parseInt(selParts[1]) - 1, parseInt(selParts[2]));
    // Find Monday of this week
    const monOffset = _dayToMonday(selDate.getDay());
    const monday = new Date(selDate);
    monday.setDate(monday.getDate() - monOffset);

    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const dStr = _fmtDate(d.getFullYear(), d.getMonth(), d.getDate());
      const isOther = d.getMonth() !== _calMonth || d.getFullYear() !== _calYear;
      html += _dayCell(dStr, d.getDate(), isOther);
    }

    gridEl.innerHTML = html;
    if (wrap) wrap.style.maxHeight = '52px';
  } else {
    // ── MONTH MODE: render full grid with prev/next month padding ──
    const firstOfMonth = new Date(_calYear, _calMonth, 1);
    const startOffset = _dayToMonday(firstOfMonth.getDay()); // how many padding days before 1st
    const daysInMonth = new Date(_calYear, _calMonth + 1, 0).getDate();
    const totalCells = startOffset + daysInMonth;
    const rows = Math.ceil(totalCells / 7);
    const totalSlots = rows * 7;

    // Previous month padding
    const prevMonthDays = new Date(_calYear, _calMonth, 0).getDate(); // last day of prev month
    for (let i = 0; i < startOffset; i++) {
      const pDay = prevMonthDays - startOffset + 1 + i;
      const pMonth = _calMonth - 1;
      const pYear = pMonth < 0 ? _calYear - 1 : _calYear;
      const pM = pMonth < 0 ? 11 : pMonth;
      html += _dayCell(_fmtDate(pYear, pM, pDay), pDay, true);
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      html += _dayCell(_fmtDate(_calYear, _calMonth, d), d, false);
    }

    // Next month padding
    const remaining = totalSlots - startOffset - daysInMonth;
    for (let i = 1; i <= remaining; i++) {
      const nMonth = _calMonth + 1;
      const nYear = nMonth > 11 ? _calYear + 1 : _calYear;
      const nM = nMonth > 11 ? 0 : nMonth;
      html += _dayCell(_fmtDate(nYear, nM, i), i, true);
    }

    gridEl.innerHTML = html;
    if (wrap) wrap.style.maxHeight = (rows * 52) + 'px';
  }

  _renderCalDayEvents();
  _initCalSwipe();
}

function _renderCalDayEvents() {
  const titleEl = document.getElementById('cal-day-events-title');
  const listEl = document.getElementById('cal-events-list');
  if (!titleEl || !listEl) return;

  const events = _calEventsForDate(_calSelectedDate);
  const today = _todayStr();

  // Format the date for the title: "May 31 Today" or "May 31"
  const parts = _calSelectedDate.split('-');
  const dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  const monthName = t(_CAL_MONTH_NAMES[dateObj.getMonth()]);
  const dayNum = dateObj.getDate();

  if (_calSelectedDate === today) {
    titleEl.innerHTML = monthName + ' ' + dayNum + ' <span class="cal-title-today">' + t('Today') + '</span>';
  } else {
    titleEl.textContent = monthName + ' ' + dayNum;
  }

  if (!events.length) {
    listEl.innerHTML = '<div class="cal-no-events">' + t('No events this day') + '</div>';
    return;
  }

  let html = '';
  for (const e of events) {
    const icon = _CAL_TYPE_ICONS[e.type] || '📌';
    const prClass = e.priority ? ' priority' : '';
    const timeStr = e.time ? '<span class="cal-event-time">' + e.time + '</span>' : '';
    const typeLabel = t(e.type ? e.type.charAt(0).toUpperCase() + e.type.slice(1) : 'Other');
    const byLabel = e.createdByName ? (' · ' + e.createdByName) : '';
    const notesHtml = e.notes ? '<div class="cal-event-notes">' + _escHtml(e.notes) + '</div>' : '';
    const prBadge = e.priority ? ' <span class="cal-event-priority-badge"></span>' : '';

    html += '<div class="cal-event-card' + prClass + '" onclick="editCalendarEvent(\'' + e._roomId + '\',\'' + e.id + '\')">'
      + '<div class="cal-event-icon">' + icon + '</div>'
      + '<div class="cal-event-body">'
      + '<div class="cal-event-title">' + _escHtml(e.title || t('Untitled')) + prBadge + '</div>'
      + '<div class="cal-event-meta">' + timeStr + '<span>' + typeLabel + byLabel + '</span></div>'
      + notesHtml
      + '</div>'
      + '</div>';
  }
  listEl.innerHTML = html;
}

function _escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function calSelectDate(dateStr) {
  _calSelectedDate = dateStr;
  // Update the month/year if user tapped a date in a different month
  const parts = dateStr.split('-');
  _calYear = parseInt(parts[0]);
  _calMonth = parseInt(parts[1]) - 1;
  renderCalendar();
}

function calPrevMonth() {
  _calMonth--;
  if (_calMonth < 0) { _calMonth = 11; _calYear--; }
  renderCalendar();
}

function calNextMonth() {
  _calMonth++;
  if (_calMonth > 11) { _calMonth = 0; _calYear++; }
  renderCalendar();
}

// ── Calendar Event Editor ──

let _calEditingEventId = null;
let _calEditingRoomId = null;
let _calEditorPriority = false;

function openCalendarEventEditor(roomId, eventId) {
  // Gate add/edit behind plus tier
  if (!_requireTier('calendar', 'plus')) return;

  _calEditingEventId = eventId || null;
  _calEditingRoomId = roomId || null;
  _calEditorPriority = false;

  const titleEl = document.getElementById('cal-editor-title');
  const titleInput = document.getElementById('cal-evt-title');
  const dateInput = document.getElementById('cal-evt-date');
  const timeInput = document.getElementById('cal-evt-time');
  const notesInput = document.getElementById('cal-evt-notes');
  const priorityBtn = document.getElementById('cal-evt-priority-btn');
  const deleteBtn = document.getElementById('cal-evt-delete-btn');

  // Reset type selector
  document.querySelectorAll('.cal-type-btn').forEach(b => b.classList.remove('selected'));
  document.querySelector('.cal-type-btn[data-type="appointment"]').classList.add('selected');

  if (_calEditingEventId && _calEditingRoomId) {
    // Editing existing event
    titleEl.textContent = t('Edit Event');
    const evt = (_calEvents[_calEditingRoomId] || {})[_calEditingEventId];
    if (evt) {
      titleInput.value = evt.title || '';
      dateInput.value = evt.date || _calSelectedDate;
      timeInput.value = evt.time || '';
      notesInput.value = evt.notes || '';
      _calEditorPriority = !!evt.priority;
      priorityBtn.textContent = _calEditorPriority ? t('On') : t('Off');
      // Set type
      if (evt.type) {
        document.querySelectorAll('.cal-type-btn').forEach(b => b.classList.remove('selected'));
        const typeBtn = document.querySelector('.cal-type-btn[data-type="' + evt.type + '"]');
        if (typeBtn) typeBtn.classList.add('selected');
      }
    }
    deleteBtn.style.display = '';
  } else {
    // New event
    titleEl.textContent = t('New Event');
    titleInput.value = '';
    dateInput.value = _calSelectedDate;
    timeInput.value = '';
    notesInput.value = '';
    _calEditorPriority = false;
    priorityBtn.textContent = t('Off');
    deleteBtn.style.display = 'none';
  }

  openSettingsSheet('sh-cal-event');
}

function closeCalendarEventEditor() {
  closeSettingsSheet('sh-cal-event');
  _calEditingEventId = null;
  _calEditingRoomId = null;
}

function calSelectType(btn) {
  document.querySelectorAll('.cal-type-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

function calTogglePriority() {
  _calEditorPriority = !_calEditorPriority;
  document.getElementById('cal-evt-priority-btn').textContent = _calEditorPriority ? t('On') : t('Off');
}

function _calGetSelectedType() {
  const sel = document.querySelector('.cal-type-btn.selected');
  return sel ? sel.dataset.type : 'other';
}

function _calPickRoom() {
  // For editing, use the event's room. For new events:
  // - Patient: use first room (or activeRoom)
  // - Carer: use activeRoom or first room
  // - Family: use activeRoom or first room
  if (_calEditingRoomId) return _calEditingRoomId;
  return S.activeRoom || S.rooms[0] || null;
}

async function saveCalendarEvent() {
  // Gate behind plus tier
  if (!_requireTier('calendar', 'plus')) return;

  const title = (document.getElementById('cal-evt-title').value || '').trim();
  if (!title) { toast(t('Please enter a title')); return; }

  const date = document.getElementById('cal-evt-date').value;
  if (!date) { toast(t('Please select a date')); return; }

  const time = document.getElementById('cal-evt-time').value || '';
  const type = _calGetSelectedType();
  const notes = (document.getElementById('cal-evt-notes').value || '').trim();

  const roomId = _calPickRoom();
  if (!roomId) { toast(t('No room available')); return; }

  const eventData = {
    title: title,
    date: date,
    time: time,
    type: type,
    notes: notes,
    priority: _calEditorPriority,
    createdBy: S.uid,
    createdByName: S.name || '',
    createdAt: firebase.database.ServerValue.TIMESTAMP
  };

  try {
    if (_calEditingEventId && _calEditingRoomId) {
      // Update existing
      await db.ref('carecall/rooms/' + _calEditingRoomId + '/calendar/' + _calEditingEventId).update(eventData);
      toast(t('Event updated'));
    } else {
      // Create new
      const newRef = db.ref('carecall/rooms/' + roomId + '/calendar').push();
      await newRef.set(eventData);
      toast(t('Event added'));
    }
    closeCalendarEventEditor();
    // Update selected date to the event date
    _calSelectedDate = date;
    const parts = date.split('-');
    _calYear = parseInt(parts[0]);
    _calMonth = parseInt(parts[1]) - 1;
    renderCalendar();
  } catch (e) {
    console.error('[Calendar] Save failed:', e);
    toast(t('Save failed'));
  }
}

function editCalendarEvent(roomId, eventId) {
  openCalendarEventEditor(roomId, eventId);
}

async function deleteCalendarEvent() {
  if (!_calEditingEventId || !_calEditingRoomId) return;
  if (!confirm(t('Delete this event?'))) return;

  try {
    await db.ref('carecall/rooms/' + _calEditingRoomId + '/calendar/' + _calEditingEventId).remove();
    toast(t('Event deleted'));
    closeCalendarEventEditor();
    renderCalendar();
  } catch (e) {
    console.error('[Calendar] Delete failed:', e);
    toast(t('Delete failed'));
  }
}

// ── Calendar Firebase listeners ──

function _startCalendarListeners() {
  _stopCalendarListeners();
  if (!S.rooms || !S.rooms.length) return;

  for (const roomId of S.rooms) {
    const ref = db.ref('carecall/rooms/' + roomId + '/calendar');
    ref.on('value', snap => {
      _calEvents[roomId] = snap.val() || {};
      // Re-render if calendar screen is visible
      const calScreen = document.getElementById('s-calendar');
      if (calScreen && calScreen.classList.contains('active')) {
        renderCalendar();
      }
    });
    _calListenerRefs.push(ref);
  }
}

function _stopCalendarListeners() {
  for (const ref of _calListenerRefs) {
    try { ref.off(); } catch (_) {}
  }
  _calListenerRefs = [];
  _calEvents = {};
}

// ════════════════════════════════════════════════════════════
//  DOCUMENT VAULT — Secure document storage for care documents
// ════════════════════════════════════════════════════════════
let _documents = {};          // { docId: docData }
let _docListenerRefs = [];    // Firebase listener refs
let _docFilter = 'all';       // current category filter
let _docPendingFile = null;   // { data: base64, mimeType: string, originalSize: number }
let _viewingDocId = null;     // currently viewed document id
let _viewingDocRoomId = null; // room id for currently viewed document

const DOC_CATEGORY_ICONS = {
  insurance: '🏥', medical: '🩺', legal: '⚖️', prescription: '💊', other: '📎'
};

function openDocumentsSheet() {
  if (!_requireTier('documents', 'plus')) return;
  renderDocumentsList();
  openSettingsSheet('sh-documents');
  _startDocumentListeners();
}

function _startDocumentListeners() {
  _stopDocumentListeners();
  if (!db || !S.rooms || S.rooms.length === 0) return;
  for (const roomId of S.rooms) {
    const ref = db.ref('carecall/rooms/' + roomId + '/documents');
    ref.on('value', snap => {
      const docs = snap.val() || {};
      // Merge into _documents with roomId prefix
      Object.keys(_documents).forEach(k => {
        if (k.startsWith(roomId + '/')) delete _documents[k];
      });
      Object.entries(docs).forEach(([docId, docData]) => {
        _documents[roomId + '/' + docId] = { ...docData, id: docId, roomId };
      });
      renderDocumentsList();
    });
    _docListenerRefs.push(ref);
  }
}

function _stopDocumentListeners() {
  for (const ref of _docListenerRefs) {
    try { ref.off(); } catch (_) {}
  }
  _docListenerRefs = [];
  _documents = {};
}

function renderDocumentsList() {
  const container = document.getElementById('doc-list');
  if (!container) return;

  // Collect and sort documents
  const docs = Object.values(_documents)
    .filter(d => _docFilter === 'all' || d.category === _docFilter)
    .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));

  if (docs.length === 0) {
    container.innerHTML = '<div class="doc-empty">' + t('No documents yet') + '</div>';
    return;
  }

  let html = '';
  for (const doc of docs) {
    const icon = DOC_CATEGORY_ICONS[doc.category] || '📎';
    const catClass = doc.category || 'other';
    const date = doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleDateString() : '';
    const meta = (doc.uploadedByName || '') + (date ? ' · ' + date : '');
    html += `<div class="doc-card" onclick="viewDocument('${doc.roomId}','${doc.id}')">
      <div class="doc-card-icon ${catClass}">${icon}</div>
      <div class="doc-card-info">
        <div class="doc-card-name">${escHtml(doc.name || 'Untitled')}</div>
        <div class="doc-card-meta">${escHtml(meta)}</div>
      </div>
      <div class="doc-card-arrow">›</div>
    </div>`;
  }
  container.innerHTML = html;
}

function filterDocuments(cat, btn) {
  _docFilter = cat;
  // Update pill UI
  document.querySelectorAll('#doc-category-pills .doc-pill').forEach(p => p.classList.remove('selected'));
  if (btn) btn.classList.add('selected');
  renderDocumentsList();
}

function openAddDocumentModal() {
  // Reset form
  const nameInput = document.getElementById('doc-name-input');
  const notesInput = document.getElementById('doc-notes-input');
  const fileInput = document.getElementById('doc-file-input');
  const errEl = document.getElementById('doc-err');
  const previewEl = document.getElementById('doc-file-preview');
  const placeholderEl = document.getElementById('doc-file-placeholder');
  const fileInfoEl = document.getElementById('doc-file-info');
  if (nameInput) nameInput.value = '';
  if (notesInput) notesInput.value = '';
  if (fileInput) fileInput.value = '';
  if (errEl) errEl.textContent = '';
  if (previewEl) { previewEl.style.display = 'none'; previewEl.innerHTML = ''; }
  if (placeholderEl) placeholderEl.style.display = '';
  if (fileInfoEl) fileInfoEl.style.display = 'none';
  _docPendingFile = null;

  // Reset category to first
  document.querySelectorAll('#doc-category-selector .doc-cat-btn').forEach((b, i) => {
    b.classList.toggle('selected', i === 0);
  });

  openSettingsSheet('sh-doc-add');
}

function docSelectCategory(btn) {
  document.querySelectorAll('#doc-category-selector .doc-cat-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

function handleDocFileSelect(input) {
  const file = input.files && input.files[0];
  if (!file) return;

  const errEl = document.getElementById('doc-err');
  const previewEl = document.getElementById('doc-file-preview');
  const placeholderEl = document.getElementById('doc-file-placeholder');
  const fileInfoEl = document.getElementById('doc-file-info');
  if (errEl) errEl.textContent = '';

  const isPDF = file.type === 'application/pdf';
  const isImage = file.type.startsWith('image/');

  if (!isPDF && !isImage) {
    if (errEl) errEl.textContent = 'Only images and PDFs are supported';
    return;
  }

  if (isImage) {
    // Compress images to max 800x800, quality 0.7
    _compressDocImage(file, 800, 800, 0.7, (dataUrl) => {
      if (!dataUrl) {
        if (errEl) errEl.textContent = t('Could not read image');
        return;
      }
      // Check size after encoding
      const base64Data = dataUrl.split(',')[1] || '';
      const sizeBytes = base64Data.length * 0.75;
      if (sizeBytes > 2 * 1024 * 1024) {
        if (errEl) errEl.textContent = t('File too large (max 2MB)');
        return;
      }
      _docPendingFile = { data: dataUrl, mimeType: 'image/jpeg' };
      if (previewEl) {
        previewEl.innerHTML = '<img src="' + dataUrl + '" alt="preview">';
        previewEl.style.display = '';
      }
      if (placeholderEl) placeholderEl.style.display = 'none';
      if (fileInfoEl) {
        fileInfoEl.textContent = _formatFileSize(sizeBytes);
        fileInfoEl.style.display = '';
      }
    });
  } else {
    // PDF — read as base64 directly
    const reader = new FileReader();
    reader.onload = function(e) {
      const dataUrl = e.target.result;
      const base64Data = dataUrl.split(',')[1] || '';
      const sizeBytes = base64Data.length * 0.75;
      if (sizeBytes > 2 * 1024 * 1024) {
        if (errEl) errEl.textContent = t('File too large (max 2MB)');
        return;
      }
      _docPendingFile = { data: dataUrl, mimeType: 'application/pdf' };
      if (previewEl) {
        previewEl.innerHTML = '<div class="pdf-badge">📄 PDF — ' + _formatFileSize(sizeBytes) + '</div>';
        previewEl.style.display = '';
      }
      if (placeholderEl) placeholderEl.style.display = 'none';
      if (fileInfoEl) {
        fileInfoEl.textContent = _formatFileSize(sizeBytes);
        fileInfoEl.style.display = '';
      }
    };
    reader.onerror = function() {
      if (errEl) errEl.textContent = t('Could not read image');
    };
    reader.readAsDataURL(file);
  }
}

function _compressDocImage(file, maxW, maxH, quality, callback) {
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxW || h > maxH) {
        const ratio = Math.min(maxW / w, maxH / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      callback(dataUrl);
    };
    img.onerror = function() { callback(null); };
    img.src = e.target.result;
  };
  reader.onerror = function() { callback(null); };
  reader.readAsDataURL(file);
}

function _formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function saveDocument() {
  const errEl = document.getElementById('doc-err');
  const nameInput = document.getElementById('doc-name-input');
  const notesInput = document.getElementById('doc-notes-input');
  const name = (nameInput && nameInput.value || '').trim();
  const notes = (notesInput && notesInput.value || '').trim();

  if (!name) {
    if (errEl) errEl.textContent = t('Please enter a document name');
    return;
  }
  if (!_docPendingFile) {
    if (errEl) errEl.textContent = t('Please select a file');
    return;
  }

  // Get selected category
  const selectedCat = document.querySelector('#doc-category-selector .doc-cat-btn.selected');
  const category = selectedCat ? selectedCat.dataset.cat : 'other';

  // Pick the first room (or activeRoom)
  const roomId = S.activeRoom || (S.rooms && S.rooms[0]);
  if (!roomId || !db) {
    if (errEl) errEl.textContent = 'Not connected to a room';
    return;
  }

  if (errEl) errEl.textContent = t('Saving document…');

  try {
    const docRef = db.ref('carecall/rooms/' + roomId + '/documents').push();
    const docData = {
      id: docRef.key,
      name: name,
      category: category,
      data: _docPendingFile.data,
      mimeType: _docPendingFile.mimeType,
      uploadedBy: S.uid,
      uploadedByName: S.name || 'Unknown',
      uploadedAt: firebase.database.ServerValue.TIMESTAMP,
      notes: notes
    };
    await docRef.set(docData);

    _docPendingFile = null;
    closeSettingsSheet('sh-doc-add');
    toast(t('Document saved'));
  } catch (e) {
    console.error('[Documents] save error:', e);
    if (errEl) errEl.textContent = t('Save failed');
  }
}

function viewDocument(roomId, docId) {
  const key = roomId + '/' + docId;
  const doc = _documents[key];
  if (!doc) return;

  _viewingDocId = docId;
  _viewingDocRoomId = roomId;

  const overlay = document.getElementById('doc-viewer-overlay');
  const titleEl = document.getElementById('doc-viewer-title');
  const bodyEl = document.getElementById('doc-viewer-body');
  const metaEl = document.getElementById('doc-viewer-meta');
  const deleteBtn = document.getElementById('doc-viewer-delete');

  if (titleEl) titleEl.textContent = doc.name || 'Document';

  // Show delete button only for uploader or carers
  if (deleteBtn) {
    const canDelete = doc.uploadedBy === S.uid || S.role === 'carer';
    deleteBtn.style.display = canDelete ? '' : 'none';
  }

  // Render body
  if (bodyEl) {
    if (doc.mimeType === 'application/pdf') {
      bodyEl.innerHTML = `<div class="pdf-open-link">
        <div class="pdf-icon">📄</div>
        <div style="font-size:1.1rem;font-weight:600;color:#1A202C;margin-bottom:4px">${escHtml(doc.name)}</div>
        <a href="${doc.data}" download="${escHtml(doc.name)}.pdf">${t('Download PDF')}</a>
      </div>`;
    } else {
      bodyEl.innerHTML = '<img src="' + doc.data + '" alt="' + escHtml(doc.name) + '">';
    }
  }

  // Render meta
  if (metaEl) {
    const date = doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleString() : '';
    const catLabel = doc.category ? (DOC_CATEGORY_ICONS[doc.category] || '') + ' ' + t(doc.category.charAt(0).toUpperCase() + doc.category.slice(1)) : '';
    let html = '';
    html += '<div class="doc-meta-row"><strong>' + t('Uploaded by') + ':</strong> ' + escHtml(doc.uploadedByName || 'Unknown') + '</div>';
    if (date) html += '<div class="doc-meta-row"><strong>' + t('Date') + ':</strong> ' + date + '</div>';
    if (catLabel) html += '<div class="doc-meta-row"><strong>' + t('Category') + ':</strong> ' + catLabel + '</div>';
    if (doc.notes) html += '<div class="doc-notes">' + escHtml(doc.notes) + '</div>';
    metaEl.innerHTML = html;
  }

  if (overlay) {
    overlay.classList.add('open');
    overlay.onclick = (e) => { if (e.target === overlay) closeDocViewer(); };
  }
}

function closeDocViewer() {
  const overlay = document.getElementById('doc-viewer-overlay');
  if (overlay) overlay.classList.remove('open');
  _viewingDocId = null;
  _viewingDocRoomId = null;
}

async function deleteDocument() {
  if (!_viewingDocId || !_viewingDocRoomId) return;

  const doc = _documents[_viewingDocRoomId + '/' + _viewingDocId];
  // Confirm
  const docName = doc ? doc.name : 'this document';
  if (!confirm(t('Delete this document?') + '\n' + docName)) return;

  try {
    await db.ref('carecall/rooms/' + _viewingDocRoomId + '/documents/' + _viewingDocId).remove();
    closeDocViewer();
    toast(t('Document deleted'));
  } catch (e) {
    console.error('[Documents] delete error:', e);
    toast(t('Save failed'));
  }
}

// ════════════════════════════════════════════════════════════
//  HEALTH MEASUREMENT TRACKING
// ════════════════════════════════════════════════════════════
let _healthEntries = {};       // { compositeKey: entryData }
let _healthListenerRefs = [];  // Firebase listener refs
let _healthInputType = null;   // currently open input type
let _healthTempUnit = 'F';     // temperature unit toggle

const HEALTH_TYPES = {
  bp:     { icon: '\u{1FA78}', name: 'Blood Pressure', unit: 'mmHg' },
  hr:     { icon: '❤️', name: 'Heart Rate', unit: 'bpm' },
  sugar:  { icon: '\u{1F36C}', name: 'Blood Sugar', unit: 'mg/dL' },
  temp:   { icon: '\u{1F321}️', name: 'Temperature', unit: '°F' },
  weight: { icon: '⚖️', name: 'Weight', unit: 'kg' },
  o2:     { icon: '\u{1F4A8}', name: 'Oxygen Saturation', unit: '%' },
  pain:   { icon: '\u{1F623}', name: 'Pain Level', unit: '/10' },
  mood:   { icon: '\u{1F60A}', name: 'Mood', unit: '' },
};

function openHealthSheet() {
  if (!_requireTier('health_tracking', 'plus')) return;
  renderHealthEntries();
  openSettingsSheet('sh-health');
  _startHealthListeners();
}

function _startHealthListeners() {
  _stopHealthListeners();
  if (!db || !S.rooms || S.rooms.length === 0) return;
  for (const roomId of S.rooms) {
    const ref = db.ref('carecall/rooms/' + roomId + '/vitals').orderByChild('recordedAt').limitToLast(100);
    ref.on('value', snap => {
      const entries = snap.val() || {};
      // Remove old entries for this room
      Object.keys(_healthEntries).forEach(k => {
        if (k.startsWith(roomId + '/')) delete _healthEntries[k];
      });
      Object.entries(entries).forEach(([entryId, data]) => {
        _healthEntries[roomId + '/' + entryId] = { ...data, id: entryId, roomId };
      });
      renderHealthEntries();
      _updateVitalsStatusCard();
    });
    _healthListenerRefs.push(ref);
  }
}

function _stopHealthListeners() {
  for (const ref of _healthListenerRefs) {
    try { ref.off(); } catch (_) {}
  }
  _healthListenerRefs = [];
  _healthEntries = {};
}

function renderHealthEntries() {
  const container = document.getElementById('health-entries-list');
  if (!container) return;

  const entries = Object.values(_healthEntries)
    .sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0));

  if (entries.length === 0) {
    container.innerHTML = '<div class="health-empty">' + t('No health entries yet') + '</div>';
    return;
  }

  // Group by date
  const groups = {};
  for (const entry of entries) {
    const dateKey = entry.date || new Date(entry.recordedAt).toISOString().slice(0, 10);
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(entry);
  }

  let html = '';
  const sortedDates = Object.keys(groups).sort().reverse();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  for (const dateKey of sortedDates) {
    let dateLabel = dateKey;
    if (dateKey === today) dateLabel = t('Today');
    else if (dateKey === yesterday) dateLabel = t('Yesterday');
    else dateLabel = new Date(dateKey + 'T12:00:00').toLocaleDateString();

    html += '<div class="health-date-group">';
    html += '<div class="health-date-label">' + escHtml(dateLabel) + '</div>';

    for (const entry of groups[dateKey]) {
      const ht = HEALTH_TYPES[entry.type] || { icon: '❤️', name: entry.type, unit: '' };
      const timeStr = entry.recordedAt ? new Date(entry.recordedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const who = entry.recordedByName || '';
      const metaParts = [timeStr, who].filter(Boolean).join(' · ');
      const displayVal = entry.type === 'mood' ? entry.value : escHtml(String(entry.value));
      const notes = entry.notes ? ' — ' + escHtml(entry.notes) : '';

      html += '<div class="health-entry-row">';
      html += '  <div class="health-entry-icon">' + ht.icon + '</div>';
      html += '  <div class="health-entry-info">';
      html += '    <div class="health-entry-value">' + displayVal + (entry.unit ? ' <span class="health-entry-unit">' + escHtml(entry.unit) + '</span>' : '') + notes + '</div>';
      html += '    <div class="health-entry-meta">' + escHtml(metaParts) + '</div>';
      html += '  </div>';
      html += '</div>';
    }
    html += '</div>';
  }
  container.innerHTML = html;
}

function openHealthInput(type) {
  _healthInputType = type;
  const ht = HEALTH_TYPES[type];
  if (!ht) return;

  const modal = document.getElementById('health-input-modal');
  const iconEl = document.getElementById('health-input-icon');
  const nameEl = document.getElementById('health-input-name');
  const bodyEl = document.getElementById('health-input-body');
  const notesEl = document.getElementById('health-notes-input');
  const errEl = document.getElementById('health-input-err');

  if (iconEl) iconEl.textContent = ht.icon;
  if (nameEl) nameEl.textContent = t(ht.name);
  if (notesEl) notesEl.value = '';
  if (errEl) errEl.textContent = '';

  let inputHtml = '';

  switch (type) {
    case 'bp':
      inputHtml = `
        <div class="health-bp-row">
          <input class="text-input" id="health-bp-sys" type="number" inputmode="numeric" placeholder="${t('Systolic')}" min="50" max="300" style="font-size:1.2rem;text-align:center">
          <div class="health-bp-slash">/</div>
          <input class="text-input" id="health-bp-dia" type="number" inputmode="numeric" placeholder="${t('Diastolic')}" min="20" max="200" style="font-size:1.2rem;text-align:center">
        </div>
        <div class="health-unit-label" style="text-align:center">mmHg</div>`;
      break;

    case 'hr':
      inputHtml = `
        <div class="health-number-row">
          <input class="text-input" id="health-hr-val" type="number" inputmode="numeric" placeholder="72" min="20" max="300" style="font-size:1.2rem">
          <div class="health-unit-label">bpm</div>
        </div>`;
      break;

    case 'sugar':
      inputHtml = `
        <div class="health-number-row">
          <input class="text-input" id="health-sugar-val" type="number" inputmode="numeric" placeholder="110" min="20" max="600" style="font-size:1.2rem">
          <div class="health-unit-label">mg/dL</div>
        </div>`;
      break;

    case 'temp':
      inputHtml = `
        <div class="health-number-row">
          <input class="text-input" id="health-temp-val" type="number" inputmode="decimal" placeholder="${_healthTempUnit === 'F' ? '98.6' : '37.0'}" min="85" max="115" step="0.1" style="font-size:1.2rem">
          <div class="health-temp-toggle">
            <button class="health-temp-btn ${_healthTempUnit === 'F' ? 'selected' : ''}" onclick="_setHealthTempUnit('F')">°F</button>
            <button class="health-temp-btn ${_healthTempUnit === 'C' ? 'selected' : ''}" onclick="_setHealthTempUnit('C')">°C</button>
          </div>
        </div>`;
      break;

    case 'weight':
      inputHtml = `
        <div class="health-number-row">
          <input class="text-input" id="health-weight-val" type="number" inputmode="decimal" placeholder="70" min="10" max="500" step="0.1" style="font-size:1.2rem">
          <div class="health-unit-label">kg</div>
        </div>`;
      break;

    case 'o2':
      inputHtml = `
        <div class="health-number-row">
          <input class="text-input" id="health-o2-val" type="number" inputmode="numeric" placeholder="97" min="50" max="100" style="font-size:1.2rem">
          <div class="health-unit-label">%</div>
        </div>`;
      break;

    case 'pain': {
      let painBtns = '';
      for (let i = 1; i <= 10; i++) {
        painBtns += `<button class="health-pain-btn" data-val="${i}" onclick="_selectHealthPain(${i})">${i}</button>`;
      }
      inputHtml = `<div class="health-pain-row">${painBtns}</div>`;
      break;
    }

    case 'mood': {
      const moods = ['\u{1F60A}', '\u{1F610}', '\u{1F61F}', '\u{1F622}', '\u{1F621}'];
      let moodBtns = '';
      for (const m of moods) {
        moodBtns += `<button class="health-mood-btn" data-val="${m}" onclick="_selectHealthMood(this)">${m}</button>`;
      }
      inputHtml = `<div class="health-mood-row">${moodBtns}</div>`;
      break;
    }
  }

  if (bodyEl) bodyEl.innerHTML = inputHtml;
  if (modal) {
    modal.style.display = '';
    modal.onclick = (e) => { if (e.target === modal) closeHealthInput(); };
  }
}

function closeHealthInput() {
  const modal = document.getElementById('health-input-modal');
  if (modal) modal.style.display = 'none';
  _healthInputType = null;
}

function _setHealthTempUnit(unit) {
  _healthTempUnit = unit;
  document.querySelectorAll('.health-temp-btn').forEach(b => {
    b.classList.toggle('selected', b.textContent.includes(unit));
  });
  const inp = document.getElementById('health-temp-val');
  if (inp) inp.placeholder = unit === 'F' ? '98.6' : '37.0';
}

function _selectHealthPain(val) {
  document.querySelectorAll('.health-pain-btn').forEach(b => {
    b.classList.toggle('selected', parseInt(b.dataset.val) === val);
  });
}

function _selectHealthMood(btn) {
  document.querySelectorAll('.health-mood-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

async function saveHealthEntry() {
  const type = _healthInputType;
  if (!type) return;
  const errEl = document.getElementById('health-input-err');
  if (errEl) errEl.textContent = '';

  let value, unit;

  switch (type) {
    case 'bp': {
      const sys = parseInt(document.getElementById('health-bp-sys')?.value);
      const dia = parseInt(document.getElementById('health-bp-dia')?.value);
      if (!sys || !dia || sys < 50 || sys > 300 || dia < 20 || dia > 200) {
        if (errEl) errEl.textContent = t('Enter valid blood pressure values');
        return;
      }
      value = sys + '/' + dia;
      unit = 'mmHg';
      break;
    }
    case 'hr': {
      const v = parseInt(document.getElementById('health-hr-val')?.value);
      if (!v || v < 20 || v > 300) {
        if (errEl) errEl.textContent = t('Enter a valid heart rate');
        return;
      }
      value = v;
      unit = 'bpm';
      break;
    }
    case 'sugar': {
      const v = parseInt(document.getElementById('health-sugar-val')?.value);
      if (!v || v < 20 || v > 600) {
        if (errEl) errEl.textContent = t('Enter a valid blood sugar value');
        return;
      }
      value = v;
      unit = 'mg/dL';
      break;
    }
    case 'temp': {
      const v = parseFloat(document.getElementById('health-temp-val')?.value);
      if (!v || v < 85 || v > 115) {
        if (errEl) errEl.textContent = t('Enter a valid temperature');
        return;
      }
      value = v;
      unit = _healthTempUnit === 'C' ? '°C' : '°F';
      break;
    }
    case 'weight': {
      const v = parseFloat(document.getElementById('health-weight-val')?.value);
      if (!v || v < 10 || v > 500) {
        if (errEl) errEl.textContent = t('Enter a valid weight');
        return;
      }
      value = v;
      unit = 'kg';
      break;
    }
    case 'o2': {
      const v = parseInt(document.getElementById('health-o2-val')?.value);
      if (!v || v < 50 || v > 100) {
        if (errEl) errEl.textContent = t('Enter a valid oxygen saturation');
        return;
      }
      value = v;
      unit = '%';
      break;
    }
    case 'pain': {
      const selected = document.querySelector('.health-pain-btn.selected');
      if (!selected) {
        if (errEl) errEl.textContent = t('Select a pain level');
        return;
      }
      value = parseInt(selected.dataset.val);
      unit = '/10';
      break;
    }
    case 'mood': {
      const selected = document.querySelector('.health-mood-btn.selected');
      if (!selected) {
        if (errEl) errEl.textContent = t('Select a mood');
        return;
      }
      value = selected.dataset.val;
      unit = '';
      break;
    }
    default: return;
  }

  const notes = (document.getElementById('health-notes-input')?.value || '').trim();
  const now = Date.now();
  const dateStr = new Date().toISOString().slice(0, 10);

  const entry = {
    type,
    value,
    unit,
    notes: notes || '',
    recordedBy: S.uid,
    recordedByName: S.name || '',
    recordedAt: now,
    date: dateStr,
  };

  try {
    // Save to all connected rooms
    for (const roomId of S.rooms) {
      const ref = db.ref('carecall/rooms/' + roomId + '/vitals').push();
      entry.id = ref.key;
      await ref.set(entry);
    }
    closeHealthInput();
    toast(t('Measurement saved'));
  } catch (e) {
    console.error('[Health] save error:', e);
    if (errEl) errEl.textContent = t('Save failed');
  }
}

function _updateVitalsStatusCard() {
  const card = document.getElementById('sc-vitals');
  const valEl = document.getElementById('sc-vitals-val');
  if (!card || !valEl) return;

  const entries = Object.values(_healthEntries)
    .sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0));

  // Find latest BP or HR
  const latestBp = entries.find(e => e.type === 'bp');
  const latestHr = entries.find(e => e.type === 'hr');

  if (latestBp || latestHr) {
    card.style.display = '';
    const parts = [];
    if (latestBp) parts.push(latestBp.value + '');
    if (latestHr) parts.push(latestHr.value + ' bpm');
    valEl.textContent = parts.join(' | ');
  } else if (entries.length > 0) {
    // Show whatever latest measurement exists
    card.style.display = '';
    const latest = entries[0];
    const ht = HEALTH_TYPES[latest.type] || {};
    valEl.textContent = latest.value + (latest.unit ? ' ' + latest.unit : '');
  } else {
    card.style.display = 'none';
  }
}

// ── Expose all functions on window for onclick handlers ──
window.loadScript = loadScript;
window.loadCSS = loadCSS;
window._registerTick = _registerTick;
window._unregisterTick = _unregisterTick;
window._runTick = _runTick;
window.isFirebaseConfigured = isFirebaseConfigured;
window.initFirebase = initFirebase;
window._teardownAllListeners = _teardownAllListeners;
window.saveState = saveState;
window.loadState = loadState;
window._getRecorderMimeType = _getRecorderMimeType;
window._voiceNoteDown = _voiceNoteDown;
window._voiceNoteUp = _voiceNoteUp;
window.playVoiceNote = playVoiceNote;
window.clearVoiceNote = clearVoiceNote;
window.playAlertVoiceNote = playAlertVoiceNote;
window.toggleDictation = toggleDictation;
window._startDictation = _startDictation;
window._startWebDictation = _startWebDictation;
window._stopDictation = _stopDictation;
window.playCallVoiceNote = playCallVoiceNote;
window.toggleFallMonitoring = toggleFallMonitoring;
window.startFallMonitoring = startFallMonitoring;
window.stopFallMonitoring = stopFallMonitoring;
window.cycleFallSensitivity = cycleFallSensitivity;
window._updateSensitivityLabel = _updateSensitivityLabel;
window._onDeviceMotion = _onDeviceMotion;
window._findFreeFall = _findFreeFall;
window._findImpact = _findImpact;
window._findRecentImpact = _findRecentImpact;
window._checkStillness = _checkStillness;
window._checkOrientationChange = _checkOrientationChange;
window._onFallDetected = _onFallDetected;
window._emergencyDown = _emergencyDown;
window._emergencyUp = _emergencyUp;
window._animateEmergencyRing = _animateEmergencyRing;
window._cancelEmergencyAnim = _cancelEmergencyAnim;
window.cancelFallAlert = cancelFallAlert;
window._sendFallCall = _sendFallCall;
window.genCode = genCode;
window.toast = toast;
window.timeAgo = timeAgo;
window.needLabel = needLabel;
window.unlockAudio = unlockAudio;
window.playBell = playBell;
window.startBell = startBell;
window.stopBell = stopBell;
window.showScreen = showScreen;
window._homeScreen = _homeScreen;
window.goBack = goBack;
window.setupChooseRole = setupChooseRole;
window.setupSaveName = setupSaveName;
window._setupPostAuth = _setupPostAuth;
window._authSwitchTab = _authSwitchTab;
window._authPasswordStrength = _authPasswordStrength;
window._authSubmit = _authSubmit;
window._authErrorMessage = _authErrorMessage;
window._authForgotPassword = _authForgotPassword;
window.signOut = signOut;
window._toggleCodeReveal = _toggleCodeReveal;
window._copyPersonalCode = _copyPersonalCode;
window._getPinHash = _getPinHash;
window._hashPin = _hashPin;
window._isPinLocked = _isPinLocked;
window._showPinOverlay = _showPinOverlay;
window._setupPin = _setupPin;
window._removePin = _removePin;
window._pinForgot = _pinForgot;
window.setupConnect = setupConnect;
window.setupSkipConnect = setupSkipConnect;
window.finishSetup = finishSetup;
window.joinAllRooms = joinAllRooms;
window.joinRoom = joinRoom;
window.leaveRoom = leaveRoom;
window.syncUserProfile = syncUserProfile;
window.lookupUserByCode = lookupUserByCode;
window.findOrCreateRoom = findOrCreateRoom;
window.connectToCode = connectToCode;
window._connectToCodeInner = _connectToCodeInner;
window._subscribePendingPairs = _subscribePendingPairs;
window._showPairRequestPrompt = _showPairRequestPrompt;
window.approvePairRequest = approvePairRequest;
window.rejectPairRequest = rejectPairRequest;
window._showPairingSuccessBanner = _showPairingSuccessBanner;
window._subscribeSentPair = _subscribeSentPair;
window._onPairApproved = _onPairApproved;
window._onPairRejected = _onPairRejected;
window._rehydrateSentPairs = _rehydrateSentPairs;
window._ensureFcmTokenInRoom = _ensureFcmTokenInRoom;
window._saveUserRooms = _saveUserRooms;
window._dedupRooms = _dedupRooms;
window._renderSettingsConnections = _renderSettingsConnections;
window._refreshSettingsConnectionsIfVisible = _refreshSettingsConnectionsIfVisible;
window.launchMainScreen = launchMainScreen;
window._showAnonAuthBannerIfNeeded = _showAnonAuthBannerIfNeeded;
window.startPatient = startPatient;
window._rebuildPatientCarerList = _rebuildPatientCarerList;
window._rebuildPatientCarerListNow = _rebuildPatientCarerListNow;
window.setPatientStatus = setPatientStatus;
window.selectNeed = selectNeed;
window.openNeedsSheet = openNeedsSheet;
window.closeNeedsSheet = closeNeedsSheet;
window._selectCarer = _selectCarer;
window._showOfflineCallWarning = _showOfflineCallWarning;
window._renderOfflineFallback = _renderOfflineFallback;
window.toggleRoomDropdown = toggleRoomDropdown;
window.renderRoomDropdown = renderRoomDropdown;
window.patientCallMain = patientCallMain;
window._sortByCarerPriority = _sortByCarerPriority;
window._getCarersByPriority = _getCarersByPriority;
window._sendToEscalationTier = _sendToEscalationTier;
window._clearEscalation = _clearEscalation;
window._setCallFinalTimeout = _setCallFinalTimeout;
window.watchForAck = watchForAck;
window.showPatientAck = showPatientAck;
window.dismissAckOverlay = dismissAckOverlay;
window._expandFamilyRooms = _expandFamilyRooms;
window._startFamilyListeners = _startFamilyListeners;
window.toggleTempCarer = toggleTempCarer;
window._activateTempCarer = _activateTempCarer;
window._deactivateTempCarer = _deactivateTempCarer;
window._updateTempCarerUI = _updateTempCarerUI;
window._showTempCarerToggleIfFamily = _showTempCarerToggleIfFamily;
window._restoreTempCarerOnBoot = _restoreTempCarerOnBoot;
window.setAvailability = setAvailability;
window.startCarer = startCarer;
window.checkForMissedCalls = checkForMissedCalls;
window.renderMembers = renderMembers;
window.updateCarerOrb = updateCarerOrb;
window.addActiveCall = addActiveCall;
window.updateCallCard = updateCallCard;
window.removeCallCard = removeCallCard;
window.renderCallCards = renderCallCards;
window.showIncomingAlert = showIncomingAlert;
window.dismissAlert = dismissAlert;
window.acknowledgeCall = acknowledgeCall;
window.acknowledgeFromAlert = acknowledgeFromAlert;
window.refreshLog = refreshLog;
window.buildLogFilters = buildLogFilters;
window.setLogFilter = setLogFilter;
window.renderLogEntries = renderLogEntries;
window._renderMedChartsInLog = _renderMedChartsInLog;
window._renderFamilyMedsList = _renderFamilyMedsList;
window._medLabelForEvent = _medLabelForEvent;
window._renderAdherenceSvg = _renderAdherenceSvg;
window._renderMostMissed = _renderMostMissed;
window._renderWellnessScore = _renderWellnessScore;
window._renderInsights = _renderInsights;
window._generateInsights = _generateInsights;
window.formatDuration = formatDuration;
window.exportLogCSV = exportLogCSV;
window.refreshSettings = refreshSettings;
window._moveCarerPriority = _moveCarerPriority;
window._moveCarerPriorityByUid = _moveCarerPriorityByUid;
window.addConnectionFromSettings = addConnectionFromSettings;
window.removeConnection = removeConnection;
window.refreshNotifStatus = refreshNotifStatus;
window.testNotification = testNotification;
window.editName = editName;
window.editPhone = editPhone;
window.toggleSettingsGroup = toggleSettingsGroup;
window.openSettingsSheet = openSettingsSheet;
window.closeSettingsSheet = closeSettingsSheet;
window._syncSettingsToggles = _syncSettingsToggles;
window._hasTierFeature = _hasTierFeature;
window._requireTier = _requireTier;
window._filterSettings = _filterSettings;
window.toggleAvatarPicker = toggleAvatarPicker;
window._renderAvatarOptions = _renderAvatarOptions;
window._selectAvatar = _selectAvatar;
window.resetApp = resetApp;
window.escHtml = escHtml;
window.t = t;
window.toggleA11y = toggleA11y;
window._loadA11y = _loadA11y;
window._refreshA11yButtons = _refreshA11yButtons;
window.selectLanguage = selectLanguage;
window._updateLangDisplay = _updateLangDisplay;
window.showLanguageModal = showLanguageModal;
window.applyTranslations = applyTranslations;
window.boot = boot;
window._firstInteraction = _firstInteraction;
window._loadCheckinSettings = _loadCheckinSettings;
window._saveCheckinSettings = _saveCheckinSettings;
window.startCheckinSchedule = startCheckinSchedule;
window.stopCheckinSchedule = stopCheckinSchedule;
window._scheduleNextCheckin = _scheduleNextCheckin;
window._showCheckinPrompt = _showCheckinPrompt;
window.respondCheckin = respondCheckin;
window._sendCheckinAlert = _sendCheckinAlert;
window.cycleCheckinInterval = cycleCheckinInterval;
window.cycleCheckinStart = cycleCheckinStart;
window.cycleCheckinEnd = cycleCheckinEnd;
window.cycleCheckinTimeout = cycleCheckinTimeout;
window._refreshCheckinSettingsUI = _refreshCheckinSettingsUI;
window._formatHour = _formatHour;
window._loadDmsSettings = _loadDmsSettings;
window.cycleDmsThreshold = cycleDmsThreshold;
window._resetDmsActivity = _resetDmsActivity;
window._startDmsMonitor = _startDmsMonitor;
window._handoffSnapshot = _handoffSnapshot;
window.showHandoffPrompt = showHandoffPrompt;
window._toggleHandoffStatus = _toggleHandoffStatus;
window._submitHandoff = _submitHandoff;
window._checkHandoffNote = _checkHandoffNote;
window._renderHandoffBanner = _renderHandoffBanner;
window._ackHandoffNote = _ackHandoffNote;
window._replyHandoff = _replyHandoff;
window._fetchHandoffNotes = _fetchHandoffNotes;
window.showQrCode = showQrCode;
window._parseQrPayload = _parseQrPayload;
window.openQrScanner = openQrScanner;
window.closeQrScanner = closeQrScanner;
window._onQrScanSuccess = _onQrScanSuccess;
window._handleDeepLinkCode = _handleDeepLinkCode;
window._buildEmergencyMessage = _buildEmergencyMessage;
window._getEmergencyInfo = _getEmergencyInfo;
window._saveEmergencyInfo = _saveEmergencyInfo;
window._migrateEmergencyInfo = _migrateEmergencyInfo;
window._emergencyMedLines = _emergencyMedLines;
window._telLink = _telLink;
window._toIsoDate = _toIsoDate;
window.showEmergencyCard = showEmergencyCard;
window._appendEiValue = _appendEiValue;
window._saveEiFromModal = _saveEiFromModal;
window._addEiField = _addEiField;
window._removeEiField = _removeEiField;
window._emergencyCardText = _emergencyCardText;
window._copyEmergencyCard = _copyEmergencyCard;
window._shareEmergencyCard = _shareEmergencyCard;
window.showParamedicView = showParamedicView;
window.editEmergencyInfo = editEmergencyInfo;
window._loadDwellLog = _loadDwellLog;
window._saveDwellLog = _saveDwellLog;
window._flushDwellIfDirty = _flushDwellIfDirty;
window._recordDwellSample = _recordDwellSample;
window._clusterDwellPoints = _clusterDwellPoints;
window._reverseGeocode = _reverseGeocode;
window.suggestZonesFromActivity = suggestZonesFromActivity;
window._renderSuggestedZonesList = _renderSuggestedZonesList;
window._zoneSnoozeActive = _zoneSnoozeActive;
window._loadZoneSnooze = _loadZoneSnooze;
window._saveZoneSnooze = _saveZoneSnooze;
window.snoozeZoneAlerts = snoozeZoneAlerts;
window.openZoneSnoozeSheet = openZoneSnoozeSheet;
window._closeZoneSnoozeSheet = _closeZoneSnoozeSheet;
window._showSessionExpiredOverlay = _showSessionExpiredOverlay;
window._sessionExpiredSignIn = _sessionExpiredSignIn;
window._isPresenceStale = _isPresenceStale;
window._getDefaultEmergencyNumber = _getDefaultEmergencyNumber;
window._getEmergencyNumberForUser = _getEmergencyNumberForUser;
window._showEmergencyCallPrompt = _showEmergencyCallPrompt;
window._showNoResponseFallback = _showNoResponseFallback;
window.editEmergencyNumber = editEmergencyNumber;
window._showCarerPhonePrompt = _showCarerPhonePrompt;
window._saveCarerPhoneFromPrompt = _saveCarerPhoneFromPrompt;
window._zoneId = _zoneId;
window._migrateZone = _migrateZone;
window._loadSafeZones = _loadSafeZones;
window._saveSafeZones = _saveSafeZones;
window._loadGeoFence = _loadGeoFence;
window._saveGeoFence = _saveGeoFence;
window._haversine = _haversine;
window._refreshSafeZoneButton = _refreshSafeZoneButton;
window.openSafeZoneEditor = openSafeZoneEditor;
window._renderZonesList = _renderZonesList;
window.openSafeZoneDetailEditor = openSafeZoneDetailEditor;
window._sazRenderEditor = _sazRenderEditor;
window._sazInitMap = _sazInitMap;
window._sazUpdateMapRadius = _sazUpdateMapRadius;
window._sazUpdateLiveMarker = _sazUpdateLiveMarker;
window._sazUpdateCenterText = _sazUpdateCenterText;
window._sazStartLiveDistance = _sazStartLiveDistance;
window._sazStopLiveDistance = _sazStopLiveDistance;
window._sazUpdateLiveDistanceText = _sazUpdateLiveDistanceText;
window._sazUseCurrentLocation = _sazUseCurrentLocation;
window._sazOpenInMaps = _sazOpenInMaps;
window._sazCloseEditor = _sazCloseEditor;
window._sazSave = _sazSave;
window._sazRemove = _sazRemove;
window.setHomeLocation = setHomeLocation;
window.clearGeoFence = clearGeoFence;
window._stopGeoFenceWatch = _stopGeoFenceWatch;
window._startGeoFenceWatch = _startGeoFenceWatch;
window._zoneTick = _zoneTick;
window._refreshPatientZonePill = _refreshPatientZonePill;
window._showZoneAckPrompt = _showZoneAckPrompt;
window._respondZoneAck = _respondZoneAck;
window._fireZoneExitCall = _fireZoneExitCall;
window._onZoneArrival = _onZoneArrival;
window._logZoneEvent = _logZoneEvent;
window._loadZoneEvents = _loadZoneEvents;
window._generateRoutineInsights = _generateRoutineInsights;
window.startAmbientListen = startAmbientListen;
window._listenForAmbientRequests = _listenForAmbientRequests;
window.stopAmbientListen = stopAmbientListen;
window._generateCarerWellbeingInsights = _generateCarerWellbeingInsights;
window._trackAvailHours = _trackAvailHours;
window.startVoiceListener = startVoiceListener;
window._startNativeSpeech = _startNativeSpeech;
window._startWebSpeech = _startWebSpeech;
window.stopVoiceListener = stopVoiceListener;
window.cycleVoiceDuration = cycleVoiceDuration;
window.toggleVoiceActivation = toggleVoiceActivation;
window._parseVoiceCommand = _parseVoiceCommand;
window._voiceCallCarer = _voiceCallCarer;
window.toggleLocationSharing = toggleLocationSharing;
window._attachLocation = _attachLocation;
window.showCareNotePrompt = showCareNotePrompt;
window._ttsEnabled = _ttsEnabled;
window.toggleTts = toggleTts;
window._refreshTtsButton = _refreshTtsButton;
window._migrateMedSchema = _migrateMedSchema;
window._normalizeMeds = _normalizeMeds;
window._loadMedications = _loadMedications;
window._saveMedications = _saveMedications;
window._medDisplayLabel = _medDisplayLabel;
window.removeMedication = removeMedication;
window.toggleMedication = toggleMedication;
window._medScheduleSummary = _medScheduleSummary;
window._medNeedsRefill = _medNeedsRefill;
window._renderMedsList = _renderMedsList;
window._nextOccurrence = _nextOccurrence;
window._upcomingDosesFor = _upcomingDosesFor;
window._scheduleAllMedNotifications = _scheduleAllMedNotifications;
window._showMedPrompt = _showMedPrompt;
window._wasRecentlyTaken = _wasRecentlyTaken;
window.respondMed = respondMed;
window._logMedEvent = _logMedEvent;
window._medQueueLoad = _medQueueLoad;
window._medQueueSave = _medQueueSave;
window._medQueueRemove = _medQueueRemove;
window._medEventEnqueueAndSend = _medEventEnqueueAndSend;
window._medQueueFlush = _medQueueFlush;
window._sendMedAlert = _sendMedAlert;
window._loadExtendedBrandMap = _loadExtendedBrandMap;
window._findBrandInMap = _findBrandInMap;
window.openMedEditor = openMedEditor;
window._renderMedEditor = _renderMedEditor;
window._rebuildMedEditorTimes = _rebuildMedEditorTimes;
window._medEditorAddTime = _medEditorAddTime;
window._medEditorRemoveTime = _medEditorRemoveTime;
window._medEditorSetTime = _medEditorSetTime;
window._medEditorToggleDay = _medEditorToggleDay;
window._medEditorUpdateBrandSuggestion = _medEditorUpdateBrandSuggestion;
window._medEditorAcceptBrandSuggestion = _medEditorAcceptBrandSuggestion;
window._snapshotMedEditorForm = _snapshotMedEditorForm;
window._medEditorOnPhotoSelect = _medEditorOnPhotoSelect;
window._medEditorRemovePhotoAt = _medEditorRemovePhotoAt;
window._medEditorOpenPhotoFromEditor = _medEditorOpenPhotoFromEditor;
window._medEditorOpenPhotoChooser = _medEditorOpenPhotoChooser;
window._medEditorClosePhotoChooser = _medEditorClosePhotoChooser;
window.openPhotoViewer = openPhotoViewer;
window._pvRender = _pvRender;
window._pvPrev = _pvPrev;
window._pvNext = _pvNext;
window.closePhotoViewer = closePhotoViewer;
window._closeMedEditor = _closeMedEditor;
window._deleteMedFromEditor = _deleteMedFromEditor;
window.openCarerMedsManager = openCarerMedsManager;
window._showPatientPicker = _showPatientPicker;
window._openPatientMedsList = _openPatientMedsList;
window._renderPatientMedsList = _renderPatientMedsList;
window.openCarerPatientSettings = openCarerPatientSettings;
window._showPatientPickerForSettings = _showPatientPickerForSettings;
window._openPatientSettingsPanel = _openPatientSettingsPanel;
window._showRemoteEmergencyCard = _showRemoteEmergencyCard;
window.exportAdherencePdf = exportAdherencePdf;
window._lookupRxcui = _lookupRxcui;
window._searchRxNav = _searchRxNav;
window._medEditorOnNameInput = _medEditorOnNameInput;
window._medEditorSelectRxAutocomplete = _medEditorSelectRxAutocomplete;
window._checkInteractionsOnSave = _checkInteractionsOnSave;
window._showInteractionWarning = _showInteractionWarning;
window._computeMedInteractionFlags = _computeMedInteractionFlags;
window._localInteractionCheck = _localInteractionCheck;
window.checkDrugInteractions = checkDrugInteractions;
window._showInteractionResult = _showInteractionResult;
window._parseIntOrNull = _parseIntOrNull;
window.saveMedFromEditor = saveMedFromEditor;
window.startVoiceCall = startVoiceCall;
window._listenForVoiceCalls = _listenForVoiceCalls;
window.answerVoiceCall = answerVoiceCall;
window.declineVoiceCall = declineVoiceCall;
window.endVoiceCall = endVoiceCall;
window._cleanupVoiceCall = _cleanupVoiceCall;
window._showCallOverlay = _showCallOverlay;
window._setCallStatus = _setCallStatus;
window._startCallTimer = _startCallTimer;
window.setupCarerPush = setupCarerPush;
window.refreshFcmTokenIfNeeded = refreshFcmTokenIfNeeded;
window.isIosSafari = isIosSafari;
window.isInStandaloneMode = isInStandaloneMode;
window.triggerInstall = triggerInstall;
window.dismissInstall = dismissInstall;
window.enterNightMode = enterNightMode;
window.exitNightMode = exitNightMode;
window.showReturningSignIn = showReturningSignIn;
window._showAlertForCall = _showAlertForCall;
window._updateCallQueueBadge = _updateCallQueueBadge;
window._dismissQrDisplay = _dismissQrDisplay;
window._broadcastCallToObserverRooms = _broadcastCallToObserverRooms;
window.nightModeSos = nightModeSos;
window._resetNightSosButton = _resetNightSosButton;
window._widgetSosTrigger = _widgetSosTrigger;
window._getGreeting = _getGreeting;
window._updateGreetingHeaders = _updateGreetingHeaders;
window.toggleCarerDropdown = toggleCarerDropdown;
window.renderCarersList = renderCarersList;
window.renderPatientsList = renderPatientsList;
window.openProfileModal = openProfileModal;
window.closeProfileModal = closeProfileModal;
window._getMemberPhoto = _getMemberPhoto;
window._setMemberPhoto = _setMemberPhoto;
window.handleProfilePhotoUpload = handleProfilePhotoUpload;
window._pickProfilePhoto = _pickProfilePhoto;
window._photoFromCamera = _photoFromCamera;
window._photoFromGallery = _photoFromGallery;
window._compressPhoto = _compressPhoto;
window._updateSettingsPhotoThumb = _updateSettingsPhotoThumb;
window.updateStatusCards = updateStatusCards;
window._initAndroidBackButton = _initAndroidBackButton;
window._watchMemberPhotos = _watchMemberPhotos;
window.renderCalendar = renderCalendar;
window.calSelectDate = calSelectDate;
window.calPrevMonth = calPrevMonth;
window.calNextMonth = calNextMonth;
window.calNavPrev = calNavPrev;
window.calNavNext = calNavNext;
window.calToggleExpand = calToggleExpand;
window.calPrevWeek = calPrevWeek;
window.calNextWeek = calNextWeek;
window.calSelectDow = calSelectDow;
window.openCalendarEventEditor = openCalendarEventEditor;
window.closeCalendarEventEditor = closeCalendarEventEditor;
window.calSelectType = calSelectType;
window.calTogglePriority = calTogglePriority;
window.saveCalendarEvent = saveCalendarEvent;
window.editCalendarEvent = editCalendarEvent;
window.deleteCalendarEvent = deleteCalendarEvent;
window._startCalendarListeners = _startCalendarListeners;
window._stopCalendarListeners = _stopCalendarListeners;
window.openDocumentsSheet = openDocumentsSheet;
window.renderDocumentsList = renderDocumentsList;
window.filterDocuments = filterDocuments;
window.openAddDocumentModal = openAddDocumentModal;
window.docSelectCategory = docSelectCategory;
window.handleDocFileSelect = handleDocFileSelect;
window.saveDocument = saveDocument;
window.viewDocument = viewDocument;
window.closeDocViewer = closeDocViewer;
window.deleteDocument = deleteDocument;
window._startDocumentListeners = _startDocumentListeners;
window._stopDocumentListeners = _stopDocumentListeners;
window.openHealthSheet = openHealthSheet;
window.renderHealthEntries = renderHealthEntries;
window.openHealthInput = openHealthInput;
window.closeHealthInput = closeHealthInput;
window.saveHealthEntry = saveHealthEntry;
window._setHealthTempUnit = _setHealthTempUnit;
window._selectHealthPain = _selectHealthPain;
window._selectHealthMood = _selectHealthMood;
window._startHealthListeners = _startHealthListeners;
window._stopHealthListeners = _stopHealthListeners;
window._updateVitalsStatusCard = _updateVitalsStatusCard;
window._homeScreen = _homeScreen;
window.S = S;
