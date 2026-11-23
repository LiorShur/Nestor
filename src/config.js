// ════════════════════════════════════════════════════════════
//  CONFIGURATION — Firebase config, timing constants
// ════════════════════════════════════════════════════════════

/* ═══════════════════════════════════════════════════════════
   FIREBASE CONFIGURATION
   Replace these values with your own Firebase project config.
   See SETUP.md for step-by-step instructions.
   ═══════════════════════════════════════════════════════════ */
export const FIREBASE_CONFIG = {
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

// ── Call / alert timing constants ──
export const MISSED_CALL_LOOKBACK_MS = 90000;   // 90s — how far back to scan for missed calls
export const CALL_FINAL_TIMEOUT_MS   = 120000;  // 2min — auto-timeout for unanswered calls
export const CALL_CARD_REMOVE_DELAY_MS = 8000;  // delay before removing acknowledged-call cards
export const NEW_CALL_THRESHOLD_MS   = 60000;   // calls newer than this trigger the incoming alert
export const BELL_CADENCE_MS         = 3400;    // interval between bell replays
export const BOOT_TIMEOUT_MS         = 8000;    // safety timeout for the boot spinner

// ── Emergency hold constant ──
export const EMERGENCY_HOLD_MS = 3000; // 3 seconds to activate
