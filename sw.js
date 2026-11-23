// CareCall Service Worker — handles app caching AND push notifications.

importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');

const CACHE = 'carecall-v4';
const BASE = '/CareCall';
const APP_SHELL = [
  BASE + '/carecall-firebase.html',
  BASE + '/manifest.json',
  BASE + '/icon-192.svg',
  BASE + '/icon-512.svg',
];

// ── Firebase init (same config as main app) ────────────────
firebase.initializeApp({
  apiKey: "AIzaSyBStlDFW0WFpA_U1o_2QC0YE4iAo6d9cQc",
  authDomain: "carecall-2afa6.firebaseapp.com",
  databaseURL: "https://carecall-2afa6-default-rtdb.firebaseio.com",
  projectId: "carecall-2afa6",
  storageBucket: "carecall-2afa6.firebasestorage.app",
  messagingSenderId: "332197805860",
  appId: "1:332197805860:web:d734289d18c69e88a27db1",
});

const messaging = firebase.messaging();

// Helper: post a log message to all open app windows
function logToClients(msg) {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(clients => {
      clients.forEach(c => c.postMessage({ type: 'sw-log', message: msg }));
    })
    .catch(() => {});
}

// ── Install: pre-cache app shell ──────────────────────────
self.addEventListener('install', evt => {
  self.skipWaiting();
  evt.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.allSettled(APP_SHELL.map(url => cache.add(url)))
    )
  );
});

// ── Activate: clear old caches, take control immediately ──
self.addEventListener('activate', evt => {
  evt.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for app shell, passthrough for APIs ──
self.addEventListener('fetch', evt => {
  const url = new URL(evt.request.url);

  if (url.hostname.includes('firebase') ||
      url.hostname.includes('firebaseio') ||
      url.hostname.includes('googleapis') ||
      url.hostname.includes('gstatic')) {
    return;
  }

  if (evt.request.method !== 'GET') return;

  evt.respondWith(
    fetch(evt.request)
      .then(response => {
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(evt.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(evt.request))
  );
});

// ── FCM: background message handler ──────────────────────
// Fires for data-only messages when the app is NOT in the foreground.
// (Messages with a `notification` key are auto-displayed by Firebase SDK.)
messaging.onBackgroundMessage(payload => {
  logToClients('[SW] onBackgroundMessage fired');
  const data  = payload.data || {};
  const notif = payload.notification || {};

  const title = notif.title || data.title || `${data.fromName || 'Patient'} needs help!`;
  const body  = notif.body  || data.body  || 'Tap to open CareCall';

  return self.registration.showNotification(title, {
    body,
    icon:               BASE + '/icon-192.svg',
    badge:              BASE + '/icon-192.svg',
    vibrate:            [500, 150, 500, 150, 800],
    requireInteraction: true,
    tag:                'carecall-alert',
    renotify:           true,
    data:               { url: BASE + '/carecall-firebase.html', ...data },
    actions: [
      { action: 'ack',     title: "✓ I'm on my way" },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  }).catch(err => {
    console.error('[SW] showNotification failed:', err);
  });
});

// ── Safety net: direct push handler ──────────────────────
// If Firebase SDK doesn't handle the push (edge cases), this catches it.
// Checks for an existing notification to avoid duplicates.
self.addEventListener('push', evt => {
  logToClients('[SW] push event received');

  evt.waitUntil(
    // Short delay to let Firebase's handler run first if it will
    new Promise(resolve => setTimeout(resolve, 500)).then(async () => {
      const existing = await self.registration.getNotifications({ tag: 'carecall-alert' });
      // If a notification with our tag already exists (Firebase handled it), skip
      if (existing.length > 0) {
        logToClients('[SW] Firebase already showed notification — skipping');
        return;
      }

      logToClients('[SW] Showing notification from safety-net handler');
      let data = {};
      if (evt.data) {
        try {
          const payload = evt.data.json();
          data = payload.data || payload;
        } catch (e) {
          try { data = { body: evt.data.text() }; } catch (e2) { /* empty */ }
        }
      }

      const title = data.title || `${data.fromName || 'Patient'} needs help!`;
      const body  = data.body  || 'Tap to open CareCall';

      return self.registration.showNotification(title, {
        body,
        icon:               BASE + '/icon-192.svg',
        badge:              BASE + '/icon-192.svg',
        vibrate:            [500, 150, 500, 150, 800],
        requireInteraction: true,
        tag:                'carecall-alert',
        renotify:           true,
        data:               { url: BASE + '/carecall-firebase.html', ...data },
        actions: [
          { action: 'ack',     title: "✓ I'm on my way" },
          { action: 'dismiss', title: 'Dismiss' },
        ],
      }).catch(err => {
        console.error('[SW] Safety-net showNotification failed:', err);
      });
    }).catch(err => {
      console.error('[SW] Safety-net handler error:', err);
    })
  );
});

// ── Notification tap: open or focus the app ───────────────
self.addEventListener('notificationclick', evt => {
  evt.notification.close();
  if (evt.action === 'dismiss') return;

  const url = (evt.notification.data && evt.notification.data.url)
    || BASE + '/carecall-firebase.html';

  evt.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const match = list.find(c => c.url.includes('carecall-firebase'));
      if (match) {
        match.focus();
        match.postMessage({ type: 'incoming-call', data: evt.notification.data || {} });
      } else {
        clients.openWindow(url);
      }
    })
  );
});
