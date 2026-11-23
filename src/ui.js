// ════════════════════════════════════════════════════════════
//  UI — Navigation, Settings, Accessibility
// ════════════════════════════════════════════════════════════
import { S, PS, CS } from './state.js';

// ════════════════════════════════════════════════════════════
//  NAVIGATION
// ════════════════════════════════════════════════════════════
export function showScreen(id) {
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
  if (prev) prev.classList.remove('active');
  document.getElementById(id).classList.add('active');

  // Refresh log/settings when opened
  if (id === 's-log') refreshLog();
  if (id === 's-settings') refreshSettings();
}

export function _homeScreen() {
  if (S.role === 'family') return 's-log';
  return S.role === 'carer' ? 's-carer' : 's-patient';
}

export function goBack() {
  showScreen(_homeScreen());
}


// ════════════════════════════════════════════════════════════
//  SETTINGS
// ════════════════════════════════════════════════════════════
export async function refreshSettings() {
  document.getElementById('s-name-display').textContent = S.name || '—';
  const roleLabels = { patient: '🛏️ Patient', carer: '🔔 Carer', family: '👨‍👩‍👧 Family' };
  document.getElementById('s-role-display').textContent = roleLabels[S.role] || S.role;
  // Mask personal code by default; user taps 👁️ to reveal.
  _codeRevealed = false;
  document.getElementById('s-personal-code').textContent = '•'.repeat((S.personalCode || '').length || 6);
  document.getElementById('s-phone-display').textContent = S.phone || 'Not set';
  document.getElementById('s-avatar-display').textContent = S.avatar || '👤';

  await _renderSettingsConnections();

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

  // Show check-in and medication settings for both roles
  const locBtn = document.getElementById('s-location-btn');
  if (locBtn) locBtn.textContent = _locationSharing ? 'On' : 'Off';

  document.getElementById('s-checkin-section').style.display = '';
  _loadCheckinSettings();
  _refreshCheckinSettingsUI();

  document.getElementById('s-dms-section').style.display = '';
  _loadDmsSettings();
  document.getElementById('dms-threshold-btn').textContent = DMS_LABELS[DMS_THRESHOLDS.indexOf(_dmsThreshold)] || 'Off';

  _loadGeoFence();
  _refreshSafeZoneButton();

  document.getElementById('s-meds-section').style.display = '';
  _loadMedications();
  _renderMedsList();
  _refreshTtsButton();

  _updateLangDisplay();
  refreshNotifStatus();
}

export function _moveCarerPriority(currentIdx, direction) {
  const order = JSON.parse(localStorage.getItem('carecall_carer_priority') || '[]');
  const newIdx = currentIdx + direction;
  if (newIdx < 0 || newIdx >= order.length) return;
  // Swap
  [order[currentIdx], order[newIdx]] = [order[newIdx], order[currentIdx]];
  localStorage.setItem('carecall_carer_priority', JSON.stringify(order));
  refreshSettings();
}

export async function addConnectionFromSettings() {
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

export async function removeConnection(roomId) {
  // Clean up the other user's Firebase rooms list
  try {
    const snap = await db.ref(`carecall/rooms/${roomId}/members`).once('value');
    const members = snap.val() || {};
    for (const [theirUid] of Object.entries(members)) {
      if (theirUid !== S.uid) {
        const theirRoomsSnap = await db.ref(`carecall/users/${theirUid}/rooms`).once('value');
        let theirRooms = theirRoomsSnap.val() || [];
        theirRooms = theirRooms.filter(r => r !== roomId);
        await db.ref(`carecall/users/${theirUid}/rooms`).set(theirRooms);
      }
    }
  } catch(e) { console.warn('Failed to clean up other user rooms:', e.message); }

  await leaveRoom(roomId);
  S.rooms = S.rooms.filter(r => r !== roomId);
  if (S.activeRoom === roomId) S.activeRoom = S.rooms[0] || null;
  // Update our own Firebase rooms list
  await _saveUserRooms(S.uid, S.rooms);
  saveState();
  await refreshSettings();
  toast(t('Connection removed'));
}

export async function refreshNotifStatus() {
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

export async function testNotification() {
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
      icon: '/CareCall/icon-192.svg',
      badge: '/CareCall/icon-192.svg',
      vibrate: [300, 100, 300],
      requireInteraction: true,
      tag: 'carecall-test',
      renotify: true,
    });
    console.log('[Test] showNotification() succeeded');
    toast('Test sent! If nothing appears, check: Android Settings → Apps → Chrome → Notifications → ensure enabled');
  } catch(e) {
    console.error('[Test] Notification failed:', e);
    toast('Notification failed: ' + e.message);
  }
}

export function editName() {
  const name = prompt('Your name:', S.name);
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

export function editPhone() {
  const phone = prompt('Your phone number (with country code):', S.phone || '');
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

export const AVATAR_OPTIONS = ['👤','👩','👨','👵','👴','👩‍🦳','👨‍🦳','👩‍🦰','👨‍🦰','👱‍♀️','👱‍♂️','👩‍⚕️','👨‍⚕️','🧑‍⚕️','👼','🧓','🤶','🎅','🦸‍♀️','🦸‍♂️','😊','😎','🥰','🤗','💪','❤️','⭐','🌻','🌈','🐱','🐶','🦋'];

export function toggleSettingsGroup(id) {
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

export function _filterSettings(query) {
  const q = (query || '').toLowerCase().trim();
  const groups = document.querySelectorAll('#s-settings .settings-group');
  groups.forEach(group => {
    if (!q) { group.style.display = ''; return; }
    const text = group.textContent.toLowerCase();
    group.style.display = text.includes(q) ? '' : 'none';
  });
}

export function toggleAvatarPicker() {
  const picker = document.getElementById('avatar-picker');
  picker.classList.toggle('show');
  if (picker.classList.contains('show') && !picker.children.length) {
    _renderAvatarOptions();
  }
}

export function _renderAvatarOptions() {
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

export function _selectAvatar(emoji) {
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

export function resetApp() {
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

