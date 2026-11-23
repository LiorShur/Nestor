// ════════════════════════════════════════════════════════════
//  NATIVE BRIDGE — Capacitor plugins with web fallbacks
//  Pattern A: Use native when available, fall back to web APIs
// ════════════════════════════════════════════════════════════

// ── Platform detection & base path for Capacitor compatibility ──
export const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
export const BASE_PATH = IS_NATIVE ? '.' : '/CareCall';

// ── Lazy-loading helpers for heavy libraries ──
const _loadedScripts = {};
export async function loadScript(url) {
  if (_loadedScripts[url]) return;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url; s.onload = () => { _loadedScripts[url] = true; resolve(); };
    s.onerror = reject; document.head.appendChild(s);
  });
}
export async function loadCSS(url) {
  if (document.querySelector(`link[href="${url}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = url; document.head.appendChild(l);
}

// ── Global tick loop — single setInterval for 1-second cadence timers ──
const _tickHandlers = new Map();
let _tickInterval = null;
export function _registerTick(key, fn) {
  _tickHandlers.set(key, fn);
  if (!_tickInterval) _tickInterval = setInterval(_runTick, 1000);
}
export function _unregisterTick(key) {
  _tickHandlers.delete(key);
  if (_tickHandlers.size === 0 && _tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
}
function _runTick() {
  for (const fn of _tickHandlers.values()) { try { fn(); } catch(e) { console.warn('[tick]', e); } }
}

export const Native = {
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

  // ── Save/share a PDF ──
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
