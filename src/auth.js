// ════════════════════════════════════════════════════════════
//  AUTH — registration, login, forgot-password, PIN lock
// ════════════════════════════════════════════════════════════
import { S } from './state.js';

// ════════════════════════════════════════════════════════════
//  SETUP FLOW
// ════════════════════════════════════════════════════════════
export let _pendingRole = null;

export function setupChooseRole(role) {
  unlockAudio(); // iOS: must unlock inside direct user gesture
  _pendingRole = role;
  showScreen('s-name');
  setTimeout(()=>document.getElementById('name-input').focus(), 400);
}

export function setupSaveName() {
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
export function _setupPostAuth() {
  if (!S.personalCode) S.personalCode = genCode();
  document.getElementById('new-room-code').textContent = S.personalCode;

  const roleToTitle = { carer: t('Your Carer Code'), family: t('Your Family Code'), patient: t('Your Patient Code') };
  document.getElementById('room-title').textContent = roleToTitle[S.role] || t('Your Personal Code');
  document.getElementById('room-sub').textContent = t('Share this code to connect');
  document.getElementById('room-code-hint').textContent = t('Share this code to connect');
  const connectLabel = (S.role === 'carer' || S.role === 'family') ? t("Patient's code") : t("Carer's code");
  document.getElementById('connect-input-label').textContent = connectLabel;
  showScreen('s-room');
}

// ════════════════════════════════════════════════════════════════════
// AUTH — email/password registration, login, forgot-password
// ════════════════════════════════════════════════════════════════════
export let _authMode = 'register'; // 'register' | 'login'

export function _authSwitchTab(mode) {
  _authMode = mode;
  const el = (id) => document.getElementById(id);
  if (!el('auth-tab-register')) return;
  el('auth-tab-register').classList.toggle('selected', mode === 'register');
  el('auth-tab-login').classList.toggle('selected', mode === 'login');
  el('auth-confirm-group').style.display = mode === 'register' ? '' : 'none';
  el('auth-phone-group').style.display = mode === 'register' ? '' : 'none';
  el('auth-consent-row').style.display = mode === 'register' ? '' : 'none';
  el('auth-forgot').style.display = mode === 'login' ? '' : 'none';
  el('auth-submit-btn').textContent = mode === 'register' ? t('Create Account') : t('Log in');
  el('auth-title').textContent = mode === 'register' ? t('Create your account') : t('Log in to your account');
  el('auth-err').textContent = '';
}

export function _authPasswordStrength(pw) {
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
if (typeof document !== 'undefined') document.addEventListener('input', e => {
  if (e.target.id !== 'auth-password') return;
  const strength = _authPasswordStrength(e.target.value);
  const el = document.getElementById('auth-strength');
  if (!el) return;
  el.className = 'auth-strength ' + strength;
  const labels = { weak: t('Weak'), fair: t('Fair'), strong: t('Strong') };
  el.textContent = e.target.value ? (labels[strength] || '') : '';
});

export async function _authSubmit() {
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
    btn.disabled = true; btn.textContent = t('Creating account…');
    try {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      S.uid = cred.user.uid;
      localStorage.setItem('carecall_uid', S.uid);
      // Send verification email (non-blocking — user can continue).
      try { await cred.user.sendEmailVerification(); } catch(_) {}
      saveState();
      toast(t('Account created! A verification email has been sent.'));
      _setupPostAuth();
    } catch(e) {
      btn.disabled = false; btn.textContent = t('Create Account');
      errEl.textContent = _authErrorMessage(e);
    }
  } else {
    // Login
    const btn = document.getElementById('auth-submit-btn');
    btn.disabled = true; btn.textContent = t('Signing in…');
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
      if (S.name && S.role) {
        // Full returning user — go straight to main screen.
        await syncUserProfile();
        await joinAllRooms();
        launchMainScreen();
      } else {
        // Account exists but profile is incomplete (e.g. registered on
        // another device but never finished setup). Show code screen.
        if (!S.personalCode) S.personalCode = genCode();
        _setupPostAuth();
      }
    } catch(e) {
      btn.disabled = false; btn.textContent = t('Log in');
      errEl.textContent = _authErrorMessage(e);
    }
  }
}

export function _authErrorMessage(e) {
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

export async function _authForgotPassword() {
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
export async function signOut() {
  if (!confirm(t('Sign out? You will need your email and password to sign back in.'))) return;
  _teardownAllListeners();
  try { await auth.signOut(); } catch(_) {}
  localStorage.clear();
  location.reload();
}

// ════════════════════════════════════════════════════════════════════
// TAP-TO-REVEAL CODE MASKING
// ════════════════════════════════════════════════════════════════════
export let _codeRevealed = false;
export let _codeRevealTimer = null;

export function _toggleCodeReveal() {
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

export async function _copyPersonalCode() {
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
export let _pinUnlockedAt = 0;
export const PIN_TIMEOUT_MS = 5 * 60 * 1000;

export function _getPinHash() {
  return localStorage.getItem('carecall_pin_hash') || '';
}

export async function _hashPin(pin) {
  const data = new TextEncoder().encode('carecall_salt_' + pin);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function _isPinLocked() {
  if (!_getPinHash()) return false;
  return (Date.now() - _pinUnlockedAt) > PIN_TIMEOUT_MS;
}

export function _showPinOverlay(onSuccess) {
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

export async function _setupPin() {
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

export function _removePin() {
  if (!confirm(t('Remove the PIN lock from Settings?'))) return;
  localStorage.removeItem('carecall_pin_hash');
  toast(t('PIN removed'));
  refreshSettings();
}

export async function _pinForgot() {
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
