// ════════════════════════════════════════════════════════════
//  FIREBASE INIT
// ════════════════════════════════════════════════════════════
import { FIREBASE_CONFIG } from './config.js';

export let db   = null;
export let auth = null;

export function isFirebaseConfigured() {
  return FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY";
}

export function initFirebase() {
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
