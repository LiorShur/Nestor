// ════════════════════════════════════════════════════════════
//  PWA — service worker + install prompt
// ════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════
//  PWA — Service Worker + Install Prompt
// ════════════════════════════════════════════════════════════
export let _installPrompt = null;

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
export function isIosSafari() {
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  const isSafari = /safari/i.test(ua) && !/chrome|crios|fxios/i.test(ua);
  return isIos && isSafari;
}
export function isInStandaloneMode() {
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
  toast('✅ CareCall installed!');
});

export function triggerInstall() {
  if (!_installPrompt) return;
  _installPrompt.prompt();
  _installPrompt.userChoice.then(choice => {
    if (choice.outcome === 'accepted') {
      document.getElementById('install-banner').classList.remove('show');
    }
    _installPrompt = null;
  });
}

export function dismissInstall() {
  document.getElementById('install-banner').classList.remove('show');
  localStorage.setItem('pwa_dismissed', '1');
  // Allow it to show again after 7 days
  setTimeout(() => localStorage.removeItem('pwa_dismissed'), 7 * 24 * 60 * 60 * 1000);
}

